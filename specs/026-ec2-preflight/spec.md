# Feature Specification: EC2 Release Reach and Preflight

**Feature Branch**: `feat/087-ec2-preflight`  
**Created**: 2026-09-27  
**Status**: Approved  
**Input**: Issue #87 (updated 2026-09-27)

## User Scenario

### An operator knows EC2 workers can launch, and that releases and patches reach them (Priority: P1)

Before a deploy or the cutover, `npm run preflight -- --aws` tells the operator, read-only, whether everything an
EC2 session launch needs is in place. Releases and OS patches reach sessions on their next start without any
scheduled job.

## Requirements

- **FR-001**: The preflight MUST check, read-only: the worker launch template (instance type, IMDSv2 at hop limit 1),
  the AMI it resolves to (arm64, available), the worker subnets (available, free addresses) and the instance type's
  availability in their zones, the invoke signing key (enabled, ECC_NIST_P256, SIGN_VERIFY), the workspace volume
  key, the worker settings in SSM (image pinned by digest), both session state machines, On-Demand Standard vCPU
  headroom and Lambda account concurrency.
- **FR-002**: Subnet addresses and Lambda concurrency MUST only warn; every other check MUST fail the run.
- **FR-003**: It MUST work for production (legacy stack names) and named environments (`--env`).
- **FR-004**: A release MUST reach a session on its next start, and so MUST a new AL2023 arm64 AMI (already true
  by #82's design: both are resolved at every launch).

## Success Criteria

- **SC-001**: The preflight passes against production; only Lambda concurrency warns (limit 10).
- **SC-002**: Unit tests cover a ready environment and each failing check.
- **SC-003**: Production evidence shows a release and the current AMI in use by the next launched session.
