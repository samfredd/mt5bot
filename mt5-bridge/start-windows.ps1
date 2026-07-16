$ErrorActionPreference = "Stop"

$dataDir = "C:\mt5-data"
$templateDir = "C:\mt5-template"
$terminal = Join-Path $dataDir "terminal64.exe"

if (-not (Test-Path $terminal)) {
  New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
  Copy-Item (Join-Path $templateDir "*") $dataDir -Recurse -Force
}

# Start the portable terminal before the Python integration attaches to it.
# Credentials are supplied per account by the backend /connect flow and are
# not persisted in this image or passed through environment files.
Start-Process -FilePath $terminal -ArgumentList "/portable" -WorkingDirectory $dataDir
Start-Sleep -Seconds 15

& python C:\app\main.py
exit $LASTEXITCODE
