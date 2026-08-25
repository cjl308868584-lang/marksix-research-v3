# Full-Period Prediction Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist and display every period's frozen pattern predictions with immutable post-draw correctness, while removing the legacy rolling settlement panel.

**Architecture:** Add one compact immutable snapshot row and one immutable settlement row per rolling-pattern run, derived from the existing source ledgers. Serve a cursor-paginated history index and lazy-loaded issue detail, and cursor-paginate the already persisted five-slot learning reviews.

**Tech Stack:** TypeScript 5.9, React 19, Vinext/Next route handlers, Cloudflare D1/SQLite, Drizzle schema, Node test runner.

**Spec:** `docs/superpowers/specs/2026-08-25-full-period-prediction-review-design.md`

## Global Constraints

- The legacy `逐期汇总结算` section must be removed completely.
- Public GET routes are read-only and use `Cache-Control: private, no-store`.
- Patterns recommendations remain original frozen 30-period recommendations and never consume learned `/learning` forecasts.
- Every verified settlement is append-only and idempotent with `INSERT OR IGNORE`.
- History uses a 20-period issue cursor; no unbounded page read and no OFFSET pagination.
- Only cross-source verified draws may settle a snapshot.
- Existing immutable rolling-pattern tables remain the audit source for backfill and fallback reconstruction.

---

### Task 1: Pure review snapshot and settlement model

**Files:**
- Create: `lib/rolling-pattern-review.ts`
- Modify: `lib/rolling-pattern-types.ts`
- Create: `tests/rolling-pattern-review.test.ts`

**Interfaces:**
- Consumes: `selectRollingPatternView`, `buildSpecialNumberConsensus`, `selectMandatoryProductRecommendations`, `evaluateRollingResultEvent`, `settleRollingPatternProduct`.
- Produces: `buildRollingPatternReviewSnapshot(run, products)`, `settleRollingPatternReviewSnapshot(snapshot, draw, scoredAt)`, `RollingPatternReviewSnapshot`, `RollingPatternReviewScore`, and `RollingPatternReviewRecord`.

- [ ] **Step 1: Write failing snapshot tests**

Create literal fixtures for one coverage zodiac result, one coverage tail result, one special result and two special-number intersections. Assert that the snapshot contains exactly five purchase items, separate coverage/special summaries, and an ordered top-15 list that preserves frozen evidence.

```ts
const snapshot = buildRollingPatternReviewSnapshot(run, products);
assert.equal(snapshot.purchases.length, 5);
assert.deepEqual(snapshot.coverage.resultGroups.map((item) => item.label), ["猴", "8尾"]);
assert.deepEqual(snapshot.specialNumbers.map((item) => item.number), [11, 16]);
```

- [ ] **Step 2: Run the new test and verify RED**

Run: `node --test tests/rolling-pattern-review.test.ts`

Expected: FAIL because `lib/rolling-pattern-review.ts` and exported review types do not exist.

- [ ] **Step 3: Implement the immutable review types and builder**

Define explicit JSON-safe types. Preserve the exact `AuthoritativeRecommendation`, `RollingPatternSummary`, event definitions used by result groups, and `SpecialNumberConsensus` rows.

```ts
export type RollingPatternReviewSnapshot = {
  runId: string;
  game: GameId;
  targetIssue: string;
  frozenAt: string;
  purchases: AuthoritativeRecommendation[];
  coverage: RollingPatternReviewScopeSnapshot;
  special: RollingPatternReviewScopeSnapshot;
  specialNumbers: SpecialNumberConsensus[];
};
```

- [ ] **Step 4: Write failing settlement tests**

Assert purchase, result-B and special-number outcomes independently. Include a draw where exactly one special-number candidate wins and an unverified draw that is rejected.

```ts
const score = settleRollingPatternReviewSnapshot(snapshot, verifiedDraw, "2026-08-25T14:00:00.000Z");
assert.equal(score.actualSpecial, 11);
assert.deepEqual(score.specialNumbers.map((item) => item.actualMatched), [true, false]);
assert.throws(() => settleRollingPatternReviewSnapshot(snapshot, unverifiedDraw, now));
```

- [ ] **Step 5: Verify settlement RED, implement, then verify GREEN**

Run before implementation: `node --test tests/rolling-pattern-review.test.ts`

Expected: FAIL because settlement is missing.

Implement exact event and product settlement using the frozen event/product definitions. Then run the same command and expect all tests PASS.

- [ ] **Step 6: Commit the pure model**

```bash
git add lib/rolling-pattern-review.ts lib/rolling-pattern-types.ts tests/rolling-pattern-review.test.ts
git commit -m "feat: model immutable period reviews"
```

### Task 2: D1 schema, persistence, backfill and cursor reads

**Files:**
- Modify: `db/schema.ts`
- Modify: `lib/research-v3-store.ts`
- Create: `drizzle/0012_prediction_review.sql`
- Modify: `lib/rolling-pattern-store.ts`
- Modify: `tests/rolling-pattern-store.test.ts`
- Modify: `tests/sites-deployment.test.mjs`

