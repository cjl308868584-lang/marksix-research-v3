import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server.js';
import test, { before, after } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createServer, type ViteDevServer } from 'vite';
let server: ViteDevServer;
let store: any;
let update: any;
const db = new DatabaseSync(':memory:');
class Statement {
  values: any[] = [];
  sql: string;
  constructor(sql: string) { this.sql = sql; }
  bind(...values: any[]) { this.values = values; return this; }
  async run() { return { meta: { changes: Number(db.prepare(this.sql).run(...this.values).changes) } }; }
  async first() { return db.prepare(this.sql).get(...this.values) ?? null; }
  async all() { return { results: db.prepare(this.sql).all(...this.values) }; }
}
before(async () => {
  (globalThis as any).__marksixD1 = {
    prepare: (sql: string) => new Statement(sql),
    batch: (items: Statement[]) => Promise.all(items.map(x => x.run())),
  };
  server = await createServer({ configFile: false, server: { middlewareMode: true }, logLevel: 'silent' });
  store = await server.ssrLoadModule('/lib/rolling-pattern-store.ts');
});
after(async () => { await server.close(); db.close(); delete (globalThis as any).__marksixD1; });
test('latest completed patterns do not depend on a strategy forecast table', async () => {
  await store.ensureRollingPatternStore();
  // A syntactically valid envelope is not needed to expose the query dependency:
  // capture the selected row by substituting a known run built by the real engine.
  const { buildRollingPatternRun } = await server.ssrLoadModule('/lib/rolling-pattern-engine.ts');
  const draws = Array.from({ length: 30 }, (_, i) => ({ game: 'new_macau', issue: String(2026200+i), drawAt: new Date(Date.UTC(2026,6,1+i,13,32)).toISOString(), numbers: [1,2,3,4,5,6], special: 7, source: 'test', verified: true }));
  const run = await buildRollingPatternRun({ game:'new_macau', draws, targetIssue:'2026230', expectedDrawAt:'2026-08-01T13:32:00Z', generatedAt:'2026-07-30T14:00:00Z' });
  assert.equal(await store.persistRollingPatternRun(run), 'created');
  db.exec('DROP TABLE IF EXISTS research_v3_forecasts');
  assert.equal((await store.readRollingPatternRun('new_macau'))?.run.runId, run.runId);
});
test('a waiting cycle can advance after the same draw becomes verified', async () => {
  try { update = await server.ssrLoadModule('/lib/pattern-update-service.ts'); } catch { update = {}; }
  assert.equal(typeof update.runPatternUpdate, 'function', 'independent retryable pattern updater is required');
  let verified = false; let settlements = 0; let scans = 0;
  const deps = {
    load: async () => ({ draws:[{ game:'new_macau',issue:'2026288',drawAt:'2026-10-15T13:32:00Z', numbers:[1,2,3,4,5,6],special:7,source:'test',verified }] }),
    settle: async () => { settlements++; return 'ok'; },
    cycle: async (input: any) => { scans++; assert.equal(input.targetIssue, '2026289'); return {status:'created',runId:'rp_next',qualified:2}; },
    persistDraws: async () => {},
  };
  const args = { game:'new_macau', now:new Date('2026-10-16T09:00:00Z') };
  assert.equal((await update.runPatternUpdate(args,deps)).status,'awaiting_verification');
  verified = true;
  assert.equal((await update.runPatternUpdate(args,deps)).targetIssue,'2026289');
  assert.equal(settlements,2); assert.equal(scans,1);
});
test('a missed cutoff still settles known draws without inventing a late prediction', async () => {
  assert.equal(typeof update?.runPatternUpdate,'function');
  let settled = false;
  const result = await update.runPatternUpdate({game:'new_macau',now:new Date('2026-10-17T09:00:00Z')},{
    load:async()=>({draws:[{game:'new_macau',issue:'2026288',drawAt:'2026-10-15T13:32:00Z',numbers:[1,2,3,4,5,6],special:7,source:'test',verified:true}]}),
    persistDraws:async()=>{}, settle:async()=>{settled=true;return 'ok';},cycle:async()=>{throw new Error('must not freeze after cutoff');},
  });
  assert.equal(settled,true); assert.equal(result.status,'awaiting_current_result');
});

