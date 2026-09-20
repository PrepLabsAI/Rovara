# Team Tasks: isolated demo environment

This runbook prepares one synthetic internal project. It does not prove a live
coding round trip, independent verification, or customer readiness.

## Fixed inputs

| Input | Value |
|---|---|
| Account / region | 944937319445 / us-east-1 |
| New stack / runtime | CharterArcTeamTasksRuntime / charterarc_team_tasks_worker |
| ECR repository | charterarc-team-tasks-worker |
| Existing runtime | AgentXDemoRuntime — leave unchanged |
| GitHub repository | PrepLabsAI/charterarc-integration-demo |
| New credential reference | github-charterarc-demo |
| Baseline branch | codex/agentx-demo-baseline |
| Required starting commit | ee25daffed9f59e7c979477c6f0b5a05834c32e3 |
| Application tools | Python 3.12.14, Node 24.19.0, uv 0.12.5, Playwright 1.63.0 |
| Worker tool | Node 22.23.2, unchanged |
| Model | amazon-bedrock / amazon.nova-pro-v1:0, no new grants |

The newer integration-kit branch contains trusted verification material and must
not become the coding base. Independent verifier tests stay outside AgentX.

## Local image proof

Build `environments/team-tasks/Dockerfile` for linux/arm64. Use
`npm run image:build:team-tasks` with buildx installed, or `docker build --platform
linux/arm64 -t charterarc-team-tasks:local -f environments/team-tasks/Dockerfile .`.
Select an isolated Docker daemon explicitly. Do not mount a home directory, AWS
configuration, SSH agent, Docker socket, Slack tokens or GitHub credentials into
the image or smoke container. Keep source/configuration and image receipts pinned.

Create a Git bundle containing only the baseline branch from the demo repository.
Verify its head with `git bundle list-heads`. Copy the bundle to the smoke
container as `/tmp/baseline.bundle`; no working checkout mount is needed.
Run `/opt/agentx-node/bin/node /opt/team-tasks/smoke.mjs` as the image's non-root
user. Set `SMOKE_IMAGE=local/team-tasks@sha256:<actual local image ID>`.
That identifier is local build evidence, not an ECR manifest digest.

The smoke checks real worker preparation, the wrong-base rejection, pinned tools,
API tests, build, Chromium journeys, repeat preparation without resetting edits,
worker health, and writable workspace bytes below 800 MiB. Save
`/mnt/workspace/smoke-receipt.json`, image inspection, build output and
`/opt/team-tasks/os-packages.tsv`. Retain a failed container until diagnosed.
App tests are executor/environment evidence, not CharterArc qualification.

## Cloud activation gates

1. Activate the reviewed additive broker configuration. Preserve all legacy app
   parameters and its secret. Use the existing approved setup secret, not a PEM
   in the image or project file.
2. Request scoped ECR upload and new-stack deployment access. Neither is granted
   by the control-plane preparation policy. Do not reuse a broad administrator
   CLI login or replace the existing runtime.
3. Push the tested image to the new ECR repository. Capture the returned manifest
   digest and build source provenance. Never substitute a mutable image tag.
4. Synthesize `CharterArcTeamTasksRuntime` with context
   `agentxDeploymentMode=demo-microvm`, `agentxTeamTasksRuntime=true`,
   `agentxRegion=us-east-1`. Supply the exact ECR image, existing control-plane
   URL and selected model. Review the change set, then execute only with
   explicitly granted access. Existing runtime resources must not change.
5. Read the new runtime endpoint and the runtime version it serves. Require
   READY, correct account/region/name, and the exact image digest. Do not assume
   the latest source commit or latest runtime version is the served version.

## Project generation and admission

Use `scripts/team-tasks-project.ts` to validate observed inputs. The input JSON
contains `imageUri`, `branchCommit`, and `runtimeObservation` with `account`,
`region`, `runtimeName`, `status`, `imageUri`. All must come from fresh observations;
the generator validates consistency, not the truth or freshness of a handwritten
file. It deliberately fails without a real pinned ECR image and READY observation.

Before registration:

- Re-read the baseline remote ref. If absent, create it at the approved commit
  without force. If present but different, stop; never reset it.
- Refresh the endpoint/runtime observation immediately before the write.
- Reconcile existing project name/revision. Preserve immutable revision 1 if it
  exists; a conflict requires inspection, never an overwrite.
- Generate the definition with `npx tsx scripts/team-tasks-project.ts observed-input.json`.
  JSON is valid YAML for the existing CLI's file loader.
- Use the owner's existing AgentX admin session, not AWS credentials as a human
  product token. Register with the existing `agentx admin project register --file
  <definition> --runtime-arn <observed ARN> --deployment-mode demo-microvm`.
- Prepare only the owner's dedicated workspace through `agentx --project
  charterarc-team-tasks admin workspace prepare --owner <verified Cognito subject>`
  after saving the generated definition as `charterarc-team-tasks.yaml` in a
  dedicated directory and supplying `--config-dir <that-directory>` to the CLI.
  Do not overwrite an existing local project definition without comparison.
- Inspect READY and the persisted preparation manifest. Require exact base,
  image, successful setup/readiness and existing-project smoke. A moving branch
  is rejected by preparation before dependency installation; never reset it to
  hide a mismatch. Re-read runtime image before accepting coding work.

The project generator does not register anything or select a runtime ARN for the
operator. The live registration command and observation must refer to the same
endpoint. A completed manifest can resume user edits; it is not fresh evidence
about a newly changed environment. Runtime changes require new explicit admission.

## Remaining product dependencies

AgentX issue #2 is the complete immutable candidate handoff/publication boundary.
Issue #1 is conversation restoration. CharterArc still needs the real adapter,
independent verification, and shared Slack/web approval before the seamless demo.
Do not label environment preparation as completion of those tasks.

## Rollback and cleanup

Disable new demo work and remove the new routing binding if activation breaks
existing projects. Keep original runtime/app available. Retain failure receipts.
Deleting a cloud stack, secret, repository or retained evidence requires a separate
targeted cleanup decision. Stop the dedicated local VM when finished; do not
delete its disk or unrelated Docker resources as a side effect of this runbook.
