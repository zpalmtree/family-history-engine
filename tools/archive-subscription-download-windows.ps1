param(
  [Parameter(Mandatory = $true)]
  [string]$TargetId,

  [Parameter(Mandatory = $true)]
  [string]$SourceFile,

  [Parameter(Mandatory = $true)]
  [string]$ArchiveFile,

  [ValidatePattern('^[a-z0-9][a-z0-9-]{0,127}$')]
  [string]$RouteId,

  [int]$Part = 1,

  # Register (and import) only; the caller runs the generated-view refresh and
  # data:check once for the whole batch. The staged download is still removed.
  [switch]$DeferValidation
)

$ErrorActionPreference = "Stop"
$source = [IO.Path]::GetFullPath($SourceFile)
$downloads = [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE "Downloads"))
$archive = [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE "OneDrive\Documents\FamilyHistorySourceMasters"))

if (-not $source.StartsWith($downloads + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw "SourceFile must be inside the Windows Downloads folder."
}
if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
  throw "Downloaded source file was not found."
}
$bytes = [IO.File]::ReadAllBytes($source)
$isJpeg = $bytes.Length -ge 3 -and $bytes[0] -eq 0xFF -and $bytes[1] -eq 0xD8 -and $bytes[2] -eq 0xFF
$isPng = $bytes.Length -ge 8 -and $bytes[0] -eq 0x89 -and $bytes[1] -eq 0x50 -and $bytes[2] -eq 0x4E -and $bytes[3] -eq 0x47 -and $bytes[4] -eq 0x0D -and $bytes[5] -eq 0x0A -and $bytes[6] -eq 0x1A -and $bytes[7] -eq 0x0A
$isPdf = $bytes.Length -ge 5 -and [Text.Encoding]::ASCII.GetString($bytes, 0, 5) -eq "%PDF-"
$isWebp = $bytes.Length -ge 12 -and [Text.Encoding]::ASCII.GetString($bytes, 0, 4) -eq "RIFF" -and [Text.Encoding]::ASCII.GetString($bytes, 8, 4) -eq "WEBP"
if (-not ($isJpeg -or $isPng -or $isPdf -or $isWebp)) {
  throw "Downloaded source file is not an approved JPEG, PNG, WebP, or PDF artifact."
}
if ([IO.Path]::GetFileName($ArchiveFile) -ne $ArchiveFile) {
  throw "ArchiveFile must be a filename, not a path."
}
$extension = [IO.Path]::GetExtension($ArchiveFile).ToLowerInvariant()
if ($extension -notin @(".jpg", ".jpeg", ".png", ".webp", ".pdf")) {
  throw "Only JPEG, PNG, WebP, and PDF source masters are supported."
}
$magicMatchesExtension = switch ($extension) {
  ".jpg" { $isJpeg }
  ".jpeg" { $isJpeg }
  ".png" { $isPng }
  ".webp" { $isWebp }
  ".pdf" { $isPdf }
  default { $false }
}
if (-not $magicMatchesExtension) {
  throw "Downloaded source bytes do not match the requested archive filename extension."
}

New-Item -ItemType Directory -Path $archive -Force | Out-Null
$destination = Join-Path $archive $ArchiveFile
$temporary = "$destination.partial"
$reuseExisting = $false
if (Test-Path -LiteralPath $destination -PathType Leaf) {
  $sourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $source).Hash
  $destinationHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $destination).Hash
  if ($sourceHash -ne $destinationHash) {
    throw "Archive destination already exists with different bytes; choose a unique stable filename."
  }
  $reuseExisting = $true
}
if (-not $reuseExisting) {
  Copy-Item -LiteralPath $source -Destination $temporary
  cipher /e $temporary | Out-Null
  $temporaryItem = Get-Item -LiteralPath $temporary
  if (-not ($temporaryItem.Attributes -band [IO.FileAttributes]::Encrypted)) {
    Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    throw "The temporary source master is not EFS encrypted."
  }
  Move-Item -LiteralPath $temporary -Destination $destination
}
cipher /e /a /q $destination | Out-Null
$item = Get-Item -LiteralPath $destination
if (-not ($item.Attributes -band [IO.FileAttributes]::Encrypted)) {
  throw "The archived source master is not EFS encrypted."
}

