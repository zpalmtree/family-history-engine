# Per-tree settings for PowerShell helpers (dot-source this file). It reads
# the same tree.config.json as tools/tree-config.mjs, from the repository the
# script runs in (the primary checkout or its Windows mirror).

function Get-TreeConfig {
  $file = Join-Path (Split-Path $PSScriptRoot -Parent) "tree.config.json"
  if (-not (Test-Path -LiteralPath $file)) { return $null }
  try { return Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $null }
}

# The tree's slug: names its DPAPI entropy and temporary folders.
function Get-TreeId {
  $config = Get-TreeConfig
  if ($config -and $config.tree -and $config.tree.id) { return [string]$config.tree.id }
  return "family-tree"
}

# The per-user folder under LocalAppData that holds this tree's encrypted
# profiles and keys.
function Get-TreeLocalAppDataDirectory {
  $config = Get-TreeConfig
  $name = if ($config -and $config.windows -and $config.windows.localAppDataDir) { [string]$config.windows.localAppDataDir } else { Get-TreeId }
  return Join-Path $env:LOCALAPPDATA $name
}

# The primary checkout as a WSL path (for wsl.exe --cd and node commands).
function Get-TreeWslProjectRoot {
  $config = Get-TreeConfig
  if ($config -and $config.paths -and $config.paths.primaryCheckout) { return [string]$config.paths.primaryCheckout }
  throw "Set paths.primaryCheckout in tree.config.json to the checkout's WSL path."
}

# Research scopes: the default first, then any additional ones.
function Get-TreeScopes {
  $config = Get-TreeConfig
  $default = if ($config -and $config.scopes -and $config.scopes.default) { [string]$config.scopes.default } else { "main" }
  $additional = if ($config -and $config.scopes -and $config.scopes.additional) { @($config.scopes.additional | ForEach-Object { [string]$_ }) } else { @() }
  return @($default) + $additional
}

function Assert-TreeScope([string]$Scope) {
  $scopes = Get-TreeScopes
  if ($scopes -notcontains $Scope) { throw "Scope must be one of: $($scopes -join ', ')." }
}

# The owner's personal mailbox for the read-only IMAP reader.
function Get-TreeOwnerMailbox {
  $config = Get-TreeConfig
  if ($config -and $config.owner -and $config.owner.personalMailbox) { return [string]$config.owner.personalMailbox }
  throw "Set owner.personalMailbox in tree.config.json to use the personal mailbox reader."
}
