param(
  [ValidateSet('setup', 'start', 'status', 'login-status', 'stop', 'audit-tabs', 'clean-tabs', 'clean-error-tabs')]
  [string]$Mode = 'status'
)

$ErrorActionPreference = 'Stop'
$nodeScript = Join-Path $PSScriptRoot 'subscription-cdp.mjs'
$slot = switch ($Mode) {
  'setup' { 'setup' }
  'start' { 'startup' }
  'stop' { 'shutdown' }
  default { 'status' }
}

$browserMutex = [System.Threading.Mutex]::new($false, 'Local\FamilyHistorySubscriptionChromeSharedWindow')
$browserMutexAcquired = $false
try {
  try {
    $browserMutexAcquired = $browserMutex.WaitOne(900000)
  } catch [System.Threading.AbandonedMutexException] {
    $browserMutexAcquired = $true
  }
  if (-not $browserMutexAcquired) {
    throw 'The shared background subscription browser is busy in another agent; retry after that transaction finishes.'
  }
  & node.exe $nodeScript --mode $Mode --affinity-slot $slot
  if ($LASTEXITCODE -ne 0) {
    throw "Background subscription command failed: $Mode"
  }
} finally {
  if ($browserMutexAcquired) {
    try { $browserMutex.ReleaseMutex() } catch {}
  }
  $browserMutex.Dispose()
}
