# Additive CharterArc demo onboarding

Status: proposed implementation specification for owner review. No runtime change or deployment is claimed.

## Purpose

Connect the separately installed CharterArc Demo GitHub App and the Team Tasks demo repository to AgentX without replacing the GitHub App or runtime serving existing projects. This enables M1 13 and M1 14; immutable candidate publication and conversation restoration remain AgentX issues #2 and #1 respectively.

## Authority and starting point

The owner requested the required setup changes on a separate branch. Use `codex/charterarc-demo-setup`, based on inspected `mainline` commit `925ad3859d502047c87df84cc2306523a65aed43`. Do not merge into or deploy mainline automatically. The product objective is MSDLC-OBJ-001@0.3, SHA-256 `bc902e9dcecec61f32d748ae290dcab417311db1382e5dbcac59bb1887845843`.

Preserve the AgentX constitution: administrator-prepared projects, authenticated workspace ownership, remote coding, one writer, explicit recovery and honest demo-storage limits. No customer data, production merge/deploy, broader model access or evidence qualification is added.

## Observed setup and missing proof

- New private GitHub App ID 5006456, installation 163149623, selected repository `PrepLabsAI/charterarc-integration-demo` only. Contents/PR write and Metadata read are approved.
- Existing broker configuration uses app 5002502, installation 163046162 and credential reference `github-agentx-sdlc`. Preserve these settings and the existing private key.
- `packages/broker/src/aws/broker.ts` constructs one global GitHub provider for both repository grants and PR APIs. Merely installing another app does not route requests to it.
- AWS DEFAULT runtime is READY on version 10, container digest `05db3fd9182587c9b580669a6a3b374923813bb533a8079c1c5ae05f6e7c90c4`. This does not establish the source commit or a passing integration run.
- The base image supplies Node 22, Git and SSH, not the demo's pinned Python/uv/Node 24/browser tools.
- The project image field is metadata; the registered AgentCore runtime binding chooses the actual container.
- The available AWS CLI profile is read-only. Secret creation, ECR upload, CloudFormation deployment and project registration have not been performed.

## Selected approach and alternatives

Use an additive credential registry and a separate Team Tasks runtime binding. Reuse the current broker, dispatch, authorization and CDK patterns.

Rejected for this task: replacing the existing singleton app with the new app, because it can break existing repositories; deploying a second full control plane by default, because it duplicates operational state and cost. A separate broker remains an explicit fallback if compatibility cannot be preserved safely.

## 1. Credential routing

Keep legacy environment parameters valid. Add an optional server-controlled registry of additional GitHub App bindings, absent/empty by default. Each binding contains:

- unique credential reference;
- GitHub account, app ID and installation ID;
- exact Secrets Manager ARN, never PEM text;
- nonempty explicit repository allowlist using canonical GitHub HTTPS identities.

Use the proposed reference `github-charterarc-demo` for this demo app. Its only permitted repository is `https://github.com/PrepLabsAI/charterarc-integration-demo.git`.

Validate configuration at startup/synthesis. Reject duplicate references, duplicate/ambiguous repository assignments, malformed IDs/URLs/ARNs, embedded URL credentials, unsupported hosts and account/repository mismatches. Error messages must not echo secret values or the full configuration.

Repository-grant routing checks both credential reference and the trusted registered repository. A repository explicitly assigned to the new app cannot fall back to the legacy app on mismatch or failure. Preserve the existing explicitly supported public-repository behavior for unrelated projects; do not use public fallback to hide failure for the private demo repo.

PR create/read/update/reconciliation must resolve the same app from the server-owned project/repository binding or persisted publication record, not an arbitrary caller-supplied app ID. Do not fix cloning while leaving PR APIs pointed at the old singleton.

Load each key through its own cached loader; a failed load is retryable and cannot poison another app's cache. Installation tokens stay repository/action scoped and are not returned in public events or logs. Existing owner/membership/grant checks remain unchanged.

## 2. Cloud configuration

CDK keeps the existing stack resources and legacy app parameters unchanged by default. Additional bindings are explicit deployment input. Grant the broker `secretsmanager:GetSecretValue` only for each exact configured secret ARN; do not grant wildcard secret access or grant the private key to coding workers. If a customer-managed KMS key is used, its exact decrypt grant requires explicit configuration; do not widen access opportunistically.

Create a new secret for the downloaded demo PEM. Never overwrite the old secret. Before deployment inspect the synthesized change set for resource replacement, IAM changes and retained existing parameters. No deployment is possible through the audit identity; an authorized operator session is required.

## 3. Team Tasks environment

Build a separate image/runtime for the demo so existing sessions are not invalidated by updating the shared runtime. Preserve the AgentX worker's Node 22 requirement. Supply the demo application's pinned Node 24 and Python 3.12 toolchains through a separate application-tool path or explicit executable paths. Do not globally switch the worker to Node 24 merely because the app needs it.

Pin tool and base-image versions/digests to verified producer artifacts. Install uv and browser system dependencies in the image. Run preparation as the existing non-root worker. Build for the supported AgentCore demo architecture. Measure final image and dependency footprint; do not assume the app/browser fits the demo workspace's storage limit.

