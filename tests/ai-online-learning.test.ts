import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createServer, type ViteDevServer } from "vite";
import {
  ONLINE_LEARNING_POLICY,
  buildOnlineLearningProfile,
  readSettledForecastLearningState,
  readSettledForecastLearningSamples,
  type LearningObservationPrediction,
  type SettledForecastLearningSample,
} from "../lib/ai-online-learning.ts";
import type { AiScenarioId } from "../lib/ai-types.ts";
import { getZodiac, ZODIAC_NAMES } from "../lib/zodiac.ts";

const SCENARIOS = [
  "balanced",
  "momentum",
  "contrarian",
] as const satisfies readonly AiScenarioId[];

const AS_OF = "2026-08-01T12:00:00.000Z";
let server: ViteDevServer;
let engine: {
  buildForecastPack: (
    game: "new_macau",
    draws: Draw[],
    focus: string,
    expectedDrawAt: string,
    evaluationHistory: Draw[],
    learning?: {
      asOf: string;
      samples: SettledForecastLearningSample[];
    },
  ) => ForecastPack;
};
let history: Draw[];

type Draw = {
  game: "new_macau";
  issue: string;
  drawAt: string;
  numbers: number[];
  special: number;
  source: string;
  verified: boolean;
};

type ForecastPack = {
  backtest: { status: string; selectedStrategyId: string | null };
  candidateSets: Array<{
    id: string;
    observations: Array<{ id: string; pick: string }>;
  }>;
  zodiacObservation: {
    scenarioId: string;
    zodiac: string;
    conclusion: string;
  };
  learning: ReturnType<typeof buildOnlineLearningProfile>;
};

before(async () => {
  server = await createServer({
    root: process.cwd(),
    configFile: false,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "silent",
  });
  engine = (await server.ssrLoadModule("/lib/ai-engine.ts")) as typeof engine;
  const lottery = (await server.ssrLoadModule("/lib/lottery.ts")) as {
    FALLBACK_DRAWS: { new_macau: Draw[] };
  };
  history = lottery.FALLBACK_DRAWS.new_macau;
});

after(async () => {
  await server.close();
});

test("少样本只记录复盘，不改变任何学习权重", () => {
  const samples = Array.from(
    { length: ONLINE_LEARNING_POLICY.minimumTargetIssues - 1 },
    (_, index) => sample(index, "contrarian"),
  );
  const profile = buildOnlineLearningProfile("new_macau", {
    asOf: AS_OF,
    samples,
  });

  assert.equal(profile.sampleSize, 11);
  assert.equal(profile.minimumSamples, 12);
  assert.equal(profile.active, false);
  assert.equal(profile.applied, false);
  assert.equal(profile.preferredScenarioId, null);
  for (const weight of Object.values(profile.scenarioWeights)) {
    assert.equal(weight.weight, 1);
    assert.equal(weight.status, "inactive_small_sample");
  }
});

test("学习库不可用不能伪装成真实零样本，也不能启用调权", async () => {
  const runtime = globalThis as typeof globalThis & {
    __marksixD1?: D1Database;
  };
  const previous = runtime.__marksixD1;
  runtime.__marksixD1 = undefined;
  try {
    const state = await readSettledForecastLearningState(
      "new_macau",
      AS_OF,
    );
    assert.deepEqual(state, {
      samples: [],
      sourceStatus: "unavailable",
    });

    const profile = buildOnlineLearningProfile("new_macau", {
      asOf: AS_OF,
      samples: Array.from(
        { length: ONLINE_LEARNING_POLICY.minimumTargetIssues },
        (_, index) => sample(index, "contrarian"),
      ),
      sourceStatus: state.sourceStatus,
    });
    assert.equal(profile.sourceStatus, "unavailable");
    assert.equal(profile.receivedSampleCount, 12);
    assert.equal(profile.eligibleSampleCount, 0);
    assert.equal(profile.sampleSize, 0);
    assert.equal(profile.active, false);
    assert.equal(profile.applied, false);
    assert.equal(profile.preferredScenarioId, null);
    assert.match(profile.conclusion, /学习库暂不可用/);
    assert.ok(
      Object.values(profile.scenarioWeights).every(
        (weight) =>
          weight.status === "inactive_small_sample" &&
          weight.weight === 1 &&
          weight.explanation.includes("学习库暂不可用"),
      ),
    );
  } finally {
    runtime.__marksixD1 = previous;
  }
});

