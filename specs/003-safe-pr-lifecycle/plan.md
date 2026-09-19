# Implementation Plan: Safe Pull Request Lifecycle

**Branch**: `main` | **Date**: 2026-09-19 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/003-safe-pr-lifecycle/spec.md`

## Summary

Make publication independent of the persistent checkout's branch ancestry by capturing the workspace tree, three-way replaying its difference from the preparation baseline onto the latest remote default branch, and creating one commit. Add durable, ownership-checked lifecycle operations for fast-forward PR updates, merge-based base synchronization, metadata/state changes, replacement PRs, and merged-PR reverts. GitHub credentials remain broker-minted, repository-scoped capabilities; worker Git operations have no force-push path.

## Technical Context

**Language/Version**: TypeScript 5.9 on Node.js 22.19+

**Primary Dependencies**: AWS SDK v3, Zod 4, Commander, pi coding-agent 0.85.1, Git CLI, GitHub REST API

**Storage**: Existing DynamoDB single-table control-plane state and AgentCore managed workspace storage

**Testing**: Vitest contract/integration suites plus disposable Git repositories and live demo acceptance

**Target Platform**: Local macOS/Linux CLI, AWS Lambda control plane, Linux ARM64 AgentCore microVM worker

**Project Type**: npm workspace containing CLI, contracts, broker service, worker service, and CDK infrastructure

**Performance Goals**: One active writer per workspace; lifecycle API acknowledgement under normal Lambda latency; Git operations bounded by existing 120/300 second timeouts

**Constraints**: No force push, branch deletion, direct default-branch update, credential exposure, cross-workspace mutation, or automatic merge; 1 MiB captured command output and existing readiness limits

**Scale/Scope**: One selected repository per lifecycle operation; current demo account/installation with design valid for multiple projects, developers, and repositories

## Constitution Check

*GATE: Passed before and after design.*

- **Local orchestration, remote coding**: PASS. Local Pi receives typed lifecycle tools only; all checkout mutation runs remotely or as broker-owned GitHub metadata calls.
- **Administrator-prepared projects**: PASS. Every repository and default branch comes from the immutable registered project revision.
- **Shared definitions, isolated instances**: PASS. Lifecycle records are keyed by owned workspace and repository; publication remains the only sharing path.
- **Durable state, replaceable processes**: PASS. Operations, publication records, expected refs, and idempotency keys are durable and fenced.
- **Evidence-based delivery**: PASS. Contract, integration, and live scenarios cover ancestry, ownership, retries, and no-force guarantees.
- **Credential constraint**: PASS. The broker retains the App key; repository capabilities mint short-lived single-repository tokens and the worker never exposes them to Pi.

## Project Structure

### Documentation (this feature)

```text
specs/003-safe-pr-lifecycle/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
└── tasks.md
```

### Source Code (repository root)

```text
packages/
├── contracts/src/operation.ts
├── contracts/src/protocol.ts
├── broker/src/aws/broker.ts
├── broker/src/github-app.ts
├── worker/src/publish.ts
├── worker/src/maintain-pull-request.ts
├── worker/src/git-auth.ts
└── cli/src/

tests/
├── contract/
└── integration/
```

**Structure Decision**: Extend the existing workspace packages and test layout. No new deployable service or dependency is required.

## Complexity Tracking

No constitution violations require justification.
