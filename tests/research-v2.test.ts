import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createServer, type ViteDevServer } from "vite";

type Draw = {
  game: "hk" | "new_macau";
  issue: string;
  drawAt: string;
  numbers: number[];
  special: number;
  source: string;
  verified: boolean;
};

type RuleSpec = {
  schemaVersion: 1;
  family: string;
  target: { scope: string; family: string };
  source: {
    field: string;
    lag: number;
    family: string;
    transform: string;
  };
  predicates: Array<{
    field: string;
    lag: number;
    family: string;
    operator: string;
    value: string;
  }>;
};

type ResearchEngine = {
  generateRuleSpecs: () => RuleSpec[];
  canonicalRuleJson: (spec: RuleSpec) => string;
  ruleId: (spec: RuleSpec) => string;
  evaluateResearchRule: (
    spec: RuleSpec,
    draws: Draw[],
  ) => {
    description: string;
    support: number;
    hitRate: number;
    baselineRate: number;
    direction: string;
    resourceDecision: string;
  };
  buildResearchSnapshot: (input: {
    game: "hk" | "new_macau";
    draws: Draw[];
    targetIssue: string;
    expectedDrawAt: string;
    generatedAt?: string;
  }) => {
    generatedRuleCount: number;
    fullBacktestRuleCount: number;
    resourceReductionRate: number;
    targetForecasts: Array<{
      targetId: string;
      formalProbabilities: Array<{
        value: string;
        probability: number;
        baseline: number;
      }>;
      experimentalProbabilities: Array<{
        value: string;
        probability: number;
      }>;
    }>;
    experimentalRules: Array<{
      description: string;
      support: number;
      hitRate: number;
      baselineRate: number;
      direction: string;
      tier: string;
    }>;
    negativeRules: Array<{
      direction: string;
      resourceDecision: string;
    }>;
    verifiedRules: unknown[];
  };
};

let server: ViteDevServer;
let engine: ResearchEngine;
let getZodiac: (number: number, drawAt: string) => string;

before(async () => {
  server = await createServer({
    root: process.cwd(),
    configFile: false,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "silent",
  });
  engine = (await server.ssrLoadModule(
    "/lib/research-v2-engine.ts",
  )) as ResearchEngine;
  const zodiac = (await server.ssrLoadModule("/lib/zodiac.ts")) as {
    getZodiac: typeof getZodiac;
  };
  getZodiac = zodiac.getZodiac;
});

after(async () => {
  await server.close();
});

test("rule grammar is deterministic and generates thousands of bounded rules", () => {
  const specs = engine.generateRuleSpecs();
  assert.ok(specs.length > 7_000);
  assert.ok(specs.every((spec) => spec.predicates.length <= 2));
  assert.ok(specs.every((spec) => spec.source.lag >= 1 && spec.source.lag <= 5));

  const example = specs.find(
    (spec) =>
      spec.family === "conditional_transfer" &&
      spec.target.scope === "special" &&
      spec.target.family === "zodiac" &&
      spec.source.field === "main.3" &&
      spec.predicates[0]?.value === "鼠",
  );
  assert.ok(example);
  assert.equal(engine.ruleId(example), engine.ruleId({ ...example }));
  assert.equal(
    engine.canonicalRuleJson(example),
    engine.canonicalRuleJson({ ...example }),
  );
});

