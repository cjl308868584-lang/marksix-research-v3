from __future__ import annotations

import argparse
import hashlib
import hmac
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


def verify_production_health(
    site_url: str,
    game: str,
) -> dict[str, object]:
    if game not in ("hk", "new_macau"):
        raise ValueError(f"unsupported game: {game}")
    base = site_url.rstrip("/")
    lottery = fetch_json(
        f"{base}/api/lottery?game={game}&limit=5",
        f"{base}/",
    )
    draws = lottery.get("draws")
    if not isinstance(draws, list) or not draws or not isinstance(draws[0], dict):
        raise RuntimeError(f"{game} latest draw unavailable")
    latest = draws[0]
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
    if not isinstance(reviews, list) or not any(
        isinstance(review, dict) and str(review.get("targetIssue")) == latest_issue
        for review in reviews
    ):
        raise RuntimeError(f"{game} review missing for verified issue {latest_issue}")

    learning_payload = fetch_json(
        f"{base}/api/research/learning-runs?game={game}&limit=5",
        f"{base}/research/review",
    )
    learning_runs = learning_payload.get("learningRuns")
    if not isinstance(learning_runs, list) or not any(
        isinstance(run, dict)
        and str(run.get("settledIssue")) == latest_issue
        and run.get("status") == "completed"
        for run in learning_runs
    ):
        raise RuntimeError(
            f"{game} completed learning run missing for verified issue {latest_issue}"
        )
    return {
        "status": "frozen",
        "game": game,
        "settledIssue": latest_issue,
        "targetIssue": target_issue,
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
        f"{base}/api/lottery?game={game}&limit=1",
        f"{base}/",
    )
    draws = lottery.get("draws")
    if not isinstance(draws, list) or not draws or not isinstance(draws[0], dict):
        raise RuntimeError(f"{game} latest draw unavailable")
    latest = draws[0]
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

    forecast = fetch_json(
        f"{base}/api/research/forecast?game={game}",
        f"{base}/research",
    )
    target_issue = str(forecast.get("targetIssue") or "")
    should_run = not target_issue or (
        _issue_number(latest_issue) >= _issue_number(target_issue)
    )
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
    return capture(
        site_url,
        secret,
        game,
        str(artifact_path),
        max_wait_seconds=0,
    )


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
        except URLError:
            pass
        if time.monotonic() >= deadline:
            raise TimeoutError(f"research capture timed out for {game}")
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
