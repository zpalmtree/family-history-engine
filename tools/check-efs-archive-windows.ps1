$ErrorActionPreference = "Stop"
$archive = Join-Path $env:OneDrive "Documents\FamilyHistorySourceMasters"
if (-not (Test-Path -LiteralPath $archive -PathType Container)) {
  throw "The source-master archive is unavailable."
}

$files = @(Get-ChildItem -LiteralPath $archive -File)
$unencrypted = @($files | Where-Object { -not ($_.Attributes -band [IO.FileAttributes]::Encrypted) })
$efsCertificates = @(Get-ChildItem Cert:\CurrentUser\My | Where-Object {
  $_.EnhancedKeyUsageList.ObjectId -contains "1.3.6.1.4.1.311.10.3.4"
})
$efsCertificatesWithPrivateKey = @($efsCertificates | Where-Object { $_.HasPrivateKey })

[pscustomobject]@{
  archiveAvailable = $true
  fileCount = $files.Count
  encryptedFileCount = $files.Count - $unencrypted.Count
  unencryptedFileCount = $unencrypted.Count
  efsCertificateCount = $efsCertificates.Count
  efsCertificateWithPrivateKeyCount = $efsCertificatesWithPrivateKey.Count
} | ConvertTo-Json -Compress

if ($unencrypted.Count -gt 0) {
  throw "$($unencrypted.Count) source master(s) are not EFS encrypted."
}
