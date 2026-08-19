import type { Draw, GameId } from "./lottery.ts";
import { getZodiac } from "./zodiac.ts";
import { binaryLogLoss, brierLoss } from "./forward-learning-math.ts";
import type { ForwardResultHistory } from "./forward-learning-engine.ts";
import type {
  AuthoritativeRecommendation,
  RollingPatternProduct,
} from "./rolling-pattern-types.ts";
import {
  FORWARD_LEARNING_SLOTS,
  type ForwardLearningCandidate,
  type ForwardLearningCandidateV2,
  type ForwardLearningForecast,
  type ForwardLearningForecastV2,
  type ForwardLearningRevision,
  type ForwardLearningRevisionSnapshot,
  type ForwardLearningRollout,
  type ForwardLearningScore,
  type ForwardLearningScoreV2,
  type ForwardLearningSlot,
  type ResolvedForwardSnapshot,
  type ResolvedSettlement,
} from "./forward-learning-types.ts";

const runtime = globalThis as typeof globalThis & {
  __marksixD1?: D1Database;
  __marksixForwardLearningV2SchemaReady?: Promise<void>;
};

type JsonRow = Record<string, string | number | null>;

export type ResolvedProductRecommendations = {
  game: GameId;
  targetIssue: string;
  revision: number;
  revisionId: string;
  recommendations: AuthoritativeRecommendation[];
  forecasts: ForwardLearningForecastV2[];
};

export class ForwardLearningDataIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForwardLearningDataIntegrityError";
  }
}

export async function ensureForwardLearningV2Store(): Promise<void> {
  const db = runtime.__marksixD1;
  if (!db) return;
  runtime.__marksixForwardLearningV2SchemaReady ??= initializeSchema(db).catch((error) => {
    runtime.__marksixForwardLearningV2SchemaReady = undefined;
    throw error;
  });
  await runtime.__marksixForwardLearningV2SchemaReady;
}

