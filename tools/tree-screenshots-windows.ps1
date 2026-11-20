param(
  [string]$OutDir,
  [string]$PageRoot,
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

if ($OutDir) {
  $env:TREE_SCREENSHOT_DIR = $OutDir
}

if ($PageRoot) {
  $env:TREE_PAGE_ROOT = $PageRoot
}

node tools/tree-screenshots.mjs @Views
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
