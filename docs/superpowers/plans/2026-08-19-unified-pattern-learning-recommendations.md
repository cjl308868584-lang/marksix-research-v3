# Unified Pattern and Forward Learning Recommendations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/patterns` and `/learning` freeze the same mandatory five recommendations, then use only post-launch immutable candidate scores to adjust later issues without backfilling official history.

**Architecture:** Move recommendation construction into one deterministic rolling-product core that always emits 357 candidates and selects one per category by expected value. Persist v2 candidates, forecasts, scores, rollout cutoffs, and corrections in a committed revision ledger; both APIs read the same resolved revision. Preserve all v1 rows, repair the unscored 2026231 bootstrap through revision 2, and derive later learning only from committed v2 candidate scores.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript 5.9, Cloudflare D1, Node test runner, Python unittest, GitHub Actions, vinext, Sites hosting.

**Spec:** `docs/superpowers/specs/2026-08-19-unified-pattern-learning-recommendations-design.md`

## Global Constraints

- A complete 30-draw `RollingPatternRun` produces exactly 357 candidates: 12 zodiac, 10 tail, 66 zodiac-pair, 220 zodiac-triple, and 49 special-number products.
- Every complete target issue freezes exactly one result for each of the five categories; no API or page may return or display “本期不推荐”.
- Selection uses expected value first with the confirmed odds table; negative expected value remains eligible and the highest item is selected.
- The first v2 issue has zero new learning samples and uses the frozen legacy product result only as a seed; legacy rows never enter new official performance.
- Legacy product history is bounded by `target_issue < firstUnifiedTargetIssue`; post-cutoff legacy scores cannot affect v2 probability or rank.
- Only scores belonging to the highest committed revision affect v2 learning, reviews, and performance.
- When more than one committed revision exists for an issue, every reader and aggregate resolves the highest integer revision for that issue before reading scores.
- Five official scores per settled issue enter performance; nonofficial candidate scores may adjust later candidates but never inflate official hit rate.
- v1 candidates, forecasts, and scores remain immutable and readable for audit; no production row is deleted or overwritten.
- Settlement requires a verified matching draw and `frozen_at < draw_at`; every write and retry is idempotent.
- HK remains `awaiting_pattern_window` until a completed 30-draw run exists.
- GET routes remain read-only with `Cache-Control: private, no-store`.
- Every `/api/research/patterns` response carries the complete canonical five-item `recommendations` array; `scope` filters only signals and product-analysis rows.
- Runtime v2 schema repair is mandatory on existing production D1 databases; checking a migration file into git is not considered an applied migration.
- Node remains `>=22.13.0`; do not add statistical or training dependencies.

---

### Task 1: Build the shared mandatory product core

**Files:**
- Modify: `lib/rolling-pattern-types.ts:217-286`
- Modify: `lib/rolling-pattern-value.ts:14-380`
- Modify: `tests/rolling-pattern-value.test.ts`
- Create: `tests/unified-pattern-recommendations.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: a frozen `RollingPatternRun`, per-result legacy history, and per-result v2 candidate history.
- Produces:

```ts
export type ProductHistoryCounts = { settledCount: number; hitCount: number };
export type UnifiedProductHistories = {
  legacy: ReadonlyMap<string, ProductHistoryCounts>;
  learned: ReadonlyMap<string, ProductHistoryCounts>;
  legacyProductIds: ReadonlyMap<string, string>;
};
export type AuthoritativeRecommendation = {
  kind: RollingPatternProductKind;
  resultKey: string;
  values: string[];
  sourceRunId: string;
  sourceProductId: string | null;
  sourceKind: "ledger" | "derived_baseline";
  dataVersion: string;
  revision: number;
  p30: number;
  legacySeedProbability: number;
  learnedProbability: number;
  netOdds: number;
  breakEvenProbability: number;
  expectedValue: number;
  legacySettledCount: number;
  legacyHitCount: number;
  learningSettledCount: number;
  learningHitCount: number;
  product: RollingPatternProduct;
  reason: string;
};
export function buildUnifiedRollingPatternProducts(
  run: RollingPatternRun,
  histories?: UnifiedProductHistories,
): RollingPatternProduct[];
export function selectMandatoryProductRecommendations(
  products: readonly RollingPatternProduct[],
  revision: number,
): AuthoritativeRecommendation[];
```

- [ ] **Step 1: Write the failing exhaustive-universe test**

Add a zero-signal run fixture and this assertion to `tests/unified-pattern-recommendations.test.ts`:

```ts
test("a complete window always builds the full five-category universe", () => {
  const products = buildUnifiedRollingPatternProducts(runFixture([]));
  assert.equal(products.length, 357);
  assert.deepEqual(countByKind(products), {
    coverage_zodiac: 12,
    coverage_tail: 10,
    coverage_zodiac_pair: 66,
    coverage_zodiac_triple: 220,
    special_number: 49,
  });
  assert.ok(products.every((item) => item.support === 0));
});
```

The production change this test catches is returning only currently signaled products and therefore leaving one or more mandatory categories empty.

- [ ] **Step 2: Run the new test and verify RED**

Run: `node --test tests/unified-pattern-recommendations.test.ts`

Expected: FAIL because `buildUnifiedRollingPatternProducts` does not exist.

- [ ] **Step 3: Implement exhaustive candidates with evidence reuse**

Refactor the existing product finalizer into a reusable function and enumerate the exact category universe. For an evidenced single or combination, reuse `combinedAudit` and the joint hit rule; for an absent event group, create a baseline candidate with empty evidence IDs, zero support/hits, and exact baseline. Use `exactSlotBaseline()` for all fallbacks so target-date zodiac membership is shared with the learning math.

`sourceKind="ledger"` means only that the matching immutable legacy product identity was found in `histories.legacyProductIds`; never copy its probability fields into v2. All v2 values are rebuilt deterministically from the immutable `RollingPatternRun`, bounded legacy counts, and committed v2 counts. Products without that identity use `sourceKind="derived_baseline"` and `sourceProductId=null`.

The resulting code must satisfy this literal cardinality check before returning:

```ts
if (products.length !== 357) {
  throw new Error(`统一产品候选不完整：${products.length}/357`);
}
```

- [ ] **Step 4: Verify the exhaustive test turns GREEN**

Run: `node --test tests/unified-pattern-recommendations.test.ts`

Expected: PASS for the universe test.

- [ ] **Step 5: Write failing tests for mandatory EV selection and two-stage history**

Add independent literal fixtures:

```ts
test("every category selects one item even when every EV is negative", () => {
  const products = allNegativeProductFixture();
  const selected = selectMandatoryProductRecommendations(products, 1);
  assert.equal(selected.length, 5);
  assert.deepEqual(selected.map((item) => item.kind), [
    "coverage_zodiac",
    "coverage_tail",
    "coverage_zodiac_pair",
    "coverage_zodiac_triple",
    "special_number",
  ]);
  assert.ok(selected.every((item) => item.expectedValue < 0));
  assert.ok(selected.every((item) => !item.reason.includes("本期不推荐")));
});

