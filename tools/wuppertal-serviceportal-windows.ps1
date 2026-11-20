param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('inspect', 'click', 'status', 'close', 'cleanup', 'signin')]
  [string]$Mode,

  [string]$Url,

  [ValidateLength(0, 120)]
  [string]$Text,

  [ValidateRange(60, 1800)]
  [int]$WaitSeconds = 900,

  [ValidatePattern('^[a-z0-9][a-z0-9-]{0,31}$')]
  [string]$AffinitySlot = 'wuppertal-serviceportal',

  [switch]$SkipInstall
)

# Wuppertal Service Portal helper (exploration layer). Read-only: it never
# types, never reads field values, and refuses submit, payment and sign-in
# controls. See tools/wuppertal-serviceportal.mjs.

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
  $nodeArgs = @(
    'tools/wuppertal-serviceportal.mjs',
    '--shared-window',
    '--endpoint', $endpoint,
    '--mode', $Mode,
    '--affinity-slot', $AffinitySlot
  )
  if ($Url) { $nodeArgs += @('--url', $Url) }
  if ($Text) { $nodeArgs += @('--text', $Text) }
  $nodeArgs += @('--wait-seconds', $WaitSeconds)
  & node @nodeArgs
  if ($LASTEXITCODE -ne 0) { throw "Wuppertal Service Portal $Mode failed safely." }
} finally {
  if ($browserMutexAcquired) { try { $browserMutex.ReleaseMutex() } catch {} }
  $browserMutex.Dispose()
}
