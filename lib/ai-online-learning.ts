import type { GameId } from "./lottery.ts";
import type {
  AiObservationId,
  AiScenarioId,
} from "./ai-types.ts";
import { getZodiac, ZODIAC_NAMES } from "./zodiac.ts";

type Wave = "red" | "blue" | "green";

const RED_WAVE = new Set([
  1, 2, 7, 8, 12, 13, 18, 19, 23, 24, 29, 30, 34, 35, 40, 45, 46,
]);
const BLUE_WAVE = new Set([
  3, 4, 9, 10, 14, 15, 20, 25, 26, 31, 36, 37, 41, 42, 47, 48,
]);
const WAVE_LABEL: Record<Wave, string> = {
  red: "红波",
  blue: "蓝波",
  green: "绿波",
};

export const ONLINE_LEARNING_POLICY = {
  minimumTargetIssues: 12,
  priorStrength: 36,
  maximumAdjustment: 0.06,
  liftToWeightScale: 0.4,
  maximumRows: 365,
  maximumVariantsPerIssue: 5,
} as const;

const SCENARIO_IDS = [
  "balanced",
  "momentum",
  "contrarian",
] as const satisfies readonly AiScenarioId[];

const OBSERVATION_IDS = [
  "zodiac_coverage",
  "tail_coverage",
  "wave_threshold",
  "parity_majority",
  "size_majority",
] as const satisfies readonly AiObservationId[];

export type LearningObservationPrediction = {
  id: AiObservationId;
  pick: string;
};

export type LearningScenarioPrediction = {
  id: AiScenarioId;
  observations: LearningObservationPrediction[];
};

export type SettledForecastLearningSample = {
  game: GameId;
  targetIssue: string;
  expectedDrawAt: string;
  lockedAt: string;
  settledAt: string;
  algorithmVersion: string;
  schemaVersion: string;
  responseMode: "ai";
  responseStatus: "ok";
  canonicalConfiguration: boolean;
  primaryScenarioId: AiScenarioId | null;
  scenarios: LearningScenarioPrediction[];
  actual: {
    issue: string;
    drawAt: string;
    numbers: number[];
    special: number;
    verified: true;
  };
};

export type OnlineLearningInput = {
  asOf: string;
  samples: SettledForecastLearningSample[];
  sourceStatus?: OnlineLearningSourceStatus;
};

export type OnlineLearningSourceStatus = "ok" | "unavailable";

export type SettledForecastLearningState = {
  samples: SettledForecastLearningSample[];
  sourceStatus: OnlineLearningSourceStatus;
};

export type OnlineLearningWeight = {
  weight: number;
  sampleSize: number;
  eventCount: number;
  observedRate: number;
  baselineRate: number;
  shrunkenLift: number;
  status:
    | "inactive_small_sample"
    | "neutral"
    | "upweighted"
    | "downweighted";
  explanation: string;
};

export type OnlineLearningProfile = {
  method: "verified_settled_empirical_bayes_v1";
  game: GameId;
  asOf: string;
  sourceStatus: OnlineLearningSourceStatus;
  applied: boolean;
  active: boolean;
  sampleSize: number;
  minimumSamples: number;
  receivedSampleCount: number;
  eligibleSampleCount: number;
  deduplicatedIssueCount: number;
  excludedSampleCount: number;
  lineages: string[];
  policy: typeof ONLINE_LEARNING_POLICY;
  scenarioWeights: Record<AiScenarioId, OnlineLearningWeight>;
  observationWeights: Record<AiObservationId, OnlineLearningWeight>;
  scenarioObservationWeights: Record<
    AiScenarioId,
    Record<AiObservationId, OnlineLearningWeight>
  >;
  directionWeights: Record<string, OnlineLearningWeight>;
  preferredScenarioId: AiScenarioId | null;
  lastReview: {
    issue: string;
    expectedDrawAt: string;
    actualDrawAt: string;
    settledAt: string;
    scenarioId: AiScenarioId;
    observations: Array<{
      id: AiObservationId;
      label: string;
      pick: string;
      hit: boolean;
    }>;
    actual: number[];
  } | null;
  safeguards: string[];
  conclusion: string;
  explanations: string[];
};

