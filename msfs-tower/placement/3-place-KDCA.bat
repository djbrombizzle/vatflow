@echo off
rem Every session: jumps the cab to the saved KDCA tower position, freezes it, turns the
rem engine off and plays a quiet cab fan sound. Minimize this window; close it to stop the fan.
call "%~dp0_python.bat" || exit /b 1
%PY% "%~dp0tower_place.py" place KDCA --fan
timeout /t 5
