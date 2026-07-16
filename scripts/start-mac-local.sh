#!/bin/zsh
set -euo pipefail

# macOS launcher. The frontend, backend, PostgreSQL and Redis always run in
# Docker. --existing-mt5 keeps only the installed MetaTrader/Wine terminal and
# its Python bridge on macOS so the bridge can attach to that exact terminal.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR="$HOME/Library/Application Support/MT5Bot"
LOG_DIR="$STATE_DIR/logs"
MODE="mock"

while (( $# > 0 )); do
  case "$1" in
    --wine) MODE="wine" ;;
    --existing-mt5) MODE="existing" ;;
    --bridge-service) MODE="bridge-service" ;;
    --mock) MODE="mock" ;;
    *) echo "Usage: $0 [--mock|--existing-mt5|--wine]" >&2; exit 2 ;;
  esac
  shift
done

# Internal launchd entrypoint. Keeping this in the same script avoids a second
# user-facing launcher while allowing the bridge to survive terminal closure.
if [[ "$MODE" == "bridge-service" ]]; then
  BRIDGE_KEY_FILE="$STATE_DIR/bridge_api_key"
  BRIDGE_RUNTIME="$STATE_DIR/runtime"
  WINE_PREFIX="$HOME/Library/Application Support/net.metaquotes.wine.metatrader5"
  WINE_BIN="/Applications/MetaTrader 5.app/Contents/SharedSupport/wine/bin/wine"
  WINE_PY="$WINE_PREFIX/drive_c/Python312/python.exe"
  export WINEPREFIX="$WINE_PREFIX"
  export WINEDEBUG=-all
  export BRIDGE_API_KEY="$(<"$BRIDGE_KEY_FILE")"
  export MT5_MOCK=false
  export MT5_PATH='C:\Program Files\MetaTrader 5\terminal64.exe'
  export MT5_PORTABLE=false
  export PORT=5001
  exec "$WINE_BIN" "$WINE_PY" "$BRIDGE_RUNTIME/main.py"
fi

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

bridge_account_connected() {
  curl --max-time 3 --silent -H "x-api-key: $BRIDGE_KEY" "$BRIDGE_URL/health" 2>/dev/null | grep -q '"connected":true'
}

restart_mt5_app() {
  echo "Restarting the installed MetaTrader 5 terminal..."
  # `open -a` merely focuses an already-open app. Ask macOS to quit it first
  # so its Wine terminal and saved broker session are recreated cleanly.
  osascript -e 'tell application "MetaTrader 5" to quit' >/dev/null 2>&1 || true
  sleep 5
  open -a 'MetaTrader 5'
  # The terminal needs time to restore its saved account and complete broker
  # authorization before the MetaTrader5 Python package can attach.
  sleep 12
}

stop_managed_process() {
  local name="$1"
  local pid_file="$2"
  local command_marker="$3"
  local pid="$(cat "$pid_file" 2>/dev/null || true)"
  if [[ "$pid" =~ '^[0-9]+$' ]] && kill -0 "$pid" 2>/dev/null && ps -p "$pid" -o command= | grep -Fq "$command_marker"; then
    echo "Stopping $name..."
    kill "$pid"
    for _ in {1..10}; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done
  fi
  rm -f "$pid_file"
}

require_command docker
if [[ "$MODE" != "mock" ]]; then
  require_command openssl
fi

mkdir -p "$LOG_DIR"

echo "Starting PostgreSQL and Redis..."
cd "$ROOT"
# This command is deliberately a restart launcher. Recreate the stateful
# containers without deleting their named volumes, so database data remains.
docker compose up -d --force-recreate postgres redis

stop_managed_process "backend" "$STATE_DIR/backend.pid" "npm run dev"
stop_managed_process "frontend" "$STATE_DIR/frontend.pid" "npm run dev"

BRIDGE_URL="http://127.0.0.1:5001"
BRIDGE_KEY="change-me-bridge-key"
if [[ "$MODE" == "mock" ]]; then
  echo "Starting the mock MT5 bridge..."
  BRIDGE_KEY_FILE="$STATE_DIR/mock_bridge_api_key"
  if [[ ! -f "$BRIDGE_KEY_FILE" ]]; then
    umask 077
    print -r -- "$BRIDGE_KEY" > "$BRIDGE_KEY_FILE"
  fi
  docker rm -f mt5-bridge-real >/dev/null 2>&1 || true
  docker compose up -d --force-recreate mt5-bridge
elif [[ "$MODE" == "wine" ]]; then
  # The Wine image needs a non-default key in real mode. Store it outside the
  # repository; it is a bridge bootstrap secret, not an application .env file.
  BRIDGE_KEY_FILE="$STATE_DIR/bridge_api_key"
  WINE_DATA_DIR="$STATE_DIR/mt5-wine"
  if [[ ! -f "$BRIDGE_KEY_FILE" ]]; then
    umask 077
    openssl rand -hex 32 > "$BRIDGE_KEY_FILE"
  fi
  BRIDGE_KEY="$(<"$BRIDGE_KEY_FILE")"
  mkdir -p "$WINE_DATA_DIR"

  echo "Stopping the mock bridge and building the Wine/MT5 bridge..."
  echo "This first build is large and can take a long time. Apple Silicon runs it under x86 emulation."
  docker compose stop mt5-bridge >/dev/null 2>&1 || true
  docker rm -f mt5-bridge-real >/dev/null 2>&1 || true
  docker build --platform linux/amd64 --tag mt5-bridge-real --file "$ROOT/mt5-bridge/Dockerfile.real" "$ROOT/mt5-bridge"
  docker run -d --name mt5-bridge-real --restart unless-stopped --platform linux/amd64 \
    --publish 127.0.0.1:5001:5001 \
    --volume "$WINE_DATA_DIR:/wine" \
    --volume "$BRIDGE_KEY_FILE:/run/secrets/bridge_api_key:ro" \
    --env BRIDGE_API_KEY_FILE=/run/secrets/bridge_api_key \
    mt5-bridge-real >/dev/null
