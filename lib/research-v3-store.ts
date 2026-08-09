import type { Draw, GameId } from "./lottery";
import { isResearchPythonArtifact } from "./research-python-artifact";
import {
  buildResearchV3Performance,
  buildResearchV3Review,
} from "./research-v3-review";
import {
  RESEARCH_V3_ENGINE_VERSION,
  RESEARCH_V3_LEGACY_ENGINE_VERSION,
  RESEARCH_V3_LEGACY_MODEL_VERSION,
  RESEARCH_V3_MODEL_VERSION,
  RESEARCH_V3_REVIEW_VERSION,
  RESEARCH_V3_SCHEMA_VERSION,
  type ResearchEventSlot,
  type ResearchExpertId,
  type ResearchLearningRun,
  type ResearchPythonArtifact,
  type ResearchRuleStateMap,
  type ResearchV3Performance,
  type ResearchV3Review,
  type ResearchV3Snapshot,
} from "./research-v3-types";

const runtime = globalThis as typeof globalThis & {
  __marksixD1?: D1Database;
  __marksixResearchV3SchemaReady?: Promise<void>;
};

export async function ensureResearchV3Store() {
  const db = runtime.__marksixD1;
  if (!db) return false;
  runtime.__marksixResearchV3SchemaReady ??= initializeResearchV3Schema(db)
    .catch((error: unknown) => {
      runtime.__marksixResearchV3SchemaReady = undefined;
      throw error;
    });
  await runtime.__marksixResearchV3SchemaReady;
  return true;
}

async function initializeResearchV3Schema(db: D1Database) {
  const statements = RESEARCH_V3_SCHEMA
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of statements) {
    await db.prepare(statement).run();
  }
}

type SnapshotRow = {
  run_id: string;
  snapshot_json: string;
  review_json: string | null;
  settled_at: string | null;
};

