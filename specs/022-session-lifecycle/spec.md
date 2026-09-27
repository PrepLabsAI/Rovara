# Feature Specification: EC2 Session Lifecycle

**Feature Branch**: `feat/083-session-lifecycle`  
**Created**: 2026-09-27  
**Status**: Approved  
**Input**: Issue #83, part of the EC2 worker design in issue #76; builds on specs 018–021

## User Scenario

### An ec2-ebs workspace gets compute when work arrives, and loses it when it closes (Priority: P1)

A caller (the dispatcher in #84) asks for a workspace's session. If a worker is ready, it gets the worker's
address. If not, provisioning starts (or is already running), the caller's outbox record is parked, and it is
re-sent once the worker answers its health probe. Closing a workspace deletes its instance and volume.

**Independent Test**: `npm run session:e2e` against the deployed control plane: provision a new volume,
resume on it, fail a provisioning, delete.

## Requirements

- **FR-001**: One module (`packages/broker/src/aws/sessions.ts`) MUST own every SESSION transition, each a
  conditional write on the state and generation it read.
- **FR-002**: The first provisioning MUST choose the availability zone; every later one MUST launch in the
  volume's zone, and refuse a binding with no subnet there.
- **FR-003**: Work arriving while the session is not ready MUST be parked (outbox WAITING_FOR_SESSION, its ID in
  the session's parked set) in the same transaction that reads or changes the session state.
- **FR-004**: markReady MUST send parked records back to PENDING (the publisher re-queues them). markFailed MUST
  fail their operations, so a broken start never loops through generations.
- **FR-005**: The provisioner MUST create the volume only on the first generation, with a ClientToken; launch
  from the worker launch template with a ClientToken; attach; probe `/ping` every 10 s for up to 10 minutes;
  then markReady. Any failure MUST terminate a launched instance, keep the volume, and markFailed.
- **FR-006**: The deleter MUST terminate the instance, wait, delete the volume and mark DELETED, treating an
  instance or volume that is already gone as deleted.
- **FR-007**: `probePing` MUST run in a Lambda in the private subnets with the session manager's security group.
- **FR-008**: Starting an execution twice for one generation MUST NOT launch twice.
- **FR-009**: The state machines' roles MUST NOT hold `ec2:*`; terminate, attach and delete MUST be limited to
  instances and volumes tagged for this environment's ec2-ebs sessions.
- **FR-010**: Production MUST only gain resources; existing resources MUST NOT change.

## Success Criteria

- **SC-001**: Contract tests cover FR-001 to FR-010; both definitions pass the Step Functions validator.
- **SC-002**: `npm run session:e2e` passes against production after the release (operator-approved).
- **SC-003**: Typecheck, lint and the full suite pass.
