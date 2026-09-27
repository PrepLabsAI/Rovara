# Feature Specification: Worker Invoke Authentication

**Feature Branch**: `feat/080-worker-invoke-auth`  
**Created**: 2026-09-27  
**Status**: Approved  
**Input**: Issue #80, part of the EC2 worker design in issue #76; builds on spec 018

## User Scenario

### Only the dispatcher can start work on an EC2 worker (Priority: P1)

An EC2 worker listens on port 8080 of a private IP. A request to `/invocations` starts work in that
workspace, so the worker must accept only invocations the dispatcher signed for that workspace, that
session generation, and that operation, and only briefly.

**Independent Test**: Send signed and unsigned invocations to the worker's request handler with a
test P-256 key pair, and check which are journaled.

## Requirements

- **FR-001**: With invoke authentication configured, `POST /invocations` MUST require
  `Authorization: AgentX-Invoke <token>`.
- **FR-002**: The token MUST be `base64url(claims JSON).base64url(DER ECDSA signature)`, signed with
  ECDSA_SHA_256 over the first part's bytes, which is what KMS Sign returns for an ECC_NIST_P256 key.
- **FR-003**: The worker MUST verify the signature against the KMS public key before decoding the claims,
  then require `workspaceId` and `generation` to equal its boot configuration and `expiresAt` to be in the future.
- **FR-004**: A request failing FR-001–FR-003 MUST get 401 before its body is read or journaled.
- **FR-005**: The invocation's `workspaceId`, `operationId` and `fence` MUST equal the token's, checked
  before journaling, so a captured token cannot carry a different invocation.
- **FR-006**: The worker MUST hold only the public key.
- **FR-007**: `/ping` MUST stay unauthenticated.
- **FR-008**: Configuration comes from `AGENTX_INVOKE_PUBLIC_KEY` (PEM, or base64 DER SPKI as KMS
  GetPublicKey returns), `AGENTX_WORKSPACE_ID` and `AGENTX_SESSION_GENERATION`. None of them leaves the
  AgentCore worker unchanged; some but not all MUST stop the worker before its port opens.

## Success Criteria

- **SC-001**: Tests cover a valid token, missing header, wrong workspace, wrong generation, expired, bad
  signature, tampered claims, malformed tokens, and a token replayed with another operation or fence.
- **SC-002**: An AgentCore worker (no variables) accepts invocations exactly as before.
- **SC-003**: Typecheck, lint and the complete suite pass.
