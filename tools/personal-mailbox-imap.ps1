# Shared read-only IMAP client for the personal mailbox (dot-sourced by
# personal-mailbox-windows.ps1 and personal-mailbox-code-windows.ps1).
# The password lives only in a DPAPI file under LocalAppData.
Add-Type -AssemblyName System.Security
. (Join-Path $PSScriptRoot "tree-consent.ps1")
$ImapHost = "friday.mxlogin.com"
$ImapPort = 993
. (Join-Path $PSScriptRoot "tree-config.ps1")
$Account = Get-TreeOwnerMailbox
$CredDir = Join-Path $env:LOCALAPPDATA "FamilyHistoryCredentials"
$CredFile = Join-Path $CredDir "personal-mailbox.dpapi"

function Save-Password([securestring]$secure) {
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
  New-Item -ItemType Directory -Force -Path $CredDir | Out-Null
  $enc = [Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($plain), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  [IO.File]::WriteAllBytes($CredFile, $enc)
  $plain = $null
}

function Read-Password {
  if (-not (Test-Path $CredFile)) { throw "No stored password: run npm run mailbox:personal:setup first." }
  [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($CredFile), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser))
}

function Quote-Imap([string]$value) { '"' + ($value -replace '\\', '\\' -replace '"', '\"') + '"' }

# Minimal IMAP4rev1 client over TLS with literal support.
$script:stream = $null
$script:tagCounter = 0
function Read-Line {
  $bytes = New-Object System.Collections.Generic.List[byte]
  while ($true) {
    $b = $script:stream.ReadByte()
    if ($b -lt 0) { throw "IMAP connection closed." }
    if ($b -eq 10) { break }
    if ($b -ne 13) { $bytes.Add([byte]$b) }
  }
  [Text.Encoding]::UTF8.GetString($bytes.ToArray())
}
function Read-Exact([int]$count) {
  $buffer = New-Object byte[] $count
  $offset = 0
  while ($offset -lt $count) {
    $read = $script:stream.Read($buffer, $offset, $count - $offset)
    if ($read -le 0) { throw "IMAP connection closed." }
    $offset += $read
  }
  [Text.Encoding]::UTF8.GetString($buffer)
}
# Returns the untagged responses (literals inlined) and throws on NO/BAD.
function Send-Command([string]$command, [switch]$Secret) {
  $script:tagCounter += 1
  $tag = "A{0:D4}" -f $script:tagCounter
  $payload = [Text.Encoding]::UTF8.GetBytes("$tag $command`r`n")
  $script:stream.Write($payload, 0, $payload.Length)
  $script:stream.Flush()
  $responses = New-Object System.Collections.Generic.List[string]
  while ($true) {
    $line = Read-Line
    while ($line -match '\{(\d+)\}$') {
      $literal = Read-Exact ([int]$Matches[1])
      $line = $line + "`n" + $literal + (Read-Line)
    }
    if ($line.StartsWith("$tag ")) {
      if ($line -notmatch "^$tag OK") {
        $shown = if ($Secret) { "LOGIN" } else { ($command -split ' ')[0] }
        throw "IMAP $shown failed: $($line.Substring($tag.Length + 1))"
      }
      return $responses
    }
    $responses.Add($line)
  }
}

function Open-Mailbox {
  Assert-TreeConsent "mailbox-read"
  $client = New-Object Net.Sockets.TcpClient($ImapHost, $ImapPort)
  $ssl = New-Object Net.Security.SslStream($client.GetStream(), $false)
  $ssl.AuthenticateAsClient($ImapHost)
  $script:stream = $ssl
  [void](Read-Line)  # greeting
  $password = Read-Password
  [void](Send-Command ("LOGIN " + (Quote-Imap $Account) + " " + (Quote-Imap $password)) -Secret)
  $password = $null
  $client
}

function Get-Folders {
  $folders = @()
  foreach ($line in (Send-Command 'LIST "" "*"')) {
    if ($line -match '^\* LIST \(([^)]*)\) (?:"[^"]*"|NIL) (.+)$') {
      $flags = $Matches[1]; $name = $Matches[2].Trim('"')
      if ($flags -notmatch '\\Noselect') { $folders += [pscustomobject]@{ name = $name; flags = $flags } }
    }
  }
  $folders
}
