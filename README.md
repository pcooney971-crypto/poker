# Poker Vision Bot (Calibration-First)

A Python poker assistant that:

1. Lets you calibrate unknown poker UI regions interactively.
2. Captures calibrated screen regions quickly using `mss`.
3. Parses cards with OpenCV template matching + OCR for numeric fields.
4. Estimates win probability with Monte Carlo simulation.
5. Recommends **Fold / Call / Raise** in console and overlay.

## Architecture

- `ScreenCapturer`: Screen grabbing and text overlay.
- `VisionParser`: Template matching + OCR parsing.
- `GameEngine`: Equity and action logic.
- `BotController`: Calibration and main loop orchestration.

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

## First Run (Calibration Mode)

```bash
python main.py
```

If `config/calibration.json` doesn't exist, calibration starts automatically.

You'll select these regions (drag ROI boxes):

- Player cards
- Community cards
- Pot size
- Fold button
- Call button
- Raise button

The calibration file is saved and reused.

## Notes

- Parsing quality depends on ROI quality and template quality.
- If template parsing misses cards, lower or tune `template_match_threshold` in `VisionParser`.
- `GameEngine` uses `treys` when available; otherwise a fallback hand-strength proxy is used.
