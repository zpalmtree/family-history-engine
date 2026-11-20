param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-z0-9][a-z0-9-]{0,127}$')]
  [string]$Request,
  [switch]$Explore,
  [switch]$FillRecipient,
  [switch]$SetAmount,
  [switch]$Details,
  [switch]$MoneyLines,
  [switch]$TransferStatus,
  [ValidatePattern('^(/[A-Za-z0-9/_#?=&.-]{0,120})?$')]
  [string]$Path = "",
  [ValidateLength(0, 300)]
  [string]$Clicks = "",
  [switch]$SkipInstall
)
# Guarded Wise bank transfer for one canonical request (AGENTS.md, 3 Nov 2026).
# Holds the one shared-window mutex and streams the Node output.
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
  $nodeArgs = @("tools/guarded-bank-transfer.mjs", "--shared-window", "--request", $Request)
  if ($Explore) { $nodeArgs += "--explore" }
  if ($Path) { $nodeArgs += @("--path", $Path) }
  if ($Clicks) { $nodeArgs += @("--clicks", $Clicks) }
  if ($FillRecipient) { $nodeArgs += "--fill-recipient" }
  if ($SetAmount) { $nodeArgs += "--set-amount" }
  if ($Details) { $nodeArgs += "--details" }
  if ($MoneyLines) { $nodeArgs += "--money-lines" }
  if ($TransferStatus) { $nodeArgs += "--transfer-status" }
  & node @nodeArgs
  if ($LASTEXITCODE -ne 0) { throw "Guarded transfer stopped without sending (see the reason above)." }
} finally {
  if ($acquired) { try { $browserMutex.ReleaseMutex() } catch {} }
  $browserMutex.Dispose()
}
