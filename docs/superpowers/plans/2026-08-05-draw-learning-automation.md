# 开奖后逐期学习自动化修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将开奖后模型更新改为北京时间 21:40、21:50、22:04 三次幂等触发，并确保每次使用最新数据、彩种隔离、严格验证目标期推进。

**Architecture:** GitHub Actions 使用 matrix 将香港和新澳门拆成独立任务，每个任务执行一次“重新同步→生成研究制品→签名结算→健康检查”的快速周期。Python CLI 提供可单测的单彩种周期和健康检查；未核验属于正常等待，已核验但预测未推进属于故障。

**Tech Stack:** GitHub Actions、Python 3.12、urllib、现有 Sites HMAC 写入接口、Node/Vinext 测试套件。

## Global Constraints

- 时区固定为 `Asia/Shanghai`，GitHub cron 使用 UTC。
- 触发时间固定为北京时间 21:40、21:50、22:04。
- 未核验结果不得结算或学习。
- 同一期不得重复结算、重复学习或覆盖冻结预测。
- 日常任务不得等待 60 分钟，不运行完整测试套件。
- 香港与新澳门失败相互隔离。
- 生产输出仍只有四项分类事件，不得包含具体号码。

---

### Task 1: 快速单彩种周期

**Files:**
- Modify: `research/src/marksix_research/cli.py`
- Modify: `research/tests/test_pipeline.py`

**Interfaces:**
- Produces: `sync_game_history(site_url: str, game: str) -> list[dict]`
- Produces: `run_cycle(site_url: str, secret: str, game: str, output_dir: str) -> dict`
- Changes: `capture(...) -> dict`，`425` 返回 `awaiting_verification`，成功返回服务端 JSON。

- [ ] **Step 1: Write failing tests**

添加测试，使用完整 HTTP 响应替身验证：单彩种同步只请求指定彩种；`425` 不进入 60 分钟循环并返回等待状态；每次 `run_cycle` 都重新同步、重新生成制品并使用本次制品生成任务 ID。

- [ ] **Step 2: Run tests and verify RED**

Run: `PYTHONPATH=research/src python3 -m unittest research.tests.test_pipeline -v`

Expected: FAIL because `sync_game_history` and `run_cycle` do not exist and `capture` raises timeout on `425`.

- [ ] **Step 3: Implement minimal cycle**

实现单彩种同步、一次研究生成、一次快速 capture。仅对短暂网络错误做有限重试；`425` 返回 `{"status":"awaiting_verification"}`，其他不可重试 HTTP 错误立即失败。

- [ ] **Step 4: Run tests and verify GREEN**

Run: `PYTHONPATH=research/src python3 -m unittest research.tests.test_pipeline -v`

Expected: PASS.

### Task 2: 严格生产健康检查

**Files:**
- Modify: `research/src/marksix_research/cli.py`
- Modify: `research/tests/test_pipeline.py`

**Interfaces:**
- Produces: `verify_production_health(site_url: str, game: str) -> dict`
- Consumes: `/api/lottery`、`/api/research/forecast`、`/api/research/reviews`、`/api/research/learning-runs`。

- [ ] **Step 1: Write failing health tests**

覆盖：未核验返回 `awaiting_verification`；已核验且目标期仍等于开奖期时报错；目标期已推进但缺少复盘或学习记录时报错；四槽位、无号码且复盘学习齐全时返回 `frozen`。

- [ ] **Step 2: Run tests and verify RED**

Run: `PYTHONPATH=research/src python3 -m unittest research.tests.test_pipeline -v`

Expected: FAIL because strict health verification does not exist.

- [ ] **Step 3: Implement health verification**

按数字期号比较当前开奖与冻结目标；校验四个固定 slot 集合、`family != number`、最新复盘和学习记录。错误信息必须包含彩种和落后的期号。

- [ ] **Step 4: Run tests and verify GREEN**

Run: `PYTHONPATH=research/src python3 -m unittest research.tests.test_pipeline -v`

Expected: PASS.

### Task 3: GitHub 三次幂等调度与彩种隔离

**Files:**
- Modify: `.github/workflows/research-v2.yml`
- Modify: `tests/rendered-html.test.mjs`

**Interfaces:**
- Consumes: `marksix-research cycle` 与 `marksix-research health-check`。
- Produces: 两个独立 matrix job，`fail-fast: false`。

- [ ] **Step 1: Write failing workflow contract test**

解析 YAML 文本并验证三个 UTC cron、matrix 两彩种、`fail-fast: false`、不含 `--max-wait-seconds 3600`，且 cycle 后执行严格 health-check。

- [ ] **Step 2: Run test and verify RED**

Run: `node --test tests/rendered-html.test.mjs`

Expected: FAIL because current workflow has one 22:20 cron and a shared 60-minute capture step.

- [ ] **Step 3: Implement workflow**

将 schedule 改为 `40 13`、`50 13`、`4 14`；使用 matrix `game: [hk, new_macau]`；移除日常 typecheck、全量 Node/Python 测试和双进程共享等待；执行单彩种 cycle 与 health-check；上传该彩种制品及状态。

- [ ] **Step 4: Run contract and deployment tests**

Run: `node --test tests/rendered-html.test.mjs tests/sites-deployment.test.mjs`

Expected: PASS.

### Task 4: 完整验证、发布和生产补跑

**Files:**
- No production source changes expected.

**Interfaces:**
- Produces: GitHub main 上的新工作流与生产 2026216 复盘、2026217 冻结预测。

- [ ] **Step 1: Run complete local verification**

Run: `npm test`

Expected: all Node tests, Python tests, build, deployment and rendered API tests pass.

- [ ] **Step 2: Commit and push**

提交源代码、测试、规格和计划，推送功能分支及 `main`。

- [ ] **Step 3: Trigger workflow manually**

Run: `gh workflow run research-v2.yml --repo cjl308868584-lang/marksix-research-v3 --ref main`

Expected: 香港和新澳门 matrix 独立完成或明确等待核验。

- [ ] **Step 4: Verify production state**

确认新澳门最新复盘为 2026216、下一目标期为 2026217、学习记录包含 2026216、四项预测无号码；重跑相同周期后记录数不增加。

- [ ] **Step 5: Audit adjacent failures**

检查 workflow 最近运行、Secrets 存在性、接口 HTTP 状态、香港目标期、定时配置和 Git 工作区状态，记录所有未解决问题。

