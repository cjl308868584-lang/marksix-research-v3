import type { Draw, GameId } from "./lottery";
import { evaluateRollingResultEvent } from "./rolling-pattern-events";
import {
  applyForwardProductHistory,
  buildRollingPatternProducts,
  buildUnifiedRollingPatternProducts,
  settleRollingPatternProduct,
} from "./rolling-pattern-value";
import {
  buildRollingPatternReviewSnapshot,
  settleRollingPatternReviewSnapshot,
  summarizeRollingPatternReviewSlots,
} from "./rolling-pattern-review.ts";
import { ensurePatternSchema } from "./pattern-schema";
import type {
  RollingPatternEnvelope,
  ProductHistoryCounts,
  RollingPatternProduct,
  RollingPatternProductKind,
  RollingPatternProductScore,
  RollingPatternReviewIndexPage,
  RollingPatternReviewRecord,
  RollingPatternReviewScore,
  RollingPatternReviewSnapshot,
  RollingPatternRun,
  RollingPatternScore,
  RollingPatternSignal,
  RollingPatternScope,
  RollingPatternValueLedgerEntry,
} from "./rolling-pattern-types";
import { ROLLING_PATTERN_ENGINE_VERSION } from "./rolling-pattern-types";

const runtime = globalThis as typeof globalThis & {
  __marksixD1?: D1Database;
};

type RunRow = { run_id: string; run_json: string };
type PendingRunRow = RunRow & {
  target_issue: string;
  needs_product_backfill: number;
};
type SignalRow = { signal_json: string };
type ScoreRow = { score_json: string };
type ProductRow = { product_json: string };
type ProductIdRow = { product_id: string };
type ProductScoreRow = { score_json: string };
type ProductHistoryRow = { product_json: string; score_json: string | null };
type ProductAggregateRow = {
  product_kind: string;
  result_key: string;
  settled_count: number;
  hit_count: number;
};
type ReviewSnapshotRow = {
  run_id: string;
  target_issue: string;
  snapshot_json: string;
  frozen_at: string;
};
type ReviewScoreRow = { score_json: string };
type ReviewArchiveRow = ReviewSnapshotRow & { score_json: string | null };
type ReviewIndexRow = {
  target_issue: string;
  frozen_at: string;
  settled: number;
};
const D1_BATCH_SIZE = 80;
const REVIEW_BACKFILL_LIMIT = 50;
const REQUIRED_REVIEW_PRODUCT_KINDS = new Set<RollingPatternProductKind>([
  "coverage_zodiac",
  "coverage_tail",
  "coverage_zodiac_pair",
  "coverage_zodiac_triple",
  "special_number",
]);

export async function ensureRollingPatternStore() {
  return ensurePatternSchema();
}

export async function persistRollingPatternRun(
  run: RollingPatternRun,
): Promise<"created" | "existing" | "invalid" | "unavailable"> {
  if (!isRollingPatternRun(run)) return "invalid";
  if (!await ensureRollingPatternStore()) return "unavailable";
  const db = runtime.__marksixD1;
  if (!db) return "unavailable";
  try {
    const inserted = await db.prepare(
      `INSERT OR IGNORE INTO rolling_pattern_runs (
         run_id, game, source_issue, target_issue, window_oldest_issue,
         window_newest_issue, window_data_hash, engine_version, status,
         generated_at, frozen_at, run_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      run.runId,
      run.game,
      run.sourceIssue,
      run.targetIssue,
      run.window.oldestIssue,
      run.window.newestIssue,
      run.window.dataHash,
      run.engineVersion,
      "processing",
      run.generatedAt,
      run.frozenAt,
      JSON.stringify({ ...run, signals: [] }),
    ).run();
    const status = Number(inserted.meta?.changes ?? 0) === 0
      ? "existing" as const
      : "created" as const;
    if (run.signals.length) {
      const statements = run.signals.map((signal) =>
        db.prepare(
          `INSERT OR IGNORE INTO rolling_pattern_signals (
             run_id, rule_id, game, target_issue, rule_family,
             event_family, event_value, sample_label, signal_json, frozen_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          run.runId,
          signal.rule.ruleId,
          run.game,
          run.targetIssue,
          signal.rule.family,
          signal.rule.event.family,
          signal.rule.event.value,
          signal.sampleLabel,
          JSON.stringify(signal),
          run.frozenAt,
        )
      );
      await runBatches(db, statements);
    }
    const products = await persistRollingPatternProducts(db, run);
    const reviewProducts = await completeReviewProducts(db, run, products);
    await persistRollingPatternReviewSnapshot(
      db,
      buildRollingPatternReviewSnapshot(run, reviewProducts),
    );
    const completed = await db.prepare(
      `UPDATE rolling_pattern_runs SET status = 'completed'
       WHERE run_id = ? AND engine_version = ? AND window_data_hash = ?`,
    ).bind(run.runId, run.engineVersion, run.window.dataHash).run();
    if (Number(completed.meta?.changes ?? 0) < 1) return "unavailable";
    return status;
  } catch {
    return "unavailable";
  }
}

