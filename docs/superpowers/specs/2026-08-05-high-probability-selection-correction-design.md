# Research v3.1 High-Probability Selection Correction Design

## Objective

Correct the mismatch between the product goal (high calibrated hit probability) and the current selector (largest relative uplift). Preserve the immutable four-slot ledger and apply the new behavior only to forecasts frozen after deployment.

## Decision

Each slot will expose two distinct meanings:

- **Formal decision:** no directional recommendation until a champion completes at least 50 independent forward issues and every registered promotion gate. The formal probability remains the exact baseline and the formal champion is `baseline`.
- **Research candidate:** the highest calibrated absolute-probability candidate that also has positive out-of-fold Brier skill and at least 80% non-worse folds. If no candidate passes, the slot explicitly abstains instead of presenting the least-bad candidate as a prediction.

Relative uplift remains diagnostic evidence but no longer dominates candidate selection. This prevents a four-member category such as `0尾` or `鼠` from beating a structurally higher-probability five-member category merely because its uplift over its own lower baseline is larger.

## Data and API

`ResearchEventForecast` gains a `decisionStatus` (`formal`, `research_candidate`, or `abstain`) and a `selectionObjective` fixed to `calibrated_absolute_probability`. Existing frozen snapshots remain readable through a compatibility projection that derives these fields without altering stored probabilities or outcomes.

The snapshot learning summary reports `baseline` as champion unless `formalChampion` exists. All public wording uses “多源一致” for New Macau data and reserves “official” for an official source.

## Interface

The research page displays “正式层暂无已验证方向” for baseline/shadow events. A separate block names the research candidate, its experimental probability, its exact baseline, out-of-fold Brier skill, and whether it passed the research display gate. Abstentions state why no category is shown.

The review page continues to settle immutable historical labels. New snapshots settle the selected research candidate while the formal score remains at baseline until promotion; expert probabilities continue to update separately.

## Governance

- The production champion is `baseline` until formal promotion.
- All references to a 20-issue promotion gate become 50 independent issues.
- Candidate selection uses only time-ordered out-of-fold evidence.
- Relative uplift, recent frequency, or one successful draw cannot override a failed out-of-fold gate.
- Existing `2026218` and earlier forecasts are never rewritten.

## Verification

Tests must prove that a lower-absolute-probability candidate cannot win solely from relative uplift, negative out-of-fold evidence produces abstention, unpromoted snapshots report the baseline champion and no formal direction, legacy snapshots remain readable, New Macau is labelled multi-source-consistent rather than officially verified, and all promotion copy uses 50 issues.