type LearningEvent = {
  issue: string;
  scenarioId: AiScenarioId;
  observationId: AiObservationId;
  pick: string;
  hit: number;
  baseline: number;
};

type LearningUnit = {
  issue: string;
  observed: number;
  baseline: number;
  eventCount: number;
};

type LearningLedgerRow = {
  forecast_id: string;
  game: string;
  target_issue: string;
  expected_draw_at: string;
  analysis_cutoff_at: string;
  window_size: number;
  focus: string;
  algorithm_version: string;
  schema_version: string;
  response_mode: string;
  response_status: string;
  prediction_json: string;
  locked_at: string;
  actual_issue: string;
  actual_draw_at: string;
  actual_numbers_json: string;
  actual_special: number;
  actual_verified: number | boolean;
  settled_at: string;
};

const runtime = globalThis as typeof globalThis & {
  __marksixD1?: D1Database;
};

export async function readSettledForecastLearningSamples(
  game: GameId,
  asOf: string,
): Promise<SettledForecastLearningSample[]> {
  return (await readSettledForecastLearningState(game, asOf)).samples;
}

export async function readSettledForecastLearningState(
  game: GameId,
  asOf: string,
): Promise<SettledForecastLearningState> {
  const db = runtime.__marksixD1;
  const asOfTime = Date.parse(asOf);
  if (!db || !Number.isFinite(asOfTime)) {
    return { samples: [], sourceStatus: "unavailable" };
  }
  try {
    const rows = await db.prepare(
      `WITH compatible AS (
         SELECT forecast_id, game, target_issue, expected_draw_at,
                analysis_cutoff_at, window_size, focus, algorithm_version,
                schema_version,
                json_extract(response_json, '$.mode') AS response_mode,
                json_extract(response_json, '$.status') AS response_status,
                json_object(
                  'primaryScenarioId',
                  json_extract(
                    response_json,
                    '$.zodiacObservation.scenarioId'
                  ),
                  'scenarios',
                  json((
                    SELECT json_group_array(
                      json_object(
                        'id', json_extract(candidate.value, '$.id'),
                        'observations', json((
                          SELECT json_group_array(
                            json_object(
                              'id',
                              json_extract(observation.value, '$.id'),
                              'pick',
                              json_extract(observation.value, '$.pick')
                            )
                          )
                          FROM json_each(
                            candidate.value,
                            '$.observations'
                          ) AS observation
                        ))
                      )
                    )
                    FROM json_each(
                      response_json,
                      '$.candidateSets'
                    ) AS candidate
                  ))
                ) AS prediction_json,
                locked_at,
                json_extract(actual_json, '$.issue') AS actual_issue,
                json_extract(actual_json, '$.drawAt') AS actual_draw_at,
                json_extract(actual_json, '$.numbers') AS actual_numbers_json,
                json_extract(actual_json, '$.special') AS actual_special,
                json_extract(actual_json, '$.verified') AS actual_verified,
                settled_at,
                ROW_NUMBER() OVER (
                  PARTITION BY game, target_issue
                  ORDER BY
                    locked_at ASC,
                    CASE
                      WHEN focus = 'comprehensive' AND window_size = 30
                      THEN 0 ELSE 1
                    END,
                    CAST(schema_version AS INTEGER) DESC,
                    forecast_id ASC
                ) AS target_rank
         FROM ai_forecast_ledger
         WHERE game = ?
           AND settled_at IS NOT NULL
           AND actual_json IS NOT NULL
           AND expected_draw_at < ?
           AND settled_at <= ?
           AND schema_version IN ('4', '5')
           AND (
             algorithm_version LIKE 'forecast-engine-v4%'
             OR algorithm_version LIKE 'forecast-engine-v5%'
           )
           AND response_json LIKE '%"zodiac_coverage"%'
           AND response_json LIKE '%"tail_coverage"%'
           AND response_json LIKE '%"wave_threshold"%'
           AND response_json LIKE '%"parity_majority"%'
           AND response_json LIKE '%"size_majority"%'
           AND json_valid(response_json) = 1
           AND json_extract(response_json, '$.mode') = 'ai'
           AND json_extract(response_json, '$.status') = 'ok'
           AND json_array_length(
             json_extract(response_json, '$.candidateSets')
           ) = 3
           AND json_valid(actual_json) = 1
           AND json_extract(actual_json, '$.verified') = 1
           AND json_extract(actual_json, '$.issue') = target_issue
       )
       SELECT forecast_id, game, target_issue, expected_draw_at,
              analysis_cutoff_at, window_size, focus, algorithm_version,
              schema_version, response_mode, response_status,
              prediction_json, locked_at, actual_issue, actual_draw_at,
              actual_numbers_json, actual_special, actual_verified,
              settled_at
       FROM compatible
       WHERE target_rank <= ?
       ORDER BY expected_draw_at DESC, locked_at ASC
       LIMIT ?`,
    )
      .bind(
        game,
        asOf,
        asOf,
        ONLINE_LEARNING_POLICY.maximumVariantsPerIssue,
        ONLINE_LEARNING_POLICY.maximumRows *
          ONLINE_LEARNING_POLICY.maximumVariantsPerIssue,
      )
      .all<LearningLedgerRow>();
    const parsed = (rows.results ?? [])
      .map(parseLearningLedgerRow)
      .filter(
        (sample): sample is SettledForecastLearningSample =>
          sample !== null,
      );
    return {
      samples: deduplicateSamples(
        parsed.filter((sample) => isEligibleSample(sample, game, asOf)),
      ).slice(0, ONLINE_LEARNING_POLICY.maximumRows),
      sourceStatus: "ok",
    };
  } catch {
    return { samples: [], sourceStatus: "unavailable" };
  }
}

