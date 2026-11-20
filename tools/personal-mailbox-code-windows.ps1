# Enters an emailed verification code into the browser tab that asked for it
# (authorized by the user on 14 Nov 2026 for sign-ins and registrations the
# user requested). It reads the newest message from one exact sender in the
# personal mailbox, only if that message arrived after -AfterUtc, takes the
# single 6-digit code in it, and inserts it into one exact input of one exact
# shared-Chrome CDP target on the expected host. The code is never printed,
# logged, written to disk or returned; output carries only the message time.
param(
  [Parameter(Mandatory)]
  [ValidatePattern('^[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,}$')]
  [string]$Sender,

  # ISO-8601 UTC time the code was requested; older messages are refused.
  [Parameter(Mandatory)]
  [ValidatePattern('^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$')]
  [string]$AfterUtc,

  [Parameter(Mandatory)]
  [ValidatePattern('^[A-F0-9]{32}$')]
  [string]$TargetId,

  [Parameter(Mandatory)]
  [ValidatePattern('^[a-z0-9.-]+\.[a-z]{2,}$')]
  [string]$ExpectedHost,

  # CSS selector of the code input, e.g. [data-test-id="SYAJU"].
  [Parameter(Mandatory)]
  [ValidatePattern('^[A-Za-z0-9\[\]="_\-#.: ]{1,80}$')]
  [string]$InputSelector,

  [ValidateRange(10, 600)]
  [int]$WaitSeconds = 180
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "personal-mailbox-imap.ps1")

$after = [DateTime]::Parse($AfterUtc, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AdjustToUniversal -bor [Globalization.DateTimeStyles]::AssumeUniversal)
$deadline = (Get-Date).ToUniversalTime().AddSeconds($WaitSeconds)
$code = $null
$messageTime = $null
while (-not $code -and (Get-Date).ToUniversalTime() -lt $deadline) {
  $client = Open-Mailbox
  try {
    [void](Send-Command 'EXAMINE "INBOX"')
    $since = $after.AddDays(-1).ToString("dd-MMM-yyyy", [Globalization.CultureInfo]::InvariantCulture)
    $uids = @()
    foreach ($line in (Send-Command ("UID SEARCH SINCE $since FROM " + (Quote-Imap $Sender)))) {
      if ($line -match '^\* SEARCH ?(.*)$') { $uids += @($Matches[1].Trim() -split ' ' | Where-Object { $_ }) }
    }
    if ($uids.Count) {
      $uid = ($uids | ForEach-Object { [int64]$_ } | Measure-Object -Maximum).Maximum
      $fetched = (Send-Command "UID FETCH $uid (INTERNALDATE BODY.PEEK[HEADER.FIELDS (FROM)] BODY.PEEK[TEXT])") -join "`n"
      if ($fetched -match 'INTERNALDATE "([^"]+)"') {
        $received = [DateTime]::ParseExact($Matches[1], "dd-MMM-yyyy HH:mm:ss zzz", [Globalization.CultureInfo]::InvariantCulture).ToUniversalTime()
        $fromOk = $fetched -match ("(?i)From:[^\n]*" + [regex]::Escape($Sender))
        if ($received -gt $after -and $fromOk) {
          $text = $fetched -replace '=\r?\n', '' -replace '<[^>]+>', ' '
          $codes = @([regex]::Matches($text, '(?<![\d#&])\d{6}(?!\d)') | ForEach-Object { $_.Value } | Select-Object -Unique)
          if ($codes.Count -eq 1) { $code = $codes[0]; $messageTime = $received }
          elseif ($codes.Count -gt 1) { throw "The newest message holds $($codes.Count) different 6-digit numbers; refusing to guess." }
        }
      }
    }
  } finally {
    try { [void](Send-Command "LOGOUT") } catch {}
    $client.Close()
  }
  if (-not $code) { Start-Sleep -Seconds 10 }
}
if (-not $code) { throw "No new code from $Sender after $AfterUtc within $WaitSeconds s." }

$selectorJson = $InputSelector | ConvertTo-Json
$hostJson = $ExpectedHost | ConvertTo-Json
$focusExpr = "(() => { if (location.hostname !== $hostJson) return 'wrong-host'; const el = document.querySelector($selectorJson); if (!el || !el.offsetParent) return 'no-input'; el.focus(); el.value = ''; return 'ok'; })()"

$ws = New-Object System.Net.WebSockets.ClientWebSocket
$ct = [Threading.CancellationToken]::None
$ws.ConnectAsync([Uri]"ws://127.0.0.1:9226/devtools/page/$TargetId", $ct).Wait()
$script:cdpId = 0
function Invoke-Cdp([string]$method, [hashtable]$params) {
  $script:cdpId += 1
  $msg = @{ id = $script:cdpId; method = $method; params = $params } | ConvertTo-Json -Depth 6 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($msg)
  $ws.SendAsync([ArraySegment[byte]]$bytes, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $ct).Wait()
  while ($true) {
    $buf = New-Object byte[] 262144; $sb = New-Object System.Text.StringBuilder
    do { $r = $ws.ReceiveAsync([ArraySegment[byte]]$buf, $ct).Result; [void]$sb.Append([Text.Encoding]::UTF8.GetString($buf, 0, $r.Count)) } until ($r.EndOfMessage)
    $resp = $sb.ToString() | ConvertFrom-Json
    if ($resp.id -eq $script:cdpId) { return $resp }
  }
}
try {
  $focus = (Invoke-Cdp "Runtime.evaluate" @{ expression = $focusExpr; returnByValue = $true }).result.result.value
  if ($focus -ne "ok") { throw "Code input not ready: $focus" }
  # Insert one digit at a time, as typing would.
  foreach ($digit in $code.ToCharArray()) {
    [void](Invoke-Cdp "Input.insertText" @{ text = [string]$digit })
    Start-Sleep -Milliseconds 120
  }
} finally {
  $ws.Dispose()
  $code = $null
}
[pscustomobject]@{ entered = $true; messageReceivedUtc = $messageTime.ToString("o") } | ConvertTo-Json -Compress