test("formal probabilities remain exact baselines while v2 is shadow-only", () => {
  const draws = makeInjectedHistory(90, false);
  const snapshot = engine.buildResearchSnapshot({
    game: "new_macau",
    draws,
    targetIssue: "2026999",
    expectedDrawAt: "2026-10-01T21:32:32+08:00",
    generatedAt: "2026-09-30T10:00:00.000Z",
  });
  const specialNumber = snapshot.targetForecasts.find(
    (target) => target.targetId === "special.number",
  );
  const specialZodiac = snapshot.targetForecasts.find(
    (target) => target.targetId === "special.zodiac",
  );
  const coverage = snapshot.targetForecasts.find(
    (target) => target.targetId === "draw.6_plus_1.zodiac",
  );
  assert.ok(specialNumber && specialZodiac && coverage);
  assert.equal(specialNumber.formalProbabilities.length, 49);
  assert.ok(
    specialNumber.formalProbabilities.every(
      (item) => Math.abs(item.probability - 1 / 49) < 0.000001,
    ),
  );
  assert.ok(
    Math.abs(
      specialZodiac.formalProbabilities.reduce(
        (sum, item) => sum + item.probability,
        0,
      ) - 1,
    ) < 0.00001,
  );
  assert.ok(
    coverage.formalProbabilities.every(
      (item) => item.probability > 0.45 && item.probability < 0.57,
    ),
  );
  assert.equal(snapshot.verifiedRules.length, 0);
});

test("discovers the user example but keeps it in the research track", () => {
  const draws = makeInjectedHistory(210, true);
  const snapshot = engine.buildResearchSnapshot({
    game: "new_macau",
    draws,
    targetIssue: "2026999",
    expectedDrawAt: "2026-10-01T21:32:32+08:00",
    generatedAt: "2026-09-30T10:00:00.000Z",
  });
  const exampleSpec = engine.generateRuleSpecs().find(
    (spec) =>
      spec.family === "conditional_transfer" &&
      spec.target.scope === "special" &&
      spec.target.family === "zodiac" &&
      spec.source.field === "main.3" &&
      spec.predicates[0]?.value === "鼠",
  );
  assert.ok(exampleSpec);
  const example = engine.evaluateResearchRule(exampleSpec, draws);
  assert.ok(example.description.includes("特码生肖为鼠"));
  assert.ok(example.description.includes("第3正码生肖"));
  assert.equal(example.direction, "positive");
  assert.ok(example.support >= 50);
  assert.ok(example.hitRate > example.baselineRate);
  assert.equal(example.resourceDecision, "full_backtest");
  assert.equal(snapshot.verifiedRules.length, 0);
  assert.ok(snapshot.generatedRuleCount > 7_000);
  assert.ok(snapshot.fullBacktestRuleCount < snapshot.generatedRuleCount * 0.1);
  assert.ok(snapshot.resourceReductionRate >= 0.95);
});

function makeInjectedHistory(count: number, verified: boolean): Draw[] {
  const base = Date.parse("2026-02-20T21:32:32+08:00");
  const draws: Draw[] = [];
  for (let index = 0; index < count; index += 1) {
    const drawAt = new Date(base + index * 86_400_000).toISOString();
    const previous = draws[index - 1];
    const shouldFollow =
      previous && getZodiac(previous.special, previous.drawAt) === "鼠";
    const desiredSpecialZodiac = shouldFollow
      ? getZodiac(previous.numbers[2], previous.drawAt)
      : index % 3 === 0
        ? "鼠"
        : "牛";
    const special = firstNumberForZodiac(desiredSpecialZodiac, drawAt, []);
    const mainThree = firstNumberForZodiac("龙", drawAt, [special]);
    const numbers = fillUniqueNumbers([1, 2, mainThree, 4, 5, 6], special);
    draws.push({
      game: "new_macau",
      issue: String(2026001 + index),
      drawAt,
      numbers,
      special,
      source: verified ? "双源测试" : "单源测试",
      verified,
    });
  }
  return draws;
}

function firstNumberForZodiac(
  zodiac: string,
  drawAt: string,
  excluded: number[],
): number {
  const number = Array.from({ length: 49 }, (_, index) => index + 1).find(
    (candidate) =>
      !excluded.includes(candidate) && getZodiac(candidate, drawAt) === zodiac,
  );
  assert.ok(number);
  return number;
}

function fillUniqueNumbers(
  preferred: number[],
  special: number,
): number[] {
  const used = new Set([special]);
  const result: number[] = [];
  for (const preferredNumber of preferred) {
    let number = preferredNumber;
    while (used.has(number)) number = (number % 49) + 1;
    used.add(number);
    result.push(number);
  }
  return result;
}
