param(
  [ValidateSet("save", "load", "status", "clear", "update-contact-address")]
  [string]$Mode = "status"
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Security

. (Join-Path $PSScriptRoot "tree-config.ps1")
$profileDirectory = Get-TreeLocalAppDataDirectory
$profilePath = Join-Path $profileDirectory "tlcpl-request-profile.dpapi"
$entropy = [System.Text.Encoding]::UTF8.GetBytes("$(Get-TreeId)/tlcpl-request-profile/v1")

switch ($Mode) {
  "save" {
    $plainText = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($plainText)) {
      throw "No TLCPL request profile was provided on standard input."
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
    }
    [Console]::Out.Write("saved")
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
        [Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($plainBytes))
      } finally {
        if ($plainBytes) { [Array]::Clear($plainBytes, 0, $plainBytes.Length) }
      }
    } finally {
      if ($protectedBytes) { [Array]::Clear($protectedBytes, 0, $protectedBytes.Length) }
    }
  }

  "status" {
    if (Test-Path -LiteralPath $profilePath) {
      [Console]::Out.Write("configured")
    } else {
      [Console]::Out.Write("not-configured")
    }
  }

  "clear" {
    if (Test-Path -LiteralPath $profilePath) {
      Remove-Item -LiteralPath $profilePath -Force
    }
    [Console]::Out.Write("cleared")
  }

  "update-contact-address" {
    if (-not (Test-Path -LiteralPath $profilePath)) {
      throw "No TLCPL request profile is configured."
    }
    $newAddress = [Console]::In.ReadLine()
    if ([string]::IsNullOrWhiteSpace($newAddress) -or $newAddress.Length -gt 500) {
      throw "A valid replacement address must be provided on standard input."
    }

    $protectedBytes = [Convert]::FromBase64String([System.IO.File]::ReadAllText($profilePath).Trim())
    try {
      $plainBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
        $protectedBytes,
        $entropy,
        [System.Security.Cryptography.DataProtectionScope]::CurrentUser
      )
      try {
        $profile = [System.Text.Encoding]::UTF8.GetString($plainBytes) | ConvertFrom-Json
      } finally {
        if ($plainBytes) { [Array]::Clear($plainBytes, 0, $plainBytes.Length) }
      }
    } finally {
      if ($protectedBytes) { [Array]::Clear($protectedBytes, 0, $protectedBytes.Length) }
    }

    if ($profile.profileType -ne "contact" -or -not $profile.fields) {
      throw "The configured TLCPL profile does not contain reusable contact fields."
    }
    $profile.fields.Address = $newAddress.Trim()
    $updatedText = $profile | ConvertTo-Json -Compress -Depth 5
    $updatedBytes = [System.Text.Encoding]::UTF8.GetBytes($updatedText)
    try {
      $updatedProtectedBytes = [System.Security.Cryptography.ProtectedData]::Protect(
        $updatedBytes,
        $entropy,
        [System.Security.Cryptography.DataProtectionScope]::CurrentUser
      )
      [System.IO.File]::WriteAllText(
        $profilePath,
        [Convert]::ToBase64String($updatedProtectedBytes),
        [System.Text.Encoding]::ASCII
      )
    } finally {
      if ($updatedBytes) { [Array]::Clear($updatedBytes, 0, $updatedBytes.Length) }
      if ($updatedProtectedBytes) { [Array]::Clear($updatedProtectedBytes, 0, $updatedProtectedBytes.Length) }
      $updatedText = $null
      $newAddress = $null
    }
    [Console]::Out.Write("updated")
  }
}
