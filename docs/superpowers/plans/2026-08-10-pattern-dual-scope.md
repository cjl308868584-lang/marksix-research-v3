# 近30期条件规律双结果域 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将独立的近30期规律页拆成6+1覆盖与特码两个结果域，并实现正确基准、汇总排序、点击筛选与黄色结果文字。

**Architecture:** 条件事件与结果事件分开枚举；规则引擎对同一组6+1条件分别扫描两个结果域，并将范围写入事件ID和冻结账本。读取API先按结果域与分类汇总，再按所选结果过滤明细；页面只读取冻结数据。

**Tech Stack:** TypeScript、React、Next/Vinext、Cloudflare Worker、D1、Node test runner、Sites。

## Global Constraints

- 最近窗口严格为30期已核验数据。
- 条件A始终读取当期6+1。
- 6+1结果B只包含生肖与尾数。
- 特码结果B包含生肖、尾数、波色与头数，只读取特码。
- 不生成01–49具体号码预测。
- 规则引擎版本为 `conditional-patterns-v3`，不得回退读取v2。
- 360px页面不得横向溢出。

---

### Task 1: 分离条件事件与两类结果事件

**Files:**
- Modify: `lib/rolling-pattern-types.ts`
- Modify: `lib/rolling-pattern-events.ts`
- Test: `tests/rolling-pattern-events.test.ts`

**Interfaces:**
- Produces: `RollingPatternScope = "coverage_6_plus_1" | "special"`
- Produces: `enumerateRollingConditionEvents(expectedDrawAt)`
- Produces: `enumerateRollingResultEvents(expectedDrawAt, scope)`
- Produces: `evaluateRollingConditionEvent(draw, event)`、`evaluateRollingResultEvent(draw, event)`
- Produces: `rollingResultEventBaseline(event, expectedDrawAt)`

- [ ] **Step 1: Write failing event-scope tests**

```ts
test("6+1 targets contain only zodiac and tail", () => {
  const events = enumerateRollingResultEvents(DRAW_AT, "coverage_6_plus_1");
  assert.deepEqual([...new Set(events.map((event) => event.family))], ["zodiac", "tail"]);
  assert.ok(events.every((event) => event.scope === "coverage_6_plus_1"));
});

test("special targets contain all four classifications and inspect only special", () => {
  const events = enumerateRollingResultEvents(DRAW_AT, "special");
  assert.deepEqual(new Set(events.map((event) => event.family)), new Set(["zodiac", "tail", "wave", "head"]));
  const red = events.find((event) => event.family === "wave" && event.value === "红波")!;
  assert.equal(evaluateRollingResultEvent(DRAW_WITH_BLUE_SPECIAL_AND_RED_MAINS, red).matched, false);
});
```

- [ ] **Step 2: Run RED**

Run: `npx tsx --test tests/rolling-pattern-events.test.ts`
Expected: FAIL because the scoped result APIs and `scope` field do not exist.

- [ ] **Step 3: Implement scoped events**

Add `scope` to result events, use `coverage:${family}:...` and `special:${family}:...` IDs, keep conditions evaluated over `[...draw.numbers, draw.special]`, evaluate special targets over `[draw.special]`, and compute baselines as hypergeometric coverage or `memberCount / 49` respectively.

- [ ] **Step 4: Run GREEN**

Run: `npx tsx --test tests/rolling-pattern-events.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/rolling-pattern-types.ts lib/rolling-pattern-events.ts tests/rolling-pattern-events.test.ts
git commit -m "feat: split rolling pattern result scopes"
```

### Task 2: 让规则引擎分别冻结两个结果域

**Files:**
- Modify: `lib/rolling-pattern-engine.ts`
- Modify: `lib/rolling-pattern-store.ts`
- Test: `tests/rolling-pattern-engine.test.ts`
- Test: `tests/rolling-pattern-store.test.ts`

**Interfaces:**
- Consumes: Task 1 scoped event functions.
- Produces: one `RollingPatternRun` containing signals tagged by `rule.event.scope` and engine version v3.

- [ ] **Step 1: Write failing engine tests**

```ts
test("build stores both scopes without unsupported targets", async () => {
  const run = await buildRollingPatternRun(FIXTURE_INPUT);
  assert.ok(run.signals.some((signal) => signal.rule.event.scope === "coverage_6_plus_1"));
  assert.ok(run.signals.some((signal) => signal.rule.event.scope === "special"));
  assert.ok(run.signals.every((signal) =>
    signal.rule.event.scope === "special" || ["zodiac", "tail"].includes(signal.rule.event.family)
  ));
});
```

- [ ] **Step 2: Run RED**

Run: `npx tsx --test tests/rolling-pattern-engine.test.ts tests/rolling-pattern-store.test.ts`
Expected: FAIL because generated rules use one shared event list and v2.

- [ ] **Step 3: Implement dual-scope generation**

Generate antecedents only from condition events, generate targets separately for both scopes, index condition and result states independently, include scope in canonical JSON, apply diversity caps per scoped result ID, and bump the engine constant to `conditional-patterns-v3`.

- [ ] **Step 4: Run GREEN**

