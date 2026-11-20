param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-z0-9][a-z0-9-]{0,127}$')]
  [string]$Request,
  [ValidatePattern('^[a-z0-9][a-z0-9-]{0,31}$')]
  [string]$AffinitySlot = "inquiry-attachment-download"
)
$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
Set-Location $ProjectRoot
$endpoint = "http://127.0.0.1:9226"
$ready = $false
try { Invoke-RestMethod -Uri "$endpoint/json/version" -TimeoutSec 2 | Out-Null; $ready = $true } catch {}
if (-not $ready) {
  & (Join-Path $ScriptDir "subscription-cdp-windows.ps1") -Mode start
  if ($LASTEXITCODE -ne 0) { throw "The shared Windows Chrome profile could not be started." }
  for ($attempt = 0; $attempt -lt 80 -and -not $ready; $attempt++) {
    Start-Sleep -Milliseconds 250
    try { Invoke-RestMethod -Uri "$endpoint/json/version" -TimeoutSec 2 | Out-Null; $ready = $true } catch {}
  }
}
if (-not $ready) { throw "The shared Windows Chrome profile exposed no localhost CDP endpoint." }
$browserMutex = [System.Threading.Mutex]::new($false, 'Local\FamilyHistorySubscriptionChromeSharedWindow')
$browserMutexAcquired = $false
try {
  try { $browserMutexAcquired = $browserMutex.WaitOne(180000) }
  catch [System.Threading.AbandonedMutexException] { $browserMutexAcquired = $true }
  if (-not $browserMutexAcquired) { throw "The one shared Windows Chrome window is busy; retry later." }
  node tools/download-inquiry-attachments.mjs --shared-window --endpoint $endpoint --affinity-slot $AffinitySlot --request $Request
  if ($LASTEXITCODE -ne 0) { throw "Inquiry attachment recovery failed safely." }
} finally {
  if ($browserMutexAcquired) { try { $browserMutex.ReleaseMutex() } catch {} }
  $browserMutex.Dispose()
}
