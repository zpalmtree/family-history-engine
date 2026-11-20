param(
  [ValidateSet('audit', 'clean', 'clean-errors', 'viewers')]
  [string]$Mode = 'audit'
)

$ErrorActionPreference = 'Stop'

$browserMutex = [System.Threading.Mutex]::new($false, 'Local\FamilyHistorySubscriptionChromeSharedWindow')
$browserMutexAcquired = $false
try {
  try {
    $browserMutexAcquired = $browserMutex.WaitOne(55000)
  } catch [System.Threading.AbandonedMutexException] {
    $browserMutexAcquired = $true
  }
  if (-not $browserMutexAcquired) {
    throw 'The shared subscription Chrome window is busy in another agent; retry this action after that agent finishes.'
  }

  $backgroundMode = switch ($Mode) {
    'audit' { 'audit-tabs' }
    'clean' { 'clean-tabs' }
    'clean-errors' { 'clean-error-tabs' }
    'viewers' { 'viewer-inventory' }
  }
  $backgroundScript = Join-Path $PSScriptRoot 'subscription-cdp.mjs'
  & node.exe $backgroundScript --mode $backgroundMode --affinity-slot tab-audit
  if ($LASTEXITCODE -ne 0) {
    throw "Background subscription tab action failed: $Mode"
  }
  return

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class FamilyHistorySubscriptionTabMouse {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr handle);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr handle, int command);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attachThread, uint attachToThread, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr handle, uint flags);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr handle, StringBuilder className, int maxCount);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  public static void Click(int x, int y) {
    SetCursorPos(x, y);
    mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
    mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
  }
  public static bool ActivateExactWindow(IntPtr handle) {
    if (handle == IntPtr.Zero) return false;
    IntPtr foreground = GetForegroundWindow();
    uint ignored;
    uint foregroundThread = foreground == IntPtr.Zero ? 0 : GetWindowThreadProcessId(foreground, out ignored);
    uint targetThread = GetWindowThreadProcessId(handle, out ignored);
    uint currentThread = GetCurrentThreadId();
    bool attachedForeground = false;
    bool attachedTarget = false;
    try {
      if (foregroundThread != 0 && foregroundThread != currentThread) attachedForeground = AttachThreadInput(currentThread, foregroundThread, true);
      if (targetThread != 0 && targetThread != currentThread && targetThread != foregroundThread) attachedTarget = AttachThreadInput(currentThread, targetThread, true);
      ShowWindowAsync(handle, 9);
      BringWindowToTop(handle);
      SetForegroundWindow(handle);
    } finally {
      if (attachedTarget) AttachThreadInput(currentThread, targetThread, false);
      if (attachedForeground) AttachThreadInput(currentThread, foregroundThread, false);
    }
    return GetAncestor(GetForegroundWindow(), 3) == handle;
  }
  public static IntPtr[] GetChromeWindowHandles() {
    var handles = new List<IntPtr>();
    EnumWindows(delegate (IntPtr handle, IntPtr _) {
      if (!IsWindowVisible(handle)) return true;
      var className = new StringBuilder(256);
      GetClassName(handle, className, className.Capacity);
      if (className.ToString() == "Chrome_WidgetWin_1") handles.Add(handle);
      return true;
    }, IntPtr.Zero);
    return handles.ToArray();
  }
}
"@

function Set-ControlledWindowForeground {
  param([IntPtr]$WindowHandle)

  [FamilyHistorySubscriptionTabMouse]::SetForegroundWindow($WindowHandle) | Out-Null
  Start-Sleep -Milliseconds 350
  $active = [FamilyHistorySubscriptionTabMouse]::GetAncestor([FamilyHistorySubscriptionTabMouse]::GetForegroundWindow(), 3)
  if ($active -ne $WindowHandle) {
    [uint32]$windowProcessId = 0
    [FamilyHistorySubscriptionTabMouse]::GetWindowThreadProcessId($WindowHandle, [ref]$windowProcessId) | Out-Null
    if ($windowProcessId -gt 0) {
      $shell = New-Object -ComObject WScript.Shell
      $shell.AppActivate([int]$windowProcessId) | Out-Null
      Start-Sleep -Milliseconds 350
      [FamilyHistorySubscriptionTabMouse]::SetForegroundWindow($WindowHandle) | Out-Null
      Start-Sleep -Milliseconds 350
      $active = [FamilyHistorySubscriptionTabMouse]::GetAncestor([FamilyHistorySubscriptionTabMouse]::GetForegroundWindow(), 3)
    }
  }
  if ($active -ne $WindowHandle) {
    [FamilyHistorySubscriptionTabMouse]::ActivateExactWindow($WindowHandle) | Out-Null
    Start-Sleep -Milliseconds 350
    $active = [FamilyHistorySubscriptionTabMouse]::GetAncestor([FamilyHistorySubscriptionTabMouse]::GetForegroundWindow(), 3)
  }
  return $active -eq $WindowHandle
}