**Interfaces:**
- Consumes: Task 1 snapshot/score builders.
- Produces: `readRollingPatternReviewIndex(game, limit, beforeIssue)`, `readRollingPatternReview(game, issue)`, automatic freeze persistence, signed-cycle backfill, and settlement persistence.

- [ ] **Step 1: Write failing schema and store tests**

Add deployment assertions for both tables and unique identities. Add store tests proving one snapshot per issue, one settlement per issue, immutable retry behavior, newest-first cursor pagination, and recovery of a legacy completed run without a snapshot.

```ts
assert.deepEqual(page.items.map((item) => item.targetIssue), ["2026237", "2026236"]);
assert.equal(page.nextCursor, "2026236");
assert.equal(await persistReviewSnapshot(snapshot), "existing");
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --test tests/rolling-pattern-store.test.ts && npm run test:deployment`

Expected: FAIL because review tables and store APIs are absent.

- [ ] **Step 3: Add schema and migration**

Add `rolling_pattern_review_snapshots` and `rolling_pattern_review_scores` to Drizzle and runtime schema. Each table uses `run_id` as primary key and a unique `(game, target_issue)` index. Add the cursor read index on `(game, target_issue)` only when it is not redundant with the unique index.

```sql
CREATE TABLE `rolling_pattern_review_snapshots` (
  `run_id` text PRIMARY KEY NOT NULL,
  `game` text NOT NULL,
  `target_issue` text NOT NULL,
  `snapshot_json` text NOT NULL,
  `frozen_at` text NOT NULL
);
CREATE UNIQUE INDEX `rolling_pattern_review_snapshot_issue_idx`
ON `rolling_pattern_review_snapshots` (`game`,`target_issue`);
```

- [ ] **Step 4: Persist current and backfilled snapshots**

Change `persistRollingPatternProducts` to return the frozen products it inserts or finds. During `persistRollingPatternRun`, build and insert the review snapshot before marking the run complete. During signed settlement, select at most 50 completed runs without snapshots, load their frozen signals/products, and batch `INSERT OR IGNORE` review snapshots.

- [ ] **Step 5: Persist verified settlements**

After snapshot backfill, select unscored snapshots and match only verified draws from the supplied draw set. Build scores with Task 1 and batch insert them with `INSERT OR IGNORE`.

- [ ] **Step 6: Implement compact cursor reads and fallback reconstruction**

The index reads `limit + 1` rows from review snapshots plus completed legacy runs, deduplicates by target issue, and returns `nextCursor`. Detail prefers the compact snapshot/score pair; if the snapshot is absent, it loads that issue's existing run/signals/products/scores and reconstructs without writing.

- [ ] **Step 7: Run focused tests and verify GREEN**

Run: `node --test tests/rolling-pattern-review.test.ts tests/rolling-pattern-store.test.ts && npm run test:deployment`

Expected: PASS with no failed tests.

- [ ] **Step 8: Commit persistence**

```bash
git add db/schema.ts lib/research-v3-store.ts drizzle/0012_prediction_review.sql lib/rolling-pattern-store.ts tests/rolling-pattern-store.test.ts tests/sites-deployment.test.mjs
git commit -m "feat: persist full period review snapshots"
```

### Task 3: Read-only patterns review API

**Files:**
- Create: `app/api/research/patterns/reviews/route.ts`
- Modify: `tests/forward-learning-api.test.ts`

**Interfaces:**
- Consumes: Task 2 review index/detail readers.
- Produces: `GET /api/research/patterns/reviews` index and detail modes.

- [ ] **Step 1: Write failing route tests**

Test index mode, issue-detail mode, cursor validation, unknown parameter rejection, unavailable issue 404, and `private, no-store` headers. Verify the GET source does not import or call settlement/freeze functions.

- [ ] **Step 2: Run route tests and verify RED**

Run: `node --test tests/forward-learning-api.test.ts`

Expected: FAIL because the reviews route does not exist.

- [ ] **Step 3: Implement strict read-only route**

Accept exactly `game`, `limit`, `before`, and `issue`. Reject `before` together with `issue`; validate issue strings with `/^\d{4,16}$/`; clamp requested limit to 1–50. Return `{ game, items, nextCursor }` for index or `{ game, review }` for detail.

- [ ] **Step 4: Verify route GREEN and commit**

Run: `node --test tests/forward-learning-api.test.ts`

Expected: PASS.

```bash
git add app/api/research/patterns/reviews/route.ts tests/forward-learning-api.test.ts
git commit -m "feat: expose immutable pattern review history"
```

### Task 4: Replace the legacy patterns history panel

**Files:**
- Modify: `app/api/research/patterns/route.ts`
- Modify: `app/patterns/RollingPatternWorkspace.tsx`
- Modify: `app/globals.css`
- Modify: `tests/rendered-html.test.mjs`

