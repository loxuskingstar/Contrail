@echo off
rem Double-cliquer pour fabriquer l'installeur Windows (dist\Contrail-<version>-Windows-Setup.exe).
rem Prerequis : Python 3.11+ et Inno Setup 6 (winget install JRSoftware.InnoSetup).
rem Options acceptees : -Version 4.3.0   -SkipPyInstaller   -Clean
cd /d "%~dp0\.."
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-setup.ps1" %*
echo.
pause
