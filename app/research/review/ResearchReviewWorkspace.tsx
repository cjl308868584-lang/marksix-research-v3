"use client";

import { useEffect, useMemo, useState } from "react";
import {
  GAME_META,
  getWave,
  getZodiac,
  type GameId,
} from "../../../lib/lottery";
import type {
  ResearchReview,
  ResearchRuleReview,
  ResearchRuleReviewOutcome,
} from "../../../lib/research-v2-types";

type ReviewFilter =
  | "all"
  | ResearchRuleReviewOutcome
  | "passed";

const GAMES: readonly GameId[] = ["new_macau", "hk"];

const OUTCOME_META: Record<
  ResearchRuleReviewOutcome,
  { label: string; tone: "good" | "bad" }
> = {
  positive_hit: { label: "正向命中", tone: "good" },
  positive_miss: { label: "正向未中", tone: "bad" },
  negative_avoided: { label: "负向避开", tone: "good" },
  negative_failed: { label: "负向失效", tone: "bad" },
};

export function ResearchReviewWorkspace() {
  const [game, setGame] = useState<GameId>("new_macau");
  const [reviews, setReviews] = useState<ResearchReview[]>([]);
  const [selectedIssue, setSelectedIssue] = useState("");
  const [filter, setFilter] = useState<ReviewFilter>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setReviews([]);
    setSelectedIssue("");
    setFilter("all");
    void fetch(`/api/research/reviews?game=${game}&limit=12`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json() as {
          reviews?: ResearchReview[];
          error?: string;
        };
        if (!response.ok) {
          throw new Error(payload.error || "复盘数据暂不可用。");
        }
        return payload.reviews ?? [];
      })
      .then((items) => {
        setReviews(items);
        setSelectedIssue(items[0]?.targetIssue ?? "");
      })
      .catch((reason) => {
        if (!(reason instanceof DOMException && reason.name === "AbortError")) {
          setError(reason instanceof Error ? reason.message : "复盘数据暂不可用。");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [game]);

  const review = reviews.find((item) => item.targetIssue === selectedIssue) ??
    reviews[0] ??
    null;
  const visibleRules = useMemo(() => {
    if (!review) return [];
    return review.rules
      .filter((rule) =>
        filter === "all"
          ? true
          : filter === "passed"
            ? rule.passedHistoricalGate
            : rule.outcome === filter,
      )
      .sort(
        (left, right) =>
          Number(right.passedHistoricalGate) -
            Number(left.passedHistoricalGate) ||
          Number(left.directionCorrect) - Number(right.directionCorrect) ||
          left.qValue - right.qValue ||
          right.support - left.support,
      );
  }, [filter, review]);

  return (
    <div className="rule-research-shell review-shell">
      <header className="rule-research-topbar">
        <a href="/" className="rule-back-link" aria-label="返回开奖首页">← 返回开奖</a>
        <div>
          <strong>六合智研</strong>
          <span>规律复盘中心</span>
        </div>
        <span className="rule-research-clock">北京时间</span>
      </header>

      <main>
        <section className="rule-research-hero review-hero">
          <span>PERIOD LEDGER · VERIFIED SETTLEMENT</span>
          <h1>每一期规律，<br />开奖后都要交卷</h1>
          <p>
            开奖前冻结当期全部可用规律，核验结果后逐条套入实际号码。
            命中、失效、随机期望和历史门槛成绩全部保留，不能事后改答案。
          </p>
          <div className="rule-game-switch" role="group" aria-label="选择复盘彩种">
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
          <ResearchViewSwitch active="review" />
        </section>

        {loading && (
          <section className="rule-research-state" aria-live="polite">
            <span className="rule-loading-dot" />
            正在结算并读取每期规律账本…
          </section>
        )}

        {!loading && error && (
          <section className="rule-research-state error" role="alert">
            <strong>暂时无法读取复盘</strong>
            <p>{error}</p>
          </section>
        )}

        {!loading && !error && reviews.length === 0 && (
          <section className="review-empty">
            <span>WAITING FOR VERIFIED DRAW</span>
            <h2>预测已经冻结，等待可核验开奖结果</h2>
            <p>
              当某期结果通过来源核验后，系统会自动把实际号码套入该期保存的每一条规律，
              生成永久复盘记录。没有冻结预测的历史期不会补写成绩。
            </p>
            <a href="/research">查看下一期已冻结规律 →</a>
          </section>
        )}

        {review && (
          <>
            <section className="review-issue-picker" aria-label="选择复盘期号">
              {reviews.map((item) => (
                <button
                  type="button"
                  className={item.targetIssue === review.targetIssue ? "active" : ""}
                  onClick={() => {
                    setSelectedIssue(item.targetIssue);
                    setFilter("all");
                  }}
                  key={item.runId}
                >
                  <span>第 {item.targetIssue} 期</span>
                  <small>
                    {percent(item.directionalSuccessRate)} · {dateLabel(item.actual.drawAt)}
                  </small>
                </button>
              ))}
            </section>

            <section className="review-result-board">
              <div className="review-result-copy">
                <span>SETTLED · 第 {review.targetIssue} 期</span>
                <h2>实际开奖结果</h2>
                <p>
                  规律冻结于 {dateTime(review.frozenAt)}，开奖结果于 {dateTime(review.settledAt)}
                  完成核验结算。
                </p>
              </div>
              <div className="review-ball-row" aria-label="实际开奖号码">
                {review.actual.numbers.map((number, index) => (
                  <ReviewBall
                    number={number}
                    drawAt={review.actual.drawAt}
                    label={`正${index + 1}`}
                    key={`${number}-${index}`}
                  />
                ))}
                <span className="review-plus">+</span>
                <ReviewBall
                  number={review.actual.special}
                  drawAt={review.actual.drawAt}
                  label="特码"
                  special
                />
              </div>
            </section>

            <section className="review-kpis" aria-label="本期复盘摘要">
              <ReviewMetric
                label="冻结可用规律"
                value={String(review.availableRuleCount)}
                note="开奖前已保存"
              />
              <ReviewMetric
                label="正向命中"
                value={`${review.positiveHits}/${review.positiveRuleCount}`}
                note={percent(review.positiveHits / Math.max(review.positiveRuleCount, 1))}
                tone="good"
              />
              <ReviewMetric
                label="负向成功避开"
                value={`${review.negativeAvoided}/${review.negativeRuleCount}`}
                note={percent(review.negativeAvoided / Math.max(review.negativeRuleCount, 1))}
                tone="good"
              />
              <ReviewMetric
                label="历史门槛规律"
                value={`${review.passedRuleCorrect}/${review.passedRuleCount}`}
                note="方向正确 / 已通过"
              />
              <ReviewMetric
                label="方向正确率"
                value={percent(review.directionalSuccessRate)}
                note={`随机期望 ${percent(review.baselineDirectionalRate)}`}
                tone={review.directionalLift >= 0 ? "good" : "bad"}
              />
            </section>

            <section className="review-conclusion">
              <div>
                <span>本期结论</span>
                <h2>{review.directionalLift >= 0 ? "本期高于对应随机期望" : "本期低于对应随机期望"}</h2>
              </div>
              <div>
                <p>{review.summary}</p>
                <small>{review.nextAction}</small>
              </div>
            </section>

            <section className="review-method-note">
              <strong>正向和负向必须分开理解</strong>
              <p>
                正向规律只有预测分类实际出现才算命中；负向规律只有被降权的分类没有出现才算“成功避开”。
                负向避开率本来就可能很高，因此系统会和 <em>1−该分类随机基线</em> 比较，不能只看表面正确率。
              </p>
            </section>

            <section className="review-filter-bar" aria-label="筛选复盘结果">
              {([
                ["all", "全部"],
                ["positive_hit", "正向命中"],
                ["positive_miss", "正向未中"],
                ["negative_avoided", "负向避开"],
                ["negative_failed", "负向失效"],
                ["passed", "历史门槛"],
              ] as const).map(([value, label]) => (
                <button
                  type="button"
                  className={filter === value ? "active" : ""}
                  onClick={() => setFilter(value)}
                  key={value}
                >
                  {label}
                  <small>{filterCount(review.rules, value)}</small>
                </button>
              ))}
            </section>

            <div className="review-list-head">
              <div>
                <span>RULE-BY-RULE SETTLEMENT</span>
                <strong>{visibleRules.length} 条逐项复盘</strong>
              </div>
              <p>优先显示历史门槛规律与本期失效项目</p>
            </div>

            <section className="review-rule-list">
              {visibleRules.map((rule, index) => (
                <ReviewRuleCard rule={rule} rank={index + 1} key={rule.ruleId} />
              ))}
              {visibleRules.length === 0 && (
                <div className="rule-empty">当前筛选条件下没有复盘项目。</div>
              )}
            </section>

            <section className="rule-boundary review-boundary">
              <strong>不可改写账本</strong>
              <p>
                页面中的预测值、方向、历史指标和规则版本来自开奖前冻结快照；
                实际值只在开奖结果通过核验后写入。历史复盘不会用开奖结果反向修改当期预测。
              </p>
              <small>
                运行 {review.runId} · 复盘版本 {review.reviewVersion} ·
                来源 {review.actual.source}
              </small>
            </section>
          </>
        )}
      </main>
    </div>
  );
}

function ResearchViewSwitch({ active }: { active: "forecast" | "review" }) {
  return (
    <nav className="research-view-switch" aria-label="研究页面">
      <a className={active === "forecast" ? "active" : ""} href="/research">
        下一期规律
        <small>开奖前冻结</small>
      </a>
      <a className={active === "review" ? "active" : ""} href="/research/review">
        历史复盘
        <small>开奖后结算</small>
      </a>
    </nav>
  );
}

function ReviewBall({
  number,
  drawAt,
  label,
  special = false,
}: {
  number: number;
  drawAt: string;
  label: string;
  special?: boolean;
}) {
  const wave = getWave(number);
  return (
    <div className={`review-ball-item ${special ? "special" : ""}`}>
      <small>{label}</small>
      <strong className={`review-ball wave-${wave}`}>
        {String(number).padStart(2, "0")}
      </strong>
      <span>{getZodiac(number, drawAt)}</span>
    </div>
  );
}

function ReviewMetric({
  label,
  value,
  note,
  tone = "",
}: {
  label: string;
  value: string;
  note: string;
  tone?: "good" | "bad" | "";
}) {
  return (
    <div className={tone}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{note}</small>
    </div>
  );
}

function ReviewRuleCard({
  rule,
  rank,
}: {
  rule: ResearchRuleReview;
  rank: number;
}) {
  const meta = OUTCOME_META[rule.outcome];
  return (
    <article className={`review-rule-card ${meta.tone}`}>
      <div className="review-rule-main">
        <span className="review-rule-rank">{String(rank).padStart(2, "0")}</span>
        <div>
          <div className="review-rule-tags">
            <span>{rule.targetLabel}</span>
            <span>{rule.direction === "positive" ? "正向" : "负向"}</span>
            {rule.passedHistoricalGate && <span className="passed">历史门槛通过</span>}
          </div>
          <h2>{rule.description}</h2>
        </div>
        <strong className={meta.tone}>{meta.label}</strong>
      </div>
      <div className="review-rule-values">
        <div>
          <span>{rule.direction === "positive" ? "开奖前预测" : "开奖前降权"}</span>
          <strong>{rule.prediction}</strong>
        </div>
        <div>
          <span>该位置实际</span>
          <strong>{String(rule.actualNumber).padStart(2, "0")} · {rule.actualValue}</strong>
        </div>
        <div>
          <span>{rule.direction === "positive" ? "历史命中率" : "历史避开率"}</span>
          <strong>{percent(rule.historicalHitRate)}</strong>
          <small>随机 {percent(rule.baselineSuccessRate)}</small>
        </div>
        <div>
          <span>历史优势</span>
          <strong className={rule.lift >= 0 ? "good" : "bad"}>
            {signedPoints(rule.lift)}
          </strong>
          <small>q={decimal(rule.qValue)} · 样本 {rule.support}</small>
        </div>
      </div>
    </article>
  );
}

function filterCount(
  rules: ResearchRuleReview[],
  value: ReviewFilter,
) {
  if (value === "all") return rules.length;
  if (value === "passed") {
    return rules.filter((rule) => rule.passedHistoricalGate).length;
  }
  return rules.filter((rule) => rule.outcome === value).length;
}

function percent(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function signedPoints(value: number) {
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}个百分点`;
}

function decimal(value: number) {
  return value < 0.001 ? "<0.001" : value.toFixed(3);
}

function dateLabel(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

function dateTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}
