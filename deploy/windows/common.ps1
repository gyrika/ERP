# Shared by install.ps1, update.ps1, backup.ps1 and status.ps1 (Windows PowerShell 5.1).
# Everything the POS keeps on the shop PC lives under C:\CheesyBeez.

$ErrorActionPreference = 'Stop'

$Base      = 'C:\CheesyBeez'
$Root      = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path   # the project (C:\CheesyBeez\ERP)
$Logs      = "$Base\logs"
$Backups   = "$Base\backups"
$Port      = 8080
$TaskServer = 'CheesyBeez POS server'
$TaskBackup = 'CheesyBeez nightly backup'
$TaskUpdate = 'CheesyBeez nightly update'

function Write-Step([string]$text) { Write-Host ''; Write-Host "== $text" -ForegroundColor Cyan }
function Write-Ok([string]$text)   { Write-Host "   $text" -ForegroundColor Green }
function Write-Note([string]$text) { Write-Host "   $text" -ForegroundColor Yellow }

function Assert-Admin {
  $me = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this as administrator: right-click PowerShell > Run as administrator.'
  }
}

# Programs installed a moment ago are not on this window's PATH yet.
function Update-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

# Runs a program and stops everything if it fails (PowerShell does not do that for .exe files).
function Invoke-Native {
  param([Parameter(Mandatory = $true)][string]$File, [string[]]$Arguments = @())
  & $File @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$File $($Arguments -join ' ') failed (exit code $LASTEXITCODE)" }
}

function Invoke-Npm([string[]]$Arguments) {
  Push-Location $Root
  try { Invoke-Native 'npm.cmd' $Arguments } finally { Pop-Location }
}

function Get-Download([string]$Url, [string]$OutFile) {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $ProgressPreference = 'SilentlyContinue'   # the progress bar makes downloads many times slower in 5.1
  Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing
}

# A random password: letters and digits only, so it is safe in a URL, a .env file and a SQL string.
function New-Secret([int]$Length = 32) {
  $chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  $bytes = New-Object byte[] $Length
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  -join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })
}

# Only administrators and Windows itself may read files holding passwords.
function Protect-File([string]$Path) {
  Invoke-Native 'icacls.exe' @($Path, '/inheritance:r', '/grant:r', '*S-1-5-32-544:F', '*S-1-5-18:F') | Out-Null
}

# KEY=value files (server\.env, server\.env.migrate).
function Read-EnvFile([string]$Path) {
  $values = @{}
  if (Test-Path $Path) {
    foreach ($line in Get-Content $Path) {
      if ($line -match '^\s*([A-Z_]+)=(.*)$') { $values[$Matches[1]] = $Matches[2] }
    }
  }
  $values
}

function Write-EnvFile([string]$Path, [hashtable]$Values) {
  $lines = $Values.Keys | Sort-Object | ForEach-Object { "$_=$($Values[$_])" }
  # ASCII, no BOM: Node reads these files and a BOM would end up in the first key.
  [IO.File]::WriteAllLines($Path, [string[]]$lines, (New-Object Text.ASCIIEncoding))
  Protect-File $Path
}

# mysql://user:password@host:port/database
function ConvertFrom-DbUrl([string]$Url) {
  if ($Url -notmatch '^mysql://([^:]+):([^@]+)@([^:/]+):(\d+)/(.+)$') { throw "Not a MySQL address: $Url" }
  @{ User = $Matches[1]; Password = $Matches[2]; Host = $Matches[3]; Port = $Matches[4]; Database = $Matches[5] }
}

function Find-MySqlBin {
  $cmd = Get-Command 'mysql.exe' -ErrorAction SilentlyContinue
  if ($cmd) { return (Split-Path $cmd.Source) }
  foreach ($pattern in @("$Base\mysql\bin\mysql.exe", "$env:ProgramFiles\MySQL\MySQL Server *\bin\mysql.exe")) {
    $found = Get-ChildItem $pattern -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1
    if ($found) { return $found.DirectoryName }
  }
  return $null
}

# Runs SQL through the mysql client. The password goes in through MYSQL_PWD, never on the command line.
function Invoke-MySql {
  param([string]$Bin, [string]$User, [string]$Password, [string]$Sql, [string]$Database = '')
  $env:MYSQL_PWD = $Password
  try {
    $arguments = @('-u', $User, '-h', '127.0.0.1', '--protocol=TCP', '-N', '-B')
    if ($Database) { $arguments += $Database }
    $out = $Sql | & (Join-Path $Bin 'mysql.exe') @arguments
    if ($LASTEXITCODE -ne 0) { throw "MySQL refused the command (exit code $LASTEXITCODE)" }
    $out
  } finally {
    Remove-Item Env:\MYSQL_PWD -ErrorAction SilentlyContinue
  }
}

function Test-Server {
  try {
    $r = Invoke-RestMethod -Uri "http://localhost:$Port/api/v1/health" -TimeoutSec 3
    return [bool]$r.ok
  } catch { return $false }
}

function Wait-Server([int]$Seconds = 60) {
  for ($i = 0; $i -lt $Seconds; $i++) {
    if (Test-Server) { return $true }
    Start-Sleep -Seconds 1
  }
  return $false
}
