# Implementation Plan: EC2 Session Lifecycle

**Branch**: `feat/083-session-lifecycle` | **Date**: 2026-09-27 | **Spec**: [spec.md](spec.md)

- `packages/broker/src/aws/sessions.ts`: `SessionManager` with `ensureSession`, `markVolume`, `markInstance`,
  `markReady`, `markFailed`, `deleteSession`, `markDeleted`. Parked outbox IDs live in a string set on the
  SESSION item, so markReady finds them without a scan. `sessionState` mirrors `state` for the sparse index
  and is removed once DELETED. Starting executions is optional, because the step Lambda the state machines
  call cannot refer back to them.
- `packages/broker/src/aws/outbox-failure.ts`: the dispatcher's terminal-failure transaction, shared unchanged.
- `packages/broker/src/aws/session-steps.ts`: one VPC Lambda for every step: user data (boot script bundled
  beside the handler, worker settings from SSM, public key from KMS), recording, `/ping`, and the marks.
- `infra/lib/session-state-machines.ts`: JSONata ASL for the provisioner and deleter. EC2 errors arrive as a
  generic `Ec2.Ec2Exception`, so "already gone" is matched on the error code or EC2's "does not exist" text.
- `infra/lib/session-lifecycle.ts`: the Lambda, both machines, scoped roles, failure/timeout alarms.
- The control plane takes five foundation outputs as parameters of the same name
  (`CONTROL_PLANE_FOUNDATION_PARAMETERS`), passed by `release-production.ts` and `agentx deploy`: no
  cross-stack export, so the manually deployed foundation does not change.
- The runtime stack publishes the worker model settings beside `worker-image`.
- `scripts/session-e2e.ts` drives the end-to-end check, standing in for the idle reaper (#85) to stop a session.

## Constitution Check

PASS. Nothing calls the session manager until #84, so production gains resources that stay idle; no existing
resource changes. Requirements, plan, tasks and verification are recorded here.
