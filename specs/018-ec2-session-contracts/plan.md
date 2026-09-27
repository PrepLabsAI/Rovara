# Implementation Plan: EC2 Session Contracts

**Branch**: `feat/079-ec2-session-contracts` | **Date**: 2026-09-27 | **Spec**: [spec.md](spec.md)

Add `ec2-ebs` to the deployment mode enum and a new `packages/contracts/src/session.ts` for the EC2
binding, `SESSION` record and invoke-token claims. Keep `WorkspaceInstanceSchema` a single strict object
so AgentCore error messages are unchanged, make the AgentCore routing fields optional there, enforce them
per mode in the refinement, and type the output as a union discriminated by `deploymentMode`. The union
makes the compiler flag every broker read of AgentCore fields.

In the broker, `RuntimeBinding` and `DurableOutboxRecord` become unions. `parseRuntimeBinding` sends
`ec2-ebs` input to the new schema and leaves the AgentCore parser's order untouched. `outboxRecord` routes
by the workspace's mode, rejecting a project binding of the other kind. Stop, close completion, dispatch and
CLI registration switch on the mode; their `ec2-ebs` branches refuse until #84 and #87 supply the behavior.

## Constitution Check

PASS. Contracts and explicit refusals only; no deployed behavior changes for AgentCore workspaces, no new
infrastructure, and requirements, plan, tasks and verification are recorded here.
