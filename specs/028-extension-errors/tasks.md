# Tasks

- [x] T001 Add real Pi regression tests for handler errors and lifecycle/sink behavior.
- [x] T002 Bind safe reporting during session creation and wire hosted logging and turn recording.
- [x] T003 Validate regression and existing behavior, typecheck and lint; review convergence.

## Validation

- 78 targeted tests passed across extension-errors, turn-recording, slack-action-gate, orchestrator-boundary, orchestrator-characterization, action-gate-characterization and turn-recording-errors.
- Typecheck and lint passed.
- Full suite: 2,730 passed, 8 skipped, 1 failed. The unrelated init-github-app manifest listener test hit ECONNRESET with its 20 ms timeout under concurrent test load. Its entire file passed in isolation (33 tests); no changes made to that test.
- Convergence: all five requirements and the lifecycle, privacy and independent-sink plan decisions are covered; no remaining implementation tasks. Verification is local with Pi's real runtime and faux provider, not a deployed Slack smoke test.
