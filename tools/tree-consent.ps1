# Per-tree consent check for PowerShell helpers that act without Node
# (dot-source this file). It mirrors tools/consents.mjs: a capability is on
# only when the tree's consents file lists it with "enabled": true, a
# grantedOn date and a grantedBy name. A missing or invalid file means off.

function Get-TreeConsentFile {
  $repoRoot = Split-Path $PSScriptRoot -Parent
  $name = "consents.json"
  $configFile = Join-Path $repoRoot "tree.config.json"
  if (Test-Path -LiteralPath $configFile) {
    try {
      $config = Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($config.consentsFile -and -not [IO.Path]::IsPathRooted([string]$config.consentsFile) -and ([string]$config.consentsFile) -notmatch '\.\.') {
        $name = [string]$config.consentsFile
      }
    } catch { }
  }
  return Join-Path $repoRoot $name
}

function Test-TreeConsent([string]$Capability) {
  $file = Get-TreeConsentFile
  if (-not (Test-Path -LiteralPath $file)) { return $false }
  try {
    $consents = Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch { return $false }
  if ($consents.schemaVersion -ne 1) { return $false }
  $grant = $consents.capabilities.$Capability
  if (-not $grant) { return $false }
  return ($grant.enabled -eq $true -and [string]$grant.grantedOn -match '^\d{4}-\d{2}-\d{2}$' -and ([string]$grant.grantedBy).Trim().Length -gt 0)
}

function Assert-TreeConsent([string]$Capability) {
  if (-not (Test-TreeConsent $Capability)) {
    throw "$Capability is not switched on for this tree. The tree's owner can enable it in $(Split-Path (Get-TreeConsentFile) -Leaf); see TREE-SETUP.md."
  }
}
