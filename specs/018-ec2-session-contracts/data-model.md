# Data Model: EC2 Session Contracts

## Deployment mode

`instances-ebs` | `demo-microvm` | `ec2-ebs`. The first two are AgentCore modes
(`AgentCoreDeploymentMode`). `unhandledDeploymentMode(value: never)` is the default branch of every
switch over the mode.

## Workspace record (`WORKSPACE#{id}` / `META`)

`WorkspaceInstance = AgentCoreWorkspaceInstance | Ec2WorkspaceInstance`.

| Field | AgentCore modes | `ec2-ebs` |
|---|---|---|
| `runtimeArn`, `endpointQualifier`, `runtimeSessionId` | required | forbidden |
| `capacityProviderArn` | required for `instances-ebs`, forbidden for `demo-microvm` | forbidden |

## Project runtime binding

AgentCore bindings are unchanged. `Ec2RuntimeBinding`:

| Field | Rule |
|---|---|
| `deploymentMode` | `ec2-ebs` |
| `launchTemplateId` | `lt-` and 8–17 hex digits |
| `subnets` | 1–16 of `{ availabilityZone, subnetId }`, one subnet per zone, unique subnet IDs |
| `volumeSizeGiB` | integer 1–16384 |
| `volumeType` | `gp3` |

## Outbox record (`OUTBOX#{id}` / `OUTBOX`)

`DurableOutboxRecord = AgentCoreOutboxRecord | Ec2OutboxRecord`. AgentCore records are unchanged and have
no `deploymentMode`; its absence means AgentCore, so records already in the table or queue still parse.
`Ec2OutboxRecord` has `deploymentMode: "ec2-ebs"` and no AgentCore routing.

Status: `PENDING` → `QUEUED` (publisher) → `DELIVERED` | `FAILED` (dispatcher). An `ec2-ebs` record whose
session is not ready is parked as `WAITING_FOR_SESSION`, and re-sent by moving it back to `PENDING`, which
the publisher already re-publishes on `MODIFY`. Operation statuses are a separate record and are unchanged.

## SESSION record (`WORKSPACE#{workspaceId}` / `SESSION`)

Fields: `workspaceId`, `state`, `generation`, and optional `volumeId`, `availabilityZone`, `subnetId`,
`instanceId`, `privateIp`, `launchedAt`, `readyAt`, `lastActivityAt`, `executionArn`.

States and transitions (from the #76 state diagram): `NONE` → `PROVISIONING` → `READY` | `FAILED`;
`READY` → `STOPPING` → `STOPPED`; `READY` → `STOPPED` (reconciler); `STOPPED` | `FAILED` → `PROVISIONING`;
`READY` → `DELETING` → `DELETED`. Transitions are owned by the Session Manager module (#83), not this schema.

Invariants the schema enforces:

- `generation` is 0 exactly while `NONE`.
- A volume or subnet has its `availabilityZone`; an instance has its `subnetId`; a private IP has its instance.
- `NONE` has no resources. `PROVISIONING` has a zone and subnet. `READY` has a volume, instance, private IP,
  `launchedAt`, `readyAt` and `lastActivityAt`. `STOPPING` has a volume and instance. `STOPPED` has a volume
  and no instance. `DELETED` has no instance.

## Invoke token claims

`workspaceId` (UUID), `generation` (≥ 1), `operationId` (UUID), `fence` (≥ 1), `expiresAt` (epoch seconds,
like the callback capability). Signing and verification belong to #80.
