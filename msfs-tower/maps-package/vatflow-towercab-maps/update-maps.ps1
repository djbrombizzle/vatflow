# VATFLOW Tower Cab - ARTCC video maps package updater (see update-maps.bat / README.txt).
param([string]$Dir)
$ErrorActionPreference = "Stop"
$Dir = (Resolve-Path $Dir).Path
$drop = Join-Path $Dir "ARTCC files"
$fac = Join-Path $Dir "html_ui\Pages\VCockpit\Instruments\VatflowTower\facilities"
New-Item -ItemType Directory -Force $drop, $fac | Out-Null
$utf8 = New-Object Text.UTF8Encoding($false)

function Add-Artcc([string]$path) {
  # the file's own "id" (ZTL ...) names it, whatever the file is called
  try { $j = Get-Content $path -Raw | ConvertFrom-Json } catch { Write-Host "  skipped $path (not JSON)"; return }
  if (-not $j.id -or -not $j.videoMaps) { Write-Host "  skipped $path (not a vNAS ARTCC file: no id / videoMaps)"; return }
  $id = ([string]$j.id).ToUpper()
  Copy-Item $path (Join-Path $fac "$id.json") -Force
  Write-Host ("  {0}: {1} video maps" -f $id, @($j.videoMaps).Count)
}

$ids = Read-Host "ARTCC ids to download from vNAS now (e.g. ZTL or ZTL ZDC; Enter to skip)"
foreach ($id in ($ids -split "[\s,;]+" | Where-Object { $_ })) {
  $id = $id.ToUpper()
  $out = Join-Path $drop "$id.json"
  Write-Host "Downloading $id ..."
  try { Invoke-WebRequest "https://data-api.vnas.vatsim.net/api/artccs/$id" -OutFile $out -UseBasicParsing }
  catch { Write-Host "  could not download $id : $($_.Exception.Message)" }
}

Write-Host "ARTCC files:"
Get-ChildItem $drop -Filter *.json | ForEach-Object { Add-Artcc $_.FullName }

# layout.json: every file MSFS should load (the html_ui part of this package)
$items = Get-ChildItem (Join-Path $Dir "html_ui") -Recurse -File | Sort-Object FullName | ForEach-Object {
  [ordered]@{
    path = $_.FullName.Substring($Dir.Length + 1).Replace("\", "/")
    size = $_.Length
    date = $_.LastWriteTimeUtc.ToFileTimeUtc()
  }
}
$layout = [ordered]@{ content = @($items) }
[IO.File]::WriteAllText((Join-Path $Dir "layout.json"), ($layout | ConvertTo-Json -Depth 5), $utf8)
Write-Host ""
Write-Host ("Done: {0} ARTCC file(s) in the package. Restart the flight so the cab reads them." -f @($items).Count)
