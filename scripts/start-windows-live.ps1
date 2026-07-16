[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^https?://')]
  [string]$OllamaUrl,
  [string]$Mt5Path = 'C:\Program Files\MetaTrader 5\terminal64.exe',
  [switch]$SkipMigrations
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$backendDir = Join-Path $repoRoot 'backend'
$frontendDir = Join-Path $repoRoot 'frontend'
$bridgeDir = Join-Path $repoRoot 'mt5-bridge'
$stateDir = Join-Path $env:LOCALAPPDATA 'MT5Bot'
$logDir = Join-Path $stateDir 'logs'
$keyPath = Join-Path $stateDir 'bridge_api_key'

function Require-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name was not found. Install it, restart PowerShell, and run this script again."
  }
}

Require-Command docker
Require-Command npm.cmd
Require-Command py

if (-not (Test-Path $Mt5Path)) {
  throw "MT5 terminal was not found at '$Mt5Path'. Install MetaTrader 5 or pass -Mt5Path with the terminal64.exe path."
}

New-Item -ItemType Directory -Force -Path $stateDir, $logDir | Out-Null

# The bridge key is a deployment bootstrap secret, not an application setting
# or .env value. The dashboard stores the matching value encrypted after login.
if (-not (Test-Path $keyPath)) {
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  [System.IO.File]::WriteAllText($keyPath, [Convert]::ToHexString($bytes))
}
$bridgeKey = [System.IO.File]::ReadAllText($keyPath).Trim()

Write-Host 'Starting PostgreSQL and Redis containers...' -ForegroundColor Cyan
Push-Location $repoRoot
docker compose up -d postgres redis
Pop-Location

if (-not (Test-Path (Join-Path $backendDir 'node_modules'))) {
  Write-Host 'Installing backend dependencies...' -ForegroundColor Cyan
  Push-Location $backendDir; npm.cmd ci; Pop-Location
}
if (-not (Test-Path (Join-Path $frontendDir 'node_modules'))) {
  Write-Host 'Installing frontend dependencies...' -ForegroundColor Cyan
  Push-Location $frontendDir; npm.cmd ci; Pop-Location
}

$bridgePython = Join-Path $bridgeDir '.venv\Scripts\python.exe'
if (-not (Test-Path $bridgePython)) {
  Write-Host 'Creating the MT5 bridge Python environment...' -ForegroundColor Cyan
  Push-Location $bridgeDir
  py -3.12 -m venv .venv
  Pop-Location
}
Write-Host 'Ensuring MT5 bridge dependencies are installed...' -ForegroundColor Cyan
& $bridgePython -m pip install --disable-pip-version-check -q -r (Join-Path $bridgeDir 'requirements.txt')
& $bridgePython -m pip install --disable-pip-version-check -q MetaTrader5

if (-not $SkipMigrations) {
  Write-Host 'Applying database migrations...' -ForegroundColor Cyan
  $previousDatabaseUrl = $env:DATABASE_URL
  try {
    # One-off Prisma CLI bootstrap; no environment file is created or read.
    $env:DATABASE_URL = 'postgresql://mt5bot:mt5bot@localhost:5433/mt5bot'
    Push-Location $backendDir
    npx prisma migrate deploy
    Pop-Location
  } finally {
    if ($null -eq $previousDatabaseUrl) { Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue }
    else { $env:DATABASE_URL = $previousDatabaseUrl }
  }
}

# These values are inherited only by the bridge child process. Broker account
# credentials are entered through the dashboard and encrypted in PostgreSQL.
$env:MT5_MOCK = 'false'
$env:MT5_PATH = $Mt5Path
$env:MT5_PORTABLE = 'true'
$env:BRIDGE_API_KEY_FILE = $keyPath
$env:PORT = '5001'

$bridge = Start-Process -FilePath $bridgePython -ArgumentList (Join-Path $bridgeDir 'main.py') -WorkingDirectory $bridgeDir -PassThru `
  -RedirectStandardOutput (Join-Path $logDir 'mt5-bridge.out.log') -RedirectStandardError (Join-Path $logDir 'mt5-bridge.err.log')
$backend = Start-Process -FilePath 'npm.cmd' -ArgumentList @('run', 'dev') -WorkingDirectory $backendDir -PassThru `
  -RedirectStandardOutput (Join-Path $logDir 'backend.out.log') -RedirectStandardError (Join-Path $logDir 'backend.err.log')
$frontend = Start-Process -FilePath 'npm.cmd' -ArgumentList @('run', 'dev') -WorkingDirectory $frontendDir -PassThru `
  -RedirectStandardOutput (Join-Path $logDir 'frontend.out.log') -RedirectStandardError (Join-Path $logDir 'frontend.err.log')

@{ bridge = $bridge.Id; backend = $backend.Id; frontend = $frontend.Id } | ConvertTo-Json | Set-Content (Join-Path $stateDir 'running-processes.json')

Write-Host ''
Write-Host 'Started the real-MT5 Windows stack.' -ForegroundColor Green
Write-Host 'Dashboard: http://localhost:3000'
Write-Host 'Backend:   http://localhost:4000/health'
Write-Host "Logs:      $logDir"
Write-Host ''
Write-Host 'After registering/logging in, set these in Settings:' -ForegroundColor Yellow
Write-Host '  MT5 bridge URL:     http://127.0.0.1:5001'
Write-Host "  MT5 bridge API key: $bridgeKey"
Write-Host "  Ollama base URL:    $OllamaUrl"
Write-Host '  Ollama model:       gemma3:12b (or the model shown by the Mac script)'
Write-Host ''
Write-Host 'Start with a demo account. Do not enable live trading until the bridge health, account identity, and minimum-size demo order are verified.' -ForegroundColor Red
