# Special Number Pattern Consensus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a special-ball-only top-15 number intersection summary derived from frozen 30-draw category rules.

**Architecture:** A pure summary module maps special-result events to numbers and aggregates de-correlated evidence. The patterns API exposes the frozen consensus and accepts a number filter; the existing client renders and controls the new module only in special scope.

**Tech Stack:** TypeScript, Next.js/Vinext, React, Node test runner, CSS, Sites.

## Global Constraints

- Condition A continues to use current-draw 6+1 features.
- Result B is special-ball zodiac, tail, wave, or head only.
- Number consensus is research evidence, not a production probability or exact-number forecast.
- Show at most 15 numbers and preserve 360px mobile layout.

---

### Task 1: Pure special-number consensus

**Files:**
- Modify: `lib/rolling-pattern-types.ts`
- Modify: `lib/rolling-pattern-summary.ts`
- Test: `tests/rolling-pattern-summary.test.ts`

**Interfaces:**
- Produces: `buildSpecialNumberConsensus(signals, expectedDrawAt, limit)` returning ranked number evidence.
- Produces: `signalSupportsSpecialNumber(signal, number, expectedDrawAt)` for API filtering.

- [ ] **Step 1: Write failing tests** for blue-wave membership, intersection ranking, rule deduplication, top-15 limit, and non-special exclusion.
- [ ] **Step 2: Run `node --import tsx --test tests/rolling-pattern-summary.test.ts`** and verify the new imports or assertions fail because the feature is absent.
- [ ] **Step 3: Implement the minimal pure functions** using `getWave`, `WAVE_LABEL`, and `getZodiac`; aggregate each result event once before projecting it to numbers.
- [ ] **Step 4: Re-run the focused test** and verify all summary tests pass.
- [ ] **Step 5: Commit** the tested summary logic.

### Task 2: API payload and number filtering

**Files:**
- Modify: `app/api/research/patterns/route.ts`
- Test: `tests/rendered-html.test.mjs`

**Interfaces:**
- Consumes: `buildSpecialNumberConsensus` and `signalSupportsSpecialNumber` from Task 1.
- Produces: API field `specialNumberConsensus` and validated query parameter `number`.

- [ ] **Step 1: Write failing route-source/API contract assertions** for special-only payload creation and `number=1..49` validation.
- [ ] **Step 2: Run `node --test tests/rendered-html.test.mjs`** and verify the new assertions fail.
- [ ] **Step 3: Implement the route changes** so summary is computed before number filtering, number filtering applies to detail signals, and coverage scope rejects a number filter.
- [ ] **Step 4: Re-run the focused route tests** and verify they pass.
- [ ] **Step 5: Commit** the API change.

### Task 3: Special-number top-15 UI

**Files:**
- Modify: `app/patterns/RollingPatternWorkspace.tsx`
- Modify: `app/globals.css`
- Test: `tests/rendered-html.test.mjs`

**Interfaces:**
- Consumes: `specialNumberConsensus` from Task 2.
- Produces: special-scope-only interactive top-15 cards and number-driven detail filtering.

- [ ] **Step 1: Write failing rendered-source assertions** for the module heading, research-boundary copy, selected-number state, and query serialization.
- [ ] **Step 2: Run `node --test tests/rendered-html.test.mjs`** and verify the UI assertions fail.
- [ ] **Step 3: Implement the React module and mutually exclusive filters**, resetting number selection on game/scope/family/result changes.
- [ ] **Step 4: Add mobile-first card styles** with yellow evidence labels and no fixed width.
- [ ] **Step 5: Re-run rendered tests and the production build** and verify both pass.
- [ ] **Step 6: Commit** the UI change.

### Task 4: Full verification and production release

**Files:**
- Verify: repository test, build, lint, and deployment outputs.

**Interfaces:**
- Consumes: validated source commits from Tasks 1–3.
- Produces: one saved and deployed Sites production version.

- [ ] **Step 1: Run `npm test`, `npm run lint`, and `git diff --check`**; fix only actual failures.
- [ ] **Step 2: Push the exact HEAD to GitHub main and the Sites source repository main** without force.
- [ ] **Step 3: Package, save, and deploy one Sites version** using the existing project ID.
- [ ] **Step 4: Trigger the signed research workflow if the schema/version requires refreshed frozen data.**
- [ ] **Step 5: Verify the production API returns no more than 15 special-number entries and every entry is 1–49 with only special-scope evidence.**
