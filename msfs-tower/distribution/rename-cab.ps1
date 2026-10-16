# VATFLOW Tower Cab - the name the cab has in MSFS 2024's aircraft list.
#   rename-cab.ps1 <project folder> [maker] [name]
# Sets, in every preset aircraft.cfg of the project: title, ui_manufacturer (maker), ui_type
# (name), ui_variation and ui_createdby, plus icao_manufacturer / icao_model where the file
# has them. With no maker / name it asks (Enter keeps the current one). The choice is kept in
# distribution\cab-name.txt, so install.bat keeps your name on later updates.
# Close the project in MSFS first, then Build All after.
param([string]$Proj, [string]$Maker, [string]$Name, [switch]$Quiet)
$ErrorActionPreference = "Stop"
$Proj = (Resolve-Path $Proj).Path
$saved = Join-Path $Proj "distribution\cab-name.txt"
$cur = @("VATFLOW", "Tower Cab")
if (Test-Path $saved) { $l = @(Get-Content $saved); if ($l.Count -ge 2 -and $l[0] -and $l[1]) { $cur = @($l[0].Trim(), $l[1].Trim()) } }
if (-not $Quiet -and -not $Maker -and -not $Name) {
  Write-Host "Name in the MSFS aircraft list is shown as  MAKER  /  NAME"
  $a = Read-Host "Maker [$($cur[0])]"; if ($a) { $cur[0] = $a.Trim() }
  $b = Read-Host "Name  [$($cur[1])]"; if ($b) { $cur[1] = $b.Trim() }
} else {
  if ($Maker) { $cur[0] = $Maker.Trim() }
  if ($Name) { $cur[1] = $Name.Trim() }
}
$maker = $cur[0] -replace '"', ''; $model = $cur[1] -replace '"', ''
$title = "$maker $model"
$utf8 = New-Object Text.UTF8Encoding($false)
New-Item -ItemType Directory -Force (Split-Path $saved) | Out-Null
[IO.File]::WriteAllLines($saved, @($maker, $model), $utf8)

$cfgs = @(Get-ChildItem (Join-Path $Proj "PackageSources\SimObjects\Airplanes") -Recurse -Filter aircraft.cfg -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -match '[\\/]presets[\\/]' })
if ($cfgs.Count -eq 0) { Write-Host "ERROR: no presets\...\aircraft.cfg under $Proj\PackageSources\SimObjects\Airplanes"; exit 1 }
$want = [ordered]@{ title = $title; ui_manufacturer = $maker; ui_type = $model; ui_variation = $model; ui_createdby = "VATFLOW" }
foreach ($f in $cfgs) {
  $out = New-Object Collections.Generic.List[string]
  $sec = ""; $done = @{}
  function Flush-Missing {
    if ($sec -notmatch '^FLTSIM\.') { return }
    $at = $out.Count
    while ($at -gt 0 -and -not $out[$at - 1].Trim()) { $at-- }      # before the blank lines ending the section
    foreach ($k in $want.Keys) { if (-not $done[$k]) { $out.Insert($at, "$k = `"$($want[$k])`""); $at++ } }
  }
  foreach ($line in (Get-Content $f.FullName)) {
    if ($line -match '^\s*\[(.+?)\]') { Flush-Missing; $sec = $Matches[1].ToUpper(); $done = @{}; $out.Add($line); continue }
    if ($sec -match '^FLTSIM\.' -and $line -match '^\s*([A-Za-z_]+)\s*=') {
      $k = $Matches[1].ToLower()
      if ($want.Contains($k)) { $out.Add("$k = `"$($want[$k])`""); $done[$k] = $true; continue }
    }
    if ($sec -eq 'GENERAL' -and $line -match '^\s*icao_manufacturer\s*=') { $out.Add("icao_manufacturer = `"$maker`""); continue }
    if ($sec -eq 'GENERAL' -and $line -match '^\s*icao_model\s*=') { $out.Add("icao_model = `"$model`""); continue }
    $out.Add($line)
  }
  Flush-Missing
  [IO.File]::WriteAllLines($f.FullName, $out, $utf8)
  Write-Host "Named `"$title`" in $($f.FullName.Substring($Proj.Length + 1))"
}
if (-not $Quiet) { Write-Host ""; Write-Host "Now open the project in MSFS and Build All (then make-community-zip.bat for testers)." }
