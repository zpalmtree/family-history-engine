param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-z0-9][a-z0-9-]{0,127}$')]
  [string]$Target,

  [Parameter(Mandatory = $true)]
  [string]$Confirmation,

  [switch]$InformationReply,
  [switch]$AcceptQuote,
  # Remind the provider, in its own thread, that an accepted quote still
  # awaits its payment instructions (bound by the same exact PAY phrase).
  [switch]$PaymentReminder,
  # Tell the provider, in its own thread, that its requested payment was made
  # (bound by the exact SUBMIT phrase).
  [switch]$PaymentNotice,

  [ValidateLength(1, 4000)]
  [string]$ClarificationReply,

  [ValidatePattern('^[a-z0-9][a-z0-9-]{0,31}$')]
  [string]$AffinitySlot = "archive-inquiry",

  [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
Set-Location $ProjectRoot

function Invoke-BoundedNodeTask {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$Arguments,

    [AllowNull()]
    [object]$StandardInputValue,

    [int]$TimeoutMilliseconds = 360000
  )

  $nodeCommand = Get-Command node -ErrorAction Stop
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $nodeCommand.Source
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardInput = $null -ne $StandardInputValue
  $startInfo.Arguments = (($Arguments | ForEach-Object {
    if ($_ -match '"') { throw "Unsafe quote in the fixed Node task arguments." }
    '"' + $_ + '"'
  }) -join ' ')

  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  try {
    if (-not $process.Start()) { throw "The authorized archive inquiry process did not start." }
    if ($startInfo.RedirectStandardInput) {
      $process.StandardInput.WriteLine([string]$StandardInputValue)
      $process.StandardInput.Close()
    }
    if (-not $process.WaitForExit($TimeoutMilliseconds)) {
      try { $process.Kill() } catch {}
      try { $process.WaitForExit() } catch {}
      throw "The authorized archive inquiry exceeded its bounded runtime and was stopped without terminating shared Chrome."
    }
    return $process.ExitCode
  } finally {
    $process.Dispose()
  }
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Windows Node.js was not found on PATH."
}
if (-not $SkipInstall -and -not (Test-Path (Join-Path $ProjectRoot "node_modules/playwright-core"))) {
  npm install
}

$endpoint = "http://127.0.0.1:9226"
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

$browserMutex = $null
$browserMutexAcquired = $false
$secureInformation = $null
$informationPointer = [IntPtr]::Zero
$requesterInformation = $null
try {
  # Obtain interactive requester information before taking the shared-browser
  # mutex. A paused or abandoned prompt must never block every provider lane.
  if ($InformationReply) {
    $secureInformation = Read-Host "Enter the authorized requester information" -AsSecureString
    $informationPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureInformation)
    $requesterInformation = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($informationPointer)
  }

  $browserMutex = [System.Threading.Mutex]::new($false, 'Local\FamilyHistorySubscriptionChromeSharedWindow')
  try {
    $browserMutexAcquired = $browserMutex.WaitOne(180000)
  } catch [System.Threading.AbandonedMutexException] {
    $browserMutexAcquired = $true
  }
  if (-not $browserMutexAcquired) {
    throw "The one shared Windows Chrome window is busy; retry after the current family-history task finishes."
  }

  $nodeArgs = @(
    "tools/submit-authorized-email-inquiry.mjs",
    "--shared-window",
    "--endpoint", $endpoint,
    "--affinity-slot", $AffinitySlot,
    "--target", $Target,
    "--confirmation", $Confirmation
  )
  if ($InformationReply) { $nodeArgs += "--information-reply-stdin" }
  if ($AcceptQuote) { $nodeArgs += "--accept-quote" }
  if ($PaymentReminder) { $nodeArgs += "--payment-reminder" }
  if ($PaymentNotice) { $nodeArgs += "--payment-notice" }
  # A clarification answers a question the provider asked. It carries no
  # requester contact details, so it is passed as plain text rather than
  # through the secure-string prompt.
  if ($ClarificationReply) { $nodeArgs += "--clarification-reply-stdin" }
  $standardInput = if ($ClarificationReply) { $ClarificationReply } else { $requesterInformation }
  $nodeExitCode = Invoke-BoundedNodeTask -Arguments $nodeArgs -StandardInputValue $standardInput
  if ($nodeExitCode -ne 0) { throw "Authorized archive inquiry failed safely." }
} finally {
  if ($browserMutexAcquired) {
    try { $browserMutex.ReleaseMutex() } catch {}
  }
  if ($browserMutex) { $browserMutex.Dispose() }
  if ($informationPointer -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($informationPointer)
  }
  $requesterInformation = $null
  if ($secureInformation) { $secureInformation.Dispose() }
}
