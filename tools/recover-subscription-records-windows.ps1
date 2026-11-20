param(
  [ValidateSet("Ancestry", "Findmypast")]
  [string]$Provider = "Ancestry",

  [ValidateRange(1, 50)]
  [int]$MaxTargets = 50
)
. (Join-Path $PSScriptRoot "tree-config.ps1")

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
$queuePath = Join-Path $ProjectRoot "evidence\subscription-records-queue.json"
$queue = Get-Content -LiteralPath $queuePath -Raw | ConvertFrom-Json
$targets = @($queue.targets | Where-Object {
  $_.provider -eq $Provider -and $_.status -eq "pending-subscription"
} | Sort-Object @{ Expression = { [int]($_.priority -replace 'P', '') } }, id | Select-Object -First $MaxTargets)

$results = foreach ($target in $targets) {
  $exact = $target.catalogueUrl -match '^https://www\.ancestry\.(com|co\.uk)/(search/collections/\d+/records/\d+|imageviewer/)'
  if ($Provider -ne "Ancestry" -or -not $exact) {
    [pscustomobject]@{ id = $target.id; status = "needs-provider-search"; note = "No exact automated image route is recorded." }
    continue
  }
  try {
    & (Join-Path $ScriptDir "acquire-subscription-record-windows.ps1") `
      -TargetId $target.id -ArchiveFile "$($target.id).jpg"
    [pscustomobject]@{ id = $target.id; status = "acquired" }
  } catch {
    wsl.exe -d Ubuntu --cd (Get-TreeWslProjectRoot) node tools/record-subscription-attempt.mjs `
      --target $target.id --outcome failed --note "Exact provider route failed and remains safe to retry or inspect manually."
    [pscustomobject]@{ id = $target.id; status = "failed"; note = "Exact provider route failed; inspect the visible record/image controls." }
  }
}

$results | ConvertTo-Json -Depth 4
