import type { Draw, GameId } from "./lottery.ts";
import { buildUnifiedRollingPatternProducts, selectMandatoryProductRecommendations } from "./rolling-pattern-value.ts";
import type {
  ProductHistoryCounts,
  RollingPatternRun,
  UnifiedProductHistories,
} from "./rolling-pattern-types.ts";
import {
  freezeForwardLearningRevision,
  persistForwardLearningRollout,
  readForwardLearningRollout,
  readForwardLearningScoreCount,
  readResolvedForwardSnapshot,
  readUnifiedCandidateHistory,
  settleResolvedForwardSnapshot,
} from "./forward-learning-v2-store.ts";
import {
  claimForwardLearningRun,
  completeForwardLearningRun,
} from "./forward-learning-store.ts";
import {
  FORWARD_LEARNING_SLOTS,
  type ForwardLearningCycleResult,
  type ForwardLearningForecast,
  type ForwardLearningRevisionSnapshot,
  type ForwardLearningRollout,
  type ForwardLearningRun,
  type ResolvedForwardSnapshot,
  type ResolvedSettlement,
} from "./forward-learning-types.ts";
import {
  NEW_MACAU_2026231_ROLLOUT,
} from "./forward-learning-rollouts.ts";
import {
  canCorrectV1Bootstrap,
  hashAuthoritativeRecommendations,
  mapProductsToRevisionSnapshot,
} from "./unified-product-learning.ts";

const UNIFIED_MODEL_VERSION = "rolling-product-ev-v2";

export type ForwardLearningDependencies = {
  readResolved: (
    game: GameId,
    issue?: string | null,
  ) => Promise<ResolvedForwardSnapshot | null>;
  settleResolved: (
    game: GameId,
    draw: Draw,
    scoredAt: string,
  ) => Promise<ResolvedSettlement>;
  readRollout: (game: GameId) => Promise<ForwardLearningRollout | null>;
  persistRollout: (
    rollout: ForwardLearningRollout,
  ) => Promise<"created" | "existing" | "conflict" | "unavailable">;
  readLegacyHistory: (
    game: GameId,
    beforeIssue: string,
  ) => Promise<{
    legacy: Map<string, ProductHistoryCounts>;
    legacyProductIds: Map<string, string>;
  } | null>;
  readV2History: (
    game: GameId,
    beforeIssue: string,
  ) => Promise<ReadonlyMap<string, ProductHistoryCounts>>;
  readScoreCount: (game: GameId, targetIssue: string) => Promise<number>;
  freezeRevision: (
    snapshot: ForwardLearningRevisionSnapshot,
  ) => Promise<"created" | "existing" | "conflict" | "unavailable">;
  claimRun: (
    run: ForwardLearningRun,
  ) => Promise<"claimed" | "existing" | "unavailable">;
  completeRun: (run: ForwardLearningRun) => Promise<boolean>;
};

const DEFAULT_DEPENDENCIES: ForwardLearningDependencies = {
  readResolved: readResolvedForwardSnapshot,
  settleResolved: settleResolvedForwardSnapshot,
  readRollout: readForwardLearningRollout,
  persistRollout: async (rollout) => {
    try {
      return await persistForwardLearningRollout(rollout);
    } catch {
      return "unavailable";
    }
  },
  readLegacyHistory: async (game, beforeIssue) => {
    const { readBoundedLegacyProductHistory } = await import("./rolling-pattern-store.ts");
    return readBoundedLegacyProductHistory(game, beforeIssue);
  },
  readV2History: async (game, beforeIssue) => {
    const history = await readUnifiedCandidateHistory(game, beforeIssue);
    return new Map([...history].map(([key, value]) => [
      key,
      { settledCount: value.settledCount, hitCount: value.hitCount },
    ]));
  },
  readScoreCount: readForwardLearningScoreCount,
  freezeRevision: freezeForwardLearningRevision,
  claimRun: claimForwardLearningRun,
  completeRun: completeForwardLearningRun,
};

export class ForwardLearningPrerequisiteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForwardLearningPrerequisiteError";
  }
}

