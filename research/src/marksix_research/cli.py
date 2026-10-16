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
    parser.add_argument("command", choices=("cycle", "check-update", "health-check"))
    parser.add_argument("--site-url", required=True)
    parser.add_argument("--game", choices=("hk", "new_macau"), required=True)
    parser.add_argument("--secret")
    parser.add_argument("--output-dir", default="research-artifacts")
    args = parser.parse_args()
    if args.command == "cycle":
        if not args.secret:
            parser.error("cycle requires --secret")
        result = run_cycle(args.site_url, args.secret, args.game, args.output_dir)
    elif args.command == "check-update":
        result = check_update_required(args.site_url, args.game)
    else:
        result = verify_production_health(args.site_url, args.game)
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))


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


def _raw_pattern_recommendations(
    payload: dict[str, object] | None,
    game: str,
    target_issue: str,
) -> dict[str, dict[str, object]] | None:
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
    if slots != FORWARD_LEARNING_SLOTS or revisions != {0}:
        return None
    for recommendation in typed:
        product = recommendation.get("product")
        values = recommendation.get("values")
        if (
            not isinstance(product, dict)
            or not isinstance(values, list)
            or str(product.get("targetIssue") or "") != target_issue
            or str(product.get("runId") or "") != run_id
            or product.get("kind") != recommendation.get("kind")
            or product.get("values") != values
            or recommendation.get("resultKey") != "+".join(str(value) for value in values)
            or recommendation.get("sourceRunId") != run_id
            or any(field not in recommendation for field in RECOMMENDATION_FIELDS)
        ):
            return None
    return {
        str(recommendation["kind"]): recommendation
        for recommendation in typed
    }