test("legacy seed and new learning are applied once in separate stages", () => {
  const histories = historiesFixture({
    key: "coverage_zodiac:猴",
    legacy: { settledCount: 9, hitCount: 7 },
    learned: { settledCount: 1, hitCount: 0 },
  });
  const monkey = findProduct(buildUnifiedRollingPatternProducts(runFixtureWithMonkey(), histories), "coverage_zodiac", "猴");
  assert.equal(monkey.patternProbability, 0.6995139714843693);
  assert.equal(monkey.legacySeedProbability, 0.7536966066105752);
  assert.equal(monkey.estimatedProbability, 0.6029572852884601);
  assert.equal(monkey.learningSettledCount, 1);
  assert.equal(monkey.learningHitCount, 0);
});
```

The second expected probability is hand-derived as `(0 + 4 × 0.7536966066105752) / 5`.

- [ ] **Step 6: Run the selection/history tests and verify RED**

Run: `node --test --test-name-pattern='every category|separate stages' tests/unified-pattern-recommendations.test.ts`

Expected: FAIL because the current selector filters nonpositive EV and the product type lacks staged probabilities.

- [ ] **Step 7: Implement staged probability and one-per-kind selection**

Extend `RollingPatternProduct` with these exact fields:

```ts
patternProbability: number;
legacySeedProbability: number;
legacySettledCount: number;
legacyHitCount: number;
learningSettledCount: number;
learningHitCount: number;
learningMissCount: number;
sourceKind: "ledger" | "derived_baseline";
derivedDefinitionHash: string;
```

Use a pure helper:

```ts
function posteriorFromHistory(
  prior: number,
  history: ProductHistoryCounts | undefined,
): number {
  if (!history || history.settledCount === 0) return prior;
  return (history.hitCount + prior * 4) / (history.settledCount + 4);
}
```

Sort all candidates by EV, learned sample count, support, strategy count, then ASCII `values.join("+")`; never apply an `expectedValue > 0` filter. Keep `selectRollingPatternRecommendations(products, scope)` as a compatibility wrapper over the same mandatory selector.

- [ ] **Step 8: Run all rolling-product tests and typecheck**

Run: `node --test tests/rolling-pattern-value.test.ts tests/unified-pattern-recommendations.test.ts && npm run typecheck`

Expected: PASS. Update the old “not recommended” assertions to verify a concrete negative-EV selection and risk wording.

Update `test:ai` in `package.json` so `tests/unified-pattern-recommendations.test.ts` is part of the default `npm test` contract.

- [ ] **Step 9: Commit the shared product core**

```bash
git add lib/rolling-pattern-types.ts lib/rolling-pattern-value.ts tests/rolling-pattern-value.test.ts tests/unified-pattern-recommendations.test.ts package.json
git commit -m "feat: unify mandatory pattern recommendation core"
```

### Task 2: Add the v2 rollout and committed revision ledger

**Files:**
- Modify: `lib/forward-learning-types.ts`
- Create: `lib/forward-learning-v2-store.ts`
- Modify: `lib/forward-learning-store.ts`
- Create: `drizzle/0011_unified_forward_learning.sql`
- Create: `tests/forward-learning-v2-store.test.ts`
- Modify: `tests/forward-learning-store.test.ts`
- Modify: `tests/sites-deployment.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: 357 `ForwardLearningCandidateV2` rows, five `ForwardLearningForecastV2` rows, verified draws, and an immutable per-game rollout.
- Produces:

