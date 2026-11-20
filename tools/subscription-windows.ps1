param(
  [ValidateSet("open", "navigate", "adopt-search", "adopt-transcription", "recover-record", "recover-ancestry-record", "adopt-viewer", "record-links", "inspect-view-action", "next-image", "zoom-in", "zoom-out", "signin-saved", "inspect", "view-transcript", "view-image", "view-article", "download-record", "preview-download", "select-image-region", "capture-full-page", "download-clipping", "image-tools", "extra-materials")]
  [string]$Mode = "open",

  [Parameter(Mandatory = $true)]
  [string]$Url,

  [ValidateSet("any", "ancestry", "findmypast")]
  [string]$Provider = "any",

  [ValidateRange(1, 50)]
  [int]$ResultIndex = 1,

  [string]$ExpectedTabTitle = "",

  [string]$TargetId = "",

  [string]$ArchiveFile = "",

  [ValidateRange(1, 20)]
  [int]$Part = 1,

  [int]$DebugPort = 9226,

  [ValidatePattern('^[a-z0-9][a-z0-9-]{0,31}$')]
  [string]$AffinitySlot = "default"
)

$ErrorActionPreference = "Stop"

# The default subscription backend is the dedicated persistent Windows Chrome
# profile controlled through localhost CDP. It never uses UI Automation,
# SendKeys, physical mouse input, or foreground-window activation. The legacy
# implementation remains below temporarily for reference while every caller is
# migrated, but this dispatcher is unconditional: there is no focus-stealing
# fallback.
$backgroundDispatcher = Join-Path $PSScriptRoot 'subscription-cdp-dispatch-windows.ps1'
$backgroundParameters = @{
  Mode = $Mode
  Url = $Url
  Provider = $Provider
  ResultIndex = $ResultIndex
  ExpectedTabTitle = $ExpectedTabTitle
  TargetId = $TargetId
  ArchiveFile = $ArchiveFile
  Part = $Part
  DebugPort = $DebugPort
  AffinitySlot = $AffinitySlot
}
& $backgroundDispatcher @backgroundParameters
return

$browserMutex = [System.Threading.Mutex]::new($false, 'Local\FamilyHistorySubscriptionChromeSharedWindow')
$browserMutexAcquired = $false
try {
  try {
    $browserMutexAcquired = $browserMutex.WaitOne(55000)
  } catch [System.Threading.AbandonedMutexException] {
    $browserMutexAcquired = $true
  }
  if (-not $browserMutexAcquired) {
    throw "The shared subscription Chrome window is busy in another agent; retry this action after that agent finishes."
  }

$target = [Uri]$Url
if ($target.Scheme -ne "https" -or $target.Host -notmatch '(^|\.)(ancestry\.(com|co\.uk)|findmypast\.(com|co\.uk))$') {
  throw "Only HTTPS Ancestry and Findmypast URLs are permitted."
}
$targetProvider = if ($target.Host -match '(^|\.)ancestry\.') { "ancestry" } else { "findmypast" }
if ($Provider -ne "any" -and $Provider -ne $targetProvider) {
  throw "The requested provider does not match the allowlisted URL host."
}
$effectiveProvider = if ($Provider -eq "any") { $targetProvider } else { $Provider }
$affinitySuffix = if ($AffinitySlot -eq 'default') { '' } else { "-$AffinitySlot" }
$affinityPath = Join-Path ([IO.Path]::GetTempPath()) "family-history-subscription-affinity$affinitySuffix.json"
$viewerCandidatePath = Join-Path ([IO.Path]::GetTempPath()) "family-history-subscription-viewer-candidate$affinitySuffix.json"
$sharedWindowPath = Join-Path ([IO.Path]::GetTempPath()) "family-history-subscription-shared-window.json"

$chrome = Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $chrome)) {
  $chrome = Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe"
}
if (-not (Test-Path $chrome)) {
  throw "Google Chrome was not found."
}

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class FamilyHistorySubscriptionMouse {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr handle);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr handle, int command);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attachThread, uint attachToThread, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr handle, uint flags);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr handle, StringBuilder className, int maxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
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
      if (foregroundThread != 0 && foregroundThread != currentThread) {
        attachedForeground = AttachThreadInput(currentThread, foregroundThread, true);
      }
      if (targetThread != 0 && targetThread != currentThread && targetThread != foregroundThread) {
        attachedTarget = AttachThreadInput(currentThread, targetThread, true);
      }
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

function Get-StableSubscriptionWindowTitle {
  param(
    [Parameter(Mandatory = $true)]
    [IntPtr]$WindowHandle,

    [int]$TimeoutSeconds = 20
  )

  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  $lastTitle = ""
  $stableSamples = 0
  do {
    Start-Sleep -Milliseconds 250
    $currentTitle = ([System.Windows.Automation.AutomationElement]::FromHandle($WindowHandle)).Current.Name
    if ($currentTitle -and $currentTitle -notmatch '^New Tab(?: - Google Chrome)?$') {
      if ($currentTitle -eq $lastTitle) {
        $stableSamples++
      } else {
        $lastTitle = $currentTitle
        $stableSamples = 1
      }
      if ($stableSamples -ge 3) { return $currentTitle }
    } else {
      $lastTitle = ""
      $stableSamples = 0
    }
  } while ([DateTime]::UtcNow -lt $deadline)

  return $lastTitle
}

function Get-SubscriptionAddressBarState {
  param(
    [Parameter(Mandatory = $true)]
    [IntPtr]$WindowHandle
  )

  try {
    $foregroundHandle = [FamilyHistorySubscriptionMouse]::GetAncestor([FamilyHistorySubscriptionMouse]::GetForegroundWindow(), 3)
    if ($foregroundHandle -ne $WindowHandle) {
      return [pscustomobject]@{ ReadSucceeded = $false; Value = $null; Uri = $null }
    }
    $windowRoot = [System.Windows.Automation.AutomationElement]::FromHandle($WindowHandle)
    $addressBar = $windowRoot.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition) |
      Where-Object {
        $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit -and
        $_.Current.Name -eq 'Address and search bar'
      } | Select-Object -First 1
    if (-not $addressBar) {
      return [pscustomobject]@{ ReadSucceeded = $false; Value = $null; Uri = $null }
    }
    $addressValue = $null
    try {
      $valuePattern = $addressBar.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
      $addressValue = ([System.Windows.Automation.ValuePattern]$valuePattern).Current.Value
    } catch {
      $legacyPattern = $addressBar.GetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern)
      $addressValue = ([System.Windows.Automation.LegacyIAccessiblePattern]$legacyPattern).Current.Value
    }
    $addressUri = $null
    if ([Uri]::TryCreate($addressValue, [UriKind]::Absolute, [ref]$addressUri)) {
      return [pscustomobject]@{ ReadSucceeded = $true; Value = [string]$addressValue; Uri = $addressUri }
    }
    # Chrome can expose a display-form omnibox value with the HTTPS scheme
    # elided. Reconstitute it only in memory; the provider allowlist is applied
    # before the value can be accepted as controlled-tab state.
    if ($addressValue -and [Uri]::TryCreate("https://$addressValue", [UriKind]::Absolute, [ref]$addressUri)) {
      return [pscustomobject]@{ ReadSucceeded = $true; Value = [string]$addressValue; Uri = $addressUri }
    }
  } catch {}
  if ($null -ne $addressValue) {
    return [pscustomobject]@{ ReadSucceeded = $true; Value = [string]$addressValue; Uri = $null }
  }
  return [pscustomobject]@{ ReadSucceeded = $false; Value = $null; Uri = $null }
}

function Get-SubscriptionAddressBarUri {
  param(
    [Parameter(Mandatory = $true)]
    [IntPtr]$WindowHandle
  )

  $state = Get-SubscriptionAddressBarState -WindowHandle $WindowHandle
  if ($state.ReadSucceeded) { return $state.Uri }
  return $null
}

function Get-SubscriptionUrlFingerprint {
  param(
    [Parameter(Mandatory = $true)]
    [Uri]$Uri
  )

  # Fingerprint only stable record/search identity. Provider SPAs routinely add,
  # remove, or reorder tracking and presentation parameters after first paint;
  # hashing the raw URL makes a legitimate controlled tab look switched. These
  # fields retain the dataset, person, family, date, and place discriminators
  # needed to distinguish research queries without storing their raw values.
  $identityKeys = @{
    'collection' = $true; 'datasetname' = $true; 'id' = $true; 'parentid' = $true; 'recordid' = $true; 'usepub' = $true
    'name' = $true; 'name_x' = $true
    'firstname' = $true; 'lastname' = $true; 'firstname_variants' = $true; 'lastname_variants' = $true
    'birth' = $true; 'birth_x' = $true; 'birth_place' = $true; 'birth_place_x' = $true
    'yearofbirth' = $true; 'yearofbirth_offset' = $true; 'death' = $true; 'death_x' = $true
    'marriage' = $true; 'marriage_x' = $true; 'marriage_place' = $true; 'marriage_place_x' = $true
    'event' = $true; 'event_x' = $true; 'event_place' = $true; 'eventyear' = $true; 'eventyear_offset' = $true
    'residence' = $true; 'residence_x' = $true; 'keywordsplace' = $true; 'keywordsplace_proximity' = $true
    'arrival' = $true; 'arrival_x' = $true; 'gender' = $true
    'spouse' = $true; 'spousefirstname' = $true; 'spouselastname' = $true
    'father' = $true; 'fatherfirstname' = $true; 'mother' = $true; 'motherfirstname' = $true
    'child' = $true; 'firstnamesother' = $true; 'lastnamesother' = $true
    'newspaper' = $true; 'keywords' = $true; 'exactkeywords' = $true; 'startdate' = $true; 'enddate' = $true
  }
  $identityParts = @()
  foreach ($rawPart in ($Uri.Query.TrimStart('?') -split '&')) {
    if (-not $rawPart) { continue }
    $pair = $rawPart -split '=', 2
    $key = [Uri]::UnescapeDataString(($pair[0] -replace '\+', ' ')).ToLowerInvariant()
    if (-not $identityKeys.ContainsKey($key)) { continue }
    $valueText = if ($pair.Count -gt 1) { [Uri]::UnescapeDataString(($pair[1] -replace '\+', ' ')) } else { '' }
    $identityParts += "$([Uri]::EscapeDataString($key))=$([Uri]::EscapeDataString($valueText))"
  }
  $normalizedPath = $Uri.AbsolutePath.TrimEnd('/').ToLowerInvariant()
  if (-not $normalizedPath) { $normalizedPath = '/' }
  $canonicalHost = Get-CanonicalSubscriptionHost -HostName $Uri.Host
  $canonical = "$($Uri.Scheme.ToLowerInvariant())://$canonicalHost$normalizedPath"
  if ($identityParts.Count -gt 0) {
    $canonical += '?' + (($identityParts | Sort-Object) -join '&')
  }
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($canonical)
    return ([BitConverter]::ToString($sha256.ComputeHash($bytes)) -replace '-', '').ToLowerInvariant()
  } finally {
    $sha256.Dispose()
  }
}

function Get-SubscriptionDownloadBindingKey {
  param(
    [Parameter(Mandatory = $true)]
    [Uri]$Uri
  )

  # Download binding is stricter than navigation affinity. Preserve every
  # viewer query key/value except an explicit list of provider tracking or
  # presentation-only fields, so a newly introduced page/image discriminator
  # cannot be silently discarded.
  $ignoredKeys = @{
    'tid' = $true; 'pid' = $true; 'queryid' = $true; '_phsrc' = $true; '_phstart' = $true
    'lang' = $true; 'geo-lang' = $true; 'view' = $true; 'action' = $true; 'usepub' = $true
  }
  $queryParts = @()
  foreach ($rawPart in ($Uri.Query.TrimStart('?') -split '&')) {
    if (-not $rawPart) { continue }
    $pair = $rawPart -split '=', 2
    $key = [Uri]::UnescapeDataString(($pair[0] -replace '\+', ' ')).ToLowerInvariant()
    if ($ignoredKeys.ContainsKey($key)) { continue }
    $valueText = if ($pair.Count -gt 1) { [Uri]::UnescapeDataString(($pair[1] -replace '\+', ' ')) } else { '' }
    $queryParts += "$([Uri]::EscapeDataString($key))=$([Uri]::EscapeDataString($valueText))"
  }
  $normalizedPath = $Uri.AbsolutePath.TrimEnd('/').ToLowerInvariant()
  if (-not $normalizedPath) { $normalizedPath = '/' }
  $bindingKey = "$($Uri.Scheme.ToLowerInvariant())://$(Get-CanonicalSubscriptionHost -HostName $Uri.Host)$normalizedPath"
  if ($queryParts.Count -gt 0) {
    $bindingKey += '?' + (($queryParts | Sort-Object) -join '&')
  }
  return $bindingKey
}

function Test-SubscriptionProviderUri {
  param(
    [Uri]$Uri,
    [Parameter(Mandatory = $true)]
    [ValidateSet('ancestry', 'findmypast')]
    [string]$ProviderName
  )

  if (-not $Uri -or $Uri.Scheme -ne 'https') { return $false }
  if ($ProviderName -eq 'ancestry') {
    return $Uri.Host -match '(^|\.)(ancestry\.(com|co\.uk))$'
  }
  return $Uri.Host -match '(^|\.)(findmypast\.(com|co\.uk))$'
}

function Get-SubscriptionElementProviderUri {
  param(
    [Parameter(Mandatory = $true)]$Element,
    [Parameter(Mandatory = $true)]
    [ValidateSet('ancestry', 'findmypast')]
    [string]$ProviderName
  )

  $candidateValues = @()
  try {
    $legacy = $Element.GetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern)
    $candidateValues += ([System.Windows.Automation.LegacyIAccessiblePattern]$legacy).Current.Value
  } catch {}
  try {
    $value = $Element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    $candidateValues += ([System.Windows.Automation.ValuePattern]$value).Current.Value
  } catch {}
  try { $candidateValues += [string]$Element.Current.HelpText } catch {}
  foreach ($candidateValue in $candidateValues) {
    [Uri]$candidateUri = $null
    if ([Uri]::TryCreate([string]$candidateValue, [UriKind]::Absolute, [ref]$candidateUri) -and
      (Test-SubscriptionProviderUri -Uri $candidateUri -ProviderName $ProviderName)) {
      return $candidateUri
    }
  }
  return $null
}

