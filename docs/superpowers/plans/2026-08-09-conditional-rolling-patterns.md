# Conditional Rolling Patterns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the heat-like rolling scanner with an explicit `condition A at t → result B at t+1` engine, evaluated only on the latest 30 verified draws and explained in full on mobile.

**Architecture:** Keep the existing event definitions, D1 tables, signed lifecycle and read API, but version the JSON contract and engine. Split statistical tests from candidate generation, store A/B evidence inside each immutable signal, and make the public reader select only the current engine version.

**Tech Stack:** TypeScript 5.9, Next/Vinext, Cloudflare D1, Node test runner, React 19, CSS.

## Global Constraints

- Use exactly the latest 30 verified draws per game; never mix games or fill with unverified rows.
- Every displayed rule has an explicit antecedent A, a next-draw consequent B, and a current trigger.
- Do not generate unconditional frequency, hotness, simple lag recurrence, one-period self-continuation, or number predictions.
- Candidate display requires support ≥3, raw uplift ≥5 percentage points, and posterior uplift >0.
- Only `q ≤ 0.10` may be called “近期强证据”; all other displayed rows are “待验证规律”.
- Preserve old immutable runs for settlement and audit; current reads return only the new engine version.
- Formal v3 strategy probabilities remain unchanged.

---

### Task 1: Conditional rule contract and exact evidence statistics

**Files:**
- Create: `lib/rolling-pattern-statistics.ts`
- Modify: `lib/rolling-pattern-types.ts`
- Test: `tests/rolling-pattern-statistics.test.ts`

**Interfaces:**
- Produces `poissonBinomialUpperTail(probabilities: number[], hits: number): number`.
- Produces `benjaminiHochberg<T>(rows: T[], getP: (row: T) => number): Array<T & { qValue: number }>`.
- Defines `RollingPatternAntecedent`, `RollingPatternConditionEvidence`, `RollingPatternHistoricalAudit`, and v2 signal evidence fields.

- [ ] **Step 1: Write failing statistical tests**

```ts
test("computes exact upper-tail evidence and monotone BH q-values", async () => {
  assert.equal(poissonBinomialUpperTail([0.5, 0.5, 0.5], 2), 0.5);
  const corrected = benjaminiHochberg(
    [{ p: 0.01 }, { p: 0.03 }, { p: 0.04 }],
    (row) => row.p,
  );
  assert.deepEqual(corrected.map((row) => row.qValue), [0.03, 0.04, 0.04]);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test tests/rolling-pattern-statistics.test.ts`

Expected: FAIL because the statistics module does not exist.

- [ ] **Step 3: Add the minimal exact dynamic programs and v2 types**

```ts
export function poissonBinomialUpperTail(probabilities: number[], hits: number) {
  const pmf = Array(probabilities.length + 1).fill(0);
  pmf[0] = 1;
  probabilities.forEach((probability, index) => {
    for (let count = index + 1; count >= 0; count -= 1) {
      pmf[count] = (pmf[count] ?? 0) * (1 - probability) +
        (count ? (pmf[count - 1] ?? 0) * probability : 0);
    }
  });
  return pmf.slice(hits).reduce((sum, value) => sum + value, 0);
}
```

Define antecedents as discriminated unions for `single`, `conjunction`, and `sequence`; define complete human-readable condition and prediction labels instead of a generic description.

- [ ] **Step 4: Run test, typecheck, and verify GREEN**

Run: `node --test tests/rolling-pattern-statistics.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/rolling-pattern-statistics.ts lib/rolling-pattern-types.ts tests/rolling-pattern-statistics.test.ts
git commit -m "feat: define conditional pattern evidence"
```

### Task 2: Generate and backtest real A-to-B rules

**Files:**
- Rewrite: `lib/rolling-pattern-engine.ts`
- Rewrite: `tests/rolling-pattern-engine.test.ts`
- Modify: `package.json`