Run: `npx tsx --test tests/rolling-pattern-engine.test.ts tests/rolling-pattern-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/rolling-pattern-engine.ts lib/rolling-pattern-store.ts tests/rolling-pattern-engine.test.ts tests/rolling-pattern-store.test.ts
git commit -m "feat: freeze dual-scope rolling patterns"
```

### Task 3: 增加结果域读取、命中率排序和结果筛选

**Files:**
- Modify: `lib/rolling-pattern-summary.ts`
- Modify: `app/api/research/patterns/route.ts`
- Test: `tests/rolling-pattern-summary.test.ts`
- Test: `tests/rendered-html.test.mjs`

**Interfaces:**
- Produces: `GET /api/research/patterns?game=<id>&scope=<scope>&family=<family>&result=<eventId>&page=<n>`
- Guarantees: summary is computed before `result` filtering; `resultGroups` sorted by hit rate descending.

- [ ] **Step 1: Write failing summary and API tests**

```ts
test("result groups sort by hit rate before support counts", () => {
  const summary = summarizeRollingPatterns([LOW_RATE_HIGH_SUPPORT, HIGH_RATE_LOW_SUPPORT]);
  assert.equal(summary.resultGroups[0].eventId, HIGH_RATE_LOW_SUPPORT.rule.event.eventId);
});
```

Add route cases proving `scope=special` excludes coverage signals and `result=<id>` narrows only `signals`, not `summary.resultGroups`.

- [ ] **Step 2: Run RED**

Run: `npx tsx --test tests/rolling-pattern-summary.test.ts && node --test tests/rendered-html.test.mjs`
Expected: FAIL on old sorting and rejected scope/result parameters.

- [ ] **Step 3: Implement validation and filter order**

Validate scopes and scope-allowed families, filter `envelope.signals` by scope then family, compute `summary`, validate `result` against that filtered set, apply result filter, and paginate. Change summary label to `event.value` and sorting to hit rate, trigger count, strategy count, uplift, then label.

- [ ] **Step 4: Run GREEN**

Run: `npx tsx --test tests/rolling-pattern-summary.test.ts && node --test tests/rendered-html.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/rolling-pattern-summary.ts app/api/research/patterns/route.ts tests/rolling-pattern-summary.test.ts tests/rendered-html.test.mjs
git commit -m "feat: filter rolling patterns by result scope"
```

### Task 4: 重构独立页面交互与样式

**Files:**
- Modify: `app/patterns/RollingPatternWorkspace.tsx`
- Modify: `app/research/ResearchWorkspace.tsx`
- Modify: `app/research/review/ResearchReviewWorkspace.tsx`
- Modify: `app/globals.css`
- Test: `tests/rendered-html.test.mjs`

**Interfaces:**
- Consumes: Task 3 API query contract.
- Produces: standalone `/patterns` UI with scope switch, context-aware family filters, clickable summary result filtering and yellow short result labels.

- [ ] **Step 1: Write failing rendered behavior tests**

Add assertions that `/patterns` exposes both scope labels and no shared “研究页面” navigation, while `/research` and `/research/review` do not link `/patterns` inside their shared switch. Assert summary cards are buttons with selected state plumbing.

- [ ] **Step 2: Run RED**

Run: `node --test tests/rendered-html.test.mjs`
Expected: FAIL because current page still uses the three-way navigation and non-clickable summary cards.

- [ ] **Step 3: Implement the client state and markup**

Add `scope` and `resultEventId` state; include both in request keys and query strings; reset result/page when game, scope, or family changes; use only `全部/生肖/尾数` for coverage and all four families for special. Render result summaries as buttons with `aria-pressed`, pass the selected ID to the panel, and show full rule wording plus a yellow short `event.value` result.

- [ ] **Step 4: Implement responsive styling**

Reuse the existing dark/gold visual language, add only font-color emphasis to short results, give scope buttons and result buttons clear focus/selected states, and collapse grids at 720px and 420px without horizontal scrolling.

- [ ] **Step 5: Run GREEN**

Run: `node --test tests/rendered-html.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/patterns/RollingPatternWorkspace.tsx app/research/ResearchWorkspace.tsx app/research/review/ResearchReviewWorkspace.tsx app/globals.css tests/rendered-html.test.mjs
git commit -m "feat: add independent dual-scope pattern workspace"
```

### Task 5: 全量验证、构建与发布

**Files:**
- Verify: all changed source and tests
- Package: Sites deployment archive generated from validated build

**Interfaces:**
- Produces: deployed `c308868584` Sites version at the existing production URL.

- [ ] **Step 1: Run the complete test suite**

Run: `npm test`
Expected: all suites pass with zero failures.

- [ ] **Step 2: Run lint and production build**

Run: `npm run lint && npm run build`
Expected: exit 0; no new lint errors; Cloudflare-compatible output exists.

- [ ] **Step 3: Inspect the final diff**

Run: `git diff HEAD~4 --check && git status --short`
Expected: no whitespace errors; only intended plan, source, tests and generated hosting metadata changes.

- [ ] **Step 4: Publish through Sites**

Package the successful build using the Sites helper, save one version against the existing project ID, deploy it publicly using the user’s standing authorization, and poll until deployment succeeds.

- [ ] **Step 5: Verify the deployed page**

Open the exact deployed URL and confirm `/patterns` serves the newly deployed version. Do not trigger training from a page read; if no v3 frozen run exists yet, verify the intentional waiting state.

