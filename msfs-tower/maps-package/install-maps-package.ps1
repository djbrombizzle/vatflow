# VATFLOW Tower Cab - copies the ARTCC video maps package into the MSFS 2024 Community folder.
#   install-maps-package.ps1 <folder holding vatflow-towercab-maps> [Community folder]
# Finds Community from the sim's UserCfg.opt (InstalledPackagesPath) unless it is given (the
# setup EXE gives it). Never overwrites ARTCC files already there; the scripts and README are updated.
param([string]$Src, [string]$CommunityDir)
$ErrorActionPreference = "Stop"
$pkg = (Resolve-Path (Join-Path $Src "vatflow-towercab-maps")).Path
$cands = @(
  (Join-Path $env:APPDATA "Microsoft Flight Simulator 2024\UserCfg.opt"),
  (Join-Path $env:LOCALAPPDATA "Packages\Microsoft.Limitless_8wekyb3d8bbwe\LocalCache\UserCfg.opt")
)
$community = $null
if ($CommunityDir -and (Test-Path $CommunityDir)) { $community = (Resolve-Path $CommunityDir).Path }
if (-not $community) {
foreach ($c in $cands) {
  if (Test-Path $c) {
    $line = Select-String -Path $c -Pattern '^\s*InstalledPackagesPath\s+"(.+)"' | Select-Object -First 1
    if ($line) { $p = Join-Path $line.Matches[0].Groups[1].Value "Community"; if (Test-Path $p) { $community = $p; break } }
  }
}
}
if (-not $community) {
  Write-Host "Could not find your Community folder. Copy this folder into it yourself:"
  Write-Host "   $pkg"
  exit 0
}
$dst = Join-Path $community "vatflow-towercab-maps"
Write-Host "ARTCC video maps package -> $dst"
Get-ChildItem $pkg -Recurse -File | ForEach-Object {
  $rel = $_.FullName.Substring($pkg.Length + 1)
  $to = Join-Path $dst $rel
  $isData = $rel -like "*.json" -and $rel -notlike "manifest.json" -and $rel -notlike "layout.json"
  if ($isData -and (Test-Path $to)) { return }                 # keep the ARTCC files you have
  if ($rel -eq "layout.json" -and (Test-Path $to)) { return }  # rebuilt below
  New-Item -ItemType Directory -Force (Split-Path $to) | Out-Null
  Copy-Item $_.FullName $to -Force
}
# rebuild the file list for whatever ARTCC files are there now
$utf8 = New-Object Text.UTF8Encoding($false)
$items = Get-ChildItem (Join-Path $dst "html_ui") -Recurse -File | Sort-Object FullName | ForEach-Object {
  [ordered]@{ path = $_.FullName.Substring($dst.Length + 1).Replace("\", "/"); size = $_.Length; date = $_.LastWriteTimeUtc.ToFileTimeUtc() }
}
[IO.File]::WriteAllText((Join-Path $dst "layout.json"), ([ordered]@{ content = @($items) } | ConvertTo-Json -Depth 5), $utf8)
Get-ChildItem (Join-Path $dst "html_ui\Pages\VCockpit\Instruments\VatflowTower\facilities") -Filter *.json | ForEach-Object { Write-Host "   ARTCC file: $($_.Name)" }
Write-Host "Done. To add or update ARTCCs later: $dst\update-maps.bat"
