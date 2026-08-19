import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after, before } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer, type ViteDevServer } from "vite";
import type { AuthoritativeRecommendation } from "../lib/rolling-pattern-types.ts";

const root = new URL("../", import.meta.url);
let server: ViteDevServer;

before(async () => {
  server = await createServer({ root: process.cwd(), configFile: false, server: { middlewareMode: true }, appType: "custom", logLevel: "silent" });
});

after(async () => {
  await server.close();
});

test("independent learning page exposes five official slots and the learning audit", async () => {
  const [page, workspace] = await Promise.all([
    readFile(new URL("app/learning/page.tsx", root), "utf8"),
    readFile(new URL("app/learning/ForwardLearningWorkspace.tsx", root), "utf8"),
  ]);
  assert.match(page, /逐期学习中心/);
  assert.match(workspace, /每期固定五项/);
  assert.match(workspace, /6\+1单生肖/);
  assert.match(workspace, /6\+1单尾数/);
  assert.match(workspace, /6\+1二连肖/);
  assert.match(workspace, /6\+1三连肖/);
  assert.match(workspace, /特码数字/);
  assert.match(workspace, /Brier skill/);
  assert.match(workspace, /与近30期购买参考同源/);
  assert.match(workspace, /赔率参与排序/);
  assert.match(workspace, /同源产品学习状态/);
  assert.doesNotMatch(workspace, /赔率不参与模型排序/);
  assert.doesNotMatch(workspace, /THREE EXPERTS/);
  assert.match(workspace, /api\/learning\/forecast/);
  assert.match(workspace, /api\/learning\/reviews/);
  assert.match(workspace, /api\/learning\/performance/);
  assert.match(workspace, /api\/learning\/model/);
});

test("a negative-EV authoritative item remains a concrete purchase card", async () => {
  const module = await server.ssrLoadModule("/app/patterns/RollingPatternWorkspace.tsx") as {
    PurchaseRecommendationPanel: React.ComponentType<{ items: AuthoritativeRecommendation[] }>;
  };
  const recommendation = negativeRecommendation();
  const html = renderToStaticMarkup(React.createElement(module.PurchaseRecommendationPanel, { items: [recommendation] }));

  assert.match(html, /01/);
  assert.match(html, /-0\.52/);
  assert.match(html, /低于盈亏平衡线/);
  assert.doesNotMatch(html, /本期不推荐/);
});

test("home links to the independent learning page", async () => {
  const dashboard = await readFile(new URL("app/LotteryDashboard.tsx", root), "utf8");
  assert.match(dashboard, /href="\/learning"/);
  assert.match(dashboard, /逐期学习中心/);
});

function negativeRecommendation(): AuthoritativeRecommendation {
  const product = {
    runId: "pattern:2026231",
    productId: "product:special:01",
    dataVersion: "data-v2",
    game: "new_macau" as const,
    targetIssue: "2026231",
    scope: "special" as const,
    kind: "special_number" as const,
    label: "01",
    values: ["01"],
    evidenceEventIds: [],
    strategyCount: 0,
    support: 0,
    hits: 0,
    misses: 0,
    baselineProbability: 1 / 49,
    patternProbability: 1 / 49,
    legacySeedProbability: 0.01,
    estimatedProbability: 0.01,
    netOdds: 47,
    breakEvenProbability: 1 / 48,
    expectedValue: -0.52,
    valueStatus: "negative" as const,
    legacySettledCount: 9,
    legacyHitCount: 0,
    learningSettledCount: 1,
    learningHitCount: 0,
    learningMissCount: 1,
    sourceKind: "ledger" as const,
    sourceProductId: "product:special:01",
    derivedDefinitionHash: "special-01",
    forwardSettledCount: 1,
    forwardHitCount: 0,
    forwardMissCount: 1,
    rank: 1,
    frozenAt: "2026-08-19T12:00:00.000Z",
  };
  return {
    kind: product.kind,
    resultKey: "01",
    values: ["01"],
    sourceRunId: product.runId,
    sourceProductId: product.sourceProductId,
    sourceKind: product.sourceKind,
    dataVersion: product.dataVersion,
    revision: 2,
    p30: product.patternProbability,
    legacySeedProbability: product.legacySeedProbability,
    learnedProbability: product.estimatedProbability,
    netOdds: product.netOdds,
    breakEvenProbability: product.breakEvenProbability,
    expectedValue: product.expectedValue,
    legacySettledCount: product.legacySettledCount,
    legacyHitCount: product.legacyHitCount,
    learningSettledCount: product.learningSettledCount,
    learningHitCount: product.learningHitCount,
    product,
    reason: "参考概率1.0%，低于盈亏平衡线2.1%，属于负期望风险项，每1单位期望-0.52。",
  };
}