export function buildOnlineLearningProfile(
  game: GameId,
  input: OnlineLearningInput | null | undefined,
): OnlineLearningProfile {
  const asOf = input?.asOf ?? "";
  const sourceStatus = input?.sourceStatus ?? (input ? "ok" : "unavailable");
  const received = input?.samples ?? [];
  const eligible =
    sourceStatus === "ok"
      ? received.filter((sample) =>
        isEligibleSample(sample, game, asOf),
      )
      : [];
  const deduplicated = deduplicateSamples(eligible).slice(
    0,
    ONLINE_LEARNING_POLICY.maximumRows,
  );
  const events = deduplicated.flatMap(buildLearningEvents);

  const scenarioWeights = Object.fromEntries(
    SCENARIO_IDS.map((scenarioId) => [
      scenarioId,
      buildWeight(
        aggregateEvents(
          events.filter((event) => event.scenarioId === scenarioId),
        ),
        `策略「${scenarioLabel(scenarioId)}」`,
        sourceStatus,
      ),
    ]),
  ) as OnlineLearningProfile["scenarioWeights"];

  const observationWeights = Object.fromEntries(
    OBSERVATION_IDS.map((observationId) => [
      observationId,
      buildWeight(
        aggregateEvents(
          events.filter(
            (event) => event.observationId === observationId,
          ),
        ),
        `观察「${observationLabel(observationId)}」`,
        sourceStatus,
      ),
    ]),
  ) as OnlineLearningProfile["observationWeights"];

  const scenarioObservationWeights = Object.fromEntries(
    SCENARIO_IDS.map((scenarioId) => [
      scenarioId,
      Object.fromEntries(
        OBSERVATION_IDS.map((observationId) => [
          observationId,
          buildWeight(
            aggregateEvents(
              events.filter(
                (event) =>
                  event.scenarioId === scenarioId &&
                  event.observationId === observationId,
              ),
            ),
            `${scenarioLabel(scenarioId)} · ${observationLabel(observationId)}`,
            sourceStatus,
          ),
        ]),
      ),
    ]),
  ) as OnlineLearningProfile["scenarioObservationWeights"];

  const directionWeights = Object.fromEntries(
    [...new Set(events.map((event) => directionKey(
      event.observationId,
      event.pick,
    )))].map((key) => [
      key,
      buildWeight(
        aggregateEvents(
          events.filter(
            (event) =>
              directionKey(event.observationId, event.pick) === key,
          ),
        ),
        `方向「${key.split(":").slice(1).join(":")}」`,
        sourceStatus,
      ),
    ]),
  );

  const rankedScenarios = [...SCENARIO_IDS].sort(
    (left, right) =>
      scenarioWeights[right].weight - scenarioWeights[left].weight ||
      SCENARIO_IDS.indexOf(left) - SCENARIO_IDS.indexOf(right),
  );
  const active =
    sourceStatus === "ok" &&
    deduplicated.length >= ONLINE_LEARNING_POLICY.minimumTargetIssues;
  const scenarioApplied = Object.values(scenarioWeights).some(
    (weight) =>
      weight.status === "upweighted" ||
      weight.status === "downweighted",
  );
  const directionApplied = Object.values(directionWeights).some(
    (weight) =>
      weight.status === "upweighted" ||
      weight.status === "downweighted",
  );
  const applied =
    sourceStatus === "ok" && (scenarioApplied || directionApplied);
  const preferredScenarioId =
    sourceStatus === "ok" && scenarioApplied
      ? rankedScenarios[0]
      : null;
  const excludedSampleCount = received.length - deduplicated.length;
  const lineages = [...new Set(
    deduplicated.map(
      (sample) => `${sample.algorithmVersion} / schema ${sample.schemaVersion}`,
    ),
  )].sort();
  const lastReview = buildLastReview(deduplicated);
  const safeguards = [
    "只接受 actual.verified=true 且 settledAt 不晚于本次 asOf 的不可变开奖前快照。",
    "按彩种与目标期去重，先限定兼容 lineage，再固定使用最早锁定记录；规范配置与 schema 仅在同一锁定时刻作稳定裁决。",
    `少于 ${ONLINE_LEARNING_POLICY.minimumTargetIssues} 个独立目标期时不调整权重。`,
    `经验表现向精确随机基线收缩 ${ONLINE_LEARNING_POLICY.priorStrength} 期，权重限制在 ${(1 - ONLINE_LEARNING_POLICY.maximumAdjustment).toFixed(2)}–${(1 + ONLINE_LEARNING_POLICY.maximumAdjustment).toFixed(2)}。`,
    "在线学习不参与历史 walk-forward 重算，也不能修改正式 backtest.status。",
    "若正式独立留出已通过优势门槛，主观察固定使用该回测实际验证的未调权方向；在线层仅保留为旁路复盘。",
    "学习库不可用时不把故障解释为 0 样本，并强制关闭全部在线调权。",
  ];
  const conclusion =
    sourceStatus === "unavailable"
      ? "在线学习库暂不可用，本期不读取历史权重、不执行在线调权；正式独立回测仍照常计算。"
      : applied
        ? preferredScenarioId
          ? `已用 ${deduplicated.length} 个独立已结算目标期做保守复盘；当前优先展示${scenarioLabel(preferredScenarioId)}，单项权重最多调整 ${Math.round(ONLINE_LEARNING_POLICY.maximumAdjustment * 100)}%。`
          : `已用 ${deduplicated.length} 个独立已结算目标期做保守复盘；方向权重已生效，三路策略排序保持不变。`
        : deduplicated.length < ONLINE_LEARNING_POLICY.minimumTargetIssues
          ? `当前仅有 ${deduplicated.length}/${ONLINE_LEARNING_POLICY.minimumTargetIssues} 个独立已结算目标期，继续记录但暂不调权。`
          : "已达到样本门槛，但收缩后的表现接近随机基线，本期不调整候选顺序。";

  return {
    method: "verified_settled_empirical_bayes_v1",
    game,
    asOf,
    sourceStatus,
    applied,
    active,
    sampleSize: deduplicated.length,
    minimumSamples: ONLINE_LEARNING_POLICY.minimumTargetIssues,
    receivedSampleCount: received.length,
    eligibleSampleCount: eligible.length,
    deduplicatedIssueCount: deduplicated.length,
    excludedSampleCount,
    lineages,
    policy: ONLINE_LEARNING_POLICY,
    scenarioWeights,
    observationWeights,
    scenarioObservationWeights,
    directionWeights,
    preferredScenarioId,
    lastReview,
    safeguards,
    conclusion,
    explanations: [
      `仅纳入 ${deduplicated.length} 个已核验、已结算且早于本次截止时间的独立目标期。`,
      "同一目标期只保留一份快照，先限定兼容 lineage，再取最早的开奖前锁定记录；规范配置与 schema 仅用于同刻裁决。",
      `只学习兼容的 v4/v5 五维快照；当前样本 lineage：${lineages.join("、") || "暂无"}。`,
      `少于 ${ONLINE_LEARNING_POLICY.minimumTargetIssues} 个独立目标期时权重固定为 1.000，不参与调序。`,
      `权重以随机基线为先验并加入 ${ONLINE_LEARNING_POLICY.priorStrength} 期收缩，单次调整绝对值不超过 ${Math.round(ONLINE_LEARNING_POLICY.maximumAdjustment * 100)}%。`,
      "在线权重只影响下一期方向分组与候选展示顺序，不回写历史回测，也不改变独立留出显著性结论。",
    ],
  };
}

