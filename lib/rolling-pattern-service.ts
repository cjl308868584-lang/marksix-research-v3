import type { Draw, GameId } from "./lottery";
import { buildRollingPatternRun } from "./rolling-pattern-engine";
import {
  persistRollingPatternRun,
  settleRollingPatternRuns,
} from "./rolling-pattern-store";
import type {
  RollingPatternCycleResult,
  RollingPatternRun,
} from "./rolling-pattern-types";

type RollingPatternCycleInput = {
  game: GameId;
  draws: Draw[];
  targetIssue: string;
  expectedDrawAt: string;
  generatedAt: string;
};

type RollingPatternCycleDependencies = {
  settle: (
    game: GameId,
    draws: Draw[],
    settledAt: string,
  ) => Promise<"ok" | "unavailable">;
  build: (input: RollingPatternCycleInput) => Promise<RollingPatternRun>;
  persist: (
    run: RollingPatternRun,
  ) => Promise<"created" | "existing" | "invalid" | "unavailable">;
};

const defaultDependencies: RollingPatternCycleDependencies = {
  settle: settleRollingPatternRuns,
  build: buildRollingPatternRun,
  persist: persistRollingPatternRun,
};

export async function runRollingPatternCycle(
  input: RollingPatternCycleInput,
  dependencies: RollingPatternCycleDependencies = defaultDependencies,
): Promise<Exclude<RollingPatternCycleResult, { status: "failed" }>> {
  const settlement = await dependencies.settle(
    input.game,
    input.draws,
    input.generatedAt,
  );
  if (settlement !== "ok") {
    throw new Error("rolling pattern settlement unavailable");
  }
  const verified = input.draws.filter(
    (draw) => draw.game === input.game && draw.verified,
  );
  if (verified.length < 30) {
    return {
      status: "insufficient_data",
      missing: 30 - verified.length,
      qualified: 0,
    };
  }
  const run = await dependencies.build({
    ...input,
    draws: verified,
  });
  const persistence = await dependencies.persist(run);
  if (persistence !== "created" && persistence !== "existing") {
    throw new Error("rolling pattern freeze unavailable");
  }
  return {
    status: persistence,
    runId: run.runId,
    qualified: run.signals.length,
  };
}
