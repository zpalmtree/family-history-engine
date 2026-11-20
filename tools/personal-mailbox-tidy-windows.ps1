# Inbox tidy for the user's personal mailbox (owner.personalMailbox in tree.config.json), at the
# user's request of 18 Nov 2026 ("archive or delete any emails related to our
# research/payments that have been processed so my inbox is clean").
#
# Separate from the read-only reader (personal-mailbox-windows.ps1), whose
# EXAMINE/BODY.PEEK guarantee is unchanged. This script:
# - list: headers only (From, To, Subject, Date, Message-ID) of INBOX messages,
#   fetched with BODY.PEEK so nothing is marked read. Bodies are never read.
# - move: moves exact INBOX UIDs to INBOX.Archive or INBOX.Trash, nothing else.
#   It refuses any other destination and verifies each UID's Message-ID first,
#   so a UID reused after an earlier change can never move the wrong message.
#
# - read: the plain-text body of ONE exact INBOX message (by -Uid plus its
#   Message-ID), fetched with BODY.PEEK, for triaging a provider reply the user
#   asked to have processed (18 Nov 2026). Output goes to the caller's file,
#   never into Git; HTML-only parts are reduced to text.
param(
  [ValidateSet("list", "move", "read", "markread")]
  [string]$Mode = "list",

  [ValidateRange(1, 2000)]
  [int]$SinceDays = 365,

  [ValidateSet("", "INBOX.Archive", "INBOX.Trash")]
  [string]$To = "",

  # list: the folder to list (INBOX by default, or INBOX.Archive to find
  # processed mail archived before it was marked read).
  [ValidateSet("INBOX", "INBOX.Archive")]
  [string]$Folder = "INBOX",

  # move: comma-separated "uid=message-id" pairs (message id without <>).
  [ValidatePattern('^[A-Za-z0-9@._+=$%\-,]{0,60000}$')]
  [string]$Items = ""
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "personal-mailbox-imap.ps1")
Assert-TreeConsent "inbox-tidy"

