# Phase 15d2: `agentx init` From the Admin User to a Slack Reply (Outline)

**Status:** outline. The full plan, in the same format as
[phase-15d1-init-deploy-apps.md](phase-15d1-init-deploy-apps.md), is written after 15d1 merges, so
it builds on what actually landed. Branch `feat/015d2-init-finish`, cut from mainline after 15d1
merges. Never stack it on the 15d1 branch.

**Goal:** `agentx init` finishes the job that 15d1 starts. After the Slack service is deployed,
it:
- creates the admin user and signs in;
- sets up the first project and channel;
- offers the Linear, Jira and Asana connectors;
- subscribes the alert address, creates the alarms and the budget, and sends a test alarm;
- ends when a person's message in the channel gets an AgentX reply in its thread.

`init --resume` completes all of this under the narrow operator role, including after a platform
team deployed the export bundle.

**Spec:**
- FR-018 steps 6 to 10;
- FR-019's operator-role resume;
- FR-021's admin-claim check for your own OIDC provider;
- FR-026's `init --resume` after an export;
- FR-036 to FR-041;
- FR-045 to FR-047.

**Depends on:**
- phase 15d1 merged;
- issue #61's optional `siteUrl` on the Jira scope merged, for the Jira guide (task 6);
- the owner's answers to 15d1's open questions.

**New steps**, appended to `INIT_STEP_IDS` after `slack-service`: `admin-user`, `first-project`,
`connectors`, `alerts`, `e2e`. The runner, install state, prompts and secret sources from 15d1 are
reused unchanged.

## Task outline

1. **Operator-role additions and the export resume.**
   - Extend `operatorRoleStatements`:
     - `sns:Subscribe`, `sns:Publish` and `sns:ListSubscriptionsByTopic` on
       `agentx-<env>-alerts`;
     - `budgets:ViewBudget` and `budgets:ModifyBudget` on `budget/agentx-<env>-*`;
     - `cognito-idp:AdminCreateUser`, `AdminAddUserToGroup` and `AdminGetUser` on the
       environment's user pool, through a resource-tag condition. Check that Cognito supports
       `aws:ResourceTag` for these actions; if not, use the pool ARN from the identity stack's
       output, passed to the access stack.
   - Add the access-policy tests.
   - `init --export` also writes `init-answers.json` (non-secret `InitAnswers`) into the bundle.
     `agentx init --resume --from-bundle <dir>` stores it in SSM, checks the access stack exists,
     records `access` as done, and continues. The bundle README's operator command becomes
     `agentx init --resume --env <env> --from-bundle <dir>`.
   - The runner refuses an admin-only step (access) under the operator role with "ask your
     platform team to deploy the access stack (deploy-access.sh)".
2. **The admin user and login (step 6).**
   - Cognito: `AdminCreateUser` with the engineer's email (Cognito emails a temporary password),
     `AdminAddUserToGroup agentx-admin`, then `loginWithPkce`. The first sign-in sets a new
     password.
   - Your own OIDC provider: `loginWithPkce`, then check the token carries `adminClaim` with one
     of `adminValues` (FR-021). Refuse, saying which claim is missing.
3. **`agentx project add` and the first-project step (step 7, FR-040).**
   - List the repositories the installation sees.
   - Read `package.json`, `pyproject.toml`, `Makefile`, `go.mod` and `Cargo.toml` through the
     contents API, and propose setup and test commands for the engineer to confirm or edit.
   - Build the `ProjectDefinition`, and call `registerProject` with the runtime binding from the
     runtime and foundation outputs.
4. **`agentx channel add` (FR-041).**
   - Find the channel by name (`conversations.list`, with the `channels:read` and `groups:read`
     scopes 15d1 already requests).
   - A public channel: `conversations.join`. A private channel: tell the engineer to
     `/invite @<bot>`, then poll `conversations.info` until the bot is a member.
   - Then `bindSlackChannel`.
5. **`agentx connector add linear`.**
   - The guide: a personal API key limited to the team.
   - Read the key from a hidden prompt, file or environment variable. Store it in
     `agentx/<env>/connectors/linear`, then `registerCredential` it as `static-secret`.
   - Test it with one real read (list the key's teams), let the engineer pick the team, and save
     the scope as a new project revision (FR-038, FR-039).
6. **`agentx connector add jira`.**
   - The guide, from `docs/connectors/jira.md`:
     - Rovo MCP API-token authentication turned on;
     - a service account with the Jira User role, restricted to its projects;
     - an API token with the six scopes, against the `/v2` endpoint.
   - Ask for the site URL, and derive `cloudId` from `https://<site>.atlassian.net/_edge/tenant_info`.
   - Save `siteUrl` on the scope (#61).
   - Test with one project search, then pick the project key.
7. **`agentx connector add asana`.**
   - The guide:
     - an Asana MCP app;
     - Manage Distribution set to "Any workspace";
     - redirect `http://localhost:8765/callback`;
     - a dedicated bot user that can see only the project.
   - Store the app's client in the secret. Sign the bot in once with `authorizeCredential`
     (PKCE), with `--no-browser` as the default and `--expect-account <bot email>`.
   - Test with one read of the project, then pick the project GID.
8. **Alerts (step 9, FR-045, FR-046).**
   - Add the missing alarms to the control-plane and Slack stacks: turn errors, turns slower than
     `alerts.slowTurnMinutes` (default 5), failed Slack deliveries, checker failures and Bedrock
     throttling. Create them only under environment naming, so the legacy templates stay
     byte-identical.
   - Subscribe the address: email, or the webhook read back from `agentx/<env>/alert-endpoint`.
   - `agentx alerts test` publishes a test alarm, and init asks whether it arrived.
   - Write `alertAddress` to settings, showing only the host for a webhook.
   - SNS https subscriptions must be confirmed. PagerDuty and Opsgenie confirm on their own; a
     generic webhook does not. Say so.
9. **The budget (step 9, FR-047).**
   - An AWS budget filtered on the `agentx:env` tag, alerting the topic. The topic policy must
     allow `budgets.amazonaws.com`.
   - Cost-allocation tags must be activated in Billing, which needs billing rights and takes up
     to 24 hours to take effect. Offer the tag filter with that warning, or an account-wide
     budget in a dedicated account.
   - Tag the secrets the CLI creates with `agentx:env`.
10. **The end-to-end check (step 10).**
    - Ask the engineer to mention the bot in the bound channel. The ingress never answers a bot,
      so the CLI cannot post the test message itself.
    - Watch `agentx admin turns export --since 5m` through the control plane for that turn, and
      confirm a threaded reply was posted.
    - No Slack history scope is needed.
11. **Docs:** the install guide's remaining steps, and the connector guides pointing at
    `agentx connector add`.
12. **Live check (owner present):** a throwaway environment from `agentx init` to a Slack reply,
    then `init --resume` under the operator role, then the export path, then teardown. It uses
    the same teardown as 15d1's Task 13, plus the connector secrets, the budget and the SNS
    subscriptions.

## Questions its full plan must settle

- Cognito resource scoping for the operator role (task 1).
- Budget by tag, or account-wide, when the cost-allocation tag is not yet active (task 9).
- Whether `agentx alerts test` confirms by prompt only, or can also read the subscription's
  delivery status.
