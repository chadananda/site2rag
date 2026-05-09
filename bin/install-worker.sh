#!/usr/bin/env bash
# Install the site2rag worker agent on any machine (macOS or Linux).
# Requires: python3, ssh access to target, and optionally a registry URL.
#
# Usage (from your local machine):
#   bin/install-worker.sh <target-host> [--port 49910] [--registry http://tower-nas:49900]
#   bin/install-worker.sh jafar
#   bin/install-worker.sh jafar --registry http://tower-nas:49900

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET=""
PORT="49910"
REGISTRY=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --port)      PORT="$2";     shift 2 ;;
    --registry)  REGISTRY="$2"; shift 2 ;;
    *)           TARGET="$1";   shift ;;
  esac
done

if [[ -z "$TARGET" ]]; then
  echo "Usage: $0 <host> [--port PORT] [--registry URL]"
  exit 1
fi

echo "[install-worker] deploying to $TARGET:$PORT"

# Copy worker-agent.py to target
scp -q "$SCRIPT_DIR/worker-agent.py" "$TARGET:/tmp/worker-agent.py"

# Build startup env vars
EXTRA_ENV=""
[[ -n "$REGISTRY" ]] && EXTRA_ENV="export WORKER_REGISTRY='$REGISTRY'; "

# Detect OS and install as a persistent service
ssh "$TARGET" bash <<REMOTE
set -euo pipefail

INSTALL_DIR="\$HOME/.local/bin"
mkdir -p "\$INSTALL_DIR"
cp /tmp/worker-agent.py "\$INSTALL_DIR/worker-agent.py"
chmod +x "\$INSTALL_DIR/worker-agent.py"

# Use venv Python if available (picks up ML packages installed there)
VENV_PYTHON="\$HOME/site2rag-venv/bin/python"
if [[ -x "\$VENV_PYTHON" ]]; then
  PYTHON="\$VENV_PYTHON"
elif command -v python3 &>/dev/null; then
  PYTHON="\$(command -v python3)"
else
  PYTHON="python3"
fi
echo "[install-worker] using Python: \$PYTHON"

# Install tesseract language packs — all workers must have the same set
# so routing never fails because a worker is missing a language model.
REQUIRED_TESS_LANGS="ara fas urd chi_sim hin jpn kor deu fra spa"
echo "[install-worker] checking tesseract language packs..."
INSTALLED_LANGS=\$(tesseract --list-langs 2>/dev/null | tail -n +2 | tr '\n' ' ')
MISSING=""
for lang in \$REQUIRED_TESS_LANGS; do
  echo "\$INSTALLED_LANGS" | grep -qw "\$lang" || MISSING="\$MISSING \$lang"
done

if [[ -n "\$MISSING" ]]; then
  echo "[install-worker] installing missing langs:\$MISSING"
  if [[ "\$OS" == "Darwin" ]]; then
    TESSDATA_DIR="\$(brew --prefix 2>/dev/null)/share/tessdata"
    [[ -z "\$TESSDATA_DIR" || ! -d "\$TESSDATA_DIR" ]] && TESSDATA_DIR="/usr/local/share/tessdata"
    mkdir -p "\$TESSDATA_DIR"
    for lang in \$MISSING; do
      echo "  downloading \$lang.traineddata..."
      curl -sfL "https://github.com/tesseract-ocr/tessdata/raw/main/\${lang}.traineddata" \
        -o "\$TESSDATA_DIR/\${lang}.traineddata" || echo "  warn: failed to download \$lang"
    done
  elif [[ "\$OS" == "Linux" ]]; then
    PKG_LIST=\$(echo \$MISSING | tr ' ' '\n' | sed 's/^/tesseract-ocr-/' | tr '\n' ' ')
    sudo apt-get install -y \$PKG_LIST 2>/dev/null \
      || echo "[install-worker] warn: apt install failed for some langs — try manually: sudo apt-get install \$PKG_LIST"
  fi
else
  echo "[install-worker] all required language packs present"
fi

# Kill any existing worker on this port
pkill -f "worker-agent.py" 2>/dev/null || true
sleep 1

OS=\$(uname -s)
if [[ "\$OS" == "Darwin" ]]; then
  # macOS: install as a LaunchAgent
  PLIST_DIR="\$HOME/Library/LaunchAgents"
  mkdir -p "\$PLIST_DIR"
  PLIST="\$PLIST_DIR/com.site2rag.worker-agent.plist"

  cat > "\$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.site2rag.worker-agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>\$PYTHON</string>
    <string>\$INSTALL_DIR/worker-agent.py</string>
    <string>--port</string><string>$PORT</string>
    $([ -n "$REGISTRY" ] && echo "<string>--registry</string><string>$REGISTRY</string>")
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>WORKER_PORT</key><string>$PORT</string>
    $([ -n "$REGISTRY" ] && echo "<key>WORKER_REGISTRY</key><string>$REGISTRY</string>")
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>\$HOME/.local/log/worker-agent.log</string>
  <key>StandardErrorPath</key><string>\$HOME/.local/log/worker-agent.err</string>
</dict>
</plist>
PLIST

  mkdir -p "\$HOME/.local/log"
  launchctl unload "\$PLIST" 2>/dev/null || true
  launchctl load "\$PLIST"
  echo "[install-worker] macOS LaunchAgent installed and started"

elif [[ "\$OS" == "Linux" ]]; then
  # Linux: install as a systemd user service (or start directly if no systemd)
  if command -v systemctl &>/dev/null; then
    SVCDIR="\$HOME/.config/systemd/user"
    mkdir -p "\$SVCDIR"
    cat > "\$SVCDIR/worker-agent.service" <<SVC
[Unit]
Description=site2rag worker agent
After=network.target

[Service]
ExecStart=\$PYTHON \$INSTALL_DIR/worker-agent.py --port $PORT $([ -n "$REGISTRY" ] && echo "--registry $REGISTRY")
Environment=WORKER_PORT=$PORT
$([ -n "$REGISTRY" ] && echo "Environment=WORKER_REGISTRY=$REGISTRY")
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
SVC
    systemctl --user daemon-reload
    systemctl --user enable --now worker-agent.service
    echo "[install-worker] systemd user service installed and started"
  else
    # Fallback: start in background directly
    nohup "\$PYTHON" "\$INSTALL_DIR/worker-agent.py" --port $PORT $([ -n "$REGISTRY" ] && echo "--registry $REGISTRY") \
      > "\$HOME/.local/log/worker-agent.log" 2>&1 &
    echo "[install-worker] started in background (no systemd)"
  fi
fi

# Quick health check
sleep 2
curl -sf "http://localhost:$PORT/health" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'[install-worker] health: {d[\"status\"]} | {d[\"cpu_cores\"]} cores, {d[\"ram_gb\"]}GB RAM')" \
  || echo "[install-worker] health check failed — check logs"
REMOTE

echo "[install-worker] done. Worker running at http://$TARGET:$PORT"
