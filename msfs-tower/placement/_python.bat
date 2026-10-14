@echo off
rem Finds Python for the other .bat files: sets PY, or explains how to install it.
set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY where python >nul 2>nul && set "PY=python"
if not defined PY (
  echo Python was not found.
  echo Install it once from https://www.python.org/downloads/  ^(tick "Add python.exe to PATH"^)
  echo or run:  winget install Python.Python.3.12
  echo then run 1-setup.bat again.
  pause
  exit /b 1
)
exit /b 0
