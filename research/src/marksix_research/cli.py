from __future__ import annotations

import argparse
import hashlib
import hmac
from io import BytesIO
import json
from pathlib import Path
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .pipeline import run_shadow_research

HTTP_HEADERS = {
    "accept": "application/json",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.7",
    "user-agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 "
        "MarksixResearch/3.0"
    ),
}

FORWARD_LEARNING_SLOTS = {
    "coverage_zodiac",
    "coverage_tail",
    "coverage_zodiac_pair",
    "coverage_zodiac_triple",
    "special_number",
}

RECOMMENDATION_FIELDS = (
    "kind",
    "resultKey",
    "values",
    "sourceRunId",
    "dataVersion",
    "revision",
    "p30",
    "legacySeedProbability",
    "learnedProbability",
    "netOdds",
    "breakEvenProbability",
    "expectedValue",
    "learningSettledCount",
    "learningHitCount",
)
UNIFIED_SELECTION_POLICY = "rolling-product-ev-v2"
PATTERN_REVISION_REPAIR_ERROR = "权威五项与冻结规律运行不一致。"


def main() -> None:
    parser = argparse.ArgumentParser(prog="marksix-research")
    subparsers = parser.add_subparsers(dest="command", required=True)

    run = subparsers.add_parser("run", help="run the offline shadow audit")
    run.add_argument("--history", required=True)
    run.add_argument("--game", choices=("hk", "new_macau"), required=True)
    run.add_argument("--output", required=True)

    sync = subparsers.add_parser(
        "sync-history",
        help="download the latest server-owned history for both games",
    )
    sync.add_argument("--site-url", required=True)
    sync.add_argument("--output", required=True)

    publish = subparsers.add_parser(
        "capture",
        help="settle the previous v3 forecast, learn, and freeze the next snapshot",
    )
    publish.add_argument("--site-url", required=True)
    publish.add_argument("--secret", required=True)
    publish.add_argument("--game", choices=("hk", "new_macau"), required=True)
    publish.add_argument("--artifact", required=True)
    publish.add_argument("--max-wait-seconds", type=int, default=0)

    cycle = subparsers.add_parser(
        "cycle",
        help="sync one game, rebuild its artifact, and capture once",
    )
    cycle.add_argument("--site-url", required=True)
    cycle.add_argument("--secret", required=True)
    cycle.add_argument("--game", choices=("hk", "new_macau"), required=True)
    cycle.add_argument("--output-dir", required=True)

    health = subparsers.add_parser(
        "health-check",
        help="verify that a verified draw was reviewed and the next issue frozen",
    )
    health.add_argument("--site-url", required=True)
    health.add_argument("--game", choices=("hk", "new_macau"), required=True)

    update_check = subparsers.add_parser(
        "check-update",
        help="check whether a verified result has reached the frozen target",
    )
    update_check.add_argument("--site-url", required=True)
    update_check.add_argument("--game", choices=("hk", "new_macau"), required=True)

    args = parser.parse_args()
    if args.command == "sync-history":
        sync_history(args.site_url, args.output)
        return
    if args.command == "run":
        result = run_shadow_research(args.history, args.game)
        destination = Path(args.output)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(
            json.dumps(result, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        print(json.dumps(result["resourceFunnel"], ensure_ascii=False))
        return
    if args.command == "check-update":
        result = check_update_required(args.site_url, args.game)
    elif args.command == "health-check":
        result = verify_production_health(args.site_url, args.game)
    elif args.command == "cycle":
        result = run_cycle(
            args.site_url,
            args.secret,
            args.game,
            args.output_dir,
        )
    else:
        result = capture(
            args.site_url,
            args.secret,
            args.game,
            args.artifact,
            args.max_wait_seconds,
        )
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))