test("按目标期去重并以收缩、封顶权重学习三策略和五类观察", () => {
  const samples = Array.from(
    { length: ONLINE_LEARNING_POLICY.minimumTargetIssues },
    (_, index) => sample(index, "contrarian"),
  );
  samples.push(sample(0, "balanced", {
    canonicalConfiguration: false,
    lockedAt: "2026-06-30T08:00:00.000Z",
  }));
  const profile = buildOnlineLearningProfile("new_macau", {
    asOf: AS_OF,
    samples,
  });

  assert.equal(profile.receivedSampleCount, 13);
  assert.equal(profile.eligibleSampleCount, 13);
  assert.equal(profile.deduplicatedIssueCount, 12);
  assert.equal(profile.excludedSampleCount, 1);
  assert.equal(profile.active, true);
  assert.equal(profile.applied, true);
  assert.equal(profile.preferredScenarioId, "contrarian");
  assert.ok(profile.scenarioWeights.contrarian.weight > 1);
  assert.ok(profile.scenarioWeights.balanced.weight < 1);
  for (const weight of [
    ...Object.values(profile.scenarioWeights),
    ...Object.values(profile.observationWeights),
    ...Object.values(profile.directionWeights),
  ]) {
    assert.ok(weight.weight >= 0.94);
    assert.ok(weight.weight <= 1.06);
  }
  assert.equal(
    Object.keys(profile.observationWeights).length,
    5,
  );
  assert.equal(profile.lastReview?.scenarioId, "contrarian");
  assert.equal(profile.lastReview?.observations.length, 5);
  assert.ok(
    profile.lastReview?.observations.every(
      (observation) => observation.hit,
    ),
  );
  assert.equal(profile.lastReview?.actual.length, 7);
  assert.equal(
    profile.lastReview?.actualDrawAt,
    profile.lastReview?.expectedDrawAt,
  );
  assert.match(profile.conclusion, /保守复盘/);
  assert.ok(profile.safeguards.some((item) => item.includes("verified")));
});

test("未来、未核验和结算晚于截止的记录不能影响当前权重", () => {
  const past = Array.from(
    { length: ONLINE_LEARNING_POLICY.minimumTargetIssues },
    (_, index) => sample(index, "momentum"),
  );
  const baseline = buildOnlineLearningProfile("new_macau", {
    asOf: AS_OF,
    samples: past,
  });
  const future = sample(90, "balanced", {
    expectedDrawAt: "2026-08-02T13:32:00.000Z",
    settledAt: "2026-08-02T14:00:00.000Z",
  });
  const unverified = {
    ...sample(91, "balanced"),
    actual: {
      ...sample(91, "balanced").actual,
      verified: false,
    },
  } as unknown as SettledForecastLearningSample;
  const lateSettlement = sample(92, "balanced", {
    expectedDrawAt: "2026-07-30T13:32:00.000Z",
    settledAt: "2026-08-01T12:00:00.001Z",
  });
  const issueMismatch = {
    ...sample(93, "balanced"),
    actual: {
      ...sample(93, "balanced").actual,
      issue: "999999",
    },
  };
  const impossibleTimeOrder = {
    ...sample(94, "balanced"),
    actual: {
      ...sample(94, "balanced").actual,
      drawAt: "2026-06-01T13:32:00.000Z",
    },
  };
  const oldLineage = sample(95, "balanced", {
    algorithmVersion: "forecast-engine-v3.1",
    schemaVersion: "3",
  });
  const withInvalid = buildOnlineLearningProfile("new_macau", {
    asOf: AS_OF,
    samples: [
      ...past,
      future,
      unverified,
      lateSettlement,
      issueMismatch,
      impossibleTimeOrder,
      oldLineage,
    ],
  });

  assert.deepEqual(
    withInvalid.scenarioWeights,
    baseline.scenarioWeights,
  );
  assert.deepEqual(
    withInvalid.observationWeights,
    baseline.observationWeights,
  );
  assert.deepEqual(withInvalid.lastReview, baseline.lastReview);
  assert.equal(withInvalid.eligibleSampleCount, past.length);
});

