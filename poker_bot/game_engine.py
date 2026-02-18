from __future__ import annotations

import itertools
import random
from typing import List

from .models import Advice, GameState


class GameEngine:
    """Calculates equity and returns action recommendation."""

    ranks = "23456789TJQKA"
    suits = "cdhs"

    def __init__(self, simulations: int = 3000) -> None:
        self.simulations = simulations
        self._treys = None
        self._try_load_treys()

    def _try_load_treys(self) -> None:
        try:
            from treys import Card, Evaluator  # type: ignore

            self._treys = {"Card": Card, "Evaluator": Evaluator()}
        except Exception:
            self._treys = None

    def advise(self, state: GameState) -> Advice:
        win_prob = self.estimate_win_probability(state.player_cards, state.community_cards)
        pot_odds = state.to_call / (state.pot_size + state.to_call) if (state.pot_size + state.to_call) > 0 else 0
        ev_call = (win_prob * state.pot_size) - ((1 - win_prob) * state.to_call)

        if win_prob < pot_odds or ev_call < 0:
            action = "Fold"
        elif win_prob > max(0.65, pot_odds + 0.2):
            action = "Raise"
        else:
            action = "Call"

        return Advice(
            action=action,
            win_probability=win_prob,
            pot_odds=pot_odds,
            expected_value=ev_call,
        )

    def estimate_win_probability(self, hero_cards: List[str], board_cards: List[str]) -> float:
        if len(hero_cards) != 2:
            return 0.0
        return self._estimate_with_treys(hero_cards, board_cards) if self._treys else self._estimate_basic(hero_cards, board_cards)

    def _estimate_with_treys(self, hero_cards: List[str], board_cards: List[str]) -> float:
        Card = self._treys["Card"]
        evaluator = self._treys["Evaluator"]

        used = set(hero_cards + board_cards)
        deck = [f"{r}{s}" for r, s in itertools.product(self.ranks, self.suits) if f"{r}{s}" not in used]

        wins = ties = 0
        trials = 0

        for _ in range(self.simulations):
            random.shuffle(deck)
            opp = deck[:2]
            missing = 5 - len(board_cards)
            board = board_cards + deck[2 : 2 + missing]

            hero_score = evaluator.evaluate([Card.new(c) for c in hero_cards], [Card.new(c) for c in board])
            opp_score = evaluator.evaluate([Card.new(c) for c in opp], [Card.new(c) for c in board])

            if hero_score < opp_score:
                wins += 1
            elif hero_score == opp_score:
                ties += 1
            trials += 1

        return (wins + 0.5 * ties) / max(trials, 1)

    def _estimate_basic(self, hero_cards: List[str], board_cards: List[str]) -> float:
        """Fallback when treys is unavailable: simple rank-based Monte Carlo proxy."""
        used = set(hero_cards + board_cards)
        deck = [f"{r}{s}" for r, s in itertools.product(self.ranks, self.suits) if f"{r}{s}" not in used]

        wins = ties = 0
        for _ in range(self.simulations):
            sample = random.sample(deck, k=2 + (5 - len(board_cards)))
            opp = sample[:2]
            board = board_cards + sample[2:]
            hero_strength = self._strength_proxy(hero_cards + board)
            opp_strength = self._strength_proxy(opp + board)
            if hero_strength > opp_strength:
                wins += 1
            elif hero_strength == opp_strength:
                ties += 1

        return (wins + 0.5 * ties) / self.simulations

    def _strength_proxy(self, cards: List[str]) -> int:
        rank_vals = sorted((self.ranks.index(c[0]) + 2) for c in cards)
        suit_vals = [c[1] for c in cards]

        rank_counts = {r: rank_vals.count(r) for r in set(rank_vals)}
        counts = sorted(rank_counts.values(), reverse=True)

        is_flush = max(suit_vals.count(s) for s in set(suit_vals)) >= 5
        is_straight = self._has_straight(rank_vals)

        if is_flush and is_straight:
            return 8000 + max(rank_vals)
        if counts[0] == 4:
            return 7000 + max(rank_counts, key=lambda k: (rank_counts[k], k))
        if counts[0] == 3 and len(counts) > 1 and counts[1] >= 2:
            return 6000 + max(rank_counts, key=lambda k: (rank_counts[k], k))
        if is_flush:
            return 5000 + sum(sorted(rank_vals, reverse=True)[:5])
        if is_straight:
            return 4000 + max(rank_vals)
        if counts[0] == 3:
            return 3000 + max(rank_counts, key=lambda k: (rank_counts[k], k))
        if counts[0] == 2 and len([c for c in counts if c == 2]) >= 2:
            return 2000 + sum(sorted((r for r, ct in rank_counts.items() if ct == 2), reverse=True)[:2])
        if counts[0] == 2:
            return 1000 + max(r for r, ct in rank_counts.items() if ct == 2)
        return sum(sorted(rank_vals, reverse=True)[:5])

    @staticmethod
    def _has_straight(ranks: List[int]) -> bool:
        unique = sorted(set(ranks))
        if 14 in unique:
            unique = [1] + unique
        streak = 1
        for i in range(1, len(unique)):
            if unique[i] == unique[i - 1] + 1:
                streak += 1
                if streak >= 5:
                    return True
            else:
                streak = 1
        return False
