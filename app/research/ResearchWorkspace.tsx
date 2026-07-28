"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { GAME_META, type GameId } from "../../lib/lottery";
import {
  buildResearchConsensus,
  type ResearchConsensus,
} from "../../lib/research-consensus";
import type {
  ResearchRuleEvidence,
  ResearchRuleSpec,
  ResearchSnapshot,
  ResearchTargetFamily,
} from "../../lib/research-v2-types";

type DirectionFilter = "all" | "positive" | "negative";
type FamilyFilter = "all" | ResearchRuleEvidence["family"];
type SortMode = "evidence" | "hit_rate" | "lift" | "support" | "q_value";
type QuickFilter = "all" | "positive" | "negative" | "passed" | "consensus" | "custom";

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
  const [family, setFamily] = useState<FamilyFilter>("all");
  const [target, setTarget] = useState("all");
  const [sort, setSort] = useState<SortMode>("evidence");
  const [query, setQuery] = useState("");
  const [quickFilter, setQuickFilter] = useState<QuickFilter>("all");
  const [scopeFilter, setScopeFilter] = useState<string>("all");
  const resultHeadRef = useRef<HTMLDivElement | null>(null);

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

  const allRegisteredRules = useMemo(
    () => snapshot
      ? [
          ...snapshot.verifiedRules,
          ...snapshot.experimentalRules,
          ...snapshot.negativeRules,
        ]
      : [],
    [snapshot],
  );

  const rules = useMemo(
    () => allRegisteredRules.filter(
      (rule) => rule.currentTriggerMatched && rule.currentPrediction !== null,
    ),
    [allRegisteredRules],
  );

  const targets = useMemo(
    () => [...new Set(rules.map((rule) => rule.targetId))].sort(),
    [rules],
  );

  const consensus = useMemo(
    () => snapshot
      ? buildResearchConsensus(rules, snapshot.expectedDrawAt)
      : [],
    [rules, snapshot],
  );
  const consensusRuleIds = useMemo(
    () => new Set(consensus.flatMap((item) => item.ruleIds)),
    [consensus],
  );

  const visibleRules = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
    return rules
      .filter((rule) => direction === "all" || rule.direction === direction)
      .filter((rule) => family === "all" || rule.family === family)
      .filter((rule) => target === "all" || rule.targetId === target)
      .filter((rule) => scopeFilter === "all" || rule.spec.target.scope === scopeFilter)
      .filter((rule) => quickFilter !== "passed" || passesHistoricalGate(rule))
      .filter((rule) => quickFilter !== "consensus" || consensusRuleIds.has(rule.ruleId))
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
  }, [consensusRuleIds, direction, family, query, quickFilter, rules, scopeFilter, sort, target]);

  const positiveCount = rules.filter((rule) => rule.direction === "positive").length;
  const negativeCount = rules.filter((rule) => rule.direction === "negative").length;
  const strictCount = rules.filter(
    passesHistoricalGate,
  ).length;
  const consensusRulesCount = consensusRuleIds.size;

  const scrollToResults = () => {
    window.requestAnimationFrame(() => {
      resultHeadRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };

  const applyQuickFilter = (next: QuickFilter) => {
    setQuickFilter(next);
    setScopeFilter("all");
    setTarget("all");
    setFamily("all");
    setQuery("");
    setDirection(
      next === "positive" ? "positive" : next === "negative" ? "negative" : "all",
    );
    scrollToResults();
  };

  const applyConsensusScope = (item: ResearchConsensus) => {
    setQuickFilter("custom");
    setScopeFilter(item.scope);
    setTarget("all");
    setFamily("all");
    setDirection("all");
    setQuery("");
    scrollToResults();
  };

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
            这里只保留已经被最新历史条件触发、能够对下一期输出具体结果的规律。
            每条都公开目标位置、触发条件、历史命中、随机基线与统计检验。
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
          <nav className="research-view-switch" aria-label="研究页面">
            <a className="active" href="/research">
              下一期规律
              <small>开奖前冻结</small>
            </a>
            <a href="/research/review">
              历史复盘
              <small>开奖后结算</small>
            </a>
          </nav>
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

            <section className="rule-overview" aria-label="快捷筛选">
              <button
                type="button"
                className={`triggered ${quickFilter === "all" && scopeFilter === "all" ? "active" : ""}`}
                onClick={() => applyQuickFilter("all")}
              >
                <span>下一期可用规律</span>
                <strong>{rules.length}</strong>
                <small>点击查看全部已触发规律</small>
              </button>
              <button
                type="button"
                className={`positive ${quickFilter === "positive" ? "active" : ""}`}
                onClick={() => applyQuickFilter("positive")}
              >
                <span>正向候选</span>
                <strong>{positiveCount}</strong>
                <small>点击只看提高权重的规律</small>
              </button>
              <button
                type="button"
                className={`negative ${quickFilter === "negative" ? "active" : ""}`}
                onClick={() => applyQuickFilter("negative")}
              >
                <span>负向规律</span>
                <strong>{negativeCount}</strong>
                <small>点击只看降低权重的规律</small>
              </button>
              <button
                type="button"
                className={quickFilter === "passed" ? "active" : ""}
                onClick={() => applyQuickFilter("passed")}
              >
                <span>历史门槛通过</span>
                <strong>{strictCount}</strong>
                <small>点击只看 q≤0.10 等合格规律</small>
              </button>
              <button
                type="button"
                className={quickFilter === "consensus" ? "active" : ""}
                onClick={() => applyQuickFilter("consensus")}
              >
                <span>参与共识汇总</span>
                <strong>{consensusRulesCount}</strong>
                <small>点击查看被合并计算的规律</small>
              </button>
            </section>

            <ConsensusPanel
              consensus={consensus}
              activeScope={scopeFilter}
              onSelect={applyConsensusScope}
            />

            <section className="rule-method-note">
              <div>
                <span>区间口径</span>
                <strong>一区 01–16 · 二区 17–33 · 三区 34–49</strong>
              </div>
              <p>
                “区”只是把01至49分成三段。一区与三区各16个号码，单位置随机基线均为32.7%；
                二区有17个号码，随机基线为34.7%。它和波色、生肖一样只是号码分类，不代表开奖区域。
              </p>
            </section>

            <section className="rule-controls" aria-label="规律筛选器">
              <label className="rule-search">
                <span>搜索具体规律</span>
                <input
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setQuickFilter("custom");
                  }}
                  placeholder="例如：第3正码、生肖、镜像号…"
                />
              </label>
              <label>
                <span>目标</span>
                <select value={target} onChange={(event) => {
                  setTarget(event.target.value);
                  setScopeFilter("all");
                  setQuickFilter("custom");
                }}>
                  <option value="all">全部目标</option>
                  {targets.map((item) => <option value={item} key={item}>{targetLabel(item)}</option>)}
                </select>
              </label>
              <label>
                <span>规律类型</span>
                <select value={family} onChange={(event) => {
                  setFamily(event.target.value as FamilyFilter);
                  setQuickFilter("custom");
                }}>
                  <option value="all">全部类型</option>
                  {Object.entries(FAMILY_LABELS).map(([value, label]) => (
                    <option value={value} key={value}>{label}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>方向</span>
                <select value={direction} onChange={(event) => {
                  setDirection(event.target.value as DirectionFilter);
                  setQuickFilter("custom");
                }}>
                  <option value="all">正向与负向</option>
                  <option value="positive">仅正向候选</option>
                  <option value="negative">仅负向规律</option>
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

            {(quickFilter !== "all" || scopeFilter !== "all" || target !== "all" || family !== "all" || direction !== "all" || query) && (
              <div className="rule-active-filter">
                <span>当前筛选</span>
                <strong>{activeFilterLabel({ quickFilter, scopeFilter, target, family, direction, query })}</strong>
                <button type="button" onClick={() => applyQuickFilter("all")}>清除筛选</button>
              </div>
            )}

            <div className="rule-result-head" ref={resultHeadRef}>
              <div>
                <span>NEXT DRAW · ACTIVE RULES</span>
                <strong>{visibleRules.length} 条结果</strong>
              </div>
              <p>全部指向目标期 {snapshot.targetIssue}，未触发规律不显示</p>
            </div>

            <section className="rule-card-list" aria-live="polite">
              {visibleRules.map((rule, index) => (
                <RuleAuditCard rule={rule} rank={index + 1} key={rule.ruleId} />
              ))}
              {visibleRules.length === 0 && (
                <div className="rule-empty">
                  当前筛选条件下没有可用于下一期的已触发规律。调整目标或方向后再查看。
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

function ConsensusPanel({
  consensus,
  activeScope,
  onSelect,
}: {
  consensus: ResearchConsensus[];
  activeScope: string;
  onSelect: (item: ResearchConsensus) => void;
}) {
  return (
    <section className="rule-consensus" aria-label="下一期共识概率">
      <div className="rule-consensus-head">
        <div>
          <span>RULE-WEIGHTED CONSENSUS</span>
          <h2>下一期共识概率</h2>
        </div>
        <p>
          将同一位置的尾数、单双、区间、生肖、波色等规则投影到01–49后合并。
          同方向会叠加，负向会抵消；点击任一位置可筛选下方原始规律。
        </p>
      </div>
      <div className="rule-consensus-grid">
        {consensus.slice(0, 8).map((item) => {
          const top = item.topNumbers[0];
          return (
            <button
              type="button"
              className={activeScope === item.scope ? "active" : ""}
              onClick={() => onSelect(item)}
              key={item.scope}
            >
              <div className="consensus-card-head">
                <span>{item.label}</span>
                <em>{item.positiveRuleCount}正 · {item.negativeRuleCount}负</em>
              </div>
              <div className="consensus-primary">
                <span>最高交集号码</span>
                <strong>{String(top.number).padStart(2, "0")}</strong>
                <div>
                  <b>{percent(top.probability)}</b>
                  <small>随机 {percent(top.baseline)} · {deltaPoints(top.delta)}</small>
                </div>
              </div>
              <div className="consensus-number-row" aria-label="共识号码前三">
                {item.topNumbers.slice(0, 3).map((number) => (
                  <span key={number.number}>
                    <b>{String(number.number).padStart(2, "0")}</b>
                    <small>{percent(number.probability)}</small>
                  </span>
                ))}
              </div>
              <div className="consensus-dimensions">
                {item.dimensions.slice(0, 3).map((dimension) => (
                  <span
                    className={dimension.delta < 0 ? "suppressed" : ""}
                    key={`${dimension.family}-${dimension.value}`}
                  >
                    <b>{dimension.value}</b>
                    <em>{percent(dimension.probability)}</em>
                    <small>基线 {percent(dimension.baseline)} · {deltaPoints(dimension.delta)}</small>
                  </span>
                ))}
              </div>
              <p>{item.explanation}</p>
              <small className="consensus-filter-action">筛选这 {item.ruleIds.length} 条原始规律 →</small>
            </button>
          );
        })}
      </div>
      <div className="rule-consensus-boundary">
        这里是规则加权后的研究概率，不是官方概率或已验证中奖率。相关规则可能来自相似历史结构；
        系统已限制单条规则影响，但不能把多条相关规律当作完全独立证据。
      </div>
    </section>
  );
}

function RuleAuditCard({ rule, rank }: { rule: ResearchRuleEvidence; rank: number }) {
  const [low, high] = wilsonInterval(rule.hits, rule.support);
  const uplift = rule.hitRate - rule.baselineRate;
  const expectedHits = rule.support * rule.baselineRate;
  const targetName = targetLabel(rule.targetId);
  const meetsHistoricalGate = passesHistoricalGate(rule);

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
        <div className="rule-current-signal active">
          <span>{nextTargetLabel(rule.targetId)}</span>
          <strong>{displayPrediction(rule)}</strong>
          <small>{rule.direction === "negative" ? "下一期降权方向" : "下一期研究结果"}</small>
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

function passesHistoricalGate(rule: ResearchRuleEvidence) {
  return rule.qValue <= 0.1 && rule.brierSkill > 0 && rule.nonWorseFoldRatio >= 0.7;
}

function activeFilterLabel({
  quickFilter,
  scopeFilter,
  target,
  family,
  direction,
  query,
}: {
  quickFilter: QuickFilter;
  scopeFilter: string;
  target: string;
  family: FamilyFilter;
  direction: DirectionFilter;
  query: string;
}) {
  const labels: string[] = [];
  if (quickFilter === "passed") labels.push("历史门槛通过");
  if (quickFilter === "consensus") labels.push("参与共识汇总");
  if (scopeFilter !== "all") labels.push(nextScopeLabel(scopeFilter));
  if (target !== "all") labels.push(targetLabel(target));
  if (family !== "all") labels.push(FAMILY_LABELS[family]);
  if (direction === "positive") labels.push("正向候选");
  if (direction === "negative") labels.push("负向规律");
  if (query) labels.push(`搜索“${query}”`);
  return labels.join(" · ") || "全部下一期可用规律";
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

function nextTargetLabel(value: string) {
  const parts = value.split(".");
  const family = familyLabel(parts.at(-1) as ResearchTargetFamily);
  if (parts[0] === "special") return `下一期特码 · ${family}`;
  if (parts[0] === "main" && parts[1] === "position") {
    return `下一期第${parts[2]}正码 · ${family}`;
  }
  if (value.startsWith("draw.6_plus_1")) return `下一期6+1 · ${family}`;
  if (value.startsWith("main.any")) return `下一期6个正码 · ${family}`;
  return `下一期 · ${targetLabel(value)}`;
}

function nextScopeLabel(value: string) {
  if (value === "special") return "下一期 · 特码";
  if (value.startsWith("main.position.")) {
    return `下一期 · 第${value.split(".")[2]}正码`;
  }
  return value;
}

function displayPrediction(rule: ResearchRuleEvidence) {
  if (!rule.currentPrediction) return "—";
  return rule.spec.target.family === "number"
    ? rule.currentPrediction.padStart(2, "0")
    : rule.currentPrediction;
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

function deltaPoints(value: number) {
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}个百分点`;
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