export async function readResearchV3Snapshot(
  game: GameId,
  targetIssue?: string | null,
): Promise<ResearchV3Snapshot | null> {
  const db = runtime.__marksixD1;
  if (!db) return null;
  try {
    const row = targetIssue
      ? await db.prepare(
        `SELECT run_id, snapshot_json, review_json, settled_at
         FROM research_v3_forecasts
         WHERE game = ? AND target_issue = ?
         ORDER BY frozen_at ASC, run_id ASC
         LIMIT 1`,
      ).bind(game, targetIssue).first<SnapshotRow>()
      : await db.prepare(
        `SELECT run_id, snapshot_json, review_json, settled_at
         FROM research_v3_forecasts
         WHERE game = ?
         ORDER BY expected_draw_at DESC, frozen_at ASC
         LIMIT 1`,
      ).bind(game).first<SnapshotRow>();
    const parsed = parseJson(row?.snapshot_json ?? "");
    return isResearchV3Snapshot(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function persistResearchV3Snapshot(
  snapshot: ResearchV3Snapshot,
): Promise<"created" | "existing" | "unavailable" | "invalid"> {
  if (!isResearchV3Snapshot(snapshot)) return "invalid";
  const db = runtime.__marksixD1;
  if (!db) return "unavailable";
  try {
    const inserted = await db.prepare(
      `INSERT OR IGNORE INTO research_v3_forecasts (
         run_id, game, target_issue, expected_draw_at, generated_at,
         dataset_version, engine_version, model_version, mode,
         snapshot_json, frozen_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      snapshot.runId,
      snapshot.game,
      snapshot.targetIssue,
      snapshot.expectedDrawAt,
      snapshot.generatedAt,
      snapshot.dataQuality.datasetVersion,
      snapshot.engineVersion,
      snapshot.modelVersion,
      snapshot.mode,
      JSON.stringify(snapshot),
      snapshot.frozenAt,
    ).run();
    if (Number(inserted.meta?.changes ?? 0) === 0) {
      return "existing";
    }
    await freezeEvents(db, snapshot);
    await registerModelArtifacts(db, snapshot);
    return "created";
  } catch {
    return "unavailable";
  }
}

export async function persistResearchDataset(
  snapshot: ResearchV3Snapshot,
  draws: Draw[],
): Promise<"ok" | "unavailable"> {
  const db = runtime.__marksixD1;
  if (!db) return "unavailable";
  const ordered = [...draws].sort(
    (left, right) => Date.parse(left.drawAt) - Date.parse(right.drawAt),
  );
  try {
    const statements: D1PreparedStatement[] = [];
    for (const draw of ordered) {
      const rawJson = JSON.stringify(draw);
      const sourceHash = stableRecordHash(rawJson);
      const grade = sourceGrade(draw);
      statements.push(
        db.prepare(
          `INSERT OR IGNORE INTO draw_source_snapshots (
             snapshot_id, game, issue, source, source_grade, fetched_at,
             body_hash, raw_json, status
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          `${draw.game}:${draw.issue}:${sourceHash}`,
          draw.game,
          draw.issue,
          draw.source,
          grade,
          snapshot.generatedAt,
          sourceHash,
          rawJson,
          draw.verified ? "consistent" : "unverified",
        ),
        db.prepare(
          `INSERT INTO lottery_draws (
             draw_id, game, issue, draw_at, main_1, main_2, main_3,
             main_4, main_5, main_6, special, source_grade, verified,
             source_hash, available_at, ingested_at, dataset_version
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(draw_id) DO UPDATE SET
             draw_at = excluded.draw_at,
             main_1 = excluded.main_1, main_2 = excluded.main_2,
             main_3 = excluded.main_3, main_4 = excluded.main_4,
             main_5 = excluded.main_5, main_6 = excluded.main_6,
             special = excluded.special, source_grade = excluded.source_grade,
             verified = excluded.verified, source_hash = excluded.source_hash,
             available_at = excluded.available_at, ingested_at = excluded.ingested_at,
             dataset_version = excluded.dataset_version
           WHERE excluded.verified > lottery_draws.verified
              OR (excluded.verified = lottery_draws.verified
                  AND excluded.source_hash <> lottery_draws.source_hash)`,
        ).bind(
          `${draw.game}:${draw.issue}`,
          draw.game,
          draw.issue,
          draw.drawAt,
          ...draw.numbers,
          draw.special,
          grade,
          draw.verified ? 1 : 0,
          sourceHash,
          draw.drawAt,
          snapshot.generatedAt,
          snapshot.dataQuality.datasetVersion,
        ),
      );
    }
    statements.push(
      db.prepare(
        `INSERT OR IGNORE INTO dataset_versions (
           dataset_version, game, generated_at, oldest_issue, newest_issue,
           draw_count, formal_draw_count, missing_issue_count, conflict_count,
           fingerprint, summary_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        snapshot.dataQuality.datasetVersion,
        snapshot.game,
        snapshot.generatedAt,
        snapshot.dataQuality.oldestIssue,
        snapshot.dataQuality.newestIssue,
        snapshot.dataQuality.sampleSize,
        snapshot.dataQuality.verifiedSampleSize,
        snapshot.dataQuality.missingIssueCount,
        snapshot.dataQuality.conflictCount,
        snapshot.dataQuality.datasetVersion,
        JSON.stringify({
          sourceMode: snapshot.dataQuality.sourceMode,
          verifiedRatio: snapshot.dataQuality.verifiedRatio,
          warnings: snapshot.dataQuality.warnings,
          missingIssueCount: snapshot.dataQuality.missingIssueCount,
          conflictCount: snapshot.dataQuality.conflictCount,
          usedIssues: ordered.filter((draw) => draw.verified).map((draw) => draw.issue),
        }),
      ),
    );
    for (let index = 0; index < statements.length; index += 80) {
      await db.batch(statements.slice(index, index + 80));
    }
    return "ok";
  } catch {
    return "unavailable";
  }
}

export async function settleResearchV3Forecasts(
  game: GameId,
  draws: Draw[],
  settledAt = new Date().toISOString(),
): Promise<"ok" | "unavailable"> {
  const db = runtime.__marksixD1;
  if (!db) return "unavailable";
  const verifiedByIssue = new Map(
    draws.filter((draw) => draw.verified).map((draw) => [draw.issue, draw]),
  );
  try {
    await ensureResearchV3Store();
    const stateRows = await db.prepare(
      `SELECT state_id, recent_20_json, recent_50_json
       FROM research_rule_states
       WHERE game = ?`,
    ).bind(game).all<{
      state_id: string;
      recent_20_json: string;
      recent_50_json: string;
    }>();
    const stateHistory = new Map(
      (stateRows.results ?? []).map((row) => [
        row.state_id,
        {
          recent20: parseBooleanHistory(row.recent_20_json),
          recent50: parseBooleanHistory(row.recent_50_json),
        },
      ]),
    );
    const rows = await db.prepare(
      `SELECT run_id, snapshot_json, review_json, settled_at
       FROM research_v3_forecasts
       WHERE game = ? AND settled_at IS NULL`,
    ).bind(game).all<SnapshotRow>();
    for (const row of rows.results ?? []) {
      const parsed = parseJson(row.snapshot_json);
      if (!isResearchV3Snapshot(parsed)) continue;
      const draw = verifiedByIssue.get(parsed.targetIssue);
      if (!draw) continue;
      const preliminaryReview = buildResearchV3Review(parsed, draw, settledAt);
      const priorEvidenceRows = await readChampionEvidenceRows(db, parsed.game);
      const currentEvidenceRows: ChampionEvidenceRow[] = preliminaryReview.events
        .flatMap((event) => event.modelWeightsBefore.map((model) => ({
          target_issue: parsed.targetIssue,
          model_id: model.modelId,
          probability: model.probability,
          status: model.status,
          actual_matched: event.actualMatched ? 1 : 0,
        })));
      const evaluatedDecision = evaluateChampionEvidence([
        ...priorEvidenceRows,
        ...currentEvidenceRows,
      ]);
      const persistedChampion = await readPersistedFormalChampion(db, parsed.game);
      const championDecision = withPersistedChampion(
        evaluatedDecision,
        persistedChampion,
      );
      const review = buildResearchV3Review(
        parsed,
        draw,
        settledAt,
        championDecision,
      );
      const claimed = await claimResearchSettlement(
        db,
        parsed.runId,
        parsed.game,
        parsed.targetIssue,
        settledAt,
      );
      if (!claimed) continue;
      const statements: D1PreparedStatement[] = [
        db.prepare(
          `UPDATE research_v3_forecasts
           SET actual_json = ?, review_version = ?, review_json = ?, settled_at = ?
           WHERE run_id = ? AND settled_at IS NULL`,
        ).bind(
          JSON.stringify(review.actual),
          RESEARCH_V3_REVIEW_VERSION,
          JSON.stringify(review),
          settledAt,
          parsed.runId,
        ),
        db.prepare(
          `INSERT OR IGNORE INTO research_learning_runs (
             learning_run_id, run_id, game, settled_issue, status,
             champion_before, champion_after, challenger_promoted,
             drift_detected, summary_json, started_at, completed_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          review.learningRun.learningRunId,
          parsed.runId,
          parsed.game,
          parsed.targetIssue,
          review.learningRun.status,
          review.learningRun.championBefore,
          review.learningRun.championAfter,
          review.learningRun.challengerPromoted ? 1 : 0,
          review.learningRun.driftDetected ? 1 : 0,
          JSON.stringify(review.learningRun),
          review.learningRun.startedAt,
          review.learningRun.completedAt,
        ),
      ];
      review.events.forEach((event) => {
        statements.push(
          db.prepare(
            `UPDATE research_event_ledger
             SET actual_matched = ?, actual_label = ?, scored_at = ?
             WHERE event_id = ? AND scored_at IS NULL`,
          ).bind(
            event.actualMatched ? 1 : 0,
            event.actualLabel,
            settledAt,
            event.eventId,
          ),
          db.prepare(
            `INSERT OR IGNORE INTO research_event_scores (
               score_id, run_id, event_id, game, target_issue, slot,
               probability, baseline_probability, actual_matched,
               brier_score, baseline_brier_score, log_loss,
               baseline_log_loss, score_json, scored_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            `${parsed.runId}:${event.eventId}`,
            parsed.runId,
            event.eventId,
            parsed.game,
            parsed.targetIssue,
            event.slot,
            event.probability,
            event.baselineProbability,
            event.actualMatched ? 1 : 0,
            event.brier,
            event.baselineBrier,
            event.logLoss,
            event.baselineLogLoss,
            JSON.stringify(event),
            settledAt,
          ),
        );
        event.modelWeightsBefore.forEach((before) => {
          const after = event.modelWeightsAfter.find(
            (item) => item.modelId === before.modelId,
          ) ?? before;
          statements.push(
            db.prepare(
              `INSERT OR IGNORE INTO research_model_weights (
                 weight_id, run_id, game, target_issue, slot, model_id,
                 weight_before, weight_after, probability, status, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).bind(
              `${parsed.runId}:${event.slot}:${before.modelId}`,
              parsed.runId,
              parsed.game,
              parsed.targetIssue,
              event.slot,
              before.modelId,
              before.weight,
              after.weight,
              before.probability,
              before.status,
              settledAt,
            ),
          );
        });
        event.ruleContributions.forEach((rule) => {
          const ruleMatched =
            event.actualMatched === (rule.direction === "support");
          const successBaseline = rule.direction === "support"
            ? rule.baselineRate
            : 1 - rule.baselineRate;
          const stateId = `${parsed.game}:${event.slot}:${rule.ruleId}`;
          const previous = stateHistory.get(stateId) ?? {
            recent20: [],
            recent50: [],
          };
          const recent20 = [...previous.recent20, ruleMatched].slice(-20);
          const recent50 = [...previous.recent50, ruleMatched].slice(-50);
          stateHistory.set(stateId, { recent20, recent50 });
          statements.push(
            db.prepare(
              `INSERT INTO research_rule_states (
                 state_id, game, slot, rule_id, posterior_alpha, posterior_beta,
                 triggers, hits, consecutive_hits, consecutive_misses,
                 recent_20_json, recent_50_json, status, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(state_id) DO UPDATE SET
                 posterior_alpha = posterior_alpha + excluded.hits,
                 posterior_beta = posterior_beta + (1 - excluded.hits),
                 triggers = triggers + 1,
                 hits = hits + excluded.hits,
                 consecutive_hits = CASE WHEN excluded.hits = 1 THEN consecutive_hits + 1 ELSE 0 END,
                 consecutive_misses = CASE WHEN excluded.hits = 0 THEN consecutive_misses + 1 ELSE 0 END,
                 recent_20_json = excluded.recent_20_json,
                 recent_50_json = excluded.recent_50_json,
                 status = CASE
                   WHEN status = 'retired' THEN 'retired'
                   WHEN excluded.hits = 0 AND consecutive_misses + 1 >= 12 THEN 'retired'
                   WHEN excluded.hits = 0 AND consecutive_misses + 1 >= 5 THEN 'suppressed'
                   WHEN excluded.hits = 1 AND consecutive_hits + 1 >= 3 THEN 'active'
                   ELSE status
                 END,
                 updated_at = excluded.updated_at`,
            ).bind(
              stateId,
              parsed.game,
              event.slot,
              rule.ruleId,
              successBaseline * 20 + (ruleMatched ? 1 : 0),
              (1 - successBaseline) * 20 + (ruleMatched ? 0 : 1),
              ruleMatched ? 1 : 0,
              ruleMatched ? 1 : 0,
              ruleMatched ? 0 : 1,
              JSON.stringify(recent20),
              JSON.stringify(recent50),
              "active",
              settledAt,
            ),
          );
        });
      });
      statements.push(
        db.prepare(
          `UPDATE research_settlement_claims
           SET status = 'completed', completed_at = ?, error_message = NULL
           WHERE run_id = ? AND status = 'processing'`,
        ).bind(settledAt, parsed.runId),
      );
      try {
        if (statements.length > 100) {
          throw new Error("settlement transaction exceeds D1 batch limit");
        }
        await db.batch(statements);
      } catch (error) {
        await db.prepare(
          `UPDATE research_settlement_claims
           SET status = 'failed', completed_at = ?, error_message = ?
           WHERE run_id = ? AND status = 'processing'`,
        ).bind(
          settledAt,
          error instanceof Error ? error.message.slice(0, 500) : "unknown",
          parsed.runId,
        ).run();
        throw error;
      }
    }
    return "ok";
  } catch {
    return "unavailable";
  }
}

async function claimResearchSettlement(
  db: D1Database,
  runId: string,
  game: GameId,
  targetIssue: string,
  claimedAt: string,
) {
  const inserted = await db.prepare(
    `INSERT OR IGNORE INTO research_settlement_claims (
       run_id, game, target_issue, status, claimed_at
     ) VALUES (?, ?, ?, 'processing', ?)`,
  ).bind(runId, game, targetIssue, claimedAt).run();
  if (Number(inserted.meta?.changes ?? 0) === 1) return true;
  const leaseCutoff = new Date(Date.parse(claimedAt) - 10 * 60_000).toISOString();
  const reclaimed = await db.prepare(
    `UPDATE research_settlement_claims
     SET status = 'processing', claimed_at = ?, completed_at = NULL,
         error_message = NULL
     WHERE run_id = ? AND (
       status = 'failed' OR (status = 'processing' AND claimed_at < ?)
     )`,
  ).bind(claimedAt, runId, leaseCutoff).run();
  return Number(reclaimed.meta?.changes ?? 0) === 1;
}

export type ResearchTaskClaim =
  | { status: "claimed" }
  | { status: "processing" }
  | { status: "existing"; response: unknown }
  | { status: "conflict" }
  | { status: "unavailable" };

export async function claimResearchTask(input: {
  taskId: string;
  game: GameId;
  requestHash: string;
  startedAt: string;
}): Promise<ResearchTaskClaim> {
  const db = runtime.__marksixD1;
  if (!db || !await ensureResearchV3Store()) return { status: "unavailable" };
  try {
    const inserted = await db.prepare(
      `INSERT OR IGNORE INTO research_task_runs (
         task_id, game, request_hash, status, started_at
       ) VALUES (?, ?, ?, 'processing', ?)`,
    ).bind(input.taskId, input.game, input.requestHash, input.startedAt).run();
    if (Number(inserted.meta?.changes ?? 0) === 1) return { status: "claimed" };
    const row = await db.prepare(
      `SELECT game, request_hash, status, response_json
       FROM research_task_runs WHERE task_id = ?`,
    ).bind(input.taskId).first<{
      game: string;
      request_hash: string;
      status: string;
      response_json: string | null;
    }>();
    if (!row || row.game !== input.game || row.request_hash !== input.requestHash) {
      return { status: "conflict" };
    }
    if (row.status === "completed" && row.response_json) {
      return { status: "existing", response: parseJson(row.response_json) };
    }
    if (row.status === "failed") {
      const retried = await db.prepare(
        `UPDATE research_task_runs
         SET status = 'processing', started_at = ?, completed_at = NULL,
             response_json = NULL, error_message = NULL
         WHERE task_id = ? AND status = 'failed'`,
      ).bind(input.startedAt, input.taskId).run();
      if (Number(retried.meta?.changes ?? 0) === 1) return { status: "claimed" };
    }
    return { status: "processing" };
  } catch {
    return { status: "unavailable" };
  }
}

export async function completeResearchTask(
  taskId: string,
  response: unknown,
  completedAt: string,
) {
  const db = runtime.__marksixD1;
  if (!db) return false;
  const result = await db.prepare(
    `UPDATE research_task_runs
     SET status = 'completed', response_json = ?, completed_at = ?,
         error_message = NULL
     WHERE task_id = ? AND status = 'processing'`,
  ).bind(JSON.stringify(response), completedAt, taskId).run();
  return Number(result.meta?.changes ?? 0) === 1;
}

export async function failResearchTask(
  taskId: string,
  errorMessage: string,
  completedAt: string,
) {
  const db = runtime.__marksixD1;
  if (!db) return;
  await db.prepare(
    `UPDATE research_task_runs
     SET status = 'failed', error_message = ?, completed_at = ?
     WHERE task_id = ? AND status = 'processing'`,
  ).bind(errorMessage.slice(0, 500), completedAt, taskId).run();
}

const RESEARCH_V3_SCHEMA = `
CREATE TABLE IF NOT EXISTS lottery_draws (
  draw_id text PRIMARY KEY NOT NULL, game text NOT NULL, issue text NOT NULL,
  draw_at text NOT NULL, main_1 integer NOT NULL, main_2 integer NOT NULL,
  main_3 integer NOT NULL, main_4 integer NOT NULL, main_5 integer NOT NULL,
  main_6 integer NOT NULL, special integer NOT NULL, source_grade text NOT NULL,
  verified integer NOT NULL DEFAULT 0, source_hash text NOT NULL,
  available_at text NOT NULL, ingested_at text NOT NULL, dataset_version text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS lottery_draws_game_issue_idx
  ON lottery_draws (game, issue);
CREATE INDEX IF NOT EXISTS lottery_draws_game_draw_at_idx
  ON lottery_draws (game, draw_at);
CREATE INDEX IF NOT EXISTS lottery_draws_dataset_idx
  ON lottery_draws (dataset_version);
CREATE TABLE IF NOT EXISTS draw_source_snapshots (
  snapshot_id text PRIMARY KEY NOT NULL, game text NOT NULL, issue text NOT NULL,
  source text NOT NULL, source_grade text NOT NULL, fetched_at text NOT NULL,
  body_hash text NOT NULL, raw_json text NOT NULL, status text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS draw_source_snapshot_identity_idx
  ON draw_source_snapshots (game, issue, source, body_hash);
CREATE INDEX IF NOT EXISTS draw_source_snapshot_issue_idx
  ON draw_source_snapshots (game, issue);
CREATE TABLE IF NOT EXISTS dataset_versions (
  dataset_version text PRIMARY KEY NOT NULL, game text NOT NULL,
  generated_at text NOT NULL, oldest_issue text, newest_issue text,
  draw_count integer NOT NULL, formal_draw_count integer NOT NULL,
  missing_issue_count integer NOT NULL DEFAULT 0,
  conflict_count integer NOT NULL DEFAULT 0, fingerprint text NOT NULL,
  summary_json text NOT NULL
);
CREATE INDEX IF NOT EXISTS dataset_versions_game_generated_idx
  ON dataset_versions (game, generated_at);
CREATE TABLE IF NOT EXISTS research_event_ledger (
  event_id text PRIMARY KEY NOT NULL, run_id text NOT NULL, game text NOT NULL,
  target_issue text NOT NULL, slot text NOT NULL, scope text NOT NULL,
  family text NOT NULL, predicted_value text NOT NULL, probability real NOT NULL,
  baseline_probability real NOT NULL, evidence_tier text NOT NULL,
  frozen_event_json text NOT NULL, frozen_at text NOT NULL,
  actual_matched integer, actual_label text, scored_at text
);
CREATE UNIQUE INDEX IF NOT EXISTS research_event_slot_identity_idx
  ON research_event_ledger (run_id, slot);
CREATE INDEX IF NOT EXISTS research_event_issue_idx
  ON research_event_ledger (game, target_issue, scored_at);
CREATE TABLE IF NOT EXISTS research_event_scores (
  score_id text PRIMARY KEY NOT NULL, run_id text NOT NULL, event_id text NOT NULL,
  game text NOT NULL, target_issue text NOT NULL, slot text NOT NULL,
  probability real NOT NULL, baseline_probability real NOT NULL,
  actual_matched integer NOT NULL, brier_score real NOT NULL,
  baseline_brier_score real NOT NULL, log_loss real NOT NULL,
  baseline_log_loss real NOT NULL, score_json text NOT NULL, scored_at text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS research_event_score_identity_idx
  ON research_event_scores (run_id, event_id);
CREATE INDEX IF NOT EXISTS research_event_score_game_idx
  ON research_event_scores (game, target_issue, slot);
CREATE TABLE IF NOT EXISTS research_learning_runs (
  learning_run_id text PRIMARY KEY NOT NULL, run_id text NOT NULL,
  game text NOT NULL, settled_issue text NOT NULL, status text NOT NULL,
  champion_before text NOT NULL, champion_after text NOT NULL,
  challenger_promoted integer NOT NULL, drift_detected integer NOT NULL,
  summary_json text NOT NULL, started_at text NOT NULL, completed_at text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS research_learning_run_identity_idx
  ON research_learning_runs (run_id, settled_issue);
CREATE INDEX IF NOT EXISTS research_learning_game_idx
  ON research_learning_runs (game, completed_at);
CREATE TABLE IF NOT EXISTS research_model_artifacts (
  artifact_id text PRIMARY KEY NOT NULL, game text NOT NULL,
  model_version text NOT NULL, kind text NOT NULL, role text NOT NULL,
  status text NOT NULL, dataset_version text NOT NULL, parent_artifact_id text,
  config_json text NOT NULL, metrics_json text NOT NULL, created_at text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS research_model_artifact_identity_idx
  ON research_model_artifacts (game, model_version, kind);
CREATE INDEX IF NOT EXISTS research_model_artifact_status_idx
  ON research_model_artifacts (game, status, created_at);
CREATE TABLE IF NOT EXISTS research_model_weights (
  weight_id text PRIMARY KEY NOT NULL, run_id text NOT NULL, game text NOT NULL,
  target_issue text NOT NULL, slot text NOT NULL, model_id text NOT NULL,
  weight_before real NOT NULL, weight_after real NOT NULL,
  probability real NOT NULL, status text NOT NULL, updated_at text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS research_model_weight_identity_idx
  ON research_model_weights (run_id, slot, model_id);
CREATE INDEX IF NOT EXISTS research_model_weight_latest_idx
  ON research_model_weights (game, slot, updated_at);
CREATE TABLE IF NOT EXISTS research_rule_states (
  state_id text PRIMARY KEY NOT NULL, game text NOT NULL, slot text NOT NULL,
  rule_id text NOT NULL, posterior_alpha real NOT NULL, posterior_beta real NOT NULL,
  triggers integer NOT NULL, hits integer NOT NULL, consecutive_hits integer NOT NULL,
  consecutive_misses integer NOT NULL, recent_20_json text NOT NULL,
  recent_50_json text NOT NULL, status text NOT NULL, updated_at text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS research_rule_state_identity_idx
  ON research_rule_states (game, slot, rule_id);
CREATE INDEX IF NOT EXISTS research_rule_state_status_idx
  ON research_rule_states (game, status, updated_at);
CREATE TABLE IF NOT EXISTS research_v3_forecasts (
  run_id text PRIMARY KEY NOT NULL, game text NOT NULL, target_issue text NOT NULL,
  expected_draw_at text NOT NULL, generated_at text NOT NULL,
  dataset_version text NOT NULL, engine_version text NOT NULL,
  model_version text NOT NULL, mode text NOT NULL, snapshot_json text NOT NULL,
  frozen_at text NOT NULL, actual_json text, review_version text,
  review_json text, settled_at text
);
CREATE UNIQUE INDEX IF NOT EXISTS research_v3_forecast_identity_idx
  ON research_v3_forecasts (game, target_issue);
CREATE INDEX IF NOT EXISTS research_v3_forecast_unsettled_idx
  ON research_v3_forecasts (game, settled_at, target_issue);
CREATE TABLE IF NOT EXISTS research_settlement_claims (
  run_id text PRIMARY KEY NOT NULL, game text NOT NULL, target_issue text NOT NULL,
  status text NOT NULL, claimed_at text NOT NULL, completed_at text,
  error_message text
);
CREATE INDEX IF NOT EXISTS research_settlement_claim_game_idx
  ON research_settlement_claims (game, status, claimed_at);
CREATE TABLE IF NOT EXISTS research_task_runs (
  task_id text PRIMARY KEY NOT NULL, game text NOT NULL, request_hash text NOT NULL,
  status text NOT NULL, response_json text, error_message text,
  started_at text NOT NULL, completed_at text
);
CREATE INDEX IF NOT EXISTS research_task_status_idx
  ON research_task_runs (game, status, started_at);
CREATE TABLE IF NOT EXISTS rolling_pattern_runs (
  run_id text PRIMARY KEY NOT NULL, game text NOT NULL,
  source_issue text NOT NULL, target_issue text NOT NULL,
  window_oldest_issue text NOT NULL, window_newest_issue text NOT NULL,
  window_data_hash text NOT NULL, engine_version text NOT NULL,
  status text NOT NULL, generated_at text NOT NULL, frozen_at text NOT NULL,
  run_json text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS rolling_pattern_target_idx
  ON rolling_pattern_runs (game, target_issue, window_data_hash, engine_version);
CREATE TABLE IF NOT EXISTS rolling_pattern_signals (
  run_id text NOT NULL, rule_id text NOT NULL, game text NOT NULL,
  target_issue text NOT NULL, rule_family text NOT NULL,
  event_family text NOT NULL, event_value text NOT NULL,
  sample_label text NOT NULL, signal_json text NOT NULL, frozen_at text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS rolling_pattern_signal_identity_idx
  ON rolling_pattern_signals (run_id, rule_id);
CREATE INDEX IF NOT EXISTS rolling_pattern_signal_filter_idx
  ON rolling_pattern_signals (game, target_issue, event_family);
CREATE TABLE IF NOT EXISTS rolling_pattern_scores (
  run_id text NOT NULL, rule_id text NOT NULL, game text NOT NULL,
  target_issue text NOT NULL, actual_matched integer NOT NULL,
  score_json text NOT NULL, scored_at text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS rolling_pattern_score_identity_idx
  ON rolling_pattern_scores (run_id, rule_id);
CREATE INDEX IF NOT EXISTS rolling_pattern_score_issue_idx
  ON rolling_pattern_scores (game, target_issue);
`;

export async function readResearchV3Reviews(
  game: GameId,
  limit = 50,
): Promise<ResearchV3Review[]> {
  const db = runtime.__marksixD1;
  if (!db) return [];
  const bounded = Math.max(1, Math.min(Math.floor(limit), 100));
  try {
    const rows = await db.prepare(
      `SELECT review_json
       FROM research_v3_forecasts
       WHERE game = ? AND settled_at IS NOT NULL AND review_json IS NOT NULL
       ORDER BY expected_draw_at DESC
       LIMIT ?`,
    ).bind(game, bounded).all<{ review_json: string }>();
    return (rows.results ?? [])
      .map((row) => parseJson(row.review_json))
      .filter(isResearchV3Review);
  } catch {
    return [];
  }
}

export async function readResearchV3Performance(
  game: GameId,
): Promise<ResearchV3Performance> {
  const reviews = await readResearchV3Reviews(game, 100);
  return buildResearchV3Performance(game, reviews);
}

export async function readResearchLearningRuns(
  game: GameId,
  limit = 20,
): Promise<ResearchLearningRun[]> {
  const db = runtime.__marksixD1;
  if (!db) return [];
  try {
    const rows = await db.prepare(
      `SELECT summary_json
       FROM research_learning_runs
       WHERE game = ?
       ORDER BY completed_at DESC
       LIMIT ?`,
    ).bind(game, Math.max(1, Math.min(limit, 50)))
      .all<{ summary_json: string }>();
    return (rows.results ?? [])
      .map((row) => parseJson(row.summary_json))
      .filter(isResearchLearningRun);
  } catch {
    return [];
  }
}

export async function readLatestModelWeights(
  game: GameId,
): Promise<
  Partial<Record<ResearchEventSlot, Partial<Record<ResearchExpertId, number>>>>
> {
  const db = runtime.__marksixD1;
  if (!db) return {};
  try {
    const rows = await db.prepare(
      `SELECT slot, model_id, weight_after
       FROM research_model_weights
       WHERE game = ?
       ORDER BY updated_at DESC`,
    ).bind(game).all<{
      slot: ResearchEventSlot;
      model_id: ResearchExpertId;
      weight_after: number;
    }>();
    const result: Partial<
      Record<ResearchEventSlot, Partial<Record<ResearchExpertId, number>>>
    > = {};
    const seen = new Set<string>();
    for (const row of rows.results ?? []) {
      const key = `${row.slot}:${row.model_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result[row.slot] ??= {};
      result[row.slot]![row.model_id] = row.weight_after;
    }
    return result;
  } catch {
    return {};
  }
}

export async function readResearchRuleStates(
  game: GameId,
): Promise<ResearchRuleStateMap> {
  const db = runtime.__marksixD1;
  if (!db) return {};
  try {
    const rows = await db.prepare(
      `SELECT slot, rule_id, triggers, hits, consecutive_hits,
              consecutive_misses, status
       FROM research_rule_states
       WHERE game = ?`,
    ).bind(game).all<{
      slot: ResearchEventSlot;
      rule_id: string;
      triggers: number;
      hits: number;
      consecutive_hits: number;
      consecutive_misses: number;
      status: "active" | "suppressed" | "retired";
    }>();
    const result: ResearchRuleStateMap = {};
    for (const row of rows.results ?? []) {
      result[row.slot] ??= {};
      result[row.slot]![row.rule_id] = {
        ruleId: row.rule_id,
        slot: row.slot,
        triggers: Number(row.triggers),
        hits: Number(row.hits),
        consecutiveHits: Number(row.consecutive_hits),
        consecutiveMisses: Number(row.consecutive_misses),
        status: row.status,
      };
    }
    return result;
  } catch {
    return {};
  }
}

export async function persistResearchPythonArtifact(
  artifact: ResearchPythonArtifact,
) {
  if (!isResearchPythonArtifact(artifact)) return "invalid" as const;
  const db = runtime.__marksixD1;
  if (!db) return "unavailable" as const;
  const artifactId = [
    "python",
    artifact.game,
    artifact.schemaVersion,
    artifact.audit.datasetVersion,
  ].join(":");
  try {
    const result = await db.prepare(
      `INSERT OR IGNORE INTO research_model_artifacts (
         artifact_id, game, model_version, kind, role, status,
         dataset_version, parent_artifact_id, config_json, metrics_json,
         created_at
       ) VALUES (?, ?, ?, 'python_rule_search', 'challenger', 'shadow', ?, NULL, ?, ?, ?)`,
    ).bind(
      artifactId,
      artifact.game,
      `${artifact.schemaVersion}-${artifact.audit.datasetVersion.slice(0, 16)}`,
      artifact.audit.datasetVersion,
      JSON.stringify(artifact.resourceFunnel),
      JSON.stringify(artifact),
      artifact.generatedAt,
    ).run();
    return Number(result.meta?.changes ?? 0) === 1
      ? "created" as const
      : "existing" as const;
  } catch {
    return "unavailable" as const;
  }
}

export async function readLatestResearchPythonArtifact(
  game: GameId,
): Promise<ResearchPythonArtifact | null> {
  const db = runtime.__marksixD1;
  if (!db) return null;
  try {
    const row = await db.prepare(
      `SELECT metrics_json
       FROM research_model_artifacts
       WHERE game = ? AND kind = 'python_rule_search' AND status = 'shadow'
       ORDER BY created_at DESC, artifact_id DESC
       LIMIT 1`,
    ).bind(game).first<{ metrics_json: string }>();
    const parsed = parseJson(row?.metrics_json ?? "");
    return isResearchPythonArtifact(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function countSettledResearchV3Forecasts(game: GameId) {
  const db = runtime.__marksixD1;
  if (!db) return 0;
  try {
    const row = await db.prepare(
      `SELECT COUNT(*) AS count
       FROM research_v3_forecasts
       WHERE game = ? AND settled_at IS NOT NULL`,
    ).bind(game).first<{ count: number }>();
    return Number(row?.count ?? 0);
  } catch {
    return 0;
  }
}

export async function readChampionChallengeState(game: GameId): Promise<{
  champion: ResearchExpertId;
  challenger: ResearchExpertId | null;
  sampleIssues: number;
  formalChampion: ResearchExpertId | null;
  confidenceLowerBound: number;
  randomChampionPercentile: number;
}> {
  const db = runtime.__marksixD1;
  if (!db) {
    return {
      champion: "baseline",
      challenger: "logistic",
      sampleIssues: 0,
      formalChampion: null,
      confidenceLowerBound: 0,
      randomChampionPercentile: 0,
    };
  }
  try {
    const [rows, persistedChampion] = await Promise.all([
      readChampionEvidenceRows(db, game),
      readPersistedFormalChampion(db, game),
    ]);
    return withPersistedChampion(
      evaluateChampionEvidence(rows),
      persistedChampion,
    );
  } catch {
    return {
      champion: "baseline",
      challenger: "logistic",
      sampleIssues: 0,
      formalChampion: null,
      confidenceLowerBound: 0,
      randomChampionPercentile: 0,
    };
  }
}

async function readChampionEvidenceRows(db: D1Database, game: GameId) {
  const rows = await db.prepare(
    `SELECT mw.target_issue, mw.model_id, mw.probability, mw.status,
            es.actual_matched
     FROM research_model_weights mw
     JOIN research_event_scores es
       ON es.run_id = mw.run_id AND es.slot = mw.slot
     WHERE mw.game = ?
     ORDER BY es.scored_at DESC
     LIMIT 2000`,
  ).bind(game).all<ChampionEvidenceRow>();
  return rows.results ?? [];
}

async function readPersistedFormalChampion(
  db: D1Database,
  game: GameId,
): Promise<ResearchExpertId | null> {
  const row = await db.prepare(
    `SELECT champion_after
     FROM research_learning_runs
     WHERE game = ? AND challenger_promoted = 1
     ORDER BY completed_at DESC
     LIMIT 1`,
  ).bind(game).first<{ champion_after: ResearchExpertId }>();
  return row?.champion_after ?? null;
}

function withPersistedChampion<T extends ReturnType<typeof evaluateChampionEvidence>>(
  evidence: T,
  persistedChampion: ResearchExpertId | null,
) {
  if (evidence.formalChampion || !persistedChampion) return evidence;
  return {
    ...evidence,
    champion: persistedChampion,
    formalChampion: persistedChampion,
  };
}

type ChampionEvidenceRow = {
  target_issue: string;
  model_id: ResearchExpertId;
  probability: number;
  status: string;
  actual_matched: number;
};

export function evaluateChampionEvidence(rows: ChampionEvidenceRow[]) {
  const eligible = rows.filter((row) => row.status !== "blocked");
  const issueIds = [...new Set(eligible.map((row) => row.target_issue))];
  const byModelIssue = new Map<string, { losses: number[]; probabilities: number[]; outcomes: number[] }>();
  for (const row of eligible) {
    const key = `${row.model_id}:${row.target_issue}`;
    const group = byModelIssue.get(key) ?? { losses: [], probabilities: [], outcomes: [] };
    const outcome = row.actual_matched ? 1 : 0;
    group.losses.push((row.probability - outcome) ** 2);
    group.probabilities.push(row.probability);
    group.outcomes.push(outcome);
    byModelIssue.set(key, group);
  }
  const issueLosses = (model: ResearchExpertId) => issueIds.flatMap((issue) => {
    const group = byModelIssue.get(`${model}:${issue}`);
    return group ? [{ issue, loss: average(group.losses) }] : [];
  });
  const calibration = (model: ResearchExpertId) => {
    const groups = issueIds.flatMap((issue) => {
      const group = byModelIssue.get(`${model}:${issue}`);
      return group ? [group] : [];
    });
    return Math.abs(
      average(groups.flatMap((group) => group.probabilities)) -
        average(groups.flatMap((group) => group.outcomes)),
    );
  };
  const baseline = new Map(issueLosses("baseline").map((row) => [row.issue, row.loss]));
  const candidates = (["interpretable_rules", "logistic", "black_box"] as ResearchExpertId[])
    .map((model) => {
      const differences = issueLosses(model).flatMap((row) => {
        const baselineLoss = baseline.get(row.issue);
        return baselineLoss === undefined ? [] : [baselineLoss - row.loss];
      });
      const improvement = average(differences);
      const confidenceLowerBound = meanLowerBound(differences);
      const randomChampionPercentile = signFlipPercentile(differences);
      return {
        model,
        issues: differences.length,
        improvement,
        confidenceLowerBound,
        randomChampionPercentile,
        calibration: calibration(model),
      };
    })
    .filter((candidate) => candidate.issues > 0)
    .sort((left, right) => right.improvement - left.improvement);
  const best = candidates[0];
  const baselineCalibration = calibration("baseline");
  const verified = Boolean(
    best &&
      best.issues >= 50 &&
      best.improvement >= 0.005 &&
      best.confidenceLowerBound > 0 &&
      best.randomChampionPercentile >= 0.99 &&
      best.calibration <= baselineCalibration + 0.01
  );
  const champion: ResearchExpertId = verified && best
    ? best.model
    : "baseline";
  return {
    champion,
    challenger: candidates.find((candidate) => candidate.model !== champion)?.model ??
      (champion === "logistic" ? "interpretable_rules" : "logistic"),
    sampleIssues: issueIds.length,
    formalChampion: verified ? champion : null,
    confidenceLowerBound: best?.confidenceLowerBound ?? 0,
    randomChampionPercentile: best?.randomChampionPercentile ?? 0,
  };
}

function meanLowerBound(values: number[]) {
  if (values.length < 2) return Number.NEGATIVE_INFINITY;
  const mean = average(values);
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    (values.length - 1);
  return mean - 1.96 * Math.sqrt(variance / values.length);
}

function signFlipPercentile(values: number[]) {
  if (!values.length) return 0;
  const observed = average(values);
  if (observed <= 0) return 0;
  let state = 0x6d2b79f5;
  let atLeastObserved = 0;
  const simulations = 10_000;
  for (let simulation = 0; simulation < simulations; simulation += 1) {
    let sum = 0;
    for (const value of values) {
      state = (Math.imul(state ^ (state >>> 15), 1 | state) + 0x9e3779b9) >>> 0;
      sum += (state & 1) === 0 ? value : -value;
    }
    if (sum / values.length >= observed - 1e-12) atLeastObserved += 1;
  }
  return 1 - (atLeastObserved + 1) / (simulations + 1);
}

async function freezeEvents(db: D1Database, snapshot: ResearchV3Snapshot) {
  const statements = snapshot.events.map((event) =>
    db.prepare(
      `INSERT OR IGNORE INTO research_event_ledger (
         event_id, run_id, game, target_issue, slot, scope, family,
         predicted_value, probability, baseline_probability, evidence_tier,
         frozen_event_json, frozen_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      event.eventId,
      snapshot.runId,
      snapshot.game,
      snapshot.targetIssue,
      event.slot,
      event.scope,
      event.family,
      event.predictedValue,
      event.probability,
      event.baselineProbability,
      event.evidenceTier,
      JSON.stringify(event),
      snapshot.frozenAt,
    )
  );
  if (statements.length) await db.batch(statements);
}

async function registerModelArtifacts(
  db: D1Database,
  snapshot: ResearchV3Snapshot,
) {
  const statements = [
    {
      id: `${snapshot.game}:${snapshot.modelVersion}:baseline`,
      kind: "baseline",
      role: "baseline",
      status: snapshot.learningSummary.champion === "baseline"
        ? "champion"
        : "active",
    },
    {
      id: `${snapshot.game}:${snapshot.modelVersion}:rules`,
      kind: "interpretable_rules",
      role: "interpretable",
      status: snapshot.learningSummary.champion === "interpretable_rules"
        ? "champion"
        : "shadow",
    },
    {
      id: `${snapshot.game}:${snapshot.modelVersion}:logistic`,
      kind: "regularized_logistic",
      role: "challenger",
      status: snapshot.dataQuality.sampleSize < 30
        ? "blocked"
        : snapshot.learningSummary.champion === "logistic"
          ? "champion"
          : "shadow",
    },
    {
      id: `${snapshot.game}:${snapshot.modelVersion}:black-box`,
      kind: "gradient_boosting",
      role: "challenger",
      status: "blocked",
    },
  ].map((model) =>
    db.prepare(
      `INSERT OR IGNORE INTO research_model_artifacts (
         artifact_id, game, model_version, kind, role, status,
         dataset_version, parent_artifact_id, config_json, metrics_json,
         created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    ).bind(
      model.id,
      snapshot.game,
      snapshot.modelVersion,
      model.kind,
      model.role,
      model.status,
      snapshot.dataQuality.datasetVersion,
      JSON.stringify({
        fastWindow: 40,
        mediumWindow: 120,
        baselineWeightFloor: 0.25,
      }),
      JSON.stringify(snapshot.events.map((event) => event.history)),
      snapshot.generatedAt,
    )
  );
  await db.batch(statements);
}

export function isResearchV3Snapshot(
  value: unknown,
): value is ResearchV3Snapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<ResearchV3Snapshot>;
  return (
    snapshot.schemaVersion === RESEARCH_V3_SCHEMA_VERSION &&
    (snapshot.engineVersion === RESEARCH_V3_ENGINE_VERSION ||
      snapshot.engineVersion === RESEARCH_V3_LEGACY_ENGINE_VERSION) &&
    typeof snapshot.modelVersion === "string" &&
    (snapshot.modelVersion.startsWith(RESEARCH_V3_MODEL_VERSION) ||
      snapshot.modelVersion.startsWith(RESEARCH_V3_LEGACY_MODEL_VERSION)) &&
    typeof snapshot.runId === "string" &&
    (snapshot.game === "hk" || snapshot.game === "new_macau") &&
    typeof snapshot.targetIssue === "string" &&
    Array.isArray(snapshot.events) &&
    snapshot.events.length === 4 &&
    snapshot.events.every((event) =>
      typeof event?.eventId === "string" &&
      typeof event?.probability === "number" &&
      event.probability >= 0.4 &&
      event.probability <= 0.7 &&
      typeof event?.baselineProbability === "number" &&
      event.baselineProbability >= 0.4 &&
      event.baselineProbability <= 0.7
    )
  );
}

function isResearchV3Review(value: unknown): value is ResearchV3Review {
  if (!value || typeof value !== "object") return false;
  const review = value as Partial<ResearchV3Review>;
  return (
    review.reviewVersion === RESEARCH_V3_REVIEW_VERSION &&
    typeof review.runId === "string" &&
    Array.isArray(review.events) &&
    review.events.length === 4
  );
}

function isResearchLearningRun(value: unknown): value is ResearchLearningRun {
  if (!value || typeof value !== "object") return false;
  const run = value as Partial<ResearchLearningRun>;
  return (
    typeof run.learningRunId === "string" &&
    typeof run.completedAt === "string" &&
    (run.status === "completed" || run.status === "failed")
  );
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseBooleanHistory(value: string) {
  const parsed = parseJson(value);
  return Array.isArray(parsed)
    ? parsed.filter((item): item is boolean => typeof item === "boolean")
    : [];
}

function average(values: number[]) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : Number.POSITIVE_INFINITY;
}

function sourceGrade(draw: Draw) {
  if (!draw.verified) return "single_source_unverified";
  return /香港赛马会官方/.test(draw.source)
    ? "official_verified"
    : "multi_source_consistent";
}

function stableRecordHash(value: string) {
  let left = 2166136261;
  let right = 2246822507;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    left = Math.imul(left ^ code, 16777619);
    right = Math.imul(right ^ code, 3266489909);
  }
  return [left, right]
    .map((valuePart) => (valuePart >>> 0).toString(16).padStart(8, "0"))
    .join("");
}