def sync_history(site_url: str, output_path: str) -> None:
    base = site_url.rstrip("/")
    payload: dict[str, list[dict[str, object]]] = {}
    for game in ("hk", "new_macau"):
        payload[game] = sync_game_history(site_url, game)
    destination = Path(output_path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def sync_game_history(site_url: str, game: str) -> list[dict[str, object]]:
    if game not in ("hk", "new_macau"):
        raise ValueError(f"unsupported game: {game}")
    base = site_url.rstrip("/")
    request = Request(
        f"{base}/api/lottery?game={game}&limit=500",
        headers={**HTTP_HEADERS, "referer": f"{base}/"},
    )
    with urlopen(request, timeout=90) as response:
        body = json.loads(response.read().decode("utf-8"))
    draws = body.get("draws")
    if not isinstance(draws, list) or not draws:
        raise ValueError(f"server history unavailable for {game}")
    return draws


def fetch_json(url: str, referer: str) -> dict[str, object]:
    request = Request(
        url,
        headers={**HTTP_HEADERS, "referer": referer},
    )
    with urlopen(request, timeout=90) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"invalid JSON response from {url}")
    return payload


def fetch_optional_json(url: str, referer: str) -> dict[str, object] | None:
    try:
        return fetch_json(url, referer)
    except HTTPError as error:
        if error.code == 404:
            return None
        raise


def fetch_update_patterns(
    url: str,
    referer: str,
) -> tuple[dict[str, object] | None, bool]:
    try:
        return fetch_optional_json(url, referer), False
    except HTTPError as error:
        if error.code != 503:
            raise
        try:
            body = error.read()
        except AttributeError:
            raise
        error.fp = error.file = BytesIO(body)
        error.read = error.file.read
        try:
            payload = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise
        if (
            isinstance(payload, dict)
            and payload.get("error") == PATTERN_REVISION_REPAIR_ERROR
        ):
            return None, True
        raise


def is_complete_forward_learning_freeze(
    payload: dict[str, object] | None,
    game: str,
    target_issue: str,
) -> bool:
    return _resolved_forward_learning_revision(payload, game, target_issue) is not None


def is_complete_forward_learning_review(
    payload: dict[str, object] | None,
    settled_issue: str,
    revision: int,
) -> bool:
    if not isinstance(payload, dict):
        return False
    reviews = payload.get("reviews")
    if not isinstance(reviews, list):
        return False
    for review in reviews:
        if not isinstance(review, dict):
            continue
        run = review.get("run")
        if (
            not isinstance(run, dict)
            or str(run.get("settledIssue") or "") != settled_issue
            or run.get("status") != "completed"
            or run.get("revisionSource") != "resolved-v2"
            or run.get("revision") != revision
        ):
            continue
        scores = review.get("scores")
        score_slots = {
            score.get("slot") for score in scores
            if isinstance(scores, list)
            and isinstance(score, dict)
            and score.get("official") is True
            and score.get("revision") == revision
            and str(score.get("targetIssue") or "") == settled_issue
        } if isinstance(scores, list) else set()
        if (
            isinstance(scores, list)
            and len(scores) == len(FORWARD_LEARNING_SLOTS)
            and score_slots == FORWARD_LEARNING_SLOTS
        ):
            return True
    return False


def _resolved_forward_learning_revision(
    payload: dict[str, object] | None,
    game: str,
    target_issue: str,
    *,
    require_policy: bool = False,
) -> int | None:
    if not isinstance(payload, dict) or payload.get("game") != game:
        return None
    forecasts = payload.get("forecasts")
    if not isinstance(forecasts, list) or len(forecasts) != len(FORWARD_LEARNING_SLOTS):
        return None
    if not all(isinstance(forecast, dict) for forecast in forecasts):
        return None
    typed_forecasts = [forecast for forecast in forecasts if isinstance(forecast, dict)]
    slots = {forecast.get("slot") for forecast in typed_forecasts}
    revisions = {forecast.get("revision") for forecast in typed_forecasts}
    if (
        slots != FORWARD_LEARNING_SLOTS
        or len(revisions) != 1
        or any(
            forecast.get("official") is not True
            or str(forecast.get("targetIssue") or "") != target_issue
            or (
                require_policy
                and forecast.get("selectionPolicy") != UNIFIED_SELECTION_POLICY
            )
            or forecast.get("kind") != forecast.get("slot")
            or any(field not in forecast for field in RECOMMENDATION_FIELDS)
            for forecast in typed_forecasts
        )
    ):
        return None
    revision = next(iter(revisions))
    if not isinstance(revision, int) or isinstance(revision, bool) or revision < 1:
        return None
    return revision


