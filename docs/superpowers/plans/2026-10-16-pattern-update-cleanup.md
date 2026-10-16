# Pattern update repair and strategy removal

Approved scope: repair updates, remove the four-slot strategy centre completely, retain patterns, pattern reviews and five-slot forward learning. Execute inline in the existing clean Sites checkout.

- [x] Add regression coverage for independently reading the latest pattern run and retrying a cycle after verification becomes available. Verify failure before production changes.
- [x] Give patterns their own schema and signed update service. Share canonical verified draw retrieval with forward learning. Settle known results even when the next freeze cutoff was missed; never backdate predictions.
- [x] Remove strategy pages, API endpoints, four-slot engines, training tasks and navigation; migrate away from exclusive strategy tables while preserving shared draw and pattern/forward tables.
- [x] Update unattended CLI/check/health workflow to use pattern and five-slot ledgers only. Waiting states must be retryable; no successful task-cache replay.
- [x] Run the remaining full test suite and rendered-route checks. Review deletion boundaries and migration on SQLite.
- [x] Package and deploy to the existing public Site, push the GitHub automation changes, dispatch a recovery cycle and verify current freeze plus completed prior review.

Review risks: stale or conflicting sources; missed cutoff; unsigned writes; duplicate retries; accidental deletion of shared learning history.

Independent review: one P2 fixed. Verified evidence now corrects unverified stored draws; conflicting verified results still abort. Regression reproduced RED then passed GREEN. SQLite migration replay retained all pattern and forward-learning tables.

Production verification (2026-10-16 Beijing 18:04): Sites v32 deployed. GitHub recovery run 38884627398 completed successfully for both games. New Macau 2026288 settled and 2026289 frozen; window 2026259-2026288. Hong Kong target 2026111 frozen. Old /research returns 404; live D1 confirms all nine exclusive strategy tables removed. Full suite: 207 Node domain tests, 15 Python, 10 deployment and 17 rendered-route tests passed.