$client = Open-Mailbox
try {
  if ($Mode -eq "list") {
    [void](Send-Command ("EXAMINE " + (Quote-Imap $Folder)))
    $since = (Get-Date).AddDays(-$SinceDays).ToString("dd-MMM-yyyy", [Globalization.CultureInfo]::InvariantCulture)
    $uids = @()
    foreach ($line in (Send-Command "UID SEARCH SINCE $since")) {
      if ($line -match '^\* SEARCH ?(.*)$') { $uids += @($Matches[1].Trim() -split ' ' | Where-Object { $_ }) }
    }
    $results = New-Object System.Collections.Generic.List[object]
    for ($i = 0; $i -lt $uids.Count; $i += 100) {
      $chunk = $uids[$i..([Math]::Min($i + 99, $uids.Count - 1))]
      foreach ($line in (Send-Command ("UID FETCH " + ($chunk -join ',') + " (UID FLAGS BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID)])"))) {
        if ($line -notmatch '^\* \d+ FETCH') { continue }
        $uid = if ($line -match 'UID (\d+)') { $Matches[1] } else { "" }
        $flags = if ($line -match 'FLAGS \(([^)]*)\)') { $Matches[1] } else { "" }
        $header = if ($line -match '(?s)BODY\[HEADER\.FIELDS[^\]]*\][^\n]*\n(.*)$') { $Matches[1] } else { "" }
        $results.Add([pscustomobject]@{ uid = $uid; flags = $flags; header = $header })
      }
    }
    [pscustomobject]@{ mode = "list"; since = $since; messages = $results } | ConvertTo-Json -Compress -Depth 5
    return
  }

  if ($Mode -eq "read") {
    $uid, $expected = $Items -split '=', 2
    if ($Items -match ',' -or $uid -notmatch '^\d+$' -or -not $expected) { throw "read needs exactly one -Items uid=message-id." }
    [void](Send-Command 'EXAMINE "INBOX"')
    $lines = Send-Command "UID FETCH $uid (BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)] BODY.PEEK[TEXT])"
    $joined = $lines -join "`n"
    if ($joined -notmatch "(?i)Message-ID:\s*<?$([regex]::Escape($expected))>?") { throw "Message-ID mismatch; nothing read." }
    $raw = if ($joined -match '(?s)BODY\[TEXT\][^\n]*\n(.*)$') { $Matches[1] } else { "" }
    $raw = $raw -replace "`r", ""
    # Decode the first text/plain part (quoted-printable or base64), else the
    # first text/html part stripped of tags.
    $text = ""
    foreach ($kind in @("plain", "html")) {
      $m = [regex]::Match($raw, "(?is)Content-Type:\s*text/$kind[^\n]*\n(?:[^\n]+\n)*?\n(.*?)(?=\n--[^\n]+|\z)")
      $headerBlock = [regex]::Match($raw, "(?is)Content-Type:\s*text/$kind(?:[^\n]*\n)(?:[^\n]+\n)*?\n")
      if (-not $m.Success) { continue }
      $part = $m.Groups[1].Value
      if ($headerBlock.Value -match '(?i)base64') {
        $part = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(($part -replace '[^A-Za-z0-9+/=]', '')))
      } elseif ($headerBlock.Value -match '(?i)quoted-printable') {
        $part = $part -replace "=\r?\n", ""
        $bytes = New-Object System.Collections.Generic.List[byte]
        for ($i = 0; $i -lt $part.Length; $i++) {
          if ($part[$i] -eq '=' -and $i + 2 -lt $part.Length -and $part.Substring($i + 1, 2) -match '^[0-9A-Fa-f]{2}$') { $bytes.Add([Convert]::ToByte($part.Substring($i + 1, 2), 16)); $i += 2 }
          else { foreach ($b in [Text.Encoding]::UTF8.GetBytes([string]$part[$i])) { $bytes.Add($b) } }
        }
        $part = [Text.Encoding]::UTF8.GetString($bytes.ToArray())
      }
      if ($kind -eq "html") { $part = [regex]::Replace(($part -replace '(?i)<br\s*/?>|</p>|</tr>|</div>', "`n"), '<[^>]+>', ' ') -replace '&nbsp;', ' ' -replace '&amp;', '&' }
      $text = $part
      break
    }
    if (-not $text) { $text = $raw }
    [pscustomobject]@{ mode = "read"; uid = $uid; text = $text } | ConvertTo-Json -Compress
    return
  }

  if ($Mode -eq "markread") {
    # Sets \Seen on exact INBOX.Archive UIDs whose Message-ID matches, for
    # processed mail archived before the tidy marked it read (20 Nov 2026).
    # Nothing is moved, deleted or read.
    if (-not $Items) { throw "markread needs -Items uid=message-id pairs." }
    [void](Send-Command 'SELECT "INBOX.Archive"')
    $marked = @(); $skipped = @()
    foreach ($pair in ($Items -split ',' | Where-Object { $_ })) {
      $uid, $expected = $pair -split '=', 2
      if ($uid -notmatch '^\d+$' -or -not $expected) { throw "Bad item '$pair'." }
      $actual = ""
      foreach ($line in (Send-Command "UID FETCH $uid (BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)])")) {
        if ($line -match '(?i)Message-ID:\s*<?([^>\s]+)>?') { $actual = $Matches[1] }
      }
      if ($actual -ne $expected) { $skipped += [pscustomobject]@{ uid = $uid; reason = "message-id mismatch or gone" }; continue }
      [void](Send-Command "UID STORE $uid +FLAGS.SILENT (\Seen)")
      $marked += $uid
    }
    [pscustomobject]@{ mode = "markread"; folder = "INBOX.Archive"; marked = $marked; skipped = $skipped } | ConvertTo-Json -Compress -Depth 4
    return
  }

  if (-not $To -or -not $Items) { throw "move needs -To (INBOX.Archive or INBOX.Trash) and -Items." }
  $caps = (Send-Command "CAPABILITY") -join " "
  $hasMove = $caps -match '\bMOVE\b'
  $hasUidPlus = $caps -match '\bUIDPLUS\b'
  if (-not $hasMove -and -not $hasUidPlus) { throw "Server supports neither MOVE nor UIDPLUS; refusing a broad EXPUNGE." }
  [void](Send-Command 'SELECT "INBOX"')
  $moved = @(); $skipped = @()
  foreach ($pair in ($Items -split ',' | Where-Object { $_ })) {
    $uid, $expected = $pair -split '=', 2
    if ($uid -notmatch '^\d+$' -or -not $expected) { throw "Bad item '$pair'." }
    $actual = ""
    foreach ($line in (Send-Command "UID FETCH $uid (BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)])")) {
      if ($line -match '(?i)Message-ID:\s*<?([^>\s]+)>?') { $actual = $Matches[1] }
    }
    if ($actual -ne $expected) { $skipped += [pscustomobject]@{ uid = $uid; reason = "message-id mismatch or gone" }; continue }
    # Mark processed mail read before it leaves the inbox (user request, 20 Nov 2026).
    [void](Send-Command "UID STORE $uid +FLAGS.SILENT (\Seen)")
    if ($hasMove) {
      [void](Send-Command ("UID MOVE $uid " + (Quote-Imap $To)))
    } else {
      [void](Send-Command ("UID COPY $uid " + (Quote-Imap $To)))
      [void](Send-Command "UID STORE $uid +FLAGS.SILENT (\Deleted)")
      [void](Send-Command "UID EXPUNGE $uid")
    }
    $moved += $uid
  }
  [pscustomobject]@{ mode = "move"; to = $To; moved = $moved; skipped = $skipped } | ConvertTo-Json -Compress -Depth 4
} finally {
  try { [void](Send-Command "LOGOUT") } catch {}
  $client.Close()
}
