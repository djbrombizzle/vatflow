@echo off
setlocal
rem VATFLOW Ramp Control Tower - makes a second MSFS project next to your VATFLOW Tower Cab
rem project (a copy of it, with the ramp tower model, its screens and its own package name),
rem so the sim's own package builder builds it, the same way as the cab.
set "SRC=C:\MSFS-Projects\VatflowTowerCab"
set "DST=C:\MSFS-Projects\VatflowRampTower"

echo VATFLOW Ramp Control Tower - new MSFS project
echo   from your cab project: %SRC%
echo   new project:           %DST%
echo Your cab project is only read, never changed.
echo.
pause

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-ramp-tower.ps1" "%SRC%" "%DST%" "%~dp0files"
if errorlevel 1 (
  pause
  exit /b 1
)

echo.
echo Done. Now in MSFS (Developer Mode):
echo   1. File ^> Open project... ^> %DST%\SimpleAircraftProject.xml
echo   2. Clean All, then Build All
echo   3. Start a flight at KATL with "VATFLOW Ramp Control Tower" (crash damage OFF)
echo To play it without the project open: copy %DST%\Packages\vatflow-ramp-tower into Community.
echo.
pause