export async function readRollingPatternValueLedger(
  game: GameId,
  issue?: string | null,
): Promise<{
  products: RollingPatternProduct[];
  scores: RollingPatternProductScore[];
} | null> {
  const envelope = await readRollingPatternRun(game, issue);
  if (!envelope) return null;
  const db = runtime.__marksixD1;
  if (!db) return null;
  try {
    const [productRows, scoreRows] = await Promise.all([
      db.prepare(
        `SELECT product_json FROM rolling_pattern_consensus_ledger
         WHERE run_id = ? ORDER BY rank ASC, rowid ASC`,
      ).bind(envelope.run.runId).all<ProductRow>(),
      db.prepare(
        `SELECT score_json FROM rolling_pattern_consensus_scores
         WHERE run_id = ? ORDER BY rowid ASC`,
      ).bind(envelope.run.runId).all<ProductScoreRow>(),
    ]);
    return {
      products: (productRows.results ?? [])
        .map((row) => parseJson(row.product_json))
        .filter(isRollingPatternProduct),
      scores: (scoreRows.results ?? [])
        .map((row) => parseJson(row.score_json))
        .filter(isRollingPatternProductScore),
    };
  } catch {
    return null;
  }
}

export async function readRollingPatternValueHistory(
  game: GameId,
  scope: RollingPatternScope,
  issueLimit = 8,
): Promise<RollingPatternValueLedgerEntry[]> {
  if (!await ensureRollingPatternStore()) return [];
  const db = runtime.__marksixD1;
  if (!db) return [];
  const bounded = Math.max(1, Math.min(30, Math.trunc(issueLimit)));
  try {
    const rows = await db.prepare(
      `SELECT l.product_json, s.score_json
       FROM rolling_pattern_consensus_ledger l
       LEFT JOIN rolling_pattern_consensus_scores s
         ON s.run_id = l.run_id AND s.product_id = l.product_id
       WHERE l.game = ? AND l.scope = ? AND l.rank <= 15
       ORDER BY l.target_issue DESC, l.rank ASC
       LIMIT ?`,
    ).bind(game, scope, bounded * 15).all<ProductHistoryRow>();
    return (rows.results ?? []).flatMap((row) => {
      const product = parseJson(row.product_json);
      const score = row.score_json ? parseJson(row.score_json) : null;
      return isRollingPatternProduct(product)
        ? [{
            product,
            score: isRollingPatternProductScore(score) ? score : null,
          }]
        : [];
    });
  } catch {
    return [];
  }
}

export async function readRollingPatternReviewIndex(
  game: GameId,
  limit = 20,
  beforeIssue?: string | null,
): Promise<RollingPatternReviewIndexPage> {
  const empty = (): RollingPatternReviewIndexPage => ({
    items: [],
    nextCursor: null,
    slotPerformance: { coverage: [], special: [] },
  });
  if (!await ensureRollingPatternStore()) return empty();
  const db = runtime.__marksixD1;
  if (!db) return empty();
  const bounded = Math.max(1, Math.min(50, Math.trunc(limit)));
  try {
    const beforeSql = beforeIssue
      ? "AND CAST(r.target_issue AS INTEGER) < CAST(? AS INTEGER)"
      : "";
    const statement = db.prepare(
      `SELECT r.target_issue, MIN(r.frozen_at) AS frozen_at,
              MAX(CASE WHEN rs.run_id IS NOT NULL OR EXISTS (
                SELECT 1 FROM lottery_draws d
                WHERE d.game = r.game AND d.issue = r.target_issue
                  AND d.verified = 1
              ) THEN 1 ELSE 0 END) AS settled
       FROM rolling_pattern_runs r
       LEFT JOIN rolling_pattern_review_scores rs ON rs.run_id = r.run_id
       WHERE r.game = ? AND r.engine_version = ? AND r.status = 'completed'
         ${beforeSql}
       GROUP BY r.target_issue
       ORDER BY CAST(r.target_issue AS INTEGER) DESC
       LIMIT ?`,
    );
    const bound = beforeIssue
      ? statement.bind(game, ROLLING_PATTERN_ENGINE_VERSION, beforeIssue, bounded + 1)
      : statement.bind(game, ROLLING_PATTERN_ENGINE_VERSION, bounded + 1);
    const rows = await bound.all<ReviewIndexRow>();
    const valid = (rows.results ?? []).filter((row) =>
      /^\d{4,16}$/.test(row.target_issue) && typeof row.frozen_at === "string"
    );
    const visible = valid.slice(0, bounded);
    const slotPerformance = await readRollingPatternReviewSlotPerformance(db, game);
    return {
      items: visible.map((row) => ({
        targetIssue: row.target_issue,
        frozenAt: row.frozen_at,
        settled: Number(row.settled) === 1,
      })),
      nextCursor: valid.length > bounded
        ? visible.at(-1)?.target_issue ?? null
        : null,
      slotPerformance,
    };
  } catch {
    return empty();
  }
}

