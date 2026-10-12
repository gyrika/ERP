# CheesyBeez POS: undoes install.ps1 on a PC that should not keep the POS (a test PC, an old
# counter PC). Run as administrator. It asks before deleting the data.
#   uninstall.ps1
# Node.js and Git stay installed (other programs may use them); remove them in
# Settings > Apps if you want.

. (Join-Path $PSScriptRoot 'common.ps1')
Assert-Admin
$ErrorActionPreference = 'Continue'   # undo as much as possible, even if one part is already gone

Write-Step 'Stopping the POS'
foreach ($name in @($TaskServer, $TaskBackup, $TaskUpdate)) {
  if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $name -Confirm:$false
    Write-Ok "Removed task: $name"
  }
}
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like '*server/main.ts*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Ok 'Stopped the server.' }

$lnk = Join-Path ([Environment]::GetFolderPath('CommonStartup')) 'CheesyBeez POS.lnk'
if (Test-Path $lnk) { Remove-Item $lnk -Force; Write-Ok 'The POS no longer opens at login.' }

if (Get-NetFirewallRule -DisplayName 'CheesyBeez POS' -ErrorAction SilentlyContinue) {
  Remove-NetFirewallRule -DisplayName 'CheesyBeez POS'
  Write-Ok "Closed port $Port."
}

Write-Step 'Sleep settings'
# Windows' usual defaults on mains power: screen off after 10 minutes, sleep after 30.
& powercfg.exe /change monitor-timeout-ac 10
& powercfg.exe /change standby-timeout-ac 30
Write-Ok 'The PC may sleep again (screen 10 min, sleep 30 min).'

Write-Step 'MySQL'
$ownMySql = Get-Service -Name 'CheesyBeezMySQL' -ErrorAction SilentlyContinue
if ($ownMySql) {
  # Our own MySQL (installed by install.ps1): remove it completely, with its data, if confirmed.
  Write-Note 'This MySQL was installed for the POS. Removing it deletes ALL POS data (sales, staff).'
  if ((Read-Host '   Type DELETE to remove it, or press Enter to keep it') -eq 'DELETE') {
    Stop-Service 'CheesyBeezMySQL' -Force
    & "$Base\mysql\bin\mysqld.exe" --remove CheesyBeezMySQL | Out-Null
    Remove-Item "$Base\mysql", "$Base\mysql-data", "$Base\mysql-root-password.txt" -Recurse -Force -ErrorAction SilentlyContinue
    Write-Ok 'MySQL and the POS data removed.'
  }
} else {
  # A MySQL that was there before: only the POS database and its two users go, if confirmed.
  $bin = Find-MySqlBin
  if ($bin) {
    Write-Note 'MySQL was already on this PC: only the POS database (cheesybeez) and its users would go.'
    if ((Read-Host '   Type DELETE to remove them, or press Enter to keep them') -eq 'DELETE') {
      $rootPw = Read-Host '   MySQL admin (root) password' -AsSecureString
      $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($rootPw)
      try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
      Invoke-MySql -Bin $bin -User 'root' -Password $plain -Sql @"
DROP DATABASE IF EXISTS cheesybeez;
DROP USER IF EXISTS 'pos_app'@'localhost';
DROP USER IF EXISTS 'pos_migrate'@'localhost';
"@ | Out-Null
      Write-Ok 'POS database and users removed.'
    }
  }
}

Write-Step 'Files'
Write-Note "Backups are in $Backups."
if ((Read-Host "   Type DELETE to remove $Base completely (the POS, logs and backups), or press Enter to keep it") -eq 'DELETE') {
  Set-Location $env:TEMP   # cannot delete the folder this window is in
  Remove-Item $Base -Recurse -Force -ErrorAction SilentlyContinue
  if (Test-Path $Base) { Write-Note "Some files in $Base were in use: delete the folder after a restart." }
  else { Write-Ok "$Base removed." }
}

Write-Step 'Done'
Write-Ok 'The POS is removed. Node.js and Git remain (Settings > Apps to remove them).'
