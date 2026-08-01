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
    publish.add_argument("--max-wait-seconds", type=int, default=3600)

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
    capture(
        args.site_url,
        args.secret,
        args.game,
        args.artifact,
        args.max_wait_seconds,
    )


def sync_history(site_url: str, output_path: str) -> None:
    base = site_url.rstrip("/")
    payload: dict[str, list[dict[str, object]]] = {}
    for game in ("hk", "new_macau"):
        request = Request(
            f"{base}/api/lottery?game={game}&limit=120",
            headers={**HTTP_HEADERS, "referer": f"{base}/"},
        )
        with urlopen(request, timeout=90) as response:
            body = json.loads(response.read().decode("utf-8"))
        draws = body.get("draws")
        if not isinstance(draws, list) or not draws:
            raise ValueError(f"server history unavailable for {game}")
        payload[game] = draws
    destination = Path(output_path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def capture(
    site_url: str,
    secret: str,
    game: str,
    artifact_path: str,
    max_wait_seconds: int = 3600,
) -> None:
    base = site_url.rstrip("/")
    artifact = json.loads(Path(artifact_path).read_text(encoding="utf-8"))
    if (
        artifact.get("schemaVersion") != "python-shadow-v3"
        or artifact.get("game") != game
    ):
        raise ValueError("artifact schema or game mismatch")
    body = json.dumps(
        {
            "taskId": f"scheduled-{game}-{int(time.time() // 300)}",
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
                print(response.read().decode("utf-8"))
                return
        except HTTPError as error:
            if error.code not in (409, 425, 429, 502, 503, 504):
                raise
        except URLError:
            pass
        if time.monotonic() >= deadline:
            raise TimeoutError(f"research capture timed out for {game}")
        time.sleep(min(60, max(1, deadline - time.monotonic())))


if __name__ == "__main__":
    main()
