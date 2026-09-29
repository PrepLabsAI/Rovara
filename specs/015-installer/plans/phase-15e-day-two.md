# Phase 15e: Day-Two Commands (`agentx upgrade`, `config`, `doctor`, `destroy`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An operator can run an installed AgentX environment without the authors:
- `agentx upgrade` moves it to a newer release, showing every change (IAM and data replacements called
  out) and stopping on a replaced table, user pool, bucket or secret unless confirmed by name;
- `agentx config list|get|set` changes models, limits, Slack behavior, alerts and the budget;
- `agentx doctor` checks every piece and says what is wrong and how to fix it;
- `agentx destroy` removes one named environment completely, in the right order, waiting properly;
- the install, day-2, teardown and move guides, and a release test workflow in a throwaway account.

It also fixes three things found live: `deploy --mode upgrade` resets the budget, the worker image
cannot run a Python repository's tests, and a failed first create (`ROLLBACK_COMPLETE`) has no
one-command way out.

**Architecture:**
- **One folder per command, under `packages/cli/src/`:** `config/`, `doctor/`, `upgrade/`, `destroy/`.
  Each has pure planning code (key tables, check logic, change review, delete order and name
  guards) separate from a thin AWS adapter, and a `cli.ts` that registers the command. Every AWS,
  vendor, clock, prompt and file dependency is injected, as in 15d1 and 15d2. No test reaches AWS,
  GitHub, Slack, Linear or Atlassian.
- **Upgrades keep what the operator set.** `deployEnvironment` gains `deployedParameters` and, in
  upgrade mode, carries each `OPERATOR_PARAMETERS` value (the budget, `SlackThreadTurnsPerMinute`,
  `SlowTurnMinutes`, and so on) from the deployed stack when the answers do not set it. This fixes
  `deploy --mode upgrade` resetting the budget, and makes every `config set` survive an upgrade.
- **`upgrade` builds its answers from the environment itself:** settings in SSM for models,
  identity and account; the deployed stacks' own parameters for the GitHub App, admin claim and
  operator principal. Nothing is asked again.
- **`doctor` reuses what init and sign-in already check** (`probeSlackUrls`, `parseAppSecret`,
  `checkDeveloperSignIn`, the prerequisite model and Elastic IP checks), under the operator role's
  existing permissions. No new operator permission is needed by any command in this phase.
- **`destroy` runs with admin credentials** (it deletes the access stack and its IAM roles). It
  records what the stacks retain in SSM before deleting them, guards every name it touches against
  the environment, and deletes settings and the lock last, so a re-run continues.

**Tech Stack:** TypeScript 5.9 strict (`exactOptionalPropertyTypes` on), Node 22.19 to 22.x, Zod 4,
Vitest, commander 15, AWS SDK v3 3.1134.0 (new in the CLI: `@aws-sdk/client-dynamodb` and
`@aws-sdk/client-kms`, already in the lockfile for the broker, and `@aws-sdk/client-cloudwatch-logs`,
new to the lockfile), `yaml` 2.9.1, Docker (Debian bookworm, uv 0.12.20), GitHub Actions.

**Spec:** [../spec.md](../spec.md). This phase implements:
- FR-042 to FR-044 (`agentx upgrade`), FR-026's `upgrade --export`;
- FR-048 and FR-049 (`agentx config`);
- FR-050 and FR-051 (`agentx doctor`), with spec 025 FR-046's rule that `doctor` runs
  `agentx signin check`'s checks, and the decision "FR-050, for phase 15e" (each connector's saved
  warning);
- FR-055 (`agentx destroy`), within the scope amendment at the top of the spec (EC2 workers, no
  capacity provider);
- FR-054 (the guides), SC-001 to SC-006 (the release test workflow and the manual check);
- the 15d2 plan's "Not in this phase" list: FR-014 and FR-015 reworded for EC2, and the legacy
  deployment's upgrade path (refused, see Decisions).

The phase map is in [README.md](README.md). Open product questions are in
[phase-15e-questions.md](phase-15e-questions.md); this plan is written to the recommendation for
each, and every task that depends on one says so.

**Depends on (all met at `dd61839`):**
- phase 15d2 merged (#148): the finishing steps, `connectors[].warning` in install progress, the
  budget in the control-plane stack, the operator-role additions (`servicequotas` for `L-1216C47A`
  and `L-0263D0A3`, `ec2:DescribeAddresses`);
- spec 025 phases 25a and 25b merged: `checkDeveloperSignIn` (R5: doctor calls it unchanged),
  `updateStackParameters` (R6), the workspace limits setting the broker reads (FR-053);
- specs 040 and 041 merged (`init --ui`, `agentx workspaces`); nothing here changes them.

**Branch:** `feat/015e-day-two`, cut from mainline `dd61839`. One PR, against `mainline`. Never stack
it on another feature branch.

## Decisions recorded by this plan

- **Named environments only.** `upgrade`, `config`, `doctor` and `destroy` refuse an environment
  with `naming: "legacy"` (the authors' adopted deployment), each with one sentence saying so. The
  legacy deployment keeps its own release pipeline (spec: "The maintainers' own
  `AgentXReleasePipeline` keeps deploying the authors' environment"). This closes the 15d2 plan's
  note about the legacy upgrade path: there is none to build.
- **Operator-set parameters survive upgrades** (`OPERATOR_PARAMETERS`, Task 1). An upgrade whose
  answers do not set one of them sends the deployed value. When the target release's template no
  longer declares a parameter, it is not sent (CloudFormation refuses an unknown parameter), and
  `upgrade` lists it before confirming, with its config key and "nothing replaces it" (the spec's
  edge case "A release that removes a `config` key").
- **Upgrade review is per stack, as each change set is ready.** A later stack's parameters depend
  on an earlier stack's new outputs, so all change sets cannot be computed first. FR-044 already
  accepts the consequence: stopping leaves earlier stacks upgraded, and a re-run continues. The
  templates engine shows the change set; the cdk engine shows `cdk diff` (FR-042), both through one
  review that lists IAM changes separately and stops on data replacement (FR-043).
- **The access stack under the operator role** (question 9). The operator role cannot change the
  access stack. Under it, `upgrade` compares the deployed access template with the release's; when
  they differ it stops before deploying anything and names `agentx upgrade --export` for the
  platform team. With admin credentials, `upgrade` deploys access first, as `agentx deploy` does.
- **Stack version for `doctor`.** A stack records no version. `doctor` compares each stack's
  package parameters (`<hashParameter>` equal to the package's `assetId`) and image digests with the
  release manifest of the version in settings (downloaded `release.json`, or the local release
  cache). The engine is read from the stack's parameters: only a cdk-deployed stack
  (`DefaultStackSynthesizer`) declares `BootstrapVersion`; the templates engine's stacks
  (`LegacyStackSynthesizer`) never do. Task 20 confirms both on a live stack.
- **Drift** (question 5). `doctor` reports each stack's last drift result from `DescribeStacks`
  (`DriftInformation.StackDriftStatus`). It does not start drift detection: detection reads every
  resource with the caller's own rights, which the least-privilege operator role does not have.
  A `DRIFTED` stack is a warning with the admin command to see the drift.
- **Connector checks** (item 2, question 10). For each connector in this environment's project files:
  the secret exists with the right shape; Linear and Jira get a real read with the stored
  credential; a vendor refusal is "expired or revoked". Asana is not refreshed by `doctor`, because a
  refresh rotates the token the control plane holds. Saved warnings (`connectors[].warning`) and the
  older `integrations.githubMcp` setting are warnings.
- **Bound channels.** The control plane has no route that lists bindings yet (spec 025 phase 25d
  adds admin reads), so `doctor` checks the bot's membership of the channel `init` bound, and says
  that channels bound later are not listed yet.
- **Elastic IPs** (item 5). `doctor` reports free EC2-VPC Elastic IPs (quota `L-0263D0A3` minus
  allocated addresses) with the same permissions `init` uses on a resume; fewer than two free is a
  warning (a second environment in this region would not fit), never a failure of this one.
- **`config` keys** (Task 3). The spec's keys plus `budget.monthlyUsd` and `budget.scope` (the 15d2
  plan put the budget in `config`). `limits.workspacesPerMember` and `limits.workspacesPerOrg` are
  listed and shown, but `set` refuses them until spec 025 phase 25e ships the admin change tool that
  writes the control-plane setting (question 4). `alerts.address` is an SSM value (settings'
  `alertAddress`), and a webhook address is a secret, read only from `--value-file`, `--value-env`
  or a hidden prompt (FR-020).
- **Changing `alerts.address`** (question 8) subscribes the new address. The operator role has no
  `sns:Unsubscribe` (15d2 kept it out on purpose, with a test that stays), so the old subscription
  stays until an admin removes it; `config set` prints the exact command.
- **`destroy` needs admin credentials** (question 7). It refuses the operator role up front: the
  operator role can neither delete the access stack nor the retained data, by design.
- **`destroy` confirms by typed name** (question 1). Every environment: type its name. `production`,
  or an environment with neither settings nor install answers (so AgentX has no record of creating
  it), also: type the AWS account id. No flag skips either. When stdin is not a terminal (the release
  test), the typed line is read from stdin (question 11).
- **`destroy` removes everything by default** (question 2), as FR-055 says; `--keep-data` keeps the
  tables (including the turn records and developer sign-in tables), buckets, secrets, user pool and
  KMS keys, and removes the rest.
- **What `destroy` removes, in order** (item 3, and docs/architecture-production.md "Tearing down an
  environment"):
  1. read everything first: the stacks, each stack's retained resources (from its template's
     `DeletionPolicy` and `ListStackResources`), the foundation's `Ec2WorkerLaunchTemplateId`, the
     GitHub and Slack app ids from install progress; save this inventory to
     `/agentx/<env>/destroy/inventory`, so a re-run after the stacks are gone still knows it;
  2. turn termination protection off and delete slack, runtime, control-plane, each waited for;
  3. terminate EC2 worker instances and delete workspace volumes tagged `DeploymentMode=ec2-ebs`,
     `Environment=<env>` and `agentx:env=<env>` (the third tag keeps the legacy deployment's
     workers, whose `Environment` is also `production`, out of reach);
  4. turn protection off and delete identity, foundation, access, each waited for;
  5. the retained resources: empty and delete buckets (every version and delete marker), delete
     tables, the flow-log group, the Cognito user pool (protection off first), schedule each KMS key
     for deletion in 7 days and delete its `alias/agentx/<env>/` aliases;
  6. force-delete every `agentx/<env>/` secret;
  7. delete every `/agentx/<env>/` parameter except the settings and the lock; then the settings;
     the lock is released last;
  8. remove `~/.agentx/environments/<env>.yaml`, the project files whose header names this
     environment and its launch template, and the stored admin token;
  9. print what it cannot do: delete the GitHub App and the Slack app, with their exact settings
     URLs.
- **Name guards.** Stack names must equal `agentx-<env>-<part>`; secrets must start `agentx/<env>/`;
  parameters `/agentx/<env>/`; aliases `alias/agentx/<env>/`; a retained resource must come from
  this environment's own stack inventory and carry the tag `agentx:env=<env>`; generated names
  (buckets, tables, log groups) must also start with `agentx-<env>-<part>-`. A resource that fails
  a guard is never touched and is listed as left in place.
- **Waiting.** A stack delete is polled every 15 seconds, with a progress line each minute (elapsed
  time and the latest stack event), for up to 3 hours, the templates engine's deploy limit. The
  control-plane delete is announced as "usually 20 to 40 minutes": its VPC Lambda functions release
  their network interfaces slowly (live, 2026-09-28). A stack in `ROLLBACK_COMPLETE` is deleted
  directly; `DELETE_FAILED` stops with the failing resources and their reasons.
- **`ROLLBACK_COMPLETE` in init.** The templates engine's refusal keeps the exact
  `delete-stack` command and adds `agentx --env <env> destroy --region <region>`.
- **Python in the worker image** (item 4). `python3`, `python3-pip` and `python3-venv` from Debian
  bookworm (the pinned base image), and uv 0.12.20 pinned by version and SHA-256 per architecture,
  in the `tools` stage like the Docker CLI. A project's devcontainer (#121) stays the route for any
  other toolchain. Installs get it only when a release publishes a new worker image; the release
  process owns that (docs/releases.md says so).
- **The release test workflow** (question 6) runs by hand in a throwaway account: install with each
  engine up to `developer-signin` (`init --stop-after`), `doctor`, upgrade from the previous
  release, `doctor`, a `config set` under the operator role, the export path under the operator
  role, and `destroy` for every environment it made. The admin sign-in, the first project, the
  Slack reply and `alerts test` need a person, so they stay in the manual release check
  (docs/releases.md), with the manual-guide teardown and SC-001.

## Spec conflicts found

Task 19 records each in the spec (a Decision or a reworded requirement):
- **FR-055 names the capacity provider** (keep, delete, warn). The scope amendment removed it. The
  warning becomes "deleting the worker volumes deletes every worker session's workspace".
- **FR-055 names two secrets**; the environment has more (`github-app`, `alert-endpoint`,
  `openrouter`, `developer-oidc`, `connectors/*`). `destroy` removes every `agentx/<env>/` secret.
- **FR-050's "the verified URLs".** No Slack API reports "Verified" without an app configuration
  token (15d1 decision); `doctor` runs the same signed self-probe `init` runs.
- **FR-050's "bot membership of bound channels".** No route lists bindings until spec 025 phase
  25d; `doctor` checks the channel `init` bound.
- **FR-044 lists runtime, control plane, Slack service.** The spec's own deploy-order decision
  upgrades access, foundation and identity first. `upgrade` follows the decision.
- **SC-005 says every day-2 command runs under the operator role.** `destroy` cannot, by design
  (question 7). `upgrade` can, except for an access-stack change (question 9).
- **FR-048's limit keys** depend on spec 025 phase 25e's writer (question 4).
- **FR-014 (`instances-ebs`) and FR-015 (AgentCore Runtime)** are superseded by the scope amendment;
  the 15d2 plan left their rewording to this phase.
- **The release tests' "live Slack reply" and "`alerts test`"** cannot run unattended against a
  throwaway environment: a pre-made Slack app's Request URL cannot follow each new environment's API
  address, and an email subscription must be confirmed by a person (question 6).
- **The manual teardown guide** filters workers on `Environment` and `DeploymentMode` only; in an
  account that also holds the legacy deployment, `Environment=production` matches its workers too.
  The guide adds `agentx:env=<env>`.

## Global Constraints

- **The live deployment does not change.** With no `agentxEnv`, templates are byte-identical
  (`tests/contract/legacy-templates.test.ts`). Legacy snapshots never change. Never run vitest with
  `-u`. No test, and no step of the live check, touches production's stacks, `/agentx/production/*`,
  production's GitHub App, Slack app or connector credentials.
- **Named environments only.** Every new command refuses `naming: "legacy"`.
- **No test reaches AWS, GitHub, Slack, Linear or Atlassian.** Every client is injected. The only
  real network use in tests is a loopback listener on `127.0.0.1`.
- **Never print secrets.** No secret value (the callback signing key, Slack bot token and signing
  secret, GitHub App private key, connector keys and refresh tokens, the alert webhook address, OIDC
  tokens) appears in output, logs, errors, local files, SSM or the upgrade bundle. Every task that
  reads one asserts its value appears in none of those. `doctor` reads secrets only to check their
  shape.
- **Secrets are never read from a flag's value** (FR-020): only a hidden prompt, `--<name>-file` or
  `--<name>-env`, read whole.
- **The operator role stays least-privilege.** No task adds an operator permission. Any later need
  for one needs a test in `tests/contract/access-policies.test.ts` and a line in the spec's
  Decisions. `tests/contract/day-two-permissions.test.ts` (Task 4) checks that every AWS action
  `config`, `doctor` and `upgrade` use is already allowed. Existing assertions stay, including
  `not.toContain("sns:Unsubscribe")`.
- **Don't weaken assertions (SC-008).** A test that fails because of this phase is fixed in the code,
  or, where the behavior was deliberately changed, its expectation is extended (for example a longer
  message still containing the old text), never loosened or deleted.
- **Exact names:**
  - stacks `agentx-<env>-<part>`; the inventory parameter `/agentx/<env>/destroy/inventory`;
  - the budget `agentx-<env>-monthly`, the alert topic `agentx-<env>-alerts`, the test alarm
    `agentx-<env>-TestAlarm`;
  - worker tags `DeploymentMode=ec2-ebs`, `Environment=<env>`, `agentx:env=<env>`;
  - uv `0.12.20`, arm64 SHA-256
    `8a7aad7bc76a2fae5151566ff3e43eacce0b2a113d5e4de3e4afe3e58fa2441e`, amd64 SHA-256
    `6590717592ace991ff83a63fef799e3ad9d33ecc8f96c5d6bdd732496e79337f` (checked against the
    downloads and the release's `.sha256` files on 2026-09-29).
- **Pinned dependencies:** exact versions, `3.1134.0` for every `@aws-sdk` client
  (`npm install --save-exact`).
- **Copy:** plain words; every error says what to do next; no em dashes anywhere, including AWS
  resource names, descriptions and user-facing text.
- **The gate:** `npm run typecheck && npm run lint && npm run build && npm test && npm run infra:synth`.
  - Use Node 22: `export PATH=/private/tmp/claude-501/node-v22.20.0-darwin-arm64/bin:$PATH`.
  - Known load flakes (issue #59): rerun that file alone.
- **Git:** never `git stash`; never push from a task; `docs/` is gitignored, so new and changed docs
  are added with `git add -f`.

## Review Focus

1. **An upgrade from a release whose template lacks a parameter the operator set, or a new
   template that dropped one.** Expected: the value is kept when the template still declares it;
   when it does not, it is not sent, and `upgrade` lists the config key before asking. Pinned in
   Tasks 1 and 12.
2. **`destroy` in an account holding a sibling environment whose name extends this one**
   (`prod` beside `prod-eu`, and `prod` beside `prod-foundation`), or the legacy deployment's
   workers tagged `Environment=production`. Expected: nothing of the sibling or the legacy
   deployment is listed, touched or deleted. Pinned in Tasks 14, 15 and 16.
3. **`destroy` re-run after a failure partway** (a bucket that could not be emptied, a stack in
   `DELETE_FAILED`, a closed terminal during the 30-minute control-plane delete). Expected: the
   re-run finds the inventory in SSM, skips what is gone, continues, and still deletes settings
   last. Pinned in Task 16.
4. **`doctor` with a secret whose value is malformed, or a vendor that echoes the key in an
   error.** Expected: a failed check that names the secret and the fix, with no part of the value in
   text or `--json` output. Pinned in Tasks 6 and 8.
5. **`config set` with a value that looks valid to the CLI but that the stack parameter refuses,
   or a model the account cannot use.** Expected: nothing changes (no change set executed, settings
   untouched), and the message says why. Pinned in Task 4.

---

## File map

| File | Responsibility | Task |
|---|---|---|
| `packages/cli/src/deploy/parameters.ts` (modify) | `OPERATOR_PARAMETERS` | 1 |
| `packages/cli/src/deploy/deploy-environment.ts` (modify) | keep operator parameters on upgrade; `templateParameterNames` | 1 |
| `packages/cli/src/deploy/deployer.ts`, `commands.ts` (modify) | the `kept` event; `cloudFormationParametersReader`; runDeploy wiring | 1 |
| `environments/base/Dockerfile` (modify) | Python, pip, venv, uv | 2 |
| `packages/cli/src/config/keys.ts` | the config key table: validation and routing | 3 |
| `packages/cli/src/deploy/parameter-update.ts` (modify) | `label: "config"` wording | 4 |
| `packages/cli/src/config/commands.ts`, `config/cli.ts` | `config list|get|set` | 4 |
| `packages/cli/src/day-two-actions.ts` | the AWS actions `config`, `doctor` and `upgrade` use | 4, 9, 12 |
| `packages/cli/src/doctor/checks.ts` | check types, formatting, JSON | 5 |
| `packages/cli/src/doctor/stacks.ts` | stack health, release, engine, drift | 5 |
| `packages/cli/src/doctor/secrets.ts`, `doctor/slack.ts`, `doctor/github.ts` | secrets, Slack, GitHub checks | 6 |
| `packages/cli/src/environments/project-files.ts` | this environment's project files | 7 |
| `packages/cli/src/doctor/connectors.ts` | connector checks | 7 |
| `packages/cli/src/doctor/account.ts`, `doctor/run.ts` | models, alerts, budget, capacity, sign-in; running every group | 8 |
| `packages/cli/src/doctor/aws.ts`, `doctor/cli.ts`, `init/release-fetch.ts` (modify) | real services, `release.json` reader, the command | 9 |
| `packages/cli/src/upgrade/answers.ts`, `upgrade/target.ts` | answers from the environment; target release, direction, notes | 10 |
| `packages/cli/src/upgrade/review.ts`, `deploy/cdk-engine.ts`, `deploy/commands.ts` (modify) | change review, replacement guard, `cdk diff` | 11 |
| `packages/cli/src/upgrade/run.ts`, `upgrade/cli.ts` | `agentx upgrade` | 12 |
| `packages/cli/src/upgrade/export.ts`, `deploy/export-bundle.ts` (modify) | `upgrade --export` | 13 |
| `packages/cli/src/destroy/names.ts`, `destroy/inventory.ts` | name guards, retained inventory, confirmation, vendor steps | 14 |
| `packages/cli/src/destroy/aws.ts` | the AWS adapter and its waits | 15 |
| `packages/cli/src/destroy/run.ts` | the ordered teardown | 16 |
| `packages/cli/src/destroy/cli.ts`, `deploy/templates-engine.ts` (modify) | `agentx destroy`; the `ROLLBACK_COMPLETE` message | 17 |
| `packages/cli/src/init/commands.ts`, `main.ts` (modify), `.github/workflows/release-test.yml` | `init --stop-after`; the release test | 18 |
| `docs/install.md`, `docs/day-two.md`, `docs/teardown.md`, `docs/move-account.md`, `docs/architecture-production.md`, `docs/releases.md`, `specs/015-installer/spec.md` | guides and decisions | 19 |
| `tests/support/doctor-fakes.ts`, `tests/support/destroy-fakes.ts` | fakes for the new services | 5 to 8, 14 to 17 |

---
### Task 1: Upgrades keep what the operator set (the budget reset)

`deploy --mode upgrade` with an answers file that has no `budget` sends no `BudgetMonthlyUsd`, so
CloudFormation uses the template default, `0`, and deletes the budget. The same happens to every
parameter `config set` changes. This task makes an upgrade carry them.

**Files:**
- Modify: `packages/cli/src/deploy/parameters.ts` (add `OPERATOR_PARAMETERS`)
- Modify: `packages/cli/src/deploy/deployer.ts` (the `kept` event)
- Modify: `packages/cli/src/deploy/deploy-environment.ts`
- Modify: `packages/cli/src/deploy/commands.ts` (`progressLine`, `cloudFormationParametersReader`, `DeployCliDependencies.stackParameters`, runDeploy)
- Test: `tests/contract/deploy-environment.test.ts`, `tests/contract/deploy-cli.test.ts`

**Interfaces:**
- Consumes: `deployEnvironment`, `stackParameters`, `LoadedRelease` (15c2).
- Produces:

```ts
// parameters.ts
export const OPERATOR_PARAMETERS: Readonly<Record<DeployPart, readonly string[]>>;
// deploy-environment.ts
export function templateParameterNames(release: LoadedRelease, part: DeployPart, env: string): ReadonlySet<string> | undefined;
export function keptOperatorParameters(input: { part: DeployPart; computed: Record<string, string>; deployed: Record<string, string> | undefined; declared: ReadonlySet<string> | undefined }): { kept: Record<string, string>; dropped: Array<{ parameter: string; value: string }> };
// DeployEnvironmentInput gains: deployedParameters?: (stackName: string) => Promise<Record<string, string> | undefined>;
// DeployEnvironmentResult gains: droppedParameters: Array<{ stackName: string; parameter: string; value: string }>;
// deployer.ts DeployEvent gains: { kind: "kept"; stackName: string; kept: string[]; dropped: string[] }
// commands.ts
export function cloudFormationParametersReader(client: CloudFormationClient): (stackName: string) => Promise<Record<string, string> | undefined>;
// DeployCliDependencies gains: stackParameters?: (stackName: string) => Promise<Record<string, string> | undefined>;
```

- [ ] **Step 1: Write the failing tests**

In `tests/contract/deploy-environment.test.ts`, add near the fakes:

```ts
/** A deployed environment that reports no parameters: nothing for an upgrade to keep. */
const nothingDeployed = async (): Promise<Record<string, string> | undefined> => undefined;
```

Then add `deployedParameters: nothingDeployed` to every existing `deployEnvironment({ mode: "upgrade", ... })`
call in this file (there are about eight). This adds an input the upgrade now requires; it changes no
expectation.

Add a new `describe` block:

```ts
describe("an upgrade keeps what the operator set (OPERATOR_PARAMETERS)", () => {
  const declared = ["BudgetMonthlyUsd", "BudgetScope", "SlackAppPostedMessages", "SlackThreadTurnsPerMinute", "SlackMemberWorkspaceLimit", "SlackOrganizationWorkspaceLimit"];

  async function installed(): Promise<{ store: MemoryParameterStore; secrets: ReturnType<typeof memorySecrets> }> {
    const store = new MemoryParameterStore();
    const secrets = memorySecrets();
    const install = fakeDeployer(scriptedOutputs());
    await deployEnvironment({ mode: "install", engine: "templates", answers: baseAnswers(), release: fakeRelease(), deployer: install.deployer, store, secrets, holder: HOLDER });
    return { store, secrets };
  }

  it("sends the deployed budget and thread limit when the answers set none", async () => {
    const { store, secrets } = await installed();
    const upgrade = fakeDeployer(scriptedOutputs());
    const events: unknown[] = [];
    await deployEnvironment({
      mode: "upgrade", engine: "templates", answers: baseAnswers(), release: fakeReleaseWithControlPlaneParameters(declared), deployer: upgrade.deployer, store, secrets, holder: HOLDER,
      deployedParameters: async (name) => (name === stackName("control-plane") ? { BudgetMonthlyUsd: "250", BudgetScope: "account", SlackThreadTurnsPerMinute: "12", GitHubAppId: "999" } : undefined),
      onEvent: (event) => events.push(event),
    });
    const controlPlane = upgrade.requests.find((request) => request.part === "control-plane")!;
    expect(controlPlane.parameters.BudgetMonthlyUsd).toBe("250");
    expect(controlPlane.parameters.BudgetScope).toBe("account");
    expect(controlPlane.parameters.SlackThreadTurnsPerMinute).toBe("12");
    // Only OPERATOR_PARAMETERS are carried: every other parameter still comes from the answers.
    expect(controlPlane.parameters.GitHubAppId).toBe("123");
    expect(events).toContainEqual({ kind: "kept", stackName: stackName("control-plane"), kept: ["BudgetMonthlyUsd", "BudgetScope", "SlackThreadTurnsPerMinute"], dropped: [] });
  });

  it("lets the answers' own budget win over the deployed one", async () => {
    const { store, secrets } = await installed();
    const upgrade = fakeDeployer(scriptedOutputs());
    await deployEnvironment({
      mode: "upgrade", engine: "templates", answers: { ...baseAnswers(), budget: { monthlyUsd: 40, scope: "tag" } }, release: fakeReleaseWithControlPlaneParameters(declared),
      deployer: upgrade.deployer, store, secrets, holder: HOLDER,
      deployedParameters: async () => ({ BudgetMonthlyUsd: "250", BudgetScope: "account" }),
    });
    const controlPlane = upgrade.requests.find((request) => request.part === "control-plane")!;
    expect(controlPlane.parameters.BudgetMonthlyUsd).toBe("40");
    expect(controlPlane.parameters.BudgetScope).toBe("tag");
  });

  it("does not send a parameter the new template no longer declares, and reports it as dropped", async () => {
    const { store, secrets } = await installed();
    const upgrade = fakeDeployer(scriptedOutputs());
    const result = await deployEnvironment({
      mode: "upgrade", engine: "templates", answers: baseAnswers(), release: fakeReleaseWithControlPlaneParameters(["BudgetMonthlyUsd"]),
      deployer: upgrade.deployer, store, secrets, holder: HOLDER,
      deployedParameters: async (name) => (name === stackName("control-plane") ? { BudgetMonthlyUsd: "250", SlackThreadTurnsPerMinute: "12" } : undefined),
    });
    const controlPlane = upgrade.requests.find((request) => request.part === "control-plane")!;
    expect(controlPlane.parameters).not.toHaveProperty("SlackThreadTurnsPerMinute");
    expect(result.droppedParameters).toEqual([{ stackName: stackName("control-plane"), parameter: "SlackThreadTurnsPerMinute", value: "12" }]);
  });

  it("refuses an upgrade that cannot read the deployed parameters, before deploying anything", async () => {
    const { store, secrets } = await installed();
    const upgrade = fakeDeployer(scriptedOutputs());
    await expect(deployEnvironment({ mode: "upgrade", engine: "templates", answers: baseAnswers(), release: fakeRelease(), deployer: upgrade.deployer, store, secrets, holder: HOLDER }))
      .rejects.toThrow("an upgrade must read the deployed stacks' parameters");
    expect(upgrade.requests.filter((request) => request.part === "control-plane")).toEqual([]);
  });

  it("never reads deployed parameters on an install", async () => {
    const store = new MemoryParameterStore();
    const reads: string[] = [];
    const install = fakeDeployer(scriptedOutputs());
    await deployEnvironment({
      mode: "install", engine: "templates", answers: baseAnswers(), release: fakeRelease(), deployer: install.deployer, store, secrets: memorySecrets(), holder: HOLDER,
      deployedParameters: async (name) => { reads.push(name); return { BudgetMonthlyUsd: "250" }; },
    });
    expect(reads).toEqual([]);
    expect(install.requests.find((request) => request.part === "control-plane")!.parameters).not.toHaveProperty("BudgetMonthlyUsd");
  });
});

describe("keptOperatorParameters", () => {
  it("keeps only listed parameters the answers did not set and the template declares", () => {
    expect(keptOperatorParameters({
      part: "slack", computed: { ModelId: "m" }, deployed: { SlowTurnMinutes: "9", ModelId: "old" }, declared: new Set(["SlowTurnMinutes", "ModelId"]),
    })).toEqual({ kept: { SlowTurnMinutes: "9" }, dropped: [] });
    expect(keptOperatorParameters({ part: "runtime", computed: {}, deployed: { ModelId: "old" }, declared: undefined })).toEqual({ kept: {}, dropped: [] });
  });
});
```

Import `keptOperatorParameters` from `deploy-environment.js`. The `upgrade` part order means the
refusal test's upgrade deploys `access`, `foundation`, `identity` and `runtime` before reaching
`control-plane`; the refusal is thrown before `control-plane` deploys, which is what the test pins.

In `tests/contract/deploy-cli.test.ts`, add:

```ts
import { runDeploy } from "../../packages/cli/src/deploy/commands.js";
import { writeEnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import { allStackOutputs } from "../support/init-fakes.js";

/** A release whose control-plane template declares the budget parameters, and "{}" for every other part. */
async function releaseDirDeclaringBudget(): Promise<string> {
  const dir = await tmp("agentx-deploy-cli-budget-");
  await mkdir(join(dir, "templates", REGION), { recursive: true });
  const templates = [];
  for (const part of ["access", "foundation", "identity", "control-plane", "runtime", "slack"]) {
    const body = part === "control-plane" ? JSON.stringify({ Parameters: { BudgetMonthlyUsd: {}, BudgetScope: {} } }) : "{}";
    const file = `templates/${REGION}/${part}.template.json`;
    await writeFile(join(dir, file), body);
    templates.push({ region: REGION, part, file, sha256: sha256(body) });
  }
  await writeFile(join(dir, "release.json"), JSON.stringify({ schemaVersion: 1, version: RELEASE_VERSION, gitCommit: "a".repeat(40), environmentPlaceholder: "qqenv-placeholderqq", templates, packages: [], images: {} }));
  return dir;
}

describe("agentx deploy --mode upgrade keeps the deployed budget", () => {
  it("reads the control-plane stack's parameters and sends its budget back", async () => {
    const store = new MemoryParameterStore();
    // Every part's outputs, including every foundation output the control plane takes.
    const outputs = allStackOutputs();
    const requests: DeployRequest[] = [];
    const deployer: StackDeployer = { async deploy(request) { requests.push(request); return outputs[request.stackName]!; }, async outputs(name) { return outputs[name]; } };
    await writeEnvironmentSettings(store, {
      schemaVersion: 1, env: ENV, account: ACCOUNT, region: REGION, engine: "templates", version: "1.2.2", naming: "environment",
      stacks: { access: stackName("access"), foundation: stackName("foundation"), identity: stackName("identity"), runtime: stackName("runtime"), "control-plane": stackName("control-plane"), slack: stackName("slack") },
      controlPlaneUrl: "https://abc123.execute-api.us-east-1.amazonaws.com", identity: { mode: "cognito", issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_abc", audience: "client123", clientId: "client123" },
      models: { orchestrator: "o", classifier: "c", worker: "w" }, updatedAt: "2026-09-29T00:00:00.000Z",
    });
    const answersDir = await tmp("agentx-deploy-cli-answers-");
    const answersFile = join(answersDir, "answers.json");
    await writeFile(answersFile, JSON.stringify({
      env: ENV, region: REGION, account: ACCOUNT, models: { orchestrator: "o", classifier: "c", worker: "w" }, identity: { mode: "cognito" },
      github: { appId: "123", privateKeySecretArn: `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:agentx/staging/github-app-AbCdEf` },
      images: { worker: `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/w@sha256:${"b".repeat(64)}`, slack: `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/s@sha256:${"c".repeat(64)}` },
    }));
    const reads: string[] = [];
    const signingKey = "k".repeat(43);
    await runDeploy(
      { mode: "upgrade", engine: "templates", releaseDir: await releaseDirDeclaringBudget(), answersFile, yes: true },
      {
        store, deployer,
        secrets: { get: async () => signingKey, create: async () => undefined },
        identity: { get: async () => ({ account: ACCOUNT, arn: `arn:aws:iam::${ACCOUNT}:user/alice` }) },
        stackParameters: async (name) => { reads.push(name); return name === stackName("control-plane") ? { BudgetMonthlyUsd: "250", BudgetScope: "tag" } : undefined; },
      },
      { stderr: { write: () => undefined } },
    );
    expect(reads).toContain(stackName("control-plane"));
    expect(requests.find((request) => request.part === "control-plane")!.parameters.BudgetMonthlyUsd).toBe("250");
  });
});
```

If `deploy-cli.test.ts` already imports any of these names, reuse its imports instead of adding
duplicates.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/contract/deploy-environment.test.ts tests/contract/deploy-cli.test.ts`
Expected: FAIL: `keptOperatorParameters` is not exported, `deployedParameters` is an unknown
property, the control-plane request has no `BudgetMonthlyUsd`.

- [ ] **Step 3: Implement**

In `packages/cli/src/deploy/parameters.ts`, after `SECRET_PARAMETERS`:

```ts
/**
 * Stack parameters an operator sets after install (the budget question, agentx config set) that an
 * upgrade's answers do not carry. An upgrade keeps each one's deployed value unless its answers set
 * it, so no upgrade resets them to the template default. Models are not here: they live in the
 * settings, which the upgrade's answers read.
 */
export const OPERATOR_PARAMETERS: Readonly<Record<DeployPart, readonly string[]>> = {
  access: [],
  foundation: [],
  identity: [],
  runtime: [],
  "control-plane": ["BudgetMonthlyUsd", "BudgetScope", "SlackAppPostedMessages", "SlackThreadTurnsPerMinute", "SlackMemberWorkspaceLimit", "SlackOrganizationWorkspaceLimit"],
  slack: ["SlowTurnMinutes"],
};
```

In `packages/cli/src/deploy/deployer.ts`, add to `DeployEvent`:

```ts
  | { kind: "kept"; stackName: string; kept: string[]; dropped: string[] }
```

In `packages/cli/src/deploy/commands.ts`, add to `progressLine`'s switch:

```ts
    case "kept":
      return `kept ${event.stackName}: ${event.kept.join(", ") || "nothing"}${event.dropped.length === 0 ? "" : `; not in this release, so not sent: ${event.dropped.join(", ")}`}`;
```

In `packages/cli/src/deploy/deploy-environment.ts`:
1. Rename `controlPlaneParameterNames(release, env)` to `export function templateParameterNames(release: LoadedRelease, part: DeployPart, env: string)`,
   reading `release.template(part, anyRegion, env)`, and in its error message replace
   `control-plane` with `${part}` (the control-plane message is unchanged word for word). Change its
   one caller to `templateParameterNames(release, "control-plane", env)`.
2. Add, after `withDeclaredSignIn`:

```ts
/**
 * Keeps what the operator set (OPERATOR_PARAMETERS) on an upgrade: each listed parameter the answers
 * did not set keeps its deployed value, when the release's template still declares it. One the
 * template no longer declares is reported as dropped and never sent: CloudFormation refuses an
 * unknown parameter. `declared` undefined means the release has no template to read (a cdk-only
 * release): every candidate is kept, and CloudFormation itself refuses one it does not know.
 */
export function keptOperatorParameters(input: {
  part: DeployPart; computed: Record<string, string>; deployed: Record<string, string> | undefined; declared: ReadonlySet<string> | undefined;
}): { kept: Record<string, string>; dropped: Array<{ parameter: string; value: string }> } {
  const kept: Record<string, string> = {};
  const dropped: Array<{ parameter: string; value: string }> = [];
  for (const name of OPERATOR_PARAMETERS[input.part]) {
    if (Object.hasOwn(input.computed, name)) continue;
    const value = input.deployed?.[name];
    if (value === undefined) continue;
    if (input.declared !== undefined && !input.declared.has(name)) {
      dropped.push({ parameter: name, value });
      continue;
    }
    kept[name] = value;
  }
  return { kept, dropped };
}
```

3. Add to `DeployEnvironmentInput`:

```ts
  /** An upgrade reads each deployed stack's parameters here, to keep OPERATOR_PARAMETERS (Task 1 of
   * phase 15e). Required for an upgrade that deploys a part with operator parameters. */
  deployedParameters?: (stackName: string) => Promise<Record<string, string> | undefined>;
```

   and to `DeployEnvironmentResult`: `droppedParameters: Array<{ stackName: string; parameter: string; value: string }>;`.
4. In `work`, declare `const droppedParameters: DeployEnvironmentResult["droppedParameters"] = [];`
   before the deploy loop, and in the loop replace the `const parameters = ...` line with:

```ts
      let parameters = part === "control-plane" && developerSignIn !== undefined
        ? withDeclaredSignIn(rawParameters, templateParameterNames(release, "control-plane", env))
        : rawParameters;
      if (mode === "upgrade" && OPERATOR_PARAMETERS[part].length > 0) {
        if (input.deployedParameters === undefined) {
          throw agentXError("CONFIG_INVALID", "an upgrade must read the deployed stacks' parameters to keep what the operator set; this is an AgentX bug, so report it");
        }
        const deployed = await input.deployedParameters(stackName);
        // The template is read only when there is something to keep: most upgrades read none.
        const candidates = OPERATOR_PARAMETERS[part].filter((name) => deployed?.[name] !== undefined && !Object.hasOwn(parameters, name));
        const declared = candidates.length === 0 ? undefined : templateParameterNames(release, part, env);
        const { kept, dropped } = keptOperatorParameters({ part, computed: parameters, deployed, declared });
        parameters = { ...kept, ...parameters };
        droppedParameters.push(...dropped.map((entry) => ({ stackName, ...entry })));
        if (candidates.length > 0) input.onEvent?.({ kind: "kept", stackName, kept: Object.keys(kept), dropped: dropped.map((entry) => entry.parameter) });
      }
```

5. Return `droppedParameters` in both `return { outputs, settingsWritten: ... }` statements of `work`.
   Import `OPERATOR_PARAMETERS` from `./parameters.js`.

In `packages/cli/src/deploy/commands.ts`, next to `cloudFormationOutputsReader`:

```ts
/** A stack's current parameter values (NoEcho ones read back as "****" and are never used here: none
 * is in OPERATOR_PARAMETERS), or undefined when the stack does not exist. */
export function cloudFormationParametersReader(client: CloudFormationClient): (stackName: string) => Promise<Record<string, string> | undefined> {
  return async (stackName) => {
    let stack;
    try {
      stack = (await client.send(new DescribeStacksCommand({ StackName: stackName }))).Stacks?.[0];
    } catch (error) {
      if (isStackAbsentError(error)) return undefined;
      throw error;
    }
    if (stack === undefined) return undefined;
    return Object.fromEntries((stack.Parameters ?? []).flatMap((parameter) => (parameter.ParameterKey === undefined || parameter.ParameterValue === undefined ? [] : [[parameter.ParameterKey, parameter.ParameterValue]])));
  };
}
```

Add `stackParameters?: (stackName: string) => Promise<Record<string, string> | undefined>;` to
`DeployCliDependencies` (doc comment: "The deployed stacks' parameters an upgrade keeps (DescribeStacks
by default)."), and in `deployCommand`'s `deployEnvironment({...})` call add:

```ts
      deployedParameters: deps.stackParameters ?? cloudFormationParametersReader(new CloudFormationClient({ region: answers.region })),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/contract/deploy-environment.test.ts tests/contract/deploy-cli.test.ts tests/contract/init-deploy-steps.test.ts tests/contract/deploy-commands.test.ts`
Expected: PASS. Then `npm run typecheck`: if a test or source file compares a whole
`DeployEnvironmentResult`, add `droppedParameters: []` to its expected value.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/deploy/parameters.ts packages/cli/src/deploy/deployer.ts packages/cli/src/deploy/deploy-environment.ts packages/cli/src/deploy/commands.ts tests/contract/deploy-environment.test.ts tests/contract/deploy-cli.test.ts
git commit -m "fix(deploy): an upgrade keeps the budget and every parameter the operator set"
```

### Task 2: Python and uv in the worker image

A live check found AgentX could not run a Python repository's tests: the worker image has only
Node. Python 3, pip and venv come from Debian bookworm (the base image is pinned by digest); uv is
pinned by version and checksum, in the same `tools` stage as the Docker CLI.

**Files:**
- Modify: `environments/base/Dockerfile`
- Create: `tests/contract/worker-image.test.ts`
- Modify: `docs/releases.md` (one paragraph; `git add -f`)

**Interfaces:**
- Consumes: nothing.
- Produces: the worker image carries `python3`, `pip`, `python3 -m venv`, `/usr/local/bin/uv` and
  `/usr/local/bin/uvx`.

- [ ] **Step 1: Write the failing test**

Create `tests/contract/worker-image.test.ts`:

```ts
// Facts about the EC2 worker image, read from its Dockerfile (the image itself is built only by the
// release workflow): what a repository's setup and test commands can count on.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dockerfile = readFileSync("environments/base/Dockerfile", "utf8");
/** The final stage: everything after the last FROM line. */
const finalStage = dockerfile.slice(dockerfile.lastIndexOf("\nFROM "));
const toolsStage = dockerfile.slice(dockerfile.indexOf(" AS tools"), dockerfile.lastIndexOf("\nFROM "));

describe("the worker image", () => {
  it("installs Python 3, pip and venv from Debian in the final stage", () => {
    const install = /apt-get install --yes --no-install-recommends ([^\n\\]+)/.exec(finalStage)?.[1] ?? "";
    for (const pkg of ["python3", "python3-pip", "python3-venv", "git", "openssh-client", "ca-certificates"]) {
      expect(install.split(/\s+/), pkg).toContain(pkg);
    }
  });

  it("pins uv by version and by SHA-256 for each architecture, and verifies the download", () => {
    expect(toolsStage).toContain("ARG UV_VERSION=0.12.20");
    expect(toolsStage).toContain("uv_sha=8a7aad7bc76a2fae5151566ff3e43eacce0b2a113d5e4de3e4afe3e58fa2441e");
    expect(toolsStage).toContain("uv_sha=6590717592ace991ff83a63fef799e3ad9d33ecc8f96c5d6bdd732496e79337f");
    expect(toolsStage).toContain('https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-$uv_arch-unknown-linux-gnu.tar.gz');
    expect(toolsStage).toMatch(/echo "\$uv_sha {2}\/tmp\/uv\.tgz" \| sha256sum -c -/);
  });

  it("copies uv and uvx into the final stage", () => {
    expect(finalStage).toContain("COPY --from=tools /usr/local/bin/uv /usr/local/bin/uv");
    expect(finalStage).toContain("COPY --from=tools /usr/local/bin/uvx /usr/local/bin/uvx");
  });

  it("still pins the Docker CLI and Compose by checksum (characterization)", () => {
    expect(toolsStage).toMatch(/echo "\$docker_sha {2}\/tmp\/docker\.tgz" \| sha256sum -c -/);
    expect(toolsStage).toMatch(/echo "\$compose_sha {2}\/tmp\/docker-compose" \| sha256sum -c -/);
  });

  it("runs as the node user", () => {
    expect(finalStage).toMatch(/\nUSER node\n/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/contract/worker-image.test.ts`
Expected: FAIL on the Python and uv tests; the Docker CLI and `USER node` tests pass.

- [ ] **Step 3: Implement**

In `environments/base/Dockerfile`, in the `tools` stage, after `ARG COMPOSE_VERSION=v5.5.1` add
`ARG UV_VERSION=0.12.20`, and after the Docker `RUN` add:

```dockerfile
# uv, which runs a Python repository's setup and tests. Pinned by the release's published SHA-256,
# checked against the downloads (2026-09-29).
RUN set -eu; \
    case "$TARGETARCH" in \
      arm64) uv_arch=aarch64; uv_sha=8a7aad7bc76a2fae5151566ff3e43eacce0b2a113d5e4de3e4afe3e58fa2441e ;; \
      amd64) uv_arch=x86_64; uv_sha=6590717592ace991ff83a63fef799e3ad9d33ecc8f96c5d6bdd732496e79337f ;; \
      *) echo "unsupported architecture $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/uv.tgz "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-$uv_arch-unknown-linux-gnu.tar.gz"; \
    echo "$uv_sha  /tmp/uv.tgz" | sha256sum -c -; \
    tar -xzf /tmp/uv.tgz -C /tmp; \
    install -m 0755 "/tmp/uv-$uv_arch-unknown-linux-gnu/uv" /usr/local/bin/uv; \
    install -m 0755 "/tmp/uv-$uv_arch-unknown-linux-gnu/uvx" /usr/local/bin/uvx
```

In the final stage, change the `apt-get install` line to:

```dockerfile
    && apt-get install --yes --no-install-recommends ca-certificates git openssh-client python3 python3-pip python3-venv \
```

and after the two Docker `COPY --from=tools` lines add:

```dockerfile
COPY --from=tools /usr/local/bin/uv /usr/local/bin/uv
COPY --from=tools /usr/local/bin/uvx /usr/local/bin/uvx
```

Add a comment above the final stage's `RUN apt-get`: `# Python 3, pip and venv (Debian bookworm) so a
Python repository's tests run; a project's devcontainer (#121) is the route for anything else.`

In `docs/releases.md`, under "What a release contains", after the images bullet, add: "The worker
image carries Node 22, Git, the Docker CLI and Compose, Python 3 with pip and venv, and uv. A change
to `environments/base/Dockerfile` reaches installs only through a new release's worker image: tag a
release, and upgrade each environment with `agentx upgrade`."

- [ ] **Step 4: Run the tests and build the image locally**

Run: `npx vitest run tests/contract/worker-image.test.ts tests/contract/workspace-packages.test.ts tests/contract/release-command.test.ts`
Expected: PASS.

If Docker is available, also run:
`docker buildx build --platform linux/arm64 --file environments/base/Dockerfile --load --tag agentx-worker:15e . && docker run --rm --entrypoint sh agentx-worker:15e -c 'python3 --version && python3 -m venv /tmp/v && /tmp/v/bin/pip --version && uv --version'`
Expected: `Python 3.11.x`, a pip version, `uv 0.12.20`. Record the output in the PR. If Docker is not
available, say so in the PR; the release workflow builds the image.

- [ ] **Step 5: Commit**

```bash
git add environments/base/Dockerfile tests/contract/worker-image.test.ts
git add -f docs/releases.md
git commit -m "feat(worker): Python 3, pip, venv and pinned uv in the worker image"
```

### Task 3: The config key table (validation and routing)

The spec's Testing section asks for "validation and routing of every `config` key". This task is
the pure table: which keys exist, what each accepts, and the one place each maps to.

Depends on question 4 (the limit keys are listed but `set` refuses them until spec 025 phase 25e).

**Files:**
- Create: `packages/cli/src/config/keys.ts`
- Test: `tests/contract/config-keys.test.ts`

**Interfaces:**
- Consumes: `OPERATOR_PARAMETERS` (Task 1), `AlertEmailSchema` (answer-schemas.ts).
- Produces:

```ts
export type ModelRole = "orchestrator" | "classifier" | "worker";
export type ConfigTarget =
  | { kind: "stack-parameter"; part: DeployPart; parameter: string }
  | { kind: "settings"; field: "alertAddress" }
  | { kind: "control-plane-setting"; field: "perPerson" | "perOrganization"; installDefault: { part: DeployPart; parameter: string } };
export interface ConfigKey { key: string; description: string; target: ConfigTarget; defaultValue?: string; model?: ModelRole; parse(value: string): string }
export const CONFIG_KEYS: readonly ConfigKey[];
export function configKey(name: string): ConfigKey;   // throws CONFIG_INVALID for an unknown key
export function whereText(target: ConfigTarget, env: string): string;
```

- [ ] **Step 1: Write the failing test**

Create `tests/contract/config-keys.test.ts`:

```ts
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONFIG_KEYS, configKey, whereText } from "../../packages/cli/src/config/keys.js";
import { OPERATOR_PARAMETERS } from "../../packages/cli/src/deploy/parameters.js";

const infraSource = readdirSync("infra/lib").filter((file) => file.endsWith(".ts")).map((file) => readFileSync(`infra/lib/${file}`, "utf8")).join("\n");
const declaredInInfra = (parameter: string) => new RegExp(`CfnParameter\\((this|stack|scope), "${parameter}"`).test(infraSource);

describe("config keys (FR-048)", () => {
  it("has every key the spec names, plus the budget", () => {
    expect(CONFIG_KEYS.map((entry) => entry.key)).toEqual([
      "models.orchestrator", "models.classifier", "models.worker",
      "limits.workspacesPerMember", "limits.workspacesPerOrg", "limits.threadTurnsPerMinute",
      "slack.appPostedMessages", "alerts.address", "alerts.slowTurnMinutes",
      "budget.monthlyUsd", "budget.scope",
    ]);
  });

  it("maps each key to exactly one place, and no two keys to the same place", () => {
    const places = CONFIG_KEYS.map((entry) => JSON.stringify(entry.target));
    expect(new Set(places).size).toBe(places.length);
  });

  it("routes limits.threadTurnsPerMinute to SlackThreadTurnsPerMinute, as the spec says", () => {
    expect(configKey("limits.threadTurnsPerMinute").target).toEqual({ kind: "stack-parameter", part: "control-plane", parameter: "SlackThreadTurnsPerMinute" });
  });

  it("routes the workspace limits to the control plane's setting, with the stack parameters as install-time defaults (spec 025 FR-053)", () => {
    expect(configKey("limits.workspacesPerMember").target).toEqual({ kind: "control-plane-setting", field: "perPerson", installDefault: { part: "control-plane", parameter: "SlackMemberWorkspaceLimit" } });
    expect(configKey("limits.workspacesPerOrg").target).toEqual({ kind: "control-plane-setting", field: "perOrganization", installDefault: { part: "control-plane", parameter: "SlackOrganizationWorkspaceLimit" } });
  });

  it("names only stack parameters the infrastructure declares", () => {
    for (const entry of CONFIG_KEYS) {
      if (entry.target.kind === "stack-parameter") expect(declaredInInfra(entry.target.parameter), entry.key).toBe(true);
      if (entry.target.kind === "control-plane-setting") expect(declaredInInfra(entry.target.installDefault.parameter), entry.key).toBe(true);
    }
  });

  it("keeps every non-model stack-parameter key across upgrades (OPERATOR_PARAMETERS)", () => {
    for (const entry of CONFIG_KEYS) {
      if (entry.target.kind !== "stack-parameter" || entry.model !== undefined) continue;
      expect(OPERATOR_PARAMETERS[entry.target.part], entry.key).toContain(entry.target.parameter);
    }
  });

  it.each([
    ["limits.threadTurnsPerMinute", "12", "12"], ["limits.threadTurnsPerMinute", " 07 ", "7"],
    ["alerts.slowTurnMinutes", "60", "60"], ["budget.monthlyUsd", "0", "0"], ["budget.monthlyUsd", "1500", "1500"],
    ["budget.scope", "account", "account"], ["slack.appPostedMessages", "ignore", "ignore"],
    ["models.orchestrator", "us.anthropic.claude-sonnet-4-6", "us.anthropic.claude-sonnet-4-6"],
    ["alerts.address", "ops@example.com", "ops@example.com"], ["limits.workspacesPerMember", "5", "5"],
  ])("accepts %s = %j", (key, value, stored) => {
    expect(configKey(key).parse(value)).toBe(stored);
  });

  it.each([
    ["limits.threadTurnsPerMinute", "0", "a whole number from 1 to 60"], ["limits.threadTurnsPerMinute", "6.5", "a whole number from 1 to 60"],
    ["alerts.slowTurnMinutes", "61", "a whole number from 1 to 60"], ["budget.monthlyUsd", "-1", "a whole number from 0 to 9999999"],
    ["budget.monthlyUsd", "10000000", "a whole number from 0 to 9999999"], ["budget.scope", "org", "one of tag, account"],
    ["slack.appPostedMessages", "yes", "one of accept, ignore"], ["models.worker", "", "a model id"], ["models.worker", "bad model", "a model id"],
    ["alerts.address", "not-an-address", "an email address"], ["limits.workspacesPerOrg", "1001", "a whole number from 1 to 1000"],
  ])("refuses %s = %j, saying what is allowed", (key, value, allowed) => {
    expect(() => configKey(key).parse(value)).toThrow(`${key} must be ${allowed}; nothing changed`);
  });

  it("refuses an unknown key and points at config list", () => {
    expect(() => configKey("models.checker")).toThrow("unknown config key models.checker; agentx config list shows every key");
  });

  it("says where each key lives", () => {
    expect(whereText(configKey("alerts.slowTurnMinutes").target, "staging")).toBe("stack parameter SlowTurnMinutes on agentx-staging-slack");
    expect(whereText(configKey("alerts.address").target, "staging")).toBe("SSM /agentx/staging/settings (alertAddress)");
    expect(whereText(configKey("limits.workspacesPerOrg").target, "staging")).toBe("control-plane setting WORKSPACE_LIMITS.perOrganization (install-time default SlackOrganizationWorkspaceLimit)");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/contract/config-keys.test.ts`
Expected: FAIL: `config/keys.js` does not exist.

- [ ] **Step 3: Implement**

Create `packages/cli/src/config/keys.ts`:

```ts
// FR-048: agentx config's fixed, documented keys. Each maps to exactly one place: a stack parameter,
// an SSM value (the environment settings) or a control-plane setting. docs/day-two.md lists the
// same table.
import { agentXError, environmentSettingsPrefix, environmentStackName } from "@agentx/contracts";
import { AlertEmailSchema } from "../deploy/answer-schemas.js";
import type { DeployPart } from "../deploy/parameters.js";

export type ModelRole = "orchestrator" | "classifier" | "worker";

export type ConfigTarget =
  | { kind: "stack-parameter"; part: DeployPart; parameter: string }
  | { kind: "settings"; field: "alertAddress" }
  | { kind: "control-plane-setting"; field: "perPerson" | "perOrganization"; installDefault: { part: DeployPart; parameter: string } };

export interface ConfigKey {
  key: string;
  description: string;
  target: ConfigTarget;
  /** The template's default, shown when the stack reports no value. */
  defaultValue?: string;
  /** Model keys pass a one-token test call before anything changes (FR-049). */
  model?: ModelRole;
  /** The value to store, or CONFIG_INVALID saying what is allowed. */
  parse(value: string): string;
}

const refuse = (key: string, allowed: string): never => {
  throw agentXError("CONFIG_INVALID", `${key} must be ${allowed}; nothing changed`);
};

const wholeNumber = (key: string, min: number, max: number) => (value: string): string => {
  const trimmed = value.trim();
  if (!/^[0-9]{1,8}$/.test(trimmed) || Number(trimmed) < min || Number(trimmed) > max) return refuse(key, `a whole number from ${min} to ${max}`);
  return String(Number(trimmed));
};

const oneOf = (key: string, values: readonly string[]) => (value: string): string =>
  (values.includes(value.trim()) ? value.trim() : refuse(key, `one of ${values.join(", ")}`));

// A Bedrock model or inference-profile id, or an OpenRouter slug: no spaces, at most 200 characters.
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const modelId = (key: string) => (value: string): string => (MODEL_ID.test(value.trim()) ? value.trim() : refuse(key, "a model id"));

const email = (key: string) => (value: string): string => (AlertEmailSchema.safeParse(value.trim()).success ? value.trim() : refuse(key, "an email address"));

const parameter = (part: DeployPart, name: string): ConfigTarget => ({ kind: "stack-parameter", part, parameter: name });

export const CONFIG_KEYS: readonly ConfigKey[] = [
  { key: "models.orchestrator", description: "the model the Slack orchestrator uses", target: parameter("slack", "ModelId"), model: "orchestrator", parse: modelId("models.orchestrator") },
  { key: "models.classifier", description: "the model the gate classifier uses", target: parameter("slack", "GateClassifierModelId"), model: "classifier", parse: modelId("models.classifier") },
  { key: "models.worker", description: "the model the coding worker uses", target: parameter("runtime", "ModelId"), model: "worker", parse: modelId("models.worker") },
  {
    key: "limits.workspacesPerMember", description: "the most workspaces one person may have open",
    target: { kind: "control-plane-setting", field: "perPerson", installDefault: { part: "control-plane", parameter: "SlackMemberWorkspaceLimit" } },
    defaultValue: "3", parse: wholeNumber("limits.workspacesPerMember", 1, 50),
  },
  {
    key: "limits.workspacesPerOrg", description: "the most workspaces the whole organization may have open",
    target: { kind: "control-plane-setting", field: "perOrganization", installDefault: { part: "control-plane", parameter: "SlackOrganizationWorkspaceLimit" } },
    defaultValue: "20", parse: wholeNumber("limits.workspacesPerOrg", 1, 1000),
  },
  { key: "limits.threadTurnsPerMinute", description: "the most requests one Slack thread may start in a minute", target: parameter("control-plane", "SlackThreadTurnsPerMinute"), defaultValue: "6", parse: wholeNumber("limits.threadTurnsPerMinute", 1, 60) },
  { key: "slack.appPostedMessages", description: "accept: answer mentions a person posts through another app; ignore: only typed mentions", target: parameter("control-plane", "SlackAppPostedMessages"), defaultValue: "accept", parse: oneOf("slack.appPostedMessages", ["accept", "ignore"]) },
  { key: "alerts.address", description: "where alarms go: an email address, or a PagerDuty or Opsgenie address (kept secret)", target: { kind: "settings", field: "alertAddress" }, parse: email("alerts.address") },
  { key: "alerts.slowTurnMinutes", description: "a turn slower than this many minutes raises the SlowTurns alarm", target: parameter("slack", "SlowTurnMinutes"), defaultValue: "5", parse: wholeNumber("alerts.slowTurnMinutes", 1, 60) },
  { key: "budget.monthlyUsd", description: "the monthly AWS budget in whole US dollars; 0 for none", target: parameter("control-plane", "BudgetMonthlyUsd"), defaultValue: "0", parse: wholeNumber("budget.monthlyUsd", 0, 9_999_999) },
  { key: "budget.scope", description: "tag: costs tagged agentx:env for this environment; account: the whole account", target: parameter("control-plane", "BudgetScope"), defaultValue: "tag", parse: oneOf("budget.scope", ["tag", "account"]) },
];

export function configKey(name: string): ConfigKey {
  const found = CONFIG_KEYS.find((entry) => entry.key === name);
  if (found === undefined) throw agentXError("CONFIG_INVALID", `unknown config key ${name}; agentx config list shows every key`);
  return found;
}

export function whereText(target: ConfigTarget, env: string): string {
  switch (target.kind) {
    case "stack-parameter":
      return `stack parameter ${target.parameter} on ${environmentStackName(env, target.part)}`;
    case "settings":
      return `SSM ${environmentSettingsPrefix(env)}settings (${target.field})`;
    case "control-plane-setting":
      return `control-plane setting WORKSPACE_LIMITS.${target.field} (install-time default ${target.installDefault.parameter})`;
  }
}
```

The template's `BudgetMonthlyUsd` pattern allows up to seven digits (`^(0|[1-9][0-9]{0,6})$`), so the
maximum is 9,999,999. `BudgetAnswersSchema` (init) allows at most 1,000,000; `config` follows the
template, which is what the stack accepts.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/contract/config-keys.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/config/keys.ts tests/contract/config-keys.test.ts
git commit -m "feat(config): the config key table with validation and routing (FR-048)"
```

### Task 4: `agentx config list|get|set`

**Files:**
- Modify: `packages/cli/src/deploy/parameter-update.ts` (`label`)
- Create: `packages/cli/src/config/commands.ts`, `packages/cli/src/config/cli.ts`
- Create: `packages/cli/src/day-two-actions.ts`
- Modify: `packages/cli/src/main.ts` (`CliDependencies.config`, register)
- Test: `tests/contract/config-commands.test.ts`, `tests/contract/day-two-permissions.test.ts`, `tests/contract/signin-commands.test.ts` (unchanged; run it)

Depends on questions 4 (the limit keys) and 8 (the old alert subscription stays).

**Interfaces:**
- Consumes: `configKey`, `CONFIG_KEYS`, `whereText` (Task 3); `updateStackParameters` (spec 025 R6);
  `withEnvironmentLock`; `readEnvironmentSettings`, `writeEnvironmentSettings`;
  `readInstallAnswers`, `writeInstallAnswers`; `ensureSubscribed`, `alertsTopicArn`, `AlertsApi`
  (15d2); `checkAlertWebhook`, `webhookDisplay`, `storeAlertWebhook` (init/answers.ts);
  `secretFromSource`; `modelCheckProblem`, `PrerequisiteChecks`; `StackReader` (adopt.ts).
- Produces:

```ts
// parameter-update.ts: ParameterUpdateInput gains  label?: "sign-in" | "config"   (default "sign-in")
// config/commands.ts
export interface ConfigServices {
  store: ParameterStore; secrets: InitSecrets; cloudFormation: { send(command: unknown): Promise<unknown> };
  stacks: StackReader; identity: CallerIdentity; checks: Pick<PrerequisiteChecks, "converse" | "openRouter">;
  alerts: AlertsApi; prompter: Prompter; processEnv: NodeJS.ProcessEnv;
  write: (line: string) => void; now: () => number; sleep: (ms: number) => Promise<void>; pollMs?: number;
}
export interface ConfigRow { key: string; value: string; where: string; description: string }
export function runConfigList(services: ConfigServices, env: string): Promise<ConfigRow[]>;
export function runConfigGet(services: ConfigServices, env: string, key: string): Promise<ConfigRow>;
export function runConfigSet(services: ConfigServices, env: string, input: { key: string; value?: string; valueSource?: SecretSource; yes: boolean }): Promise<{ changed: boolean }>;
// day-two-actions.ts
export const CONFIG_AWS_ACTIONS: readonly string[];
```

- [ ] **Step 1: Write the failing tests**

Create `tests/contract/config-commands.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { runConfigGet, runConfigList, runConfigSet, type ConfigServices } from "../../packages/cli/src/config/commands.js";
import { lockParameterName } from "../../packages/cli/src/environments/lock.js";
import { readEnvironmentSettings, writeEnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import type { StackDescription } from "../../packages/cli/src/environments/adopt.js";
import { fakeCloudFormation } from "../support/fake-cloudformation.js";
import { memoryInitSecrets, passingChecks, scriptedPrompter, T0 } from "../support/init-fakes.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";
import { fakeAlerts, STAGING_SETTINGS } from "../support/setup-fakes.js";

const ENV = "staging";
const ROLE = "arn:aws:iam::123456789012:role/agentx-staging-cloudformation";
const WEBHOOK = "https://events.pagerduty.com/integration/SECRETkey0123456789/enqueue";

async function seeded(): Promise<MemoryParameterStore> {
  const store = new MemoryParameterStore();
  await writeEnvironmentSettings(store, {
    ...STAGING_SETTINGS,
    access: { artifactBucket: "b", cloudFormationRoleArn: ROLE, operatorRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-operator", pullThroughPrefix: "agentx-staging" },
  });
  return store;
}

function stacks(parameters: Record<string, Record<string, string>>): ConfigServices["stacks"] {
  return {
    async describe(name): Promise<StackDescription | undefined> {
      const values = parameters[name];
      return values === undefined ? undefined : { status: "UPDATE_COMPLETE", outputs: { OperatorAlertsTopicArn: "arn:aws:sns:us-east-1:123456789012:agentx-staging-alerts" }, parameters: values };
    },
  };
}

function services(overrides: Partial<ConfigServices> & { store: MemoryParameterStore }): ConfigServices & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    secrets: memoryInitSecrets(),
    cloudFormation: fakeCloudFormation({ parameters: { SlackThreadTurnsPerMinute: "6", BudgetMonthlyUsd: "100", ModelId: "amazon.nova-pro-v1:0" } }),
    stacks: stacks({ "agentx-staging-control-plane": { SlackThreadTurnsPerMinute: "6", BudgetMonthlyUsd: "100", BudgetScope: "tag", SlackAppPostedMessages: "accept", SlackMemberWorkspaceLimit: "3", SlackOrganizationWorkspaceLimit: "20" }, "agentx-staging-slack": { ModelId: "us.anthropic.claude-sonnet-4-6", GateClassifierModelId: "amazon.nova-lite-v1:0", SlowTurnMinutes: "5" }, "agentx-staging-runtime": { ModelId: "amazon.nova-pro-v1:0" } }),
    identity: { get: async () => ({ account: "123456789012", arn: "arn:aws:sts::123456789012:assumed-role/agentx-staging-operator/alice" }) },
    checks: passingChecks(),
    alerts: fakeAlerts({ confirmAfterPolls: 0 }),
    prompter: scriptedPrompter([]),
    processEnv: {},
    write: (line) => lines.push(line),
    now: () => T0,
    sleep: async () => undefined,
    pollMs: 0,
    ...overrides,
  };
}

describe("agentx config list and get", () => {
  it("lists every key with its value and where it lives", async () => {
    const rows = await runConfigList(services({ store: await seeded() }), ENV);
    expect(rows.find((row) => row.key === "limits.threadTurnsPerMinute")).toMatchObject({ value: "6", where: "stack parameter SlackThreadTurnsPerMinute on agentx-staging-control-plane" });
    expect(rows.find((row) => row.key === "models.orchestrator")?.value).toBe("us.anthropic.claude-sonnet-4-6");
    expect(rows.find((row) => row.key === "alerts.address")?.value).toBe("none");
    expect(rows.find((row) => row.key === "limits.workspacesPerMember")?.value).toBe("3 (install-time default; the control plane may hold a newer setting)");
    expect(rows).toHaveLength(11);
  });

  it("refuses an unknown key", async () => {
    await expect(runConfigGet(services({ store: await seeded() }), ENV, "nope")).rejects.toThrow("unknown config key nope");
  });

  it("refuses an environment that is not installed, and the legacy deployment", async () => {
    await expect(runConfigList(services({ store: new MemoryParameterStore() }), ENV)).rejects.toThrow("environment staging is not installed in this account and region");
    const legacy = new MemoryParameterStore();
    await writeEnvironmentSettings(legacy, { ...STAGING_SETTINGS, naming: "legacy" });
    await expect(runConfigList(services({ store: legacy }), ENV)).rejects.toThrow("agentx config works on environments installed with agentx init; staging uses the legacy stack names");
  });
});

describe("agentx config set", () => {
  it("changes one stack parameter with a parameter-only update, keeping every other value, under the lock", async () => {
    const store = await seeded();
    const cloudFormation = fakeCloudFormation({ parameters: { SlackThreadTurnsPerMinute: "6", BudgetMonthlyUsd: "100", CallbackSigningKey: "****" } });
    const result = await runConfigSet(services({ store, cloudFormation }), ENV, { key: "limits.threadTurnsPerMinute", value: "12", yes: true });
    expect(result.changed).toBe(true);
    const create = cloudFormation.calls.find((call) => call.name === "CreateChangeSetCommand")!.input;
    expect(create.RoleARN).toBe(ROLE);
    expect(create.UsePreviousTemplate).toBe(true);
    expect(create.ChangeSetName).toMatch(/^agentx-config-\d+$/);
    expect(create.Parameters).toEqual(expect.arrayContaining([
      { ParameterKey: "SlackThreadTurnsPerMinute", ParameterValue: "12" },
      { ParameterKey: "CallbackSigningKey", UsePreviousValue: true },
    ]));
    expect(store.calls.filter((call) => call.name === lockParameterName(ENV)).map((call) => call.op)).toEqual(["put", "get", "delete"]);
  });

  it("changes nothing for an invalid value, before any AWS call", async () => {
    const cloudFormation = fakeCloudFormation();
    await expect(runConfigSet(services({ store: await seeded(), cloudFormation }), ENV, { key: "limits.threadTurnsPerMinute", value: "6.5", yes: true })).rejects.toThrow("must be a whole number from 1 to 60; nothing changed");
    expect(cloudFormation.calls).toEqual([]);
  });

  it("changes nothing when the stack parameter refuses a value the CLI accepted, and says why", async () => {
    const store = await seeded();
    const cloudFormation = fakeCloudFormation({ parameters: { BudgetMonthlyUsd: "100" }, changeSet: { status: "FAILED", reason: "Parameter BudgetMonthlyUsd failed to satisfy constraint" } });
    await expect(runConfigSet(services({ store, cloudFormation }), ENV, { key: "budget.monthlyUsd", value: "9999999", yes: true }))
      .rejects.toThrow("the change set for agentx-staging-control-plane failed: Parameter BudgetMonthlyUsd failed to satisfy constraint; nothing changed");
    expect(cloudFormation.calls.filter((call) => call.name === "ExecuteChangeSetCommand")).toEqual([]);
  });

  it("changes nothing when the model fails its one-token test call, and says why", async () => {
    const store = await seeded();
    const cloudFormation = fakeCloudFormation();
    const checks = passingChecks({ converse: async () => { throw Object.assign(new Error("You don't have access to the model"), { name: "AccessDeniedException" }); } });
    await expect(runConfigSet(services({ store, cloudFormation, checks }), ENV, { key: "models.orchestrator", value: "us.anthropic.claude-opus-4-1", yes: true })).rejects.toThrow("nothing changed");
    expect(cloudFormation.calls.filter((call) => call.name === "CreateChangeSetCommand")).toEqual([]);
    expect((await readEnvironmentSettings(store, ENV))?.models.orchestrator).toBe(STAGING_SETTINGS.models.orchestrator);
  });

  it("updates the model's stack parameter and the settings when the model answers", async () => {
    const store = await seeded();
    const checks = passingChecks();
    await runConfigSet(services({ store, checks, cloudFormation: fakeCloudFormation({ parameters: { ModelId: "amazon.nova-pro-v1:0" } }) }), ENV, { key: "models.worker", value: "amazon.nova-premier-v1:0", yes: true });
    expect(checks.models).toEqual(["amazon.nova-premier-v1:0"]);
    expect((await readEnvironmentSettings(store, ENV))?.models.worker).toBe("amazon.nova-premier-v1:0");
  });

  it("says nothing changed when the value is already set, and takes no lock", async () => {
    const store = await seeded();
    const result = await runConfigSet(services({ store, cloudFormation: fakeCloudFormation({ parameters: { SlackThreadTurnsPerMinute: "6" } }) }), ENV, { key: "limits.threadTurnsPerMinute", value: "6", yes: true });
    expect(result.changed).toBe(false);
  });

  it("refuses the workspace limits until the control plane's change tool exists (question 4)", async () => {
    await expect(runConfigSet(services({ store: await seeded() }), ENV, { key: "limits.workspacesPerMember", value: "5", yes: true }))
      .rejects.toThrow("limits.workspacesPerMember is the control plane's workspace limits setting; AgentX changes it with the admin change tool from spec 025 phase 25e, which this release does not have yet");
  });

  it("asks before applying without --yes, and applies nothing on no", async () => {
    const store = await seeded();
    const cloudFormation = fakeCloudFormation({ parameters: { SlowTurnMinutes: "5" } });
    await expect(runConfigSet(services({ store, cloudFormation, prompter: scriptedPrompter([false]) }), ENV, { key: "alerts.slowTurnMinutes", value: "9", yes: false }))
      .rejects.toThrow("the config change to agentx-staging-slack was not applied; nothing changed");
    expect(cloudFormation.calls.filter((call) => call.name === "ExecuteChangeSetCommand")).toEqual([]);
  });

  it("subscribes a new email alert address and records it, naming the old subscription an admin must remove", async () => {
    const store = await seeded();
    const alerts = fakeAlerts({ existing: [{ arn: "arn:aws:sns:us-east-1:123456789012:agentx-staging-alerts:1", protocol: "email", endpoint: "old@example.com" }], confirmAfterPolls: 0 });
    const run = services({ store, alerts });
    await runConfigSet(run, ENV, { key: "alerts.address", value: "ops@example.com", yes: true });
    expect(alerts.subscribed).toEqual(["email ops@example.com"]);
    expect((await readEnvironmentSettings(store, ENV))?.alertAddress).toBe("ops@example.com");
    expect(run.lines.join("\n")).toContain("aws sns unsubscribe --subscription-arn arn:aws:sns:us-east-1:123456789012:agentx-staging-alerts:1 --region us-east-1");
  });

  it("reads a webhook alert address only from a file or variable, stores it as a secret and never prints it", async () => {
    const store = await seeded();
    const secrets = memoryInitSecrets();
    const alerts = fakeAlerts({ confirmAfterPolls: 0 });
    const run = services({ store, secrets, alerts, processEnv: { HOOK: WEBHOOK } });
    await runConfigSet(run, ENV, { key: "alerts.address", valueSource: { envName: "HOOK" }, yes: true });
    expect(secrets.values.get("agentx/staging/alert-endpoint")).toBe(WEBHOOK);
    expect(alerts.subscribed).toEqual([`https ${WEBHOOK}`]);
    expect((await readEnvironmentSettings(store, ENV))?.alertAddress).toBe("https://events.pagerduty.com/...");
    expect(run.lines.join("\n")).not.toContain("SECRETkey");
    expect([...store.values.values()].join("\n")).not.toContain("SECRETkey");
  });

  it("refuses a webhook typed on the command line (FR-020)", async () => {
    await expect(runConfigSet(services({ store: await seeded() }), ENV, { key: "alerts.address", value: WEBHOOK, yes: true }))
      .rejects.toThrow("a webhook alert address is a secret; pass it with --value-file <path> or --value-env <NAME>, never on the command line");
  });
});
```

Create `tests/contract/day-two-permissions.test.ts`:

```ts
// SC-005: the day-2 commands run under the operator role alone. Each command declares the AWS
// actions it uses; every one must already be allowed by the operator role's policy.
import { describe, expect, it } from "vitest";
import { operatorRoleStatements } from "@agentx/contracts";
import { CONFIG_AWS_ACTIONS } from "../../packages/cli/src/day-two-actions.js";

const scope = {
  env: "staging", partition: "aws", region: "us-east-1", account: "123456789012",
  artifactBucketArn: "arn:aws:s3:::agentx-staging-access-artifactbucket", pullThroughPrefix: "agentx-staging", cloudFormationRoleName: "agentx-staging-cloudformation",
};
const allowed = new Set(operatorRoleStatements(scope).filter((statement) => statement.Effect === "Allow").flatMap((statement) => statement.Action));

describe("day-2 commands need no permission beyond the operator role (SC-005)", () => {
  it.each(CONFIG_AWS_ACTIONS.map((action) => [action]))("config: %s is allowed", (action) => {
    expect(allowed.has(action)).toBe(true);
  });
});
```

If `operatorRoleStatements` is not exported from `@agentx/contracts`'s index, import it from
`../../packages/contracts/src/access-policies.js` as `tests/contract/access-policies.test.ts` does.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/contract/config-commands.test.ts tests/contract/day-two-permissions.test.ts`
Expected: FAIL: the modules do not exist.

- [ ] **Step 3: Implement**

In `packages/cli/src/deploy/parameter-update.ts`:
- add `label?: "sign-in" | "config";` to `ParameterUpdateInput`;
- at the top of `updateStackParameters`: `const label = input.label ?? "sign-in";`;
- change set name: ``const changeSetName = `agentx-${label === "config" ? "config" : "signin"}-${Math.floor(now() / 1000)}`;``;
- the decline message: `` `the ${label} change to ${stackName} was not applied; nothing changed` ``;
- the end message: `` `stack ${stackName} ended in ${stackStatus}; ${label === "config" ? "the setting" : "sign-in"} did not change. See the stack's events in the CloudFormation console` ``;
- before the two sign-in missing-parameter checks, add:

```ts
  if (missing.length > 0 && label === "config") {
    throw agentXError("CONFIG_INVALID", `stack ${stackName} has no ${missing.join(", ")} parameter; it runs an older AgentX release, so upgrade it with agentx upgrade, then run this again`);
  }
```

Every sign-in message stays word for word (`tests/contract/signin-commands.test.ts` pins them).

Create `packages/cli/src/day-two-actions.ts`:

```ts
// SC-005: every AWS action each day-2 command uses. tests/contract/day-two-permissions.test.ts
// checks each is already allowed by the operator role, so a command that starts using a new action
// fails that test until the operator policy (and the spec) are changed on purpose.
export const CONFIG_AWS_ACTIONS: readonly string[] = [
  "sts:GetCallerIdentity",
  "ssm:GetParameter", "ssm:PutParameter", "ssm:DeleteParameter",
  "cloudformation:DescribeStacks", "cloudformation:CreateChangeSet", "cloudformation:DescribeChangeSet",
  "cloudformation:ExecuteChangeSet", "cloudformation:DeleteChangeSet", "iam:PassRole",
  "bedrock:InvokeModel",
  "secretsmanager:GetSecretValue", "secretsmanager:CreateSecret", "secretsmanager:PutSecretValue", "secretsmanager:TagResource",
  "sns:ListSubscriptionsByTopic", "sns:Subscribe",
];
```

Create `packages/cli/src/config/commands.ts`:

```ts
// agentx config list|get|set (FR-048, FR-049), under the operator role. Stack-parameter keys change
// with a parameter-only stack update (spec 025 R6's updateStackParameters); the alert address is an
// SSM value; the workspace limits are the control plane's setting (spec 025 FR-053).
import { agentXError, environmentStackName } from "@agentx/contracts";
import type { CallerIdentity, StackReader } from "../environments/adopt.js";
import { withEnvironmentLock } from "../environments/lock.js";
import type { ParameterStore } from "../environments/parameter-store.js";
import { readEnvironmentSettings, writeEnvironmentSettings, type EnvironmentSettings } from "../environments/settings.js";
import { updateStackParameters } from "../deploy/parameter-update.js";
import { checkAlertWebhook, storeAlertWebhook, webhookDisplay } from "../init/answers.js";
import type { InitSecrets } from "../init/context.js";
import { readInstallAnswers, writeInstallAnswers } from "../init/install-state.js";
import { modelCheckProblem, type PrerequisiteChecks } from "../init/prerequisites.js";
import { secretFromSource, type Prompter, type SecretSource } from "../init/prompts.js";
import { alertsTopicArn, ensureSubscribed, type AlertsApi } from "../setup/alerts.js";
import { CONFIG_KEYS, configKey, whereText, type ConfigKey, type ModelRole } from "./keys.js";

export interface ConfigServices {
  store: ParameterStore;
  secrets: InitSecrets;
  cloudFormation: { send(command: unknown): Promise<unknown> };
  stacks: StackReader;
  identity: CallerIdentity;
  checks: Pick<PrerequisiteChecks, "converse" | "openRouter">;
  alerts: AlertsApi;
  prompter: Prompter;
  processEnv: NodeJS.ProcessEnv;
  write: (line: string) => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  pollMs?: number;
}

export interface ConfigRow { key: string; value: string; where: string; description: string }

const LIMITS_REFUSAL = (key: string) =>
  `${key} is the control plane's workspace limits setting; AgentX changes it with the admin change tool from spec 025 phase 25e, which this release does not have yet. Until then, new installs take the stack parameter as their default`;

async function installed(services: ConfigServices, env: string): Promise<EnvironmentSettings> {
  const settings = await readEnvironmentSettings(services.store, env);
  if (settings === undefined) throw agentXError("CONFIG_INVALID", `environment ${env} is not installed in this account and region; check --env and --region`);
  if (settings.naming !== "environment") throw agentXError("CONFIG_INVALID", `agentx config works on environments installed with agentx init; ${env} uses the legacy stack names`);
  return settings;
}

async function currentValue(services: ConfigServices, env: string, settings: EnvironmentSettings, entry: ConfigKey): Promise<string> {
  const { target } = entry;
  if (target.kind === "settings") return settings.alertAddress ?? "none";
  const part = target.kind === "stack-parameter" ? target.part : target.installDefault.part;
  const name = target.kind === "stack-parameter" ? target.parameter : target.installDefault.parameter;
  const stack = await services.stacks.describe(environmentStackName(env, part));
  const value = stack?.parameters[name] ?? entry.defaultValue ?? "unknown";
  return target.kind === "stack-parameter" ? value : `${value} (install-time default; the control plane may hold a newer setting)`;
}

export async function runConfigList(services: ConfigServices, env: string): Promise<ConfigRow[]> {
  const settings = await installed(services, env);
  const rows: ConfigRow[] = [];
  for (const entry of CONFIG_KEYS) {
    rows.push({ key: entry.key, value: await currentValue(services, env, settings, entry), where: whereText(entry.target, env), description: entry.description });
  }
  return rows;
}

export async function runConfigGet(services: ConfigServices, env: string, key: string): Promise<ConfigRow> {
  const entry = configKey(key);
  const settings = await installed(services, env);
  return { key: entry.key, value: await currentValue(services, env, settings, entry), where: whereText(entry.target, env), description: entry.description };
}

/** FR-049: a model key passes the same one-token test call init makes, with the environment's provider. */
async function checkModel(services: ConfigServices, settings: EnvironmentSettings, role: ModelRole, modelId: string): Promise<void> {
  try {
    if (settings.models.providers?.[role] === "openrouter") {
      if (services.checks.openRouter === undefined) throw new Error("this agentx cannot check OpenRouter models");
      await services.checks.openRouter(modelId, settings.models.openRouter ?? {});
    } else {
      await services.checks.converse(modelId);
    }
  } catch (error) {
    throw agentXError("CONFIG_INVALID", `${modelCheckProblem({ modelId, role, region: settings.region, error })}; nothing changed`);
  }
}

export async function runConfigSet(services: ConfigServices, env: string, input: { key: string; value?: string; valueSource?: SecretSource; yes: boolean }): Promise<{ changed: boolean }> {
  const entry = configKey(input.key);
  const { target } = entry;
  if (target.kind === "control-plane-setting") throw agentXError("CONFIG_INVALID", LIMITS_REFUSAL(entry.key));
  if (target.kind === "settings") return setAlertAddress(services, env, input);
  if (input.value === undefined) throw agentXError("CONFIG_INVALID", `give the new value: agentx config set ${entry.key} <value>`);
  const value = entry.parse(input.value);
  const settings = await installed(services, env);
  if ((await currentValue(services, env, settings, entry)) === value) {
    services.write(`${entry.key} is already ${value}; nothing to change`);
    return { changed: false };
  }
  if (entry.model !== undefined) await checkModel(services, settings, entry.model, value);
  const roleArn = settings.access?.cloudFormationRoleArn;
  if (roleArn === undefined) throw agentXError("CONFIG_INVALID", `environment ${env}'s settings name no CloudFormation role; run agentx env use --env ${env}, or agentx init --resume`);
  const holder = (await services.identity.get()).arn;
  return withEnvironmentLock({ store: services.store, env, holder, command: `config set ${entry.key}`, now: services.now }, async () => {
    const stackName = environmentStackName(env, target.part);
    const result = await updateStackParameters({
      cloudFormation: services.cloudFormation, stackName, roleArn, changes: { [target.parameter]: value }, label: "config",
      confirm: async ({ parameters, changes }) => {
        for (const change of parameters) services.write(`${entry.key}: ${change.name} ${change.from} -> ${change.to} on ${stackName}`);
        for (const change of changes) services.write(`  ${change.action} ${change.logicalId} (${change.type})${change.replacement === "True" ? " [replacement]" : ""}`);
        return input.yes || services.prompter.confirm(`Apply this change to ${stackName}?`, { defaultValue: false });
      },
      write: services.write, now: services.now, sleep: services.sleep, ...(services.pollMs === undefined ? {} : { pollMs: services.pollMs }),
    });
    if (result.changed && entry.model !== undefined) {
      // Settings are the source of truth an upgrade reads models from (Task 10), so they follow the stack.
      const current = await installed(services, env);
      await writeEnvironmentSettings(services.store, { ...current, models: { ...current.models, [entry.model]: value }, updatedAt: new Date(services.now()).toISOString() });
      const answers = await readInstallAnswers(services.store, env);
      if (answers !== undefined) await writeInstallAnswers(services.store, { ...answers, models: { ...answers.models, [entry.model]: value } });
    }
    return { changed: result.changed };
  });
}

const looksLikeWebhook = (value: string) => /^https?:\/\//i.test(value.trim());

/** alerts.address: an email from the command line, or a webhook from a file, variable or hidden
 * prompt (FR-020). The operator role cannot unsubscribe (question 8): the old address stays until an
 * admin removes it, and this prints the exact command, showing a webhook only by its host. */
async function setAlertAddress(services: ConfigServices, env: string, input: { value?: string; valueSource?: SecretSource; yes: boolean }): Promise<{ changed: boolean }> {
  if (input.value !== undefined && looksLikeWebhook(input.value)) {
    throw agentXError("CONFIG_INVALID", "a webhook alert address is a secret; pass it with --value-file <path> or --value-env <NAME>, never on the command line");
  }
  const settings = await installed(services, env);
  const target = input.value !== undefined
    ? { kind: "email" as const, address: configKey("alerts.address").parse(input.value) }
    : await (async () => {
      const endpoint = checkAlertWebhook(await secretFromSource({ what: "the alert webhook address", flag: "--value-file", source: input.valueSource ?? {}, processEnv: services.processEnv, prompter: services.prompter }));
      return { kind: "webhook" as const, endpoint, display: webhookDisplay(endpoint) };
    })();
  const shown = target.kind === "email" ? target.address : target.display;
  const holder = (await services.identity.get()).arn;
  return withEnvironmentLock({ store: services.store, env, holder, command: "config set alerts.address", now: services.now }, async () => {
    const secretName = `agentx/${env}/alert-endpoint`;
    if (target.kind === "webhook") await storeAlertWebhook(services.secrets, secretName, target.endpoint);
    const topicArn = await alertsTopicArn({ stackOutputs: async (name) => (await services.stacks.describe(name))?.outputs, stackName: settings.stacks["control-plane"], next: "upgrade the environment with agentx upgrade" });
    const before = await services.alerts.subscriptions(topicArn);
    const state = await ensureSubscribed({ api: services.alerts, topicArn, target, write: services.write, sleep: services.sleep, now: services.now });
    const current = await installed(services, env);
    await writeEnvironmentSettings(services.store, { ...current, alertAddress: shown, updatedAt: new Date(services.now()).toISOString() });
    const answers = await readInstallAnswers(services.store, env);
    if (answers !== undefined) {
      await writeInstallAnswers(services.store, { ...answers, alert: target.kind === "email" ? { kind: "email", address: target.address } : { kind: "webhook", display: target.display, secretName } });
    }
    const newEndpoint = target.kind === "email" ? target.address.toLowerCase() : target.endpoint;
    for (const old of before) {
      const endpoint = old.protocol === "email" ? old.endpoint.toLowerCase() : old.endpoint;
      if (endpoint === newEndpoint || !old.arn.startsWith("arn:")) continue;
      const oldShown = old.protocol === "email" ? old.endpoint : `${old.protocol}://${safeHost(old.endpoint)}/...`;
      services.write(`${oldShown} is still subscribed. To stop sending it alarms, an admin runs: aws sns unsubscribe --subscription-arn ${old.arn} --region ${settings.region}`);
    }
    services.write(state === "pending"
      ? `Alerts will go to ${shown} once the subscription is confirmed; then run agentx --env ${env} alerts test.`
      : `Alerts now go to ${shown}. Send a test alarm with agentx --env ${env} alerts test.`);
    return { changed: true };
  });
}

function safeHost(endpoint: string): string {
  try { return new URL(endpoint).host; } catch { return "an address"; }
}
```

Create `packages/cli/src/config/cli.ts`:

```ts
// The `agentx config` command group (FR-048, FR-049), kept out of main.ts. Builds real AWS clients
// only when a test has not overridden them.
import { agentXError } from "@agentx/contracts";
import { BudgetsClient } from "@aws-sdk/client-budgets";
import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SNSClient } from "@aws-sdk/client-sns";
import { STSClient } from "@aws-sdk/client-sts";
import type { Command } from "commander";
import { realCommandRunner } from "../deploy/commands.js";
import { cloudFormationStackReader, stsCallerIdentity } from "../environments/adopt.js";
import type { ParameterStore } from "../environments/parameter-store.js";
import { secretsManagerInitSecrets } from "../init/context.js";
import { awsPrerequisiteChecks } from "../init/prerequisites.js";
import { processPrompter, unattendedPrompter, type TextWriter } from "../init/prompts.js";
import { formatSuccess } from "../output.js";
import { awsAlertsApi } from "../setup/alerts.js";
import { secretSource } from "../signin/cli.js";
import { runConfigGet, runConfigList, runConfigSet, type ConfigRow, type ConfigServices } from "./commands.js";

export interface ConfigCommandContext {
  overrides?: Partial<ConfigServices>;
  parameterStore: (region?: string) => ParameterStore;
  fetch: typeof fetch;
  stdout: TextWriter;
  stderr: TextWriter;
}

const rowText = (rows: ConfigRow[]) => rows.map((row) => `${row.key.padEnd(28)} ${row.value}\n${" ".repeat(29)}${row.where}`).join("\n");

export function registerConfigCommands(program: Command, context: ConfigCommandContext): void {
  const config = program.command("config").description("list, read and change an environment's settings: models, limits, Slack, alerts and the budget (operator role)");
  const services = (region: string | undefined, yes: boolean): ConfigServices => {
    const overrides = context.overrides ?? {};
    const aws = region === undefined ? {} : { region };
    const store = overrides.store ?? context.parameterStore(region);
    const accountRegion = region ?? process.env.AWS_REGION ?? "us-east-1";
    return {
      store,
      secrets: overrides.secrets ?? secretsManagerInitSecrets(new SecretsManagerClient(aws)),
      cloudFormation: overrides.cloudFormation ?? new CloudFormationClient(aws),
      stacks: overrides.stacks ?? cloudFormationStackReader(new CloudFormationClient(aws)),
      identity: overrides.identity ?? stsCallerIdentity(new STSClient(aws)),
      // Only converse and openRouter are used; the account is not needed for them.
      checks: overrides.checks ?? awsPrerequisiteChecks({ region: accountRegion, account: "000000000000", store, runner: realCommandRunner(context.stderr), fetch: context.fetch }),
      alerts: overrides.alerts ?? awsAlertsApi({ sns: new SNSClient(aws), cloudWatch: new CloudWatchClient(aws), budgets: new BudgetsClient({ region: "us-east-1" }) }),
      prompter: overrides.prompter ?? (yes || process.stdin.isTTY !== true ? unattendedPrompter() : processPrompter(context.stderr)),
      processEnv: overrides.processEnv ?? process.env,
      write: overrides.write ?? ((line) => { context.stderr.write(`${line}\n`); }),
      now: overrides.now ?? Date.now,
      sleep: overrides.sleep ?? ((ms) => new Promise((resolve) => { setTimeout(resolve, ms); })),
      ...(overrides.pollMs === undefined ? {} : { pollMs: overrides.pollMs }),
    };
  };
  const globals = (command: Command) => command.optsWithGlobals<{ env: string; json: boolean }>();
  const regionOption = ["--region <region>", "AWS region of the environment; defaults to your AWS configuration"] as const;

  config.command("list").description("every key, its value, and where it lives").option(...regionOption)
    .action(async (options: { region?: string }, command: Command) => {
      const rows = await runConfigList(services(options.region, false), globals(command).env);
      context.stdout.write(globals(command).json ? formatSuccess(rows, true) : `${rowText(rows)}\n`);
    });
  config.command("get").description("one key's value").argument("<key>").option(...regionOption)
    .action(async (key: string, options: { region?: string }, command: Command) => {
      const row = await runConfigGet(services(options.region, false), globals(command).env, key);
      context.stdout.write(globals(command).json ? formatSuccess(row, true) : `${row.value}\n`);
    });
  config.command("set").description("change one key: shows the change and asks first; model keys are tested first")
    .argument("<key>").argument("[value]")
    .option("--value-file <path>", "file holding the value (for a webhook alert address, which is a secret)")
    .option("--value-env <NAME>", "environment variable holding the value (for a webhook alert address)")
    .option("--yes", "apply without asking; the change is still printed", false)
    .option(...regionOption)
    .action(async (key: string, value: string | undefined, options: { valueFile?: string; valueEnv?: string; yes: boolean; region?: string }, command: Command) => {
      if (value !== undefined && (options.valueFile !== undefined || options.valueEnv !== undefined)) {
        throw agentXError("CONFIG_INVALID", "give the value once: on the command line, or with --value-file or --value-env");
      }
      const source = secretSource(options.valueFile, options.valueEnv);
      const result = await runConfigSet(services(options.region, options.yes), globals(command).env, {
        key, yes: options.yes, ...(value === undefined ? {} : { value }), ...(source === undefined ? {} : { valueSource: source }),
      });
      context.stdout.write(globals(command).json ? formatSuccess(result, true) : result.changed ? `${key} changed.\n` : "Nothing to change.\n");
    });
}
```

In `packages/cli/src/main.ts`, add to `CliDependencies`:
`/** \`agentx config\` overrides, for tests: never touch AWS. */ config?: Partial<ConfigServices>;`
and after `registerSigninCommands(...)`:

```ts
  registerConfigCommands(program, { ...(dependencies.config === undefined ? {} : { overrides: dependencies.config }), parameterStore, fetch: services.fetchImplementation, stdout: services.stdout, stderr: services.stderr });
```

`processPrompter` must offer `secret` with a hidden prompt (it does, since 15d1). Where `config set
alerts.address` is run with no value and no `--value-*` flag, `secretFromSource` asks the hidden
prompt; with no terminal it refuses with the flag to use.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/contract/config-commands.test.ts tests/contract/day-two-permissions.test.ts tests/contract/signin-commands.test.ts tests/contract/config-keys.test.ts`
Expected: PASS. If `fakeCloudFormation`'s `DescribeStacks` answer carries no parameter the test's
`changes` names, `updateStackParameters` refuses with the config missing-parameter message; seed the
fake's `parameters` as each test above does.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/deploy/parameter-update.ts packages/cli/src/config packages/cli/src/day-two-actions.ts packages/cli/src/main.ts tests/contract/config-commands.test.ts tests/contract/day-two-permissions.test.ts
git commit -m "feat(cli): agentx config list, get and set (FR-048, FR-049)"
```

### Task 5: `doctor`'s core and the stack checks

**Files:**
- Create: `packages/cli/src/doctor/checks.ts`, `packages/cli/src/doctor/stacks.ts`
- Create: `tests/support/doctor-fakes.ts`
- Test: `tests/contract/doctor-stacks.test.ts`

Depends on question 5 (drift is read, never detected).

**Interfaces:**
- Consumes: `installOrder` (parameters.ts), `EnvironmentSettings`, `InitAnswers`, `InstallProgress`,
  `ReleaseManifest`, the service interfaces `SlackApi`, `SlackChannelApi`, `GitHubApi`, `VendorApi`,
  `AlertsApi`, `PrerequisiteChecks`, `SignInCheck`.
- Produces (every later doctor task uses these unchanged):

```ts
// doctor/checks.ts
export type CheckStatus = "ok" | "warn" | "fail" | "skip";
export type DoctorGroup = "stacks" | "secrets" | "slack" | "github" | "connectors" | "models" | "alerts" | "capacity" | "sign-in";
export interface DoctorCheck { group: DoctorGroup; name: string; status: CheckStatus; detail: string; fix?: string }
export interface DoctorStack { status: string; parameters: Record<string, string>; outputs: Record<string, string>; drift?: string }
export interface DoctorServices {
  secrets: Pick<InitSecrets, "get">;
  stacks: { describe(stackName: string): Promise<DoctorStack | undefined> };
  releaseManifest: (version: string) => Promise<ReleaseManifest | undefined>;
  checks: Pick<PrerequisiteChecks, "converse" | "openRouter" | "ec2Quota" | "elasticIps">;
  slackApi: SlackApi; slackChannels: SlackChannelApi; github: GitHubApi; vendors: VendorApi; alerts: AlertsApi;
  fetch: typeof fetch; configDir: string;
  signIn: (settings: EnvironmentSettings) => Promise<SignInCheck[]>;
  now: () => number; sleep: (ms: number) => Promise<void>;
}
export interface DoctorContext { env: string; settings: EnvironmentSettings; answers: InitAnswers | undefined; progress: InstallProgress | undefined; services: DoctorServices }
export interface DoctorReport { env: string; region: string; version: string; engine: string; checks: DoctorCheck[]; failed: number; warned: number; passed: number }
export function check(group: DoctorGroup, name: string, status: CheckStatus, detail: string, fix?: string): DoctorCheck;
export function guarded(group: DoctorGroup, run: () => Promise<DoctorCheck[]>): Promise<DoctorCheck[]>;
export function doctorReport(settings: EnvironmentSettings, checks: DoctorCheck[]): DoctorReport;
export function reportText(report: DoctorReport): string;
// doctor/stacks.ts
export function releaseMismatch(part: DeployPart, parameters: Record<string, string>, manifest: ReleaseManifest): { code: string[]; images: string[] };
export function stackChecks(context: DoctorContext): Promise<DoctorCheck[]>;
```

- [ ] **Step 1: Write the fakes and the failing test**

Create `tests/support/doctor-fakes.ts`:

```ts
// Everything agentx doctor reads, faked: a healthy templates-engine environment by default, with
// every secret well formed. Tests break one thing at a time.
import { environmentStackName, type ReleaseManifest } from "@agentx/contracts";
import type { DoctorContext, DoctorServices, DoctorStack } from "../../packages/cli/src/doctor/checks.js";
import type { InstallProgress } from "../../packages/cli/src/init/install-state.js";
import { fakeGitHubApi, fakeSlackApi, memoryInitSecrets, passingChecks, sampleAnswers, TEST_BOT_TOKEN, TEST_PRIVATE_KEY, TEST_SIGNING_SECRET, T0 } from "./init-fakes.js";
import { fakeAlerts, fakeSlackChannels, fakeVendors, STAGING_SETTINGS } from "./setup-fakes.js";

export const ENV = "staging";
export const SIGNING_KEY = "callbackKEY-".padEnd(43, "q");
export const ASSET = "a".repeat(64);
export const WORKER_DIGEST = `sha256:${"b".repeat(64)}`;
export const SLACK_DIGEST = `sha256:${"c".repeat(64)}`;

export const MANIFEST: ReleaseManifest = {
  schemaVersion: 1, version: STAGING_SETTINGS.version, gitCommit: "d".repeat(40), environmentPlaceholder: "qqenv-placeholderqq", templates: [],
  packages: [{ assetId: ASSET, file: `packages/${ASSET}.zip`, sha256: "e".repeat(64), parts: ["control-plane"], bucketParameter: "AssetBucket", keyParameter: "AssetKey", hashParameter: "AssetHash", keyParameterValue: `packages/${ASSET}.zip` }],
  images: { worker: `public.ecr.aws/agentx/agentx-worker@${WORKER_DIGEST}`, slack: `public.ecr.aws/agentx/agentx-slack@${SLACK_DIGEST}` },
};

export const SECRETS: Record<string, string> = {
  "agentx/staging/callback-signing-key": SIGNING_KEY,
  "agentx/staging/slack": JSON.stringify({ botToken: TEST_BOT_TOKEN, signingSecret: TEST_SIGNING_SECRET }),
  "agentx/staging/github-app": JSON.stringify({ appId: "123", slug: "agentx-acme", account: "acme", privateKey: TEST_PRIVATE_KEY }),
};

/** Every part's stack, healthy, deployed by the templates engine from MANIFEST. */
export function healthyStacks(): Record<string, DoctorStack> {
  const stack = (parameters: Record<string, string> = {}, outputs: Record<string, string> = {}): DoctorStack => ({ status: "UPDATE_COMPLETE", parameters, outputs, drift: "NOT_CHECKED" });
  return {
    [environmentStackName(ENV, "access")]: stack({ OperatorPrincipalArn: "" }),
    [environmentStackName(ENV, "foundation")]: stack({}, { Ec2WorkerLaunchTemplateId: "lt-0123456789abcdef0" }),
    [environmentStackName(ENV, "identity")]: stack(),
    [environmentStackName(ENV, "runtime")]: stack({ WorkerImageUri: `123456789012.dkr.ecr.us-east-1.amazonaws.com/agentx-staging/agentx/agentx-worker@${WORKER_DIGEST}`, ModelId: "amazon.nova-pro-v1:0" }),
    [environmentStackName(ENV, "control-plane")]: stack(
      { AssetHash: ASSET, BudgetMonthlyUsd: "100", BudgetScope: "tag" },
      { SlackEventsUrl: "https://cp.example.test/slack/events", SlackInteractivityUrl: "https://cp.example.test/slack/interactivity", OperatorAlertsTopicArn: "arn:aws:sns:us-east-1:123456789012:agentx-staging-alerts", ApiEndpoint: "https://cp.example.test" },
    ),
    [environmentStackName(ENV, "slack")]: stack({ OrchestratorImageUri: `123456789012.dkr.ecr.us-east-1.amazonaws.com/agentx-staging/agentx/agentx-slack@${SLACK_DIGEST}` }),
  };
}

export const SETTINGS = {
  ...STAGING_SETTINGS,
  stacks: { access: "agentx-staging-access", foundation: "agentx-staging-foundation", identity: "agentx-staging-identity", runtime: "agentx-staging-runtime", "control-plane": "agentx-staging-control-plane", slack: "agentx-staging-slack" },
};

export const PROGRESS: InstallProgress = {
  schemaVersion: 1, env: ENV, steps: {}, updatedAt: new Date(T0).toISOString(),
  github: { account: "acme", appId: "123", slug: "agentx-acme", privateKeySecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/github-app-AbCdEf", installationId: "456" },
  slack: { appId: "A0APP", teamId: "T0TEAM", botUserId: "U0BOT" },
  project: { name: "payments", revision: 1, channelName: "payments", channelId: "C0123456789", teamId: "T0TEAM" },
};

export function doctorServices(overrides: Partial<DoctorServices> & { stackMap?: Record<string, DoctorStack> } = {}): DoctorServices {
  const { stackMap, ...rest } = overrides;
  const stacks = stackMap ?? healthyStacks();
  return {
    secrets: memoryInitSecrets(SECRETS),
    stacks: { describe: async (name) => stacks[name] },
    releaseManifest: async () => MANIFEST,
    checks: passingChecks(),
    slackApi: fakeSlackApi(),
    slackChannels: fakeSlackChannels([{ id: "C0123456789", name: "payments", isPrivate: false, isMember: true }]),
    github: fakeGitHubApi({ installationId: 456 }),
    vendors: fakeVendors(),
    alerts: fakeAlerts({ existing: [{ arn: "arn:aws:sns:us-east-1:123456789012:agentx-staging-alerts:1", protocol: "email", endpoint: "ops@example.com" }], budgetUsd: 100 }),
    // The Slack ingress: echoes the url_verification challenge, and answers the interactivity probe 200.
    fetch: (async (_input: unknown, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.startsWith("{")) return new Response(JSON.stringify({ challenge: (JSON.parse(body) as { challenge: string }).challenge }), { status: 200 });
      return new Response("", { status: 200 });
    }) as typeof fetch,
    configDir: "/nonexistent-agentx-doctor",
    signIn: async () => [{ name: "settings", ok: true, detail: "Slack sign-in on, company sign-in off" }],
    now: () => T0,
    sleep: async () => undefined,
    ...rest,
  };
}

export function doctorContext(overrides: Partial<DoctorContext> & { services?: DoctorServices } = {}): DoctorContext {
  return { env: ENV, settings: SETTINGS, answers: sampleAnswers({ env: ENV }), progress: PROGRESS, services: doctorServices(), ...overrides };
}
```

If `fakeGitHubApi`'s options or `sampleAnswers`'s signature differ, read `tests/support/init-fakes.ts`
and pass what makes the default environment healthy: installation 456 with at least one repository,
and answers for environment `staging` with an email alert.

Create `tests/contract/doctor-stacks.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { doctorReport, guarded, reportText } from "../../packages/cli/src/doctor/checks.js";
import { releaseMismatch, stackChecks } from "../../packages/cli/src/doctor/stacks.js";
import { doctorContext, doctorServices, healthyStacks, MANIFEST, SETTINGS } from "../support/doctor-fakes.js";

const withStack = (name: string, change: Partial<ReturnType<typeof healthyStacks>[string]> | undefined) => {
  const stacks = healthyStacks();
  if (change === undefined) delete stacks[name];
  else stacks[name] = { ...stacks[name]!, ...change };
  return doctorContext({ services: doctorServices({ stackMap: stacks }) });
};

describe("doctor: stacks (FR-050)", () => {
  it("passes a healthy environment deployed from the release in its settings", async () => {
    const checks = await stackChecks(doctorContext());
    expect(checks.filter((entry) => entry.status !== "ok")).toEqual([]);
    expect(checks.map((entry) => entry.name)).toEqual([
      "agentx-staging-access", "agentx-staging-foundation", "agentx-staging-identity", "agentx-staging-control-plane", "agentx-staging-runtime", "agentx-staging-slack",
      "engine", "drift", "release 1.2.3",
    ]);
  });

  it("fails a missing stack and says upgrade deploys it again", async () => {
    const found = (await stackChecks(withStack("agentx-staging-slack", undefined))).find((entry) => entry.name === "agentx-staging-slack")!;
    expect(found).toMatchObject({ status: "fail", detail: "does not exist", fix: "agentx --env staging upgrade deploys it again" });
  });

  it("fails a stack whose first create failed, offering the delete command and agentx destroy", async () => {
    const found = (await stackChecks(withStack("agentx-staging-identity", { status: "ROLLBACK_COMPLETE" }))).find((entry) => entry.name === "agentx-staging-identity")!;
    expect(found.status).toBe("fail");
    expect(found.fix).toContain("aws cloudformation delete-stack --stack-name agentx-staging-identity --region us-east-1");
    expect(found.fix).toContain("agentx --env staging destroy --region us-east-1");
  });

  it("warns about a rolled-back update and a stack that is still busy", async () => {
    expect((await stackChecks(withStack("agentx-staging-runtime", { status: "UPDATE_ROLLBACK_COMPLETE" }))).find((entry) => entry.name === "agentx-staging-runtime")?.status).toBe("warn");
    expect((await stackChecks(withStack("agentx-staging-runtime", { status: "UPDATE_IN_PROGRESS" }))).find((entry) => entry.name === "agentx-staging-runtime")?.status).toBe("warn");
  });

  it("fails an engine mismatch: a cdk-deployed stack (BootstrapVersion) in a templates environment", async () => {
    const stacks = healthyStacks();
    stacks["agentx-staging-slack"] = { ...stacks["agentx-staging-slack"]!, parameters: { ...stacks["agentx-staging-slack"]!.parameters, BootstrapVersion: "/cdk-bootstrap/hnb659fds/version" } };
    const engine = (await stackChecks(doctorContext({ services: doctorServices({ stackMap: stacks }) }))).find((entry) => entry.name === "engine")!;
    expect(engine.status).toBe("fail");
    expect(engine.detail).toContain("agentx-staging-slack (cdk)");
  });

  it("warns about drift found by the last drift check, with the admin command to see it", async () => {
    const drift = (await stackChecks(withStack("agentx-staging-control-plane", { drift: "DRIFTED" }))).find((entry) => entry.name === "drift")!;
    expect(drift.status).toBe("warn");
    expect(drift.fix).toContain("aws cloudformation describe-stack-resource-drifts --stack-name agentx-staging-control-plane --region us-east-1");
  });

  it("fails a stack running another release's code, and warns about a testing image", async () => {
    const stacks = healthyStacks();
    stacks["agentx-staging-control-plane"] = { ...stacks["agentx-staging-control-plane"]!, parameters: { ...stacks["agentx-staging-control-plane"]!.parameters, AssetHash: "f".repeat(64) } };
    const release = (await stackChecks(doctorContext({ services: doctorServices({ stackMap: stacks }) }))).find((entry) => entry.name === "release 1.2.3")!;
    expect(release).toMatchObject({ status: "fail", fix: "agentx --env staging upgrade --to 1.2.3" });
    expect(releaseMismatch("runtime", { WorkerImageUri: `x@sha256:${"9".repeat(64)}` }, MANIFEST)).toEqual({ code: [], images: ["WorkerImageUri"] });
  });

  it("warns, and does not fail, when the release manifest cannot be read", async () => {
    const release = (await stackChecks(doctorContext({ services: doctorServices({ releaseManifest: async () => undefined }) }))).find((entry) => entry.name === "release 1.2.3")!;
    expect(release.status).toBe("warn");
  });
});

describe("doctor: reporting (FR-051)", () => {
  it("counts results and prints each problem with its fix", () => {
    const report = doctorReport(SETTINGS, [
      { group: "stacks", name: "agentx-staging-slack", status: "fail", detail: "does not exist", fix: "agentx --env staging upgrade deploys it again" },
      { group: "alerts", name: "subscription", status: "warn", detail: "not confirmed yet" },
      { group: "models", name: "orchestrator", status: "ok", detail: "answers" },
      { group: "slack", name: "bound channel", status: "skip", detail: "no channel recorded" },
    ]);
    expect(report).toMatchObject({ env: "staging", failed: 1, warned: 1, passed: 1 });
    const text = reportText(report);
    expect(text).toContain("FAIL  stacks      agentx-staging-slack: does not exist\n      fix: agentx --env staging upgrade deploys it again");
    expect(text).toContain("warn  alerts      subscription: not confirmed yet");
    expect(text).toContain("skip  slack       bound channel: no channel recorded");
    expect(text.trimEnd().split("\n").at(-1)).toBe("1 failed, 1 warning, 1 passed, 1 skipped");
  });

  it("turns a check group that throws into one failed check, without the error's code prefix", async () => {
    const checks = await guarded("github", async () => { throw new Error("GitHub app lookup failed with HTTP 502"); });
    expect(checks).toEqual([{ group: "github", name: "github checks", status: "fail", detail: "could not run the github checks: GitHub app lookup failed with HTTP 502" }]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/contract/doctor-stacks.test.ts`
Expected: FAIL: the doctor modules do not exist.

- [ ] **Step 3: Implement**

Create `packages/cli/src/doctor/checks.ts`:

```ts
// agentx doctor's shared shapes (FR-050, FR-051): every check says what it found and, when something
// is wrong, how to fix it. A check never carries a secret value: checks read secrets only to judge
// their shape, and every message here is built from names and fixed words.
import type { ReleaseManifest } from "@agentx/contracts";
import { AgentXError } from "@agentx/contracts";
import type { EnvironmentSettings } from "../environments/settings.js";
import type { GitHubApi } from "../init/github-app.js";
import type { InitSecrets } from "../init/context.js";
import type { InitAnswers, InstallProgress } from "../init/install-state.js";
import type { PrerequisiteChecks } from "../init/prerequisites.js";
import type { SlackApi } from "../init/slack-app.js";
import type { AlertsApi } from "../setup/alerts.js";
import type { SlackChannelApi } from "../setup/channel-add.js";
import type { VendorApi } from "../setup/connectors/vendors.js";
import type { SignInCheck } from "../signin/check.js";

export type CheckStatus = "ok" | "warn" | "fail" | "skip";
export type DoctorGroup = "stacks" | "secrets" | "slack" | "github" | "connectors" | "models" | "alerts" | "capacity" | "sign-in";
export interface DoctorCheck { group: DoctorGroup; name: string; status: CheckStatus; detail: string; fix?: string }
export interface DoctorStack { status: string; parameters: Record<string, string>; outputs: Record<string, string>; drift?: string }

export interface DoctorServices {
  secrets: Pick<InitSecrets, "get">;
  stacks: { describe(stackName: string): Promise<DoctorStack | undefined> };
  /** The release manifest for a version: the local release cache, else the published release.json;
   * undefined when neither can be read. */
  releaseManifest: (version: string) => Promise<ReleaseManifest | undefined>;
  checks: Pick<PrerequisiteChecks, "converse" | "openRouter" | "ec2Quota" | "elasticIps">;
  slackApi: SlackApi;
  slackChannels: SlackChannelApi;
  github: GitHubApi;
  vendors: VendorApi;
  alerts: AlertsApi;
  fetch: typeof fetch;
  /** Where project files live (the global --config-dir). */
  configDir: string;
  /** Spec 025 FR-046: agentx signin check's checks, unchanged (R5). */
  signIn: (settings: EnvironmentSettings) => Promise<SignInCheck[]>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface DoctorContext { env: string; settings: EnvironmentSettings; answers: InitAnswers | undefined; progress: InstallProgress | undefined; services: DoctorServices }
export interface DoctorReport { env: string; region: string; version: string; engine: string; checks: DoctorCheck[]; failed: number; warned: number; passed: number }

export function check(group: DoctorGroup, name: string, status: CheckStatus, detail: string, fix?: string): DoctorCheck {
  return { group, name, status, detail, ...(fix === undefined ? {} : { fix }) };
}

/** An error's own words, without AgentXError's "CODE: " prefix. */
export function plainMessage(error: unknown): string {
  if (error instanceof AgentXError) return error.message.slice(error.code.length + 2);
  return error instanceof Error ? error.message : String(error);
}

/** A group that throws becomes one failed check, so one broken dependency never hides the others. */
export async function guarded(group: DoctorGroup, run: () => Promise<DoctorCheck[]>): Promise<DoctorCheck[]> {
  try {
    return await run();
  } catch (error) {
    return [check(group, `${group} checks`, "fail", `could not run the ${group} checks: ${plainMessage(error)}`)];
  }
}

export function doctorReport(settings: EnvironmentSettings, checks: DoctorCheck[]): DoctorReport {
  const count = (status: CheckStatus) => checks.filter((entry) => entry.status === status).length;
  return { env: settings.env, region: settings.region, version: settings.version, engine: settings.engine, checks, failed: count("fail"), warned: count("warn"), passed: count("ok") };
}

const LABEL: Record<CheckStatus, string> = { ok: "ok  ", warn: "warn", fail: "FAIL", skip: "skip" };

export function reportText(report: DoctorReport): string {
  const lines = [`agentx doctor: environment ${report.env} (release ${report.version}, ${report.engine} engine, ${report.region})`];
  for (const entry of report.checks) {
    lines.push(`${LABEL[entry.status]}  ${entry.group.padEnd(10)}  ${entry.name}: ${entry.detail}`);
    if (entry.fix !== undefined && entry.status !== "ok") lines.push(`      fix: ${entry.fix}`);
  }
  const skipped = report.checks.filter((entry) => entry.status === "skip").length;
  lines.push(`${report.failed} failed, ${report.warned} ${report.warned === 1 ? "warning" : "warnings"}, ${report.passed} passed, ${skipped} skipped`);
  return `${lines.join("\n")}\n`;
}
```

Create `packages/cli/src/doctor/stacks.ts`:

```ts
// FR-050: that stacks exist and are healthy, that they run the release the settings name, the engine
// they were deployed with, and their last drift result.
import { environmentStackName, type ReleaseManifest } from "@agentx/contracts";
import { installOrder, type DeployPart } from "../deploy/parameters.js";
import { check, type DoctorCheck, type DoctorContext, type DoctorStack } from "./checks.js";

const HEALTHY = new Set(["CREATE_COMPLETE", "UPDATE_COMPLETE", "IMPORT_COMPLETE"]);
const IMAGE_PARAMETERS: Partial<Record<DeployPart, { parameter: string; image: "worker" | "slack" }>> = {
  runtime: { parameter: "WorkerImageUri", image: "worker" },
  slack: { parameter: "OrchestratorImageUri", image: "slack" },
};

/** The parameters of `part` that differ from the release: code packages by asset hash (a failure),
 * images by digest (a warning: the testing-only image flags set other digests on purpose). */
export function releaseMismatch(part: DeployPart, parameters: Record<string, string>, manifest: ReleaseManifest): { code: string[]; images: string[] } {
  const code = manifest.packages.filter((pkg) => pkg.parts.includes(part) && parameters[pkg.hashParameter] !== pkg.assetId).map((pkg) => pkg.hashParameter);
  const images: string[] = [];
  const image = IMAGE_PARAMETERS[part];
  const digest = image === undefined ? undefined : manifest.images[image.image]?.split("@")[1];
  if (image !== undefined && digest !== undefined && !(parameters[image.parameter] ?? "").endsWith(`@${digest}`)) images.push(image.parameter);
  return { code, images };
}

function stackHealth(env: string, region: string, name: string, stack: DoctorStack | undefined): DoctorCheck {
  if (stack === undefined) return check("stacks", name, "fail", "does not exist", `agentx --env ${env} upgrade deploys it again`);
  const status = stack.status;
  const events = `aws cloudformation describe-stack-events --stack-name ${name} --region ${region}`;
  if (HEALTHY.has(status)) return check("stacks", name, "ok", status);
  if (status === "UPDATE_ROLLBACK_COMPLETE") return check("stacks", name, "warn", `${status}: its last update was rolled back, so it runs the previous version`, `read its events (${events}), fix the cause, then run agentx --env ${env} upgrade`);
  if (status.endsWith("_IN_PROGRESS")) return check("stacks", name, "warn", `${status}: CloudFormation is still working on it`, "run agentx doctor again when it finishes");
  if (status === "ROLLBACK_COMPLETE") {
    return check("stacks", name, "fail", `${status}: its first create failed`, `delete it (aws cloudformation delete-stack --stack-name ${name} --region ${region}) and run agentx init --env ${env} --region ${region} again, or remove the whole environment with agentx --env ${env} destroy --region ${region}`);
  }
  return check("stacks", name, "fail", status, `see its events (${events})`);
}

export async function stackChecks(context: DoctorContext): Promise<DoctorCheck[]> {
  const { env, settings, services } = context;
  const described = new Map<DeployPart, { name: string; stack: DoctorStack | undefined }>();
  const checks: DoctorCheck[] = [];
  for (const part of installOrder(settings.identity.mode)) {
    const name = settings.stacks[part] ?? environmentStackName(env, part);
    const stack = await services.stacks.describe(name);
    described.set(part, { name, stack });
    checks.push(stackHealth(env, settings.region, name, stack));
  }

  // Only a cdk-deployed stack (DefaultStackSynthesizer) declares BootstrapVersion; the templates
  // engine's stacks (LegacyStackSynthesizer) never do.
  const wrongEngine = [...described.values()].flatMap(({ name, stack }) => {
    if (stack === undefined) return [];
    const used = Object.hasOwn(stack.parameters, "BootstrapVersion") ? "cdk" : "templates";
    return used === settings.engine ? [] : [`${name} (${used})`];
  });
  checks.push(wrongEngine.length === 0
    ? check("stacks", "engine", "ok", `every stack was deployed with the ${settings.engine} engine`)
    : check("stacks", "engine", "fail", `the settings say ${settings.engine}, but ${wrongEngine.join(", ")} ${wrongEngine.length === 1 ? "was" : "were"} deployed with the other engine; switching engines is not supported`, `redeploy with the ${settings.engine} engine: agentx --env ${env} upgrade uses the engine in the settings`));

  const drifted = [...described.values()].filter(({ stack }) => stack?.drift === "DRIFTED").map(({ name }) => name);
  const checked = [...described.values()].some(({ stack }) => stack?.drift === "IN_SYNC" || stack?.drift === "DRIFTED");
  checks.push(drifted.length > 0
    ? check("stacks", "drift", "warn", `${drifted.join(", ")} changed outside CloudFormation (at the last drift check)`, `see what changed, with admin credentials: ${drifted.map((name) => `aws cloudformation describe-stack-resource-drifts --stack-name ${name} --region ${settings.region}`).join("; ")}; then undo it by hand or run agentx --env ${env} upgrade`)
    : check("stacks", "drift", "ok", checked ? "no drift at the last drift check" : `drift has not been checked; detecting it needs admin credentials (aws cloudformation detect-stack-drift --stack-name <stack> --region ${settings.region})`));

  const title = `release ${settings.version}`;
  const manifest = await services.releaseManifest(settings.version);
  if (manifest === undefined) {
    checks.push(check("stacks", title, "warn", `could not read release ${settings.version}'s release.json, so the stacks' versions were not compared`, "check this computer's network access to github.com, then run agentx doctor again"));
    return checks;
  }
  const code: string[] = [];
  const images: string[] = [];
  for (const [part, { name, stack }] of described) {
    if (stack === undefined) continue;
    const found = releaseMismatch(part, stack.parameters, manifest);
    code.push(...found.code.map((parameter) => `${name} ${parameter}`));
    images.push(...found.images.map((parameter) => `${name} ${parameter}`));
  }
  if (code.length > 0) checks.push(check("stacks", title, "fail", `${code.join(", ")} ${code.length === 1 ? "does" : "do"} not match release ${settings.version}'s code packages`, `agentx --env ${env} upgrade --to ${settings.version}`));
  else if (images.length > 0) checks.push(check("stacks", title, "warn", `${images.join(", ")} ${images.length === 1 ? "is not" : "are not"} release ${settings.version}'s image (the testing-only image flags set this)`, `agentx --env ${env} upgrade --to ${settings.version}, without --worker-image or --slack-image`));
  else checks.push(check("stacks", title, "ok", `every stack runs release ${settings.version}'s code and images`));
  return checks;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/contract/doctor-stacks.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/doctor/checks.ts packages/cli/src/doctor/stacks.ts tests/support/doctor-fakes.ts tests/contract/doctor-stacks.test.ts
git commit -m "feat(doctor): check shapes, reporting, and the stack health, release, engine and drift checks"
```

### Task 6: `doctor`'s secret, Slack and GitHub checks

**Files:**
- Create: `packages/cli/src/doctor/secrets.ts`, `packages/cli/src/doctor/slack.ts`, `packages/cli/src/doctor/github.ts`
- Test: `tests/contract/doctor-services.test.ts`

**Interfaces:**
- Consumes: `DoctorContext`, `check` (Task 5); `slackSecretName`, `readSlackBotToken`,
  `probeSlackUrls` (init/slack-app.ts); `githubAppSecretName`, `parseAppSecret`, `githubAppJwt`
  (init/github-app.ts); `checkAlertWebhook` (init/answers.ts).
- Produces:

```ts
export function secretChecks(context: DoctorContext): Promise<DoctorCheck[]>;  // doctor/secrets.ts
export function slackChecks(context: DoctorContext): Promise<DoctorCheck[]>;   // doctor/slack.ts
export function githubChecks(context: DoctorContext): Promise<DoctorCheck[]>;  // doctor/github.ts
```

- [ ] **Step 1: Write the failing test**

Create `tests/contract/doctor-services.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { githubChecks } from "../../packages/cli/src/doctor/github.js";
import { secretChecks } from "../../packages/cli/src/doctor/secrets.js";
import { slackChecks } from "../../packages/cli/src/doctor/slack.js";
import { doctorContext, doctorServices, SECRETS, SIGNING_KEY } from "../support/doctor-fakes.js";
import { fakeGitHubApi, fakeSlackApi, memoryInitSecrets, TEST_BOT_TOKEN, TEST_PRIVATE_KEY, TEST_SIGNING_SECRET } from "../support/init-fakes.js";
import { fakeSlackChannels } from "../support/setup-fakes.js";

const withSecrets = (values: Record<string, string>) => doctorContext({ services: doctorServices({ secrets: memoryInitSecrets(values) }) });
const text = (value: unknown) => JSON.stringify(value);

describe("doctor: secrets (FR-050)", () => {
  it("passes the three secrets every environment has", async () => {
    const checks = await secretChecks(doctorContext());
    expect(checks.map((entry) => [entry.name, entry.status])).toEqual([
      ["agentx/staging/callback-signing-key", "ok"], ["agentx/staging/slack", "ok"], ["agentx/staging/github-app", "ok"],
    ]);
  });

  it("fails a missing secret with a fix, and a malformed one without showing its value", async () => {
    const malformed = { ...SECRETS, "agentx/staging/slack": JSON.stringify({ botToken: "xoxp-PERSONALtoken", signingSecret: TEST_SIGNING_SECRET }) };
    delete (malformed as Record<string, string>)["agentx/staging/callback-signing-key"];
    const checks = await secretChecks(withSecrets(malformed));
    expect(checks.find((entry) => entry.name === "agentx/staging/callback-signing-key")).toMatchObject({ status: "fail", detail: "does not exist", fix: "run agentx --env staging upgrade: it makes a new key and redeploys the control plane with it" });
    const slack = checks.find((entry) => entry.name === "agentx/staging/slack")!;
    expect(slack.status).toBe("fail");
    expect(slack.detail).toBe("holds no bot token (xoxb-)");
    expect(text(checks)).not.toContain("PERSONALtoken");
  });

  it("checks the webhook alert address and the OpenRouter key only when the environment uses them", async () => {
    const context = doctorContext({
      answers: { ...doctorContext().answers!, alert: { kind: "webhook", display: "https://events.pagerduty.com/...", secretName: "agentx/staging/alert-endpoint" } },
      settings: { ...doctorContext().settings, models: { ...doctorContext().settings.models, openRouter: { secretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/openrouter-AbCdEf" } } },
      services: doctorServices({ secrets: memoryInitSecrets({ ...SECRETS, "agentx/staging/alert-endpoint": "http://not-https.example.com/SECRETkey" }) }),
    });
    const checks = await secretChecks(context);
    expect(checks.find((entry) => entry.name === "agentx/staging/alert-endpoint")?.status).toBe("fail");
    expect(checks.find((entry) => entry.name === "agentx/staging/openrouter")).toMatchObject({ status: "fail", detail: "does not exist" });
    expect(text(checks)).not.toContain("SECRETkey");
  });
});

describe("doctor: Slack (FR-050)", () => {
  it("passes a working bot token, both URLs answering the signed probe, and the bot in the bound channel", async () => {
    const checks = await slackChecks(doctorContext());
    expect(checks.map((entry) => [entry.name, entry.status])).toEqual([["bot token", "ok"], ["request URLs", "ok"], ["#payments", "ok"]]);
    expect(text(checks)).not.toContain(TEST_BOT_TOKEN);
    expect(text(checks)).not.toContain(TEST_SIGNING_SECRET);
  });

  it("fails a revoked token with Slack's error code only, and skips the checks that need it", async () => {
    const context = doctorContext({ services: doctorServices({ slackApi: fakeSlackApi({ authTest: async () => ({ ok: false, error: "token_revoked" }) }) }) });
    const checks = await slackChecks(context);
    expect(checks[0]).toMatchObject({ name: "bot token", status: "fail", detail: "Slack refused the bot token (token_revoked)" });
    expect(checks[0]!.fix).toContain("reinstall the Slack app");
  });

  it("fails when the bot token belongs to another workspace than init recorded", async () => {
    const context = doctorContext({ services: doctorServices({ slackApi: fakeSlackApi({ authTest: async () => ({ ok: true, user_id: "U1", bot_id: "B1", team_id: "T0OTHER", team: "Other" }) }) }) });
    expect((await slackChecks(context))[0]).toMatchObject({ status: "fail", detail: "the bot token is for workspace T0OTHER, but agentx init set up T0TEAM" });
  });

  it("fails when the events URL does not echo the challenge", async () => {
    const context = doctorContext({ services: doctorServices({ fetch: (async () => new Response("nope", { status: 500 })) as typeof fetch }) });
    expect((await slackChecks(context)).find((entry) => entry.name === "request URLs")?.status).toBe("fail");
  });

  it("fails when the bot left the bound channel, naming the invite", async () => {
    const context = doctorContext({ services: doctorServices({ slackChannels: fakeSlackChannels([{ id: "C0123456789", name: "payments", isPrivate: true, isMember: false }]) }) });
    expect((await slackChecks(context)).find((entry) => entry.name === "#payments")).toMatchObject({ status: "fail", fix: "in #payments, type /invite @agentx" });
  });

  it("skips the channel check when init bound no channel", async () => {
    const context = doctorContext({ progress: { ...doctorContext().progress!, project: undefined } as never });
    expect((await slackChecks(context)).at(-1)).toMatchObject({ name: "bound channels", status: "skip" });
  });
});

describe("doctor: GitHub App (FR-050)", () => {
  it("passes an installed app that sees repositories, and never shows the private key", async () => {
    const checks = await githubChecks(doctorContext());
    expect(checks).toEqual([expect.objectContaining({ name: "GitHub App", status: "ok", detail: "installed on acme, sees 1 repository" })]);
    expect(text(checks)).not.toContain(TEST_PRIVATE_KEY.slice(40, 80));
  });

  it("fails when the app is no longer installed, with the install link", async () => {
    const context = doctorContext({ services: doctorServices({ github: fakeGitHubApi({ installAfterPolls: 99 }) }) });
    expect((await githubChecks(context))[0]).toMatchObject({ status: "fail", fix: "install it again: https://github.com/apps/agentx-acme/installations/new" });
  });

  it("fails when the installation sees no repository", async () => {
    const context = doctorContext({ services: doctorServices({ github: fakeGitHubApi({ installationId: 456, repositoryCounts: [0] }) }) });
    expect((await githubChecks(context))[0]).toMatchObject({ status: "fail", detail: "installed on acme, but it sees no repository" });
  });

  it("skips when the GitHub App secret is unreadable (the secrets check reports it)", async () => {
    const context = withSecrets({ "agentx/staging/callback-signing-key": SIGNING_KEY });
    expect((await githubChecks(context))[0]?.status).toBe("skip");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/contract/doctor-services.test.ts`
Expected: FAIL: the modules do not exist.

- [ ] **Step 3: Implement**

Create `packages/cli/src/doctor/secrets.ts`:

```ts
// FR-050: that secrets exist and have the right shape. Values are read only to judge their shape;
// no message here is built from a value.
import { githubAppSecretName, parseAppSecret } from "../init/github-app.js";
import { checkAlertWebhook } from "../init/answers.js";
import { slackSecretName } from "../init/slack-app.js";
import { check, type DoctorCheck, type DoctorContext } from "./checks.js";

interface SecretRule { name: string; shape(value: string): string | undefined; fix: string }

function slackShape(value: string): string | undefined {
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(value) as Record<string, unknown>; } catch { return "is not JSON"; }
  if (typeof parsed.botToken !== "string" || !parsed.botToken.startsWith("xoxb-")) return "holds no bot token (xoxb-)";
  if (typeof parsed.signingSecret !== "string" || !/^[a-f0-9]{32}$/.test(parsed.signingSecret)) return "holds no Slack signing secret";
  return undefined;
}

export async function secretChecks(context: DoctorContext): Promise<DoctorCheck[]> {
  const { env, settings, answers, services } = context;
  const put = (name: string, shape: string) => `aws secretsmanager put-secret-value --secret-id ${name} --secret-string file://${shape} --region ${settings.region}`;
  const rules: SecretRule[] = [
    {
      name: `agentx/${env}/callback-signing-key`,
      shape: (value) => (value.length >= 32 ? undefined : "is shorter than the 32 characters the control plane needs"),
      fix: `run agentx --env ${env} upgrade: it makes a new key and redeploys the control plane with it`,
    },
    {
      name: slackSecretName(env),
      shape: slackShape,
      fix: `store the Slack app's Bot User OAuth Token and Signing Secret again: ${put(slackSecretName(env), "slack.json")}, where slack.json is {"botToken":"xoxb-...","signingSecret":"..."} plus clientId and clientSecret if developers sign in with Slack`,
    },
    {
      name: githubAppSecretName(env),
      shape: (value) => { try { parseAppSecret(value, githubAppSecretName(env)); return undefined; } catch { return "is not an AgentX GitHub App secret"; } },
      fix: `generate a new private key on the GitHub App's settings page, then ${put(githubAppSecretName(env), "github-app.json")} with {"appId":"...","slug":"...","account":"...","privateKey":"-----BEGIN RSA PRIVATE KEY-----..."}`,
    },
  ];
  if (answers?.alert.kind === "webhook") {
    rules.push({
      name: answers.alert.secretName,
      shape: (value) => { try { checkAlertWebhook(value.trim()); return undefined; } catch { return "is not an https:// address"; } },
      fix: `agentx --env ${env} config set alerts.address --value-file <file holding the PagerDuty or Opsgenie address>`,
    });
  }
  if (settings.models.openRouter?.secretArn.includes(`:secret:agentx/${env}/openrouter`) === true) {
    rules.push({ name: `agentx/${env}/openrouter`, shape: (value) => (value.trim() === "" ? "is empty" : undefined), fix: `store the OpenRouter key again: ${put(`agentx/${env}/openrouter`, "openrouter-key.txt")}` });
  }
  const checks: DoctorCheck[] = [];
  for (const rule of rules) {
    const value = await services.secrets.get(rule.name);
    if (value === undefined) { checks.push(check("secrets", rule.name, "fail", "does not exist", rule.fix)); continue; }
    const problem = rule.shape(value);
    checks.push(problem === undefined ? check("secrets", rule.name, "ok", "exists and has the right shape") : check("secrets", rule.name, "fail", problem, rule.fix));
  }
  return checks;
}
```

Create `packages/cli/src/doctor/slack.ts`:

```ts
// FR-050: the Slack token, the request URLs, and the bot's membership of the bound channel. Slack's
// own "Verified" mark cannot be read without an app configuration token (15d1 decision), so the URLs
// get the same signed self-probe agentx init sends.
import { environmentStackName } from "@agentx/contracts";
import { probeSlackUrls, readSlackBotToken, slackSecretName } from "../init/slack-app.js";
import { check, plainMessage, type DoctorCheck, type DoctorContext } from "./checks.js";

const PROBE_TIMEOUT_MS = 30_000;
/** Slack documents its error codes as lower case, digits and underscores; anything else is not echoed. */
const safeCode = (code: string | undefined) => (code !== undefined && /^[a-z0-9_]{1,64}$/.test(code) ? code : "no reason given");

export async function slackChecks(context: DoctorContext): Promise<DoctorCheck[]> {
  const { env, settings, progress, services } = context;
  const reinstall = `reinstall the Slack app (api.slack.com/apps, Install App), then store the new Bot User OAuth Token in ${slackSecretName(env)}`;
  let token: string;
  try {
    token = await readSlackBotToken(services.secrets, env);
  } catch (error) {
    return [check("slack", "bot token", "fail", plainMessage(error), reinstall)];
  }
  let auth: Awaited<ReturnType<typeof services.slackApi.authTest>>;
  try {
    auth = await services.slackApi.authTest(token);
  } catch {
    return [check("slack", "bot token", "fail", "could not reach Slack to check the bot token", "check this computer's network access to slack.com, then run agentx doctor again")];
  }
  if (!auth.ok) return [check("slack", "bot token", "fail", `Slack refused the bot token (${safeCode(auth.error)})`, reinstall)];
  if (auth.bot_id === undefined) return [check("slack", "bot token", "fail", "the stored token is not a bot token", reinstall)];
  const recordedTeam = progress?.slack?.teamId;
  if (recordedTeam !== undefined && auth.team_id !== recordedTeam) {
    return [check("slack", "bot token", "fail", `the bot token is for workspace ${auth.team_id ?? "unknown"}, but agentx init set up ${recordedTeam}`, `store the bot token of the Slack app installed in ${recordedTeam} in ${slackSecretName(env)}`)];
  }
  const checks = [check("slack", "bot token", "ok", `bot ${auth.user ?? auth.user_id ?? "user"} in ${auth.team ?? auth.team_id ?? "the workspace"}`)];

  const controlPlane = settings.stacks["control-plane"] ?? environmentStackName(env, "control-plane");
  const outputs = (await services.stacks.describe(controlPlane))?.outputs ?? {};
  const secret = JSON.parse((await services.secrets.get(slackSecretName(env))) ?? "{}") as { signingSecret?: string };
  if (outputs.SlackEventsUrl === undefined || outputs.SlackInteractivityUrl === undefined || secret.signingSecret === undefined) {
    checks.push(check("slack", "request URLs", "skip", "the control-plane stack reports no Slack URLs, or no signing secret is stored"));
  } else {
    try {
      await probeSlackUrls({ eventsUrl: outputs.SlackEventsUrl, interactivityUrl: outputs.SlackInteractivityUrl, signingSecret: secret.signingSecret, fetch: services.fetch, now: services.now, sleep: services.sleep, write: () => undefined, timeoutMs: PROBE_TIMEOUT_MS, pollMs: 5_000 });
      checks.push(check("slack", "request URLs", "ok", "the events URL echoes a signed challenge and the interactivity URL answers; Slack's own Verified mark is on the app's Event Subscriptions page"));
    } catch (error) {
      checks.push(check("slack", "request URLs", "fail", plainMessage(error), `check that the Slack app's Request URLs are ${outputs.SlackEventsUrl} and ${outputs.SlackInteractivityUrl}, and the control plane's SlackIngress logs`));
    }
  }

  const channel = progress?.project?.channelName;
  if (channel === undefined) {
    checks.push(check("slack", "bound channels", "skip", "agentx init recorded no bound channel; channels bound later are not listed until the control plane can report them"));
    return checks;
  }
  const found = await services.slackChannels.find(token, channel);
  const bot = auth.user ?? "the bot";
  if (found === undefined) checks.push(check("slack", `#${channel}`, "fail", "the channel no longer exists, or it is private and the bot is not in it", `in #${channel}, type /invite @${bot}, or bind another channel with agentx --env ${env} channel add`));
  else if (!found.isMember) checks.push(check("slack", `#${channel}`, "fail", "the bot is not a member", `in #${channel}, type /invite @${bot}`));
  else checks.push(check("slack", `#${channel}`, "ok", "the bot is a member"));
  return checks;
}
```

Create `packages/cli/src/doctor/github.ts`:

```ts
// FR-050: the GitHub App installation and repository access. The private key signs one JWT in
// memory and is never written anywhere.
import { githubAppJwt, githubAppSecretName, parseAppSecret } from "../init/github-app.js";
import { check, type DoctorCheck, type DoctorContext } from "./checks.js";

export async function githubChecks(context: DoctorContext): Promise<DoctorCheck[]> {
  const { env, progress, services } = context;
  const raw = await services.secrets.get(githubAppSecretName(env));
  let app;
  try {
    if (raw === undefined) throw new Error("missing");
    app = parseAppSecret(raw, githubAppSecretName(env));
  } catch {
    return [check("github", "GitHub App", "skip", `the secret ${githubAppSecretName(env)} cannot be read; the secrets check says why`)];
  }
  const jwt = githubAppJwt({ appId: app.appId, privateKey: app.privateKey, nowSeconds: Math.floor(services.now() / 1000) });
  let installations;
  try {
    installations = await services.github.listInstallations(jwt);
  } catch {
    return [check("github", "GitHub App", "fail", "GitHub refused the app's key, or could not be reached", `generate a new private key on the app's settings page and store it in ${githubAppSecretName(env)}`)];
  }
  const wanted = progress?.github?.installationId;
  const installation = wanted === undefined ? installations[0] : installations.find((entry) => String(entry.id) === wanted);
  if (installation === undefined) {
    return [check("github", "GitHub App", "fail", `the GitHub App ${app.slug} is not installed on ${app.account}`, `install it again: https://github.com/apps/${app.slug}/installations/new`)];
  }
  const token = await services.github.installationToken(jwt, String(installation.id));
  const count = await services.github.repositoryCount(token.token);
  if (count === 0) return [check("github", "GitHub App", "fail", `installed on ${installation.account.login}, but it sees no repository`, "choose the repositories AgentX may use in the app's installation settings on GitHub")];
  return [check("github", "GitHub App", "ok", `installed on ${installation.account.login}, sees ${count} ${count === 1 ? "repository" : "repositories"}`)];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/contract/doctor-services.test.ts`
Expected: PASS. If `probeSlackUrls`' interactivity answer differs from the fake (`fetch` in
`doctorServices` answers 200 to any form body), read `probeSlackUrls` and match the fake to what it
accepts; never loosen `probeSlackUrls` itself.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/doctor/secrets.ts packages/cli/src/doctor/slack.ts packages/cli/src/doctor/github.ts tests/contract/doctor-services.test.ts
git commit -m "feat(doctor): secret shape, Slack token and URLs, bound channel, and GitHub App checks"
```

### Task 7: `doctor`'s connector checks (credentials missing or expired, legacy integrations)

**Files:**
- Create: `packages/cli/src/environments/project-files.ts`
- Create: `packages/cli/src/doctor/connectors.ts`
- Test: `tests/contract/doctor-connectors.test.ts`

Depends on question 10 (Asana is not refreshed by `doctor`).

**Interfaces:**
- Consumes: `DoctorContext`, `check` (Task 5); `writeProjectFile` (setup/project-add.ts, as the
  fixture writer); `StaticSecretSchema`, `OAuthRefreshTokenSecretSchema` (contracts); `VendorApi`.
- Produces:

```ts
// environments/project-files.ts (Task 16's destroy uses it too)
export interface EnvironmentProjectFile { path: string; name: string; launchTemplateId: string; definition: Record<string, unknown> }
export function environmentProjectFiles(configDir: string, env: string): Promise<EnvironmentProjectFile[]>;
// doctor/connectors.ts
export function connectorChecks(context: DoctorContext): Promise<DoctorCheck[]>;
```

- [ ] **Step 1: Write the failing test**

Create `tests/contract/doctor-connectors.test.ts`:

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectDefinition } from "@agentx/contracts";
import { connectorChecks } from "../../packages/cli/src/doctor/connectors.js";
import { environmentProjectFiles } from "../../packages/cli/src/environments/project-files.js";
import { writeProjectFile } from "../../packages/cli/src/setup/project-add.js";
import { doctorContext, doctorServices, PROGRESS, SECRETS } from "../support/doctor-fakes.js";
import { memoryInitSecrets } from "../support/init-fakes.js";
import { fakeVendors } from "../support/setup-fakes.js";

const LINEAR_KEY = "lin_api_SECRETlinearKEY0123";
const JIRA_TOKEN = "ATATT3xSECRETjiraTOKEN";
const TEAM = "c408e946-78aa-4db8-923e-f78053dd954f";
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

const binding = (launchTemplateId: string) => ({ deploymentMode: "ec2-ebs", launchTemplateId, subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0aaa1111bbbb2222c" }], volumeSizeGib: "20", volumeType: "gp3" }) as never;

/** Project files written by agentx's own writer, so the header these tests parse is the real one. */
async function projectDir(files: Array<{ env: string; definition: Record<string, unknown> }>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agentx-doctor-projects-"));
  dirs.push(dir);
  for (const file of files) await writeProjectFile(dir, file.definition as unknown as ProjectDefinition, { env: file.env, binding: binding("lt-0123456789abcdef0") });
  return dir;
}

const payments = (connectors: unknown[], extra: Record<string, unknown> = {}) => ({ name: "payments", revision: 3, integrations: { connectors, ...extra } });
const linear = { name: "linear", type: "linear", credentialRef: "linear", scopes: [{ alias: "pay", teamId: TEAM }], tools: [] };
const jira = { name: "jira", type: "jira", credentialRef: "jira", scopes: [{ alias: "pay", cloudId: "0f1e2d3c-4b5a-4968-8776-655443322110", projectKey: "PAY" }], tools: [] };
const asana = { name: "asana", type: "asana", credentialRef: "asana", scopes: [{ alias: "pay", projectGid: "1200000000000001" }], tools: [] };
const connectorSecrets = {
  ...SECRETS,
  "agentx/staging/connectors/linear": JSON.stringify({ apiKey: LINEAR_KEY }),
  "agentx/staging/connectors/jira": JSON.stringify({ apiKey: JIRA_TOKEN }),
  "agentx/staging/connectors/asana": JSON.stringify({ clientId: "c", clientSecret: "SECRETasanaCLIENT", refreshToken: "SECRETrefresh" }),
};

async function run(input: { connectors: unknown[]; extra?: Record<string, unknown>; secrets?: Record<string, string>; vendors?: ReturnType<typeof fakeVendors>; progress?: typeof PROGRESS }) {
  const configDir = await projectDir([{ env: "staging", definition: payments(input.connectors, input.extra) }, { env: "staging-eu", definition: { name: "other", revision: 1, integrations: { connectors: [linear] } } }]);
  const services = doctorServices({ configDir, secrets: memoryInitSecrets(input.secrets ?? connectorSecrets), vendors: input.vendors ?? fakeVendors() });
  return connectorChecks(doctorContext({ services, progress: input.progress ?? PROGRESS }));
}

describe("environmentProjectFiles", () => {
  it("finds only this environment's project files, by the header agentx writes", async () => {
    const dir = await projectDir([{ env: "staging", definition: payments([]) }, { env: "staging-eu", definition: { name: "eu", revision: 1 } }, { env: "prod", definition: { name: "prod-app", revision: 1 } }]);
    const found = await environmentProjectFiles(dir, "staging");
    expect(found.map((file) => [file.name, file.launchTemplateId])).toEqual([["payments", "lt-0123456789abcdef0"]]);
  });

  it("answers an empty list for a directory that does not exist", async () => {
    expect(await environmentProjectFiles("/nonexistent-agentx-projects", "staging")).toEqual([]);
  });
});

describe("doctor: connectors (FR-050, the 15d2 decision on saved warnings)", () => {
  it("passes Linear and Jira with a real read, and Asana with its stored sign-in, never showing a credential", async () => {
    const vendors = fakeVendors({ jiraInside: ["PAY-1"] });
    const checks = await run({ connectors: [linear, jira, asana], vendors });
    expect(checks.map((entry) => [entry.name, entry.status])).toEqual([
      ["Linear (project payments)", "ok"], ["Jira (project payments)", "ok"], ["Asana (project payments)", "ok"],
    ]);
    expect(vendors.calls).toContain("linearTeams");
    expect(vendors.calls).toContain("jiraSearch project = PAY max 1");
    expect(vendors.calls).not.toContain("asanaAccessToken");
    expect(JSON.stringify(checks)).not.toMatch(/SECRET/);
  });

  it("fails a connector whose credentials are missing", async () => {
    const secrets: Record<string, string> = { ...connectorSecrets };
    delete secrets["agentx/staging/connectors/linear"];
    expect((await run({ connectors: [linear], secrets }))[0]).toMatchObject({ status: "fail", detail: "credentials missing: no secret agentx/staging/connectors/linear", fix: "agentx --env staging connector add linear --project payments" });
  });

  it("fails an expired or revoked key, and never repeats what the vendor said", async () => {
    const refused = await run({ connectors: [linear], vendors: fakeVendors({ linearRefuses: true }) });
    expect(refused[0]).toMatchObject({ status: "fail", detail: "Linear refused the stored key: it expired or was revoked" });
    const echoing = { ...fakeVendors(), linearTeams: async () => { throw new Error(`bad key ${LINEAR_KEY}`); } };
    const failed = await run({ connectors: [linear], vendors: echoing as never });
    expect(failed[0]).toMatchObject({ status: "fail", detail: "could not reach Linear to test the key" });
    expect(JSON.stringify(failed)).not.toContain(LINEAR_KEY);
  });

  it("fails when the key no longer sees the connected team", async () => {
    const checks = await run({ connectors: [linear], vendors: fakeVendors({ linearTeams: [{ id: "00000000-0000-4000-8000-000000000000", key: "OPS", name: "Ops" }] }) });
    expect(checks[0]).toMatchObject({ status: "fail", detail: "the key no longer sees team pay" });
  });

  it("warns when Jira finds no issue in the connected project", async () => {
    expect((await run({ connectors: [jira], vendors: fakeVendors({ jiraInside: [] }) }))[0]).toMatchObject({ status: "warn", detail: "the API token works, but finds no issue in PAY" });
  });

  it("fails an Asana credential with no refresh token: the bot never finished signing in", async () => {
    const secrets = { ...connectorSecrets, "agentx/staging/connectors/asana": JSON.stringify({ clientId: "c", clientSecret: "s" }) };
    expect((await run({ connectors: [asana], secrets }))[0]).toMatchObject({ status: "fail", detail: "the Asana bot never finished signing in (no refresh token is stored)" });
  });

  it("warns about the older integrations.githubMcp setting and a warning init saved", async () => {
    const progress = { ...PROGRESS, connectors: [{ type: "jira" as const, ref: "jira", warning: "the Jira service account can also see issues in HR, FIN" }] };
    const checks = await run({ connectors: [], extra: { githubMcp: { tools: [] } }, progress });
    expect(checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "project payments", status: "warn", detail: "uses the older integrations.githubMcp setting" }),
      expect.objectContaining({ name: "Jira warning", status: "warn", detail: "the Jira service account can also see issues in HR, FIN" }),
    ]));
  });

  it("says so when there are no connectors", async () => {
    expect(await run({ connectors: [] })).toEqual([expect.objectContaining({ name: "connectors", status: "ok", detail: "no connectors are set up" })]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/contract/doctor-connectors.test.ts`
Expected: FAIL: the modules do not exist.

- [ ] **Step 3: Implement**

Create `packages/cli/src/environments/project-files.ts`:

```ts
// The project files one environment's commands wrote (~/.agentx/projects by default). A project file
// names its environment only in the header agentx writes (setup/project-add.ts's fileHeader):
//   #   agentx admin project register --env <env> --file <path> --deployment-mode ec2-ebs --launch-template-id <lt-...> ...
// so this reads that line. A file without it (hand-written) belongs to no environment here.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";

export interface EnvironmentProjectFile { path: string; name: string; launchTemplateId: string; definition: Record<string, unknown> }

const REGISTER_LINE = /^#\s+agentx admin project register --env (\S+) --file .+? --deployment-mode ec2-ebs --launch-template-id (\S+)/m;

export async function environmentProjectFiles(configDir: string, env: string): Promise<EnvironmentProjectFile[]> {
  let entries: string[];
  try {
    entries = await readdir(configDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: EnvironmentProjectFile[] = [];
  for (const entry of entries.filter((name) => name.endsWith(".yaml")).sort()) {
    const path = join(configDir, entry);
    const text = await readFile(path, "utf8");
    const match = REGISTER_LINE.exec(text);
    if (match === null || match[1] !== env || match[2] === undefined) continue;
    let parsed: unknown;
    try { parsed = YAML.parse(text); } catch { continue; }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const definition = parsed as Record<string, unknown>;
    files.push({ path, name: typeof definition.name === "string" ? definition.name : entry.slice(0, -".yaml".length), launchTemplateId: match[2], definition });
  }
  return files;
}
```

Create `packages/cli/src/doctor/connectors.ts`:

```ts
// FR-050's "each connector's test read" and the 15d2 decision "FR-050, for phase 15e": for every
// connector in this environment's project files, the credential exists with the right shape and,
// for Linear and Jira, still works. Asana is not refreshed here: a refresh rotates the token the
// control plane holds (question 10). A vendor's own words never reach a check: they may repeat the key.
import { OAuthRefreshTokenSecretSchema, StaticSecretSchema } from "@agentx/contracts";
import { environmentProjectFiles } from "../environments/project-files.js";
import { check, type DoctorCheck, type DoctorContext } from "./checks.js";

type KnownType = "linear" | "jira" | "asana";
interface KnownConnector { type: KnownType; credentialRef: string; scopes: Array<{ alias: string; teamId?: string; cloudId?: string; projectKey?: string; projectGid?: string }> }
const LABEL: Record<KnownType, string> = { linear: "Linear", jira: "Jira", asana: "Asana" };
const refused = (error: unknown) => error instanceof Error && error.name === "VendorRefused";

function parseJson(raw: string): unknown {
  try { return JSON.parse(raw) as unknown; } catch { return undefined; }
}

async function connectorCheck(context: DoctorContext, project: string, connector: KnownConnector): Promise<DoctorCheck> {
  const { env, services } = context;
  const name = `${LABEL[connector.type]} (project ${project})`;
  const again = `agentx --env ${env} connector add ${connector.type} --project ${project}`;
  if (connector.credentialRef !== connector.type) return check("connectors", name, "skip", `credential ${connector.credentialRef} was registered by hand, so its secret is not known here`);
  const secretName = `agentx/${env}/connectors/${connector.credentialRef}`;
  const raw = await services.secrets.get(secretName);
  if (raw === undefined) return check("connectors", name, "fail", `credentials missing: no secret ${secretName}`, again);
  const value = parseJson(raw);
  if (connector.type === "asana") {
    return OAuthRefreshTokenSecretSchema.safeParse(value).success
      ? check("connectors", name, "ok", "the bot's sign-in is stored; not tested live, since a test refresh would rotate the token the control plane holds")
      : check("connectors", name, "fail", "the Asana bot never finished signing in (no refresh token is stored)", again);
  }
  const secret = StaticSecretSchema.safeParse(value);
  if (!secret.success) return check("connectors", name, "fail", `the secret ${secretName} has the wrong shape`, again);
  const key = secret.data.apiKey;
  if (connector.type === "linear") {
    let teams;
    try { teams = await services.vendors.linearTeams(key); } catch (error) {
      return refused(error) ? check("connectors", name, "fail", "Linear refused the stored key: it expired or was revoked", again) : check("connectors", name, "fail", "could not reach Linear to test the key", "check this computer's network access to linear.app, then run agentx doctor again");
    }
    const missing = connector.scopes.filter((scope) => !teams.some((team) => team.id.toLowerCase() === (scope.teamId ?? "").toLowerCase())).map((scope) => scope.alias);
    return missing.length > 0 ? check("connectors", name, "fail", `the key no longer sees team ${missing.join(", ")}`, again) : check("connectors", name, "ok", `the key sees ${teams.length} ${teams.length === 1 ? "team" : "teams"}`);
  }
  const empty: string[] = [];
  for (const scope of connector.scopes) {
    if (scope.cloudId === undefined) continue;
    let keys: string[];
    try {
      keys = await services.vendors.jiraSearch({ token: key, cloudId: scope.cloudId, jql: scope.projectKey === undefined ? "order by created DESC" : `project = ${scope.projectKey}`, maxResults: 1 });
    } catch (error) {
      return refused(error) ? check("connectors", name, "fail", "Atlassian refused the stored API token: it expired or was revoked", again) : check("connectors", name, "fail", "could not reach Atlassian to test the API token", "check this computer's network access to atlassian.com, then run agentx doctor again");
    }
    if (keys.length === 0) empty.push(scope.projectKey ?? scope.alias);
  }
  return empty.length > 0 ? check("connectors", name, "warn", `the API token works, but finds no issue in ${empty.join(", ")}`, "check that the Jira service account can still browse the project") : check("connectors", name, "ok", "the API token finds issues in the connected project");
}

export async function connectorChecks(context: DoctorContext): Promise<DoctorCheck[]> {
  const { env, progress, services } = context;
  const files = await environmentProjectFiles(services.configDir, env);
  const checks: DoctorCheck[] = [];
  for (const file of files) {
    const integrations = (file.definition.integrations ?? {}) as { githubMcp?: unknown; connectors?: unknown[] };
    if (integrations.githubMcp !== undefined) {
      checks.push(check("connectors", `project ${file.name}`, "warn", "uses the older integrations.githubMcp setting", "move it to integrations.connectors (docs/project-configuration.md), then register the project again"));
    }
    for (const entry of integrations.connectors ?? []) {
      const connector = entry as Partial<KnownConnector> & { type?: string };
      if (connector.type !== "linear" && connector.type !== "jira" && connector.type !== "asana") continue;
      if (typeof connector.credentialRef !== "string" || !Array.isArray(connector.scopes)) continue;
      checks.push(await connectorCheck(context, file.name, connector as KnownConnector));
    }
  }
  for (const saved of progress?.connectors ?? []) {
    if (saved.warning === undefined) continue;
    checks.push(check("connectors", `${LABEL[saved.type]} warning`, "warn", saved.warning, saved.type === "jira"
      ? "narrow the Jira service account to the connected project (docs/connectors/jira.md, Step 4), then run agentx connector add jira again"
      : `agentx --env ${env} connector add ${saved.type} --project <name>`));
  }
  const recorded = progress?.connectors ?? [];
  if (files.length === 0 && recorded.length > 0) {
    checks.push(check("connectors", "project files", "warn", `agentx init added ${recorded.map((entry) => LABEL[entry.type]).join(", ")}, but no project file of environment ${env} is in ${services.configDir}`, "run agentx doctor with --config-dir <the directory holding the project files>"));
  }
  return checks.length > 0 ? checks : [check("connectors", "connectors", "ok", "no connectors are set up")];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/contract/doctor-connectors.test.ts tests/contract/setup-project-add.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/environments/project-files.ts packages/cli/src/doctor/connectors.ts tests/contract/doctor-connectors.test.ts
git commit -m "feat(doctor): connector checks for missing or expired credentials, saved warnings and the older githubMcp setting"
```

### Task 8: `doctor`'s model, alert, budget, capacity and sign-in checks, and running every group

**Files:**
- Create: `packages/cli/src/doctor/account.ts`, `packages/cli/src/doctor/run.ts`
- Test: `tests/contract/doctor-run.test.ts`

**Interfaces:**
- Consumes: every group from Tasks 5 to 7; `modelCheckProblem`, `NAT_ELASTIC_IPS`
  (prerequisites.ts); `readEnvironmentSettings`, `readInstallAnswers`, `readInstallProgress`.
- Produces:

```ts
// doctor/account.ts
export function modelChecks(context: DoctorContext): Promise<DoctorCheck[]>;
export function alertChecks(context: DoctorContext): Promise<DoctorCheck[]>;
export function capacityChecks(context: DoctorContext): Promise<DoctorCheck[]>;
export function signInChecks(context: DoctorContext): Promise<DoctorCheck[]>;
// doctor/run.ts
export function runDoctor(input: { env: string; store: ParameterStore; services: (settings: EnvironmentSettings) => DoctorServices }): Promise<DoctorReport>;
```

- [ ] **Step 1: Write the failing test**

Create `tests/contract/doctor-run.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { alertChecks, capacityChecks, modelChecks, signInChecks } from "../../packages/cli/src/doctor/account.js";
import { reportText } from "../../packages/cli/src/doctor/checks.js";
import { runDoctor } from "../../packages/cli/src/doctor/run.js";
import { writeEnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import { writeInstallAnswers, writeInstallProgress } from "../../packages/cli/src/init/install-state.js";
import { doctorContext, doctorServices, healthyStacks, PROGRESS, SECRETS, SETTINGS } from "../support/doctor-fakes.js";
import { fakeSlackApi, memoryInitSecrets, passingChecks, sampleAnswers, TEST_BOT_TOKEN, TEST_PRIVATE_KEY, TEST_SIGNING_SECRET } from "../support/init-fakes.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";
import { fakeAlerts } from "../support/setup-fakes.js";

describe("doctor: models (FR-050)", () => {
  it("tests each distinct model once and fails one the account cannot use, with the config command to change it", async () => {
    const checks = passingChecks({ converse: async (id) => { if (id === "amazon.nova-pro-v1:0") throw Object.assign(new Error("no access"), { name: "AccessDeniedException" }); } });
    const found = await modelChecks(doctorContext({ services: doctorServices({ checks }) }));
    expect(found.map((entry) => [entry.name, entry.status])).toEqual([["orchestrator", "ok"], ["classifier", "ok"], ["worker", "fail"]]);
    expect(found[2]!.fix).toBe("choose another model with agentx --env staging config set models.worker <model id>");
  });
});

describe("doctor: alerts and the budget (FR-050)", () => {
  it("passes a confirmed subscription and a budget that matches its parameter", async () => {
    expect((await alertChecks(doctorContext())).map((entry) => [entry.name, entry.status])).toEqual([["subscription", "ok"], ["budget", "ok"]]);
  });

  it("fails when an address is set but nobody is subscribed, and warns when nothing is confirmed yet", async () => {
    expect((await alertChecks(doctorContext({ services: doctorServices({ alerts: fakeAlerts({ budgetUsd: 100 }) }) })))[0]).toMatchObject({ status: "fail", fix: "agentx --env staging config set alerts.address <email>" });
    const pending = fakeAlerts({ existing: [{ arn: "PendingConfirmation", protocol: "email", endpoint: "ops@example.com" }], confirmAfterPolls: 99, budgetUsd: 100 });
    expect((await alertChecks(doctorContext({ services: doctorServices({ alerts: pending }) })))[0]?.status).toBe("warn");
  });

  it("warns, and does not fail, when no alert address was ever set", async () => {
    const context = doctorContext({ answers: sampleAnswers({ alert: { kind: "none" } }), services: doctorServices({ alerts: fakeAlerts({ budgetUsd: 100 }) }) });
    expect((await alertChecks(context))[0]).toMatchObject({ status: "warn", detail: "no alert address is set, so alarms go nowhere" });
  });

  it("fails a missing budget and passes budget.monthlyUsd 0 as no budget", async () => {
    expect((await alertChecks(doctorContext({ services: doctorServices({ alerts: fakeAlerts({ existing: [{ arn: "arn:aws:sns:us-east-1:123456789012:agentx-staging-alerts:1", protocol: "email", endpoint: "ops@example.com" }] }) }) })))[1]).toMatchObject({ status: "fail", detail: "the budget agentx-staging-monthly is missing" });
    const stacks = healthyStacks();
    stacks["agentx-staging-control-plane"] = { ...stacks["agentx-staging-control-plane"]!, parameters: { ...stacks["agentx-staging-control-plane"]!.parameters, BudgetMonthlyUsd: "0" } };
    expect((await alertChecks(doctorContext({ services: doctorServices({ stackMap: stacks }) })))[1]).toMatchObject({ status: "ok", detail: "no budget (budget.monthlyUsd is 0)" });
  });
});

describe("doctor: capacity (item 5)", () => {
  it("reports free Elastic IPs and warns when a second environment would not fit", async () => {
    expect((await capacityChecks(doctorContext())).find((entry) => entry.name === "Elastic IPs")).toMatchObject({ status: "ok", detail: "5 of 5 EC2-VPC Elastic IPs free in us-east-1" });
    const tight = passingChecks({ elasticIps: async () => ({ quota: 5, allocated: 4 }) });
    const found = (await capacityChecks(doctorContext({ services: doctorServices({ checks: tight }) }))).find((entry) => entry.name === "Elastic IPs")!;
    expect(found.status).toBe("warn");
    expect(found.fix).toContain("aws service-quotas request-service-quota-increase --service-code ec2 --quota-code L-0263D0A3 --desired-value 6 --region us-east-1");
  });
});

describe("doctor: developer sign-in (spec 025 FR-046)", () => {
  it("shows agentx signin check's checks as they are", async () => {
    const services = doctorServices({ signIn: async () => [{ name: "Slack redirect URL", ok: true, warn: true, detail: "not verified" }, { name: "Slack team ID", ok: false, detail: "no team ID is recorded" }] });
    expect((await signInChecks(doctorContext({ services }))).map((entry) => [entry.name, entry.status])).toEqual([["Slack redirect URL", "warn"], ["Slack team ID", "fail"]]);
  });
});

describe("runDoctor", () => {
  async function store(settings = SETTINGS): Promise<MemoryParameterStore> {
    const seeded = new MemoryParameterStore();
    await writeEnvironmentSettings(seeded, settings);
    await writeInstallAnswers(seeded, sampleAnswers());
    await writeInstallProgress(seeded, PROGRESS);
    return seeded;
  }

  it("passes a healthy environment", async () => {
    const report = await runDoctor({ env: "staging", store: await store(), services: () => doctorServices() });
    expect(report.checks.filter((entry) => entry.status === "fail")).toEqual([]);
    expect(report.failed).toBe(0);
  });

  it("reports every broken piece at once, and no secret value in text or JSON", async () => {
    const services = () => doctorServices({
      secrets: memoryInitSecrets({ ...SECRETS, "agentx/staging/slack": JSON.stringify({ botToken: TEST_BOT_TOKEN, signingSecret: "not-hex" }) }),
      slackApi: fakeSlackApi({ authTest: async () => ({ ok: false, error: "invalid_auth" }) }),
      checks: passingChecks({ converse: async () => { throw new Error("throttled"); } }),
      github: { ...doctorServices().github, listInstallations: async () => { throw new Error("401"); } },
    });
    const report = await runDoctor({ env: "staging", store: await store(), services });
    expect(report.failed).toBeGreaterThanOrEqual(4);
    for (const output of [JSON.stringify(report), reportText(report)]) {
      for (const secret of [TEST_BOT_TOKEN, TEST_SIGNING_SECRET, TEST_PRIVATE_KEY.slice(40, 80), SECRETS["agentx/staging/callback-signing-key"]!]) expect(output).not.toContain(secret);
    }
  });

  it("refuses an environment that is not installed, and the legacy deployment", async () => {
    await expect(runDoctor({ env: "staging", store: new MemoryParameterStore(), services: () => doctorServices() })).rejects.toThrow("environment staging is not installed in this account and region");
    await expect(runDoctor({ env: "staging", store: await store({ ...SETTINGS, naming: "legacy" }), services: () => doctorServices() })).rejects.toThrow("agentx doctor checks environments installed with agentx init; staging uses the legacy stack names");
  });

  it("keeps going when a group throws, reporting it as one failed check", async () => {
    const services = () => doctorServices({ signIn: async () => { throw new Error("SSM read failed"); } });
    const report = await runDoctor({ env: "staging", store: await store(), services });
    expect(report.checks).toContainEqual({ group: "sign-in", name: "sign-in checks", status: "fail", detail: "could not run the sign-in checks: SSM read failed" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/contract/doctor-run.test.ts`
Expected: FAIL: the modules do not exist.

- [ ] **Step 3: Implement**

Create `packages/cli/src/doctor/account.ts`:

```ts
// FR-050's model access, alert subscription and budget; the region's capacity (the vCPU quota and
// free Elastic IPs init checks, item 5); and spec 025 FR-046's sign-in checks, unchanged.
import { environmentStackName } from "@agentx/contracts";
import { modelCheckProblem, NAT_ELASTIC_IPS, type ModelRole } from "../init/prerequisites.js";
import { check, plainMessage, type DoctorCheck, type DoctorContext } from "./checks.js";

export async function modelChecks(context: DoctorContext): Promise<DoctorCheck[]> {
  const { env, settings, services } = context;
  const results = new Map<string, { ok: boolean; detail: string }>();
  const checks: DoctorCheck[] = [];
  for (const role of ["orchestrator", "classifier", "worker"] as const satisfies readonly ModelRole[]) {
    const modelId = settings.models[role];
    const provider = settings.models.providers?.[role] ?? "amazon-bedrock";
    const key = `${provider}/${modelId}`;
    let result = results.get(key);
    if (result === undefined) {
      try {
        if (provider === "openrouter") {
          if (services.checks.openRouter === undefined) throw new Error("this agentx cannot check OpenRouter models");
          await services.checks.openRouter(modelId, settings.models.openRouter ?? {});
        } else {
          await services.checks.converse(modelId);
        }
        result = { ok: true, detail: `${modelId} answers a one-token test call` };
      } catch (error) {
        result = { ok: false, detail: modelCheckProblem({ modelId, role, region: settings.region, error }) };
      }
      results.set(key, result);
    }
    checks.push(result.ok ? check("models", role, "ok", result.detail) : check("models", role, "fail", result.detail, `choose another model with agentx --env ${env} config set models.${role} <model id>`));
  }
  return checks;
}

export async function alertChecks(context: DoctorContext): Promise<DoctorCheck[]> {
  const { env, settings, answers, services } = context;
  const controlPlane = await services.stacks.describe(settings.stacks["control-plane"] ?? environmentStackName(env, "control-plane"));
  const set = `agentx --env ${env} config set alerts.address <email>`;
  const checks: DoctorCheck[] = [];
  const topicArn = controlPlane?.outputs.OperatorAlertsTopicArn;
  if (topicArn === undefined || topicArn === "") {
    checks.push(check("alerts", "subscription", "fail", "the control-plane stack reports no alert topic", `agentx --env ${env} upgrade`));
  } else {
    const subscriptions = await services.alerts.subscriptions(topicArn);
    const confirmed = subscriptions.filter((entry) => entry.arn.startsWith("arn:"));
    const addressSet = settings.alertAddress !== undefined || (answers !== undefined && answers.alert.kind !== "none");
    if (subscriptions.length === 0) {
      checks.push(addressSet
        ? check("alerts", "subscription", "fail", `nobody is subscribed to agentx-${env}-alerts, so alarms go nowhere`, set)
        : check("alerts", "subscription", "warn", "no alert address is set, so alarms go nowhere", set));
    } else if (confirmed.length === 0) {
      checks.push(check("alerts", "subscription", "warn", "the subscription is not confirmed yet", `confirm it (the AWS Notifications email, or your webhook's SubscribeURL), then run agentx --env ${env} alerts test`));
    } else {
      const protocols = [...new Set(confirmed.map((entry) => entry.protocol))].join(", ");
      checks.push(check("alerts", "subscription", "ok", `${confirmed.length} confirmed ${confirmed.length === 1 ? "subscription" : "subscriptions"} (${protocols})`));
    }
  }
  const monthly = controlPlane?.parameters.BudgetMonthlyUsd ?? "0";
  const scope = controlPlane?.parameters.BudgetScope ?? "tag";
  if (monthly === "0") {
    checks.push(check("alerts", "budget", "ok", "no budget (budget.monthlyUsd is 0)"));
  } else {
    const limit = await services.alerts.budget(settings.account, `agentx-${env}-monthly`);
    if (limit === undefined) checks.push(check("alerts", "budget", "fail", `the budget agentx-${env}-monthly is missing`, `agentx --env ${env} upgrade (the control-plane stack creates it)`));
    else if (limit !== Number(monthly)) checks.push(check("alerts", "budget", "warn", `the budget is $${limit} a month, but budget.monthlyUsd is ${monthly}`, `agentx --env ${env} upgrade`));
    else checks.push(check("alerts", "budget", "ok", `$${monthly} a month, ${scope === "tag" ? "costs tagged agentx:env (the tag must be active in Billing, Cost allocation tags)" : "the whole account"}`));
  }
  return checks;
}

export async function capacityChecks(context: DoctorContext): Promise<DoctorCheck[]> {
  const { settings, services } = context;
  const region = settings.region;
  const checks: DoctorCheck[] = [];
  try {
    const quota = await services.checks.ec2Quota();
    checks.push(quota >= 1
      ? check("capacity", "EC2 vCPUs", "ok", `the Standard on-demand vCPU quota is ${quota} in ${region}`)
      : check("capacity", "EC2 vCPUs", "fail", `the Standard on-demand vCPU quota is ${quota} in ${region}, so no worker can start`, `request an increase of L-1216C47A in Service Quotas for ${region}`));
  } catch (error) {
    checks.push(check("capacity", "EC2 vCPUs", "warn", `could not read the vCPU quota: ${plainMessage(error)}`));
  }
  try {
    const { quota, allocated } = await services.checks.elasticIps();
    const free = Math.max(0, quota - allocated);
    checks.push(free >= NAT_ELASTIC_IPS
      ? check("capacity", "Elastic IPs", "ok", `${free} of ${quota} EC2-VPC Elastic IPs free in ${region}`)
      : check("capacity", "Elastic IPs", "warn", `${free} of ${quota} EC2-VPC Elastic IPs free in ${region}: this environment keeps working, but another environment in this region would not fit (it needs ${NAT_ELASTIC_IPS})`,
        `release addresses you no longer use, or request more: aws service-quotas request-service-quota-increase --service-code ec2 --quota-code L-0263D0A3 --desired-value ${allocated + NAT_ELASTIC_IPS} --region ${region}`));
  } catch (error) {
    checks.push(check("capacity", "Elastic IPs", "warn", `could not count Elastic IPs: ${plainMessage(error)}`));
  }
  return checks;
}

export async function signInChecks(context: DoctorContext): Promise<DoctorCheck[]> {
  const found = await context.services.signIn(context.settings);
  return found.map((entry) => check("sign-in", entry.name, entry.warn === true ? "warn" : entry.ok ? "ok" : "fail", entry.detail));
}
```

If `ModelRole` is not exported from `prerequisites.ts` under that name, export it there (it is
declared as `export type ModelRole` today).

Create `packages/cli/src/doctor/run.ts`:

```ts
// agentx doctor (FR-050, FR-051): every check group in order. Each group runs even when an earlier
// one failed, so one run lists everything wrong.
import { agentXError } from "@agentx/contracts";
import type { ParameterStore } from "../environments/parameter-store.js";
import { readEnvironmentSettings, type EnvironmentSettings } from "../environments/settings.js";
import { readInstallAnswers, readInstallProgress } from "../init/install-state.js";
import { alertChecks, capacityChecks, modelChecks, signInChecks } from "./account.js";
import { check, doctorReport, guarded, plainMessage, type DoctorCheck, type DoctorContext, type DoctorGroup, type DoctorReport, type DoctorServices } from "./checks.js";
import { connectorChecks } from "./connectors.js";
import { githubChecks } from "./github.js";
import { secretChecks } from "./secrets.js";
import { slackChecks } from "./slack.js";
import { stackChecks } from "./stacks.js";

const GROUPS: ReadonlyArray<[DoctorGroup, (context: DoctorContext) => Promise<DoctorCheck[]>]> = [
  ["stacks", stackChecks], ["secrets", secretChecks], ["slack", slackChecks], ["github", githubChecks], ["connectors", connectorChecks],
  ["models", modelChecks], ["alerts", alertChecks], ["capacity", capacityChecks], ["sign-in", signInChecks],
];

export async function runDoctor(input: { env: string; store: ParameterStore; services: (settings: EnvironmentSettings) => DoctorServices }): Promise<DoctorReport> {
  const { env, store } = input;
  const settings = await readEnvironmentSettings(store, env);
  if (settings === undefined) throw agentXError("CONFIG_INVALID", `environment ${env} is not installed in this account and region; check --env and --region`);
  if (settings.naming !== "environment") throw agentXError("CONFIG_INVALID", `agentx doctor checks environments installed with agentx init; ${env} uses the legacy stack names`);
  const notes: DoctorCheck[] = [];
  const answers = await readInstallAnswers(store, env).catch((error: unknown) => { notes.push(check("stacks", "install answers", "warn", plainMessage(error))); return undefined; });
  const progress = await readInstallProgress(store, env).catch((error: unknown) => { notes.push(check("stacks", "install progress", "warn", plainMessage(error))); return undefined; });
  const context: DoctorContext = { env, settings, answers, progress, services: input.services(settings) };
  const checks = [...notes];
  for (const [group, run] of GROUPS) checks.push(...await guarded(group, () => run(context)));
  return doctorReport(settings, checks);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/contract/doctor-run.test.ts tests/contract/doctor-stacks.test.ts tests/contract/doctor-services.test.ts tests/contract/doctor-connectors.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/doctor/account.ts packages/cli/src/doctor/run.ts tests/contract/doctor-run.test.ts
git commit -m "feat(doctor): model, alert, budget, capacity and sign-in checks; run every group"
```

### Task 9: The `doctor` command and its real services

**Files:**
- Modify: `packages/cli/src/init/release-fetch.ts` (`readReleaseManifest`)
- Create: `packages/cli/src/doctor/aws.ts`, `packages/cli/src/doctor/cli.ts`
- Modify: `packages/cli/src/day-two-actions.ts` (`DOCTOR_AWS_ACTIONS`), `packages/cli/src/main.ts`
- Test: `tests/contract/doctor-cli.test.ts`, `tests/contract/init-release-fetch.test.ts`, `tests/contract/day-two-permissions.test.ts`

**Interfaces:**
- Consumes: `runDoctor`, `reportText` (Tasks 5, 8); `releaseAssetUrls`, `releaseCacheDir`;
  `checkDeveloperSignIn` (spec 025); every real API factory (`slackWebApi`, `slackChannelApi`,
  `githubRestApi`, `vendorApi`, `awsAlertsApi`, `awsPrerequisiteChecks`, `secretsManagerInitSecrets`).
- Produces:

```ts
// init/release-fetch.ts
export function readReleaseManifest(input: { version: string; home: string; fetch: typeof fetch }): Promise<ReleaseManifest | undefined>;
// doctor/aws.ts
export function doctorStackReader(client: { send(command: unknown): Promise<unknown> }): DoctorServices["stacks"];
export function realDoctorServices(input: { settings: EnvironmentSettings; store: ParameterStore; fetch: typeof fetch; home: string; configDir: string; stderr: TextWriter }): DoctorServices;
// doctor/cli.ts
export interface DoctorCommandContext { overrides?: (settings: EnvironmentSettings) => DoctorServices; parameterStore: (region?: string) => ParameterStore; fetch: typeof fetch; home: string; stdout: TextWriter; stderr: TextWriter }
export function registerDoctorCommand(program: Command, context: DoctorCommandContext): void;
// day-two-actions.ts
export const DOCTOR_AWS_ACTIONS: readonly string[];
// main.ts CliDependencies gains: doctor?: { store?: ParameterStore; services?: (settings: EnvironmentSettings) => DoctorServices }
```

- [ ] **Step 1: Write the failing tests**

Add to `tests/contract/init-release-fetch.test.ts`:

```ts
import { readReleaseManifest } from "../../packages/cli/src/init/release-fetch.js";

describe("readReleaseManifest (doctor's release check)", () => {
  const manifest = { schemaVersion: 1, version: "1.2.3", gitCommit: "a".repeat(40), environmentPlaceholder: "qqenv-placeholderqq", templates: [], packages: [], images: {} };

  it("reads the cached release.json without downloading", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentx-manifest-"));
    await mkdir(join(home, ".agentx", "releases", "1.2.3"), { recursive: true });
    await writeFile(join(home, ".agentx", "releases", "1.2.3", "release.json"), JSON.stringify(manifest));
    const fetched: string[] = [];
    const found = await readReleaseManifest({ version: "1.2.3", home, fetch: (async (url: string) => { fetched.push(url); return new Response("", { status: 500 }); }) as never });
    expect(found?.version).toBe("1.2.3");
    expect(fetched).toEqual([]);
  });

  it("downloads the published release.json, and answers undefined for anything unreadable", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentx-manifest-"));
    const ok = await readReleaseManifest({ version: "1.2.3", home, fetch: (async () => new Response(JSON.stringify(manifest), { status: 200 })) as never });
    expect(ok?.version).toBe("1.2.3");
    expect(await readReleaseManifest({ version: "1.2.3", home, fetch: (async () => new Response("", { status: 404 })) as never })).toBeUndefined();
    expect(await readReleaseManifest({ version: "1.2.3", home, fetch: (async () => new Response("not json", { status: 200 })) as never })).toBeUndefined();
    expect(await readReleaseManifest({ version: "1.2.4", home, fetch: (async () => new Response(JSON.stringify(manifest), { status: 200 })) as never })).toBeUndefined();
    expect(await readReleaseManifest({ version: "unversioned", home, fetch: (async () => { throw new Error("no call expected"); }) as never })).toBeUndefined();
  });
});
```

(Import `mkdir`, `mkdtemp`, `writeFile`, `tmpdir`, `join` if the file does not already.)

Create `tests/contract/doctor-cli.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { doctorStackReader } from "../../packages/cli/src/doctor/aws.js";
import { writeEnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import { executeCli } from "../../packages/cli/src/main.js";
import { doctorServices, SETTINGS } from "../support/doctor-fakes.js";
import { fakeSlackApi } from "../support/init-fakes.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: { write: (text: string) => out.push(text) }, stderr: { write: (text: string) => err.push(text) } };
}

async function seeded(): Promise<MemoryParameterStore> {
  const store = new MemoryParameterStore();
  await writeEnvironmentSettings(store, SETTINGS);
  return store;
}

describe("agentx doctor", () => {
  it("prints every check and exits 0 when nothing fails", async () => {
    const io = capture();
    const code = await executeCli(["--env", "staging", "doctor"], { ...io, doctor: { store: await seeded(), services: () => doctorServices() } });
    expect(code).toBe(0);
    expect(io.out.join("")).toContain("agentx doctor: environment staging (release 1.2.3, templates engine, us-east-1)");
  });

  it("exits non-zero when a check fails, naming how many (FR-051)", async () => {
    const io = capture();
    const services = () => doctorServices({ slackApi: fakeSlackApi({ authTest: async () => ({ ok: false, error: "invalid_auth" }) }) });
    const code = await executeCli(["--env", "staging", "doctor"], { ...io, doctor: { store: await seeded(), services } });
    expect(code).toBe(2);
    expect(io.out.join("")).toContain("FAIL  slack       bot token: Slack refused the bot token (invalid_auth)");
    expect(io.err.join("")).toContain("1 doctor check failed; fix what each one names, then run agentx doctor again");
  });

  it("prints machine-readable results with --json", async () => {
    const io = capture();
    await executeCli(["--env", "staging", "--json", "doctor"], { ...io, doctor: { store: await seeded(), services: () => doctorServices() } });
    const parsed = JSON.parse(io.out.join("")) as { ok: boolean; data: { env: string; failed: number; checks: unknown[] } };
    expect(parsed.data).toMatchObject({ env: "staging", failed: 0 });
    expect(parsed.data.checks.length).toBeGreaterThan(20);
  });
});

describe("doctorStackReader", () => {
  it("reads status, parameters, outputs and the last drift result, and answers undefined for a missing stack", async () => {
    const client = {
      async send(command: unknown) {
        const name = (command as DescribeStacksCommand).input.StackName;
        if (name === "agentx-staging-gone") throw Object.assign(new Error("Stack with id agentx-staging-gone does not exist"), { name: "ValidationError" });
        return { Stacks: [{ StackStatus: "UPDATE_COMPLETE", Parameters: [{ ParameterKey: "A", ParameterValue: "1" }], Outputs: [{ OutputKey: "B", OutputValue: "2" }], DriftInformation: { StackDriftStatus: "DRIFTED" } }] };
      },
    };
    const reader = doctorStackReader(client);
    expect(await reader.describe("agentx-staging-slack")).toEqual({ status: "UPDATE_COMPLETE", parameters: { A: "1" }, outputs: { B: "2" }, drift: "DRIFTED" });
    expect(await reader.describe("agentx-staging-gone")).toBeUndefined();
  });
});
```

Add to `tests/contract/day-two-permissions.test.ts`:

```ts
import { DOCTOR_AWS_ACTIONS } from "../../packages/cli/src/day-two-actions.js";

describe("doctor needs no permission beyond the operator role (SC-005)", () => {
  it.each(DOCTOR_AWS_ACTIONS.map((action) => [action]))("doctor: %s is allowed", (action) => {
    expect(allowed.has(action)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/contract/doctor-cli.test.ts tests/contract/init-release-fetch.test.ts tests/contract/day-two-permissions.test.ts`
Expected: FAIL: `readReleaseManifest`, `doctor/aws.js` and the `doctor` command do not exist.

- [ ] **Step 3: Implement**

In `packages/cli/src/init/release-fetch.ts`, add (import `ReleaseManifestSchema` and `type
ReleaseManifest` from `@agentx/contracts`):

```ts
/** A release's manifest: the local release cache when it holds that version, else the published
 * release.json (read-only, 15-second limit). Undefined when neither can be read, or when what was
 * read names another version: doctor then says it could not compare, and fails nothing. */
export async function readReleaseManifest(input: { version: string; home: string; fetch: typeof fetch }): Promise<ReleaseManifest | undefined> {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(input.version)) return undefined;
  let text = await readFile(join(releaseCacheDir(input.home, input.version), "release.json"), "utf8").catch(() => undefined);
  if (text === undefined) {
    try {
      const response = await input.fetch(releaseAssetUrls(input.version).manifest, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) return undefined;
      text = await response.text();
    } catch {
      return undefined;
    }
  }
  let json: unknown;
  try { json = JSON.parse(text); } catch { return undefined; }
  const parsed = ReleaseManifestSchema.safeParse(json);
  return parsed.success && parsed.data.version === input.version ? parsed.data : undefined;
}
```

Add to `packages/cli/src/day-two-actions.ts`:

```ts
export const DOCTOR_AWS_ACTIONS: readonly string[] = [
  "ssm:GetParameter", "ssm:GetParametersByPath",
  "cloudformation:DescribeStacks",
  "secretsmanager:GetSecretValue",
  "bedrock:InvokeModel",
  "servicequotas:GetServiceQuota", "ec2:DescribeAddresses",
  "sns:ListSubscriptionsByTopic", "budgets:ViewBudget",
];
```

Create `packages/cli/src/doctor/aws.ts`:

```ts
// agentx doctor's real services, built for the environment's own account and region. Every read here
// is one the operator role already allows (day-two-actions.ts's DOCTOR_AWS_ACTIONS).
import { BudgetsClient } from "@aws-sdk/client-budgets";
import { CloudFormationClient, DescribeStacksCommand, type Stack } from "@aws-sdk/client-cloudformation";
import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SNSClient } from "@aws-sdk/client-sns";
import { realCommandRunner } from "../deploy/commands.js";
import type { ParameterStore } from "../environments/parameter-store.js";
import type { EnvironmentSettings } from "../environments/settings.js";
import { secretsManagerInitSecrets } from "../init/context.js";
import { githubRestApi } from "../init/github-app.js";
import { awsPrerequisiteChecks } from "../init/prerequisites.js";
import type { TextWriter } from "../init/prompts.js";
import { readReleaseManifest } from "../init/release-fetch.js";
import { slackWebApi } from "../init/slack-app.js";
import { awsAlertsApi } from "../setup/alerts.js";
import { slackChannelApi } from "../setup/channel-add.js";
import { vendorApi } from "../setup/connectors/vendors.js";
import { checkDeveloperSignIn } from "../signin/check.js";
import type { DoctorServices, DoctorStack } from "./checks.js";

const pairs = (entries: Array<{ key?: string | undefined; value?: string | undefined }>) =>
  Object.fromEntries(entries.flatMap((entry) => (entry.key === undefined || entry.value === undefined ? [] : [[entry.key, entry.value]])));

export function doctorStackReader(client: { send(command: unknown): Promise<unknown> }): DoctorServices["stacks"] {
  return {
    async describe(stackName): Promise<DoctorStack | undefined> {
      let stack: Stack | undefined;
      try {
        stack = ((await client.send(new DescribeStacksCommand({ StackName: stackName }))) as { Stacks?: Stack[] }).Stacks?.[0];
      } catch (error) {
        if (error instanceof Error && error.name === "ValidationError" && /does not exist/.test(error.message)) return undefined;
        throw error;
      }
      if (stack === undefined) return undefined;
      return {
        status: stack.StackStatus ?? "UNKNOWN",
        parameters: pairs((stack.Parameters ?? []).map((entry) => ({ key: entry.ParameterKey, value: entry.ParameterValue }))),
        outputs: pairs((stack.Outputs ?? []).map((entry) => ({ key: entry.OutputKey, value: entry.OutputValue }))),
        ...(stack.DriftInformation?.StackDriftStatus === undefined ? {} : { drift: stack.DriftInformation.StackDriftStatus }),
      };
    },
  };
}

export function realDoctorServices(input: { settings: EnvironmentSettings; store: ParameterStore; fetch: typeof fetch; home: string; configDir: string; stderr: TextWriter }): DoctorServices {
  const { settings } = input;
  const region = { region: settings.region };
  const secrets = secretsManagerInitSecrets(new SecretsManagerClient(region));
  const slackApi = slackWebApi(input.fetch);
  return {
    secrets,
    stacks: doctorStackReader(new CloudFormationClient(region)),
    releaseManifest: (version) => readReleaseManifest({ version, home: input.home, fetch: input.fetch }),
    checks: awsPrerequisiteChecks({ region: settings.region, account: settings.account, store: input.store, runner: realCommandRunner(input.stderr), fetch: input.fetch }),
    slackApi,
    slackChannels: slackChannelApi(input.fetch),
    github: githubRestApi(input.fetch),
    vendors: vendorApi(input.fetch),
    // AWS Budgets is a global service answered in us-east-1, as init's alerts step uses it.
    alerts: awsAlertsApi({ sns: new SNSClient(region), cloudWatch: new CloudWatchClient(region), budgets: new BudgetsClient({ region: "us-east-1" }) }),
    fetch: input.fetch,
    configDir: input.configDir,
    signIn: (current) => checkDeveloperSignIn({ env: current.env, store: input.store, secrets, settings: current, fetch: input.fetch, slackApi }),
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  };
}
```

If init builds `BudgetsClient` with another region (read `init/commands.ts`'s `realSetupServices`),
use the same.

Create `packages/cli/src/doctor/cli.ts`:

```ts
// The `agentx doctor` command (FR-050, FR-051): prints every check, then exits non-zero when any
// failed. --json prints the whole report.
import { agentXError } from "@agentx/contracts";
import type { Command } from "commander";
import type { ParameterStore } from "../environments/parameter-store.js";
import type { EnvironmentSettings } from "../environments/settings.js";
import type { TextWriter } from "../init/prompts.js";
import { formatSuccess } from "../output.js";
import { realDoctorServices } from "./aws.js";
import { reportText, type DoctorServices } from "./checks.js";
import { runDoctor } from "./run.js";

export interface DoctorCommandContext {
  store?: ParameterStore;
  services?: (settings: EnvironmentSettings) => DoctorServices;
  parameterStore: (region?: string) => ParameterStore;
  fetch: typeof fetch;
  home: string;
  stdout: TextWriter;
  stderr: TextWriter;
}

export function registerDoctorCommand(program: Command, context: DoctorCommandContext): void {
  program
    .command("doctor")
    .description("check every piece of an environment and say what is wrong and how to fix it; exits non-zero when a check fails (operator role)")
    .option("--region <region>", "AWS region of the environment; defaults to your AWS configuration")
    .action(async (options: { region?: string }, command: Command) => {
      const globals = command.optsWithGlobals<{ env: string; json: boolean; configDir: string }>();
      const store = context.store ?? context.parameterStore(options.region);
      const report = await runDoctor({
        env: globals.env, store,
        services: context.services ?? ((settings) => realDoctorServices({ settings, store, fetch: context.fetch, home: context.home, configDir: globals.configDir, stderr: context.stderr })),
      });
      context.stdout.write(globals.json ? formatSuccess(report, true) : reportText(report));
      if (report.failed > 0) {
        throw agentXError("CONFIG_INVALID", `${report.failed} doctor ${report.failed === 1 ? "check" : "checks"} failed; fix what each one names, then run agentx doctor again`);
      }
    });
}
```

In `packages/cli/src/main.ts`, add to `CliDependencies`:

```ts
  /** `agentx doctor` overrides, for tests: never touch AWS or a vendor. */
  doctor?: { store?: ParameterStore; services?: (settings: EnvironmentSettings) => DoctorServices };
```

and register after the config commands:

```ts
  registerDoctorCommand(program, {
    ...(dependencies.doctor?.store === undefined ? {} : { store: dependencies.doctor.store }),
    ...(dependencies.doctor?.services === undefined ? {} : { services: dependencies.doctor.services }),
    parameterStore, fetch: services.fetchImplementation, home, stdout: services.stdout, stderr: services.stderr,
  });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/contract/doctor-cli.test.ts tests/contract/init-release-fetch.test.ts tests/contract/day-two-permissions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/init/release-fetch.ts packages/cli/src/doctor/aws.ts packages/cli/src/doctor/cli.ts packages/cli/src/day-two-actions.ts packages/cli/src/main.ts tests/contract/doctor-cli.test.ts tests/contract/init-release-fetch.test.ts tests/contract/day-two-permissions.test.ts
git commit -m "feat(cli): agentx doctor with --json and a non-zero exit on failure (FR-050, FR-051)"
```

### Task 10: `upgrade`'s answers, target release, direction and notes

**Files:**
- Create: `packages/cli/src/upgrade/answers.ts`, `packages/cli/src/upgrade/target.ts`
- Test: `tests/contract/upgrade-answers.test.ts`

Depends on question 3 (an older release is refused).

**Interfaces:**
- Consumes: `EnvironmentSettings`, `StackReader` (adopt.ts), `DeployAnswers`, `RELEASE_REPOSITORY`.
- Produces:

```ts
// upgrade/answers.ts
export function upgradeAnswers(input: { settings: EnvironmentSettings; stacks: StackReader; images?: { worker?: string; slack?: string } }): Promise<DeployAnswers>;
// upgrade/target.ts
export function compareVersions(a: string, b: string): number;
export function upgradeDirection(env: string, current: string, target: string): "same" | "newer";
export interface ReleaseNotes { text: string; url: string }
export function releaseNotes(input: { fetch: typeof fetch; version: string }): Promise<ReleaseNotes | undefined>;
export function notesText(notes: ReleaseNotes | undefined, version: string): string;
```

- [ ] **Step 1: Write the failing test**

Create `tests/contract/upgrade-answers.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { StackDescription } from "../../packages/cli/src/environments/adopt.js";
import { upgradeAnswers } from "../../packages/cli/src/upgrade/answers.js";
import { compareVersions, notesText, releaseNotes, upgradeDirection } from "../../packages/cli/src/upgrade/target.js";
import { SETTINGS } from "../support/doctor-fakes.js";

const KEY_ARN = "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/github-app-AbCdEf";
const stacks = (parameters: Record<string, Record<string, string>>) => ({
  async describe(name: string): Promise<StackDescription | undefined> {
    return parameters[name] === undefined ? undefined : { status: "UPDATE_COMPLETE", outputs: {}, parameters: parameters[name]! };
  },
});
const controlPlane = { GitHubAppId: "123", GitHubAppPrivateKeySecretArn: KEY_ARN, GitHubAppCredentialRef: "github-agentx-sdlc", CallbackSigningKey: "****", AdminClaim: "cognito:groups", AdminValues: "[\"agentx-admin\"]" };

describe("upgradeAnswers: everything from the environment itself, nothing asked", () => {
  it("builds a Cognito environment's answers from its settings and deployed stacks", async () => {
    const answers = await upgradeAnswers({ settings: SETTINGS, stacks: stacks({ "agentx-staging-control-plane": controlPlane, "agentx-staging-access": { OperatorPrincipalArn: "arn:aws:iam::123456789012:role/ops" } }) });
    expect(answers).toEqual({
      env: "staging", region: "us-east-1", account: "123456789012", models: SETTINGS.models, identity: { mode: "cognito" },
      github: { appId: "123", privateKeySecretArn: KEY_ARN, credentialRef: "github-agentx-sdlc" },
      operatorPrincipalArn: "arn:aws:iam::123456789012:role/ops",
    });
    // Never the callback signing key: deployEnvironment reads it from Secrets Manager itself.
    expect(JSON.stringify(answers)).not.toContain("****");
  });

  it("carries your own OIDC provider's admin claim and values from the control-plane stack", async () => {
    const oidc = { ...SETTINGS, identity: { mode: "oidc" as const, issuer: "https://idp.example.com", audience: "agentx", clientId: "cli" } };
    const answers = await upgradeAnswers({ settings: oidc, stacks: stacks({ "agentx-staging-control-plane": { ...controlPlane, AdminClaim: "groups", AdminValues: "[\"eng-admins\"]" } }) });
    expect(answers.identity).toEqual({ mode: "oidc", issuer: "https://idp.example.com", audience: "agentx", clientId: "cli", adminClaim: "groups", adminValues: ["eng-admins"] });
  });

  it("passes the testing-only image overrides, and the permission boundary from the settings", async () => {
    const settings = { ...SETTINGS, access: { artifactBucket: "b", cloudFormationRoleArn: "arn:aws:iam::123456789012:role/cfn", operatorRoleArn: "arn:aws:iam::123456789012:role/op", pullThroughPrefix: "agentx-staging", permissionsBoundaryArn: "arn:aws:iam::123456789012:policy/company-boundary" } };
    const answers = await upgradeAnswers({ settings, stacks: stacks({ "agentx-staging-control-plane": controlPlane }), images: { worker: `w@sha256:${"b".repeat(64)}` } });
    expect(answers.images).toEqual({ worker: `w@sha256:${"b".repeat(64)}` });
    expect(answers.permissionsBoundaryArn).toBe("arn:aws:iam::123456789012:policy/company-boundary");
  });

  it("refuses when the control-plane stack is gone or lacks the GitHub App", async () => {
    await expect(upgradeAnswers({ settings: SETTINGS, stacks: stacks({}) })).rejects.toThrow("stack agentx-staging-control-plane does not exist; agentx doctor says what else is missing");
    await expect(upgradeAnswers({ settings: SETTINGS, stacks: stacks({ "agentx-staging-control-plane": { GitHubAppId: "" } }) })).rejects.toThrow("stack agentx-staging-control-plane has no GitHubAppId parameter");
  });
});

describe("the target release", () => {
  it("orders versions, with a prerelease before its release", () => {
    expect(compareVersions("1.2.3", "1.10.0")).toBeLessThan(0);
    expect(compareVersions("2.0.0", "1.99.99")).toBeGreaterThan(0);
    expect(compareVersions("1.3.0-rc.1", "1.3.0")).toBeLessThan(0);
    expect(compareVersions("1.3.0", "1.3.0")).toBe(0);
  });

  it("allows the same release (a re-run) and a newer one, and refuses an older one (question 3)", () => {
    expect(upgradeDirection("staging", "1.2.3", "1.2.3")).toBe("same");
    expect(upgradeDirection("staging", "1.2.3", "1.3.0")).toBe("newer");
    expect(() => upgradeDirection("staging", "1.3.0", "1.2.3")).toThrow("release 1.2.3 is older than 1.3.0, which environment staging runs; agentx upgrade never moves an environment back");
  });

  it("reads the release's notes from GitHub, and says where to look when it cannot", async () => {
    const fetched: string[] = [];
    const notes = await releaseNotes({ version: "1.3.0", fetch: (async (url: string) => { fetched.push(url); return new Response(JSON.stringify({ body: "Fixes.\nMore fixes.", html_url: "https://github.com/PrepLabsAI/AgentX/releases/tag/v1.3.0" }), { status: 200 }); }) as never });
    expect(fetched).toEqual(["https://api.github.com/repos/PrepLabsAI/AgentX/releases/tags/v1.3.0"]);
    expect(notesText(notes, "1.3.0")).toBe("Release notes for 1.3.0:\n  Fixes.\n  More fixes.");
    expect(await releaseNotes({ version: "1.3.0", fetch: (async () => new Response("", { status: 404 })) as never })).toBeUndefined();
    expect(notesText(undefined, "1.3.0")).toBe("No release notes could be read for 1.3.0; see https://github.com/PrepLabsAI/AgentX/releases/tag/v1.3.0");
  });

  it("shows at most 40 lines of notes, then where the rest are", () => {
    const text = notesText({ text: Array.from({ length: 50 }, (_, index) => `line ${index + 1}`).join("\n"), url: "https://example.test/notes" }, "1.3.0");
    expect(text.split("\n")).toHaveLength(42);
    expect(text.split("\n").at(-1)).toBe("  (10 more lines at https://example.test/notes)");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/contract/upgrade-answers.test.ts`
Expected: FAIL: the modules do not exist.

- [ ] **Step 3: Implement**

Create `packages/cli/src/upgrade/answers.ts`:

```ts
// agentx upgrade's deploy answers, from the environment itself: the settings (FR-003's source of
// truth) for account, region, models and identity; the deployed stacks' own parameters for what the
// settings do not hold (the GitHub App, your own OIDC provider's admin claim, the operator
// principal). Operator-set parameters are carried by deployEnvironment (Task 1), not here, and the
// callback signing key comes from Secrets Manager.
import { agentXError } from "@agentx/contracts";
import type { DeployAnswers } from "../deploy/deploy-environment.js";
import type { StackReader } from "../environments/adopt.js";
import type { EnvironmentSettings } from "../environments/settings.js";

export async function upgradeAnswers(input: { settings: EnvironmentSettings; stacks: StackReader; images?: { worker?: string; slack?: string } }): Promise<DeployAnswers> {
  const { settings } = input;
  const controlPlaneName = settings.stacks["control-plane"];
  const controlPlane = await input.stacks.describe(controlPlaneName);
  if (controlPlane === undefined) throw agentXError("CONFIG_INVALID", `stack ${controlPlaneName} does not exist; agentx doctor says what else is missing`);
  const parameter = (name: string): string => {
    const value = controlPlane.parameters[name];
    if (value === undefined || value === "") throw agentXError("CONFIG_INVALID", `stack ${controlPlaneName} has no ${name} parameter; run agentx doctor, and agentx init --resume if the install never finished`);
    return value;
  };
  let identity: DeployAnswers["identity"];
  if (settings.identity.mode === "cognito") {
    identity = { mode: "cognito" };
  } else {
    let adminValues: unknown;
    try { adminValues = JSON.parse(parameter("AdminValues")); } catch { adminValues = undefined; }
    if (!Array.isArray(adminValues) || adminValues.length === 0 || !adminValues.every((value) => typeof value === "string" && value !== "")) {
      throw agentXError("CONFIG_INVALID", `stack ${controlPlaneName}'s AdminValues parameter is not a list of admin values; fix it in the CloudFormation console, then run agentx upgrade again`);
    }
    identity = { mode: "oidc", issuer: settings.identity.issuer, audience: settings.identity.audience, clientId: settings.identity.clientId, adminClaim: parameter("AdminClaim"), adminValues: adminValues as string[] };
  }
  const credentialRef = controlPlane.parameters.GitHubAppCredentialRef;
  const access = settings.stacks.access === undefined ? undefined : await input.stacks.describe(settings.stacks.access);
  const operatorPrincipalArn = access?.parameters.OperatorPrincipalArn;
  const images = input.images === undefined || (input.images.worker === undefined && input.images.slack === undefined) ? undefined : {
    ...(input.images.worker === undefined ? {} : { worker: input.images.worker }),
    ...(input.images.slack === undefined ? {} : { slack: input.images.slack }),
  };
  return {
    env: settings.env,
    region: settings.region,
    account: settings.account,
    models: settings.models,
    identity,
    github: { appId: parameter("GitHubAppId"), privateKeySecretArn: parameter("GitHubAppPrivateKeySecretArn"), ...(credentialRef === undefined || credentialRef === "" ? {} : { credentialRef }) },
    ...(settings.access?.permissionsBoundaryArn === undefined ? {} : { permissionsBoundaryArn: settings.access.permissionsBoundaryArn }),
    ...(operatorPrincipalArn === undefined || operatorPrincipalArn === "" ? {} : { operatorPrincipalArn }),
    ...(images === undefined ? {} : { images }),
  };
}
```

Create `packages/cli/src/upgrade/target.ts`:

```ts
// FR-042: which release an upgrade moves to, that it never moves back (question 3), and the
// release's notes.
import { agentXError } from "@agentx/contracts";
import { RELEASE_REPOSITORY } from "../init/release-fetch.js";

const MAX_NOTE_LINES = 40;

function parts(version: string): { numbers: number[]; pre: string | undefined } {
  const [core = "", ...pre] = version.split("-");
  return { numbers: core.split(".").map((part) => Number(part)), pre: pre.length === 0 ? undefined : pre.join("-") };
}

export function compareVersions(a: string, b: string): number {
  const left = parts(a);
  const right = parts(b);
  for (let index = 0; index < 3; index += 1) {
    const difference = (left.numbers[index] ?? 0) - (right.numbers[index] ?? 0);
    if (difference !== 0) return difference;
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === undefined) return 1;
  if (right.pre === undefined) return -1;
  return left.pre < right.pre ? -1 : 1;
}

export function upgradeDirection(env: string, current: string, target: string): "same" | "newer" {
  const order = compareVersions(current, target);
  if (order === 0) return "same";
  if (order < 0) return "newer";
  throw agentXError("CONFIG_INVALID", `release ${target} is older than ${current}, which environment ${env} runs; agentx upgrade never moves an environment back, because a newer release may have written data an older one cannot read. Upgrade to ${current} or later`);
}

export interface ReleaseNotes { text: string; url: string }

export async function releaseNotes(input: { fetch: typeof fetch; version: string }): Promise<ReleaseNotes | undefined> {
  try {
    const response = await input.fetch(`https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/tags/v${input.version}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "agentx-cli" }, signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { body?: unknown; html_url?: unknown };
    if (typeof body.body !== "string" || typeof body.html_url !== "string") return undefined;
    return { text: body.body, url: body.html_url };
  } catch {
    return undefined;
  }
}

export function notesText(notes: ReleaseNotes | undefined, version: string): string {
  if (notes === undefined) return `No release notes could be read for ${version}; see https://github.com/${RELEASE_REPOSITORY}/releases/tag/v${version}`;
  const lines = notes.text.replace(/\r\n/g, "\n").trimEnd().split("\n");
  const shown = lines.slice(0, MAX_NOTE_LINES).map((line) => `  ${line}`);
  const rest = lines.length - shown.length;
  return [`Release notes for ${version}:`, ...shown, ...(rest > 0 ? [`  (${rest} more lines at ${notes.url})`] : [])].join("\n");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/contract/upgrade-answers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/upgrade/answers.ts packages/cli/src/upgrade/target.ts tests/contract/upgrade-answers.test.ts
git commit -m "feat(upgrade): answers from the environment, the target release, never downgrading, and release notes"
```

### Task 11: `upgrade`'s change review, the replacement guard and `cdk diff`

**Files:**
- Create: `packages/cli/src/upgrade/review.ts`
- Modify: `packages/cli/src/deploy/cdk-engine.ts` (`cdkDiff`, a shared argument builder, `CommandRunner`'s optional `stderr`)
- Modify: `packages/cli/src/deploy/commands.ts` (`realCommandRunner` returns `stderr`)
- Test: `tests/contract/upgrade-review.test.ts`

**Interfaces:**
- Consumes: `ChangeSetChange`, `ConfirmFn`, `Ask` (commands.ts), `StackDeployer`, `DeployRequest`,
  `CDK_CONSTRUCT_IDS`, `CommandRunner`.
- Produces:

```ts
// upgrade/review.ts
export const DATA_RESOURCE_TYPES: ReadonlySet<string>;   // table, user pool, bucket, secret (FR-043)
export interface DataChange { logicalId: string; type: string; verb: "replace" | "delete" }
export interface ReviewedChanges { iam: ChangeSetChange[]; data: DataChange[]; other: ChangeSetChange[] }
export function reviewChanges(changes: ChangeSetChange[]): ReviewedChanges;
export function reviewLines(stackName: string, reviewed: ReviewedChanges): string[];
export function guardData(input: { stackName: string; data: DataChange[]; allowReplace: ReadonlySet<string>; yes: boolean; ask: Ask }): Promise<string | undefined>;  // a refusal, or undefined
export function upgradeConfirm(input: { write: (line: string) => void; ask: Ask; yes: boolean; allowReplace: ReadonlySet<string> }): { confirm: ConfirmFn; refusal(): string | undefined };
export function cdkDiffRisks(text: string): { data: DataChange[]; iam: boolean };
export function cdkReviewedDeployer(inner: StackDeployer, review: (request: DeployRequest) => Promise<void>): StackDeployer;
// cdk-engine.ts
export function cdkDiff(input: { runner: CommandRunner; source: string; env: string; region: string; identityMode: "cognito" | "oidc"; request: DeployRequest }): Promise<string>;
// CommandRunner.run resolves { stdout: string; stderr?: string }
```

- [ ] **Step 1: Write the failing test**

Create `tests/contract/upgrade-review.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { CommandRunner } from "../../packages/cli/src/deploy/cdk-engine.js";
import { cdkDiff } from "../../packages/cli/src/deploy/cdk-engine.js";
import type { DeployRequest, StackDeployer } from "../../packages/cli/src/deploy/deployer.js";
import { cdkDiffRisks, cdkReviewedDeployer, guardData, reviewChanges, reviewLines, upgradeConfirm } from "../../packages/cli/src/upgrade/review.js";

const change = (action: string, logicalId: string, type: string, replacement = "False") => ({ action, logicalId, type, replacement });
const answers = (...replies: string[]) => { const queue = [...replies]; return async () => queue.shift() ?? ""; };

describe("reviewing an upgrade's changes (FR-042, FR-043)", () => {
  it("calls out IAM changes, and replacing or deleting a table, user pool, bucket or secret", () => {
    const reviewed = reviewChanges([
      change("Modify", "WorkerRole", "AWS::IAM::Role"),
      change("Modify", "State", "AWS::DynamoDB::Table", "True"),
      change("Remove", "Artifacts", "AWS::S3::Bucket"),
      change("Modify", "UserPool", "AWS::Cognito::UserPool", "Conditional"),
      change("Modify", "SlackSecret", "AWS::SecretsManager::Secret", "False"),
      change("Modify", "Ingress", "AWS::Lambda::Function", "True"),
    ]);
    expect(reviewed.iam.map((entry) => entry.logicalId)).toEqual(["WorkerRole"]);
    expect(reviewed.data).toEqual([
      { logicalId: "State", type: "AWS::DynamoDB::Table", verb: "replace" },
      { logicalId: "Artifacts", type: "AWS::S3::Bucket", verb: "delete" },
      { logicalId: "UserPool", type: "AWS::Cognito::UserPool", verb: "replace" },
    ]);
    expect(reviewed.other.map((entry) => entry.logicalId)).toEqual(["SlackSecret", "Ingress"]);
    expect(reviewLines("agentx-staging-control-plane", reviewed)).toEqual([
      "Changes for agentx-staging-control-plane:",
      "  IAM changes:",
      "    Modify WorkerRole (AWS::IAM::Role)",
      "  Replaces or deletes data:",
      "    replace State (AWS::DynamoDB::Table)",
      "    delete Artifacts (AWS::S3::Bucket)",
      "    replace UserPool (AWS::Cognito::UserPool)",
      "  Other changes:",
      "    Modify SlackSecret (AWS::SecretsManager::Secret)",
      "    Modify Ingress (AWS::Lambda::Function) [replacement]",
    ]);
  });

  it("stops a data replacement under --yes unless --allow-replace names it", async () => {
    const data = [{ logicalId: "State", type: "AWS::DynamoDB::Table", verb: "replace" as const }];
    expect(await guardData({ stackName: "s", data, allowReplace: new Set(), yes: true, ask: answers() })).toBe("upgrade stopped: s would replace State (AWS::DynamoDB::Table) and lose its data; nothing in s changed. If you accept that, run agentx upgrade again with --allow-replace State");
    expect(await guardData({ stackName: "s", data, allowReplace: new Set(["State"]), yes: true, ask: answers() })).toBeUndefined();
  });

  it("asks for the resource's name to be typed, and stops on anything else", async () => {
    const data = [{ logicalId: "UserPool", type: "AWS::Cognito::UserPool", verb: "replace" as const }];
    expect(await guardData({ stackName: "s", data, allowReplace: new Set(), yes: false, ask: answers("UserPool") })).toBeUndefined();
    expect(await guardData({ stackName: "s", data, allowReplace: new Set(), yes: false, ask: answers("userpool") })).toContain("upgrade stopped: s would replace UserPool");
  });

  it("confirms a change set: y applies, anything else declines with the reason kept", async () => {
    const lines: string[] = [];
    const yes = upgradeConfirm({ write: (line) => lines.push(line), ask: answers("y"), yes: false, allowReplace: new Set() });
    expect(await yes.confirm({ stackName: "s", changes: [change("Modify", "Fn", "AWS::Lambda::Function")] })).toBe(true);
    expect(lines[0]).toBe("Changes for s:");
    const no = upgradeConfirm({ write: () => undefined, ask: answers("n"), yes: false, allowReplace: new Set() });
    expect(await no.confirm({ stackName: "s", changes: [] })).toBe(false);
    expect(no.refusal()).toBe("upgrade stopped before s: nothing in it changed. Stacks upgraded before it keep the new release; run agentx upgrade again to continue");
  });
});

describe("the cdk engine's review: cdk diff (FR-042)", () => {
  const diff = [
    "Stack agentx-staging-control-plane",
    "IAM Statement Changes",
    "┌───┬──────────┐",
    "Resources",
    "[~] AWS::DynamoDB::Table State StateABC123 replace",
    " └─ [~] KeySchema (requires replacement)",
    "[-] AWS::S3::Bucket Artifacts Artifacts9F8E7D destroy",
    "[~] AWS::Lambda::Function Ingress IngressFn may be replaced",
    "[+] AWS::SecretsManager::Secret NewSecret NewSecretXYZ",
  ].join("\n");

  it("finds data replacements and deletions, and IAM changes, in cdk diff's output", () => {
    expect(cdkDiffRisks(diff)).toEqual({
      iam: true,
      data: [{ logicalId: "StateABC123", type: "AWS::DynamoDB::Table", verb: "replace" }, { logicalId: "Artifacts9F8E7D", type: "AWS::S3::Bucket", verb: "delete" }],
    });
    expect(cdkDiffRisks("Resources\n[~] AWS::Lambda::Function Fn FnABC")).toEqual({ iam: false, data: [] });
  });

  it("runs cdk diff with the stack's parameters, redacting the signing key everywhere", async () => {
    const calls: Array<{ args: string[]; display: string }> = [];
    const runner: CommandRunner = { async run(_command, args, options) { calls.push({ args, display: options.display }); return { stdout: "", stderr: `diff with ${"s".repeat(43)}` }; } };
    const request: DeployRequest = { part: "control-plane", stackName: "agentx-staging-control-plane", parameters: { CallbackSigningKey: "s".repeat(43), GitHubAppId: "123" }, terminationProtection: false };
    const text = await cdkDiff({ runner, source: "/src", env: "staging", region: "us-east-1", identityMode: "cognito", request });
    expect(calls[0]!.args.slice(0, 4)).toEqual(["--no-install", "cdk", "diff", "AgentXControlPlane"]);
    expect(calls[0]!.args).toContain("--no-change-set");
    expect(calls[0]!.args).toContain("agentx-staging-control-plane:GitHubAppId=123");
    expect(calls[0]!.display).not.toContain("s".repeat(43));
    expect(text).toBe("diff with <redacted>");
  });

  it("reviews each stack before the cdk engine deploys it, and deploys nothing after a refusal", async () => {
    const deployed: string[] = [];
    const inner: StackDeployer = { async deploy(request) { deployed.push(request.stackName); return {}; }, async outputs() { return undefined; } };
    const reviewed = cdkReviewedDeployer(inner, async (request) => { if (request.part === "control-plane") throw new Error("stopped"); });
    await reviewed.deploy({ part: "runtime", stackName: "agentx-staging-runtime", parameters: {}, terminationProtection: true });
    await expect(reviewed.deploy({ part: "control-plane", stackName: "agentx-staging-control-plane", parameters: {}, terminationProtection: false })).rejects.toThrow("stopped");
    expect(deployed).toEqual(["agentx-staging-runtime"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/contract/upgrade-review.test.ts`
Expected: FAIL: `upgrade/review.js` and `cdkDiff` do not exist.

- [ ] **Step 3: Implement**

Create `packages/cli/src/upgrade/review.ts`:

```ts
// FR-042 and FR-043: every change an upgrade makes, with IAM changes called out separately, and a
// stop before replacing or deleting a table, user pool, bucket or secret unless the operator types
// its name (or passes --allow-replace <logical-id>).
import type { Ask, ConfirmFn } from "../deploy/commands.js";
import type { ChangeSetChange, DeployRequest, StackDeployer } from "../deploy/deployer.js";

export const DATA_RESOURCE_TYPES: ReadonlySet<string> = new Set(["AWS::DynamoDB::Table", "AWS::Cognito::UserPool", "AWS::S3::Bucket", "AWS::SecretsManager::Secret"]);

export interface DataChange { logicalId: string; type: string; verb: "replace" | "delete" }
export interface ReviewedChanges { iam: ChangeSetChange[]; data: DataChange[]; other: ChangeSetChange[] }

const replaces = (replacement: string) => replacement === "True" || replacement === "Conditional";

export function reviewChanges(changes: ChangeSetChange[]): ReviewedChanges {
  const reviewed: ReviewedChanges = { iam: [], data: [], other: [] };
  for (const change of changes) {
    if (change.type.startsWith("AWS::IAM::")) reviewed.iam.push(change);
    else if (DATA_RESOURCE_TYPES.has(change.type) && (change.action === "Remove" || replaces(change.replacement))) {
      reviewed.data.push({ logicalId: change.logicalId, type: change.type, verb: change.action === "Remove" ? "delete" : "replace" });
    } else reviewed.other.push(change);
  }
  return reviewed;
}

const changeLine = (change: ChangeSetChange) => `    ${change.action} ${change.logicalId} (${change.type})${change.replacement === "True" ? " [replacement]" : change.replacement === "Conditional" ? " [replacement: conditional]" : ""}`;

export function reviewLines(stackName: string, reviewed: ReviewedChanges): string[] {
  return [
    `Changes for ${stackName}:`,
    ...(reviewed.iam.length === 0 ? [] : ["  IAM changes:", ...reviewed.iam.map(changeLine)]),
    ...(reviewed.data.length === 0 ? [] : ["  Replaces or deletes data:", ...reviewed.data.map((entry) => `    ${entry.verb} ${entry.logicalId} (${entry.type})`)]),
    ...(reviewed.other.length === 0 ? [] : ["  Other changes:", ...reviewed.other.map(changeLine)]),
    ...(reviewed.iam.length + reviewed.data.length + reviewed.other.length === 0 ? ["  no resource changes"] : []),
  ];
}

/** FR-043: undefined when every data change is accepted; otherwise the refusal to report. */
export async function guardData(input: { stackName: string; data: DataChange[]; allowReplace: ReadonlySet<string>; yes: boolean; ask: Ask }): Promise<string | undefined> {
  for (const entry of input.data) {
    if (input.allowReplace.has(entry.logicalId)) continue;
    const refusal = `upgrade stopped: ${input.stackName} would ${entry.verb} ${entry.logicalId} (${entry.type}) and lose its data; nothing in ${input.stackName} changed. If you accept that, run agentx upgrade again with --allow-replace ${entry.logicalId}`;
    if (input.yes) return refusal;
    const typed = await input.ask(`${input.stackName} would ${entry.verb} ${entry.logicalId} (${entry.type}), losing its data. Type ${entry.logicalId} to accept, or anything else to stop: `);
    if (typed.trim() !== entry.logicalId) return refusal;
  }
  return undefined;
}

/** The templates engine's confirmation. A refusal returns false, so the engine deletes its change set,
 * and keeps the reason for agentx upgrade to report instead of the engine's generic words. */
export function upgradeConfirm(input: { write: (line: string) => void; ask: Ask; yes: boolean; allowReplace: ReadonlySet<string> }): { confirm: ConfirmFn; refusal(): string | undefined } {
  let refusal: string | undefined;
  return {
    refusal: () => refusal,
    async confirm({ stackName, changes }) {
      const reviewed = reviewChanges(changes);
      for (const line of reviewLines(stackName, reviewed)) input.write(line);
      refusal = await guardData({ stackName, data: reviewed.data, allowReplace: input.allowReplace, yes: input.yes, ask: input.ask });
      if (refusal !== undefined) return false;
      if (input.yes) return true;
      if (/^y(es)?$/i.test((await input.ask(`Apply these changes to ${stackName}? [y/N] `)).trim())) return true;
      refusal = `upgrade stopped before ${stackName}: nothing in it changed. Stacks upgraded before it keep the new release; run agentx upgrade again to continue`;
      return false;
    },
  };
}

// cdk diff's resource lines: "[~] AWS::DynamoDB::Table State StateABC123 replace". The third word is
// the construct path's last part, the fourth the logical id. Checked against the pinned CDK's output
// in the live check (Task 20).
const RESOURCE_LINE = /^\[([-~+])\]\s+(AWS::[A-Za-z0-9:]+)\s+\S+\s+(\S+)(.*)$/;

export function cdkDiffRisks(text: string): { data: DataChange[]; iam: boolean } {
  const data: DataChange[] = [];
  let iam = /IAM Statement Changes|IAM Policy Changes/.test(text);
  for (const line of text.split("\n")) {
    const match = RESOURCE_LINE.exec(line.trim());
    if (match === null) continue;
    const [, mark, type = "", logicalId = "", rest = ""] = match;
    if (type.startsWith("AWS::IAM::")) iam = true;
    if (!DATA_RESOURCE_TYPES.has(type)) continue;
    if (mark === "-") data.push({ logicalId, type, verb: "delete" });
    else if (mark === "~" && /replace/.test(rest)) data.push({ logicalId, type, verb: "replace" });
  }
  return { data, iam };
}

/** The cdk engine has no change set to confirm: each stack is reviewed (cdk diff) just before it deploys. */
export function cdkReviewedDeployer(inner: StackDeployer, review: (request: DeployRequest) => Promise<void>): StackDeployer {
  return {
    async deploy(request) {
      await review(request);
      return inner.deploy(request);
    },
    outputs: (stackName) => inner.outputs(stackName),
  };
}
```

In `packages/cli/src/deploy/cdk-engine.ts`:
- change `CommandRunner.run`'s result to `Promise<{ stdout: string; stderr?: string }>` (doc: "stderr: the child's captured standard error, unredacted; only our own code reads it, and redacts it before showing it");
- move the argument building out of `cdkDeployer.deploy` into:

```ts
/** The cdk command's arguments for one stack (deploy or diff), with each parameter by physical stack name. */
function cdkArguments(input: { env: string; region: string; identityMode: "cognito" | "oidc" }, request: DeployRequest, command: "deploy" | "diff"): string[] {
  const args = ["--no-install", "cdk", command, CDK_CONSTRUCT_IDS[request.part], "--exclusively", "--app", "node infra/dist/bin/agentx.js", "-c", `agentxEnv=${input.env}`, "-c", `agentxRegion=${input.region}`];
  if (input.identityMode === "oidc") args.push("-c", "agentxIdentity=oidc");
  for (const [key, value] of Object.entries(request.parameters)) args.push("--parameters", `${request.stackName}:${key}=${value}`);
  return args;
}
```

  and make `deploy` build `const args = [...cdkArguments(input, request, "deploy"), "--require-approval", "never", "--outputs-file", outputsFile, ...(request.roleArn === undefined ? [] : ["--role-arn", request.roleArn])];`.
  Keep every existing test in `tests/contract/cdk-engine.test.ts` passing unchanged; if one pins the
  exact argument order, order the pushes to match it rather than changing the test.
- add:

```ts
/** FR-042: `cdk diff` for one stack, against the deployed template (no change set, so nothing is
 * written to AWS). cdk prints the diff on stderr; the text returned has every secret redacted. */
export async function cdkDiff(input: { runner: CommandRunner; source: string; env: string; region: string; identityMode: "cognito" | "oidc"; request: DeployRequest }): Promise<string> {
  const args = [...cdkArguments(input, input.request, "diff"), "--no-change-set"];
  const redact = (text: string) => redactSecrets(text, input.request.parameters);
  const display = ["npx", ...args.map((arg) => displayArg(redact(arg)))].join(" ");
  const result = await input.runner.run("npx", args, { cwd: input.source, display, redact, quiet: true });
  return redact([result.stdout, result.stderr ?? ""].filter((part) => part !== "").join("\n"));
}
```

In `packages/cli/src/deploy/commands.ts`, `realCommandRunner`'s `close` handler resolves
`resolvePromise({ stdout, stderr: stderrBuffer })`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/contract/upgrade-review.test.ts tests/contract/cdk-engine.test.ts tests/contract/deploy-cli.test.ts tests/contract/init-release-fetch.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/upgrade/review.ts packages/cli/src/deploy/cdk-engine.ts packages/cli/src/deploy/commands.ts tests/contract/upgrade-review.test.ts
git commit -m "feat(upgrade): change review with IAM called out, the data replacement guard, and cdk diff (FR-042, FR-043)"
```

### Task 12: `agentx upgrade`

**Files:**
- Create: `packages/cli/src/upgrade/run.ts`, `packages/cli/src/upgrade/cli.ts`
- Modify: `packages/cli/src/day-two-actions.ts` (`UPGRADE_AWS_ACTIONS`), `packages/cli/src/main.ts`
- Test: `tests/contract/upgrade-run.test.ts`, `tests/contract/day-two-permissions.test.ts`

Depends on questions 3 (older releases) and 9 (the access stack under the operator role).

**Interfaces:**
- Consumes: `upgradeAnswers`, `upgradeDirection`, `notesText`, `ReleaseNotes` (Task 10);
  `upgradeConfirm`, `cdkReviewedDeployer`, `cdkDiffRisks`, `guardData` (Task 11);
  `deployEnvironment`, `templateParameterNames`, `OPERATOR_PARAMETERS` (Task 1); `CONFIG_KEYS`
  (Task 3); `runDoctor`, `reportText`, `realDoctorServices` (Tasks 8, 9); `isOperatorRole`
  (init/commands.ts); `prepareDeployment`, `progressLine`, `readlineAsk`; `fetchRelease`,
  `loadRelease`; `upgradeOrder`.
- Produces:

```ts
export interface UpgradeOptions { env: string; to?: string; releaseDir?: string; source?: string; yes: boolean; allowReplace: string[]; exportDir?: string; images?: { worker?: string; slack?: string } }
export interface UpgradeDependencies {
  store: ParameterStore; stacks: StackReader; cloudFormation: { send(command: unknown): Promise<unknown> }; identity: CallerIdentity;
  loadRelease(input: { releaseDir?: string; version?: string }): Promise<LoadedRelease>;
  notes(version: string): Promise<ReleaseNotes | undefined>;
  prepare(input: { settings: EnvironmentSettings; release: LoadedRelease; source?: string }): Promise<PreparedDeployment>;
  cdkDiff(request: DeployRequest, settings: EnvironmentSettings, source: string): Promise<string>;
  ask: Ask; isInteractive(): boolean;
  doctor(env: string): Promise<DoctorReport>;
  write: (line: string) => void; now: () => number;
  cliVersion: string | undefined;
}
export interface UpgradeResult { env: string; from: string; to: string; parts: DeployPart[]; exported?: string; doctor?: { failed: number; warned: number } }
export function droppedConfigKeys(input: { release: LoadedRelease; env: string; parts: DeployPart[]; stacks: StackReader }): Promise<Array<{ key: string; value: string }>>;
export function accessChanged(input: { cloudFormation: { send(command: unknown): Promise<unknown> }; stackName: string; release: LoadedRelease; region: string; env: string }): Promise<boolean>;
export function runUpgrade(options: UpgradeOptions, deps: UpgradeDependencies): Promise<UpgradeResult>;
// day-two-actions.ts
export const UPGRADE_AWS_ACTIONS: readonly string[];
// main.ts CliDependencies gains: upgrade?: Partial<UpgradeDependencies>
```

- [ ] **Step 1: Write the failing test**

Create `tests/contract/upgrade-run.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { GetTemplateCommand } from "@aws-sdk/client-cloudformation";
import type { ChangeSetChange, StackDeployer } from "../../packages/cli/src/deploy/deployer.js";
import type { LoadedRelease } from "../../packages/cli/src/deploy/release.js";
import type { DoctorReport } from "../../packages/cli/src/doctor/checks.js";
import type { StackDescription } from "../../packages/cli/src/environments/adopt.js";
import { readEnvironmentSettings, writeEnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import { runUpgrade, type UpgradeDependencies } from "../../packages/cli/src/upgrade/run.js";
import { SETTINGS } from "../support/doctor-fakes.js";
import { allStackOutputs, fakeRelease, memoryInitSecrets, scriptedDeployer, T0 } from "../support/init-fakes.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";

const ADMIN = "arn:aws:sts::123456789012:assumed-role/Admin/alice";
const OPERATOR = "arn:aws:sts::123456789012:assumed-role/agentx-staging-operator/alice";
const ACCESS_TEMPLATE = JSON.stringify({ Resources: { ArtifactBucket: { Type: "AWS::S3::Bucket" } } });
const INSTALLED = {
  ...SETTINGS, version: "1.2.3",
  access: { artifactBucket: "agentx-staging-access-artifactbucket-abc", cloudFormationRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-cloudformation", operatorRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-operator", pullThroughPrefix: "agentx-staging" },
};

function release(version = "1.3.0", declared: string[] = ["BudgetMonthlyUsd", "BudgetScope", "SlackThreadTurnsPerMinute"], accessTemplate = ACCESS_TEMPLATE): LoadedRelease {
  return { ...fakeRelease(version), template: (part) => (part === "access" ? accessTemplate : JSON.stringify({ Parameters: Object.fromEntries(declared.map((name) => [name, {}])) })) };
}

/** The templates engine's contract, faked: it asks request.confirm, and declines the way the engine does. */
function confirmingDeployer(changes: Record<string, ChangeSetChange[]> = {}): StackDeployer & { deployed: string[] } {
  const inner = scriptedDeployer(allStackOutputs(), Object.keys(allStackOutputs()));
  return {
    get deployed() { return inner.requests.map((request) => request.stackName); },
    async deploy(request) {
      if (request.confirm !== undefined && !(await request.confirm({ stackName: request.stackName, changes: changes[request.stackName] ?? [] }))) {
        throw new Error(`deploy of ${request.stackName} not executed; confirmation declined`);
      }
      return inner.deploy(request);
    },
    outputs: (name) => inner.outputs(name),
  };
}

const healthy: DoctorReport = { env: "staging", region: "us-east-1", version: "1.3.0", engine: "templates", checks: [], failed: 0, warned: 0, passed: 25 };

async function harness(overrides: Partial<UpgradeDependencies> & { caller?: string; deployer?: StackDeployer; changes?: Record<string, ChangeSetChange[]>; controlPlane?: Record<string, string> } = {}) {
  const store = new MemoryParameterStore();
  await writeEnvironmentSettings(store, INSTALLED);
  const deployer = overrides.deployer ?? confirmingDeployer(overrides.changes);
  const lines: string[] = [];
  const doctorRuns: string[] = [];
  const controlPlane = overrides.controlPlane ?? { GitHubAppId: "123", GitHubAppPrivateKeySecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/github-app-AbCdEf", BudgetMonthlyUsd: "250", CallbackSigningKey: "****" };
  const deps: UpgradeDependencies = {
    store,
    stacks: { describe: async (name): Promise<StackDescription | undefined> => ({ status: "UPDATE_COMPLETE", outputs: allStackOutputs()[name] ?? {}, parameters: name === "agentx-staging-control-plane" ? controlPlane : {} }) },
    cloudFormation: { async send(command: unknown) { if (command instanceof GetTemplateCommand) return { TemplateBody: ACCESS_TEMPLATE }; throw new Error("unexpected"); } },
    identity: { get: async () => ({ account: "123456789012", arn: overrides.caller ?? ADMIN }) },
    loadRelease: async () => release(),
    notes: async () => ({ text: "Fixes.", url: "https://example.test" }),
    prepare: async () => ({ deployer, store, secrets: memoryInitSecrets({ "agentx/staging/callback-signing-key": "k".repeat(43) }), holder: overrides.caller ?? ADMIN, partition: "aws", cleanup: async () => undefined }),
    cdkDiff: async () => "",
    ask: async () => "y",
    isInteractive: () => true,
    doctor: async (env) => { doctorRuns.push(env); return healthy; },
    write: (line) => lines.push(line),
    now: () => T0,
    cliVersion: "1.3.0",
    ...overrides,
  };
  return { deps, store, lines, doctorRuns, deployer: deployer as ReturnType<typeof confirmingDeployer> };
}

const options = { env: "staging", yes: true, allowReplace: [] as string[] };

describe("agentx upgrade (FR-042 to FR-044)", () => {
  it("shows the notes, deploys in upgrade order, records the new version, keeps the budget and runs doctor", async () => {
    const h = await harness();
    const result = await runUpgrade(options, h.deps);
    expect(h.lines).toContain("Upgrading staging from 1.2.3 to 1.3.0 (templates engine)");
    expect(h.lines).toContain("Release notes for 1.3.0:\n  Fixes.");
    expect(h.deployer.deployed).toEqual(["agentx-staging-access", "agentx-staging-foundation", "agentx-staging-identity", "agentx-staging-runtime", "agentx-staging-control-plane", "agentx-staging-slack"]);
    expect((await readEnvironmentSettings(h.store, "staging"))?.version).toBe("1.3.0");
    expect(h.doctorRuns).toEqual(["staging"]);
    expect(result).toMatchObject({ from: "1.2.3", to: "1.3.0", doctor: { failed: 0 } });
  });

  it("refuses an older release before anything else happens", async () => {
    const h = await harness({ loadRelease: async () => release("1.1.0") });
    await expect(runUpgrade(options, h.deps)).rejects.toThrow("release 1.1.0 is older than 1.2.3");
    expect(h.deployer.deployed).toEqual([]);
  });

  it("needs a version when this agentx was built from source", async () => {
    const h = await harness({ cliVersion: undefined });
    await expect(runUpgrade(options, h.deps)).rejects.toThrow("this agentx was built from source, so it has no release of its own; pass --to <version> or --release <dir>");
  });

  it("refuses the legacy deployment and an environment that is not installed", async () => {
    const h = await harness();
    await writeEnvironmentSettings(h.store, { ...INSTALLED, naming: "legacy" });
    await expect(runUpgrade(options, h.deps)).rejects.toThrow("agentx upgrade works on environments installed with agentx init; staging uses the legacy stack names");
    await expect(runUpgrade({ ...options, env: "other" }, h.deps)).rejects.toThrow("environment other is not installed in this account and region");
  });

  it("under the operator role, skips an unchanged access stack", async () => {
    const h = await harness({ caller: OPERATOR });
    await runUpgrade(options, h.deps);
    expect(h.deployer.deployed[0]).toBe("agentx-staging-foundation");
  });

  it("under the operator role, stops before deploying when the release changes the access stack (question 9)", async () => {
    const h = await harness({ caller: OPERATOR, loadRelease: async () => release("1.3.0", [], JSON.stringify({ Resources: { ArtifactBucket: { Type: "AWS::S3::Bucket" }, NewRole: { Type: "AWS::IAM::Role" } } })) });
    await expect(runUpgrade(options, h.deps)).rejects.toThrow("release 1.3.0 changes the access stack, which only admin credentials can deploy");
    expect(h.deployer.deployed).toEqual([]);
  });

  it("stops on a data replacement under --yes, deleting nothing, and continues with --allow-replace", async () => {
    const changes = { "agentx-staging-control-plane": [{ action: "Modify", logicalId: "State", type: "AWS::DynamoDB::Table", replacement: "True" }] };
    const stopped = await harness({ changes });
    await expect(runUpgrade(options, stopped.deps)).rejects.toThrow("upgrade stopped: agentx-staging-control-plane would replace State (AWS::DynamoDB::Table)");
    expect(stopped.deployer.deployed).not.toContain("agentx-staging-control-plane");
    const allowed = await harness({ changes });
    await runUpgrade({ ...options, allowReplace: ["State"] }, allowed.deps);
    expect(allowed.deployer.deployed).toContain("agentx-staging-control-plane");
  });

  it("lists a config key the new release drops, before deploying", async () => {
    const h = await harness({ loadRelease: async () => release("1.3.0", ["BudgetScope"]) });
    await runUpgrade(options, h.deps);
    const warning = h.lines.findIndex((line) => line === "config key budget.monthlyUsd (250) is not in release 1.3.0, so the upgrade drops it; nothing replaces it");
    const firstDeploy = h.lines.findIndex((line) => line.startsWith("deployed "));
    expect(warning).toBeGreaterThanOrEqual(0);
    expect(warning).toBeLessThan(firstDeploy);
  });

  it("fails when doctor finds a problem after the upgrade (FR-044)", async () => {
    const h = await harness({ doctor: async () => ({ ...healthy, failed: 2 }) });
    await expect(runUpgrade(options, h.deps)).rejects.toThrow("upgraded staging to 1.3.0, but 2 doctor checks failed; fix what each one names, then run agentx doctor again");
  });

  it("needs --yes when stdin is not a terminal", async () => {
    const h = await harness({ isInteractive: () => false });
    await expect(runUpgrade({ ...options, yes: false }, h.deps)).rejects.toThrow("agentx upgrade needs --yes when stdin is not a terminal");
  });

  it("with the cdk engine, reviews each stack's cdk diff before deploying it", async () => {
    const h = await harness({ cdkDiff: async (request) => (request.part === "control-plane" ? "Resources\n[-] AWS::S3::Bucket Artifacts Artifacts9F8E7D destroy" : "") });
    await writeEnvironmentSettings(h.store, { ...INSTALLED, engine: "cdk" });
    await expect(runUpgrade({ ...options, source: "/src" }, h.deps)).rejects.toThrow("upgrade stopped: agentx-staging-control-plane would delete Artifacts9F8E7D (AWS::S3::Bucket)");
    expect(h.deployer.deployed).toContain("agentx-staging-runtime");
    expect(h.deployer.deployed).not.toContain("agentx-staging-control-plane");
  });
});
```

Add to `tests/contract/day-two-permissions.test.ts`:

```ts
import { UPGRADE_AWS_ACTIONS } from "../../packages/cli/src/day-two-actions.js";

describe("upgrade needs no permission beyond the operator role, except an access-stack change (SC-005, question 9)", () => {
  it.each(UPGRADE_AWS_ACTIONS.map((action) => [action]))("upgrade: %s is allowed", (action) => {
    expect(allowed.has(action)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/contract/upgrade-run.test.ts tests/contract/day-two-permissions.test.ts`
Expected: FAIL: `upgrade/run.js` does not exist.

- [ ] **Step 3: Implement**

Add to `packages/cli/src/day-two-actions.ts`:

```ts
export const UPGRADE_AWS_ACTIONS: readonly string[] = [
  "sts:GetCallerIdentity",
  "ssm:GetParameter", "ssm:PutParameter", "ssm:DeleteParameter", "ssm:GetParametersByPath",
  "cloudformation:DescribeStacks", "cloudformation:DescribeStackEvents", "cloudformation:GetTemplate",
  "cloudformation:CreateChangeSet", "cloudformation:DescribeChangeSet", "cloudformation:ExecuteChangeSet", "cloudformation:DeleteChangeSet",
  "cloudformation:UpdateTerminationProtection", "iam:PassRole",
  "s3:GetObject", "s3:PutObject",
  "secretsmanager:GetSecretValue", "secretsmanager:CreateSecret", "secretsmanager:TagResource",
  ...DOCTOR_AWS_ACTIONS,
];
```

(Declare it after `DOCTOR_AWS_ACTIONS`.)

Create `packages/cli/src/upgrade/run.ts`:

```ts
// agentx upgrade (FR-042 to FR-044): read the environment's version and engine from SSM, show the
// target release's notes and every change, deploy in upgrade order (stopping at the first failure,
// which leaves earlier stacks upgraded and is safe to re-run), then run doctor.
import { GetTemplateCommand } from "@aws-sdk/client-cloudformation";
import { agentXError, environmentStackName } from "@agentx/contracts";
import { CONFIG_KEYS } from "../config/keys.js";
import { progressLine, type Ask, type PreparedDeployment } from "../deploy/commands.js";
import { deployEnvironment, templateParameterNames } from "../deploy/deploy-environment.js";
import type { DeployRequest } from "../deploy/deployer.js";
import { OPERATOR_PARAMETERS, upgradeOrder, type DeployPart } from "../deploy/parameters.js";
import type { LoadedRelease } from "../deploy/release.js";
import type { DoctorReport } from "../doctor/checks.js";
import { reportText } from "../doctor/checks.js";
import type { CallerIdentity, StackReader } from "../environments/adopt.js";
import type { ParameterStore } from "../environments/parameter-store.js";
import { readEnvironmentSettings, type EnvironmentSettings } from "../environments/settings.js";
import { isOperatorRole } from "../init/commands.js";
import { upgradeAnswers } from "./answers.js";
import { cdkDiffRisks, cdkReviewedDeployer, guardData, upgradeConfirm } from "./review.js";
import { notesText, upgradeDirection, type ReleaseNotes } from "./target.js";

export interface UpgradeOptions { env: string; to?: string; releaseDir?: string; source?: string; yes: boolean; allowReplace: string[]; exportDir?: string; images?: { worker?: string; slack?: string } }

export interface UpgradeDependencies {
  store: ParameterStore;
  stacks: StackReader;
  /** GetTemplate, for the access-stack comparison under the operator role. */
  cloudFormation: { send(command: unknown): Promise<unknown> };
  identity: CallerIdentity;
  loadRelease(input: { releaseDir?: string; version?: string }): Promise<LoadedRelease>;
  notes(version: string): Promise<ReleaseNotes | undefined>;
  prepare(input: { settings: EnvironmentSettings; release: LoadedRelease; source?: string }): Promise<PreparedDeployment>;
  cdkDiff(request: DeployRequest, settings: EnvironmentSettings, source: string): Promise<string>;
  ask: Ask;
  isInteractive(): boolean;
  doctor(env: string): Promise<DoctorReport>;
  write: (line: string) => void;
  now: () => number;
  /** This agentx's own release (RELEASE_VERSION); undefined for a build from source. */
  cliVersion: string | undefined;
}

export interface UpgradeResult { env: string; from: string; to: string; parts: DeployPart[]; exported?: string; doctor?: { failed: number; warned: number } }

/** Sorts object keys at every level, so two templates compare by content, not by formatting. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
}

export async function accessChanged(input: { cloudFormation: { send(command: unknown): Promise<unknown> }; stackName: string; release: LoadedRelease; region: string; env: string }): Promise<boolean> {
  const deployed = ((await input.cloudFormation.send(new GetTemplateCommand({ StackName: input.stackName, TemplateStage: "Original" }))) as { TemplateBody?: string }).TemplateBody ?? "{}";
  return JSON.stringify(canonical(JSON.parse(deployed))) !== JSON.stringify(canonical(JSON.parse(input.release.template("access", input.region, input.env))));
}

/** The spec's edge case "A release that removes a config key an environment has set": each operator
 * parameter a deployed stack holds that the target release's template no longer declares. */
export async function droppedConfigKeys(input: { release: LoadedRelease; env: string; parts: DeployPart[]; stacks: StackReader }): Promise<Array<{ key: string; value: string }>> {
  const dropped: Array<{ key: string; value: string }> = [];
  for (const part of input.parts) {
    const names = OPERATOR_PARAMETERS[part];
    if (names.length === 0) continue;
    const deployed = (await input.stacks.describe(environmentStackName(input.env, part)))?.parameters ?? {};
    const held = names.filter((name) => deployed[name] !== undefined);
    if (held.length === 0) continue;
    const declared = templateParameterNames(input.release, part, input.env);
    if (declared === undefined) continue;
    for (const name of held.filter((candidate) => !declared.has(candidate))) {
      const key = CONFIG_KEYS.find((entry) => entry.target.kind === "stack-parameter" && entry.target.part === part && entry.target.parameter === name)?.key ?? name;
      dropped.push({ key, value: deployed[name] ?? "" });
    }
  }
  return dropped;
}

export async function runUpgrade(options: UpgradeOptions, deps: UpgradeDependencies): Promise<UpgradeResult> {
  const { env } = options;
  const settings = await readEnvironmentSettings(deps.store, env);
  if (settings === undefined) throw agentXError("CONFIG_INVALID", `environment ${env} is not installed in this account and region; check --env and --region`);
  if (settings.naming !== "environment") throw agentXError("CONFIG_INVALID", `agentx upgrade works on environments installed with agentx init; ${env} uses the legacy stack names`);
  if (settings.engine === "cdk" && options.source === undefined && options.exportDir === undefined) {
    throw agentXError("CONFIG_INVALID", "the cdk engine upgrades from a checkout of the target release's tag; pass --source <dir>");
  }

  const version = options.releaseDir === undefined ? options.to ?? deps.cliVersion : undefined;
  if (options.releaseDir === undefined && version === undefined) {
    throw agentXError("CONFIG_INVALID", "this agentx was built from source, so it has no release of its own; pass --to <version> or --release <dir>");
  }
  const release = await deps.loadRelease({ ...(options.releaseDir === undefined ? {} : { releaseDir: options.releaseDir }), ...(version === undefined ? {} : { version }) });
  const target = release.manifest.version;
  if (options.to !== undefined && options.releaseDir !== undefined && options.to !== target) {
    throw agentXError("CONFIG_INVALID", `--release holds release ${target}, not ${options.to}; pass the release you mean`);
  }
  const direction = upgradeDirection(env, settings.version, target);
  deps.write(direction === "same" ? `Environment ${env} already runs ${target}; checking that every stack is on it` : `Upgrading ${env} from ${settings.version} to ${target} (${settings.engine} engine)`);
  deps.write(notesText(await deps.notes(target), target));

  const answers = await upgradeAnswers({ settings, stacks: deps.stacks, ...(options.images === undefined ? {} : { images: options.images }) });
  const caller = await deps.identity.get();
  let parts = upgradeOrder(settings.identity.mode);
  const accessStack = settings.stacks.access ?? environmentStackName(env, "access");
  if (isOperatorRole(caller.arn, env)) {
    parts = parts.filter((part) => part !== "access");
    if (settings.engine === "templates") {
      if (await accessChanged({ cloudFormation: deps.cloudFormation, stackName: accessStack, release, region: settings.region, env })) {
        throw agentXError("CONFIG_INVALID", `release ${target} changes the access stack, which only admin credentials can deploy. Ask your platform team to deploy it (agentx --env ${env} upgrade --export <dir> writes what they need), or run agentx upgrade with admin credentials; then run agentx upgrade again`);
      }
    } else {
      deps.write(`The operator role cannot deploy the access stack; if release ${target} changes it, your platform team deploys that part with cdk and admin credentials.`);
    }
  }

  for (const entry of await droppedConfigKeys({ release, env, parts, stacks: deps.stacks })) {
    deps.write(`config key ${entry.key} (${entry.value}) is not in release ${target}, so the upgrade drops it; nothing replaces it`);
  }

  if (!options.yes && !deps.isInteractive()) throw agentXError("CONFIG_INVALID", "agentx upgrade needs --yes when stdin is not a terminal");
  const allowReplace = new Set(options.allowReplace);
  const review = upgradeConfirm({ write: deps.write, ask: deps.ask, yes: options.yes, allowReplace });
  const prepared = await deps.prepare({ settings, release, ...(options.source === undefined ? {} : { source: options.source }) });
  try {
    const deployer = settings.engine === "templates" ? prepared.deployer : cdkReviewedDeployer(prepared.deployer, async (request) => {
      const risks = cdkDiffRisks(await deps.cdkDiff(request, settings, options.source ?? ""));
      if (risks.iam) deps.write(`${request.stackName} changes IAM; the changes are in the diff above.`);
      const refusal = await guardData({ stackName: request.stackName, data: risks.data, allowReplace, yes: options.yes, ask: deps.ask });
      if (refusal !== undefined) throw agentXError("CONFIG_INVALID", refusal);
      if (!options.yes && !/^y(es)?$/i.test((await deps.ask(`Deploy ${request.stackName}? [y/N] `)).trim())) {
        throw agentXError("CONFIG_INVALID", `upgrade stopped before ${request.stackName}: nothing in it changed. Stacks upgraded before it keep the new release; run agentx upgrade again to continue`);
      }
    });
    try {
      await deployEnvironment({
        mode: "upgrade", engine: settings.engine, answers, release, deployer, store: prepared.store, secrets: prepared.secrets, holder: prepared.holder, parts,
        onEvent: (event) => deps.write(progressLine(event)),
        ...(settings.engine === "templates" ? { confirm: review.confirm } : {}),
        deployedParameters: async (stackName) => (await deps.stacks.describe(stackName))?.parameters,
        now: deps.now,
      });
    } catch (error) {
      const refusal = review.refusal();
      if (refusal !== undefined && error instanceof Error && /confirmation declined/.test(error.message)) throw agentXError("CONFIG_INVALID", refusal);
      throw error;
    }
  } finally {
    await prepared.cleanup();
  }

  deps.write("Checking the environment with agentx doctor");
  const report = await deps.doctor(env);
  deps.write(reportText(report).trimEnd());
  if (report.failed > 0) {
    throw agentXError("CONFIG_INVALID", `upgraded ${env} to ${target}, but ${report.failed} doctor ${report.failed === 1 ? "check" : "checks"} failed; fix what each one names, then run agentx doctor again`);
  }
  return { env, from: settings.version, to: target, parts, doctor: { failed: report.failed, warned: report.warned } };
}
```

Create `packages/cli/src/upgrade/cli.ts`:

```ts
// The `agentx upgrade` command (FR-042 to FR-044, FR-026's upgrade --export), kept out of main.ts.
import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { STSClient } from "@aws-sdk/client-sts";
import type { Command } from "commander";
import { cdkDiff } from "../deploy/cdk-engine.js";
import { prepareDeployment, readlineAsk, realCommandRunner, type DeployCliDependencies } from "../deploy/commands.js";
import { loadRelease } from "../deploy/release.js";
import { realDoctorServices } from "../doctor/aws.js";
import { runDoctor } from "../doctor/run.js";
import { cloudFormationStackReader, stsCallerIdentity } from "../environments/adopt.js";
import type { ParameterStore } from "../environments/parameter-store.js";
import type { TextWriter } from "../init/prompts.js";
import { fetchRelease } from "../init/release-fetch.js";
import { formatSuccess } from "../output.js";
import { RELEASE_VERSION } from "../version.js";
import { runUpgrade, type UpgradeDependencies } from "./run.js";
import { releaseNotes } from "./target.js";

export interface UpgradeCommandContext {
  overrides?: Partial<UpgradeDependencies>;
  deploy?: DeployCliDependencies;
  parameterStore: (region?: string) => ParameterStore;
  fetch: typeof fetch;
  home: string;
  stdout: TextWriter;
  stderr: TextWriter;
}

const collect = (value: string, previous: string[]) => [...previous, value];

export function registerUpgradeCommand(program: Command, context: UpgradeCommandContext): void {
  program
    .command("upgrade")
    .description("upgrade an environment to a newer release: shows the release notes and every change, stops on a data replacement unless you name it, then runs doctor (operator role)")
    .option("--to <version>", "the release to upgrade to; default: this agentx's own release")
    .option("--release <dir>", "a release directory (agentx release build output) instead of downloading one")
    .option("--source <dir>", "the cdk engine only: a clean checkout of the target release's tag")
    .option("--allow-replace <logical-id>", "accept replacing or deleting this table, user pool, bucket or secret; repeat for each", collect, [])
    .option("--export <dir>", "write the upgrade for a platform team's pipeline instead of deploying it")
    .option("--worker-image <digest-ref>", "worker image by digest (testing only)")
    .option("--slack-image <digest-ref>", "Slack service image by digest (testing only)")
    .option("--yes", "apply without asking; every change and the release notes are still printed", false)
    .option("--region <region>", "AWS region of the environment; defaults to your AWS configuration")
    .action(async (options: { to?: string; release?: string; source?: string; allowReplace: string[]; export?: string; workerImage?: string; slackImage?: string; yes: boolean; region?: string }, command: Command) => {
      const globals = command.optsWithGlobals<{ env: string; json: boolean; configDir: string }>();
      const overrides = context.overrides ?? {};
      const aws = options.region === undefined ? {} : { region: options.region };
      const store = overrides.store ?? context.parameterStore(options.region);
      const runner = realCommandRunner(context.stderr);
      const write = overrides.write ?? ((line: string) => { context.stderr.write(`${line}\n`); });
      const deps: UpgradeDependencies = {
        store,
        stacks: overrides.stacks ?? cloudFormationStackReader(new CloudFormationClient(aws)),
        cloudFormation: overrides.cloudFormation ?? new CloudFormationClient(aws),
        identity: overrides.identity ?? stsCallerIdentity(new STSClient(aws)),
        loadRelease: overrides.loadRelease ?? (async (input) => loadRelease(input.releaseDir ?? await fetchRelease({ version: input.version, home: context.home, fetch: context.fetch, runner, write }))),
        notes: overrides.notes ?? ((version) => releaseNotes({ fetch: context.fetch, version })),
        prepare: overrides.prepare ?? ((input) => prepareDeployment({
          engine: input.settings.engine, env: input.settings.env, region: input.settings.region, account: input.settings.account,
          identityMode: input.settings.identity.mode, release: input.release, ...(input.source === undefined ? {} : { source: input.source }),
          deps: context.deploy ?? {}, stderr: context.stderr,
        })),
        cdkDiff: overrides.cdkDiff ?? ((request, settings, source) => cdkDiff({ runner, source, env: settings.env, region: settings.region, identityMode: settings.identity.mode, request })),
        ask: overrides.ask ?? readlineAsk(),
        isInteractive: overrides.isInteractive ?? (() => process.stdin.isTTY === true),
        doctor: overrides.doctor ?? ((env) => runDoctor({ env, store, services: (settings) => realDoctorServices({ settings, store, fetch: context.fetch, home: context.home, configDir: globals.configDir, stderr: context.stderr }) })),
        write,
        now: overrides.now ?? Date.now,
        cliVersion: "cliVersion" in overrides ? overrides.cliVersion : RELEASE_VERSION,
      };
      const images = options.workerImage === undefined && options.slackImage === undefined ? undefined : {
        ...(options.workerImage === undefined ? {} : { worker: options.workerImage }), ...(options.slackImage === undefined ? {} : { slack: options.slackImage }),
      };
      const result = await runUpgrade({
        env: globals.env, yes: options.yes, allowReplace: options.allowReplace,
        ...(options.to === undefined ? {} : { to: options.to }), ...(options.release === undefined ? {} : { releaseDir: options.release }),
        ...(options.source === undefined ? {} : { source: options.source }), ...(options.export === undefined ? {} : { exportDir: options.export }),
        ...(images === undefined ? {} : { images }),
      }, deps);
      context.stdout.write(globals.json ? formatSuccess(result, true) : result.exported !== undefined
        ? `Wrote the upgrade of ${result.env} to ${result.to} to ${result.exported}; give it to your platform team.\n`
        : `Upgraded ${result.env} from ${result.from} to ${result.to}.\n`);
    });
}
```

In `packages/cli/src/main.ts`, add `/** \`agentx upgrade\` overrides, for tests. */ upgrade?: Partial<UpgradeDependencies>;`
to `CliDependencies`, and register after doctor:

```ts
  registerUpgradeCommand(program, {
    ...(dependencies.upgrade === undefined ? {} : { overrides: dependencies.upgrade }),
    ...(dependencies.deploy === undefined ? {} : { deploy: dependencies.deploy }),
    parameterStore, fetch: services.fetchImplementation, home, stdout: services.stdout, stderr: services.stderr,
  });
```

`isOperatorRole` lives in `init/commands.ts`, which imports much of init; if importing it from
`upgrade/run.ts` creates an import cycle that lint or the build reports, move `isOperatorRole` to
`packages/cli/src/environments/operator-role.ts` and re-export it from `init/commands.ts`, so no
existing import changes.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/contract/upgrade-run.test.ts tests/contract/day-two-permissions.test.ts tests/contract/init-cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/upgrade/run.ts packages/cli/src/upgrade/cli.ts packages/cli/src/day-two-actions.ts packages/cli/src/main.ts tests/contract/upgrade-run.test.ts tests/contract/day-two-permissions.test.ts
git commit -m "feat(cli): agentx upgrade: notes, per-stack review, access-stack check under the operator role, doctor at the end"
```

### Task 13: `agentx upgrade --export` (FR-026)

A platform team that deploys AgentX through its own pipeline needs the upgrade as files. The bundle
uses only documented AWS CLI calls (`create-change-set --parameters file://...`), and every parameter
that must keep its value (the callback signing key, the operator's settings, developer sign-in) is
written as `UsePreviousValue`, so no secret is ever in it.

**Files:**
- Create: `packages/cli/src/upgrade/export.ts`
- Modify: `packages/cli/src/deploy/export-bundle.ts` (export `assertClaimable`)
- Modify: `packages/cli/src/upgrade/run.ts` (the `exportDir` branch)
- Test: `tests/contract/upgrade-export.test.ts`

**Interfaces:**
- Consumes: `stackParameters`, `SECRET_PARAMETERS`, `upgradeOrder`, `templateParameterNames`,
  `assertClaimable`, `LoadedRelease`.
- Produces:

```ts
export function writeUpgradeBundle(input: {
  dir: string; settings: EnvironmentSettings; answers: DeployAnswers; release: LoadedRelease; parts: DeployPart[];
  outputs: Partial<Record<DeployPart, StackOutputs>>; deployed: Partial<Record<DeployPart, Record<string, string>>>;
}): Promise<{ dir: string; files: string[] }>;
```

- [ ] **Step 1: Write the failing test**

Create `tests/contract/upgrade-export.test.ts`:

```ts
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LoadedRelease } from "../../packages/cli/src/deploy/release.js";
import { writeUpgradeBundle } from "../../packages/cli/src/upgrade/export.js";
import { SETTINGS } from "../support/doctor-fakes.js";
import { allStackOutputs, fakeRelease } from "../support/init-fakes.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const ASSET = "a".repeat(64);
const settings = { ...SETTINGS, access: { artifactBucket: "agentx-staging-access-artifactbucket-abc", cloudFormationRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-cloudformation", operatorRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-operator", pullThroughPrefix: "agentx-staging" } };

async function releaseWithPackage(): Promise<LoadedRelease> {
  const dir = await mkdtemp(join(tmpdir(), "agentx-upgrade-release-"));
  dirs.push(dir);
  await writeFile(join(dir, `${ASSET}.zip`), "zip bytes");
  const base = fakeRelease("1.3.0");
  return {
    ...base,
    manifest: { ...base.manifest, packages: [{ assetId: ASSET, file: `packages/${ASSET}.zip`, sha256: "f".repeat(64), parts: ["control-plane"], bucketParameter: "AssetBucket", keyParameter: "AssetKey", hashParameter: "AssetHash", keyParameterValue: `packages/${ASSET}.zip` }] },
    template: (part) => JSON.stringify({ Parameters: part === "control-plane" ? { CallbackSigningKey: {}, BudgetMonthlyUsd: {}, GitHubAppId: {} } : {} }),
    packagePath: () => join(dir, `${ASSET}.zip`),
  };
}

const answers = {
  env: "staging", region: "us-east-1", account: "123456789012", models: SETTINGS.models, identity: { mode: "cognito" as const },
  github: { appId: "123", privateKeySecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/github-app-AbCdEf" },
};
const outputs = Object.fromEntries(Object.entries(allStackOutputs()).map(([name, value]) => [name.replace("agentx-staging-", ""), value]));

describe("agentx upgrade --export (FR-026)", () => {
  it("writes templates, parameter files, packages and a README, with no secret, keeping what must not change", async () => {
    const out = join(await mkdtemp(join(tmpdir(), "agentx-upgrade-bundle-")), "bundle");
    dirs.push(out);
    const result = await writeUpgradeBundle({
      dir: out, settings, answers, release: await releaseWithPackage(), parts: ["foundation", "identity", "runtime", "control-plane", "slack"], outputs,
      deployed: { "control-plane": { CallbackSigningKey: "****", BudgetMonthlyUsd: "250", GitHubAppId: "123", DeveloperSignInSlack: "enabled" } },
    });
    expect(result.files).toEqual(expect.arrayContaining(["README.md", "templates/control-plane.template.json", "parameters/control-plane.json", `packages/${ASSET}.zip`]));
    const parameters = JSON.parse(await readFile(join(out, "parameters", "control-plane.json"), "utf8")) as Array<Record<string, unknown>>;
    expect(parameters).toContainEqual({ ParameterKey: "CallbackSigningKey", UsePreviousValue: true });
    expect(parameters).toContainEqual({ ParameterKey: "BudgetMonthlyUsd", UsePreviousValue: true });
    expect(parameters).toContainEqual({ ParameterKey: "GitHubAppId", ParameterValue: "123" });
    // A parameter the new template does not declare is not sent at all.
    expect(parameters.find((entry) => entry.ParameterKey === "DeveloperSignInSlack")).toBeUndefined();
    for (const file of await readdir(join(out, "parameters"))) expect(await readFile(join(out, "parameters", file), "utf8")).not.toMatch(/"ParameterKey": "CallbackSigningKey",\s*"ParameterValue"/);
    const readme = await readFile(join(out, "README.md"), "utf8");
    expect(readme).toContain("aws cloudformation create-change-set --stack-name agentx-staging-control-plane");
    expect(readme).toContain("--role-arn arn:aws:iam::123456789012:role/agentx-staging-cloudformation");
    expect(readme).toContain(`aws s3 cp packages/${ASSET}.zip s3://agentx-staging-access-artifactbucket-abc/packages/${ASSET}.zip --metadata sha256=${"f".repeat(64)} --region us-east-1`);
    expect(readme.indexOf("agentx-staging-runtime")).toBeLessThan(readme.indexOf("agentx-staging-control-plane --change-set-name"));
    expect(readme).toContain("agentx --env staging upgrade --to 1.3.0");
    expect(readme).not.toContain("agentx-staging-access --change-set-name");
  });

  it("refuses a directory that is not empty", async () => {
    const out = await mkdtemp(join(tmpdir(), "agentx-upgrade-bundle-"));
    dirs.push(out);
    await writeFile(join(out, "keep.txt"), "x");
    await expect(writeUpgradeBundle({ dir: out, settings, answers, release: await releaseWithPackage(), parts: ["slack"], outputs, deployed: {} })).rejects.toThrow("is not empty");
  });
});
```

Add to `tests/contract/upgrade-run.test.ts`:

```ts
  it("with --export, writes the bundle and deploys nothing", async () => {
    const out = join(await mkdtemp(join(tmpdir(), "agentx-upgrade-run-export-")), "bundle");
    const h = await harness();
    const result = await runUpgrade({ ...options, exportDir: out }, h.deps);
    expect(result.exported).toBe(out);
    expect(h.deployer.deployed).toEqual([]);
    expect(h.doctorRuns).toEqual([]);
    await rm(dirname(out), { recursive: true, force: true });
  });
```

(Import `mkdtemp`, `rm` from `node:fs/promises`, `tmpdir` from `node:os`, `dirname` and `join` from `node:path`.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/contract/upgrade-export.test.ts tests/contract/upgrade-run.test.ts`
Expected: FAIL: `upgrade/export.js` does not exist; `exported` is undefined.

- [ ] **Step 3: Implement**

In `packages/cli/src/deploy/export-bundle.ts`, change `async function assertClaimable` to
`export async function assertClaimable`.

Create `packages/cli/src/upgrade/export.ts`:

```ts
// FR-026: `agentx upgrade --export <dir>` writes the upgrade for a platform team's pipeline. It makes
// no AWS write. Each stack's parameter file names every value this upgrade sets, and marks every
// deployed parameter it does not set (the callback signing key, the operator's settings, developer
// sign-in) UsePreviousValue, so the change set keeps them and no secret is in any file.
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { environmentStackName } from "@agentx/contracts";
import type { DeployAnswers } from "../deploy/deploy-environment.js";
import { templateParameterNames } from "../deploy/deploy-environment.js";
import { assertClaimable } from "../deploy/export-bundle.js";
import { SECRET_PARAMETERS, stackParameters, type DeployPart, type StackOutputs } from "../deploy/parameters.js";
import type { LoadedRelease } from "../deploy/release.js";
import type { EnvironmentSettings } from "../environments/settings.js";

/** Never written: stackParameters checks the key's length, and SECRET_PARAMETERS are removed below. */
const PLACEHOLDER_KEY = "upgrade-bundle-placeholder-never-written-0000";

export async function writeUpgradeBundle(input: {
  dir: string; settings: EnvironmentSettings; answers: DeployAnswers; release: LoadedRelease; parts: DeployPart[];
  outputs: Partial<Record<DeployPart, StackOutputs>>; deployed: Partial<Record<DeployPart, Record<string, string>>>;
}): Promise<{ dir: string; files: string[] }> {
  const { dir, settings, release } = input;
  const { env, region } = settings;
  const version = release.manifest.version;
  await assertClaimable(dir);
  for (const sub of ["templates", "parameters", "packages"]) await mkdir(join(dir, sub), { recursive: true });
  const files: string[] = [];
  const full = { ...input.answers, release: release.manifest, callbackSigningKey: PLACEHOLDER_KEY };
  const bucket = settings.access?.artifactBucket ?? "<the access stack's ArtifactBucketName>";
  const role = settings.access?.cloudFormationRoleArn ?? "<the access stack's CloudFormationRoleArn>";
  const uploads: string[] = [];
  const steps: string[] = [];
  const changeSet = `agentx-upgrade-${version.replaceAll(".", "-")}`;
  for (const part of input.parts) {
    const stackName = environmentStackName(env, part);
    const computed = stackParameters(part, full, input.outputs);
    for (const secret of SECRET_PARAMETERS) delete computed[secret];
    const declared = templateParameterNames(release, part, env);
    const keep = Object.keys(input.deployed[part] ?? {}).filter((name) => !Object.hasOwn(computed, name) && (declared === undefined || declared.has(name)));
    const parameters = [
      ...Object.entries(computed).map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue })),
      ...keep.map((ParameterKey) => ({ ParameterKey, UsePreviousValue: true })),
    ];
    await writeFile(join(dir, "parameters", `${part}.json`), `${JSON.stringify(parameters, null, 2)}\n`);
    await writeFile(join(dir, "templates", `${part}.template.json`), release.template(part, region, env));
    files.push(`parameters/${part}.json`, `templates/${part}.template.json`);
    for (const pkg of release.manifest.packages.filter((entry) => entry.parts.includes(part))) {
      await copyFile(release.packagePath(pkg.assetId), join(dir, "packages", `${pkg.assetId}.zip`));
      files.push(`packages/${pkg.assetId}.zip`);
      uploads.push(`aws s3 cp packages/${pkg.assetId}.zip s3://${bucket}/packages/${pkg.assetId}.zip --metadata sha256=${pkg.sha256} --region ${region}`);
    }
    const key = `templates/${version}/${region}/${part}.template.json`;
    const roleFlag = part === "access" ? "" : ` --role-arn ${role}`;
    steps.push(
      `### ${stackName}`, "", "```",
      `aws s3 cp templates/${part}.template.json s3://${bucket}/${key} --region ${region}`,
      `aws cloudformation create-change-set --stack-name ${stackName} --change-set-name ${changeSet} --template-url https://${bucket}.s3.${region}.amazonaws.com/${key} --parameters file://parameters/${part}.json --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM${roleFlag} --region ${region}`,
      `aws cloudformation wait change-set-create-complete --stack-name ${stackName} --change-set-name ${changeSet} --region ${region}`,
      `aws cloudformation describe-change-set --stack-name ${stackName} --change-set-name ${changeSet} --region ${region}`,
      `aws cloudformation execute-change-set --stack-name ${stackName} --change-set-name ${changeSet} --region ${region}`,
      `aws cloudformation wait stack-update-complete --stack-name ${stackName} --region ${region}`,
      "```", "",
    );
  }
  const readme = [
    `# Upgrade AgentX environment ${env} to ${version}`, "",
    `Environment ${env} (account ${settings.account}, region ${region}) runs ${settings.version}. This bundle upgrades it to ${version}.`,
    "No file here holds a secret. Every deployed parameter this upgrade does not set is marked UsePreviousValue, so it keeps its value.", "",
    `Deploy the stacks in this order, one at a time, each only after the one before it finished: ${input.parts.map((part) => environmentStackName(env, part)).join(", ")}.`,
    "Read each change set before executing it: a replaced or deleted table, user pool, bucket or secret loses its data.",
    ...(input.parts.includes("access") ? ["The access stack deploys with your own credentials, without --role-arn; every other stack deploys through the CloudFormation role."] : []), "",
    "## 1. Upload the code packages", "", "```", ...(uploads.length === 0 ? ["# this release changes no code package"] : uploads), "```", "",
    "## 2. Deploy each stack", "", ...steps,
    "## 3. Record the new release", "",
    `When every stack is updated, the AgentX operator runs \`agentx --env ${env} upgrade --to ${version}\`. It finds no change left, records ${version} in the settings, and runs agentx doctor.`, "",
  ].join("\n");
  await writeFile(join(dir, "README.md"), readme);
  files.push("README.md");
  return { dir, files };
}
```

In `packages/cli/src/upgrade/run.ts`, right after the dropped-config-key lines and before the
`--yes` check, add:

```ts
  if (options.exportDir !== undefined) {
    const includeAccess = settings.engine === "templates" && await accessChanged({ cloudFormation: deps.cloudFormation, stackName: accessStack, release, region: settings.region, env });
    const exportParts = upgradeOrder(settings.identity.mode).filter((part) => part !== "access" || includeAccess);
    const outputs: Partial<Record<DeployPart, Record<string, string>>> = {};
    const deployed: Partial<Record<DeployPart, Record<string, string>>> = {};
    for (const part of upgradeOrder(settings.identity.mode)) {
      const stack = await deps.stacks.describe(settings.stacks[part] ?? environmentStackName(env, part));
      if (stack !== undefined) { outputs[part] = stack.outputs; deployed[part] = stack.parameters; }
    }
    const written = await writeUpgradeBundle({ dir: options.exportDir, settings, answers, release, parts: exportParts, outputs, deployed });
    return { env, from: settings.version, to: target, parts: exportParts, exported: written.dir };
  }
```

and move the operator-role access check so it runs only when `options.exportDir` is undefined
(an export needs no deploy rights). Import `writeUpgradeBundle` from `./export.js`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/contract/upgrade-export.test.ts tests/contract/upgrade-run.test.ts tests/contract/export-bundle.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/upgrade/export.ts packages/cli/src/upgrade/run.ts packages/cli/src/deploy/export-bundle.ts tests/contract/upgrade-export.test.ts tests/contract/upgrade-run.test.ts
git commit -m "feat(upgrade): upgrade --export writes change-set commands and parameter files with no secret (FR-026)"
```

### Task 14: `destroy`'s name guards, inventory, confirmation and plan

Pure code: what belongs to the environment, what the stacks retain, how the person confirms, what
they are shown before confirming, and the vendor steps printed at the end.

Depends on questions 1 (confirmation) and 2 (`--keep-data`).

**Files:**
- Create: `packages/cli/src/destroy/names.ts`, `packages/cli/src/destroy/inventory.ts`
- Test: `tests/contract/destroy-plan.test.ts`

**Interfaces:**
- Consumes: `environmentStackName`, `environmentSettingsPrefix`, `EnvironmentNameSchema`,
  `CONNECTOR_TYPES`, `SSM_STANDARD_VALUE_LIMIT` (install-state.ts), `ParameterStore`.
- Produces:

```ts
// destroy/names.ts
export const DELETE_BEFORE_WORKERS: readonly StackPart[];  // slack, runtime, control-plane
export const DELETE_AFTER_WORKERS: readonly StackPart[];   // identity, foundation, access
export function isOwnedStack(env: string, name: string): boolean;
export function isOwnedSecret(env: string, name: string): boolean;
export function isOwnedParameter(env: string, name: string): boolean;
export function isOwnedAlias(env: string, alias: string): boolean;
export function isOwnedWorker(env: string, tags: Record<string, string>): boolean;
export function isOwnedRetained(env: string, resource: RetainedResource, tags: Record<string, string> | undefined): boolean;
// destroy/inventory.ts
export const RETAINED_TYPES: readonly string[];
export const KEPT_BY_KEEP_DATA: ReadonlySet<string>;
export interface RetainedResource { part: StackPart; logicalId: string; type: string; physicalId: string }
export function retainedResources(part: StackPart, templateBody: string, resources: Array<{ logicalId: string; type: string; physicalId: string | undefined }>): RetainedResource[];
export interface Inventory { schemaVersion: 1; env: string; resources: RetainedResource[]; launchTemplateId?: string; github?: { account: string; accountType: "organization" | "user"; slug: string }; slackAppId?: string; connectors?: ConnectorType[] }
export function inventoryParameterName(env: string): string;
export function readInventory(store: ParameterStore, env: string): Promise<Inventory | undefined>;
export function writeInventory(store: ParameterStore, inventory: Inventory): Promise<void>;
export function mergeInventory(stored: Inventory | undefined, found: Omit<Inventory, "schemaVersion">): Inventory;
export function confirmationPrompts(input: { env: string; account: string; recorded: boolean }): Array<{ question: string; expected: string }>;
export function vendorSteps(inventory: Inventory): string[];
export interface DestroyPlan { env: string; account: string; region: string; stacks: Array<{ name: string; status: string }>; instances: number; volumes: number; resources: RetainedResource[]; secrets: number; parameters: number; localFiles: string[]; keepData: boolean }
export function destroyPlanText(plan: DestroyPlan): string[];
```

- [ ] **Step 1: Write the failing test**

Create `tests/contract/destroy-plan.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { confirmationPrompts, destroyPlanText, inventoryParameterName, mergeInventory, readInventory, retainedResources, vendorSteps, writeInventory, type RetainedResource } from "../../packages/cli/src/destroy/inventory.js";
import { DELETE_AFTER_WORKERS, DELETE_BEFORE_WORKERS, isOwnedAlias, isOwnedParameter, isOwnedRetained, isOwnedSecret, isOwnedStack, isOwnedWorker } from "../../packages/cli/src/destroy/names.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";

describe("destroy: the order (docs/architecture-production.md, Tearing down an environment)", () => {
  it("deletes slack, runtime, control-plane, then the workers, then identity, foundation, access", () => {
    expect([...DELETE_BEFORE_WORKERS, "workers", ...DELETE_AFTER_WORKERS]).toEqual(["slack", "runtime", "control-plane", "workers", "identity", "foundation", "access"]);
  });
});

describe("destroy: name guards never reach another environment", () => {
  it("matches this environment's stacks, secrets, parameters and aliases exactly", () => {
    expect(isOwnedStack("prod", "agentx-prod-slack")).toBe(true);
    expect(isOwnedStack("prod", "agentx-prod-eu-slack")).toBe(false);
    expect(isOwnedStack("prod", "AgentXControlPlane")).toBe(false);
    expect(isOwnedSecret("prod", "agentx/prod/slack")).toBe(true);
    expect(isOwnedSecret("prod", "agentx/prod-eu/slack")).toBe(false);
    expect(isOwnedSecret("prod", "agentx/connectors/linear")).toBe(false);
    expect(isOwnedParameter("prod", "/agentx/prod/settings")).toBe(true);
    expect(isOwnedParameter("prod", "/agentx/prod-eu/settings")).toBe(false);
    expect(isOwnedAlias("prod", "alias/agentx/prod/workspaces")).toBe(true);
    expect(isOwnedAlias("prod", "alias/agentx/prod-eu/workspaces")).toBe(false);
    expect(isOwnedAlias("production", "alias/agentx/production-workspaces")).toBe(false);
  });

  it("matches a worker only with all three tags, so the legacy deployment's workers (Environment=production, no agentx:env) are never touched", () => {
    expect(isOwnedWorker("production", { DeploymentMode: "ec2-ebs", Environment: "production", "agentx:env": "production" })).toBe(true);
    expect(isOwnedWorker("production", { DeploymentMode: "ec2-ebs", Environment: "production" })).toBe(false);
    expect(isOwnedWorker("prod", { DeploymentMode: "ec2-ebs", Environment: "prod-eu", "agentx:env": "prod-eu" })).toBe(false);
  });

  it("matches a retained resource only with this environment's tag and, for generated names, its stack's prefix", () => {
    const bucket: RetainedResource = { part: "foundation", logicalId: "Artifacts", type: "AWS::S3::Bucket", physicalId: "agentx-prod-foundation-access-artifactbucket-1a2b" };
    // Env "prod-foundation"'s access bucket starts with env "prod"'s foundation prefix; only the tag tells them apart.
    expect(isOwnedRetained("prod", bucket, { "agentx:env": "prod-foundation" })).toBe(false);
    expect(isOwnedRetained("prod", { ...bucket, physicalId: "agentx-prod-foundation-artifacts-9z" }, { "agentx:env": "prod" })).toBe(true);
    expect(isOwnedRetained("prod", { ...bucket, physicalId: "agentx-prod-eu-foundation-artifacts-9z" }, { "agentx:env": "prod" })).toBe(false);
    expect(isOwnedRetained("prod", { part: "identity", logicalId: "UserPool", type: "AWS::Cognito::UserPool", physicalId: "us-east-1_AbC" }, undefined)).toBe(false);
    expect(isOwnedRetained("prod", { part: "control-plane", logicalId: "SlackSecret", type: "AWS::SecretsManager::Secret", physicalId: "arn:aws:secretsmanager:us-east-1:1:secret:agentx/prod-eu/slack-AbC" }, { "agentx:env": "prod" })).toBe(false);
  });
});

describe("destroy: the inventory of what the stacks retain", () => {
  const template = JSON.stringify({ Resources: {
    State: { Type: "AWS::DynamoDB::Table", DeletionPolicy: "RetainExceptOnCreate" },
    Pool: { Type: "AWS::Cognito::UserPool", DeletionPolicy: "Retain" },
    Fn: { Type: "AWS::Lambda::Function" },
  } });

  it("lists only resources whose DeletionPolicy retains them", () => {
    const found = retainedResources("control-plane", template, [
      { logicalId: "State", type: "AWS::DynamoDB::Table", physicalId: "agentx-staging-control-plane-State-1" },
      { logicalId: "Pool", type: "AWS::Cognito::UserPool", physicalId: "us-east-1_X" },
      { logicalId: "Fn", type: "AWS::Lambda::Function", physicalId: "fn" },
      { logicalId: "State", type: "AWS::DynamoDB::Table", physicalId: undefined },
    ]);
    expect(found.map((entry) => entry.logicalId)).toEqual(["State", "Pool"]);
  });

  it("falls back to the retained resource types when the template cannot be parsed", () => {
    expect(retainedResources("foundation", "Resources: yaml", [{ logicalId: "FlowLogs", type: "AWS::Logs::LogGroup", physicalId: "g" }, { logicalId: "Fn", type: "AWS::Lambda::Function", physicalId: "f" }]).map((entry) => entry.logicalId)).toEqual(["FlowLogs"]);
  });

  it("round-trips through SSM, merges without duplicates, and keeps what an earlier run recorded", async () => {
    const store = new MemoryParameterStore();
    const first = mergeInventory(undefined, { env: "staging", resources: [{ part: "foundation", logicalId: "Key", type: "AWS::KMS::Key", physicalId: "k-1" }], launchTemplateId: "lt-0123456789abcdef0", slackAppId: "A0APP" });
    await writeInventory(store, first);
    expect(store.values.has(inventoryParameterName("staging"))).toBe(true);
    const stored = await readInventory(store, "staging");
    const second = mergeInventory(stored, { env: "staging", resources: [{ part: "foundation", logicalId: "Key", type: "AWS::KMS::Key", physicalId: "k-1" }, { part: "identity", logicalId: "Pool", type: "AWS::Cognito::UserPool", physicalId: "us-east-1_X" }] });
    expect(second.resources).toHaveLength(2);
    expect(second.launchTemplateId).toBe("lt-0123456789abcdef0");
    expect(second.slackAppId).toBe("A0APP");
  });
});

describe("destroy: confirmation (question 1)", () => {
  it("asks for the environment's name, and also the account id for production or an environment AgentX has no record of", () => {
    expect(confirmationPrompts({ env: "staging", account: "123456789012", recorded: true }).map((prompt) => prompt.expected)).toEqual(["staging"]);
    expect(confirmationPrompts({ env: "production", account: "123456789012", recorded: true }).map((prompt) => prompt.expected)).toEqual(["production", "123456789012"]);
    expect(confirmationPrompts({ env: "staging", account: "123456789012", recorded: false }).map((prompt) => prompt.expected)).toEqual(["staging", "123456789012"]);
  });
});

describe("destroy: what is shown before, and printed after", () => {
  it("shows every stack in order, the workers with the workspace warning, what is kept, and the slow control-plane delete", () => {
    const lines = destroyPlanText({
      env: "staging", account: "123456789012", region: "us-east-1",
      stacks: [{ name: "agentx-staging-slack", status: "UPDATE_COMPLETE" }, { name: "agentx-staging-control-plane", status: "UPDATE_COMPLETE" }],
      instances: 1, volumes: 2, secrets: 5, parameters: 9, localFiles: ["/home/a/.agentx/environments/staging.yaml"], keepData: false,
      resources: [{ part: "control-plane", logicalId: "State", type: "AWS::DynamoDB::Table", physicalId: "t" }, { part: "foundation", logicalId: "Key", type: "AWS::KMS::Key", physicalId: "k" }],
    });
    expect(lines[0]).toBe("This deletes AgentX environment staging in account 123456789012, region us-east-1:");
    expect(lines).toContain("  stacks, in this order: agentx-staging-slack (UPDATE_COMPLETE), agentx-staging-control-plane (UPDATE_COMPLETE)");
    expect(lines).toContain("  EC2 workers: 1 instance and 2 workspace volumes; deleting the volumes deletes every worker session's workspace");
    expect(lines).toContain("  what the stacks keep, deleted after them: 1 table, 1 KMS key (deleted after 7 days)");
    expect(lines).toContain("  Deleting agentx-staging-control-plane usually takes 20 to 40 minutes: its Lambda functions release their network interfaces slowly.");
    expect(lines.at(-1)).toBe("Nothing here can be undone.");
    const kept = destroyPlanText({ env: "staging", account: "123456789012", region: "us-east-1", stacks: [], instances: 0, volumes: 0, secrets: 5, parameters: 1, localFiles: [], keepData: true, resources: [{ part: "control-plane", logicalId: "State", type: "AWS::DynamoDB::Table", physicalId: "t" }] });
    expect(kept).toContain("  --keep-data keeps: 1 table and 5 secrets");
  });

  it("prints the GitHub App and Slack app pages to delete them, and the connector credentials to revoke", () => {
    expect(vendorSteps({ schemaVersion: 1, env: "staging", resources: [], github: { account: "acme", accountType: "organization", slug: "agentx-acme" }, slackAppId: "A0APP", connectors: ["linear"] })).toEqual([
      "Delete the GitHub App agentx-acme: open https://github.com/organizations/acme/settings/apps/agentx-acme/advanced and choose Delete GitHub App.",
      "Delete the Slack app: open https://api.slack.com/apps/A0APP/general and choose Delete App at the bottom of the page.",
      "Revoke the Linear API key AgentX used: Linear, Settings, Security and access, API keys.",
    ]);
    expect(vendorSteps({ schemaVersion: 1, env: "staging", resources: [], github: { account: "alice", accountType: "user", slug: "agentx-alice" } })[0]).toBe("Delete the GitHub App agentx-alice: open https://github.com/settings/apps/agentx-alice/advanced and choose Delete GitHub App.");
    expect(vendorSteps({ schemaVersion: 1, env: "staging", resources: [] })).toEqual([
      "Delete the environment's GitHub App, if it had one: https://github.com/settings/apps (for an organization: its Settings, Developer settings, GitHub Apps), then Advanced, Delete GitHub App.",
      "Delete the environment's Slack app, if it had one: https://api.slack.com/apps, the app, then Delete App at the bottom of Basic Information.",
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/contract/destroy-plan.test.ts`
Expected: FAIL: the modules do not exist.

- [ ] **Step 3: Implement**

Create `packages/cli/src/destroy/names.ts`:

```ts
// agentx destroy never touches another environment's resources: every name is checked here before
// anything is deleted. Prefixes carry their separator ("agentx/<env>/", "/agentx/<env>/"), because
// "/" cannot appear in an environment name, so agentx/prod/ never matches agentx/prod-eu/.
import { environmentStackName, STACK_PARTS, type StackPart } from "@agentx/contracts";
import type { RetainedResource } from "./inventory.js";

export const DELETE_BEFORE_WORKERS: readonly StackPart[] = ["slack", "runtime", "control-plane"];
export const DELETE_AFTER_WORKERS: readonly StackPart[] = ["identity", "foundation", "access"];

/** Resource types whose names CloudFormation generates from the stack name. */
const GENERATED_NAMES = new Set(["AWS::S3::Bucket", "AWS::DynamoDB::Table", "AWS::Logs::LogGroup"]);

export const isOwnedStack = (env: string, name: string) => STACK_PARTS.some((part) => environmentStackName(env, part) === name);
export const isOwnedSecret = (env: string, name: string) => name.startsWith(`agentx/${env}/`);
export const isOwnedParameter = (env: string, name: string) => name === `/agentx/${env}` || name.startsWith(`/agentx/${env}/`);
export const isOwnedAlias = (env: string, alias: string) => alias.startsWith(`alias/agentx/${env}/`);

/** All three tags: the legacy deployment's workers carry Environment=production but no agentx:env. */
export const isOwnedWorker = (env: string, tags: Record<string, string>) =>
  tags.DeploymentMode === "ec2-ebs" && tags.Environment === env && tags["agentx:env"] === env;

/** A retained resource comes from this environment's own stack inventory; it must also carry this
 * environment's tag, and a generated name must start with its own stack's name. */
export function isOwnedRetained(env: string, resource: RetainedResource, tags: Record<string, string> | undefined): boolean {
  if (tags?.["agentx:env"] !== env) return false;
  if (GENERATED_NAMES.has(resource.type)) return resource.physicalId.toLowerCase().startsWith(`${environmentStackName(env, resource.part)}-`.toLowerCase());
  if (resource.type === "AWS::SecretsManager::Secret") return resource.physicalId.includes(`:secret:agentx/${env}/`) || resource.physicalId.startsWith(`agentx/${env}/`);
  return true;
}
```

Create `packages/cli/src/destroy/inventory.ts`:

```ts
// What agentx destroy must remove after the stacks are gone: every resource a stack retains
// (DeletionPolicy Retain or RetainExceptOnCreate), recorded in SSM before any stack is deleted, so
// a re-run after the stacks are gone still knows them. Also the plan shown before confirming, the
// typed confirmation, and the vendor steps printed at the end.
import { z } from "zod";
import { agentXError, EnvironmentNameSchema, environmentSettingsPrefix, environmentStackName, type StackPart } from "@agentx/contracts";
import type { ParameterStore } from "../environments/parameter-store.js";
import { CONNECTOR_TYPES, SSM_STANDARD_VALUE_LIMIT, type ConnectorType } from "../init/install-state.js";

export const RETAINED_TYPES: readonly string[] = ["AWS::S3::Bucket", "AWS::DynamoDB::Table", "AWS::Logs::LogGroup", "AWS::Cognito::UserPool", "AWS::KMS::Key", "AWS::SecretsManager::Secret"];
/** Question 2: --keep-data keeps the data, and removes the rest (log groups included). */
export const KEPT_BY_KEEP_DATA: ReadonlySet<string> = new Set(["AWS::S3::Bucket", "AWS::DynamoDB::Table", "AWS::Cognito::UserPool", "AWS::KMS::Key", "AWS::SecretsManager::Secret"]);

export interface RetainedResource { part: StackPart; logicalId: string; type: string; physicalId: string }

const PARTS = ["access", "foundation", "identity", "runtime", "control-plane", "slack"] as const;
const InventorySchema = z.object({
  schemaVersion: z.literal(1),
  env: EnvironmentNameSchema,
  resources: z.array(z.object({ part: z.enum(PARTS), logicalId: z.string().min(1).max(255), type: z.string().min(1).max(100), physicalId: z.string().min(1).max(2048) }).strict()).max(40),
  launchTemplateId: z.string().regex(/^lt-[0-9a-f]+$/).optional(),
  github: z.object({ account: z.string().min(1).max(39), accountType: z.enum(["organization", "user"]), slug: z.string().regex(/^[a-z0-9-]+$/) }).strict().optional(),
  slackAppId: z.string().regex(/^A[A-Z0-9]+$/).optional(),
  connectors: z.array(z.enum(CONNECTOR_TYPES)).max(3).optional(),
}).strict();
export type Inventory = z.infer<typeof InventorySchema>;

export function retainedResources(part: StackPart, templateBody: string, resources: Array<{ logicalId: string; type: string; physicalId: string | undefined }>): RetainedResource[] {
  let retained: (resource: { logicalId: string; type: string }) => boolean;
  try {
    const template = JSON.parse(templateBody) as { Resources?: Record<string, { DeletionPolicy?: string }> };
    const ids = new Set(Object.entries(template.Resources ?? {}).filter(([, resource]) => resource.DeletionPolicy === "Retain" || resource.DeletionPolicy === "RetainExceptOnCreate").map(([id]) => id));
    retained = (resource) => ids.has(resource.logicalId);
  } catch {
    // An unreadable template: every resource of a type AgentX retains is treated as retained. One
    // the stack delete removed anyway is simply found gone later.
    retained = (resource) => RETAINED_TYPES.includes(resource.type);
  }
  return resources.flatMap((resource) => (retained(resource) && resource.physicalId !== undefined && resource.physicalId !== "" ? [{ part, logicalId: resource.logicalId, type: resource.type, physicalId: resource.physicalId }] : []));
}

export function inventoryParameterName(env: string): string {
  return `${environmentSettingsPrefix(env)}destroy/inventory`;
}

export async function readInventory(store: ParameterStore, env: string): Promise<Inventory | undefined> {
  const stored = await store.get(inventoryParameterName(env));
  if (stored === undefined) return undefined;
  let json: unknown;
  try { json = JSON.parse(stored.value); } catch { json = undefined; }
  const parsed = InventorySchema.safeParse(json);
  if (!parsed.success || parsed.data.env !== env) throw agentXError("CONFIG_INVALID", `${inventoryParameterName(env)} is not an agentx destroy inventory for ${env}; delete it only if you are sure nothing of ${env} is left, then run agentx destroy again`);
  return parsed.data;
}

export async function writeInventory(store: ParameterStore, inventory: Inventory): Promise<void> {
  const json = JSON.stringify(InventorySchema.parse(inventory));
  if (Buffer.byteLength(json) > SSM_STANDARD_VALUE_LIMIT) {
    throw agentXError("CONFIG_INVALID", `the list of resources environment ${inventory.env}'s stacks keep is larger than SSM's ${SSM_STANDARD_VALUE_LIMIT}-byte limit; report this as an AgentX bug, and tear the environment down with docs/teardown.md meanwhile`);
  }
  await store.put(inventoryParameterName(inventory.env), json);
}

export function mergeInventory(stored: Inventory | undefined, found: Omit<Inventory, "schemaVersion">): Inventory {
  const key = (resource: RetainedResource) => `${resource.type}|${resource.physicalId}`;
  const resources = new Map((stored?.resources ?? []).map((resource) => [key(resource), resource]));
  for (const resource of found.resources) resources.set(key(resource), resource);
  const launchTemplateId = found.launchTemplateId ?? stored?.launchTemplateId;
  const github = found.github ?? stored?.github;
  const slackAppId = found.slackAppId ?? stored?.slackAppId;
  const connectors = found.connectors ?? stored?.connectors;
  return {
    schemaVersion: 1, env: found.env, resources: [...resources.values()],
    ...(launchTemplateId === undefined ? {} : { launchTemplateId }), ...(github === undefined ? {} : { github }),
    ...(slackAppId === undefined ? {} : { slackAppId }), ...(connectors === undefined ? {} : { connectors }),
  };
}

export function confirmationPrompts(input: { env: string; account: string; recorded: boolean }): Array<{ question: string; expected: string }> {
  const prompts = [{ question: `Type the environment's name, ${input.env}, to delete it and everything in it: `, expected: input.env }];
  if (input.env === "production" || !input.recorded) {
    const why = input.env === "production" ? "This environment is named production." : `AgentX has no record of creating ${input.env} (no settings and no install answers).`;
    prompts.push({ question: `${why} Type the AWS account id, ${input.account}, to go on: `, expected: input.account });
  }
  return prompts;
}

const REVOKE: Record<ConnectorType, string> = {
  linear: "Revoke the Linear API key AgentX used: Linear, Settings, Security and access, API keys.",
  jira: "Revoke the Jira service account's API token: id.atlassian.com, Security, API tokens, signed in as the service account.",
  asana: "Delete the Asana app AgentX used, or remove its bot from the project: app.asana.com/0/my-apps.",
};

export function vendorSteps(inventory: Inventory): string[] {
  const { github, slackAppId } = inventory;
  const githubPage = github === undefined ? undefined : github.accountType === "organization"
    ? `https://github.com/organizations/${github.account}/settings/apps/${github.slug}/advanced`
    : `https://github.com/settings/apps/${github.slug}/advanced`;
  return [
    github === undefined || githubPage === undefined
      ? "Delete the environment's GitHub App, if it had one: https://github.com/settings/apps (for an organization: its Settings, Developer settings, GitHub Apps), then Advanced, Delete GitHub App."
      : `Delete the GitHub App ${github.slug}: open ${githubPage} and choose Delete GitHub App.`,
    slackAppId === undefined
      ? "Delete the environment's Slack app, if it had one: https://api.slack.com/apps, the app, then Delete App at the bottom of Basic Information."
      : `Delete the Slack app: open https://api.slack.com/apps/${slackAppId}/general and choose Delete App at the bottom of the page.`,
    ...(inventory.connectors ?? []).map((type) => REVOKE[type]),
  ];
}

export interface DestroyPlan {
  env: string; account: string; region: string; stacks: Array<{ name: string; status: string }>; instances: number; volumes: number;
  resources: RetainedResource[]; secrets: number; parameters: number; localFiles: string[]; keepData: boolean;
}

const NOUNS: Record<string, [string, string]> = {
  "AWS::S3::Bucket": ["bucket (every version)", "buckets (every version)"], "AWS::DynamoDB::Table": ["table", "tables"], "AWS::Logs::LogGroup": ["log group", "log groups"],
  "AWS::Cognito::UserPool": ["Cognito user pool", "Cognito user pools"], "AWS::KMS::Key": ["KMS key (deleted after 7 days)", "KMS keys (deleted after 7 days)"], "AWS::SecretsManager::Secret": ["secret", "secrets"],
};
const counted = (resources: RetainedResource[]) => [...new Set(resources.map((resource) => resource.type))].map((type) => {
  const count = resources.filter((resource) => resource.type === type).length;
  const [one, many] = NOUNS[type] ?? [type, type];
  return `${count} ${count === 1 ? one : many}`;
});
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export function destroyPlanText(plan: DestroyPlan): string[] {
  const deleted = plan.keepData ? plan.resources.filter((resource) => !KEPT_BY_KEEP_DATA.has(resource.type)) : plan.resources;
  const kept = plan.keepData ? plan.resources.filter((resource) => KEPT_BY_KEEP_DATA.has(resource.type)) : [];
  const controlPlane = environmentStackName(plan.env, "control-plane");
  return [
    `This deletes AgentX environment ${plan.env} in account ${plan.account}, region ${plan.region}:`,
    ...(plan.stacks.length === 0 ? [] : [`  stacks, in this order: ${plan.stacks.map((stack) => `${stack.name} (${stack.status})`).join(", ")}`]),
    ...(plan.instances + plan.volumes === 0 ? [] : [`  EC2 workers: ${plural(plan.instances, "instance", "instances")} and ${plural(plan.volumes, "workspace volume", "workspace volumes")}; deleting the volumes deletes every worker session's workspace`]),
    ...(deleted.length === 0 ? [] : [`  what the stacks keep, deleted after them: ${counted(deleted).join(", ")}`]),
    ...(plan.keepData ? [] : [`  secrets: ${plural(plan.secrets, "secret", "secrets")} under agentx/${plan.env}/, deleted without recovery`]),
    `  settings: ${plural(plan.parameters, "parameter", "parameters")} under /agentx/${plan.env}/`,
    ...(plan.localFiles.length === 0 ? [] : [`  on this computer: ${plan.localFiles.join(", ")}`]),
    ...(plan.keepData ? [`  --keep-data keeps: ${[...counted(kept), plural(plan.secrets, "secret", "secrets")].join(" and ")}`] : []),
    ...(plan.stacks.some((stack) => stack.name === controlPlane) ? [`  Deleting ${controlPlane} usually takes 20 to 40 minutes: its Lambda functions release their network interfaces slowly.`] : []),
    "Nothing here can be undone.",
  ];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/contract/destroy-plan.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/destroy/names.ts packages/cli/src/destroy/inventory.ts tests/contract/destroy-plan.test.ts
git commit -m "feat(destroy): name guards, the retained inventory, typed confirmation, the plan and vendor steps"
```

### Task 15: `destroy`'s AWS adapter and its waits

**Files:**
- Modify: `packages/cli/package.json`, `package-lock.json` (three SDK clients)
- Create: `packages/cli/src/destroy/aws.ts`, `packages/cli/src/destroy/wait.ts`
- Test: `tests/contract/destroy-aws.test.ts`

**Interfaces:**
- Consumes: `isOwnedSecret`, `isOwnedAlias` (Task 14), `RetainedResource`.
- Produces:

```ts
// destroy/aws.ts
export interface DestroyStack { status: string; terminationProtection: boolean; roleArn?: string; outputs: Record<string, string> }
export interface DestroyApi {
  stack(name: string): Promise<DestroyStack | undefined>;
  template(name: string): Promise<string>;
  stackResources(name: string): Promise<Array<{ logicalId: string; type: string; physicalId: string | undefined }>>;
  disableTerminationProtection(name: string): Promise<void>;
  deleteStack(name: string): Promise<void>;
  latestEvent(name: string): Promise<string | undefined>;
  failedResources(name: string): Promise<string[]>;
  workerInstances(env: string): Promise<Array<{ id: string; state: string; tags: Record<string, string> }>>;
  terminateInstances(ids: string[]): Promise<void>;
  workerVolumes(env: string): Promise<Array<{ id: string; state: string; tags: Record<string, string> }>>;
  deleteVolume(id: string): Promise<void>;
  resourceTags(resource: RetainedResource): Promise<Record<string, string> | undefined>;   // undefined: already gone
  deleteBucket(name: string, onProgress: (deleted: number) => void): Promise<void>;
  deleteTable(name: string): Promise<void>;
  deleteLogGroup(name: string): Promise<void>;
  deleteUserPool(id: string, domainPrefix: string): Promise<void>;
  scheduleKeyDeletion(keyId: string): Promise<"scheduled" | "already">;
  aliases(env: string): Promise<Array<{ name: string }>>;
  deleteAlias(name: string): Promise<void>;
  secrets(env: string): Promise<Array<{ name: string; scheduled: boolean }>>;
  deleteSecret(name: string, scheduled: boolean): Promise<void>;
}
type Send = { send(command: unknown): Promise<unknown> };
export function awsDestroyApi(clients: { cloudFormation: Send; ec2: Send; s3: Send; dynamodb: Send; logs: Send; cognito: Send; kms: Send; secrets: Send }): DestroyApi;
// destroy/wait.ts
export const STACK_DELETE_TIMEOUT_MS: number;   // 3 hours
export function waitForStackDelete(input: { api: DestroyApi; name: string; write: (line: string) => void; sleep: (ms: number) => Promise<void>; now: () => number; pollMs?: number; noticeMs?: number; timeoutMs?: number }): Promise<void>;
export function waitForInstancesGone(input: { api: DestroyApi; env: string; ids: string[]; sleep: (ms: number) => Promise<void>; now: () => number; timeoutMs?: number }): Promise<void>;
export function deleteVolumesWhenFree(input: { api: DestroyApi; ids: string[]; sleep: (ms: number) => Promise<void>; now: () => number; timeoutMs?: number }): Promise<void>;
```

- [ ] **Step 1: Add the SDK clients**

Run: `npm install --save-exact -w @agentx/cli @aws-sdk/client-dynamodb@3.1134.0 @aws-sdk/client-kms@3.1134.0 @aws-sdk/client-cloudwatch-logs@3.1134.0`
Expected: `packages/cli/package.json` lists the three at `3.1134.0`; `package-lock.json` changes.

- [ ] **Step 2: Write the failing test**

Create `tests/contract/destroy-aws.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { awsDestroyApi, type DestroyApi, type DestroyStack } from "../../packages/cli/src/destroy/aws.js";
import { deleteVolumesWhenFree, STACK_DELETE_TIMEOUT_MS, waitForStackDelete } from "../../packages/cli/src/destroy/wait.js";

type Handler = (input: Record<string, unknown>) => unknown;
/** One fake client per service, answering by command name; every call is recorded in order. */
function fakeClients(handlers: Record<string, Handler>) {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const client = {
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      const name = command.constructor.name.replace(/Command$/, "");
      calls.push({ name, input: command.input });
      const handler = handlers[name];
      if (handler === undefined) throw new Error(`test setup: no handler for ${name}`);
      return handler(command.input);
    },
  };
  return { calls, clients: { cloudFormation: client, ec2: client, s3: client, dynamodb: client, logs: client, cognito: client, kms: client, secrets: client } };
}
const notFound = (name: string) => () => { throw Object.assign(new Error(`${name}`), { name }); };

describe("the destroy adapter", () => {
  it("empties a versioned bucket in batches of at most 1,000, every version and delete marker, then deletes it", async () => {
    const versions = Array.from({ length: 1100 }, (_, index) => ({ Key: `k${index}`, VersionId: `v${index}` }));
    let listed = 0;
    const fake = fakeClients({
      ListObjectVersions: () => (listed++ === 0 ? { Versions: versions, DeleteMarkers: [{ Key: "gone", VersionId: "m1" }], IsTruncated: true, NextKeyMarker: "k1099", NextVersionIdMarker: "v1099" } : { Versions: [{ Key: "last", VersionId: "v" }], IsTruncated: false }),
      DeleteObjects: () => ({ Errors: [] }),
      DeleteBucket: () => ({}),
    });
    const progress: number[] = [];
    await awsDestroyApi(fake.clients).deleteBucket("agentx-staging-control-plane-artifacts-1", (count) => progress.push(count));
    const batches = fake.calls.filter((call) => call.name === "DeleteObjects").map((call) => ((call.input.Delete as { Objects: unknown[] }).Objects).length);
    expect(batches.every((size) => size <= 1000)).toBe(true);
    expect(batches.reduce((sum, size) => sum + size, 0)).toBe(1102);
    expect(fake.calls.at(-1)?.name).toBe("DeleteBucket");
    expect(progress.at(-1)).toBe(1102);
  });

  it("treats a bucket that is already gone as deleted", async () => {
    const fake = fakeClients({ ListObjectVersions: notFound("NoSuchBucket") });
    await expect(awsDestroyApi(fake.clients).deleteBucket("b", () => undefined)).resolves.toBeUndefined();
  });

  it("turns a user pool's deletion protection off and deletes its own domain before the pool, refusing a domain that is not its own", async () => {
    const fake = fakeClients({
      DescribeUserPool: () => ({ UserPool: { Id: "us-east-1_AbC", DeletionProtection: "ACTIVE", Domain: "agentx-staging-123456789012" } }),
      UpdateUserPool: () => ({}), DeleteUserPoolDomain: () => ({}), DeleteUserPool: () => ({}),
    });
    await awsDestroyApi(fake.clients).deleteUserPool("us-east-1_AbC", "agentx-staging-123456789012");
    expect(fake.calls.map((call) => call.name)).toEqual(["DescribeUserPool", "UpdateUserPool", "DeleteUserPoolDomain", "DeleteUserPool"]);
    expect(fake.calls[1]!.input).toMatchObject({ UserPoolId: "us-east-1_AbC", DeletionProtection: "INACTIVE" });
    const foreign = fakeClients({ DescribeUserPool: () => ({ UserPool: { Id: "us-east-1_AbC", DeletionProtection: "INACTIVE", Domain: "someone-else" } }) });
    await expect(awsDestroyApi(foreign.clients).deleteUserPool("us-east-1_AbC", "agentx-staging-123456789012")).rejects.toThrow("user pool us-east-1_AbC has the domain someone-else, which is not agentx-staging-123456789012; delete that domain yourself, then run agentx destroy again");
  });

  it("finds workers by all three tags, and drops any answer that does not carry them", async () => {
    const fake = fakeClients({
      DescribeInstances: () => ({ Reservations: [{ Instances: [
        { InstanceId: "i-1", State: { Name: "running" }, Tags: [{ Key: "DeploymentMode", Value: "ec2-ebs" }, { Key: "Environment", Value: "staging" }, { Key: "agentx:env", Value: "staging" }] },
        { InstanceId: "i-2", State: { Name: "running" }, Tags: [{ Key: "DeploymentMode", Value: "ec2-ebs" }, { Key: "Environment", Value: "staging" }] },
      ] }] }),
    });
    const found = await awsDestroyApi(fake.clients).workerInstances("staging");
    expect(found.map((instance) => instance.id)).toEqual(["i-1"]);
    expect(fake.calls[0]!.input.Filters).toEqual(expect.arrayContaining([
      { Name: "tag:DeploymentMode", Values: ["ec2-ebs"] }, { Name: "tag:Environment", Values: ["staging"] }, { Name: "tag:agentx:env", Values: ["staging"] },
    ]));
  });

  it("lists only this environment's secrets, and force-deletes one already scheduled for deletion by restoring it first", async () => {
    const fake = fakeClients({
      ListSecrets: () => ({ SecretList: [{ Name: "agentx/staging/slack" }, { Name: "agentx/staging-eu/slack" }, { Name: "agentx/staging/github-app", DeletedDate: new Date() }] }),
      RestoreSecret: () => ({}), DeleteSecret: () => ({}),
    });
    const api = awsDestroyApi(fake.clients);
    expect(await api.secrets("staging")).toEqual([{ name: "agentx/staging/slack", scheduled: false }, { name: "agentx/staging/github-app", scheduled: true }]);
    expect(fake.calls[0]!.input).toMatchObject({ Filters: [{ Key: "name", Values: ["agentx/staging/"] }], IncludePlannedDeletion: true });
    await api.deleteSecret("agentx/staging/github-app", true);
    expect(fake.calls.slice(-2).map((call) => call.name)).toEqual(["RestoreSecret", "DeleteSecret"]);
    expect(fake.calls.at(-1)!.input).toEqual({ SecretId: "agentx/staging/github-app", ForceDeleteWithoutRecovery: true });
  });

  it("schedules a KMS key's deletion in 7 days, once", async () => {
    let state = "Enabled";
    const fake = fakeClients({ DescribeKey: () => ({ KeyMetadata: { KeyState: state } }), ScheduleKeyDeletion: () => { state = "PendingDeletion"; return {}; } });
    const api = awsDestroyApi(fake.clients);
    expect(await api.scheduleKeyDeletion("k-1")).toBe("scheduled");
    expect(fake.calls.find((call) => call.name === "ScheduleKeyDeletion")!.input).toEqual({ KeyId: "k-1", PendingWindowInDays: 7 });
    expect(await api.scheduleKeyDeletion("k-1")).toBe("already");
  });

  it("reads a table's tags through its ARN, and answers undefined for one already gone", async () => {
    const fake = fakeClients({ DescribeTable: () => ({ Table: { TableArn: "arn:aws:dynamodb:us-east-1:1:table/t" } }), ListTagsOfResource: () => ({ Tags: [{ Key: "agentx:env", Value: "staging" }] }) });
    expect(await awsDestroyApi(fake.clients).resourceTags({ part: "control-plane", logicalId: "State", type: "AWS::DynamoDB::Table", physicalId: "t" })).toEqual({ "agentx:env": "staging" });
    const gone = fakeClients({ DescribeTable: notFound("ResourceNotFoundException") });
    expect(await awsDestroyApi(gone.clients).resourceTags({ part: "control-plane", logicalId: "State", type: "AWS::DynamoDB::Table", physicalId: "t" })).toBeUndefined();
  });
});

describe("waiting for a stack delete", () => {
  function stackApi(statuses: Array<string | undefined>): DestroyApi {
    let index = 0;
    return {
      stack: async (): Promise<DestroyStack | undefined> => { const status = statuses[Math.min(index++, statuses.length - 1)]; return status === undefined ? undefined : { status, terminationProtection: false, outputs: {} }; },
      latestEvent: async () => "SlackIngressFunction DELETE_IN_PROGRESS",
      failedResources: async () => ["WorkerSecurityGroup: resource sg-1 has a dependent object"],
    } as unknown as DestroyApi;
  }
  const clock = () => { let time = 0; return { now: () => time, sleep: async (ms: number) => { time += ms; } }; };

  it("waits through a 40-minute control-plane delete, with a progress line each minute, and never gives up early", async () => {
    const statuses = [...Array.from({ length: 160 }, () => "DELETE_IN_PROGRESS"), undefined];
    const lines: string[] = [];
    await waitForStackDelete({ api: stackApi(statuses), name: "agentx-staging-control-plane", write: (line) => lines.push(line), ...clock() });
    expect(lines.filter((line) => line.startsWith("still deleting agentx-staging-control-plane")).length).toBeGreaterThanOrEqual(39);
    expect(lines).toContain("still deleting agentx-staging-control-plane: 1 minute so far; last event: SlackIngressFunction DELETE_IN_PROGRESS");
    expect(lines.at(-1)).toBe("deleted agentx-staging-control-plane (40 minutes)");
  });

  it("gives up only after 3 hours, saying a re-run keeps waiting", async () => {
    const time = clock();
    await expect(waitForStackDelete({ api: stackApi(["DELETE_IN_PROGRESS"]), name: "s", write: () => undefined, ...time })).rejects.toThrow("stack s is still DELETE_IN_PROGRESS after 3 hours; it may still finish. Run agentx destroy again to keep waiting and continue");
    expect(time.now()).toBeGreaterThanOrEqual(STACK_DELETE_TIMEOUT_MS);
  });

  it("stops on DELETE_FAILED with the failing resources", async () => {
    await expect(waitForStackDelete({ api: stackApi(["DELETE_FAILED"]), name: "agentx-staging-foundation", write: () => undefined, ...clock() }))
      .rejects.toThrow("stack agentx-staging-foundation could not be deleted: WorkerSecurityGroup: resource sg-1 has a dependent object. Fix that, then run agentx destroy again to continue");
  });

  it("retries a volume that is still attached until it is free", async () => {
    let attempts = 0;
    const api = { deleteVolume: async () => { attempts += 1; if (attempts < 3) throw Object.assign(new Error("in use"), { name: "VolumeInUse" }); } } as unknown as DestroyApi;
    await deleteVolumesWhenFree({ api, ids: ["vol-1"], ...clock() });
    expect(attempts).toBe(3);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/contract/destroy-aws.test.ts`
Expected: FAIL: the modules do not exist.

- [ ] **Step 4: Implement**

Create `packages/cli/src/destroy/aws.ts`:

```ts
// agentx destroy's AWS calls, one method per step, each treating "already gone" as done so a
// re-run after a failure continues. Run with admin credentials (question 7).
import { DeleteStackCommand, DescribeStackEventsCommand, DescribeStacksCommand, GetTemplateCommand, ListStackResourcesCommand, UpdateTerminationProtectionCommand, type Stack } from "@aws-sdk/client-cloudformation";
import { DeleteUserPoolCommand, DeleteUserPoolDomainCommand, DescribeUserPoolCommand, UpdateUserPoolCommand } from "@aws-sdk/client-cognito-identity-provider";
import { DeleteTableCommand, DescribeTableCommand, ListTagsOfResourceCommand, UpdateTableCommand } from "@aws-sdk/client-dynamodb";
import { DeleteVolumeCommand, DescribeInstancesCommand, DescribeVolumesCommand, TerminateInstancesCommand } from "@aws-sdk/client-ec2";
import { DeleteAliasCommand, DescribeKeyCommand, ListAliasesCommand, ListResourceTagsCommand, ScheduleKeyDeletionCommand } from "@aws-sdk/client-kms";
import { DeleteLogGroupCommand, DescribeLogGroupsCommand, ListTagsForResourceCommand } from "@aws-sdk/client-cloudwatch-logs";
import { DeleteBucketCommand, DeleteObjectsCommand, GetBucketTaggingCommand, ListObjectVersionsCommand } from "@aws-sdk/client-s3";
import { DeleteSecretCommand, DescribeSecretCommand, ListSecretsCommand, RestoreSecretCommand } from "@aws-sdk/client-secrets-manager";
import { agentXError } from "@agentx/contracts";
import type { RetainedResource } from "./inventory.js";
import { isOwnedAlias, isOwnedSecret, isOwnedWorker } from "./names.js";

export interface DestroyStack { status: string; terminationProtection: boolean; roleArn?: string; outputs: Record<string, string> }
export interface DestroyApi {
  stack(name: string): Promise<DestroyStack | undefined>;
  template(name: string): Promise<string>;
  stackResources(name: string): Promise<Array<{ logicalId: string; type: string; physicalId: string | undefined }>>;
  disableTerminationProtection(name: string): Promise<void>;
  deleteStack(name: string): Promise<void>;
  latestEvent(name: string): Promise<string | undefined>;
  failedResources(name: string): Promise<string[]>;
  workerInstances(env: string): Promise<Array<{ id: string; state: string; tags: Record<string, string> }>>;
  terminateInstances(ids: string[]): Promise<void>;
  workerVolumes(env: string): Promise<Array<{ id: string; state: string; tags: Record<string, string> }>>;
  deleteVolume(id: string): Promise<void>;
  resourceTags(resource: RetainedResource): Promise<Record<string, string> | undefined>;
  deleteBucket(name: string, onProgress: (deleted: number) => void): Promise<void>;
  deleteTable(name: string): Promise<void>;
  deleteLogGroup(name: string): Promise<void>;
  deleteUserPool(id: string, domainPrefix: string): Promise<void>;
  scheduleKeyDeletion(keyId: string): Promise<"scheduled" | "already">;
  aliases(env: string): Promise<Array<{ name: string }>>;
  deleteAlias(name: string): Promise<void>;
  secrets(env: string): Promise<Array<{ name: string; scheduled: boolean }>>;
  deleteSecret(name: string, scheduled: boolean): Promise<void>;
}

type Send = { send(command: unknown): Promise<unknown> };
const GONE = new Set(["NoSuchBucket", "ResourceNotFoundException", "NotFoundException", "InvalidVolume.NotFound", "NoSuchEntity"]);
const isGone = (error: unknown) => error instanceof Error && (GONE.has(error.name) || (error.name === "ValidationError" && /does not exist/.test(error.message)));
async function unlessGone<T>(run: () => Promise<T>, gone: T): Promise<T> {
  try { return await run(); } catch (error) { if (isGone(error)) return gone; throw error; }
}
const tagMap = (tags: Array<{ Key?: string; Value?: string }> | undefined) => Object.fromEntries((tags ?? []).flatMap((tag) => (tag.Key === undefined ? [] : [[tag.Key, tag.Value ?? ""]])));
const workerFilters = (env: string) => [
  { Name: "tag:DeploymentMode", Values: ["ec2-ebs"] }, { Name: "tag:Environment", Values: [env] }, { Name: "tag:agentx:env", Values: [env] },
];

export function awsDestroyApi(clients: { cloudFormation: Send; ec2: Send; s3: Send; dynamodb: Send; logs: Send; cognito: Send; kms: Send; secrets: Send }): DestroyApi {
  const { cloudFormation, ec2, s3, dynamodb, logs, cognito, kms, secrets } = clients;
  const events = async (name: string) => ((await cloudFormation.send(new DescribeStackEventsCommand({ StackName: name }))) as { StackEvents?: Array<{ LogicalResourceId?: string; ResourceStatus?: string; ResourceStatusReason?: string }> }).StackEvents ?? [];
  return {
    stack: (name) => unlessGone(async () => {
      const stack = ((await cloudFormation.send(new DescribeStacksCommand({ StackName: name }))) as { Stacks?: Stack[] }).Stacks?.[0];
      if (stack === undefined || stack.StackStatus === "DELETE_COMPLETE") return undefined;
      return {
        status: stack.StackStatus ?? "UNKNOWN", terminationProtection: stack.EnableTerminationProtection === true,
        ...(stack.RoleARN === undefined ? {} : { roleArn: stack.RoleARN }),
        outputs: tagMap((stack.Outputs ?? []).map((output) => ({ Key: output.OutputKey, Value: output.OutputValue }))),
      };
    }, undefined),
    async template(name) {
      return ((await cloudFormation.send(new GetTemplateCommand({ StackName: name, TemplateStage: "Original" }))) as { TemplateBody?: string }).TemplateBody ?? "{}";
    },
    async stackResources(name) {
      const resources: Array<{ logicalId: string; type: string; physicalId: string | undefined }> = [];
      let token: string | undefined;
      do {
        const page = (await cloudFormation.send(new ListStackResourcesCommand({ StackName: name, ...(token === undefined ? {} : { NextToken: token }) }))) as { StackResourceSummaries?: Array<{ LogicalResourceId?: string; ResourceType?: string; PhysicalResourceId?: string }>; NextToken?: string };
        resources.push(...(page.StackResourceSummaries ?? []).map((entry) => ({ logicalId: entry.LogicalResourceId ?? "", type: entry.ResourceType ?? "", physicalId: entry.PhysicalResourceId })));
        token = page.NextToken;
      } while (token !== undefined);
      return resources;
    },
    async disableTerminationProtection(name) { await cloudFormation.send(new UpdateTerminationProtectionCommand({ StackName: name, EnableTerminationProtection: false })); },
    // No RoleARN: CloudFormation deletes with the role the stack was deployed through.
    async deleteStack(name) { await cloudFormation.send(new DeleteStackCommand({ StackName: name })); },
    async latestEvent(name) {
      const latest = (await events(name))[0];
      return latest === undefined ? undefined : `${latest.LogicalResourceId ?? "stack"} ${latest.ResourceStatus ?? ""}`.trim();
    },
    async failedResources(name) {
      return (await events(name)).filter((event) => event.ResourceStatus === "DELETE_FAILED" && event.LogicalResourceId !== name).map((event) => `${event.LogicalResourceId ?? "resource"}: ${event.ResourceStatusReason ?? "no reason given"}`);
    },
    async workerInstances(env) {
      const found: Array<{ id: string; state: string; tags: Record<string, string> }> = [];
      let token: string | undefined;
      do {
        const page = (await ec2.send(new DescribeInstancesCommand({ Filters: [...workerFilters(env), { Name: "instance-state-name", Values: ["pending", "running", "stopping", "stopped", "shutting-down"] }], ...(token === undefined ? {} : { NextToken: token }) }))) as { Reservations?: Array<{ Instances?: Array<{ InstanceId?: string; State?: { Name?: string }; Tags?: Array<{ Key?: string; Value?: string }> }> }>; NextToken?: string };
        for (const instance of (page.Reservations ?? []).flatMap((reservation) => reservation.Instances ?? [])) {
          const tags = tagMap(instance.Tags);
          if (instance.InstanceId !== undefined && isOwnedWorker(env, tags)) found.push({ id: instance.InstanceId, state: instance.State?.Name ?? "unknown", tags });
        }
        token = page.NextToken;
      } while (token !== undefined);
      return found;
    },
    async terminateInstances(ids) { if (ids.length > 0) await ec2.send(new TerminateInstancesCommand({ InstanceIds: ids })); },
    async workerVolumes(env) {
      const found: Array<{ id: string; state: string; tags: Record<string, string> }> = [];
      let token: string | undefined;
      do {
        const page = (await ec2.send(new DescribeVolumesCommand({ Filters: workerFilters(env), ...(token === undefined ? {} : { NextToken: token }) }))) as { Volumes?: Array<{ VolumeId?: string; State?: string; Tags?: Array<{ Key?: string; Value?: string }> }>; NextToken?: string };
        for (const volume of page.Volumes ?? []) {
          const tags = tagMap(volume.Tags);
          if (volume.VolumeId !== undefined && isOwnedWorker(env, tags)) found.push({ id: volume.VolumeId, state: volume.State ?? "unknown", tags });
        }
        token = page.NextToken;
      } while (token !== undefined);
      return found;
    },
    async deleteVolume(id) { await unlessGone(() => ec2.send(new DeleteVolumeCommand({ VolumeId: id })), undefined); },
    async resourceTags(resource) {
      const id = resource.physicalId;
      switch (resource.type) {
        case "AWS::S3::Bucket":
          try {
            return tagMap(((await s3.send(new GetBucketTaggingCommand({ Bucket: id }))) as { TagSet?: Array<{ Key?: string; Value?: string }> }).TagSet);
          } catch (error) {
            if (error instanceof Error && error.name === "NoSuchTagSet") return {};
            if (isGone(error)) return undefined;
            throw error;
          }
        case "AWS::DynamoDB::Table":
          return unlessGone(async () => {
            const arn = ((await dynamodb.send(new DescribeTableCommand({ TableName: id }))) as { Table?: { TableArn?: string } }).Table?.TableArn;
            return arn === undefined ? undefined : tagMap(((await dynamodb.send(new ListTagsOfResourceCommand({ ResourceArn: arn }))) as { Tags?: Array<{ Key?: string; Value?: string }> }).Tags);
          }, undefined);
        case "AWS::Logs::LogGroup":
          return unlessGone(async () => {
            const groups = ((await logs.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: id }))) as { logGroups?: Array<{ logGroupName?: string; logGroupArn?: string }> }).logGroups ?? [];
            const arn = groups.find((group) => group.logGroupName === id)?.logGroupArn;
            return arn === undefined ? undefined : ((await logs.send(new ListTagsForResourceCommand({ resourceArn: arn }))) as { tags?: Record<string, string> }).tags ?? {};
          }, undefined);
        case "AWS::Cognito::UserPool":
          return unlessGone(async () => ((await cognito.send(new DescribeUserPoolCommand({ UserPoolId: id }))) as { UserPool?: { UserPoolTags?: Record<string, string> } }).UserPool?.UserPoolTags ?? {}, undefined);
        case "AWS::KMS::Key":
          return unlessGone(async () => Object.fromEntries((((await kms.send(new ListResourceTagsCommand({ KeyId: id }))) as { Tags?: Array<{ TagKey?: string; TagValue?: string }> }).Tags ?? []).flatMap((tag) => (tag.TagKey === undefined ? [] : [[tag.TagKey, tag.TagValue ?? ""]]))), undefined);
        case "AWS::SecretsManager::Secret":
          return unlessGone(async () => tagMap(((await secrets.send(new DescribeSecretCommand({ SecretId: id }))) as { Tags?: Array<{ Key?: string; Value?: string }> }).Tags), undefined);
        default:
          return {};
      }
    },
    async deleteBucket(name, onProgress) {
      let deleted = 0;
      let keyMarker: string | undefined;
      let versionMarker: string | undefined;
      try {
        for (;;) {
          const page = (await s3.send(new ListObjectVersionsCommand({ Bucket: name, ...(keyMarker === undefined ? {} : { KeyMarker: keyMarker }), ...(versionMarker === undefined ? {} : { VersionIdMarker: versionMarker }) }))) as { Versions?: Array<{ Key?: string; VersionId?: string }>; DeleteMarkers?: Array<{ Key?: string; VersionId?: string }>; IsTruncated?: boolean; NextKeyMarker?: string; NextVersionIdMarker?: string };
          const objects = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])].flatMap((entry) => (entry.Key === undefined ? [] : [{ Key: entry.Key, ...(entry.VersionId === undefined ? {} : { VersionId: entry.VersionId }) }]));
          for (let start = 0; start < objects.length; start += 1000) {
            const batch = objects.slice(start, start + 1000);
            const result = (await s3.send(new DeleteObjectsCommand({ Bucket: name, Delete: { Objects: batch, Quiet: true } }))) as { Errors?: Array<{ Key?: string; Code?: string }> };
            if ((result.Errors ?? []).length > 0) throw agentXError("RUNTIME_UNAVAILABLE", `bucket ${name}: ${result.Errors!.length} objects could not be deleted (${result.Errors![0]?.Code ?? "no code"}); run agentx destroy again`);
            deleted += batch.length;
            onProgress(deleted);
          }
          if (page.IsTruncated !== true) break;
          keyMarker = page.NextKeyMarker;
          versionMarker = page.NextVersionIdMarker;
        }
        await s3.send(new DeleteBucketCommand({ Bucket: name }));
      } catch (error) {
        if (isGone(error)) return;
        throw error;
      }
    },
    async deleteTable(name) {
      await unlessGone(async () => {
        const table = ((await dynamodb.send(new DescribeTableCommand({ TableName: name }))) as { Table?: { DeletionProtectionEnabled?: boolean } }).Table;
        if (table?.DeletionProtectionEnabled === true) await dynamodb.send(new UpdateTableCommand({ TableName: name, DeletionProtectionEnabled: false }));
        await dynamodb.send(new DeleteTableCommand({ TableName: name }));
      }, undefined);
    },
    async deleteLogGroup(name) { await unlessGone(() => logs.send(new DeleteLogGroupCommand({ logGroupName: name })), undefined); },
    async deleteUserPool(id, domainPrefix) {
      await unlessGone(async () => {
        const pool = ((await cognito.send(new DescribeUserPoolCommand({ UserPoolId: id }))) as { UserPool?: { DeletionProtection?: string; Domain?: string } }).UserPool;
        if (pool === undefined) return;
        if (pool.Domain !== undefined && pool.Domain !== domainPrefix) {
          throw agentXError("CONFIG_INVALID", `user pool ${id} has the domain ${pool.Domain}, which is not ${domainPrefix}; delete that domain yourself, then run agentx destroy again`);
        }
        // UpdateUserPool resets settings it is not given; the pool is deleted next, so that is fine.
        if (pool.DeletionProtection === "ACTIVE") await cognito.send(new UpdateUserPoolCommand({ UserPoolId: id, DeletionProtection: "INACTIVE" }));
        if (pool.Domain !== undefined) await cognito.send(new DeleteUserPoolDomainCommand({ UserPoolId: id, Domain: pool.Domain }));
        await cognito.send(new DeleteUserPoolCommand({ UserPoolId: id }));
      }, undefined);
    },
    async scheduleKeyDeletion(keyId) {
      const state = ((await kms.send(new DescribeKeyCommand({ KeyId: keyId }))) as { KeyMetadata?: { KeyState?: string } }).KeyMetadata?.KeyState;
      if (state === "PendingDeletion") return "already";
      await kms.send(new ScheduleKeyDeletionCommand({ KeyId: keyId, PendingWindowInDays: 7 }));
      return "scheduled";
    },
    async aliases(env) {
      const found: Array<{ name: string }> = [];
      let marker: string | undefined;
      do {
        const page = (await kms.send(new ListAliasesCommand({ ...(marker === undefined ? {} : { Marker: marker }) }))) as { Aliases?: Array<{ AliasName?: string }>; NextMarker?: string; Truncated?: boolean };
        found.push(...(page.Aliases ?? []).flatMap((alias) => (alias.AliasName !== undefined && isOwnedAlias(env, alias.AliasName) ? [{ name: alias.AliasName }] : [])));
        marker = page.Truncated === true ? page.NextMarker : undefined;
      } while (marker !== undefined);
      return found;
    },
    async deleteAlias(name) { await unlessGone(() => kms.send(new DeleteAliasCommand({ AliasName: name })), undefined); },
    async secrets(env) {
      const found: Array<{ name: string; scheduled: boolean }> = [];
      let token: string | undefined;
      do {
        const page = (await secrets.send(new ListSecretsCommand({ Filters: [{ Key: "name", Values: [`agentx/${env}/`] }], IncludePlannedDeletion: true, ...(token === undefined ? {} : { NextToken: token }) }))) as { SecretList?: Array<{ Name?: string; DeletedDate?: Date }>; NextToken?: string };
        found.push(...(page.SecretList ?? []).flatMap((secret) => (secret.Name !== undefined && isOwnedSecret(env, secret.Name) ? [{ name: secret.Name, scheduled: secret.DeletedDate !== undefined }] : [])));
        token = page.NextToken;
      } while (token !== undefined);
      return found;
    },
    async deleteSecret(name, scheduled) {
      await unlessGone(async () => {
        // A secret already scheduled for deletion keeps its name until the window ends; restoring it
        // first lets the force delete free the name for a reinstall now.
        if (scheduled) await secrets.send(new RestoreSecretCommand({ SecretId: name }));
        await secrets.send(new DeleteSecretCommand({ SecretId: name, ForceDeleteWithoutRecovery: true }));
      }, undefined);
    },
  };
}
```

Create `packages/cli/src/destroy/wait.ts`:

```ts
// Waiting for AWS during agentx destroy: never giving up early (the control-plane delete takes 20
// to 40 minutes while its VPC Lambda functions release their network interfaces, live 2026-09-28),
// and always saying what it is waiting for.
import { agentXError } from "@agentx/contracts";
import type { DestroyApi } from "./aws.js";

export const STACK_DELETE_TIMEOUT_MS = 3 * 60 * 60 * 1000;
const POLL_MS = 15_000;
const NOTICE_MS = 60_000;
const WORKER_TIMEOUT_MS = 30 * 60_000;

const minutes = (ms: number) => { const count = Math.round(ms / 60_000); return `${count} ${count === 1 ? "minute" : "minutes"}`; };

export async function waitForStackDelete(input: { api: DestroyApi; name: string; write: (line: string) => void; sleep: (ms: number) => Promise<void>; now: () => number; pollMs?: number; noticeMs?: number; timeoutMs?: number }): Promise<void> {
  const { api, name } = input;
  const timeout = input.timeoutMs ?? STACK_DELETE_TIMEOUT_MS;
  const started = input.now();
  let noticed = started;
  for (;;) {
    const stack = await api.stack(name);
    if (stack === undefined) {
      input.write(`deleted ${name} (${minutes(input.now() - started)})`);
      return;
    }
    if (stack.status === "DELETE_FAILED") {
      const reasons = await api.failedResources(name);
      throw agentXError("RUNTIME_UNAVAILABLE", `stack ${name} could not be deleted: ${reasons.join("; ") || "no reason given"}. Fix that, then run agentx destroy again to continue`);
    }
    if (input.now() - started >= timeout) {
      throw agentXError("RUNTIME_UNAVAILABLE", `stack ${name} is still ${stack.status} after ${Math.round(timeout / 3_600_000)} hours; it may still finish. Run agentx destroy again to keep waiting and continue`);
    }
    if (input.now() - noticed >= (input.noticeMs ?? NOTICE_MS)) {
      const event = await api.latestEvent(name);
      input.write(`still deleting ${name}: ${minutes(input.now() - started)} so far${event === undefined ? "" : `; last event: ${event}`}`);
      noticed = input.now();
    }
    await input.sleep(input.pollMs ?? POLL_MS);
  }
}

export async function waitForInstancesGone(input: { api: DestroyApi; env: string; ids: string[]; sleep: (ms: number) => Promise<void>; now: () => number; timeoutMs?: number }): Promise<void> {
  const started = input.now();
  for (;;) {
    const left = (await input.api.workerInstances(input.env)).filter((instance) => input.ids.includes(instance.id) && instance.state !== "terminated");
    if (left.length === 0) return;
    if (input.now() - started >= (input.timeoutMs ?? WORKER_TIMEOUT_MS)) {
      throw agentXError("RUNTIME_UNAVAILABLE", `worker instances ${left.map((instance) => instance.id).join(", ")} are still ${left[0]?.state ?? "running"} after 30 minutes; check them in the EC2 console, then run agentx destroy again`);
    }
    await input.sleep(POLL_MS);
  }
}

export async function deleteVolumesWhenFree(input: { api: DestroyApi; ids: string[]; sleep: (ms: number) => Promise<void>; now: () => number; timeoutMs?: number }): Promise<void> {
  const started = input.now();
  for (const id of input.ids) {
    for (;;) {
      try {
        await input.api.deleteVolume(id);
        break;
      } catch (error) {
        if (!(error instanceof Error && error.name === "VolumeInUse")) throw error;
        if (input.now() - started >= (input.timeoutMs ?? WORKER_TIMEOUT_MS)) throw agentXError("RUNTIME_UNAVAILABLE", `volume ${id} is still attached after 30 minutes; check it in the EC2 console, then run agentx destroy again`);
        await input.sleep(POLL_MS);
      }
    }
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/contract/destroy-aws.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/package.json package-lock.json packages/cli/src/destroy/aws.ts packages/cli/src/destroy/wait.ts tests/contract/destroy-aws.test.ts
git commit -m "feat(destroy): the AWS adapter (versioned buckets, user pool protection, KMS, secrets, tagged workers) and patient waits"
```

### Task 16: `destroy`'s ordered teardown

**Files:**
- Create: `packages/cli/src/destroy/run.ts`
- Create: `tests/support/destroy-fakes.ts`
- Test: `tests/contract/destroy-run.test.ts`

Depends on questions 1, 2 and 7.

**Interfaces:**
- Consumes: Tasks 14 and 15; `environmentProjectFiles` (Task 7); `withEnvironmentLock`;
  `readEnvironmentSettings`, `settingsParameterName`, `lockParameterName`; `readInstallAnswers`,
  `readInstallProgress`; `environmentCachePath`; `tokenStoreKey`; `isOperatorRole`.
- Produces:

```ts
export interface DestroyDependencies {
  store: ParameterStore; api: DestroyApi; identity: CallerIdentity;
  /** Shows the question and reads one typed line (a terminal, or piped stdin: question 11). */
  confirmLine: (question: string) => Promise<string>;
  write: (line: string) => void; sleep: (ms: number) => Promise<void>; now: () => number;
  home: string; configDir: string; tokenStore: TokenStore; region: string;
}
export interface DestroyResult {
  env: string; removed: boolean; stacksDeleted: string[]; instances: number; volumes: number;
  retainedDeleted: string[]; kept: string[]; leftInPlace: string[]; secrets: number; parameters: number; localFiles: string[]; manualSteps: string[];
}
export function runDestroy(options: { env: string; keepData: boolean }, deps: DestroyDependencies): Promise<DestroyResult>;
```

- [ ] **Step 1: Write the fakes and the failing test**

Create `tests/support/destroy-fakes.ts`:

```ts
// An AWS account in memory for agentx destroy: stacks that take simulated minutes to delete,
// worker instances and volumes, retained resources with tags, and secrets. Every mutating call is
// recorded in order in `calls`.
import { environmentStackName, type StackPart } from "@agentx/contracts";
import type { DestroyApi, DestroyStack } from "../../packages/cli/src/destroy/aws.js";
import type { RetainedResource } from "../../packages/cli/src/destroy/inventory.js";

export interface FakeStack extends DestroyStack { template: string; resources: Array<{ logicalId: string; type: string; physicalId: string }>; deleteMinutes?: number; failDeletes?: number }
export interface FakeAccount {
  stacks: Map<string, FakeStack>;
  instances: Array<{ id: string; state: string; tags: Record<string, string> }>;
  volumes: Array<{ id: string; state: string; tags: Record<string, string> }>;
  tags: Map<string, Record<string, string>>;   // physical id -> tags; absent means gone
  secrets: Array<{ name: string; scheduled: boolean }>;
  aliases: string[];
  calls: string[];
}

export const retainedTemplate = (resources: Array<{ logicalId: string; type: string }>) => JSON.stringify({ Resources: Object.fromEntries(resources.map((resource) => [resource.logicalId, { Type: resource.type, DeletionPolicy: "RetainExceptOnCreate" }])) });

/** A fully installed environment `env` in account 123456789012, with one worker, two volumes and the usual retained resources. */
export function installedAccount(env = "staging"): FakeAccount {
  const stack = (part: StackPart, resources: FakeStack["resources"] = [], extra: Partial<FakeStack> = {}): [string, FakeStack] => [environmentStackName(env, part), {
    status: "UPDATE_COMPLETE", terminationProtection: ["access", "foundation", "identity", "runtime"].includes(part), outputs: {},
    ...(part === "access" ? {} : { roleArn: `arn:aws:iam::123456789012:role/agentx-${env}-cloudformation` }),
    template: retainedTemplate(resources), resources, ...extra,
  }];
  const account: FakeAccount = {
    stacks: new Map([
      stack("access", [{ logicalId: "ArtifactBucket", type: "AWS::S3::Bucket", physicalId: `agentx-${env}-access-artifactbucket-1a` }]),
      stack("foundation", [{ logicalId: "VpcFlowLogs", type: "AWS::Logs::LogGroup", physicalId: `agentx-${env}-foundation-VpcFlowLogs-2b` }, { logicalId: "WorkspaceKey", type: "AWS::KMS::Key", physicalId: "key-3c" }], { outputs: { Ec2WorkerLaunchTemplateId: "lt-0123456789abcdef0" } }),
      stack("identity", [{ logicalId: "UserPool", type: "AWS::Cognito::UserPool", physicalId: "us-east-1_Pool4d" }]),
      stack("control-plane", [
        { logicalId: "State", type: "AWS::DynamoDB::Table", physicalId: `agentx-${env}-control-plane-State-5e` },
        { logicalId: "SlackThreadSessions", type: "AWS::S3::Bucket", physicalId: `agentx-${env}-control-plane-slackthreadsessions-6f` },
        { logicalId: "SlackSecret", type: "AWS::SecretsManager::Secret", physicalId: `arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/${env}/slack-AbCdEf` },
      ], { deleteMinutes: 30 }),
      stack("runtime"),
      stack("slack"),
    ]),
    instances: [{ id: "i-worker1", state: "running", tags: { DeploymentMode: "ec2-ebs", Environment: env, "agentx:env": env } }],
    volumes: [
      { id: "vol-root1", state: "in-use", tags: { DeploymentMode: "ec2-ebs", Environment: env, "agentx:env": env } },
      { id: "vol-ws1", state: "available", tags: { DeploymentMode: "ec2-ebs", Environment: env, "agentx:env": env } },
    ],
    tags: new Map(),
    secrets: [{ name: `agentx/${env}/slack`, scheduled: false }, { name: `agentx/${env}/callback-signing-key`, scheduled: false }, { name: `agentx/${env}/github-app`, scheduled: false }],
    aliases: [`alias/agentx/${env}/workspaces`],
    calls: [],
  };
  for (const [, entry] of account.stacks) for (const resource of entry.resources) account.tags.set(resource.physicalId, { "agentx:env": env });
  return account;
}

export function fakeDestroyApi(account: FakeAccount, clock: { now: () => number }): DestroyApi {
  const deleting = new Map<string, number>();   // stack name -> time the delete finishes
  const stackNow = (name: string): FakeStack | undefined => {
    const entry = account.stacks.get(name);
    const done = deleting.get(name);
    if (entry !== undefined && done !== undefined && clock.now() >= done) {
      if ((entry.failDeletes ?? 0) > 0) { entry.failDeletes = (entry.failDeletes ?? 0) - 1; entry.status = "DELETE_FAILED"; deleting.delete(name); return entry; }
      account.stacks.delete(name);
      deleting.delete(name);
      return undefined;
    }
    return entry;
  };
  const gone = (resource: RetainedResource) => account.tags.delete(resource.physicalId);
  return {
    async stack(name) { const entry = stackNow(name); return entry === undefined ? undefined : { status: entry.status, terminationProtection: entry.terminationProtection, outputs: entry.outputs, ...(entry.roleArn === undefined ? {} : { roleArn: entry.roleArn }) }; },
    async template(name) { return account.stacks.get(name)?.template ?? "{}"; },
    async stackResources(name) { return account.stacks.get(name)?.resources ?? []; },
    async disableTerminationProtection(name) { account.calls.push(`protection off ${name}`); account.stacks.get(name)!.terminationProtection = false; },
    async deleteStack(name) {
      const entry = account.stacks.get(name)!;
      if (entry.terminationProtection) throw new Error(`test: ${name} still has termination protection`);
      account.calls.push(`delete stack ${name}`);
      entry.status = "DELETE_IN_PROGRESS";
      deleting.set(name, clock.now() + (entry.deleteMinutes ?? 2) * 60_000);
    },
    async latestEvent() { return "Resource DELETE_IN_PROGRESS"; },
    async failedResources() { return ["WorkerSecurityGroup: resource has a dependent object"]; },
    async workerInstances() { return account.instances.filter((instance) => instance.state !== "terminated"); },
    async terminateInstances(ids) { account.calls.push(`terminate ${ids.join(",")}`); for (const instance of account.instances) if (ids.includes(instance.id)) instance.state = "terminated"; for (const volume of account.volumes) volume.state = "available"; },
    async workerVolumes() { return account.volumes; },
    async deleteVolume(id) { account.calls.push(`delete volume ${id}`); account.volumes = account.volumes.filter((volume) => volume.id !== id); },
    async resourceTags(resource) { return account.tags.get(resource.physicalId); },
    async deleteBucket(name, onProgress) { account.calls.push(`delete bucket ${name}`); onProgress(3); account.tags.delete(name); },
    async deleteTable(name) { account.calls.push(`delete table ${name}`); account.tags.delete(name); },
    async deleteLogGroup(name) { account.calls.push(`delete log group ${name}`); account.tags.delete(name); },
    async deleteUserPool(id, domain) { account.calls.push(`delete user pool ${id} (domain ${domain})`); account.tags.delete(id); },
    async scheduleKeyDeletion(id) { account.calls.push(`schedule key ${id}`); return "scheduled"; },
    async aliases() { return account.aliases.map((name) => ({ name })); },
    async deleteAlias(name) { account.calls.push(`delete alias ${name}`); account.aliases = account.aliases.filter((alias) => alias !== name); },
    async secrets() { return account.secrets; },
    async deleteSecret(name) { account.calls.push(`delete secret ${name}`); account.secrets = account.secrets.filter((secret) => secret.name !== name && !name.includes(`:secret:${secret.name}-`)); gone({ part: "control-plane", logicalId: "", type: "", physicalId: name }); },
  };
}
```

Create `tests/contract/destroy-run.test.ts`:

```ts
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectDefinition } from "@agentx/contracts";
import { inventoryParameterName } from "../../packages/cli/src/destroy/inventory.js";
import { runDestroy, type DestroyDependencies } from "../../packages/cli/src/destroy/run.js";
import { environmentCachePath } from "../../packages/cli/src/environments/cache.js";
import { lockParameterName } from "../../packages/cli/src/environments/lock.js";
import { settingsParameterName, writeEnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import { writeInstallAnswers, writeInstallProgress } from "../../packages/cli/src/init/install-state.js";
import { writeProjectFile } from "../../packages/cli/src/setup/project-add.js";
import { PROGRESS, SETTINGS } from "../support/doctor-fakes.js";
import { fakeDestroyApi, installedAccount, type FakeAccount } from "../support/destroy-fakes.js";
import { sampleAnswers } from "../support/init-fakes.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";
import { memoryTokenStore } from "../support/setup-fakes.js";

const ADMIN = "arn:aws:sts::123456789012:assumed-role/Admin/alice";
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function harness(input: { account?: FakeAccount; typed?: string[]; caller?: string; installed?: boolean; env?: string } = {}) {
  const env = input.env ?? "staging";
  const account = input.account ?? installedAccount(env);
  const store = new MemoryParameterStore();
  if (input.installed !== false) {
    await writeEnvironmentSettings(store, { ...SETTINGS, env, stacks: { access: `agentx-${env}-access`, foundation: `agentx-${env}-foundation`, identity: `agentx-${env}-identity`, runtime: `agentx-${env}-runtime`, "control-plane": `agentx-${env}-control-plane`, slack: `agentx-${env}-slack` } });
    await writeInstallAnswers(store, sampleAnswers({ env }));
    await writeInstallProgress(store, { ...PROGRESS, env, connectors: [{ type: "linear", ref: "linear" }] });
    store.values.set(`/agentx/${env}/worker/image`, "x");
  }
  // A sibling environment whose name extends this one: nothing of it may be touched.
  store.values.set(`/agentx/${env}-eu/settings`, "{}");
  const home = await mkdtemp(join(tmpdir(), "agentx-destroy-home-"));
  const configDir = join(home, ".agentx", "projects");
  dirs.push(home);
  await mkdir(join(home, ".agentx", "environments"), { recursive: true });
  await writeFile(environmentCachePath(home, env), "env: x\n");
  const binding = (lt: string) => ({ deploymentMode: "ec2-ebs", launchTemplateId: lt, subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0aaa1111bbbb2222c" }], volumeSizeGib: "20", volumeType: "gp3" }) as never;
  await writeProjectFile(configDir, { name: "payments", revision: 1 } as unknown as ProjectDefinition, { env, binding: binding("lt-0123456789abcdef0") });
  await writeProjectFile(configDir, { name: "eu-app", revision: 1 } as unknown as ProjectDefinition, { env: `${env}-eu`, binding: binding("lt-0fffffffffffffff0") });
  let time = 0;
  const clock = { now: () => time, sleep: async (ms: number) => { time += ms; } };
  const lines: string[] = [];
  const typed = [...(input.typed ?? [env])];
  const asked: string[] = [];
  const deps: DestroyDependencies = {
    store, api: fakeDestroyApi(account, clock), identity: { get: async () => ({ account: "123456789012", arn: input.caller ?? ADMIN }) },
    confirmLine: async (question) => { asked.push(question); return typed.shift() ?? ""; },
    write: (line) => lines.push(line), ...clock, home, configDir, tokenStore: memoryTokenStore(), region: "us-east-1",
  };
  return { deps, account, store, lines, asked, home, configDir, env };
}

describe("agentx destroy (FR-055, item 3)", () => {
  it("removes everything in the documented order and deletes the settings last", async () => {
    const h = await harness();
    const result = await runDestroy({ env: "staging", keepData: false }, h.deps);
    const order = h.account.calls;
    const at = (text: string) => order.findIndex((call) => call === text);
    expect(order.slice(0, 5)).toEqual(["delete stack agentx-staging-slack", "protection off agentx-staging-runtime", "delete stack agentx-staging-runtime", "delete stack agentx-staging-control-plane", "terminate i-worker1"]);
    expect(at("delete volume vol-ws1")).toBeLessThan(at("protection off agentx-staging-identity"));
    expect(at("delete stack agentx-staging-identity")).toBeLessThan(at("delete stack agentx-staging-foundation"));
    expect(at("delete stack agentx-staging-foundation")).toBeLessThan(at("delete stack agentx-staging-access"));
    expect(at("delete stack agentx-staging-access")).toBeLessThan(at("delete bucket agentx-staging-access-artifactbucket-1a"));
    expect(order).toEqual(expect.arrayContaining([
      "delete table agentx-staging-control-plane-State-5e", "delete bucket agentx-staging-control-plane-slackthreadsessions-6f",
      "delete log group agentx-staging-foundation-VpcFlowLogs-2b", "delete user pool us-east-1_Pool4d (domain agentx-staging-123456789012)",
      "schedule key key-3c", "delete alias alias/agentx/staging/workspaces",
      "delete secret agentx/staging/callback-signing-key", "delete secret agentx/staging/github-app",
    ]));
    expect(h.store.values.has(settingsParameterName("staging"))).toBe(false);
    expect(h.store.values.has(lockParameterName("staging"))).toBe(false);
    expect(h.store.values.has(inventoryParameterName("staging"))).toBe(false);
    expect(h.store.values.has("/agentx/staging/worker/image")).toBe(false);
    const settingsDelete = h.store.calls.filter((call) => call.op === "delete").map((call) => call.name);
    expect(settingsDelete.indexOf(settingsParameterName("staging"))).toBe(settingsDelete.length - 2); // then the lock
    expect(result.manualSteps).toEqual(expect.arrayContaining([
      "Delete the GitHub App agentx-acme: open https://github.com/organizations/acme/settings/apps/agentx-acme/advanced and choose Delete GitHub App.",
      "Delete the Slack app: open https://api.slack.com/apps/A0APP/general and choose Delete App at the bottom of the page.",
    ]));
    expect(result.localFiles).toEqual(expect.arrayContaining([environmentCachePath(h.home, "staging"), join(h.configDir, "payments.yaml")]));
    expect(await readdir(h.configDir)).toEqual(["eu-app.yaml"]);
    expect(h.lines).toContain("Deleting agentx-staging-control-plane: this usually takes 20 to 40 minutes while its Lambda functions release their network interfaces.");
  });

  it("never touches a sibling environment, the legacy deployment's workers, or a retained resource with another tag", async () => {
    const account = installedAccount("staging");
    account.instances.push({ id: "i-legacy", state: "running", tags: { DeploymentMode: "ec2-ebs", Environment: "staging" } });
    account.secrets.push({ name: "agentx/staging-eu/slack", scheduled: false });
    account.aliases.push("alias/agentx/staging-eu/workspaces");
    account.tags.set("key-3c", { "agentx:env": "staging-eu" });
    const h = await harness({ account });
    const result = await runDestroy({ env: "staging", keepData: false }, h.deps);
    expect(h.account.calls.join("\n")).not.toMatch(/staging-eu|i-legacy|schedule key key-3c/);
    expect(h.store.values.has("/agentx/staging-eu/settings")).toBe(true);
    expect(result.leftInPlace).toEqual(["AWS::KMS::Key key-3c (it does not carry agentx:env=staging)"]);
  });

  it("changes nothing when the typed name is wrong", async () => {
    const h = await harness({ typed: ["stagin"] });
    await expect(runDestroy({ env: "staging", keepData: false }, h.deps)).rejects.toThrow("you typed stagin, not staging; nothing was removed");
    expect(h.account.calls).toEqual([]);
    expect(h.store.values.has(settingsParameterName("staging"))).toBe(true);
  });

  it("asks for the account id too for production, and for an environment AgentX has no record of", async () => {
    const production = await harness({ env: "production", typed: ["production", "123456789012"] });
    await runDestroy({ env: "production", keepData: false }, production.deps);
    expect(production.asked).toHaveLength(2);
    const unrecorded = await harness({ installed: false, typed: ["staging", "999999999999"] });
    await expect(runDestroy({ env: "staging", keepData: false }, unrecorded.deps)).rejects.toThrow("you typed 999999999999, not 123456789012; nothing was removed");
  });

  it("refuses the legacy deployment, the operator role, and credentials for another account", async () => {
    const legacy = await harness();
    await writeEnvironmentSettings(legacy.store, { ...SETTINGS, naming: "legacy" });
    await expect(runDestroy({ env: "staging", keepData: false }, legacy.deps)).rejects.toThrow("agentx destroy never removes the legacy deployment");
    const operator = await harness({ caller: "arn:aws:sts::123456789012:assumed-role/agentx-staging-operator/alice" });
    await expect(runDestroy({ env: "staging", keepData: false }, operator.deps)).rejects.toThrow("agentx destroy needs admin credentials");
    const other = await harness();
    other.deps.identity = { get: async () => ({ account: "999999999999", arn: ADMIN }) };
    await expect(runDestroy({ env: "staging", keepData: false }, other.deps)).rejects.toThrow("environment staging is installed in account 123456789012, but your AWS credentials are for 999999999999");
  });

  it("with --keep-data, keeps the tables, buckets, secrets, user pool and KMS keys, and removes the rest", async () => {
    const h = await harness();
    const result = await runDestroy({ env: "staging", keepData: true }, h.deps);
    expect(h.account.calls.join("\n")).not.toMatch(/delete table|delete bucket|delete user pool|schedule key|delete secret|delete alias/);
    expect(h.account.calls).toContain("delete log group agentx-staging-foundation-VpcFlowLogs-2b");
    expect(h.store.values.has(settingsParameterName("staging"))).toBe(false);
    expect(result.kept).toEqual(expect.arrayContaining(["AWS::DynamoDB::Table agentx-staging-control-plane-State-5e", "AWS::Cognito::UserPool us-east-1_Pool4d"]));
  });

  it("stops at a stack that cannot be deleted, keeps the inventory, and continues on the next run", async () => {
    const account = installedAccount();
    account.stacks.get("agentx-staging-foundation")!.failDeletes = 1;
    const first = await harness({ account });
    await expect(runDestroy({ env: "staging", keepData: false }, first.deps)).rejects.toThrow("stack agentx-staging-foundation could not be deleted");
    expect(first.store.values.has(settingsParameterName("staging"))).toBe(true);
    expect(first.store.values.has(inventoryParameterName("staging"))).toBe(true);
    expect(first.store.values.has(lockParameterName("staging"))).toBe(false);
    // The next run: control-plane and identity are gone, but their retained resources come from the saved inventory.
    first.deps.confirmLine = async () => "staging";
    await runDestroy({ env: "staging", keepData: false }, first.deps);
    expect(first.account.calls).toContain("delete table agentx-staging-control-plane-State-5e");
    expect(first.account.calls).toContain("delete user pool us-east-1_Pool4d (domain agentx-staging-123456789012)");
    expect(first.store.values.has(settingsParameterName("staging"))).toBe(false);
  });

  it("deletes a stack left in ROLLBACK_COMPLETE by a failed first install", async () => {
    const account = installedAccount();
    for (const name of [...account.stacks.keys()]) if (name !== "agentx-staging-access" && name !== "agentx-staging-identity") account.stacks.delete(name);
    account.stacks.get("agentx-staging-identity")!.status = "ROLLBACK_COMPLETE";
    account.stacks.get("agentx-staging-identity")!.terminationProtection = false;
    account.instances = [];
    account.volumes = [];
    const h = await harness({ account, installed: false, typed: ["staging", "123456789012"] });
    await runDestroy({ env: "staging", keepData: false }, h.deps);
    expect(h.account.calls).toContain("delete stack agentx-staging-identity");
  });

  it("offers to take over its own lock after a closed terminal", async () => {
    const h = await harness({ typed: ["staging", "yes"] });
    h.store.values.set(lockParameterName("staging"), JSON.stringify({ holder: ADMIN, command: "destroy", acquiredAt: new Date(0).toISOString() }));
    await runDestroy({ env: "staging", keepData: false }, h.deps);
    expect(h.asked[1]).toContain("Take the lock over?");
  });

  it("says so, and asks nothing, when there is nothing to remove", async () => {
    const empty: FakeAccount = { stacks: new Map(), instances: [], volumes: [], tags: new Map(), secrets: [], aliases: [], calls: [] };
    const h = await harness({ account: empty, installed: false });
    await rm(environmentCachePath(h.home, "staging"));
    await rm(join(h.configDir, "payments.yaml"));
    const result = await runDestroy({ env: "staging", keepData: false }, h.deps);
    expect(result.removed).toBe(false);
    expect(h.asked).toEqual([]);
    expect(h.lines).toContain("Environment staging has nothing to remove in this account and region.");
  });

  it("refuses up front when the access stack is gone but a stack deployed through its role remains", async () => {
    const account = installedAccount();
    account.stacks.delete("agentx-staging-access");
    const h = await harness({ account });
    await expect(runDestroy({ env: "staging", keepData: false }, h.deps)).rejects.toThrow("stack agentx-staging-slack was deployed through the role arn:aws:iam::123456789012:role/agentx-staging-cloudformation, which the access stack held and which is gone");
    expect(h.account.calls).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/contract/destroy-run.test.ts`
Expected: FAIL: `destroy/run.js` does not exist.

- [ ] **Step 3: Implement**

Create `packages/cli/src/destroy/run.ts`:

```ts
// agentx destroy (FR-055, and item 3 of the phase 15e brief): remove one named environment in the
// order docs/architecture-production.md's teardown gives, waiting properly, never touching another
// environment, and safe to re-run: the inventory of retained resources is saved in SSM before any
// stack is deleted, and the settings and lock are deleted last.
import { access, rm } from "node:fs/promises";
import { agentXError, environmentStackName, type StackPart } from "@agentx/contracts";
import { tokenStoreKey } from "../auth.js";
import type { CallerIdentity } from "../environments/adopt.js";
import { environmentCachePath } from "../environments/cache.js";
import { lockParameterName, withEnvironmentLock } from "../environments/lock.js";
import type { ParameterStore } from "../environments/parameter-store.js";
import { environmentProjectFiles } from "../environments/project-files.js";
import { readEnvironmentSettings, settingsParameterName, type EnvironmentSettings } from "../environments/settings.js";
import { isOperatorRole } from "../init/commands.js";
import { readInstallAnswers, readInstallProgress } from "../init/install-state.js";
import type { TokenStore } from "../token-store.js";
import type { DestroyApi, DestroyStack } from "./aws.js";
import { confirmationPrompts, destroyPlanText, KEPT_BY_KEEP_DATA, mergeInventory, readInventory, retainedResources, vendorSteps, writeInventory, type RetainedResource } from "./inventory.js";
import { DELETE_AFTER_WORKERS, DELETE_BEFORE_WORKERS, isOwnedAlias, isOwnedParameter, isOwnedRetained, isOwnedSecret, isOwnedStack, isOwnedWorker } from "./names.js";
import { deleteVolumesWhenFree, waitForInstancesGone, waitForStackDelete } from "./wait.js";

export interface DestroyDependencies {
  store: ParameterStore;
  api: DestroyApi;
  identity: CallerIdentity;
  confirmLine: (question: string) => Promise<string>;
  write: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  home: string;
  configDir: string;
  tokenStore: TokenStore;
  region: string;
}

export interface DestroyResult {
  env: string; removed: boolean; stacksDeleted: string[]; instances: number; volumes: number;
  retainedDeleted: string[]; kept: string[]; leftInPlace: string[]; secrets: number; parameters: number; localFiles: string[]; manualSteps: string[];
}

const exists = (path: string) => access(path).then(() => true, () => false);
const label = (resource: RetainedResource) => `${resource.type} ${resource.physicalId}`;
const IDLE_TIMEOUT_MS = 60 * 60_000;

export async function runDestroy(options: { env: string; keepData: boolean }, deps: DestroyDependencies): Promise<DestroyResult> {
  const { env } = options;
  const { api, store } = deps;
  const settings: EnvironmentSettings | undefined = await readEnvironmentSettings(store, env).catch(() => undefined);
  if (settings?.naming === "legacy") throw agentXError("CONFIG_INVALID", "agentx destroy never removes the legacy deployment (fixed stack names); tear it down by hand if you mean to");
  const caller = await deps.identity.get();
  if (isOperatorRole(caller.arn, env)) {
    throw agentXError("CONFIG_INVALID", "agentx destroy needs admin credentials: it deletes the access stack and its IAM roles, which the operator role cannot do by design");
  }
  if (settings !== undefined && settings.account !== caller.account) {
    throw agentXError("CONFIG_INVALID", `environment ${env} is installed in account ${settings.account}, but your AWS credentials are for ${caller.account}; use credentials for ${settings.account}`);
  }
  const answers = await readInstallAnswers(store, env).catch(() => undefined);
  const progress = await readInstallProgress(store, env).catch(() => undefined);

  // 1. Read everything first.
  const stacks = new Map<StackPart, DestroyStack>();
  for (const part of [...DELETE_BEFORE_WORKERS, ...DELETE_AFTER_WORKERS]) {
    const found = await api.stack(environmentStackName(env, part));
    if (found !== undefined) stacks.set(part, found);
  }
  if (!stacks.has("access")) {
    for (const [part, stack] of stacks) {
      if (stack.roleArn === undefined) continue;
      const name = environmentStackName(env, part);
      throw agentXError("CONFIG_INVALID", `stack ${name} was deployed through the role ${stack.roleArn}, which the access stack held and which is gone, so CloudFormation cannot delete it. Delete it with a role that can (aws cloudformation delete-stack --stack-name ${name} --role-arn <an admin role ARN> --region ${deps.region}), then run agentx destroy again`);
    }
  }
  const found: RetainedResource[] = [];
  for (const [part] of stacks) {
    const name = environmentStackName(env, part);
    found.push(...retainedResources(part, await api.template(name), await api.stackResources(name)));
  }
  const stored = await readInventory(store, env);
  const launchTemplateId = stacks.get("foundation")?.outputs.Ec2WorkerLaunchTemplateId;
  const github = progress?.github === undefined || answers === undefined ? undefined : { account: progress.github.account, accountType: answers.github.accountType, slug: progress.github.slug };
  const connectors = progress?.connectors?.map((entry) => entry.type);
  const inventory = mergeInventory(stored, {
    env, resources: found,
    ...(launchTemplateId === undefined ? {} : { launchTemplateId }), ...(github === undefined ? {} : { github }),
    ...(progress?.slack?.appId === undefined ? {} : { slackAppId: progress.slack.appId }), ...(connectors === undefined ? {} : { connectors }),
  });
  // Every list is checked against the guards again here, whatever the adapter already filtered.
  const instances = (await api.workerInstances(env)).filter((instance) => isOwnedWorker(env, instance.tags));
  const volumes = (await api.workerVolumes(env)).filter((volume) => isOwnedWorker(env, volume.tags));
  const secrets = (await api.secrets(env)).filter((secret) => isOwnedSecret(env, secret.name));
  const parameters = (await store.list(`/agentx/${env}`)).filter((name) => isOwnedParameter(env, name));
  const cachePath = environmentCachePath(deps.home, env);
  const projectFiles = inventory.launchTemplateId === undefined ? [] : (await environmentProjectFiles(deps.configDir, env)).filter((file) => file.launchTemplateId === inventory.launchTemplateId);
  const localFiles = [...((await exists(cachePath)) ? [cachePath] : []), ...projectFiles.map((file) => file.path)];

  const result: DestroyResult = { env, removed: false, stacksDeleted: [], instances: 0, volumes: 0, retainedDeleted: [], kept: [], leftInPlace: [], secrets: 0, parameters: 0, localFiles: [], manualSteps: [] };
  if (stacks.size + inventory.resources.length + instances.length + volumes.length + secrets.length + parameters.length + localFiles.length === 0) {
    deps.write(`Environment ${env} has nothing to remove in this account and region.`);
    return result;
  }

  // 2. Show everything, then the typed confirmation (question 1).
  const orderedStacks = [...DELETE_BEFORE_WORKERS, ...DELETE_AFTER_WORKERS].flatMap((part) => { const stack = stacks.get(part); return stack === undefined ? [] : [{ name: environmentStackName(env, part), status: stack.status }]; });
  for (const line of destroyPlanText({ env, account: caller.account, region: deps.region, stacks: orderedStacks, instances: instances.length, volumes: volumes.length, resources: inventory.resources, secrets: secrets.length, parameters: parameters.length, localFiles, keepData: options.keepData })) deps.write(line);
  const recorded = settings?.naming === "environment" || answers !== undefined;
  for (const prompt of confirmationPrompts({ env, account: caller.account, recorded })) {
    const typed = (await deps.confirmLine(prompt.question)).trim();
    if (typed !== prompt.expected) throw agentXError("CONFIG_INVALID", `you typed ${typed || "nothing"}, not ${prompt.expected}; nothing was removed`);
  }

  const deleteStack = async (part: StackPart): Promise<void> => {
    const name = environmentStackName(env, part);
    if (!isOwnedStack(env, name)) throw agentXError("CONFIG_INVALID", `refusing to delete stack ${name}: it does not belong to environment ${env}`);
    let stack = await api.stack(name);
    if (stack === undefined) return;
    const idleSince = deps.now();
    while (stack !== undefined && stack.status.endsWith("_IN_PROGRESS") && stack.status !== "DELETE_IN_PROGRESS") {
      if (deps.now() - idleSince >= IDLE_TIMEOUT_MS) throw agentXError("RUNTIME_UNAVAILABLE", `stack ${name} is still ${stack.status} after 60 minutes; wait for it to finish, then run agentx destroy again`);
      deps.write(`Waiting for ${name}: it is ${stack.status}`);
      await deps.sleep(15_000);
      stack = await api.stack(name);
    }
    if (stack === undefined) return;
    if (stack.terminationProtection) await api.disableTerminationProtection(name);
    if (stack.status !== "DELETE_IN_PROGRESS") {
      if (part === "control-plane") deps.write(`Deleting ${name}: this usually takes 20 to 40 minutes while its Lambda functions release their network interfaces.`);
      else deps.write(`Deleting ${name}`);
      await api.deleteStack(name);
    }
    await waitForStackDelete({ api, name, write: deps.write, sleep: deps.sleep, now: deps.now });
    result.stacksDeleted.push(name);
  };

  await withEnvironmentLock({
    store, env, holder: caller.arn, command: "destroy", now: deps.now, takeOverOwn: true,
    confirmTakeover: async (held) => /^y(es)?$/i.test((await deps.confirmLine(`Environment ${env} is locked by ${held.holder} running "${held.command}" since ${held.acquiredAt}. Take the lock over? Say yes only if that command is no longer running. [y/N] `)).trim()),
  }, async () => {
    await writeInventory(store, inventory);
    for (const part of DELETE_BEFORE_WORKERS) await deleteStack(part);

    // 3. Workers: launched by Step Functions, outside CloudFormation (all three tags checked in the adapter).
    const running = (await api.workerInstances(env)).filter((instance) => isOwnedWorker(env, instance.tags)).map((instance) => instance.id);
    if (running.length > 0) {
      deps.write(`Terminating ${running.length} worker ${running.length === 1 ? "instance" : "instances"}`);
      await api.terminateInstances(running);
      await waitForInstancesGone({ api, env, ids: running, sleep: deps.sleep, now: deps.now });
      result.instances = running.length;
    }
    const left = (await api.workerVolumes(env)).filter((volume) => isOwnedWorker(env, volume.tags)).map((volume) => volume.id);
    if (left.length > 0) {
      deps.write(`Deleting ${left.length} workspace ${left.length === 1 ? "volume" : "volumes"}`);
      await deleteVolumesWhenFree({ api, ids: left, sleep: deps.sleep, now: deps.now });
      result.volumes = left.length;
    }

    for (const part of DELETE_AFTER_WORKERS) await deleteStack(part);

    // 5. What the stacks retained.
    for (const resource of inventory.resources) {
      if (options.keepData && KEPT_BY_KEEP_DATA.has(resource.type)) { result.kept.push(label(resource)); continue; }
      const tags = await api.resourceTags(resource);
      if (tags === undefined) continue;
      if (!isOwnedRetained(env, resource, tags)) { result.leftInPlace.push(`${label(resource)} (it does not carry agentx:env=${env})`); continue; }
      switch (resource.type) {
        case "AWS::S3::Bucket": await api.deleteBucket(resource.physicalId, (count) => { if (count % 1000 === 0) deps.write(`${resource.physicalId}: ${count} objects deleted`); }); break;
        case "AWS::DynamoDB::Table": await api.deleteTable(resource.physicalId); break;
        case "AWS::Logs::LogGroup": await api.deleteLogGroup(resource.physicalId); break;
        case "AWS::Cognito::UserPool": await api.deleteUserPool(resource.physicalId, `agentx-${env}-${caller.account}`); break;
        case "AWS::KMS::Key": await api.scheduleKeyDeletion(resource.physicalId); break;
        case "AWS::SecretsManager::Secret": await api.deleteSecret(resource.physicalId, false); break;
        default: result.leftInPlace.push(`${label(resource)} (agentx destroy does not delete this type; delete it by hand)`); continue;
      }
      result.retainedDeleted.push(label(resource));
    }
    if (!options.keepData) {
      for (const alias of (await api.aliases(env)).filter((entry) => isOwnedAlias(env, entry.name))) await api.deleteAlias(alias.name);
      // 6. Every agentx/<env>/ secret, without recovery, so a reinstall can reuse the names.
      const remaining = (await api.secrets(env)).filter((secret) => isOwnedSecret(env, secret.name));
      for (const secret of remaining) await api.deleteSecret(secret.name, secret.scheduled);
      result.secrets = remaining.length;
    }

    // 7. Parameters; the settings last, and the lock is released after this function returns.
    const names = (await store.list(`/agentx/${env}`)).filter((name) => isOwnedParameter(env, name) && name !== settingsParameterName(env) && name !== lockParameterName(env));
    for (const name of names) await store.delete(name);
    await store.delete(settingsParameterName(env));
    result.parameters = names.length + 1;
  });

  // 8. This computer.
  for (const path of localFiles) await rm(path, { force: true });
  if (settings !== undefined) await deps.tokenStore.delete(tokenStoreKey({ issuer: settings.identity.issuer, clientId: settings.identity.clientId, audience: settings.identity.audience }));
  result.localFiles = localFiles;

  // 9. What AgentX cannot do.
  result.manualSteps = [
    ...vendorSteps(inventory),
    ...(options.keepData && result.kept.length > 0 ? [`Kept, as --keep-data asked: ${result.kept.join(", ")}. A new install named ${env} cannot reuse the secret names until you delete them.`] : []),
    ...(result.retainedDeleted.some((entry) => entry.startsWith("AWS::KMS::Key")) ? ["The KMS keys are scheduled for deletion in 7 days; until then, aws kms cancel-key-deletion brings one back."] : []),
    ...result.leftInPlace.map((entry) => `Left in place: ${entry}.`),
  ];
  result.removed = true;
  deps.write(`Environment ${env} is removed.`);
  for (const step of result.manualSteps) deps.write(`  ${step}`);
  return result;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/contract/destroy-run.test.ts tests/contract/destroy-plan.test.ts tests/contract/destroy-aws.test.ts`
Expected: PASS. If the order test fails only because the fake records an extra call, fix the fake, not
the expected order: the order is the spec's.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/destroy/run.ts tests/support/destroy-fakes.ts tests/contract/destroy-run.test.ts
git commit -m "feat(destroy): the ordered teardown, with guards, keep-data, re-run safety and the manual steps (FR-055)"
```

### Task 17: The `destroy` command, and `agentx destroy` in init's `ROLLBACK_COMPLETE` error

**Files:**
- Create: `packages/cli/src/destroy/cli.ts`
- Modify: `packages/cli/src/main.ts` (`CliDependencies.destroy`, register)
- Modify: `packages/cli/src/deploy/templates-engine.ts` (the `ROLLBACK_COMPLETE` refusal)
- Test: `tests/contract/destroy-cli.test.ts`, `tests/contract/templates-engine.test.ts`

Depends on question 11 (the typed name from piped stdin).

**Interfaces:**
- Consumes: `runDestroy`, `DestroyDependencies` (Task 16); `awsDestroyApi` (Task 15).
- Produces:

```ts
export function lineReader(input: { stdin: Readable; stderr: TextWriter }): { ask(question: string): Promise<string>; close(): void };
export interface DestroyCommandContext { overrides?: Partial<DestroyDependencies>; parameterStore: (region?: string) => ParameterStore; stdin: Readable; home: string; tokenStore: TokenStore; stdout: TextWriter; stderr: TextWriter }
export function registerDestroyCommand(program: Command, context: DestroyCommandContext): void;
// main.ts CliDependencies gains: destroy?: Partial<DestroyDependencies>
```

- [ ] **Step 1: Write the failing tests**

Create `tests/contract/destroy-cli.test.ts`:

```ts
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { lineReader } from "../../packages/cli/src/destroy/cli.js";
import { writeEnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import { executeCli } from "../../packages/cli/src/main.js";
import { fakeDestroyApi, installedAccount } from "../support/destroy-fakes.js";
import { SETTINGS } from "../support/doctor-fakes.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";
import { memoryTokenStore } from "../support/setup-fakes.js";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: { write: (text: string) => out.push(text) }, stderr: { write: (text: string) => err.push(text) } };
}

describe("agentx destroy", () => {
  it("needs an explicit --env, so it never removes production by default", async () => {
    const io = capture();
    expect(await executeCli(["destroy"], io)).toBe(2);
    expect(io.err.join("")).toContain("agentx destroy requires an explicit --env");
  });

  it("removes the environment after the typed name, and prints the manual steps on stdout", async () => {
    const io = capture();
    const store = new MemoryParameterStore();
    await writeEnvironmentSettings(store, SETTINGS);
    let time = 0;
    const clock = { now: () => time, sleep: async (ms: number) => { time += ms; } };
    const code = await executeCli(["--env", "staging", "destroy", "--region", "us-east-1"], {
      ...io,
      destroy: {
        store, api: fakeDestroyApi(installedAccount(), clock), identity: { get: async () => ({ account: "123456789012", arn: "arn:aws:sts::123456789012:assumed-role/Admin/alice" }) },
        confirmLine: async () => "staging", tokenStore: memoryTokenStore(), home: "/nonexistent-agentx-home", configDir: "/nonexistent-agentx-projects", ...clock,
      },
    });
    expect(code).toBe(0);
    expect(io.out.join("")).toContain("Removed environment staging.");
    expect(io.out.join("")).toContain("https://api.slack.com/apps");
  });

  it("reads each typed answer from piped stdin, in order (question 11)", async () => {
    const written: string[] = [];
    const reader = lineReader({ stdin: Readable.from(["staging\n123456789012\n"]), stderr: { write: (text: string) => written.push(text) } });
    expect(await reader.ask("Type the name: ")).toBe("staging");
    expect(await reader.ask("Type the account: ")).toBe("123456789012");
    expect(await reader.ask("Anything else: ")).toBe("");
    reader.close();
    expect(written).toEqual(["Type the name: ", "Type the account: ", "Anything else: "]);
  });
});
```

Add to `tests/contract/templates-engine.test.ts`, next to "refuses a stack in ROLLBACK_COMPLETE with the delete command to run":

```ts
  it("offers agentx destroy for a stack in ROLLBACK_COMPLETE, as well as the exact delete", async () => {
    const fake = fakeClients({ PutObject: [{}], DescribeStacks: [stack("ROLLBACK_COMPLETE")] });
    await expect(deployer(fake).deploy(request("identity"))).rejects.toThrow("or remove the whole environment with agentx --env staging destroy --region us-east-1");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/contract/destroy-cli.test.ts tests/contract/templates-engine.test.ts`
Expected: FAIL: `destroy/cli.js` does not exist; the refusal has no destroy line.

- [ ] **Step 3: Implement**

In `packages/cli/src/deploy/templates-engine.ts`, `changeSetType`'s `ROLLBACK_COMPLETE` refusal becomes:

```ts
      throw agentXError(
        "CONFIG_INVALID",
        `stack ${stackName} failed to create earlier and must be deleted before it can be deployed again (aws cloudformation delete-stack --stack-name ${stackName} --region ${region}), or remove the whole environment with agentx --env ${env} destroy --region ${region}`,
      );
```

(The existing test's text is still a prefix of the new message, so it passes unchanged.)

Create `packages/cli/src/destroy/cli.ts`:

```ts
// The `agentx destroy` command (FR-055), kept out of main.ts. It needs admin credentials (question 7)
// and an explicit --env, and it reads each typed confirmation from the terminal or, when stdin is not
// a terminal, from piped stdin (question 11). No flag skips the typed name.
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { agentXError } from "@agentx/contracts";
import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { EC2Client } from "@aws-sdk/client-ec2";
import { KMSClient } from "@aws-sdk/client-kms";
import { S3Client } from "@aws-sdk/client-s3";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { STSClient } from "@aws-sdk/client-sts";
import type { Command } from "commander";
import { stsCallerIdentity } from "../environments/adopt.js";
import type { ParameterStore } from "../environments/parameter-store.js";
import type { TextWriter } from "../init/prompts.js";
import { formatSuccess } from "../output.js";
import type { TokenStore } from "../token-store.js";
import { awsDestroyApi } from "./aws.js";
import { runDestroy, type DestroyDependencies } from "./run.js";

export function lineReader(input: { stdin: Readable; stderr: TextWriter }): { ask(question: string): Promise<string>; close(): void } {
  const rl = createInterface({ input: input.stdin, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  return {
    async ask(question) {
      input.stderr.write(question);
      const next = await lines.next();
      return next.done === true ? "" : String(next.value);
    },
    close() { rl.close(); },
  };
}

export interface DestroyCommandContext {
  overrides?: Partial<DestroyDependencies>;
  parameterStore: (region?: string) => ParameterStore;
  stdin: Readable;
  home: string;
  tokenStore: TokenStore;
  stdout: TextWriter;
  stderr: TextWriter;
}

export function registerDestroyCommand(program: Command, context: DestroyCommandContext): void {
  program
    .command("destroy")
    .description("remove one named environment from this AWS account: its stacks, workers, kept data, secrets and settings, in order (admin credentials; you type its name to confirm)")
    .option("--region <region>", "AWS region of the environment; defaults to your AWS configuration")
    .option("--keep-data", "keep the tables, buckets, secrets, Cognito user pool and KMS keys; remove the rest", false)
    .action(async (options: { region?: string; keepData: boolean }, command: Command) => {
      if (command.getOptionValueSourceWithGlobals("env") !== "cli") {
        throw agentXError("CONFIG_INVALID", "agentx destroy requires an explicit --env, so it can never remove production by default");
      }
      const globals = command.optsWithGlobals<{ env: string; json: boolean; configDir: string }>();
      const overrides = context.overrides ?? {};
      const aws = options.region === undefined ? {} : { region: options.region };
      const reader = overrides.confirmLine === undefined ? lineReader({ stdin: context.stdin, stderr: context.stderr }) : undefined;
      try {
        const deps: DestroyDependencies = {
          store: overrides.store ?? context.parameterStore(options.region),
          api: overrides.api ?? awsDestroyApi({
            cloudFormation: new CloudFormationClient(aws), ec2: new EC2Client(aws), s3: new S3Client(aws), dynamodb: new DynamoDBClient(aws),
            logs: new CloudWatchLogsClient(aws), cognito: new CognitoIdentityProviderClient(aws), kms: new KMSClient(aws), secrets: new SecretsManagerClient(aws),
          }),
          identity: overrides.identity ?? stsCallerIdentity(new STSClient(aws)),
          confirmLine: overrides.confirmLine ?? ((question) => reader!.ask(question)),
          write: overrides.write ?? ((line) => { context.stderr.write(`${line}\n`); }),
          sleep: overrides.sleep ?? ((ms) => new Promise((resolve) => { setTimeout(resolve, ms); })),
          now: overrides.now ?? Date.now,
          home: overrides.home ?? context.home,
          configDir: overrides.configDir ?? globals.configDir,
          tokenStore: overrides.tokenStore ?? context.tokenStore,
          region: overrides.region ?? options.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "<region>",
        };
        const result = await runDestroy({ env: globals.env, keepData: options.keepData }, deps);
        context.stdout.write(globals.json ? formatSuccess(result, true) : result.removed
          ? [`Removed environment ${result.env}.`, ...result.manualSteps.map((step) => `  ${step}`)].join("\n") + "\n"
          : `Nothing to remove for environment ${result.env}.\n`);
      } finally {
        reader?.close();
      }
    });
}
```

In `packages/cli/src/main.ts`, add `/** \`agentx destroy\` overrides, for tests: never touch AWS. */ destroy?: Partial<DestroyDependencies>;`
to `CliDependencies`, and register after the upgrade command:

```ts
  registerDestroyCommand(program, {
    ...(dependencies.destroy === undefined ? {} : { overrides: dependencies.destroy }),
    parameterStore, stdin: dependencies.stdin ?? process.stdin, home, tokenStore: services.tokenStore, stdout: services.stdout, stderr: services.stderr,
  });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/contract/destroy-cli.test.ts tests/contract/templates-engine.test.ts tests/contract/init-cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/destroy/cli.ts packages/cli/src/main.ts packages/cli/src/deploy/templates-engine.ts tests/contract/destroy-cli.test.ts tests/contract/templates-engine.test.ts
git commit -m "feat(cli): agentx destroy with an explicit --env and a typed name; ROLLBACK_COMPLETE offers it"
```

### Task 18: `init --stop-after` and the release test workflow

The release test (SC-003, SC-004, SC-005) runs by hand before a release, in a throwaway account.
A pre-made Slack app cannot follow each new environment's API address, and the admin sign-in needs
a browser, so the automated run stops `init` after `developer-signin` (question 6).

**Files:**
- Modify: `packages/cli/src/init/commands.ts` (`InitOptions.stopAfter`, `InitResult.stoppedAfter`)
- Modify: `packages/cli/src/main.ts` (`--stop-after`, its output line)
- Create: `.github/workflows/release-test.yml`
- Test: `tests/contract/init-cli.test.ts`, `tests/contract/release-test-workflow.test.ts`

Depends on question 6.

**Interfaces:**
- Consumes: `INIT_STEP_IDS`, `runInitSteps`; every command from Tasks 4, 9, 12, 17.
- Produces: `agentx init --stop-after <step>`; `InitOptions.stopAfter?: InitStepId`;
  `InitResult.stoppedAfter?: InitStepId`; the `Release test` workflow.

- [ ] **Step 1: Write the failing tests**

Add to `tests/contract/init-cli.test.ts`, inside `describe("agentx init", ...)`:

```ts
  it("stops after the step --stop-after names, records it, and says how to finish", async () => {
    const h = await harness();
    expect(await h.run(["--stop-after", "developer-signin"], { prompter: scriptedPrompter([...FIRST_RUN, ...SLACK, ...SIGNIN]) })).toBe(0);
    const progress = await readInstallProgress(h.store, "staging");
    expect(progress?.steps["developer-signin"]?.status).toBe("done");
    expect(progress?.steps["admin-user"]).toBeUndefined();
    expect(h.printed()).toContain("Stopped after the developer-signin step, as --stop-after asked. Run agentx init --env staging --region us-east-1 again to finish.");
    expect(h.store.values.has(lockParameterName("staging"))).toBe(false);
  });

  it("refuses a --stop-after that names no step", async () => {
    const h = await harness();
    expect(await h.run(["--stop-after", "everything"], { prompter: scriptedPrompter([]) })).not.toBe(0);
    expect(h.printed()).toContain("--stop-after");
  });
```

Create `tests/contract/release-test-workflow.test.ts`:

```ts
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

interface Step { name?: string; run?: string; uses?: string; if?: string; env?: Record<string, string> }
interface Job { needs?: string | string[]; if?: string; strategy?: { matrix?: Record<string, unknown> }; env?: Record<string, string>; steps: Step[] }
interface Workflow { on: Record<string, unknown>; permissions: Record<string, string>; concurrency: Record<string, unknown>; jobs: Record<string, Job> }

const text = () => readFile(".github/workflows/release-test.yml", "utf8");
const workflow = async () => YAML.parse(await text()) as Workflow;
const runs = (wf: Workflow) => Object.values(wf.jobs).flatMap((job) => job.steps.map((step) => step.run ?? "")).join("\n");

describe("the release test workflow (SC-003 to SC-005, question 6)", () => {
  it("runs only by hand, one at a time, with OIDC and read-only contents", async () => {
    const wf = await workflow();
    expect(Object.keys(wf.on)).toEqual(["workflow_dispatch"]);
    expect(wf.permissions).toEqual({ contents: "read", "id-token": "write" });
    expect(wf.concurrency).toEqual({ group: "release-test", "cancel-in-progress": false });
  });

  it("installs with each engine, runs doctor, upgrades from the previous release, and exercises the export path", async () => {
    const wf = await workflow();
    expect(wf.jobs.lane?.strategy?.matrix?.engine).toEqual(["templates", "cdk"]);
    const all = runs(wf);
    expect(all).toMatch(/ init --yes [\s\S]*?--stop-after developer-signin/);
    expect(all).toContain(" doctor --region ");
    expect(all).toContain(" upgrade --yes ");
    expect(all).toContain(" init --export ");
    expect(all).toContain(" init --resume --from-bundle ");
    expect(all).toContain(" config set alerts.slowTurnMinutes 7 --yes");
  });

  it("always tears down every environment it made with agentx destroy, the name piped in", async () => {
    const wf = await workflow();
    expect(wf.jobs.teardown?.if).toBe("always()");
    expect(wf.jobs.teardown?.needs).toEqual(["lane", "export"]);
    expect(runs(wf)).toMatch(/printf '%s\\n%s\\n' "\$env" "\$ACCOUNT" \| node packages\/cli\/dist\/main\.js --env "\$env" destroy --region "\$AWS_REGION"/);
  });

  it("never names production, and passes every secret through an environment variable, never a flag's value", async () => {
    const all = await text();
    expect(all).not.toMatch(/production/i);
    for (const line of runs(await workflow()).split("\n")) expect(line).not.toMatch(/\$\{\{\s*secrets\./);
    expect(all).toContain("--github-private-key-env RT_GITHUB_PRIVATE_KEY");
    expect(all).toContain("--slack-bot-token-env RT_SLACK_BOT_TOKEN");
  });

  it("keeps environment names within 20 characters", async () => {
    expect(await text()).toMatch(/AGENTX_ENV: rt\$\{\{ github\.run_number \}\}/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/contract/init-cli.test.ts tests/contract/release-test-workflow.test.ts`
Expected: FAIL: `--stop-after` is an unknown option; the workflow file does not exist.

- [ ] **Step 3: Implement `--stop-after`**

In `packages/cli/src/init/commands.ts`:
- add `/** --stop-after: run the steps up to and including this one, then stop (the release test). */ stopAfter?: InitStepId;` to `InitOptions`;
- change `InitResult` to `InitRunResult & { env: string; resumed: boolean; controlPlaneUrl?: string; ready?: string; stoppedAfter?: InitStepId }`;
- after `const steps = initSteps(...)` add:

```ts
  const stopIndex = options.stopAfter === undefined ? -1 : steps.findIndex((step) => step.id === options.stopAfter);
  const runSteps = stopIndex < 0 ? steps : steps.slice(0, stopIndex + 1);
```

  and pass `steps: runSteps` to `runInitSteps` (the wizard's `setSteps` keeps the full list);
- where the result is returned, when `options.stopAfter !== undefined && result.status === "complete"`,
  return `{ ...result, env, resumed: stored !== undefined, stoppedAfter: options.stopAfter }` without
  reading settings for the ready text.

In `packages/cli/src/main.ts`:
- import `INIT_STEP_IDS` and `type InitStepId` from `./init/install-state.js` if main.ts does not already;
- on the `init` command: `.addOption(new Option("--stop-after <step>", "run the steps up to and including this one, then stop; agentx init again finishes (for automated tests)").choices([...INIT_STEP_IDS]))`;
- `initOptions` passes `...(options.stopAfter === undefined ? {} : { stopAfter: options.stopAfter as InitStepId })`;
- in the action, before printing `result.ready`:

```ts
        if (result.stoppedAfter !== undefined) {
          services.stdout.write(`Stopped after the ${result.stoppedAfter} step, as --stop-after asked. Run agentx init --env ${result.env} --region ${options.region ?? "<region>"} again to finish.\n`);
          return;
        }
```

- [ ] **Step 4: Write the workflow**

Create `.github/workflows/release-test.yml`:

```yaml
name: Release test

# The spec's release tests (Testing, "Release tests"), run by hand before a release, in a throwaway
# AWS account that holds nothing else. An owner sets it up once (docs/releases.md, "The release
# test"): the role in vars.AGENTX_RELEASE_TEST_ROLE_ARN, the private ECR repositories
# agentx-release-test/worker and agentx-release-test/slack, a test GitHub App and a test Slack app.
# init stops after developer-signin: the admin sign-in needs a browser, and a pre-made Slack app
# cannot follow each new environment's API address, so the Slack reply, alerts test and the manual
# teardown guide stay in the manual release check.
on:
  workflow_dispatch:
    inputs:
      previous:
        description: "The published release to install first, then upgrade from (for example 1.2.3)"
        required: true
      candidate:
        description: "The version for the candidate built from this ref, newer than previous (for example 1.3.0)"
        required: true

permissions:
  contents: read
  id-token: write

concurrency:
  group: release-test
  cancel-in-progress: false

env:
  AWS_REGION: ${{ vars.AGENTX_RELEASE_TEST_REGION || 'us-east-1' }}
  PREVIOUS: ${{ inputs.previous }}
  CANDIDATE: ${{ inputs.candidate }}

jobs:
  images:
    runs-on: ubuntu-24.04-arm
    outputs:
      worker: ${{ steps.push.outputs.worker }}
      slack: ${{ steps.push.outputs.slack }}
    steps:
      - uses: actions/checkout@v5
        with: { persist-credentials: false }
      - uses: aws-actions/configure-aws-credentials@v5
        with: { role-to-assume: "${{ vars.AGENTX_RELEASE_TEST_ROLE_ARN }}", aws-region: "${{ env.AWS_REGION }}" }
      - id: login
        uses: aws-actions/amazon-ecr-login@v2
      - uses: docker/setup-buildx-action@v3
      - id: push
        shell: bash
        env:
          REGISTRY: ${{ steps.login.outputs.registry }}
          TAG: rt-${{ github.run_id }}
        run: |
          for image in worker slack; do
            dockerfile=environments/base/Dockerfile; [ "$image" = slack ] && dockerfile=environments/slack/Dockerfile
            repo="$REGISTRY/agentx-release-test/$image"
            docker buildx build --platform linux/arm64 --provenance=false --sbom=false --file "$dockerfile" --tag "$repo:$TAG" --push --metadata-file "$RUNNER_TEMP/$image.json" .
            echo "$image=$repo@$(jq -r '."containerimage.digest"' "$RUNNER_TEMP/$image.json")" >> "$GITHUB_OUTPUT"
          done

  lane:
    needs: images
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        engine: [templates, cdk]
    env:
      AGENTX_ENV: rt${{ github.run_number }}${{ matrix.engine == 'cdk' && 'c' || 't' }}
      WORKER: ${{ needs.images.outputs.worker }}
      SLACK: ${{ needs.images.outputs.slack }}
      RT_GITHUB_PRIVATE_KEY: ${{ secrets.RT_GITHUB_PRIVATE_KEY }}
      RT_SLACK_BOT_TOKEN: ${{ secrets.RT_SLACK_BOT_TOKEN }}
      RT_SLACK_SIGNING_SECRET: ${{ secrets.RT_SLACK_SIGNING_SECRET }}
      RT_SLACK_CLIENT_SECRET: ${{ secrets.RT_SLACK_CLIENT_SECRET }}
      GH_TOKEN: ${{ github.token }}
    steps:
      - uses: actions/checkout@v5
        with: { fetch-depth: 0, persist-credentials: false }
      - uses: actions/setup-node@v5
        with: { node-version-file: .node-version, cache: npm }
      - run: npm ci && npm run build
      - uses: aws-actions/configure-aws-credentials@v5
        with: { role-to-assume: "${{ vars.AGENTX_RELEASE_TEST_ROLE_ARN }}", aws-region: "${{ env.AWS_REGION }}" }
      - name: Fetch the previous release and build the candidate
        run: |
          mkdir -p "$RUNNER_TEMP/previous"
          gh release download "v$PREVIOUS" --repo "$GITHUB_REPOSITORY" --pattern "agentx-$PREVIOUS.tar.gz" --dir "$RUNNER_TEMP"
          tar -xzf "$RUNNER_TEMP/agentx-$PREVIOUS.tar.gz" -C "$RUNNER_TEMP/previous"
          npm run release:build -- --version "$CANDIDATE" --out "$RUNNER_TEMP/candidate"
      - name: Check out the previous release's source (cdk engine)
        if: matrix.engine == 'cdk'
        run: |
          git worktree add "$RUNNER_TEMP/source-previous" "v$PREVIOUS"
          # A local tag only, never pushed: the cdk engine deploys from a checkout at v<version>.
          git tag "v$CANDIDATE"
      - name: Install the previous release, up to developer sign-in
        run: |
          source_flag=""; [ "${{ matrix.engine }}" = cdk ] && source_flag="--source $RUNNER_TEMP/source-previous"
          node packages/cli/dist/main.js --env "$AGENTX_ENV" init --yes --no-browser --region "$AWS_REGION" --release "$RUNNER_TEMP/previous" --engine ${{ matrix.engine }} $source_flag \
            --operator-principal "${{ vars.AGENTX_RELEASE_TEST_ROLE_ARN }}" --budget 0 --no-alerts --connectors none \
            --github-account "${{ vars.RT_GITHUB_ACCOUNT }}" --github-app-id "${{ vars.RT_GITHUB_APP_ID }}" --github-installation-id "${{ vars.RT_GITHUB_INSTALLATION_ID }}" --github-private-key-env RT_GITHUB_PRIVATE_KEY \
            --slack-app-name "AgentX release test" --slack-bot-token-env RT_SLACK_BOT_TOKEN --slack-signing-secret-env RT_SLACK_SIGNING_SECRET --slack-install installed \
            --signin slack --slack-client-id "${{ vars.RT_SLACK_CLIENT_ID }}" --slack-client-secret-env RT_SLACK_CLIENT_SECRET \
            --stop-after developer-signin
      - name: Doctor on the previous release
        run: node packages/cli/dist/main.js --env "$AGENTX_ENV" doctor --region "$AWS_REGION"
      - name: Upgrade to the candidate (runs doctor at the end)
        run: |
          source_flag=""; [ "${{ matrix.engine }}" = cdk ] && source_flag="--source $GITHUB_WORKSPACE"
          node packages/cli/dist/main.js --env "$AGENTX_ENV" upgrade --yes --region "$AWS_REGION" --release "$RUNNER_TEMP/candidate" --worker-image "$WORKER" --slack-image "$SLACK" $source_flag
      - name: Change a setting under the operator role alone (SC-005)
        run: |
          creds=$(aws sts assume-role --role-arn "arn:aws:iam::$(aws sts get-caller-identity --query Account --output text):role/agentx-$AGENTX_ENV-operator" --role-session-name release-test --query Credentials --output json)
          export AWS_ACCESS_KEY_ID=$(echo "$creds" | jq -r .AccessKeyId) AWS_SECRET_ACCESS_KEY=$(echo "$creds" | jq -r .SecretAccessKey) AWS_SESSION_TOKEN=$(echo "$creds" | jq -r .SessionToken)
          node packages/cli/dist/main.js --env "$AGENTX_ENV" config set alerts.slowTurnMinutes 7 --yes --region "$AWS_REGION"
          test "$(node packages/cli/dist/main.js --env "$AGENTX_ENV" config get alerts.slowTurnMinutes --region "$AWS_REGION")" = 7
          node packages/cli/dist/main.js --env "$AGENTX_ENV" doctor --region "$AWS_REGION"

  export:
    needs: images
    runs-on: ubuntu-latest
    env:
      AGENTX_ENV: rt${{ github.run_number }}x
      WORKER: ${{ needs.images.outputs.worker }}
      SLACK: ${{ needs.images.outputs.slack }}
      RT_GITHUB_PRIVATE_KEY: ${{ secrets.RT_GITHUB_PRIVATE_KEY }}
      RT_SLACK_BOT_TOKEN: ${{ secrets.RT_SLACK_BOT_TOKEN }}
      RT_SLACK_SIGNING_SECRET: ${{ secrets.RT_SLACK_SIGNING_SECRET }}
      RT_SLACK_CLIENT_SECRET: ${{ secrets.RT_SLACK_CLIENT_SECRET }}
    steps:
      - uses: actions/checkout@v5
        with: { persist-credentials: false }
      - uses: actions/setup-node@v5
        with: { node-version-file: .node-version, cache: npm }
      - run: npm ci && npm run build && npm run release:build -- --version "$CANDIDATE" --out "$RUNNER_TEMP/candidate"
      - uses: aws-actions/configure-aws-credentials@v5
        with: { role-to-assume: "${{ vars.AGENTX_RELEASE_TEST_ROLE_ARN }}", aws-region: "${{ env.AWS_REGION }}" }
      - name: Export, then deploy the access stack as a platform team would
        run: |
          node packages/cli/dist/main.js --env "$AGENTX_ENV" init --export "$RUNNER_TEMP/bundle" --region "$AWS_REGION" --release "$RUNNER_TEMP/candidate" --operator-principal "${{ vars.AGENTX_RELEASE_TEST_ROLE_ARN }}"
          "$RUNNER_TEMP/bundle/deploy-access.sh" --yes
      - name: Resume under the operator role alone, up to developer sign-in
        run: |
          creds=$(aws sts assume-role --role-arn "arn:aws:iam::$(aws sts get-caller-identity --query Account --output text):role/agentx-$AGENTX_ENV-operator" --role-session-name release-test --query Credentials --output json)
          export AWS_ACCESS_KEY_ID=$(echo "$creds" | jq -r .AccessKeyId) AWS_SECRET_ACCESS_KEY=$(echo "$creds" | jq -r .SecretAccessKey) AWS_SESSION_TOKEN=$(echo "$creds" | jq -r .SessionToken)
          node packages/cli/dist/main.js init --resume --from-bundle "$RUNNER_TEMP/bundle" --env "$AGENTX_ENV" --yes --no-browser --region "$AWS_REGION" --release "$RUNNER_TEMP/candidate" \
            --worker-image "$WORKER" --slack-image "$SLACK" --budget 0 --no-alerts --connectors none \
            --github-account "${{ vars.RT_GITHUB_ACCOUNT }}" --github-app-id "${{ vars.RT_GITHUB_APP_ID }}" --github-installation-id "${{ vars.RT_GITHUB_INSTALLATION_ID }}" --github-private-key-env RT_GITHUB_PRIVATE_KEY \
            --slack-app-name "AgentX release test" --slack-bot-token-env RT_SLACK_BOT_TOKEN --slack-signing-secret-env RT_SLACK_SIGNING_SECRET --slack-install installed \
            --signin slack --slack-client-id "${{ vars.RT_SLACK_CLIENT_ID }}" --slack-client-secret-env RT_SLACK_CLIENT_SECRET \
            --stop-after developer-signin
          node packages/cli/dist/main.js --env "$AGENTX_ENV" doctor --region "$AWS_REGION"

  teardown:
    needs: [lane, export]
    if: always()
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with: { persist-credentials: false }
      - uses: actions/setup-node@v5
        with: { node-version-file: .node-version, cache: npm }
      - run: npm ci && npm run build
      - uses: aws-actions/configure-aws-credentials@v5
        with: { role-to-assume: "${{ vars.AGENTX_RELEASE_TEST_ROLE_ARN }}", aws-region: "${{ env.AWS_REGION }}" }
      - name: Destroy every environment this run made
        run: |
          ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
          status=0
          for env in "rt${{ github.run_number }}t" "rt${{ github.run_number }}c" "rt${{ github.run_number }}x"; do
            # The name, then the account id, for an install that failed before it recorded itself.
            printf '%s\n%s\n' "$env" "$ACCOUNT" | node packages/cli/dist/main.js --env "$env" destroy --region "$AWS_REGION" || status=1
          done
          exit $status
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/contract/init-cli.test.ts tests/contract/release-test-workflow.test.ts tests/contract/release-workflow.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/init/commands.ts packages/cli/src/main.ts .github/workflows/release-test.yml tests/contract/init-cli.test.ts tests/contract/release-test-workflow.test.ts
git commit -m "feat(release): init --stop-after, and a release test workflow for both engines, upgrade, export and destroy"
```

### Task 19: The guides, the export bundle's teardown text, and the spec

FR-054: an install guide for each path, a day-2 guide, a manual teardown guide (#66) and a "move to
another account by reinstalling" guide (#67). Plain words, every command exact, no em dashes.

**Files:**
- Create: `docs/install.md`, `docs/day-two.md`, `docs/teardown.md`, `docs/move-account.md` (`git add -f`)
- Modify: `docs/architecture-production.md`, `docs/releases.md` (`git add -f`)
- Modify: `packages/cli/src/deploy/export-bundle.ts` (the README's teardown section)
- Modify: `specs/015-installer/spec.md`, `specs/015-installer/plans/README.md`
- Test: `tests/contract/day-two-docs.test.ts`, `tests/contract/export-bundle.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/contract/day-two-docs.test.ts`:

```ts
// FR-054's guides stay true to the code: every config key is in the day-2 guide's table with the
// place it maps to, and the teardown guide gives destroy's order and the worker tag guard.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONFIG_KEYS } from "../../packages/cli/src/config/keys.js";

const read = (path: string) => readFileSync(path, "utf8");

describe("the guides (FR-054)", () => {
  it("lists every config key in the day-2 guide, on one table row with where it lives", () => {
    const rows = read("docs/day-two.md").split("\n").filter((line) => line.startsWith("| `"));
    for (const entry of CONFIG_KEYS) {
      const row = rows.find((line) => line.startsWith(`| \`${entry.key}\` |`));
      expect(row, entry.key).toBeDefined();
      const place = entry.target.kind === "stack-parameter" ? entry.target.parameter : entry.target.kind === "settings" ? "alertAddress" : `WORKSPACE_LIMITS.${entry.target.field}`;
      expect(row, entry.key).toContain(place);
    }
  });

  it("gives the teardown order, the three worker tags, and agentx destroy", () => {
    const guide = read("docs/teardown.md");
    expect(guide).toContain("agentx --env <env> destroy --region <region>");
    expect(guide).toContain("Name=tag:agentx:env,Values=<env>");
    const order = ["agentx-<env>-slack", "agentx-<env>-runtime", "agentx-<env>-control-plane", "aws ec2 terminate-instances", "agentx-<env>-identity", "agentx-<env>-foundation", "agentx-<env>-access"];
    const positions = order.map((text) => guide.indexOf(text));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(guide).toContain("https://github.com/PrepLabsAI/AgentX/issues/66");
  });

  it("has an install guide for each path, and a move guide that links #67", () => {
    const install = read("docs/install.md");
    for (const heading of ["## With published templates (recommended)", "## With cdk", "## Through your platform team (export)"]) expect(install).toContain(heading);
    expect(read("docs/move-account.md")).toContain("https://github.com/PrepLabsAI/AgentX/issues/67");
  });

  it("uses no em dash in any guide", () => {
    for (const path of ["docs/install.md", "docs/day-two.md", "docs/teardown.md", "docs/move-account.md"]) expect(read(path), path).not.toContain("\u2014");
  });
});
```

In `tests/contract/export-bundle.test.ts`, next to the existing `step4Body` expectations, add:

```ts
    expect(step4Body).toContain("Name=tag:agentx:env,Values=staging");
    expect(readmeText).toContain("agentx --env staging destroy --region us-east-1 does all of this");
```

(Use the environment and region the file's fixture uses, if they differ from `staging` and `us-east-1`.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/contract/day-two-docs.test.ts tests/contract/export-bundle.test.ts`
Expected: FAIL: the guides do not exist; the bundle README has no destroy line.

- [ ] **Step 3: The export bundle's teardown text**

In `packages/cli/src/deploy/export-bundle.ts`'s `readme`, replace the paragraph starting
"\`agentx destroy\` is planned for phase 15e" with:
"\`agentx --env ${env} destroy --region ${region}\` does all of this, in this order, with admin
credentials; it asks you to type the environment's name first. The steps below are the same work
by hand." In step 4, add `Name=tag:agentx:env,Values=${env}` to both the `describe-instances` and
the `describe-volumes` filters, and one sentence: "The agentx:env tag keeps the workers of any other
deployment in this account out of the list, including the one that predates named environments,
whose workers are also tagged Environment=production."

- [ ] **Step 4: Write the guides**

`docs/install.md` ("Installing AgentX"), under 250 lines:
- Before you start: an AWS account (a dedicated one, `DEDICATED_ACCOUNT_NOTE`'s words), admin
  credentials for the first run, Node 22, a GitHub organization or account, a Slack workspace where
  you can create apps, an email address for alerts, the region's quotas (vCPUs `L-1216C47A`, two
  free EC2-VPC Elastic IPs `L-0263D0A3`).
- `## With published templates (recommended)`: `npx @charterarc/agentx --env <env> init --region
  <region>`; each step in `INIT_STEP_IDS` order with one sentence each (prerequisites, access, core,
  github-app, control-plane, slack-app, slack-service, developer-signin, admin-user, first-project,
  connectors, alerts, e2e); what `init` asks you to click or paste; resuming (`agentx init` again);
  `--no-browser`; `--yes` with every flag; the cost estimate.
- `## With cdk`: `cdk bootstrap` (or `--yes`), a clean checkout of tag `v<version>`,
  `--engine cdk --source <dir>`; the one secret-handling difference (the signing key in the process
  list, from the spec's decision).
- `## Through your platform team (export)`: `agentx --env <env> init --export <dir> --region
  <region> --release <dir> --operator-principal <arn>`; what the bundle holds; the platform team runs
  `deploy-access.sh`; the operator runs `agentx init --resume --env <env> --region <region>
  --from-bundle <dir>` with the operator role.
- After install: link to docs/day-two.md.

`docs/day-two.md` ("Running AgentX"), under 250 lines:
- `## Check it`: `agentx --env <env> doctor --region <region>`; every check group from Tasks 5 to 8
  in one line each; `--json`; exit codes (0, and 2 when a check fails); drift needs admin
  (question 5); the Elastic IP line.
- `## Upgrade`: `agentx --env <env> upgrade [--to <version>]`; what it shows (notes, IAM changes,
  data replacements); `--allow-replace <logical-id>`; the order; stopping and re-running; the
  operator role and the access stack (question 9); `upgrade --export <dir>` for a pipeline; never
  downgrading (question 3); operator settings are kept.
- `## Change settings`: `agentx config list|get|set`, then this table, one row per key:

  | Key | Where it lives | Default | Notes |
  |---|---|---|---|
  | `models.orchestrator` | stack parameter ModelId on agentx-<env>-slack, and the settings | from init | tested with one call first |
  | `models.classifier` | stack parameter GateClassifierModelId on agentx-<env>-slack, and the settings | from init | tested with one call first |
  | `models.worker` | stack parameter ModelId on agentx-<env>-runtime, and the settings | from init | tested with one call first |
  | `limits.workspacesPerMember` | control-plane setting WORKSPACE_LIMITS.perPerson (install-time default SlackMemberWorkspaceLimit) | 3 | changed with spec 025 phase 25e's admin tool |
  | `limits.workspacesPerOrg` | control-plane setting WORKSPACE_LIMITS.perOrganization (install-time default SlackOrganizationWorkspaceLimit) | 20 | changed with spec 025 phase 25e's admin tool |
  | `limits.threadTurnsPerMinute` | stack parameter SlackThreadTurnsPerMinute on agentx-<env>-control-plane | 6 | 1 to 60 |
  | `slack.appPostedMessages` | stack parameter SlackAppPostedMessages on agentx-<env>-control-plane | accept | accept or ignore |
  | `alerts.address` | SSM /agentx/<env>/settings (alertAddress) | none | a webhook comes from --value-file or --value-env |
  | `alerts.slowTurnMinutes` | stack parameter SlowTurnMinutes on agentx-<env>-slack | 5 | 1 to 60 |
  | `budget.monthlyUsd` | stack parameter BudgetMonthlyUsd on agentx-<env>-control-plane | 0 | 0 for none |
  | `budget.scope` | stack parameter BudgetScope on agentx-<env>-control-plane | tag | tag or account |

  and, after it: changing `alerts.address` leaves the old subscription until an admin removes it
  (question 8), with the command.
- `## Projects, channels and connectors`: `agentx project add`, `channel add`,
  `connector add linear|jira|asana`, `alerts test` (15d2), one line each.
- `## Developer sign-in`: `agentx signin show|enable|disable|check` (spec 025), one line each.

`docs/teardown.md` ("Removing an environment"), under 200 lines, linking
https://github.com/PrepLabsAI/AgentX/issues/66:
- `## With agentx destroy`: `agentx --env <env> destroy --region <region>` with admin credentials;
  what it removes, in order (this plan's Decisions list, in plain words); the typed name, and the
  account id for `production` or an environment with no record; `--keep-data`; the 20 to 40 minute
  control-plane delete; re-running after a failure; what it prints for you to do (the GitHub App and
  Slack app pages, connector credentials).
- `## By hand`: the same steps as commands, in order: termination protection off; delete
  `agentx-<env>-slack`, `agentx-<env>-runtime`, `agentx-<env>-control-plane`, each with
  `aws cloudformation delete-stack` then `aws cloudformation wait stack-delete-complete`; the
  workers with `aws ec2 describe-instances --filters Name=tag:DeploymentMode,Values=ec2-ebs
  Name=tag:Environment,Values=<env> Name=tag:agentx:env,Values=<env>`, `aws ec2
  terminate-instances`, `aws ec2 wait instance-terminated`, the volumes with the same filters and
  `aws ec2 delete-volume`; delete `agentx-<env>-identity`, `agentx-<env>-foundation`,
  `agentx-<env>-access`; then the retained resources, each with its command (the export bundle's
  step 6 commands); every `agentx/<env>/` secret with `--force-delete-without-recovery`; every
  `/agentx/<env>/` parameter; the local files.

`docs/move-account.md` ("Moving AgentX to another account"), under 100 lines, linking
https://github.com/PrepLabsAI/AgentX/issues/67: moving is reinstalling (the spec's decision). Install
in the new account (docs/install.md) with new GitHub and Slack apps, or move the Slack app's Request
URLs to the new environment; register the projects again from `~/.agentx/projects/*.yaml` with
`agentx admin project register --file`; add the connectors again; what does not move (turn records,
workspaces, developer sign-in sessions; people sign in again); then `agentx destroy` the old one.

`docs/architecture-production.md`: in "Installing with agentx init", link docs/install.md; replace
"Tearing down an environment"'s first paragraph with a link to docs/teardown.md and one sentence on
`agentx destroy`; add `agentx:env` to its worker filter sentence.

`docs/releases.md`, a new section "The release test":
- One-time owner setup: a throwaway AWS account; an IAM role GitHub can assume from this
  repository's `workflow_dispatch` runs, in `vars.AGENTX_RELEASE_TEST_ROLE_ARN`; the private ECR
  repositories `agentx-release-test/worker` and `agentx-release-test/slack`; a test GitHub App
  (`vars.RT_GITHUB_ACCOUNT`, `vars.RT_GITHUB_APP_ID`, `vars.RT_GITHUB_INSTALLATION_ID`,
  `secrets.RT_GITHUB_PRIVATE_KEY`) and a test Slack app (`vars.RT_SLACK_CLIENT_ID`,
  `secrets.RT_SLACK_BOT_TOKEN`, `secrets.RT_SLACK_SIGNING_SECRET`, `secrets.RT_SLACK_CLIENT_SECRET`).
- Running it: Actions, Release test, the previous and candidate versions.
- The manual release check, before tagging: one full `agentx init` to a Slack reply,
  `agentx alerts test`, a teardown by docs/teardown.md's "By hand" section, and, once, SC-001.

- [ ] **Step 5: The spec and the plans README**

In `specs/015-installer/spec.md`:
- Reword FR-014: "The installer MUST deploy EC2 workers (`ec2-ebs`); the retired runtime modes and
  the maintainers' `AgentXReleasePipeline` stack are not installed."
- Reword FR-015's second bullet: "that the region's EC2 quotas allow a worker (vCPUs `L-1216C47A`)
  and the environment's two NAT gateways (two free EC2-VPC Elastic IPs, `L-0263D0A3`), and that
  Bedrock is available;".
- Reword FR-055: drop the capacity provider from its list and from `--keep-data`; the warning
  becomes "that deleting the worker volumes deletes every worker session's workspace"; the secrets
  line becomes "every secret under `agentx/<env>/` (deleted without recovery, so the names can be
  reused)"; add "It MUST terminate the environment's EC2 worker instances and delete their volumes
  (tagged `DeploymentMode=ec2-ebs`, `Environment=<env>` and `agentx:env=<env>`) after the
  control-plane stack and before the foundation stack."
- Add to Decisions, each dated with the day the owner answered, marked "phase 15e plan; owner
  decision" with "accepted" or "changed", carrying the owner's answer to each of the 11 questions in
  phase-15e-questions.md, plus these plan decisions: operator parameters survive upgrades
  (`OPERATOR_PARAMETERS`); upgrade review per stack; doctor's release check by package hashes and
  image digests, and the engine by `BootstrapVersion`; the bound-channel limit until spec 025 phase
  25d; the release test's scope.
- Note, without rewording it, that SC-005's "all" excludes `destroy` (question 7) and an access-stack
  change during `upgrade` (question 9).

In `specs/015-installer/plans/README.md`, when the PR is opened, change the 15e row's plan cell to
"[phase-15e-day-two.md](phase-15e-day-two.md) (built, PR #<number>)".

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/contract/day-two-docs.test.ts tests/contract/export-bundle.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -f docs/install.md docs/day-two.md docs/teardown.md docs/move-account.md docs/architecture-production.md docs/releases.md
git add packages/cli/src/deploy/export-bundle.ts specs/015-installer/spec.md specs/015-installer/plans/README.md tests/contract/day-two-docs.test.ts tests/contract/export-bundle.test.ts
git commit -m "docs: install, day-2, teardown and move guides; destroy in the bundle README; phase 15e decisions"
```

### Task 20: Live check and SC-001 (owner present)

This task changes no code unless it finds a defect; a defect is fixed with a failing test first,
then reviewed. It needs the owner's explicit go-ahead, an admin session on the owner's machine
(`aws login --profile agentx-admin`, driven from this session), and a test GitHub organization and
Slack workspace the owner chooses. Never production's apps, stacks or `/agentx/production/*`.

It uses two new environment names in account 944937319445, `us-east-1`: `live15ea` (templates) and
`live15eb` (cdk).

- [ ] **Step 1: Prepare (read-only)**
  - Build two releases: from mainline `dd61839`, `npm run release:build -- --version 0.0.4 --out <scratch>/old`;
    from this branch, `npm run release:build -- --version 0.0.5 --out <scratch>/new`.
  - Build and push this branch's worker image to a private repository in the account (for the
    Python check), and read production's current Slack image digest from its stack parameters, as
    15d2's live check did. Pass both with the testing-only image flags.
  - Confirm neither environment exists: `aws ssm get-parameters-by-path --path /agentx/live15ea --recursive --region us-east-1` (and `live15eb`) return nothing.
  - Count free Elastic IPs: `aws ec2 describe-addresses --region us-east-1` and the `L-0263D0A3`
    quota. Two environments need four; stop and tell the owner if fewer are free.
  - Prove SC-005 for the new commands with the policy simulator once `live15ea`'s access stack
    exists: `aws iam simulate-principal-policy --policy-source-arn <agentx-live15ea-operator ARN>`
    for every action in `CONFIG_AWS_ACTIONS`, `DOCTOR_AWS_ACTIONS` and `UPGRADE_AWS_ACTIONS` on
    this environment's resources. Expected: every one `allowed`.

- [ ] **Step 2: Owner approval**

Tell the owner what will exist (two environments' stacks, the test apps' use, one worker while a
reply runs), the running cost (about $3 a day per environment, from 15d1's figures, plus the
worker), and that both are destroyed at the end with `agentx destroy`. Wait for the go-ahead.

- [ ] **Step 3: Install on the old release, then break one thing (US4's independent test)**
  - `node packages/cli/dist/main.js --env live15ea init --region us-east-1 --release <scratch>/old --budget 10` to a Slack reply.
  - `agentx --env live15ea doctor`: every check `ok` or `warn`; record the count and each warning.
  - Store a revoked bot token (reinstall the Slack app, do not store the new token). `doctor` must
    fail "Slack refused the bot token (...)", name the fix, and exit 2. Restore the token; `doctor`
    passes.

- [ ] **Step 4: Config and the budget across an upgrade (item 1)**
  - `agentx --env live15ea config set models.orchestrator <a model the account cannot use>`: refused, nothing changed.
  - `agentx --env live15ea config set limits.threadTurnsPerMinute 12` and `config set budget.monthlyUsd 20`: each shows its change set and applies.
  - `agentx --env live15ea upgrade --release <scratch>/new`: record the notes line, the per-stack
    review (IAM changes, data replacements), and doctor at the end.
  - After it: `aws cloudformation describe-stacks --stack-name agentx-live15ea-control-plane` shows
    `SlackThreadTurnsPerMinute` 12 and `BudgetMonthlyUsd` 20; `aws budgets describe-budget` shows $20.

- [ ] **Step 5: Python in the worker (item 4)**

Register a small Python repository (a `pyproject.toml` and one pytest test) as a project on
`live15ea` with `agentx project add` (test command `uv run pytest`, or `python3 -m venv .venv &&
.venv/bin/pip install -e . pytest && .venv/bin/pytest`). Ask AgentX in its channel to run the tests.
Expected: the tests run and pass in the worker. Record the worker's reply.

- [ ] **Step 6: The cdk engine (Tasks 5 and 11's live confirmations)**
  - Install `live15eb` with `--engine cdk --source <a checkout of v0.0.4>` up to
    `--stop-after developer-signin`; upgrade with `--source <this branch tagged v0.0.5 locally>`.
  - Record one real `cdk diff` output and confirm `cdkDiffRisks`' resource-line pattern matches it
    (fix the parser with a test from the real text if not).
  - Confirm `BootstrapVersion` is a parameter of every `live15eb` stack and of no `live15ea` stack.

- [ ] **Step 7: Destroy, timed (item 3)**
  - `agentx --env live15eb destroy --region us-east-1`, typing the name. Record each stack's delete
    time (the control-plane one especially) and every progress line.
  - `agentx --env live15ea destroy --region us-east-1 --keep-data`, then `agentx --env live15ea
    destroy --region us-east-1` again: the second run removes what the first kept, from the saved
    inventory.
  - Confirm nothing is left: `aws cloudformation list-stacks --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE ROLLBACK_COMPLETE DELETE_FAILED`
    shows no `agentx-live15e*`; `aws ssm get-parameters-by-path --path /agentx/live15ea --recursive`
    and `live15eb` show nothing; `aws secretsmanager list-secrets --filters Key=name,Values=agentx/live15e`
    shows nothing (force-deleted secrets can take a few minutes); `aws ec2 describe-volumes --filters Name=tag:agentx:env,Values=live15ea`
    shows nothing; the KMS keys are `PendingDeletion`; `aws kms list-aliases` shows no
    `alias/agentx/live15e`; `aws cognito-idp list-user-pools --max-results 60` shows no live15e pool.
  - Confirm the printed GitHub App and Slack app pages open the right apps; delete both.

- [ ] **Step 8: The release test workflow**

If the owner has set up the throwaway account (docs/releases.md), run "Release test" with previous
`0.0.4` and candidate `0.0.5` and record the run. Otherwise record it as not yet run, for the owner.

- [ ] **Step 9: SC-001, the manual check (once, before this spec is done)**

With the owner, a person who has never seen AgentX installs it from docs/install.md on a clean
machine and a new AWS account, with no help, to a Slack reply. Record every place they get stuck, and
open one issue for each. The spec is done only when each is fixed (SC-001); this can finish after the
PR merges.

- [ ] **Step 10: Record the evidence**

Record the commands, outcomes, timings, simulator results, the cdk diff sample, the Python run and
every defect fixed in the PR description. Anything that changes a decision above goes to the owner
before the PR merges.

## Not in this phase

- Listing every bound channel in `doctor`: needs spec 025 phase 25d's admin read routes.
- `config set limits.workspacesPerMember` and `limits.workspacesPerOrg`: spec 025 phase 25e's admin
  change tool (question 4).
- Starting drift detection from `doctor` (question 5), and a live Asana refresh (question 10).
- An unattended Slack reply and `alerts test` in the release test: needs the Slack App Manifest
  API with an app configuration token (question 6).
- Moving an environment between accounts beyond the reinstall guide (#67, out of scope).
- Day-2 commands for the legacy deployment: it keeps its own release pipeline.

## Self-review

- **Spec coverage.**
  - FR-042 (notes, every change, IAM separately, change sets and `cdk diff`): Tasks 10, 11, 12.
  - FR-043 (stop on replacing a table, user pool, bucket or secret; typed name or `--allow-replace`): Task 11, pinned in Task 12.
  - FR-044 (order, stop at first failure, earlier stacks kept, re-run, doctor at the end): Task 12.
  - FR-026's `upgrade --export`: Task 13.
  - FR-048 (the keys, each mapped to one place, unknown and invalid refused): Tasks 3, 4; the docs table: Task 19.
  - FR-049 (show before applying, parameter-only update, SSM at once, model test first): Task 4.
  - FR-050 (stacks, version, engine, drift, secrets, Slack token, URLs, channel membership, GitHub App, connector reads, models, alerts, budget; saved connector warnings): Tasks 5 to 8.
  - FR-051 (`--json`, non-zero exit): Tasks 8, 9. Spec 025 FR-046 (sign-in checks): Task 8.
  - FR-055 (typed name, protection off, reverse order, retained resources, keep-data, settings and lock last, re-run safe): Tasks 14 to 17; the workers between control-plane and foundation (the scope amendment): Task 16.
  - FR-054 (install per path, day-2, teardown, move): Task 19.
  - SC-001: Task 20 Step 9. SC-002: recorded in Task 20 Step 3. SC-003 and SC-004: the release test (Task 18) and Task 20 Steps 4 and 6. SC-005: `day-two-permissions.test.ts` (Tasks 4, 9, 12) and the simulator (Task 20 Step 1). SC-006: each task's no-secret assertions (Tasks 4, 6, 7, 8, 13).
  - The brief's items: 1 (budget kept on upgrade) Task 1, proven live in Task 20 Step 4; 2 (connector warnings) Task 7; 3 (destroy) Tasks 14 to 17, the `ROLLBACK_COMPLETE` line in Task 17; 4 (Python) Task 2, live in Task 20 Step 5; 5 (Elastic IPs in doctor) Task 8.
  - The 15d2 plan's hand-offs: FR-014 and FR-015 reworded (Task 19); `alerts.address`, `alerts.slowTurnMinutes` and the budget in `config` (Tasks 3, 4); connector warnings in doctor (Task 7); destroy removes connector secrets, project files and workers (Task 16); the legacy upgrade path (refused, Decisions).
- **Placeholders.** None of "TBD", "TODO" or "similar to Task N". Where a step depends on a name in
  an existing file this plan could not quote (a fixture's options, a test harness), it names the file
  and what to match. The guides in Task 19 are specified section by section with every command.
- **Type consistency.** `OPERATOR_PARAMETERS` and `templateParameterNames` (Task 1) are used by
  Tasks 3, 12 and 13 unchanged. `DoctorServices` is complete in Task 5 (no field is added later);
  `runDoctor(input: { env; store; services: (settings) => DoctorServices })` (Task 8) is what Tasks
  9 and 12 call. `DestroyApi` (Task 15) is the interface Tasks 16 and 17 and the fake use. The three
  `*_AWS_ACTIONS` lists live in `day-two-actions.ts` (Tasks 4, 9, 12) and one test file checks them.
  `upgradeConfirm` returns `{ confirm, refusal }` (Task 11), as Task 12 uses it.
- **Review Focus.** Each line has its test: 1 in Tasks 1 and 12 ("does not send a parameter the new
  template no longer declares", "lists a config key the new release drops"); 2 in Tasks 14 and 16
  (the `prod`/`prod-eu`/`prod-foundation` guards, "never touches a sibling environment"); 3 in Task 16
  ("stops at a stack that cannot be deleted ... continues", "offers to take over its own lock"); 4 in
  Tasks 6 and 8 (malformed secrets, a vendor echoing the key); 5 in Task 4 (invalid value, failing
  model, declined change).
