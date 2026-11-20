[CmdletBinding()]
param(
  [ValidateSet("start", "status", "health", "restart")]
  [string]$Mode = "status"
)

$ErrorActionPreference = "Stop"
$Bridge = Join-Path $env:LOCALAPPDATA "SharedBrowserBridge\app\windows\playwright-mcp-windows.ps1"
if (-not (Test-Path -LiteralPath $Bridge -PathType Leaf)) {
  throw "Shared Browser Bridge is not installed at $Bridge."
}

$Mapped = switch ($Mode) {
  "start" { "Start" }
  "status" { "Status" }
  "health" { "Health" }
  "restart" { "Restart" }
}
& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $Bridge -Mode $Mapped
exit $LASTEXITCODE
