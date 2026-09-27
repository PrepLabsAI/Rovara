# Implementation Plan: GitHub App Installation per Repository Owner

**Branch**: `feat/123-github-installations` | **Date**: 2026-09-27 | **Spec**: [spec.md](spec.md)

- `packages/broker/src/github-app.ts`: `GitHubAppCredentialProvider` takes only the credential ref, App ID and
  key. `installed()` looks up and caches `{ id, login }` per lowercase owner; `createInstallationToken` retries once
  after a 404; `checkRepository` is the registration check. The repository URL check keeps the canonical-URL rule
  but no longer compares the owner with a configured account.
- `packages/broker/src/aws/broker.ts`: wiring without the two environment variables; `checkRepositoryAccess` is an
  optional dependency that registration calls for each repository of a new revision.
- `infra/lib/control-plane.ts`, `scripts/release-demo.ts`, `packages/cli/src/deploy/*`: the two parameters go.
  `agentx init` still records the installation it verifies during setup; deploy no longer passes it.
- Tests: provider tests answer the lookup through a wrapper; new tests cover the per-owner cache, the canonical
  owner, a repository the App cannot see, a reinstalled App and no GitHub call for other credentials; a
  registration test covers the refusal; the control-plane snapshot loses the two parameters.

## Constitution Check

PASS. The release removes two parameters and changes how the broker picks an installation; the pipeline passes
neither parameter. Rollback is redeploying the previous release with the parameters' previous values.
