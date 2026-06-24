param(
  [switch]$CheckOnly
)

$ErrorActionPreference = "Stop"

$projectDir = Split-Path -Parent $PSScriptRoot
$startScript = Join-Path $projectDir "start-desktop.ps1"
if (!(Test-Path -LiteralPath $startScript)) {
  throw "Missing start script: $startScript"
}

$desktop = [Environment]::GetFolderPath("Desktop")
if (![string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
  $candidate = Join-Path $env:USERPROFILE "Desktop"
  if (Test-Path -LiteralPath $candidate) {
    $desktop = $candidate
  }
}
if (!(Test-Path -LiteralPath $desktop)) {
  throw "Desktop folder not found: $desktop"
}

$shortcutName = "AI" + [char]0x5c0f + [char]0x7ec4 + [char]0x542f + [char]0x52a8 + ".bat"
$shortcutBat = Join-Path $desktop $shortcutName
$helperPs1 = Join-Path $desktop "ai-council-start.ps1"
$encodedProjectDir = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($projectDir))

$helper = @"
`$ErrorActionPreference = "Stop"
`$encodedProjectDir = "$encodedProjectDir"
`$projectDir = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String(`$encodedProjectDir))
`$startScript = Join-Path `$projectDir "start-desktop.ps1"
if (!(Test-Path -LiteralPath `$startScript)) {
  Write-Host "Failed to enter project folder:"
  Write-Host `$projectDir
  Read-Host "Press Enter to exit"
  exit 1
}
& powershell -NoProfile -ExecutionPolicy Bypass -File `$startScript @args
exit `$LASTEXITCODE
"@

$bat = @"
@echo off
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0ai-council-start.ps1" %*
if errorlevel 1 pause
"@

if (!$CheckOnly) {
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($helperPs1, $helper, $utf8NoBom)
  [System.IO.File]::WriteAllText($shortcutBat, $bat, $utf8NoBom)
}

Write-Host "AI Council desktop shortcut ready:"
Write-Host $shortcutBat
Write-Host "Project:"
Write-Host $projectDir
