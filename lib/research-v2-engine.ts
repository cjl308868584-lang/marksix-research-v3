import {
  formatBall,
  getWave,
  getZodiac,
  type Draw,
  type GameId,
} from "./lottery";
import { ZODIAC_NAMES } from "./zodiac";
import {
  MODEL_VERSION,
  RESEARCH_ENGINE_VERSION,
  RESEARCH_SCHEMA_VERSION,
  RULE_ENGINE_VERSION,
  type ResearchDataQuality,
  type ResearchEvidenceTier,
  type ResearchProbability,
  type ResearchRuleDirection,
  type ResearchRuleEvidence,
  type ResearchRuleSpec,
  type ResearchSnapshot,
  type ResearchTargetFamily,
  type ResearchTargetForecast,
  type ResearchTargetId,
  type ResearchTargetScope,
  type RuleField,
  type RuleTransform,
} from "./research-v2-types";

const RULE_PRIOR_STRENGTH = 20;
const MIN_RULE_SUPPORT = 30;
const MIN_EXPECTED_HITS = 5;
const MAX_FULL_RULES_PER_FAMILY = 500;
const EXPLORATORY_ALPHA = 0.2;
const CHALLENGER_Q = 0.1;
const OFFSET_VALUES = Array.from({ length: 24 }, (_, index) =>
  index < 12 ? index - 12 : index - 11,
).filter((value) => value !== 0);
const RULE_LAGS = [1, 2, 3, 4, 5] as const;
const FIELDS = [
  "special",
  "main.1",
  "main.2",
  "main.3",
  "main.4",
  "main.5",
  "main.6",
] as const satisfies readonly RuleField[];
const POSITION_SCOPES = [
  "special",
  "main.position.1",
  "main.position.2",
  "main.position.3",
  "main.position.4",
  "main.position.5",
  "main.position.6",
] as const;
const FAMILIES = [
  "number",
  "zodiac",
  "wave",
  "tail",
  "parity",
  "size",
  "zone",
] as const satisfies readonly ResearchTargetFamily[];

type RuleObservation = {
  issue: string;
  prediction: string;
  actual: string;
  hit: boolean;
  baseline: number;
};

type TargetDefinition = {
  targetId: ResearchTargetId;
  label: string;
  scope: ResearchTargetScope;
  family: ResearchTargetFamily;
};

