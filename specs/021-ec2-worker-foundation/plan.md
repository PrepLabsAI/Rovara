# Implementation Plan: EC2 Worker Foundation

**Branch**: `feat/082-ec2-worker-foundation` | **Date**: 2026-09-27 | **Spec**: [spec.md](spec.md)

Resources go where their dependencies already live, in production and in named environments alike:

| Resource | Stack | Why there |
|---|---|---|
| Launch template, instance role and profile, worker, dispatcher and session manager security groups, worker log group | foundation (`infra/lib/ec2-workers.ts`) | needs the VPC, private subnets and workspace key |
| Invoke signing key, `bySessionState` index | control plane | the dispatcher and state table are there |
| `/agentx/<env>/worker-image` | runtime | releases already set `WorkerImageUri` there |

No new stack part, so the CLI's deploy engines, release manifests and operator policies are untouched.
The worker log group has a fixed name the boot script writes to, so it is deleted with the stack; a
retained fixed-name group would block redeploying the environment. Instance profiles need their own IAM
actions in the access stack's service role and default boundary, scoped to `/agentx/<env>/`.

Deferred: EventBridge Scheduler roles move to #85 and #86. CDK's scheduler target creates each role with
invoke rights on its own function, and neither function exists yet.

The mainline pipeline refuses foundation drift, so the operator deploys the production foundation by
hand from this branch, and this branch merges right after: until it does, any other mainline release
also sees drift.

## Constitution Check

PASS. Production gains resources nothing uses yet; existing resources are unchanged apart from FR-001's
grant additions. A named environment's access stack must be updated before its foundation (platform team).
Requirements, plan, tasks and verification are recorded here.
