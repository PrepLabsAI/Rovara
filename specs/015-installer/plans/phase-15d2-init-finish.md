# Phase 15d2: `agentx init` From the Admin User to a Slack Reply Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `agentx init` finishes the job that phase 15d1 started. After the Slack service and
developer sign-in are set up, it:
- creates the admin user (Cognito) or checks the admin claim (your own OIDC), and signs in;
- sets up the first project on `ec2-ebs` and binds its channel;
- offers the Linear, Jira and Asana connectors, each tested with one real read before it is saved;
- subscribes the alert address, checks the alarms and the budget, and sends a test alarm;
- ends when a person's message in the channel gets an AgentX reply in its thread.

`agentx init --resume` does all of this under the narrow operator role, including after a platform
team deployed the export bundle. The same work is also offered as day-2 commands: `agentx project
add`, `agentx channel add`, `agentx connector add linear|jira|asana` and `agentx alerts test`.

**Architecture:**
- **One module per job, under `packages/cli/src/setup/`.** Each takes an admin session (the control
  plane URL and an admin access token) and injected vendor and AWS interfaces, and knows nothing
  about `init`. The day-2 commands (`setup/cli.ts`) and the new init steps (`init/finish-steps.ts`)
  are thin wrappers around the same functions, so both behave the same.
- **Five new init steps after `developer-signin`:** `admin-user`, `first-project`, `connectors`,
  `alerts`, `e2e`. The 15d1 runner, install state, prompts and secret sources are reused. Progress
  gains the admin, project, connector and alert facts, written the moment they are known.
- **Alarms and the budget are infrastructure,** not CLI calls. The five missing alarms and a test
  alarm go in the Slack stack, and the budget goes in the control-plane stack, both only under
  environment naming, so the legacy templates stay byte-identical. The CLI only subscribes the
  alert address (a webhook address is a secret, so it cannot be a template parameter) and flips
  the test alarm.
- **Every AWS, vendor, browser, clock and prompt dependency is injected,** as in 15d1. No test
  reaches AWS, GitHub, Slack, Linear, Atlassian or Asana. A fake control plane (`fetch`) serves the
  admin routes in tests.

**Tech Stack:** TypeScript 5.9 strict (`exactOptionalPropertyTypes` on), Node 22.19 to 22.x, Zod 4,
Vitest, commander 15, AWS CDK 2 (`aws-cdk-lib/aws-budgets`, `aws-cloudwatch`, `aws-logs`, `aws-sns`),
AWS SDK v3 3.1134.0 (new in the CLI: `@aws-sdk/client-cognito-identity-provider`,
`@aws-sdk/client-sns`, `@aws-sdk/client-cloudwatch`), `yaml` 2.9.1, and `@agentx/gateway`'s
`connectMcp` for the Jira and Asana test reads (bundled into the npm CLI by `pack-cli.ts`).

**Spec:** [../spec.md](../spec.md). The FR numbers were re-checked against the current spec; FR-018's
list was renumbered on 2026-09-27, so the outline's "steps 6 to 10" are now steps 7 to 11:
- FR-018 steps 7 to 11 (admin user and login; first project; connectors; alerts and budget; the
  end-to-end check), and the scope amendment at the top of the spec (every new project is
  `ec2-ebs`, bound with `Ec2WorkerLaunchTemplateId` and `Ec2WorkerSubnets`);
- FR-019's operator-role resume for steps 4 to 11;
- FR-021's admin-claim check for your own OIDC provider;
- FR-026's `init --resume` after an export, and the decision "`agentx init --export` refuses
  `production` only when it is already installed", which says it changes in this phase;
- FR-036 to FR-041 (connectors, projects and channels);
- FR-045 to FR-047 (alerts, `alerts test`, the budget and the `agentx:env` tag).

The phase map is in [README.md](README.md). This plan replaces the outline that was left for
"after 15d1 merges".

