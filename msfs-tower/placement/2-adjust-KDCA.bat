@echo off
rem Puts the cab on the KDCA tower, then lets you nudge it and save. Use this the first time.
call "%~dp0_python.bat" || exit /b 1
echo Make sure MSFS is running with the tower cab loaded at KDCA.
echo Tip: look from outside (drone/external view) while you nudge.
echo.
%PY% "%~dp0tower_place.py" adjust KDCA
pause