export function buildResearchSnapshot({
  game,
  draws,
  targetIssue,
  expectedDrawAt,
  generatedAt = new Date().toISOString(),
  previous = null,
}: {
  game: GameId;
  draws: Draw[];
  targetIssue: string;
  expectedDrawAt: string;
  generatedAt?: string;
  previous?: ResearchSnapshot | null;
}): ResearchSnapshot {
  const chronological = [...draws]
    .filter(isResearchDraw)
    .sort(
      (left, right) =>
        Date.parse(left.drawAt) - Date.parse(right.drawAt) ||
        left.issue.localeCompare(right.issue, "en", { numeric: true }),
    );
  const dataQuality = buildDataQuality(game, chronological);
  const specs = generateRuleSpecs();
  const evaluated = specs.map((spec) => evaluateRule(spec, chronological));
  const capped = applyResourceCaps(evaluated);
  const corrected = applyFalseDiscoveryRate(capped);
  const selected = corrected
    .filter((rule) => rule.resourceDecision === "full_backtest")
    .sort(compareRuleEvidence);
  const negativeRules = corrected
    .filter((rule) => rule.resourceDecision === "negative_pool")
    .sort(compareRuleEvidence)
    .slice(0, 24);
  const experimentalRules = selectDiversifiedRules(
    selected.filter(
      (rule) => rule.tier === "challenger" || rule.tier === "experimental",
    ),
    36,
  );
  const verifiedRules = corrected
    .filter((rule) => rule.tier === "verified")
    .sort(compareRuleEvidence);
  const forecastRules = [...verifiedRules, ...experimentalRules, ...negativeRules];
  const targetForecasts = buildTargetForecasts({
    chronological,
    expectedDrawAt,
    rules: forecastRules,
    previous,
  });
  const fullBacktestRuleCount = corrected.filter(
    (rule) =>
      rule.resourceDecision === "full_backtest" ||
      rule.resourceDecision === "negative_pool",
  ).length;
  const runSeed = JSON.stringify([
    game,
    targetIssue,
    expectedDrawAt,
    dataQuality.datasetVersion,
    RULE_ENGINE_VERSION,
    MODEL_VERSION,
  ]);
  const evidenceTier: ResearchEvidenceTier = verifiedRules.length
    ? "verified"
    : experimentalRules.some((rule) => rule.tier === "challenger")
      ? "challenger"
      : experimentalRules.length
        ? "experimental"
        : "baseline";
  const snapshot: ResearchSnapshot = {
    schemaVersion: RESEARCH_SCHEMA_VERSION,
    engineVersion: RESEARCH_ENGINE_VERSION,
    ruleEngineVersion: RULE_ENGINE_VERSION,
    modelVersion: MODEL_VERSION,
    runId: `rv2_${stableHash(runSeed)}`,
    game,
    targetIssue,
    expectedDrawAt,
    generatedAt,
    mode: "shadow",
    evidenceTier,
    dataQuality,
    targetForecasts,
    verifiedRules,
    experimentalRules,
    negativeRules,
    archivedRuleCount: corrected.filter(
      (rule) =>
        rule.resourceDecision !== "full_backtest" &&
        rule.resourceDecision !== "negative_pool",
    ).length,
    generatedRuleCount: specs.length,
    fullBacktestRuleCount,
    resourceReductionRate: round6(
      1 - fullBacktestRuleCount / Math.max(specs.length, 1),
    ),
    modelComparison: [
      {
        id: "uniform",
        label: "精确随机基线",
        role: "baseline",
        status: "active",
        window: null,
        brierSkill: 0,
        logLossSkill: 0,
        sampleSize: chronological.length,
        note: "正式预测的永久锚点；没有已验证优势时保持基线概率。",
      },
      {
        id: "interpretable_fast",
        label: "可解释快线",
        role: "interpretable",
        status: "shadow",
        window: 20,
        brierSkill: averageFinite(
          experimentalRules.slice(0, 12).map((rule) => rule.brierSkill),
        ),
        logLossSkill: null,
        sampleSize: Math.min(20, chronological.length),
        note: "关注最近20期，只在研究层显示。",
      },
      {
        id: "interpretable_medium",
        label: "可解释中线",
        role: "interpretable",
        status: "shadow",
        window: 80,
        brierSkill: averageFinite(
          experimentalRules.slice(0, 24).map((rule) => rule.brierSkill),
        ),
        logLossSkill: null,
        sampleSize: Math.min(80, chronological.length),
        note: "使用最近80期，降低单期开奖冲击。",
      },
      {
        id: "interpretable_slow",
        label: "可解释慢线",
        role: "interpretable",
        status: "shadow",
        window: null,
        brierSkill: averageFinite(
          experimentalRules.map((rule) => rule.brierSkill),
        ),
        logLossSkill: null,
        sampleSize: chronological.length,
        note: "使用全部历史，负责长期稳定性。",
      },
      {
        id: "black_box",
        label: "黑盒挑战轨",
        role: "challenger",
        status:
          dataQuality.formalSampleSize >= 2_000
            ? "shadow"
            : "blocked_insufficient_data",
        window: null,
        brierSkill: null,
        logLossSkill: null,
        sampleSize: dataQuality.formalSampleSize,
        note:
          dataQuality.formalSampleSize >= 2_000
            ? "达到数据门槛，仍须独立前瞻验证。"
            : "高质量样本不足2000期，不允许深度模型影响正式预测。",
      },
    ],
    previousForecastDelta: buildPreviousDelta(targetForecasts, previous),
    postmortem: buildPostmortem(chronological, previous, generatedAt),
    notice:
      "v2当前以影子模式运行。正式概率只允许已验证规律参与；历史候选仅在研究实验室展示。",
  };
  return snapshot;
}

export function generateRuleSpecs(): ResearchRuleSpec[] {
  const specs: ResearchRuleSpec[] = [];
  for (const targetScope of POSITION_SCOPES) {
    for (const family of FAMILIES) {
      for (const sourceField of FIELDS) {
        for (const lag of RULE_LAGS) {
          specs.push({
            schemaVersion: 1,
            family: "position_transfer",
            target: { scope: targetScope, family },
            source: {
              field: sourceField,
              lag,
              family,
              transform: "identity",
            },
            predicates: [],
          });
        }
      }
    }
  }
  for (const targetScope of POSITION_SCOPES) {
    for (const sourceField of FIELDS) {
      for (const lag of RULE_LAGS) {
        const transforms: RuleTransform[] = [
          "mirror",
          ...OFFSET_VALUES.map(
            (offset) => `offset.${offset}` as RuleTransform,
          ),
        ];
        for (const transform of transforms) {
          specs.push({
            schemaVersion: 1,
            family: "number_transform",
            target: { scope: targetScope, family: "number" },
            source: {
              field: sourceField,
              lag,
              family: "number",
              transform,
            },
            predicates: [],
          });
        }
      }
    }
  }
  const conditionFamilies = FAMILIES.filter(
    (family) => family !== "number",
  );
  for (const family of conditionFamilies) {
    for (const value of familyValues(family, new Date().toISOString())) {
      for (let position = 1; position <= 6; position += 1) {
        specs.push({
          schemaVersion: 1,
          family: "conditional_transfer",
          target: { scope: "special", family },
          source: {
            field: `main.${position}` as RuleField,
            lag: 1,
            family,
            transform: "identity",
          },
          predicates: [
            {
              field: "special",
              lag: 1,
              family,
              operator: "equals",
              value,
            },
          ],
        });
      }
    }
  }
  return deduplicateSpecs(specs);
}