**Depends on (all met at `e805b49`):**
- phase 15d1 merged (#98);
- issue #61's optional `siteUrl` on the Jira scope merged (#77);
- 15d1's open questions answered: the spec's Decisions record all ten as confirmed rulings;
- EC2 as the only runtime (#118, #134, issue #99 closed): `registerProject` accepts only `ec2-ebs`;
- OpenRouter as a model provider, with the key in `agentx/<env>/openrouter` (#139);
- phase 25a's `developer-signin` step, the last in `INIT_STEP_IDS` today (#143).

**Branch:** `feat/015d2-init-finish`, cut from mainline after this plan merges. One PR, against
`mainline`. Never stack it on another feature branch.

## Decisions recorded by this plan

- **Where the new steps go.** They go after `developer-signin`, which stays where 25a put it:

  | Step id | What it does | FR-018 step |
  |---|---|---|
  | `prerequisites` ... `slack-service` | unchanged from 15d1 | 1 to 6 |
  | `developer-signin` | unchanged from 25a | (spec 025 FR-044) |
  | `admin-user` | Cognito: create the user and add it to `agentx-admin`; sign in; check the admin route answers. Your own OIDC: sign in and check the admin claim | 7 |
  | `first-project` | `project add` for one repository, on `ec2-ebs`, then `channel add` without the reply check | 8 |
  | `connectors` | offer Linear, Jira and Asana; each is optional | 9 |
  | `alerts` | subscribe the address, check the alarms and budget exist, send the test alarm, ask if it arrived | 10 |
  | `e2e` | ask the engineer to mention the bot, wait for the threaded reply | 11 |

  Reasons:
  - **Resume stays simple.** The runner skips done steps in array order, and `INIT_STEP_IDS` is
    that order. Appending five ids moves no existing id, so a recorded `developer-signin` keeps its
    meaning and nothing is re-run.
  - **`developer-signin` needs nothing the new steps make.** It needs only the Slack service's
    settings, and it needs no admin token.
  - **`developer-signin` changes a control-plane stack parameter.** Putting it before the
    end-to-end check means the final reply is tested against the final stack.
  - **The end-to-end check must be last** (FR-018 step 11): it proves every earlier step together.
- **Every new project is `ec2-ebs`.** `project add` reads `Ec2WorkerLaunchTemplateId` and
  `Ec2WorkerSubnets` from the foundation stack's outputs and builds the binding with 15d1's
  `cliRuntimeBinding("ec2-ebs", ...)`: 20 GiB, `gp3`, as `admin project register` defaults. The
  EC2 vCPU quota is already checked by `prerequisites` (`ec2Quota()`).
- **The project file lives on disk, as today.** The control plane has no route that returns a
  registered definition. `project add` writes `<config dir>/<name>.yaml` (default
  `~/.agentx/projects/`, the directory `--project` already reads), and `connector add` edits that
  file, raises `revision` and registers it again. This is the file `admin project register --file`
  takes.
- **The repository's credential reference is the built-in GitHub App reference,** read from
  `admin credential list` (the entry with `builtIn: true` and type `github-app`), so a custom
  `GitHubAppCredentialRef` still works.
- **The CLI cannot post the test message itself.** The ingress never answers a bot (FR-034), and
  the bot is the only Slack identity the CLI holds. `channel add` and the `e2e` step ask the
  engineer to mention the bot, then watch turn records (`GET /v1/admin/turns`) for an `answered`
  turn in that channel after the prompt. No Slack history scope is needed. See spec conflicts.
- **Connector test reads (FR-038):**
  - **Linear:** the key lists its teams through Linear's GraphQL API before anything is stored.
    The engineer picks the team from that list, so the read and the pick are one step.
  - **Jira:** two searches through Atlassian's Rovo MCP server (`/v2`), with the token, before
    anything is stored: one inside the chosen project (must find at least one issue) and one
    outside it. This automates the Jira guide's Step 8. If the outside search finds issues, the
    connector is still saved, with a warning that names the other projects, says AgentX will be
    able to read issues in them, and suggests narrowing the account (owner decision 6). `init`
    records the warning in the install progress, so 15e's `doctor` can show it again.
  - **Asana:** the bot signs in once with 15d1's `authorizeCredential` (PKCE, `--no-browser` and
    `--expect-account` by default), then the CLI refreshes the token once and reads the chosen
    project with `get_project` before the project revision is saved.
  - For all three, the project revision is registered with `preflight: true`, and a preflight
    status other than `connected` fails the step with the control plane's reason.
- **Connector secrets live under `agentx/<env>/connectors/`,** which the broker already accepts
  (`environmentConnectorSecretPrefix`) and the operator role can write.
- **The test alarm is a real CloudWatch alarm.** The Slack stack gets `agentx-<env>-TestAlarm`,
  which never breaches on its own. `agentx alerts test` sets it to `ALARM`, then back to `OK`, with
  `SetAlarmState`. PagerDuty and Opsgenie CloudWatch integrations then receive a real alarm, not a
  plain SNS message they might drop.
- **The budget is asked with the other questions,** shown in the plan, and deployed with the
  control-plane stack (`BudgetMonthlyUsd`, `BudgetScope`), so it is in CloudFormation and removed
  with the stack. The `alerts` step only checks it exists and repeats the cost-allocation tag
  warning. The default is $100 a month on the `agentx:env` tag; `--budget 0` means none.
- **Operator-role resume after an export** reads the bundle's `init-answers.json` (the answers the
  export knew), asks the rest (GitHub, Slack, alerts, budget), checks the access stack exists,
  records `access` as done with the note "deployed by your platform team", and continues. Under the
  operator role, a pending `access` step is refused with what to ask the platform team.

## Owner decisions (2026-09-28)

The owner answered every open question on 2026-09-28. Six were accepted as recommended and one
was changed. The plan is written to these answers, and Task 15 records each one in the spec's
Decisions with that date.

1. **Cognito scoping for the operator role: accepted.** `cognito-idp:AdminCreateUser`,
   `AdminGetUser` and `AdminAddUserToGroup` on `userpool/*` in the account and region, with
   `aws:ResourceTag/agentx:env` equal to the environment. The user pool carries that tag (15a's
   `Tags.of(app)`), and an exact tag value cannot match a sibling environment. Task 16 proves it with
   the IAM policy simulator before the live run. If the tag condition turns out not to work for these
   actions, the fallback is the exact pool ARN, from the identity stack's `UserPoolId` output, in an
   operator-role policy. That needs an access-stack update.
2. **The budget when the `agentx:env` cost-allocation tag is not active yet: accepted.** The budget
   filters on the tag by default, with a warning in the plan and in the `alerts` step that it reads
   $0 until the tag is activated, and the exact Billing step to activate it:
   `BUDGET_TAG_NOTE`'s "Billing, Cost allocation tags". `--budget-scope account` is offered for a
   dedicated account.
3. **How `agentx alerts test` confirms: accepted.** It asks the engineer, and also makes two reads:
   before sending, the subscription must be confirmed (not `PendingConfirmation`); after sending,
   the alarm's history must show the change to `ALARM`. No SNS delivery-status logging.
4. **The budget lives in CloudFormation: accepted.** It is answered with the other questions and
   deployed with the control-plane stack; the service role gains `budgets:*`.
5. **Where the project file lives: accepted.** On disk, at `~/.agentx/projects/<name>.yaml`, which
   is what `admin project register --file` takes. A read route for registered definitions belongs to
   a later phase.
6. **A Jira service account that can see other projects: changed.** It is warned about and saved,
   not refused. The warning:
   - names the other projects it can see: up to 5 project keys, then "and N more";
   - says AgentX will be able to read issues in them;
   - suggests narrowing the account to the connected project (the Jira guide's Step 4).

   Under `--yes` it saves with the same warning printed; it never asks. `init` records the warning
   in the install progress (`connectors[].warning`), so a later `doctor` (15e) can show it. The day-2
   `agentx connector add jira` prints it and exits 0. The check for at least one issue inside the
   connected project still refuses when it finds none. Task 10 carries this, with Tasks 2, 12 and 15.
7. **The test message for `channel add` (FR-041): accepted.** The engineer mentions the bot, the CLI
   watches turn records for the threaded reply, and FR-041 is reworded.

## Spec conflicts found

These are also listed in the report and recorded by Task 15:
- **FR-018's step numbers moved.** The outline cited steps 6 to 10; after the 2026-09-27 amendment
  the admin user is step 7 and the end-to-end check is step 11. The README's phase row still says
  "steps 6 to 10" and is corrected by this plan's README line.
- **FR-018 does not list `developer-signin`.** Spec 025 FR-044 added it as init's last step. It now
  runs after step 6 and before step 7. Task 15 adds this to the "init step order" decision.
- **FR-041 asks the CLI to post a test message** that gets a threaded reply. The ingress ignores
  bots, so a message the CLI posts can never be answered. Owner decision 7.
- **FR-015 still names AgentCore** ("the region supports AgentCore Runtime") and **FR-014 names
  `instances-ebs`.** The scope amendment at the top of the spec supersedes both, but the text was
  not changed. This phase touches neither; Task 15 notes them for 15e.
- **`init --export` still refuses `--env production` outright** in `main.ts`, although the spec's
  decision says it changes in 15d2. Task 14 changes it.
- **FR-045 lists the budget among the alarms,** and FR-047 makes it an AWS budget. A budget
  notification is not a CloudWatch alarm; this plan sends both to the same topic, which is what the
  two together mean.

## Global Constraints

- **The live deployment does not change.** With no `agentxEnv`, templates are byte-identical
  (`tests/contract/legacy-templates.test.ts`). Never run vitest with `-u`. No test, and no step of
  the live check, touches production's stacks, `/agentx/production/*`, production's GitHub App,
  Slack app, Linear key, Jira token or Asana app.
- **No test reaches AWS, GitHub, Slack, Linear, Atlassian or Asana.** Every client is injected. The
  only real network use in tests is a loopback listener on `127.0.0.1`.
- **No secret value in output, logs, errors, local files or SSM:** the admin's tokens, the Slack bot
  token, the Linear API key, the Jira API token, the Asana client secret and refresh token, and the
  alert webhook address. Every task that handles one asserts its value appears in none of those.
  The project YAML file holds no secret, only credential references.
- **Secrets are never read from a flag's value.** They come only from a hidden prompt,
  `--<name>-file <path>` or `--<name>-env <NAME>` (FR-020), read whole, never cut at 128
  characters.
- **Exact names:**
  - connector secrets `agentx/<env>/connectors/linear`, `agentx/<env>/connectors/jira` and
    `agentx/<env>/connectors/asana`; credential references `linear`, `jira` and `asana`;
  - alarms `agentx-<env>-TurnErrors`, `-SlowTurns`, `-SlackDeliveryFailed`, `-CheckerFailures`,
    `-BedrockThrottling`, `-ClassifierThrottling` and `-TestAlarm`; the budget
    `agentx-<env>-monthly`; the topic `agentx-<env>-alerts` (15a);
  - the admin group `agentx-admin` (15b);
  - the bundle file `init-answers.json`.
- **Every new project is `ec2-ebs`.** No AgentCore, runtime ARN or capacity provider appears in any
  new code, test or doc.
- **Every secret the CLI creates carries the tag `agentx:env=<env>`** (FR-047).
- **Pinned dependencies:** exact versions, `3.1134.0` for every `@aws-sdk` client.
- **Copy:** plain words; every error says what to do next; no em dashes anywhere, including AWS
  resource names and descriptions.
- **The gate:** `npm run typecheck && npm run lint && npm run build && npm test && npm run infra:synth`.
  - Use Node 22: `export PATH=/private/tmp/claude-501/node-v22.20.0-darwin-arm64/bin:$PATH`.
  - Known load flakes (issue #59): rerun that file alone.

## Review Focus

1. **The admin user already exists** (a rerun after the first sign-in, or someone made it by hand,
   perhaps without the group). Expected: `AdminCreateUser` is not called again, no second email is
   sent, and the user is still added to `agentx-admin`. A user in `FORCE_CHANGE_PASSWORD` is told
   to use the temporary password from the first email. Pinned in Task 5.
2. **A stored admin token that is expired, or that belongs to a user who is not an admin.**
   Expected: an expired token triggers a new sign-in; a valid token that the admin route answers
   with 403 stops the step with "signed in as someone who is not an AgentX administrator" and how
   to fix it, instead of a later step failing with a bare HTTP 403. Pinned in Task 5.
3. **A Slack channel name typed with `#`, in capitals, or naming a private channel the bot is not
   in.** Expected: `#Payments` finds `payments`; a private channel prints `/invite @<bot>` and
   waits until the bot is a member; a missing channel lists how to create it. Pinned in Task 8.
4. **The person's mention gets an answer, but the turn failed or was abandoned** (for example,
   the worker could not start). Expected: the `e2e` step does not pass on an error reply. It says
   which disposition the turn had and points at `agentx admin turns export --since 15m`. Pinned in
   Task 8.
5. **A repository with no recognizable build files, or a `package.json` with no `test` script.**
   Expected: no invented command. The proposal is empty for that part, and the engineer is asked to
   type the command or leave it empty. Pinned in Task 6.

---

## File map

| File | Responsibility | Task |
|---|---|---|
| `packages/contracts/src/access-policies.ts` (modify) | operator role: admin user, alerts, test alarm, quotas, budget read; boundary and service role services | 1 |
| `packages/cli/src/init/install-state.ts` (modify) | the five step ids, the new progress facts, the budget answer | 2, 4 |
| `packages/cli/src/init/steps.ts` (modify) | `ProgressHandle.update` takes the new facts | 2 |
| `packages/cli/src/deploy/signing-key.ts` (modify) | tag created secrets `agentx:env` | 2 |
| `infra/lib/slack-orchestrator.ts` (modify) | the five alarms, the test alarm, their metric filters | 3 |
| `infra/lib/control-plane.ts` (modify) | the budget and the topic's budgets grant | 3 |
| `packages/slack-service/src/turn-records.ts` (modify) | `TurnDurationMs` and `GateCheckerFailed` metric lines | 3 |
| `packages/cli/src/deploy/answer-schemas.ts`, `parameters.ts`, `commands.ts` (modify) | budget answer; `OperatorAlertsTopicArn`, `BudgetMonthlyUsd`, `BudgetScope` | 3 |
| `packages/cli/src/init/answers.ts`, `plan.ts` (modify) | the budget question and plan line | 4 |
| `packages/cli/src/setup/admin-session.ts` | sign in, check the admin route, the OIDC claim | 5 |
| `packages/cli/src/setup/admin-user.ts` | Cognito admin user | 5 |
| `packages/cli/src/setup/services.ts` | `SetupServices`: every injected interface the setup modules use | 5 to 12 |
| `packages/cli/src/setup/project-files.ts` | list repositories, read build files, propose commands | 6 |
| `packages/cli/src/setup/project-add.ts` | build and register the project, write its file | 7 |
| `packages/cli/src/setup/channel-add.ts` | find, join and bind a channel | 8 |
| `packages/cli/src/setup/reply-watch.ts` | wait for an answered turn in a channel | 8 |
| `packages/cli/src/setup/connectors/revision.ts` | add a connector to the project file and register a new revision | 9 |
| `packages/cli/src/setup/connectors/linear.ts`, `jira.ts`, `asana.ts` | each connector's guide, test read and scope | 9, 10, 11 |
| `packages/cli/src/setup/alerts.ts` | subscribe, check alarms and budget, send the test alarm | 12 |
| `packages/cli/src/setup/cli.ts` | `project add`, `channel add`, `connector add`, `alerts test` | 7 to 12 |
| `packages/cli/src/init/finish-steps.ts` | the five init steps | 5, 7, 12, 13 |
| `packages/cli/src/init/context.ts`, `commands.ts`, `main.ts` (modify) | wiring, next steps text, `--from-bundle`, export rule | 13, 14 |
| `packages/cli/src/deploy/export-bundle.ts` (modify) | `init-answers.json`, the README's operator command | 14 |
| `tests/support/setup-fakes.ts` | fake control plane, Cognito, token store, Slack, GitHub, vendors, alerts | 5 to 12 |
| `docs/architecture-production.md`, `docs/connectors/*.md`, `specs/015-installer/spec.md` (modify) | the guide and the decisions | 15 |

---
### Task 1: Operator-role, boundary and service-role additions

**Files:**
- Modify: `packages/contracts/src/access-policies.ts` (`SERVICE_ROLE_SERVICES`, `BOUNDARY_SERVICES`, `operatorRoleStatements`)
- Test: `tests/contract/access-policies.test.ts`
- Modify if its generated check fails: `tests/contract/access-stack.test.ts` (the "every boundary service is used" list)

**Interfaces:**
- Consumes: `PolicyScope`, `operatorRoleStatements`, `serviceRoleStatements`, `defaultBoundaryStatements` (15c1).
- Produces: the operator role may, for this environment only:
  - `cognito-idp:AdminGetUser`, `AdminCreateUser`, `AdminAddUserToGroup` on `userpool/*` where `aws:ResourceTag/agentx:env` is the environment (Sid `AdminUser`);
  - `sns:Subscribe`, `sns:ListSubscriptionsByTopic`, `sns:GetTopicAttributes` on `agentx-<env>-alerts` (Sid `Alerts`);
  - `cloudwatch:SetAlarmState`, `cloudwatch:DescribeAlarmHistory` on `alarm:agentx-<env>-TestAlarm` (Sid `TestAlarm`);
  - `budgets:ViewBudget` on `budget/agentx-<env>-monthly` (Sid `Budget`);
  - `servicequotas:GetServiceQuota` on `*` (Sid `Quotas`, read-only, for `prerequisites` on a resume).
- The service role gains `budgets` in `SERVICE_ROLE_SERVICES`; the default boundary gains `budgets` (through that list) and `servicequotas`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/contract/access-policies.test.ts`, inside `describe("operator role policy", ...)`:

```ts
  it("may create the environment's admin user only in a user pool tagged for this environment", () => {
    const admin = operatorRoleStatements(scope).find((s) => s.Sid === "AdminUser")!;
    expect(admin.Action.sort()).toEqual(["cognito-idp:AdminAddUserToGroup", "cognito-idp:AdminCreateUser", "cognito-idp:AdminGetUser"]);
    expect(admin.Resource).toBe("arn:aws:cognito-idp:us-east-1:123456789012:userpool/*");
    expect(admin.Condition).toEqual({ StringEquals: { "aws:ResourceTag/agentx:env": "staging" } });
  });

  it("may subscribe to and read only this environment's alert topic, and never publish or unsubscribe", () => {
    const alerts = operatorRoleStatements(scope).find((s) => s.Sid === "Alerts")!;
    expect(alerts.Action.sort()).toEqual(["sns:GetTopicAttributes", "sns:ListSubscriptionsByTopic", "sns:Subscribe"]);
    expect(alerts.Resource).toBe("arn:aws:sns:us-east-1:123456789012:agentx-staging-alerts");
    expect(actions(operatorRoleStatements(scope))).not.toContain("sns:Publish");
    expect(actions(operatorRoleStatements(scope))).not.toContain("sns:Unsubscribe");
  });

  it("may flip only the test alarm, by its exact name", () => {
    const alarm = operatorRoleStatements(scope).find((s) => s.Sid === "TestAlarm")!;
    expect(alarm.Action.sort()).toEqual(["cloudwatch:DescribeAlarmHistory", "cloudwatch:SetAlarmState"]);
    // Exact, never agentx-staging-*: that would also match a sibling environment named staging-eu.
    expect(alarm.Resource).toBe("arn:aws:cloudwatch:us-east-1:123456789012:alarm:agentx-staging-TestAlarm");
  });

  it("may read only this environment's budget, and change none", () => {
    const budget = operatorRoleStatements(scope).find((s) => s.Sid === "Budget")!;
    expect(budget.Action).toEqual(["budgets:ViewBudget"]);
    expect(budget.Resource).toBe("arn:aws:budgets::123456789012:budget/agentx-staging-monthly");
    expect(actions(operatorRoleStatements(scope)).filter((a) => a.startsWith("budgets:"))).toEqual(["budgets:ViewBudget"]);
  });

  it("may read the EC2 vCPU quota, so prerequisites run on an operator resume", () => {
    const quotas = operatorRoleStatements(scope).find((s) => s.Sid === "Quotas")!;
    expect(quotas.Action).toEqual(["servicequotas:GetServiceQuota"]);
    expect(quotas.Resource).toBe("*");
  });
```

Add inside `describe("default permission boundary", ...)`:

```ts
  it("allows what the operator and service roles now use: budgets and the quota read", () => {
    const services = defaultBoundaryStatements(scope).find((s) => s.Sid === "Services")!.Action;
    expect(services).toContain("budgets:*");
    expect(services).toContain("servicequotas:*");
    expect(serviceRoleStatements(scope).find((s) => s.Sid === "Services")!.Action).toContain("budgets:*");
    expect(serviceRoleStatements(scope).find((s) => s.Sid === "Services")!.Action).not.toContain("servicequotas:*");
  });
```

If the `describe` names differ in the file, put each test in the `describe` whose other tests
exercise the same function.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/contract/access-policies.test.ts`
Expected: FAIL, the new statements are `undefined` and the boundary lacks `budgets:*`.

- [ ] **Step 3: Implement**

In `packages/contracts/src/access-policies.ts`:

```ts
export const SERVICE_ROLE_SERVICES: readonly string[] = [
  "apigateway",
  // The control-plane stack's monthly budget (phase 15d2, FR-047).
  "budgets",
  "cloudformation",
  // ...the rest unchanged
];

export const BOUNDARY_SERVICES: readonly string[] = [...SERVICE_ROLE_SERVICES, "bedrock", "codebuild", "execute-api", "servicequotas", "xray"];
```

Update the `BOUNDARY_SERVICES` doc comment: "plus what the environment's roles call (Bedrock
models, X-Ray, CodeBuild, API Gateway invoke, and the operator's EC2 quota read)".

Append to the array `operatorRoleStatements` returns, before `Identity`:

```ts
    {
      // FR-018 step 7: the admin user. The identity stack's user pool carries agentx:env (15a's
      // Tags.of(app)); an exact tag value cannot match another environment.
      Sid: "AdminUser",
      Effect: "Allow",
      Action: ["cognito-idp:AdminGetUser", "cognito-idp:AdminCreateUser", "cognito-idp:AdminAddUserToGroup"],
      Resource: `arn:${partition}:cognito-idp:${region}:${account}:userpool/*`,
      Condition: { StringEquals: { "aws:ResourceTag/agentx:env": env } },
    },
    {
      // FR-045: subscribe the alert address. No Publish: the test alarm goes through CloudWatch.
      Sid: "Alerts",
      Effect: "Allow",
      Action: ["sns:Subscribe", "sns:ListSubscriptionsByTopic", "sns:GetTopicAttributes"],
      Resource: `arn:${partition}:sns:${region}:${account}:agentx-${env}-alerts`,
    },
    {
      // FR-046: agentx alerts test flips this one alarm, named exactly.
      Sid: "TestAlarm",
      Effect: "Allow",
      Action: ["cloudwatch:SetAlarmState", "cloudwatch:DescribeAlarmHistory"],
      Resource: `arn:${partition}:cloudwatch:${region}:${account}:alarm:agentx-${env}-TestAlarm`,
    },
    // FR-047: the alerts step checks the budget CloudFormation made; it never changes it.
    { Sid: "Budget", Effect: "Allow", Action: ["budgets:ViewBudget"], Resource: `arn:${partition}:budgets::${account}:budget/agentx-${env}-monthly` },
    // prerequisites on an operator resume: read-only, and GetServiceQuota's quota ARN format is
    // not one this plan could confirm, so it is not scoped.
    { Sid: "Quotas", Effect: "Allow", Action: ["servicequotas:GetServiceQuota"], Resource: "*" },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/contract/access-policies.test.ts tests/contract/access-stack.test.ts tests/contract/export-bundle.test.ts tests/contract/permissions-boundary.test.ts`
Expected: PASS. If `access-stack.test.ts`'s generated "every boundary service is used" check fails
for `servicequotas`, add `servicequotas` to that test's list of services the operator role uses,
with the comment "the operator's EC2 quota read (prerequisites on a resume)". Never loosen the
check itself.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/access-policies.ts tests/contract/access-policies.test.ts tests/contract/access-stack.test.ts
git commit -m "feat(access): operator role may create the admin user, subscribe alerts, flip the test alarm"
```

### Task 2: Install state for the new steps, and tagged secrets

**Files:**
- Modify: `packages/cli/src/init/install-state.ts`
- Modify: `packages/cli/src/init/steps.ts` (`ProgressHandle.update`'s patch type)
- Modify: `packages/cli/src/deploy/signing-key.ts` (`secretsManagerValueStore.create`)
- Test: `tests/contract/init-install-state.test.ts`, `tests/contract/signing-key.test.ts`

**Interfaces:**
- Consumes: `InstallProgressSchema`, `INIT_STEP_IDS` (15d1); `secretsManagerValueStore` (15c2).
- Produces:

```ts
export const INIT_STEP_IDS = ["prerequisites", "access", "core", "github-app", "control-plane", "slack-app", "slack-service", "developer-signin", "admin-user", "first-project", "connectors", "alerts", "e2e"] as const;
export type ConnectorType = "linear" | "jira" | "asana";
// New optional InstallProgress fields:
//   admin?: { username: string; mode: "cognito" | "oidc" }
//   project?: { name: string; revision: number; channelName?: string; channelId?: string; teamId?: string }
//   connectors?: Array<{ type: ConnectorType; ref: string; warning?: string }>  // warning: owner decision 6
//   alerts?: { subscribed: boolean; tested: boolean }
export type ProgressPatch = Pick<Partial<InstallProgress>, "github" | "slack" | "admin" | "project" | "connectors" | "alerts">;
// ProgressHandle.update(patch: ProgressPatch): Promise<void>
export function secretTags(name: string): Array<{ Key: string; Value: string }>; // in signing-key.ts
```

- [ ] **Step 1: Write the failing tests**

Add to `tests/contract/init-install-state.test.ts`:

```ts
import { INIT_STEP_IDS, readInstallProgress, writeInstallProgress, emptyProgress } from "../../packages/cli/src/init/install-state.js";

describe("15d2 install state", () => {
  it("appends the five finishing steps after developer-signin, moving no earlier id", () => {
    expect(INIT_STEP_IDS).toEqual([
      "prerequisites", "access", "core", "github-app", "control-plane", "slack-app", "slack-service", "developer-signin",
      "admin-user", "first-project", "connectors", "alerts", "e2e",
    ]);
  });

  it("round-trips the admin, project, connector and alert facts", async () => {
    const store = new MemoryParameterStore();
    const progress = {
      ...emptyProgress("staging", T0),
      admin: { username: "alice@example.com", mode: "cognito" as const },
      project: { name: "payments", revision: 2, channelName: "payments", channelId: "C0123456789", teamId: "T0123456789" },
      connectors: [{ type: "linear" as const, ref: "linear" }, { type: "jira" as const, ref: "jira", warning: "the Jira service account can also see issues in HR, FIN" }],
      alerts: { subscribed: true, tested: false },
    };
    await writeInstallProgress(store, progress);
    expect(await readInstallProgress(store, "staging")).toEqual(progress);
  });

  it("refuses a project name or channel id that could not have come from AgentX or Slack", async () => {
    const store = new MemoryParameterStore();
    await expect(writeInstallProgress(store, { ...emptyProgress("staging", T0), project: { name: "Payments!", revision: 1 } })).rejects.toThrow("install progress is invalid: project.name");
    await expect(writeInstallProgress(store, { ...emptyProgress("staging", T0), project: { name: "payments", revision: 1, channelId: "D0123" } })).rejects.toThrow("project.channelId");
  });

  it("still reads progress an older agentx wrote, with none of the new fields", async () => {
    const store = new MemoryParameterStore();
    store.values.set("/agentx/staging/install/progress", JSON.stringify({ schemaVersion: 1, env: "staging", steps: { "developer-signin": { status: "done", at: "2026-09-27T00:00:00.000Z" } }, updatedAt: "2026-09-27T00:00:00.000Z" }));
    expect((await readInstallProgress(store, "staging"))?.steps["developer-signin"]?.status).toBe("done");
  });
});
```

(`MemoryParameterStore` and `T0` come from `../support/memory-parameter-store.js` and
`../support/init-fakes.js`; import them if the file does not already.)

Add to `tests/contract/signing-key.test.ts`:

```ts
import { CreateSecretCommand } from "@aws-sdk/client-secrets-manager";
import { secretsManagerValueStore, secretTags } from "../../packages/cli/src/deploy/signing-key.js";

describe("secrets the CLI creates carry agentx:env (FR-047)", () => {
  it("tags a secret under agentx/<env>/ with its environment", async () => {
    const sent: unknown[] = [];
    const client = { send: async (command: unknown) => { sent.push(command); return {}; } };
    await secretsManagerValueStore(client as never).create("agentx/staging/connectors/linear", "{}");
    const input = (sent[0] as CreateSecretCommand).input;
    expect(input.Tags).toEqual([{ Key: "agentx:env", Value: "staging" }]);
  });

  it("adds no tag to a name outside agentx/<env>/", () => {
    expect(secretTags("agentx/connectors/linear-payments")).toEqual([]);
    expect(secretTags("something-else")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/contract/init-install-state.test.ts tests/contract/signing-key.test.ts`
Expected: FAIL: the step list is short, `admin` is an unknown key, `secretTags` is not exported.

- [ ] **Step 3: Implement**

In `install-state.ts`:

```ts
export const INIT_STEP_IDS = [
  "prerequisites", "access", "core", "github-app", "control-plane", "slack-app", "slack-service", "developer-signin",
  // Phase 15d2, appended so no earlier id moves (resume skips done steps in this order).
  "admin-user", "first-project", "connectors", "alerts", "e2e",
] as const;

export const CONNECTOR_TYPES = ["linear", "jira", "asana"] as const;
export type ConnectorType = (typeof CONNECTOR_TYPES)[number];
```

Add to `InstallProgressSchema`'s object, after `slack`:

```ts
  admin: z.object({ username: z.string().min(3).max(128), mode: z.enum(["cognito", "oidc"]) }).strict().optional(),
  project: z.object({
    name: z.string().regex(AGENTX_NAME_PATTERN),
    revision: z.number().int().positive(),
    channelName: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/).optional(),
    channelId: z.string().regex(/^[CG][A-Z0-9]{8,}$/).optional(),
    teamId: z.string().regex(/^T[A-Z0-9]+$/).optional(),
  }).strict().optional(),
  // warning: a connector saved with a caution (owner decision 6: a Jira account that sees other
  // projects), kept so 15e's doctor can show it again. At most 300 characters, never a secret.
  connectors: z.array(z.object({ type: z.enum(CONNECTOR_TYPES), ref: z.string().regex(AGENTX_NAME_PATTERN), warning: z.string().min(1).max(300).optional() }).strict()).max(3).optional(),
  alerts: z.object({ subscribed: z.boolean(), tested: z.boolean() }).strict().optional(),
```

Import `AGENTX_NAME_PATTERN` from `@agentx/contracts`.

In `steps.ts`:

```ts
export type ProgressPatch = Pick<Partial<InstallProgress>, "github" | "slack" | "admin" | "project" | "connectors" | "alerts">;
export interface ProgressHandle {
  current(): InstallProgress;
  /** Merges step facts and writes progress at once, so a crash right after keeps them. */
  update(patch: ProgressPatch): Promise<void>;
}
```

In `signing-key.ts`:

```ts
/** FR-047: every resource carries agentx:env. A secret the CLI creates under agentx/<env>/ is
 * tagged with that environment; a name outside it (the legacy agentx/connectors/) is not. */
export function secretTags(name: string): Array<{ Key: string; Value: string }> {
  const match = /^agentx\/([a-z0-9-]{1,20})\//.exec(name);
  return match === null || match[1] === "connectors" ? [] : [{ Key: "agentx:env", Value: match[1]! }];
}
```

and in `create`:

```ts
        const tags = secretTags(name);
        await client.send(new CreateSecretCommand({ Name: name, SecretString: value, ...(tags.length === 0 ? {} : { Tags: tags }) }));
```

`secretsmanager:TagResource`, which `CreateSecret` with tags needs, is already in the operator
role's `Secrets` statement.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/contract/init-install-state.test.ts tests/contract/signing-key.test.ts tests/contract/init-steps.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/init/install-state.ts packages/cli/src/init/steps.ts packages/cli/src/deploy/signing-key.ts tests/contract/init-install-state.test.ts tests/contract/signing-key.test.ts
git commit -m "feat(init): progress for the finishing steps; tag created secrets agentx:env"
```

### Task 3: The alarms, the test alarm and the budget in the stacks

**Files:**
- Modify: `infra/lib/slack-orchestrator.ts`
- Modify: `infra/lib/control-plane.ts`
- Modify: `packages/slack-service/src/turn-records.ts` (`emitTurnMetrics`)
- Modify: `packages/cli/src/deploy/answer-schemas.ts` (`BudgetAnswersSchema`)
- Modify: `packages/cli/src/deploy/parameters.ts` (`InstallAnswers.budget`; slack and control-plane cases)
- Modify: `packages/cli/src/deploy/commands.ts` (`DeployAnswersSchema.budget` and its rebuild)
- Modify: `tests/support/init-fakes.ts` (`allStackOutputs` gains `OperatorAlertsTopicArn`)
- Test: `tests/contract/alert-alarms-infrastructure.test.ts` (new), `tests/contract/turn-alarm-metrics.test.ts` (new), `tests/contract/deploy-parameters.test.ts`

**Interfaces:**
- Consumes: `environmentNaming` (`infra/lib/naming.ts`), the control plane's `OperatorAlertsTopicArn` output.
- Produces:
  - Slack stack parameters, under environment naming only: `OperatorAlertsTopicArn` (String) and `SlowTurnMinutes` (Number, default 5, 1 to 60).
  - Control-plane stack parameters, under environment naming only: `BudgetMonthlyUsd` (String, default `"0"`, `0` means no budget) and `BudgetScope` (`tag` or `account`, default `tag`).
  - `export const BudgetAnswersSchema = z.object({ monthlyUsd: z.number().int().min(1).max(1_000_000), scope: z.enum(["tag", "account"]) }).strict();`
  - `InstallAnswers.budget?: { monthlyUsd: number; scope: "tag" | "account" }`.
  - Metric lines `{"event":"metric","metric":"TurnDurationMs","count":<ms>}` for every answered or failed turn, and `GateCheckerFailed` with the number of calls whose gate source is `classifier_unavailable` or `gate_error`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/contract/alert-alarms-infrastructure.test.ts
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { environmentNaming } from "../../infra/lib/naming.js";
import { SlackOrchestratorStack } from "../../infra/lib/slack-orchestrator.js";

const naming = environmentNaming("staging");
const slack = Template.fromStack(new SlackOrchestratorStack(new App(), "AlarmsSlack", { naming }));
const controlPlane = Template.fromStack(new ControlPlaneStack(new App(), "AlarmsControlPlane", { naming }));
const alarm = (name: string) => Object.values(slack.findResources("AWS::CloudWatch::Alarm", { Properties: { AlarmName: name } }))[0] as { Properties: Record<string, unknown>; Condition?: string } | undefined;

describe("FR-045 alarms in the Slack stack (environment naming)", () => {
  it("creates every alarm the spec names, each sending to the environment's topic", () => {
    for (const name of ["TurnErrors", "SlowTurns", "SlackDeliveryFailed", "CheckerFailures", "BedrockThrottling", "ClassifierThrottling", "TestAlarm"]) {
      const found = alarm(`agentx-staging-${name}`);
      expect(found, name).toBeDefined();
      expect(found!.Properties.AlarmActions).toEqual([{ Ref: "OperatorAlertsTopicArn" }]);
    }
  });

  it("turns failed turns and abandoned Slack requests into metrics from the service's own log events", () => {
    slack.hasResourceProperties("AWS::Logs::MetricFilter", Match.objectLike({
      FilterPattern: '{ $.event = "task.failed" }',
      MetricTransformations: [Match.objectLike({ MetricName: "TurnFailed", MetricNamespace: "AgentX/staging", MetricValue: "1" })],
    }));
    slack.hasResourceProperties("AWS::Logs::MetricFilter", Match.objectLike({
      FilterPattern: '{ $.event = "request.abandoned" }',
      MetricTransformations: [Match.objectLike({ MetricName: "SlackDeliveryFailed", MetricValue: "1" })],
    }));
  });

  it("compares the slowest turn in 5 minutes with SlowTurnMinutes", () => {
    slack.hasParameter("SlowTurnMinutes", { Type: "Number", Default: 5, MinValue: 1, MaxValue: 60 });
    expect(alarm("agentx-staging-SlowTurns")!.Properties.Threshold).toEqual({ Ref: "SlowTurnMinutes" });
  });

  it("watches Bedrock throttling only when the orchestrator or classifier runs on Bedrock", () => {
    const bedrock = alarm("agentx-staging-BedrockThrottling")!;
    expect(bedrock.Properties.Namespace).toBe("AWS/Bedrock");
    expect(bedrock.Properties.MetricName).toBe("InvocationThrottles");
    expect(bedrock.Properties.Dimensions).toEqual([{ Name: "ModelId", Value: { Ref: "ModelId" } }]);
    expect(bedrock.Condition).toBeDefined();
    expect(alarm("agentx-staging-ClassifierThrottling")!.Condition).toBeDefined();
  });

  it("keeps the test alarm quiet: it reads a metric nothing emits", () => {
    const test = alarm("agentx-staging-TestAlarm")!;
    expect(test.Properties.MetricName).toBe("TestAlarmNeverEmitted");
    expect(test.Properties.TreatMissingData).toBe("notBreaching");
  });
});

describe("FR-047 budget in the control-plane stack (environment naming)", () => {
  it("creates the monthly budget only when BudgetMonthlyUsd is not 0, alerting the topic", () => {
    controlPlane.hasParameter("BudgetMonthlyUsd", { Type: "String", Default: "0" });
    controlPlane.hasParameter("BudgetScope", { Type: "String", Default: "tag", AllowedValues: ["tag", "account"] });
    const budgets = controlPlane.findResources("AWS::Budgets::Budget");
    const [budget] = Object.values(budgets) as Array<{ Condition?: string; Properties: { Budget: Record<string, unknown>; NotificationsWithSubscribers: unknown[] } }>;
    expect(budget!.Condition).toBeDefined();
    expect(budget!.Properties.Budget.BudgetName).toBe("agentx-staging-monthly");
    expect(JSON.stringify(budget!.Properties.NotificationsWithSubscribers)).toContain("OperatorAlerts");
    expect(JSON.stringify(budget!.Properties.Budget.CostFilters)).toContain("user:agentx:env$staging");
  });

  it("lets AWS Budgets publish to the topic, from this account only", () => {
    const policies = JSON.stringify(controlPlane.findResources("AWS::SNS::TopicPolicy"));
    expect(policies).toContain("budgets.amazonaws.com");
    expect(policies).toContain("aws:SourceAccount");
  });
});

describe("the legacy stacks stay as they are", () => {
  it("adds none of this without environment naming", () => {
    const legacySlack = Template.fromStack(new SlackOrchestratorStack(new App(), "LegacySlack"));
    expect(Object.keys(legacySlack.findParameters("OperatorAlertsTopicArn"))).toEqual([]);
    expect(Object.keys(legacySlack.findResources("AWS::CloudWatch::Alarm"))).toEqual([]);
    const legacyControlPlane = Template.fromStack(new ControlPlaneStack(new App(), "LegacyControlPlane"));
    expect(Object.keys(legacyControlPlane.findResources("AWS::Budgets::Budget"))).toEqual([]);
  });
});
```

```ts
// tests/contract/turn-alarm-metrics.test.ts
import { describe, expect, it } from "vitest";
import { emitTurnMetrics } from "../../packages/slack-service/src/turn-records.js";

const call = (source?: string) => ({
  name: "t", arguments: "{}", argumentsFingerprint: "0".repeat(32), validation: "ok", outcome: "SUCCEEDED", durationMs: 1,
  ...(source === undefined ? {} : { gate: { outcome: "deny", source, reason: "x" } }),
});
const record = (overrides: Record<string, unknown>) => ({ disposition: "answered", emptyResponse: false, calls: [], durationMs: 420_000, ...overrides }) as never;

describe("metric lines the FR-045 alarms read", () => {
  it("reports every answered or failed turn's duration", () => {
    const lines: Array<[string, unknown]> = [];
    emitTurnMetrics(record({}), (event, fields) => { lines.push([event, fields]); });
    expect(lines).toContainEqual(["metric", { metric: "TurnDurationMs", count: 420_000 }]);
  });

  it("counts calls the action gate could not check (it failed closed)", () => {
    const lines: Array<[string, unknown]> = [];
    emitTurnMetrics(record({ calls: [call("gate_error"), call("classifier_unavailable"), call("classifier"), call()] }), (event, fields) => { lines.push([event, fields]); });
    expect(lines).toContainEqual(["metric", { metric: "GateCheckerFailed", count: 2 }]);
  });

  it("reports nothing for a turn that never ran the orchestrator", () => {
    const lines: unknown[] = [];
    emitTurnMetrics(record({ disposition: "workspace_limit" }), (...args) => { lines.push(args); });
    expect(lines).toEqual([]);
  });
});
```

Add to `tests/contract/deploy-parameters.test.ts` (reuse its answers and outputs fixtures; the
names below are the ones in that file's first `describe`, adjust if they differ):

```ts
  it("passes the alert topic to the Slack stack, and the budget to the control plane only when there is one", () => {
    expect(stackParameters("slack", answers, outputs).OperatorAlertsTopicArn).toBe(outputs["control-plane"]!.OperatorAlertsTopicArn);
    expect(stackParameters("control-plane", answers, outputs).BudgetMonthlyUsd).toBeUndefined();
    const withBudget = stackParameters("control-plane", { ...answers, budget: { monthlyUsd: 150, scope: "account" } }, outputs);
    expect(withBudget).toMatchObject({ BudgetMonthlyUsd: "150", BudgetScope: "account" });
  });
```

and add `OperatorAlertsTopicArn: "arn:aws:sns:us-east-1:123456789012:agentx-staging-alerts"` to that
file's control-plane outputs fixture and to `allStackOutputs`'s control-plane entry in
`tests/support/init-fakes.ts`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/contract/alert-alarms-infrastructure.test.ts tests/contract/turn-alarm-metrics.test.ts tests/contract/deploy-parameters.test.ts`
Expected: FAIL: no alarms, no budget, no new metric lines, no `OperatorAlertsTopicArn`.

- [ ] **Step 3: Implement the metric lines**

In `packages/slack-service/src/turn-records.ts`, inside `emitTurnMetrics` after the
`TurnCompleted` line:

```ts
  // FR-045's slow-turn alarm reads the slowest turn in each 5 minutes; "count" is the value field
  // every metric filter here maps.
  log("metric", { metric: "TurnDurationMs", count: record.durationMs });
  // FR-045's checker-failure alarm: the action gate could not check a call, so it failed closed.
  const checkerFailures = record.calls.filter((call) => call.gate?.source === "classifier_unavailable" || call.gate?.source === "gate_error").length;
  if (checkerFailures > 0) log("metric", { metric: "GateCheckerFailed", count: checkerFailures });
```

The legacy stack has no filter for either line, so the legacy deployment is unaffected.

- [ ] **Step 4: Implement the Slack stack alarms**

In `infra/lib/slack-orchestrator.ts`, import `CfnCondition`, `Fn`, `Duration` from `aws-cdk-lib`,
`aws-cloudwatch` as `cloudwatch`, `aws-cloudwatch-actions` as `cloudwatchActions` and `aws-sns` as
`sns`. After the existing metric filters, add:

```ts
    // FR-045, environment naming only, so the legacy template stays byte-identical. The topic is
    // the control plane's; its policy already lets any alarm in this account publish.
    if (naming.env !== undefined) {
      const alertsTopicArn = new CfnParameter(this, "OperatorAlertsTopicArn", {
        type: "String",
        description: "The environment's alert topic, the control plane's OperatorAlertsTopicArn output",
      });
      const slowTurnMinutes = new CfnParameter(this, "SlowTurnMinutes", {
        type: "Number", default: 5, minValue: 1, maxValue: 60,
        description: "A turn slower than this many minutes raises the SlowTurns alarm (alerts.slowTurnMinutes)",
      });
      const notify = new cloudwatchActions.SnsAction(sns.Topic.fromTopicArn(this, "OperatorAlerts", alertsTopicArn.valueAsString));
      const eventMetric = (id: string, event: string, metricName: string) => logGroup.addMetricFilter(id, {
        filterPattern: logs.FilterPattern.stringValue("$.event", "=", event),
        metricNamespace: naming.metricsNamespace, metricName, metricValue: "1",
      });
      eventMetric("TurnFailedMetric", "task.failed", "TurnFailed");
      eventMetric("SlackDeliveryFailedMetric", "request.abandoned", "SlackDeliveryFailed");
      for (const metric of ["TurnDurationMs", "GateCheckerFailed"]) {
        logGroup.addMetricFilter(`${metric}Metric`, {
          filterPattern: logs.FilterPattern.all(
            logs.FilterPattern.stringValue("$.event", "=", "metric"),
            logs.FilterPattern.stringValue("$.metric", "=", metric),
          ),
          metricNamespace: naming.metricsNamespace, metricName: metric, metricValue: "$.count",
        });
      }
      const agentx = (metricName: string, statistic: string) =>
        new cloudwatch.Metric({ namespace: naming.metricsNamespace, metricName, statistic, period: Duration.minutes(5) });
      const alarm = (id: string, props: { suffix: string; description: string; metric: cloudwatch.IMetric; threshold: number }) => {
        const created = new cloudwatch.Alarm(this, id, {
          alarmName: naming.alarmName(props.suffix),
          alarmDescription: props.description,
          metric: props.metric,
          threshold: props.threshold,
          evaluationPeriods: 1,
          comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });
        created.addAlarmAction(notify);
        return created;
      };
      alarm("TurnErrorsAlarm", { suffix: "TurnErrors", threshold: 1, metric: agentx("TurnFailed", "Sum"),
        description: "An orchestrator turn failed. Export recent turns with agentx admin turns export --since 1h." });
      alarm("SlowTurnsAlarm", {
        suffix: "SlowTurns",
        threshold: slowTurnMinutes.valueAsNumber,
        metric: new cloudwatch.MathExpression({
          expression: "slowest / 60000",
          usingMetrics: { slowest: agentx("TurnDurationMs", "Maximum") },
          period: Duration.minutes(5),
          label: "Slowest turn in minutes",
        }),
        description: "A turn took longer than alerts.slowTurnMinutes. Export recent turns with agentx admin turns export --since 1h.",
      });
      alarm("SlackDeliveryFailedAlarm", { suffix: "SlackDeliveryFailed", threshold: 1, metric: agentx("SlackDeliveryFailed", "Sum"),
        description: "A Slack request was given up after its last attempt, so the member got no answer. Check the Slack service logs for request.abandoned." });
      alarm("CheckerFailuresAlarm", { suffix: "CheckerFailures", threshold: 1, metric: agentx("GateCheckerFailed", "Sum"),
        description: "The action gate could not check a call and refused it. Check the classifier model's access and the Slack service logs." });
      const onBedrock = (id: string, provider: CfnParameter) => new CfnCondition(this, id, { expression: Fn.conditionEquals(provider.valueAsString, "amazon-bedrock") });
      const throttles = (id: string, suffix: string, model: CfnParameter, condition: CfnCondition, what: string) => {
        const created = alarm(id, {
          suffix, threshold: 5,
          metric: new cloudwatch.Metric({ namespace: "AWS/Bedrock", metricName: "InvocationThrottles", dimensionsMap: { ModelId: model.valueAsString }, statistic: "Sum", period: Duration.minutes(5) }),
          description: `Amazon Bedrock throttled the ${what} model at least 5 times in 5 minutes. Ask for a higher quota in Service Quotas, or choose another model.`,
        });
        (created.node.defaultChild as cloudwatch.CfnAlarm).cfnOptions.condition = condition;
      };
      throttles("BedrockThrottlingAlarm", "BedrockThrottling", modelId, onBedrock("OrchestratorOnBedrock", modelProvider), "orchestrator");
      throttles("ClassifierThrottlingAlarm", "ClassifierThrottling", gateClassifierModelId, onBedrock("ClassifierOnBedrock", classifierProvider), "classifier");
      alarm("TestAlarm", { suffix: "TestAlarm", threshold: 1, metric: agentx("TestAlarmNeverEmitted", "Sum"),
        description: "agentx alerts test sets this alarm to ALARM and back to OK. It never fires on its own." });
    }
```

`modelId`, `modelProvider`, `classifierProvider` and `gateClassifierModelId` are the existing
parameters at the top of the constructor. If the Bedrock `ModelId` dimension turns out not to
carry the `us.` inference-profile id, Task 16 records it and the fix is a follow-up; the alarm
stays harmless (it never breaches).

- [ ] **Step 5: Implement the budget and the topic grant**

In `infra/lib/control-plane.ts`, import `aws-budgets` as `budgets`, and `CfnCondition`, `Fn`,
`Aws` and `Token` from `aws-cdk-lib`. After `operatorAlerts`'s CloudWatch grant, add:

```ts
    // FR-047, environment naming only. AWS Budgets publishes the budget's notifications to the
    // same topic, so the topic policy must allow it (enforceSSL left only a Deny).
    if (naming.env !== undefined) {
      operatorAlerts.addToResourcePolicy(new iam.PolicyStatement({
        principals: [new iam.ServicePrincipal("budgets.amazonaws.com")],
        actions: ["sns:Publish"],
        resources: [operatorAlerts.topicArn],
        conditions: { StringEquals: { "aws:SourceAccount": this.account } },
      }));
      const monthlyUsd = new CfnParameter(this, "BudgetMonthlyUsd", {
        type: "String", default: "0", allowedPattern: "^[0-9]{1,7}$",
        description: "The environment's monthly AWS budget in US dollars; 0 means no budget",
      });
      const scope = new CfnParameter(this, "BudgetScope", {
        type: "String", default: "tag", allowedValues: ["tag", "account"],
        description: "tag: costs tagged agentx:env for this environment (the tag must be activated in Billing); account: the whole account",
      });
      const hasBudget = new CfnCondition(this, "HasBudget", { expression: Fn.conditionNot(Fn.conditionEquals(monthlyUsd.valueAsString, "0")) });
      const byTag = new CfnCondition(this, "BudgetByTag", { expression: Fn.conditionEquals(scope.valueAsString, "tag") });
      const notify = (type: "ACTUAL" | "FORECASTED", threshold: number) => ({
        notification: { notificationType: type, comparisonOperator: "GREATER_THAN", threshold, thresholdType: "PERCENTAGE" },
        subscribers: [{ subscriptionType: "SNS", address: operatorAlerts.topicArn }],
      });
      const budget = new budgets.CfnBudget(this, "MonthlyBudget", {
        budget: {
          budgetName: naming.alarmName("monthly"),
          budgetType: "COST",
          timeUnit: "MONTHLY",
          // CloudFormation passes the parameter's string; the Budgets resource accepts it as its number.
          budgetLimit: { amount: Token.asNumber(monthlyUsd.valueAsString), unit: "USD" },
          costFilters: Fn.conditionIf(byTag.logicalId, { TagKeyValue: [`user:agentx:env$${naming.env}`] }, Aws.NO_VALUE),
        },
        notificationsWithSubscribers: [notify("ACTUAL", 80), notify("FORECASTED", 100)],
      });
      budget.cfnOptions.condition = hasBudget;
    }
```

- [ ] **Step 6: Implement the parameters**

In `packages/cli/src/deploy/answer-schemas.ts`:

```ts
/** FR-047: the monthly budget init offers; absent means none. */
export const BudgetAnswersSchema = z.object({ monthlyUsd: z.number().int().min(1).max(1_000_000), scope: z.enum(["tag", "account"]) }).strict();
```

In `parameters.ts`, add to `InstallAnswers`:

```ts
  /** FR-047's budget; absent means none (the template's BudgetMonthlyUsd default, 0). */
  budget?: { monthlyUsd: number; scope: "tag" | "account" };
```

In the `control-plane` case, after `SlackAppPostedMessages`:

```ts
        ...(answers.budget === undefined ? {} : { BudgetMonthlyUsd: String(answers.budget.monthlyUsd), BudgetScope: answers.budget.scope }),
```

In the `slack` case, after `SlackSecretArn`:

```ts
        OperatorAlertsTopicArn: required(outputs, "control-plane", "OperatorAlertsTopicArn", answers.env),
```

In `commands.ts`, add `budget: BudgetAnswersSchema.optional(),` to `DeployAnswersSchema`, and to
the rebuild in `loadDeployAnswers`:

```ts
    ...(parsed.budget === undefined ? {} : { budget: parsed.budget }),
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run tests/contract/alert-alarms-infrastructure.test.ts tests/contract/turn-alarm-metrics.test.ts tests/contract/deploy-parameters.test.ts tests/contract/legacy-templates.test.ts tests/contract/turn-records-infrastructure.test.ts tests/contract/template-rendering.test.ts tests/contract/export-bundle.test.ts && npm run infra:synth`
Expected: PASS, and `legacy-templates.test.ts` unchanged. If `template-rendering.test.ts` or
`export-bundle.test.ts` lists every Slack stack parameter, add `OperatorAlertsTopicArn` (from the
control-plane output marker) to that list.

- [ ] **Step 8: Commit**

```bash
git add infra/lib/slack-orchestrator.ts infra/lib/control-plane.ts packages/slack-service/src/turn-records.ts packages/cli/src/deploy tests/contract/alert-alarms-infrastructure.test.ts tests/contract/turn-alarm-metrics.test.ts tests/contract/deploy-parameters.test.ts tests/support/init-fakes.ts
git commit -m "feat(infra): FR-045 alarms, a test alarm, and the FR-047 monthly budget for named environments"
```

### Task 4: The budget question and its plan line

**Files:**
- Modify: `packages/cli/src/init/install-state.ts` (`InitAnswersSchema.budget`)
- Modify: `packages/cli/src/init/answers.ts` (`InitFlags.budget`, `budgetScope`; the question; `RESUME_CHECKS`)
- Modify: `packages/cli/src/init/plan.ts` (the alerts and budget lines)
- Modify: `packages/cli/src/init/deploy-steps.ts` (`initDeployAnswers` passes `budget`)
- Modify: `packages/cli/src/main.ts` (`--budget <usd>`, `--budget-scope <scope>`)
- Test: `tests/contract/init-answers.test.ts`, `tests/contract/init-plan.test.ts`, `tests/contract/init-deploy-steps.test.ts`

**Interfaces:**
- Consumes: `BudgetAnswersSchema` (Task 3).
- Produces:
  - `InitAnswers.budget?: { monthlyUsd: number; scope: "tag" | "account" }`, absent for no budget.
  - `InitFlags.budget?: string` (`--budget`, whole US dollars, `0` for none) and `InitFlags.budgetScope?: "tag" | "account"`.
  - `export const BUDGET_TAG_NOTE: string` (answers.ts), shown in the plan and by the `alerts` step.
  - `initDeployAnswers(...)` returns `budget` when the answers have one.

- [ ] **Step 1: Write the failing tests**

Add to `tests/contract/init-answers.test.ts`, using that file's existing helper that runs
`collectInitAnswers` with flags and a scripted prompter (called `collect` below; use the file's
own name for it):

```ts
describe("the budget question (FR-047)", () => {
  it("defaults to $100 a month on the agentx:env tag, and says the tag must be activated", async () => {
    const result = await collect({ flags: { ...allOtherFlags }, script: ["", ""] });
    expect(result.answers.budget).toEqual({ monthlyUsd: 100, scope: "tag" });
    expect(result.notes).toContain(BUDGET_TAG_NOTE);
  });

  it("takes --budget 0 as no budget, asking nothing", async () => {
    const result = await collect({ flags: { ...allOtherFlags, budget: "0" }, script: [] });
    expect(result.answers.budget).toBeUndefined();
  });

  it("takes --budget 250 --budget-scope account without the tag note", async () => {
    const result = await collect({ flags: { ...allOtherFlags, budget: "250", budgetScope: "account" }, script: [] });
    expect(result.answers.budget).toEqual({ monthlyUsd: 250, scope: "account" });
    expect(result.notes).not.toContain(BUDGET_TAG_NOTE);
  });

  it("refuses a budget that is not a whole number of dollars", async () => {
    await expect(collect({ flags: { ...allOtherFlags, budget: "99.5" }, script: [] })).rejects.toThrow("--budget must be a whole number of US dollars, or 0 for no budget");
  });

  it("refuses a resume whose --budget differs from what the install started with", () => {
    expect(() => assertResumeFlagsMatch(sampleAnswers({ budget: { monthlyUsd: 100, scope: "tag" } }), { budget: "200" })).toThrow("--budget 200 differs from what this install started with (100)");
  });
});
```

`allOtherFlags` is the flag set that file already uses to answer every other question without a
prompt; if the file has none, build one there with `engine`, `identity`, the three models,
`alertEmail`, `githubAccount`, `githubAccountType`, `githubAppName`, `slackAppName` and
`slackAppPostedMessages`.

Add to `tests/contract/init-plan.test.ts`:

```ts
  it("names the budget and says alerts are subscribed during init", () => {
    const text = installPlanText(sampleAnswers({ budget: { monthlyUsd: 100, scope: "tag" } }), estimateMonthlyCost(sampleAnswers().models), []);
    expect(text).toContain("- Alerts: email to ops@example.com, subscribed and tested at the end of init");
    expect(text).toContain("- Budget agentx-staging-monthly: $100 a month for costs tagged agentx:env=staging, alerting at 80% spent and 100% forecast");
    expect(installPlanText(sampleAnswers(), estimateMonthlyCost(sampleAnswers().models), [])).toContain("- Budget: none");
  });
```

Add to `tests/contract/init-deploy-steps.test.ts`:

```ts
  it("passes the budget to the control plane's deploy answers", () => {
    const deploy = initDeployAnswers(sampleAnswers({ budget: { monthlyUsd: 100, scope: "account" } }), progressWithGitHub, ["control-plane"]);
    expect(deploy.budget).toEqual({ monthlyUsd: 100, scope: "account" });
  });
```

(`progressWithGitHub` is that file's progress fixture carrying `github.installationId`.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/contract/init-answers.test.ts tests/contract/init-plan.test.ts tests/contract/init-deploy-steps.test.ts`
Expected: FAIL: `budget` is not an answer, the plan still says "subscribed in a later AgentX release".

- [ ] **Step 3: Implement**

`install-state.ts`, in `InitAnswersSchema` after `alert`:

```ts
  budget: BudgetAnswersSchema.optional(),
```

`answers.ts`:

```ts
export const BUDGET_TAG_NOTE =
  "The budget counts costs tagged agentx:env. Someone with billing rights must activate that tag once in Billing, Cost allocation tags; it appears there up to 24 hours after the first tagged resource is billed. Until then the budget reads $0. For an account used only by AgentX, --budget-scope account needs no tag.";

// In InitFlags:
  /** --budget: whole US dollars a month; "0" for none. */
  budget?: string;
  budgetScope?: "tag" | "account";
```

In `collectInitAnswers`, after the alert block:

```ts
  const budgetFlag = "--budget (0 for none)";
  const rawBudget = flags.budget ?? (await prompter.ask("Monthly AWS budget for this environment, in US dollars (0 for none)", {
    flag: budgetFlag, defaultValue: "100",
    validate: (value) => (/^\d{1,7}$/.test(value) ? undefined : "must be a whole number of US dollars, or 0"),
  }));
  if (!/^\d{1,7}$/.test(rawBudget)) throw agentXError("CONFIG_INVALID", "--budget must be a whole number of US dollars, or 0 for no budget");
  let budget: InitAnswers["budget"];
  if (Number(rawBudget) > 0) {
    const scope = flags.budgetScope ?? (await prompter.choose<"tag" | "account">("Which costs should the budget count?", [
      { value: "tag", label: "Only this environment's (tagged agentx:env; the tag must be activated in Billing)" },
      { value: "account", label: "The whole account (for an account used only by AgentX)" },
    ], { flag: "--budget-scope", defaultValue: "tag" }));
    budget = { monthlyUsd: Number(rawBudget), scope };
    if (scope === "tag") notes.push(BUDGET_TAG_NOTE);
  }
```

and add `...(budget === undefined ? {} : { budget }),` to the `answers` object after `alert`.

Add to `RESUME_CHECKS`:

```ts
  { flag: "--budget", key: "budget", stored: (a) => String(a.budget?.monthlyUsd ?? 0) },
  { flag: "--budget-scope", key: "budgetScope", stored: (a) => a.budget?.scope },
```

`plan.ts`: replace the alerts line and add a budget line after it:

```ts
    `- Alerts: ${alerts}${answers.alert.kind === "none" ? "" : ", subscribed and tested at the end of init"}`,
    answers.budget === undefined
      ? "- Budget: none"
      : `- Budget agentx-${env}-monthly: ${money(answers.budget.monthlyUsd)} a month for ${answers.budget.scope === "tag" ? `costs tagged agentx:env=${env}` : "the whole account"}, alerting at 80% spent and 100% forecast`,
```

`money` already formats `$100`; if it prints cents (`$100.00`), use `$${answers.budget.monthlyUsd}`
and change the test string to match what is printed.

`deploy-steps.ts`, in `initDeployAnswers`'s return:

```ts
    ...(answers.budget === undefined ? {} : { budget: answers.budget }),
```

`main.ts`, on the `init` command after `--no-alerts`:

```ts
    .option("--budget <usd>", "monthly AWS budget in whole US dollars; 0 for none (default 100)")
    .addOption(new Option("--budget-scope <scope>", "tag: costs tagged agentx:env; account: the whole account").choices(["tag", "account"]))
```

and in `InitCommandOptions` (`budget?: string; budgetScope?: "tag" | "account";`) and
`initOptions`'s `flags` (`budget: options.budget, budgetScope: options.budgetScope,`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/contract/init-answers.test.ts tests/contract/init-plan.test.ts tests/contract/init-deploy-steps.test.ts tests/contract/init-cli.test.ts`
Expected: PASS. If an `init-cli.test.ts` run scripts every prompt in order, add `""` (take the $100
default) and `""` (take `tag`) after its alert answers.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/init packages/cli/src/main.ts tests/contract/init-answers.test.ts tests/contract/init-plan.test.ts tests/contract/init-deploy-steps.test.ts tests/contract/init-cli.test.ts
git commit -m "feat(init): ask for a monthly budget and show it in the plan"
```

### Task 5: The admin user and the admin session

**Files:**
- Create: `packages/cli/src/setup/services.ts`
- Create: `packages/cli/src/setup/admin-session.ts`
- Create: `packages/cli/src/setup/admin-user.ts`
- Create: `packages/cli/src/init/finish-steps.ts` (the `admin-user` step)
- Create: `tests/support/setup-fakes.ts`
- Modify: `packages/cli/src/init/context.ts` (`InitContext.setup: SetupServices`)
- Modify: `tests/support/init-fakes.ts` (`initContext` fills `setup` with `setupServices()`)
- Modify: `packages/cli/package.json` (`@aws-sdk/client-cognito-identity-provider` `3.1134.0`)
- Test: `tests/contract/setup-admin.test.ts`

**Interfaces:**
- Consumes: `loginWithPkce`, `tokenStoreKey`, `LoginOptions` (`auth.ts`); `TokenStore`, `StoredTokens`; `listCredentials` (`admin/credential.ts`); `EnvironmentSettings`, `readEnvironmentSettings`; `ProgressHandle`, `InitStep`.
- Produces:

```ts
// setup/services.ts
export interface AdminSession { controlPlaneUrl: string; accessToken: string }
export interface CognitoAdmin {
  /** The user's status (for example FORCE_CHANGE_PASSWORD, CONFIRMED), or undefined when absent. */
  userStatus(poolId: string, username: string): Promise<string | undefined>;
  /** AdminCreateUser with email and email_verified; Cognito emails a temporary password. */
  createUser(poolId: string, email: string): Promise<void>;
  addToGroup(poolId: string, username: string, group: string): Promise<void>;
}
export interface SetupServices {
  tokenStore: TokenStore;
  cognito: CognitoAdmin;
  login: (options: LoginOptions) => Promise<StoredTokens>;
  fetch: typeof fetch;
  // Tasks 6 to 12 each add one field here; see their Interfaces blocks.
}
export function cognitoAdmin(client: { send(command: unknown): Promise<unknown> }): CognitoAdmin;

// setup/admin-session.ts
export const ADMIN_GROUP = "agentx-admin";
export function userPoolId(settings: Pick<EnvironmentSettings, "identity">): string;
/** The admin claim values in an access token, without verifying it (the control plane verifies). */
export function tokenClaimValues(accessToken: string, claim: string): string[];
export async function openAdminSession(input: {
  settings: EnvironmentSettings; services: Pick<SetupServices, "tokenStore" | "login" | "fetch">;
  openBrowser?: (url: string) => Promise<unknown>; write: (line: string) => void; now: () => number;
  /** Your own OIDC: the claim and values that mark an administrator (FR-021). */
  adminClaim?: { claim: string; values: readonly string[] };
}): Promise<AdminSession>;

// setup/admin-user.ts
export async function ensureCognitoAdmin(input: { cognito: CognitoAdmin; poolId: string; email: string; write: (line: string) => void }): Promise<{ created: boolean }>;

// init/finish-steps.ts
export function adminUserStep(): InitStep<InitContext>;
// InitContext gains: setup: SetupServices; adminSession(): Promise<AdminSession>; flags: FinishFlags
export interface FinishFlags { adminEmail?: string; projectName?: string; repository?: string; setupCommand?: string; testCommand?: string; channel?: string; connectors?: string; linearKey?: SecretSource; jiraToken?: SecretSource; jiraSite?: string; jiraProject?: string; asanaClientId?: string; asanaClientSecret?: SecretSource; asanaBotEmail?: string; asanaProject?: string; linearTeam?: string }
```

`InitContext.adminSession` is built in `commands.ts` (Task 13). It is not memoized: each call reads
the token store and checks the admin route once, so a token that expired during a long run (an
Asana sign-in, a slow email confirmation) is replaced by a new sign-in. The `admin-user` step is
what first calls it.

- [ ] **Step 1: Write the shared fakes**

```ts
// tests/support/setup-fakes.ts
// Fakes for the setup modules (phase 15d2). Nothing here reaches AWS, a vendor or the control plane.
import type { StoredTokens, TokenStore } from "../../packages/cli/src/token-store.js";
import type { CognitoAdmin, SetupServices } from "../../packages/cli/src/setup/services.js";

export const CONTROL_PLANE = "https://cp.example.test";
export const ADMIN_EMAIL = "alice@example.com";

/** A JWT-shaped token (unsigned) with the given payload: the CLI only reads claims, never verifies. */
export function accessToken(payload: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part(payload)}.sig`;
}

export function memoryTokenStore(initial: Record<string, StoredTokens> = {}): TokenStore & { values: Map<string, StoredTokens> } {
  const values = new Map(Object.entries(initial));
  return {
    values,
    get: async (key) => values.get(key),
    set: async (key, tokens) => { values.set(key, tokens); },
    delete: async (key) => { values.delete(key); },
  };
}

export function fakeCognito(users: Record<string, string> = {}): CognitoAdmin & { created: string[]; grouped: string[] } {
  const status = new Map(Object.entries(users));
  const created: string[] = [];
  const grouped: string[] = [];
  return {
    created, grouped,
    userStatus: async (_pool, username) => status.get(username),
    createUser: async (_pool, email) => { created.push(email); status.set(email, "FORCE_CHANGE_PASSWORD"); },
    addToGroup: async (_pool, username, group) => { grouped.push(`${username}:${group}`); },
  };
}

export interface FakeControlPlane {
  fetch: typeof fetch;
  requests: Array<{ method: string; path: string; body?: unknown; token?: string }>;
  /** Answer GET /v1/admin/credentials with 403 for this token. */
  forbidden: Set<string>;
  credentials: Array<Record<string, unknown>>;
  registered: unknown[];
  /** The preflight each registration answers with, by connector name. */
  preflight: Record<string, { status: "connected" | "not_connected" | "unavailable"; problem?: string }>;
  bindings: string[];
  turns: unknown[];
}

/** Serves the admin routes the setup modules call, in memory. */
export function fakeControlPlane(): FakeControlPlane {
  const plane: FakeControlPlane = {
    requests: [], forbidden: new Set(), registered: [], preflight: {}, bindings: [], turns: [],
    credentials: [{ ref: "github-agentx-sdlc", type: "github-app", secretName: "agentx/staging/github-app", builtIn: true, tokenCached: false }],
    fetch: async (url, init) => {
      const parsed = new URL(String(url));
      const method = init?.method ?? "GET";
      const token = (init?.headers as Record<string, string> | undefined)?.authorization?.replace(/^Bearer /, "");
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
      plane.requests.push({ method, path: parsed.pathname, ...(body === undefined ? {} : { body }), ...(token === undefined ? {} : { token }) });
      const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
      if (token !== undefined && plane.forbidden.has(token)) return json(403, { error: { code: "FORBIDDEN", message: "administrator role required" } });
      if (parsed.pathname === "/v1/admin/credentials" && method === "GET") return json(200, { credentials: plane.credentials });
      if (parsed.pathname === "/v1/admin/credentials" && method === "POST") { plane.credentials.push(body as Record<string, unknown>); return json(200, { registered: true }); }
      if (parsed.pathname === "/v1/admin/projects" && method === "POST") {
        plane.registered.push(body);
        const definition = (body as { definition: { name: string; revision: number; integrations?: { connectors?: Array<{ name: string }> } } }).definition;
        const connectors = (definition.integrations?.connectors ?? []).map((connector) => ({ name: connector.name, offered: [], skipped: [], ...(plane.preflight[connector.name] ?? { status: "connected" }) }));
        return json(200, { name: definition.name, revision: definition.revision, preflight: { connectors } });
      }
      if (parsed.pathname.startsWith("/v1/admin/slack/bindings/") && method === "PUT") { plane.bindings.push(parsed.pathname.split("/").slice(-2).join("/")); return json(200, { bound: true }); }
      if (parsed.pathname === "/v1/admin/turns") return json(200, { turns: plane.turns });
      return json(404, { error: { code: "NOT_FOUND", message: `no route ${method} ${parsed.pathname}` } });
    },
  };
  return plane;
}

export function setupServices(overrides: Partial<SetupServices> = {}): SetupServices {
  const plane = fakeControlPlane();
  return {
    tokenStore: memoryTokenStore(),
    cognito: fakeCognito(),
    login: async () => ({ accessToken: accessToken({ "cognito:groups": ["agentx-admin"] }), expiresAt: Date.parse("2026-09-27T01:00:00.000Z") }),
    fetch: plane.fetch,
    ...overrides,
  } as SetupServices;
}
```

Later tasks add their own fakes to this file (`fakeRepositories`, `fakeSlackChannels`,
`fakeVendors`, `fakeAlerts`) and a default for each new `SetupServices` field in
`setupServices()`.

- [ ] **Step 2: Write the failing tests**

```ts
// tests/contract/setup-admin.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { tokenStoreKey } from "../../packages/cli/src/auth.js";
import { ensureCognitoAdmin } from "../../packages/cli/src/setup/admin-user.js";
import { openAdminSession, tokenClaimValues, userPoolId } from "../../packages/cli/src/setup/admin-session.js";
import { adminUserStep } from "../../packages/cli/src/init/finish-steps.js";
import type { EnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import { initContext, progressHandle, scriptedPrompter, T0, type TestInitContext } from "../support/init-fakes.js";
import { ADMIN_EMAIL, CONTROL_PLANE, accessToken, fakeCognito, fakeControlPlane, memoryTokenStore, setupServices } from "../support/setup-fakes.js";

const cognitoSettings = {
  schemaVersion: 1, env: "staging", account: "123456789012", region: "us-east-1", engine: "templates", version: "1.2.3", naming: "environment",
  stacks: { foundation: "agentx-staging-foundation", runtime: "agentx-staging-runtime", "control-plane": "agentx-staging-control-plane", slack: "agentx-staging-slack" },
  controlPlaneUrl: CONTROL_PLANE,
  identity: { mode: "cognito", issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_AbCdEf123", audience: "client123", clientId: "client123" },
  models: { orchestrator: "us.anthropic.claude-sonnet-4-6", classifier: "amazon.nova-lite-v1:0", worker: "amazon.nova-pro-v1:0" },
  updatedAt: "2026-09-27T00:00:00.000Z",
} as EnvironmentSettings;
const key = tokenStoreKey(cognitoSettings.identity);
const now = () => T0;

describe("the Cognito admin user (FR-018 step 7)", () => {
  it("creates the user, adds it to agentx-admin and says the temporary password comes by email", async () => {
    const cognito = fakeCognito();
    const lines: string[] = [];
    expect(await ensureCognitoAdmin({ cognito, poolId: "us-east-1_AbCdEf123", email: ADMIN_EMAIL, write: (line) => lines.push(line) })).toEqual({ created: true });
    expect(cognito.created).toEqual([ADMIN_EMAIL]);
    expect(cognito.grouped).toEqual([`${ADMIN_EMAIL}:agentx-admin`]);
    expect(lines.join("\n")).toContain(`Cognito emailed a temporary password to ${ADMIN_EMAIL}`);
  });

  it("never creates an existing user again, and still adds it to the group (Review Focus 1)", async () => {
    const cognito = fakeCognito({ [ADMIN_EMAIL]: "FORCE_CHANGE_PASSWORD" });
    const lines: string[] = [];
    expect(await ensureCognitoAdmin({ cognito, poolId: "p", email: ADMIN_EMAIL, write: (line) => lines.push(line) })).toEqual({ created: false });
    expect(cognito.created).toEqual([]);
    expect(cognito.grouped).toEqual([`${ADMIN_EMAIL}:agentx-admin`]);
    expect(lines.join("\n")).toContain("use the temporary password from the first email");
  });

  it("reads the pool id from the issuer", () => {
    expect(userPoolId(cognitoSettings)).toBe("us-east-1_AbCdEf123");
  });
});

describe("the admin session", () => {
  it("reuses a stored token that has not expired, after the admin route accepts it", async () => {
    const token = accessToken({ "cognito:groups": ["agentx-admin"] });
    const plane = fakeControlPlane();
    let logins = 0;
    const session = await openAdminSession({
      settings: cognitoSettings, now, write: () => undefined,
      services: { tokenStore: memoryTokenStore({ [key]: { accessToken: token, expiresAt: T0 + 3_600_000 } }), fetch: plane.fetch, login: async () => { logins += 1; throw new Error("not expected"); } },
    });
    expect(session).toEqual({ controlPlaneUrl: CONTROL_PLANE, accessToken: token });
    expect(logins).toBe(0);
    expect(plane.requests).toEqual([{ method: "GET", path: "/v1/admin/credentials", token }]);
  });

  it("signs in again when the stored token expired (Review Focus 2)", async () => {
    const fresh = accessToken({ "cognito:groups": ["agentx-admin"] });
    let logins = 0;
    const session = await openAdminSession({
      settings: cognitoSettings, now, write: () => undefined,
      services: { tokenStore: memoryTokenStore({ [key]: { accessToken: "old", expiresAt: T0 - 1 } }), fetch: fakeControlPlane().fetch, login: async () => { logins += 1; return { accessToken: fresh, expiresAt: T0 + 3_600_000 }; } },
    });
    expect(logins).toBe(1);
    expect(session.accessToken).toBe(fresh);
  });

  it("stops with what to do when the signed-in user is not an administrator (Review Focus 2)", async () => {
    const token = accessToken({ "cognito:groups": [] });
    const plane = fakeControlPlane();
    plane.forbidden.add(token);
    await expect(openAdminSession({
      settings: cognitoSettings, now, write: () => undefined,
      services: { tokenStore: memoryTokenStore(), fetch: plane.fetch, login: async () => ({ accessToken: token, expiresAt: T0 + 3_600_000 }) },
    })).rejects.toThrow("you signed in as someone who is not an AgentX administrator; sign out of the AgentX sign-in page in your browser, then run agentx init again and sign in as the admin user");
  });

  it("refuses your own OIDC provider's token without the admin claim, naming it (FR-021)", async () => {
    const token = accessToken({ groups: ["engineering"] });
    const oidc = { ...cognitoSettings, identity: { mode: "oidc", issuer: "https://login.example.com", audience: "agentx", clientId: "cli" } } as EnvironmentSettings;
    await expect(openAdminSession({
      settings: oidc, now, write: () => undefined, adminClaim: { claim: "groups", values: ["agentx-admins"] },
      services: { tokenStore: memoryTokenStore(), fetch: fakeControlPlane().fetch, login: async () => ({ accessToken: token, expiresAt: T0 + 3_600_000 }) },
    })).rejects.toThrow('your sign-in token\'s "groups" claim has none of agentx-admins (it has engineering); add yourself to one of them in your identity provider, then run agentx init again');
  });

  it("reads claim values from a string or a list, and from no claim at all", () => {
    expect(tokenClaimValues(accessToken({ groups: "a" }), "groups")).toEqual(["a"]);
    expect(tokenClaimValues(accessToken({ groups: ["a", "b"] }), "groups")).toEqual(["a", "b"]);
    expect(tokenClaimValues(accessToken({}), "groups")).toEqual([]);
    expect(tokenClaimValues("not-a-jwt", "groups")).toEqual([]);
  });
});

describe("the admin-user init step", () => {
  let context: TestInitContext | undefined;
  afterEach(async () => { if (context !== undefined) await rm(context.home, { recursive: true, force: true }); });

  it("creates the Cognito admin from the asked email, signs in, and records the admin", async () => {
    const cognito = fakeCognito();
    context = initContext({ prompter: scriptedPrompter([ADMIN_EMAIL]), setup: setupServices({ cognito }) });
    context.store.values.set("/agentx/staging/settings", JSON.stringify(cognitoSettings));
    const progress = progressHandle();
    expect(await adminUserStep().run(context, progress)).toEqual({ status: "done", note: `admin ${ADMIN_EMAIL}` });
    expect(cognito.created).toEqual([ADMIN_EMAIL]);
    expect(progress.value().admin).toEqual({ username: ADMIN_EMAIL, mode: "cognito" });
    expect(context.lines.join("\n")).toContain("A browser opens the AgentX sign-in page. Sign in as");
  });

  it("does not ask again on a rerun that already recorded the admin", async () => {
    const cognito = fakeCognito({ [ADMIN_EMAIL]: "CONFIRMED" });
    context = initContext({ prompter: scriptedPrompter([]), setup: setupServices({ cognito }) });
    context.store.values.set("/agentx/staging/settings", JSON.stringify(cognitoSettings));
    const progress = progressHandle({ ...progressHandle().value(), admin: { username: ADMIN_EMAIL, mode: "cognito" } });
    await adminUserStep().run(context, progress);
    expect(cognito.created).toEqual([]);
  });
});
```

`initContext` needs `setup` and `adminSession` defaults (Step 4); `adminSession` in the fake calls
the real `openAdminSession` with `context.setup`, so these tests exercise the whole path.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/contract/setup-admin.test.ts`
Expected: FAIL, "Cannot find module .../setup/admin-user.js".

- [ ] **Step 4: Implement**

```ts
// packages/cli/src/setup/services.ts
// Every AWS and vendor interface the setup modules (phase 15d2) use, injected so tests replace
// them all. init builds one SetupServices per run; the day-2 commands build one per command.
import { AdminAddUserToGroupCommand, AdminCreateUserCommand, AdminGetUserCommand } from "@aws-sdk/client-cognito-identity-provider";
import type { LoginOptions } from "../auth.js";
import type { StoredTokens, TokenStore } from "../token-store.js";

export interface AdminSession { controlPlaneUrl: string; accessToken: string }

export interface CognitoAdmin {
  userStatus(poolId: string, username: string): Promise<string | undefined>;
  createUser(poolId: string, email: string): Promise<void>;
  addToGroup(poolId: string, username: string, group: string): Promise<void>;
}

export interface SetupServices {
  tokenStore: TokenStore;
  cognito: CognitoAdmin;
  login: (options: LoginOptions) => Promise<StoredTokens>;
  fetch: typeof fetch;
}

const errorName = (error: unknown) => (error instanceof Error ? error.name : undefined);

export function cognitoAdmin(client: { send(command: unknown): Promise<unknown> }): CognitoAdmin {
  return {
    async userStatus(poolId, username) {
      try {
        return ((await client.send(new AdminGetUserCommand({ UserPoolId: poolId, Username: username }))) as { UserStatus?: string }).UserStatus ?? "UNKNOWN";
      } catch (error) {
        if (errorName(error) === "UserNotFoundException") return undefined;
        throw error;
      }
    },
    async createUser(poolId, email) {
      // No MessageAction: Cognito emails the temporary password, which is never seen by the CLI.
      await client.send(new AdminCreateUserCommand({
        UserPoolId: poolId, Username: email, DesiredDeliveryMediums: ["EMAIL"],
        UserAttributes: [{ Name: "email", Value: email }, { Name: "email_verified", Value: "true" }],
      }));
    },
    async addToGroup(poolId, username, group) {
      await client.send(new AdminAddUserToGroupCommand({ UserPoolId: poolId, Username: username, GroupName: group }));
    },
  };
}
```

```ts
// packages/cli/src/setup/admin-user.ts
// FR-018 step 7 for a Cognito identity: the admin user, created once. Cognito emails a temporary
// password; the first sign-in asks for a new one. Re-running never sends a second email.
import { ADMIN_GROUP } from "./admin-session.js";
import type { CognitoAdmin } from "./services.js";

export async function ensureCognitoAdmin(input: { cognito: CognitoAdmin; poolId: string; email: string; write: (line: string) => void }): Promise<{ created: boolean }> {
  const status = await input.cognito.userStatus(input.poolId, input.email);
  if (status === undefined) {
    await input.cognito.createUser(input.poolId, input.email);
    input.write(`Created the admin user ${input.email}. Cognito emailed a temporary password to ${input.email}; you set your own password at the first sign-in.`);
  } else if (status === "FORCE_CHANGE_PASSWORD") {
    input.write(`The admin user ${input.email} already exists and has not signed in yet: use the temporary password from the first email Cognito sent.`);
  }
  // Idempotent: adding a member again changes nothing.
  await input.cognito.addToGroup(input.poolId, input.email, ADMIN_GROUP);
  return { created: status === undefined };
}
```

```ts
// packages/cli/src/setup/admin-session.ts
// The admin's session with the control plane: a stored token when it is still good, otherwise a
// browser sign-in (PKCE on 127.0.0.1:8765). Either way the admin route must accept it, so a later
// step never fails on a bare 403. Your own OIDC provider's token must also carry the admin claim
// (FR-021); the control plane is what verifies it, this only explains a refusal.
import { agentXError } from "@agentx/contracts";
import { tokenStoreKey } from "../auth.js";
import { listCredentials } from "../admin/credential.js";
import type { EnvironmentSettings } from "../environments/settings.js";
import type { AdminSession, SetupServices } from "./services.js";

export const ADMIN_GROUP = "agentx-admin";
const EXPIRY_MARGIN_MS = 60_000;

export function userPoolId(settings: Pick<EnvironmentSettings, "identity">): string {
  const id = settings.identity.issuer.split("/").at(-1) ?? "";
  if (!/^[a-z]{2}(-[a-z]+)+-\d_[A-Za-z0-9]+$/.test(id)) {
    throw agentXError("CONFIG_INVALID", `the issuer ${settings.identity.issuer} does not end in a Cognito user pool id; check /agentx/<env>/settings`);
  }
  return id;
}

export function tokenClaimValues(accessToken: string, claim: string): string[] {
  const payload = accessToken.split(".")[1];
  if (payload === undefined) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return []; }
  const value = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>)[claim] : undefined;
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

export async function openAdminSession(input: {
  settings: EnvironmentSettings; services: Pick<SetupServices, "tokenStore" | "login" | "fetch">;
  openBrowser?: (url: string) => Promise<unknown>; write: (line: string) => void; now: () => number;
  adminClaim?: { claim: string; values: readonly string[] };
}): Promise<AdminSession> {
  const { settings, services } = input;
  const auth = { issuer: settings.identity.issuer, clientId: settings.identity.clientId, audience: settings.identity.audience };
  const stored = await services.tokenStore.get(tokenStoreKey(auth));
  let accessToken = stored !== undefined && stored.expiresAt - EXPIRY_MARGIN_MS > input.now() ? stored.accessToken : undefined;
  if (accessToken === undefined) {
    input.write("A browser opens the AgentX sign-in page. Sign in as the admin user; if no browser opens, open the address it prints.");
    const tokens = await services.login({
      ...auth, tokenStore: services.tokenStore, fetchImplementation: services.fetch, callbackPort: 8765,
      ...(input.openBrowser === undefined ? {} : { openBrowser: async (url: string) => { input.write(url); await input.openBrowser!(url); } }),
    });
    accessToken = tokens.accessToken;
  }
  if (input.adminClaim !== undefined) {
    const values = tokenClaimValues(accessToken, input.adminClaim.claim);
    if (!values.some((value) => input.adminClaim!.values.includes(value))) {
      throw agentXError("AUTH_REQUIRED", `your sign-in token's "${input.adminClaim.claim}" claim has none of ${input.adminClaim.values.join(", ")} (it has ${values.join(", ") || "no values"}); add yourself to one of them in your identity provider, then run agentx init again`);
    }
  }
  try {
    await listCredentials({ controlPlaneUrl: settings.controlPlaneUrl, accessToken }, services.fetch);
  } catch (error) {
    if (error instanceof Error && /FORBIDDEN|administrator|HTTP 403/.test(error.message)) {
      throw agentXError("AUTH_REQUIRED", "you signed in as someone who is not an AgentX administrator; sign out of the AgentX sign-in page in your browser, then run agentx init again and sign in as the admin user");
    }
    throw error;
  }
  return { controlPlaneUrl: settings.controlPlaneUrl, accessToken };
}
```

If `adminResponseBody` maps the 403 to a code other than one that matches the regular expression
above, match on the code instead (`error instanceof AgentXError && error.code === "<code>"`); read
`admin/http.ts` and the broker's 403 body to choose. The test's `forbidden` answer is what the
broker sends.

```ts
// packages/cli/src/init/finish-steps.ts
// The init steps after developer sign-in (phase 15d2): each is a thin wrapper around a setup/
// module, so agentx init and the day-2 commands behave the same.
import { agentXError } from "@agentx/contracts";
import { AlertEmailSchema } from "../deploy/answer-schemas.js";
import { readEnvironmentSettings, type EnvironmentSettings } from "../environments/settings.js";
import { userPoolId } from "../setup/admin-session.js";
import { ensureCognitoAdmin } from "../setup/admin-user.js";
import type { InitContext } from "./context.js";
import type { InitStep } from "./steps.js";

export async function requireSettings(context: InitContext): Promise<EnvironmentSettings> {
  const settings = await readEnvironmentSettings(context.store, context.env);
  if (settings === undefined) throw agentXError("CONFIG_INVALID", `environment ${context.env} has no settings yet; the Slack service step must finish first, so run agentx init again`);
  return settings;
}

export function adminUserStep(): InitStep<InitContext> {
  return {
    id: "admin-user",
    title: "Create the admin user and sign in",
    async run(context, progress) {
      const settings = await requireSettings(context);
      const recorded = progress.current().admin;
      if (settings.identity.mode === "cognito") {
        const email = recorded?.username ?? context.flags.adminEmail ?? await context.prompter.ask("Your email address, for your AgentX admin user", {
          flag: "--admin-email", validate: (value) => (AlertEmailSchema.safeParse(value).success ? undefined : "must be an email address"),
        });
        if (recorded === undefined) {
          await ensureCognitoAdmin({ cognito: context.setup.cognito, poolId: userPoolId(settings), email, write: context.write });
          await progress.update({ admin: { username: email, mode: "cognito" } });
        }
        await context.adminSession();
        return { status: "done", note: `admin ${email}` };
      }
      await context.adminSession();
      await progress.update({ admin: { username: "your OIDC provider's admin", mode: "oidc" } });
      return { status: "done", note: "admin signed in with your OIDC provider" };
    },
  };
}
```

In `context.ts`, add to `InitContext`:

```ts
  /** Phase 15d2's injected interfaces (setup/services.ts). */
  setup: SetupServices;
  /** The admin's control-plane session: the stored token when still good, else a new sign-in. */
  adminSession: () => Promise<AdminSession>;
  /** Phase 15d2's answers for the finishing steps, from flags (every one also has a prompt). */
  flags: FinishFlags;
```

and define `FinishFlags` there as in the Interfaces block (import `SecretSource` from
`./prompts.js`).

In `tests/support/init-fakes.ts`'s `initContext`, add defaults (read at call time):

```ts
    setup: setupServices(),
    flags: {},
    adminSession: async () => {
      const settings = await readEnvironmentSettings(context.store, context.env);
      if (settings === undefined) throw new Error("test setup: no settings");
      return openAdminSession({
        settings, services: context.setup, now: context.now, write: context.write,
        ...(settings.identity.mode === "oidc" && context.answers.identity.mode === "oidc"
          ? { adminClaim: { claim: context.answers.identity.adminClaim, values: context.answers.identity.adminValues } } : {}),
      });
    },
```

Add `"@aws-sdk/client-cognito-identity-provider": "3.1134.0"` to `packages/cli/package.json` and
run `npm install`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/contract/setup-admin.test.ts tests/contract/init-steps.test.ts tests/contract/init-signin-step.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/package.json package-lock.json packages/cli/src/setup packages/cli/src/init/finish-steps.ts packages/cli/src/init/context.ts tests/support tests/contract/setup-admin.test.ts
git commit -m "feat(setup): the admin user and a checked admin session (FR-018 step 7, FR-021)"
```

### Task 6: Reading the repository and proposing its commands

**Files:**
- Create: `packages/cli/src/setup/project-files.ts`
- Modify: `packages/cli/src/setup/services.ts` (`repositories`, `github`)
- Modify: `tests/support/setup-fakes.ts` (`fakeRepositories`; defaults in `setupServices`)
- Test: `tests/contract/setup-project-files.test.ts`

**Interfaces:**
- Consumes: `GitHubApi`, `githubAppJwt`, `githubAppSecretName` (`init/github-app.ts`); `InitSecrets` (`init/context.ts`); `ProjectCommand` (`@agentx/contracts`).
- Produces:

```ts
export interface RepositoryInfo { fullName: string; name: string; defaultBranch: string; cloneUrl: string }
export interface GitHubRepositoryApi {
  /** Every repository the installation can see (GET /installation/repositories, all pages). */
  list(token: string): Promise<RepositoryInfo[]>;
  /** A file's text at the default branch, or undefined when it does not exist. */
  file(token: string, fullName: string, path: string): Promise<string | undefined>;
}
export function githubRepositoryApi(fetchImplementation: typeof fetch): GitHubRepositoryApi;
export const BUILD_FILES: readonly string[];
export interface ProposedCommands { setup: ProjectCommand[]; readiness: ProjectCommand[]; basis: string[] }
export function proposeCommands(files: Readonly<Record<string, string | undefined>>, cwd: string): ProposedCommands;
export function parseCommandLine(line: string, cwd: string, timeoutSeconds: number): ProjectCommand;
export function commandLine(command: ProjectCommand): string;
export function agentxRepositoryName(githubName: string): string;
export async function installationToken(input: {
  env: string; secrets: Pick<InitSecrets, "get">; github: Pick<GitHubApi, "listInstallations" | "installationToken">;
  installationId?: string; nowSeconds: number;
}): Promise<string>;
// SetupServices gains: repositories: GitHubRepositoryApi; github: Pick<GitHubApi, "listInstallations" | "installationToken">
```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/contract/setup-project-files.test.ts
import { describe, expect, it } from "vitest";
import { agentxRepositoryName, commandLine, installationToken, parseCommandLine, proposeCommands } from "../../packages/cli/src/setup/project-files.js";
import { fakeGitHubApi, memoryInitSecrets, TEST_PRIVATE_KEY } from "../support/init-fakes.js";

const CWD = "repo/payments-api";
const lines = (proposed: ReturnType<typeof proposeCommands>) => ({ setup: proposed.setup.map(commandLine), readiness: proposed.readiness.map(commandLine) });

describe("proposing setup and test commands from the repository's files (FR-040)", () => {
  it("uses npm ci and npm test for a package-lock project with a test script", () => {
    const proposed = proposeCommands({ "package.json": JSON.stringify({ scripts: { test: "vitest run" } }), "package-lock.json": "{}" }, CWD);
    expect(lines(proposed)).toEqual({ setup: ["npm ci"], readiness: ["npm test"] });
    expect(proposed.setup[0]).toEqual({ cwd: CWD, executable: "npm", args: ["ci"], timeoutSeconds: 900 });
    expect(proposed.basis).toEqual(["package.json and package-lock.json: npm ci", "package.json's test script: npm test"]);
  });

  it("follows the lockfile: pnpm and yarn", () => {
    expect(lines(proposeCommands({ "package.json": JSON.stringify({ scripts: { test: "jest" } }), "pnpm-lock.yaml": "" }, CWD))).toEqual({ setup: ["pnpm install --frozen-lockfile"], readiness: ["pnpm test"] });
    expect(lines(proposeCommands({ "package.json": JSON.stringify({ scripts: { test: "jest" } }), "yarn.lock": "" }, CWD))).toEqual({ setup: ["yarn install --frozen-lockfile"], readiness: ["yarn test"] });
  });

  it("proposes no test command when package.json has none, or only npm's placeholder (Review Focus 5)", () => {
    expect(lines(proposeCommands({ "package.json": JSON.stringify({ name: "x" }), "package-lock.json": "{}" }, CWD)).readiness).toEqual([]);
    const placeholder = JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } });
    expect(lines(proposeCommands({ "package.json": placeholder }, CWD)).readiness).toEqual([]);
  });

  it("proposes nothing for a repository with no build files it knows (Review Focus 5)", () => {
    expect(proposeCommands({ "README.md": "# hi" }, CWD)).toEqual({ setup: [], readiness: [], basis: [] });
  });

  it("handles Python with uv, poetry and plain pip", () => {
    expect(lines(proposeCommands({ "pyproject.toml": "[tool.pytest.ini_options]", "uv.lock": "" }, CWD))).toEqual({ setup: ["uv sync"], readiness: ["uv run pytest"] });
    expect(lines(proposeCommands({ "pyproject.toml": "[tool.poetry]\npytest = \"^8\"", "poetry.lock": "" }, CWD))).toEqual({ setup: ["poetry install"], readiness: ["poetry run pytest"] });
    expect(lines(proposeCommands({ "pyproject.toml": "[project]\nname = \"x\"" }, CWD))).toEqual({ setup: ["python3 -m pip install -e ."], readiness: [] });
    expect(lines(proposeCommands({ "requirements.txt": "pytest\n" }, CWD))).toEqual({ setup: ["python3 -m pip install -r requirements.txt"], readiness: ["python3 -m pytest"] });
  });

  it("handles Go, Rust and a Makefile test target", () => {
    expect(lines(proposeCommands({ "go.mod": "module x" }, CWD))).toEqual({ setup: ["go mod download"], readiness: ["go test ./..."] });
    expect(lines(proposeCommands({ "Cargo.toml": "[package]" }, CWD))).toEqual({ setup: ["cargo fetch"], readiness: ["cargo test"] });
    expect(lines(proposeCommands({ Makefile: "build:\n\tgo build\ntest:\n\tgo test ./...\n" }, CWD))).toEqual({ setup: [], readiness: ["make test"] });
  });

  it("parses a typed command line with quotes, and refuses shell operators", () => {
    expect(parseCommandLine(`npm test -- --grep "login flow"`, CWD, 1800)).toEqual({ cwd: CWD, executable: "npm", args: ["test", "--", "--grep", "login flow"], timeoutSeconds: 1800 });
    expect(() => parseCommandLine("npm ci && npm test", CWD, 900)).toThrow("a command runs one program; put && , | and ; steps in a script or Makefile target and call that");
    expect(() => parseCommandLine("   ", CWD, 900)).toThrow("the command is empty");
  });

  it("turns a GitHub repository name into an AgentX name", () => {
    expect(agentxRepositoryName("Payments.API")).toBe("payments-api");
    expect(agentxRepositoryName("_x")).toBe("repo-x");
  });
});