def _pattern_recommendations(
    payload: dict[str, object] | None,
    game: str,
    target_issue: str,
) -> tuple[int, dict[str, dict[str, object]]] | None:
    if not isinstance(payload, dict) or payload.get("game") != game:
        return None
    run = payload.get("run")
    if (
        not isinstance(run, dict)
        or str(run.get("targetIssue") or "") != target_issue
        or not str(run.get("runId") or "")
    ):
        return None
    run_id = str(run["runId"])
    recommendations = payload.get("recommendations")
    if (
        not isinstance(recommendations, list)
        or len(recommendations) != len(FORWARD_LEARNING_SLOTS)
        or not all(isinstance(item, dict) for item in recommendations)
    ):
        return None
    typed = [item for item in recommendations if isinstance(item, dict)]
    slots = {item.get("kind") for item in typed}
    revisions = {item.get("revision") for item in typed}
    if slots != FORWARD_LEARNING_SLOTS or len(revisions) != 1:
        return None
    revision = next(iter(revisions))
    if not isinstance(revision, int) or isinstance(revision, bool) or revision < 1:
        return None
    for recommendation in typed:
        product = recommendation.get("product")
        if (
            not isinstance(product, dict)
            or str(product.get("targetIssue") or "") != target_issue
            or recommendation.get("sourceRunId") != run_id
            or any(field not in recommendation for field in RECOMMENDATION_FIELDS)
        ):
            return None
    return revision, {
        str(recommendation["kind"]): recommendation
        for recommendation in typed
    }


def _validate_recommendation_alignment(
    patterns: dict[str, object] | None,
    learning: dict[str, object] | None,
    game: str,
    target_issue: str,
) -> int:
    learning_revision = _resolved_forward_learning_revision(
        learning,
        game,
        target_issue,
    )
    resolved_patterns = _pattern_recommendations(patterns, game, target_issue)
    forecasts = learning.get("forecasts") if isinstance(learning, dict) else None
    if learning_revision is None or resolved_patterns is None:
        raise RuntimeError(
            f"{game} target {target_issue} has an invalid resolved-v2 five-slot revision"
        )
    pattern_revision, by_kind = resolved_patterns
    if pattern_revision != learning_revision:
        raise RuntimeError(
            f"{game} target {target_issue} recommendation mismatch: revision"
        )
    assert isinstance(forecasts, list)
    for forecast in forecasts:
        assert isinstance(forecast, dict)
        recommendation = by_kind.get(str(forecast.get("slot") or ""))
        if recommendation is None or any(
            recommendation.get(field) != forecast.get(field)
            for field in RECOMMENDATION_FIELDS
        ):
            raise RuntimeError(
                f"{game} target {target_issue} recommendation mismatch"
            )
    return learning_revision


