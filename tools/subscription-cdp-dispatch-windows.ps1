param(
  [Parameter(Mandatory = $true)]
  [string]$Mode,

  [Parameter(Mandatory = $true)]
  [string]$Url,

  [ValidateSet('any', 'ancestry', 'findmypast')]
  [string]$Provider = 'any',

  [ValidateRange(1, 50)]
  [int]$ResultIndex = 1,

  [string]$ExpectedRowTerms = '',

  [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._:/-]{2,200}$')]
  [string]$ExpectedRecordId = '',

  [string]$ExpectedTabTitle = '',

  [string]$TargetId = '',

  [string]$ArchiveFile = '',

  [ValidateRange(1, 20)]
  [int]$Part = 1,

  [switch]$InspectOnly,

  [switch]$InspectTranscript,

  # Batch archiving: register the master but leave the generated-view refresh
  # and the full data:check to the caller's one end-of-batch validation.
  [switch]$DeferValidation,

  [int]$DebugPort = 9226,

  [ValidatePattern('^[a-z0-9][a-z0-9-]{0,31}$')]
  [string]$AffinitySlot = 'default'
)

$ErrorActionPreference = 'Stop'
if ($DebugPort -ne 9226) {
  throw 'The background subscription profile is intentionally fixed to the localhost-only port 9226.'
}

$browserMutex = [System.Threading.Mutex]::new($false, 'Local\FamilyHistorySubscriptionChromeSharedWindow')
$browserMutexAcquired = $false
try {
  try {
    $browserMutexAcquired = $browserMutex.WaitOne(900000)
  } catch [System.Threading.AbandonedMutexException] {
    $browserMutexAcquired = $true
  }
  if (-not $browserMutexAcquired) {
    throw 'The shared background subscription browser is busy in another agent; retry after that transaction finishes.'
  }

  $nodeScript = Join-Path $PSScriptRoot 'subscription-cdp.mjs'
  $nodeArgs = @(
    '--mode', $Mode,
    '--url', $Url,
    '--provider', $Provider,
    '--result-index', [string]$ResultIndex,
    '--part', [string]$Part,
    '--affinity-slot', $AffinitySlot
  )
  if ($ExpectedTabTitle) { $nodeArgs += @('--expected-tab-title', $ExpectedTabTitle) }
  if ($ExpectedRowTerms) { $nodeArgs += @('--expected-row-terms', $ExpectedRowTerms) }
  if ($ExpectedRecordId) { $nodeArgs += @('--expected-record-id', $ExpectedRecordId) }
  if ($TargetId) { $nodeArgs += @('--target-id', $TargetId) }
  if ($ArchiveFile) { $nodeArgs += @('--archive-file', $ArchiveFile) }
  if ($InspectOnly) { $nodeArgs += '--inspect-only' }
  if ($InspectTranscript) { $nodeArgs += '--inspect-transcript' }
  if ($DeferValidation) { $nodeArgs += '--defer-validation' }

  & node.exe $nodeScript @nodeArgs
  if ($LASTEXITCODE -ne 0) {
    throw "Background subscription action failed: $Mode"
  }
} finally {
  if ($browserMutexAcquired) {
    try { $browserMutex.ReleaseMutex() } catch {}
  }
  $browserMutex.Dispose()
}
