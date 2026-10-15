# VATFLOW Tower Cab - removes the sample aircraft's sounds from the MSFS project.
# Called by install.bat:  powershell -ExecutionPolicy Bypass -File silence-sounds.ps1 <project> <aircraft folder>
# Every "sound" folder under the aircraft is moved to <project>\backup-sound\<same path> (once;
# an existing backup is kept) and replaced by the silent sound.xml shipped next to this script.
# To undo: copy the folders from backup-sound back over them.
param([string]$Project, [string]$Aircraft)
$ErrorActionPreference = "Stop"
$silent = Join-Path $PSScriptRoot "sound.xml"
$found = @(Get-ChildItem -Path $Aircraft -Recurse -Directory -Filter sound -ErrorAction SilentlyContinue)
if ($found.Count -eq 0) {
    $found = @(New-Item -ItemType Directory -Force -Path (Join-Path (Join-Path $Aircraft "common") "sound"))
}
foreach ($dir in $found) {
    $rel = $dir.FullName.Substring($Project.TrimEnd('\', '/').Length).TrimStart('\', '/')
    $backup = Join-Path (Join-Path $Project "backup-sound") $rel
    $files = @(Get-ChildItem -Path $dir.FullName -Recurse -File)
    $alreadySilent = ($files.Count -eq 1) -and ($files[0].Name -eq "sound.xml") -and
        ((Get-Content $files[0].FullName -Raw) -match "VATFLOW Tower Cab: no aircraft sounds")
    if (-not $alreadySilent -and $files.Count -gt 0 -and -not (Test-Path $backup)) {
        New-Item -ItemType Directory -Force -Path $backup | Out-Null
        Copy-Item -Path (Join-Path $dir.FullName "*") -Destination $backup -Recurse -Force
        Write-Host "  sounds backed up: $rel -> backup-sound"
    }
    Get-ChildItem -Path $dir.FullName -Force | Remove-Item -Recurse -Force
    Copy-Item -Path $silent -Destination (Join-Path $dir.FullName "sound.xml")
    Write-Host "  silenced: $rel"
}
