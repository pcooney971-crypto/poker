from __future__ import annotations

from typing import Dict, Tuple

import cv2
import mss
import numpy as np

BBox = Tuple[int, int, int, int]


class ScreenCapturer:
    """Fast screen capture service using mss."""

    def __init__(self, monitor_index: int = 1) -> None:
        self.monitor_index = monitor_index
        self.sct = mss.mss()

    def grab(self, bbox: BBox) -> np.ndarray:
        x, y, w, h = bbox
        monitor: Dict[str, int] = {
            "left": x,
            "top": y,
            "width": w,
            "height": h,
        }
        raw = np.array(self.sct.grab(monitor))
        return cv2.cvtColor(raw, cv2.COLOR_BGRA2BGR)

    def grab_full_screen(self) -> np.ndarray:
        monitor = self.sct.monitors[self.monitor_index]
        raw = np.array(self.sct.grab(monitor))
        return cv2.cvtColor(raw, cv2.COLOR_BGRA2BGR)

    @staticmethod
    def draw_text_overlay(
        frame: np.ndarray,
        text: str,
        position: Tuple[int, int] = (40, 40),
        color: Tuple[int, int, int] = (0, 255, 0),
    ) -> np.ndarray:
        out = frame.copy()
        cv2.putText(
            out,
            text,
            position,
            cv2.FONT_HERSHEY_SIMPLEX,
            1,
            color,
            2,
            cv2.LINE_AA,
        )
        return out
