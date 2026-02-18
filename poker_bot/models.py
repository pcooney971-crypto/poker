from __future__ import annotations

from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any, Dict, List, Tuple
import json

BBox = Tuple[int, int, int, int]


@dataclass
class CalibrationConfig:
    """Stores all user-defined screen regions required by the bot."""

    player_cards: BBox
    community_cards: BBox
    pot_size: BBox
    action_buttons: Dict[str, BBox]

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "CalibrationConfig":
        return cls(
            player_cards=tuple(data["player_cards"]),
            community_cards=tuple(data["community_cards"]),
            pot_size=tuple(data["pot_size"]),
            action_buttons={k: tuple(v) for k, v in data["action_buttons"].items()},
        )

    def save(self, path: str | Path) -> None:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.to_dict(), indent=2), encoding="utf-8")

    @classmethod
    def load(cls, path: str | Path) -> "CalibrationConfig":
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        return cls.from_dict(data)


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
