param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('inspect', 'capture', 'search')]
  [string]$Mode,

  [string]$County = '',

  [string]$Book = '',

  [string]$Page = '',

  [string]$Pages = '',

  [string]$LastName = '',

  [string]$FirstName = '',

  [ValidatePattern('^$|^[a-z0-9][a-z0-9-]{0,127}$')]
  [string]$TargetId = '',

  [ValidatePattern('^[a-z0-9][a-z0-9-]{0,31}$')]
  [string]$AffinitySlot = 'mdlandrec',

  [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
Set-Location $ProjectRoot

if ($Mode -eq 'capture') {
  # -Pages captures several folios inside one signed-in run; the site's session
  # expires across separate runs, costing a re-authentication each time.
  if ($Pages -and $Pages -notmatch '^\d{1,4}(,\d{1,4})*$') {
    throw '-Pages must be a comma-separated list of folio numbers.'
  }
  if (-not $County -or -not $Book -or -not $TargetId -or (-not $Pages -and $Page -notmatch '^\d{1,4}$')) {
    throw 'Capture requires -County, -Book, -TargetId, and either a numeric -Page or a -Pages list.'
  }
}

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
    $browserMutexAcquired = $browserMutex.WaitOne(180000)
  } catch [System.Threading.AbandonedMutexException] {
    $browserMutexAcquired = $true
  }
  if (-not $browserMutexAcquired) {
    throw 'The one shared Windows Chrome window is busy; retry after the current family-history task finishes.'
  }

  $nodeArgs = @(
    'tools/mdlandrec-capture.mjs',
    '--shared-window',
    '--endpoint', $endpoint,
    '--mode', $Mode,
    '--affinity-slot', $AffinitySlot
  )
  if ($County) { $nodeArgs += @('--county', $County) }
  if ($Book) { $nodeArgs += @('--book', $Book) }
  if ($Page) { $nodeArgs += @('--page', $Page) }
  if ($Pages) { $nodeArgs += @('--pages', $Pages) }
  if ($TargetId) { $nodeArgs += @('--target-id', $TargetId) }
  if ($LastName) { $nodeArgs += @('--last-name', $LastName) }
  if ($FirstName) { $nodeArgs += @('--first-name', $FirstName) }
  node @nodeArgs
  if ($LASTEXITCODE -ne 0) { throw "MDLandRec $Mode failed safely." }
} finally {
  if ($browserMutexAcquired) {
    try { $browserMutex.ReleaseMutex() } catch {}
  }
  $browserMutex.Dispose()
}
