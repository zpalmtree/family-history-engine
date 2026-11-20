param(
  [Parameter(Mandatory = $true)]
  [string]$TargetId,

  [Parameter(Mandatory = $true)]
  [string]$SourceFile,

  [Parameter(Mandatory = $true)]
  [ValidatePattern("^[0-9a-fA-F]{64}$")]
  [string]$ExpectedOldSha256,

  [Parameter(Mandatory = $true)]
  [ValidatePattern("^[0-9a-fA-F]{64}$")]
  [string]$ExpectedNewSha256,

  [Parameter(Mandatory = $true)]
  [ValidateRange(1024, [long]::MaxValue)]
  [long]$ExpectedNewLength
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
$CanonicalTargetPath = Join-Path $ProjectRoot "evidence\acquisition\targets\$TargetId.json"
if (-not (Test-Path -LiteralPath $CanonicalTargetPath -PathType Leaf)) {
  throw "Canonical public-record target was not found: $TargetId"
}
$target = Get-Content -LiteralPath $CanonicalTargetPath -Raw | ConvertFrom-Json
if (-not $target.archiveFile) { throw "Public-record target has no archive filename: $TargetId" }

$source = [IO.Path]::GetFullPath($SourceFile)
$downloads = [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE "Downloads"))
$archive = [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE "OneDrive\Documents\FamilyHistorySourceMasters"))
if (-not $source.StartsWith($downloads + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw "SourceFile must be inside the Windows Downloads folder."
}
if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
  throw "Replacement source file was not found."
}

$archiveFile = [string]$target.archiveFile
if ([IO.Path]::GetFileName($archiveFile) -ne $archiveFile) {
  throw "Target archiveFile must be a filename, not a path."
}
$extension = [IO.Path]::GetExtension($archiveFile).ToLowerInvariant()
$bytes = [IO.File]::ReadAllBytes($source)
$isPdf = $bytes.Length -ge 5 -and [Text.Encoding]::ASCII.GetString($bytes, 0, 5) -eq "%PDF-"
if ($extension -ne ".pdf" -or -not $isPdf) {
  throw "Guarded public-master replacement currently accepts only a PDF matching a .pdf archive target."
}
if ($bytes.Length -ne $ExpectedNewLength) {
  throw "Replacement length mismatch: expected $ExpectedNewLength bytes, found $($bytes.Length)."
}
$sourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $source).Hash.ToLowerInvariant()
if ($sourceHash -ne $ExpectedNewSha256.ToLowerInvariant()) {
  throw "Replacement SHA-256 does not match ExpectedNewSha256."
}

$destination = Join-Path $archive $archiveFile
if (-not (Test-Path -LiteralPath $destination -PathType Leaf)) {
  throw "Existing archived source master was not found: $archiveFile"
}
$destinationItem = Get-Item -LiteralPath $destination
if (-not ($destinationItem.Attributes -band [IO.FileAttributes]::Encrypted)) {
  throw "Existing archived source master is not EFS encrypted."
}
$destinationHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $destination).Hash.ToLowerInvariant()
if ($destinationHash -ne $ExpectedOldSha256.ToLowerInvariant()) {
  throw "Existing archive SHA-256 does not match ExpectedOldSha256; refusing replacement."
}
if ($destinationHash -eq $sourceHash) {
  throw "Existing and replacement source masters are identical; no repair is needed."
}

$temporary = "$destination.replacement.partial"
$backup = "$destination.pre-repair.backup"
if ((Test-Path -LiteralPath $temporary) -or (Test-Path -LiteralPath $backup)) {
  throw "A prior replacement staging file exists; inspect it before retrying."
}

$destinationMoved = $false
$replacementInstalled = $false
try {
  Copy-Item -LiteralPath $source -Destination $temporary
  cipher /e /a /q $temporary | Out-Null
  $temporaryItem = Get-Item -LiteralPath $temporary
  if (-not ($temporaryItem.Attributes -band [IO.FileAttributes]::Encrypted)) {
    throw "The staged replacement is not EFS encrypted."
  }
  $temporaryHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $temporary).Hash.ToLowerInvariant()
  if ($temporaryHash -ne $sourceHash) {
    throw "The staged replacement failed byte verification."
  }

  Move-Item -LiteralPath $destination -Destination $backup
  $destinationMoved = $true
  Move-Item -LiteralPath $temporary -Destination $destination
  $replacementInstalled = $true

  $installedItem = Get-Item -LiteralPath $destination
  if (-not ($installedItem.Attributes -band [IO.FileAttributes]::Encrypted)) {
    throw "The installed replacement is not EFS encrypted."
  }
  $installedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $destination).Hash.ToLowerInvariant()
  if ($installedHash -ne $sourceHash) {
    throw "The installed replacement failed byte verification."
  }

  . (Join-Path $PSScriptRoot "tree-config.ps1")
  $wslProjectRoot = Get-TreeWslProjectRoot
  wsl.exe -d Ubuntu --cd $wslProjectRoot node tools/register-public-record.mjs --target $TargetId
  if ($LASTEXITCODE -ne 0) { throw "WSL canonical public-record registration failed." }

  Remove-Item -LiteralPath $backup -Force
  $destinationMoved = $false
  Write-Host "Replaced and re-registered $TargetId."
  Write-Host "The Downloads replacement was retained until full validation succeeds."
} catch {
  if ($replacementInstalled -and (Test-Path -LiteralPath $destination -PathType Leaf)) {
    Remove-Item -LiteralPath $destination -Force
  }
  if ($destinationMoved -and (Test-Path -LiteralPath $backup -PathType Leaf)) {
    Move-Item -LiteralPath $backup -Destination $destination
    $destinationMoved = $false
  }
  throw
} finally {
  Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
  if (-not $destinationMoved) {
    Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
  }
}
