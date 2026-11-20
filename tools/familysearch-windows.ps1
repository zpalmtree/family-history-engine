param(
  [ValidateSet("profile", "signin-saved", "film", "inspect", "fulltext", "query", "global-query", "record", "download", "context", "links", "scan-index", "scan-results", "scan-transcripts", "source-item", "source-view", "source-link", "result-item", "catalog-probate", "catalog-subject", "catalog-page", "catalog-annex-year", "image", "pan-image-right", "pan-image-left", "pan-image-up", "pan-image-down", "capture", "book-page", "close-panel", "dismiss", "zoom", "reset", "viewer", "close-affinity", "pause", "stop", "traffic", "status")]
  [string]$Mode = "profile",

  [string]$ProfileDir,
  [string]$Query,
  [string]$Record,
  [string]$OutFile,
  [int]$Image,
  [string]$Images,
  [int]$Index = -1,
  [int]$DebugPort = 9226,

  [ValidatePattern('^[a-z0-9][a-z0-9-]{0,31}$')]
  [string]$AffinitySlot = "familysearch"
)

$ErrorActionPreference = "Stop"
if ($ProfileDir) { throw "FamilySearch no longer accepts a separate profile directory; it uses the one shared Windows Chrome/CDP profile." }
if ($DebugPort -ne 9226) { throw "FamilySearch is fixed to the one shared localhost CDP endpoint on port 9226." }

$sharedDispatcher = Join-Path $PSScriptRoot "familysearch-cdp-dispatch-windows.ps1"
& $sharedDispatcher `
  -Mode $Mode `
  -Query $Query `
  -Record $Record `
  -OutFile $OutFile `
  -Image $Image `
  -Images $Images `
  -Index $Index `
  -AffinitySlot $AffinitySlot
