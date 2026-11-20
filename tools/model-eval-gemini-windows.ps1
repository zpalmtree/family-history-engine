param(
  [ValidateSet("save", "status", "clear", "invoke")]
  [string]$Mode = "status"
)

$ErrorActionPreference = "Stop"
$utf8 = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
Add-Type -AssemblyName System.Security
. (Join-Path $PSScriptRoot "tree-config.ps1")
$profileDirectory = Get-TreeLocalAppDataDirectory
$profilePath = Join-Path $profileDirectory "model-eval-gemini-key.dpapi"
$entropy = [System.Text.Encoding]::UTF8.GetBytes("$(Get-TreeId)/model-eval-gemini/v1")

if ($Mode -eq "save") {
  $plain = [Console]::In.ReadToEnd().Trim()
  if ([string]::IsNullOrWhiteSpace($plain) -or $plain.Length -gt 512) { throw "Provide one bounded Gemini API key on standard input." }
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($plain)
  try {
    $protected = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    New-Item -ItemType Directory -Force -Path $profileDirectory | Out-Null
    [System.IO.File]::WriteAllText($profilePath, [Convert]::ToBase64String($protected), [System.Text.Encoding]::ASCII)
  } finally {
    if ($bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
    if ($protected) { [Array]::Clear($protected, 0, $protected.Length) }
    $plain = $null
  }
  Write-Output "saved"
  exit 0
}

if ($Mode -eq "status") {
  if (Test-Path -LiteralPath $profilePath) { Write-Output "configured" } else { Write-Output "not-configured" }
  exit 0
}

if ($Mode -eq "clear") {
  if (Test-Path -LiteralPath $profilePath) { Remove-Item -LiteralPath $profilePath -Force }
  Write-Output "cleared"
  exit 0
}

if (-not (Test-Path -LiteralPath $profilePath)) { throw "Gemini model-eval key is not configured." }
$requestText = [Console]::In.ReadToEnd()
if ([string]::IsNullOrWhiteSpace($requestText) -or $requestText.Length -gt 8000000) { throw "A bounded Gemini request is required on standard input." }
try {
  $request = $requestText | ConvertFrom-Json
  if ($request.model -ne "gemini-3.7-flash") { throw "Only gemini-3.7-flash is allowed by this bridge." }
  if ($request.store -ne $false -or $request.background -ne $false -or $request.stream -ne $false) { throw "Gemini retention/background/stream guards are not fixed." }
  if ($request.generation_config.tool_choice -ne "none" -or $request.tools) { throw "Gemini tools are forbidden in model evaluation." }
  $protectedBytes = [Convert]::FromBase64String([System.IO.File]::ReadAllText($profilePath).Trim())
  $plainBytes = [System.Security.Cryptography.ProtectedData]::Unprotect($protectedBytes, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  $key = [System.Text.Encoding]::UTF8.GetString($plainBytes)
  $headers = @{ "x-goog-api-key" = $key }
  $body = $request | ConvertTo-Json -Depth 100 -Compress
  $response = Invoke-RestMethod -Method Post -Uri "https://generativelanguage.googleapis.com/v1beta/interactions" -Headers $headers -ContentType "application/json" -Body $body
  $response | ConvertTo-Json -Depth 100 -Compress
} catch {
  throw "Gemini request failed; credentials and request details were suppressed."
} finally {
  if ($plainBytes) { [Array]::Clear($plainBytes, 0, $plainBytes.Length) }
  if ($protectedBytes) { [Array]::Clear($protectedBytes, 0, $protectedBytes.Length) }
  $key = $null
  $headers = $null
  $body = $null
  $requestText = $null
}
