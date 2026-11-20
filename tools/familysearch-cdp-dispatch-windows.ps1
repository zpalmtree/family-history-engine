param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("profile", "signin-saved", "film", "inspect", "fulltext", "query", "global-query", "record", "download", "context", "links", "scan-index", "scan-results", "scan-transcripts", "source-item", "source-view", "source-link", "result-item", "catalog-probate", "catalog-subject", "catalog-page", "catalog-annex-year", "image", "pan-image-right", "pan-image-left", "pan-image-up", "pan-image-down", "capture", "book-page", "close-panel", "dismiss", "zoom", "reset", "viewer", "close-affinity", "pause", "stop", "traffic", "status")]
  [string]$Mode,

  [string]$Query,
  [string]$Record,
  [string]$OutFile,
  [int]$Image,
  [string]$Images,
  [int]$Index = -1,

  [ValidatePattern('^[a-z0-9][a-z0-9-]{0,31}$')]
  [string]$AffinitySlot = "familysearch"
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
$endpoint = "http://127.0.0.1:9226"
$browserMutex = [System.Threading.Mutex]::new($false, 'Local\FamilyHistorySubscriptionChromeSharedWindow')
$browserMutexAcquired = $false

try {
  try {
    $browserMutexAcquired = $browserMutex.WaitOne(900000)
  } catch [System.Threading.AbandonedMutexException] {
    $browserMutexAcquired = $true
  }
  if (-not $browserMutexAcquired) {
    throw "The one shared Windows Chrome window is busy in another family-history session; retry after that queued transaction finishes."
  }

  $ready = $false
  try {
    Invoke-RestMethod -Uri "$endpoint/json/version" -TimeoutSec 2 | Out-Null
    $ready = $true
  } catch {}
  if (-not $ready) {
    & (Join-Path $ScriptDir "subscription-cdp-windows.ps1") -Mode start
    if ($LASTEXITCODE -ne 0) { throw "The shared Windows Chrome profile could not be started." }
    for ($attempt = 0; $attempt -lt 80 -and -not $ready; $attempt++) {
      Start-Sleep -Milliseconds 250
      try {
        Invoke-RestMethod -Uri "$endpoint/json/version" -TimeoutSec 2 | Out-Null
        $ready = $true
      } catch {}
    }
  }
  if (-not $ready) { throw "The shared Windows Chrome profile exposed no localhost CDP endpoint." }

  $nodeArgs = @((Join-Path $ScriptDir "familysearch-film.mjs"), "--endpoint", $endpoint, "--shared-window", "--affinity-slot", $AffinitySlot)
  switch ($Mode) {
    "close-affinity" { $nodeArgs += "--close-affinity" }
    "profile" { $nodeArgs += "--signin" }
    "signin-saved" { $nodeArgs += "--signin-saved" }
    "query" {
      if (-not $Query) { throw "-Query is required for query mode." }
      $nodeArgs += @("--query", $Query)
    }
    "global-query" {
      if (-not $Query) { throw "-Query is required for global-query mode." }
      $nodeArgs += @("--global-query", $Query)
    }
    "record" {
      if (-not $Record) { throw "-Record is required for record mode." }
      $nodeArgs += @("--record", $Record)
    }
    "inspect" {
      $nodeArgs += "--inspect"
      if ($Record) { $nodeArgs += @("--record", $Record) }
      if ($Image -gt 0) { $nodeArgs += @("--image", [string]$Image) }
    }
    "download" {
      if (-not $Record -or -not $OutFile) { throw "-Record and -OutFile are required for download mode." }
      if ($OutFile -notmatch '^[a-z0-9][a-z0-9._-]+$') { throw "-OutFile must be a safe lowercase filename, not a path." }
      $archiveRoot = Join-Path $env:OneDrive "Documents\FamilyHistorySourceMasters"
      New-Item -ItemType Directory -Force -Path $archiveRoot | Out-Null
      cipher.exe /E /A /Q $archiveRoot | Out-Null
      $env:FAMILYSEARCH_DOWNLOAD_PATH = Join-Path $archiveRoot $OutFile
      $nodeArgs += @("--download-record", "--record", $Record)
      if ($Image -gt 0) { $nodeArgs += @("--image", [string]$Image) }
    }
    "context" {
      if (-not $Query) { throw "-Query is required for context mode." }
      $nodeArgs += @("--context", $Query)
      if ($Record) { $nodeArgs += @("--record", $Record) }
    }
    "links" {
      $nodeArgs += "--links"
      if ($Record) { $nodeArgs += @("--record", $Record) }
    }
    "scan-index" {
      if (-not $Record -or $Index -lt 1) { throw "-Record and a positive -Index image count are required for scan-index mode." }
      $nodeArgs += @("--scan-index", [string]$Index, "--record", $Record)
      if ($Image -gt 0) { $nodeArgs += @("--image", [string]$Image) }
    }
    "scan-results" {
      if (-not $Record -or -not $Query -or $Index -lt 1) { throw "-Record, -Query filter terms, and a positive -Index page count are required for scan-results mode." }
      $nodeArgs += @("--scan-results", [string]$Index, "--context", $Query, "--record", $Record)
    }
    "scan-transcripts" {
      if (-not $Record -or -not $Query -or $Image -lt 1 -or $Index -lt 1) { throw "-Record, -Query terms, a positive -Image start, and a positive -Index image count are required for scan-transcripts mode." }
      $nodeArgs += @("--scan-transcripts", [string]$Index, "--context", $Query, "--record", $Record, "--image", [string]$Image)
    }
    "source-item" {
      if (-not $Record -or -not $Query) { throw "-Record and -Query are required for source-item mode." }
      $nodeArgs += @("--source-item", $Query, "--record", $Record)
    }
    "source-view" {
      if (-not $Record -or $Index -lt 0) { throw "-Record and a zero-based -Index are required for source-view mode." }
      $nodeArgs += @("--source-view", [string]$Index, "--record", $Record)
    }
    "source-link" {
      if (-not $Record -or -not $Query) { throw "-Record and the exact -Query link are required for source-link mode." }
      $nodeArgs += @("--source-link", $Query, "--record", $Record)
    }
    "result-item" {
      if (-not $Record -or -not $Query) { throw "-Record and -Query are required for result-item mode." }
      $nodeArgs += @("--result-item", $Query, "--record", $Record)
    }
    "catalog-subject" {
      if (-not $Record -or -not $Query) { throw "-Record and -Query are required for catalog-subject mode." }
      $nodeArgs += @("--catalog-subject", $Query, "--catalog-url", $Record)
    }
    "catalog-annex-year" {
      if (-not $Record -or $Query -notmatch '^(1[0-9]{3}|20[0-9]{2})$') { throw "Exact -Record catalogue URL and four-digit -Query year are required." }
      $nodeArgs += @("--catalog-annex-year", $Query, "--catalog-url", $Record)
    }
    "catalog-page" {
      if (-not $Record -or -not $Query) { throw "-Record and -Query are required for catalog-page mode." }
      $nodeArgs += @("--catalog-page", $Query, "--catalog-url", $Record)
    }
    "image" {
      if ($Image -lt 1) { throw "-Image must be positive for image mode." }
      $nodeArgs += @("--image", [string]$Image)
    }
    "capture" {
      if (-not $OutFile) { throw "-OutFile is required for capture mode." }
      if ($OutFile -notmatch '^[a-z0-9][a-z0-9._-]+$') { throw "-OutFile must be a safe lowercase filename, not a path." }
      if ($Images -and $Images -notmatch '^[1-9]\d*(,[1-9]\d*){0,99}$') { throw "-Images must be 1 through 100 comma-separated positive image numbers." }
      if ($Images -and ($Image -gt 0 -or $Index -gt 0)) { throw "Pass -Images or the -Image/-Index range, not both." }
      if ($Index -gt 0 -and $Image -lt 1) { throw "-Image is required when -Index requests a bounded capture range." }
      $env:FAMILYSEARCH_CAPTURE_PATH = Join-Path ([IO.Path]::GetTempPath()) $OutFile
      $nodeArgs += "--capture"
      if ($Record) { $nodeArgs += @("--record", $Record) }
      if ($Image -gt 0) { $nodeArgs += @("--image", [string]$Image) }
      if ($Images) { $nodeArgs += @("--capture-images", $Images) }
      if ($Index -gt 0) { $nodeArgs += @("--capture-count", [string]$Index) }
    }
    "book-page" {
      if (-not $Record -or -not $OutFile -or -not $Images) { throw "-Record, -OutFile and -Images are required for book-page mode." }
      if ($OutFile -notmatch '^[a-z0-9][a-z0-9._-]+$') { throw "-OutFile must be a safe lowercase filename, not a path." }
      if ($Images -notmatch '^[1-9]\d*(,[1-9]\d*){0,29}$') { throw "-Images must be 1 through 30 comma-separated positive page numbers." }
      $env:FAMILYSEARCH_CAPTURE_PATH = Join-Path ([IO.Path]::GetTempPath()) $OutFile
      $nodeArgs += @("--book-page", "--record", $Record, "--capture-images", $Images)
    }
    default { $nodeArgs += "--$Mode" }
  }

  Write-Host "Running FamilySearch in the existing shared Windows Chrome/CDP window"
  Write-Host "Endpoint: $endpoint"
  Write-Host "Affinity: $AffinitySlot"
  & node.exe @nodeArgs
  if ($LASTEXITCODE -ne 0) { throw "Shared-window FamilySearch action failed: $Mode" }

  if ($Mode -eq "download") {
    if (-not (Test-Path -LiteralPath $env:FAMILYSEARCH_DOWNLOAD_PATH)) {
      throw "FamilySearch source-master download did not create $OutFile"
    }
    cipher.exe /E /A /Q $env:FAMILYSEARCH_DOWNLOAD_PATH | Out-Null
  }
  if ($Mode -eq "capture") {
    $expectedCapturePath = $env:FAMILYSEARCH_CAPTURE_PATH
    if ($Images) {
      $firstImage = [int]($Images.Split(',')[0])
      $captureDirectory = Split-Path -Parent $expectedCapturePath
      $captureExtension = [IO.Path]::GetExtension($expectedCapturePath)
      $captureStem = [IO.Path]::GetFileNameWithoutExtension($expectedCapturePath)
      $expectedCapturePath = Join-Path $captureDirectory ("{0}-{1}{2}" -f $captureStem, $firstImage, $captureExtension)
    } elseif ($Index -gt 0) {
      $captureDirectory = Split-Path -Parent $expectedCapturePath
      $captureExtension = [IO.Path]::GetExtension($expectedCapturePath)
      $captureStem = [IO.Path]::GetFileNameWithoutExtension($expectedCapturePath)
      $expectedCapturePath = Join-Path $captureDirectory ("{0}-{1}{2}" -f $captureStem, $Image, $captureExtension)
    }
    if (-not (Test-Path -LiteralPath $expectedCapturePath)) {
      throw "FamilySearch temporary capture did not create the expected first output for $OutFile"
    }
  }
} finally {
  Remove-Item Env:FAMILYSEARCH_DOWNLOAD_PATH -ErrorAction SilentlyContinue
  Remove-Item Env:FAMILYSEARCH_CAPTURE_PATH -ErrorAction SilentlyContinue
  if ($browserMutexAcquired) {
    try { $browserMutex.ReleaseMutex() } catch {}
  }
  $browserMutex.Dispose()
}
