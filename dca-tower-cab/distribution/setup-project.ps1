# DCA Tower Cab - turns a fresh copy of the MSFS 2024 SDK's SimpleAircraft sample into the
# DCA Tower Cab project (its own project, separate from the VATFLOW Tower Cab's):
#   setup-project.ps1 <project folder>      (the folder with SimpleAircraftProject.xml)
# * renames the sample's aircraft folder to vatflow_dca_tower_cab (and its asset group), so it
#   never shares a SimObjects path with the VATFLOW Tower Cab when both are installed
# * puts in this repo's model, panel, sound, textures and systems.cfg (the sample's model and
#   sound folders go to <project>\backup-sample\)
# * copies the screens (html_ui\...\VatflowDcaTower) and adds the html_ui Copy asset group
# * names it "DCA Tower Cab" and moves the eye point onto the GC position
# Close the project in MSFS first; run it again after pulling a new version. Then Build All.
param([string]$Proj)
$ErrorActionPreference = "Stop"
if (-not $Proj) { Write-Host "usage: setup-project.ps1 <project folder>"; exit 1 }
$Proj = (Resolve-Path $Proj).Path
$Repo = Split-Path $PSScriptRoot -Parent
$Ac = "vatflow_dca_tower_cab"
$utf8 = New-Object Text.UTF8Encoding($false)

$planes = Join-Path $Proj "PackageSources\SimObjects\Airplanes"
if (-not (Test-Path $planes)) { Write-Host "ERROR: $planes not found (is this the SimpleAircraft project copy?)"; exit 1 }
$defs = @(Get-ChildItem (Join-Path $Proj "PackageDefinitions") -Filter *.xml -ErrorAction SilentlyContinue)
if ($defs.Count -eq 0) { Write-Host "ERROR: no PackageDefinitions\*.xml in $Proj"; exit 1 }

