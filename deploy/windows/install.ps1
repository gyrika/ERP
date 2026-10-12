# CheesyBeez POS: sets up the counter PC (Windows 10/11), in one go. Run as administrator.
# Safe to run again: every step checks what is already there and skips it.
# The written-down guide is docs/install-windows.md.

. (Join-Path $PSScriptRoot 'common.ps1')
Assert-Admin

$NodeVersion  = '22.23.3'
$MySqlVersion = '8.4.3'
$Downloads    = Join-Path $Base 'downloads'
$MySqlHome    = Join-Path $Base 'mysql'
$MySqlData    = Join-Path $Base 'mysql-data'
$EnvFile      = Join-Path $Root 'server\.env'
$MigrateFile  = Join-Path $Root 'server\.env.migrate'
$RootPwFile   = Join-Path $Base 'mysql-root-password.txt'

New-Item -ItemType Directory -Force -Path $Base, $Logs, $Backups, $Downloads | Out-Null
Start-Transcript -Path (Join-Path $Logs ("install-{0:yyyy-MM-dd-HHmm}.log" -f (Get-Date))) | Out-Null

function Read-Choice([string]$Question, [string[]]$Options) {
  for ($i = 0; $i -lt $Options.Count; $i++) { Write-Host ("   {0}. {1}" -f ($i + 1), $Options[$i]) }
  while ($true) {
    $answer = Read-Host "   $Question (1-$($Options.Count))"
    $n = 0
    if ([int]::TryParse($answer, [ref]$n) -and $n -ge 1 -and $n -le $Options.Count) { return $n - 1 }
  }
}

