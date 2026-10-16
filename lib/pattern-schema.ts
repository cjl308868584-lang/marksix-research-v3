const runtime = globalThis as typeof globalThis & { __marksixD1?: D1Database };
const ready = new WeakMap<D1Database, Promise<void>>();
export async function ensurePatternSchema() {
  const db = runtime.__marksixD1;
  if (!db) return false;
  let pending = ready.get(db);
  if (!pending) {
    pending = (async () => {
      for (const sql of SCHEMA.split(';').map(x => x.trim()).filter(Boolean)) await db.prepare(sql).run();
    })().catch(error => { ready.delete(db); throw error; });
    ready.set(db, pending);
  }
  await pending;
  return true;
}
const SCHEMA = `CREATE TABLE IF NOT EXISTS lottery_draws (
  draw_id text PRIMARY KEY NOT NULL, game text NOT NULL, issue text NOT NULL,
  draw_at text NOT NULL, main_1 integer NOT NULL, main_2 integer NOT NULL,
  main_3 integer NOT NULL, main_4 integer NOT NULL, main_5 integer NOT NULL,
  main_6 integer NOT NULL, special integer NOT NULL, source_grade text NOT NULL,
  verified integer NOT NULL DEFAULT 0, source_hash text NOT NULL,
  available_at text NOT NULL, ingested_at text NOT NULL, dataset_version text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS lottery_draws_game_issue_idx
  ON lottery_draws (game, issue);
CREATE INDEX IF NOT EXISTS lottery_draws_game_draw_at_idx
  ON lottery_draws (game, draw_at);
CREATE INDEX IF NOT EXISTS lottery_draws_dataset_idx
  ON lottery_draws (dataset_version);
CREATE TABLE IF NOT EXISTS rolling_pattern_runs (
  run_id text PRIMARY KEY NOT NULL, game text NOT NULL,
  source_issue text NOT NULL, target_issue text NOT NULL,
  window_oldest_issue text NOT NULL, window_newest_issue text NOT NULL,
  window_data_hash text NOT NULL, engine_version text NOT NULL,
  status text NOT NULL, generated_at text NOT NULL, frozen_at text NOT NULL,
  run_json text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS rolling_pattern_target_idx
  ON rolling_pattern_runs (game, target_issue, window_data_hash, engine_version);
CREATE TABLE IF NOT EXISTS rolling_pattern_signals (
  run_id text NOT NULL, rule_id text NOT NULL, game text NOT NULL,
  target_issue text NOT NULL, rule_family text NOT NULL,
  event_family text NOT NULL, event_value text NOT NULL,
  sample_label text NOT NULL, signal_json text NOT NULL, frozen_at text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS rolling_pattern_signal_identity_idx
  ON rolling_pattern_signals (run_id, rule_id);
CREATE INDEX IF NOT EXISTS rolling_pattern_signal_filter_idx
  ON rolling_pattern_signals (game, target_issue, event_family);
CREATE TABLE IF NOT EXISTS rolling_pattern_scores (
  run_id text NOT NULL, rule_id text NOT NULL, game text NOT NULL,
  target_issue text NOT NULL, actual_matched integer NOT NULL,
  score_json text NOT NULL, scored_at text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS rolling_pattern_score_identity_idx
  ON rolling_pattern_scores (run_id, rule_id);
CREATE INDEX IF NOT EXISTS rolling_pattern_score_issue_idx
  ON rolling_pattern_scores (game, target_issue);
CREATE TABLE IF NOT EXISTS rolling_pattern_consensus_ledger (
  run_id text NOT NULL, product_id text NOT NULL, game text NOT NULL,
  target_issue text NOT NULL, scope text NOT NULL, product_kind text NOT NULL,
  result_key text NOT NULL, rank integer NOT NULL,
  product_json text NOT NULL, frozen_at text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS rolling_pattern_consensus_identity_idx
  ON rolling_pattern_consensus_ledger (run_id, product_id);
CREATE INDEX IF NOT EXISTS rolling_pattern_consensus_issue_idx
  ON rolling_pattern_consensus_ledger (game, target_issue, scope);
CREATE TABLE IF NOT EXISTS rolling_pattern_consensus_scores (
  run_id text NOT NULL, product_id text NOT NULL, game text NOT NULL,
  target_issue text NOT NULL, scope text NOT NULL, product_kind text NOT NULL,
  actual_matched integer NOT NULL, unit_profit real NOT NULL,
  actual_json text NOT NULL, score_json text NOT NULL, scored_at text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS rolling_pattern_consensus_score_identity_idx
  ON rolling_pattern_consensus_scores (run_id, product_id);
CREATE INDEX IF NOT EXISTS rolling_pattern_consensus_score_issue_idx
  ON rolling_pattern_consensus_scores (game, target_issue, scope);
CREATE TABLE IF NOT EXISTS rolling_pattern_review_snapshots (
  run_id text PRIMARY KEY NOT NULL, game text NOT NULL,
  target_issue text NOT NULL, snapshot_json text NOT NULL,
  frozen_at text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS rolling_pattern_review_snapshot_issue_idx
  ON rolling_pattern_review_snapshots (game, target_issue);
CREATE TABLE IF NOT EXISTS rolling_pattern_review_scores (
  run_id text PRIMARY KEY NOT NULL, game text NOT NULL,
  target_issue text NOT NULL, actual_json text NOT NULL,
  score_json text NOT NULL, scored_at text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS rolling_pattern_review_score_issue_idx
  ON rolling_pattern_review_scores (game, target_issue);
`;
