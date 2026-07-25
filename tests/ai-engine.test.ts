import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createServer, type ViteDevServer } from "vite";

type LoadedEngine = {
  buildForecastPack: (
    game: "hk" | "macau" | "new_macau",
    draws: Draw[],
    focus: string,
    expectedDrawAt: string,
    evaluationHistory?: Draw[],
  ) => ForecastPack;
  randomBaseline: () => {
    averageMainOverlap: number;
    anyMainOverlapRate: number;
    specialExactRate: number;
  };
  exactCoverageProbability: (
    memberCount: number,
    threshold?: number,
    drawSize?: number,
  ) => number;
  poissonBinomialUpperTailPValue: (
    observed: number,
    probabilities: number[],
  ) => number;
  isZodiacCovered: (
    zodiac: string,
    drawAt: string,
    numbers: number[],
  ) => boolean;
  wilsonInterval: (
    successes: number,
    trials: number,
  ) => { low: number; high: number; level: number; method: string };
};

type Draw = {
  game: "hk" | "macau" | "new_macau";
  issue: string;
  drawAt: string;
  numbers: number[];
  special: number;
  source: string;
  verified: boolean;
};

type ForecastPack = {
  candidateSets: Array<{
    id: string;
    numbers: number[];
    special: number;
    evidenceScore: number;
    observations: ScenarioObservation[];
    diversity: {
      uniqueMainNumbers: number;
      maxMainOverlap: number;
      averageJaccard: number;
      score: number;
    };
  }>;
  backtest: {
    method: string;
    trainWindow: number;
    evaluationHistorySize: number;
    selectionCount: number;
    holdoutCount: number;
    testCount: number;
    multipleComparisonCount: number;
    validationAlpha: number;
    observationComparisonCount: number;
    observationValidationAlpha: number;
    correction: string;
    status: string;
    decision: string;
    selectedStrategyId: string | null;
    selection: BacktestSegment;
    holdout: BacktestSegment;
  };
  zodiacObservation: {
    kind: string;
    scenarioId: string;
    zodiac: string;
    target: string;
    baselineRate: number;
    validation: string;
    configuration: {
      focus: string;
      trainWindow: number;
      userSelectable: boolean;
    };
    backtest: BacktestObservation;
    conclusion: string;
  };
  evidenceStrength: { score: number; label: string };
  localSynthesis: { recommendedScenarioId: string | null };
};

type BacktestSegment = {
  startIssue: string | null;
  endIssue: string | null;
  testCount: number;
  strategies: Array<{
    id: string;
    sampleSize: number;
    totalMainOverlap: number;
    anyMainOverlapCount: number;
    specialExactCount: number;
    averageMainOverlapCI: { low: number; high: number; method: string };
    anyMainOverlapCI: { low: number; high: number; method: string };
    specialExactCI: { low: number; high: number; method: string };
    specialZodiacCI: { low: number; high: number; method: string };
    specialZodiacBaseline: number;
    observations: BacktestObservation[];
    mainRandomPValue: number;
    randomPValue: number;
  }>;
};

type BacktestObservation = {
  id: string;
  label: string;
  sampleSize: number;
  hitCount: number;
  hitRate: number;
  confidenceInterval: { low: number; high: number; method: string };
  baselineRate: number;
  lift: number;
  randomPValue: number;
  status: string;
};

type ScenarioObservation = {
  id: string;
  label: string;
  pick: string;
  target: string;
  threshold: number;
  memberCount: number;
  baselineRate: number;
  backtest: BacktestObservation;
};

let server: ViteDevServer;
let engine: LoadedEngine;
let history: Record<"hk" | "macau" | "new_macau", Draw[]>;
let zodiacFor: (number: number, drawAt: string) => string;

before(async () => {
  server = await createServer({
    root: process.cwd(),
    configFile: false,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "silent",
  });
  engine = (await server.ssrLoadModule("/lib/ai-engine.ts")) as LoadedEngine;
  const lottery = (await server.ssrLoadModule("/lib/lottery.ts")) as {
    FALLBACK_DRAWS: typeof history;
    getZodiac: typeof zodiacFor;
  };
  history = lottery.FALLBACK_DRAWS;
  zodiacFor = lottery.getZodiac;
});

