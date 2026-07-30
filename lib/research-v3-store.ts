import type { Draw, GameId } from "./lottery";
import {
  buildResearchV3Performance,
  buildResearchV3Review,
} from "./research-v3-review";
import {
  RESEARCH_V3_ENGINE_VERSION,
  RESEARCH_V3_MODEL_VERSION,
  RESEARCH_V3_REVIEW_VERSION,
  RESEARCH_V3_SCHEMA_VERSION,
  type ResearchEventSlot,
  type ResearchExpertId,
  type ResearchLearningRun,
  type ResearchV3Performance,
  type ResearchV3Review,
  type ResearchV3Snapshot,
} from "./research-v3-types";

const runtime = globalThis as typeof globalThis & {
  __marksixD1?: D1Database;
};

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
      const review = buildResearchV3Review(parsed, draw, settledAt);
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
              rule.baselineRate * 20 + (ruleMatched ? 1 : 0),
              (1 - rule.baselineRate) * 20 + (ruleMatched ? 0 : 1),
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
      for (let index = 0; index < statements.length; index += 80) {
        await db.batch(statements.slice(index, index + 80));
      }
    }
    return "ok";
  } catch {
    return "unavailable";
  }
}

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
}> {
  const db = runtime.__marksixD1;
  if (!db) {
    return {
      champion: "interpretable_rules",
      challenger: "logistic",
      sampleIssues: 0,
    };
  }
  try {
    const rows = await db.prepare(
      `SELECT mw.target_issue, mw.model_id, mw.probability,
              es.actual_matched, es.scored_at
       FROM research_model_weights mw
       JOIN research_event_scores es
         ON es.run_id = mw.run_id AND es.slot = mw.slot
       WHERE mw.game = ?
       ORDER BY es.scored_at DESC
       LIMIT 400`,
    ).bind(game).all<{
      target_issue: string;
      model_id: ResearchExpertId;
      probability: number;
      actual_matched: number;
      scored_at: string;
    }>();
    const issueOrder: string[] = [];
    for (const row of rows.results ?? []) {
      if (!issueOrder.includes(row.target_issue)) issueOrder.push(row.target_issue);
      if (issueOrder.length >= 20) break;
    }
    const issueSet = new Set(issueOrder);
    const eligible = (rows.results ?? []).filter((row) =>
      issueSet.has(row.target_issue)
    );
    const metrics = new Map<
      ResearchExpertId,
      { brier: number[]; probability: number[]; outcome: number[] }
    >();
    eligible.forEach((row) => {
      const group = metrics.get(row.model_id) ?? {
        brier: [],
        probability: [],
        outcome: [],
      };
      const outcome = row.actual_matched ? 1 : 0;
      group.brier.push((row.probability - outcome) ** 2);
      group.probability.push(row.probability);
      group.outcome.push(outcome);
      metrics.set(row.model_id, group);
    });
    const score = (model: ResearchExpertId) => {
      const group = metrics.get(model);
      return {
        sample: group?.brier.length ?? 0,
        brier: average(group?.brier ?? []),
        calibration: Math.abs(
          average(group?.probability ?? []) - average(group?.outcome ?? []),
        ),
      };
    };
    const rules = score("interpretable_rules");
    const logistic = score("logistic");
    const blackBox = score("black_box");
    let champion: ResearchExpertId = "interpretable_rules";
    if (
      issueOrder.length >= 20 &&
      logistic.sample >= 80 &&
      logistic.brier < rules.brier &&
      logistic.calibration <= rules.calibration + 0.01
    ) {
      champion = "logistic";
    }
    if (
      issueOrder.length >= 20 &&
      blackBox.sample >= 80 &&
      blackBox.brier < Math.min(rules.brier, logistic.brier) &&
      blackBox.calibration <= Math.min(rules.calibration, logistic.calibration) + 0.01
    ) {
      champion = "black_box";
    }
    const ranked = (
      ["interpretable_rules", "logistic", "black_box"] as ResearchExpertId[]
    )
      .filter((model) => model !== champion && score(model).sample > 0)
      .sort((left, right) => score(left).brier - score(right).brier);
    return {
      champion,
      challenger: ranked[0] ?? (champion === "logistic"
        ? "interpretable_rules"
        : "logistic"),
      sampleIssues: issueOrder.length,
    };
  } catch {
    return {
      champion: "interpretable_rules",
      challenger: "logistic",
      sampleIssues: 0,
    };
  }
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
      status: snapshot.dataQuality.sampleSize < 1_000
        ? "blocked"
        : snapshot.learningSummary.champion === "black_box"
          ? "champion"
          : "shadow",
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
    snapshot.engineVersion === RESEARCH_V3_ENGINE_VERSION &&
    typeof snapshot.modelVersion === "string" &&
    snapshot.modelVersion.startsWith(RESEARCH_V3_MODEL_VERSION) &&
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
