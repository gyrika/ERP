# The one step on a fresh shop PC. In PowerShell, opened as administrator, paste:
#   irm https://raw.githubusercontent.com/gyrika/ERP/main/deploy/windows/get.ps1 | iex
# It installs Git if needed, downloads the POS to C:\CheesyBeez\ERP, and runs install.ps1.

$ErrorActionPreference = 'Stop'
$me = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Open PowerShell as administrator (right-click > Run as administrator) and paste the line again.'
}

$dir = 'C:\CheesyBeez\ERP'
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')

if (-not (Get-Command 'git.exe' -ErrorAction SilentlyContinue)) {
  Write-Host 'Installing Git...'
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $ProgressPreference = 'SilentlyContinue'
  $setup = Join-Path $env:TEMP 'git-setup.exe'
  Invoke-WebRequest -UseBasicParsing -OutFile $setup `
    -Uri 'https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.1/Git-2.47.1-64-bit.exe'
  Start-Process -FilePath $setup -ArgumentList '/VERYSILENT', '/NORESTART' -Wait
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

if (Test-Path (Join-Path $dir '.git')) {
  & git.exe -C $dir pull --ff-only
} else {
  New-Item -ItemType Directory -Force -Path (Split-Path $dir) | Out-Null
  & git.exe clone https://github.com/gyrika/ERP.git $dir
}
if ($LASTEXITCODE -ne 0) { throw 'Could not download the POS (is the internet up?).' }

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $dir 'deploy\windows\install.ps1')