**Interfaces:**
- Consumes: Task 3 API contracts.
- Produces: lazy `PatternReviewArchive`, issue cursor loading, three review sections, and no legacy `SettlementHistoryPanel`.

- [ ] **Step 1: Write failing rendered/UI tests**

Assert that `逐期汇总结算` is absent and `逐期预测复盘`, `五项购买参考`, `结果 B 支持复盘`, and `特码号码交集前15复盘` are present. Assert the main patterns API no longer reads or returns `settlementHistory`.

- [ ] **Step 2: Run rendered test and verify RED**

Run: `node --test tests/rendered-html.test.mjs`

Expected: FAIL because the legacy panel remains and the archive is missing.

- [ ] **Step 3: Remove legacy API and component**

Delete `readRollingPatternValueHistory` from the main route and remove `settlementHistory` from its payload/type. Delete `SettlementHistoryPanel` and its render call completely.

- [ ] **Step 4: Implement lazy archive UI**

Load the first 20 issue headers after the current page data succeeds. Only fetch `/api/research/patterns/reviews?game=...&issue=...` when an issue is expanded. Render pending/hit/miss badges, actual draw, the five purchases, two result-B scope tabs, and the special top15. Add a cursor “加载更早期数” button.

- [ ] **Step 5: Add responsive styling and verify GREEN**

Reuse existing gold/green/red tokens. Keep single-column cards on mobile and two/three-column grids at desktop widths.

Run: `node --test tests/rendered-html.test.mjs && npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit patterns UI**

```bash
git add app/api/research/patterns/route.ts app/patterns/RollingPatternWorkspace.tsx app/globals.css tests/rendered-html.test.mjs
git commit -m "feat: replace rolling settlement with full review archive"
```

### Task 5: Show every learning settlement with cursor pagination

**Files:**
- Modify: `lib/forward-learning-store.ts`
- Modify: `app/api/learning/reviews/route.ts`
- Modify: `app/learning/ForwardLearningWorkspace.tsx`
- Modify: `app/globals.css`
- Modify: `tests/forward-learning-api.test.ts`
- Modify: `tests/rendered-html.test.mjs`

**Interfaces:**
- Consumes: existing committed-v2 review validation.
- Produces: optional `beforeIssue` in `readForwardLearningReviews`, API `nextCursor`, and expandable all-period learning history.

- [ ] **Step 1: Write failing pagination and UI tests**

Seed at least three complete official issues. Assert the first two are returned newest-first with `nextCursor`, then assert the cursor returns the older issue without overlap. Assert the page contains `逐期五项结算` and no longer contains `最近一期逐项结算`.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --test tests/forward-learning-api.test.ts tests/rendered-html.test.mjs`

Expected: FAIL because `before` and multi-period UI are absent.

- [ ] **Step 3: Add cursor pagination to storage and API**

Filter completed runs with `CAST(settled_issue AS INTEGER) < CAST(? AS INTEGER)`, fetch `limit + 1`, slice the visible page, and return the last visible issue as `nextCursor` only when another row exists. Continue validating complete five-slot official scores for every returned issue.

- [ ] **Step 4: Render all loaded learning reviews**

Replace `latest` with `data.reviews.map`. Use `<details>` per issue, open the newest issue by default, reuse the existing five score cards, and append older pages when the user clicks “加载更早期数”.

- [ ] **Step 5: Verify GREEN and commit**

Run: `node --test tests/forward-learning-api.test.ts tests/rendered-html.test.mjs && npm run typecheck`

Expected: PASS.

```bash
git add lib/forward-learning-store.ts app/api/learning/reviews/route.ts app/learning/ForwardLearningWorkspace.tsx app/globals.css tests/forward-learning-api.test.ts tests/rendered-html.test.mjs
git commit -m "feat: show all learning settlements"
```

### Task 6: Full verification and production deployment

**Files:**
- Modify only if verification uncovers a tested defect.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: verified build and deployed Sites version.

- [ ] **Step 1: Run full verification**

Run: `npm test`

Expected: TypeScript passes, all Node tests pass, all Python tests pass, production build succeeds, deployment tests pass, and rendered HTML tests pass.

- [ ] **Step 2: Inspect the diff and requirement checklist**

Run:

```bash
git status --short
git diff --check
git log --oneline --decorate -6
```

Confirm the old panel is absent, all three pattern review sections are present, all learning periods are accessible, cursor pagination is bounded, and public GET routes contain no writes.

- [ ] **Step 3: Deploy with Sites hosting workflow**

Use the Sites hosting deployment tool for the project identified by `.openai/hosting.json`. Record the returned deployment URL/version and verify `/patterns`, `/learning`, and both review APIs on the deployed version.

- [ ] **Step 4: Final evidence**

Report the exact verification commands, passed test counts, deployment version, and any old periods that could not be reconstructed. Do not claim completion without fresh command output.

