# Tasks: EC2 Worker Boot Script

- [x] T001 Add `Ec2WorkerBootConfigSchema` and `ec2WorkerUserData` to `packages/contracts/src/session.ts`.
- [x] T002 Add `packages/worker/ec2/boot.sh`; shellcheck clean.
- [x] T003 Add `tests/contract/ec2-boot-config.test.ts` (renderer, injection refusals, script/renderer drift).
- [x] T004 Add opt-in `tests/live/ec2-boot-script.test.ts` and `npm run test:boot-script`; run on arm64.
- [ ] T005 Boot a real instance from #82's launch template: new, existing and blank-but-expected volumes.
- [x] T006 Run typecheck, lint and the full suite.
