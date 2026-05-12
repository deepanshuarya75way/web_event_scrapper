#!/bin/zsh
# ─────────────────────────────────────────────────────────────
# run.sh – Start Appium (with ANDROID_HOME) then launch scraper
# Usage:
#   ./run.sh          → run scraper (resumes from last stop)
#   ./run.sh --reset  → clear output/ and start fresh
# ─────────────────────────────────────────────────────────────

export ANDROID_HOME="$HOME/Library/Android/sdk"
export ANDROID_SDK_ROOT="$HOME/Library/Android/sdk"
export PATH="$PATH:$ANDROID_HOME/platform-tools"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="$HOME/.nvm/versions/node/v24.9.0/bin/node"
APPIUM="$HOME/.nvm/versions/node/v24.9.0/bin/appium"

case "$1" in
  --reset)
    echo "Clearing output/…"
    rm -f "$SCRIPT_DIR/output/profiles.json" "$SCRIPT_DIR/output/profiles.csv"
    ;;
  --help|-h)
    echo "Usage: ./run.sh [--reset | --nofilter | --help]"
    exit 0
    ;;
esac

# ── Start Appium if not already running (or restart if missing ANDROID_HOME) ──
APPIUM_RUNNING=0
if curl -s http://127.0.0.1:4723/status > /dev/null 2>&1; then
  # Check if the running Appium has ANDROID_HOME by probing with a dummy session
  # Simpler: just always restart to ensure env vars are set correctly
  echo "Restarting Appium to ensure ANDROID_HOME is set…"
  pkill -f "node.*appium" 2>/dev/null || true
  sleep 1
fi

echo "Starting Appium server…"
"$APPIUM" --allow-cors > /tmp/appium-websummit.log 2>&1 &
APPIUM_PID=$!
sleep 4

if ! curl -s http://127.0.0.1:4723/status > /dev/null 2>&1; then
  echo "ERROR: Appium failed to start. Check /tmp/appium-websummit.log"
  exit 1
fi
echo "Appium started (PID $APPIUM_PID)"

# ── Run scraper ───────────────────────────────────────────────
cd "$SCRIPT_DIR"
"$NODE" scraper.js "$@"
