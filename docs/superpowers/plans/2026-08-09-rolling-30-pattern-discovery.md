# 近30期规律发现 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增一个只读取最新30期、每期开奖后自动重扫和结算、仅展示当前已触发且高于基准规律的独立研究页面。

**Architecture:** 用纯TypeScript规则引擎把每期开奖转换为生肖、尾数、波色数量和头数数量事件，再对有限状态模板进行无未来泄漏的滚动评估。D1保存不可变运行、信号和结算；现有签名逐期学习任务负责先结算旧信号再冻结下一期运行，公开API和页面只读冻结结果。

**Tech Stack:** Next 16 / Vinext、React 19、TypeScript 5.9、Cloudflare Worker + D1、Node test、Sites发布。

## Global Constraints

- 每个彩种独立使用目标期开奖前最新30期，香港和新澳门不得混合。
- 只读取 `official_verified` 或 `multi_source_consistent` 的已核验开奖。
- 只研究6+1生肖覆盖、6+1尾数覆盖、波色至少3个、头数至少2个，不预测具体号码。
- 只展示当前已触发、历史已结算触发至少3次、原始命中率严格高于精确基准且提升至少5个百分点的规律。
- Beta-Binomial收缩固定使用8个以精确随机基准为中心的伪样本。
- 触发少于6次为“小样本”，6–9次为“有限样本”，10次以上为“近期重复”。
- 空结果必须冻结；不得重复重跑直到出现规律。
- 公开GET请求不得结算、训练、扫描或写入D1。
- 现有正式策略、模型权重和历史冻结预测不受影响。
- 时区固定 `Asia/Shanghai`，360像素宽页面不得横向溢出。

---

## File Structure

- Create `lib/rolling-pattern-types.ts`: 运行、规则、信号、审计和API响应类型。
- Create `lib/rolling-pattern-events.ts`: 分类事件枚举、开奖状态转换和精确组合基准。
- Create `lib/rolling-pattern-engine.ts`: 30期窗口、模板生成、历史评估、规范化、去重、筛选和排序。
- Create `lib/rolling-pattern-store.ts`: D1初始化、不可变运行写入、历史结算和只读查询。
- Create `lib/rolling-pattern-service.ts`: “结算旧运行→生成新运行→冻结”的应用编排。
- Create `app/api/research/patterns/route.ts`: 只读查询接口。
- Create `app/research/patterns/page.tsx`: 页面元数据和服务端入口。
- Create `app/research/patterns/RollingPatternWorkspace.tsx`: 手机端交互页面。
- Create `tests/rolling-pattern-events.test.ts`: 事件映射和组合基准测试。
- Create `tests/rolling-pattern-engine.test.ts`: 窗口、规则、无未来泄漏、筛选与去重测试。
- Create `tests/rolling-pattern-store.test.ts`: D1幂等冻结、结算和读取测试。
- Create `drizzle/0008_rolling_pattern_runs.sql`: 三张规律表和索引。
- Modify `db/schema.ts`: 增加三张表的Drizzle定义。
- Modify `lib/research-v3-service.ts`: 在已有签名学习周期中调用规律编排。
- Modify `lib/research-v3-store.ts`: 统一D1 schema初始化包含新表，保持现有兼容路径。
- Modify `app/research/ResearchWorkspace.tsx`: 导航加入“近30期规律”。
- Modify `app/research/review/ResearchReviewWorkspace.tsx`: 导航加入“近30期规律”。
- Modify `app/globals.css`: 新页面及360像素响应式样式。
- Modify `tests/rendered-html.test.mjs`: SSR、导航、只读边界和页面文案回归。
- Modify `tests/sites-deployment.test.mjs`: 发布制品包含新路由。
- Modify `package.json`: 把三份新增单元测试加入 `test:ai`。

---

### Task 1: 分类事件与精确随机基准

