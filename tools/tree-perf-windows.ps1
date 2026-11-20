param(
  [string]$PageRoot,
  [double]$DeviceScaleFactor = 1,
  [string]$ShotDir,
  [switch]$Gpu,
  [string]$ExtraCss,
  [string[]]$Views
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
Set-Location $ProjectRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Windows Node.js was not found on PATH. Install Node for Windows or add it to PATH."
}

if (-not (Test-Path (Join-Path $ProjectRoot "node_modules/playwright-core"))) {
  npm install
}

if (-not $env:CHROME_PATH) {
  $chrome = Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe"
  if (-not (Test-Path $chrome)) {
    $chrome = Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe"
  }
  $env:CHROME_PATH = $chrome
}


$env:TREE_PERF_DPR = [string]$DeviceScaleFactor
if ($ExtraCss) {
  $env:TREE_PERF_CSS = $ExtraCss
}
if ($Gpu) {
  $env:TREE_PERF_GPU = "1"
}
if ($ShotDir) {
  $env:TREE_PERF_SHOT_DIR = $ShotDir
}

if ($PageRoot) {
  $env:TREE_PAGE_ROOT = $PageRoot
}

node tools/tree-perf-benchmark.mjs @Views
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
