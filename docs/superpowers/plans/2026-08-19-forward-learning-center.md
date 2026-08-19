# Independent Forward Learning Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an independent `/learning` page whose five fixed recommendation slots are frozen before each draw, settled once, and used to update the probabilities and explanations for the next issue.

**Architecture:** Add a deterministic TypeScript learning engine beside the existing rolling-pattern system. The engine consumes a completed 30-draw pattern run, freezes all candidate probabilities plus exactly one official forecast per slot, settles only pre-draw snapshots, updates versioned per-slot expert state, and exposes read-only learning APIs. Existing `/patterns` data and UI remain available as legacy product research.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript 5.9, Cloudflare D1, Web Crypto HMAC, Node test runner, GitHub Actions, vinext.

**Spec:** `docs/superpowers/specs/2026-08-19-forward-learning-center-design.md`

## Global Constraints

- Add a top-level `/learning` page; do not replace `/patterns`, `/research`, or `/research/review`.
- Freeze exactly five official slots per game and target issue: single zodiac, single tail, zodiac pair, zodiac triple, and special number.
- One target issue plus one slot is one official forward sample; candidate scores never enter official hit-rate totals.
- Never import `rolling_pattern_consensus_*` rows into the new model state or official performance.
- Selection is ordered by calibrated probability first; odds are display-only.
- Baseline expert weight is at least 25%, any expert is at most 60%, and one issue changes a weight by at most 10 percentage points.
- Settlement requires a verified matching draw and `frozen_at < draw_at`; retries are idempotent.
- Web GET routes are read-only and return `Cache-Control: private, no-store`.
- Computation remains deterministic TypeScript and must not add a high-CPU training dependency.
- Node engine remains `>=22.13.0`; scheduled workflows must use supported action versions.

---

### Task 1: Define learning records, exact baselines, and probability scoring

**Files:**
- Create: `lib/forward-learning-types.ts`
- Create: `lib/forward-learning-math.ts`
- Test: `tests/forward-learning-math.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `GameId`, `Draw`, `RollingPatternProductKind`, and the target draw date.
- Produces: `ForwardLearningSlot`, `ForwardLearningCandidate`, `ForwardLearningForecast`, `ForwardLearningScore`, `ForwardLearningModelState`, `exactSlotBaseline()`, `brierLoss()`, `binaryLogLoss()`, `updateExpertWeights()`.

- [ ] **Step 1: Write failing tests for exact baselines and scores**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  brierLoss,
  binaryLogLoss,
  exactSlotBaseline,
  updateExpertWeights,
} from "../lib/forward-learning-math.ts";

test("special number baseline is exactly 1/49", () => {
  assert.equal(exactSlotBaseline("special_number", ["01"], "2026-08-20T13:40:00Z"), 1 / 49);
});

test("pair and triple baselines use joint inclusion-exclusion", () => {
  const pair = exactSlotBaseline("coverage_zodiac_pair", ["鼠", "牛"], "2026-08-20T13:40:00Z");
  const triple = exactSlotBaseline("coverage_zodiac_triple", ["鼠", "牛", "虎"], "2026-08-20T13:40:00Z");
  assert.ok(pair > triple);
  assert.ok(pair > 0 && pair < 1);
  assert.ok(triple > 0 && triple < 1);
});

test("high-confidence failure has worse loss than baseline failure", () => {
  assert.ok(binaryLogLoss(0.9, false) > binaryLogLoss(0.5, false));
  assert.ok(brierLoss(0.9, false) > brierLoss(0.5, false));
});

test("expert update keeps safety bounds and per-issue movement cap", () => {
  const next = updateExpertWeights(
    { baseline: 0.34, rules30: 0.33, forward: 0.33 },
    { baseline: 0.1, rules30: 2.0, forward: 0.2 },
  );
  assert.ok(next.baseline >= 0.25);
  assert.ok(Math.max(...Object.values(next)) <= 0.6);
  assert.ok(Math.abs(next.rules30 - 0.33) <= 0.1000001);
});
```

- [ ] **Step 2: Register the new test and verify RED**

