@echo off
rem Every session: jumps the cab to the saved KDCA tower position and freezes it.
call "%~dp0_python.bat" || exit /b 1
%PY% "%~dp0tower_place.py" place KDCA
timeout /t 5
