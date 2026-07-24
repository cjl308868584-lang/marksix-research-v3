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
    correction: string;
    status: string;
    decision: string;
    selectedStrategyId: string | null;
    selection: BacktestSegment;
    holdout: BacktestSegment;
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
    randomPValue: number;
  }>;
};

let server: ViteDevServer;
let engine: LoadedEngine;
let history: Record<"hk" | "macau" | "new_macau", Draw[]>;

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
  };
  history = lottery.FALLBACK_DRAWS;
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

test("uses the selected window at every walk-forward step and keeps selection separate", () => {
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
    }
  }
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
