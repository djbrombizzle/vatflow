# VATFLOW Tower Cab - builds the zips for testers from the project:
#   vatflow-towercab-test.zip   the cab (from the built package in Packages\)
#   vatflow-towercab-maps.zip   the ARTCC video maps package, empty (testers add their own ARTCC file)
#   make-community-zip.ps1 <project folder>
param([string]$Proj)
$ErrorActionPreference = "Stop"
$Name = "vatflow-towercab"
$Title = "VATFLOW Tower Cab (test)"
$Proj = (Resolve-Path $Proj).Path
$utf8 = New-Object Text.UTF8Encoding($false)
$desktop = [Environment]::GetFolderPath("Desktop")

$pkgRoot = Join-Path $Proj "Packages"
if (-not (Test-Path $pkgRoot)) { Write-Host "ERROR: $pkgRoot not found. In MSFS: open the project and Build All first."; exit 1 }
$pkg = Get-ChildItem $pkgRoot -Directory | Where-Object {
  Test-Path (Join-Path $_.FullName "html_ui\Pages\VCockpit\Instruments\VatflowTower\Screen")
} | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $pkg) { Write-Host "ERROR: no built tower cab package in $pkgRoot (with the new screens). Build All in MSFS first."; exit 1 }
Write-Host "Built package: $($pkg.FullName)  (built $($pkg.LastWriteTime))"

# never ship anyone's VATSIM CID (it is typed in the cab now, but an old airport.js could have one)
$withCid = Get-ChildItem $pkg.FullName -Recurse -Filter *.js | Select-String -Pattern 'cid:\s*"\d+' -List
if ($withCid) {
  Write-Host "ERROR: a VATSIM CID is inside the package:"
  $withCid | ForEach-Object { Write-Host "   $($_.Path)" }
  Write-Host "Run the latest install.bat (it clears it), Build All again, then run this again."
  exit 1
}

# ---- the cab -------------------------------------------------------------------------
$stage = Join-Path $env:TEMP "vatflow-towercab-zip"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory $stage | Out-Null
$dst = Join-Path $stage $Name
Copy-Item $pkg.FullName $dst -Recurse

# package title shown in the sim's content manager (layout.json doesn't list manifest.json)
$manifest = Join-Path $dst "manifest.json"
if (Test-Path $manifest) {
  $m = Get-Content $manifest -Raw | ConvertFrom-Json
  $m.title = $Title
  if ($m.PSObject.Properties.Name -contains "creator") { $m.creator = "VATFLOW" }
  [IO.File]::WriteAllText($manifest, ($m | ConvertTo-Json -Depth 20), $utf8)
}

$readme = @"
VATFLOW Tower Cab (test build)
==============================

Install
  1. Close MSFS 2024.
  2. Unzip. Move the folder "$Name" into your MSFS 2024 Community folder, the same
     place as your other add-ons. Usually:
       MS Store / Game Pass: %LOCALAPPDATA%\Packages\Microsoft.Limitless_8wekyb3d8bbwe\LocalCache\Packages\Community
       Steam:                %APPDATA%\Microsoft Flight Simulator 2024\Packages\Community
     (or "Community" inside the folder you chose when installing the sim)
  3. Optional, ARTCC video maps: unzip vatflow-towercab-maps.zip into Community too, put
     your ARTCC's .json file (e.g. ZTL.json) in its "ARTCC files" folder and double-click
     update-maps.bat there (see its README).
  4. Start MSFS. New Community packages are only read when the sim starts.

Fly
  1. Aircraft: "VATFLOW Tower Cab". In MSFS: Assistance > crash damage OFF.
  2. Start at any parking spot at the airport you control (cold and dark).
  3. Wait ~10 seconds: the cab finds the airport and goes up into the tower by itself
     (when it knows a tower spot: KDCA is tuned, elsewhere OpenStreetMap's tower).

In the cab
  - Every big screen has a MENU tab (bottom right): pick what it shows (DBRITE, ASDE-X,
    IDST, VATSMART, demand vs AAR, aircraft list, TOWER SETUP ...).
  - MENU > TOWER SETUP: PLACE IN TOWER, nudge the cab onto the real tower (FWD / BACK /
    LEFT / RIGHT / UP / DOWN / TURN, FINE / MEDIUM / BIG steps), SAVE THIS SPOT.
    VATSIM CID > EDIT: type your CID (needed to issue IDST releases).
  - DBRITE / ASDE-X: MAPS tab (next to MENU) for the ARTCC video maps, with presets.
  - Brightness: the four knobs on the console. Overhead monitors: drag to move / swivel.

Uninstall: delete "$Name" (and "vatflow-towercab-maps") from Community.
"@
[IO.File]::WriteAllText((Join-Path $stage "READ ME - install.txt"), $readme, $utf8)

$zip = Join-Path $desktop "$Name-test.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip
Remove-Item $stage -Recurse -Force
Write-Host "Cab:  $zip"

# ---- the ARTCC video maps package ------------------------------------------------------
# where it is: Community (found from UserCfg.opt), else the copy in the project
$maps = $null
foreach ($c in @((Join-Path $env:APPDATA "Microsoft Flight Simulator 2024\UserCfg.opt"),
                 (Join-Path $env:LOCALAPPDATA "Packages\Microsoft.Limitless_8wekyb3d8bbwe\LocalCache\UserCfg.opt"))) {
  if (Test-Path $c) {
    $line = Select-String -Path $c -Pattern '^\s*InstalledPackagesPath\s+"(.+)"' | Select-Object -First 1
    if ($line) { $p = Join-Path $line.Matches[0].Groups[1].Value "Community\vatflow-towercab-maps"; if (Test-Path $p) { $maps = $p; break } }
  }
}
if (-not $maps) { $p = Join-Path $Proj "maps-package\vatflow-towercab-maps"; if (Test-Path $p) { $maps = $p } }
if (-not $maps) { Write-Host "Maps: no vatflow-towercab-maps package found, skipped."; exit 0 }

# the testers' maps package goes out empty: each tester adds their own ARTCC file
$stage = Join-Path $env:TEMP "vatflow-towercab-maps-zip"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory $stage | Out-Null
$mdst = Join-Path $stage "vatflow-towercab-maps"
Copy-Item $maps $mdst -Recurse
Get-ChildItem (Join-Path $mdst "html_ui\Pages\VCockpit\Instruments\VatflowTower\facilities") -Filter *.json -ErrorAction SilentlyContinue | Remove-Item -Force
Get-ChildItem (Join-Path $mdst "ARTCC files") -Filter *.json -ErrorAction SilentlyContinue | Remove-Item -Force
# file list for what is in the zip now
$items = Get-ChildItem (Join-Path $mdst "html_ui") -Recurse -File | Sort-Object FullName | ForEach-Object {
  [ordered]@{ path = $_.FullName.Substring($mdst.Length + 1).Replace("\", "/"); size = $_.Length; date = $_.LastWriteTimeUtc.ToFileTimeUtc() }
}
[IO.File]::WriteAllText((Join-Path $mdst "layout.json"), ([ordered]@{ content = @($items) } | ConvertTo-Json -Depth 5), $utf8)
$mzip = Join-Path $desktop "vatflow-towercab-maps.zip"
if (Test-Path $mzip) { Remove-Item $mzip -Force }
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $mzip
Remove-Item $stage -Recurse -Force
Write-Host "Maps: $mzip  (no ARTCC files: testers add their own)"
Write-Host ""
Write-Host "Note: on THIS PC don't put the cab zip in Community while the project is open in the editor"
Write-Host "(the sim would see the cab twice). Test it on another PC, or close the project first."