**Interfaces:**
- Keeps `buildRollingPatternRun(input): Promise<RollingPatternRun>`.
- Generates single transfer `A(t) → B(t+1)`, cross-family conjunction `(A1 ∧ A2)(t) → B(t+1)`, and same-event sequence rules.
- Emits `currentEvidence`, full historical A/B audit, `pValue`, `qValue`, and `evidenceTier`.

- [ ] **Step 1: Write failing engine tests for the new semantics**

```ts
test("discovers a current cross-event A to next-draw B rule", async () => {
  const run = await buildRollingPatternRun(crossEventFixture());
  const signal = run.signals.find((item) =>
    item.rule.antecedent.kind === "single" &&
    item.rule.antecedent.conditions[0].event.value === "猪" &&
    item.rule.event.value === "4尾"
  );
  assert.ok(signal);
  assert.match(signal.rule.relationLabel, /当.*猪.*下一期.*4尾/);
  assert.equal(signal.support, 3);
  assert.equal(signal.hits, 2);
  assert.ok(signal.currentEvidence.length > 0);
});

test("never generates hotness, simple lag, or one-draw self continuation", async () => {
  const run = await buildRollingPatternRun(crossEventFixture());
  assert.ok(run.signals.every((item) => item.rule.family !== "lag_recurrence"));
  assert.ok(run.signals.every((item) => item.rule.antecedent.kind !== "unconditional"));
  assert.ok(run.signals.every((item) =>
    item.rule.antecedent.kind !== "single" ||
    item.rule.antecedent.conditions[0].event.eventId !== item.rule.event.eventId
  ));
});
```

Add a separate fixture for `连续3期未出现 → 下一期出现`, and assert that 2/3 with a weak exact test remains `experimental` rather than `strong`.

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test tests/rolling-pattern-engine.test.ts`

Expected: FAIL because old rules contain no antecedent evidence and still generate lag recurrence.

- [ ] **Step 3: Implement bounded candidate generation**

Build per-draw event-state maps once. Generate:

```ts
for (const source of events) {
  for (const target of events) {
    if (source.eventId !== target.eventId) addSingle(source, target);
  }
}
for (const [left, right] of crossFamilyPairs(events)) {
  for (const target of events) {
    if (![left.eventId, right.eventId].includes(target.eventId)) {
      addConjunction(left, right, target);
    }
  }
}
for (const event of events) addSequences(event, { min: 2, max: 5 });
```

Evaluate historical triggers only from earlier state to the following draw. Evaluate the current trigger at index 30 without reading a target result.

- [ ] **Step 4: Apply evidence gates and BH-FDR**

Calculate p-values for every current-triggered rule with support ≥3, correct that complete family, then filter by the global constraints. Generate stable canonical JSON from antecedent and consequent event IDs.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `node --test tests/rolling-pattern-statistics.test.ts tests/rolling-pattern-engine.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/rolling-pattern-engine.ts tests/rolling-pattern-engine.test.ts package.json
git commit -m "feat: mine conditional A-to-B patterns"
```

### Task 3: Version-safe immutable persistence and settlement

**Files:**
- Modify: `lib/rolling-pattern-store.ts`
- Modify: `lib/rolling-pattern-service.ts`
- Modify: `tests/rolling-pattern-store.test.ts`

**Interfaces:**
- `readRollingPatternRun()` filters `engine_version = ROLLING_PATTERN_ENGINE_VERSION`.
- Settlement evaluates the consequent B for both old and new immutable ledgers.
- Existing D1 tables and unique target index remain valid because engine version is part of the identity.

- [ ] **Step 1: Write failing version-selection test**

```ts
test("current reads ignore a frozen v1 heat-like run", async () => {
  seedRun({ engineVersion: "rolling-patterns-v1", frozenAt: "2026-08-01T00:00:00Z" });
  seedRun({ engineVersion: ROLLING_PATTERN_ENGINE_VERSION, frozenAt: "2026-08-02T00:00:00Z" });
  const result = await readRollingPatternRun("new_macau", "2026221");
  assert.equal(result?.run.engineVersion, ROLLING_PATTERN_ENGINE_VERSION);
});
```

- [ ] **Step 2: Run test and verify RED**

Run: `node --test tests/rolling-pattern-store.test.ts`

Expected: FAIL because the query currently picks the earliest frozen run regardless of engine.

- [ ] **Step 3: Bind current engine version in reads and preserve legacy settlement parsing**

Use `WHERE game = ? AND target_issue = ? AND engine_version = ?`. Keep the consequent at `signal.rule.event`, so settlement remains deterministic.

- [ ] **Step 4: Run store and lifecycle tests**

Run: `node --test tests/rolling-pattern-store.test.ts tests/research-v3.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/rolling-pattern-store.ts lib/rolling-pattern-service.ts tests/rolling-pattern-store.test.ts
git commit -m "fix: isolate current conditional pattern ledgers"
```

### Task 4: Replace the heat-like cards with explicit rule explanations

**Files:**
- Rewrite: `app/research/patterns/RollingPatternWorkspace.tsx`
- Modify: `app/globals.css`
- Modify: `tests/rendered-html.test.mjs`

**Interfaces:**
- Consumes only v2 `RollingPatternSignal` fields.
- Keeps game and target-family filters and pagination.
- Renders a relation flow, current evidence, exact statistics, and historical A/B audit.

- [ ] **Step 1: Write failing server-render and source behavior tests**

```js
assert.match(patternSource, /完整规律/);
assert.match(patternSource, /本期触发依据/);
assert.match(patternSource, /历史条件A/);
assert.match(patternSource, /下一期结果B/);
assert.doesNotMatch(patternSource, /rolling-pattern-state/);
```

- [ ] **Step 2: Run test and verify RED**

Run: `node --test tests/rendered-html.test.mjs`

Expected: FAIL because the current card is centered on the old 30-cell state strip.

- [ ] **Step 3: Implement the mobile-first relation card**

Render:

```tsx
<div className="conditional-relation">
  <section><span>历史条件 A</span><strong>{signal.rule.conditionLabel}</strong></section>
  <b aria-hidden="true">→</b>
  <section><span>下一期结果 B</span><strong>{signal.rule.predictionLabel}</strong></section>
