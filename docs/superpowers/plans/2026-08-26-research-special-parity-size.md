# 研究页特码单双与大小固定槽位 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `/research` 每期固定给出 6+1 生肖、6+1 尾数、特码单双、特码大小四个可复盘方向，并让新版特码学习与旧位置槽位完全隔离。

**Architecture:** 保留四槽位快照与开奖后评分流水线，但将当前槽位集合版本化为 `zodiac_6_plus_1`、`tail_6_plus_1`、`special_parity`、`special_size`。数据库允许同一目标期按引擎版本各保存一份不可变快照；当前预测、模型权重、晋级证据与表现统计只读取新版引擎，复盘列表继续兼容旧版位置槽位。

**Tech Stack:** TypeScript 5.9、React 19、Next/vinext、Cloudflare D1/SQLite、Node test runner、Python unittest、Cloudflare Sites

**Spec:** `docs/superpowers/specs/2026-08-25-research-special-parity-size-design.md`

## Global Constraints

- 当前四项名称固定为：`6+1生肖覆盖`、`6+1尾数覆盖`、`特码单双`、`特码大小`。
- 特码单双只能选择“特码单”或“特码双”；奇数为单，偶数为双。
- 特码大小只能选择“特码小”或“特码大”；1–24 为小，25–49 为大。
- 新槽位身份固定为 `special_parity` 和 `special_size`；旧 `position_parity`、`position_size` 只读兼容。
- 四张卡片始终显示冻结的 `predictionLabel`，但必须区分“正式验证方向”“本期验证方向·研究候选”“本期验证方向·基线记录”。
- 旧快照、结算、复盘和模型记录不得删除或改写。
- 同一目标期只有开奖前冻结的新版快照可结算；不得在开奖后补写该期方向。
- 公开页面只读取持久化冻结结果；持久化不可用时失败关闭，不在客户端生成方向。
- 不改变 6+1 生肖和尾数逻辑，不预测 01–49 精确号码。
- 不增加第三方依赖，不改变公开 API 的鉴权边界。

---

## File map

- `lib/research-v3-types.ts`：定义当前/旧版引擎、复盘版本与槽位类型边界。
- `lib/research-v3-engine.ts`：生成四个当前槽位候选、冻结方向、精确基线与命中语义。
- `lib/research-v3-review.ts`：按冻结槽位结算并生成新版复盘。
- `lib/research-v3-store.ts`：迁移 D1 唯一索引、读取当前快照、兼容旧复盘、隔离新版学习统计。
- `lib/research-v3-service.ts`：当前版本不存在时计算并追加新版快照，存在时保持不可变读取。
- `app/api/research/rules/route.ts`：只接受四个当前槽位作为规则查询参数。
- `app/research/ResearchWorkspace.tsx`：始终显示验证方向，并清楚标注证据状态。
- `app/research/page.tsx`、`app/LotteryDashboard.tsx`：同步当前四项文案。
- `research/src/marksix_research/cli.py`：健康检查与远端快照契约改为新版四槽位。
- `tests/research-v3.test.ts`：候选、边界、结算、版本和学习隔离测试。
- `tests/research-v3-store.test.ts`：D1 索引迁移、同一期双版本、当前读取与历史兼容测试。
- `tests/rendered-html.test.mjs`：研究页方向与文案契约测试。
- `research/tests/test_pipeline.py`：Python 自动化四槽位契约测试。

### Task 1: 建立当前槽位与旧槽位的类型/版本边界

**Files:**
- Modify: `lib/research-v3-types.ts:4-18, 100-210`
- Modify: `lib/research-v3-store.ts:1-20, 1265-1310`
- Test: `tests/research-v3-store.test.ts:70-150`

**Interfaces:**
- Consumes: 现有 `ResearchEventForecast`、`ResearchV3Snapshot`、`ResearchV3Review` 数据结构。
- Produces: `CURRENT_RESEARCH_EVENT_SLOTS`, `LEGACY_RESEARCH_EVENT_SLOTS`, `CurrentResearchEventSlot`, `ResearchEventSlot`, `isCurrentResearchV3Snapshot(value)`，以及能读取 v3.0/v3.1/v3.2 快照和 v3/v4 复盘的验证器。

- [ ] **Step 1: 写版本与槽位验证的失败测试**

在 `tests/research-v3-store.test.ts` 扩展模块类型并增加测试，明确新版只接受固定四项、旧版仍可读、未知版本拒绝：

