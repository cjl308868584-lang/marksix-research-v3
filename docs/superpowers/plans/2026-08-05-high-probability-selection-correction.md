# Research v3.1 High-Probability Selection Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the four fixed slots optimize calibrated absolute probability without presenting unverified candidates as formal predictions.

**Architecture:** Keep the immutable v3 ledger and expert ensemble. Add an explicit decision status, gate research candidates with selected out-of-fold evidence, default the production champion to the exact baseline, and render formal abstention separately from research candidates.

**Tech Stack:** TypeScript, Node.js 22, Next/Vinext, D1 SQLite, Python 3.12, GitHub Actions, Sites.

---

### Task 1: Lock corrected selection behavior with tests

**Files:** Modify `tests/research-v3.test.ts`, `tests/research-v3-store.test.ts`, and `tests/rendered-html.test.mjs`.

- [ ] Add a candidate-selection regression where a lower absolute probability has higher relative uplift and assert the higher calibrated probability wins.
- [ ] Add a negative out-of-fold regression and assert the event abstains.
- [ ] Add assertions that an unpromoted snapshot reports `baseline` champion and no formal direction.
- [ ] Run focused tests and confirm they fail for the current selector and wording.

### Task 2: Implement selection status and compatibility

**Files:** Modify `lib/research-v3-types.ts`, `lib/research-v3-engine.ts`, and `lib/research-v3-store.ts`.

- [ ] Add `decisionStatus` and `selectionObjective` to new snapshots.
- [ ] Rank eligible candidates by experimental absolute probability, then Brier skill, then deterministic identity.
- [ ] Require positive out-of-fold Brier skill and 80% non-worse folds; otherwise emit abstention.
- [ ] Project legacy snapshots to the new public shape without changing frozen values.
- [ ] Run focused engine and store tests until green.

### Task 3: Correct champion governance and promotion wording

**Files:** Modify `lib/research-v3-store.ts`, `lib/research-v3-review.ts`, and related tests.

- [ ] Default unverified champion state to `baseline` while retaining interpretable rules and logistic as challengers.
- [ ] Replace every 20-issue promotion statement with the implemented 50-independent-issue gate.
- [ ] Verify a single result never promotes or changes a frozen forecast.

### Task 4: Separate formal abstention from research display

**Files:** Modify `app/research/ResearchWorkspace.tsx`, `app/research/review/ResearchReviewWorkspace.tsx`, and `app/globals.css`.

- [ ] Render “正式层暂无已验证方向” whenever `decisionStatus` is not `formal`.
- [ ] Render the research candidate and experimental probability in a clearly labelled subordinate block.
- [ ] Render abstention without a candidate label when the out-of-fold gate fails.
- [ ] Preserve 360px mobile layout and add rendered HTML assertions.

### Task 5: Correct source semantics

**Files:** Modify `lib/research-v3-engine.ts`, `app/research/ResearchWorkspace.tsx`, and text assertions.

- [ ] Label New Macau samples as multi-source-consistent, not officially verified.
- [ ] Keep Hong Kong official-source wording only when the official feed participates.
- [ ] Run focused text and API tests.

### Task 6: Verify and publish

**Files:** No product changes unless verification reveals a regression.

- [ ] Run `npm test` and confirm typecheck, 74+ Node tests, Python tests, build, deployment tests, and rendered tests pass.
- [ ] Run production-only dependency audit and live read-only API checks.
- [ ] Commit and push the exact verified source to GitHub `main`.
- [ ] Package, save, and deploy a new version of the existing c308868584 Sites project.
- [ ] Confirm the existing `2026218` snapshot is unchanged and the next generated snapshot uses v3.1 semantics.
