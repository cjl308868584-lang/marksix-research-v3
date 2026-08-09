"use client";

/* eslint-disable react-hooks/set-state-in-effect -- legacy request reset is intentionally synchronous */
import Link from "next/link";
import { useEffect, useState } from "react";
import { GAME_META, getZodiac, type GameId } from "../../../lib/lottery";
import type {
  ResearchEventReview,
  ResearchV3Performance,
  ResearchV3Review,
} from "../../../lib/research-v3-types";

const GAMES: readonly GameId[] = ["new_macau", "hk"];

export function ResearchReviewWorkspace() {
  const [game, setGame] = useState<GameId>("new_macau");
  const [reviews, setReviews] = useState<ResearchV3Review[]>([]);
  const [performance, setPerformance] = useState<ResearchV3Performance | null>(
    null,
  );
  const [selectedIssue, setSelectedIssue] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    setLoading(true);
    setError("");
    setReviews([]);
    setSelectedIssue("");
    void Promise.all([
      fetch(`/api/research/reviews?game=${game}&limit=50`, {
        cache: "no-store",
        signal: controller.signal,
      }).then(async (response) => {
        const payload = await response.json() as {
          reviews?: ResearchV3Review[];
          error?: string;
        };
        if (!response.ok) {
          throw new Error(payload.error || "复盘数据暂不可用。");
        }
        return payload.reviews ?? [];
      }),
      fetch(`/api/research/performance?game=${game}`, {
        cache: "no-store",
        signal: controller.signal,
      }).then(async (response) => {
        if (!response.ok) return null;
        return await response.json() as ResearchV3Performance;
      }),
    ])
      .then(([items, summary]) => {
        setReviews(items);
        setPerformance(summary);
        setSelectedIssue(items[0]?.targetIssue ?? "");
        if (items.length === 0) {
          retryTimer = setTimeout(() => {
            setRefreshKey((value) => value + 1);
          }, 30_000);
        }
      })
      .catch((reason) => {
        if (!(reason instanceof DOMException && reason.name === "AbortError")) {
          setError(reason instanceof Error ? reason.message : "复盘数据暂不可用。");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [game, refreshKey]);

  const review =
    reviews.find((item) => item.targetIssue === selectedIssue) ??
    reviews[0] ??
    null;

  return (
    <div className="v3-shell">
      <header className="v3-topbar">
        <Link href="/" aria-label="返回开奖首页">← 开奖</Link>
        <div>
          <strong>六合智研</strong>
          <span>逐期学习复盘</span>
        </div>
        <span>北京时间</span>
      </header>

      <main>
        <section className="v3-hero v3-review-hero">
          <span>IMMUTABLE LEDGER · POST-DRAW LEARNING</span>
          <h1>每期开奖后，<br />模型都必须交卷</h1>
          <p>
            四项策略在开奖前冻结。开奖结果核验后逐项计算概率损失、
            解释错误原因、更新专家权重，再用于下一期。
          </p>
          <div className="v3-game-switch" role="group" aria-label="选择彩种">
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
          <nav className="v3-view-switch" aria-label="研究页面">
            <Link href="/research">下一期策略</Link>
            <Link href="/patterns">近30期规律</Link>
            <Link className="active" href="/research/review">逐期复盘</Link>
          </nav>
        </section>

        {loading && (
          <section className="v3-state" aria-live="polite">
            <span />
            正在读取不可变复盘账本…
          </section>
        )}
        {!loading && error && (
          <section className="v3-state error" role="alert">
            <strong>暂时无法读取复盘</strong>
            <p>{error}</p>
          </section>
        )}
        {!loading && !error && reviews.length === 0 && (
          <section className="v3-review-empty">
            <span>WAITING FOR FIRST SETTLEMENT</span>
            <h2>v3还没有已结算期</h2>
            <p>
              第一组四项策略开奖并完成双源核验后，这里会自动出现命中、
              概率评分、错误诊断和模型权重变化。
            </p>
            <button
              type="button"
              onClick={() => setRefreshKey((value) => value + 1)}
            >
              重新读取复盘账本
            </button>
            <a href="/research">查看下一期冻结策略 →</a>
          </section>
        )}

        {!loading && review && (
          <>
            <IssuePicker
              reviews={reviews}
              selectedIssue={review.targetIssue}
              onSelect={setSelectedIssue}
            />
            <PerformanceBoard performance={performance} />
            <ReviewSummary review={review} />
            <section className="v3-review-event-list">
              {review.events.map((event, index) => (
                <ReviewEvent event={event} rank={index + 1} key={event.eventId} />
              ))}
            </section>
            <section className="v3-learning-result">
              <span>LEARNING RUN</span>
              <h2>{review.learningRun.summary}</h2>
              <div>
                <p>
                  冠军更新前
                  <strong>{modelLabel(review.learningRun.championBefore)}</strong>
                </p>
                <p>
                  当前权重领先
                  <strong>{modelLabel(review.learningRun.championAfter)}</strong>
                </p>
                <p>
                  漂移检测
                  <strong>{review.learningRun.driftDetected ? "发现信号" : "未发现"}</strong>
                </p>
              </div>
              <small>{review.nextAction}</small>
            </section>
          </>
        )}
      </main>
    </div>
  );
}

function IssuePicker({
  reviews,
  selectedIssue,
  onSelect,
}: {
  reviews: ResearchV3Review[];
  selectedIssue: string;
  onSelect: (issue: string) => void;
}) {
  return (
    <section className="v3-issue-picker" aria-label="选择复盘期号">
      {reviews.map((review) => (
        <button
          type="button"
          className={selectedIssue === review.targetIssue ? "active" : ""}
          onClick={() => onSelect(review.targetIssue)}
          key={review.runId}
        >
          <span>{review.targetIssue}</span>
          <strong>{review.hits}/4</strong>
          <small>{formatDate(review.settledAt)}</small>
        </button>
      ))}
    </section>
  );
}

function PerformanceBoard({
  performance,
}: {
  performance: ResearchV3Performance | null;
}) {
  if (!performance) return null;
  return (
    <section className="v3-performance-board">
      <header>
        <div>
          <span>LEARNING CURVE</span>
          <h2>模型是否真的在进步</h2>
        </div>
        <p>{performance.conclusion}</p>
      </header>
      <div className="v3-window-grid">
        {performance.windows.map((window) => (
          <div key={String(window.window)}>
            <span>{window.window === "all" ? "全部前瞻" : `近${window.window}期`}</span>
            <strong>{percent(window.hitRate)}</strong>
            <small>随机 {percent(window.baselineHitRate)}</small>
            <div>
              <i
                className={window.brierSkill > 0 ? "good" : "bad"}
                style={{ width: `${Math.min(Math.abs(window.brierSkill) * 500, 100)}%` }}
              />
            </div>
            <em>Brier skill {signed(window.brierSkill, 3)}</em>
          </div>
        ))}
      </div>
    </section>
  );
}

function ReviewSummary({ review }: { review: ResearchV3Review }) {
  return (
    <section className="v3-review-summary">
      <header>
        <div>
          <span>ISSUE {review.targetIssue} · VERIFIED</span>
          <h2>本期固定四项结算</h2>
          <p>{review.summary}</p>
        </div>
        <div className="v3-review-score">
          <strong>{review.hits}/4</strong>
          <span>本期命中</span>
        </div>
      </header>
      <div className="v3-actual-row" aria-label="本期开奖结果">
        {review.actual.numbers.map((number, index) => (
          <span key={`${number}-${index}`}>
            <strong>{String(number).padStart(2, "0")}</strong>
            <small>{getZodiac(number, review.actual.drawAt)}</small>
          </span>
        ))}
        <i>＋</i>
        <span className="special">
          <strong>{String(review.actual.special).padStart(2, "0")}</strong>
          <small>{getZodiac(review.actual.special, review.actual.drawAt)}</small>
        </span>
      </div>
      <div className="v3-review-kpis">
        <div><span>随机预期</span><strong>{review.expectedHits.toFixed(2)}项</strong></div>
        <div><span>实际提升</span><strong>{signedPoints(review.hitRate - review.baselineHitRate)}</strong></div>
        <div><span>Brier skill</span><strong>{signed(review.brierSkill, 3)}</strong></div>
        <div><span>log-loss skill</span><strong>{signed(review.logLossSkill, 3)}</strong></div>
      </div>
    </section>
  );
}

function ReviewEvent({
  event,
  rank,
}: {
  event: ResearchEventReview;
  rank: number;
}) {
  return (
    <article className={`v3-review-event ${event.actualMatched ? "hit" : "miss"}`}>
      <header>
        <span>{String(rank).padStart(2, "0")} · {event.slotLabel}</span>
        <h2>{event.prediction}</h2>
        <strong>{event.actualMatched ? "命中" : "未中"}</strong>
      </header>
      <div className="v3-review-event-values">
        <div><span>模型概率</span><strong>{percent(event.probability)}</strong></div>
        <div><span>随机基线</span><strong>{percent(event.baselineProbability)}</strong></div>
        <div><span>实际结果</span><strong>{event.actualLabel}</strong></div>
        <div><span>Brier skill</span><strong>{signed(event.brierSkill, 3)}</strong></div>
      </div>
      <div className="v3-diagnosis">
        <span>误差归因</span>
        {event.diagnosis.map((item) => <p key={item}>{item}</p>)}
      </div>
      <details className="v3-details">
        <summary>查看模型权重如何变化 <span>展开</span></summary>
        <div className="v3-weight-changes">
          {event.modelWeightsBefore.map((before) => {
            const after = event.modelWeightsAfter.find(
              (item) => item.modelId === before.modelId,
            ) ?? before;
            return (
              <div key={before.modelId}>
                <strong>{before.label}</strong>
                <span>{percent(before.weight)} → {percent(after.weight)}</span>
                <small>{signedPoints(after.weight - before.weight)}</small>
              </div>
            );
          })}
        </div>
      </details>
    </article>
  );
}

function modelLabel(value: string) {
  return {
    baseline: "精确随机基线",
    interpretable_rules: "可解释规则集成",
    logistic: "正则化逻辑回归",
    black_box: "黑盒挑战者",
  }[value] ?? value;
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

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}