export function canonicalRuleJson(spec: ResearchRuleSpec): string {
  const predicates = [...spec.predicates].sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );
  return JSON.stringify({
    schemaVersion: spec.schemaVersion,
    family: spec.family,
    target: spec.target,
    source: spec.source,
    predicates,
  });
}

export function ruleId(spec: ResearchRuleSpec): string {
  return `rule_${stableHash(canonicalRuleJson(spec))}`;
}

export function evaluateResearchRule(
  spec: ResearchRuleSpec,
  draws: Draw[],
): ResearchRuleEvidence {
  const chronological = [...draws]
    .filter(isResearchDraw)
    .sort(
      (left, right) =>
        Date.parse(left.drawAt) - Date.parse(right.drawAt) ||
        left.issue.localeCompare(right.issue, "en", { numeric: true }),
    );
  return evaluateRule(spec, chronological);
}

function evaluateRule(
  spec: ResearchRuleSpec,
  draws: Draw[],
): ResearchRuleEvidence {
  const observations: RuleObservation[] = [];
  const minimumIndex = Math.max(
    spec.source.lag,
    ...spec.predicates.map((predicate) => predicate.lag),
  );
  for (let index = minimumIndex; index < draws.length; index += 1) {
    const prediction = predictRule(spec, draws, index, draws[index].drawAt);
    if (prediction === null) continue;
    const actual = targetValue(spec, draws[index]);
    if (actual === null) continue;
    const baseline = baselineForTarget(
      spec.target.scope,
      spec.target.family,
      prediction,
      draws[index].drawAt,
    );
    observations.push({
      issue: draws[index].issue,
      prediction,
      actual,
      hit: prediction === actual,
      baseline,
    });
  }
  const support = observations.length;
  const hits = observations.filter((observation) => observation.hit).length;
  const baselineRate = averageFinite(
    observations.map((observation) => observation.baseline),
  ) ?? baselineForTarget(
    spec.target.scope,
    spec.target.family,
    defaultValue(spec.target.family, new Date().toISOString()),
    new Date().toISOString(),
  );
  const hitRate = hits / Math.max(support, 1);
  const shrunkenRate =
    (hits + RULE_PRIOR_STRENGTH * baselineRate) /
    Math.max(support + RULE_PRIOR_STRENGTH, 1);
  const direction: ResearchRuleDirection =
    hitRate > baselineRate
      ? "positive"
      : hitRate < baselineRate
        ? "negative"
        : "neutral";
  const expectedHits = support * baselineRate;
  const hasSupport =
    support >= MIN_RULE_SUPPORT && expectedHits >= MIN_EXPECTED_HITS;
  const upperP = binomialTail(support, hits, baselineRate, "upper");
  const lowerP = binomialTail(support, hits, baselineRate, "lower");
  const pValue =
    direction === "positive"
      ? upperP
      : direction === "negative"
        ? lowerP
        : 1;
  const rolling = rollingRuleScore(observations, baselineRate);
  let resourceDecision: ResearchRuleEvidence["resourceDecision"];
  if (!hasSupport) {
    resourceDecision = "insufficient_support";
  } else if (direction === "positive" && pValue <= EXPLORATORY_ALPHA) {
    resourceDecision = "full_backtest";
  } else if (direction === "negative" && pValue <= EXPLORATORY_ALPHA) {
    resourceDecision = "negative_pool";
  } else {
    resourceDecision = "not_above_baseline";
  }
  return {
    ruleId: ruleId(spec),
    family: spec.family,
    description: describeRule(spec),
    direction,
    tier: hasSupport ? "archived" : "insufficient",
    targetId: `${spec.target.scope}.${spec.target.family}`,
    support,
    hits,
    hitRate: round6(hitRate),
    baselineRate: round6(baselineRate),
    shrunkenRate: round6(shrunkenRate),
    lift: round6(shrunkenRate - baselineRate),
    brierSkill: rolling.brierSkill,
    nonWorseFoldRatio: rolling.nonWorseFoldRatio,
    pValue: round6(pValue),
    qValue: 1,
    stabilityScore: rolling.stabilityScore,
    resourceDecision,
    spec,
  };
}

