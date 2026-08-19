# 近30期规律与逐期学习统一推荐设计

## 1. 决策与目标

本设计修正 `2026-08-19-forward-learning-center-design.md` 中“逐期学习另建一套概率优先推荐模型”的决定。用户要求 `/patterns` 与 `/learning` 使用完全相同的当期推荐逻辑；`/learning` 只比 `/patterns` 多开奖前冻结、开奖后逐项结算和跨期学习，不能另行选择结果。

每个彩种、每个目标期必须产生以下五个正式结果，不允许显示“本期不推荐”：

1. 6+1单生肖；
2. 6+1单尾数；
3. 6+1二连肖；
4. 6+1三连肖；
5. 特码数字。

该强制五项约束只适用于已经具备30个已核验历史样本、且存在完整 `RollingPatternRun` 的目标期。窗口不足时两个页面都显示等待30期窗口，不生成候选或正式结果。

首期没有新版逐期样本时，学习修正为零，五项必须与同一期已冻结的近30期购买参考逐项相同。首期不得把旧产品账本回填成新版正式成绩。

## 2. 方案比较与选择

### 方案A：共享冻结产品账本，逐期学习作为后置校正层（采用）

两页共同读取一个完整的冻结产品候选集，使用相同概率、赔率、期望值和排序函数。新版开奖结果只在下一期生成前校正这些产品概率。优点是首期和后续期都不会分叉，概率与推荐理由可追溯，且不重复计算同一份近30期证据。

### 方案B：首期复制 `/patterns`，以后继续旧三专家模型（否决）

该方案只能让第一期标签看起来一致；第二期开始仍会因目标函数和候选证据不同再次分叉，不能满足“同一推荐逻辑”。

### 方案C：把旧产品逐期记录导入新版学习成绩（否决）

旧账本每期保存大量候选且只展示前15，样本口径与新版每期五个正式结果不同。导入会造成事后选择和重复计数。

## 3. 单一事实源

`RollingPatternProduct` 冻结账本是当期推荐的唯一事实源。一次运行的数据流为：

```text
最新已核验30期
  → 条件规律冻结
  → 构建五类完整产品候选
  → 叠加截止启动期以前的旧产品种子
  → 叠加启动期以后新版候选结算
  → 按期望值逐类选第一名
  → 同时供 /patterns 与 /learning 冻结读取
```

`/learning` 不再重新扫描条件信号、重新枚举一套概率或使用独立专家权重改变结果。任何页面都不得在客户端从截断后的列表重新选推荐。

## 4. 完整候选与强制五选五

每期必须冻结完整候选宇宙：

- 12个单生肖；
- 10个单尾数；
- 66个二连肖；
- 220个三连肖；
- 49个特码号码。

合计357个候选。存在当前30期共同审计时，使用现有产品联合审计计算；不存在证据时，使用精确随机基线、`support=0`、`hits=0` 补齐。二连肖和三连肖仍使用联合出现的审计及精确容斥基线，不能相乘单肖概率。

每类排序统一为：

1. 每1单位期望值，从高到低；
2. 新版逐期结算样本量，从高到低；
3. 当前30期共同审计次数，从高到低；
4. 支持策略数，从高到低；
5. 稳定结果键。

不再过滤 `expectedValue <= 0`。即使一类全部低于盈亏平衡线，也选择该类期望值最高的一项，并如实显示负期望和低于盈亏线的差值；不得显示“本期不推荐”。

## 5. 概率与学习口径

### 5.1 当前30期概率

每个产品先计算：

```text
p30 = (hits30 + 4 × exactBaseline) / (support30 + 4)
```

### 5.2 旧产品种子

为了让首期与已冻结 `/patterns` 结果完全一致，启动期以前的 `rolling_pattern_consensus_scores` 可以作为基础推荐的旧产品种子：

```text
pSeed = (legacyHits + 4 × p30) / (legacySettled + 4)
```

旧数据只影响启动时的推荐先验，不复制到 `forward_learning_scores`，不增加 `/learning` 的正式样本数、命中数、Brier或任何逐期成绩。旧数据截止线是该彩种第一个新版正式目标期；截止线以后旧产品账本的结算不得再次进入种子。

