#!/bin/bash
# Xibo Player - Chromium Kiosk Launcher
#
# Alternative to Electron for systems where Electron's GPU doesn't work
# (e.g. NVIDIA Optimus on Wayland). Uses system Chromium which has full
# GPU acceleration out of the box.
#
# Usage:
#   ./chromium-kiosk.sh [--dev] [--no-kiosk] [--port=8765] [--cms-url=URL --cms-key=KEY]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT=8765
DEV=""
KIOSK="--kiosk"
CHROMIUM=""

# Parse arguments
for arg in "$@"; do
  case "$arg" in
    --dev)       DEV="--dev" ;;
    --no-kiosk)  KIOSK="" ;;
    --port=*)    PORT="${arg#--port=}" ;;
  esac
done

# Find Chromium binary
for bin in chromium-browser chromium google-chrome-stable google-chrome; do
  if command -v "$bin" &>/dev/null; then
    CHROMIUM="$bin"
    break
  fi
done

if [ -z "$CHROMIUM" ]; then
  echo "ERROR: No Chromium/Chrome browser found. Install chromium-browser or google-chrome."
  exit 1
fi

echo "[Launcher] Using browser: $CHROMIUM"
echo "[Launcher] Port: $PORT"

# Start the Express server in the background
node "$SCRIPT_DIR/src/server-standalone.js" --port="$PORT" $DEV &
SERVER_PID=$!

# Wait for server to be ready
echo "[Launcher] Waiting for server on port $PORT..."
for i in $(seq 1 30); do
  if curl -s "http://localhost:$PORT/" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

# Check server started
if ! kill -0 "$SERVER_PID" 2>/dev/null; then
  echo "ERROR: Server failed to start"
  exit 1
fi

echo "[Launcher] Server ready, launching $CHROMIUM"

# Pre-create Chromium policy to auto-grant permissions (no prompts in kiosk)
POLICY_DIR="$HOME/.config/xibo-player-chromium/policies/managed"
mkdir -p "$POLICY_DIR"
cat > "$POLICY_DIR/xibo-kiosk.json" <<'POLICY'
{
  "DefaultNotificationsSetting": 1,
  "DefaultGeolocationSetting": 1,
  "DefaultMediaStreamSetting": 1,
  "VideoCaptureAllowed": true,
  "AudioCaptureAllowed": true,
  "ScreenCaptureAllowed": true,
  "WakeLockAllowed": true,
  "DefaultWebUsbGuardSetting": 1,
  "DefaultInsecureContentSetting": 2,
  "AutoplayAllowed": true
}
POLICY
echo "[Launcher] Chromium policies set (auto-grant permissions)"

# Launch Chromium in app/kiosk mode
# --app gives a clean window without address bar
# System Chromium handles GPU acceleration automatically
"$CHROMIUM" \
  $KIOSK \
  --app="http://localhost:$PORT/player/pwa/" \
  --disable-translate \
  --disable-infobars \
  --disable-features=PermissionChip \
  --no-first-run \
  --no-default-browser-check \
  --autoplay-policy=no-user-gesture-required \
  --unsafely-treat-insecure-origin-as-secure="http://localhost:$PORT" \
  --user-data-dir="$HOME/.config/xibo-player-chromium" \
  "$@" &

BROWSER_PID=$!

echo "[Launcher] Browser PID: $BROWSER_PID, Server PID: $SERVER_PID"

# Keep server running until Ctrl+C
cleanup() {
  echo "[Launcher] Shutting down..."
  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Wait for server (keeps running until Ctrl+C or browser close kills script)
wait "$SERVER_PID" 2>/dev/null || true
