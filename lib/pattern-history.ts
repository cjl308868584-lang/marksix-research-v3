import { loadServerDraws } from './lottery-data';
import { getLotteryDraws } from './lottery-feed';
import { mergeDrawLists } from './draw-merge';
import type { Draw, GameId } from './lottery';

/** Use the same latest verification as the public feed, with deep history for scans. */
export async function loadPatternHistory(game: GameId, now = new Date()) {
  const [history, feed] = await Promise.all([
    loadServerDraws(game, 500, now),
    getLotteryDraws(game, 120),
  ]);
  return { draws: reconcilePatternDraws(history.draws, feed.draws, now) };
}

export function reconcilePatternDraws(history: Draw[], feed: Draw[], now: Date): Draw[] {
  const eligible = (draw: Draw) => Date.parse(draw.drawAt) <= now.getTime();
  const old = new Map(history.map(draw => [`${draw.game}:${draw.issue}`, draw]));
  for (const draw of feed.filter(eligible)) {
    const previous = old.get(`${draw.game}:${draw.issue}`);
    if (previous?.verified && draw.verified &&
      [...previous.numbers, previous.special].join(',') !== [...draw.numbers, draw.special].join(',')) {
      throw new Error(`verified draw conflict: ${draw.game}:${draw.issue}`);
    }
  }
  return mergeDrawLists(history.filter(eligible), feed.filter(eligible), 500);
}
