# Independent 30-Draw Pattern Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the complete rolling 30-draw conditional-pattern workspace to `/patterns`, add all-rule aggregate statistics above it, link it from the homepage, and preserve the separate strategy and review pages.

**Architecture:** A pure summary function aggregates the complete filtered signal set before API pagination. The existing client workspace moves to the top-level route and renders the summary before filters and detailed rule cards; `/research/patterns` becomes a compatibility redirect. Existing `/research` and `/research/review` routes remain unchanged except that their shared navigation points to `/patterns`.

**Tech Stack:** Next.js 16, React 19, TypeScript 5.9, Vinext/Cloudflare Worker, Node test runner, Sites hosting.

## Global Constraints

- Keep `/research` as the independent “下一期策略” page.
- Keep `/research/review` as the independent “逐期复盘” page.
- Use only the frozen rolling-pattern ledger; page reads must not trigger scans, training, settlement, or writes.
- Aggregate all filtered signals before pagination; the totals must not change between pages.
- Historical trigger, hit, and miss totals are rule-audit counts and must be labeled as non-independent.
- Keep all existing condition, result, baseline, p/q, evidence, pagination, and audit details.
- `/research/patterns` must redirect to `/patterns` so old links keep working.
- 360px mobile layout must have no horizontal overflow.

---

### Task 1: Pure all-rule summary aggregation

**Files:**
- Create: `lib/rolling-pattern-summary.ts`
- Modify: `lib/rolling-pattern-types.ts`
- Create: `tests/rolling-pattern-summary.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `RollingPatternSignal[]`.
- Produces: `summarizeRollingPatterns(signals: RollingPatternSignal[]): RollingPatternSummary`.
- Produces types `RollingPatternSummary` and `RollingPatternResultSummary`.

- [ ] **Step 1: Write the failing aggregation tests**

Create fixtures with duplicate `ruleId` values and mixed result baselines. Assert:

```ts
const summary = summarizeRollingPatterns(signals);
assert.equal(summary.strategyCount, 3);
assert.equal(summary.triggerCount, 20);
assert.equal(summary.hitCount, 13);
assert.equal(summary.missCount, 7);
assert.equal(summary.expectedHits, 9.2);
assert.equal(summary.resultGroups[0].eventId, "zodiac:羊:1");
assert.equal(summary.resultGroups[0].strategyCount, 2);
```

Also assert an empty input returns zeros and `resultGroups: []`, and assert result groups sort by strong count, strategy count, uplift, then label.

- [ ] **Step 2: Run the new test and verify it fails**

Run: `node --test tests/rolling-pattern-summary.test.ts`

Expected: FAIL because `lib/rolling-pattern-summary.ts` does not exist.

- [ ] **Step 3: Add summary types and minimal pure implementation**

Add:

```ts
export type RollingPatternResultSummary = {
  eventId: string;
  label: string;
  family: RollingPatternFamily;
  strategyCount: number;
  triggerCount: number;
  hitCount: number;
  missCount: number;
  hitRate: number;
  expectedHits: number;
  baselineRate: number;
  uplift: number;
  strongStrategyCount: number;
  experimentalStrategyCount: number;
};

export type RollingPatternSummary = {
  strategyCount: number;
  resultCount: number;
  triggerCount: number;
  hitCount: number;
  missCount: number;
  hitRate: number;
  expectedHits: number;
  expectedMisses: number;
  baselineRate: number;
  uplift: number;
  strongStrategyCount: number;
  experimentalStrategyCount: number;
  resultGroups: RollingPatternResultSummary[];
};
```

Deduplicate by `rule.ruleId` before all aggregation. Compute `expectedHits` as `sum(support * baseline)` and use guarded division returning `0` for empty totals.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `node --test tests/rolling-pattern-summary.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Register the test and commit**

Add `tests/rolling-pattern-summary.test.ts` to `test:ai`, then commit:

```bash
git add lib/rolling-pattern-summary.ts lib/rolling-pattern-types.ts tests/rolling-pattern-summary.test.ts package.json
git commit -m "feat: aggregate rolling pattern evidence"
```

### Task 2: Return the complete filtered summary from the read API

**Files:**
- Modify: `app/api/research/patterns/route.ts`
- Modify: `tests/rendered-html.test.mjs`

**Interfaces:**
- Consumes: `summarizeRollingPatterns(filtered)` before pagination.
- Produces: `PatternApiResponse.summary: RollingPatternSummary | null`.

- [ ] **Step 1: Write failing API contract assertions**

Update the unavailable response expectation to include:

```js
summary: null,
```

Read the route source and assert `summarizeRollingPatterns(filtered)` appears before `filtered.slice(...)`, proving the summary is not page-local.

- [ ] **Step 2: Run the focused API tests and verify failure**

Run: `npm run build && node --test --test-name-pattern="rolling pattern API" tests/rendered-html.test.mjs`

Expected: FAIL because the response has no `summary` field.

- [ ] **Step 3: Add API summary output**

Import the pure aggregator, return `summary: null` for unavailable state, and return:

```ts
summary: summarizeRollingPatterns(filtered),
signals: filtered.slice(start, start + PAGE_SIZE),
```

for completed reads.

- [ ] **Step 4: Run focused tests**

Run: `npm run build && node --test --test-name-pattern="rolling pattern API" tests/rendered-html.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/api/research/patterns/route.ts tests/rendered-html.test.mjs
git commit -m "feat: expose rolling pattern summary"
```

### Task 3: Move the full workspace to `/patterns` and add the statistics UI

