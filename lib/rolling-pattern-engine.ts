import type { Draw, GameId } from "./lottery";
import {
  enumerateRollingEvents,
  evaluateRollingEvent,
  rollingEventBaseline,
} from "./rolling-pattern-events";
import {
  ROLLING_PATTERN_ENGINE_VERSION,
  type RollingPatternEvent,
  type RollingPatternEventState,
  type RollingPatternRule,
  type RollingPatternRuleFamily,
  type RollingPatternRun,
  type RollingPatternSignal,
  type RollingPatternTriggerAudit,
} from "./rolling-pattern-types";

const WINDOW_SIZE = 30;
const PRIOR_STRENGTH = 8;
const MIN_SUPPORT = 3;
const MIN_RAW_UPLIFT = 0.05;

type BuildRollingPatternRunInput = {
  game: GameId;
  draws: Draw[];
  targetIssue: string;
  expectedDrawAt: string;
  generatedAt: string;
};

type RuleEvaluation = {
  rule: RollingPatternRule;
  currentTriggered: boolean;
  support: number;
  hits: number;
  rawRate: number;
  baseline: number;
  rawUplift: number;
  posteriorRate: number;
  posteriorUplift: number;
  stateHistory: RollingPatternEventState[];
  audit: RollingPatternTriggerAudit[];
};

export async function buildRollingPatternRun(
  input: BuildRollingPatternRunInput,
): Promise<RollingPatternRun> {
  const windowDraws = [...input.draws]
    .filter((draw) => draw.verified && draw.game === input.game)
    .sort((left, right) =>
      Date.parse(right.drawAt) - Date.parse(left.drawAt) ||
      right.issue.localeCompare(left.issue, "en", { numeric: true })
    )
    .slice(0, WINDOW_SIZE);
  if (windowDraws.length !== WINDOW_SIZE) {
    throw new Error("rolling pattern scan requires 30 verified draws");
  }
  const chronological = [...windowDraws].reverse();
  const windowDataHash = await stablePatternHash(JSON.stringify(
    chronological.map((draw) => ({
      game: draw.game,
      issue: draw.issue,
      drawAt: draw.drawAt,
      numbers: draw.numbers,
      special: draw.special,
      verified: draw.verified,
    })),
  ));
  const generatedRules = enumerateRollingEvents(input.expectedDrawAt)
    .flatMap((event) => generateRules(event));
  const evaluations: RuleEvaluation[] = [];
  for (const rule of generatedRules) {
    const states = chronological.map((draw) => evaluateRollingEvent(draw, rule.event));
    const evaluation = evaluateRule(rule, states, input.expectedDrawAt);
    if (evaluation.currentTriggered) evaluations.push(evaluation);
  }
  const grouped = new Map<string, RuleEvaluation[]>();
  for (const evaluation of evaluations) {
    const group = grouped.get(evaluation.rule.canonicalJson) ?? [];
    group.push(evaluation);
    grouped.set(evaluation.rule.canonicalJson, group);
  }
  const deduplicated = [...grouped.values()].map((group) => ({
    ...group[0],
    rule: group[0].rule,
    relatedRuleCount: group.length,
  }));
  const aboveBaseline = deduplicated.filter((item) => item.rawRate > item.baseline);
  const qualified = aboveBaseline.filter((item) =>
    item.support >= MIN_SUPPORT && item.rawUplift >= MIN_RAW_UPLIFT
  );
  const signals: RollingPatternSignal[] = qualified
    .map((item) => ({
      rule: item.rule,
      currentTriggered: true as const,
      support: item.support,
      hits: item.hits,
      rawRate: item.rawRate,
      baseline: item.baseline,
      rawUplift: item.rawUplift,
      posteriorRate: item.posteriorRate,
      posteriorUplift: item.posteriorUplift,
      sampleLabel: sampleLabel(item.support),
      relatedRuleCount: item.relatedRuleCount,
      stateHistory: item.stateHistory,
      audit: item.audit,
    }))
    .sort((left, right) =>
      right.posteriorUplift - left.posteriorUplift ||
      right.support - left.support ||
      right.rawUplift - left.rawUplift ||
      left.rule.ruleId.localeCompare(right.rule.ruleId)
    );
  const runHash = await stablePatternHash([
    input.game,
    input.targetIssue,
    windowDataHash,
    ROLLING_PATTERN_ENGINE_VERSION,
  ].join(":"));
  return {
    schemaVersion: "rolling-patterns-1",
    engineVersion: ROLLING_PATTERN_ENGINE_VERSION,
    runId: `rp_${input.game}_${input.targetIssue}_${runHash.slice(0, 16)}`,
    game: input.game,
    sourceIssue: windowDraws[0].issue,
    targetIssue: input.targetIssue,
    expectedDrawAt: input.expectedDrawAt,
    generatedAt: input.generatedAt,
    frozenAt: input.generatedAt,
    status: "completed",
    window: {
      game: input.game,
      drawCount: windowDraws.length,
      oldestIssue: chronological[0].issue,
      newestIssue: chronological[chronological.length - 1].issue,
      dataHash: windowDataHash,
    },
    funnel: {
      generated: generatedRules.length,
      currentTriggered: evaluations.length,
      deduplicated: deduplicated.length,
      aboveBaseline: aboveBaseline.length,
      qualified: signals.length,
    },
    signals,
  };
}

