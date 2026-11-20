param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('inspect', 'diagnose', 'submit', 'receipt')]
  [string]$Mode,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-z0-9][a-z0-9-]{0,127}$')]
  [string]$Target,

  [Parameter(Mandatory = $true)]
  [string]$Confirmation,

  [ValidatePattern('^[a-z0-9][a-z0-9-]{0,31}$')]
  [string]$AffinitySlot = 'archive-contact-form',

  [ValidateRange(60, 3600)]
  [int]$CaptchaWaitSeconds = 900,

  [switch]$ResumeReview,

  [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
Set-Location $ProjectRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Windows Node.js was not found on PATH.' }
if (-not $SkipInstall -and -not (Test-Path (Join-Path $ProjectRoot 'node_modules/playwright-core'))) { npm install }

$endpoint = 'http://127.0.0.1:9226'
$ready = $false
try { Invoke-RestMethod -Uri "$endpoint/json/version" -TimeoutSec 2 | Out-Null; $ready = $true } catch {}
if (-not $ready) {
  & (Join-Path $ScriptDir 'subscription-cdp-windows.ps1') -Mode start
  if ($LASTEXITCODE -ne 0) { throw 'The shared Windows Chrome profile could not be started.' }
  for ($attempt = 0; $attempt -lt 80 -and -not $ready; $attempt++) {
    Start-Sleep -Milliseconds 250
    try { Invoke-RestMethod -Uri "$endpoint/json/version" -TimeoutSec 2 | Out-Null; $ready = $true } catch {}
  }
}
if (-not $ready) { throw 'The shared Windows Chrome profile exposed no localhost CDP endpoint.' }

$browserMutex = [System.Threading.Mutex]::new($false, 'Local\FamilyHistorySubscriptionChromeSharedWindow')
$browserMutexAcquired = $false
try {
  try { $browserMutexAcquired = $browserMutex.WaitOne(180000) }
  catch [System.Threading.AbandonedMutexException] { $browserMutexAcquired = $true }
  if (-not $browserMutexAcquired) { throw 'The one shared Windows Chrome window is busy; retry later.' }
  # Argument splatting keeps the multi-word confirmation phrase intact instead of
  # letting the shell split it into a positional argument.
  $nodeArgs = @(
    'tools/authorized-contact-form.mjs',
    '--shared-window',
    '--endpoint', $endpoint,
    '--mode', $Mode,
    '--target', $Target,
    '--confirmation', $Confirmation,
    '--affinity-slot', $AffinitySlot,
    '--captcha-wait-seconds', $CaptchaWaitSeconds
  )

  if ($ResumeReview) { $nodeArgs += '--resume-review' }

  # The requester locality fields reach Node only over stdin. They are never
  # placed on a command line, in an environment variable, or in the repository.
  $profileJson = $null
  if ($Mode -notin @('inspect', 'receipt')) {
    $profileJson = & (Join-Path $ScriptDir 'archive-request-profile.ps1') -Mode load
  }
  try {
    if ([string]::IsNullOrWhiteSpace($profileJson)) {
      & node @nodeArgs
    } else {
      $nodeArgs += '--contact-profile-stdin'
      $profileJson | & node @nodeArgs
    }
  } finally {
    $profileJson = $null
  }
  if ($LASTEXITCODE -ne 0) { throw "Authorized contact-form $Mode failed safely." }
} finally {
  if ($browserMutexAcquired) { try { $browserMutex.ReleaseMutex() } catch {} }
  $browserMutex.Dispose()
}
