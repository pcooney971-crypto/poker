from __future__ import annotations

import time
from pathlib import Path
from typing import Dict, Tuple

import cv2
import mss
import numpy as np

from .game_engine import GameEngine
from .models import CalibrationConfig, GameState
from .screen_capturer import ScreenCapturer
from .vision_parser import VisionParser

BBox = Tuple[int, int, int, int]


class BotController:
    """Main orchestration layer for calibration, parsing, and game advice."""

    def __init__(
        self,
        config_path: str | Path = "config/calibration.json",
        rank_templates: str | Path = "templates/ranks",
        suit_templates: str | Path = "templates/suits",
    ) -> None:
        self.config_path = Path(config_path)
        self.rank_templates = Path(rank_templates)
        self.suit_templates = Path(suit_templates)

        self.screen = ScreenCapturer()
        self.vision = VisionParser()
        self.engine = GameEngine()

        if self.rank_templates.exists() and self.suit_templates.exists():
            self.vision.load_card_templates(self.rank_templates, self.suit_templates)

    def run(self, use_overlay: bool = True, interval_s: float = 0.5) -> None:
        config = self._ensure_calibration()
        print("Bot started. Press 'q' in overlay window to quit.")

        while True:
            state = self._read_state(config)
            advice = self.engine.advise(state)

            message = (
                f"{advice.action} | Win%={advice.win_probability:.2%} "
                f"| PotOdds={advice.pot_odds:.2%} | EV={advice.expected_value:.2f}"
            )
            print(message)

            if use_overlay:
                player_img = self.screen.grab(config.player_cards)
                overlay = self.screen.draw_text_overlay(player_img, message, (10, 30))
                cv2.imshow("Poker Bot Advice", overlay)
                if cv2.waitKey(1) & 0xFF == ord("q"):
                    break

            time.sleep(interval_s)

        cv2.destroyAllWindows()

    def _read_state(self, config: CalibrationConfig) -> GameState:
        player_region = self.screen.grab(config.player_cards)
        board_region = self.screen.grab(config.community_cards)
        pot_region = self.screen.grab(config.pot_size)

        call_region_bbox = config.action_buttons.get("Call") or next(iter(config.action_buttons.values()))
        call_region = self.screen.grab(call_region_bbox)

        player_cards = self.vision.parse_cards(player_region, expected_cards=2)
        board_cards = self.vision.parse_cards(board_region, expected_cards=5)
        pot_size = self.vision.read_numeric_value(pot_region)
        to_call = self.vision.detect_to_call(call_region)

        return GameState(
            player_cards=player_cards,
            community_cards=board_cards,
            pot_size=pot_size,
            to_call=to_call,
        )

    def _ensure_calibration(self) -> CalibrationConfig:
        if self.config_path.exists():
            return CalibrationConfig.load(self.config_path)
        config = self.calibrate()
        config.save(self.config_path)
        return config

    def calibrate(self) -> CalibrationConfig:
        print("Entering calibration mode...")
        screenshot = self._grab_full_screen()
        action_buttons: Dict[str, BBox] = {}

        player_cards = self._select_roi(screenshot, "Select PLAYER CARDS region")
        community_cards = self._select_roi(screenshot, "Select COMMUNITY CARDS region")
        pot_size = self._select_roi(screenshot, "Select POT SIZE region")

        for action in ["Fold", "Call", "Raise"]:
            action_buttons[action] = self._select_roi(screenshot, f"Select {action.upper()} button region")

        cv2.destroyAllWindows()
        return CalibrationConfig(
            player_cards=player_cards,
            community_cards=community_cards,
            pot_size=pot_size,
            action_buttons=action_buttons,
        )

    @staticmethod
    def _grab_full_screen() -> np.ndarray:
        with mss.mss() as sct:
            monitor = sct.monitors[1]
            raw = np.array(sct.grab(monitor))
            return cv2.cvtColor(raw, cv2.COLOR_BGRA2BGR)

    @staticmethod
    def _select_roi(screenshot: np.ndarray, title: str) -> BBox:
        print(title)
        x, y, w, h = cv2.selectROI(title, screenshot, fromCenter=False, showCrosshair=True)
        if w == 0 or h == 0:
            raise ValueError(f"ROI not selected for: {title}")
        cv2.destroyWindow(title)
        return int(x), int(y), int(w), int(h)
