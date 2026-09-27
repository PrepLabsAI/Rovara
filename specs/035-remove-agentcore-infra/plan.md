# Implementation Plan: Remove AgentCore Resources

**Branch**: `feat/118-remove-agentcore-infra` | **Date**: 2026-09-27 | **Spec**: [spec.md](spec.md)

## Code
- `infra/lib/production-foundation.ts`: without the capacity provider, operator role, AgentCore security group and
  their outputs. The AgentCore region check and the lifecycle and volume settings go too.
- `infra/lib/agent-runtime.ts` and `infra/lib/demo-runtime.ts` are deleted; `app.ts` refuses `demo-microvm`.
- `scripts/release-demo.ts` becomes `scripts/release-common.ts`, with only the helpers `release-production.ts` uses.
- `infra/lib/control-plane.ts`: without the broker's and dispatcher's AgentCore grants.
- `infra/lib/release-pipeline.ts`: without `ReadProductionAgentCore`, `DescribeLogGroups` and `RuntimeLogRetention`.
- `packages/contracts/src/access-policies.ts`: without `bedrock-agentcore`, AgentCore service-linked roles, the
  default-instance-role pass-role, and the boundary's `autoscaling` and `events`, which only AgentCore's managed
  operator policy needed. The access-stack test confirms nothing else uses them.
- `infra/lib/naming.ts`: without the runtime, capacity-provider and AgentCore security-group names.

## Production order (operator-executed)
1. Delete the two runtimes, then the capacity provider (the runtimes reference it).
2. Execute the foundation change set. The capacity provider was `Retain`, so CloudFormation only forgets it; the
   operator role and the security group, which have no network interfaces, are deleted.
3. Merge; the pipeline releases the control plane without AgentCore grants.
4. Execute the pipeline change set, which the release never deploys.
5. Delete the leftover `/aws/bedrock-agentcore/runtimes/*` log groups, then run the account check.

## Constitution Check

PASS. Nothing in use is removed. The foundation is changed through a reviewed change set, as the release requires.