```ts
export type ForwardLearningRollout = {
  game: GameId;
  firstUnifiedTargetIssue: string;
  legacySeedThroughIssue: string;
  seedQueryVersion: "legacy-target-cutoff-v1";
  sourceRunId: string;
  sourceDataHash: string;
  authoritativeRecommendationHash: string;
  createdAt: string;
};
export type ForwardLearningRevision = {
  revisionId: string;
  game: GameId;
  targetIssue: string;
  revision: number;
  status: "processing" | "committed";
  selectionPolicy: "rolling-product-ev-v2";
  sourceRunId: string;
  dataVersion: string;
  contentHash: string;
  reason: "initial" | "correct-v1-bootstrap";
  createdAt: string;
  committedAt: string | null;
};
export async function persistForwardLearningRollout(rollout: ForwardLearningRollout): Promise<"created" | "existing" | "conflict">;
export async function ensureForwardLearningV2Store(): Promise<void>;
export async function freezeForwardLearningRevision(snapshot: ForwardLearningRevisionSnapshot): Promise<"created" | "existing" | "conflict" | "unavailable">;
export async function readResolvedForwardSnapshot(game: GameId, issue?: string | null): Promise<ResolvedForwardSnapshot | null>;
export async function settleResolvedForwardSnapshot(game: GameId, draw: Draw, scoredAt: string): Promise<ResolvedSettlement>;
export async function readUnifiedCandidateHistory(game: GameId, beforeIssue: string): Promise<Map<string, ForwardResultHistory>>;
```

- [ ] **Step 1: Write failing schema and resolver tests**

Create a real-behavior fake D1 fixture and tests for these breaks:

```ts
test("an uncommitted revision never shadows the v1 snapshot", async () => {
  await seedV1Snapshot(db, v1FiveForecasts());
  await seedProcessingV2Revision(db, revision2Snapshot());
  const resolved = await store.readResolvedForwardSnapshot("new_macau", "2026231");
  assert.equal(resolved?.revision, 1);
  assert.equal(resolved?.source, "v1");
});

test("the highest committed revision is the only settlement source", async () => {
  await seedV1Snapshot(db, v1FiveForecasts());
  await store.freezeForwardLearningRevision(revision2Snapshot());
  const settled = await store.settleResolvedForwardSnapshot("new_macau", verifiedDraw("2026231"), "2026-08-19T14:00:00.000Z");
  assert.equal(settled.revision, 2);
  assert.equal(settled.scores.length, 357);
  assert.equal(settled.scores.filter((item) => item.official).length, 5);
  assert.ok(settled.scores.every((item) => item.candidateId.includes(":r2:")));
});

test("a committed revision rejects the same id with different content", async () => {
  assert.equal(await store.freezeForwardLearningRevision(revision2Snapshot()), "created");
  assert.equal(await store.freezeForwardLearningRevision(changedRevision2Snapshot()), "conflict");
});

test("a production database with only v1 tables repairs the complete v2 schema on first use", async () => {
  await seedSchemaThroughMigration0010(db);
  await store.ensureForwardLearningV2Store();
  assert.deepEqual(await readExpectedV2SchemaObjects(db), EXPECTED_V2_SCHEMA_OBJECTS);
});
```

- [ ] **Step 2: Run the v2 store tests and verify RED**

Run: `node --test tests/forward-learning-v2-store.test.ts`

Expected: FAIL because the v2 store and tables do not exist.

- [ ] **Step 3: Add the migration with explicit uniqueness**

Create `drizzle/0011_unified_forward_learning.sql` with these tables and constraints:

```sql
CREATE TABLE IF NOT EXISTS forward_learning_rollouts (
  game text PRIMARY KEY,
  first_unified_target_issue text NOT NULL,
  legacy_seed_through_issue text NOT NULL,
  seed_query_version text NOT NULL,
  rollout_json text NOT NULL,
  created_at text NOT NULL
);
CREATE TABLE IF NOT EXISTS forward_learning_revisions (
  revision_id text PRIMARY KEY,
  game text NOT NULL,
  target_issue text NOT NULL,
  revision integer NOT NULL,
  status text NOT NULL,
  content_hash text NOT NULL,
  revision_json text NOT NULL,
  created_at text NOT NULL,
  committed_at text
);
CREATE UNIQUE INDEX IF NOT EXISTS forward_learning_revision_identity_idx
  ON forward_learning_revisions (game, target_issue, revision);
CREATE TABLE IF NOT EXISTS forward_learning_revision_candidates (
  candidate_id text PRIMARY KEY,
  revision_id text NOT NULL,
  game text NOT NULL,
  target_issue text NOT NULL,
  revision integer NOT NULL,
  slot text NOT NULL,
  result_key text NOT NULL,
  candidate_json text NOT NULL,
  frozen_at text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS forward_learning_revision_candidate_result_idx
  ON forward_learning_revision_candidates (game, target_issue, revision, slot, result_key);
CREATE TABLE IF NOT EXISTS forward_learning_revision_forecasts (
  forecast_id text PRIMARY KEY,
  candidate_id text NOT NULL,
  revision_id text NOT NULL,
  game text NOT NULL,
  target_issue text NOT NULL,
  revision integer NOT NULL,
  slot text NOT NULL,
  result_key text NOT NULL,
  forecast_json text NOT NULL,
  frozen_at text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS forward_learning_revision_forecast_slot_idx
  ON forward_learning_revision_forecasts (game, target_issue, revision, slot);
CREATE TABLE IF NOT EXISTS forward_learning_revision_scores (
  score_id text PRIMARY KEY,
  forecast_id text,
  candidate_id text NOT NULL UNIQUE,
  revision_id text NOT NULL,
  game text NOT NULL,
  target_issue text NOT NULL,
  revision integer NOT NULL,
  slot text NOT NULL,
  result_key text NOT NULL,
  official integer NOT NULL,
  actual_matched integer NOT NULL,
  score_json text NOT NULL,
  scored_at text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS forward_learning_revision_score_result_idx
  ON forward_learning_revision_scores (game, target_issue, revision, slot, result_key);
CREATE UNIQUE INDEX IF NOT EXISTS forward_learning_revision_score_forecast_idx
  ON forward_learning_revision_scores (forecast_id) WHERE forecast_id IS NOT NULL;
```