describe("the installation token", () => {
  it("uses the recorded installation, reading the app key from its secret", async () => {
    const secrets = memoryInitSecrets({ "agentx/staging/github-app": JSON.stringify({ appId: "42", slug: "agentx-acme", account: "acme", privateKey: TEST_PRIVATE_KEY }) });
    const github = fakeGitHubApi({ installationId: 7 });
    expect(await installationToken({ env: "staging", secrets, github, installationId: "7", nowSeconds: 1_790_000_000 })).toMatch(/^ghs_/);
  });

  it("finds the only installation when none is recorded, and refuses when there are several", async () => {
    const secrets = memoryInitSecrets({ "agentx/staging/github-app": JSON.stringify({ appId: "42", slug: "s", account: "acme", privateKey: TEST_PRIVATE_KEY }) });
    await expect(installationToken({ env: "staging", secrets, github: { ...fakeGitHubApi(), listInstallations: async () => [{ id: 1, account: { login: "a" } }, { id: 2, account: { login: "b" } }] }, nowSeconds: 1 }))
      .rejects.toThrow("the GitHub App is installed on 2 accounts (a, b); AgentX uses one");
  });
});
```

If `fakeGitHubApi`'s installation token does not start with `ghs_`, match whatever the fake
returns.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/contract/setup-project-files.test.ts`
Expected: FAIL, "Cannot find module .../setup/project-files.js".

- [ ] **Step 3: Implement**

```ts
// packages/cli/src/setup/project-files.ts
// FR-040: what the GitHub App can see, and setup and test commands proposed from a repository's
// build files, for the engineer to confirm or edit. Nothing is guessed: a repository with no known
// build file gets no command, and the engineer types one or leaves it empty.
import { agentXError, type ProjectCommand } from "@agentx/contracts";
import type { InitSecrets } from "../init/context.js";
import { githubAppJwt, githubAppSecretName, type GitHubApi } from "../init/github-app.js";

export interface RepositoryInfo { fullName: string; name: string; defaultBranch: string; cloneUrl: string }
export interface GitHubRepositoryApi {
  list(token: string): Promise<RepositoryInfo[]>;
  file(token: string, fullName: string, path: string): Promise<string | undefined>;
}

const API = "https://api.github.com";
const SETUP_TIMEOUT = 900;
const TEST_TIMEOUT = 1800;
const NPM_PLACEHOLDER = /no test specified/;

export const BUILD_FILES: readonly string[] = [
  "package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
  "pyproject.toml", "uv.lock", "poetry.lock", "requirements.txt",
  "go.mod", "Cargo.toml", "Makefile",
];

export function githubRepositoryApi(fetchImplementation: typeof fetch): GitHubRepositoryApi {
  const headers = (token: string, accept = "application/vnd.github+json") => ({
    accept, authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28", "user-agent": "agentx-cli",
  });
  return {
    async list(token) {
      const all: RepositoryInfo[] = [];
      for (let page = 1; page <= 10; page += 1) {
        const response = await fetchImplementation(`${API}/installation/repositories?per_page=100&page=${page}`, { headers: headers(token) });
        if (!response.ok) throw agentXError("RUNTIME_UNAVAILABLE", `GitHub repository list failed with HTTP ${response.status}`);
        const body = (await response.json()) as { repositories: Array<{ full_name: string; name: string; default_branch: string; clone_url: string }> };
        all.push(...body.repositories.map((repo) => ({ fullName: repo.full_name, name: repo.name, defaultBranch: repo.default_branch, cloneUrl: repo.clone_url })));
        if (body.repositories.length < 100) break;
      }
      return all;
    },
    async file(token, fullName, path) {
      const response = await fetchImplementation(`${API}/repos/${fullName}/contents/${encodeURIComponent(path)}`, { headers: headers(token, "application/vnd.github.raw+json") });
      if (response.status === 404) return undefined;
      if (!response.ok) throw agentXError("RUNTIME_UNAVAILABLE", `GitHub could not read ${path} in ${fullName} (HTTP ${response.status})`);
      return response.text();
    },
  };
}

export function agentxRepositoryName(githubName: string): string {
  const cleaned = githubName.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);
  return /^[a-z]/.test(cleaned) ? cleaned : `repo-${cleaned}`.slice(0, 63);
}

export function parseCommandLine(line: string, cwd: string, timeoutSeconds: number): ProjectCommand {
  const words: string[] = [];
  let current = "";
  let quote: string | undefined;
  let started = false;
  for (const character of line.trim()) {
    if (quote !== undefined) {
      if (character === quote) quote = undefined; else current += character;
    } else if (character === '"' || character === "'") {
      quote = character; started = true;
    } else if (/\s/.test(character)) {
      if (started) { words.push(current); current = ""; started = false; }
    } else {
      current += character; started = true;
    }
  }
  if (quote !== undefined) throw agentXError("CONFIG_INVALID", "the command has an unclosed quote");
  if (started) words.push(current);
  if (words.length === 0) throw agentXError("CONFIG_INVALID", "the command is empty");
  if (words.some((word) => ["&&", "||", "|", ";"].includes(word))) {
    throw agentXError("CONFIG_INVALID", "a command runs one program; put && , | and ; steps in a script or Makefile target and call that");
  }
  const [executable, ...args] = words as [string, ...string[]];
  return { cwd, executable, args, timeoutSeconds };
}

export function commandLine(command: ProjectCommand): string {
  return [command.executable, ...command.args].map((word) => (/[\s"']/.test(word) ? JSON.stringify(word) : word)).join(" ");
}

export interface ProposedCommands { setup: ProjectCommand[]; readiness: ProjectCommand[]; basis: string[] }

export function proposeCommands(files: Readonly<Record<string, string | undefined>>, cwd: string): ProposedCommands {
  const has = (name: string) => files[name] !== undefined;
  const setup: ProjectCommand[] = [];
  const readiness: ProjectCommand[] = [];
  const basis: string[] = [];
  const add = (target: ProjectCommand[], line: string, why: string) => {
    target.push(parseCommandLine(line, cwd, target === setup ? SETUP_TIMEOUT : TEST_TIMEOUT));
    basis.push(`${why}: ${line}`);
  };
  if (has("package.json")) {
    const tool = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : "npm";
    const install = tool === "npm" ? (has("package-lock.json") ? "npm ci" : "npm install") : `${tool} install --frozen-lockfile`;
    const lock = tool === "pnpm" ? "pnpm-lock.yaml" : tool === "yarn" ? "yarn.lock" : has("package-lock.json") ? "package-lock.json" : undefined;
    add(setup, install, lock === undefined ? "package.json" : `package.json and ${lock}`);
    let test: unknown;
    try { test = (JSON.parse(files["package.json"]!) as { scripts?: { test?: unknown } }).scripts?.test; } catch { test = undefined; }
    if (typeof test === "string" && !NPM_PLACEHOLDER.test(test)) add(readiness, `${tool} test`, "package.json's test script");
  } else if (has("pyproject.toml")) {
    const pyproject = files["pyproject.toml"]!;
    const pytest = /pytest/.test(pyproject);
    if (has("uv.lock")) { add(setup, "uv sync", "pyproject.toml and uv.lock"); if (pytest) add(readiness, "uv run pytest", "pytest in pyproject.toml"); }
    else if (has("poetry.lock")) { add(setup, "poetry install", "pyproject.toml and poetry.lock"); if (pytest) add(readiness, "poetry run pytest", "pytest in pyproject.toml"); }
    else { add(setup, "python3 -m pip install -e .", "pyproject.toml"); if (pytest) add(readiness, "python3 -m pytest", "pytest in pyproject.toml"); }
  } else if (has("requirements.txt")) {
    add(setup, "python3 -m pip install -r requirements.txt", "requirements.txt");
    if (/^pytest\b/m.test(files["requirements.txt"]!)) add(readiness, "python3 -m pytest", "pytest in requirements.txt");
  } else if (has("go.mod")) {
    add(setup, "go mod download", "go.mod"); add(readiness, "go test ./...", "go.mod");
  } else if (has("Cargo.toml")) {
    add(setup, "cargo fetch", "Cargo.toml"); add(readiness, "cargo test", "Cargo.toml");
  }
  if (readiness.length === 0 && has("Makefile") && /^test:/m.test(files.Makefile!)) add(readiness, "make test", "the Makefile's test target");
  return { setup, readiness, basis };
}

export async function installationToken(input: {
  env: string; secrets: Pick<InitSecrets, "get">; github: Pick<GitHubApi, "listInstallations" | "installationToken">;
  installationId?: string; nowSeconds: number;
}): Promise<string> {
  const name = githubAppSecretName(input.env);
  const raw = await input.secrets.get(name);
  let app: { appId?: unknown; privateKey?: unknown } = {};
  try { app = raw === undefined ? {} : JSON.parse(raw) as typeof app; } catch { app = {}; }
  if (typeof app.appId !== "string" || typeof app.privateKey !== "string") {
    throw agentXError("CONFIG_INVALID", `secret ${name} does not hold the GitHub App's id and key; run agentx init again so the GitHub App step stores it`);
  }
  const jwt = githubAppJwt({ appId: app.appId, privateKey: app.privateKey, nowSeconds: input.nowSeconds });
  let installationId = input.installationId;
  if (installationId === undefined) {
    const installations = await input.github.listInstallations(jwt);
    if (installations.length !== 1) {
      throw agentXError("CONFIG_INVALID", installations.length === 0
        ? "the GitHub App is not installed anywhere; install it on your organization and choose repositories, then run this again"
        : `the GitHub App is installed on ${installations.length} accounts (${installations.map((entry) => entry.account.login).join(", ")}); AgentX uses one, so uninstall the others`);
    }
    installationId = String(installations[0]!.id);
  }
  return (await input.github.installationToken(jwt, installationId)).token;
}
```

The secret shape `{"appId","slug","account","privateKey"}` is 15d1's (Global Constraints of
15d1). If `InitSecrets` has no `get`, use `SecretValueStore.get`, which it extends.

In `services.ts`, add to `SetupServices`:

```ts
  /** Task 6: the repositories the GitHub App sees, and their build files. */
  repositories: GitHubRepositoryApi;
  /** Task 6: the installation token (15d1's GitHub API). */
  github: Pick<GitHubApi, "listInstallations" | "installationToken">;
