# Implementation Plan: Deliver Work to EC2 Workers

**Branch**: `feat/084-ec2-dispatch` | **Date**: 2026-09-27 | **Spec**: [spec.md](spec.md)

- `packages/broker/src/aws/ec2-delivery.ts`: binding → `ensureSession` → park (progress event) or sign
  (`workerInvokeTokenPayload`, KMS `ECDSA_SHA_256`) and POST. `dispatcher.ts` routes `ec2-ebs` records to it.
- `packages/broker/src/aws/operation-events.ts`: one event, next sequence, fenced, idempotent per outbox record.
- `broker.ts`: close completion calls `deleteEc2Session` (`SessionManager.deleteSession`).
- `packages/cli`: `cliRuntimeBinding` builds the binding from the register flags.
- Infrastructure: `DispatcherSecurityGroupId` joins `CONTROL_PLANE_FOUNDATION_PARAMETERS`; the session lifecycle
  construct puts the dispatcher in the VPC and lets it start the provisioner, and lets the broker start the
  deleter.

Deviation from the issue: prepare does not write a `SESSION` item in state `NONE`. `ensureSession` treats a
missing item as `NONE`, and a retried prepare on a workspace whose session exists would fail that conditional
write.

## Constitution Check

PASS. The only change to AgentCore behavior is network placement of the dispatcher. Requirements, plan, tasks
and verification are recorded here.