after(async () => {
  await server.close();
});

test("uses the exact theoretical random baseline", () => {
  const baseline = engine.randomBaseline();
  const noOverlap =
    combination(43, 6) /
    combination(49, 6);

  assert.ok(Math.abs(baseline.averageMainOverlap - 36 / 49) < 1e-6);
  assert.ok(
    Math.abs(baseline.anyMainOverlapRate - (1 - noOverlap) * 100) < 1e-6,
  );
  assert.ok(Math.abs(baseline.specialExactRate - (1 / 49) * 100) < 1e-6);
});

test("uses exact without-replacement baselines for the five 6+1 observations", () => {
  const fourMemberCoverage =
    1 - combination(45, 7) / combination(49, 7);
  const fiveMemberCoverage =
    1 - combination(44, 7) / combination(49, 7);
  const redAtLeastThree = hypergeometricUpperTail(17, 3, 7);
  const oddMajority = hypergeometricUpperTail(25, 4, 7);

  assert.ok(
    Math.abs(engine.exactCoverageProbability(4) - fourMemberCoverage) < 1e-12,
  );
  assert.ok(
    Math.abs(engine.exactCoverageProbability(5) - fiveMemberCoverage) < 1e-12,
  );
  assert.ok(
    Math.abs(engine.exactCoverageProbability(17, 3) - redAtLeastThree) < 1e-12,
  );
  assert.ok(
    Math.abs(engine.exactCoverageProbability(25, 4) - oddMajority) < 1e-12,
  );
  assert.equal(engine.exactCoverageProbability(4, 8), 0);
  assert.equal(engine.exactCoverageProbability(50), 0);
});

test("Poisson-binomial upper tails are exact for equal and unequal null rates", () => {
  assert.ok(
    Math.abs(
      engine.poissonBinomialUpperTailPValue(2, [0.5, 0.5, 0.5]) - 0.5,
    ) < 1e-12,
  );
  assert.ok(
    Math.abs(
      engine.poissonBinomialUpperTailPValue(1, [0.2, 0.4]) - 0.52,
    ) < 1e-12,
  );
  assert.equal(engine.poissonBinomialUpperTailPValue(0, [0.2, 0.4]), 1);
  assert.equal(engine.poissonBinomialUpperTailPValue(3, [0.2, 0.4]), 0);
});

test("生肖覆盖命中可来自任一正码或特码", () => {
  const drawAt = "2026-07-25T13:32:00.000Z";
  const targetZodiac = zodiacFor(5, drawAt);
  const nonTargetNumbers = Array.from(
    { length: 49 },
    (_, index) => index + 1,
  ).filter((number) => zodiacFor(number, drawAt) !== targetZodiac);

  assert.equal(
    engine.isZodiacCovered(
      targetZodiac,
      drawAt,
      [5, ...nonTargetNumbers.slice(0, 6)],
    ),
    true,
  );
  assert.equal(
    engine.isZodiacCovered(
      targetZodiac,
      drawAt,
      [...nonTargetNumbers.slice(0, 6), 5],
    ),
    true,
  );
  assert.equal(
    engine.isZodiacCovered(
      targetZodiac,
      drawAt,
      nonTargetNumbers.slice(0, 7),
    ),
    false,
  );
});

test("Wilson intervals are deterministic and contain the observed rate", () => {
  const first = engine.wilsonInterval(5, 10);
  const second = engine.wilsonInterval(5, 10);

  assert.deepEqual(first, second);
  assert.equal(first.method, "wilson");
  assert.equal(first.level, 95);
  assert.ok(first.low < 50);
  assert.ok(first.high > 50);
  assert.deepEqual(engine.wilsonInterval(0, 0), {
    low: 0,
    high: 0,
    level: 95,
    method: "wilson",
  });
});

