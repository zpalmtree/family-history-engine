param(
  [ValidateSet('setup', 'start', 'status', 'stop')]
  [string]$Mode = 'start',

  [ValidateRange(1024, 65535)]
  [int]$DebugPort = 9226
)

$ErrorActionPreference = 'Stop'
if ($DebugPort -ne 9226) {
  throw 'The canonical shared Chrome debugging endpoint is fixed to localhost port 9226.'
}

$sharedCommand = Join-Path $PSScriptRoot 'shared-browser-command-windows.ps1'
$subscriptionController = Join-Path $PSScriptRoot 'subscription-cdp.mjs'

switch ($Mode) {
  'start' {
    & $sharedCommand -Mode start
    if ($LASTEXITCODE -ne 0) { throw 'Shared Browser Bridge failed to start.' }
  }
  'status' {
    & $sharedCommand -Mode health
    if ($LASTEXITCODE -ne 0) { throw 'Shared Browser Bridge is not healthy.' }
  }
  'setup' {
    & $sharedCommand -Mode start
    if ($LASTEXITCODE -ne 0) { throw 'Shared Browser Bridge failed to start.' }
    & node.exe $subscriptionController --mode setup --affinity-slot setup
    if ($LASTEXITCODE -ne 0) { throw 'Subscription provider setup failed.' }
  }
  'stop' {
    # This public command now closes only Ancestry/Findmypast task tabs and
    # releases their broker lease. Shared Chrome remains alive for other apps.
    & node.exe $subscriptionController --mode stop --affinity-slot shutdown
    if ($LASTEXITCODE -ne 0) { throw 'Subscription provider tab cleanup failed.' }
  }
}
