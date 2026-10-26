# Builds cv-pack-<CV_PACK_VERSION>-win-x64.zip (SCRUM-169): what table detection needs beside CheesyBeez Station.
# The shop server downloads it from the release when the owner activates CV (server/cvPack.ts).
#   ffmpeg.exe                     BtbN static LGPL win64 build, ffmpeg.exe only (no ffprobe, ffplay, docs)
#   node_modules/onnxruntime-node  pinned, win32-x64 binaries only, with onnxruntime-common beside it
#   models/yolox_nano.onnx         YOLOX release 0.1.1rc0 (Apache-2.0), 416x416 input
#   LICENSES/                      each part's licence, and where ffmpeg's source is
#   manifest.json                  {version, files: [{path, sha256}]}, checked file by file by the server
# Anything in here changes the pack: raise CV_PACK_VERSION in server/cvPack.ts with it (that also makes a release).
# Every download is pinned by sha256. BtbN deletes its autobuilds after a few weeks, so the first build on main
# keeps a copy of the exact same files in this repo's "cv-deps" pre-release (-Mirror), and later builds take them
# from there; the sha256 is the same check either way.
# Usage (repo root, Windows, Node 22): ./deploy/cv-pack/build.ps1 -Out <folder> [-Cache <folder>] [-Mirror]
param(
  [Parameter(Mandatory)] [string]$Out,
  [string]$Cache = (Join-Path ([IO.Path]::GetTempPath()) 'cv-cache'),
  [switch]$Mirror
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$version = [regex]::Match((Get-Content server/cvPack.ts -Raw), "CV_PACK_VERSION = '([^']+)'").Groups[1].Value
if (-not $version) { throw 'CV_PACK_VERSION not found in server/cvPack.ts' }

$OrtVersion = '1.30.0'
$Pins = @(
  @{ Name = 'ffmpeg-n8.1.3-24-g92611900bb-win64-lgpl-8.1.zip'
     Sha256 = 'ed8b8dfe088ff978d657834cf96fe40d7dcbb011b37ff374005b66d5272448c9'
     Url = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-10-25-13-00/ffmpeg-n8.1.3-24-g92611900bb-win64-lgpl-8.1.zip' },
  @{ Name = 'yolox_nano.onnx'
     Sha256 = 'c789161ed43c8269fcd4e67c67eeeb4e80c622da2eb296a20bc6007bd18a0b7d'
     Url = 'https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_nano.onnx' }
)
$MirrorTag = 'cv-deps'
$MirrorBase = "https://github.com/gyrika/ERP/releases/download/$MirrorTag"
$FfmpegSource = 'https://github.com/FFmpeg/FFmpeg/tree/92611900bb (n8.1.3-24-g92611900bb), built by https://github.com/BtbN/FFmpeg-Builds (autobuild-2026-10-25-13-00)'
$YoloxLicense = 'https://raw.githubusercontent.com/Megvii-BaseDetection/YOLOX/0.1.1rc0/LICENSE'

function Sha256([string]$file) { (Get-FileHash -Algorithm SHA256 $file).Hash.ToLower() }

# One pinned file: from the cache, our mirror, or where it was published; refused unless its sha256 matches.
function Get-Pinned($pin) {
  New-Item -ItemType Directory -Force $Cache | Out-Null
  $file = Join-Path $Cache $pin.Name
  if (-not ((Test-Path $file) -and (Sha256 $file) -eq $pin.Sha256)) {
    $found = $false
    foreach ($url in @("$MirrorBase/$($pin.Name)", $pin.Url)) {
      Remove-Item -Force -ErrorAction SilentlyContinue $file
      & curl.exe -fsSL --retry 3 -o $file $url
      if ($LASTEXITCODE) { Write-Host "Not at $url"; continue }
      $got = Sha256 $file
      if ($got -ne $pin.Sha256) { Write-Host "$url has sha256 $got, not $($pin.Sha256): refused"; continue }
      Write-Host "$($pin.Name) from $url (sha256 ok)"
      $found = $true
      break
    }
    if (-not $found) { throw "$($pin.Name) is neither in $MirrorBase nor at $($pin.Url) with sha256 $($pin.Sha256)" }
  }
  if ($Mirror) { Save-Mirror $file | Out-Host }
  $global:LASTEXITCODE = 0
  return $file
}

# A pre-release that is never "latest": station-update.ps1 and the server look for the latest release.
function Save-Mirror([string]$file) {
  $name = Split-Path -Leaf $file
  $have = gh release view $MirrorTag --json assets --jq '.assets[].name' 2>$null
  if ($LASTEXITCODE) {
    gh release create $MirrorTag --prerelease --latest=false --title 'CV pack inputs (not an app release)' `
      --notes 'Pinned copies of what deploy/cv-pack/build.ps1 builds the CV pack from (the sha256s are in that script). Not a CheesyBeez version.'
    if ($LASTEXITCODE) { throw 'could not create the cv-deps release' }
    $have = @()
  }
  if (@($have) -contains $name) { return }
  gh release upload $MirrorTag $file
  if ($LASTEXITCODE) { throw "could not keep a copy of $name in cv-deps" }
  Write-Host "$name kept in the $MirrorTag pre-release"
}

$work = Join-Path ([IO.Path]::GetTempPath()) "cv-pack-build-$([guid]::NewGuid().ToString('N'))"
# The pack is put together outside the repo, so nothing in it can be found through the repo's node_modules.
$pack = Join-Path $work "cv-pack-$version"
New-Item -ItemType Directory -Force (Join-Path $pack 'models'), (Join-Path $pack 'LICENSES'), (Join-Path $pack 'node_modules') | Out-Null

# ffmpeg.exe and its licence; the rest of the build (ffprobe, ffplay, docs) is not needed.
$ff = Join-Path $work 'ffmpeg'
Expand-Archive -Path (Get-Pinned $Pins[0]) -DestinationPath $ff
$exe = Get-ChildItem $ff -Recurse -Filter ffmpeg.exe | Select-Object -First 1
if (-not $exe) { throw 'ffmpeg.exe is not in the ffmpeg build' }
Copy-Item $exe.FullName (Join-Path $pack 'ffmpeg.exe')
$ffLicense = Get-ChildItem $ff -Recurse -Filter LICENSE.txt | Select-Object -First 1
if (-not $ffLicense) { throw 'the ffmpeg build has no LICENSE.txt' }
Copy-Item $ffLicense.FullName (Join-Path $pack 'LICENSES/ffmpeg-LICENSE.txt')
Set-Content -Encoding utf8 (Join-Path $pack 'LICENSES/ffmpeg-SOURCE.txt') "ffmpeg.exe is FFmpeg under the LGPL 2.1 or later (an LGPL build: no GPL or nonfree parts).`r`nSource: $FfmpegSource"

# The model and its licence.
Copy-Item (Get-Pinned $Pins[1]) (Join-Path $pack 'models/yolox_nano.onnx')
& curl.exe -fsSL --retry 3 -o (Join-Path $pack 'LICENSES/YOLOX-LICENSE.txt') $YoloxLicense
if ($LASTEXITCODE) { throw "could not fetch $YoloxLicense" }

# ONNX Runtime for Node, installed on its own (the Station's node_modules never see it), Windows x64 only.
$ort = Join-Path $work 'ort'
New-Item -ItemType Directory -Force $ort | Out-Null
npm install --prefix $ort --no-save --no-package-lock --no-audit --no-fund "onnxruntime-node@$OrtVersion"
if ($LASTEXITCODE) { throw "npm could not install onnxruntime-node@$OrtVersion" }
foreach ($name in 'onnxruntime-node', 'onnxruntime-common') {
  Copy-Item -Recurse (Join-Path $ort "node_modules/$name") (Join-Path $pack "node_modules/$name")
  $lic = Get-ChildItem (Join-Path $pack "node_modules/$name") -File | Where-Object Name -match '^(LICENSE|ThirdPartyNotices)' | Select-Object -First 1
  if ($lic) { Copy-Item $lic.FullName (Join-Path $pack "LICENSES/$name-LICENSE.txt") }
}
$bins = Join-Path $pack 'node_modules/onnxruntime-node/bin'
(Get-ChildItem $bins -Directory -Recurse) | Where-Object { $_.Parent.Name -like 'napi-v*' -and $_.Name -ne 'win32' } | Remove-Item -Recurse -Force
(Get-ChildItem $bins -Directory -Recurse) | Where-Object { $_.Parent.Name -eq 'win32' -and $_.Name -ne 'x64' } | Remove-Item -Recurse -Force
if (-not (Get-ChildItem $bins -Recurse -Filter onnxruntime_binding.node | Where-Object FullName -match 'win32\\x64')) { throw 'onnxruntime-node has no win32/x64 binding' }
if (-not (Test-Path (Join-Path $pack 'LICENSES/onnxruntime-node-LICENSE.txt'))) { throw 'onnxruntime-node has no LICENSE' }

# The manifest: every file's sha256, which the server checks before it uses the pack.
$files = Get-ChildItem $pack -Recurse -File | Sort-Object FullName | ForEach-Object {
  [ordered]@{ path = $_.FullName.Substring($pack.Length + 1).Replace('\', '/'); sha256 = Sha256 $_.FullName }
}
[ordered]@{ version = $version; files = @($files) } | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8NoBOM (Join-Path $pack 'manifest.json')

New-Item -ItemType Directory -Force $Out | Out-Null
$zip = Join-Path (Resolve-Path $Out) "cv-pack-$version-win-x64.zip"
Remove-Item -Force -ErrorAction SilentlyContinue $zip
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($pack, $zip, [IO.Compression.CompressionLevel]::Optimal, $false)
Remove-Item -Recurse -Force $work
"$zip  $((Get-Item $zip).Length) bytes  sha256 $(Sha256 $zip)" | Write-Host
