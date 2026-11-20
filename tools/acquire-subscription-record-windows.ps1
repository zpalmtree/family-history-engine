param(
  [Parameter(Mandatory = $true)]
  [string]$TargetId,

  [Parameter(Mandatory = $true)]
  [string]$ArchiveFile,

  [int]$Part = 1
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
  $route = $canonical.routes | Where-Object {
    $_.id -eq $TargetId -and
    $_.sourceQueue -eq "subscription-records" -and
    $_.provider -eq "Ancestry" -and
    $_.status -in @("ready-subscription-capture", "acquired")
  } | Select-Object -First 1
  if (-not $route) { throw "Canonical subscription target has no exact ready Ancestry route: $TargetId" }
  $target = [pscustomobject]@{
    id = $canonical.id
    provider = $route.provider
    status = "pending-subscription"
    catalogueUrl = $route.sourceUrl
  }
}
if ($target.provider -ne "Ancestry") { throw "Automated acquisition currently supports exact Ancestry targets; use the provider inspection workflow for Findmypast." }
if ($target.status -notin @("pending-subscription", "provider-alternate")) { throw "Target is not pending acquisition: $TargetId" }
if ($target.catalogueUrl -notmatch '^https://www\.ancestry\.(com|co\.uk)/(search/collections/\d+/records/\d+|imageviewer/)') {
  throw "Target does not have an exact Ancestry record or image-viewer URL: $TargetId"
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
  -Url $target.catalogueUrl `
  -Provider ancestry `
  -TargetId $TargetId `
  -ArchiveFile $ArchiveFile `
  -Part $Part `
  -AffinitySlot $affinitySlot
return

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class FamilyHistoryMouse {
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

function Get-SubscriptionChromeRoot {
  $processInfo = Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq "chrome.exe" -and $_.CommandLine -match 'remote-debugging-port=9226'
  } | Select-Object -First 1
  $process = if ($processInfo) { Get-Process -Id $processInfo.ProcessId -ErrorAction SilentlyContinue } else { $null }
  if (-not $process -or $process.MainWindowHandle -eq 0) {
    $process = Get-Process chrome | Where-Object {
      $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -notmatch 'FamilySearch|Full-Text Search Results'
    } | Select-Object -First 1
  }
  if (-not $process) { throw "No user-controlled Windows Chrome subscription window was found." }
  return [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
}

function Focus-SubscriptionChrome {
  $processInfo = Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq "chrome.exe" -and $_.CommandLine -match 'remote-debugging-port=9226'
  } | Select-Object -First 1
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
  if (-not $script:subscriptionTargetTabOpened) { return }
  Focus-SubscriptionChrome | Out-Null
  [System.Windows.Forms.SendKeys]::SendWait('^w')
  Start-Sleep -Milliseconds 500
  Write-Host "Closed the controlled tab created by this Ancestry acquisition."
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
  throw "The visible provider control could not be activated through Windows accessibility automation."
}

function Click-AccessibleElement($element) {
  $bounds = $element.Current.BoundingRectangle
  if ($bounds.Width -le 0 -or $bounds.Height -le 0) { throw "The visible provider control has no clickable bounds." }
  $window = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($element)
  while ($window -and $window.Current.ControlType -ne [System.Windows.Automation.ControlType]::Window) {
    $window = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($window)
  }
  if ($window -and $window.Current.NativeWindowHandle) {
    [FamilyHistoryMouse]::SetForegroundWindow([IntPtr]$window.Current.NativeWindowHandle) | Out-Null
    Start-Sleep -Milliseconds 300
  }
  [FamilyHistoryMouse]::Click(
    [int]($bounds.X + ($bounds.Width / 2)),
    [int]($bounds.Y + ($bounds.Height / 2))
  )
}

try {
  $focusRoot = Get-SubscriptionChromeRoot
  Focus-SubscriptionChrome | Out-Null
  Start-Sleep -Milliseconds 300
} catch {
  # A subscription Chrome window may not exist until the first target opens.
}
$script:subscriptionTargetTabOpened = $false
$tabsBeforeOpen = Get-SubscriptionTabCount
try {
  Open-SubscriptionTargetTab $target.catalogueUrl
$root = Get-SubscriptionChromeRoot
$viewer = $target.catalogueUrl -match '/imageviewer/'

if (-not $viewer) {
  $viewDeadline = (Get-Date).AddSeconds(15)
  $viewLink = $null
  do {
    $root = Get-SubscriptionChromeRoot
    $viewLink = Get-Elements $root | Where-Object {
      ($_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $_.Current.Name -eq "View image") -or
      ($_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Hyperlink -and
        $_.Current.Name -match '^View .+' -and $_.Current.Name -notmatch '^View (others|record|profile)')
    } | Select-Object -First 1
    if (-not $viewLink) { Start-Sleep -Milliseconds 500 }
  } while (-not $viewLink -and (Get-Date) -lt $viewDeadline)
  if (-not $viewLink) { throw "No current-record image link was exposed for $TargetId" }
  Click-AccessibleElement $viewLink
  Start-Sleep -Seconds 3
  $root = Get-SubscriptionChromeRoot
  $sameTabToolMenu = Get-Elements $root | Where-Object { $_.Current.Name -eq "Tool menu" } | Select-Object -First 1
  if (-not $sameTabToolMenu) {
    # Ancestry normally opens the viewer in the immediately adjacent background
    # tab. The source record stays active, so advance exactly one tab.
    Focus-SubscriptionChrome | Out-Null
    [System.Windows.Forms.SendKeys]::SendWait('^{TAB}')
    Start-Sleep -Seconds 2
  }
}

$root = Get-SubscriptionChromeRoot
$toolDeadline = (Get-Date).AddSeconds(15)
$toolMenu = $null
do {
  $root = Get-SubscriptionChromeRoot
  $toolMenu = Get-Elements $root | Where-Object {
    $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $_.Current.Name -eq "Tool menu"
  } | Select-Object -First 1
  if (-not $toolMenu) { Start-Sleep -Milliseconds 500 }
} while (-not $toolMenu -and (Get-Date) -lt $toolDeadline)
if (-not $toolMenu) { throw "Ancestry image viewer did not expose its tool menu for $TargetId" }
$expand = $toolMenu.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
if (([System.Windows.Automation.ExpandCollapsePattern]$expand).Current.ExpandCollapseState -ne [System.Windows.Automation.ExpandCollapseState]::Expanded) {
  ([System.Windows.Automation.ExpandCollapsePattern]$expand).Expand()
}
Start-Sleep -Milliseconds 400

$downloads = Join-Path $env:USERPROFILE "Downloads"
$before = @(Get-ChildItem -LiteralPath $downloads -File | Select-Object -ExpandProperty FullName)
$root = Get-SubscriptionChromeRoot
$download = Get-Elements $root | Where-Object {
  $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $_.Current.Name -eq "Download"
} | Select-Object -First 1
if (-not $download) { throw "Ancestry image viewer did not expose its normal download control for $TargetId" }
Invoke-AccessibleElement $download

$deadline = (Get-Date).AddSeconds(45)
$source = $null
do {
  Start-Sleep -Milliseconds 500
  $source = Get-ChildItem -LiteralPath $downloads -File | Where-Object {
    $_.FullName -notin $before -and $_.Extension -ne ".crdownload" -and $_.Length -gt 1024
  } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
} while (-not $source -and (Get-Date) -lt $deadline)
if (-not $source) { throw "No completed Ancestry download appeared for $TargetId" }

$length = $source.Length
Start-Sleep -Milliseconds 750
$source.Refresh()
if ($source.Length -ne $length) { throw "Ancestry download was still changing; rerun after it completes" }

  & (Join-Path $ScriptDir "archive-subscription-download-windows.ps1") `
    -TargetId $TargetId -SourceFile $source.FullName -ArchiveFile $ArchiveFile -Part $Part
  if ($LASTEXITCODE -ne 0) { throw "Archival transaction failed for $TargetId" }
  Write-Host "Acquired and registered $TargetId without reading credentials, cookies, account state, or payment data."
} finally {
  Close-NewSubscriptionTabs -BeforeCount $tabsBeforeOpen
}
