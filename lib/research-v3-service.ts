import { nextIssue } from "./ai-engine";
import { loadServerDraws } from "./lottery-data";
import { GAME_IDS, nextScheduledDraw, type GameId } from "./lottery";
import { buildResearchV3Snapshot } from "./research-v3-engine";
import {
  countSettledResearchV3Forecasts,
  ensureResearchV3Store,
  persistResearchV3Snapshot,
  readChampionChallengeState,
  readLatestModelWeights,
  readResearchV3Snapshot,
  settleResearchV3Forecasts,
} from "./research-v3-store";
import type {
  ResearchV3Envelope,
} from "./research-v3-types";

const MAX_RESEARCH_HISTORY = 500;
const CACHE_TTL_MS = 10 * 60_000;
const LEGACY_RESEARCH_ORIGIN =
  "https://marksix-intelligence-cn.m308868584.chatgpt.site";

const runtime = globalThis as typeof globalThis & {
  __marksixResearchV3Cache?: Map<
    string,
    { expiresAt: number; envelope: ResearchV3Envelope }
  >;
};

const cache =
  runtime.__marksixResearchV3Cache ??
  new Map<string, { expiresAt: number; envelope: ResearchV3Envelope }>();
runtime.__marksixResearchV3Cache = cache;

export async function loadResearchV3Envelope({
  game,
  asOf = new Date(),
  forceCompute = false,
}: {
  game: GameId;
  asOf?: Date;
  forceCompute?: boolean;
}): Promise<ResearchV3Envelope> {
  if (!GAME_IDS.includes(game)) throw new Error("unsupported game");
  const history = await loadServerDraws(game, MAX_RESEARCH_HISTORY, asOf);
  const latest = history.draws[0];
  if (!latest) throw new Error("history unavailable");
  await ensureResearchV3Store();
  await importLegacySnapshot(game, latest.issue);
  await settleResearchV3Forecasts(game, history.draws, asOf.toISOString());
  if (!latest.verified) {
    const frozen =
      await readResearchV3Snapshot(game, latest.issue) ??
      await readResearchV3Snapshot(game);
    if (frozen) {
      return { snapshot: frozen, source: "stored" };
    }
    throw new Error("latest draw is awaiting independent verification");
  }
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
    const stored = await readResearchV3Snapshot(game, targetIssue);
    if (stored && stored.expectedDrawAt === expectedDrawAt) {
      const envelope: ResearchV3Envelope = {
        snapshot: stored,
        source: "stored",
      };
      cache.set(cacheKey, {
        expiresAt: Date.now() + CACHE_TTL_MS,
        envelope,
      });
      return envelope;
    }
  }
  const [previousWeights, settledForecasts, challengeState] = await Promise.all([
    readLatestModelWeights(game),
    countSettledResearchV3Forecasts(game),
    readChampionChallengeState(game),
  ]);
  const snapshot = buildResearchV3Snapshot({
    game,
    draws: history.draws,
    targetIssue,
    expectedDrawAt,
    generatedAt: asOf.toISOString(),
    sourceMode: history.sourceMode,
    sourceWarning: history.warning,
    previousWeights,
    settledForecasts,
    champion: challengeState.champion,
    challenger: challengeState.challenger,
  });
  const envelope: ResearchV3Envelope = {
    snapshot,
    source: history.sourceMode === "snapshot" ? "snapshot" : "computed",
  };
  const persistence = await persistResearchV3Snapshot(snapshot);
  if (persistence === "existing") {
    const immutable = await readResearchV3Snapshot(game, targetIssue);
    if (immutable) {
      const storedEnvelope: ResearchV3Envelope = {
        snapshot: immutable,
        source: "stored",
      };
      cache.set(cacheKey, {
        expiresAt: Date.now() + CACHE_TTL_MS,
        envelope: storedEnvelope,
      });
      return storedEnvelope;
    }
  }
  cache.set(cacheKey, {
    expiresAt: Date.now() + CACHE_TTL_MS,
    envelope,
  });
  pruneCache();
  return envelope;
}

async function importLegacySnapshot(game: GameId, issue: string) {
  if (await readResearchV3Snapshot(game, issue)) return;
  try {
    const response = await fetch(
      `${LEGACY_RESEARCH_ORIGIN}/api/research/forecast?game=${game}&issue=${encodeURIComponent(issue)}`,
      { cache: "no-store", headers: { accept: "application/json" } },
    );
    if (!response.ok) return;
    const snapshot = await response.json() as Parameters<
      typeof persistResearchV3Snapshot
    >[0];
    if (
      snapshot.game !== game ||
      snapshot.targetIssue !== issue ||
      Date.parse(snapshot.frozenAt) >= Date.parse(snapshot.expectedDrawAt)
    ) return;
    await persistResearchV3Snapshot(snapshot);
  } catch {
    // Migration is best effort; live prediction remains available without it.
  }
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
