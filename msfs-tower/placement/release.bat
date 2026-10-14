@echo off
rem Unfreezes the cab (so you can slew it by hand).
call "%~dp0_python.bat" || exit /b 1
%PY% "%~dp0tower_place.py" release
timeout /t 5
