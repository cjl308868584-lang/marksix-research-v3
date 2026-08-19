"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { GAME_META, type GameId } from "../../lib/lottery";
import type {
  ForwardLearningForecast,
  ForwardLearningModelState,
  ForwardLearningReview,
  ForwardLearningSlot,
  ForwardLearningSlotPerformance,
} from "../../lib/forward-learning-types";

const GAMES: readonly GameId[] = ["new_macau", "hk"];
const SLOT_LABELS: Record<ForwardLearningSlot, string> = {
  coverage_zodiac: "6+1单生肖",
  coverage_tail: "6+1单尾数",
  coverage_zodiac_pair: "6+1二连肖",
  coverage_zodiac_triple: "6+1三连肖",
  special_number: "特码数字",
};

type LearningData = {
  forecasts: ForwardLearningForecast[];
  reviews: ForwardLearningReview[];
  performance: ForwardLearningSlotPerformance[];
  models: ForwardLearningModelState[];
};

export function ForwardLearningWorkspace() {
  const [game, setGame] = useState<GameId>("new_macau");
  const [data, setData] = useState<LearningData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void Promise.all([
      readJson<{ forecasts?: ForwardLearningForecast[] }>(`/api/learning/forecast?game=${game}`, controller.signal),
      readJson<{ reviews?: ForwardLearningReview[] }>(`/api/learning/reviews?game=${game}&limit=30`, controller.signal),
      readJson<{ performance?: ForwardLearningSlotPerformance[] }>(`/api/learning/performance?game=${game}`, controller.signal),
      readJson<{ models?: ForwardLearningModelState[] }>(`/api/learning/model?game=${game}`, controller.signal),
    ]).then(([forecast, reviews, performance, model]) => {
      setData({
        forecasts: forecast.forecasts ?? [],
        reviews: reviews.reviews ?? [],
        performance: performance.performance ?? [],
        models: model.models ?? [],
      });
    }).catch((reason) => {
      if (!(reason instanceof DOMException && reason.name === "AbortError")) {
        setError(reason instanceof Error ? reason.message : "逐期学习账本暂不可用。");
      }
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [game]);

  const latest = data?.reviews[0] ?? null;
  const conclusion = useMemo(() => learningConclusion(data?.performance ?? []), [data?.performance]);

  return (
    <div className="v3-shell forward-learning-shell">
      <header className="v3-topbar">
        <Link href="/" aria-label="返回开奖首页">← 开奖</Link>
        <div><strong>六合智研</strong><span>逐期学习中心</span></div>
        <span>北京时间</span>
      </header>
      <main>
        <section className="v3-hero forward-learning-hero">
          <span>PRE-DRAW FREEZE · FORWARD SCORE · ONLINE LEARNING</span>
          <h1>每期固定五项，<br />开奖以后全部交卷</h1>
          <p>这里是独立的前瞻学习账本。每期只保存一个单生肖、单尾数、二连肖、三连肖和特码数字；先冻结，后核验，再更新下一期。</p>
          <div className="v3-game-switch" role="group" aria-label="选择彩种">
            {GAMES.map((item) => <button type="button" className={game === item ? "active" : ""} onClick={() => setGame(item)} key={item}>{GAME_META[item].name}</button>)}
          </div>
        </section>

        {loading && <section className="v3-state" aria-live="polite"><span />正在读取不可变学习账本…</section>}
        {!loading && error && <section className="v3-state error" role="alert"><strong>学习账本暂不可用</strong><p>{error}</p></section>}
        {!loading && !error && data && (
          <>
            <section className="forward-learning-status">
              <div><span>研究彩种</span><strong>{GAME_META[game].name}</strong></div>
              <div><span>下一目标期</span><strong>{data.forecasts[0]?.targetIssue ?? "待冻结"}</strong></div>
              <div><span>正式样本</span><strong>{data.reviews.length}期</strong></div>
              <div><span>模型版本</span><strong>{data.models[0]?.version ?? "基线启动"}</strong></div>
            </section>

            <section className={`forward-learning-verdict ${conclusion.tone}`}>
              <span>IS THE MODEL REALLY IMPROVING?</span>
              <h2>模型是否真的在进步：{conclusion.title}</h2>
              <p>{conclusion.detail}</p>
            </section>

            <section className="v3-section-head">
              <div><span>NEXT ISSUE · FIVE OFFICIAL SLOTS</span><h2>下一期冻结方向</h2></div>
              <p>每个槽位只选概率最高的一项；赔率不参与模型排序。页面刷新不会改动冻结结果。</p>
            </section>
            {data.forecasts.length === 5 ? (
              <section className="forward-learning-grid" aria-label="每期固定五项">
                {data.forecasts.map((forecast, index) => <ForecastCard forecast={forecast} index={index} key={forecast.forecastId} />)}
              </section>
            ) : (
              <section className="rolling-pattern-empty valid-empty"><span>WAITING FOR FIRST FREEZE</span><h2>五项正式方向尚未完整冻结</h2><p>系统不会拿旧规律或不完整结果补位。下一次已核验开奖任务会创建首期账本。</p></section>
            )}

            <section className="v3-section-head forward-learning-heading">
              <div><span>LATEST SETTLEMENT</span><h2>最近一期逐项结算</h2></div>
              <p>正式命中率只统计五个冻结槽位，不把候选规律的多次触发相加。</p>
            </section>
            {latest ? <LatestReview review={latest} /> : <EmptyLearning text="尚无开奖后结算样本。首期只冻结，不制造历史成绩。" />}

            <section className="v3-section-head forward-learning-heading">
              <div><span>RELATIVE TO EXACT BASELINE</span><h2>分槽位学习表现</h2></div>
              <p>同时看命中率、随机基线与 Brier skill；命中率高但未超过基线，不算模型进步。</p>
            </section>
            <PerformanceBoard performance={data.performance} />

            <section className="forward-learning-model-board">
              <header><div><span>THREE EXPERTS</span><h2>模型权重</h2></div><p>随机基线专家永不低于25%；单一专家不会超过60%。</p></header>
              <div className="forward-learning-model-grid">
                {data.models.map((model) => <ModelCard model={model} key={model.stateId} />)}
              </div>
            </section>

            <section className="forward-learning-model-board">
              <header><div><span>RULE AUDIT</span><h2>规则奖励与降权</h2></div><p>只根据开奖前冻结的正式方向更新；高置信错误处罚更重，命中但不高于基线不奖励。</p></header>
              <RuleUpdates review={latest} />
            </section>
          </>
        )}
      </main>
    </div>
  );
}

function ForecastCard({ forecast, index }: { forecast: ForwardLearningForecast; index: number }) {
  return <article className={`forward-learning-card slot-${forecast.slot}`}>
    <header><span>{String(index + 1).padStart(2, "0")} · {SLOT_LABELS[forecast.slot]}</span><strong>{percent(forecast.finalProbability)}</strong></header>
    <h2>{forecast.label}</h2>
    <p>{forecast.explanation[0] ?? "基于精确随机基线与已结算前瞻样本。"}</p>
    <div className="forward-learning-card-kpis">
      <div><span>精确基线</span><strong>{percent(forecast.baselineProbability)}</strong></div>
      <div><span>相对变化</span><strong>{signedPoints(forecast.finalProbability - forecast.baselineProbability)}</strong></div>
      <div><span>独立证据簇</span><strong>{forecast.evidenceClusterCount}</strong></div>
      <div><span>已结算样本</span><strong>{forecast.forwardSettledCount}</strong></div>
    </div>
    <footer><span>备选：{forecast.topAlternative ?? "无"}</span><span>冻结 {formatTime(forecast.frozenAt)}</span></footer>
  </article>;
}

function LatestReview({ review }: { review: ForwardLearningReview }) {
  const hits = review.scores.filter((score) => score.actualMatched).length;
  const official = review.scores.filter((score) => score.official);
  const mean = (read: (score: typeof official[number]) => number) => official.length ? official.reduce((sum, score) => sum + read(score), 0) / official.length : 0;
  const brierSkill = mean((score) => score.baselineBrier) > 0 ? 1 - mean((score) => score.brier) / mean((score) => score.baselineBrier) : 0;
  return <section className="forward-learning-review">
    <header><div><span>第 {review.run.settledIssue} 期</span><h2>{hits} / {official.length} 命中</h2></div><div><span>本期 Brier skill</span><strong className={brierSkill > 0 ? "positive" : "negative"}>{signedPercent(brierSkill)}</strong></div></header>
    <div className="forward-learning-score-grid">
      {official.map((score) => <article className={score.actualMatched ? "hit" : "miss"} key={score.scoreId}>
        <span>{SLOT_LABELS[score.slot]}</span><h3>{score.resultKey}</h3><strong>{score.actualMatched ? "命中" : "未命中"}</strong>
        <p>概率 {percent(score.probability)} · 基线 {percent(score.baselineProbability)}</p>
      </article>)}
    </div>
    <footer>实际特码 {String(official[0]?.actualSpecial ?? "—").padStart(2, "0")} · 结算 {formatTime(official[0]?.scoredAt ?? review.run.completedAt ?? "")}</footer>
  </section>;
}

function PerformanceBoard({ performance }: { performance: ForwardLearningSlotPerformance[] }) {
  return <section className="forward-learning-performance">
    {performance.map((item) => {
      const recent = item.windows.find((window) => window.window === "recent30") ?? item.windows[0];
      const all = item.windows.find((window) => window.window === "all") ?? item.windows[0];
      return <article key={item.slot}><header><span>{SLOT_LABELS[item.slot]}</span><strong>{recent?.settledCount ?? 0}期</strong></header>
        <div><span>近30命中率</span><strong>{percent(recent?.hitRate ?? 0)}</strong></div>
        <div><span>近30随机基线</span><strong>{percent(recent?.meanBaseline ?? 0)}</strong></div>
        <div><span>Brier skill</span><strong className={(recent?.brierSkill ?? 0) > 0 ? "positive" : "negative"}>{signedPercent(recent?.brierSkill ?? 0)}</strong></div>
        <div><span>全历史 Brier skill</span><strong className={(all?.brierSkill ?? 0) > 0 ? "positive" : "negative"}>{signedPercent(all?.brierSkill ?? 0)}</strong></div>
      </article>;
    })}
  </section>;
}

function ModelCard({ model }: { model: ForwardLearningModelState }) {
  return <article><header><span>{SLOT_LABELS[model.slot]}</span><small>学至 {model.learnedThroughIssue ?? "尚未结算"}</small></header>
    {(["baseline", "rules30", "forward"] as const).map((expert) => <div className="forward-learning-weight" key={expert}><span>{expertLabel(expert)}</span><i><b style={{ width: `${model.weights[expert] * 100}%` }} /></i><strong>{percent(model.weights[expert])}</strong></div>)}
  </article>;
}

function RuleUpdates({ review }: { review: ForwardLearningReview | null }) {
  if (!review?.ruleUpdates.length) return <EmptyLearning text="本次正式方向没有可更新的独立规则，或尚无结算样本。" />;
  return <div className="forward-learning-rule-list">{review.ruleUpdates.slice(0, 20).map((update) => <article key={`${update.slot}:${update.ruleId}`}><span className={update.action}>{update.action === "rewarded" ? "奖励" : update.action === "reduced" ? "降权" : "不变"}</span><div><strong>{SLOT_LABELS[update.slot]}</strong><p>{update.reason}</p></div><small>{percent(update.beforeWeight)} → {percent(update.afterWeight)}</small></article>)}</div>;
}

function EmptyLearning({ text }: { text: string }) { return <section className="forward-learning-empty">{text}</section>; }

async function readJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { cache: "no-store", signal });
  const payload = await response.json() as T & { error?: string };
  if (!response.ok && response.status !== 404) throw new Error(payload.error || "逐期学习账本暂不可用。");
  return payload;
}

