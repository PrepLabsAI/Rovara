# Tasks

- [x] Remove legacy dispatch and dependencies; preserve historical reads.
- [x] Make CLI, installer and release paths EC2-only.
- [x] Update documentation and migrate active fixtures; verify historical compatibility.
- [x] Pass build, lint, full test suite and vocabulary check.

## Validation

- `npm run build`: passed.
- `npm run lint`: passed.
- `npm test`: 2,779 passed, 8 opt-in live tests skipped.
- `git grep -i agentcore -- ':!specs'`: no matches.
- `git diff --check`: passed.
- Historical wire records: both retired modes remain readable; registration/allocation and dispatch
  refuse retired modes; retrying an already-closed workspace performs no resource deletion.
- Optional expanded TypeScript check (`tsc -p tsconfig.lint.json`) still reports pre-existing test
  and script errors: 126 versus 128 on the base checkout, with no increased per-file error counts.
- No AWS deployment or live infrastructure verification performed.
