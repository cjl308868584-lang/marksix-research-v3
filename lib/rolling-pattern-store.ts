import type { Draw, GameId } from "./lottery";
import { evaluateRollingEvent } from "./rolling-pattern-events";
import { ensureResearchV3Store } from "./research-v3-store";
import type {
  RollingPatternEnvelope,
  RollingPatternRun,
  RollingPatternScore,
  RollingPatternSignal,
} from "./rolling-pattern-types";
import { ROLLING_PATTERN_ENGINE_VERSION } from "./rolling-pattern-types";

const runtime = globalThis as typeof globalThis & {
  __marksixD1?: D1Database;
};

type RunRow = { run_id: string; run_json: string };
type SignalRow = { signal_json: string };
type ScoreRow = { score_json: string };
const D1_BATCH_SIZE = 80;

export async function ensureRollingPatternStore() {
  return ensureResearchV3Store();
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
      run.status,
      run.generatedAt,
      run.frozenAt,
      JSON.stringify(run),
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
    return status;
  } catch {
    return "unavailable";
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
         FROM research_v3_forecasts
         WHERE game = ?
         ORDER BY expected_draw_at DESC, frozen_at ASC
         LIMIT 1`,
      ).bind(game).first<{ target_issue: string }>();
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
  const verified = draws.filter((draw) => draw.game === game && draw.verified);
  try {
    for (const draw of verified) {
      const rows = await db.prepare(
        `SELECT run_id, run_json FROM rolling_pattern_runs
         WHERE game = ? AND target_issue = ? AND status = 'completed'`,
      ).bind(game, draw.issue).all<RunRow>();
      for (const row of rows.results ?? []) {
        const run = parseJson(row.run_json);
        if (!isRollingPatternRun(run)) continue;
        const statements = run.signals.map((signal) => {
          const actual = evaluateRollingEvent(draw, signal.rule.event);
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
      }
    }
    return "ok";
  } catch {
    return "unavailable";
  }
}

async function runBatches(
  db: D1Database,
  statements: D1PreparedStatement[],
) {
  for (let index = 0; index < statements.length; index += D1_BATCH_SIZE) {
    await db.batch(statements.slice(index, index + D1_BATCH_SIZE));
  }
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

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
