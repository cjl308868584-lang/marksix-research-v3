import type { Draw, GameId } from "./lottery";
import {
  enumerateRollingEvents,
  evaluateRollingEvent,
  rollingEventBaseline,
} from "./rolling-pattern-events";
import {
  benjaminiHochberg,
  poissonBinomialUpperTail,
} from "./rolling-pattern-statistics";
import {
  ROLLING_PATTERN_ENGINE_VERSION,
  type RollingPatternAntecedent,
  type RollingPatternCondition,
  type RollingPatternConditionEvidence,
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
  currentTriggered: true;
  currentEvidence: RollingPatternConditionEvidence[];
  support: number;
  hits: number;
  rawRate: number;
  baseline: number;
  rawUplift: number;
  posteriorRate: number;
  posteriorUplift: number;
  pValue: number;
  stateHistory: RollingPatternEventState[];
  audit: RollingPatternTriggerAudit[];
};

type EventStateIndex = Map<string, RollingPatternEventState[]>;

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
  const events = enumerateRollingEvents(input.expectedDrawAt);
  const states = indexEventStates(events, chronological);
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
  const generatedRules = generateRules(events);
  const currentEvaluations: RuleEvaluation[] = [];
  for (const rule of generatedRules) {
    const currentEvidence = evidenceAt(states, states.size ? WINDOW_SIZE : 0, rule);
    if (!currentEvidence) continue;
    currentEvaluations.push(evaluateRule(
      rule,
      states,
      input.expectedDrawAt,
      currentEvidence,
    ));
  }
  const grouped = new Map<string, RuleEvaluation[]>();
  for (const evaluation of currentEvaluations) {
    const group = grouped.get(evaluation.rule.canonicalJson) ?? [];
    group.push(evaluation);
    grouped.set(evaluation.rule.canonicalJson, group);
  }
  const deduplicated = [...grouped.values()].map((group) => ({
    ...group[0],
    relatedRuleCount: group.length,
  }));
  const testable = deduplicated.filter((item) => item.support >= MIN_SUPPORT);
  const corrected = benjaminiHochberg(testable, (item) => item.pValue);
  const aboveBaseline = deduplicated.filter((item) => item.rawRate > item.baseline);
  const qualified = corrected.filter((item) =>
    item.rawUplift >= MIN_RAW_UPLIFT && item.posteriorUplift > 0
  );
  const signals: RollingPatternSignal[] = qualified
    .map((item) => ({
      rule: item.rule,
      currentTriggered: true as const,
      currentEvidence: item.currentEvidence,
      support: item.support,
      hits: item.hits,
      rawRate: item.rawRate,
      baseline: item.baseline,
      rawUplift: item.rawUplift,
      posteriorRate: item.posteriorRate,
      posteriorUplift: item.posteriorUplift,
      pValue: item.pValue,
      qValue: item.qValue,
      evidenceTier: item.qValue <= 0.10 ? "strong" as const : "experimental" as const,
      sampleLabel: sampleLabel(item.support),
      relatedRuleCount: item.relatedRuleCount,
      stateHistory: item.stateHistory,
      audit: item.audit,
    }))
    .sort((left, right) =>
      Number(right.evidenceTier === "strong") - Number(left.evidenceTier === "strong") ||
      right.posteriorUplift - left.posteriorUplift ||
      right.support - left.support ||
      left.rule.ruleId.localeCompare(right.rule.ruleId)
    );
  const runHash = await stablePatternHash([
    input.game,
    input.targetIssue,
    windowDataHash,
    ROLLING_PATTERN_ENGINE_VERSION,
  ].join(":"));
  return {
    schemaVersion: "rolling-patterns-2",
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
      currentTriggered: currentEvaluations.length,
      deduplicated: deduplicated.length,
      aboveBaseline: aboveBaseline.length,
      qualified: signals.length,
    },
    signals,
  };
}

