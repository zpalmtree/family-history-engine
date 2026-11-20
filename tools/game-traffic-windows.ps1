param(
  [ValidateRange(3, 60)]
  [int]$Seconds = 10,

  [switch]$IncludeProcessIo
)

$adapter = Get-NetAdapter |
  Where-Object { $_.Status -eq "Up" -and $_.HardwareInterface } |
  Sort-Object LinkSpeed -Descending |
  Select-Object -First 1

if (-not $adapter) {
  throw "No active physical Windows network adapter was found."
}

$logicalProcessors = (Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors
$rows = @()

function Get-ProcessCpuSeconds([string[]]$Names) {
  $sum = (Get-Process -Name $Names -ErrorAction SilentlyContinue | Measure-Object CPU -Sum).Sum
  if ($null -eq $sum) { return 0.0 }
  return [double]$sum
}

for ($index = 0; $index -lt $Seconds; $index++) {
  $chromeBefore = Get-ProcessCpuSeconds @("chrome")
  $gameBefore = Get-ProcessCpuSeconds @("tf_win64", "hl2")
  $networkBefore = Get-NetAdapterStatistics -Name $adapter.Name
  Start-Sleep -Seconds 1
  $chromeAfter = Get-ProcessCpuSeconds @("chrome")
  $gameAfter = Get-ProcessCpuSeconds @("tf_win64", "hl2")
  $networkAfter = Get-NetAdapterStatistics -Name $adapter.Name

  $rows += [pscustomobject]@{
    ChromeCpuPct = [math]::Round([math]::Max(0, ($chromeAfter - $chromeBefore) * 100 / $logicalProcessors), 2)
    GameCpuPct = [math]::Round([math]::Max(0, ($gameAfter - $gameBefore) * 100 / $logicalProcessors), 2)
    DownKbps = [math]::Round(($networkAfter.ReceivedBytes - $networkBefore.ReceivedBytes) * 8 / 1000, 1)
    UpKbps = [math]::Round(($networkAfter.SentBytes - $networkBefore.SentBytes) * 8 / 1000, 1)
  }
}

[pscustomobject]@{
  Adapter = $adapter.Name
  Samples = $rows.Count
  ChromeCpuAvgPct = [math]::Round(($rows.ChromeCpuPct | Measure-Object -Average).Average, 2)
  ChromeCpuMaxPct = [math]::Round(($rows.ChromeCpuPct | Measure-Object -Maximum).Maximum, 2)
  GameCpuAvgPct = [math]::Round(($rows.GameCpuPct | Measure-Object -Average).Average, 2)
  GameCpuMaxPct = [math]::Round(($rows.GameCpuPct | Measure-Object -Maximum).Maximum, 2)
  AdapterDownAvgKbps = [math]::Round(($rows.DownKbps | Measure-Object -Average).Average, 1)
  AdapterDownMaxKbps = [math]::Round(($rows.DownKbps | Measure-Object -Maximum).Maximum, 1)
  AdapterUpAvgKbps = [math]::Round(($rows.UpKbps | Measure-Object -Average).Average, 1)
  AdapterUpMaxKbps = [math]::Round(($rows.UpKbps | Measure-Object -Maximum).Maximum, 1)
} | Format-List

Write-Host "Adapter rates are whole-system totals; Windows does not expose per-process byte rates through this lightweight sampler."

if ($IncludeProcessIo) {
  Write-Host ""
  Write-Host "Top process write-I/O candidates (three one-second samples; includes disk I/O, so it is a lead rather than network attribution):"
  $samples = (Get-Counter "\Process(*)\IO Write Bytes/sec" -SampleInterval 1 -MaxSamples 3).CounterSamples
  $samples |
    Where-Object { $_.InstanceName -notmatch "^(_total|idle)$" } |
    Group-Object InstanceName |
    ForEach-Object {
      [pscustomobject]@{
        Process = $_.Name
        AvgWriteKbps = [math]::Round((($_.Group.CookedValue | Measure-Object -Average).Average) * 8 / 1000, 1)
        MaxWriteKbps = [math]::Round((($_.Group.CookedValue | Measure-Object -Maximum).Maximum) * 8 / 1000, 1)
      }
    } |
    Where-Object { $_.MaxWriteKbps -gt 0 } |
    Sort-Object MaxWriteKbps -Descending |
    Select-Object -First 12 |
    Format-Table -AutoSize
}
