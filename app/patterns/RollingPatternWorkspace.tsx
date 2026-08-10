"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { GAME_META, type GameId } from "../../lib/lottery";
import type {
  RollingPatternEnvelope,
  RollingPatternFamily,
  RollingPatternResultSummary,
  RollingPatternRun,
  RollingPatternScope,
  RollingPatternScore,
  RollingPatternSignal,
  RollingPatternSummary,
  SpecialNumberConsensus,
} from "../../lib/rolling-pattern-types";

const GAMES: readonly GameId[] = ["new_macau", "hk"];
const COVERAGE_FILTERS: ReadonlyArray<{
  value: RollingPatternFamily | null;
  label: string;
}> = [
  { value: null, label: "全部" },
  { value: "zodiac", label: "生肖" },
  { value: "tail", label: "尾数" },
];
const SPECIAL_FILTERS: typeof COVERAGE_FILTERS = [
  ...COVERAGE_FILTERS,
  { value: "wave", label: "波色" },
  { value: "head", label: "头数" },
];

type PatternApiResponse = Partial<RollingPatternEnvelope> & {
  game: GameId;
  status: "completed" | "unavailable";
  run: RollingPatternRun | null;
  signals: RollingPatternSignal[];
  scores: RollingPatternScore[];
  summary: RollingPatternSummary | null;
  specialNumberConsensus: SpecialNumberConsensus[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    pages: number;
  };
  error?: string;
};

