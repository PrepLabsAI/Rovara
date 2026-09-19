# Quickstart: Validate Pull Request Creation

## Prerequisites

- A registered project and READY owner workspace with one configured GitHub repository.
- A GitHub App installation covering that repository with Contents write and Pull requests write
  permissions approved by the installation owner.
- The App private key stored in the broker's configured Secrets Manager secret.
- Registered readiness commands that include the project's required automated tests.

Update the App under **GitHub Settings → Developer settings → GitHub Apps → AgentX SDLC →
Permissions & events → Repository permissions**. Set **Contents** and **Pull requests** to **Read
and write**, save, and approve the permission request on the App installation before deployment.
AgentX does not need Administration, Actions, Workflows, or a personal access token for this flow.

## Local quality gates

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run infra:synth:demo
```

Expected: contract/integration tests pass, including failed-check no-side-effect behavior,
repository grant access separation, retry idempotency, and the local orchestration tool boundary.

Observed locally on 2026-09-19: typecheck and lint passed; 85 tests across 27 files passed; the
VPC-free demo CDK stack synthesized successfully; and the ARM64 worker image built and returned
`{"status":"Healthy","activeOperations":0}` from `/ping`.

AWS deployment evidence on 2026-09-19:

- `AgentXControlPlane` and `AgentXDemoRuntime` reached `UPDATE_COMPLETE` in account `944937319445`.
- AgentCore reported `READY` for runtime `agentx_demo_worker-E4dYCR6f45`.
- The deployed worker image is
  `agentx-worker-demo@sha256:05db3fd9182587c9b580669a6a3b374923813bb533a8079c1c5ae05f6e7c90c4`.
- Fresh schema-v2 workspaces for `agentx@8`, `speckit@2`, and `personal-website@2` prepared
  successfully after the demo runtime-version storage reset.
- A live clean-checkout publication operation reached the new worker and failed safely with
  `repository has no changes to publish`; it created no branch or PR.
- The installation was upgraded to Contents write and Pull requests write. Live changed-checkout
  operation `201e1ceb-1f0d-47f5-8ee1-0eba290ecd18` created
  `ps06756/personal-website-test#1` successfully; the test PR was closed without merging.
- Live validation exposed and corrected the private-ref scope requirement: PR tokens now include
  Contents read alongside Pull requests write while remaining scoped to the selected repository.

## Live acceptance

1. Prepare a fresh demo workspace and submit a coding task that makes a small verifiable change.
2. Confirm the workspace remains READY after the coding task and inspect its returned diff evidence.
3. Run:

```sh
agentx --project personal-website pr create \
  --repository personal-website \
  --title "AgentX publication acceptance" \
  --body "Created by the AgentX pull-request acceptance workflow."
```

The equivalent TUI request is explicit: `Create a pull request for the personal-website repository
titled "AgentX publication acceptance".` Ordinary task completion never triggers publication.

4. Verify the terminal result includes repository, PR URL/number, head/base branches, commit, and
   passing checks.
5. Open the URL and confirm the PR targets `main`, contains only the expected change, and is authored
   through the GitHub App.
6. Repeat the same request ID through the contract fixture and verify no duplicate branch, commit,
   or pull request is created.
7. Introduce a failing readiness command in a disposable fixture and verify no remote side effect.

Do not merge the acceptance PR automatically. Merge and cleanup remain explicit human actions.