function Read-Secret([string]$Question) {
  $secure = Read-Host "   $Question" -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

function Read-YesNo([string]$Question, [bool]$Default = $false) {
  $hint = 'y/N'
  if ($Default) { $hint = 'Y/n' }
  $a = Read-Host "   $Question ($hint)"
  if (-not $a) { return $Default }
  return $a -match '^[yY]'
}

try {
  # ---------------------------------------------------------------- Node.js
  Write-Step 'Node.js'
  Update-Path
  $node = Get-Command 'node.exe' -ErrorAction SilentlyContinue
  $nodeOk = $false
  if ($node) {
    $major = [int](((& node.exe --version) -replace '^v', '').Split('.')[0])
    $nodeOk = ($major -ge 22)
  }
  if ($nodeOk) {
    Write-Ok "Node.js $(& node.exe --version) is installed."
  } else {
    $msi = Join-Path $Downloads "node-v$NodeVersion-x64.msi"
    if (-not (Test-Path $msi)) { Get-Download "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-x64.msi" $msi }
    Invoke-Native 'msiexec.exe' @('/i', $msi, '/qn', '/norestart')
    Update-Path
    Write-Ok "Node.js $NodeVersion installed."
  }

  # ---------------------------------------------------------------- MySQL
  Write-Step 'MySQL'
  $bin = Find-MySqlBin
  $rootPassword = $null
  if ($bin) {
    Write-Ok "Found MySQL in $bin."
    if (Test-Path $RootPwFile) { $rootPassword = (Get-Content $RootPwFile -Raw).Trim() }
  } else {
    # Our own MySQL, as a Windows service that starts with the PC. Needs the Microsoft C++ runtime.
    Write-Note 'MySQL is not installed: installing it for the POS (a few minutes).'
    $vc = Join-Path $Downloads 'vc_redist.x64.exe'
    if (-not (Test-Path $vc)) { Get-Download 'https://aka.ms/vs/17/release/vc_redist.x64.exe' $vc }
    & $vc /install /quiet /norestart | Out-Null   # exit 1638 = already installed, fine
    $zip = Join-Path $Downloads "mysql-$MySqlVersion-winx64.zip"
    if (-not (Test-Path $zip)) { Get-Download "https://dev.mysql.com/get/Downloads/MySQL-8.4/mysql-$MySqlVersion-winx64.zip" $zip }
    Expand-Archive -Path $zip -DestinationPath $Base -Force
    if (Test-Path $MySqlHome) { Remove-Item $MySqlHome -Recurse -Force }
    Rename-Item (Join-Path $Base "mysql-$MySqlVersion-winx64") $MySqlHome
    $ini = @"
[mysqld]
basedir=$($MySqlHome -replace '\\', '/')
datadir=$($MySqlData -replace '\\', '/')
port=3306
bind-address=127.0.0.1
character-set-server=utf8mb4
"@
    [IO.File]::WriteAllText((Join-Path $MySqlHome 'my.ini'), $ini, (New-Object Text.ASCIIEncoding))
    $bin = Join-Path $MySqlHome 'bin'
    if (-not (Test-Path $MySqlData)) {
      Invoke-Native (Join-Path $bin 'mysqld.exe') @("--defaults-file=$MySqlHome\my.ini", '--initialize-insecure', '--console')
    }
    Invoke-Native (Join-Path $bin 'mysqld.exe') @('--install', 'CheesyBeezMySQL', "--defaults-file=$MySqlHome\my.ini")
    Start-Service 'CheesyBeezMySQL'
    $ready = $false
    for ($i = 0; $i -lt 60 -and -not $ready; $i++) {
      try { Invoke-MySql -Bin $bin -User 'root' -Password '' -Sql 'SELECT 1;' | Out-Null; $ready = $true } catch { Start-Sleep -Seconds 1 }
    }
    if (-not $ready) { throw 'MySQL did not start. See C:\CheesyBeez\mysql-data\*.err' }
    # It starts with an empty root password: give it a random one and keep it for the owner.
    $rootPassword = New-Secret
    Invoke-MySql -Bin $bin -User 'root' -Password '' -Sql "ALTER USER 'root'@'localhost' IDENTIFIED BY '$rootPassword';" | Out-Null
    [IO.File]::WriteAllText($RootPwFile, $rootPassword)
    Protect-File $RootPwFile
    Write-Ok "MySQL $MySqlVersion installed as the CheesyBeezMySQL service."
    Write-Note "The MySQL admin password is in $RootPwFile (administrators only). Keep a copy with the owner."
  }

  # ---------------------------------------------------------------- Database and its two users
  Write-Step 'Database'
  if ((Test-Path $EnvFile) -and (Test-Path $MigrateFile)) {
    Write-Ok 'Already set up (server\.env and server\.env.migrate exist).'
  } else {
    if (-not $rootPassword) { $rootPassword = Read-Secret 'MySQL admin (root) password' }
    $appPw = New-Secret
    $migratePw = New-Secret
    $bootstrap = (Get-Content (Join-Path $Root 'server\bootstrap.sql') -Raw).
      Replace('<app password>', $appPw).Replace('<migrate password>', $migratePw)
    # Users that already exist keep their old password, which we do not know: reset both.
    $bootstrap += "`nALTER USER 'pos_app'@'localhost' IDENTIFIED BY '$appPw';`nALTER USER 'pos_migrate'@'localhost' IDENTIFIED BY '$migratePw';`n"
    Invoke-MySql -Bin $bin -User 'root' -Password $rootPassword -Sql $bootstrap | Out-Null
    Write-EnvFile $MigrateFile @{ MIGRATE_DATABASE_URL = "mysql://pos_migrate:$migratePw@localhost:3306/cheesybeez" }
    Write-EnvFile $EnvFile @{ DATABASE_URL = "mysql://pos_app:$appPw@localhost:3306/cheesybeez"; PORT = "$Port" }
    Write-Ok 'Database and users created; passwords saved for the server (administrators only).'
  }

  # ---------------------------------------------------------------- The app
  # The nightly update runs as SYSTEM, which Git would otherwise refuse in a folder an admin cloned.
  if (Get-Command 'git.exe' -ErrorAction SilentlyContinue) {
    & git.exe config --system --replace-all safe.directory ($Root -replace '\\', '/') | Out-Null
  }
  Write-Step 'Building the POS'
  Invoke-Npm @('ci', '--no-audit', '--no-fund')
  Invoke-Npm @('run', 'build')
  Invoke-Npm @('run', 'server:migrate')
  Write-Ok 'Built, and the database is up to date.'

  # ---------------------------------------------------------------- Receipt printer
  Write-Step 'Receipt printer'
  $envValues = Read-EnvFile $EnvFile
  $printers = @(Get-Printer -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name)
  $current = 'none'
  if ($envValues.ContainsKey('PRINTER')) { $current = $envValues['PRINTER'] }
  Write-Host "   Now: $current"
  $options = @('No printer yet (receipts are saved as files instead)') + $printers
  $pick = Read-Choice 'Which printer prints the receipts?' $options
  if ($pick -eq 0) { $envValues.Remove('PRINTER') } else { $envValues['PRINTER'] = $printers[$pick - 1] }
  Write-EnvFile $EnvFile $envValues

  # ---------------------------------------------------------------- Shop id
  $shopFile = Join-Path $Base 'shop-id.txt'
  if (Test-Path $shopFile) {
    $shop = (Get-Content $shopFile -Raw).Trim()
  } else {
    $shop = Read-Host '   Shop id (Enter for cheesybeez-thalwila)'
    if (-not $shop) { $shop = 'cheesybeez-thalwila' }
    [IO.File]::WriteAllText($shopFile, $shop)
  }

  # ---------------------------------------------------------------- Staff
  Write-Step 'Staff and their PINs'
  Push-Location $Root
  try {
    & npm.cmd run -s server:staff -- list --shop $shop
    while ($true) {
      $name = Read-Host '   Add a person: name (Enter when done)'
      if (-not $name) { break }
      $roles = @('cashier', 'manager', 'owner', 'kitchen')
      $role = $roles[(Read-Choice 'Role' @('Cashier', 'Manager', 'Owner', 'Kitchen'))]
      $pin = Read-Secret "$name's 4-digit PIN"
      & npm.cmd run -s server:staff -- add --shop $shop --name $name --role $role --pin $pin
      if ($LASTEXITCODE -ne 0) { Write-Note 'Not added (see above). Try again.' }
    }
  } finally { Pop-Location }

  # ---------------------------------------------------------------- Start with Windows
  Write-Step 'Starting with Windows'
  $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/c "{0}"' -f (Join-Path $PSScriptRoot 'run-server.cmd')) -WorkingDirectory $Root
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
  $system = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  Register-ScheduledTask -TaskName $TaskServer -Action $action -Trigger (New-ScheduledTaskTrigger -AtStartup) -Settings $settings -Principal $system -Force | Out-Null
  Stop-ScheduledTask -TaskName $TaskServer -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like '*server/main.ts*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Start-ScheduledTask -TaskName $TaskServer
  if (Wait-Server 60) { Write-Ok "The server is running on http://localhost:$Port and starts with Windows." }
  else { throw "The server did not start. See $Logs\server.log" }

  # Nightly backup at 3 am, kept for 14 days.
  $backup = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f (Join-Path $PSScriptRoot 'backup.ps1'))
  Register-ScheduledTask -TaskName $TaskBackup -Action $backup -Trigger (New-ScheduledTaskTrigger -Daily -At 3am) -Settings $settings -Principal $system -Force | Out-Null
  Write-Ok "Nightly backup at 3 am into $Backups."

  if (Read-YesNo 'Install updates by themselves at 4 am, when the shop is closed?' $false) {
    $update = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f (Join-Path $PSScriptRoot 'update.ps1'))
    Register-ScheduledTask -TaskName $TaskUpdate -Action $update -Trigger (New-ScheduledTaskTrigger -Daily -At 4am) -Settings $settings -Principal $system -Force | Out-Null
    Write-Ok 'Nightly update at 4 am.'
  }

  # ---------------------------------------------------------------- The counter screen
  Write-Step 'The counter screen'
  if (-not (Test-Path (Join-Path $Base 'counter-paired.txt'))) {
    Push-Location $Root
    try {
      $out = & npm.cmd run -s server:device -- --kind counter --shop $shop --name 'CheesyBeez'
      if ($LASTEXITCODE -ne 0) { throw 'Could not register the counter.' }
    } finally { Pop-Location }
    $link = ($out | Select-String -Pattern 'http://\S+').Matches[0].Value
    # open-pos.cmd opens this once, in the same browser it will always use, then deletes it.
    [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'pairing-link.txt'), $link)
    [IO.File]::WriteAllText((Join-Path $Base 'counter-paired.txt'), (Get-Date).ToString('s'))
  }
  $startup = [Environment]::GetFolderPath('CommonStartup')   # whoever logs in at the counter
  $shell = New-Object -ComObject WScript.Shell
  $lnk = $shell.CreateShortcut((Join-Path $startup 'CheesyBeez POS.lnk'))
  $lnk.TargetPath = Join-Path $PSScriptRoot 'open-pos.cmd'
  $lnk.WorkingDirectory = $PSScriptRoot
  $lnk.WindowStyle = 7   # minimised: only the POS shows
  $lnk.Save()
  Write-Ok 'The POS opens full screen whenever someone logs in to Windows (Alt+F4 closes it).'

  # ---------------------------------------------------------------- Windows settings
  Write-Step 'Windows settings'
  # A counter PC that falls asleep mid-service is no use: never sleep, never blank the screen on mains power.
  Invoke-Native 'powercfg.exe' @('/change', 'standby-timeout-ac', '0')
  Invoke-Native 'powercfg.exe' @('/change', 'monitor-timeout-ac', '0')
  Write-Ok 'The PC never sleeps on mains power.'
  # For a kitchen tablet later, on the shop Wi-Fi only (private networks), never from outside.
  if (-not (Get-NetFirewallRule -DisplayName 'CheesyBeez POS' -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName 'CheesyBeez POS' -Direction Inbound -Protocol TCP -LocalPort $Port -Profile Private -Action Allow | Out-Null
  }
  Write-Ok "Port $Port open to devices on the shop's private network only."

  Write-Step 'Done'
  Write-Ok 'Next: open the POS (it starts by itself at the next login), log in with a PIN.'
  Write-Ok "Printer test: http://localhost:$Port/#receipt > Print a test receipt. Then one cash sale tests the drawer."
  Write-Ok 'Check everything any time: deploy\windows\status.ps1'
  Start-Process (Join-Path $PSScriptRoot 'open-pos.cmd')
} catch {
  Write-Host ''
  Write-Host "Stopped: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "Nothing is half-done that a second run cannot finish. The log is in $Logs." -ForegroundColor Red
  exit 1
} finally {
  Stop-Transcript | Out-Null
}
