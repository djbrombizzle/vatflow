# VATFLOW Tower Cab - the setup that runs inside VATFLOW-TowerCab-Setup.exe (built by
# make-community-zip.ps1 with Windows' own IExpress). Next to it in the EXE:
#   vatflow-towercab.zip          the cab package
#   vatflow-towercab-maps.zip     the ARTCC video maps package (no ARTCC files), if there was one
#   install-maps-package.ps1      copies the maps package in, keeping ARTCC files already there
# It finds the MSFS 2024 Community folder, replaces the cab there, adds / updates the maps
# package and can add ARTCC video maps right away. Run again to update, or to uninstall.
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Name = "vatflow-towercab"
$Maps = "vatflow-towercab-maps"
$Host.UI.RawUI.WindowTitle = "VATFLOW Tower Cab setup"

function Done([int]$code) { Write-Host ""; Read-Host "Press Enter to close" | Out-Null; exit $code }
function Ask([string]$q) { return ((Read-Host "$q (Y/N)") -match '^\s*[yY]') }

Write-Host "=============================================="
Write-Host "  VATFLOW Tower Cab for MSFS 2024 - setup"
Write-Host "=============================================="
Write-Host ""

# ---- the sim must be closed: it reads Community only when it starts ---------------------
while (Get-Process -Name "FlightSimulator2024" -ErrorAction SilentlyContinue) {
  Write-Host "Microsoft Flight Simulator is running. Close it, then press Enter."
  Read-Host | Out-Null
}

# ---- the Community folder -----------------------------------------------------------
# UserCfg.opt (InstalledPackagesPath) of the Steam and the MS Store / Game Pass sim
$found = New-Object Collections.Generic.List[string]
foreach ($c in @((Join-Path $env:APPDATA "Microsoft Flight Simulator 2024\UserCfg.opt"),
                 (Join-Path $env:LOCALAPPDATA "Packages\Microsoft.Limitless_8wekyb3d8bbwe\LocalCache\UserCfg.opt"))) {
  if (Test-Path $c) {
    $line = Select-String -Path $c -Pattern '^\s*InstalledPackagesPath\s+"(.+)"' | Select-Object -First 1
    if ($line) {
      $p = Join-Path $line.Matches[0].Groups[1].Value "Community"
      if ((Test-Path $p) -and -not $found.Contains($p)) { $found.Add($p) }
    }
  }
}
$community = $null
if ($found.Count -eq 1) { $community = $found[0] }
elseif ($found.Count -gt 1) {
  Write-Host "More than one MSFS 2024 install found:"
  for ($i = 0; $i -lt $found.Count; $i++) { Write-Host ("  {0}. {1}" -f ($i + 1), $found[$i]) }
  $n = Read-Host "Which one? (number)"
  if ($n -match '^\d+$' -and [int]$n -ge 1 -and [int]$n -le $found.Count) { $community = $found[[int]$n - 1] }
}
if (-not $community) {
  Write-Host "Pick your MSFS 2024 Community folder in the window that opens"
  Write-Host "(the folder your other add-ons are in; it may be behind this window)."
  Add-Type -AssemblyName System.Windows.Forms
  $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
  $dlg.Description = "Your MSFS 2024 Community folder"
  $dlg.ShowNewFolderButton = $false
  if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $community = $dlg.SelectedPath }
}
if (-not $community -or -not (Test-Path $community)) { Write-Host "No Community folder: nothing installed."; Done 1 }
if ((Split-Path -Leaf $community) -ne "Community") {
  Write-Host "Note: $community is not called Community."
  if (-not (Ask "Install there anyway?")) { Done 1 }
}
Write-Host "Community folder: $community"
Write-Host ""

$cabDir = Join-Path $community $Name
$mapsDir = Join-Path $community $Maps

