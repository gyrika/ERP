# CheesyBeez POS: one-screen health check, for when you connect from far away (AnyDesk).
. (Join-Path $PSScriptRoot 'common.ps1')

function Show([string]$label, [bool]$ok, [string]$detail) {
  $mark = 'OK  '
  $color = 'Green'
  if (-not $ok) { $mark = 'FIX '; $color = 'Red' }
  Write-Host ("{0} {1,-16} {2}" -f $mark, $label, $detail) -ForegroundColor $color
}

Write-Host ''
Write-Host "CheesyBeez POS on $env:COMPUTERNAME  ($(Get-Date -Format 'yyyy-MM-dd HH:mm'))"
Write-Host ''

$up = Test-Server
Show 'Server' $up ("http://localhost:$Port" + $(if ($up) { '' } else { "  not answering: see $Logs\server.log" }))

$task = Get-ScheduledTask -TaskName $TaskServer -ErrorAction SilentlyContinue
Show 'Starts with PC' ([bool]$task) $(if ($task) { "task: $($task.State)" } else { 'missing: run install.ps1' })

$mysql = Get-Service -Name 'CheesyBeezMySQL', 'MySQL*' -ErrorAction SilentlyContinue | Select-Object -First 1
Show 'MySQL' ($mysql -and $mysql.Status -eq 'Running') $(if ($mysql) { "$($mysql.Name): $($mysql.Status)" } else { 'no MySQL service found' })

$commit = (& git.exe -C $Root log -1 --format='%h %cd %s' --date=short 2>$null)
Show 'Version' ([bool]$commit) "$commit"

$envValues = Read-EnvFile (Join-Path $Root 'server\.env')
if ($envValues.ContainsKey('PRINTER')) {
  $p = Get-Printer -Name $envValues['PRINTER'] -ErrorAction SilentlyContinue
  Show 'Printer' ($p -and $p.PrinterStatus -eq 'Normal') $(if ($p) { "$($p.Name): $($p.PrinterStatus), $(@(Get-PrintJob -PrinterName $p.Name -ErrorAction SilentlyContinue).Count) waiting" } else { "'$($envValues['PRINTER'])' not found" })
} else {
  Show 'Printer' $false 'none set: receipts go to server\prints (dry run). Rerun install.ps1 to choose one.'
}

$last = Get-ChildItem $Backups -Filter 'cheesybeez-*.sql' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
$fresh = $last -and $last.LastWriteTime -gt (Get-Date).AddHours(-30)
Show 'Backup' $fresh $(if ($last) { "$($last.Name), $([math]::Round((Get-Item $last.FullName).Length / 1KB)) KB" } else { 'none yet' })

$disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID = 'C:'"
$freeGb = [math]::Round($disk.FreeSpace / 1GB, 1)
Show 'Disk C:' ($freeGb -gt 5) "$freeGb GB free"

Write-Host ''
Write-Host 'Last lines of the server log:'
Get-Content (Join-Path $Logs 'server.log') -Tail 8 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "  $_" }
