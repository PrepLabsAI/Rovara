# Tasks: Worker Invoke Authentication

- [x] T001 Add the invoke token format and authorization scheme to `packages/contracts/src/session.ts`.
- [x] T002 Add `packages/worker/src/invoke-auth.ts`: configuration, key reader, header verifier, binding check.
- [x] T003 Enforce it in `packages/worker/src/server.ts` and load it in `packages/worker/src/main.ts`.
- [x] T004 Add `tests/contract/worker-invoke-auth.test.ts`.
- [x] T005 Run typecheck, lint and the full suite; confirm convergence against #80.
