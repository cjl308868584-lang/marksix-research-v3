# Sites Migration and Model Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move 六合智研 v3 to the current `c308868584` Sites account, preserve its immutable research history, update the model, and remove the standalone Cloudflare deployment only after production verification.

**Architecture:** Sites becomes the only production web, API, persistence, and model runtime. A timestamped local export is the recovery source for the existing Cloudflare D1 data. GitHub remains source control, but standalone Cloudflare deployment and scheduled workflows are retired after Sites passes end-to-end settlement and next-period freezing.

**Tech Stack:** Vinext/Next, TypeScript, Cloudflare-compatible Worker output, Sites managed D1, Python research kernel, GitHub, Node test runner.

## Global Constraints

- Preserve only Hong Kong and New Macau; New Macau remains the default.
- Formal output contains exactly four high-probability events and never concrete number predictions.
- Settlement must score a frozen pre-draw forecast before learning the result.
- Unverified draws must not settle or update model state.
- Failed learning keeps the previous champion and frozen forecast immutable.
- Standalone Cloudflare resources are deleted only after the Sites deployment passes production verification.
- Preserve a restorable local export and its SHA-256 checksum before deletion.

---

### Task 1: Export and Audit the Standalone Cloudflare State

**Files:**
- Create: `backups/cloudflare-2026-08-04/manifest.json`
- Create: `backups/cloudflare-2026-08-04/marksix-research-v3-db.sql`
- Create: `backups/cloudflare-2026-08-04/marksix-research-v3-db.sha256`

**Interfaces:**
- Consumes: Cloudflare D1 database `marksix-research-v3-db`.
- Produces: immutable SQL backup plus checksum and row-count manifest.

- [ ] **Step 1: Query the table inventory and material row counts**

Run a read-only D1 query against `sqlite_master`, then count rows in research forecast, review, learning-run, model-weight, rule-state, and task-ledger tables. Save the exact counts in `manifest.json`.

- [ ] **Step 2: Export the complete remote database**

Run `wrangler d1 export marksix-research-v3-db --remote --output backups/cloudflare-2026-08-04/marksix-research-v3-db.sql`.

- [ ] **Step 3: Create and verify the checksum**

Run `shasum -a 256` on the SQL export, save the result, and verify it with `shasum -a 256 -c`.

- [ ] **Step 4: Confirm the backup contains the immutable ledgers**

Run `rg 'research_event_ledger|research_event_scores|research_learning_runs|research_model_weights|research_rule_states'` against the SQL export. Expected: every named table is present.

### Task 2: Prepare the Sites-Owned Project

**Files:**
- Modify: `.openai/hosting.json`
- Modify: `wrangler.jsonc`
- Modify: `vite.config.ts`
- Test: `tests/sites-deployment.test.mjs`

**Interfaces:**
- Consumes: existing Sites `project_id` when accessible in `c308868584`.
- Produces: one Sites-owned logical `DB` binding with no standalone Cloudflare database ID.

- [ ] **Step 1: Write a failing hosting ownership test**

Assert `.openai/hosting.json` contains only the Sites project ID and logical `d1: "DB"`, while production source contains no standalone D1 database ID or workers.dev URL.

- [ ] **Step 2: Run the deployment test and confirm failure**

Run `node --test tests/sites-deployment.test.mjs`. Expected: failure because standalone Cloudflare identifiers remain.

- [ ] **Step 3: Remove standalone deployment coupling**

Keep the Sites plugin and logical database declaration, remove the fixed standalone database identifier and Cloudflare-specific production deployment path, and preserve local development bindings.

- [ ] **Step 4: Run the deployment test and typecheck**

Run `node --test tests/sites-deployment.test.mjs && npm run typecheck`. Expected: pass.

### Task 3: Make Model Updates Sites-Safe

**Files:**
- Modify: `lib/research-v3-service.ts`
- Modify: `lib/research-v3-store.ts`
- Modify: `app/api/internal/research/settle-and-learn/route.ts`
- Test: `tests/research-v3.test.ts`
- Test: `tests/research-v3-store.test.ts`

**Interfaces:**
- Consumes: verified draw history, frozen snapshot, previous model weights, Python artifact.
- Produces: `ResearchV3Envelope` for the next issue and one idempotent `ResearchEventReview` for the settled issue.

- [ ] **Step 1: Add regression tests for settle-before-learn**

Test that the review uses the weights frozen before the result, the result appears only in the next training sample, and replaying the same task ID returns the original response.

- [ ] **Step 2: Add regression tests for resource-safe execution**

Test that unverified results return the stored forecast without settlement, verified results settle once, and a failed next-model build leaves the previous champion intact.

- [ ] **Step 3: Implement the minimal Sites-safe cycle**

Keep I/O phases separate from model calculation, reuse persisted artifacts, and commit review, model state, and next forecast only through idempotent store operations.

- [ ] **Step 4: Run focused model tests**

