"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { GAME_META, type GameId } from "../../../lib/lottery";
import type {
  RollingPatternEnvelope,
  RollingPatternFamily,
  RollingPatternRun,
  RollingPatternScore,
  RollingPatternSignal,
} from "../../../lib/rolling-pattern-types";

const GAMES: readonly GameId[] = ["new_macau", "hk"];
const FILTERS: ReadonlyArray<{
  value: RollingPatternFamily | null;
  label: string;
}> = [
  { value: null, label: "全部" },
  { value: "zodiac", label: "生肖" },
  { value: "tail", label: "尾数" },
  { value: "wave", label: "波色" },
  { value: "head", label: "头数" },
];

type PatternApiResponse = Partial<RollingPatternEnvelope> & {
  game: GameId;
  status: "completed" | "unavailable";
  run: RollingPatternRun | null;
  signals: RollingPatternSignal[];
  scores: RollingPatternScore[];
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
  const [family, setFamily] = useState<RollingPatternFamily | null>(null);
  const [page, setPage] = useState(1);
  const [response, setResponse] = useState<{
    key: string;
    data: PatternApiResponse | null;
    error: string;
  }>({ key: "", data: null, error: "" });
  const requestKey = `${game}:${family ?? "all"}:${page}`;
  const loading = response.key !== requestKey;
  const data = loading ? null : response.data;
  const error = loading ? "" : response.error;

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ game, page: String(page) });
    if (family) query.set("family", family);
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
  }, [game, family, page, requestKey]);

  const scoreByRule = useMemo(
    () => new Map((data?.scores ?? []).map((score) => [score.ruleId, score])),
    [data?.scores],
  );

  const selectGame = (next: GameId) => {
    if (next === game) return;
    setPage(1);
    setGame(next);
  };

  const selectFamily = (next: RollingPatternFamily | null) => {
    if (next === family) return;
    setPage(1);
    setFamily(next);
  };

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
          <span>ROLLING 30 · ACTIVE PATTERNS ONLY</span>
          <h1>只看最新30期，<br />只留本期已触发</h1>
          <p>
            新期开奖核验后先结算旧规律，再丢掉最早一期并完整重扫。
            原始命中率会公开展示，小样本同时经过基准收缩提醒。
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
          <ResearchNavigation active="patterns" />
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
            <PatternFunnel run={data.run} />
            <section className="rolling-pattern-toolbar" aria-label="规律分类筛选">
              {FILTERS.map((item) => (
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
                当前分类共 {data.pagination.total} 条。只表示最新30期内的待验证方向，
                不进入正式策略概率。
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

function ResearchNavigation({ active }: { active: "strategy" | "patterns" | "review" }) {
  return (
    <nav className="v3-view-switch" aria-label="研究页面">
      <Link className={active === "strategy" ? "active" : ""} href="/research">
        下一期策略
      </Link>
      <Link className={active === "patterns" ? "active" : ""} href="/research/patterns">
        近30期规律
      </Link>
      <Link className={active === "review" ? "active" : ""} href="/research/review">
        逐期复盘
      </Link>
    </nav>
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

function PatternFunnel({ run }: { run: RollingPatternRun }) {
  const cells = [
    ["模板生成", run.funnel.generated],
    ["当前触发", run.funnel.currentTriggered],
    ["规范去重", run.funnel.deduplicated],
    ["高于基准", run.funnel.aboveBaseline],
    ["最终展示", run.funnel.qualified],
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
    <article className="rolling-pattern-card">
      <header>
        <div>
          <span>{String(rank).padStart(2, "0")} · {familyLabel(signal.rule.event.family)} · 待验证规律</span>
          <h2>{signal.rule.description}</h2>
          <p>{signal.rule.event.label}</p>
        </div>
        <strong className="rolling-pattern-sample">{signal.sampleLabel}</strong>
      </header>

      <div className="rolling-pattern-rate">
        <div><span>近期命中</span><strong>{signal.hits}/{signal.support}</strong></div>
        <div><span>原始命中率</span><strong>{percent(signal.rawRate)}</strong></div>
        <div><span>随机基准</span><strong>{percent(signal.baseline)}</strong></div>
        <div><span>高于基准</span><strong className="good">{signedPoints(signal.rawUplift)}</strong></div>
        <div><span>收缩后</span><strong>{percent(signal.posteriorRate)}</strong></div>
      </div>

      <div className="rolling-pattern-state" aria-label="最近30期状态">
        {signal.stateHistory.map((state) => (
          <span
            className={state.matched ? "matched" : "missed"}
            aria-label={`${state.issue} ${state.matched ? "出现" : "未出现"}`}
            title={`${state.issue} ${state.matched ? "出现" : "未出现"}`}
            key={state.issue}
          >
            <i>{state.matched ? "出现" : "未出现"}</i>
          </span>
        ))}
      </div>

      <div className="rolling-pattern-current">
        <span>当前为何触发</span>
        <p>{signal.rule.description}，因此只研究目标期的“{signal.rule.event.value}”事件。</p>
        {signal.relatedRuleCount > 1 && (
          <small>已合并 {signal.relatedRuleCount} 条数学等价规则，未重复计数。</small>
        )}
        {score && <strong>{score.actualMatched ? "历史结算：命中" : "历史结算：未命中"}</strong>}
      </div>

      <details className="rolling-pattern-audit">
        <summary>查看 {signal.support} 次历史触发审计 <span>展开</span></summary>
        <div>
          {signal.audit.map((item) => (
            <p key={`${item.sourceIssue}:${item.targetIssue}`}>
              <span>{item.sourceIssue} → {item.targetIssue}</span>
              <strong className={item.matched ? "hit" : "miss"}>
                {item.matched ? "命中" : "失败"}
              </strong>
            </p>
          ))}
        </div>
      </details>
    </article>
  );
}

function familyLabel(family: RollingPatternFamily) {
  return { zodiac: "生肖", tail: "尾数", wave: "波色", head: "头数" }[family];
}

function percent(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function signedPoints(value: number) {
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}个百分点`;
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