async function readRollingPatternReviewSlotPerformance(
  db: D1Database,
  game: GameId,
) {
  const rows = await db.prepare(
    `SELECT review.run_id, review.target_issue, review.snapshot_json,
            review.frozen_at, score.score_json
     FROM rolling_pattern_review_snapshots review
     LEFT JOIN rolling_pattern_review_scores score ON score.run_id = review.run_id
     WHERE review.game = ?
     ORDER BY CAST(review.target_issue AS INTEGER) ASC,
              review.frozen_at ASC, review.run_id ASC`,
  ).bind(game).all<ReviewArchiveRow>();
  const issues = new Set<string>();
  const reviews: RollingPatternReviewRecord[] = [];
  for (const row of rows.results ?? []) {
    if (issues.has(row.target_issue)) continue;
    issues.add(row.target_issue);
    const snapshot = parseJson(row.snapshot_json);
    const score = parseJson(row.score_json ?? "");
    if (!isRollingPatternReviewSnapshot(snapshot) ||
      !isRollingPatternReviewScore(score)) continue;
    reviews.push({ snapshot, score });
  }
  return summarizeRollingPatternReviewSlots(reviews);
}

export async function readRollingPatternReview(
  game: GameId,
  issue: string,
): Promise<RollingPatternReviewRecord | null> {
  if (!await ensureRollingPatternStore()) return null;
  const db = runtime.__marksixD1;
  if (!db) return null;
  try {
    const row = await db.prepare(
      `SELECT run_id, target_issue, snapshot_json, frozen_at
       FROM rolling_pattern_review_snapshots
       WHERE game = ? AND target_issue = ?
       ORDER BY frozen_at ASC, run_id ASC LIMIT 1`,
    ).bind(game, issue).first<ReviewSnapshotRow>();
    const snapshotValue = parseJson(row?.snapshot_json ?? "");
    if (isRollingPatternReviewSnapshot(snapshotValue)) {
      const scoreRow = await db.prepare(
        `SELECT score_json FROM rolling_pattern_review_scores
         WHERE run_id = ? LIMIT 1`,
      ).bind(snapshotValue.runId).first<ReviewScoreRow>();
      const scoreValue = parseJson(scoreRow?.score_json ?? "");
      return {
        snapshot: snapshotValue,
        score: isRollingPatternReviewScore(scoreValue) ? scoreValue : null,
      };
    }
    return reconstructRollingPatternReview(db, game, issue);
  } catch {
    return null;
  }
}

export async function readBoundedLegacyProductHistory(
  game: GameId,
  beforeIssue: string,
): Promise<{
  legacy: Map<string, ProductHistoryCounts>;
  legacyProductIds: Map<string, string>;
} | null> {
  const empty = () => ({
    legacy: new Map<string, ProductHistoryCounts>(),
    legacyProductIds: new Map<string, string>(),
  });
  if (!await ensureRollingPatternStore()) return null;
  const db = runtime.__marksixD1;
  if (!db) return null;
  try {
    const rows = await db.prepare(
      `SELECT l.product_json, s.score_json
       FROM rolling_pattern_consensus_ledger l
       INNER JOIN rolling_pattern_consensus_scores s
         ON s.run_id = l.run_id AND s.product_id = l.product_id
       WHERE l.game = ?
         AND CAST(l.target_issue AS INTEGER) < CAST(? AS INTEGER)
       ORDER BY CAST(l.target_issue AS INTEGER) DESC, l.rowid DESC`,
    ).bind(game, beforeIssue).all<ProductHistoryRow>();
    const result = empty();
    for (const row of rows.results ?? []) {
      const product = parseJson(row.product_json);
      const score = row.score_json ? parseJson(row.score_json) : null;
      if (!isRollingPatternProduct(product) ||
        !isRollingPatternProductScore(score) ||
        product.game !== game ||
        compareIssues(product.targetIssue, beforeIssue) >= 0 ||
        score.runId !== product.runId || score.productId !== product.productId) {
        continue;
      }
      const key = `${product.kind}:${product.values.join("+")}`;
      const previous = result.legacy.get(key) ?? { settledCount: 0, hitCount: 0 };
      result.legacy.set(key, {
        settledCount: previous.settledCount + 1,
        hitCount: previous.hitCount + (score.actualMatched ? 1 : 0),
      });
      if (!result.legacyProductIds.has(key) && product.productId.trim()) {
        result.legacyProductIds.set(key, product.productId);
      }
    }
    return result;
  } catch {
    return null;
  }
}

