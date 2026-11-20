param(
  [ValidateSet("save", "save-clipboard", "status", "invoke", "utf8-selftest")]
  [string]$Mode = "status"
)

# Setup/rotation: copy the dedicated key in the linked Claude Console organization,
# then run -Mode save-clipboard. It encrypts the key and clears only that clipboard
# value. -Mode save accepts piped stdin for a trusted local setup helper.

$ErrorActionPreference = "Stop"
$utf8 = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
Add-Type -AssemblyName System.Security
. (Join-Path $PSScriptRoot "tree-config.ps1")
$profileDirectory = Get-TreeLocalAppDataDirectory
$profilePath = Join-Path $profileDirectory "life-stories-anthropic-key.dpapi"
$entropy = $utf8.GetBytes("$(Get-TreeId)/life-stories-anthropic/v1")

# Windows PowerShell 5.1 decodes a response whose Content-Type omits a charset
# as ISO-8859-1, which mangles every non-ASCII character in a story (an o-umlaut
# arrives as two Latin-1 characters). Decode the raw bytes as UTF-8 instead, and project only
# the text blocks so thinking, signatures and transport details never leave here.
function ConvertFrom-MessagesResponseBytes([byte[]]$Bytes) {
  $response = $utf8.GetString($Bytes) | ConvertFrom-Json
  @{ stop_reason = $response.stop_reason; content = @($response.content | Where-Object { $_.type -eq "text" } | ForEach-Object { @{ type = "text"; text = $_.text } }); usage = $response.usage } | ConvertTo-Json -Depth 20 -Compress
}

if ($Mode -eq "utf8-selftest") {
  # Network-free check of the production decoding path on a fixed UTF-8 payload.
  # Keep this script ASCII: Windows PowerShell 5.1 reads a BOM-less file as ANSI.
  $text = "Sch$([char]0xF6)mberg, B$([char]0xFC)rger, J$([char]0xE4)ger, W$([char]0xFC)rttemberg"
  ConvertFrom-MessagesResponseBytes $utf8.GetBytes('{"stop_reason":"end_turn","content":[{"type":"thinking","thinking":"hidden"},{"type":"text","text":"' + $text + '"}],"usage":{"input_tokens":1,"output_tokens":1}}')
  exit 0
}

if ($Mode -eq "status") {
  @{ configured = (Test-Path -LiteralPath $profilePath); provider = "anthropic"; transport = "messages-api" } | ConvertTo-Json -Compress
  exit 0
}

try {
  if ($Mode -in @("save", "save-clipboard")) {
    $key = if ($Mode -eq "save-clipboard") { (Get-Clipboard -Raw).Trim() } else { [Console]::In.ReadToEnd().Trim() }
    if ($key -notmatch '^sk-ant-[A-Za-z0-9_-]+$' -or $key.Length -gt 512) { throw "Invalid credential" }
    $plainBytes = $utf8.GetBytes($key)
    $protectedBytes = [System.Security.Cryptography.ProtectedData]::Protect($plainBytes, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    New-Item -ItemType Directory -Force -Path $profileDirectory | Out-Null
    [System.IO.File]::WriteAllText($profilePath, [Convert]::ToBase64String($protectedBytes), [System.Text.Encoding]::ASCII)
    if ($Mode -eq "save-clipboard" -and (Get-Clipboard -Raw).Trim() -eq $key) { Set-Clipboard -Value $null }
    Write-Output '{"configured":true}'
  } else {
    if (-not (Test-Path -LiteralPath $profilePath)) { throw "Credential unavailable" }
    $body = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($body) -or $body.Length -gt 8000000) { throw "Invalid request size" }
    $request = $body | ConvertFrom-Json
    $allowed = @("model", "max_tokens", "system", "messages", "thinking", "output_config")
    if (@($request.PSObject.Properties.Name | Where-Object { $_ -notin $allowed }).Count) { throw "Unexpected request fields" }
    if ($request.model -ne "claude-opus-5-5" -or $request.max_tokens -ne 8192) { throw "Invalid model or token limit" }
    if ($request.output_config.format.type -ne "json_schema" -or $request.output_config.effort -ne "high") { throw "Structured output is required" }
    if ($request.thinking.type -ne "adaptive" -or @($request.messages).Count -ne 1 -or $request.messages[0].role -ne "user") { throw "Invalid request shape" }
    $protectedBytes = [Convert]::FromBase64String([System.IO.File]::ReadAllText($profilePath).Trim())
    $plainBytes = [System.Security.Cryptography.ProtectedData]::Unprotect($protectedBytes, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    $key = $utf8.GetString($plainBytes)
    $headers = @{ "x-api-key" = $key; "anthropic-version" = "2023-06-01" }
    $response = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "https://api.anthropic.com/v1/messages" -Headers $headers -ContentType "application/json; charset=utf-8" -Body $utf8.GetBytes($body) -TimeoutSec 600
    ConvertFrom-MessagesResponseBytes $response.RawContentStream.ToArray()
  }
} catch {
  $status = 0
  if ($_.Exception.Response -and $_.Exception.Response.StatusCode) { $status = [int]$_.Exception.Response.StatusCode }
  @{ error = "life-story-api-failed"; httpStatus = $status } | ConvertTo-Json -Compress
  exit 1
} finally {
  if ($plainBytes) { [Array]::Clear($plainBytes, 0, $plainBytes.Length) }
  if ($protectedBytes) { [Array]::Clear($protectedBytes, 0, $protectedBytes.Length) }
  $key = $null; $headers = $null; $body = $null; $request = $null; $response = $null
}
