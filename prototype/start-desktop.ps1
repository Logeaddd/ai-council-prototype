$CheckOnly = $args -contains "-CheckOnly"
$ErrorActionPreference = "Stop"

$projectDir = $PSScriptRoot
Set-Location -LiteralPath $projectDir
$env:NODE_OPTIONS = "--use-system-ca"

if ($CheckOnly) {
  Write-Host "AI Council startup script OK:"
  Write-Host $projectDir
  exit 0
}

if (!(Test-Path -LiteralPath "node_modules\electron")) {
  Write-Host "Electron dependencies were not found."
  Write-Host "Running npm.cmd install with system certificate store..."
  npm.cmd install
  if ($LASTEXITCODE -ne 0) {
    Write-Host "npm.cmd install failed. Please check the certificate or network settings."
    Read-Host "Press Enter to exit"
    exit $LASTEXITCODE
  }
}

npm.cmd run desktop
if ($LASTEXITCODE -ne 0) {
  Write-Host "AI Council desktop failed to start."
  Read-Host "Press Enter to exit"
  exit $LASTEXITCODE
}