export async function readRollingPatternRun(
  game: GameId,
  issue?: string | null,
): Promise<RollingPatternEnvelope | null> {
  if (!await ensureRollingPatternStore()) return null;
  const db = runtime.__marksixD1;
  if (!db) return null;
  try {
    let targetIssue = issue ?? null;
    if (!targetIssue) {
      const current = await db.prepare(
        `SELECT target_issue
         FROM rolling_pattern_runs
         WHERE game = ? AND engine_version = ? AND status = 'completed'
         ORDER BY CAST(target_issue AS INTEGER) DESC, frozen_at ASC
         LIMIT 1`,
      ).bind(game, ROLLING_PATTERN_ENGINE_VERSION).first<{ target_issue: string }>();
      targetIssue = current?.target_issue ?? null;
    }
    if (!targetIssue) return null;
    const row = await db.prepare(
      `SELECT run_id, run_json
       FROM rolling_pattern_runs
       WHERE game = ? AND target_issue = ? AND engine_version = ?
         AND status = 'completed'
       ORDER BY frozen_at ASC, run_id ASC
       LIMIT 1`,
    ).bind(game, targetIssue, ROLLING_PATTERN_ENGINE_VERSION).first<RunRow>();
    const run = parseJson(row?.run_json ?? "");
    if (!isRollingPatternRun(run)) return null;
    const [signalRows, scoreRows] = await Promise.all([
      db.prepare(
        `SELECT signal_json FROM rolling_pattern_signals
         WHERE run_id = ? ORDER BY rowid ASC`,
      ).bind(run.runId).all<SignalRow>(),
      db.prepare(
        `SELECT score_json FROM rolling_pattern_scores
         WHERE run_id = ? ORDER BY rowid ASC`,
      ).bind(run.runId).all<ScoreRow>(),
    ]);
    const signals = (signalRows.results ?? [])
      .map((item) => parseJson(item.signal_json))
      .filter(isRollingPatternSignal);
    const scores = (scoreRows.results ?? [])
      .map((item) => parseJson(item.score_json))
      .filter(isRollingPatternScore);
    return { run: { ...run, signals }, signals, scores };
  } catch {
    return null;
  }
}