```ts
type StoreModule = {
  // 保留现有声明
  isResearchV3Snapshot(value: unknown): boolean;
  isCurrentResearchV3Snapshot(value: unknown): boolean;
};

test("v3.2 requires the two special-only slots while v3.1 stays readable", () => {
  const current = snapshotFixture({
    engineVersion: "high-probability-events-v3.2",
    modelVersion: "champion-challenger-v3.2-deadbeef",
    reviewVersion: "research-event-review-v4",
    slots: ["zodiac_6_plus_1", "tail_6_plus_1", "special_parity", "special_size"],
  });
  const prior = snapshotFixture({
    engineVersion: "high-probability-events-v3.1",
    modelVersion: "champion-challenger-v3.1-deadbeef",
    reviewVersion: "research-event-review-v3",
    slots: ["zodiac_6_plus_1", "tail_6_plus_1", "position_parity", "position_size"],
  });

  assert.equal(store.isResearchV3Snapshot(current), true);
  assert.equal(store.isCurrentResearchV3Snapshot(current), true);
  assert.equal(store.isResearchV3Snapshot(prior), true);
  assert.equal(store.isCurrentResearchV3Snapshot(prior), false);
  assert.equal(store.isResearchV3Snapshot({
    ...current,
    events: current.events.map((event: any, index: number) =>
      index === 2 ? { ...event, slot: "position_parity" } : event
    ),
  }), false);
  assert.equal(store.isResearchV3Snapshot({
    ...current,
    frozenAt: current.expectedDrawAt,
  }), false);
});
```

`snapshotFixture` 必须生成四个带 `eventId`、`slot`、`probability: 0.5`、`baselineProbability: 0.5` 的最小合法事件，避免测试只验证版本字符串而遗漏槽位集合。

- [ ] **Step 2: 运行测试，确认当前代码拒绝 v3.2**

Run: `node --test tests/research-v3-store.test.ts --test-name-pattern="v3.2 requires"`

Expected: FAIL，`isCurrentResearchV3Snapshot` 尚未导出或 v3.2 被现有验证器拒绝。

- [ ] **Step 3: 实现明确的版本常量、槽位集合与版本配对验证**

在 `lib/research-v3-types.ts` 使用以下公开边界：

```ts
export const RESEARCH_V3_ENGINE_VERSION = "high-probability-events-v3.2" as const;
export const RESEARCH_V3_MODEL_VERSION = "champion-challenger-v3.2" as const;
export const RESEARCH_V3_REVIEW_VERSION = "research-event-review-v4" as const;
export const RESEARCH_V3_PRIOR_ENGINE_VERSION = "high-probability-events-v3.1" as const;
export const RESEARCH_V3_PRIOR_MODEL_VERSION = "champion-challenger-v3.1" as const;
export const RESEARCH_V3_PRIOR_REVIEW_VERSION = "research-event-review-v3" as const;
export const RESEARCH_V3_LEGACY_ENGINE_VERSION = "high-probability-events-v3.0" as const;
export const RESEARCH_V3_LEGACY_MODEL_VERSION = "champion-challenger-v3.0" as const;

export const CURRENT_RESEARCH_EVENT_SLOTS = [
  "zodiac_6_plus_1",
  "tail_6_plus_1",
  "special_parity",
  "special_size",
] as const;
export const LEGACY_RESEARCH_EVENT_SLOTS = [
  "zodiac_6_plus_1",
  "tail_6_plus_1",
  "position_parity",
  "position_size",
] as const;

export type CurrentResearchEventSlot = typeof CURRENT_RESEARCH_EVENT_SLOTS[number];
export type LegacyResearchEventSlot = typeof LEGACY_RESEARCH_EVENT_SLOTS[number];
export type ResearchEventSlot = CurrentResearchEventSlot | LegacyResearchEventSlot;
```

在 `lib/research-v3-store.ts` 让 `isResearchV3Snapshot` 先验证版本配对，再验证对应的精确槽位顺序；不要只用 `startsWith` 接受任意引擎/模型组合。验证器还必须要求 `frozenAt`、`expectedDrawAt` 为有效时间，且 `frozenAt < expectedDrawAt`，使开奖后生成的快照无法进入不可变账本：

```ts
export function isCurrentResearchV3Snapshot(value: unknown): value is ResearchV3Snapshot {
  return isResearchV3Snapshot(value) &&
    value.engineVersion === RESEARCH_V3_ENGINE_VERSION;
}

function slotsMatch(events: Array<{ slot?: unknown }>, expected: readonly string[]) {
  return events.length === expected.length &&
    events.every((event, index) => event.slot === expected[index]);
}
```

