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

# Where the update is, for the progress bar in Shop setup > Updates (the shop server hands it on).
$statusFile = Join-Path $data 'update-status.json'
$script:target = ''
function Status([string]$phase, [int]$percent) {
  $s = @{ phase = $phase; percent = $percent; version = $script:target; at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
  try { [IO.File]::WriteAllText($statusFile, ($s | ConvertTo-Json -Compress)) } catch { }
}

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

# Downloads with real progress: 5% to 60% of the bar.
function Download([string]$url, [string]$file, [bool]$show) {
  $req = [Net.HttpWebRequest]::Create($url)
  $req.UserAgent = 'CheesyBeez-Station'
  $res = $req.GetResponse()
  $total = $res.ContentLength
  $in = $res.GetResponseStream()
  $out = [IO.File]::Create($file)
  try {
    $buf = New-Object byte[] 262144
    $done = 0; $shown = -1
    while (($n = $in.Read($buf, 0, $buf.Length)) -gt 0) {
      $out.Write($buf, 0, $n)
      $done += $n
      if ($show -and $total -gt 0) {
        $pct = 5 + [int](55 * $done / $total)
        if ($pct -ne $shown) { Status 'downloading' $pct; $shown = $pct }
      }
    }
  } finally { $out.Close(); $in.Close(); $res.Close() }
}

function Install([string]$url, [string]$name, [bool]$show = $true) {
  $file = Join-Path $env:TEMP $name
  Download $url $file $show
  if ($show) { Status 'installing' 65 }
  $p = Start-Process -FilePath $file -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART' -Wait -PassThru
  Remove-Item $file -Force -ErrorAction SilentlyContinue
  return $p.ExitCode
}

try {
  if ($Force) { Status 'checking' 2 }
  if (-not $Force) { [void](Backup 'nightly') }

  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $current = (Get-Content (Join-Path $PSScriptRoot 'version.txt') -Raw).Trim()
  $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/gyrika/ERP/releases/latest' -Headers @{ 'User-Agent' = 'CheesyBeez-Station' } -TimeoutSec 30
  $latest = $release.tag_name.TrimStart('v')
  $script:target = $latest
  if ([version]$latest -le [version]$current) { Note "Up to date ($current)."; if ($Force) { Status 'up-to-date' 100 }; exit 0 }
  $skipFile = Join-Path $data 'update-skip.txt'
  if ((Test-Path $skipFile) -and (Get-Content $skipFile -Raw).Trim() -eq $latest) { Note "Version $latest did not start here before: waiting for a newer one."; exit 0 }

  $busy = Get-ChildItem (Join-Path $data 'pos.sqlite-wal') -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -gt (Get-Date).AddMinutes(-15) }
  if ($busy -and -not $Force) { Note "Version $latest is ready, but the shop is busy: trying tomorrow."; exit 0 }
  Status 'downloading' 5
  if ($Force) { Note 'Update now: asked for in Shop setup.' }

  $asset = $release.assets | Where-Object { $_.name -like 'CheesyBeez-Setup-*.exe' } | Select-Object -First 1
  if (-not $asset) { Note "Release $latest has no installer."; exit 0 }
  # No update without a good backup of the sales first.
  Status 'backup' 61
  if (-not (Backup "before-$latest")) { Note "Not updating to ${latest}: the backup did not work."; Status 'failed' 100; exit 0 }

  Note "Installing $latest (was $current)."
  $code = Install $asset.browser_download_url $asset.name
  Note "Installer finished (exit $code)."
  Status 'starting' 85
  if (Answers $latest) { Note "Running $latest."; Status 'done' 100; exit 0 }

  # The new version did not start: put back the one that was running. The data stays as it is
  # (database changes only ever add, so the older version reads it); the backup is there if needed.
  Note "Version $latest did not answer within 3 minutes: going back to $current."
  Status 'going-back' 90
  Set-Content -Path $skipFile -Value $latest
  $back = "CheesyBeez-Setup-$current.exe"
  $code = Install "https://github.com/gyrika/ERP/releases/download/v$current/$back" $back $false
  if (Answers $current) { Note "Back on $current (installer exit $code). Version $latest is skipped until a newer one comes out."; Status 'back' 100 }
  else { Note "Going back to $current did not answer either (installer exit $code): needs a look over AnyDesk." }
} catch {
  Note "Update failed: $($_.Exception.Message)"
  if ($Force) { Status 'failed' 100 }
}
