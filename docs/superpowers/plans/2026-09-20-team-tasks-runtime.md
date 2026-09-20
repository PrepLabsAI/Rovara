# Team Tasks runtime and project admission implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare one isolated, pinned AgentX environment for the shared Team Tasks job without changing the runtime serving existing projects.

**Architecture:** Reuse the existing worker and DemoRuntimeStack. Add an opt-in distinct runtime name/stack, a pinned application-tool image, and a fail-closed project generator. Keep CharterArc verification outside this coding workspace.

**Tech Stack:** TypeScript, Vitest, CDK, Docker linux/arm64, Node 22.23.2 worker, Node 24.19.0 app, Python 3.12.14, uv 0.12.5, Playwright 1.63.0 Chromium.

**Spec:** `specs/004-charterarc-demo-onboarding/spec.md`, sections 3–4 and runtime/project acceptance.

Status: written for owner review; not implemented. Continue inline after approval. Credential routing is already implemented at `a84b323891dac3c940e6b52cecf2abb9e9d1f3b3` on `codex/charterarc-demo-setup`. Keep using that separate branch; no mainline merge.

## Global constraints

- Objective MSDLC-OBJ-001@0.3, SHA-256 `bc902e9dcecec61f32d748ae290dcab417311db1382e5dbcac59bb1887845843`.
- Repository `https://github.com/PrepLabsAI/charterarc-integration-demo.git`, credential `github-charterarc-demo`.
- Coding base commit `ee25daffed9f59e7c979477c6f0b5a05834c32e3`, tree `3409b03ef972fcf9c854e124d02e9b438b1730b2`. The current kit branch `f841346d3f6847145752dcf97ca464faeb81603d` contains trusted verification tooling and is NOT the coding base.
- Create only a new baseline reference `codex/agentx-demo-baseline` at the coding base after checking it is absent. If present, require exact equality; never force-push. Worker setup rechecks HEAD before dependency work. This ref is preparation, not an agent-produced candidate or PR.
- New stack `CharterArcTeamTasksRuntime`, runtime `charterarc_team_tasks_worker`, image repository `charterarc-team-tasks-worker`. Existing `AgentXDemoRuntime` and `agentx_demo_worker` unchanged.
- Keep `demo-microvm`, `/mnt/workspace`, 900-second idle timeout, 28,800-second lifetime. Preserve disclosed preview storage limitations. Measure writable workspace bytes; reject preparation at or above 800 MiB to leave headroom in the stated 1 GiB limit.
- Preserve current Bedrock selection `amazon-bedrock` / `amazon.nova-pro-v1:0`. This plan does not broaden model permissions. Fail explicitly if that model is unavailable.
- Preserve worker Node 22; all application commands go through `/opt/team-tasks/bin/app-env` with Node 24. No global worker upgrade.
- No PEM in image, project file or worker. No host AWS, Slack, GitHub credentials mounted into a local image test.
- Generated project must contain real pinned image and runtime metadata. Missing values are errors, not example digests.
- Current setup permission does not authorize ECR upload/runtime creation. Produce exact deployment inputs/change set and request scoped access before those cloud writes.
- Candidate freeze/publication (#2), conversation continuity (#1), and CharterArc's live adapter remain distinct dependencies. A prepared workspace is not the complete round trip.

## Review focus

1. Default stack synthesis must remain unchanged when the new runtime is not selected; Task 1 compares legacy resource identities/properties.
2. A normal Python venv can point outside the workspace; Task 2 exercises real preparation with copied executables and leaves containment checks intact.
3. A branch can move between admission and clone; Task 3 checks the exact prepared commit, not just the remote branch label.
4. Image metadata can disagree with the live endpoint; Task 3 rejects wrong image/account/region/runtime and non-READY observations before registration.
5. Dependencies/browser downloads can fill session storage; Task 2 bakes browser/tool binaries into the image, measures workspace usage and tests explicit over-budget rejection.

## Task 1: Opt-in separate runtime identity

**Files:** modify `infra/lib/demo-runtime.ts`, `infra/bin/agentx.ts`; extend `tests/contract/infrastructure.test.ts`.

**Interfaces:** `DemoRuntimeStackProps.runtimeName?: string` defaults to `agentx_demo_worker`. New context `agentxTeamTasksRuntime=true` selects stack `CharterArcTeamTasksRuntime` and runtime `charterarc_team_tasks_worker`; only valid with `agentxDeploymentMode=demo-microvm`. It does not instantiate a second copy of the control plane.

- [ ] Write failing synthesis tests:

```ts
const legacy = Template.fromStack(new DemoRuntimeStack(new App(), "AgentXDemoRuntime", {deploymentRegion:"us-east-1"}));
legacy.hasResourceProperties("AWS::BedrockAgentCore::Runtime", {AgentRuntimeName:"agentx_demo_worker"});
const separate = Template.fromStack(new DemoRuntimeStack(new App(), "CharterArcTeamTasksRuntime", {
  deploymentRegion:"us-east-1", runtimeName:"charterarc_team_tasks_worker"
}));
separate.hasResourceProperties("AWS::BedrockAgentCore::Runtime", {AgentRuntimeName:"charterarc_team_tasks_worker"});
separate.resourceCountIs("AWS::BedrockAgentCore::Runtime",1);
```

- [ ] Run `npm test -- tests/contract/infrastructure.test.ts`; require the new-name assertion to fail before implementation.
- [ ] Implement the optional property and validate `/^[A-Za-z][A-Za-z0-9_]{0,47}$/`. Use `props.runtimeName ?? "agentx_demo_worker"` only for `agentRuntimeName`; preserve the original child logical ID and existing defaults.
- [ ] In the entrypoint validate context boolean/string exactly (`true`, `"true"`, absent); reject invalid values and reject team-tasks selection with instances-ebs. Select the stack ID/name from the validated option. Preserve control-plane constructor behavior.
- [ ] Add negative name/mode tests; compare legacy resources with pre-change synthesis. Run tests, build, lint and synthesize only `CharterArcTeamTasksRuntime` with both required contexts. Record unchanged legacy template identity separately from new stack output.
- [ ] Commit `feat: add opt-in isolated Team Tasks runtime identity`.

## Task 2: Pinned image and genuine environment smoke test

**Files:** create `environments/team-tasks/Dockerfile`, `environments/team-tasks/toolchains.json`, `environments/team-tasks/app-env`, `environments/team-tasks/prepare-app.sh`, `environments/team-tasks/check-workspace.mjs`, `environments/team-tasks/smoke.mjs`; add `tests/contract/team-tasks-environment.test.ts` and package scripts.

**Interfaces:** `app-env COMMAND...` runs application tools; `prepare-app.sh EXPECTED_BASE` operates only in the prepared demo checkout; `checkWorkspace(path, limitBytes)` rejects excess bytes with `WORKSPACE_TOO_LARGE`; `smoke.mjs` reports worker/app versions, non-root identity, base HEAD, tests, and workspace bytes. It supplies no independent-evidence qualification.

`checkWorkspace` is an async exported function returning `{bytes:number}`; it
counts regular-file sizes recursively without following symlinks. Broken or
escaping symlinks fail; the real preparation path's stricter containment scan
still runs. Its CLI exits nonzero on failure and prints only the count on success.

Producer metadata observed 2026-09-20 (recheck before download):

| Artifact | Pin |
|---|---|
| Official Python image `python:3.12.14-slim-bookworm` | index `sha256:392307d22300de8b5986851a12d9176dfc0fc073e65bf6523ebd7dcbeb23564e`; linux/arm64 child `sha256:eb5be8e5b4d0a159c237946bbdd06356dda5d19c30fc4f7843e8046d3a590333` |
| `https://nodejs.org/dist/v22.23.2/node-v22.23.2-linux-arm64.tar.xz` | SHA-256 `fff4078c5def658577f92c88db7db3bc0072924bfb93fe52c1e744a54e94abb8` |
| `https://nodejs.org/dist/v24.19.0/node-v24.19.0-linux-arm64.tar.xz` | SHA-256 `01443c1e1a29e531ccad5a46fefa6df490d2189c49f7955904aecdbb0fe86fdc` |
| `https://github.com/astral-sh/uv/releases/download/0.12.5/uv-aarch64-unknown-linux-gnu.tar.gz` | SHA-256 `9bf43b4d1a07665bf64d4c4e710930b382321a785e0eb10aac07f46471f86a31` |

- [ ] Add failing tests that parse the toolchain manifest, reject modified download bytes, require separate Node paths, and prove `checkWorkspace` rejects a small temporary directory when its explicit byte limit is exceeded. Use a tiny generated fixture, not an 800-MiB test allocation.

```ts
const work = await mkdtemp(join(tmpdir(), "team-tasks-limit-"));
await writeFile(join(work,"sample"), Buffer.alloc(64));
await expect(checkWorkspace(work,32)).rejects.toThrow("WORKSPACE_TOO_LARGE");
await expect(checkWorkspace(work,128)).resolves.toEqual({bytes:64});
```

Use test-managed temporary cleanup in `afterEach`; never delete a user checkout.
- [ ] Run the new test file and observe missing implementation/behavior failures.
- [ ] Build worker packages in the existing pinned Node22 build stage. Final stage uses the pinned Python image. Install verified Node22 under `/opt/agentx-node` and Node24 under `/opt/app-node`; copy production worker dependencies/build output to `/opt/agentx`. Install Git, make, CA certificates and browser runtime libraries during image build, never as the worker. Capture resolved OS package inventory in the image build receipt.
- [ ] Pin a dedicated browser dependency lock with `@playwright/test@1.63.0` under `/opt/team-tasks/browser`; install only Chromium into `/opt/team-tasks/browsers` during build, then remove package download caches. Verify locked browser revision through a real launch. Do not treat the Chromium version as mobile/native proof.
- [ ] Create a non-root worker account and `/mnt/workspace` ownership. Set worker PATH to Node22 and launch `/opt/agentx-node/bin/node /opt/agentx/packages/worker/dist/main.js` explicitly. Keep Python in its official `/usr/local` layout.
- [ ] Implement application wrapper:

```sh
#!/bin/sh
set -eu
export PATH="/opt/app-node/bin:/usr/local/bin:/usr/bin:/bin"
export PLAYWRIGHT_BROWSERS_PATH=/opt/team-tasks/browsers
export UV_PYTHON_DOWNLOADS=never
export UV_LINK_MODE=copy
export UV_CACHE_DIR=/tmp/team-tasks-uv-cache
export npm_config_cache=/tmp/team-tasks-npm-cache
exec "$@"
```

- [ ] Implement setup without changing the agent's containment policy:

```sh
#!/bin/sh
set -eu
test "$(git rev-parse HEAD)" = "$1"
test -z "$(git status --porcelain)"
test "$(node --version)" = v24.19.0
test "$(python3.12 --version)" = 'Python 3.12.14'
test "$(uv --version)" = 'uv 0.12.5'
if test ! -d .venv; then python3.12 -m venv --copies .venv; fi
uv sync --frozen --python .venv/bin/python
npm --prefix app/web ci --ignore-scripts
```

The version commands must be checked against actual tool output; accept uv's build suffix only after testing the precise format, not by weakening the pinned version. `--copies` is needed because ordinary venv executable symlinks can point outside the workspace. `UV_LINK_MODE=copy` alone does not solve that.

- [ ] Write the smoke runner to call the real `prepareWorkspace` production path with the project commands and a synthetic local fixture materializer at the exact base. Copy source into a disposable mount; never mount the user's working checkout read/write or include `.aws`, `.config`, tokens or SSH agents. Readiness runs `make baseline` through `app-env`; retain exit codes and version output. Assertions require the manifest's exact resolved commit, `complete=true`, non-root UID and no out-of-workspace symlink. Exercise one deliberately wrong expected-base value and require failure before dependency install.
- [ ] Build `linux/arm64` using the project-local Docker/Colima toolchain, with an isolated builder/profile if none is running. No global Docker context change. A Docker CLI exists under ManagedSDLC `.local/toolchain/bin`; no daemon was reachable in the inspected default context. If starting a VM requires broader host permission, request it rather than substituting a claimed build.
- [ ] Run real image smoke: worker startup/health, Node22 worker, Node24 app, Python/uv versions, API tests, web build, Chromium tests, preparation retry without resetting files, and total workspace bytes below 800 MiB. Image layers are not counted as session bytes. Capture final image ID/digest and architecture; do not invent a registry digest before upload.
- [ ] Run full repository tests/build/lint. Commit `feat: provide pinned Team Tasks worker environment`.

## Task 3: Generate and validate a real project definition before admission

**Files:** create `scripts/team-tasks-project.ts`, `tests/contract/team-tasks-project.test.ts`, and `specs/004-charterarc-demo-onboarding/team-tasks-runbook.md`.

**Interfaces:** `buildTeamTasksProject({imageUri, runtimeObservation, branchCommit}): ProjectDefinition`. Observation includes account, region, runtime name, status and exact image URI, all obtained read-only from AWS. `branchCommit` is the observed baseline ref SHA. Runtime registration still uses the existing `registerProject`; no new registration endpoint.

```ts
type RuntimeObservation = {account:string;region:string;runtimeName:string;status:string;imageUri:string};
type TeamTasksProjectInput = {imageUri:string;runtimeObservation:RuntimeObservation;branchCommit:string};
// Exported by scripts/team-tasks-project.ts; validate every field before returning.
export function buildTeamTasksProject(input:TeamTasksProjectInput):ProjectDefinition;
```

- [ ] Add tests using synthetic metadata, with explicit production-code validation:

```ts
const imageUri = "944937319445.dkr.ecr.us-east-1.amazonaws.com/charterarc-team-tasks-worker@sha256:" + "a".repeat(64);
const otherImage = imageUri.replace(/a{64}$/, "b".repeat(64));
const valid = {imageUri,branchCommit:"ee25daffed9f59e7c979477c6f0b5a05834c32e3",runtimeObservation:{
  account:"944937319445",region:"us-east-1",runtimeName:"charterarc_team_tasks_worker",status:"READY",imageUri
}};
expect(() => buildTeamTasksProject({...valid, branchCommit:"0".repeat(40)})).toThrow(/base/i);
expect(() => buildTeamTasksProject({...valid, runtimeObservation:{...valid.runtimeObservation,status:"CREATING"}})).toThrow(/ready/i);
expect(() => buildTeamTasksProject({...valid, runtimeObservation:{...valid.runtimeObservation,imageUri:otherImage}})).toThrow(/image/i);
const result = buildTeamTasksProject(valid);
expect(result.repositories[0].credentialRef).toBe("github-charterarc-demo");
expect(result.setup[0].args).toContain("ee25daffed9f59e7c979477c6f0b5a05834c32e3");
expect(ProjectDefinitionSchema.safeParse(result).success).toBe(true);
```

Construct `valid` with synthetic pinned image metadata, correct account/region/runtime name and base. Add wrong account, region, runtime name, tag-only image, unknown extra metadata, and missing input cases. No real token/key is a fixture.

- [ ] Observe RED; implement the generator with fixed name `charterarc-team-tasks`, revision 1, live URL `https://3m38w35kz2.execute-api.us-east-1.amazonaws.com`, issuer `https://cognito-idp.us-east-1.amazonaws.com/us-east-1_o1RxnoU3F`, client/audience `3g88n9e4bj16k70rrrb026gn1d`, repository path `repo/team-tasks`, proposed baseline branch and exact expected SHA. Reconcile existing project revision before write; never overwrite an existing immutable revision.
- [ ] Setup command: executable `/opt/team-tasks/bin/app-env`, args `[/opt/team-tasks/bin/prepare-app.sh, ee25daffed9f59e7c979477c6f0b5a05834c32e3]`, cwd `repo/team-tasks`, timeout 900. Readiness: same wrapper with `make baseline`, timeout 900; include storage measurement and base assertion as separate checks. Instructions require remote application commands through the wrapper, allowed job scope, no trusted-evidence claims and no unapproved publication.
- [ ] Re-read branch/runtime immediately before registration and verify after workspace preparation. If base moves, fail; do not silently reset an existing workspace. No app setup command receives a secret, owner ID, token or runtime-admin credential.
- [ ] After authorized image upload/runtime creation and broker activation, generate the project with actual immutable image/runtime identifiers. Register through the existing authenticated admin CLI; prepare only the owner's dedicated workspace. Inspect READY preparation receipt, exact manifest/base/image and existing-project smoke result. Don't start coding if any check is missing.
- [ ] Run full tests, build, lint and fresh whole-branch review; fix Important findings with regression tests. Commit/push only the separate branch. Record local, image and live proof separately.

## Live delivery gates

| Gate | Owner/action | Required result |
|---|---|---|
| Broker activation | Codex prepares; owner executes reviewed change set | Old/new app routing works, no existing-resource replacement |
| New image/runtime | Codex prepares exact assets and narrow access proposal | New runtime only; READY and exact image matches |
| Project admission | Codex with owner's authenticated admin session | Private clone and readiness pass at pinned base |
| Coding handoff | AgentX issue #2 plus CharterArc adapter | Full immutable code returned and independently reconstructed |
| Follow-up demo | AgentX issue #1 | Correct saved conversation restored |
| Integrated demonstration | CharterArc | Exact candidate checks, evidence, explicit approval and approved publication |

## Approval boundary and postflight

Review this written plan before runtime code changes, as required by writing-plans.
Execution remains inline; no new task/session is needed. This plan does not grant
unrestricted deployment or merge permission. Successful image tests are not AWS
runtime evidence; successful workspace preparation is not a successful coding job.
Record objective digest before/after, exact commits/images, checks, retained logs,
cloud resource changes and remaining gates. Keep `Delivered` and `Validated` false
for this synthetic demo setup.
