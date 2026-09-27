# Tasks: EC2 Session Lifecycle

- [x] T001 Session manager module and tests (`tests/contract/session-manager.test.ts`).
- [x] T002 Shared outbox failure transaction; dispatcher behavior unchanged.
- [x] T003 Session steps Lambda and tests (`tests/contract/session-steps.test.ts`).
- [x] T004 Provisioner and deleter definitions; Step Functions validator and TestState checks; structure tests.
- [x] T005 Control plane, runtime, release and `agentx deploy` wiring; infrastructure tests; snapshots re-recorded.
- [x] T006 `scripts/session-e2e.ts`.
- [x] T007 `npm run session:e2e` passed against production on 2026-09-27: provision (READY in 2 min), resume on the same volume (READY in 2 min), a forced attach failure (instance terminated, volume kept, FAILED) and delete (volume gone, DELETED).
