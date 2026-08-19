import type { Draw, GameId } from "./lottery.ts";
import { getZodiac } from "./zodiac.ts";
import { brierLoss, binaryLogLoss } from "./forward-learning-math.ts";
import type { ForwardResultHistory } from "./forward-learning-engine.ts";
import {
  FORWARD_LEARNING_ENGINE_VERSION,
  FORWARD_LEARNING_SLOTS,
  type ForwardLearningCandidate,
  type ForwardLearningForecast,
  type ForwardLearningModelState,
  type ForwardLearningPerformanceWindow,
  type ForwardLearningReview,
  type ForwardLearningRun,
  type ForwardLearningScore,
  type ForwardLearningSlotPerformance,
  type ForwardRuleUpdate,
} from "./forward-learning-types.ts";

const runtime = globalThis as typeof globalThis & {
  __marksixD1?: D1Database;
  __marksixForwardLearningSchemaReady?: Promise<void>;
};

type JsonRow = Record<string, string | number | null>;

export async function ensureForwardLearningStore() {
  const db = runtime.__marksixD1;
  if (!db) return false;
  runtime.__marksixForwardLearningSchemaReady ??= initializeSchema(db).catch((error) => {
    runtime.__marksixForwardLearningSchemaReady = undefined;
    throw error;
  });
  await runtime.__marksixForwardLearningSchemaReady;
  return true;
}