`ResearchV3Snapshot.engineVersion` 要包含 v3.2、v3.1、v3.0；`ResearchV3Review.reviewVersion` 要包含 v4 与 v3，以便旧复盘解析。

- [ ] **Step 4: 运行类型与定向测试**

Run: `npm run typecheck && node --test tests/research-v3-store.test.ts`

Expected: PASS；v3.2 当前快照、v3.1/v3.0 历史快照可区分，未知版本继续拒绝。

- [ ] **Step 5: 提交类型边界**

```bash
git add lib/research-v3-types.ts lib/research-v3-store.ts tests/research-v3-store.test.ts
git commit -m "refactor: version research event slots"
```

### Task 2: 迁移不可变快照身份并优先读取当前引擎

**Files:**
- Modify: `lib/research-v3-store.ts:25-125, 700-718, 977-1060`
- Modify: `lib/research-v3-service.ts:130-205, 220-255`
- Test: `tests/research-v3-store.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `RESEARCH_V3_ENGINE_VERSION` 与 `isCurrentResearchV3Snapshot`。
- Produces: `readResearchV3Snapshot(game, targetIssue?, scope?)`，其中 `scope` 为 `"current" | "any"` 且默认 `"current"`；D1 唯一身份为 `(game, target_issue, engine_version)`。

- [ ] **Step 1: 写同一期双版本与当前优先读取的失败测试**

扩展 `FakeTaskD1`，让它保存 `research_v3_forecasts` 行并响应索引 DDL、插入和读取。增加以下行为测试：

```ts
test("the ledger preserves an old engine row and appends one current row for the same issue", async () => {
  const db = new FakeResearchD1();
  testRuntime.__marksixD1 = db;
  delete testRuntime.__marksixResearchV3SchemaReady;

  const prior = snapshotFixture({
    runId: "prior-run",
    targetIssue: "2026237",
    engineVersion: "high-probability-events-v3.1",
    modelVersion: "champion-challenger-v3.1-deadbeef",
    slots: ["zodiac_6_plus_1", "tail_6_plus_1", "position_parity", "position_size"],
  });
  const current = snapshotFixture({
    runId: "current-run",
    targetIssue: "2026237",
    engineVersion: "high-probability-events-v3.2",
    modelVersion: "champion-challenger-v3.2-deadbeef",
    slots: ["zodiac_6_plus_1", "tail_6_plus_1", "special_parity", "special_size"],
  });

  assert.equal(await store.persistResearchV3Snapshot(prior), "created");
  assert.equal(await store.persistResearchV3Snapshot(current), "created");
  assert.equal(db.forecasts.size, 2);
  assert.equal((await store.readResearchV3Snapshot("new_macau", "2026237"))?.runId, "current-run");
  assert.equal((await store.readResearchV3Snapshot("new_macau", "2026237", "any"))?.runId, "prior-run");
});
```

另加迁移断言：执行 schema repair 后存在 `research_v3_forecast_engine_identity_idx`，旧 `research_v3_forecast_identity_idx` 已移除，快照行数不变。

- [ ] **Step 2: 运行测试，确认旧唯一键阻止第二份快照**

Run: `node --test tests/research-v3-store.test.ts --test-name-pattern="preserves an old engine|schema repair"`

Expected: FAIL；旧索引仍以 `(game, target_issue)` 唯一，且读取器没有 `scope`。

- [ ] **Step 3: 实现无损索引迁移与版本化读取**

将 schema 中旧索引替换为：

```sql
DROP INDEX IF EXISTS research_v3_forecast_identity_idx;
CREATE UNIQUE INDEX IF NOT EXISTS research_v3_forecast_engine_identity_idx
  ON research_v3_forecasts (game, target_issue, engine_version);