function Get-AddressBarState {
  param([System.Windows.Automation.AutomationElement]$Root)

  $address = $Root.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.Condition]::TrueCondition
    ) | Where-Object {
      $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit -and
      $_.Current.Name -eq 'Address and search bar'
    } | Select-Object -First 1
  if (-not $address) {
    return [pscustomobject]@{ ReadSucceeded = $false; Value = $null }
  }
  try {
    $value = $address.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    return [pscustomobject]@{
      ReadSucceeded = $true
      Value = [string]([System.Windows.Automation.ValuePattern]$value).Current.Value
    }
  } catch {}
  try {
    $legacy = $address.GetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern)
    return [pscustomobject]@{
      ReadSucceeded = $true
      Value = [string]([System.Windows.Automation.LegacyIAccessiblePattern]$legacy).Current.Value
    }
  } catch {}
  return [pscustomobject]@{ ReadSucceeded = $false; Value = $null }
}

function Test-BlankAddress {
  param([string]$Address)

  return (-not $Address -or $Address -eq 'about:blank' -or
    $Address -match '^chrome://(?:newtab|new-tab-page(?:-third-party)?)/?$')
}

function Get-SelectedTabRuntimeId {
  param([System.Windows.Automation.AutomationElement]$Root)

  $tabs = @($Root.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.Condition]::TrueCondition
    ) | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::TabItem })
  foreach ($tab in $tabs) {
    try {
      $selection = $tab.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
      if (([System.Windows.Automation.SelectionItemPattern]$selection).Current.IsSelected) {
        return (($tab.GetRuntimeId()) -join ':')
      }
    } catch {}
    try {
      $legacy = $tab.GetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern)
      $legacyState = ([System.Windows.Automation.LegacyIAccessiblePattern]$legacy).Current.State
      if (($legacyState -band [System.Windows.Forms.AccessibleStates]::Selected) -ne 0 -or
        ($legacyState -band [System.Windows.Forms.AccessibleStates]::Focused) -ne 0) {
        return (($tab.GetRuntimeId()) -join ':')
      }
    } catch {}
  }
  $activeTitle = ([string]$Root.Current.Name) -replace ' - Google Chrome$', ''
  if ($activeTitle) {
    $titleMatches = @($tabs | Where-Object { [string]$_.Current.Name -eq $activeTitle })
    if ($titleMatches.Count -eq 1) {
      return (($titleMatches[0].GetRuntimeId()) -join ':')
    }
  }
  return $null
}

if ($Mode -eq 'viewers') {
  $visibleChromeWindowHandles = @([FamilyHistorySubscriptionTabMouse]::GetChromeWindowHandles())
  $providerTitles = @()
  $ancestryTitles = @()
  foreach ($visibleChromeWindowHandle in $visibleChromeWindowHandles) {
    try {
      $viewerRoot = [System.Windows.Automation.AutomationElement]::FromHandle(
        [IntPtr]$visibleChromeWindowHandle
      )
      $providerTitles += @($viewerRoot.FindAll(
          [System.Windows.Automation.TreeScope]::Descendants,
          [System.Windows.Automation.Condition]::TrueCondition
        ) | Where-Object {
          $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::TabItem -and
          $_.Current.Name -match '(?i)findmypast'
        } | ForEach-Object {
          ([string]$_.Current.Name -replace '[\r\n]', ' ').Trim()
        })
      $ancestryTitles += @($viewerRoot.FindAll(
          [System.Windows.Automation.TreeScope]::Descendants,
          [System.Windows.Automation.Condition]::TrueCondition
        ) | Where-Object {
          $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::TabItem -and
          $_.Current.Name -match '(?i)Ancestry\.com'
        } | ForEach-Object {
          ([string]$_.Current.Name -replace '[\r\n]', ' ').Trim()
        })
    } catch {}
  }
  $exactViewerTitles = @($providerTitles | Where-Object {
    $_ -match '^[^|]+ Image \| findmypast\.(com|co\.uk)(?: - Memory usage - \d+ MB)?$'
  })
  Write-Host "Findmypast tab inventory: provider-tabs=$($providerTitles.Count); exact-viewer-tabs=$($exactViewerTitles.Count)"
  foreach ($providerTitle in @($providerTitles | Sort-Object)) {
    $kind = if ($providerTitle -in $exactViewerTitles) { 'viewer' } else { 'other' }
    Write-Host "  [$kind] $providerTitle"
  }
  Write-Host "Ancestry tab inventory: provider-tabs=$($ancestryTitles.Count)"
  foreach ($ancestryTitle in @($ancestryTitles | Sort-Object -Unique)) {
    Write-Host "  [ancestry] $ancestryTitle"
  }
  return
}