function indexEventStates(events: RollingPatternEvent[], draws: Draw[]) {
  return new Map(events.map((event) => [
    event.eventId,
    draws.map((draw) => evaluateRollingEvent(draw, event)),
  ]));
}

function generateRules(events: RollingPatternEvent[]) {
  const candidates: Array<{
    family: RollingPatternRuleFamily;
    antecedent: RollingPatternAntecedent;
    event: RollingPatternEvent;
  }> = [];
  for (const source of events) {
    for (const target of events) {
      if (source.eventId === target.eventId) continue;
      candidates.push({
        family: "single_transfer",
        antecedent: {
          kind: "single",
          conditions: [{ event: source, expectedMatched: true }],
        },
        event: target,
      });
    }
  }
  for (let leftIndex = 0; leftIndex < events.length; leftIndex += 1) {
    const left = events[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < events.length; rightIndex += 1) {
      const right = events[rightIndex];
      if (left.family === right.family) continue;
      for (const target of events) {
        if (target.eventId === left.eventId || target.eventId === right.eventId) continue;
        candidates.push({
          family: "conjunction_transfer",
          antecedent: {
            kind: "conjunction",
            conditions: [
              { event: left, expectedMatched: true },
              { event: right, expectedMatched: true },
            ],
          },
          event: target,
        });
      }
    }
  }
  for (const event of events) {
    for (let length = 2; length <= 5; length += 1) {
      for (let mask = 0; mask < 2 ** length; mask += 1) {
        const sequence = Array.from(
          { length },
          (_, index) => Boolean(mask & (1 << (length - index - 1))),
        );
        candidates.push({
          family: "sequence_transition",
          antecedent: {
            kind: "sequence",
            event,
            states: sequence,
            requireBoundaryFlip: sequence.every((state) => state === sequence[0]),
          },
          event,
        });
      }
    }
  }
  return candidates.map(finalizeRule);
}

function finalizeRule(candidate: {
  family: RollingPatternRuleFamily;
  antecedent: RollingPatternAntecedent;
  event: RollingPatternEvent;
}): RollingPatternRule {
  const canonicalJson = JSON.stringify({
    engineVersion: ROLLING_PATTERN_ENGINE_VERSION,
    family: candidate.family,
    antecedent: canonicalAntecedent(candidate.antecedent),
    resultEventId: candidate.event.eventId,
  });
  const conditionLabel = describeAntecedent(candidate.antecedent);
  const predictionLabel = candidate.event.label;
  const relationLabel = `当${conditionLabel}时 → ${predictionLabel}`;
  return {
    ...candidate,
    prediction: true,
    canonicalJson,
    ruleId: `r30_${stablePatternHashSync(canonicalJson)}`,
    conditionLabel,
    predictionLabel,
    relationLabel,
    description: relationLabel,
  };
}

function canonicalAntecedent(antecedent: RollingPatternAntecedent) {
  if (antecedent.kind === "sequence") {
    return {
      kind: antecedent.kind,
      eventId: antecedent.event.eventId,
      states: antecedent.states,
      requireBoundaryFlip: antecedent.requireBoundaryFlip,
    };
  }
  return {
    kind: antecedent.kind,
    conditions: antecedent.conditions.map((condition) => ({
      eventId: condition.event.eventId,
      expectedMatched: condition.expectedMatched,
    })),
  };
}

function describeAntecedent(antecedent: RollingPatternAntecedent) {
  if (antecedent.kind === "single") {
    return `本期${eventPhrase(antecedent.conditions[0].event)}`;
  }
  if (antecedent.kind === "conjunction") {
    return `本期同时${eventPhrase(antecedent.conditions[0].event)}，并且${eventPhrase(antecedent.conditions[1].event)}`;
  }
  const allMatched = antecedent.states.every(Boolean);
  const allMissed = antecedent.states.every((state) => !state);
  if (allMatched) {
    return `最近连续${antecedent.states.length}期均${eventPhrase(antecedent.event)}`;
  }
  if (allMissed) {
    if (antecedent.event.family === "wave" || antecedent.event.family === "head") {
      return `最近连续${antecedent.states.length}期${antecedent.event.value}均未达到${antecedent.event.threshold}个`;
    }
    return `最近连续${antecedent.states.length}期未出现${antecedent.event.value}`;
  }
  return `最近${antecedent.states.length}期“${eventPhrase(antecedent.event)}”状态依次为${antecedent.states.map((state) => state ? "出现" : "未出现").join("→")}`;
}