```

In `setup-fakes.ts`:

```ts
export function fakeRepositories(repositories: Record<string, { defaultBranch?: string; files: Record<string, string> }>): GitHubRepositoryApi & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    list: async () => Object.keys(repositories).map((fullName) => ({
      fullName, name: fullName.split("/")[1]!, defaultBranch: repositories[fullName]!.defaultBranch ?? "main", cloneUrl: `https://github.com/${fullName}.git`,
    })),
    file: async (_token, fullName, path) => { reads.push(`${fullName}:${path}`); return repositories[fullName]?.files[path]; },
  };
}
```

and in `setupServices()`: `repositories: fakeRepositories({}), github: fakeGitHubApi(),` (import
`fakeGitHubApi` from `./init-fakes.js`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/contract/setup-project-files.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/setup tests/support/setup-fakes.ts tests/contract/setup-project-files.test.ts
git commit -m "feat(setup): list the app's repositories and propose setup and test commands (FR-040)"
```

### Task 7: `agentx project add` and the first-project step

**Files:**
- Create: `packages/cli/src/setup/project-add.ts`
- Create: `packages/cli/src/setup/cli.ts` (`registerSetupCommands`, with `project add`)
- Modify: `packages/cli/src/setup/services.ts` (`stackOutputs`, `configDir`)
- Modify: `packages/cli/src/init/finish-steps.ts` (`firstProjectStep`, project half)
- Modify: `packages/cli/src/main.ts` (call `registerSetupCommands`)
- Modify: `tests/support/setup-fakes.ts` (defaults)
- Test: `tests/contract/setup-project-add.test.ts`

**Interfaces:**
- Consumes: `registerProject`, `cliRuntimeBinding` (`admin/register.ts`); `listCredentials`; `loadProjectConfig` (`config.ts`); `installationToken`, `proposeCommands`, `parseCommandLine`, `commandLine`, `agentxRepositoryName`, `RepositoryInfo` (Task 6); `AdminSession` (Task 5); `StackOutputs`; `environmentStackName`.
- Produces:

```ts
export const DEFAULT_INSTRUCTIONS = "Delegate every repository read, edit, build, and test to the remote AgentX worker.";
export function ec2Binding(outputs: StackOutputs | undefined, stackName: string): Ec2RuntimeBinding;
export async function builtInGitHubRef(session: AdminSession, fetchImplementation: typeof fetch): Promise<string>;
export function projectFilePath(configDir: string, name: string): string;
export async function writeProjectFile(configDir: string, definition: ProjectDefinition): Promise<string>;
export async function addProject(input: {
  env: string; session: AdminSession; githubToken: string; prompter: Prompter; write: (line: string) => void;
  services: Pick<SetupServices, "fetch" | "repositories" | "stackOutputs" | "configDir">;
  flags: { projectName?: string; repository?: string; setupCommand?: string; testCommand?: string };
}): Promise<{ name: string; revision: number; file: string }>;
export async function registerRevision(input: {
  env: string; session: AdminSession; definition: ProjectDefinition;
  services: Pick<SetupServices, "fetch" | "stackOutputs" | "configDir">;
}): Promise<{ revision: number; preflight: ConnectorPreflight[]; warnings: string[]; file: string }>;
// SetupServices gains: stackOutputs(stackName): Promise<StackOutputs | undefined>; configDir: string
// finish-steps.ts: firstProjectStep(): InitStep<InitContext> (Task 8 adds the channel half)
```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/contract/setup-project-add.test.ts
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addProject, ec2Binding, registerRevision } from "../../packages/cli/src/setup/project-add.js";
import { scriptedPrompter } from "../support/init-fakes.js";
import { CONTROL_PLANE, fakeControlPlane, fakeRepositories } from "../support/setup-fakes.js";

const FOUNDATION = { Ec2WorkerLaunchTemplateId: "lt-0123456789abcdef0", Ec2WorkerSubnets: "us-east-1a=subnet-0aaa1111bbbb2222c,us-east-1b=subnet-0ddd3333eeee4444f" };
let configDir: string;
beforeEach(async () => { configDir = await mkdtemp(join(tmpdir(), "agentx-projects-")); });
afterEach(async () => { await rm(configDir, { recursive: true, force: true }); });

const services = (plane = fakeControlPlane(), repositories = fakeRepositories({
  "acme/payments-api": { files: { "package.json": JSON.stringify({ scripts: { test: "vitest run" } }), "package-lock.json": "{}" } },
  "acme/docs": { files: {} },
})) => ({ fetch: plane.fetch, repositories, configDir, stackOutputs: async (name: string) => (name === "agentx-staging-foundation" ? FOUNDATION : undefined) });
const session = { controlPlaneUrl: CONTROL_PLANE, accessToken: "admin-token" };

describe("the ec2-ebs binding from the foundation's outputs", () => {
  it("uses the launch template and every zone's subnet, 20 GiB gp3", () => {
    expect(ec2Binding(FOUNDATION, "agentx-staging-foundation")).toEqual({
      deploymentMode: "ec2-ebs", launchTemplateId: "lt-0123456789abcdef0",
      subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0aaa1111bbbb2222c" }, { availabilityZone: "us-east-1b", subnetId: "subnet-0ddd3333eeee4444f" }],
      volumeSizeGiB: 20, volumeType: "gp3",
    });
  });

  it("says which output is missing and what to do", () => {
    expect(() => ec2Binding({}, "agentx-staging-foundation")).toThrow("stack agentx-staging-foundation has no Ec2WorkerLaunchTemplateId output; upgrade the environment to a release with EC2 workers, then run this again");
  });
});

describe("agentx project add (FR-040)", () => {
  it("offers the repositories, proposes the commands, registers revision 1 on ec2-ebs and writes the file", async () => {
    const plane = fakeControlPlane();
    // repository, project name (default), use the proposed commands
    const prompter = scriptedPrompter(["acme/payments-api", "", true]);
    const lines: string[] = [];
    const result = await addProject({ env: "staging", session, githubToken: "ghs_x", prompter, write: (line) => lines.push(line), services: services(plane), flags: {} });
    expect(result).toEqual({ name: "payments-api", revision: 1, file: join(configDir, "payments-api.yaml") });
    const sent = plane.registered[0] as { definition: Record<string, unknown>; runtimeBinding: { deploymentMode: string } };
    expect(sent.runtimeBinding.deploymentMode).toBe("ec2-ebs");
    expect(sent.definition).toMatchObject({
      name: "payments-api", revision: 1,
      repositories: [{ name: "payments-api", url: "https://github.com/acme/payments-api.git", path: "repo/payments-api", defaultBranch: "main", credentialRef: "github-agentx-sdlc" }],
      setup: [{ executable: "npm", args: ["ci"] }], readiness: [{ executable: "npm", args: ["test"] }],
    });
    expect(lines.join("\n")).toContain("Proposed from package.json and package-lock.json: npm ci");
    const file = await readFile(result.file, "utf8");
    expect(file).toContain("name: payments-api");
    expect(file).not.toContain("admin-token");
  });

  it("takes every answer from flags, asking nothing", async () => {
    const plane = fakeControlPlane();
    const result = await addProject({
      env: "staging", session, githubToken: "ghs_x", prompter: scriptedPrompter([]), write: () => undefined, services: services(plane),
      flags: { repository: "acme/docs", projectName: "docs", setupCommand: "", testCommand: "make check" },
    });
    expect(result.name).toBe("docs");
    expect((plane.registered[0] as { definition: { setup: unknown[]; readiness: Array<{ executable: string }> } }).definition.setup).toEqual([]);
    expect((plane.registered[0] as { definition: { readiness: Array<{ executable: string; args: string[] }> } }).definition.readiness).toMatchObject([{ executable: "make", args: ["check"] }]);
  });

  it("lets the engineer type the commands when they do not accept the proposal", async () => {
    const plane = fakeControlPlane();
    const prompter = scriptedPrompter(["acme/payments-api", "", false, "npm install", "npm run test:unit"]);
    await addProject({ env: "staging", session, githubToken: "ghs_x", prompter, write: () => undefined, services: services(plane), flags: {} });
    expect((plane.registered[0] as { definition: { setup: Array<{ args: string[] }>; readiness: Array<{ args: string[] }> } }).definition).toMatchObject({ setup: [{ args: ["install"] }], readiness: [{ args: ["run", "test:unit"] }] });
  });

  it("refuses a repository the app cannot see, naming the ones it can", async () => {
    await expect(addProject({ env: "staging", session, githubToken: "ghs_x", prompter: scriptedPrompter([]), write: () => undefined, services: services(), flags: { repository: "acme/secret" } }))
      .rejects.toThrow("the GitHub App cannot see acme/secret; it sees acme/payments-api, acme/docs. Add the repository to the app's installation, or choose one of those");
  });

  it("registers a later revision from the file with the preflight's report", async () => {
    const plane = fakeControlPlane();
    const first = await addProject({ env: "staging", session, githubToken: "ghs_x", prompter: scriptedPrompter(["acme/payments-api", "", true]), write: () => undefined, services: services(plane), flags: {} });
    const definition = { ...(plane.registered[0] as { definition: Record<string, unknown> }).definition, revision: 2 } as never;
    const again = await registerRevision({ env: "staging", session, definition, services: services(plane) });
    expect(again.revision).toBe(2);
    expect(again.file).toBe(first.file);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/contract/setup-project-add.test.ts`
Expected: FAIL, "Cannot find module .../setup/project-add.js".

- [ ] **Step 3: Implement**

```ts
// packages/cli/src/setup/project-add.ts
// FR-040: agentx project add, and init's first-project step. Every new project runs on EC2 workers
// (ec2-ebs), bound with the foundation's launch template and subnets. The definition is also
// written to <config dir>/<name>.yaml, the file agentx admin project register --file takes, so
// connector add can build the next revision from it.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import {
  ProjectDefinitionSchema, RegistrationPreflightSchema, agentXError, environmentStackName,
  type ConnectorPreflight, type Ec2RuntimeBinding, type ProjectDefinition,
} from "@agentx/contracts";
import { listCredentials } from "../admin/credential.js";
import { cliRuntimeBinding, registerProject } from "../admin/register.js";
import type { StackOutputs } from "../deploy/parameters.js";
import type { Prompter } from "../init/prompts.js";
import { agentxRepositoryName, commandLine, parseCommandLine, proposeCommands, BUILD_FILES, type RepositoryInfo } from "./project-files.js";
import type { AdminSession, SetupServices } from "./services.js";

export const DEFAULT_INSTRUCTIONS = "Delegate every repository read, edit, build, and test to the remote AgentX worker.";

export function ec2Binding(outputs: StackOutputs | undefined, stackName: string): Ec2RuntimeBinding {
  for (const name of ["Ec2WorkerLaunchTemplateId", "Ec2WorkerSubnets"] as const) {
    if (outputs?.[name] === undefined) {
      throw agentXError("CONFIG_INVALID", `stack ${stackName} has no ${name} output; upgrade the environment to a release with EC2 workers, then run this again`);
    }
  }
  return cliRuntimeBinding("ec2-ebs", {
    launchTemplateId: outputs!.Ec2WorkerLaunchTemplateId!, subnets: outputs!.Ec2WorkerSubnets!, volumeSizeGib: "20", volumeType: "gp3",
  });
}

export async function builtInGitHubRef(session: AdminSession, fetchImplementation: typeof fetch): Promise<string> {
  const listed = (await listCredentials(session, fetchImplementation)) as { credentials?: Array<{ ref?: unknown; type?: unknown; builtIn?: unknown }> };
  const ref = listed.credentials?.find((entry) => entry.builtIn === true && entry.type === "github-app")?.ref;
  if (typeof ref !== "string") throw agentXError("RUNTIME_UNAVAILABLE", "the control plane lists no GitHub App credential; check the control-plane stack's GitHubAppId parameter");
  return ref;
}

export function projectFilePath(configDir: string, name: string): string {
  return join(configDir, `${name}.yaml`);
}

export async function writeProjectFile(configDir: string, definition: ProjectDefinition): Promise<string> {
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const path = projectFilePath(configDir, definition.name);
  const header = `# Registered by agentx. Edit, raise revision, then: agentx admin project register --file ${path}\n`;
  await writeFile(path, header + YAML.stringify(definition), { mode: 0o600 });
  return path;
}

export async function registerRevision(input: {
  env: string; session: AdminSession; definition: ProjectDefinition;
  services: Pick<SetupServices, "fetch" | "stackOutputs" | "configDir">;
}): Promise<{ revision: number; preflight: ConnectorPreflight[]; warnings: string[]; file: string }> {
  const foundation = environmentStackName(input.env, "foundation");
  const runtimeBinding = ec2Binding(await input.services.stackOutputs(foundation), foundation);
  const result = (await registerProject({ controlPlaneUrl: input.session.controlPlaneUrl, accessToken: input.session.accessToken, definition: input.definition, runtimeBinding }, input.services.fetch)) as Record<string, unknown>;
  const preflight = RegistrationPreflightSchema.safeParse(result.preflight);
  const warnings = Array.isArray(result.warnings) ? result.warnings.filter((entry): entry is string => typeof entry === "string") : [];
  const file = await writeProjectFile(input.services.configDir, input.definition);
  return { revision: input.definition.revision, preflight: preflight.success ? preflight.data.connectors : [], warnings, file };
}

async function chooseRepository(repositories: RepositoryInfo[], prompter: Prompter, flag: string | undefined): Promise<RepositoryInfo> {
  if (repositories.length === 0) throw agentXError("CONFIG_INVALID", "the GitHub App sees no repositories; choose at least one in the app's installation settings, then run this again");
  const wanted = flag ?? await prompter.choose<string>("Which repository is the first project's?", repositories.map((repo) => ({ value: repo.fullName, label: repo.fullName })), { flag: "--repository", defaultValue: repositories[0]!.fullName });
  const found = repositories.find((repo) => repo.fullName.toLowerCase() === wanted.toLowerCase());
  if (found === undefined) {
    throw agentXError("CONFIG_INVALID", `the GitHub App cannot see ${wanted}; it sees ${repositories.map((repo) => repo.fullName).join(", ")}. Add the repository to the app's installation, or choose one of those`);
  }
  return found;
}

export async function addProject(input: {
  env: string; session: AdminSession; githubToken: string; prompter: Prompter; write: (line: string) => void;
  services: Pick<SetupServices, "fetch" | "repositories" | "stackOutputs" | "configDir">;
  flags: { projectName?: string; repository?: string; setupCommand?: string; testCommand?: string };
}): Promise<{ name: string; revision: number; file: string }> {
  const { prompter, flags } = input;
  const repository = await chooseRepository(await input.services.repositories.list(input.githubToken), prompter, flags.repository);
  const repoName = agentxRepositoryName(repository.name);
  const name = flags.projectName ?? await prompter.ask("Project name", {
    flag: "--project-name", defaultValue: repoName, validate: (value) => (/^[a-z][a-z0-9-]{0,62}$/.test(value) ? undefined : "lowercase letters, digits and hyphens, starting with a letter"),
  });
  const cwd = `repo/${repoName}`;
  const files = Object.fromEntries(await Promise.all(BUILD_FILES.map(async (file) => [file, await input.services.repositories.file(input.githubToken, repository.fullName, file)] as const)));
  const proposed = proposeCommands(files, cwd);
  let setup = proposed.setup;
  let readiness = proposed.readiness;
  const typed = (line: string, timeout: number) => (line.trim() === "" ? [] : [parseCommandLine(line, cwd, timeout)]);
  if (flags.setupCommand !== undefined || flags.testCommand !== undefined) {
    if (flags.setupCommand !== undefined) setup = typed(flags.setupCommand, 900);
    if (flags.testCommand !== undefined) readiness = typed(flags.testCommand, 1800);
  } else {
    input.write(proposed.basis.length === 0
      ? `No build file AgentX knows in ${repository.fullName}, so no command is proposed.`
      : proposed.basis.map((line) => `Proposed from ${line}`).join("\n"));
    const summary = `setup: ${setup.map(commandLine).join("; ") || "none"}; test: ${readiness.map(commandLine).join("; ") || "none"}`;
    if (proposed.basis.length === 0 || !(await prompter.confirm(`Use these commands? (${summary})`, { defaultValue: true }))) {
      setup = typed(await prompter.ask("Setup command (empty for none)", { flag: "--setup-command", defaultValue: setup.map(commandLine)[0] ?? "" }), 900);
      readiness = typed(await prompter.ask("Test command (empty for none)", { flag: "--test-command", defaultValue: readiness.map(commandLine)[0] ?? "" }), 1800);
    }
  }
  const definition = ProjectDefinitionSchema.parse({
    name, revision: 1,
    repositories: [{ name: repoName, url: repository.cloneUrl, path: cwd, defaultBranch: repository.defaultBranch, credentialRef: await builtInGitHubRef(input.session, input.services.fetch) }],
    setup, readiness, orchestratorInstructions: DEFAULT_INSTRUCTIONS,
  });
  const registered = await registerRevision({ env: input.env, session: input.session, definition, services: input.services });
  input.write(`Registered project ${name}, revision 1, on EC2 workers. Its file is ${registered.file}.`);
  return { name, revision: 1, file: registered.file };
}
```

The empty-proposal case asks the two questions with an empty default; `scriptedPrompter`'s `""`
takes that default. A registration refused because revision 1 already exists (a rerun after the
file was lost) surfaces the control plane's message; that is correct, since the project exists.

In `services.ts`, add:

```ts
  /** Task 7: a stack's outputs (the foundation's EC2 worker outputs). */
  stackOutputs: (stackName: string) => Promise<StackOutputs | undefined>;
  /** Task 7: where project files live (the global --config-dir, default ~/.agentx/projects). */
  configDir: string;
```

In `setupServices()`, default `stackOutputs` to the foundation outputs used above and `configDir`
to `join(tmpdir(), "agentx-setup-unused")`; tests that write files pass their own.

In `finish-steps.ts`:

```ts
// Add to the imports: installationToken (../setup/project-files.js), addProject (../setup/project-add.js).
export function firstProjectStep(): InitStep<InitContext> {
  return {
    id: "first-project",
    title: "Set up the first project and its channel",
    async run(context, progress) {
      const session = await context.adminSession();
      let project = progress.current().project;
      if (project === undefined) {
        const githubToken = await installationToken({
          env: context.env, secrets: context.secrets, github: context.setup.github,
          ...(progress.current().github?.installationId === undefined ? {} : { installationId: progress.current().github!.installationId! }),
          nowSeconds: Math.floor(context.now() / 1000),
        });
        const added = await addProject({ env: context.env, session, githubToken, prompter: context.prompter, write: context.write, services: context.setup, flags: context.flags });
        project = { name: added.name, revision: added.revision };
        await progress.update({ project });
      }
      // Task 8 binds the channel here.
      return { status: "done", note: `project ${project.name}` };
    },
  };
}
```

`setup/cli.ts`:

```ts
// agentx project add, channel add, connector add and alerts test (phase 15d2): day-2 forms of
// init's finishing steps, built on the same setup/ modules.
import type { Command } from "commander";
import type { SetupCommandContext } from "./command-context.js";
import { addProject } from "./project-add.js";
import { installationToken } from "./project-files.js";

export function registerSetupCommands(program: Command, context: SetupCommandContext): void {
  program.command("project").description("AgentX projects")
    .command("add")
    .description("register a new project from a repository the GitHub App sees, on EC2 workers")
    .option("--repository <owner/name>", "the repository")
    .option("--project-name <name>", "the project's name (default: the repository's)")
    .option("--setup-command <command>", "the setup command, or \"\" for none")
    .option("--test-command <command>", "the test command, or \"\" for none")
    .action(async (options: { repository?: string; projectName?: string; setupCommand?: string; testCommand?: string }, command: Command) => {
      const run = await context.open(command);
      const githubToken = await installationToken({ env: run.env, secrets: run.secrets, github: run.services.github, nowSeconds: Math.floor(Date.now() / 1000) });
      const result = await addProject({ env: run.env, session: run.session, githubToken, prompter: run.prompter, write: run.write, services: run.services, flags: options });
      run.print(result, `Registered project ${result.name} (revision ${result.revision}); file ${result.file}\n`);
    });
}
```

and `setup/command-context.ts`:

```ts
// What every setup day-2 command needs: the environment's settings from SSM (FR-004), an admin
// session (the same check init uses), the secrets store, prompts, and the injected services.
import type { Command } from "commander";
import type { InitSecrets } from "../init/context.js";
import type { Prompter } from "../init/prompts.js";
import type { EnvironmentSettings } from "../environments/settings.js";
import type { AdminSession, SetupServices } from "./services.js";

export interface SetupRun {
  env: string; settings: EnvironmentSettings; session: AdminSession; secrets: InitSecrets;
  services: SetupServices; prompter: Prompter; write: (line: string) => void;
  print: (result: unknown, text: string) => void;
}
export interface SetupCommandContext { open(command: Command): Promise<SetupRun> }
```

In `main.ts`, build a `SetupCommandContext` whose `open`:
1. reads `globals` (`--env`, `--json`, `--config-dir`) and an optional `--region` (default: the
   AWS configuration's), builds `ssmParameterStore` for that region and reads the settings; missing
   settings fail with "environment <env> has no settings in <region>; pass --region, or run agentx
   env list";
2. builds `SetupServices` with real clients in `settings.region` (the real constructors are listed
   in Task 13, Step 3), `tokenStore: services.tokenStore`, `configDir: globals.configDir`;
3. opens the session with `openAdminSession` (`adminClaim` from `settings.identity` is not stored
   in settings, so day-2 commands rely on the admin route's check alone);
4. uses `processPrompter(stderr)` on a terminal, else `unattendedPrompter()`.

Tests override it through a new `CliDependencies.setup?: SetupCommandContext`. Register with
`registerSetupCommands(program, dependencies.setup ?? realSetupContext(...))` after the `admin`
commands.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/contract/setup-project-add.test.ts tests/contract/cli-main.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/setup packages/cli/src/init/finish-steps.ts packages/cli/src/main.ts tests/support/setup-fakes.ts tests/contract/setup-project-add.test.ts
git commit -m "feat(setup): agentx project add on ec2-ebs, and init's first-project step (FR-040)"
```

### Task 8: `agentx channel add` and watching for the threaded reply

**Files:**
- Create: `packages/cli/src/setup/channel-add.ts`
- Create: `packages/cli/src/setup/reply-watch.ts`
- Modify: `packages/cli/src/setup/services.ts` (`slackChannels`)
- Modify: `packages/cli/src/setup/cli.ts` (`channel add`)
- Modify: `packages/cli/src/init/finish-steps.ts` (`firstProjectStep`'s channel half)
- Modify: `tests/support/setup-fakes.ts` (`fakeSlackChannels`, `turn`)
- Test: `tests/contract/setup-channel.test.ts`

**Interfaces:**
- Consumes: `bindSlackChannel` (`admin/slack.ts`); `exportTurns` (`admin/turns.ts`); `slackSecretName` (`init/slack-app.ts`); `AdminSession`; `InstallProgress.slack` (`teamId`, `botUserId`).
- Produces:

```ts
// channel-add.ts
export interface SlackChannel { id: string; name: string; isPrivate: boolean; isMember: boolean }
export interface SlackChannelApi {
  /** conversations.list, public and private, not archived, every page; private ones only when the bot is in them. */
  find(token: string, name: string): Promise<SlackChannel | undefined>;
  /** conversations.join, for a public channel. */
  join(token: string, channelId: string): Promise<void>;
}
export function slackChannelApi(fetchImplementation: typeof fetch): SlackChannelApi;
export function channelName(typed: string): string;
export async function readBotToken(secrets: Pick<InitSecrets, "get">, env: string): Promise<string>;
export async function addChannel(input: {
  session: AdminSession; botToken: string; teamId: string; botUserId: string; projectName: string;
  prompter: Prompter; write: (line: string) => void; sleep: (ms: number) => Promise<void>; now: () => number;
  services: Pick<SetupServices, "fetch" | "slackChannels">; flags: { channel?: string };
}): Promise<{ channelId: string; channelName: string }>;
// reply-watch.ts
export const REPLY_WAIT_MS = 10 * 60_000;
export async function waitForThreadedReply(input: {
  session: AdminSession; fetch: typeof fetch; teamId: string; channelId: string; channelName: string; botUserId: string;
  write: (line: string) => void; sleep: (ms: number) => Promise<void>; now: () => number; timeoutMs?: number;
}): Promise<{ eventId: string; seconds: number }>;
// SetupServices gains: slackChannels: SlackChannelApi; slackIdentity(botToken): Promise<{ teamId: string; botUserId: string }>
// SetupRun (setup/command-context.ts) gains: sleep, now
```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/contract/setup-channel.test.ts
import { describe, expect, it } from "vitest";
import { addChannel, channelName } from "../../packages/cli/src/setup/channel-add.js";
import { waitForThreadedReply } from "../../packages/cli/src/setup/reply-watch.js";
import { scriptedPrompter, T0 } from "../support/init-fakes.js";
import { CONTROL_PLANE, fakeControlPlane, fakeSlackChannels, turn } from "../support/setup-fakes.js";

const session = { controlPlaneUrl: CONTROL_PLANE, accessToken: "admin-token" };
const TEAM = "T0123456789";
const BOT = "U0BOT00001";
function clock() { let now = T0; return { now: () => now, sleep: async (ms: number) => { now += ms; } }; }

describe("finding the channel (Review Focus 3)", () => {
  it("drops a leading # and capitals", () => {
    expect(channelName("#Payments")).toBe("payments");
    expect(channelName("  ops-alerts ")).toBe("ops-alerts");
  });
});

describe("agentx channel add (FR-041)", () => {
  it("joins a public channel the bot is not in, then binds it to the project", async () => {
    const plane = fakeControlPlane();
    const slack = fakeSlackChannels([{ id: "C0PAY00001", name: "payments", isPrivate: false, isMember: false }]);
    const result = await addChannel({ session, botToken: "xoxb-1", teamId: TEAM, botUserId: BOT, projectName: "payments-api", prompter: scriptedPrompter(["#Payments"]), write: () => undefined, ...clock(), services: { fetch: plane.fetch, slackChannels: slack }, flags: {} });
    expect(result).toEqual({ channelId: "C0PAY00001", channelName: "payments" });
    expect(slack.joined).toEqual(["C0PAY00001"]);
    expect(plane.bindings).toEqual([`${TEAM}/C0PAY00001`]);
    expect(plane.requests.find((r) => r.method === "PUT")?.body).toEqual({ projectName: "payments-api" });
  });

  it("asks for an invite to a private channel, and waits until the bot can see it", async () => {
    const plane = fakeControlPlane();
    const slack = fakeSlackChannels([{ id: "G0SEC00001", name: "secret", isPrivate: true, isMember: true }], { visibleAfterFinds: 3 });
    const lines: string[] = [];
    const result = await addChannel({ session, botToken: "xoxb-1", teamId: TEAM, botUserId: BOT, projectName: "p", prompter: scriptedPrompter([]), write: (line) => lines.push(line), ...clock(), services: { fetch: plane.fetch, slackChannels: slack }, flags: { channel: "secret" } });
    expect(result.channelId).toBe("G0SEC00001");
    expect(lines.join("\n")).toContain(`If #secret is private, type /invite <@${BOT}> in it`);
    expect(slack.joined).toEqual([]);
  });

  it("gives up after 10 minutes, saying how to create the channel", async () => {
    const slack = fakeSlackChannels([]);
    await expect(addChannel({ session, botToken: "xoxb-1", teamId: TEAM, botUserId: BOT, projectName: "p", prompter: scriptedPrompter([]), write: () => undefined, ...clock(), services: { fetch: fakeControlPlane().fetch, slackChannels: slack }, flags: { channel: "nope" } }))
      .rejects.toThrow("the bot cannot see a channel named #nope after 10 minutes; create it in Slack (or invite the bot to it, if it is private), then run this again");
  });
});

describe("waiting for the threaded reply (FR-018 step 11)", () => {
  it("passes on an answered turn in that channel received after the prompt", async () => {
    const plane = fakeControlPlane();
    const time = clock();
    const lines: string[] = [];
    const pending = waitForThreadedReply({ session, fetch: plane.fetch, teamId: TEAM, channelId: "C0PAY00001", channelName: "payments", botUserId: BOT, write: (line) => lines.push(line), ...time,
      sleep: async (ms) => { await time.sleep(ms); plane.turns = [turn({ subject: `${TEAM}/C0PAY00001/1790000000.000100`, receivedAt: new Date(time.now()).toISOString(), disposition: "answered" })]; } });
    expect((await pending).eventId).toMatch(/^Ev/);
    expect(lines[0]).toBe(`In #payments, post a message that mentions <@${BOT}>, for example "<@${BOT}> what can you do?". Waiting up to 10 minutes for AgentX to reply in its thread.`);
  });

  it("ignores turns in other channels and turns from before the prompt", async () => {
    const plane = fakeControlPlane();
    plane.turns = [
      turn({ subject: `${TEAM}/C0OTHER001/1.1`, receivedAt: new Date(T0 + 1000).toISOString(), disposition: "answered" }),
      turn({ subject: `${TEAM}/C0PAY00001/1.1`, receivedAt: new Date(T0 - 60_000).toISOString(), disposition: "answered" }),
    ];
    await expect(waitForThreadedReply({ session, fetch: plane.fetch, teamId: TEAM, channelId: "C0PAY00001", channelName: "payments", botUserId: BOT, write: () => undefined, ...clock(), timeoutMs: 60_000 }))
      .rejects.toThrow("no AgentX reply in #payments within 1 minutes");
  });

  it("does not pass on an error reply, naming the turn's disposition (Review Focus 4)", async () => {
    const plane = fakeControlPlane();
    plane.turns = [turn({ subject: `${TEAM}/C0PAY00001/1.1`, receivedAt: new Date(T0 + 1000).toISOString(), disposition: "failed", error: { name: "WorkerUnavailable" } })];
    await expect(waitForThreadedReply({ session, fetch: plane.fetch, teamId: TEAM, channelId: "C0PAY00001", channelName: "payments", botUserId: BOT, write: () => undefined, ...clock() }))
      .rejects.toThrow("AgentX replied in #payments, but the turn ended as failed (WorkerUnavailable); see agentx admin turns export --since 15m, fix it, then run agentx init again");
  });
});
```

`turn` in `setup-fakes.ts`:

```ts
export function turn(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    eventId: `Ev${Math.random().toString(36).slice(2, 10).toUpperCase()}`, subject: "T0123456789/C0PAY00001/1.1", receivedAt: "2026-09-27T00:00:01.000Z",
    requestedBy: { teamId: "T0123456789", userId: "U0HUMAN001" }, disposition: "answered", startedAt: "2026-09-27T00:00:01.000Z", finishedAt: "2026-09-27T00:00:09.000Z",
    durationMs: 8000, requestText: "hello", responseText: "hi", offeredTools: [], calls: [], emptyResponse: false, workerOperations: [], ...overrides,
  };
}

export function fakeSlackChannels(channels: Array<{ id: string; name: string; isPrivate: boolean; isMember: boolean }>, options: { visibleAfterFinds?: number } = {}): import("../../packages/cli/src/setup/channel-add.js").SlackChannelApi & { joined: string[]; finds: () => number } {
  const joined: string[] = [];
  let finds = 0;
  return {
    joined, finds: () => finds,
    async find(_token, name) {
      finds += 1;
      if (options.visibleAfterFinds !== undefined && finds < options.visibleAfterFinds) return undefined;
      return channels.find((channel) => channel.name === name);
    },
    async join(_token, channelId) { joined.push(channelId); },
  };
}
```

and `slackChannels: fakeSlackChannels([])` in `setupServices()`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/contract/setup-channel.test.ts`
Expected: FAIL, "Cannot find module .../setup/channel-add.js".

- [ ] **Step 3: Implement**

```ts
// packages/cli/src/setup/channel-add.ts
// FR-041: bind a Slack channel to a project. A public channel is joined; a private one needs a
// person to invite the bot (a bot cannot join a private channel), so the CLI waits for that.
import { agentXError } from "@agentx/contracts";
import { bindSlackChannel } from "../admin/slack.js";
import type { InitSecrets } from "../init/context.js";
import type { Prompter } from "../init/prompts.js";
import { slackSecretName } from "../init/slack-app.js";
import type { AdminSession, SetupServices } from "./services.js";

export interface SlackChannel { id: string; name: string; isPrivate: boolean; isMember: boolean }
export interface SlackChannelApi {
  find(token: string, name: string): Promise<SlackChannel | undefined>;
  join(token: string, channelId: string): Promise<void>;
}

const FIND_WAIT_MS = 10 * 60_000;
const FIND_POLL_MS = 10_000;

export function slackChannelApi(fetchImplementation: typeof fetch): SlackChannelApi {
  const call = async (method: string, token: string, params: Record<string, string>): Promise<Record<string, unknown>> => {
    const response = await fetchImplementation(`https://slack.com/api/${method}?${new URLSearchParams(params).toString()}`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) throw agentXError("RUNTIME_UNAVAILABLE", `Slack ${method} failed with HTTP ${response.status}; try again in a minute`);
    const body = (await response.json()) as Record<string, unknown>;
    if (body.ok !== true) {
      const code = typeof body.error === "string" && /^[a-z_]{1,64}$/.test(body.error) ? body.error : "unknown_error";
      throw agentXError(code === "missing_scope" ? "CONFIG_INVALID" : "RUNTIME_UNAVAILABLE", `Slack ${method} refused: ${code}${code === "missing_scope" ? "; reinstall the Slack app from its manifest so it has channels:read, groups:read and channels:join" : ""}`);
    }
    return body;
  };
  return {
    async find(token, name) {
      let cursor = "";
      for (let page = 0; page < 50; page += 1) {
        const body = await call("conversations.list", token, { types: "public_channel,private_channel", exclude_archived: "true", limit: "1000", ...(cursor === "" ? {} : { cursor }) });
        const channels = (body.channels ?? []) as Array<{ id: string; name: string; is_private?: boolean; is_member?: boolean }>;
        const match = channels.find((channel) => channel.name === name);
        if (match !== undefined) return { id: match.id, name: match.name, isPrivate: match.is_private === true, isMember: match.is_member === true };
        cursor = ((body.response_metadata as { next_cursor?: string } | undefined)?.next_cursor) ?? "";
        if (cursor === "") return undefined;
      }
      return undefined;
    },
    async join(token, channelId) {
      await call("conversations.join", token, { channel: channelId });
    },
  };
}

export function channelName(typed: string): string {
  return typed.trim().replace(/^#/, "").toLowerCase();
}

export async function readBotToken(secrets: Pick<InitSecrets, "get">, env: string): Promise<string> {
  const raw = await secrets.get(slackSecretName(env));
  let token: unknown;
  try { token = raw === undefined ? undefined : (JSON.parse(raw) as { botToken?: unknown }).botToken; } catch { token = undefined; }
  if (typeof token !== "string" || !token.startsWith("xoxb-")) {
    throw agentXError("CONFIG_INVALID", `secret ${slackSecretName(env)} holds no Slack bot token; run agentx init again so the Slack app step stores it`);
  }
  return token;
}

export async function addChannel(input: {
  session: AdminSession; botToken: string; teamId: string; botUserId: string; projectName: string;
  prompter: Prompter; write: (line: string) => void; sleep: (ms: number) => Promise<void>; now: () => number;
  services: Pick<SetupServices, "fetch" | "slackChannels">; flags: { channel?: string };
}): Promise<{ channelId: string; channelName: string }> {
  const name = channelName(input.flags.channel ?? await input.prompter.ask("Which Slack channel should the project use?", {
    flag: "--channel", validate: (value) => (/^#?[a-z0-9][a-z0-9_-]{0,79}$/i.test(value.trim()) ? undefined : "a channel name, such as payments"),
  }));
  const deadline = input.now() + FIND_WAIT_MS;
  let channel = await input.services.slackChannels.find(input.botToken, name);
  if (channel === undefined) {
    input.write(`The bot cannot see #${name} yet. If #${name} is private, type /invite <@${input.botUserId}> in it; if it does not exist, create it. Waiting up to 10 minutes.`);
    while (channel === undefined) {
      if (input.now() >= deadline) {
        throw agentXError("CONFIG_INVALID", `the bot cannot see a channel named #${name} after 10 minutes; create it in Slack (or invite the bot to it, if it is private), then run this again`);
      }
      await input.sleep(FIND_POLL_MS);
      channel = await input.services.slackChannels.find(input.botToken, name);
    }
  }
  if (!channel.isMember) {
    // Only a public channel can be listed while the bot is not in it.
    await input.services.slackChannels.join(input.botToken, channel.id);
    input.write(`The bot joined #${name}.`);
  }
  await bindSlackChannel({ controlPlaneUrl: input.session.controlPlaneUrl, accessToken: input.session.accessToken, teamId: input.teamId, channelId: channel.id, projectName: input.projectName }, input.services.fetch);
  input.write(`Bound #${name} to project ${input.projectName}.`);
  return { channelId: channel.id, channelName: name };
}
```

The private-channel message in the test reads "If #secret is private, type /invite
<@U0BOT00001> in it"; keep the implementation's wording and the test's in step.

```ts
// packages/cli/src/setup/reply-watch.ts
// FR-018 step 11 and FR-041's check: a person mentions the bot (the ingress never answers a bot,
// so the CLI cannot post the test itself), and the CLI watches turn records for an answered turn
// in that channel. No Slack history scope is needed.
import { agentXError } from "@agentx/contracts";
import { exportTurns } from "../admin/turns.js";
import type { AdminSession } from "./services.js";

export const REPLY_WAIT_MS = 10 * 60_000;
const POLL_MS = 15_000;
/** Turns received a little before the prompt still count: the person may type fast. */
const EARLY_MS = 5_000;

interface WatchedTurn { eventId: string; subject: string; receivedAt: string; disposition: string; durationMs: number; error?: { name: string } }

export async function waitForThreadedReply(input: {
  session: AdminSession; fetch: typeof fetch; teamId: string; channelId: string; channelName: string; botUserId: string;
  write: (line: string) => void; sleep: (ms: number) => Promise<void>; now: () => number; timeoutMs?: number;
}): Promise<{ eventId: string; seconds: number }> {
  const timeout = input.timeoutMs ?? REPLY_WAIT_MS;
  const started = input.now();
  const since = new Date(started - EARLY_MS).toISOString();
  const prefix = `${input.teamId}/${input.channelId}/`;
  input.write(`In #${input.channelName}, post a message that mentions <@${input.botUserId}>, for example "<@${input.botUserId}> what can you do?". Waiting up to ${Math.round(timeout / 60_000)} minutes for AgentX to reply in its thread.`);
  for (;;) {
    const turns: WatchedTurn[] = [];
    await exportTurns({ ...input.session, since, write: (line) => { turns.push(JSON.parse(line) as WatchedTurn); } }, input.fetch);
    const mine = turns.filter((entry) => entry.subject.startsWith(prefix) && Date.parse(entry.receivedAt) >= started - EARLY_MS);
    const answered = mine.find((entry) => entry.disposition === "answered");
    if (answered !== undefined) {
      input.write(`AgentX replied in #${input.channelName} in ${Math.round(answered.durationMs / 1000)} seconds.`);
      return { eventId: answered.eventId, seconds: Math.round(answered.durationMs / 1000) };
    }
    const other = mine[0];
    if (other !== undefined) {
      throw agentXError("RUNTIME_UNAVAILABLE", `AgentX replied in #${input.channelName}, but the turn ended as ${other.disposition}${other.error === undefined ? "" : ` (${other.error.name})`}; see agentx admin turns export --since 15m, fix it, then run agentx init again`);
    }
    if (input.now() - started >= timeout) {
      throw agentXError("RUNTIME_UNAVAILABLE", `no AgentX reply in #${input.channelName} within ${Math.round(timeout / 60_000)} minutes; check that the message mentioned the bot, that Slack shows the Request URL as Verified, and agentx admin turns export --since 15m, then run agentx init again`);
    }
    await input.sleep(POLL_MS);
  }
}
```

In `services.ts`, add `slackChannels: SlackChannelApi;` ("Task 8").

In `finish-steps.ts`, replace the "Task 8 binds the channel here." comment in `firstProjectStep`:

```ts
      if (project.channelId === undefined) {
        const slack = progress.current().slack;
        if (slack === undefined) throw agentXError("CONFIG_INVALID", "install progress has no Slack app facts; the Slack app step must finish first, so run agentx init again");
        const bound = await addChannel({
          session, botToken: await readBotToken(context.secrets, context.env), teamId: slack.teamId, botUserId: slack.botUserId, projectName: project.name,
          prompter: context.prompter, write: context.write, sleep: context.sleep, now: context.now, services: context.setup, flags: context.flags,
        });
        project = { ...project, channelId: bound.channelId, channelName: bound.channelName, teamId: slack.teamId };
        await progress.update({ project });
      }
```

and return `{ status: "done", note: `project ${project.name} in #${project.channelName}` }`.

In `setup/cli.ts`, add:

```ts
  program.command("channel").description("Slack channels bound to AgentX projects")
    .command("add")
    .description("bind a Slack channel to a project, invite the bot, and check a mention gets a threaded reply")
    .requiredOption("--project <name>", "the project")
    .option("--channel <name>", "the channel's name")
    .option("--no-check", "bind only; skip waiting for a reply")
    .action(async (options: { project: string; channel?: string; check: boolean }, command: Command) => {
      const run = await context.open(command);
      const botToken = await readBotToken(run.secrets, run.env);
      const identity = await run.services.slackIdentity(botToken);
      const bound = await addChannel({ session: run.session, botToken, teamId: identity.teamId, botUserId: identity.botUserId, projectName: options.project, prompter: run.prompter, write: run.write, sleep: run.sleep, now: run.now, services: run.services, flags: options });
      if (options.check) await waitForThreadedReply({ session: run.session, fetch: run.services.fetch, teamId: identity.teamId, channelId: bound.channelId, channelName: bound.channelName, botUserId: identity.botUserId, write: run.write, sleep: run.sleep, now: run.now });
      run.print(bound, `Bound #${bound.channelName} to ${options.project}\n`);
    });
```

This needs two more things, added here:
- `SetupRun` gains `sleep` and `now`;
- `SetupServices` gains `slackIdentity(botToken): Promise<{ teamId: string; botUserId: string }>`,
  whose real implementation calls 15d1's `SlackApi.authTest` and returns `team_id` and `user_id`;
  its fake returns `{ teamId: "T0123456789", botUserId: "U0BOT00001" }`.

`--project` here is the command's own option; the global `--project` is unrelated to it. If
commander reports a clash with the global option, name it `--to-project` and change the
description.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/contract/setup-channel.test.ts tests/contract/setup-project-add.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/setup packages/cli/src/init/finish-steps.ts tests/support/setup-fakes.ts tests/contract/setup-channel.test.ts
git commit -m "feat(setup): agentx channel add, and watching turn records for the threaded reply (FR-041)"
```

### Task 9: A connector's new revision, and `agentx connector add linear`

**Files:**
- Create: `packages/cli/src/setup/connectors/revision.ts`
- Create: `packages/cli/src/setup/connectors/vendors.ts` (the `VendorApi` interface and its Linear part)
- Create: `packages/cli/src/setup/connectors/linear.ts`
- Modify: `packages/cli/src/setup/services.ts` (`vendors`)
- Modify: `packages/cli/src/setup/cli.ts` (`connector add linear`)
- Modify: `tests/support/setup-fakes.ts` (`fakeVendors`)
- Test: `tests/contract/setup-connector-linear.test.ts`

**Interfaces:**
- Consumes: `loadProjectConfig`; `registerRevision` (Task 7); `registerCredential`; `secretFromSource`, `Prompter`, `SecretSource`; `InitSecrets` (`create`, `put`, `arn`); `environmentConnectorSecretPrefix`; `LinearConnectorSchema`, `ConnectorConfig` (`@agentx/contracts`).
- Produces:

```ts
// revision.ts
export async function storeConnectorSecret(secrets: Pick<InitSecrets, "arn" | "create" | "put">, name: string, value: string): Promise<void>;
export async function addConnectorRevision(input: {
  env: string; session: AdminSession; projectName: string; connector: ConnectorConfig;
  services: Pick<SetupServices, "fetch" | "stackOutputs" | "configDir">; write: (line: string) => void;
}): Promise<{ revision: number }>;
export function connectorSecretName(env: string, type: ConnectorType): string; // agentx/<env>/connectors/<type>
export function scopeAlias(text: string): string;
// vendors.ts
export interface LinearTeam { id: string; key: string; name: string }
export interface VendorApi {
  linearTeams(apiKey: string): Promise<LinearTeam[]>;
  // Tasks 10 and 11 add jiraCloudId, jiraSearch, asanaAccessToken and asanaProject.
}
export function vendorApi(fetchImplementation: typeof fetch): VendorApi;
// linear.ts
export const LINEAR_GUIDE: string;
export const LINEAR_TOOLS: ConnectorConfig["tools"];
export async function addLinear(input: ConnectorAddInput): Promise<{ ref: string; revision: number }>;
export interface ConnectorAddInput {
  env: string; session: AdminSession; projectName: string; secrets: Pick<InitSecrets, "arn" | "create" | "put" | "get">;
  prompter: Prompter; processEnv: NodeJS.ProcessEnv; write: (line: string) => void;
  services: Pick<SetupServices, "fetch" | "stackOutputs" | "configDir" | "vendors">;
  flags: FinishFlags;
}
// SetupServices gains: vendors: VendorApi
```

`ConnectorAddInput` lives in `revision.ts` and is used by all three connectors.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/contract/setup-connector-linear.test.ts
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addLinear, LINEAR_GUIDE } from "../../packages/cli/src/setup/connectors/linear.js";
import { writeProjectFile } from "../../packages/cli/src/setup/project-add.js";
import { memoryInitSecrets, scriptedPrompter } from "../support/init-fakes.js";
import { CONTROL_PLANE, fakeControlPlane, fakeVendors } from "../support/setup-fakes.js";

const KEY = `lin_api_${"k".repeat(150)}`; // longer than 128: must be stored whole
const FOUNDATION = { Ec2WorkerLaunchTemplateId: "lt-0123456789abcdef0", Ec2WorkerSubnets: "us-east-1a=subnet-0aaa1111bbbb2222c" };
const session = { controlPlaneUrl: CONTROL_PLANE, accessToken: "admin-token" };
let configDir: string;

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "agentx-projects-"));
  await writeProjectFile(configDir, {
    name: "payments-api", revision: 1,
    repositories: [{ name: "payments-api", url: "https://github.com/acme/payments-api.git", path: "repo/payments-api", defaultBranch: "main", credentialRef: "github-agentx-sdlc" }],
    setup: [], readiness: [], orchestratorInstructions: "Delegate every repository read, edit, build, and test to the remote AgentX worker.",
  });
});
afterEach(async () => { await rm(configDir, { recursive: true, force: true }); });