```

保留 `run_id` 主键，不更新任何已有行。修改读取器：

```ts
export async function readResearchV3Snapshot(
  game: GameId,
  targetIssue?: string | null,
  scope: "current" | "any" = "current",
): Promise<ResearchV3Snapshot | null> {
  // scope === "current" 时 SQL 必须包含 engine_version = RESEARCH_V3_ENGINE_VERSION。
  // scope === "any" 时保持 frozen_at ASC, run_id ASC，供迁移/历史读取使用。
}
```

`persistResearchV3Snapshot` 继续 `INSERT OR IGNORE`，但冲突身份变为同一引擎同一期。`lib/research-v3-service.ts` 的生产读取保持默认 `current`，`importLegacySnapshot` 显式使用 `"any"`，从而不会因当前读取不到旧快照而重复导入。若当期仅有旧 v3.1，签名任务会在下一目标期开奖前生成 v3.2；`nextScheduledDraw` 与已验证最新期开奖共同保证不会回填已经开奖的目标期。

同时将以下学习查询限制到当前引擎：

```sql
-- countSettledResearchV3Forecasts
WHERE game = ? AND engine_version = ? AND settled_at IS NOT NULL

-- readChampionEvidenceRows
JOIN research_v3_forecasts f ON f.run_id = mw.run_id
WHERE mw.game = ? AND f.engine_version = ?

-- readPersistedFormalChampion
JOIN research_v3_forecasts f ON f.run_id = research_learning_runs.run_id
WHERE research_learning_runs.game = ? AND f.engine_version = ?
```

所有查询绑定 `RESEARCH_V3_ENGINE_VERSION`；这使旧位置槽位无法通过全局 champion 状态间接影响新引擎。

- [ ] **Step 4: 运行存储、服务与类型回归**

Run: `npm run typecheck && node --test tests/research-v3-store.test.ts tests/research-v3.test.ts`

Expected: PASS；同一期可保留两种引擎，默认只返回 v3.2，旧行仍能通过历史路径读取。

- [ ] **Step 5: 提交持久化迁移**

```bash
git add lib/research-v3-store.ts lib/research-v3-service.ts tests/research-v3-store.test.ts
git commit -m "feat: isolate current research snapshots"
```

### Task 3: 将后两项候选与结算固定到特码

**Files:**
- Modify: `lib/research-v3-engine.ts:145-230, 380-445, 980-1050`
- Modify: `lib/research-v3-review.ts:40-90`
- Test: `tests/research-v3.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `CurrentResearchEventSlot` 与 `CURRENT_RESEARCH_EVENT_SLOTS`。
- Produces: 当前快照槽位顺序 `[zodiac_6_plus_1, tail_6_plus_1, special_parity, special_size]`；`special_parity`/`special_size` 的 scope 永远为 `special`。

- [ ] **Step 1: 写候选集、边界和正码不干扰结算的失败测试**

在 `tests/research-v3.test.ts` 将首个槽位断言改为新四项，并增加：

```ts
test("special-only slots never select a main-number position", () => {
  const snapshot = buildSnapshot({
    game: "new_macau",
    draws: makeHistory(160),
    targetIssue: "2026999",
    expectedDrawAt: "2026-10-01T21:32:32+08:00",
    generatedAt: "2026-09-30T10:00:00.000Z",
  });
  const parity = snapshot.events.find((event: any) => event.slot === "special_parity");
  const size = snapshot.events.find((event: any) => event.slot === "special_size");
  assert.equal(parity.scope, "special");
  assert.equal(size.scope, "special");
  assert.match(parity.predictionLabel, /^下一期：特码(单|双)$/);
  assert.match(size.predictionLabel, /^下一期：特码(大|小)$/);
  assert.doesNotMatch(JSON.stringify([parity, size]), /main\.position/);
});

test("special parity and size use exact 01-49 boundaries", () => {
  assert.equal(baseline("special", "parity", "单", "2026-10-01T21:32:32+08:00"), 25 / 49);
  assert.equal(baseline("special", "parity", "双", "2026-10-01T21:32:32+08:00"), 24 / 49);
  assert.equal(baseline("special", "size", "大", "2026-10-01T21:32:32+08:00"), 25 / 49);
  assert.equal(baseline("special", "size", "小", "2026-10-01T21:32:32+08:00"), 24 / 49);
});

test("changing main numbers cannot change special slot settlement", () => {
  const snapshot = buildSnapshot({
    game: "new_macau",
    draws: makeHistory(160),
    targetIssue: "2026999",
    expectedDrawAt: "2026-10-01T21:32:32+08:00",
    generatedAt: "2026-09-30T10:00:00.000Z",
  });
  const drawA = verifiedDraw({ issue: "2026999", numbers: [1, 2, 3, 4, 5, 6], special: 25 });
  const drawB = verifiedDraw({ issue: "2026999", numbers: [44, 45, 46, 47, 48, 49], special: 25 });
  const settledA = buildReview(snapshot, drawA, "2026-10-01T22:00:00+08:00");
  const settledB = buildReview(snapshot, drawB, "2026-10-01T22:00:00+08:00");
  for (const slot of ["special_parity", "special_size"]) {
    assert.equal(
      settledA.events.find((event: any) => event.slot === slot).actualMatched,
      settledB.events.find((event: any) => event.slot === slot).actualMatched,
    );
  }
});
```

