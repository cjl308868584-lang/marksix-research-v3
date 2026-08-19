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

## Review fix round 1

- `readResolvedProductRecommendations` now distinguishes a genuinely absent committed revision from corrupt committed state. It reads and validates the row game, target issue, revision, revision ID, and status against the manifest, and throws a dedicated data-integrity error for invalid JSON or identity mismatch.
- The forecast route consequently returns 404 only when no committed row exists; corrupt committed data fails closed as HTTP 503 with `private, no-store`.
- The model route catches incomplete, mixed, corrupt, or other reader failures and returns HTTP 503 with `private, no-store`; actual route-import tests cover both an incomplete five-slot projection and corrupt manifest JSON.
- Public review types now require a resolved-v2 run carrying `revision` and `revisionSource`, plus v2 scores whose `official` field is statically `true`.
- Open Graph/Twitter sharing metadata now says “每期固定五项” and “产品学习”, with the legacy four-item/model-weight wording removed.

### Round 1 TDD and verification

- RED: corrupt committed JSON produced forecast 404, model reader failures escaped the route, store corruption/mismatch returned `null`, and rendered metadata still advertised “每期固定四项…模型权重变化”.
- GREEN: `npm run typecheck && node --test tests/forward-learning-v2-store.test.ts tests/forward-learning-api.test.ts tests/forward-learning-ui.test.ts` — typecheck passed; 26/26 tests passed.
- GREEN: `npm run build && node --test tests/rendered-html.test.mjs` — production build passed; 24/24 rendered HTML/API tests passed.
- GREEN: `npm test` — 184/184 Node tests, 33/33 Python research tests, production build, 8/8 deployment tests, and 24/24 rendered HTML/API tests passed.
- GREEN: final focused `node --test tests/forward-learning-api.test.ts` — 11/11 tests passed, including the explicit no-row 404 versus corrupt-row 503 contract.
- No new blocking concerns. Build output still contains only the pre-existing proxy and Node `punycode` deprecation warnings.