export function onlineDirectionWeight(
  profile: OnlineLearningProfile,
  observationId: AiObservationId,
  pick: string,
) {
  const learned = profile.directionWeights[
    directionKey(observationId, pick)
  ];
  return learned?.status === "upweighted" ||
    learned?.status === "downweighted"
    ? learned.weight
    : 1;
}

function parseLearningLedgerRow(
  row: LearningLedgerRow,
): SettledForecastLearningSample | null {
  const prediction = parseJson(row.prediction_json) as {
    primaryScenarioId?: unknown;
    scenarios?: unknown;
  } | null;
  const actualNumbers = parseJson(row.actual_numbers_json);
  if (
    row.response_mode !== "ai" ||
    row.response_status !== "ok" ||
    row.game !== "hk" &&
    row.game !== "new_macau" &&
    row.game !== "macau"
  ) {
    return null;
  }
  if (
    row.actual_verified !== true &&
      row.actual_verified !== 1 ||
    typeof row.actual_issue !== "string" ||
    row.actual_issue !== row.target_issue ||
    typeof row.actual_draw_at !== "string" ||
    !isValidNumbers(actualNumbers, 6) ||
    !isValidNumber(row.actual_special) ||
    actualNumbers.includes(row.actual_special)
  ) {
    return null;
  }
  const scenarios = parseScenarioPredictions(prediction?.scenarios);
  if (
    scenarios.length !== SCENARIO_IDS.length ||
    scenarios.some(
      (scenario) =>
        new Set(
          scenario.observations.map((observation) => observation.id),
        ).size !== OBSERVATION_IDS.length,
    )
  ) {
    return null;
  }
  return {
    game: row.game,
    targetIssue: row.target_issue,
    expectedDrawAt: row.expected_draw_at,
    lockedAt: row.locked_at || row.analysis_cutoff_at,
    settledAt: row.settled_at,
    algorithmVersion: row.algorithm_version,
    schemaVersion: row.schema_version,
    responseMode: "ai",
    responseStatus: "ok",
    canonicalConfiguration:
      row.focus === "comprehensive" && Number(row.window_size) === 30,
    primaryScenarioId: isScenarioId(
      prediction?.primaryScenarioId,
    )
      ? prediction.primaryScenarioId
      : null,
    scenarios,
    actual: {
      issue: row.actual_issue,
      drawAt: row.actual_draw_at,
      numbers: actualNumbers,
      special: row.actual_special,
      verified: true,
    },
  };
}

