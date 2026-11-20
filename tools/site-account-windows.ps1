# One-time steps of an account registration or sign-in the user asked for
# (AGENTS.md: account registration on the user's request, 13 Nov 2026; emailed
# verification, 14 Nov 2026), done inside one exact shared-Chrome tab:
#
#   -Mode open-emailed-link  open the single activation or sign-in link that the
#                            newest message from one exact sender carries, if it
#                            arrived after -AfterUtc and points at -ExpectedHost
#   -Mode set-password       generate a strong password, keep it DPAPI-encrypted
#                            under LocalAppData, and enter it in the tab's
#                            password field(s)
#   -Mode fill-password      enter the stored password again (a later sign-in)
#   -Mode fill-account-email enter the account's sign-in name, which is the
#                            personal mailbox address the account was made with
#   -Mode status             whether a password is stored for -Site
#
# Neither the link nor the password is ever printed, logged, written in the
# clear, returned or passed on a command line: output says only that it was done.
param(
  [Parameter(Mandatory)]
  [ValidateSet("open-emailed-link", "set-password", "fill-password", "fill-account-email", "status")]
  [string]$Mode,

  [ValidatePattern('^([a-z0-9][a-z0-9-]{1,40})?$')]
  [string]$Site = "",

  [ValidatePattern('^([a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,})?$')]
  [string]$Sender = "",

  [ValidatePattern('^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z)?$')]
  [string]$AfterUtc = "",

  [ValidatePattern('^([A-F0-9]{32})?$')]
  [string]$TargetId = "",

  [ValidatePattern('^([a-z0-9.-]+\.[a-z]{2,})?$')]
  [string]$ExpectedHost = "",

  # Comma-separated CSS selectors of the password input(s).
  [ValidatePattern('^[A-Za-z0-9\[\]="_\-#.:, ]{0,160}$')]
  [string]$InputSelectors = "",

  [ValidateRange(10, 600)]
  [int]$WaitSeconds = 120
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Security
$utf8 = [System.Text.UTF8Encoding]::new($false)
$storeDirectory = Join-Path $env:LOCALAPPDATA "FamilyTreeSiteAccounts"
$entropy = $utf8.GetBytes("family-tree/site-account/v1")

function Get-StorePath { if (-not $Site) { throw "-Site is required." }; Join-Path $storeDirectory "$Site.dpapi" }

if ($Mode -eq "status") {
  [pscustomobject]@{ site = $Site; passwordStored = (Test-Path -LiteralPath (Get-StorePath)) } | ConvertTo-Json -Compress
  exit 0
}
if (-not $TargetId -or -not $ExpectedHost) { throw "-TargetId and -ExpectedHost are required." }

$ws = New-Object System.Net.WebSockets.ClientWebSocket
$ct = [Threading.CancellationToken]::None
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
function Get-PageHost { (Invoke-Cdp "Runtime.evaluate" @{ expression = "location.hostname"; returnByValue = $true }).result.result.value }

function Enter-Password([string]$Password, [string]$InputType = "password") {
  $selectors = @($InputSelectors -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  if (-not $selectors.Count) { throw "-InputSelectors is required." }
  if ((Get-PageHost) -ne $ExpectedHost) { throw "The tab is not on $ExpectedHost." }
  foreach ($selector in $selectors) {
    $selectorJson = $selector | ConvertTo-Json
    $focus = (Invoke-Cdp "Runtime.evaluate" @{ returnByValue = $true; expression = "(() => { const el = document.querySelector($selectorJson); if (!el || !el.offsetParent || el.type !== '$InputType') return 'no-$InputType-input'; el.focus(); el.value = ''; return 'ok'; })()" }).result.result.value
    if ($focus -ne "ok") { throw "Input not ready ($selector): $focus" }
    [void](Invoke-Cdp "Input.insertText" @{ text = $Password })
    Start-Sleep -Milliseconds 250
    $length = (Invoke-Cdp "Runtime.evaluate" @{ returnByValue = $true; expression = "document.querySelector($selectorJson).value.length" }).result.result.value
    if ($length -ne $Password.Length) { throw "The password did not enter completely ($selector)." }
  }
  $selectors.Count
}

try {
  if ($Mode -eq "open-emailed-link") {
    if (-not $Sender -or -not $AfterUtc) { throw "-Sender and -AfterUtc are required." }
    . (Join-Path $PSScriptRoot "personal-mailbox-imap.ps1")
    $after = [DateTime]::Parse($AfterUtc, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AdjustToUniversal -bor [Globalization.DateTimeStyles]::AssumeUniversal)
    $deadline = (Get-Date).ToUniversalTime().AddSeconds($WaitSeconds)
    $link = $null
    $messageTime = $null
    while (-not $link -and (Get-Date).ToUniversalTime() -lt $deadline) {
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
              # Quoted-printable soft breaks and every =XX escape (a literal "=" is
              # always written "=3D" there, so nothing else can look like one), then
              # HTML entities. A body that is not quoted-printable is left as it is:
              # "?g=5d..." in a plain link is not an escape. Decoding only some escapes
              # once opened a truncated Lob link that verified nothing (19 Nov 2026).
              $text = $fetched
              if ($text -match '(?i)Content-Transfer-Encoding:\s*quoted-printable') {
                $text = $text -replace '=\r?\n', ''
                $text = [regex]::Replace($text, '=([0-9A-Fa-f]{2})', { param($m) [string][char][Convert]::ToInt32($m.Groups[1].Value, 16) })
              }
              $text = $text -replace '&amp;', '&'
              $pattern = 'https://' + [regex]::Escape($ExpectedHost) + '/[A-Za-z0-9\-._~:/?#\[\]@!$&''()*+,;=%]+'
              $links = @([regex]::Matches($text, $pattern) | ForEach-Object { $_.Value.TrimEnd('.', ')', ',', ';') } |
                Where-Object { ([Uri]$_).AbsolutePath.Length -gt 1 } | Select-Object -Unique)
              if ($links.Count -eq 1) { $link = $links[0]; $messageTime = $received }
              elseif ($links.Count -gt 1) { throw "The newest message holds $($links.Count) different links to $ExpectedHost; refusing to guess." }
              else { throw "The newest message holds no link to $ExpectedHost." }
            }
          }
        }
      } finally {
        try { [void](Send-Command "LOGOUT") } catch {}
        $client.Close()
      }
      if (-not $link) { Start-Sleep -Seconds 10 }
    }
    if (-not $link) { throw "No new message from $Sender after $AfterUtc within $WaitSeconds s." }
    $ws.ConnectAsync([Uri]"ws://127.0.0.1:9226/devtools/page/$TargetId", $ct).Wait()
    if ((Get-PageHost) -ne $ExpectedHost) { throw "The tab is not on $ExpectedHost." }
    [void](Invoke-Cdp "Page.navigate" @{ url = $link })
    Start-Sleep -Seconds 4
    $link = $null
    [pscustomobject]@{ opened = $true; messageReceivedUtc = $messageTime.ToString("o"); landedOnHost = ((Get-PageHost) -eq $ExpectedHost) } | ConvertTo-Json -Compress
    exit 0
  }

  if ($Mode -eq "fill-account-email") {
    . (Join-Path $PSScriptRoot "personal-mailbox-imap.ps1")
    $ws.ConnectAsync([Uri]"ws://127.0.0.1:9226/devtools/page/$TargetId", $ct).Wait()
    $count = Enter-Password $Account "email"
    [pscustomobject]@{ filled = $true; fields = $count } | ConvertTo-Json -Compress
    exit 0
  }
  $storePath = Get-StorePath
  $ws.ConnectAsync([Uri]"ws://127.0.0.1:9226/devtools/page/$TargetId", $ct).Wait()
  if ($Mode -eq "set-password") {
    if (Test-Path -LiteralPath $storePath) { throw "A password is already stored for $Site; use fill-password." }
    # 22 characters with every class present, from a generator meant for secrets.
    $classes = @("ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "!#%*-_=+")
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    function Get-RandomIndex([int]$max) { $b = New-Object byte[] 4; do { $rng.GetBytes($b); $v = [BitConverter]::ToUInt32($b, 0) } while ($v -ge ([uint32]::MaxValue - ([uint32]::MaxValue % $max))); [int]($v % $max) }
    $chars = New-Object System.Collections.Generic.List[char]
    foreach ($class in $classes) { $chars.Add($class[(Get-RandomIndex $class.Length)]) }
    $all = ($classes -join "")
    while ($chars.Count -lt 22) { $chars.Add($all[(Get-RandomIndex $all.Length)]) }
    for ($i = $chars.Count - 1; $i -gt 0; $i--) { $j = Get-RandomIndex ($i + 1); $t = $chars[$i]; $chars[$i] = $chars[$j]; $chars[$j] = $t }
    $password = -join $chars
    # Stored before it is entered, so a password the site accepted is never lost.
    $protected = [System.Security.Cryptography.ProtectedData]::Protect($utf8.GetBytes($password), $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    New-Item -ItemType Directory -Force -Path $storeDirectory | Out-Null
    [System.IO.File]::WriteAllText($storePath, [Convert]::ToBase64String($protected), [System.Text.Encoding]::ASCII)
    try {
      $count = Enter-Password $password
    } catch {
      Remove-Item -LiteralPath $storePath -Force
      throw
    }
    $password = $null
    [pscustomobject]@{ set = $true; stored = $true; fields = $count } | ConvertTo-Json -Compress
  } else {
    if (-not (Test-Path -LiteralPath $storePath)) { throw "No password is stored for $Site." }
    $plain = [System.Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String([System.IO.File]::ReadAllText($storePath).Trim()), $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    try { $count = Enter-Password ($utf8.GetString($plain)) } finally { [Array]::Clear($plain, 0, $plain.Length) }
    [pscustomobject]@{ filled = $true; fields = $count } | ConvertTo-Json -Compress
  }
} finally {
  $ws.Dispose()
}
