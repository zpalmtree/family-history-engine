param(
  [string]$ProjectRoot
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $ProjectRoot) {
  $ProjectRoot = Split-Path -Parent $ScriptDir
}
$HashTool = Join-Path $ScriptDir "hash-viewer-password.mjs"

try {
  Write-Host "Configure the protected family viewer" -ForegroundColor Cyan
  Write-Host "Your passphrase stays in this terminal and is never sent to chat, Git, or a file."
  $passwordHash = & node.exe $HashTool --value-only
  if ($LASTEXITCODE -ne 0 -or -not $passwordHash) {
    throw "Passphrase hashing did not complete."
  }
  $passwordHash | & npx.cmd --yes vercel@55.0.0 env add VIEWER_PASSWORD_HASH production --sensitive --force --yes --cwd $ProjectRoot --no-color
  if ($LASTEXITCODE -ne 0) {
    throw "Vercel did not accept VIEWER_PASSWORD_HASH."
  }
  Remove-Variable passwordHash

  $sessionSecret = & node.exe -e "process.stdout.write(require('crypto').randomBytes(48).toString('base64url'))"
  $sessionSecret | & npx.cmd --yes vercel@55.0.0 env add VIEWER_SESSION_SECRET production --sensitive --force --yes --cwd $ProjectRoot --no-color
  if ($LASTEXITCODE -ne 0) {
    throw "Vercel did not accept VIEWER_SESSION_SECRET."
  }
  Remove-Variable sessionSecret
  Write-Host "Both production secrets are configured." -ForegroundColor Green
} catch {
  Write-Host $_ -ForegroundColor Red
} finally {
  Read-Host "Press Enter to close this window"
}