export async function freezeForwardLearningIssue(
  candidates: readonly ForwardLearningCandidate[],
  forecasts: readonly ForwardLearningForecast[],
): Promise<"created" | "existing" | "unavailable" | "invalid"> {
  if (!validFreeze(candidates, forecasts)) return "invalid";
  if (!await ensureForwardLearningStore()) return "unavailable";
  const db = runtime.__marksixD1;
  if (!db) return "unavailable";
  try {
    const candidateStatements = candidates.map((candidate) => db.prepare(
      `INSERT OR IGNORE INTO forward_learning_candidates (
         candidate_id, game, target_issue, slot, result_key, probability,
         baseline_probability, model_version, frozen_at, candidate_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      candidate.candidateId,
      candidate.game,
      candidate.targetIssue,
      candidate.slot,
      candidate.resultKey,
      candidate.finalProbability,
      candidate.baselineProbability,
      candidate.modelVersion,
      candidate.frozenAt,
      JSON.stringify(candidate),
    ));
    const forecastStatements = forecasts.map((forecast) => db.prepare(
      `INSERT OR IGNORE INTO forward_learning_forecasts (
         forecast_id, game, target_issue, slot, result_key, probability,
         baseline_probability, model_version, data_version, frozen_at,
         official, forecast_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      forecast.forecastId,
      forecast.game,
      forecast.targetIssue,
      forecast.slot,
      forecast.resultKey,
      forecast.finalProbability,
      forecast.baselineProbability,
      forecast.modelVersion,
      forecast.dataVersion,
      forecast.frozenAt,
      1,
      JSON.stringify(forecast),
    ));
    const ruleStatements = candidates.flatMap((candidate) =>
      candidate.ruleContributions.map((contribution) => db.prepare(
        `INSERT OR IGNORE INTO forward_learning_rule_snapshots (
           candidate_id, rule_id, cluster_id, game, target_issue,
           snapshot_json, frozen_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        candidate.candidateId,
        contribution.ruleId,
        contribution.clusterId,
        candidate.game,
        candidate.targetIssue,
        JSON.stringify(contribution),
        candidate.frozenAt,
      ))
    );
    await runBatches(db, candidateStatements);
    const results = await runBatches(db, forecastStatements);
    await runBatches(db, ruleStatements);
    return results.some((result) => Number(result.meta?.changes ?? 0) > 0)
      ? "created"
      : "existing";
  } catch {
    return "unavailable";
  }
}

export async function settleForwardLearningIssue(
  game: GameId,
  draw: Draw,
  scoredAt = new Date().toISOString(),
): Promise<{
  status: "settled" | "existing" | "not_found";
  scores: ForwardLearningScore[];
}> {
  if (!draw.verified || draw.game !== game) {
    throw new Error("只能使用同彩种的已核验开奖结果结算");
  }
  if (!await ensureForwardLearningStore()) return { status: "not_found", scores: [] };
  const db = runtime.__marksixD1;
  if (!db) return { status: "not_found", scores: [] };
  const [candidateRows, forecastRows, existingRows] = await Promise.all([
    db.prepare(
      `SELECT candidate_json FROM forward_learning_candidates
       WHERE game = ? AND target_issue = ? ORDER BY slot, result_key`,
    ).bind(game, draw.issue).all<JsonRow>(),
    db.prepare(
      `SELECT forecast_json FROM forward_learning_forecasts
       WHERE game = ? AND target_issue = ? ORDER BY slot`,
    ).bind(game, draw.issue).all<JsonRow>(),
    db.prepare(
      `SELECT score_json FROM forward_learning_scores
       WHERE game = ? AND target_issue = ? ORDER BY slot, result_key`,
    ).bind(game, draw.issue).all<JsonRow>(),
  ]);
  const candidates = rowsAs<ForwardLearningCandidate>(candidateRows.results, "candidate_json");
  const forecasts = rowsAs<ForwardLearningForecast>(forecastRows.results, "forecast_json");
  const existing = rowsAs<ForwardLearningScore>(existingRows.results, "score_json");
  if (!candidates.length || forecasts.length !== FORWARD_LEARNING_SLOTS.length) {
    return { status: "not_found", scores: [] };
  }
  if (existing.length === candidates.length) {
    return { status: "existing", scores: existing };
  }
  if (existing.length > candidates.length) {
    throw new Error("逐期学习评分账本数量异常");
  }
  if ([...candidates, ...forecasts].some((item) =>
    Date.parse(item.frozenAt) >= Date.parse(draw.drawAt)
  )) {
    throw new Error("预测必须在开奖前冻结");
  }
  const officialByCandidate = new Map(forecasts.map((item) => [item.candidateId, item]));
  const scores = candidates.map((candidate) => scoreCandidate(
    candidate,
    officialByCandidate.get(candidate.candidateId) ?? null,
    draw,
    scoredAt,
  ));
  const statements = scores.map((score) => db.prepare(
    `INSERT OR IGNORE INTO forward_learning_scores (
       score_id, forecast_id, candidate_id, game, target_issue, slot,
       result_key, official, actual_matched, probability,
       baseline_probability, brier, baseline_brier, log_loss,
       baseline_log_loss, scored_at, score_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    score.scoreId,
    score.forecastId,
    score.candidateId,
    score.game,
    score.targetIssue,
    score.slot,
    score.resultKey,
    score.official ? 1 : 0,
    score.actualMatched ? 1 : 0,
    score.probability,
    score.baselineProbability,
    score.brier,
    score.baselineBrier,
    score.logLoss,
    score.baselineLogLoss,
    score.scoredAt,
    JSON.stringify(score),
  ));
  await runBatches(db, statements);
  const completedRows = await db.prepare(
    `SELECT score_json FROM forward_learning_scores
     WHERE game = ? AND target_issue = ? ORDER BY slot, result_key`,
  ).bind(game, draw.issue).all<JsonRow>();
  const completedScores = rowsAs<ForwardLearningScore>(completedRows.results, "score_json");
  if (completedScores.length !== candidates.length) {
    throw new Error("逐期学习评分未完整持久化");
  }
  return { status: "settled", scores: completedScores };
}

export async function readForwardLearningForecast(
  game: GameId,
  targetIssue?: string | null,
) {
  if (!await ensureForwardLearningStore()) return [];
  const db = runtime.__marksixD1;
  if (!db) return [];
  let issue = targetIssue ?? null;
  if (!issue) {
    const row = await db.prepare(
      `SELECT target_issue FROM forward_learning_forecasts
       WHERE game = ? ORDER BY target_issue DESC, frozen_at ASC LIMIT 1`,
    ).bind(game).first<{ target_issue: string }>();
    issue = row?.target_issue ?? null;
  }
  if (!issue) return [];
  const rows = await db.prepare(
    `SELECT forecast_json FROM forward_learning_forecasts
     WHERE game = ? AND target_issue = ? ORDER BY slot`,
  ).bind(game, issue).all<JsonRow>();
  const forecasts = rowsAs<ForwardLearningForecast>(rows.results, "forecast_json");
  return FORWARD_LEARNING_SLOTS.flatMap((slot) =>
    forecasts.filter((forecast) => forecast.slot === slot).slice(0, 1)
  );
}

export async function readForwardCandidateHistory(game: GameId) {
  if (!await ensureForwardLearningStore()) return new Map<string, ForwardResultHistory>();
  const db = runtime.__marksixD1;
  if (!db) return new Map<string, ForwardResultHistory>();
  const rows = await db.prepare(
    `SELECT slot, result_key, COUNT(*) settled_count,
            SUM(actual_matched) hit_count, AVG(brier) brier,
            AVG(baseline_brier) baseline_brier
     FROM forward_learning_scores
     WHERE game = ? GROUP BY slot, result_key`,
  ).bind(game).all<JsonRow>();
  return new Map((rows.results ?? []).map((row) => [
    `${row.slot}:${row.result_key}`,
    {
      settledCount: Number(row.settled_count),
      hitCount: Number(row.hit_count),
      brier: Number(row.brier),
      baselineBrier: Number(row.baseline_brier),
    },
  ]));
}

export async function readForwardLearningCandidates(
  game: GameId,
  targetIssue: string,
) {
  if (!await ensureForwardLearningStore()) return [];
  const db = runtime.__marksixD1;
  if (!db) return [];
  const rows = await db.prepare(
    `SELECT candidate_json FROM forward_learning_candidates
     WHERE game = ? AND target_issue = ? ORDER BY slot, result_key`,
  ).bind(game, targetIssue).all<JsonRow>();
  return rowsAs<ForwardLearningCandidate>(rows.results, "candidate_json");
}

export async function readForwardRuleWeights(game: GameId) {
  if (!await ensureForwardLearningStore()) return new Map<string, number>();
  const db = runtime.__marksixD1;
  if (!db) return new Map<string, number>();
  const rows = await db.prepare(
    `SELECT update_json FROM forward_learning_rule_updates
     WHERE game = ? ORDER BY generated_at DESC, rowid DESC`,
  ).bind(game).all<JsonRow>();
  const updates = rowsAs<ForwardRuleUpdate>(rows.results, "update_json");
  const weights = new Map<string, number>();
  for (const update of updates) {
    const key = `${update.slot}:${update.ruleId}`;
    if (!weights.has(key)) weights.set(key, update.afterWeight);
  }
  return weights;
}

export async function persistForwardLearningModelStates(
  states: readonly ForwardLearningModelState[],
) {
  if (!await ensureForwardLearningStore()) return "unavailable" as const;
  const db = runtime.__marksixD1;
  if (!db) return "unavailable" as const;
  const statements = states.map((state) => db.prepare(
    `INSERT OR IGNORE INTO forward_learning_model_states (
       state_id, game, slot, version, learned_through_issue,
       state_json, generated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    state.stateId,
    state.game,
    state.slot,
    state.version,
    state.learnedThroughIssue,
    JSON.stringify(state),
    state.generatedAt,
  ));
  await runBatches(db, statements);
  return "ok" as const;
}

export async function readForwardLearningModel(game: GameId) {
  if (!await ensureForwardLearningStore()) return [];
  const db = runtime.__marksixD1;
  if (!db) return [];
  const rows = await db.prepare(
    `SELECT state_json FROM forward_learning_model_states
     WHERE game = ? ORDER BY generated_at DESC, rowid DESC`,
  ).bind(game).all<JsonRow>();
  const parsed = rowsAs<ForwardLearningModelState>(rows.results, "state_json");
  return FORWARD_LEARNING_SLOTS.flatMap((slot) =>
    parsed.filter((state) => state.slot === slot).slice(0, 1)
  );
}

export async function persistForwardRuleUpdates(updates: readonly ForwardRuleUpdate[]) {
  if (!await ensureForwardLearningStore()) return "unavailable" as const;
  const db = runtime.__marksixD1;
  if (!db) return "unavailable" as const;
  await runBatches(db, updates.map((update) => db.prepare(
    `INSERT OR IGNORE INTO forward_learning_rule_updates (
       run_id, slot, rule_id, game, settled_issue, update_json, generated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    update.runId,
    update.slot,
    update.ruleId,
    update.game,
    update.settledIssue,
    JSON.stringify(update),
    new Date().toISOString(),
  )));
  return "ok" as const;
}

export async function readForwardLearningPerformance(game: GameId) {
  if (!await ensureForwardLearningStore()) return [];
  const db = runtime.__marksixD1;
  if (!db) return [];
  const rows = await db.prepare(
    `SELECT score_json FROM forward_learning_scores
     WHERE game = ? AND official = 1 ORDER BY target_issue DESC, slot`,
  ).bind(game).all<JsonRow>();
  const scores = rowsAs<ForwardLearningScore>(rows.results, "score_json");
  return FORWARD_LEARNING_SLOTS.map((slot) => {
    const slotScores = scores.filter((score) => score.slot === slot);
    return {
      slot,
      windows: [
        performanceWindow("recent10", slotScores.slice(0, 10)),
        performanceWindow("recent30", slotScores.slice(0, 30)),
        performanceWindow("all", slotScores),
      ],
    } satisfies ForwardLearningSlotPerformance;
  });
}

export async function readForwardLearningReviews(
  game: GameId,
  limit = 50,
): Promise<ForwardLearningReview[]> {
  if (!await ensureForwardLearningStore()) return [];
  const db = runtime.__marksixD1;
  if (!db) return [];
  const bounded = Math.max(1, Math.min(100, Math.trunc(limit)));
  const runRows = await db.prepare(
    `SELECT run_json FROM forward_learning_runs
     WHERE game = ? AND status = 'completed'
     ORDER BY completed_at DESC LIMIT ?`,
  ).bind(game, bounded).all<JsonRow>();
  const runs = rowsAs<ForwardLearningRun>(runRows.results, "run_json");
  const scoreRows = await db.prepare(
    `SELECT score_json FROM forward_learning_scores
     WHERE game = ? AND official = 1 ORDER BY target_issue DESC, slot`,
  ).bind(game).all<JsonRow>();
  const scores = rowsAs<ForwardLearningScore>(scoreRows.results, "score_json");
  const modelRows = await db.prepare(
    `SELECT state_json FROM forward_learning_model_states
     WHERE game = ? ORDER BY generated_at DESC, rowid DESC`,
  ).bind(game).all<JsonRow>();
  const models = rowsAs<ForwardLearningModelState>(modelRows.results, "state_json");
  const updateRows = await db.prepare(
    `SELECT update_json FROM forward_learning_rule_updates
     WHERE game = ? ORDER BY generated_at DESC, rowid DESC`,
  ).bind(game).all<JsonRow>();
  const updates = rowsAs<ForwardRuleUpdate>(updateRows.results, "update_json");
  return runs.map((run) => ({
    run,
    scores: scores.filter((score) => score.targetIssue === run.settledIssue),
    modelBefore: run.modelVersionBefore
      ? models.filter((state) => state.version === run.modelVersionBefore)
      : [],
    modelAfter: run.modelVersionAfter
      ? models.filter((state) => state.version === run.modelVersionAfter)
      : [],
    ruleUpdates: updates.filter((update) => update.runId === run.runId),
  }));
}

export async function claimForwardLearningRun(run: ForwardLearningRun) {
  if (!await ensureForwardLearningStore()) return "unavailable" as const;
  const db = runtime.__marksixD1;
  if (!db) return "unavailable" as const;
  const result = await db.prepare(
    `INSERT OR IGNORE INTO forward_learning_runs (
       run_id, task_id, game, settled_issue, target_issue, engine_version,
       status, run_json, started_at, completed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    run.runId,
    run.taskId,
    run.game,
    run.settledIssue,
    run.targetIssue,
    run.engineVersion,
    run.status,
    JSON.stringify(run),
    run.startedAt,
    run.completedAt,
  ).run();
  return Number(result.meta?.changes ?? 0) > 0 ? "claimed" as const : "existing" as const;
}

export async function completeForwardLearningRun(run: ForwardLearningRun) {
  const db = runtime.__marksixD1;
  if (!db) return false;
  const completed = { ...run, status: "completed" as const };
  const result = await db.prepare(
    `UPDATE forward_learning_runs SET status = 'completed', run_json = ?, completed_at = ?
     WHERE run_id = ? AND status = 'processing'`,
  ).bind(JSON.stringify(completed), completed.completedAt, completed.runId).run();
  return Number(result.meta?.changes ?? 0) > 0;
}

export async function readForwardLearningRun(
  game: GameId,
  settledIssue: string | null,
) {
  if (!await ensureForwardLearningStore()) return null;
  const db = runtime.__marksixD1;
  if (!db) return null;
  const row = await db.prepare(
    `SELECT run_json FROM forward_learning_runs
     WHERE game = ? AND settled_issue IS ? AND engine_version = ?
     ORDER BY started_at ASC LIMIT 1`,
  ).bind(game, settledIssue, FORWARD_LEARNING_ENGINE_VERSION).first<JsonRow>();
  return parseJson<ForwardLearningRun>(row?.run_json);
}

function scoreCandidate(
  candidate: ForwardLearningCandidate,
  forecast: ForwardLearningForecast | null,
  draw: Draw,
  scoredAt: string,
): ForwardLearningScore {
  const matched = candidateMatched(candidate, draw);
  return {
    scoreId: `score:${candidate.candidateId}`,
    forecastId: forecast?.forecastId ?? null,
    candidateId: candidate.candidateId,
    game: candidate.game,
    targetIssue: candidate.targetIssue,
    slot: candidate.slot,
    resultKey: candidate.resultKey,
    official: Boolean(forecast),
    actualMatched: matched,
    probability: candidate.finalProbability,
    baselineProbability: candidate.baselineProbability,
    brier: brierLoss(candidate.finalProbability, matched),
    baselineBrier: brierLoss(candidate.baselineProbability, matched),
    logLoss: binaryLogLoss(candidate.finalProbability, matched),
    baselineLogLoss: binaryLogLoss(candidate.baselineProbability, matched),
    actualNumbers: [...draw.numbers, draw.special],
    actualSpecial: draw.special,
    scoredAt,
  };
}

function candidateMatched(candidate: ForwardLearningCandidate, draw: Draw) {
  if (candidate.slot === "special_number") {
    return draw.special === Number(candidate.values[0]);
  }
  const numbers = [...draw.numbers, draw.special];
  if (candidate.slot === "coverage_tail") {
    return candidate.values.every((value) =>
      numbers.some((number) => `${number % 10}尾` === value)
    );
  }
  const zodiacs = new Set(numbers.map((number) => getZodiac(number, draw.drawAt)));
  return candidate.values.every((value) => zodiacs.has(value as never));
}

function validFreeze(
  candidates: readonly ForwardLearningCandidate[],
  forecasts: readonly ForwardLearningForecast[],
) {
  if (!candidates.length || forecasts.length !== FORWARD_LEARNING_SLOTS.length) return false;
  const identity = candidates[0];
  if (!identity) return false;
  if ([...candidates, ...forecasts].some((item) =>
    item.game !== identity.game ||
    item.targetIssue !== identity.targetIssue ||
    !Number.isFinite(Date.parse(item.frozenAt))
  )) return false;
  return FORWARD_LEARNING_SLOTS.every((slot) =>
    forecasts.filter((forecast) => forecast.slot === slot).length === 1
  );
}

function performanceWindow(
  window: ForwardLearningPerformanceWindow["window"],
  scores: readonly ForwardLearningScore[],
): ForwardLearningPerformanceWindow {
  const settledCount = scores.length;
  const sum = (read: (score: ForwardLearningScore) => number) =>
    scores.reduce((total, score) => total + read(score), 0);
  const hitCount = scores.filter((score) => score.actualMatched).length;
  const brier = settledCount ? sum((score) => score.brier) / settledCount : 0;
  const baselineBrier = settledCount
    ? sum((score) => score.baselineBrier) / settledCount
    : 0;
  const logLoss = settledCount ? sum((score) => score.logLoss) / settledCount : 0;
  const baselineLogLoss = settledCount
    ? sum((score) => score.baselineLogLoss) / settledCount
    : 0;
  return {
    window,
    settledCount,
    hitCount,
    missCount: settledCount - hitCount,
    hitRate: settledCount ? hitCount / settledCount : 0,
    meanBaseline: settledCount
      ? sum((score) => score.baselineProbability) / settledCount
      : 0,
    brier,
    baselineBrier,
    brierSkill: baselineBrier > 0 ? 1 - brier / baselineBrier : 0,
    logLoss,
    baselineLogLoss,
    logLossSkill: baselineLogLoss > 0 ? 1 - logLoss / baselineLogLoss : 0,
  };
}

async function initializeSchema(db: D1Database) {
  for (const statement of FORWARD_LEARNING_SCHEMA.split(";").map((item) => item.trim()).filter(Boolean)) {
    await db.prepare(statement).run();
  }
}

async function runBatches(db: D1Database, statements: D1PreparedStatement[]) {
  const results: D1Result[] = [];
  for (let index = 0; index < statements.length; index += 90) {
    results.push(...await db.batch(statements.slice(index, index + 90)));
  }
  return results;
}

function rowsAs<T>(rows: JsonRow[] | undefined, key: string) {
  return (rows ?? []).flatMap((row) => {
    const parsed = parseJson<T>(row[key]);
    return parsed ? [parsed] : [];
  });
}

function parseJson<T>(value: unknown): T | null {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

const FORWARD_LEARNING_SCHEMA = `
CREATE TABLE IF NOT EXISTS forward_learning_forecasts (forecast_id text PRIMARY KEY, game text NOT NULL, target_issue text NOT NULL, slot text NOT NULL, result_key text NOT NULL, probability real NOT NULL, baseline_probability real NOT NULL, model_version text NOT NULL, data_version text NOT NULL, frozen_at text NOT NULL, official integer NOT NULL, forecast_json text NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS forward_learning_forecast_slot_idx ON forward_learning_forecasts (game, target_issue, slot);
CREATE TABLE IF NOT EXISTS forward_learning_candidates (candidate_id text PRIMARY KEY, game text NOT NULL, target_issue text NOT NULL, slot text NOT NULL, result_key text NOT NULL, probability real NOT NULL, baseline_probability real NOT NULL, model_version text NOT NULL, frozen_at text NOT NULL, candidate_json text NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS forward_learning_candidate_issue_idx ON forward_learning_candidates (game, target_issue, candidate_id);
CREATE TABLE IF NOT EXISTS forward_learning_scores (score_id text PRIMARY KEY, forecast_id text, candidate_id text NOT NULL, game text NOT NULL, target_issue text NOT NULL, slot text NOT NULL, result_key text NOT NULL, official integer NOT NULL, actual_matched integer NOT NULL, probability real NOT NULL, baseline_probability real NOT NULL, brier real NOT NULL, baseline_brier real NOT NULL, log_loss real NOT NULL, baseline_log_loss real NOT NULL, scored_at text NOT NULL, score_json text NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS forward_learning_score_candidate_idx ON forward_learning_scores (candidate_id);
CREATE UNIQUE INDEX IF NOT EXISTS forward_learning_score_forecast_idx ON forward_learning_scores (forecast_id) WHERE forecast_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS forward_learning_rule_snapshots (candidate_id text NOT NULL, rule_id text NOT NULL, cluster_id text NOT NULL, game text NOT NULL, target_issue text NOT NULL, snapshot_json text NOT NULL, frozen_at text NOT NULL, PRIMARY KEY (candidate_id, rule_id));
CREATE TABLE IF NOT EXISTS forward_learning_rule_updates (run_id text NOT NULL, slot text NOT NULL, rule_id text NOT NULL, game text NOT NULL, settled_issue text NOT NULL, update_json text NOT NULL, generated_at text NOT NULL, PRIMARY KEY (run_id, slot, rule_id));
CREATE TABLE IF NOT EXISTS forward_learning_model_states (state_id text PRIMARY KEY, game text NOT NULL, slot text NOT NULL, version text NOT NULL, learned_through_issue text, state_json text NOT NULL, generated_at text NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS forward_learning_model_version_idx ON forward_learning_model_states (game, slot, version);
CREATE TABLE IF NOT EXISTS forward_learning_runs (run_id text PRIMARY KEY, task_id text NOT NULL, game text NOT NULL, settled_issue text, target_issue text NOT NULL, engine_version text NOT NULL, status text NOT NULL, run_json text NOT NULL, started_at text NOT NULL, completed_at text);
CREATE UNIQUE INDEX IF NOT EXISTS forward_learning_run_issue_idx ON forward_learning_runs (game, settled_issue, engine_version) WHERE settled_issue IS NOT NULL;
`;