- [ ] **Step 4: Implement the two-phase committed revision writer**

Use fixed canonical IDs and `INSERT OR IGNORE`. Validate 357 unique candidate identities and five unique official slots before writing. Insert processing manifest, candidate batches, forecast batch, query exact counts, then update only `status='processing'` to committed. A pre-existing committed row returns `existing` only when the stored content hash is equal; otherwise return `conflict`.

Implement `ensureForwardLearningV2Store()` with the same one-probe, named table-and-index integrity gate used by the hardened v1 stores. Every v2 reader and writer calls it. A database containing only migration 0010 must converge to all 0011 tables and indexes without a manual console step; an interrupted schema creation must replay `IF NOT EXISTS` DDL and fail closed if a uniqueness conflict prevents an index from being restored.

- [ ] **Step 5: Verify resolver tests turn GREEN**

Run: `node --test tests/forward-learning-v2-store.test.ts`

Expected: PASS for commit visibility, revision precedence, and conflict tests.

- [ ] **Step 6: Write failing idempotent score and rollout tests**

```ts
test("settlement retry cannot duplicate any candidate or official score", async () => {
  await store.freezeForwardLearningRevision(revision1Snapshot());
  const first = await store.settleResolvedForwardSnapshot("new_macau", verifiedDraw("2026232"), scoredAt);
  const second = await store.settleResolvedForwardSnapshot("new_macau", verifiedDraw("2026232"), laterScoredAt);
  assert.equal(first.status, "settled");
  assert.equal(second.status, "existing");
  assert.equal(await db.count("forward_learning_revision_scores"), 357);
  assert.equal(first.scores.filter((item) => item.official).length, 5);
});

test("a rollout cutoff is immutable per game", async () => {
  assert.equal(await store.persistForwardLearningRollout(newMacauRollout()), "created");
  assert.equal(await store.persistForwardLearningRollout(newMacauRollout()), "existing");
  assert.equal(await store.persistForwardLearningRollout({ ...newMacauRollout(), firstUnifiedTargetIssue: "2026232" }), "conflict");
});

test("partial settlement is repaired without changing already frozen scores", async () => {
  await store.freezeForwardLearningRevision(revision1Snapshot());
  await seedFirstRevisionScores(db, { count: 37, scoredAt: originalScoredAt });
  const repaired = await store.settleResolvedForwardSnapshot("new_macau", verifiedDraw("2026232"), laterScoredAt);
  assert.equal(repaired.status, "repaired");
  assert.equal(await db.count("forward_learning_revision_scores"), 357);
  assert.equal(await readScore(db, firstCandidateId).scoredAt, originalScoredAt);
  const existing = await store.settleResolvedForwardSnapshot("new_macau", verifiedDraw("2026232"), newestScoredAt);
  assert.equal(existing.status, "existing");
});

test("candidate history counts only the highest committed revision for each issue", async () => {
  await seedTwoCommittedScoredRevisionsForOneIssue(db);
  const history = await store.readUnifiedCandidateHistory("new_macau", "2026233");
  assert.equal(history.get("coverage_zodiac:猴")?.settledCount, 1);
});
```

- [ ] **Step 7: Implement v2 settlement, history aggregation, and compatibility wrappers**

Score only the resolved committed revision. Persist the frozen learned probability, baseline, Brier, baseline Brier, log-loss, baseline log-loss, actual draw, and timestamp. A partial score batch is repaired with deterministic IDs and `INSERT OR IGNORE`; existing score bytes and `scoredAt` remain unchanged. `readUnifiedCandidateHistory` must first resolve `MAX(revision)` among committed revisions for every `(game,target_issue)`, join scores only to those resolved revisions, and then include only issues lexically/numerically before `beforeIssue`. Update the existing forecast/candidate read wrappers to prefer v2 resolution and fall back to v1 only when no committed v2 revision exists.

- [ ] **Step 8: Run store, migration, and type verification**

Run: `node --test tests/forward-learning-store.test.ts tests/forward-learning-v2-store.test.ts tests/sites-deployment.test.mjs && npm run typecheck`

Expected: PASS and deployment test recognizes migration `0011_unified_forward_learning.sql`.

Update `test:ai` in `package.json` so `tests/forward-learning-v2-store.test.ts` is included in `npm test`.

- [ ] **Step 9: Commit the versioned ledger**

```bash
git add lib/forward-learning-types.ts lib/forward-learning-v2-store.ts lib/forward-learning-store.ts drizzle/0011_unified_forward_learning.sql tests/forward-learning-v2-store.test.ts tests/forward-learning-store.test.ts tests/sites-deployment.test.mjs package.json
git commit -m "feat: add committed forward learning revisions"
```

### Task 3: Map shared products into the learning cycle and correct 2026231

