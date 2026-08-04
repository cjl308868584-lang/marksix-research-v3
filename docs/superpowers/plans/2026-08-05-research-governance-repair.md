# Research v3 Governance Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make production probabilities scientifically isolated from shadow research, repair validation and promotion auditing, remove vulnerable dependencies, and migrate CI actions off Node 20.

**Architecture:** Preserve the current Sites/D1 immutable ledger and four-slot API. Add an explicit formal-versus-experimental probability boundary, selected-pipeline outer walk-forward evidence, issue-level champion evaluation, and promotion-aware learning-run persistence.

**Tech Stack:** TypeScript, Node.js 22, Next/Vinext, D1 SQLite, Python 3.12, GitHub Actions, Sites.

## Global Constraints

- Do not change the four fixed high-probability strategy slots.
- Do not output concrete 01-49 number predictions.
- Never score a forecast frozen at or after draw time.
- Never let an unverified or shadow model change formal probability.
- Count one draw issue, not four event rows, as one independent forward sample.
- Preserve previous champions and forecasts on any failed update.

---

### Task 1: Patch production dependencies

**Files:** Modify `package.json`, `package-lock.json`.

- [ ] Add an audit assertion documenting that Next.js 16.2.6 is unacceptable.
- [ ] Run the assertion and confirm it fails on 16.2.6.
- [ ] Upgrade Next.js and compatible transitive dependencies to a patched release.
- [ ] Run build, tests, and production-only audit.
- [ ] Commit the isolated dependency upgrade.

### Task 2: Separate formal and experimental probability

**Files:** Modify `lib/research-v3-types.ts`, `lib/research-v3-engine.ts`, UI consumers, and `tests/research-v3.test.ts`.

- [ ] Add failing tests showing baseline-only Python rules and shadow logistic output cannot alter `probability`.
- [ ] Add `experimentalProbability` and explicit formal expert selection.
- [ ] Keep expert diagnostics and shadow rationale visible without mixing tracks.
- [ ] Run focused and rendered-page tests.
- [ ] Commit the probability boundary.

### Task 3: Repair formal promotion state

**Files:** Modify v3 types, store, service, engine, D1 migration if required, and store tests.

- [ ] Add failing tests for unreachable `verified` and unsafe historical-only promotion.
- [ ] Persist verified champion/promotion evidence by game and slot.
- [ ] Generate `verified` only from persisted evidence satisfying all gates.
- [ ] Prove baseline/shadow remains the fallback when evidence is missing.
- [ ] Commit the formal-state repair.

### Task 4: Validate the complete selection pipeline

**Files:** Modify `lib/research-v3-engine.ts` or a focused selection-validation module and its tests.

- [ ] Add a future-data and random-winner regression test for outer selection.
- [ ] Implement expanding-window candidate selection and next-row scoring.
- [ ] Use out-of-fold selected observations for history and promotion metrics.
- [ ] Confirm fair-random histories do not manufacture selected advantage.
- [ ] Commit outer walk-forward validation.

### Task 5: Strengthen champion challenge and audit

**Files:** Modify `lib/research-v3-store.ts`, `lib/research-v3-review.ts`, service orchestration, types, and tests.

- [ ] Add failing tests proving four events count as one issue and weak improvements do not promote.
- [ ] Add issue-level Brier/calibration aggregates, minimum margin, confidence lower bound, and random-audit gate.
- [ ] Calculate promotion before learning-run persistence.
- [ ] Persist accurate `championAfter`, `challengerPromoted`, and rejection reason.
- [ ] Commit champion governance and audit repair.

### Task 6: Upgrade GitHub Actions runtimes

**Files:** Modify `.github/workflows/research-v2.yml`, `.github/workflows/research-v2-monthly.yml`, deployment tests.

- [ ] Add/adjust workflow assertions for Node 24-backed action majors.
- [ ] Confirm the old action versions fail the assertion.
- [ ] Upgrade checkout, setup-python, upload-artifact, and setup-node.
- [ ] Run deployment tests and YAML inspection.
- [ ] Commit the workflow upgrade.

### Task 7: Full verification and Sites publication

**Files:** No product changes unless verification finds a regression.

- [ ] Run all Node and Python tests, typecheck, production build, dependency audit, and deployment tests.
- [ ] Inspect the generated Sites archive and migration set.
- [ ] Publish the exact verified commit to the existing c308868584 Sites project.
- [ ] Confirm deployment success and read-only forecast, review, performance, model, and learning-run APIs.
- [ ] Confirm the next scheduled cycle still uses 21:40, 21:50, and 22:04 Beijing triggers.