def _validate_recommendation_sources(
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
    if learning_revision is None:
        raise RuntimeError(
            f"{game} target {target_issue} has an invalid resolved-v2 five-slot revision"
        )
    if _raw_pattern_recommendations(patterns, game, target_issue) is None:
        raise RuntimeError(
            f"{game} target {target_issue} has an invalid raw pattern five-slot set"
        )
    return learning_revision


def _issue_number(issue: str) -> int:
    if not issue.isdigit():
        raise RuntimeError(f"invalid numeric issue: {issue}")
    return int(issue)


def _latest(site_url, game):
    if game not in ("hk", "new_macau"):
        raise ValueError(f"unsupported game: {game}")
    base = site_url.rstrip("/")
    payload = fetch_json(f"{base}/api/lottery?game={game}&limit=120", f"{base}/")
    draws = payload.get("draws")
    if not isinstance(draws, list) or not draws or not isinstance(draws[0], dict):
        raise RuntimeError(f"{game} latest draw unavailable")
    latest = draws[0]
    _issue_number(str(latest.get("issue") or ""))
    return latest, sum(1 for d in draws if isinstance(d,dict) and d.get("verified") is True)


def _patterns(site_url, game):
    base = site_url.rstrip("/")
    return fetch_optional_json(f"{base}/api/research/patterns?game={game}", f"{base}/patterns")


def _target(patterns):
    return str((patterns or {}).get("run", {}).get("targetIssue") or "")


def _prior_review(site_url, game, issue):
    base = site_url.rstrip("/")
    prior = fetch_optional_json(f"{base}/api/learning/forecast?game={game}&issue={issue}", f"{base}/learning")
    if prior is None:
        return True  # No prediction was frozen; never fabricate a retrospective score.
    revision = _resolved_forward_learning_revision(prior,game,issue)
    if revision is None:
        return False
    reviews = fetch_json(f"{base}/api/learning/reviews?game={game}&limit=5", f"{base}/learning")
    return is_complete_forward_learning_review(reviews,issue,revision)


def check_update_required(site_url, game):
    latest, count = _latest(site_url,game)
    issue = str(latest["issue"])
    if latest.get("verified") is not True:
        return dict(shouldRun=False,reason="awaiting_verification",game=game,latestIssue=issue)
    patterns = _patterns(site_url,game)
    target = _target(patterns)
    if not target or _issue_number(target) <= _issue_number(issue):
        return dict(shouldRun=True,reason="verified_result_ready",game=game,latestIssue=issue,targetIssue=target or None)
    base = site_url.rstrip("/")
    forward = fetch_optional_json(f"{base}/api/learning/forecast?game={game}",f"{base}/learning")
    try:
        _validate_recommendation_sources(patterns,forward,game,target)
        healthy = _prior_review(site_url,game,issue)
    except RuntimeError:
        healthy = False
    return dict(shouldRun=not healthy,reason="forecast_ahead" if healthy else "learning_repair_required",game=game,latestIssue=issue,targetIssue=target)


def verify_production_health(site_url, game):
    latest, count = _latest(site_url,game)
    issue = str(latest["issue"])
    if latest.get("verified") is not True:
        return dict(status="awaiting_verification",game=game,latestIssue=issue)
    patterns = _patterns(site_url,game)
    if patterns is None and count < 30:
        return dict(status="degraded",reason="insufficient_pattern_history",game=game)
    target = _target(patterns)
    if not target or _issue_number(target) <= _issue_number(issue):
        raise RuntimeError(f"{game} verified issue {issue} did not advance pattern target {target or 'missing'}")
    base = site_url.rstrip("/")
    forward = fetch_optional_json(f"{base}/api/learning/forecast?game={game}", f"{base}/learning")
    revision = _validate_recommendation_sources(patterns,forward,game,target)
    if not _prior_review(site_url,game,issue):
        raise RuntimeError(f"{game} forward review for {issue} is not a complete resolved-v2 learning run")
    # Verify the pattern archive was settled too, independently of forward learning.
    archive = fetch_optional_json(f"{base}/api/research/patterns/reviews?game={game}&issue={issue}",f"{base}/patterns")
    if archive and archive.get("review") is not None and not archive["review"].get("score"):
        raise RuntimeError(f"{game} pattern review missing for {issue}")
    return dict(status="frozen",game=game,settledIssue=issue,targetIssue=target,revision=revision)


def capture_patterns(site_url, secret, game):
    base = site_url.rstrip("/")
    # No old response cache: every invocation rechecks live verification.
    body = json.dumps(dict(taskId=f"patterns-v1:{game}",game=game),separators=(",", ":")).encode()
    timestamp = str(int(time.time()*1000))
    signature = hmac.new(secret.encode(),timestamp.encode()+b"."+body,hashlib.sha256).hexdigest()
    request = Request(f"{base}/api/internal/patterns/settle-and-freeze",data=body,method="POST",headers={
        **HTTP_HEADERS,"content-type":"application/json","origin":base,"referer":f"{base}/patterns",
        "x-research-timestamp":timestamp,"x-research-signature":signature,
    })
    try:
        with urlopen(request,timeout=90) as response:
            result = json.loads(response.read().decode())
    except HTTPError as error:
        if error.code != 425:
            raise
        result = json.loads(error.read().decode())
    if not isinstance(result,dict) or not isinstance(result.get("status"),str):
        raise RuntimeError("invalid pattern update response")
    return result


def run_cycle(site_url, secret, game, output_dir):
    result = capture_patterns(site_url,secret,game)
    if result["status"].startswith("awaiting_"):
        return result
    if result["status"] == "insufficient_data":
        return result
    target = str(result.get("targetIssue") or "")
    if not target:
        raise RuntimeError("pattern update returned no target")
    result["forwardLearning"] = capture_forward_learning(site_url,secret,game,target)
    destination = Path(output_dir)
    destination.mkdir(parents=True,exist_ok=True)
    (destination/"cycle-result.json").write_text(json.dumps(result,ensure_ascii=False),encoding="utf-8")
    return result


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


if __name__ == "__main__":
    main()
