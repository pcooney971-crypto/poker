#!/usr/bin/env bash
set -euo pipefail

# Run this from the poker repo root:
#   bash make_mac_app.sh

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This installer is for macOS only."
  exit 1
fi

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCHER_PATH="$REPO_DIR/PokerBot.command"
DESKTOP_LAUNCHER="$HOME/Desktop/PokerBot.command"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1"
    return 1
  fi
}

if ! require_cmd python3; then
  echo "Install Python 3 first (for example: brew install python)."
  exit 1
fi

if ! command -v brew >/dev/null 2>&1; then
  cat <<'MSG'
Homebrew is not installed.
Install it from https://brew.sh and then rerun this script.
MSG
  exit 1
fi

if ! command -v tesseract >/dev/null 2>&1; then
  echo "Installing tesseract with Homebrew..."
  brew install tesseract
fi

echo "Creating virtual environment..."
python3 -m venv "$REPO_DIR/.venv"
"$REPO_DIR/.venv/bin/python" -m pip install --upgrade pip
"$REPO_DIR/.venv/bin/pip" install -r "$REPO_DIR/requirements.txt"

mkdir -p "$REPO_DIR/templates/ranks" "$REPO_DIR/templates/suits" "$REPO_DIR/config"

cat > "$LAUNCHER_PATH" <<'LAUNCHER'
#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_DIR"

if [[ ! -d .venv ]]; then
  osascript -e 'display dialog "Missing .venv. Run make_mac_app.sh once first." buttons {"OK"} default button "OK"'
  exit 1
fi

source .venv/bin/activate

if ! command -v tesseract >/dev/null 2>&1; then
  osascript -e 'display dialog "Tesseract is not installed. Run: brew install tesseract" buttons {"OK"} default button "OK"'
  exit 1
fi

echo "Launching Poker Vision Bot..."
echo "Tip: Grant Screen Recording permission to Terminal/iTerm if prompted."
python main.py

read -r -p "Press Enter to close this window..." _
LAUNCHER

chmod +x "$LAUNCHER_PATH"
cp "$LAUNCHER_PATH" "$DESKTOP_LAUNCHER"
chmod +x "$DESKTOP_LAUNCHER"

cat <<MSG
Done.

Double-click this file to run the app:
  $DESKTOP_LAUNCHER

First launch tips:
  1) macOS may ask for Screen Recording permission.
  2) Add card templates to:
     - $REPO_DIR/templates/ranks
     - $REPO_DIR/templates/suits
  3) Bot auto-detects table/buttons each run (no manual calibration).
MSG
