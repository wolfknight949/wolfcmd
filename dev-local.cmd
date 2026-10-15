@echo off
rem Double-click: WolfCmd with hot reload, on test data or on your own workspaces (it asks).
rem The steps are in tools\local\dev.ps1.
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\local\dev.ps1" %*
if errorlevel 1 pause