function applyResourceCaps(
  rules: ResearchRuleEvidence[],
): ResearchRuleEvidence[] {
  const groups = new Map<string, ResearchRuleEvidence[]>();
  for (const rule of rules) {
    if (
      rule.resourceDecision !== "full_backtest" &&
      rule.resourceDecision !== "negative_pool"
    ) {
      continue;
    }
    const key = `${rule.targetId}:${rule.family}:${rule.direction}`;
    groups.set(key, [...(groups.get(key) ?? []), rule]);
  }
  const allowed = new Set<string>();
  groups.forEach((group) => {
    group
      .sort(compareRuleEvidence)
      .slice(0, MAX_FULL_RULES_PER_FAMILY)
      .forEach((rule) => allowed.add(rule.ruleId));
  });
  const globalLimit = Math.max(1, Math.floor(rules.length * 0.05));
  const globallyAllowed = new Set(
    rules
      .filter((rule) => allowed.has(rule.ruleId))
      .sort(compareRuleEvidence)
      .slice(0, globalLimit)
      .map((rule) => rule.ruleId),
  );
  return rules.map((rule) =>
    (
      rule.resourceDecision === "full_backtest" ||
      rule.resourceDecision === "negative_pool"
    ) &&
    (!allowed.has(rule.ruleId) || !globallyAllowed.has(rule.ruleId))
      ? {
        ...rule,
        resourceDecision: "archived_by_cap",
        tier: "archived",
      }
      : rule,
  );
}

function applyFalseDiscoveryRate(
  rules: ResearchRuleEvidence[],
): ResearchRuleEvidence[] {
  const eligible = rules
    .filter(
      (rule) =>
        rule.resourceDecision === "full_backtest" ||
        rule.resourceDecision === "negative_pool",
    )
    .sort((left, right) => left.pValue - right.pValue);
  const qById = new Map<string, number>();
  let running = 1;
  for (let index = eligible.length - 1; index >= 0; index -= 1) {
    const adjusted = Math.min(
      1,
      (eligible[index].pValue * eligible.length) / (index + 1),
    );
    running = Math.min(running, adjusted);
    qById.set(eligible[index].ruleId, running);
  }
  return rules.map((rule) => {
    const qValue = round6(qById.get(rule.ruleId) ?? 1);
    let tier = rule.tier;
    if (
      rule.resourceDecision === "full_backtest" ||
      rule.resourceDecision === "negative_pool"
    ) {
      tier =
        qValue <= CHALLENGER_Q &&
        rule.brierSkill > 0 &&
        rule.nonWorseFoldRatio >= 0.7
          ? "challenger"
          : "experimental";
    }
    return { ...rule, qValue, tier };
  });
}

function buildTargetForecasts({
  chronological,
  expectedDrawAt,
  rules,
  previous,
}: {
  chronological: Draw[];
  expectedDrawAt: string;
  rules: ResearchRuleEvidence[];
  previous: ResearchSnapshot | null;
}): ResearchTargetForecast[] {
  const definitions = targetDefinitions();
  return definitions.map((definition) => {
    const values = familyValues(definition.family, expectedDrawAt);
    const previousTarget = previous?.targetForecasts.find(
      (target) => target.targetId === definition.targetId,
    );
    const firingRules = rules.filter(
      (rule) =>
        rule.targetId === definition.targetId &&
        predictRule(rule.spec, chronological, chronological.length, expectedDrawAt) !==
          null,
    );
    const formalProbabilities = values.map((value) => {
      const baseline = baselineForTarget(
        definition.scope,
        definition.family,
        value,
        expectedDrawAt,
      );
      const previousProbability =
        previousTarget?.formalProbabilities.find(
          (probability) => probability.value === value,
        )?.probability ?? baseline;
      return probabilityItem(
        definition.family,
        value,
        baseline,
        baseline,
        previousProbability,
      );
    });
    const experimentalProbabilities = adjustedProbabilities({
      definition,
      values,
      expectedDrawAt,
      chronological,
      rules: firingRules,
      previousTarget,
    });
    const ranked = [...experimentalProbabilities].sort(
      (left, right) =>
        right.probability - left.probability ||
        left.value.localeCompare(right.value, "en", { numeric: true }),
    );
    const activeRuleIds = firingRules.map((rule) => rule.ruleId);
    const tier: ResearchEvidenceTier = firingRules.some(
      (rule) => rule.tier === "verified",
    )
      ? "verified"
      : firingRules.some((rule) => rule.tier === "challenger")
        ? "challenger"
        : firingRules.length
          ? "experimental"
          : "baseline";
    return {
      ...definition,
      evidenceTier: tier,
      formalProbabilities,
      experimentalProbabilities,
      top1: ranked[0]?.value ?? "",
      top3: ranked.slice(0, 3).map((probability) => probability.value),
      activeRuleIds,
      conclusion:
        tier === "verified"
          ? "已有前瞻验证规律参与正式概率。"
          : firingRules.length
            ? `研究层有 ${firingRules.length} 条规则触发；正式层仍保持精确随机基线。`
            : "没有通过筛选且适用于本期的规律，保持精确随机基线。",
    };
  });
}

