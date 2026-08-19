import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("learning read APIs are no-store and never trigger training", async () => {
  const paths = [
    "app/api/learning/forecast/route.ts",
    "app/api/learning/reviews/route.ts",
    "app/api/learning/performance/route.ts",
    "app/api/learning/model/route.ts",
  ];
  const sources = await Promise.all(paths.map((path) => readFile(new URL(path, root), "utf8")));
  for (const source of sources) {
    assert.match(source, /private, no-store/);
    assert.doesNotMatch(source, /runForwardLearningCycle|runStoredForwardLearningCycle/);
  }
  assert.match(sources[0], /readForwardLearningForecast/);
  assert.match(sources[1], /readForwardLearningReviews/);
  assert.match(sources[2], /readForwardLearningPerformance/);
  assert.match(sources[3], /readForwardLearningModel/);
});

test("learning API validators reject unknown query parameters", async () => {
  const paths = [
    "app/api/learning/forecast/route.ts",
    "app/api/learning/reviews/route.ts",
    "app/api/learning/performance/route.ts",
    "app/api/learning/model/route.ts",
  ];
  const sources = await Promise.all(paths.map((path) => readFile(new URL(path, root), "utf8")));
  for (const source of sources) {
    assert.match(source, /不受支持的参数/);
    assert.match(source, /GAME_IDS/);
  }
});

test("signed learning treats a missing 30-draw prerequisite as an explicit abstention", async () => {
  const route = await readFile(
    new URL("app/api/internal/learning/settle-and-freeze/route.ts", root),
    "utf8",
  );
  const service = await readFile(
    new URL("lib/forward-learning-service.ts", root),
    "utf8",
  );
  assert.match(service, /ForwardLearningPrerequisiteError/);
  assert.match(route, /instanceof ForwardLearningPrerequisiteError/);
  assert.match(route, /awaiting_pattern_window/);
  assert.match(route, /status:\s*425/);
});