function parseScenarioPredictions(value: unknown): LearningScenarioPrediction[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<AiScenarioId>();
  return value.flatMap((item) => {
    if (!isRecord(item) || !isScenarioId(item.id) || seen.has(item.id)) {
      return [];
    }
    const observations = Array.isArray(item.observations)
      ? item.observations.flatMap((observation) => {
        if (
          !isRecord(observation) ||
          !isObservationId(observation.id) ||
          typeof observation.pick !== "string"
        ) {
          return [];
        }
        return [{
          id: observation.id,
          pick: observation.pick,
        }];
      })
      : [];
    if (observations.length === 0) return [];
    seen.add(item.id);
    return [{ id: item.id, observations }];
  });
}

function isEligibleSample(
  sample: SettledForecastLearningSample,
  game: GameId,
  asOf: string,
) {
  const asOfTime = Date.parse(asOf);
  const expectedTime = Date.parse(sample.expectedDrawAt);
  const lockedTime = Date.parse(sample.lockedAt);
  const settledTime = Date.parse(sample.settledAt);
  const actualTime = Date.parse(sample.actual.drawAt);
  return (
    Number.isFinite(asOfTime) &&
    sample.game === game &&
    sample.actual.verified === true &&
    sample.responseMode === "ai" &&
    sample.responseStatus === "ok" &&
    sample.actual.issue === sample.targetIssue &&
    /^\d+$/.test(sample.targetIssue) &&
    isCompatibleLineage(sample) &&
    Number.isFinite(expectedTime) &&
    Number.isFinite(lockedTime) &&
    Number.isFinite(settledTime) &&
    Number.isFinite(actualTime) &&
    lockedTime < expectedTime &&
    expectedTime < asOfTime &&
    expectedTime <= actualTime &&
    actualTime <= settledTime &&
    actualTime < asOfTime &&
    settledTime <= asOfTime &&
    isValidNumbers(sample.actual.numbers, 6) &&
    isValidNumber(sample.actual.special) &&
    !sample.actual.numbers.includes(sample.actual.special) &&
    sample.scenarios.length === SCENARIO_IDS.length &&
    buildLearningEvents(sample).length ===
      SCENARIO_IDS.length * OBSERVATION_IDS.length
  );
}

