# Research v3 Governance Repair Design

## Objective

Repair the audited security, model-governance, validation, review-ledger, and CI runtime defects in priority order without changing the four fixed high-probability event slots or the immutable pre-draw ledger.

## Architecture

The engine will expose two explicitly different probability tracks. `probability` remains the production probability and may use only the exact baseline plus a formally promoted champion. `experimentalProbability` may combine interpretable rules, logistic regression, and Python-discovered rules. Each expert keeps its own probability and validation status so the UI can explain differences without presenting a shadow result as formal evidence.

Formal promotion is a persisted state transition, not a label inferred from one historical run. A candidate can become `verified` only after the complete outer walk-forward pipeline selects the event without future data, accumulates at least 50 independent forward issues, passes the registered Brier and calibration gates, has a positive 95% bootstrap lower bound, and beats at least 99% of fair-random pipeline champions. Until then the production probability stays at baseline or the prior verified champion.

Champion comparison uses one aggregate score per issue, preserving the four correlated event slots as one independent time unit. A challenger needs at least 20 consecutive forward issues, positive Brier skill with a positive confidence-bound, non-worse calibration, and a minimum improvement margin. The settlement service computes the promotion decision before persisting the learning run so `championAfter` and `challengerPromoted` are historically accurate.

## Selection Validation

The four-slot selector is evaluated by an outer expanding-window walk-forward. At each historical step it generates all candidates using only earlier draws, runs the same selection function used for the next live issue, then scores the selected candidate on the next unseen draw. Displayed historical metrics and promotion gates use only these selected out-of-fold observations; metrics calculated after choosing a winner on the full dataset remain diagnostic only.

## Dependency and CI Maintenance

Next.js is upgraded from the vulnerable 16.2.6 release to a patched compatible release and the full build/test/deployment suite must remain green. GitHub Actions move to Node 24-backed majors: checkout v5, setup-python v6, upload-artifact v6, and setup-node v6. Scheduled times and deployment ownership remain unchanged.

## Safety and Persistence

- Frozen forecasts remain immutable and can only be settled by a verified draw whose draw time is later than `frozenAt`.
- Shadow probabilities never replace or silently alter formal probabilities.
- Failed training or promotion validation preserves the previous champion and next frozen forecast.
- Every promotion or rejection is reconstructible from saved issue-level scores and model versions.
- Hong Kong remains baseline-only until its verified independent sample gate is met.

## Verification

Tests must prove the vulnerable package is gone, baseline-only Python artifacts cannot affect formal probability, shadow logistic models cannot affect formal probability, formal mode is reachable only through persisted validation evidence, outer walk-forward does not use future outcomes, correlated events count as one issue, and promotion is recorded in the learning run. The full Node, Python, deployment, rendered-page, production build, dependency audit, and live read-only API checks run before publication.
