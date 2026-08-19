import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

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
  assert.match(workspace, /模型权重/);
  assert.match(workspace, /规则奖励与降权/);
  assert.match(workspace, /api\/learning\/forecast/);
  assert.match(workspace, /api\/learning\/reviews/);
  assert.match(workspace, /api\/learning\/performance/);
  assert.match(workspace, /api\/learning\/model/);
});

test("home links to the independent learning page", async () => {
  const dashboard = await readFile(new URL("app/LotteryDashboard.tsx", root), "utf8");
  assert.match(dashboard, /href="\/learning"/);
  assert.match(dashboard, /逐期学习中心/);
});
