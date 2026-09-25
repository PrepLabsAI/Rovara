# Implementation Plan: Connector Gateway

**Date**: 2026-09-24 | **Spec**: [spec.md](spec.md) | **Branch**: `feat/013-connector-gateway`

## Summary

Extract the feature 007 engine into a new `@agentx/gateway` package behind five interfaces, move
GitHub onto it without behavior change, then generalize configuration, routes and credentials,
reshape what the orchestrator sees, add turn records and alarms, and add Linear and Jira as
connectors. Every phase is a separate pull request to `mainline` that leaves the system releasable.

## Technical Context

- TypeScript 5.9, Node 22.19–22.x, npm workspaces, Vitest 5, ESLint type-checked rules.
- MCP SDK 1.30.1 (already pinned by the broker); Ajv through the SDK's validator.
- Pi `@earendil-works/pi-coding-agent` 0.85.1 for the orchestrator: `defineTool`,
  `setActiveTools`, extension events `tool_execution_start|end`, `turn_end`, `agent_end`.
- AWS: existing broker Lambda, state table, Slack service on Fargate; new `TurnRecords` table and
  SNS topic in `AgentXControlPlane`. Metrics through CloudWatch embedded metric format.
- Tests import package sources and resolve workspace packages through their built `dist`, so
  `npm run build` (or `npm run typecheck`, which emits) precedes `npm test`, as in CI and releases.
- No new third-party runtime dependency. Schema flattening is written in the gateway (bounded
  `$ref`/`$defs` inlining and `allOf` merge), not added as a library.

## Constitution Check (2.1.0)

- **I.** Connector tools remain control-plane mediated; credentials never enter model context;
  writes keep durable deduplication; scope is project plus connector scope; each connector's setup
  guide requires vendor-side credential limits. Tool registration still enforces the orchestration
  boundary (`assertOrchestrationOnly` is updated to the new names, never widened to worker tools).
- **II–III.** No change to project preparation or workspace isolation.
- **IV.** Ledger semantics unchanged; turn records are written once per Slack event.
- **V.** Each phase has behavioral tests; live acceptance is recorded separately in `quickstart.md`
  and never inferred from mocks.

## Project Structure

```text
packages/gateway/                 new: @agentx/gateway
  src/index.ts                    public exports
  src/mcp-client.ts               moved from packages/broker/src/mcp-client.ts
  src/types.ts                    Connector, CredentialProvider, Binder, Guard, Ledger, results
  src/engine.ts                   discoverTools, approveTools, executeTool
  src/util.ts                     fingerprint, canonical, resultText, isObject, withDeadline
  src/github.ts                   GitHub endpoint, binder, issue-not-PR guard
  src/schema.ts                   phase 1b: $ref/$defs flattening
  src/catalog.ts                  phase 1b: presented names, target enum, descriptions, cache
  src/credentials/*.ts            phase 3: registry, static-secret, oauth-client-credentials
  src/linear.ts, src/jira.ts      phases 5–6
packages/broker/src/github-mcp.ts phase 1a: feature 007 names delegating to the gateway
packages/broker/src/mcp-client.ts phase 1a: re-export from the gateway
packages/broker/src/aws/connectors.ts   phase 1b: connector routes and aliases
packages/broker/src/aws/credentials.ts  phase 3: registry store and admin routes
packages/broker/src/aws/turns.ts        phase 4: turn export route
packages/contracts/src/connectors.ts    phase 1b: connector config, catalog, request, result
packages/contracts/src/usage.ts         phase 4: TaskUsageTelemetry moved from the worker
packages/orchestrator/src/connector-tools.ts  phase 2: replaces mcp-tools.ts
packages/orchestrator/src/manifest.ts         phase 2: capabilities manifest
packages/orchestrator/src/turn-recorder.ts    phase 4: hidden extension collecting the record
packages/slack-service/src/turn-records.ts    phase 4: DynamoDB writer, metrics
packages/cli/src/admin/credential.ts, turns.ts  phases 3–4
infra/lib/control-plane.ts        phases 3–4: secret prefix grant, TurnRecords, SNS, alarms
tests/eval/                       phase 4: cases, runner, baselines
```

## Phases

| Phase | Pull request | Depends on | Detailed plan |
|---|---|---|---|
| 1a | Extract `@agentx/gateway`; GitHub behind it; no behavior change | — | [plans/phase-1a-gateway-extraction.md](plans/phase-1a-gateway-extraction.md) |
| 1b | `integrations.connectors` with `githubMcp` shim; `/connectors/` routes with `/github/` aliases; ledger key; schema flattening; catalog cache | 1a | written after 1a merges |
| 2 | Presentation: names, `target`, descriptions, manifest, not-connected result, PR tool consolidation, conditional recovery tools, rename table, budget | 1b | written after 1b merges |
| 3 | Credential registry, providers, admin commands, registration preflight | 1b | [plans/phase-3-credentials.md](plans/phase-3-credentials.md) |
| 4 | Turn records, shared usage contract, metrics, alarms, export, evaluation tiers | 2 | [plans/phase-4-turn-records.md](plans/phase-4-turn-records.md) |
| 5a | Generic connector types and routes; registration preflight and thread setup cover every configured type | 3 | [plans/phase-5a-generic-connectors.md](plans/phase-5a-generic-connectors.md) |
| 5b | Shared binder: bind a property on every tool or only where present; guards get the scope and can rewrite arguments | 5a | [plans/phase-5b-binder.md](plans/phase-5b-binder.md) |
| 5 | Linear connector | 5b | [plans/phase-5-linear.md](plans/phase-5-linear.md) |
| 6 | Jira connector (live check gated on Atlassian administrator) | 5b | [plans/phase-6-jira.md](plans/phase-6-jira.md) |

Detailed plans are written per phase, immediately before it starts, because each phase ships and is
reviewed on its own and later phases build on names that review may change. The task list in
[tasks.md](tasks.md) covers every phase at the level Spec Kit uses.

## Risks

- **Parallel changes on `mainline`.** Phase 1a is a move that does not touch `broker.ts` at all; later phases confine route logic to new files and keep `broker.ts` edits to wiring.
- **Rolling deployment.** The release deploys the runtime before the control plane and the Slack
  service after it. Aliases, the legacy ledger key and optional response fields keep every
  intermediate combination working.
- **Vendor schemas.** Recorded fixtures may lag the live servers; registration preflight reports
  drift at registration time and metrics report it at run time.