test("同一期永远保留最早冻结预测，不允许后发新 lineage 覆盖", () => {
  const older = sample(0, "contrarian");
  const compatibleV5 = sample(0, "balanced", {
    algorithmVersion: "forecast-engine-v5.0",
    schemaVersion: "5",
    canonicalConfiguration: false,
    lockedAt: "2026-07-01T10:00:00.000Z",
  });
  const profile = buildOnlineLearningProfile("new_macau", {
    asOf: AS_OF,
    samples: [older, compatibleV5],
  });

  assert.equal(profile.sampleSize, 1);
  assert.equal(profile.lastReview?.scenarioId, "contrarian");
  assert.deepEqual(profile.lineages, [
    "forecast-engine-v4.1 / schema 4",
  ]);
});

test("直接输入也只学习最近 365 个独立目标期", () => {
  const samples = Array.from(
    { length: ONLINE_LEARNING_POLICY.maximumRows + 1 },
    (_, index) => {
      const expectedTime =
        Date.UTC(2026, 5, 1, 0, 0) + index * 60 * 60 * 1_000;
      const expectedDrawAt = new Date(expectedTime).toISOString();
      return sample(index, "contrarian", {
        expectedDrawAt,
        lockedAt: new Date(
          expectedTime - 60 * 60 * 1_000,
        ).toISOString(),
        settledAt: new Date(
          expectedTime + 30 * 60 * 1_000,
        ).toISOString(),
        actual: {
          issue: String(2026200 + index),
          drawAt: expectedDrawAt,
          numbers: [1, 2, 7, 3, 4, 9],
          special: 25,
          verified: true,
        },
      });
    },
  );
  const profile = buildOnlineLearningProfile("new_macau", {
    asOf: AS_OF,
    samples,
  });

  assert.equal(profile.receivedSampleCount, 366);
  assert.equal(profile.eligibleSampleCount, 366);
  assert.equal(profile.sampleSize, 365);
  assert.equal(profile.deduplicatedIssueCount, 365);
  assert.equal(profile.excludedSampleCount, 1);
  assert.equal(profile.lastReview?.issue, String(2026200 + 365));
});

