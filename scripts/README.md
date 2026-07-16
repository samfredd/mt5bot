# Launch scripts

## Mac: complete local demo stack

Run this on a Mac to start PostgreSQL, Redis, the mock MT5 bridge, backend,
and frontend without an `.env` file:

```bash
./scripts/start-mac-local.sh
```

For the Wine-backed MT5 terminal bridge, use:

```bash
./scripts/start-mac-local.sh --wine
```

Wine mode builds an x86_64 Linux image and is experimental on macOS, especially
on Apple Silicon. It is not the recommended production path; validate it on a
demo account first. The default without `--wine` remains safe mock mode.

If MetaTrader 5 is already installed on the Mac with its Windows Python bridge
dependencies, reuse that existing Wine prefix instead of creating a second
terminal:

```bash
./scripts/start-mac-local.sh --existing-mt5
```

## Mac: Ollama service

Run this on the Mac that hosts the model:

```bash
./scripts/start-mac-ollama.sh
```

It restarts Ollama bound to the private LAN, pulls `gemma3:12b`, and prints the
base URL for the Windows dashboard. An optional first argument selects another
model.

## Windows: real-MT5 development stack

Run this from PowerShell on the Windows PC after installing Docker Desktop
(Linux-container mode), Node 22, Python 3.12, and the MT5 desktop terminal:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\start-windows-live.ps1 -OllamaUrl http://192.168.1.25:11434
```

Replace the IP with the URL printed by the Mac script. The Windows script does
not create or load `.env`; it creates a local bridge bootstrap-secret file in
`%LOCALAPPDATA%\MT5Bot`, starts PostgreSQL/Redis, applies migrations, and
starts the native MT5 bridge, backend, and frontend. It prints the bridge key
that must be entered once in the dashboard's Operational configuration.