旧种子查询必须按产品的 `target_issue < firstUnifiedTargetIssue` 过滤，不能按写入时间或结算时间过滤。启动线以后的 `rolling_pattern_consensus_scores` 只保留旧页面审计与ROI用途，绝不再进入v2概率或排序。

每个彩种在 `forward_learning_rollouts` 保存一条不可变启动记录：`game`、`firstUnifiedTargetIssue`、`seedQueryVersion`、`legacySeedThroughIssue`、`sourceRunId`、`sourceDataHash`、`authoritativeRecommendationHash` 和创建时间。所有v2构建从该记录读取截止线，不能从以后可变的代码常量推断。每个冻结候选还保存本期实际使用的 `legacySettledCount`、`legacyHitCount`、`pSeed` 及种子聚合哈希，使历史结果可以重放核对。

### 5.3 新版逐期学习

每期开奖后，对开奖前冻结的完整候选集逐项评分。下一期按 `game + slot + result_key` 聚合新版候选分数：

```text
pLearned = (newHits + 4 × pSeed) / (newSettled + 4)
```

首期 `newSettled=0`，所以 `pLearned=pSeed`。“学习修正为零”只表示新版样本尚未改变冻结种子，不表示忽略旧种子并退回 `p30`。

正式表现仍只统计每期五个正式预测；未入选候选的分数只用于校正以后选择，不进入正式命中率。一个候选一期最多产生一条新版分数，同期开奖不能同时从旧产品分数和新版分数重复计入。

v2学习查询只能聚合“该目标期最高已提交revision”的候选分数；键为 `game + slot + result_key`。原v1候选、未提交revision、非有效revision及未来目标期全部排除。

### 5.4 赔率与期望值

沿用已确认的净赔率：

- 单肖：马 `1:0.75`，其余 `1:1`；
- 单尾：0尾 `1:1`，其余 `1:0.75`；
- 二连肖：含马 `1:2`，不含马 `1:3`；
- 三连肖：含马 `1:7`，不含马 `1:9`；
- 特码数字：`1:47`。

```text
breakEven = 1 / (netOdds + 1)
EV = pLearned × netOdds - (1 - pLearned)
```

赔率参与最终排序，因为这正是近30期购买参考的现有决策目标。

## 6. 冻结、结算与幂等

正常期继续使用每期一个不可变候选快照和五个正式预测。`persistRollingPatternProducts` 或其共享替代实现必须同时读取“截止线以前旧种子”和“截止线以后v2有效候选分数”，不得继续从全部旧产品分数聚合。开奖后严格按以下顺序执行：

1. 读取目标期开奖前冻结的有效候选版本；
2. 核验开奖、彩种、期号及 `frozenAt < drawAt`；
3. 对所有候选写一次分数，其中五项标记 `official=true`；
4. 完成该期正式复盘；
5. 使用最新30期、旧种子截止线和全部已结算新版候选分数构建下一期357个产品；
6. 每类按同一EV排序选一个并冻结。

重复任务必须返回相同候选、相同五项和相同分数。半完成任务只能补齐缺失阶段，不能再次累计学习。

## 7. 已冻结首期的无损纠正

新澳门 `2026231` 已由旧 `forward-learning-v1` 冻结为另一组结果，但尚未开奖、尚无分数。不能删除或覆盖该历史证据。v2所有正常冻结和纠正都使用同一套版本化快照表；旧v1原表只读保留：

- `forward_learning_revisions`：保存目标期、整数修订号、来源规律run、数据版本、选择策略、原内容哈希、新内容哈希、原因和提交状态；唯一键为 `game + target_issue + revision`；
- `forward_learning_revision_candidates`：保存该修订的357个冻结产品候选；
- `forward_learning_revision_forecasts`：保存该修订逐类选择的五项正式预测；
- `forward_learning_revision_scores`：保存该修订357个候选的唯一分数，其中五项标记official。`score_id` 与 `candidate_id` 全局唯一，并额外唯一约束 `game + target_issue + revision + slot + result_key`；非空official forecast ID一对一唯一。