test("uses the predeclared 30-period primary window and keeps selection separate", () => {
  const evaluationHistory = history.new_macau;
  const selectedWindow = evaluationHistory.slice(0, 30);
  const pack = engine.buildForecastPack(
    "new_macau",
    selectedWindow,
    "comprehensive",
    "2026-07-25T13:32:00.000Z",
    evaluationHistory,
  );

  assert.equal(pack.backtest.method, "nested_holdout_walk_forward");
  assert.equal(pack.backtest.trainWindow, 30);
  assert.equal(pack.backtest.evaluationHistorySize, evaluationHistory.length);
  assert.equal(
    pack.backtest.selectionCount + pack.backtest.holdoutCount,
    evaluationHistory.length - 30,
  );
  assert.equal(pack.backtest.testCount, pack.backtest.holdoutCount);
  assert.equal(pack.backtest.multipleComparisonCount, 40);
  assert.ok(
    Math.abs(pack.backtest.validationAlpha - 0.05 / 40) < 1e-6,
  );
  assert.equal(pack.backtest.correction, "bonferroni");
  assert.equal(pack.backtest.observationComparisonCount, 600);
  assert.ok(
    Math.abs(pack.backtest.observationValidationAlpha - 0.05 / 600) < 1e-6,
  );
  assert.ok(pack.backtest.selectionCount >= 20);
  assert.ok(pack.backtest.holdoutCount >= 20);
  assert.ok(
    Number(pack.backtest.selection.endIssue) <
      Number(pack.backtest.holdout.startIssue),
  );
  for (const segment of [pack.backtest.selection, pack.backtest.holdout]) {
    for (const strategy of segment.strategies) {
      assert.equal(strategy.sampleSize, segment.testCount);
      assert.equal(strategy.averageMainOverlapCI.method, "bootstrap_percentile");
      assert.equal(strategy.anyMainOverlapCI.method, "wilson");
      assert.equal(strategy.specialExactCI.method, "wilson");
      assert.equal(strategy.specialZodiacCI.method, "wilson");
      assert.ok(strategy.specialZodiacBaseline > 0);
      assert.ok(strategy.specialZodiacBaseline < 100);
      assert.deepEqual(
        strategy.observations.map((observation) => observation.id),
        [
          "zodiac_coverage",
          "tail_coverage",
          "wave_threshold",
          "parity_majority",
          "size_majority",
        ],
      );
      for (const observation of strategy.observations) {
        assert.equal(observation.sampleSize, segment.testCount);
        assert.equal(observation.confidenceInterval.method, "wilson");
        assert.ok(observation.baselineRate > 0);
        assert.ok(observation.baselineRate < 100);
        assert.ok(observation.randomPValue >= 0);
        assert.ok(observation.randomPValue <= 1);
      }
      const zodiac = strategy.observations[0];
      assert.equal(strategy.randomPValue, zodiac.randomPValue);
      assert.ok(strategy.mainRandomPValue >= 0);
      assert.ok(strategy.mainRandomPValue <= 1);
    }
  }
  assert.equal(
    pack.zodiacObservation.kind,
    "zodiac_coverage_6_plus_1",
  );
  assert.equal(
    pack.zodiacObservation.scenarioId,
    pack.backtest.selectedStrategyId,
  );
  assert.match(pack.zodiacObservation.target, /6\+1/);
  assert.ok(pack.zodiacObservation.zodiac.length > 0);
  assert.ok(pack.zodiacObservation.baselineRate > 40);
  assert.ok(pack.zodiacObservation.baselineRate < 60);
  assert.deepEqual(pack.zodiacObservation.configuration, {
    focus: "comprehensive",
    trainWindow: 30,
    userSelectable: false,
  });
});

