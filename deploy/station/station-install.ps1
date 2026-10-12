# Run by the installer (as administrator, hidden) after the files are in place; safe to run again.
# Makes the POS start with Windows, keeps the PC awake, lets tablets on the shop Wi-Fi in,
# checks for updates every night, and starts the POS now.
$ErrorActionPreference = 'Stop'
$app = $PSScriptRoot
$data = Join-Path $env:ProgramData 'CheesyBeez'
New-Item -ItemType Directory -Force -Path (Join-Path $data 'logs') | Out-Null
# The shop's data (sales, staff, the cloud key) is for Windows and administrators only, not every user.
& icacls.exe $data /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null

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

# The counter app shows the POS with Windows' own web engine (WebView2). Windows 10 and 11 normally
# have it already; if not, Microsoft's small installer fetches it (quietly).
$webview = 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
$present = (Test-Path $webview) -and ((Get-ItemProperty $webview -ErrorAction SilentlyContinue).pv -notin @($null, '', '0.0.0.0'))
if (-not $present) {
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $boot = Join-Path $env:TEMP 'MicrosoftEdgeWebview2Setup.exe'
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' -OutFile $boot -UseBasicParsing
    Start-Process -FilePath $boot -ArgumentList '/silent', '/install' -Wait
  } catch {
    Add-Content -Path (Join-Path $data 'logs\install.log') -Value "WebView2 could not be installed: $($_.Exception.Message)"
  }
}

Start-ScheduledTask -TaskName 'CheesyBeez Station'
