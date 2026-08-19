import type { Draw, GameId } from "./lottery.ts";
import type { RollingPatternRun } from "./rolling-pattern-types.ts";
import {
  buildForwardLearningCandidates,
  selectOfficialForecasts,
  type ForwardResultHistory,
} from "./forward-learning-engine.ts";
import { binaryLogLoss, updateExpertWeights } from "./forward-learning-math.ts";
import {
  claimForwardLearningRun,
  completeForwardLearningRun,
  freezeForwardLearningIssue,
  persistForwardLearningModelStates,
  persistForwardRuleUpdates,
  readForwardCandidateHistory,
  readForwardLearningCandidates,
  readForwardLearningForecast,
  readForwardLearningModel,
  readForwardRuleWeights,
  settleForwardLearningIssue,
} from "./forward-learning-store.ts";
import {
  FORWARD_LEARNING_ENGINE_VERSION,
  FORWARD_LEARNING_SLOTS,
  type ExpertWeights,
  type ForwardLearningCandidate,
  type ForwardLearningCycleResult,
  type ForwardLearningForecast,
  type ForwardLearningModelState,
  type ForwardLearningRun,
  type ForwardLearningScore,
  type ForwardRuleUpdate,
} from "./forward-learning-types.ts";

type Settlement = Awaited<ReturnType<typeof settleForwardLearningIssue>>;

export type ForwardLearningDependencies = {
  readForecast: (game: GameId, issue?: string | null) => Promise<ForwardLearningForecast[]>;
  settle: (game: GameId, draw: Draw, scoredAt: string) => Promise<Settlement>;
  readCandidates: (game: GameId, issue: string) => Promise<ForwardLearningCandidate[]>;
  readModel: (game: GameId) => Promise<ForwardLearningModelState[]>;
  readHistory: (game: GameId) => Promise<Map<string, ForwardResultHistory>>;
  readRuleWeights: (game: GameId) => Promise<Map<string, number>>;
  persistStates: (states: readonly ForwardLearningModelState[]) => Promise<"ok" | "unavailable">;
  persistRuleUpdates: (updates: readonly ForwardRuleUpdate[]) => Promise<"ok" | "unavailable">;
  freeze: (
    candidates: readonly ForwardLearningCandidate[],
    forecasts: readonly ForwardLearningForecast[],
  ) => Promise<"created" | "existing" | "unavailable" | "invalid">;
  claimRun: (run: ForwardLearningRun) => Promise<"claimed" | "existing" | "unavailable">;
  completeRun: (run: ForwardLearningRun) => Promise<boolean>;
};

