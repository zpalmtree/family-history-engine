param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^gro-[a-z0-9-]+$')]
  [string]$Target,

  [switch]$Inspect,

  [ValidateRange(1, 65535)]
  [int]$DebugPort = 9226
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
Set-Location $ProjectRoot

if ($DebugPort -ne 9226) {
  throw "GRO saved-card assist is fixed to the shared Windows Chrome endpoint on port 9226."
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Windows Node.js was not found on PATH."
}

$escapedTarget = [Regex]::Escape($Target)
$targetPattern = '--target\s+"?{0}"?(?:\s|$)' -f $escapedTarget
$activeOrders = @(
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object {
      $_.CommandLine -match 'tools[\\/]gro-order-frank\.mjs' -and
      $_.CommandLine -match $targetPattern
    }
)
if ($activeOrders.Count -ne 1) {
  throw "Expected one paused GRO order process for $Target; found $($activeOrders.Count)."
}

$assistMutex = [System.Threading.Mutex]::new($false, 'Local\FamilyHistoryGroSavedCardAssist')
$acquired = $false
try {
  $acquired = $assistMutex.WaitOne(0)
  if (-not $acquired) { throw "Another GRO saved-card assist is already running." }
  $nodeArgs = @("tools/gro-saved-card-assist.mjs", "--target", $Target, "--endpoint", "http://127.0.0.1:$DebugPort")
  if ($Inspect) { $nodeArgs += "--inspect" }
  node @nodeArgs
  if ($LASTEXITCODE -ne 0) { throw "GRO saved-card assist failed safely." }
} finally {
  if ($acquired) {
    try { $assistMutex.ReleaseMutex() } catch {}
  }
  $assistMutex.Dispose()
}