function deduplicateSamples(
  samples: SettledForecastLearningSample[],
) {
  const selected = new Map<string, SettledForecastLearningSample>();
  samples.forEach((sample) => {
    const key = `${sample.game}:${sample.targetIssue}`;
    const current = selected.get(key);
    if (!current || compareSamplePreference(sample, current) < 0) {
      selected.set(key, sample);
    }
  });
  return [...selected.values()].sort(
    (left, right) =>
      Date.parse(right.expectedDrawAt) - Date.parse(left.expectedDrawAt) ||
      right.targetIssue.localeCompare(left.targetIssue, "en", {
        numeric: true,
      }) ||
      left.lockedAt.localeCompare(right.lockedAt),
  );
}

function compareSamplePreference(
  left: SettledForecastLearningSample,
  right: SettledForecastLearningSample,
) {
  return (
    left.lockedAt.localeCompare(right.lockedAt) ||
    Number(right.canonicalConfiguration) -
      Number(left.canonicalConfiguration) ||
    Number(right.schemaVersion) - Number(left.schemaVersion) ||
    stableSampleKey(left).localeCompare(stableSampleKey(right))
  );
}

function isCompatibleLineage(sample: SettledForecastLearningSample) {
  return (
    (sample.schemaVersion === "4" || sample.schemaVersion === "5") &&
    (
      sample.algorithmVersion.startsWith("forecast-engine-v4") ||
      sample.algorithmVersion.startsWith("forecast-engine-v5")
    )
  );
}

function buildLearningEvents(
  sample: SettledForecastLearningSample,
): LearningEvent[] {
  const actualNumbers = [...sample.actual.numbers, sample.actual.special];
  return sample.scenarios.flatMap((scenario) => {
    const seen = new Set<AiObservationId>();
    return scenario.observations.flatMap((observation) => {
      if (seen.has(observation.id)) return [];
      seen.add(observation.id);
      const result = settleObservation(
        observation,
        sample.actual.drawAt,
        actualNumbers,
      );
      if (!result) return [];
      return [{
        issue: sample.targetIssue,
        scenarioId: scenario.id,
        observationId: observation.id,
        pick: observation.pick,
        hit: Number(result.hit),
        baseline: result.baseline,
      }];
    });
  });
}

