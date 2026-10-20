#!/bin/zsh
# Install (or remove) the macOS LaunchAgent that keeps the bridge running.
#
#   npm run install:launchd
#   npm run uninstall:launchd
#
# The agent is a per-user LaunchAgent: it starts at login (and is restarted by
# launchd if it crashes). It does NOT start the OpenCode service itself — the
# bridge does that on demand via `opencode service start` (the shared service).

set -euo pipefail

LABEL="com.opencode.dingtalk-bridge"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
AGENT_DIR="$HOME/Library/LaunchAgents"
PLIST="$AGENT_DIR/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/$LABEL"
DOMAIN="gui/$(id -u)"

uninstall() {
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "removed $PLIST"
}

if [[ "${1:-}" == "--uninstall" ]]; then
  uninstall
  exit 0
fi

NODE_BIN="$(command -v node)"
if [[ -z "$NODE_BIN" ]]; then
  echo "error: node not found in PATH" >&2
  exit 1
fi
NODE_DIR="$(dirname "$NODE_BIN")"

if [[ ! -f "$PROJECT_DIR/dist/index.js" ]]; then
  echo "building..."
  (cd "$PROJECT_DIR" && npm run build >/dev/null)
fi

mkdir -p "$AGENT_DIR" "$LOG_DIR"
chmod 700 "$LOG_DIR"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${PROJECT_DIR}/dist/index.js</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${PROJECT_DIR}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${NODE_DIR}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <!-- the bridge talks to the local OpenCode service over loopback -->
    <key>NO_PROXY</key>
    <string>localhost,127.0.0.1,::1</string>
    <key>no_proxy</key>
    <string>localhost,127.0.0.1,::1</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <!-- do not spin if the bridge exits immediately (e.g. bad config) -->
  <key>ThrottleInterval</key>
  <integer>15</integer>

  <key>ProcessType</key>
  <string>Background</string>

  <key>StandardOutPath</key>
  <string>${LOG_DIR}/out.log</string>

  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/error.log</string>
</dict>
</plist>
PLIST_EOF

plutil -lint "$PLIST" >/dev/null

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl enable "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"

sleep 2
echo "installed: $PLIST"
echo "node:     $NODE_BIN"
echo "logs:     $LOG_DIR/out.log"
echo
launchctl print "$DOMAIN/$LABEL" 2>/dev/null | sed -n '1,12p' || echo "(service not reporting yet)"
