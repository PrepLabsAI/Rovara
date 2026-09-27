# EC2 environment tags — issue #100

## Requirements
- FR-001: Named environments must put `agentx:env=<env>` on newly launched worker instances, root EBS volumes, and separately created workspace EBS volumes.
- FR-002: Preserve existing ownership, workspace and generation tags and IAM conditions.
- FR-003: Preserve the legacy unnamed deployment's omission of `agentx:env`, consistent with app-level tagging.

## Acceptance
Synthesized launch templates and provisioner definitions carry the correct environment tag for named deployments. Unnamed deployments omit it. Tests cover both cases.

## Scope and assumptions
This fixes future resource creation. Existing resources are not retroactively tagged. Budget and teardown implementations are outside scope. Legacy compatibility follows the existing app's conditional tagging behavior.
