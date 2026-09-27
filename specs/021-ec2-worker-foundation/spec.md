# Feature Specification: EC2 Worker Foundation

**Feature Branch**: `feat/082-ec2-worker-foundation`  
**Created**: 2026-09-27  
**Status**: Approved  
**Input**: Issue #82, part of the EC2 worker design in issue #76; builds on specs 018–020

## User Scenario

### Production can host EC2 workers beside AgentCore (Priority: P1)

Besides today's AgentCore stacks, production (and any named environment) holds everything the session
provisioner (#83) needs to launch a worker: a launch template, an instance role, security groups, an
invoke signing key, the worker image parameter and a sparse session index. Nothing uses them until
#83 and #84, so AgentCore behavior is unchanged. There is no non-production environment; production
is the target, decided 2026-09-27.

**Independent Test**: Synthesize production and a named environment, and diff production against the live stacks.

## Requirements

- **FR-001**: Every resource below MUST be added to production under production names, and to named
  environments under theirs. Existing production resources MUST NOT change, except that the table grants
  of the broker, outbox publisher and dispatcher also cover the new index, and the dispatcher gains `kms:Sign`.
- **FR-002**: Launch template: Amazon Linux 2023 arm64 resolved from its public SSM parameter at launch,
  `m6g.medium`, IMDSv2 required with hop limit 1, a 30 GiB gp3 root volume encrypted with the workspace
  key, terminate on instance-initiated shutdown, no user data (the provisioner sends the boot script).
- **FR-003**: Instance role: ECR pull (including the environment's pull-through prefix), Bedrock
  `InvokeModel` and `InvokeModelWithResponseStream`, and writes to its own log group. No AgentCore, KMS or SSM.
- **FR-004**: The worker security group MUST allow ingress only on 8080 and only from the dispatcher's and the
  session manager's security groups, with HTTPS-only egress. The AgentCore workers' group is unchanged.
- **FR-005**: An ECC_NIST_P256 SIGN_VERIFY key MUST be usable for `kms:Sign` by the dispatcher only, enforced in
  the key policy as well as by grant.
- **FR-006**: The released worker image URI MUST be published in SSM at `/agentx/<env>/worker-image`.
- **FR-007**: The state table MUST have a sparse index `bySessionState` (`sessionState`, `workspaceId`).
- **FR-008**: The environment's CloudFormation service role and default boundary MUST allow managing instance
  profiles under the environment's IAM path, and nothing wider.

## Success Criteria

- **SC-001**: Contract tests cover FR-001 to FR-008; the re-recorded production snapshots differ only by FR-001's additions.
- **SC-002**: `cdk synth` of a named environment and of production reports no new validation warnings.
- **SC-003**: `cdk diff` of the live production foundation shows additions only; the operator deploys it.