def verify_production_health(
    site_url: str,
    game: str,
) -> dict[str, object]:
    if game not in ("hk", "new_macau"):
        raise ValueError(f"unsupported game: {game}")
    base = site_url.rstrip("/")
    lottery = fetch_json(
        f"{base}/api/lottery?game={game}&limit=120",
        f"{base}/",
    )
    draws = lottery.get("draws")
    if not isinstance(draws, list) or not draws or not isinstance(draws[0], dict):
        raise RuntimeError(f"{game} latest draw unavailable")
    latest = draws[0]
    verified_count = sum(
        1 for draw in draws
        if isinstance(draw, dict) and draw.get("verified") is True
    )
    latest_issue = str(latest.get("issue") or "")
    if not latest_issue:
        raise RuntimeError(f"{game} latest draw issue unavailable")
    if latest.get("verified") is not True:
        return {
            "status": "awaiting_verification",
            "game": game,
            "latestIssue": latest_issue,
        }

    forecast = fetch_json(
        f"{base}/api/research/forecast?game={game}",
        f"{base}/research",
    )
    target_issue = str(forecast.get("targetIssue") or "")
    if not target_issue or _issue_number(target_issue) <= _issue_number(latest_issue):
        raise RuntimeError(
            f"{game} verified issue {latest_issue} did not advance forecast "
            f"target {target_issue or 'missing'}"
        )
    events = forecast.get("events")
    expected_slots = {
        "zodiac_6_plus_1",
        "tail_6_plus_1",
        "position_parity",
        "position_size",
    }
    if not isinstance(events, list) or {
        event.get("slot") for event in events if isinstance(event, dict)
    } != expected_slots:
        raise RuntimeError(f"{game} target {target_issue} has invalid event slots")
    if any(
        isinstance(event, dict) and event.get("family") == "number"
        for event in events
    ):
        raise RuntimeError(f"{game} target {target_issue} leaked a number forecast")

    review_payload = fetch_json(
        f"{base}/api/research/reviews?game={game}&limit=5",
        f"{base}/research/review",
    )
    reviews = review_payload.get("reviews")
    has_review = isinstance(reviews, list) and any(
        isinstance(review, dict) and str(review.get("targetIssue")) == latest_issue
        for review in reviews
    )

    learning_payload = fetch_json(
        f"{base}/api/research/learning-runs?game={game}&limit=5",
        f"{base}/research/review",
    )
    learning_runs = learning_payload.get("learningRuns")
    has_learning_run = isinstance(learning_runs, list) and any(
        isinstance(run, dict)
        and str(run.get("settledIssue")) == latest_issue
        and run.get("status") == "completed"
        for run in learning_runs
    )
    primary_bootstrap = False
    if has_review != has_learning_run:
        if not has_review:
            raise RuntimeError(f"{game} review missing for verified issue {latest_issue}")
        raise RuntimeError(
            f"{game} completed learning run missing for verified issue {latest_issue}"
        )
    if not has_review:
        previous_primary = fetch_optional_json(
            f"{base}/api/research/forecast?game={game}&issue={latest_issue}",
            f"{base}/research",
        )
        if previous_primary is not None:
            raise RuntimeError(f"{game} review missing for verified issue {latest_issue}")
        primary_bootstrap = True

    forward = fetch_optional_json(
        f"{base}/api/learning/forecast?game={game}",
        f"{base}/learning",
    )
    if forward is None:
        patterns = fetch_optional_json(
            f"{base}/api/research/patterns?game={game}",
            f"{base}/patterns",
        )
        if patterns is None and verified_count < 30:
            return {
                "status": "degraded",
                "reason": "forward_learning_pattern_window_unavailable",
                "game": game,
                "settledIssue": None if primary_bootstrap else latest_issue,
                "targetIssue": target_issue,
                "forwardLearningForecastCount": 0,
            }
        raise RuntimeError(
            f"{game} target {target_issue} is missing the five-slot forward freeze"
        )
    patterns = fetch_optional_json(
        f"{base}/api/research/patterns?game={game}",
        f"{base}/patterns",
    )
    revision = _validate_recommendation_alignment(
        patterns,
        forward,
        game,
        target_issue,
    )

    previous_forward = fetch_optional_json(
        f"{base}/api/learning/forecast?game={game}&issue={latest_issue}",
        f"{base}/learning",
    )
    if previous_forward is not None:
        previous_revision = _resolved_forward_learning_revision(
            previous_forward,
            game,
            latest_issue,
        )
        if previous_revision is None:
            raise RuntimeError(
                f"{game} verified issue {latest_issue} has an invalid prior resolved-v2 freeze"
            )
        forward_reviews = fetch_json(
            f"{base}/api/learning/reviews?game={game}&limit=5",
            f"{base}/learning",
        )
        if not is_complete_forward_learning_review(
            forward_reviews,
            latest_issue,
            previous_revision,
        ):
            raise RuntimeError(
                f"{game} forward review for {latest_issue} is not a complete five-slot learning run (resolved-v2)"
            )
    return {
        "status": "frozen",
        "game": game,
        "settledIssue": None if primary_bootstrap else latest_issue,
        "targetIssue": target_issue,
        "forwardLearningTargetIssue": target_issue,
        "revision": revision,
    }


