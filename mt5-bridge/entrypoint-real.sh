#!/bin/bash
# Real-mode bridge entrypoint: headless display + MT5 terminal + bridge, all under Wine.
set -e

# Persist the Wine prefix (terminal login/config/history) across container
# restarts: when a volume is mounted at /wine, seed it once from the image.
if [ -d /wine ]; then
  if [ ! -f /wine/system.reg ]; then
    echo "seeding persistent wine prefix from image..."
    cp -a "$WINEPREFIX/." /wine/
  fi
  export WINEPREFIX=/wine
fi

Xvfb :99 -screen 0 1280x800x16 &
export DISPLAY=:99

# Optional: watch the terminal UI over VNC (port 5900) for debugging.
if [ "${DEBUG_VNC:-false}" = "true" ]; then
  x11vnc -display :99 -forever -nopw -quiet &
fi

# Pre-launch the terminal so mt5.initialize() can attach — more reliable
# under Wine than letting the Python package spawn it. /portable keeps all
# data inside the install dir (and therefore inside the persistent prefix).
wine "C:\\Program Files\\MetaTrader 5\\terminal64.exe" /portable &
sleep 20

exec wine python /app/main.py
