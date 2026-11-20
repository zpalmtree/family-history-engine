param(
  [ValidateSet("status", "save-clipboard", "save-from-tab", "rehearsal-setup", "configure", "send", "selftest")]
  [string]$Mode = "status",
  # save-from-tab: the shared-Chrome tab showing Lob's own API Keys page, and
  # which of its two secret keys to store.
  [ValidatePattern('^([A-F0-9]{32})?$')]
  [string]$TargetId = "",
  [ValidateSet("test", "live")]
  [string]$KeyEnvironment = "test",
  # configure: which of the account's saved objects to use (opaque Lob ids).
  [ValidatePattern('^(bank_[A-Za-z0-9]{6,40})?$')]
  [string]$BankAccount = "",
  [ValidatePattern('^(adr_[A-Za-z0-9]{6,40})?$')]
  [string]$FromAddress = "",
  # selftest only: a mock Lob on this machine. Never used with the stored key.
  [ValidatePattern('^(http://127\.0\.0\.1:\d{2,5})?$')]
  [string]$SelfTestBase = ""
)

# Guarded mailed cheque through Lob (AGENTS.md, 19 Nov 2026). This bridge is the
# only place the Lob API key, the bank account and the sender's own name, email
# and address exist. The key is saved from the clipboard and kept only
# DPAPI-encrypted under LocalAppData; the bank account and the return address
# are objects the user saved in Lob's own dashboard and are referred to here by
# their opaque ids. Nothing personal is printed: results carry ids, a cheque
# number, a date and the payee's name.
#
#   -Mode save-clipboard   store the API key now on the clipboard (test_ or live_)
#   -Mode save-from-tab    store the test or live key straight from Lob's own API
#                          Keys page in one exact tab (the key is never shown)
#   -Mode rehearsal-setup  with a test_ key only: make the test environment's own
#                          sample bank account and return address, so a cheque
#                          can be rehearsed before anything real exists
#   -Mode configure        choose the verified bank account and the return address
#   -Mode status           what is configured (no secrets)
#   -Mode send             stdin: {"idempotencyKey": "...", "check": {...}} from the Node helper
#   -Mode selftest         the same request shapes against a local mock, with a fake key

$ErrorActionPreference = "Stop"
$utf8 = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
Add-Type -AssemblyName System.Security
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$profileDirectory = Join-Path $env:LOCALAPPDATA "FamilyTreeMailedCheque"
$keyPath = Join-Path $profileDirectory "mailed-check-lob-key.dpapi"
$settingsPath = Join-Path $profileDirectory "mailed-check-lob-settings.json"
$entropy = $utf8.GetBytes("family-tree/mailed-check-lob/v1")
$liveBase = "https://api.lob.com/v1"