test('canonical verification upgrades history without admitting future results or verified conflicts', async () => {
  const { reconcilePatternDraws } = await server.ssrLoadModule('/lib/pattern-history.ts');
  const draw = { game:'new_macau',issue:'2026288',drawAt:'2026-10-15T13:32:00Z',numbers:[1,2,3,4,5,6],special:7,source:'history',verified:false };
  const canonical = {...draw,verified:true,source:'canonical'};
  const now = new Date('2026-10-16T09:00:00Z');
  const merged = reconcilePatternDraws([draw],[canonical,{...canonical,issue:'2026289',drawAt:'2026-10-16T13:32:00Z'}],now);
  assert.equal(merged.length,1); assert.equal(merged[0].verified,true);
  assert.throws(()=>reconcilePatternDraws([canonical],[{...canonical,special:8}],now),/verified draw conflict/);
});

test('verified evidence corrects a stored unverified row, but cannot overwrite a different verified result', async () => {
  const { persistPatternDraws } = await server.ssrLoadModule('/lib/pattern-update-service.ts');
  const now = new Date('2026-10-16T09:00:00Z');
  const draw = { game:'new_macau',issue:'2026288',drawAt:'2026-10-15T13:32:00Z',numbers:[1,2,3,4,5,6],special:7,source:'canonical',verified:true };
  db.prepare(`INSERT INTO lottery_draws VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('old','new_macau','2026288',draw.drawAt,1,2,3,4,5,6,8,'single',0,'old',draw.drawAt,draw.drawAt,'old');
  await persistPatternDraws([draw],now);
  assert.equal(db.prepare(`SELECT special FROM lottery_draws WHERE issue='2026288'`).get()?.special,7);
  await assert.rejects(persistPatternDraws([{...draw,special:9}],now),/conflicts/);
  assert.equal(db.prepare(`SELECT special FROM lottery_draws WHERE issue='2026288'`).get()?.special,7);
});

test('signed pattern writer rejects malformed payloads and stale or forged signatures before work', async () => {
  (globalThis as any).__marksixBindings = {RESEARCH_INGEST_SECRET:'contract-secret'};
  const route = await server.ssrLoadModule('/app/api/internal/patterns/settle-and-freeze/route.ts');
  async function request(payload: unknown, timestamp = String(Date.now()), forged = false) {
    const body = JSON.stringify(payload);
    const signature = forged ? '0'.repeat(64) : createHmac('sha256','contract-secret').update(timestamp+'.'+body).digest('hex');
    return route.POST(new NextRequest('https://test/api/internal/patterns/settle-and-freeze',{method:'POST',headers:{'content-type':'application/json','x-research-timestamp':timestamp,'x-research-signature':signature},body}));
  }
  assert.equal((await request(null)).status,400);
  assert.equal((await request({game:'new_macau',taskId:'contract-task',asOf:'2099-01-01'})).status,400);
  assert.equal((await request({game:'new_macau',taskId:'contract-task'},String(Date.now()-600000))).status,401);
  assert.equal((await request({game:'new_macau',taskId:'contract-task'},String(Date.now()),true)).status,401);
  delete (globalThis as any).__marksixBindings;
});

test('latest canonical feed finishes before deep-history requests can occupy outbound connections', async () => {
  const { loadPatternHistory } = await server.ssrLoadModule('/lib/pattern-history.ts');
  const calls: string[] = [];
  await loadPatternHistory('new_macau',new Date('2026-10-16T09:00:00Z'),{
    feed: async () => { calls.push('feed-start'); await Promise.resolve(); calls.push('feed-done'); return {draws:[]}; },
    history: async () => { calls.push('history-start'); return {draws:[]}; },
    stored: async () => [],
  });
  assert.deepEqual(calls,['feed-start','feed-done','history-start']);
});

test('temporary upstream fallback retains already stored verified history', async () => {
  const { loadPatternHistory } = await server.ssrLoadModule('/lib/pattern-history.ts');
  const verified = {game:'new_macau',issue:'2026288',drawAt:'2026-10-15T13:32:00Z',numbers:[1,2,3,4,5,6],special:7,source:'stored-cross-verified',verified:true};
  const stale = {...verified,issue:'2026203',drawAt:'2026-07-22T13:32:00Z',verified:false};
  const result = await loadPatternHistory('new_macau',new Date('2026-10-16T09:00:00Z'),{
    feed:async()=>({draws:[stale]}),history:async()=>({draws:[stale]}),stored:async()=>[verified],
  });
  assert.equal(result.draws[0].issue,'2026288'); assert.equal(result.draws[0].verified,true);
});
