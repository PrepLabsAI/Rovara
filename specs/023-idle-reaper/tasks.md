# Tasks: EC2 Session Idle Reaper

- [x] T001 Session stop transitions, state listing and binding lookup.
- [x] T002 Reaper handler and tests (`tests/contract/session-reaper.test.ts`).
- [x] T003 Reaper Lambda, schedule, IAM and alarm; infrastructure tests; snapshots re-recorded.
- [x] T004 `scripts/session-e2e.ts` waits for the deployed reaper.
- [x] T005 `npm run session:e2e` passed against production on 2026-09-27: the deployed reaper claimed an idle session 11 s after its 5-minute idle mark and marked it STOPPED a minute later; generation 2 resumed on the same volume. It stopped a real Slack workspace the same way during the #84 test.