**Files:**
- Create: `lib/rolling-pattern-types.ts`
- Create: `lib/rolling-pattern-events.ts`
- Test: `tests/rolling-pattern-events.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `Draw`, `GameId`, `getWave` from `lib/lottery.ts`; `getZodiac`, `ZODIAC_NAMES` from `lib/zodiac.ts`.
- Produces: `RollingPatternEvent`, `RollingPatternEventState`, `enumerateRollingEvents(expectedDrawAt)`, `evaluateRollingEvent(draw, event)`, `rollingEventBaseline(event, expectedDrawAt)`.

- [ ] **Step 1: Write failing tests for event definitions and exact baselines**

```ts
test("zodiac and tail coverage use their actual 4/5 member baselines", () => {
  const events = enumerateRollingEvents("2026-08-10T21:32:00+08:00");
  const pig = events.find((event) => event.family === "zodiac" && event.value === "猪")!;
  const tail0 = events.find((event) => event.family === "tail" && event.value === "0尾")!;
  assert.equal(pig.threshold, 1);
  assert.equal(tail0.threshold, 1);
  assert.equal(
    rollingEventBaseline(pig, "2026-08-10T21:32:00+08:00"),
    1 - choose(49 - pig.memberCount, 7) / choose(49, 7),
  );
});

