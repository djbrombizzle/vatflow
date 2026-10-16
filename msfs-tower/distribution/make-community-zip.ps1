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

# ---- is the build up to date? -------------------------------------------------------
# every screen file in PackageSources must be in the build, the same size (else: Build All again)
$problems = New-Object Collections.Generic.List[string]
$warnings = New-Object Collections.Generic.List[string]
$srcHtml = Join-Path $Proj "PackageSources\html_ui"
if (Test-Path $srcHtml) {
  Get-ChildItem $srcHtml -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($srcHtml.Length + 1)
    $built = Join-Path $pkg.FullName ("html_ui\" + $rel)
    if ($rel -match '[\\/]facilities[\\/]') { return }                       # ARTCC files: never shipped (below)
    if (-not (Test-Path $built)) {
      # ramp layouts are only the fallback (the RAMP screen reads vatflow.io first)
      if ($rel -match '\.json$') { $warnings.Add("not in the build (RAMP reads it from vatflow.io instead): html_ui\$rel") }
      else { $problems.Add("missing from the build: html_ui\$rel") }
    }
    elseif ((Get-Item $built).Length -ne $_.Length) { $problems.Add("older in the build:   html_ui\$rel") }
  }
}
# the parts of the latest version, by name
$need = @("html_ui\Pages\VCockpit\Instruments\VatflowTower\common\viewctl.js",
          "html_ui\Pages\VCockpit\Instruments\VatflowTower\common\ramp-airports.js",
          "html_ui\Pages\VCockpit\Instruments\VatflowTower\StripBay\SB_1.html",
          "html_ui\Pages\VCockpit\Instruments\VatflowTower\Screen\S_RAMPMAP_ED.html")
foreach ($n in $need) { if (-not (Test-Path (Join-Path $pkg.FullName $n))) { $problems.Add("missing from the build: $n") } }
$panel = Get-ChildItem (Join-Path $pkg.FullName "SimObjects") -Recurse -Filter panel.cfg -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $panel) { $problems.Add("missing from the build: panel.cfg") }
elseif (-not (Select-String -Path $panel.FullName -Pattern "pixel_size=1536,896" -Quiet)) { $problems.Add("panel.cfg in the build is older (no 3-column strip bays)") }
$model = Get-ChildItem (Join-Path $pkg.FullName "SimObjects") -Recurse -Filter "tower_cab_interior.*" -ErrorAction SilentlyContinue
if (-not $model) { $problems.Add("missing from the build: the cab interior model (tower_cab_interior)") }
if ($problems.Count) {
  Write-Host ""
  Write-Host "ERROR: the built package is not the latest version:"
  $problems | Select-Object -First 15 | ForEach-Object { Write-Host "   $_" }
  if ($problems.Count -gt 15) { Write-Host "   ... and $($problems.Count - 15) more" }
  Write-Host "In MSFS: open the project, Clean All, Build All, then run this again."
  exit 1
}
Write-Host "Build check: all screen files, the panel and the model are in the build."
if ($warnings.Count) { Write-Host "Note: $($warnings.Count) ramp layout file(s) not in the build; the RAMP screen reads them from vatflow.io instead." }

# the name testers see in the aircraft list (rename-cab.bat)
$cabName = "VATFLOW Tower Cab"
$preset = Get-ChildItem (Join-Path $pkg.FullName "SimObjects") -Recurse -Filter aircraft.cfg -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -match '[\\/]presets[\\/]' } | Select-Object -First 1
if ($preset) {
  $t = Select-String -Path $preset.FullName -Pattern '^\s*title\s*=\s*"([^"]+)"' | Select-Object -First 1
  if ($t) { $cabName = $t.Matches[0].Groups[1].Value }
}
Write-Host "Aircraft name in the sim: $cabName"
$Title = "$cabName (test)"

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

# no ARTCC video map files in the cab package (testers add their own in the maps package)
$fac = @(Get-ChildItem $dst -Recurse -File -Filter *.json | Where-Object { $_.FullName -match '[\\/]facilities[\\/]' })
if ($fac.Count) {
  $fac | Remove-Item -Force
  $lj = Join-Path $dst "layout.json"
  if (Test-Path $lj) {
    $L = Get-Content $lj -Raw | ConvertFrom-Json
    $L.content = @($L.content | Where-Object { $_.path -notmatch '(^|/)facilities/[^/]+\.json$' })
    [IO.File]::WriteAllText($lj, ($L | ConvertTo-Json -Depth 5), $utf8)
  }
  Write-Host "Left out $($fac.Count) ARTCC file(s) found in the cab package."
}

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
     Check: it must be Community\$Name\manifest.json, not a folder inside another folder.
  3. Optional, ARTCC video maps: unzip vatflow-towercab-maps.zip into Community too, put
     your ARTCC's .json file (e.g. ZTL.json; CRC keeps them in %LOCALAPPDATA%\CRC\ARTCCs)
     in its "ARTCC files" folder and double-click update-maps.bat there (see its README).
  4. Start MSFS. New Community packages are only read when the sim starts.

Fly
  1. Assistance > crash damage OFF.
  2. Aircraft: "$cabName".
  3. Start at any parking spot at the airport you control (cold and dark).
  4. Wait ~10 seconds: the cab finds the airport and goes up into the tower by itself
     (a saved spot, the built-in list, or OpenStreetMap's control tower). If a screen says
     NOT IN THE TOWER: MENU > TOWER SETUP > PLACE IN TOWER, nudge it, SAVE THIS SPOT.

In the cab
  - Every big screen has a MENU tab (bottom right): DBRITE, ASDE-X, IDST, VATSMART, demand
    vs AAR, aircraft list, RAMP, STRIP BAYS, TOWER SETUP. Each screen keeps its choice.
  - TOWER SETUP: nudge the cab (FWD / BACK / LEFT / RIGHT / UP / DOWN / TURN), SAVE THIS SPOT.
    VATSIM CID > EDIT: your CID (needed to issue IDST releases).
  - DBRITE / ASDE-X: zoom + / -, pan with the arrows, C = whole picture. MAPS tab for the
    ARTCC video maps, with presets.
  - RAMP: pick an airport from the VATFLOW ramp page, then its ramps (or ENTIRE AIRPORT).
    RAMPS tab on the map to change it.
  - Strip bays (TMU, GROUND, LOCAL): departure strips print by themselves. Tap a strip to
    pick it up, tap where it goes; COCK / DELETE. MENU > STRIP BAYS: names, where each bay
    stands, separators and their columns.
  - Brightness: the four knobs on the console. Overhead monitors: drag the post to move
    them round the cab, the handle for height, the side knobs to swivel.

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