export async function settleRollingPatternRuns(
  game: GameId,
  draws: Draw[],
  settledAt = new Date().toISOString(),
): Promise<"ok" | "unavailable"> {
  if (!await ensureRollingPatternStore()) return "unavailable";
  const db = runtime.__marksixD1;
  if (!db) return "unavailable";
  const verifiedByIssue = new Map(
    draws
      .filter((draw) => draw.game === game && draw.verified)
      .map((draw) => [draw.issue, draw]),
  );
  try {
    const rows = await db.prepare(
      `SELECT r.run_id, r.target_issue, r.run_json,
              CASE WHEN
                EXISTS (
                  SELECT 1 FROM rolling_pattern_signals bs
                  WHERE bs.run_id = r.run_id
                )
                AND (
                  NOT EXISTS (
                    SELECT 1 FROM rolling_pattern_consensus_ledger bl
                    WHERE bl.run_id = r.run_id
                  )
                  OR EXISTS (
                    SELECT 1 FROM rolling_pattern_consensus_ledger pl
                    WHERE pl.run_id = r.run_id
                      AND NOT EXISTS (
                        SELECT 1 FROM rolling_pattern_consensus_scores ps
                        WHERE ps.run_id = pl.run_id AND ps.product_id = pl.product_id
                      )
                  )
                )
              THEN 1 ELSE 0 END AS needs_product_backfill
       FROM rolling_pattern_runs r
       WHERE r.game = ? AND r.status = 'completed'
         AND (
           EXISTS (
             SELECT 1 FROM rolling_pattern_signals s
             WHERE s.run_id = r.run_id
               AND NOT EXISTS (
                 SELECT 1 FROM rolling_pattern_scores ss
                 WHERE ss.run_id = s.run_id AND ss.rule_id = s.rule_id
               )
           )
           OR EXISTS (
             SELECT 1 FROM rolling_pattern_consensus_ledger l
             WHERE l.run_id = r.run_id
               AND NOT EXISTS (
                 SELECT 1 FROM rolling_pattern_consensus_scores cs
                 WHERE cs.run_id = l.run_id AND cs.product_id = l.product_id
               )
           )
           OR (
             EXISTS (
               SELECT 1 FROM rolling_pattern_signals bs
               WHERE bs.run_id = r.run_id
             )
             AND NOT EXISTS (
               SELECT 1 FROM rolling_pattern_consensus_ledger bl
               WHERE bl.run_id = r.run_id
             )
           )
         )
       ORDER BY CAST(r.target_issue AS INTEGER) ASC, r.frozen_at ASC, r.run_id ASC`,
    ).bind(game).all<PendingRunRow>();
    for (const row of rows.results ?? []) {
      const draw = verifiedByIssue.get(row.target_issue);
      if (!draw) continue;
      const run = parseJson(row.run_json);
      if (!isRollingPatternRun(run) ||
        run.runId !== row.run_id || run.targetIssue !== row.target_issue) {
        continue;
      }
      const needsProductBackfill = Number(row.needs_product_backfill) === 1;
      const [signalRows, frozenSignalRows] = await Promise.all([
        db.prepare(
          `SELECT s.signal_json FROM rolling_pattern_signals s
           LEFT JOIN rolling_pattern_scores ss
             ON ss.run_id = s.run_id AND ss.rule_id = s.rule_id
           WHERE s.run_id = ? AND ss.rule_id IS NULL
           ORDER BY s.rowid ASC`,
        ).bind(run.runId).all<SignalRow>(),
        needsProductBackfill
          ? db.prepare(
            `SELECT signal_json FROM rolling_pattern_signals
             WHERE run_id = ? ORDER BY rowid ASC`,
          ).bind(run.runId).all<SignalRow>()
          : Promise.resolve(null),
      ]);
      if (frozenSignalRows) {
        const frozenSignals = (frozenSignalRows.results ?? [])
          .map((item) => parseJson(item.signal_json))
          .filter(isRollingPatternSignal);
        await persistRollingPatternProducts(db, { ...run, signals: frozenSignals });
      }
      const signals = (signalRows.results ?? [])
        .map((item) => parseJson(item.signal_json))
        .filter(isRollingPatternSignal);
      const statements = signals.map((signal) => {
        const actual = evaluateRollingResultEvent(draw, signal.rule.event);
        const score: RollingPatternScore = {
          runId: run.runId,
          ruleId: signal.rule.ruleId,
          game,
          targetIssue: draw.issue,
          actualMatched: actual.matched,
          actual,
          scoredAt: settledAt,
        };
        return db.prepare(
          `INSERT OR IGNORE INTO rolling_pattern_scores (
             run_id, rule_id, game, target_issue, actual_matched,
             score_json, scored_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          run.runId,
          signal.rule.ruleId,
          game,
          draw.issue,
          actual.matched ? 1 : 0,
          JSON.stringify(score),
          settledAt,
        );
      });
      await runBatches(db, statements);
      const productRows = await db.prepare(
        `SELECT l.product_json FROM rolling_pattern_consensus_ledger l
         LEFT JOIN rolling_pattern_consensus_scores cs
           ON cs.run_id = l.run_id AND cs.product_id = l.product_id
         WHERE l.run_id = ? AND cs.product_id IS NULL
         ORDER BY l.rank ASC, l.rowid ASC`,
      ).bind(run.runId).all<ProductRow>();
      const productStatements = (productRows.results ?? [])
        .map((item) => parseJson(item.product_json))
        .filter(isRollingPatternProduct)
        .map((product) => {
          const score = settleRollingPatternProduct(product, draw, settledAt);
          return db.prepare(
            `INSERT OR IGNORE INTO rolling_pattern_consensus_scores (
               run_id, product_id, game, target_issue, scope, product_kind,
               actual_matched, unit_profit, actual_json, score_json, scored_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            run.runId,
            product.productId,
            game,
            draw.issue,
            product.scope,
            product.kind,
            score.actualMatched ? 1 : 0,
            score.unitProfit,
            JSON.stringify({ numbers: score.actualNumbers, special: score.actualSpecial }),
            JSON.stringify(score),
            settledAt,
          );
        });
      await runBatches(db, productStatements);
    }
    await backfillRollingPatternReviewSnapshots(db, game);
    await settleRollingPatternReviewSnapshots(db, game, verifiedByIssue, settledAt);
    return "ok";
  } catch {
    return "unavailable";
  }
}

async function persistRollingPatternProducts(
  db: D1Database,
  run: RollingPatternRun,
) {
  const [aggregateRows, existingRows] = await Promise.all([
    db.prepare(
      `SELECT l.product_kind, l.result_key,
              COUNT(*) AS settled_count,
              SUM(s.actual_matched) AS hit_count
       FROM rolling_pattern_consensus_ledger l
       INNER JOIN rolling_pattern_consensus_scores s
         ON s.run_id = l.run_id AND s.product_id = l.product_id
       WHERE l.game = ?
       GROUP BY l.product_kind, l.result_key`,
    ).bind(run.game).all<ProductAggregateRow>(),
    db.prepare(
      `SELECT product_id FROM rolling_pattern_consensus_ledger
       WHERE run_id = ?`,
    ).bind(run.runId).all<ProductIdRow>(),
  ]);
  const existingProductIds = new Set(
    (existingRows.results ?? []).map((row) => row.product_id),
  );
  const history = new Map(
    (aggregateRows.results ?? [])
      .filter((row) =>
        typeof row.product_kind === "string" &&
        typeof row.result_key === "string" &&
        Number.isFinite(Number(row.settled_count)) &&
        Number.isFinite(Number(row.hit_count))
      )
      .map((row) => [
        `${row.product_kind}:${row.result_key}`,
        { settled: Number(row.settled_count), hits: Number(row.hit_count) },
      ]),
  );
  const products = buildRollingPatternProducts(run)
    .map((product) => {
      const previous = history.get(`${product.kind}:${product.values.join("+")}`);
      return previous
        ? applyForwardProductHistory(product, previous.settled, previous.hits)
        : product;
    })
    .sort((left, right) =>
      right.expectedValue - left.expectedValue ||
      right.support - left.support ||
      left.label.localeCompare(right.label, "zh-CN")
    )
    .map((product, index) => ({ ...product, rank: index + 1 }));
  const statements = products
    .filter((product) => !existingProductIds.has(product.productId))
    .map((product) =>
      db.prepare(
        `INSERT OR IGNORE INTO rolling_pattern_consensus_ledger (
           run_id, product_id, game, target_issue, scope, product_kind,
           result_key, rank, product_json, frozen_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        run.runId,
        product.productId,
        run.game,
        run.targetIssue,
        product.scope,
        product.kind,
        product.values.join("+"),
        product.rank,
        JSON.stringify(product),
        run.frozenAt,
      )
    );
  await runBatches(db, statements);
  return products;
}

async function completeReviewProducts(
  db: D1Database,
  run: RollingPatternRun,
  products: readonly RollingPatternProduct[],
) {
  const availableKinds = new Set(products.map((product) => product.kind));
  if ([...REQUIRED_REVIEW_PRODUCT_KINDS].every((kind) => availableKinds.has(kind))) {
    return [...products];
  }
  const histories = await readPriorProductHistories(db, run.game, run.targetIssue);
  const universe = buildUnifiedRollingPatternProducts(run, {
    legacy: new Map(),
    learned: histories.legacy,
    legacyProductIds: histories.legacyProductIds,
  });
  return [
    ...products,
    ...universe.filter((product) => !availableKinds.has(product.kind)),
  ];
}

async function readPriorProductHistories(
  db: D1Database,
  game: GameId,
  beforeIssue: string,
) {
  const rows = await db.prepare(
    `SELECT l.product_json, s.score_json
     FROM rolling_pattern_consensus_ledger l
     INNER JOIN rolling_pattern_consensus_scores s
       ON s.run_id = l.run_id AND s.product_id = l.product_id
     WHERE l.game = ?
       AND CAST(l.target_issue AS INTEGER) < CAST(? AS INTEGER)
     ORDER BY CAST(l.target_issue AS INTEGER) DESC, l.rowid DESC`,
  ).bind(game, beforeIssue).all<ProductHistoryRow>();
  const legacy = new Map<string, ProductHistoryCounts>();
  const legacyProductIds = new Map<string, string>();
  for (const row of rows.results ?? []) {
    const product = parseJson(row.product_json);
    const score = parseJson(row.score_json ?? "");
    if (!isRollingPatternProduct(product) || !isRollingPatternProductScore(score) ||
      product.game !== game || compareIssues(product.targetIssue, beforeIssue) >= 0) {
      continue;
    }
    const key = `${product.kind}:${product.values.join("+")}`;
    const current = legacy.get(key) ?? { settledCount: 0, hitCount: 0 };
    legacy.set(key, {
      settledCount: current.settledCount + 1,
      hitCount: current.hitCount + (score.actualMatched ? 1 : 0),
    });
    if (!legacyProductIds.has(key) && product.productId.trim()) {
      legacyProductIds.set(key, product.productId);
    }
  }
  return { legacy, legacyProductIds };
}

async function persistRollingPatternReviewSnapshot(
  db: D1Database,
  snapshot: RollingPatternReviewSnapshot,
) {
  await db.prepare(
    `INSERT OR IGNORE INTO rolling_pattern_review_snapshots (
       run_id, game, target_issue, snapshot_json, frozen_at
     ) VALUES (?, ?, ?, ?, ?)`,
  ).bind(
    snapshot.runId,
    snapshot.game,
    snapshot.targetIssue,
    JSON.stringify(snapshot),
    snapshot.frozenAt,
  ).run();
}

async function backfillRollingPatternReviewSnapshots(
  db: D1Database,
  game: GameId,
) {
  const rows = await db.prepare(
    `SELECT r.run_id, r.run_json
     FROM rolling_pattern_runs r
     LEFT JOIN rolling_pattern_review_snapshots review ON review.run_id = r.run_id
     WHERE r.game = ? AND r.engine_version = ? AND r.status = 'completed'
       AND review.run_id IS NULL
     ORDER BY CAST(r.target_issue AS INTEGER) ASC, r.frozen_at ASC, r.run_id ASC
     LIMIT ?`,
  ).bind(game, ROLLING_PATTERN_ENGINE_VERSION, REVIEW_BACKFILL_LIMIT).all<RunRow>();
  for (const row of rows.results ?? []) {
    const storedRun = parseJson(row.run_json);
    if (!isRollingPatternRun(storedRun) || storedRun.runId !== row.run_id) continue;
    const [signalRows, productRows] = await Promise.all([
      db.prepare(
        `SELECT signal_json FROM rolling_pattern_signals
         WHERE run_id = ? ORDER BY rowid ASC`,
      ).bind(storedRun.runId).all<SignalRow>(),
      db.prepare(
        `SELECT product_json FROM rolling_pattern_consensus_ledger
         WHERE run_id = ? ORDER BY rank ASC, rowid ASC`,
      ).bind(storedRun.runId).all<ProductRow>(),
    ]);
    const signals = (signalRows.results ?? [])
      .map((item) => parseJson(item.signal_json))
      .filter(isRollingPatternSignal);
    const run = { ...storedRun, signals };
    const storedProducts = (productRows.results ?? [])
      .map((item) => parseJson(item.product_json))
      .filter(isRollingPatternProduct);
    const products = storedProducts.length
      ? storedProducts
      : buildRollingPatternProducts(run);
    const reviewProducts = await completeReviewProducts(db, run, products);
    await persistRollingPatternReviewSnapshot(
      db,
      buildRollingPatternReviewSnapshot(run, reviewProducts),
    );
  }
}

async function settleRollingPatternReviewSnapshots(
  db: D1Database,
  game: GameId,
  verifiedByIssue: ReadonlyMap<string, Draw>,
  scoredAt: string,
) {
  const rows = await db.prepare(
    `SELECT review.run_id, review.target_issue, review.snapshot_json,
            review.frozen_at
     FROM rolling_pattern_review_snapshots review
     LEFT JOIN rolling_pattern_review_scores score ON score.run_id = review.run_id
     WHERE review.game = ? AND score.run_id IS NULL
     ORDER BY CAST(review.target_issue AS INTEGER) ASC, review.frozen_at ASC`,
  ).bind(game).all<ReviewSnapshotRow>();
  const statements: D1PreparedStatement[] = [];
  for (const row of rows.results ?? []) {
    const snapshot = parseJson(row.snapshot_json);
    const draw = verifiedByIssue.get(row.target_issue);
    if (!draw || !isRollingPatternReviewSnapshot(snapshot)) continue;
    const score = settleRollingPatternReviewSnapshot(snapshot, draw, scoredAt);
    statements.push(db.prepare(
      `INSERT OR IGNORE INTO rolling_pattern_review_scores (
         run_id, game, target_issue, actual_json, score_json, scored_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      snapshot.runId,
      snapshot.game,
      snapshot.targetIssue,
      JSON.stringify({ numbers: score.actualNumbers, special: score.actualSpecial }),
      JSON.stringify(score),
      score.scoredAt,
    ));
  }
  await runBatches(db, statements);
}

async function reconstructRollingPatternReview(
  db: D1Database,
  game: GameId,
  issue: string,
): Promise<RollingPatternReviewRecord | null> {
  const envelope = await readRollingPatternRun(game, issue);
  if (!envelope) return null;
  const productRows = await db.prepare(
    `SELECT product_json FROM rolling_pattern_consensus_ledger
     WHERE run_id = ? ORDER BY rank ASC, rowid ASC`,
  ).bind(envelope.run.runId).all<ProductRow>();
  const storedProducts = (productRows.results ?? [])
    .map((item) => parseJson(item.product_json))
    .filter(isRollingPatternProduct);
  const baseProducts = storedProducts.length
    ? storedProducts
    : buildRollingPatternProducts({ ...envelope.run, signals: envelope.signals });
  const products = await completeReviewProducts(
    db,
    { ...envelope.run, signals: envelope.signals },
    baseProducts,
  );
  const snapshot = buildRollingPatternReviewSnapshot(
    { ...envelope.run, signals: envelope.signals },
    products,
  );
  const draw = await readVerifiedStoredDraw(db, game, issue);
  if (!draw) return { snapshot, score: null };
  const scored = await db.prepare(
    `SELECT scored_at FROM rolling_pattern_scores
     WHERE run_id = ? ORDER BY scored_at ASC LIMIT 1`,
  ).bind(snapshot.runId).first<{ scored_at: string }>();
  return {
    snapshot,
    score: settleRollingPatternReviewSnapshot(
      snapshot,
      draw,
      scored?.scored_at ?? draw.drawAt,
    ),
  };
}

async function readVerifiedStoredDraw(
  db: D1Database,
  game: GameId,
  issue: string,
): Promise<Draw | null> {
  const row = await db.prepare(
    `SELECT draw_at, main_1, main_2, main_3, main_4, main_5, main_6,
            special, verified
     FROM lottery_draws
     WHERE game = ? AND issue = ? AND verified = 1 LIMIT 1`,
  ).bind(game, issue).first<{
    draw_at: string;
    main_1: number;
    main_2: number;
    main_3: number;
    main_4: number;
    main_5: number;
    main_6: number;
    special: number;
    verified: number;
  }>();
  if (!row) return null;
  return {
    game,
    issue,
    drawAt: row.draw_at,
    numbers: [row.main_1, row.main_2, row.main_3, row.main_4, row.main_5, row.main_6],
    special: row.special,
    source: "stored-verified-draw",
    verified: Number(row.verified) === 1,
  };
}

async function runBatches(
  db: D1Database,
  statements: D1PreparedStatement[],
) {
  for (let index = 0; index < statements.length; index += D1_BATCH_SIZE) {
    await db.batch(statements.slice(index, index + D1_BATCH_SIZE));
  }
}

function compareIssues(left: string, right: string) {
  return left.localeCompare(right, "en", { numeric: true });
}

function isRollingPatternRun(value: unknown): value is RollingPatternRun {
  if (!value || typeof value !== "object") return false;
  const run = value as Partial<RollingPatternRun>;
  const schemaVersion = (value as { schemaVersion?: string }).schemaVersion;
  return (schemaVersion === "rolling-patterns-1" || schemaVersion === "rolling-patterns-2") &&
    (run.game === "hk" || run.game === "new_macau") &&
    typeof run.runId === "string" &&
    typeof run.targetIssue === "string" &&
    run.window?.drawCount === 30 &&
    Array.isArray(run.signals);
}

function isRollingPatternSignal(value: unknown): value is RollingPatternSignal {
  if (!value || typeof value !== "object") return false;
  const signal = value as Partial<RollingPatternSignal>;
  return signal.currentTriggered === true &&
    typeof signal.support === "number" &&
    typeof signal.hits === "number" &&
    typeof signal.rule?.ruleId === "string";
}

function isRollingPatternScore(value: unknown): value is RollingPatternScore {
  if (!value || typeof value !== "object") return false;
  const score = value as Partial<RollingPatternScore>;
  return typeof score.runId === "string" &&
    typeof score.ruleId === "string" &&
    typeof score.actualMatched === "boolean";
}

function isRollingPatternProduct(value: unknown): value is RollingPatternProduct {
  if (!value || typeof value !== "object") return false;
  const product = value as Partial<RollingPatternProduct>;
  return typeof product.productId === "string" &&
    typeof product.targetIssue === "string" &&
    typeof product.estimatedProbability === "number" &&
    typeof product.netOdds === "number";
}

function isRollingPatternProductScore(
  value: unknown,
): value is RollingPatternProductScore {
  if (!value || typeof value !== "object") return false;
  const score = value as Partial<RollingPatternProductScore>;
  return typeof score.productId === "string" &&
    typeof score.actualMatched === "boolean" &&
    typeof score.unitProfit === "number";
}

function isRollingPatternReviewSnapshot(
  value: unknown,
): value is RollingPatternReviewSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<RollingPatternReviewSnapshot>;
  return typeof snapshot.runId === "string" &&
    (snapshot.game === "hk" || snapshot.game === "new_macau") &&
    typeof snapshot.targetIssue === "string" &&
    typeof snapshot.frozenAt === "string" &&
    Array.isArray(snapshot.purchases) && snapshot.purchases.length === 5 &&
    Boolean(snapshot.coverage && Array.isArray(snapshot.coverage.resultGroups)) &&
    Boolean(snapshot.special && Array.isArray(snapshot.special.resultGroups)) &&
    Array.isArray(snapshot.specialNumbers);
}

function isRollingPatternReviewScore(
  value: unknown,
): value is RollingPatternReviewScore {
  if (!value || typeof value !== "object") return false;
  const score = value as Partial<RollingPatternReviewScore>;
  return typeof score.runId === "string" &&
    (score.game === "hk" || score.game === "new_macau") &&
    typeof score.targetIssue === "string" &&
    Array.isArray(score.actualNumbers) &&
    typeof score.actualSpecial === "number" &&
    Array.isArray(score.purchases) && score.purchases.length === 5 &&
    Array.isArray(score.coverageResults) &&
    Array.isArray(score.specialResults) &&
    Array.isArray(score.specialNumbers) &&
    typeof score.scoredAt === "string";
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
