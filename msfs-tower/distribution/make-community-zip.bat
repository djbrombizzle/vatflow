@echo off
rem Makes a Community-folder zip of the tower cab to give to friends:
rem   1. In MSFS: open the project, Clean All, Build All (so Packages\ has the latest build)
rem   2. Double-click this file. The zip lands on your Desktop.
rem It checks that no VATSIM CID is inside, names the package vatflow-towercab and adds
rem install instructions for your friends.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0make-community-zip.ps1" "%~dp0.."
pause
