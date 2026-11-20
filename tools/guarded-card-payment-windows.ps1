param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-z0-9][a-z0-9-]{0,127}$')]
  [string]$Request,
  [ValidatePattern('^(https://.*)?$')]
  [string]$Url = "",
  # Follow the payment link inside the provider's own Gmail message instead of
  # passing its tokenized URL on the command line.
  [ValidateLength(0, 200)]
  [string]$GmailQuery = "",
  [ValidateLength(0, 80)]
  [string]$LinkText = "",
  [switch]$ListLinks,
  # Save one named attachment (payment instructions) to Windows temp only.
  [ValidateLength(0, 120)]
  [string]$SaveAttachment = "",
  [switch]$Inspect,
  # Run the TNA page-check order driver, which reaches checkout itself.
  [switch]$TnaPageCheck,
  # Run the GRO certificate auto-pay for a queue target whose slug is -Request.
  [switch]$GroOrder,
  # Build the MSA cart for every reviewed record under -Request.
  [switch]$MsaOrder,
  # Order the reviewed GOV.UK Find a Will copy under -Request from its basket.
  [switch]$FindAWillOrder,
  # With -FindAWillOrder: only read the account's My Orders page.
  [switch]$Orders,
  # Build the New Jersey State Archives cart for the reviewed record under -Request.
  [switch]$NjArchivesOrder,
  # With -NjArchivesOrder: never reveal the tab for the user; stop quietly instead.
  [switch]$NoManual,
  # Run the Ancestry membership order driver, which reaches checkout itself.
  [switch]$AncestryMembership,
  # With -AncestryMembership: only read the account's past charge amounts.
  [switch]$PastCharges,
  [switch]$SkipInstall
)
# Guarded saved-card payment for one canonical request (AGENTS.md, 28 Oct 2026).
# Holds the one shared-window mutex and streams the Node output, so a refusal
# reason is always visible instead of a bare "failed safely".
$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
Set-Location $ProjectRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Windows Node.js was not found on PATH." }
if (-not $SkipInstall -and -not (Test-Path (Join-Path $ProjectRoot "node_modules/playwright-core"))) { npm install }
$endpoint = "http://127.0.0.1:9226"
try { Invoke-RestMethod -Uri "$endpoint/json/version" -TimeoutSec 2 | Out-Null } catch {
  & (Join-Path $ScriptDir "subscription-cdp-windows.ps1") -Mode start
  if ($LASTEXITCODE -ne 0) { throw "The shared Windows Chrome profile could not be started." }
}
$browserMutex = [System.Threading.Mutex]::new($false, 'Local\FamilyHistorySubscriptionChromeSharedWindow')
$acquired = $false
try {
  try { $acquired = $browserMutex.WaitOne(180000) } catch [System.Threading.AbandonedMutexException] { $acquired = $true }
  if (-not $acquired) { throw "The one shared Windows Chrome window is busy; retry after the current family-history task finishes." }
  if ($MsaOrder) {
    $nodeArgs = @("tools/msa-order.mjs", "--request", $Request)
    if ($Inspect) { $nodeArgs += "--inspect" }
  } elseif ($FindAWillOrder) {
    $nodeArgs = @("tools/find-a-will-order.mjs", "--request", $Request)
    if ($Inspect) { $nodeArgs += "--inspect" }
    if ($Orders) { $nodeArgs += "--orders" }
  } elseif ($NjArchivesOrder) {
    $nodeArgs = @("tools/nj-archives-order.mjs", "--request", $Request)
    if ($Inspect) { $nodeArgs += "--inspect" }
    if ($NoManual) { $nodeArgs += "--no-manual" }
  } elseif ($AncestryMembership) {
    $nodeArgs = @("tools/ancestry-membership-order.mjs", "--request", $Request)
    if ($Inspect) { $nodeArgs += "--explore" }
    if ($PastCharges) { $nodeArgs += @("--explore", "--past-charges") }
  } elseif ($GroOrder) {
    $nodeArgs = @("tools/gro-order-frank.mjs", "--auto-pay", "--shared-window", "--target", $Request)
    if ($Inspect) { $nodeArgs += "--explore" }
  } elseif ($TnaPageCheck) {
    $nodeArgs = @("tools/tna-page-check-order.mjs", "--request", $Request)
    if ($Inspect) { $nodeArgs += "--explore" }
  } else {
    if (-not $Url -and -not $GmailQuery) { throw "-Url or -GmailQuery is required unless a provider order driver is selected." }
    $nodeArgs = @("tools/guarded-card-payment.mjs", "--shared-window", "--request", $Request)
    if ($Url) { $nodeArgs += @("--url", $Url) }
    if ($GmailQuery) { $nodeArgs += @("--gmail-query", $GmailQuery) }
    if ($LinkText) { $nodeArgs += @("--link-text", $LinkText) }
    if ($ListLinks) { $nodeArgs += "--list-links" }
    if ($SaveAttachment) { $nodeArgs += @("--save-attachment", $SaveAttachment) }
    if ($Inspect) { $nodeArgs += "--inspect" }
  }
  & node @nodeArgs
  if ($LASTEXITCODE -ne 0) { throw "Guarded payment stopped without paying (see the reason above)." }
} finally {
  if ($acquired) { try { $browserMutex.ReleaseMutex() } catch {} }
  $browserMutex.Dispose()
}
