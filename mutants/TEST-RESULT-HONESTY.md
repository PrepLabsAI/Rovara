# TEST-RESULT-HONESTY mutants (branch pr/test-result-honesty-20261125)

STATUS: RUN 2026-11-25. Each applied singly, `tsc -b packages/contracts packages/broker`, then the named vitest file(s) (--maxWorkers=1), then reverted. 11 of 11 killed (one only after an added assertion).

| # | Location | Mutation | Test that fails | Result |
|---|---|---|---|---|
| M1 | packages/contracts/src/test-output-signals.ts pytestOf | `all: skipped > 0 && ...` -> `all: false` | tests/unit/test-output-signals.test.ts "says all when nothing ran but skips" | killed |
| M2 | test-output-signals.ts skippedTestsOf | run genericOf even when a runner was recognised (drop the `found.length === 0` guard) | test-output-signals.test.ts (pytest "says all", jest "every test skipped") | killed |
| M3 | test-output-signals.ts missingServicesOf | drop the REFUSED test (marker alone is enough) | test-output-signals.test.ts "says nothing for a refused connection to another port" | killed |
| M4 | packages/contracts/src/checks-reply.ts verifiedLine | delete the `ran === 0` line | tests/unit/test-result-honesty-surfaces.test.ts "a run in which every test was skipped is not tested" | killed |
| M5 | checks-reply.ts verifiedLine | use `count` instead of `ran` in "Checks: X of Y" | surfaces test "one check that tested nothing among others ..." | killed |
| M6 | packages/contracts/src/check-result-notes.ts checkResultNote | read skips for every outcome (drop `after === "passed"`) | SURVIVED the first run; killed by the added surfaces test "reads skips only from a check that passed, and a missing service only from one that failed" | killed after fix |
| M7 | packages/broker/src/core-host/app/evidence.ts | do not pass `environmentNote` | tests/unit/test-result-honesty-evidence.test.ts "names the test-environment words the pin recorded" | killed |
| M8 | packages/broker/src/core/proof/verification-result.ts | `isFixedEnvironmentNote` back to model-hosts only | tests/unit/core-proof-verification-result.test.ts needs_postgres case | killed |
| M9 | packages/contracts/src/check-result-notes.ts skippedResultOf (used by pr-verdict.ts resultOf) | drop the "Passed, N tests skipped" heading (no Testing view) | tests/unit/contracts-pr-verdict.test.ts "a pass that skipped tests is 'Passed, N tests skipped'" | killed |
| M10 | check-result-notes.ts skippedResultOf | drop the "Not tested: every test was skipped" heading | contracts-pr-verdict.test.ts "a run in which every test was skipped is 'Not tested'" | killed |
| M11 | packages/broker/src/core/proof/test-result-items.ts skippedFactsOf | `skipped +=` -> `skipped =` (no sum over checks) | tests/unit/core-proof-pr-check-verdict.test.ts "skipped tests in passing checks are summed into the heading" | killed |
