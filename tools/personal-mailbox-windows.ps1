# Read-only IMAP reader for the user's personal mailbox (owner.personalMailbox in tree.config.json,
# hosted by MXroute). Authorized by the user on 13-14 Nov 2026 so provider
# confirmations (GRO/Worldpay receipts, archive replies) sent to the personal
# address are visible to the research loop.
#
# Guarantees:
# - The password is entered once in a Windows credential dialog (-Mode setup)
#   and stored only DPAPI-encrypted under LocalAppData. It never reaches argv,
#   environment variables, Node, logs, chat or Git.
# - The mailbox is opened with EXAMINE (read-only) and messages are fetched with
#   BODY.PEEK, so nothing is marked read, moved, flagged or deleted.
# - Only header fields (From, To, Subject, Date, Message-ID) and the MIME
#   structure (for attachment names) are fetched. A message body is read in one
#   case only: -Mode text returns the plain text of a single message that the
#   Node side chose by a provider's sender term (19 Nov 2026, when a provider's
#   reply had left the shared mailbox and the user said it was in this one).
# - Deleted items are searched only with -IncludeTrash, which the user asks for.
param(
  [ValidateSet("setup", "status", "search", "attachment", "text")]
  [string]$Mode = "status",

  [switch]$IncludeTrash,

  # Comma-separated sender terms (addresses or domains), searched one by one.
  [ValidatePattern('^[A-Za-z0-9@._+\-, ]{0,2000}$')]
  [string]$From = "",

  [ValidatePattern('^[A-Za-z0-9 ._\-:#/]{0,120}$')]
  [string]$Subject = "",

  [ValidateRange(1, 400)]
  [int]$SinceDays = 30,

  [ValidateRange(1, 200)]
  [int]$MaxPerTerm = 25,

  # attachment mode: one MIME part of one message, chosen by the Node side
  # from the message's BODYSTRUCTURE so that it is an attachment, never the
  # text body. Saved base64-decoded under LocalAppData, outside the repository.
  [ValidatePattern('^[A-Za-z0-9 ._\-/]{0,80}$')]
  [string]$Folder = "",
  [ValidatePattern('^\d{0,10}$')]
  [string]$Uid = "",
  [ValidatePattern('^(\d{1,3}(\.\d{1,3}){0,4})?$')]
  [string]$Section = "",
  [ValidatePattern('^[a-z0-9][a-z0-9._-]{0,120}$')]
  [string]$OutName = ""
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "personal-mailbox-imap.ps1")

if ($Mode -eq "setup") {
  $cred = Get-Credential -UserName $Account -Message "Personal mailbox password for $Account (stored only with Windows DPAPI for read-only IMAP)"
  if (-not $cred) { throw "No password entered." }
  Save-Password $cred.Password
  $client = Open-Mailbox
  try { [void](Send-Command "LOGOUT") } catch {}
  $client.Close()
  [pscustomobject]@{ mode = "setup"; stored = $true; verifiedLogin = $true } | ConvertTo-Json -Compress
  exit 0
}