export async function persistForwardLearningRollout(
  rollout: ForwardLearningRollout,
): Promise<"created" | "existing" | "conflict"> {
  await ensureForwardLearningV2Store();
  const db = runtime.__marksixD1;
  if (!db) throw new Error("新版逐期学习数据库不可用");
  const rolloutJson = canonicalRolloutJson(rollout);
  const result = await db.prepare(
    `INSERT OR IGNORE INTO forward_learning_rollouts (
       game, first_unified_target_issue, legacy_seed_through_issue,
       seed_query_version, rollout_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(
    rollout.game,
    rollout.firstUnifiedTargetIssue,
    rollout.legacySeedThroughIssue,
    rollout.seedQueryVersion,
    rolloutJson,
    rollout.createdAt,
  ).run();
  if (Number(result.meta?.changes ?? 0) > 0) return "created";
  const stored = await db.prepare(
    `SELECT rollout_json FROM forward_learning_rollouts WHERE game = ? LIMIT 1`,
  ).bind(rollout.game).first<{ rollout_json: string }>();
  return stored?.rollout_json === rolloutJson ? "existing" : "conflict";
}

export async function readForwardLearningRollout(
  game: GameId,
): Promise<ForwardLearningRollout | null> {
  await ensureForwardLearningV2Store();
  const db = runtime.__marksixD1;
  if (!db) return null;
  const row = await db.prepare(
    `SELECT rollout_json FROM forward_learning_rollouts WHERE game = ? LIMIT 1`,
  ).bind(game).first<{ rollout_json: string }>();
  const rollout = parseJson<ForwardLearningRollout>(row?.rollout_json);
  return rollout && canonicalRolloutJson(rollout) === row?.rollout_json
    ? rollout
    : null;
}

export async function readForwardLearningScoreCount(
  game: GameId,
  targetIssue: string,
): Promise<number> {
  await ensureForwardLearningV2Store();
  const db = runtime.__marksixD1;
  if (!db) return 0;
  const [v1, v2] = await Promise.all([
    db.prepare(
      `SELECT COUNT(*) AS score_count FROM forward_learning_scores
       WHERE game = ? AND target_issue = ?`,
    ).bind(game, targetIssue).first<{ score_count: number }>(),
    db.prepare(
      `SELECT COUNT(*) AS score_count FROM forward_learning_revision_scores
       WHERE game = ? AND target_issue = ?`,
    ).bind(game, targetIssue).first<{ score_count: number }>(),
  ]);
  return Number(v1?.score_count ?? 0) + Number(v2?.score_count ?? 0);
}

export async function freezeForwardLearningRevision(
  snapshot: ForwardLearningRevisionSnapshot,
): Promise<"created" | "existing" | "conflict" | "unavailable"> {
  if (!validRevisionSnapshot(snapshot)) return "conflict";
  try {
    await ensureForwardLearningV2Store();
    const db = runtime.__marksixD1;
    if (!db) return "unavailable";
    let stored = await readRevisionIdentity(db, snapshot);
    if (stored?.status === "committed") {
      return stored.content_hash === snapshot.contentHash ? "existing" : "conflict";
    }
    if (stored && (
      stored.revision_id !== snapshot.revisionId ||
      stored.content_hash !== snapshot.contentHash
    )) return "conflict";

    const processing = revisionManifest(snapshot, "processing", null);
    if (!stored) {
      await db.prepare(
        `INSERT OR IGNORE INTO forward_learning_revisions (
           revision_id, game, target_issue, revision, status, content_hash,
           revision_json, created_at, committed_at
         ) VALUES (?, ?, ?, ?, 'processing', ?, ?, ?, NULL)`,
      ).bind(
        snapshot.revisionId,
        snapshot.game,
        snapshot.targetIssue,
        snapshot.revision,
        snapshot.contentHash,
        JSON.stringify(processing),
        snapshot.createdAt,
      ).run();
      stored = await readRevisionIdentity(db, snapshot);
      if (!stored || stored.status !== "processing" ||
        stored.revision_id !== snapshot.revisionId ||
        stored.content_hash !== snapshot.contentHash) return "conflict";
    }

    await runBatches(db, snapshot.candidates.map((candidate) => db.prepare(
      `INSERT OR IGNORE INTO forward_learning_revision_candidates (
         candidate_id, revision_id, game, target_issue, revision, slot,
         result_key, candidate_json, frozen_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      candidate.candidateId,
      snapshot.revisionId,
      snapshot.game,
      snapshot.targetIssue,
      snapshot.revision,
      candidate.slot,
      candidate.resultKey,
      JSON.stringify(candidate),
      candidate.frozenAt,
    )));
    await runBatches(db, snapshot.forecasts.map((forecast) => db.prepare(
      `INSERT OR IGNORE INTO forward_learning_revision_forecasts (
         forecast_id, candidate_id, revision_id, game, target_issue,
         revision, slot, result_key, forecast_json, frozen_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      forecast.forecastId,
      forecast.candidateId,
      snapshot.revisionId,
      snapshot.game,
      snapshot.targetIssue,
      snapshot.revision,
      forecast.slot,
      forecast.resultKey,
      JSON.stringify(forecast),
      forecast.frozenAt,
    )));

    const [candidateRows, forecastRows] = await Promise.all([
      db.prepare(
        `SELECT candidate_id, candidate_json
         FROM forward_learning_revision_candidates
         WHERE revision_id = ? ORDER BY slot, result_key`,
      ).bind(snapshot.revisionId).all<JsonRow>(),
      db.prepare(
        `SELECT forecast_id, forecast_json
         FROM forward_learning_revision_forecasts
         WHERE revision_id = ? ORDER BY slot`,
      ).bind(snapshot.revisionId).all<JsonRow>(),
    ]);
    if (!sameFrozenRows(
      candidateRows.results,
      "candidate_id",
      "candidate_json",
      snapshot.candidates.map((item) => [item.candidateId, JSON.stringify(item)]),
    ) || !sameFrozenRows(
      forecastRows.results,
      "forecast_id",
      "forecast_json",
      snapshot.forecasts.map((item) => [item.forecastId, JSON.stringify(item)]),
    )) return "conflict";

    const committedAt = snapshot.committedAt ?? snapshot.createdAt;
    const committed = revisionManifest(snapshot, "committed", committedAt);
    const update = await db.prepare(
      `UPDATE forward_learning_revisions
       SET status = 'committed', revision_json = ?, committed_at = ?
       WHERE revision_id = ? AND status = 'processing' AND content_hash = ?`,
    ).bind(
      JSON.stringify(committed),
      committedAt,
      snapshot.revisionId,
      snapshot.contentHash,
    ).run();
    if (Number(update.meta?.changes ?? 0) > 0) return "created";
    const final = await readRevisionIdentity(db, snapshot);
    if (final?.status === "committed") {
      return final.content_hash === snapshot.contentHash ? "existing" : "conflict";
    }
    return "unavailable";
  } catch {
    return "unavailable";
  }
}

export async function readResolvedForwardSnapshot(
  game: GameId,
  issue?: string | null,
): Promise<ResolvedForwardSnapshot | null> {
  await ensureForwardLearningV2Store();
  const db = runtime.__marksixD1;
  if (!db) return null;
  const targetIssue = issue ?? await latestTargetIssue(db, game);
  if (!targetIssue) return null;
  const revisionRow = await db.prepare(
    `SELECT revision_id, revision_json FROM forward_learning_revisions
     WHERE game = ? AND target_issue = ? AND status = 'committed'
     ORDER BY revision DESC LIMIT 1`,
  ).bind(game, targetIssue).first<JsonRow>();
  if (revisionRow) {
    const revision = parseJson<ForwardLearningRevision>(revisionRow.revision_json);
    if (!revision) return null;
    const [candidateRows, forecastRows] = await Promise.all([
      db.prepare(
        `SELECT candidate_json FROM forward_learning_revision_candidates
         WHERE revision_id = ? ORDER BY slot, result_key`,
      ).bind(revision.revisionId).all<JsonRow>(),
      db.prepare(
        `SELECT forecast_json FROM forward_learning_revision_forecasts
         WHERE revision_id = ? ORDER BY slot`,
      ).bind(revision.revisionId).all<JsonRow>(),
    ]);
    const candidates = rowsAs<ForwardLearningCandidateV2>(
      candidateRows.results,
      "candidate_json",
    );
    const forecasts = rowsAs<ForwardLearningForecastV2>(forecastRows.results, "forecast_json");
    if (candidates.length !== 357 || forecasts.length !== FORWARD_LEARNING_SLOTS.length) {
      return null;
    }
    return {
      source: "v2",
      revision: revision.revision,
      revisionId: revision.revisionId,
      game,
      targetIssue,
      candidates,
      forecasts,
    };
  }
  const [candidateRows, forecastRows] = await Promise.all([
    db.prepare(
      `SELECT candidate_json FROM forward_learning_candidates
       WHERE game = ? AND target_issue = ? ORDER BY slot, result_key`,
    ).bind(game, targetIssue).all<JsonRow>(),
    db.prepare(
      `SELECT forecast_json FROM forward_learning_forecasts
       WHERE game = ? AND target_issue = ? ORDER BY slot`,
    ).bind(game, targetIssue).all<JsonRow>(),
  ]);
  const candidates = rowsAs<ForwardLearningCandidate>(candidateRows.results, "candidate_json");
  const forecasts = rowsAs<ForwardLearningForecast>(forecastRows.results, "forecast_json");
  if (!candidates.length || forecasts.length !== FORWARD_LEARNING_SLOTS.length) return null;
  return {
    source: "v1",
    revision: 1,
    revisionId: null,
    game,
    targetIssue,
    candidates,
    forecasts,
  };
}

export async function readResolvedProductRecommendations(
  game: GameId,
  issue?: string | null,
): Promise<ResolvedProductRecommendations | null> {
  await ensureForwardLearningV2Store();
  const db = runtime.__marksixD1;
  if (!db) return null;
  const targetIssue = issue ?? await latestV2TargetIssue(db, game);
  if (!targetIssue) return null;
  const row = await db.prepare(
    `SELECT revision_id, game, target_issue, revision, status, revision_json
     FROM forward_learning_revisions
     WHERE game = ? AND target_issue = ? AND status = 'committed'
     ORDER BY revision DESC LIMIT 1`,
  ).bind(game, targetIssue).first<JsonRow>();
  if (!row) return null;
  const revision = validatedCommittedRevision(row, game, targetIssue);
  const forecastRows = await db.prepare(
    `SELECT forecast_json FROM forward_learning_revision_forecasts
     WHERE revision_id = ? ORDER BY slot`,
  ).bind(revision.revisionId).all<JsonRow>();
  const forecasts = rowsAs<ForwardLearningForecastV2>(forecastRows.results, "forecast_json")
    .sort((left, right) => slotOrder(left.slot) - slotOrder(right.slot));
  assertResolvedForecasts(forecasts, revision);
  return {
    game,
    targetIssue,
    revision: revision.revision,
    revisionId: revision.revisionId,
    forecasts,
    recommendations: forecasts.map(forecastToRecommendation),
  };
}

export async function settleResolvedForwardSnapshot(
  game: GameId,
  draw: Draw,
  scoredAt: string,
): Promise<ResolvedSettlement> {
  if (!draw.verified || draw.game !== game) {
    throw new Error("只能使用同彩种的已核验开奖结果结算");
  }
  const resolved = await readResolvedForwardSnapshot(game, draw.issue);
  if (!resolved) return { status: "not_found", source: null, revision: null, scores: [] };
  if ([...resolved.candidates, ...resolved.forecasts].some((item) => {
    const frozenAt = Date.parse(item.frozenAt);
    return !Number.isFinite(frozenAt) || frozenAt >= Date.parse(draw.drawAt);
  })) {
    throw new Error("预测必须在开奖前冻结");
  }
  if (resolved.source === "v1") return settleV1Snapshot(resolved, draw, scoredAt);
  const db = runtime.__marksixD1;
  if (!db || !resolved.revisionId) {
    return { status: "not_found", source: null, revision: null, scores: [] };
  }
  const forecasts = resolved.forecasts as ForwardLearningForecastV2[];
  const officialByCandidate = new Map(forecasts.map((item) => [item.candidateId, item]));
  const scores = (resolved.candidates as ForwardLearningCandidateV2[]).map((candidate) =>
    scoreV2Candidate(candidate, officialByCandidate.get(candidate.candidateId) ?? null, draw, scoredAt)
  );
  assertCompleteV2ScoreSet(scores);
  const expectedByCandidate = new Map(scores.map((score) => [score.candidateId, score]));
  const existingRows = await db.prepare(
    `SELECT score_id, forecast_id, candidate_id, revision_id, game,
            target_issue, revision, slot, result_key, official,
            actual_matched, score_json, scored_at
     FROM forward_learning_revision_scores
     WHERE revision_id = ? ORDER BY slot, result_key`,
  ).bind(resolved.revisionId).all<JsonRow>();
  const existing = validateStoredV2Scores(existingRows.results, expectedByCandidate);
  if (existing.length === scores.length) {
    assertCompleteV2ScoreSet(existing);
    return {
      status: "existing",
      source: "v2",
      revision: resolved.revision,
      scores: existing,
    };
  }
  const existingIds = new Set(existing.map((score) => score.candidateId));
  const missing = scores.filter((score) => !existingIds.has(score.candidateId));
  await runBatches(db, missing.map((score) => db.prepare(
    `INSERT OR IGNORE INTO forward_learning_revision_scores (
       score_id, forecast_id, candidate_id, revision_id, game, target_issue,
       revision, slot, result_key, official, actual_matched, score_json, scored_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    score.scoreId,
    score.forecastId,
    score.candidateId,
    score.revisionId,
    score.game,
    score.targetIssue,
    score.revision,
    score.slot,
    score.resultKey,
    score.official ? 1 : 0,
    score.actualMatched ? 1 : 0,
    JSON.stringify(score),
    score.scoredAt,
  )));
  const completedRows = await db.prepare(
    `SELECT score_id, forecast_id, candidate_id, revision_id, game,
            target_issue, revision, slot, result_key, official,
            actual_matched, score_json, scored_at
     FROM forward_learning_revision_scores
     WHERE revision_id = ? ORDER BY slot, result_key`,
  ).bind(resolved.revisionId).all<JsonRow>();
  const completed = validateStoredV2Scores(completedRows.results, expectedByCandidate);
  assertCompleteV2ScoreSet(completed);
  return {
    status: existing.length > 0 ? "repaired" : "settled",
    source: "v2",
    revision: resolved.revision,
    scores: completed,
  };
}

