import type { GameId } from "./lottery";

export const ROLLING_PATTERN_ENGINE_VERSION = "rolling-patterns-v1";

export type RollingPatternFamily = "zodiac" | "tail" | "wave" | "head";

export type RollingPatternEvent = {
  eventId: string;
  family: RollingPatternFamily;
  value: string;
  label: string;
  threshold: 1 | 2 | 3;
  memberCount: number;
};

export type RollingPatternEventState = {
  issue: string;
  drawAt: string;
  matched: boolean;
  count: number;
};

export type RollingPatternWindow = {
  game: GameId;
  drawCount: number;
  oldestIssue: string;
  newestIssue: string;
  dataHash: string;
};
