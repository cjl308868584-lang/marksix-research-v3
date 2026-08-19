# Task 4 Report — Unified five-item API and UI projection

## Status

Complete. Both public pages now consume the same canonical five authoritative recommendations from the highest committed resolved-v2 revision.

## Implemented

- `/api/research/patterns` returns all five canonical recommendations independent of `scope`; `scope` continues to filter only signals, summaries, consensus, and value-analysis rows.
- `/api/learning/forecast` projects the same authoritative fields and adds official forecast IDs, labels, freeze metadata, and explanations.
- Mixed, incomplete, or source-mismatched recommendation revisions fail closed with HTTP 503 and `private, no-store`.
- Public reviews and performance read only official scores from the highest committed v2 revision per issue. v1 rows, lower committed revisions, and the 357-candidate diagnostic denominator are excluded.
- Public performance rejects a partially written five-score official denominator rather than publishing partial KPIs.
- `/api/learning/model` now returns `{ game, learning }` with per-slot settled candidate counts, official sample counts, latest adjustment points, and learned-through issue.
- `/patterns` renders the server-selected five items without client reselection or null cards.
- `/learning` shows the same five items with probability, baseline, odds, break-even, EV, current-30 support/hits, legacy seed history, and new learning history.
- Negative-EV items remain visible with their concrete result and explicit “低于盈亏平衡线” risk wording.
- Removed the “本期不推荐”, odds-excluded sorting, three-expert, model-weight, and rule-weight UI language; replaced it with the product-learning status board.

## TDD evidence

- API tests failed first because patterns had no authoritative recommendations, forecast still used the legacy shape, and review/performance had no resolved-v2 public projection.
- UI tests failed first on the old odds/expert copy and nullable recommendation cards.
- A final review test failed first with HTTP 200 for a partial four-score KPI denominator; the reader now rejects it with HTTP 503.

## Verification

- `node --test tests/forward-learning-api.test.ts tests/forward-learning-ui.test.ts tests/rendered-html.test.mjs && npm run typecheck` — 33/33 tests passed; typecheck passed.
- `npm test` — passed on the final tree:
  - 179/179 Node core tests
  - 33/33 Python research tests
  - production build passed
  - 8/8 deployment tests
  - 24/24 rendered HTML/API tests

## Concerns

- None blocking. Build output retains pre-existing proxy and Node `punycode` deprecation warnings; no test or build failures.
- The legacy internal `readForwardLearningForecast` compatibility reader remains for audit/service callers, while both public routes use `readResolvedProductRecommendations` directly.