else
  # Reuse the official macOS MT5 app's existing Wine prefix. This installation
  # was inspected to contain terminal64.exe, Python 3.12, MetaTrader5, FastAPI,
  # Uvicorn and Pydantic, so no second terminal or Docker Wine image is needed.
  BRIDGE_KEY_FILE="$STATE_DIR/bridge_api_key"
  WINE_PREFIX="$HOME/Library/Application Support/net.metaquotes.wine.metatrader5"
  WINE_BIN="/Applications/MetaTrader 5.app/Contents/SharedSupport/wine/bin/wine"
  WINE_PY="$WINE_PREFIX/drive_c/Python312/python.exe"
  WINE_TERMINAL="$WINE_PREFIX/drive_c/Program Files/MetaTrader 5/terminal64.exe"
  if [[ ! -f "$WINE_BIN" || ! -f "$WINE_PY" || ! -f "$WINE_TERMINAL" ]]; then
    echo "Existing MetaTrader Wine installation is incomplete. Use --mock or install/reopen MetaTrader 5 first." >&2
    exit 1
  fi
  if [[ ! -f "$BRIDGE_KEY_FILE" ]]; then
    umask 077
    openssl rand -hex 32 > "$BRIDGE_KEY_FILE"
  fi
  BRIDGE_KEY="$(<"$BRIDGE_KEY_FILE")"
  docker compose stop mt5-bridge >/dev/null 2>&1 || true
  docker rm -f mt5-bridge-real >/dev/null 2>&1 || true
  launchctl remove com.mt5bot.mt5-bridge-existing >/dev/null 2>&1 || true
  stop_managed_process "existing MT5 bridge" "$STATE_DIR/mt5-bridge-existing.pid" "$ROOT/mt5-bridge/main.py"
  if lsof -tiTCP:5001 -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port 5001 is held by a process not managed by this launcher. Stop it, then rerun this script." >&2
    exit 1
  fi
  restart_mt5_app
  echo "Starting a fresh bridge as a supervised macOS service..."
  # Background launchd jobs cannot reliably read source files under Documents
  # because of macOS privacy controls. Copy the tiny bridge runtime into the
  # app's own state directory before submitting the supervised job.
  BRIDGE_RUNTIME="$STATE_DIR/runtime"
  mkdir -p "$BRIDGE_RUNTIME"
  cp "$ROOT/scripts/start-mac-local.sh" "$BRIDGE_RUNTIME/start-mac-local.sh"
  cp "$ROOT/mt5-bridge/main.py" "$BRIDGE_RUNTIME/main.py"
  cp "$ROOT/mt5-bridge/filling.py" "$BRIDGE_RUNTIME/filling.py"
  chmod 700 "$BRIDGE_RUNTIME/start-mac-local.sh"
  launchctl submit \
    -l com.mt5bot.mt5-bridge-existing \
    -o "$LOG_DIR/mt5-bridge-existing.out.log" \
    -e "$LOG_DIR/mt5-bridge-existing.err.log" \
    -- "$BRIDGE_RUNTIME/start-mac-local.sh" --bridge-service
  echo "Waiting for the MT5 account session..."
  for _ in {1..20}; do
    if bridge_account_connected; then
      echo "MT5 account connected."
      break
    fi
    sleep 2
  done
  if ! bridge_account_connected; then
    echo "MT5 opened, but no account was available to the bridge. Check the MT5 login window and rerun this script." >&2
    exit 1
  fi
fi

DOCKER_BRIDGE_URL="http://host.docker.internal:5001"
if [[ "$MODE" == "mock" ]]; then
  DOCKER_BRIDGE_URL="http://mt5-bridge:5001"
fi

echo "Building and restarting the containerized backend and frontend..."
docker compose up -d --build --force-recreate backend frontend

echo "Waiting for the containerized backend..."
for _ in {1..60}; do
  if curl --max-time 2 --silent --fail http://127.0.0.1:4000/health >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
if ! curl --max-time 2 --silent --fail http://127.0.0.1:4000/health >/dev/null 2>&1; then
  echo "Backend did not become healthy. Run: docker compose logs backend" >&2
  exit 1
fi

echo "Saving the MT5 bridge connection in database-backed Settings..."
docker compose exec -T backend node dist/scripts/configure-local-bridge.js "$DOCKER_BRIDGE_URL" - < "$BRIDGE_KEY_FILE"

echo
echo "Mac Docker stack started in $MODE mode."
echo "Dashboard: http://localhost:3000"
echo "Backend:   http://localhost:4000/health"
echo "App logs:  docker compose logs -f backend frontend"
echo "MT5 logs:  $LOG_DIR"
echo "The MT5 bridge connection was saved automatically in Settings."
echo
if [[ "$MODE" == "mock" ]]; then
  echo "This uses the Docker mock bridge. It is safe for demo testing only and cannot send real trades."
elif [[ "$MODE" == "wine" ]]; then
  echo "Wine MT5 bridge logs: docker logs -f mt5-bridge-real"
  echo "Wine mode is experimental on macOS. Verify a demo account, broker symbol list, and minimum-size demo order before considering any live-trading gate."
else
  echo "Existing-MT5 bridge logs: $LOG_DIR/mt5-bridge-existing.out.log"
  echo "This reuses your installed MetaTrader Wine prefix. Verify a demo account and minimum-size demo order before considering any live-trading gate."
fi