test("is deterministic and returns valid, deliberately diverse candidate sets", () => {
  const evaluationHistory = history.macau;
  const selectedWindow = evaluationHistory.slice(0, 30);
  const first = engine.buildForecastPack(
    "macau",
    selectedWindow,
    "numbers",
    "2026-07-25T14:32:00.000Z",
    evaluationHistory,
  );
  const second = engine.buildForecastPack(
    "macau",
    selectedWindow,
    "numbers",
    "2026-07-25T14:32:00.000Z",
    evaluationHistory,
  );

  assert.deepEqual(first, second);
  for (const candidate of first.candidateSets) {
    assert.equal(candidate.numbers.length, 6);
    assert.equal(new Set(candidate.numbers).size, 6);
    assert.ok(candidate.numbers.every((number) => number >= 1 && number <= 49));
    assert.ok(candidate.special >= 1 && candidate.special <= 49);
    assert.ok(!candidate.numbers.includes(candidate.special));
    assert.ok(candidate.diversity.maxMainOverlap <= 2);
    assert.ok(candidate.diversity.score >= 80);
    assert.ok(candidate.evidenceScore >= 0 && candidate.evidenceScore <= 99);
    assert.deepEqual(
      candidate.observations.map((observation) => observation.id),
      [
        "zodiac_coverage",
        "tail_coverage",
        "wave_threshold",
        "parity_majority",
        "size_majority",
      ],
    );
    for (const observation of candidate.observations) {
      assert.ok(observation.pick.length > 0);
      assert.ok(observation.target.length > 0);
      assert.ok(observation.threshold >= 1);
      assert.ok(observation.memberCount >= 4);
      assert.ok(
        Math.abs(
          observation.baselineRate / 100 -
            engine.exactCoverageProbability(
              observation.memberCount,
              observation.threshold,
            ),
        ) < 1e-4,
      );
    }
  }
  for (let left = 0; left < first.candidateSets.length; left += 1) {
    for (let right = left + 1; right < first.candidateSets.length; right += 1) {
      const overlap = first.candidateSets[left].numbers.filter((number) =>
        first.candidateSets[right].numbers.includes(number),
      ).length;
      assert.ok(overlap <= 2);
    }
  }
});

test("future evaluation rows cannot change the current forecast or backtest", () => {
  const evaluationHistory = history.hk;
  const selectedWindow = evaluationHistory.slice(0, 30);
  const baseline = engine.buildForecastPack(
    "hk",
    selectedWindow,
    "shape",
    "2026-07-25T13:30:00.000Z",
    evaluationHistory,
  );
  const future: Draw = {
    game: "hk",
    issue: "9999999",
    drawAt: "2027-01-01T21:30:00+08:00",
    numbers: [1, 2, 3, 4, 5, 6],
    special: 7,
    source: "future sentinel",
    verified: true,
  };
  const withFuture = engine.buildForecastPack(
    "hk",
    selectedWindow,
    "shape",
    "2026-07-25T13:30:00.000Z",
    [future, ...evaluationHistory],
  );

  assert.deepEqual(withFuture.candidateSets, baseline.candidateSets);
  assert.deepEqual(withFuture.backtest, baseline.backtest);
  assert.deepEqual(withFuture.evidenceStrength, baseline.evidenceStrength);
});

test("the official zodiac direction cannot be changed by focus or visible window", () => {
  const evaluationHistory = history.new_macau;
  const compact = engine.buildForecastPack(
    "new_macau",
    evaluationHistory.slice(0, 10),
    "zodiac",
    "2026-07-25T13:32:00.000Z",
    evaluationHistory,
  );
  const expanded = engine.buildForecastPack(
    "new_macau",
    evaluationHistory.slice(0, 50),
    "omission",
    "2026-07-25T13:32:00.000Z",
    evaluationHistory,
  );

  assert.deepEqual(expanded.zodiacObservation, compact.zodiacObservation);
  assert.deepEqual(expanded.backtest, compact.backtest);
  assert.equal(compact.backtest.trainWindow, 30);
  assert.notDeepEqual(
    expanded.candidateSets.map((candidate) => candidate.numbers),
    compact.candidateSets.map((candidate) => candidate.numbers),
  );
});