</div>
```

Add current issue evidence rows including event counts, a statistics grid including success/failure/p/q, and audit rows showing source and target issues. Remove the old heat-like state strip.

- [ ] **Step 4: Run rendered, API, and 360px CSS checks**

Run: `node --test tests/rendered-html.test.mjs && npm run typecheck && npm run lint`

Expected: PASS with no lint errors.

- [ ] **Step 5: Commit**

```bash
git add app/research/patterns/RollingPatternWorkspace.tsx app/globals.css tests/rendered-html.test.mjs
git commit -m "feat: explain conditional rolling patterns"
```

### Task 5: Full regression, publish, rescan, and production audit

**Files:**
- Modify: `README.md`
- Test: `tests/sites-deployment.test.mjs`

**Interfaces:**
- Existing signed `settle-and-learn` task creates the v2 current run after deployment.
- Public API returns only v2 data for the formal target issue.

- [ ] **Step 1: Update deployment assertions and README terminology**

Assert the build contains the conditional page and current engine reader; document the A→B definition and evidence tiers.

- [ ] **Step 2: Run the complete local verification**

Run: `npm test && npm run lint`

Expected: all TypeScript, Python, build, migration, API, and rendered tests pass; lint has zero errors.

- [ ] **Step 3: Commit the validated source**

```bash
git add README.md tests/sites-deployment.test.mjs
git commit -m "test: verify conditional pattern deployment"
```

- [ ] **Step 4: Save and deploy a new Sites version**

Push the exact validated HEAD to the configured Sites source repository, package `dist` plus `.openai/hosting.json` and migrations, save one version, deploy it to the existing public project, and wait for success.

- [ ] **Step 5: Trigger one signed research cycle and audit production**

Verify for new Macau that:

- current target equals the formal v3 target;
- engine version is the new conditional version;
- all signals contain A and B;
- no v1 run is returned;
- the page contains explicit relation copy;
- an empty run remains a valid outcome.