function Get-CanonicalSubscriptionHost {
  param(
    [Parameter(Mandatory = $true)]
    [string]$HostName
  )

  $normalizedHost = $HostName.ToLowerInvariant()
  # Chrome commonly elides only the leading www. in the omnibox value exposed
  # through UI Automation. Treat that presentation-only form as the same host;
  # provider and TLD validation still happens independently.
  if ($normalizedHost -match '^www\.(ancestry\.(com|co\.uk)|findmypast\.(com|co\.uk))$') {
    return $Matches[1]
  }
  return $normalizedHost
}

function Test-SubscriptionBlankUri {
  param([Uri]$Uri)

  if (-not $Uri) { return $false }
  return (($Uri.Scheme -eq 'about' -and $Uri.OriginalString -eq 'about:blank') -or
    ($Uri.Scheme -eq 'chrome' -and $Uri.Host -in @('newtab', 'new-tab-page', 'new-tab-page-third-party')))
}

function Test-SubscriptionBlankAddressState {
  param([pscustomobject]$State)

  if (-not $State -or -not $State.ReadSucceeded) { return $false }
  if ([string]::IsNullOrEmpty([string]$State.Value)) { return $true }
  return Test-SubscriptionBlankUri -Uri $State.Uri
}

function Get-SelectedSubscriptionTabRuntimeId {
  param(
    [Parameter(Mandatory = $true)]
    [IntPtr]$WindowHandle
  )

  try {
    $windowRoot = [System.Windows.Automation.AutomationElement]::FromHandle($WindowHandle)
    $tabs = $windowRoot.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition) |
      Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::TabItem }
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
      try {
        if ($tab.Current.HasKeyboardFocus) {
          return (($tab.GetRuntimeId()) -join ':')
        }
      } catch {}
    }
    $activeTitle = ([string]$windowRoot.Current.Name) -replace ' - Google Chrome$', ''
    if ($activeTitle) {
      $titleMatches = @($tabs | Where-Object { [string]$_.Current.Name -eq $activeTitle })
      if ($titleMatches.Count -eq 1) {
        return (($titleMatches[0].GetRuntimeId()) -join ':')
      }
    }
    if ($tabs.Count -eq 1) {
      return (($tabs[0].GetRuntimeId()) -join ':')
    }
  } catch {}
  return $null
}

function Get-SubscriptionTabRuntimeIds {
  param(
    [Parameter(Mandatory = $true)]
    [IntPtr]$WindowHandle
  )

  try {
    $windowRoot = [System.Windows.Automation.AutomationElement]::FromHandle($WindowHandle)
    return @($windowRoot.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition
      ) | Where-Object {
        $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::TabItem
      } | ForEach-Object { (($_.GetRuntimeId()) -join ':') })
  } catch {}
  return @()
}

function Get-SubscriptionTabByRuntimeId {
  param(
    [Parameter(Mandatory = $true)]
    [IntPtr]$WindowHandle,

    [Parameter(Mandatory = $true)]
    [string]$RuntimeId
  )

  try {
    $windowRoot = [System.Windows.Automation.AutomationElement]::FromHandle($WindowHandle)
    return $windowRoot.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition
      ) | Where-Object {
        $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::TabItem -and
        (($_.GetRuntimeId()) -join ':') -eq $RuntimeId
      } | Select-Object -First 1
  } catch {}
  return $null
}

function Get-ChromeTopLevelWindowHandles {
  try {
    return @([FamilyHistorySubscriptionMouse]::GetChromeWindowHandles() | ForEach-Object { $_.ToInt64() })
  } catch {}
  return @()
}

function Get-SharedSubscriptionWindow {
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

  $candidates = @()
  $persistedCandidate = $null
  foreach ($windowHandleValue in @(Get-ChromeTopLevelWindowHandles)) {
    try {
      $windowHandle = [IntPtr][int64]$windowHandleValue
      [uint32]$windowProcessId = 0
      [FamilyHistorySubscriptionMouse]::GetWindowThreadProcessId($windowHandle, [ref]$windowProcessId) | Out-Null
      $windowProcess = Get-Process -Id $windowProcessId -ErrorAction SilentlyContinue
      if (-not $windowProcess -or $windowProcess.Name -ne 'chrome') { continue }
      $windowRoot = [System.Windows.Automation.AutomationElement]::FromHandle($windowHandle)
      $windowTitle = [string]$windowRoot.Current.Name
      $windowTabs = @($windowRoot.FindAll(
          [System.Windows.Automation.TreeScope]::Descendants,
          [System.Windows.Automation.Condition]::TrueCondition
        ) | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::TabItem })
      $providerTabCount = @($windowTabs | Where-Object {
        ([string]$_.Current.Name) -match '(?i)(Ancestry|findmypast)'
      }).Count
      $windowCandidate = [pscustomobject]@{
        Id = [int]$windowProcessId
        MainWindowHandle = $windowHandle
        MainWindowTitle = $windowTitle
        ProviderTabCount = $providerTabCount
        TabCount = $windowTabs.Count
      }
      if ($windowHandle.ToInt64() -eq $persistedHandle -and [int]$windowProcessId -eq $persistedProcessId) {
        $persistedCandidate = $windowCandidate
      }
      if ($windowTitle -match '(?i)(FamilySearch|Account settings|Full-Text Search Results)' -or
        $providerTabCount -eq 0) {
        continue
      }
      $candidates += $windowCandidate
    } catch {}
  }
  if ($persistedCandidate) { return $persistedCandidate }
  if ($candidates.Count -eq 0) { return $null }

  $selected = $candidates | Sort-Object -Property @(
    @{ Expression = 'ProviderTabCount'; Descending = $true },
    @{ Expression = 'TabCount'; Descending = $true },
    @{ Expression = { [int64]$_.MainWindowHandle }; Descending = $false }
  ) | Select-Object -First 1
  [pscustomobject]@{
    schemaVersion = 1
    windowHandle = ([int64]$selected.MainWindowHandle)
    processId = $selected.Id
    selectedAt = [DateTime]::UtcNow.ToString('o')
  } | ConvertTo-Json | Set-Content -LiteralPath $sharedWindowPath -Encoding UTF8
  return $selected
}

function Get-ReusableSubscriptionAffinityTab {
  param(
    [Parameter(Mandatory = $true)]
    [pscustomobject]$SharedWindow
  )

  if (-not (Test-Path -LiteralPath $affinityPath)) { return $null }
  try {
    $savedAffinity = Get-Content -LiteralPath $affinityPath -Raw | ConvertFrom-Json
    if ([int]$savedAffinity.schemaVersion -ne 3 -or
      [int64]$savedAffinity.windowHandle -ne ([IntPtr]$SharedWindow.MainWindowHandle).ToInt64() -or
      [int]$savedAffinity.processId -ne [int]$SharedWindow.Id -or
      [string]::IsNullOrWhiteSpace([string]$savedAffinity.tabRuntimeId) -or
      [string]::IsNullOrWhiteSpace([string]$savedAffinity.activeUrlFingerprint) -or
      [string]$savedAffinity.provider -notin @('ancestry', 'findmypast')) {
      return $null
    }
    $sharedHandle = [IntPtr]$SharedWindow.MainWindowHandle
    $savedTab = Get-SubscriptionTabByRuntimeId -WindowHandle $sharedHandle -RuntimeId ([string]$savedAffinity.tabRuntimeId)
    if (-not $savedTab) { return $null }
    $savedSelection = $savedTab.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
    ([System.Windows.Automation.SelectionItemPattern]$savedSelection).Select()
    Start-Sleep -Milliseconds 350
    if (-not (Set-SubscriptionWindowForeground -WindowHandle $sharedHandle -ProcessId ([int]$SharedWindow.Id)) -or
      (Get-SelectedSubscriptionTabRuntimeId -WindowHandle $sharedHandle) -ne [string]$savedAffinity.tabRuntimeId) {
      return $null
    }
    $savedUri = Get-SubscriptionAddressBarUri -WindowHandle $sharedHandle
    if (-not (Test-SubscriptionProviderUri -Uri $savedUri -ProviderName ([string]$savedAffinity.provider)) -or
      (Get-SubscriptionUrlFingerprint -Uri $savedUri) -ne [string]$savedAffinity.activeUrlFingerprint) {
      return $null
    }
    return [pscustomobject]@{
      Affinity = $savedAffinity
      Uri = $savedUri
      TabRuntimeId = [string]$savedAffinity.tabRuntimeId
    }
  } catch {}
  return $null
}

function Set-SubscriptionWindowForeground {
  param(
    [Parameter(Mandatory = $true)]
    [IntPtr]$WindowHandle,

    [int]$ProcessId = 0
  )

  [FamilyHistorySubscriptionMouse]::SetForegroundWindow($WindowHandle) | Out-Null
  Start-Sleep -Milliseconds 300
  $activeHandle = [FamilyHistorySubscriptionMouse]::GetAncestor([FamilyHistorySubscriptionMouse]::GetForegroundWindow(), 3)
  if ($activeHandle -ne $WindowHandle -and $ProcessId -gt 0) {
    $shell = New-Object -ComObject WScript.Shell
    $shell.AppActivate($ProcessId) | Out-Null
    Start-Sleep -Milliseconds 300
    [FamilyHistorySubscriptionMouse]::SetForegroundWindow($WindowHandle) | Out-Null
    Start-Sleep -Milliseconds 300
    $activeHandle = [FamilyHistorySubscriptionMouse]::GetAncestor([FamilyHistorySubscriptionMouse]::GetForegroundWindow(), 3)
  }
  if ($activeHandle -ne $WindowHandle) {
    [FamilyHistorySubscriptionMouse]::ActivateExactWindow($WindowHandle) | Out-Null
    Start-Sleep -Milliseconds 300
    $activeHandle = [FamilyHistorySubscriptionMouse]::GetAncestor([FamilyHistorySubscriptionMouse]::GetForegroundWindow(), 3)
  }
  return $activeHandle -eq $WindowHandle
}

function Close-VerifiedBlankSubscriptionTab {
  param(
    [Parameter(Mandatory = $true)]
    [IntPtr]$WindowHandle,

    [Parameter(Mandatory = $true)]
    [int]$ProcessId,

    [string]$TabRuntimeId
  )

  if (-not $TabRuntimeId) { return $false }
  if (-not (Set-SubscriptionWindowForeground -WindowHandle $WindowHandle -ProcessId $ProcessId)) { return $false }
  if ((Get-SelectedSubscriptionTabRuntimeId -WindowHandle $WindowHandle) -ne $TabRuntimeId) { return $false }
  $currentUri = Get-SubscriptionAddressBarUri -WindowHandle $WindowHandle
  if (-not (Test-SubscriptionBlankUri -Uri $currentUri)) { return $false }
  [System.Windows.Forms.SendKeys]::SendWait('^w')
  return $true
}

function Wait-SubscriptionNavigation {
  param(
    [Parameter(Mandatory = $true)]
    [IntPtr]$WindowHandle,

    [Parameter(Mandatory = $true)]
    [ValidateSet('ancestry', 'findmypast')]
    [string]$ProviderName,

    [string]$PreviousFingerprint = '',

    [bool]$RequireChanged = $false,

    [string]$ExpectedHost = '',

    # Collection-result pages can take longer than a simple record page to
    # settle their canonical query URL. Waiting a little longer keeps the
    # verified blank-tab handoff intact instead of abandoning a valid load.
    [int]$TimeoutSeconds = 30
  )

  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  $lastFingerprint = ''
  $stableSamples = 0
  do {
    Start-Sleep -Milliseconds 250
    $currentUri = Get-SubscriptionAddressBarUri -WindowHandle $WindowHandle
    if ((Test-SubscriptionProviderUri -Uri $currentUri -ProviderName $ProviderName) -and
      (-not $ExpectedHost -or
        (Get-CanonicalSubscriptionHost -HostName $currentUri.Host) -eq
          (Get-CanonicalSubscriptionHost -HostName $ExpectedHost))) {
      $currentFingerprint = Get-SubscriptionUrlFingerprint -Uri $currentUri
      if (-not $RequireChanged -or $currentFingerprint -ne $PreviousFingerprint) {
        if ($currentFingerprint -eq $lastFingerprint) {
          $stableSamples++
        } else {
          $lastFingerprint = $currentFingerprint
          $stableSamples = 1
        }
        # Provider search pages can rewrite their canonical query URL after the
        # first paint. Require three seconds of an unchanged allowlisted URL so
        # the affinity cannot become stale immediately after a successful open.
        if ($stableSamples -ge 12) {
          return [pscustomobject]@{
            host = Get-CanonicalSubscriptionHost -HostName $currentUri.Host
            fingerprint = $currentFingerprint
          }
        }
      }
    }
  } while ([DateTime]::UtcNow -lt $deadline)
  return $null
}

function Write-SubscriptionAffinity {
  param(
    [Parameter(Mandatory = $true)]
    [IntPtr]$WindowHandle,

    [Parameter(Mandatory = $true)]
    [int]$ProcessId,

    [Parameter(Mandatory = $true)]
    [ValidateSet('ancestry', 'findmypast')]
    [string]$ProviderName,

    [Parameter(Mandatory = $true)]
    [Uri]$RequestedUri,

    [Parameter(Mandatory = $true)]
    [pscustomobject]$ObservedNavigation
  )

  $tabRuntimeId = Get-SelectedSubscriptionTabRuntimeId -WindowHandle $WindowHandle
  if (-not $tabRuntimeId) {
    throw "The selected subscription tab runtime identity could not be recorded."
  }

  [pscustomobject]@{
    schemaVersion = 3
    provider = $ProviderName
    host = $ObservedNavigation.host
    windowHandle = $WindowHandle.ToInt64()
    processId = $ProcessId
    tabRuntimeId = $tabRuntimeId
    requestedUrlFingerprint = Get-SubscriptionUrlFingerprint -Uri $RequestedUri
    activeUrlFingerprint = $ObservedNavigation.fingerprint
    writtenAt = [DateTime]::UtcNow.ToString('o')
  } | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $affinityPath -Encoding UTF8
}