export async function runStoredForwardLearningCycle({
  game,
  asOf = new Date(),
}: {
  game: GameId;
  asOf?: Date;
}) {
  const [{ loadServerDraws }, { readRollingPatternRun }] = await Promise.all([
    import("./lottery-data.ts"),
    import("./rolling-pattern-store.ts"),
  ]);
  const [history, envelope] = await Promise.all([
    loadServerDraws(game, 500, asOf),
    readRollingPatternRun(game),
  ]);
  if (!envelope || envelope.run.status !== "completed") {
    throw new ForwardLearningPrerequisiteError("当前30期规律尚未冻结");
  }
  return runForwardLearningCycle({
    game,
    draws: history.draws,
    rollingRun: envelope.run,
    now: asOf,
  });
}

export async function runForwardLearningCycle(
  input: {
    game: GameId;
    draws: Draw[];
    rollingRun: RollingPatternRun;
    now: Date;
  },
  dependencies: ForwardLearningDependencies = DEFAULT_DEPENDENCIES,
): Promise<ForwardLearningCycleResult> {
  validateCycleInput(input);
  let rollout = await resolveStoredOrFixedRollout(input.rollingRun, dependencies);
  if (rollout === "unavailable") return awaitingRollout(input.rollingRun.targetIssue);

  const existing = await dependencies.readResolved(
    input.game,
    input.rollingRun.targetIssue,
  );
  const prior = rollout
    ? await findPriorResolvedV2(input, rollout, dependencies)
    : null;
  let learningRun: ForwardLearningRun | null = null;
  let priorForecasts: readonly ForwardLearningForecast[] = [];
  if (prior) {
    learningRun = buildLearningRun(input, prior.draw.issue);
    const claim = await dependencies.claimRun(learningRun);
    if (claim === "unavailable") throw new Error("逐期学习任务账本不可用");
    const settlement = await dependencies.settleResolved(
      input.game,
      prior.draw,
      input.now.toISOString(),
    );
    if (settlement.status === "not_found" || settlement.source !== "v2") {
      throw new Error("找不到可结算的已提交v2预测");
    }
    priorForecasts = prior.snapshot.forecasts as ForwardLearningForecast[];
  }

  if (existing?.source === "v2") {
    if (!rollout) return awaitingRollout(input.rollingRun.targetIssue);
    if (learningRun) await completeLearningRun(learningRun, input.now, dependencies);
    return resolvedResult("existing", existing, learningRun?.runId ?? null, prior?.draw.issue ?? null);
  }
  if (existing?.source === "v1" && !isNewMacauBootstrap(input.rollingRun)) {
    if (learningRun) await completeLearningRun(learningRun, input.now, dependencies);
    return resolvedResult("existing", existing, learningRun?.runId ?? null, prior?.draw.issue ?? null);
  }

  const revision = existing?.source === "v1" ? 2 : 1;
  let state = await buildUnifiedState(
    input,
    rollout?.firstUnifiedTargetIssue ?? input.rollingRun.targetIssue,
    revision,
    dependencies,
  );
  if (!rollout) {
    const proposed = initialRollout(
      input.rollingRun,
      hashAuthoritativeRecommendations(state.recommendations),
    );
    const persisted = await dependencies.persistRollout(proposed);
    if (persisted === "unavailable") return awaitingRollout(input.rollingRun.targetIssue);
    if (persisted === "conflict") {
      const concurrent = await dependencies.readRollout(input.game);
      if (!concurrent || !rolloutAppliesToRun(concurrent, input.rollingRun)) {
        return awaitingRollout(input.rollingRun.targetIssue);
      }
      rollout = concurrent;
      state = await buildUnifiedState(
        input,
        rollout.firstUnifiedTargetIssue,
        revision,
        dependencies,
      );
    } else {
      rollout = proposed;
    }
  }
  const snapshot = mapProductsToRevisionSnapshot({
    run: input.rollingRun,
    products: state.products,
    recommendations: state.recommendations,
    rollout,
    revision,
    reason: revision === 2 ? "correct-v1-bootstrap" : "initial",
    previousForecasts: priorForecasts,
  });
  if (input.rollingRun.targetIssue === rollout.firstUnifiedTargetIssue &&
    rollout.authoritativeRecommendationHash !== snapshot.recommendationHash) {
    throw new Error("首期权威五项哈希与不可变启动记录不一致");
  }

  if (existing?.source === "v1") {
    const verifiedMatchingDraw = input.draws.find((draw) =>
      draw.game === input.game && draw.issue === input.rollingRun.targetIssue && draw.verified
    ) ?? null;
    const scoreCount = await dependencies.readScoreCount(
      input.game,
      input.rollingRun.targetIssue,
    );
    const gate = canCorrectV1Bootstrap({
      game: input.game,
      targetIssue: input.rollingRun.targetIssue,
      run: input.rollingRun,
      rollout,
      recommendationHash: snapshot.recommendationHash,
      existing,
      scoreCount,
      verifiedMatchingDraw,
      now: input.now,
    });
    if (!gate.allowed) {
      if (learningRun) await completeLearningRun(learningRun, input.now, dependencies);
      return resolvedResult("existing", existing, learningRun?.runId ?? null, prior?.draw.issue ?? null);
    }
  }

  const freeze = await dependencies.freezeRevision(snapshot);
  if (freeze === "conflict" || freeze === "unavailable") {
    throw new Error("统一逐期学习修订未能完整冻结");
  }
  if (learningRun) await completeLearningRun(learningRun, input.now, dependencies);
  return {
    status: freeze,
    runId: learningRun?.runId ?? null,
    settledIssue: prior?.draw.issue ?? null,
    targetIssue: input.rollingRun.targetIssue,
    revision,
    modelVersion: UNIFIED_MODEL_VERSION,
    forecasts: snapshot.forecasts,
  };
}