**Files:**
- Create: `lib/forward-learning-rollouts.ts`
- Create: `lib/unified-product-learning.ts`
- Modify: `lib/forward-learning-service.ts`
- Modify: `lib/forward-learning-engine.ts`
- Modify: `lib/rolling-pattern-store.ts:108-175,320-379`
- Create: `tests/unified-product-learning.test.ts`
- Modify: `tests/forward-learning-service.test.ts`
- Modify: `tests/rolling-pattern-store.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: resolved rolling run, immutable rollout cutoff, legacy aggregate before cutoff, committed v2 candidate history before target issue, and any previous official forecasts.
- Produces:

```ts
export const NEW_MACAU_2026231_ROLLOUT: ForwardLearningRollout;
export const NEW_MACAU_2026231_AUTHORITATIVE_HASH = "cd1e2e83347869be0943420d92ba7af3cd6317bd20d6b1a7cfceeadfb4d78608";
export function canonicalRecommendationPayload(recommendations: readonly AuthoritativeRecommendation[]): string;
export function canonicalRevisionPayload(snapshot: ForwardLearningRevisionSnapshot): string;
export function canCorrectV1Bootstrap(input: V1BootstrapCorrectionInput): CorrectionGateResult;
export function mapProductsToRevisionSnapshot(input: {
  run: RollingPatternRun;
  products: readonly RollingPatternProduct[];
  recommendations: readonly AuthoritativeRecommendation[];
  rollout: ForwardLearningRollout;
  revision: number;
  reason: "initial" | "correct-v1-bootstrap";
  previousForecasts?: readonly ForwardLearningForecast[];
}): ForwardLearningRevisionSnapshot;
```

- [ ] **Step 1: Write the failing 2026231 authoritative snapshot test**

Use a checked-in literal five-product fixture with the values from design section 12 and assert:

```ts
test("the first unified revision freezes the authoritative 2026231 five", () => {
  const snapshot = mapProductsToRevisionSnapshot(authoritativeRunAndProductsFixture());
  assert.equal(snapshot.candidates.length, 357);
  assert.deepEqual(snapshot.forecasts.map((item) => item.resultKey), [
    "猴", "8尾", "蛇+猴", "蛇+马+猴", "01",
  ]);
  assert.equal(snapshot.recommendationHash, NEW_MACAU_2026231_AUTHORITATIVE_HASH);
  assert.ok(snapshot.forecasts.every((item) => item.revision === 2));
  assert.ok(snapshot.forecasts.every((item) => item.learningSettledCount === 0));
  assert.equal(sha256(canonicalRecommendationPayload(snapshot.recommendations)), NEW_MACAU_2026231_AUTHORITATIVE_HASH);
  assert.notEqual(snapshot.contentHash, snapshot.recommendationHash);
  assert.ok(snapshot.candidates.every((item) => item.candidateId.startsWith(`candidate:unified-v2:${snapshot.revisionId}:`)));
});
```

The production change this catches is using v1 probability-first output or importing the legacy 9 rows as official v2 samples.

- [ ] **Step 2: Run the mapper test and verify RED**

Run: `node --test tests/unified-product-learning.test.ts`

Expected: FAIL because the v2 mapper and rollout constant do not exist.

- [ ] **Step 3: Implement the product-to-forecast mapper**

Map every frozen product to a v2 candidate without recomputing probability. Official forecasts copy the authoritative recommendation fields exactly and add forecast IDs, previous-result comparison, top alternative by the same EV comparator, and structured explanation. Set `selectionPolicy="rolling-product-ev-v2"`; do not call v1 `selectOfficialForecasts()`.

Use these canonical identities verbatim:

```ts
candidateId = `candidate:unified-v2:${revisionId}:${slot}:${resultKey}`;
forecastId = `forecast:${candidateId}`;
scoreId = `score:${candidateId}`;
```

Every candidate and forecast freezes `revisionId`, `sourceRunId`, nullable `sourceProductId`, `sourceKind`, and `derivedDefinitionHash`. `canonicalRecommendationPayload()` sorts the five authority projections in fixed slot order and serializes a fixed field list. `canonicalRevisionPayload()` independently sorts all 357 candidates by slot and `resultKey`, then appends the five forecasts and rollout identity. `recommendationHash` hashes the former; `contentHash` hashes the latter. Never hash arbitrary object insertion order.

- [ ] **Step 4: Verify the 2026231 mapper test turns GREEN**

Run: `node --test tests/unified-product-learning.test.ts`

Expected: PASS for the authoritative five and hash.

- [ ] **Step 5: Write failing cycle tests for bootstrap correction and next-issue learning**

Add two service tests:

```ts
test("an unscored v1 bootstrap is corrected append-only before draw", async () => {
  const dependencies = correctionDependencies();
  const result = await runForwardLearningCycle(correctionInput(), dependencies);
  assert.equal(result.status, "created");
  assert.equal(result.revision, 2);
  assert.deepEqual(result.forecasts.map((item) => item.resultKey), ["猴", "8尾", "蛇+猴", "蛇+马+猴", "01"]);
  assert.equal(dependencies.deleteCalls, 0);
});

test("the next issue uses current p30 plus exactly one v2 settlement", async () => {
  const dependencies = learnedDependencies();
  const result = await runForwardLearningCycle(nextIssueInput(), dependencies);
  const monkey = result.forecasts.find((item) => item.resultKey === "猴");
  assert.equal(monkey?.learningSettledCount, 1);
  assert.equal(dependencies.legacyQueryCutoff, "2026231");
  assert.equal(dependencies.v2HistoryReadCount, 1);
});

test("the 2026231 correction hard gate rejects every provenance mismatch", () => {
  for (const changed of correctionMismatchFixtures()) {
    const gate = canCorrectV1Bootstrap(changed);
    assert.equal(gate.allowed, false, changed.name);
  }
});