function eventPhrase(event: RollingPatternEvent) {
  if (event.family === "wave" || event.family === "head") {
    return `6+1达到至少${event.threshold}个${event.value}`;
  }
  return `6+1至少出现一次${event.value}`;
}

function evaluateRule(
  rule: RollingPatternRule,
  states: EventStateIndex,
  expectedDrawAt: string,
  currentEvidence: RollingPatternConditionEvidence[],
): RuleEvaluation {
  const audit: RollingPatternTriggerAudit[] = [];
  const baselines: number[] = [];
  const targetStates = requiredStates(states, rule.event);
  for (let targetIndex = 1; targetIndex < WINDOW_SIZE; targetIndex += 1) {
    const conditionEvidence = evidenceAt(states, targetIndex, rule);
    if (!conditionEvidence) continue;
    const result = targetStates[targetIndex];
    audit.push({
      sourceIssue: conditionEvidence.at(-1)?.issue ?? "",
      targetIssue: result.issue,
      targetDrawAt: result.drawAt,
      conditionEvidence,
      result,
      matched: result.matched,
    });
    baselines.push(rollingEventBaseline(rule.event, result.drawAt));
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
    currentTriggered: true,
    currentEvidence,
    support,
    hits,
    rawRate,
    baseline,
    rawUplift: rawRate - baseline,
    posteriorRate,
    posteriorUplift: posteriorRate - baseline,
    pValue: poissonBinomialUpperTail(baselines, hits),
    stateHistory: targetStates,
    audit,
  };
}

function evidenceAt(
  states: EventStateIndex,
  targetIndex: number,
  rule: RollingPatternRule,
): RollingPatternConditionEvidence[] | null {
  const antecedent = rule.antecedent;
  if (antecedent.kind === "single" || antecedent.kind === "conjunction") {
    const sourceIndex = targetIndex - 1;
    if (sourceIndex < 0) return null;
    const evidence = antecedent.conditions.map((condition) =>
      conditionEvidence(requiredStates(states, condition.event)[sourceIndex], condition)
    );
    return evidence.every((item) => item.actualMatched === item.expectedMatched)
      ? evidence
      : null;
  }
  const length = antecedent.states.length;
  const start = targetIndex - length;
  if (start < 0) return null;
  const eventStates = requiredStates(states, antecedent.event);
  const observed = eventStates.slice(start, targetIndex);
  if (observed.length !== length || !observed.every((state, index) =>
    state.matched === antecedent.states[index]
  )) return null;
  if (antecedent.requireBoundaryFlip) {
    const boundary = eventStates[start - 1];
    if (!boundary || boundary.matched === antecedent.states[0]) return null;
  }
  return observed.map((state, index) => conditionEvidence(state, {
    event: antecedent.event,
    expectedMatched: antecedent.states[index],
  }));
}

function conditionEvidence(
  state: RollingPatternEventState,
  condition: RollingPatternCondition,
): RollingPatternConditionEvidence {
  return {
    issue: state.issue,
    drawAt: state.drawAt,
    eventId: condition.event.eventId,
    eventLabel: eventPhrase(condition.event),
    expectedMatched: condition.expectedMatched,
    actualMatched: state.matched,
    count: state.count,
  };
}

function requiredStates(states: EventStateIndex, event: RollingPatternEvent) {
  const values = states.get(event.eventId);
  if (!values) throw new Error(`missing event states for ${event.eventId}`);
  return values;
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
