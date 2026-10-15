@echo off
rem Makes a Community-folder zip of the tower cab to give to friends:
rem   1. In MSFS: open the project, Clean All, Build All (so Packages\ has the latest build)
rem   2. Double-click this file. Two zips land on your Desktop: the cab, and the ARTCC
rem      video maps package (empty: testers add their own ARTCC file).
rem It checks that no VATSIM CID is inside, names the package vatflow-towercab and adds
rem install instructions for your friends.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0make-community-zip.ps1" "%~dp0.."
pause