# ---- already installed: update or uninstall ---------------------------------------------
if (Test-Path $cabDir) {
  Write-Host "The tower cab is already installed."
  $c = Read-Host "U = update it (your ARTCC maps stay), R = remove it, Enter = update"
  if ($c -match '^\s*[rR]') {
    Remove-Item $cabDir -Recurse -Force
    Write-Host "Removed $cabDir"
    if ((Test-Path $mapsDir) -and (Ask "Also remove the ARTCC video maps package (and your ARTCC files in it)?")) {
      Remove-Item $mapsDir -Recurse -Force
      Write-Host "Removed $mapsDir"
    }
    Write-Host "Uninstalled. Your cab settings (saved tower spots, CID) stay in the sim's storage."
    Done 0
  }
}

# the editor's project on this PC: the sim would see the cab twice
if (Test-Path "C:\MSFS-Projects\VatflowTowerCab\SimpleAircraftProject.xml") {
  Write-Host "Note: this PC has the tower cab project (C:\MSFS-Projects\VatflowTowerCab). Don't open it"
  Write-Host "in the editor while this Community copy is installed: the sim would see the cab twice."
  Write-Host ""
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$tmp = Join-Path $env:TEMP ("vatflow-setup-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory $tmp | Out-Null
try {
  # ---- the cab ------------------------------------------------------------------------
  Write-Host "Installing the tower cab..."
  [IO.Compression.ZipFile]::ExtractToDirectory((Join-Path $here "$Name.zip"), (Join-Path $tmp "cab"))
  $src = Join-Path $tmp "cab\$Name"
  if (-not (Test-Path (Join-Path $src "manifest.json"))) { throw "the cab package in this setup is damaged (no manifest.json)" }
  if (Test-Path $cabDir) { Remove-Item $cabDir -Recurse -Force }   # an update replaces it all
  Copy-Item $src $cabDir -Recurse
  Write-Host "  $cabDir"
  $guide = Join-Path $tmp "cab\READ ME - install.txt"

  # ---- the ARTCC video maps package (your ARTCC files in it are kept) ------------------------
  $mz = Join-Path $here "$Maps.zip"
  if (Test-Path $mz) {
    Write-Host "Installing the ARTCC video maps package..."
    [IO.Compression.ZipFile]::ExtractToDirectory($mz, (Join-Path $tmp "maps"))
    & (Join-Path $here "install-maps-package.ps1") (Join-Path $tmp "maps") $community
  }
  Write-Host ""
  Write-Host "Installed."

  # ---- ARTCC video maps now? -------------------------------------------------------------
  $upd = Join-Path $mapsDir "update-maps.ps1"
  if (Test-Path $upd) {
    Write-Host ""
    Write-Host "ARTCC video maps (optional): the radars can show your ARTCC's own vNAS maps, as CRC does."
    Write-Host "They come from the ARTCC files CRC keeps, or are downloaded from vNAS."
    if (Ask "Add ARTCC video maps now?") {
      & $upd $mapsDir
    } else {
      Write-Host "Later: $mapsDir\update-maps.bat"
    }
  }

  # the guide for testers next to the package
  if (Test-Path $guide) { Copy-Item $guide (Join-Path $cabDir "READ ME - VATFLOW Tower Cab.txt") -Force }
} catch {
  Write-Host ""
  Write-Host "ERROR: $($_.Exception.Message)"
  Write-Host "Nothing else was changed. Check the Community folder is writable and try again."
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  Done 1
}
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "Fly it:"
Write-Host "  1. Start MSFS 2024. Assistance > crash damage OFF."
Write-Host "  2. Aircraft: VATFLOW Tower Cab. Start at a parking spot at the airport you control."
Write-Host "  3. Wait about 10 seconds: the cab goes up into the tower by itself."
Write-Host "     If a screen says NOT IN THE TOWER: MENU > TOWER SETUP > PLACE IN TOWER."
Write-Host "  4. Type your VATSIM CID on TOWER SETUP (MENU on any big screen)."
Write-Host ""
Write-Host "The guide: $cabDir\READ ME - VATFLOW Tower Cab.txt"
Write-Host "Update: run the new setup. Uninstall: run this setup again and pick R."
Done 0
