# Feature Specification: EC2 Session Reconciler

**Feature Branch**: `feat/086-reconciler`  
**Created**: 2026-09-27  
**Status**: Approved  
**Input**: Issue #86 (flow 5 in #76, updated 2026-09-27); builds on specs 022–024

## User Scenario

### Drift between EC2 and SESSION items is repaired, and nothing unclaimed is destroyed (Priority: P1)

When an instance dies, a state machine stops partway, or a resource is left behind, the reconciler brings
EC2 and the `SESSION` items back in line within ten minutes: orphan instances are terminated, lost workers
are marked stopped with their work failed, stuck transitions are finished, and a volume nobody claims is
quarantined for a person to decide on.

**Independent Test**: the reconciler tests, one per finding class, with the real session manager.

## Requirements

- **FR-001**: An EventBridge Scheduler schedule MUST run the reconciler every 10 minutes as a VPC Lambda; runs
  MUST be safe to overlap.
- **FR-002**: It MUST act only on instances and volumes tagged `DeploymentMode=ec2-ebs` and its `Environment`.
- **FR-003 (orphan)**: A live instance no session owns, launched over 15 minutes ago, MUST be terminated.
- **FR-004 (lost)**: A READY session whose instance is gone or not running MUST become STOPPED (volume kept); its
  workspace's active operation, in any live status, MUST fail with `RUNTIME_UNAVAILABLE` and release the workspace.
- **FR-005 (unresponsive)**: After 3 consecutive failed probes of a READY worker, its instance MUST be terminated;
  a successful probe MUST reset the count.
- **FR-006 (provisioning)**: A PROVISIONING session whose execution ended MUST have its instance terminated and be
  marked FAILED (failing parked work); one with no recorded execution MUST be started again; a running execution
  MUST be left alone.
- **FR-007 (deleting)**: A DELETING session whose deleter is no longer running MUST be finished with direct EC2 calls
  and marked DELETED.
- **FR-008 (parked)**: Work still parked on a READY session MUST be sent back to PENDING.
- **FR-009 (volumes)**: A volume of a workspace CLOSED over an hour ago MUST be deleted once available; any other
  unclaimed volume older than 15 minutes MUST be tagged `agentx:quarantined` and never deleted.
- **FR-010**: It MUST emit a count per finding class and alarm on quarantined volumes, lost instances, stuck
  provisioning and repeated run errors.

## Success Criteria

- **SC-001**: A test per finding class passes.
- **SC-002**: Production gains resources only.
- **SC-003**: After the release, the reconciler runs in production with nothing to repair and no errors.