export async function readUnifiedCandidateHistory(
  game: GameId,
  beforeIssue: string,
): Promise<Map<string, ForwardResultHistory>> {
  const scores = await readValidatedHighestCommittedScores(game, {
    beforeIssue,
    requireCompleteCandidateSet: true,
  });
  const aggregates = new Map<string, {
    settledCount: number;
    hitCount: number;
    brier: number;
    baselineBrier: number;
  }>();
  for (const score of scores) {
    const key = `${score.slot}:${score.resultKey}`;
    const aggregate = aggregates.get(key) ?? {
      settledCount: 0,
      hitCount: 0,
      brier: 0,
      baselineBrier: 0,
    };
    aggregate.settledCount += 1;
    aggregate.hitCount += score.actualMatched ? 1 : 0;
    aggregate.brier += score.brier;
    aggregate.baselineBrier += score.baselineBrier;
    aggregates.set(key, aggregate);
  }
  return new Map([...aggregates].map(([key, aggregate]) => [key, {
    settledCount: aggregate.settledCount,
    hitCount: aggregate.hitCount,
    brier: aggregate.brier / aggregate.settledCount,
    baselineBrier: aggregate.baselineBrier / aggregate.settledCount,
  }]));
}

export async function readValidatedHighestCommittedScores(
  game: GameId,
  options: {
    beforeIssue?: string;
    officialOnly?: boolean;
    requireCompleteCandidateSet?: boolean;
  } = {},
): Promise<ForwardLearningScoreV2[]> {
  await ensureForwardLearningV2Store();
  const db = runtime.__marksixD1;
  if (!db) return [];
  const revisions = await readValidatedHighestCommittedRevisions(
    db,
    game,
    options.beforeIssue,
  );
  if (!revisions.length) return [];
  const revisionIds = new Set(revisions.map((revision) => revision.revisionId));
  const rows = await db.prepare(
    `SELECT score_id, forecast_id, candidate_id, revision_id, game,
            target_issue, revision, slot, result_key, official,
            actual_matched, score_json, scored_at
     FROM forward_learning_revision_scores
     WHERE game = ? AND revision_id IN (${revisions.map(() => "?").join(", ")})
     ORDER BY CAST(target_issue AS INTEGER) DESC, slot, result_key`,
  ).bind(game, ...revisions.map((revision) => revision.revisionId)).all<JsonRow>();
  const revisionById = new Map(revisions.map((revision) => [revision.revisionId, revision]));
  const scores = (rows.results ?? []).map((row) => {
    const score = parseJson<ForwardLearningScoreV2>(row.score_json);
    const revision = score ? revisionById.get(score.revisionId) : null;
    if (!score || !revision || !revisionIds.has(String(row.revision_id)) ||
      !storedScoreRowMatchesJson(row, score) ||
      score.game !== revision.game ||
      score.targetIssue !== revision.targetIssue ||
      score.revision !== revision.revision) {
      throw new ForwardLearningDataIntegrityError(
        "resolved-v2 committed score与manifest完整性校验失败",
      );
    }
    return score;
  });
  if (options.requireCompleteCandidateSet) {
    for (const revision of revisions) {
      const revisionScores = scores.filter((score) => score.revisionId === revision.revisionId);
      if (revisionScores.length) assertCompleteV2ScoreSet(revisionScores);
    }
  }
  return options.officialOnly ? scores.filter((score) => score.official) : scores;
}

