# Every night at 4 am (as SYSTEM): if GitHub has a newer CheesyBeez Station, install it quietly.
# The installer keeps the shop's data (C:\ProgramData\CheesyBeez) and restarts the POS.
# Never during service: it does nothing if a sale was recorded in the last 15 minutes,
# unless the owner pressed "Update now" in Shop setup (-Force).
param([switch]$Force)
$ErrorActionPreference = 'Stop'
$log = Join-Path $env:ProgramData 'CheesyBeez\logs\update.log'
function Note([string]$text) { Add-Content -Path $log -Value ("[{0:yyyy-MM-dd HH:mm}] {1}" -f (Get-Date), $text) }
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $current = [version](Get-Content (Join-Path $PSScriptRoot 'version.txt') -Raw).Trim()
  $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/gyrika/ERP/releases/latest' -Headers @{ 'User-Agent' = 'CheesyBeez-Station' } -TimeoutSec 30
  $latest = [version]($release.tag_name.TrimStart('v'))
  if ($latest -le $current) { Note "Up to date ($current)."; exit 0 }

  $busy = Get-ChildItem (Join-Path $env:ProgramData 'CheesyBeez\pos.sqlite-wal') -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -gt (Get-Date).AddMinutes(-15) }
  if ($busy -and -not $Force) { Note "Version $latest is ready, but the shop is busy: trying tomorrow."; exit 0 }
  if ($Force) { Note 'Update now: asked for in Shop setup.' }

  $asset = $release.assets | Where-Object { $_.name -like 'CheesyBeez-Setup-*.exe' } | Select-Object -First 1
  if (-not $asset) { Note "Release $latest has no installer."; exit 0 }
  $file = Join-Path $env:TEMP $asset.name
  $ProgressPreference = 'SilentlyContinue'
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $file -UseBasicParsing
  Note "Installing $latest (was $current)."
  $p = Start-Process -FilePath $file -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART' -Wait -PassThru
  Note "Installer finished (exit $($p.ExitCode))."
  Remove-Item $file -Force -ErrorAction SilentlyContinue
} catch {
  Note "Update check failed: $($_.Exception.Message)"
}
