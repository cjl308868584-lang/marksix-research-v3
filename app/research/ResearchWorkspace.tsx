"use client";

import { useEffect, useMemo, useState } from "react";
import { GAME_META, type GameId } from "../../lib/lottery";
import type {
  ResearchRuleEvidence,
  ResearchRuleSpec,
  ResearchSnapshot,
  ResearchTargetFamily,
} from "../../lib/research-v2-types";

type DirectionFilter = "all" | "positive" | "negative";
type TriggerFilter = "all" | "triggered" | "not_triggered";
type FamilyFilter = "all" | ResearchRuleEvidence["family"];
type SortMode = "evidence" | "hit_rate" | "lift" | "support" | "q_value";

const GAMES: readonly GameId[] = ["new_macau", "hk"];

const FAMILY_LABELS: Record<ResearchRuleEvidence["family"], string> = {
  position_transfer: "位置传导",
  conditional_transfer: "条件传导",
  number_transform: "号码变换",
};

const TARGET_LABELS: Record<string, string> = {
  "special.number": "特码号码",
  "special.zodiac": "特码生肖",
  "special.wave": "特码波色",
  "special.tail": "特码尾数",
  "special.parity": "特码单双",
  "special.size": "特码大小",
  "special.zone": "特码区间",
  "main.position.1.zodiac": "第1正码生肖",
  "main.position.2.zodiac": "第2正码生肖",
  "main.position.3.zodiac": "第3正码生肖",
  "main.position.4.zodiac": "第4正码生肖",
  "main.position.5.zodiac": "第5正码生肖",
  "main.position.6.zodiac": "第6正码生肖",
};