async function readValidatedHighestCommittedRevisions(
  db: D1Database,
  game: GameId,
  beforeIssue?: string,
) {
  const cutoff = beforeIssue
    ? "AND CAST(target_issue AS INTEGER) < CAST(? AS INTEGER)"
    : "";
  const rows = await db.prepare(
    `SELECT revisions.revision_id, revisions.game, revisions.target_issue,
            revisions.revision, revisions.status, revisions.revision_json
     FROM forward_learning_revisions revisions
     INNER JOIN (
       SELECT game, target_issue, MAX(revision) AS revision
       FROM forward_learning_revisions
       WHERE status = 'committed' AND game = ? ${cutoff}
       GROUP BY game, target_issue
     ) latest
       ON latest.game = revisions.game
      AND latest.target_issue = revisions.target_issue
      AND latest.revision = revisions.revision
     WHERE revisions.status = 'committed' AND revisions.game = ?
     ORDER BY CAST(revisions.target_issue AS INTEGER) DESC`,
  ).bind(
    game,
    ...(beforeIssue ? [beforeIssue] : []),
    game,
  ).all<JsonRow>();
  return (rows.results ?? []).map((row) =>
    validatedCommittedRevision(row, game, String(row.target_issue))
  );
}

function validatedCommittedRevision(
  row: JsonRow,
  game: GameId,
  targetIssue: string,
) {
  const revision = parseJson<ForwardLearningRevision>(row.revision_json);
  if (!revision || row.status !== "committed" || row.game !== game ||
    row.target_issue !== targetIssue || Number(row.revision) !== revision.revision ||
    revision.status !== "committed" || revision.game !== row.game ||
    revision.targetIssue !== row.target_issue || revision.revisionId !== row.revision_id ||
    revision.selectionPolicy !== "rolling-product-ev-v2" ||
    !revision.sourceRunId?.trim() || !revision.dataVersion?.trim()) {
    throw new ForwardLearningDataIntegrityError(
      "resolved-v2 committed revision manifest完整性校验失败",
    );
  }
  return revision;
}

