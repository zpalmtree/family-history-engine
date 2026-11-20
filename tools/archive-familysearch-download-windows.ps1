param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-z0-9][a-z0-9-]{0,127}$')]
  [string]$TargetId,

  [Parameter(Mandatory = $true)]
  [string]$SourceFile
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
$QueuePath = Join-Path $ProjectRoot "evidence\familysearch-recovery-queue.json"
$queue = Get-Content -LiteralPath $QueuePath -Raw | ConvertFrom-Json
$target = $queue.targets | Where-Object { $_.id -eq $TargetId } | Select-Object -First 1
if (-not $target) {
  # Canonical acquisition targets are authoritative. Newly researched records
  # may not yet exist in the generated compatibility queue, and requiring that
  # stale projection created a circular archive-registration dependency.
  $canonicalTargetPath = Join-Path $ProjectRoot "evidence\acquisition\targets\$TargetId.json"
  if (Test-Path -LiteralPath $canonicalTargetPath -PathType Leaf) {
    $target = Get-Content -LiteralPath $canonicalTargetPath -Raw | ConvertFrom-Json
    if ($target.id -ne $TargetId) { throw "Canonical FamilySearch target id does not match its filename." }
  }
}
if (-not $target) { throw "Unknown FamilySearch target: $TargetId" }
if (-not $target.archiveFile) { throw "FamilySearch target has no archive filename: $TargetId" }

$source = [IO.Path]::GetFullPath($SourceFile)
$downloads = [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE "Downloads"))
$archive = [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE "OneDrive\Documents\FamilyHistorySourceMasters"))
if (-not $source.StartsWith($downloads + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw "SourceFile must be inside the Windows Downloads folder."
}
if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
  throw "Downloaded FamilySearch source file was not found."
}

$archiveFile = [string]$target.archiveFile
if ([IO.Path]::GetFileName($archiveFile) -ne $archiveFile) {
  throw "FamilySearch queue archiveFile must be a filename, not a path."
}
$bytes = [IO.File]::ReadAllBytes($source)
$isJpeg = $bytes.Length -ge 3 -and $bytes[0] -eq 0xFF -and $bytes[1] -eq 0xD8 -and $bytes[2] -eq 0xFF
$isPng = $bytes.Length -ge 8 -and $bytes[0] -eq 0x89 -and $bytes[1] -eq 0x50 -and $bytes[2] -eq 0x4E -and $bytes[3] -eq 0x47 -and $bytes[4] -eq 0x0D -and $bytes[5] -eq 0x0A -and $bytes[6] -eq 0x1A -and $bytes[7] -eq 0x0A
$isPdf = $bytes.Length -ge 5 -and [Text.Encoding]::ASCII.GetString($bytes, 0, 5) -eq "%PDF-"
$isWebp = $bytes.Length -ge 12 -and [Text.Encoding]::ASCII.GetString($bytes, 0, 4) -eq "RIFF" -and [Text.Encoding]::ASCII.GetString($bytes, 8, 4) -eq "WEBP"
if (-not ($isJpeg -or $isPng -or $isPdf -or $isWebp)) {
  throw "Downloaded source file is not an approved JPEG, PNG, WebP, or PDF artifact."
}
$extension = [IO.Path]::GetExtension($archiveFile).ToLowerInvariant()
$magicMatchesExtension = switch ($extension) {
  ".jpg" { $isJpeg }
  ".jpeg" { $isJpeg }
  ".png" { $isPng }
  ".webp" { $isWebp }
  ".pdf" { $isPdf }
  default { $false }
}
if (-not $magicMatchesExtension) {
  throw "Downloaded source bytes do not match the queued archive filename extension."
}

New-Item -ItemType Directory -Path $archive -Force | Out-Null
$destination = Join-Path $archive $archiveFile
$temporary = "$destination.partial"
try {
  if (Test-Path -LiteralPath $destination -PathType Leaf) {
    $sourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $source).Hash
    $destinationHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $destination).Hash
    if ($sourceHash -ne $destinationHash) {
      throw "Archive destination already exists with different bytes; inspect before replacing it."
    }
  } else {
    Copy-Item -LiteralPath $source -Destination $temporary
    cipher /e $temporary | Out-Null
    $temporaryItem = Get-Item -LiteralPath $temporary
    if (-not ($temporaryItem.Attributes -band [IO.FileAttributes]::Encrypted)) {
      throw "The temporary FamilySearch source master is not EFS encrypted."
    }
    Move-Item -LiteralPath $temporary -Destination $destination
  }
  cipher /e /a /q $destination | Out-Null
  $item = Get-Item -LiteralPath $destination
  if (-not ($item.Attributes -band [IO.FileAttributes]::Encrypted)) {
    throw "The archived FamilySearch source master is not EFS encrypted."
  }

  . (Join-Path $PSScriptRoot "tree-config.ps1")
  $wslProjectRoot = Get-TreeWslProjectRoot
  wsl.exe -d Ubuntu --cd $wslProjectRoot node tools/register-familysearch-record.mjs --target $TargetId
  if ($LASTEXITCODE -ne 0) { throw "WSL FamilySearch registration failed." }
  wsl.exe -d Ubuntu --cd $wslProjectRoot npm run records:import:familysearch
  if ($LASTEXITCODE -ne 0) { throw "WSL FamilySearch import failed." }

  Write-Host "Archived and registered $TargetId."
  Write-Host "The Downloads copy was retained until visual person verification and full validation succeed."
} finally {
  Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
}