async function resolveStoredOrFixedRollout(
  run: RollingPatternRun,
  dependencies: ForwardLearningDependencies,
): Promise<ForwardLearningRollout | null | "unavailable"> {
  const stored = await dependencies.readRollout(run.game);
  if (!isNewMacauBootstrap(run)) {
    if (!stored) return null;
    return rolloutAppliesToRun(stored, run) ? stored : "unavailable";
  }
  const persisted = await dependencies.persistRollout(NEW_MACAU_2026231_ROLLOUT);
  if (persisted === "conflict" || persisted === "unavailable") return "unavailable";
  return NEW_MACAU_2026231_ROLLOUT;
}

function initialRollout(
  run: RollingPatternRun,
  authoritativeRecommendationHash: string,
): ForwardLearningRollout {
  return {
    game: run.game,
    firstUnifiedTargetIssue: run.targetIssue,
    legacySeedThroughIssue: run.sourceIssue,
    seedQueryVersion: "legacy-target-cutoff-v1",
    sourceRunId: run.runId,
    sourceDataHash: run.window.dataHash,
    authoritativeRecommendationHash,
    createdAt: run.frozenAt,
  };
}

async function buildUnifiedState(
  input: {
    game: GameId;
    rollingRun: RollingPatternRun;
  },
  firstUnifiedTargetIssue: string,
  revision: number,
  dependencies: ForwardLearningDependencies,
) {
  const legacy = await dependencies.readLegacyHistory(
    input.game,
    firstUnifiedTargetIssue,
  );
  if (!legacy) {
    throw new ForwardLearningPrerequisiteError("旧产品种子历史不可用");
  }
  const learned = await dependencies.readV2History(
    input.game,
    input.rollingRun.targetIssue,
  );
  const histories: UnifiedProductHistories = {
    legacy: legacy.legacy,
    learned,
    legacyProductIds: legacy.legacyProductIds,
  };
  const products = buildUnifiedRollingPatternProducts(input.rollingRun, histories);
  return {
    products,
    recommendations: selectMandatoryProductRecommendations(products, revision),
  };
}

