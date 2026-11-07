# Construit l'installeur Windows : PyInstaller -> dist\Contrail, puis Inno Setup -> dist\Contrail-<version>-Windows-Setup.exe
# Usage (depuis n'importe quel dossier) :  powershell -ExecutionPolicy Bypass -File scripts\build-setup.ps1
#   options : -Version 3.0.1   -SkipPyInstaller (reutilise dist\Contrail)   -Clean (supprime build\ et dist\ avant)
param([string]$Version = "", [switch]$SkipPyInstaller, [switch]$Clean)
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

# Python : py -3 ou python
$Py = $null
foreach ($c in @("py", "python")) { if (Get-Command $c -ErrorAction SilentlyContinue) { $Py = $c; break } }
if (-not $Py) { throw "Python introuvable dans le PATH." }
$PyArgs = @(); if ($Py -eq "py") { $PyArgs = @("-3") }

# Version : argument, sinon APP_VERSION de app\core.py
if (-not $Version) {
    $m = Select-String -Path "app\core.py" -Pattern 'APP_VERSION\s*=\s*"([^"]+)"' | Select-Object -First 1
    if (-not $m) { throw "APP_VERSION introuvable dans app\core.py" }
    $Version = $m.Matches[0].Groups[1].Value
}
Write-Host "== Contrail $Version ==" -ForegroundColor Cyan

if ($Clean) { Write-Host "-- Nettoyage"; Remove-Item -Recurse -Force build, dist -ErrorAction SilentlyContinue }

if (-not $SkipPyInstaller) {
    Write-Host "-- Dependances"
    & $Py @PyArgs -m pip install -q -r requirements.txt pyinstaller pystray
    if ($LASTEXITCODE) { throw "pip a echoue" }
    Write-Host "-- PyInstaller"
    & $Py @PyArgs -m PyInstaller --noconfirm desktop\contrail.spec
    if ($LASTEXITCODE) { throw "PyInstaller a echoue" }
}
if (-not (Test-Path "dist\Contrail\Contrail.exe")) { throw "dist\Contrail\Contrail.exe introuvable" }

# Inno Setup : PATH, puis emplacements habituels (installation globale ou par utilisateur)
$Iscc = $null
$cmd = Get-Command iscc -ErrorAction SilentlyContinue
if ($cmd) { $Iscc = $cmd.Source }
if (-not $Iscc) {
    $dirs = @($env:LOCALAPPDATA, $env:ProgramFiles, ${env:ProgramFiles(x86)}) | Where-Object { $_ }
    foreach ($d in $dirs) {
        foreach ($sub in @("Programs\Inno Setup 6", "Inno Setup 6")) {
            $p = Join-Path $d "$sub\ISCC.exe"
            if (Test-Path $p) { $Iscc = $p; break }
        }
        if ($Iscc) { break }
    }
}
if (-not $Iscc) { throw "ISCC.exe introuvable. Installe Inno Setup 6 :  winget install JRSoftware.InnoSetup" }

Write-Host "-- Inno Setup ($Iscc)"
& $Iscc "/DAppVersion=$Version" "/DSourceDir=$Root\dist\Contrail" "desktop\windows\contrail.iss"
if ($LASTEXITCODE) { throw "Inno Setup a echoue" }

$Out = Get-Item "dist\Contrail-$Version-Windows-Setup.exe"
Write-Host ("`nOK : {0}  ({1:N1} Mo)" -f $Out.FullName, ($Out.Length / 1MB)) -ForegroundColor Green
