# VATFLOW Ramp Control Tower - builds a new MSFS project from the VATFLOW Tower Cab project.
#   install-ramp-tower.ps1 <cab project> <new project> <files folder>
# 1. Copies the cab project (without its build output) to the new folder; the cab project is
#    only read.
# 2. Gives the copy its own package and aircraft folder names (vatflow-ramp-tower,
#    VatflowRampTower), so both can be in the sim at once.
# 3. Swaps in the ramp tower: model files, panel.cfg (its ten VATFLOW screens), the cab lights
#    in systems.cfg, the eye point, and the contact points 24.6 ft lower, so the tower stands on
#    the bottom of its shaft with the cab 7.5 m up.
# 4. Names it "VATFLOW Ramp Control Tower" in the aircraft list (distribution\rename-cab.ps1).
param([string]$Src, [string]$Dst, [string]$Files)
$ErrorActionPreference = "Stop"
$utf8 = New-Object Text.UTF8Encoding($false)
$OLD_ACFT = "MyCompany_Simple_Aircraft"; $NEW_ACFT = "VatflowRampTower"
$OLD_PKG = "mycompany-aircraft-simple";   $NEW_PKG = "vatflow-ramp-tower"
$SHAFT_FT = 24.6                       # shaft height below the cab floor (7.5 m)

if (-not (Test-Path (Join-Path $Src "SimpleAircraftProject.xml"))) {
  Write-Host "ERROR: $Src\SimpleAircraftProject.xml not found. Edit SRC at the top of install.bat."; exit 1
}
if (-not (Test-Path (Join-Path $Src "PackageSources\SimObjects\Airplanes\$OLD_ACFT"))) {
  Write-Host "ERROR: $Src\PackageSources\SimObjects\Airplanes\$OLD_ACFT not found."; exit 1
}

# ---- 1. copy (fresh each time; no build output, no backups) -------------------------------
if (Test-Path $Dst) {
  Write-Host "Replacing the earlier $Dst"
  Remove-Item $Dst -Recurse -Force
}
& robocopy $Src $Dst /E /NFL /NDL /NJH /NJS /NP /XD Packages _PackageInt backup-sound .vs | Out-Null
if ($LASTEXITCODE -ge 8) { Write-Host "ERROR: copying the project failed."; exit 1 }

# ---- 2. own package / aircraft names --------------------------------------------------------
$acftOld = Join-Path $Dst "PackageSources\SimObjects\Airplanes\$OLD_ACFT"
Rename-Item $acftOld $NEW_ACFT
$acft = Join-Path $Dst "PackageSources\SimObjects\Airplanes\$NEW_ACFT"
$texts = @(Get-ChildItem $Dst -File -Filter *.xml) + @(Get-ChildItem (Join-Path $Dst "PackageDefinitions") -Recurse -File -Include *.xml, *.json -ErrorAction SilentlyContinue)
foreach ($f in $texts) {
  $t = [IO.File]::ReadAllText($f.FullName)
  $n = $t.Replace($OLD_ACFT, $NEW_ACFT).Replace($OLD_PKG, $NEW_PKG)
  if ($n -ne $t) { [IO.File]::WriteAllText($f.FullName, $n, $utf8); Write-Host "Renamed package in $($f.Name)" }
}
Get-ChildItem (Join-Path $Dst "PackageDefinitions") -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "$OLD_PKG*" } |
  ForEach-Object { Rename-Item $_.FullName ($_.Name.Replace($OLD_PKG, $NEW_PKG)) }

# ---- 3. the ramp tower --------------------------------------------------------------------
$model = Join-Path $acft "common\model"
Get-ChildItem $model -File | Remove-Item -Force
Copy-Item (Join-Path $Files "model\*") $model -Force
New-Item -ItemType Directory -Force (Join-Path $acft "common\panel") | Out-Null
Copy-Item (Join-Path $Files "panel.cfg") (Join-Path $acft "common\panel\panel.cfg") -Force
# the cab's own textures aren't used by the ramp tower
Get-ChildItem (Join-Path $acft "common\texture") -File -Filter "TWR_*" -ErrorAction SilentlyContinue | Remove-Item -Force

$lights = [IO.File]::ReadAllText((Join-Path $Files "lights.cfg")).TrimEnd()
foreach ($f in @(Get-ChildItem $acft -Recurse -File -Filter *.cfg)) {
  $t = [IO.File]::ReadAllText($f.FullName); $n = $t
  if ($f.Name -eq "systems.cfg" -and $n -match '(?ms)^\[LIGHTS\].*?(?=^\[)') {
    $n = [regex]::Replace($n, '(?ms)^\[LIGHTS\].*?(?=^\[)', { param($m) $lights + "`r`n`r`n" })
  }
  # eye point: standing behind the front ramp positions (feet from the datum, which is 3.6 ft
  # ahead of the cab centre in SimpleAircraft: 3.9 ft forward of the centre - 3.6 = 0.3)
  $n = [regex]::Replace($n, '(?m)^(\s*eyepoint\s*=).*$', '$1 0.3, 0, 5.4 ; VATFLOW ramp tower')
  if ($f.Name -eq "flight_model.cfg") {
    # contact points 24.6 ft lower: the tower stands on the bottom of its shaft
    $n = [regex]::Replace($n, '(?m)^(\s*point\.\d+\s*=\s*[^,]+,[^,]+,[^,]+,)\s*([-0-9.]+)', {
      param($m) $m.Groups[1].Value + " " + ([math]::Round([double]::Parse($m.Groups[2].Value, [Globalization.CultureInfo]::InvariantCulture) - $SHAFT_FT, 2)).ToString([Globalization.CultureInfo]::InvariantCulture) })
    $n = [regex]::Replace($n, '(?m)^(\s*static_cg_height\s*=)\s*([-0-9.]+)', {
      param($m) $m.Groups[1].Value + " " + ([math]::Round([double]::Parse($m.Groups[2].Value, [Globalization.CultureInfo]::InvariantCulture) + $SHAFT_FT, 2)).ToString([Globalization.CultureInfo]::InvariantCulture) })
  }
  if ($n -ne $t) { [IO.File]::WriteAllText($f.FullName, $n, $utf8); Write-Host "Updated $($f.FullName.Substring($Dst.Length + 1))" }
}

# ---- 4. name in the aircraft list -------------------------------------------------------
$rename = Join-Path $Dst "distribution\rename-cab.ps1"
if (Test-Path $rename) { & $rename $Dst -Maker "VATFLOW" -Name "Ramp Control Tower" -Quiet }
else { Write-Host "Note: distribution\rename-cab.ps1 not found; set title in presets\...\aircraft.cfg yourself." }

Write-Host ""
Write-Host "Ramp tower project ready: $Dst"
