# Tasks

- [x] Strengthen system instructions for command-only actions and evidence-based reporting.
- [x] Add negative eval scoring and close/model-selection cases.
- [x] Verify scoring, runtime prompt wiring, snapshots and existing command handlers.
- [x] Run build, lint, tests and offline eval; record evidence.

## Validation

- `npm run build`: passed.
- `npm run lint`: passed.
- Targeted eval/prompt suite: 67 passed; two prompt snapshots updated and reviewed.
- `npm test`: 2,798 passed; 8 opt-in live tests skipped.
- `npm run eval`: 71/71 offline cases passed. This uses scripted replies, not a live model.
- The reported false close reply, misleading replies containing the correct command, formatted
  success claims, and false model-switch claims fail the new negative scoring checks.
- Existing baseline case hashes/report compatibility and command handlers pass unchanged.
- `git diff --check`: passed.
- No deployment or live-model evaluation performed.
