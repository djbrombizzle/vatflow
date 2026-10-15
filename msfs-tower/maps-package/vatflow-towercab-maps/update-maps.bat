@echo off
rem VATFLOW Tower Cab - ARTCC video maps: puts the ARTCC files where the cab reads them and
rem updates this package's file list (layout.json), which MSFS needs to see new files.
rem   1. It offers the ARTCC files CRC has (%LOCALAPPDATA%\CRC), takes any .json you put in the
rem      "ARTCC files" folder next to this, or downloads ARTCC ids you type from vNAS.
rem   2. Restart the flight (or the sim) so the cab reads them.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update-maps.ps1" "%~dp0."
pause