function generateRules(event: RollingPatternEvent) {
  const candidates: Array<Omit<RollingPatternRule, "ruleId" | "canonicalJson" | "description">> = [];
  for (let length = 1; length <= 5; length += 1) {
    candidates.push({
      family: "omission_recovery",
      event,
      statePattern: Array<boolean>(length).fill(false),
      parameters: { length },
      prediction: true,
    });
  }
  for (let length = 1; length <= 3; length += 1) {
    candidates.push({
      family: "continuation",
      event,
      statePattern: Array<boolean>(length).fill(true),
      parameters: { length },
      prediction: true,
    });
  }
  for (let length = 2; length <= 4; length += 1) {
    for (let mask = 0; mask < 2 ** length; mask += 1) {
      candidates.push({
        family: "state_transition",
        event,
        statePattern: Array.from(
          { length },
          (_, index) => Boolean(mask & (1 << (length - index - 1))),
        ),
        parameters: { length },
        prediction: true,
      });
    }
  }
  for (let lag = 2; lag <= 5; lag += 1) {
    candidates.push({
      family: "lag_recurrence",
      event,
      statePattern: [true, ...Array<null>(lag - 1).fill(null)],
      parameters: { lag },
      prediction: true,
    });
  }
  return candidates.map((candidate) => finalizeRule(candidate));
}

function finalizeRule(
  candidate: Omit<RollingPatternRule, "ruleId" | "canonicalJson" | "description">,
): RollingPatternRule {
  const normalized = normalizeRule(candidate);
  const canonicalJson = JSON.stringify({
    engineVersion: ROLLING_PATTERN_ENGINE_VERSION,
    family: normalized.family,
    eventId: normalized.event.eventId,
    parameters: normalized.parameters,
    statePattern: normalized.statePattern,
    prediction: true,
  });
  return {
    ...normalized,
    canonicalJson,
    ruleId: `r30_${stablePatternHashSync(canonicalJson)}`,
    description: describeRule(normalized),
  };
}

function normalizeRule(
  candidate: Omit<RollingPatternRule, "ruleId" | "canonicalJson" | "description">,
) {
  const allFalse = candidate.statePattern.every((value) => value === false);
  const allTrue = candidate.statePattern.every((value) => value === true);
  if (candidate.family === "state_transition" && allFalse) {
    return {
      ...candidate,
      family: "omission_recovery" as const,
      parameters: { length: candidate.statePattern.length },
    };
  }
  if (candidate.family === "state_transition" && allTrue) {
    return {
      ...candidate,
      family: "continuation" as const,
      parameters: { length: candidate.statePattern.length },
    };
  }
  return candidate;
}

function describeRule(rule: Pick<RollingPatternRule, "family" | "event" | "parameters" | "statePattern">) {
  switch (rule.family) {
    case "omission_recovery":
      return `最近连续${rule.parameters.length}期未满足“${rule.event.value}”，研究下一期回补`;
    case "continuation":
      return `最近连续${rule.parameters.length}期满足“${rule.event.value}”，研究下一期延续`;
    case "lag_recurrence":
      return `前${rule.parameters.lag}期满足“${rule.event.value}”，研究下一期重现`;
    case "state_transition":
      return `最近${rule.statePattern.length}期状态为${rule.statePattern.map((value) => value ? "开" : "未开").join("→")}，研究下一期出现`;
  }
}

function evaluateRule(
  rule: RollingPatternRule,
  states: RollingPatternEventState[],
  expectedDrawAt: string,
): RuleEvaluation {
  const audit: RollingPatternTriggerAudit[] = [];
  const baselines: number[] = [];
  for (let targetIndex = 1; targetIndex < states.length; targetIndex += 1) {
    if (!triggerAt(states, targetIndex, rule)) continue;
    audit.push({
      sourceIssue: states[targetIndex - 1].issue,
      targetIssue: states[targetIndex].issue,
      targetDrawAt: states[targetIndex].drawAt,
      matched: states[targetIndex].matched,
    });
    baselines.push(rollingEventBaseline(rule.event, states[targetIndex].drawAt));
  }
  const support = audit.length;
  const hits = audit.filter((item) => item.matched).length;
  const rawRate = support ? hits / support : 0;
  const baseline = baselines.length
    ? average(baselines)
    : rollingEventBaseline(rule.event, expectedDrawAt);
  const posteriorRate = (hits + PRIOR_STRENGTH * baseline) /
    (support + PRIOR_STRENGTH);
  return {
    rule,
    currentTriggered: triggerAt(states, states.length, rule),
    support,
    hits,
    rawRate,
    baseline,
    rawUplift: rawRate - baseline,
    posteriorRate,
    posteriorUplift: posteriorRate - baseline,
    stateHistory: states,
    audit,
  };
}

function triggerAt(
  states: RollingPatternEventState[],
  targetIndex: number,
  rule: RollingPatternRule,
) {
  if (rule.family === "lag_recurrence") {
    const lag = rule.parameters.lag ?? 0;
    return targetIndex >= lag && states[targetIndex - lag]?.matched === true;
  }
  const length = rule.parameters.length ?? rule.statePattern.length;
  if (targetIndex < length) return false;
  const observed = states.slice(targetIndex - length, targetIndex)
    .map((state) => state.matched);
  const matches = rule.statePattern.every((value, index) =>
    value === null || value === observed[index]
  );
  if (!matches) return false;
  if (rule.family === "omission_recovery") {
    return targetIndex > length && states[targetIndex - length - 1].matched;
  }
  if (rule.family === "continuation") {
    return targetIndex > length && !states[targetIndex - length - 1].matched;
  }
  return true;
}

function sampleLabel(support: number): RollingPatternSignal["sampleLabel"] {
  if (support < 6) return "小样本";
  if (support < 10) return "有限样本";
  return "近期重复";
}

export async function stablePatternHash(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function stablePatternHashSync(value: string) {
  let left = 2166136261;
  let right = 2246822507;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    left = Math.imul(left ^ code, 16777619);
    right = Math.imul(right ^ code, 3266489909);
  }
  return [left, right]
    .map((part) => (part >>> 0).toString(16).padStart(8, "0"))
    .join("");
}

function average(values: number[]) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}
