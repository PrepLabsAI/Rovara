# Implementation Plan: Releases Publish Only the EC2 Worker Settings

**Branch**: `feat/117-release-worker-settings` | **Date**: 2026-09-27 | **Spec**: [spec.md](spec.md)

- `infra/lib/worker-settings.ts`: `WorkerSettingsStack`, the SSM parameters and their four template
  parameters, moved from `AgentRuntimeStack` with the same construct IDs. `infra/lib/app.ts` builds it as
  `AgentXProductionRuntime`; the stack keeps its name, since renaming a stack means replacing it.
- `infra/lib/agent-runtime.ts` keeps only the constants the foundation and demo stacks still import; they go
  with #118 and #119.
- `scripts/release-production.ts`: remove the capacity provider wait, runtime wait, runtime log retention,
  control-plane URL check and demo-runtime fallback; the manifest records `ec2-ebs` and the model settings.
- `packages/cli/src/deploy/parameters.ts`: the `runtime` part passes only the image and model.
- Tests: the settings stack pins the production logical IDs; the pull-through tests move from the runtime to
  the foundation's instance role; deploy and export tests stop expecting the removed parameters; the
  legacy template snapshot loses the runtime.
- The one-off drain script from the cutover (`scripts/close-agentcore-workspaces.ts`, `npm run
  drain:agentcore`) ships here too; #119 removes it.

## Constitution Check

PASS. The released change is removal only: the SSM parameters are unchanged, and the retained runtime
leaves no workspace without compute, because none uses it. Rollback is redeploying the previous release.