$sharedWindowPath = Join-Path ([IO.Path]::GetTempPath()) 'family-history-subscription-shared-window.json'
$windows = @()
foreach ($windowHandle in @([FamilyHistorySubscriptionTabMouse]::GetChromeWindowHandles())) {
  try {
    [uint32]$windowProcessId = 0
    [FamilyHistorySubscriptionTabMouse]::GetWindowThreadProcessId(
      [IntPtr]$windowHandle,
      [ref]$windowProcessId
    ) | Out-Null
    $windowProcess = Get-Process -Id $windowProcessId -ErrorAction SilentlyContinue
    if (-not $windowProcess -or $windowProcess.Name -ne 'chrome') { continue }
    $windowRoot = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$windowHandle)
    $windowTitle = [string]$windowRoot.Current.Name
    if ($windowTitle -match '(?i)(FamilySearch|Account settings|Full-Text Search Results)') { continue }
    $windowTabs = @($windowRoot.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition
      ) | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::TabItem })
    $providerTabCount = @($windowTabs | Where-Object {
      ([string]$_.Current.Name) -match '(?i)(Ancestry|findmypast)'
    }).Count
    if ($providerTabCount -eq 0) { continue }
    $windows += [pscustomobject]@{
      Id = [int]$windowProcessId
      MainWindowHandle = [IntPtr]$windowHandle
      MainWindowTitle = $windowTitle
      ProviderTabCount = $providerTabCount
      TabCount = $windowTabs.Count
    }
  } catch {}
}
if (-not $windows) {
  throw 'No normal Windows Chrome subscription window is visible.'
}
$persistedHandle = 0
$persistedProcessId = 0
if (Test-Path -LiteralPath $sharedWindowPath) {
  try {
    $persisted = Get-Content -LiteralPath $sharedWindowPath -Raw | ConvertFrom-Json
    if ([int]$persisted.schemaVersion -eq 1) {
      $persistedHandle = [int64]$persisted.windowHandle
      $persistedProcessId = [int]$persisted.processId
    }
  } catch {}
}
$window = $windows | Where-Object {
  [int64]$_.MainWindowHandle -eq $persistedHandle -and $_.Id -eq $persistedProcessId
} | Select-Object -First 1
if (-not $window) {
  $window = $windows | Sort-Object -Property @(
    @{ Expression = 'ProviderTabCount'; Descending = $true },
    @{ Expression = 'TabCount'; Descending = $true },
    @{ Expression = { [int64]$_.MainWindowHandle }; Descending = $false }
  ) | Select-Object -First 1
  [pscustomobject]@{
    schemaVersion = 1
    windowHandle = ([int64]$window.MainWindowHandle)
    processId = $window.Id
    selectedAt = [DateTime]::UtcNow.ToString('o')
  } | ConvertTo-Json | Set-Content -LiteralPath $sharedWindowPath -Encoding UTF8
}
$handle = [IntPtr]$window.MainWindowHandle
if (-not (Set-ControlledWindowForeground -WindowHandle $handle)) {
  throw 'The selected Windows Chrome subscription window could not be activated safely.'
}

$closed = 0
$root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
if ($Mode -eq 'clean-errors') {
  $ignoredErrorRuntimeIds = @{}
  for ($errorIteration = 0; $errorIteration -lt 200; $errorIteration++) {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
    $errorTab = $root.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition
      ) | Where-Object {
        $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::TabItem -and
        $_.Current.Name -eq '500 Internal Server Error' -and
        -not $ignoredErrorRuntimeIds.ContainsKey((($_.GetRuntimeId()) -join ':'))
      } | Select-Object -First 1
    if (-not $errorTab) { break }
    $errorRuntimeId = (($errorTab.GetRuntimeId()) -join ':')
    try {
      $errorSelection = $errorTab.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
      ([System.Windows.Automation.SelectionItemPattern]$errorSelection).Select()
    } catch {
      $ignoredErrorRuntimeIds[$errorRuntimeId] = $true
      continue
    }
    Start-Sleep -Milliseconds 350
    if (-not (Set-ControlledWindowForeground -WindowHandle $handle)) {
      throw 'The controlled Chrome window lost foreground during exact error-tab cleanup.'
    }
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
    $errorAddress = Get-AddressBarState -Root $root
    [Uri]$errorUri = $null
    $parsedErrorAddress = $errorAddress.ReadSucceeded -and
      ([Uri]::TryCreate([string]$errorAddress.Value, [UriKind]::Absolute, [ref]$errorUri) -or
        [Uri]::TryCreate("https://$($errorAddress.Value)", [UriKind]::Absolute, [ref]$errorUri))
    $allowedErrorAddress = $parsedErrorAddress -and (
      ($errorUri.Scheme -eq 'chrome-error' -and $errorUri.Host -eq 'chromewebdata') -or
      ($errorUri.Scheme -eq 'https' -and
        $errorUri.Host -match '(^|\.)(ancestry\.(com|co\.uk)|findmypast\.(com|co\.uk))$')
    )
    if ((Get-SelectedTabRuntimeId -Root $root) -ne $errorRuntimeId -or
      [string]$root.Current.Name -notmatch '^500 Internal Server Error(?: - Google Chrome)?$' -or
      -not $allowedErrorAddress) {
      $ignoredErrorRuntimeIds[$errorRuntimeId] = $true
      continue
    }
    [System.Windows.Forms.SendKeys]::SendWait('^w')
    Start-Sleep -Milliseconds 400
    $closed++
  }
  Write-Host "Closed $closed exact 500-error tab(s) after title, selection, and provider/error-URL verification; no record page was closed."
  return
}
if ($Mode -eq 'clean') {
  for ($selectedBlankIteration = 0; $selectedBlankIteration -lt 200; $selectedBlankIteration++) {
    if (-not (Set-ControlledWindowForeground -WindowHandle $handle)) {
      throw 'The controlled Chrome window lost foreground before selected-blank cleanup.'
    }
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
    $selectedAddress = Get-AddressBarState -Root $root
    $selectedWindowTitle = [string]$root.Current.Name
    if ($selectedWindowTitle -notmatch '^New Tab(?: - Google Chrome)?$' -or
      -not $selectedAddress.ReadSucceeded -or
      -not (Test-BlankAddress -Address $selectedAddress.Value)) {
      break
    }
    [System.Windows.Forms.SendKeys]::SendWait('^w')
    Start-Sleep -Milliseconds 400
    $closed++
  }
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
}
$tabs = @($root.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition
  ) | Where-Object {
    $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::TabItem
  })