function learningConclusion(performance: ForwardLearningSlotPerformance[]) {
  const all = performance.flatMap((item) => item.windows.filter((window) => window.window === "all"));
  const settled = all.reduce((sum, item) => sum + item.settledCount, 0);
  const weightedSkill = settled ? all.reduce((sum, item) => sum + item.brierSkill * item.settledCount, 0) / settled : 0;
  if (!settled) return { tone: "neutral", title: "尚无证据", detail: "首期只负责冻结。必须等待真实开奖形成前瞻样本后，才判断模型是否优于随机基线。" };
  if (weightedSkill > 0.02) return { tone: "positive", title: "目前优于基线", detail: `累计 ${settled} 个正式槽位样本，加权 Brier skill 为 ${signedPercent(weightedSkill)}。仍需继续观察各槽位是否稳定。` };
  if (weightedSkill < 0) return { tone: "negative", title: "目前没有进步", detail: `累计 ${settled} 个正式槽位样本仍落后随机基线。系统应降低规则与历史专家权重，主动回归基线。` };
  return { tone: "neutral", title: "与基线基本相当", detail: `累计 ${settled} 个正式槽位样本尚未证明稳定优势，系统不会把短期高命中包装成进步。` };
}

function expertLabel(value: "baseline" | "rules30" | "forward") { return value === "baseline" ? "随机基线" : value === "rules30" ? "30期规律" : "前瞻历史"; }
function percent(value: number) { return `${(value * 100).toFixed(1)}%`; }
function signedPercent(value: number) { return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`; }
function signedPoints(value: number) { return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}个百分点`; }
function formatTime(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(date); }
