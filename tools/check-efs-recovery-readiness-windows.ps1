[CmdletBinding()]
param(
  [string]$ArchivePath,
  [string]$ReceiptPath,
  [ValidateRange(1, 3650)]
  [int]$MaxRestoreDrillAgeDays = 370
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$issues = [Collections.Generic.List[string]]::new()
$archiveAvailable = $false
$fileCount = 0
$allFilesEncrypted = $false
$readProbePassed = $false
$validEfsCertificateWithPrivateKeyPresent = $false
$certificateBackupRecorded = $false
$independentRestoreDrillCurrent = $false

if ([string]::IsNullOrWhiteSpace($ArchivePath)) {
  if ([string]::IsNullOrWhiteSpace($env:OneDrive)) {
    [void]$issues.Add("onedrive-location-unavailable")
  }
  else {
    $ArchivePath = Join-Path $env:OneDrive "Documents\FamilyHistorySourceMasters"
  }
}

if ([string]::IsNullOrWhiteSpace($ReceiptPath) -and -not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
  $ReceiptPath = Join-Path $env:LOCALAPPDATA "ZacharyPalmerFamilyHistory\EfsRecoveryReadiness.json"
}

if (-not [string]::IsNullOrWhiteSpace($ArchivePath) -and (Test-Path -LiteralPath $ArchivePath -PathType Container)) {
  $archiveAvailable = $true
  try {
    $files = @(Get-ChildItem -LiteralPath $ArchivePath -File -Recurse -Force)
    $fileCount = $files.Count
    if ($fileCount -eq 0) {
      [void]$issues.Add("archive-empty")
    }
    else {
      $unencryptedCount = @($files | Where-Object {
        -not ($_.Attributes -band [IO.FileAttributes]::Encrypted)
      }).Count
      $allFilesEncrypted = $unencryptedCount -eq 0
      if (-not $allFilesEncrypted) {
        [void]$issues.Add("archive-has-unencrypted-files")
      }

      # Opening one byte from a small sample proves that the current account can
      # decrypt local archive files. No filename, path, or content is emitted.
      $probeFiles = @($files | Sort-Object -Property Name | Select-Object -First 3)
      $failedProbeCount = 0
      foreach ($file in $probeFiles) {
        $stream = $null
        try {
          $stream = [IO.File]::Open(
            $file.FullName,
            [IO.FileMode]::Open,
            [IO.FileAccess]::Read,
            [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
          )
          if ($stream.Length -gt 0) {
            [void]$stream.ReadByte()
          }
        }
        catch {
          $failedProbeCount += 1
        }
        finally {
          if ($null -ne $stream) {
            $stream.Dispose()
          }
        }
      }
      $readProbePassed = $probeFiles.Count -gt 0 -and $failedProbeCount -eq 0
      if (-not $readProbePassed) {
        [void]$issues.Add("local-decryption-read-probe-failed")
      }
    }
  }
  catch {
    [void]$issues.Add("archive-scan-failed")
  }
}
else {
  [void]$issues.Add("archive-unavailable")
}

try {
  $now = Get-Date
  $efsCertificates = @(Get-ChildItem Cert:\CurrentUser\My | Where-Object {
    $_.EnhancedKeyUsageList.ObjectId -contains "1.3.6.1.4.1.311.10.3.4"
  })
  $validCertificates = @($efsCertificates | Where-Object {
    $_.HasPrivateKey -and $_.NotBefore -le $now -and $_.NotAfter -gt $now
  })
  $validEfsCertificateWithPrivateKeyPresent = $validCertificates.Count -gt 0
  if (-not $validEfsCertificateWithPrivateKeyPresent) {
    [void]$issues.Add("valid-local-efs-certificate-with-private-key-missing")
  }
}
catch {
  [void]$issues.Add("certificate-store-check-failed")
}

if (-not [string]::IsNullOrWhiteSpace($ReceiptPath) -and (Test-Path -LiteralPath $ReceiptPath -PathType Leaf)) {
  try {
    $receipt = Get-Content -LiteralPath $ReceiptPath -Raw | ConvertFrom-Json
    if ($receipt.schemaVersion -ne 1) {
      throw "Unsupported receipt schema."
    }

    $backupDate = [DateTimeOffset]::ParseExact(
      [string]$receipt.certificateBackupVerifiedAt,
      "yyyy-MM-dd",
      [Globalization.CultureInfo]::InvariantCulture
    )
    $drillDate = [DateTimeOffset]::ParseExact(
      [string]$receipt.independentRestoreDrillVerifiedAt,
      "yyyy-MM-dd",
      [Globalization.CultureInfo]::InvariantCulture
    )
    $today = [DateTimeOffset]::UtcNow.Date
    $certificateBackupRecorded = $backupDate.Date -le $today
    $drillAgeDays = ($today - $drillDate.Date).TotalDays
    $independentRestoreDrillCurrent = $drillAgeDays -ge 0 -and $drillAgeDays -le $MaxRestoreDrillAgeDays

    if (-not $certificateBackupRecorded) {
      [void]$issues.Add("external-certificate-backup-not-recorded")
    }
    if (-not $independentRestoreDrillCurrent) {
      [void]$issues.Add("independent-restore-drill-overdue")
    }
  }
  catch {
    [void]$issues.Add("recovery-receipt-invalid")
  }
}
else {
  [void]$issues.Add("recovery-receipt-missing")
}

$recoveryReady = $archiveAvailable `
  -and $fileCount -gt 0 `
  -and $allFilesEncrypted `
  -and $readProbePassed `
  -and $validEfsCertificateWithPrivateKeyPresent `
  -and $certificateBackupRecorded `
  -and $independentRestoreDrillCurrent

[pscustomobject]@{
  schemaVersion = 1
  status = if ($recoveryReady) { "ready" } else { "needs-user" }
  archiveAvailable = $archiveAvailable
  fileCount = $fileCount
  allFilesEncrypted = $allFilesEncrypted
  localDecryptionReadProbePassed = $readProbePassed
  validEfsCertificateWithPrivateKeyPresent = $validEfsCertificateWithPrivateKeyPresent
  externalCertificateBackupRecorded = $certificateBackupRecorded
  independentRestoreDrillCurrent = $independentRestoreDrillCurrent
  maxRestoreDrillAgeDays = $MaxRestoreDrillAgeDays
  recoveryReady = $recoveryReady
  issues = @($issues)
} | ConvertTo-Json -Compress

if (-not $recoveryReady) {
  exit 1
}