test("同一请求先结算、settledAt 等于 asOf 时可立即进入下一期复盘", () => {
  const equalCutoff = sample(0, "balanced", {
    settledAt: AS_OF,
  });
  const degradedVariant = {
    ...equalCutoff,
    responseStatus: "degraded",
    lockedAt: "2026-06-30T07:00:00.000Z",
  } as unknown as SettledForecastLearningSample;
  const profile = buildOnlineLearningProfile("new_macau", {
    asOf: AS_OF,
    samples: [equalCutoff],
  });
  assert.equal(profile.eligibleSampleCount, 1);
  assert.equal(profile.sampleSize, 1);

  const runtime = globalThis as typeof globalThis & {
    __marksixD1?: D1Database;
  };
  const previous = runtime.__marksixD1;
  let sqlText = "";
  let boundValues: unknown[] = [];
  runtime.__marksixD1 = {
    prepare(sql: string) {
      sqlText = sql;
      return {
        bind(...values: unknown[]) {
          boundValues = values;
          return this;
        },
        async all() {
          return {
            results: [
              ledgerRow(degradedVariant),
              ledgerRow(equalCutoff),
            ],
            success: true,
          };
        },
      };
    },
  } as unknown as D1Database;
  return readSettledForecastLearningSamples(
    "new_macau",
    AS_OF,
  ).then((samples) => {
    assert.equal(samples.length, 1);
    assert.match(sqlText, /settled_at <= \?/);
    assert.match(sqlText, /ROW_NUMBER\(\) OVER/);
    assert.match(sqlText, /PARTITION BY game, target_issue/);
    assert.ok(
      sqlText.indexOf("locked_at ASC") <
        sqlText.indexOf("CAST(schema_version AS INTEGER) DESC"),
    );
    assert.match(sqlText, /WHERE target_rank <= \?/);
    assert.match(sqlText, /schema_version IN \('4', '5'\)/);
    assert.match(sqlText, /AS prediction_json/);
    assert.match(sqlText, /AS actual_numbers_json/);
    assert.match(sqlText, /json_valid\(response_json\) = 1/);
    assert.match(
      sqlText,
      /json_extract\(response_json, '\$\.mode'\) = 'ai'/,
    );
    assert.equal(ONLINE_LEARNING_POLICY.maximumRows, 365);
    assert.deepEqual(boundValues.slice(-2), [
      ONLINE_LEARNING_POLICY.maximumVariantsPerIssue,
      ONLINE_LEARNING_POLICY.maximumRows *
        ONLINE_LEARNING_POLICY.maximumVariantsPerIssue,
    ]);
  }).finally(() => {
    runtime.__marksixD1 = previous;
  });
});

test("在线学习影响下一期主观察和候选顺序，但不改写正式回测", () => {
  const selectedWindow = history.slice(0, 30);
  const expectedDrawAt = "2026-08-02T13:32:00.000Z";
  const baseline = engine.buildForecastPack(
    "new_macau",
    selectedWindow,
    "comprehensive",
    expectedDrawAt,
    history,
  );
  assert.notEqual(baseline.backtest.status, "observed_advantage");

  const samples = Array.from(
    { length: ONLINE_LEARNING_POLICY.minimumTargetIssues },
    (_, index) => sample(index, "contrarian"),
  );
  const learned = engine.buildForecastPack(
    "new_macau",
    selectedWindow,
    "comprehensive",
    expectedDrawAt,
    history,
    { asOf: AS_OF, samples },
  );

  assert.deepEqual(learned.backtest, baseline.backtest);
  assert.equal(learned.learning.active, true);
  assert.equal(learned.learning.applied, true);
  assert.equal(learned.candidateSets[0].id, "contrarian");
  assert.equal(learned.zodiacObservation.scenarioId, "contrarian");
  assert.match(learned.zodiacObservation.conclusion, /在线复盘/);

  const postDrawCutoff = engine.buildForecastPack(
    "new_macau",
    selectedWindow,
    "comprehensive",
    expectedDrawAt,
    history,
    {
      asOf: "2026-08-03T12:00:00.000Z",
      samples,
    },
  );
  assert.equal(postDrawCutoff.learning.sampleSize, 0);
  assert.deepEqual(
    postDrawCutoff.candidateSets,
    baseline.candidateSets,
  );
  assert.deepEqual(
    postDrawCutoff.zodiacObservation,
    baseline.zodiacObservation,
  );
});

