"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { GAME_META, type GameId } from "../../lib/lottery";
import type {
  ResearchEventForecast,
  ResearchV3Performance,
  ResearchV3Snapshot,
} from "../../lib/research-v3-types";

const GAMES: readonly GameId[] = ["new_macau", "hk"];

export function ResearchWorkspace() {
  const [game, setGame] = useState<GameId>("new_macau");
  const [snapshot, setSnapshot] = useState<ResearchV3Snapshot | null>(null);
  const [performance, setPerformance] = useState<ResearchV3Performance | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const selectGame = (nextGame: GameId) => {
    if (nextGame === game) return;
    setLoading(true);
    setError("");
    setSnapshot(null);
    setPerformance(null);
    setGame(nextGame);
  };

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      fetch(`/api/research/forecast?game=${game}`, {
        cache: "no-store",
        signal: controller.signal,
      }).then(async (response) => {
        const payload = await response.json() as ResearchV3Snapshot & {
          error?: string;
        };
        if (!response.ok) throw new Error(payload.error || "预测暂不可用。");
        return payload;
      }),
      fetch(`/api/research/performance?game=${game}`, {
        cache: "no-store",
        signal: controller.signal,
      }).then(async (response) => {
        if (!response.ok) return null;
        return await response.json() as ResearchV3Performance;
      }),
    ])
      .then(([forecast, history]) => {
        setSnapshot(forecast);
        setPerformance(history);
      })
      .catch((reason) => {
        if (!(reason instanceof DOMException && reason.name === "AbortError")) {
          setError(reason instanceof Error ? reason.message : "预测暂不可用。");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [game]);

  return (
    <div className="v3-shell">
      <header className="v3-topbar">
        <Link href="/" aria-label="返回开奖首页">← 开奖</Link>
        <div>
          <strong>六合智研</strong>
          <span>高概率策略中心</span>
        </div>
        <span>北京时间</span>
      </header>

      <main>
        <section className="v3-hero">
          <span>HIGH-PROBABILITY EVENTS · ONLINE LEARNING</span>
          <h1>不猜号码，<br />只研究高概率事件</h1>
          <p>
            每期只冻结四项40%–70%基线策略。开奖后全部交卷，
            再更新规则、模型权重和下一期概率。
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
          <nav className="v3-view-switch" aria-label="研究页面">
            <Link className="active" href="/research">下一期策略</Link>
            <Link href="/patterns">近30期规律</Link>
            <Link href="/research/review">逐期复盘</Link>
          </nav>
        </section>

        {loading && (
          <section className="v3-state" aria-live="polite">
            <span />
            正在读取冻结策略与学习状态…
          </section>
        )}

        {!loading && error && (
          <section className="v3-state error" role="alert">
            <strong>暂时无法读取研究结果</strong>
            <p>{error}</p>
          </section>
        )}

        {!loading && snapshot && (
          <>
            <RunContext snapshot={snapshot} />
            <section className="v3-section-head">
              <div>
                <span>NEXT DRAW · FOUR FIXED SLOTS</span>
                <h2>下一期固定四项</h2>
              </div>
              <p>
                目标期 {snapshot.targetIssue} ·
                开奖前概率已经冻结，页面刷新不会重新训练。
              </p>
            </section>

            <section className="v3-event-grid" aria-label="下一期四项高概率策略">
              {snapshot.events.map((event, index) => (
                <EventCard event={event} rank={index + 1} key={event.eventId} />
              ))}
            </section>

            <LearningBoard snapshot={snapshot} performance={performance} />

            <section className="v3-science-note">
              <span>SCIENTIFIC BOUNDARY</span>
              <h2>高命中不等于有优势</h2>
              <p>
                四项策略必须和各自的精确随机基线比较。即使命中率超过50%，
                如果Brier、log-loss或长期命中率没有超过基线，系统仍会判定
                “尚未证明优势”，并把概率收缩回随机水平。
              </p>
              <div>
                <strong>模型不会做的事</strong>
                <p>不输出01–49候选、不把分类交集换算成号码、不把负向避开计作正式命中。</p>
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}

function RunContext({ snapshot }: { snapshot: ResearchV3Snapshot }) {
  return (
    <section className="v3-context">
      <div><span>研究彩种</span><strong>{GAME_META[snapshot.game].name}</strong></div>
      <div><span>目标期</span><strong>{snapshot.targetIssue}</strong></div>
      <div><span>历史样本</span><strong>{snapshot.dataQuality.sampleSize}期</strong></div>
      <div>
        <span>{snapshot.game === "new_macau" ? "多源一致" : "核验比例"}</span>
        <strong>{percent(snapshot.dataQuality.verifiedRatio)}</strong>
      </div>
      <div>
        <span>运行层级</span>
        <strong className={snapshot.mode}>{snapshot.mode === "formal" ? "正式" : "影子"}</strong>
      </div>
    </section>
  );
}

function EventCard({
  event,
  rank,
}: {
  event: ResearchEventForecast;
  rank: number;
}) {
  const decisionStatus = event.decisionStatus ?? (
    event.evidenceTier === "verified" ? "formal" : "abstain"
  );
  const isFormal = decisionStatus === "formal";
  const isCandidate = decisionStatus === "research_candidate";
  return (
    <article className={`v3-event-card ${decisionStatus}`}>
      <header>
        <div>
          <span>{String(rank).padStart(2, "0")} · {event.slotLabel}</span>
          <h2>{isFormal ? event.predictionLabel : "正式层暂无已验证方向"}</h2>
          <p>{event.scopeLabel} · {isFormal ? evidenceLabel(event.evidenceTier) : "精确随机基线"}</p>
        </div>
        <div className="v3-probability">
          <strong>{percent(event.probability)}</strong>
          <span>{event.evidenceTier === "verified" ? "正式模型概率" : "正式基线概率"}</span>
        </div>
      </header>

      {isCandidate && (
        <div className="v3-decision v3-research-candidate">
          <span>研究候选</span>
          <strong>{event.predictionLabel}</strong>
          <p>校准绝对概率 {percent(event.experimentalProbability)}；仅供前瞻验证，不属于正式预测。</p>
        </div>
      )}
      {!isFormal && !isCandidate && (
        <div className="v3-decision v3-abstain">
          <span>研究层主动弃权</span>
          <strong>滚动回测尚未稳定超过随机基线</strong>
          <p>系统仍保存基线评分，但不向本期给出方向。</p>
        </div>
      )}

      <div className="v3-probability-track" aria-label="预测概率对比">
        <div style={{ width: `${event.probability * 100}%` }} />
        <i style={{ left: `${event.baselineProbability * 100}%` }} />
      </div>
      <div className="v3-baseline-row">
        <span>随机基线 {percent(event.baselineProbability)}</span>
        <strong className={event.uplift > 0 ? "good" : "bad"}>
          {signedPoints(event.uplift)}
        </strong>
      </div>

      {isCandidate && (
        <div className="v3-baseline-row">
          <span>研究候选概率 {percent(event.experimentalProbability ?? event.probability)}</span>
          <strong>{signedPoints(event.experimentalUplift ?? 0)}</strong>
        </div>
      )}

      <div className="v3-event-kpis">
        <div>
          <span>历史命中</span>
          <strong>{event.history.hits}/{event.history.sampleSize}</strong>
          <small>{percent(event.history.hitRate)}</small>
        </div>
        <div>
          <span>Brier skill</span>
          <strong>{signed(event.history.brierSkill, 3)}</strong>
          <small>{event.history.brierSkill > 0 ? "暂优于基线" : "未优于基线"}</small>
        </div>
        <div>
          <span>5折不劣</span>
          <strong>{percent(event.history.nonWorseFoldRatio)}</strong>
          <small>门槛80%</small>
        </div>
      </div>

      <p className="v3-rationale">{event.rationale}</p>
      {event.warning && <div className="v3-warning">{event.warning}</div>}

      <details className="v3-details">
        <summary>查看模型权重与快中慢证据 <span>展开</span></summary>
        <div className="v3-experts">
          {event.experts.map((expert) => (
            <div key={expert.modelId}>
              <header>
                <strong>{expert.label}</strong>
                <span>{percent(expert.weight)}权重</span>
              </header>
              <div>
                <i style={{ width: `${expert.weight * 100}%` }} />
              </div>
              <p>{percent(expert.probability)} · {expert.note}</p>
            </div>
          ))}
        </div>
        <div className="v3-contributions">
          {event.ruleContributions.map((rule) => (
            <div className={rule.direction} key={rule.ruleId}>
              <span>{rule.label}</span>
              <strong>{percent(rule.posteriorRate)}</strong>
              <small>
                样本{rule.support} · 基线{percent(rule.baselineRate)} ·
                {signedPoints(rule.contribution)}
              </small>
            </div>
          ))}
        </div>
      </details>
    </article>
  );
}

function LearningBoard({
  snapshot,
  performance,
}: {
  snapshot: ResearchV3Snapshot;
  performance: ResearchV3Performance | null;
}) {
  return (
    <section className="v3-learning-board">
      <header>
        <div>
          <span>SETTLE → LEARN → FREEZE</span>
          <h2>逐期开奖学习闭环</h2>
        </div>
        <Link href="/research/review">查看完整复盘 →</Link>
      </header>
      <div className="v3-learning-flow">
        {["冻结四项", "核验开奖", "概率评分", "误差归因", "更新权重", "冻结下期"].map(
          (label, index) => (
            <div key={label}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <strong>{label}</strong>
            </div>
          ),
        )}
      </div>
      <div className="v3-learning-kpis">
        <div>
          <span>已结算期数</span>
          <strong>{performance?.settledIssues ?? snapshot.learningSummary.settledForecasts}</strong>
        </div>
        <div>
          <span>累计命中</span>
          <strong>{performance ? `${performance.hits}/${performance.settledEvents}` : "等待结算"}</strong>
        </div>
        <div>
          <span>随机预期</span>
          <strong>{performance ? performance.expectedHits.toFixed(1) : "—"}</strong>
        </div>
        <div>
          <span>累计Brier skill</span>
          <strong>{performance ? signed(performance.brierSkill, 3) : "—"}</strong>
        </div>
      </div>
      <p className="v3-learning-conclusion">
        {performance?.conclusion ?? snapshot.learningSummary.message}
      </p>
    </section>
  );
}

function evidenceLabel(value: ResearchEventForecast["evidenceTier"]) {
  return {
    baseline: "随机基线",
    shadow: "影子学习",
    challenger: "历史挑战者",
    verified: "已验证",
  }[value];
}

function percent(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function signedPoints(value: number) {
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}个百分点`;
}

function signed(value: number, digits: number) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}