$newTabs = @($tabs | Where-Object { $_.Current.Name -match '^(?:New Tab(?: - Google Chrome)?|about:blank)$' })
Write-Host "Subscription tab audit: window=$($root.Current.Name); tab-items=$($tabs.Count), exact-new-tabs=$($newTabs.Count)"
if ($Mode -eq 'audit') { return }
if (-not $newTabs) {
  Write-Host "Closed $closed verified blank/new-tab tab(s); no provider record tab was enumerated or closed."
  return
}

$ignoredRuntimeIds = @{}
for ($iteration = 0; $iteration -lt 200; $iteration++) {
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
  $candidate = $root.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.Condition]::TrueCondition
    ) | Where-Object {
      $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::TabItem -and
      $_.Current.Name -match '^(?:New Tab(?: - Google Chrome)?|about:blank)$' -and
      -not $ignoredRuntimeIds.ContainsKey((($_.GetRuntimeId()) -join ':'))
    } | Select-Object -First 1
  if (-not $candidate) { break }

  if (-not (Set-ControlledWindowForeground -WindowHandle $handle)) {
    throw 'The controlled Chrome window lost foreground before blank-tab inspection.'
  }
  $bounds = $candidate.Current.BoundingRectangle
  $windowBounds = $root.Current.BoundingRectangle
  if ($bounds.Width -le 0 -or $bounds.Height -le 0 -or
    $bounds.X -lt $windowBounds.X -or $bounds.Y -lt $windowBounds.Y -or
    ($bounds.X + $bounds.Width) -gt ($windowBounds.X + $windowBounds.Width) -or
    ($bounds.Y + $bounds.Height) -gt ($windowBounds.Y + $windowBounds.Height)) {
    throw 'An exact New Tab control was not safely clickable inside the controlled Chrome window.'
  }
  [FamilyHistorySubscriptionTabMouse]::Click(
    [int]($bounds.X + $bounds.Width / 2),
    [int]($bounds.Y + $bounds.Height / 2)
  )
  Start-Sleep -Milliseconds 400
  if (-not (Set-ControlledWindowForeground -WindowHandle $handle)) {
    throw 'The controlled Chrome window lost foreground after blank-tab selection.'
  }
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
  if ((Get-SelectedTabRuntimeId -Root $root) -ne (($candidate.GetRuntimeId()) -join ':')) {
    throw 'The exact New Tab control was not selected after its verified click.'
  }
  $address = Get-AddressBarState -Root $root
  if (-not $address.ReadSucceeded -or -not (Test-BlankAddress -Address $address.Value)) {
    $ignoredRuntimeIds[(($candidate.GetRuntimeId()) -join ':')] = $true
    continue
  }
  [System.Windows.Forms.SendKeys]::SendWait('^w')
  Start-Sleep -Milliseconds 350
  $closed++
}

Write-Host "Closed $closed verified blank/new-tab tab(s); no provider record tab was enumerated or closed."
} finally {
  if ($browserMutexAcquired) {
    try { $browserMutex.ReleaseMutex() } catch {}
  }
  $browserMutex.Dispose()
}