Run `node --test tests/research-v3.test.ts tests/research-v3-store.test.ts`. Expected: pass.

### Task 4: Import the Historical Ledger into Sites

**Files:**
- Create: `.openai/drizzle/0001_research_v3.sql` only if the target project lacks the current schema.
- Create: `scripts/verify-sites-ledger.mjs`

**Interfaces:**
- Consumes: Task 1 SQL export and Sites-managed `DB` binding.
- Produces: matching forecast, review, learning-run, model-weight, and rule-state row counts.

- [ ] **Step 1: Inspect the target Sites database schema**

Compare table names and schema versions with the exported database. Do not overwrite any newer Sites record.

- [ ] **Step 2: Import missing immutable records**

Use primary keys and `INSERT OR IGNORE` semantics so the import is restartable and cannot duplicate learning.

- [ ] **Step 3: Verify row counts and immutable hashes**

Run `node scripts/verify-sites-ledger.mjs`. Expected: all required source rows exist in Sites and conflicting immutable rows equal their source hashes.

### Task 5: Build and Publish to the Current Sites Account

**Files:**
- Modify: `.openai/hosting.json` only when Sites assigns a new `project_id`.
- Generated: `dist/**`

**Interfaces:**
- Consumes: validated source and target Sites project.
- Produces: public `chatgpt.site` deployment owned by `c308868584`.

- [ ] **Step 1: Run the complete validation suite**

Run `npm test`. Expected: all TypeScript, Python, rendered-page, API, model, and deployment tests pass.

- [ ] **Step 2: Build the exact production archive**

Run `npm run build`, then package `dist`, hosting metadata, and migrations with the Sites packaging helper.

- [ ] **Step 3: Save and deploy one Sites version**

Publish the validated branch-head version to the accessible Sites project and poll until deployment reports `succeeded`.

- [ ] **Step 4: Open the deployed URL**

Open the exact successful deployment URL in the Codex browser handoff.

### Task 6: Production Verification and Model Refresh

**Files:**
- No source changes unless verification exposes a reproducible defect.

**Interfaces:**
- Consumes: deployed Sites APIs.
- Produces: evidence that both games can read forecasts and one verified game can settle and freeze the next issue.

- [ ] **Step 1: Verify forecast shape for both games**

Call `/api/research/forecast` for `hk` and `new_macau`. Expected: HTTP 200, exactly four events, and no event with `family: "number"`.

- [ ] **Step 2: Verify preserved review history**

Call `/api/research/reviews`, `/performance`, and `/learning-runs`. Expected: the imported New Macau 2026215 review remains reconstructable.

- [ ] **Step 3: Execute one signed idempotent learning cycle**

Submit the same task twice. Expected: the first request settles/freezes or awaits verification; the second returns the identical stored response and creates no duplicate review.

- [ ] **Step 4: Verify the next target and mobile routes**

Confirm the next target issue is later than the settled issue, refreshes do not change frozen probabilities, and `/`, `/research`, and `/research/review` all return successfully.

### Task 7: Retire Standalone Cloudflare Resources

**Files:**
- Delete: `.github/workflows/deploy-cloudflare.yml`
- Modify: `.github/workflows/research-v2.yml` to target Sites, or delete it when Sites owns scheduling.
- Modify: `package.json` to remove standalone deployment scripts.
- Test: `tests/sites-deployment.test.mjs`

**Interfaces:**
- Consumes: successful Task 6 verification and Task 1 backup.
- Produces: no standalone Worker, D1, or Cloudflare deployment secret remains.

- [ ] **Step 1: Disable standalone GitHub automation**

Remove the standalone deployment workflow and Cloudflare-only secrets after the Sites scheduler is confirmed.

- [ ] **Step 2: Delete the standalone Worker**

Delete only `marksix-research-v3`, then verify the workers.dev URL no longer serves the application.

- [ ] **Step 3: Delete the standalone D1 database**

Delete only database ID `b55d1eaa-847a-4079-ab17-a140c2ae3345` after rechecking the backup checksum and Sites ledger counts.

- [ ] **Step 4: Remove obsolete tokens and deployment configuration**

Delete the dedicated Cloudflare API token and repository secrets used only by the retired deployment.

- [ ] **Step 5: Run final Sites health checks**

Repeat Task 6 reads after Cloudflare deletion. Expected: the Sites URL and all core APIs remain healthy.

### Task 8: Final Verification and Commit

**Files:**
- Modify: this plan to check completed steps.

**Interfaces:**
- Consumes: all prior task outputs.
- Produces: clean source tree and auditable migration record.

- [ ] **Step 1: Run the full test suite again**

Run `npm test`. Expected: pass.

- [ ] **Step 2: Inspect repository state**

Run `git diff --check && git status --short`. Expected: no accidental generated credentials or unrelated changes.

- [ ] **Step 3: Commit and push the completed migration**

Commit the source, migration metadata, and non-secret backup manifest. Never commit SQL data containing operational records or any secret.
