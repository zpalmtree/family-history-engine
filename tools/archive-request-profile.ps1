param(
  [ValidateSet("save", "load", "status", "clear")]
  [string]$Mode = "status"
)

# Reusable requester contact fields for authorized archive contact forms.
#
# Name and email still come live from the signed-in Gmail identity at submit
# time; this profile only supplies the locality fields that Gmail cannot answer
# (city and state). The encrypted file stays under the Windows user's
# LocalAppData and must never reach the repository, command line, environment,
# chat, logs, or screenshots.

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Security

. (Join-Path $PSScriptRoot "tree-config.ps1")
$profileDirectory = Get-TreeLocalAppDataDirectory
$profilePath = Join-Path $profileDirectory "archive-request-profile.dpapi"
$entropy = [System.Text.Encoding]::UTF8.GetBytes("$(Get-TreeId)/archive-request-profile/v1")

switch ($Mode) {
  "save" {
    $plainText = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($plainText)) {
      throw "No archive request profile was provided on standard input."
    }

    try {
      $parsed = $plainText | ConvertFrom-Json
    } catch {
      throw "The archive request profile must be JSON with city and state fields."
    }
    if ([string]::IsNullOrWhiteSpace($parsed.city) -or [string]::IsNullOrWhiteSpace($parsed.state)) {
      throw "The archive request profile requires non-empty city and state fields."
    }
    if ($parsed.city.Length -gt 100 -or $parsed.state.Length -gt 100) {
      throw "The archive request profile city and state must each be at most 100 characters."
    }

    $plainBytes = [System.Text.Encoding]::UTF8.GetBytes($plainText)
    try {
      $protectedBytes = [System.Security.Cryptography.ProtectedData]::Protect(
        $plainBytes,
        $entropy,
        [System.Security.Cryptography.DataProtectionScope]::CurrentUser
      )
      New-Item -ItemType Directory -Force -Path $profileDirectory | Out-Null
      [System.IO.File]::WriteAllText(
        $profilePath,
        [Convert]::ToBase64String($protectedBytes),
        [System.Text.Encoding]::ASCII
      )
    } finally {
      if ($plainBytes) { [Array]::Clear($plainBytes, 0, $plainBytes.Length) }
      if ($protectedBytes) { [Array]::Clear($protectedBytes, 0, $protectedBytes.Length) }
      $plainText = $null
      $parsed = $null
    }
    Write-Output "saved"
  }

  "load" {
    if (-not (Test-Path -LiteralPath $profilePath)) { exit 0 }
    $protectedBytes = [Convert]::FromBase64String([System.IO.File]::ReadAllText($profilePath).Trim())
    try {
      $plainBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
        $protectedBytes,
        $entropy,
        [System.Security.Cryptography.DataProtectionScope]::CurrentUser
      )
      try {
        Write-Output ([System.Text.Encoding]::UTF8.GetString($plainBytes))
      } finally {
        if ($plainBytes) { [Array]::Clear($plainBytes, 0, $plainBytes.Length) }
      }
    } finally {
      if ($protectedBytes) { [Array]::Clear($protectedBytes, 0, $protectedBytes.Length) }
    }
  }

  "status" {
    if (Test-Path -LiteralPath $profilePath) {
      Write-Output "configured"
    } else {
      Write-Output "not-configured"
    }
  }

  "clear" {
    if (Test-Path -LiteralPath $profilePath) {
      Remove-Item -LiteralPath $profilePath -Force
    }
    Write-Output "cleared"
  }
}