function Resolve-WslProjectRoot {
  if (-not [string]::IsNullOrWhiteSpace($env:FAMILY_HISTORY_WSL_PROJECT_ROOT)) {
    return $env:FAMILY_HISTORY_WSL_PROJECT_ROOT
  }

  $projectRoot = Split-Path -Parent $PSScriptRoot
  $normalizedRoot = $projectRoot -replace '/', '\'
  $uncMatch = [regex]::Match(
    $normalizedRoot,
    '^\\\\wsl(?:\.localhost|\$)\\Ubuntu\\(?<path>.+)$',
    [Text.RegularExpressions.RegexOptions]::IgnoreCase
  )
  if (-not $uncMatch.Success) {
    throw "Could not derive the exact WSL project root from the archive helper path; set FAMILY_HISTORY_WSL_PROJECT_ROOT explicitly."
  }
  return '/' + ($uncMatch.Groups['path'].Value -replace '\\', '/')
}

$wslProjectRoot = Resolve-WslProjectRoot
if ($wslProjectRoot -notmatch '^/(?:home|tmp)/[A-Za-z0-9._/-]+$' -or $wslProjectRoot -match '(?:^|/)\.\.(?:/|$)') {
  throw "FAMILY_HISTORY_WSL_PROJECT_ROOT must name one explicit project path under /home or /tmp."
}
wsl.exe -d Ubuntu --cd $wslProjectRoot test -f tools/register-subscription-record.mjs
if ($LASTEXITCODE -ne 0) { throw "The selected WSL project root is not a family-history checkout." }
# Plain wsl.exe commands run in a non-login shell, where node is the distribution's
# /usr/bin/node rather than the profile's project Node, and data:check needs Node 20+.
# Read the login-shell PATH once and run every project command under it.
$wslLoginPath = wsl.exe -d Ubuntu --cd $wslProjectRoot --exec bash -lc 'echo $PATH' | Select-Object -Last 1
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($wslLoginPath)) { throw "Could not read the WSL login-shell PATH." }
$wslLoginPath = $wslLoginPath.Trim()

function Invoke-ProjectWsl([string[]]$Command) {
  wsl.exe -d Ubuntu --cd $wslProjectRoot --exec env "PATH=$wslLoginPath" @Command
}

try {
  $registerArgs = @('tools/register-subscription-record.mjs', '--target', $TargetId, '--archive-file', $ArchiveFile, '--part', $Part)
  if ($PSBoundParameters.ContainsKey('RouteId')) { $registerArgs += @('--route', $RouteId) }
  Invoke-ProjectWsl (@('node') + $registerArgs)
  if ($LASTEXITCODE -ne 0) { throw "WSL subscription registration failed." }
  Invoke-ProjectWsl @('npm', 'run', 'records:import:subscriptions')
  if ($LASTEXITCODE -ne 0) { throw "WSL subscription import failed." }
  if ($DeferValidation) {
    Write-Output "Registered $TargetId; generated-view refresh and data:check deferred to the batch."
    Remove-Item -LiteralPath $source -Force
    return
  }
  Invoke-ProjectWsl @('npm', 'run', 'records:atoms:migrate')
  if ($LASTEXITCODE -ne 0) { throw "WSL source-atom refresh failed." }
  Invoke-ProjectWsl @('npm', 'run', 'research:current', '--', '--write')
  if ($LASTEXITCODE -ne 0) { throw "WSL research current-state refresh failed." }
  Invoke-ProjectWsl @('node', 'tools/seed-acquisition-session.mjs')
  if ($LASTEXITCODE -ne 0) { throw "WSL acquisition-ledger refresh failed." }
  Invoke-ProjectWsl @('npm', 'run', 'records:extract:snapshot')
  if ($LASTEXITCODE -ne 0) { throw "WSL extraction-campaign snapshot refresh failed." }
  Invoke-ProjectWsl @('npm', 'run', 'data:check')
  if ($LASTEXITCODE -ne 0) { throw "WSL data validation failed." }
  Remove-Item -LiteralPath $source -Force
} finally {
  Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
}
