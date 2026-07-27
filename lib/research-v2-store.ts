import {
  MODEL_VERSION,
  RESEARCH_ENGINE_VERSION,
  RESEARCH_SCHEMA_VERSION,
  RULE_ENGINE_VERSION,
  type ResearchRuleEvidence,
  type ResearchRunEnvelope,
  type ResearchSnapshot,
  type ResearchTargetForecast,
} from "./research-v2-types";
import { getWave, getZodiac, type Draw, type GameId } from "./lottery";
import { canonicalRuleJson } from "./research-v2-engine";

const runtime = globalThis as typeof globalThis & {
  __marksixD1?: D1Database;
};

type ForecastRow = {
  snapshot_json: string;
  frozen_at: string;
  settled_at: string | null;
};

export async function readResearchSnapshot(
  game: GameId,
  targetIssue?: string | null,
): Promise<ResearchSnapshot | null> {
  const db = runtime.__marksixD1;
  if (!db) return null;
  try {
    const row = targetIssue
      ? await db.prepare(
        `SELECT snapshot_json, frozen_at, settled_at
         FROM research_forecasts
         WHERE game = ? AND target_issue = ?
         ORDER BY frozen_at ASC, run_id ASC
         LIMIT 1`,
      )
        .bind(game, targetIssue)
        .first<ForecastRow>()
      : await db.prepare(
        `SELECT snapshot_json, frozen_at, settled_at
         FROM research_forecasts
         WHERE game = ?
         ORDER BY expected_draw_at DESC, frozen_at ASC
         LIMIT 1`,
      )
        .bind(game)
        .first<ForecastRow>();
    const parsed = row ? parseJson(row.snapshot_json) : null;
    return isResearchSnapshot(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function readPreviousResearchSnapshot(
  game: GameId,
  beforeExpectedDrawAt: string,
): Promise<ResearchSnapshot | null> {
  const db = runtime.__marksixD1;
  if (!db) return null;
  try {
    const row = await db.prepare(
      `SELECT snapshot_json, frozen_at, settled_at
       FROM research_forecasts
       WHERE game = ? AND expected_draw_at < ?
       ORDER BY expected_draw_at DESC, frozen_at ASC
       LIMIT 1`,
    )
      .bind(game, beforeExpectedDrawAt)
      .first<ForecastRow>();
    const parsed = row ? parseJson(row.snapshot_json) : null;
    return isResearchSnapshot(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function persistResearchRun(
  envelope: ResearchRunEnvelope,
): Promise<"created" | "existing" | "unavailable" | "invalid"> {
  if (!isResearchRunEnvelope(envelope)) return "invalid";
  const db = runtime.__marksixD1;
  if (!db) return "unavailable";
  const { snapshot } = envelope;
  const rules = deduplicateRules([
    ...snapshot.verifiedRules,
    ...snapshot.experimentalRules,
    ...snapshot.negativeRules,
    ...envelope.rules,
  ]);
  try {
    const inserted = await db.prepare(
      `INSERT OR IGNORE INTO research_forecasts (
         run_id, game, target_issue, expected_draw_at, generated_at,
         dataset_version, rule_engine_version, model_version, evidence_tier,
         snapshot_json, frozen_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        snapshot.runId,
        snapshot.game,
        snapshot.targetIssue,
        snapshot.expectedDrawAt,
        snapshot.generatedAt,
        snapshot.dataQuality.datasetVersion,
        snapshot.ruleEngineVersion,
        snapshot.modelVersion,
        snapshot.evidenceTier,
        JSON.stringify(snapshot),
        snapshot.generatedAt,
      )
      .run();
    if (Number(inserted.meta?.changes ?? 0) === 0) return "existing";

    const statements = [
      db.prepare(
        `INSERT OR IGNORE INTO dataset_versions (
           dataset_version, game, generated_at, oldest_issue, newest_issue,
           draw_count, formal_draw_count, missing_issue_count, conflict_count,
           fingerprint, summary_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
      ).bind(
        snapshot.dataQuality.datasetVersion,
        snapshot.game,
        snapshot.generatedAt,
        snapshot.dataQuality.oldestIssue,
        snapshot.dataQuality.newestIssue,
        snapshot.dataQuality.sampleSize,
        snapshot.dataQuality.formalSampleSize,
        snapshot.dataQuality.datasetVersion,
        JSON.stringify(snapshot.dataQuality),
      ),
      db.prepare(
        `INSERT OR IGNORE INTO research_model_registry (
           model_version, game, kind, role, status, dataset_version,
           code_version, config_json, metrics_json, registered_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        `${snapshot.game}:${snapshot.modelVersion}`,
        snapshot.game,
        "dual_track_shadow",
        "challenger",
        "shadow",
        snapshot.dataQuality.datasetVersion,
        snapshot.engineVersion,
        JSON.stringify({
          ruleEngineVersion: snapshot.ruleEngineVersion,
          formalUsesVerifiedOnly: true,
        }),
        JSON.stringify(snapshot.modelComparison),
        snapshot.generatedAt,
      ),
    ];
    for (const rule of rules.slice(0, 500)) {
      statements.push(
        db.prepare(
          `INSERT OR IGNORE INTO research_rule_definitions (
             rule_id, rule_engine_version, family, target_id, direction,
             canonical_json, description, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          rule.ruleId,
          snapshot.ruleEngineVersion,
          rule.family,
          rule.targetId,
          rule.direction,
          canonicalRuleJson(rule.spec),
          rule.description,
          snapshot.generatedAt,
        ),
        db.prepare(
          `INSERT OR IGNORE INTO research_rule_evaluations (
             evaluation_id, run_id, rule_id, game, dataset_version, tier,
             direction, support, hits, metrics_json, resource_decision,
             evaluated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          `${snapshot.runId}:${rule.ruleId}`,
          snapshot.runId,
          rule.ruleId,
          snapshot.game,
          snapshot.dataQuality.datasetVersion,
          rule.tier,
          rule.direction,
          rule.support,
          rule.hits,
          JSON.stringify({
            hitRate: rule.hitRate,
            baselineRate: rule.baselineRate,
            shrunkenRate: rule.shrunkenRate,
            lift: rule.lift,
            brierSkill: rule.brierSkill,
            nonWorseFoldRatio: rule.nonWorseFoldRatio,
            pValue: rule.pValue,
            qValue: rule.qValue,
            stabilityScore: rule.stabilityScore,
          }),
          rule.resourceDecision,
          snapshot.generatedAt,
        ),
      );
    }
    for (let index = 0; index < statements.length; index += 80) {
      await db.batch(statements.slice(index, index + 80));
    }
    return "created";
  } catch {
    return "unavailable";
  }
}

export async function settleResearchForecasts(
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
    const rows = await db.prepare(
      `SELECT run_id, target_issue, snapshot_json
       FROM research_forecasts
       WHERE game = ? AND settled_at IS NULL`,
    )
      .bind(game)
      .all<{
        run_id: string;
        target_issue: string;
        snapshot_json: string;
      }>();
    for (const row of rows.results ?? []) {
      const draw = verifiedByIssue.get(row.target_issue);
      const parsed = parseJson(row.snapshot_json);
      if (!draw || !isResearchSnapshot(parsed)) continue;
      const actual = {
        issue: draw.issue,
        drawAt: draw.drawAt,
        numbers: draw.numbers,
        special: draw.special,
        source: draw.source,
        verified: draw.verified,
      };
      const scores = parsed.targetForecasts.map((target) =>
        scoreTarget(target, draw),
      );
      const statements = [
        db.prepare(
          `UPDATE research_forecasts
           SET actual_json = ?, settled_at = ?
           WHERE run_id = ? AND settled_at IS NULL`,
        ).bind(JSON.stringify(actual), settledAt, row.run_id),
        ...scores.map((score) =>
          db.prepare(
            `INSERT OR IGNORE INTO research_forecast_scores (
               score_id, run_id, game, target_issue, target_id,
               brier_score, baseline_brier_score, log_loss,
               baseline_log_loss, score_json, scored_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            `${row.run_id}:${score.targetId}`,
            row.run_id,
            game,
            draw.issue,
            score.targetId,
            score.brier,
            score.baselineBrier,
            score.logLoss,
            score.baselineLogLoss,
            JSON.stringify(score),
            settledAt,
          ),
        ),
      ];
      await db.batch(statements);
    }
    return "ok";
  } catch {
    return "unavailable";
  }
}

function scoreTarget(target: ResearchTargetForecast, draw: Draw) {
  const actual = actualValues(target, draw);
  const independent =
    target.scope === "main.any" || target.scope === "draw.6_plus_1";
  const formalBrier = target.formalProbabilities.map((probability) => {
    const outcome = actual.has(probability.value) ? 1 : 0;
    return square(probability.probability - outcome);
  });
  const baselineBrier = target.formalProbabilities.map((probability) => {
    const outcome = actual.has(probability.value) ? 1 : 0;
    return square(probability.baseline - outcome);
  });
  const modelLogLoss = independent
    ? target.formalProbabilities.map((probability) => {
      const outcome = actual.has(probability.value);
      return -Math.log(
        Math.max(
          outcome ? probability.probability : 1 - probability.probability,
          1e-12,
        ),
      );
    })
    : [
      -Math.log(
        Math.max(
          target.formalProbabilities.find((probability) =>
            actual.has(probability.value)
          )?.probability ?? 1e-12,
          1e-12,
        ),
      ),
    ];
  const baselineLogLoss = independent
    ? target.formalProbabilities.map((probability) => {
      const outcome = actual.has(probability.value);
      return -Math.log(
        Math.max(
          outcome ? probability.baseline : 1 - probability.baseline,
          1e-12,
        ),
      );
    })
    : [
      -Math.log(
        Math.max(
          target.formalProbabilities.find((probability) =>
            actual.has(probability.value)
          )?.baseline ?? 1e-12,
          1e-12,
        ),
      ),
    ];
  return {
    targetId: target.targetId,
    brier: average(formalBrier),
    baselineBrier: average(baselineBrier),
    logLoss: average(modelLogLoss),
    baselineLogLoss: average(baselineLogLoss),
    actual: [...actual],
  };
}

function actualValues(
  target: ResearchTargetForecast,
  draw: Draw,
): Set<string> {
  const numbers =
    target.scope === "special"
      ? [draw.special]
      : target.scope.startsWith("main.position.")
        ? [draw.numbers[Number(target.scope.split(".")[2]) - 1]]
        : target.scope === "main.any"
          ? draw.numbers
          : [...draw.numbers, draw.special];
  return new Set(
    numbers
      .filter((number): number is number => typeof number === "number")
      .map((number) => categoryValue(target.family, number, draw.drawAt)),
  );
}

function categoryValue(
  family: ResearchTargetForecast["family"],
  number: number,
  drawAt: string,
) {
  if (family === "number") return String(number);
  if (family === "zodiac") return getZodiac(number, drawAt);
  if (family === "wave") {
    const wave = getWave(number);
    return wave === "red" ? "红波" : wave === "blue" ? "蓝波" : "绿波";
  }
  if (family === "tail") return `${number % 10}尾`;
  if (family === "parity") return number % 2 ? "单" : "双";
  if (family === "size") return number >= 25 ? "大" : "小";
  return number <= 16 ? "一区" : number <= 33 ? "二区" : "三区";
}

function isResearchRunEnvelope(value: unknown): value is ResearchRunEnvelope {
  if (!value || typeof value !== "object") return false;
  const envelope = value as { snapshot?: unknown; rules?: unknown };
  return isResearchSnapshot(envelope.snapshot) && Array.isArray(envelope.rules);
}

export function isResearchSnapshot(value: unknown): value is ResearchSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<ResearchSnapshot>;
  return (
    snapshot.schemaVersion === RESEARCH_SCHEMA_VERSION &&
    snapshot.engineVersion === RESEARCH_ENGINE_VERSION &&
    snapshot.ruleEngineVersion === RULE_ENGINE_VERSION &&
    snapshot.modelVersion === MODEL_VERSION &&
    typeof snapshot.runId === "string" &&
    (snapshot.game === "hk" || snapshot.game === "new_macau") &&
    typeof snapshot.targetIssue === "string" &&
    /^\d+$/.test(snapshot.targetIssue) &&
    typeof snapshot.expectedDrawAt === "string" &&
    Number.isFinite(Date.parse(snapshot.expectedDrawAt)) &&
    Array.isArray(snapshot.targetForecasts) &&
    Array.isArray(snapshot.experimentalRules) &&
    Array.isArray(snapshot.negativeRules) &&
    Array.isArray(snapshot.modelComparison)
  );
}

function deduplicateRules(rules: ResearchRuleEvidence[]) {
  return [...new Map(rules.map((rule) => [rule.ruleId, rule])).values()];
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function average(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) /
    Math.max(values.length, 1);
}

function square(value: number) {
  return value * value;
}
