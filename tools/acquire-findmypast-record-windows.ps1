param(
  [Parameter(Mandatory = $true)]
  [string]$TargetId,

  [string]$ArchiveFile,

  [int]$Part = 1,

  [switch]$InspectOnly,

  [switch]$InspectTranscript
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
$queuePath = Join-Path $ProjectRoot "evidence\subscription-records-queue.json"
$queue = Get-Content -LiteralPath $queuePath -Raw | ConvertFrom-Json
$target = $queue.targets | Where-Object { $_.id -eq $TargetId } | Select-Object -First 1
if (-not $target) {
  $canonicalPath = Join-Path $ProjectRoot "evidence\acquisition\targets\$TargetId.json"
  if (-not (Test-Path -LiteralPath $canonicalPath -PathType Leaf)) { throw "Unknown subscription target: $TargetId" }
  $canonical = Get-Content -LiteralPath $canonicalPath -Raw | ConvertFrom-Json
  $canonicalRoute = $canonical.routes | Where-Object {
    $_.id -eq $TargetId -and
    $_.sourceQueue -eq 'subscription-records' -and
    $_.provider -eq 'Findmypast' -and
    $_.status -in @('pending-subscription','ready-subscription-capture','acquired')
  } | Select-Object -First 1
  if (-not $canonicalRoute) { throw "Canonical Findmypast target has no acquisition-ready route: $TargetId" }
  $target = [PSCustomObject]@{
    id = $canonical.id
    provider = 'Findmypast'
    status = if ($canonicalRoute.status -eq 'acquired') { 'acquired' } else { 'pending-subscription' }
    captureKind = if ($canonical.captureKind) { $canonical.captureKind } else { 'record-image' }
    searchUrl = $canonicalRoute.sourceUrl
    catalogueUrl = $canonicalRoute.sourceUrl
    resultMatch = @($canonical.resultMatch)
  }
}
if ($target.provider -ne "Findmypast") { throw "Target is not a Findmypast record: $TargetId" }
if (-not $InspectOnly -and -not $InspectTranscript -and $Part -eq 1 -and $target.status -ne "pending-subscription") {
  throw "Target is not pending acquisition: $TargetId"
}
if (-not $InspectOnly -and -not $InspectTranscript -and $Part -gt 1 -and $target.status -ne "acquired") {
  throw "The base target must be acquired before adding a later image part: $TargetId"
}
if ($target.captureKind -notin @("record-image", "newspaper-page")) {
  throw "Target does not use a supported Findmypast acquisition workflow: $TargetId"
}
$route = if ($target.searchUrl) { $target.searchUrl } else { $target.catalogueUrl }
if ($target.captureKind -eq "record-image" -and $route -notmatch '^https://www\.findmypast\.(com|co\.uk)/search/results\?') {
  throw "Target does not have a narrow Findmypast result route: $TargetId"
}
if ($target.captureKind -eq "newspaper-page" -and $route -notmatch '^https://www\.findmypast\.(com|co\.uk)/search-newspapers/results\?') {
  throw "Target does not have a narrow Findmypast newspaper route: $TargetId"
}
$matchTerms = @($target.resultMatch | Where-Object { $_ })
if (-not $matchTerms.Count) { throw "Target has no result-row verification terms: $TargetId" }
if (-not $ArchiveFile) {
  $ArchiveFile = if ($Part -eq 1) { "$TargetId.jpg" } else { "$TargetId-part-$Part.jpg" }
}
if ([IO.Path]::GetFileName($ArchiveFile) -ne $ArchiveFile -or $ArchiveFile -notmatch '\.(jpg|jpeg|png|webp|pdf)$') {
  throw "ArchiveFile must be a safe supported filename."
}

$affinityStem = (($TargetId -replace '[^a-z0-9-]', '-').Trim('-'))
if ($affinityStem.Length -gt 19) { $affinityStem = $affinityStem.Substring(0, 19).TrimEnd('-') }
$affinityHasher = [Security.Cryptography.SHA256]::Create()
try {
  $affinityHashBytes = $affinityHasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($TargetId))
} finally {
  $affinityHasher.Dispose()
}
$affinityHash = ([BitConverter]::ToString($affinityHashBytes) -replace '-', '').Substring(0, 8).ToLowerInvariant()
$affinitySlot = "acq-$affinityStem-$affinityHash"
$dispatcher = Join-Path $ScriptDir 'subscription-cdp-dispatch-windows.ps1'
& $dispatcher `
  -Mode acquire-target `
  -Url $route `
  -Provider findmypast `
  -TargetId $TargetId `
  -ArchiveFile $ArchiveFile `
  -Part $Part `
  -AffinitySlot $affinitySlot `
  -InspectOnly:$InspectOnly `
  -InspectTranscript:$InspectTranscript
return

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class FamilyHistoryFindmypastMouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  public static void Click(int x, int y) {
    SetCursorPos(x, y);
    mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
    mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
  }
}
"@

function Get-SubscriptionProcessInfo {
  return Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq "chrome.exe" -and $_.CommandLine -match 'remote-debugging-port=9226'
  } | Select-Object -First 1
}

function Get-SubscriptionChromeRoot {
  $processInfo = Get-SubscriptionProcessInfo
  $process = if ($processInfo) { Get-Process -Id $processInfo.ProcessId -ErrorAction SilentlyContinue } else { $null }
  if (-not $process -or $process.MainWindowHandle -eq 0) {
    $process = Get-Process chrome | Where-Object {
      $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -match 'findmypast'
    } | Select-Object -Last 1
  }
  if (-not $process) { throw "No user-controlled Windows Chrome subscription window was found." }
  return [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
}

function Focus-SubscriptionChrome {
  $processInfo = Get-SubscriptionProcessInfo
  if (-not $processInfo) { return $false }
  $shell = New-Object -ComObject WScript.Shell
  return $shell.AppActivate([int]$processInfo.ProcessId)
}

function Get-Elements($root) {
  return $root.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition
  )
}

function Get-SubscriptionTabCount {
  try {
    $root = Get-SubscriptionChromeRoot
    return @(Get-Elements $root | Where-Object {
      $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::TabItem
    }).Count
  } catch { return 0 }
}

function Open-SubscriptionTargetTab([string]$Url) {
  Focus-SubscriptionChrome | Out-Null
  [System.Windows.Forms.SendKeys]::SendWait('^t')
  $script:subscriptionTargetTabOpened = $true
  Start-Sleep -Milliseconds 500
  $root = Get-SubscriptionChromeRoot
  $address = Get-Elements $root | Where-Object {
    $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit -and
    $_.Current.Name -eq 'Address and search bar'
  } | Select-Object -First 1
  if (-not $address) { throw 'Windows Chrome exposed no address bar for the controlled research tab.' }
  $value = $address.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
  ([System.Windows.Automation.ValuePattern]$value).SetValue($Url)
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  Start-Sleep -Seconds 4
}

function Close-NewSubscriptionTabs([int]$BeforeCount) {
  # Chrome's accessibility tab count/runtime IDs are not stable enough to
  # infer ownership. Close only the one tab this script explicitly opened;
  # never sweep other visible tabs.
  if (-not $script:subscriptionTargetTabOpened) { return }
  Focus-SubscriptionChrome | Out-Null
  if ($script:findmypastViewerTabOpened) {
    [System.Windows.Forms.SendKeys]::SendWait('^w')
    Start-Sleep -Milliseconds 500
  }
  [System.Windows.Forms.SendKeys]::SendWait('^w')
  Start-Sleep -Milliseconds 500
  Write-Host "Closed the controlled tab created by this Findmypast acquisition."
}

function Click-AccessibleElement($element) {
  $bounds = $element.Current.BoundingRectangle
  if ($bounds.Width -le 0 -or $bounds.Height -le 0) { throw "The visible provider control has no clickable bounds." }
  [FamilyHistoryFindmypastMouse]::Click(
    [int]($bounds.X + ($bounds.Width / 2)),
    [int]($bounds.Y + ($bounds.Height / 2))
  )
}

function Invoke-AccessibleElement($element) {
  try {
    $invoke = $element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    ([System.Windows.Automation.InvokePattern]$invoke).Invoke()
    return
  } catch {}
  try {
    $legacy = $element.GetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern)
    ([System.Windows.Automation.LegacyIAccessiblePattern]$legacy).DoDefaultAction()
    return
  } catch {}
  Click-AccessibleElement $element
}

function Get-ResultContainers($element) {
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $current = $walker.GetParent($element)
  $containers = @()
  for ($depth = 1; $depth -le 12 -and $current; $depth++) {
    $bounds = $current.Current.BoundingRectangle
    if ($current.Current.ControlType -in @(
          [System.Windows.Automation.ControlType]::DataItem,
          [System.Windows.Automation.ControlType]::ListItem
        ) -and
        $bounds.Height -gt 0 -and $bounds.Height -le 700) {
      $containers += $current
    }
    $current = $walker.GetParent($current)
  }
  return $containers
}

function Get-ElementSummary($element) {
  $labels = @($element.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition
  ) | ForEach-Object { $_.Current.Name } | Where-Object { $_ } | ForEach-Object { $_ -replace '\s+', ' ' })
  return (($labels | Select-Object -Unique) -join ' | ')
}

function Test-AllTerms($summary, $terms) {
  foreach ($term in $terms) {
    if ($summary.IndexOf([string]$term, [StringComparison]::OrdinalIgnoreCase) -lt 0) { return $false }
  }
  return $true
}

function Acquire-NewspaperPage {
  $deadline = (Get-Date).AddSeconds(25)
  $articleLink = $null
  $observed = @()
  do {
    $root = Get-SubscriptionChromeRoot
    $links = @(Get-Elements $root | Where-Object {
      $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Hyperlink -and
      $_.Current.Name -match "Added on"
    })
    foreach ($link in $links) {
      $summary = $link.Current.Name -replace '\s+', ' '
      if ($summary -and $summary -notin $observed) { $observed += $summary }
      if (Test-AllTerms $summary $matchTerms) {
        $articleLink = $link
        break
      }
    }
    if (-not $articleLink) { Start-Sleep -Milliseconds 750 }
  } while (-not $articleLink -and (Get-Date) -lt $deadline)

  if ($InspectOnly) {
    Write-Host "Expected newspaper terms: $($matchTerms -join ', ')"
    if ($observed.Count) {
      Write-Host "Visible newspaper results:"
      $observed | Select-Object -First 8 | ForEach-Object { Write-Host "  $_" }
    } else {
      Write-Host "No newspaper result links were exposed."
    }
    if ($articleLink) { Write-Host "A verified full-page newspaper capture is ready for acquisition." }
    return
  }
  if ($InspectTranscript) { throw "Transcript inspection is not supported for newspaper-page targets." }
  if (-not $articleLink) { throw "No newspaper result matched every verification term for $TargetId" }

  Focus-SubscriptionChrome | Out-Null
  Click-AccessibleElement $articleLink
  $selection = $null
  $viewerDeadline = (Get-Date).AddSeconds(25)
  do {
    Start-Sleep -Milliseconds 750
    $root = Get-SubscriptionChromeRoot
    $selection = Get-Elements $root | Where-Object {
      $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and
      $_.Current.Name -eq "Activate selection of an image region"
    } | Select-Object -First 1
  } while (-not $selection -and (Get-Date) -lt $viewerDeadline)
  if (-not $selection) { throw "Verified newspaper result did not open the full-page viewer for $TargetId" }

  $downloads = Join-Path $env:USERPROFILE "Downloads"
  $before = @(Get-ChildItem -LiteralPath $downloads -File | Select-Object -ExpandProperty FullName)
  Click-AccessibleElement $selection
  $capture = $null
  $captureDeadline = (Get-Date).AddSeconds(15)
  do {
    Start-Sleep -Milliseconds 400
    $root = Get-SubscriptionChromeRoot
    $capture = Get-Elements $root | Where-Object {
      $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and
      $_.Current.Name -eq "Capture full page"
    } | Select-Object -First 1
  } while (-not $capture -and (Get-Date) -lt $captureDeadline)
  if (-not $capture) { throw "Newspaper viewer exposed no provider full-page capture for $TargetId" }
  Click-AccessibleElement $capture

  # The clipping dialog's Download hyperlink must be clicked exactly once. An
  # accessibility Invoke action can open the image in a new tab, and retrying
  # it while polling creates duplicate tabs instead of a completed download.
  $download = $null
  $dialogDeadline = (Get-Date).AddSeconds(20)
  do {
    Start-Sleep -Milliseconds 400
    $root = Get-SubscriptionChromeRoot
    $download = Get-Elements $root | Where-Object {
      $_.Current.ControlType -in @(
        [System.Windows.Automation.ControlType]::Button,
        [System.Windows.Automation.ControlType]::Hyperlink
      ) -and $_.Current.Name -eq 'Download'
    } | Select-Object -First 1
  } while (-not $download -and (Get-Date) -lt $dialogDeadline)
  if (-not $download) { throw "Findmypast clipping dialog exposed no Download control for $TargetId" }
  Click-AccessibleElement $download

  $source = $null
  $downloadDeadline = (Get-Date).AddSeconds(60)
  do {
    Start-Sleep -Milliseconds 500
    $source = Get-ChildItem -LiteralPath $downloads -File | Where-Object {
      $_.FullName -notin $before -and $_.Extension -ne ".crdownload" -and $_.Length -gt 1024
    } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  } while (-not $source -and (Get-Date) -lt $downloadDeadline)
  if (-not $source) { throw "No completed provider full-page newspaper capture appeared for $TargetId" }

  $length = $source.Length
  Start-Sleep -Milliseconds 750
  $source.Refresh()
  if ($source.Length -ne $length) { throw "Newspaper capture was still changing; rerun after it completes" }
  & (Join-Path $ScriptDir "archive-subscription-download-windows.ps1") `
    -TargetId $TargetId -SourceFile $source.FullName -ArchiveFile $ArchiveFile -Part $Part
  if ($LASTEXITCODE -ne 0) { throw "Newspaper archival transaction failed for $TargetId" }
  Write-Host "Acquired and registered $TargetId using Findmypast's full-page capture control."
}