export function RollingPatternWorkspace() {
  const [game, setGame] = useState<GameId>("new_macau");
  const [scope, setScope] = useState<RollingPatternScope>("coverage_6_plus_1");
  const [family, setFamily] = useState<RollingPatternFamily | null>(null);
  const [resultEventId, setResultEventId] = useState<string | null>(null);
  const [selectedNumber, setSelectedNumber] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [response, setResponse] = useState<{
    key: string;
    data: PatternApiResponse | null;
    error: string;
  }>({ key: "", data: null, error: "" });
  const requestKey = `${game}:${scope}:${family ?? "all"}:${resultEventId ?? "all"}:${selectedNumber ?? "all"}:${page}`;
  const loading = response.key !== requestKey;
  const data = loading ? null : response.data;
  const error = loading ? "" : response.error;

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ game, scope, page: String(page) });
    if (family) query.set("family", family);
    if (resultEventId) query.set("result", resultEventId);
    if (selectedNumber) query.set("number", String(selectedNumber));
    void fetch(`/api/research/patterns?${query.toString()}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json() as PatternApiResponse;
        if (!response.ok && response.status !== 404) {
          throw new Error(payload.error || "近期规律暂不可用。");
        }
        return payload;
      })
      .then((payload) => {
        setResponse({ key: requestKey, data: payload, error: "" });
      })
      .catch((reason) => {
        if (!(reason instanceof DOMException && reason.name === "AbortError")) {
          setResponse({
            key: requestKey,
            data: null,
            error: reason instanceof Error ? reason.message : "近期规律暂不可用。",
          });
        }
      });
    return () => controller.abort();
  }, [game, scope, family, resultEventId, selectedNumber, page, requestKey]);

  const scoreByRule = useMemo(
    () => new Map((data?.scores ?? []).map((score) => [score.ruleId, score])),
    [data?.scores],
  );

  const selectGame = (next: GameId) => {
    if (next === game) return;
    setPage(1);
    setResultEventId(null);
    setSelectedNumber(null);
    setGame(next);
  };

  const selectScope = (next: RollingPatternScope) => {
    if (next === scope) return;
    setPage(1);
    setFamily(null);
    setResultEventId(null);
    setSelectedNumber(null);
    setScope(next);
  };

  const selectFamily = (next: RollingPatternFamily | null) => {
    if (next === family) return;
    setPage(1);
    setResultEventId(null);
    setSelectedNumber(null);
    setFamily(next);
  };

  const selectResult = (next: string) => {
    setPage(1);
    setSelectedNumber(null);
    setResultEventId((current) => current === next ? null : next);
  };

  const selectNumber = (next: number) => {
    setPage(1);
    setResultEventId(null);
    setSelectedNumber((current) => current === next ? null : next);
  };

  const filters = scope === "coverage_6_plus_1"
    ? COVERAGE_FILTERS
    : SPECIAL_FILTERS;

  return (
    <div className="v3-shell rolling-pattern-shell">
      <header className="v3-topbar">
        <Link href="/" aria-label="返回开奖首页">← 开奖</Link>
        <div>
          <strong>六合智研</strong>
          <span>近30期规律</span>
        </div>
        <span>北京时间</span>
      </header>

      <main>
        <section className="v3-hero rolling-pattern-hero">
          <span>CONDITION A → NEXT-DRAW RESULT B</span>
          <h1>条件 A 已成立，<br />下一期结果 B 会怎样</h1>
          <p>
            这里研究的是明确的前提与下一期结果，不是热号或出现频率。
            条件 A 统一读取本期6+1；每期开奖后严格滚动最新30期，重新验证 A → B。
          </p>
          <div className="v3-game-switch" role="group" aria-label="选择彩种">
            {GAMES.map((item) => (
              <button
                type="button"
                className={game === item ? "active" : ""}
                onClick={() => selectGame(item)}
                key={item}
              >
                {GAME_META[item].name}
              </button>
            ))}
          </div>
          <div className="rolling-pattern-scope-switch" role="group" aria-label="选择结果范围">
            <button
              type="button"
              className={scope === "coverage_6_plus_1" ? "active" : ""}
              onClick={() => selectScope("coverage_6_plus_1")}
            >
              <strong>6+1覆盖规律</strong>
              <span>结果只研究生肖、尾数</span>
            </button>
            <button
              type="button"
              className={scope === "special" ? "active" : ""}
              onClick={() => selectScope("special")}
            >
              <strong>特码规律</strong>
              <span>结果只看下一期的特码</span>
            </button>
          </div>
        </section>

        {loading && (
          <section className="v3-state" aria-live="polite">
            <span />
            正在读取冻结的近期规律…
          </section>
        )}

        {!loading && error && (
          <section className="v3-state error" role="alert">
            <strong>暂时无法读取近期规律</strong>
            <p>{error}</p>
          </section>
        )}

        {!loading && !error && data?.status === "unavailable" && (
          <section className="rolling-pattern-empty">
            <span>NO CURRENT FROZEN RUN</span>
            <h2>本目标期尚无冻结结果</h2>
            <p>系统不会拿上一期规律冒充当前结果。等待下一次已核验开奖任务完成重扫。</p>
          </section>
        )}

        {!loading && !error && data?.run && (
          <>
            <PatternRunContext run={data.run} />
            {data.summary && (
              <PatternSummaryPanel
                summary={data.summary}
                selectedResult={resultEventId}
                onSelectResult={selectResult}
              />
            )}
            {scope === "special" && (
              <SpecialNumberConsensusPanel
                items={data.specialNumberConsensus ?? []}
                selectedNumber={selectedNumber}
                onSelectNumber={selectNumber}
              />
            )}
            <PatternFunnel run={data.run} scope={scope} />
            <section className="rolling-pattern-toolbar" aria-label="规律分类筛选">
              {filters.map((item) => (
                <button
                  type="button"
                  className={family === item.value ? "active" : ""}
                  onClick={() => selectFamily(item.value)}
                  key={item.label}
                >
                  {item.label}
                </button>
              ))}
            </section>

            <section className="v3-section-head rolling-pattern-heading">
              <div>
                <span>CURRENT TRIGGER · NEXT ISSUE</span>
                <h2>指向下一期 {data.run.targetIssue}</h2>
              </div>
              <p>
                当前筛选共 {data.pagination.total} 条。每条都必须写明条件 A、下一期结果 B
                和本期触发证据；不进入正式策略概率。
              </p>
            </section>

            {data.pagination.total === 0 ? (
              <section className="rolling-pattern-empty valid-empty">
                <span>VALID EMPTY RUN</span>
                <h2>本期没有同时满足当前触发和高于基准的近期规律</h2>
                <p>空结果已经冻结，不会反复重跑直到出现规律。</p>
              </section>
            ) : (
              <section className="rolling-pattern-list">
                {data.signals.map((signal, index) => (
                  <PatternCard
                    signal={signal}
                    score={scoreByRule.get(signal.rule.ruleId)}
                    rank={(data.pagination.page - 1) * data.pagination.pageSize + index + 1}
                    key={signal.rule.ruleId}
                  />
                ))}
              </section>
            )}

            {data.pagination.pages > 1 && (
              <nav className="rolling-pattern-pagination" aria-label="规律结果分页">
                <button
                  type="button"
                  disabled={page <= 1}
                  onClick={() => setPage((value) => Math.max(1, value - 1))}
                >
                  上一页
                </button>
                <span>{page} / {data.pagination.pages}</span>
                <button
                  type="button"
                  disabled={page >= data.pagination.pages}
                  onClick={() => setPage((value) => value + 1)}
                >
                  下一页
                </button>
              </nav>
            )}

            <section className="v3-science-note rolling-pattern-boundary">
              <span>RESEARCH BOUNDARY</span>
              <h2>高于基准，不等于已经验证</h2>
              <p>
                例如3次触发命中2次会显示66.7%的原始命中率，但样本仍然很小。
                页面同步给出精确随机基准和收缩后概率，避免把偶然结果描述成稳定优势。
              </p>
            </section>
          </>
        )}
      </main>
    </div>
  );
}

function SpecialNumberConsensusPanel({
  items,
  selectedNumber,
  onSelectNumber,
}: {
  items: SpecialNumberConsensus[];
  selectedNumber: number | null;
  onSelectNumber: (number: number) => void;
}) {
  return (
    <section className="special-number-consensus" aria-labelledby="special-number-consensus-title">
      <header>
        <div>
          <span>SPECIAL BALL · CATEGORY INTERSECTION</span>
          <h2 id="special-number-consensus-title">特码号码交集前15</h2>
        </div>
        <p>
          把特码生肖、尾数、波色、头数投影到01–49后汇总。比如0头与蓝波的交集包含03、04、09；
          点击号码可筛选下方所有支持策略。
        </p>
      </header>
      <div className="special-number-consensus-note">
        规律交集研究分，不是01–49的真实中奖概率；相同结果B先合并，避免相关策略被重复放大。
      </div>
      {items.length === 0 ? (
        <p className="rolling-pattern-result-empty">当前筛选没有可形成号码交集的特码规律。</p>
      ) : (
        <div className="special-number-consensus-grid">
          {items.map((item, index) => (
            <button
              type="button"
              className={selectedNumber === item.number ? "selected" : ""}
              aria-pressed={selectedNumber === item.number}
              onClick={() => onSelectNumber(item.number)}
              key={item.number}
            >
              <header>
                <span>#{String(index + 1).padStart(2, "0")}</span>
                <strong>{String(item.number).padStart(2, "0")}</strong>
                <em>研究分 +{(item.score * 100).toFixed(1)}</em>
              </header>
              <div className="special-number-consensus-evidence">
                {item.evidence.map((entry) => (
                  <span key={entry.eventId}>
                    <strong>{entry.label}</strong>
                    <small>{entry.strategyCount}策 · {percent(entry.hitRate)}</small>
                  </span>
                ))}
              </div>
              <footer>
                <span>{item.resultCount}类结果</span>
                <span>{item.strategyCount}条策略</span>
                <span>历史汇总 {percent(item.hitRate)}</span>
                <span>命中/失败 {item.hitCount}/{item.missCount}</span>
              </footer>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function PatternSummaryPanel({
  summary,
  selectedResult,
  onSelectResult,
}: {
  summary: RollingPatternSummary;
  selectedResult: string | null;
  onSelectResult: (eventId: string) => void;
}) {
  const cells = [
    ["支持策略数", `${summary.strategyCount}条`],
    ["支持结果数", `${summary.resultCount}种`],
    ["历史触发总次数", `${summary.triggerCount}次`],
    ["总命中次数", `${summary.hitCount}次`],
    ["总失败次数", `${summary.missCount}次`],
    ["汇总命中率", percent(summary.hitRate)],
    ["加权随机基准", percent(summary.baselineRate)],
    ["相对基准", signedPoints(summary.uplift)],
  ] as const;

  return (
    <section className="rolling-pattern-summary" aria-labelledby="pattern-summary-title">
      <header>
        <div>
          <span>ALL ACTIVE RULES · FULL WINDOW</span>
          <h2 id="pattern-summary-title">本期规律总统计</h2>
        </div>
        <p>
          统计当前分类全部冻结规律，不受每页20条限制。命中、失败和触发均为
          规则审计次数，不是独立期开奖期数。
        </p>
      </header>

      <div className="rolling-pattern-summary-kpis">
        {cells.map(([label, value]) => (
          <div key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>

      <div className="rolling-pattern-summary-detail">
        <span>
          随机预期命中 {decimal(summary.expectedHits)} 次 · 随机预期失败 {decimal(summary.expectedMisses)} 次
        </span>
        <strong>
          近期强证据 {summary.strongStrategyCount} 条 · 待验证 {summary.experimentalStrategyCount} 条
        </strong>
      </div>

      <section className="rolling-pattern-result-summary" aria-labelledby="result-summary-title">
        <header>
          <span>RESULT B CONSENSUS</span>
          <h3 id="result-summary-title">结果 B 支持汇总</h3>
          <p>相同结果由多少条条件规律支持，以及这些规律过去累计命中和失败多少次。</p>
        </header>
        {summary.resultGroups.length === 0 ? (
          <p className="rolling-pattern-result-empty">当前分类没有可汇总的结果 B。</p>
        ) : (
          <div className="rolling-pattern-result-grid">
            {summary.resultGroups.map((group) => (
              <PatternResultSummaryCard
                group={group}
                selected={selectedResult === group.eventId}
                onSelect={() => onSelectResult(group.eventId)}
                key={group.eventId}
              />
            ))}
          </div>
        )}
      </section>
    </section>
  );
}

function PatternResultSummaryCard({
  group,
  selected,
  onSelect,
}: {
  group: RollingPatternResultSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`rolling-pattern-result-card ${selected ? "selected" : ""}`}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <header>
        <span>{familyLabel(group.family)}</span>
        <strong>{group.label}</strong>
        <em>{group.strategyCount}条策略支持</em>
      </header>
      <div>
        <p><span>命中 / 失败</span><strong>{group.hitCount} / {group.missCount}</strong></p>
        <p><span>历史触发</span><strong>{group.triggerCount}次</strong></p>
        <p><span>汇总命中率</span><strong>{percent(group.hitRate)}</strong></p>
        <p><span>随机基准</span><strong>{percent(group.baselineRate)}</strong></p>
        <p><span>高于基准</span><strong className={group.uplift >= 0 ? "good" : "bad"}>{signedPoints(group.uplift)}</strong></p>
        <p><span>证据构成</span><strong>{group.strongStrategyCount}强 / {group.experimentalStrategyCount}待验</strong></p>
      </div>
    </button>
  );
}

function PatternRunContext({ run }: { run: RollingPatternRun }) {
  return (
    <section className="rolling-pattern-context">
      <div><span>研究彩种</span><strong>{GAME_META[run.game].name}</strong></div>
      <div><span>目标期</span><strong>{run.targetIssue}</strong></div>
      <div><span>30期范围</span><strong>{run.window.oldestIssue}–{run.window.newestIssue}</strong></div>
      <div><span>窗口样本</span><strong>{run.window.drawCount}/30期</strong></div>
      <div><span>冻结时间</span><strong>{beijingTime(run.frozenAt)}</strong></div>
      <div><span>规则版本</span><strong>{run.engineVersion}</strong></div>
    </section>
  );
}

function PatternFunnel({ run, scope }: { run: RollingPatternRun; scope: RollingPatternScope }) {
  const funnel = run.scopeFunnels?.[scope] ?? run.funnel;
  const cells = [
    ["模板生成", funnel.generated],
    ["当前触发", funnel.currentTriggered],
    ["规范去重", funnel.deduplicated],
    ["高于基准", funnel.aboveBaseline],
    ["最终展示", funnel.qualified],
  ] as const;
  return (
    <section className="rolling-pattern-funnel" aria-label="本期规律扫描漏斗">
      {cells.map(([label, value]) => (
        <div key={label}><span>{label}</span><strong>{value}</strong></div>
      ))}
    </section>
  );
}

function PatternCard({
  signal,
  score,
  rank,
}: {
  signal: RollingPatternSignal;
  score?: RollingPatternScore;
  rank: number;
}) {
  return (
    <article className={`rolling-pattern-card ${signal.evidenceTier}`}>
      <header>
        <div>
          <span>
            {String(rank).padStart(2, "0")} · {ruleFamilyLabel(signal.rule.family)} · {familyLabel(signal.rule.event.family)}
          </span>
          <h2>{signal.rule.relationLabel}</h2>
        </div>
        <strong className="rolling-pattern-sample">
          {signal.evidenceTier === "strong" ? "近期强证据" : "待验证规律"}
        </strong>
      </header>

      <div className="conditional-relation" aria-label="完整条件规律">
        <section>
          <span>历史条件 A</span>
          <strong>{signal.rule.conditionLabel}</strong>
        </section>
        <b aria-hidden="true">→</b>
        <section>
          <span>下一期结果 B</span>
          <strong className="rolling-pattern-result-value">{signal.rule.event.value}</strong>
          <small>{signal.rule.predictionLabel}</small>
        </section>
      </div>

      <div className="rolling-pattern-rate">
        <div><span>历史触发</span><strong>{signal.support}次</strong></div>
        <div><span>命中 / 失败</span><strong>{signal.hits} / {signal.support - signal.hits}</strong></div>
        <div><span>原始命中率</span><strong>{percent(signal.rawRate)}</strong></div>
        <div><span>B自身随机基准</span><strong>{percent(signal.baseline)}</strong></div>
        <div><span>高于基准</span><strong className="good">{signedPoints(signal.rawUplift)}</strong></div>
        <div><span>收缩后</span><strong>{percent(signal.posteriorRate)}</strong></div>
        <div><span>原始 p / FDR q</span><strong>{statValue(signal.pValue)} / {statValue(signal.qValue)}</strong></div>
        <div><span>证据结论</span><strong>{signal.evidenceTier === "strong" ? "q≤0.10" : signal.sampleLabel}</strong></div>
      </div>

      <div className="rolling-pattern-current">
        <span>本期触发依据</span>
        <div className="rolling-pattern-evidence-list">
          {signal.currentEvidence.map((evidence, index) => (
            <p key={`${evidence.issue}:${evidence.eventId}:${index}`}>
              <strong>{evidence.issue}</strong>
              <span>{evidence.eventLabel}</span>
              <em>实际{evidence.count}个 · {evidence.actualMatched ? "条件成立" : "条件未出现"}</em>
            </p>
          ))}
        </div>
        {signal.relatedRuleCount > 1 && (
          <small>已合并 {signal.relatedRuleCount} 条数学等价规则，未重复计数。</small>
        )}
        {score && <strong>{score.actualMatched ? "历史结算：命中" : "历史结算：未命中"}</strong>}
      </div>

      <details className="rolling-pattern-audit">
        <summary>查看 {signal.support} 次“A → B”历史审计 <span>展开</span></summary>
        <div>
          {signal.audit.map((item) => (
            <article key={`${item.sourceIssue}:${item.targetIssue}`}>
              <header>
                <span>{item.sourceIssue} 的条件 A → {item.targetIssue} 的结果 B</span>
                <strong className={item.matched ? "hit" : "miss"}>
                  {item.matched ? "命中" : "失败"}
                </strong>
              </header>
              <p>
                A：{item.conditionEvidence.map((evidence) =>
                  `${evidence.issue} ${evidence.eventLabel}（实际${evidence.count}个）`
                ).join("；")}
              </p>
              <p>
                B：{signal.rule.predictionLabel}，实际{item.result.count}个，
                {item.result.matched ? "已满足" : "未满足"}
              </p>
            </article>
          ))}
        </div>
      </details>
    </article>
  );
}

function familyLabel(family: RollingPatternFamily) {
  return { zodiac: "生肖", tail: "尾数", wave: "波色", head: "头数" }[family];
}

function ruleFamilyLabel(family: RollingPatternSignal["rule"]["family"]) {
  return {
    single_transfer: "单条件传导",
    conjunction_transfer: "双条件交集",
    sequence_transition: "节奏规律",
  }[family];
}

function percent(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function signedPoints(value: number) {
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}个百分点`;
}

function statValue(value: number) {
  return value < 0.001 ? "<0.001" : value.toFixed(3);
}

function decimal(value: number) {
  return value.toFixed(1);
}

function beijingTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}
