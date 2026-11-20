param(
  [ValidateSet("dry-run", "prepare", "submit", "verify", "capture-profile")]
  [string]$Mode = "prepare",

  [string]$Queue = "evidence/tlcpl/scan-queue.json",
  [string]$Batch = "1",
  [string]$Confirmation,
  [switch]$Headless,
  [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
Set-Location $ProjectRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Windows Node.js was not found on PATH. Install Node for Windows or add it to PATH."
}

if (-not $SkipInstall -and -not (Test-Path (Join-Path $ProjectRoot "node_modules/playwright-core"))) {
  npm install
}

if ($Headless) { throw "TLCPL uses the existing shared Windows Chrome window; headless mode is unavailable." }

$endpoint = "http://127.0.0.1:9226"
$browserMutex = $null
$browserMutexAcquired = $false
if ($Mode -in @("prepare", "submit", "verify", "capture-profile")) {
  $ready = $false
  try {
    Invoke-RestMethod -Uri "$endpoint/json/version" -TimeoutSec 2 | Out-Null
    $ready = $true
  } catch {}
  if (-not $ready) {
    & (Join-Path $ScriptDir "subscription-cdp-windows.ps1") -Mode start
    if ($LASTEXITCODE -ne 0) { throw "The shared Windows Chrome profile could not be started." }
    for ($attempt = 0; $attempt -lt 80 -and -not $ready; $attempt++) {
      Start-Sleep -Milliseconds 250
      try {
        Invoke-RestMethod -Uri "$endpoint/json/version" -TimeoutSec 2 | Out-Null
        $ready = $true
      } catch {}
    }
  }
  if (-not $ready) { throw "The shared Windows Chrome profile exposed no localhost CDP endpoint." }

  $browserMutex = [System.Threading.Mutex]::new($false, 'Local\FamilyHistorySubscriptionChromeSharedWindow')
  try {
    $browserMutexAcquired = $browserMutex.WaitOne(180000)
  } catch [System.Threading.AbandonedMutexException] {
    $browserMutexAcquired = $true
  }
  if (-not $browserMutexAcquired) {
    throw "The one shared Windows Chrome window is busy in another family-history session; retry after that queued transaction finishes."
  }
}

$nodeArgs = @("tools/tlcpl-obit-scans.mjs", "--$Mode", "--queue", $Queue, "--batch", $Batch)

if ($Mode -eq "submit") {
  if ([string]::IsNullOrWhiteSpace($Confirmation)) {
    throw "TLCPL final submission requires the exact documented -Confirmation phrase."
  }
  $nodeArgs += @("--confirmation", $Confirmation)
}

Write-Host "Running TLCPL obituary scan helper in Windows Chrome mode"
Write-Host "Project: $ProjectRoot"
Write-Host "Shared Chrome endpoint: $endpoint"
Write-Host "Queue:   $Queue"
Write-Host "Batch:   $Batch"

try {
  node @nodeArgs
  if ($LASTEXITCODE -ne 0) { throw "TLCPL helper failed with exit code $LASTEXITCODE." }
} finally {
  if ($browserMutexAcquired) {
    try { $browserMutex.ReleaseMutex() } catch {}
  }
  if ($browserMutex) { $browserMutex.Dispose() }
}