Modify `test:ai` to include `tests/forward-learning-math.test.ts`.

Run: `node --test --test-name-pattern='baseline|expert update|high-confidence' tests/forward-learning-math.test.ts`

Expected: FAIL because `forward-learning-math.ts` does not exist.

- [ ] **Step 3: Add stable domain types**

Define these exact unions and records in `lib/forward-learning-types.ts`:

```ts
export type ForwardLearningSlot =
  | "coverage_zodiac"
  | "coverage_tail"
  | "coverage_zodiac_pair"
  | "coverage_zodiac_triple"
  | "special_number";

export type ExpertWeights = { baseline: number; rules30: number; forward: number };
export type ExpertProbabilities = ExpertWeights;

export type ForwardLearningCandidate = {
  candidateId: string;
  game: GameId;
  targetIssue: string;
  slot: ForwardLearningSlot;
  resultKey: string;
  label: string;
  values: string[];
  baselineProbability: number;
  expertProbabilities: ExpertProbabilities;
  expertWeights: ExpertWeights;
  finalProbability: number;
  netOdds: number;
  rawRuleCount: number;
  evidenceClusterCount: number;
  ruleContributions: ForwardRuleContribution[];
  frozenAt: string;
  modelVersion: string;
  dataVersion: string;
};
```

Add forecast, score, model-state, rule-update, learning-run, review, and performance records using the field names in the design spec. Forecasts contain `official: true`; candidate snapshots do not duplicate official performance counters.

- [ ] **Step 4: Implement exact combinatorial baselines and proper scores**

Implement:

```ts
export function exactSlotBaseline(
  slot: ForwardLearningSlot,
  values: readonly string[],
  expectedDrawAt: string,
): number;
export function brierLoss(probability: number, matched: boolean): number;
export function binaryLogLoss(probability: number, matched: boolean): number;
export function updateExpertWeights(
  before: ExpertWeights,
  meanLoss: ExpertWeights,
  eta?: number,
): ExpertWeights;
```

Use `choose(n, k)` and inclusion-exclusion over category member counts for coverage slots. Clamp log-loss input to `[1e-6, 1 - 1e-6]`. Apply exponential loss updates, normalize, cap per-issue movement at `0.10`, enforce baseline `>=0.25`, enforce all experts `<=0.60`, then normalize again without violating the floors/caps.

- [ ] **Step 5: Run focused and existing math tests**

Run: `node --test --test-name-pattern='baseline|expert update|high-confidence' tests/forward-learning-math.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the scoring foundation**

```bash
git add lib/forward-learning-types.ts lib/forward-learning-math.ts tests/forward-learning-math.test.ts package.json
git commit -m "feat: add forward learning probability foundation"
```

### Task 2: Build candidates, remove correlated evidence, and select five official forecasts

**Files:**
- Create: `lib/forward-learning-engine.ts`
- Test: `tests/forward-learning-engine.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `RollingPatternRun`, prior `ForwardLearningModelState[]`, prior result posteriors, and `ForwardLearningCandidate` math helpers.
- Produces: `clusterRuleEvidence()`, `buildForwardLearningCandidates()`, `selectOfficialForecasts()`.

- [ ] **Step 1: Write failing engine tests**

Cover these concrete behaviors:

```ts
test("selects exactly one official forecast for every slot", () => {
  const result = selectOfficialForecasts(candidateFixture());
  assert.deepEqual(result.map((item) => item.slot), [
    "coverage_zodiac",
    "coverage_tail",
    "coverage_zodiac_pair",
    "coverage_zodiac_triple",
    "special_number",
  ]);
});

test("triple odds cannot displace a higher-probability candidate in another slot", () => {
  const result = selectOfficialForecasts(candidateFixtureWithHighTripleOdds());
  assert.equal(result.find((item) => item.slot === "coverage_zodiac")?.label, "猴");
});

test("duplicated rules form one evidence cluster and do not raise probability", () => {
  const once = buildForwardLearningCandidates(runFixture({ duplicateRule: false }), initialStates());
  const twice = buildForwardLearningCandidates(runFixture({ duplicateRule: true }), initialStates());
  assert.equal(candidate(once, "coverage_zodiac", "猴").finalProbability,
    candidate(twice, "coverage_zodiac", "猴").finalProbability);
});

test("selection is probability-first and deterministic", () => {
  const result = selectOfficialForecasts(tiedCandidateFixture());
  assert.equal(result[0].resultKey, "猴");
});
```

