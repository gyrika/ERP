# CheesyBeez POS: copies the whole database to C:\CheesyBeez\backups, every night at 3 am
# (scheduled by install.ps1). Keeps 14 days. If a USB drive with a folder named
# CheesyBeezBackup is plugged in, the newest copy also goes there: that is the copy
# that survives if the PC itself dies, until the cloud copy (SCRUM-61) exists.

. (Join-Path $PSScriptRoot 'common.ps1')

New-Item -ItemType Directory -Force -Path $Backups | Out-Null
$m = ConvertFrom-DbUrl (Read-EnvFile (Join-Path $Root 'server\.env.migrate'))['MIGRATE_DATABASE_URL']
$bin = Find-MySqlBin
if (-not $bin) { throw 'MySQL not found.' }

$file = Join-Path $Backups ("cheesybeez-{0:yyyy-MM-dd}.sql" -f (Get-Date))
$env:MYSQL_PWD = $m.Password
try {
  # --single-transaction: a consistent copy without stopping sales.
  & (Join-Path $bin 'mysqldump.exe') -u $m.User -h 127.0.0.1 --protocol=TCP --single-transaction --no-tablespaces `
    --result-file="$file" $m.Database
  if ($LASTEXITCODE -ne 0) { throw "mysqldump failed (exit code $LASTEXITCODE)" }
} finally {
  Remove-Item Env:\MYSQL_PWD -ErrorAction SilentlyContinue
}
Protect-File $file   # it holds every sale: administrators only

Get-ChildItem $Backups -Filter 'cheesybeez-*.sql' | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-14) } | Remove-Item -Force

foreach ($drive in Get-CimInstance Win32_LogicalDisk -Filter 'DriveType = 2') {
  $target = Join-Path ($drive.DeviceID + '\') 'CheesyBeezBackup'
  if (Test-Path $target) { Copy-Item $file $target -Force }
}
Write-Output "Backup: $file ($([math]::Round((Get-Item $file).Length / 1KB)) KB)"
