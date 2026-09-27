# Feature Specification: EC2 Session Contracts

**Feature Branch**: `feat/079-ec2-session-contracts`  
**Created**: 2026-09-27  
**Status**: Approved  
**Input**: Issue #79, part of the EC2 worker design in issue #76

## User Scenario

### Later EC2 work builds against one data model (Priority: P1)

A maintainer implementing the Session Manager, dispatcher, idle reaper or reconciler (#80–#88) can
rely on shared schemas for the `ec2-ebs` deployment mode, its runtime binding, the per-workspace
`SESSION` record and the worker invoke token. Every place that branches on the deployment mode says
what `ec2-ebs` does, so nothing takes the AgentCore path by accident.

**Independent Test**: Parse valid and invalid records with each schema, and drive an `ec2-ebs`
project through registration, preparation and close in the broker test harness.

## Requirements

- **FR-001**: `WorkspaceDeploymentModeSchema` MUST include `ec2-ebs`.
- **FR-002**: An `ec2-ebs` workspace record MUST NOT carry `runtimeArn`, `endpointQualifier`,
  `runtimeSessionId` or `capacityProviderArn`; AgentCore workspace records MUST still require the first three.
- **FR-003**: A project runtime binding for `ec2-ebs` MUST name a launch template, one private subnet per
  availability zone, and the volume size and type, and MUST NOT accept AgentCore ARNs.
- **FR-004**: An `ec2-ebs` outbox record MUST carry the workspace ID and deployment mode instead of AgentCore
  routing, and the outbox status union MUST include `WAITING_FOR_SESSION`.
- **FR-005**: The `SESSION` record MUST be keyed `WORKSPACE#{workspaceId}` / `SESSION` and validate that its
  fields agree with its state.
- **FR-006**: Invoke token claims MUST be `workspaceId`, `generation`, `operationId`, `fence` and `expiresAt`.
- **FR-007**: Every deployment-mode branch listed in #79 MUST handle `ec2-ebs` explicitly. Where the EC2
  behavior belongs to a later issue (dispatch, stop, close), the branch MUST refuse rather than fall through.
- **FR-008**: The AgentCore path MUST behave exactly as before, including validation order and error messages.

## Success Criteria

- **SC-001**: Adding another deployment mode fails to compile at every exhaustive switch.
- **SC-002**: Closing an `ec2-ebs` workspace returns `RUNTIME_UNAVAILABLE` and leaves it `CLOSING`; it never
  reports CLOSED while its volume survives.
- **SC-003**: Typecheck, lint and the complete suite pass with no change to existing AgentCore assertions.