The new runtime uses existing `DemoRuntimeStack` semantics with a distinct stack and runtime name. It must not replace `AgentXDemoRuntime`. Preserve bounded idle/lifetime settings and selected Bedrock model; do not broaden model access in this task.

Image acceptance: worker starts on its supported Node version; the application commands use their pinned versions; Python setup, web dependency install, build and browser smoke checks succeed without root or publication credentials. A Docker build alone is not live AgentCore proof.

## 4. Project configuration and admission

Generate a schema-v2 project definition with the live control-plane/OIDC metadata, exact new image digest, demo repository/path, credential reference, setup/readiness commands and scoped instructions. It contains no tokens, PEM or owner/workspace/session IDs.

Before registration verify that the selected runtime endpoint actually uses the specified image. Do not invent an ARN or digest. The exact demo base is approved input: current schema has only `defaultBranch`, so the bounded demo must assert the resolved commit equals the approved base before coding. A moved branch fails closed rather than silently selecting new code. Per-job base binding is handled by the candidate/job contract work.

Register an immutable project revision, prepare a dedicated workspace for the authenticated owner's Cognito subject, and prove private clone plus readiness. Project registration needs an AgentX `agentx-admin` login; an AWS IAM administrator is not automatically that login. The supplied screenshot showed only the existing collaborator's Cognito user, so the owner's login must be created separately rather than reused.

`make setup` and `make baseline` are app/environment checks. They cannot qualify CharterArc's independent acceptance evidence. Keep independent verifier credentials and tests outside the coding workspace.

## 5. Files and integration boundaries

| Area | Change |
|---|---|
| New broker credential-router module | Parse/validate additional bindings; repository/ref routing; key-loader isolation; PR routing |
| `packages/broker/src/aws/broker.ts` | Construct router and use it consistently for grants and PR operations; no unrelated handler rewrite |
| `infra/lib/control-plane.ts` | Optional additive registry configuration and exact secret-read permissions; unchanged default template |
| `infra/bin/agentx.ts`, `infra/lib/demo-runtime.ts` | Explicit opt-in separate demo runtime/name; preserve old stack identity |
| `environments/team-tasks/Dockerfile` | Compatible pinned application tools while preserving the worker runtime |
| Project configuration generator/example | Validate required deployment inputs and base pin; no fabricated ready-to-run image |
| `tests/contract/github-app.test.ts`, infrastructure/project tests and new router tests | Behavioral regression and least-privilege checks |
| This feature's plan/tasks/runbook | Exact operator steps, rollback, proof and remaining unknowns |

## Acceptance

1. Without the additional registry, all existing credential and PR tests behave unchanged.
2. The old app still serves an existing project while the new app serves only the demo repository.
3. Clone, push and every PR lifecycle API choose the correct installation. Wrong reference, repository, account and ambiguous config are rejected before token use.
4. No fallback to another app on permission/network/key-load failure. No PEM/token values in logs, errors or project YAML.
5. Synthesized default infrastructure does not replace existing resources. Added secret grants name only approved secrets; new runtime has a separate identity.
6. The demo image proves both worker and application toolchains and app baseline checks. Exact image and source revision are recorded.
7. Registration fails when runtime image or starting commit differs; unauthorized registration/preparation fails.
8. Actual AWS private clone/readiness and authorized candidate-ref push are recorded separately from mocked/local checks. Pushing is not authorized merely by cloning successfully.
9. Existing stack/project smoke tests pass after activation; a failure rolls back the additive configuration without deleting source, evidence or the existing app.

## Rollout and rollback

Code and deterministic tests first on the separate feature branch; image build and CDK synthesis next; operator reviews the exact change set; then create the new secret/runtime/project and run the bounded smoke test. Keep the original app and runtime available throughout.

Rollback removes the new binding from active routing and disables new demo work. Revoke new installation tokens as needed. Retain evidence and diagnose before deleting any secret/runtime/project; destructive cleanup is a separately targeted operator action. Do not rewrite previously recorded candidates or receipts.

## Product scope mapping

| Requirement | Classification | Full-product status | Current-phase status | Reason |
|---|---|---|---|---|
| Existing-project compatibility | constraint | retained | included | Preserve parallel work |
| Exact code/environment binding | invariant | retained | included as demo base assertion and image check | Branch/config labels alone are insufficient |
| Separate verifier/approval authority | invariant | retained | included | Setup cannot self-qualify evidence |
| General customer onboarding | capability | retained | phased | This is one synthetic internal project |
| Other model gateways/clouds | capability | retained | phased | Existing Bedrock/AWS demo scope |
| Production release | authority constraint | retained | excluded | No implicit merge/deployment authority |

## Review gate

This file makes the proposed credential and runtime boundaries reviewable. It is not a completed implementation plan or runtime change. Confirm this written specification before generating the detailed test-first plan and implementing the credential-routing change. The separate-branch requirement remains in force throughout.
