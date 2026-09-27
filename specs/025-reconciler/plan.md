# Implementation Plan: EC2 Session Reconciler

**Branch**: `feat/086-reconciler` | **Date**: 2026-09-27 | **Spec**: [spec.md](spec.md)

- `SessionManager` gains `markLost` (READY → STOPPED for the instance it saw), `recordPingFailure` /
  `clearPingFailures` (a `pingFailures` counter on the SESSION item), and `requeueParked` (which `markReady` now
  uses).
- `failActiveOperation` (outbox-failure.ts) fails an operation in any live status, fenced, and restores the workspace:
  PREPARATION_FAILED after a prepare, the previous status after a close preflight, READY otherwise.
- `packages/broker/src/aws/session-reconciler.ts`: the handler over injected EC2, Step Functions, ping and data
  access. A running provisioner is trusted (it has its own 45-minute timeout). The deleter's name is unique for 90
  days, so a stuck deletion is finished with direct EC2 calls.
- Infrastructure in the session lifecycle construct: the reconciler Lambda, `rate(10 minutes)`, terminate, delete and
  quarantine tagging limited to this environment's `ec2-ebs` resources, read access to both state machines, and four
  alarms.

## Constitution Check

PASS. Production gains eleven control-plane resources; nothing else changes. No ec2-ebs instances or volumes exist
at release time, so the first runs have nothing to repair. Requirements, plan, tasks and verification are here.
