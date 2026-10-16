import { loadServerDraws } from './lottery-data';
import { getLotteryDraws } from './lottery-feed';
import { mergeDrawLists } from './draw-merge';
import { isValidDraw, type Draw, type GameId } from './lottery';

/** Use the same latest verification as the public feed, with deep history for scans. */
async function readStoredDraws(game: GameId, now: Date): Promise<Draw[]> {
  const db = (globalThis as typeof globalThis & {__marksixD1?: D1Database}).__marksixD1;
  if (!db) return [];
  const rows = await db.prepare(`SELECT issue,draw_at,main_1,main_2,main_3,main_4,main_5,main_6,special
    FROM lottery_draws WHERE game=? AND verified=1 ORDER BY CAST(issue AS INTEGER) DESC LIMIT 500`)
    .bind(game).all<{issue:string;draw_at:string;main_1:number;main_2:number;main_3:number;main_4:number;main_5:number;main_6:number;special:number}>();
  return (rows.results ?? []).map(row => ({
    game,issue:row.issue,drawAt:row.draw_at,numbers:[row.main_1,row.main_2,row.main_3,row.main_4,row.main_5,row.main_6],
    special:row.special,source:'stored-cross-verified',verified:true,
  })).filter(draw => isValidDraw(draw) && Date.parse(draw.drawAt) <= now.getTime());
}

const sources = {feed:getLotteryDraws,history:loadServerDraws,stored:readStoredDraws};
export async function loadPatternHistory(game: GameId, now = new Date(), dependencies = sources) {
  // A Worker has a bounded number of outbound connections. Fetch the latest feed
  // before deep history so ten history requests cannot starve latest verification.
  const feed = await dependencies.feed(game,120);
  const history = await dependencies.history(game,500,now);
  const stored = await dependencies.stored(game,now);
  const merged = reconcilePatternDraws(stored,history.draws,now);
  return { draws: reconcilePatternDraws(merged,feed.draws,now) };
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
