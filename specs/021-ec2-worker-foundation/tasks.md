# Tasks: EC2 Worker Foundation

- [x] T001 Add `WORKSPACE_SESSION_STATE_INDEX` and instance-profile IAM actions to contracts.
- [x] T002 Add EC2 names to `infra/lib/naming.ts` (legacy getters throw).
- [x] T003 Add `infra/lib/ec2-workers.ts` and wire it into the foundation for named environments.
- [x] T004 Add the signing key and session index to the control plane, the image parameter to the runtime.
- [x] T005 Add `tests/contract/ec2-worker-infrastructure.test.ts`; adjust access and naming tests.
- [x] T006 Synthesize staging and production; run typecheck, lint and the full suite.
- [ ] T007 Operator: update the environment's access stack, then deploy it with `--env`.
