# Every 5 minutes and when Windows starts (as SYSTEM): if GitHub has a newer CheesyBeez Station,
# download it silently and install it when nobody can feel it. The installer keeps the shop's data
# (C:\ProgramData\CheesyBeez) and restarts the POS.
# Never during service: it installs only in the first minutes after Windows starts (before the
# first sale), or late at night (23:00-06:00) once the counter has been quiet for an hour, or when
# the owner pressed "Update now" in Shop setup (the shop server leaves update-now.txt and starts
# this task; -Force does the same by hand). A PC switched off every night therefore
# updates the next time it is switched on. At 4 am (-Nightly, or at the next start if the PC was
# off) it first makes the nightly backup of the shop's data.
# Safe: another backup right before installing, and if the new version does not answer within
# 3 minutes, the version that was running is put back by itself. Everything goes in logs\update.log.
param([switch]$Force, [switch]$Nightly)
$ErrorActionPreference = 'Stop'
$data = Join-Path $env:ProgramData 'CheesyBeez'
$log = Join-Path $data 'logs\update.log'
function Note([string]$text) { Add-Content -Path $log -Value ("[{0:yyyy-MM-dd HH:mm}] {1}" -f (Get-Date), $text) }

# Where the update is, for the progress bar in Shop setup > Updates (the shop server hands it on).
$statusFile = Join-Path $data 'update-status.json'
$script:target = ''
$script:installing = $false
function Status([string]$phase, [int]$percent) {
  $s = @{ phase = $phase; percent = $percent; version = $script:target; at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
  try { [IO.File]::WriteAllText($statusFile, ($s | ConvertTo-Json -Compress)) } catch { }
}

# "Update now": the note counts for 15 minutes only, so one nobody picked up (the task was off)
# never installs in the middle of service later. Taken once, so it is not done twice.
$nowFile = Join-Path $data 'update-now.txt'
function UpdateNow {
  $f = Get-Item $nowFile -ErrorAction SilentlyContinue
  if (-not $f) { return $false }
  $fresh = ((Get-Date) - $f.LastWriteTime).TotalMinutes -lt 15  # read before the file is gone
  Remove-Item $nowFile -Force -ErrorAction SilentlyContinue
  return $fresh
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

# Waits for the shop server to answer as this version (36 tries, 5 s apart: about 3 minutes).
# Counted in tries, not clock time: a PC that sleeps meanwhile must not look like a failed start.
function Answers([string]$version) {
  for ($try = 0; $try -lt 36; $try++) {
    try {
      $h = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/v1/health" -TimeoutSec 5
      if ($h.version -eq $version) { return $true }
    } catch { }
    Start-Sleep -Seconds 5
  }
  return $false
}

# Downloads with real progress: 5% to 60% of the bar. A quiet download (the 5-minute check) starts
# showing it, and becomes "Update now", if the owner presses it meanwhile.
function Download([string]$url, [string]$file, [bool]$show) {
  $req = [Net.HttpWebRequest]::Create($url)
  $req.UserAgent = 'CheesyBeez-Station'
  $res = $req.GetResponse()
  $total = $res.ContentLength
  $in = $res.GetResponseStream()
  $out = [IO.File]::Create($file)
  try {
    $buf = New-Object byte[] 262144
    $done = 0; $shown = -1; $look = 0
    while (($n = $in.Read($buf, 0, $buf.Length)) -gt 0) {
      $out.Write($buf, 0, $n)
      $done += $n
      if (-not $show -and -not $script:installing -and $done -ge $look) {
        $look = $done + 1MB
        if (UpdateNow) { $script:Force = $true; $show = $true }
      }
      if ($show -and $total -gt 0) {
        $pct = 5 + [int](55 * $done / $total)
        if ($pct -ne $shown) { Status 'downloading' $pct; $shown = $pct }
      }
    }
  } finally { $out.Close(); $in.Close(); $res.Close() }
}

function Install([string]$file) {
  $p = Start-Process -FilePath $file -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART' -Wait -PassThru
  return $p.ExitCode
}

try {
  if (UpdateNow) { $Force = $true }
  if ($Force) { Status 'checking' 2 }
  if ($Nightly) { [void](Backup 'nightly') }

  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $current = (Get-Content (Join-Path $PSScriptRoot 'version.txt') -Raw).Trim()
  $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/gyrika/ERP/releases/latest' -Headers @{ 'User-Agent' = 'CheesyBeez-Station' } -TimeoutSec 30
  $latest = $release.tag_name.TrimStart('v')
  $script:target = $latest
  # Checked every 5 minutes: only the nightly run and "Update now" say so in the log.
  if ([version]$latest -le [version]$current) { if ($Nightly -or $Force) { Note "Up to date ($current)." }; if ($Force) { Status 'up-to-date' 100 }; exit 0 }
  $skipFile = Join-Path $data 'update-skip.txt'
  if ((Test-Path $skipFile) -and (Get-Content $skipFile -Raw).Trim() -eq $latest) { if ($Nightly -or $Force) { Note "Version $latest did not start here before: waiting for a newer one." }; if ($Force) { Status 'failed' 100 }; exit 0 }

  $asset = $release.assets | Where-Object { $_.name -like 'CheesyBeez-Setup-*.exe' } | Select-Object -First 1
  if (-not $asset) { Note "Release $latest has no installer."; if ($Force) { Status 'failed' 100 }; exit 0 }

  # Downloaded ahead, silently (no notice at the counter), so installing later takes only seconds.
  $cache = Join-Path $data 'updates'
  New-Item -ItemType Directory -Force -Path $cache | Out-Null
  $file = Join-Path $cache $asset.name
  if (-not (Test-Path $file)) {
    Get-ChildItem $cache -File | Remove-Item -Force -ErrorAction SilentlyContinue  # older versions, a broken download
    if ($Force) { Status 'downloading' 5 }
    Download $asset.browser_download_url "$file.part" $Force
    if ((Get-Item "$file.part").Length -ne $asset.size) { throw "the download of $latest stopped part-way" }
    Move-Item "$file.part" $file
  }

  # "Update now" pressed while this run was already going (the task runs one at a time).
  if (-not $Force -and (UpdateNow)) { $Force = $true; Status 'checking' 2 }

  # When nobody can feel it. The shop server writes as it starts, so a write in the first 2 minutes
  # after Windows started is not a sale.
  $wal = Get-Item (Join-Path $data 'pos.sqlite-wal') -ErrorAction SilentlyContinue
  $lastWrite = if ($wal) { $wal.LastWriteTime } else { [datetime]::MinValue }
  $now = Get-Date
  $boot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime
  $justStarted = ($now - $boot).TotalMinutes -lt 20 -and $lastWrite -lt $boot.AddMinutes(2)
  $night = ($now.Hour -ge 23 -or $now.Hour -lt 6) -and $lastWrite -lt $now.AddMinutes(-60)
  if (-not ($Force -or $justStarted -or $night)) {
    # Shop setup > Updates and the admin page say it is downloaded and when it installs.
    Status 'waiting' 100
    # Said once per version, not every 5 minutes.
    $waitFile = Join-Path $data 'update-waiting.txt'
    if (-not ((Test-Path $waitFile) -and (Get-Content $waitFile -Raw).Trim() -eq $latest)) {
      Note "Version $latest is downloaded; it installs the next time the PC starts, or tonight once the counter is quiet."
      Set-Content -Path $waitFile -Value $latest
    }
    exit 0
  }
  $script:installing = $true
  if ($Force) { Note 'Update now: asked for in Shop setup.' }
  # Keep Windows from sleeping until this run ends (it clears itself when the script exits).
  Add-Type -Namespace CheesyBeez -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);'
  [void][CheesyBeez.Power]::SetThreadExecutionState([uint32]'0x80000001')  # ES_CONTINUOUS | ES_SYSTEM_REQUIRED
  # No update without a good backup of the sales first.
  Status 'backup' 61
  if (-not (Backup "before-$latest")) { Note "Not updating to ${latest}: the backup did not work."; Status 'failed' 100; exit 0 }

  Note "Installing $latest (was $current)."
  Status 'installing' 65
  $code = Install $file
  Note "Installer finished (exit $code)."
  Status 'starting' 85
  if (Answers $latest) { Note "Running $latest."; Status 'done' 100; exit 0 }

  # The new version did not start: put back the one that was running. The data stays as it is
  # (database changes only ever add, so the older version reads it); the backup is there if needed.
  Note "Version $latest did not answer within 3 minutes: going back to $current."
  Status 'going-back' 90
  Set-Content -Path $skipFile -Value $latest
  $back = Join-Path $env:TEMP "CheesyBeez-Setup-$current.exe"
  Download "https://github.com/gyrika/ERP/releases/download/v$current/CheesyBeez-Setup-$current.exe" $back $false
  $code = Install $back
  Remove-Item $back -Force -ErrorAction SilentlyContinue
  if (Answers $current) { Note "Back on $current (installer exit $code). Version $latest is skipped until a newer one comes out."; Status 'back' 100 }
  else { Note "Going back to $current did not answer either (installer exit $code): needs a look over AnyDesk." }
} catch {
  # No internet for a 5-minute check is normal: logged only when it matters.
  if ($Force -or $Nightly -or $script:installing) { Note "Update failed: $($_.Exception.Message)" }
  if ($Force) { Status 'failed' 100 }
}
