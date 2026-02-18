from __future__ import annotations

from pathlib import Path
from typing import Dict, List, Tuple

import cv2
import numpy as np
import pytesseract

BBox = Tuple[int, int, int, int]


class VisionParser:
    """Parses screen regions into poker features (cards and numbers)."""

    def __init__(self, template_match_threshold: float = 0.78) -> None:
        self.template_match_threshold = template_match_threshold
        self.rank_templates: Dict[str, np.ndarray] = {}
        self.suit_templates: Dict[str, np.ndarray] = {}

    def load_card_templates(self, rank_dir: str | Path, suit_dir: str | Path) -> None:
        """Load rank and suit templates from disk.

        File naming convention:
          - rank template: A.png, K.png, Q.png, ... 2.png
          - suit template: h.png, d.png, c.png, s.png
        """
        rank_dir = Path(rank_dir)
        suit_dir = Path(suit_dir)
        self.rank_templates = self._load_template_dir(rank_dir)
        self.suit_templates = self._load_template_dir(suit_dir)

    @staticmethod
    def _load_template_dir(folder: Path) -> Dict[str, np.ndarray]:
        templates: Dict[str, np.ndarray] = {}
        for file in folder.glob("*.png"):
            img = cv2.imread(str(file), cv2.IMREAD_GRAYSCALE)
            if img is not None:
                templates[file.stem] = img
        return templates

    @staticmethod
    def split_card_slots(region_img: np.ndarray, card_count: int) -> List[np.ndarray]:
        h, w = region_img.shape[:2]
        slot_width = max(1, w // card_count)
        slots = []
        for idx in range(card_count):
            x0 = idx * slot_width
            x1 = w if idx == card_count - 1 else (idx + 1) * slot_width
            slots.append(region_img[:, x0:x1])
        return slots

    def parse_cards(self, region_img: np.ndarray, expected_cards: int) -> List[str]:
        cards: List[str] = []
        for slot in self.split_card_slots(region_img, expected_cards):
            card = self._parse_single_card(slot)
            if card:
                cards.append(card)
        return cards

    def _parse_single_card(self, card_img: np.ndarray) -> str | None:
        gray = cv2.cvtColor(card_img, cv2.COLOR_BGR2GRAY)
        rank_roi = gray[: max(1, int(gray.shape[0] * 0.40)), : max(1, int(gray.shape[1] * 0.55))]
        suit_roi = gray[max(1, int(gray.shape[0] * 0.30)) :, : max(1, int(gray.shape[1] * 0.55))]

        rank = self._best_template_match(rank_roi, self.rank_templates)
        suit = self._best_template_match(suit_roi, self.suit_templates)

        if rank and suit:
            return f"{rank}{suit}"
        return None

    def _best_template_match(self, roi: np.ndarray, templates: Dict[str, np.ndarray]) -> str | None:
        best_name = None
        best_score = -1.0

        for name, template in templates.items():
            if roi.shape[0] < template.shape[0] or roi.shape[1] < template.shape[1]:
                continue
            result = cv2.matchTemplate(roi, template, cv2.TM_CCOEFF_NORMED)
            score = float(np.max(result))
            if score > best_score:
                best_score = score
                best_name = name

        if best_name is None or best_score < self.template_match_threshold:
            return None
        return best_name

    @staticmethod
    def read_numeric_value(region_img: np.ndarray) -> float:
        gray = cv2.cvtColor(region_img, cv2.COLOR_BGR2GRAY)
        gray = cv2.GaussianBlur(gray, (3, 3), 0)
        _, thresh = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

        text = pytesseract.image_to_string(
            thresh,
            config="--oem 3 --psm 7 -c tessedit_char_whitelist=0123456789.$",
        )
        cleaned = "".join(ch for ch in text if ch.isdigit() or ch == ".")
        return float(cleaned) if cleaned else 0.0

    @staticmethod
    def detect_to_call(button_region: np.ndarray) -> float:
        """Estimate call amount from the call/check button area via OCR."""
        return VisionParser.read_numeric_value(button_region)

    @staticmethod
    def crop_by_bbox(full_img: np.ndarray, bbox: BBox) -> np.ndarray:
        x, y, w, h = bbox
        return full_img[y : y + h, x : x + w]
