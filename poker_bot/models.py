from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Tuple

BBox = Tuple[int, int, int, int]


@dataclass
class TableLayout:
    """Auto-detected screen regions required by the bot."""

    player_cards: BBox
    community_cards: BBox
    pot_size: BBox
    action_buttons: Dict[str, BBox]
    table_bounds: BBox


@dataclass
class GameState:
    player_cards: List[str]
    community_cards: List[str]
    pot_size: float
    to_call: float


@dataclass
class Advice:
    action: str
    win_probability: float
    pot_odds: float
    expected_value: float