test("a missing rollout never falls back to an unbounded legacy query", async () => {
  const dependencies = dependenciesWithoutRollout();
  const result = await runForwardLearningCycle(firstV2Input(), dependencies);
  assert.equal(result.status, "awaiting_rollout");
  assert.equal(dependencies.legacyQueryCount, 0);
});
```

- [ ] **Step 6: Run cycle tests and verify RED**

Run: `node --test --test-name-pattern='corrected append-only|exactly one v2' tests/forward-learning-service.test.ts`

Expected: FAIL because the current cycle returns existing v1 and updates three-expert model state.

- [ ] **Step 7: Replace the v1 selection path with the shared product cycle**

In `runStoredForwardLearningCycle`, load the immutable completed `RollingPatternRun` and its signals, rollout manifest, legacy aggregate bounded by rollout cutoff, optional legacy product identities, and committed v2 history. Build all v2 products directly with `buildUnifiedRollingPatternProducts`; never source v2 candidate values or ranking from the old `rolling_pattern_consensus_ledger`, whose special-number universe is incomplete and whose rows are immutable v1 audit data. In `runForwardLearningCycle`:

1. settle the prior resolved v2 revision when a matching verified draw exists;
2. complete the idempotent run;
3. if the current target has v1 only, evaluate `canCorrectV1Bootstrap()` and build revision 2 only when every hard condition matches;
4. otherwise build revision 1 for a new target;
5. return exactly five forecasts from the committed revision.

Retire v1 expert weight and rule-weight updates from v2 execution; retain the old functions only for decoding/auditing v1 rows.

The checked-in correction gate remains pinned to `game=new_macau` and `targetIssue=rollout.firstUnifiedTargetIssue=2026231`. It requires: the exact rollout/source run/data hash/expected draw/recommendation hash from the checked-in fixture; exactly 357 v1 candidates and five unique v1 official slots; no score for any v1 or v2 candidate; no verified matching draw; server wall clock `< expectedDrawAt`; and an unchanged immutable rollout. Any mismatch fails closed without creating a revision.

A deployment-transition race has one additional append-only path: when a cycle enters with no rollout at all but the current target was already frozen by v1 before the v2 deployment, that current target may become the dynamic first unified target and receive revision 2. The gate requires the exact 12/10/66/220/49 v1 universe, canonical `${runId}:${slot}:${resultKey}` IDs, five official slots, matching game/target/dataVersion/frozenAt, zero v1/v2 scores, no verified target draw, no existing v2 history, and server wall clock before the immutable run deadline. Persist the dynamic rollout only after this gate passes. A backdated signed `asOf` cannot reopen the window. Once any earlier rollout exists, later v1-only targets are never upgraded by this path; they return an explicit `awaiting_unified_target` instead of a false v2 success.

- [ ] **Step 8: Bound legacy history and freeze the full shared revision snapshot**

Persist or verify the immutable rollout before any legacy query or v2 product construction. For the 2026231 correction, insert the checked-in rollout first and reject conflicts. For a game entering v2 later, derive the first rollout once from that immutable completed run (`firstUnifiedTargetIssue=run.targetIssue`, `legacySeedThroughIssue=run.sourceIssue`) and persist it before reading history; retries must read the stored cutoff rather than infer a new one.

Aggregate legacy rows with `product.target_issue < rollout.firstUnifiedTargetIssue`; aggregate learned rows only from highest committed v2 revision scores before the new target. Build all 357 products with `buildUnifiedRollingPatternProducts`, rank them once, and freeze them in `forward_learning_revision_candidates`. Do not update or reinterpret existing `rolling_pattern_consensus_ledger` rows. The old consensus settlement may continue for audit/ROI but cannot feed v2 probability after cutoff.

- [ ] **Step 9: Run service/store integration and typecheck**

Run: `node --test tests/unified-product-learning.test.ts tests/forward-learning-service.test.ts tests/rolling-pattern-store.test.ts && npm run typecheck`

Expected: PASS.

Update `test:ai` in `package.json` so `tests/unified-product-learning.test.ts` is included in `npm test`.

- [ ] **Step 10: Commit the unified cycle**

```bash
git add lib/forward-learning-rollouts.ts lib/unified-product-learning.ts lib/forward-learning-service.ts lib/forward-learning-engine.ts lib/rolling-pattern-store.ts tests/unified-product-learning.test.ts tests/forward-learning-service.test.ts tests/rolling-pattern-store.test.ts package.json
git commit -m "feat: drive forward learning from frozen pattern products"
```

### Task 4: Make both APIs and pages render the same five decisions

**Files:**
- Modify: `app/api/research/patterns/route.ts`
- Modify: `app/api/learning/forecast/route.ts`
- Modify: `app/api/learning/model/route.ts`
- Modify: `app/api/learning/reviews/route.ts`
- Modify: `app/api/learning/performance/route.ts`
- Modify: `app/patterns/RollingPatternWorkspace.tsx`
- Modify: `app/learning/ForwardLearningWorkspace.tsx`
- Modify: `app/globals.css`
- Modify: `tests/forward-learning-api.test.ts`
- Modify: `tests/forward-learning-ui.test.ts`
- Modify: `tests/rendered-html.test.mjs`

**Interfaces:**
- `/api/research/patterns` always produces the complete canonical five-item `recommendations: AuthoritativeRecommendation[]`, selected on the server from the resolved revision. The requested scope filters only signals and value-analysis rows.
- `/api/learning/forecast` produces the same five recommendation fields inside `forecasts` plus official IDs/explanations.
- `/api/learning/model` produces `{ game, learning: ProductLearningSlotStatus[] }`, where each slot status contains settled candidates, official samples, latest adjustment points, and learned-through issue.

- [ ] **Step 1: Write failing API equality tests**

```ts
test("patterns and learning expose the same authoritative recommendation fields", async () => {
  const patterns = await getPatterns(patternsRequest("new_macau"));
  const learning = await getLearning(learningRequest("new_macau"));
  assert.deepEqual(
    projectRecommendations(learning.forecasts),
    projectRecommendations(patterns.recommendations),
  );
});