function buildLastReview(
  samples: SettledForecastLearningSample[],
): OnlineLearningProfile["lastReview"] {
  const latest = [...samples].sort(
    (left, right) =>
      Date.parse(right.expectedDrawAt) - Date.parse(left.expectedDrawAt) ||
      right.targetIssue.localeCompare(left.targetIssue, "en", {
        numeric: true,
      }),
  )[0];
  if (!latest) return null;
  const scenario =
    latest.scenarios.find(
      (candidate) => candidate.id === latest.primaryScenarioId,
    ) ??
    latest.scenarios.find((candidate) => candidate.id === "balanced") ??
    latest.scenarios[0];
  if (!scenario) return null;
  const actual = [...latest.actual.numbers, latest.actual.special];
  const seen = new Set<AiObservationId>();
  const observations = scenario.observations.flatMap((observation) => {
    if (seen.has(observation.id)) return [];
    seen.add(observation.id);
    const result = settleObservation(
      observation,
      latest.actual.drawAt,
      actual,
    );
    if (!result) return [];
    return [{
      id: observation.id,
      label: observationLabel(observation.id),
      pick: observation.pick,
      hit: result.hit,
    }];
  });
  return {
    issue: latest.targetIssue,
    expectedDrawAt: latest.expectedDrawAt,
    actualDrawAt: latest.actual.drawAt,
    settledAt: latest.settledAt,
    scenarioId: scenario.id,
    observations,
    actual,
  };
}

function settleObservation(
  observation: LearningObservationPrediction,
  drawAt: string,
  numbers: number[],
): { hit: boolean; baseline: number } | null {
  if (observation.id === "zodiac_coverage") {
    if (!ZODIAC_NAMES.includes(observation.pick as (typeof ZODIAC_NAMES)[number])) {
      return null;
    }
    const matches = (number: number) =>
      getZodiac(number, drawAt) === observation.pick;
    return eventResult(numbers, matches, 1);
  }
  if (observation.id === "tail_coverage") {
    const match = observation.pick.match(/^([0-9])尾$/);
    if (!match) return null;
    const tail = Number(match[1]);
    return eventResult(numbers, (number) => number % 10 === tail, 1);
  }
  if (observation.id === "wave_threshold") {
    const wave = (Object.entries(WAVE_LABEL) as Array<[Wave, string]>)
      .find(([, label]) => label === observation.pick)?.[0];
    if (!wave) return null;
    return eventResult(numbers, (number) => getWave(number) === wave, 3);
  }
  if (observation.id === "parity_majority") {
    if (observation.pick !== "奇数" && observation.pick !== "偶数") return null;
    return eventResult(
      numbers,
      (number) =>
        observation.pick === "奇数"
          ? number % 2 === 1
          : number % 2 === 0,
      4,
    );
  }
  if (observation.pick !== "大数" && observation.pick !== "小数") return null;
  return eventResult(
    numbers,
    (number) =>
      observation.pick === "大数"
        ? number >= 25
        : number < 25,
    4,
  );
}

function eventResult(
  actualNumbers: number[],
  matches: (number: number) => boolean,
  threshold: number,
) {
  const memberCount = countPopulation(matches);
  return {
    hit:
      actualNumbers.filter((number) => matches(number)).length >= threshold,
    baseline: exactCoverageProbability(memberCount, threshold),
  };
}

function aggregateEvents(events: LearningEvent[]): LearningUnit[] {
  const grouped = new Map<
    string,
    { observed: number; baseline: number; count: number }
  >();
  events.forEach((event) => {
    const current = grouped.get(event.issue) ?? {
      observed: 0,
      baseline: 0,
      count: 0,
    };
    current.observed += event.hit;
    current.baseline += event.baseline;
    current.count += 1;
    grouped.set(event.issue, current);
  });
  return [...grouped.entries()].map(([issue, values]) => ({
    issue,
    observed: values.observed / values.count,
    baseline: values.baseline / values.count,
    eventCount: values.count,
  }));
}