if ($Mode -eq "open") {
  Remove-Item -LiteralPath $viewerCandidatePath -ErrorAction SilentlyContinue
  # Intentionally uses the user's existing Chrome profile, so its normal saved
  # session/password-manager behavior remains in Windows Chrome. This wrapper
  # never reads, copies, types, or logs credentials, cookies, or account state.
  # Reuse one visible subscription window and create the controlled tab through
  # that exact window. Handing a bare URL to an already-running Chrome instance
  # lets Chrome choose a different window, while Ctrl+9 can then select an older
  # rightmost tab. That race caused later inspection to read the wrong record.
  # Ctrl+T followed immediately by setting the omnibox navigates the tab we own;
  # it does not leave an orphaned about:blank tab and never closes user tabs.
  $focusWindow = Get-SharedSubscriptionWindow
  if ($focusWindow) {
    try {
      $focusRoot = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$focusWindow.MainWindowHandle)
      $focusTabCount = @($focusRoot.FindAll(
          [System.Windows.Automation.TreeScope]::Descendants,
          [System.Windows.Automation.Condition]::TrueCondition
        ) | Where-Object {
          $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::TabItem
        }).Count
    } catch {
      throw "The shared subscription Chrome window could not be inspected safely; no tab was opened."
    }
    $reusableAffinityTab = Get-ReusableSubscriptionAffinityTab -SharedWindow $focusWindow
    if ($reusableAffinityTab) {
      $reusedHandle = [IntPtr]$focusWindow.MainWindowHandle
      try {
        [System.Windows.Forms.SendKeys]::SendWait('^l')
        Start-Sleep -Milliseconds 300
        $reusedRoot = [System.Windows.Automation.AutomationElement]::FromHandle($reusedHandle)
        $reusedAddress = $reusedRoot.FindAll(
            [System.Windows.Automation.TreeScope]::Descendants,
            [System.Windows.Automation.Condition]::TrueCondition
          ) | Where-Object {
            $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit -and
            $_.Current.Name -eq 'Address and search bar'
          } | Select-Object -First 1
        if (-not $reusedAddress) {
          throw "Windows Chrome exposed no address bar for the reusable subscription tab."
        }
        $reusedValue = $reusedAddress.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
        ([System.Windows.Automation.ValuePattern]$reusedValue).SetValue($target.AbsoluteUri)
        [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
        $reusedNavigation = Wait-SubscriptionNavigation -WindowHandle $reusedHandle -ProviderName $effectiveProvider -PreviousFingerprint ([string]$reusableAffinityTab.Affinity.activeUrlFingerprint) -RequireChanged $false -ExpectedHost $target.Host.ToLowerInvariant()
        if (-not $reusedNavigation -or
          (Get-SelectedSubscriptionTabRuntimeId -WindowHandle $reusedHandle) -ne [string]$reusableAffinityTab.TabRuntimeId) {
          throw "The reusable subscription tab did not finish the requested navigation with its identity intact."
        }
        Write-SubscriptionAffinity -WindowHandle $reusedHandle -ProcessId ([int]$focusWindow.Id) -ProviderName $effectiveProvider -RequestedUri $target -ObservedNavigation $reusedNavigation
      } catch {
        Remove-Item -LiteralPath $affinityPath -ErrorAction SilentlyContinue
        throw
      }
      Write-Host "Reused this task's existing tab in the shared Windows Chrome subscription window."
      Write-Host "Only the allowlisted omnibox URL was verified; no credentials, cookies, account fields, screenshots, downloads, or record images were read or written."
      return
    }
    if ($focusTabCount -ge 52) {
      throw "The shared subscription Chrome window already exposes $focusTabCount tabs; no extra window was opened. Close unneeded tabs in that one window before retrying."
    }
  }

  if ($focusWindow) {
    $controlledHandle = [IntPtr]$focusWindow.MainWindowHandle
    $controlledProcessId = [int]$focusWindow.Id
    if (-not (Set-SubscriptionWindowForeground -WindowHandle $controlledHandle -ProcessId $controlledProcessId)) {
      throw "The selected subscription Chrome window could not be activated safely."
    }
    $beforeOpenTabRuntimeIds = @(Get-SubscriptionTabRuntimeIds -WindowHandle $controlledHandle)
    [System.Windows.Forms.SendKeys]::SendWait('^t')
    $controlledTabRuntimeId = $null
    $createdTabRuntimeIds = @()
    $createdTabTitles = @()
    $newTabDeadline = [DateTime]::UtcNow.AddSeconds(4)
    do {
      Start-Sleep -Milliseconds 250
      $controlledTabRuntimeId = Get-SelectedSubscriptionTabRuntimeId -WindowHandle $controlledHandle
    } while (-not $controlledTabRuntimeId -and [DateTime]::UtcNow -lt $newTabDeadline)
    if (-not $controlledTabRuntimeId) {
      $afterOpenTabRuntimeIds = @(Get-SubscriptionTabRuntimeIds -WindowHandle $controlledHandle)
      $createdTabRuntimeIds = @($afterOpenTabRuntimeIds | Where-Object { $_ -notin $beforeOpenTabRuntimeIds })
      $createdTabTitles = @($createdTabRuntimeIds | ForEach-Object {
        $created = Get-SubscriptionTabByRuntimeId -WindowHandle $controlledHandle -RuntimeId $_
        if ($created) { ([string]$created.Current.Name -replace '[\r\n]', ' ').Substring(0, [Math]::Min(120, ([string]$created.Current.Name).Length)) }
      })
      if ($createdTabRuntimeIds.Count -eq 1) {
        $createdTab = Get-SubscriptionTabByRuntimeId -WindowHandle $controlledHandle -RuntimeId $createdTabRuntimeIds[0]
        if ($createdTab -and $createdTab.Current.Name -match '^New Tab(?: - Google Chrome)?$') {
          try {
            $createdSelection = $createdTab.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
            ([System.Windows.Automation.SelectionItemPattern]$createdSelection).Select()
            Start-Sleep -Milliseconds 500
            $controlledTabRuntimeId = Get-SelectedSubscriptionTabRuntimeId -WindowHandle $controlledHandle
          } catch {}
        }
      }
    }
    if (-not $controlledTabRuntimeId) {
      throw "Chrome new-tab identity was not verifiable (before=$($beforeOpenTabRuntimeIds.Count), created=$($createdTabRuntimeIds.Count), createdTitles=$($createdTabTitles -join ' | ')); no navigation was attempted."
    }
    if ($controlledTabRuntimeId -in $beforeOpenTabRuntimeIds) {
      throw "Chrome did not select a uniquely new controlled tab; no navigation was attempted."
    }
    $foregroundAfterNewTab = [FamilyHistorySubscriptionMouse]::GetAncestor([FamilyHistorySubscriptionMouse]::GetForegroundWindow(), 3)
    if ($foregroundAfterNewTab -ne $controlledHandle) {
      Close-VerifiedBlankSubscriptionTab -WindowHandle $controlledHandle -ProcessId $controlledProcessId -TabRuntimeId $controlledTabRuntimeId | Out-Null
      throw "The new subscription tab did not remain in the selected Chrome window."
    }
    $controlledProcess = Get-Process -Id $controlledProcessId -ErrorAction SilentlyContinue
    if (-not $controlledProcess -or $controlledProcess.Name -ne 'chrome') {
      Close-VerifiedBlankSubscriptionTab -WindowHandle $controlledHandle -ProcessId $controlledProcessId -TabRuntimeId $controlledTabRuntimeId | Out-Null
      throw "The controlled subscription tab did not remain in the foreground Chrome window."
    }
    $newTabUri = Get-SubscriptionAddressBarUri -WindowHandle $controlledHandle
    $controlledTabElement = Get-SubscriptionTabByRuntimeId -WindowHandle $controlledHandle -RuntimeId $controlledTabRuntimeId
    $newTabStateVerified = (Test-SubscriptionBlankUri -Uri $newTabUri) -or
      (-not $newTabUri -and $controlledTabElement -and $controlledTabElement.Current.Name -match '^New Tab(?: - Google Chrome)?$')
    if (-not $newTabStateVerified) {
      for ($blankCheck = 0; $blankCheck -lt 4 -and -not $newTabStateVerified; $blankCheck++) {
        Start-Sleep -Milliseconds 250
        $newTabUri = Get-SubscriptionAddressBarUri -WindowHandle $controlledHandle
        $controlledTabElement = Get-SubscriptionTabByRuntimeId -WindowHandle $controlledHandle -RuntimeId $controlledTabRuntimeId
        $newTabStateVerified = (Test-SubscriptionBlankUri -Uri $newTabUri) -or
          (-not $newTabUri -and $controlledTabElement -and $controlledTabElement.Current.Name -match '^New Tab(?: - Google Chrome)?$')
      }
      if ($newTabStateVerified) {
        Close-VerifiedBlankSubscriptionTab -WindowHandle $controlledHandle -ProcessId $controlledProcessId -TabRuntimeId $controlledTabRuntimeId | Out-Null
      }
      throw "The new Chrome tab did not expose a verified blank/new-tab URL; no navigation was attempted."
    }
    try {
      [System.Windows.Forms.SendKeys]::SendWait('^l')
      Start-Sleep -Milliseconds 300
      $openRoot = [System.Windows.Automation.AutomationElement]::FromHandle($controlledHandle)
      $address = $openRoot.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition) |
        Where-Object {
          $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit -and
          $_.Current.Name -eq 'Address and search bar'
        } | Select-Object -First 1
      if (-not $address) {
        throw "Windows Chrome exposed no address bar for the controlled subscription tab."
      }
      $value = $address.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
      ([System.Windows.Automation.ValuePattern]$value).SetValue($target.AbsoluteUri)
      [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
      $observedNavigation = Wait-SubscriptionNavigation -WindowHandle $controlledHandle -ProviderName $effectiveProvider -ExpectedHost $target.Host.ToLowerInvariant()
      if (-not $observedNavigation) {
        throw "The controlled subscription tab did not finish navigating to the requested provider."
      }
      Write-SubscriptionAffinity -WindowHandle $controlledHandle -ProcessId $controlledProcessId -ProviderName $effectiveProvider -RequestedUri $target -ObservedNavigation $observedNavigation
    } catch {
      Close-VerifiedBlankSubscriptionTab -WindowHandle $controlledHandle -ProcessId $controlledProcessId -TabRuntimeId $controlledTabRuntimeId | Out-Null
      throw
    }
    Write-Host "Opened the requested record in a new, active tab of the selected Windows Chrome subscription window."
    Write-Host "Only the allowlisted omnibox URL was verified; no credentials, cookies, account fields, screenshots, downloads, or record images were read or written."
    return
  }

  throw "No existing shared Chrome window contains an Ancestry or Findmypast tab; no new Chrome window was launched. Open one provider tab in the window you want all agents to share, then retry."
}

if ($Mode -eq 'adopt-search') {
  $targetPathAllowed = if ($effectiveProvider -eq 'findmypast') {
    $target.AbsolutePath -eq '/search/results'
  } else {
    $target.AbsolutePath -match '^/search(?:/collections/\d+)?/?$'
  }
  if (-not $targetPathAllowed) {
    throw "adopt-search requires an exact allowlisted provider search-results URL."
  }
  $expectedFindmypastTitle = $null
  if ($effectiveProvider -eq 'findmypast') {
    foreach ($rawPart in ($target.Query.TrimStart('?') -split '&')) {
      if (-not $rawPart) { continue }
      $pair = $rawPart -split '=', 2
      $key = [Uri]::UnescapeDataString(($pair[0] -replace '\+', ' ')).ToLowerInvariant()
      if ($key -eq 'datasetname' -and $pair.Count -gt 1) {
        $expectedFindmypastTitle = [Uri]::UnescapeDataString(($pair[1] -replace '\+', ' '))
        break
      }
    }
  }
  $targetFingerprint = Get-SubscriptionUrlFingerprint -Uri $target
  $matchingSearches = @()
  $eligibleSearchUris = @()
  foreach ($searchWindowHandleValue in @(Get-ChromeTopLevelWindowHandles)) {
    $searchWindowHandle = [FamilyHistorySubscriptionMouse]::GetAncestor(
      [IntPtr][int64]$searchWindowHandleValue,
      3
    )
    [uint32]$searchProcessId = 0
    [FamilyHistorySubscriptionMouse]::GetWindowThreadProcessId($searchWindowHandle, [ref]$searchProcessId) | Out-Null
    $searchProcess = Get-Process -Id $searchProcessId -ErrorAction SilentlyContinue
    if (-not $searchProcess -or $searchProcess.Name -ne 'chrome') { continue }
    try {
      $searchRoot = [System.Windows.Automation.AutomationElement]::FromHandle($searchWindowHandle)
      $searchTabs = @($searchRoot.FindAll(
          [System.Windows.Automation.TreeScope]::Descendants,
          [System.Windows.Automation.Condition]::TrueCondition
        ) | Where-Object {
          if ($_.Current.ControlType -ne [System.Windows.Automation.ControlType]::TabItem) { return $false }
          $baseTitle = ([string]$_.Current.Name) -replace ' - Memory usage - \d+ MB$', ''
          if ($effectiveProvider -eq 'findmypast') {
            $baseTitle -match '^Search Results for [^|]+ \| findmypast\.(com|co\.uk)$' -and
              (-not $expectedFindmypastTitle -or
                $baseTitle -match ('^Search Results for ' + [Regex]::Escape($expectedFindmypastTitle) + ' \|'))
          } else {
            $baseTitle -match ' - Ancestry\.com$'
          }
        })
      foreach ($searchTab in $searchTabs) {
        $searchRuntimeId = (($searchTab.GetRuntimeId()) -join ':')
        $searchSelection = $searchTab.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
        ([System.Windows.Automation.SelectionItemPattern]$searchSelection).Select()
        Start-Sleep -Milliseconds 250
        if (-not (Set-SubscriptionWindowForeground -WindowHandle $searchWindowHandle -ProcessId $searchProcessId) -or
          (Get-SelectedSubscriptionTabRuntimeId -WindowHandle $searchWindowHandle) -ne $searchRuntimeId) {
          continue
        }
        $searchUri = Get-SubscriptionAddressBarUri -WindowHandle $searchWindowHandle
        $searchPathAllowed = if ($effectiveProvider -eq 'findmypast') {
          $searchUri -and $searchUri.AbsolutePath -eq '/search/results'
        } else {
          $searchUri -and $searchUri.AbsolutePath -match '^/search(?:/collections/\d+)?/?$'
        }
        if (-not $searchPathAllowed -or
          -not (Test-SubscriptionProviderUri -Uri $searchUri -ProviderName $effectiveProvider)) {
          continue
        }
        $eligibleSearchUris += $searchUri.AbsoluteUri
        if ((Get-SubscriptionUrlFingerprint -Uri $searchUri) -ne $targetFingerprint) { continue }
        $matchingSearches += [pscustomobject]@{
          windowHandle = $searchWindowHandle.ToInt64()
          processId = [int]$searchProcessId
          tabRuntimeId = $searchRuntimeId
          uri = $searchUri.AbsoluteUri
        }
      }
    } catch {}
  }
  if ($matchingSearches.Count -eq 0) {
    if ($eligibleSearchUris.Count -gt 0) {
      Write-Host "Observed eligible provider search URLs: $($eligibleSearchUris -join ' | ')"
    }
    throw "Exact search-tab recovery found no matching tab."
  }
  if ($matchingSearches.Count -gt 1) {
    Write-Host "Found $($matchingSearches.Count) exact duplicate provider search tabs; adopting one without closing or changing the others."
  }
  $matchingSearch = $matchingSearches[0]
  $matchingHandle = [IntPtr][int64]$matchingSearch.windowHandle
  $matchingTab = Get-SubscriptionTabByRuntimeId -WindowHandle $matchingHandle -RuntimeId ([string]$matchingSearch.tabRuntimeId)
  if (-not $matchingTab) {
    throw "The uniquely matched provider search tab disappeared before adoption."
  }
  $matchingSelection = $matchingTab.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
  ([System.Windows.Automation.SelectionItemPattern]$matchingSelection).Select()
  Start-Sleep -Milliseconds 350
  if (-not (Set-SubscriptionWindowForeground -WindowHandle $matchingHandle -ProcessId ([int]$matchingSearch.processId)) -or
    (Get-SelectedSubscriptionTabRuntimeId -WindowHandle $matchingHandle) -ne [string]$matchingSearch.tabRuntimeId) {
    throw "The uniquely matched provider search tab could not be selected for adoption."
  }
  $matchingUri = Get-SubscriptionAddressBarUri -WindowHandle $matchingHandle
  if (-not (Test-SubscriptionProviderUri -Uri $matchingUri -ProviderName $effectiveProvider) -or
    (Get-SubscriptionUrlFingerprint -Uri $matchingUri) -ne $targetFingerprint) {
    throw "The uniquely matched provider search URL changed before adoption."
  }
  $matchingObserved = [pscustomobject]@{
    host = Get-CanonicalSubscriptionHost -HostName $matchingUri.Host
    fingerprint = $targetFingerprint
  }
  Write-SubscriptionAffinity -WindowHandle $matchingHandle -ProcessId ([int]$matchingSearch.processId) -ProviderName $effectiveProvider -RequestedUri $matchingUri -ObservedNavigation $matchingObserved
  Write-Host "Adopted the one exact provider search tab: $($matchingUri.AbsoluteUri)"
  return
}

