param(
  [string]$Providers = 'familysearch,findmypast,ancestry',
  [switch]$Probe
)

# Guarded saved-credential sign-in in the one shared Windows Chrome profile.
# Holds the shared-window mutex for the whole sweep; see tools/saved-signin.mjs
# for what the helper will and will not do.

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$endpoint = 'http://127.0.0.1:9226'
$browserMutex = [System.Threading.Mutex]::new($false, 'Local\FamilyHistorySubscriptionChromeSharedWindow')
$browserMutexAcquired = $false

if ($Providers -notmatch '^[a-z]+(,[a-z]+)*$') { throw 'Providers must be a comma-separated list of provider ids.' }

try {
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

  try { $browserMutexAcquired = $browserMutex.WaitOne(900000) }
  catch [System.Threading.AbandonedMutexException] { $browserMutexAcquired = $true }
  if (-not $browserMutexAcquired) { throw 'The one shared Windows Chrome window is busy; retry after the current transaction.' }

  $nodeArgs = @((Join-Path $ScriptDir 'provider-signin.mjs'), '--providers', $Providers)
  if ($Probe) { $nodeArgs += '--probe' }
  & node.exe @nodeArgs
  if ($LASTEXITCODE -ne 0) { throw 'Saved sign-in sweep reported an error.' }
} finally {
  if ($browserMutexAcquired) { try { $browserMutex.ReleaseMutex() } catch {} }
  $browserMutex.Dispose()
}
