# Poker Vision Bot (Auto-Detection)

A Python poker assistant that:

1. Automatically finds the poker table layout on-screen (no manual calibration).
2. Uses OCR to locate your username (`pcooney`) and action buttons (`Fold`, `Call/Check`, `Raise/Bet`).
3. Captures inferred regions with `mss`.
4. Parses cards via OpenCV template matching and reads pot/call amounts via OCR.
5. Estimates win probability with Monte Carlo simulation.
6. Recommends **Fold / Call / Raise** in console and overlay.

## Architecture

- `ScreenCapturer`: Screen grabbing and text overlay.
- `VisionParser`: OCR + template matching + automatic layout inference.
- `GameEngine`: Equity and action logic.
- `BotController`: Main loop orchestration.

## Install

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

> On Linux, install Tesseract binary as well (`sudo apt install tesseract-ocr`) for OCR.

## macOS Single-Command App Build (double-clickable .app)

Run this one command from the repo root:

```bash
bash make_mac_app_bundle.sh
```

It will:

- Create `.venv`
- Install Python dependencies
- Install `tesseract` via Homebrew if needed
- Create runtime launcher `run_pokerbot.sh`
- Build a macOS app bundle at `~/Desktop/PokerBot.app`

Then you launch by double-clicking **`~/Desktop/PokerBot.app`**.

## Template Setup

Create template folders:

- `templates/ranks` (e.g., `A.png`, `K.png`, ..., `2.png`)
- `templates/suits` (e.g., `h.png`, `d.png`, `c.png`, `s.png`)

Crop these from your poker client for best match quality.

## Run

```bash
python main.py
```

No calibration step is required. The bot continuously auto-detects the table each loop using OCR anchors.

## Notes

- Auto-detection is heuristic; it works best when button labels are visible and your username is displayed as `pcooney`.
- OCR quality depends on text size/contrast; macOS Screen Recording permission is required.
- If card parsing misses cards, tune `template_match_threshold` in `VisionParser`.
- `GameEngine` uses `treys` when available; otherwise a fallback hand-strength proxy is used.