function buildWeight(
  units: LearningUnit[],
  label: string,
  sourceStatus: OnlineLearningSourceStatus,
): OnlineLearningWeight {
  const sampleSize = units.length;
  const eventCount = units.reduce(
    (sum, unit) => sum + unit.eventCount,
    0,
  );
  const observedRate = average(
    units.map((unit) => unit.observed),
  );
  const baselineRate = average(
    units.map((unit) => unit.baseline),
  );
  const shrunkenLift =
    units.reduce(
      (sum, unit) => sum + unit.observed - unit.baseline,
      0,
    ) /
    (sampleSize + ONLINE_LEARNING_POLICY.priorStrength);
  const adjustment =
    sampleSize < ONLINE_LEARNING_POLICY.minimumTargetIssues
      ? 0
      : clamp(
        shrunkenLift * ONLINE_LEARNING_POLICY.liftToWeightScale,
        -ONLINE_LEARNING_POLICY.maximumAdjustment,
        ONLINE_LEARNING_POLICY.maximumAdjustment,
      );
  const weight = round4(1 + adjustment);
  const status: OnlineLearningWeight["status"] =
    sampleSize < ONLINE_LEARNING_POLICY.minimumTargetIssues
      ? "inactive_small_sample"
      : weight > 1.0025
        ? "upweighted"
        : weight < 0.9975
          ? "downweighted"
          : "neutral";
  const observedPercent = round4(observedRate * 100);
  const baselinePercent = round4(baselineRate * 100);
  return {
    weight,
    sampleSize,
    eventCount,
    observedRate: observedPercent,
    baselineRate: baselinePercent,
    shrunkenLift: round4(shrunkenLift * 100),
    status,
    explanation:
      sourceStatus === "unavailable"
        ? `${label}未调权：在线学习库暂不可用，不能把读取故障解释为真实零样本。`
        : status === "inactive_small_sample"
        ? `${label}只有 ${sampleSize} 个独立已结算目标期，未达到 ${ONLINE_LEARNING_POLICY.minimumTargetIssues} 期门槛，权重保持 1.000。`
        : `${label}在 ${sampleSize} 个独立目标期中观察率 ${observedPercent}%，精确随机基线 ${baselinePercent}%；经 ${ONLINE_LEARNING_POLICY.priorStrength} 期先验收缩后权重为 ${weight.toFixed(3)}。`,
  };
}

function exactCoverageProbability(
  memberCount: number,
  threshold: number,
) {
  const denominator = combination(49, 7);
  let probability = 0;
  for (
    let matches = threshold;
    matches <= Math.min(memberCount, 7);
    matches += 1
  ) {
    const misses = 7 - matches;
    if (misses > 49 - memberCount) continue;
    probability +=
      (combination(memberCount, matches) *
        combination(49 - memberCount, misses)) /
      denominator;
  }
  return clamp(probability, 0, 1);
}

function combination(n: number, k: number) {
  if (k < 0 || k > n) return 0;
  let value = 1;
  const safeK = Math.min(k, n - k);
  for (let index = 1; index <= safeK; index += 1) {
    value = (value * (n - safeK + index)) / index;
  }
  return value;
}

function countPopulation(matches: (number: number) => boolean) {
  let count = 0;
  for (let number = 1; number <= 49; number += 1) {
    if (matches(number)) count += 1;
  }
  return count;
}

function getWave(number: number): Wave {
  if (RED_WAVE.has(number)) return "red";
  if (BLUE_WAVE.has(number)) return "blue";
  return "green";
}

function directionKey(id: AiObservationId, pick: string) {
  return `${id}:${pick}`;
}

function stableSampleKey(sample: SettledForecastLearningSample) {
  return JSON.stringify([
    sample.expectedDrawAt,
    sample.scenarios.map((scenario) => [
      scenario.id,
      scenario.observations.map((observation) => [
        observation.id,
        observation.pick,
      ]),
    ]),
  ]);
}

function scenarioLabel(id: AiScenarioId) {
  if (id === "momentum") return "趋势延续";
  if (id === "contrarian") return "逆向遗漏";
  return "冷热平衡";
}

function observationLabel(id: AiObservationId) {
  if (id === "zodiac_coverage") return "生肖覆盖";
  if (id === "tail_coverage") return "尾数覆盖";
  if (id === "wave_threshold") return "波色至少三个";
  if (id === "parity_majority") return "单双多数";
  return "大小多数";
}

function isScenarioId(value: unknown): value is AiScenarioId {
  return typeof value === "string" &&
    SCENARIO_IDS.includes(value as AiScenarioId);
}

function isObservationId(value: unknown): value is AiObservationId {
  return typeof value === "string" &&
    OBSERVATION_IDS.includes(value as AiObservationId);
}

function isValidNumber(value: unknown): value is number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 49;
}

function isValidNumbers(value: unknown, count: number): value is number[] {
  return Array.isArray(value) &&
    value.length === count &&
    value.every(isValidNumber) &&
    new Set(value).size === count;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function average(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) /
    Math.max(values.length, 1);
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

function round4(value: number) {
  return Math.round(value * 10_000) / 10_000;
}
