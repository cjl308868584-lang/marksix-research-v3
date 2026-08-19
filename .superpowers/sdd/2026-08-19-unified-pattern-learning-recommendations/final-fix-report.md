# Unified pattern learning recommendations — final fix report

## Status

Complete on fix base `4ab95cca6e3c4f0558b1077cce457dd35e60803e`. All four Important findings are covered by narrow regression tests, the requested Minor cleanups are complete, and the full repository test command passes.

## Important 1 — signed internal response uses the canonical authority projection

### RED

Added `test_signed_internal_route_payload_satisfies_the_python_capture_contract`. The test does not hand-build a public-shaped response: it launches `tests/support/render-internal-forward-learning-response.ts`, creates a real in-memory D1 store, seeds an immutable completed rolling run, signs a request to the actual internal route, and passes the returned JSON into the real Python `capture_forward_learning` validator.

Focused command:

```text
PYTHONPATH=research/src python3 -m unittest \
  research.tests.test_pipeline.ResearchPipelineTest.test_signed_internal_route_payload_satisfies_the_python_capture_contract -v
```

Initial result:

```text
RuntimeError: hk forward learning did not return a complete five-slot freeze for resolved-v2
```

The raw `ForwardLearningForecastV2` response lacked CLI-required canonical aliases such as `kind` and `p30`.

### GREEN

- After a `created` or `existing` cycle, the internal route reads back the exact committed revision and projects it with `projectResolvedLearningForecasts`, the same projector used by the public learning API.
- The projector now preserves `selectionPolicy`.
- The actual internal-route payload passes the Python capture contract with revision 1 and exactly five forecasts.

## Important 2 — dynamic rollout freezes the real recommendation authority hash

### RED

Added narrow service tests for:

- a first dynamic rollout whose authority hash must equal the first frozen revision's `recommendationHash`, not `window.dataHash`;
- a concurrent insert conflict that must reread the stored rollout and recompute with its immutable cutoff/identity;
- an invalid concurrent cutoff that must fail closed;
- a New Macau bootstrap missing real legacy product provenance, which must not be repaired with fabricated IDs.

Focused command:

```text
node --test --test-name-pattern='dynamic first rollout|concurrent dynamic rollout|bootstrap never synthesizes' \
  tests/forward-learning-service.test.ts
```

Initial failures showed the authority hash was `data-2026232`, the concurrent path returned `awaiting_rollout` instead of freezing from the stored identity, and bootstrap code could synthesize provenance. The invalid stored-cutoff regression initially froze instead of returning `awaiting_rollout`.

### GREEN

- A missing dynamic rollout first builds all 357 candidates and the actual five recommendations from the immutable run plus bounded legacy/v2 histories.
- `hashAuthoritativeRecommendations` hashes the same canonical five-item payload used by `recommendationHash`; only then is the rollout persisted.
- On a persistence conflict, the stored rollout is reread, its identity/cutoff is validated, and state is rebuilt using its stored cutoff; invalid state fails closed.
- The first revision explicitly asserts `rollout.authoritativeRecommendationHash === snapshot.recommendationHash` before freezing.
- Removed bootstrap `correctionProvenanceIdentities`; `legacyProductIds` now comes only from real store provenance.

## Important 3 — v2 settlement retries validate every deterministic score byte

### RED

Added settlement regressions for:

- completed draw A followed by draw B;
- partial draw A followed by draw B;
- mutation of a frozen deterministic field (`probability`);
- the existing same-draw partial repair and completed retry paths, including the exact five-official assertion.

Focused command:

```text
node --test --test-name-pattern='completed settlement rejects|partial settlement from draw A|deterministic score field conflict|partial settlement is repaired|settlement retry cannot duplicate' \
  tests/forward-learning-v2-store.test.ts
```

Initial result: the three conflict tests failed with “Missing expected rejection.”

### GREEN

- Settlement computes the complete expected score map before examining stored rows.
- Every existing row is checked against its SQL mirror and its expected candidate score. Canonical comparison covers every score field except `scoredAt`, including draw actuals, probability, official flag, forecast ID, candidate/revision identity, and losses.
- Partial retries insert only missing candidates, then reload and revalidate the complete set.
- Completion requires exactly 357 unique candidates/results and exactly five unique official slots.
- Same-draw partial repair preserves the original stored `scoredAt`; different draws or any frozen deterministic conflict fail closed.

## Important 4 — aggregates use validated highest committed revisions only

### RED

Added corrupt-highest-manifest tests at all three required entry points:

- `readUnifiedCandidateHistory`;
- `/api/learning/reviews`;
- `/api/learning/performance`.

Focused commands:

```text
node --test --test-name-pattern='candidate history fails closed' tests/forward-learning-v2-store.test.ts
node --test --test-name-pattern='reviews and performance fail closed' tests/forward-learning-api.test.ts
```

Initial results: candidate history accepted the corrupt manifest, while both public routes returned HTTP 200 instead of HTTP 503.

### GREEN

- Added one shared `readValidatedHighestCommittedScores` path.
- It first resolves the highest committed manifest per issue, parses and validates row/manifest game, issue, revision, revision ID, status, selection policy, source run, and data version, then admits only scores whose SQL identity and JSON identity match that manifest.
- Candidate learning uses this path with the target cutoff and exact 357/5 validation.
- Model, reviews, and performance reuse the same validated score source; reviews/performance additionally enforce the exact five-official denominator.
- Corrupt or mismatched highest manifests now fail the whole read closed instead of contributing learning or public statistics.

## Requested Minor fixes

- Removed service-bootstrap legacy product ID fabrication; real store provenance is retained unchanged.
- Added `learningSettledCount` and `learningHitCount` to Python canonical recommendation comparison and updated fixtures. `test_health_rejects_learning_counter_drift` was RED because drift was accepted, then GREEN after both fields joined `RECOMMENDATION_FIELDS`.
- Removed the new `forward-learning-v2-store` unused-variable warnings. Before cleanup, the targeted ESLint run reported eight `@typescript-eslint/no-unused-vars` warnings from forecast-only destructuring; after cleanup it exits 0 with no output.
- Left the previously reported all-history model/statistics SQL performance Minor unchanged. The correctness path is now centralized and validated, but historical score loading remains unbounded as permitted by this fix-wave scope.

## Final verification

Focused Node regression suite:

```text
node --test tests/forward-learning-service.test.ts tests/forward-learning-v2-store.test.ts \
  tests/forward-learning-api.test.ts tests/forward-learning-store.test.ts \
  tests/unified-product-learning.test.ts tests/unified-pattern-recommendations.test.ts \
  tests/rolling-pattern-store.test.ts

tests 70; pass 70; fail 0
```

Python research suite:

```text
npm run test:research

Ran 48 tests in 1.697s
OK
```

Static checks:

```text
npm run typecheck -- --pretty false
# exit 0

npx eslint lib/forward-learning-v2-store.ts lib/forward-learning-service.ts
# exit 0, no output

git diff --check
# exit 0, no output
```

Full repository verification:

```text
npm test

Node core:       194/194 passed
Python research: 48/48 passed
Production build: passed
Deployment:       8/8 passed
Rendered/API:    24/24 passed
```

## Concerns

- No blocking concerns.
- The allowed all-history score-query performance Minor remains open.
- The successful production build still emits the pre-existing proxy notice and Node `punycode` deprecation warning; neither is introduced by this change.