test("正式留出优势只绑定其实际验证方向，在线翻转不得继承验证标签", () => {
  const evaluationHistory = buildAlwaysCoveredHistory();
  const selectedWindow = evaluationHistory.slice(0, 30);
  const expectedDrawAt = "2026-08-02T13:32:00.000Z";
  const samples = Array.from(
    { length: ONLINE_LEARNING_POLICY.minimumTargetIssues },
    (_, index) => sample(index, "contrarian"),
  );
  const learningInput = { asOf: AS_OF, samples };
  const baseline = engine.buildForecastPack(
    "new_macau",
    selectedWindow,
    "comprehensive",
    expectedDrawAt,
    evaluationHistory,
  );
  assert.equal(baseline.backtest.status, "observed_advantage");

  // 同一学习输入在没有正式留出优势时，确实会把主方向从牛翻到马。
  const exploratoryBaseline = engine.buildForecastPack(
    "new_macau",
    selectedWindow,
    "comprehensive",
    expectedDrawAt,
    selectedWindow,
  );
  const exploratoryLearned = engine.buildForecastPack(
    "new_macau",
    selectedWindow,
    "comprehensive",
    expectedDrawAt,
    selectedWindow,
    learningInput,
  );
  assert.notDeepEqual(
    [
      exploratoryLearned.zodiacObservation.scenarioId,
      exploratoryLearned.zodiacObservation.zodiac,
    ],
    [
      exploratoryBaseline.zodiacObservation.scenarioId,
      exploratoryBaseline.zodiacObservation.zodiac,
    ],
  );

  const learned = engine.buildForecastPack(
    "new_macau",
    selectedWindow,
    "comprehensive",
    expectedDrawAt,
    evaluationHistory,
    learningInput,
  );
  assert.deepEqual(learned.backtest, baseline.backtest);
  assert.deepEqual(
    learned.zodiacObservation,
    baseline.zodiacObservation,
  );
  assert.deepEqual(
    learned.candidateSets.map((candidate) => [
      candidate.id,
      candidate.observations.map((observation) => observation.pick),
    ]),
    baseline.candidateSets.map((candidate) => [
      candidate.id,
      candidate.observations.map((observation) => observation.pick),
    ]),
  );
  assert.ok(
    learned.learning.safeguards.some(
      (item) => item.includes("实际验证的未调权方向"),
    ),
  );
});

function buildAlwaysCoveredHistory(): Draw[] {
  const chronological: Draw[] = [];
  for (let index = 0; index < 30; index += 1) {
    const values = Array.from(
      { length: 7 },
      (_, offset) => 1 + ((index * 7 + offset * 6) % 49),
    );
    chronological.push({
      game: "new_macau",
      issue: String(2026001 + index),
      drawAt: new Date(
        Date.UTC(2026, 0, 1 + index, 13, 32),
      ).toISOString(),
      numbers: values.slice(0, 6),
      special: values[6],
      source: "deterministic seed",
      verified: true,
    });
  }
  for (let index = 30; index < 90; index += 1) {
    const drawAt = new Date(
      Date.UTC(2026, 0, 1 + index, 13, 32),
    ).toISOString();
    const prior = [...chronological].reverse();
    const forecast = engine.buildForecastPack(
      "new_macau",
      prior.slice(0, 30),
      "comprehensive",
      drawAt,
      prior,
    );
    const zodiacs = [...new Set(
      forecast.candidateSets.map(
        (candidate) =>
          candidate.observations.find(
            (observation) => observation.id === "zodiac_coverage",
          )!.pick,
      ),
    )];
    const values: number[] = [];
    zodiacs.forEach((zodiac) => {
      const match = Array.from(
        { length: 49 },
        (_, numberIndex) => numberIndex + 1,
      ).find(
        (number) =>
          getZodiac(number, drawAt) === zodiac &&
          !values.includes(number),
      );
      if (match) values.push(match);
    });
    for (let number = 1; values.length < 7; number += 1) {
      if (!values.includes(number)) values.push(number);
    }
    chronological.push({
      game: "new_macau",
      issue: String(2026001 + index),
      drawAt,
      numbers: values.slice(0, 6),
      special: values[6],
      source: "constructed coverage",
      verified: true,
    });
  }
  return chronological.reverse();
}

