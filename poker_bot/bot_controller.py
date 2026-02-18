from __future__ import annotations

import time
from pathlib import Path

import cv2

from .game_engine import GameEngine
from .models import GameState, TableLayout
from .screen_capturer import ScreenCapturer
from .vision_parser import VisionParser


class BotController:
    """Main orchestration layer with automatic table/button detection (no calibration)."""

    def __init__(
        self,
        rank_templates: str | Path = "templates/ranks",
        suit_templates: str | Path = "templates/suits",
        username: str = "pcooney",
    ) -> None:
        self.rank_templates = Path(rank_templates)
        self.suit_templates = Path(suit_templates)
        self.username = username

        self.screen = ScreenCapturer()
        self.vision = VisionParser()
        self.engine = GameEngine()

        if self.rank_templates.exists() and self.suit_templates.exists():
            self.vision.load_card_templates(self.rank_templates, self.suit_templates)

    def run(self, use_overlay: bool = True, interval_s: float = 0.5) -> None:
        print(f"Bot started for user '{self.username}'. Auto-detecting table layout. Press 'q' to quit.")

        while True:
            full_screen = self.screen.grab_full_screen()
            layout = self.vision.detect_layout(full_screen, username=self.username)

            state = self._read_state(full_screen, layout)
            advice = self.engine.advise(state)

            message = (
                f"{advice.action} | Win%={advice.win_probability:.2%} "
                f"| PotOdds={advice.pot_odds:.2%} | EV={advice.expected_value:.2f}"
            )
            print(message)

            if use_overlay:
                focus = self.vision.crop_by_bbox(full_screen, layout.table_bounds)
                overlay = self.screen.draw_text_overlay(focus, message, (10, 30))
                cv2.imshow("Poker Bot Advice", overlay)
                if cv2.waitKey(1) & 0xFF == ord("q"):
                    break

            time.sleep(interval_s)

        cv2.destroyAllWindows()

    def _read_state(self, full_screen, layout: TableLayout) -> GameState:
        player_region = self.vision.crop_by_bbox(full_screen, layout.player_cards)
        board_region = self.vision.crop_by_bbox(full_screen, layout.community_cards)
        pot_region = self.vision.crop_by_bbox(full_screen, layout.pot_size)

        call_region_bbox = layout.action_buttons.get("Call") or next(iter(layout.action_buttons.values()))
        call_region = self.vision.crop_by_bbox(full_screen, call_region_bbox)

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