# ---- the aircraft folder: rename the sample's to vatflow_dca_tower_cab -------------------
$dst = Join-Path $planes $Ac
if (-not (Test-Path $dst)) {
  $src = @(Get-ChildItem $planes -Directory)
  if ($src.Count -ne 1) { Write-Host "ERROR: expected the sample's one aircraft folder in $planes, found $($src.Count)"; exit 1 }
  $old = $src[0].Name
  Rename-Item $src[0].FullName $Ac
  foreach ($d in $defs) {
    $x = [IO.File]::ReadAllText($d.FullName)
    $x = $x.Replace("SimObjects\Airplanes\$old\", "SimObjects\Airplanes\$Ac\").Replace("SimObjects\Airplanes\$old<", "SimObjects\Airplanes\$Ac<")
    [IO.File]::WriteAllText($d.FullName, $x, $utf8)
  }
  Write-Host "Aircraft folder: $old -> $Ac (asset group paths updated)"
}

# ---- model, panel, sound, textures, systems.cfg ----------------------------------------
$common = Join-Path $dst "common"
$backup = Join-Path $Proj "backup-sample"
foreach ($sub in @("model", "sound")) {
  $p = Join-Path $common $sub
  if ((Test-Path $p) -and -not (Test-Path (Join-Path $backup $sub))) {
    New-Item -ItemType Directory -Force $backup | Out-Null
    Move-Item $p (Join-Path $backup $sub)
    Write-Host "Sample's $sub folder -> backup-sample\$sub"
  }
}
$ours = Join-Path $Repo "package\SimObjects\Airplanes\$Ac\common"
foreach ($sub in @("model", "panel", "sound", "texture", "config")) {
  $to = Join-Path $common $sub
  New-Item -ItemType Directory -Force $to | Out-Null
  Copy-Item (Join-Path $ours "$sub\*") $to -Recurse -Force
}
# the sample may keep a panel in a preset too; ours is in common\panel
Write-Host "Model, panel, sound, textures and systems.cfg copied."

# ---- screens + the html_ui Copy asset group --------------------------------------------
$html = Join-Path $Proj "PackageSources\html_ui\Pages\VCockpit\Instruments\VatflowDcaTower"
if (Test-Path $html) { Remove-Item $html -Recurse -Force }
New-Item -ItemType Directory -Force (Split-Path $html) | Out-Null
Copy-Item (Join-Path $Repo "package\html_ui\Pages\VCockpit\Instruments\VatflowDcaTower") $html -Recurse
Write-Host "Screens copied to PackageSources\html_ui\...\VatflowDcaTower"
foreach ($d in $defs) {
  $x = [IO.File]::ReadAllText($d.FullName)
  if ($x -notmatch '<AssetGroups>' -or $x -match 'PackageSources\\html_ui\\') { continue }
  $grp = "`r`n`t`t<AssetGroup Name=`"html_ui`">`r`n`t`t`t<Type>Copy</Type>`r`n`t`t`t<Flags>`r`n`t`t`t`t<FSXCompatibility>false</FSXCompatibility>`r`n`t`t`t</Flags>`r`n`t`t`t<AssetDir>PackageSources\html_ui\</AssetDir>`r`n`t`t`t<OutputDir>html_ui\</OutputDir>`r`n`t`t</AssetGroup>"
  $x = $x.Replace("<AssetGroups>", "<AssetGroups>$grp")
  [IO.File]::WriteAllText($d.FullName, $x, $utf8)
  Write-Host "Added the html_ui Copy asset group to $($d.Name)"
}

# ---- name: DCA Tower Cab ----------------------------------------------------------------
$want = [ordered]@{ title = "DCA Tower Cab"; ui_manufacturer = "VATFLOW"; ui_type = "DCA Tower Cab"; ui_variation = "DCA Tower Cab"; ui_createdby = "VATFLOW" }
foreach ($f in @(Get-ChildItem $dst -Recurse -Filter aircraft.cfg)) {
  $out = New-Object Collections.Generic.List[string]
  $sec = ""; $done = @{}
  $flush = {
    if ($sec -notmatch '^FLTSIM\.') { return }
    $at = $out.Count
    while ($at -gt 0 -and -not $out[$at - 1].Trim()) { $at-- }
    foreach ($k in $want.Keys) { if (-not $done[$k]) { $out.Insert($at, "$k = `"$($want[$k])`""); $at++ } }
  }
  foreach ($line in [IO.File]::ReadAllLines($f.FullName)) {
    if ($line -match '^\s*\[(.+?)\]') { & $flush; $sec = $Matches[1].ToUpper(); $done = @{}; $out.Add($line); continue }
    if ($sec -match '^FLTSIM\.' -and $line -match '^\s*([A-Za-z_]+)\s*=') {
      $k = $Matches[1].ToLower()
      if ($want.Contains($k)) { $out.Add("$k = `"$($want[$k])`""); $done[$k] = $true; continue }
    }
    if ($sec -eq 'GENERAL' -and $line -match '^\s*icao_model\s*=') { $out.Add("icao_model = `"DCA Tower Cab`""); continue }
    $out.Add($line)
  }
  & $flush
  [IO.File]::WriteAllLines($f.FullName, $out, $utf8)
  Write-Host "Named `"DCA Tower Cab`" in $($f.FullName.Substring($Proj.Length + 1))"
}

# ---- eye point: standing at GC (11.98 ft forward of the cab origin, 5.41 ft up) ----------
$inv = [Globalization.CultureInfo]::InvariantCulture
$fm = Get-ChildItem $dst -Recurse -Filter flight_model.cfg | Select-Object -First 1
$datum = @(0.0, 0.0, 0.0)
if ($fm) {
  $m = Select-String -Path $fm.FullName -Pattern '^\s*reference_datum_position\s*=\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)' | Select-Object -First 1
  if ($m) { $datum = @([double]::Parse($m.Matches[0].Groups[1].Value, $inv), [double]::Parse($m.Matches[0].Groups[2].Value, $inv), [double]::Parse($m.Matches[0].Groups[3].Value, $inv)) }
}
$eye = [string]::Format($inv, "{0:0.00}, {1:0.00}, {2:0.00}", (11.98 - $datum[0]), (0 - $datum[1]), (5.41 - $datum[2]))
$cams = @(Get-ChildItem $dst -Recurse -Filter cameras.cfg)
$set = $false
foreach ($c in $cams) {
  $lines = [IO.File]::ReadAllLines($c.FullName)
  $new = $lines | ForEach-Object { if ($_ -match '^\s*eyepoint\s*=') { $set = $true; "eyepoint = $eye ; DCA Tower Cab: standing at GC" } else { $_ } }
  [IO.File]::WriteAllLines($c.FullName, $new, $utf8)
}
if ($set) { Write-Host "Eye point set to $eye (GC position)" }
else { Write-Host "NOTE: no eyepoint line found in cameras.cfg; set  eyepoint = $eye  by hand (see README)" }

Write-Host ""
Write-Host "Done. Open the project in MSFS, Clean All, Build All, then pick aircraft `"DCA Tower Cab`"."