test("reviews expose only five official scores from the resolved revision", async () => {
  const payload = await getReviews(reviewsRequest("new_macau"));
  assert.equal(payload.reviews[0].scores.length, 5);
  assert.ok(payload.reviews[0].scores.every((item) => item.official));
  assert.equal(payload.reviews[0].run.revision, 2);
});

test("reviews and performance exclude v1 and lower committed revisions", async () => {
  await seedV1ScoresAndTwoCommittedV2Revisions();
  const reviews = await getReviews(reviewsRequest("new_macau"));
  const performance = await getPerformance(performanceRequest("new_macau"));
  assert.equal(reviews.reviews[0].run.revision, 2);
  assert.equal(reviews.reviews[0].scores.length, 5);
  assert.equal(performance.officialSettledCount, 5);
  assert.ok(performance.slots.every((item) => item.revisionSource === "resolved-v2"));
});
```

- [ ] **Step 2: Run API tests and verify RED**

Run: `node --test tests/forward-learning-api.test.ts`

Expected: FAIL because patterns has no authoritative server recommendations and learning uses v1 fields.

- [ ] **Step 3: Implement server-authoritative API payloads**

Read `readResolvedProductRecommendations` once per request. Return all five recommendation rows in canonical category order regardless of the patterns `scope`. Reject mixed target issues/revisions with HTTP 503 instead of returning partial data. Preserve `private,no-store`.

Implement resolved-v2 review and performance readers. They must project only five `official=1` scores from the highest committed revision of each issue. Full 357-candidate scoring remains an internal learning diagnostic and never appears as the public `reviews[].scores` or official KPI denominator. v1 rows and lower committed revisions remain audit-only.

- [ ] **Step 4: Verify API tests turn GREEN**

Run: `node --test tests/forward-learning-api.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing UI copy and mandatory-card tests**

Assert rendered markup contains five concrete recommendation labels and these phrases:

```ts
assert.match(html, /与近30期购买参考同源/);
assert.match(html, /赔率参与排序/);
assert.doesNotMatch(html, /本期不推荐/);
assert.doesNotMatch(html, /赔率不参与模型排序/);
assert.doesNotMatch(html, /THREE EXPERTS/);
```

Also assert a negative-EV fixture still renders its result, negative value, and “低于盈亏平衡线” explanation.

- [ ] **Step 6: Run UI tests and verify RED**

Run: `node --test tests/forward-learning-ui.test.ts tests/rendered-html.test.mjs`

Expected: FAIL on current copy and expert-weight UI.

- [ ] **Step 7: Update both pages**

Pass `recommendations` from the patterns API directly into `PurchaseRecommendationPanel`; remove client reselection and null cards. Change copy to state that one item is always shown and negative EV is still possible. On `/learning`, render probability, baseline, odds, break-even, EV, current30 support/hits, and new learning settled/hits. Replace the three-expert and rule-weight boards with a product-learning status board; retain official review and Brier performance sections.

- [ ] **Step 8: Run UI, API, accessibility-oriented render, and type tests**

Run: `node --test tests/forward-learning-api.test.ts tests/forward-learning-ui.test.ts tests/rendered-html.test.mjs && npm run typecheck`

Expected: PASS.

- [ ] **Step 9: Commit the unified user experience**

```bash
git add app/api/research/patterns/route.ts app/api/learning/forecast/route.ts app/api/learning/model/route.ts app/api/learning/reviews/route.ts app/api/learning/performance/route.ts app/patterns/RollingPatternWorkspace.tsx app/learning/ForwardLearningWorkspace.tsx app/globals.css tests/forward-learning-api.test.ts tests/forward-learning-ui.test.ts tests/rendered-html.test.mjs
git commit -m "feat: show one shared recommendation set on both pages"
```

### Task 5: Align automation gates and health checks with resolved v2 revisions

**Files:**
- Modify: `research/src/marksix_research/cli.py`
- Modify: `research/tests/test_pipeline.py`
- Modify: `.github/workflows/research-v2.yml`

**Interfaces:**
- `capture_forward_learning()` continues to require five unique official slots and additionally validates one shared target issue, revision, `selectionPolicy="rolling-product-ev-v2"`, and the canonical recommendation fields.
- `verify_production_health()` compares `/patterns.recommendations` with `/learning.forecasts`, requires five official prior scores for a settled v2 issue, and no longer requires five expert model states.
- `check_update_required()` requests repair when the latest complete pattern run lacks a committed matching v2 revision.

- [ ] **Step 1: Write failing automation tests**

Add fixtures and assertions:

```py
def test_health_rejects_patterns_learning_recommendation_drift(self):
    responses = self._v2_health_responses()
    responses.patterns["recommendations"][0]["resultKey"] = "猴"
    responses.learning["forecasts"][0]["resultKey"] = "马"
    with patch.object(cli, "fetch_json", side_effect=responses.sequence):
        with self.assertRaisesRegex(RuntimeError, "recommendation mismatch"):
            cli.verify_production_health("https://example.test", "new_macau")

def test_health_accepts_a_complete_revision_without_expert_model_states(self):
    responses = self._v2_health_responses(models=[])
    with patch.object(cli, "fetch_json", side_effect=responses.sequence):
        result = cli.verify_production_health("https://example.test", "new_macau")
    self.assertEqual(result["revision"], 2)

def test_update_gate_repairs_a_v1_only_target(self):
    responses = self._v1_only_target_responses()
    with patch.object(cli, "fetch_json", side_effect=responses.sequence):
        result = cli.check_update_required("https://example.test", "new_macau")
    self.assertTrue(result["shouldRun"])
    self.assertEqual(result["reason"], "unified_revision_repair_required")
```

