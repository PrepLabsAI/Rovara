# Implementation Plan: Project Worker Model Selection

**Branch**: `feature/031-project-model-selection` | **Date**: 2026-09-27 | **Spec**: [spec.md](spec.md)

## Summary

Add optional model policy to project revisions, persist a mutable project selection, resolve it in the broker for every new task, and expose deterministic Slack commands. The signed task invocation carries the resolved pair; an absent field retains worker environment defaults.

## Technical Context

**Language/Version**: TypeScript 5.9, Node.js 22  
**Dependencies**: Zod, AWS SDK v3, Slack Events API, Pi coding agent  
**Storage**: Existing DynamoDB control-plane table  
**Testing**: Vitest contract and integration suites  
**Platform**: AWS Lambda broker/Slack service and AgentCore worker container  
**Constraints**: Backward-compatible optional fields, deterministic commands, latest-policy validation, at most 16 models

## Constitution Check

- Spec, plan, tasks, focused tests, documentation, and convergence are included.
- Shared contracts precede service changes.
- Authorization stays in the broker; Slack has no table access.
- Inputs are strict and bounded; optional protocol fields preserve rollout compatibility.

Post-design re-check: PASS. Signed service identity, project binding, task fencing, and callback authority remain intact.

## Project Structure

```text
packages/contracts/src/       # shared policy/API/invocation schemas
packages/broker/src/aws/      # persistence and task resolution
packages/slack-service/src/   # deterministic commands and service calls
packages/worker/src/          # invocation override and environment fallback
tests/contract/               # schema, broker, routing tests
tests/integration/            # Slack and worker behavior
docs/                         # configuration and rollout guidance
```

**Structure Decision**: Extend existing package boundaries and the DynamoDB single-table layout.
