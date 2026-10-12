# Run by the installer (as administrator, hidden) after the files are in place; safe to run again.
# Makes the POS start with Windows, keeps the PC awake, lets tablets on the shop Wi-Fi in,
# checks for updates every night, and starts the POS now.
$ErrorActionPreference = 'Stop'
$app = $PSScriptRoot
$data = Join-Path $env:ProgramData 'CheesyBeez'
New-Item -ItemType Directory -Force -Path (Join-Path $data 'logs') | Out-Null

$system = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$always = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

# The shop server: starts with Windows, runs for ever (station.cmd restarts it if it stops).
$server = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/c "{0}"' -f (Join-Path $app 'station.cmd')) -WorkingDirectory $app
Register-ScheduledTask -TaskName 'CheesyBeez Station' -Action $server -Trigger (New-ScheduledTaskTrigger -AtStartup) -Principal $system -Settings $always -Force | Out-Null

# A newer version from GitHub, at 4 am when the shop is closed.
$update = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f (Join-Path $app 'station-update.ps1'))
Register-ScheduledTask -TaskName 'CheesyBeez Station update' -Action $update -Trigger (New-ScheduledTaskTrigger -Daily -At 4am) -Principal $system -Settings $always -Force | Out-Null

# A counter PC that sleeps mid-service is no use (mains power only; battery settings untouched).
& powercfg.exe /change standby-timeout-ac 0
& powercfg.exe /change monitor-timeout-ac 0

# Kitchen tablets on the shop's Wi-Fi (private networks only, never public ones).
if (-not (Get-NetFirewallRule -DisplayName 'CheesyBeez POS' -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName 'CheesyBeez POS' -Direction Inbound -Protocol TCP -LocalPort 8080 -Profile Private -Action Allow | Out-Null
}

Start-ScheduledTask -TaskName 'CheesyBeez Station'
