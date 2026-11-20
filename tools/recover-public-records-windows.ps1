param(
  [string]$Queue = "evidence/record-recovery-queue.json",
  [string]$TargetId
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
$QueuePath = Join-Path $ProjectRoot $Queue
$ArchiveRoot = Join-Path $env:OneDrive "Documents\FamilyHistorySourceMasters"
$targets = (Get-Content -LiteralPath $QueuePath -Raw | ConvertFrom-Json).targets
if ($TargetId -and $TargetId -notmatch '^[a-z0-9][a-z0-9._-]+$') {
  throw "Unsafe target id"
}
if ($TargetId) {
  $queueTarget = $targets | Where-Object { $_.id -eq $TargetId } | Select-Object -First 1
  if ($queueTarget) {
    if ($queueTarget.status -notin @("ready", "acquired")) {
      throw "Public-record target is not recoverable: $TargetId"
    }
    # Project an acquired queue entry back into the wrapper's ready shape so an
    # exact-target rerun verifies the archived master instead of silently doing nothing.
    $targets = @([pscustomobject]@{
      id = $queueTarget.id
      status = "ready"
      url = $queueTarget.url
      archiveFile = $queueTarget.archiveFile
    })
  } else {
    $CanonicalTargetPath = Join-Path $ProjectRoot "evidence\acquisition\targets\$TargetId.json"
    if (-not (Test-Path -LiteralPath $CanonicalTargetPath -PathType Leaf)) {
      throw "Unknown public-record target: $TargetId"
    }
    $canonicalTarget = Get-Content -LiteralPath $CanonicalTargetPath -Raw | ConvertFrom-Json
    $canonicalRoute = $canonicalTarget.routes | Where-Object {
      $_.id -eq $TargetId -and
      $_.sourceQueue -eq "public-record-recovery" -and
      $_.status -in @("ready-download", "acquired")
    } | Select-Object -First 1
    if (-not $canonicalRoute) {
      throw "Canonical public-record target has no ready download route: $TargetId"
    }
    $targets = @([pscustomobject]@{
      id = $canonicalTarget.id
      status = "ready"
      url = $canonicalRoute.sourceUrl
      archiveFile = $canonicalTarget.archiveFile
    })
  }
}
$AllowedHosts = @(
  "archive.org",
  "genpa.org",
  "web.archive.org",
  "gwm.lunaimaging.com",
  "tile.loc.gov",
  "probatesearch.service.gov.uk",
  "leicester.contentdm.oclc.org",
  "www.gnosallhistory.co.uk",
  "iiif-antenati.cultura.gov.it",
  "nara-1940-census.s3.us-east-2.amazonaws.com",
  "1950census.archives.gov",
  "catalog.archives.gov",
  "msa.maryland.gov",
  "mdhistory.msa.maryland.gov",
  "woodcountyoh.documents-on-demand.com",
  "usgenwebsites.org",
  "www.usgenwebsites.org",
  "yanceyfamilygenealogy.org",
  "wcdpl.advantage-preservation.com",
  "findlaylibrary.advantage-preservation.com",
  "ohiomemory.org",
  "northfieldcenter.com",
  "www2.landesarchiv-bw.de",
  "michigan.access.preservica.com",
  # Find a Grave contributor photographs, hosted with the user's email approval (14 Nov 2026).
  "images.findagrave.com"
)

New-Item -ItemType Directory -Force -Path $ArchiveRoot | Out-Null
cipher.exe /E /A /Q $ArchiveRoot | Out-Null

$results = foreach ($target in $targets) {
  if ($TargetId -and $target.id -ne $TargetId) { continue }
  if ($target.status -ne "ready") { continue }
  if ($target.archiveFile -notmatch '^[a-z0-9][a-z0-9._-]+$') {
    throw "Unsafe archive filename for $($target.id)"
  }
  $uri = [Uri]$target.url
  if ($uri.Scheme -ne "https" -or $uri.Host -notin $AllowedHosts) {
    throw "Public-record URL is not on the HTTPS allowlist for $($target.id)"
  }
  $destination = Join-Path $ArchiveRoot $target.archiveFile
  $temporary = "$destination.partial"
  if (Test-Path -LiteralPath $destination) {
    $item = Get-Item -LiteralPath $destination
    [pscustomobject]@{
      id = $target.id
      status = "recovered-existing"
      archivePath = "FamilyHistorySourceMasters/$($target.archiveFile)"
      length = $item.Length
      sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $destination).Hash.ToLowerInvariant()
      encrypted = [bool]($item.Attributes -band [IO.FileAttributes]::Encrypted)
    }
    continue
  }
  try {
    $request = @{
      Uri = $target.url
      OutFile = $temporary
      MaximumRedirection = 5
      PassThru = $true
      UseBasicParsing = $true
      UserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138.0 Safari/537.36"
    }
    if ($uri.Host -eq "iiif-antenati.cultura.gov.it") {
      $request.Headers = @{ Referer = "https://antenati.cultura.gov.it/" }
    }
    if ($uri.Host -eq "woodcountyoh.documents-on-demand.com") {
      $request.Headers = @{ Referer = "https://woodcountyoh.documents-on-demand.com/" }
    }
    $response = Invoke-WebRequest @request
    $length = (Get-Item -LiteralPath $temporary).Length
    if ($length -lt 1024 -or $length -gt 100MB) {
      throw "Downloaded file is unexpectedly small for $($target.id)"
    }
    $contentType = [string]$response.Headers["Content-Type"]
    $approvedOctetStream = $uri.Host -in @("catalog.archives.gov", "michigan.access.preservica.com") -and $contentType -match '^application/octet-stream(;|$)'
    if (-not $approvedOctetStream -and $contentType -notmatch '^image/(jpeg|png|webp|tiff)(;|$)' -and $contentType -notmatch '^application/pdf(;|$)') {
      throw "Unexpected Content-Type '$contentType' for $($target.id)"
    }
    $bytes = [IO.File]::ReadAllBytes($temporary)
    $isJpeg = $bytes.Length -ge 3 -and $bytes[0] -eq 0xFF -and $bytes[1] -eq 0xD8 -and $bytes[2] -eq 0xFF
    $isPng = $bytes.Length -ge 8 -and $bytes[0] -eq 0x89 -and $bytes[1] -eq 0x50 -and $bytes[2] -eq 0x4E -and $bytes[3] -eq 0x47 -and $bytes[4] -eq 0x0D -and $bytes[5] -eq 0x0A -and $bytes[6] -eq 0x1A -and $bytes[7] -eq 0x0A
    $isPdf = $bytes.Length -ge 5 -and [Text.Encoding]::ASCII.GetString($bytes, 0, 5) -eq "%PDF-"
    $isWebp = $bytes.Length -ge 12 -and [Text.Encoding]::ASCII.GetString($bytes, 0, 4) -eq "RIFF" -and [Text.Encoding]::ASCII.GetString($bytes, 8, 4) -eq "WEBP"
    $isTiff = $bytes.Length -ge 4 -and (
      ($bytes[0] -eq 0x49 -and $bytes[1] -eq 0x49 -and $bytes[2] -eq 0x2A -and $bytes[3] -eq 0x00) -or
      ($bytes[0] -eq 0x4D -and $bytes[1] -eq 0x4D -and $bytes[2] -eq 0x00 -and $bytes[3] -eq 0x2A)
    )
    if (-not ($isJpeg -or $isPng -or $isPdf -or $isWebp -or $isTiff)) {
      throw "Downloaded file signature is not an approved source-master format for $($target.id)"
    }
    $extension = [IO.Path]::GetExtension($target.archiveFile).ToLowerInvariant()
    $magicMatchesExtension = switch ($extension) {
      ".jpg" { $isJpeg }
      ".jpeg" { $isJpeg }
      ".png" { $isPng }
      ".webp" { $isWebp }
      ".tif" { $isTiff }
      ".tiff" { $isTiff }
      ".pdf" { $isPdf }
      default { $false }
    }
    if (-not $magicMatchesExtension) {
      throw "Downloaded source bytes do not match the archive extension for $($target.id)"
    }
    Move-Item -LiteralPath $temporary -Destination $destination -Force
    cipher.exe /E /A /Q $destination | Out-Null
    $item = Get-Item -LiteralPath $destination
    [pscustomobject]@{
      id = $target.id
      status = "downloaded"
      archivePath = "FamilyHistorySourceMasters/$($target.archiveFile)"
      length = $item.Length
      sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $destination).Hash.ToLowerInvariant()
      encrypted = [bool]($item.Attributes -band [IO.FileAttributes]::Encrypted)
    }
  } catch {
    [pscustomobject]@{
      id = $target.id
      status = "failed"
      archiveFile = $target.archiveFile
      error = $_.Exception.Message
    }
  } finally {
    Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
  }
}

if ($TargetId -and @($results).Count -eq 0) {
  throw "No ready public-record target matched $TargetId"
}
$results | ConvertTo-Json -Depth 4
