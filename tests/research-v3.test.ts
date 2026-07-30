import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createServer, type ViteDevServer } from "vite";

type Draw = {
  game: "new_macau";
  issue: string;
  drawAt: string;
  numbers: number[];
  special: number;
  source: string;
  verified: boolean;
};

let server: ViteDevServer;
let buildSnapshot: (input: {
  game: "new_macau";
  draws: Draw[];
  targetIssue: string;
  expectedDrawAt: string;
  generatedAt: string;
}) => any;
let baseline: (
  scope: string,
  family: string,
  value: string,
  drawAt: string,
) => number;
let buildReview: (snapshot: any, draw: Draw, settledAt: string) => any;

before(async () => {
  server = await createServer({
    root: process.cwd(),
    configFile: false,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "silent",
  });
  const engine = await server.ssrLoadModule("/lib/research-v3-engine.ts") as any;
  const review = await server.ssrLoadModule("/lib/research-v3-review.ts") as any;
  buildSnapshot = engine.buildResearchV3Snapshot;
  baseline = engine.exactEventBaseline;
  buildReview = review.buildResearchV3Review;
});

after(async () => {
  await server.close();
});

test("v3 freezes exactly four high-probability events and never predicts numbers", () => {
  const draws = makeHistory(160);
  const snapshot = buildSnapshot({
    game: "new_macau",
    draws,
    targetIssue: "2026999",
    expectedDrawAt: "2026-10-01T21:32:32+08:00",
    generatedAt: "2026-09-30T10:00:00.000Z",
  });
  assert.equal(snapshot.schemaVersion, "3");
  assert.deepEqual(
    snapshot.events.map((event: any) => event.slot),
    [
      "zodiac_6_plus_1",
      "tail_6_plus_1",
      "position_parity",
      "position_size",
    ],
  );
  for (const event of snapshot.events) {
    assert.ok(event.probability >= 0.4 && event.probability <= 0.7);
    assert.ok(
      event.baselineProbability >= 0.4 &&
        event.baselineProbability <= 0.7,
    );
    assert.notEqual(event.family, "number");
    assert.doesNotMatch(event.predictionLabel, /候选号码|最高交集号码|号码前三/);
    assert.equal(event.experts.length, 4);
  }
});

test("coverage and position baselines use exact without-replacement probabilities", () => {
  const drawAt = "2026-10-01T21:32:32+08:00";
  const zodiac = baseline("draw.6_plus_1", "zodiac", "鼠", drawAt);
  const tail4 = baseline("draw.6_plus_1", "tail", "4尾", drawAt);
  const odd = baseline("main.position.3", "parity", "单", drawAt);
  const big = baseline("special", "size", "大", drawAt);
  assert.ok(zodiac > 0.47 && zodiac < 0.56);
  assert.ok(tail4 > 0.47 && tail4 < 0.56);
  assert.ok(Math.abs(odd - 25 / 49) < 1e-9);
  assert.ok(Math.abs(big - 25 / 49) < 1e-9);
});

test("verified settlement scores frozen events before updating weights", () => {
  const draws = makeHistory(160);
  const snapshot = buildSnapshot({
    game: "new_macau",
    draws,
    targetIssue: "2026999",
    expectedDrawAt: "2026-10-01T21:32:32+08:00",
    generatedAt: "2026-09-30T10:00:00.000Z",
  });
  const draw: Draw = {
    game: "new_macau",
    issue: "2026999",
    drawAt: "2026-10-01T21:32:32+08:00",
    numbers: [1, 12, 23, 34, 45, 49],
    special: 8,
    source: "双源一致测试",
    verified: true,
  };
  const review = buildReview(
    snapshot,
    draw,
    "2026-10-01T21:35:00+08:00",
  );
  assert.equal(review.events.length, 4);
  assert.equal(review.total, 4);
  assert.ok(review.hits >= 0 && review.hits <= 4);
  for (const event of review.events) {
    const before = Object.fromEntries(
      event.modelWeightsBefore.map((item: any) => [item.modelId, item.weight]),
    );
    const after = Object.fromEntries(
      event.modelWeightsAfter.map((item: any) => [item.modelId, item.weight]),
    );
    assert.ok(after.baseline >= 0.25);
    assert.ok(
      event.modelWeightsAfter.every((item: any) => item.weight <= 0.5 + 1e-9),
    );
    for (const id of Object.keys(before)) {
      assert.ok(Math.abs(after[id] - before[id]) <= 0.100001);
    }
    assert.ok(Number.isFinite(event.brier));
    assert.ok(Number.isFinite(event.logLoss));
  }
});

test("a result cannot settle a forecast frozen after draw time", () => {
  const snapshot = buildSnapshot({
    game: "new_macau",
    draws: makeHistory(80),
    targetIssue: "2026999",
    expectedDrawAt: "2026-10-01T21:32:32+08:00",
    generatedAt: "2026-10-01T22:00:00+08:00",
  });
  const draw: Draw = {
    game: "new_macau",
    issue: "2026999",
    drawAt: "2026-10-01T21:32:32+08:00",
    numbers: [1, 2, 3, 4, 5, 6],
    special: 7,
    source: "双源一致测试",
    verified: true,
  };
  assert.throws(
    () => buildReview(snapshot, draw, "2026-10-01T22:01:00+08:00"),
    /not frozen before/,
  );
});

function makeHistory(count: number): Draw[] {
  const start = Date.parse("2026-01-01T21:32:32+08:00");
  return Array.from({ length: count }, (_, index) => {
    const pool = Array.from({ length: 49 }, (__, numberIndex) => numberIndex + 1);
    const shift = (index * 11) % 49;
    const ordered = [...pool.slice(shift), ...pool.slice(0, shift)];
    return {
      game: "new_macau",
      issue: String(2026001 + index),
      drawAt: new Date(start + index * 86_400_000).toISOString(),
      numbers: ordered.slice(0, 6),
      special: ordered[6],
      source: "合成测试",
      verified: index >= count - 60,
    };
  });
}