function adjustedProbabilities({
  definition,
  values,
  expectedDrawAt,
  chronological,
  rules,
  previousTarget,
}: {
  definition: TargetDefinition;
  values: string[];
  expectedDrawAt: string;
  chronological: Draw[];
  rules: ResearchRuleEvidence[];
  previousTarget: ResearchTargetForecast | undefined;
}): ResearchProbability[] {
  const independentCoverage =
    definition.scope === "main.any" ||
    definition.scope === "draw.6_plus_1";
  const scores = new Map<string, number>();
  values.forEach((value) => {
    const baseline = baselineForTarget(
      definition.scope,
      definition.family,
      value,
      expectedDrawAt,
    );
    scores.set(value, independentCoverage ? logit(baseline) : Math.log(Math.max(baseline, 1e-8)));
  });
  for (const rule of rules) {
    const prediction = predictRule(
      rule.spec,
      chronological,
      chronological.length,
      expectedDrawAt,
    );
    if (prediction === null || !scores.has(prediction)) continue;
    const evidenceWeight =
      clamp(Math.abs(rule.lift) / Math.max(rule.baselineRate, 0.02), 0, 0.5) *
      clamp(rule.stabilityScore, 0.1, 1) *
      clamp(1 - rule.qValue, 0.1, 1);
    const signed =
      rule.direction === "negative" ? -evidenceWeight : evidenceWeight;
    scores.set(prediction, (scores.get(prediction) ?? 0) + signed);
  }
  const adjusted = new Map<string, number>();
  if (independentCoverage) {
    scores.forEach((score, value) => adjusted.set(value, sigmoid(score)));
  } else {
    const maximum = Math.max(...scores.values());
    const exponentials = [...scores.entries()].map(([value, score]) => [
      value,
      Math.exp(score - maximum),
    ] as const);
    const total = exponentials.reduce((sum, [, value]) => sum + value, 0);
    exponentials.forEach(([value, score]) =>
      adjusted.set(value, score / Math.max(total, 1e-12)),
    );
  }
  return values.map((value) => {
    const baseline = baselineForTarget(
      definition.scope,
      definition.family,
      value,
      expectedDrawAt,
    );
    const probability = adjusted.get(value) ?? baseline;
    const previousProbability =
      previousTarget?.experimentalProbabilities.find(
        (item) => item.value === value,
      )?.probability ?? baseline;
    return probabilityItem(
      definition.family,
      value,
      probability,
      baseline,
      previousProbability,
    );
  });
}

function predictRule(
  spec: ResearchRuleSpec,
  draws: Draw[],
  targetIndex: number,
  targetDrawAt: string,
): string | null {
  for (const predicate of spec.predicates) {
    const predicateDraw = draws[targetIndex - predicate.lag];
    if (!predicateDraw) return null;
    const number = fieldNumber(predicateDraw, predicate.field);
    if (
      number === null ||
      categoryValue(predicate.family, number, predicateDraw.drawAt) !==
        predicate.value
    ) {
      return null;
    }
  }
  const sourceDraw = draws[targetIndex - spec.source.lag];
  if (!sourceDraw) return null;
  const sourceNumber = fieldNumber(sourceDraw, spec.source.field);
  if (sourceNumber === null) return null;
  if (spec.source.family === "number") {
    const transformed = transformNumber(sourceNumber, spec.source.transform);
    return transformed === null ? null : String(transformed);
  }
  return categoryValue(spec.source.family, sourceNumber, targetDrawAt);
}

function targetValue(spec: ResearchRuleSpec, draw: Draw): string | null {
  const field = scopeToField(spec.target.scope);
  const number = fieldNumber(draw, field);
  return number === null
    ? null
    : categoryValue(spec.target.family, number, draw.drawAt);
}

function rollingRuleScore(
  observations: RuleObservation[],
  baselineRate: number,
): {
  brierSkill: number;
  nonWorseFoldRatio: number;
  stabilityScore: number;
} {
  if (observations.length < MIN_RULE_SUPPORT) {
    return { brierSkill: 0, nonWorseFoldRatio: 0, stabilityScore: 0 };
  }
  const initial = Math.max(10, Math.floor(observations.length * 0.4));
  const remaining = observations.length - initial;
  const foldSize = Math.max(1, Math.floor(remaining / 5));
  const skills: number[] = [];
  for (let fold = 0; fold < 5; fold += 1) {
    const start = initial + fold * foldSize;
    const end =
      fold === 4
        ? observations.length
        : Math.min(observations.length, start + foldSize);
    if (start >= end) continue;
    const train = observations.slice(0, start);
    const test = observations.slice(start, end);
    const trainHits = train.filter((observation) => observation.hit).length;
    const probability =
      (trainHits + RULE_PRIOR_STRENGTH * baselineRate) /
      (train.length + RULE_PRIOR_STRENGTH);
    const modelBrier = averageFinite(
      test.map((observation) =>
        square(probability - Number(observation.hit)),
      ),
    ) ?? 0;
    const baselineBrier = averageFinite(
      test.map((observation) =>
        square(observation.baseline - Number(observation.hit)),
      ),
    ) ?? 0;
    skills.push(
      baselineBrier > 0 ? 1 - modelBrier / baselineBrier : 0,
    );
  }
  const brierSkill = averageFinite(skills) ?? 0;
  const nonWorseFoldRatio =
    skills.filter((skill) => skill >= 0).length / Math.max(skills.length, 1);
  const dispersion = Math.sqrt(
    averageFinite(skills.map((skill) => square(skill - brierSkill))) ?? 0,
  );
  return {
    brierSkill: round6(brierSkill),
    nonWorseFoldRatio: round6(nonWorseFoldRatio),
    stabilityScore: round6(clamp(1 - dispersion, 0, 1)),
  };
}