- [ ] **Step 2: Run the engine tests and verify RED**

Run: `node --test tests/forward-learning-engine.test.ts`

Expected: FAIL because engine exports do not exist.

- [ ] **Step 3: Implement evidence clustering**

Create a stable condition signature from canonical antecedent JSON. Compute Jaccard overlap from each rule's historical audit target issues. Put rules in the same cluster when signatures match or overlap is `>=0.8`. Within a cluster, retain the strongest posterior log-odds lift as the primary contribution and cap all supplemental contribution at 20% of that primary magnitude.

- [ ] **Step 4: Implement the three expert candidate probabilities**

For every valid result in each slot:

```ts
finalProbability =
  weights.baseline * exactBaseline +
  weights.rules30 * rules30Probability +
  weights.forward * forwardPosteriorProbability;
```

Use baseline-centered Beta strength 4 for each rule and result posterior. Bound final probability to `[0.01, 0.99]` for coverage and `[0.001, 0.20]` for special numbers. Generate all single zodiac/tail candidates, supported pairs/triples, and all 49 special-number candidates. Preserve current odds only as metadata.

- [ ] **Step 5: Implement per-slot official selection and explanation facts**

Sort only within a slot by final probability, uplift, forward sample count, Brier skill, and stable `resultKey`. Return exactly one official forecast per slot. Store structured comparison fields: previous probability, delta, top alternative, effective cluster count, and unchanged-result reason.

- [ ] **Step 6: Run engine tests and typecheck**

Run: `node --test tests/forward-learning-engine.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 7: Commit the candidate engine**

```bash
git add lib/forward-learning-engine.ts tests/forward-learning-engine.test.ts package.json
git commit -m "feat: add five-slot forward learning engine"
```

### Task 3: Add immutable D1 storage and idempotent settlement

**Files:**
- Create: `lib/forward-learning-store.ts`
- Test: `tests/forward-learning-store.test.ts`
- Modify: `lib/research-v3-store.ts`
- Modify: `tests/sites-deployment.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: candidates and forecasts from Task 2, verified `Draw`, and expert-state updates.
- Produces: `ensureForwardLearningStore()`, `freezeForwardLearningIssue()`, `settleForwardLearningIssue()`, `readForwardLearningForecast()`, `readForwardLearningReviews()`, `readForwardLearningPerformance()`, `readForwardLearningModel()`.

- [ ] **Step 1: Write failing storage tests**

Test with the existing fake D1 pattern that:

- one freeze writes five official rows and candidate snapshots;
- a repeated freeze preserves the original JSON and timestamp;
- settlement rejects a draw whose `drawAt` is not after `frozenAt`;
- a repeated settlement returns the existing run without duplicating scores or updates;
- candidate scores remain separate from official forecast totals;
- a failed update leaves the prior successful model state readable.

- [ ] **Step 2: Run storage tests and verify RED**

Run: `node --test tests/forward-learning-store.test.ts`

Expected: FAIL because the store and tables do not exist.

- [ ] **Step 3: Add the seven independent tables and indexes**

Append exact `CREATE TABLE IF NOT EXISTS` statements to the existing D1 bootstrap for:

```sql
forward_learning_forecasts
forward_learning_candidates
forward_learning_scores
forward_learning_rule_snapshots
forward_learning_rule_updates
forward_learning_model_states
forward_learning_runs
```

Use unique indexes on `(game, target_issue, slot)` for official forecasts, `(game, target_issue, candidate_id)` for candidates, `(forecast_id)` and `(candidate_id)` for scores, and `(game, settled_issue, engine_version)` for learning runs. Store complete immutable JSON snapshots alongside indexed identity columns.

- [ ] **Step 4: Implement freeze and settlement transactions**

