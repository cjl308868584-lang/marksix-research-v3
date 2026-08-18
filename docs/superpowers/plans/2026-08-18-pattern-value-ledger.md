# 近30期规律逐期账本与赔率价值 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 冻结并逐期结算规律汇总，加入单肖、单尾、二连肖、三连肖及特码号码的赔率价值分析。

**Architecture:** 新建纯函数赔率引擎负责产品生成、联合审计、概率和期望收益；D1使用独立账本与结算表保证冻结快照和幂等结算；现有自动周期先结算旧期再冻结新期，API只读取冻结结果并聚合历史表现。

**Tech Stack:** Next.js 16、TypeScript、Cloudflare D1/SQLite、Drizzle、node:test、Sites。

**Spec:** `docs/superpowers/specs/2026-08-18-pattern-value-ledger-design.md`

## Global Constraints

- 不设置最少20期或FDR购买门槛。
- 二连肖含马净赔率2、不含马3；三连肖含马7、不含马9。
- 组合命中必须按同一期联合审计，不能相乘单项命中率。
- 冻结和结算均幂等；网页读取不能训练或改写快照。
- 不自动下注，不提供投注金额。

---

### Task 1: 赔率与产品纯函数

**Files:**
- Create: `lib/rolling-pattern-value.ts`
- Modify: `lib/rolling-pattern-types.ts`
- Test: `tests/rolling-pattern-value.test.ts`

**Interfaces:**
- Produces: `buildRollingPatternProducts(run)`, `settleRollingPatternProduct(product, draw, scoredAt)`, `summarizeProductPerformance(products, scores)`。

- [ ] 写失败测试，覆盖各赔率、盈亏平衡概率、二/三连肖联合审计、特码前15与单位期望收益。
- [ ] 运行 `node --test tests/rolling-pattern-value.test.ts` 并确认因模块缺失失败。
- [ ] 实现最小纯函数与类型；概率采用基线强度4的Beta收缩，组合按审计目标期交集。
- [ ] 重跑测试并确认通过。

### Task 2: D1冻结账本与幂等结算

**Files:**
- Modify: `db/schema.ts`
- Modify: `lib/research-v3-store.ts`
- Modify: `lib/rolling-pattern-store.ts`
- Modify: `lib/rolling-pattern-service.ts`
- Create: generated Drizzle migration
- Test: `tests/rolling-pattern-store.test.ts`

**Interfaces:**
- Consumes: `buildRollingPatternProducts`, `settleRollingPatternProduct`。
- Produces: `readRollingPatternValueLedger(game, issue?)` 与扩展后的冻结/结算生命周期。

- [ ] 扩展Fake D1并写失败测试：重复冻结不重复、缺失子记录可修复、重复结算不重复、只结算已冻结目标期。
- [ ] 运行目标测试并确认失败。
- [ ] 新增账本/结算表、查询索引和运行时建表语句。
- [ ] 在持久化运行时冻结产品，在旧期结算时写入产品评分；读取当前和历史记录。
- [ ] 生成并检查Drizzle迁移，运行目标测试通过。

### Task 3: API与赔率价值面板

**Files:**
- Modify: `app/api/research/patterns/route.ts`
- Modify: `app/patterns/RollingPatternWorkspace.tsx`
- Modify: `app/globals.css`
- Test: `tests/rendered-html.test.mjs`

**Interfaces:**
- Consumes: 当前冻结产品、产品评分和历史逐期表现。
- Produces: API字段 `valueAnalysis`、`settlementHistory`，页面赔率价值区和逐期汇总结算区。

- [ ] 写失败渲染测试，要求出现赔率价值、二连肖、三连肖、盈亏平衡、逐期汇总结算与命中/失败状态。
- [ ] 运行渲染测试确认失败。
- [ ] API返回选定scope的价值榜与历史；UI在原汇总上方渲染并保留现有筛选。
- [ ] 添加360px无横向溢出的响应式样式并运行渲染测试通过。

### Task 4: 全量验证与发布

**Files:**
- Modify: `README.md`（记录账本、赔率与计算口径）

**Interfaces:**
- Consumes: 完成的账本、API与页面。
- Produces: 可发布的Sites构建。

- [ ] 运行 `npm run typecheck`、`npm run test:ai`、`npm run test:research`、`npm run build`、部署测试与HTML测试。
- [ ] 检查迁移SQL每个prepare只有一条语句，确认唯一索引和查询索引正确。
- [ ] 使用Sites发布流程部署并验证线上 `/patterns` API与页面。
- [ ] 提交并推送分支，记录发布地址与验证结果。
