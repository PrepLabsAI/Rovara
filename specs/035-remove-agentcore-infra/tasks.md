# Tasks: Remove AgentCore Resources

- [x] T001 Foundation, demo stack, release helpers, control plane, pipeline, access policies and naming.
- [x] T002 Tests and template snapshots; typecheck, lint and tests pass.
- [x] T003 Delete the runtimes and the capacity provider (operator).
  Done 2026-09-27: both runtimes and the capacity provider deleted.
- [x] T004 Execute the foundation change set, merge, execute the pipeline change set (operator).
  Done 2026-09-27: foundation change set executed (#133's first release failed cleanly on the drift check and was retried), then the pipeline change set.
- [x] T005 Delete the leftover log groups; account check; a new Slack thread runs on EC2.
  Done 2026-09-27/28: log groups deleted; account check empty apart from two AWS service-linked roles; a new Sample-Project-A thread ran on EC2.