`freezeForwardLearningIssue()` validates exactly five unique slots and uses `INSERT OR IGNORE`. `settleForwardLearningIssue()` first claims the idempotency key, validates the verified draw and freeze timestamps, writes scores, rule updates, and the next model version, and only then marks the run completed. On failure mark the learning run failed without changing the current-success state pointer.

- [ ] **Step 5: Implement read models and performance windows**

Official performance groups only `forward_learning_forecasts` joined to its official score. Return per slot for last 10, last 30, and all settled samples: count, hits, misses, hit rate, mean baseline, Brier, baseline Brier, Brier skill, log-loss, baseline log-loss, and skill. Candidate posteriors query candidate scores by exact `slot + result_key`.

- [ ] **Step 6: Verify D1 schema, storage, and deployment tests**

Run: `node --test tests/forward-learning-store.test.ts tests/sites-deployment.test.mjs`

Expected: PASS and all seven tables reported by the schema test.

- [ ] **Step 7: Commit immutable storage**

```bash
git add lib/forward-learning-store.ts lib/research-v3-store.ts tests/forward-learning-store.test.ts tests/sites-deployment.test.mjs package.json
git commit -m "feat: persist immutable forward learning ledger"
```

### Task 4: Orchestrate settle → learn → next freeze in the signed draw task

**Files:**
- Create: `lib/forward-learning-service.ts`
- Test: `tests/forward-learning-service.test.ts`
- Create: `app/api/internal/learning/settle-and-freeze/route.ts`
- Modify: `app/api/internal/research/settle-and-learn/route.ts`
- Modify: `lib/research-v3-service.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: completed rolling-pattern run from the existing cycle, verified draws, storage and engine APIs.
- Produces: `runForwardLearningCycle({ game, draws, rollingRun, now })`, the signed `POST /api/internal/learning/settle-and-freeze` endpoint, and a `forwardLearning` status in the existing signed task response.

- [ ] **Step 1: Write failing service tests for ordering and recovery**

Assert call order is exactly `settle previous → update model → build candidates → freeze next`. Add tests that awaiting verification does not update state, retry returns the same run, and candidate/model failure leaves the already-frozen next issue unchanged.

- [ ] **Step 2: Run service tests and verify RED**

Run: `node --test tests/forward-learning-service.test.ts`

Expected: FAIL because the cycle service does not exist.

- [ ] **Step 3: Implement the deterministic cycle**

Implement:

```ts
export async function runForwardLearningCycle(input: {
  game: GameId;
  draws: Draw[];
  rollingRun: RollingPatternRun;
  now: Date;
}): Promise<ForwardLearningCycleResult>;
```

Select the verified draw matching a frozen target issue, settle it once, load the latest successful per-slot model state, build the current target's candidate snapshots from the completed 30-draw run, and freeze five official recommendations. If no prior forecast exists, initialize model weights to `{ baseline: 0.34, rules30: 0.33, forward: 0.33 }` and freeze without fabricating a review.

- [ ] **Step 4: Wire the learning service into the existing signed task**

Call the new cycle only after `runResearchV3Cycle()` and `requireRollingPatternTaskSuccess()` succeed. Include `{ status, settledIssue, targetIssue, modelVersion }` in the response. A learning failure returns HTTP 503 so the same signed task can retry; it must not mark the shared task completed with missing learning output.

- [ ] **Step 5: Add the dedicated signed learning endpoint**

Create `POST /api/internal/learning/settle-and-freeze` with the same HMAC-SHA256 format, five-minute timestamp window, 512 KiB body cap, constant-time signature comparison, and `taskId` validation as the existing research endpoint. It accepts `{ taskId, game, asOf? }`, loads the already-completed rolling run and verified draws, calls `runForwardLearningCycle()`, and returns the existing idempotent result. It never recomputes the old research forecast.

- [ ] **Step 6: Verify service and both route behaviors**

Run: `node --test tests/forward-learning-service.test.ts tests/research-v3-store.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 7: Commit cycle orchestration**

