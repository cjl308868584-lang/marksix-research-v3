import { nextIssue } from "./ai-engine";
import { loadServerDraws } from "./lottery-data";
import { GAME_IDS, nextScheduledDraw, type GameId } from "./lottery";
import { buildResearchSnapshot } from "./research-v2-engine";
import {
  readPreviousResearchSnapshot,
  readResearchSnapshot,
  ensureResearchRuleLedger,
  persistResearchRun,
  settleResearchForecasts,
} from "./research-v2-store";
import type {
  ResearchRunEnvelope,
  ResearchSnapshot,
} from "./research-v2-types";

const MAX_RESEARCH_HISTORY = 160;
const CACHE_TTL_MS = 10 * 60_000;

const runtime = globalThis as typeof globalThis & {
  __marksixResearchCache?: Map<
    string,
    { expiresAt: number; envelope: ResearchRunEnvelope }
  >;
};

const cache =
  runtime.__marksixResearchCache ??
  new Map<string, { expiresAt: number; envelope: ResearchRunEnvelope }>();
runtime.__marksixResearchCache = cache;

export async function loadResearchEnvelope({
  game,
  asOf = new Date(),
  forceCompute = false,
}: {
  game: GameId;
  asOf?: Date;
  forceCompute?: boolean;
}): Promise<ResearchRunEnvelope> {
  if (!GAME_IDS.includes(game)) throw new Error("unsupported game");
  const history = await loadServerDraws(game, MAX_RESEARCH_HISTORY, asOf);
  await settleResearchForecasts(game, history.draws, asOf.toISOString());
  const latest = history.draws[0];
  if (!latest) throw new Error("history unavailable");
  const expectedDrawAt = nextScheduledDraw(game, asOf).toISOString();
  const targetIssue = nextIssue(latest.issue);
  const cacheKey = [
    game,
    targetIssue,
    expectedDrawAt,
    latest.issue,
    latest.drawAt,
    history.draws.length,
    history.draws.filter((draw) => draw.verified).length,
  ].join(":");
  const cached = cache.get(cacheKey);
  if (!forceCompute && cached && cached.expiresAt > Date.now()) {
    return cached.envelope;
  }
  if (!forceCompute) {
    const stored = await readResearchSnapshot(game, targetIssue);
    if (stored && stored.expectedDrawAt === expectedDrawAt) {
      await ensureResearchRuleLedger(stored);
      const envelope: ResearchRunEnvelope = {
        snapshot: stored,
        rules: [
          ...stored.verifiedRules,
          ...stored.experimentalRules,
          ...stored.negativeRules,
        ],
        source: "stored",
      };
      cache.set(cacheKey, {
        expiresAt: Date.now() + CACHE_TTL_MS,
        envelope,
      });
      return envelope;
    }
  }
  const previous = await readPreviousResearchSnapshot(game, expectedDrawAt);
  const snapshot = buildResearchSnapshot({
    game,
    draws: history.draws,
    targetIssue,
    expectedDrawAt,
    generatedAt: asOf.toISOString(),
    previous,
  });
  const envelope: ResearchRunEnvelope = {
    snapshot,
    rules: [
      ...snapshot.verifiedRules,
      ...snapshot.experimentalRules,
      ...snapshot.negativeRules,
    ],
    source: history.sourceMode === "snapshot" ? "snapshot" : "computed",
  };
  // The local fallback is still frozen immutably. A later Python/GitHub retry
  // with the same runId receives "existing" and cannot replace this forecast.
  await persistResearchRun(envelope);
  cache.set(cacheKey, {
    expiresAt: Date.now() + CACHE_TTL_MS,
    envelope,
  });
  pruneCache();
  return envelope;
}

export function compactResearchSnapshot(
  snapshot: ResearchSnapshot,
): ResearchSnapshot {
  return {
    ...snapshot,
    targetForecasts: snapshot.targetForecasts,
    verifiedRules: snapshot.verifiedRules.slice(0, 20),
    experimentalRules: snapshot.experimentalRules.slice(0, 24),
    negativeRules: snapshot.negativeRules.slice(0, 16),
  };
}

function pruneCache() {
  if (cache.size <= 12) return;
  const now = Date.now();
  cache.forEach((entry, key) => {
    if (entry.expiresAt <= now) cache.delete(key);
  });
  while (cache.size > 12) {
    const oldest = cache.keys().next().value;
    if (typeof oldest !== "string") break;
    cache.delete(oldest);
  }
}
