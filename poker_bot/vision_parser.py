from __future__ import annotations

from pathlib import Path
from typing import Dict, List, Tuple

import cv2
import numpy as np
import pytesseract
from pytesseract import Output

from .models import BBox, TableLayout


class VisionParser:
    """Parses screen regions into poker features (cards and numbers)."""

    def __init__(self, template_match_threshold: float = 0.78) -> None:
        self.template_match_threshold = template_match_threshold
        self.rank_templates: Dict[str, np.ndarray] = {}
        self.suit_templates: Dict[str, np.ndarray] = {}

    def load_card_templates(self, rank_dir: str | Path, suit_dir: str | Path) -> None:
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

    def detect_layout(self, full_img: np.ndarray, username: str = "pcooney") -> TableLayout:
        """Infer key table regions directly from the live screen.

        Strategy:
        1) OCR all visible words.
        2) Use Fold/Call/Raise labels to anchor action buttons if available.
        3) Use player username location ("pcooney") to anchor hero seat.
        4) Derive card/pot regions from anchor geometry with safe fallbacks.
        """
        words = self._ocr_word_boxes(full_img)
        height, width = full_img.shape[:2]

        fold_box = self._find_word(words, ["fold"])
        call_box = self._find_word(words, ["call", "check"])
        raise_box = self._find_word(words, ["raise", "bet"])
        user_box = self._find_word(words, [username])

        action_buttons = self._derive_action_buttons(width, height, fold_box, call_box, raise_box)
        table_bounds = self._derive_table_bounds(width, height, action_buttons, user_box)
        player_cards = self._derive_player_cards(table_bounds, user_box)
        community_cards = self._derive_community_cards(table_bounds)
        pot_size = self._derive_pot_region(table_bounds, community_cards)

        return TableLayout(
            player_cards=player_cards,
            community_cards=community_cards,
            pot_size=pot_size,
            action_buttons=action_buttons,
            table_bounds=table_bounds,
        )

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
        return VisionParser.read_numeric_value(button_region)

    @staticmethod
    def crop_by_bbox(full_img: np.ndarray, bbox: BBox) -> np.ndarray:
        x, y, w, h = bbox
        return full_img[y : y + h, x : x + w]

    @staticmethod
    def _ocr_word_boxes(full_img: np.ndarray) -> List[Dict[str, object]]:
        gray = cv2.cvtColor(full_img, cv2.COLOR_BGR2GRAY)
        data = pytesseract.image_to_data(gray, output_type=Output.DICT)

        words: List[Dict[str, object]] = []
        for i in range(len(data["text"])):
            text = (data["text"][i] or "").strip()
            if not text:
                continue
            conf = float(data["conf"][i]) if str(data["conf"][i]).strip() not in {"", "-1"} else -1.0
            if conf < 20:
                continue
            words.append(
                {
                    "text": text.lower(),
                    "bbox": (
                        int(data["left"][i]),
                        int(data["top"][i]),
                        int(data["width"][i]),
                        int(data["height"][i]),
                    ),
                    "conf": conf,
                }
            )
        return words

    @staticmethod
    def _find_word(words: List[Dict[str, object]], terms: List[str]) -> BBox | None:
        terms_norm = [t.lower() for t in terms]
        candidates: List[Tuple[float, BBox]] = []

        for w in words:
            text = str(w["text"])
            if any(term in text for term in terms_norm):
                candidates.append((float(w["conf"]), w["bbox"]))

        if not candidates:
            return None
        candidates.sort(key=lambda x: x[0], reverse=True)
        return candidates[0][1]

    @staticmethod
    def _inflate_box(box: BBox, dx: int, dy: int, max_w: int, max_h: int) -> BBox:
        x, y, w, h = box
        nx = max(0, x - dx)
        ny = max(0, y - dy)
        rx = min(max_w, x + w + dx)
        by = min(max_h, y + h + dy)
        return (nx, ny, max(1, rx - nx), max(1, by - ny))

    def _derive_action_buttons(
        self,
        width: int,
        height: int,
        fold_box: BBox | None,
        call_box: BBox | None,
        raise_box: BBox | None,
    ) -> Dict[str, BBox]:
        defaults = {
            "Fold": (int(width * 0.25), int(height * 0.82), int(width * 0.12), int(height * 0.10)),
            "Call": (int(width * 0.44), int(height * 0.82), int(width * 0.12), int(height * 0.10)),
            "Raise": (int(width * 0.63), int(height * 0.82), int(width * 0.12), int(height * 0.10)),
        }

        found = {"Fold": fold_box, "Call": call_box, "Raise": raise_box}
        out: Dict[str, BBox] = {}
        for action, box in found.items():
            if box is None:
                out[action] = defaults[action]
            else:
                out[action] = self._inflate_box(box, dx=30, dy=20, max_w=width, max_h=height)
        return out

    def _derive_table_bounds(
        self,
        width: int,
        height: int,
        action_buttons: Dict[str, BBox],
        user_box: BBox | None,
    ) -> BBox:
        left = int(width * 0.12)
        top = int(height * 0.12)
        right = int(width * 0.88)

        buttons_top = min(b[1] for b in action_buttons.values())
        bottom = int(buttons_top - height * 0.05)

        if user_box is not None:
            ux, uy, uw, uh = user_box
            bottom = min(bottom, int(uy - 0.02 * height)) if uy > top else bottom
            left = min(left, max(0, ux - int(0.35 * width)))
            right = max(right, min(width, ux + uw + int(0.35 * width)))

        bottom = max(top + 50, bottom)
        return (left, top, max(1, right - left), max(1, bottom - top))

    def _derive_player_cards(self, table_bounds: BBox, user_box: BBox | None) -> BBox:
        tx, ty, tw, th = table_bounds
        if user_box is not None:
            ux, uy, uw, uh = user_box
            center_x = ux + uw // 2
            card_w = int(tw * 0.20)
            card_h = int(th * 0.18)
            x = max(tx, center_x - card_w // 2)
            y = max(ty, uy - card_h - int(0.02 * th))
            return (x, y, card_w, card_h)

        return (
            int(tx + tw * 0.40),
            int(ty + th * 0.74),
            int(tw * 0.20),
            int(th * 0.18),
        )

    @staticmethod
    def _derive_community_cards(table_bounds: BBox) -> BBox:
        tx, ty, tw, th = table_bounds
        return (
            int(tx + tw * 0.28),
            int(ty + th * 0.40),
            int(tw * 0.44),
            int(th * 0.20),
        )

    @staticmethod
    def _derive_pot_region(table_bounds: BBox, community_cards: BBox) -> BBox:
        tx, ty, tw, _ = table_bounds
        cx, cy, cw, ch = community_cards
        return (
            int(tx + tw * 0.40),
            int(max(ty, cy - ch * 0.9)),
            int(cw * 0.45),
            int(ch * 0.55),
        )
