# Gathers what CheesyBeez Station installs into deploy/station/stage/ (run from the repo root after
# `npm ci` and `npm run build`): Node.js for Windows, the server, the built app, and only the
# runtime packages. Used by .github/workflows/station.yml.
# -Cache: a folder kept between runs (the workflow caches it), so Node.js downloads only once per version.
param([Parameter(Mandatory = $true)][string]$NodeVersion, [Parameter(Mandatory = $true)][string]$AppVersion, [string]$Cache = $env:TEMP)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$stage = Join-Path $PSScriptRoot 'stage'
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path "$stage\node", "$stage\app" | Out-Null

# Node.js: just node.exe, the exact version this POS is tested with.
New-Item -ItemType Directory -Force -Path $Cache | Out-Null
$cached = Join-Path $Cache "node-v$NodeVersion.exe"
if (-not (Test-Path $cached)) {
  $zip = Join-Path $env:TEMP "node-v$NodeVersion-win-x64.zip"
  Invoke-WebRequest -Uri "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip" -OutFile $zip -UseBasicParsing
  Expand-Archive $zip -DestinationPath $env:TEMP -Force
  Copy-Item "$env:TEMP\node-v$NodeVersion-win-x64\node.exe" "$cached.part"
  Move-Item "$cached.part" $cached
}
Copy-Item $cached "$stage\node\node.exe"

# The POS: the server, the code it shares with the app, the built app (no tests, no local data).
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
foreach ($dir in @('server', 'src', 'dist')) {
  Copy-Item (Join-Path $root $dir) "$stage\app\$dir" -Recurse
}
Get-ChildItem "$stage\app" -Recurse -Include '*.test.ts', '*.test.tsx' | Remove-Item -Force
foreach ($local in @('server\data', 'server\prints', 'server\.env', 'server\.env.migrate')) {
  $p = Join-Path "$stage\app" $local
  if (Test-Path $p) { Remove-Item $p -Recurse -Force }
}
Copy-Item (Join-Path $root 'package.json'), (Join-Path $root 'package-lock.json') "$stage\app"
Push-Location "$stage\app"
try { & npm.cmd ci --omit=dev --ignore-scripts --no-audit --no-fund; if ($LASTEXITCODE) { throw 'npm ci failed' } } finally { Pop-Location }

Set-Content -Path "$stage\version.txt" -Value $AppVersion -NoNewline
Write-Host "Staged CheesyBeez Station $AppVersion ($([math]::Round((Get-ChildItem $stage -Recurse | Measure-Object Length -Sum).Sum / 1MB)) MB)"
