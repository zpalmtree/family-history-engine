param(
  [string]$Queue = "evidence/familysearch-recovery-queue.json",
  [string]$TargetId,
  [string]$Scope = "main",
  [ValidateRange(1, 25)]
  [int]$MaxTargets = 1
)
. (Join-Path $PSScriptRoot "tree-config.ps1")
Assert-TreeScope $Scope

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
$previousLocation = Get-Location
Set-Location -LiteralPath $ProjectRoot
$QueuePath = Join-Path $ProjectRoot $Queue
$ArchiveRoot = Join-Path $env:OneDrive "Documents\FamilyHistorySourceMasters"
$Downloader = Join-Path $ScriptDir "familysearch-windows.ps1"
$targets = (Get-Content -LiteralPath $QueuePath -Raw | ConvertFrom-Json).targets
if ($TargetId -and $TargetId -notmatch '^[a-z0-9][a-z0-9._-]+$') { throw "Unsafe target id" }
if ($TargetId) {
  $targets = @($targets | Where-Object { $_.id -eq $TargetId })
  if ($targets.Count -ne 1) { throw "Unknown or ambiguous FamilySearch target: $TargetId" }
  $MaxTargets = 1
}
# Prefer direct FamilySearch image ARKs.  Indexed 1:1 record pages stay in the
# queue, but do not delay originals that have a recoverable 3:1 image route.
$targets = @($targets | Sort-Object { if ($_.recordUrl -match '/3:1:') { 0 } else { 1 } })
$attempted = 0

$results = foreach ($target in $targets) {
  $destination = Join-Path $ArchiveRoot $target.archiveFile
  if ($target.status -eq "acquired" -and (Test-Path -LiteralPath $destination)) {
    $item = Get-Item -LiteralPath $destination
    [pscustomobject]@{
      id = $target.id
      status = "acquired"
      archiveFile = $target.archiveFile
      length = $item.Length
      sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $destination).Hash.ToLowerInvariant()
      encrypted = [bool]($item.Attributes -band [IO.FileAttributes]::Encrypted)
    }
    continue
  }
  if ($target.status -ne "ready") { continue }
  if ($attempted -ge $MaxTargets) { continue }
  $attempted += 1
  try {
    $affinityStem = (($target.id -replace '[^a-z0-9-]', '-').Trim('-'))
    if ($affinityStem.Length -gt 18) { $affinityStem = $affinityStem.Substring(0, 18).TrimEnd('-') }
    $affinityHasher = [Security.Cryptography.SHA256]::Create()
    try {
      $affinityHashBytes = $affinityHasher.ComputeHash([Text.Encoding]::UTF8.GetBytes([string]$target.id))
    } finally {
      $affinityHasher.Dispose()
    }
    $affinityHash = ([BitConverter]::ToString($affinityHashBytes) -replace '-', '').Substring(0, 8).ToLowerInvariant()
    $affinitySlot = "fs-$affinityStem-$affinityHash"
    $downloadOutput = & $Downloader -Mode download -Record $target.recordUrl -OutFile $target.archiveFile -AffinitySlot $affinitySlot 2>&1
    if (-not (Test-Path -LiteralPath $destination)) {
      throw "download did not create the requested archive file"
    }
    $item = Get-Item -LiteralPath $destination
    node tools/register-familysearch-record.mjs --target $target.id | Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw "download succeeded but queue registration failed"
    }
    [pscustomobject]@{
      id = $target.id
      status = "acquired"
      archiveFile = $target.archiveFile
      length = $item.Length
      sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $destination).Hash.ToLowerInvariant()
      encrypted = [bool]($item.Attributes -band [IO.FileAttributes]::Encrypted)
    }
  } catch {
    $errorText = "$($_.Exception.Message) $($downloadOutput -join ' ')"
    $interactiveSignIn = $errorText -match '(?i)sign-in|identity/login'
    node tools/record-acquisition-attempt.mjs `
      --atom $target.atomId `
      --route $target.id `
      --scope $Scope `
      --outcome $(if ($interactiveSignIn) { "needs-interactive-sign-in" } else { "retryable-error" }) `
      --note $(if ($interactiveSignIn) { "Shared FamilySearch profile requires one manual sign-in; later targets were not attempted." } else { "FamilySearch original download failed and remains safe to retry after provider-state review." }) | Out-Null
    [pscustomobject]@{
      id = $target.id
      status = if ($interactiveSignIn) { "needs-interactive-sign-in" } else { "failed" }
      archiveFile = $target.archiveFile
      error = if ($interactiveSignIn) { "Shared FamilySearch profile requires manual sign-in." } else { $_.Exception.Message }
    }
    if ($interactiveSignIn) { break }
  }
}

$results | ConvertTo-Json -Depth 4
Set-Location -LiteralPath $previousLocation