```bash
git add lib/forward-learning-service.ts app/api/internal/learning/settle-and-freeze/route.ts app/api/internal/research/settle-and-learn/route.ts lib/research-v3-service.ts tests/forward-learning-service.test.ts package.json
git commit -m "feat: run forward learning after verified draws"
```

### Task 5: Add read-only learning APIs

**Files:**
- Create: `app/api/learning/forecast/route.ts`
- Create: `app/api/learning/reviews/route.ts`
- Create: `app/api/learning/performance/route.ts`
- Create: `app/api/learning/model/route.ts`
- Test: `tests/forward-learning-api.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: read functions from Task 3.
- Produces: stable JSON for the `/learning` workspace.

- [ ] **Step 1: Write failing validation and no-store tests**

Test valid `game=hk|new_macau`, bounded review limit `1..100`, malformed game/issue rejection, 404 unavailable payloads, and `Cache-Control: private, no-store` on every response.

- [ ] **Step 2: Run API tests and verify RED**

Run: `node --test tests/forward-learning-api.test.ts`

Expected: FAIL because routes do not exist.

- [ ] **Step 3: Implement four thin GET handlers**

Routes validate query parameters, call exactly one matching store read model, and never call settlement, candidate generation, or model update functions. The forecast payload includes five slots in stable order; reviews include structured before/after model changes; performance includes 10/30/all windows.

- [ ] **Step 4: Run API and type tests**

Run: `node --test tests/forward-learning-api.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit read APIs**

```bash
git add app/api/learning tests/forward-learning-api.test.ts package.json
git commit -m "feat: expose read-only forward learning APIs"
```

### Task 6: Build the independent `/learning` page and homepage entry

**Files:**
- Create: `app/learning/page.tsx`
- Create: `app/learning/ForwardLearningWorkspace.tsx`
- Modify: `app/LotteryDashboard.tsx`
- Modify: `app/globals.css`
- Modify: `tests/rendered-html.test.mjs`

**Interfaces:**
- Consumes: Task 5 API payloads and types from `forward-learning-types.ts`.
- Produces: independent responsive learning UI; the old `/patterns` component remains unchanged.

- [ ] **Step 1: Write failing rendered-source assertions**

Add assertions for:

```js
assert.match(learningPage, /逐期学习中心/);
assert.match(workspace, /下一期正式推荐/);
assert.match(workspace, /模型是否真的在进步/);
assert.match(workspace, /专家权重变化/);
assert.match(workspace, /逐期审计明细/);
assert.doesNotMatch(patternWorkspace, /逐期学习中心/);
assert.match(dashboard, /href="\/learning"/);
```

- [ ] **Step 2: Run rendered tests and verify RED**

Run: `node --test tests/rendered-html.test.mjs`

Expected: FAIL because `/learning` does not exist.

- [ ] **Step 3: Build the client workspace**

Fetch forecast, reviews, performance, and model endpoints for the selected game. Render five fixed forecast cards in the required slot order, latest five-slot settlement, 10/30/all metrics by slot, expert weight history, rule updates, and collapsed audit records. Empty state copy must say “正在积累前瞻样本” and never substitute backtest results.

- [ ] **Step 4: Add structured recommendation explanations**

Each card displays current probability, baseline, probability delta, raw rule count, evidence clusters, forward candidate history, expert weights, and unchanged/changed reason. Odds are visually secondary and no expected-value ranking is shown.

- [ ] **Step 5: Add homepage navigation and responsive styles**

Add one homepage card/link to `/learning`. Prefix all new CSS with `forward-learning-`. At `max-width: 520px`, use one-column cards, allow metric labels to wrap, and set all grids to `min-width: 0`; no element may require horizontal scrolling at 360px.

- [ ] **Step 6: Verify rendering, build, and mobile source rules**

Run: `node --test tests/rendered-html.test.mjs && npm run build`

Expected: PASS.

- [ ] **Step 7: Commit the independent page**

```bash
git add app/learning app/LotteryDashboard.tsx app/globals.css tests/rendered-html.test.mjs
git commit -m "feat: add independent forward learning center"
```

### Task 7: Label legacy research, verify automation runtime, and run adversarial simulations

