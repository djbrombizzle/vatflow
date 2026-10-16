@echo off
rem VATFLOW Tower Cab - what VATFLOW-TowerCab-Setup.exe runs once it has unpacked itself.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1"
