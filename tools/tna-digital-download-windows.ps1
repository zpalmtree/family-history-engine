param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-z0-9][a-z0-9-]{0,127}$')]
  [string]$Target,
  [switch]$Explore,
  [switch]$SkipInstall
)
# Free National Archives digital download for one canonical target, inside the
# one shared Windows Chrome profile's mutex (no Linux browser, no direct launch).
$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
Set-Location $ProjectRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Windows Node.js was not found on PATH." }
if (-not $SkipInstall -and -not (Test-Path (Join-Path $ProjectRoot "node_modules/playwright-core"))) { npm install }
$endpoint = "http://127.0.0.1:9226"
try { Invoke-RestMethod -Uri "$endpoint/json/version" -TimeoutSec 2 | Out-Null } catch {
  & (Join-Path $ScriptDir "subscription-cdp-windows.ps1") -Mode start
  if ($LASTEXITCODE -ne 0) { throw "The shared Windows Chrome profile could not be started." }
}
$browserMutex = [System.Threading.Mutex]::new($false, 'Local\FamilyHistorySubscriptionChromeSharedWindow')
$acquired = $false
try {
  try { $acquired = $browserMutex.WaitOne(180000) } catch [System.Threading.AbandonedMutexException] { $acquired = $true }
  if (-not $acquired) { throw "The one shared Windows Chrome window is busy; retry after the current family-history task finishes." }
  $nodeArgs = @("tools/tna-digital-download.mjs", "--target", $Target)
  if ($Explore) { $nodeArgs += "--explore" }
  & node @nodeArgs
  if ($LASTEXITCODE -ne 0) { throw "The TNA download stopped (see the reason above)." }
} finally {
  if ($acquired) { try { $browserMutex.ReleaseMutex() } catch {} }
  $browserMutex.Dispose()
}