export function ResearchWorkspace() {
  const [game, setGame] = useState<GameId>("new_macau");
  const [snapshot, setSnapshot] = useState<ResearchSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [direction, setDirection] = useState<DirectionFilter>("all");
  const [trigger, setTrigger] = useState<TriggerFilter>("all");
  const [family, setFamily] = useState<FamilyFilter>("all");
  const [target, setTarget] = useState("all");
  const [sort, setSort] = useState<SortMode>("evidence");
  const [query, setQuery] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setSnapshot(null);
    void fetch(`/api/research/forecast?game=${game}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json() as ResearchSnapshot & { error?: string };
        if (!response.ok) throw new Error(payload.error || "规律研究数据暂不可用。");
        return payload;
      })
      .then(setSnapshot)
      .catch((reason) => {
        if (!(reason instanceof DOMException && reason.name === "AbortError")) {
          setError(reason instanceof Error ? reason.message : "规律研究数据暂不可用。");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [game]);

  const rules = useMemo(
    () => snapshot
      ? [
          ...snapshot.verifiedRules,
          ...snapshot.experimentalRules,
          ...snapshot.negativeRules,
        ]
      : [],
    [snapshot],
  );

  const targets = useMemo(
    () => [...new Set(rules.map((rule) => rule.targetId))].sort(),
    [rules],
  );

  const visibleRules = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
    return rules
      .filter((rule) => direction === "all" || rule.direction === direction)
      .filter((rule) => family === "all" || rule.family === family)
      .filter((rule) => target === "all" || rule.targetId === target)
      .filter((rule) =>
        trigger === "all" ||
        (trigger === "triggered" ? rule.currentTriggerMatched : !rule.currentTriggerMatched),
      )
      .filter((rule) =>
        !normalizedQuery ||
        [
          rule.description,
          rule.ruleId,
          FAMILY_LABELS[rule.family],
          targetLabel(rule.targetId),
          rule.currentPrediction ?? "",
        ].some((value) => value.toLocaleLowerCase("zh-CN").includes(normalizedQuery)),
      )
      .sort((left, right) => {
        if (sort === "hit_rate") return right.hitRate - left.hitRate || right.support - left.support;
        if (sort === "lift") return right.lift - left.lift || right.support - left.support;
        if (sort === "support") return right.support - left.support || left.qValue - right.qValue;
        if (sort === "q_value") return left.qValue - right.qValue || right.support - left.support;
        return (
          Number(right.currentTriggerMatched) - Number(left.currentTriggerMatched) ||
          directionRank(right.direction) - directionRank(left.direction) ||
          tierRank(right.tier) - tierRank(left.tier) ||
          right.brierSkill - left.brierSkill ||
          left.qValue - right.qValue
        );
      });
  }, [direction, family, query, rules, sort, target, trigger]);

  const triggeredCount = rules.filter((rule) => rule.currentTriggerMatched).length;
  const positiveCount = rules.filter((rule) => rule.direction === "positive").length;
  const negativeCount = rules.filter((rule) => rule.direction === "negative").length;
  const strictCount = rules.filter(
    (rule) => rule.qValue <= 0.1 && rule.brierSkill > 0 && rule.nonWorseFoldRatio >= 0.7,
  ).length;

  return (
    <div className="rule-research-shell">
      <header className="rule-research-topbar">
        <a href="/" className="rule-back-link" aria-label="返回开奖首页">← 返回开奖</a>
        <div>
          <strong>六合智研</strong>
          <span>规律研究中心</span>
        </div>
        <span className="rule-research-clock">北京时间</span>
      </header>

      <main>
        <section className="rule-research-hero">
          <span>RULE DISCOVERY · WALK-FORWARD AUDIT</span>
          <h1>逐条研究规律，<br />不再只看一个预测结果</h1>
          <p>
            每条规律都公开触发条件、历史样本、实际命中、随机基线、收缩后提升、
            滚动回测和多重检验结果。未通过验证的规律只作为研究假设。
          </p>
          <div className="rule-game-switch" role="group" aria-label="选择彩种">
            {GAMES.map((item) => (
              <button
                type="button"
                className={game === item ? "active" : ""}
                onClick={() => setGame(item)}
                key={item}
              >
                {GAME_META[item].name}
              </button>
            ))}
          </div>
        </section>

        {loading && (
          <section className="rule-research-state" aria-live="polite">
            <span className="rule-loading-dot" />
            正在读取冻结规律与回测结果…
          </section>
        )}

        {!loading && error && (
          <section className="rule-research-state error" role="alert">
            <strong>暂时无法读取研究结果</strong>
            <p>{error}</p>
          </section>
        )}

        {snapshot && (
          <>
            <section className="rule-run-context" aria-label="本次研究上下文">
              <div><span>研究彩种</span><strong>{GAME_META[game].name}</strong></div>
              <div><span>目标期</span><strong>{snapshot.targetIssue}</strong></div>
              <div><span>历史样本</span><strong>{snapshot.dataQuality.sampleSize} 期</strong></div>
              <div><span>核验比例</span><strong>{percent(snapshot.dataQuality.verifiedRatio)}</strong></div>
              <div><span>候选生成</span><strong>{snapshot.generatedRuleCount.toLocaleString("zh-CN")}</strong></div>
              <div><span>完整回测</span><strong>{snapshot.fullBacktestRuleCount.toLocaleString("zh-CN")}</strong></div>
            </section>

            <section className="rule-overview">
              <div>
                <span>当前登记规律</span>
                <strong>{rules.length}</strong>
                <small>从完整回测结果中保留的代表规律</small>
              </div>
              <div className="triggered">
                <span>本期已触发</span>
                <strong>{triggeredCount}</strong>
                <small>只表示条件匹配，不代表必然命中</small>
              </div>
              <div className="positive">
                <span>正向候选</span>
                <strong>{positiveCount}</strong>
                <small>收缩后高于对应随机基线</small>
              </div>
              <div className="negative">
                <span>负向规律</span>
                <strong>{negativeCount}</strong>
                <small>仅用于降权，不包装成反向推荐</small>
              </div>
              <div>
                <span>严格筛选通过</span>
                <strong>{strictCount}</strong>
                <small>q≤0.10、Brier skill&gt;0、≥70%折不劣</small>
              </div>
            </section>

            <section className="rule-method-note">
              <div>
                <span>如何判断一条规律</span>
                <strong>命中率必须与它自己的精确随机基线比较</strong>
              </div>
              <p>
                例如生肖、波色、尾数、位置与 6+1 覆盖的基线并不相同。
                系统先做贝叶斯收缩，再检查五折滚动表现和 FDR 校正后的 q 值；
                单看“历史命中过几次”不能证明有效。
              </p>
            </section>

            <section className="rule-controls" aria-label="规律筛选器">
              <label className="rule-search">
                <span>搜索具体规律</span>
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="例如：第3正码、生肖、镜像号…"
                />
              </label>
              <label>
                <span>目标</span>
                <select value={target} onChange={(event) => setTarget(event.target.value)}>
                  <option value="all">全部目标</option>
                  {targets.map((item) => <option value={item} key={item}>{targetLabel(item)}</option>)}
                </select>
              </label>
              <label>
                <span>规律类型</span>
                <select value={family} onChange={(event) => setFamily(event.target.value as FamilyFilter)}>
                  <option value="all">全部类型</option>
                  {Object.entries(FAMILY_LABELS).map(([value, label]) => (
                    <option value={value} key={value}>{label}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>方向</span>
                <select value={direction} onChange={(event) => setDirection(event.target.value as DirectionFilter)}>
                  <option value="all">正向与负向</option>
                  <option value="positive">仅正向候选</option>
                  <option value="negative">仅负向规律</option>
                </select>
              </label>
              <label>
                <span>本期状态</span>
                <select value={trigger} onChange={(event) => setTrigger(event.target.value as TriggerFilter)}>
                  <option value="all">全部状态</option>
                  <option value="triggered">本期已触发</option>
                  <option value="not_triggered">本期未触发</option>
                </select>
              </label>
              <label>
                <span>排序</span>
                <select value={sort} onChange={(event) => setSort(event.target.value as SortMode)}>
                  <option value="evidence">综合证据</option>
                  <option value="hit_rate">历史命中率</option>
                  <option value="lift">高于基线幅度</option>
                  <option value="support">触发样本数</option>
                  <option value="q_value">q 值由小到大</option>
                </select>
              </label>
            </section>

            <div className="rule-result-head">
              <div>
                <span>规律明细</span>
                <strong>{visibleRules.length} 条结果</strong>
              </div>
              <p>默认优先显示本期触发且综合证据较强的规律</p>
            </div>

            <section className="rule-card-list" aria-live="polite">
              {visibleRules.map((rule, index) => (
                <RuleAuditCard rule={rule} rank={index + 1} key={rule.ruleId} />
              ))}
              {visibleRules.length === 0 && (
                <div className="rule-empty">
                  当前筛选条件下没有规律。调整目标、方向或本期状态后再查看。
                </div>
              )}
            </section>

            <section className="rule-boundary">
              <strong>研究边界</strong>
              <p>
                当前页面展示的是规则发现与回测证据，不是中奖承诺。标记“候选”或“影子”的规律尚未完成独立前瞻验证；
                即使历史命中率高于基线，也可能来自随机波动或数据选择。
              </p>
              <small>
                数据版本 {snapshot.dataQuality.datasetVersion} · 规则引擎 {snapshot.ruleEngineVersion} ·
                生成于 {beijingDateTime(snapshot.generatedAt)}
              </small>
            </section>
          </>
        )}
      </main>
    </div>
  );
}

function RuleAuditCard({ rule, rank }: { rule: ResearchRuleEvidence; rank: number }) {
  const [low, high] = wilsonInterval(rule.hits, rule.support);
  const uplift = rule.hitRate - rule.baselineRate;
  const expectedHits = rule.support * rule.baselineRate;
  const targetName = targetLabel(rule.targetId);
  const meetsHistoricalGate =
    rule.qValue <= 0.1 && rule.brierSkill > 0 && rule.nonWorseFoldRatio >= 0.7;

  return (
    <article className={`rule-audit-card ${rule.direction}`}>
      <div className="rule-audit-head">
        <div className="rule-rank">{String(rank).padStart(2, "0")}</div>
        <div className="rule-title">
          <div>
            <span>{FAMILY_LABELS[rule.family]}</span>
            <span>{targetName}</span>
            <span className={rule.direction}>{rule.direction === "negative" ? "负向降权" : "正向候选"}</span>
            <span className={meetsHistoricalGate ? "gate-pass" : "gate-watch"}>
              {meetsHistoricalGate ? "历史门槛通过" : "继续观察"}
            </span>
          </div>
          <h2>{rule.description}</h2>
        </div>
        <div className={`rule-current-signal ${rule.currentTriggerMatched ? "active" : ""}`}>
          <span>{rule.currentTriggerMatched ? "本期已触发" : "本期未触发"}</span>
          <strong>{rule.currentPrediction ?? "—"}</strong>
          <small>{rule.currentTriggerMatched ? (rule.direction === "negative" ? "本期降权方向" : "本期研究结果") : "不参与本期计算"}</small>
        </div>
      </div>

      <div className="rule-primary-metrics">
        <div>
          <span>历史命中</span>
          <strong>{rule.hits}<small> / {rule.support} 次</small></strong>
          <em>触发后实际命中次数</em>
        </div>
        <div>
          <span>命中率</span>
          <strong>{percent(rule.hitRate)}</strong>
          <em>95% CI {percent(low)}–{percent(high)}</em>
        </div>
        <div>
          <span>随机基线</span>
          <strong>{percent(rule.baselineRate)}</strong>
          <em>随机预期约 {expectedHits.toFixed(1)} 次</em>
        </div>
        <div className={uplift >= 0 ? "good" : "bad"}>
          <span>高于基线</span>
          <strong>{signedPoints(uplift)}</strong>
          <em>收缩后 {signedPoints(rule.lift)}</em>
        </div>
      </div>

      <div className="rule-score-grid">
        <Metric label="贝叶斯收缩命中率" value={percent(rule.shrunkenRate)} note="抑制小样本偶然高命中" />
        <Metric label="Brier skill" value={signedDecimal(rule.brierSkill)} note={rule.brierSkill > 0 ? "优于对应随机基线" : "未优于随机基线"} />
        <Metric label="5折不劣比例" value={percent(rule.nonWorseFoldRatio)} note="至少70%才通过历史门槛" />
        <Metric label="稳定度" value={percent(rule.stabilityScore)} note="各时间折表现的一致性" />
        <Metric label="原始 p 值" value={decimal(rule.pValue)} note="未经多重检验校正" />
        <Metric label="FDR q 值" value={decimal(rule.qValue)} note={rule.qValue <= 0.1 ? "达到探索阶段门槛" : "尚未达到 q≤0.10"} />
      </div>

      <details className="rule-audit-details">
        <summary>查看触发逻辑与审计说明 <span>展开</span></summary>
        <div>
          <section>
            <span>规则如何工作</span>
            <p>{explainSpec(rule.spec)}</p>
          </section>
          <section>
            <span>统计判断</span>
            <p>{statisticalReading(rule, low, high)}</p>
          </section>
          <section>
            <span>资源决策</span>
            <p>{resourceDecisionLabel(rule.resourceDecision)}</p>
          </section>
          <section>
            <span>可追溯编号</span>
            <code>{rule.ruleId}</code>
          </section>
        </div>
      </details>
    </article>
  );
}

function Metric({ label, value, note }: { label: string; value: string; note: string }) {
  return <div><span>{label}</span><strong>{value}</strong><small>{note}</small></div>;
}

function explainSpec(spec: ResearchRuleSpec) {
  const predicates = spec.predicates.map((item) =>
    `${lagLabel(item.lag)}${fieldLabel(item.field)}的${familyLabel(item.family)}等于“${item.value}”`,
  );
  const condition = predicates.length ? `当${predicates.join("，并且")}时，` : "";
  const transform =
    spec.source.transform === "identity"
      ? "原值"
      : spec.source.transform === "mirror"
        ? "镜像值（50−N）"
        : `偏移 ${spec.source.transform.replace("offset.", "")}`;
  return `${condition}读取${lagLabel(spec.source.lag)}${fieldLabel(spec.source.field)}的${familyLabel(spec.source.family)}，采用${transform}，预测下一期${scopeLabel(spec.target.scope)}的${familyLabel(spec.target.family)}。`;
}

function statisticalReading(rule: ResearchRuleEvidence, low: number, high: number) {
  const relation = rule.hitRate >= rule.baselineRate ? "高于" : "低于";
  return `这条规律历史触发 ${rule.support} 次、命中 ${rule.hits} 次，命中率 ${percent(rule.hitRate)}，${relation}随机基线 ${percent(rule.baselineRate)}。命中率95%区间为 ${percent(low)}–${percent(high)}；FDR 校正后 q=${decimal(rule.qValue)}。${rule.direction === "negative" ? "它只用于降低对应方向权重，不能解释为反向必开。" : "在完成独立前瞻验证前，它仍属于候选证据。"}`;
}

function targetLabel(value: string) {
  if (TARGET_LABELS[value]) return TARGET_LABELS[value];
  const position = value.match(/^main\.position\.(\d)\.(.+)$/);
  if (position) return `第${position[1]}正码${familyLabel(position[2] as ResearchTargetFamily)}`;
  return value;
}

function fieldLabel(value: string) {
  if (value === "special") return "特码";
  return `第${value.split(".")[1]}正码`;
}

function scopeLabel(value: string) {
  if (value === "special") return "特码";
  return `第${value.split(".")[2]}正码`;
}

function lagLabel(value: number) {
  return value === 1 ? "上一期" : `前${value}期`;
}

function familyLabel(value: ResearchTargetFamily) {
  return {
    number: "号码",
    zodiac: "生肖",
    wave: "波色",
    tail: "尾数",
    parity: "单双",
    size: "大小",
    zone: "区间",
  }[value];
}

function resourceDecisionLabel(value: ResearchRuleEvidence["resourceDecision"]) {
  return {
    full_backtest: "已进入完整滚动回测；仍须满足独立前瞻验证才可晋级正式层。",
    negative_pool: "稳定低于基线，已进入负向降权池，不作为正向预测。",
    insufficient_support: "触发样本不足，停止继续消耗完整回测资源。",
    not_above_baseline: "未高于对应基线且缺乏稳定负向证据，停止计算。",
    archived_by_cap: "同目标同家族超过资源上限，已归档。",
  }[value];
}

function tierRank(value: ResearchRuleEvidence["tier"]) {
  return { baseline: 0, insufficient: 1, archived: 2, experimental: 3, challenger: 4, verified: 5 }[value];
}

function directionRank(value: ResearchRuleEvidence["direction"]) {
  return { neutral: 0, negative: 1, positive: 2 }[value];
}

function wilsonInterval(hits: number, total: number): [number, number] {
  if (total <= 0) return [0, 0];
  const z = 1.959963984540054;
  const proportion = hits / total;
  const denominator = 1 + (z * z) / total;
  const center = (proportion + (z * z) / (2 * total)) / denominator;
  const margin =
    (z * Math.sqrt((proportion * (1 - proportion) + (z * z) / (4 * total)) / total)) /
    denominator;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

function percent(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function signedPoints(value: number) {
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)} 个百分点`;
}

function signedDecimal(value: number) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(3)}`;
}

function decimal(value: number) {
  return value < 0.001 ? "<0.001" : value.toFixed(3);
}

function beijingDateTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}
