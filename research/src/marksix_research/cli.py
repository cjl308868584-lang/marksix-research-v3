from __future__ import annotations

import argparse
import hashlib
import hmac
import json
from pathlib import Path
import time
from urllib.request import Request, urlopen

from .pipeline import run_shadow_research


def main() -> None:
    parser = argparse.ArgumentParser(prog="marksix-research")
    subparsers = parser.add_subparsers(dest="command", required=True)

    run = subparsers.add_parser("run", help="run the offline shadow audit")
    run.add_argument("--history", required=True)
    run.add_argument("--game", choices=("hk", "new_macau"), required=True)
    run.add_argument("--output", required=True)

    publish = subparsers.add_parser("capture", help="freeze the site's current v2 snapshot")
    publish.add_argument("--site-url", required=True)
    publish.add_argument("--secret", required=True)
    publish.add_argument("--game", choices=("hk", "new_macau"), required=True)

    args = parser.parse_args()
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
    capture(args.site_url, args.secret, args.game)


def capture(site_url: str, secret: str, game: str) -> None:
    base = site_url.rstrip("/")
    with urlopen(f"{base}/api/research/forecast?game={game}", timeout=90) as response:
        snapshot = json.loads(response.read().decode("utf-8"))
    snapshot.pop("source", None)
    rules = [
        *snapshot.get("verifiedRules", []),
        *snapshot.get("experimentalRules", []),
        *snapshot.get("negativeRules", []),
    ]
    body = json.dumps(
        {"snapshot": snapshot, "rules": rules, "source": "computed"},
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    timestamp = str(int(time.time() * 1000))
    signature = hmac.new(
        secret.encode("utf-8"),
        timestamp.encode("utf-8") + b"." + body,
        hashlib.sha256,
    ).hexdigest()
    request = Request(
        f"{base}/api/internal/research-runs",
        data=body,
        method="POST",
        headers={
            "content-type": "application/json",
            "x-research-timestamp": timestamp,
            "x-research-signature": signature,
        },
    )
    with urlopen(request, timeout=90) as response:
        print(response.read().decode("utf-8"))


if __name__ == "__main__":
    main()

