import { nextIssue } from './ai-engine';
import { GAME_IDS, nextScheduledDraw, type Draw, type GameId } from './lottery';
import { loadPatternHistory } from './pattern-history';
import { ensurePatternSchema } from './pattern-schema';
import { runRollingPatternCycle } from './rolling-pattern-service';
import { settleRollingPatternRuns } from './rolling-pattern-store';

export async function persistPatternDraws(draws: Draw[], now: Date) {
  if (!await ensurePatternSchema()) throw new Error('pattern database unavailable');
  const db = (globalThis as typeof globalThis & { __marksixD1?: D1Database }).__marksixD1!;
  const statements = draws.filter(d => d.verified).map(draw => {
    return db.prepare(`INSERT INTO lottery_draws
      (draw_id,game,issue,draw_at,main_1,main_2,main_3,main_4,main_5,main_6,special,
       source_grade,verified,source_hash,available_at,ingested_at,dataset_version)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,'cross_verified',1,?,?,?,'pattern-feed-v1')
      ON CONFLICT(game,issue) DO UPDATE SET verified=1, source_grade='cross_verified',
        draw_at=excluded.draw_at, main_1=excluded.main_1, main_2=excluded.main_2,
        main_3=excluded.main_3, main_4=excluded.main_4, main_5=excluded.main_5,
        main_6=excluded.main_6, special=excluded.special, source_hash=excluded.source_hash,
        ingested_at=excluded.ingested_at, dataset_version=excluded.dataset_version
      WHERE lottery_draws.verified=0 OR (lottery_draws.main_1=excluded.main_1 AND lottery_draws.main_2=excluded.main_2
        AND lottery_draws.main_3=excluded.main_3 AND lottery_draws.main_4=excluded.main_4
        AND lottery_draws.main_5=excluded.main_5 AND lottery_draws.main_6=excluded.main_6
        AND lottery_draws.special=excluded.special)`).bind(
      `${draw.game}:${draw.issue}`,draw.game,draw.issue,draw.drawAt,...draw.numbers,draw.special,
      draw.source,draw.drawAt,now.toISOString(),
    );
  });
  for (let i = 0; i < statements.length; i += 80) {
    const results = await db.batch(statements.slice(i, i + 80));
    if (results.some(result => Number(result.meta?.changes ?? 0) !== 1)) {
      throw new Error('stored verified draw conflicts with current evidence');
    }
  }
}
const defaults = {
  load: loadPatternHistory, settle: settleRollingPatternRuns,
  cycle: runRollingPatternCycle, persistDraws: persistPatternDraws,
};

/** Waiting is transient. Only immutable pattern runs, never waiting responses, are reused. */
export async function runPatternUpdate(
  { game, now = new Date() }: { game: GameId; now?: Date },
  dependencies = defaults,
) {
  if (!GAME_IDS.includes(game)) throw new Error('unsupported game');
  const history = await dependencies.load(game, now);
  const latest = history.draws[0];
  if (!latest) throw new Error('history unavailable');
  await dependencies.persistDraws(history.draws, now);
  if (await dependencies.settle(game, history.draws, now.toISOString()) !== 'ok') {
    throw new Error('pattern settlement unavailable');
  }
  if (!latest.verified) return { status: 'awaiting_verification', latestIssue: latest.issue };
  const expectedDrawAt = nextScheduledDraw(game, new Date(latest.drawAt)).toISOString();
  if (now.getTime() >= Date.parse(expectedDrawAt)) {
    return { status: 'awaiting_current_result', latestIssue: latest.issue };
  }
  const targetIssue = nextIssue(latest.issue);
  const rollingPatterns = await dependencies.cycle({
    game, draws: history.draws, targetIssue, expectedDrawAt, generatedAt: now.toISOString(),
  });
  return { status: rollingPatterns.status, targetIssue, rollingPatterns, immutable: true };
}
