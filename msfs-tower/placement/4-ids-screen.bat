@echo off
rem vZDC IDS on the TMU desk's third screen: opens the IDS in Edge (log in once with VATSIM)
rem and mirrors it to the cab screen. Minimize the Edge window; closing this window stops it.
call "%~dp0_python.bat" || exit /b 1
%PY% "%~dp0web_mirror.py" https://ids.vzdc.org/app/airport/KDCA 8777
pause