test("wave and head events count all six main balls plus the special", () => {
  const draw = fixtureDraw([1, 2, 7, 3, 4, 9], 12);
  assert.equal(evaluateRollingEvent(draw, waveEvent("red")), true);
  assert.equal(evaluateRollingEvent(draw, headEvent(0)), true);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `node --test tests/rolling-pattern-events.test.ts`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `rolling-pattern-events.ts`.

- [ ] **Step 3: Define stable event types**

```ts
export type RollingPatternFamily = "zodiac" | "tail" | "wave" | "head";

export type RollingPatternEvent = {
  eventId: string;
  family: RollingPatternFamily;
  value: string;
  label: string;
  threshold: 1 | 2 | 3;
  memberCount: number;
};

export type RollingPatternEventState = {
  issue: string;
  drawAt: string;
  matched: boolean;
  count: number;
};
```

- [ ] **Step 4: Implement exact without-replacement probabilities and draw evaluation**

```ts
export function hypergeometricAtLeast(
  population: number,
  members: number,
  draws: number,
  threshold: number,
) {
  const denominator = choose(population, draws);
  let numerator = 0;
  for (let hits = threshold; hits <= Math.min(members, draws); hits += 1) {
    numerator += choose(members, hits) * choose(population - members, draws - hits);
  }
  return numerator / denominator;
}

export function evaluateRollingEvent(draw: Draw, event: RollingPatternEvent) {
  return countEventMembers([...draw.numbers, draw.special], draw.drawAt, event) >=
    event.threshold;
}
```

Enumerate 12 zodiac events, 10 tail events, 3 wave events and 5 head events in deterministic family/value order. Zodiac membership must call `getZodiac(number, expectedDrawAt)`; wave membership must call `getWave(number)`; head membership must use the ranges fixed in Global Constraints.

- [ ] **Step 5: Run unit tests and typecheck**

Run: `node --test tests/rolling-pattern-events.test.ts && npm run typecheck`

Expected: all event tests PASS and TypeScript exits 0.

- [ ] **Step 6: Commit the event foundation**

```bash
git add package.json lib/rolling-pattern-types.ts lib/rolling-pattern-events.ts tests/rolling-pattern-events.test.ts
git commit -m "feat: add rolling pattern event baselines"
```

---

### Task 2: 30期规则发现、无未来泄漏与去重

**Files:**
- Create: `lib/rolling-pattern-engine.ts`
- Test: `tests/rolling-pattern-engine.test.ts`
- Modify: `lib/rolling-pattern-types.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `enumerateRollingEvents`, `evaluateRollingEvent`, `rollingEventBaseline` from Task 1.
- Produces: `buildRollingPatternRun(input): RollingPatternRun`, `canonicalizeRollingRule(rule): string`, `stablePatternHash(value): Promise<string>`.

- [ ] **Step 1: Write failing tests for exact windowing and current-trigger filtering**

```ts
test("uses exactly the newest 30 verified draws and drops the oldest", async () => {
  const draws = makeDraws(31);
  const run = await buildRollingPatternRun(input(draws));
  assert.equal(run.window.drawCount, 30);
  assert.equal(run.window.oldestIssue, draws[29].issue);
  assert.equal(run.window.newestIssue, draws[0].issue);
  assert.ok(run.signals.every((signal) => signal.currentTriggered));
});

test("does not count the unresolved current trigger as a historical hit", async () => {
  const run = await buildRollingPatternRun(input(plantedMissingThreePattern()));
  const signal = run.signals.find((item) => item.rule.family === "omission_recovery")!;
  assert.equal(signal.support, 3);
  assert.equal(signal.hits, 2);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `node --test tests/rolling-pattern-engine.test.ts`

Expected: FAIL because `buildRollingPatternRun` is not defined.

- [ ] **Step 3: Implement bounded rule templates**

```ts
export type RollingPatternRule = {
  ruleId: string;
  family:
    | "omission_recovery"
    | "continuation"
    | "state_transition"
    | "lag_recurrence";
  event: RollingPatternEvent;
  statePattern: boolean[];
  parameters: { length?: number; lag?: number };
  prediction: true;
  canonicalJson: string;
  description: string;
};
```

Generate only: omission lengths 1–5, continuation lengths 1–3, binary state sequences of length 2–4, and fixed lags 2–5. Generate in deterministic order and normalize equivalent omission/state rules to the omission description before hashing.

- [ ] **Step 4: Implement chronological evaluation and current qualification**

```ts
function evaluateRule(states: RollingPatternEventState[], rule: RollingPatternRule) {
  const historical = states.slice(0, -1);
  const outcomes = settledTriggers(historical, rule); // each target lies after its trigger
  const currentTriggered = matchesSuffix(states, rule.statePattern);
  return {
    support: outcomes.length,
    hits: outcomes.filter(Boolean).length,
    currentTriggered,
  };
}

const qualified = currentTriggered &&
  support >= 3 &&
  rawRate > baseline &&
  rawRate - baseline >= 0.05;
```

Use `posterior = (hits + 8 * baseline) / (support + 8)`. Set sample labels exactly to `小样本`, `有限样本`, or `近期重复`. Preserve every qualified signal in the frozen run; apply pagination only in the read API.

- [ ] **Step 5: Add no-future-leak, duplicate and empty-run tests**

```ts
test("equivalent rules share one normalized id", async () => {
  const run = await buildRollingPatternRun(input(equivalentRuleFixture()));
  assert.equal(new Set(run.signals.map((item) => item.rule.ruleId)).size, run.signals.length);
});

test("freezes an empty successful run when nothing beats baseline", async () => {
  const run = await buildRollingPatternRun(input(flatFixture()));
  assert.equal(run.status, "completed");
  assert.equal(run.funnel.qualified, 0);
  assert.deepEqual(run.signals, []);
});
```

- [ ] **Step 6: Run engine tests and typecheck**

Run: `node --test tests/rolling-pattern-events.test.ts tests/rolling-pattern-engine.test.ts && npm run typecheck`

Expected: all tests PASS.

- [ ] **Step 7: Commit the pure rule engine**

```bash
git add package.json lib/rolling-pattern-types.ts lib/rolling-pattern-engine.ts tests/rolling-pattern-engine.test.ts
git commit -m "feat: discover active rolling 30 patterns"
```

---

### Task 3: D1不可变运行、信号与结算账本

**Files:**
- Create: `lib/rolling-pattern-store.ts`
- Create: `tests/rolling-pattern-store.test.ts`
- Create: `drizzle/0008_rolling_pattern_runs.sql`
- Modify: `db/schema.ts`
- Modify: `lib/research-v3-store.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `RollingPatternRun`, `RollingPatternSignal`, `Draw`.
- Produces: `ensureRollingPatternStore()`, `persistRollingPatternRun(run)`, `readRollingPatternRun(game, issue?)`, `settleRollingPatternRuns(game, draws, settledAt)`.

- [ ] **Step 1: Write failing fake-D1 tests for immutable persistence**

```ts
test("replaying one run id does not duplicate signals", async () => {
  const first = await store.persistRollingPatternRun(runFixture);
  const replay = await store.persistRollingPatternRun(runFixture);
  assert.equal(first, "created");
  assert.equal(replay, "existing");
  assert.equal(db.signals.size, runFixture.signals.length);
});

test("settlement scores only a previously frozen target issue", async () => {
  await store.persistRollingPatternRun(runFixture);
  await store.settleRollingPatternRuns("new_macau", [actualDraw], settledAt);
  assert.equal(db.scores.size, runFixture.signals.length);
  assert.ok([...db.scores.values()].every((row) => row.target_issue === actualDraw.issue));
});
```

- [ ] **Step 2: Run the store test and verify it fails**

Run: `node --test tests/rolling-pattern-store.test.ts`

Expected: FAIL because `rolling-pattern-store.ts` is missing.

- [ ] **Step 3: Add database schema and migration**

```sql
CREATE TABLE IF NOT EXISTS rolling_pattern_runs (
  run_id text PRIMARY KEY NOT NULL,
  game text NOT NULL,
  source_issue text NOT NULL,
  target_issue text NOT NULL,
  window_oldest_issue text NOT NULL,
  window_newest_issue text NOT NULL,
  window_data_hash text NOT NULL,
  engine_version text NOT NULL,
  status text NOT NULL,
  run_json text NOT NULL,
  frozen_at text NOT NULL,
  superseded_at text
);
CREATE UNIQUE INDEX IF NOT EXISTS rolling_pattern_target_idx
  ON rolling_pattern_runs (game, target_issue, window_data_hash, engine_version);
```

Add `rolling_pattern_signals` with `(run_id, rule_id)` unique identity and `signal_json`; add `rolling_pattern_scores` with `(run_id, rule_id)` unique identity, `actual_matched`, `actual_json`, and `scored_at`. Mirror these definitions in `db/schema.ts` and append them to runtime schema initialization so a new Sites database self-initializes.

- [ ] **Step 4: Implement immutable writes and current/history reads**

```ts
export async function persistRollingPatternRun(run: RollingPatternRun) {
  const inserted = await db.prepare(
    `INSERT OR IGNORE INTO rolling_pattern_runs (...) VALUES (...)`,
  ).bind(...values).run();
  if (Number(inserted.meta?.changes ?? 0) === 0) return "existing";
  if (run.signals.length) await db.batch(run.signals.map(insertSignal));
  return "created";
}
```

Latest read must first query `research_v3_forecasts` for that彩种当前冻结的 `target_issue`，再精确读取相同期号的规律运行；若相同期号不存在则返回 `null`，不得退回上一期。Issue reads return the exact immutable run plus any scores.

- [ ] **Step 5: Implement idempotent score settlement**

For each unsettled run whose `target_issue` exists in the verified draw map, evaluate each frozen signal against that draw and `INSERT OR IGNORE` its score. Update no probabilities and never rebuild the frozen rule during scoring.

- [ ] **Step 6: Run store tests, migration checks and typecheck**

Run: `node --test tests/rolling-pattern-store.test.ts && npm run typecheck && node --test tests/rendered-html.test.mjs --test-name-pattern="research writes"`

Expected: tests PASS; typecheck exits 0; runtime schema、Drizzle schema和迁移均包含三张规律表及唯一索引。

- [ ] **Step 7: Commit storage**

```bash
git add package.json db/schema.ts drizzle/0008_rolling_pattern_runs.sql lib/research-v3-store.ts lib/rolling-pattern-store.ts tests/rolling-pattern-store.test.ts
git commit -m "feat: persist rolling pattern ledgers"
```

---

### Task 4: 接入每期开奖后的自动重扫流程

**Files:**
- Create: `lib/rolling-pattern-service.ts`
- Modify: `lib/research-v3-service.ts`
- Modify: `app/api/internal/research/settle-and-learn/route.ts`
- Test: `tests/rolling-pattern-store.test.ts`
- Test: `tests/research-v3-store.test.ts`

**Interfaces:**
- Consumes: `buildRollingPatternRun`, `settleRollingPatternRuns`, `persistRollingPatternRun`, existing `runResearchV3Cycle` inputs.
- Produces: `runRollingPatternCycle({ game, draws, targetIssue, expectedDrawAt, generatedAt }): Promise<{ status; runId; qualified }>`.

- [ ] **Step 1: Write a failing lifecycle-order test**

```ts
test("settles the old target before freezing the next rolling window", async () => {
  const calls: string[] = [];
  await runRollingPatternCycle(input, {
    settle: async () => { calls.push("settle"); return "ok"; },
    build: async () => { calls.push("build"); return runFixture; },
    persist: async () => { calls.push("persist"); return "created"; },
  });
  assert.deepEqual(calls, ["settle", "build", "persist"]);
});
```

- [ ] **Step 2: Run the lifecycle test and verify it fails**

Run: `node --test tests/rolling-pattern-store.test.ts`

Expected: FAIL because `runRollingPatternCycle` is missing.

- [ ] **Step 3: Implement the rolling pattern service**

```ts
export async function runRollingPatternCycle(input: RollingPatternCycleInput) {
  const formal = input.draws.filter((draw) => draw.verified);
  if (formal.length < 30) return { status: "insufficient_data", missing: 30 - formal.length };
  const settlement = await settleRollingPatternRuns(input.game, formal, input.generatedAt);
  if (settlement !== "ok") throw new Error("rolling pattern settlement failed");
  const run = await buildRollingPatternRun({ ...input, draws: formal.slice(0, 30) });
  const persistence = await persistRollingPatternRun(run);
  return { status: persistence, runId: run.runId, qualified: run.funnel.qualified };
}
```

- [ ] **Step 4: Integrate with every safe return path of `runResearchV3Cycle`**

After the newest draw is verified and before returning an existing or newly created v3 snapshot, invoke the rolling cycle exactly once for the derived target issue. Do not invoke it when the newest draw remains unverified or conflicted. The pattern result is independent of the four formal strategy events and must not be passed into `buildResearchV3Snapshot`.

- [ ] **Step 5: Include pattern status in signed task response without changing idempotency**

```ts
const response = {
  status: envelope.cycleStatus,
  taskId: body.taskId,
  runId: envelope.snapshot.runId,
  targetIssue: envelope.snapshot.targetIssue,
  rollingPatterns: envelope.rollingPatterns,
  immutable: true,
};
```

The response remains stored by the existing `research_task_runs` claim. A retry with the same task ID restores this exact response and performs no second scan.

- [ ] **Step 6: Run lifecycle and existing idempotency tests**

Run: `node --test tests/rolling-pattern-store.test.ts tests/research-v3-store.test.ts && npm run typecheck`

Expected: all tests PASS, including the existing one-learner task claim test.

- [ ] **Step 7: Commit automation integration**

```bash
git add lib/rolling-pattern-service.ts lib/research-v3-service.ts app/api/internal/research/settle-and-learn/route.ts tests/rolling-pattern-store.test.ts tests/research-v3-store.test.ts
git commit -m "feat: rescan rolling patterns after each draw"
```

---

### Task 5: 只读规律查询API

**Files:**
- Create: `app/api/research/patterns/route.ts`
- Modify: `tests/rendered-html.test.mjs`

**Interfaces:**
- Consumes: `readRollingPatternRun(game, issue?)` from Task 3.
- Produces: `GET /api/research/patterns?game=<game>&issue=<optional>&family=<optional>&page=<optional>`.

- [ ] **Step 1: Write failing API validation and empty-result tests**

```js
test("rolling pattern API rejects unsupported query parameters", async () => {
  const response = await fetchWorker("/api/research/patterns?game=new_macau&write=true");
  assert.equal(response.status, 400);
});

test("rolling pattern API is a read-only no-store endpoint", async () => {
  const response = await fetchWorker("/api/research/patterns?game=new_macau");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
});
```

- [ ] **Step 2: Run the API tests and verify they fail**

Run: `npm run build && node --test tests/rendered-html.test.mjs --test-name-pattern="rolling pattern API"`

Expected: FAIL with 404 before the route exists.

- [ ] **Step 3: Implement strict query validation and pagination**

```ts
const allowed = new Set(["game", "issue", "family", "page"]);
const family = value === null || ["zodiac", "tail", "wave", "head"].includes(value)
  ? value
  : invalid;
const page = Math.max(1, Math.min(Number(rawPage || 1), 100));
```

Return `{ run, signals, scores, pagination }`. Page size is fixed at20. If no current run exists, return a structured `status: "unavailable"` response rather than falling back to an older target. The handler imports no build, settle, persist, data-fetch or model-training function.

- [ ] **Step 4: Add source-level guard proving public GET cannot write**

```js
assert.doesNotMatch(patternRoute, /buildRollingPatternRun|persistRollingPatternRun|settleRollingPatternRuns|loadServerDraws/);
assert.match(patternRoute, /readRollingPatternRun/);
```

- [ ] **Step 5: Run API and public-read regression tests**

Run: `npm run build && node --test tests/rendered-html.test.mjs`

Expected: all rendered/API tests PASS.

- [ ] **Step 6: Commit the read API**

```bash
git add app/api/research/patterns/route.ts tests/rendered-html.test.mjs
git commit -m "feat: expose frozen rolling patterns"
```

---

### Task 6: 手机端近30期规律页面与研究导航

**Files:**
- Create: `app/research/patterns/page.tsx`
- Create: `app/research/patterns/RollingPatternWorkspace.tsx`
- Modify: `app/research/ResearchWorkspace.tsx`
- Modify: `app/research/review/ResearchReviewWorkspace.tsx`
- Modify: `app/globals.css`
- Modify: `tests/rendered-html.test.mjs`

**Interfaces:**
- Consumes: public pattern API response from Task 5 and `GAME_META`.
- Produces: `/research/patterns` with game switch, funnel, family filters, cards, audit details and explicit empty/error states.

- [ ] **Step 1: Write failing SSR and navigation tests**

```js
test("server-renders the rolling 30 pattern workspace", async () => {
  const response = await render("/research/patterns");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>近30期规律｜六合智研<\/title>/i);
  assert.match(html, /只看最新30期/);
  assert.match(html, /正在读取冻结的近期规律/);
});
```

Also assert all three workspaces contain links to `/research`, `/research/patterns`, and `/research/review`.

- [ ] **Step 2: Run SSR test and verify it fails**

Run: `npm run build && node --test tests/rendered-html.test.mjs --test-name-pattern="rolling 30|研究导航"`

Expected: FAIL because the page and navigation link do not exist.

- [ ] **Step 3: Implement metadata, loading and game/family controls**

```tsx
export const metadata: Metadata = {
  title: "近30期规律",
  description: "只使用最新30期，展示当前已触发且历史命中率高于精确随机基准的近期待验证规律。",
};
```

Default game is `new_macau`. A game or family change aborts the prior fetch and reads only the frozen API. Filters are `全部、生肖、尾数、波色、头数`.

- [ ] **Step 4: Implement run context, scan funnel and honest states**

Display target issue, source issue, 30-period start/end, quality grade, frozen time and engine version. Funnel labels are `模板生成、当前触发、规范去重、高于基准、最终展示`. Empty successful runs display exactly: `本期没有同时满足当前触发和高于基准的近期规律`.

- [ ] **Step 5: Implement signal cards and expandable audit**

```tsx
<article className={`rolling-pattern-card ${signal.sampleLabel}`}>
  <span>{familyLabel(signal.event.family)} · 待验证规律</span>
  <h2>{signal.rule.description}</h2>
  <strong>{signal.event.label}</strong>
  <Metric label="近期命中" value={`${signal.hits}/${signal.support}`} />
  <Metric label="原始命中率" value={percent(signal.rawRate)} />
  <Metric label="随机基准" value={percent(signal.baseline)} />
  <Metric label="高于基准" value={signedPoints(signal.rawUplift)} />
  <Metric label="收缩后" value={percent(signal.posteriorRate)} />
</article>
```

The 30-state strip uses accessible text (`出现/未出现`) in addition to color. `<details>` lists every settled trigger source issue, target issue and hit/miss plus the current trigger explanation.

- [ ] **Step 6: Add mobile-first styles and 360px overflow guard**

Use one-column cards by default; add wider grids only above720px. Set `min-width: 0`, `overflow-wrap: anywhere`, compact metric grids and horizontally wrapping filter buttons. Add an automated source assertion for `@media (max-width: 370px)` and manually inspect at360×800.

- [ ] **Step 7: Run page tests, typecheck and build**

Run: `npm run typecheck && npm run build && node --test tests/rendered-html.test.mjs`

Expected: all commands exit 0 and all three research pages server-render.

- [ ] **Step 8: Commit the page**

```bash
git add app/research/patterns/page.tsx app/research/patterns/RollingPatternWorkspace.tsx app/research/ResearchWorkspace.tsx app/research/review/ResearchReviewWorkspace.tsx app/globals.css tests/rendered-html.test.mjs
git commit -m "feat: add rolling 30 pattern workspace"
```

---

### Task 7: 全量回归、生产数据演练与Sites发布

**Files:**
- Modify: `tests/sites-deployment.test.mjs`
- Modify: `README.md`

**Interfaces:**
- Consumes: completed engine, store, lifecycle, API and page.
- Produces: regression-tested build and a published Sites version on the existing c308868584 project.

- [ ] **Step 1: Add deployment artifact assertions**

```js
test("deployment contains the rolling pattern route and no write-on-read imports", async () => {
  const manifest = await readDeploymentManifest();
  assert.match(JSON.stringify(manifest), /research\/patterns/);
  const route = await readFile("app/api/research/patterns/route.ts", "utf8");
  assert.doesNotMatch(route, /settle|persist|buildRollingPatternRun/);
});
```

- [ ] **Step 2: Document operational behavior**

Add a concise README section stating that the existing GitHub Action performs one idempotent pattern settlement/rescan after verified draws; public page reads never compute; empty runs are valid; manual recovery uses the existing signed `settle-and-learn` workflow dispatch.

- [ ] **Step 3: Run the complete local verification suite**

Run: `npm test && npm run lint`

Expected: TypeScript, all Node tests, Python tests, production build, rendered HTML and deployment checks PASS; ESLint exits 0.

- [ ] **Step 4: Run deterministic fixture audits**

Run: `node --test tests/rolling-pattern-events.test.ts tests/rolling-pattern-engine.test.ts tests/rolling-pattern-store.test.ts`

Expected: the planted “连续3期未出现→下一期出现” fixture produces `3次触发、2次命中`; the duplicate fixture has unique rule IDs; the empty fixture freezes zero signals.

- [ ] **Step 5: Commit the final regression coverage**

```bash
git add README.md tests/sites-deployment.test.mjs
git commit -m "test: verify rolling pattern deployment"
```

- [ ] **Step 6: Publish through the existing Sites project**

Use the `sites:sites-hosting` workflow against `.openai/hosting.json`. Do not create a new Sites project. Save a new version, publish it, and record the returned production URL and version identifier.

- [ ] **Step 7: Verify production read paths**

Check `/research/patterns`, `/api/research/patterns?game=new_macau`, `/research`, and `/research/review`. Verify HTTP200, Beijing-time copy, three-way navigation, correct current/empty state, and no horizontal overflow at360px. Do not trigger the signed learning endpoint during a read-only production smoke test.

- [ ] **Step 8: Record final status**

Run: `git status --short && git log -8 --oneline`

Expected: clean worktree and the seven feature commits above present in order.

---

## Execution Notes

- The design specification is `docs/superpowers/specs/2026-08-09-rolling-30-pattern-discovery-design.md`.
- Build the pure event and engine layers before touching D1 or React so statistical behavior can be reviewed independently.
- Do not reuse the older v2 broad rule page or its 8,032-rule display; this feature has a bounded 30-period binary-state DSL.
- Do not add a second GitHub schedule. The existing signed settle-and-learn cycle is the single writer.
- Existing frozen v3 predictions and reviews are immutable and must remain readable after the schema additions.