再用特码 24/25 各生成一条复盘，断言 24=`双+小`、25=`单+大`。

- [ ] **Step 2: 运行测试，确认引擎仍会选择正码位置**

Run: `node --test tests/research-v3.test.ts --test-name-pattern="special-only|exact 01-49|changing main"`

Expected: FAIL；快照仍返回 `position_parity`/`position_size` 或 scope 为 `main.position.*`。

- [ ] **Step 3: 最小修改候选生成、标签和命中函数**

在 `buildResearchV3Snapshot` 使用当前槽位常量，且后两类候选只生成：

```ts
const fixedCandidates: ResearchCandidate[] = [
  { slot: "special_parity", scope: "special", family: "parity", value: "单" },
  { slot: "special_parity", scope: "special", family: "parity", value: "双" },
  { slot: "special_size", scope: "special", family: "size", value: "小" },
  { slot: "special_size", scope: "special", family: "size", value: "大" },
];
```

删除当前候选管线中为 `main.position.1` 至 `main.position.6` 生成单双/大小的循环，但保留 `ResearchEventScope` 的旧位置类型供历史快照展示。更新标签：

```ts
const labels: Record<CurrentResearchEventSlot, string> = {
  zodiac_6_plus_1: "6+1生肖覆盖",
  tail_6_plus_1: "6+1尾数覆盖",
  special_parity: "特码单双",
  special_size: "特码大小",
};
```

`predictionLabel` 对后两项分别输出 `下一期：特码${value}`；结算读取 scope 时继续让 `special` 返回 `[draw.special]`，从而 24 为双/小、25 为单/大。

- [ ] **Step 4: 运行引擎与复盘测试**

Run: `npm run typecheck && node --test tests/research-v3.test.ts`

Expected: PASS；四项齐全，后两项没有任何 `main.position.*` 候选，边界和结算全部正确。

- [ ] **Step 5: 提交引擎语义**

```bash
git add lib/research-v3-engine.ts lib/research-v3-review.ts tests/research-v3.test.ts
git commit -m "feat: predict special parity and size"
```

### Task 4: 隔离新版在线学习与表现统计，同时保留旧复盘

**Files:**
- Modify: `lib/research-v3-store.ts:250-380, 790-920, 977-1155`
- Modify: `lib/research-v3-review.ts:1-110`
- Test: `tests/research-v3-store.test.ts`
- Test: `tests/research-v3.test.ts`

**Interfaces:**
- Consumes: 当前引擎过滤查询、`special_parity`/`special_size` 事件。
- Produces: `readResearchV3Reviews(game, limit, scope?)`，默认历史复盘用 `"all"`；`readResearchV3Performance(game)` 只聚合当前引擎；结算只更新快照自身的槽位。

- [ ] **Step 1: 写旧权重不进入新版和旧复盘仍可读的失败测试**

增加两个存储测试：

```ts
test("current performance and champion evidence exclude prior-engine rows", async () => {
  const db = seededVersionedResearchD1({
    prior: settledSnapshotFixture("high-probability-events-v3.1", [
      "zodiac_6_plus_1", "tail_6_plus_1", "position_parity", "position_size",
    ]),
    current: settledSnapshotFixture("high-probability-events-v3.2", [
      "zodiac_6_plus_1", "tail_6_plus_1", "special_parity", "special_size",
    ]),
  });
  testRuntime.__marksixD1 = db;
  const performance = await store.readResearchV3Performance("new_macau");
  assert.deepEqual(performance.slots.map((slot: any) => slot.slot), [
    "zodiac_6_plus_1", "tail_6_plus_1", "special_parity", "special_size",
  ]);
  assert.equal(performance.settledForecasts, 1);
});

test("the audit reader keeps prior and current reviews without rewriting either", async () => {
  const reviews = await store.readResearchV3Reviews("new_macau", 10, "all");
  assert.equal(reviews.length, 2);
  assert.deepEqual(reviews.map((review: any) => review.reviewVersion).sort(), [
    "research-event-review-v3", "research-event-review-v4",
  ]);
});
```