def check_update_required(
    site_url: str,
    game: str,
) -> dict[str, object]:
    """Return whether the latest verified result is ready to be settled."""
    if game not in ("hk", "new_macau"):
        raise ValueError(f"unsupported game: {game}")
    base = site_url.rstrip("/")
    lottery = fetch_json(
        f"{base}/api/lottery?game={game}&limit=120",
        f"{base}/",
    )
    draws = lottery.get("draws")
    if not isinstance(draws, list) or not draws or not isinstance(draws[0], dict):
        raise RuntimeError(f"{game} latest draw unavailable")
    latest = draws[0]
    verified_count = sum(
        1 for draw in draws
        if isinstance(draw, dict) and draw.get("verified") is True
    )
    latest_issue = str(latest.get("issue") or "")
    if not latest_issue:
        raise RuntimeError(f"{game} latest draw issue unavailable")
    if latest.get("verified") is not True:
        return {
            "shouldRun": False,
            "reason": "awaiting_verification",
            "game": game,
            "latestIssue": latest_issue,
        }

    forecast = fetch_optional_json(
        f"{base}/api/research/forecast?game={game}",
        f"{base}/research",
    )
    if forecast is None:
        return {
            "shouldRun": True,
            "reason": "bootstrap_required",
            "game": game,
            "latestIssue": latest_issue,
            "targetIssue": None,
        }
    target_issue = str(forecast.get("targetIssue") or "")
    should_run = not target_issue or (
        _issue_number(latest_issue) >= _issue_number(target_issue)
    )
    if not should_run:
        forward = fetch_optional_json(
            f"{base}/api/learning/forecast?game={game}",
            f"{base}/learning",
        )
        if not is_complete_forward_learning_freeze(forward, game, target_issue):
            patterns, revision_repair = fetch_update_patterns(
                f"{base}/api/research/patterns?game={game}",
                f"{base}/patterns",
            )
            if revision_repair:
                return {
                    "shouldRun": True,
                    "reason": "unified_revision_repair_required",
                    "game": game,
                    "latestIssue": latest_issue,
                    "targetIssue": target_issue,
                }
            if patterns is None and verified_count < 30:
                return {
                    "shouldRun": False,
                    "reason": "forward_learning_waiting_for_pattern_window",
                    "game": game,
                    "latestIssue": latest_issue,
                    "targetIssue": target_issue,
                }
            return {
                "shouldRun": True,
                "reason": (
                    "forward_learning_repair_required"
                    if patterns is None
                    else "unified_revision_repair_required"
                ),
                "game": game,
                "latestIssue": latest_issue,
                "targetIssue": target_issue,
            }
        patterns, revision_repair = fetch_update_patterns(
            f"{base}/api/research/patterns?game={game}",
            f"{base}/patterns",
        )
        if revision_repair:
            return {
                "shouldRun": True,
                "reason": "unified_revision_repair_required",
                "game": game,
                "latestIssue": latest_issue,
                "targetIssue": target_issue,
            }
        try:
            _validate_recommendation_alignment(
                patterns,
                forward,
                game,
                target_issue,
            )
        except RuntimeError:
            return {
                "shouldRun": True,
                "reason": "unified_revision_repair_required",
                "game": game,
                "latestIssue": latest_issue,
                "targetIssue": target_issue,
            }
        previous_forward = fetch_optional_json(
            f"{base}/api/learning/forecast?game={game}&issue={latest_issue}",
            f"{base}/learning",
        )
        if previous_forward is not None:
            previous_revision = _resolved_forward_learning_revision(
                previous_forward,
                game,
                latest_issue,
            )
            if previous_revision is None:
                return {
                    "shouldRun": True,
                    "reason": "forward_learning_review_repair_required",
                    "game": game,
                    "latestIssue": latest_issue,
                    "targetIssue": target_issue,
                }
            reviews = fetch_json(
                f"{base}/api/learning/reviews?game={game}&limit=5",
                f"{base}/learning",
            )
            if not is_complete_forward_learning_review(
                reviews,
                latest_issue,
                previous_revision,
            ):
                return {
                    "shouldRun": True,
                    "reason": "forward_learning_review_repair_required",
                    "game": game,
                    "latestIssue": latest_issue,
                    "targetIssue": target_issue,
                }
    return {
        "shouldRun": should_run,
        "reason": "verified_result_ready" if should_run else "forecast_ahead",
        "game": game,
        "latestIssue": latest_issue,
        "targetIssue": target_issue or None,
    }


