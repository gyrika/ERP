# Every night at 4 am (as SYSTEM): a backup of the shop's data, then, if GitHub has a newer
# CheesyBeez Station, install it quietly. The installer keeps the shop's data
# (C:\ProgramData\CheesyBeez) and restarts the POS.
# Never during service: it installs nothing if a sale was recorded in the last 15 minutes,
# unless the owner pressed "Update now" in Shop setup (-Force).
# Safe: another backup right before installing, and if the new version does not answer within
# 3 minutes, the version that was running is put back by itself. Everything goes in logs\update.log.
param([switch]$Force)
$ErrorActionPreference = 'Stop'
$data = Join-Path $env:ProgramData 'CheesyBeez'
$log = Join-Path $data 'logs\update.log'
function Note([string]$text) { Add-Content -Path $log -Value ("[{0:yyyy-MM-dd HH:mm}] {1}" -f (Get-Date), $text) }

function Backup([string]$label) {
  $node = Join-Path $PSScriptRoot 'node\node.exe'
  $script = Join-Path $PSScriptRoot 'app\server\sqliteBackup.ts'
  $out = & $node --experimental-strip-types --no-warnings $script $data $label 2>&1
  Note ($out -join ' ')
  return ($LASTEXITCODE -eq 0)
}

# The shop server's port (station.env may change it).
$port = 8080
$envFile = Join-Path $data 'station.env'
if (Test-Path $envFile) {
  $line = Get-Content $envFile | Where-Object { $_ -match '^\s*PORT\s*=\s*(\d+)' } | Select-Object -First 1
  if ($line -match '(\d+)\s*$') { $port = [int]$Matches[1] }
}

# Waits for the shop server to answer as this version (up to 3 minutes).
function Answers([string]$version) {
  $until = (Get-Date).AddMinutes(3)
  while ((Get-Date) -lt $until) {
    try {
      $h = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/v1/health" -TimeoutSec 5
      if ($h.version -eq $version) { return $true }
    } catch { }
    Start-Sleep -Seconds 5
  }
  return $false
}

function Install([string]$url, [string]$name) {
  $file = Join-Path $env:TEMP $name
  $ProgressPreference = 'SilentlyContinue'
  Invoke-WebRequest -Uri $url -OutFile $file -UseBasicParsing
  $p = Start-Process -FilePath $file -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART' -Wait -PassThru
  Remove-Item $file -Force -ErrorAction SilentlyContinue
  return $p.ExitCode
}

try {
  if (-not $Force) { [void](Backup 'nightly') }

  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $current = (Get-Content (Join-Path $PSScriptRoot 'version.txt') -Raw).Trim()
  $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/gyrika/ERP/releases/latest' -Headers @{ 'User-Agent' = 'CheesyBeez-Station' } -TimeoutSec 30
  $latest = $release.tag_name.TrimStart('v')
  if ([version]$latest -le [version]$current) { Note "Up to date ($current)."; exit 0 }
  $skipFile = Join-Path $data 'update-skip.txt'
  if ((Test-Path $skipFile) -and (Get-Content $skipFile -Raw).Trim() -eq $latest) { Note "Version $latest did not start here before: waiting for a newer one."; exit 0 }

  $busy = Get-ChildItem (Join-Path $data 'pos.sqlite-wal') -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -gt (Get-Date).AddMinutes(-15) }
  if ($busy -and -not $Force) { Note "Version $latest is ready, but the shop is busy: trying tomorrow."; exit 0 }
  if ($Force) { Note 'Update now: asked for in Shop setup.' }

  $asset = $release.assets | Where-Object { $_.name -like 'CheesyBeez-Setup-*.exe' } | Select-Object -First 1
  if (-not $asset) { Note "Release $latest has no installer."; exit 0 }
  # No update without a good backup of the sales first.
  if (-not (Backup "before-$latest")) { Note "Not updating to ${latest}: the backup did not work."; exit 0 }

  Note "Installing $latest (was $current)."
  $code = Install $asset.browser_download_url $asset.name
  Note "Installer finished (exit $code)."
  if (Answers $latest) { Note "Running $latest."; exit 0 }

  # The new version did not start: put back the one that was running. The data stays as it is
  # (database changes only ever add, so the older version reads it); the backup is there if needed.
  Note "Version $latest did not answer within 3 minutes: going back to $current."
  Set-Content -Path $skipFile -Value $latest
  $back = "CheesyBeez-Setup-$current.exe"
  $code = Install "https://github.com/gyrika/ERP/releases/download/v$current/$back" $back
  if (Answers $current) { Note "Back on $current (installer exit $code). Version $latest is skipped until a newer one comes out." }
  else { Note "Going back to $current did not answer either (installer exit $code): needs a look over AnyDesk." }
} catch {
  Note "Update failed: $($_.Exception.Message)"
}
