@echo off
rem One-time setup: installs the Python package the tools use (SimConnect for placement).
call "%~dp0_python.bat" || exit /b 1
echo Installing the SimConnect package for %PY% ...
%PY% -m pip install --upgrade -r "%~dp0requirements.txt"
echo.
echo Setup done. Next: start a flight with the tower cab, then run 2-adjust-KDCA.bat
pause
