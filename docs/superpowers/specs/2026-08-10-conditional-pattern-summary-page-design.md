# 近30期条件规律统计页设计

## 目标

新增独立页面 `/research/patterns/summary`，集中统计当前目标期已经冻结的近30期条件规律。现有 `/research/patterns` 继续只负责逐条展示 A → B 规律，不把汇总模块合并进去。

统计必须覆盖当前筛选范围内的全部冻结规律，不受逐条页面每页20条的分页影响。

## 页面结构

### 1. 顶部总统计

页面第一屏展示：

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

### 3. 分类筛选

支持全部、生肖、尾数、波色、头数五种范围。切换后，顶部总统计和结果 B 汇总同时更新。新页面不再重复渲染逐条规律卡片；用户可通过“查看逐条规律”返回原页面。

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

## 导航与移动端

- 新页面标题为“近30期规律统计”。
- 页面顶部提供“返回逐条规律”和现有研究入口。
- 360px宽度下统计卡片采用两列，结果 B 汇总采用纵向卡片，不出现横向表格和横向滚动。
- 现有逐条规律页面只增加一个轻量入口链接，不嵌入统计内容。

## 验收

- 125条规律无论位于多少分页，统计策略数仍为125。
- 总失败严格等于总触发减总命中。
- 随机预期命中使用每条 B 的真实基准，不能使用统一50%。
- 分类筛选后统计与该分类全部规律一致。
- 同一规则不能重复计入支持策略数。
- 空结果、不可用状态有明确页面反馈。
- 现有逐条规律页面不出现汇总统计模块。
- 360px手机页面无横向溢出。