**Files:**
- Modify: `app/patterns/RollingPatternWorkspace.tsx`
- Modify: `.github/workflows/research-v2.yml`
- Create: `tests/forward-learning-random.test.ts`
- Modify: `tests/rendered-html.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: complete engine/store/service/UI from Tasks 1–6.
- Produces: clear old/new boundary, supported workflow runtime, random and planted-bias acceptance evidence.

- [ ] **Step 1: Write failing random and planted-bias simulations**

Use deterministic seeded draws. For 500 fair synthetic issues, assert the learned probability's mean absolute deviation from the exact baseline decreases over the final 100 issues and no expert violates its cap. For a synthetic condition with a stable 15-point uplift, assert the rule expert gains weight and final-100 Brier is lower than the baseline expert. Add a duplicate-rule simulation proving cloned evidence leaves forecasts unchanged.

- [ ] **Step 2: Run simulations and verify behavior**

Run: `node --test tests/forward-learning-random.test.ts`

Expected before final tuning: at least one acceptance assertion fails; adjust only learning constants, not test data, until all deterministic expectations pass.

- [ ] **Step 3: Mark old panels as legacy without removing them**

Change the old `/patterns` copy to “旧版赔率产品研究” and explicitly state that its candidate totals are not official samples for `/learning`. Keep every existing old panel and interaction.

- [ ] **Step 4: Verify the GitHub workflow runtime and response check**

Keep `actions/checkout@v5`, `actions/setup-python@v6`, and `actions/upload-artifact@v6`. Extend the post-cycle health check to require that a successful response contains the new `forwardLearning` status when settlement runs. Do not add Node 20 actions.

- [ ] **Step 5: Run the complete verification suite**

Run:

```bash
npm run typecheck
npm run test:ai
npm run test:research
npm run build
npm run test:deployment
node --test tests/rendered-html.test.mjs
npm run lint
git diff --check
```

Expected: all tests and build pass; lint has no new errors; existing unrelated warnings, if any, are reported separately.

- [ ] **Step 6: Commit final integration**

```bash
git add app/patterns/RollingPatternWorkspace.tsx .github/workflows/research-v2.yml tests/forward-learning-random.test.ts tests/rendered-html.test.mjs package.json
git commit -m "test: verify forward learning safety and automation"
```

### Task 8: Deploy, initialize the first honest forecast, and verify production

**Files:**
- Modify only if deployment validation exposes an environment-specific defect.

**Interfaces:**
- Consumes: all completed tasks and existing Sites deployment configuration.
- Produces: deployed `/learning` page plus the first immutable five-slot forecast for each available game.

- [ ] **Step 1: Confirm the worktree is clean and commits are ordered**

Run: `git status --short && git log --oneline -10`

Expected: clean status and separate commits for math, engine, storage, orchestration, APIs, UI, and safety integration.

- [ ] **Step 2: Deploy through the existing Sites project**

Publish the tested branch to project `appgprj_6a71775ca2a0819187c157155bc9353c`, wait for deployment completion, and record the deployment/version identifiers.

- [ ] **Step 3: Trigger one signed cycle per game**

Use the existing production GitHub workflow dispatch or signed cycle client. The response must report the current verified issue, next target issue, `forwardLearning.status`, model version, and exactly five frozen forecasts. Do not backfill old product candidates as official forecasts.

- [ ] **Step 4: Verify live read-only behavior**

Check:

```text
/learning
/api/learning/forecast?game=new_macau
/api/learning/reviews?game=new_macau&limit=10
/api/learning/performance?game=new_macau
/api/learning/model?game=new_macau
```

Expected: five distinct slots, empty or honest post-release review history, no-store headers, stable repeated responses, and old `/patterns` still available.

- [ ] **Step 5: Verify 360px layout and immutable refresh**

Inspect `/learning` at 360px width and refresh twice. Expected: no horizontal overflow and identical target issue, results, probabilities, model version, and frozen timestamp.

- [ ] **Step 6: Push the final tested commit**

```bash
git push github codex/cloudflare-free-deploy
git push github codex/cloudflare-free-deploy:main
```

Expected: both pushes succeed and production remains on the verified commit.
