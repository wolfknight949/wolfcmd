@echo off
rem Double-click: builds the current code and installs it as your daily WolfCmd.
rem The steps are in tools\local\install.ps1.
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\local\install.ps1" %*
if errorlevel 1 pause