function sample(
  index: number,
  winner: AiScenarioId,
  overrides: Partial<SettledForecastLearningSample> = {},
): SettledForecastLearningSample {
  const day = String((index % 27) + 1).padStart(2, "0");
  const expectedDrawAt =
    overrides.expectedDrawAt ??
    `2026-07-${day}T13:32:00.000Z`;
  const actualNumbers = [1, 2, 7, 3, 4, 9];
  const special = 25;
  const actualAll = [...actualNumbers, special];
  return {
    game: "new_macau",
    targetIssue: String(2026200 + index),
    expectedDrawAt,
    lockedAt:
      overrides.lockedAt ??
      `2026-07-${day}T08:00:00.000Z`,
    settledAt:
      overrides.settledAt ??
      `2026-07-${day}T14:00:00.000Z`,
    algorithmVersion: "forecast-engine-v4.1",
    schemaVersion: "4",
    responseMode: "ai",
    responseStatus: "ok",
    canonicalConfiguration:
      overrides.canonicalConfiguration ?? true,
    primaryScenarioId: winner,
    scenarios: SCENARIOS.map((id) => ({
      id,
      observations:
        id === winner
          ? winningObservations(expectedDrawAt, actualAll)
          : losingObservations(expectedDrawAt, actualAll),
    })),
    actual: {
      issue: String(2026200 + index),
      drawAt: expectedDrawAt,
      numbers: actualNumbers,
      special,
      verified: true,
    },
    ...overrides,
  };
}

function winningObservations(
  drawAt: string,
  actual: number[],
): LearningObservationPrediction[] {
  return [
    { id: "zodiac_coverage", pick: getZodiac(actual[0], drawAt) },
    { id: "tail_coverage", pick: `${actual[0] % 10}尾` },
    { id: "wave_threshold", pick: "蓝波" },
    { id: "parity_majority", pick: "奇数" },
    { id: "size_majority", pick: "小数" },
  ];
}

function losingObservations(
  drawAt: string,
  actual: number[],
): LearningObservationPrediction[] {
  const actualZodiacs = new Set(
    actual.map((number) => getZodiac(number, drawAt)),
  );
  const absentZodiac = ZODIAC_NAMES.find(
    (zodiac) => !actualZodiacs.has(zodiac),
  )!;
  const actualTails = new Set(actual.map((number) => number % 10));
  const absentTail = Array.from(
    { length: 10 },
    (_, tail) => tail,
  ).find((tail) => !actualTails.has(tail))!;
  return [
    { id: "zodiac_coverage", pick: absentZodiac },
    { id: "tail_coverage", pick: `${absentTail}尾` },
    { id: "wave_threshold", pick: "绿波" },
    { id: "parity_majority", pick: "偶数" },
    { id: "size_majority", pick: "大数" },
  ];
}

function ledgerRow(sampleValue: SettledForecastLearningSample) {
  return {
    game: sampleValue.game,
    target_issue: sampleValue.targetIssue,
    expected_draw_at: sampleValue.expectedDrawAt,
    analysis_cutoff_at: sampleValue.lockedAt,
    window_size: 30,
    focus: "comprehensive",
    algorithm_version: sampleValue.algorithmVersion,
    schema_version: sampleValue.schemaVersion,
    response_mode: sampleValue.responseMode,
    response_status: sampleValue.responseStatus,
    prediction_json: JSON.stringify({
      primaryScenarioId: sampleValue.primaryScenarioId,
      scenarios: sampleValue.scenarios,
    }),
    locked_at: sampleValue.lockedAt,
    actual_issue: sampleValue.actual.issue,
    actual_draw_at: sampleValue.actual.drawAt,
    actual_numbers_json: JSON.stringify(sampleValue.actual.numbers),
    actual_special: sampleValue.actual.special,
    actual_verified: sampleValue.actual.verified,
    settled_at: sampleValue.settledAt,
    forecast_id: `forecast-${sampleValue.targetIssue}`,
  };
}