function input(overrides: { script?: Array<string | boolean>; plane?: ReturnType<typeof fakeControlPlane>; vendors?: ReturnType<typeof fakeVendors>; lines?: string[]; secrets?: ReturnType<typeof memoryInitSecrets> } = {}) {
  const plane = overrides.plane ?? fakeControlPlane();
  return {
    env: "staging", session, projectName: "payments-api", secrets: overrides.secrets ?? memoryInitSecrets(),
    prompter: scriptedPrompter(overrides.script ?? [KEY, "c408e946-78aa-4db8-923e-f78053dd954f"]),
    processEnv: {}, write: (line: string) => { overrides.lines?.push(line); },
    services: { fetch: plane.fetch, configDir, stackOutputs: async () => FOUNDATION, vendors: overrides.vendors ?? fakeVendors() },
    flags: {},
  };
}

describe("agentx connector add linear (FR-036 to FR-039)", () => {
  it("prints the guide, lists the key's teams as its test read, then stores, registers and scopes it", async () => {
    const plane = fakeControlPlane();
    const vendors = fakeVendors({ linearTeams: [{ id: "c408e946-78aa-4db8-923e-f78053dd954f", key: "PAY", name: "Payments" }, { id: "d0000000-0000-4000-8000-000000000001", key: "OPS", name: "Ops" }] });
    const secrets = memoryInitSecrets();
    const lines: string[] = [];
    expect(await addLinear(input({ plane, vendors, secrets, lines }))).toEqual({ ref: "linear", revision: 2 });
    expect(lines[0]).toBe(LINEAR_GUIDE);
    expect(lines.join("\n")).toContain("The key can see 2 teams: PAY (Payments), OPS (Ops).");
    expect(vendors.calls).toEqual(["linearTeams"]);
    expect(JSON.parse(secrets.values.get("agentx/staging/connectors/linear")!)).toEqual({ apiKey: KEY });
    expect(plane.credentials).toContainEqual({ ref: "linear", type: "static-secret", secretName: "agentx/staging/connectors/linear" });
    const registered = plane.registered.at(-1) as { definition: { revision: number; integrations: { connectors: Array<Record<string, unknown>> } } };
    expect(registered.definition.revision).toBe(2);
    expect(registered.definition.integrations.connectors[0]).toMatchObject({ name: "linear", type: "linear", credentialRef: "linear", scopes: [{ alias: "pay", teamId: "c408e946-78aa-4db8-923e-f78053dd954f" }] });
    const file = await readFile(join(configDir, "payments-api.yaml"), "utf8");
    expect(file).toContain("revision: 2");
    expect(file).not.toContain(KEY);
    expect(lines.join("\n")).not.toContain(KEY);
  });

  it("stores nothing when Linear refuses the key", async () => {
    const secrets = memoryInitSecrets();
    const vendors = fakeVendors({ linearRefuses: true });
    await expect(addLinear(input({ vendors, secrets }))).rejects.toThrow("Linear refused the API key; check you copied all of it and that it is not revoked (Settings, Account, Security & Access). Nothing was stored");
    expect(secrets.values.size).toBe(0);
  });

  it("refuses a team the key cannot see", async () => {
    await expect(addLinear(input({ script: [KEY, "not-a-team"] }))).rejects.toThrow("the key cannot see team not-a-team");
  });

  it("fails the step when the preflight does not report the connector connected, keeping the revision", async () => {
    const plane = fakeControlPlane();
    plane.preflight.linear = { status: "not_connected", problem: "Linear rejected the credential twice" };
    await expect(addLinear(input({ plane }))).rejects.toThrow("revision 2 of payments-api is registered, but the linear connector is not_connected: Linear rejected the credential twice. Fix it, then run agentx connector add linear --project payments-api again");
  });

  it("replaces an earlier linear connector instead of adding a second one", async () => {
    const plane = fakeControlPlane();
    await addLinear(input({ plane }));
    await addLinear(input({ plane }));
    const last = plane.registered.at(-1) as { definition: { revision: number; integrations: { connectors: unknown[] } } };
    expect(last.definition.revision).toBe(3);
    expect(last.definition.integrations.connectors).toHaveLength(1);
  });
});
```

`fakeVendors` in `setup-fakes.ts`:

```ts
export function fakeVendors(options: {
  linearTeams?: Array<{ id: string; key: string; name: string }>; linearRefuses?: boolean;
} = {}): import("../../packages/cli/src/setup/connectors/vendors.js").VendorApi & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async linearTeams() {
      calls.push("linearTeams");
      if (options.linearRefuses) throw Object.assign(new Error("401"), { name: "VendorRefused" });
      return options.linearTeams ?? [{ id: "c408e946-78aa-4db8-923e-f78053dd954f", key: "PAY", name: "Payments" }];
    },
  };
}
```

Tasks 10 and 11 add their options and methods to this fake.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/contract/setup-connector-linear.test.ts`
Expected: FAIL, "Cannot find module .../setup/connectors/linear.js".

- [ ] **Step 3: Implement**

```ts
// packages/cli/src/setup/connectors/vendors.ts
// The one real read each connector's test needs (FR-038), behind one interface so tests fake it.
import { agentXError } from "@agentx/contracts";

export interface LinearTeam { id: string; key: string; name: string }
export interface VendorApi {
  linearTeams(apiKey: string): Promise<LinearTeam[]>;
}

/** Thrown when a vendor refuses the credential (401 or 403). Carries no vendor text. */
export class VendorRefused extends Error {
  constructor(vendor: string) { super(`${vendor} refused the credential`); this.name = "VendorRefused"; }
}

export function vendorApi(fetchImplementation: typeof fetch): VendorApi {
  return {
    async linearTeams(apiKey) {
      // A personal API key goes in Authorization as it is, without "Bearer" (Linear's API docs).
      const response = await fetchImplementation("https://api.linear.app/graphql", {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { authorization: apiKey, "content-type": "application/json" },
        body: JSON.stringify({ query: "{ teams { nodes { id key name } } }" }),
      });
      if (response.status === 401 || response.status === 403) throw new VendorRefused("Linear");
      if (!response.ok) throw agentXError("RUNTIME_UNAVAILABLE", `Linear answered HTTP ${response.status}; try again in a minute`);
      const body = (await response.json()) as { data?: { teams?: { nodes?: LinearTeam[] } }; errors?: unknown[] };
      if (body.errors !== undefined && body.errors.length > 0) throw new VendorRefused("Linear");
      return body.data?.teams?.nodes ?? [];
    },
  };
}
```

`fakeVendors`'s refusal is an `Error` named `VendorRefused`; the connector modules test
`error.name === "VendorRefused"`, so the fake and the class agree.

```ts
// packages/cli/src/setup/connectors/revision.ts
// A connector joins a project as a new revision of the project file project add wrote (FR-039).
// Registration runs the control plane's preflight; anything but "connected" fails the step with
// its reason, so a broken connector is never reported as set up.
import { agentXError, environmentConnectorSecretPrefix, type ConnectorConfig } from "@agentx/contracts";
import { loadProjectConfig } from "../../config.js";
import type { InitSecrets, FinishFlags } from "../../init/context.js";
import type { ConnectorType } from "../../init/install-state.js";
import type { Prompter } from "../../init/prompts.js";
import { registerRevision } from "../project-add.js";
import type { AdminSession, SetupServices } from "../services.js";

export interface ConnectorAddInput {
  env: string; session: AdminSession; projectName: string; secrets: Pick<InitSecrets, "arn" | "create" | "put" | "get">;
  prompter: Prompter; processEnv: NodeJS.ProcessEnv; write: (line: string) => void;
  services: Pick<SetupServices, "fetch" | "stackOutputs" | "configDir" | "vendors">;
  flags: FinishFlags;
}

export function connectorSecretName(env: string, type: ConnectorType): string {
  return `${environmentConnectorSecretPrefix(env)}${type}`;
}

export function scopeAlias(text: string): string {
  const cleaned = text.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return /^[a-z]/.test(cleaned) ? cleaned : `scope-${cleaned}`.slice(0, 40);
}

export async function storeConnectorSecret(secrets: Pick<InitSecrets, "arn" | "create" | "put">, name: string, value: string): Promise<void> {
  if ((await secrets.arn(name)) === undefined) await secrets.create(name, value);
  else await secrets.put(name, value);
}

export async function addConnectorRevision(input: {
  env: string; session: AdminSession; projectName: string; connector: ConnectorConfig;
  services: Pick<SetupServices, "fetch" | "stackOutputs" | "configDir">; write: (line: string) => void;
}): Promise<{ revision: number }> {
  const current = await loadProjectConfig({ projectName: input.projectName, configDirectory: input.services.configDir, allowLoopback: false });
  const others = (current.integrations?.connectors ?? []).filter((entry) => entry.name !== input.connector.name);
  const definition = { ...current, revision: current.revision + 1, integrations: { ...current.integrations, connectors: [...others, input.connector] } };
  const registered = await registerRevision({ env: input.env, session: input.session, definition, services: input.services });
  const report = registered.preflight.find((entry) => entry.name === input.connector.name);
  for (const warning of registered.warnings) input.write(`Warning: ${warning}`);
  if (report !== undefined && report.status !== "connected") {
    throw agentXError("CONFIG_INVALID", `revision ${registered.revision} of ${input.projectName} is registered, but the ${input.connector.name} connector is ${report.status}${report.problem === undefined ? "" : `: ${report.problem}`}. Fix it, then run agentx connector add ${input.connector.type} --project ${input.projectName} again`);
  }
  input.write(`Registered revision ${registered.revision} of ${input.projectName} with the ${input.connector.name} connector${report === undefined ? "" : `, offering ${report.offered.length} tools`}.`);
  return { revision: registered.revision };
}
```

If `loadProjectConfig`'s definition type differs from what `registerRevision` takes (for example,
`StoredProjectDefinition`), parse the merged definition with `ProjectDefinitionSchema.parse`
before registering; that also refuses a hand-edited file early, with the schema's message.

```ts
// packages/cli/src/setup/connectors/linear.ts
// agentx connector add linear (FR-036 to FR-039), from docs/connectors/linear.md. The key's own
// team list is the test read, and the engineer picks the team from it.
import { agentXError, type ConnectorConfig } from "@agentx/contracts";
import { registerCredential } from "../../admin/credential.js";
import { secretFromSource } from "../../init/prompts.js";
import { addConnectorRevision, connectorSecretName, scopeAlias, storeConnectorSecret, type ConnectorAddInput } from "./revision.js";

export const LINEAR_GUIDE = [
  "Linear: AgentX uses a Linear API key, which acts as the Linear user who made it.",
  "  1. In Linear, open Settings, Account, Security & Access. Under Personal API keys, choose New API key.",
  "  2. Permissions: Read, plus Create issues and Create comments (or Write, to let AgentX update issues).",
  "  3. Team access: only the teams this project may use.",
  "  4. Create the key and copy it; Linear shows it once. A dedicated Linear user keeps AgentX's writes apart from a person's.",
].join("\n");

export const LINEAR_TOOLS: ConnectorConfig["tools"] = [
  { name: "list_issues", access: "read" },
  { name: "get_issue", access: "read", allowedArguments: ["id", "includeCustomerNeeds", "includeReleases"] },
  { name: "save_issue", access: "write", allowedArguments: ["id", "title", "description", "state", "assignee", "priority", "labels", "dueDate"] },
  { name: "save_comment", access: "write", allowedArguments: ["issueId", "body"] },
];

export async function addLinear(input: ConnectorAddInput): Promise<{ ref: string; revision: number }> {
  input.write(LINEAR_GUIDE);
  const apiKey = await secretFromSource({ what: "Linear API key", flag: "--linear-key", source: input.flags.linearKey ?? {}, processEnv: input.processEnv, prompter: input.prompter });
  let teams;
  try {
    teams = await input.services.vendors.linearTeams(apiKey);
  } catch (error) {
    if (error instanceof Error && error.name === "VendorRefused") {
      throw agentXError("AUTH_REQUIRED", "Linear refused the API key; check you copied all of it and that it is not revoked (Settings, Account, Security & Access). Nothing was stored");
    }
    throw error;
  }
  if (teams.length === 0) throw agentXError("CONFIG_INVALID", "the key can see no Linear team; give it access to the project's team, then run this again. Nothing was stored");
  input.write(`The key can see ${teams.length} teams: ${teams.map((team) => `${team.key} (${team.name})`).join(", ")}.${teams.length > 1 ? " Limit the key to the project's team in Linear if you can." : ""}`);
  const wanted = input.flags.linearTeam ?? await input.prompter.choose<string>("Which Linear team may this project use?", teams.map((team) => ({ value: team.id, label: `${team.key} (${team.name})` })), { flag: "--linear-team", defaultValue: teams[0]!.id });
  const team = teams.find((entry) => entry.id === wanted || entry.key.toLowerCase() === wanted.toLowerCase());
  if (team === undefined) throw agentXError("CONFIG_INVALID", `the key cannot see team ${wanted}; it sees ${teams.map((entry) => entry.key).join(", ")}. Nothing was stored`);

  const secretName = connectorSecretName(input.env, "linear");
  await storeConnectorSecret(input.secrets, secretName, JSON.stringify({ apiKey }));
  await registerCredential({ ...input.session, ref: "linear", type: "static-secret", secretName }, input.services.fetch);
  const { revision } = await addConnectorRevision({
    env: input.env, session: input.session, projectName: input.projectName, write: input.write, services: input.services,
    connector: { name: "linear", type: "linear", credentialRef: "linear", scopes: [{ alias: scopeAlias(team.key), teamId: team.id }], tools: LINEAR_TOOLS },
  });
  return { ref: "linear", revision };
}
```

`scriptedPrompter`'s `choose` matches on `value`, so the test's second answer is the team id.

In `services.ts`, add `vendors: VendorApi;` ("Tasks 9 to 11"); in `setupServices()`,
`vendors: fakeVendors()`.

In `setup/cli.ts`, add the `connector` group:

```ts
  // agentx connector add linear|jira|asana, the words FR-036 uses.
  const connector = program.command("connector").description("connect a project to Linear, Jira or Asana")
    .command("add").description("add a connector to a project");
  connector.command("linear")
    .description("add Linear to a project: guide, key, test read, team, new revision")
    .requiredOption("--project <name>", "the project, as project add named it")
    .option("--linear-key-file <path>", "file holding the Linear API key")
    .option("--linear-key-env <NAME>", "environment variable holding the Linear API key")
    .option("--linear-team <id or key>", "the team the project may use")
    .action(async (options: { project: string; linearKeyFile?: string; linearKeyEnv?: string; linearTeam?: string }, command: Command) => {
      const run = await context.open(command);
      const result = await addLinear({
        env: run.env, session: run.session, projectName: options.project, secrets: run.secrets, prompter: run.prompter, processEnv: process.env, write: run.write, services: run.services,
        flags: { ...(options.linearTeam === undefined ? {} : { linearTeam: options.linearTeam }), ...secretFlag("linearKey", options.linearKeyFile, options.linearKeyEnv) },
      });
      run.print(result, `Linear connected to ${options.project} (revision ${result.revision})\n`);
    });
```

with, in `cli.ts`:

```ts
const secretFlag = (key: string, file?: string, envName?: string) =>
  (file === undefined && envName === undefined ? {} : { [key]: { ...(file === undefined ? {} : { file }), ...(envName === undefined ? {} : { envName }) } });
```

Tasks 10 and 11 add `jira` and `asana` under the same `connector` (`add`) command.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/contract/setup-connector-linear.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/setup tests/support/setup-fakes.ts tests/contract/setup-connector-linear.test.ts
git commit -m "feat(setup): agentx connector add linear, with a test read and a new project revision"
```

### Task 10: `agentx connector add jira`

**Files:**
- Create: `packages/cli/src/setup/connectors/jira.ts`
- Modify: `packages/cli/src/setup/connectors/vendors.ts` (`jiraCloudId`, `jiraSearch`)
- Modify: `packages/cli/package.json` (`"@agentx/gateway": "0.1.0"`, bundled by `pack-cli.ts`)
- Modify: `packages/cli/src/setup/cli.ts` (`connector add jira`)
- Modify: `tests/support/setup-fakes.ts` (`fakeVendors`'s Jira options)
- Test: `tests/contract/setup-connector-jira.test.ts`

**Interfaces:**
- Consumes: `ConnectorAddInput`, `addConnectorRevision`, `connectorSecretName`, `scopeAlias`, `storeConnectorSecret` (Task 9); `connectMcp` (`@agentx/gateway`); `JiraConnectorSchema`.
- Produces:

```ts
// vendors.ts, VendorApi gains:
  /** GET https://<site>.atlassian.net/_edge/tenant_info: the site's cloudId, lowercase. */
  jiraCloudId(siteUrl: string): Promise<string>;
  /** searchJiraIssuesUsingJql through Rovo MCP /v2 with the API token as Bearer: the distinct issue keys found (at most maxResults issues). */
  jiraSearch(input: { token: string; cloudId: string; jql: string; maxResults: number }): Promise<string[]>;
// jira.ts
export const JIRA_GUIDE: string;
export const JIRA_TOOLS: ConnectorConfig["tools"];
/** How many issues the outside search reads, to name the other projects (owner decision 6). */
export const OUTSIDE_SAMPLE = 50;
export function jiraSiteUrl(typed: string): string;
/** The project keys in `issueKeys` (PAY-1 -> PAY), distinct, in first-seen order. */
export function projectKeys(issueKeys: readonly string[]): string[];
/** Owner decision 6's warning, at most 300 characters: up to 5 keys, then "and N more". */
export function widerAccessWarning(projectKey: string, others: readonly string[]): string;
export async function addJira(input: ConnectorAddInput): Promise<{ ref: string; revision: number; warning?: string }>;
```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/contract/setup-connector-jira.test.ts
// (copy the imports, FOUNDATION, session, configDir, beforeEach, afterEach and input() from
// Task 9's setup-connector-linear.test.ts verbatim; each test file stands alone)
import { addJira, JIRA_GUIDE, jiraSiteUrl, projectKeys, widerAccessWarning } from "../../packages/cli/src/setup/connectors/jira.js";

const TOKEN = `ATATT${"t".repeat(187)}`; // about 192 characters, as Atlassian's are
const CLOUD = "0f1e2d3c-4b5a-4968-8776-655443322110";

describe("the Jira site", () => {
  it("accepts a bare site name, a host or a URL, and returns https://<site>.atlassian.net", () => {
    expect(jiraSiteUrl("acme")).toBe("https://acme.atlassian.net");
    expect(jiraSiteUrl("Acme.atlassian.net")).toBe("https://acme.atlassian.net");
    expect(jiraSiteUrl("https://acme.atlassian.net/jira/software/projects/PAY/boards/1")).toBe("https://acme.atlassian.net");
    expect(() => jiraSiteUrl("jira.acme.com")).toThrow("Jira Cloud sites are https://<site>.atlassian.net");
  });
});

describe("agentx connector add jira (FR-036 to FR-039)", () => {
  it("proves the token sees the project before storing it, then scopes it with siteUrl", async () => {
    const plane = fakeControlPlane();
    const vendors = fakeVendors({ jiraCloudId: CLOUD, jiraInside: ["PAY-1"], jiraOutside: [] });
    const secrets = memoryInitSecrets();
    const lines: string[] = [];
    // site, token, project key
    expect(await addJira(input({ plane, vendors, secrets, lines, script: ["acme", TOKEN, "PAY"] }))).toEqual({ ref: "jira", revision: 2 });
    expect(lines[0]).toBe(JIRA_GUIDE);
    expect(vendors.calls).toEqual(["jiraCloudId https://acme.atlassian.net", "jiraSearch project = PAY max 5", "jiraSearch project not in (PAY) max 50"]);
    expect(JSON.parse(secrets.values.get("agentx/staging/connectors/jira")!)).toEqual({ apiKey: TOKEN });
    const registered = plane.registered.at(-1) as { definition: { integrations: { connectors: Array<Record<string, unknown>> } } };
    expect(registered.definition.integrations.connectors[0]).toMatchObject({
      name: "jira", type: "jira", credentialRef: "jira",
      scopes: [{ alias: "pay", cloudId: CLOUD, projectKey: "PAY", siteUrl: "https://acme.atlassian.net" }],
    });
    expect(lines.join("\n")).not.toContain(TOKEN);
  });

  it("saves a service account that can see other projects, with a warning naming them (owner decision 6)", async () => {
    const plane = fakeControlPlane();
    const secrets = memoryInitSecrets();
    const lines: string[] = [];
    const vendors = fakeVendors({ jiraCloudId: CLOUD, jiraInside: ["PAY-1"], jiraOutside: ["HR-4", "FIN-2", "HR-9"] });
    const result = await addJira(input({ plane, vendors, secrets, lines, script: ["acme", TOKEN, "PAY"] }));
    const warning = "the Jira service account can also see issues in HR and FIN, so AgentX will be able to read issues in those projects too. Narrow the account to PAY in each other project's permission scheme (docs/connectors/jira.md, Step 4)";
    expect(result).toEqual({ ref: "jira", revision: 2, warning });
    expect(lines).toContain(`Warning: ${warning}`);
    // Saved all the same: the secret, the credential and the revision.
    expect(JSON.parse(secrets.values.get("agentx/staging/connectors/jira")!)).toEqual({ apiKey: TOKEN });
    expect(plane.credentials).toContainEqual({ ref: "jira", type: "static-secret", secretName: "agentx/staging/connectors/jira" });
    expect(plane.registered).toHaveLength(1);
    // The outside search reads enough issues to name several projects.
    expect(vendors.calls).toContain("jiraSearch project not in (PAY) max 50");
  });

  it("names the first five other projects and counts the rest", () => {
    expect(widerAccessWarning("PAY", ["HR", "FIN", "OPS", "LEGAL", "SALES", "IT", "QA"])).toBe(
      "the Jira service account can also see issues in HR, FIN, OPS, LEGAL, SALES and 2 more, so AgentX will be able to read issues in those projects too. Narrow the account to PAY in each other project's permission scheme (docs/connectors/jira.md, Step 4)",
    );
    expect(widerAccessWarning("PAY", ["HR"])).toContain("can also see issues in HR, so AgentX");
    expect(widerAccessWarning("PAY", ["A".repeat(10), "B".repeat(10), "C".repeat(10), "D".repeat(10), "E".repeat(10), "F"]).length).toBeLessThanOrEqual(300);
  });

  it("finds project keys from issue keys, once each", () => {
    expect(projectKeys(["HR-4", "FIN-2", "HR-9", "OPS_2-1"])).toEqual(["HR", "FIN", "OPS_2"]);
  });

  it("asks nothing more under --yes when the account sees other projects: the same warning, saved", async () => {
    const lines: string[] = [];
    const vendors = fakeVendors({ jiraCloudId: CLOUD, jiraInside: ["PAY-1"], jiraOutside: ["HR-4"] });
    const env = { TOKEN_ENV: TOKEN };
    const base = input({ vendors, lines, script: [] });
    const result = await addJira({ ...base, processEnv: env, flags: { jiraSite: "acme", jiraProject: "PAY", jiraToken: { envName: "TOKEN_ENV" } } });
    expect(result.warning).toContain("can also see issues in HR");
    expect(lines.some((line) => line.startsWith("Warning: the Jira service account can also see issues in HR"))).toBe(true);
  });

  it("says nothing extra when the account sees only the connected project", async () => {
    const result = await addJira(input({ vendors: fakeVendors({ jiraCloudId: CLOUD, jiraInside: ["PAY-1"], jiraOutside: [] }), script: ["acme", TOKEN, "PAY"] }));
    expect(result).toEqual({ ref: "jira", revision: 2 });
  });

  it("asks for one issue in an empty project, so an empty answer is not mistaken for a blind one", async () => {
    const vendors = fakeVendors({ jiraCloudId: CLOUD, jiraInside: [], jiraOutside: [] });
    await expect(addJira(input({ vendors, script: ["acme", TOKEN, "PAY"] }))).rejects.toThrow("the search found no issue in PAY; if the project is empty, create one issue in it and run this again. If it has issues, the service account cannot see them: add it to the project (Step 4)");
  });

  it("explains a refused token: API token authentication off, a missing scope, or the /v1 endpoint", async () => {
    const vendors = fakeVendors({ jiraCloudId: CLOUD, jiraRefuses: true });
    await expect(addJira(input({ vendors, script: ["acme", TOKEN, "PAY"] }))).rejects.toThrow("Atlassian refused the API token; check that Rovo MCP's Allow API token authentication is on (Step 1) and the token has all six scopes (Step 5). Nothing was stored");
  });

  it("refuses a project key that is not one", async () => {
    await expect(addJira(input({ vendors: fakeVendors({ jiraCloudId: CLOUD }), script: ["acme", TOKEN, "pay project"] }))).rejects.toThrow("a Jira project key is capital letters and digits, such as PAY");
  });
});
```