function validRevisionSnapshot(snapshot: ForwardLearningRevisionSnapshot) {
  if (snapshot.candidates.length !== 357 ||
    snapshot.forecasts.length !== FORWARD_LEARNING_SLOTS.length ||
    !Number.isInteger(snapshot.revision) || snapshot.revision < 1) return false;
  const candidates = new Map<string, ForwardLearningCandidateV2>();
  const results = new Set<string>();
  for (const candidate of snapshot.candidates) {
    const identity = `${candidate.slot}:${candidate.resultKey}`;
    if (candidates.has(candidate.candidateId) || results.has(identity) ||
      candidate.candidateId !== canonicalCandidateId(snapshot.revisionId, candidate) ||
      candidate.revisionId !== snapshot.revisionId ||
      !sameRevisionIdentity(candidate, snapshot)) return false;
    candidates.set(candidate.candidateId, candidate);
    results.add(identity);
  }
  const slots = new Set<string>();
  for (const forecast of snapshot.forecasts) {
    const candidate = candidates.get(forecast.candidateId);
    if (!candidate || slots.has(forecast.slot) || !forecast.official ||
      forecast.forecastId !== `forecast:${forecast.candidateId}` ||
      !sameCandidateMirror(candidate, forecast)) return false;
    slots.add(forecast.slot);
  }
  return FORWARD_LEARNING_SLOTS.every((slot) => slots.has(slot));
}