if ($Mode -eq 'adopt-transcription') {
  # Allowlisted transcription adoptions and the page text each must show
  # (tree/transcription-gates.json: { "<target id>": ["text", ...] }).
  $transcriptionGatesByTarget = @{}
  $gatesFile = Join-Path (Split-Path $PSScriptRoot -Parent) 'tree\transcription-gates.json'
  if (Test-Path -LiteralPath $gatesFile) {
    $gates = Get-Content -LiteralPath $gatesFile -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($property in $gates.PSObject.Properties) {
      if ($property.Name -ne 'note') { $transcriptionGatesByTarget[$property.Name] = @($property.Value | ForEach-Object { [string]$_ }) }
    }
  }
  if ($effectiveProvider -ne 'findmypast' -or -not $TargetId -or
    -not $transcriptionGatesByTarget.ContainsKey($TargetId)) {
    throw "adopt-transcription requires an allowlisted exact Findmypast recovery target id."
  }
  $queuePath = Join-Path (Split-Path $PSScriptRoot -Parent) 'evidence\subscription-records-queue.json'
  $queue = Get-Content -LiteralPath $queuePath -Raw | ConvertFrom-Json
  $boundTargets = @($queue.targets | Where-Object {
    [string]$_.id -eq $TargetId -and
    [string]$_.provider -eq 'Findmypast' -and
    [string]$_.status -in @('pending-subscription', 'acquired')
  })
  if ($boundTargets.Count -ne 1) {
    throw "The transcription recovery target is not unique and eligible in the subscription queue."
  }
  $requiredVisibleText = @($transcriptionGatesByTarget[$TargetId])
  $matchingTranscriptions = @()
  foreach ($transcriptionWindowHandleValue in @(Get-ChromeTopLevelWindowHandles)) {
    $transcriptionWindowHandle = [FamilyHistorySubscriptionMouse]::GetAncestor(
      [IntPtr][int64]$transcriptionWindowHandleValue,
      3
    )
    [uint32]$transcriptionProcessId = 0
    [FamilyHistorySubscriptionMouse]::GetWindowThreadProcessId($transcriptionWindowHandle, [ref]$transcriptionProcessId) | Out-Null
    $transcriptionProcess = Get-Process -Id $transcriptionProcessId -ErrorAction SilentlyContinue
    if (-not $transcriptionProcess -or $transcriptionProcess.Name -ne 'chrome') { continue }
    $transcriptionRoot = [System.Windows.Automation.AutomationElement]::FromHandle($transcriptionWindowHandle)
    $transcriptionTabs = @($transcriptionRoot.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition
      ) | Where-Object {
        $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::TabItem -and
        (([string]$_.Current.Name) -replace ' - Memory usage - \d+ MB$', '') -match
          '^Record Transcription: [^|]+ \| findmypast\.(com|co\.uk)$'
      })
    foreach ($transcriptionTab in $transcriptionTabs) {
      $transcriptionRuntimeId = (($transcriptionTab.GetRuntimeId()) -join ':')
      try {
        $selection = $transcriptionTab.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
        ([System.Windows.Automation.SelectionItemPattern]$selection).Select()
        Start-Sleep -Milliseconds 250
        if (-not (Set-SubscriptionWindowForeground -WindowHandle $transcriptionWindowHandle -ProcessId $transcriptionProcessId) -or
          (Get-SelectedSubscriptionTabRuntimeId -WindowHandle $transcriptionWindowHandle) -ne $transcriptionRuntimeId) {
          continue
        }
        $transcriptionUri = Get-SubscriptionAddressBarUri -WindowHandle $transcriptionWindowHandle
        if (-not (Test-SubscriptionProviderUri -Uri $transcriptionUri -ProviderName 'findmypast') -or
          $transcriptionUri.AbsolutePath -notmatch '^/(?:record|transcript)(?:/|$)') {
          continue
        }
        $activeTranscriptionRoot = [System.Windows.Automation.AutomationElement]::FromHandle($transcriptionWindowHandle)
        $visibleText = (($activeTranscriptionRoot.FindAll(
              [System.Windows.Automation.TreeScope]::Descendants,
              [System.Windows.Automation.Condition]::TrueCondition
            ) | ForEach-Object { [string]$_.Current.Name }) -join ' ') -replace '\s+', ' '
        $contentMatches = $true
        foreach ($requiredText in $requiredVisibleText) {
          if ($visibleText.IndexOf($requiredText, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
            $contentMatches = $false
            break
          }
        }
        if ($contentMatches) {
          $matchingTranscriptions += [pscustomobject]@{
            windowHandle = $transcriptionWindowHandle.ToInt64()
            processId = [int]$transcriptionProcessId
            tabRuntimeId = $transcriptionRuntimeId
            uri = $transcriptionUri.AbsoluteUri
          }
        }
      } catch {}
    }
  }
  if ($matchingTranscriptions.Count -ne 1) {
    throw "Target-aware transcription recovery found $($matchingTranscriptions.Count) matching tabs; exactly one is required."
  }
  $matchingTranscription = $matchingTranscriptions[0]
  $matchingHandle = [IntPtr][int64]$matchingTranscription.windowHandle
  $matchingTab = Get-SubscriptionTabByRuntimeId -WindowHandle $matchingHandle -RuntimeId ([string]$matchingTranscription.tabRuntimeId)
  if (-not $matchingTab) {
    throw "The uniquely matched transcription tab disappeared before adoption."
  }
  $matchingSelection = $matchingTab.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
  ([System.Windows.Automation.SelectionItemPattern]$matchingSelection).Select()
  Start-Sleep -Milliseconds 350
  if (-not (Set-SubscriptionWindowForeground -WindowHandle $matchingHandle -ProcessId ([int]$matchingTranscription.processId)) -or
    (Get-SelectedSubscriptionTabRuntimeId -WindowHandle $matchingHandle) -ne [string]$matchingTranscription.tabRuntimeId) {
    throw "The uniquely matched transcription tab could not be selected for adoption."
  }
  $matchingUri = Get-SubscriptionAddressBarUri -WindowHandle $matchingHandle
  if (-not (Test-SubscriptionProviderUri -Uri $matchingUri -ProviderName 'findmypast') -or
    $matchingUri.AbsolutePath -notmatch '^/(?:record|transcript)(?:/|$)' -or
    (Get-SubscriptionUrlFingerprint -Uri $matchingUri) -ne
      (Get-SubscriptionUrlFingerprint -Uri ([Uri][string]$matchingTranscription.uri))) {
    throw "The uniquely matched transcription URL changed before adoption."
  }
  $matchingObserved = [pscustomobject]@{
    host = Get-CanonicalSubscriptionHost -HostName $matchingUri.Host
    fingerprint = Get-SubscriptionUrlFingerprint -Uri $matchingUri
  }
  Write-SubscriptionAffinity -WindowHandle $matchingHandle -ProcessId ([int]$matchingTranscription.processId) -ProviderName 'findmypast' -RequestedUri $matchingUri -ObservedNavigation $matchingObserved
  Write-Host "Adopted the one target-matching Findmypast transcription tab: $($matchingUri.AbsoluteUri)"
  return
}

if ($Mode -eq 'recover-record') {
  if (-not $ExpectedTabTitle -or $ExpectedTabTitle.Length -gt 240 -or $ExpectedTabTitle -match '[\r\n]' -or
    $effectiveProvider -ne 'findmypast' -or
    $ExpectedTabTitle -notmatch '^Record Transcription: [^|]+ \| findmypast\.(com|co\.uk)(?: - Memory usage - \d+ MB)?$') {
    throw "recover-record requires the exact allowlisted Findmypast transcription-tab title."
  }
  if (-not (Test-Path -LiteralPath $affinityPath)) {
    throw "No previously controlled subscription tab is recorded for recovery."
  }
  try {
    $recoveryAffinity = Get-Content -LiteralPath $affinityPath -Raw | ConvertFrom-Json
  } catch {
    throw "The previous controlled subscription-tab record could not be read safely."
  }
  if ([int]$recoveryAffinity.schemaVersion -ne 3 -or
    [string]$recoveryAffinity.provider -ne $effectiveProvider -or
    [int64]$recoveryAffinity.windowHandle -le 0 -or
    [int]$recoveryAffinity.processId -le 0 -or
    -not [string]$recoveryAffinity.tabRuntimeId) {
    throw "The previous controlled subscription-tab record is not eligible for recovery."
  }
  $recoveryHandle = [FamilyHistorySubscriptionMouse]::GetAncestor(
    [IntPtr][int64]$recoveryAffinity.windowHandle,
    3
  )
  [uint32]$recoveryProcessId = 0
  [FamilyHistorySubscriptionMouse]::GetWindowThreadProcessId($recoveryHandle, [ref]$recoveryProcessId) | Out-Null
  $recoveryProcess = Get-Process -Id $recoveryProcessId -ErrorAction SilentlyContinue
  if (-not $recoveryProcess -or $recoveryProcess.Name -ne 'chrome' -or
    [int]$recoveryAffinity.processId -ne [int]$recoveryProcessId) {
    throw "The exact previously controlled Chrome window is no longer available."
  }
  $recoveryTab = Get-SubscriptionTabByRuntimeId -WindowHandle $recoveryHandle -RuntimeId ([string]$recoveryAffinity.tabRuntimeId)
  if (-not $recoveryTab) {
    throw "The exact previously controlled tab no longer exists."
  }
  $expectedRecoveryBaseTitle = $ExpectedTabTitle -replace ' - Memory usage - \d+ MB$', ''
  $currentRecoveryBaseTitle = ([string]$recoveryTab.Current.Name) -replace ' - Memory usage - \d+ MB$', ''
  if ($currentRecoveryBaseTitle -ne $expectedRecoveryBaseTitle) {
    throw "The exact previously controlled tab does not have the expected transcription title."
  }
  try {
    $recoverySelection = $recoveryTab.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
    ([System.Windows.Automation.SelectionItemPattern]$recoverySelection).Select()
  } catch {
    throw "The exact previously controlled transcription tab could not be selected."
  }
  Start-Sleep -Milliseconds 350
  if (-not (Set-SubscriptionWindowForeground -WindowHandle $recoveryHandle -ProcessId $recoveryProcessId) -or
    (Get-SelectedSubscriptionTabRuntimeId -WindowHandle $recoveryHandle) -ne [string]$recoveryAffinity.tabRuntimeId) {
    throw "The exact previously controlled transcription tab could not be reverified."
  }
  $recoveryUri = Get-SubscriptionAddressBarUri -WindowHandle $recoveryHandle
  if (-not (Test-SubscriptionProviderUri -Uri $recoveryUri -ProviderName $effectiveProvider) -or
    $recoveryUri.AbsolutePath -notmatch '^/(?:record|transcript)(?:/|$)') {
    throw "The recovered tab does not expose an allowlisted Findmypast record/transcription URL."
  }
  $recoveryFingerprint = Get-SubscriptionUrlFingerprint -Uri $recoveryUri
  Start-Sleep -Seconds 1
  if (-not (Set-SubscriptionWindowForeground -WindowHandle $recoveryHandle -ProcessId $recoveryProcessId) -or
    (Get-SelectedSubscriptionTabRuntimeId -WindowHandle $recoveryHandle) -ne [string]$recoveryAffinity.tabRuntimeId) {
    throw "The recovered Findmypast transcription tab lost its exact identity during verification."
  }
  $recheckedRecoveryUri = Get-SubscriptionAddressBarUri -WindowHandle $recoveryHandle
  if (-not (Test-SubscriptionProviderUri -Uri $recheckedRecoveryUri -ProviderName $effectiveProvider) -or
    $recheckedRecoveryUri.AbsolutePath -notmatch '^/(?:record|transcript)(?:/|$)' -or
    (Get-SubscriptionUrlFingerprint -Uri $recheckedRecoveryUri) -ne $recoveryFingerprint) {
    throw "The recovered Findmypast transcription URL did not remain stable."
  }
  $observedRecovery = [pscustomobject]@{
    host = Get-CanonicalSubscriptionHost -HostName $recheckedRecoveryUri.Host
    fingerprint = $recoveryFingerprint
  }
  $recoveryUri = $recheckedRecoveryUri
  Write-SubscriptionAffinity -WindowHandle $recoveryHandle -ProcessId $recoveryProcessId -ProviderName $effectiveProvider -RequestedUri $recoveryUri -ObservedNavigation $observedRecovery
  Write-Host "Recovered the exact previously controlled Findmypast transcription tab: $($recoveryUri.AbsoluteUri)"
  return
}

