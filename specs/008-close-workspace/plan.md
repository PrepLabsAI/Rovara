# Implementation Plan: Close Slack Thread Workspace

**Branch**: `feature/024-close-workspace` | **Date**: 2026-09-24 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `specs/008-close-workspace/spec.md`

## Summary

Add a deterministic Slack close command that bypasses ordinary workspace creation, starts a fenced worker preflight, blocks deletion when Git work exists only on the workspace, deletes the AgentCore capacity-provider session for a clean production workspace, retains a closed tombstone, releases quota, removes hosted conversation state, and keeps all completion and failure messages in the owning thread.

## Technical Context

**Language/Version**: TypeScript 5.9 on Node.js 22
**Primary Dependencies**: Zod 4, AWS SDK v3, AWS CDK v2, Vitest, hosted Pi orchestrator
**Storage**: Existing DynamoDB control-plane and Slack-thread tables; existing S3 Slack session bucket; AgentCore Instances EBS session
**Testing**: Vitest contract and integration suites; TypeScript typecheck; ESLint; CDK synthesis
**Target Platform**: AWS Lambda control plane, ECS hosted Slack service, Bedrock AgentCore runtime
**Project Type**: npm workspaces monorepo
**Performance Goals**: Close recognition before model invocation; no polling beyond the existing operation wait path; bounded Git inspection per repository
**Constraints**: One active operation per workspace, Slack thread isolation, durable idempotency, no deletion of unpublished work, rolling compatibility across control-plane/runtime/service deployment order
**Scale/Scope**: One workspace close at a time per Slack FIFO thread; existing organization and member workspace limits

## Constitution Check

- **I — Orchestration-only clients**: PASS. Slack only recognizes and routes the close intent. Git inspection runs in the remote worker; resource deletion is mediated by the authenticated control plane.
- **II — Administrator-prepared projects**: PASS. Closure uses the existing prepared manifest and does not change project configuration.
- **III — Shared definitions, isolated instances**: PASS. Workspace resolution uses the server-owned Slack subject and closed resources are scoped to that workspace session.
- **IV — Durable working state**: PASS. Closure acquires the operation fence, blocks on unpublished work, preserves a tombstone, and makes retries idempotent.
- **V — Evidence-based delivery**: PASS. The specification, design, contracts, tasks, tests, and local verification are recorded in this feature directory.

Post-design check: PASS. The interface contracts do not expose workspace identifiers in close requests, and the state model prevents a closed thread from implicitly recreating a workspace.

## Project Structure

### Documentation

```text
specs/008-close-workspace/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── slack-close.md
├── checklists/
│   └── requirements.md
└── tasks.md
```

### Source Code

```text
packages/contracts/src/          # workspace, operation, protocol and Slack result schemas
packages/worker/src/             # repository close preflight
packages/broker/src/aws/         # service routes, durable fencing, callbacks and AgentCore deletion
packages/slack-service/src/      # command recognition, close flow and session removal
infra/lib/                       # broker delete-session permission
tests/contract/                  # schemas, broker lifecycle and IAM synthesis
tests/integration/               # worker preflight and Slack processing
README.md                        # user-visible Slack close behavior
```

**Structure Decision**: Extend the existing packages and AWS broker rather than add another cleanup service. The Slack FIFO consumer already serializes each thread, the outbox already dispatches fenced worker operations, and the broker already owns AgentCore lifecycle permissions.

## Design

1. The Slack processor recognizes only an explicit close phrase after stripping the leading app mention. It calls the close endpoint before `ensureWorkspace`, preventing accidental creation in an empty thread.
2. The broker resolves the workspace from the authenticated Slack owner key. It returns a typed absent or closed outcome, refuses an active operation, or atomically changes an idle workspace to `CLOSING`, increments its fence, and creates one idempotent `close` operation and outbox record.
3. The worker reads the preparation manifest and inspects each repository. Any worktree changes, untracked files, commits not reachable from a remote ref, or local branch commits not reachable from a remote ref produce a bounded unsafe result. An unsafe result is a successful preflight result, not an infrastructure failure.
4. The terminal callback leaves a safe workspace in `CLOSING`; an unsafe or failed preflight returns it to its prior runnable state. The Slack processor waits through the existing operation polling API.
5. For a safe result, the Slack service calls the completion endpoint. The broker deletes an Instances capacity-provider session, treats an absent session as already deleted, and transitions to `CLOSED` while releasing organization and starter-member quota once.
6. The Slack service removes its S3 Pi transcript and clears live conversation identifiers after the broker confirms closure. Its Dynamo thread record retains the workspace ID and closed state so retries and later messages stay closed.
7. A later ordinary mention receives a closed-workspace message from the typed workspace result and never starts a model turn.

## Deployment Compatibility

- Deploy the worker and control plane before the Slack service so the new close invocation and routes exist before messages can request them.
- Existing workspace records remain valid because new closure fields are optional and new statuses are only written by the new broker.
- An older Slack service never emits close requests. A newer Slack service treats a control plane without the route as a retryable processing failure until deployment completes.

## Complexity Tracking

No constitution violations or new infrastructure components are introduced. The two-step close API is required because the worker preflight is asynchronous and the persistent session must remain attached until inspection finishes.
