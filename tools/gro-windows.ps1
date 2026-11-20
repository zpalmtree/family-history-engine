param(
  [ValidateSet("profile", "dry-run", "index", "order", "queue", "resume", "check-orders", "recover-payment")]
  [string]$Mode = "queue",

  [string]$Target,
  [string]$Queue = "evidence/gro/order-queue.json",
  [switch]$Headless,
  [switch]$SkipInstall,

  [ValidateRange(1, 65535)]
  [int]$DebugPort = 9226,

  [ValidatePattern('^[a-z0-9][a-z0-9-]{0,31}$')]
  [string]$AffinitySlot = "gro-orders"
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
Set-Location $ProjectRoot

if ($DebugPort -ne 9226) {
  throw "GRO is fixed to the one shared localhost Chrome/CDP endpoint on port 9226."
}
if ($Headless) {
  throw "GRO uses a background task tab in the existing shared Windows Chrome window; separate headless browser launches are disabled."
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Windows Node.js was not found on PATH. Install Node for Windows or add it to PATH."
}

if (-not $SkipInstall -and -not (Test-Path (Join-Path $ProjectRoot "node_modules/playwright-core"))) {
  npm install
}

$script = if ($Mode -eq "check-orders") {
  "tools/gro-check-orders.mjs"
} elseif ($Mode -eq "recover-payment") {
  "tools/gro-payment-recover.mjs"
} else {
  "tools/gro-order-frank.mjs"
}

$nodeArgs = @($script)
$nodeArgs += @("--shared-window", "--endpoint", "http://127.0.0.1:9226", "--affinity-slot", $AffinitySlot)
if ($Mode -notin @("check-orders", "recover-payment")) { $nodeArgs += "--$Mode" }

if ($Mode -eq "queue" -and $Queue) {
  $nodeArgs += $Queue
}

if ($Target) {
  $nodeArgs += @("--target", $Target)
}

$browserMutex = [System.Threading.Mutex]::new($false, 'Local\FamilyHistorySubscriptionChromeSharedWindow')
$browserMutexAcquired = $false
try {
  try {
    $browserMutexAcquired = $browserMutex.WaitOne(180000)
  } catch [System.Threading.AbandonedMutexException] {
    $browserMutexAcquired = $true
  }
  if (-not $browserMutexAcquired) {
    throw "The one shared Windows Chrome window is busy in another family-history session; retry after that transaction finishes."
  }

  $endpoint = "http://127.0.0.1:9226"
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

  Write-Host "Running GRO in a background task tab in the existing shared Windows Chrome/CDP window"
  Write-Host "Project:  $ProjectRoot"
  Write-Host "Endpoint: $endpoint"
  Write-Host "Affinity: $AffinitySlot"

  node @nodeArgs
  if ($LASTEXITCODE -ne 0) { throw "Shared-window GRO action failed: $Mode" }
} finally {
  if ($browserMutexAcquired) {
    try { $browserMutex.ReleaseMutex() } catch {}
  }
  $browserMutex.Dispose()
}