旧v1原表隐含为revision 1；新目标期的首个v2快照也是revision 1；已有v1目标期的纠正从revision 2开始。读取与结算统一调用 `readResolvedForwardSnapshot(game, issue?)`，优先选择同一期已提交的最高整数revision，并在没有v2快照时才回退v1。无期号的默认最新读取、forecast、candidate、settlement、reviews、performance和内部任务都必须使用该resolver，不能各自实现版本选择。

规范ID必须包含revision身份，例如 `candidate:unified-v2:<game>:<targetIssue>:r<revision>:<slot>:<resultKey>`。v2分数只写revision score表，不与v1 candidateId、forecastId或scoreId共用唯一键。review只返回有效revision的五条official分数；其余候选分数只供学习诊断和下一期校正。

写分数前必须先由resolver确认同一已committed revision，且每个score的candidateId属于该revision。score冻结 `learnedProbability`、精确基线、Brier、baseline Brier、log-loss、baseline log-loss、actualMatched、实际号码、实际特码和scoredAt；聚合查询必须join committed manifest，禁止仅按期号读取孤立分数。

修订写入顺序为manifest processing、全部候选、五项预测、完整性及哈希校验、manifest committed。未提交的半套修订对读取不可见，重试使用固定ID和内容哈希补齐；已committed的同revision遇到不同内容哈希必须409，不能覆盖。正常v2首冻和纠正都遵守这一协议。

首期纠正仅在以下条件全部成立时执行：目标期尚未开奖；原期没有任何新版分数；原记录恰好五槽；同一期不可变 `RollingPatternRun` 及截止线前旧产品分数存在且数据版本一致。

revision 2从该冻结run的signals、expectedDrawAt、window.dataHash及旧种子，按本设计确定性重建357个v2产品。原账本已有的产品复用其联合审计；缺失产品按第4节补为精确基线候选。补齐项目属于revision 2的派生冻结候选，不追写原rolling账本。原revision 1继续保存但不参与结算。

2026231纠正使用本设计第12节的版本化权威五项快照作为迁移输入和hard gate：重建结果必须与快照的结果键、概率、赔率、盈亏线、期望值及哈希完全一致，否则拒绝提交revision 2。不能从当前页面文本或重新排序后的可变列表“尽量重建”。以后新目标期的权威五项直接随revision冻结，不再需要迁移fixture。

`/patterns` 与 `/learning` 都读取 `readResolvedProductRecommendations` 返回的有效revision五项。若2026231已有revision 2，`/patterns` 的购买参考也显示revision 2，而不是继续从旧分页产品列表重新选择。

## 8. 类型与页面

新版 `ForwardLearningCandidate`/`Forecast` 增加并冻结：

- `sourceRunId`、可空的 `sourceProductId`、`sourceKind: "ledger" | "derived_baseline"`、`derivedDefinitionHash`、`selectionPolicy`、`revision`；
- `patternProbability`、`legacySeedProbability`、`learnedProbability`；
- `netOdds`、`breakEvenProbability`、`expectedValue`；
- 当前30期support/hits、旧种子计数、新版候选学习计数。

旧三专家字段仅为读取v1历史兼容，不再参与v2选择。`/learning` 页面文案改为“与近30期购买参考同源，开奖后叠加真实逐期结果”。模型权重面板改成逐类学习状态，显示当前30期概率、新版历史修正、正式样本量和最近变化。

`/patterns` 的购买参考也使用权威五类选择结果，删除“达不到盈亏线时明确不推荐”和“本期不推荐”分支。负期望时仍显示选中的结果、负期望和风险说明。

## 9. API与自动化健康检查

- `/api/research/patterns` 返回冻结产品和服务器端算好的权威recommendations；
- `/api/learning/forecast` 返回同一来源映射的五项及有效revision；
- reviews/performance只统计新版五项正式分数；
- model接口返回逐类学习统计，不再要求三专家权重才能判定健康；
- 内部 settle-and-freeze 在正常结算前先修复可安全修复的旧首期bootstrap。

