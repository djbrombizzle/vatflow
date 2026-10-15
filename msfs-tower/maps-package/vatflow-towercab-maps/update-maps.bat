@echo off
rem VATFLOW Tower Cab - ARTCC video maps: puts the ARTCC files where the cab reads them and
rem updates this package's file list (layout.json), which MSFS needs to see new files.
rem   1. Put ARTCC files (e.g. ZTL.json from vNAS) in the "ARTCC files" folder next to this,
rem      or type ARTCC ids below and they are downloaded from vNAS.
rem   2. Restart the flight (or the sim) so the cab reads them.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update-maps.ps1" "%~dp0."
pause
