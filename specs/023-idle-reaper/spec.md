# Feature Specification: EC2 Session Idle Reaper

**Feature Branch**: `feat/085-idle-reaper`  
**Created**: 2026-09-27  
**Status**: Approved  
**Input**: Issue #85 (flow 4 in #76); builds on spec 022

## User Scenario

### An idle worker stops by itself and resumes when work arrives (Priority: P1)

A workspace's EC2 worker that has done nothing for five minutes, or was launched over 14 days ago, is
stopped: the instance is terminated and the workspace volume kept. The next dispatch resumes it on the
same volume. A dispatch or task that arrives while the reaper is deciding always wins.

**Independent Test**: the reaper tests with the real session manager, and `npm run session:e2e`, whose
second phase waits for the deployed reaper to stop the session and then resumes it.

## Requirements

- **FR-001**: An EventBridge Scheduler schedule MUST run the reaper every minute as a Lambda in the private
  subnets. Runs MUST be safe to overlap; the reaper reserves no concurrency, which an account at the
  Lambda minimum (10) cannot grant.
- **FR-002**: A READY session idle over five minutes or launched over 14 days ago MUST be skipped when its
  workspace has an active operation or `/ping` returns `HealthyBusy`.
- **FR-003**: Otherwise the reaper MUST claim READY → STOPPING conditionally on an unchanged
  `lastActivityAt` and generation and no active operation (absent or null), in one transaction, and then
  terminate the instance.
- **FR-004**: A STOPPING session MUST become STOPPED (instance and address cleared) once the instance is gone
  and the volume available; a live instance MUST be terminated again.
- **FR-005**: If work was parked while stopping, the reaper MUST start the next generation at once.
- **FR-006**: The workspace's status MUST NOT change.
- **FR-007**: The reaper MUST emit `SessionsStopped` and `SessionsStopping`, and alarm after 15 minutes of
  failing runs.

## Success Criteria

- **SC-001**: Tests cover idle stop, the 14-day lifetime, both busy skips, a dispatch and a task racing a
  reap, restart of parked work, and a terminate retried after failure.
- **SC-002**: Production gains resources only.
- **SC-003**: `npm run session:e2e` passes against production after the release, including the reaper's
  idle stop (operator-approved).
