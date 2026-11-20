# Shared Gmail inbox tidy (user request, 18 Nov 2026): list inbox rows, or
# archive / move to Bin exact thread ids. Serialized on the shared-window mutex.
param(
  [ValidateSet("list", "act", "archived-unread", "markread")]
  [string]$Mode = "list",

  [ValidatePattern('^[0-9a-f,]{0,20000}$')]
  [string]$Archive = "",

  [ValidatePattern('^[0-9a-f,]{0,20000}$')]
  [string]$Trash = "",

  # markread: exact archived thread ids to mark read (nothing is moved).
  [ValidatePattern('^[0-9a-f,]{0,20000}$')]
  [string]$MarkRead = "",

  # Optional JSON file {threadId: subject} checked before acting.
  [string]$Expect = "",

  [ValidatePattern('^[a-z0-9][a-z0-9-]{0,31}$')]
  [string]$AffinitySlot = "gmail-inbox-tidy",

  [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
Set-Location $ProjectRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Windows Node.js was not found on PATH." }
if (-not $SkipInstall -and -not (Test-Path (Join-Path $ProjectRoot "node_modules/playwright-core"))) { npm install }

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
  $nodeArgs = @("tools/gmail-inbox-tidy.mjs", "--shared-window", "--endpoint", $endpoint, "--affinity-slot", $AffinitySlot, "--mode", $Mode)
  if ($Archive) { $nodeArgs += @("--archive", $Archive) }
  if ($Trash) { $nodeArgs += @("--trash", $Trash) }
  if ($MarkRead) { $nodeArgs += @("--markread", $MarkRead) }
  if ($Expect) { $nodeArgs += @("--expect", $Expect) }
  node @nodeArgs
  if ($LASTEXITCODE -ne 0) { throw "Gmail inbox tidy failed safely." }
} finally {
  if ($browserMutexAcquired) { try { $browserMutex.ReleaseMutex() } catch {} }
  $browserMutex.Dispose()
}
