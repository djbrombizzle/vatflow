# VATFLOW Tower Cab - removes the sample aircraft's sounds from the MSFS project.
# Called by install.bat:  powershell -ExecutionPolicy Bypass -File silence-sounds.ps1 <project> <aircraft folder>
# Every "sound" folder under the aircraft is moved to <project>\backup-sound\<same path> (once;
# an existing backup is kept) and replaced by the silent sound.xml shipped next to this script.
# Windshear alarm: when <project>\sound-package\VATFLOW_TowerCab.PC.PCK exists (built in Wwise,
# see sound-package\README.md), it goes in instead with sound-alarm.xml as the sound.xml: the
# alarm and nothing else.
# To undo: copy the folders from backup-sound back over them.
param([string]$Project, [string]$Aircraft)
$ErrorActionPreference = "Stop"
$silent = Join-Path $PSScriptRoot "sound.xml"
$pck = Join-Path (Join-Path $Project "sound-package") "VATFLOW_TowerCab.PC.PCK"
$withAlarm = Test-Path $pck
if ($withAlarm) { $silent = Join-Path $PSScriptRoot "sound-alarm.xml"; Write-Host "  windshear alarm sound: $pck" }
$found = @(Get-ChildItem -Path $Aircraft -Recurse -Directory -Filter sound -ErrorAction SilentlyContinue)
if ($found.Count -eq 0) {
    $found = @(New-Item -ItemType Directory -Force -Path (Join-Path (Join-Path $Aircraft "common") "sound"))
}
foreach ($dir in $found) {
    $rel = $dir.FullName.Substring($Project.TrimEnd('\', '/').Length).TrimStart('\', '/')
    $backup = Join-Path (Join-Path $Project "backup-sound") $rel
    $files = @(Get-ChildItem -Path $dir.FullName -Recurse -File)
    # ours already (the silent or the alarm-only sound.xml, maybe with the alarm package): no backup
    $xml = $files | Where-Object { $_.Name -eq "sound.xml" } | Select-Object -First 1
    $alreadySilent = ($null -ne $xml) -and ((Get-Content $xml.FullName -Raw) -match "VATFLOW Tower Cab:") -and
        (@($files | Where-Object { $_.Name -ne "sound.xml" -and $_.Name -notlike "VATFLOW_TowerCab*.PC.PCK" }).Count -eq 0)
    if (-not $alreadySilent -and $files.Count -gt 0 -and -not (Test-Path $backup)) {
        New-Item -ItemType Directory -Force -Path $backup | Out-Null
        Copy-Item -Path (Join-Path $dir.FullName "*") -Destination $backup -Recurse -Force
        Write-Host "  sounds backed up: $rel -> backup-sound"
    }
    Get-ChildItem -Path $dir.FullName -Force | Remove-Item -Recurse -Force
    Copy-Item -Path $silent -Destination (Join-Path $dir.FullName "sound.xml")
    if ($withAlarm) {
        Copy-Item -Path $pck -Destination (Join-Path $dir.FullName "VATFLOW_TowerCab.PC.PCK")
        Write-Host "  silenced, windshear alarm only: $rel"
    } else { Write-Host "  silenced: $rel" }
}
