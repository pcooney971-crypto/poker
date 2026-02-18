#!/usr/bin/env bash
set -euo pipefail

# One-command macOS setup + app creation.
# Usage:
#   bash make_mac_app_bundle.sh

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script is for macOS only."
  exit 1
fi

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_LAUNCHER="$REPO_DIR/run_pokerbot.sh"
APP_PATH="$HOME/Desktop/PokerBot.app"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1"
    return 1
  fi
}

if ! require_cmd python3; then
  echo "Install Python 3 first (example: brew install python)."
  exit 1
fi

if ! require_cmd osacompile; then
  echo "Missing osacompile (part of macOS)."
  exit 1
fi

if ! command -v brew >/dev/null 2>&1; then
  cat <<'MSG'
Homebrew is not installed.
Install it from https://brew.sh and rerun this script.
MSG
  exit 1
fi

if ! command -v tesseract >/dev/null 2>&1; then
  echo "Installing tesseract via Homebrew..."
  brew install tesseract
fi

echo "Setting up virtual environment..."
python3 -m venv "$REPO_DIR/.venv"
"$REPO_DIR/.venv/bin/python" -m pip install --upgrade pip
"$REPO_DIR/.venv/bin/pip" install -r "$REPO_DIR/requirements.txt"

mkdir -p "$REPO_DIR/templates/ranks" "$REPO_DIR/templates/suits" "$REPO_DIR/config"

cat > "$RUNTIME_LAUNCHER" <<'LAUNCH'
#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_DIR"

if [[ ! -d .venv ]]; then
  osascript -e 'display dialog "Missing .venv. Run make_mac_app_bundle.sh first." buttons {"OK"} default button "OK"'
  exit 1
fi

source .venv/bin/activate

if ! command -v tesseract >/dev/null 2>&1; then
  osascript -e 'display dialog "Tesseract is not installed. Run: brew install tesseract" buttons {"OK"} default button "OK"'
  exit 1
fi

echo "Launching Poker Vision Bot..."
echo "If prompted, grant Screen Recording permission to Terminal."
python main.py

echo
echo "Program exited."
read -r -p "Press Enter to close this window..." _
LAUNCH

chmod +x "$RUNTIME_LAUNCHER"

APPLESCRIPT_FILE="$(mktemp)"
cat > "$APPLESCRIPT_FILE" <<APPLESCRIPT
on run
  set repoPath to "$REPO_DIR"
  tell application "Terminal"
    activate
    do script "cd " & quoted form of repoPath & " && bash run_pokerbot.sh"
  end tell
end run
APPLESCRIPT

rm -rf "$APP_PATH"
osacompile -o "$APP_PATH" "$APPLESCRIPT_FILE"
rm -f "$APPLESCRIPT_FILE"

cat <<MSG
Done. Your app is ready:
  $APP_PATH

Double-click PokerBot.app to launch.

Before first successful hand parsing, add templates to:
  $REPO_DIR/templates/ranks
  $REPO_DIR/templates/suits
MSG
