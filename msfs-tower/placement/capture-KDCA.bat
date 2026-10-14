@echo off
rem Saves wherever the cab is right now as the KDCA tower position (e.g. after moving it in slew mode).
call "%~dp0_python.bat" || exit /b 1
%PY% "%~dp0tower_place.py" capture KDCA
pause
