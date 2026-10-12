# CheesyBeez POS: installs the newest version from GitHub (main). Run as administrator,
# over AnyDesk, or by itself at 4 am if install.ps1 was told to.
#   update.ps1          refuses while orders are coming in (any event in the last 15 minutes)
#   update.ps1 -Force   updates anyway
# If anything fails before the new version is confirmed running, it puts the old one back.

param([switch]$Force)
. (Join-Path $PSScriptRoot 'common.ps1')
Assert-Admin

$log = Join-Path $Logs ("update-{0:yyyy-MM-dd-HHmm}.log" -f (Get-Date))
Start-Transcript -Path $log | Out-Null
$dist = Join-Path $Root 'dist'
$next = Join-Path $Root 'dist-next'
$prev = Join-Path $Root 'dist-previous'

function Set-ServerRunning([bool]$On) {
  if ($On) { Start-ScheduledTask -TaskName $TaskServer; return }
  Stop-ScheduledTask -TaskName $TaskServer -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like '*server/main.ts*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
}

$old = $null
$swapped = $false
try {
  Push-Location $Root

  if (-not $Force) {
    $m = ConvertFrom-DbUrl (Read-EnvFile (Join-Path $Root 'server\.env.migrate'))['MIGRATE_DATABASE_URL']
    $bin = Find-MySqlBin
    $last = Invoke-MySql -Bin $bin -User $m.User -Password $m.Password -Database $m.Database `
      -Sql 'SELECT COALESCE(MAX(received_at), 0) FROM events;'
    $quietMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [int64]"$last".Trim()
    if ($quietMs -lt 15 * 60 * 1000) {
      Write-Note 'Orders are coming in (activity in the last 15 minutes): not updating now. Use -Force to override.'
      exit 0
    }
  }

  Write-Step 'Fetching'
  $old = (& git.exe rev-parse HEAD).Trim()
  Invoke-Native 'git.exe' @('fetch', '--quiet', 'origin', 'main')
  $new = (& git.exe rev-parse origin/main).Trim()
  if ($new -eq $old) { Write-Ok "Already up to date ($($old.Substring(0, 7)))."; exit 0 }
  Invoke-Native 'git.exe' @('merge', '--ff-only', '--quiet', 'origin/main')
  Write-Ok "$($old.Substring(0, 7)) -> $($new.Substring(0, 7))"
  & git.exe log --oneline "$old..$new"

  Write-Step 'Building (the POS keeps running meanwhile)'
  Invoke-Npm @('ci', '--no-audit', '--no-fund')
  Invoke-Npm @('run', 'typecheck')
  Invoke-Npm @('exec', '--', 'vite', 'build', '--outDir', 'dist-next', '--emptyOutDir')

  Write-Step 'Database changes'
  Invoke-Npm @('run', 'server:migrate')

  Write-Step 'Switching over'
  Set-ServerRunning $false
  if (Test-Path $prev) { Remove-Item $prev -Recurse -Force }
  if (Test-Path $dist) { Rename-Item $dist $prev }
  Rename-Item $next $dist
  $swapped = $true
  Set-ServerRunning $true
  if (-not (Wait-Server 60)) { throw 'The new version did not start.' }
  Write-Ok "Updated to $($new.Substring(0, 7)) and running."
} catch {
  Write-Host "Update failed: $($_.Exception.Message)" -ForegroundColor Red
  if ($old) {
    Write-Note "Putting $($old.Substring(0, 7)) back."
    # Database changes are only ever additions, so the old version runs on the new tables.
    & git.exe reset --hard --quiet $old
    & npm.cmd ci --no-audit --no-fund | Out-Null
    if ($swapped) {
      Set-ServerRunning $false
      if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
      if (Test-Path $prev) { Rename-Item $prev $dist }
    }
    if (Test-Path $next) { Remove-Item $next -Recurse -Force }
    Set-ServerRunning $true
    if (Wait-Server 60) { Write-Ok 'The old version is running again.' }
    else { Write-Host "The POS is not running. See $Logs\server.log" -ForegroundColor Red }
  }
  exit 1
} finally {
  Pop-Location
  Stop-Transcript | Out-Null
}
