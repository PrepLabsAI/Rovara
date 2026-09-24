# Implementation Plan: Retire the Local CLI Development Mode

## Summary

Move the orchestrator runtime and its client code out of `@agentx/cli` into a new `@agentx/orchestrator` package, so the hosted Slack service no longer depends on a command-line client. Cut the developer commands and their modules from `agentx`, leaving `login` and the administration commands. Close the OIDC entry point to developer workspace operations, leaving the Slack service route and administration routes as they are. Follow the package through both images, the release image-input lists and the pipeline trigger.

## Technical Context

- TypeScript 5.9 / Node.js 22.23.2 monorepo, npm workspaces, project references. Vitest. AWS CDK.
- `packages/slack-service/src/main.ts` imported `@agentx/cli/orchestrator`, `@agentx/cli/control-plane-api` and `@agentx/cli/event-client`.
- The broker's OIDC branch fell through to `routeWorkspaceRequest`, the same function the Slack service route reaches through `/v1/service/*`.
- `environments/slack/Dockerfile` built and copied `packages/cli`; `environments/base/Dockerfile` copies every workspace `package.json` for `npm ci`.

## Constitution Check (v2.0.0)

- **I:** The orchestration boundary moves package but does not change: `createOrchestrationTools` and `assertOrchestrationOnly` still gate the tool list, and the interactive local entry point is deleted rather than relocated. The control plane now refuses developer work that does not come through the orchestrator's service identity.
- **II:** Project registration and channel binding stay administrator-only, through the kept commands.
- **III:** Thread ownership is the only owner model left. No route creates a personal workspace; the existing ones are stopped and kept.
- **IV:** Durable state is untouched. Deleting the local reconnect-state file removes only per-machine client state.
- **V:** This spec, plan and tasks; behavioural tests for the command surface, the refused OIDC path and the unchanged Slack path.

## Design

### 1. `@agentx/orchestrator`

`orchestrator.ts`, `orchestration-tools.ts`, `mcp-tools.ts`, `control-plane-api.ts` and `event-client.ts` move unchanged except for the interactive entry point. The package exports both a root index and the three subpaths the Slack service already imported, so its import sites change only in their package name. `runOrchestratorInteractive` and its `InteractiveMode` import are deleted with the TUI, and the system prompt and boundary extension drop the word "local", which now names nothing.

### 2. The `agentx` executable

`main.ts` keeps `login` plus `admin project register`, `admin workspace stop` and `admin slack bind|unbind`. `tui.ts`, `connect.ts`, `client-state.ts`, `status.ts`, `cancel.ts`, `pull-request.ts`, `feedback.ts`, `slack-credentials.ts`, `secret-store.ts` and `admin/prepare.ts` are deleted. `secret-store.ts` goes because only the retired Slack credential helper used it; `token-store.ts` stays, because the administration commands authenticate with it. The package drops its `exports` map and its `pi-coding-agent` and `typebox` dependencies.

### 3. Broker

The OIDC branch serves administration only. After the administration routes it throws `FORBIDDEN` with a message naming Slack, instead of falling through to `routeWorkspaceRequest`. `/v1/service/*` still reaches that function with a thread identity, so the hosted path is untouched. Feature 007's GitHub MCP routes already moved into that shared router when the hosted orchestrator gained them, so they keep working for Slack threads and lose only their OIDC entry.

### 4. Build and release

Both Dockerfiles copy `packages/orchestrator/package.json` for `npm ci`; the Slack image builds and ships `packages/orchestrator` in place of `packages/cli`. `WORKER_IMAGE_INPUTS` gains the new manifest, `SLACK_ORCHESTRATOR_IMAGE_INPUTS` swaps the CLI directory for the orchestrator directory and keeps the CLI manifest, and the smoke test imports the new specifiers. The trigger glob becomes `packages/{broker,cli,contracts,orchestrator,slack-service,worker}/**`, still one of four patterns, within CodePipeline's limit of eight.

### 5. Tests

The moved modules' tests follow the move by import path, including the hosted GitHub MCP integration test. `cli-main` asserts the exact command list; `cli-execution` exercises `admin workspace stop` and `admin slack bind` and asserts the retired commands fail without reaching the control plane. The publication test in `cloud-handlers` moves to the service path, where it now also asserts the Slack attribution the broker adds, and asserts that the same publication through OIDC is refused. `slack-control-plane` expects the refusal instead of a not-found for personal and administrator logins, including on the GitHub MCP route. `github-mcp-broker` drives the service path with a thread identity, keeping its authorization matrix, and adds the OIDC refusal. The local Slack-mode test is reduced to the Slack text helpers it still covers.

## Deviation

Issue #11 lists `login` among the developer commands to remove. Every kept administration command reads its access token from the store that `login` fills, so removing it would leave them unusable; there is no other way to obtain a token. `login` is therefore kept and the command-surface test asserts it. Removing it belongs with the Slack setup UX that replaces the administration CLI.
