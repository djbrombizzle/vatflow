@echo off
rem DCA Tower Cab - set up the MSFS project (drag the project folder onto this file, or type it)
set "PROJ=%~1"
if "%PROJ%"=="" set /p "PROJ=Project folder (with SimpleAircraftProject.xml): "
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-project.ps1" "%PROJ%"
pause