function buildDataQuality(
  game: GameId,
  draws: Draw[],
): ResearchDataQuality {
  const formal = draws.filter((draw) => draw.verified);
  const sourceGrade =
    draws.length > 0 && formal.length === draws.length
      ? "official_verified"
      : formal.length > 0
        ? "multi_source_consistent"
        : "single_source_unverified";
  const seed = JSON.stringify(
    draws.map((draw) => [
      draw.game,
      draw.issue,
      draw.drawAt,
      ...draw.numbers,
      draw.special,
      draw.source,
      draw.verified,
    ]),
  );
  const warnings = [
    draws.length < 200
      ? "历史不足200期，大多数精确号码规律只能作为探索假设。"
      : null,
    formal.length === 0
      ? `${game === "hk" ? "香港" : "新澳门"}历史尚无可用于正式验证的核验样本。`
      : null,
  ].filter((warning): warning is string => Boolean(warning));
  return {
    sampleSize: draws.length,
    formalSampleSize: formal.length,
    sourceGrade,
    datasetVersion: `data_${stableHash(seed)}`,
    verifiedRatio: round6(formal.length / Math.max(draws.length, 1)),
    oldestIssue: draws[0]?.issue ?? null,
    newestIssue: draws.at(-1)?.issue ?? null,
    warnings,
  };
}

function buildPreviousDelta(
  targets: ResearchTargetForecast[],
  previous: ResearchSnapshot | null,
): ResearchSnapshot["previousForecastDelta"] {
  if (!previous) {
    return {
      comparable: false,
      largestChanges: [],
      summary: "尚无上一期同版本冻结预测，无法计算变化。",
    };
  }
  const changes = targets.flatMap((target) => {
    const previousTarget = previous.targetForecasts.find(
      (item) => item.targetId === target.targetId,
    );
    if (!previousTarget) return [];
    return target.experimentalProbabilities.map((probability) => {
      const before = previousTarget.experimentalProbabilities.find(
        (item) => item.value === probability.value,
      )?.probability ?? probability.baseline;
      return {
        targetId: target.targetId,
        value: probability.value,
        delta: round6(probability.probability - before),
      };
    });
  });
  const largestChanges = changes
    .sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta))
    .slice(0, 8);
  return {
    comparable: true,
    largestChanges,
    summary: largestChanges.length
      ? "逐期开奖只做有证据的渐进更新；变化最大的方向已列出。"
      : "规则与数据未产生可测变化。",
  };
}

function buildPostmortem(
  draws: Draw[],
  previous: ResearchSnapshot | null,
  settledAt: string,
): ResearchSnapshot["postmortem"] {
  const latest = draws.at(-1);
  if (!latest || !previous || previous.targetIssue !== latest.issue) return null;
  const target = previous.targetForecasts.find(
    (forecast) => forecast.targetId === "special.zodiac",
  );
  const actualZodiac = getZodiac(latest.special, latest.drawAt);
  const actualProbability =
    target?.experimentalProbabilities.find(
      (probability) => probability.value === actualZodiac,
    )?.probability ?? null;
  const top = target?.top1 ?? null;
  const active = new Set(target?.activeRuleIds ?? []);
  const previousRules = [
    ...previous.verifiedRules,
    ...previous.experimentalRules,
    ...previous.negativeRules,
  ].filter((rule) => active.has(rule.ruleId));
  const ruleHits = previousRules.filter(() => top === actualZodiac).length;
  return {
    settledIssue: latest.issue,
    settledAt,
    actualSpecial: latest.special,
    actualSpecialZodiac: actualZodiac,
    previousTopSpecialZodiac: top,
    previousActualProbability: actualProbability,
    ruleHits,
    ruleMisses: Math.max(previousRules.length - ruleHits, 0),
    summary:
      top === actualZodiac
        ? "上一期研究层首选生肖命中，但单次命中只做小幅增量奖励。"
        : "上一期研究层首选未命中；系统按实际结果概率处罚过度自信，不追开出生肖。",
    nextAction:
      previousRules.length > 0
        ? "更新触发规则的滚动评分，连续失效才会显著降权或退役。"
        : "保持随机基线，等待更多可核验前瞻样本。",
  };
}