function rolloutAppliesToRun(
  rollout: ForwardLearningRollout,
  run: RollingPatternRun,
) {
  if (rollout.game !== run.game ||
    compareIssues(run.targetIssue, rollout.firstUnifiedTargetIssue) < 0 ||
    rollout.seedQueryVersion !== "legacy-target-cutoff-v1" ||
    compareIssues(rollout.legacySeedThroughIssue, rollout.firstUnifiedTargetIssue) >= 0 ||
    !rollout.firstUnifiedTargetIssue.trim() ||
    !rollout.legacySeedThroughIssue.trim() ||
    !rollout.sourceRunId.trim() ||
    !rollout.sourceDataHash.trim() ||
    !rollout.authoritativeRecommendationHash.trim() ||
    !Number.isFinite(Date.parse(rollout.createdAt))) return false;
  return run.targetIssue !== rollout.firstUnifiedTargetIssue || (
    rollout.sourceRunId === run.runId &&
    rollout.sourceDataHash === run.window.dataHash
  );
}

async function findPriorResolvedV2(
  input: {
    game: GameId;
    draws: Draw[];
    rollingRun: RollingPatternRun;
  },
  rollout: ForwardLearningRollout,
  dependencies: ForwardLearningDependencies,
) {
  const verified = [...input.draws]
    .filter((draw) =>
      draw.game === input.game && draw.verified &&
      compareIssues(draw.issue, input.rollingRun.targetIssue) < 0 &&
      compareIssues(draw.issue, rollout.firstUnifiedTargetIssue) >= 0
    )
    .sort((left, right) => compareIssues(right.issue, left.issue));
  for (const draw of verified) {
    const snapshot = await dependencies.readResolved(input.game, draw.issue);
    if (snapshot?.source === "v2" &&
      snapshot.forecasts.length === FORWARD_LEARNING_SLOTS.length) {
      return { draw, snapshot };
    }
  }
  return null;
}

function validateCycleInput(input: {
  game: GameId;
  rollingRun: RollingPatternRun;
  now: Date;
}) {
  if (input.rollingRun.game !== input.game) throw new Error("学习运行彩种不一致");
  if (input.rollingRun.status !== "completed") throw new Error("只能学习已完成的冻结规律运行");
  if (!Number.isFinite(input.now.getTime())) throw new Error("学习时间无效");
}

function isNewMacauBootstrap(run: RollingPatternRun) {
  return run.game === "new_macau" && run.targetIssue === "2026231";
}

function buildLearningRun(
  input: { game: GameId; rollingRun: RollingPatternRun; now: Date },
  settledIssue: string,
): ForwardLearningRun {
  const runId = `learning:${input.game}:${settledIssue}:${UNIFIED_MODEL_VERSION}`;
  return {
    runId,
    taskId: runId,
    game: input.game,
    settledIssue,
    targetIssue: input.rollingRun.targetIssue,
    engineVersion: UNIFIED_MODEL_VERSION,
    status: "processing",
    modelVersionBefore: UNIFIED_MODEL_VERSION,
    modelVersionAfter: null,
    error: null,
    startedAt: input.now.toISOString(),
    completedAt: null,
  };
}

async function completeLearningRun(
  run: ForwardLearningRun,
  now: Date,
  dependencies: ForwardLearningDependencies,
) {
  if (!await dependencies.completeRun({
    ...run,
    status: "completed",
    modelVersionAfter: UNIFIED_MODEL_VERSION,
    completedAt: now.toISOString(),
  })) {
    throw new Error("逐期学习任务未能完成记账");
  }
}

function resolvedResult(
  status: "existing",
  snapshot: ResolvedForwardSnapshot,
  runId: string | null,
  settledIssue: string | null,
): ForwardLearningCycleResult {
  return {
    status,
    runId,
    settledIssue,
    targetIssue: snapshot.targetIssue,
    revision: snapshot.revision,
    modelVersion: snapshot.source === "v2" ? UNIFIED_MODEL_VERSION : "forward-learning-v1",
    forecasts: snapshot.forecasts as ForwardLearningForecast[],
  };
}

function awaitingRollout(targetIssue: string): ForwardLearningCycleResult {
  return {
    status: "awaiting_rollout",
    runId: null,
    settledIssue: null,
    targetIssue,
    revision: null,
    modelVersion: UNIFIED_MODEL_VERSION,
    forecasts: [],
  };
}

function compareIssues(left: string, right: string) {
  return left.localeCompare(right, "en", { numeric: true });
}