在引擎测试中以 `previousWeights` 只传 `position_parity`/`position_size` 极端权重，断言新 `special_*` 专家权重仍为默认值。

- [ ] **Step 2: 运行测试，确认性能与 champion 仍混合旧期**

Run: `node --test tests/research-v3-store.test.ts tests/research-v3.test.ts --test-name-pattern="exclude prior-engine|keeps prior|extreme"`

Expected: FAIL；现有 `readResearchV3Performance` 读取全部版本，champion 查询也未按引擎过滤。

- [ ] **Step 3: 实现当前学习过滤与历史审计双通道**

实现：

```ts
export async function readResearchV3Reviews(
  game: GameId,
  limit = 50,
  scope: "current" | "all" = "all",
): Promise<ResearchV3Review[]>;

export async function readResearchV3Performance(game: GameId) {
  const reviews = await readResearchV3Reviews(game, 100, "current");
  return buildResearchV3Performance(game, reviews);
}
```

`scope === "current"` 的 SQL 增加 `engine_version = ?`；复盘页沿用默认 `all`。`readLatestModelWeights` 与 `readResearchRuleStates` 只把 `CURRENT_RESEARCH_EVENT_SLOTS` 中的行放入返回对象，即使数据库存在旧槽位，也不会交给新版引擎。`settleResearchV3Forecasts` 对每个未结算快照按其自身版本生成对应 reviewVersion，并且 champion 证据只查询该快照引擎；v3.1 历史若已冻结仍按旧语义结算，v3.2 只更新 `special_*` 状态。

复盘构建器按 snapshot 引擎选择版本：

```ts
const reviewVersion = snapshot.engineVersion === RESEARCH_V3_ENGINE_VERSION
  ? RESEARCH_V3_REVIEW_VERSION
  : RESEARCH_V3_PRIOR_REVIEW_VERSION;
```

不可把旧 `position_*` 名称映射成 `special_*`；旧记录必须保持原始 `slot`、`scopeLabel` 与 `prediction`。

- [ ] **Step 4: 运行学习与复盘定向测试**

Run: `npm run typecheck && node --test tests/research-v3.test.ts tests/research-v3-store.test.ts`

Expected: PASS；当前统计只含 v3.2，新旧复盘都可读，旧权重不会进入新版槽位。

- [ ] **Step 5: 提交学习隔离**

```bash
git add lib/research-v3-store.ts lib/research-v3-review.ts tests/research-v3-store.test.ts tests/research-v3.test.ts
git commit -m "fix: isolate special-slot learning history"
```

### Task 5: 更新研究 API 与自动化契约

**Files:**
- Modify: `app/api/research/rules/route.ts:1-40`
- Modify: `research/src/marksix_research/cli.py:400-430`
- Modify: `research/tests/test_pipeline.py:450-490, 900-925, 1155-1180`
- Modify: `tests/rendered-html.test.mjs:250-290`

**Interfaces:**
- Consumes: `CURRENT_RESEARCH_EVENT_SLOTS` 与 v3.2 快照。
- Produces: 规则 API 只接受当前四槽位；Python 自动化要求后两项 slot/scope 为 `special_parity/special` 与 `special_size/special`。

- [ ] **Step 1: 写 API 与 Python 契约失败测试**

在 `tests/rendered-html.test.mjs` 对规则路由源码断言：

```js
assert.match(rulesRoute, /CURRENT_RESEARCH_EVENT_SLOTS/);
assert.doesNotMatch(rulesRoute, /"position_parity"/);
assert.doesNotMatch(rulesRoute, /"position_size"/);
```

将 `research/tests/test_pipeline.py` 的期望槽位改为：

```py
self.assertEqual(
    [event["slot"] for event in snapshot["events"]],
    ["zodiac_6_plus_1", "tail_6_plus_1", "special_parity", "special_size"],
)
self.assertEqual(snapshot["events"][2]["scope"], "special")
self.assertEqual(snapshot["events"][3]["scope"], "special")
```

- [ ] **Step 2: 运行契约测试，确认旧槽位仍被要求**

Run: `PYTHONPATH=research/src python3 -m unittest research.tests.test_pipeline -v && node --test tests/rendered-html.test.mjs --test-name-pattern="research"`

Expected: FAIL；CLI 与规则 API 仍列出 `position_parity`、`position_size`。

- [ ] **Step 3: 使用共享当前槽位集合并校验特码 scope**

`app/api/research/rules/route.ts` 改为：