const DEFAULT_DEPENDENCIES: ForwardLearningDependencies = {
  readForecast: readForwardLearningForecast,
  settle: settleForwardLearningIssue,
  readCandidates: readForwardLearningCandidates,
  readModel: readForwardLearningModel,
  readHistory: readForwardCandidateHistory,
  readRuleWeights: readForwardRuleWeights,
  persistStates: persistForwardLearningModelStates,
  persistRuleUpdates: persistForwardRuleUpdates,
  freeze: freezeForwardLearningIssue,
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
  if (!envelope) {
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
  if (input.rollingRun.game !== input.game) throw new Error("学习运行彩种不一致");
  const verified = [...input.draws]
    .filter((draw) =>
      draw.game === input.game &&
      draw.verified &&
      draw.issue.localeCompare(input.rollingRun.targetIssue, "en", { numeric: true }) < 0
    )
    .sort((left, right) => right.issue.localeCompare(left.issue, "en", { numeric: true }));
  const existingNext = await dependencies.readForecast(input.game, input.rollingRun.targetIssue);
  let previousDraw: Draw | null = null;
  let previousForecasts: ForwardLearningForecast[] = [];
  if (verified.length > 0) {
    const latestVerified = verified[0];
    const latestVerifiedForecasts = await dependencies.readForecast(input.game, latestVerified.issue);
    if (latestVerifiedForecasts.length === FORWARD_LEARNING_SLOTS.length) {
      previousDraw = latestVerified;
      previousForecasts = latestVerifiedForecasts;
    } else if (existingNext.length !== FORWARD_LEARNING_SLOTS.length) {
      const latestFrozen = await dependencies.readForecast(input.game);
      const frozenIssue = latestFrozen[0]?.targetIssue ?? null;
      const matchingDraw = frozenIssue
        ? verified.find((draw) => draw.issue === frozenIssue) ?? null
        : null;
      if (matchingDraw && latestFrozen.length === FORWARD_LEARNING_SLOTS.length) {
        previousDraw = matchingDraw;
        previousForecasts = latestFrozen;
      }
    }
  }

  let modelStates = await dependencies.readModel(input.game);
  let run: ForwardLearningRun | null = null;
  if (previousDraw) {
    run = learningRun(input, previousDraw.issue, modelStates);
    const claim = await dependencies.claimRun(run);
    if (claim === "unavailable") throw new Error("逐期学习任务账本不可用");
    const settlement = await dependencies.settle(
      input.game,
      previousDraw,
      input.now.toISOString(),
    );
    if (settlement.status === "not_found") throw new Error("找不到开奖前冻结的学习预测");
    const learnedSlots = new Set(modelStates
      .filter((state) => state.learnedThroughIssue === previousDraw.issue)
      .map((state) => state.slot));
    if (learnedSlots.size > 0 && learnedSlots.size !== FORWARD_LEARNING_SLOTS.length) {
      throw new Error("逐期学习模型状态不完整，拒绝重复或部分更新");
    }
    const modelAlreadyLearned = learnedSlots.size === FORWARD_LEARNING_SLOTS.length;
    if (claim === "existing" && settlement.status === "existing") {
      if (existingNext.length === FORWARD_LEARNING_SLOTS.length && modelAlreadyLearned) {
        await completeRecoveredRun(run, modelStates, input.now, dependencies);
        return {
          status: "existing",
          runId: run.runId,
          settledIssue: previousDraw.issue,
          targetIssue: input.rollingRun.targetIssue,
          modelVersion: modelStates[0]?.version ?? `${FORWARD_LEARNING_ENGINE_VERSION}:bootstrap`,
          forecasts: existingNext,
        };
      }
    }
    const previousCandidates = await dependencies.readCandidates(input.game, previousDraw.issue);
    if (!modelAlreadyLearned) {
      modelStates = updateModelStates(
        input.game,
        previousDraw.issue,
        input.now.toISOString(),
        modelStates,
        previousCandidates,
        settlement.scores,
      );
      if (await dependencies.persistStates(modelStates) !== "ok") {
        throw new Error("新模型状态未能持久化");
      }
    }
    const priorRuleWeights = await dependencies.readRuleWeights(input.game);
    const ruleUpdates = buildRuleUpdates(
      run.runId,
      previousDraw.issue,
      previousForecasts,
      settlement.scores,
      priorRuleWeights,
    );
    if (await dependencies.persistRuleUpdates(ruleUpdates) !== "ok") {
      throw new Error("规则学习变化未能持久化");
    }
  }

  if (existingNext.length === FORWARD_LEARNING_SLOTS.length) {
    if (run) {
      await completeRecoveredRun(run, modelStates, input.now, dependencies);
    }
    return {
      status: "existing",
      runId: run?.runId ?? null,
      settledIssue: previousDraw?.issue ?? null,
      targetIssue: input.rollingRun.targetIssue,
      modelVersion: modelStates[0]?.version ?? `${FORWARD_LEARNING_ENGINE_VERSION}:bootstrap`,
      forecasts: existingNext,
    };
  }

  const [history, ruleWeights] = await Promise.all([
    dependencies.readHistory(input.game),
    dependencies.readRuleWeights(input.game),
  ]);
  const candidates = buildForwardLearningCandidates(input.rollingRun, {
    modelStates,
    resultHistory: history,
    ruleWeights,
  });
  const forecasts = selectOfficialForecasts(candidates, previousForecasts);
  if (forecasts.length !== FORWARD_LEARNING_SLOTS.length) {
    throw new Error("未能生成完整五槽位预测");
  }
  const freeze = await dependencies.freeze(candidates, forecasts);
  if (freeze === "invalid" || freeze === "unavailable") {
    throw new Error("下一期逐期学习预测未能冻结");
  }
  if (run) {
    const completed = {
      ...run,
      status: "completed" as const,
      modelVersionAfter: modelStates[0]?.version ?? null,
      completedAt: input.now.toISOString(),
    };
    if (!await dependencies.completeRun(completed)) {
      throw new Error("逐期学习任务未能完成记账");
    }
  }
  return {
    status: freeze,
    runId: run?.runId ?? null,
    settledIssue: previousDraw?.issue ?? null,
    targetIssue: input.rollingRun.targetIssue,
    modelVersion: modelStates[0]?.version ?? `${FORWARD_LEARNING_ENGINE_VERSION}:bootstrap`,
    forecasts,
  };
}

async function completeRecoveredRun(
  run: ForwardLearningRun,
  modelStates: readonly ForwardLearningModelState[],
  now: Date,
  dependencies: ForwardLearningDependencies,
) {
  const completed = {
    ...run,
    status: "completed" as const,
    modelVersionAfter: modelStates[0]?.version ?? null,
    completedAt: now.toISOString(),
  };
  if (!await dependencies.completeRun(completed)) {
    throw new Error("逐期学习任务未能完成记账");
  }
}

function updateModelStates(
  game: GameId,
  settledIssue: string,
  generatedAt: string,
  previous: readonly ForwardLearningModelState[],
  candidates: readonly ForwardLearningCandidate[],
  scores: readonly ForwardLearningScore[],
) {
  const scoreByCandidate = new Map(scores.map((score) => [score.candidateId, score]));
  return FORWARD_LEARNING_SLOTS.map((slot) => {
    const before = previous.find((state) => state.slot === slot);
    const weights = before?.weights ?? { baseline: 0.34, rules30: 0.33, forward: 0.33 };
    const slotCandidates = candidates.filter((candidate) =>
      candidate.slot === slot && scoreByCandidate.has(candidate.candidateId)
    );
    const losses = slotCandidates.length
      ? meanExpertLoss(slotCandidates, scoreByCandidate)
      : { baseline: 0, rules30: 0, forward: 0 };
    const nextWeights = slotCandidates.length ? updateExpertWeights(weights, losses) : weights;
    const version = `${FORWARD_LEARNING_ENGINE_VERSION}:${settledIssue}`;
    return {
      stateId: `state:${game}:${slot}:${version}`,
      game,
      slot,
      version,
      weights: nextWeights,
      previousVersion: before?.version ?? null,
      learnedThroughIssue: settledIssue,
      generatedAt,
    } satisfies ForwardLearningModelState;
  });
}

function meanExpertLoss(
  candidates: readonly ForwardLearningCandidate[],
  scores: ReadonlyMap<string, ForwardLearningScore>,
): ExpertWeights {
  const total: ExpertWeights = { baseline: 0, rules30: 0, forward: 0 };
  for (const candidate of candidates) {
    const score = scores.get(candidate.candidateId)!;
    for (const key of ["baseline", "rules30", "forward"] as const) {
      total[key] += binaryLogLoss(candidate.expertProbabilities[key], score.actualMatched);
    }
  }
  for (const key of ["baseline", "rules30", "forward"] as const) {
    total[key] /= candidates.length;
  }
  return total;
}

function buildRuleUpdates(
  runId: string,
  settledIssue: string,
  forecasts: readonly ForwardLearningForecast[],
  scores: readonly ForwardLearningScore[],
  previousWeights: ReadonlyMap<string, number>,
) {
  const scoreByCandidate = new Map(scores.map((score) => [score.candidateId, score]));
  const updates = new Map<string, ForwardRuleUpdate>();
  for (const forecast of forecasts) {
    const score = scoreByCandidate.get(forecast.candidateId);
    if (!score) continue;
    for (const contribution of forecast.ruleContributions) {
      const before = previousWeights.get(`${forecast.slot}:${contribution.ruleId}`) ?? 1;
      const eligibleReward = score.actualMatched &&
        forecast.finalProbability > forecast.baselineProbability;
      const after = eligibleReward
        ? Math.min(2, before * 1.03)
        : score.actualMatched
          ? before
          : Math.max(0.2, before * 0.95);
      updates.set(`${forecast.slot}:${contribution.ruleId}`, {
        runId,
        game: forecast.game,
        settledIssue,
        slot: forecast.slot,
        ruleId: contribution.ruleId,
        beforeWeight: before,
        afterWeight: after,
        action: after > before ? "rewarded" : after < before ? "reduced" : "unchanged",
        reason: after > before
          ? "正式前瞻命中且概率高于自身基线"
          : after < before
            ? "正式前瞻失败，有限降权"
            : "虽命中但没有超过自身随机基线，不奖励",
      });
    }
  }
  return [...updates.values()];
}

function learningRun(
  input: { game: GameId; rollingRun: RollingPatternRun; now: Date },
  settledIssue: string,
  states: readonly ForwardLearningModelState[],
): ForwardLearningRun {
  const runId = `learning:${input.game}:${settledIssue}:${FORWARD_LEARNING_ENGINE_VERSION}`;
  return {
    runId,
    taskId: runId,
    game: input.game,
    settledIssue,
    targetIssue: input.rollingRun.targetIssue,
    engineVersion: FORWARD_LEARNING_ENGINE_VERSION,
    status: "processing",
    modelVersionBefore: states[0]?.version ?? null,
    modelVersionAfter: null,
    error: null,
    startedAt: input.now.toISOString(),
    completedAt: null,
  };
}
