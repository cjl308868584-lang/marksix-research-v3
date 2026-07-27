"""Offline, reproducible research jobs.

This module deliberately does not generate betting selections. It audits the
dataset, searches a bounded rule grammar, applies shrinkage/FDR, and reports
whether a challenger deserves a later walk-forward evaluation.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from hashlib import sha256
from math import erfc, sqrt
import json
from pathlib import Path
from typing import Any, Iterable, Sequence

ZODIACS = ("鼠", "牛", "虎", "兔", "龙", "蛇", "马", "羊", "猴", "鸡", "狗", "猪")
POSITIONS = ("main.1", "main.2", "main.3", "main.4", "main.5", "main.6", "special")
LUNAR_NEW_YEAR = {
    2020: "2020-01-25",
    2021: "2021-02-12",
    2022: "2022-02-01",
    2023: "2023-01-22",
    2024: "2024-02-10",
    2025: "2025-01-29",
    2026: "2026-02-17",
    2027: "2027-02-06",
    2028: "2028-01-26",
    2029: "2029-02-13",
    2030: "2030-02-03",
}


@dataclass(frozen=True)
class Draw:
    game: str
    issue: str
    draw_at: str
    numbers: tuple[int, ...]
    special: int
    verified: bool


def load_draws(path: str | Path, game: str) -> list[Draw]:
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    draws = []
    for item in payload.get(game, []):
        numbers = tuple(int(value) for value in item["numbers"])
        if len(numbers) != 6 or len(set((*numbers, int(item["special"])))) != 7:
            continue
        if not all(1 <= value <= 49 for value in (*numbers, int(item["special"]))):
            continue
        draws.append(
            Draw(
                game=game,
                issue=str(item["issue"]),
                draw_at=str(item["drawAt"]),
                numbers=numbers,
                special=int(item["special"]),
                verified=bool(item.get("verified", False)),
            )
        )
    return sorted(draws, key=lambda draw: (draw.draw_at, draw.issue))


def audit_dataset(draws: Sequence[Draw]) -> dict[str, Any]:
    issues = [draw.issue for draw in draws]
    duplicates = len(issues) - len(set(issues))
    numeric = sorted({int(issue) for issue in issues if issue.isdigit()})
    gaps = sum(max(0, right - left - 1) for left, right in zip(numeric, numeric[1:]))
    canonical = [
        [draw.issue, draw.draw_at, *draw.numbers, draw.special, draw.verified]
        for draw in draws
    ]
    return {
        "sampleSize": len(draws),
        "formalSampleSize": sum(draw.verified for draw in draws),
        "verifiedRatio": sum(draw.verified for draw in draws) / max(len(draws), 1),
        "duplicateIssueCount": duplicates,
        "numericGapCount": gaps,
        "oldestIssue": draws[0].issue if draws else None,
        "newestIssue": draws[-1].issue if draws else None,
        "datasetVersion": sha256(
            json.dumps(canonical, ensure_ascii=False, separators=(",", ":")).encode()
        ).hexdigest(),
    }


def zodiac(number: int, draw_at: str) -> str:
    date_key = draw_at[:10]
    year = int(date_key[:4])
    lunar_new_year = LUNAR_NEW_YEAR.get(year)
    if lunar_new_year and date_key < lunar_new_year:
        year -= 1
    year_animal = (year - 2020) % 12
    return ZODIACS[(year_animal - (number - 1) % 12) % 12]


def value_at(draw: Draw, field: str) -> int:
    if field == "special":
        return draw.special
    return draw.numbers[int(field.split(".")[1]) - 1]


def discover_zodiac_rules(
    draws: Sequence[Draw],
    min_support: int = 30,
) -> list[dict[str, Any]]:
    """Search position-transfer and one-condition rules without lookahead."""
    candidates: list[dict[str, Any]] = []
    for lag in range(1, 6):
        for source in POSITIONS:
            for target in POSITIONS:
                plain = _evaluate_rule(draws, lag, source, target, None)
                candidates.append(_record(lag, source, target, None, plain))
                for predicate_field in POSITIONS:
                    for predicate_value in ZODIACS:
                        condition = (predicate_field, predicate_value)
                        result = _evaluate_rule(draws, lag, source, target, condition)
                        candidates.append(_record(lag, source, target, condition, result))
    eligible = [
        item
        for item in candidates
        if item["support"] >= min_support
        and item["support"] * item["baselineRate"] >= 5
    ]
    _apply_bh_fdr(eligible)
    for item in eligible:
        if item["shrunkenRate"] > item["baselineRate"]:
            item["direction"] = "positive"
            item["resourceDecision"] = "full_backtest"
        elif item["hitRate"] < item["baselineRate"] and item["qValue"] <= 0.10:
            item["direction"] = "negative"
            item["resourceDecision"] = "negative_pool"
        else:
            item["direction"] = "neutral"
            item["resourceDecision"] = "not_above_baseline"
    eligible.sort(
        key=lambda item: (
            item["resourceDecision"] != "full_backtest",
            item["qValue"],
            -item["support"],
            item["ruleId"],
        )
    )
    return eligible


def run_shadow_research(path: str | Path, game: str) -> dict[str, Any]:
    draws = load_draws(path, game)
    audit = audit_dataset(draws)
    rules = discover_zodiac_rules(draws)
    full = [item for item in rules if item["resourceDecision"] == "full_backtest"]
    negative = [item for item in rules if item["resourceDecision"] == "negative_pool"]
    generated = 5 * 7 * 7 * (1 + 7 * 12)
    black_box = _black_box_status(draws)
    return {
        "schemaVersion": "python-shadow-v2",
        "generatedAt": datetime.utcnow().isoformat(timespec="seconds") + "Z",
        "game": game,
        "audit": audit,
        "resourceFunnel": {
            "generated": generated,
            "eligible": len(rules),
            "fullBacktest": len(full),
            "negativePool": len(negative),
            "reductionRate": 1 - len(full) / max(generated, 1),
        },
        "topPositiveRules": full[:50],
        "topNegativeRules": negative[:50],
        "blackBox": black_box,
        "formalDecision": (
            "baseline_only"
            if audit["formalSampleSize"] < 2000
            else "requires_independent_forward_validation"
        ),
    }


def _evaluate_rule(
    draws: Sequence[Draw],
    lag: int,
    source: str,
    target: str,
    condition: tuple[str, str] | None,
) -> tuple[int, int]:
    support = hits = 0
    for index in range(lag, len(draws)):
        previous = draws[index - lag]
        current = draws[index]
        if condition and zodiac(value_at(previous, condition[0]), previous.draw_at) != condition[1]:
            continue
        predicted = zodiac(value_at(previous, source), previous.draw_at)
        actual = zodiac(value_at(current, target), current.draw_at)
        support += 1
        hits += predicted == actual
    return support, hits


def _record(
    lag: int,
    source: str,
    target: str,
    condition: tuple[str, str] | None,
    result: tuple[int, int],
) -> dict[str, Any]:
    support, hits = result
    spec = {
        "family": "conditional_transfer" if condition else "position_transfer",
        "lag": lag,
        "source": source,
        "target": target,
        "condition": condition,
        "familyTarget": "zodiac",
    }
    baseline = 1 / 12
    hit_rate = hits / max(support, 1)
    prior_strength = 24
    shrunken = (hits + prior_strength * baseline) / max(support + prior_strength, 1)
    return {
        "ruleId": sha256(
            json.dumps(spec, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()[:24],
        "spec": spec,
        "description": _describe(spec),
        "support": support,
        "hits": hits,
        "hitRate": hit_rate,
        "baselineRate": baseline,
        "shrunkenRate": shrunken,
        "pValue": _normal_tail(hits, support, baseline),
        "qValue": 1.0,
    }


def _describe(spec: dict[str, Any]) -> str:
    condition = spec["condition"]
    prefix = f"若前期{condition[0]}生肖为{condition[1]}，" if condition else ""
    return f"{prefix}读取前{spec['lag']}期{spec['source']}生肖，预测下期{spec['target']}生肖"


def _normal_tail(hits: int, support: int, baseline: float) -> float:
    if support <= 0:
        return 1.0
    mean = support * baseline
    variance = support * baseline * (1 - baseline)
    if variance <= 0:
        return 1.0
    z_score = (hits - 0.5 - mean) / sqrt(variance)
    return min(1.0, max(0.0, 0.5 * erfc(z_score / sqrt(2))))


def _apply_bh_fdr(records: list[dict[str, Any]]) -> None:
    ordered = sorted(records, key=lambda item: (item["pValue"], item["ruleId"]))
    count = len(ordered)
    running = 1.0
    for rank in range(count, 0, -1):
        item = ordered[rank - 1]
        running = min(running, item["pValue"] * count / rank)
        item["qValue"] = running


def _black_box_status(draws: Sequence[Draw]) -> dict[str, Any]:
    if len(draws) < 2000:
        return {
            "status": "blocked_insufficient_data",
            "sampleSize": len(draws),
            "minimumSampleSize": 2000,
            "models": ["logistic_regression", "hist_gradient_boosting", "river_online"],
        }
    return {
        "status": "shadow_pending_forward_validation",
        "sampleSize": len(draws),
        "minimumSampleSize": 2000,
        "models": ["logistic_regression", "hist_gradient_boosting", "river_online"],
    }

