# Feature Specification: Releases Publish Only the EC2 Worker Settings

**Feature Branch**: `feat/117-release-worker-settings`  
**Created**: 2026-09-27  
**Status**: Approved  
**Input**: Issue #117 (part of #88)

## User Scenario

### A release reaches EC2 workers without touching AgentCore (Priority: P1)

Every workspace now runs on EC2 (all AgentCore workspaces were closed on 2026-09-27, and the live projects
were re-registered as `ec2-ebs`). A release publishes the worker image and model settings that the session
provisioner reads when it boots a worker, and nothing else about the worker.

## Requirements

- **FR-001**: `AgentXProductionRuntime` (and `agentx-<env>-runtime`) MUST hold only the four SSM worker
  settings, under the logical IDs they have in production, so CloudFormation updates them in place.
- **FR-002**: The stack MUST drop the AgentCore runtime, its execution role and policy, and the
  `ControlPlaneUrl` and `CapacityProviderArn` parameters. The production runtime is `Retain`, so it stays in
  the account for #118 to delete; a named environment's runtime is deleted with the stack update.
- **FR-003**: `npm run release:prod` MUST NOT wait for the capacity provider or the runtime, set runtime log
  retention, or fall back to the demo runtime for model settings. It MUST still deploy the worker settings
  before the control plane.
- **FR-004**: `agentx deploy` MUST stop passing the two removed parameters for the `runtime` part.
- **FR-005**: Named environments' EC2 workers MUST keep pulling images through the ECR pull-through cache
  (the foundation's instance role already holds that grant).
- **FR-006**: The release manifest MUST record `deploymentMode: "ec2-ebs"` and the model settings instead of
  the runtime ARN, version and capacity provider.

## Success Criteria

- **SC-001**: The released runtime template differs from production only by removals and its description.
- **SC-002**: A release through the pipeline completes, the SSM worker settings carry its image, and a new
  Slack thread prepares and runs on EC2.
- **SC-003**: Typecheck, lint and the full test suite pass.
