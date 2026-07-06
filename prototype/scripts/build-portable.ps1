param(
  [switch]$CheckOnly
)

$ErrorActionPreference = "Stop"

$projectDir = Split-Path -Parent $PSScriptRoot
$electronDist = Join-Path $projectDir "node_modules\electron\dist"
if (!(Test-Path -LiteralPath (Join-Path $electronDist "electron.exe"))) {
  throw "Electron runtime not found. Run npm.cmd install first."
}

$outRoot = Join-Path $projectDir "dist"
$outDir = Join-Path $outRoot "AI-Council-Portable"
$appDir = Join-Path $outDir "resources\app"
$zipPath = Join-Path $outRoot "AI-Council-Portable.zip"

if ($CheckOnly) {
  Write-Host "AI Council portable build check OK:"
  Write-Host $electronDist
  exit 0
}

if (Test-Path -LiteralPath $outDir) {
  $resolvedOutDir = [System.IO.Path]::GetFullPath($outDir)
  $portableLeaf = [System.IO.Path]::Combine("dist", "AI-Council-Portable")
  if (!$resolvedOutDir.EndsWith($portableLeaf, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to delete unexpected portable output path: $resolvedOutDir"
  }
  Remove-Item -LiteralPath $resolvedOutDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
Copy-Item -Path (Join-Path $electronDist "*") -Destination $outDir -Recurse -Force
Rename-Item -LiteralPath (Join-Path $outDir "electron.exe") -NewName "AI-Council.exe"
New-Item -ItemType Directory -Force -Path $appDir | Out-Null

$includeDirs = @("desktop", "src")
foreach ($dir in $includeDirs) {
  Copy-Item -LiteralPath (Join-Path $projectDir $dir) -Destination $appDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path (Join-Path $appDir "renderer") | Out-Null
Copy-Item -LiteralPath (Join-Path $projectDir "renderer\out") -Destination (Join-Path $appDir "renderer") -Recurse -Force
New-Item -ItemType Directory -Force -Path (Join-Path $appDir "config") | Out-Null
$includeConfigFiles = @("group.example.json", "group.real.example.json")
foreach ($file in $includeConfigFiles) {
  Copy-Item -LiteralPath (Join-Path $projectDir "config\$file") -Destination (Join-Path $appDir "config") -Force
}
$includeFiles = @("package.json", "package-lock.json", "start-desktop.ps1", ".env.example", "README.md")
foreach ($file in $includeFiles) {
  Copy-Item -LiteralPath (Join-Path $projectDir $file) -Destination $appDir -Force
}

$bat = @"
@echo off
chcp 65001 >nul
set ELECTRON_NO_ATTACH_CONSOLE=1
"%~dp0AI-Council.exe" "%~dp0resources\app\desktop\main.mjs"
if errorlevel 1 pause
"@
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $outDir "AI-Council.bat"), $bat, $utf8NoBom)

if (Test-Path -LiteralPath $zipPath) {
  Remove-Item -LiteralPath $zipPath -Force
}
Compress-Archive -LiteralPath $outDir -DestinationPath $zipPath

Write-Host "AI Council portable build ready:"
Write-Host $outDir
Write-Host $zipPath