- [ ] **Step 2: Run Python tests and verify RED**

Run: `PYTHONPATH=research/src python3 -m unittest research.tests.test_pipeline -v`

Expected: FAIL because current health checks do not compare the shared recommendation fields and require model-after states.

- [ ] **Step 3: Implement v2 validation and repair gates**

Compare exactly `kind/resultKey/values/sourceRunId/dataVersion/revision/p30/legacySeedProbability/learnedProbability/netOdds/breakEvenProbability/expectedValue` using the complete five-item recommendations returned by any patterns scope. Require five canonical slots and five official prior scores from the resolved highest committed revision. Keep the existing patterns-first guard so HK cannot be mislabeled as healthy when an internal pattern run exists but forecast is missing. Keep retryable HTTP statuses visible.

Preserve the actual production workflow in `.github/workflows/research-v2.yml`: the two-game matrix, `set -o pipefail`, primary signed cycle, separate signed forward cycle, and final health check. Only update its payload validation/repair semantics; do not create or target a similarly named workflow file.

- [ ] **Step 4: Run automation tests and workflow syntax checks**

Run: `PYTHONPATH=research/src python3 -m unittest discover -s research/tests -v`

Expected: PASS.

Run: `node --test tests/sites-deployment.test.mjs`

Expected: PASS and workflow still invokes cycle followed by health.

- [ ] **Step 5: Commit automation alignment**

```bash
git add research/src/marksix_research/cli.py research/tests/test_pipeline.py .github/workflows/research-v2.yml
git commit -m "fix: verify unified recommendation revisions in automation"
```

### Task 6: Full verification, publish, repair the live first issue, and audit production

**Files:**
- Modify only if verification exposes a defect in files already named above.
- Package: Sites deployment archive generated outside git.

**Interfaces:**
- Consumes the exact committed branch head and Sites project from `.openai/hosting.json`.
- Produces one deployed version, one idempotent v2 correction for new_macau 2026231, and evidence that both live pages resolve the same five decisions.

- [ ] **Step 1: Run focused mutation-sensitive regression tests**

Run:

```bash
node --test \
  tests/rolling-pattern-value.test.ts \
  tests/unified-pattern-recommendations.test.ts \
  tests/forward-learning-store.test.ts \
  tests/forward-learning-v2-store.test.ts \
  tests/unified-product-learning.test.ts \
  tests/forward-learning-service.test.ts \
  tests/forward-learning-api.test.ts \
  tests/forward-learning-ui.test.ts
```

Expected: PASS with zero failures.

- [ ] **Step 2: Run the complete repository verification**

Run: `npm test`

Expected: typecheck, all Node AI tests, all Python research tests, production build, deployment contract tests, and rendered HTML tests pass with exit code 0.

Run: `git diff --check && git status --short`

Expected: no whitespace errors and only intentional committed changes.

- [ ] **Step 3: Commit any final verified correction**

If verification required a code correction, return to the owning task, repeat its exact RED/GREEN command, stage only the explicit file list from that task's `git add` command, and commit with `fix: complete unified recommendation verification`.

If no correction was required, create no empty commit.

- [ ] **Step 4: Push the exact verified branch head**

Push `codex/cloudflare-free-deploy` to its existing upstream. Record the pushed branch-head SHA and use only that SHA for publishing and workflow dispatch.

- [ ] **Step 5: Publish the exact verified source with Sites**

Use the existing Sites project ID in `.openai/hosting.json`. Follow the installed `sites:sites-hosting` skill's current packaging and version-save flow for this project, reuse the successful build, save one version for the exact branch-head SHA, deploy it, and poll until status is `succeeded`. Do not assume a repository-local packaging helper exists, and do not run a second deployment for the same source.

- [ ] **Step 6: Recheck the live correction safety gate**

Before dispatching the correction, fetch the verified draw for `new_macau` issue `2026231`, the resolved revision scores, and the server clock relative to `expectedDrawAt=2026-08-19T13:32:00.000Z`. Continue with revision 2 only when the issue is still unverified, no v1 or v2 score exists, and the draw deadline has not passed. If any condition fails, do not rewrite or backfill 2026231; preserve v1 for audit and start unified v2 at the next target issue.

- [ ] **Step 7: Trigger the existing signed cycle once**

Run the existing `Research v3 settle, learn and freeze` workflow for `new_macau`. The v2 cycle must see unscored v1 target 2026231, create committed revision 2, and return five forecasts. Do not delete or edit revision 1.

- [ ] **Step 8: Verify the live correction and equality**

Fetch:

```text
/api/research/patterns?game=new_macau&scope=coverage_6_plus_1&page=1
/api/research/patterns?game=new_macau&scope=special&page=1
/api/learning/forecast?game=new_macau&issue=2026231
/api/learning/reviews?game=new_macau&limit=30
/api/learning/performance?game=new_macau
```

Assert, using the complete five-item `recommendations` array returned by either patterns scope:

```text
revision = 2
results = 猴 | 8尾 | 蛇+猴 | 蛇+马+猴 | 01
five shared recommendation projections are byte-for-byte equal
official settled samples = 0 before the 2026231 draw
no v1 row was deleted or scored
```

- [ ] **Step 9: Run live health for both games**

Run the production health command for `new_macau` and `hk`.

Expected: new_macau reports a healthy committed five-slot revision; HK reports the explicit pattern-window waiting/degraded state and does not fabricate forecasts.