try {
  Focus-SubscriptionChrome | Out-Null
} catch {}
$script:subscriptionTargetTabOpened = $false
$script:findmypastViewerTabOpened = $false
$tabsBeforeOpen = Get-SubscriptionTabCount
try {
  Open-SubscriptionTargetTab $route

if ($target.captureKind -eq "newspaper-page") {
  Acquire-NewspaperPage
  return
}

$deadline = (Get-Date).AddSeconds(25)
$verifiedLink = $null
$verifiedContainer = $null
$observed = @()
do {
  $root = Get-SubscriptionChromeRoot
  $imageLinks = @(Get-Elements $root | Where-Object {
    $_.Current.Name -eq "View image" -and $_.Current.ControlType -in @(
      [System.Windows.Automation.ControlType]::Hyperlink,
      [System.Windows.Automation.ControlType]::Button
    )
  })
  foreach ($link in $imageLinks) {
    foreach ($container in @(Get-ResultContainers $link)) {
      $summary = Get-ElementSummary $container
      if ($summary -and $summary -notin $observed) {
        $observed += "$($container.Current.ControlType.ProgrammaticName): $summary"
      }
      if (Test-AllTerms $summary $matchTerms) {
        $verifiedLink = $link
        $verifiedContainer = $container
        break
      }
    }
    if ($verifiedLink) { break }
  }
  if (-not $verifiedLink) { Start-Sleep -Milliseconds 750 }
} while (-not $verifiedLink -and (Get-Date) -lt $deadline)

if ($InspectOnly) {
  Write-Host "Expected row terms: $($matchTerms -join ', ')"
  if ($observed.Count) {
    Write-Host "Visible result rows:"
    $observed | Select-Object -First 12 | ForEach-Object { Write-Host "  $_" }
  } else {
    Write-Host "No image-bearing result rows were exposed."
  }
  if ($verifiedLink) { Write-Host "A verified image-bearing row is ready for acquisition." }
  exit 0
}

if ($InspectTranscript) {
  if (-not $verifiedContainer) { throw "No verified result row was available for transcript inspection: $TargetId" }
  $transcript = Get-Elements $verifiedContainer | Where-Object {
    $_.Current.Name -eq "View transcript" -and $_.Current.ControlType -in @(
      [System.Windows.Automation.ControlType]::Hyperlink,
      [System.Windows.Automation.ControlType]::Button
    )
  } | Select-Object -First 1
  if (-not $transcript) { throw "Verified result row has no transcript control: $TargetId" }
  Focus-SubscriptionChrome | Out-Null
  Click-AccessibleElement $transcript
  Start-Sleep -Seconds 4
  $root = Get-SubscriptionChromeRoot
  Write-Host "Visible transcript text for verified target ${TargetId}:"
  Get-Elements $root | Where-Object {
    $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Text -and $_.Current.Name
  } | ForEach-Object { $_.Current.Name -replace '\s+', ' ' } | Select-Object -Unique -First 240 | ForEach-Object {
    Write-Host "  $_"
  }
  exit 0
}

if (-not $verifiedLink) {
  throw "No image-bearing result row matched every verification term for $TargetId"
}

Focus-SubscriptionChrome | Out-Null
Click-AccessibleElement $verifiedLink
Start-Sleep -Milliseconds 750
Focus-SubscriptionChrome | Out-Null
$script:findmypastViewerTabOpened = $true
[System.Windows.Forms.SendKeys]::SendWait('^{TAB}')
Start-Sleep -Seconds 3
$downloadLink = $null
$downloadDeadline = (Get-Date).AddSeconds(25)
do {
  $root = Get-SubscriptionChromeRoot
  $downloadLink = Get-Elements $root | Where-Object {
    $_.Current.Name -eq "Download record" -and $_.Current.ControlType -in @(
      [System.Windows.Automation.ControlType]::Hyperlink,
      [System.Windows.Automation.ControlType]::Button
    )
  } | Select-Object -First 1
  if (-not $downloadLink) { Start-Sleep -Milliseconds 750 }
} while (-not $downloadLink -and (Get-Date) -lt $downloadDeadline)
if (-not $downloadLink) { throw "Verified Findmypast image viewer did not expose Download record for $TargetId" }

for ($advance = 1; $advance -lt $Part; $advance++) {
  $root = Get-SubscriptionChromeRoot
  $next = Get-Elements $root | Where-Object {
    $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Hyperlink -and
    $_.Current.Name -match 'Next$'
  } | Select-Object -First 1
  if (-not $next) { throw "Findmypast viewer exposed no next image while acquiring part $Part for $TargetId" }
  Click-AccessibleElement $next
  Start-Sleep -Seconds 3
}

if ($Part -gt 1) {
  $downloadLink = $null
  $advancedDeadline = (Get-Date).AddSeconds(20)
  do {
    $root = Get-SubscriptionChromeRoot
    $downloadLink = Get-Elements $root | Where-Object {
      $_.Current.Name -eq "Download record" -and $_.Current.ControlType -in @(
        [System.Windows.Automation.ControlType]::Hyperlink,
        [System.Windows.Automation.ControlType]::Button
      )
    } | Select-Object -First 1
    if (-not $downloadLink) { Start-Sleep -Milliseconds 750 }
  } while (-not $downloadLink -and (Get-Date) -lt $advancedDeadline)
  if (-not $downloadLink) { throw "Advanced Findmypast image did not expose Download record for $TargetId part $Part" }
}

$downloads = Join-Path $env:USERPROFILE "Downloads"
$before = @(Get-ChildItem -LiteralPath $downloads -File | Select-Object -ExpandProperty FullName)
Invoke-AccessibleElement $downloadLink

$downloadDeadline = (Get-Date).AddSeconds(60)
$source = $null
do {
  Start-Sleep -Milliseconds 500
  $source = Get-ChildItem -LiteralPath $downloads -File | Where-Object {
    $_.FullName -notin $before -and $_.Extension -ne ".crdownload" -and $_.Length -gt 1024
  } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
} while (-not $source -and (Get-Date) -lt $downloadDeadline)
if (-not $source) { throw "No completed Findmypast download appeared for $TargetId" }

$length = $source.Length
Start-Sleep -Milliseconds 750
$source.Refresh()
if ($source.Length -ne $length) { throw "Findmypast download was still changing; rerun after it completes" }

  & (Join-Path $ScriptDir "archive-subscription-download-windows.ps1") `
    -TargetId $TargetId -SourceFile $source.FullName -ArchiveFile $ArchiveFile -Part $Part
  if ($LASTEXITCODE -ne 0) { throw "Archival transaction failed for $TargetId" }
  Write-Host "Acquired and registered $TargetId from a verified Findmypast result row."
} finally {
  Close-NewSubscriptionTabs -BeforeCount $tabsBeforeOpen
}
