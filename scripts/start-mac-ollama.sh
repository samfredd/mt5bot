#!/bin/zsh
set -euo pipefail

MODEL="${1:-gemma3:12b}"
PORT="11434"

if ! command -v ollama >/dev/null 2>&1; then
  echo "Ollama is not installed. Install it from https://ollama.com/download, then run this script again." >&2
  exit 1
fi

# This affects the Ollama macOS app after it is restarted. It exposes Ollama
# only to the local network; configure the macOS firewall to allow the Windows
# PC and never port-forward this port to the Internet.
launchctl setenv OLLAMA_HOST "0.0.0.0:${PORT}"

if pgrep -x Ollama >/dev/null 2>&1; then
  osascript -e 'tell application "Ollama" to quit' || true
  sleep 2
fi
open -a Ollama

echo "Waiting for Ollama to start..."
for _ in {1..20}; do
  if curl --fail --silent "http://127.0.0.1:${PORT}/api/tags" >/dev/null; then
    break
  fi
  sleep 1
done

curl --fail --silent "http://127.0.0.1:${PORT}/api/tags" >/dev/null || {
  echo "Ollama did not start on port ${PORT}. Open the Ollama app and retry." >&2
  exit 1
}

echo "Pulling ${MODEL} if needed..."
ollama pull "$MODEL"

IP="$(ipconfig getifaddr en0 2>/dev/null || true)"
if [[ -z "$IP" ]]; then
  IP="$(ipconfig getifaddr en1 2>/dev/null || true)"
fi

echo
echo "Mac Ollama is ready. In the Windows dashboard, use:"
echo "  Base URL: http://${IP:-<your-mac-LAN-IP>}:${PORT}"
echo "  Model:    ${MODEL}"
echo
echo "Allow only the Windows PC through the macOS firewall. Do not expose port ${PORT} to the public Internet."