if ($Mode -eq 'recover-ancestry-record') {
  if (-not $ExpectedTabTitle -or $ExpectedTabTitle.Length -gt 240 -or $ExpectedTabTitle -match '[\r\n]' -or
    $effectiveProvider -ne 'ancestry' -or
    $ExpectedTabTitle -notmatch '^(?:[^-].+ - Ancestry\.com|Ancestry\.com - .+?)(?: - Memory usage - \d+ MB)?$') {
    throw "recover-ancestry-record requires the exact allowlisted Ancestry record-tab title."
  }

  $expectedBaseTitle = $ExpectedTabTitle -replace ' - Memory usage - \d+ MB$', ''
  $matchingRecords = @()
  foreach ($recordWindowHandleValue in @(Get-ChromeTopLevelWindowHandles)) {
    $recordWindowHandle = [FamilyHistorySubscriptionMouse]::GetAncestor([IntPtr][int64]$recordWindowHandleValue, 3)
    [uint32]$recordProcessId = 0
    [FamilyHistorySubscriptionMouse]::GetWindowThreadProcessId($recordWindowHandle, [ref]$recordProcessId) | Out-Null
    $recordProcess = Get-Process -Id $recordProcessId -ErrorAction SilentlyContinue
    if (-not $recordProcess -or $recordProcess.Name -ne 'chrome') { continue }
    try {
      $recordRoot = [System.Windows.Automation.AutomationElement]::FromHandle($recordWindowHandle)
      foreach ($recordTab in @($recordRoot.FindAll(
          [System.Windows.Automation.TreeScope]::Descendants,
          [System.Windows.Automation.Condition]::TrueCondition
        ) | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::TabItem })) {
        $recordBaseTitle = ([string]$recordTab.Current.Name) -replace ' - Memory usage - \d+ MB$', ''
        if ($recordBaseTitle -eq $expectedBaseTitle) {
          $recordIsSelected = $false
          try {
            $recordSelection = $recordTab.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
            $recordIsSelected = ([System.Windows.Automation.SelectionItemPattern]$recordSelection).Current.IsSelected
          } catch {}
          $recordWindowBaseTitle = ([string]$recordRoot.Current.Name) -replace ' - Google Chrome$', '' -replace ' - Memory usage - \d+ MB$', ''
          $matchingRecords += [pscustomobject]@{
            windowHandle = $recordWindowHandle.ToInt64()
            processId = [int]$recordProcessId
            tabRuntimeId = (($recordTab.GetRuntimeId()) -join ':')
            isSelected = [bool]$recordIsSelected
            isMainWindow = ([int64]$recordProcess.MainWindowHandle -eq $recordWindowHandle.ToInt64())
            hasExpectedWindowTitle = ($recordWindowBaseTitle -eq $expectedBaseTitle)
            windowTitle = $recordWindowBaseTitle
          }
        }
      }
    } catch {}
  }
  $matchSummary = @($matchingRecords | ForEach-Object {
    "window=$($_.windowTitle);selected=$($_.isSelected);main=$($_.isMainWindow)"
  }) -join ' | '
  if ($matchingRecords.Count -gt 1) {
    $selectedRecords = @($matchingRecords | Where-Object { $_.isSelected })
    if ($selectedRecords.Count -gt 0) { $matchingRecords = $selectedRecords }
  }
  if ($matchingRecords.Count -gt 1) {
    $verifiedRecords = @()
    $candidateRoutes = @()
    foreach ($candidateRecord in @($matchingRecords | Sort-Object windowHandle)) {
      $candidateHandle = [IntPtr][int64]$candidateRecord.windowHandle
      if (-not (Set-SubscriptionWindowForeground -WindowHandle $candidateHandle -ProcessId ([int]$candidateRecord.processId)) -or
        (Get-SelectedSubscriptionTabRuntimeId -WindowHandle $candidateHandle) -ne [string]$candidateRecord.tabRuntimeId) {
        continue
      }
      $candidateUri = Get-SubscriptionAddressBarUri -WindowHandle $candidateHandle
      if ($candidateUri) { $candidateRoutes += "$($candidateUri.Scheme)://$($candidateUri.Host)$($candidateUri.AbsolutePath)" }
      if (-not (Test-SubscriptionProviderUri -Uri $candidateUri -ProviderName 'ancestry') -or
        $candidateUri.AbsolutePath -notmatch '^/(?:search/collections/\d+(?:/records/\d+)?/?|imageviewer/collections/\d+/images/[^/]+)$') {
        continue
      }
      $candidateRecord | Add-Member -NotePropertyName recordBindingKey -NotePropertyValue (Get-SubscriptionDownloadBindingKey -Uri $candidateUri)
      $verifiedRecords += $candidateRecord
    }
    $bindingKeys = @($verifiedRecords | Select-Object -ExpandProperty recordBindingKey -Unique)
    if ($verifiedRecords.Count -eq $matchingRecords.Count -and $bindingKeys.Count -eq 1) {
      $matchingRecords = @($verifiedRecords | Select-Object -First 1)
    }
    if ($matchingRecords.Count -gt 1 -and $candidateRoutes.Count -gt 0) {
      $matchSummary += ";routes=$(($candidateRoutes | Select-Object -Unique) -join ',')"
    }
  }
  if ($matchingRecords.Count -ne 1) {
    throw "Exact-title Ancestry recovery did not resolve to one selected matching tab (matches=$($matchingRecords.Count); observed=$matchSummary); no tab was adopted."
  }

  $matchingRecord = $matchingRecords[0]
  $matchingHandle = [IntPtr][int64]$matchingRecord.windowHandle
  $matchingTab = Get-SubscriptionTabByRuntimeId -WindowHandle $matchingHandle -RuntimeId ([string]$matchingRecord.tabRuntimeId)
  if (-not $matchingTab) { throw "The uniquely matched Ancestry record tab disappeared before adoption." }
  $matchingSelection = $matchingTab.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
  ([System.Windows.Automation.SelectionItemPattern]$matchingSelection).Select()
  Start-Sleep -Milliseconds 350
  if (-not (Set-SubscriptionWindowForeground -WindowHandle $matchingHandle -ProcessId ([int]$matchingRecord.processId))) {
    throw "The uniquely matched Ancestry record tab could not be selected for adoption."
  }
  $activeMatchingRoot = [System.Windows.Automation.AutomationElement]::FromHandle($matchingHandle)
  $activeMatchingTabs = @($activeMatchingRoot.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.Condition]::TrueCondition
    ) | Where-Object {
      $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::TabItem -and
      (([string]$_.Current.Name) -replace ' - Memory usage - \d+ MB$', '') -eq $expectedBaseTitle
    })
  $selectedMatchingTabs = @($activeMatchingTabs | Where-Object {
    try {
      $activeSelection = $_.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
      return ([System.Windows.Automation.SelectionItemPattern]$activeSelection).Current.IsSelected
    } catch { return $false }
  })
  if ($selectedMatchingTabs.Count -ne 1) {
    throw "The uniquely titled Ancestry tab was not the one selected after activation."
  }
  $matchingUri = Get-SubscriptionAddressBarUri -WindowHandle $matchingHandle
  if (-not (Test-SubscriptionProviderUri -Uri $matchingUri -ProviderName 'ancestry') -or
    $matchingUri.AbsolutePath -notmatch '^/(?:search/collections/\d+(?:/records/\d+)?/?|imageviewer/collections/\d+/images/[^/]+)$') {
    throw "The recovered Ancestry tab does not expose an allowlisted exact record URL."
  }
  $matchingFingerprint = Get-SubscriptionUrlFingerprint -Uri $matchingUri
  Start-Sleep -Milliseconds 750
  $confirmedMatchingUri = Get-SubscriptionAddressBarUri -WindowHandle $matchingHandle
  if (-not (Test-SubscriptionProviderUri -Uri $confirmedMatchingUri -ProviderName 'ancestry') -or
    (Get-SubscriptionUrlFingerprint -Uri $confirmedMatchingUri) -ne $matchingFingerprint) {
    throw "The recovered Ancestry record URL did not remain stable."
  }
  $matchingObserved = [pscustomobject]@{
    host = Get-CanonicalSubscriptionHost -HostName $confirmedMatchingUri.Host
    fingerprint = $matchingFingerprint
  }
  Write-SubscriptionAffinity -WindowHandle $matchingHandle -ProcessId ([int]$matchingRecord.processId) -ProviderName 'ancestry' -RequestedUri $matchingUri -ObservedNavigation $matchingObserved
  Write-Host "Adopted the one exact-title Ancestry record tab: $($matchingUri.AbsoluteUri)"
  return
}