function targetDefinitions(): TargetDefinition[] {
  const definitions: TargetDefinition[] = [];
  for (const scope of POSITION_SCOPES) {
    for (const family of FAMILIES) {
      definitions.push({
        targetId: `${scope}.${family}`,
        label: `${scopeLabel(scope)}${familyLabel(family)}`,
        scope,
        family,
      });
    }
  }
  for (const scope of ["main.any", "draw.6_plus_1"] as const) {
    for (const family of FAMILIES) {
      definitions.push({
        targetId: `${scope}.${family}`,
        label: `${scopeLabel(scope)}${familyLabel(family)}覆盖`,
        scope,
        family,
      });
    }
  }
  return definitions;
}

function baselineForTarget(
  scope: ResearchTargetScope,
  family: ResearchTargetFamily,
  value: string,
  drawAt: string,
): number {
  const memberCount = numbersForFamilyValue(family, value, drawAt).length;
  if (scope === "draw.6_plus_1") {
    return hypergeometricCoverage(memberCount, 7);
  }
  if (scope === "main.any") {
    return hypergeometricCoverage(memberCount, 6);
  }
  return memberCount / 49;
}

function hypergeometricCoverage(memberCount: number, drawCount: number) {
  if (memberCount <= 0) return 0;
  if (memberCount >= 49 - drawCount + 1) return 1;
  let miss = 1;
  for (let index = 0; index < drawCount; index += 1) {
    miss *= (49 - memberCount - index) / (49 - index);
  }
  return 1 - miss;
}

function numbersForFamilyValue(
  family: ResearchTargetFamily,
  value: string,
  drawAt: string,
): number[] {
  return Array.from({ length: 49 }, (_, index) => index + 1).filter(
    (number) => categoryValue(family, number, drawAt) === value,
  );
}

function familyValues(
  family: ResearchTargetFamily,
  drawAt: string,
): string[] {
  if (family === "number") {
    return Array.from({ length: 49 }, (_, index) => String(index + 1));
  }
  if (family === "zodiac") return [...ZODIAC_NAMES];
  if (family === "wave") return ["红波", "蓝波", "绿波"];
  if (family === "tail") {
    return Array.from({ length: 10 }, (_, index) => `${index}尾`);
  }
  if (family === "parity") return ["单", "双"];
  if (family === "size") return ["小", "大"];
  if (family === "zone") return ["一区", "二区", "三区"];
  return [defaultValue(family, drawAt)];
}

function defaultValue(
  family: ResearchTargetFamily,
  drawAt: string,
): string {
  return familyValues(family, drawAt)[0] ?? "";
}