```ts
import {
  CURRENT_RESEARCH_EVENT_SLOTS,
  type CurrentResearchEventSlot,
} from "../../../../lib/research-v3-types";

const SLOTS = new Set<CurrentResearchEventSlot>(CURRENT_RESEARCH_EVENT_SLOTS);
```

Python CLI 的远端快照校验必须同时验证顺序和 scope：

```py
expected_slots = (
    "zodiac_6_plus_1",
    "tail_6_plus_1",
    "special_parity",
    "special_size",
)
if tuple(event.get("slot") for event in events) != expected_slots:
    raise ResearchPipelineError("远端冻结快照不是当前四槽位")
if events[2].get("scope") != "special" or events[3].get("scope") != "special":
    raise ResearchPipelineError("特码单双/大小范围不是特码")
```

- [ ] **Step 4: 运行 Python、API 与类型测试**

Run: `npm run typecheck && npm run test:research && node --test tests/rendered-html.test.mjs --test-name-pattern="research"`

Expected: PASS；签名学习任务和健康检查不会接受旧位置槽位冒充当前预测。

- [ ] **Step 5: 提交外部契约**

```bash
git add app/api/research/rules/route.ts research/src/marksix_research/cli.py research/tests/test_pipeline.py tests/rendered-html.test.mjs
git commit -m "chore: update research slot contracts"
```

### Task 6: 研究页始终显示冻结方向与诚实证据状态

**Files:**
- Modify: `app/research/ResearchWorkspace.tsx:55-90, 185-255`
- Modify: `app/research/page.tsx`
- Modify: `app/LotteryDashboard.tsx`
- Modify: `tests/rendered-html.test.mjs:60-95`

**Interfaces:**
- Consumes: `ResearchEventForecast.predictionLabel`、`decisionStatus`、`probability`、`experimentalProbability`、`baselineProbability`。
- Produces: 每张卡片主标题始终为冻结方向；三种证据状态具有不同标签和概率说明。

- [ ] **Step 1: 写三种状态都必须显示方向的失败测试**

将现有“正式弃权”源码断言替换为明确的 UI helper 契约。在 `ResearchWorkspace.tsx` 导出纯函数：

```ts
export function eventDisplay(event: ResearchEventForecast) {
  const status = event.decisionStatus ?? (
    event.evidenceTier === "verified" ? "formal" : "abstain"
  );
  if (status === "formal") {
    return { status, badge: "正式验证方向", probability: event.probability, probabilityLabel: "正式模型概率" };
  }
  if (status === "research_candidate") {
    return { status, badge: "本期验证方向·研究候选", probability: event.experimentalProbability, probabilityLabel: "校准候选概率" };
  }
  return { status, badge: "本期验证方向·基线记录", probability: event.probability, probabilityLabel: "正式基线概率" };
}
```

在 `tests/rendered-html.test.mjs` 断言源码包含三种 badge、标题为 `event.predictionLabel`，并且不再包含：

```js
assert.match(workspace, /<h2>\{event\.predictionLabel\}<\/h2>/);
assert.match(workspace, /本期验证方向·研究候选/);
assert.match(workspace, /本期验证方向·基线记录/);
assert.match(workspace, /正式验证方向/);
assert.doesNotMatch(workspace, /正式层暂无已验证方向/);
assert.doesNotMatch(workspace, /不向本期给出方向/);
```

- [ ] **Step 2: 运行渲染契约，确认旧页面仍隐藏方向**

Run: `node --test tests/rendered-html.test.mjs --test-name-pattern="research UI"`

Expected: FAIL；页面仍用“正式层暂无已验证方向”覆盖主标题。

- [ ] **Step 3: 实现统一方向标题、状态 badge 和概率轨道**

`EventCard` 先调用 `eventDisplay(event)`，主区域使用：

```tsx
const display = eventDisplay(event);

<span>{display.badge}</span>
<h2>{event.predictionLabel}</h2>
<p>{event.scopeLabel} · {evidenceLabel(event.evidenceTier)}</p>

<div className="v3-probability">
  <strong>{percent(display.probability)}</strong>
  <span>{display.probabilityLabel}</span>
</div>
```

概率轨道宽度使用 `display.probability`，随机基线标记继续使用 `event.baselineProbability`。研究候选说明固定为“开奖前冻结供逐期验证，尚未达到正式晋级门槛”；基线记录说明固定为“模型尚未证明优于随机基线，本期仍保存该方向供客观结算”。不得使用“主动弃权”或“不提供方向”。