**Files:**
- Create: `app/patterns/page.tsx`
- Move: `app/research/patterns/RollingPatternWorkspace.tsx` to `app/patterns/RollingPatternWorkspace.tsx`
- Modify: `app/research/patterns/page.tsx`
- Modify: `app/globals.css`
- Modify: `tests/rendered-html.test.mjs`

**Interfaces:**
- Consumes: API `summary` plus existing run, signals, scores, and pagination.
- Produces: page `/patterns`, redirect `/research/patterns` → `/patterns`, `PatternSummaryPanel` and result-B summary cards.

- [ ] **Step 1: Write failing route and markup tests**

Assert `/patterns` server-renders the existing title, condition copy, strategy/review navigation, and summary labels:

```js
assert.match(html, /支持策略数/);
assert.match(html, /总命中次数/);
assert.match(html, /总失败次数/);
assert.match(html, /结果 B 支持汇总/);
assert.match(html, /规则审计次数，不是独立期开奖期数/);
```

Assert `/research/patterns` returns a redirect whose `location` ends in `/patterns`.

- [ ] **Step 2: Run the route test and verify it fails**

Run: `npm run build && node --test --test-name-pattern="rolling 30 pattern|compatibility" tests/rendered-html.test.mjs`

Expected: FAIL because `/patterns` and the summary markup do not exist.

- [ ] **Step 3: Move the workspace and wire the route**

Move the component to `app/patterns`, update relative imports from `../../../lib` to `../../lib`, add the new page metadata, and replace the old page with:

```ts
import { redirect } from "next/navigation";

export default function LegacyRollingPatternPage() {
  redirect("/patterns");
}
```

- [ ] **Step 4: Render summary before detailed rules**

Extend `PatternApiResponse` with `summary: RollingPatternSummary | null`. Render KPI cards for strategies, results, triggers, hits, misses, hit rate, weighted baseline, and uplift. Render `resultGroups` below with result label, supporting strategy count, hits/failures, hit rate, baseline, uplift, and strong/experimental counts. Keep filter, list, pagination, and audits below the summary.

- [ ] **Step 5: Add mobile-first styles**

Use existing `rolling-pattern-*` visual language. At `max-width: 640px`, render KPI cards in two columns, result-group cards in one column, and ensure all values wrap with `min-width: 0` and no table overflow.

- [ ] **Step 6: Run focused render tests and typecheck**

Run: `npm run typecheck && npm run build && node --test --test-name-pattern="rolling 30 pattern|compatibility" tests/rendered-html.test.mjs`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add app/patterns app/research/patterns app/globals.css tests/rendered-html.test.mjs
git commit -m "feat: add independent rolling pattern page"
```

### Task 4: Add homepage entry and preserve all three research destinations

**Files:**
- Modify: `app/LotteryDashboard.tsx`
- Modify: `app/research/ResearchWorkspace.tsx`
- Modify: `app/research/review/ResearchReviewWorkspace.tsx`
- Modify: `app/patterns/RollingPatternWorkspace.tsx`
- Modify: `tests/rendered-html.test.mjs`

**Interfaces:**
- Produces direct homepage link `href="/patterns"`.
- Preserves `href="/research"` and `href="/research/review"`.

- [ ] **Step 1: Write failing navigation tests**

Assert the homepage includes visible copy “近30期条件规律” and `href="/patterns"`. For `/research`, `/patterns`, and `/research/review`, assert all three destination links are present.

- [ ] **Step 2: Run the navigation tests and verify failure**

Run: `npm run build && node --test --test-name-pattern="dashboard|three-way navigation" tests/rendered-html.test.mjs`

Expected: FAIL because the homepage and existing navigation still point to the old path.

- [ ] **Step 3: Add the homepage entry and update navigation links**

Add a prominent direct entry beside the existing research entry without removing it. Replace every internal `href="/research/patterns"` with `href="/patterns"`; leave `/research` and `/research/review` unchanged.

- [ ] **Step 4: Run navigation tests**

Run: `npm run build && node --test --test-name-pattern="dashboard|three-way navigation" tests/rendered-html.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/LotteryDashboard.tsx app/research/ResearchWorkspace.tsx app/research/review/ResearchReviewWorkspace.tsx app/patterns/RollingPatternWorkspace.tsx tests/rendered-html.test.mjs
git commit -m "feat: link independent pattern research page"
```

### Task 5: Regression verification and Sites publication

**Files:**
- Modify only if verification exposes a scoped regression.

**Interfaces:**
- Verifies the feature and existing strategy/review flows.
- Publishes the verified commit to the existing Sites project.

- [ ] **Step 1: Run static and focused test checks**

Run:

```bash
rg -n 'href="/research/patterns"' app tests
git diff --check
npm run lint
```

Expected: no stale internal links, no whitespace errors, lint PASS.

- [ ] **Step 2: Run the complete test suite**

Run: `npm test`

Expected: typecheck, Node tests, Python research tests, build, deployment tests, and rendered HTML tests all PASS.

- [ ] **Step 3: Verify production-shaped routes locally**

Verify `/`, `/patterns`, `/research`, `/research/review`, and `/research/patterns`. Confirm the first four render successfully and the legacy path redirects to `/patterns`; confirm the read API remains `private, no-store`.

- [ ] **Step 4: Commit any verification-only corrections**

If fixes were required, stage only scoped files and commit:

```bash
git commit -m "fix: verify independent pattern workspace"
```

- [ ] **Step 5: Push and publish**

Push the verified branch/commit to GitHub and save/deploy a new public Sites version for project `appgprj_6a71775ca2a0819187c157155bc9353c`. Wait for deployment success and verify the production URL serves `/patterns`, homepage entry, strategy, review, and legacy redirect.