Add to `fakeVendors`'s options `jiraCloudId?: string; jiraInside?: string[]; jiraOutside?: string[]; jiraRefuses?: boolean`, and methods:

```ts
    async jiraCloudId(siteUrl) { calls.push(`jiraCloudId ${siteUrl}`); return options.jiraCloudId ?? "0f1e2d3c-4b5a-4968-8776-655443322110"; },
    async jiraSearch({ jql, maxResults }) {
      calls.push(`jiraSearch ${jql} max ${maxResults}`);
      if (options.jiraRefuses) throw Object.assign(new Error("401"), { name: "VendorRefused" });
      return jql.includes("not in") ? options.jiraOutside ?? [] : options.jiraInside ?? ["PAY-1"];
    },
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/contract/setup-connector-jira.test.ts`
Expected: FAIL, "Cannot find module .../setup/connectors/jira.js".

- [ ] **Step 3: Implement the vendor calls**

In `vendors.ts`, import `connectMcp` and `McpUnauthorized` from `@agentx/gateway`, and add to
the object `vendorApi` returns:

```ts
    async jiraCloudId(siteUrl) {
      const response = await fetchImplementation(`${siteUrl}/_edge/tenant_info`, { redirect: "error", signal: AbortSignal.timeout(15_000) });
      const body = response.ok ? (await response.json()) as { cloudId?: unknown } : {};
      if (typeof body.cloudId !== "string") throw agentXError("CONFIG_INVALID", `${siteUrl} did not return a cloudId; check the site name`);
      return body.cloudId.toLowerCase();
    },
    async jiraSearch({ token, cloudId, jql, maxResults }) {
      let connection;
      try {
        // /v2 is the endpoint that accepts API tokens; /v1 ignores them (spec 013 lessons).
        connection = await connectMcp({ endpoint: new URL("https://mcp.atlassian.com/v2/mcp"), token, tools: ["searchJiraIssuesUsingJql"], signal: AbortSignal.timeout(30_000), fetchImplementation });
      } catch (error) {
        if (error instanceof McpUnauthorized) throw new VendorRefused("Atlassian");
        throw error;
      }
      try {
        const result = await connection.call("searchJiraIssuesUsingJql", { cloudId, jql, maxResults });
        if (result.isError === true) throw new VendorRefused("Atlassian");
        const text = (result.content ?? []).map((part) => ("text" in part && typeof part.text === "string" ? part.text : "")).join("");
        return [...new Set(text.match(/\b[A-Z][A-Z0-9_]+-[0-9]+\b/g) ?? [])];
      } finally {
        await connection.close();
      }
    },
```

This is the Jira guide's Step 8 check, in code. The outside search reads up to
`OUTSIDE_SAMPLE` (50) issues so the warning can name several projects; the other projects are
at least those found, so the warning says "can also see", never "can see only". If `McpToolResult`'s content parts are typed
differently, follow `packages/gateway/src/mcp-client.ts`.

- [ ] **Step 4: Implement the connector**

```ts
// packages/cli/src/setup/connectors/jira.ts
// agentx connector add jira (FR-036 to FR-039), from docs/connectors/jira.md: a service account's
// API token against Rovo MCP /v2. The test read is the guide's Step 8: the token must find an issue
// inside the project before anything is stored. Issues it finds outside the project do not stop it
// (owner decision 6, 2026-09-28): the connector is saved with a warning naming those projects.
import { agentXError, type ConnectorConfig } from "@agentx/contracts";
import { registerCredential } from "../../admin/credential.js";
import { secretFromSource } from "../../init/prompts.js";
import { addConnectorRevision, connectorSecretName, scopeAlias, storeConnectorSecret, type ConnectorAddInput } from "./revision.js";

export const JIRA_GUIDE = [
  "Jira: AgentX acts as an Atlassian service account, with an API token.",
  "  1. admin.atlassian.com: Apps, AI settings, Rovo MCP server, Authentication: turn on Allow API token authentication.",
  "  2. Directory, Service accounts: create one (for example AgentX), and give it Jira with the User role only.",
  "  3. Add it to the project AgentX may use; make sure no other project lets it browse (docs/connectors/jira.md, Step 4).",
  "  4. On the service account, Credentials: create an API token (not OAuth) with read:jira-work, write:jira-work, read:jira-user,",
  "     read:jira:agent-interface, write:jira:agent-interface and search:jira:agent-interface. Copy it; it is about 192 characters.",
].join("\n");

export const JIRA_TOOLS: ConnectorConfig["tools"] = [
  { name: "searchJiraIssuesUsingJql", access: "read" },
  { name: "getJiraIssue", access: "read" },
  { name: "createJiraIssue", access: "write" },
  { name: "addOrEditJiraIssueComment", access: "write" },
];

export function jiraSiteUrl(typed: string): string {
  const text = typed.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0]!;
  const site = text.endsWith(".atlassian.net") ? text.slice(0, -".atlassian.net".length) : text;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,60}[a-z0-9])?$/.test(site)) throw agentXError("CONFIG_INVALID", "Jira Cloud sites are https://<site>.atlassian.net; type the <site> part");
  return `https://${site}.atlassian.net`;
}

const refused = (error: unknown) => error instanceof Error && error.name === "VendorRefused";

export const OUTSIDE_SAMPLE = 50;
const NAMED = 5;
const WARNING_LIMIT = 300;

export function projectKeys(issueKeys: readonly string[]): string[] {
  return [...new Set(issueKeys.map((key) => key.replace(/-[0-9]+$/, "")))];
}

export function widerAccessWarning(projectKey: string, others: readonly string[]): string {
  const shown = others.slice(0, NAMED);
  const rest = others.length - shown.length;
  const list = rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)!}` : shown[0]!;
  const text = `the Jira service account can also see issues in ${list}, so AgentX will be able to read issues in those projects too. Narrow the account to ${projectKey} in each other project's permission scheme (docs/connectors/jira.md, Step 4)`;
  // Project keys are at most 10 characters, so 5 of them always fit; the cut is only a guard.
  return text.length <= WARNING_LIMIT ? text : text.slice(0, WARNING_LIMIT);
}

export async function addJira(input: ConnectorAddInput): Promise<{ ref: string; revision: number; warning?: string }> {
  input.write(JIRA_GUIDE);
  const siteUrl = jiraSiteUrl(input.flags.jiraSite ?? await input.prompter.ask("Your Jira site (the <site> in <site>.atlassian.net)", { flag: "--jira-site" }));
  const cloudId = await input.services.vendors.jiraCloudId(siteUrl);
  const token = await secretFromSource({ what: "Jira API token", flag: "--jira-token", source: input.flags.jiraToken ?? {}, processEnv: input.processEnv, prompter: input.prompter });
  const projectKey = (input.flags.jiraProject ?? await input.prompter.ask("The Jira project key AgentX may use (for example PAY)", { flag: "--jira-project" })).trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{0,9}$/.test(projectKey)) throw agentXError("CONFIG_INVALID", "a Jira project key is capital letters and digits, such as PAY");

  let inside: string[];
  let outside: string[];
  try {
    inside = await input.services.vendors.jiraSearch({ token, cloudId, jql: `project = ${projectKey}`, maxResults: 5 });
    outside = await input.services.vendors.jiraSearch({ token, cloudId, jql: `project not in (${projectKey})`, maxResults: OUTSIDE_SAMPLE });
  } catch (error) {
    if (refused(error)) throw agentXError("AUTH_REQUIRED", "Atlassian refused the API token; check that Rovo MCP's Allow API token authentication is on (Step 1) and the token has all six scopes (Step 5). Nothing was stored");
    throw error;
  }
  if (inside.length === 0) throw agentXError("CONFIG_INVALID", `the search found no issue in ${projectKey}; if the project is empty, create one issue in it and run this again. If it has issues, the service account cannot see them: add it to the project (Step 4)`);
  // Owner decision 6: warn and save, never refuse, and never ask (so --yes behaves the same).
  const others = projectKeys(outside).filter((key) => key !== projectKey);
  const warning = others.length === 0 ? undefined : widerAccessWarning(projectKey, others);
  input.write(`The token sees ${projectKey} (${inside.join(", ")}).${warning === undefined ? " It sees no other project." : ""}`);
  if (warning !== undefined) input.write(`Warning: ${warning}`);

  const secretName = connectorSecretName(input.env, "jira");
  await storeConnectorSecret(input.secrets, secretName, JSON.stringify({ apiKey: token }));
  await registerCredential({ ...input.session, ref: "jira", type: "static-secret", secretName }, input.services.fetch);
  const { revision } = await addConnectorRevision({
    env: input.env, session: input.session, projectName: input.projectName, write: input.write, services: input.services,
    connector: { name: "jira", type: "jira", credentialRef: "jira", scopes: [{ alias: scopeAlias(projectKey), cloudId, projectKey, siteUrl }], tools: JIRA_TOOLS },
  });
  return { ref: "jira", revision, ...(warning === undefined ? {} : { warning }) };
}
```

The questions come in the order site, token, project key, which is the order the tests script
their answers in.

Add `"@agentx/gateway": "0.1.0"` to `packages/cli/package.json`'s dependencies, add the gateway
to the CLI's TypeScript project references if the repo uses them (check
`packages/cli/tsconfig.json`), and run `npm install`. Then run
`npx tsx scripts/release/pack-cli.ts --version 0.0.0 --out <scratch>` once and check the bundle
contains `@modelcontextprotocol/sdk` code and no bare import of it.

In `setup/cli.ts`, add under `connector`:

```ts
  connector.command("jira")
    .description("add Jira to a project: guide, service account token, project check, new revision")
    .requiredOption("--project <name>", "the project, as project add named it")
    .option("--jira-site <site>", "the <site> in <site>.atlassian.net")
    .option("--jira-project <key>", "the Jira project key")
    .option("--jira-token-file <path>", "file holding the API token")
    .option("--jira-token-env <NAME>", "environment variable holding the API token")
    .action(async (options: { project: string; jiraSite?: string; jiraProject?: string; jiraTokenFile?: string; jiraTokenEnv?: string }, command: Command) => {
      const run = await context.open(command);
      const result = await addJira({
        env: run.env, session: run.session, projectName: options.project, secrets: run.secrets, prompter: run.prompter, processEnv: process.env, write: run.write, services: run.services,
        flags: {
          ...(options.jiraSite === undefined ? {} : { jiraSite: options.jiraSite }),
          ...(options.jiraProject === undefined ? {} : { jiraProject: options.jiraProject }),
          ...secretFlag("jiraToken", options.jiraTokenFile, options.jiraTokenEnv),
        },
      });
      // The warning was already printed by addJira; --json carries it in the result too. Exit 0.
      run.print(result, `Jira connected to ${options.project} (revision ${result.revision})${result.warning === undefined ? "" : ", with the warning above"}\n`);
    });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/contract/setup-connector-jira.test.ts tests/contract/release-pack-cli.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/package.json package-lock.json packages/cli/src/setup tests/support/setup-fakes.ts tests/contract/setup-connector-jira.test.ts
git commit -m "feat(setup): agentx connector add jira, warning when the account sees other projects"
```

### Task 11: `agentx connector add asana`

**Files:**
- Create: `packages/cli/src/setup/connectors/asana.ts`
- Modify: `packages/cli/src/setup/connectors/vendors.ts` (`asanaAccessToken`, `asanaProject`)
- Modify: `packages/cli/src/setup/services.ts` (`authorize`, `authorizeSecrets`)
- Modify: `packages/cli/src/setup/cli.ts` (`connector add asana`)
- Modify: `tests/support/setup-fakes.ts`
- Test: `tests/contract/setup-connector-asana.test.ts`

**Interfaces:**
- Consumes: `authorizeCredential`, `AuthorizeInput`, `AuthorizeSecrets`, `WRITABLE_TAG` (`admin/authorize.ts`); `OAUTH_AUTHORIZATION_PROFILES.asana`; Task 9's helpers; `connectMcp`.
- Produces:

```ts
// VendorApi gains:
  /** One refresh at Asana's token endpoint; the refresh token back when Asana rotated it. */
  asanaAccessToken(input: { clientId: string; clientSecret: string; refreshToken: string }): Promise<{ accessToken: string; refreshToken?: string }>;
  /** get_project through Asana MCP: the project's name, or undefined when the bot cannot see it. */
  asanaProject(input: { accessToken: string; projectGid: string }): Promise<{ name: string } | undefined>;
// SetupServices gains:
  authorize: (input: AuthorizeInput) => Promise<unknown>;   // default authorizeCredential
  authorizeSecrets: AuthorizeSecrets;                        // default secretsManagerAuthorizeSecrets
// asana.ts
export const ASANA_GUIDE: string;
export const ASANA_TOOLS: ConnectorConfig["tools"];
export async function addAsana(input: ConnectorAddInput & { services: ConnectorAddInput["services"] & Pick<SetupServices, "authorize" | "authorizeSecrets"> }): Promise<{ ref: string; revision: number }>;
```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/contract/setup-connector-asana.test.ts
// (copy the imports, FOUNDATION, session, configDir, beforeEach, afterEach and input() from
// Task 9's setup-connector-linear.test.ts verbatim; each test file stands alone)
import { addAsana, ASANA_GUIDE } from "../../packages/cli/src/setup/connectors/asana.js";

const SECRET = `asana-client-secret-${"s".repeat(40)}`;
const BOT = "agentx-bot@example.com";
const GID = "1210000000000010";

function fakeAuthorize(signedInAs = BOT) {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    authorize: async (options: { secrets: { read(n: string): Promise<string | undefined>; write(n: string, v: string): Promise<void> }; secretName: string; expectAccount?: string; openBrowser?: unknown; showUrl: (url: string, redirect: string) => void }) => {
      calls.push({ secretName: options.secretName, expectAccount: options.expectAccount, openBrowser: options.openBrowser });
      options.showUrl("https://app.asana.com/-/oauth_authorize?x=1", "(the Asana app's redirect URL must be exactly http://localhost:8765/callback)");
      if (signedInAs !== options.expectAccount) throw Object.assign(new Error(`AUTH_REQUIRED: the sign-in was for ${signedInAs}, not ${options.expectAccount}; nothing was stored or registered.`), { name: "AgentXError" });
      const app = JSON.parse((await options.secrets.read(options.secretName))!) as Record<string, string>;
      await options.secrets.write(options.secretName, JSON.stringify({ ...app, refreshToken: "refresh-1" }));
      return { registered: true };
    },
  };
}

function memoryAuthorizeSecrets(secrets: ReturnType<typeof memoryInitSecrets>) {
  return { read: async (name: string) => secrets.values.get(name), write: async (name: string, value: string) => { secrets.values.set(name, value); }, tag: async () => undefined };
}

describe("agentx connector add asana (FR-036 to FR-039)", () => {
  it("stores the app's client, signs the bot in with --no-browser and --expect-account, reads the project, then scopes it", async () => {
    const plane = fakeControlPlane();
    const secrets = memoryInitSecrets();
    const auth = fakeAuthorize();
    const vendors = fakeVendors({ asanaProject: { name: "Payments" } });
    const lines: string[] = [];
    // client id, client secret, bot email, project gid
    const base = input({ plane, vendors, secrets, lines, script: ["1200000000000001", SECRET, BOT, GID] });
    const result = await addAsana({ ...base, services: { ...base.services, authorize: auth.authorize as never, authorizeSecrets: memoryAuthorizeSecrets(secrets) } });
    expect(result).toEqual({ ref: "asana", revision: 2 });
    expect(lines[0]).toBe(ASANA_GUIDE);
    // FR-037: no browser is opened, and only the bot's sign-in is accepted.
    expect(auth.calls).toEqual([{ secretName: "agentx/staging/connectors/asana", expectAccount: BOT, openBrowser: undefined }]);
    expect(lines.join("\n")).toContain("Open this address in a private window signed in as agentx-bot@example.com");
    expect(vendors.calls).toEqual(["asanaAccessToken", `asanaProject ${GID}`]);
    expect(lines.join("\n")).toContain("The bot user sees the Asana project Payments.");
    const registered = plane.registered.at(-1) as { definition: { integrations: { connectors: Array<Record<string, unknown>> } } };
    expect(registered.definition.integrations.connectors[0]).toMatchObject({ name: "asana", type: "asana", credentialRef: "asana", scopes: [{ alias: "payments", projectGid: GID }] });
    for (const text of [lines.join("\n"), JSON.stringify(plane.registered)]) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain("refresh-1");
    }
  });

  it("writes back a refresh token Asana rotated during the test read", async () => {
    const secrets = memoryInitSecrets();
    const base = input({ secrets, vendors: fakeVendors({ asanaProject: { name: "Payments" }, asanaRotates: "refresh-2" }), script: ["1200000000000001", SECRET, BOT, GID] });
    await addAsana({ ...base, services: { ...base.services, authorize: fakeAuthorize().authorize as never, authorizeSecrets: memoryAuthorizeSecrets(secrets) } });
    expect(JSON.parse(secrets.values.get("agentx/staging/connectors/asana")!).refreshToken).toBe("refresh-2");
  });

  it("refuses when the bot user cannot see the project, before saving the revision", async () => {
    const plane = fakeControlPlane();
    const secrets = memoryInitSecrets();
    const base = input({ plane, secrets, vendors: fakeVendors({ asanaProject: undefined }), script: ["1200000000000001", SECRET, BOT, GID] });
    await expect(addAsana({ ...base, services: { ...base.services, authorize: fakeAuthorize().authorize as never, authorizeSecrets: memoryAuthorizeSecrets(secrets) } }))
      .rejects.toThrow(`the bot user cannot see Asana project ${GID}; invite ${BOT} to that project as a guest with Editor access (docs/connectors/asana.md, Step 1), then run this again`);
    expect(plane.registered).toEqual([]);
  });

  it("passes on the refusal of a sign-in by the wrong account (FR-037)", async () => {
    const secrets = memoryInitSecrets();
    const base = input({ secrets, script: ["1200000000000001", SECRET, BOT, GID] });
    await expect(addAsana({ ...base, services: { ...base.services, authorize: fakeAuthorize("owner@example.com").authorize as never, authorizeSecrets: memoryAuthorizeSecrets(secrets) } }))
      .rejects.toThrow("the sign-in was for owner@example.com, not agentx-bot@example.com");
  });
});
```

Add to `fakeVendors`'s options `asanaProject?: { name: string } | undefined; asanaRotates?: string`
(use `"asanaProject" in options` to tell "absent" from "undefined"), and methods:

```ts
    async asanaAccessToken() { calls.push("asanaAccessToken"); return { accessToken: "asana-access", ...(options.asanaRotates === undefined ? {} : { refreshToken: options.asanaRotates }) }; },
    async asanaProject({ projectGid }) { calls.push(`asanaProject ${projectGid}`); return "asanaProject" in options ? options.asanaProject : { name: "Payments" }; },
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/contract/setup-connector-asana.test.ts`
Expected: FAIL, "Cannot find module .../setup/connectors/asana.js".

- [ ] **Step 3: Implement the vendor calls**

In `vendors.ts`, add:

```ts
    async asanaAccessToken({ clientId, clientSecret, refreshToken }) {
      const response = await fetchImplementation(OAUTH_AUTHORIZATION_PROFILES.asana.tokenUrl, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }).toString(),
      });
      if (response.status === 400 || response.status === 401) throw new VendorRefused("Asana");
      if (!response.ok) throw agentXError("RUNTIME_UNAVAILABLE", `Asana's token endpoint answered HTTP ${response.status}; try again in a minute`);
      const body = (await response.json()) as { access_token?: unknown; refresh_token?: unknown };
      if (typeof body.access_token !== "string") throw new VendorRefused("Asana");
      return { accessToken: body.access_token, ...(typeof body.refresh_token === "string" && body.refresh_token !== refreshToken ? { refreshToken: body.refresh_token } : {}) };
    },
    async asanaProject({ accessToken, projectGid }) {
      const connection = await connectMcp({ endpoint: new URL(OAUTH_AUTHORIZATION_PROFILES.asana.resource), token: accessToken, tools: ["get_project"], signal: AbortSignal.timeout(30_000), fetchImplementation });
      try {
        const result = await connection.call("get_project", { project_id: projectGid });
        if (result.isError === true) return undefined;
        const text = (result.content ?? []).map((part) => ("text" in part && typeof part.text === "string" ? part.text : "")).join("");
        const name = /"name"\s*:\s*"([^"]{1,200})"/.exec(text)?.[1];
        return { name: name ?? projectGid };
      } finally {
        await connection.close();
      }
    },
```

Asana's `get_project` takes `project_id` (`packages/gateway/src/asana.ts`, the binding comment).

- [ ] **Step 4: Implement the connector**

```ts
// packages/cli/src/setup/connectors/asana.ts
// agentx connector add asana (FR-036 to FR-039), from docs/connectors/asana.md. The bot user signs
// in once (FR-037: no browser is opened, and only --expect-account's sign-in is kept), then the
// test read is get_project as the bot, before the project revision is saved.
import { agentXError, type ConnectorConfig } from "@agentx/contracts";
import { AlertEmailSchema } from "../../deploy/answer-schemas.js";
import { secretFromSource } from "../../init/prompts.js";
import type { SetupServices } from "../services.js";
import { addConnectorRevision, connectorSecretName, scopeAlias, storeConnectorSecret, type ConnectorAddInput } from "./revision.js";

export const ASANA_GUIDE = [
  "Asana: AgentX acts as a bot user that signs in once. An Asana token reaches everything that user sees.",
  "  1. Invite a dedicated bot address (outside your email domain, so it joins as a guest) to the one project, with Editor access.",
  "  2. app.asana.com/0/my-apps: Create new app, type Asana MCP (not External MCP, not an API app).",
  "  3. In the app's settings, add the redirect URL http://localhost:8765/callback exactly.",
  "  4. Manage Distribution: Any workspace (a guest bot signs in through another domain).",
  "  5. Copy the Client ID and the Client secret.",
].join("\n");

export const ASANA_TOOLS: ConnectorConfig["tools"] = [
  { name: "get_task", access: "read" },
  { name: "get_tasks", access: "read" },
  { name: "create_tasks", access: "write" },
  { name: "update_tasks", access: "write" },
  { name: "add_comment", access: "write" },
];

export async function addAsana(input: ConnectorAddInput & { services: ConnectorAddInput["services"] & Pick<SetupServices, "authorize" | "authorizeSecrets"> }): Promise<{ ref: string; revision: number }> {
  input.write(ASANA_GUIDE);
  const clientId = input.flags.asanaClientId ?? await input.prompter.ask("The Asana app's Client ID", { flag: "--asana-client-id", validate: (value) => (/^\d{1,20}$/.test(value.trim()) ? undefined : "the Client ID is digits") });
  const clientSecret = await secretFromSource({ what: "Asana client secret", flag: "--asana-client-secret", source: input.flags.asanaClientSecret ?? {}, processEnv: input.processEnv, prompter: input.prompter });
  const botEmail = input.flags.asanaBotEmail ?? await input.prompter.ask("The bot user's email", { flag: "--asana-bot-email", validate: (value) => (AlertEmailSchema.safeParse(value).success ? undefined : "must be an email address") });

  const secretName = connectorSecretName(input.env, "asana");
  await storeConnectorSecret(input.secrets, secretName, JSON.stringify({ clientId: clientId.trim(), clientSecret }));
  await input.services.authorize({
    controlPlaneUrl: input.session.controlPlaneUrl, accessToken: input.session.accessToken, ref: "asana", secretName, provider: "asana",
    secrets: input.services.authorizeSecrets, expectAccount: botEmail, fetchImplementation: input.services.fetch,
    // FR-037: no openBrowser; the engineer opens the address in a private window as the bot.
    showUrl: (url, redirect) => { input.write(`Sign in as the bot user ${redirect}. Open this address in a private window signed in as ${botEmail}:\n${url}`); },
    showAccount: (line) => { input.write(line); },
  });

  const projectGid = (input.flags.asanaProject ?? await input.prompter.ask("The Asana project's GID (the number after /project/ in its address)", { flag: "--asana-project", validate: (value) => (/^\d{1,20}$/.test(value.trim()) ? undefined : "the GID is digits") })).trim();
  const stored = JSON.parse((await input.services.authorizeSecrets.read(secretName)) ?? "{}") as { clientId?: string; clientSecret?: string; refreshToken?: string };
  if (stored.refreshToken === undefined) throw agentXError("CONFIG_INVALID", `secret ${secretName} has no refresh token after the sign-in; run agentx connector add asana again`);
  const tokens = await input.services.vendors.asanaAccessToken({ clientId: clientId.trim(), clientSecret, refreshToken: stored.refreshToken });
  // The broker also handles rotation; writing it back here keeps the stored token the live one.
  if (tokens.refreshToken !== undefined) await input.services.authorizeSecrets.write(secretName, JSON.stringify({ ...stored, refreshToken: tokens.refreshToken }));
  const project = await input.services.vendors.asanaProject({ accessToken: tokens.accessToken, projectGid });
  if (project === undefined) {
    throw agentXError("CONFIG_INVALID", `the bot user cannot see Asana project ${projectGid}; invite ${botEmail} to that project as a guest with Editor access (docs/connectors/asana.md, Step 1), then run this again`);
  }
  input.write(`The bot user sees the Asana project ${project.name}.`);
  const { revision } = await addConnectorRevision({
    env: input.env, session: input.session, projectName: input.projectName, write: input.write, services: input.services,
    connector: { name: "asana", type: "asana", credentialRef: "asana", scopes: [{ alias: scopeAlias(project.name), projectGid }], tools: ASANA_TOOLS },
  });
  return { ref: "asana", revision };
}
```

`authorizeCredential` itself tags the secret `agentx-writable=refresh-token`, stores the refresh
token beside the client and registers the credential as `oauth-refresh-token`, so this module does
none of those. It binds `127.0.0.1:8765`; the guide's SSH note (`ssh -L 8765:127.0.0.1:8765`)
applies, and Task 15 repeats it in the install guide.

In `services.ts`, add:

```ts
  /** Task 11: the one-time bot sign-in (admin/authorize.ts). */
  authorize: (input: AuthorizeInput) => Promise<unknown>;
  authorizeSecrets: AuthorizeSecrets;
```

and in `setupServices()`, an `authorize` that throws "test setup: authorize not expected" and an
in-memory `authorizeSecrets`.

In `setup/cli.ts`, add `connector add asana` with `--project`, `--asana-client-id`,
`--asana-client-secret-file`, `--asana-client-secret-env`, `--asana-bot-email` and
`--asana-project`, built the same way as the `jira` command, calling `addAsana`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/contract/setup-connector-asana.test.ts tests/contract/credential-authorize.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/setup tests/support/setup-fakes.ts tests/contract/setup-connector-asana.test.ts
git commit -m "feat(setup): agentx connector add asana, with the bot's sign-in and a get_project read"
```

### Task 12: Alerts, `agentx alerts test`, and the connectors and alerts steps

**Files:**
- Create: `packages/cli/src/setup/alerts.ts`
- Modify: `packages/cli/src/setup/services.ts` (`alerts`)
- Modify: `packages/cli/src/setup/cli.ts` (`alerts test`)
- Modify: `packages/cli/src/init/finish-steps.ts` (`connectorsStep`, `alertsStep`)
- Modify: `packages/cli/package.json` (`@aws-sdk/client-sns`, `@aws-sdk/client-cloudwatch`, `@aws-sdk/client-budgets`, all `3.1134.0`)
- Modify: `tests/support/setup-fakes.ts` (`fakeAlerts`)
- Test: `tests/contract/setup-alerts.test.ts`

**Interfaces:**
- Consumes: `InitAnswers.alert`, `InitAnswers.budget`, `BUDGET_TAG_NOTE` (Task 4); `alertWebhookSecretName`; the control plane's `OperatorAlertsTopicArn` output; `addLinear`, `addJira`, `addAsana` (Tasks 9 to 11).
- Produces:

```ts
export interface Subscription { arn: string; protocol: string; endpoint: string }
export interface AlertsApi {
  subscriptions(topicArn: string): Promise<Subscription[]>;
  subscribe(topicArn: string, protocol: "email" | "https", endpoint: string): Promise<void>;
  setAlarmState(alarmName: string, state: "ALARM" | "OK", reason: string): Promise<void>;
  /** True when the alarm's history shows a change to ALARM at or after `since`. */
  wentToAlarm(alarmName: string, since: Date): Promise<boolean>;
  /** DescribeBudget: the monthly limit in dollars, or undefined when there is no such budget. */
  budget(account: string, name: string): Promise<number | undefined>;
}
export function awsAlertsApi(clients: { sns: { send(c: unknown): Promise<unknown> }; cloudWatch: { send(c: unknown): Promise<unknown> }; budgets: { send(c: unknown): Promise<unknown> } }): AlertsApi;
export type AlertTarget = { kind: "email"; address: string } | { kind: "webhook"; endpoint: string; display: string };
export const CONFIRM_WAIT_MS: number; // 10 minutes
export async function ensureSubscribed(input: { api: AlertsApi; topicArn: string; target: AlertTarget; write: (line: string) => void; sleep: (ms: number) => Promise<void>; now: () => number }): Promise<"confirmed" | "pending">;
export async function sendTestAlarm(input: { api: AlertsApi; env: string; shownAs: string; prompter: Prompter; write: (line: string) => void; sleep: (ms: number) => Promise<void>; now: () => number }): Promise<void>;
export function testAlarmName(env: string): string; // agentx-<env>-TestAlarm
// SetupServices gains: alerts: AlertsApi
// finish-steps.ts: connectorsStep(), alertsStep()
```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/contract/setup-alerts.test.ts
import { describe, expect, it } from "vitest";
import { ensureSubscribed, sendTestAlarm, testAlarmName } from "../../packages/cli/src/setup/alerts.js";
import { scriptedPrompter, T0 } from "../support/init-fakes.js";
import { fakeAlerts } from "../support/setup-fakes.js";

const TOPIC = "arn:aws:sns:us-east-1:123456789012:agentx-staging-alerts";
const WEBHOOK = "https://events.pagerduty.com/integration/SECRETKEY123/enqueue";
function clock() { let now = T0; return { now: () => now, sleep: async (ms: number) => { now += ms; } }; }

describe("subscribing the alert address (FR-045)", () => {
  it("subscribes an email once, and waits for the person to confirm it", async () => {
    const api = fakeAlerts({ confirmAfterPolls: 2 });
    const lines: string[] = [];
    expect(await ensureSubscribed({ api, topicArn: TOPIC, target: { kind: "email", address: "ops@example.com" }, write: (line) => lines.push(line), ...clock() })).toBe("confirmed");
    expect(api.subscribed).toEqual(["email ops@example.com"]);
    expect(lines.join("\n")).toContain('AWS sent ops@example.com an email from AWS Notifications; open it and choose "Confirm subscription".');
  });

  it("does not subscribe an address that is already on the topic", async () => {
    const api = fakeAlerts({ existing: [{ arn: `${TOPIC}:1`, protocol: "email", endpoint: "OPS@example.com" }] });
    expect(await ensureSubscribed({ api, topicArn: TOPIC, target: { kind: "email", address: "ops@example.com" }, write: () => undefined, ...clock() })).toBe("confirmed");
    expect(api.subscribed).toEqual([]);
  });

  it("returns pending when nobody confirms within 10 minutes", async () => {
    const api = fakeAlerts({ confirmAfterPolls: 1_000 });
    expect(await ensureSubscribed({ api, topicArn: TOPIC, target: { kind: "email", address: "ops@example.com" }, write: () => undefined, ...clock() })).toBe("pending");
  });

  it("subscribes a webhook without ever printing its address, only its host", async () => {
    const api = fakeAlerts({ confirmAfterPolls: 1 });
    const lines: string[] = [];
    await ensureSubscribed({ api, topicArn: TOPIC, target: { kind: "webhook", endpoint: WEBHOOK, display: "https://events.pagerduty.com/..." }, write: (line) => lines.push(line), ...clock() });
    expect(api.subscribed).toEqual([`https ${WEBHOOK}`]);
    expect(lines.join("\n")).not.toContain("SECRETKEY123");
    expect(lines.join("\n")).toContain("PagerDuty and Opsgenie confirm the subscription on their own");
  });

  it("warns that a generic webhook must confirm the subscription itself", async () => {
    const lines: string[] = [];
    await ensureSubscribed({ api: fakeAlerts({ confirmAfterPolls: 1 }), topicArn: TOPIC, target: { kind: "webhook", endpoint: "https://hooks.example.com/x", display: "https://hooks.example.com/..." }, write: (line) => lines.push(line), ...clock() });
    expect(lines.join("\n")).toContain("A webhook that is not PagerDuty or Opsgenie must confirm the subscription itself");
  });
});

