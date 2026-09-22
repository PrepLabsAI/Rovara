# Quickstart: CodeBuild Publication Gates

## Administrator setup

1. Create or select an AWS CodeBuild project whose source is the registered GitHub repository. For private GitHub repositories, authorize the source through AWS CodeConnections/GitHub App.
2. Name the project with the `agentx-` prefix.
3. Configure its service role, image, compute size, buildspec, cache, artifacts, and secrets in AWS. Do not put secrets in the AgentX project file.
4. Ensure the build accepts an exact Git commit as the source version. Put unit, integration, and/or Playwright commands in the repository buildspec.
5. Add `codeBuildGates` to the repository in the shared AgentX project configuration and register a new immutable project revision.
6. Re-prepare developer workspaces for that revision, then publish normally with `agentx pr create` or the local Pi orchestration tools.

## Example buildspec

```yaml
version: 0.2
phases:
  install:
    runtime-versions:
      nodejs: 22
    commands:
      - npm ci
      - npx playwright install --with-deps chromium
  build:
    commands:
      - npm run typecheck
      - npm test
      - npx playwright test
```

## Expected behavior

- A new candidate branch can be visible in GitHub before the gate completes, but no PR exists until success.
- A failed gate leaves the candidate branch for diagnosis and returns a failed AgentX operation.
- Existing PR append/sync uses a separate validation branch, so failure leaves the PR head unchanged.
- Build evidence in the operation result links to CodeBuild/CloudWatch logs when AWS returns a link.

## Verification evidence

Local verification completed on 2026-09-19:

- `npm run typecheck` — passed
- `npm run lint` — passed
- `npm test` — 29 files and 111 tests passed
- `npm run infra:synth:demo` — passed
- AWS deployment and disposable-repository acceptance remain pending until explicitly requested.
