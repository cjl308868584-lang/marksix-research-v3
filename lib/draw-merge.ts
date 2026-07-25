type MergeableDraw = {
  game: string;
  issue: string;
  verified: boolean;
};

/**
 * Merge refreshed draws without letting stale single-source data overwrite a
 * verified result. At equal quality, the incoming record wins so corrections
 * and metadata upgrades are reflected immediately.
 */
export function mergeDrawLists<T extends MergeableDraw>(
  current: T[],
  incoming: T[],
  limit = 120,
): T[] {
  const merged = new Map<string, T>();
  current.forEach((draw) => {
    merged.set(`${draw.game}:${draw.issue}`, draw);
  });
  incoming.forEach((draw) => {
    const key = `${draw.game}:${draw.issue}`;
    const existing = merged.get(key);
    if (!existing || draw.verified || !existing.verified) {
      merged.set(key, draw);
    }
  });
  return [...merged.values()]
    .sort((left, right) =>
      right.issue.localeCompare(left.issue, "en", { numeric: true })
    )
    .slice(0, limit);
}
