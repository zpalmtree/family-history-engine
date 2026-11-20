param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('inspect', 'purchase', 'viewer-inspect', 'capture', 'cleanup')]
  [string]$Mode,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-z0-9][a-z0-9-]{0,127}$')]
  [string]$Target,

  [ValidatePattern('^[a-z0-9][a-z0-9-]{0,127}$')]
  [string]$Route,

  [Parameter(Mandatory = $true)]
  [string]$Confirmation,

  [ValidatePattern('^[a-z0-9][a-z0-9-]{0,31}$')]
  [string]$AffinitySlot = 'archion-access',

  [ValidatePattern('^\d{1,3}$')]
  [string]$Page,

  [ValidatePattern('^\d{1,3}(,\d{1,3}){0,19}$')]
  [string]$Pages,

  [ValidateRange(0, 4)]
  [int]$ZoomSteps = 0,

  [switch]$PanTop,

  [switch]$PanMiddle,

  [switch]$PanBottom,

  [switch]$PanDeepBottom,

  [switch]$CaptureTriplet,

  [switch]$ReadRecognizedText,

  [switch]$CreateAccount,

  # viewer-inspect only: a temporary target description outside the repository
  # (a WSL path such as /tmp/... or a Windows path), for reading a volume on
  # screen before it has a canonical acquisition target.
  [ValidatePattern('^[^\x00-\x1f"<>|*?]{1,400}\.json$')]
  [string]$TargetFile,

  [ValidatePattern('^[a-z0-9][a-z0-9-]{0,127}$')]
  [string]$ReuseConfirmationTarget,

  [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
Set-Location $ProjectRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Windows Node.js was not found on PATH.'
}
if (-not $SkipInstall -and -not (Test-Path (Join-Path $ProjectRoot 'node_modules/playwright-core'))) {
  npm install
}

$endpoint = 'http://127.0.0.1:9226'
$ready = $false
try {
  Invoke-RestMethod -Uri "$endpoint/json/version" -TimeoutSec 2 | Out-Null
  $ready = $true
} catch {}
if (-not $ready) {
  & (Join-Path $ScriptDir 'subscription-cdp-windows.ps1') -Mode start
  if ($LASTEXITCODE -ne 0) { throw 'The shared Windows Chrome profile could not be started.' }
  for ($attempt = 0; $attempt -lt 80 -and -not $ready; $attempt++) {
    Start-Sleep -Milliseconds 250
    try {
      Invoke-RestMethod -Uri "$endpoint/json/version" -TimeoutSec 2 | Out-Null
      $ready = $true
    } catch {}
  }
}
if (-not $ready) { throw 'The shared Windows Chrome profile exposed no localhost CDP endpoint.' }

$browserMutex = [System.Threading.Mutex]::new($false, 'Local\FamilyHistorySubscriptionChromeSharedWindow')
$browserMutexAcquired = $false
try {
  try {
    $browserMutexAcquired = $browserMutex.WaitOne(900000)
  } catch [System.Threading.AbandonedMutexException] {
    $browserMutexAcquired = $true
  }
  if (-not $browserMutexAcquired) {
    throw 'The one shared Windows Chrome window is busy; retry after the current family-history task finishes.'
  }

  $nodeArgs = @(
    'tools/archion-access.mjs',
    '--shared-window',
    '--endpoint', $endpoint,
    '--mode', $Mode,
    '--target', $Target,
    '--confirmation', $Confirmation,
    '--affinity-slot', $AffinitySlot
  )
  if ($PSBoundParameters.ContainsKey('Route')) { $nodeArgs += @('--route', $Route) }
  if ($PSBoundParameters.ContainsKey('ReuseConfirmationTarget')) { $nodeArgs += @('--reuse-confirmation-target', $ReuseConfirmationTarget) }
  if ($PSBoundParameters.ContainsKey('Page')) { $nodeArgs += @('--page', $Page) }
  if ($PSBoundParameters.ContainsKey('Pages')) { $nodeArgs += @('--pages', $Pages) }
  if ($PSBoundParameters.ContainsKey('ZoomSteps')) { $nodeArgs += @('--zoom-steps', [string]$ZoomSteps) }
  if ($PanTop) { $nodeArgs += '--pan-top' }
  if ($PanMiddle) { $nodeArgs += '--pan-middle' }
  if ($PanBottom) { $nodeArgs += '--pan-bottom' }
  if ($PanDeepBottom) { $nodeArgs += '--pan-deep-bottom' }
  if ($CaptureTriplet) { $nodeArgs += '--capture-triplet' }
  if ($ReadRecognizedText) { $nodeArgs += '--read-recognized-text' }
  if ($CreateAccount) { $nodeArgs += '--create-account' }
  if ($PSBoundParameters.ContainsKey('TargetFile')) {
    if ($Mode -ne 'viewer-inspect') { throw '-TargetFile is accepted only with -Mode viewer-inspect.' }
    $targetFilePath = $TargetFile
    if ($targetFilePath.StartsWith('/')) {
      # A WSL path: resolve it on the same distribution share as this checkout.
      $distroRoot = $ProjectRoot.Substring(0, $ProjectRoot.IndexOf('\home\'))
      $targetFilePath = $distroRoot + $targetFilePath.Replace('/', '\')
    }
    $nodeArgs += @('--target-file', $targetFilePath)
  }
  $nodeExitCode = 1
  $savedErrorActionPreference = $ErrorActionPreference
  try {
    # Windows PowerShell 5.1 can promote native stderr into a terminating
    # NativeCommandError when the script-wide preference is Stop, truncating
    # the helper's safe diagnostic before its actual error message. Stream both
    # native channels while the helper runs, then enforce its exit code here.
    $ErrorActionPreference = 'Continue'
    node @nodeArgs 2>&1 | ForEach-Object { Write-Host $_ }
    $nodeExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $savedErrorActionPreference
  }
  if ($nodeExitCode -ne 0) { throw "Archion $Mode failed safely." }
} finally {
  if ($browserMutexAcquired) {
    try { $browserMutex.ReleaseMutex() } catch {}
  }
  $browserMutex.Dispose()
}