test("holdout outcomes cannot alter the strategy chosen by the earlier selection segment", () => {
  const evaluationHistory = history.new_macau;
  const selectedWindow = evaluationHistory.slice(0, 30);
  const baseline = engine.buildForecastPack(
    "new_macau",
    selectedWindow,
    "comprehensive",
    "2026-07-25T13:32:00.000Z",
    evaluationHistory,
  );
  const changedLatest: Draw = {
    ...evaluationHistory[0],
    numbers: [1, 2, 3, 4, 5, 6],
    special: 7,
    source: "holdout sentinel",
  };
  const changed = engine.buildForecastPack(
    "new_macau",
    selectedWindow,
    "comprehensive",
    "2026-07-25T13:32:00.000Z",
    [changedLatest, ...evaluationHistory.slice(1)],
  );

  assert.equal(
    changed.backtest.selectedStrategyId,
    baseline.backtest.selectedStrategyId,
  );
  assert.deepEqual(changed.backtest.selection, baseline.backtest.selection);
  assert.deepEqual(
    changed.candidateSets.map((candidate) => ({
      id: candidate.id,
      numbers: candidate.numbers,
      special: candidate.special,
      diversity: candidate.diversity,
    })),
    baseline.candidateSets.map((candidate) => ({
      id: candidate.id,
      numbers: candidate.numbers,
      special: candidate.special,
      diversity: candidate.diversity,
    })),
  );
});

test("insufficient independent history forces an abstention and no recommendation", () => {
  const selectedWindow = history.new_macau.slice(0, 50);
  const pack = engine.buildForecastPack(
    "new_macau",
    selectedWindow,
    "comprehensive",
    "2026-07-25T13:32:00.000Z",
    selectedWindow,
  );

  assert.equal(pack.backtest.status, "insufficient");
  assert.equal(pack.backtest.decision, "abstain");
  assert.equal(pack.backtest.selectedStrategyId, null);
  assert.equal(pack.localSynthesis.recommendedScenarioId, null);
  assert.equal(pack.evidenceStrength.score, 0);
  assert.ok(pack.candidateSets.every((candidate) => candidate.evidenceScore === 0));
});

test("fair random histories rarely cross the family-wise recommendation gate", () => {
  let observedAdvantages = 0;
  const simulationCount = 60;
  for (let seed = 1; seed <= simulationCount; seed += 1) {
    const simulated = randomHistory(seed, 90);
    const pack = engine.buildForecastPack(
      "new_macau",
      simulated.slice(0, 30),
      "comprehensive",
      "2026-07-25T13:32:00.000Z",
      simulated,
    );
    if (pack.backtest.status === "observed_advantage") {
      observedAdvantages += 1;
    }
  }

  assert.ok(
    observedAdvantages <= 1,
    `family-wise gate produced ${observedAdvantages}/${simulationCount} false advantages`,
  );
});

function randomHistory(seed: number, count: number): Draw[] {
  const random = seededRandom(seed);
  const chronological = Array.from({ length: count }, (_, index) => {
    const pool = Array.from({ length: 49 }, (__, numberIndex) => numberIndex + 1);
    for (let cursor = pool.length - 1; cursor > 0; cursor -= 1) {
      const swapIndex = Math.floor(random() * (cursor + 1));
      [pool[cursor], pool[swapIndex]] = [pool[swapIndex], pool[cursor]];
    }
    const values = pool.slice(0, 7);
    return {
      game: "new_macau" as const,
      issue: String(2026001 + index),
      drawAt: new Date(Date.UTC(2026, 0, 1 + index, 13, 32)).toISOString(),
      numbers: values.slice(0, 6),
      special: values[6],
      source: "deterministic null simulation",
      verified: true,
    };
  });
  return chronological.reverse();
}

function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = Math.imul(state ^ (state >>> 15), 1 | state);
    state ^= state + Math.imul(state ^ (state >>> 7), 61 | state);
    return ((state ^ (state >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function combination(n: number, k: number) {
  let value = 1;
  for (let index = 1; index <= k; index += 1) {
    value = (value * (n - k + index)) / index;
  }
  return value;
}

function hypergeometricUpperTail(
  memberCount: number,
  threshold: number,
  drawSize: number,
) {
  let probability = 0;
  for (
    let matches = threshold;
    matches <= Math.min(memberCount, drawSize);
    matches += 1
  ) {
    probability +=
      (combination(memberCount, matches) *
        combination(49 - memberCount, drawSize - matches)) /
      combination(49, drawSize);
  }
  return probability;
}