function Read-Key {
  if (-not (Test-Path -LiteralPath $keyPath)) { throw "Credential unavailable" }
  $protected = [Convert]::FromBase64String([System.IO.File]::ReadAllText($keyPath).Trim())
  $plain = [System.Security.Cryptography.ProtectedData]::Unprotect($protected, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  try { $utf8.GetString($plain) } finally { [Array]::Clear($plain, 0, $plain.Length) }
}

function Read-Settings {
  if (-not (Test-Path -LiteralPath $settingsPath)) { return $null }
  [System.IO.File]::ReadAllText($settingsPath, $utf8) | ConvertFrom-Json
}

function Invoke-Lob([string]$Base, [string]$Key, [string]$Method, [string]$Path, $Body, [string]$IdempotencyKey) {
  $headers = @{ Authorization = "Basic " + [Convert]::ToBase64String($utf8.GetBytes($Key + ":")) }
  if ($IdempotencyKey) { $headers["Idempotency-Key"] = $IdempotencyKey }
  $arguments = @{ UseBasicParsing = $true; Method = $Method; Uri = ($Base + $Path); Headers = $headers; TimeoutSec = 90 }
  if ($null -ne $Body) {
    $arguments.ContentType = "application/json; charset=utf-8"
    $arguments.Body = $utf8.GetBytes(($Body | ConvertTo-Json -Depth 8 -Compress))
  }
  $response = Invoke-WebRequest @arguments
  $utf8.GetString($response.RawContentStream.ToArray()) | ConvertFrom-Json
}

function Get-Environment([string]$Key) { if ($Key -like "live_*") { "live" } else { "test" } }

# The sender as Lob holds it, for the letter's heading and signature.
function Get-Sender($Address) {
  $lines = @($Address.address_line1, $Address.address_line2) | Where-Object { $_ }
  $place = (@($Address.address_city, $Address.address_state) | Where-Object { $_ }) -join ", "
  # Lob keeps names in capitals; a letter is signed in ordinary case.
  $name = [string]$Address.name
  if ($name -ceq $name.ToUpperInvariant()) { $name = [Globalization.CultureInfo]::InvariantCulture.TextInfo.ToTitleCase($name.ToLowerInvariant()) }
  @{
    sender_name = $name
    sender_email = [string]$Address.email
    sender_address = ((@($lines) + @(($place + " " + $Address.address_zip).Trim())) -join ", ")
    letter_date = (Get-Date).ToString("d MMMM yyyy", [Globalization.CultureInfo]::InvariantCulture)
  }
}

function Send-Check([string]$Base, [string]$Key, $Settings, $Request) {
  $allowedTop = @("idempotencyKey", "check")
  if (@($Request.PSObject.Properties.Name | Where-Object { $_ -notin $allowedTop }).Count) { throw "Unexpected request fields" }
  $allowed = @("description", "to", "amount", "memo", "message", "attachment", "mail_type", "use_type", "metadata")
  $check = $Request.check
  if (@($check.PSObject.Properties.Name | Where-Object { $_ -notin $allowed }).Count) { throw "Unexpected cheque fields" }
  if ($check.mail_type -ne "usps_first_class" -or $check.use_type -ne "operational") { throw "Invalid mail type" }
  if (-not ($check.amount -gt 0) -or $check.amount -gt 500) { throw "Invalid amount" }
  if ($Request.idempotencyKey -notmatch '^family-history-cheque/[a-z0-9-]{1,127}/[A-Za-z0-9-]{1,80}$') { throw "Invalid idempotency key" }
  $from = Invoke-Lob $Base $Key "Get" ("/addresses/" + $Settings.fromAddress) $null ""
  if (-not $from.name -or -not $from.email) { throw "The saved return address needs a name and an email" }
  $bank = Invoke-Lob $Base $Key "Get" ("/bank_accounts/" + $Settings.bankAccount) $null ""
  if (-not $bank.verified) { throw "The bank account is not verified" }
  $body = [ordered]@{}
  foreach ($property in $check.PSObject.Properties) { $body[$property.Name] = $property.Value }
  $body["from"] = $Settings.fromAddress
  $body["bank_account"] = $Settings.bankAccount
  $body["merge_variables"] = Get-Sender $from
  $created = Invoke-Lob $Base $Key "Post" "/checks" $body $Request.idempotencyKey
  [ordered]@{
    id = $created.id
    checkNumber = $created.check_number
    amount = $created.amount
    toName = $created.to.name
    expectedDeliveryDate = $created.expected_delivery_date
    environment = (Get-Environment $Key)
  }
}

try {
  if ($Mode -eq "status") {
    $settings = Read-Settings
    $environment = $null
    if (Test-Path -LiteralPath $keyPath) { $environment = Get-Environment (Read-Key) }
    @{ provider = "lob"; keyStored = (Test-Path -LiteralPath $keyPath); environment = $environment; bankAccount = [bool]$settings.bankAccount; fromAddress = [bool]$settings.fromAddress } | ConvertTo-Json -Compress
    exit 0
  }
  if ($Mode -in @("save-clipboard", "save-from-tab")) {
    if ($Mode -eq "save-from-tab") {
      if (-not $TargetId) { throw "The tab is required" }
      $ws = New-Object System.Net.WebSockets.ClientWebSocket
      $ct = [Threading.CancellationToken]::None
      $ws.ConnectAsync([Uri]"ws://127.0.0.1:9226/devtools/page/$TargetId", $ct).Wait()
      try {
        $expression = "(() => { if (location.hostname !== 'dashboard.lob.com') return ''; const el = document.getElementById('$KeyEnvironment-api-key'); return el ? el.value : ''; })()"
        $message = @{ id = 1; method = "Runtime.evaluate"; params = @{ expression = $expression; returnByValue = $true } } | ConvertTo-Json -Depth 5 -Compress
        $ws.SendAsync([ArraySegment[byte]]$utf8.GetBytes($message), [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $ct).Wait()
        $key = ""
        while (-not $key) {
          $buffer = New-Object byte[] 65536; $builder = New-Object System.Text.StringBuilder
          do { $received = $ws.ReceiveAsync([ArraySegment[byte]]$buffer, $ct).Result; [void]$builder.Append($utf8.GetString($buffer, 0, $received.Count)) } until ($received.EndOfMessage)
          $response = $builder.ToString() | ConvertFrom-Json
          if ($response.id -eq 1) { $key = [string]$response.result.result.value; break }
        }
      } finally { $ws.Dispose() }
      if (-not $key.StartsWith("${KeyEnvironment}_")) { throw "Invalid credential" }
    } else {
      $key = (Get-Clipboard -Raw).Trim()
    }
    if ($key -notmatch '^(test|live)_[A-Za-z0-9]{16,120}$') { throw "Invalid credential" }
    $plainBytes = $utf8.GetBytes($key)
    $protectedBytes = [System.Security.Cryptography.ProtectedData]::Protect($plainBytes, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    New-Item -ItemType Directory -Force -Path $profileDirectory | Out-Null
    [System.IO.File]::WriteAllText($keyPath, [Convert]::ToBase64String($protectedBytes), [System.Text.Encoding]::ASCII)
    [Array]::Clear($plainBytes, 0, $plainBytes.Length)
    if ($Mode -eq "save-clipboard" -and (Get-Clipboard -Raw).Trim() -eq $key) { Set-Clipboard -Value $null }
    # A different key may belong to a different account: its saved objects are chosen again.
    if (Test-Path -LiteralPath $settingsPath) { Remove-Item -LiteralPath $settingsPath -Force }
    @{ keyStored = $true; environment = (Get-Environment $key) } | ConvertTo-Json -Compress
    exit 0
  }

  $base = $liveBase
  if ($Mode -eq "selftest") {
    if (-not $SelfTestBase) { throw "selftest needs -SelfTestBase" }
    $base = $SelfTestBase
    $key = "test_selftest0000000000"
  } else {
    if ($SelfTestBase) { throw "-SelfTestBase is for selftest only" }
    $key = Read-Key
  }

  if ($Mode -eq "rehearsal-setup") {
    # Test environment only: Lob's own sample bank numbers and a sample address.
    # Nothing here is the user's, nothing can be posted, and no money can move.
    if ((Get-Environment $key) -ne "test") { throw "Invalid environment for a rehearsal" }
    $existingBanks = @((Invoke-Lob $base $key "Get" "/bank_accounts?limit=20" $null "").data | Where-Object { $_.verified -and -not $_.deleted })
    if (-not $existingBanks.Count) {
      $bank = Invoke-Lob $base $key "Post" "/bank_accounts" @{ description = "rehearsal bank account"; routing_number = "322271627"; account_number = "123456789"; signatory = "Rehearsal Signatory"; account_type = "individual" } ""
      [void](Invoke-Lob $base $key "Post" ("/bank_accounts/" + $bank.id + "/verify") @{ amounts = @(25, 63) } "")
    }
    $existingAddresses = @((Invoke-Lob $base $key "Get" "/addresses?limit=20" $null "").data | Where-Object { -not $_.deleted })
    if (-not $existingAddresses.Count) {
      [void](Invoke-Lob $base $key "Post" "/addresses" @{ description = "rehearsal return address"; name = "Rehearsal Sender"; email = "rehearsal@example.org"; address_line1 = "210 King St"; address_city = "San Francisco"; address_state = "CA"; address_zip = "94107"; address_country = "US" } "")
    }
    $Mode = "configure"
  }
  # The one verified bank account and the one saved address, unless named.
  $banks = @((Invoke-Lob $base $key "Get" "/bank_accounts?limit=20" $null "").data | Where-Object { $_.verified -and -not $_.deleted })
  $addresses = @((Invoke-Lob $base $key "Get" "/addresses?limit=20" $null "").data | Where-Object { -not $_.deleted })
  if ($Mode -in @("configure", "selftest")) {
    $bank = if ($BankAccount) { $banks | Where-Object { $_.id -eq $BankAccount } } elseif ($banks.Count -eq 1) { $banks[0] } else { $null }
    $address = if ($FromAddress) { $addresses | Where-Object { $_.id -eq $FromAddress } } elseif ($addresses.Count -eq 1) { $addresses[0] } else { $null }
    if (-not $bank -or -not $address) {
      # Ids and the labels the user gave them, never an account or street.
      @{
        configured = $false
        verifiedBankAccounts = @($banks | ForEach-Object { @{ id = $_.id; description = [string]$_.description; bank = [string]$_.bank_name } })
        addresses = @($addresses | ForEach-Object { @{ id = $_.id; description = [string]$_.description; hasEmail = [bool]$_.email } })
      } | ConvertTo-Json -Compress -Depth 5
      exit 2
    }
    if (-not $address.email) { throw "The saved return address needs an email (add it in Lob's dashboard)" }
    $chosen = [pscustomobject]@{ bankAccount = $bank.id; fromAddress = $address.id }
    if ($Mode -eq "configure") {
      New-Item -ItemType Directory -Force -Path $profileDirectory | Out-Null
      [System.IO.File]::WriteAllText($settingsPath, ($chosen | ConvertTo-Json -Compress), $utf8)
      @{ configured = $true; environment = (Get-Environment $key) } | ConvertTo-Json -Compress
      exit 0
    }
    $settings = $chosen
  } else {
    $settings = Read-Settings
    if (-not $settings.bankAccount -or -not $settings.fromAddress) { throw "Not configured" }
  }

  $text = [Console]::In.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($text) -or $text.Length -gt 200000) { throw "Invalid request size" }
  Send-Check $base $key $settings ($text | ConvertFrom-Json) | ConvertTo-Json -Compress
} catch {
  $status = 0
  $code = "mailed-check-bridge-failed"
  if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
    $status = [int]$_.Exception.Response.StatusCode
    try {
      $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream(), $utf8)
      $lobCode = ($reader.ReadToEnd() | ConvertFrom-Json).error.code
      if ($lobCode -match '^[a-z0-9_]{1,60}$') { $code = "lob:" + $lobCode }
    } catch {}
  } elseif ($_.Exception.Message -match '^(Credential unavailable|Not configured|Invalid [a-z ]+|Unexpected [a-z ]+|The [A-Za-z ''()]+|selftest needs -SelfTestBase|-SelfTestBase is for selftest only)$') {
    $code = $_.Exception.Message
  }
  @{ error = $code; httpStatus = $status } | ConvertTo-Json -Compress
  exit 1
}