function categoryValue(
  family: ResearchTargetFamily,
  number: number,
  drawAt: string,
): string {
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

function fieldNumber(draw: Draw, field: RuleField): number | null {
  if (field === "special") return draw.special;
  const position = Number(field.split(".")[1]);
  return draw.numbers[position - 1] ?? null;
}

function scopeToField(
  scope: Exclude<ResearchTargetScope, "main.any" | "draw.6_plus_1">,
): RuleField {
  if (scope === "special") return "special";
  return `main.${scope.split(".")[2]}` as RuleField;
}

function transformNumber(
  number: number,
  transform: RuleTransform,
): number | null {
  if (transform === "identity") return number;
  if (transform === "mirror") return 50 - number;
  const offset = Number(transform.split(".")[1]);
  if (!Number.isInteger(offset)) return null;
  return ((number - 1 + offset) % 49 + 49) % 49 + 1;
}

function probabilityItem(
  family: ResearchTargetFamily,
  value: string,
  probability: number,
  baseline: number,
  previous: number,
): ResearchProbability {
  return {
    value,
    label: family === "number" ? formatBall(Number(value)) : value,
    probability: round6(probability),
    baseline: round6(baseline),
    deltaPrevious: round6(probability - previous),
  };
}

function describeRule(spec: ResearchRuleSpec): string {
  const lag = `前${spec.source.lag}期`;
  const source = fieldLabel(spec.source.field);
  const target = `${scopeLabel(spec.target.scope)}${familyLabel(spec.target.family)}`;
  const prediction =
    spec.source.transform === "identity"
      ? `${source}${familyLabel(spec.source.family)}传导到${target}`
      : spec.source.transform === "mirror"
        ? `${source}镜像号传导到${target}`
        : `${source}${transformLabel(spec.source.transform)}传导到${target}`;
  const condition = spec.predicates
    .map(
      (predicate) =>
        `前${predicate.lag}期${fieldLabel(predicate.field)}${familyLabel(predicate.family)}为${predicate.value}`,
    )
    .join("且");
  return condition ? `若${condition}，则用${lag}${prediction}` : `用${lag}${prediction}`;
}

function fieldLabel(field: RuleField): string {
  return field === "special" ? "特码" : `第${field.split(".")[1]}正码`;
}

function scopeLabel(scope: ResearchTargetScope): string {
  if (scope === "special") return "下期特码";
  if (scope === "main.any") return "下期6正码";
  if (scope === "draw.6_plus_1") return "下期6+1";
  return `下期第${scope.split(".")[2]}正码`;
}

function familyLabel(family: ResearchTargetFamily): string {
  const labels: Record<ResearchTargetFamily, string> = {
    number: "号码",
    zodiac: "生肖",
    wave: "波色",
    tail: "尾数",
    parity: "单双",
    size: "大小",
    zone: "区间",
  };
  return labels[family];
}

function transformLabel(transform: RuleTransform): string {
  if (!transform.startsWith("offset.")) return "";
  const value = Number(transform.split(".")[1]);
  return value >= 0 ? `加${value}` : `减${Math.abs(value)}`;
}

function deduplicateSpecs(specs: ResearchRuleSpec[]): ResearchRuleSpec[] {
  return [
    ...new Map(
      specs.map((spec) => [canonicalRuleJson(spec), spec]),
    ).values(),
  ];
}

function compareRuleEvidence(
  left: ResearchRuleEvidence,
  right: ResearchRuleEvidence,
) {
  return (
    tierRank(right.tier) - tierRank(left.tier) ||
    right.brierSkill - left.brierSkill ||
    right.stabilityScore - left.stabilityScore ||
    right.support - left.support ||
    left.ruleId.localeCompare(right.ruleId)
  );
}

function selectDiversifiedRules(
  rules: ResearchRuleEvidence[],
  limit: number,
): ResearchRuleEvidence[] {
  const selected: ResearchRuleEvidence[] = [];
  const seen = new Set<string>();
  const familyBuckets = new Map<string, ResearchRuleEvidence[]>();
  rules.forEach((rule) => {
    const key = `${rule.family}:${rule.spec.target.family}`;
    familyBuckets.set(key, [...(familyBuckets.get(key) ?? []), rule]);
  });
  familyBuckets.forEach((bucket) => {
    bucket.slice(0, 2).forEach((rule) => {
      if (selected.length < limit && !seen.has(rule.ruleId)) {
        seen.add(rule.ruleId);
        selected.push(rule);
      }
    });
  });
  for (const family of [
    "conditional_transfer",
    "position_transfer",
    "number_transform",
  ] as const) {
    rules
      .filter((rule) => rule.family === family)
      .slice(0, Math.ceil(limit / 3))
      .forEach((rule) => {
        if (!seen.has(rule.ruleId)) {
          seen.add(rule.ruleId);
          selected.push(rule);
        }
      });
  }
  for (const rule of rules) {
    if (selected.length >= limit) break;
    if (!seen.has(rule.ruleId)) {
      seen.add(rule.ruleId);
      selected.push(rule);
    }
  }
  return selected.slice(0, limit);
}

function tierRank(tier: ResearchEvidenceTier) {
  const ranks: Record<ResearchEvidenceTier, number> = {
    baseline: 0,
    insufficient: 1,
    archived: 2,
    experimental: 3,
    challenger: 4,
    verified: 5,
  };
  return ranks[tier];
}

function binomialTail(
  n: number,
  k: number,
  probability: number,
  direction: "upper" | "lower",
): number {
  if (n <= 0) return 1;
  const start = direction === "upper" ? k : 0;
  const end = direction === "upper" ? n : k;
  let total = 0;
  for (let hits = start; hits <= end; hits += 1) {
    total += Math.exp(
      logChoose(n, hits) +
      hits * Math.log(Math.max(probability, 1e-12)) +
      (n - hits) * Math.log(Math.max(1 - probability, 1e-12)),
    );
  }
  return clamp(total, 0, 1);
}

function logChoose(n: number, k: number): number {
  const safeK = Math.min(k, n - k);
  let total = 0;
  for (let index = 1; index <= safeK; index += 1) {
    total += Math.log(n - safeK + index) - Math.log(index);
  }
  return total;
}

function isResearchDraw(draw: Draw): boolean {
  return (
    /^\d+$/.test(draw.issue) &&
    Number.isFinite(Date.parse(draw.drawAt)) &&
    draw.numbers.length === 6 &&
    new Set([...draw.numbers, draw.special]).size === 7 &&
    [...draw.numbers, draw.special].every(
      (number) => Number.isInteger(number) && number >= 1 && number <= 49,
    )
  );
}

function stableHash(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ (code + index), 0x01000193);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}

function averageFinite(values: Array<number | null>): number | null {
  const finite = values.filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  );
  return finite.length
    ? finite.reduce((sum, value) => sum + value, 0) / finite.length
    : null;
}

function square(value: number) {
  return value * value;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function logit(value: number) {
  const safe = clamp(value, 1e-8, 1 - 1e-8);
  return Math.log(safe / (1 - safe));
}

function sigmoid(value: number) {
  return 1 / (1 + Math.exp(-value));
}

function round6(value: number) {
  return Number.isFinite(value) ? Math.round(value * 1_000_000) / 1_000_000 : 0;
}
