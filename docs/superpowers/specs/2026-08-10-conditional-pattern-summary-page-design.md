# 近30期条件规律统计页设计

## 目标

新增顶级独立页面 `/patterns`，集中展示当前目标期已经冻结的近30期条件规律。现有 `/research/patterns` 的逐条 A → B 规律工作区整体迁移到新页面，并在新页面最上方增加统计总览。

首页增加“近30期条件规律”直接入口。旧地址 `/research/patterns` 改为服务端跳转到 `/patterns`，保留历史链接兼容，不再维护第二份页面实现。

统计必须覆盖当前筛选范围内的全部冻结规律，不受逐条页面每页20条的分页影响。

## 页面结构

### 1. 独立页面头部与顶部总统计

独立页面保留彩种切换、目标期、30期范围和规则版本；不再作为“下一期策略”页面内部的子模块。页面第一屏在这些上下文之后立即展示：

- 支持策略数：当前统计范围内的条件规律数量。
- 支持结果数：这些规律指向的不同结果 B 数量。
- 历史触发总次数：所有规律 `support` 的合计。
- 总命中次数：所有规律 `hits` 的合计。
- 总失败次数：`support - hits` 的合计。
- 汇总命中率：总命中除以历史触发总次数。
- 随机预期命中：每条规律的 `support × B自身随机基准` 后求和。
- 相对基准差：总命中减去随机预期命中，同时给出百分点口径的加权命中率差。

顶部必须注明：不同规律可能在同一期同时触发，因此命中、失败和触发总数是“规则审计次数”，不是独立期开奖期数，不能直接用来证明优势。

### 2. 结果 B 支持汇总

按 `result eventId` 聚合，每个结果 B 显示：

- 结果名称。
- 支持策略数量。
- 历史触发、命中、失败。
- 汇总命中率。
- B自身随机基准。
- 相对基准百分点差。
- 近期强证据数量与待验证数量。

排序顺序固定为：强证据数量、支持策略数量、加权基准提升、结果名称。相同结果下最多只计一次同一 `ruleId`。

### 3. 分类筛选与逐条规律

支持全部、生肖、尾数、波色、头数五种范围。切换后，顶部总统计、结果 B 汇总和逐条规律卡片同时更新。现有条件 A、下一期结果 B、历史触发、命中/失败、随机基准、p/q值、本期触发依据和历史审计全部迁移，不删减研究内容。

## 数据流与接口

扩展现有只读接口 `GET /api/research/patterns`，增加 `summary` 字段。服务端在完成彩种和分类筛选后、分页前，对全部规律计算汇总。

接口返回：

```ts
type RollingPatternSummary = {
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

空账本返回全零汇总和空分组；不可用状态返回 `summary: null`。公开读取仍为 `no-store`，不触发扫描、训练或写入。

## 统计口径

- `strategyCount` 按唯一 `ruleId` 计数。
- `triggerCount`、`hitCount`、`missCount` 允许跨规律重复，因为它们表示每条规律自己的历史审计。
- `expectedHits = Σ(support × baseline)`。
- `baselineRate = expectedHits / triggerCount`。
- `uplift = hitRate - baselineRate`。
- 聚合不会改变任何规律的 p值、q值或证据等级。
- 汇总结果不写入正式四项预测，也不改变模型权重。

## 首页、导航与移动端

- 新页面标题为“近30期条件规律｜六合智研”。
- 首页增加可点击的“近30期条件规律”入口，直接指向 `/patterns`。
- 研究页原“近30期规律”导航也改为指向 `/patterns`。
- `/research/patterns` 永久兼容跳转到 `/patterns`。
- 页面顶部提供返回开奖首页、下一期策略和逐期复盘入口。
- 360px宽度下统计卡片采用两列，结果 B 汇总采用纵向卡片，不出现横向表格和横向滚动。
- 独立页同时承载统计与迁移后的逐条规律，但统计必须位于逐条规律之前。

## 验收

- 125条规律无论位于多少分页，统计策略数仍为125。
- 总失败严格等于总触发减总命中。
- 随机预期命中使用每条 B 的真实基准，不能使用统一50%。
- 分类筛选后统计与该分类全部规律一致。
- 同一规则不能重复计入支持策略数。
- 空结果、不可用状态有明确页面反馈。
- 首页可以一次点击进入独立规律页。
- 旧规律地址跳转后只存在一份实际页面实现。
- 原逐条规律的筛选、分页和历史审计功能迁移后保持可用。
- 360px手机页面无横向溢出。
