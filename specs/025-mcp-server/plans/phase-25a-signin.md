# Phase 25a: Developer Sign-In and Project Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A developer runs `agentx login <url>`, signs in with Slack or the company's OIDC provider
in the browser, and the control plane issues them AgentX tokens that a second API Gateway JWT
authorizer accepts on `/v1/dev/*`; `agentx whoami` and `GET /v1/dev/projects` show which projects
they may use (admin grants, or membership of a bound Slack channel). Admins choose the methods in
`agentx init` or later with `agentx signin enable|disable|show|check`. The constitution is amended
to 3.0.0 first. (Built as 4.0.0: mainline took 3.0.0 for the EC2-only runtime before this merged.)

**Architecture:**
- **One new Lambda, `DeveloperIdentity`, is the sign-in server** behind `ANY /v1/auth/{proxy+}`
  (no authorizer). It serves the OAuth 2.1 authorization code flow with PKCE for the one public
  client `agentx-cli`, exchanges the Slack or company code server side with the client secret from
  Secrets Manager, checks the Slack team or the required claim, and issues:
  - a 1-hour access token, a JWT signed by a new KMS key that only this function may use;
  - a 7-day rotating refresh token, stored only as a SHA-256 hash, in a new `DeveloperSignIn`
    DynamoDB table (with a TTL).
- **It is the only new reader of the Slack secret.** It holds the Slack client secret (FR-010) and
  the bot token for `users.info`, `users.lookupByEmail` and `conversations.members`. The broker
  still never reads the Slack secret: it asks `DeveloperIdentity` for channel membership through a
  direct Lambda invoke (`{ kind: "channel-members" }`), and the function caches member lists for
  at most 10 minutes.
- **A second JWT authorizer** (issuer `<api-endpoint>/v1/auth`, audience `agentx-developer`) guards
  the new route `ANY /v1/dev/{proxy+}`, which goes to the broker. The broker checks issuer,
  audience, method and the sign-in session again on every request, and serves
  `GET /v1/dev/projects`. The admin authorizer and `ANY /{proxy+}` are untouched.
- **All of it exists only in named environments** (`naming.env !== undefined`). The legacy
  production templates stay byte-identical.
- **The CLI:**
  - `agentx login <url>`, `whoami`, `logout` for developers; tokens go in the existing system token
    store, the environment's URL in `~/.agentx/developer.yaml`;
  - `agentx signin show|enable|disable|check` for admins under the operator role. They change
    control-plane stack parameters with a parameter-only change set, and record the choice in SSM
    (`/agentx/<env>/signin`, `/agentx/<env>/slack/teamId`), which every later deploy reads back;
  - a last `agentx init` step, `developer-signin`, that runs the same code.

**Tech Stack:** TypeScript 5.9 strict (`exactOptionalPropertyTypes` on), Node 22.19 to 22.x, Zod 4,
Vitest, `jose` 6.2.12 (already a broker dependency; ID token and test verification only), AWS SDK v3
3.1134.0 (`@aws-sdk/client-kms`, `client-dynamodb`, `lib-dynamodb`, `client-secrets-manager`,
`client-cloudformation`; new in the broker: `@aws-sdk/client-lambda`), AWS CDK (`aws-apigatewayv2`
L1, `aws-kms`, `aws-dynamodb`, `aws-lambda-nodejs`), commander 15, `node:http` (loopback listener),
`node:crypto`.

**Spec:** [../spec.md](../spec.md). Phase 25a delivers exactly the phase README's row:
- FR-001 to FR-013 (sign-in server, providers, tokens, team ID, refresh checks, developer record,
  the second authorizer, sign-in settings, the CLI commands, the Slack link, project access);
- FR-015 (developer sign-in never grants admin);
- FR-044 to FR-046 (the `init` step, `signin` commands, the checks FR-046 gives `doctor`);
- FR-048 (the API version in `agentx-configuration`; the CLI's major-version check at login);
- FR-050 (the constitution amendment);
- User Story 4, and `GET /v1/dev/projects` from FR-016.

The phase map is in [README.md](README.md).

**Branch:** `feat/025a-signin` in `/Users/abhishekgarg/web/AgentX-s025`, on mainline `451000d`
(phase 15d1 merged) plus the approved spec commits. One PR, against `mainline`. No stacked PRs.

## Decisions recorded by this plan

Each ruling is written into the code by the task named. The ones marked **(owner)** are also in
Open questions, because they change or interpret the spec's text.

- **R1. Access tokens are RS256, not ES256 (owner).** FR-005 says ES256, but API Gateway's HTTP API
  JWT authorizer supports only RSA algorithms ("Currently, only RSA-based algorithms are
  supported", API Gateway developer guide, *Control access to HTTP APIs with JWT authorizers*).
  FR-009 requires that authorizer. The KMS key is `RSA_2048`, `SIGN_VERIFY`, signing with
  `RSASSA_PKCS1_V1_5_SHA_256`. Everything else in FR-005 holds. Task 3.
- **R2. `DeveloperIdentity` reads the Slack secret (owner).** FR-002 and FR-010 put the Slack client
  secret in `agentx/<env>/slack`, and FR-007, FR-012 and FR-013 need the bot token, so the sign-in
  server must read it. The spec's Testing line "only the notifier, the ingress and the orchestrator
  role can read the Slack secret" becomes "the ingress, the orchestrator role and
  `DeveloperIdentity` (and in 25c the notifier)". The broker still cannot read it (D11). Task 8.
- **R3. Named environments only.** Every new resource, parameter and environment variable is
  created only when `naming.env !== undefined`. The legacy templates, and so production, do not
  change. Bringing sign-in to production needs production moved to environment naming or an
  explicit owner decision; neither is in this phase. Task 8.
- **R4. Bare `agentx login` stays the admin login (owner).** FR-011 names `agentx login <url>` for
  developers and `agentx login --admin` for admins. Existing scripts, docs and tests
  (`environment-cli.test.ts`, `cli-execution.test.ts`) run bare `agentx login` as the admin login,
  and FR-042 says admin commands keep working unchanged. So: a URL means developer sign-in;
  `--admin` or no URL means today's admin login. `login <url> --admin` is refused. Task 10.
- **R5. No `doctor` yet: `agentx signin check` runs FR-046's checks.** `doctor` is phase 15e and
  does not exist. `checkDeveloperSignIn()` is exported so 15e's `doctor` calls it unchanged. The
  check also compares the live `agentx-configuration` with the stored settings. Task 12.
- **R6. The team ID reaches the control plane by a parameter-only update.** `agentx init` deploys
  the control plane before the Slack app exists (the app's manifest needs the control plane's
  URLs), so `SlackTeamId` cannot be known at that deploy. The `developer-signin` step and
  `agentx signin enable|disable` run a CloudFormation change set with `UsePreviousTemplate` and
  `UsePreviousValue` for every other parameter. Tasks 9 and 13.
- **R7. Sign-in settings live in SSM and every deploy reads them back.**
  - `/agentx/<env>/signin`: JSON, no secret: the methods, the company issuer, client ID, required
    claim and values, display name, and the client secret's name;
  - `/agentx/<env>/slack/teamId`: the team ID (FR-006's path).

  `deployEnvironment` reads both when the answers do not carry them, so an `agentx deploy` or an
  `init` re-run never resets sign-in to the template defaults. Task 9.
- **R8. The template defaults are "sign-in off".** `DeveloperSignInSlack` defaults to `disabled`
  and `DeveloperOidcIssuer` to empty. Slack is the default *choice* in `init` and `signin enable`
  (FR-010), not the template default, so a control plane deployed before the Slack app is set up
  never offers a half-configured Slack sign-in. Task 8.
- **R9. The `developer-signin` step is the last `init` step**, after `slack-service`. FR-044 says
  "after the Slack app step", and the last position also means the environment settings exist, so
  the step runs the same code as `agentx signin enable`. An environment installed before 25a gets
  the step on its next `agentx init` run, because the runner skips done steps. Task 13.
- **R10. The Slack manifest always carries sign-in's redirect URL and scopes.** The redirect URL
  `<api>/v1/auth/callback/slack`, the user scopes `openid`, `email` and `profile`, and the bot
  scopes `users:read.email` and `im:write` are in every new manifest, whether or not Slack sign-in
  is chosen. Adding scopes later forces a reinstall (the 15d1 reasoning). An app created before 25a
  is updated by hand. The `developer-signin` step and `signin check` read the bot scopes from
  `auth.test`'s `x-oauth-scopes` header and say exactly what is missing. Tasks 11 and 12.
- **R11. The Slack app step keeps the sign-in keys.** Re-running it (a new bot token) merges into
  `agentx/<env>/slack` instead of replacing it, so `clientId` and `clientSecret` survive. Task 11.
- **R12. Access tokens carry `sid`, and the broker checks the session on every request.** FR-005
  lists `sub`, `amr` and `env`; the JWT also carries `iss`, `aud`, `iat`, `nbf`, `exp`, `jti` and
  `sid` (the sign-in session). With `sid`, the broker refuses a revoked or ended session at once,
  instead of up to an hour later. This is how "a reused refresh token revokes the whole session"
  and "disabling a method revokes its sessions" (FR-045) take effect at once. `amr` is a string
  (`slack` or `oidc`), as FR-005 writes it, not RFC 8176's array: API Gateway turns array claims
  into strings before the broker sees them. Tasks 3 and 7.
- **R13. Disabling a method revokes by method, with no table scan.** The broker refuses any token
  whose `amr` is a disabled method, and the token endpoint refuses, and marks revoked, any refresh
  of such a session. The operator role has no DynamoDB rights, so this needs none. Tasks 6 and 7.
- **R14. `POST /v1/auth/revoke` (RFC 7009) is added for `logout` (owner).** FR-001's route list does
  not name it, but without it `agentx logout` would leave a valid 7-day session behind. It sits
  under the same `/v1/auth/{proxy+}` route, so no infrastructure is added. Task 6.
- **R15. `GET /v1/dev/projects` carries the developer summary.** `whoami` needs the name, method and
  Slack link, and the spec has no `/v1/dev/me`. The response is
  `{ developer, projects, notices }`. The "task policy" FR-016 mentions is FR-014 (phase 25b) and is
  added to each project there. Task 7.
- **R16. Until 25b, `channelMembersMayUse` is treated as true.** FR-013 reads it, but FR-014 (the
  `developerTasks` settings) is phase 25b. `resolveDeveloperAccess` takes a
  `channelMembersMayUse(project)` callback, which 25a wires to `() => true`. Task 7.
- **R17. Grants are read, not created.** A grant is a `MEMBER#<developerId>` / `PROJECT#<name>`
  record (FR-013). The route that creates one is phase 25e (`agentx_admin_grant_project_access`).
  25a reads grants and tests them with seeded records. Any role counts (`developer` or
  `administrator`), so a person who is both admin and developer under the same OIDC issuer is not
  locked out. Task 7.
- **R18. Slack down fails closed, but never logs anyone out.**
  - At sign-in: Slack sign-in fails with a "try again" page.
  - At a Slack developer's refresh: the token endpoint answers 503 `temporarily_unavailable`, keeps
    the session and does not rotate. The CLI keeps the refresh token and says so.
  - In `GET /v1/dev/projects`: granted projects are listed, channel-based ones are not, and
    `notices` holds `slack_unavailable`.
  - At a company sign-in: the Slack link keeps its previous value.

  Tasks 6, 7 and 10.
- **R19. Refreshes on one machine are serialized.** Refresh rotation plus reuse detection means two
  processes refreshing with the same token at once revoke the session. `developerAccessToken`
  takes a lock file (`~/.agentx/locks/developer-<env>.lock`) and re-reads the token store after
  taking it. Task 10.
- **R20. The CLI checks the login URL's configuration before trusting it.** The authorization, token
  and revocation endpoints must share the URL's origin. The API version's major number must match
  the CLI's. The CLI binds its loopback listener on port 0. Task 10.
- **R21. `agentx env adopt` records the team ID when it can (FR-006).** After writing settings it
  reads the control plane's Slack secret, calls `auth.test` and writes `/agentx/<env>/slack/teamId`.
  A failure is reported in one line and never fails the adopt. No test runs it against
  production. Task 11.
- **R22. Slack's `users.info` team check accepts Enterprise Grid members of the environment's team.**
  A refresh passes when the user is not deleted, not a bot, and `user.team_id` is the team or
  `user.enterprise_user.teams` contains it. Sign-in itself still accepts only the ID token's own
  `https://slack.com/team_id` (the spec's Grid edge case). Task 5.
- **R23. The `developer-signin` step asks its own questions.** It does not add to the up-front
  answers or the cost plan: the step records its outcome in `/agentx/<env>/signin`, and a failed
  run asks again. Each question also has a flag. Task 13.

## Open questions for the owner

Each has the plan's recommended answer. The plan is written to the recommendation, and Task 14
records the answers in the spec once confirmed.

1. **ES256 in FR-005 (R1).** *Recommended:* RS256 with a KMS `RSA_2048` key; amend FR-005.
2. **The Slack secret readers (R2).** *Recommended:* amend the Testing line to name
   `DeveloperIdentity`.
3. **Bare `agentx login` (R4).** *Recommended:* stays the admin login; `login <url>` is the
   developer login; amend FR-011's wording.
4. **`POST /v1/auth/revoke` (R14).** *Recommended:* add it to FR-001's route list.
5. **SC-008 ("existing CLI suites pass with no change to their assertions").** Three existing
   assertions list things 25a must add to. Each is updated by appending, never weakened:
   - `cli-main.test.ts`: the root command list gains `logout`, `whoami` and `signin` (FR-011,
     FR-045);
   - `init-install-state.test.ts`: `INIT_STEP_IDS` gains `developer-signin` (FR-044);
   - `init-slack-app.test.ts`: the manifest gains the redirect URL, user scopes and two bot scopes
     (FR-044).

   `init-cli.test.ts`'s scripted runs also gain the new step's answers. *Recommended:* accept these
   updates and read SC-008 as "no weakened or removed assertion".
6. **The constitution waits for Pratik.** The spec's Decisions say FR-050's amendment "waits for his
   answer". *Recommended:* Task 1 commits the amendment on this branch; the PR does not merge until
   Pratik has confirmed in writing, and the PR description links his answer.
7. **Production.** R3 keeps production unchanged. *Recommended:* confirm that sign-in on production
   waits for a separate decision.

## Global Constraints

- **The live deployment does not change.** With no `agentxEnv`, templates are byte-identical
  (`tests/contract/legacy-templates.test.ts`). Never run vitest with `-u`. No test and no step of
  the live check touches production's stacks, `/agentx/production/*`, production's Slack app or its
  secrets.
- **No test reaches AWS, Slack, GitHub or a company IdP.** Every client is injected. The only real
  network use in tests is the CLI's loopback listener on `127.0.0.1`.
- **Never printed, logged, stored in SSM or local files, or put in an error message:** the Slack
  client secret, the company client secret, the Slack bot token, the KMS private key (never leaves
  KMS), refresh tokens, authorization codes, and access tokens. Refresh tokens and codes are stored
  server side only as SHA-256 hashes. Every task that handles one plants a known value and asserts
  it appears in none of those places.
- **Secrets are never read from a flag's value.** They come only from a hidden prompt,
  `--<name>-file <path>` or `--<name>-env <NAME>` (spec 015 FR-020).
- **Exact names and values:**
  - public client `agentx-cli`; audience `agentx-developer`; issuer `<ApiEndpoint>/v1/auth`;
  - access token 3600 seconds; session 604800 seconds (7 days) from the provider sign-in; AgentX
    authorization code 300 seconds; authorization request 600 seconds; channel-member cache
    600,000 ms;
  - loopback redirect `http://127.0.0.1:<port>/callback`, port 1 to 65535, no leading zero;
  - refresh tokens `agxr_` plus 43 base64url characters; authorization codes `agxc_` plus 43;
  - stack parameters `SlackTeamId`, `DeveloperSignInSlack` (`enabled`/`disabled`),
    `DeveloperOidcIssuer`, `DeveloperOidcClientId`, `DeveloperOidcRequiredClaim`,
    `DeveloperOidcRequiredValues` (a JSON array), `DeveloperOidcDisplayName`;
  - SSM `/agentx/<env>/signin` and `/agentx/<env>/slack/teamId`;
  - secrets `agentx/<env>/slack` (gains `clientId`, `clientSecret`) and
    `agentx/<env>/developer-oidc` (JSON `{"clientSecret":"..."}`);
  - KMS alias `alias/agentx/<env>/developer-tokens`;
  - lock commands `signin` (environment lock) and the file lock
    `~/.agentx/locks/developer-<env>.lock`;
  - `DEVELOPER_API_VERSION = "1.0"`.
- **Pinned dependencies:** `@aws-sdk/client-lambda` at exactly `3.1134.0`. Check it exists first
  with `npm view @aws-sdk/client-lambda@3.1134.0 version`.
- **Copy:**
  - plain words;
  - every error says what to do next;
  - no em dashes in any user-facing text, AWS resource name or description.
- **The gate:** `npm run typecheck && npm run lint && npm run build && npm test && npm run infra:synth`.
  - Use Node 22: `export PATH=/private/tmp/claude-501/node-v22.20.0-darwin-arm64/bin:$PATH`.
  - Known load flakes (issue #59): rerun that file alone.
- **Build process:** the owner approves this plan before building. Building uses
  superpowers:subagent-driven-development, with a fresh implementer and a fresh reviewer per task.

## Review Focus

1. **A refused sign-in leaves the terminal waiting.** Someone signs in with Slack from the wrong
   workspace, or without the company's required group. The browser shows the refusal, but today's
   loopback listener only knows `code` and `state`, so the CLI would sit until its timeout and then
   say "timed out". Expected: the CLI stops at once and prints the reason, for example "Sign-in
   refused: you signed in to Slack workspace T0OTHER, but this AgentX serves T0TEAM". Pinned in
   Task 10 (`developer-login.test.ts`, "stops at once with the server's reason when the sign-in is
   refused").
2. **Two local processes refresh at the same moment.** In 25b the MCP server and `agentx whoami`
   share one refresh token; rotation plus reuse detection would revoke the whole session and sign
   the person out. Expected: refreshes on one machine are serialized. The second process re-reads
   the rotated token and never sends the old one. Pinned in Task 10 (`developer-session.test.ts`,
   "serializes concurrent refreshes so the server never sees the same refresh token twice").
3. **A Slack outage or rate limit at refresh time signs everyone out.** Expected:
   - the token endpoint answers 503 `temporarily_unavailable` and neither rotates nor revokes;
   - the CLI keeps the stored tokens and says Slack could not be reached;
   - the same refresh token works once Slack is back.

   Pinned in Task 6 (`developer-identity-server.test.ts`, "keeps the session when Slack cannot be
   reached at refresh") and Task 10 ("keeps the tokens when the server says Slack is unavailable").
4. **A later deploy silently turns sign-in off.** After `signin enable`, someone runs
   `agentx deploy --parts control-plane` or re-runs `init`'s control-plane step, and
   `stackParameters` falls back to the template defaults, `disabled` and an empty team ID.
   Expected: every deploy of the control plane passes the stored sign-in parameters. Pinned in
   Task 9 (`deploy-environment.test.ts`, "passes the stored sign-in settings to every control-plane
   deploy").
5. **Re-running the Slack app step drops the sign-in keys.** A rotated bot token goes back through
   the `slack-app` step, which today writes `{signingSecret, botToken}` over the whole secret.
   `clientId` and `clientSecret` would vanish and Slack sign-in would break with no alarm.
   Expected: the step merges and keeps both keys. Pinned in Task 11 (`init-slack-app.test.ts`,
   "keeps the sign-in client ID and secret when the bot token is replaced").

---

## File map

| File | Responsibility | Task |
|---|---|---|
| `.specify/memory/constitution.md` (modify) | 3.0.0: Principles I, II, III | 1 |
| `packages/contracts/src/developer.ts` | constants, loopback rule, configuration, token and projects schemas, the channel-members invoke | 2 |
| `packages/contracts/src/index.ts` (modify) | export it | 2 |
| `packages/broker/src/developer/tokens.ts` | PKCE, random tokens, hashes, `TokenSigner`, KMS signer, access tokens | 3 |
| `tests/support/developer-fakes.ts` | fake KMS, local signer, fake Slack, fake OIDC provider, event builders | 3, 5, 6 |
| `packages/broker/src/developer/store.ts` | sign-in records: requests, codes, developers, sessions, refresh tokens | 4 |
| `packages/broker/src/developer/providers.ts` | Slack and company OIDC: authorize URLs, code exchange, ID token checks | 5 |
| `packages/broker/src/developer/slack-directory.ts` | `users.info`, `users.lookupByEmail`, `conversations.members` with the cache | 5 |
| `packages/broker/src/developer/server.ts` | the `/v1/auth/*` routes and the channel-members invoke | 6 |
| `packages/broker/src/aws/developer-identity.ts` | the Lambda entry: AWS clients and configuration | 6 |
| `packages/broker/src/developer/access.ts` | FR-013 access resolution | 7 |
| `packages/broker/src/aws/developer-routes.ts` | developer identity from claims, session check, `GET /v1/dev/projects` | 7 |
| `packages/broker/src/aws/broker.ts` (modify) | route `/v1/dev/*`; wire the developer configuration | 7 |
| `packages/broker/package.json` (modify) | `@aws-sdk/client-lambda` | 7 |
| `infra/lib/developer-signin.ts` | the construct: table, key, function, authorizer, routes, grants | 8 |
| `infra/lib/control-plane.ts` (modify) | the parameters and the construct, named environments only | 8 |
| `infra/lib/naming.ts` (modify) | `developerTokenKeyAlias` | 8 |
| `packages/cli/src/signin/settings.ts` | SSM settings and team ID, stack parameter mapping | 9 |
| `packages/cli/src/deploy/parameters.ts`, `deploy-environment.ts` (modify) | carry stored sign-in into control-plane deploys | 9 |
| `packages/cli/src/deploy/parameter-update.ts` | parameter-only change sets | 9 |
| `packages/cli/src/auth.ts` (modify) | export the loopback listener; handle `error` callbacks | 10 |
| `packages/cli/src/developer/config.ts` | `~/.agentx/developer.yaml` | 10 |
| `packages/cli/src/developer/session.ts` | stored tokens, locked refresh, sign-in required | 10 |
| `packages/cli/src/developer/login.ts` | `agentx login <url>` | 10 |
| `packages/cli/src/developer/commands.ts` | whoami and logout | 10 |
| `packages/cli/src/main.ts` (modify) | `login [url] --admin --no-browser`, `logout`, `whoami`, `signin`, init flags | 10, 12, 13 |
| `packages/cli/src/init/slack-app.ts` (modify) | manifest scopes and redirect URL, secret merge, team ID, scope header | 11 |
| `packages/cli/src/environments/adopt.ts`, `commands.ts` (modify) | adopt records the team ID | 11 |
| `packages/cli/src/signin/collect.ts` | Slack and company sign-in questions, secrets, discovery check | 12 |
| `packages/cli/src/signin/apply.ts` | show the change, confirm, update the stack, write SSM | 12 |
| `packages/cli/src/signin/check.ts` | FR-046 checks | 12 |
| `packages/cli/src/signin/commands.ts` | `signin show|enable|disable|check` | 12 |
| `packages/cli/src/init/signin-step.ts` | the `developer-signin` step | 13 |
| `packages/cli/src/init/install-state.ts`, `commands.ts`, `context.ts` (modify) | step id, flags, CloudFormation client | 13 |
| `specs/025-mcp-server/spec.md`, `plans/README.md` (modify) | record the rulings | 14 |

---
### Task 1: Constitution 3.0.0

FR-050 requires the amendment before any `/v1/dev/*` route is deployed. It is the first commit, so
every later commit on the branch sits under it. Open question 6: the PR does not merge until
Pratik has confirmed.

**Files:**
- Modify: `.specify/memory/constitution.md`
- Test: `tests/contract/constitution.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the constitution at version 3.0.0, which Tasks 7 and 14 cite.

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/constitution.test.ts
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const read = () => readFile(new URL("../../.specify/memory/constitution.md", import.meta.url), "utf8");

describe("constitution 3.0.0 (spec 025 FR-050)", () => {
  it("is version 3.0.0 with a sync impact note naming Principles I, II and III", async () => {
    const text = await read();
    expect(text).toMatch(/\*\*Version\*\*: 3\.0\.0 \| \*\*Ratified\*\*: 2026-09-17 \| \*\*Last Amended\*\*: \d{4}-\d{2}-\d{2}/);
    expect(text).toMatch(/Sync impact: 2\.1\.0 -> 3\.0\.0/);
    expect(text).toMatch(/Principles modified: I\. .*II\. .*III\./s);
  });

  it("keeps the Slack orchestrator as the only orchestrator model and admits the developer task API", async () => {
    const text = await read();
    expect(text).toContain("The hosted Slack orchestrator is the only AgentX orchestrator model.");
    expect(text).toContain("the developer task API");
    expect(text).toContain("MUST record the requesting developer with every operation");
    expect(text).not.toContain("No other client may drive coding work.");
  });

  it("lets a developer select a project by name through the developer task API (Principle II)", async () => {
    expect(await read()).toContain("or by name through the developer task API when they may use it");
  });

  it("gives developer tasks their own workspaces and keeps personal workspaces retired (Principle III)", async () => {
    const text = await read();
    expect(text).toContain("Every workspace is owned by a Slack thread or by one developer task.");
    expect(text).toContain("reachable only by the developer who started it");
    expect(text).toContain("Personal workspaces not tied to a task stay retired.");
  });

  it("contains no em dash", async () => {
    expect(await read()).not.toContain("\u2014");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/contract/constitution.test.ts`
Expected: FAIL, the version is 2.1.0.

- [ ] **Step 3: Amend the constitution**

Add this comment block at the top of the file, above the existing `<!-- Sync impact: 2.0.0 -> 2.1.0` block:

```markdown
<!-- Sync impact: 2.1.0 -> 3.0.0 (reverses spec 008's Slack-only rule for developers' AI tools).
Principles modified: I. One orchestrator, remote coding (the Slack orchestrator stays the only
orchestrator model; a second client, the developer task API, may drive coding work for a signed-in
developer whose own AI tool writes the instructions); II. Administrator-prepared projects (a
developer may also select a project by name through the developer task API); III. Shared
definitions, isolated instances (a workspace is owned by a Slack thread or by one developer task).
Sections modified: Scope and Operational Constraints (developer tasks are unattended too).
Removed sections: none.
Design and verification are recorded in specs/025-mcp-server/.
Follow-up TODOs: none. -->
```

Replace Principle I's second paragraph (from "No other client may drive coding work." to the end
of that paragraph) with:

```markdown
The hosted Slack orchestrator is the only AgentX orchestrator model. A second client, the developer
task API, may drive coding work. It MUST authenticate a developer through the control plane's
developer sign-in, and the developer's own AI tool writes the instructions, which reach the remote
worker unchanged with no AgentX model in between. It MUST record the requesting developer with
every operation. The administration client authenticates an administrator and calls
administration routes only. The control plane MUST refuse workspace, task, conversation, event and
publication requests that arrive neither through the hosted orchestrator's service identity nor
through the developer task API with a developer sign-in.
```

In Principle II, replace "A developer selects a registered project by posting in the Slack channel
bound to it." with:

```markdown
A developer selects a registered project by posting in the Slack channel bound to it, or by name
through the developer task API when they may use it.
```

Replace Principle III's second paragraph with:

```markdown
Every workspace is owned by a Slack thread or by one developer task. A Slack thread's workspace is
owned by its thread (team, channel and thread, as verified by Slack's signed request) and is
intentionally shared by the channel members who post in that thread. A developer task's workspace
is reachable only by the developer who started it, and, while the developer shares it in continue
mode, by the members of the bound channel who post in its shared thread. No workspace is reachable
from any other thread, task, or identifier supplied through any other client. Personal workspaces
not tied to a task stay retired: the existing ones are stopped and kept, and no route creates
another.
```

In Scope and Operational Constraints, replace the last sentence of the first paragraph ("All
orchestration is unattended and runs in the hosted Slack orchestrator described in Principle I.")
with:

```markdown
All orchestration is unattended. It runs in the hosted Slack orchestrator, or, for developer tasks,
in the remote worker with the developer's own instructions, as Principle I describes.
```

Change the version line to `**Version**: 3.0.0 | **Ratified**: 2026-09-17 | **Last Amended**: <today, YYYY-MM-DD>`.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/contract/constitution.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .specify/memory/constitution.md tests/contract/constitution.test.ts
git commit -m "docs(constitution): 3.0.0 admits the developer task API (spec 025 FR-050)"
```

---

### Task 2: Developer sign-in contracts

**Files:**
- Create: `packages/contracts/src/developer.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `tests/contract/developer-contracts.test.ts`

**Interfaces:**
- Consumes: `EnvironmentNameSchema`, `SlackChannelIdSchema`, `SlackUserIdSchema` from
  `@agentx/contracts`.
- Produces (all exported from `@agentx/contracts`):
  - `DEVELOPER_API_VERSION = "1.0"`, `AGENTX_CLI_CLIENT_ID = "agentx-cli"`,
    `DEVELOPER_TOKEN_AUDIENCE = "agentx-developer"`, `DEVELOPER_ACCESS_TOKEN_SECONDS = 3600`,
    `DEVELOPER_SESSION_SECONDS = 604_800`, `DEVELOPER_CODE_SECONDS = 300`,
    `DEVELOPER_AUTH_REQUEST_SECONDS = 600`, `SLACK_OIDC_ISSUER = "https://slack.com"`;
  - `DeveloperSignInMethodSchema` (`"slack" | "oidc"`) and `type DeveloperSignInMethod`;
  - `isLoopbackRedirectUri(value: string): boolean`;
  - `developerIssuer(apiEndpoint: string): string` (`<endpoint without trailing slash>/v1/auth`);
  - `apiVersionCompatible(server: string, client: string): { compatible: boolean; upgradeNotice: boolean }`;
  - `AgentXConfigurationSchema`, `type AgentXConfiguration`;
  - `DeveloperTokenResponseSchema`, `type DeveloperTokenResponse`;
  - `DeveloperSummarySchema`, `DeveloperProjectSchema`, `DeveloperProjectsResponseSchema`, and their types;
  - `ChannelMembersRequestSchema`, `type ChannelMembersRequest`,
    `type ChannelMembersResponse = { ok: true; memberOf: string[] } | { ok: false; error: "slack_unavailable" }`.

  The schemas the CLI parses from server responses (`AgentXConfigurationSchema`,
  `DeveloperTokenResponseSchema`, `DeveloperProjectsResponseSchema`) are plain `z.object`, not
  `.strict()`, so a newer control plane that adds fields (25e adds confirmation methods) does not
  break an older CLI.

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/developer-contracts.test.ts
import { describe, expect, it } from "vitest";
import {
  AGENTX_CLI_CLIENT_ID,
  AgentXConfigurationSchema,
  ChannelMembersRequestSchema,
  DEVELOPER_API_VERSION,
  DEVELOPER_TOKEN_AUDIENCE,
  DeveloperProjectsResponseSchema,
  DeveloperTokenResponseSchema,
  apiVersionCompatible,
  developerIssuer,
  isLoopbackRedirectUri,
} from "@agentx/contracts";

const configuration = {
  env: "staging",
  apiVersion: "1.0",
  issuer: "https://abc.execute-api.us-east-1.amazonaws.com/v1/auth",
  authorizationEndpoint: "https://abc.execute-api.us-east-1.amazonaws.com/v1/auth/authorize",
  tokenEndpoint: "https://abc.execute-api.us-east-1.amazonaws.com/v1/auth/token",
  revocationEndpoint: "https://abc.execute-api.us-east-1.amazonaws.com/v1/auth/revoke",
  clientId: "agentx-cli",
  methods: { slack: true, oidc: { displayName: "Okta" } },
};

describe("developer sign-in contracts", () => {
  it("names the public client, audience and API version", () => {
    expect([AGENTX_CLI_CLIENT_ID, DEVELOPER_TOKEN_AUDIENCE, DEVELOPER_API_VERSION]).toEqual(["agentx-cli", "agentx-developer", "1.0"]);
  });

  it.each([
    ["http://127.0.0.1:8765/callback", true],
    ["http://127.0.0.1:1/callback", true],
    ["http://127.0.0.1:65535/callback", true],
    ["http://127.0.0.1:65536/callback", false],
    ["http://127.0.0.1:0/callback", false],
    ["http://127.0.0.1:08765/callback", false],
    ["http://localhost:8765/callback", false],
    ["https://127.0.0.1:8765/callback", false],
    ["http://127.0.0.1:8765/callback/", false],
    ["http://127.0.0.1:8765/callback?x=1", false],
    ["http://127.0.0.1:8765/other", false],
    ["http://127.0.0.1.evil.test:8765/callback", false],
    ["http://[::1]:8765/callback", false],
  ])("accepts only loopback callbacks on 127.0.0.1: %s is %s", (uri, expected) => {
    expect(isLoopbackRedirectUri(uri)).toBe(expected);
  });

  it("derives the issuer from the API endpoint, with or without a trailing slash", () => {
    expect(developerIssuer("https://abc.execute-api.us-east-1.amazonaws.com")).toBe("https://abc.execute-api.us-east-1.amazonaws.com/v1/auth");
    expect(developerIssuer("https://abc.execute-api.us-east-1.amazonaws.com/")).toBe("https://abc.execute-api.us-east-1.amazonaws.com/v1/auth");
  });

  it("compares API versions by major (refuse) and minor (notice)", () => {
    expect(apiVersionCompatible("1.0", "1.0")).toEqual({ compatible: true, upgradeNotice: false });
    expect(apiVersionCompatible("1.3", "1.0")).toEqual({ compatible: true, upgradeNotice: true });
    expect(apiVersionCompatible("1.0", "1.3")).toEqual({ compatible: true, upgradeNotice: false });
    expect(apiVersionCompatible("2.0", "1.9")).toEqual({ compatible: false, upgradeNotice: true });
    expect(apiVersionCompatible("garbage", "1.0")).toEqual({ compatible: false, upgradeNotice: true });
  });

  it("parses the agentx configuration and ignores fields a newer control plane adds", () => {
    const parsed = AgentXConfigurationSchema.parse({ ...configuration, confirm: { elicitation: true } });
    expect(parsed).toEqual(configuration);
    expect(AgentXConfigurationSchema.safeParse({ ...configuration, clientId: "other" }).success).toBe(false);
    expect(AgentXConfigurationSchema.safeParse({ ...configuration, methods: { slack: false, oidc: null } }).success).toBe(true);
  });

  it("parses a token response and refuses one without a refresh token", () => {
    const token = { access_token: "a.b.c", token_type: "Bearer", expires_in: 3600, refresh_token: `agxr_${"x".repeat(43)}` };
    expect(DeveloperTokenResponseSchema.parse(token)).toEqual(token);
    expect(DeveloperTokenResponseSchema.safeParse({ ...token, refresh_token: undefined }).success).toBe(false);
  });

  it("parses the projects response", () => {
    const response = {
      developer: { id: "a".repeat(64), name: "Maya Chen", provider: "slack", slackUserId: "U0123ABCD" },
      projects: [{ name: "payments-api", latestRevision: 7, access: "channel", channels: [{ channelId: "C0123ABCD" }] }],
      notices: [],
    };
    expect(DeveloperProjectsResponseSchema.parse(response)).toEqual(response);
    expect(DeveloperProjectsResponseSchema.safeParse({ ...response, notices: ["slack_unavailable"] }).success).toBe(true);
  });

  it("bounds the channel-members invoke", () => {
    expect(ChannelMembersRequestSchema.safeParse({ kind: "channel-members", slackUserId: "U0123ABCD", channelIds: ["C0123ABCD"] }).success).toBe(true);
    expect(ChannelMembersRequestSchema.safeParse({ kind: "channel-members", slackUserId: "U0123ABCD", channelIds: Array.from({ length: 501 }, () => "C0123ABCD") }).success).toBe(false);
    expect(ChannelMembersRequestSchema.safeParse({ kind: "channel-members", slackUserId: "not-a-user", channelIds: [] }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/contract/developer-contracts.test.ts`
Expected: FAIL, the exports do not exist.

- [ ] **Step 3: Implement**

```ts
// packages/contracts/src/developer.ts
// Spec 025 phase 25a: the developer sign-in's shared names and wire shapes. The CLI parses server
// responses with the non-strict schemas here, so a newer control plane can add fields.
import { z } from "zod";
import { EnvironmentNameSchema } from "./environments.js";
import { SlackChannelIdSchema, SlackUserIdSchema } from "./slack.js";

export const DEVELOPER_API_VERSION = "1.0";
export const AGENTX_CLI_CLIENT_ID = "agentx-cli";
export const DEVELOPER_TOKEN_AUDIENCE = "agentx-developer";
export const DEVELOPER_ACCESS_TOKEN_SECONDS = 3600;
export const DEVELOPER_SESSION_SECONDS = 7 * 24 * 3600;
export const DEVELOPER_CODE_SECONDS = 300;
export const DEVELOPER_AUTH_REQUEST_SECONDS = 600;
export const SLACK_OIDC_ISSUER = "https://slack.com";

export const DeveloperSignInMethodSchema = z.enum(["slack", "oidc"]);
export type DeveloperSignInMethod = z.infer<typeof DeveloperSignInMethodSchema>;

const LOOPBACK_REDIRECT = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/callback$/;

/** FR-001: the only redirect URIs agentx-cli may use. */
export function isLoopbackRedirectUri(value: string): boolean {
  const match = LOOPBACK_REDIRECT.exec(value);
  return match !== null && Number(match[1]) <= 65_535;
}

export function developerIssuer(apiEndpoint: string): string {
  return `${apiEndpoint.replace(/\/+$/, "")}/v1/auth`;
}

/** FR-048: a different major refuses; a newer server minor shows an upgrade notice. */
export function apiVersionCompatible(server: string, client: string): { compatible: boolean; upgradeNotice: boolean } {
  const parse = (value: string) => /^(\d+)\.(\d+)$/.exec(value);
  const s = parse(server);
  const c = parse(client);
  if (!s || !c) return { compatible: false, upgradeNotice: true };
  if (s[1] !== c[1]) return { compatible: false, upgradeNotice: true };
  return { compatible: true, upgradeNotice: Number(s[2]) > Number(c[2]) };
}

export const AgentXConfigurationSchema = z.object({
  env: EnvironmentNameSchema,
  apiVersion: z.string().regex(/^\d+\.\d+$/),
  issuer: z.string().url(),
  authorizationEndpoint: z.string().url(),
  tokenEndpoint: z.string().url(),
  revocationEndpoint: z.string().url(),
  clientId: z.literal(AGENTX_CLI_CLIENT_ID),
  methods: z.object({
    slack: z.boolean(),
    oidc: z.object({ displayName: z.string().min(1).max(40) }).nullable(),
  }),
});
export type AgentXConfiguration = z.infer<typeof AgentXConfigurationSchema>;

export const DeveloperTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.literal("Bearer"),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().regex(/^agxr_[A-Za-z0-9_-]{43}$/),
});
export type DeveloperTokenResponse = z.infer<typeof DeveloperTokenResponseSchema>;

export const DeveloperSummarySchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  name: z.string().min(1).max(200),
  provider: DeveloperSignInMethodSchema,
  slackUserId: SlackUserIdSchema.optional(),
  email: z.string().email().optional(),
});
export type DeveloperSummary = z.infer<typeof DeveloperSummarySchema>;

export const DeveloperProjectSchema = z.object({
  name: z.string().min(1),
  latestRevision: z.number().int().positive(),
  access: z.enum(["granted", "channel"]),
  channels: z.array(z.object({ channelId: SlackChannelIdSchema })),
});
export type DeveloperProject = z.infer<typeof DeveloperProjectSchema>;

export const DeveloperProjectsResponseSchema = z.object({
  developer: DeveloperSummarySchema,
  projects: z.array(DeveloperProjectSchema),
  notices: z.array(z.enum(["slack_unavailable"])),
});
export type DeveloperProjectsResponse = z.infer<typeof DeveloperProjectsResponseSchema>;

export const ChannelMembersRequestSchema = z.object({
  kind: z.literal("channel-members"),
  slackUserId: SlackUserIdSchema,
  channelIds: z.array(SlackChannelIdSchema).max(500),
}).strict();
export type ChannelMembersRequest = z.infer<typeof ChannelMembersRequestSchema>;
export type ChannelMembersResponse = { ok: true; memberOf: string[] } | { ok: false; error: "slack_unavailable" };
```

In `packages/contracts/src/index.ts`, add `export * from "./developer.js";` after the
`./credentials.js` line.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/contract/developer-contracts.test.ts tests/contract/contracts.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/developer.ts packages/contracts/src/index.ts tests/contract/developer-contracts.test.ts
git commit -m "feat(contracts): developer sign-in names and wire shapes"
```

---

### Task 3: Tokens, PKCE and the KMS signer

**Files:**
- Create: `packages/broker/src/developer/tokens.ts`
- Create: `tests/support/developer-fakes.ts`
- Test: `tests/contract/developer-tokens.test.ts`

**Interfaces:**
- Consumes: `DEVELOPER_ACCESS_TOKEN_SECONDS`, `DEVELOPER_TOKEN_AUDIENCE`, `DeveloperSignInMethod`
  (Task 2).
- Produces (`packages/broker/src/developer/tokens.ts`):
  - `interface PublicSigningJwk { kty: "RSA"; n: string; e: string; kid: string; alg: "RS256"; use: "sig" }`;
  - `interface TokenSigner { publicJwk(): Promise<PublicSigningJwk>; sign(signingInput: Buffer): Promise<Buffer> }`;
  - `kmsTokenSigner(input: { kms: { send(command: unknown): Promise<unknown> }; keyId: string }): TokenSigner`.
    Uses `GetPublicKeyCommand` once (cached), and `SignCommand` with `MessageType: "RAW"` and
    `SigningAlgorithm: "RSASSA_PKCS1_V1_5_SHA_256"`;
  - `issueAccessToken(signer: TokenSigner, input: { issuer: string; subject: string; amr: DeveloperSignInMethod; env: string; sessionId: string; now: number }): Promise<{ token: string; expiresIn: number }>`;
  - `pkceChallengeMatches(verifier: string, challenge: string): boolean` (S256 only; the verifier
    must be 43 to 128 characters of `[A-Za-z0-9._~-]`);
  - `randomToken(prefix: "agxr_" | "agxc_" | ""): string` (32 random bytes, base64url);
  - `sha256Hex(value: string): string`.
- Produces (`tests/support/developer-fakes.ts`): `fakeKms()`, `localSigner()`, `T0`, `ISSUER`,
  `API`, used by Tasks 4 to 7.

- [ ] **Step 1: Write the test support and the failing test**

```ts
// tests/support/developer-fakes.ts
// Shared fakes for the developer sign-in (spec 025 phase 25a). Nothing here reaches AWS, Slack or
// any identity provider. Later tasks add the fake Slack and OIDC providers below.
import { createPublicKey, generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import { GetPublicKeyCommand, SignCommand } from "@aws-sdk/client-kms";
import type { PublicSigningJwk, TokenSigner } from "../../packages/broker/src/developer/tokens.js";
import { kmsTokenSigner } from "../../packages/broker/src/developer/tokens.js";

export const T0 = Date.parse("2026-09-27T12:00:00.000Z");
export const API = "https://abc123.execute-api.us-east-1.amazonaws.com";
export const ISSUER = `${API}/v1/auth`;

export function rsaKeyPair(): { privateKey: KeyObject; publicKey: KeyObject } {
  return generateKeyPairSync("rsa", { modulusLength: 2048 });
}

/** A KMS client that signs with a local RSA key, and records every command it received. */
export function fakeKms(keys = rsaKeyPair()) {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  return {
    calls,
    publicKey: keys.publicKey,
    async send(command: unknown): Promise<unknown> {
      const name = (command as { constructor: { name: string } }).constructor.name;
      const input = (command as { input: Record<string, unknown> }).input;
      calls.push({ name, input });
      if (command instanceof GetPublicKeyCommand) {
        return { KeySpec: "RSA_2048", KeyUsage: "SIGN_VERIFY", PublicKey: new Uint8Array(keys.publicKey.export({ format: "der", type: "spki" })) };
      }
      if (command instanceof SignCommand) {
        if (input.MessageType !== "RAW" || input.SigningAlgorithm !== "RSASSA_PKCS1_V1_5_SHA_256") throw new Error("unexpected signing request");
        return { Signature: new Uint8Array(cryptoSign("sha256", Buffer.from(input.Message as Uint8Array), keys.privateKey)) };
      }
      throw new Error(`fakeKms does not support ${name}`);
    },
  };
}

/** The signer every server test uses: the real KMS signer over the fake KMS. */
export function localSigner(): TokenSigner & { jwks(): Promise<{ keys: PublicSigningJwk[] }> } {
  const signer = kmsTokenSigner({ kms: fakeKms(), keyId: "arn:aws:kms:us-east-1:123456789012:key/test" });
  return { ...signer, jwks: async () => ({ keys: [await signer.publicJwk()] }) };
}

export function publicKeyOf(jwk: PublicSigningJwk): KeyObject {
  return createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: "jwk" });
}
```

```ts
// tests/contract/developer-tokens.test.ts
import { createHash } from "node:crypto";
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { issueAccessToken, kmsTokenSigner, pkceChallengeMatches, randomToken, sha256Hex } from "../../packages/broker/src/developer/tokens.js";
import { ISSUER, T0, fakeKms } from "../support/developer-fakes.js";

const KEY = "arn:aws:kms:us-east-1:123456789012:key/k1";
const issue = (signer: ReturnType<typeof kmsTokenSigner>, now = T0) =>
  issueAccessToken(signer, { issuer: ISSUER, subject: "d".repeat(64), amr: "slack", env: "staging", sessionId: "s-1", now });

describe("developer access tokens", () => {
  it("are RS256 JWTs with a kid that a JWKS verifier (API Gateway's JWT authorizer) accepts", async () => {
    const signer = kmsTokenSigner({ kms: fakeKms(), keyId: KEY });
    const { token, expiresIn } = await issue(signer);
    expect(expiresIn).toBe(3600);
    const jwk = await signer.publicJwk();
    expect(jwk).toMatchObject({ kty: "RSA", alg: "RS256", use: "sig" });
    expect(decodeProtectedHeader(token)).toEqual({ alg: "RS256", typ: "JWT", kid: jwk.kid });
    const { payload } = await jwtVerify(token, createLocalJWKSet({ keys: [jwk] }), { issuer: ISSUER, audience: "agentx-developer", currentDate: new Date(T0 + 1_000) });
    expect(payload).toMatchObject({ iss: ISSUER, aud: "agentx-developer", sub: "d".repeat(64), amr: "slack", env: "staging", sid: "s-1", iat: T0 / 1000, nbf: T0 / 1000, exp: T0 / 1000 + 3600 });
    expect(typeof payload.jti).toBe("string");
    // API Gateway passes array claims to the broker as strings, so every claim is a scalar.
    for (const value of Object.values(payload)) expect(["string", "number"]).toContain(typeof value);
  });

  it("stop verifying after one hour", async () => {
    const signer = kmsTokenSigner({ kms: fakeKms(), keyId: KEY });
    const { token } = await issue(signer);
    await expect(jwtVerify(token, createLocalJWKSet({ keys: [await signer.publicJwk()] }), { issuer: ISSUER, audience: "agentx-developer", currentDate: new Date(T0 + 3_601_000) })).rejects.toThrow(/exp/);
  });

  it("sign through KMS over the raw signing input, fetching the public key once", async () => {
    const kms = fakeKms();
    const signer = kmsTokenSigner({ kms, keyId: KEY });
    await issue(signer);
    await issue(signer);
    await signer.publicJwk();
    expect(kms.calls.filter((call) => call.name === "GetPublicKeyCommand")).toHaveLength(1);
    const signs = kms.calls.filter((call) => call.name === "SignCommand");
    expect(signs).toHaveLength(2);
    expect(signs[0]!.input).toMatchObject({ KeyId: KEY, MessageType: "RAW", SigningAlgorithm: "RSASSA_PKCS1_V1_5_SHA_256" });
  });

  it("derive the kid from the public key, so it never reveals the key ARN", async () => {
    const jwk = await kmsTokenSigner({ kms: fakeKms(), keyId: KEY }).publicJwk();
    expect(jwk.kid).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(jwk.kid).not.toContain("k1");
  });
});

describe("PKCE, random tokens and hashes", () => {
  const verifier = "v".repeat(43);
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  it("accepts only the S256 challenge of the verifier", () => {
    expect(pkceChallengeMatches(verifier, challenge)).toBe(true);
    expect(pkceChallengeMatches(verifier, verifier)).toBe(false);
    expect(pkceChallengeMatches("v".repeat(42), createHash("sha256").update("v".repeat(42)).digest("base64url"))).toBe(false);
    expect(pkceChallengeMatches("v".repeat(129), createHash("sha256").update("v".repeat(129)).digest("base64url"))).toBe(false);
    expect(pkceChallengeMatches(`${"v".repeat(42)} `, challenge)).toBe(false);
  });

  it("makes prefixed random tokens with 32 bytes of entropy", () => {
    const first = randomToken("agxr_");
    expect(first).toMatch(/^agxr_[A-Za-z0-9_-]{43}$/);
    expect(randomToken("agxr_")).not.toBe(first);
    expect(randomToken("")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("hashes to lowercase hex SHA-256", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/contract/developer-tokens.test.ts`
Expected: FAIL, `packages/broker/src/developer/tokens.js` does not exist.

- [ ] **Step 3: Implement**

```ts
// packages/broker/src/developer/tokens.ts
// Spec 025 FR-001 and FR-005 (R1: RS256, because API Gateway's JWT authorizer accepts only RSA).
// The private key never leaves KMS; this file builds the JWS signing input and asks KMS to sign it.
import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { GetPublicKeyCommand, SignCommand } from "@aws-sdk/client-kms";
import { DEVELOPER_ACCESS_TOKEN_SECONDS, DEVELOPER_TOKEN_AUDIENCE, type DeveloperSignInMethod } from "@agentx/contracts";

export interface PublicSigningJwk { kty: "RSA"; n: string; e: string; kid: string; alg: "RS256"; use: "sig" }

export interface TokenSigner {
  publicJwk(): Promise<PublicSigningJwk>;
  sign(signingInput: Buffer): Promise<Buffer>;
}

const KMS_RAW_MESSAGE_LIMIT = 4096;

export function kmsTokenSigner(input: { kms: { send(command: unknown): Promise<unknown> }; keyId: string }): TokenSigner {
  let jwk: Promise<PublicSigningJwk> | undefined;
  return {
    publicJwk() {
      jwk ??= input.kms.send(new GetPublicKeyCommand({ KeyId: input.keyId })).then((response) => {
        const der = (response as { PublicKey?: Uint8Array }).PublicKey;
        if (der === undefined) throw new Error("KMS returned no public key for the developer token key");
        const exported = createPublicKey({ key: Buffer.from(der), format: "der", type: "spki" }).export({ format: "jwk" });
        if (exported.kty !== "RSA" || typeof exported.n !== "string" || typeof exported.e !== "string") {
          throw new Error("the developer token key is not an RSA key");
        }
        const kid = createHash("sha256").update(Buffer.from(der)).digest("base64url").slice(0, 16);
        return { kty: "RSA" as const, n: exported.n, e: exported.e, kid, alg: "RS256" as const, use: "sig" as const };
      }).catch((error: unknown) => {
        jwk = undefined;
        throw error;
      });
      return jwk;
    },
    async sign(signingInput) {
      if (signingInput.length > KMS_RAW_MESSAGE_LIMIT) throw new Error("developer token signing input is too large for KMS");
      const response = await input.kms.send(new SignCommand({
        KeyId: input.keyId,
        Message: signingInput,
        MessageType: "RAW",
        SigningAlgorithm: "RSASSA_PKCS1_V1_5_SHA_256",
      })) as { Signature?: Uint8Array };
      if (response.Signature === undefined) throw new Error("KMS returned no signature");
      return Buffer.from(response.Signature);
    },
  };
}

const base64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

export async function issueAccessToken(signer: TokenSigner, input: {
  issuer: string; subject: string; amr: DeveloperSignInMethod; env: string; sessionId: string; now: number;
}): Promise<{ token: string; expiresIn: number }> {
  const { kid } = await signer.publicJwk();
  const iat = Math.floor(input.now / 1000);
  const header = { alg: "RS256", typ: "JWT", kid };
  const payload = {
    iss: input.issuer,
    aud: DEVELOPER_TOKEN_AUDIENCE,
    sub: input.subject,
    amr: input.amr,
    env: input.env,
    sid: input.sessionId,
    iat,
    nbf: iat,
    exp: iat + DEVELOPER_ACCESS_TOKEN_SECONDS,
    jti: randomUUID(),
  };
  const signingInput = `${base64url(header)}.${base64url(payload)}`;
  const signature = await signer.sign(Buffer.from(signingInput));
  return { token: `${signingInput}.${signature.toString("base64url")}`, expiresIn: DEVELOPER_ACCESS_TOKEN_SECONDS };
}

const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

export function pkceChallengeMatches(verifier: string, challenge: string): boolean {
  if (!VERIFIER.test(verifier)) return false;
  const expected = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
  const given = Buffer.from(challenge);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function randomToken(prefix: "agxr_" | "agxc_" | ""): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/contract/developer-tokens.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/broker/src/developer/tokens.ts tests/support/developer-fakes.ts tests/contract/developer-tokens.test.ts
git commit -m "feat(broker): developer access tokens signed by KMS (RS256)"
```

---

### Task 4: The sign-in store

**Files:**
- Create: `packages/broker/src/developer/store.ts`
- Test: `tests/contract/developer-signin-store.test.ts`

**Interfaces:**
- Consumes: `randomToken`, `sha256Hex`, `pkceChallengeMatches` (Task 3);
  `DEVELOPER_SESSION_SECONDS`, `DEVELOPER_CODE_SECONDS`, `DEVELOPER_AUTH_REQUEST_SECONDS`,
  `DeveloperSignInMethod` (Task 2); `FakeDynamoDb` (`tests/support/fake-dynamodb.ts`).
- Produces (`packages/broker/src/developer/store.ts`), keyed in the `DeveloperSignIn` table, TTL
  attribute `expiresAt` (epoch seconds):

  | Record | pk / sk | Lifetime |
  |---|---|---|
  | authorization request | `AUTHREQ#<id>` / `META` | 600 s |
  | AgentX code | `CODE#<sha256(code)>` / `META` | 300 s, single use |
  | developer | `DEVELOPER#<developerId>` / `META` | kept |
  | session | `SESSION#<sessionId>` / `META` | TTL 1 day after `endsAt` |
  | refresh token | `REFRESH#<sha256(token)>` / `META` | TTL at the session's `endsAt` |

  ```ts
  export interface AuthRequestRecord { id: string; clientRedirectUri: string; clientState: string; codeChallenge: string; nonce: string; method?: DeveloperSignInMethod; consumedAt?: string; expiresAt: number }
  export interface DeveloperRecord { developerId: string; provider: DeveloperSignInMethod; issuer: string; subject: string; displayName: string; email?: string; slackUserId?: string; firstSignInAt: string; lastSignInAt: string; revoked: boolean }
  export interface SessionRecord { sessionId: string; developerId: string; amr: DeveloperSignInMethod; slackUserId?: string; startedAt: string; endsAt: number; lastRefreshAt?: string; revokedAt?: string; revokedReason?: string }
  export type RefreshLookup =
    | { kind: "active"; session: SessionRecord; tokenHash: string }
    | { kind: "unknown" }
    | { kind: "reused"; sessionId: string }
    | { kind: "ended"; session: SessionRecord };
  export class DeveloperSignInStore {
    constructor(input: { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string; now: () => number });
    createAuthRequest(input: Omit<AuthRequestRecord, "id" | "expiresAt" | "method" | "consumedAt">): Promise<AuthRequestRecord>;
    getAuthRequest(id: string): Promise<AuthRequestRecord | undefined>; // undefined when absent or expired
    chooseMethod(id: string, method: DeveloperSignInMethod): Promise<AuthRequestRecord | undefined>;
    consumeAuthRequest(id: string, method: DeveloperSignInMethod): Promise<AuthRequestRecord | undefined>; // once only
    upsertDeveloper(profile: Omit<DeveloperRecord, "firstSignInAt" | "lastSignInAt" | "revoked">): Promise<DeveloperRecord>;
    getDeveloper(developerId: string): Promise<DeveloperRecord | undefined>;
    issueCode(input: { developerId: string; amr: DeveloperSignInMethod; slackUserId?: string; codeChallenge: string; redirectUri: string }): Promise<string>;
    redeemCode(input: { code: string; verifier: string; redirectUri: string }): Promise<{ developerId: string; amr: DeveloperSignInMethod; slackUserId?: string } | undefined>;
    createSession(input: { developerId: string; amr: DeveloperSignInMethod; slackUserId?: string }): Promise<{ session: SessionRecord; refreshToken: string }>;
    getSession(sessionId: string): Promise<SessionRecord | undefined>;
    lookupRefresh(refreshToken: string): Promise<RefreshLookup>;
    rotateRefresh(input: { session: SessionRecord; tokenHash: string }): Promise<{ refreshToken: string } | { reused: true }>;
    revokeSession(sessionId: string, reason: string): Promise<void>;
  }
  ```

  `lookupRefresh` reports `reused` when the token's record has `usedAt`, and `ended` when the
  session is revoked or past `endsAt`. `rotateRefresh` runs one transaction (mark the old record
  used, put the new one, touch the session, all conditional) and answers `{ reused: true }` when a
  condition fails because the old token was used in the meantime.

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/developer-signin-store.test.ts
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { DeveloperSignInStore } from "../../packages/broker/src/developer/store.js";
import { sha256Hex } from "../../packages/broker/src/developer/tokens.js";
import { T0 } from "../support/developer-fakes.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const verifier = "v".repeat(64);
const challenge = createHash("sha256").update(verifier).digest("base64url");
const redirect = "http://127.0.0.1:49152/callback";
const developerId = "a".repeat(64);

let db: FakeDynamoDb;
let clock: number;
let store: DeveloperSignInStore;
beforeEach(() => {
  db = new FakeDynamoDb();
  clock = T0;
  store = new DeveloperSignInStore({ documentClient: db, tableName: "signin", now: () => clock });
});

describe("authorization requests", () => {
  it("expire after 10 minutes and are consumed once, for the method chosen", async () => {
    const request = await store.createAuthRequest({ clientRedirectUri: redirect, clientState: "cs", codeChallenge: challenge, nonce: "n1" });
    expect(request.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(db.get(`AUTHREQ#${request.id}`, "META")).toMatchObject({ expiresAt: T0 / 1000 + 600 });
    await store.chooseMethod(request.id, "slack");
    expect(await store.consumeAuthRequest(request.id, "oidc")).toBeUndefined();
    expect(await store.consumeAuthRequest(request.id, "slack")).toMatchObject({ clientState: "cs", nonce: "n1" });
    expect(await store.consumeAuthRequest(request.id, "slack")).toBeUndefined();
  });

  it("are gone once expired", async () => {
    const request = await store.createAuthRequest({ clientRedirectUri: redirect, clientState: "cs", codeChallenge: challenge, nonce: "n1" });
    clock = T0 + 601_000;
    expect(await store.getAuthRequest(request.id)).toBeUndefined();
    expect(await store.chooseMethod(request.id, "slack")).toBeUndefined();
  });
});

describe("developers", () => {
  it("keep the first sign-in time and refresh the rest at each sign-in (FR-008, FR-012)", async () => {
    const profile = { developerId, provider: "slack" as const, issuer: "https://slack.com", subject: "U0123ABCD", displayName: "Maya", slackUserId: "U0123ABCD" };
    const first = await store.upsertDeveloper(profile);
    clock = T0 + 86_400_000;
    const second = await store.upsertDeveloper({ ...profile, displayName: "Maya Chen" });
    expect(second).toMatchObject({ firstSignInAt: first.firstSignInAt, lastSignInAt: new Date(clock).toISOString(), displayName: "Maya Chen", revoked: false });
  });

  it("drop a Slack link and email the provider no longer gives", async () => {
    await store.upsertDeveloper({ developerId, provider: "oidc", issuer: "https://idp.example.test", subject: "s1", displayName: "Maya", email: "maya@example.com", slackUserId: "U0123ABCD" });
    const next = await store.upsertDeveloper({ developerId, provider: "oidc", issuer: "https://idp.example.test", subject: "s1", displayName: "Maya" });
    expect(next.email).toBeUndefined();
    expect(next.slackUserId).toBeUndefined();
  });
});

describe("AgentX codes", () => {
  it("are stored hashed, redeem once with the right verifier and redirect, and expire after 5 minutes", async () => {
    const code = await store.issueCode({ developerId, amr: "slack", slackUserId: "U0123ABCD", codeChallenge: challenge, redirectUri: redirect });
    expect(code).toMatch(/^agxc_/);
    expect(JSON.stringify([...db.items.values()])).not.toContain(code);
    expect(db.get(`CODE#${sha256Hex(code)}`, "META")).toBeDefined();
    expect(await store.redeemCode({ code, verifier: "w".repeat(64), redirectUri: redirect })).toBeUndefined();
    expect(await store.redeemCode({ code, verifier, redirectUri: "http://127.0.0.1:49153/callback" })).toBeUndefined();
    expect(await store.redeemCode({ code, verifier, redirectUri: redirect })).toEqual({ developerId, amr: "slack", slackUserId: "U0123ABCD" });
    expect(await store.redeemCode({ code, verifier, redirectUri: redirect })).toBeUndefined();

    const late = await store.issueCode({ developerId, amr: "oidc", codeChallenge: challenge, redirectUri: redirect });
    clock += 301_000;
    expect(await store.redeemCode({ code: late, verifier, redirectUri: redirect })).toBeUndefined();
  });

  it("burn a code even when the verifier is wrong, so it cannot be guessed at", async () => {
    const code = await store.issueCode({ developerId, amr: "slack", codeChallenge: challenge, redirectUri: redirect });
    await store.redeemCode({ code, verifier: "w".repeat(64), redirectUri: redirect });
    expect(await store.redeemCode({ code, verifier, redirectUri: redirect })).toBeUndefined();
  });
});

describe("sessions and refresh tokens (FR-005)", () => {
  it("store only the refresh token's hash and end 7 days after sign-in", async () => {
    const { session, refreshToken } = await store.createSession({ developerId, amr: "slack", slackUserId: "U0123ABCD" });
    expect(refreshToken).toMatch(/^agxr_[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify([...db.items.values()])).not.toContain(refreshToken);
    expect(session.endsAt).toBe(T0 / 1000 + 604_800);
    expect(await store.lookupRefresh(refreshToken)).toMatchObject({ kind: "active", session: { sessionId: session.sessionId } });
  });

  it("rotate: the old token becomes reused, the new one active, and the end date stays put", async () => {
    const { refreshToken } = await store.createSession({ developerId, amr: "slack" });
    const lookup = await store.lookupRefresh(refreshToken);
    if (lookup.kind !== "active") throw new Error("expected active");
    clock = T0 + 3_600_000;
    const rotated = await store.rotateRefresh(lookup);
    if (!("refreshToken" in rotated)) throw new Error("expected a new token");
    expect(await store.lookupRefresh(refreshToken)).toEqual({ kind: "reused", sessionId: lookup.session.sessionId });
    const next = await store.lookupRefresh(rotated.refreshToken);
    expect(next).toMatchObject({ kind: "active", session: { endsAt: T0 / 1000 + 604_800 } });
  });

  it("answer reused when the same token rotates twice (a race)", async () => {
    const { refreshToken } = await store.createSession({ developerId, amr: "slack" });
    const lookup = await store.lookupRefresh(refreshToken);
    if (lookup.kind !== "active") throw new Error("expected active");
    await store.rotateRefresh(lookup);
    expect(await store.rotateRefresh(lookup)).toEqual({ reused: true });
  });

  it("report ended after revocation and after 7 days, and unknown for a token never issued", async () => {
    const one = await store.createSession({ developerId, amr: "slack" });
    await store.revokeSession(one.session.sessionId, "refresh_token_reused");
    expect(await store.lookupRefresh(one.refreshToken)).toMatchObject({ kind: "ended", session: { revokedReason: "refresh_token_reused" } });
    const two = await store.createSession({ developerId, amr: "oidc" });
    clock = T0 + 604_801_000;
    expect((await store.lookupRefresh(two.refreshToken)).kind).toBe("ended");
    expect(await store.lookupRefresh(`agxr_${"z".repeat(43)}`)).toEqual({ kind: "unknown" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/contract/developer-signin-store.test.ts`
Expected: FAIL, the module does not exist.

- [ ] **Step 3: Implement**

```ts
// packages/broker/src/developer/store.ts
// The DeveloperSignIn table (spec 025 FR-005, FR-008). Codes and refresh tokens are stored only as
// SHA-256 hashes. Every expiry is checked here; the table's TTL only cleans up afterwards.
import { randomUUID } from "node:crypto";
import { GetCommand, PutCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  DEVELOPER_AUTH_REQUEST_SECONDS,
  DEVELOPER_CODE_SECONDS,
  DEVELOPER_SESSION_SECONDS,
  type DeveloperSignInMethod,
} from "@agentx/contracts";
import { pkceChallengeMatches, randomToken, sha256Hex } from "./tokens.js";

export interface AuthRequestRecord { id: string; clientRedirectUri: string; clientState: string; codeChallenge: string; nonce: string; method?: DeveloperSignInMethod; consumedAt?: string; expiresAt: number }
export interface DeveloperRecord { developerId: string; provider: DeveloperSignInMethod; issuer: string; subject: string; displayName: string; email?: string; slackUserId?: string; firstSignInAt: string; lastSignInAt: string; revoked: boolean }
export interface SessionRecord { sessionId: string; developerId: string; amr: DeveloperSignInMethod; slackUserId?: string; startedAt: string; endsAt: number; lastRefreshAt?: string; revokedAt?: string; revokedReason?: string }
export type RefreshLookup =
  | { kind: "active"; session: SessionRecord; tokenHash: string }
  | { kind: "unknown" }
  | { kind: "reused"; sessionId: string }
  | { kind: "ended"; session: SessionRecord };

interface CodeRecord { developerId: string; amr: DeveloperSignInMethod; slackUserId?: string; codeChallenge: string; redirectUri: string; expiresAt: number; usedAt?: string }
interface RefreshRecord { sessionId: string; expiresAt: number; usedAt?: string }

const META = "META";
const conditionFailed = (error: unknown) =>
  error instanceof Error && (error.name === "ConditionalCheckFailedException" || error.name === "TransactionCanceledException");

export class DeveloperSignInStore {
  constructor(private readonly input: { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string; now: () => number }) {}

  private seconds(): number { return Math.floor(this.input.now() / 1000); }
  private iso(): string { return new Date(this.input.now()).toISOString(); }

  private async get<T>(pk: string): Promise<(T & { pk: string; sk: string }) | undefined> {
    const response = await this.input.documentClient.send(new GetCommand({ TableName: this.input.tableName, Key: { pk, sk: META }, ConsistentRead: true })) as { Item?: T & { pk: string; sk: string } };
    return response.Item;
  }

  private async put(item: Record<string, unknown>, condition?: string): Promise<void> {
    await this.input.documentClient.send(new PutCommand({ TableName: this.input.tableName, Item: item, ...(condition === undefined ? {} : { ConditionExpression: condition }) }));
  }

  async createAuthRequest(input: Omit<AuthRequestRecord, "id" | "expiresAt" | "method" | "consumedAt">): Promise<AuthRequestRecord> {
    const record: AuthRequestRecord = { ...input, id: randomToken(""), expiresAt: this.seconds() + DEVELOPER_AUTH_REQUEST_SECONDS };
    await this.put({ pk: `AUTHREQ#${record.id}`, sk: META, entityType: "AUTH_REQUEST", ...record }, "attribute_not_exists(pk)");
    return record;
  }

  async getAuthRequest(id: string): Promise<AuthRequestRecord | undefined> {
    const item = await this.get<AuthRequestRecord>(`AUTHREQ#${id}`);
    return item === undefined || item.expiresAt <= this.seconds() ? undefined : strip(item);
  }

  async chooseMethod(id: string, method: DeveloperSignInMethod): Promise<AuthRequestRecord | undefined> {
    try {
      await this.input.documentClient.send(new UpdateCommand({
        TableName: this.input.tableName,
        Key: { pk: `AUTHREQ#${id}`, sk: META },
        UpdateExpression: "SET #method = :method",
        ConditionExpression: "attribute_exists(pk) AND expiresAt > :now AND attribute_not_exists(consumedAt)",
        ExpressionAttributeNames: { "#method": "method" },
        ExpressionAttributeValues: { ":method": method, ":now": this.seconds() },
      }));
    } catch (error) {
      if (conditionFailed(error)) return undefined;
      throw error;
    }
    return this.getAuthRequest(id);
  }

  async consumeAuthRequest(id: string, method: DeveloperSignInMethod): Promise<AuthRequestRecord | undefined> {
    try {
      await this.input.documentClient.send(new UpdateCommand({
        TableName: this.input.tableName,
        Key: { pk: `AUTHREQ#${id}`, sk: META },
        UpdateExpression: "SET consumedAt = :at",
        ConditionExpression: "attribute_exists(pk) AND expiresAt > :now AND attribute_not_exists(consumedAt) AND #method = :method",
        ExpressionAttributeNames: { "#method": "method" },
        ExpressionAttributeValues: { ":at": this.iso(), ":now": this.seconds(), ":method": method },
      }));
    } catch (error) {
      if (conditionFailed(error)) return undefined;
      throw error;
    }
    const item = await this.get<AuthRequestRecord>(`AUTHREQ#${id}`);
    return item === undefined ? undefined : strip(item);
  }

  async upsertDeveloper(profile: Omit<DeveloperRecord, "firstSignInAt" | "lastSignInAt" | "revoked">): Promise<DeveloperRecord> {
    const existing = await this.getDeveloper(profile.developerId);
    const at = this.iso();
    const record: DeveloperRecord = {
      developerId: profile.developerId,
      provider: profile.provider,
      issuer: profile.issuer,
      subject: profile.subject,
      displayName: profile.displayName,
      ...(profile.email === undefined ? {} : { email: profile.email }),
      ...(profile.slackUserId === undefined ? {} : { slackUserId: profile.slackUserId }),
      firstSignInAt: existing?.firstSignInAt ?? at,
      lastSignInAt: at,
      revoked: existing?.revoked ?? false,
    };
    await this.put({ pk: `DEVELOPER#${record.developerId}`, sk: META, entityType: "DEVELOPER", ...record });
    return record;
  }

  async getDeveloper(developerId: string): Promise<DeveloperRecord | undefined> {
    const item = await this.get<DeveloperRecord>(`DEVELOPER#${developerId}`);
    return item === undefined ? undefined : strip(item);
  }

  async issueCode(input: { developerId: string; amr: DeveloperSignInMethod; slackUserId?: string; codeChallenge: string; redirectUri: string }): Promise<string> {
    const code = randomToken("agxc_");
    const record: CodeRecord = { ...input, expiresAt: this.seconds() + DEVELOPER_CODE_SECONDS };
    await this.put({ pk: `CODE#${sha256Hex(code)}`, sk: META, entityType: "AUTH_CODE", ...record }, "attribute_not_exists(pk)");
    return code;
  }

  async redeemCode(input: { code: string; verifier: string; redirectUri: string }): Promise<{ developerId: string; amr: DeveloperSignInMethod; slackUserId?: string } | undefined> {
    const pk = `CODE#${sha256Hex(input.code)}`;
    try {
      // Burned first, whatever the verifier: a code is tried once.
      await this.input.documentClient.send(new UpdateCommand({
        TableName: this.input.tableName,
        Key: { pk, sk: META },
        UpdateExpression: "SET usedAt = :at",
        ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(usedAt) AND expiresAt > :now",
        ExpressionAttributeValues: { ":at": this.iso(), ":now": this.seconds() },
      }));
    } catch (error) {
      if (conditionFailed(error)) return undefined;
      throw error;
    }
    const record = await this.get<CodeRecord>(pk);
    if (record === undefined || record.redirectUri !== input.redirectUri || !pkceChallengeMatches(input.verifier, record.codeChallenge)) return undefined;
    return { developerId: record.developerId, amr: record.amr, ...(record.slackUserId === undefined ? {} : { slackUserId: record.slackUserId }) };
  }

  async createSession(input: { developerId: string; amr: DeveloperSignInMethod; slackUserId?: string }): Promise<{ session: SessionRecord; refreshToken: string }> {
    const session: SessionRecord = { ...input, sessionId: randomUUID(), startedAt: this.iso(), endsAt: this.seconds() + DEVELOPER_SESSION_SECONDS };
    const refreshToken = randomToken("agxr_");
    await this.input.documentClient.send(new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: this.input.tableName, Item: { pk: `SESSION#${session.sessionId}`, sk: META, entityType: "SESSION", ...session, expiresAt: session.endsAt + 86_400 }, ConditionExpression: "attribute_not_exists(pk)" } },
        { Put: { TableName: this.input.tableName, Item: { pk: `REFRESH#${sha256Hex(refreshToken)}`, sk: META, entityType: "REFRESH_TOKEN", sessionId: session.sessionId, expiresAt: session.endsAt }, ConditionExpression: "attribute_not_exists(pk)" } },
      ],
    }));
    return { session, refreshToken };
  }

  async getSession(sessionId: string): Promise<SessionRecord | undefined> {
    const item = await this.get<SessionRecord & { expiresAt?: number }>(`SESSION#${sessionId}`);
    if (item === undefined) return undefined;
    const { expiresAt: _ttl, ...session } = strip(item);
    return session;
  }

  async lookupRefresh(refreshToken: string): Promise<RefreshLookup> {
    const tokenHash = sha256Hex(refreshToken);
    const record = await this.get<RefreshRecord>(`REFRESH#${tokenHash}`);
    if (record === undefined) return { kind: "unknown" };
    if (record.usedAt !== undefined) return { kind: "reused", sessionId: record.sessionId };
    const session = await this.getSession(record.sessionId);
    if (session === undefined) return { kind: "unknown" };
    if (session.revokedAt !== undefined || session.endsAt <= this.seconds()) return { kind: "ended", session };
    return { kind: "active", session, tokenHash };
  }

  async rotateRefresh(input: { session: SessionRecord; tokenHash: string }): Promise<{ refreshToken: string } | { reused: true }> {
    const refreshToken = randomToken("agxr_");
    const at = this.iso();
    try {
      await this.input.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          { Update: { TableName: this.input.tableName, Key: { pk: `REFRESH#${input.tokenHash}`, sk: META }, UpdateExpression: "SET usedAt = :at", ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(usedAt)", ExpressionAttributeValues: { ":at": at } } },
          { Put: { TableName: this.input.tableName, Item: { pk: `REFRESH#${sha256Hex(refreshToken)}`, sk: META, entityType: "REFRESH_TOKEN", sessionId: input.session.sessionId, expiresAt: input.session.endsAt }, ConditionExpression: "attribute_not_exists(pk)" } },
          { Update: { TableName: this.input.tableName, Key: { pk: `SESSION#${input.session.sessionId}`, sk: META }, UpdateExpression: "SET lastRefreshAt = :at", ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(revokedAt)", ExpressionAttributeValues: { ":at": at } } },
        ],
      }));
    } catch (error) {
      if (conditionFailed(error)) return { reused: true };
      throw error;
    }
    return { refreshToken };
  }

  async revokeSession(sessionId: string, reason: string): Promise<void> {
    await this.input.documentClient.send(new UpdateCommand({
      TableName: this.input.tableName,
      Key: { pk: `SESSION#${sessionId}`, sk: META },
      UpdateExpression: "SET revokedAt = if_not_exists(revokedAt, :at), revokedReason = if_not_exists(revokedReason, :reason)",
      ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeValues: { ":at": this.iso(), ":reason": reason },
    })).catch((error: unknown) => {
      if (!conditionFailed(error)) throw error;
    });
  }
}

function strip<T extends { pk: string; sk: string }>(item: T): Omit<T, "pk" | "sk" | "entityType"> {
  const { pk: _pk, sk: _sk, entityType: _type, ...rest } = item as T & { entityType?: string };
  return rest;
}
```

If `FakeDynamoDb` cannot evaluate a condition used here (for example `#method = :method` or
`expiresAt > :now` on a number), extend `tests/support/fake-dynamodb.ts`'s evaluator for that
operator and add a case for it in `tests/contract/fake-dynamodb.test.ts` if that file exists,
otherwise in this task's test file. Never change the store to suit a gap in the fake.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/contract/developer-signin-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/broker/src/developer/store.ts tests/contract/developer-signin-store.test.ts tests/support/fake-dynamodb.ts
git commit -m "feat(broker): developer sign-in store with hashed codes and rotating refresh tokens"
```

---
### Task 5: Sign-in providers and the Slack directory

**Files:**
- Create: `packages/broker/src/developer/providers.ts`
- Create: `packages/broker/src/developer/slack-directory.ts`
- Modify: `tests/support/developer-fakes.ts` (fake Slack, fake OIDC provider, `routeFetch`)
- Test: `tests/contract/developer-providers.test.ts`, `tests/contract/developer-slack-directory.test.ts`

**Interfaces:**
- Consumes: `SLACK_OIDC_ISSUER`, `DeveloperSignInMethod`, `ChannelMembersResponse`,
  `SlackUserIdSchema`, `cleanDisplayName` from `@agentx/contracts`; `jose`'s `jwtVerify` and
  `JWTVerifyGetKey`.
- Produces (`providers.ts`):
  ```ts
  export interface ProviderIdentity { method: DeveloperSignInMethod; issuer: string; subject: string; displayName: string; email?: string; slackUserId?: string }
  export type ProviderResult = { ok: true; identity: ProviderIdentity } | { ok: false; reason: string };
  export class ProviderUnavailableError extends Error {}   // the provider could not be reached; try again
  export class ProviderNotConfiguredError extends Error {} // an admin must finish setting it up
  export interface SignInProvider {
    readonly method: DeveloperSignInMethod;
    authorizeUrl(input: { state: string; nonce: string; redirectUri: string }): Promise<string>;
    complete(input: { code: string; nonce: string; redirectUri: string }): Promise<ProviderResult>;
  }
  export function slackSignInProvider(input: { teamId: string | undefined; credentials: () => Promise<{ clientId?: string; clientSecret?: string }>; fetch: typeof fetch; jwks: JWTVerifyGetKey; now: () => number }): SignInProvider;
  export function oidcSignInProvider(input: { issuer: string; clientId: string; clientSecret: () => Promise<string>; requiredClaim?: string; requiredValues: readonly string[]; fetch: typeof fetch; jwksFor: (jwksUri: string) => JWTVerifyGetKey; now: () => number }): SignInProvider;
  ```
- Produces (`slack-directory.ts`):
  ```ts
  export type SlackUserStatus = "active" | "gone" | "unavailable";
  export interface SlackDirectory {
    userStatus(userId: string): Promise<SlackUserStatus>;                            // FR-007
    lookupByEmail(email: string): Promise<{ userId: string } | "none" | "unavailable">; // FR-012
    channelMembers(userId: string, channelIds: readonly string[]): Promise<ChannelMembersResponse>; // FR-013
  }
  export const CHANNEL_MEMBERS_CACHE_MS = 600_000;
  export function slackDirectory(input: { teamId: string | undefined; botToken: () => Promise<string>; fetch: typeof fetch; now: () => number; cacheMs?: number; maxPages?: number }): SlackDirectory;
  ```
- Produces (`tests/support/developer-fakes.ts`): `fakeSlack(options)`, `fakeOidc(options)`,
  `routeFetch(...handlers)`, `TEAM = "T0TEAM1"`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`,
  `BOT_TOKEN`, `OIDC_ISSUER`, `OIDC_CLIENT_SECRET`.

- [ ] **Step 1: Add the fakes**

Append to `tests/support/developer-fakes.ts`, moving the new `import` lines to the top of the file:

```ts
import { SignJWT, createLocalJWKSet, type JWTVerifyGetKey } from "jose";

export const TEAM = "T0TEAM1";
export const SLACK_CLIENT_ID = "1111111111.2222222222222";
export const SLACK_CLIENT_SECRET = "0123456789abcdef0123456789abcdef";
export const BOT_TOKEN = "xoxb-1111-2222-plantedbottoken";
export const OIDC_ISSUER = "https://idp.example.test";
export const OIDC_CLIENT_ID = "agentx-developers";
export const OIDC_CLIENT_SECRET = "planted-oidc-client-secret-value";

type Handler = (url: URL, init: RequestInit | undefined) => Promise<Response | undefined>;

/** One fetch for several fakes: the first handler that answers wins; anything else throws. */
export function routeFetch(...handlers: Handler[]): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push(`${init?.method ?? "GET"} ${url.origin}${url.pathname}`);
    for (const handler of handlers) {
      const response = await handler(url, init);
      if (response !== undefined) return response;
    }
    throw new Error(`test setup: unexpected fetch ${url.href}`);
  }) as typeof fetch & { calls: string[] };
  fn.calls = calls;
  return fn;
}

function signingKey() {
  const keys = rsaKeyPair();
  const kid = `k${Math.random().toString(36).slice(2, 8)}`;
  const jwk = { ...keys.publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };
  return { keys, kid, jwks: createLocalJWKSet({ keys: [jwk as never] }), jwk };
}

const form = (init: RequestInit | undefined) => new URLSearchParams(typeof init?.body === "string" ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : "");

export interface FakeSlackUser { userId: string; teamId?: string; name: string; email?: string; emailVerified?: boolean; deleted?: boolean; isBot?: boolean; enterpriseTeams?: string[] }

/** Slack's OpenID Connect and Web API, as far as the sign-in uses them. */
export function fakeSlack(options: { users: FakeSlackUser[]; channels?: Record<string, string[]>; scopes?: string[] }) {
  const signer = signingKey();
  const codes = new Map<string, { user: FakeSlackUser; nonce: string; redirectUri: string; teamId: string }>();
  const state = { down: false, rateLimited: false, secretSeen: [] as string[] };
  const user = (id: string) => options.users.find((candidate) => candidate.userId === id);
  const userJson = (u: FakeSlackUser) => ({
    id: u.userId, team_id: u.teamId ?? TEAM, deleted: u.deleted === true, is_bot: u.isBot === true, real_name: u.name,
    ...(u.enterpriseTeams ? { enterprise_user: { teams: u.enterpriseTeams } } : {}),
  });
  const handler: Handler = async (url, init) => {
    if (url.hostname !== "slack.com") return undefined;
    if (state.down) throw new TypeError("fetch failed");
    if (state.rateLimited) return Response.json({ ok: false, error: "ratelimited" }, { status: 429 });
    const bearer = new Headers(init?.headers).get("authorization");
    if (url.pathname === "/api/openid.connect.token") {
      const body = form(init);
      state.secretSeen.push(body.get("client_secret") ?? "");
      if (body.get("client_id") !== SLACK_CLIENT_ID || body.get("client_secret") !== SLACK_CLIENT_SECRET) return Response.json({ ok: false, error: "invalid_client" });
      const grant = codes.get(body.get("code") ?? "");
      if (grant === undefined || grant.redirectUri !== body.get("redirect_uri")) return Response.json({ ok: false, error: "invalid_code" });
      codes.delete(body.get("code") ?? "");
      const idToken = await new SignJWT({
        nonce: grant.nonce, name: grant.user.name,
        ...(grant.user.email === undefined ? {} : { email: grant.user.email, email_verified: grant.user.emailVerified ?? true }),
        "https://slack.com/user_id": grant.user.userId, "https://slack.com/team_id": grant.teamId,
      }).setProtectedHeader({ alg: "RS256", kid: signer.kid }).setIssuer("https://slack.com").setAudience(SLACK_CLIENT_ID)
        .setSubject(grant.user.userId).setIssuedAt().setExpirationTime("5m").sign(signer.keys.privateKey);
      return Response.json({ ok: true, access_token: "xoxp-user-token-unused", id_token: idToken });
    }
    if (bearer !== `Bearer ${BOT_TOKEN}`) return Response.json({ ok: false, error: "invalid_auth" });
    if (url.pathname === "/api/auth.test") {
      return Response.json({ ok: true, team_id: TEAM, team: "Acme", user_id: "U0BOT0001", bot_id: "B0BOT0001" }, { headers: { "x-oauth-scopes": (options.scopes ?? []).join(",") } });
    }
    if (url.pathname === "/api/users.info") {
      const found = user(url.searchParams.get("user") ?? "");
      return Response.json(found ? { ok: true, user: userJson(found) } : { ok: false, error: "user_not_found" });
    }
    if (url.pathname === "/api/users.lookupByEmail") {
      const found = options.users.find((candidate) => candidate.email === url.searchParams.get("email"));
      return Response.json(found ? { ok: true, user: userJson(found) } : { ok: false, error: "users_not_found" });
    }
    if (url.pathname === "/api/conversations.members") {
      const members = options.channels?.[url.searchParams.get("channel") ?? ""];
      if (members === undefined) return Response.json({ ok: false, error: "channel_not_found" });
      const start = Number(url.searchParams.get("cursor") || "0");
      const page = members.slice(start, start + 2);
      const next = start + 2 < members.length ? String(start + 2) : "";
      return Response.json({ ok: true, members: page, response_metadata: { next_cursor: next } });
    }
    return undefined;
  };
  return {
    state,
    handler,
    jwks: signer.jwks as JWTVerifyGetKey,
    /** What the browser does at Slack: `userId` approves the authorize URL; returns the callback URL. */
    approve(authorizeUrl: string, userId: string, overrides: { teamId?: string } = {}): string {
      const url = new URL(authorizeUrl);
      if (url.origin + url.pathname !== "https://slack.com/openid/connect/authorize") throw new Error(`test setup: not a Slack authorize URL: ${authorizeUrl}`);
      if (url.searchParams.get("client_id") !== SLACK_CLIENT_ID) throw new Error("test setup: wrong client_id");
      const found = user(userId);
      if (found === undefined) throw new Error(`test setup: no Slack user ${userId}`);
      const code = `slack-code-${Math.random().toString(36).slice(2)}`;
      const redirectUri = url.searchParams.get("redirect_uri") ?? "";
      codes.set(code, { user: found, nonce: url.searchParams.get("nonce") ?? "", redirectUri, teamId: overrides.teamId ?? found.teamId ?? TEAM });
      return `${redirectUri}?code=${code}&state=${url.searchParams.get("state") ?? ""}`;
    },
  };
}

export interface FakeOidcUser { sub: string; name?: string; email?: string; email_verified?: boolean; groups?: string[] }

/** A company OIDC provider with discovery, a token endpoint (client_secret_basic) and keys. */
export function fakeOidc(options: { users: FakeOidcUser[] }) {
  const signer = signingKey();
  const codes = new Map<string, { user: FakeOidcUser; nonce: string; redirectUri: string }>();
  const state = { down: false };
  const handler: Handler = async (url, init) => {
    if (url.origin !== OIDC_ISSUER) return undefined;
    if (state.down) throw new TypeError("fetch failed");
    if (url.pathname === "/.well-known/openid-configuration") {
      return Response.json({ issuer: OIDC_ISSUER, authorization_endpoint: `${OIDC_ISSUER}/authorize`, token_endpoint: `${OIDC_ISSUER}/token`, jwks_uri: `${OIDC_ISSUER}/jwks` });
    }
    if (url.pathname === "/token") {
      const expected = `Basic ${Buffer.from(`${encodeURIComponent(OIDC_CLIENT_ID)}:${encodeURIComponent(OIDC_CLIENT_SECRET)}`).toString("base64")}`;
      if (new Headers(init?.headers).get("authorization") !== expected) return Response.json({ error: "invalid_client" }, { status: 401 });
      const body = form(init);
      const grant = codes.get(body.get("code") ?? "");
      if (grant === undefined || grant.redirectUri !== body.get("redirect_uri")) return Response.json({ error: "invalid_grant" }, { status: 400 });
      codes.delete(body.get("code") ?? "");
      const { sub, ...claims } = grant.user;
      const idToken = await new SignJWT({ ...claims, nonce: grant.nonce }).setProtectedHeader({ alg: "RS256", kid: signer.kid })
        .setIssuer(OIDC_ISSUER).setAudience(OIDC_CLIENT_ID).setSubject(sub).setIssuedAt().setExpirationTime("5m").sign(signer.keys.privateKey);
      return Response.json({ access_token: "unused", token_type: "Bearer", id_token: idToken });
    }
    return undefined;
  };
  return {
    state,
    handler,
    jwks: signer.jwks as JWTVerifyGetKey,
    approve(authorizeUrl: string, sub: string): string {
      const url = new URL(authorizeUrl);
      if (url.origin + url.pathname !== `${OIDC_ISSUER}/authorize`) throw new Error(`test setup: not the OIDC authorize URL: ${authorizeUrl}`);
      const found = options.users.find((candidate) => candidate.sub === sub);
      if (found === undefined) throw new Error(`test setup: no OIDC user ${sub}`);
      const code = `oidc-code-${Math.random().toString(36).slice(2)}`;
      const redirectUri = url.searchParams.get("redirect_uri") ?? "";
      codes.set(code, { user: found, nonce: url.searchParams.get("nonce") ?? "", redirectUri });
      return `${redirectUri}?code=${code}&state=${url.searchParams.get("state") ?? ""}`;
    },
  };
}
```

- [ ] **Step 2: Write the failing tests**

```ts
// tests/contract/developer-providers.test.ts
import { describe, expect, it } from "vitest";
import { ProviderNotConfiguredError, ProviderUnavailableError, oidcSignInProvider, slackSignInProvider } from "../../packages/broker/src/developer/providers.js";
import {
  ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_ISSUER, SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, T0, TEAM, fakeOidc, fakeSlack, routeFetch,
} from "../support/developer-fakes.js";

const slackCallback = `${ISSUER}/callback/slack`;
const oidcCallback = `${ISSUER}/callback/oidc`;
const maya = { userId: "U0MAYA001", name: "Maya Chen", email: "maya@example.com" };
const now = () => Date.now();

function slack(overrides: { teamId?: string | undefined; credentials?: { clientId?: string; clientSecret?: string } } = {}) {
  const fake = fakeSlack({ users: [maya] });
  const provider = slackSignInProvider({
    teamId: "teamId" in overrides ? overrides.teamId : TEAM,
    credentials: async () => overrides.credentials ?? { clientId: SLACK_CLIENT_ID, clientSecret: SLACK_CLIENT_SECRET },
    fetch: routeFetch(fake.handler), jwks: fake.jwks, now,
  });
  return { fake, provider };
}

async function codeFrom(callbackUrl: string): Promise<string> {
  return new URL(callbackUrl).searchParams.get("code")!;
}

describe("Sign in with Slack (FR-003)", () => {
  it("sends the browser to Slack with openid email profile, the nonce, the state and the environment's team", async () => {
    const { provider } = slack();
    const url = new URL(await provider.authorizeUrl({ state: "s1", nonce: "n1", redirectUri: slackCallback }));
    expect(url.origin + url.pathname).toBe("https://slack.com/openid/connect/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code", scope: "openid email profile", client_id: SLACK_CLIENT_ID, state: "s1", nonce: "n1", redirect_uri: slackCallback, team: TEAM,
    });
  });

  it("accepts a member of the environment's team, subject = the Slack user ID", async () => {
    const { fake, provider } = slack();
    const authorize = await provider.authorizeUrl({ state: "s1", nonce: "n1", redirectUri: slackCallback });
    const result = await provider.complete({ code: await codeFrom(fake.approve(authorize, maya.userId)), nonce: "n1", redirectUri: slackCallback });
    expect(result).toEqual({ ok: true, identity: { method: "slack", issuer: "https://slack.com", subject: "U0MAYA001", displayName: "Maya Chen", email: "maya@example.com", slackUserId: "U0MAYA001" } });
  });

  it("refuses another team, naming both teams, including another team of the same Grid (SC-007)", async () => {
    const { fake, provider } = slack();
    const authorize = await provider.authorizeUrl({ state: "s1", nonce: "n1", redirectUri: slackCallback });
    const result = await provider.complete({ code: await codeFrom(fake.approve(authorize, maya.userId, { teamId: "T0OTHER1" })), nonce: "n1", redirectUri: slackCallback });
    expect(result).toEqual({ ok: false, reason: `you signed in to Slack workspace T0OTHER1, but this AgentX serves ${TEAM}` });
  });

  it("refuses a nonce that does not match", async () => {
    const { fake, provider } = slack();
    const authorize = await provider.authorizeUrl({ state: "s1", nonce: "n1", redirectUri: slackCallback });
    const result = await provider.complete({ code: await codeFrom(fake.approve(authorize, maya.userId)), nonce: "other", redirectUri: slackCallback });
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/nonce/) });
  });

  it("records the email only when Slack says it is verified", async () => {
    const fake = fakeSlack({ users: [{ ...maya, emailVerified: false }] });
    const provider = slackSignInProvider({ teamId: TEAM, credentials: async () => ({ clientId: SLACK_CLIENT_ID, clientSecret: SLACK_CLIENT_SECRET }), fetch: routeFetch(fake.handler), jwks: fake.jwks, now });
    const authorize = await provider.authorizeUrl({ state: "s", nonce: "n", redirectUri: slackCallback });
    const result = await provider.complete({ code: await codeFrom(fake.approve(authorize, maya.userId)), nonce: "n", redirectUri: slackCallback });
    expect(result.ok).toBe(true);
    expect(result.ok && result.identity.email).toBeUndefined();
  });

  it("refuses to start without a team ID or without the app's client credentials (FR-006)", async () => {
    await expect(slack({ teamId: undefined }).provider.authorizeUrl({ state: "s", nonce: "n", redirectUri: slackCallback })).rejects.toBeInstanceOf(ProviderNotConfiguredError);
    await expect(slack({ credentials: {} }).provider.authorizeUrl({ state: "s", nonce: "n", redirectUri: slackCallback })).rejects.toBeInstanceOf(ProviderNotConfiguredError);
  });

  it("reports Slack being down or rate limiting as unavailable, never as a refusal", async () => {
    const { fake, provider } = slack();
    const authorize = await provider.authorizeUrl({ state: "s", nonce: "n", redirectUri: slackCallback });
    const code = await codeFrom(fake.approve(authorize, maya.userId));
    fake.state.down = true;
    await expect(provider.complete({ code, nonce: "n", redirectUri: slackCallback })).rejects.toBeInstanceOf(ProviderUnavailableError);
    fake.state.down = false;
    fake.state.rateLimited = true;
    await expect(provider.complete({ code, nonce: "n", redirectUri: slackCallback })).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it("never puts the client secret in an error", async () => {
    const { fake, provider } = slack({ credentials: { clientId: SLACK_CLIENT_ID, clientSecret: "ffffffffffffffffffffffffffffffff" } });
    const authorize = await provider.authorizeUrl({ state: "s", nonce: "n", redirectUri: slackCallback });
    const result = await provider.complete({ code: await codeFrom(fake.approve(authorize, maya.userId)), nonce: "n", redirectUri: slackCallback });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("ffffffffffffffffffffffffffffffff");
  });
});

describe("company sign-in (FR-004)", () => {
  const users = [
    { sub: "okta-1", name: "Ravi", email: "ravi@example.com", email_verified: true, groups: ["engineering", "staff"] },
    { sub: "okta-2", name: "Sam", email: "sam@example.com", email_verified: false, groups: ["sales"] },
  ];
  function oidc(requiredClaim?: string, requiredValues: string[] = []) {
    const fake = fakeOidc({ users });
    const provider = oidcSignInProvider({
      issuer: OIDC_ISSUER, clientId: OIDC_CLIENT_ID, clientSecret: async () => OIDC_CLIENT_SECRET,
      ...(requiredClaim === undefined ? {} : { requiredClaim }), requiredValues,
      fetch: routeFetch(fake.handler), jwksFor: () => fake.jwks, now,
    });
    return { fake, provider };
  }
  async function signIn(provider: ReturnType<typeof oidc>["provider"], fake: ReturnType<typeof oidc>["fake"], sub: string) {
    const authorize = await provider.authorizeUrl({ state: "s", nonce: "n", redirectUri: oidcCallback });
    return provider.complete({ code: await codeFrom(fake.approve(authorize, sub)), nonce: "n", redirectUri: oidcCallback });
  }

  it("uses the discovery document's authorization endpoint with openid email profile", async () => {
    const { provider } = oidc();
    const url = new URL(await provider.authorizeUrl({ state: "s", nonce: "n", redirectUri: oidcCallback }));
    expect(url.origin + url.pathname).toBe(`${OIDC_ISSUER}/authorize`);
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.searchParams.get("client_id")).toBe(OIDC_CLIENT_ID);
  });

  it("accepts a person in the required group, with their verified email", async () => {
    const { fake, provider } = oidc("groups", ["engineering"]);
    expect(await signIn(provider, fake, "okta-1")).toEqual({ ok: true, identity: { method: "oidc", issuer: OIDC_ISSUER, subject: "okta-1", displayName: "Ravi", email: "ravi@example.com" } });
  });

  it("refuses a person outside the required group and names the group (US4 scenario 3)", async () => {
    const { fake, provider } = oidc("groups", ["engineering", "platform"]);
    expect(await signIn(provider, fake, "okta-2")).toEqual({ ok: false, reason: "this AgentX requires the groups claim to include engineering or platform" });
  });

  it("drops an unverified email", async () => {
    const { fake, provider } = oidc();
    const result = await signIn(provider, fake, "okta-2");
    expect(result.ok && result.identity.email).toBe(undefined);
  });

  it("reports an unreachable provider as unavailable", async () => {
    const { fake, provider } = oidc();
    fake.state.down = true;
    await expect(provider.authorizeUrl({ state: "s", nonce: "n", redirectUri: oidcCallback })).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it("refuses a discovery document whose issuer is not the configured one", async () => {
    const fake = fakeOidc({ users });
    const provider = oidcSignInProvider({
      issuer: "https://other.example.test", clientId: OIDC_CLIENT_ID, clientSecret: async () => OIDC_CLIENT_SECRET, requiredValues: [],
      fetch: routeFetch(async (url, init) => (url.origin === "https://other.example.test" ? fake.handler(new URL(url.pathname, OIDC_ISSUER), init) : undefined)),
      jwksFor: () => fake.jwks, now,
    });
    await expect(provider.authorizeUrl({ state: "s", nonce: "n", redirectUri: oidcCallback })).rejects.toBeInstanceOf(ProviderNotConfiguredError);
  });
});

void T0;
```

```ts
// tests/contract/developer-slack-directory.test.ts
import { describe, expect, it } from "vitest";
import { slackDirectory } from "../../packages/broker/src/developer/slack-directory.js";
import { BOT_TOKEN, T0, TEAM, fakeSlack, routeFetch } from "../support/developer-fakes.js";

function directory(users: Parameters<typeof fakeSlack>[0]["users"], channels: Record<string, string[]> = {}) {
  let clock = T0;
  const fake = fakeSlack({ users, channels });
  const fetch = routeFetch(fake.handler);
  const dir = slackDirectory({ teamId: TEAM, botToken: async () => BOT_TOKEN, fetch, now: () => clock });
  return { fake, fetch, dir, tick: (ms: number) => { clock += ms; } };
}

describe("users.info at refresh (FR-007, R22)", () => {
  it("is active for a person in the team, including an Enterprise Grid member of it", async () => {
    const { dir } = directory([{ userId: "U0A000001", name: "A" }, { userId: "U0B000001", name: "B", teamId: "T0HOME01", enterpriseTeams: [TEAM] }]);
    expect(await dir.userStatus("U0A000001")).toBe("active");
    expect(await dir.userStatus("U0B000001")).toBe("active");
  });

  it("is gone for a deactivated user, a bot, a user of another team, or an unknown user", async () => {
    const { dir } = directory([
      { userId: "U0D000001", name: "D", deleted: true },
      { userId: "U0E000001", name: "E", isBot: true },
      { userId: "U0F000001", name: "F", teamId: "T0OTHER1" },
    ]);
    for (const id of ["U0D000001", "U0E000001", "U0F000001", "U0NOBODY1"]) expect(await dir.userStatus(id)).toBe("gone");
  });

  it("is unavailable when Slack is down or rate limits, so a refresh never signs anyone out for it", async () => {
    const { dir, fake } = directory([{ userId: "U0A000001", name: "A" }]);
    fake.state.down = true;
    expect(await dir.userStatus("U0A000001")).toBe("unavailable");
    fake.state.down = false;
    fake.state.rateLimited = true;
    expect(await dir.userStatus("U0A000001")).toBe("unavailable");
  });
});

describe("users.lookupByEmail (FR-012)", () => {
  it("links an active person in the team, and nobody else", async () => {
    const { dir } = directory([
      { userId: "U0A000001", name: "A", email: "a@example.com" },
      { userId: "U0D000001", name: "D", email: "d@example.com", deleted: true },
    ]);
    expect(await dir.lookupByEmail("a@example.com")).toEqual({ userId: "U0A000001" });
    expect(await dir.lookupByEmail("d@example.com")).toBe("none");
    expect(await dir.lookupByEmail("nobody@example.com")).toBe("none");
  });
});

describe("conversations.members (FR-013)", () => {
  it("pages through members and answers which channels the user is in", async () => {
    const { dir } = directory([], { C0PAY0001: ["U01", "U02", "U03", "U0MAYA001"], C0LEDGER1: ["U01"] });
    expect(await dir.channelMembers("U0MAYA001", ["C0PAY0001", "C0LEDGER1"])).toEqual({ ok: true, memberOf: ["C0PAY0001"] });
  });

  it("caches a channel's members for at most 10 minutes", async () => {
    const { dir, fetch, tick } = directory([], { C0PAY0001: ["U0MAYA001"] });
    await dir.channelMembers("U0MAYA001", ["C0PAY0001"]);
    tick(599_000);
    await dir.channelMembers("U0OTHER01", ["C0PAY0001"]);
    expect(fetch.calls.filter((call) => call.includes("conversations.members"))).toHaveLength(1);
    tick(2_000);
    await dir.channelMembers("U0MAYA001", ["C0PAY0001"]);
    expect(fetch.calls.filter((call) => call.includes("conversations.members"))).toHaveLength(2);
  });

  it("fails closed when Slack cannot be reached or a channel cannot be read", async () => {
    const { dir, fake } = directory([], { C0PAY0001: ["U0MAYA001"] });
    expect(await dir.channelMembers("U0MAYA001", ["C0GONE001"])).toEqual({ ok: false, error: "slack_unavailable" });
    fake.state.down = true;
    expect(await dir.channelMembers("U0MAYA001", ["C0PAY0001"])).toEqual({ ok: false, error: "slack_unavailable" });
  });

  it("is unavailable, not empty, when the environment has no team ID", async () => {
    const fake = fakeSlack({ users: [] });
    const dir = slackDirectory({ teamId: undefined, botToken: async () => BOT_TOKEN, fetch: routeFetch(fake.handler), now: () => T0 });
    expect(await dir.channelMembers("U0MAYA001", ["C0PAY0001"])).toEqual({ ok: false, error: "slack_unavailable" });
    expect(await dir.userStatus("U0MAYA001")).toBe("unavailable");
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run tests/contract/developer-providers.test.ts tests/contract/developer-slack-directory.test.ts`
Expected: FAIL, the modules do not exist.

- [ ] **Step 4: Implement the providers**

```ts
// packages/broker/src/developer/providers.ts
// Spec 025 FR-002 to FR-004: the Slack and company OIDC providers. The code exchange runs here,
// server side, with the client secret; the laptop never sees it.
import { jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { SLACK_OIDC_ISSUER, SlackUserIdSchema, cleanDisplayName, type DeveloperSignInMethod } from "@agentx/contracts";

export interface ProviderIdentity { method: DeveloperSignInMethod; issuer: string; subject: string; displayName: string; email?: string; slackUserId?: string }
export type ProviderResult = { ok: true; identity: ProviderIdentity } | { ok: false; reason: string };
export class ProviderUnavailableError extends Error { override name = "ProviderUnavailableError"; }
export class ProviderNotConfiguredError extends Error { override name = "ProviderNotConfiguredError"; }

export interface SignInProvider {
  readonly method: DeveloperSignInMethod;
  authorizeUrl(input: { state: string; nonce: string; redirectUri: string }): Promise<string>;
  complete(input: { code: string; nonce: string; redirectUri: string }): Promise<ProviderResult>;
}

const SCOPES = "openid email profile";
const TIMEOUT_MS = 8_000;

async function call(fetchFn: typeof fetch, url: string, init: RequestInit, what: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchFn(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new ProviderUnavailableError(`${what} could not be reached`);
  }
  if (response.status === 429 || response.status >= 500) throw new ProviderUnavailableError(`${what} answered HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new ProviderUnavailableError(`${what} answered with something other than JSON`);
  }
}

async function verifyIdToken(idToken: string, jwks: JWTVerifyGetKey, options: { issuer: string; audience: string; nonce: string; now: number }): Promise<{ ok: true; payload: JWTPayload } | { ok: false; reason: string }> {
  try {
    const { payload } = await jwtVerify(idToken, jwks, { issuer: options.issuer, audience: options.audience, currentDate: new Date(options.now), algorithms: ["RS256", "ES256"] });
    if (payload.nonce !== options.nonce) return { ok: false, reason: "the identity token's nonce does not match this sign-in; run agentx login again" };
    return { ok: true, payload };
  } catch (error) {
    return { ok: false, reason: `the identity token could not be verified (${error instanceof Error ? error.name : "invalid"}); run agentx login again` };
  }
}

const verifiedEmail = (payload: JWTPayload): string | undefined =>
  typeof payload.email === "string" && (payload.email_verified === true || payload.email_verified === "true") ? payload.email : undefined;

export function slackSignInProvider(input: {
  teamId: string | undefined; credentials: () => Promise<{ clientId?: string; clientSecret?: string }>; fetch: typeof fetch; jwks: JWTVerifyGetKey; now: () => number;
}): SignInProvider {
  const configured = async () => {
    if (input.teamId === undefined) throw new ProviderNotConfiguredError("this AgentX environment has no Slack team ID yet");
    const { clientId, clientSecret } = await input.credentials();
    if (clientId === undefined || clientSecret === undefined) throw new ProviderNotConfiguredError("the Slack app's client ID and client secret are not stored yet");
    return { teamId: input.teamId, clientId, clientSecret };
  };
  return {
    method: "slack",
    async authorizeUrl({ state, nonce, redirectUri }) {
      const { teamId, clientId } = await configured();
      const url = new URL("https://slack.com/openid/connect/authorize");
      for (const [key, value] of Object.entries({ response_type: "code", scope: SCOPES, client_id: clientId, state, nonce, redirect_uri: redirectUri, team: teamId })) url.searchParams.set(key, value);
      return url.toString();
    },
    async complete({ code, nonce, redirectUri }) {
      const { teamId, clientId, clientSecret } = await configured();
      const body = await call(input.fetch, "https://slack.com/api/openid.connect.token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }).toString(),
      }, "Slack") as { ok?: boolean; error?: string; id_token?: string };
      if (body.error === "ratelimited") throw new ProviderUnavailableError("Slack is rate limiting sign-ins");
      if (body.ok !== true || typeof body.id_token !== "string") {
        return { ok: false, reason: `Slack refused the sign-in (${typeof body.error === "string" ? body.error.replace(/[^a-z_]/g, "") : "no reason given"}); run agentx login again` };
      }
      const verified = await verifyIdToken(body.id_token, input.jwks, { issuer: SLACK_OIDC_ISSUER, audience: clientId, nonce, now: input.now() });
      if (!verified.ok) return verified;
      const team = verified.payload["https://slack.com/team_id"];
      if (team !== teamId) return { ok: false, reason: `you signed in to Slack workspace ${typeof team === "string" ? team : "unknown"}, but this AgentX serves ${teamId}` };
      const userId = SlackUserIdSchema.safeParse(verified.payload["https://slack.com/user_id"]);
      if (!userId.success) return { ok: false, reason: "Slack's identity token names no Slack user; run agentx login again" };
      const email = verifiedEmail(verified.payload);
      return {
        ok: true,
        identity: {
          method: "slack", issuer: SLACK_OIDC_ISSUER, subject: userId.data,
          displayName: (typeof verified.payload.name === "string" ? cleanDisplayName(verified.payload.name) : undefined) ?? userId.data,
          ...(email === undefined ? {} : { email }),
          slackUserId: userId.data,
        },
      };
    },
  };
}

interface Discovery { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string }

export function oidcSignInProvider(input: {
  issuer: string; clientId: string; clientSecret: () => Promise<string>; requiredClaim?: string; requiredValues: readonly string[];
  fetch: typeof fetch; jwksFor: (jwksUri: string) => JWTVerifyGetKey; now: () => number;
}): SignInProvider {
  const issuer = input.issuer.replace(/\/+$/, "");
  let discovery: Promise<Discovery> | undefined;
  const discover = () => {
    discovery ??= call(input.fetch, `${issuer}/.well-known/openid-configuration`, {}, "the company sign-in provider").then((value) => {
      const doc = value as Partial<Discovery>;
      if (typeof doc.issuer !== "string" || doc.issuer.replace(/\/+$/, "") !== issuer) {
        throw new ProviderNotConfiguredError(`the company sign-in provider's discovery document names issuer ${String(doc.issuer)}, not ${issuer}`);
      }
      for (const key of ["authorization_endpoint", "token_endpoint", "jwks_uri"] as const) {
        if (typeof doc[key] !== "string" || !doc[key].startsWith("https://")) throw new ProviderNotConfiguredError(`the company sign-in provider's discovery document has no HTTPS ${key}`);
      }
      return doc as Discovery;
    }).catch((error: unknown) => {
      discovery = undefined;
      throw error;
    });
    return discovery;
  };
  return {
    method: "oidc",
    async authorizeUrl({ state, nonce, redirectUri }) {
      const doc = await discover();
      const url = new URL(doc.authorization_endpoint);
      for (const [key, value] of Object.entries({ response_type: "code", scope: SCOPES, client_id: input.clientId, state, nonce, redirect_uri: redirectUri })) url.searchParams.set(key, value);
      return url.toString();
    },
    async complete({ code, nonce, redirectUri }) {
      const doc = await discover();
      const secret = await input.clientSecret();
      const basic = Buffer.from(`${encodeURIComponent(input.clientId)}:${encodeURIComponent(secret)}`).toString("base64");
      const body = await call(input.fetch, doc.token_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${basic}` },
        body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri }).toString(),
      }, "the company sign-in provider") as { id_token?: string; error?: string };
      if (typeof body.id_token !== "string") {
        return { ok: false, reason: `the company sign-in provider refused the sign-in (${typeof body.error === "string" ? body.error.replace(/[^a-z_]/g, "") : "no reason given"}); run agentx login again` };
      }
      const verified = await verifyIdToken(body.id_token, input.jwksFor(doc.jwks_uri), { issuer: doc.issuer, audience: input.clientId, nonce, now: input.now() });
      if (!verified.ok) return verified;
      const payload = verified.payload;
      if (input.requiredClaim !== undefined && input.requiredValues.length > 0) {
        const raw = payload[input.requiredClaim];
        const values = Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === "string") : typeof raw === "string" ? raw.split(/[\s,]+/) : [];
        if (!input.requiredValues.some((value) => values.includes(value))) {
          return { ok: false, reason: `this AgentX requires the ${input.requiredClaim} claim to include ${input.requiredValues.join(" or ")}` };
        }
      }
      if (typeof payload.sub !== "string" || payload.sub === "") return { ok: false, reason: "the identity token has no subject; ask an admin to check the company sign-in app" };
      const email = verifiedEmail(payload);
      const name = [payload.name, payload.preferred_username, email].find((value): value is string => typeof value === "string" && value !== "");
      return {
        ok: true,
        identity: {
          method: "oidc", issuer, subject: payload.sub,
          displayName: (name === undefined ? undefined : cleanDisplayName(name)) ?? payload.sub,
          ...(email === undefined ? {} : { email }),
        },
      };
    },
  };
}
```

- [ ] **Step 5: Implement the Slack directory**

```ts
// packages/broker/src/developer/slack-directory.ts
// Spec 025 FR-007, FR-012 and FR-013 with the bot token. Every failure to reach Slack is
// "unavailable": the caller fails closed for access and keeps sessions for refreshes (R18).
import type { ChannelMembersResponse } from "@agentx/contracts";

export type SlackUserStatus = "active" | "gone" | "unavailable";
export interface SlackDirectory {
  userStatus(userId: string): Promise<SlackUserStatus>;
  lookupByEmail(email: string): Promise<{ userId: string } | "none" | "unavailable">;
  channelMembers(userId: string, channelIds: readonly string[]): Promise<ChannelMembersResponse>;
}

export const CHANNEL_MEMBERS_CACHE_MS = 600_000;
const CACHE_CAP = 500;
const TIMEOUT_MS = 5_000;

interface SlackUser { id?: string; team_id?: string; deleted?: boolean; is_bot?: boolean; enterprise_user?: { teams?: string[] } }

export function slackDirectory(input: {
  teamId: string | undefined; botToken: () => Promise<string>; fetch: typeof fetch; now: () => number; cacheMs?: number; maxPages?: number;
}): SlackDirectory {
  const cacheMs = input.cacheMs ?? CHANNEL_MEMBERS_CACHE_MS;
  const maxPages = input.maxPages ?? 50;
  const members = new Map<string, { at: number; users: Set<string> }>();

  const get = async (method: string, query: Record<string, string>): Promise<Record<string, unknown> | undefined> => {
    try {
      const url = new URL(`https://slack.com/api/${method}`);
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
      const response = await input.fetch(url, { headers: { authorization: `Bearer ${await input.botToken()}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (response.status === 429 || response.status >= 500) return undefined;
      return await response.json() as Record<string, unknown>;
    } catch {
      return undefined;
    }
  };
  const inTeam = (user: SlackUser) =>
    user.deleted !== true && user.is_bot === false && (user.team_id === input.teamId || (user.enterprise_user?.teams ?? []).includes(input.teamId ?? ""));

  return {
    async userStatus(userId) {
      if (input.teamId === undefined) return "unavailable";
      const body = await get("users.info", { user: userId });
      if (body === undefined) return "unavailable";
      if (body.ok !== true) return body.error === "user_not_found" || body.error === "account_inactive" ? "gone" : "unavailable";
      return inTeam(body.user as SlackUser) ? "active" : "gone";
    },
    async lookupByEmail(email) {
      if (input.teamId === undefined) return "unavailable";
      const body = await get("users.lookupByEmail", { email });
      if (body === undefined) return "unavailable";
      if (body.ok !== true) return body.error === "users_not_found" ? "none" : "unavailable";
      const user = body.user as SlackUser;
      return inTeam(user) && typeof user.id === "string" ? { userId: user.id } : "none";
    },
    async channelMembers(userId, channelIds) {
      if (input.teamId === undefined) return { ok: false, error: "slack_unavailable" };
      const memberOf: string[] = [];
      for (const channelId of [...new Set(channelIds)].sort()) {
        let entry = members.get(channelId);
        if (entry === undefined || input.now() - entry.at >= cacheMs) {
          const users = new Set<string>();
          let cursor = "";
          for (let page = 0; ; page += 1) {
            if (page >= maxPages) return { ok: false, error: "slack_unavailable" };
            const body = await get("conversations.members", { channel: channelId, limit: "1000", ...(cursor === "" ? {} : { cursor }) });
            if (body === undefined || body.ok !== true || !Array.isArray(body.members)) return { ok: false, error: "slack_unavailable" };
            for (const member of body.members) if (typeof member === "string") users.add(member);
            cursor = String((body.response_metadata as { next_cursor?: unknown } | undefined)?.next_cursor ?? "");
            if (cursor === "") break;
          }
          if (members.size >= CACHE_CAP) members.delete(members.keys().next().value as string);
          entry = { at: input.now(), users };
          members.set(channelId, entry);
        }
        if (entry.users.has(userId)) memberOf.push(channelId);
      }
      return { ok: true, memberOf };
    },
  };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/contract/developer-providers.test.ts tests/contract/developer-slack-directory.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/broker/src/developer/providers.ts packages/broker/src/developer/slack-directory.ts tests/support/developer-fakes.ts tests/contract/developer-providers.test.ts tests/contract/developer-slack-directory.test.ts
git commit -m "feat(broker): Slack and company sign-in providers and the Slack directory"
```

---

### Task 6: The sign-in server

**Files:**
- Create: `packages/broker/src/developer/server.ts`
- Create: `packages/broker/src/aws/developer-identity.ts`
- Modify: `tests/support/developer-fakes.ts` (event builders and a server harness)
- Test: `tests/contract/developer-identity-server.test.ts`

**Interfaces:**
- Consumes: Tasks 2 to 5; `adaptHttpApiEvent`, `ownerKeyForSubject`, `HttpApiV2Event` from
  `packages/broker/src/aws/lambda.ts`.
- Produces (`server.ts`):
  ```ts
  export interface DeveloperIdentityConfig { env: string; issuer: string; slack: { enabled: boolean; teamId?: string }; oidc?: { displayName: string } }
  export interface DeveloperIdentityDependencies {
    config: DeveloperIdentityConfig; store: DeveloperSignInStore; signer: TokenSigner;
    providers: Partial<Record<DeveloperSignInMethod, SignInProvider>>; directory: SlackDirectory;
    now: () => number; log: (entry: Record<string, unknown>) => void;
  }
  export interface HttpResult { statusCode: number; headers: Record<string, string>; body: string }
  export function createDeveloperIdentityHandler(deps: DeveloperIdentityDependencies): (event: HttpApiV2Event | ChannelMembersRequest) => Promise<HttpResult | ChannelMembersResponse>;
  export function enabledMethods(deps: Pick<DeveloperIdentityDependencies, "config" | "providers">): DeveloperSignInMethod[];
  ```
- Produces (`packages/broker/src/aws/developer-identity.ts`):
  - `developerIdentityConfigFromEnvironment(env: NodeJS.ProcessEnv): DeveloperIdentityConfig & { oidcSettings?: { issuer: string; clientId: string; requiredClaim?: string; requiredValues: string[] } }`;
  - `parseSlackSignInSecret(json: string): { botToken: string; clientId?: string; clientSecret?: string }`;
  - `export const handler`, the Lambda entry.
- Routes, exactly:

  | Route | Result |
  |---|---|
  | `GET /v1/auth/.well-known/openid-configuration` | discovery; `issuer` equals the configured issuer exactly |
  | `GET /v1/auth/.well-known/jwks.json` | `{ keys: [publicJwk] }` |
  | `GET /v1/auth/.well-known/agentx-configuration` | `AgentXConfiguration` |
  | `GET /v1/auth/authorize` | method page, or 302 to the only method's provider |
  | `GET /v1/auth/callback/slack`, `/callback/oidc` | 302 to the CLI's loopback with `code` or `error` |
  | `POST /v1/auth/token` | `authorization_code` or `refresh_token` grant |
  | `POST /v1/auth/revoke` | RFC 7009: always 200; ends the session of a known refresh token |
  | direct invoke `{ kind: "channel-members" }` | `ChannelMembersResponse` |

- [ ] **Step 1: Add the event builders and harness**

Append to `tests/support/developer-fakes.ts`, moving the new `import` lines to the top of the file (merge the `node:crypto` import with the existing one):

```ts
import { createHash } from "node:crypto";
import type { HttpApiV2Event } from "../../packages/broker/src/aws/lambda.js";
import type { DeveloperIdentityDependencies, HttpResult } from "../../packages/broker/src/developer/server.js";
import { createDeveloperIdentityHandler } from "../../packages/broker/src/developer/server.js";
import { oidcSignInProvider, slackSignInProvider } from "../../packages/broker/src/developer/providers.js";
import { slackDirectory } from "../../packages/broker/src/developer/slack-directory.js";
import { DeveloperSignInStore } from "../../packages/broker/src/developer/store.js";
import { FakeDynamoDb } from "./fake-dynamodb.js";

export function httpEvent(method: "GET" | "POST", pathAndQuery: string, body?: Record<string, string>): HttpApiV2Event {
  const url = new URL(pathAndQuery, API);
  return {
    version: "2.0",
    rawPath: url.pathname,
    rawQueryString: url.search.slice(1),
    headers: body === undefined ? {} : { "content-type": "application/x-www-form-urlencoded" },
    ...(body === undefined ? {} : { body: Buffer.from(new URLSearchParams(body).toString()).toString("base64"), isBase64Encoded: true }),
    requestContext: { requestId: "req-1", http: { method } },
  };
}

export const CLI_REDIRECT = "http://127.0.0.1:49152/callback";
export const VERIFIER = "v".repeat(64);
export const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

export function authorizeQuery(overrides: Record<string, string> = {}): string {
  return `/v1/auth/authorize?${new URLSearchParams({
    response_type: "code", client_id: "agentx-cli", redirect_uri: CLI_REDIRECT, code_challenge: CHALLENGE, code_challenge_method: "S256", state: "cli-state", ...overrides,
  }).toString()}`;
}

/** The sign-in server with fake Slack, fake OIDC, fake DynamoDB and the fake KMS signer. */
export function identityHarness(options: {
  slack?: boolean; teamId?: string | undefined; oidc?: { requiredClaim?: string; requiredValues?: string[] };
  slackUsers?: FakeSlackUser[]; oidcUsers?: FakeOidcUser[]; channels?: Record<string, string[]>;
  slackCredentials?: { clientId?: string; clientSecret?: string };
} = {}) {
  let clock = T0;
  const now = () => clock;
  const db = new FakeDynamoDb();
  const slack = fakeSlack({ users: options.slackUsers ?? [], ...(options.channels ? { channels: options.channels } : {}) });
  const oidc = fakeOidc({ users: options.oidcUsers ?? [] });
  const fetch = routeFetch(slack.handler, oidc.handler);
  const signer = localSigner();
  const logs: Array<Record<string, unknown>> = [];
  const teamId = "teamId" in options ? options.teamId : TEAM;
  const providers: DeveloperIdentityDependencies["providers"] = {
    slack: slackSignInProvider({ teamId, credentials: async () => options.slackCredentials ?? { clientId: SLACK_CLIENT_ID, clientSecret: SLACK_CLIENT_SECRET }, fetch, jwks: slack.jwks, now }),
    ...(options.oidc === undefined ? {} : {
      oidc: oidcSignInProvider({
        issuer: OIDC_ISSUER, clientId: OIDC_CLIENT_ID, clientSecret: async () => OIDC_CLIENT_SECRET,
        ...(options.oidc.requiredClaim === undefined ? {} : { requiredClaim: options.oidc.requiredClaim }),
        requiredValues: options.oidc.requiredValues ?? [], fetch, jwksFor: () => oidc.jwks, now,
      }),
    }),
  };
  const deps: DeveloperIdentityDependencies = {
    config: {
      env: "staging", issuer: ISSUER,
      slack: { enabled: options.slack ?? true, ...(teamId === undefined ? {} : { teamId }) },
      ...(options.oidc === undefined ? {} : { oidc: { displayName: "Okta" } }),
    },
    store: new DeveloperSignInStore({ documentClient: db, tableName: "signin", now }),
    signer,
    providers,
    directory: slackDirectory({ teamId, botToken: async () => BOT_TOKEN, fetch, now }),
    now,
    log: (entry) => logs.push(entry),
  };
  const handler = createDeveloperIdentityHandler(deps);
  const http = async (event: HttpApiV2Event) => handler(event) as Promise<HttpResult>;
  return {
    db, slack, oidc, fetch, signer, logs, deps, handler, http,
    tick: (ms: number) => { clock += ms; },
    now,
    /** GET authorize, follow to the provider, approve as `who`, follow the callback: the CLI's loopback URL. */
    async signIn(method: "slack" | "oidc", who: string, extra: { teamId?: string; query?: Record<string, string> } = {}): Promise<URL> {
      let response = await http(httpEvent("GET", authorizeQuery(extra.query)));
      if (response.statusCode === 200) {
        const link = new RegExp(`href="([^"]*method=${method})"`).exec(response.body)?.[1];
        if (link === undefined) throw new Error(`test setup: no ${method} link on the method page`);
        response = await http(httpEvent("GET", link.replaceAll("&amp;", "&")));
      }
      if (response.statusCode !== 302) return new URL(`${API}/unexpected-${response.statusCode}`);
      const providerUrl = response.headers.location!;
      if (providerUrl.startsWith(CLI_REDIRECT)) return new URL(providerUrl);
      const callback = method === "slack" ? slack.approve(providerUrl, who, extra.teamId === undefined ? {} : { teamId: extra.teamId }) : oidc.approve(providerUrl, who);
      const back = await http(httpEvent("GET", callback));
      return new URL(back.headers.location ?? `${API}/no-redirect-${back.statusCode}`);
    },
    async exchange(code: string, overrides: Record<string, string> = {}) {
      const response = await http(httpEvent("POST", "/v1/auth/token", { grant_type: "authorization_code", client_id: "agentx-cli", code, code_verifier: VERIFIER, redirect_uri: CLI_REDIRECT, ...overrides }));
      return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
    },
    async refresh(refreshToken: string) {
      const response = await http(httpEvent("POST", "/v1/auth/token", { grant_type: "refresh_token", client_id: "agentx-cli", refresh_token: refreshToken }));
      return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
    },
  };
}
```

- [ ] **Step 2: Write the failing test**

```ts
// tests/contract/developer-identity-server.test.ts
import { createLocalJWKSet, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import {
  API, BOT_TOKEN, CLI_REDIRECT, ISSUER, OIDC_CLIENT_SECRET, OIDC_ISSUER, SLACK_CLIENT_SECRET, TEAM, authorizeQuery, httpEvent, identityHarness,
} from "../support/developer-fakes.js";

const maya = { userId: "U0MAYA001", name: "Maya Chen", email: "maya@example.com" };
const mayaId = ownerKeyForSubject("https://slack.com", "U0MAYA001");
const json = (body: string) => JSON.parse(body) as Record<string, unknown>;

describe("discovery (FR-001, FR-048)", () => {
  it("publishes an OpenID configuration whose issuer is exactly the authorizer's, and the JWKS", async () => {
    const h = identityHarness();
    const discovery = json((await h.http(httpEvent("GET", "/v1/auth/.well-known/openid-configuration"))).body);
    expect(discovery).toMatchObject({
      issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, revocation_endpoint: `${ISSUER}/revoke`,
      jwks_uri: `${ISSUER}/.well-known/jwks.json`, code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"],
      id_token_signing_alg_values_supported: ["RS256"],
    });
    expect(json((await h.http(httpEvent("GET", "/v1/auth/.well-known/jwks.json"))).body)).toEqual(await h.signer.jwks());
  });

  it("reports the environment, API version and the methods that can actually be used", async () => {
    const both = identityHarness({ oidc: {} });
    expect(json((await both.http(httpEvent("GET", "/v1/auth/.well-known/agentx-configuration"))).body)).toEqual({
      env: "staging", apiVersion: "1.0", issuer: ISSUER, authorizationEndpoint: `${ISSUER}/authorize`, tokenEndpoint: `${ISSUER}/token`,
      revocationEndpoint: `${ISSUER}/revoke`, clientId: "agentx-cli", methods: { slack: true, oidc: { displayName: "Okta" } },
    });
    // FR-006: Slack sign-in is refused while the team ID is unset, so it is not offered.
    const noTeam = identityHarness({ teamId: undefined });
    expect(json((await noTeam.http(httpEvent("GET", "/v1/auth/.well-known/agentx-configuration"))).body)).toMatchObject({ methods: { slack: false, oidc: null } });
  });
});

describe("authorize (FR-001, FR-002)", () => {
  it("never redirects to a URI that is not the CLI's loopback, and names the problem", async () => {
    const h = identityHarness();
    for (const query of [{ client_id: "other" }, { redirect_uri: "https://evil.example.test/callback" }, { redirect_uri: "http://localhost:1/callback" }]) {
      const response = await h.http(httpEvent("GET", authorizeQuery(query)));
      expect(response.statusCode).toBe(400);
      expect(response.headers.location).toBeUndefined();
      expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(response.body).toContain("agentx login");
    }
  });

  it("sends a bad PKCE or response type back to the CLI as invalid_request", async () => {
    const h = identityHarness();
    for (const query of [{ code_challenge_method: "plain" }, { code_challenge: "short" }, { response_type: "token" }, { state: "" }]) {
      const location = new URL((await h.http(httpEvent("GET", authorizeQuery(query)))).headers.location!);
      expect(`${location.origin}${location.pathname}`).toBe(CLI_REDIRECT);
      expect(location.searchParams.get("error")).toBe("invalid_request");
    }
  });

  it("goes straight to the only enabled method, with a server-held state and nonce", async () => {
    const h = identityHarness();
    const response = await h.http(httpEvent("GET", authorizeQuery()));
    expect(response.statusCode).toBe(302);
    const slack = new URL(response.headers.location!);
    expect(slack.origin).toBe("https://slack.com");
    expect(slack.searchParams.get("state")).not.toBe("cli-state");
    expect(slack.searchParams.get("nonce")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(slack.searchParams.get("redirect_uri")).toBe(`${ISSUER}/callback/slack`);
  });

  it("shows a page with each enabled method when there are two, escaping the display name", async () => {
    const h = identityHarness({ oidc: {} });
    h.deps.config.oidc = { displayName: "<Okta & co>" };
    const response = await h.http(httpEvent("GET", authorizeQuery()));
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Sign in with Slack");
    expect(response.body).toContain("Sign in with &lt;Okta &amp; co&gt;");
    expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
  });

  it("tells the CLI when no method is enabled", async () => {
    const h = identityHarness({ slack: false });
    const location = new URL((await h.http(httpEvent("GET", authorizeQuery()))).headers.location!);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("error_description")).toContain("agentx signin enable");
  });
});

describe("Sign in with Slack end to end (US4 scenario 1, FR-003, FR-005, FR-008)", () => {
  it("issues a code to the loopback, then an access token the developer authorizer accepts and a refresh token", async () => {
    const h = identityHarness({ slackUsers: [maya] });
    const back = await h.signIn("slack", maya.userId);
    expect(`${back.origin}${back.pathname}`).toBe(CLI_REDIRECT);
    expect(back.searchParams.get("state")).toBe("cli-state");
    const code = back.searchParams.get("code")!;
    const { status, body } = await h.exchange(code);
    expect(status).toBe(200);
    expect(body).toMatchObject({ token_type: "Bearer", expires_in: 3600 });
    const { payload } = await jwtVerify(String(body.access_token), createLocalJWKSet(await h.signer.jwks()), { issuer: ISSUER, audience: "agentx-developer", currentDate: new Date(h.now()) });
    expect(payload).toMatchObject({ sub: mayaId, amr: "slack", env: "staging" });
    expect(h.db.get(`DEVELOPER#${mayaId}`, "META")).toMatchObject({ provider: "slack", displayName: "Maya Chen", email: "maya@example.com", slackUserId: "U0MAYA001", revoked: false });
  });

  it("refuses another Slack team: no code, no developer record, the reason goes to the CLI (US4 scenario 2, SC-007)", async () => {
    const h = identityHarness({ slackUsers: [maya] });
    const back = await h.signIn("slack", maya.userId, { teamId: "T0OTHER1" });
    expect(back.searchParams.get("code")).toBeNull();
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("error_description")).toBe(`you signed in to Slack workspace T0OTHER1, but this AgentX serves ${TEAM}`);
    expect(h.db.get(`DEVELOPER#${mayaId}`, "META")).toBeUndefined();
    expect(h.logs).toContainEqual(expect.objectContaining({ event: "signin.refused", method: "slack" }));
  });

  it("refuses a developer an admin revoked", async () => {
    const h = identityHarness({ slackUsers: [maya] });
    h.db.set({ pk: `DEVELOPER#${mayaId}`, sk: "META", developerId: mayaId, provider: "slack", issuer: "https://slack.com", subject: "U0MAYA001", displayName: "Maya", firstSignInAt: "x", lastSignInAt: "x", revoked: true });
    const back = await h.signIn("slack", maya.userId);
    expect(back.searchParams.get("error")).toBe("access_denied");
  });

  it("uses a callback state once, and not after 10 minutes", async () => {
    const h = identityHarness({ slackUsers: [maya] });
    const start = await h.http(httpEvent("GET", authorizeQuery()));
    const callback = h.slack.approve(start.headers.location!, maya.userId);
    expect((await h.http(httpEvent("GET", callback))).statusCode).toBe(302);
    expect((await h.http(httpEvent("GET", callback))).statusCode).toBe(400);
    const late = await h.http(httpEvent("GET", authorizeQuery()));
    const lateCallback = h.slack.approve(late.headers.location!, maya.userId);
    h.tick(601_000);
    expect((await h.http(httpEvent("GET", lateCallback))).statusCode).toBe(400);
  });

  it("sends a Slack outage back to the CLI as temporarily_unavailable", async () => {
    const h = identityHarness({ slackUsers: [maya] });
    const start = await h.http(httpEvent("GET", authorizeQuery()));
    const callback = h.slack.approve(start.headers.location!, maya.userId);
    h.slack.state.down = true;
    const location = new URL((await h.http(httpEvent("GET", callback))).headers.location!);
    expect(location.searchParams.get("error")).toBe("temporarily_unavailable");
  });
});

describe("company sign-in (US4 scenario 3, FR-004, FR-012)", () => {
  const ravi = { sub: "okta-ravi", name: "Ravi", email: "ravi@example.com", email_verified: true, groups: ["engineering"] };
  const sam = { sub: "okta-sam", name: "Sam", email: "sam@example.com", email_verified: true, groups: ["sales"] };

  it("refuses a person outside the required group, naming it", async () => {
    const h = identityHarness({ slack: false, oidc: { requiredClaim: "groups", requiredValues: ["engineering"] }, oidcUsers: [sam] });
    const back = await h.signIn("oidc", "okta-sam");
    expect(back.searchParams.get("error_description")).toBe("this AgentX requires the groups claim to include engineering");
  });

  it("links a company user to the Slack user with the same verified email", async () => {
    const h = identityHarness({ slack: false, oidc: { requiredClaim: "groups", requiredValues: ["engineering"] }, oidcUsers: [ravi], slackUsers: [{ userId: "U0RAVI001", name: "Ravi", email: "ravi@example.com" }] });
    const back = await h.signIn("oidc", "okta-ravi");
    expect((await h.exchange(back.searchParams.get("code")!)).status).toBe(200);
    expect(h.db.get(`DEVELOPER#${ownerKeyForSubject(OIDC_ISSUER, "okta-ravi")}`, "META")).toMatchObject({ provider: "oidc", email: "ravi@example.com", slackUserId: "U0RAVI001" });
  });

  it("keeps the earlier Slack link when Slack is down at sign-in (R18)", async () => {
    const h = identityHarness({ slack: false, oidc: {}, oidcUsers: [ravi], slackUsers: [{ userId: "U0RAVI001", name: "Ravi", email: "ravi@example.com" }] });
    await h.signIn("oidc", "okta-ravi");
    h.slack.state.down = true;
    const back = await h.signIn("oidc", "okta-ravi");
    expect(back.searchParams.get("code")).not.toBeNull();
    expect(h.db.get(`DEVELOPER#${ownerKeyForSubject(OIDC_ISSUER, "okta-ravi")}`, "META")).toMatchObject({ slackUserId: "U0RAVI001" });
  });
});

describe("the token endpoint (FR-001, FR-005, FR-007)", () => {
  async function signedIn() {
    const h = identityHarness({ slackUsers: [maya] });
    const code = (await h.signIn("slack", maya.userId)).searchParams.get("code")!;
    const first = await h.exchange(code);
    return { h, code, refreshToken: String(first.body.refresh_token) };
  }

  it("refuses a reused code, a wrong verifier, a wrong redirect URI and another client", async () => {
    const h = identityHarness({ slackUsers: [maya] });
    const code = (await h.signIn("slack", maya.userId)).searchParams.get("code")!;
    expect((await h.exchange(code, { code_verifier: "w".repeat(64) })).body).toEqual({ error: "invalid_grant", error_description: expect.any(String) });
    const code2 = (await h.signIn("slack", maya.userId)).searchParams.get("code")!;
    expect((await h.exchange(code2, { redirect_uri: "http://127.0.0.1:1/callback" })).body.error).toBe("invalid_grant");
    const code3 = (await h.signIn("slack", maya.userId)).searchParams.get("code")!;
    expect((await h.exchange(code3, { client_id: "other" })).status).toBe(401);
    expect((await h.exchange(code3)).status).toBe(200);
    expect((await h.exchange(code3)).body.error).toBe("invalid_grant");
  });

  it("rotates refresh tokens and keeps the 7-day end (US4 scenario 4)", async () => {
    const { h, refreshToken } = await signedIn();
    h.tick(3_600_000);
    const next = await h.refresh(refreshToken);
    expect(next.status).toBe(200);
    expect(next.body.refresh_token).not.toBe(refreshToken);
    h.tick(6 * 86_400_000);
    expect((await h.refresh(String(next.body.refresh_token))).status).toBe(200);
  });

  it("revokes the whole session when an old refresh token is used again (FR-005)", async () => {
    const { h, refreshToken } = await signedIn();
    const next = await h.refresh(refreshToken);
    expect((await h.refresh(refreshToken)).body.error).toBe("invalid_grant");
    expect((await h.refresh(String(next.body.refresh_token))).body.error).toBe("invalid_grant");
    expect(h.logs).toContainEqual(expect.objectContaining({ event: "signin.session_revoked", reason: "refresh_token_reused" }));
  });

  it("ends the session 7 days after the provider sign-in (US4 scenario 5)", async () => {
    const { h, refreshToken } = await signedIn();
    h.tick(604_801_000);
    expect((await h.refresh(refreshToken)).body.error).toBe("invalid_grant");
  });

  it("fails and revokes when the Slack user is deactivated (FR-007)", async () => {
    const h = identityHarness({ slackUsers: [maya] });
    const code = (await h.signIn("slack", maya.userId)).searchParams.get("code")!;
    const { body } = await h.exchange(code);
    maya.deleted = true;
    try {
      const refused = await h.refresh(String(body.refresh_token));
      expect(refused.body).toMatchObject({ error: "invalid_grant", error_description: expect.stringContaining("no longer active") });
    } finally {
      delete maya.deleted;
    }
  });

  it("keeps the session when Slack cannot be reached at refresh (Review Focus 3, R18)", async () => {
    const { h, refreshToken } = await signedIn();
    h.slack.state.down = true;
    const unavailable = await h.refresh(refreshToken);
    expect(unavailable.status).toBe(503);
    expect(unavailable.body.error).toBe("temporarily_unavailable");
    h.slack.state.down = false;
    h.slack.state.rateLimited = true;
    expect((await h.refresh(refreshToken)).status).toBe(503);
    h.slack.state.rateLimited = false;
    expect((await h.refresh(refreshToken)).status).toBe(200);
  });

  it("refuses a refresh once the method is disabled, and revokes that session (FR-045, R13)", async () => {
    const { h, refreshToken } = await signedIn();
    h.deps.config.slack.enabled = false;
    expect((await h.refresh(refreshToken)).body.error).toBe("invalid_grant");
    h.deps.config.slack.enabled = true;
    expect((await h.refresh(refreshToken)).body.error).toBe("invalid_grant");
  });

  it("answers unsupported_grant_type for anything else", async () => {
    const h = identityHarness();
    const response = await h.http(httpEvent("POST", "/v1/auth/token", { grant_type: "password", client_id: "agentx-cli" }));
    expect(json(response.body).error).toBe("unsupported_grant_type");
    expect(response.headers["cache-control"]).toBe("no-store");
  });
});

describe("revocation and the channel-members invoke", () => {
  it("ends the session of a revoked refresh token and always answers 200 (RFC 7009, R14)", async () => {
    const h = identityHarness({ slackUsers: [maya] });
    const { body } = await h.exchange((await h.signIn("slack", maya.userId)).searchParams.get("code")!);
    expect((await h.http(httpEvent("POST", "/v1/auth/revoke", { token: String(body.refresh_token), client_id: "agentx-cli" }))).statusCode).toBe(200);
    expect((await h.refresh(String(body.refresh_token))).body.error).toBe("invalid_grant");
    expect((await h.http(httpEvent("POST", "/v1/auth/revoke", { token: "agxr_unknown", client_id: "agentx-cli" }))).statusCode).toBe(200);
  });

  it("answers which bound channels a Slack user is in", async () => {
    const h = identityHarness({ channels: { C0PAY0001: ["U0MAYA001"], C0LEDGER1: [] } });
    expect(await h.handler({ kind: "channel-members", slackUserId: "U0MAYA001", channelIds: ["C0PAY0001", "C0LEDGER1"] })).toEqual({ ok: true, memberOf: ["C0PAY0001"] });
  });
});

describe("secrets never leave", () => {
  it("keeps client secrets, the bot token, codes and refresh tokens out of every log line and HTML page", async () => {
    const h = identityHarness({ slackUsers: [maya], oidc: {}, oidcUsers: [{ sub: "okta-1", email: "a@example.com", email_verified: true }] });
    const pages: string[] = [];
    const slackBack = await h.signIn("slack", maya.userId);
    const code = slackBack.searchParams.get("code")!;
    const { body } = await h.exchange(code);
    const refreshed = await h.refresh(String(body.refresh_token));
    await h.refresh(String(body.refresh_token));
    pages.push((await h.http(httpEvent("GET", authorizeQuery()))).body);
    const everything = JSON.stringify(h.logs) + pages.join("");
    for (const secret of [SLACK_CLIENT_SECRET, OIDC_CLIENT_SECRET, BOT_TOKEN, code, String(body.refresh_token), String(refreshed.body.refresh_token), String(body.access_token)]) {
      expect(everything).not.toContain(secret);
    }
  });
});

void API;
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run tests/contract/developer-identity-server.test.ts`
Expected: FAIL, `server.js` does not exist.

- [ ] **Step 4: Implement the server**

```ts
// packages/broker/src/developer/server.ts
// Spec 025 FR-001 to FR-008: the control plane as the developers' sign-in server. Behind
// ANY /v1/auth/{proxy+} with no authorizer, plus one direct-invoke operation for the broker.
import { randomBytes } from "node:crypto";
import {
  AGENTX_CLI_CLIENT_ID,
  ChannelMembersRequestSchema,
  DEVELOPER_API_VERSION,
  isLoopbackRedirectUri,
  type ChannelMembersRequest,
  type ChannelMembersResponse,
  type DeveloperSignInMethod,
} from "@agentx/contracts";
import { adaptHttpApiEvent, ownerKeyForSubject, type HttpApiV2Event } from "../aws/lambda.js";
import { ProviderNotConfiguredError, ProviderUnavailableError, type SignInProvider } from "./providers.js";
import type { SlackDirectory } from "./slack-directory.js";
import type { DeveloperSignInStore, SessionRecord } from "./store.js";
import { issueAccessToken, type TokenSigner } from "./tokens.js";

export interface DeveloperIdentityConfig { env: string; issuer: string; slack: { enabled: boolean; teamId?: string }; oidc?: { displayName: string } }
export interface DeveloperIdentityDependencies {
  config: DeveloperIdentityConfig;
  store: DeveloperSignInStore;
  signer: TokenSigner;
  providers: Partial<Record<DeveloperSignInMethod, SignInProvider>>;
  directory: SlackDirectory;
  now: () => number;
  log: (entry: Record<string, unknown>) => void;
}
export interface HttpResult { statusCode: number; headers: Record<string, string>; body: string }

const CHALLENGE = /^[A-Za-z0-9_-]{43,128}$/;
const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store" };
const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
};

export function enabledMethods(deps: Pick<DeveloperIdentityDependencies, "config" | "providers">): DeveloperSignInMethod[] {
  const methods: DeveloperSignInMethod[] = [];
  if (deps.config.slack.enabled && deps.config.slack.teamId !== undefined && deps.providers.slack !== undefined) methods.push("slack");
  if (deps.config.oidc !== undefined && deps.providers.oidc !== undefined) methods.push("oidc");
  return methods;
}

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function page(statusCode: number, title: string, paragraphs: string[], links: Array<{ href: string; label: string }> = []): HttpResult {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title>`
    + `<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5}a.method{display:block;margin:.75rem 0;padding:.75rem 1rem;border:1px solid #888;border-radius:.5rem;text-decoration:none;color:inherit}</style></head>`
    + `<body><main><h1>${escape(title)}</h1>${paragraphs.map((p) => `<p>${escape(p)}</p>`).join("")}`
    + `${links.map((link) => `<a class="method" href="${escape(link.href)}">${escape(link.label)}</a>`).join("")}</main></body></html>`;
  return { statusCode, headers: HTML_HEADERS, body };
}

const jsonResult = (statusCode: number, body: unknown, headers: Record<string, string> = {}): HttpResult =>
  ({ statusCode, headers: { ...JSON_HEADERS, ...headers }, body: JSON.stringify(body) });
const redirect = (location: string): HttpResult => ({ statusCode: 302, headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer" }, body: "" });
const oauthError = (status: number, error: string, description: string) => jsonResult(status, { error, error_description: description });

function toClient(redirectUri: string, params: Record<string, string>): HttpResult {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return redirect(url.toString());
}

export function createDeveloperIdentityHandler(deps: DeveloperIdentityDependencies) {
  const { config, store } = deps;
  const endpoint = (path: string) => `${config.issuer}${path}`;
  const methodLabel = (method: DeveloperSignInMethod) => (method === "slack" ? "Slack" : config.oidc?.displayName ?? "company sign-in");

  async function tokens(session: SessionRecord, refreshToken: string): Promise<HttpResult> {
    const access = await issueAccessToken(deps.signer, { issuer: config.issuer, subject: session.developerId, amr: session.amr, env: config.env, sessionId: session.sessionId, now: deps.now() });
    return jsonResult(200, { access_token: access.token, token_type: "Bearer", expires_in: access.expiresIn, refresh_token: refreshToken });
  }

  async function revoke(sessionId: string, reason: string): Promise<void> {
    await store.revokeSession(sessionId, reason);
    deps.log({ event: "signin.session_revoked", sessionId, reason });
  }

  async function authorize(query: URLSearchParams): Promise<HttpResult> {
    const methods = enabledMethods(deps);
    const requestId = query.get("request");
    if (requestId !== null) {
      const method = query.get("method");
      if ((method !== "slack" && method !== "oidc") || !methods.includes(method)) return page(400, "Sign-in method not available", ["Run agentx login again."]);
      const request = await store.chooseMethod(requestId, method);
      if (request === undefined) return page(400, "This sign-in link has expired", ["Run agentx login again."]);
      return toProvider(request.id, request.nonce, method, request.clientRedirectUri, request.clientState);
    }
    const redirectUri = query.get("redirect_uri") ?? "";
    if (query.get("client_id") !== AGENTX_CLI_CLIENT_ID || !isLoopbackRedirectUri(redirectUri)) {
      return page(400, "This sign-in link is not from the AgentX CLI", ["Start signing in from your terminal with agentx login <url>."]);
    }
    const clientState = query.get("state") ?? "";
    const challenge = query.get("code_challenge") ?? "";
    const invalid = (description: string) => toClient(redirectUri, { error: "invalid_request", error_description: description, ...(clientState === "" ? {} : { state: clientState }) });
    if (query.get("response_type") !== "code") return invalid("response_type must be code");
    if (query.get("code_challenge_method") !== "S256" || !CHALLENGE.test(challenge)) return invalid("PKCE with S256 is required");
    if (clientState.length < 1 || clientState.length > 512) return invalid("state is required");
    if (methods.length === 0) {
      return toClient(redirectUri, { error: "access_denied", state: clientState, error_description: "developer sign-in is not enabled in this AgentX environment; ask an admin to run agentx signin enable slack" });
    }
    const request = await store.createAuthRequest({ clientRedirectUri: redirectUri, clientState, codeChallenge: challenge, nonce: randomBytes(32).toString("base64url") });
    if (methods.length === 1) {
      const method = methods[0]!;
      await store.chooseMethod(request.id, method);
      return toProvider(request.id, request.nonce, method, redirectUri, clientState);
    }
    return page(200, "Sign in to AgentX", [`Environment: ${config.env}`], methods.map((method) => ({
      href: `${endpoint("/authorize")}?request=${encodeURIComponent(request.id)}&method=${method}`,
      label: `Sign in with ${methodLabel(method)}`,
    })));
  }

  async function toProvider(requestId: string, nonce: string, method: DeveloperSignInMethod, clientRedirect: string, clientState: string): Promise<HttpResult> {
    try {
      return redirect(await deps.providers[method]!.authorizeUrl({ state: requestId, nonce, redirectUri: endpoint(`/callback/${method}`) }));
    } catch (error) {
      return providerFailure(error, method, clientRedirect, clientState);
    }
  }

  function providerFailure(error: unknown, method: DeveloperSignInMethod, clientRedirect: string, clientState: string): HttpResult {
    if (error instanceof ProviderUnavailableError) {
      deps.log({ event: "signin.provider_unavailable", method });
      return toClient(clientRedirect, { error: "temporarily_unavailable", state: clientState, error_description: `${methodLabel(method)} could not be reached; run agentx login again in a minute` });
    }
    if (error instanceof ProviderNotConfiguredError) {
      deps.log({ event: "signin.not_configured", method, detail: error.message });
      return toClient(clientRedirect, { error: "access_denied", state: clientState, error_description: `${methodLabel(method)} sign-in is not finished: ${error.message}; ask an admin to run agentx signin check` });
    }
    throw error;
  }

  async function callback(method: DeveloperSignInMethod, query: URLSearchParams): Promise<HttpResult> {
    const state = query.get("state") ?? "";
    const pending = await store.getAuthRequest(state);
    if (pending === undefined || pending.method !== method) return page(400, "This sign-in link has expired", ["Run agentx login again."]);
    const request = await store.consumeAuthRequest(state, method);
    if (request === undefined) return page(400, "This sign-in link was already used", ["Run agentx login again."]);
    const client = (params: Record<string, string>) => toClient(request.clientRedirectUri, { ...params, state: request.clientState });
    const code = query.get("code");
    if (code === null) return client({ error: "access_denied", error_description: `the sign-in was cancelled at ${methodLabel(method)}` });
    let result;
    try {
      result = await deps.providers[method]!.complete({ code, nonce: request.nonce, redirectUri: endpoint(`/callback/${method}`) });
    } catch (error) {
      return providerFailure(error, method, request.clientRedirectUri, request.clientState);
    }
    if (!result.ok) {
      deps.log({ event: "signin.refused", method, reason: result.reason });
      return client({ error: "access_denied", error_description: result.reason });
    }
    const identity = result.identity;
    const developerId = ownerKeyForSubject(identity.issuer, identity.subject);
    const existing = await store.getDeveloper(developerId);
    if (existing?.revoked === true) {
      deps.log({ event: "signin.refused", method, reason: "developer_revoked", developerId });
      return client({ error: "access_denied", error_description: "your AgentX sign-in was turned off by an admin; contact an admin" });
    }
    let slackUserId = identity.slackUserId;
    if (slackUserId === undefined && identity.email !== undefined) {
      const link = await deps.directory.lookupByEmail(identity.email);
      slackUserId = link === "unavailable" ? existing?.slackUserId : link === "none" ? undefined : link.userId;
    }
    await store.upsertDeveloper({
      developerId, provider: method, issuer: identity.issuer, subject: identity.subject, displayName: identity.displayName,
      ...(identity.email === undefined ? {} : { email: identity.email }),
      ...(slackUserId === undefined ? {} : { slackUserId }),
    });
    const agentxCode = await store.issueCode({ developerId, amr: method, ...(slackUserId === undefined ? {} : { slackUserId }), codeChallenge: request.codeChallenge, redirectUri: request.clientRedirectUri });
    deps.log({ event: "signin.succeeded", method, developerId, linkedToSlack: slackUserId !== undefined });
    return client({ code: agentxCode });
  }

  async function token(form: URLSearchParams): Promise<HttpResult> {
    if (form.get("client_id") !== AGENTX_CLI_CLIENT_ID) return oauthError(401, "invalid_client", "unknown client");
    const methods = enabledMethods(deps);
    const grant = form.get("grant_type");
    if (grant === "authorization_code") {
      const redeemed = await store.redeemCode({ code: form.get("code") ?? "", verifier: form.get("code_verifier") ?? "", redirectUri: form.get("redirect_uri") ?? "" });
      if (redeemed === undefined) return oauthError(400, "invalid_grant", "the sign-in code is invalid, used or expired; run agentx login again");
      if (!methods.includes(redeemed.amr)) return oauthError(400, "invalid_grant", "that sign-in method was turned off; run agentx login again");
      const developer = await store.getDeveloper(redeemed.developerId);
      if (developer === undefined || developer.revoked) return oauthError(400, "invalid_grant", "your AgentX sign-in was turned off by an admin");
      const { session, refreshToken } = await store.createSession(redeemed);
      deps.log({ event: "signin.session_started", method: redeemed.amr, developerId: redeemed.developerId, sessionId: session.sessionId });
      return tokens(session, refreshToken);
    }
    if (grant === "refresh_token") {
      const lookup = await store.lookupRefresh(form.get("refresh_token") ?? "");
      const ended = oauthError(400, "invalid_grant", "your AgentX sign-in has ended; run agentx login again");
      if (lookup.kind === "unknown") return ended;
      if (lookup.kind === "reused") {
        await revoke(lookup.sessionId, "refresh_token_reused");
        return ended;
      }
      if (lookup.kind === "ended") return ended;
      const { session } = lookup;
      if (!methods.includes(session.amr)) {
        await revoke(session.sessionId, "method_disabled");
        return oauthError(400, "invalid_grant", `${methodLabel(session.amr)} sign-in was turned off in this environment; sign in another way with agentx login`);
      }
      const developer = await store.getDeveloper(session.developerId);
      if (developer === undefined || developer.revoked) {
        await revoke(session.sessionId, "developer_revoked");
        return ended;
      }
      if (session.amr === "slack" && session.slackUserId !== undefined) {
        const status = await deps.directory.userStatus(session.slackUserId);
        if (status === "unavailable") return oauthError(503, "temporarily_unavailable", "Slack could not be reached to check your account; your sign-in is kept, try again in a few minutes");
        if (status === "gone") {
          await revoke(session.sessionId, "slack_user_inactive");
          return oauthError(400, "invalid_grant", "your Slack account is no longer active in this workspace; contact an admin");
        }
      }
      const rotated = await store.rotateRefresh(lookup);
      if ("reused" in rotated) {
        await revoke(session.sessionId, "refresh_token_reused");
        return ended;
      }
      return tokens(session, rotated.refreshToken);
    }
    return oauthError(400, "unsupported_grant_type", "use authorization_code or refresh_token");
  }

  async function revokeToken(form: URLSearchParams): Promise<HttpResult> {
    const lookup = await store.lookupRefresh(form.get("token") ?? "");
    if (lookup.kind === "active" || lookup.kind === "ended") await revoke(lookup.session.sessionId, "signed_out");
    if (lookup.kind === "reused") await revoke(lookup.sessionId, "signed_out");
    return jsonResult(200, {});
  }

  const configuration = () => ({
    env: config.env,
    apiVersion: DEVELOPER_API_VERSION,
    issuer: config.issuer,
    authorizationEndpoint: endpoint("/authorize"),
    tokenEndpoint: endpoint("/token"),
    revocationEndpoint: endpoint("/revoke"),
    clientId: AGENTX_CLI_CLIENT_ID,
    methods: { slack: enabledMethods(deps).includes("slack"), oidc: enabledMethods(deps).includes("oidc") ? { displayName: config.oidc!.displayName } : null },
  });

  return async (event: HttpApiV2Event | ChannelMembersRequest): Promise<HttpResult | ChannelMembersResponse> => {
    if ("kind" in event) {
      const parsed = ChannelMembersRequestSchema.safeParse(event);
      if (!parsed.success) return { ok: false, error: "slack_unavailable" };
      return deps.directory.channelMembers(parsed.data.slackUserId, parsed.data.channelIds);
    }
    const request = adaptHttpApiEvent(event);
    const url = new URL(request.path, "https://agentx.invalid");
    try {
      if (request.method === "GET") {
        switch (url.pathname) {
          case "/v1/auth/.well-known/openid-configuration":
            return jsonResult(200, {
              issuer: config.issuer, authorization_endpoint: endpoint("/authorize"), token_endpoint: endpoint("/token"), revocation_endpoint: endpoint("/revoke"),
              jwks_uri: endpoint("/.well-known/jwks.json"), response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
              code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"], subject_types_supported: ["public"],
              id_token_signing_alg_values_supported: ["RS256"], scopes_supported: ["openid"],
            }, { "cache-control": "public, max-age=300" });
          case "/v1/auth/.well-known/jwks.json":
            return jsonResult(200, { keys: [await deps.signer.publicJwk()] }, { "cache-control": "public, max-age=300" });
          case "/v1/auth/.well-known/agentx-configuration":
            return jsonResult(200, configuration());
          case "/v1/auth/authorize":
            return await authorize(url.searchParams);
          case "/v1/auth/callback/slack":
            return await callback("slack", url.searchParams);
          case "/v1/auth/callback/oidc":
            return await callback("oidc", url.searchParams);
        }
      }
      if (request.method === "POST" && (url.pathname === "/v1/auth/token" || url.pathname === "/v1/auth/revoke")) {
        const form = new URLSearchParams(request.body ?? "");
        return url.pathname === "/v1/auth/token" ? await token(form) : await revokeToken(form);
      }
      return jsonResult(404, { error: "not_found" });
    } catch (error) {
      deps.log({ event: "signin.error", path: url.pathname, error: error instanceof Error ? error.name : "unknown" });
      return url.pathname.endsWith("/token") || url.pathname.endsWith("/revoke")
        ? oauthError(500, "server_error", "sign-in failed on the server; try again")
        : page(500, "Sign-in failed", ["Something went wrong on the AgentX server. Run agentx login again."]);
    }
  };
}
```

- [ ] **Step 5: Implement the Lambda entry**

```ts
// packages/broker/src/aws/developer-identity.ts
// The DeveloperIdentity Lambda (spec 025 phase 25a): wires the sign-in server to AWS. The only
// new role that reads the Slack secret (R2); it never logs a secret.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { KMSClient } from "@aws-sdk/client-kms";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { createRemoteJWKSet, type JWTVerifyGetKey } from "jose";
import type { ChannelMembersRequest } from "@agentx/contracts";
import { oidcSignInProvider, slackSignInProvider } from "../developer/providers.js";
import { createDeveloperIdentityHandler, type DeveloperIdentityConfig } from "../developer/server.js";
import { slackDirectory } from "../developer/slack-directory.js";
import { DeveloperSignInStore } from "../developer/store.js";
import { kmsTokenSigner } from "../developer/tokens.js";
import { requiredEnvironment, type HttpApiV2Event } from "./lambda.js";

const SECRET_CACHE_MS = 5 * 60 * 1000;

export function developerIdentityConfigFromEnvironment(env: NodeJS.ProcessEnv): DeveloperIdentityConfig & { oidcSettings?: { issuer: string; clientId: string; requiredClaim?: string; requiredValues: string[] } } {
  const issuer = env.DEVELOPER_OIDC_ISSUER ?? "";
  const teamId = env.SLACK_TEAM_ID ?? "";
  let requiredValues: string[] = [];
  try {
    const parsed = JSON.parse(env.DEVELOPER_OIDC_REQUIRED_VALUES ?? "[]") as unknown;
    if (Array.isArray(parsed)) requiredValues = parsed.filter((value): value is string => typeof value === "string" && value !== "");
  } catch {
    throw new Error("DEVELOPER_OIDC_REQUIRED_VALUES must be a JSON array of strings");
  }
  const requiredClaim = env.DEVELOPER_OIDC_REQUIRED_CLAIM ?? "";
  return {
    env: requiredEnvironment("AGENTX_ENV"),
    issuer: requiredEnvironment("DEVELOPER_TOKEN_ISSUER"),
    slack: { enabled: env.DEVELOPER_SIGNIN_SLACK === "enabled", ...(teamId === "" ? {} : { teamId }) },
    ...(issuer === "" ? {} : {
      oidc: { displayName: env.DEVELOPER_OIDC_DISPLAY_NAME || "Company sign-in" },
      oidcSettings: { issuer, clientId: requiredEnvironment("DEVELOPER_OIDC_CLIENT_ID"), ...(requiredClaim === "" ? {} : { requiredClaim }), requiredValues },
    }),
  };
}

export function parseSlackSignInSecret(json: string): { botToken: string; clientId?: string; clientSecret?: string } {
  const value = JSON.parse(json) as Record<string, unknown>;
  if (typeof value.botToken !== "string" || !value.botToken.startsWith("xoxb-")) throw new Error("the Slack secret has no bot token yet");
  return {
    botToken: value.botToken,
    ...(typeof value.clientId === "string" && value.clientId !== "" ? { clientId: value.clientId } : {}),
    ...(typeof value.clientSecret === "string" && value.clientSecret !== "" ? { clientSecret: value.clientSecret } : {}),
  };
}

function cachedSecret<T>(client: SecretsManagerClient, secretId: string, parse: (text: string) => T): () => Promise<T> {
  let cached: { value: Promise<T>; at: number } | undefined;
  return () => {
    if (cached === undefined || Date.now() - cached.at > SECRET_CACHE_MS) {
      const value = client.send(new GetSecretValueCommand({ SecretId: secretId })).then((response) => {
        if (!response.SecretString) throw new Error(`secret ${secretId} is empty`);
        return parse(response.SecretString);
      });
      cached = { value, at: Date.now() };
      value.catch(() => { cached = undefined; });
    }
    return cached.value;
  };
}

let built: ReturnType<typeof createDeveloperIdentityHandler> | undefined;

function build(): ReturnType<typeof createDeveloperIdentityHandler> {
  const region = process.env.AWS_REGION === undefined ? {} : { region: process.env.AWS_REGION };
  const config = developerIdentityConfigFromEnvironment(process.env);
  const secrets = new SecretsManagerClient(region);
  const slackSecret = cachedSecret(secrets, requiredEnvironment("SLACK_SECRET_ARN"), parseSlackSignInSecret);
  const now = () => Date.now();
  const jwksCache = new Map<string, JWTVerifyGetKey>();
  const jwksFor = (uri: string) => {
    let jwks = jwksCache.get(uri);
    if (jwks === undefined) {
      jwks = createRemoteJWKSet(new URL(uri));
      jwksCache.set(uri, jwks);
    }
    return jwks;
  };
  const oidc = config.oidcSettings;
  return createDeveloperIdentityHandler({
    config,
    store: new DeveloperSignInStore({
      documentClient: DynamoDBDocumentClient.from(new DynamoDBClient(region), { marshallOptions: { removeUndefinedValues: true } }),
      tableName: requiredEnvironment("DEVELOPER_SIGNIN_TABLE_NAME"),
      now,
    }),
    signer: kmsTokenSigner({ kms: new KMSClient(region), keyId: requiredEnvironment("DEVELOPER_TOKEN_KEY_ARN") }),
    providers: {
      slack: slackSignInProvider({ teamId: config.slack.teamId, credentials: async () => slackSecret(), fetch, jwks: jwksFor("https://slack.com/openid/connect/keys"), now }),
      ...(oidc === undefined ? {} : {
        oidc: oidcSignInProvider({
          ...oidc,
          clientSecret: cachedSecret(secrets, requiredEnvironment("DEVELOPER_OIDC_SECRET_ID"), (text) => {
            const secret = (JSON.parse(text) as { clientSecret?: unknown }).clientSecret;
            if (typeof secret !== "string" || secret === "") throw new Error("the company sign-in secret has no clientSecret");
            return secret;
          }),
          fetch, jwksFor, now,
        }),
      }),
    },
    directory: slackDirectory({ teamId: config.slack.teamId, botToken: async () => (await slackSecret()).botToken, fetch, now }),
    now,
    log: (entry) => console.log(JSON.stringify(entry)),
  });
}

export const handler = async (event: HttpApiV2Event | ChannelMembersRequest) => {
  built ??= build();
  return built(event);
};
```

Add to the test file a `describe("the Lambda's configuration")` block:

```ts
import { developerIdentityConfigFromEnvironment, parseSlackSignInSecret } from "../../packages/broker/src/aws/developer-identity.js";

describe("the Lambda's configuration", () => {
  const base = { AGENTX_ENV: "staging", DEVELOPER_TOKEN_ISSUER: ISSUER };
  it("turns Slack on only for enabled, keeps an empty team ID unset, and company sign-in off without an issuer", () => {
    expect(developerIdentityConfigFromEnvironment({ ...base, DEVELOPER_SIGNIN_SLACK: "enabled", SLACK_TEAM_ID: "" })).toEqual({ env: "staging", issuer: ISSUER, slack: { enabled: true } });
    expect(developerIdentityConfigFromEnvironment({ ...base, DEVELOPER_SIGNIN_SLACK: "disabled", SLACK_TEAM_ID: TEAM }).slack).toEqual({ enabled: false, teamId: TEAM });
  });
  it("reads the company settings", () => {
    expect(developerIdentityConfigFromEnvironment({ ...base, DEVELOPER_OIDC_ISSUER: OIDC_ISSUER, DEVELOPER_OIDC_CLIENT_ID: "c", DEVELOPER_OIDC_REQUIRED_CLAIM: "groups", DEVELOPER_OIDC_REQUIRED_VALUES: "[\"engineering\"]", DEVELOPER_OIDC_DISPLAY_NAME: "Okta" }))
      .toMatchObject({ oidc: { displayName: "Okta" }, oidcSettings: { issuer: OIDC_ISSUER, clientId: "c", requiredClaim: "groups", requiredValues: ["engineering"] } });
  });
  it("parses the Slack secret with or without the sign-in keys, and never echoes it", () => {
    expect(parseSlackSignInSecret(JSON.stringify({ signingSecret: "s", botToken: BOT_TOKEN }))).toEqual({ botToken: BOT_TOKEN });
    expect(parseSlackSignInSecret(JSON.stringify({ botToken: BOT_TOKEN, clientId: "1.2", clientSecret: SLACK_CLIENT_SECRET }))).toEqual({ botToken: BOT_TOKEN, clientId: "1.2", clientSecret: SLACK_CLIENT_SECRET });
    expect(() => parseSlackSignInSecret(JSON.stringify({ botToken: "unset", clientSecret: SLACK_CLIENT_SECRET }))).toThrow(/^the Slack secret has no bot token yet$/);
  });
});
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/contract/developer-identity-server.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/broker/src/developer/server.ts packages/broker/src/aws/developer-identity.ts tests/support/developer-fakes.ts tests/contract/developer-identity-server.test.ts
git commit -m "feat(broker): developer sign-in server behind /v1/auth"
```

---

### Task 7: Developer routes on the broker and project access

**Files:**
- Create: `packages/broker/src/developer/access.ts`
- Create: `packages/broker/src/aws/developer-routes.ts`
- Modify: `packages/broker/src/aws/broker.ts` (route `/v1/dev/*` before the admin identity; wire the configuration)
- Modify: `packages/broker/package.json` (`"@aws-sdk/client-lambda": "3.1134.0"`), `package-lock.json`
- Modify: `tests/support/admin-broker.ts` (pass an optional `developer` configuration through)
- Test: `tests/contract/developer-access.test.ts`, `tests/contract/developer-routes.test.ts`

**Interfaces:**
- Consumes: `ChannelMembersRequest`, `ChannelMembersResponse`, `DeveloperProjectsResponse`,
  `DEVELOPER_TOKEN_AUDIENCE`, `DeveloperSignInMethod`, `SlackChannelBinding` (Task 2 and
  contracts); `AdaptedHttpRequest` (`lambda.ts`); the DeveloperSignIn record shapes (Task 4).
- Produces (`access.ts`):
  ```ts
  export interface DeveloperAccessInput {
    grants: readonly string[];
    bindings: readonly SlackChannelBinding[];
    slackUserId?: string;
    channelMembersMayUse: (project: string) => boolean; // R16: 25a passes () => true; 25b reads developerTasks
    channelMembers: (request: ChannelMembersRequest) => Promise<ChannelMembersResponse>;
  }
  export interface DeveloperAccess { projects: Map<string, { access: "granted" | "channel"; channels: string[] }>; slackUnavailable: boolean }
  export async function resolveDeveloperAccess(input: DeveloperAccessInput): Promise<DeveloperAccess>;
  ```
- Produces (`developer-routes.ts`):
  ```ts
  export interface DeveloperApiConfiguration {
    issuer: string; env: string; methods: { slack: boolean; oidc: boolean }; slackTeamId?: string;
    signInTableName: string;
    channelMembers(request: ChannelMembersRequest): Promise<ChannelMembersResponse>;
  }
  export interface DeveloperCaller { developerId: string; sessionId: string; amr: DeveloperSignInMethod; name: string; slackUserId?: string; email?: string }
  export function developerClaims(claims: Record<string, unknown> | undefined, config: DeveloperApiConfiguration): { developerId: string; sessionId: string; amr: DeveloperSignInMethod };
  export async function authenticateDeveloper(deps: DeveloperRouteDependencies, claims: Record<string, unknown> | undefined): Promise<DeveloperCaller>;
  export async function routeDeveloperRequest(deps: DeveloperRouteDependencies, request: AdaptedHttpRequest, url: URL): Promise<unknown>;
  export interface DeveloperRouteDependencies { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string; developer: DeveloperApiConfiguration; now: () => number }
  ```
  25b adds its task routes to `routeDeveloperRequest` and reuses `authenticateDeveloper` and
  `resolveDeveloperAccess`.
- `AwsBrokerDependencies` gains `developer?: DeveloperApiConfiguration` (and `AwsBrokerInput` with
  it). Without it, `/v1/dev/*` answers NOT_FOUND "developer sign-in is not set up in this
  deployment".

- [ ] **Step 1: Write the failing tests**

```ts
// tests/contract/developer-access.test.ts
import { describe, expect, it, vi } from "vitest";
import type { ChannelMembersRequest, SlackChannelBinding } from "@agentx/contracts";
import { resolveDeveloperAccess } from "../../packages/broker/src/developer/access.js";

const binding = (channelId: string, projectName: string): SlackChannelBinding => ({ teamId: "T0TEAM1", channelId, projectName, updatedAt: "2026-09-27T00:00:00.000Z" });
const bindings = [binding("C0PAY0001", "payments-api"), binding("C0PAY0002", "payments-api"), binding("C0LEDGER1", "ledger"), binding("C0DOCS001", "docs")];

describe("project access (FR-013)", () => {
  it("counts an admin grant without asking Slack", async () => {
    const channelMembers = vi.fn();
    const access = await resolveDeveloperAccess({ grants: ["ledger"], bindings, channelMembersMayUse: () => true, channelMembers });
    expect([...access.projects]).toEqual([["ledger", { access: "granted", channels: ["C0LEDGER1"] }]]);
    expect(channelMembers).not.toHaveBeenCalled();
  });

  it("counts membership of any bound channel of a project, asking once for every candidate channel (US4 scenario 6)", async () => {
    const channelMembers = vi.fn(async (request: ChannelMembersRequest) => {
      expect(request).toEqual({ kind: "channel-members", slackUserId: "U0MAYA001", channelIds: ["C0DOCS001", "C0PAY0001", "C0PAY0002"] });
      return { ok: true as const, memberOf: ["C0PAY0002"] };
    });
    const access = await resolveDeveloperAccess({ grants: ["ledger"], bindings, slackUserId: "U0MAYA001", channelMembersMayUse: () => true, channelMembers });
    expect(Object.fromEntries(access.projects)).toEqual({
      ledger: { access: "granted", channels: ["C0LEDGER1"] },
      "payments-api": { access: "channel", channels: ["C0PAY0001", "C0PAY0002"] },
    });
    expect(channelMembers).toHaveBeenCalledTimes(1);
  });

  it("never asks Slack for a developer with no Slack link (a company user whose email matched nobody)", async () => {
    const channelMembers = vi.fn();
    const access = await resolveDeveloperAccess({ grants: [], bindings, channelMembersMayUse: () => true, channelMembers });
    expect(access.projects.size).toBe(0);
    expect(channelMembers).not.toHaveBeenCalled();
  });

  it("skips projects whose policy switches channel access off", async () => {
    const channelMembers = vi.fn(async () => ({ ok: true as const, memberOf: ["C0PAY0001", "C0DOCS001"] }));
    const access = await resolveDeveloperAccess({ grants: [], bindings, slackUserId: "U0MAYA001", channelMembersMayUse: (project) => project !== "docs", channelMembers });
    expect([...access.projects.keys()]).toEqual(["payments-api"]);
  });

  it("fails closed when Slack is unavailable, keeping grants (edge case: Slack down)", async () => {
    const access = await resolveDeveloperAccess({ grants: ["ledger"], bindings, slackUserId: "U0MAYA001", channelMembersMayUse: () => true, channelMembers: async () => ({ ok: false, error: "slack_unavailable" }) });
    expect([...access.projects.keys()]).toEqual(["ledger"]);
    expect(access.slackUnavailable).toBe(true);
  });

  it("lists a granted project that has no bound channel", async () => {
    const access = await resolveDeveloperAccess({ grants: ["solo"], bindings, channelMembersMayUse: () => true, channelMembers: vi.fn() });
    expect(access.projects.get("solo")).toEqual({ access: "granted", channels: [] });
  });
});
```

```ts
// tests/contract/developer-routes.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelMembersRequest, ChannelMembersResponse } from "@agentx/contracts";
import type { DeveloperApiConfiguration } from "../../packages/broker/src/aws/developer-routes.js";
import { adminIssuer, createAdminBroker, type AdminHandler } from "../support/admin-broker.js";
import type { FakeDynamoDb } from "../support/fake-dynamodb.js";

const ISSUER = "https://abc123.execute-api.us-east-1.amazonaws.com/v1/auth";
const developerId = "d".repeat(64);
const T0 = Date.parse("2026-09-27T12:00:00.000Z");

let db: FakeDynamoDb;
let handler: AdminHandler;
let channelMembers: ReturnType<typeof vi.fn<(request: ChannelMembersRequest) => Promise<ChannelMembersResponse>>>;
let config: DeveloperApiConfiguration;

const claims = (overrides: Record<string, unknown> = {}) => ({ iss: ISSUER, aud: "agentx-developer", sub: developerId, amr: "slack", env: "staging", sid: "s-1", ...overrides });
const call = (path: string, jwt: Record<string, unknown>, method = "GET") =>
  handler({ rawPath: path, requestContext: { requestId: "r", http: { method }, authorizer: { jwt: { claims: jwt } } } });

beforeEach(async () => {
  vi.useFakeTimers({ now: T0, toFake: ["Date"] });
  channelMembers = vi.fn(async () => ({ ok: true as const, memberOf: ["C0PAY0001"] }));
  config = { issuer: ISSUER, env: "staging", methods: { slack: true, oidc: false }, slackTeamId: "T0TEAM1", signInTableName: "signin", channelMembers };
  ({ db, handler } = await createAdminBroker({ developer: config }));
  db.set({ pk: "SESSION#s-1", sk: "META", sessionId: "s-1", developerId, amr: "slack", slackUserId: "U0MAYA001", startedAt: new Date(T0).toISOString(), endsAt: T0 / 1000 + 604_800 });
  db.set({ pk: `DEVELOPER#${developerId}`, sk: "META", developerId, provider: "slack", issuer: "https://slack.com", subject: "U0MAYA001", displayName: "Maya Chen", slackUserId: "U0MAYA001", firstSignInAt: "x", lastSignInAt: "x", revoked: false });
  db.set({ pk: "SLACK_BINDING#T0TEAM1", sk: "CHANNEL#C0PAY0001", teamId: "T0TEAM1", channelId: "C0PAY0001", projectName: "payments-api", updatedAt: "2026-09-27T00:00:00.000Z" });
  db.set({ pk: "SLACK_BINDING#T0TEAM1", sk: "CHANNEL#C0LEDGER1", teamId: "T0TEAM1", channelId: "C0LEDGER1", projectName: "ledger", updatedAt: "2026-09-27T00:00:00.000Z" });
  db.set({ pk: "PROJECT#payments-api", sk: "REV#000000000007", entityType: "PROJECT", definition: { name: "payments-api", revision: 7 } });
  db.set({ pk: "PROJECT#ledger", sk: "REV#000000000002", entityType: "PROJECT", definition: { name: "ledger", revision: 2 } });
  db.set({ pk: "PROJECT#solo", sk: "REV#000000000001", entityType: "PROJECT", definition: { name: "solo", revision: 1 } });
  db.set({ pk: `MEMBER#${developerId}`, sk: "PROJECT#solo", entityType: "MEMBERSHIP", ownerKey: developerId, projectName: "solo", role: "developer" });
});

describe("GET /v1/dev/projects (FR-016, FR-013)", () => {
  it("lists granted and channel projects with the developer summary", async () => {
    const response = await call("/v1/dev/projects", claims());
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      developer: { id: developerId, name: "Maya Chen", provider: "slack", slackUserId: "U0MAYA001" },
      projects: [
        { name: "payments-api", latestRevision: 7, access: "channel", channels: [{ channelId: "C0PAY0001" }] },
        { name: "solo", latestRevision: 1, access: "granted", channels: [] },
      ],
      notices: [],
    });
    expect(channelMembers).toHaveBeenCalledWith({ kind: "channel-members", slackUserId: "U0MAYA001", channelIds: ["C0LEDGER1", "C0PAY0001"] });
  });

  it("keeps grants and says so when Slack is unavailable", async () => {
    channelMembers.mockResolvedValueOnce({ ok: false, error: "slack_unavailable" });
    const body = JSON.parse((await call("/v1/dev/projects", claims())).body) as { projects: Array<{ name: string }>; notices: string[] };
    expect(body.projects.map((project) => project.name)).toEqual(["solo"]);
    expect(body.notices).toEqual(["slack_unavailable"]);
  });

  it("skips a binding whose project has no registered revision", async () => {
    db.items.delete("PROJECT#payments-api\u0000REV#000000000007");
    const body = JSON.parse((await call("/v1/dev/projects", claims())).body) as { projects: Array<{ name: string }> };
    expect(body.projects.map((project) => project.name)).toEqual(["solo"]);
  });
});

describe("the developer check on every /v1/dev request (FR-009, R12, R13)", () => {
  it.each([
    ["an admin token", { iss: adminIssuer, aud: "agentx-admin-client" }],
    ["another audience", { aud: "something-else" }],
    ["no session id", { sid: undefined }],
    ["a subject that is not a developer ID", { sub: "not-hex" }],
  ])("refuses %s with AUTH_REQUIRED", async (_name, overrides) => {
    const response = await call("/v1/dev/projects", claims(overrides));
    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body)).toMatchObject({ error: { code: "AUTH_REQUIRED" } });
  });

  it("refuses a token whose method is turned off", async () => {
    config.methods.slack = false;
    const response = await call("/v1/dev/projects", claims());
    expect(response.statusCode).toBe(401);
    expect(response.body).toContain("Slack sign-in is turned off");
  });

  it("refuses a revoked or ended session, a session of someone else, and a revoked developer", async () => {
    db.set({ ...db.get("SESSION#s-1", "META")!, revokedAt: new Date(T0).toISOString() });
    expect((await call("/v1/dev/projects", claims())).statusCode).toBe(401);
    db.set({ ...db.get("SESSION#s-1", "META")!, revokedAt: undefined, endsAt: T0 / 1000 - 1 });
    expect((await call("/v1/dev/projects", claims())).statusCode).toBe(401);
    db.set({ ...db.get("SESSION#s-1", "META")!, endsAt: T0 / 1000 + 100, developerId: "e".repeat(64) });
    expect((await call("/v1/dev/projects", claims())).statusCode).toBe(401);
    db.set({ ...db.get("SESSION#s-1", "META")!, developerId });
    db.set({ ...db.get(`DEVELOPER#${developerId}`, "META")!, revoked: true });
    expect((await call("/v1/dev/projects", claims())).statusCode).toBe(401);
  });

  it("answers NOT_FOUND for a /v1/dev route this phase does not serve", async () => {
    expect((await call("/v1/dev/tasks", claims(), "POST")).statusCode).toBe(404);
  });
});

describe("admin and developer tokens stay apart (FR-009, FR-015)", () => {
  it("refuses a developer token on /v1/admin/*", async () => {
    const response = await call("/v1/admin/turns", claims());
    expect(response.statusCode).toBe(401);
  });

  it("keeps spec 008's refusal for JWT routes that are neither /v1/admin nor /v1/dev", async () => {
    const response = await call("/v1/workspaces", { iss: adminIssuer, sub: "admin-subject", groups: ["admins"] }, "POST");
    expect(response.statusCode).toBe(403);
    expect(response.body).toContain("AgentX developer workflows run in the project's Slack channel");
  });

  it("answers NOT_FOUND on /v1/dev/* when developer sign-in is not configured", async () => {
    const { handler: bare } = await createAdminBroker();
    const response = await bare({ rawPath: "/v1/dev/projects", requestContext: { requestId: "r", http: { method: "GET" }, authorizer: { jwt: { claims: claims() } } } });
    expect(response.statusCode).toBe(404);
    expect(response.body).toContain("developer sign-in is not set up");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/contract/developer-access.test.ts tests/contract/developer-routes.test.ts`
Expected: FAIL, the modules and the `developer` option do not exist.

- [ ] **Step 3: Implement access resolution**

```ts
// packages/broker/src/developer/access.ts
// Spec 025 FR-013: a developer may use a project granted to them, or, when the project allows it,
// any project with a bound channel their linked Slack user is in. Slack failures fail closed.
import type { ChannelMembersRequest, ChannelMembersResponse, SlackChannelBinding } from "@agentx/contracts";

export interface DeveloperAccessInput {
  grants: readonly string[];
  bindings: readonly SlackChannelBinding[];
  slackUserId?: string;
  channelMembersMayUse: (project: string) => boolean;
  channelMembers: (request: ChannelMembersRequest) => Promise<ChannelMembersResponse>;
}
export interface DeveloperAccess { projects: Map<string, { access: "granted" | "channel"; channels: string[] }>; slackUnavailable: boolean }

export async function resolveDeveloperAccess(input: DeveloperAccessInput): Promise<DeveloperAccess> {
  const channelsOf = new Map<string, string[]>();
  for (const binding of input.bindings) channelsOf.set(binding.projectName, [...(channelsOf.get(binding.projectName) ?? []), binding.channelId].sort());
  const projects: DeveloperAccess["projects"] = new Map();
  for (const project of [...new Set(input.grants)].sort()) projects.set(project, { access: "granted", channels: channelsOf.get(project) ?? [] });

  const candidates = [...channelsOf.keys()].filter((project) => !projects.has(project) && input.channelMembersMayUse(project));
  if (input.slackUserId === undefined || candidates.length === 0) return { projects: sorted(projects), slackUnavailable: false };
  const channelIds = [...new Set(candidates.flatMap((project) => channelsOf.get(project) ?? []))].sort();
  const answer = await input.channelMembers({ kind: "channel-members", slackUserId: input.slackUserId, channelIds });
  if (!answer.ok) return { projects: sorted(projects), slackUnavailable: true };
  const member = new Set(answer.memberOf);
  for (const project of candidates) {
    const channels = channelsOf.get(project) ?? [];
    if (channels.some((channel) => member.has(channel))) projects.set(project, { access: "channel", channels });
  }
  return { projects: sorted(projects), slackUnavailable: false };
}

const sorted = <V>(map: Map<string, V>) => new Map([...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
```

- [ ] **Step 4: Implement the developer routes**

```ts
// packages/broker/src/aws/developer-routes.ts
// Spec 025 FR-009 and FR-016 (GET projects only in 25a). API Gateway's developer JWT authorizer
// has already verified the token; the broker checks issuer, audience, method and the sign-in
// session again on every request (R12, R13), so a revoked session stops at once.
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  DEVELOPER_TOKEN_AUDIENCE,
  agentXError,
  type ChannelMembersRequest,
  type ChannelMembersResponse,
  type DeveloperProjectsResponse,
  type DeveloperSignInMethod,
  type SlackChannelBinding,
} from "@agentx/contracts";
import { resolveDeveloperAccess } from "../developer/access.js";
import type { AdaptedHttpRequest } from "./lambda.js";

export interface DeveloperApiConfiguration {
  issuer: string; env: string; methods: { slack: boolean; oidc: boolean }; slackTeamId?: string;
  signInTableName: string;
  channelMembers(request: ChannelMembersRequest): Promise<ChannelMembersResponse>;
}
export interface DeveloperRouteDependencies { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string; developer: DeveloperApiConfiguration; now: () => number }
export interface DeveloperCaller { developerId: string; sessionId: string; amr: DeveloperSignInMethod; name: string; slackUserId?: string; email?: string }

const SIGN_IN_AGAIN = "your AgentX sign-in has ended; run agentx login <url> again";

export function developerClaims(claims: Record<string, unknown> | undefined, config: DeveloperApiConfiguration): { developerId: string; sessionId: string; amr: DeveloperSignInMethod } {
  if (claims === undefined || claims.iss !== config.issuer || claims.aud !== DEVELOPER_TOKEN_AUDIENCE) {
    throw agentXError("AUTH_REQUIRED", "this route needs an AgentX developer sign-in; run agentx login <url>");
  }
  if (typeof claims.sub !== "string" || !/^[a-f0-9]{64}$/.test(claims.sub) || typeof claims.sid !== "string" || claims.sid === "") {
    throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  }
  const amr = claims.amr;
  if (amr !== "slack" && amr !== "oidc") throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  if (!config.methods[amr]) {
    throw agentXError("AUTH_REQUIRED", `${amr === "slack" ? "Slack" : "Company"} sign-in is turned off in this environment; sign in another way with agentx login <url>`);
  }
  return { developerId: claims.sub, sessionId: claims.sid, amr };
}

async function getSignIn<T>(deps: DeveloperRouteDependencies, pk: string): Promise<T | undefined> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.developer.signInTableName, Key: { pk, sk: "META" }, ConsistentRead: true })) as { Item?: T };
  return response.Item;
}

export async function authenticateDeveloper(deps: DeveloperRouteDependencies, claims: Record<string, unknown> | undefined): Promise<DeveloperCaller> {
  const token = developerClaims(claims, deps.developer);
  const session = await getSignIn<{ developerId: string; endsAt: number; revokedAt?: string }>(deps, `SESSION#${token.sessionId}`);
  if (session === undefined || session.developerId !== token.developerId || session.revokedAt !== undefined || session.endsAt <= Math.floor(deps.now() / 1000)) {
    throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  }
  const developer = await getSignIn<{ displayName: string; slackUserId?: string; email?: string; revoked: boolean }>(deps, `DEVELOPER#${token.developerId}`);
  if (developer === undefined || developer.revoked) throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  return {
    ...token,
    name: developer.displayName,
    ...(developer.slackUserId === undefined ? {} : { slackUserId: developer.slackUserId }),
    ...(developer.email === undefined ? {} : { email: developer.email }),
  };
}

async function queryState<T>(deps: DeveloperRouteDependencies, pk: string, prefix: string, options: { newestFirst?: boolean; limit?: number } = {}): Promise<T[]> {
  const response = await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: { ":pk": pk, ":prefix": prefix },
    ...(options.newestFirst ? { ScanIndexForward: false } : {}),
    ...(options.limit === undefined ? {} : { Limit: options.limit }),
    ConsistentRead: true,
  })) as { Items?: T[] };
  return response.Items ?? [];
}

async function listProjects(deps: DeveloperRouteDependencies, caller: DeveloperCaller): Promise<DeveloperProjectsResponse> {
  const grants = (await queryState<{ projectName: string }>(deps, `MEMBER#${caller.developerId}`, "PROJECT#")).map((grant) => grant.projectName);
  const bindings = deps.developer.slackTeamId === undefined ? [] : await queryState<SlackChannelBinding>(deps, `SLACK_BINDING#${deps.developer.slackTeamId}`, "CHANNEL#");
  const access = await resolveDeveloperAccess({
    grants,
    bindings,
    ...(caller.slackUserId === undefined ? {} : { slackUserId: caller.slackUserId }),
    channelMembersMayUse: () => true, // R16: phase 25b reads the revision's developerTasks.channelMembersMayUse
    channelMembers: (request) => deps.developer.channelMembers(request),
  });
  const projects: DeveloperProjectsResponse["projects"] = [];
  for (const [name, entry] of access.projects) {
    const [latest] = await queryState<{ definition: { revision: number } }>(deps, `PROJECT#${name}`, "REV#", { newestFirst: true, limit: 1 });
    if (latest === undefined) continue;
    projects.push({ name, latestRevision: latest.definition.revision, access: entry.access, channels: entry.channels.map((channelId) => ({ channelId })) });
  }
  return {
    developer: {
      id: caller.developerId, name: caller.name, provider: caller.amr,
      ...(caller.slackUserId === undefined ? {} : { slackUserId: caller.slackUserId }),
      ...(caller.email === undefined ? {} : { email: caller.email }),
    },
    projects,
    notices: access.slackUnavailable ? ["slack_unavailable"] : [],
  };
}

export async function routeDeveloperRequest(deps: DeveloperRouteDependencies, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  const caller = await authenticateDeveloper(deps, request.jwtClaims);
  if (request.method === "GET" && url.pathname === "/v1/dev/projects") return listProjects(deps, caller);
  throw agentXError("NOT_FOUND", "route not found");
}
```

- [ ] **Step 5: Wire it into the broker**

In `packages/broker/src/aws/broker.ts`:

1. Import `routeDeveloperRequest` and `type DeveloperApiConfiguration` from `./developer-routes.js`,
   and `InvokeCommand, LambdaClient` from `@aws-sdk/client-lambda`.
2. Add `developer?: DeveloperApiConfiguration;` to `AwsBrokerDependencies`, after `slack?:`.
3. In the handler, directly after the `/v1/service/` block and before
   `const identity = identityFromJwtClaims(...)`, add:

```ts
      // Spec 025: the developer API. API Gateway's second JWT authorizer guards /v1/dev/*; the
      // broker checks issuer, audience, method and session again (FR-009).
      if (url.pathname.startsWith("/v1/dev/")) {
        if (!dependencies.developer) throw agentXError("NOT_FOUND", "developer sign-in is not set up in this deployment");
        return json(await routeDeveloperRequest({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, developer: dependencies.developer, now: Date.now }, request, url), request.requestId);
      }
```

4. At the bottom, before `export const handler = createAwsBrokerHandler({`, add:

```ts
const lambdaClient = new LambdaClient(awsClientConfiguration);
/** Set only in named environments with developer sign-in (infra/lib/developer-signin.ts). */
function developerConfiguration(): DeveloperApiConfiguration | undefined {
  const issuer = process.env.DEVELOPER_TOKEN_ISSUER;
  if (!issuer) return undefined;
  const functionName = requiredEnvironment("DEVELOPER_IDENTITY_FUNCTION_ARN");
  const teamId = process.env.SLACK_TEAM_ID ?? "";
  return {
    issuer,
    env: requiredEnvironment("AGENTX_ENV"),
    methods: { slack: process.env.DEVELOPER_SIGNIN_SLACK === "enabled", oidc: (process.env.DEVELOPER_OIDC_ISSUER ?? "") !== "" },
    ...(teamId === "" ? {} : { slackTeamId: teamId }),
    signInTableName: requiredEnvironment("DEVELOPER_SIGNIN_TABLE_NAME"),
    async channelMembers(request) {
      try {
        const response = await lambdaClient.send(new InvokeCommand({ FunctionName: functionName, Payload: Buffer.from(JSON.stringify(request)) }));
        if (response.FunctionError !== undefined || response.Payload === undefined) return { ok: false, error: "slack_unavailable" };
        const parsed = JSON.parse(Buffer.from(response.Payload).toString("utf8")) as { ok?: unknown; memberOf?: unknown };
        return parsed.ok === true && Array.isArray(parsed.memberOf)
          ? { ok: true, memberOf: parsed.memberOf.filter((entry): entry is string => typeof entry === "string") }
          : { ok: false, error: "slack_unavailable" };
      } catch {
        return { ok: false, error: "slack_unavailable" };
      }
    },
  };
}
const developer = developerConfiguration();
```

   and add `...(developer ? { developer } : {}),` to the `createAwsBrokerHandler({ ... })` input.
5. In `packages/broker/package.json`, add `"@aws-sdk/client-lambda": "3.1134.0"` (alphabetical).
   Run `npm view @aws-sdk/client-lambda@3.1134.0 version` first; then `npm install`.
6. In `tests/support/admin-broker.ts`, add `developer?: DeveloperApiConfiguration` to
   `createAdminBroker`'s options (type-only import from
   `../../packages/broker/src/aws/developer-routes.js`) and pass
   `...(options.developer ? { developer: options.developer } : {})` into `createAwsBrokerHandler`.

- [ ] **Step 6: Run the tests, and the existing broker suites unchanged**

Run: `npx vitest run tests/contract/developer-access.test.ts tests/contract/developer-routes.test.ts tests/contract/admin-preparation.test.ts tests/contract/slack-control-plane.test.ts tests/contract/cloud-handlers.test.ts tests/contract/authorization.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/broker/src/developer/access.ts packages/broker/src/aws/developer-routes.ts packages/broker/src/aws/broker.ts packages/broker/package.json package-lock.json tests/support/admin-broker.ts tests/contract/developer-access.test.ts tests/contract/developer-routes.test.ts
git commit -m "feat(broker): GET /v1/dev/projects with FR-013 access and a per-request session check"
```

---

### Task 8: Infrastructure

**Files:**
- Create: `infra/lib/developer-signin.ts`
- Modify: `infra/lib/control-plane.ts` (parameters and the construct, named environments only)
- Modify: `infra/lib/naming.ts` (`developerTokenKeyAlias`)
- Test: `tests/contract/developer-signin-infrastructure.test.ts`

**Interfaces:**
- Consumes: `packagedFunction` (control-plane.ts), `AgentXNaming`, the Lambda entry
  `packages/broker/src/aws/developer-identity.ts` (Task 6), the broker environment variables
  Task 7 reads, `DEVELOPER_TOKEN_AUDIENCE`.
- Produces:
  - stack parameters, exactly (all with defaults, so `stackParameters` needs nothing new to deploy):

    | Parameter | Default | Constraint |
    |---|---|---|
    | `SlackTeamId` | `""` | `^$|^[TE][A-Z0-9]{2,31}$` |
    | `DeveloperSignInSlack` | `disabled` | `enabled` or `disabled` |
    | `DeveloperOidcIssuer` | `""` | `^$|^https://\S+$` |
    | `DeveloperOidcClientId` | `""` | at most 256 characters |
    | `DeveloperOidcRequiredClaim` | `""` | at most 128 characters |
    | `DeveloperOidcRequiredValues` | `[]` | `^\[.*\]$` |
    | `DeveloperOidcDisplayName` | `Company sign-in` | 1 to 40 characters |

  - output `DeveloperSignInIssuer` (`<ApiEndpoint>/v1/auth`), which `signin check` reads;
  - `AgentXNaming.developerTokenKeyAlias`: `alias/agentx/<env>/developer-tokens`
    (legacy value `alias/agentx/developer-tokens`, never used).

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/developer-signin-infrastructure.test.ts
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";

type Json = Record<string, any>;
let named: Json;
let legacy: Json;

const controlPlane = (app: ReturnType<typeof buildAgentXApp>, name: string) =>
  Template.fromStack(app.node.children.find((child): child is Stack => Stack.isStack(child) && child.stackName === name)!).toJSON() as Json;
const ofType = (template: Json, type: string) => Object.entries(template.Resources as Json).filter(([, resource]) => resource.Type === type) as Array<[string, Json]>;

beforeAll(() => {
  named = controlPlane(buildAgentXApp({ agentxEnv: "staging" }), "agentx-staging-control-plane");
  legacy = controlPlane(buildAgentXApp(), "AgentXControlPlane");
}, 300_000);

describe("developer sign-in infrastructure (named environments)", () => {
  it("declares the sign-in parameters, with sign-in off by default (R8)", () => {
    expect(named.Parameters.SlackTeamId).toMatchObject({ Type: "String", Default: "", AllowedPattern: "^$|^[TE][A-Z0-9]{2,31}$" });
    expect(named.Parameters.DeveloperSignInSlack).toMatchObject({ Default: "disabled", AllowedValues: ["enabled", "disabled"] });
    expect(named.Parameters.DeveloperOidcIssuer).toMatchObject({ Default: "" });
    expect(named.Parameters.DeveloperOidcRequiredValues).toMatchObject({ Default: "[]" });
    expect(named.Parameters.DeveloperOidcDisplayName).toMatchObject({ Default: "Company sign-in", MaxLength: 40 });
    for (const parameter of Object.values(named.Parameters as Json)) expect(JSON.stringify(parameter)).not.toContain("\u2014");
  });

  it("adds a second JWT authorizer whose issuer is the API's own endpoint plus /v1/auth (FR-009)", () => {
    const authorizers = ofType(named, "AWS::ApiGatewayV2::Authorizer").map(([, resource]) => resource.Properties);
    expect(authorizers).toHaveLength(2);
    const developer = authorizers.find((properties) => properties.Name === "agentx-developer-jwt")!;
    expect(developer.JwtConfiguration.Audience).toEqual(["agentx-developer"]);
    expect(developer.JwtConfiguration.Issuer).toEqual({ "Fn::Join": ["", [{ "Fn::GetAtt": [expect.stringMatching(/^HttpApi/), "ApiEndpoint"] }, "/v1/auth"]] });
    expect(authorizers.find((properties) => properties.Name === "agentx-jwt")).toBeDefined();
  });

  it("routes /v1/dev/* through the developer authorizer to the broker, /v1/auth/* with no authorizer to DeveloperIdentity, and leaves ANY /{proxy+} alone", () => {
    const routes = Object.fromEntries(ofType(named, "AWS::ApiGatewayV2::Route").map(([, resource]) => [resource.Properties.RouteKey, resource.Properties]));
    const authorizerId = (name: string) => ({ Ref: ofType(named, "AWS::ApiGatewayV2::Authorizer").find(([, r]) => r.Properties.Name === name)![0] });
    expect(routes["ANY /v1/dev/{proxy+}"]).toMatchObject({ AuthorizationType: "JWT", AuthorizerId: authorizerId("agentx-developer-jwt"), Target: routes["ANY /{proxy+}"].Target });
    expect(routes["ANY /{proxy+}"]).toMatchObject({ AuthorizationType: "JWT", AuthorizerId: authorizerId("agentx-jwt") });
    expect(routes["ANY /v1/auth/{proxy+}"].AuthorizationType).toBe("NONE");
    expect(routes["ANY /v1/auth/{proxy+}"].Target).not.toEqual(routes["ANY /{proxy+}"].Target);
  });

  it("signs with an RSA_2048 KMS key only the DeveloperIdentity role may use (R1)", () => {
    const keys = ofType(named, "AWS::KMS::Key").map(([, resource]) => resource.Properties).filter((properties) => properties.KeySpec === "RSA_2048");
    expect(keys).toHaveLength(1);
    expect(keys[0]!.KeyUsage).toBe("SIGN_VERIFY");
    const deny = keys[0]!.KeyPolicy.Statement.find((statement: Json) => statement.Effect === "Deny");
    expect(deny).toMatchObject({ Action: "kms:Sign", Principal: { AWS: "*" } });
    expect(JSON.stringify(deny.Condition)).toContain("DeveloperSignInFunctionServiceRole");
    const alias = ofType(named, "AWS::KMS::Alias").map(([, resource]) => resource.Properties.AliasName);
    expect(alias).toContain("alias/agentx/staging/developer-tokens");
  });

  it("lets only the ingress, the orchestrator task role and DeveloperIdentity read the Slack secret (R2)", () => {
    const [secretId] = ofType(named, "AWS::SecretsManager::Secret").find(([, resource]) => resource.Properties.Name === "agentx/staging/slack")!;
    const readers = ofType(named, "AWS::IAM::Policy").filter(([, policy]) => policy.Properties.PolicyDocument.Statement.some((statement: Json) =>
      [statement.Action].flat().includes("secretsmanager:GetSecretValue") && JSON.stringify(statement.Resource).includes(secretId)))
      .flatMap(([, policy]) => policy.Properties.Roles.map((role: Json) => String(role.Ref)));
    expect(readers.map((role) => role.replace(/[0-9A-F]{8}$/, "")).sort()).toEqual(["DeveloperSignInFunctionServiceRole", "SlackIngressServiceRole", "SlackOrchestratorTaskRole"]);
  });

  it("gives the broker an invoke on DeveloperIdentity and only session and developer reads on the sign-in table", () => {
    const brokerPolicies = ofType(named, "AWS::IAM::Policy").filter(([, policy]) => policy.Properties.Roles.some((role: Json) => String(role.Ref).startsWith("BrokerServiceRole")));
    const statements = brokerPolicies.flatMap(([, policy]) => policy.Properties.PolicyDocument.Statement as Json[]);
    expect(statements.some((statement) => [statement.Action].flat().includes("lambda:InvokeFunction") && JSON.stringify(statement.Resource).includes("DeveloperSignInFunction"))).toBe(true);
    const tableRead = statements.find((statement) => JSON.stringify(statement.Resource).includes("DeveloperSignInTable"))!;
    expect(tableRead.Action).toBe("dynamodb:GetItem");
    expect(tableRead.Condition).toEqual({ "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["SESSION#*", "DEVELOPER#*"] } });
  });

  it("keeps sign-in records in a retained table with a TTL", () => {
    const [id, table] = ofType(named, "AWS::DynamoDB::Table").find(([logicalId]) => logicalId.startsWith("DeveloperSignInTable"))!;
    expect(table.Properties.TimeToLiveSpecification).toEqual({ AttributeName: "expiresAt", Enabled: true });
    expect(table.DeletionPolicy).toBe("Retain");
    expect(id).toBeDefined();
  });

  it("passes the developer configuration to the broker and DeveloperIdentity", () => {
    const functions = Object.fromEntries(ofType(named, "AWS::Lambda::Function").map(([id, resource]) => [id.replace(/[0-9A-F]{8}$/, ""), resource.Properties.Environment?.Variables ?? {}]));
    expect(Object.keys(functions.Broker)).toEqual(expect.arrayContaining(["DEVELOPER_TOKEN_ISSUER", "AGENTX_ENV", "DEVELOPER_SIGNIN_TABLE_NAME", "DEVELOPER_IDENTITY_FUNCTION_ARN", "SLACK_TEAM_ID", "DEVELOPER_SIGNIN_SLACK", "DEVELOPER_OIDC_ISSUER"]));
    expect(Object.keys(functions.Broker)).not.toContain("SLACK_SECRET_ARN");
    expect(Object.keys(functions.DeveloperSignInFunction)).toEqual(expect.arrayContaining([
      "AGENTX_ENV", "DEVELOPER_TOKEN_ISSUER", "DEVELOPER_SIGNIN_TABLE_NAME", "DEVELOPER_TOKEN_KEY_ARN", "SLACK_SECRET_ARN", "SLACK_TEAM_ID",
      "DEVELOPER_SIGNIN_SLACK", "DEVELOPER_OIDC_ISSUER", "DEVELOPER_OIDC_CLIENT_ID", "DEVELOPER_OIDC_REQUIRED_CLAIM", "DEVELOPER_OIDC_REQUIRED_VALUES",
      "DEVELOPER_OIDC_DISPLAY_NAME", "DEVELOPER_OIDC_SECRET_ID",
    ]));
    expect(named.Outputs.DeveloperSignInIssuer).toBeDefined();
  });
});

describe("the legacy deployment (R3)", () => {
  it("has none of it", () => {
    const text = JSON.stringify(legacy);
    for (const absent of ["SlackTeamId", "DeveloperSignIn", "agentx-developer-jwt", "/v1/dev/", "/v1/auth/", "DEVELOPER_TOKEN_ISSUER"]) expect(text).not.toContain(absent);
    expect(ofType(legacy, "AWS::ApiGatewayV2::Authorizer")).toHaveLength(1);
  });
});
```

The legacy snapshot test (`tests/contract/legacy-templates.test.ts`) is the byte-level check and
must pass unchanged.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/contract/developer-signin-infrastructure.test.ts`
Expected: FAIL, one authorizer and no sign-in parameters.

- [ ] **Step 3: Implement the construct**

```ts
// infra/lib/developer-signin.ts
// Spec 025 phase 25a: the control plane as the developers' sign-in server. Named environments only
// (R3): the legacy deployment must not change.
import { ArnFormat, CfnOutput, CfnParameter, Duration, RemovalPolicy, Stack, aws_apigatewayv2 as apigwv2, aws_dynamodb as dynamodb, aws_iam as iam, aws_kms as kms, type aws_lambda_nodejs as lambdaNodejs, type aws_secretsmanager as secretsmanager } from "aws-cdk-lib";
import { Construct } from "constructs";
import { DEVELOPER_TOKEN_AUDIENCE } from "@agentx/contracts";
import type { AgentXNaming } from "./naming.js";
import { packagedFunction } from "./control-plane.js";

export interface DeveloperSignInParameters {
  slackTeamId: CfnParameter; slack: CfnParameter; oidcIssuer: CfnParameter; oidcClientId: CfnParameter;
  oidcRequiredClaim: CfnParameter; oidcRequiredValues: CfnParameter; oidcDisplayName: CfnParameter;
}

/** Declared on the stack itself, so the parameter names are exactly these. */
export function developerSignInParameters(stack: Stack): DeveloperSignInParameters {
  return {
    slackTeamId: new CfnParameter(stack, "SlackTeamId", { type: "String", default: "", allowedPattern: "^$|^[TE][A-Z0-9]{2,31}$", description: "The Slack workspace (team) ID this environment serves; Slack sign-in is refused while it is empty" }),
    slack: new CfnParameter(stack, "DeveloperSignInSlack", { type: "String", default: "disabled", allowedValues: ["enabled", "disabled"], description: "enabled: developers may sign in with Slack; disabled: they may not" }),
    oidcIssuer: new CfnParameter(stack, "DeveloperOidcIssuer", { type: "String", default: "", allowedPattern: "^$|^https://\\S+$", description: "Company OIDC issuer URL for developer sign-in; empty turns company sign-in off" }),
    oidcClientId: new CfnParameter(stack, "DeveloperOidcClientId", { type: "String", default: "", maxLength: 256, description: "Client ID of the company OIDC app for developer sign-in" }),
    oidcRequiredClaim: new CfnParameter(stack, "DeveloperOidcRequiredClaim", { type: "String", default: "", maxLength: 128, description: "Claim a company sign-in must carry, for example groups; empty for none" }),
    oidcRequiredValues: new CfnParameter(stack, "DeveloperOidcRequiredValues", { type: "String", default: "[]", allowedPattern: "^\\[.*\\]$", description: "JSON string array; the required claim must contain one of these values" }),
    oidcDisplayName: new CfnParameter(stack, "DeveloperOidcDisplayName", { type: "String", default: "Company sign-in", minLength: 1, maxLength: 40, description: "Name on the company sign-in button, for example Okta" }),
  };
}

export interface DeveloperSignInProps {
  naming: AgentXNaming;
  env: string;
  api: apigwv2.CfnApi;
  brokerIntegration: apigwv2.CfnIntegration;
  broker: lambdaNodejs.NodejsFunction;
  slackSecret: secretsmanager.ISecret;
  parameters: DeveloperSignInParameters;
}

export class DeveloperSignIn extends Construct {
  constructor(scope: Construct, id: string, props: DeveloperSignInProps) {
    super(scope, id);
    const stack = Stack.of(this);
    const p = props.parameters;
    const issuer = `${props.api.attrApiEndpoint}/v1/auth`;

    const table = new dynamodb.Table(this, "Table", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      timeToLiveAttribute: "expiresAt",
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      // Retained: developer records and session history must outlive a stack deletion.
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const tokenKey = new kms.Key(this, "TokenKey", {
      alias: props.naming.developerTokenKeyAlias,
      description: `Signs AgentX ${props.naming.environmentTagValue} developer access tokens`,
      keySpec: kms.KeySpec.RSA_2048,
      keyUsage: kms.KeyUsage.SIGN_VERIFY,
      pendingWindow: Duration.days(7),
      // Access tokens live one hour, so nothing outlives the key for long.
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const oidcSecretName = `agentx/${props.env}/developer-oidc`;
    const fn = packagedFunction(this, "Function", "packages/broker/src/aws/developer-identity.ts", {
      AGENTX_ENV: props.env,
      DEVELOPER_TOKEN_ISSUER: issuer,
      DEVELOPER_SIGNIN_TABLE_NAME: table.tableName,
      DEVELOPER_TOKEN_KEY_ARN: tokenKey.keyArn,
      SLACK_SECRET_ARN: props.slackSecret.secretArn,
      SLACK_TEAM_ID: p.slackTeamId.valueAsString,
      DEVELOPER_SIGNIN_SLACK: p.slack.valueAsString,
      DEVELOPER_OIDC_ISSUER: p.oidcIssuer.valueAsString,
      DEVELOPER_OIDC_CLIENT_ID: p.oidcClientId.valueAsString,
      DEVELOPER_OIDC_REQUIRED_CLAIM: p.oidcRequiredClaim.valueAsString,
      DEVELOPER_OIDC_REQUIRED_VALUES: p.oidcRequiredValues.valueAsString,
      DEVELOPER_OIDC_DISPLAY_NAME: p.oidcDisplayName.valueAsString,
      DEVELOPER_OIDC_SECRET_ID: oidcSecretName,
    }, Duration.seconds(15));
    table.grantReadWriteData(fn);
    tokenKey.grant(fn, "kms:Sign", "kms:GetPublicKey");
    tokenKey.addToResourcePolicy(new iam.PolicyStatement({
      sid: "SignOnlyAsDeveloperIdentity",
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ["kms:Sign"],
      resources: ["*"],
      conditions: { ArnNotEquals: { "aws:PrincipalArn": fn.role!.roleArn } },
    }));
    props.slackSecret.grantRead(fn);
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ["secretsmanager:GetSecretValue"],
      // Secrets Manager appends "-" and six characters to a secret's name in its ARN.
      resources: [stack.formatArn({ service: "secretsmanager", resource: "secret", resourceName: `${oidcSecretName}-??????`, arnFormat: ArnFormat.COLON_RESOURCE_NAME })],
    }));

    const integration = new apigwv2.CfnIntegration(this, "Integration", {
      apiId: props.api.ref, integrationType: "AWS_PROXY", integrationUri: fn.functionArn, payloadFormatVersion: "2.0",
    });
    new apigwv2.CfnRoute(this, "AuthRoute", {
      apiId: props.api.ref, routeKey: "ANY /v1/auth/{proxy+}", target: `integrations/${integration.ref}`, authorizationType: "NONE",
    });
    fn.addPermission("ApiInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      sourceArn: `arn:${stack.partition}:execute-api:${stack.region}:${stack.account}:${props.api.ref}/*/*/v1/auth/*`,
    });

    const authorizer = new apigwv2.CfnAuthorizer(this, "Authorizer", {
      apiId: props.api.ref,
      authorizerType: "JWT",
      identitySource: ["$request.header.Authorization"],
      name: "agentx-developer-jwt",
      jwtConfiguration: { audience: [DEVELOPER_TOKEN_AUDIENCE], issuer },
    });
    new apigwv2.CfnRoute(this, "DevRoute", {
      apiId: props.api.ref, routeKey: "ANY /v1/dev/{proxy+}", target: `integrations/${props.brokerIntegration.ref}`,
      authorizationType: "JWT", authorizerId: authorizer.ref,
    });

    const broker = props.broker;
    broker.addEnvironment("DEVELOPER_TOKEN_ISSUER", issuer);
    broker.addEnvironment("AGENTX_ENV", props.env);
    broker.addEnvironment("DEVELOPER_SIGNIN_TABLE_NAME", table.tableName);
    broker.addEnvironment("DEVELOPER_IDENTITY_FUNCTION_ARN", fn.functionArn);
    broker.addEnvironment("SLACK_TEAM_ID", p.slackTeamId.valueAsString);
    broker.addEnvironment("DEVELOPER_SIGNIN_SLACK", p.slack.valueAsString);
    broker.addEnvironment("DEVELOPER_OIDC_ISSUER", p.oidcIssuer.valueAsString);
    fn.grantInvoke(broker);
    broker.addToRolePolicy(new iam.PolicyStatement({
      actions: ["dynamodb:GetItem"],
      resources: [table.tableArn],
      conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["SESSION#*", "DEVELOPER#*"] } },
    }));

    new CfnOutput(stack, "DeveloperSignInIssuer", { value: issuer });
  }
}
```

- [ ] **Step 4: Wire it into the control plane and naming**

In `infra/lib/naming.ts`: add `readonly developerTokenKeyAlias: string;` to `AgentXNaming` (after
`workspaceKeyAlias`), `developerTokenKeyAlias: \`alias/agentx/${name}/developer-tokens\`` in
`environmentNaming`, and `developerTokenKeyAlias: "alias/agentx/developer-tokens"` in
`legacyNaming` (unused: R3). If `tests/contract/environment-naming.test.ts` compares a whole
naming object, add the field to that expectation.

In `infra/lib/control-plane.ts`:
1. `import { DeveloperSignIn, developerSignInParameters } from "./developer-signin.js";`
2. After the `githubAppPrivateKeySecretArn` parameter:
   `const signInParameters = naming.env === undefined ? undefined : developerSignInParameters(this);`
3. After the `SlackServiceRoute` route and before `const sessions = new SessionLifecycle(...)`:

```ts
    // Spec 025 phase 25a: developer sign-in, named environments only (R3).
    if (naming.env !== undefined && signInParameters !== undefined) {
      new DeveloperSignIn(this, "DeveloperSignIn", {
        naming, env: naming.env, api, brokerIntegration: integration, broker, slackSecret, parameters: signInParameters,
      });
    }
```

`developer-signin.ts` imports `packagedFunction` from `control-plane.ts`, and `control-plane.ts`
imports the construct: ES modules allow this cycle because neither uses the other at module load
time. If the build or lint refuses the cycle, move `packagedFunction` to
`infra/lib/packaged-function.ts` and re-export it from `control-plane.ts` unchanged.

- [ ] **Step 5: Run the new test, the legacy snapshots and the infrastructure suites**

Run: `npx vitest run tests/contract/developer-signin-infrastructure.test.ts tests/contract/legacy-templates.test.ts tests/contract/environment-naming.test.ts tests/contract/permissions-boundary.test.ts tests/contract/deploy-parameters.test.ts tests/contract/template-rendering.test.ts tests/contract/release-build.test.ts tests/contract/turn-records-infrastructure.test.ts tests/contract/session-lifecycle-infrastructure.test.ts`
Expected: PASS, with the legacy snapshots unchanged. Then `npm run infra:synth`: succeeds.

- [ ] **Step 6: Commit**

```bash
git add infra/lib/developer-signin.ts infra/lib/control-plane.ts infra/lib/naming.ts tests/contract/developer-signin-infrastructure.test.ts
git commit -m "feat(infra): developer sign-in server, token key and the /v1/dev authorizer"
```

---
### Task 9: Sign-in settings, deploys that keep them, and parameter-only updates

**Files:**
- Create: `packages/cli/src/signin/settings.ts`
- Create: `packages/cli/src/deploy/parameter-update.ts`
- Modify: `packages/cli/src/deploy/parameters.ts` (`InstallAnswers.developerSignIn`; control-plane mapping)
- Modify: `packages/cli/src/deploy/deploy-environment.ts` (read stored sign-in for control-plane deploys)
- Create: `tests/support/fake-cloudformation.ts` (reused by Tasks 12 and 13)
- Test: `tests/contract/signin-settings.test.ts`, `tests/contract/parameter-update.test.ts`,
  additions to `tests/contract/deploy-parameters.test.ts` and `tests/contract/deploy-environment.test.ts`

**Interfaces:**
- Consumes: `ParameterStore`, `EnvironmentNameSchema`, `agentXError`, `ChangeSetChange`
  (`deploy/deployer.ts`); the stack parameters of Task 8.
- Produces (`signin/settings.ts`):
  ```ts
  export const DeveloperSignInSettingsSchema: z.ZodType<DeveloperSignInSettings>;
  export interface DeveloperSignInSettings {
    schemaVersion: 1; env: string; slack: boolean;
    oidc?: { issuer: string; clientId: string; requiredClaim?: string; requiredValues?: string[]; displayName: string; clientSecretName: string };
    updatedAt: string; updatedBy: string;
  }
  export interface StoredDeveloperSignIn { settings?: DeveloperSignInSettings; slackTeamId?: string }
  export function signInParameterName(env: string): string;        // /agentx/<env>/signin
  export function slackTeamIdParameterName(env: string): string;    // /agentx/<env>/slack/teamId
  export function oidcSecretName(env: string): string;              // agentx/<env>/developer-oidc
  export async function readSignInSettings(store: ParameterStore, env: string): Promise<DeveloperSignInSettings | undefined>;
  export async function writeSignInSettings(store: ParameterStore, settings: DeveloperSignInSettings): Promise<void>;
  export async function readSlackTeamId(store: ParameterStore, env: string): Promise<string | undefined>;
  export async function writeSlackTeamId(store: ParameterStore, env: string, teamId: string): Promise<void>;
  export async function readStoredDeveloperSignIn(store: ParameterStore, env: string): Promise<StoredDeveloperSignIn | undefined>;
  export function signInStackParameters(stored: StoredDeveloperSignIn): Record<string, string>;
  export function describeSignIn(settings: DeveloperSignInSettings | undefined): string[];
  ```
- Produces (`deploy/parameter-update.ts`):
  ```ts
  export interface ParameterChange { name: string; from: string; to: string }
  export interface ParameterUpdateInput {
    cloudFormation: { send(command: unknown): Promise<unknown> };
    stackName: string; roleArn: string; changes: Record<string, string>;
    confirm: (event: { stackName: string; parameters: ParameterChange[]; changes: ChangeSetChange[] }) => Promise<boolean>;
    write: (line: string) => void; now?: () => number; sleep?: (ms: number) => Promise<void>; pollMs?: number; timeoutMs?: number;
  }
  export async function updateStackParameters(input: ParameterUpdateInput): Promise<{ changed: boolean }>;
  ```
- `InstallAnswers` gains `developerSignIn?: StoredDeveloperSignIn`. `deployEnvironment` fills it
  from SSM when the deploy includes `control-plane` and the answers carry none (R7).

- [ ] **Step 1: Write the failing tests**

```ts
// tests/contract/signin-settings.test.ts
import { describe, expect, it } from "vitest";
import {
  describeSignIn, readSignInSettings, readStoredDeveloperSignIn, signInParameterName, signInStackParameters, slackTeamIdParameterName,
  writeSignInSettings, writeSlackTeamId, type DeveloperSignInSettings,
} from "../../packages/cli/src/signin/settings.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";

const slackOnly: DeveloperSignInSettings = { schemaVersion: 1, env: "staging", slack: true, updatedAt: "2026-09-27T00:00:00.000Z", updatedBy: "arn:aws:iam::123456789012:user/alice" };
const both: DeveloperSignInSettings = {
  ...slackOnly,
  oidc: { issuer: "https://acme.okta.com", clientId: "0oa1", requiredClaim: "groups", requiredValues: ["engineering"], displayName: "Okta", clientSecretName: "agentx/staging/developer-oidc" },
};

describe("sign-in settings in SSM (FR-010, R7)", () => {
  it("round-trip at /agentx/<env>/signin and hold no secret value", async () => {
    const store = new MemoryParameterStore();
    await writeSignInSettings(store, both);
    expect(store.values.has(signInParameterName("staging"))).toBe(true);
    expect(signInParameterName("staging")).toBe("/agentx/staging/signin");
    expect(await readSignInSettings(store, "staging")).toEqual(both);
    expect(store.values.get("/agentx/staging/signin")).not.toMatch(/clientSecret"/);
  });

  it("refuse a setting with no method enabled, an http issuer, a secret name for another environment, or another environment's name", async () => {
    const store = new MemoryParameterStore();
    await expect(writeSignInSettings(store, { ...slackOnly, slack: false })).rejects.toThrow(/Slack sign-in, company sign-in, or both/);
    await expect(writeSignInSettings(store, { ...both, oidc: { ...both.oidc!, issuer: "http://acme.okta.com" } })).rejects.toThrow(/https/);
    await expect(writeSignInSettings(store, { ...both, oidc: { ...both.oidc!, clientSecretName: "agentx/prod/developer-oidc" } })).rejects.toThrow(/agentx\/staging\/developer-oidc/);
    store.values.set("/agentx/staging/signin", JSON.stringify({ ...slackOnly, env: "other" }));
    await expect(readSignInSettings(store, "staging")).rejects.toThrow(/names environment other/);
  });

  it("keep the team ID at FR-006's path, and read nothing when nothing is stored", async () => {
    const store = new MemoryParameterStore();
    expect(await readStoredDeveloperSignIn(store, "staging")).toBeUndefined();
    await writeSlackTeamId(store, "staging", "T0TEAM1");
    expect(store.values.get(slackTeamIdParameterName("staging"))).toBe("T0TEAM1");
    expect(slackTeamIdParameterName("staging")).toBe("/agentx/staging/slack/teamId");
    await expect(writeSlackTeamId(store, "staging", "not-a-team")).rejects.toThrow(/team ID/);
    expect(await readStoredDeveloperSignIn(store, "staging")).toEqual({ slackTeamId: "T0TEAM1" });
  });
});

describe("stack parameters from stored sign-in", () => {
  it("map every sign-in parameter, sign-in off for what is not enabled", () => {
    expect(signInStackParameters({ settings: both, slackTeamId: "T0TEAM1" })).toEqual({
      SlackTeamId: "T0TEAM1", DeveloperSignInSlack: "enabled", DeveloperOidcIssuer: "https://acme.okta.com", DeveloperOidcClientId: "0oa1",
      DeveloperOidcRequiredClaim: "groups", DeveloperOidcRequiredValues: "[\"engineering\"]", DeveloperOidcDisplayName: "Okta",
    });
    expect(signInStackParameters({ slackTeamId: "T0TEAM1" })).toEqual({
      SlackTeamId: "T0TEAM1", DeveloperSignInSlack: "disabled", DeveloperOidcIssuer: "", DeveloperOidcClientId: "",
      DeveloperOidcRequiredClaim: "", DeveloperOidcRequiredValues: "[]", DeveloperOidcDisplayName: "Company sign-in",
    });
  });

  it("describe the settings in plain words", () => {
    expect(describeSignIn(both)).toEqual(["Slack sign-in: on", "Company sign-in: on (Okta, https://acme.okta.com, client 0oa1, requires groups: engineering)"]);
    expect(describeSignIn(undefined)).toEqual(["Slack sign-in: off", "Company sign-in: off"]);
  });
});
```

Add to `tests/contract/deploy-parameters.test.ts`, inside `describe("deploy parameters")`:

```ts
  it("passes stored developer sign-in to the control plane, every key declared by the template", () => {
    const params = stackParameters("control-plane", { ...answers(), developerSignIn: { slackTeamId: "T0TEAM1", settings: { schemaVersion: 1, env: "staging", slack: true, updatedAt: "2026-09-27T00:00:00.000Z", updatedBy: "x" } } }, outputs);
    expect(params).toMatchObject({ SlackTeamId: "T0TEAM1", DeveloperSignInSlack: "enabled", DeveloperOidcIssuer: "" });
    const declared = templates.get("control-plane")!.Parameters ?? {};
    expect(Object.keys(params).filter((name) => !(name in declared))).toEqual([]);
    expect(stackParameters("runtime", { ...answers(), developerSignIn: { slackTeamId: "T0TEAM1" } }, outputs)).not.toHaveProperty("SlackTeamId");
  });

  it("leaves the template defaults when no sign-in is stored", () => {
    expect(stackParameters("control-plane", answers(), outputs)).not.toHaveProperty("DeveloperSignInSlack");
  });
```

Add to `tests/contract/deploy-environment.test.ts`, inside `describe("deploy environment")`:

```ts
  it("passes the stored sign-in settings to every control-plane deploy (Review Focus 4, R7)", async () => {
    const store = new MemoryParameterStore();
    const secrets = memorySecrets();
    const first = fakeDeployer(scriptedOutputs());
    await deployEnvironment({ mode: "install", engine: "templates", answers: baseAnswers(), release: fakeRelease(), deployer: first.deployer, store, secrets, holder: HOLDER });
    await store.put("/agentx/staging/slack/teamId", "T0TEAM1");
    await store.put("/agentx/staging/signin", JSON.stringify({ schemaVersion: 1, env: "staging", slack: true, updatedAt: "2026-09-27T00:00:00.000Z", updatedBy: HOLDER }));

    const again = fakeDeployer(scriptedOutputs());
    await deployEnvironment({ mode: "upgrade", engine: "templates", answers: baseAnswers(), release: fakeRelease(), deployer: again.deployer, store, secrets, holder: HOLDER, parts: ["control-plane"] });
    expect(again.requests.find((request) => request.part === "control-plane")!.parameters).toMatchObject({ SlackTeamId: "T0TEAM1", DeveloperSignInSlack: "enabled" });
  });

  it("does not read sign-in settings for a deploy without the control plane", async () => {
    const store = new MemoryParameterStore();
    const { deployer } = fakeDeployer(scriptedOutputs());
    await deployEnvironment({ mode: "install", engine: "templates", answers: baseAnswers(), release: fakeRelease(), deployer, store, secrets: memorySecrets(), holder: HOLDER, parts: ["access"] });
    expect(store.calls.filter((call) => call.name.includes("/signin") || call.name.includes("/slack/teamId"))).toEqual([]);
  });
```

```ts
// tests/support/fake-cloudformation.ts
// A CloudFormation client for parameter-only updates (spec 025 R6): one stack, one change set.
import { CreateChangeSetCommand, DeleteChangeSetCommand, DescribeChangeSetCommand, DescribeStacksCommand, ExecuteChangeSetCommand } from "@aws-sdk/client-cloudformation";

const STACK = "agentx-staging-control-plane";

/** The control plane's sign-in parameters as a fresh 25a install leaves them. */
export const SIGN_IN_PARAMETERS: Record<string, string> = {
  CallbackSigningKey: "****", SlackTeamId: "", DeveloperSignInSlack: "disabled", DeveloperOidcIssuer: "", DeveloperOidcClientId: "",
  DeveloperOidcRequiredClaim: "", DeveloperOidcRequiredValues: "[]", DeveloperOidcDisplayName: "Company sign-in",
};

type Command = { constructor: { name: string }; input: Record<string, unknown> };

/** Applies an executed change set's parameters, so a later update sees the new values. */
export function fakeCloudFormation(options: { parameters?: Record<string, string>; status?: string; changeSet?: { status: "CREATE_COMPLETE" | "FAILED"; reason?: string }; finalStatus?: string; absent?: boolean } = {}) {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const parameters: Record<string, string> = { ...(options.parameters ?? { CallbackSigningKey: "****", SlackTeamId: "", DeveloperSignInSlack: "disabled", DeveloperOidcIssuer: "" }) };
  let pending: Array<{ ParameterKey: string; ParameterValue?: string; UsePreviousValue?: boolean }> = [];
  let executed = false;
  return {
    calls,
    parameters,
    async send(command: Command): Promise<unknown> {
      calls.push({ name: command.constructor.name, input: command.input });
      if (command instanceof DescribeStacksCommand) {
        if (options.absent) throw Object.assign(new Error(`Stack with id ${STACK} does not exist`), { name: "ValidationError" });
        return { Stacks: [{ StackName: STACK, StackStatus: executed ? options.finalStatus ?? "UPDATE_COMPLETE" : options.status ?? "UPDATE_COMPLETE", Parameters: Object.entries(parameters).map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue })) }] };
      }
      if (command instanceof CreateChangeSetCommand) {
        pending = (command.input.Parameters ?? []) as typeof pending;
        executed = false;
        return { Id: "arn:aws:cloudformation:us-east-1:123456789012:changeSet/agentx-signin/1" };
      }
      if (command instanceof DescribeChangeSetCommand) {
        return {
          Status: options.changeSet?.status ?? "CREATE_COMPLETE", StatusReason: options.changeSet?.reason,
          ExecutionStatus: executed ? "EXECUTE_COMPLETE" : "AVAILABLE",
          Changes: [{ ResourceChange: { Action: "Modify", LogicalResourceId: "DeveloperSignInFunction1A2B3C4D", ResourceType: "AWS::Lambda::Function", Replacement: "False" } }],
        };
      }
      if (command instanceof ExecuteChangeSetCommand) {
        executed = true;
        if ((options.finalStatus ?? "UPDATE_COMPLETE") === "UPDATE_COMPLETE") {
          for (const parameter of pending) if (parameter.ParameterValue !== undefined) parameters[parameter.ParameterKey] = parameter.ParameterValue;
        }
        return {};
      }
      if (command instanceof DeleteChangeSetCommand) return {};
      throw new Error(`unexpected ${command.constructor.name}`);
    },
  };
}
```

```ts
// tests/contract/parameter-update.test.ts
import { describe, expect, it } from "vitest";
import { updateStackParameters, type ParameterChange } from "../../packages/cli/src/deploy/parameter-update.js";
import { fakeCloudFormation } from "../support/fake-cloudformation.js";

const STACK = "agentx-staging-control-plane";
const ROLE = "arn:aws:iam::123456789012:role/agentx-staging-cloudformation";

const run = (cloudFormation: ReturnType<typeof fakeCloudFormation>, changes: Record<string, string>, confirm: (event: { parameters: ParameterChange[] }) => Promise<boolean> = async () => true) =>
  updateStackParameters({ cloudFormation, stackName: STACK, roleArn: ROLE, changes, confirm, write: () => undefined, sleep: async () => undefined, pollMs: 1 });

describe("parameter-only stack updates (R6)", () => {
  it("keeps the template and every other parameter, including the NoEcho signing key, and shows what changes", async () => {
    const cf = fakeCloudFormation();
    const seen: ParameterChange[][] = [];
    const result = await run(cf, { SlackTeamId: "T0TEAM1", DeveloperSignInSlack: "enabled" }, async (event) => { seen.push(event.parameters); return true; });
    expect(result).toEqual({ changed: true });
    const create = cf.calls.find((call) => call.name === "CreateChangeSetCommand")!.input;
    expect(create).toMatchObject({ StackName: STACK, ChangeSetType: "UPDATE", UsePreviousTemplate: true, RoleARN: ROLE, Capabilities: ["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM"] });
    expect(create.Parameters).toEqual([
      { ParameterKey: "CallbackSigningKey", UsePreviousValue: true },
      { ParameterKey: "SlackTeamId", ParameterValue: "T0TEAM1" },
      { ParameterKey: "DeveloperSignInSlack", ParameterValue: "enabled" },
      { ParameterKey: "DeveloperOidcIssuer", UsePreviousValue: true },
    ]);
    expect(seen).toEqual([[{ name: "SlackTeamId", from: "", to: "T0TEAM1" }, { name: "DeveloperSignInSlack", from: "disabled", to: "enabled" }]]);
    expect(cf.calls.map((call) => call.name)).toContain("ExecuteChangeSetCommand");
  });

  it("does nothing when the values are already set", async () => {
    const cf = fakeCloudFormation({ parameters: { SlackTeamId: "T0TEAM1" } });
    expect(await run(cf, { SlackTeamId: "T0TEAM1" })).toEqual({ changed: false });
    expect(cf.calls.map((call) => call.name)).toEqual(["DescribeStacksCommand"]);
  });

  it("refuses a stack deployed from a release without developer sign-in, naming the missing parameter", async () => {
    const cf = fakeCloudFormation({ parameters: { CallbackSigningKey: "****" } });
    await expect(run(cf, { SlackTeamId: "T0TEAM1" })).rejects.toThrow(`stack ${STACK} was deployed from an AgentX release without developer sign-in (it has no SlackTeamId parameter); upgrade the environment to a release with developer sign-in, then run this again`);
  });

  it.each([
    ["UPDATE_IN_PROGRESS", /is busy \(UPDATE_IN_PROGRESS\); try again when it finishes/],
    ["UPDATE_ROLLBACK_FAILED", /is UPDATE_ROLLBACK_FAILED; fix it in the CloudFormation console first/],
    ["ROLLBACK_COMPLETE", /is ROLLBACK_COMPLETE; fix it in the CloudFormation console first/],
  ])("refuses a stack that is %s", async (status, message) => {
    await expect(run(fakeCloudFormation({ status }), { SlackTeamId: "T0TEAM1" })).rejects.toThrow(message);
  });

  it("refuses a stack that does not exist", async () => {
    await expect(run(fakeCloudFormation({ absent: true }), { SlackTeamId: "T0TEAM1" })).rejects.toThrow(/does not exist; install the environment first/);
  });

  it("deletes the change set and changes nothing when declined", async () => {
    const cf = fakeCloudFormation();
    await expect(run(cf, { SlackTeamId: "T0TEAM1" }, async () => false)).rejects.toThrow(/not applied; nothing changed/);
    expect(cf.calls.map((call) => call.name)).toContain("DeleteChangeSetCommand");
    expect(cf.calls.map((call) => call.name)).not.toContain("ExecuteChangeSetCommand");
  });

  it("reports a failed update with what to do", async () => {
    await expect(run(fakeCloudFormation({ finalStatus: "UPDATE_ROLLBACK_COMPLETE" }), { SlackTeamId: "T0TEAM1" })).rejects.toThrow(/ended in UPDATE_ROLLBACK_COMPLETE; sign-in did not change/);
  });

  it("treats a change set with no changes as done", async () => {
    const cf = fakeCloudFormation({ changeSet: { status: "FAILED", reason: "The submitted information didn't contain changes." } });
    expect(await run(cf, { SlackTeamId: "T0TEAM1" })).toEqual({ changed: false });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/contract/signin-settings.test.ts tests/contract/parameter-update.test.ts tests/contract/deploy-parameters.test.ts tests/contract/deploy-environment.test.ts`
Expected: FAIL, the modules and `developerSignIn` do not exist.

- [ ] **Step 3: Implement the settings**

```ts
// packages/cli/src/signin/settings.ts
// Spec 025 FR-006 and FR-010 (R7): the developer sign-in choice, kept in SSM beside the environment
// settings. No secret value is ever stored here, only the company client secret's name.
import { z } from "zod";
import { EnvironmentNameSchema, SlackTeamIdSchema, agentXError, environmentSettingsPrefix } from "@agentx/contracts";
import type { ParameterStore } from "../environments/parameter-store.js";

export const DeveloperSignInSettingsSchema = z.object({
  schemaVersion: z.literal(1),
  env: EnvironmentNameSchema,
  slack: z.boolean(),
  oidc: z.object({
    issuer: z.string().url().refine((value) => value.startsWith("https://"), "the company issuer must use https"),
    clientId: z.string().min(1).max(256),
    requiredClaim: z.string().min(1).max(128).optional(),
    requiredValues: z.array(z.string().min(1).max(128)).min(1).max(20).optional(),
    displayName: z.string().min(1).max(40),
    clientSecretName: z.string().regex(/^agentx\/[a-z0-9-]+\/developer-oidc$/),
  }).strict().optional(),
  updatedAt: z.iso.datetime(),
  updatedBy: z.string().min(1).max(2048),
}).strict()
  .refine((settings) => settings.slack || settings.oidc !== undefined, "enable Slack sign-in, company sign-in, or both (FR-010)")
  .superRefine((settings, context) => {
    if (settings.oidc !== undefined && settings.oidc.clientSecretName !== oidcSecretName(settings.env)) {
      context.addIssue({ code: "custom", path: ["oidc", "clientSecretName"], message: `must be ${oidcSecretName(settings.env)}` });
    }
  });

export type DeveloperSignInSettings = z.infer<typeof DeveloperSignInSettingsSchema>;
export interface StoredDeveloperSignIn { settings?: DeveloperSignInSettings; slackTeamId?: string }

export const signInParameterName = (env: string) => `${environmentSettingsPrefix(env)}signin`;
export const slackTeamIdParameterName = (env: string) => `${environmentSettingsPrefix(env)}slack/teamId`;
export const oidcSecretName = (env: string) => `agentx/${env}/developer-oidc`;

const firstIssue = (error: z.ZodError) => `${error.issues[0]?.path.join(".") ?? ""} ${error.issues[0]?.message ?? ""}`.trim();

export async function readSignInSettings(store: ParameterStore, env: string): Promise<DeveloperSignInSettings | undefined> {
  const stored = await store.get(signInParameterName(env));
  if (stored === undefined) return undefined;
  let json: unknown;
  try { json = JSON.parse(stored.value); } catch { throw agentXError("CONFIG_INVALID", `${signInParameterName(env)} is not valid JSON; run agentx signin enable again`); }
  const parsed = DeveloperSignInSettingsSchema.safeParse(json);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", `${signInParameterName(env)} is invalid (${firstIssue(parsed.error)}); run agentx signin enable again`);
  if (parsed.data.env !== env) throw agentXError("CONFIG_INVALID", `${signInParameterName(env)} names environment ${parsed.data.env}; run agentx signin enable again`);
  return parsed.data;
}

export async function writeSignInSettings(store: ParameterStore, settings: DeveloperSignInSettings): Promise<void> {
  const parsed = DeveloperSignInSettingsSchema.safeParse(settings);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", `developer sign-in settings are invalid: ${firstIssue(parsed.error)}`);
  await store.put(signInParameterName(parsed.data.env), JSON.stringify(parsed.data));
}

export async function readSlackTeamId(store: ParameterStore, env: string): Promise<string | undefined> {
  const stored = await store.get(slackTeamIdParameterName(env));
  return stored === undefined || stored.value === "" ? undefined : stored.value;
}

export async function writeSlackTeamId(store: ParameterStore, env: string, teamId: string): Promise<void> {
  if (!SlackTeamIdSchema.safeParse(teamId).success) throw agentXError("CONFIG_INVALID", `${teamId} is not a Slack team ID (it starts with T)`);
  await store.put(slackTeamIdParameterName(env), teamId);
}

export async function readStoredDeveloperSignIn(store: ParameterStore, env: string): Promise<StoredDeveloperSignIn | undefined> {
  const [settings, slackTeamId] = await Promise.all([readSignInSettings(store, env), readSlackTeamId(store, env)]);
  if (settings === undefined && slackTeamId === undefined) return undefined;
  return { ...(settings === undefined ? {} : { settings }), ...(slackTeamId === undefined ? {} : { slackTeamId }) };
}

export function signInStackParameters(stored: StoredDeveloperSignIn): Record<string, string> {
  const oidc = stored.settings?.oidc;
  return {
    SlackTeamId: stored.slackTeamId ?? "",
    DeveloperSignInSlack: stored.settings?.slack === true ? "enabled" : "disabled",
    DeveloperOidcIssuer: oidc?.issuer ?? "",
    DeveloperOidcClientId: oidc?.clientId ?? "",
    DeveloperOidcRequiredClaim: oidc?.requiredClaim ?? "",
    DeveloperOidcRequiredValues: JSON.stringify(oidc?.requiredValues ?? []),
    DeveloperOidcDisplayName: oidc?.displayName ?? "Company sign-in",
  };
}

export function describeSignIn(settings: DeveloperSignInSettings | undefined): string[] {
  const oidc = settings?.oidc;
  const requirement = oidc?.requiredClaim === undefined ? "" : `, requires ${oidc.requiredClaim}: ${(oidc.requiredValues ?? []).join(" or ")}`;
  return [
    `Slack sign-in: ${settings?.slack === true ? "on" : "off"}`,
    oidc === undefined ? "Company sign-in: off" : `Company sign-in: on (${oidc.displayName}, ${oidc.issuer}, client ${oidc.clientId}${requirement})`,
  ];
}
```

- [ ] **Step 4: Carry stored sign-in into control-plane deploys**

In `packages/cli/src/deploy/parameters.ts`:
- `import { signInStackParameters, type StoredDeveloperSignIn } from "../signin/settings.js";`
- add to `InstallAnswers`, after `slackAppPostedMessages?`:
  `/** Spec 025 R7: the stored developer sign-in; deployEnvironment reads it from SSM when absent. */ developerSignIn?: StoredDeveloperSignIn;`
- in the `control-plane` case's returned object, after the `SlackAppPostedMessages` spread:
  `...(answers.developerSignIn === undefined ? {} : signInStackParameters(answers.developerSignIn)),`

In `packages/cli/src/deploy/deploy-environment.ts`, inside `work()`, replace the line building
`fullAnswers` with:

```ts
    const fullOrder = mode === "install" ? installOrder(answers.identity.mode) : upgradeOrder(answers.identity.mode);
    const deploySet = new Set(input.parts ?? fullOrder);
    // R7: a control-plane deploy always carries the stored developer sign-in, so no deploy resets it.
    const developerSignIn = answers.developerSignIn ?? (deploySet.has("control-plane") ? await readStoredDeveloperSignIn(store, env) : undefined);
    const fullAnswers: InstallAnswers = { ...answers, ...(developerSignIn === undefined ? {} : { developerSignIn }), release: release.manifest, callbackSigningKey: key };
```

and delete the now-duplicated `fullOrder` and `deploySet` declarations that followed it. Import
`readStoredDeveloperSignIn` from `../signin/settings.js`.

- [ ] **Step 5: Implement the parameter-only update**

```ts
// packages/cli/src/deploy/parameter-update.ts
// Spec 025 R6: change a few parameters of a deployed stack without a release: a change set with
// UsePreviousTemplate and UsePreviousValue for every other parameter, so NoEcho values are never
// sent again. It shows the parameter changes and the resource changes, and asks first.
import { CreateChangeSetCommand, DeleteChangeSetCommand, DescribeChangeSetCommand, DescribeStacksCommand, ExecuteChangeSetCommand, type Change, type Stack } from "@aws-sdk/client-cloudformation";
import { agentXError } from "@agentx/contracts";
import type { ChangeSetChange } from "./deployer.js";

export interface ParameterChange { name: string; from: string; to: string }
export interface ParameterUpdateInput {
  cloudFormation: { send(command: unknown): Promise<unknown> };
  stackName: string; roleArn: string; changes: Record<string, string>;
  confirm: (event: { stackName: string; parameters: ParameterChange[]; changes: ChangeSetChange[] }) => Promise<boolean>;
  write: (line: string) => void; now?: () => number; sleep?: (ms: number) => Promise<void>; pollMs?: number; timeoutMs?: number;
}

const NO_CHANGES = ["didn't contain changes", "No updates are to be performed"];
const ENDED = new Set(["EXECUTE_COMPLETE", "EXECUTE_FAILED", "OBSOLETE"]);

export async function updateStackParameters(input: ParameterUpdateInput): Promise<{ changed: boolean }> {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollMs = input.pollMs ?? 5_000;
  const deadline = now() + (input.timeoutMs ?? 30 * 60_000);
  const { stackName } = input;

  const describe = async (): Promise<Stack> => {
    try {
      const stack = ((await input.cloudFormation.send(new DescribeStacksCommand({ StackName: stackName }))) as { Stacks?: Stack[] }).Stacks?.[0];
      if (stack !== undefined) return stack;
    } catch (error) {
      if (!(error instanceof Error && error.name === "ValidationError" && /does not exist/.test(error.message))) throw error;
    }
    throw agentXError("CONFIG_INVALID", `stack ${stackName} does not exist; install the environment first`);
  };

  const stack = await describe();
  const status = stack.StackStatus ?? "";
  if (status.endsWith("_IN_PROGRESS")) throw agentXError("CONFIG_INVALID", `stack ${stackName} is busy (${status}); try again when it finishes`);
  if (status.endsWith("_FAILED") || status === "ROLLBACK_COMPLETE") throw agentXError("CONFIG_INVALID", `stack ${stackName} is ${status}; fix it in the CloudFormation console first`);
  const current = new Map((stack.Parameters ?? []).map((parameter) => [parameter.ParameterKey ?? "", parameter.ParameterValue ?? ""]));
  const missing = Object.keys(input.changes).filter((name) => !current.has(name));
  if (missing.length > 0) {
    throw agentXError("CONFIG_INVALID", `stack ${stackName} was deployed from an AgentX release without developer sign-in (it has no ${missing.join(", ")} parameter); upgrade the environment to a release with developer sign-in, then run this again`);
  }
  const parameters = Object.entries(input.changes).filter(([name, to]) => current.get(name) !== to).map(([name, to]) => ({ name, from: current.get(name) ?? "", to }));
  if (parameters.length === 0) return { changed: false };

  const changeSetName = `agentx-signin-${Math.floor(now() / 1000)}`;
  const id = { StackName: stackName, ChangeSetName: changeSetName };
  await input.cloudFormation.send(new CreateChangeSetCommand({
    ...id,
    ChangeSetType: "UPDATE",
    UsePreviousTemplate: true,
    Capabilities: ["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM"],
    RoleARN: input.roleArn,
    Parameters: [...current.keys()].map((key) => (key in input.changes ? { ParameterKey: key, ParameterValue: input.changes[key] } : { ParameterKey: key, UsePreviousValue: true })),
  }));
  const deleteChangeSet = () => input.cloudFormation.send(new DeleteChangeSetCommand(id)).catch(() => undefined);

  let changeSet: { Status?: string; StatusReason?: string; ExecutionStatus?: string; Changes?: Change[] };
  for (;;) {
    changeSet = await input.cloudFormation.send(new DescribeChangeSetCommand(id)) as typeof changeSet;
    if (changeSet.Status === "CREATE_COMPLETE" || changeSet.Status === "FAILED") break;
    if (now() > deadline) { await deleteChangeSet(); throw agentXError("RUNTIME_UNAVAILABLE", `the change set for ${stackName} took too long to prepare; nothing changed, run this again`); }
    await sleep(pollMs);
  }
  if (changeSet.Status === "FAILED") {
    await deleteChangeSet();
    if (NO_CHANGES.some((phrase) => (changeSet.StatusReason ?? "").includes(phrase))) return { changed: false };
    throw agentXError("CONFIG_INVALID", `the change set for ${stackName} failed: ${changeSet.StatusReason ?? "no reason given"}; nothing changed`);
  }
  const changes: ChangeSetChange[] = (changeSet.Changes ?? []).map((change) => ({
    action: change.ResourceChange?.Action ?? "", logicalId: change.ResourceChange?.LogicalResourceId ?? "",
    type: change.ResourceChange?.ResourceType ?? "", replacement: change.ResourceChange?.Replacement ?? "",
  }));
  if (!(await input.confirm({ stackName, parameters, changes }))) {
    await deleteChangeSet();
    throw agentXError("CONFIG_INVALID", `the sign-in change to ${stackName} was not applied; nothing changed`);
  }
  await input.cloudFormation.send(new ExecuteChangeSetCommand({ ...id, ClientRequestToken: changeSetName }));
  input.write(`Updating ${stackName}; this usually takes one to three minutes`);
  for (;;) {
    const executed = await input.cloudFormation.send(new DescribeChangeSetCommand(id)).catch(() => undefined) as { ExecutionStatus?: string } | undefined;
    const finished = executed === undefined || ENDED.has(executed.ExecutionStatus ?? "");
    const stackStatus = finished ? (await describe()).StackStatus ?? "" : "";
    if (finished && !stackStatus.endsWith("_IN_PROGRESS")) {
      if (stackStatus !== "UPDATE_COMPLETE") throw agentXError("CONFIG_INVALID", `stack ${stackName} ended in ${stackStatus}; sign-in did not change. See the stack's events in the CloudFormation console`);
      return { changed: true };
    }
    if (now() > deadline) throw agentXError("RUNTIME_UNAVAILABLE", `stack ${stackName} is still updating after 30 minutes; check it in the CloudFormation console`);
    await sleep(pollMs);
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass, and the deploy suites unchanged**

Run: `npx vitest run tests/contract/signin-settings.test.ts tests/contract/parameter-update.test.ts tests/contract/deploy-parameters.test.ts tests/contract/deploy-environment.test.ts tests/contract/deploy-cli.test.ts tests/contract/init-deploy-steps.test.ts tests/contract/export-bundle.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add tests/support/fake-cloudformation.ts packages/cli/src/signin/settings.ts packages/cli/src/deploy/parameter-update.ts packages/cli/src/deploy/parameters.ts packages/cli/src/deploy/deploy-environment.ts tests/contract/signin-settings.test.ts tests/contract/parameter-update.test.ts tests/contract/deploy-parameters.test.ts tests/contract/deploy-environment.test.ts
git commit -m "feat(cli): stored developer sign-in settings, kept by every control-plane deploy"
```

---

### Task 10: `agentx login <url>`, `whoami` and `logout`

**Files:**
- Modify: `packages/cli/src/auth.ts` (export the loopback listener; answer an `error` callback at once)
- Create: `packages/cli/src/developer/config.ts`
- Create: `packages/cli/src/developer/session.ts`
- Create: `packages/cli/src/developer/login.ts`
- Create: `packages/cli/src/developer/commands.ts`
- Modify: `packages/cli/src/main.ts` (`login [url]`, `--admin`, `--no-browser`; `logout`, `whoami`)
- Modify: `tests/contract/cli-main.test.ts` (append `logout` and `whoami` to the root command list; Open question 5)
- Test: `tests/contract/developer-login.test.ts`, `tests/contract/developer-session.test.ts`,
  `tests/contract/developer-cli.test.ts`

**Interfaces:**
- Consumes: Task 2's schemas and constants; `tokenStoreKey`, `openSystemBrowser`
  (`auth.ts`); `TokenStore`, `StoredTokens` (`token-store.ts`).
- Produces:
  - `auth.ts`: `export async function createCallbackListener(expectedState: string, timeoutMilliseconds: number, port: number): Promise<{ redirectUri: string; code: Promise<string>; close(): void }>`.
    A callback with the right `state` and an `error` rejects at once: `temporarily_unavailable`
    as `RUNTIME_UNAVAILABLE` "sign-in could not finish: <description>", anything else as
    `AUTH_REQUIRED` "sign-in refused: <description>". The description is stripped of control
    characters and cut to 300 characters.
  - `developer/config.ts`:
    ```ts
    export interface DeveloperEnvironment { url: string; issuer: string; tokenEndpoint: string; revocationEndpoint: string }
    export function developerConfigPath(home: string): string; // ~/.agentx/developer.yaml
    export async function readDeveloperConfig(home: string): Promise<{ default?: string; environments: Record<string, DeveloperEnvironment> }>;
    export async function saveDeveloperEnvironment(home: string, env: string, entry: DeveloperEnvironment): Promise<void>; // becomes the default; 0600; atomic
    export async function removeDeveloperEnvironment(home: string, env: string): Promise<void>;
    export async function resolveDeveloperEnvironment(home: string, env: string | undefined): Promise<{ env: string; entry: DeveloperEnvironment }>;
    export function developerTokenKey(issuer: string): string;
    ```
  - `developer/session.ts`:
    ```ts
    export interface DeveloperSessionDeps { home: string; tokenStore: TokenStore; fetch: typeof fetch; now?: () => number; sleep?: (ms: number) => Promise<void>; lockWaitMs?: number }
    export async function developerAccessToken(deps: DeveloperSessionDeps, env: string | undefined): Promise<{ env: string; entry: DeveloperEnvironment; accessToken: string }>;
    ```
    25b's MCP server calls `developerAccessToken` for every control-plane call.
  - `developer/login.ts`:
    ```ts
    export interface DeveloperLoginOptions { url: string; allowLoopback: boolean; browser: boolean; home: string; tokenStore: TokenStore; fetch: typeof fetch; openBrowser?: (url: string) => Promise<void>; write: (line: string) => void; timeoutMs?: number; callbackPort?: number }
    export async function developerLogin(options: DeveloperLoginOptions): Promise<{ env: string; configuration: AgentXConfiguration }>;
    ```
  - `developer/commands.ts`:
    ```ts
    export async function fetchDeveloperProjects(deps: DeveloperSessionDeps, env: string | undefined): Promise<{ env: string; url: string; projects: DeveloperProjectsResponse }>;
    export function whoamiText(result: { env: string; url: string; projects: DeveloperProjectsResponse }): string;
    export async function developerLogout(deps: DeveloperSessionDeps, env: string | undefined): Promise<{ env: string; revoked: boolean }>;
    ```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/contract/developer-login.test.ts
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { developerTokenKey, readDeveloperConfig } from "../../packages/cli/src/developer/config.js";
import { developerLogin } from "../../packages/cli/src/developer/login.js";
import { InMemoryTokenStore } from "../../packages/cli/src/token-store.js";

const URL_ = "https://abc123.execute-api.us-east-1.amazonaws.com";
const ISSUER = `${URL_}/v1/auth`;
const REFRESH = `agxr_${"r".repeat(43)}`;
const configuration = (overrides: Record<string, unknown> = {}) => ({
  env: "staging", apiVersion: "1.0", issuer: ISSUER, authorizationEndpoint: `${ISSUER}/authorize`, tokenEndpoint: `${ISSUER}/token`,
  revocationEndpoint: `${ISSUER}/revoke`, clientId: "agentx-cli", methods: { slack: true, oidc: null }, ...overrides,
});

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const home = async () => { const dir = await mkdtemp(join(tmpdir(), "agentx-dev-login-")); dirs.push(dir); return dir; };

function server(options: { configuration?: Record<string, unknown>; token?: (body: URLSearchParams) => Response } = {}) {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === `${URL_}/v1/auth/.well-known/agentx-configuration`) return Response.json(options.configuration ?? configuration());
    if (url === `${ISSUER}/token`) {
      const body = new URLSearchParams(String(init?.body));
      return options.token?.(body) ?? Response.json({ access_token: "access.jwt.value", token_type: "Bearer", expires_in: 3600, refresh_token: REFRESH });
    }
    throw new Error(`unexpected ${url}`);
  });
}

/** The browser: follow the authorize URL to the loopback with a code, or with an error. */
const browser = (answer: Record<string, string>) => async (authorizationUrl: string) => {
  const authorize = new URL(authorizationUrl);
  const callback = new URL(authorize.searchParams.get("redirect_uri")!);
  callback.searchParams.set("state", authorize.searchParams.get("state")!);
  for (const [key, value] of Object.entries(answer)) callback.searchParams.set(key, value);
  await fetch(callback);
};

describe("agentx login <url> (FR-011)", () => {
  it("reads the configuration, runs PKCE with a loopback on any port, stores the tokens and the environment", async () => {
    const dir = await home();
    const store = new InMemoryTokenStore();
    const fetchImpl = server();
    let authorize: URL | undefined;
    const result = await developerLogin({
      url: `${URL_}/`, allowLoopback: false, browser: true, home: dir, tokenStore: store, fetch: fetchImpl, write: () => undefined,
      openBrowser: async (link) => { authorize = new URL(link); await browser({ code: "agxc_code" })(link); },
    });
    expect(result.env).toBe("staging");
    expect(Object.fromEntries(authorize!.searchParams)).toMatchObject({ response_type: "code", client_id: "agentx-cli", code_challenge_method: "S256" });
    expect(authorize!.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:[1-9]\d*\/callback$/);
    const tokenCall = fetchImpl.mock.calls.find(([input]) => String(input).endsWith("/token"))!;
    expect(new URLSearchParams(String(tokenCall[1]?.body)).get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(await store.get(developerTokenKey(ISSUER))).toMatchObject({ accessToken: "access.jwt.value", refreshToken: REFRESH });
    expect(await readDeveloperConfig(dir)).toEqual({ default: "staging", environments: { staging: { url: URL_, issuer: ISSUER, tokenEndpoint: `${ISSUER}/token`, revocationEndpoint: `${ISSUER}/revoke` } } });
    expect((await stat(join(dir, ".agentx", "developer.yaml"))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(dir, ".agentx", "developer.yaml"), "utf8")).not.toContain(REFRESH);
  });

  it("stops at once with the server's reason when the sign-in is refused (Review Focus 1)", async () => {
    const dir = await home();
    const started = Date.now();
    await expect(developerLogin({
      url: URL_, allowLoopback: false, browser: true, home: dir, tokenStore: new InMemoryTokenStore(), fetch: server(), write: () => undefined, timeoutMs: 60_000,
      openBrowser: browser({ error: "access_denied", error_description: "you signed in to Slack workspace T0OTHER1, but this AgentX serves T0TEAM1\u0007" }),
    })).rejects.toThrow("AUTH_REQUIRED: sign-in refused: you signed in to Slack workspace T0OTHER1, but this AgentX serves T0TEAM1");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await readDeveloperConfig(dir)).toEqual({ environments: {} });
  });

  it("says a Slack outage is temporary", async () => {
    await expect(developerLogin({
      url: URL_, allowLoopback: false, browser: true, home: await home(), tokenStore: new InMemoryTokenStore(), fetch: server(), write: () => undefined,
      openBrowser: browser({ error: "temporarily_unavailable", error_description: "Slack could not be reached; run agentx login again in a minute" }),
    })).rejects.toThrow(/^RUNTIME_UNAVAILABLE: sign-in could not finish: Slack could not be reached/);
  });

  it("prints the link and waits on the loopback with --no-browser", async () => {
    const lines: string[] = [];
    const login = developerLogin({ url: URL_, allowLoopback: false, browser: false, home: await home(), tokenStore: new InMemoryTokenStore(), fetch: server(), write: (line) => lines.push(line) });
    await vi.waitFor(() => expect(lines.some((line) => line.includes(`${ISSUER}/authorize?`))).toBe(true));
    const link = lines.find((line) => line.includes(`${ISSUER}/authorize?`))!.match(/https:\/\/\S+/)![0];
    await browser({ code: "agxc_code" })(link);
    await expect(login).resolves.toMatchObject({ env: "staging" });
  });

  it.each([
    ["an endpoint on another origin", configuration({ tokenEndpoint: "https://evil.example.test/token" }), /must be on https:\/\/abc123/],
    ["a newer major API version", configuration({ apiVersion: "2.0" }), /upgrade: npx @charterarc\/agentx@latest login/],
    ["no enabled method", configuration({ methods: { slack: false, oidc: null } }), /no developer sign-in method is enabled.*agentx signin enable/],
  ])("refuses %s before opening a browser (R20)", async (_name, config, message) => {
    const openBrowser = vi.fn();
    await expect(developerLogin({ url: URL_, allowLoopback: false, browser: true, home: await home(), tokenStore: new InMemoryTokenStore(), fetch: server({ configuration: config }), write: () => undefined, openBrowser })).rejects.toThrow(message);
    expect(openBrowser).not.toHaveBeenCalled();
  });

  it("refuses a plain http URL outside --allow-loopback", async () => {
    await expect(developerLogin({ url: "http://abc123.example.test", allowLoopback: false, browser: true, home: await home(), tokenStore: new InMemoryTokenStore(), fetch: server(), write: () => undefined })).rejects.toThrow(/must use https/);
  });

  it("never prints or stores the refresh token outside the token store", async () => {
    const lines: string[] = [];
    const dir = await home();
    await developerLogin({ url: URL_, allowLoopback: false, browser: true, home: dir, tokenStore: new InMemoryTokenStore(), fetch: server(), write: (line) => lines.push(line), openBrowser: browser({ code: "agxc_code" }) });
    expect(lines.join("\n")).not.toContain(REFRESH);
    expect(lines.join("\n")).not.toContain("access.jwt.value");
  });
});
```

```ts
// tests/contract/developer-session.test.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { developerTokenKey, readDeveloperConfig, saveDeveloperEnvironment } from "../../packages/cli/src/developer/config.js";
import { developerAccessToken } from "../../packages/cli/src/developer/session.js";
import { InMemoryTokenStore } from "../../packages/cli/src/token-store.js";

const URL_ = "https://abc123.execute-api.us-east-1.amazonaws.com";
const ISSUER = `${URL_}/v1/auth`;
const entry = { url: URL_, issuer: ISSUER, tokenEndpoint: `${ISSUER}/token`, revocationEndpoint: `${ISSUER}/revoke` };
const T0 = Date.parse("2026-09-27T12:00:00.000Z");
const r = (c: string) => `agxr_${c.repeat(43)}`;

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function setup(tokens: { accessToken: string; refreshToken?: string; expiresAt: number }) {
  const home = await mkdtemp(join(tmpdir(), "agentx-dev-session-"));
  dirs.push(home);
  await saveDeveloperEnvironment(home, "staging", entry);
  const tokenStore = new InMemoryTokenStore();
  await tokenStore.set(developerTokenKey(ISSUER), tokens);
  return { home, tokenStore };
}

describe("developer access tokens on this machine", () => {
  it("uses a token that is still valid for more than a minute, without calling the server", async () => {
    const { home, tokenStore } = await setup({ accessToken: "valid", refreshToken: r("a"), expiresAt: T0 + 120_000 });
    const fetchImpl = vi.fn<typeof fetch>();
    expect(await developerAccessToken({ home, tokenStore, fetch: fetchImpl, now: () => T0 }, undefined)).toMatchObject({ env: "staging", accessToken: "valid" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refreshes silently and stores the rotated refresh token (US4 scenario 4)", async () => {
    const { home, tokenStore } = await setup({ accessToken: "old", refreshToken: r("a"), expiresAt: T0 + 30_000 });
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      expect(new URLSearchParams(String(init?.body)).get("refresh_token")).toBe(r("a"));
      return Response.json({ access_token: "new", token_type: "Bearer", expires_in: 3600, refresh_token: r("b") });
    });
    expect((await developerAccessToken({ home, tokenStore, fetch: fetchImpl, now: () => T0 }, "staging")).accessToken).toBe("new");
    expect(await tokenStore.get(developerTokenKey(ISSUER))).toEqual({ accessToken: "new", refreshToken: r("b"), expiresAt: T0 + 3_600_000 });
  });

  it("serializes concurrent refreshes so the server never sees the same refresh token twice (Review Focus 2, R19)", async () => {
    const { home, tokenStore } = await setup({ accessToken: "old", refreshToken: r("a"), expiresAt: T0 - 1 });
    const seen: string[] = [];
    let issued = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const token = new URLSearchParams(String(init?.body)).get("refresh_token")!;
      seen.push(token);
      await new Promise((resolve) => setTimeout(resolve, 50));
      issued += 1;
      return Response.json({ access_token: `new-${issued}`, token_type: "Bearer", expires_in: 3600, refresh_token: r(String.fromCharCode(97 + issued)) });
    });
    const deps = { home, tokenStore, fetch: fetchImpl, now: () => T0 };
    const results = await Promise.all([developerAccessToken(deps, "staging"), developerAccessToken(deps, "staging"), developerAccessToken(deps, "staging")]);
    expect(seen).toEqual([r("a")]);
    expect(new Set(results.map((result) => result.accessToken))).toEqual(new Set(["new-1"]));
  });

  it("takes over a lock file left by a crashed process after 30 seconds", async () => {
    const { home, tokenStore } = await setup({ accessToken: "old", refreshToken: r("a"), expiresAt: T0 - 1 });
    const { mkdir, writeFile, utimes } = await import("node:fs/promises");
    await mkdir(join(home, ".agentx", "locks"), { recursive: true });
    const lock = join(home, ".agentx", "locks", "developer-staging.lock");
    await writeFile(lock, "99999");
    await utimes(lock, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ access_token: "new", token_type: "Bearer", expires_in: 3600, refresh_token: r("b") }));
    expect((await developerAccessToken({ home, tokenStore, fetch: fetchImpl, now: () => T0 }, "staging")).accessToken).toBe("new");
  });

  it("deletes the tokens and names the exact login command when the sign-in has ended (US4 scenario 5)", async () => {
    const { home, tokenStore } = await setup({ accessToken: "old", refreshToken: r("a"), expiresAt: T0 - 1 });
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ error: "invalid_grant", error_description: "your AgentX sign-in has ended; run agentx login again" }, { status: 400 }));
    await expect(developerAccessToken({ home, tokenStore, fetch: fetchImpl, now: () => T0 }, "staging")).rejects.toThrow(`AUTH_REQUIRED: your AgentX sign-in for staging has ended (your AgentX sign-in has ended; run agentx login again); run npx @charterarc/agentx login ${URL_}`);
    expect(await tokenStore.get(developerTokenKey(ISSUER))).toBeUndefined();
  });

  it("keeps the tokens when the server says Slack is unavailable (Review Focus 3)", async () => {
    const { home, tokenStore } = await setup({ accessToken: "old", refreshToken: r("a"), expiresAt: T0 - 1 });
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ error: "temporarily_unavailable", error_description: "Slack could not be reached to check your account; your sign-in is kept, try again in a few minutes" }, { status: 503 }));
    await expect(developerAccessToken({ home, tokenStore, fetch: fetchImpl, now: () => T0 }, "staging")).rejects.toThrow(/^RUNTIME_UNAVAILABLE: Slack could not be reached/);
    expect(await tokenStore.get(developerTokenKey(ISSUER))).toMatchObject({ refreshToken: r("a") });
  });

  it("keeps the tokens when the control plane cannot be reached", async () => {
    const { home, tokenStore } = await setup({ accessToken: "old", refreshToken: r("a"), expiresAt: T0 - 1 });
    const fetchImpl = vi.fn<typeof fetch>(async () => { throw new TypeError("fetch failed"); });
    await expect(developerAccessToken({ home, tokenStore, fetch: fetchImpl, now: () => T0 }, "staging")).rejects.toThrow(/^RUNTIME_UNAVAILABLE: could not reach AgentX at https:\/\/abc123/);
    expect(await tokenStore.get(developerTokenKey(ISSUER))).toMatchObject({ refreshToken: r("a") });
  });

  it("says how to sign in when this machine never signed in to the environment", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentx-dev-session-"));
    dirs.push(home);
    await expect(developerAccessToken({ home, tokenStore: new InMemoryTokenStore(), fetch: vi.fn(), now: () => T0 }, "staging")).rejects.toThrow("AUTH_REQUIRED: this computer is not signed in to AgentX environment staging; run npx @charterarc/agentx login <your AgentX URL>");
    expect(await readDeveloperConfig(home)).toEqual({ environments: {} });
  });
});
```

```ts
// tests/contract/developer-cli.test.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { developerTokenKey, saveDeveloperEnvironment } from "../../packages/cli/src/developer/config.js";
import { executeCli } from "../../packages/cli/src/main.js";
import { InMemoryTokenStore } from "../../packages/cli/src/token-store.js";

const URL_ = "https://abc123.execute-api.us-east-1.amazonaws.com";
const ISSUER = `${URL_}/v1/auth`;
const entry = { url: URL_, issuer: ISSUER, tokenEndpoint: `${ISSUER}/token`, revocationEndpoint: `${ISSUER}/revoke` };
const projects = {
  developer: { id: "a".repeat(64), name: "Maya Chen", provider: "slack", slackUserId: "U0MAYA001" },
  projects: [
    { name: "payments-api", latestRevision: 7, access: "channel", channels: [{ channelId: "C0PAY0001" }] },
    { name: "solo", latestRevision: 1, access: "granted", channels: [] },
  ],
  notices: [],
};

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function signedIn() {
  const home = await mkdtemp(join(tmpdir(), "agentx-dev-cli-"));
  dirs.push(home);
  await saveDeveloperEnvironment(home, "staging", entry);
  const tokenStore = new InMemoryTokenStore();
  await tokenStore.set(developerTokenKey(ISSUER), { accessToken: "access", refreshToken: `agxr_${"a".repeat(43)}`, expiresAt: Date.now() + 3_600_000 });
  const out: string[] = [];
  const err: string[] = [];
  const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `${URL_}/v1/dev/projects`) {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access");
      return Response.json(projects);
    }
    if (url === `${ISSUER}/revoke`) return Response.json({});
    throw new Error(`unexpected ${url}`);
  });
  const run = (argv: string[]) => executeCli(argv, { fetchImplementation, tokenStore, environments: { home }, stdout: { write: (text: string) => out.push(text) }, stderr: { write: (text: string) => err.push(text) } });
  return { home, tokenStore, out, err, run, fetchImplementation };
}

describe("agentx whoami and logout (FR-011)", () => {
  it("whoami shows the name, method, Slack link and projects with how each is allowed (US4 scenario 1)", async () => {
    const h = await signedIn();
    expect(await h.run(["whoami"])).toBe(0);
    expect(h.out.join("")).toBe([
      `Signed in to AgentX environment staging (${URL_}) as Maya Chen, with Slack (U0MAYA001).`,
      "Projects you can use:",
      "  payments-api  (you are in its Slack channel C0PAY0001)",
      "  solo  (an admin granted you access)",
      "",
    ].join("\n"));
  });

  it("whoami --json prints the projects response", async () => {
    const h = await signedIn();
    expect(await h.run(["--json", "whoami"])).toBe(0);
    expect(JSON.parse(h.out.join(""))).toEqual({ ok: true, data: { env: "staging", url: URL_, ...projects } });
  });

  it("logout revokes the session at the server and removes the tokens and the environment", async () => {
    const h = await signedIn();
    expect(await h.run(["logout"])).toBe(0);
    expect(h.fetchImplementation.mock.calls.some(([input]) => String(input) === `${ISSUER}/revoke`)).toBe(true);
    expect(await h.tokenStore.get(developerTokenKey(ISSUER))).toBeUndefined();
    expect(h.out.join("")).toContain("Signed out of AgentX environment staging");
  });

  it("login refuses a URL together with --admin", async () => {
    const h = await signedIn();
    expect(await h.run(["login", URL_, "--admin"])).toBe(2);
    expect(h.err.join("")).toContain("use either agentx login <url> (developer sign-in) or agentx login --admin, not both");
  });
});
```

In `tests/contract/cli-main.test.ts`, change the root command list to
`["login", "logout", "whoami", "admin", "env", "deploy", "init"]` and rename the test to
"exposes administration and developer sign-in; developer tasks come from AI tools". This is Open
question 5's deliberate update. Task 12 inserts `signin` after `whoami`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/contract/developer-login.test.ts tests/contract/developer-session.test.ts tests/contract/developer-cli.test.ts tests/contract/cli-main.test.ts`
Expected: FAIL, the modules and commands do not exist.

- [ ] **Step 3: Export and extend the loopback listener**

In `packages/cli/src/auth.ts`, export `createCallbackListener` and replace its request handler
body after the `/callback` path check with:

```ts
    const callbackState = url.searchParams.get("state");
    const authorizationCode = url.searchParams.get("code");
    const failure = url.searchParams.get("error");
    if (callbackState === expectedState && failure !== null) {
      // The server refused or could not finish the sign-in: stop at once with its reason
      // (Review Focus 1) instead of waiting for the timeout.
      const description = (url.searchParams.get("error_description") ?? failure).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 300);
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end(`AgentX sign-in did not finish: ${description}\nYou can close this window and return to the terminal.`);
      rejectCode(failure === "temporarily_unavailable"
        ? agentXError("RUNTIME_UNAVAILABLE", `sign-in could not finish: ${description}`)
        : agentXError("AUTH_REQUIRED", `sign-in refused: ${description}`));
      return;
    }
    if (callbackState !== expectedState || !authorizationCode) {
      response.writeHead(400, { "content-type": "text/plain" }).end("Invalid authentication callback.");
      rejectCode(agentXError("AUTH_REQUIRED", "OIDC callback state or code is invalid"));
      return;
    }
    response.writeHead(200, { "content-type": "text/plain" }).end("AgentX authentication complete. You can close this window.");
    resolveCode(authorizationCode);
```

Right after the `code` promise is created, add `code.catch(() => undefined);` with the comment
"the caller awaits code after the browser step; this only stops Node reporting an early refusal as
an unhandled rejection". The promise itself still rejects for the caller.

The admin flow (`loginWithPkce`) keeps its behaviour; `tests/contract/auth-client.test.ts` must
pass unchanged.

- [ ] **Step 4: Implement the config, session, login and commands**

```ts
// packages/cli/src/developer/config.ts
// ~/.agentx/developer.yaml: which AgentX environments this computer has signed in to (FR-011).
// Never holds a token: tokens live in the system token store.
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { AGENTX_CLI_CLIENT_ID, DEVELOPER_TOKEN_AUDIENCE, EnvironmentNameSchema, agentXError } from "@agentx/contracts";
import YAML from "yaml";
import { z } from "zod";
import { tokenStoreKey } from "../auth.js";

const EntrySchema = z.object({ url: z.string().url(), issuer: z.string().url(), tokenEndpoint: z.string().url(), revocationEndpoint: z.string().url() }).strict();
const ConfigSchema = z.object({ schemaVersion: z.literal(1), default: EnvironmentNameSchema.optional(), environments: z.record(EnvironmentNameSchema, EntrySchema) }).strict();
export type DeveloperEnvironment = z.infer<typeof EntrySchema>;

export const developerConfigPath = (home: string) => join(home, ".agentx", "developer.yaml");
export const developerTokenKey = (issuer: string) => tokenStoreKey({ issuer, clientId: AGENTX_CLI_CLIENT_ID, audience: DEVELOPER_TOKEN_AUDIENCE });

export async function readDeveloperConfig(home: string): Promise<{ default?: string; environments: Record<string, DeveloperEnvironment> }> {
  let text: string;
  try { text = await readFile(developerConfigPath(home), "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { environments: {} };
    throw error;
  }
  const parsed = ConfigSchema.safeParse(YAML.parse(text));
  if (!parsed.success) throw agentXError("CONFIG_INVALID", `${developerConfigPath(home)} is invalid; delete it and run agentx login <url> again`);
  return { ...(parsed.data.default === undefined ? {} : { default: parsed.data.default }), environments: parsed.data.environments };
}

async function write(home: string, config: { default?: string; environments: Record<string, DeveloperEnvironment> }): Promise<void> {
  const path = developerConfigPath(home);
  await mkdir(join(home, ".agentx"), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  const handle = await open(temp, "w", 0o600);
  try { await handle.writeFile(YAML.stringify({ schemaVersion: 1, ...config })); } finally { await handle.close(); }
  try { await rename(temp, path); } catch (error) { await rm(temp, { force: true }); throw error; }
}

export async function saveDeveloperEnvironment(home: string, env: string, entry: DeveloperEnvironment): Promise<void> {
  const config = await readDeveloperConfig(home);
  await write(home, { default: env, environments: { ...config.environments, [env]: EntrySchema.parse(entry) } });
}

export async function removeDeveloperEnvironment(home: string, env: string): Promise<void> {
  const config = await readDeveloperConfig(home);
  const { [env]: _removed, ...rest } = config.environments;
  const nextDefault = config.default === env ? Object.keys(rest).sort()[0] : config.default;
  await write(home, { ...(nextDefault === undefined ? {} : { default: nextDefault }), environments: rest });
}

export async function resolveDeveloperEnvironment(home: string, env: string | undefined): Promise<{ env: string; entry: DeveloperEnvironment }> {
  const config = await readDeveloperConfig(home);
  const name = env ?? config.default;
  const entry = name === undefined ? undefined : config.environments[name];
  if (name === undefined || entry === undefined) {
    throw agentXError("AUTH_REQUIRED", `this computer is not signed in to AgentX${name === undefined ? "" : ` environment ${name}`}; run npx @charterarc/agentx login <your AgentX URL>`);
  }
  return { env: name, entry };
}
```

```ts
// packages/cli/src/developer/session.ts
// The developer's AgentX tokens on this computer: used as long as they are valid, refreshed once,
// under a lock file, when they are not (R19). A failed refresh deletes tokens only when the server
// says the sign-in has ended (R18).
import { mkdir, open, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { AGENTX_CLI_CLIENT_ID, DeveloperTokenResponseSchema, agentXError } from "@agentx/contracts";
import type { TokenStore } from "../token-store.js";
import { developerTokenKey, resolveDeveloperEnvironment, type DeveloperEnvironment } from "./config.js";

export interface DeveloperSessionDeps { home: string; tokenStore: TokenStore; fetch: typeof fetch; now?: () => number; sleep?: (ms: number) => Promise<void>; lockWaitMs?: number }

const EARLY_MS = 60_000;
const STALE_LOCK_MS = 30_000;

async function withRefreshLock<T>(deps: DeveloperSessionDeps, env: string, work: () => Promise<T>): Promise<T> {
  const dir = join(deps.home, ".agentx", "locks");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `developer-${env}.lock`);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + (deps.lockWaitMs ?? 15_000);
  for (;;) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(String(process.pid));
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const age = await stat(path).then((info) => Date.now() - info.mtimeMs, () => 0);
      if (age > STALE_LOCK_MS) { await rm(path, { force: true }); continue; }
      if (Date.now() > deadline) throw agentXError("RUNTIME_UNAVAILABLE", `another agentx process is refreshing your sign-in to ${env}; try again in a moment`);
      await sleep(50);
    }
  }
  try { return await work(); } finally { await rm(path, { force: true }); }
}

export async function developerAccessToken(deps: DeveloperSessionDeps, env: string | undefined): Promise<{ env: string; entry: DeveloperEnvironment; accessToken: string }> {
  const now = deps.now ?? Date.now;
  const resolved = await resolveDeveloperEnvironment(deps.home, env);
  const key = developerTokenKey(resolved.entry.issuer);
  const signIn = `run npx @charterarc/agentx login ${resolved.entry.url}`;
  const fresh = (tokens: { expiresAt: number } | undefined) => tokens !== undefined && tokens.expiresAt - EARLY_MS > now();

  const stored = await deps.tokenStore.get(key);
  if (stored === undefined) throw agentXError("AUTH_REQUIRED", `this computer is not signed in to AgentX environment ${resolved.env}; ${signIn}`);
  if (fresh(stored)) return { ...resolved, accessToken: stored.accessToken };

  return withRefreshLock(deps, resolved.env, async () => {
    // Another process may have refreshed while this one waited for the lock.
    const current = await deps.tokenStore.get(key);
    if (current !== undefined && fresh(current)) return { ...resolved, accessToken: current.accessToken };
    if (current?.refreshToken === undefined) throw agentXError("AUTH_REQUIRED", `your AgentX sign-in for ${resolved.env} has ended; ${signIn}`);
    let response: Response;
    try {
      response = await deps.fetch(resolved.entry.tokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", client_id: AGENTX_CLI_CLIENT_ID, refresh_token: current.refreshToken }).toString(),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw agentXError("RUNTIME_UNAVAILABLE", `could not reach AgentX at ${resolved.entry.url}; check your connection and try again`);
    }
    const body = await response.json().catch(() => ({})) as { error?: unknown; error_description?: unknown };
    const reason = typeof body.error_description === "string" ? body.error_description.slice(0, 300) : "no reason given";
    if (response.status === 400 && body.error === "invalid_grant") {
      await deps.tokenStore.delete(key);
      throw agentXError("AUTH_REQUIRED", `your AgentX sign-in for ${resolved.env} has ended (${reason}); ${signIn}`);
    }
    if (!response.ok) throw agentXError("RUNTIME_UNAVAILABLE", response.status === 503 ? reason : `AgentX could not refresh your sign-in (HTTP ${response.status}); try again`);
    const parsed = DeveloperTokenResponseSchema.safeParse(body);
    if (!parsed.success) throw agentXError("RUNTIME_UNAVAILABLE", "AgentX answered the refresh with something unexpected; try again");
    await deps.tokenStore.set(key, { accessToken: parsed.data.access_token, refreshToken: parsed.data.refresh_token, expiresAt: now() + parsed.data.expires_in * 1000 });
    return { ...resolved, accessToken: parsed.data.access_token };
  });
}
```

```ts
// packages/cli/src/developer/login.ts
// agentx login <url> (FR-011): the developer sign-in. It needs no AWS credentials.
import { createHash, randomBytes } from "node:crypto";
import { AGENTX_CLI_CLIENT_ID, AgentXConfigurationSchema, DEVELOPER_API_VERSION, DeveloperTokenResponseSchema, agentXError, apiVersionCompatible, type AgentXConfiguration } from "@agentx/contracts";
import { createCallbackListener, openSystemBrowser } from "../auth.js";
import type { TokenStore } from "../token-store.js";
import { developerTokenKey, saveDeveloperEnvironment } from "./config.js";

export interface DeveloperLoginOptions { url: string; allowLoopback: boolean; browser: boolean; home: string; tokenStore: TokenStore; fetch: typeof fetch; openBrowser?: (url: string) => Promise<void>; write: (line: string) => void; timeoutMs?: number; callbackPort?: number }

export async function developerLogin(options: DeveloperLoginOptions): Promise<{ env: string; configuration: AgentXConfiguration }> {
  let base: URL;
  try { base = new URL(options.url); } catch { throw agentXError("CONFIG_INVALID", `${options.url} is not a URL; pass your AgentX URL, for example https://agentx.example.com`); }
  if (base.protocol !== "https:" && !(options.allowLoopback && base.protocol === "http:")) throw agentXError("CONFIG_INVALID", "your AgentX URL must use https");
  const url = base.origin + base.pathname.replace(/\/+$/, "");

  let configuration: AgentXConfiguration;
  try {
    const response = await options.fetch(`${url}/v1/auth/.well-known/agentx-configuration`, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    configuration = AgentXConfigurationSchema.parse(await response.json());
  } catch {
    throw agentXError("CONFIG_INVALID", `${url} does not look like an AgentX environment with developer sign-in; check the URL with your admin`);
  }
  for (const endpoint of [configuration.authorizationEndpoint, configuration.tokenEndpoint, configuration.revocationEndpoint]) {
    if (new URL(endpoint).origin !== base.origin) throw agentXError("CONFIG_INVALID", `the sign-in endpoints must be on ${base.origin}; ${endpoint} is not, so nothing was sent`);
  }
  const version = apiVersionCompatible(configuration.apiVersion, DEVELOPER_API_VERSION);
  if (!version.compatible) throw agentXError("CONFIG_INVALID", `this AgentX (API ${configuration.apiVersion}) needs a newer CLI; upgrade: npx @charterarc/agentx@latest login ${url}`);
  if (!configuration.methods.slack && configuration.methods.oidc === null) {
    throw agentXError("CONFIG_INVALID", "no developer sign-in method is enabled in this AgentX; ask an admin to run agentx signin enable slack");
  }

  const verifier = randomBytes(48).toString("base64url");
  const state = randomBytes(24).toString("base64url");
  const listener = await createCallbackListener(state, options.timeoutMs ?? 300_000, options.callbackPort ?? 0);
  try {
    const authorize = new URL(configuration.authorizationEndpoint);
    for (const [key, value] of Object.entries({
      response_type: "code", client_id: AGENTX_CLI_CLIENT_ID, redirect_uri: listener.redirectUri, state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
    })) authorize.searchParams.set(key, value);
    if (options.browser) {
      options.write(`Opening your browser to sign in to AgentX environment ${configuration.env}. If it does not open, open this link: ${authorize.toString()}`);
      await (options.openBrowser ?? openSystemBrowser)(authorize.toString()).catch(() => undefined);
    } else {
      options.write(`Open this link in a browser on this computer to sign in to AgentX environment ${configuration.env}: ${authorize.toString()}`);
    }
    const code = await listener.code;
    const response = await options.fetch(configuration.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: AGENTX_CLI_CLIENT_ID, code, code_verifier: verifier, redirect_uri: listener.redirectUri }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    const tokens = DeveloperTokenResponseSchema.safeParse(body);
    if (!response.ok || !tokens.success) {
      const reason = typeof body.error_description === "string" ? body.error_description.slice(0, 300) : `HTTP ${response.status}`;
      throw agentXError("AUTH_REQUIRED", `sign-in failed: ${reason}`);
    }
    await options.tokenStore.set(developerTokenKey(configuration.issuer), {
      accessToken: tokens.data.access_token, refreshToken: tokens.data.refresh_token, expiresAt: Date.now() + tokens.data.expires_in * 1000,
    });
    await saveDeveloperEnvironment(options.home, configuration.env, { url, issuer: configuration.issuer, tokenEndpoint: configuration.tokenEndpoint, revocationEndpoint: configuration.revocationEndpoint });
    return { env: configuration.env, configuration };
  } finally {
    listener.close();
  }
}
```

```ts
// packages/cli/src/developer/commands.ts
// agentx whoami and agentx logout (FR-011).
import { AGENTX_CLI_CLIENT_ID, DeveloperProjectsResponseSchema, agentXError, type DeveloperProjectsResponse } from "@agentx/contracts";
import { developerTokenKey, removeDeveloperEnvironment, resolveDeveloperEnvironment } from "./config.js";
import { developerAccessToken, type DeveloperSessionDeps } from "./session.js";

export async function fetchDeveloperProjects(deps: DeveloperSessionDeps, env: string | undefined): Promise<{ env: string; url: string; projects: DeveloperProjectsResponse }> {
  const session = await developerAccessToken(deps, env);
  let response: Response;
  try {
    response = await deps.fetch(`${session.entry.url}/v1/dev/projects`, { headers: { authorization: `Bearer ${session.accessToken}` }, signal: AbortSignal.timeout(20_000) });
  } catch {
    throw agentXError("RUNTIME_UNAVAILABLE", `could not reach AgentX at ${session.entry.url}; check your connection and try again`);
  }
  if (response.status === 401) throw agentXError("AUTH_REQUIRED", `your AgentX sign-in for ${session.env} has ended; run npx @charterarc/agentx login ${session.entry.url}`);
  if (!response.ok) throw agentXError("RUNTIME_UNAVAILABLE", `AgentX answered HTTP ${response.status}; try again`);
  return { env: session.env, url: session.entry.url, projects: DeveloperProjectsResponseSchema.parse(await response.json()) };
}

export function whoamiText(result: { env: string; url: string; projects: DeveloperProjectsResponse }): string {
  const { developer, projects, notices } = result.projects;
  const method = developer.provider === "slack" ? "Slack" : "your company sign-in";
  const link = developer.slackUserId === undefined ? "" : ` (${developer.slackUserId})`;
  const lines = [`Signed in to AgentX environment ${result.env} (${result.url}) as ${developer.name}, with ${method}${link}.`];
  if (projects.length === 0) {
    lines.push("You cannot use any project yet: join a project's Slack channel, or ask an admin for access.");
  } else {
    lines.push("Projects you can use:");
    for (const project of projects) {
      lines.push(`  ${project.name}  (${project.access === "granted" ? "an admin granted you access" : `you are in its Slack channel ${project.channels.map((channel) => channel.channelId).join(", ")}`})`);
    }
  }
  if (notices.includes("slack_unavailable")) lines.push("Slack could not be reached, so projects you use through a Slack channel are not listed; try again later.");
  return `${lines.join("\n")}\n`;
}

export async function developerLogout(deps: DeveloperSessionDeps, env: string | undefined): Promise<{ env: string; revoked: boolean }> {
  const resolved = await resolveDeveloperEnvironment(deps.home, env);
  const key = developerTokenKey(resolved.entry.issuer);
  const tokens = await deps.tokenStore.get(key);
  let revoked = false;
  if (tokens?.refreshToken !== undefined) {
    revoked = await deps.fetch(resolved.entry.revocationEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: tokens.refreshToken, client_id: AGENTX_CLI_CLIENT_ID }).toString(),
      signal: AbortSignal.timeout(5_000),
    }).then((response) => response.ok, () => false);
  }
  await deps.tokenStore.delete(key);
  await removeDeveloperEnvironment(deps.home, resolved.env);
  return { env: resolved.env, revoked };
}
```

- [ ] **Step 5: Wire the commands**

In `packages/cli/src/main.ts`, replace the `login` command with:

```ts
  program
    .command("login")
    .description("sign in: agentx login <url> for developers; agentx login --admin (or no URL) for administrators")
    .argument("[url]", "your AgentX URL, for developer sign-in")
    .option("--admin", "sign in as an administrator with the admin identity provider (the default when no URL is given)", false)
    .option("--no-browser", "developer sign-in: print the sign-in link instead of opening a browser")
    .option("--callback-port <port>", "fixed loopback callback port registered with the OIDC client", parsePort, DEFAULT_CALLBACK_PORT)
    .action(async (url: string | undefined, options: { admin: boolean; browser: boolean; callbackPort: number }, command: Command) => {
      const globals = globalOptions(command);
      if (url !== undefined && options.admin) {
        throw agentXError("CONFIG_INVALID", "use either agentx login <url> (developer sign-in) or agentx login --admin, not both");
      }
      if (url !== undefined) {
        const session = { home, tokenStore: services.tokenStore, fetch: services.fetchImplementation };
        const result = await developerLogin({
          url, allowLoopback: globals.allowLoopback, browser: options.browser, home, tokenStore: services.tokenStore, fetch: services.fetchImplementation,
          write: (line) => { services.stderr.write(`${line}\n`); },
          ...(command.getOptionValueSource("callbackPort") === "cli" ? { callbackPort: options.callbackPort } : {}),
        });
        const projects = await fetchDeveloperProjects(session, result.env);
        services.stdout.write(globals.json ? formatSuccess({ ...projects.projects, env: projects.env, url: projects.url }, true) : whoamiText(projects));
        return;
      }
      // R4: today's admin login, unchanged.
      const settings = await deploymentSettings(globals);
      await loginWithPkce({
        issuer: settings.auth.issuer, clientId: settings.auth.clientId, audience: settings.auth.audience,
        tokenStore: services.tokenStore, fetchImplementation: services.fetchImplementation, callbackPort: options.callbackPort,
      });
      services.stdout.write(formatSuccess({ controlPlaneUrl: settings.controlPlaneUrl, authenticated: true }, globals.json));
    });

  /** The developer environment: --env when typed, otherwise the default agentx login set. */
  const developerEnv = (command: Command): string | undefined =>
    command.getOptionValueSourceWithGlobals("env") === "cli" ? globalOptions(command).env : undefined;

  program
    .command("logout")
    .description("sign out of AgentX on this computer; --admin signs out of the admin sign-in")
    .option("--admin", "sign out of the administrator sign-in instead", false)
    .action(async (options: { admin: boolean }, command: Command) => {
      const globals = globalOptions(command);
      if (options.admin) {
        const settings = await deploymentSettings(globals);
        await services.tokenStore.delete(tokenStoreKey(settings.auth));
        services.stdout.write(globals.json ? formatSuccess({ env: globals.env, admin: true }, true) : `Signed out of the admin sign-in for ${globals.env}.\n`);
        return;
      }
      const result = await developerLogout({ home, tokenStore: services.tokenStore, fetch: services.fetchImplementation }, developerEnv(command));
      services.stdout.write(globals.json ? formatSuccess(result, true) : `Signed out of AgentX environment ${result.env}.\n`);
    });

  program
    .command("whoami")
    .description("show who you are signed in as and which AgentX projects you can use")
    .action(async (_options: unknown, command: Command) => {
      const globals = globalOptions(command);
      const result = await fetchDeveloperProjects({ home, tokenStore: services.tokenStore, fetch: services.fetchImplementation }, developerEnv(command));
      services.stdout.write(globals.json ? formatSuccess({ env: result.env, url: result.url, ...result.projects }, true) : whoamiText(result));
    });
```

Import `developerLogin` from `./developer/login.js` and `developerLogout`, `fetchDeveloperProjects`,
`whoamiText` from `./developer/commands.js`. Change the program's description to "AgentX: sign in,
and administer AgentX; developers hand off tasks from their AI tools or work in Slack".

- [ ] **Step 6: Run the tests to verify they pass, and the CLI suites unchanged**

Run: `npx vitest run tests/contract/developer-login.test.ts tests/contract/developer-session.test.ts tests/contract/developer-cli.test.ts tests/contract/cli-main.test.ts tests/contract/auth-client.test.ts tests/contract/cli-execution.test.ts tests/contract/environment-cli.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/auth.ts packages/cli/src/developer packages/cli/src/main.ts tests/contract/developer-login.test.ts tests/contract/developer-session.test.ts tests/contract/developer-cli.test.ts tests/contract/cli-main.test.ts
git commit -m "feat(cli): agentx login <url>, whoami and logout for developers"
```

---
### Task 11: The Slack app for sign-in, the team ID, and `env adopt`

**Files:**
- Modify: `packages/cli/src/init/slack-app.ts`
- Modify: `packages/cli/src/environments/adopt.ts`, `packages/cli/src/environments/commands.ts`, `packages/cli/src/main.ts` (adopt wiring)
- Modify: `tests/contract/init-slack-app.test.ts` (the manifest expectations: Open question 5), `tests/contract/environment-adopt.test.ts`
- Test: the same two files

**Interfaces:**
- Consumes: `writeSlackTeamId` (Task 9); `InitSecrets` (`init/context.ts`); `SlackApi`.
- Produces (`init/slack-app.ts`):
  - `SLACK_BOT_SCOPES` becomes `["app_mentions:read", "channels:join", "channels:read", "chat:write", "groups:read", "im:write", "users:read", "users:read.email"]`;
  - `SLACK_USER_SCOPES = ["email", "openid", "profile"]`;
  - `SIGN_IN_BOT_SCOPES = ["channels:read", "groups:read", "im:write", "users:read", "users:read.email"]`;
  - `slackAppManifest(input: { appName: string; eventsUrl: string; interactivityUrl: string; signInCallbackUrl: string }): SlackManifest`,
    with `oauth_config: { redirect_urls: [signInCallbackUrl], scopes: { bot, user } }`;
  - `slackSignInCallbackUrl(apiEndpoint: string): string` (`<api>/v1/auth/callback/slack`);
  - `SlackApi.authTest` results gain `scopes?: string[]`, from the `x-oauth-scopes` response header;
  - `missingScopes(granted: readonly string[] | undefined, needed: readonly string[]): string[]`;
  - `slackSecretWithBot(existing: string | undefined, bot: { signingSecret: string; botToken: string }): string`
    (keeps `clientId` and `clientSecret`: R11);
  - `slackSecretWithSignIn(existing: string | undefined, client: { clientId: string; clientSecret: string }): string`
    (keeps every other key);
  - `readSlackTeamIdFromSecret(input: { secrets: Pick<InitSecrets, "get">; api: SlackApi; secretId: string }): Promise<{ teamId: string; scopes?: string[] }>`.
- Produces (`environments/adopt.ts`): `adoptEnvironment` input gains
  `slackTeamId?: (slackSecretArn: string) => Promise<string>` and `write?: (line: string) => void`.

- [ ] **Step 1: Update the manifest test and write the new failing tests**

In `tests/contract/init-slack-app.test.ts`:
- add `const SIGNIN = "https://abc123.execute-api.us-east-1.amazonaws.com/v1/auth/callback/slack";`;
- pass `signInCallbackUrl: SIGNIN` in both `slackAppManifest(...)` calls;
- change the manifest expectation's `oauth_config` to:

```ts
      oauth_config: {
        redirect_urls: [SIGNIN],
        scopes: {
          bot: ["app_mentions:read", "channels:join", "channels:read", "chat:write", "groups:read", "im:write", "users:read", "users:read.email"],
          user: ["email", "openid", "profile"],
        },
      },
```

Then add:

```ts
import { missingScopes, readSlackTeamIdFromSecret, slackSecretWithBot, slackSecretWithSignIn, slackSignInCallbackUrl, SIGN_IN_BOT_SCOPES } from "../../packages/cli/src/init/slack-app.js";

describe("Slack sign-in support in the app (FR-044, R10, R11)", () => {
  it("builds the sign-in callback URL from the control plane's endpoint", () => {
    expect(slackSignInCallbackUrl("https://abc123.execute-api.us-east-1.amazonaws.com/")).toBe(SIGNIN);
  });

  it("keeps the sign-in client ID and secret when the bot token is replaced (Review Focus 5)", async () => {
    const existing = JSON.stringify({ signingSecret: "old", botToken: "xoxb-old", clientId: "1111.2222", clientSecret: "f".repeat(32) });
    expect(JSON.parse(slackSecretWithBot(existing, { signingSecret: TEST_SIGNING_SECRET, botToken: TEST_BOT_TOKEN }))).toEqual({
      signingSecret: TEST_SIGNING_SECRET, botToken: TEST_BOT_TOKEN, clientId: "1111.2222", clientSecret: "f".repeat(32),
    });
    // The control plane's placeholder carries no sign-in keys, and none are invented.
    expect(JSON.parse(slackSecretWithBot(JSON.stringify({ botToken: "unset", signingSecret: PLACEHOLDER }), { signingSecret: TEST_SIGNING_SECRET, botToken: TEST_BOT_TOKEN }))).toEqual({ signingSecret: TEST_SIGNING_SECRET, botToken: TEST_BOT_TOKEN });

    const context = slackContext(["installed", TEST_BOT_TOKEN, TEST_SIGNING_SECRET, true]);
    context.secrets.values.set(SLACK_SECRET, existing);
    await slackAppStep(fakeSlackApi()).run(context, progressHandle());
    expect(JSON.parse(context.secrets.values.get(SLACK_SECRET)!)).toMatchObject({ clientId: "1111.2222", clientSecret: "f".repeat(32), botToken: TEST_BOT_TOKEN });
  });

  it("adds the client credentials and keeps the bot token and signing secret", () => {
    const existing = JSON.stringify({ signingSecret: TEST_SIGNING_SECRET, botToken: TEST_BOT_TOKEN });
    expect(JSON.parse(slackSecretWithSignIn(existing, { clientId: "1111.2222", clientSecret: "e".repeat(32) }))).toEqual({
      signingSecret: TEST_SIGNING_SECRET, botToken: TEST_BOT_TOKEN, clientId: "1111.2222", clientSecret: "e".repeat(32),
    });
  });

  it("reads the team ID and granted scopes with the stored bot token, never echoing it", async () => {
    const secrets = memoryInitSecrets({ [SLACK_SECRET]: JSON.stringify({ signingSecret: TEST_SIGNING_SECRET, botToken: TEST_BOT_TOKEN }) });
    const api = fakeSlackApi({ authTest: async (token) => ({ ok: token === TEST_BOT_TOKEN, team_id: "T0TEAM", user_id: "U0BOT", bot_id: "B0BOT", scopes: ["users:read"] }) });
    expect(await readSlackTeamIdFromSecret({ secrets, api, secretId: SLACK_SECRET })).toEqual({ teamId: "T0TEAM", scopes: ["users:read"] });
    const unset = memoryInitSecrets({ [SLACK_SECRET]: JSON.stringify({ botToken: "unset", signingSecret: PLACEHOLDER }) });
    await expect(readSlackTeamIdFromSecret({ secrets: unset, api, secretId: SLACK_SECRET })).rejects.toThrow(`secret ${SLACK_SECRET} has no Slack bot token yet; finish the Slack app step of agentx init first`);
  });

  it("names the sign-in scopes the app is missing", () => {
    expect(missingScopes(["app_mentions:read", "channels:read", "groups:read", "users:read"], SIGN_IN_BOT_SCOPES)).toEqual(["im:write", "users:read.email"]);
    expect(missingScopes(undefined, SIGN_IN_BOT_SCOPES)).toEqual([]);
  });

  it("reads the granted scopes from auth.test's x-oauth-scopes header", async () => {
    const api = slackWebApi(async () => Response.json({ ok: true, team_id: "T0TEAM" }, { headers: { "x-oauth-scopes": "chat:write,users:read, im:write" } }));
    expect((await api.authTest(TEST_BOT_TOKEN)).scopes).toEqual(["chat:write", "users:read", "im:write"]);
  });
});
```

In `tests/contract/environment-adopt.test.ts`, add:

```ts
describe("agentx env adopt records the Slack team ID (FR-006, R21)", () => {
  const withSecret = { ...liveStacks, AgentXControlPlane: { ...liveStacks.AgentXControlPlane, outputs: { ...liveStacks.AgentXControlPlane.outputs, SlackSecretArn: "arn:aws:secretsmanager:us-east-1:944937319445:secret:SlackSecret-AbCdEf" } } };

  it("writes /agentx/production/slack/teamId from the bot token's auth.test", async () => {
    const store = new MemoryParameterStore();
    const home = await mkdtemp(join(tmpdir(), "agentx-adopt-"));
    const seen: string[] = [];
    await adoptEnvironment({ env: "production", region: "us-east-1", stacks: reader(withSecret), identity, store, home, now, slackTeamId: async (arn) => { seen.push(arn); return "T0TEAM1"; } });
    expect(seen).toEqual(["arn:aws:secretsmanager:us-east-1:944937319445:secret:SlackSecret-AbCdEf"]);
    expect(store.values.get("/agentx/production/slack/teamId")).toBe("T0TEAM1");
  });

  it("reports a failure in one line and still adopts", async () => {
    const store = new MemoryParameterStore();
    const home = await mkdtemp(join(tmpdir(), "agentx-adopt-"));
    const lines: string[] = [];
    const settings = await adoptEnvironment({ env: "production", region: "us-east-1", stacks: reader(withSecret), identity, store, home, now, write: (line) => lines.push(line), slackTeamId: async () => { throw Object.assign(new Error("denied xoxb-should-not-print"), { name: "AccessDeniedException" }); } });
    expect(settings.env).toBe("production");
    expect(lines).toEqual(["Could not record the Slack team ID (AccessDeniedException); agentx signin check reports it, and agentx signin enable slack records it"]);
    expect(store.values.has("/agentx/production/slack/teamId")).toBe(false);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/contract/init-slack-app.test.ts tests/contract/environment-adopt.test.ts`
Expected: FAIL: the manifest has no redirect URL, and the new exports and adopt inputs do not exist.

- [ ] **Step 3: Implement**

In `packages/cli/src/init/slack-app.ts`:

```ts
// channels:join, channels:read and groups:read serve 15d2's `channel add`; users:read.email and
// im:write serve developer sign-in (spec 025 FR-044). Adding scopes later forces a reinstall (R10).
export const SLACK_BOT_SCOPES: readonly string[] = ["app_mentions:read", "channels:join", "channels:read", "chat:write", "groups:read", "im:write", "users:read", "users:read.email"];
/** Sign in with Slack (OpenID Connect). */
export const SLACK_USER_SCOPES: readonly string[] = ["email", "openid", "profile"];
/** What developer sign-in needs of the bot token: users.info, users.lookupByEmail, conversations.members, and 25e's DMs. */
export const SIGN_IN_BOT_SCOPES: readonly string[] = ["channels:read", "groups:read", "im:write", "users:read", "users:read.email"];

export interface SlackManifest {
  display_information: { name: string; description: string };
  features: { bot_user: { display_name: string; always_online: boolean } };
  oauth_config: { redirect_urls: string[]; scopes: { bot: string[]; user: string[] } };
  settings: {
    event_subscriptions: { request_url: string; bot_events: string[] };
    interactivity: { is_enabled: boolean; request_url: string };
    org_deploy_enabled: boolean;
    socket_mode_enabled: boolean;
    token_rotation_enabled: boolean;
  };
}

export const slackSignInCallbackUrl = (apiEndpoint: string) => `${apiEndpoint.replace(/\/+$/, "")}/v1/auth/callback/slack`;

export function missingScopes(granted: readonly string[] | undefined, needed: readonly string[]): string[] {
  if (granted === undefined) return [];
  return needed.filter((scope) => !granted.includes(scope));
}

function parsedSecret(existing: string | undefined): Record<string, unknown> {
  try {
    const value = JSON.parse(existing ?? "{}") as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** R11: a new bot token and signing secret, keeping the sign-in keys the developer-signin step stored. */
export function slackSecretWithBot(existing: string | undefined, bot: { signingSecret: string; botToken: string }): string {
  const current = parsedSecret(existing);
  const keep = Object.fromEntries(["clientId", "clientSecret"].filter((key) => typeof current[key] === "string").map((key) => [key, current[key]]));
  return JSON.stringify({ ...keep, signingSecret: bot.signingSecret, botToken: bot.botToken });
}

export function slackSecretWithSignIn(existing: string | undefined, client: { clientId: string; clientSecret: string }): string {
  return JSON.stringify({ ...parsedSecret(existing), clientId: client.clientId, clientSecret: client.clientSecret });
}

export async function readSlackTeamIdFromSecret(input: { secrets: Pick<InitSecrets, "get">; api: SlackApi; secretId: string }): Promise<{ teamId: string; scopes?: string[] }> {
  const token = parsedSecret(await input.secrets.get(input.secretId)).botToken;
  if (typeof token !== "string" || !token.startsWith("xoxb-")) {
    throw agentXError("CONFIG_INVALID", `secret ${input.secretId} has no Slack bot token yet; finish the Slack app step of agentx init first`);
  }
  const auth = await input.api.authTest(token);
  if (!auth.ok || auth.team_id === undefined) throw agentXError("CONFIG_INVALID", `Slack refused the stored bot token (${auth.error ?? "no reason given"}); run the Slack app step of agentx init again`);
  return { teamId: auth.team_id, ...(auth.scopes === undefined ? {} : { scopes: auth.scopes }) };
}
```

- `slackAppManifest` takes `signInCallbackUrl` and sets
  `oauth_config: { redirect_urls: [input.signInCallbackUrl], scopes: { bot: [...SLACK_BOT_SCOPES], user: [...SLACK_USER_SCOPES] } }`.
- `SlackApi.authTest`'s result type gains `scopes?: string[]`. In `slackWebApi`, `authTest` reads
  the response header: change `call` to return `{ body, headers }` and build `authTest`'s result
  as `{ ...body, ...(header === null ? {} : { scopes: header.split(",").map((scope) => scope.trim()).filter(Boolean) }) }`
  where `header = headers.get("x-oauth-scopes")`.
- `controlPlaneSlackUrls` also returns `apiEndpoint` (the `ApiEndpoint` output), and
  `slackAppStep` passes `signInCallbackUrl: slackSignInCallbackUrl(urls.apiEndpoint)` into the
  manifest.
- `slackAppStep` stores the secret with
  `await context.secrets.put(slackSecretName(env), slackSecretWithBot(await context.secrets.get(slackSecretName(env)), { signingSecret, botToken }));`.

In `packages/cli/src/environments/adopt.ts`, add the two optional inputs, import
`writeSlackTeamId` from `../signin/settings.js`, and after the local cache is written (inside the
lock, before `return settings`):

```ts
    const slackSecretArn = control.outputs.SlackSecretArn;
    if (input.slackTeamId !== undefined && slackSecretArn !== undefined) {
      try {
        await writeSlackTeamId(input.store, input.env, await input.slackTeamId(slackSecretArn));
      } catch (error) {
        input.write?.(`Could not record the Slack team ID (${error instanceof Error ? error.name : "unknown error"}); agentx signin check reports it, and agentx signin enable slack records it`);
      }
    }
```

Pass the two inputs through `runEnvAdopt` in `environments/commands.ts`. In `main.ts`'s `env adopt`
action, add:

```ts
        slackTeamId: async (arn) => (await readSlackTeamIdFromSecret({
          secrets: secretsManagerInitSecrets(new SecretsManagerClient({ region: options.region })),
          api: slackWebApi(services.fetchImplementation),
          secretId: arn,
        })).teamId,
        write: (line) => { services.stderr.write(`${line}\n`); },
```

- [ ] **Step 4: Run the tests to verify they pass, and the init suites**

Run: `npx vitest run tests/contract/init-slack-app.test.ts tests/contract/environment-adopt.test.ts tests/contract/environment-cli.test.ts tests/contract/init-cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/init/slack-app.ts packages/cli/src/environments/adopt.ts packages/cli/src/environments/commands.ts packages/cli/src/main.ts tests/contract/init-slack-app.test.ts tests/contract/environment-adopt.test.ts
git commit -m "feat(cli): Slack app carries sign-in scopes; keep sign-in keys; record the team ID"
```

---

### Task 12: `agentx signin show|enable|disable|check`

**Files:**
- Create: `packages/cli/src/signin/collect.ts`
- Create: `packages/cli/src/signin/apply.ts`
- Create: `packages/cli/src/signin/check.ts`
- Create: `packages/cli/src/signin/commands.ts`
- Modify: `packages/cli/src/main.ts` (the `signin` command group; `CliDependencies.signin`)
- Modify: `tests/contract/cli-main.test.ts` (insert `signin` after `whoami`; `signin` subcommands)
- Test: `tests/contract/signin-commands.test.ts`, `tests/contract/signin-check.test.ts`

**Interfaces:**
- Consumes: Task 9 (`settings.ts`, `updateStackParameters`), Task 11 (Slack helpers),
  `withEnvironmentLock`, `readEnvironmentSettings`, `secretFromSource`, `Prompter`, `InitSecrets`.
- Produces:
  - `collect.ts`:
    ```ts
    export interface SigninFlags { methods?: "slack" | "oidc" | "both"; slackClientId?: string; oidcIssuer?: string; oidcClientId?: string; oidcRequiredClaim?: string; oidcRequiredValues?: string; oidcDisplayName?: string }
    export interface SigninSecretFlags { slackClientSecret?: SecretSource; oidcClientSecret?: SecretSource }
    export function checkSlackClientId(value: string): string;      // /^\d+\.\d+$/
    export function checkSlackClientSecret(value: string): string;  // 32 lowercase hex
    export async function collectSlackClient(input: { prompter: Prompter; processEnv: NodeJS.ProcessEnv; flags: SigninFlags; secretFlags: SigninSecretFlags }): Promise<{ clientId: string; clientSecret: string }>;
    export async function slackSignInPrerequisites(input: { env: string; secrets: InitSecrets; slackApi: SlackApi; expectedTeamId?: string }): Promise<{ teamId: string }>;
    export async function checkOidcDiscovery(fetchFn: typeof fetch, issuer: string): Promise<void>;
    export async function collectOidc(input: { env: string; prompter: Prompter; processEnv: NodeJS.ProcessEnv; fetch: typeof fetch; flags: SigninFlags; secretFlags: SigninSecretFlags }): Promise<{ oidc: NonNullable<DeveloperSignInSettings["oidc"]>; clientSecret: string }>;
    export async function storeOidcSecret(secrets: InitSecrets, env: string, clientSecret: string): Promise<void>;
    ```
  - `apply.ts`:
    ```ts
    export interface ApplySignInInput {
      env: string; store: ParameterStore; cloudFormation: { send(command: unknown): Promise<unknown> }; holder: string; settings: EnvironmentSettings;
      next: { slack: boolean; oidc?: NonNullable<DeveloperSignInSettings["oidc"]> }; slackTeamId?: string;
      confirm: (text: string) => Promise<boolean>; write: (line: string) => void; now: () => number; lockHeld?: boolean;
      sleep?: (ms: number) => Promise<void>; pollMs?: number;
    }
    /** "Slack sign-in: off" and "Slack sign-in: on" become "  Slack sign-in: off -> on"; an unchanged line is printed as it is. */
export function changeLine(before: string, after: string): string {
  if (before === after) return `  ${after}`;
  const [label, beforeState = ""] = before.split(": ");
  return `  ${label}: ${beforeState.split(" ")[0]} -> ${after.slice(after.indexOf(": ") + 2)}`;
}

export async function applySignInChange(input: ApplySignInInput): Promise<{ changed: boolean; settings: DeveloperSignInSettings }>;
    ```
  - `check.ts`:
    ```ts
    export interface SignInCheck { name: string; ok: boolean; detail: string }
    export async function checkDeveloperSignIn(input: { env: string; store: ParameterStore; secrets: Pick<InitSecrets, "get">; settings: EnvironmentSettings; fetch: typeof fetch; slackApi: SlackApi }): Promise<SignInCheck[]>;
    export function checkLines(checks: SignInCheck[]): string[];
    ```
    15e's `doctor` calls `checkDeveloperSignIn` unchanged (R5).
  - `commands.ts`:
    ```ts
    export interface SigninServices { store: ParameterStore; secrets: InitSecrets; cloudFormation: { send(command: unknown): Promise<unknown> }; identity: CallerIdentity; fetch: typeof fetch; slackApi: SlackApi; prompter: Prompter; processEnv: NodeJS.ProcessEnv; write: (line: string) => void; now: () => number; sleep?: (ms: number) => Promise<void>; pollMs?: number }
    export async function runSigninShow(services: SigninServices, env: string): Promise<{ lines: string[]; data: Record<string, unknown> }>;
    export async function runSigninEnable(services: SigninServices, env: string, method: "slack" | "oidc", flags: SigninFlags, secretFlags: SigninSecretFlags, yes: boolean): Promise<{ changed: boolean }>;
    export async function runSigninDisable(services: SigninServices, env: string, method: "slack" | "oidc", yes: boolean): Promise<{ changed: boolean }>;
    export async function runSigninCheck(services: SigninServices, env: string): Promise<SignInCheck[]>;
    ```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/contract/signin-commands.test.ts
import { describe, expect, it } from "vitest";
import { writeEnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import { runSigninDisable, runSigninEnable, runSigninShow, type SigninServices } from "../../packages/cli/src/signin/commands.js";
import { readSignInSettings, writeSignInSettings, writeSlackTeamId } from "../../packages/cli/src/signin/settings.js";
import { stagingSettings } from "../support/environment-fixtures.js";
import { SIGN_IN_PARAMETERS, fakeCloudFormation } from "../support/fake-cloudformation.js";
import { HOLDER, T0, fakeSlackApi, memoryInitSecrets, scriptedPrompter, TEST_BOT_TOKEN, TEST_SIGNING_SECRET } from "../support/init-fakes.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";

const SLACK_CLIENT_SECRET = "fedcba9876543210fedcba9876543210";
const OIDC_SECRET = "planted-company-client-secret";
const installed = { ...stagingSettings, access: { artifactBucket: "b", cloudFormationRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-cloudformation", operatorRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-operator", pullThroughPrefix: "agentx-staging" } };
const discovery = (issuer: string) => async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url === `${issuer}/.well-known/openid-configuration`) return Response.json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/keys` });
  throw new TypeError("fetch failed");
};

async function services(prompts: Array<string | boolean>, overrides: Partial<SigninServices> = {}) {
  const store = new MemoryParameterStore();
  await writeEnvironmentSettings(store, installed);
  const secrets = memoryInitSecrets({ "agentx/staging/slack": JSON.stringify({ signingSecret: TEST_SIGNING_SECRET, botToken: TEST_BOT_TOKEN }) });
  const cloudFormation = fakeCloudFormation({ parameters: SIGN_IN_PARAMETERS });
  const lines: string[] = [];
  const s: SigninServices = {
    store, secrets, cloudFormation, identity: { get: async () => ({ account: "123456789012", arn: HOLDER }) },
    fetch: discovery("https://acme.okta.com") as typeof fetch,
    slackApi: fakeSlackApi({ authTest: async () => ({ ok: true, team_id: "T0TEAM", user_id: "U0BOT", bot_id: "B0BOT", scopes: ["app_mentions:read", "channels:read", "groups:read", "im:write", "users:read", "users:read.email"] }) }),
    prompter: scriptedPrompter(prompts), processEnv: { OIDC_SECRET }, write: (line) => lines.push(line), now: () => T0, sleep: async () => undefined, pollMs: 1,
    ...overrides,
  };
  return { s, store, secrets, cloudFormation, lines };
}

describe("agentx signin enable slack (FR-045)", () => {
  it("stores the client credentials in the Slack secret, records the team ID, shows the change, updates the stack and writes the settings", async () => {
    const h = await services(["1111111111.2222222222222", SLACK_CLIENT_SECRET, true]);
    expect(await runSigninEnable(h.s, "staging", "slack", {}, {}, false)).toEqual({ changed: true });
    expect(JSON.parse(h.secrets.values.get("agentx/staging/slack")!)).toEqual({ signingSecret: TEST_SIGNING_SECRET, botToken: TEST_BOT_TOKEN, clientId: "1111111111.2222222222222", clientSecret: SLACK_CLIENT_SECRET });
    expect(h.store.values.get("/agentx/staging/slack/teamId")).toBe("T0TEAM");
    expect(h.cloudFormation.parameters).toMatchObject({ SlackTeamId: "T0TEAM", DeveloperSignInSlack: "enabled" });
    expect(await readSignInSettings(h.store, "staging")).toMatchObject({ slack: true, updatedBy: HOLDER });
    const printed = h.lines.join("\n");
    expect(printed).toContain("Slack sign-in: off -> on");
    expect(printed).toContain("https://abc.execute-api.us-east-1.amazonaws.com/v1/auth/callback/slack");
    for (const secret of [SLACK_CLIENT_SECRET, TEST_BOT_TOKEN, TEST_SIGNING_SECRET]) {
      expect(printed).not.toContain(secret);
      expect([...h.store.values.values()].join("\n")).not.toContain(secret);
    }
    expect(h.store.values.has("/agentx/staging/lock")).toBe(false);
  });

  it("refuses, storing nothing, when the Slack app lacks the sign-in bot scopes", async () => {
    const h = await services([], { slackApi: fakeSlackApi({ authTest: async () => ({ ok: true, team_id: "T0TEAM", user_id: "U0BOT", bot_id: "B0BOT", scopes: ["app_mentions:read", "users:read"] }) }) });
    await expect(runSigninEnable(h.s, "staging", "slack", {}, {}, false)).rejects.toThrow("the Slack app is missing the bot scopes channels:read, groups:read, im:write, users:read.email; add them on the app's OAuth & Permissions page, reinstall the app, then run this again");
    expect(h.cloudFormation.calls).toEqual([]);
    expect(JSON.parse(h.secrets.values.get("agentx/staging/slack")!)).not.toHaveProperty("clientId");
  });

  it("changes nothing when the change is declined", async () => {
    const h = await services(["1111111111.2222222222222", SLACK_CLIENT_SECRET, false]);
    await expect(runSigninEnable(h.s, "staging", "slack", {}, {}, false)).rejects.toThrow(/not applied; nothing changed/);
    expect(h.cloudFormation.parameters.DeveloperSignInSlack).toBe("disabled");
    expect(await readSignInSettings(h.store, "staging")).toBeUndefined();
  });

  it("never reads a secret from a flag value", async () => {
    const h = await services([]);
    await expect(runSigninEnable(h.s, "staging", "slack", { slackClientId: "1111111111.2222222222222" }, { slackClientSecret: { envName: "MISSING" } }, true)).rejects.toThrow(/environment variable MISSING/);
  });

  it("refuses an environment that uses the legacy stack names", async () => {
    const h = await services([]);
    await writeEnvironmentSettings(h.store, { ...installed, env: "staging", naming: "legacy" });
    await expect(runSigninEnable(h.s, "staging", "slack", {}, {}, true)).rejects.toThrow(/installed with agentx init/);
  });
});

describe("agentx signin enable oidc (FR-004, FR-010, FR-045)", () => {
  it("checks the issuer's discovery document, stores the client secret, and keeps Slack as it was", async () => {
    const h = await services([true]);
    await writeSignInSettings(h.store, { schemaVersion: 1, env: "staging", slack: true, updatedAt: "2026-09-27T00:00:00.000Z", updatedBy: HOLDER });
    await writeSlackTeamId(h.store, "staging", "T0TEAM");
    await runSigninEnable(h.s, "staging", "oidc", { oidcIssuer: "https://acme.okta.com", oidcClientId: "0oa1", oidcRequiredClaim: "groups", oidcRequiredValues: "engineering,platform", oidcDisplayName: "Okta" }, { oidcClientSecret: { envName: "OIDC_SECRET" } }, false);
    expect(JSON.parse(h.secrets.values.get("agentx/staging/developer-oidc")!)).toEqual({ clientSecret: OIDC_SECRET });
    expect(await readSignInSettings(h.store, "staging")).toMatchObject({ slack: true, oidc: { issuer: "https://acme.okta.com", clientId: "0oa1", requiredClaim: "groups", requiredValues: ["engineering", "platform"], displayName: "Okta", clientSecretName: "agentx/staging/developer-oidc" } });
    expect(h.cloudFormation.parameters).toMatchObject({ DeveloperOidcIssuer: "https://acme.okta.com", DeveloperOidcRequiredValues: "[\"engineering\",\"platform\"]", DeveloperSignInSlack: "enabled", SlackTeamId: "T0TEAM" });
    expect(h.lines.join("\n")).toContain("Register this redirect URI with your identity provider: https://abc.execute-api.us-east-1.amazonaws.com/v1/auth/callback/oidc");
    expect(h.lines.join("\n")).not.toContain(OIDC_SECRET);
  });

  it("refuses an issuer whose discovery document cannot be read, before storing anything", async () => {
    const h = await services([]);
    await expect(runSigninEnable(h.s, "staging", "oidc", { oidcIssuer: "https://down.example.test", oidcClientId: "c" }, { oidcClientSecret: { envName: "OIDC_SECRET" } }, true))
      .rejects.toThrow("could not read https://down.example.test/.well-known/openid-configuration; check the issuer URL and that this computer can reach it");
    expect(h.secrets.values.has("agentx/staging/developer-oidc")).toBe(false);
  });
});

describe("agentx signin disable and show", () => {
  it("disables a method, which revokes its sessions through the control plane (FR-045, R13)", async () => {
    const h = await services([true]);
    await writeSignInSettings(h.store, { schemaVersion: 1, env: "staging", slack: true, oidc: { issuer: "https://acme.okta.com", clientId: "0oa1", displayName: "Okta", clientSecretName: "agentx/staging/developer-oidc" }, updatedAt: "2026-09-27T00:00:00.000Z", updatedBy: HOLDER });
    await writeSlackTeamId(h.store, "staging", "T0TEAM");
    expect(await runSigninDisable(h.s, "staging", "slack", false)).toEqual({ changed: true });
    expect(h.cloudFormation.parameters.DeveloperSignInSlack).toBe("disabled");
    expect(h.lines.join("\n")).toContain("Everyone signed in with Slack is signed out as soon as the update finishes");
  });

  it("refuses to disable the last method (FR-010)", async () => {
    const h = await services([]);
    await writeSignInSettings(h.store, { schemaVersion: 1, env: "staging", slack: true, updatedAt: "2026-09-27T00:00:00.000Z", updatedBy: HOLDER });
    await expect(runSigninDisable(h.s, "staging", "slack", true)).rejects.toThrow("Slack sign-in is the only method enabled; enable company sign-in first (agentx signin enable oidc), because at least one method must stay on");
  });

  it("shows the settings and what the control plane offers, never a secret", async () => {
    const h = await services([], {
      fetch: (async () => Response.json({ env: "staging", apiVersion: "1.0", issuer: "i", authorizationEndpoint: "https://a/x", tokenEndpoint: "https://a/t", revocationEndpoint: "https://a/r", clientId: "agentx-cli", methods: { slack: true, oidc: null } })) as typeof fetch,
    });
    await writeSignInSettings(h.store, { schemaVersion: 1, env: "staging", slack: true, updatedAt: "2026-09-27T00:00:00.000Z", updatedBy: HOLDER });
    await writeSlackTeamId(h.store, "staging", "T0TEAM");
    const shown = await runSigninShow(h.s, "staging");
    expect(shown.lines).toEqual([
      "Slack sign-in: on",
      "Company sign-in: off",
      "Slack team: T0TEAM",
      "The control plane offers: Slack",
      "Developers sign in with: npx @charterarc/agentx login https://abc.execute-api.us-east-1.amazonaws.com",
    ]);
  });
});
```

```ts
// tests/contract/signin-check.test.ts
import { describe, expect, it } from "vitest";
import { checkDeveloperSignIn, checkLines } from "../../packages/cli/src/signin/check.js";
import { writeSignInSettings, writeSlackTeamId } from "../../packages/cli/src/signin/settings.js";
import { stagingSettings } from "../support/environment-fixtures.js";
import { HOLDER, fakeSlackApi, memoryInitSecrets, TEST_BOT_TOKEN, TEST_SIGNING_SECRET } from "../support/init-fakes.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";

const API = "https://abc.execute-api.us-east-1.amazonaws.com";
const CLIENT_SECRET = "fedcba9876543210fedcba9876543210";
const scopes = ["channels:read", "groups:read", "im:write", "users:read", "users:read.email"];

function fetchFor(options: { methods?: { slack: boolean; oidc: null | { displayName: string } }; slackAuthorize?: Response; discovery?: boolean }) {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.href === `${API}/v1/auth/.well-known/agentx-configuration`) {
      return Response.json({ env: "staging", apiVersion: "1.0", issuer: `${API}/v1/auth`, authorizationEndpoint: `${API}/v1/auth/authorize`, tokenEndpoint: `${API}/v1/auth/token`, revocationEndpoint: `${API}/v1/auth/revoke`, clientId: "agentx-cli", methods: options.methods ?? { slack: true, oidc: null } });
    }
    if (url.origin + url.pathname === "https://slack.com/openid/connect/authorize") return options.slackAuthorize ?? new Response("", { status: 302, headers: { location: "https://acme.slack.com/signin" } });
    if (url.href === "https://acme.okta.com/.well-known/openid-configuration" && options.discovery !== false) {
      return Response.json({ issuer: "https://acme.okta.com", authorization_endpoint: "https://acme.okta.com/authorize", token_endpoint: "https://acme.okta.com/token", jwks_uri: "https://acme.okta.com/keys" });
    }
    throw new TypeError("fetch failed");
  }) as typeof fetch;
}

async function setup(slackSecret: Record<string, string>, extra: { oidc?: boolean; teamId?: string } = {}) {
  const store = new MemoryParameterStore();
  await writeSignInSettings(store, {
    schemaVersion: 1, env: "staging", slack: true, updatedAt: "2026-09-27T00:00:00.000Z", updatedBy: HOLDER,
    ...(extra.oidc ? { oidc: { issuer: "https://acme.okta.com", clientId: "0oa1", displayName: "Okta", clientSecretName: "agentx/staging/developer-oidc" } } : {}),
  });
  if (extra.teamId !== undefined) await writeSlackTeamId(store, "staging", extra.teamId);
  const secrets = memoryInitSecrets({ "agentx/staging/slack": JSON.stringify(slackSecret), ...(extra.oidc ? { "agentx/staging/developer-oidc": JSON.stringify({ clientSecret: "x" }) } : {}) });
  return { store, secrets };
}

const api = (granted = scopes) => fakeSlackApi({ authTest: async () => ({ ok: true, team_id: "T0TEAM", user_id: "U0BOT", bot_id: "B0BOT", scopes: granted }) });

describe("agentx signin check (FR-046, R5)", () => {
  it("passes every check for a complete Slack setup", async () => {
    const { store, secrets } = await setup({ signingSecret: TEST_SIGNING_SECRET, botToken: TEST_BOT_TOKEN, clientId: "1111.2222", clientSecret: CLIENT_SECRET }, { teamId: "T0TEAM" });
    const checks = await checkDeveloperSignIn({ env: "staging", store, secrets, settings: stagingSettings, fetch: fetchFor({}), slackApi: api() });
    expect(checks.map((check) => [check.name, check.ok])).toEqual([
      ["settings", true], ["control plane", true], ["Slack app credentials", true], ["Slack team ID", true], ["Slack bot scopes", true], ["Slack redirect URL", true],
    ]);
    const text = checkLines(checks).join("\n");
    for (const secret of [CLIENT_SECRET, TEST_BOT_TOKEN, TEST_SIGNING_SECRET]) expect(text).not.toContain(secret);
  });

  it("names each missing piece with what to do", async () => {
    // A client ID without its secret: the credentials check fails, and the redirect check still runs.
    const { store, secrets } = await setup({ signingSecret: TEST_SIGNING_SECRET, botToken: TEST_BOT_TOKEN, clientId: "1111.2222" });
    const checks = await checkDeveloperSignIn({
      env: "staging", store, secrets, settings: stagingSettings, slackApi: api(["users:read"]),
      fetch: fetchFor({ methods: { slack: false, oidc: null }, slackAuthorize: new Response("<p>redirect_uri did not match any configured URIs</p>", { status: 200 }) }),
    });
    expect(Object.fromEntries(checks.map((check) => [check.name, check.detail]))).toEqual({
      settings: "Slack sign-in on, company sign-in off",
      "control plane": "the control plane does not offer Slack sign-in, but the settings say it is on; run agentx signin enable slack again",
      "Slack app credentials": "the Slack app's client ID and client secret are not stored in agentx/staging/slack; run agentx signin enable slack",
      "Slack team ID": "no team ID is recorded at /agentx/staging/slack/teamId; run agentx signin enable slack",
      "Slack bot scopes": "the app is missing channels:read, groups:read, im:write, users:read.email; add them on OAuth & Permissions and reinstall the app",
      "Slack redirect URL": "Slack does not list https://abc.execute-api.us-east-1.amazonaws.com/v1/auth/callback/slack as a redirect URL; add it on OAuth & Permissions",
    });
  });

  it("checks the company issuer and secret when company sign-in is on", async () => {
    const { store, secrets } = await setup({ signingSecret: TEST_SIGNING_SECRET, botToken: TEST_BOT_TOKEN, clientId: "1111.2222", clientSecret: CLIENT_SECRET }, { teamId: "T0TEAM", oidc: true });
    const down = await checkDeveloperSignIn({ env: "staging", store, secrets, settings: stagingSettings, slackApi: api(), fetch: fetchFor({ methods: { slack: true, oidc: { displayName: "Okta" } }, discovery: false }) });
    expect(down.find((check) => check.name === "company sign-in discovery")).toMatchObject({ ok: false, detail: expect.stringContaining("could not read https://acme.okta.com/.well-known/openid-configuration") });
    expect(down.find((check) => check.name === "company sign-in secret")).toMatchObject({ ok: true });
  });

  it("says sign-in is not set up when there are no settings", async () => {
    const checks = await checkDeveloperSignIn({ env: "staging", store: new MemoryParameterStore(), secrets: memoryInitSecrets(), settings: stagingSettings, slackApi: api(), fetch: fetchFor({}) });
    expect(checks).toEqual([{ name: "settings", ok: false, detail: "developer sign-in is not set up; run agentx signin enable slack (or oidc)" }]);
  });
});
```

In `tests/contract/cli-main.test.ts`: root commands become
`["login", "logout", "whoami", "signin", "admin", "env", "deploy", "init"]`, and add
`expect(subcommands(program, "signin")).toEqual(["show", "enable", "disable", "check"]);` (use the
file's `subcommands` helper; if it takes a parent command, pass the root program).

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/contract/signin-commands.test.ts tests/contract/signin-check.test.ts tests/contract/cli-main.test.ts`
Expected: FAIL, the modules and the command do not exist.

- [ ] **Step 3: Implement `collect.ts`**

```ts
// packages/cli/src/signin/collect.ts
// The questions for developer sign-in (spec 025 FR-044, FR-045), shared by agentx init and
// agentx signin enable. Secrets come only from a hidden prompt, a file or an environment variable.
import { agentXError } from "@agentx/contracts";
import type { InitSecrets } from "../init/context.js";
import { secretFromSource, type Prompter, type SecretSource } from "../init/prompts.js";
import { SIGN_IN_BOT_SCOPES, missingScopes, readSlackTeamIdFromSecret, slackSecretName, type SlackApi } from "../init/slack-app.js";
import { oidcSecretName, type DeveloperSignInSettings } from "./settings.js";

export interface SigninFlags { methods?: "slack" | "oidc" | "both"; slackClientId?: string; oidcIssuer?: string; oidcClientId?: string; oidcRequiredClaim?: string; oidcRequiredValues?: string; oidcDisplayName?: string }
export interface SigninSecretFlags { slackClientSecret?: SecretSource; oidcClientSecret?: SecretSource }

export function checkSlackClientId(value: string): string {
  if (!/^\d+\.\d+$/.test(value.trim())) throw agentXError("CONFIG_INVALID", "a Slack client ID is two numbers joined by a dot (Basic Information, App Credentials, Client ID)");
  return value.trim();
}

export function checkSlackClientSecret(value: string): string {
  if (!/^[a-f0-9]{32}$/.test(value)) throw agentXError("CONFIG_INVALID", "a Slack client secret is 32 lowercase hexadecimal characters (Basic Information, App Credentials, Client Secret); it is not the Signing Secret");
  return value;
}

export async function slackSignInPrerequisites(input: { env: string; secrets: InitSecrets; slackApi: SlackApi; expectedTeamId?: string }): Promise<{ teamId: string }> {
  const { teamId, scopes } = await readSlackTeamIdFromSecret({ secrets: input.secrets, api: input.slackApi, secretId: slackSecretName(input.env) });
  if (input.expectedTeamId !== undefined && input.expectedTeamId !== teamId) {
    throw agentXError("CONFIG_INVALID", `the stored bot token belongs to Slack workspace ${teamId}, but this install uses ${input.expectedTeamId}; nothing was saved`);
  }
  const missing = missingScopes(scopes, SIGN_IN_BOT_SCOPES);
  if (missing.length > 0) {
    throw agentXError("CONFIG_INVALID", `the Slack app is missing the bot scopes ${missing.join(", ")}; add them on the app's OAuth & Permissions page, reinstall the app, then run this again`);
  }
  return { teamId };
}

export async function collectSlackClient(input: { prompter: Prompter; processEnv: NodeJS.ProcessEnv; flags: SigninFlags; secretFlags: SigninSecretFlags }): Promise<{ clientId: string; clientSecret: string }> {
  const clientId = checkSlackClientId(input.flags.slackClientId ?? await input.prompter.ask("Slack app Client ID (Basic Information, App Credentials)", {
    flag: "--slack-client-id",
    validate: (value) => (/^\d+\.\d+$/.test(value.trim()) ? undefined : "two numbers joined by a dot"),
  }));
  const clientSecret = checkSlackClientSecret(await secretFromSource({ what: "Slack client secret", flag: "--slack-client-secret", source: input.secretFlags.slackClientSecret ?? {}, processEnv: input.processEnv, prompter: input.prompter }));
  return { clientId, clientSecret };
}

export async function checkOidcDiscovery(fetchFn: typeof fetch, issuer: string): Promise<void> {
  const url = `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  let doc: Record<string, unknown>;
  try {
    const response = await fetchFn(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(String(response.status));
    doc = await response.json() as Record<string, unknown>;
  } catch {
    throw agentXError("CONFIG_INVALID", `could not read ${url}; check the issuer URL and that this computer can reach it`);
  }
  if (typeof doc.issuer !== "string" || doc.issuer.replace(/\/+$/, "") !== issuer.replace(/\/+$/, "")) {
    throw agentXError("CONFIG_INVALID", `${url} names issuer ${String(doc.issuer)}, not ${issuer}; use the issuer exactly as your identity provider writes it`);
  }
  for (const key of ["authorization_endpoint", "token_endpoint", "jwks_uri"]) {
    if (typeof doc[key] !== "string" || !(doc[key] as string).startsWith("https://")) throw agentXError("CONFIG_INVALID", `${url} has no HTTPS ${key}`);
  }
}

export async function collectOidc(input: { env: string; prompter: Prompter; processEnv: NodeJS.ProcessEnv; fetch: typeof fetch; flags: SigninFlags; secretFlags: SigninSecretFlags }): Promise<{ oidc: NonNullable<DeveloperSignInSettings["oidc"]>; clientSecret: string }> {
  const { prompter, flags } = input;
  const issuer = (flags.oidcIssuer ?? await prompter.ask("Company sign-in issuer URL (for example https://acme.okta.com)", {
    flag: "--signin-oidc-issuer", validate: (value) => (value.startsWith("https://") ? undefined : "must start with https://"),
  })).replace(/\/+$/, "");
  if (!issuer.startsWith("https://")) throw agentXError("CONFIG_INVALID", "the company issuer URL must start with https://");
  await checkOidcDiscovery(input.fetch, issuer);
  const clientId = flags.oidcClientId ?? await prompter.ask("Client ID of the company sign-in app", { flag: "--signin-oidc-client-id" });
  const clientSecret = await secretFromSource({ what: "company sign-in client secret", flag: "--signin-oidc-client-secret", source: input.secretFlags.oidcClientSecret ?? {}, processEnv: input.processEnv, prompter });
  const claim = (flags.oidcRequiredClaim ?? await prompter.ask("Claim a person must carry to use AgentX, for example groups (leave empty for none)", { flag: "--signin-oidc-required-claim", defaultValue: "" })).trim();
  const values = claim === "" ? [] : (flags.oidcRequiredValues ?? await prompter.ask(`Values of ${claim} that may use AgentX, comma-separated`, { flag: "--signin-oidc-required-values" }))
    .split(",").map((value) => value.trim()).filter(Boolean);
  if (claim !== "" && values.length === 0) throw agentXError("CONFIG_INVALID", `name at least one value of ${claim} with --signin-oidc-required-values`);
  const displayName = (flags.oidcDisplayName ?? await prompter.ask("Name on the sign-in button, for example Okta", { flag: "--signin-oidc-display-name", defaultValue: "Company sign-in" })).trim().slice(0, 40);
  return {
    oidc: { issuer, clientId, ...(claim === "" ? {} : { requiredClaim: claim, requiredValues: values }), displayName, clientSecretName: oidcSecretName(input.env) },
    clientSecret,
  };
}

export async function storeOidcSecret(secrets: InitSecrets, env: string, clientSecret: string): Promise<void> {
  const name = oidcSecretName(env);
  const value = JSON.stringify({ clientSecret });
  if ((await secrets.arn(name)) === undefined) await secrets.create(name, value);
  else await secrets.put(name, value);
}
```

- [ ] **Step 4: Implement `apply.ts`**

```ts
// packages/cli/src/signin/apply.ts
// Show the sign-in change, confirm it, update the control plane's parameters, then record the
// settings (spec 025 FR-045, R6, R7). Runs under the environment lock.
import { DeveloperSignInSettingsSchema, describeSignIn, readSignInSettings, readSlackTeamId, signInStackParameters, writeSignInSettings, writeSlackTeamId, type DeveloperSignInSettings } from "./settings.js";
import { agentXError } from "@agentx/contracts";
import { updateStackParameters } from "../deploy/parameter-update.js";
import { withEnvironmentLock } from "../environments/lock.js";
import type { ParameterStore } from "../environments/parameter-store.js";
import type { EnvironmentSettings } from "../environments/settings.js";

export interface ApplySignInInput {
  env: string; store: ParameterStore; cloudFormation: { send(command: unknown): Promise<unknown> }; holder: string; settings: EnvironmentSettings;
  next: { slack: boolean; oidc?: NonNullable<DeveloperSignInSettings["oidc"]> }; slackTeamId?: string;
  confirm: (text: string) => Promise<boolean>; write: (line: string) => void; now: () => number; lockHeld?: boolean;
  sleep?: (ms: number) => Promise<void>; pollMs?: number;
}

export async function applySignInChange(input: ApplySignInInput): Promise<{ changed: boolean; settings: DeveloperSignInSettings }> {
  const roleArn = input.settings.access?.cloudFormationRoleArn;
  if (input.settings.naming !== "environment" || roleArn === undefined) {
    throw agentXError("CONFIG_INVALID", `developer sign-in needs an environment installed with agentx init; ${input.env} uses the legacy stack names`);
  }
  const work = async () => {
    const current = await readSignInSettings(input.store, input.env);
    const parsed = DeveloperSignInSettingsSchema.safeParse({
      schemaVersion: 1, env: input.env, slack: input.next.slack, ...(input.next.oidc === undefined ? {} : { oidc: input.next.oidc }),
      updatedAt: new Date(input.now()).toISOString(), updatedBy: input.holder,
    });
    if (!parsed.success) throw agentXError("CONFIG_INVALID", parsed.error.issues[0]?.message ?? "developer sign-in settings are invalid");
    const next = parsed.data;
    const teamId = input.slackTeamId ?? await readSlackTeamId(input.store, input.env);
    if (next.slack && teamId === undefined) throw agentXError("CONFIG_INVALID", "Slack sign-in needs the Slack team ID; run agentx signin enable slack, which records it");
    const before = describeSignIn(current);
    const after = describeSignIn(next);
    const { changed } = await updateStackParameters({
      cloudFormation: input.cloudFormation,
      stackName: input.settings.stacks["control-plane"],
      roleArn,
      changes: signInStackParameters({ settings: next, ...(teamId === undefined ? {} : { slackTeamId: teamId }) }),
      write: input.write,
      ...(input.sleep === undefined ? {} : { sleep: input.sleep }),
      ...(input.pollMs === undefined ? {} : { pollMs: input.pollMs }),
      confirm: async ({ stackName, changes }) => input.confirm([
        `Developer sign-in for ${input.env}:`,
        ...before.map((line, index) => changeLine(line, after[index]!)),
        `${stackName} will change: ${changes.map((change) => `${change.action} ${change.logicalId} (${change.type})`).join(", ") || "parameters only"}`,
        "Apply this change?",
      ].join("\n")),
    });
    if (current?.slack === true && !next.slack) input.write("Everyone signed in with Slack is signed out as soon as the update finishes: the control plane refuses their tokens and their refreshes.");
    if (current?.oidc !== undefined && next.oidc === undefined) input.write("Everyone signed in with company sign-in is signed out as soon as the update finishes: the control plane refuses their tokens and their refreshes.");
    await writeSignInSettings(input.store, next);
    if (input.slackTeamId !== undefined) await writeSlackTeamId(input.store, input.env, input.slackTeamId);
    return { changed, settings: next };
  };
  return input.lockHeld === true ? work() : withEnvironmentLock({ store: input.store, env: input.env, holder: input.holder, command: "signin", now: input.now }, work);
}
```

A changed line reads exactly `Slack sign-in: off -> on` (or `Company sign-in: off -> on (Okta, ...)`);
`signin-commands.test.ts` pins it.

- [ ] **Step 5: Implement `check.ts`**

```ts
// packages/cli/src/signin/check.ts
// FR-046's checks. 15e's `agentx doctor` calls checkDeveloperSignIn (R5). Never prints a secret.
import { AgentXConfigurationSchema } from "@agentx/contracts";
import type { ParameterStore } from "../environments/parameter-store.js";
import type { EnvironmentSettings } from "../environments/settings.js";
import type { InitSecrets } from "../init/context.js";
import { SIGN_IN_BOT_SCOPES, missingScopes, readSlackTeamIdFromSecret, slackSecretName, slackSignInCallbackUrl, type SlackApi } from "../init/slack-app.js";
import { checkOidcDiscovery } from "./collect.js";
import { oidcSecretName, readSignInSettings, readSlackTeamId } from "./settings.js";

export interface SignInCheck { name: string; ok: boolean; detail: string }

const parse = (text: string | undefined): Record<string, unknown> => { try { return JSON.parse(text ?? "{}") as Record<string, unknown>; } catch { return {}; } };

/** Slack answers a test authorize request for a registered redirect URL by sending the browser on to sign in; for an unregistered one it shows an error page naming redirect_uri. Confirmed in the live check (Task 15). */
async function slackRedirectRegistered(fetchFn: typeof fetch, clientId: string, redirectUri: string): Promise<"yes" | "no" | "unknown"> {
  const url = new URL("https://slack.com/openid/connect/authorize");
  for (const [key, value] of Object.entries({ response_type: "code", scope: "openid", client_id: clientId, redirect_uri: redirectUri, state: "agentx-signin-check" })) url.searchParams.set(key, value);
  try {
    const response = await fetchFn(url, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
    const location = response.headers.get("location") ?? "";
    if (location.startsWith(redirectUri) && location.includes("error=")) return "no";
    if (response.status >= 300 && response.status < 400) return "yes";
    const body = await response.text();
    if (/redirect_uri/i.test(body) && /(did not match|bad_redirect_uri|invalid)/i.test(body)) return "no";
    return response.ok ? "yes" : "unknown";
  } catch {
    return "unknown";
  }
}

export async function checkDeveloperSignIn(input: { env: string; store: ParameterStore; secrets: Pick<InitSecrets, "get">; settings: EnvironmentSettings; fetch: typeof fetch; slackApi: SlackApi }): Promise<SignInCheck[]> {
  const stored = await readSignInSettings(input.store, input.env);
  if (stored === undefined) return [{ name: "settings", ok: false, detail: "developer sign-in is not set up; run agentx signin enable slack (or oidc)" }];
  const checks: SignInCheck[] = [{ name: "settings", ok: true, detail: `Slack sign-in ${stored.slack ? "on" : "off"}, company sign-in ${stored.oidc === undefined ? "off" : "on"}` }];

  try {
    const response = await input.fetch(`${input.settings.controlPlaneUrl}/v1/auth/.well-known/agentx-configuration`, { signal: AbortSignal.timeout(10_000) });
    const live = AgentXConfigurationSchema.parse(await response.json());
    const problems = [
      ...(live.methods.slack === stored.slack ? [] : [`the control plane ${live.methods.slack ? "offers" : "does not offer"} Slack sign-in, but the settings say it is ${stored.slack ? "on" : "off"}; run agentx signin ${stored.slack ? "enable" : "disable"} slack again`]),
      ...((live.methods.oidc !== null) === (stored.oidc !== undefined) ? [] : [`the control plane ${live.methods.oidc !== null ? "offers" : "does not offer"} company sign-in, but the settings say it is ${stored.oidc !== undefined ? "on" : "off"}; run agentx signin ${stored.oidc !== undefined ? "enable" : "disable"} oidc again`]),
    ];
    checks.push(problems.length === 0 ? { name: "control plane", ok: true, detail: "offers exactly the enabled methods" } : { name: "control plane", ok: false, detail: problems.join("; ") });
  } catch {
    checks.push({ name: "control plane", ok: false, detail: `could not read ${input.settings.controlPlaneUrl}/v1/auth/.well-known/agentx-configuration; the environment may run a release without developer sign-in` });
  }

  if (stored.slack) {
    const secret = parse(await input.secrets.get(slackSecretName(input.env)));
    const clientId = typeof secret.clientId === "string" && /^\d+\.\d+$/.test(secret.clientId) ? secret.clientId : undefined;
    const clientSecretOk = typeof secret.clientSecret === "string" && /^[a-f0-9]{32}$/.test(secret.clientSecret);
    checks.push(clientId !== undefined && clientSecretOk
      ? { name: "Slack app credentials", ok: true, detail: `client ID and client secret are stored in ${slackSecretName(input.env)}` }
      : { name: "Slack app credentials", ok: false, detail: `the Slack app's client ID and client secret are not stored in ${slackSecretName(input.env)}; run agentx signin enable slack` });
    const recorded = await readSlackTeamId(input.store, input.env);
    let live: { teamId: string; scopes?: string[] } | undefined;
    try { live = await readSlackTeamIdFromSecret({ secrets: input.secrets, api: input.slackApi, secretId: slackSecretName(input.env) }); } catch { live = undefined; }
    checks.push(recorded === undefined
      ? { name: "Slack team ID", ok: false, detail: `no team ID is recorded at /agentx/${input.env}/slack/teamId; run agentx signin enable slack` }
      : live !== undefined && live.teamId !== recorded
        ? { name: "Slack team ID", ok: false, detail: `the recorded team ${recorded} is not the bot token's team ${live.teamId}; run agentx signin enable slack` }
        : { name: "Slack team ID", ok: true, detail: `team ${recorded}` });
    const missing = live === undefined ? undefined : live.scopes === undefined ? undefined : missingScopes(live.scopes, SIGN_IN_BOT_SCOPES);
    checks.push(missing === undefined
      ? { name: "Slack bot scopes", ok: false, detail: "Slack did not report the app's scopes; check that the bot token in the Slack secret works" }
      : missing.length === 0 ? { name: "Slack bot scopes", ok: true, detail: "the app has every scope sign-in needs" }
        : { name: "Slack bot scopes", ok: false, detail: `the app is missing ${missing.join(", ")}; add them on OAuth & Permissions and reinstall the app` });
    const callback = slackSignInCallbackUrl(input.settings.controlPlaneUrl);
    const registered = clientId === undefined ? "unknown" : await slackRedirectRegistered(input.fetch, clientId, callback);
    checks.push(registered === "yes" ? { name: "Slack redirect URL", ok: true, detail: `Slack accepted a test sign-in request for ${callback}` }
      : registered === "no" ? { name: "Slack redirect URL", ok: false, detail: `Slack does not list ${callback} as a redirect URL; add it on OAuth & Permissions` }
        : { name: "Slack redirect URL", ok: false, detail: `could not confirm with Slack that ${callback} is a redirect URL; check OAuth & Permissions` });
  }

  if (stored.oidc !== undefined) {
    try {
      await checkOidcDiscovery(input.fetch, stored.oidc.issuer);
      checks.push({ name: "company sign-in discovery", ok: true, detail: `${stored.oidc.issuer} publishes its discovery document` });
    } catch (error) {
      checks.push({ name: "company sign-in discovery", ok: false, detail: error instanceof Error ? error.message.replace(/^[A-Z_]+: /, "") : "unreachable" });
    }
    const secret = parse(await input.secrets.get(oidcSecretName(input.env)));
    checks.push(typeof secret.clientSecret === "string" && secret.clientSecret !== ""
      ? { name: "company sign-in secret", ok: true, detail: `the client secret is stored in ${oidcSecretName(input.env)}` }
      : { name: "company sign-in secret", ok: false, detail: `no client secret is stored in ${oidcSecretName(input.env)}; run agentx signin enable oidc` });
  }
  return checks;
}

export function checkLines(checks: SignInCheck[]): string[] {
  return checks.map((check) => `${check.ok ? "ok  " : "FAIL"}  ${check.name}: ${check.detail}`);
}
```

- [ ] **Step 6: Implement `commands.ts` and the CLI group**

```ts
// packages/cli/src/signin/commands.ts
// agentx signin show|enable|disable|check (spec 025 FR-045, FR-046), under the operator role.
import { agentXError } from "@agentx/contracts";
import type { CallerIdentity } from "../environments/adopt.js";
import type { ParameterStore } from "../environments/parameter-store.js";
import { readEnvironmentSettings, type EnvironmentSettings } from "../environments/settings.js";
import type { InitSecrets } from "../init/context.js";
import type { Prompter } from "../init/prompts.js";
import { slackSecretName, slackSecretWithSignIn, slackSignInCallbackUrl, type SlackApi } from "../init/slack-app.js";
import { applySignInChange } from "./apply.js";
import { checkDeveloperSignIn, type SignInCheck } from "./check.js";
import { collectOidc, collectSlackClient, slackSignInPrerequisites, storeOidcSecret, type SigninFlags, type SigninSecretFlags } from "./collect.js";
import { describeSignIn, readSignInSettings, readSlackTeamId } from "./settings.js";

export interface SigninServices {
  store: ParameterStore; secrets: InitSecrets; cloudFormation: { send(command: unknown): Promise<unknown> }; identity: CallerIdentity;
  fetch: typeof fetch; slackApi: SlackApi; prompter: Prompter; processEnv: NodeJS.ProcessEnv; write: (line: string) => void; now: () => number;
  sleep?: (ms: number) => Promise<void>; pollMs?: number;
}

async function installed(services: SigninServices, env: string): Promise<EnvironmentSettings> {
  const settings = await readEnvironmentSettings(services.store, env);
  if (settings === undefined) throw agentXError("CONFIG_INVALID", `environment ${env} is not installed in this account and region; check --env and --region`);
  if (settings.naming !== "environment") throw agentXError("CONFIG_INVALID", `developer sign-in needs an environment installed with agentx init; ${env} uses the legacy stack names`);
  return settings;
}

const applyOptions = (services: SigninServices, yes: boolean) => ({
  confirm: async (text: string) => { services.write(text); return yes || services.prompter.confirm("Apply this change?", { defaultValue: false }); },
  write: services.write, now: services.now,
  ...(services.sleep === undefined ? {} : { sleep: services.sleep }),
  ...(services.pollMs === undefined ? {} : { pollMs: services.pollMs }),
});

export async function runSigninShow(services: SigninServices, env: string): Promise<{ lines: string[]; data: Record<string, unknown> }> {
  const settings = await installed(services, env);
  const stored = await readSignInSettings(services.store, env);
  const teamId = await readSlackTeamId(services.store, env);
  let offered = "unknown (the control plane could not be reached)";
  try {
    const live = await (await services.fetch(`${settings.controlPlaneUrl}/v1/auth/.well-known/agentx-configuration`)).json() as { methods?: { slack?: boolean; oidc?: { displayName?: string } | null } };
    const methods = [live.methods?.slack === true ? "Slack" : undefined, live.methods?.oidc ? live.methods.oidc.displayName : undefined].filter(Boolean);
    offered = methods.length === 0 ? "nothing" : methods.join(" and ");
  } catch { /* shown as unknown */ }
  const lines = [...describeSignIn(stored), `Slack team: ${teamId ?? "not recorded"}`, `The control plane offers: ${offered}`, `Developers sign in with: npx @charterarc/agentx login ${settings.controlPlaneUrl}`];
  return { lines, data: { settings: stored ?? null, slackTeamId: teamId ?? null, offered } };
}

export async function runSigninEnable(services: SigninServices, env: string, method: "slack" | "oidc", flags: SigninFlags, secretFlags: SigninSecretFlags, yes: boolean): Promise<{ changed: boolean }> {
  const settings = await installed(services, env);
  const holder = (await services.identity.get()).arn;
  const current = await readSignInSettings(services.store, env);
  if (method === "slack") {
    const { teamId } = await slackSignInPrerequisites({ env, secrets: services.secrets, slackApi: services.slackApi });
    services.write(`Check that the Slack app's OAuth & Permissions page lists the redirect URL ${slackSignInCallbackUrl(settings.controlPlaneUrl)} and the user scopes openid, email and profile.`);
    const client = await collectSlackClient({ prompter: services.prompter, processEnv: services.processEnv, flags, secretFlags });
    await services.secrets.put(slackSecretName(env), slackSecretWithSignIn(await services.secrets.get(slackSecretName(env)), client));
    const result = await applySignInChange({ env, store: services.store, cloudFormation: services.cloudFormation, holder, settings, next: { slack: true, ...(current?.oidc === undefined ? {} : { oidc: current.oidc }) }, slackTeamId: teamId, ...applyOptions(services, yes) });
    return { changed: result.changed };
  }
  const { oidc, clientSecret } = await collectOidc({ env, prompter: services.prompter, processEnv: services.processEnv, fetch: services.fetch, flags, secretFlags });
  await storeOidcSecret(services.secrets, env, clientSecret);
  services.write(`Register this redirect URI with your identity provider: ${settings.controlPlaneUrl.replace(/\/+$/, "")}/v1/auth/callback/oidc`);
  const result = await applySignInChange({ env, store: services.store, cloudFormation: services.cloudFormation, holder, settings, next: { slack: current?.slack ?? false, oidc }, ...applyOptions(services, yes) });
  return { changed: result.changed };
}

export async function runSigninDisable(services: SigninServices, env: string, method: "slack" | "oidc", yes: boolean): Promise<{ changed: boolean }> {
  const settings = await installed(services, env);
  const current = await readSignInSettings(services.store, env);
  if (current === undefined) throw agentXError("CONFIG_INVALID", "developer sign-in is not set up; nothing to disable");
  const next = { slack: method === "slack" ? false : current.slack, ...(method === "oidc" || current.oidc === undefined ? {} : { oidc: current.oidc }) };
  if (!next.slack && next.oidc === undefined) {
    const other = method === "slack" ? "company sign-in first (agentx signin enable oidc)" : "Slack sign-in first (agentx signin enable slack)";
    throw agentXError("CONFIG_INVALID", `${method === "slack" ? "Slack" : "Company"} sign-in is the only method enabled; enable ${other}, because at least one method must stay on`);
  }
  const holder = (await services.identity.get()).arn;
  const result = await applySignInChange({ env, store: services.store, cloudFormation: services.cloudFormation, holder, settings, next, ...applyOptions(services, yes) });
  return { changed: result.changed };
}

export async function runSigninCheck(services: SigninServices, env: string): Promise<SignInCheck[]> {
  const settings = await installed(services, env);
  return checkDeveloperSignIn({ env, store: services.store, secrets: services.secrets, settings, fetch: services.fetch, slackApi: services.slackApi });
}
```

In `packages/cli/src/main.ts`, add `signin?: Partial<SigninServices>` to `CliDependencies`, and after
the `whoami` command:

```ts
  const signin = program.command("signin").description("choose how developers sign in: Slack, your company's sign-in, or both (operator role)");
  const signinServices = (region: string | undefined, command: Command): SigninServices => {
    const config = region === undefined ? {} : { region };
    const yes = (command.opts() as { yes?: boolean }).yes === true;
    return {
      store: parameterStore(region),
      secrets: secretsManagerInitSecrets(new SecretsManagerClient(config)),
      cloudFormation: new CloudFormationClient(config),
      identity: stsCallerIdentity(new STSClient(config)),
      fetch: services.fetchImplementation,
      slackApi: slackWebApi(services.fetchImplementation),
      prompter: yes ? unattendedPrompter() : processPrompter(services.stderr),
      processEnv: process.env,
      write: (line) => { services.stderr.write(`${line}\n`); },
      now: Date.now,
      ...dependencies.signin,
    };
  };
  const regionOption = "--region <region>";
  const regionHelp = "AWS region of the environment; defaults to your AWS configuration";
  signin.command("show").option(regionOption, regionHelp).action(async (options: { region?: string }, command: Command) => {
    const globals = globalOptions(command);
    const result = await runSigninShow(signinServices(options.region, command), globals.env);
    services.stdout.write(globals.json ? formatSuccess(result.data, true) : `${result.lines.join("\n")}\n`);
  });
  signin.command("enable").argument("<method>", "slack or oidc").option(regionOption, regionHelp).option("--yes", "apply without asking", false)
    .option("--slack-client-id <id>").option("--slack-client-secret-file <path>").option("--slack-client-secret-env <NAME>")
    .option("--issuer <url>", "company sign-in issuer URL").option("--client-id <id>", "company sign-in client ID")
    .option("--client-secret-file <path>").option("--client-secret-env <NAME>")
    .option("--required-claim <claim>").option("--required-values <values>", "comma-separated").option("--display-name <name>")
    .action(async (method: string, options: Record<string, string | boolean | undefined>, command: Command) => {
      if (method !== "slack" && method !== "oidc") throw agentXError("CONFIG_INVALID", "the method is slack or oidc");
      const globals = globalOptions(command);
      const text = (name: string) => (typeof options[name] === "string" ? options[name] : undefined);
      const source = (file?: string, envName?: string) => (file === undefined && envName === undefined ? undefined : { ...(file === undefined ? {} : { file }), ...(envName === undefined ? {} : { envName }) });
      const flags = definedEntries<SigninFlags>({
        slackClientId: text("slackClientId"), oidcIssuer: text("issuer"), oidcClientId: text("clientId"),
        oidcRequiredClaim: text("requiredClaim"), oidcRequiredValues: text("requiredValues"), oidcDisplayName: text("displayName"),
      });
      const secretFlags = definedEntries<SigninSecretFlags>({
        slackClientSecret: source(text("slackClientSecretFile"), text("slackClientSecretEnv")),
        oidcClientSecret: source(text("clientSecretFile"), text("clientSecretEnv")),
      });
      const result = await runSigninEnable(signinServices(text("region"), command), globals.env, method, flags, secretFlags, options.yes === true);
      services.stdout.write(globals.json ? formatSuccess(result, true) : `${result.changed ? "Developer sign-in updated." : "Nothing to change."}\n`);
    });
  signin.command("disable").argument("<method>", "slack or oidc").option(regionOption, regionHelp).option("--yes", "apply without asking", false)
    .action(async (method: string, options: { region?: string; yes: boolean }, command: Command) => {
      if (method !== "slack" && method !== "oidc") throw agentXError("CONFIG_INVALID", "the method is slack or oidc");
      const globals = globalOptions(command);
      const result = await runSigninDisable(signinServices(options.region, command), globals.env, method, options.yes);
      services.stdout.write(globals.json ? formatSuccess(result, true) : `${result.changed ? "Developer sign-in updated." : "Nothing to change."}\n`);
    });
  signin.command("check").option(regionOption, regionHelp).action(async (options: { region?: string }, command: Command) => {
    const globals = globalOptions(command);
    const checks = await runSigninCheck(signinServices(options.region, command), globals.env);
    services.stdout.write(globals.json ? formatSuccess(checks, true) : `${checkLines(checks).join("\n")}\n`);
    const failed = checks.filter((check) => !check.ok).length;
    if (failed > 0) throw agentXError("CONFIG_INVALID", `${failed} developer sign-in check${failed === 1 ? "" : "s"} failed; see above`);
  });
```

Add the imports this needs (`runSigninShow`, `runSigninEnable`, `runSigninDisable`,
`runSigninCheck`, `type SigninServices` from `./signin/commands.js`; `checkLines` from
`./signin/check.js`; `type SigninFlags`, `type SigninSecretFlags` from `./signin/collect.js`;
`secretsManagerInitSecrets` from `./init/context.js`; `slackWebApi` from `./init/slack-app.js`;
`processPrompter`, `unattendedPrompter` from `./init/prompts.js`).

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run tests/contract/signin-commands.test.ts tests/contract/signin-check.test.ts tests/contract/cli-main.test.ts tests/contract/signin-settings.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/signin packages/cli/src/main.ts tests/contract/signin-commands.test.ts tests/contract/signin-check.test.ts tests/contract/cli-main.test.ts
git commit -m "feat(cli): agentx signin show, enable, disable and check"
```

---

### Task 13: The `developer-signin` init step

**Files:**
- Create: `packages/cli/src/init/signin-step.ts`
- Modify: `packages/cli/src/init/install-state.ts` (`INIT_STEP_IDS` gains `developer-signin` last)
- Modify: `packages/cli/src/init/context.ts` (`cloudFormation`, `signinFlags`; `SecretFlags` gains `slackClientSecret`, `oidcClientSecret`)
- Modify: `packages/cli/src/init/commands.ts` (the step; `InitCliDependencies.cloudFormation`; `InitOptions.signinFlags`)
- Modify: `packages/cli/src/main.ts` (the init flags)
- Modify: `tests/support/init-fakes.ts` (`initContext` gains the two fields)
- Modify: `tests/contract/init-install-state.test.ts`, `tests/contract/init-cli.test.ts` (Open question 5)
- Test: `tests/contract/init-signin-step.test.ts`

**Interfaces:**
- Consumes: Tasks 9, 11 and 12 (`collectSlackClient`, `slackSignInPrerequisites`, `collectOidc`,
  `storeOidcSecret`, `applySignInChange`, `slackSecretWithSignIn`, `readSignInSettings`).
- Produces:
  - `developerSignInStep(input: { slack: SlackApi }): InitStep<InitContext>` with id
    `developer-signin` and title "Set up developer sign-in";
  - `InitContext` gains `cloudFormation: { send(command: unknown): Promise<unknown> }` and
    `signinFlags: SigninFlags`;
  - init flags: `--signin <slack|oidc|both>`, `--slack-client-id <id>`,
    `--slack-client-secret-file <path>`, `--slack-client-secret-env <NAME>`,
    `--signin-oidc-issuer <url>`, `--signin-oidc-client-id <id>`,
    `--signin-oidc-client-secret-file <path>`, `--signin-oidc-client-secret-env <NAME>`,
    `--signin-oidc-required-claim <claim>`, `--signin-oidc-required-values <values>`,
    `--signin-oidc-display-name <name>`.

- [ ] **Step 1: Write the failing test and update the existing ones**

```ts
// tests/contract/init-signin-step.test.ts
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { writeEnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import { developerSignInStep } from "../../packages/cli/src/init/signin-step.js";
import { emptyProgress } from "../../packages/cli/src/init/install-state.js";
import { readSignInSettings } from "../../packages/cli/src/signin/settings.js";
import { stagingSettings } from "../support/environment-fixtures.js";
import { SIGN_IN_PARAMETERS, fakeCloudFormation } from "../support/fake-cloudformation.js";
import { T0, fakeSlackApi, initContext, memoryInitSecrets, progressHandle, scriptedPrompter, TEST_BOT_TOKEN, TEST_SIGNING_SECRET } from "../support/init-fakes.js";

const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))); });
const CLIENT_SECRET = "fedcba9876543210fedcba9876543210";
const installed = { ...stagingSettings, controlPlaneUrl: "https://abc123.execute-api.us-east-1.amazonaws.com", access: { artifactBucket: "b", cloudFormationRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-cloudformation", operatorRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-operator", pullThroughPrefix: "agentx-staging" } };
const withScopes = fakeSlackApi({ authTest: async () => ({ ok: true, team_id: "T0TEAM", user_id: "U0BOT", bot_id: "B0BOT", scopes: ["channels:read", "groups:read", "im:write", "users:read", "users:read.email"] }) });

async function context(prompts: Array<string | boolean>) {
  const cloudFormation = fakeCloudFormation({ parameters: SIGN_IN_PARAMETERS });
  const secrets = memoryInitSecrets({ "agentx/staging/slack": JSON.stringify({ signingSecret: TEST_SIGNING_SECRET, botToken: TEST_BOT_TOKEN }) });
  const ctx = initContext({ prompter: scriptedPrompter(prompts), secrets, cloudFormation });
  homes.push(ctx.home);
  await writeEnvironmentSettings(ctx.store, installed);
  const progress = progressHandle({ ...emptyProgress("staging", T0), slack: { appId: "A0APP", teamId: "T0TEAM", botUserId: "U0BOT" } });
  return { ctx, cloudFormation, progress };
}

describe("the developer-signin init step (FR-044)", () => {
  it("defaults to Slack, stores the client credentials, records the team and turns Slack sign-in on", async () => {
    const { ctx, cloudFormation, progress } = await context(["", "1111111111.2222222222222", CLIENT_SECRET, true]);
    expect(await developerSignInStep({ slack: withScopes }).run(ctx, progress)).toEqual({ status: "done", note: "developer sign-in: Slack" });
    expect(cloudFormation.parameters).toMatchObject({ DeveloperSignInSlack: "enabled", SlackTeamId: "T0TEAM" });
    expect(await readSignInSettings(ctx.store, "staging")).toMatchObject({ slack: true });
    expect(ctx.lines).toContain("Developers sign in with: npx @charterarc/agentx login https://abc123.execute-api.us-east-1.amazonaws.com");
    expect(ctx.lines.join("\n")).not.toContain(CLIENT_SECRET);
  });

  it("holds the lock the step runner already holds, and never takes it again", async () => {
    const { ctx, progress } = await context(["", "1111111111.2222222222222", CLIENT_SECRET, true]);
    await developerSignInStep({ slack: withScopes }).run(ctx, progress);
    expect(ctx.store.calls.filter((call) => call.name.endsWith("/lock") && call.op !== "get")).toEqual([]);
  });

  it("refuses a bot token of another workspace than the install's", async () => {
    const { ctx, progress } = await context([""]);
    const otherTeam = fakeSlackApi({ authTest: async () => ({ ok: true, team_id: "T0OTHER", user_id: "U0BOT", bot_id: "B0BOT", scopes: [] }) });
    await expect(developerSignInStep({ slack: otherTeam }).run(ctx, progress)).rejects.toThrow("the stored bot token belongs to Slack workspace T0OTHER, but this install uses T0TEAM; nothing was saved");
  });

  it("is done at once when sign-in was already set up (a re-run after a crash)", async () => {
    const { ctx, cloudFormation, progress } = await context([]);
    await ctx.store.put("/agentx/staging/signin", JSON.stringify({ schemaVersion: 1, env: "staging", slack: true, updatedAt: "2026-09-27T00:00:00.000Z", updatedBy: "x" }));
    expect(await developerSignInStep({ slack: withScopes }).run(ctx, progress)).toEqual({ status: "done", note: "developer sign-in was already set up" });
    expect(cloudFormation.calls).toEqual([]);
  });
});
```

In `tests/contract/init-install-state.test.ts`, the expected `INIT_STEP_IDS` gains
`"developer-signin"` at the end.

In `tests/contract/init-cli.test.ts` (Open question 5; no assertion removed or weakened):
- the harness passes `cloudFormation: fakeCloudFormation({ parameters: SIGN_IN_PARAMETERS })` in
  `deps` (imported from `../support/fake-cloudformation.js`);
- add `const SIGNIN = ["", "1111111111.2222222222222", "fedcba9876543210fedcba9876543210", true];`
  (default method Slack, client ID, client secret, "Apply this change?") and append `...SIGNIN`
  to every scripted prompter that runs through `slack-service`;
- add to `UNATTENDED` the flags `"--slack-client-id", "1111111111.2222222222222",
  "--slack-client-secret-env", "SLACK_CLIENT_SECRET"`, and to `UNATTENDED_ENV`
  `SLACK_CLIENT_SECRET: "fedcba9876543210fedcba9876543210"`;
- in the first-run test, also assert
  `expect(await everywhereButSecrets(h)).not.toContain("fedcba9876543210fedcba9876543210");`;
- the harness's `fakeSlackApi()` returns no scopes, which the step treats as "not reported" and does
  not refuse; the refusal is pinned in Task 12.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/contract/init-signin-step.test.ts tests/contract/init-install-state.test.ts tests/contract/init-cli.test.ts`
Expected: FAIL, the step does not exist.

- [ ] **Step 3: Implement the step**

```ts
// packages/cli/src/init/signin-step.ts
// Spec 025 FR-044: the last agentx init step (R9). It asks which developer sign-in methods to
// enable (Slack by default), collects the Slack app's client ID and secret or the company OIDC
// app, and runs the same change as agentx signin enable, under the lock the runner holds.
import { agentXError } from "@agentx/contracts";
import { readEnvironmentSettings } from "../environments/settings.js";
import { applySignInChange } from "../signin/apply.js";
import { collectOidc, collectSlackClient, slackSignInPrerequisites, storeOidcSecret } from "../signin/collect.js";
import { readSignInSettings, type DeveloperSignInSettings } from "../signin/settings.js";
import type { InitContext } from "./context.js";
import { slackSecretName, slackSecretWithSignIn, slackSignInCallbackUrl, type SlackApi } from "./slack-app.js";
import type { InitStep } from "./steps.js";

export function developerSignInStep(input: { slack: SlackApi }): InitStep<InitContext> {
  return {
    id: "developer-signin",
    title: "Set up developer sign-in",
    async run(context, progress) {
      const { env } = context;
      if ((await readSignInSettings(context.store, env)) !== undefined) return { status: "done", note: "developer sign-in was already set up" };
      const settings = await readEnvironmentSettings(context.store, env);
      if (settings === undefined) throw agentXError("CONFIG_INVALID", `environment ${env} has no settings yet; the Slack service step must finish first, so run agentx init again`);
      const methods = context.signinFlags.methods ?? await context.prompter.choose<"slack" | "oidc" | "both">("How will developers sign in to AgentX from their AI tools?", [
        { value: "slack", label: "Sign in with Slack (recommended)" },
        { value: "oidc", label: "Your company's sign-in (OIDC)" },
        { value: "both", label: "Both" },
      ], { flag: "--signin", defaultValue: "slack" });
      const common = { prompter: context.prompter, processEnv: context.processEnv, flags: context.signinFlags, secretFlags: context.secretFlags };

      let slackTeamId: string | undefined;
      if (methods !== "oidc") {
        const expected = progress.current().slack?.teamId;
        ({ teamId: slackTeamId } = await slackSignInPrerequisites({ env, secrets: context.secrets, slackApi: input.slack, ...(expected === undefined ? {} : { expectedTeamId: expected }) }));
        context.write(`The Slack app lists the redirect URL ${slackSignInCallbackUrl(settings.controlPlaneUrl)} and the user scopes openid, email and profile. Copy its Client ID and Client Secret from Basic Information, App Credentials.`);
        const client = await collectSlackClient(common);
        await context.secrets.put(slackSecretName(env), slackSecretWithSignIn(await context.secrets.get(slackSecretName(env)), client));
      }
      let oidc: NonNullable<DeveloperSignInSettings["oidc"]> | undefined;
      if (methods !== "slack") {
        const collected = await collectOidc({ ...common, env, fetch: context.fetch });
        await storeOidcSecret(context.secrets, env, collected.clientSecret);
        context.write(`Register this redirect URI with your identity provider: ${settings.controlPlaneUrl.replace(/\/+$/, "")}/v1/auth/callback/oidc`);
        oidc = collected.oidc;
      }
      await applySignInChange({
        env, store: context.store, cloudFormation: context.cloudFormation, holder: context.holder, settings,
        next: { slack: methods !== "oidc", ...(oidc === undefined ? {} : { oidc }) },
        ...(slackTeamId === undefined ? {} : { slackTeamId }),
        confirm: async (text) => { context.write(text); return context.prompter.confirm("Apply this change?", { defaultValue: true }); },
        write: context.write, now: context.now, sleep: context.sleep, lockHeld: true,
      });
      context.write(`Developers sign in with: npx @charterarc/agentx login ${settings.controlPlaneUrl}`);
      return { status: "done", note: `developer sign-in: ${methods === "both" ? "Slack and company sign-in" : methods === "slack" ? "Slack" : "company sign-in"}` };
    },
  };
}
```

`SecretFlags` in `context.ts` gains `slackClientSecret?: SecretSource; oidcClientSecret?: SecretSource`,
so `context.secretFlags` satisfies `SigninSecretFlags`.

- [ ] **Step 4: Wire it**
- `install-state.ts`: `INIT_STEP_IDS = [..., "slack-service", "developer-signin"] as const`.
- `context.ts`: add `cloudFormation: { send(command: unknown): Promise<unknown> };` and
  `signinFlags: SigninFlags;` (import the type from `../signin/collect.js`) to `InitContext`.
- `commands.ts`: `initSteps` appends `developerSignInStep({ slack: input.slack })`;
  `InitCliDependencies` gains `cloudFormation?: { send(command: unknown): Promise<unknown> }`;
  `InitOptions` gains `signinFlags?: SigninFlags`; the context gets
  `cloudFormation: deps.cloudFormation ?? new CloudFormationClient({ region })` and
  `signinFlags: options.signinFlags ?? {}`.
- `tests/support/init-fakes.ts`: `initContext` sets `cloudFormation: overrides.cloudFormation ?? fakeCloudFormation({ parameters: SIGN_IN_PARAMETERS })`
  and `signinFlags: overrides.signinFlags ?? {}`.
- `main.ts`: add the eleven init flags from the Interfaces block to the `init` command, add them to
  `InitCommandOptions`, and in `initOptions` build
  `signinFlags` with `definedEntries<SigninFlags>({ methods: options.signin, slackClientId: options.slackClientId, oidcIssuer: options.signinOidcIssuer, oidcClientId: options.signinOidcClientId, oidcRequiredClaim: options.signinOidcRequiredClaim, oidcRequiredValues: options.signinOidcRequiredValues, oidcDisplayName: options.signinOidcDisplayName })`
  and add `slackClientSecret: source(options.slackClientSecretFile, options.slackClientSecretEnv)`
  and `oidcClientSecret: source(options.signinOidcClientSecretFile, options.signinOidcClientSecretEnv)`
  to `secretFlags`. Refuse any `--signin` value other than `slack`, `oidc` or `both` with
  commander's `.choices()`.

- [ ] **Step 5: Run the tests, then the whole gate**

Run: `npx vitest run tests/contract/init-signin-step.test.ts tests/contract/init-install-state.test.ts tests/contract/init-cli.test.ts tests/contract/init-steps.test.ts tests/contract/init-slack-app.test.ts`
Expected: PASS.

Run: `npm run typecheck && npm run lint && npm run build && npm test && npm run infra:synth`
Expected: all pass; `legacy-templates.test.ts` unchanged.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/init packages/cli/src/main.ts tests/support/init-fakes.ts tests/contract/init-signin-step.test.ts tests/contract/init-install-state.test.ts tests/contract/init-cli.test.ts
git commit -m "feat(cli): agentx init sets up developer sign-in as its last step"
```

---

### Task 14: Record the rulings in the spec

This task changes no code. It runs after the owner has answered Open questions 1 to 7, and writes
the answers into the spec so the spec and the code agree. Where the owner chose differently from
the recommendation, stop and re-plan the affected task before this one.

**Files:**
- Modify: `specs/025-mcp-server/spec.md`
- Modify: `specs/025-mcp-server/plans/README.md`

- [ ] **Step 1: Amend the spec (recommended answers shown; use the owner's)**
  - FR-005: "a JWT signed with RS256 by a KMS RSA key the control plane owns (API Gateway's JWT
    authorizer accepts only RSA algorithms)", in place of "signed with ES256".
  - FR-001: add `POST /v1/auth/revoke` (RFC 7009) to the route list.
  - FR-011: "`agentx login --admin`, or `agentx login` with no URL: today's admin PKCE login,
    unchanged".
  - Testing, contract tests: "a test that only the notifier, the ingress, the orchestrator role
    and the `DeveloperIdentity` sign-in function can read the Slack secret".
  - SC-008: "...pass with no assertion removed or weakened; lists of commands, init steps and
    manifest scopes gain the new entries".
  - Decisions: add D14 (R3, sign-in in named environments only until the owner decides
    production), D15 (R6 and R7, how sign-in settings reach the control plane) and D16 (R12,
    `sid` and the per-request session check), each one paragraph, marked owner-confirmed with the
    date.
  - The Assumptions line "Spec 015 phase 15d (`agentx init`) is not built yet..." becomes
    "Phase 15d1 built `agentx init`; phase 25a added the `developer-signin` step."
  - FR-046: "`agentx doctor` (phase 15e) runs the checks of `agentx signin check`, which phase 25a
    ships".
- [ ] **Step 2: Mark 25a in the phase README** as "built, see PR #<n>" in the "What it delivers"
  cell's first line. The plan link is already there.
- [ ] **Step 3: Check the copy** with `grep -c "$(printf '\342\200\224')" specs/025-mcp-server/spec.md` (prints 0), then
  commit:

```bash
git add specs/025-mcp-server/spec.md specs/025-mcp-server/plans/README.md
git commit -m "docs(spec-025): record the phase 25a rulings"
```

---

### Task 15: Live check in a throwaway environment (owner present)

This task changes no code unless it finds a defect. A defect is fixed with a failing test first,
then reviewed. It needs:
- the owner's explicit go-ahead, and Pratik's written confirmation of the constitution amendment
  (Open question 6);
- an admin AWS session for account 944937319445 (CloudShell, or `aws login` to an admin profile for
  this session only), because the access stack creates IAM roles;
- a Slack workspace the owner names for testing, and a GitHub organization or account for testing.
  Never production's Slack app, GitHub App, stacks, secrets or `/agentx/production/*`.

It uses a new environment, `live25a`, in `us-east-1`. The company sign-in is played by a second,
confidential app client on the environment's own Cognito user pool, which is a real OIDC provider
with groups. That needs no outside IdP access.

- [ ] **Step 1: Prepare (read-only)**
  - Build a release from this branch: `npm run release:build -- --version 0.0.3 --out <scratch>/rel`.
  - Read production's image digests, read-only, exactly as phase 15d1's live check did
    (`aws cloudformation describe-stacks --stack-name AgentXProductionRuntime --query "Stacks[0].Parameters[?ParameterKey=='WorkerImageUri'].ParameterValue" --output text --region us-east-1`,
    and the same for `AgentXSlackOrchestrator` and `OrchestratorImageUri`).
  - Confirm `aws ssm get-parameters-by-path --path /agentx/live25a --recursive --region us-east-1`
    returns nothing.
- [ ] **Step 2: Owner approval.** Tell the owner:
  - what it creates: six stacks, a GitHub App and a Slack app in their test organization and
    workspace, a KMS RSA key, the `DeveloperSignIn` table, and a Cognito app client;
  - the cost while it exists: about $3 a day (phase 15d1's figure), plus the KMS key at $1 a month,
    prorated;
  - that everything is torn down in Step 9.
- [ ] **Step 3: Install with Slack sign-in.** Run
  `node packages/cli/dist/main.js --env live25a init --region us-east-1 --release <scratch>/rel --worker-image <worker digest ref> --slack-image <slack digest ref>`.
  At the `developer-signin` step, take Slack. Record:
  - that Slack's create-from-manifest page accepted `redirect_urls` and the user scopes;
  - the step's change text, and how long the parameter update took;
  - whether `agentx --env live25a signin check --region us-east-1` passes every check, in
    particular "Slack redirect URL". If Slack answers the test authorize request differently from
    what `slackRedirectRegistered` expects, fix it with a failing test built from the observed
    response.
- [ ] **Step 4: Sign in with Slack.** As a member of the test workspace, on a machine or profile
  without AWS credentials in the environment:
  - `node packages/cli/dist/main.js login <ApiEndpoint>`: the browser goes straight to Slack, the
    terminal prints who you are and "You cannot use any project yet...";
  - optionally, to see channel access (US4 scenario 6): as admin, create a Cognito admin user,
    `agentx --env live25a login --admin`, register a test project and bind a test channel with the
    existing `agentx admin` commands, join the channel, then `agentx whoami`: the project is listed
    "you are in its Slack channel";
  - check that `~/.agentx/developer.yaml` holds no token.
- [ ] **Step 5: Revocation, live.**
  - `agentx --env live25a signin disable slack` refuses while Slack is the only method. Enable
    company sign-in first (Step 6), then disable Slack. The next `agentx whoami` fails at once with
    "Slack sign-in is turned off" (R13), without waiting an hour. Then re-enable Slack.
  - `agentx logout`, then `agentx whoami`: "not signed in".
- [ ] **Step 6: Company sign-in with a required group.**
  - In the `live25a` user pool (IDs from the identity stack's outputs), create the group
    `agentx-developers`, and two test users with verified emails: one in the group, one not.
  - Create a confidential app client with the `code` flow, the scopes `openid email profile`, the
    callback URL `<ApiEndpoint>/v1/auth/callback/oidc`, and `COGNITO` as its identity provider.
    Write its secret straight to a file with owner-only permissions:
    `aws cognito-idp describe-user-pool-client --user-pool-id <id> --client-id <client> --query UserPoolClient.ClientSecret --output text > <scratch>/oidc-secret && chmod 600 <scratch>/oidc-secret`.
    Never print it.
  - `agentx --env live25a signin enable oidc --region us-east-1 --issuer https://cognito-idp.us-east-1.amazonaws.com/<pool id> --client-id <client> --client-secret-file <scratch>/oidc-secret --required-claim cognito:groups --required-values agentx-developers --display-name "Test company"`.
  - `agentx login <ApiEndpoint>`: the page shows both methods. The user outside the group is
    refused: the terminal stops at once, naming `cognito:groups` and `agentx-developers`
    (Review Focus 1). The user in the group signs in; if their email matches a Slack member,
    `whoami` shows the Slack link (FR-012).
- [ ] **Step 7: Another Slack workspace (SC-007 live).** Slack itself refuses a sign-in from another
  workspace for an app that is not distributed, before AgentX sees it. If the owner wants the
  AgentX refusal shown live, turn on public distribution for the throwaway app temporarily and sign
  in from a second workspace: expect "you signed in to Slack workspace T..., but this AgentX serves
  T...". Otherwise record that SC-007 rests on the contract tests and on Slack's own refusal.
- [ ] **Step 8: No secret leaked.**
  - `grep -r` over `~/.agentx` and the saved terminal log for `xoxb-`, `agxr_`, `agxc_`, the Slack
    client secret and the Cognito client secret finds nothing.
  - For each pattern, run
    `aws logs filter-log-events --log-group-name <DeveloperIdentity log group> --filter-pattern '"agxr_"' --region us-east-1`:
    no events. Repeat for `xoxb-` and for the broker's log group.
- [ ] **Step 9: Tear down.** Give the owner these commands, run under the admin session:
  1. On this machine: `agentx --env live25a logout`. Delete the Keychain items the CLI stored
     (service `dev.agentx.cli`) for the `live25a` issuers.
  2. Turn termination protection off on `agentx-live25a-access`, `-foundation`, `-identity` and
     `-runtime`, then delete the stacks in reverse order (slack, runtime, control-plane, identity,
     foundation, access), waiting for each, as in phase 15d1's Step 6.
  3. Remove what the stacks retain, as in phase 15d1's Step 6:
     - the capacity provider, the Cognito user pool (turn deletion protection off first; its app
       clients go with it), the buckets, the DynamoDB tables, the log groups;
     - `agentx-live25a-control-plane`'s `DeveloperSignInTable...`;
     - the default boundary policy if left behind.

     The developer token key is deleted with its stack after a 7-day pending window. Also schedule
     deletion of the workspace KMS key, as in 15d1.
  4. Force-delete the secrets `agentx/live25a/callback-signing-key`, `agentx/live25a/github-app`,
     `agentx/live25a/slack`, `agentx/live25a/developer-oidc` and, if created,
     `agentx/live25a/alert-endpoint`.
  5. Delete the parameters: `aws ssm delete-parameters --names /agentx/live25a/settings /agentx/live25a/install/answers /agentx/live25a/install/progress /agentx/live25a/signin /agentx/live25a/slack/teamId --region us-east-1`,
     and `/agentx/live25a/lock` if present.
  6. Delete the GitHub App and the Slack app (its settings pages).
  7. Confirm that no `agentx-live25a-*` stack is listed and `/agentx/live25a` is empty.
- [ ] **Step 10: Record the evidence** in the PR description: the commands, outcomes and timings,
  the `signin check` output, each defect fixed, and any finding that changes a ruling above (for
  example, Slack's test authorize response). Raise those with the owner before merge.

## Not in this phase

- **Phase 25b:**
  - the developer task API (`POST /v1/dev/tasks` and the rest of FR-016);
  - the `developerTasks` project settings (FR-014), which replace R16's `() => true`;
  - the `@agentx/mcp` package and `agentx mcp`, including the MCP-side `UPGRADE_REQUIRED` and
    upgrade notice of FR-048;
  - `agentx mcp install` and the install guide (FR-043, FR-047);
  - `PROJECT_ACCESS_DENIED`'s list of visible channels (FR-049).
- **Phase 25e:** creating and revoking grants and sign-ins
  (`agentx_admin_grant_project_access`, `agentx_admin_revoke_project_access`,
  `agentx_admin_revoke_signin`); the Slack Confirm DMs that use `im:write`; `mcp.confirm.elicitation`
  in `agentx-configuration`.
- **Phase 15e:** `agentx doctor`, which calls `checkDeveloperSignIn` (R5).
- **Later, by owner decision:** developer sign-in on the legacy production deployment (R3), and
  rotating the developer token key.
