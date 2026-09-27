# Feature Specification: Deliver Work to EC2 Workers

**Feature Branch**: `feat/084-ec2-dispatch`  
**Created**: 2026-09-27  
**Status**: Approved  
**Input**: Issue #84 (flows 1 to 3 in #76); builds on specs 018–023

## User Scenario

### A Slack thread on an ec2-ebs project works end to end (Priority: P1)

In a channel bound to an `ec2-ebs` project, a member starts a thread. The workspace is prepared on a new
EC2 worker, tasks run on it, it resumes after the idle reaper stops it, and closing the thread deletes its
instance and volume. Projects on AgentCore behave exactly as before.

**Independent Test**: the `ec2-test` project bound to Slack channel `C0C4NKT8JAZ` in production: prepare, a
task, a task after an idle stop, and close.

## Requirements

- **FR-001**: For an `ec2-ebs` outbox record the dispatcher MUST resolve the workspace's pinned binding and call
  `ensureSession`, parking the record when the session is not ready.
- **FR-002**: A parked record MUST be acknowledged without using a retry attempt, after one idempotent progress
  event "Starting workspace compute" on its operation.
- **FR-003**: When the session is READY the dispatcher MUST sign an invoke token with KMS (workspace, generation,
  operation, fence, 60 s expiry), POST the invocation to the worker's private address, and mark the record
  DELIVERED; a refused or failed POST MUST use a retry attempt as today.
- **FR-004**: The dispatcher MUST run in the private subnets with the foundation's dispatcher security group.
- **FR-005**: Close completion for `ec2-ebs` MUST start the session deleter and report storage released; if it
  cannot, the close MUST be refused and the workspace left CLOSING.
- **FR-006**: `agentx admin project register` MUST accept an `ec2-ebs` binding (`--launch-template-id`,
  `--subnets`, volume size and type), keeping each mode to its own flags.
- **FR-007**: The AgentCore path MUST be unchanged apart from the dispatcher reaching AgentCore through the NAT
  gateways.

## Success Criteria

- **SC-001**: A token the dispatcher signs passes the worker's own verifier, and expires after 60 s.
- **SC-002**: With the real session manager, a first delivery parks with one event, is re-queued at markReady,
  and is then delivered.
- **SC-003**: The `ec2-test` project works end to end through Slack in production (operator).
