# BROWSER-SKIP-HONESTY mutants (branch pr/browser-skip-honesty-20261125)

STATUS: RUN 2026-11-25. Each mutation applied singly, then `npx vitest run tests/unit/browser-skip-honesty.test.ts tests/unit/core-proof-verification-result.test.ts --maxWorkers=1` (contracts rebuilt with `tsc -b packages/contracts` for the contracts mutants), then reverted. 15 of 15 killed. The set was run twice: once on the first build (M10 and M13 survived until the tests were made exact), once more after the complexity refactor moved code into helpers (all 15, final).

| # | Location | Mutation | Test that fails | Result |
|---|---|---|---|---|
| M1 | packages/broker/src/core/task-flow/dispatch.ts | drop `browserRunnerMissingWords(...)` (back to "too old; upgrade it") | browser-skip-honesty "dispatch ... ends the step with the plain words" | killed |
| M2 | packages/contracts/src/browser-runner-words.ts | drop the "worker lists the application plan feature" guard | "still says 'too old' for a worker that lacks the application plan feature too" | killed |
| M3 | packages/broker/src/core/build-step/results.ts | never map the dispatch words to the block reason | "the task's block reason ... keeps the words" | killed |
| M4 | packages/broker/src/e2e/application-plan-approval.ts | say "no browser runner" even when the caller did not look for expired rows | "keeps the generic reason when the caller did not look for expired rows" | killed |
| M5 | application-plan-approval.ts | judge on the kind-filtered row list, not the project's whole count | "keeps the expiry reason ... a filtered list is not 'no runner'" | killed |
| M6 | packages/broker/src/core/proof/verification-result.ts | every runtime-unusable block gets the browser-runner reason | core-proof-verification-result "keeps the old reason for any other runtime refusal" | killed |
| M7 | packages/broker/src/aws/developer-tasks.ts | drop the plain status line | "the task page and chat status ... leads with the words" | killed |
| M8 | packages/broker/src/developer/workflow-messages.ts (plainBlockReason) | drop the browser-runner sentence | "the chat card ... says the browser checks were not run" | killed |
| M9 | packages/broker/src/e2e/feature-plan-planning-context.ts | `no-browser-runner` even when another kind has a READY row | "keeps 'runtime-not-ready' when the project has some other READY runtime" | killed |
| M10 | packages/contracts/src/plan-quality.ts (targetUnavailableOwner) | drop the owner sentence special case | "plan quality: ... says the checks will not run" (exact sentence) | killed |
| M11 | packages/broker/src/local/app/browser-evidence-skip.ts | say it for a project with no recipe | "says nothing without a recipe ..." | killed |
| M12 | browser-evidence-skip.ts | say it even when the machine can run browser evidence | same test | killed |
| M13 | browser-runner-words.ts | drop the "the checks are what is missing" guard | "browserRunnerMissingWords: ... answers for nothing else" (survived until that unit test was added) | killed after fix |
| M14 | packages/broker/src/local/app/browser-evidence-skip.ts (localBrowserEvidenceDeps) | build a seam even when nothing is configured and nothing can run | "the laptop's browser evidence seam ... has no seam at all" | killed |
| M15 | browser-evidence-skip.ts | ask for the recipe even when the machine cannot run it | "the laptop's browser evidence seam ... asks for the recipe only while the machine can run it" | killed |