同步页面文案：

```tsx
每期固定冻结 6+1生肖、6+1尾数、特码单双、特码大小四个方向。
开奖后全部交卷，再更新规则、模型权重和下一期概率。
```

`app/research/page.tsx` metadata 和首页入口删除当前功能中的“指定位置单双与大小”，但不要修改历史复盘里的旧记录文案。

- [ ] **Step 4: 运行渲染、类型与生产构建**

Run: `npm run typecheck && node --test tests/rendered-html.test.mjs && npm run build`

Expected: PASS；服务端渲染仍成功，当前研究页不再隐藏任何冻结方向，也不把研究候选称为正式优势。

- [ ] **Step 5: 提交页面变更**

```bash
git add app/research/ResearchWorkspace.tsx app/research/page.tsx app/LotteryDashboard.tsx tests/rendered-html.test.mjs
git commit -m "feat: always show research validation directions"
```

### Task 7: 全量验证、浏览器验收与发布

**Files:**
- Modify only if a verification failure exposes a defect in files already listed above.
- Verify: `docs/superpowers/specs/2026-08-25-research-special-parity-size-design.md`
- Verify: `docs/superpowers/plans/2026-08-26-research-special-parity-size.md`

**Interfaces:**
- Consumes: Tasks 1–6 的完整实现。
- Produces: 通过全量测试的生产构建，以及已发布并在 `/research`、`/research/review` 验收的版本。

- [ ] **Step 1: 运行完整静态、Node、Python、构建与部署检查**

Run: `npm test`

Expected: exit code 0；`typecheck`、`test:ai`、`test:research`、`build`、`test:deployment`、`rendered-html` 全部 PASS。

- [ ] **Step 2: 检查变更范围与禁用词**

Run:

```bash
git diff --check
rg -n "正式层暂无已验证方向|不向本期给出方向|position_parity|position_size" app/research app/api/research research/src/marksix_research/cli.py
git status --short
```

Expected: `git diff --check` 无输出；`rg` 在当前页面/API/CLI 无命中；`git status` 只显示本计划范围内的预期文件。

- [ ] **Step 3: 本地浏览器验收四种核心行为**

Run: `npm run dev`

在本地 `/research` 验收：

```text
1. 四张卡片依次为 6+1生肖覆盖、6+1尾数覆盖、特码单双、特码大小。
2. 第3、4张卡片范围都是“特码”，方向分别只可能是单/双与大/小。
3. 所有卡片都有具体主标题；研究候选或基线记录有明确未验证说明。
4. 切换新澳门六合彩与香港六合彩后仍满足以上三点。
```

在本地 `/research/review` 打开一条旧 v3.1 复盘与一条新 v3.2 复盘，确认旧位置预测保持原标签，新版显示特码标签，二者均有冻结方向与开奖结果。

Expected: 四项显示、证据标签、旧新复盘兼容全部符合设计说明。

- [ ] **Step 4: 使用 Sites 发布并检查线上数据契约**

按 `sites:sites-hosting` 技能执行发布。发布后请求：

```text
/api/research/forecast?game=new_macau
/api/research/forecast?game=hk
/research
/research/review
```

Expected: 两个 forecast 响应的 `events[].slot` 精确为四个当前槽位，后两项 `scope` 都是 `special`；页面可见具体方向；旧复盘仍可打开。若当前目标期已有 v3.1 快照且尚未开奖，确认数据库额外保存 v3.2 行而不是覆盖旧行；若已开奖，只从下一目标期开始出现 v3.2。

- [ ] **Step 5: 提交验收中必要的最终修正并记录结果**

若 Step 1–4 未产生代码修正，不创建空提交；否则只提交为通过验收所做的范围内修正：

```bash
git add lib/research-v3-types.ts lib/research-v3-engine.ts lib/research-v3-review.ts lib/research-v3-store.ts lib/research-v3-service.ts app/api/research/rules/route.ts app/research/ResearchWorkspace.tsx app/research/page.tsx app/LotteryDashboard.tsx research/src/marksix_research/cli.py research/tests/test_pipeline.py tests/research-v3.test.ts tests/research-v3-store.test.ts tests/rendered-html.test.mjs
git commit -m "fix: complete special-slot rollout verification"
```

最终交付记录必须列出 `npm test` 的实际通过结果、发布 URL、线上四槽位、两个特码 scope，以及旧复盘兼容检查结果。