describe("agentx alerts test (FR-046)", () => {
  it("sets the test alarm to ALARM and back to OK, checks its history, then asks", async () => {
    const api = fakeAlerts();
    const prompter = scriptedPrompter([true]);
    await sendTestAlarm({ api, env: "staging", shownAs: "ops@example.com", prompter, write: () => undefined, ...clock() });
    expect(api.states).toEqual([`${testAlarmName("staging")} ALARM`, `${testAlarmName("staging")} OK`]);
    expect(prompter.asked).toEqual(["Did a test alarm named agentx-staging-TestAlarm arrive at ops@example.com?"]);
  });

  it("says what to check when the alarm did not arrive", async () => {
    await expect(sendTestAlarm({ api: fakeAlerts(), env: "staging", shownAs: "ops@example.com", prompter: scriptedPrompter([false]), write: () => undefined, ...clock() }))
      .rejects.toThrow("the test alarm did not arrive; check the subscription is confirmed (aws sns list-subscriptions-by-topic --topic-arn <the agentx-staging-alerts topic>) and your spam folder, then run agentx alerts test");
  });

  it("fails before asking when CloudWatch never recorded the ALARM change", async () => {
    await expect(sendTestAlarm({ api: fakeAlerts({ historyEmpty: true }), env: "staging", shownAs: "x", prompter: scriptedPrompter([]), write: () => undefined, ...clock() }))
      .rejects.toThrow("CloudWatch did not record the test alarm going off");
  });
});
```

`fakeAlerts` in `setup-fakes.ts`:

```ts
export function fakeAlerts(options: { existing?: Array<{ arn: string; protocol: string; endpoint: string }>; confirmAfterPolls?: number; historyEmpty?: boolean; budgetUsd?: number } = {}) {
  const subscribed: string[] = [];
  const states: string[] = [];
  const subscriptions = [...(options.existing ?? [])];
  let polls = 0;
  return {
    subscribed, states,
    async subscriptions() {
      polls += 1;
      return subscriptions.map((entry) => ({ ...entry, arn: entry.arn === "PendingConfirmation" && polls > (options.confirmAfterPolls ?? 0) ? "arn:aws:sns:us-east-1:123456789012:agentx-staging-alerts:1" : entry.arn }));
    },
    async subscribe(_topic: string, protocol: string, endpoint: string) { subscribed.push(`${protocol} ${endpoint}`); subscriptions.push({ arn: "PendingConfirmation", protocol, endpoint }); polls = 0; },
    async setAlarmState(name: string, state: string) { states.push(`${name} ${state}`); },
    async wentToAlarm() { return options.historyEmpty !== true; },
    async budget() { return options.budgetUsd; },
  };
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/contract/setup-alerts.test.ts`
Expected: FAIL, "Cannot find module .../setup/alerts.js".

- [ ] **Step 3: Implement `alerts.ts`**

```ts
// packages/cli/src/setup/alerts.ts
// FR-045 and FR-046: subscribe the alert address to the environment's topic, and send a test alarm
// through CloudWatch (the test alarm in the Slack stack), so PagerDuty and Opsgenie receive a real
// alarm. A webhook address carries its integration key: it is sent to SNS and never printed.
import { DescribeBudgetCommand } from "@aws-sdk/client-budgets";
import { DescribeAlarmHistoryCommand, SetAlarmStateCommand } from "@aws-sdk/client-cloudwatch";
import { ListSubscriptionsByTopicCommand, SubscribeCommand } from "@aws-sdk/client-sns";
import { agentXError } from "@agentx/contracts";
import type { Prompter } from "../init/prompts.js";

export interface Subscription { arn: string; protocol: string; endpoint: string }
export interface AlertsApi {
  subscriptions(topicArn: string): Promise<Subscription[]>;
  subscribe(topicArn: string, protocol: "email" | "https", endpoint: string): Promise<void>;
  setAlarmState(alarmName: string, state: "ALARM" | "OK", reason: string): Promise<void>;
  wentToAlarm(alarmName: string, since: Date): Promise<boolean>;
  budget(account: string, name: string): Promise<number | undefined>;
}
export type AlertTarget = { kind: "email"; address: string } | { kind: "webhook"; endpoint: string; display: string };

export const CONFIRM_WAIT_MS = 10 * 60_000;
const POLL_MS = 15_000;
const SELF_CONFIRMING = /(^|\.)(pagerduty\.com|opsgenie\.com)$/;

export function testAlarmName(env: string): string {
  return `agentx-${env}-TestAlarm`;
}

type Send = { send(command: unknown): Promise<unknown> };
export function awsAlertsApi(clients: { sns: Send; cloudWatch: Send; budgets: Send }): AlertsApi {
  return {
    async subscriptions(topicArn) {
      const all: Subscription[] = [];
      let token: string | undefined;
      do {
        const page = (await clients.sns.send(new ListSubscriptionsByTopicCommand({ TopicArn: topicArn, ...(token === undefined ? {} : { NextToken: token }) }))) as { Subscriptions?: Array<{ SubscriptionArn?: string; Protocol?: string; Endpoint?: string }>; NextToken?: string };
        all.push(...(page.Subscriptions ?? []).map((entry) => ({ arn: entry.SubscriptionArn ?? "", protocol: entry.Protocol ?? "", endpoint: entry.Endpoint ?? "" })));
        token = page.NextToken;
      } while (token !== undefined);
      return all;
    },
    async subscribe(topicArn, protocol, endpoint) {
      await clients.sns.send(new SubscribeCommand({ TopicArn: topicArn, Protocol: protocol, Endpoint: endpoint }));
    },
    async setAlarmState(alarmName, state, reason) {
      await clients.cloudWatch.send(new SetAlarmStateCommand({ AlarmName: alarmName, StateValue: state, StateReason: reason }));
    },
    async wentToAlarm(alarmName, since) {
      const history = (await clients.cloudWatch.send(new DescribeAlarmHistoryCommand({ AlarmName: alarmName, HistoryItemType: "StateUpdate", StartDate: since, MaxRecords: 10 }))) as { AlarmHistoryItems?: Array<{ HistorySummary?: string }> };
      return (history.AlarmHistoryItems ?? []).some((item) => /to ALARM/.test(item.HistorySummary ?? ""));
    },
    async budget(account, name) {
      try {
        const response = (await clients.budgets.send(new DescribeBudgetCommand({ AccountId: account, BudgetName: name }))) as { Budget?: { BudgetLimit?: { Amount?: string } } };
        return Number(response.Budget?.BudgetLimit?.Amount ?? "0");
      } catch (error) {
        if (error instanceof Error && error.name === "NotFoundException") return undefined;
        throw error;
      }
    },
  };
}

const sameEndpoint = (a: string, b: string, kind: AlertTarget["kind"]) => (kind === "email" ? a.toLowerCase() === b.toLowerCase() : a === b);

export async function ensureSubscribed(input: { api: AlertsApi; topicArn: string; target: AlertTarget; write: (line: string) => void; sleep: (ms: number) => Promise<void>; now: () => number }): Promise<"confirmed" | "pending"> {
  const { target } = input;
  const protocol = target.kind === "email" ? "email" : "https";
  const endpoint = target.kind === "email" ? target.address : target.endpoint;
  const find = async () => (await input.api.subscriptions(input.topicArn)).find((entry) => entry.protocol === protocol && sameEndpoint(entry.endpoint, endpoint, target.kind));
  let found = await find();
  if (found === undefined) {
    await input.api.subscribe(input.topicArn, protocol, endpoint);
    if (target.kind === "email") {
      input.write(`AWS sent ${target.address} an email from AWS Notifications; open it and choose "Confirm subscription". Waiting up to 10 minutes.`);
    } else {
      const host = new URL(target.endpoint).host;
      input.write(SELF_CONFIRMING.test(host)
        ? `Subscribed ${target.display}. PagerDuty and Opsgenie confirm the subscription on their own.`
        : `Subscribed ${target.display}. A webhook that is not PagerDuty or Opsgenie must confirm the subscription itself, by opening the SubscribeURL in the first message SNS sends it.`);
    }
    found = await find();
  }
  const deadline = input.now() + CONFIRM_WAIT_MS;
  while (found !== undefined && found.arn === "PendingConfirmation") {
    if (input.now() >= deadline) return "pending";
    await input.sleep(POLL_MS);
    found = await find();
  }
  return "confirmed";
}

export async function sendTestAlarm(input: { api: AlertsApi; env: string; shownAs: string; prompter: Prompter; write: (line: string) => void; sleep: (ms: number) => Promise<void>; now: () => number }): Promise<void> {
  const name = testAlarmName(input.env);
  const since = new Date(input.now() - 1000);
  await input.api.setAlarmState(name, "ALARM", "agentx alerts test: a test alarm, not a real problem");
  input.write(`Sent a test alarm (${name}) to ${input.shownAs}.`);
  await input.sleep(20_000);
  const recorded = await input.api.wentToAlarm(name, since);
  await input.api.setAlarmState(name, "OK", "agentx alerts test: done");
  if (!recorded) throw agentXError("RUNTIME_UNAVAILABLE", `CloudWatch did not record the test alarm going off; check that the ${name} alarm exists in the Slack stack (it needs this AgentX release), then run agentx alerts test`);
  if (!(await input.prompter.confirm(`Did a test alarm named ${name} arrive at ${input.shownAs}?`, { defaultValue: true }))) {
    throw agentXError("CONFIG_INVALID", `the test alarm did not arrive; check the subscription is confirmed (aws sns list-subscriptions-by-topic --topic-arn <the agentx-${input.env}-alerts topic>) and your spam folder, then run agentx alerts test`);
  }
}
```

- [ ] **Step 4: Implement the two init steps**

In `finish-steps.ts`:

```ts
const CONNECTOR_LABELS = { linear: "Linear", jira: "Jira", asana: "Asana" } as const;

export function connectorsStep(): InitStep<InitContext> {
  return {
    id: "connectors",
    title: "Offer the Linear, Jira and Asana connectors",
    async run(context, progress) {
      const project = progress.current().project;
      if (project === undefined) throw agentXError("CONFIG_INVALID", "install progress has no project; the first-project step must finish first, so run agentx init again");
      const done = new Set((progress.current().connectors ?? []).map((entry) => entry.type));
      const wanted = context.flags.connectors === undefined ? undefined : new Set(context.flags.connectors.split(",").map((value) => value.trim()).filter((value) => value !== "" && value !== "none"));
      for (const type of CONNECTOR_TYPES) {
        if (done.has(type)) continue;
        const yes = wanted !== undefined ? wanted.has(type) : await context.prompter.confirm(`Connect ${CONNECTOR_LABELS[type]} to ${project.name} now? (You can add it later with agentx connector add ${type})`, { defaultValue: false });
        if (!yes) continue;
        const session = await context.adminSession();
        const base = { env: context.env, session, projectName: project.name, secrets: context.secrets, prompter: context.prompter, processEnv: context.processEnv, write: context.write, services: context.setup, flags: context.flags };
        const result = type === "linear" ? await addLinear(base) : type === "jira" ? await addJira(base) : await addAsana(base);
        // Owner decision 6: a Jira warning is kept in progress, for 15e's doctor.
        const warning = "warning" in result ? result.warning : undefined;
        await progress.update({ connectors: [...(progress.current().connectors ?? []), { type, ref: result.ref, ...(warning === undefined ? {} : { warning }) }], project: { ...project, revision: result.revision } });
      }
      const connected = (progress.current().connectors ?? []).map((entry) => CONNECTOR_LABELS[entry.type]);
      return { status: "done", note: connected.length === 0 ? "no connectors" : `connected ${connected.join(", ")}` };
    },
  };
}

export function alertsStep(): InitStep<InitContext> {
  return {
    id: "alerts",
    title: "Subscribe alerts, check the budget, and send a test alarm",
    async run(context, progress) {
      const { answers } = context;
      const settings = await requireSettings(context);
      if (answers.budget !== undefined) {
        const limit = await context.setup.alerts.budget(settings.account, `agentx-${context.env}-monthly`);
        if (limit === undefined) throw agentXError("CONFIG_INVALID", `the budget agentx-${context.env}-monthly does not exist; check the control-plane stack's BudgetMonthlyUsd parameter, then run agentx init again`);
        context.write(`Budget agentx-${context.env}-monthly: $${limit} a month.${answers.budget.scope === "tag" ? ` ${BUDGET_TAG_NOTE}` : ""}`);
      }
      if (answers.alert.kind === "none") return { status: "done", note: "no alert address (agentx config set alerts.address, phase 15e)" };
      const recorded = progress.current().alerts ?? { subscribed: false, tested: false };
      const shownAs = answers.alert.kind === "email" ? answers.alert.address : answers.alert.display;
      if (!recorded.subscribed) {
        const outputs = await context.setup.stackOutputs(environmentStackName(context.env, "control-plane"));
        const topicArn = outputs?.OperatorAlertsTopicArn;
        if (topicArn === undefined) throw agentXError("CONFIG_INVALID", "the control-plane stack reports no OperatorAlertsTopicArn; run agentx init again");
        const target: AlertTarget = answers.alert.kind === "email"
          ? { kind: "email", address: answers.alert.address }
          : { kind: "webhook", display: answers.alert.display, endpoint: await requireSecret(context, answers.alert.secretName) };
        const state = await ensureSubscribed({ api: context.setup.alerts, topicArn, target, write: context.write, sleep: context.sleep, now: context.now });
        if (state === "pending") return { status: "waiting", message: `Confirm the alert subscription for ${shownAs} (the AWS Notifications email, or your webhook's SubscribeURL), then run agentx init --env ${context.env} --region ${answers.region} again.` };
        await progress.update({ alerts: { subscribed: true, tested: false } });
      }
      await sendTestAlarm({ api: context.setup.alerts, env: context.env, shownAs, prompter: context.prompter, write: context.write, sleep: context.sleep, now: context.now });
      await progress.update({ alerts: { subscribed: true, tested: true } });
      return { status: "done", note: `alerts to ${shownAs}, test alarm received` };
    },
  };
}

async function requireSecret(context: InitContext, name: string): Promise<string> {
  const value = await context.secrets.get(name);
  if (value === undefined) throw agentXError("CONFIG_INVALID", `secret ${name} is missing; run agentx init with --alert-webhook-file or --alert-webhook-env to store it again`);
  return value;
}
```

Imports to add: `CONNECTOR_TYPES` (`./install-state.js`), `environmentStackName`
(`@agentx/contracts`), `BUDGET_TAG_NOTE` (`./answers.js`), `addLinear`, `addJira`, `addAsana`,
`ensureSubscribed`, `sendTestAlarm`, `AlertTarget`.

Write the step tests too, in `tests/contract/setup-alerts.test.ts`:

```ts
import { alertsStep, connectorsStep } from "../../packages/cli/src/init/finish-steps.js";

describe("the alerts step", () => {
  it("waits, exiting 0, when the email is not confirmed, and resumes at the test alarm", async () => {
    const api = fakeAlerts({ confirmAfterPolls: 1_000 });
    const context = initContext({ setup: setupServices({ alerts: api, stackOutputs: async () => ({ OperatorAlertsTopicArn: TOPIC }) }), prompter: scriptedPrompter([true]) });
    context.store.values.set("/agentx/staging/settings", JSON.stringify(settingsFixture));
    const progress = progressHandle();
    expect(await alertsStep().run(context, progress)).toMatchObject({ status: "waiting" });
    expect(progress.value().alerts).toBeUndefined();
  });

  it("records subscribed before the test alarm, so a failed test does not subscribe twice", async () => {
    const api = fakeAlerts({ confirmAfterPolls: 0 });
    const context = initContext({ setup: setupServices({ alerts: api, stackOutputs: async () => ({ OperatorAlertsTopicArn: TOPIC }) }), prompter: scriptedPrompter([false]) });
    context.store.values.set("/agentx/staging/settings", JSON.stringify(settingsFixture));
    const progress = progressHandle();
    await expect(alertsStep().run(context, progress)).rejects.toThrow("the test alarm did not arrive");
    expect(progress.value().alerts).toEqual({ subscribed: true, tested: false });
  });
});

describe("the connectors step", () => {
  it("records a Jira connector's wider-access warning in the install progress (owner decision 6)", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "agentx-projects-"));
    await writeProjectFile(configDir, {
      name: "payments-api", revision: 1,
      repositories: [{ name: "payments-api", url: "https://github.com/acme/payments-api.git", path: "repo/payments-api", defaultBranch: "main", credentialRef: "github-agentx-sdlc" }],
      setup: [], readiness: [], orchestratorInstructions: "Delegate every repository read, edit, build, and test to the remote AgentX worker.",
    });
    const vendors = fakeVendors({ jiraCloudId: "0f1e2d3c-4b5a-4968-8776-655443322110", jiraInside: ["PAY-1"], jiraOutside: ["HR-4"] });
    const context = initContext({
      prompter: scriptedPrompter([]),
      flags: { connectors: "jira", jiraSite: "acme", jiraProject: "PAY", jiraToken: { envName: "JIRA" } },
      processEnv: { JIRA: `ATATT${"t".repeat(187)}` },
      setup: setupServices({ vendors, configDir, stackOutputs: async () => ({ Ec2WorkerLaunchTemplateId: "lt-0123456789abcdef0", Ec2WorkerSubnets: "us-east-1a=subnet-0aaa1111bbbb2222c" }) }),
      adminSession: async () => ({ controlPlaneUrl: "https://cp.example.test", accessToken: "t" }),
    });
    const progress = progressHandle({ ...progressHandle().value(), project: { name: "payments-api", revision: 1 } });
    await connectorsStep().run(context, progress);
    expect(progress.value().connectors).toEqual([{ type: "jira", ref: "jira", warning: expect.stringContaining("can also see issues in HR") as unknown }]);
    await rm(configDir, { recursive: true, force: true });
  });

  it("connects nothing and asks three times when the engineer says no to each", async () => {
    const prompter = scriptedPrompter([false, false, false]);
    const context = initContext({ prompter });
    const progress = progressHandle({ ...progressHandle().value(), project: { name: "payments-api", revision: 1 } });
    expect(await connectorsStep().run(context, progress)).toEqual({ status: "done", note: "no connectors" });
    expect(prompter.asked).toHaveLength(3);
  });

  it("asks nothing with --connectors none", async () => {
    const context = initContext({ prompter: scriptedPrompter([]), flags: { connectors: "none" } });
    const progress = progressHandle({ ...progressHandle().value(), project: { name: "payments-api", revision: 1 } });
    expect(await connectorsStep().run(context, progress)).toEqual({ status: "done", note: "no connectors" });
  });
});
```

(`settingsFixture` is the `cognitoSettings` object from `setup-admin.test.ts`; copy it, and
import `initContext`, `progressHandle`, `setupServices`, `fakeVendors`, `writeProjectFile`, and
`mkdtemp`, `rm`, `tmpdir` and `join` from Node.)

`setup/cli.ts`, add:

```ts
  program.command("alerts").description("AgentX alerts")
    .command("test")
    .description("send a test alarm to the alert address and ask whether it arrived (FR-046)")
    .action(async (_options: unknown, command: Command) => {
      const run = await context.open(command);
      const shownAs = run.settings.alertAddress ?? "the alert address";
      await sendTestAlarm({ api: run.services.alerts, env: run.env, shownAs, prompter: run.prompter, write: run.write, sleep: run.sleep, now: run.now });
      run.print({ sent: true }, "The test alarm arrived.\n");
    });
```

`alerts test` uses CloudWatch's `SetAlarmState`, which the operator role may do on this alarm
only (Task 1); it needs no admin session, so give `SetupCommandContext` an `openAws(command)`
that skips the sign-in, and use it here.

Add the three SDK clients to `packages/cli/package.json` at `3.1134.0` and run `npm install`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/contract/setup-alerts.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/package.json package-lock.json packages/cli/src/setup packages/cli/src/init/finish-steps.ts tests/support/setup-fakes.ts tests/contract/setup-alerts.test.ts
git commit -m "feat(setup): subscribe alerts, agentx alerts test, and the connectors and alerts steps (FR-045, FR-046)"
```

### Task 13: The end-to-end step, and wiring the finishing steps into `agentx init`

**Files:**
- Modify: `packages/cli/src/init/finish-steps.ts` (`e2eStep`, `finishSteps`, `readyText`)
- Modify: `packages/cli/src/init/commands.ts` (`initSteps`, real `SetupServices`, `adminSession`, the result text)
- Modify: `packages/cli/src/main.ts` (the finishing flags on `init`; the final message)
- Test: `tests/contract/init-finish-steps.test.ts`, `tests/contract/init-cli.test.ts`

**Interfaces:**
- Consumes: every step from Tasks 5, 7, 8 and 12; `waitForThreadedReply` (Task 8); `openAdminSession` (Task 5); the real constructors `cognitoAdmin`, `githubRepositoryApi`, `githubRestApi`, `cloudFormationOutputsReader`, `slackChannelApi`, `slackWebApi`, `vendorApi`, `authorizeCredential`, `secretsManagerAuthorizeSecrets`, `awsAlertsApi`, `loginWithPkce`, `SystemCredentialTokenStore`.
- Produces:

```ts
export function e2eStep(): InitStep<InitContext>;
/** admin-user, first-project, connectors, alerts, e2e, in that order. */
export function finishSteps(): InitStep<InitContext>[];
export function readyText(input: { env: string; controlPlaneUrl: string; progress: InstallProgress }): string;
export function realSetupServices(input: { region: string; fetch: typeof fetch; configDir: string; tokenStore?: TokenStore }): SetupServices;
// InitCliDependencies gains: setup?: Partial<SetupServices>
// InitOptions gains: finishFlags: FinishFlags; configDir: string
// InitResult: nextSteps is replaced by ready?: string
```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/contract/init-finish-steps.test.ts
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { e2eStep, readyText } from "../../packages/cli/src/init/finish-steps.js";
import { emptyProgress } from "../../packages/cli/src/init/install-state.js";
import { initContext, progressHandle, T0, type TestInitContext } from "../support/init-fakes.js";
import { fakeControlPlane, setupServices, turn } from "../support/setup-fakes.js";

let context: TestInitContext | undefined;
afterEach(async () => { if (context !== undefined) await rm(context.home, { recursive: true, force: true }); });

describe("the e2e step (FR-018 step 11)", () => {
  const progress = () => progressHandle({
    ...emptyProgress("staging", T0),
    slack: { appId: "A0APP00001", teamId: "T0123456789", botUserId: "U0BOT00001" },
    project: { name: "payments-api", revision: 1, channelName: "payments", channelId: "C0PAY00001", teamId: "T0123456789" },
  });

  it("finishes when a person's mention gets an answered reply in its thread", async () => {
    const plane = fakeControlPlane();
    plane.turns = [turn({ subject: "T0123456789/C0PAY00001/1790000000.000100", receivedAt: new Date(T0 + 2000).toISOString(), disposition: "answered", durationMs: 12_000 })];
    context = initContext({ setup: setupServices({ fetch: plane.fetch }), adminSession: async () => ({ controlPlaneUrl: "https://cp.example.test", accessToken: "t" }) });
    expect(await e2eStep().run(context, progress())).toEqual({ status: "done", note: "a mention in #payments got a threaded reply in 12 seconds" });
  });

  it("needs the channel from the first-project step", async () => {
    context = initContext();
    await expect(e2eStep().run(context, progressHandle())).rejects.toThrow("install progress has no bound channel; the first-project step must finish first, so run agentx init again");
  });
});

describe("the message init ends with", () => {
  it("says where to talk to AgentX and what to do next", () => {
    const text = readyText({ env: "staging", controlPlaneUrl: "https://cp.example.test", progress: {
      ...emptyProgress("staging", T0),
      slack: { appId: "A0APP00001", teamId: "T0123456789", botUserId: "U0BOT00001" },
      project: { name: "payments-api", revision: 2, channelName: "payments", channelId: "C0PAY00001" },
      connectors: [{ type: "linear", ref: "linear" }],
    } });
    expect(text).toBe([
      "AgentX environment staging is ready.",
      "  Talk to it: mention <@U0BOT00001> in #payments (project payments-api, revision 2).",
      "  Connected: Linear. Add more with agentx --env staging connector add linear|jira|asana --project payments-api.",
      "  More projects: agentx --env staging project add, then agentx --env staging channel add.",
      "  Send a test alarm any time: agentx --env staging alerts test.",
    ].join("\n"));
  });

  it("repeats a connector's warning at the end (owner decision 6)", () => {
    const text = readyText({ env: "staging", controlPlaneUrl: "https://cp.example.test", progress: {
      ...emptyProgress("staging", T0),
      project: { name: "payments-api", revision: 2 },
      connectors: [{ type: "jira", ref: "jira", warning: "the Jira service account can also see issues in HR" }],
    } });
    expect(text).toContain("  Warning (Jira): the Jira service account can also see issues in HR.");
  });
});
```

`init-cli.test.ts`'s existing "lists its steps in the recorded order" test already compares
`initSteps(...)` with `INIT_STEP_IDS`; it fails until `initSteps` includes the finishing steps,
and passes after Step 3. In `tests/contract/init-cli.test.ts`, also change the test that checks
the final output of a complete run: it now ends with `readyText`, not "Next, until agentx init
does these too". The first-run test becomes:

```ts
  it("a first run goes from the questions to a threaded Slack reply", async () => {
    const h = await harness();
    const plane = fakeControlPlane();
    // Received a day later: whatever the run's fake clock reads when the e2e step starts, this counts.
    plane.turns = [turn({ subject: "T0123456789/C0PAY00001/1790000000.000100", receivedAt: new Date(T0 + 86_400_000).toISOString() })];
    const setup = setupServices({
      fetch: plane.fetch,
      repositories: fakeRepositories({ "acme/payments-api": { files: { "go.mod": "module example.com/pay" } } }),
      slackChannels: fakeSlackChannels([{ id: "C0PAY00001", name: "payments", isPrivate: false, isMember: true }]),
      alerts: fakeAlerts({ confirmAfterPolls: 0 }),
      stackOutputs: async (name) => allStackOutputs()[name],
      configDir: await tmp("agentx-projects-"),
    });
    // admin email; repository; project name; use the proposed commands; channel; three connector offers; the test alarm arrived
    const FINISH = ["alice@example.com", "acme/payments-api", "", true, "payments", false, false, false, true];
    const prompter = scriptedPrompter([...FIRST_RUN, ...SLACK, ...SIGNIN, ...FINISH]);
    expect(await h.run([], { prompter, setup })).toBe(0);
    expect(prompter.remaining()).toBe(0);
    expect(plane.registered).toHaveLength(1);
    expect(plane.bindings).toEqual(["T0123456789/C0PAY00001"]);
    expect(h.printed()).toContain("AgentX environment staging is ready.");
    expect(await everywhereButSecrets(h)).not.toContain(TEST_BOT_TOKEN);
  });
```

If the fake Slack app's team id or bot user id differ from `T0123456789` and the channel's
binding path, use the fake's values (`fakeSlackApi` in `init-fakes.ts`). Import
`fakeControlPlane`, `fakeRepositories`, `fakeSlackChannels`, `fakeAlerts`, `setupServices` and
`turn` from `../support/setup-fakes.js`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/contract/init-finish-steps.test.ts tests/contract/init-cli.test.ts`
Expected: FAIL: `e2eStep` is not exported, and `initSteps` stops at `developer-signin`.

- [ ] **Step 3: Implement**

In `finish-steps.ts`:

```ts
export function e2eStep(): InitStep<InitContext> {
  return {
    id: "e2e",
    title: "Check that AgentX answers in Slack",
    async run(context, progress) {
      const { project, slack } = progress.current();
      if (project?.channelId === undefined || project.channelName === undefined || slack === undefined) {
        throw agentXError("CONFIG_INVALID", "install progress has no bound channel; the first-project step must finish first, so run agentx init again");
      }
      const reply = await waitForThreadedReply({
        session: await context.adminSession(), fetch: context.setup.fetch, teamId: slack.teamId, channelId: project.channelId,
        channelName: project.channelName, botUserId: slack.botUserId, write: context.write, sleep: context.sleep, now: context.now,
      });
      return { status: "done", note: `a mention in #${project.channelName} got a threaded reply in ${reply.seconds} seconds` };
    },
  };
}

export function finishSteps(): InitStep<InitContext>[] {
  return [adminUserStep(), firstProjectStep(), connectorsStep(), alertsStep(), e2eStep()];
}

const LABELS = { linear: "Linear", jira: "Jira", asana: "Asana" } as const;

export function readyText(input: { env: string; controlPlaneUrl: string; progress: InstallProgress }): string {
  const { env, progress } = input;
  const cli = `agentx --env ${env}`;
  const project = progress.project;
  const connected = (progress.connectors ?? []).map((entry) => LABELS[entry.type]);
  return [
    `AgentX environment ${env} is ready.`,
    ...(project?.channelName === undefined || progress.slack === undefined ? [] : [`  Talk to it: mention <@${progress.slack.botUserId}> in #${project.channelName} (project ${project.name}, revision ${project.revision}).`]),
    ...(project === undefined ? [] : [`  ${connected.length === 0 ? "No connectors yet." : `Connected: ${connected.join(", ")}.`} Add ${connected.length === 0 ? "one" : "more"} with ${cli} connector add linear|jira|asana --project ${project.name}.`]),
    // Owner decision 6: a connector saved with a warning says so again at the end.
    ...(progress.connectors ?? []).filter((entry) => entry.warning !== undefined).map((entry) => `  Warning (${LABELS[entry.type]}): ${entry.warning!}.`),
    `  More projects: ${cli} project add, then ${cli} channel add.`,
    `  Send a test alarm any time: ${cli} alerts test.`,
  ].join("\n");
}
```

(`readyText` does not use `controlPlaneUrl` today; keep the field, since `--json` callers get
it, or drop it from the signature and the test together.)

In `commands.ts`:

```ts
export function initSteps(input: { github: GitHubApi; slack: SlackApi }): InitStep<InitContext>[] {
  return [
    // ...the eight 15d1 and 25a steps, unchanged
    developerSignInStep({ slack: input.slack }),
    ...finishSteps(),
  ];
}

export function realSetupServices(input: { region: string; fetch: typeof fetch; configDir: string; tokenStore?: TokenStore }): SetupServices {
  const secretsClient = new SecretsManagerClient({ region: input.region });
  return {
    tokenStore: input.tokenStore ?? new SystemCredentialTokenStore(),
    cognito: cognitoAdmin(new CognitoIdentityProviderClient({ region: input.region })),
    login: loginWithPkce,
    fetch: input.fetch,
    repositories: githubRepositoryApi(input.fetch),
    github: githubRestApi(input.fetch),
    stackOutputs: cloudFormationOutputsReader(new CloudFormationClient({ region: input.region })),
    configDir: input.configDir,
    slackChannels: slackChannelApi(input.fetch),
    slackIdentity: async (token) => {
      const answer = await slackWebApi(input.fetch).authTest(token);
      if (answer.ok !== true || answer.team_id === undefined || answer.user_id === undefined) throw agentXError("CONFIG_INVALID", "Slack refused the stored bot token; run agentx init again to store a new one");
      return { teamId: answer.team_id, botUserId: answer.user_id };
    },
    vendors: vendorApi(input.fetch),
    authorize: authorizeCredential,
    authorizeSecrets: secretsManagerAuthorizeSecrets(secretsClient),
    alerts: awsAlertsApi({ sns: new SNSClient({ region: input.region }), cloudWatch: new CloudWatchClient({ region: input.region }), budgets: new BudgetsClient({ region: "us-east-1" }) }),
  };
}
```

AWS Budgets is a global service answered from `us-east-1`; that is why its client names the
region.

In `init()`, build the services and the session once, before `context`:

```ts
  const setup: SetupServices = { ...realSetupServices({ region, fetch: fetchImplementation, configDir: options.configDir }), ...deps.setup };
  const adminClaim = answers.identity.mode === "oidc" ? { claim: answers.identity.adminClaim, values: answers.identity.adminValues } : undefined;
  const adminSession = async () => {
    const settings = await readEnvironmentSettings(store, env);
    if (settings === undefined) throw agentXError("CONFIG_INVALID", `environment ${env} has no settings yet; the Slack service step must finish first, so run agentx init again`);
    return openAdminSession({
      settings, services: setup, write, now,
      ...(options.browser ? { openBrowser: neverThrowingBrowser(deps.openBrowser ?? openSystemBrowser, write) } : {}),
      ...(adminClaim === undefined ? {} : { adminClaim }),
    });
  };
```

and add `setup`, `adminSession` and `flags: options.finishFlags` to `context`. Real clients are
only constructed, never called, until a step uses them, so tests that pass `deps.setup` reach no
AWS.

Replace the end of `init()`'s success path:

```ts
    const progress = result.status === "complete" ? await readInstallProgress(store, env) : undefined;
    return {
      ...result, env, resumed: stored !== undefined,
      ...(settings === undefined ? {} : { controlPlaneUrl: settings.controlPlaneUrl }),
      ...(settings === undefined || progress === undefined ? {} : { ready: readyText({ env, controlPlaneUrl: settings.controlPlaneUrl, progress }) }),
    };
```

Delete `nextStepsText` and its test: its three manual steps (admin-create-user and
admin-add-user-to-group, login, project register and slack bind) are the steps this phase
automates.

In `main.ts`'s `init` command, add the finishing flags:

```ts
    .option("--admin-email <email>", "Cognito: your email, for the AgentX admin user")
    .option("--repository <owner/name>", "the first project's repository")
    .option("--project-name <name>", "the first project's name (default: the repository's)")
    .option("--setup-command <command>", "the first project's setup command, or \"\" for none")
    .option("--test-command <command>", "the first project's test command, or \"\" for none")
    .option("--channel <name>", "the Slack channel for the first project")
    .option("--connectors <list>", "connectors to add now: comma-separated linear, jira, asana, or none")
    .option("--linear-key-file <path>").option("--linear-key-env <NAME>").option("--linear-team <id or key>")
    .option("--jira-site <site>").option("--jira-project <key>").option("--jira-token-file <path>").option("--jira-token-env <NAME>")
    .option("--asana-client-id <id>").option("--asana-client-secret-file <path>").option("--asana-client-secret-env <NAME>")
    .option("--asana-bot-email <email>").option("--asana-project <gid>")
```

Give each of the last five lines' options a description, as the other `init` options have. Build
`finishFlags` in `initOptions` with `definedEntries<FinishFlags>`, using `secretSource` for the
three secrets, and pass `configDir: globals.configDir`. The final message becomes:

```ts
        services.stdout.write(`${result.ready ?? `AgentX environment ${result.env} is deployed. Control plane: ${result.controlPlaneUrl ?? "unknown"}`}\n`);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/contract/init-finish-steps.test.ts tests/contract/init-cli.test.ts tests/contract/init-steps.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole gate once**

Run: `npm run typecheck && npm run lint && npm run build && npm test && npm run infra:synth`
Expected: PASS. Fix what fails in the task that owns it, with its test first.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src tests/contract/init-finish-steps.test.ts tests/contract/init-cli.test.ts
git commit -m "feat(init): run the finishing steps and end on a threaded Slack reply (FR-018 steps 7 to 11)"
```

### Task 14: The export path's resume, and the operator role

**Files:**
- Modify: `packages/cli/src/deploy/export-bundle.ts` (`init-answers.json`; the README's operator command)
- Modify: `packages/cli/src/deploy/commands.ts` (`runInitExport` passes the bundle answers)
- Modify: `packages/cli/src/init/commands.ts` (`--from-bundle`; the operator check on `access`)
- Modify: `packages/cli/src/init/answers.ts` (`collectInitAnswers` takes fixed answers)
- Modify: `packages/cli/src/main.ts` (`--from-bundle <dir>`; the `--env production` rule)
- Test: `tests/contract/export-bundle.test.ts`, `tests/contract/init-cli.test.ts`, `tests/contract/init-answers.test.ts`

**Interfaces:**
- Consumes: `writeExportBundle`, `runInitExport` (15c2); `collectInitAnswers`, `persistInitAnswers`, `writeInstallProgress`, `emptyProgress`; `environmentOperatorRoleName`; `StackStatusReader`.
- Produces:

```ts
// export-bundle.ts
export const BundleAnswersSchema: z.ZodType<BundleAnswers>;
export type BundleAnswers = Pick<InitAnswers, "schemaVersion" | "env" | "region" | "account" | "engine" | "releaseVersion" | "identity" | "models" | "permissionsBoundaryArn" | "operatorPrincipalArn">;
export async function readBundleAnswers(dir: string): Promise<BundleAnswers>;
// answers.ts: collectInitAnswers(input & { fixed?: BundleAnswers }) asks only what `fixed` lacks
// commands.ts
export function isOperatorRole(callerArn: string, env: string): boolean;
// InitOptions gains: fromBundle?: string
```

- [ ] **Step 1: Write the failing tests**

In `tests/contract/export-bundle.test.ts`:

```ts
  it("writes the answers the export knows, with no secret, for init --resume --from-bundle", async () => {
    const result = await writeExportBundle({ dir, answers, release });
    expect(result.files).toContain("init-answers.json");
    const saved = JSON.parse(await readFile(join(dir, "init-answers.json"), "utf8"));
    expect(saved).toEqual({
      schemaVersion: 1, env: "staging", region: "us-east-1", account: "123456789012", engine: "templates",
      releaseVersion: release.manifest.version, identity: { mode: "cognito" }, models: answers.models,
    });
    expect(await readBundleAnswers(dir)).toEqual(saved);
  });

  it("tells the operator to finish with init --resume --from-bundle", async () => {
    await writeExportBundle({ dir, answers, release });
    const readme = await readFile(join(dir, "README.md"), "utf8");
    expect(readme).toContain("agentx init --resume --env staging --region us-east-1 --from-bundle <this directory>");
    expect(readme).not.toContain("agentx deploy --mode install --parts");
  });
