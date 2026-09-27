# Feature Specification: Remove AgentCore Resources

**Feature Branch**: `feat/118-remove-agentcore-infra`  
**Created**: 2026-09-27  
**Status**: Approved  
**Input**: Issue #118 (part of #88)

## User Scenario

### No AgentCore remains in the account (Priority: P1)

Every workspace runs on EC2 (#88's cutover and #117), so nothing uses AgentCore. The templates stop declaring it,
and the leftover live resources are deleted.

## Requirements

- **FR-001**: `AgentXProductionFoundation` MUST no longer declare the capacity provider, its operator role and policy,
  or the AgentCore worker security group, nor output `CapacityProviderArn` or `WorkerSecurityGroupId`.
- **FR-002**: The demo microVM runtime stack, its CDK code and `release:demo` MUST go; the shared release helpers move
  to `scripts/release-common.ts`, and `agentxDeploymentMode=demo-microvm` is refused.
- **FR-003**: The control plane, the release pipeline and the access policies (service role, operator role, boundary)
  MUST grant nothing of AgentCore, nor the runtime log-group permissions the pipeline kept for it.
- **FR-004**: The live runtimes (`agentx_production_worker`, `charterarc_team_tasks_worker`), the capacity provider
  (`agentx_production_capacity_v3`) and the `/aws/bedrock-agentcore/runtimes/*` log groups MUST be deleted, in an
  order that never leaves a resource CloudFormation would try to delete while it is in use.

## Success Criteria

- **SC-001**: The foundation, control-plane and pipeline templates differ from production only by the removals and
  the foundation's `DeploymentMode` output (`ec2-ebs`).
- **SC-002**: After the rollout, listing AgentCore runtimes, capacity providers, workload identities and log groups in
  us-east-1 returns nothing, and a new Slack thread still runs on EC2.
- **SC-003**: Typecheck, lint and the full test suite pass.
