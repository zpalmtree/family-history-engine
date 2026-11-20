param(
  [Parameter(Mandatory = $true)]
  [string]$TargetId,

  [Parameter(Mandatory = $true)]
  [string]$SourceFile
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
$QueuePath = Join-Path $ProjectRoot "evidence\record-recovery-queue.json"
$queue = Get-Content -LiteralPath $QueuePath -Raw | ConvertFrom-Json
$CanonicalTargetPath = Join-Path $ProjectRoot "evidence\acquisition\targets\$TargetId.json"
$canonicalTarget = if (Test-Path -LiteralPath $CanonicalTargetPath -PathType Leaf) {
  Get-Content -LiteralPath $CanonicalTargetPath -Raw | ConvertFrom-Json
} else {
  $null
}
$target = if ($canonicalTarget) {
  $canonicalTarget
} else {
  $queue.targets | Where-Object { $_.id -eq $TargetId } | Select-Object -First 1
}
if (-not $target) { throw "Unknown delivered-record target: $TargetId" }
if (-not $target.archiveFile) { throw "Delivered-record target has no archive filename: $TargetId" }

$source = [IO.Path]::GetFullPath($SourceFile)
$downloads = [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE "Downloads"))
$archive = [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE "OneDrive\Documents\FamilyHistorySourceMasters"))
if (-not $source.StartsWith($downloads + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw "SourceFile must be inside the Windows Downloads folder."
}
if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
  throw "Delivered source file was not found."
}

$archiveFile = [string]$target.archiveFile
if ([IO.Path]::GetFileName($archiveFile) -ne $archiveFile) {
  throw "Queue archiveFile must be a filename, not a path."
}
$bytes = [IO.File]::ReadAllBytes($source)
$isJpeg = $bytes.Length -ge 3 -and $bytes[0] -eq 0xFF -and $bytes[1] -eq 0xD8 -and $bytes[2] -eq 0xFF
$isPng = $bytes.Length -ge 8 -and $bytes[0] -eq 0x89 -and $bytes[1] -eq 0x50 -and $bytes[2] -eq 0x4E -and $bytes[3] -eq 0x47 -and $bytes[4] -eq 0x0D -and $bytes[5] -eq 0x0A -and $bytes[6] -eq 0x1A -and $bytes[7] -eq 0x0A
$isPdf = $bytes.Length -ge 5 -and [Text.Encoding]::ASCII.GetString($bytes, 0, 5) -eq "%PDF-"
$isWebp = $bytes.Length -ge 12 -and [Text.Encoding]::ASCII.GetString($bytes, 0, 4) -eq "RIFF" -and [Text.Encoding]::ASCII.GetString($bytes, 8, 4) -eq "WEBP"
if (-not ($isJpeg -or $isPng -or $isPdf -or $isWebp)) {
  throw "Delivered source file is not an approved JPEG, PNG, WebP, or PDF artifact."
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
  throw "Delivered source bytes do not match the queued archive filename extension."
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
      throw "The temporary delivered source master is not EFS encrypted."
    }
    Move-Item -LiteralPath $temporary -Destination $destination
  }
  cipher /e /a /q $destination | Out-Null
  $item = Get-Item -LiteralPath $destination
  if (-not ($item.Attributes -band [IO.FileAttributes]::Encrypted)) {
    throw "The archived delivered source master is not EFS encrypted."
  }

  . (Join-Path $PSScriptRoot "tree-config.ps1")
  $wslProjectRoot = Get-TreeWslProjectRoot
  if ($canonicalTarget) {
    wsl.exe -d Ubuntu --cd $wslProjectRoot node tools/register-public-record.mjs --target $TargetId
    if ($LASTEXITCODE -ne 0) { throw "WSL canonical public-record registration failed." }
  } else {
    wsl.exe -d Ubuntu --cd $wslProjectRoot npm run records:import:public
    if ($LASTEXITCODE -ne 0) { throw "WSL delivered-record import failed." }
  }
  Write-Host "Archived and registered $TargetId."
  Write-Host "The Downloads copy was retained until visual person verification and full validation succeed."
} finally {
  Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
}
