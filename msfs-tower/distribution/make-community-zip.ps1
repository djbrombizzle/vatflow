# VATFLOW Tower Cab - builds a Community-folder zip from the project's built package.
#   make-community-zip.ps1 <project folder>
param([string]$Proj)
$ErrorActionPreference = "Stop"
$Name = "vatflow-towercab"
$Title = "VATFLOW Tower Cab (test)"
$Proj = (Resolve-Path $Proj).Path

$pkgRoot = Join-Path $Proj "Packages"
if (-not (Test-Path $pkgRoot)) { Write-Host "ERROR: $pkgRoot not found. In MSFS: open the project and Build All first."; exit 1 }
$pkg = Get-ChildItem $pkgRoot -Directory | Where-Object {
  Test-Path (Join-Path $_.FullName "html_ui\Pages\VCockpit\Instruments\VatflowTower\Screen")
} | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $pkg) { Write-Host "ERROR: no built tower cab package in $pkgRoot (with the new screens). Build All in MSFS first."; exit 1 }
Write-Host "Built package: $($pkg.FullName)"

# never ship anyone's VATSIM CID (it is typed in the cab now, but an old airport.js could have one)
$withCid = Get-ChildItem $pkg.FullName -Recurse -Filter *.js | Select-String -Pattern 'cid:\s*"\d+' -List
if ($withCid) {
  Write-Host "ERROR: a VATSIM CID is inside the package:"
  $withCid | ForEach-Object { Write-Host "   $($_.Path)" }
  Write-Host "Run the latest install.bat (it clears it), Build All again, then run this again."
  exit 1
}

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
  [IO.File]::WriteAllText($manifest, ($m | ConvertTo-Json -Depth 20), (New-Object Text.UTF8Encoding($false)))
}

$readme = @"
VATFLOW Tower Cab (test build)
==============================

Install
  1. Unzip. Move the folder "$Name" into your MSFS 2024 Community folder.
     (Find it: MSFS > Settings > General Options > Developers, or search your PC for "Community".)
  2. Start MSFS. Pick the aircraft "VATFLOW Tower Cab".
  3. Start a flight at a parking spot at the airport you are controlling (cold and dark).

In the cab
  - The cab finds the airport by itself and, after a few seconds, goes up into the tower
    (if it knows where the tower is: KDCA is tuned, other airports use OpenStreetMap's tower).
  - Every screen has a MENU tab in its bottom-right corner: pick what it shows
    (DBRITE, ASDE-X, IDST, VATSMART, APT dashboard, TOWER SETUP ...).
  - MENU > TOWER SETUP: place the cab, nudge it onto the real tower (FWD / BACK / LEFT / RIGHT /
    UP / DOWN / TURN), SAVE THIS SPOT, and type your VATSIM CID (needed to issue IDST releases).
  - In MSFS turn crash damage OFF (Assistance), or touching the tower ends the flight.

Uninstall: delete the "$Name" folder from Community.
"@
[IO.File]::WriteAllText((Join-Path $stage "READ ME - install.txt"), $readme, (New-Object Text.UTF8Encoding($false)))

$zip = Join-Path ([Environment]::GetFolderPath("Desktop")) "$Name-test.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip
Remove-Item $stage -Recurse -Force
Write-Host ""
Write-Host "Done: $zip"
Write-Host "Note: on THIS PC don't put it in Community while the project is open in the editor"
Write-Host "(the sim would see the cab twice). Test it on a friend's PC, or close the project first."