def _issue_number(issue: str) -> int:
    if not issue.isdigit():
        raise RuntimeError(f"invalid numeric issue: {issue}")
    return int(issue)


def run_cycle(
    site_url: str,
    secret: str,
    game: str,
    output_dir: str,
) -> dict[str, object]:
    destination = Path(output_dir)
    destination.mkdir(parents=True, exist_ok=True)
    history_path = destination / f"{game}-history.json"
    artifact_path = destination / f"{game}.json"
    draws = sync_game_history(site_url, game)
    history_path.write_text(
        json.dumps({game: draws}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    artifact = run_shadow_research(history_path, game)
    artifact_path.write_text(
        json.dumps(artifact, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    primary = capture(
        site_url,
        secret,
        game,
        str(artifact_path),
        max_wait_seconds=0,
    )
    if primary.get("status") == "awaiting_verification":
        return primary
    rolling = primary.get("rollingPatterns")
    if isinstance(rolling, dict) and rolling.get("status") == "insufficient_data":
        missing = rolling.get("missing")
        return {
            **primary,
            "forwardLearning": {
                "status": "insufficient_data",
                "missing": missing if isinstance(missing, int) else None,
                "forecastCount": 0,
            },
        }
    target_issue = str(primary.get("targetIssue") or "")
    if not target_issue:
        raise RuntimeError(f"{game} primary capture returned no target issue")
    forward = capture_forward_learning(
        site_url,
        secret,
        game,
        target_issue,
        max_wait_seconds=0,
    )
    return {**primary, "forwardLearning": forward}


def capture_forward_learning(
    site_url: str,
    secret: str,
    game: str,
    target_issue: str,
    max_wait_seconds: int = 0,
) -> dict[str, object]:
    base = site_url.rstrip("/")
    body = json.dumps(
        {
            "taskId": f"forward-learning-v1:{game}:{target_issue}",
            "game": game,
        },
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    deadline = time.monotonic() + max(0, max_wait_seconds)
    last_error: BaseException | None = None
    while True:
        timestamp = str(int(time.time() * 1000))
        signature = hmac.new(
            secret.encode("utf-8"),
            timestamp.encode("utf-8") + b"." + body,
            hashlib.sha256,
        ).hexdigest()
        request = Request(
            f"{base}/api/internal/learning/settle-and-freeze",
            data=body,
            method="POST",
            headers={
                **HTTP_HEADERS,
                "content-type": "application/json",
                "origin": base,
                "referer": f"{base}/learning",
                "x-research-timestamp": timestamp,
                "x-research-signature": signature,
            },
        )
        try:
            with urlopen(request, timeout=75) as response:
                result = json.loads(response.read().decode("utf-8"))
                if not isinstance(result, dict):
                    raise ValueError(f"invalid forward learning response for {game}")
                forecasts = result.get("forecasts")
                resolved_revision = _resolved_forward_learning_revision(
                    result,
                    game,
                    target_issue,
                    require_policy=True,
                )
                if (
                    result.get("status") not in ("created", "existing")
                    or result.get("game") != game
                    or str(result.get("targetIssue") or "") != target_issue
                    or resolved_revision is None
                    or result.get("revision") != resolved_revision
                ):
                    raise RuntimeError(
                        f"{game} forward learning did not return a complete five-slot freeze for resolved-v2"
                    )
                assert isinstance(forecasts, list)
                result["forecastCount"] = len(forecasts)
                result.pop("forecasts", None)
                return result
        except HTTPError as error:
            if error.code == 425:
                raise RuntimeError(
                    f"{game} forward learning prerequisite unavailable"
                ) from error
            if error.code not in (409, 425, 429, 502, 503, 504):
                raise
            last_error = error
        except (URLError, TimeoutError) as error:
            last_error = error
        if time.monotonic() >= deadline:
            if max_wait_seconds <= 0 and isinstance(last_error, HTTPError):
                raise RuntimeError(
                    f"forward learning request failed for {game}: HTTP {last_error.code}"
                ) from last_error
            if max_wait_seconds <= 0 and last_error is not None:
                raise RuntimeError(
                    f"forward learning request failed for {game}: {last_error}"
                ) from last_error
            raise TimeoutError(
                f"forward learning capture timed out for {game}"
            ) from last_error
        time.sleep(min(30, max(1, deadline - time.monotonic())))


def capture(
    site_url: str,
    secret: str,
    game: str,
    artifact_path: str,
    max_wait_seconds: int = 0,
) -> dict[str, object]:
    base = site_url.rstrip("/")
    artifact = json.loads(Path(artifact_path).read_text(encoding="utf-8"))
    if (
        artifact.get("schemaVersion") != "python-shadow-v3"
        or artifact.get("game") != game
    ):
        raise ValueError("artifact schema or game mismatch")
    body = json.dumps(
        {
            "taskId": capture_task_id(game, artifact),
            "game": game,
            "researchArtifact": artifact,
        },
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    deadline = time.monotonic() + max(0, max_wait_seconds)
    last_error: BaseException | None = None
    while True:
        timestamp = str(int(time.time() * 1000))
        signature = hmac.new(
            secret.encode("utf-8"),
            timestamp.encode("utf-8") + b"." + body,
            hashlib.sha256,
        ).hexdigest()
        request = Request(
            f"{base}/api/internal/research/settle-and-learn",
            data=body,
            method="POST",
            headers={
                **HTTP_HEADERS,
                "content-type": "application/json",
                "origin": base,
                "referer": f"{base}/research",
                "x-research-timestamp": timestamp,
                "x-research-signature": signature,
            },
        )
        try:
            with urlopen(request, timeout=90) as response:
                result = json.loads(response.read().decode("utf-8"))
                if not isinstance(result, dict):
                    raise ValueError(f"invalid research response for {game}")
                return result
        except HTTPError as error:
            if error.code == 425:
                return {"status": "awaiting_verification"}
            if error.code not in (409, 425, 429, 502, 503, 504):
                raise
            last_error = error
        except (URLError, TimeoutError) as error:
            last_error = error
        if time.monotonic() >= deadline:
            if max_wait_seconds <= 0 and isinstance(last_error, HTTPError):
                raise RuntimeError(
                    f"research request failed for {game}: HTTP {last_error.code}"
                ) from last_error
            if max_wait_seconds <= 0 and last_error is not None:
                raise RuntimeError(
                    f"research request failed for {game}: {last_error}"
                ) from last_error
            raise TimeoutError(
                f"research capture timed out for {game}"
            ) from last_error
        time.sleep(min(60, max(1, deadline - time.monotonic())))


PATTERN_TASK_VERSION = "conditional-patterns-v2"


def capture_task_id(game: str, artifact: dict[str, object]) -> str:
    audit = artifact.get("audit")
    audit = audit if isinstance(audit, dict) else {}
    issue = str(audit.get("newestIssue") or "empty")
    artifact_hash = hashlib.sha256(
        json.dumps(
            artifact,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()
    return f"scheduled-{game}-{issue}-{PATTERN_TASK_VERSION}-{artifact_hash[:20]}"


if __name__ == "__main__":
    main()