$client = Open-Mailbox
try {
  $folders = @(Get-Folders)
  if ($Mode -eq "attachment") {
    if (-not $Folder -or -not $Uid -or -not $Section -or -not $OutName) { throw "attachment mode needs -Folder, -Uid, -Section and -OutName." }
    [void](Send-Command ("EXAMINE " + (Quote-Imap $Folder)))
    $lines = Send-Command ("UID FETCH $Uid (BODY.PEEK[$Section.MIME] BODY.PEEK[$Section])")
    $joined = ($lines -join "`n")
    $mime = if ($joined -match "(?s)BODY\[$([regex]::Escape($Section))\.MIME\][^\n]*\n(.*?)(?:\s+BODY\[|$)") { $Matches[1] } else { "" }
    if ($mime -notmatch '(?i)Content-Disposition:\s*(attachment|inline);[^\n]*name' -and $mime -notmatch '(?i)Content-Type:[^\n]*;\s*name=') {
      throw "Section $Section is not a named attachment part; refusing to fetch it."
    }
    $data = if ($joined -match "(?s)BODY\[$([regex]::Escape($Section))\] [^\n]*\n(.*)$") { $Matches[1] } elseif ($joined -match "(?s)BODY\[$([regex]::Escape($Section))\]\s*\{\d+\}\n(.*)$") { $Matches[1] } else { "" }
    $data = $data -replace '\)\s*$', ''
    if ($mime -match '(?i)Content-Transfer-Encoding:\s*base64') {
      $bytes = [Convert]::FromBase64String(($data -replace '[^A-Za-z0-9+/=]', ''))
    } else {
      $bytes = [Text.Encoding]::UTF8.GetBytes($data)
    }
    $outDir = Join-Path $env:LOCALAPPDATA "FamilyHistoryMail"
    New-Item -ItemType Directory -Force -Path $outDir | Out-Null
    $outPath = Join-Path $outDir $OutName
    [IO.File]::WriteAllBytes($outPath, $bytes)
    [pscustomobject]@{ mode = "attachment"; path = $outPath; bytes = $bytes.Length } | ConvertTo-Json -Compress
    return
  }
  if ($Mode -eq "text") {
    if (-not $Folder -or -not $Uid -or -not $Section) { throw "text mode needs -Folder, -Uid and -Section." }
    [void](Send-Command ("EXAMINE " + (Quote-Imap $Folder)))
    $lines = Send-Command ("UID FETCH $Uid (BODY.PEEK[$Section.MIME] BODY.PEEK[$Section])")
    $joined = ($lines -join "`n")
    $mime = if ($joined -match "(?s)BODY\[$([regex]::Escape($Section))\.MIME\][^\n]*\n(.*?)(?:\s+BODY\[|$)") { $Matches[1] } else { "" }
    if ($mime -notmatch '(?i)Content-Type:\s*text/plain' -or $mime -match '(?i)Content-Disposition:\s*attachment') {
      throw "Section $Section is not the plain text of the message; refusing to fetch it."
    }
    $data = if ($joined -match "(?s)BODY\[$([regex]::Escape($Section))\] [^\n]*\n(.*)$") { $Matches[1] } elseif ($joined -match "(?s)BODY\[$([regex]::Escape($Section))\]\s*\{\d+\}\n(.*)$") { $Matches[1] } else { "" }
    $data = $data -replace '\)\s*$', ''
    $charset = if ($mime -match '(?i)charset="?([A-Za-z0-9._-]+)') { $Matches[1] } else { "utf-8" }
    $encoding = try { [Text.Encoding]::GetEncoding($charset) } catch { [Text.Encoding]::UTF8 }
    if ($mime -match '(?i)Content-Transfer-Encoding:\s*base64') {
      $text = $encoding.GetString([Convert]::FromBase64String(($data -replace '[^A-Za-z0-9+/=]', '')))
    } elseif ($mime -match '(?i)Content-Transfer-Encoding:\s*quoted-printable') {
      $bytes = New-Object System.Collections.Generic.List[byte]
      $soft = ($data -replace "=\r?\n", "")
      for ($i = 0; $i -lt $soft.Length; $i++) {
        if ($soft[$i] -eq '=' -and $i + 2 -lt $soft.Length + 0 -and $soft.Substring($i + 1, 2) -match '^[0-9A-Fa-f]{2}$') {
          $bytes.Add([Convert]::ToByte($soft.Substring($i + 1, 2), 16)); $i += 2
        } else { $bytes.AddRange([Text.Encoding]::ASCII.GetBytes([string]$soft[$i])) }
      }
      $text = $encoding.GetString($bytes.ToArray())
    } else {
      $text = $data
    }
    if ($text.Length -gt 20000) { $text = $text.Substring(0, 20000) }
    [pscustomobject]@{ mode = "text"; text = $text } | ConvertTo-Json -Compress
    return
  }
  if ($Mode -eq "status") {
    [pscustomobject]@{ mode = "status"; account = $Account; folders = @($folders | ForEach-Object { $_.name }) } | ConvertTo-Json -Compress -Depth 4
    return
  }
  # Search the inbox plus junk/spam/archive folders, never sent or drafts; the
  # deleted-items folder only when the user asked for it.
  $searchFolders = @($folders | Where-Object {
    $_.name -eq "INBOX" -or $_.flags -match '\\(Junk|Archive|All)' -or $_.name -match '(?i)^(inbox\.)?(junk|spam|archive)$' -or
      ($IncludeTrash -and ($_.flags -match '\\Trash' -or $_.name -match '(?i)^(inbox\.)?(trash|deleted( items| messages)?)$'))
  } | ForEach-Object { $_.name })
  $since = (Get-Date).AddDays(-$SinceDays).ToString("dd-MMM-yyyy", [Globalization.CultureInfo]::InvariantCulture)
  $terms = @($From -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  if (-not $terms.Count -and -not $Subject) { throw "Pass -From and/or -Subject." }
  if (-not $terms.Count) { $terms = @("") }
  $results = New-Object System.Collections.Generic.List[object]
  foreach ($folder in $searchFolders) {
    [void](Send-Command ("EXAMINE " + (Quote-Imap $folder)))
    foreach ($term in $terms) {
      $criteria = "SINCE $since"
      if ($term) { $criteria += " FROM " + (Quote-Imap $term) }
      if ($Subject) { $criteria += " SUBJECT " + (Quote-Imap $Subject) }
      $uids = @()
      foreach ($line in (Send-Command "UID SEARCH $criteria")) {
        if ($line -match '^\* SEARCH ?(.*)$') { $uids += @($Matches[1].Trim() -split ' ' | Where-Object { $_ }) }
      }
      $uids = @($uids | Select-Object -Last $MaxPerTerm)
      if (-not $uids.Count) { continue }
      $fetch = Send-Command ("UID FETCH " + ($uids -join ',') + " (UID BODYSTRUCTURE BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID)])")
      foreach ($line in $fetch) {
        if ($line -notmatch '^\* \d+ FETCH') { continue }
        $uid = if ($line -match 'UID (\d+)') { $Matches[1] } else { "" }
        $structure = if ($line -match 'BODYSTRUCTURE (\(.*?\)) BODY\[') { $Matches[1] } elseif ($line -match 'BODYSTRUCTURE (\(.*\))') { $Matches[1] } else { "" }
        $header = if ($line -match '(?s)BODY\[HEADER\.FIELDS[^\]]*\][^\n]*\n(.*)$') { $Matches[1] } else { "" }
        $results.Add([pscustomobject]@{ folder = $folder; term = $term; uid = $uid; header = $header; bodystructure = $structure })
      }
    }
  }
  [pscustomobject]@{ mode = "search"; account = $Account; since = $since; folders = $searchFolders; messages = $results } | ConvertTo-Json -Compress -Depth 6
} finally {
  try { [void](Send-Command "LOGOUT") } catch {}
  $client.Close()
}
