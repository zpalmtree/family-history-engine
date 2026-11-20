param(
  [string]$Url = 'https://www.ancestry.com/',

  [switch]$ColdStart
)

$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
public static class FamilyHistoryCdpFocusProbe {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
  private static IntPtr initial;
  private static IntPtr firstChanged;
  private static uint initialProcessId;
  private static uint firstChangedProcessId;
  private static volatile bool running;
  private static readonly object gate = new object();
  private static readonly HashSet<uint> observedForegroundProcessIds = new HashSet<uint>();
  private static Thread monitor;
  public static void Start() {
    initial = GetForegroundWindow();
    GetWindowThreadProcessId(initial, out initialProcessId);
    firstChanged = IntPtr.Zero;
    firstChangedProcessId = 0;
    lock (gate) observedForegroundProcessIds.Clear();
    running = true;
    monitor = new Thread(() => {
      while (running) {
        var current = GetForegroundWindow();
        if (current != initial) {
          uint currentProcessId;
          GetWindowThreadProcessId(current, out currentProcessId);
          lock (gate) observedForegroundProcessIds.Add(currentProcessId);
          if (firstChanged == IntPtr.Zero) {
            firstChanged = current;
            firstChangedProcessId = currentProcessId;
          }
        }
        Thread.Sleep(10);
      }
    });
    monitor.IsBackground = true;
    monitor.Start();
  }
  public static void Stop() {
    running = false;
    if (monitor != null) monitor.Join(1000);
  }
  public static bool ObservedAny(uint[] processIds) {
    lock (gate) {
      foreach (var processId in processIds) {
        if (observedForegroundProcessIds.Contains(processId)) return true;
      }
    }
    return false;
  }
  public static string Diagnostic() {
    return "initial-pid=" + initialProcessId + "; changed-pid=" + firstChangedProcessId;
  }
}
"@

$dispatcher = Join-Path $PSScriptRoot 'subscription-cdp-dispatch-windows.ps1'
$compatibilityWrapper = Join-Path $PSScriptRoot 'subscription-windows.ps1'
$sharedBrowserCommand = Join-Path $PSScriptRoot 'shared-browser-command-windows.ps1'

function Get-DedicatedChromeProcessIds {
  $profilePath = Join-Path $env:LOCALAPPDATA 'FamilyHistorySubscriptionChrome'
  $escapedProfile = [Regex]::Escape($profilePath)
  $profileArgumentPattern = "(?:^|\s)--user-data-dir=(?:`"$escapedProfile`"|$escapedProfile)(?=\s|$)"
  return @(
    Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" | Where-Object {
      $_.CommandLine -and
      $_.CommandLine -match $profileArgumentPattern -and
      $_.CommandLine -match '(?:^|\s)--remote-debugging-port=9226(?:\s|$)'
    } | ForEach-Object { [uint32]$_.ProcessId }
  )
}

if ($ColdStart) {
  $browserMutex = [System.Threading.Mutex]::new($false, 'Local\FamilyHistorySubscriptionChromeSharedWindow')
  $browserMutexAcquired = $false
  try {
    try {
      $browserMutexAcquired = $browserMutex.WaitOne(180000)
    } catch [System.Threading.AbandonedMutexException] {
      $browserMutexAcquired = $true
    }
    if (-not $browserMutexAcquired) {
      throw 'The shared subscription browser is busy; the coordinated cold-start smoke was not run.'
    }
    [FamilyHistoryCdpFocusProbe]::Start()
    try {
      & $sharedBrowserCommand -Mode restart
      if ($LASTEXITCODE -ne 0) { throw 'The supervised shared-browser restart failed.' }
    } finally {
      [FamilyHistoryCdpFocusProbe]::Stop()
    }
    $dedicatedProcessIds = @(Get-DedicatedChromeProcessIds)
    if ($dedicatedProcessIds.Count -eq 0) {
      throw 'The cold-start focus probe could not identify the dedicated Chrome process.'
    }
    if ([FamilyHistoryCdpFocusProbe]::ObservedAny($dedicatedProcessIds)) {
      throw "The minimized cold start changed the foreground top-level window at least once ($([FamilyHistoryCdpFocusProbe]::Diagnostic()))."
    }
  } finally {
    if ($browserMutexAcquired) {
      try { $browserMutex.ReleaseMutex() } catch {}
    }
    $browserMutex.Dispose()
  }
  Write-Host 'Supervised cold launch preserved foreground focus and restored the canonical shared browser.'
  return
}

[FamilyHistoryCdpFocusProbe]::Start()
try {
  & $compatibilityWrapper -Mode open -Url $Url -Provider ancestry -AffinitySlot focus-smoke
} finally {
  & $dispatcher -Mode close-affinity -Url $Url -Provider ancestry -AffinitySlot focus-smoke
}
[FamilyHistoryCdpFocusProbe]::Stop()
$dedicatedProcessIds = @(Get-DedicatedChromeProcessIds)
if ($dedicatedProcessIds.Count -eq 0) {
  throw 'The warm focus probe could not identify the dedicated Chrome process.'
}
if ([FamilyHistoryCdpFocusProbe]::ObservedAny($dedicatedProcessIds)) {
  throw "The background CDP smoke transaction changed the foreground top-level window at least once ($([FamilyHistoryCdpFocusProbe]::Diagnostic()))."
}
Write-Host 'Background CDP smoke transaction preserved the foreground window and left no task tab behind.'
