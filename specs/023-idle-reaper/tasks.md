# Tasks: EC2 Session Idle Reaper

- [x] T001 Session stop transitions, state listing and binding lookup.
- [x] T002 Reaper handler and tests (`tests/contract/session-reaper.test.ts`).
- [x] T003 Reaper Lambda, schedule, IAM and alarm; infrastructure tests; snapshots re-recorded.
- [x] T004 `scripts/session-e2e.ts` waits for the deployed reaper.
- [ ] T005 Operator: after the release, run `npm run session:e2e` against production.