两个公开接口共享的权威recommendation最低结构为：

```text
kind, resultKey, values, sourceRunId, dataVersion, revision,
p30, legacySeedProbability, learnedProbability,
netOdds, breakEvenProbability, expectedValue,
learningSettledCount, learningHitCount
```

`/patterns` 直接返回该数组；`/learning` 的forecast逐字段复制它并增加正式预测ID及解释，不能再次排序。健康检查必须验证：两页相同targetIssue的五类上述字段一致；五类恰好各一项；上一已开奖期有效revision有五条正式分数；存在修订时只结算最高已提交修订。香港不足30期时继续明确处于等待窗口，不能伪造五项。

## 10. 测试与验收

必须覆盖：

1. 同一冻结产品集生成的 `/patterns` 五项与 `/learning` 五项逐字段一致；
2. 全部候选EV为负时仍恰好返回五项；
3. 无当前信号时357个基线候选完整、结果稳定；
4. 二/三连肖使用联合审计，不把单肖概率相乘；
5. 首期零新版样本，不制造review或正式成绩；
6. 旧产品分数只到启动截止线且不进入新版正式表现；
7. 新版候选命中/失败只校正一次，未开奖和未来分数不进入；
8. 同期重跑不改变结果或累计计数；
9. revision 1保留、revision 2完整提交后成为唯一读取与结算版本；
10. revision 2半写入时读取仍返回revision 1；
11. 页面不再出现“本期不推荐”，并明确赔率参与排序；
12. 固定 `firstUnifiedTargetIssue=2026231`、`window.dataHash=e1bb9fe08f06fa838a4959f8cd5d4b7c9c6154480089e03e562d3df943ecec6a`、`expectedDrawAt=2026-08-19T13:32:00.000Z`、旧种子过滤 `target_issue < 2026231` 及本设计赔率表后，新澳门首期修订应为：猴、8尾、蛇＋猴、蛇＋马＋猴、特码01；
13. 类型检查、完整Node/Python测试、生产构建、D1迁移和部署健康检查通过。

## 11. 研究边界

强制每类给一个结果不等于每类都具有正期望。页面必须如实显示概率、盈亏平衡线和正负期望，不得把“最高的一项”描述成已经验证的盈利机会。逐期学习只证明模型是否相对自身冻结基线改善，不承诺公平随机开奖存在持续优势。

## 12. 新澳门2026231权威纠正快照

固定来源：

- `sourceRunId=rp_new_macau_2026231_ce1e7c5e05d6a18a`
- `firstUnifiedTargetIssue=2026231`
- `legacySeedThroughIssue=2026230`
- `window.dataHash=e1bb9fe08f06fa838a4959f8cd5d4b7c9c6154480089e03e562d3df943ecec6a`
- `expectedDrawAt=2026-08-19T13:32:00.000Z`
- 下列数组按字段顺序JSON序列化后的SHA-256：`cd1e2e83347869be0943420d92ba7af3cd6317bd20d6b1a7cfceeadfb4d78608`

| kind | resultKey | p30 | pSeed / pLearned | 净赔率 | 盈亏线 | EV | 30期中/审计 | 旧种子中/结算 |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| coverage_zodiac | 猴 | 0.6995139714843693 | 0.7536966066105752 | 1 | 0.5 | 0.5073932132211505 | 17/23 | 7/9 |
| coverage_tail | 8尾 | 0.7775225083273186 | 0.8546223102545596 | 0.75 | 0.5714285714285714 | 0.49558904294547923 | 18/22 | 8/9 |
| coverage_zodiac_pair | 蛇+猴 | 0.3675265118104436 | 0.5746235420955211 | 3 | 0.25 | 1.2984941683820845 | 8/20 | 6/9 |
| coverage_zodiac_triple | 蛇+马+猴 | 0.29017271661601063 | 0.47389929742031095 | 7 | 0.125 | 2.7911943793624876 | 6/18 | 5/9 |
| special_number | 01 | 0.02040816326530612 | 0.08320251177394035 | 47 | 0.020833333333333332 | 2.993720565149137 | 0/0 | 1/9 |