$requestedFingerprint = Get-SubscriptionUrlFingerprint -Uri $target
if (-not (Test-Path -LiteralPath $affinityPath)) {
  throw "No controlled subscription tab is recorded; run open for the requested provider first."
}
try {
  $affinity = Get-Content -LiteralPath $affinityPath -Raw | ConvertFrom-Json
  if ($affinity.schemaVersion -ne 3 -or
    $affinity.provider -ne $effectiveProvider -or
    -not $affinity.activeUrlFingerprint -or
    -not $affinity.requestedUrlFingerprint -or
    -not $affinity.tabRuntimeId -or
    [int64]$affinity.windowHandle -le 0) {
    throw "The controlled subscription-tab record is stale; run open for the requested provider again."
  }
  $affinityHandle = [FamilyHistorySubscriptionMouse]::GetAncestor([IntPtr][int64]$affinity.windowHandle, 3)
  [uint32]$affinityProcessId = 0
  [FamilyHistorySubscriptionMouse]::GetWindowThreadProcessId($affinityHandle, [ref]$affinityProcessId) | Out-Null
  $affinityProcess = Get-Process -Id $affinityProcessId -ErrorAction SilentlyContinue
  if (-not $affinityProcess -or $affinityProcess.Name -ne 'chrome' -or
    [int]$affinity.processId -ne [int]$affinityProcessId -or
    -not (Set-SubscriptionWindowForeground -WindowHandle $affinityHandle -ProcessId $affinityProcessId)) {
    throw "The controlled subscription Chrome window is no longer available."
  }
  $selectedTabRuntimeId = Get-SelectedSubscriptionTabRuntimeId -WindowHandle $affinityHandle
  if ($selectedTabRuntimeId -ne [string]$affinity.tabRuntimeId) {
    $recordedTab = Get-SubscriptionTabByRuntimeId -WindowHandle $affinityHandle -RuntimeId ([string]$affinity.tabRuntimeId)
    if (-not $recordedTab) {
      throw "The recorded controlled subscription tab no longer exists in its Chrome window."
    }
    try {
      $recordedSelection = $recordedTab.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
      ([System.Windows.Automation.SelectionItemPattern]$recordedSelection).Select()
      Start-Sleep -Milliseconds 350
      if (-not (Set-SubscriptionWindowForeground -WindowHandle $affinityHandle -ProcessId $affinityProcessId) -or
        (Get-SelectedSubscriptionTabRuntimeId -WindowHandle $affinityHandle) -ne [string]$affinity.tabRuntimeId) {
        throw "The exact recorded controlled subscription tab could not be reselected."
      }
    } catch {
      if ($_.Exception.Message -eq "The exact recorded controlled subscription tab could not be reselected.") { throw }
      throw "The exact recorded controlled subscription tab could not be reselected."
    }
  }
  $currentUri = Get-SubscriptionAddressBarUri -WindowHandle $affinityHandle
  if (-not (Test-SubscriptionProviderUri -Uri $currentUri -ProviderName $effectiveProvider) -or
    (Get-CanonicalSubscriptionHost -HostName $currentUri.Host) -ne [string]$affinity.host -or
    (Get-SubscriptionUrlFingerprint -Uri $currentUri) -ne [string]$affinity.activeUrlFingerprint) {
    throw "The controlled subscription tab is no longer active in its recorded Chrome window."
  }
  if ($Mode -ne 'navigate' -and $requestedFingerprint -ne [string]$affinity.requestedUrlFingerprint) {
    throw "The requested operation does not match the recorded controlled subscription tab."
  }
  $window = [pscustomobject]@{
    Id = $affinityProcess.Id
    MainWindowHandle = $affinityHandle
    MainWindowTitle = ([System.Windows.Automation.AutomationElement]::FromHandle($affinityHandle)).Current.Name
  }
} catch {
  if ($_.Exception.Message -match '^(The|No) controlled subscription') { throw }
  throw "The controlled subscription-tab record could not be verified safely."
}
$root = [System.Windows.Automation.AutomationElement]::FromHandle($window.MainWindowHandle)
if ($Mode -eq "adopt-viewer") {
  if (-not $ExpectedTabTitle -or $ExpectedTabTitle.Length -gt 200 -or $ExpectedTabTitle -match '[\r\n]') {
    throw "-ExpectedTabTitle must be the expected visible provider viewer-tab title."
  }
  $expectedTitleAllowed = if ($effectiveProvider -eq 'findmypast') {
    $ExpectedTabTitle -match '^[^|]+ Image \| findmypast\.(com|co\.uk)(?: - Memory usage - \d+ MB)?$'
  } else {
    $ExpectedTabTitle -match '^[^-].+ - Ancestry\.com(?: - Memory usage - \d+ MB)?$'
  }
  if (-not $expectedTitleAllowed) {
    throw "The expected tab title is not an allowlisted provider image-viewer title."
  }
  if (-not (Test-Path -LiteralPath $viewerCandidatePath)) {
    throw "No newly opened provider viewer candidate is recorded; activate View image first."
  }
  try {
    $candidate = Get-Content -LiteralPath $viewerCandidatePath -Raw | ConvertFrom-Json
  } catch {
    Remove-Item -LiteralPath $viewerCandidatePath -ErrorAction SilentlyContinue
    throw "The recorded provider viewer candidate could not be verified safely."
  }
  $expiresAt = [DateTime]::MinValue
  if ([int]$candidate.schemaVersion -ne 3 -or
    -not [DateTime]::TryParse([string]$candidate.expiresAt, [ref]$expiresAt) -or
    [DateTime]::UtcNow -gt $expiresAt.ToUniversalTime() -or
    [int64]$candidate.originWindowHandle -ne ([IntPtr]$window.MainWindowHandle).ToInt64() -or
    [int]$candidate.originProcessId -ne [int]$window.Id -or
    [string]$candidate.provider -ne $effectiveProvider -or
    [string]$candidate.originRequestedUrlFingerprint -ne [string]$affinity.requestedUrlFingerprint -or
    [string]$candidate.originActiveUrlFingerprint -ne [string]$affinity.activeUrlFingerprint -or
    [int64]$candidate.candidateWindowHandle -le 0 -or
    [int]$candidate.candidateProcessId -le 0 -or
    -not [string]$candidate.tabRuntimeId) {
    Remove-Item -LiteralPath $viewerCandidatePath -ErrorAction SilentlyContinue
    throw "The recorded provider viewer candidate is stale or does not belong to the current controlled action."
  }
  $originalTabRuntimeId = Get-SelectedSubscriptionTabRuntimeId -WindowHandle ([IntPtr]$window.MainWindowHandle)
  if (-not $originalTabRuntimeId -or $originalTabRuntimeId -ne [string]$candidate.originTabRuntimeId) {
    Remove-Item -LiteralPath $viewerCandidatePath -ErrorAction SilentlyContinue
    throw "The controlled origin tab changed before viewer adoption; no tab was selected."
  }
  $candidateHandle = [FamilyHistorySubscriptionMouse]::GetAncestor([IntPtr][int64]$candidate.candidateWindowHandle, 3)
  [uint32]$candidateProcessId = 0
  [FamilyHistorySubscriptionMouse]::GetWindowThreadProcessId($candidateHandle, [ref]$candidateProcessId) | Out-Null
  $candidateProcess = Get-Process -Id $candidateProcessId -ErrorAction SilentlyContinue
  if ($candidateHandle -eq [IntPtr]::Zero -or
    -not $candidateProcess -or $candidateProcess.Name -ne 'chrome' -or
    [int]$candidate.candidateProcessId -ne [int]$candidateProcessId) {
    Remove-Item -LiteralPath $viewerCandidatePath -ErrorAction SilentlyContinue
    throw "The newly opened viewer window is no longer the exact Chrome window recorded by the controlled action."
  }
  $viewerTab = Get-SubscriptionTabByRuntimeId -WindowHandle $candidateHandle -RuntimeId ([string]$candidate.tabRuntimeId)
  $currentViewerTitle = if ($viewerTab) { [string]$viewerTab.Current.Name } else { '' }
  $expectedViewerBaseTitle = $ExpectedTabTitle -replace ' - Memory usage - \d+ MB$', ''
  $currentViewerBaseTitle = $currentViewerTitle -replace ' - Memory usage - \d+ MB$', ''
  if (-not $viewerTab -or
    [string]$candidate.expectedBaseTitle -ne $expectedViewerBaseTitle -or
    $currentViewerBaseTitle -ne $expectedViewerBaseTitle) {
    Remove-Item -LiteralPath $viewerCandidatePath -ErrorAction SilentlyContinue
    throw "The newly opened viewer tab no longer has the exact expected title; no tab was selected."
  }
  $adopted = $false
  try {
    if ($candidateHandle -eq [IntPtr]$window.MainWindowHandle) {
      $selection = $viewerTab.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
      ([System.Windows.Automation.SelectionItemPattern]$selection).Select()
      Start-Sleep -Milliseconds 500
    }
    if (-not (Set-SubscriptionWindowForeground -WindowHandle $candidateHandle -ProcessId $candidateProcessId) -or
      (Get-SelectedSubscriptionTabRuntimeId -WindowHandle $candidateHandle) -ne [string]$candidate.tabRuntimeId) {
      throw "The new provider viewer tab/window could not be selected and verified."
    }
    $viewerUri = Get-SubscriptionAddressBarUri -WindowHandle $candidateHandle
    $viewerPathAllowed = if ($effectiveProvider -eq 'findmypast') {
      $viewerUri.AbsolutePath -match '^/(?:record|image-viewer|viewer|image)(?:/|$)'
    } else {
      $viewerUri.AbsolutePath -match '^/imageviewer(?:/|$)'
    }
    if ($effectiveProvider -eq 'ancestry' -and -not $viewerPathAllowed -and
      $viewerUri.AbsolutePath -match '^/search/collections/\d+/records/\d+(?:/|$)' -and
      (Get-SubscriptionDownloadBindingKey -Uri $viewerUri) -eq (Get-SubscriptionDownloadBindingKey -Uri $target)) {
      $ancestryToolMenu = $null
      $ancestryViewerDeadline = [DateTime]::UtcNow.AddSeconds(15)
      do {
        $candidateRoot = [System.Windows.Automation.AutomationElement]::FromHandle($candidateHandle)
        $ancestryToolMenu = $candidateRoot.FindAll(
            [System.Windows.Automation.TreeScope]::Descendants,
            [System.Windows.Automation.Condition]::TrueCondition
          ) | Where-Object {
            $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and
            $_.Current.Name -eq 'Tool menu'
          } | Select-Object -First 1
        if (-not $ancestryToolMenu) { Start-Sleep -Milliseconds 500 }
      } while (-not $ancestryToolMenu -and [DateTime]::UtcNow -lt $ancestryViewerDeadline)
      $viewerPathAllowed = [bool]$ancestryToolMenu
    }
    if (-not (Test-SubscriptionProviderUri -Uri $viewerUri -ProviderName $effectiveProvider) -or -not $viewerPathAllowed) {
      $observedViewerRoute = if ($viewerUri) { "$($viewerUri.Scheme)://$($viewerUri.Host)$($viewerUri.AbsolutePath)" } else { '(no URL)' }
      throw "The newly opened tab did not expose an allowlisted provider viewer URL. Observed route: $observedViewerRoute"
    }
    $observedViewer = Wait-SubscriptionNavigation -WindowHandle $candidateHandle -ProviderName $effectiveProvider -ExpectedHost $viewerUri.Host
    if (-not $observedViewer) {
      throw "The new provider viewer URL did not remain stable."
    }
    Write-SubscriptionAffinity -WindowHandle $candidateHandle -ProcessId $candidateProcessId -ProviderName $effectiveProvider -RequestedUri $viewerUri -ObservedNavigation $observedViewer
    $adopted = $true
  } finally {
    Remove-Item -LiteralPath $viewerCandidatePath -ErrorAction SilentlyContinue
    if (-not $adopted) {
      $originalHandle = [IntPtr]$window.MainWindowHandle
      $originalTab = Get-SubscriptionTabByRuntimeId -WindowHandle $originalHandle -RuntimeId $originalTabRuntimeId
      if ($originalTab -and $candidateHandle -eq $originalHandle) {
        try {
          $originalSelection = $originalTab.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
          ([System.Windows.Automation.SelectionItemPattern]$originalSelection).Select()
          Start-Sleep -Milliseconds 350
          Set-SubscriptionWindowForeground -WindowHandle $originalHandle -ProcessId $window.Id | Out-Null
        } catch {}
      } else {
        Set-SubscriptionWindowForeground -WindowHandle $originalHandle -ProcessId $window.Id | Out-Null
      }
      $restoredUri = Get-SubscriptionAddressBarUri -WindowHandle $originalHandle
      if ((Get-SelectedSubscriptionTabRuntimeId -WindowHandle $originalHandle) -ne $originalTabRuntimeId -or
        -not $restoredUri -or
        (Get-SubscriptionUrlFingerprint -Uri $restoredUri) -ne [string]$affinity.activeUrlFingerprint) {
        throw "Viewer adoption failed and the original controlled tab could not be restored exactly."
      }
    }
  }
  Write-Host "Adopted the exact provider viewer tab created by the immediately preceding controlled action: $($viewerUri.AbsoluteUri)"
  return
}
if ($Mode -eq "navigate") {
  Remove-Item -LiteralPath $viewerCandidatePath -ErrorAction SilentlyContinue
  $expectedHandle = [IntPtr]$window.MainWindowHandle
  if (-not (Set-SubscriptionWindowForeground -WindowHandle $expectedHandle -ProcessId $window.Id)) {
    throw "The controlled subscription Chrome window could not be activated safely."
  }
  $beforeUri = Get-SubscriptionAddressBarUri -WindowHandle $expectedHandle
  if (-not $beforeUri -or
    (Get-SubscriptionUrlFingerprint -Uri $beforeUri) -ne [string]$affinity.activeUrlFingerprint) {
    throw "The controlled subscription tab changed before navigation; no keystroke was sent."
  }
  [System.Windows.Forms.SendKeys]::SendWait('^l')
  Start-Sleep -Milliseconds 250
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($window.MainWindowHandle)
  $address = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition) |
    Where-Object {
      $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit -and
      $_.Current.Name -eq 'Address and search bar'
    } | Select-Object -First 1
  if (-not $address) { throw "Windows Chrome exposed no address bar for the controlled subscription tab." }
  $value = $address.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
  ([System.Windows.Automation.ValuePattern]$value).SetValue($target.AbsoluteUri)
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  $requireChanged = [string]$affinity.activeUrlFingerprint -ne $requestedFingerprint
  $observedNavigation = Wait-SubscriptionNavigation -WindowHandle $expectedHandle -ProviderName $effectiveProvider -PreviousFingerprint ([string]$affinity.activeUrlFingerprint) -RequireChanged $requireChanged -ExpectedHost $target.Host.ToLowerInvariant()
  if (-not $observedNavigation) {
    Remove-Item -LiteralPath $affinityPath -ErrorAction SilentlyContinue
    throw "The controlled subscription tab did not finish navigating to the requested provider."
  }
  Write-SubscriptionAffinity -WindowHandle $expectedHandle -ProcessId $window.Id -ProviderName $effectiveProvider -RequestedUri $target -ObservedNavigation $observedNavigation
  Write-Host "Navigated the verified controlled Windows Chrome tab. Only the allowlisted omnibox URL was read; credentials, cookies, account fields, and payment data were not read or written."
  return
}
if ($Mode -eq "record-links") {
  $links = @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition) |
    Where-Object {
      $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Hyperlink -and
      ($_.Current.Name -in @("View Record", "View Image", "View original record") -or
        ($_.Current.Name -match '^View .+' -and $_.Current.Name -notmatch '^View (others|record|profile)'))
    })
  $safeLinks = foreach ($link in $links) {
    $value = $null
    try {
      $legacy = $link.GetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern)
      $value = ([System.Windows.Automation.LegacyIAccessiblePattern]$legacy).Current.Value
    } catch {}
    if (-not $value) {
      try {
        $valuePattern = $link.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
        $value = ([System.Windows.Automation.ValuePattern]$valuePattern).Current.Value
      } catch {}
    }
    $uri = $null
    if ([Uri]::TryCreate($value, [UriKind]::Absolute, [ref]$uri) -and
      (Test-SubscriptionProviderUri -Uri $uri -ProviderName $effectiveProvider)) {
      [pscustomobject]@{ label = $link.Current.Name; url = $uri.AbsoluteUri }
    }
  }
  if (-not $safeLinks) { throw "No safe provider record or image links were exposed on the selected result page." }
  $safeLinks | ConvertTo-Json -Depth 3
  return
}
if ($Mode -eq "inspect-view-action") {
  $viewControls = @($root.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.Condition]::TrueCondition
    ) | Where-Object {
      $_.Current.ControlType -in @(
        [System.Windows.Automation.ControlType]::Button,
        [System.Windows.Automation.ControlType]::Hyperlink
      ) -and ([string]$_.Current.Name).Trim() -in @('View', 'View image', 'View Image')
    })
  if ($viewControls.Count -eq 0) {
    throw "No visible provider View image action was exposed on the selected result page."
  }
  $safeViewMetadata = foreach ($viewControl in $viewControls) {
    $providerUrl = $null
    $candidateValues = @()
    try {
      $legacy = $viewControl.GetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern)
      $candidateValues += ([System.Windows.Automation.LegacyIAccessiblePattern]$legacy).Current.Value
    } catch {}
    try {
      $valuePattern = $viewControl.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
      $candidateValues += ([System.Windows.Automation.ValuePattern]$valuePattern).Current.Value
    } catch {}
    $candidateValues += [string]$viewControl.Current.HelpText
    foreach ($candidateValue in $candidateValues) {
      $candidateUri = $null
      if ([Uri]::TryCreate($candidateValue, [UriKind]::Absolute, [ref]$candidateUri) -and
        (Test-SubscriptionProviderUri -Uri $candidateUri -ProviderName $effectiveProvider)) {
        $providerUrl = $candidateUri.AbsoluteUri
        break
      }
    }
    [pscustomobject]@{
      label = [string]$viewControl.Current.Name
      controlType = [string]$viewControl.Current.ControlType.ProgrammaticName
      automationId = [string]$viewControl.Current.AutomationId
      className = [string]$viewControl.Current.ClassName
      providerUrl = $providerUrl
    }
  }
  $safeViewMetadata | ConvertTo-Json -Depth 3
  return
}
if ($Mode -eq "next-image") {
  $nextImageViewerAllowed = if ($effectiveProvider -eq 'findmypast') {
    $currentUri.AbsolutePath -match '^/(?:record|image-viewer|viewer|image)(?:/|$)'
  } else {
    $currentUri.AbsolutePath -match '^/imageviewer(?:/|$)'
  }
  if (-not $nextImageViewerAllowed) {
    throw "next-image requires a verified controlled provider image-viewer tab."
  }
  $originTabRuntimeId = Get-SelectedSubscriptionTabRuntimeId -WindowHandle ([IntPtr]$window.MainWindowHandle)
  if (-not $originTabRuntimeId -or $originTabRuntimeId -ne [string]$affinity.tabRuntimeId) {
    throw "The controlled provider image-viewer tab is no longer the recorded active tab."
  }
  $errorControls = @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition) |
    Where-Object {
      $_.Current.IsEnabled -and $_.Current.Name -match '(?i)(something went wrong|an error occurred|try again later|subscribe to continue|upgrade to continue|sign in to continue)'
    })
  if ($errorControls.Count -gt 0) {
    throw "The provider viewer exposes a popup, error, sign-in, or subscription state; no continuation control was invoked."
  }
  $nextMatches = @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition) |
    Where-Object {
      $_.Current.ControlType -in @([System.Windows.Automation.ControlType]::Button, [System.Windows.Automation.ControlType]::Hyperlink) -and
      $_.Current.IsEnabled -and $(if ($effectiveProvider -eq 'ancestry') {
        $_.Current.Name -eq 'Next image'
      } else {
        $_.Current.Name -match '^(?:\S+\s+)?Next$'
      })
    })
  if (($effectiveProvider -eq 'findmypast' -and $nextMatches.Count -ne 1) -or
    ($effectiveProvider -eq 'ancestry' -and $nextMatches.Count -lt 1)) {
    throw "The controlled provider viewer did not expose an eligible Next image continuation control."
  }
  if (-not (Set-SubscriptionWindowForeground -WindowHandle ([IntPtr]$window.MainWindowHandle) -ProcessId $window.Id) -or
    (Get-SelectedSubscriptionTabRuntimeId -WindowHandle ([IntPtr]$window.MainWindowHandle)) -ne $originTabRuntimeId) {
    throw "The controlled provider image-viewer tab could not be revalidated before continuation."
  }
  $beforeUri = Get-SubscriptionAddressBarUri -WindowHandle ([IntPtr]$window.MainWindowHandle)
  if (-not $beforeUri -or (Get-SubscriptionUrlFingerprint -Uri $beforeUri) -ne [string]$affinity.activeUrlFingerprint) {
    throw "The controlled provider image-viewer URL changed before continuation; no control was invoked."
  }
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($window.MainWindowHandle)
  $freshNextMatches = @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition) |
    Where-Object {
      $_.Current.ControlType -in @([System.Windows.Automation.ControlType]::Button, [System.Windows.Automation.ControlType]::Hyperlink) -and
      $_.Current.IsEnabled -and $(if ($effectiveProvider -eq 'ancestry') {
        $_.Current.Name -eq 'Next image'
      } else {
        $_.Current.Name -match '^(?:\S+\s+)?Next$'
      })
    })
  if (($effectiveProvider -eq 'findmypast' -and $freshNextMatches.Count -ne 1) -or
    ($effectiveProvider -eq 'ancestry' -and $freshNextMatches.Count -lt 1)) {
    throw "The exact provider Next continuation control was no longer eligible; no control was invoked."
  }
  try {
    $invoke = $freshNextMatches[0].GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    ([System.Windows.Automation.InvokePattern]$invoke).Invoke()
  } catch {
    throw "The verified provider Next continuation control could not be invoked safely."
  }
  $observedNavigation = Wait-SubscriptionNavigation -WindowHandle ([IntPtr]$window.MainWindowHandle) -ProviderName $effectiveProvider -PreviousFingerprint ([string]$affinity.activeUrlFingerprint) -RequireChanged $true -ExpectedHost $beforeUri.Host
  if (-not $observedNavigation) {
    throw "The invoked provider Next continuation did not produce a verified changed viewer URL."
  }
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($window.MainWindowHandle)
  $postErrorControls = @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition) |
    Where-Object {
      $_.Current.IsEnabled -and $_.Current.Name -match '(?i)(something went wrong|an error occurred|try again later|subscribe to continue|upgrade to continue|sign in to continue)'
    })
  if ($postErrorControls.Count -gt 0) {
    throw "The provider continuation reached a popup, error, sign-in, or subscription state; no source action was taken."
  }
  Write-SubscriptionAffinity -WindowHandle ([IntPtr]$window.MainWindowHandle) -ProcessId $window.Id -ProviderName $effectiveProvider -RequestedUri $target -ObservedNavigation $observedNavigation
  Write-Host "Activated the verified provider Next image continuation and observed a changed viewer URL."
  return
}
if ($Mode -eq "signin-saved") {
  if ($Provider -eq "any") { throw "-Provider is required for signin-saved." }
  . (Join-Path $PSScriptRoot "tree-consent.ps1")
  Assert-TreeConsent "saved-signin"
  $loginLink = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition) |
    Where-Object {
      $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Hyperlink -and
      $_.Current.Name -match '^(Log in|Sign in)$'
    } | Select-Object -First 1
  if (-not $loginLink) {
    Write-Host "No provider login link is visible; the selected Windows Chrome page may already be signed in."
    return
  }
  $invoke = $loginLink.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
  ([System.Windows.Automation.InvokePattern]$invoke).Invoke()
  Start-Sleep -Seconds 4
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($window.MainWindowHandle)
  $submit = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition) |
    Where-Object {
      $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and
      $_.Current.Name -match '^(Log in|Sign in)$'
    } | Select-Object -First 1
  if (-not $submit) {
    $postLoginNavigation = Wait-SubscriptionNavigation -WindowHandle ([IntPtr]$window.MainWindowHandle) -ProviderName $effectiveProvider
    if ($postLoginNavigation) {
      Write-SubscriptionAffinity -WindowHandle ([IntPtr]$window.MainWindowHandle) -ProcessId $window.Id -ProviderName $effectiveProvider -RequestedUri $target -ObservedNavigation $postLoginNavigation
    } else {
      Remove-Item -LiteralPath $affinityPath -ErrorAction SilentlyContinue
    }
    Write-Host "The provider login form is not visible; no credential or account action was taken. Controlled-tab state was refreshed when available."
    return
  }
  Write-Host "Submitting only the existing provider form after allowing Chrome's password manager to autofill; no field value is read, copied, typed, or logged."
  $submitInvoke = $submit.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
  ([System.Windows.Automation.InvokePattern]$submitInvoke).Invoke()
  Start-Sleep -Seconds 5
  $postLoginNavigation = Wait-SubscriptionNavigation -WindowHandle ([IntPtr]$window.MainWindowHandle) -ProviderName $effectiveProvider
  if ($postLoginNavigation) {
    Write-SubscriptionAffinity -WindowHandle ([IntPtr]$window.MainWindowHandle) -ProcessId $window.Id -ProviderName $effectiveProvider -RequestedUri $target -ObservedNavigation $postLoginNavigation
  } else {
    Remove-Item -LiteralPath $affinityPath -ErrorAction SilentlyContinue
    throw "Provider sign-in submitted, but the controlled tab could not be verified afterward; run open before continuing."
  }
  Write-Host "Provider sign-in form submitted. Account creation, signup, and payment controls were not used."
  return
}
if ($Mode -in @("view-transcript", "view-image", "view-article", "download-record", "preview-download", "select-image-region", "capture-full-page", "download-clipping", "image-tools", "extra-materials")) {
  $originTabRuntimeId = Get-SelectedSubscriptionTabRuntimeId -WindowHandle ([IntPtr]$window.MainWindowHandle)
  if (-not $originTabRuntimeId) {
    throw "The controlled subscription tab runtime identity could not be verified; no control was activated."
  }
  $preActionTabRuntimeIds = if ($Mode -eq "view-image") {
    Remove-Item -LiteralPath $viewerCandidatePath -ErrorAction SilentlyContinue
    @(Get-SubscriptionTabRuntimeIds -WindowHandle ([IntPtr]$window.MainWindowHandle))
  } else { @() }
  $preActionChromeWindowHandles = if ($Mode -eq "view-image") {
    @(Get-ChromeTopLevelWindowHandles)
  } else { @() }
  $preActionTabRuntimeIdsByWindow = @{}
  if ($Mode -eq "view-image") {
    foreach ($preActionWindowHandle in $preActionChromeWindowHandles) {
      $preActionTabRuntimeIdsByWindow[[string][int64]$preActionWindowHandle] = @(
        Get-SubscriptionTabRuntimeIds -WindowHandle ([IntPtr][int64]$preActionWindowHandle)
      )
    }
  }
  $downloadBefore = @()
  $downloadsPath = $null
  $expectedDownloadStem = $null
  if ($Mode -in @("download-record", "preview-download")) {
    $downloadViewerAllowed = if ($effectiveProvider -eq 'findmypast') {
      $currentUri.AbsolutePath -match '^/(?:record|image-viewer|viewer|image)(?:/|$)'
    } else {
      $currentUri.AbsolutePath -match '^/imageviewer(?:/|$)'
    }
    if (-not $downloadViewerAllowed) {
      throw "$Mode requires a verified adopted provider image-viewer tab."
    }
    if ($Mode -eq 'preview-download' -and $effectiveProvider -ne 'findmypast') {
      throw "preview-download is limited to a verified Findmypast image-viewer tab."
    }
    $boundTargetUri = $currentUri
    if ($Mode -eq 'download-record') {
      if (-not $TargetId -or $TargetId -notmatch '^[a-z0-9][a-z0-9-]{2,119}$') {
        throw "download-record requires the exact allowlisted -TargetId from the subscription acquisition queue."
      }
      $queuePath = Join-Path (Split-Path $PSScriptRoot -Parent) "evidence\subscription-records-queue.json"
      $queue = Get-Content -LiteralPath $queuePath -Raw | ConvertFrom-Json
      $boundTargets = @($queue.targets | Where-Object { [string]$_.id -eq $TargetId })
      if ($boundTargets.Count -ne 1 -or [string]$boundTargets[0].provider.ToLowerInvariant() -ne $effectiveProvider -or
        [string]$boundTargets[0].status -ne 'pending-subscription') {
        throw "The requested download target is not a unique pending provider acquisition-queue target."
      }
      if (-not $ArchiveFile -or [IO.Path]::GetFileName($ArchiveFile) -ne $ArchiveFile -or
        [IO.Path]::GetExtension($ArchiveFile).ToLowerInvariant() -notin @('.jpg', '.jpeg', '.png', '.webp', '.pdf')) {
        throw "download-record requires a safe supported -ArchiveFile filename for immediate encrypted archival."
      }
      $boundTargetUri = $null
      if (-not [Uri]::TryCreate([string]$boundTargets[0].catalogueUrl, [UriKind]::Absolute, [ref]$boundTargetUri) -or
        -not (Test-SubscriptionProviderUri -Uri $boundTargetUri -ProviderName $effectiveProvider) -or
        (Get-CanonicalSubscriptionHost -HostName $boundTargetUri.Host) -ne (Get-CanonicalSubscriptionHost -HostName $currentUri.Host) -or
        (Get-SubscriptionDownloadBindingKey -Uri $boundTargetUri) -ne (Get-SubscriptionDownloadBindingKey -Uri $currentUri)) {
        throw "The acquisition target's exact catalogue viewer URL does not match the controlled Findmypast viewer."
      }
    }
    if ($effectiveProvider -eq 'findmypast') {
      $viewerRecordId = $null
      foreach ($rawPart in ($boundTargetUri.Query.TrimStart('?') -split '&')) {
        if (-not $rawPart) { continue }
        $pair = $rawPart -split '=', 2
        $key = [Uri]::UnescapeDataString(($pair[0] -replace '\+', ' ')).ToLowerInvariant()
        if ($key -eq 'id' -and $pair.Count -gt 1) {
          $viewerRecordId = [Uri]::UnescapeDataString(($pair[1] -replace '\+', ' '))
          break
        }
      }
      if (-not $viewerRecordId) {
        throw "The exact Findmypast viewer URL exposes no record id for download-file binding."
      }
      $expectedDownloadStem = ($viewerRecordId -replace '[\\/]+', '_' -replace '[^A-Za-z0-9_-]', '_').Trim('_').ToLowerInvariant()
    } else {
      $expectedDownloadStem = [IO.Path]::GetFileName($boundTargetUri.AbsolutePath).ToLowerInvariant()
    }
    if (-not $expectedDownloadStem) {
      throw "The exact Findmypast viewer URL exposes no usable record id for download-file binding."
    }
    $downloadsPath = Join-Path $env:USERPROFILE 'Downloads'
    $downloadBefore = @(Get-ChildItem -LiteralPath $downloadsPath -File | Select-Object -ExpandProperty FullName)
  }
  $wanted = if ($Mode -eq "view-transcript") { "View transcript" } elseif ($Mode -eq "view-article") { "the verified newspaper result" } elseif ($Mode -in @("download-record", "preview-download")) { if ($effectiveProvider -eq 'findmypast') { "Download record" } else { "Download" } } elseif ($Mode -eq "select-image-region") { "Activate selection of an image region" } elseif ($Mode -eq "capture-full-page") { "Capture full page" } elseif ($Mode -eq "download-clipping") { "Download" } elseif ($Mode -eq "image-tools") { if ($effectiveProvider -eq 'findmypast') { "Expand image tools" } else { "Tool menu" } } elseif ($Mode -eq "extra-materials") { "Extra materials" } else { "View image or the current collection" }
  $matches = @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition) |
    Where-Object {
      $label = ([string]$_.Current.Name).Trim()
      $labelMatches = if ($Mode -eq "view-transcript") {
        $label -eq "View transcript"
      } elseif ($Mode -eq "view-article") {
        $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Hyperlink -and
        $label -match "Added on" -and $label -match "\b(18|19|20)\d{2}\b"
      } elseif ($Mode -eq "image-tools") {
        $label -eq $(if ($effectiveProvider -eq 'findmypast') { "Expand image tools" } else { "Tool menu" })
      } elseif ($Mode -eq "select-image-region") {
        $label -eq "Activate selection of an image region"
      } elseif ($Mode -in @("download-record", "preview-download")) {
        $label -eq $(if ($effectiveProvider -eq 'findmypast') { "Download record" } else { "Download" })
      } elseif ($Mode -eq "capture-full-page") {
        $label -eq "Capture full page"
      } elseif ($Mode -eq "download-clipping") {
        $label -eq "Download"
      } elseif ($Mode -eq "extra-materials") {
        $label -match "Extra materials"
      } else {
        $label -in @('View', 'View image', 'View Image')
      }
      $labelMatches -and $_.Current.ControlType -in @(
        [System.Windows.Automation.ControlType]::Button,
        [System.Windows.Automation.ControlType]::Hyperlink
      )
    })
  $match = if ($Mode -in @("view-transcript", "view-image")) {
    $matches | Select-Object -Skip ($ResultIndex - 1) -First 1
  } elseif ($Mode -in @("download-record", "preview-download") -and $matches.Count -ne 1) {
    $null
  } else {
    $matches | Select-Object -First 1
  }
  if (-not $match) {
    $suffix = if ($Mode -in @("view-transcript", "view-image")) { " at result index $ResultIndex" } else { "" }
    throw "No visible $wanted control was found$suffix in the selected $Provider window."
  }
  if ($Mode -eq "image-tools") {
    $expand = $match.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
    ([System.Windows.Automation.ExpandCollapsePattern]$expand).Expand()
  } elseif ($Mode -in @("view-image", "download-record", "preview-download", "select-image-region", "capture-full-page", "download-clipping")) {
    $expectedPhysicalClickBindingKey = $null
    if ($Mode -eq 'view-image') {
      $expectedPhysicalClickUri = Get-SubscriptionElementProviderUri -Element $match -ProviderName $effectiveProvider
      if (-not $expectedPhysicalClickUri) {
        throw "The selected View image result exposed no safe provider URL; no click was sent."
      }
      $expectedPhysicalClickBindingKey = Get-SubscriptionDownloadBindingKey -Uri $expectedPhysicalClickUri
    }
    if (-not (Set-SubscriptionWindowForeground -WindowHandle ([IntPtr]$window.MainWindowHandle) -ProcessId $window.Id) -or
      (Get-SelectedSubscriptionTabRuntimeId -WindowHandle ([IntPtr]$window.MainWindowHandle)) -ne $originTabRuntimeId) {
      throw "The exact controlled tab could not be reverified immediately before the physical click."
    }
    $preClickUri = Get-SubscriptionAddressBarUri -WindowHandle ([IntPtr]$window.MainWindowHandle)
    if (-not (Test-SubscriptionProviderUri -Uri $preClickUri -ProviderName $effectiveProvider) -or
      (Get-CanonicalSubscriptionHost -HostName $preClickUri.Host) -ne [string]$affinity.host -or
      (Get-SubscriptionUrlFingerprint -Uri $preClickUri) -ne [string]$affinity.activeUrlFingerprint) {
      throw "The controlled provider URL changed before the physical click; no click was sent."
    }
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($window.MainWindowHandle)
    $freshMatches = @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition) |
      Where-Object {
        $_.Current.ControlType -in @(
          [System.Windows.Automation.ControlType]::Button,
          [System.Windows.Automation.ControlType]::Hyperlink
        ) -and $_.Current.Name -eq $match.Current.Name
      })
    if ($Mode -eq 'view-image') {
      $freshMatch = $freshMatches | Select-Object -Skip ($ResultIndex - 1) -First 1
      $freshPhysicalClickUri = if ($freshMatch) {
        Get-SubscriptionElementProviderUri -Element $freshMatch -ProviderName $effectiveProvider
      } else { $null }
      if (-not $freshMatch -or
        -not $freshPhysicalClickUri -or
        (Get-SubscriptionDownloadBindingKey -Uri $freshPhysicalClickUri) -ne $expectedPhysicalClickBindingKey) {
        throw "The result-indexed View image URL changed before the physical click; no click was sent."
      }
      $match = $freshMatch
    } elseif ($freshMatches.Count -ne 1) {
      throw "The exact physical-click control was no longer unique; no click was sent."
    } else {
      $match = $freshMatches[0]
    }
    $bounds = $match.Current.BoundingRectangle
    $windowBounds = $root.Current.BoundingRectangle
    if ($bounds.Width -le 0 -or $bounds.Height -le 0 -or
      $bounds.X -lt $windowBounds.X -or $bounds.Y -lt $windowBounds.Y -or
      ($bounds.X + $bounds.Width) -gt ($windowBounds.X + $windowBounds.Width) -or
      ($bounds.Y + $bounds.Height) -gt ($windowBounds.Y + $windowBounds.Height)) {
      throw "The physical-click control bounds are not safely inside the controlled Chrome window."
    }
    [FamilyHistorySubscriptionMouse]::Click([int]($bounds.X + $bounds.Width / 2), [int]($bounds.Y + $bounds.Height / 2))
  } else {
    $invoke = $match.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    ([System.Windows.Automation.InvokePattern]$invoke).Invoke()
  }
  Start-Sleep -Seconds 2
  $newViewerCandidate = $null
  if ($Mode -eq "view-image") {
    $candidateWindowHandle = [IntPtr]::Zero
    $candidateProcessId = 0
    $candidateTabRuntimeId = $null
    $viewerDiscoveryDeadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
      $postActionChromeWindowHandles = @(Get-ChromeTopLevelWindowHandles)
      $newChromeWindowHandles = @($postActionChromeWindowHandles | Where-Object { $_ -notin $preActionChromeWindowHandles })
      $newTabsInExistingWindows = @()
      foreach ($existingWindowHandle in @($postActionChromeWindowHandles | Where-Object { $_ -in $preActionChromeWindowHandles })) {
        $existingWindowKey = [string][int64]$existingWindowHandle
        $previousRuntimeIds = @($preActionTabRuntimeIdsByWindow[$existingWindowKey])
        $currentRuntimeIds = @(Get-SubscriptionTabRuntimeIds -WindowHandle ([IntPtr][int64]$existingWindowHandle)
        )
        foreach ($currentRuntimeId in @($currentRuntimeIds | Where-Object { $_ -notin $previousRuntimeIds })) {
          $newTabsInExistingWindows += [pscustomobject]@{
            windowHandle = [int64]$existingWindowHandle
            tabRuntimeId = [string]$currentRuntimeId
          }
        }
      }
      if ($newTabsInExistingWindows.Count -eq 1 -and $newChromeWindowHandles.Count -eq 0) {
        $candidateWindowHandle = [FamilyHistorySubscriptionMouse]::GetAncestor(
          [IntPtr][int64]$newTabsInExistingWindows[0].windowHandle,
          3
        )
        [uint32]$candidatePid = 0
        [FamilyHistorySubscriptionMouse]::GetWindowThreadProcessId($candidateWindowHandle, [ref]$candidatePid) | Out-Null
        $candidateProcess = Get-Process -Id $candidatePid -ErrorAction SilentlyContinue
        if ($candidateProcess -and $candidateProcess.Name -eq 'chrome') {
          $candidateProcessId = [int]$candidatePid
        }
        $candidateTabRuntimeId = [string]$newTabsInExistingWindows[0].tabRuntimeId
        $newViewerCandidate = Get-SubscriptionTabByRuntimeId -WindowHandle $candidateWindowHandle -RuntimeId $candidateTabRuntimeId
      } elseif ($newTabsInExistingWindows.Count -eq 0 -and $newChromeWindowHandles.Count -eq 1) {
        $candidateWindowHandle = [FamilyHistorySubscriptionMouse]::GetAncestor([IntPtr][int64]$newChromeWindowHandles[0], 3)
        [uint32]$candidatePid = 0
        [FamilyHistorySubscriptionMouse]::GetWindowThreadProcessId($candidateWindowHandle, [ref]$candidatePid) | Out-Null
        $candidateProcess = Get-Process -Id $candidatePid -ErrorAction SilentlyContinue
        $candidateTabs = @(Get-SubscriptionTabRuntimeIds -WindowHandle $candidateWindowHandle)
        if ($candidateProcess -and $candidateProcess.Name -eq 'chrome' -and $candidateTabs.Count -eq 1) {
          $candidateProcessId = [int]$candidatePid
          $candidateTabRuntimeId = $candidateTabs[0]
          $newViewerCandidate = Get-SubscriptionTabByRuntimeId -WindowHandle $candidateWindowHandle -RuntimeId $candidateTabRuntimeId
        }
      }
      if (-not $newViewerCandidate) { Start-Sleep -Milliseconds 250 }
    } while (-not $newViewerCandidate -and [DateTime]::UtcNow -lt $viewerDiscoveryDeadline)
    if ($newViewerCandidate) {
      $newViewerTitle = if ($newViewerCandidate) { [string]$newViewerCandidate.Current.Name } else { '' }
      $newViewerBaseTitle = $newViewerTitle -replace ' - Memory usage - \d+ MB$', ''
      $newViewerTitleAllowed = if ($effectiveProvider -eq 'findmypast') {
        $newViewerTitle -match '^[^|]+ Image \| findmypast\.(com|co\.uk)(?: - Memory usage - \d+ MB)?$'
      } else {
        $newViewerTitle -match '^[^-].+ - Ancestry\.com(?: - Memory usage - \d+ MB)?$'
      }
      if ($newViewerCandidate -and $newViewerTitleAllowed) {
        [pscustomobject]@{
          schemaVersion = 3
          provider = $effectiveProvider
          originWindowHandle = ([IntPtr]$window.MainWindowHandle).ToInt64()
          originProcessId = [int]$window.Id
          originTabRuntimeId = $originTabRuntimeId
          originRequestedUrlFingerprint = [string]$affinity.requestedUrlFingerprint
          originActiveUrlFingerprint = [string]$affinity.activeUrlFingerprint
          candidateWindowHandle = $candidateWindowHandle.ToInt64()
          candidateProcessId = $candidateProcessId
          tabRuntimeId = $candidateTabRuntimeId
          expectedBaseTitle = $newViewerBaseTitle
          createdAt = [DateTime]::UtcNow.ToString('o')
          expiresAt = [DateTime]::UtcNow.AddMinutes(2).ToString('o')
        } | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $viewerCandidatePath -Encoding UTF8
      } else {
        $newViewerCandidate = $null
      }
    }
  }
  if (-not (Set-SubscriptionWindowForeground -WindowHandle ([IntPtr]$window.MainWindowHandle) -ProcessId $window.Id)) {
    throw "The controlled subscription Chrome window could not be reactivated after the requested control."
  }
  $postActionNavigation = Wait-SubscriptionNavigation -WindowHandle ([IntPtr]$window.MainWindowHandle) -ProviderName $effectiveProvider -ExpectedHost ([string]$affinity.host)
  if (-not $postActionNavigation) {
    throw "The controlled subscription tab could not be verified after the requested control."
  }
  if ($Mode -eq "view-image") {
    $currentRoot = [System.Windows.Automation.AutomationElement]::FromHandle($window.MainWindowHandle)
    $toolMenu = $currentRoot.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition) |
      Where-Object { $_.Current.Name -eq "Tool menu" } | Select-Object -First 1
    if (-not $toolMenu -and $postActionNavigation.fingerprint -eq [string]$affinity.activeUrlFingerprint) {
      if ($newViewerCandidate) {
        Write-Host "The provider opened exactly one new viewer candidate tab. Its runtime identity is bound to this action for two minutes. Expected title: $($newViewerCandidate.Current.Name)"
        return
      }
      throw "The provider opened the image viewer outside the controlled tab, but exactly one newly created tab could not be proven; no tab switch was attempted."
    }
  } elseif ($Mode -in @("download-record", "preview-download")) {
    $postDownloadUri = Get-SubscriptionAddressBarUri -WindowHandle ([IntPtr]$window.MainWindowHandle)
    $postDownloadPathAllowed = if ($effectiveProvider -eq 'findmypast') {
      $postDownloadUri -and $postDownloadUri.AbsolutePath -match '^/(?:record|image-viewer|viewer|image)(?:/|$)'
    } else {
      $postDownloadUri -and $postDownloadUri.AbsolutePath -match '^/imageviewer(?:/|$)'
    }
    if (-not $postDownloadPathAllowed) {
      throw "The provider download action left the verified viewer route; no affinity update or acquisition claim was made."
    }
    $downloadedSource = $null
    $downloadDeadline = [DateTime]::UtcNow.AddSeconds(60)
    $stableDownloadSamples = 0
    $lastDownloadLength = -1L
    $lastDownloadWriteTicks = -1L
    $expectedFinalPattern = '^' + [Regex]::Escape($expectedDownloadStem) + '(?: \(\d+\))?\.(?:jpe?g|png|webp|pdf)$'
    $expectedPartialPattern = '^' + [Regex]::Escape($expectedDownloadStem) + '(?: \(\d+\))?\.(?:jpe?g|png|webp|pdf)\.crdownload$'
    do {
      Start-Sleep -Milliseconds 500
      $newDownloadFiles = @(Get-ChildItem -LiteralPath $downloadsPath -File | Where-Object {
        $_.FullName -notin $downloadBefore
      })
      $unexpectedDownloads = @($newDownloadFiles | Where-Object {
        $_.Name -notmatch $expectedFinalPattern -and $_.Name -notmatch $expectedPartialPattern
      })
      if ($unexpectedDownloads.Count -gt 0) {
        throw "An unrelated new file appeared in Downloads during the controlled transaction; no archive binding was attempted."
      }
      $partialDownloads = @($newDownloadFiles | Where-Object { $_.Name -match $expectedPartialPattern })
      $downloadCandidates = @($newDownloadFiles | Where-Object { $_.Name -match $expectedFinalPattern })
      if ($downloadCandidates.Count -gt 1 -or $partialDownloads.Count -gt 1) {
        throw "The controlled provider created more than one matching download; no archive binding was attempted."
      }
      if ($downloadCandidates.Count -eq 1) {
        $candidate = $downloadCandidates[0]
        if ($partialDownloads.Count -eq 0 -and
          $candidate.Length -eq $lastDownloadLength -and
          $candidate.LastWriteTimeUtc.Ticks -eq $lastDownloadWriteTicks) {
          $stableDownloadSamples++
        } else {
          $stableDownloadSamples = 0
          $lastDownloadLength = $candidate.Length
          $lastDownloadWriteTicks = $candidate.LastWriteTimeUtc.Ticks
        }
        if ($stableDownloadSamples -ge 3) {
          $downloadedSource = $candidate.FullName
        }
      } else {
        $stableDownloadSamples = 0
        $lastDownloadLength = -1L
        $lastDownloadWriteTicks = -1L
      }
    } while (-not $downloadedSource -and [DateTime]::UtcNow -lt $downloadDeadline)
    if (-not $downloadedSource) {
      throw "No completed supported download appeared within 60 seconds; no acquisition was registered."
    }
    if ($Mode -eq 'preview-download') {
      Write-Host "Downloaded a temporary Findmypast preview for local visual inspection only; it has not been archived, manifested, or published: $downloadedSource"
    } else {
      $archiveTool = Join-Path $PSScriptRoot 'archive-subscription-download-windows.ps1'
      & $archiveTool -TargetId $TargetId -SourceFile $downloadedSource -ArchiveFile $ArchiveFile
      Write-Host "Downloaded and immediately handed the target to the encrypted archive/hash/manifest transaction: $TargetId"
    }
  } elseif ($Mode -eq "view-article") {
    if ($postActionNavigation.fingerprint -eq [string]$affinity.activeUrlFingerprint) {
      throw "The provider opened the article outside the controlled tab; no guessed tab switch was attempted. Use an explicit allowlisted article URL with open."
    }
  }
  Write-SubscriptionAffinity -WindowHandle ([IntPtr]$window.MainWindowHandle) -ProcessId $window.Id -ProviderName $effectiveProvider -RequestedUri $target -ObservedNavigation $postActionNavigation
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($window.MainWindowHandle)
  $selectionNote = if ($Mode -eq "view-transcript") { " for result index $ResultIndex" } else { "" }
  Write-Host "Activated $wanted$selectionNote in the selected Windows Chrome window."
}
$controls = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition) |
  Where-Object {
    $_.Current.ControlType -in @(
      [System.Windows.Automation.ControlType]::Button,
      [System.Windows.Automation.ControlType]::Edit,
      [System.Windows.Automation.ControlType]::Hyperlink,
      [System.Windows.Automation.ControlType]::Image,
      [System.Windows.Automation.ControlType]::ListItem,
      [System.Windows.Automation.ControlType]::Text,
      [System.Windows.Automation.ControlType]::DataItem
    )
  } |
  Select-Object -First 240

if ($Mode -eq 'inspect') {
  Write-Host "Verified provider URL: $($currentUri.AbsoluteUri)"
}
Write-Host "Visible window: $($window.MainWindowTitle)"
Write-Host "Visible controls (role and accessible label only; values are never read):"
foreach ($control in $controls) {
  $label = $control.Current.Name -replace '\s+', ' '
  if ($label) { Write-Host "  $($control.Current.ControlType.ProgrammaticName): $label" }
}
} finally {
  if ($browserMutexAcquired) {
    try { $browserMutex.ReleaseMutex() } catch {}
  }
  $browserMutex.Dispose()
}
