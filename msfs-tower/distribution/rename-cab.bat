@echo off
rem VATFLOW Tower Cab - change the cab's name in the MSFS 2024 aircraft list.
rem Close the project in MSFS first; Build All afterwards.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0rename-cab.ps1" "%~dp0.."
pause