```

(`dir`, `answers` and `release` are that file's existing fixtures. If the file already asserts
the old `agentx deploy --mode install --parts` line in the README or `deploy-access.sh`, change
that assertion to the new command; the script's comment changes too.)

In `tests/contract/init-cli.test.ts`:

```ts
// The bundle's answers, as writeExportBundle writes them (Task 14's export-bundle test pins that).
async function bundleDir(overrides: Record<string, unknown> = {}): Promise<string> {
  const dir = await tmp("agentx-bundle-");
  await writeFile(join(dir, "init-answers.json"), JSON.stringify({
    schemaVersion: 1, env: "staging", region: "us-east-1", account: "123456789012", engine: "templates", releaseVersion: "1.2.3",
    identity: { mode: "cognito" }, models: { orchestrator: "us.anthropic.claude-sonnet-4-6", classifier: "amazon.nova-lite-v1:0", worker: "amazon.nova-pro-v1:0" },
    ...overrides,
  }));
  return dir;
}
const OPERATOR = "arn:aws:sts::123456789012:assumed-role/agentx-staging-operator/alice";
// A bundle resume asks only: alert kind, alert email, budget, budget scope, GitHub account, account
// type, app name, Slack app name, app-posted messages; then the plan.
const BUNDLE_RUN = ["", "ops@example.com", "", "", "acme", "", "", "", "", true];

describe("init --resume --from-bundle (FR-026)", () => {
  it("asks only what the export did not know, records access as done, and goes on with core", async () => {
    const h = await harness();
    const dir = await bundleDir();
    h.deployer.fail.set(environmentStackName("staging", "foundation"), new Error("stop after access"));
    const prompter = scriptedPrompter(BUNDLE_RUN);
    const code = await h.run(["--resume", "--from-bundle", dir], {
      prompter, stackStatus: { status: async (name) => (name === "agentx-staging-access" ? "CREATE_COMPLETE" : undefined) },
      deploy: { ...h.deps.deploy, identity: { get: async () => ({ account: "123456789012", arn: OPERATOR }) } },
    });
    expect(code).not.toBe(0);
    expect(h.printed()).toContain("stop after access");
    expect(prompter.remaining()).toBe(0);
    expect(prompter.asked).not.toContain("Deploy engine");
    const progress = await readInstallProgress(h.store, "staging");
    expect(progress?.steps.access).toMatchObject({ status: "done", note: "deployed by your platform team from the export bundle" });
    expect(progress?.steps.prerequisites?.status).toBe("done");
    expect(h.deployer.requests.map((request) => request.part)).toEqual(["foundation"]);
  });

  it("refuses when the platform team has not deployed the access stack yet", async () => {
    const h = await harness();
    const code = await h.run(["--resume", "--from-bundle", await bundleDir()], { prompter: scriptedPrompter([]), stackStatus: { status: async () => undefined } });
    expect(code).not.toBe(0);
    expect(h.printed()).toContain("the access stack agentx-staging-access does not exist yet; ask your platform team to run deploy-access.sh from the bundle, then run this again");
  });

  it("refuses a bundle for another account", async () => {
    const h = await harness();
    const code = await h.run(["--resume", "--from-bundle", await bundleDir({ account: "999999999999" })], { prompter: scriptedPrompter([]), stackStatus: { status: async () => "CREATE_COMPLETE" } });
    expect(code).not.toBe(0);
    expect(h.printed()).toContain("the bundle is for account 999999999999, but your AWS credentials are for account 123456789012");
  });
});

describe("the access step under the operator role (FR-019)", () => {
  it("refuses with what to ask the platform team, instead of failing on IAM", async () => {
    const h = await harness();
    const operator = { ...h.deps.deploy, identity: { get: async () => ({ account: "123456789012", arn: OPERATOR }) } };
    // A first run as the operator: answers are saved, prerequisites pass, then access refuses.
    const code = await h.run([], { prompter: scriptedPrompter([...FIRST_RUN_WITH_BUDGET]), deploy: operator });
    expect(code).not.toBe(0);
    expect(h.printed()).toContain("the access stack needs admin rights, and you are using the AgentX operator role; ask your platform team to deploy it (agentx init --export, then deploy-access.sh), or run agentx init with admin credentials");
    expect(h.deployer.requests).toEqual([]);
  });
});

describe("init --export and production (spec decision, 2026-09-27)", () => {
  it("writes a bundle for production when nothing is installed there", async () => {
    const h = await harness();
    const out = await tmp("agentx-export-");
    const code = await executeCli(["--env", "production", "init", "--export", join(out, "bundle"), "--region", "us-east-1", "--release", h.release, "--account", "123456789012"], { deploy: { store: new MemoryParameterStore() }, stdout: { write: () => true }, stderr: { write: () => true } });
    expect(code).toBe(0);
  });

  it("refuses production when SSM already holds its settings", async () => {
    const h = await harness();
    const store = new MemoryParameterStore();
    store.values.set("/agentx/production/settings", "{}");
    const err: string[] = [];
    const out = await tmp("agentx-export-");
    const code = await executeCli(["--env", "production", "init", "--export", join(out, "bundle"), "--region", "us-east-1", "--release", h.release, "--account", "123456789012"], { deploy: { store }, stdout: { write: () => true }, stderr: { write: (text: string) => err.push(text) } });
    expect(code).not.toBe(0);
    expect(err.join("")).toContain("environment production is already installed in this account; export a bundle for a new --env");
  });
});
```

This needs two small changes to the file's `harness`: return `deps` (so a test can build on
`h.deps.deploy`), and a `FIRST_RUN_WITH_BUDGET` constant, which is `FIRST_RUN` with `""` and `""`
(the $100 budget and its `tag` scope) inserted after `"ops@example.com"`. Task 4 already changed
`FIRST_RUN` that way; if it did, use `FIRST_RUN` here. `readEnvironmentSettings` parses the
`"{}"` seeded above and fails; the check must treat any value at `/agentx/production/settings` as
installed, so use `store.get(settingsParameterName(env))` rather than `readEnvironmentSettings`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/contract/export-bundle.test.ts tests/contract/init-cli.test.ts`
Expected: FAIL: no `init-answers.json`, no `--from-bundle`, production refused outright.

- [ ] **Step 3: Implement the bundle answers**

In `export-bundle.ts`, extend `ExportBundleInput` with `bundleAnswers: BundleAnswers`, and write it
next to the README:

```ts
    await write("init-answers.json", `${JSON.stringify(input.bundleAnswers, null, 2)}\n`);
```

```ts
export const BundleAnswersSchema = z.object({
  schemaVersion: z.literal(1), env: EnvironmentNameSchema, region: z.string().regex(REGION_PATTERN), account: z.string().regex(ACCOUNT_PATTERN),
  engine: z.literal("templates"), releaseVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  identity: IdentityAnswersSchema, models: ModelsAnswersSchema,
  permissionsBoundaryArn: z.string().optional(), operatorPrincipalArn: z.string().optional(),
}).strict();

export async function readBundleAnswers(dir: string): Promise<BundleAnswers> {
  let json: unknown;
  try { json = JSON.parse(await readFile(join(dir, "init-answers.json"), "utf8")); } catch {
    throw agentXError("CONFIG_INVALID", `${dir} has no readable init-answers.json; pass the bundle agentx init --export wrote`);
  }
  const parsed = BundleAnswersSchema.safeParse(json);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", `${dir}/init-answers.json is invalid: ${parsed.error.issues[0]?.path.join(".") ?? ""} ${parsed.error.issues[0]?.message ?? ""}`.trim());
  return parsed.data as BundleAnswers;
}
```

A bundle is always the templates engine (the platform team deploys templates). In `runInitExport`,
build `bundleAnswers` from the export's own `answers` and `release.manifest.version`.

Replace `operatorResumeCommand` with:

```ts
function operatorResumeCommand(env: string, region: string): string {
  return `agentx init --resume --env ${env} --region ${region} --from-bundle <this directory>`;
}
```

and use it in `deployAccessScript`'s comment and the README's "After this stack exists"
section, whose text becomes: "The AgentX operator then runs, with the operator role, from a
machine with a browser: `<command>`. It deploys every other stack through the
`agentx-<env>-cloudformation` role, creates the GitHub and Slack apps, the admin user, the first
project and channel, and the alerts, and ends when AgentX answers in Slack."

- [ ] **Step 4: Implement `--from-bundle` and the operator check**

In `answers.ts`, `collectInitAnswers` takes `fixed?: BundleAnswers`. When given, it skips the
engine, identity, model, boundary and operator-principal questions and uses `fixed`'s values; it
still asks the alert, budget, GitHub and Slack questions. In `init()` (`commands.ts`), before the
existing `stored === undefined` branch:

```ts
  const bundle = options.fromBundle === undefined ? undefined : await readBundleAnswers(options.fromBundle);
  if (bundle !== undefined) {
    if (!options.resume) throw agentXError("CONFIG_INVALID", "--from-bundle goes with --resume");
    if (bundle.env !== env) throw agentXError("CONFIG_INVALID", `the bundle is for environment ${bundle.env}; pass --env ${bundle.env}`);
    if (bundle.account !== caller.account) throw agentXError("CONFIG_INVALID", `the bundle is for account ${bundle.account}, but your AWS credentials are for account ${caller.account}`);
    if (bundle.releaseVersion !== release.manifest.version) throw agentXError("CONFIG_INVALID", `the bundle is for release ${bundle.releaseVersion}; run npx @charterarc/agentx@${bundle.releaseVersion} init --resume --from-bundle ${options.fromBundle}`);
    const accessStack = environmentStackName(env, "access");
    const status = await context.stackStatus.status(accessStack);
    if (status === undefined || !/_COMPLETE$/.test(status) || status.startsWith("ROLLBACK") || status.startsWith("DELETE")) {
      throw agentXError("CONFIG_INVALID", status === undefined
        ? `the access stack ${accessStack} does not exist yet; ask your platform team to run deploy-access.sh from the bundle, then run this again`
        : `the access stack ${accessStack} is ${status}; ask your platform team to fix it (see the bundle's README, "If it fails"), then run this again`);
    }
  }
```

(Read `stackStatus` from `deps.stackStatus ?? cloudFormationStatusReader(...)` here, before
`context` exists.) With a bundle and no stored answers, the `--resume` refusal ("there is no
install of environment ... to resume") does not apply: the bundle is what is resumed.
`collectInitAnswers` then runs with `fixed: bundle`, the plan is shown and confirmed as on a first
run, and `saveAnswers` also records the platform team's access stack:

```ts
      if (bundle !== undefined) {
        const progress = (await readInstallProgress(store, env)) ?? emptyProgress(env, now());
        await writeInstallProgress(store, { ...progress, steps: { ...progress.steps, access: { status: "done", at: new Date(now()).toISOString(), note: "deployed by your platform team from the export bundle" } } });
      }
```

The OpenRouter key: a bundle's models carry `openRouter.secretArn` when the export was given
`--openrouter-secret-arn`; `--export` refuses a key file, so nothing new is stored here.

For the operator check, in `commands.ts`:

```ts
export function isOperatorRole(callerArn: string, env: string): boolean {
  return new RegExp(`:assumed-role/${environmentOperatorRoleName(env)}/`).test(callerArn);
}
```

and in `initSteps`, wrap the access step so it refuses first:

```ts
    {
      ...deployStep({ id: "access", title: "Deploy the access stack (IAM roles, artifact bucket, image cache)" }),
      async run(context, progress) {
        if (isOperatorRole(context.holder, context.env)) {
          throw agentXError("CONFIG_INVALID", "the access stack needs admin rights, and you are using the AgentX operator role; ask your platform team to deploy it (agentx init --export, then deploy-access.sh), or run agentx init with admin credentials");
        }
        return deployStep({ id: "access", title: "Deploy the access stack (IAM roles, artifact bucket, image cache)" }).run(context, progress);
      },
    },
```

The runner turns the error into `init stopped at "Deploy the access stack ...": ...`, which still
contains the tested sentence.

In `main.ts`, add `.option("--from-bundle <dir>", "with --resume: continue an install whose access stack a platform team deployed from this export bundle")`,
pass `fromBundle`, and replace the two `--export` production checks with one read-only check,
after `--region` is known:

```ts
      if (options.export !== undefined) {
        const store = dependencies.deploy?.store ?? ssmParameterStore(new SSMClient({ region: options.region }));
        if ((await store.get(settingsParameterName(globals.env))) !== undefined) {
          throw agentXError("CONFIG_INVALID", `environment ${globals.env} is already installed in this account; export a bundle for a new --env`);
        }
      }
```

keeping the "requires an explicit --env" refusal, so a bundle is never written for the silent
default.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/contract/export-bundle.test.ts tests/contract/init-cli.test.ts tests/contract/init-answers.test.ts tests/contract/deploy-cli.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src tests/contract/export-bundle.test.ts tests/contract/init-cli.test.ts tests/contract/init-answers.test.ts
git commit -m "feat(init): init --resume --from-bundle under the operator role; export production when it is free (FR-019, FR-026)"
```

### Task 15: Documentation and the spec

**Files:**
- Modify: `docs/architecture-production.md` ("Installing with agentx init"; `docs/` is gitignored, so `git add -f`)
- Modify: `docs/connectors/linear.md`, `docs/connectors/jira.md`, `docs/connectors/asana.md`
- Modify: `specs/015-installer/spec.md` (Decisions; FR-041's wording)
- Modify: `specs/015-installer/plans/README.md` (the 15d2 row)

- [ ] **Step 1: The install guide, under 60 more lines, in plain words**

In "Installing with agentx init":
- Extend the numbered step list with `developer-signin` (8, spec 025) and the five new steps:
  9. **admin-user**: Cognito creates your admin user from your email and emails a temporary
     password; a browser opens the AgentX sign-in page (127.0.0.1:8765, so over SSH forward that
     port). Your own OIDC provider: sign in; your token must carry the admin claim.
  10. **first-project**: pick a repository the GitHub App sees; confirm or edit the proposed setup
      and test commands; the project runs on EC2 workers; pick its Slack channel (a private one
      needs `/invite @<bot>`).
  11. **connectors**: Linear, Jira and Asana are each offered; say no to add them later.
  12. **alerts**: confirm the AWS Notifications email (a PagerDuty or Opsgenie address confirms on
      its own); a test alarm is sent and you are asked whether it arrived.
  13. **e2e**: mention the bot in the channel; init ends when AgentX replies in the thread.
- The budget question, `--budget` and `--budget-scope`, and the cost-allocation tag note
  (`BUDGET_TAG_NOTE`'s words).
- The finishing flags (`--admin-email`, `--repository`, `--channel`, `--connectors`, the connector
  flags), so `--yes` still needs no prompt.
- Where the project file lives (`~/.agentx/projects/<name>.yaml`) and that `connector add` builds
  the next revision from it.
- The day-2 commands: `agentx project add`, `channel add`, `connector add linear|jira|asana`,
  `alerts test`.
- The export path: the platform team runs `deploy-access.sh`; the operator runs
  `agentx init --resume --env <env> --region <region> --from-bundle <dir>` with the operator role.
- Delete the paragraph "Until a later AgentX release adds them to init (phase 15d2), finish the
  install by hand".

- [ ] **Step 2: The connector guides**

At the top of each of the three guides, add one paragraph: "`agentx connector add <type> --project
<name>` walks you through this guide, reads the credential from a hidden prompt, tests it, and
registers the project's next revision. The steps below are what it does, for doing it by hand or
understanding it." In `jira.md`, say that the command runs Step 8's inside and outside check
itself, and reword Step 8 to match owner decision 6 (2026-09-28): `inside` must still be more than
0; when `outside` is more than 0, AgentX still saves the connector, warns you with the other
projects it found (up to 5, then "and N more"), and warns that it will be able to read issues in
them. Keep Step 4's advice to narrow the account, and replace "Do not register the project until
`outside` is 0" with "Narrow the account until `outside` is 0 if AgentX must not read those
projects; `agentx init` keeps the warning, and `agentx doctor` shows it again". In `asana.md`, say that the command signs the bot in with `--no-browser` and
`--expect-account` already set. Change each guide's secret name examples to
`agentx/<env>/connectors/<name>` for a named environment, keeping `agentx/connectors/` for the
legacy one. Replace the Linear guide's `--runtime-arn <runtime ARN> --deployment-mode <mode>` with
`--deployment-mode ec2-ebs --launch-template-id <Ec2WorkerLaunchTemplateId> --subnets
<Ec2WorkerSubnets>` (the AgentCore flags are gone since #134).

- [ ] **Step 3: The spec's Decisions**

Under Decisions, add these entries, each dated 2026-09-28 and marked "phase 15d2 plan; owner
decision" with "accepted" or "changed" as below. They carry the owner's exact answers:
- **The finishing steps run after developer sign-in.** The order is FR-018's steps 1 to 6, then
  `developer-signin` (spec 025 FR-044), then steps 7 to 11. The new step ids are appended to
  `INIT_STEP_IDS`, so resume never re-runs a done step.
- **Cognito scoping for the operator role (accepted).** `cognito-idp:AdminCreateUser`,
  `AdminGetUser` and `AdminAddUserToGroup` on `userpool/*`, with `aws:ResourceTag/agentx:env`
  equal to the environment, proven with the IAM policy simulator in the live check; the fallback is
  the exact pool ARN. The operator role also gains subscribe and list on the environment's alert
  topic, `SetAlarmState` on the test alarm only, `budgets:ViewBudget` on the environment's budget,
  and `servicequotas:GetServiceQuota`.
- **The budget filters on the `agentx:env` tag by default (accepted),** with a warning that it
  reads $0 until the tag is activated and the exact Billing step to activate it (Billing, Cost
  allocation tags); `--budget-scope account` is for a dedicated account.
- **`agentx alerts test` (accepted)** flips a CloudWatch test alarm, so PagerDuty and Opsgenie get a
  real alarm. It checks that the subscription is confirmed and that the alarm's history shows
  `ALARM`, then asks the engineer. No SNS delivery-status logging.
- **The budget lives in CloudFormation (accepted),** in the control-plane stack, answered with the
  other questions; the service role gains `budgets` permissions.
- **Project files stay at `~/.agentx/projects/<name>.yaml` (accepted),** as `admin project register
  --file` takes them.
- **A Jira service account that can see other projects is warned about and saved, not refused
  (changed).** The warning names the other projects it can see (up to 5, then "and N more"), says
  AgentX will be able to read issues in them, and suggests narrowing the account. Under `--yes` it
  saves with the same warning printed. `init` records the warning in the install progress
  (`connectors[].warning`) so `agentx doctor` (15e) can show it. An account that finds no issue in
  the connected project is still refused.
- **Connector test reads:** Linear lists the key's teams; Jira searches inside the project (must
  find an issue) and outside it (warns, as above); Asana reads the project with `get_project` as the
  bot; then the registration preflight must report `connected`.
- **FR-041's test message is posted by a person (accepted).** The engineer mentions the bot and the
  CLI watches turn records for the threaded reply. Change FR-041's text to: "`agentx channel add`
  MUST bind a channel to a project, invite the bot (or wait for a person to invite it to a private
  channel), and ask the engineer to mention the bot, then wait for a threaded reply."
- **FR-050, for phase 15e:** add "each connector's saved warning (for example, a Jira account that
  can see other projects)" to `doctor`'s checks.
- Under the existing "init step order follows the deploy order" decision, add one sentence:
  "Spec 025's `developer-signin` runs after step 6."
- Note, without changing them, that FR-014 (`instances-ebs`) and FR-015 (AgentCore Runtime) are
  superseded by the scope amendment and should be reworded in phase 15e.

- [ ] **Step 4: The plans README**

The plan's own commit already changed the 15d2 row to "(plan)" with the renumbered FR-018 steps.
Once this phase is built, change "(plan)" to "(built, PR #<number>)" and add "the budget, the
operator-role additions and `init --resume --from-bundle`" to "What it delivers".

- [ ] **Step 5: Commit**

```bash
git add -f docs/architecture-production.md docs/connectors/linear.md docs/connectors/jira.md docs/connectors/asana.md
git add specs/015-installer/spec.md specs/015-installer/plans/README.md
git commit -m "docs: agentx init to a Slack reply; connector add in the guides; decisions from phase 15d2"
```

### Task 16: Live install of a throwaway environment to a Slack reply (owner present)

This task changes no code unless it finds a defect. A defect is fixed with a failing test first,
then reviewed. It needs:
- the owner's explicit go-ahead;
- an admin AWS session for the first run (`aws login --profile agentx-admin` on the owner's
  machine, driven from this session), because the access stack creates IAM roles;
- a test GitHub organization, a test Slack workspace, and, for the connector checks, a test Linear
  workspace, a test Jira site and a test Asana workspace, all chosen by the owner. Never
  production's GitHub App, Slack app, Linear key, Jira service account or Asana app.

It uses two new environment names, `live15e2e` (the interactive run) and `live15exp` (the export
path), in account 944937319445, `us-east-1`. It never touches a production stack,
`/agentx/production/*`, or any production app or credential.

- [ ] **Step 1: Prepare (read-only)**
  - Build a release with a plain version: `npm run release:build -- --version 0.0.3 --out <scratch>/rel`.
    It has no image digests, so the run uses the testing-only image flags, with production's
    current digests read from the stack parameters, as in 15d1's Task 13 Step 1.
  - Confirm neither environment exists:
    `aws ssm get-parameters-by-path --path /agentx/live15e2e --recursive --region us-east-1` and
    the same for `live15exp` return no parameters.
  - Check the EC2 vCPU quota (`L-1216C47A`) allows at least one worker instance.
  - Prove owner decision 1 with the policy simulator, since root cannot assume the operator role
    (owner memory): after the access stack exists in Step 3, run
    `aws iam simulate-principal-policy --policy-source-arn <agentx-live15e2e-operator ARN> --action-names cognito-idp:AdminCreateUser --resource-arns <the live pool ARN> --context-entries Key=aws:ResourceTag/agentx:env,Values=live15e2e,Type=string`.
    Expected: `allowed`. With `Values=other`, expected: `implicitDeny`. If the first is not
    allowed, stop and take the fallback in owner decision 1 to the owner.

- [ ] **Step 2: Owner approval**

Ask the owner to approve. Tell them:
- the six stacks per environment, the GitHub and Slack apps, the Cognito admin user, one EC2
  worker instance during the reply, the SNS subscription, the $10 budget used for the test, and the
  connector credentials in the test vendor accounts;
- the running cost while it exists (about $3 a day per environment, from 15d1's figures, plus the
  worker instance while it runs);
- that everything is torn down at the end.

- [ ] **Step 3: The interactive run, as admin**

Run (built CLI):
`node packages/cli/dist/main.js --env live15e2e init --region us-east-1 --release <scratch>/rel --worker-image <digest ref> --slack-image <digest ref> --budget 10`

Take the defaults, except: the alert address (the owner's email); the GitHub and Slack test
accounts; the admin email (the owner's); the test repository; a new public channel
`#agentx-live15`; connectors: say yes to Linear, Jira and Asana in turn, with the test accounts.
Record:
- every step's start and end time, and every click or paste (SC-002 counts at most 15 for the
  install without connectors; count connector actions separately);
- the Cognito email arriving, and the first sign-in's new-password page;
- the proposed setup and test commands for the test repository;
- the Jira inside and outside counts, and, if the test service account can see a second project,
  the warning's exact text (owner decision 6) and that it appears again at the end of init and in
  `/agentx/live15e2e/install/progress`;
- the Asana "Signed in to Asana as" line and project name;
- the AWS Notifications email, and the test alarm's arrival (email subject and time);
- the time from the mention to the threaded reply.

- [ ] **Step 4: Prove resume and "changes nothing"**
  - During the `connectors` step (at the Asana sign-in), close the terminal. Run the same command
    again. Expected: the lock is offered for takeover; `admin-user` and `first-project` are "already
    done"; Linear and Jira are not asked again; Asana is offered again.
  - After it finishes, run the command a third time. Expected: every step is "already done", no
    new project revision is registered (check `agentx --env live15e2e admin credential list` and
    the project file's `revision`), and no second Cognito email arrives.

- [ ] **Step 5: The operator role on the same environment**

Give the operator role a session (the owner assumes `agentx-live15e2e-operator` from an IAM
principal allowed by `--operator-principal`, or uses the policy simulator for each action if no
such principal exists). Run, as the operator:
- `agentx --env live15e2e project add` for a second test repository, then
  `agentx --env live15e2e channel add --project <it> --channel agentx-live15-b`, mentioning the
  bot when asked;
- `agentx --env live15e2e alerts test`.
Expected: both succeed; CloudTrail shows no `AccessDenied` for the operator role during them.

- [ ] **Step 6: The export path**

- As admin: `node packages/cli/dist/main.js --env live15exp init --export <scratch>/bundle --region us-east-1 --release <scratch>/rel --account 944937319445 --operator-principal <the owner's operator principal ARN>`.
- As admin, playing the platform team: `<scratch>/bundle/deploy-access.sh --yes`.
- As the operator role only:
  `node packages/cli/dist/main.js init --resume --env live15exp --region us-east-1 --from-bundle <scratch>/bundle --release <scratch>/rel --worker-image <digest ref> --slack-image <digest ref> --budget 0 --connectors none`,
  with a second test Slack app and GitHub App name, and channel `#agentx-live15-exp`.
- Expected: `access` shows "deployed by your platform team from the export bundle"; every other
  step runs under the operator role; the run ends on a threaded reply.

- [ ] **Step 7: Verify**
  - `aws cloudwatch describe-alarms --alarm-name-prefix agentx-live15e2e- --region us-east-1` lists
    the seven alarms, and none is in `ALARM` after the test.
  - `aws budgets describe-budget --account-id 944937319445 --budget-name agentx-live15e2e-monthly`
    shows $10.
  - Every secret under `agentx/live15e2e/` carries the tag `agentx:env=live15e2e`
    (`aws secretsmanager describe-secret`).
  - Neither `~/.agentx/` (including `projects/`) nor the saved terminal logs contain `xoxb-`, the
    Linear key, the Jira token, the Asana client secret, a refresh token, the webhook key or an
    access token. Check with `grep -r` for each value's first 12 characters.
  - The Bedrock throttling alarm's `ModelId` dimension: in the CloudWatch console, check whether
    `AWS/Bedrock InvocationThrottles` lists the `us.anthropic.claude-sonnet-4-6` inference-profile
    id as a `ModelId`. Record the answer; if it does not, open an issue for the dimension.

- [ ] **Step 8: Tear down both environments**

Give the owner these commands, run under the admin session, for `<env>` in `live15e2e` and
`live15exp`:
1. **Stop the workers first.** EC2 worker instances and volumes are launched by Step Functions,
   outside CloudFormation. List and terminate instances tagged `agentx:env=<env>`, then delete
   volumes with that tag once they are `available`:
   `aws ec2 describe-instances --filters Name=tag:agentx:env,Values=<env> Name=instance-state-name,Values=pending,running,stopping,stopped --query "Reservations[].Instances[].InstanceId" --output text --region us-east-1`,
   `aws ec2 terminate-instances --instance-ids <ids> --region us-east-1`, then
   `aws ec2 describe-volumes --filters Name=tag:agentx:env,Values=<env> --query "Volumes[].VolumeId" --output text --region us-east-1` and
   `aws ec2 delete-volume --volume-id <id> --region us-east-1` for each.
2. Turn termination protection off on `agentx-<env>-access`, `-foundation`, `-identity`,
   `-runtime`, `-control-plane` and `-slack`:
   `aws cloudformation update-termination-protection --no-enable-termination-protection --stack-name <stack> --region us-east-1`.
3. Delete the stacks in reverse order, waiting for each: slack, runtime, control-plane, identity,
   foundation, access.
   `aws cloudformation delete-stack --stack-name <stack> --region us-east-1 && aws cloudformation wait stack-delete-complete --stack-name <stack> --region us-east-1`.
   Deleting the control-plane stack deletes the budget and the SNS topic, and with it the topic's
   subscriptions.
4. Remove what the stacks retain. Named environments use RetainExceptOnCreate, so a resource
   created by a successful deploy is kept on stack deletion:
   - the Cognito user pool (turn deletion protection off, then delete; this deletes the admin
     user);
   - the buckets: empty every version and delete marker, then delete (the artifact bucket, the
     control plane's artifacts bucket, the thread-sessions bucket);
   - the DynamoDB tables, including the turn records table;
   - the log groups under `/agentx/<env>/` and those named for the stacks;
   - the KMS keys: schedule deletion, 7 days;
   - the default boundary policy, if left behind.
5. Force-delete the secrets, each with
   `aws secretsmanager delete-secret --secret-id <name> --force-delete-without-recovery --region us-east-1`:
   `agentx/<env>/callback-signing-key`, `agentx/<env>/github-app`, `agentx/<env>/slack`,
   `agentx/<env>/alert-endpoint` (if created), `agentx/<env>/openrouter` (if created),
   `agentx/<env>/connectors/linear`, `agentx/<env>/connectors/jira`,
   `agentx/<env>/connectors/asana`, and any developer sign-in secret the `developer-signin` step
   created (list them with `aws secretsmanager list-secrets --filters Key=name,Values=agentx/<env>/`).
6. Delete the parameters: every name `aws ssm get-parameters-by-path --path /agentx/<env> --recursive`
   returns (settings, install answers and progress, developer sign-in settings, the worker image,
   the lock if present), with `aws ssm delete-parameters --names ...`.
7. If the budget was created account-wide or outlived its stack, delete it:
   `aws budgets delete-budget --account-id 944937319445 --budget-name agentx-<env>-monthly`.
8. Delete the local files: `~/.agentx/projects/<each test project>.yaml`, the environment cache
   under `~/.agentx/`, and the stored admin token (`agentx --env <env> logout --admin` before the
   stacks go, or delete the Keychain entry afterwards).
9. In the vendors: delete both GitHub Apps (settings, Advanced, Delete GitHub App) and both Slack
   apps (api.slack.com/apps, Basic Information, Delete App); revoke the Linear key; revoke the Jira
   API token and delete the test service account; delete the Asana app and remove the bot user
   from the test project.
10. Confirm: `aws cloudformation list-stacks --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE --region us-east-1`
    shows no `agentx-live15e2e-*` or `agentx-live15exp-*` stack;
    `aws ssm get-parameters-by-path --path /agentx/<env> --recursive` shows nothing;
    `aws secretsmanager list-secrets --filters Key=name,Values=agentx/<env>/` shows nothing
    (force-deleted secrets can take a few minutes to leave the list); and
    `aws ec2 describe-volumes --filters Name=tag:agentx:env,Values=<env>` shows nothing.

- [ ] **Step 9: Record the evidence**

Record the commands, outcomes, timings, the click-and-paste counts, the simulator results, the
Bedrock dimension answer, and every defect fixed, in the PR description. Record anything that
changes a decision above as a finding for the owner, before the PR is merged.

## Not in this phase

In phase 15e:
- `agentx upgrade`, `config` (including `alerts.address`, `alerts.slowTurnMinutes` and the budget),
  `doctor` (including the alert subscription and budget checks FR-050 lists, and showing each
  connector's saved warning from the install progress, owner decision 6) and `destroy`, which
  must also remove the connector secrets, the project files' environment, and worker instances
  and volumes;
- rewording FR-014 and FR-015 for EC2;
- the legacy deployment's upgrade path, which must not pass the Slack stack's new
  `OperatorAlertsTopicArn` parameter to a legacy template.

Later:
- a control-plane route that returns a registered project definition, so project files need not
  live on disk;
- SNS delivery-status logging for `alerts test`.

## Self-review

- **Spec coverage.** FR-018 step 7: Task 5. Step 8: Tasks 6 and 7 (FR-040). Step 9: Tasks 9 to 12
  (FR-036 to FR-039). Step 10: Tasks 3, 4 and 12 (FR-045 to FR-047). Step 11: Tasks 8 and 13.
  FR-019's operator resume: Tasks 1 and 14. FR-021's claim check: Task 5. FR-026's export resume:
  Task 14. FR-041: Task 8. FR-047's tag on every resource: 15a for the stacks, Task 2 for the
  secrets the CLI creates. The scope amendment (ec2-ebs, `Ec2WorkerLaunchTemplateId`,
  `Ec2WorkerSubnets`): Task 7. The EC2 quota check under the operator role: Task 1. OpenRouter:
  the Bedrock throttling alarms are conditional on the provider (Task 3), and the teardown lists
  `agentx/<env>/openrouter` (Task 16). The spec's "export refuses production only when installed"
  decision: Task 14.
- **Placeholders.** None of "TBD", "TODO" or "similar to Task N" remain. Where a step depends on a
  name in an existing file this plan could not quote exactly (a test fixture's name, a `describe`
  title), it says which file to read and what to match.
- **Type consistency.** `SetupServices` grows by task: `tokenStore`, `cognito`, `login`, `fetch`
  (5); `repositories`, `github` (6); `stackOutputs`, `configDir` (7); `slackChannels`,
  `slackIdentity` (8); `vendors` (9 to 11); `authorize`, `authorizeSecrets` (11); `alerts` (12).
  `realSetupServices` (13) fills every one. `ProgressPatch` (2) covers every fact the steps write.
  `ConnectorAddInput` (9) is used unchanged by Tasks 10 to 12. `FinishFlags` (5) holds every flag
  Tasks 7 to 13 read.
- **Review Focus.** Each of the five lines has a test in its task: 1 and 2 in Task 5, 3 and 4 in
  Task 8, 5 in Task 6.
- **Owner decision 6, re-checked (2026-09-28).** Everything the change touches:
  - Task 2: `connectors[].warning` (at most 300 characters) in `InstallProgressSchema`, with a
    round-trip test;
  - Task 10: `addJira` no longer refuses on outside issues, returns `warning`, prints it as
    `Warning: ...`, never prompts (so `--yes` behaves the same), and still refuses when nothing is
    found inside; `jiraSearch` takes `maxResults` (5 inside, 50 outside); `projectKeys` and
    `widerAccessWarning` have their own tests, including the 5-then-"and N more" rule and the
    300-character cap;
  - Task 12: the connectors step writes the warning into progress, with a test;
  - Task 13: `readyText` repeats it, with a test;
  - Task 15: the Jira guide's Step 8 and the spec decision;
  - Task 16: the live check records the warning if the test account sees a second project.

  No other task reads the outside search. The warning is built only from project keys, so it
  cannot carry a secret into progress or output. `widerAccessWarning`'s result fits the 300
  characters the schema allows: 5 keys of at most 10 characters plus the fixed text come to about
  290, and the function cuts at 300 as a guard.
