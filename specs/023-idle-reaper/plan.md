# Implementation Plan: EC2 Session Idle Reaper

**Branch**: `feat/085-idle-reaper` | **Date**: 2026-09-27 | **Spec**: [spec.md](spec.md)

- `SessionManager` gains `listByState` (the sparse `bySessionState` index), `claimStop` (transaction: the
  conditional READY → STOPPING plus a condition check that the workspace has no active operation) and
  `markStopped`. `workspaceBinding` resolves a workspace's pinned `ec2-ebs` binding; #84 reuses it.
- `packages/broker/src/aws/session-reaper.ts`: a handler over injected dependencies; the Lambda wires EC2,
  DynamoDB, Step Functions and `/ping`. An unreachable worker counts as not busy: stopping it frees the
  instance, and the reconciler (#86) owns workers that stay unreachable while in use.
- Infrastructure in the session lifecycle construct: the reaper Lambda (VPC, reserved concurrency 1), a
  `rate(1 minute)` schedule, termination limited to this environment's `ec2-ebs` instances, an errors
  alarm. Named environments' access stacks gain the `scheduler` service.
- `scripts/session-e2e.ts`: phase 2 waits for the deployed reaper; phase 3 stops through `claimStop` and
  `markStopped`.

## Constitution Check

PASS. Production gains eight control-plane resources and nothing else changes. Requirements, plan, tasks
and verification are recorded here.