function sameCandidateMirror(
  candidate: ForwardLearningCandidateV2,
  forecast: ForwardLearningForecastV2,
) {
  const forecastOnlyFields = new Set([
    "forecastId",
    "official",
    "rank",
    "previousResultKey",
    "previousProbability",
    "probabilityDelta",
    "topAlternative",
    "explanation",
  ]);
  const candidateMirror = Object.fromEntries(
    Object.entries(forecast).filter(([key]) => !forecastOnlyFields.has(key)),
  );
  const candidateKeys = Object.keys(candidate).sort();
  const mirrorKeys = Object.keys(candidateMirror).sort();
  return candidateKeys.length === mirrorKeys.length &&
    candidateKeys.every((key, index) => key === mirrorKeys[index]) &&
    canonicalJson(candidate) === canonicalJson(candidateMirror);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(object[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalRolloutJson(rollout: ForwardLearningRollout) {
  return JSON.stringify({
    game: rollout.game,
    firstUnifiedTargetIssue: rollout.firstUnifiedTargetIssue,
    legacySeedThroughIssue: rollout.legacySeedThroughIssue,
    seedQueryVersion: rollout.seedQueryVersion,
    sourceRunId: rollout.sourceRunId,
    sourceDataHash: rollout.sourceDataHash,
    authoritativeRecommendationHash: rollout.authoritativeRecommendationHash,
    createdAt: rollout.createdAt,
  });
}

function sameRevisionIdentity(
  item: ForwardLearningCandidateV2,
  snapshot: ForwardLearningRevisionSnapshot,
) {
  return item.game === snapshot.game &&
    item.targetIssue === snapshot.targetIssue &&
    item.revision === snapshot.revision &&
    item.selectionPolicy === snapshot.selectionPolicy &&
    item.sourceRunId === snapshot.sourceRunId &&
    item.dataVersion === snapshot.dataVersion &&
    Number.isFinite(Date.parse(item.frozenAt));
}

function canonicalCandidateId(
  revisionId: string,
  candidate: Pick<ForwardLearningCandidateV2, "slot" | "resultKey">,
) {
  return `candidate:unified-v2:${revisionId}:${candidate.slot}:${candidate.resultKey}`;
}

function revisionManifest(
  snapshot: ForwardLearningRevisionSnapshot,
  status: ForwardLearningRevision["status"],
  committedAt: string | null,
): ForwardLearningRevision {
  return {
    revisionId: snapshot.revisionId,
    game: snapshot.game,
    targetIssue: snapshot.targetIssue,
    revision: snapshot.revision,
    status,
    selectionPolicy: snapshot.selectionPolicy,
    sourceRunId: snapshot.sourceRunId,
    dataVersion: snapshot.dataVersion,
    contentHash: snapshot.contentHash,
    reason: snapshot.reason,
    createdAt: snapshot.createdAt,
    committedAt,
  };
}

async function readRevisionIdentity(
  db: D1Database,
  snapshot: ForwardLearningRevisionSnapshot,
) {
  return db.prepare(
    `SELECT revision_id, status, content_hash, revision_json
     FROM forward_learning_revisions
     WHERE revision_id = ? OR (game = ? AND target_issue = ? AND revision = ?)
     ORDER BY CASE WHEN revision_id = ? THEN 0 ELSE 1 END LIMIT 1`,
  ).bind(
    snapshot.revisionId,
    snapshot.game,
    snapshot.targetIssue,
    snapshot.revision,
    snapshot.revisionId,
  ).first<{
    revision_id: string;
    status: string;
    content_hash: string;
    revision_json: string;
  }>();
}

function sameFrozenRows(
  rows: JsonRow[] | undefined,
  idKey: string,
  jsonKey: string,
  expectedEntries: Array<[string, string]>,
) {
  if ((rows?.length ?? 0) !== expectedEntries.length) return false;
  const expected = new Map(expectedEntries);
  return (rows ?? []).every((row) => expected.get(String(row[idKey])) === row[jsonKey]);
}

async function latestTargetIssue(db: D1Database, game: GameId) {
  const [v2, v1] = await Promise.all([
    db.prepare(
      `SELECT target_issue FROM forward_learning_revisions
       WHERE game = ? AND status = 'committed'
       ORDER BY target_issue DESC, revision DESC LIMIT 1`,
    ).bind(game).first<{ target_issue: string }>(),
    db.prepare(
      `SELECT target_issue FROM forward_learning_forecasts
       WHERE game = ? ORDER BY target_issue DESC, frozen_at ASC LIMIT 1`,
    ).bind(game).first<{ target_issue: string }>(),
  ]);
  if (!v1?.target_issue) return v2?.target_issue ?? null;
  if (!v2?.target_issue) return v1.target_issue;
  return v2.target_issue > v1.target_issue ? v2.target_issue : v1.target_issue;
}

function scoreV2Candidate(
  candidate: ForwardLearningCandidateV2,
  forecast: ForwardLearningForecastV2 | null,
  draw: Draw,
  scoredAt: string,
): ForwardLearningScoreV2 {
  const actualMatched = candidateMatched(candidate, draw);
  const probability = candidate.learnedProbability;
  return {
    scoreId: `score:${candidate.candidateId}`,
    forecastId: forecast?.forecastId ?? null,
    candidateId: candidate.candidateId,
    revisionId: candidate.revisionId,
    revision: candidate.revision,
    game: candidate.game,
    targetIssue: candidate.targetIssue,
    slot: candidate.slot,
    resultKey: candidate.resultKey,
    official: Boolean(forecast),
    actualMatched,
    probability,
    learnedProbability: probability,
    baselineProbability: candidate.baselineProbability,
    brier: brierLoss(probability, actualMatched),
    baselineBrier: brierLoss(candidate.baselineProbability, actualMatched),
    logLoss: binaryLogLoss(probability, actualMatched),
    baselineLogLoss: binaryLogLoss(candidate.baselineProbability, actualMatched),
    actualNumbers: [...draw.numbers, draw.special],
    actualSpecial: draw.special,
    scoredAt,
  };
}

function validateStoredV2Scores(
  rows: JsonRow[] | undefined,
  expectedByCandidate: ReadonlyMap<string, ForwardLearningScoreV2>,
) {
  if ((rows?.length ?? 0) > expectedByCandidate.size) {
    throw new Error("新版逐期学习评分账本数量异常");
  }
  const seen = new Set<string>();
  return (rows ?? []).map((row) => {
    const score = parseJson<ForwardLearningScoreV2>(row.score_json);
    const expected = score ? expectedByCandidate.get(score.candidateId) : null;
    if (!score || !expected || seen.has(score.candidateId) ||
      !storedScoreRowMatchesJson(row, score) ||
      deterministicScoreJson(score) !== deterministicScoreJson(expected)) {
      throw new Error("新版逐期学习既有评分与本次开奖冲突");
    }
    seen.add(score.candidateId);
    return score;
  });
}

function storedScoreRowMatchesJson(
  row: JsonRow,
  score: ForwardLearningScoreV2,
) {
  return row.score_id === score.scoreId &&
    row.forecast_id === score.forecastId &&
    row.candidate_id === score.candidateId &&
    row.revision_id === score.revisionId &&
    row.game === score.game &&
    row.target_issue === score.targetIssue &&
    Number(row.revision) === score.revision &&
    row.slot === score.slot &&
    row.result_key === score.resultKey &&
    Boolean(Number(row.official)) === score.official &&
    Boolean(Number(row.actual_matched)) === score.actualMatched &&
    row.scored_at === score.scoredAt;
}

function deterministicScoreJson(score: ForwardLearningScoreV2) {
  return canonicalJson(Object.fromEntries(
    Object.entries(score).filter(([key]) => key !== "scoredAt"),
  ));
}

function assertCompleteV2ScoreSet(
  scores: readonly ForwardLearningScoreV2[],
) {
  const candidateIds = new Set(scores.map((score) => score.candidateId));
  const results = new Set(scores.map((score) => `${score.slot}:${score.resultKey}`));
  const official = scores.filter((score) => score.official);
  const officialSlots = new Set(official.map((score) => score.slot));
  if (scores.length !== 357 || candidateIds.size !== 357 || results.size !== 357 ||
    official.length !== FORWARD_LEARNING_SLOTS.length ||
    officialSlots.size !== FORWARD_LEARNING_SLOTS.length ||
    !FORWARD_LEARNING_SLOTS.every((slot) => officialSlots.has(slot))) {
    throw new Error("新版逐期学习评分必须恰好包含357候选和5项正式结果");
  }
}

async function settleV1Snapshot(
  resolved: ResolvedForwardSnapshot,
  draw: Draw,
  scoredAt: string,
): Promise<ResolvedSettlement> {
  const db = runtime.__marksixD1;
  if (!db) return { status: "not_found", source: null, revision: null, scores: [] };
  const candidates = resolved.candidates as ForwardLearningCandidate[];
  const forecasts = resolved.forecasts as ForwardLearningForecast[];
  const officialByCandidate = new Map(forecasts.map((item) => [item.candidateId, item]));
  const scores = candidates.map((candidate): ForwardLearningScore => {
    const actualMatched = candidateMatched(candidate, draw);
    const forecast = officialByCandidate.get(candidate.candidateId);
    return {
      scoreId: `score:${candidate.candidateId}`,
      forecastId: forecast?.forecastId ?? null,
      candidateId: candidate.candidateId,
      game: candidate.game,
      targetIssue: candidate.targetIssue,
      slot: candidate.slot,
      resultKey: candidate.resultKey,
      official: Boolean(forecast),
      actualMatched,
      probability: candidate.finalProbability,
      baselineProbability: candidate.baselineProbability,
      brier: brierLoss(candidate.finalProbability, actualMatched),
      baselineBrier: brierLoss(candidate.baselineProbability, actualMatched),
      logLoss: binaryLogLoss(candidate.finalProbability, actualMatched),
      baselineLogLoss: binaryLogLoss(candidate.baselineProbability, actualMatched),
      actualNumbers: [...draw.numbers, draw.special],
      actualSpecial: draw.special,
      scoredAt,
    };
  });
  await runBatches(db, scores.map((score) => db.prepare(
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
  )));
  const rows = await db.prepare(
    `SELECT score_json FROM forward_learning_scores
     WHERE game = ? AND target_issue = ? ORDER BY slot, result_key`,
  ).bind(resolved.game, resolved.targetIssue).all<JsonRow>();
  return {
    status: "settled",
    source: "v1",
    revision: 1,
    scores: rowsAs<ForwardLearningScore>(rows.results, "score_json"),
  };
}

function candidateMatched(
  candidate: ForwardLearningCandidate | ForwardLearningCandidateV2,
  draw: Draw,
) {
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

function assertResolvedForecasts(
  forecasts: readonly ForwardLearningForecastV2[],
  revision: ForwardLearningRevision,
) {
  const slots = new Set(forecasts.map((forecast) => forecast.slot));
  if (forecasts.length !== FORWARD_LEARNING_SLOTS.length ||
    slots.size !== FORWARD_LEARNING_SLOTS.length ||
    !FORWARD_LEARNING_SLOTS.every((slot) => slots.has(slot)) ||
    forecasts.some((forecast) =>
      !forecast.official || forecast.rank !== 1 ||
      forecast.game !== revision.game ||
      forecast.targetIssue !== revision.targetIssue ||
      forecast.revisionId !== revision.revisionId ||
      forecast.revision !== revision.revision ||
      forecast.sourceRunId !== revision.sourceRunId ||
      forecast.dataVersion !== revision.dataVersion
    )) {
    throw new Error("resolved-v2权威五项来源不完整或混合");
  }
}

function forecastToRecommendation(
  forecast: ForwardLearningForecastV2,
): AuthoritativeRecommendation {
  const product = forecastToProduct(forecast);
  return {
    kind: forecast.slot,
    resultKey: forecast.resultKey,
    values: [...forecast.values],
    sourceRunId: forecast.sourceRunId,
    sourceProductId: forecast.sourceProductId,
    sourceKind: forecast.sourceKind,
    dataVersion: forecast.dataVersion,
    revision: forecast.revision,
    p30: forecast.patternProbability,
    legacySeedProbability: forecast.legacySeedProbability,
    learnedProbability: forecast.learnedProbability,
    netOdds: forecast.netOdds,
    breakEvenProbability: forecast.breakEvenProbability,
    expectedValue: forecast.expectedValue,
    legacySettledCount: forecast.legacySettledCount,
    legacyHitCount: forecast.legacyHitCount,
    learningSettledCount: forecast.learningSettledCount,
    learningHitCount: forecast.learningHitCount,
    product,
    reason: productReason(product),
  };
}

function forecastToProduct(forecast: ForwardLearningForecastV2): RollingPatternProduct {
  const learningMissCount = Math.max(
    0,
    forecast.learningSettledCount - forecast.learningHitCount,
  );
  return {
    runId: forecast.sourceRunId,
    productId: forecast.sourceProductId ?? forecast.candidateId,
    dataVersion: forecast.dataVersion,
    game: forecast.game,
    targetIssue: forecast.targetIssue,
    scope: forecast.slot === "special_number" ? "special" : "coverage_6_plus_1",
    kind: forecast.slot,
    label: forecast.label,
    values: [...forecast.values],
    evidenceEventIds: [],
    strategyCount: forecast.rawRuleCount,
    support: forecast.support,
    hits: forecast.hits,
    misses: Math.max(0, forecast.support - forecast.hits),
    baselineProbability: forecast.baselineProbability,
    patternProbability: forecast.patternProbability,
    legacySeedProbability: forecast.legacySeedProbability,
    estimatedProbability: forecast.learnedProbability,
    netOdds: forecast.netOdds,
    breakEvenProbability: forecast.breakEvenProbability,
    expectedValue: forecast.expectedValue,
    valueStatus: forecast.expectedValue >= 0 ? "positive" : "negative",
    legacySettledCount: forecast.legacySettledCount,
    legacyHitCount: forecast.legacyHitCount,
    learningSettledCount: forecast.learningSettledCount,
    learningHitCount: forecast.learningHitCount,
    learningMissCount,
    sourceKind: forecast.sourceKind,
    sourceProductId: forecast.sourceProductId,
    derivedDefinitionHash: forecast.derivedDefinitionHash,
    forwardSettledCount: forecast.learningSettledCount,
    forwardHitCount: forecast.learningHitCount,
    forwardMissCount: learningMissCount,
    rank: 1,
    frozenAt: forecast.frozenAt,
  };
}

function productReason(product: RollingPatternProduct) {
  const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
  const expected = `${product.expectedValue >= 0 ? "+" : ""}${product.expectedValue.toFixed(2)}`;
  const learning = product.learningSettledCount
    ? `同源产品学习已结算${product.learningSettledCount}期，命中${product.learningHitCount}期`
    : "同源产品学习尚无结算";
  const risk = product.expectedValue >= 0
    ? `高于盈亏平衡线${percent(product.breakEvenProbability)}`
    : `低于盈亏平衡线${percent(product.breakEvenProbability)}，属于负期望风险项`;
  return `当前30期共同审计${product.support}次、命中${product.hits}次；${learning}。参考概率${percent(product.estimatedProbability)}，${risk}，每1单位期望${expected}。`;
}

function slotOrder(slot: ForwardLearningSlot) {
  return FORWARD_LEARNING_SLOTS.indexOf(slot);
}

async function latestV2TargetIssue(db: D1Database, game: GameId) {
  const row = await db.prepare(
    `SELECT target_issue FROM forward_learning_revisions
     WHERE game = ? AND status = 'committed'
     ORDER BY CAST(target_issue AS INTEGER) DESC, revision DESC LIMIT 1`,
  ).bind(game).first<{ target_issue: string }>();
  return row?.target_issue ?? null;
}

async function initializeSchema(db: D1Database) {
  const expectedObjects = schemaObjectNames(FORWARD_LEARNING_V2_SCHEMA);
  const present = await countSchemaObjects(db, expectedObjects);
  if (present === expectedObjects.length) return;
  for (const statement of FORWARD_LEARNING_V2_SCHEMA.split(";").map((item) => item.trim()).filter(Boolean)) {
    await db.prepare(statement).run();
  }
  const repaired = await countSchemaObjects(db, expectedObjects);
  if (repaired !== expectedObjects.length) {
    throw new Error(`新版逐期学习数据库结构不完整：${repaired}/${expectedObjects.length}`);
  }
}

async function countSchemaObjects(db: D1Database, names: string[]) {
  const row = await db.prepare(
    `SELECT COUNT(*) AS present FROM sqlite_master
     WHERE type IN ('table', 'index') AND name IN (
       ${names.map((name) => `'${name}'`).join(", ")}
     )`,
  ).first<{ present: number }>();
  return Number(row?.present ?? 0);
}

function schemaObjectNames(schema: string) {
  return [...schema.matchAll(
    /CREATE (?:UNIQUE )?(?:TABLE|INDEX) IF NOT EXISTS\s+([a-zA-Z0-9_]+)/g,
  )].map((match) => match[1]);
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

const FORWARD_LEARNING_V2_SCHEMA = `
CREATE TABLE IF NOT EXISTS forward_learning_rollouts (game text PRIMARY KEY, first_unified_target_issue text NOT NULL, legacy_seed_through_issue text NOT NULL, seed_query_version text NOT NULL, rollout_json text NOT NULL, created_at text NOT NULL);
CREATE TABLE IF NOT EXISTS forward_learning_revisions (revision_id text PRIMARY KEY, game text NOT NULL, target_issue text NOT NULL, revision integer NOT NULL, status text NOT NULL, content_hash text NOT NULL, revision_json text NOT NULL, created_at text NOT NULL, committed_at text);
CREATE UNIQUE INDEX IF NOT EXISTS forward_learning_revision_identity_idx ON forward_learning_revisions (game, target_issue, revision);
CREATE TABLE IF NOT EXISTS forward_learning_revision_candidates (candidate_id text PRIMARY KEY, revision_id text NOT NULL, game text NOT NULL, target_issue text NOT NULL, revision integer NOT NULL, slot text NOT NULL, result_key text NOT NULL, candidate_json text NOT NULL, frozen_at text NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS forward_learning_revision_candidate_result_idx ON forward_learning_revision_candidates (game, target_issue, revision, slot, result_key);
CREATE TABLE IF NOT EXISTS forward_learning_revision_forecasts (forecast_id text PRIMARY KEY, candidate_id text NOT NULL, revision_id text NOT NULL, game text NOT NULL, target_issue text NOT NULL, revision integer NOT NULL, slot text NOT NULL, result_key text NOT NULL, forecast_json text NOT NULL, frozen_at text NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS forward_learning_revision_forecast_slot_idx ON forward_learning_revision_forecasts (game, target_issue, revision, slot);
CREATE TABLE IF NOT EXISTS forward_learning_revision_scores (score_id text PRIMARY KEY, forecast_id text, candidate_id text NOT NULL UNIQUE, revision_id text NOT NULL, game text NOT NULL, target_issue text NOT NULL, revision integer NOT NULL, slot text NOT NULL, result_key text NOT NULL, official integer NOT NULL, actual_matched integer NOT NULL, score_json text NOT NULL, scored_at text NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS forward_learning_revision_score_result_idx ON forward_learning_revision_scores (game, target_issue, revision, slot, result_key);
CREATE UNIQUE INDEX IF NOT EXISTS forward_learning_revision_score_forecast_idx ON forward_learning_revision_scores (forecast_id) WHERE forecast_id IS NOT NULL;
`;
