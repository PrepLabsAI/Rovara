# Phase 25e: Admin Changes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An AgentX admin can change AgentX from their AI tool (register a project revision, bind or
unbind a channel, register a credential, stop a workspace's work, grant or revoke a developer's
project access, end a developer's sign-in, and change the workspace limits), and every change first
shows its exact effect and applies only after a confirmation the model cannot give itself: the MCP
client's own pop-up, or a Confirm button in the admin's Slack direct messages. Every request,
whatever its outcome, leaves one audit record with a trace ID that admins read with
`agentx_admin_changes` and `agentx admin changes`. The CLI gains `agentx admin project grant` and
`revoke`, and `agentx config set limits.*` works, through the same change path.

**Architecture:**
- **A change is planned, stored, confirmed, then applied once** (FR-039, FR-040). `POST
  /v1/admin/changes` checks the admin's rights, computes the effect and a hash of the state it was
  planned against, and stores a pending change (`ADMIN_CHANGE#<id>` in the State table, 10 minutes)
  with its audit record (`CHANGE#<id>` in the TurnRecords table, 30 days). `/apply` (the pop-up or
  the CLI) and a Slack press re-plan the change, refuse it when the state moved (`CHANGE_STALE`),
  claim it with one conditional write so it applies at most once, and run the existing admin
  handler. `/decline` and a Cancel press mark it declined.
- **Two confirmation methods, in order** (FR-041): MCP elicitation, when the client declared it and
  the environment allows it; otherwise the Slack Confirm button, when the admin's verified email
  matches one Slack user (25d's `GET /v1/admin/me`). The Slack step is started by the MCP server
  (`POST /v1/admin/changes/<id>/slack`); the notifier sees it on the state table's stream (a new
  filter on its existing mapping, never a third reader, C7) and posts the direct message; a press
  reaches the ingress, which hands it to the broker asynchronously; the broker applies it, and the
  notifier edits the message with the outcome. A person typing an `agentx` command is the third,
  CLI-only method (`cli`), as D12 already allows **(Q6)**.
- **The MCP server offers the change tools only when a method is available** (FR-028, FR-041), with
  25d's tool offer, now in three groups: admin reads, the audit read (`agentx_admin_changes`) and
  the change tools. A direct call to a hidden change tool answers `CONFIRMATION_UNAVAILABLE`.
- **Traceable end to end** (FR-052): one trace ID per change tool call, sent as `x-agentx-trace-id`
  on each of its calls, stored on the change, and written with the change ID in one log line at
  each step (broker, notifier, ingress); one `AdminChangeOutcome` metric per outcome.

**Tech Stack:** TypeScript 5.9 strict (`exactOptionalPropertyTypes` on), Node 22.19 to 22.x, Zod 4
(4.6.5), Vitest, `@modelcontextprotocol/sdk` 1.30.1 (elicitation), AWS SDK v3 3.1134.0
(`lib-dynamodb`, `client-lambda`), AWS CDK (event source mapping filters).

**Spec:** [../spec.md](../spec.md), the binding authority. Phase 25e delivers the phase README's row:
- FR-030's admin change tools (all nine) and `agentx_admin_changes`;
- FR-039 (pending changes), FR-040 (apply once, decline), FR-041 (the two methods, the read-only
  fallback, `CONFIRMATION_UNAVAILABLE`), FR-042 (existing `agentx admin` commands unchanged);
- FR-051 (one audit record per request), FR-052 (trace IDs, outcome metrics, `GET
  /v1/admin/changes`, `agentx_admin_changes`, `agentx admin changes`), FR-053 (the workspace limits
  change tool, and spec 015 FR-048's `agentx config set limits.*`);
- User Story 6; SC-005, SC-011, SC-013;
- the owner's requirement of 2026-09-29: `agentx_admin_grant_project_access` with a CLI
  equivalent (there is no way today for an admin to grant a developer direct access, FR-013.1),
  and `agentx config set limits.workspacesPerMember` / `limits.workspacesPerOrg` lifted from their
  "until 25e" refusal and routed through the same change path, with its confirmation and audit;
- 25c's carry-over C22: a close's `completed` audit record.

The phase map is in [README.md](README.md). It builds on phase 25d's interfaces
([phase-25d-admin-reads.md](phase-25d-admin-reads.md)): `AdminReadDependencies` and its helpers,
`adminIdentityReader`, `httpAdminClient`, `ToolOffer`, `guardTransport` and `ADMIN_READ_TOOLS`.
Open product questions are in [phase-25e-questions.md](phase-25e-questions.md): this plan follows
each recommendation, and every task that depends on one says "Depends on Q<n>".

**Branch:** `feat/025e-admin-changes`, cut from mainline once 25d has merged. One PR, against
`mainline`. No stacked PRs.

## Decisions recorded by this plan

Each ruling is written into the code by the task named. Rulings marked **(Q<n>)** follow the
recommendation of an open owner question.

- **E1. The change kinds.** `register_project_revision`, `bind_channel`, `unbind_channel`,
  `register_credential`, `stop_workspace`, `grant_project_access`, `revoke_project_access`,
  `revoke_signin`, `set_workspace_limits`, one per FR-030 change tool. A request is
  `{ requestId, change: { kind, ...input }, client, methods }`. Task 1.
- **E2. The pending change** is `ADMIN_CHANGE#<changeId>` / `META` in the State table: kind, the
  parsed input, the effect text, the plan's details, `stateHash`, the planning admin (issuer,
  subject, owner key, display name), the admin's linked Slack user when there is one,
  `methodsOffered`, `status` (`pending`, `applying`, `applied`, `declined`, `expired`, `failed`),
  `createdAt`, `expiresAt` (10 minutes later, FR-039), `traceId`, and later `slackRequestedAt`,
  `dm` (the Slack message), `methodUsed`, `result` or `error`. A repeated `requestId` from the same
  admin answers the change it made (`ADMIN_CHANGE_REQUEST#<ownerKey>` / `<requestId>`). Tasks 1, 7.
- **E3. The audit record** (FR-051) is `CHANGE#<changeId>` / `AUDIT` in the TurnRecords table,
  which already keeps records 30 days by TTL, listed newest first through its `byTime` index under
  its own partition, `CHANGES` (the turn export reads only `TURNS`, so the two never mix). It holds
  who asked (issuer, subject, display name), the client (the CLI's version, the MCP client's name
  and version), the exact change (the input and the plan's field-level details, through
  `redactSecrets`), the effect, the methods offered and used, the Slack user who pressed, the
  status and the outcome (`confirmed`, `declined`, `expired`, `failed`), each step's time
  (proposed, confirmation requested, answered, applied or failed, expired), the result or the
  redacted error, refused attempts (at most 20), and the trace ID. Only the broker writes it: one
  conditional put, then updates that never clear the outcome once set; no route changes it. An
  expired change is recorded `expired` when next touched, and every read after its expiry shows
  it expired. Tasks 2, 7.
- **E4. Routes.** `POST /v1/admin/changes`; `GET /v1/admin/changes` (FR-052); `GET
  /v1/admin/changes/<id>`; `POST /v1/admin/changes/<id>/slack` (start the Slack step);
  `POST /v1/admin/changes/<id>/apply` (`method`: `elicitation` or `cli`); `POST
  /v1/admin/changes/<id>/decline`. All behind the admin JWT authorizer and the admin claim; only
  the planning admin may apply, decline or start the Slack step; any admin may read. Named
  environments only: elsewhere they answer `NOT_FOUND` "admin changes are not set up in this
  deployment" (D14). Task 7.
- **E5. At most once** (FR-040). Apply and a Confirm press re-plan the change and compare the new
  state hash first (`CHANGE_STALE` otherwise, recorded as a refused attempt, and the change
  becomes `failed`); then one conditional update moves it from `pending` to `applying` only while
  it is unexpired and planned by the same admin with an offered method; only then does the
  existing handler run, and a last update records `applied` or `failed`. A change stuck in
  `applying` for over 2 minutes (the Lambda died) reads as `failed` ("the apply did not finish;
  check the state, then ask again"). Honest limit, kept: the state can change between the hash
  check and the handler's own write, a window of milliseconds that the handlers' own conditions
  (such as registration's immutable revisions) narrow further. Task 7.
- **E6. Rights** (FR-015). A change on a project needs the admin's `administrator` membership of
  it, at planning and again inside the handler at apply: binding (the new project, and the
  channel's current project if any), unbinding, a revision, a grant or revoke, and stopping a
  workspace (its project). Changes that are not about one project (a credential, ending a sign-in,
  the workspace limits) need the admin claim only, as `agentx admin credential register` does
  today **(Q7)**. Tasks 5, 6.
- **E7. What each plan shows** (FR-030's table), in plain words, and what its hash covers:

  | Kind | The effect says | The hash covers |
  |---|---|---|
  | register revision | the new revision number, each changed field with its old and new value (redacted), and the registration preflight's findings | the project's latest revision number |
  | bind | the channel (a public name, or a private one's ID), its current project or "bound to nothing today", the new project and the revision new threads will use | the binding (or its absence) and the project's latest revision |
  | unbind | the channel, its project, and that new messages there get no reply | the binding |
  | register credential | the reference, type and secret name, whether the secret exists and reads as that type, which projects name the reference, and whether it replaces a registration | the registration (or its absence) |
  | stop workspace | the workspace, its project, owner and status, and the running task that will be cancelled **(Q2)** | the workspace's status, active operation and fence |
  | grant access | the developer (name and sign-in, or "has not signed in yet"), the project, and their current access | the grant (or its absence) |
  | revoke access | the developer, the project, that running tasks keep running, and whether channel membership still gives them access | the grant |
  | revoke sign-in | the developer, and that every sign-in session they have now ends at once; they may sign in again **(Q3)** | the developer record's sessions-ended time |
  | set limits | the current and new limits, the current counts, and which people and whether the organization are at or over the new limit | the limits setting (or its absence) and the stack defaults |

  Tasks 5, 6.
- **E8. The developer a grant names** (FR-030's "developer ID, email or Slack user"): a 64-hex
  developer ID as it is; a Slack user ID (`U...`) as the developer ID Slack sign-in gives it
  (`sha256("https://slack.com", userId)`, FR-008), so a grant can precede their first sign-in;
  an email through a new email index that sign-in writes from this release on
  (`EMAIL#<sha256 of the lowercased email>` in the sign-in table), so an email works only once that
  person has signed in **(Q4)**. Tasks 3, 4.
- **E9. Ending a sign-in (Q3).** `revoke_signin` sets `sessionsEndedAt` on the developer record
  (through DeveloperIdentity, which owns the sign-in table's writes): the broker refuses any
  session that started before it, at once (D16's per-request check), and the token endpoint
  revokes such a session at its next refresh. It does not set `revoked`, so the person may sign in
  again. Tasks 3, 6.
- **E10. Stopping a workspace (Q2).** Today's `POST /v1/admin/workspaces/<id>/stop` always answers
  "manual compute stop is not supported; idle sessions stop automatically". The change tool
  therefore cancels the workspace's running task through the existing admin cancel handler (#126),
  and says that the compute stops on its own when idle. A workspace with nothing running is
  refused at planning ("nothing is running; its compute stops on its own when idle"). Task 6.
- **E11. A new revision keeps its project's runtime binding (Q5).** `register_project_revision`
  takes only `definition` (FR-030); the runtime binding is the latest revision's, unchanged. A
  project with no revision yet is refused ("register a project's first revision with agentx admin
  project register"). Task 5.
- **E12. Channels by ID or name (Q8).** A channel ID is used as it is; a name (with or without
  `#`) is looked up among the environment's public channels through DeveloperIdentity
  (`conversations.list`, at most 10 pages of 200); a private channel must be given by ID. Tasks 3, 5.
- **E13. The Slack step.** The MCP server starts it only when elicitation is not offered or did not
  work; the broker then sets `slackRequestedAt` (the audit's "confirmation requested") and the
  notifier posts the direct message with Confirm and Cancel buttons (action IDs
  `agentx_admin_change_confirm` and `agentx_admin_change_cancel`, value the change ID) to the
  admin's Slack user, records `dm` on the change, and, when the change later ends, edits the
  message to say how. The tool call waits up to 5 minutes for the press, with a progress
  notification every 15 seconds, then answers `awaiting_confirmation` (FR-041). Tasks 7, 8, 12.
- **E14. A press** reaches the ingress (the existing interactivity route), which checks the Slack
  signature, answers the presser at once (only they can see it: "Received; AgentX is applying
  it" or "...cancelling it"), and invokes the broker asynchronously with the change ID, the
  button and the Slack user. The broker accepts a press only from the change's own Slack user in
  the environment's team (FR-041); any other press is refused, recorded as a refused attempt, and
  the change stays pending (US6 edge case). A press after the tool stopped waiting still applies
  within the 10 minutes (D7). Direct message channels (`D...`) are parsed for these two buttons
  only; every other button keeps today's parsing. Tasks 7, 9.
- **E15. Outcomes in the tools (Q9).** `applied` and `awaiting_confirmation` are results: the
  change ID, the outcome, the effect and the handler's result. `declined`, `expired` and a stale
  state are FR-049's errors (`CONFIRMATION_DECLINED`, `CONFIRMATION_EXPIRED`, `CHANGE_STALE`),
  whose message names the change ID; a handler's own refusal is its own code with the change ID.
  Task 13.
- **E16. The elicitation switch (Q1).** A new control-plane stack parameter,
  `McpConfirmElicitation` (`enabled` by default, or `disabled`), named environments only, reaches
  DeveloperIdentity (so `agentx-configuration` reports `confirm.elicitation`) and the broker
  (which neither offers nor accepts elicitation when it is `disabled`). `agentx config set
  mcp.confirmElicitation enabled|disabled` changes it with a parameter-only update, and upgrades
  keep it (`OPERATOR_PARAMETERS`). `confirm.slack` is true where Slack sign-in and a Slack team are
  set up. Tasks 10, 11.
- **E17. The CLI method (Q6).** `agentx admin project grant|revoke` and `agentx config set
  limits.*` send `methods: ["cli"]`, print the effect, ask "Apply this change?" (unless `--yes`), and
  apply with `method: "cli"` or decline. The audit records `cli`. The broker always accepts `cli`
  from the planning admin, as D12 accepts any `agentx admin` command a person types. Every existing
  `agentx admin` command is unchanged (FR-042). Tasks 14, 15.
- **E18. The admin API moves to 1.1 (Q11).** `ADMIN_API_VERSION = "1.1"`: the change routes and
  `GET /v1/admin/changes` are new. A 25e MCP server offers the admin read tools against a 25d
  control plane (1.0) but neither `agentx_admin_changes` nor the change tools; `DEVELOPER_API_VERSION`
  stays `1.2`. Tasks 1, 13.
- **E19. The workspace limits setting** (FR-053) is written by `set_workspace_limits` as
  `SETTINGS` / `WORKSPACE_LIMITS` with `perPerson`, `perOrganization`, `updatedBy` (the admin's
  issuer and subject) and `updatedAt`; an omitted value keeps the current one; `perPerson` may not
  exceed `perOrganization` (`INVALID_REQUEST`). The broker already reads it at each workspace
  creation (25b), so the next creation uses it (SC-013). Tasks 4, 6.
- **E20. A close's outcome is audited** (25c's C22): when a close completes, its transaction also
  writes a `completed` AI-tool turn record (`action: "close"`, outcome `succeeded`); a close that
  finds unpublished work writes one with outcome `refused` and the repositories as its response.
  Task 16.

## Owner questions

[phase-25e-questions.md](phase-25e-questions.md) lists eleven questions the spec leaves open. This
plan follows each recommendation. Task 18 records the owner's answers in the spec; if an answer
differs from the recommendation, the owning task changes first, with its tests.

## Global Constraints

- **The live deployment does not change.** With no `agentxEnv`, templates are byte-identical
  (`tests/contract/legacy-templates.test.ts`). Legacy snapshots never change. Never run vitest with
  `-u`. No test and no step of the live check touches production's stacks, `/agentx/production/*`,
  production's Slack app or its secrets. Every resource, grant, parameter and environment variable
  this phase adds exists only in named environments (D14), and code that needs one checks for it.
- **The 25a to 25d live checks' lessons hold:** no resource that CloudFormation validates at create
  time against our own API; the live check runs in a throwaway named environment with the owner
  present, and only one throwaway environment fits in the account at a time (the Elastic IP quota).
- **No test reaches AWS, Slack, GitHub or an IdP.** Every client is injected. The only real network
  use in tests is `127.0.0.1`.
- **Zero changes apply without a valid confirmation** (SC-005). Every change route and the press
  path has a test for: no confirmation, a declined one, an expired one, a reused one, another
  person's press, and a stale state. Each asserts the target state did not change.
- **Never printed, logged, stored in local files, or put in a tool result, audit record, Slack post
  or error message:** tokens (developer, admin, Slack), secret values, and a credential's secret
  contents. A proposed change passes through `redactSecrets` before it is stored (FR-051). Logs
  carry event names, change IDs, trace IDs, kinds, outcomes and error names only. Every task that
  handles one plants a known value and asserts it appears nowhere it must not.
- **Existing admin commands are unchanged** (FR-042): `agentx admin project register`, `slack
  bind|unbind`, `credential register`, `workspace stop|cancel` and their routes keep their exact
  behaviour and tests.
- **Least privilege.** New IAM statements name exact actions and leading keys; the notifier gets
  `ADMIN_CHANGE#*` only; the broker gets `CHANGE#*` on TurnRecords and `EMAIL#*` on the sign-in
  table only.
- **Pratik's `agentx_*` orchestrator tools** are not touched; if a task finds it must, it stops and
  first adds characterization tests, then 1:1 mapping tests, with no weakened assertion.
- **Exact names and values:**
  - routes of E4; tools `agentx_admin_register_project_revision`, `agentx_admin_bind_channel`,
    `agentx_admin_unbind_channel`, `agentx_admin_register_credential`, `agentx_admin_stop_workspace`,
    `agentx_admin_grant_project_access`, `agentx_admin_revoke_project_access`,
    `agentx_admin_revoke_signin`, `agentx_admin_set_workspace_limits`, `agentx_admin_changes`;
  - CLI `agentx admin changes --since <duration> [--json]`, `agentx admin project grant|revoke
    --project <name> --developer <id, email or Slack user> [--yes]`, `agentx config set
    limits.workspacesPerMember|limits.workspacesPerOrg <n> [--yes]`, `agentx config set
    mcp.confirmElicitation enabled|disabled`;
  - items `ADMIN_CHANGE#<id>`/`META`, `ADMIN_CHANGE_REQUEST#<ownerKey>`/`<requestId>` (State),
    `CHANGE#<id>`/`AUDIT` with `exportPk` `CHANGES` (TurnRecords), `EMAIL#<hash>`/`META` (sign-in);
  - a change expires 10 minutes after it is planned; the Slack wait is 5 minutes with progress
    every 15 seconds; `applying` is stale after 2 minutes; audit records keep 30 days; at most 20
    refused attempts per record;
  - error codes gain `CONFIRMATION_UNAVAILABLE`, `CONFIRMATION_DECLINED`, `CONFIRMATION_EXPIRED`,
    `CHANGE_STALE` (HTTP 409); `ADMIN_API_VERSION = "1.1"` (Q11);
  - the metric `AdminChangeOutcome` with the dimension `Outcome`;
  - the stack parameter `McpConfirmElicitation` (`enabled` or `disabled`).
- **Copy:** plain words; every error says what to do next; no em dashes in any user-facing text,
  Slack message, tool description, AWS resource name or description.
- **The gate:** `npm run typecheck && npm run lint && npm run build && npm test && npm run infra:synth`.
  - Use Node 22: `export PATH=/private/tmp/claude-501/node-v22.20.0-darwin-arm64/bin:$PATH`.
  - Known load flakes (issue #59): rerun that file alone.
- **Existing suites:** no assertion is removed or weakened (SC-008). Lists of routes, tools, codes
  and constants gain the new entries by appending. Where a test pinned behaviour this phase
  deliberately changes (the config command's limits refusal), the task names the test, the old
  assertion and its replacement.
- **Build process:** the owner approves this plan before building. Building uses
  superpowers:subagent-driven-development, with a fresh implementer and a fresh reviewer per task.
  PRs target mainline.

## Review Focus

1. **The admin presses Confirm in Slack after the tool call stopped waiting, and seconds before the
   change expires.** Expected: the change applies once (D7), the audit shows `slack`, the presser
   and the times, the message is edited to "Applied", and a second press gets "no longer pending"
   without applying twice. Pinned in Task 7 (`admin-change-routes.test.ts`, "applies a press after
   the wait, once, and refuses the second press").
2. **The state moves between the plan and the confirmation** (another admin binds the same channel
   to a third project). Expected: the pop-up's accept answers `CHANGE_STALE` naming the change ID,
   nothing is written to the binding, and the audit shows `failed` with the refused attempt
   `stale_state`. Pinned in Task 7 ("refuses a stale change and leaves the binding as the other
   admin set it").
3. **The client declared elicitation, but the pop-up request fails** (the client answers with an
   error, or times out after 9 minutes). Expected: when Slack is available the tool falls back to the
   Slack step and says so in its progress; otherwise it declines the change, and the audit says
   `declined` with the method `elicitation`. Pinned in Task 12 (`mcp-confirmation.test.ts`, "falls
   back to Slack when the pop-up fails, and declines when there is no Slack").
4. **A planted secret in a revision's definition** (an `orchestratorInstructions` line quoting
   `ghp_...`) and in a credential tool's input. Expected: the effect, the audit record, the Slack
   message and every log line show `[REDACTED]`; the credential tool refuses the input as looking
   like a secret before anything is stored. Pinned in Task 5 (`admin-change-plans.test.ts`,
   "redacts a planted secret in a revision's diff, and refuses a secret-looking credential input")
   and Task 17 (the SC-004 sweep over change records).
5. **`agentx config set limits.workspacesPerMember 2` while one person has 3 open workspaces.**
   Expected: the plan names that person as over the new limit, the command asks first, the setting
   changes after "yes", their existing workspaces keep running, and their next creation is refused
   while any other person's is allowed. Pinned in Task 15 (`config-limits-change.test.ts`, "shows
   who is over the new limit, asks, and the next creation uses it").

---

## File map

| File | Responsibility | Task |
|---|---|---|
| `packages/contracts/src/admin-changes.ts` | change requests, views, audit records, keys, constants, the press event | 1 |
| `packages/contracts/src/errors.ts`, `admin.ts`, `developer.ts`, `index.ts` (modify) | four error codes; admin API 1.1; `confirm` in the configuration; new invoke requests | 1, 3 |
| `packages/broker/src/aws/admin-change-audit.ts` | the audit record's writes and reads, step logs, the outcome metric | 2 |
| `packages/broker/src/developer/store.ts`, `server.ts`, `slack-directory.ts` (modify) | the email index; `sessionsEndedAt`; `end-developer-sessions`, `channel-by-name` | 3 |
| `packages/broker/src/aws/developer-routes.ts` (modify) | the broker refuses sessions ended by an admin; through-lambda helpers | 3 |
| `packages/broker/src/aws/admin-actions.ts` | grant and revoke access, set limits, resolve a developer, end sessions | 4 |
| `packages/broker/src/aws/admin-change-plans.ts` | each kind's plan: effect, details, snapshot, apply | 5, 6 |
| `packages/broker/src/aws/broker.ts` (modify) | registration's dry run; the handlers for plans; route wiring; the press event | 5, 7 |
| `packages/broker/src/aws/admin-changes.ts` | the change routes, claim and apply once, expiry, the press | 7 |
| `packages/broker/src/aws/developer-task-notifier.ts`, `slack-web.ts`, `packages/broker/src/developer/change-messages.ts` | the direct message and its edit | 8 |
| `packages/broker/src/aws/slack-interactivity.ts`, `slack-ingress.ts` (modify) | the Confirm and Cancel presses | 9 |
| `infra/lib/control-plane.ts`, `developer-task-notifier.ts`, `developer-signin.ts` (modify) | the filter, the grants, the parameter | 10 |
| `packages/cli/src/config/keys.ts`, `packages/cli/src/deploy/parameters.ts` (modify) | `mcp.confirmElicitation`; keep it on upgrade | 11 |
| `packages/mcp/src/admin-client.ts`, `confirmation.ts` | the change calls; the confirmation driver | 12 |
| `packages/mcp/src/change-tools.ts`, `offer.ts`, `server.ts`, `errors.ts` (modify) | the change tools and `agentx_admin_changes`; three offer groups | 13 |
| `packages/cli/src/mcp/serve.ts` (modify) | the confirmation methods from the configuration and `/me` | 13 |
| `packages/cli/src/admin/changes.ts`, `packages/cli/src/main.ts` (modify) | `agentx admin changes`, `admin project grant|revoke`, the CLI change runner | 14 |
| `packages/cli/src/config/commands.ts`, `cli.ts` (modify) | `config set limits.*` through the change path | 15 |
| `packages/broker/src/aws/developer-tasks.ts`, `packages/broker/src/developer/task-records.ts` (modify) | a close's `completed` record | 16 |
| `tests/support/admin-change-broker.ts` | the admin read broker plus changes, a Slack team, a press, a clock | 7 |
| `tests/support/admin-read-broker.ts` (modify) | `admin()` takes a body | 7 |
| `tests/support/developer-fakes.ts` (modify) | `conversations.list` in the fake Slack | 3 |
| `tests/support/config-services.ts` | `config-commands.test.ts`'s services factory, moved | 15 |
| `tests/support/mcp-broker-client.ts` (modify) | the configuration's versions; elicitation, clock and `onSleep` | 17 |
| `specs/025-mcp-server/spec.md`, `plans/README.md` (modify) | record the rulings and answers | 18 |

---
### Task 1: The contracts for admin changes

E1 to E4, E13, E14, E16, E18. **Depends on Q11** (the admin API version).

**Files:**
- Create: `packages/contracts/src/admin-changes.ts`
- Modify: `packages/contracts/src/errors.ts` (four codes)
- Modify: `packages/contracts/src/admin.ts` (`ADMIN_API_VERSION = "1.1"`)
- Modify: `packages/contracts/src/index.ts` (append `export * from "./admin-changes.js";`)
- Test: `tests/contract/admin-change-contracts.test.ts`
- Modify (expected constants): `tests/contract/admin-read-contracts.test.ts` (`ADMIN_API_VERSION`
  `"1.0"` becomes `"1.1"`), `tests/contract/developer-task-contracts.test.ts` (the codes list gains
  the four), `tests/contract/developer-identity-admin-invokes.test.ts` and
  `tests/contract/developer-identity-server.test.ts` (`adminApiVersion: "1.1"`)

**Interfaces:**
- Consumes: `AgentXNameSchema`, `SlackUserIdSchema`, `SlackTeamIdSchema`, `SlackChannelIdSchema`
  (contracts).
- Produces (all exported from `@agentx/contracts`):
  - constants `ADMIN_CHANGE_TTL_MS = 600_000`, `ADMIN_CHANGE_SLACK_WAIT_MS = 300_000`,
    `ADMIN_CHANGE_PROGRESS_MS = 15_000`, `ADMIN_CHANGE_APPLYING_STALE_MS = 120_000`,
    `ADMIN_CHANGE_RETENTION_DAYS = 30`, `ADMIN_CHANGES_PARTITION = "CHANGES"`,
    `ADMIN_CHANGE_REFUSED_ATTEMPTS_MAX = 20`, `ADMIN_CHANGE_EFFECT_MAX = 4_000`,
    `ADMIN_CHANGE_CONFIRM_ACTION = "agentx_admin_change_confirm"`,
    `ADMIN_CHANGE_CANCEL_ACTION = "agentx_admin_change_cancel"`;
  - `AdminChangeKindSchema` / `AdminChangeKind`, `ConfirmationMethodSchema` / `ConfirmationMethod`,
    `AdminChangeInputSchema` / `AdminChangeInput` (discriminated by `kind`),
    `AdminChangeClientSchema`, `ProposeAdminChangeRequestSchema` / `ProposeAdminChangeRequest`,
    `ApplyAdminChangeRequestSchema`, `DeclineAdminChangeRequestSchema`;
  - `AdminChangeStatusSchema`, `AdminChangeOutcomeSchema`, `outcomeOfStatus(status)`,
    `AdminChangeViewSchema` / `AdminChangeView`, `AdminChangeResponseSchema`,
    `AdminChangeAuditRecordSchema` / `AdminChangeAuditRecord`, `AdminChangesResponseSchema`,
    `RefusedAttemptReasonSchema` / `RefusedAttemptReason`;
  - keys `adminChangeKey(changeId)`, `adminChangeRequestKey(ownerKey, requestId)`,
    `adminChangeAuditKeys(changeId, proposedAt)`;
  - `AdminChangePressEventSchema` / `AdminChangePressEvent`, `isAdminChangePressEvent(value)`;
  - `AgentXConfigurationConfirmSchema` (`{ elicitation: boolean; slack: boolean }`);
  - `AgentXErrorCodeSchema` gains `CONFIRMATION_UNAVAILABLE`, `CONFIRMATION_DECLINED`,
    `CONFIRMATION_EXPIRED`, `CHANGE_STALE` (each 409).

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/admin-change-contracts.test.ts
// Spec 025 phase 25e, Task 1: the shapes of a change request, its pending record and its audit record.
import { describe, expect, it } from "vitest";
import {
  ADMIN_API_VERSION,
  ADMIN_CHANGE_TTL_MS,
  AdminChangeAuditRecordSchema,
  AdminChangeInputSchema,
  AdminChangeKindSchema,
  ApplyAdminChangeRequestSchema,
  ProposeAdminChangeRequestSchema,
  adminChangeAuditKeys,
  adminChangeKey,
  agentXError,
  isAdminChangePressEvent,
  outcomeOfStatus,
} from "../../packages/contracts/src/index.js";

const CHANGE = "55555555-5555-4555-8555-555555555555";
const REQUEST = "66666666-6666-4666-8666-666666666666";

describe("change requests (E1)", () => {
  it("names FR-030's nine change kinds", () => {
    expect(AdminChangeKindSchema.options).toEqual([
      "register_project_revision", "bind_channel", "unbind_channel", "register_credential", "stop_workspace",
      "grant_project_access", "revoke_project_access", "revoke_signin", "set_workspace_limits",
    ]);
  });

  it("takes each kind's own input, and refuses a field of another kind", () => {
    expect(AdminChangeInputSchema.parse({ kind: "bind_channel", channel: "#ledger-dev", project: "ledger" })).toMatchObject({ kind: "bind_channel" });
    expect(AdminChangeInputSchema.parse({ kind: "set_workspace_limits", perPerson: 5 })).toEqual({ kind: "set_workspace_limits", perPerson: 5 });
    expect(AdminChangeInputSchema.safeParse({ kind: "set_workspace_limits", perPerson: 51 }).success).toBe(false);
    expect(AdminChangeInputSchema.safeParse({ kind: "unbind_channel", channel: "C0123456789", project: "ledger" }).success).toBe(false);
    expect(AdminChangeInputSchema.safeParse({ kind: "grant_project_access", project: "<b>", developer: "U0ADA00001" }).success).toBe(false);
  });

  it("needs a request ID, the client and at least one method", () => {
    const request = { requestId: REQUEST, change: { kind: "unbind_channel", channel: "C0123456789" }, client: { cliVersion: "0.0.7", mcpClient: { name: "claude-code", version: "2.1.0" } }, methods: ["elicitation", "slack"] };
    expect(ProposeAdminChangeRequestSchema.parse(request)).toMatchObject({ methods: ["elicitation", "slack"] });
    expect(ProposeAdminChangeRequestSchema.safeParse({ ...request, methods: [] }).success).toBe(false);
    expect(ProposeAdminChangeRequestSchema.safeParse({ ...request, methods: ["email"] }).success).toBe(false);
  });

  it("applies only by elicitation or the CLI through the route: a Slack press has its own path (E4)", () => {
    expect(ApplyAdminChangeRequestSchema.parse({ method: "elicitation" })).toEqual({ method: "elicitation" });
    expect(ApplyAdminChangeRequestSchema.safeParse({ method: "slack" }).success).toBe(false);
  });
});

describe("records (E2, E3)", () => {
  it("keys the pending change in the State table and the audit record under its own export partition", () => {
    expect(adminChangeKey(CHANGE)).toEqual({ pk: `ADMIN_CHANGE#${CHANGE}`, sk: "META" });
    const keys = adminChangeAuditKeys(CHANGE, "2026-10-02T09:00:00.000Z");
    expect(keys).toMatchObject({ pk: `CHANGE#${CHANGE}`, sk: "AUDIT", exportPk: "CHANGES", exportSk: `2026-10-02T09:00:00.000Z#${CHANGE}` });
    expect(keys.expiresAt).toBe(Math.floor(Date.parse("2026-10-02T09:00:00.000Z") / 1000) + 30 * 86_400);
  });

  it("maps statuses to FR-051's outcomes", () => {
    expect(["pending", "applying", "applied", "declined", "expired", "failed"].map((status) => outcomeOfStatus(status as never))).toEqual([undefined, undefined, "confirmed", "declined", "expired", "failed"]);
  });

  it("reads an audit record with every FR-051 field, and one still pending", () => {
    const record = {
      changeId: CHANGE, kind: "bind_channel", traceId: "trace-1", status: "applied", outcome: "confirmed",
      admin: { issuer: "https://identity.example.test", subject: "admin-subject", displayName: "Ada" },
      client: { cliVersion: "0.0.7", mcpClientName: "claude-code", mcpClientVersion: "2.1.0" },
      change: { kind: "bind_channel", channel: "C0123456789", project: "ledger" }, effect: "Bind channel #ledger-dev (C0123456789) to project ledger.",
      methodsOffered: ["elicitation", "slack"], methodUsed: "slack", pressedBy: "U0ADA00001",
      proposedAt: "2026-10-02T09:00:00.000Z", confirmationRequestedAt: "2026-10-02T09:00:01.000Z", answeredAt: "2026-10-02T09:01:00.000Z", appliedAt: "2026-10-02T09:01:00.500Z",
      result: { binding: { channelId: "C0123456789" } }, refusedAttempts: [{ at: "2026-10-02T09:00:30.000Z", reason: "another_person", slackUserId: "U0BOB00002" }],
    };
    expect(AdminChangeAuditRecordSchema.parse(record)).toMatchObject({ outcome: "confirmed" });
    const { outcome: _outcome, appliedAt: _applied, answeredAt: _answered, methodUsed: _method, pressedBy: _pressed, result: _result, ...pending } = record;
    expect(AdminChangeAuditRecordSchema.parse({ ...pending, status: "pending" })).not.toHaveProperty("outcome");
    expect(AdminChangeAuditRecordSchema.safeParse({ ...record, refusedAttempts: Array.from({ length: 21 }, () => record.refusedAttempts[0]) }).success).toBe(false);
  });
});

describe("the press and the codes (E14, E18)", () => {
  it("recognizes the ingress's press event only without an API Gateway context", () => {
    const press = { source: "agentx.slack-ingress", action: "admin-change-press", changeId: CHANGE, click: "confirm", slackUserId: "U0ADA00001", teamId: "T0BSHLLUGBD" };
    expect(isAdminChangePressEvent(press)).toBe(true);
    expect(isAdminChangePressEvent({ ...press, requestContext: {} })).toBe(false);
    expect(isAdminChangePressEvent({ ...press, click: "maybe" })).toBe(false);
  });

  it("adds the four confirmation codes as 409s, and moves the admin API to 1.1", () => {
    for (const code of ["CONFIRMATION_UNAVAILABLE", "CONFIRMATION_DECLINED", "CONFIRMATION_EXPIRED", "CHANGE_STALE"] as const) expect(agentXError(code, "x").statusCode).toBe(409);
    expect(ADMIN_API_VERSION).toBe("1.1");
    expect(ADMIN_CHANGE_TTL_MS).toBe(600_000);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/contract/admin-change-contracts.test.ts`
Expected: FAIL, `adminChangeKey` and the other new exports are not defined.

- [ ] **Step 3: Add the contracts**

```ts
// packages/contracts/src/admin-changes.ts
// Spec 025 phase 25e: an admin change's request (FR-039), its pending record (E2), its audit record
// (FR-051, E3) and the Slack press that confirms it (E14). Wire answers are not strict, so a newer
// control plane may add fields; stored records and requests are.
import { z } from "zod";
import { AgentXNameSchema } from "./project.js";
import { SlackTeamIdSchema, SlackUserIdSchema } from "./slack.js";

export const ADMIN_CHANGE_TTL_MS = 10 * 60_000;
export const ADMIN_CHANGE_SLACK_WAIT_MS = 5 * 60_000;
export const ADMIN_CHANGE_PROGRESS_MS = 15_000;
export const ADMIN_CHANGE_APPLYING_STALE_MS = 2 * 60_000;
export const ADMIN_CHANGE_RETENTION_DAYS = 30;
export const ADMIN_CHANGES_PARTITION = "CHANGES";
export const ADMIN_CHANGE_REFUSED_ATTEMPTS_MAX = 20;
export const ADMIN_CHANGE_EFFECT_MAX = 4_000;
export const ADMIN_CHANGE_CONFIRM_ACTION = "agentx_admin_change_confirm";
export const ADMIN_CHANGE_CANCEL_ACTION = "agentx_admin_change_cancel";

const Uuid = z.string().uuid();
const Time = z.string().datetime();

export const AdminChangeKindSchema = z.enum([
  "register_project_revision", "bind_channel", "unbind_channel", "register_credential", "stop_workspace",
  "grant_project_access", "revoke_project_access", "revoke_signin", "set_workspace_limits",
]);
export type AdminChangeKind = z.infer<typeof AdminChangeKindSchema>;
export const ConfirmationMethodSchema = z.enum(["elicitation", "slack", "cli"]);
export type ConfirmationMethod = z.infer<typeof ConfirmationMethodSchema>;

const Channel = z.string().min(1).max(80);
/** E8: a developer ID, an email, or a Slack user ID. */
const DeveloperRef = z.string().min(1).max(254);
export const AdminChangeInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("register_project_revision"), definition: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ kind: z.literal("bind_channel"), channel: Channel, project: AgentXNameSchema }).strict(),
  z.object({ kind: z.literal("unbind_channel"), channel: Channel }).strict(),
  z.object({ kind: z.literal("register_credential"), ref: z.string().min(1).max(63), type: z.string().min(1).max(64), secretName: z.string().min(1).max(512) }).strict(),
  z.object({ kind: z.literal("stop_workspace"), workspaceId: Uuid }).strict(),
  z.object({ kind: z.literal("grant_project_access"), project: AgentXNameSchema, developer: DeveloperRef }).strict(),
  z.object({ kind: z.literal("revoke_project_access"), project: AgentXNameSchema, developer: DeveloperRef }).strict(),
  z.object({ kind: z.literal("revoke_signin"), developer: DeveloperRef }).strict(),
  z.object({ kind: z.literal("set_workspace_limits"), perPerson: z.number().int().min(1).max(50).optional(), perOrganization: z.number().int().min(1).max(1_000).optional() }).strict(),
]);
export type AdminChangeInput = z.infer<typeof AdminChangeInputSchema>;

/** FR-051: the AgentX CLI running the MCP server, and the MCP client's own name and version. */
export const AdminChangeClientSchema = z.object({
  cliVersion: z.string().min(1).max(40),
  mcpClient: z.object({ name: z.string().min(1).max(200), version: z.string().max(64).optional() }).strict().optional(),
}).strict();
export const ProposeAdminChangeRequestSchema = z.object({
  requestId: Uuid,
  change: AdminChangeInputSchema,
  client: AdminChangeClientSchema,
  /** In the caller's order of preference; the control plane keeps those it allows (E13, E16). */
  methods: z.array(ConfirmationMethodSchema).min(1).max(3),
}).strict();
export type ProposeAdminChangeRequest = z.infer<typeof ProposeAdminChangeRequestSchema>;
/** E4: a Slack press applies through its own path, never this route. */
export const ApplyAdminChangeRequestSchema = z.object({ method: z.enum(["elicitation", "cli"]), requestedAt: Time.optional(), answeredAt: Time.optional() }).strict();
export const DeclineAdminChangeRequestSchema = z.object({ method: z.enum(["elicitation", "cli"]), reason: z.enum(["declined", "cancelled", "failed"]), answeredAt: Time.optional() }).strict();

export const AdminChangeStatusSchema = z.enum(["pending", "applying", "applied", "declined", "expired", "failed"]);
export type AdminChangeStatus = z.infer<typeof AdminChangeStatusSchema>;
export const AdminChangeOutcomeSchema = z.enum(["confirmed", "declined", "expired", "failed"]);
export type AdminChangeOutcome = z.infer<typeof AdminChangeOutcomeSchema>;
export function outcomeOfStatus(status: AdminChangeStatus): AdminChangeOutcome | undefined {
  switch (status) {
    case "applied": return "confirmed";
    case "declined": return "declined";
    case "expired": return "expired";
    case "failed": return "failed";
    default: return undefined;
  }
}

const ChangeError = z.object({ code: z.string().max(64), message: z.string().max(1_000) });
export const AdminChangeViewSchema = z.object({
  changeId: Uuid,
  kind: AdminChangeKindSchema,
  status: AdminChangeStatusSchema,
  effect: z.string().max(ADMIN_CHANGE_EFFECT_MAX),
  methodsOffered: z.array(ConfirmationMethodSchema),
  createdAt: z.string(),
  expiresAt: z.string(),
  methodUsed: ConfirmationMethodSchema.optional(),
  result: z.record(z.string(), z.unknown()).optional(),
  error: ChangeError.optional(),
});
export type AdminChangeView = z.infer<typeof AdminChangeViewSchema>;
export const AdminChangeResponseSchema = z.object({ change: AdminChangeViewSchema });

export const RefusedAttemptReasonSchema = z.enum(["another_person", "wrong_team", "stale_state", "expired", "not_pending", "method_not_offered", "another_admin"]);
export type RefusedAttemptReason = z.infer<typeof RefusedAttemptReasonSchema>;
export const AdminChangeAuditRecordSchema = z.object({
  changeId: Uuid,
  kind: AdminChangeKindSchema,
  traceId: z.string().min(1).max(128),
  admin: z.object({ issuer: z.string().min(1).max(512), subject: z.string().min(1).max(256), displayName: z.string().min(1).max(200).optional() }).strict(),
  client: z.object({ cliVersion: z.string().max(40), mcpClientName: z.string().max(200).optional(), mcpClientVersion: z.string().max(64).optional() }).strict(),
  /** The input and the plan's details, through redactSecrets. */
  change: z.record(z.string(), z.unknown()),
  effect: z.string().max(ADMIN_CHANGE_EFFECT_MAX),
  methodsOffered: z.array(ConfirmationMethodSchema),
  methodUsed: ConfirmationMethodSchema.optional(),
  pressedBy: SlackUserIdSchema.optional(),
  status: AdminChangeStatusSchema,
  outcome: AdminChangeOutcomeSchema.optional(),
  proposedAt: Time,
  confirmationRequestedAt: Time.optional(),
  answeredAt: Time.optional(),
  appliedAt: Time.optional(),
  failedAt: Time.optional(),
  expiredAt: Time.optional(),
  result: z.record(z.string(), z.unknown()).optional(),
  error: ChangeError.optional(),
  refusedAttempts: z.array(z.object({ at: Time, reason: RefusedAttemptReasonSchema, slackUserId: SlackUserIdSchema.optional() }).strict()).max(ADMIN_CHANGE_REFUSED_ATTEMPTS_MAX).optional(),
}).strict();
export type AdminChangeAuditRecord = z.infer<typeof AdminChangeAuditRecordSchema>;
export const AdminChangesResponseSchema = z.object({ changes: z.array(AdminChangeAuditRecordSchema), cursor: z.string().optional() });
export type AdminChangesResponse = z.infer<typeof AdminChangesResponseSchema>;

export function adminChangeKey(changeId: string): { pk: string; sk: "META" } {
  return { pk: `ADMIN_CHANGE#${changeId}`, sk: "META" };
}
export function adminChangeRequestKey(ownerKey: string, requestId: string): { pk: string; sk: string } {
  return { pk: `ADMIN_CHANGE_REQUEST#${ownerKey}`, sk: requestId };
}
/** E3: the audit record's keys in the TurnRecords table: its own export partition, and the table's TTL. */
export function adminChangeAuditKeys(changeId: string, proposedAt: string) {
  return {
    pk: `CHANGE#${changeId}`,
    sk: "AUDIT" as const,
    exportPk: ADMIN_CHANGES_PARTITION,
    exportSk: `${proposedAt}#${changeId}`,
    expiresAt: Math.floor(Date.parse(proposedAt) / 1000) + ADMIN_CHANGE_RETENTION_DAYS * 86_400,
  };
}

/** E14: the ingress hands a Confirm or Cancel press to the broker by a direct, asynchronous invoke. */
export const AdminChangePressEventSchema = z.object({
  source: z.literal("agentx.slack-ingress"),
  action: z.literal("admin-change-press"),
  changeId: Uuid,
  click: z.enum(["confirm", "cancel"]),
  slackUserId: SlackUserIdSchema,
  teamId: SlackTeamIdSchema.optional(),
}).strict();
export type AdminChangePressEvent = z.infer<typeof AdminChangePressEventSchema>;
export function isAdminChangePressEvent(value: unknown): value is AdminChangePressEvent {
  // API Gateway always sets requestContext, so a request from outside can never take this path.
  return typeof value === "object" && value !== null && (value as { requestContext?: unknown }).requestContext === undefined && AdminChangePressEventSchema.safeParse(value).success;
}

/** FR-041: which methods the environment allows, reported in agentx-configuration (E16). */
export const AgentXConfigurationConfirmSchema = z.object({ elicitation: z.boolean(), slack: z.boolean() });
export type AgentXConfigurationConfirm = z.infer<typeof AgentXConfigurationConfirmSchema>;
```

In `packages/contracts/src/errors.ts`, append `"CONFIRMATION_UNAVAILABLE", "CONFIRMATION_DECLINED",
"CONFIRMATION_EXPIRED", "CHANGE_STALE",` to `AgentXErrorCodeSchema` (each falls to `errorStatus`'s
409). In `packages/contracts/src/admin.ts`: `export const ADMIN_API_VERSION = "1.1";` with the
comment `/** A1 (25d Q1) and E18 (25e Q11): 1.1 adds the change routes and GET /v1/admin/changes. */`.

- [ ] **Step 4: Move the constants the existing tests expect (additive, SC-008)**
  - `tests/contract/admin-read-contracts.test.ts`: `expect(ADMIN_API_VERSION).toBe("1.0")` becomes `"1.1"`.
  - `tests/contract/developer-identity-admin-invokes.test.ts` and
    `tests/contract/developer-identity-server.test.ts`: `adminApiVersion: "1.0"` becomes `"1.1"`.
  - `tests/contract/developer-task-contracts.test.ts`: append `["CONFIRMATION_UNAVAILABLE", 409]`,
    `["CONFIRMATION_DECLINED", 409]`, `["CONFIRMATION_EXPIRED", 409]`, `["CHANGE_STALE", 409]` to
    the list of codes and statuses.

  Each is an expected constant moving with Q11 or a list gaining entries; nothing is loosened.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/contract/admin-change-contracts.test.ts tests/contract/admin-read-contracts.test.ts tests/contract/developer-task-contracts.test.ts tests/contract/developer-identity-admin-invokes.test.ts tests/contract/developer-identity-server.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src tests/contract/admin-change-contracts.test.ts tests/contract/admin-read-contracts.test.ts tests/contract/developer-task-contracts.test.ts tests/contract/developer-identity-admin-invokes.test.ts tests/contract/developer-identity-server.test.ts
git commit -m "feat(contracts): admin change requests, audit records, confirmation codes and admin API 1.1 (spec 025 phase 25e)"
```

---

### Task 2: The audit record, its step logs and the outcome metric

E3, FR-051, FR-052's logs and metric. Pure storage: Task 7 decides when each step happens.

**Files:**
- Create: `packages/broker/src/aws/admin-change-audit.ts`
- Test: `tests/contract/admin-change-audit.test.ts`

**Interfaces:**
- Consumes: `AdminChangeAuditRecord`, `AdminChangeAuditRecordSchema`, `adminChangeAuditKeys`,
  `ADMIN_CHANGES_PARTITION`, `ADMIN_CHANGE_REFUSED_ATTEMPTS_MAX`, `ADMIN_LIST_MAX`,
  `outcomeOfStatus`, `redactSecrets` (contracts).
- Produces:
  - `export interface AuditStore { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string; now(): number; log(entry: Record<string, unknown>): void; metric(outcome: AdminChangeOutcome): void }`;
  - `export function proposalItem(tableName: string, record: AdminChangeAuditRecord): { Put: Record<string, unknown> }`
    and `export function auditStepItem(tableName: string, changeId: string, step: AuditStep): { Update: Record<string, unknown> }`,
    the same writes as transaction items, so Task 7 commits a change's own state and its audit step
    in one transaction (an audit write can never fail silently after a change applied);
    `export type AuditStep = Partial<Pick<AdminChangeAuditRecord, "status" | "confirmationRequestedAt" | "answeredAt" | "appliedAt" | "failedAt" | "expiredAt" | "methodUsed" | "pressedBy" | "result" | "error">>`;
  - `export async function writeProposal(store: AuditStore, record: AdminChangeAuditRecord): Promise<void>`;
  - `export async function recordAuditStep(store: AuditStore, changeId: string, proposedAt: string, step: AuditStep): Promise<void>`
    (sets `outcome` from `status`; once an outcome is set, a later step never changes it; emits
    the metric the first time an outcome is set);
  - `export async function recordRefusedAttempt(store: AuditStore, changeId: string, attempt: { at: string; reason: RefusedAttemptReason; slackUserId?: string }): Promise<void>`;
  - `export async function readAudit(store: AuditStore, changeId: string): Promise<AdminChangeAuditRecord | undefined>`;
  - `export async function listAudit(store: AuditStore, query: { since: string; until?: string; admin?: string; outcome?: AdminChangeOutcome; limit: number; cursor?: string }): Promise<{ changes: AdminChangeAuditRecord[]; cursor?: string }>`;
  - `export function logChangeStep(log: (entry: Record<string, unknown>) => void, step: string, fields: { changeId: string; traceId: string; kind?: string; outcome?: string; error?: string }): void`
    (event `admin_change.<step>`);
  - `export function outcomeMetric(namespace: string): (outcome: AdminChangeOutcome) => void`
    (an EMF line: metric `AdminChangeOutcome`, dimension `Outcome`).

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/admin-change-audit.test.ts
// Spec 025 E3, FR-051, FR-052: one audit record per change request, written once and then only
// stepped forward; its outcome is set once and counted once.
import { describe, expect, it, vi } from "vitest";
import { listAudit, logChangeStep, outcomeMetric, readAudit, recordAuditStep, recordRefusedAttempt, writeProposal, type AuditStore } from "../../packages/broker/src/aws/admin-change-audit.js";
import type { AdminChangeAuditRecord } from "../../packages/contracts/src/index.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const CHANGE = "55555555-5555-4555-8555-555555555555";
const PROPOSED = "2026-10-02T09:00:00.000Z";
const PLANTED = `ghp_${"C".repeat(36)}`;
const record = (changeId = CHANGE, proposedAt = PROPOSED, extra: Partial<AdminChangeAuditRecord> = {}): AdminChangeAuditRecord => ({
  changeId, kind: "bind_channel", traceId: "trace-1", status: "pending",
  admin: { issuer: "https://identity.example.test", subject: "admin-subject", displayName: "Ada" }, client: { cliVersion: "0.0.7", mcpClientName: "claude-code", mcpClientVersion: "2.1.0" },
  change: { kind: "bind_channel", channel: "C0123456789", project: "ledger" }, effect: "Bind channel C0123456789 to project ledger.",
  methodsOffered: ["elicitation"], proposedAt, ...extra,
});

function store(): AuditStore & { db: FakeDynamoDb; metrics: string[]; logs: Array<Record<string, unknown>> } {
  const db = new FakeDynamoDb();
  const metrics: string[] = [];
  const logs: Array<Record<string, unknown>> = [];
  return { db, metrics, logs, documentClient: db, tableName: "turns", now: () => Date.parse("2026-10-02T09:05:00.000Z"), log: (entry) => logs.push(entry), metric: (outcome) => metrics.push(outcome) };
}

describe("the audit record (E3)", () => {
  it("is written once, keyed for the CHANGES export, and redacted", async () => {
    const audit = store();
    await writeProposal(audit, record(CHANGE, PROPOSED, { change: { kind: "register_credential", ref: "linear", note: PLANTED } as never }));
    const stored = audit.db.get(`CHANGE#${CHANGE}`, "AUDIT")!;
    expect(stored).toMatchObject({ exportPk: "CHANGES", exportSk: `${PROPOSED}#${CHANGE}`, status: "pending" });
    expect(JSON.stringify(stored)).not.toContain(PLANTED);
    await expect(writeProposal(audit, record())).rejects.toThrow();
  });

  it("steps forward, sets the outcome once, and counts it once", async () => {
    const audit = store();
    await writeProposal(audit, record());
    await recordAuditStep(audit, CHANGE, PROPOSED, { confirmationRequestedAt: "2026-10-02T09:00:01.000Z" });
    await recordAuditStep(audit, CHANGE, PROPOSED, { status: "applied", methodUsed: "elicitation", answeredAt: "2026-10-02T09:01:00.000Z", appliedAt: "2026-10-02T09:01:00.500Z", result: { ok: true } });
    await recordAuditStep(audit, CHANGE, PROPOSED, { status: "failed", failedAt: "2026-10-02T09:02:00.000Z" });
    expect(await readAudit(audit, CHANGE)).toMatchObject({ status: "applied", outcome: "confirmed", methodUsed: "elicitation", confirmationRequestedAt: "2026-10-02T09:00:01.000Z" });
    expect(audit.metrics).toEqual(["confirmed"]);
  });

  it("keeps at most 20 refused attempts", async () => {
    const audit = store();
    await writeProposal(audit, record());
    for (let n = 0; n < 25; n += 1) await recordRefusedAttempt(audit, CHANGE, { at: "2026-10-02T09:00:30.000Z", reason: "another_person", slackUserId: "U0BOB00002" });
    expect((await readAudit(audit, CHANGE))?.refusedAttempts).toHaveLength(20);
  });

  it("lists newest first, filters by admin and outcome, and pages with a cursor", async () => {
    const audit = store();
    for (let n = 0; n < 3; n += 1) await writeProposal(audit, record(`5555555${n}-5555-4555-8555-555555555555`, `2026-10-02T09:0${n}:00.000Z`));
    await recordAuditStep(audit, "55555551-5555-4555-8555-555555555555", "2026-10-02T09:01:00.000Z", { status: "declined", answeredAt: "2026-10-02T09:01:30.000Z" });
    const first = await listAudit(audit, { since: "2026-10-01T00:00:00.000Z", limit: 2 });
    expect(first.changes.map((change) => change.proposedAt)).toEqual(["2026-10-02T09:02:00.000Z", "2026-10-02T09:01:00.000Z"]);
    const rest = await listAudit(audit, { since: "2026-10-01T00:00:00.000Z", limit: 2, cursor: first.cursor! });
    expect(rest.changes.map((change) => change.proposedAt)).toEqual(["2026-10-02T09:00:00.000Z"]);
    expect((await listAudit(audit, { since: "2026-10-01T00:00:00.000Z", limit: 10, outcome: "declined" })).changes).toHaveLength(1);
    expect((await listAudit(audit, { since: "2026-10-01T00:00:00.000Z", limit: 10, admin: "someone-else" })).changes).toHaveLength(0);
    await expect(listAudit(audit, { since: "2026-10-01T00:00:00.000Z", limit: 2, cursor: "bm90LWEta2V5" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("logs one line per step with the change and trace IDs, and writes an EMF metric per outcome", () => {
    const log = vi.fn();
    logChangeStep(log, "applied", { changeId: CHANGE, traceId: "trace-1", kind: "bind_channel", outcome: "confirmed" });
    expect(log).toHaveBeenCalledWith({ event: "admin_change.applied", changeId: CHANGE, traceId: "trace-1", kind: "bind_channel", outcome: "confirmed" });
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: string) => { lines.push(line); });
    outcomeMetric("AgentX/live25e")("declined");
    spy.mockRestore();
    expect(JSON.parse(lines[0]!)).toMatchObject({ _aws: { CloudWatchMetrics: [{ Namespace: "AgentX/live25e", Dimensions: [["Outcome"]], Metrics: [{ Name: "AdminChangeOutcome", Unit: "Count" }] }] }, Outcome: "declined", AdminChangeOutcome: 1 });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/contract/admin-change-audit.test.ts`
Expected: FAIL: `admin-change-audit.js` does not exist.

- [ ] **Step 3: Write the store**

```ts
// packages/broker/src/aws/admin-change-audit.ts
// Spec 025 E3, FR-051, FR-052: the audit record of each admin change request, in the TurnRecords
// table (30 days by TTL), under its own export partition. Written once, then only stepped forward:
// the outcome, once set, never changes, and no route writes this record. Log lines carry IDs only.
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  ADMIN_CHANGES_PARTITION, ADMIN_CHANGE_REFUSED_ATTEMPTS_MAX, AdminChangeAuditRecordSchema, adminChangeAuditKeys, agentXError, outcomeOfStatus, redactSecrets,
  type AdminChangeAuditRecord, type AdminChangeOutcome, type RefusedAttemptReason,
} from "@agentx/contracts";

export interface AuditStore {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  now(): number;
  log(entry: Record<string, unknown>): void;
  metric(outcome: AdminChangeOutcome): void;
}
const STORAGE_KEYS = new Set(["pk", "sk", "exportPk", "exportSk", "expiresAt", "entityType"]);
const CURSOR_INVALID = "cursor is invalid; start again without it";

export type AuditStep = Partial<Pick<AdminChangeAuditRecord, "status" | "confirmationRequestedAt" | "answeredAt" | "appliedAt" | "failedAt" | "expiredAt" | "methodUsed" | "pressedBy" | "result" | "error">>;

/** The proposal's put, for a transaction; the proposed change holds no secret value (FR-051). */
export function proposalItem(tableName: string, record: AdminChangeAuditRecord): { Put: Record<string, unknown> } {
  const safe = AdminChangeAuditRecordSchema.parse({ ...record, change: redactSecrets(record.change) as Record<string, unknown>, ...(record.result === undefined ? {} : { result: redactSecrets(record.result) as Record<string, unknown> }) });
  return { Put: { TableName: tableName, Item: { ...adminChangeAuditKeys(safe.changeId, safe.proposedAt), entityType: "ADMIN_CHANGE_AUDIT", ...safe }, ConditionExpression: "attribute_not_exists(pk)" } };
}

/** One step forward, for a transaction: never once an outcome is set, and only on an existing record. */
export function auditStepItem(tableName: string, changeId: string, step: AuditStep): { Update: Record<string, unknown> } {
  const outcome = step.status === undefined ? undefined : outcomeOfStatus(step.status);
  const fields: Record<string, unknown> = { ...step, ...(step.result === undefined ? {} : { result: redactSecrets(step.result) }), ...(outcome === undefined ? {} : { outcome }) };
  const names: Record<string, string> = { "#outcome": "outcome" };
  const values: Record<string, unknown> = {};
  const sets = Object.entries(fields).filter(([, value]) => value !== undefined).map(([name, value], index) => {
    names[`#f${index}`] = name;
    values[`:v${index}`] = value;
    return `#f${index} = :v${index}`;
  });
  return { Update: {
    TableName: tableName,
    Key: { pk: `CHANGE#${changeId}`, sk: "AUDIT" },
    UpdateExpression: `SET ${sets.join(", ")}`,
    ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(#outcome)",
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  } };
}

export async function writeProposal(store: AuditStore, record: AdminChangeAuditRecord): Promise<void> {
  await store.documentClient.send(new PutCommand(proposalItem(store.tableName, record).Put as never));
  const outcome = outcomeOfStatus(record.status);
  if (outcome !== undefined) store.metric(outcome);
}

export async function recordAuditStep(store: AuditStore, changeId: string, proposedAt: string, step: AuditStep): Promise<void> {
  if (Object.values(step).every((value) => value === undefined)) return;
  try {
    await store.documentClient.send(new UpdateCommand(auditStepItem(store.tableName, changeId, step).Update as never));
  } catch (error) {
    if (error instanceof Error && error.name === "ConditionalCheckFailedException") {
      store.log({ event: "admin_change.audit_step_ignored", changeId, proposedAt });
      return;
    }
    throw error;
  }
  const outcome = step.status === undefined ? undefined : outcomeOfStatus(step.status);
  if (outcome !== undefined) store.metric(outcome);
}

export async function recordRefusedAttempt(store: AuditStore, changeId: string, attempt: { at: string; reason: RefusedAttemptReason; slackUserId?: string }): Promise<void> {
  const current = await readAudit(store, changeId);
  if (current === undefined || (current.refusedAttempts?.length ?? 0) >= ADMIN_CHANGE_REFUSED_ATTEMPTS_MAX) return;
  await store.documentClient.send(new UpdateCommand({
    TableName: store.tableName,
    Key: { pk: `CHANGE#${changeId}`, sk: "AUDIT" },
    UpdateExpression: "SET refusedAttempts = list_append(if_not_exists(refusedAttempts, :empty), :attempt)",
    ConditionExpression: "attribute_exists(pk)",
    ExpressionAttributeValues: { ":empty": [], ":attempt": [attempt] },
  }));
}

function parse(item: Record<string, unknown> | undefined): AdminChangeAuditRecord | undefined {
  if (item === undefined) return undefined;
  const parsed = AdminChangeAuditRecordSchema.safeParse(Object.fromEntries(Object.entries(item).filter(([key]) => !STORAGE_KEYS.has(key))));
  return parsed.success ? parsed.data : undefined;
}

export async function readAudit(store: AuditStore, changeId: string): Promise<AdminChangeAuditRecord | undefined> {
  const response = await store.documentClient.send(new GetCommand({ TableName: store.tableName, Key: { pk: `CHANGE#${changeId}`, sk: "AUDIT" }, ConsistentRead: true })) as { Item?: Record<string, unknown> };
  return parse(response.Item);
}

const encode = (key: Record<string, unknown>) => Buffer.from(JSON.stringify(key)).toString("base64url");
function decode(cursor: string): Record<string, unknown> {
  try {
    const key = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
    // Only a key from this partition's own pages, as the turn export does.
    if (key.exportPk !== ADMIN_CHANGES_PARTITION || typeof key.pk !== "string" || !key.pk.startsWith("CHANGE#") || key.sk !== "AUDIT" || typeof key.exportSk !== "string") throw new Error("bad");
    return key;
  } catch {
    throw agentXError("CONFIG_INVALID", CURSOR_INVALID);
  }
}

export async function listAudit(store: AuditStore, query: { since: string; until?: string; admin?: string; outcome?: AdminChangeOutcome; limit: number; cursor?: string }): Promise<{ changes: AdminChangeAuditRecord[]; cursor?: string }> {
  const changes: AdminChangeAuditRecord[] = [];
  let start = query.cursor === undefined ? undefined : decode(query.cursor);
  let last: Record<string, unknown> | undefined;
  for (let reads = 0; reads < 10 && changes.length < query.limit; reads += 1) {
    const filters = [...(query.admin === undefined ? [] : ["admin.subject = :admin"]), ...(query.outcome === undefined ? [] : ["outcome = :outcome"])];
    const page = await store.documentClient.send(new QueryCommand({
      TableName: store.tableName,
      IndexName: "byTime",
      KeyConditionExpression: query.until === undefined ? "exportPk = :partition AND exportSk >= :since" : "exportPk = :partition AND exportSk BETWEEN :since AND :until",
      ExpressionAttributeValues: {
        ":partition": ADMIN_CHANGES_PARTITION, ":since": query.since,
        ...(query.until === undefined ? {} : { ":until": `${query.until}\uffff` }),
        ...(query.admin === undefined ? {} : { ":admin": query.admin }),
        ...(query.outcome === undefined ? {} : { ":outcome": query.outcome }),
      },
      ...(filters.length === 0 ? {} : { FilterExpression: filters.join(" AND ") }),
      ScanIndexForward: false,
      Limit: query.limit,
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of page.Items ?? []) {
      const record = parse(item);
      if (record === undefined) { store.log({ event: "admin_change.audit_unreadable" }); continue; }
      if (changes.length < query.limit) { changes.push(record); last = { pk: item.pk, sk: item.sk, exportPk: item.exportPk, exportSk: item.exportSk }; }
    }
    start = page.LastEvaluatedKey;
    if (start === undefined) break;
  }
  // More remain when the index still had pages, or this page filled the limit.
  const more = start !== undefined || (changes.length === query.limit && last !== undefined);
  return { changes, ...(more && last !== undefined ? { cursor: encode(last) } : {}) };
}

export function logChangeStep(log: (entry: Record<string, unknown>) => void, step: string, fields: { changeId: string; traceId: string; kind?: string; outcome?: string; error?: string }): void {
  log({ event: `admin_change.${step}`, ...fields });
}

export function outcomeMetric(namespace: string): (outcome: AdminChangeOutcome) => void {
  return (outcome) => console.log(JSON.stringify({
    _aws: { Timestamp: Date.now(), CloudWatchMetrics: [{ Namespace: namespace, Dimensions: [["Outcome"]], Metrics: [{ Name: "AdminChangeOutcome", Unit: "Count" }] }] },
    component: "broker", event: "metric", Outcome: outcome, AdminChangeOutcome: 1,
  }));
}
```

`admin.subject` in the filter is a nested path, which DynamoDB and `FakeDynamoDb`'s condition
parser both resolve.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/contract/admin-change-audit.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/broker/src/aws/admin-change-audit.ts tests/contract/admin-change-audit.test.ts
git commit -m "feat(broker): the admin change audit record, its step logs and the outcome metric (spec 025 phase 25e)"
```

---
### Task 3: DeveloperIdentity: the email index, ending a developer's sessions, a channel by name

E8, E9, E12's DeveloperIdentity side, and the broker's refusal of sessions an admin ended.
**Depends on Q3** (end sessions, not ban), **Q4** (email only after sign-in) and **Q8** (names).

**Files:**
- Modify: `packages/contracts/src/developer.ts` (two invoke requests)
- Modify: `packages/broker/src/developer/store.ts` (the email index; `sessionsEndedAt`; `endSessions`)
- Modify: `packages/broker/src/developer/server.ts` (two invoke kinds; the refresh check)
- Modify: `packages/broker/src/developer/slack-directory.ts` (`channelByName`)
- Modify: `packages/broker/src/aws/developer-identity.ts` (the handler's event type)
- Modify: `packages/broker/src/aws/developer-routes.ts` (the per-request check; two helpers; two
  configuration fields)
- Modify: `packages/broker/src/aws/broker.ts` (`developerConfiguration()` wires the helpers)
- Test: `tests/contract/developer-identity-admin-changes.test.ts`

**Interfaces:**
- Consumes: 25a's store, server and directory; 25d's `identityInvoke` widening (developer-routes.ts).
- Produces:
  - contracts: `EndDeveloperSessionsRequestSchema` (`{ kind: "end-developer-sessions", developerId, at }`),
    `EndDeveloperSessionsResponse` (`{ ok: true } | { ok: false; error: "not_found" | "invalid_request" | "unavailable" }`),
    `ChannelByNameRequestSchema` (`{ kind: "channel-by-name", name }`, a Slack channel name),
    `ChannelByNameResponse` (`{ ok: true; channel?: { channelId: string; name: string } } | { ok: false; error: "slack_unavailable" | "invalid_request" }`);
  - store: `export function emailIndexKey(email: string): { pk: string; sk: "META" }` (the SHA-256 of
    the trimmed, lowercased email); `DeveloperRecord.sessionsEndedAt?: string`;
    `DeveloperSignInStore.endSessions(developerId: string, at: string): Promise<"ended" | "not_found">`;
  - directory: `SlackDirectory.channelByName(name: string): Promise<ChannelByNameResponse>`;
  - broker: `endDeveloperSessionsThroughLambda(invoke)`, `channelByNameThroughLambda(invoke)`;
    `DeveloperApiConfiguration.endDeveloperSessions?` and `.channelByName?`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/developer-identity-admin-changes.test.ts
// Spec 025 E8, E9, E12: the email index, an admin ending a developer's sessions, a channel by name.
import { describe, expect, it } from "vitest";
import { emailIndexKey } from "../../packages/broker/src/developer/store.js";
import { createDeveloperTaskBroker, MAYA } from "../support/developer-task-broker.js";
import { TEAM, identityHarness } from "../support/developer-fakes.js";

describe("the email index (E8, Q4)", () => {
  it("is written at each sign-in with a verified email, keyed by the email's hash, never the email", async () => {
    const harness = identityHarness({ slackUsers: [{ userId: "U0ADA00001", teamId: TEAM, name: "Ada", email: "Ada@Example.com", emailVerified: true }] });
    await harness.signIn("slack", "U0ADA00001");
    const key = emailIndexKey(" ada@example.com ");
    const item = harness.db.get(key.pk, key.sk);
    expect(item).toMatchObject({ entityType: "DEVELOPER_EMAIL", developerId: expect.stringMatching(/^[a-f0-9]{64}$/) as unknown });
    expect(JSON.stringify(item)).not.toContain("example.com");
  });
});

describe("ending a developer's sessions (E9, Q3)", () => {
  it("ends every session that started before, and still lets them sign in again", async () => {
    const harness = identityHarness({ slackUsers: [{ userId: "U0ADA00001", teamId: TEAM, name: "Ada" }] });
    const callback = await harness.signIn("slack", "U0ADA00001");
    const tokens = await harness.exchange(callback.searchParams.get("code")!);
    const developerId = String(harness.db.find((item) => item.entityType === "DEVELOPER")[0]?.developerId);
    harness.tick(1_000);
    expect(await harness.handler({ kind: "end-developer-sessions", developerId, at: new Date(harness.now()).toISOString() } as never)).toEqual({ ok: true });
    const refresh = await harness.refresh(String(tokens.body.refresh_token));
    expect(refresh).toMatchObject({ status: 400, body: { error: "invalid_grant", error_description: "an AgentX admin ended your sign-in; sign in again with agentx login" } });
    harness.tick(1_000);
    const again = await harness.signIn("slack", "U0ADA00001");
    expect((await harness.exchange(again.searchParams.get("code")!)).status).toBe(200);
  });

  it("answers not_found for a developer who never signed in", async () => {
    const harness = identityHarness({});
    expect(await harness.handler({ kind: "end-developer-sessions", developerId: "f".repeat(64), at: new Date().toISOString() } as never)).toEqual({ ok: false, error: "not_found" });
  });

  it("makes the broker refuse a session that started before the end, at once (D16)", async () => {
    const harness = await createDeveloperTaskBroker();
    expect((await harness.dev(MAYA, "GET", "/v1/dev/projects")).status).toBe(200);
    const developer = harness.db.get(`DEVELOPER#${MAYA.developerId}`, "META")!;
    harness.db.set({ ...developer, sessionsEndedAt: new Date(Date.now() + 1_000).toISOString() });
    expect((await harness.dev(MAYA, "GET", "/v1/dev/projects")).body.error).toEqual({ code: "AUTH_REQUIRED", message: "an AgentX admin ended your sign-in; run agentx login <url> again" });
  });
});

describe("a channel by name (E12, Q8)", () => {
  it("finds a public channel by name, with or without #, and nothing for an unknown one", async () => {
    const harness = identityHarness({ channelInfo: { C0LEDGER001: { name: "ledger-dev" }, C0SECRET001: { name: "secret-launch", isPrivate: true } } });
    expect(await harness.handler({ kind: "channel-by-name", name: "ledger-dev" } as never)).toEqual({ ok: true, channel: { channelId: "C0LEDGER001", name: "ledger-dev" } });
    expect(await harness.handler({ kind: "channel-by-name", name: "secret-launch" } as never)).toEqual({ ok: true });
    expect(await harness.handler({ kind: "channel-by-name", name: "nope" } as never)).toEqual({ ok: true });
    expect(await harness.handler({ kind: "channel-by-name", name: "Not A Name!" } as never)).toEqual({ ok: false, error: "invalid_request" });
  });
});
```

`fakeSlack` (`tests/support/developer-fakes.ts`) answers `conversations.info` from its
`channelInfo` option; add, beside it, a `conversations.list` answer built from the same option,
for `BOT_TOKEN` only (it sits after the bearer check):

```ts
    if (url.pathname === "/api/conversations.list") {
      const channels = Object.entries(options.channelInfo ?? {}).map(([id, info]) => ({ id, name: info.name, is_private: info.isPrivate === true }));
      return Response.json({ ok: true, channels, response_metadata: { next_cursor: "" } });
    }
```

Slack sign-in's email comes from the ID token, which `fakeSlack` already signs with `email` and
`email_verified` from the user entry.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/contract/developer-identity-admin-changes.test.ts`
Expected: FAIL: `emailIndexKey` is not exported, the invoke kinds are refused, and the broker
accepts the ended session.

- [ ] **Step 3: The contracts**

In `packages/contracts/src/developer.ts`, after 25d's `SlackAuthCheckResponse`:

```ts
/** Spec 025 E9 (Q3): an admin ends every sign-in session a developer has; they may sign in again. */
export const EndDeveloperSessionsRequestSchema = z.object({ kind: z.literal("end-developer-sessions"), developerId: z.string().regex(/^[a-f0-9]{64}$/), at: z.string().datetime() }).strict();
export type EndDeveloperSessionsRequest = z.infer<typeof EndDeveloperSessionsRequestSchema>;
export type EndDeveloperSessionsResponse = { ok: true } | { ok: false; error: "not_found" | "invalid_request" | "unavailable" };

/** Spec 025 E12 (Q8): a public channel of the environment's team, by its name. */
export const ChannelByNameRequestSchema = z.object({ kind: z.literal("channel-by-name"), name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/) }).strict();
export type ChannelByNameRequest = z.infer<typeof ChannelByNameRequestSchema>;
export type ChannelByNameResponse = { ok: true; channel?: { channelId: string; name: string } } | { ok: false; error: "slack_unavailable" | "invalid_request" };
```

- [ ] **Step 4: The store**

In `packages/broker/src/developer/store.ts`:
- add `sessionsEndedAt?: string` to `DeveloperRecord`;
- add, beside `META`:

```ts
/** E8: the email index's key, the SHA-256 of the trimmed, lowercased email, so no email is stored as a key. */
export function emailIndexKey(email: string): { pk: string; sk: "META" } {
  return { pk: `EMAIL#${sha256Hex(email.trim().toLowerCase())}`, sk: META };
}
```

- at the end of `upsertDeveloper`, before reading the record back, when `profile.email` is set:

```ts
    if (profile.email !== undefined) {
      // E8 (Q4): the latest sign-in with this verified email wins; the email itself is not stored here.
      await this.put({ ...emailIndexKey(profile.email), entityType: "DEVELOPER_EMAIL", developerId: profile.developerId, updatedAt: at });
    }
```

- add:

```ts
  /** E9 (Q3): sessions that started before `at` end; `revoked` is untouched, so they may sign in again. */
  async endSessions(developerId: string, at: string): Promise<"ended" | "not_found"> {
    try {
      await this.input.documentClient.send(new UpdateCommand({
        TableName: this.input.tableName,
        Key: { pk: `DEVELOPER#${developerId}`, sk: META },
        UpdateExpression: "SET sessionsEndedAt = :at",
        ConditionExpression: "attribute_exists(pk)",
        ExpressionAttributeValues: { ":at": at },
      }));
      return "ended";
    } catch (error) {
      if (conditionFailed(error)) return "not_found";
      throw error;
    }
  }
```

  `upsertDeveloper`'s update never names `sessionsEndedAt`, so a later sign-in keeps it; the new
  session starts after it and passes.

- [ ] **Step 5: The server and the directory**

In `packages/broker/src/developer/server.ts`:
- in the `if ("kind" in event)` block, before 25d's branches:

```ts
      if (event.kind === "end-developer-sessions") {
        const parsed = EndDeveloperSessionsRequestSchema.safeParse(event);
        if (!parsed.success) return { ok: false, error: "invalid_request" };
        const result = await store.endSessions(parsed.data.developerId, parsed.data.at);
        deps.log({ event: "signin.sessions_ended_by_admin", developerId: parsed.data.developerId, result });
        return result === "ended" ? { ok: true } : { ok: false, error: "not_found" };
      }
      if (event.kind === "channel-by-name") {
        const parsed = ChannelByNameRequestSchema.safeParse(event);
        if (!parsed.success) return { ok: false, error: "invalid_request" };
        return deps.directory.channelByName(parsed.data.name);
      }
```

- in `refreshTokenGrant`, right after the `developer === undefined || developer.revoked` check:

```ts
    if (developer.sessionsEndedAt !== undefined && Date.parse(session.startedAt) < Date.parse(developer.sessionsEndedAt)) {
      await revoke(session.sessionId, "ended_by_admin");
      return oauthError(400, "invalid_grant", "an AgentX admin ended your sign-in; sign in again with agentx login");
    }
```

- widen the handler's event and result types (and `developer-identity.ts`'s) with the two
  requests and responses.

In `slack-directory.ts`, add to the interface and the returned object:

```ts
    async channelByName(name) {
      if (input.teamId === undefined) return { ok: false, error: "slack_unavailable" };
      let cursor = "";
      // E12: public channels only, at most 10 pages of 200; a private channel is given by ID.
      for (let page = 0; page < 10; page += 1) {
        const reply = await get("conversations.list", { types: "public_channel", exclude_archived: "true", limit: "200", ...(cursor === "" ? {} : { cursor }) });
        if (reply === undefined) return { ok: false, error: "slack_unavailable" };
        if (reply.body.ok !== true || !Array.isArray(reply.body.channels)) { refused("conversations.list", reply); return { ok: false, error: "slack_unavailable" }; }
        for (const channel of reply.body.channels as Array<{ id?: unknown; name?: unknown; is_private?: unknown }>) {
          if (channel.name === name && typeof channel.id === "string" && channel.is_private !== true) return { ok: true, channel: { channelId: channel.id, name } };
        }
        const next = (reply.body.response_metadata as { next_cursor?: unknown } | undefined)?.next_cursor;
        cursor = typeof next === "string" ? next : "";
        if (cursor === "") break;
      }
      return { ok: true };
    },
```

- [ ] **Step 6: The broker**

In `packages/broker/src/aws/developer-routes.ts`:
- in `authenticateDeveloper`, read `sessionsEndedAt` with the developer record (widen the `Pick`
  to include it) and, after the `revoked` check:

```ts
  if (developer.sessionsEndedAt !== undefined && Date.parse(session.startedAt) < Date.parse(developer.sessionsEndedAt)) {
    // E9: D16's per-request check ends the session at once; the token endpoint revokes it at its next refresh.
    throw agentXError("AUTH_REQUIRED", "an AgentX admin ended your sign-in; run agentx login <url> again");
  }
```

  (widen `session`'s `Pick` with `startedAt`, which it already has);
- add the helpers, on `identityInvoke`:

```ts
export function endDeveloperSessionsThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: EndDeveloperSessionsRequest) => Promise<EndDeveloperSessionsResponse> {
  return async (request) => {
    let notFound = false;
    const answer = await identityInvoke(invoke, request, (reply) => {
      if (reply.ok === true) return { ok: true as const };
      if (reply.ok === false && reply.error === "not_found") notFound = true;
      return undefined;
    }, "developer.end_sessions");
    if (answer.ok) return answer;
    return { ok: false, error: notFound ? "not_found" : answer.error === "invalid_request" ? "invalid_request" : "unavailable" };
  };
}

export function channelByNameThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: ChannelByNameRequest) => Promise<ChannelByNameResponse> {
  return (request) => identityInvoke(invoke, request, (reply) => {
    if (reply.ok !== true) return undefined;
    const channel = reply.channel as { channelId?: unknown; name?: unknown } | undefined;
    return typeof channel?.channelId === "string" && typeof channel.name === "string" ? { ok: true as const, channel: { channelId: channel.channelId, name: channel.name } } : { ok: true as const };
  }, "developer.channel_by_name");
}
```

  (widen `identityInvoke`'s `request` union with the two new requests);
- add `endDeveloperSessions?` and `channelByName?` with those types to `DeveloperApiConfiguration`,
  and wire both in `developerConfiguration()` (broker.ts) on the same `InvokeCommand` as
  `channelMembers`.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run tests/contract/developer-identity-admin-changes.test.ts tests/contract/developer-identity-server.test.ts tests/contract/developer-signin*.test.ts tests/contract/developer-routes*.test.ts && npm run typecheck`
Expected: PASS; 25a's sign-in and refresh tests are unchanged.

- [ ] **Step 8: Commit**

```bash
git add packages/contracts/src/developer.ts packages/broker/src/developer packages/broker/src/aws/developer-identity.ts packages/broker/src/aws/developer-routes.ts packages/broker/src/aws/broker.ts tests/support/developer-fakes.ts tests/contract/developer-identity-admin-changes.test.ts
git commit -m "feat(broker): the developer email index, admin-ended sessions and channels by name (spec 025 phase 25e)"
```

---

### Task 4: The new admin actions: grant, revoke, limits, and who a developer is

E8, E9, E19. These are the handlers the change tools apply that no `agentx admin` command had:
there is no way today for an admin to grant a developer direct project access (FR-013.1), and the
limits setting has no writer (FR-053). **Depends on Q4** and **Q7**.

**Files:**
- Create: `packages/broker/src/aws/admin-actions.ts`
- Test: `tests/contract/admin-actions.test.ts`

**Interfaces:**
- Consumes: `emailIndexKey` (Task 3); `readWorkspaceLimits`, `WORKSPACE_LIMITS_KEY`
  (`packages/broker/src/developer/limits.ts`); `ownerKeyForSubject` (`./lambda.js`);
  `SLACK_OIDC_ISSUER`, `SlackUserIdSchema`, `agentXError` (contracts).
- Produces:
  - `export interface AdminActionDependencies { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string; signInTableName?: string; slackTeamId?: string; limitDefaults: { member: number; organization: number }; endDeveloperSessions?: (request: EndDeveloperSessionsRequest) => Promise<EndDeveloperSessionsResponse>; now(): number }`;
  - `export interface ResolvedDeveloper { developerId: string; via: "id" | "slack" | "email"; slackUserId?: string; profile?: { displayName: string; provider: "slack" | "oidc"; slackUserId?: string; sessionsEndedAt?: string } }`;
  - `export function developerIdForSlackUser(userId: string): string`;
  - `export async function resolveDeveloper(deps, reference: string): Promise<ResolvedDeveloper>`;
  - `export async function projectGrant(deps, project: string, developerId: string): Promise<{ role: "developer" | "administrator" } | undefined>`;
  - `export async function grantProjectAccess(deps, admin: { issuer: string; subject: string }, project: string, developerId: string): Promise<{ granted: true; already: boolean }>`;
  - `export async function revokeProjectAccess(deps, project: string, developerId: string): Promise<{ revoked: boolean }>`;
  - `export async function setWorkspaceLimits(deps, admin: { issuer: string; subject: string }, limits: { perPerson: number; perOrganization: number }): Promise<{ perPerson: number; perOrganization: number; updatedAt: string }>`;
  - `export async function endSessions(deps, developerId: string): Promise<{ endedAt: string }>`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/admin-actions.test.ts
// Spec 025 E8, E9, E19: the handlers 25e's change tools apply that had no admin command before.
import { describe, expect, it, vi } from "vitest";
import { developerIdForSlackUser, endSessions, grantProjectAccess, projectGrant, resolveDeveloper, revokeProjectAccess, setWorkspaceLimits, type AdminActionDependencies } from "../../packages/broker/src/aws/admin-actions.js";
import { readWorkspaceLimits } from "../../packages/broker/src/developer/limits.js";
import { emailIndexKey } from "../../packages/broker/src/developer/store.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const ADMIN = { issuer: "https://identity.example.test", subject: "admin-subject" };
function deps(extra: Partial<AdminActionDependencies> = {}): AdminActionDependencies & { db: FakeDynamoDb } {
  const db = new FakeDynamoDb();
  return { db, documentClient: db, tableName: "state", signInTableName: "signin", slackTeamId: "T0BSHLLUGBD", limitDefaults: { member: 3, organization: 20 }, now: () => Date.parse("2026-10-02T09:00:00.000Z"), ...extra };
}

describe("who a developer is (E8, Q4)", () => {
  it("takes a developer ID, a Slack user and an email that has signed in", async () => {
    const d = deps();
    const slackId = developerIdForSlackUser("U0ADA00001");
    expect(slackId).toMatch(/^[a-f0-9]{64}$/);
    d.db.set({ pk: `DEVELOPER#${slackId}`, sk: "META", developerId: slackId, provider: "slack", displayName: "Ada", slackUserId: "U0ADA00001", revoked: false });
    d.db.set({ ...emailIndexKey("ada@example.com"), developerId: slackId });
    expect(await resolveDeveloper(d, "U0ADA00001")).toMatchObject({ developerId: slackId, via: "slack", profile: { displayName: "Ada" } });
    expect(await resolveDeveloper(d, "Ada@Example.com")).toMatchObject({ developerId: slackId, via: "email" });
    expect(await resolveDeveloper(d, slackId)).toMatchObject({ developerId: slackId, via: "id" });
  });

  it("lets a Slack user be named before their first sign-in, but not an email", async () => {
    const d = deps();
    expect(await resolveDeveloper(d, "U0NEW00001")).toEqual({ developerId: developerIdForSlackUser("U0NEW00001"), via: "slack", slackUserId: "U0NEW00001" });
    await expect(resolveDeveloper(d, "new@example.com")).rejects.toMatchObject({ code: "NOT_FOUND", message: "nobody has signed in to AgentX with new@example.com yet; name them by Slack user ID, or ask them to sign in first" });
    await expect(resolveDeveloper(d, "not a person")).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});

describe("grants (FR-013.1)", () => {
  it("grants developer access once, keeps an administrator row as it is, and revokes only a developer row", async () => {
    const d = deps();
    const id = developerIdForSlackUser("U0ADA00001");
    expect(await grantProjectAccess(d, ADMIN, "payments", id)).toEqual({ granted: true, already: false });
    expect(d.db.get(`MEMBER#${id}`, "PROJECT#payments")).toMatchObject({ entityType: "MEMBERSHIP", ownerKey: id, projectName: "payments", role: "developer", grantedBy: ADMIN });
    expect(await grantProjectAccess(d, ADMIN, "payments", id)).toEqual({ granted: true, already: true });
    expect(await projectGrant(d, "payments", id)).toEqual({ role: "developer" });
    expect(await revokeProjectAccess(d, "payments", id)).toEqual({ revoked: true });
    expect(await revokeProjectAccess(d, "payments", id)).toEqual({ revoked: false });
    d.db.set({ pk: `MEMBER#${id}`, sk: "PROJECT#ledger", entityType: "MEMBERSHIP", ownerKey: id, projectName: "ledger", role: "administrator" });
    await expect(grantProjectAccess(d, ADMIN, "ledger", id)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(await revokeProjectAccess(d, "ledger", id)).toEqual({ revoked: false });
    expect(d.db.get(`MEMBER#${id}`, "PROJECT#ledger")).toMatchObject({ role: "administrator" });
  });
});

describe("the workspace limits setting (E19, FR-053)", () => {
  it("writes the setting the broker already reads, with who and when", async () => {
    const d = deps();
    expect(await setWorkspaceLimits(d, ADMIN, { perPerson: 5, perOrganization: 40 })).toEqual({ perPerson: 5, perOrganization: 40, updatedAt: "2026-10-02T09:00:00.000Z" });
    expect(d.db.get("SETTINGS", "WORKSPACE_LIMITS")).toMatchObject({ perPerson: 5, perOrganization: 40, updatedBy: ADMIN, updatedAt: "2026-10-02T09:00:00.000Z" });
    expect(await readWorkspaceLimits(d.db, "state", d.limitDefaults)).toEqual({ member: 5, organization: 40, source: "setting" });
    await expect(setWorkspaceLimits(d, ADMIN, { perPerson: 30, perOrganization: 20 })).rejects.toMatchObject({ code: "CONFIG_INVALID", message: "the per-person limit (30) cannot be more than the organization limit (20)" });
  });
});

describe("ending sessions (E9)", () => {
  it("asks DeveloperIdentity, and says when the developer never signed in or it cannot be reached", async () => {
    const endDeveloperSessions = vi.fn(async () => ({ ok: true as const }));
    expect(await endSessions(deps({ endDeveloperSessions }), "d".repeat(64))).toEqual({ endedAt: "2026-10-02T09:00:00.000Z" });
    expect(endDeveloperSessions).toHaveBeenCalledWith({ kind: "end-developer-sessions", developerId: "d".repeat(64), at: "2026-10-02T09:00:00.000Z" });
    await expect(endSessions(deps({ endDeveloperSessions: async () => ({ ok: false, error: "not_found" }) }), "d".repeat(64))).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(endSessions(deps({ endDeveloperSessions: async () => ({ ok: false, error: "unavailable" }) }), "d".repeat(64))).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    await expect(endSessions(deps(), "d".repeat(64))).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/contract/admin-actions.test.ts`
Expected: FAIL: `admin-actions.js` does not exist.

- [ ] **Step 3: Write the actions**

```ts
// packages/broker/src/aws/admin-actions.ts
// Spec 025 E8, E9, E19: the admin actions 25e's change tools apply that no admin command had. Each
// is called only by a confirmed change (Task 7) or by the CLI's own change path (Tasks 14, 15).
import { DeleteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { SLACK_OIDC_ISSUER, SlackUserIdSchema, agentXError, type EndDeveloperSessionsRequest, type EndDeveloperSessionsResponse } from "@agentx/contracts";
import { WORKSPACE_LIMITS_KEY } from "../developer/limits.js";
import { emailIndexKey } from "../developer/store.js";
import { ownerKeyForSubject } from "./lambda.js";

export interface AdminActionDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  /** The sign-in table; absent where developer sign-in is not set up. */
  signInTableName?: string;
  slackTeamId?: string;
  limitDefaults: { member: number; organization: number };
  endDeveloperSessions?: (request: EndDeveloperSessionsRequest) => Promise<EndDeveloperSessionsResponse>;
  now(): number;
}
export interface ResolvedDeveloper {
  developerId: string;
  via: "id" | "slack" | "email";
  slackUserId?: string;
  profile?: { displayName: string; provider: "slack" | "oidc"; slackUserId?: string; sessionsEndedAt?: string };
}

const HEX64 = /^[a-f0-9]{64}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;
const conditional = (error: unknown) => error instanceof Error && error.name === "ConditionalCheckFailedException";

/** FR-008: a Slack sign-in's developer ID, so a grant can come before the first sign-in (E8). */
export function developerIdForSlackUser(userId: string): string {
  return ownerKeyForSubject(SLACK_OIDC_ISSUER, userId);
}

async function signInItem(deps: AdminActionDependencies, key: { pk: string; sk: string }): Promise<Record<string, unknown> | undefined> {
  if (deps.signInTableName === undefined) return undefined;
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.signInTableName, Key: key, ConsistentRead: true })) as { Item?: Record<string, unknown> };
  return response.Item;
}

async function profileOf(deps: AdminActionDependencies, developerId: string): Promise<ResolvedDeveloper["profile"]> {
  const item = await signInItem(deps, { pk: `DEVELOPER#${developerId}`, sk: "META" });
  if (item === undefined || typeof item.displayName !== "string" || (item.provider !== "slack" && item.provider !== "oidc")) return undefined;
  return {
    displayName: item.displayName, provider: item.provider,
    ...(typeof item.slackUserId === "string" ? { slackUserId: item.slackUserId } : {}),
    ...(typeof item.sessionsEndedAt === "string" ? { sessionsEndedAt: item.sessionsEndedAt } : {}),
  };
}

export async function resolveDeveloper(deps: AdminActionDependencies, reference: string): Promise<ResolvedDeveloper> {
  const value = reference.trim();
  if (HEX64.test(value)) {
    const profile = await profileOf(deps, value);
    return { developerId: value, via: "id", ...(profile === undefined ? {} : { profile }) };
  }
  if (SlackUserIdSchema.safeParse(value).success) {
    const developerId = developerIdForSlackUser(value);
    const profile = await profileOf(deps, developerId);
    return { developerId, via: "slack", slackUserId: value, ...(profile === undefined ? {} : { profile }) };
  }
  if (EMAIL.test(value)) {
    const indexed = await signInItem(deps, emailIndexKey(value));
    // Q4: an email names only someone who signed in with it (from this release on).
    if (typeof indexed?.developerId !== "string") throw agentXError("NOT_FOUND", `nobody has signed in to AgentX with ${value} yet; name them by Slack user ID, or ask them to sign in first`);
    const profile = await profileOf(deps, indexed.developerId);
    return { developerId: indexed.developerId, via: "email", ...(profile === undefined ? {} : { profile }) };
  }
  throw agentXError("CONFIG_INVALID", "developer must be a developer ID, an email or a Slack user ID such as U0123456789");
}

export async function projectGrant(deps: AdminActionDependencies, project: string, developerId: string): Promise<{ role: "developer" | "administrator" } | undefined> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: { pk: `MEMBER#${developerId}`, sk: `PROJECT#${project}` }, ConsistentRead: true })) as { Item?: { role?: unknown } };
  const role = response.Item?.role;
  return role === "developer" || role === "administrator" ? { role } : undefined;
}

/** FR-013.1: a `developer` ProjectMembership row. An administrator row for the same key is kept as it is. */
export async function grantProjectAccess(deps: AdminActionDependencies, admin: { issuer: string; subject: string }, project: string, developerId: string): Promise<{ granted: true; already: boolean }> {
  const current = await projectGrant(deps, project, developerId);
  if (current?.role === "administrator") throw agentXError("CONFIG_INVALID", `that developer already administers ${project}`);
  if (current?.role === "developer") return { granted: true, already: true };
  try {
    await deps.documentClient.send(new PutCommand({
      TableName: deps.tableName,
      Item: { pk: `MEMBER#${developerId}`, sk: `PROJECT#${project}`, entityType: "MEMBERSHIP", ownerKey: developerId, projectName: project, role: "developer", grantedBy: admin, grantedAt: new Date(deps.now()).toISOString() },
      ConditionExpression: "attribute_not_exists(pk)",
    }));
  } catch (error) {
    if (!conditional(error)) throw error;
    return { granted: true, already: true };
  }
  return { granted: true, already: false };
}

export async function revokeProjectAccess(deps: AdminActionDependencies, project: string, developerId: string): Promise<{ revoked: boolean }> {
  try {
    await deps.documentClient.send(new DeleteCommand({
      TableName: deps.tableName,
      Key: { pk: `MEMBER#${developerId}`, sk: `PROJECT#${project}` },
      // Only a grant: an administrator row is never removed by revoking a developer's access.
      ConditionExpression: "#role = :developer",
      ExpressionAttributeNames: { "#role": "role" },
      ExpressionAttributeValues: { ":developer": "developer" },
    }));
    return { revoked: true };
  } catch (error) {
    if (conditional(error)) return { revoked: false };
    throw error;
  }
}

/** E19, FR-053: the setting the broker reads at each workspace creation. */
export async function setWorkspaceLimits(deps: AdminActionDependencies, admin: { issuer: string; subject: string }, limits: { perPerson: number; perOrganization: number }): Promise<{ perPerson: number; perOrganization: number; updatedAt: string }> {
  if (limits.perPerson > limits.perOrganization) throw agentXError("CONFIG_INVALID", `the per-person limit (${limits.perPerson}) cannot be more than the organization limit (${limits.perOrganization})`);
  const updatedAt = new Date(deps.now()).toISOString();
  await deps.documentClient.send(new PutCommand({
    TableName: deps.tableName,
    Item: { ...WORKSPACE_LIMITS_KEY, entityType: "SETTING", perPerson: limits.perPerson, perOrganization: limits.perOrganization, updatedBy: admin, updatedAt },
  }));
  return { ...limits, updatedAt };
}

export async function endSessions(deps: AdminActionDependencies, developerId: string): Promise<{ endedAt: string }> {
  if (deps.endDeveloperSessions === undefined) throw agentXError("NOT_FOUND", "developer sign-in is not set up in this deployment");
  const endedAt = new Date(deps.now()).toISOString();
  const answer = await deps.endDeveloperSessions({ kind: "end-developer-sessions", developerId, at: endedAt });
  if (answer.ok) return { endedAt };
  if (answer.error === "not_found") throw agentXError("NOT_FOUND", "that developer has never signed in, so there is no sign-in to end");
  throw agentXError("RUNTIME_UNAVAILABLE", "AgentX could not reach its sign-in service; try again");
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/contract/admin-actions.test.ts tests/contract/developer-task-start.test.ts`
Expected: PASS. A grant written here is exactly the row `grantsOf` (developer-routes.ts) counts, so
25b's access tests hold; `developer-task-start.test.ts` runs to confirm nothing else moved.

- [ ] **Step 5: Commit**

```bash
git add packages/broker/src/aws/admin-actions.ts tests/contract/admin-actions.test.ts
git commit -m "feat(broker): grant and revoke project access, the limits setting, and developer lookup (spec 025 phase 25e)"
```

---
### Task 5: Plans for channels, project revisions and credentials

E6, E7, E11, E12, FR-039's "compute the exact effect against current state". Each plan returns its
effect, its details (for the audit), the snapshot its hash covers, and how to apply it. **Depends
on Q5** (the runtime binding), **Q7** (who may register a credential) and **Q8** (channels by name).

**Files:**
- Create: `packages/broker/src/aws/admin-change-plans.ts`
- Modify: `packages/broker/src/aws/broker.ts` (`registrationChecks` extracted from
  `registerProject`, unchanged in effect; `adminChangeHandlers(dependencies)`)
- Modify: `packages/broker/src/aws/credentials.ts` (`registration(ref)` and `checkSecret(...)`)
- Test: `tests/contract/admin-change-plans.test.ts`

**Interfaces:**
- Consumes: `AdminReadDependencies`, `queryAllItems`, `getStateItem`, `latestProjectRecord`,
  `adminProjectNames`, `channelLabels` (25d, admin-reads.ts); `AdminActionDependencies` (Task 4);
  `ChannelByNameRequest`, `ChannelByNameResponse` (Task 3); `hashJson` (broker-shared.ts);
  `redactSecrets`, `redactText`, `SlackChannelIdSchema`, `CredentialRegistrationSchema` (contracts).
- Produces:
  - `export interface AdminChangeHandlers { requireAdministrator(identity: AuthenticatedIdentity, project: string): Promise<void>; bindChannel(identity: AuthenticatedIdentity, teamId: string, channelId: string, project: string): Promise<Record<string, unknown>>; unbindChannel(identity: AuthenticatedIdentity, teamId: string, channelId: string): Promise<Record<string, unknown>>; checkRevision(identity: AuthenticatedIdentity, definition: unknown, runtimeBinding: unknown): Promise<{ definition: ProjectDefinition; warnings: string[] }>; registerRevision(identity: AuthenticatedIdentity, definition: ProjectDefinition, runtimeBinding: unknown): Promise<Record<string, unknown>>; registerCredential(identity: AuthenticatedIdentity, registration: { ref: string; type: string; secretName: string }): Promise<Record<string, unknown>>; cancelWorkspaceTask(identity: AuthenticatedIdentity, workspaceId: string): Promise<Record<string, unknown>> }`;
  - `export interface PlanDependencies { reads: AdminReadDependencies; actions: AdminActionDependencies; handlers: AdminChangeHandlers; channelByName?: (request: ChannelByNameRequest) => Promise<ChannelByNameResponse>; credentials?: Pick<CredentialRegistry, "registration" | "checkSecret">; connectorSecretPrefix: string }`;
  - `export interface ChangePlan { effect: string; details: Record<string, unknown>; snapshot: unknown; apply(identity: AuthenticatedIdentity): Promise<Record<string, unknown>> }`;
  - `export async function planChange(deps: PlanDependencies, identity: AuthenticatedIdentity, input: AdminChangeInput): Promise<ChangePlan>`;
  - `export const PLANNERS: Partial<Record<AdminChangeKind, Planner>>` with
    `type Planner = (deps: PlanDependencies, identity: AuthenticatedIdentity, input: AdminChangeInput) => Promise<ChangePlan>`
    (Task 6 adds five);
  - `export function stateHash(snapshot: unknown): string`;
  - `export function fieldDiff(before: unknown, after: unknown, max?: number): Array<{ field: string; from?: string; to?: string }>`;
  - `export function looksLikeSecret(value: string): boolean`;
  - `export async function resolveChannel(deps: PlanDependencies, teamId: string, value: string): Promise<{ channelId: string; label: string }>`;
  - `CredentialRegistry.registration(ref: string): Promise<CredentialRecord | undefined>` and
    `CredentialRegistry.checkSecret(registration: CredentialRegistration): Promise<"reads" | "missing" | "wrong_type" | "unavailable">`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/admin-change-plans.test.ts
// Spec 025 E6, E7, E11, E12: a plan says exactly what will happen, against current state, and
// changes nothing; its hash moves when the state it covers moves.
import { describe, expect, it, vi } from "vitest";
import { fieldDiff, looksLikeSecret, planChange, stateHash, type PlanDependencies } from "../../packages/broker/src/aws/admin-change-plans.js";
import { createAdminReadBroker } from "../support/admin-read-broker.js";
import { bindChannel, registerRevision } from "../support/developer-task-broker.js";
import { SLACK_CHANNEL, SLACK_TEAM } from "../support/slack-broker.js";

const PLANTED = `ghp_${"D".repeat(36)}`;
const admin = { issuer: "https://identity.example.test", subject: "admin-subject", ownerKey: "", isAdministrator: true, claims: {} };

async function harness(options: { channelByName?: PlanDependencies["channelByName"] } = {}) {
  const broker = await createAdminReadBroker({ channelInfo: async (request) => ({ ok: true, channels: request.channelIds.map((channelId) => ({ channelId, name: channelId === SLACK_CHANNEL ? "payments-dev" : "ledger-dev", isPrivate: channelId === "C0PRIVATE01" })) }) });
  const module = await import("../../packages/broker/src/aws/broker.js") as unknown as { createPlanDependencies(input: never): PlanDependencies };
  const deps = module.createPlanDependencies({ ...broker.brokerInput, ...(options.channelByName ? { developer: { ...(broker.brokerInput as { developer: object }).developer, channelByName: options.channelByName } } : {}) } as never);
  // The registering admin's owner key: registration wrote its administrator membership.
  const membership = broker.db.find((item) => item.entityType === "MEMBERSHIP" && item.role === "administrator")[0]!;
  return { ...broker, deps, identity: { ...admin, ownerKey: String(membership.ownerKey) } };
}

describe("binding and unbinding (E7, E12)", () => {
  it("shows the channel, its current binding and the revision new threads use, and changes nothing", async () => {
    const { deps, identity, db, handler } = await harness({ channelByName: async () => ({ ok: true, channel: { channelId: "C0LEDGER01", name: "ledger-dev" } }) });
    await registerRevision(handler, 7, {});
    const plan = await planChange(deps, identity, { kind: "bind_channel", channel: "#ledger-dev", project: "payments" });
    expect(plan.effect).toBe("Bind channel #ledger-dev (C0LEDGER01) to project payments. It is bound to nothing today. New threads in #ledger-dev will use payments revision 7.");
    expect(db.get(`SLACK_BINDING#${SLACK_TEAM}`, "CHANNEL#C0LEDGER01")).toBeUndefined();
    const again = await planChange(deps, identity, { kind: "bind_channel", channel: "C0LEDGER01", project: "payments" });
    expect(stateHash(again.snapshot)).toBe(stateHash(plan.snapshot));
    await bindChannel(handler, "C0LEDGER01", "payments");
    await expect(planChange(deps, identity, { kind: "bind_channel", channel: "C0LEDGER01", project: "payments" })).rejects.toMatchObject({ code: "CONFIG_INVALID", message: "channel #ledger-dev (C0LEDGER01) is already bound to payments" });
  });

  it("names a private channel by ID only, and refuses a private channel's name", async () => {
    const { deps, identity } = await harness({ channelByName: async () => ({ ok: true }) });
    expect((await planChange(deps, identity, { kind: "bind_channel", channel: "C0PRIVATE01", project: "payments" })).effect).toContain("Bind channel C0PRIVATE01 (a private channel) to project payments.");
    await expect(planChange(deps, identity, { kind: "bind_channel", channel: "#secret-launch", project: "payments" })).rejects.toMatchObject({ code: "NOT_FOUND", message: "no public channel named #secret-launch in this Slack workspace; give a private channel by its ID" });
  });

  it("unbinds a bound channel, saying new messages there get no reply, and refuses an unbound one", async () => {
    const { deps, identity } = await harness();
    expect((await planChange(deps, identity, { kind: "unbind_channel", channel: SLACK_CHANNEL })).effect).toBe(`Unbind channel #payments-dev (${SLACK_CHANNEL}) from project payments. New messages there will get no reply; existing thread workspaces are kept.`);
    await expect(planChange(deps, identity, { kind: "unbind_channel", channel: "C0NOTBOUND1" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses an admin who does not administer the project (FR-015)", async () => {
    const { deps } = await harness();
    await expect(planChange(deps, { ...admin, ownerKey: "f".repeat(64) }, { kind: "unbind_channel", channel: SLACK_CHANNEL })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("a project revision (E7, E11)", () => {
  it("shows the new number, each changed field and the preflight, keeping the latest runtime binding", async () => {
    const { deps, identity } = await harness();
    const latest = { name: "payments", revision: 2, repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }], setup: [], readiness: [], orchestratorInstructions: `Delegate work. Token ${PLANTED}` };
    const plan = await planChange(deps, identity, { kind: "register_project_revision", definition: latest });
    expect(plan.effect).toContain("Register revision 2 of project payments (the latest is 1).");
    expect(plan.effect).toContain("orchestratorInstructions:");
    expect(plan.effect).toContain("[REDACTED]");
    expect(JSON.stringify(plan)).not.toContain(PLANTED);
    expect(plan.details).toMatchObject({ revision: 2, runtimeMode: "ec2-ebs" });
  });

  it("redacts a planted secret in a revision's diff, and refuses a secret-looking credential input", async () => {
    const { deps, identity } = await harness();
    const plan = await planChange(deps, identity, { kind: "register_project_revision", definition: { name: "payments", revision: 3, repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }], setup: [], readiness: [], orchestratorInstructions: PLANTED } });
    expect(JSON.stringify([plan.effect, plan.details])).not.toContain(PLANTED);
    await expect(planChange(deps, identity, { kind: "register_credential", ref: "linear", type: "static-secret", secretName: `agentx/connectors/${PLANTED}` })).rejects.toMatchObject({ code: "CONFIG_INVALID", message: "that input looks like a secret value; give the secret's name under agentx/connectors/, never its value" });
  });

  it("refuses a first revision, an existing revision and an invalid definition", async () => {
    const { deps, identity } = await harness();
    await expect(planChange(deps, identity, { kind: "register_project_revision", definition: { name: "ledger", revision: 1 } })).rejects.toMatchObject({ code: "NOT_FOUND", message: "project ledger has no revision yet; register its first revision with agentx admin project register" });
    await expect(planChange(deps, identity, { kind: "register_project_revision", definition: { name: "payments", revision: 1 } })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});

describe("a credential (E7, Q7)", () => {
  it("shows whether the secret reads as that type, which projects name it, and whether it replaces one", async () => {
    const { deps, identity } = await harness();
    deps.credentials = { registration: vi.fn(async () => undefined), checkSecret: vi.fn(async () => "missing" as const) };
    const plan = await planChange(deps, identity, { kind: "register_credential", ref: "linear", type: "static-secret", secretName: "agentx/connectors/linear" });
    expect(plan.effect).toBe("Register credential linear as static-secret, read from agentx/connectors/linear. That secret does not exist yet, so connectors naming linear will fail until it does. No project names linear today. It is a new registration.");
  });
});

describe("the helpers", () => {
  it("diffs leaves by path and shows values redacted and short", () => {
    expect(fieldDiff({ a: 1, b: { c: "x" }, d: [1] }, { a: 2, b: { c: "x", e: PLANTED }, d: [] })).toEqual([
      { field: "a", from: "1", to: "2" }, { field: "b.e", to: '"[REDACTED]"' }, { field: "d[0]", from: "1" },
    ]);
  });

  it("knows a secret-looking value", () => {
    expect(looksLikeSecret(PLANTED)).toBe(true);
    expect(looksLikeSecret("x".repeat(40))).toBe(true);
    expect(looksLikeSecret("agentx/connectors/linear")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/contract/admin-change-plans.test.ts`
Expected: FAIL: `admin-change-plans.js` does not exist.

- [ ] **Step 3: The credential registry's two reads**

In `packages/broker/src/aws/credentials.ts`, add to `CredentialRegistry`:

```ts
  /** Spec 025 E7: the registration under a reference, if a valid one exists. */
  async registration(ref: string): Promise<CredentialRecord | undefined> {
    return this.readRecord(ref);
  }

  /** Spec 025 E7: whether the secret exists and reads as the type, without keeping or returning it. */
  async checkSecret(registration: CredentialRegistration): Promise<"reads" | "missing" | "wrong_type" | "unavailable"> {
    let raw: string | undefined;
    try {
      raw = await this.options.secrets.read(registration.secretName);
    } catch (error) {
      return error instanceof CredentialUnavailable ? "missing" : "unavailable";
    }
    try {
      parseConnectorSecret(registration.type, raw, registration.ref, registration.secretName);
      return "reads";
    } catch {
      return "wrong_type";
    }
  }
```

- [ ] **Step 4: Extract registration's checks, unchanged**

In `packages/broker/src/aws/broker.ts`, move the lines of `registerProject` from
`const nameProblems = presentedNameProblems(definition);` through the `wantsPreflight` block that
sets `preflight` into:

```ts
/** Registration's refusals and preflight, for a new revision; registerProject and a change plan share them. */
async function registrationChecks(dependencies: AwsBrokerDependencies, identity: AuthenticatedIdentity, definition: ProjectDefinition, wantsPreflight: boolean): Promise<RegistrationPreflight | undefined> {
  const budget = toolBudget(approvedToolCount(definition));
  const connectors = () => resolveConnectors(definition, connectorTypeContext(dependencies), dependencies.connectorTypes);
  const nameProblems = presentedNameProblems(definition);
  if (nameProblems.length > 0) throw agentXError("CONFIG_INVALID", nameProblems.join("; "));
  if (budget.refusal) throw agentXError("CONFIG_INVALID", budget.refusal);
  const credentialProblems = await credentialRefusals(connectors(), dependencies.credentialRegistry);
  if (credentialProblems.length > 0) throw agentXError("CONFIG_INVALID", credentialProblems.join("; "));
  // A repository the GitHub App cannot reach would otherwise fail only at prepare (#123).
  for (const repository of definition.repositories) {
    await dependencies.checkRepositoryAccess?.(repository);
  }
  if (!wantsPreflight) return undefined;
  const result = await preflightConnectors(connectors(), definition, identity.ownerKey);
  if (result.refusals.length > 0) throw agentXError("CONFIG_INVALID", result.refusals.join("; "));
  return result.report;
}
```

and call it there: `const preflight = await registrationChecks(dependencies, identity, definition, wantsPreflight);`.
The order of checks and every message are as before; `admin-preparation.test.ts`,
`registration*.test.ts` and `slack-admin-cli.test.ts` pass unchanged.

Then add the handlers and the plan dependencies:

```ts
/** Spec 025 phase 25e: the existing admin handlers a confirmed change applies through (FR-040). */
function adminChangeHandlers(dependencies: AwsBrokerDependencies): AdminChangeHandlers {
  return {
    requireAdministrator: (identity, project) => requireAdministrator(dependencies, identity, project),
    bindChannel: async (identity, teamId, channelId, project) => putSlackBinding(dependencies, identity, teamId, channelId, { projectName: project }),
    unbindChannel: async (identity, teamId, channelId) => deleteSlackBinding(dependencies, identity, teamId, channelId),
    checkRevision: async (identity, value, runtimeBindingValue) => {
      if (!identity.isAdministrator) throw agentXError("FORBIDDEN", "administrator claim is required");
      const retired = legacyProjectFields(value);
      if (retired.length > 0) throw agentXError("CONFIG_INVALID", `project definition must not contain ${retired.join(", ")}`);
      const parsed = ProjectDefinitionSchema.safeParse(value);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw agentXError("CONFIG_INVALID", `the project definition is invalid: ${issue?.path.join(".") || "definition"}: ${issue?.message ?? "invalid"}`);
      }
      const definition = parsed.data;
      parseRuntimeBinding(runtimeBindingValue);
      if (await getItem(dependencies, projectKey(definition.name, definition.revision)) !== undefined) throw agentXError("CONFIG_INVALID", `revision ${definition.revision} of ${definition.name} is already registered`);
      const preflight = await registrationChecks(dependencies, identity, definition, true);
      return { definition, warnings: registrationWarnings(toolBudget(approvedToolCount(definition)).warning, preflight) };
    },
    registerRevision: async (identity, definition, runtimeBinding) => registerProject(dependencies, identity, { definition, runtimeBinding, preflight: true }) as unknown as Record<string, unknown>,
    registerCredential: async (identity, registration) => {
      if (!dependencies.credentialRegistry) throw agentXError("RUNTIME_UNAVAILABLE", "connector credentials are not configured in this deployment");
      return dependencies.credentialRegistry.register(identity, registration) as unknown as Record<string, unknown>;
    },
    cancelWorkspaceTask: async (identity, workspaceId) => cancelWorkspaceTask(dependencies, identity, workspaceId) as unknown as Record<string, unknown>,
  };
}

/** Spec 025 phase 25e: what change plans read and apply through; tests build it the same way. */
export function createPlanDependencies(input: AwsBrokerInput): PlanDependencies {
  const dependencies = brokerDependencies(input);
  return planDependencies(dependencies);
}

function planDependencies(dependencies: AwsBrokerDependencies): PlanDependencies {
  const developer = dependencies.developer;
  return {
    reads: adminReadDependencies(dependencies),
    actions: {
      documentClient: dependencies.documentClient, tableName: dependencies.tableName,
      ...(developer === undefined ? {} : { signInTableName: developer.signInTableName }),
      ...(developer?.slackTeamId === undefined ? {} : { slackTeamId: developer.slackTeamId }),
      limitDefaults: { member: dependencies.slack?.memberWorkspaceLimit ?? 3, organization: dependencies.slack?.organizationWorkspaceLimit ?? 20 },
      ...(developer?.endDeveloperSessions === undefined ? {} : { endDeveloperSessions: developer.endDeveloperSessions }),
      now: Date.now,
    },
    handlers: adminChangeHandlers(dependencies),
    ...(developer?.channelByName === undefined ? {} : { channelByName: developer.channelByName }),
    ...(dependencies.credentialRegistry === undefined ? {} : { credentials: dependencies.credentialRegistry }),
    connectorSecretPrefix: process.env.CONNECTOR_SECRET_PREFIX ?? "agentx/connectors/",
  };
}
```

`putSlackBinding`'s and `deleteSlackBinding`'s signatures are as today (`teamIdValue`,
`channelIdValue` are the URL segments, which they `decodeURIComponent`; plain IDs pass unchanged).

- [ ] **Step 5: Write the plans module**

```ts
// packages/broker/src/aws/admin-change-plans.ts
// Spec 025 FR-039, E6, E7: each admin change's plan, computed against current state. A plan
// changes nothing: it says what will happen, hashes what it read, and says how to apply it through
// the existing handler. Every value it shows passes through redaction first.
import {
  AgentXNameSchema, CredentialRegistrationSchema, SlackChannelIdSchema, agentXError, redactSecrets, redactText,
  type AdminChangeInput, type AdminChangeKind, type ChannelByNameRequest, type ChannelByNameResponse, type ProjectDefinition,
} from "@agentx/contracts";
import type { AuthenticatedIdentity } from "../auth.js";
import type { AdminActionDependencies } from "./admin-actions.js";
import { adminProjectNames, channelLabels, getStateItem, latestProjectRecord, queryAllItems, type AdminReadDependencies } from "./admin-reads.js";
import { hashJson } from "./broker-shared.js";
import type { CredentialRegistry } from "./credentials.js";

export interface AdminChangeHandlers {
  requireAdministrator(identity: AuthenticatedIdentity, project: string): Promise<void>;
  bindChannel(identity: AuthenticatedIdentity, teamId: string, channelId: string, project: string): Promise<Record<string, unknown>>;
  unbindChannel(identity: AuthenticatedIdentity, teamId: string, channelId: string): Promise<Record<string, unknown>>;
  checkRevision(identity: AuthenticatedIdentity, definition: unknown, runtimeBinding: unknown): Promise<{ definition: ProjectDefinition; warnings: string[] }>;
  registerRevision(identity: AuthenticatedIdentity, definition: ProjectDefinition, runtimeBinding: unknown): Promise<Record<string, unknown>>;
  registerCredential(identity: AuthenticatedIdentity, registration: { ref: string; type: string; secretName: string }): Promise<Record<string, unknown>>;
  cancelWorkspaceTask(identity: AuthenticatedIdentity, workspaceId: string): Promise<Record<string, unknown>>;
}
export interface PlanDependencies {
  reads: AdminReadDependencies;
  actions: AdminActionDependencies;
  handlers: AdminChangeHandlers;
  channelByName?: (request: ChannelByNameRequest) => Promise<ChannelByNameResponse>;
  credentials?: Pick<CredentialRegistry, "registration" | "checkSecret">;
  connectorSecretPrefix: string;
}
export interface ChangePlan {
  effect: string;
  details: Record<string, unknown>;
  snapshot: unknown;
  apply(identity: AuthenticatedIdentity): Promise<Record<string, unknown>>;
}
export type Planner = (deps: PlanDependencies, identity: AuthenticatedIdentity, input: AdminChangeInput) => Promise<ChangePlan>;

export const stateHash = (snapshot: unknown): string => hashJson(snapshot);

const SHOWN_VALUE_MAX = 120;
const show = (value: unknown): string => {
  const text = JSON.stringify(redactSecrets(value)) ?? "null";
  return text.length > SHOWN_VALUE_MAX ? `${text.slice(0, SHOWN_VALUE_MAX - 3)}...` : text;
};

function leaves(value: unknown, path: string, into: Map<string, unknown>): Map<string, unknown> {
  if (Array.isArray(value)) value.forEach((entry, index) => leaves(entry, `${path}[${index}]`, into));
  else if (value !== null && typeof value === "object") for (const [key, entry] of Object.entries(value)) leaves(entry, path === "" ? key : `${path}.${key}`, into);
  else into.set(path, value);
  return into;
}

/** Leaf by leaf, in the order the new definition names them, then what it removed. */
export function fieldDiff(before: unknown, after: unknown, max = 200): Array<{ field: string; from?: string; to?: string }> {
  const old = leaves(before, "", new Map());
  const next = leaves(after, "", new Map());
  const changes: Array<{ field: string; from?: string; to?: string }> = [];
  for (const [field, value] of next) {
    if (!old.has(field)) changes.push({ field, to: show(value) });
    else if (JSON.stringify(old.get(field)) !== JSON.stringify(value)) changes.push({ field, from: show(old.get(field)), to: show(value) });
  }
  for (const [field, value] of old) if (!next.has(field)) changes.push({ field, from: show(value) });
  return changes.slice(0, max);
}

/** FR-030: a credential tool refuses any input that looks like a secret value. */
export function looksLikeSecret(value: string): boolean {
  if (redactText(value) !== value) return true;
  // A long unbroken token of key-like characters is refused too, whatever its prefix.
  return value.split(/[/:@.\s]/).some((part) => part.length >= 32 && /^[A-Za-z0-9_+=-]+$/.test(part));
}

const CHANNEL_NAME = /^[a-z0-9][a-z0-9._-]{0,79}$/;

/** E12 (Q8): a channel ID as it is; a public channel's name among the bindings, then through Slack. */
export async function resolveChannel(deps: PlanDependencies, teamId: string, value: string): Promise<{ channelId: string; label: string }> {
  const text = value.trim().replace(/^#/, "");
  const labelOf = async (channelId: string) => {
    const known = (await channelLabels(deps.reads, [channelId])).labels.get(channelId);
    return known?.name !== undefined ? `#${known.name} (${channelId})` : known?.private === true ? `${channelId} (a private channel)` : channelId;
  };
  if (SlackChannelIdSchema.safeParse(text).success) return { channelId: text, label: await labelOf(text) };
  if (!CHANNEL_NAME.test(text)) throw agentXError("CONFIG_INVALID", "channel must be a Slack channel ID such as C0123456789, or a public channel's name");
  const bound = (await queryAllItems(deps.reads, `SLACK_BINDING#${teamId}`, "CHANNEL#")).map((item) => String(item.channelId));
  const { labels } = await channelLabels(deps.reads, bound);
  for (const [channelId, label] of labels) if (label.name === text) return { channelId, label: `#${text} (${channelId})` };
  const found = deps.channelByName === undefined ? undefined : await deps.channelByName({ kind: "channel-by-name", name: text });
  if (found !== undefined && !found.ok) throw agentXError("SLACK_UNAVAILABLE", "Slack could not be reached to find that channel; try again, or give its ID");
  if (found?.channel === undefined) throw agentXError("NOT_FOUND", `no public channel named #${text} in this Slack workspace; give a private channel by its ID`);
  return { channelId: found.channel.channelId, label: `#${text} (${found.channel.channelId})` };
}

const teamOf = (deps: PlanDependencies): string => {
  if (deps.reads.slackTeamId === undefined) throw agentXError("CONFIG_INVALID", "this environment records no Slack team, so channels cannot be bound from an AI tool; use agentx admin slack bind");
  return deps.reads.slackTeamId;
};
const bindingOf = async (deps: PlanDependencies, teamId: string, channelId: string) => {
  const item = await getStateItem(deps.reads, { pk: `SLACK_BINDING#${teamId}`, sk: `CHANNEL#${channelId}` });
  return typeof item?.projectName === "string" ? { projectName: item.projectName, updatedAt: String(item.updatedAt ?? "") } : undefined;
};
const shortName = (label: string) => (label.startsWith("#") ? label.slice(0, label.indexOf(" ")) : label.split(" ")[0]!);

const planBind: Planner = async (deps, identity, input) => {
  if (input.kind !== "bind_channel") throw new Error("wrong planner");
  const teamId = teamOf(deps);
  const { channelId, label } = await resolveChannel(deps, teamId, input.channel);
  await deps.handlers.requireAdministrator(identity, input.project);
  const current = await bindingOf(deps, teamId, channelId);
  if (current?.projectName === input.project) throw agentXError("CONFIG_INVALID", `channel ${label} is already bound to ${input.project}`);
  if (current !== undefined) await deps.handlers.requireAdministrator(identity, current.projectName);
  const latest = await latestProjectRecord(deps.reads, input.project);
  if (latest === undefined) throw agentXError("NOT_FOUND", `project ${input.project} is not registered`);
  const now = current === undefined ? "It is bound to nothing today." : `It is bound to ${current.projectName} today; its existing threads keep their workspaces.`;
  return {
    effect: `Bind channel ${label} to project ${input.project}. ${now} New threads in ${shortName(label)} will use ${input.project} revision ${latest.definition.revision}.`,
    details: { channelId, project: input.project, currentProject: current?.projectName ?? null, revision: latest.definition.revision },
    snapshot: { binding: current ?? null, latestRevision: latest.definition.revision },
    apply: (applier) => deps.handlers.bindChannel(applier, teamId, channelId, input.project),
  };
};

const planUnbind: Planner = async (deps, identity, input) => {
  if (input.kind !== "unbind_channel") throw new Error("wrong planner");
  const teamId = teamOf(deps);
  const { channelId, label } = await resolveChannel(deps, teamId, input.channel);
  const current = await bindingOf(deps, teamId, channelId);
  if (current === undefined) throw agentXError("NOT_FOUND", `channel ${label} is not bound to any project`);
  await deps.handlers.requireAdministrator(identity, current.projectName);
  return {
    effect: `Unbind channel ${label} from project ${current.projectName}. New messages there will get no reply; existing thread workspaces are kept.`,
    details: { channelId, project: current.projectName },
    snapshot: { binding: current },
    apply: (applier) => deps.handlers.unbindChannel(applier, teamId, channelId),
  };
};

const planRevision: Planner = async (deps, identity, input) => {
  if (input.kind !== "register_project_revision") throw new Error("wrong planner");
  const name = input.definition.name;
  if (typeof name !== "string" || !AgentXNameSchema.safeParse(name).success) throw agentXError("CONFIG_INVALID", "the definition needs the project's name");
  const latest = await latestProjectRecord(deps.reads, name);
  // Q5: a new revision keeps its project's runtime binding; a first revision needs the CLI's flags.
  if (latest === undefined) throw agentXError("NOT_FOUND", `project ${name} has no revision yet; register its first revision with agentx admin project register`);
  await deps.handlers.requireAdministrator(identity, name);
  const { definition, warnings } = await deps.handlers.checkRevision(identity, input.definition, latest.runtimeBinding);
  if (definition.revision <= latest.definition.revision) throw agentXError("CONFIG_INVALID", `revision ${definition.revision} is not newer than the latest, ${latest.definition.revision}; use ${latest.definition.revision + 1}`);
  const changes = fieldDiff(latest.definition, definition);
  const listed = changes.filter((change) => change.field !== "revision").slice(0, 20).map((change) => `${change.field}: ${change.from ?? "(none)"} -> ${change.to ?? "(removed)"}`);
  const findings = warnings.length === 0 ? "The preflight found nothing to fix." : `The preflight found: ${warnings.map((warning) => redactText(warning)).join("; ")}.`;
  return {
    effect: `Register revision ${definition.revision} of project ${name} (the latest is ${latest.definition.revision}). It changes ${changes.length - 1} field${changes.length - 1 === 1 ? "" : "s"}${listed.length === 0 ? "" : `: ${listed.join("; ")}`}. ${findings} New threads and tasks use it; running ones keep their revision.`,
    details: { project: name, revision: definition.revision, latestRevision: latest.definition.revision, runtimeMode: latest.runtimeBinding.deploymentMode, changes, warnings },
    snapshot: { latestRevision: latest.definition.revision },
    apply: (applier) => deps.handlers.registerRevision(applier, definition, latest.runtimeBinding),
  };
};

const planCredential: Planner = async (deps, _identity, input) => {
  if (input.kind !== "register_credential") throw new Error("wrong planner");
  // FR-030: refuse anything that looks like a secret value before it is stored anywhere.
  if ([input.ref, input.type, input.secretName].some(looksLikeSecret)) throw agentXError("CONFIG_INVALID", `that input looks like a secret value; give the secret's name under ${deps.connectorSecretPrefix}, never its value`);
  const registration = CredentialRegistrationSchema.safeParse({ ref: input.ref, type: input.type, secretName: input.secretName });
  if (!registration.success) throw agentXError("CONFIG_INVALID", `invalid credential: ${registration.error.issues[0]?.path.join(".") ?? "input"}: ${registration.error.issues[0]?.message ?? "invalid"}`);
  if (!registration.data.secretName.startsWith(deps.connectorSecretPrefix)) throw agentXError("CONFIG_INVALID", `the secret name must be ${deps.connectorSecretPrefix}<name> in this deployment`);
  if (deps.credentials === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "connector credentials are not configured in this deployment");
  const [current, secret] = await Promise.all([deps.credentials.registration(input.ref), deps.credentials.checkSecret(registration.data)]);
  const users: string[] = [];
  for (const name of await adminProjectNames(deps.reads, { ownerKey: "", isAdministrator: true, issuer: "", subject: "", claims: {} })) {
    const latest = await latestProjectRecord(deps.reads, name);
    const connectors = ((latest?.definition as { integrations?: { connectors?: Array<{ credentialRef?: unknown }> } } | undefined)?.integrations?.connectors ?? []);
    if (connectors.some((connector) => connector.credentialRef === input.ref)) users.push(name);
  }
  const secretText = {
    reads: `That secret exists and reads as ${input.type}.`,
    missing: `That secret does not exist yet, so connectors naming ${input.ref} will fail until it does.`,
    wrong_type: `That secret exists but does not read as ${input.type}, so registering it will be refused.`,
    unavailable: "AgentX could not read that secret just now, so whether it exists is unknown.",
  }[secret];
  return {
    effect: `Register credential ${input.ref} as ${input.type}, read from ${input.secretName}. ${secretText} ${users.length === 0 ? `No project names ${input.ref} today.` : `Projects naming it: ${users.join(", ")}.`} ${current === undefined ? "It is a new registration." : `It replaces the registration from ${current.registeredAt}, which read ${current.secretName} as ${current.type}.`}`,
    details: { ref: input.ref, type: input.type, secretName: input.secretName, secret, projects: users, replaces: current === undefined ? null : { type: current.type, secretName: current.secretName } },
    snapshot: { registration: current === undefined ? null : { type: current.type, secretName: current.secretName, registeredAt: current.registeredAt } },
    apply: (applier) => deps.handlers.registerCredential(applier, registration.data),
  };
};

export const PLANNERS: Partial<Record<AdminChangeKind, Planner>> = {
  bind_channel: planBind,
  unbind_channel: planUnbind,
  register_project_revision: planRevision,
  register_credential: planCredential,
};

export async function planChange(deps: PlanDependencies, identity: AuthenticatedIdentity, input: AdminChangeInput): Promise<ChangePlan> {
  const planner = PLANNERS[input.kind];
  if (planner === undefined) throw agentXError("CONFIG_INVALID", `${input.kind} is not a change this AgentX can plan`);
  return planner(deps, identity, input);
}
```

`adminProjectNames` takes an identity only for its membership rows; the credential plan passes an
empty owner key so only the catalog and bindings count, since a credential is not scoped to the
asking admin's own projects. Import `redactSecrets` is used by `show`; `ProjectDefinition` is the
contracts' type.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/contract/admin-change-plans.test.ts tests/contract/admin-preparation.test.ts tests/contract/slack-admin-cli.test.ts $(ls tests/contract | grep -E "^(registration|project-registration|connector-registration).*\.test\.ts$" | sed 's#^#tests/contract/#') && npm run typecheck`
Expected: PASS; registration's existing tests are unchanged.

- [ ] **Step 7: Commit**

```bash
git add packages/broker/src/aws/admin-change-plans.ts packages/broker/src/aws/broker.ts packages/broker/src/aws/credentials.ts tests/contract/admin-change-plans.test.ts
git commit -m "feat(broker): change plans for channels, project revisions and credentials (spec 025 phase 25e)"
```

---

### Task 6: Plans for workspaces, project access, sign-ins and the limits

E6, E7, E8, E9, E10, E19. **Depends on Q2** (stop), **Q3** (end sessions), **Q4** (developers by
email) and **Q7** (org-wide changes need the admin claim only).

**Files:**
- Modify: `packages/broker/src/aws/admin-change-plans.ts`
- Test: `tests/contract/admin-change-plans-access.test.ts`

**Interfaces:**
- Consumes: `PLANNERS`, `Planner`, `stateHash` (Task 5); `resolveDeveloper`, `projectGrant`,
  `grantProjectAccess`, `revokeProjectAccess`, `setWorkspaceLimits`, `endSessions` (Task 4);
  `workspaceOwner` (25d, admin-reads.ts); `readWorkspaceLimits` (limits.ts);
  `WorkspaceInstanceSchema`, `workspaceRecordFields`, `developerTaskPolicy` (contracts).
- Produces: `PLANNERS` gains `stop_workspace`, `grant_project_access`, `revoke_project_access`,
  `revoke_signin`, `set_workspace_limits`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/admin-change-plans-access.test.ts
// Spec 025 E7 to E10, E19: stopping work, granting and revoking access, ending a sign-in, and the limits.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { planChange, stateHash, type PlanDependencies } from "../../packages/broker/src/aws/admin-change-plans.js";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import { createAdminReadBroker } from "../support/admin-read-broker.js";
import { MAYA } from "../support/developer-task-broker.js";

const admin = { issuer: "https://identity.example.test", subject: "admin-subject", ownerKey: "", isAdministrator: true, claims: {} };
async function harness() {
  const broker = await createAdminReadBroker({ developerExtra: { endDeveloperSessions: async () => ({ ok: true }) } });
  const module = await import("../../packages/broker/src/aws/broker.js") as unknown as { createPlanDependencies(input: never): PlanDependencies };
  const deps = module.createPlanDependencies(broker.brokerInput as never);
  const membership = broker.db.find((item) => item.entityType === "MEMBERSHIP" && item.role === "administrator")[0]!;
  return { ...broker, deps, identity: { ...admin, ownerKey: String(membership.ownerKey) } };
}

describe("stopping a workspace's work (E10, Q2)", () => {
  it("names the running task it cancels, and refuses a workspace with nothing running", async () => {
    const { deps, identity, db, dev } = await harness();
    const started = await dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix it", client: "claude-code" });
    const task = db.get(`DEVTASK#${(started.body.task as { taskId: string }).taskId}`, "META") as { workspaceId: string };
    // A prepare is running, which the admin cancel does not stop midway.
    await expect(planChange(deps, identity, { kind: "stop_workspace", workspaceId: task.workspaceId })).rejects.toMatchObject({ code: "CONFIG_INVALID", message: "the running operation is a prepare, which AgentX does not cancel midway; wait for it to end" });
    const workspace = db.get(`WORKSPACE#${task.workspaceId}`, "META")!;
    db.set({ ...workspace, status: "READY", activeOperationId: null });
    await expect(planChange(deps, identity, { kind: "stop_workspace", workspaceId: task.workspaceId })).rejects.toMatchObject({ code: "CONFIG_INVALID", message: `nothing is running in workspace ${task.workspaceId}; its compute stops on its own when idle` });
  });
});

describe("project access (E7, E8, FR-013.1)", () => {
  it("grants a developer named by Slack user before their first sign-in, saying so", async () => {
    const { deps, identity } = await harness();
    const plan = await planChange(deps, identity, { kind: "grant_project_access", project: "payments", developer: "U0NEW00001" });
    expect(plan.effect).toBe("Grant Slack user U0NEW00001 (not signed in to AgentX yet; the grant applies when they sign in with Slack) access to project payments. They have no grant today. They can then hand tasks to payments from their AI tool.");
    expect(plan.details).toMatchObject({ developerId: developerIdForSlackUser("U0NEW00001"), project: "payments" });
  });

  it("names a signed-in developer, and revokes only a grant, saying channel access may remain", async () => {
    const { deps, identity, db } = await harness();
    db.set({ pk: `MEMBER#${MAYA.developerId}`, sk: "PROJECT#payments", entityType: "MEMBERSHIP", ownerKey: MAYA.developerId, projectName: "payments", role: "developer" });
    const plan = await planChange(deps, identity, { kind: "revoke_project_access", project: "payments", developer: MAYA.developerId });
    expect(plan.effect).toBe("Revoke Maya Chen (signs in with Slack)'s granted access to project payments. Their running tasks keep running. If they are a member of one of payments's Slack channels, they keep access through it.");
    const before = stateHash(plan.snapshot);
    db.delete(`MEMBER#${MAYA.developerId}`, "PROJECT#payments");
    await expect(planChange(deps, identity, { kind: "revoke_project_access", project: "payments", developer: MAYA.developerId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(before).toMatch(/^[a-f0-9]{64}$/);
  });

  it("refuses a grant on a project the admin does not administer (FR-015)", async () => {
    const { deps } = await harness();
    await expect(planChange(deps, { ...admin, ownerKey: "f".repeat(64) }, { kind: "grant_project_access", project: "payments", developer: "U0NEW00001" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("ending a sign-in (E9, Q3)", () => {
  it("says every session ends at once and that they may sign in again", async () => {
    const { deps, identity } = await harness();
    expect((await planChange(deps, identity, { kind: "revoke_signin", developer: MAYA.developerId })).effect).toBe("End every AgentX sign-in session of Maya Chen (signs in with Slack). Their AI tools stop reaching AgentX at once; they may sign in again with agentx login. Their running tasks keep running.");
    await expect(planChange(deps, identity, { kind: "revoke_signin", developer: "U0NEW00001" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("the workspace limits (E19, FR-053)", () => {
  it("shows the current and new limits, the counts, and who is at or over the new limit", async () => {
    const { deps, identity, db } = await harness();
    db.set({ pk: "SLACK_LIMIT#T0BSHLLUGBD", sk: "MEMBER#U0PRIYA001", count: 3 });
    db.set({ pk: "SLACK_LIMIT#T0BSHLLUGBD", sk: "MEMBER#U0OMAR0001", count: 1 });
    db.set({ pk: "SLACK_LIMIT#T0BSHLLUGBD", sk: "ORGANIZATION", count: 4 });
    const plan = await planChange(deps, identity, { kind: "set_workspace_limits", perPerson: 2 });
    expect(plan.effect).toBe("Set the workspace limits to 2 per person (now 3) and 20 for the organization (unchanged). Open workspaces: 4 of 20. At or over 2 per person: Slack member U0PRIYA001 (3 open). Existing workspaces keep running; a new one is refused while its person or the organization is at the limit.");
    await expect(planChange(deps, identity, { kind: "set_workspace_limits" })).rejects.toMatchObject({ code: "CONFIG_INVALID", message: "give per_person, per_organization or both" });
    await expect(planChange(deps, identity, { kind: "set_workspace_limits", perPerson: 30, perOrganization: 20 })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("hashes the setting, so a change by someone else makes the plan stale", async () => {
    const { deps, identity, db } = await harness();
    const before = stateHash((await planChange(deps, identity, { kind: "set_workspace_limits", perPerson: 5 })).snapshot);
    db.set({ pk: "SETTINGS", sk: "WORKSPACE_LIMITS", perPerson: 4, perOrganization: 20, updatedAt: "2026-10-02T09:00:00.000Z" });
    expect(stateHash((await planChange(deps, identity, { kind: "set_workspace_limits", perPerson: 5 })).snapshot)).not.toBe(before);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/contract/admin-change-plans-access.test.ts`
Expected: FAIL: "stop_workspace is not a change this AgentX can plan".

- [ ] **Step 3: Add the five plans**

In `admin-change-plans.ts`, import the Task 4 actions, `workspaceOwner`, `readWorkspaceLimits`,
`WorkspaceInstanceSchema`, `workspaceRecordFields` and `developerTaskPolicy`, and add:

```ts
function describeDeveloper(resolved: ResolvedDeveloper): string {
  if (resolved.profile !== undefined) return `${resolved.profile.displayName} (signs in with ${resolved.profile.provider === "slack" ? "Slack" : "the company sign-in"})`;
  if (resolved.slackUserId !== undefined) return `Slack user ${resolved.slackUserId} (not signed in to AgentX yet; the grant applies when they sign in with Slack)`;
  return `developer ${resolved.developerId.slice(0, 12)} (not signed in to AgentX yet)`;
}
const projectMustExist = async (deps: PlanDependencies, project: string) => {
  const latest = await latestProjectRecord(deps.reads, project);
  if (latest === undefined) throw agentXError("NOT_FOUND", `project ${project} is not registered`);
  return latest;
};

const planStop: Planner = async (deps, identity, input) => {
  if (input.kind !== "stop_workspace") throw new Error("wrong planner");
  const item = await getStateItem(deps.reads, { pk: `WORKSPACE#${input.workspaceId}`, sk: "META" });
  const parsed = item === undefined ? undefined : WorkspaceInstanceSchema.safeParse(workspaceRecordFields(item));
  if (parsed === undefined || !parsed.success) throw agentXError("NOT_FOUND", `no workspace ${input.workspaceId}`);
  const workspace = parsed.data;
  await deps.handlers.requireAdministrator(identity, workspace.projectName);
  // Q2: stopping compute by hand is not supported (idle sessions stop on their own), so the change
  // cancels the running task, through the admin cancel of #126.
  if (workspace.activeOperationId === null) throw agentXError("CONFIG_INVALID", `nothing is running in workspace ${workspace.id}; its compute stops on its own when idle`);
  const operation = await getStateItem(deps.reads, { pk: `WORKSPACE#${workspace.id}`, sk: `OPERATION#${workspace.activeOperationId}` });
  if (operation?.kind !== "task") throw agentXError("CONFIG_INVALID", `the running operation is a ${String(operation?.kind ?? "setup")}, which AgentX does not cancel midway; wait for it to end`);
  const { owner } = await workspaceOwner(deps.reads, workspace);
  const who = owner.threadUrl ?? (owner.developerName === undefined ? "its owner" : `${owner.developerName}'s task`);
  return {
    effect: `Cancel the task running in workspace ${workspace.id} (project ${workspace.projectName}, ${who}, ${workspace.status}). Its conversation keeps what finished before; its compute stops on its own when idle.`,
    details: { workspaceId: workspace.id, project: workspace.projectName, operationId: workspace.activeOperationId },
    snapshot: { status: workspace.status, activeOperationId: workspace.activeOperationId, fence: workspace.fence },
    apply: (applier) => deps.handlers.cancelWorkspaceTask(applier, workspace.id),
  };
};

const planGrant: Planner = async (deps, identity, input) => {
  if (input.kind !== "grant_project_access") throw new Error("wrong planner");
  await projectMustExist(deps, input.project);
  await deps.handlers.requireAdministrator(identity, input.project);
  const resolved = await resolveDeveloper(deps.actions, input.developer);
  const current = await projectGrant(deps.actions, input.project, resolved.developerId);
  if (current?.role === "developer") throw agentXError("CONFIG_INVALID", `${describeDeveloper(resolved)} already has a grant for ${input.project}`);
  if (current?.role === "administrator") throw agentXError("CONFIG_INVALID", `${describeDeveloper(resolved)} already administers ${input.project}`);
  return {
    effect: `Grant ${describeDeveloper(resolved)} access to project ${input.project}. They have no grant today. They can then hand tasks to ${input.project} from their AI tool.`,
    details: { developerId: resolved.developerId, via: resolved.via, project: input.project },
    snapshot: { grant: null },
    apply: (applier) => grantProjectAccess(deps.actions, { issuer: applier.issuer, subject: applier.subject }, input.project, resolved.developerId),
  };
};

const planRevoke: Planner = async (deps, identity, input) => {
  if (input.kind !== "revoke_project_access") throw new Error("wrong planner");
  const latest = await projectMustExist(deps, input.project);
  await deps.handlers.requireAdministrator(identity, input.project);
  const resolved = await resolveDeveloper(deps.actions, input.developer);
  const current = await projectGrant(deps.actions, input.project, resolved.developerId);
  if (current?.role !== "developer") throw agentXError("NOT_FOUND", `${describeDeveloper(resolved)} has no grant for ${input.project}`);
  const channels = developerTaskPolicy(latest.definition).channelMembersMayUse
    ? ` If they are a member of one of ${input.project}'s Slack channels, they keep access through it.` : "";
  return {
    effect: `Revoke ${describeDeveloper(resolved)}'s granted access to project ${input.project}. Their running tasks keep running.${channels}`,
    details: { developerId: resolved.developerId, via: resolved.via, project: input.project },
    snapshot: { grant: current },
    apply: async () => revokeProjectAccess(deps.actions, input.project, resolved.developerId),
  };
};

const planEndSessions: Planner = async (deps, _identity, input) => {
  if (input.kind !== "revoke_signin") throw new Error("wrong planner");
  const resolved = await resolveDeveloper(deps.actions, input.developer);
  if (resolved.profile === undefined) throw agentXError("NOT_FOUND", `${describeDeveloper(resolved)} has never signed in, so there is no sign-in to end`);
  return {
    effect: `End every AgentX sign-in session of ${describeDeveloper(resolved)}. Their AI tools stop reaching AgentX at once; they may sign in again with agentx login. Their running tasks keep running.`,
    details: { developerId: resolved.developerId, via: resolved.via },
    snapshot: { sessionsEndedAt: resolved.profile.sessionsEndedAt ?? null },
    apply: async () => endSessions(deps.actions, resolved.developerId),
  };
};

const planLimits: Planner = async (deps, _identity, input) => {
  if (input.kind !== "set_workspace_limits") throw new Error("wrong planner");
  if (input.perPerson === undefined && input.perOrganization === undefined) throw agentXError("CONFIG_INVALID", "give per_person, per_organization or both");
  const setting = await getStateItem(deps.reads, { pk: "SETTINGS", sk: "WORKSPACE_LIMITS" });
  const current = await readWorkspaceLimits(deps.reads.documentClient, deps.reads.tableName, deps.reads.limitDefaults, deps.reads.log);
  const next = { perPerson: input.perPerson ?? current.member, perOrganization: input.perOrganization ?? current.organization };
  if (next.perPerson > next.perOrganization) throw agentXError("CONFIG_INVALID", `the per-person limit (${next.perPerson}) cannot be more than the organization limit (${next.perOrganization})`);
  const team = deps.reads.slackTeamId;
  const members = team === undefined ? [] : await queryAllItems(deps.reads, `SLACK_LIMIT#${team}`, "MEMBER#");
  const over = members.filter((item) => typeof item.count === "number" && item.count >= next.perPerson).map((item) => `Slack member ${String(item.sk).slice("MEMBER#".length)} (${String(item.count)} open)`);
  const organizationCount = (team === undefined ? 0 : Number((await getStateItem(deps.reads, { pk: `SLACK_LIMIT#${team}`, sk: "ORGANIZATION" }))?.count ?? 0))
    + Number((await getStateItem(deps.reads, { pk: "DEVELOPER_LIMIT#ORGANIZATION", sk: "ORGANIZATION" }))?.count ?? 0);
  const change = (value: number, was: number) => (value === was ? "(unchanged)" : `(now ${was})`);
  const orgNote = organizationCount >= next.perOrganization ? " The organization is at or over its new limit." : "";
  return {
    effect: `Set the workspace limits to ${next.perPerson} per person ${change(next.perPerson, current.member)} and ${next.perOrganization} for the organization ${change(next.perOrganization, current.organization)}. Open workspaces: ${organizationCount} of ${next.perOrganization}.${over.length === 0 ? "" : ` At or over ${next.perPerson} per person: ${over.join(", ")}.`}${orgNote} Existing workspaces keep running; a new one is refused while its person or the organization is at the limit.`,
    details: { current: { perPerson: current.member, perOrganization: current.organization, source: current.source }, next, organizationCount, over: over.length },
    snapshot: { setting: setting === undefined ? null : { perPerson: setting.perPerson, perOrganization: setting.perOrganization, updatedAt: setting.updatedAt ?? null }, defaults: deps.reads.limitDefaults },
    apply: async (applier) => setWorkspaceLimits(deps.actions, { issuer: applier.issuer, subject: applier.subject }, next),
  };
};

Object.assign(PLANNERS, {
  stop_workspace: planStop,
  grant_project_access: planGrant,
  revoke_project_access: planRevoke,
  revoke_signin: planEndSessions,
  set_workspace_limits: planLimits,
});
```

(`Object.assign` keeps Task 5's object as the one registry; writing the five entries into its
literal is the same and also fine.) Developers without a Slack link count on their own
`DEVELOPER_LIMIT#<id>` rows, which are not listed by person (they are one partition each); the
organization's total includes them.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/contract/admin-change-plans-access.test.ts tests/contract/admin-change-plans.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/broker/src/aws/admin-change-plans.ts tests/contract/admin-change-plans-access.test.ts
git commit -m "feat(broker): change plans for workspaces, project access, sign-ins and the limits (spec 025 phase 25e)"
```

---
### Task 7: The change routes, apply at most once, and the Slack press

E2 to E5, E13, E14, FR-039, FR-040, FR-051's steps, FR-052's logs and metric; SC-005's matrix at
the route level. **Depends on Q6** (the `cli` method) and **Q9** (outcomes as codes).

**Files:**
- Create: `packages/broker/src/aws/admin-changes.ts`
- Modify: `packages/broker/src/aws/broker.ts` (the dependencies; the route; the press event)
- Modify: `tests/support/admin-read-broker.ts` (`admin()` takes a `body`)
- Create: `tests/support/admin-change-broker.ts`
- Test: `tests/contract/admin-change-routes.test.ts`

**Interfaces:**
- Consumes: Task 1's schemas and keys; Task 2's `proposalItem`, `auditStepItem`, `writeProposal`,
  `recordAuditStep`, `recordRefusedAttempt`, `readAudit`, `listAudit`, `logChangeStep`,
  `outcomeMetric`; Tasks 5 and 6's `planChange`, `stateHash`, `PlanDependencies`; 25d's
  `adminReader` (admin-reads.ts) for the admin's display name and Slack link.
- Produces:
  - `export interface AdminChangeDependencies { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string; audit: AuditStore; plans: PlanDependencies; identity?: { profile(identity: AuthenticatedIdentity, authorization: string | undefined): Promise<{ name?: string; email?: string }>; me(identity: AuthenticatedIdentity, authorization: string | undefined): Promise<AdminMeResponse> }; slackTeamId?: string; confirm: { elicitation: boolean; slack: boolean }; now(): number; newId(): string; log(entry: Record<string, unknown>): void }`;
  - `export interface PendingChange` (E2's fields, as stored);
  - `export async function routeAdminChange(deps: AdminChangeDependencies | undefined, identity: AuthenticatedIdentity, request: { method: string; headers: Record<string, string | undefined>; body: unknown }, url: URL): Promise<{ status: number; body: unknown } | undefined>`;
  - `export async function pressAdminChange(deps: AdminChangeDependencies, event: AdminChangePressEvent): Promise<{ outcome: "applied" | "declined" | "refused" | "expired" | "not_pending" | "stale" | "failed" | "not_found"; changeId: string; traceId?: string }>`;
  - `AwsBrokerDependencies.adminChanges?: { confirm?: { elicitation: boolean; slack: boolean }; now?(): number; metric?(outcome: AdminChangeOutcome): void }`;
  - test support: `createAdminChangeBroker(options?: { elicitation?: boolean; slack?: boolean; slackLinked?: boolean })`
    with `propose`, `get`, `list`, `slack`, `apply`, `decline`, `press`, `audit`, `clock`, `metrics`;
    `ADMIN_SLACK = "U0ADA00001"`.

- [ ] **Step 1: The test support**

In `tests/support/admin-read-broker.ts`, give `admin()`'s options `body?: unknown` and send it:
`...(call.body === undefined ? {} : { body: JSON.stringify(call.body) })` in the event. Then:

```ts
// tests/support/admin-change-broker.ts
// Spec 025 phase 25e: the admin read broker with admin changes on, a clock the changes read, a
// linked Slack user for the admin, and the ingress's press event.
import { randomUUID } from "node:crypto";
import type { AdminChangeInput } from "@agentx/contracts";
import { createAdminReadBroker } from "./admin-read-broker.js";
import { SLACK_TEAM, issuer } from "./slack-broker.js";

export const ADMIN_SLACK = "U0ADA00001";
export const TRACE = "trace-test-0001";

export async function createAdminChangeBroker(options: { elicitation?: boolean; slack?: boolean; slackLinked?: boolean } = {}) {
  let now = Date.now();
  const clock = { now: () => now, advance: (ms: number) => { now += ms; } };
  const metrics: string[] = [];
  // 25d's A12: the admin's verified email comes from the issuer's userinfo endpoint.
  const fetch = (async (input: string | URL | Request) => (String(input).endsWith("/.well-known/openid-configuration")
    ? Response.json({ issuer, userinfo_endpoint: "https://identity.example.test/userinfo" })
    : Response.json({ sub: "admin-subject", email: "ada@example.com", email_verified: true, name: "Ada" }))) as unknown as typeof globalThis.fetch;
  const slackUserByEmail = async () => (options.slackLinked === false ? { ok: true as const } : { ok: true as const, userId: ADMIN_SLACK });
  const harness = await createAdminReadBroker({
    developerExtra: {
      slackUserByEmail,
      endDeveloperSessions: async () => ({ ok: true }),
      channelByName: async ({ name }) => (name === "ledger-dev" ? { ok: true, channel: { channelId: "C0LEDGER01", name } } : { ok: true }),
    },
    brokerExtra: {
      // A test's own `me` replaces the production default whole, so it names the lookup too.
      adminReads: { me: { issuer, fetch, slackUserByEmail } },
      // A credential registry, so agentx_admin_register_credential can plan; its secret reads as nothing useful.
      connectorCredentials: { secrets: { read: async () => "{}" }, githubApp: { ref: "github-app", secretName: "arn:aws:secretsmanager:us-east-1:111122223333:secret:github-app" } },
      adminChanges: { confirm: { elicitation: options.elicitation ?? true, slack: options.slack ?? true }, now: clock.now, metric: (outcome: string) => metrics.push(outcome) },
    },
  });
  const call = (method: string, path: string, body?: unknown, subject = "admin-subject") => harness.admin(method, path, { subject, headers: { "x-agentx-trace-id": TRACE }, ...(body === undefined ? {} : { body }) });
  const propose = (change: AdminChangeInput, methods: string[] = ["elicitation"], requestId: string = randomUUID(), subject?: string) =>
    call("POST", "/v1/admin/changes", { requestId, change, client: { cliVersion: "0.0.7", mcpClient: { name: "claude-code", version: "2.1.0" } }, methods }, subject);
  const press = async (changeId: string, click: "confirm" | "cancel", slackUserId = ADMIN_SLACK, teamId = SLACK_TEAM) => {
    const response = await harness.handler({ source: "agentx.slack-ingress", action: "admin-change-press", changeId, click, slackUserId, teamId });
    return JSON.parse(response.body) as { outcome: string; changeId: string; traceId?: string };
  };
  return {
    ...harness, clock, metrics, propose, press,
    get: (id: string) => call("GET", `/v1/admin/changes/${id}`),
    list: (query = "") => call("GET", `/v1/admin/changes${query}`),
    slack: (id: string, subject?: string) => call("POST", `/v1/admin/changes/${id}/slack`, {}, subject),
    apply: (id: string, method = "elicitation", subject?: string) => call("POST", `/v1/admin/changes/${id}/apply`, { method }, subject),
    decline: (id: string, reason = "declined") => call("POST", `/v1/admin/changes/${id}/decline`, { method: "elicitation", reason }),
    audit: (id: string) => harness.db.get(`CHANGE#${id}`, "AUDIT") as Record<string, unknown> | undefined,
  };
}
```

- [ ] **Step 2: Write the failing test**

```ts
// tests/contract/admin-change-routes.test.ts
// Spec 025 FR-039 to FR-041, FR-051, FR-052, SC-005 and SC-011 at the routes: a change is planned,
// stored and audited, and applies at most once, only after a valid confirmation.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ADMIN_SLACK, TRACE, createAdminChangeBroker } from "../support/admin-change-broker.js";
import { SLACK_CHANNEL, SLACK_TEAM } from "../support/slack-broker.js";

const BIND = { kind: "bind_channel" as const, channel: "#ledger-dev", project: "payments" };
const binding = (db: { get(pk: string, sk: string): unknown }) => db.get(`SLACK_BINDING#${SLACK_TEAM}`, "CHANNEL#C0LEDGER01") as { projectName?: string } | undefined;
const changeId = (answer: { body: Record<string, unknown> }) => (answer.body.change as { changeId: string }).changeId;
let lines: string[] = [];
beforeEach(() => { lines = []; vi.spyOn(console, "log").mockImplementation((line: string) => { lines.push(String(line)); }); });
afterEach(() => vi.restoreAllMocks());
const logged = (event: string) => lines.map((line) => { try { return JSON.parse(line) as Record<string, unknown>; } catch { return {}; } }).filter((entry) => entry.event === event);

describe("planning a change (FR-039)", () => {
  it("stores a pending change and its audit record, and changes nothing", async () => {
    const broker = await createAdminChangeBroker();
    const answer = await broker.propose(BIND);
    expect(answer.status).toBe(201);
    expect(answer.body.change).toMatchObject({ kind: "bind_channel", status: "pending", methodsOffered: ["elicitation"], effect: expect.stringContaining("Bind channel #ledger-dev (C0LEDGER01) to project payments.") as unknown });
    expect(binding(broker.db)).toBeUndefined();
    const id = changeId(answer);
    expect(broker.audit(id)).toMatchObject({
      status: "pending", traceId: TRACE, admin: { issuer: expect.any(String) as unknown, subject: "admin-subject", displayName: "Ada" },
      client: { cliVersion: "0.0.7", mcpClientName: "claude-code", mcpClientVersion: "2.1.0" }, methodsOffered: ["elicitation"], proposedAt: expect.any(String) as unknown,
    });
    expect(broker.audit(id)).not.toHaveProperty("outcome");
    expect(logged("admin_change.proposed")).toEqual([expect.objectContaining({ changeId: id, traceId: TRACE, kind: "bind_channel" })]);
  });

  it("answers the same change for a repeated request ID", async () => {
    const broker = await createAdminChangeBroker();
    const first = await broker.propose(BIND, ["elicitation"], "77777777-7777-4777-8777-777777777777");
    const second = await broker.propose(BIND, ["elicitation"], "77777777-7777-4777-8777-777777777777");
    expect(second.status).toBe(200);
    expect(changeId(second)).toBe(changeId(first));
  });

  it("offers only the methods the environment and the admin allow, and refuses when none is left (FR-041)", async () => {
    const off = await createAdminChangeBroker({ elicitation: false, slackLinked: false });
    const refused = await off.propose(BIND, ["elicitation", "slack"]);
    expect(refused.body.error).toEqual({ code: "CONFIRMATION_UNAVAILABLE", message: "no confirmation method is available: the environment does not allow the pop-up, and your admin sign-in matches no Slack user; use agentx admin commands instead" });
    const audited = off.db.find((item) => item.entityType === "ADMIN_CHANGE_AUDIT");
    expect(audited).toEqual([expect.objectContaining({ status: "failed", outcome: "failed", error: expect.objectContaining({ code: "CONFIRMATION_UNAVAILABLE" }) as unknown })]);
    const slackOnly = await createAdminChangeBroker({ elicitation: false });
    expect((await slackOnly.propose(BIND, ["elicitation", "slack"])).body.change).toMatchObject({ methodsOffered: ["slack"] });
  });

  it("audits a request whose plan is refused, and stores no pending change", async () => {
    const broker = await createAdminChangeBroker();
    expect((await broker.propose({ kind: "bind_channel", channel: "C0LEDGER01", project: "ledger" })).body.error).toMatchObject({ code: "NOT_FOUND" });
    expect(broker.db.find((item) => item.entityType === "ADMIN_CHANGE")).toEqual([]);
    expect(broker.db.find((item) => item.entityType === "ADMIN_CHANGE_AUDIT")).toEqual([expect.objectContaining({ outcome: "failed", error: expect.objectContaining({ code: "NOT_FOUND" }) as unknown })]);
  });
});

describe("confirming by the pop-up (FR-040, SC-005)", () => {
  it("applies once through the existing handler, and refuses the reused confirmation", async () => {
    const broker = await createAdminChangeBroker();
    const id = changeId(await broker.propose(BIND));
    const applied = await broker.apply(id);
    expect(applied.body.change).toMatchObject({ status: "applied", methodUsed: "elicitation" });
    expect(binding(broker.db)).toMatchObject({ projectName: "payments" });
    expect(broker.audit(id)).toMatchObject({ status: "applied", outcome: "confirmed", methodUsed: "elicitation", appliedAt: expect.any(String) as unknown });
    expect(broker.metrics).toEqual(["confirmed"]);
    const again = await broker.apply(id);
    expect(again.body.error).toMatchObject({ code: "CONFIRMATION_EXPIRED" });
    expect((broker.audit(id)?.refusedAttempts as unknown[])).toEqual([expect.objectContaining({ reason: "not_pending" })]);
    expect(logged("admin_change.applied")).toEqual([expect.objectContaining({ changeId: id, traceId: TRACE })]);
  });

  it("refuses another admin's apply, recording it, and leaves the change pending", async () => {
    const broker = await createAdminChangeBroker();
    const id = changeId(await broker.propose(BIND));
    expect((await broker.apply(id, "elicitation", "another-admin")).body.error).toEqual({ code: "FORBIDDEN", message: "only the admin who asked for this change can confirm or decline it" });
    expect(binding(broker.db)).toBeUndefined();
    expect(broker.audit(id)).toMatchObject({ status: "pending", refusedAttempts: [expect.objectContaining({ reason: "another_admin" })] });
  });

  it("marks a declined change declined, and a later apply is refused", async () => {
    const broker = await createAdminChangeBroker();
    const id = changeId(await broker.propose(BIND));
    expect((await broker.decline(id)).body.change).toMatchObject({ status: "declined" });
    expect(broker.audit(id)).toMatchObject({ outcome: "declined", methodUsed: "elicitation" });
    expect((await broker.apply(id)).body.error).toMatchObject({ code: "CONFIRMATION_DECLINED" });
    expect(binding(broker.db)).toBeUndefined();
  });

  it("expires after 10 minutes: an apply is refused, and every read shows it expired", async () => {
    const broker = await createAdminChangeBroker();
    const id = changeId(await broker.propose(BIND));
    broker.clock.advance(10 * 60_000 + 1);
    expect((await broker.get(id)).body.change).toMatchObject({ status: "expired" });
    expect((await broker.apply(id)).body.error).toMatchObject({ code: "CONFIRMATION_EXPIRED" });
    expect(broker.audit(id)).toMatchObject({ outcome: "expired", expiredAt: expect.any(String) as unknown });
    expect(binding(broker.db)).toBeUndefined();
  });

  it("refuses a stale change and leaves the binding as the other admin set it", async () => {
    const broker = await createAdminChangeBroker();
    const id = changeId(await broker.propose(BIND));
    broker.db.set({ pk: `SLACK_BINDING#${SLACK_TEAM}`, sk: "CHANNEL#C0LEDGER01", entityType: "SLACK_BINDING", teamId: SLACK_TEAM, channelId: "C0LEDGER01", projectName: "payments-legacy", updatedAt: new Date().toISOString() });
    const answer = await broker.apply(id);
    expect(answer.body.error).toMatchObject({ code: "CHANGE_STALE", message: expect.stringContaining(`change ${id}`) as unknown });
    expect(binding(broker.db)).toMatchObject({ projectName: "payments-legacy" });
    expect(broker.audit(id)).toMatchObject({ status: "failed", outcome: "failed", error: expect.objectContaining({ code: "CHANGE_STALE" }) as unknown, refusedAttempts: [expect.objectContaining({ reason: "stale_state" })] });
  });

  it("refuses the pop-up when the environment turned it off, even for a change that offered it earlier", async () => {
    const broker = await createAdminChangeBroker({ elicitation: false });
    const id = changeId(await broker.propose(BIND, ["cli"]));
    expect((await broker.apply(id, "elicitation")).body.error).toMatchObject({ code: "CONFIRMATION_UNAVAILABLE" });
    expect((await broker.apply(id, "cli")).body.change).toMatchObject({ status: "applied", methodUsed: "cli" });
  });
});

describe("confirming by the Slack button (FR-041, E13, E14)", () => {
  it("applies a press after the wait, once, and refuses the second press", async () => {
    const broker = await createAdminChangeBroker();
    const id = changeId(await broker.propose(BIND, ["slack"]));
    expect((await broker.slack(id)).body.change).toMatchObject({ status: "pending" });
    expect(broker.audit(id)).toMatchObject({ confirmationRequestedAt: expect.any(String) as unknown });
    broker.clock.advance(6 * 60_000);
    expect(await broker.press(id, "confirm")).toMatchObject({ outcome: "applied", changeId: id, traceId: TRACE });
    expect(binding(broker.db)).toMatchObject({ projectName: "payments" });
    expect(broker.audit(id)).toMatchObject({ outcome: "confirmed", methodUsed: "slack", pressedBy: ADMIN_SLACK });
    expect(await broker.press(id, "confirm")).toMatchObject({ outcome: "not_pending" });
    expect(broker.metrics).toEqual(["confirmed"]);
  });

  it("refuses another person's press and a press from another team, recording both, and stays pending", async () => {
    const broker = await createAdminChangeBroker();
    const id = changeId(await broker.propose(BIND, ["slack"]));
    await broker.slack(id);
    expect(await broker.press(id, "confirm", "U0BOB00002")).toMatchObject({ outcome: "refused" });
    expect(await broker.press(id, "confirm", ADMIN_SLACK, "T0OTHERTEAM")).toMatchObject({ outcome: "refused" });
    expect(binding(broker.db)).toBeUndefined();
    expect(broker.audit(id)).toMatchObject({ status: "pending", refusedAttempts: [expect.objectContaining({ reason: "another_person", slackUserId: "U0BOB00002" }), expect.objectContaining({ reason: "wrong_team" })] });
  });

  it("declines on Cancel, and ignores a press before the Slack step started or after expiry", async () => {
    const broker = await createAdminChangeBroker();
    const early = changeId(await broker.propose(BIND, ["slack"]));
    expect(await broker.press(early, "confirm")).toMatchObject({ outcome: "not_pending" });
    await broker.slack(early);
    expect(await broker.press(early, "cancel")).toMatchObject({ outcome: "declined" });
    expect(broker.audit(early)).toMatchObject({ outcome: "declined", methodUsed: "slack", pressedBy: ADMIN_SLACK });
    const late = changeId(await broker.propose({ kind: "unbind_channel", channel: SLACK_CHANNEL }, ["slack"]));
    await broker.slack(late);
    broker.clock.advance(10 * 60_000 + 1);
    expect(await broker.press(late, "confirm")).toMatchObject({ outcome: "expired" });
    expect(broker.db.get(`SLACK_BINDING#${SLACK_TEAM}`, `CHANNEL#${SLACK_CHANNEL}`)).toBeDefined();
  });

  it("refuses the Slack step when it was not offered", async () => {
    const broker = await createAdminChangeBroker();
    const id = changeId(await broker.propose(BIND, ["elicitation"]));
    expect((await broker.slack(id)).body.error).toMatchObject({ code: "CONFIRMATION_UNAVAILABLE" });
  });
});

describe("reading the records (FR-052)", () => {
  it("lists records newest first, filters them, and shows an expired one as expired", async () => {
    const broker = await createAdminChangeBroker();
    const applied = changeId(await broker.propose(BIND));
    await broker.apply(applied);
    const waiting = changeId(await broker.propose({ kind: "unbind_channel", channel: SLACK_CHANNEL }));
    broker.clock.advance(10 * 60_000 + 1);
    const list = await broker.list(`?since=${encodeURIComponent(new Date(Date.now() - 3_600_000).toISOString())}`);
    expect((list.body.changes as Array<{ changeId: string; outcome?: string }>).map((change) => [change.changeId, change.outcome])).toEqual([[waiting, "expired"], [applied, "confirmed"]]);
    expect((await broker.list(`?outcome=confirmed&since=${encodeURIComponent(new Date(Date.now() - 3_600_000).toISOString())}`)).body.changes).toHaveLength(1);
  });

  it("refuses every change route without the admin claim, and in a deployment without admin changes", async () => {
    const broker = await createAdminChangeBroker();
    expect((await broker.admin("GET", "/v1/admin/changes", { admin: false })).body.error).toMatchObject({ code: "FORBIDDEN" });
    expect((await broker.admin("POST", "/v1/admin/changes", { admin: false, body: {} })).body.error).toMatchObject({ code: "FORBIDDEN" });
  });

  it("reads a change stuck applying for over 2 minutes as failed", async () => {
    const broker = await createAdminChangeBroker();
    const id = changeId(await broker.propose(BIND));
    const pending = broker.db.get(`ADMIN_CHANGE#${id}`, "META")!;
    broker.db.set({ ...pending, status: "applying", claimedAt: new Date(broker.clock.now()).toISOString() });
    broker.clock.advance(2 * 60_000 + 1);
    expect((await broker.get(id)).body.change).toMatchObject({ status: "failed", error: { code: "RUNTIME_UNAVAILABLE", message: "the apply did not finish; check the state, then ask again" } });
  });
});
```

A legacy deployment's refusal ("admin changes are not set up in this deployment") is tested with
`createAdminBroker()` (`tests/support/admin-broker.ts`, no developer sign-in):

```ts
import { adminCall, createAdminBroker } from "../support/admin-broker.js";
describe("the legacy deployment", () => {
  it("answers NOT_FOUND for the change routes", async () => {
    const { handler } = await createAdminBroker();
    expect((await adminCall(handler, { method: "GET", path: "/v1/admin/changes" })).body.error).toEqual({ code: "NOT_FOUND", message: "admin changes are not set up in this deployment" });
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run tests/contract/admin-change-routes.test.ts`
Expected: FAIL: the change routes answer the catch-all `FORBIDDEN`.

- [ ] **Step 4: Write the routes**

```ts
// packages/broker/src/aws/admin-changes.ts
// Spec 025 FR-039 to FR-041, FR-051, FR-052: admin changes. A change is planned and stored with
// its audit record; it applies at most once, only after a confirmation by an offered method, and
// only while the state it was planned against still holds. Every step writes its audit step in the
// same transaction as the change's own state, and one log line with the change and trace IDs.
import { randomUUID } from "node:crypto";
import { GetCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  ADMIN_CHANGE_APPLYING_STALE_MS, ADMIN_CHANGE_EFFECT_MAX, ADMIN_CHANGE_TTL_MS, ADMIN_LIST_MAX, AdminChangeOutcomeSchema, AgentXError, AgentXErrorCodeSchema,
  ApplyAdminChangeRequestSchema, DeclineAdminChangeRequestSchema, ProposeAdminChangeRequestSchema, adminChangeKey, adminChangeRequestKey, agentXError,
  outcomeOfStatus, redactSecrets, redactText,
  type AdminChangeAuditRecord, type AdminChangeInput, type AdminChangeKind, type AdminChangePressEvent, type AdminChangeStatus, type AdminChangeView, type AdminMeResponse, type ConfirmationMethod,
} from "@agentx/contracts";
import type { AuthenticatedIdentity } from "../auth.js";
import { auditStepItem, listAudit, logChangeStep, proposalItem, readAudit, recordRefusedAttempt, writeProposal, type AuditStep, type AuditStore } from "./admin-change-audit.js";
import { planChange, stateHash, type PlanDependencies } from "./admin-change-plans.js";

export interface AdminChangeDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  audit: AuditStore;
  plans: PlanDependencies;
  identity?: {
    profile(identity: AuthenticatedIdentity, authorization: string | undefined): Promise<{ name?: string; email?: string }>;
    me(identity: AuthenticatedIdentity, authorization: string | undefined): Promise<AdminMeResponse>;
  };
  slackTeamId?: string;
  confirm: { elicitation: boolean; slack: boolean };
  now(): number;
  newId(): string;
  log(entry: Record<string, unknown>): void;
}

export interface PendingChange {
  pk: string; sk: "META"; entityType: "ADMIN_CHANGE";
  changeId: string; kind: AdminChangeKind; input: AdminChangeInput;
  effect: string; details: Record<string, unknown>; stateHash: string;
  admin: { issuer: string; subject: string; ownerKey: string; displayName?: string };
  slackUserId?: string;
  methodsOffered: ConfirmationMethod[];
  status: AdminChangeStatus;
  createdAt: string; expiresAt: string; traceId: string;
  proposedAt: string;
  claimedAt?: string; slackRequestedAt?: string;
  dm?: { channel: string; ts: string; postedAt: string; editedAt?: string };
  methodUsed?: ConfirmationMethod; pressedBy?: string;
  result?: Record<string, unknown>; error?: { code: string; message: string };
}

const iso = (ms: number) => new Date(ms).toISOString();
const TRACE = /^[A-Za-z0-9._-]{1,128}$/;
const stripCode = (message: string, code: string) => (message.startsWith(`${code}: `) ? message.slice(code.length + 2) : message);
const errorOf = (error: unknown): { code: string; message: string } => (error instanceof AgentXError
  ? { code: error.code, message: redactText(stripCode(error.message, error.code)).slice(0, 1_000) }
  : { code: "RUNTIME_UNAVAILABLE", message: "the change could not be applied" });

function viewOf(change: PendingChange): AdminChangeView {
  return {
    changeId: change.changeId, kind: change.kind, status: change.status, effect: change.effect, methodsOffered: change.methodsOffered,
    createdAt: change.createdAt, expiresAt: change.expiresAt,
    ...(change.methodUsed === undefined ? {} : { methodUsed: change.methodUsed }),
    ...(change.result === undefined ? {} : { result: change.result }),
    ...(change.error === undefined ? {} : { error: change.error }),
  };
}

async function getPending(deps: AdminChangeDependencies, changeId: string): Promise<PendingChange | undefined> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: adminChangeKey(changeId), ConsistentRead: true })) as { Item?: PendingChange };
  return response.Item;
}

const conditional = (error: unknown) => error instanceof Error && (error.name === "ConditionalCheckFailedException" || error.name === "TransactionCanceledException");

/** Moves the change from `from` to `to` and steps its audit record, in one transaction; false when it had moved on. */
async function transition(deps: AdminChangeDependencies, change: PendingChange, from: AdminChangeStatus, to: AdminChangeStatus, step: AuditStep, fields: Record<string, unknown> = {}): Promise<boolean> {
  const sets = { ...fields };
  const names: Record<string, string> = { "#status": "status" };
  const values: Record<string, unknown> = { ":to": to, ":from": from };
  const assignments = ["#status = :to", ...Object.entries(sets).map(([name, value], index) => { names[`#g${index}`] = name; values[`:g${index}`] = value; return `#g${index} = :g${index}`; })];
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Update: { TableName: deps.tableName, Key: adminChangeKey(change.changeId), UpdateExpression: `SET ${assignments.join(", ")}`, ConditionExpression: "#status = :from", ExpressionAttributeNames: names, ExpressionAttributeValues: values } },
      auditStepItem(deps.audit.tableName, change.changeId, { ...step, status: to }),
    ] }));
  } catch (error) {
    if (conditional(error)) return false;
    throw error;
  }
  const outcome = outcomeOfStatus(to);
  if (outcome !== undefined) deps.audit.metric(outcome);
  return true;
}

/** E3, E5: a pending change past its 10 minutes is expired, and one stuck applying is failed, when touched. */
async function settle(deps: AdminChangeDependencies, change: PendingChange): Promise<PendingChange> {
  const now = deps.now();
  if (change.status === "pending" && now >= Date.parse(change.expiresAt)) {
    const expiredAt = iso(now);
    await transition(deps, change, "pending", "expired", { expiredAt });
    logChangeStep(deps.log, "expired", { changeId: change.changeId, traceId: change.traceId, kind: change.kind, outcome: "expired" });
    return { ...change, status: "expired" };
  }
  if (change.status === "applying" && change.claimedAt !== undefined && now - Date.parse(change.claimedAt) > ADMIN_CHANGE_APPLYING_STALE_MS) {
    const error = { code: "RUNTIME_UNAVAILABLE", message: "the apply did not finish; check the state, then ask again" };
    await transition(deps, change, "applying", "failed", { failedAt: iso(now), error }, { error, failedAt: iso(now) });
    return { ...change, status: "failed", error };
  }
  return change;
}

/** Q9: why a change that is not pending can no longer be confirmed. */
function refusalFor(change: PendingChange): AgentXError {
  switch (change.status) {
    case "declined": return agentXError("CONFIRMATION_DECLINED", `change ${change.changeId} was declined; ask for the change again`);
    case "expired": return agentXError("CONFIRMATION_EXPIRED", `change ${change.changeId} expired at ${change.expiresAt}; ask for the change again`);
    case "applied": return agentXError("CONFIRMATION_EXPIRED", `change ${change.changeId} was already applied; a change applies at most once`);
    case "applying": return agentXError("CONFIRMATION_EXPIRED", `change ${change.changeId} is being applied now; read it again in a moment`);
    case "failed": {
      const code = AgentXErrorCodeSchema.safeParse(change.error?.code);
      return agentXError(code.success ? code.data : "RUNTIME_UNAVAILABLE", `change ${change.changeId} failed: ${change.error?.message ?? "it could not be applied"}`);
    }
    default: return agentXError("CONFIRMATION_EXPIRED", `change ${change.changeId} is no longer pending`);
  }
}

const storedIdentity = (change: PendingChange): AuthenticatedIdentity => ({ issuer: change.admin.issuer, subject: change.admin.subject, ownerKey: change.admin.ownerKey, isAdministrator: true, claims: {} });

async function requireOwn(deps: AdminChangeDependencies, identity: AuthenticatedIdentity, changeId: string): Promise<PendingChange> {
  const change = await getPending(deps, changeId);
  if (change === undefined) throw agentXError("NOT_FOUND", `no change ${changeId}`);
  if (change.admin.issuer !== identity.issuer || change.admin.subject !== identity.subject) {
    await recordRefusedAttempt(deps.audit, changeId, { at: iso(deps.now()), reason: "another_admin" });
    throw agentXError("FORBIDDEN", "only the admin who asked for this change can confirm or decline it");
  }
  return change;
}

async function propose(deps: AdminChangeDependencies, identity: AuthenticatedIdentity, authorization: string | undefined, value: unknown, traceId: string): Promise<{ status: number; body: unknown }> {
  const parsed = ProposeAdminChangeRequestSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw agentXError("CONFIG_INVALID", `invalid change request: ${issue?.path.join(".") || "request"}: ${issue?.message ?? "invalid"}`);
  }
  const request = parsed.data;
  const pointer = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: adminChangeRequestKey(identity.ownerKey, request.requestId), ConsistentRead: true })) as { Item?: { changeId?: string } };
  if (typeof pointer.Item?.changeId === "string") {
    const existing = await getPending(deps, pointer.Item.changeId);
    if (existing !== undefined) return { status: 200, body: { change: viewOf(await settle(deps, existing)) } };
  }
  const now = deps.now();
  const changeId = deps.newId();
  const proposedAt = iso(now);
  const profile = deps.identity === undefined ? {} : await deps.identity.profile(identity, authorization);
  const admin = { issuer: identity.issuer, subject: identity.subject, ...(profile.name === undefined ? {} : { displayName: profile.name }) };
  const client = { cliVersion: request.client.cliVersion, ...(request.client.mcpClient === undefined ? {} : { mcpClientName: request.client.mcpClient.name, ...(request.client.mcpClient.version === undefined ? {} : { mcpClientVersion: request.client.mcpClient.version }) }) };
  const base = { changeId, kind: request.change.kind, traceId, admin, client, proposedAt };
  let plan: Awaited<ReturnType<typeof planChange>>;
  try {
    plan = await planChange(deps.plans, identity, request.change);
  } catch (error) {
    // FR-051: every request has its audit record, whatever its outcome.
    await writeProposal(deps.audit, { ...base, change: request.change as Record<string, unknown>, effect: "", methodsOffered: [], status: "failed", failedAt: proposedAt, error: errorOf(error) });
    logChangeStep(deps.log, "plan_refused", { changeId, traceId, kind: request.change.kind, error: errorOf(error).code });
    throw error;
  }
  const effect = redactText(plan.effect).slice(0, ADMIN_CHANGE_EFFECT_MAX);
  const change = redactSecrets({ ...request.change, details: plan.details }) as Record<string, unknown>;
  const offered: ConfirmationMethod[] = [];
  let slackUserId: string | undefined;
  for (const method of request.methods) {
    if (offered.includes(method)) continue;
    if (method === "cli") offered.push("cli");
    if (method === "elicitation" && deps.confirm.elicitation) offered.push("elicitation");
    if (method === "slack" && deps.confirm.slack && deps.identity !== undefined) {
      const me = await deps.identity.me(identity, authorization);
      if (me.slack.linked && me.slack.userId !== undefined) {
        slackUserId = me.slack.userId;
        offered.push("slack");
      }
    }
  }
  if (offered.length === 0) {
    const error = { code: "CONFIRMATION_UNAVAILABLE", message: "no confirmation method is available: the environment does not allow the pop-up, and your admin sign-in matches no Slack user; use agentx admin commands instead" };
    await writeProposal(deps.audit, { ...base, change, effect, methodsOffered: [], status: "failed", failedAt: proposedAt, error });
    logChangeStep(deps.log, "unconfirmable", { changeId, traceId, kind: request.change.kind });
    throw agentXError("CONFIRMATION_UNAVAILABLE", error.message);
  }
  const pending: PendingChange = {
    ...adminChangeKey(changeId), entityType: "ADMIN_CHANGE", changeId, kind: request.change.kind, input: request.change, effect, details: plan.details,
    stateHash: stateHash(plan.snapshot), admin: { ...admin, ownerKey: identity.ownerKey }, ...(slackUserId === undefined ? {} : { slackUserId }),
    methodsOffered: offered, status: "pending", createdAt: proposedAt, proposedAt, expiresAt: iso(now + ADMIN_CHANGE_TTL_MS), traceId,
  };
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: deps.tableName, Item: pending, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: deps.tableName, Item: { ...adminChangeRequestKey(identity.ownerKey, request.requestId), entityType: "ADMIN_CHANGE_REQUEST", changeId }, ConditionExpression: "attribute_not_exists(pk)" } },
      proposalItem(deps.audit.tableName, { ...base, change, effect, methodsOffered: offered, status: "pending" }),
    ] }));
  } catch (error) {
    if (!conditional(error)) throw error;
    // The same request ID raced this one; answer the change it made.
    const raced = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: adminChangeRequestKey(identity.ownerKey, request.requestId), ConsistentRead: true })) as { Item?: { changeId?: string } };
    const existing = typeof raced.Item?.changeId === "string" ? await getPending(deps, raced.Item.changeId) : undefined;
    if (existing === undefined) throw error;
    return { status: 200, body: { change: viewOf(existing) } };
  }
  logChangeStep(deps.log, "proposed", { changeId, traceId, kind: request.change.kind });
  return { status: 201, body: { change: viewOf(pending) } };
}

/** E5: re-plan and compare the hash, claim with one conditional write, then run the handler. */
async function applyOnce(deps: AdminChangeDependencies, change: PendingChange, applier: AuthenticatedIdentity, how: { method: ConfirmationMethod; pressedBy?: string; requestedAt?: string; answeredAt?: string }): Promise<PendingChange> {
  const now = deps.now();
  const answered = { answeredAt: how.answeredAt ?? iso(now), methodUsed: how.method, ...(how.pressedBy === undefined ? {} : { pressedBy: how.pressedBy }), ...(how.requestedAt === undefined || change.slackRequestedAt !== undefined ? {} : { confirmationRequestedAt: how.requestedAt }) };
  let fresh: Awaited<ReturnType<typeof planChange>> | Error;
  try {
    fresh = await planChange(deps.plans, applier, change.input);
  } catch (error) {
    fresh = error instanceof Error ? error : new Error("plan failed");
  }
  if (fresh instanceof Error || stateHash(fresh.snapshot) !== change.stateHash) {
    await recordRefusedAttempt(deps.audit, change.changeId, { at: iso(now), reason: "stale_state", ...(how.pressedBy === undefined ? {} : { slackUserId: how.pressedBy }) });
    const why = fresh instanceof AgentXError ? ` (${stripCode(fresh.message, fresh.code)})` : "";
    const error = { code: "CHANGE_STALE", message: redactText(`what change ${change.changeId} was planned against has changed${why}; ask for the change again`).slice(0, 1_000) };
    await transition(deps, change, "pending", "failed", { ...answered, failedAt: iso(now), error }, { error, failedAt: iso(now) });
    logChangeStep(deps.log, "stale", { changeId: change.changeId, traceId: change.traceId, kind: change.kind, outcome: "failed" });
    throw agentXError("CHANGE_STALE", error.message);
  }
  try {
    await deps.documentClient.send(new UpdateCommand({
      TableName: deps.tableName, Key: adminChangeKey(change.changeId),
      UpdateExpression: "SET #status = :applying, claimedAt = :now, methodUsed = :method",
      // FR-040: pending, unexpired, and confirmed by an offered method; the planner was checked by the caller.
      ConditionExpression: "#status = :pending AND expiresAt > :now AND contains(methodsOffered, :method)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":applying": "applying", ":pending": "pending", ":now": iso(now), ":method": how.method },
    }));
  } catch (error) {
    if (!conditional(error)) throw error;
    const current = await settle(deps, (await getPending(deps, change.changeId)) ?? change);
    await recordRefusedAttempt(deps.audit, change.changeId, { at: iso(now), reason: current.status === "expired" ? "expired" : "not_pending" });
    throw refusalFor(current);
  }
  logChangeStep(deps.log, "claimed", { changeId: change.changeId, traceId: change.traceId, kind: change.kind });
  const applying = { ...change, status: "applying" as const };
  let result: Record<string, unknown>;
  try {
    result = redactSecrets(await fresh.apply(applier)) as Record<string, unknown>;
  } catch (error) {
    const failure = errorOf(error);
    await transition(deps, applying, "applying", "failed", { ...answered, failedAt: iso(deps.now()), error: failure }, { error: failure, failedAt: iso(deps.now()) });
    logChangeStep(deps.log, "failed", { changeId: change.changeId, traceId: change.traceId, kind: change.kind, outcome: "failed", error: failure.code });
    throw error instanceof AgentXError ? error : agentXError("RUNTIME_UNAVAILABLE", failure.message);
  }
  const appliedAt = iso(deps.now());
  await transition(deps, applying, "applying", "applied", { ...answered, appliedAt, result }, { result, appliedAt });
  logChangeStep(deps.log, "applied", { changeId: change.changeId, traceId: change.traceId, kind: change.kind, outcome: "confirmed" });
  return { ...change, status: "applied", result, methodUsed: how.method };
}

async function apply(deps: AdminChangeDependencies, identity: AuthenticatedIdentity, changeId: string, value: unknown): Promise<{ status: number; body: unknown }> {
  const body = ApplyAdminChangeRequestSchema.safeParse(value);
  if (!body.success) throw agentXError("CONFIG_INVALID", "method must be elicitation or cli");
  const change = await settle(deps, await requireOwn(deps, identity, changeId));
  if (change.status !== "pending") {
    await recordRefusedAttempt(deps.audit, changeId, { at: iso(deps.now()), reason: change.status === "expired" ? "expired" : "not_pending" });
    throw refusalFor(change);
  }
  const allowed = change.methodsOffered.includes(body.data.method) && (body.data.method !== "elicitation" || deps.confirm.elicitation);
  if (!allowed) {
    await recordRefusedAttempt(deps.audit, changeId, { at: iso(deps.now()), reason: "method_not_offered" });
    throw agentXError("CONFIRMATION_UNAVAILABLE", `the ${body.data.method === "cli" ? "CLI" : "pop-up"} confirmation was not offered for change ${changeId}`);
  }
  const applied = await applyOnce(deps, change, identity, { method: body.data.method, ...(body.data.requestedAt === undefined ? {} : { requestedAt: body.data.requestedAt }), ...(body.data.answeredAt === undefined ? {} : { answeredAt: body.data.answeredAt }) });
  return { status: 200, body: { change: viewOf(applied) } };
}

async function decline(deps: AdminChangeDependencies, identity: AuthenticatedIdentity, changeId: string, value: unknown): Promise<{ status: number; body: unknown }> {
  const body = DeclineAdminChangeRequestSchema.safeParse(value);
  if (!body.success) throw agentXError("CONFIG_INVALID", "method must be elicitation or cli, and reason declined, cancelled or failed");
  const change = await settle(deps, await requireOwn(deps, identity, changeId));
  if (change.status !== "pending") throw refusalFor(change);
  const answeredAt = body.data.answeredAt ?? iso(deps.now());
  await transition(deps, change, "pending", "declined", { answeredAt, methodUsed: body.data.method }, { methodUsed: body.data.method });
  logChangeStep(deps.log, "declined", { changeId, traceId: change.traceId, kind: change.kind, outcome: "declined" });
  return { status: 200, body: { change: viewOf({ ...change, status: "declined", methodUsed: body.data.method }) } };
}

async function startSlack(deps: AdminChangeDependencies, identity: AuthenticatedIdentity, changeId: string): Promise<{ status: number; body: unknown }> {
  const change = await settle(deps, await requireOwn(deps, identity, changeId));
  if (change.status !== "pending") throw refusalFor(change);
  if (!change.methodsOffered.includes("slack")) throw agentXError("CONFIRMATION_UNAVAILABLE", `the Slack Confirm button was not offered for change ${changeId}`);
  if (change.slackRequestedAt !== undefined) return { status: 200, body: { change: viewOf(change) } };
  const requestedAt = iso(deps.now());
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Update: { TableName: deps.tableName, Key: adminChangeKey(changeId), UpdateExpression: "SET slackRequestedAt = :at", ConditionExpression: "#status = :pending AND attribute_not_exists(slackRequestedAt)", ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":at": requestedAt, ":pending": "pending" } } },
      auditStepItem(deps.audit.tableName, changeId, { confirmationRequestedAt: requestedAt }),
    ] }));
  } catch (error) {
    if (!conditional(error)) throw error;
  }
  // The notifier sees slackRequestedAt on the stream and posts the direct message (E13).
  logChangeStep(deps.log, "slack_requested", { changeId, traceId: change.traceId, kind: change.kind });
  return { status: 200, body: { change: viewOf({ ...change, slackRequestedAt: requestedAt }) } };
}

/** E14: a Confirm or Cancel press, from the ingress. Only the change's own Slack user, in this team. */
export async function pressAdminChange(deps: AdminChangeDependencies, event: AdminChangePressEvent): Promise<{ outcome: "applied" | "declined" | "refused" | "expired" | "not_pending" | "stale" | "failed" | "not_found"; changeId: string; traceId?: string }> {
  const change = await getPending(deps, event.changeId);
  if (change === undefined) return { outcome: "not_found", changeId: event.changeId };
  const at = iso(deps.now());
  const traced = { changeId: change.changeId, traceId: change.traceId };
  if (deps.slackTeamId !== undefined && event.teamId !== undefined && event.teamId !== deps.slackTeamId) {
    await recordRefusedAttempt(deps.audit, change.changeId, { at, reason: "wrong_team", slackUserId: event.slackUserId });
    logChangeStep(deps.log, "press_refused", { ...traced, error: "wrong_team" });
    return { outcome: "refused", ...traced };
  }
  if (change.slackUserId === undefined || event.slackUserId !== change.slackUserId) {
    await recordRefusedAttempt(deps.audit, change.changeId, { at, reason: "another_person", slackUserId: event.slackUserId });
    logChangeStep(deps.log, "press_refused", { ...traced, error: "another_person" });
    return { outcome: "refused", ...traced };
  }
  const current = await settle(deps, change);
  if (current.status !== "pending" || current.slackRequestedAt === undefined) {
    await recordRefusedAttempt(deps.audit, change.changeId, { at, reason: current.status === "expired" ? "expired" : "not_pending", slackUserId: event.slackUserId });
    return { outcome: current.status === "expired" ? "expired" : "not_pending", ...traced };
  }
  if (event.click === "cancel") {
    await transition(deps, current, "pending", "declined", { answeredAt: at, methodUsed: "slack", pressedBy: event.slackUserId }, { methodUsed: "slack", pressedBy: event.slackUserId });
    logChangeStep(deps.log, "declined", { ...traced, kind: change.kind, outcome: "declined" });
    return { outcome: "declined", ...traced };
  }
  try {
    // D7: a press applies at once, server side, even after the tool call stopped waiting.
    await applyOnce(deps, current, storedIdentity(current), { method: "slack", pressedBy: event.slackUserId, answeredAt: at });
    return { outcome: "applied", ...traced };
  } catch (error) {
    return { outcome: error instanceof AgentXError && error.code === "CHANGE_STALE" ? "stale" : "failed", ...traced };
  }
}

async function list(deps: AdminChangeDependencies, url: URL): Promise<{ status: number; body: unknown }> {
  const now = deps.now();
  const text = (name: string) => url.searchParams.get(name) ?? undefined;
  const since = text("since") ?? iso(now - 7 * 86_400_000);
  if (Number.isNaN(Date.parse(since))) throw agentXError("CONFIG_INVALID", "since must be an ISO 8601 time");
  const until = text("until");
  if (until !== undefined && Number.isNaN(Date.parse(until))) throw agentXError("CONFIG_INVALID", "until must be an ISO 8601 time");
  const outcome = text("outcome") === undefined ? undefined : AdminChangeOutcomeSchema.safeParse(text("outcome"));
  if (outcome !== undefined && !outcome.success) throw agentXError("CONFIG_INVALID", "outcome must be confirmed, declined, expired or failed");
  const limitText = text("limit");
  const limit = limitText === undefined ? 25 : Number(limitText);
  if (!Number.isInteger(limit) || limit < 1 || limit > ADMIN_LIST_MAX) throw agentXError("CONFIG_INVALID", "limit must be a whole number from 1 to 100");
  const admin = text("admin");
  const cursor = text("cursor");
  const page = await listAudit(deps.audit, {
    since: new Date(since).toISOString(), limit,
    ...(until === undefined ? {} : { until: new Date(until).toISOString() }),
    ...(admin === undefined ? {} : { admin: admin.slice(0, 256) }),
    ...(outcome === undefined ? {} : { outcome: outcome.data }),
    ...(cursor === undefined ? {} : { cursor }),
  });
  // E3: every read after its expiry shows a change expired, and records it on the way.
  const changes: AdminChangeAuditRecord[] = [];
  for (const record of page.changes) {
    if (record.status === "pending" && now >= Date.parse(record.proposedAt) + ADMIN_CHANGE_TTL_MS) {
      const pending = await getPending(deps, record.changeId);
      if (pending !== undefined) await settle(deps, pending);
      changes.push((await readAudit(deps.audit, record.changeId)) ?? { ...record, status: "expired", outcome: "expired" });
    } else {
      changes.push(record);
    }
  }
  return { status: 200, body: { changes, ...(page.cursor === undefined ? {} : { cursor: page.cursor }) } };
}

export async function routeAdminChange(deps: AdminChangeDependencies | undefined, identity: AuthenticatedIdentity, request: { method: string; headers: Record<string, string | undefined>; body: unknown }, url: URL): Promise<{ status: number; body: unknown } | undefined> {
  if (url.pathname !== "/v1/admin/changes" && !url.pathname.startsWith("/v1/admin/changes/")) return undefined;
  if (deps === undefined) throw agentXError("NOT_FOUND", "admin changes are not set up in this deployment");
  if (!identity.isAdministrator) throw agentXError("FORBIDDEN", "administrator claim is required");
  const given = request.headers["x-agentx-trace-id"];
  const traceId = given !== undefined && TRACE.test(given) ? given : randomUUID();
  if (url.pathname === "/v1/admin/changes") {
    if (request.method === "POST") return propose(deps, identity, request.headers.authorization, request.body, traceId);
    if (request.method === "GET") return list(deps, url);
  }
  const match = /^\/v1\/admin\/changes\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/(slack|apply|decline))?$/.exec(url.pathname);
  if (match?.[1] !== undefined) {
    const changeId = match[1];
    if (request.method === "GET" && match[2] === undefined) {
      const change = await getPending(deps, changeId);
      if (change === undefined) throw agentXError("NOT_FOUND", `no change ${changeId}`);
      return { status: 200, body: { change: viewOf(await settle(deps, change)) } };
    }
    if (request.method === "POST" && match[2] === "slack") return startSlack(deps, identity, changeId);
    if (request.method === "POST" && match[2] === "apply") return apply(deps, identity, changeId, request.body);
    if (request.method === "POST" && match[2] === "decline") return decline(deps, identity, changeId, request.body);
  }
  throw agentXError("NOT_FOUND", "route not found");
}
```

A change's steps log with the change's own trace ID (the MCP server sends one per change tool
call, E13 and FR-052); a CLI or a later call with another trace ID still logs the change's.

- [ ] **Step 5: Wire them into the broker**

In `packages/broker/src/aws/broker.ts`:
- add `adminChanges?: { confirm?: { elicitation: boolean; slack: boolean }; now?(): number; metric?(outcome: AdminChangeOutcome): void }`
  to `AwsBrokerDependencies`;
- beside `adminReadDependencies`:

```ts
/** Spec 025 phase 25e: admin changes exist only with developer sign-in and a TurnRecords table (D14). */
function adminChangeDependencies(dependencies: AwsBrokerDependencies, reads: AdminReadDependencies): AdminChangeDependencies | undefined {
  const developer = dependencies.developer;
  if (developer === undefined || dependencies.turnRecordsTableName === undefined) return undefined;
  const log = (entry: Record<string, unknown>) => console.log(JSON.stringify({ component: "broker", ...entry }));
  const reader = adminReader(reads);
  return {
    documentClient: dependencies.documentClient,
    tableName: dependencies.tableName,
    audit: {
      documentClient: dependencies.documentClient, tableName: dependencies.turnRecordsTableName, now: dependencies.adminChanges?.now ?? Date.now, log,
      metric: dependencies.adminChanges?.metric ?? outcomeMetric(process.env.AGENTX_METRICS_NAMESPACE ?? "AgentX"),
    },
    plans: planDependencies(dependencies),
    ...(reader === undefined ? {} : { identity: reader }),
    ...(developer.slackTeamId === undefined ? {} : { slackTeamId: developer.slackTeamId }),
    // E16: the environment's switch; Slack needs Slack sign-in and a team (FR-041).
    confirm: dependencies.adminChanges?.confirm ?? { elicitation: process.env.MCP_CONFIRM_ELICITATION !== "disabled", slack: developer.methods.slack && developer.slackTeamId !== undefined },
    now: dependencies.adminChanges?.now ?? Date.now,
    newId: randomUUID,
    log,
  };
}
```

- in `createAwsBrokerHandler`, after `adminReads`: `const adminChanges = adminChangeDependencies(dependencies, adminReads);`;
  widen the handler's event type with `AdminChangePressEvent`, and first in the handler, beside the
  stop event:

```ts
    if (isAdminChangePressEvent(event)) {
      if (adminChanges === undefined) return json({ error: { code: "NOT_FOUND", message: "admin changes are not set up in this deployment" } }, "slack-ingress", 404);
      return json(await pressAdminChange(adminChanges, event), "slack-ingress");
    }
```

- in the admin block, before 25d's `routeAdminRead`:

```ts
      // Spec 025 phase 25e: admin changes (FR-039 to FR-041, FR-052).
      const changed = await routeAdminChange(adminChanges, identity, { method: request.method, headers: request.headers, body }, url);
      if (changed !== undefined) return json(changed.body, request.requestId, changed.status);
```

`body` is the already parsed request body (`parseBody(request.body)`).

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/contract/admin-change-routes.test.ts tests/contract/admin-read-*.test.ts tests/contract/admin-me.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/broker/src/aws/admin-changes.ts packages/broker/src/aws/broker.ts tests/support/admin-read-broker.ts tests/support/admin-change-broker.ts tests/contract/admin-change-routes.test.ts
git commit -m "feat(broker): admin change routes that apply at most once after a valid confirmation (spec 025 phase 25e)"
```

---
### Task 8: The notifier sends the Slack Confirm message, and edits it when the change ends

E13, FR-034's "triggered ... by new pending changes" (a filter on the existing mapping, C7, D23),
FR-041's direct message, FR-052's notifier log line.

**Files:**
- Create: `packages/broker/src/developer/change-messages.ts`
- Modify: `packages/broker/src/developer/notifications.ts` (two notice kinds from `ADMIN_CHANGE` images)
- Modify: `packages/broker/src/aws/slack-web.ts` (`blocks`, the channel in the answer; `chatUpdate`)
- Modify: `packages/broker/src/aws/developer-task-notifier.ts` (deliver the two kinds)
- Test: `tests/contract/admin-change-notifier.test.ts`

**Interfaces:**
- Consumes: `PendingChange` (Task 7); `ADMIN_CHANGE_CONFIRM_ACTION`, `ADMIN_CHANGE_CANCEL_ACTION`,
  `adminChangeKey` (Task 1); 25c's `createNotifierHandler`, `NotifierDependencies`, `readStream`.
- Produces:
  - `NoticeKind` gains `"admin_change_dm" | "admin_change_outcome"`; `Notice.changeId?: string`;
  - `export function adminChangeMessage(change: PendingChange, now: number): { text: string; blocks: unknown[] }`
    and `export function adminChangeOutcomeMessage(change: PendingChange): { text: string; blocks: unknown[] } | undefined`;
  - `chatPostMessage(token, { channel, threadTs?, text, blocks? })` answers `{ ts: string; channel?: string }`;
    `export async function chatUpdate(botToken: string, input: { channel: string; ts: string; text: string; blocks: unknown[] }, fetchImplementation?: typeof fetch): Promise<void>`;
  - `NotifierDependencies.post` takes `blocks?`; `NotifierDependencies.update?(input): Promise<void>`
    (optional, so 25c's tests that build the dependencies without it still compile).

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/admin-change-notifier.test.ts
// Spec 025 E13: a change whose Slack step started gets one direct message with Confirm and Cancel;
// when the change ends, the message is edited to say how. Only the notifier posts (D11).
import { marshall } from "@aws-sdk/util-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { createNotifierHandler, type NotifierDependencies } from "../../packages/broker/src/aws/developer-task-notifier.js";
import { noticesFromStream, type StreamRecord } from "../../packages/broker/src/developer/notifications.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const CHANGE = "55555555-5555-4555-8555-555555555555";
const PLANTED = `xoxb-${"4".repeat(10)}-planted`;
const pending = (extra: Record<string, unknown> = {}) => ({
  pk: `ADMIN_CHANGE#${CHANGE}`, sk: "META", entityType: "ADMIN_CHANGE", changeId: CHANGE, kind: "bind_channel", status: "pending",
  effect: `Bind channel #ledger-dev (C0LEDGER01) to project ledger. It is bound to nothing today. <script> ${PLANTED}`,
  admin: { issuer: "https://identity.example.test", subject: "admin-subject", ownerKey: "o".repeat(64), displayName: "Ada" }, slackUserId: "U0ADA00001",
  methodsOffered: ["slack"], createdAt: "2026-10-02T09:00:00.000Z", expiresAt: "2026-10-02T09:10:00.000Z", traceId: "trace-7", ...extra,
});
const modify = (before: Record<string, unknown>, after: Record<string, unknown>): StreamRecord => ({ eventID: "e1", eventName: "MODIFY", dynamodb: { OldImage: marshall(before), NewImage: marshall(after) } });

function notifier(db: FakeDynamoDb, now = Date.parse("2026-10-02T09:01:00.000Z")) {
  const posts: Array<{ channel: string; text: string; blocks?: unknown[] }> = [];
  const updates: Array<{ channel: string; ts: string; text: string; blocks: unknown[] }> = [];
  const logs: Array<Record<string, unknown>> = [];
  const deps: NotifierDependencies = {
    documentClient: db, tableName: "state", enqueue: vi.fn(async () => undefined), retryLater: vi.fn(async () => undefined),
    post: vi.fn(async (input) => { posts.push(input); return { ts: "1696237200.000100", channel: "D0ADMINDM1" }; }),
    update: vi.fn(async (input) => { updates.push(input); }),
    now: () => now, log: (entry) => logs.push(entry), deliveryFailed: vi.fn(),
  };
  const handler = createNotifierHandler(deps);
  const deliver = (notice: unknown) => handler({ Records: [{ eventSource: "aws:sqs", messageId: "m1", receiptHandle: "r1", body: JSON.stringify(notice) }] });
  return { posts, updates, logs, deliver };
}

describe("the Slack Confirm message (E13)", () => {
  it("turns the start of the Slack step, and the end of a change with a message, into notices", () => {
    expect(noticesFromStream([modify(pending(), pending({ slackRequestedAt: "2026-10-02T09:00:05.000Z" }))])).toEqual([expect.objectContaining({ id: `${CHANGE}:dm`, kind: "admin_change_dm", changeId: CHANGE })]);
    const dm = { channel: "D0ADMINDM1", ts: "1696237200.000100", postedAt: "2026-10-02T09:00:06.000Z" };
    expect(noticesFromStream([modify(pending({ dm }), pending({ dm, status: "applied" }))])).toEqual([expect.objectContaining({ id: `${CHANGE}:outcome`, kind: "admin_change_outcome" })]);
    expect(noticesFromStream([modify(pending(), pending({ status: "applied" }))])).toEqual([]);
  });

  it("posts one direct message to the admin's Slack user, with Confirm and Cancel, escaped and redacted", async () => {
    const db = new FakeDynamoDb();
    db.set(pending({ slackRequestedAt: "2026-10-02T09:00:05.000Z" }));
    const { posts, logs, deliver } = notifier(db);
    await deliver({ id: `${CHANGE}:dm`, kind: "admin_change_dm", changeId: CHANGE, at: "2026-10-02T09:00:05.000Z" });
    await deliver({ id: `${CHANGE}:dm`, kind: "admin_change_dm", changeId: CHANGE, at: "2026-10-02T09:00:05.000Z" });
    expect(posts).toHaveLength(1);
    expect(posts[0]?.channel).toBe("U0ADA00001");
    expect(posts[0]?.text).toContain("&lt;script&gt;");
    expect(JSON.stringify(posts)).not.toContain(PLANTED);
    expect(JSON.stringify(posts[0]?.blocks)).toContain("agentx_admin_change_confirm");
    expect(JSON.stringify(posts[0]?.blocks)).toContain(`"value":"${CHANGE}"`);
    expect(db.get(`ADMIN_CHANGE#${CHANGE}`, "META")).toMatchObject({ dm: { channel: "D0ADMINDM1", ts: "1696237200.000100" } });
    expect(logs).toContainEqual(expect.objectContaining({ event: "admin_change.dm_posted", changeId: CHANGE, traceId: "trace-7" }));
  });

  it("posts nothing for a change that already ended or expired", async () => {
    const db = new FakeDynamoDb();
    db.set(pending({ slackRequestedAt: "2026-10-02T09:00:05.000Z", status: "declined" }));
    const { posts, deliver } = notifier(db);
    await deliver({ id: `${CHANGE}:dm`, kind: "admin_change_dm", changeId: CHANGE, at: "2026-10-02T09:00:05.000Z" });
    const expired = new FakeDynamoDb();
    expired.set(pending({ slackRequestedAt: "2026-10-02T09:00:05.000Z" }));
    const late = notifier(expired, Date.parse("2026-10-02T09:11:00.000Z"));
    await late.deliver({ id: `${CHANGE}:dm`, kind: "admin_change_dm", changeId: CHANGE, at: "2026-10-02T09:00:05.000Z" });
    expect([...posts, ...late.posts]).toEqual([]);
  });

  it("edits the message once the change ends, removing the buttons", async () => {
    const db = new FakeDynamoDb();
    db.set(pending({ status: "applied", pressedBy: "U0ADA00001", dm: { channel: "D0ADMINDM1", ts: "1696237200.000100", postedAt: "2026-10-02T09:00:06.000Z" } }));
    const { updates, deliver } = notifier(db);
    await deliver({ id: `${CHANGE}:outcome`, kind: "admin_change_outcome", changeId: CHANGE, at: "2026-10-02T09:02:00.000Z" });
    await deliver({ id: `${CHANGE}:outcome`, kind: "admin_change_outcome", changeId: CHANGE, at: "2026-10-02T09:02:00.000Z" });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ channel: "D0ADMINDM1", ts: "1696237200.000100" });
    expect(updates[0]?.text).toContain("Applied, confirmed by <@U0ADA00001>.");
    expect(JSON.stringify(updates[0]?.blocks)).not.toContain("agentx_admin_change_confirm");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/contract/admin-change-notifier.test.ts`
Expected: FAIL: no notices come from `ADMIN_CHANGE` images, and the kinds are unknown.

- [ ] **Step 3: The notices**

In `packages/broker/src/developer/notifications.ts`, widen `NoticeKind` with
`"admin_change_dm" | "admin_change_outcome"`, add `changeId?: string` to `Notice`, and add a case
to `noticesOf`:

```ts
    case "ADMIN_CHANGE": {
      // Spec 025 E13: the Slack step started, or a change with a message ended.
      const changeId = text(next.changeId);
      if (next.slackRequestedAt != null && previous?.slackRequestedAt == null && next.status === "pending") return [{ id: `${changeId}:dm`, kind: "admin_change_dm", changeId, at }];
      const ended = ["applied", "declined", "expired", "failed"].includes(text(next.status));
      if (next.dm != null && ended && previous?.status !== next.status) return [{ id: `${changeId}:outcome`, kind: "admin_change_outcome", changeId, at }];
      return [];
    }
```

`changedAt` needs no change: an `ADMIN_CHANGE` image has no `updatedAt`, so the stream's time is used.

- [ ] **Step 4: The messages**

```ts
// packages/broker/src/developer/change-messages.ts
// Spec 025 E13: the Slack Confirm message and its edited form. The effect is already redacted by the
// broker; it is redacted again and escaped for Slack here, since it can quote a channel's name.
import { ADMIN_CHANGE_CANCEL_ACTION, ADMIN_CHANGE_CONFIRM_ACTION, redactText } from "@agentx/contracts";
import type { PendingChange } from "../aws/admin-changes.js";

const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const section = (text: string) => ({ type: "section", text: { type: "mrkdwn", text: text.slice(0, 3_000) } });
const minutes = (from: number, until: string) => Math.max(1, Math.ceil((Date.parse(until) - from) / 60_000));

export function adminChangeMessage(change: PendingChange, now: number): { text: string; blocks: unknown[] } {
  const effect = escape(redactText(change.effect));
  const text = `AgentX needs your confirmation for a change you asked for.\n\n${effect}\n\nIt expires in ${minutes(now, change.expiresAt)} minutes. Confirm applies it at once; Cancel drops it.`;
  return {
    text,
    blocks: [
      section(text),
      { type: "actions", block_id: "agentx_admin_change", elements: [
        { type: "button", action_id: ADMIN_CHANGE_CONFIRM_ACTION, style: "primary", text: { type: "plain_text", text: "Confirm" }, value: change.changeId },
        { type: "button", action_id: ADMIN_CHANGE_CANCEL_ACTION, text: { type: "plain_text", text: "Cancel" }, value: change.changeId },
      ] },
    ],
  };
}

export function adminChangeOutcomeMessage(change: PendingChange): { text: string; blocks: unknown[] } | undefined {
  const effect = escape(redactText(change.effect));
  const outcome = {
    applied: `Applied${change.pressedBy === undefined ? "" : `, confirmed by <@${change.pressedBy}>`}.`,
    declined: "Cancelled; nothing was changed.",
    expired: "This change expired, so nothing was changed. Ask for it again if you still want it.",
    failed: `It was not applied: ${escape(redactText(change.error?.message ?? "it could not be applied"))}`,
  }[change.status as "applied" | "declined" | "expired" | "failed"];
  if (outcome === undefined) return undefined;
  const text = `${effect}\n\n${outcome}`;
  return { text, blocks: [section(text)] };
}
```

- [ ] **Step 5: Slack's two calls**

In `packages/broker/src/aws/slack-web.ts`, give `chatPostMessage`'s input `blocks?: unknown[]`
(sent when present) and return `{ ts, ...(typeof result.channel === "string" ? { channel: result.channel } : {}) }`;
add:

```ts
/** Spec 025 E13: edits a message the bot posted. Errors carry Slack's code only, as chatPostMessage's do. */
export async function chatUpdate(botToken: string, input: { channel: string; ts: string; text: string; blocks: unknown[] }, fetchImplementation: typeof fetch = fetch): Promise<void> {
  const response = await fetchImplementation("https://slack.com/api/chat.update", {
    method: "POST",
    headers: { authorization: `Bearer ${botToken}`, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(10_000),
  });
  let result: Record<string, unknown> = {};
  try { result = await response.json() as Record<string, unknown>; } catch { /* reported by status below */ }
  if (!response.ok || result.ok !== true) {
    throw new SlackPostError(typeof result.error === "string" && /^[a-z_]{1,64}$/.test(result.error) ? result.error : `http_${response.status}`);
  }
}
```

- [ ] **Step 6: Deliver the two kinds**

In `packages/broker/src/aws/developer-task-notifier.ts`:
- add `"admin_change_dm"` and `"admin_change_outcome"` to `NOTICE_KINDS`, `blocks?: unknown[]` to
  `PostInput`, `update?(input: { channel: string; ts: string; text: string; blocks: unknown[] }): Promise<void>`
  to `NotifierDependencies`, and let `post` answer `{ ts: string; channel?: string }`;
- add:

```ts
/** A claim older than this was left by a delivery that died between claiming and posting. */
const DM_CLAIM_MS = 60_000;

async function deliverAdminChange(deps: NotifierDependencies, notice: Notice): Promise<string> {
  if (notice.changeId === undefined) return "stale";
  const key = adminChangeKey(notice.changeId);
  const change = await getItem<PendingChange>(deps, key);
  if (change === undefined) return "stale";
  if (notice.kind === "admin_change_outcome") {
    if (change.dm === undefined || change.dm.editedAt !== undefined) return "delivered";
    if (deps.update === undefined) return "stale";
    const message = adminChangeOutcomeMessage(change);
    if (message === undefined) return "stale";
    await deps.update({ channel: change.dm.channel, ts: change.dm.ts, ...message });
    await deps.documentClient.send(new UpdateCommand({ TableName: deps.tableName, Key: key, UpdateExpression: "SET dm.editedAt = :now", ConditionExpression: "attribute_exists(dm)", ExpressionAttributeValues: { ":now": new Date(deps.now()).toISOString() } }));
    deps.log({ event: "admin_change.dm_edited", changeId: change.changeId, traceId: change.traceId, status: change.status });
    return "posted";
  }
  if (change.dm !== undefined) return "delivered";
  if (change.status !== "pending" || deps.now() >= Date.parse(change.expiresAt) || change.slackUserId === undefined) return "stale";
  const claimedAt = new Date(deps.now()).toISOString();
  try {
    await deps.documentClient.send(new UpdateCommand({
      TableName: deps.tableName, Key: key, UpdateExpression: "SET dmClaimedAt = :now",
      ConditionExpression: "attribute_not_exists(dm) AND (attribute_not_exists(dmClaimedAt) OR dmClaimedAt < :stale)",
      ExpressionAttributeValues: { ":now": claimedAt, ":stale": new Date(deps.now() - DM_CLAIM_MS).toISOString() },
    }));
  } catch (error) {
    if (!isConditional(error)) throw error;
    // Another delivery is posting it now; this one is retried and then finds it delivered.
    throw new StartPending();
  }
  let posted: { ts: string; channel?: string };
  try {
    posted = await deps.post({ channel: change.slackUserId, ...adminChangeMessage(change, deps.now()) });
  } catch (error) {
    await deps.documentClient.send(new UpdateCommand({ TableName: deps.tableName, Key: key, UpdateExpression: "REMOVE dmClaimedAt", ConditionExpression: "dmClaimedAt = :mine", ExpressionAttributeValues: { ":mine": claimedAt } })).catch(() => undefined);
    throw error;
  }
  await deps.documentClient.send(new UpdateCommand({
    TableName: deps.tableName, Key: key, UpdateExpression: "SET dm = :dm",
    ConditionExpression: "attribute_not_exists(dm)",
    ExpressionAttributeValues: { ":dm": { channel: posted.channel ?? change.slackUserId, ts: posted.ts, postedAt: new Date(deps.now()).toISOString() } },
  })).catch((error: unknown) => { if (!isConditional(error)) throw error; });
  // FR-052: the notifier's step, with the change and trace IDs.
  deps.log({ event: "admin_change.dm_posted", changeId: change.changeId, traceId: change.traceId });
  return "posted";
}
```

- in `createNotifierHandler`, deliver by kind:
  `outcome: notice.kind === "admin_change_dm" || notice.kind === "admin_change_outcome" ? await deliverAdminChange(deps, notice) : await deliver(deps, notice)`;
- in the module's AWS wiring, add
  `update: async (input) => chatUpdate(await token(), input)` beside `post`, with `token()` the
  same cached bot token the poster uses (split `cachedSlackPoster`'s token cache into its own
  `cachedBotToken(loadToken, now)` and build both from it).

A DM notice that keeps failing is retried within the notice window, as every notice is (C9); a
change expires after 10 minutes, and `deliverAdminChange` then answers `stale`, so it stops early.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run tests/contract/admin-change-notifier.test.ts tests/contract/developer-task-notifier.test.ts tests/contract/developer-task-notices.test.ts && npm run typecheck`
Expected: PASS; 25c's notifier tests are unchanged.

- [ ] **Step 8: Commit**

```bash
git add packages/broker/src/developer/change-messages.ts packages/broker/src/developer/notifications.ts packages/broker/src/aws/slack-web.ts packages/broker/src/aws/developer-task-notifier.ts tests/contract/admin-change-notifier.test.ts
git commit -m "feat(broker): the notifier's Slack Confirm message for admin changes, and its edit (spec 025 phase 25e)"
```

---

### Task 9: The ingress takes a Confirm or Cancel press

E14, FR-041's "the Slack interactivity route MUST accept a press only from that Slack user" (the
broker decides; the ingress hands it over), FR-052's interactivity log line.

**Files:**
- Modify: `packages/broker/src/aws/slack-interactivity.ts`
- Test: `tests/contract/admin-change-interactivity.test.ts`

**Interfaces:**
- Consumes: `ADMIN_CHANGE_CONFIRM_ACTION`, `ADMIN_CHANGE_CANCEL_ACTION` (Task 1); the handler's
  signature check and `respondEphemeral` (spec 014).
- Produces: `SlackInteractivityDependencies` gains
  `adminChange?: { press(input: { changeId: string; click: "confirm" | "cancel"; slackUserId: string; teamId?: string }): Promise<void>; traceOf?(changeId: string): Promise<string | undefined> }`;
  `export const ADMIN_CHANGE_RECEIVED_TEXT` and `export const ADMIN_CHANGE_CANCEL_RECEIVED_TEXT`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/admin-change-interactivity.test.ts
// Spec 025 E14: a Confirm or Cancel press in a direct message is handed to the broker, and the
// presser hears at once that it was received; every other button keeps today's handling.
import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ADMIN_CHANGE_RECEIVED_TEXT, createSlackInteractivityHandler } from "../../packages/broker/src/aws/slack-interactivity.js";

const SIGNING = "s".repeat(32);
const CHANGE = "55555555-5555-4555-8555-555555555555";
function event(actionId: string, value = CHANGE, now = Date.now()) {
  const payload = { type: "block_actions", user: { id: "U0ADA00001", team_id: "T0BSHLLUGBD" }, team: { id: "T0BSHLLUGBD" }, container: { type: "message", channel_id: "D0ADMINDM1", message_ts: "1696237200.000100" },
    message: { ts: "1696237200.000100", text: "AgentX needs your confirmation" }, response_url: "https://hooks.slack.com/actions/T/1/abc", actions: [{ action_id: actionId, value }] };
  const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
  const timestamp = String(Math.floor(now / 1000));
  const signature = `v0=${createHmac("sha256", SIGNING).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  return { version: "2.0", rawPath: "/v1/slack/interactions", body, headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": signature }, requestContext: { http: { method: "POST" } } };
}

describe("an admin change press (E14)", () => {
  it("hands a Confirm press to the broker, answers the presser, and logs the change's trace ID", async () => {
    const press = vi.fn(async () => undefined);
    const respondEphemeral = vi.fn(async () => undefined);
    const log = vi.fn();
    const handler = createSlackInteractivityHandler({ secrets: async () => ({ signingSecret: SIGNING, botToken: "xoxb-1" }), handlers: [], respondEphemeral, log, adminChange: { press, traceOf: async () => "trace-7" } });
    expect((await handler(event("agentx_admin_change_confirm") as never)).statusCode).toBe(200);
    expect(press).toHaveBeenCalledWith({ changeId: CHANGE, click: "confirm", slackUserId: "U0ADA00001", teamId: "T0BSHLLUGBD" });
    expect(respondEphemeral).toHaveBeenCalledWith("https://hooks.slack.com/actions/T/1/abc", ADMIN_CHANGE_RECEIVED_TEXT);
    expect(log).toHaveBeenCalledWith("admin_change.press_received", { changeId: CHANGE, traceId: "trace-7", click: "confirm" });
  });

  it("tells the presser to try again when the hand-over fails, and ignores a press with no change ID", async () => {
    const respondEphemeral = vi.fn(async () => undefined);
    const handler = createSlackInteractivityHandler({ secrets: async () => ({ signingSecret: SIGNING, botToken: "xoxb-1" }), handlers: [], respondEphemeral, adminChange: { press: async () => { throw new Error("throttled"); } } });
    await handler(event("agentx_admin_change_cancel") as never);
    expect(respondEphemeral).toHaveBeenLastCalledWith(expect.any(String), "I couldn't take that press. Press the button again.");
    const press = vi.fn();
    const strict = createSlackInteractivityHandler({ secrets: async () => ({ signingSecret: SIGNING, botToken: "xoxb-1" }), handlers: [], respondEphemeral, adminChange: { press } });
    await strict(event("agentx_admin_change_confirm", "not-a-change") as never);
    expect(press).not.toHaveBeenCalled();
  });

  it("refuses an unsigned press as every interaction is refused", async () => {
    const press = vi.fn();
    const handler = createSlackInteractivityHandler({ secrets: async () => ({ signingSecret: "other".repeat(8), botToken: "xoxb-1" }), handlers: [], adminChange: { press } });
    expect((await handler(event("agentx_admin_change_confirm") as never)).statusCode).toBe(401);
    expect(press).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/contract/admin-change-interactivity.test.ts`
Expected: FAIL: the press parses as a malformed action (its channel is a `D...` direct message).

- [ ] **Step 3: Take the press**

In `packages/broker/src/aws/slack-interactivity.ts`, add the option to
`SlackInteractivityDependencies` and, right after the `payload.type !== "block_actions"` check:

```ts
    // Spec 025 E14: an admin change's buttons live in a direct message (a D... channel), which the
    // thread-based parsing below refuses; they are read here, and only these two action IDs.
    const press = adminChangePress(payload);
    if (press !== undefined) {
      if (dependencies.adminChange === undefined) {
        await dependencies.respondEphemeral?.(press.responseUrl, UNKNOWN_BUTTON_TEXT).catch(() => undefined);
        return respond(200, { ok: true });
      }
      const traceId = await dependencies.adminChange.traceOf?.(press.changeId).catch(() => undefined);
      log("admin_change.press_received", { changeId: press.changeId, ...(traceId === undefined ? {} : { traceId }), click: press.click });
      try {
        await dependencies.adminChange.press({ changeId: press.changeId, click: press.click, slackUserId: press.slackUserId, ...(press.teamId === undefined ? {} : { teamId: press.teamId }) });
        await dependencies.respondEphemeral?.(press.responseUrl, press.click === "confirm" ? ADMIN_CHANGE_RECEIVED_TEXT : ADMIN_CHANGE_CANCEL_RECEIVED_TEXT).catch(() => undefined);
      } catch (error) {
        log("admin_change.press_failed", { changeId: press.changeId, errorName: errorName(error) });
        await dependencies.respondEphemeral?.(press.responseUrl, "I couldn't take that press. Press the button again.").catch(() => undefined);
      }
      return respond(200, { ok: true });
    }
```

with, at module level:

```ts
export const ADMIN_CHANGE_RECEIVED_TEXT = "Received. AgentX is applying the change; the message above will show how it went.";
export const ADMIN_CHANGE_CANCEL_RECEIVED_TEXT = "Received. AgentX is dropping the change.";
const CHANGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function adminChangePress(payload: Record<string, unknown>): { changeId: string; click: "confirm" | "cancel"; slackUserId: string; teamId?: string; responseUrl: string } | undefined {
  const [action] = Array.isArray(payload.actions) ? payload.actions.map(asRecord) : [];
  if (action === undefined || (action.action_id !== ADMIN_CHANGE_CONFIRM_ACTION && action.action_id !== ADMIN_CHANGE_CANCEL_ACTION)) return undefined;
  const user = asRecord(payload.user);
  const userId = SlackUserIdSchema.safeParse(user.id);
  const team = SlackTeamIdSchema.safeParse(asRecord(payload.team).id ?? user.team_id);
  if (typeof action.value !== "string" || !CHANGE_ID.test(action.value) || !userId.success || !isSlackResponseUrl(payload.response_url)) return undefined;
  return { changeId: action.value, click: action.action_id === ADMIN_CHANGE_CONFIRM_ACTION ? "confirm" : "cancel", slackUserId: userId.data, ...(team.success ? { teamId: team.data } : {}), responseUrl: payload.response_url };
}
```

In `createAwsSlackInteractivityHandler`, pass:

```ts
    adminChange: {
      // E14: asynchronous, so Slack's 3-second answer never waits on an apply; the broker records the outcome.
      press: async (press) => {
        await lambda.send(new InvokeCommand({ FunctionName: requiredEnvironment("BROKER_FUNCTION_NAME"), InvocationType: "Event", Payload: Buffer.from(JSON.stringify({ source: "agentx.slack-ingress", action: "admin-change-press", ...press })) }));
      },
      traceOf: async (changeId) => {
        const response = await documentClient.send(new GetCommand({ TableName: requiredEnvironment("STATE_TABLE_NAME"), Key: { pk: `ADMIN_CHANGE#${changeId}`, sk: "META" }, ProjectionExpression: "pk, sk, traceId" }));
        const traceId = (response.Item as { traceId?: unknown } | undefined)?.traceId;
        return typeof traceId === "string" ? traceId : undefined;
      },
    },
```

with a `LambdaClient` built from the same client configuration (`@aws-sdk/client-lambda`, which
the ingress already uses for the stop command). The ingress's grants (Task 10) allow exactly this:
invoking the broker (existing) and reading `pk`, `sk` and `traceId` of `ADMIN_CHANGE#*` items.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/contract/admin-change-interactivity.test.ts tests/contract/slack-interactivity*.test.ts tests/contract/slack-details*.test.ts`
Expected: PASS; spec 014's interactivity tests are unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/broker/src/aws/slack-interactivity.ts tests/contract/admin-change-interactivity.test.ts
git commit -m "feat(broker): the ingress hands Slack Confirm and Cancel presses to the broker (spec 025 phase 25e)"
```

---

### Task 10: Infrastructure: the notifier's filter, the grants and the elicitation switch

E13's filter (a fourth filter on the notifier's existing mapping, never a third stream reader, C7),
least-privilege grants for every new read and write, and E16's parameter. Named environments only.
**Depends on Q1.**

**Files:**
- Modify: `infra/lib/developer-task-notifier.ts`
- Modify: `infra/lib/developer-signin.ts`
- Modify: `infra/lib/control-plane.ts`
- Test: `tests/contract/admin-change-infrastructure.test.ts`

**Interfaces:**
- Consumes: the constructs 25a to 25d built.
- Produces: the stack parameter `McpConfirmElicitation` (`enabled` default, or `disabled`),
  in `DeveloperSignInParameters.mcpConfirmElicitation`; the environment variable
  `MCP_CONFIRM_ELICITATION` on DeveloperIdentity and the broker.

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/admin-change-infrastructure.test.ts
// Spec 025 phase 25e: every new grant is exact, the notifier's stream mapping gains one filter,
// and the legacy template does not change.
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { environmentNaming } from "../../infra/lib/naming.js";

type Statement = { Action: string | string[]; Resource: unknown; Condition?: Record<string, Record<string, unknown>> };
type Policy = { Properties: { PolicyDocument: { Statement: Statement[] }; Roles: Array<{ Ref?: string }> } };
const statementsOf = (template: Template, rolePrefix: string) => (Object.values(template.findResources("AWS::IAM::Policy")) as Policy[])
  .filter((policy) => policy.Properties.Roles.some((role) => role.Ref?.startsWith(rolePrefix)))
  .flatMap((policy) => policy.Properties.PolicyDocument.Statement);
const leading = (statement: Statement) => statement.Condition?.["ForAllValues:StringLike"]?.["dynamodb:LeadingKeys"];

describe("admin change infrastructure", () => {
  const named = Template.fromStack(new ControlPlaneStack(new App(), "ChangesControlPlane", { naming: environmentNaming("live25e") }));
  const legacy = Template.fromStack(new ControlPlaneStack(new App(), "ChangesLegacyControlPlane"));

  it("adds one ADMIN_CHANGE filter to the notifier's existing stream mapping, and no third stream reader", () => {
    const mappings = Object.values(named.findResources("AWS::Lambda::EventSourceMapping")) as Array<{ Properties: { EventSourceArn?: unknown; FilterCriteria?: { Filters: Array<{ Pattern: string }> } } }>;
    const onStream = mappings.filter((mapping) => JSON.stringify(mapping.Properties.EventSourceArn).includes("StreamArn"));
    expect(onStream).toHaveLength(2);
    const patterns = onStream.flatMap((mapping) => mapping.Properties.FilterCriteria?.Filters ?? []).map((filter) => filter.Pattern);
    expect(patterns).toContainEqual(JSON.stringify({ dynamodb: { NewImage: { entityType: { S: ["ADMIN_CHANGE"] } } } }));
  });

  it("lets the notifier read and update ADMIN_CHANGE items only, by key", () => {
    const notifier = statementsOf(named, "DeveloperTaskNotifierFunctionServiceRole");
    expect(notifier).toContainEqual(expect.objectContaining({ Action: ["dynamodb:GetItem", "dynamodb:UpdateItem"], Condition: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["ADMIN_CHANGE#*"] } } }));
  });

  it("lets the broker write audit records under CHANGE# only, and read the email index", () => {
    const broker = statementsOf(named, "BrokerServiceRole");
    expect(broker.find((statement) => JSON.stringify(leading(statement)) === JSON.stringify(["CHANGE#*"]))?.Action).toEqual(["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:GetItem"]);
    expect(broker.some((statement) => JSON.stringify(leading(statement)).includes("EMAIL#*"))).toBe(true);
  });

  it("lets the ingress read only an ADMIN_CHANGE item's keys and trace ID", () => {
    const ingress = statementsOf(named, "SlackIngressServiceRole");
    const read = ingress.find((statement) => JSON.stringify(leading(statement)) === JSON.stringify(["ADMIN_CHANGE#*"]));
    expect(read).toMatchObject({ Action: "dynamodb:GetItem", Condition: { "ForAllValues:StringEquals": { "dynamodb:Attributes": ["pk", "sk", "traceId"] }, Null: { "dynamodb:Attributes": "false" } } });
  });

  it("adds the McpConfirmElicitation parameter, enabled by default, to DeveloperIdentity and the broker", () => {
    expect(named.toJSON().Parameters.McpConfirmElicitation).toMatchObject({ Type: "String", Default: "enabled", AllowedValues: ["enabled", "disabled"] });
    expect(JSON.stringify(named.toJSON())).toContain("MCP_CONFIRM_ELICITATION");
  });

  it("changes nothing in the legacy template", () => {
    expect(legacy.toJSON().Parameters).not.toHaveProperty("McpConfirmElicitation");
    expect(JSON.stringify(legacy.toJSON())).not.toContain("ADMIN_CHANGE");
  });
});
```

Role logical IDs start with the construct's path (`DeveloperTaskNotifierFunctionServiceRole...`,
`BrokerServiceRole...`, `SlackIngressServiceRole...`), as `tests/contract/developer-signin-infrastructure.test.ts`
and `turn-records-infrastructure.test.ts` already rely on.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/contract/admin-change-infrastructure.test.ts`
Expected: FAIL: no such filter, grants or parameter.

- [ ] **Step 3: The notifier**

In `infra/lib/developer-task-notifier.ts`, append to the stream mapping's `filters`:

```ts
        // Spec 025 E13: admin changes whose Slack step started, and changes with a message that ended.
        lambda.FilterCriteria.filter({ dynamodb: { NewImage: { entityType: { S: equals("ADMIN_CHANGE") } } } }),
```

and add:

```ts
    // Spec 025 E13: the notifier reads a change and records its message (dm, dmClaimedAt), by key.
    this.function.addToRolePolicy(new iam.PolicyStatement({
      actions: ["dynamodb:GetItem", "dynamodb:UpdateItem"],
      resources: [props.state.tableArn],
      conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["ADMIN_CHANGE#*"] } },
    }));
```

- [ ] **Step 4: DeveloperIdentity and the broker**

In `infra/lib/developer-signin.ts`:
- add to `developerSignInParameters`:
  `mcpConfirmElicitation: new CfnParameter(stack, "McpConfirmElicitation", { type: "String", default: "enabled", allowedValues: ["enabled", "disabled"], description: "enabled: an admin may confirm a change from an AI tool in the tool's own pop-up; disabled: only the Slack Confirm button (or the CLI)" }),`
  and the field to `DeveloperSignInParameters`;
- add `MCP_CONFIRM_ELICITATION: p.mcpConfirmElicitation.valueAsString` to DeveloperIdentity's
  environment, and `broker.addEnvironment("MCP_CONFIRM_ELICITATION", p.mcpConfirmElicitation.valueAsString);`;
- append `"EMAIL#*"` to the broker's sign-in table `GetItem` statement's leading keys
  (`["SESSION#*", "DEVELOPER#*", "EMAIL#*"]`);
- after the `TASK#*` PutItem statement:

```ts
    // Spec 025 E3: admin change audit records, only under CHANGE#. Written once, then stepped forward
    // by the broker alone; no delete, and no route edits them (FR-051).
    broker.addToRolePolicy(new iam.PolicyStatement({
      actions: ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:GetItem"],
      resources: [props.turnRecords.tableArn],
      conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["CHANGE#*"] } },
    }));
```

In `infra/lib/control-plane.ts`, inside the named-environment block, beside the `SHARED_TASK#*`
statement:

```ts
      // Spec 025 E14, FR-052: the interactivity route logs a press with its change's trace ID; it may
      // read only that attribute and the keys, by key.
      slackIngress.addToRolePolicy(new iam.PolicyStatement({
        actions: ["dynamodb:GetItem"],
        resources: [state.tableArn],
        conditions: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["ADMIN_CHANGE#*"] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": ["pk", "sk", "traceId"] },
          StringEqualsIfExists: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
          Null: { "dynamodb:Attributes": "false" },
        },
      }));
```

The broker already invokes nothing new (the ingress invokes the broker, `broker.grantInvoke(slackIngress)`,
which covers the `Event` invocation type), and already reads and writes the State table.

- [ ] **Step 5: Run the tests and synth**

Run: `npx vitest run tests/contract/admin-change-infrastructure.test.ts tests/contract/developer-signin-infrastructure.test.ts tests/contract/legacy-templates.test.ts && npm run infra:synth`
Expected: PASS; the legacy templates are byte-identical. `developer-signin-infrastructure.test.ts`
gains the new parameter and statements in any list it pins (append only).

- [ ] **Step 6: Commit**

```bash
git add infra/lib/developer-task-notifier.ts infra/lib/developer-signin.ts infra/lib/control-plane.ts tests/contract/admin-change-infrastructure.test.ts tests/contract/developer-signin-infrastructure.test.ts
git commit -m "feat(infra): admin change grants, the notifier's filter and the elicitation switch, named environments only (spec 025 phase 25e)"
```

---

### Task 11: The environment reports its confirmation methods, and `agentx config` changes the switch

E16, FR-041's "the control plane MUST report whether each method is enabled in
agentx-configuration". **Depends on Q1.**

**Files:**
- Modify: `packages/broker/src/developer/server.ts` (`confirm` in `configuration()`)
- Modify: `packages/broker/src/aws/developer-identity.ts` (read `MCP_CONFIRM_ELICITATION`)
- Modify: `packages/cli/src/config/keys.ts` (`mcp.confirmElicitation`)
- Modify: `packages/cli/src/deploy/parameters.ts` (`OPERATOR_PARAMETERS`)
- Test: `tests/contract/admin-change-configuration.test.ts`
- Modify (expected constants): `tests/contract/config-commands.test.ts` (`rows` length 11 becomes
  12), `tests/contract/developer-identity-server.test.ts` (the configuration gains
  `confirm: { elicitation: true, slack: true }`)

**Interfaces:**
- Consumes: `AgentXConfigurationConfirm` (Task 1).
- Produces: `DeveloperIdentityConfig.confirmElicitation?: boolean` (absent means enabled);
  the configuration answer's `confirm: { elicitation: boolean; slack: boolean }`; the config key
  `mcp.confirmElicitation` on stack parameter `McpConfirmElicitation` of the control plane.

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/admin-change-configuration.test.ts
// Spec 025 E16, FR-041: which confirmation methods the environment allows, and how an admin turns the pop-up off.
import { describe, expect, it } from "vitest";
import { configKey } from "../../packages/cli/src/config/keys.js";
import { OPERATOR_PARAMETERS } from "../../packages/cli/src/deploy/parameters.js";
import { developerIdentityConfigFromEnvironment } from "../../packages/broker/src/aws/developer-identity.js";
import { httpEvent, identityHarness } from "../support/developer-fakes.js";

describe("the environment's confirmation methods (FR-041)", () => {
  it("reports the pop-up on by default, and Slack when Slack sign-in and a team are set up", async () => {
    const harness = identityHarness({});
    expect(JSON.parse((await harness.http(httpEvent("GET", "/v1/auth/.well-known/agentx-configuration"))).body)).toMatchObject({ confirm: { elicitation: true, slack: true } });
    const noTeam = identityHarness({ teamId: undefined });
    expect(JSON.parse((await noTeam.http(httpEvent("GET", "/v1/auth/.well-known/agentx-configuration"))).body)).toMatchObject({ confirm: { elicitation: true, slack: false } });
  });

  it("reads the switch from the environment", () => {
    const base = { AGENTX_ENV: "live25e", DEVELOPER_TOKEN_ISSUER: "https://x/v1/auth" };
    expect(developerIdentityConfigFromEnvironment({ ...base, MCP_CONFIRM_ELICITATION: "disabled" })).toMatchObject({ confirmElicitation: false });
    expect(developerIdentityConfigFromEnvironment(base)).not.toHaveProperty("confirmElicitation");
  });
});

describe("agentx config set mcp.confirmElicitation (E16, Q1)", () => {
  it("is a control-plane stack parameter that upgrades keep", () => {
    const entry = configKey("mcp.confirmElicitation");
    expect(entry.target).toEqual({ kind: "stack-parameter", part: "control-plane", parameter: "McpConfirmElicitation" });
    expect(entry.parse("disabled")).toBe("disabled");
    expect(() => entry.parse("off")).toThrow("mcp.confirmElicitation must be one of enabled, disabled; nothing changed");
    expect(OPERATOR_PARAMETERS["control-plane"]).toContain("McpConfirmElicitation");
  });
});
```

The switch's own effect (a disabled pop-up is neither offered nor accepted) is Task 7's
"refuses the pop-up when the environment turned it off" test.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/contract/admin-change-configuration.test.ts`
Expected: FAIL: no `confirm` in the configuration; no such config key.

- [ ] **Step 3: Report and read the switch**

In `packages/broker/src/developer/server.ts`, add `confirmElicitation?: boolean` to
`DeveloperIdentityConfig`, and to `configuration()`:

```ts
      // FR-041, E16: the methods this environment allows; the MCP server adds the client's and the admin's own.
      confirm: { elicitation: config.confirmElicitation !== false, slack: config.slack.enabled && config.slack.teamId !== undefined },
```

In `developerIdentityConfigFromEnvironment` (developer-identity.ts), add
`...(env.MCP_CONFIRM_ELICITATION === "disabled" ? { confirmElicitation: false } : {})` to the
returned config. In `tests/contract/developer-identity-server.test.ts`, the expected configuration
gains `confirm: { elicitation: true, slack: true }` (additive, SC-008).

- [ ] **Step 4: The config key**

In `packages/cli/src/config/keys.ts`, append to `CONFIG_KEYS`:

```ts
  { key: "mcp.confirmElicitation", description: "enabled: an admin may confirm a change from an AI tool in the tool's own pop-up; disabled: only the Slack Confirm button or the CLI", target: parameter("control-plane", "McpConfirmElicitation"), defaultValue: "enabled", parse: oneOf("mcp.confirmElicitation", ["enabled", "disabled"]) },
```

and in `packages/cli/src/deploy/parameters.ts`, append `"McpConfirmElicitation"` to
`OPERATOR_PARAMETERS["control-plane"]`. In `tests/contract/config-commands.test.ts`, `rows`'s
expected length 11 becomes 12 (a list gaining an entry). `docs/day-two.md` lists the config keys:
add the row there too.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/contract/admin-change-configuration.test.ts tests/contract/config-*.test.ts tests/contract/deploy-environment.test.ts tests/contract/developer-identity-server.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/broker/src/developer/server.ts packages/broker/src/aws/developer-identity.ts packages/cli/src/config/keys.ts packages/cli/src/deploy/parameters.ts docs/day-two.md tests/contract/admin-change-configuration.test.ts tests/contract/config-commands.test.ts tests/contract/developer-identity-server.test.ts
git commit -m "feat(spec-025): report the confirmation methods, and agentx config set mcp.confirmElicitation (phase 25e)"
```

---
### Task 12: The MCP server's change calls and the confirmation driver

E13, E15, FR-041's order (the pop-up first, then Slack), FR-052's one trace ID per change tool
call. **Depends on Q9.**

**Files:**
- Modify: `packages/mcp/src/admin-client.ts` (the change calls; the change errors)
- Create: `packages/mcp/src/confirmation.ts`
- Modify: `packages/mcp/src/tools.ts` (`ToolCall.elicit`)
- Modify: `packages/mcp/src/server.ts` (build `elicit` from the client's capability)
- Test: `tests/contract/mcp-confirmation.test.ts`

**Interfaces:**
- Consumes: Task 1's schemas and types; 25d's `httpAdminClient`, `ADMIN_SIGN_IN_STEP`, `ToolError`,
  `NEXT_STEPS`.
- Produces:
  - `AdminControlPlaneClient` gains `proposeChange(request: ProposeAdminChangeRequest, traceId: string): Promise<AdminChangeView>`,
    `getChange(changeId: string, traceId: string): Promise<AdminChangeView>`,
    `startSlackConfirmation(changeId: string, traceId: string): Promise<AdminChangeView>`,
    `applyChange(changeId: string, body: { method: "elicitation" | "cli"; requestedAt?: string; answeredAt?: string }, traceId: string): Promise<AdminChangeView>`,
    `declineChange(changeId: string, body: { method: "elicitation" | "cli"; reason: "declined" | "cancelled" | "failed"; answeredAt?: string }, traceId: string): Promise<AdminChangeView>`,
    `changes(query: { since?: string; until?: string; admin?: string; outcome?: AdminChangeOutcome; limit?: number; cursor?: string }): Promise<AdminChangesResponse>`;
  - `ToolCall.elicit?(message: string, timeoutMs: number, signal: AbortSignal): Promise<"accept" | "decline" | "cancel" | "failed">`;
  - `export async function confirmChange(run: ConfirmationRun): Promise<{ outcome: "applied" | "awaiting_confirmation"; change: AdminChangeView }>`
    with `ConfirmationRun = { admin: AdminControlPlaneClient; change: AdminChangeView; traceId: string; elicit?: ToolCall["elicit"]; progress?: ToolCall["progress"]; sleep(ms: number, signal: AbortSignal): Promise<void>; now(): number; signal: AbortSignal; log?(entry: Record<string, unknown>): void }`;
  - `export function changeError(change: AdminChangeView): ToolError`;
  - `export const SLACK_POLL_MS = 5_000;`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/mcp-confirmation.test.ts
// Spec 025 FR-041, E13, E15: the pop-up first, then the Slack button; declined, expired and stale
// changes are FR-049's errors naming the change; a Slack wait ends as awaiting_confirmation.
import { describe, expect, it, vi } from "vitest";
import { ToolError, changeError, confirmChange, type AdminControlPlaneClient } from "../../packages/mcp/src/index.js";
import type { AdminChangeView } from "../../packages/contracts/src/index.js";

const CHANGE = "55555555-5555-4555-8555-555555555555";
const view = (extra: Partial<AdminChangeView> = {}): AdminChangeView => ({
  changeId: CHANGE, kind: "bind_channel", status: "pending", effect: "Bind channel #ledger-dev (C0LEDGER01) to project ledger.", methodsOffered: ["elicitation", "slack"],
  createdAt: "2026-10-02T09:00:00.000Z", expiresAt: "2026-10-02T09:10:00.000Z", ...extra,
});
function run(admin: Partial<AdminControlPlaneClient>, extra: Record<string, unknown> = {}) {
  let now = Date.parse("2026-10-02T09:00:01.000Z");
  const progress = vi.fn(async () => undefined);
  return {
    progress,
    run: { admin: admin as AdminControlPlaneClient, change: view(), traceId: "trace-9", progress, sleep: async (ms: number) => { now += ms; }, now: () => now, signal: new AbortController().signal, ...extra },
  };
}

describe("the confirmation driver (FR-041)", () => {
  it("applies after the pop-up's yes, reporting when it asked and when it was answered", async () => {
    const applyChange = vi.fn(async () => view({ status: "applied", methodUsed: "elicitation" }));
    const elicit = vi.fn(async () => "accept" as const);
    const { run: r } = run({ applyChange }, { elicit });
    expect(await confirmChange(r)).toMatchObject({ outcome: "applied" });
    expect(elicit).toHaveBeenCalledWith(expect.stringContaining("Bind channel #ledger-dev"), expect.any(Number), expect.anything());
    expect(applyChange).toHaveBeenCalledWith(CHANGE, { method: "elicitation", requestedAt: expect.any(String) as unknown, answeredAt: expect.any(String) as unknown }, "trace-9");
  });

  it("declines on no or a dismissed pop-up, and says CONFIRMATION_DECLINED with the change ID", async () => {
    for (const answer of ["decline", "cancel"] as const) {
      const declineChange = vi.fn(async () => view({ status: "declined" }));
      const { run: r } = run({ declineChange }, { elicit: async () => answer });
      await expect(confirmChange(r)).rejects.toMatchObject({ code: "CONFIRMATION_DECLINED", message: expect.stringContaining(CHANGE) as unknown });
      expect(declineChange).toHaveBeenCalledWith(CHANGE, expect.objectContaining({ method: "elicitation", reason: answer === "decline" ? "declined" : "cancelled" }), "trace-9");
    }
  });

  it("falls back to Slack when the pop-up fails, and declines when there is no Slack", async () => {
    const startSlackConfirmation = vi.fn(async () => view());
    const getChange = vi.fn().mockResolvedValueOnce(view()).mockResolvedValueOnce(view({ status: "applied", methodUsed: "slack" }));
    const { run: withSlack, progress } = run({ startSlackConfirmation, getChange }, { elicit: async () => "failed" as const });
    expect(await confirmChange(withSlack)).toMatchObject({ outcome: "applied" });
    expect(progress).toHaveBeenCalledWith(expect.any(Number), 300, expect.stringContaining("the pop-up could not be shown"));
    const declineChange = vi.fn(async () => view({ status: "declined" }));
    const { run: noSlack } = run({ declineChange }, { elicit: async () => "failed" as const, change: view({ methodsOffered: ["elicitation"] }) });
    await expect(confirmChange(noSlack)).rejects.toMatchObject({ code: "CONFIRMATION_DECLINED", message: expect.stringContaining("the confirmation pop-up could not be shown") as unknown });
    expect(declineChange).toHaveBeenCalledWith(CHANGE, expect.objectContaining({ reason: "failed" }), "trace-9");
  });

  it("waits five minutes for the Slack press, with progress every 15 seconds, then says awaiting_confirmation", async () => {
    const getChange = vi.fn(async () => view({ methodsOffered: ["slack"] }));
    const { run: r, progress } = run({ startSlackConfirmation: async () => view({ methodsOffered: ["slack"] }), getChange }, { change: view({ methodsOffered: ["slack"] }) });
    expect(await confirmChange(r)).toMatchObject({ outcome: "awaiting_confirmation" });
    expect(progress.mock.calls.length).toBeGreaterThanOrEqual(19);
    expect(getChange.mock.calls.length).toBeLessThanOrEqual(61);
  });

  it("stops waiting when the tool call is cancelled, leaving the change to its button (D7)", async () => {
    const controller = new AbortController();
    controller.abort();
    const { run: r } = run({ startSlackConfirmation: async () => view(), getChange: async () => view() }, { change: view({ methodsOffered: ["slack"] }), signal: controller.signal });
    expect(await confirmChange(r)).toMatchObject({ outcome: "awaiting_confirmation" });
  });
});

describe("change errors (E15, Q9)", () => {
  it("maps each ending to FR-049's code, naming the change", () => {
    expect(changeError(view({ status: "declined" }))).toMatchObject({ code: "CONFIRMATION_DECLINED" });
    expect(changeError(view({ status: "expired" }))).toMatchObject({ code: "CONFIRMATION_EXPIRED" });
    expect(changeError(view({ status: "failed", error: { code: "CHANGE_STALE", message: "what it was planned against has changed" } }))).toMatchObject({ code: "CHANGE_STALE" });
    const failed = changeError(view({ status: "failed", error: { code: "CONFIG_INVALID", message: "the per-person limit cannot be more than the organization limit" } }));
    expect(failed).toBeInstanceOf(ToolError);
    expect(failed).toMatchObject({ code: "INVALID_REQUEST", message: expect.stringContaining(`change ${CHANGE}`) as unknown });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/contract/mcp-confirmation.test.ts`
Expected: FAIL: `confirmChange` is not exported.

- [ ] **Step 3: The client's change calls**

In `packages/mcp/src/admin-client.ts`, generalize 25d's `get` into
`send<T>(schema, method: "GET" | "POST", path, body: unknown | undefined, traceId: string | undefined, tries: number)`,
keep `get` as `send(schema, "GET", path, undefined, undefined, tries)`, and add, retrying only the
proposal (its `requestId` makes a repeat the same request; an apply, a decline or a Slack step is
sent once):

```ts
const ChangeView = AdminChangeResponseSchema.transform((value) => value.change);
    proposeChange: (request, traceId) => send(ChangeView, "POST", "/v1/admin/changes", request, traceId, tries),
    getChange: (changeId, traceId) => send(ChangeView, "GET", `/v1/admin/changes/${changeId}`, undefined, traceId, tries),
    startSlackConfirmation: (changeId, traceId) => send(ChangeView, "POST", `/v1/admin/changes/${changeId}/slack`, {}, traceId, 1),
    applyChange: (changeId, body, traceId) => send(ChangeView, "POST", `/v1/admin/changes/${changeId}/apply`, body, traceId, 1),
    declineChange: (changeId, body, traceId) => send(ChangeView, "POST", `/v1/admin/changes/${changeId}/decline`, body, traceId, 1),
    changes: (query) => send(AdminChangesResponseSchema, "GET", `/v1/admin/changes${search({ since: query.since, until: query.until, admin: query.admin, outcome: query.outcome, limit: query.limit, cursor: query.cursor })}`, undefined, undefined, tries),
```

(`changeId` is always a UUID the control plane made, so it needs no encoding.) Extend `refusal`
for the change codes, before its last two lines:

```ts
  if (code === "CONFIRMATION_UNAVAILABLE" || code === "CONFIRMATION_DECLINED" || code === "CONFIRMATION_EXPIRED" || code === "CHANGE_STALE") return new ToolError(code, message);
  if (code === "SLACK_UNAVAILABLE") return new ToolError("SLACK_UNAVAILABLE", message);
  // FR-015: the admin may change only projects they administer.
  if (code === "FORBIDDEN" && message.includes("membership")) return new ToolError("ADMIN_REQUIRED", message, "ask an AgentX admin who administers that project to make this change");
  if (code === "NOT_FOUND" || code === "PROJECT_REVISION_MISMATCH" || code === "WORKSPACE_BUSY" || code === "IDEMPOTENCY_CONFLICT") return new ToolError("INVALID_REQUEST", message);
```

A `NOT_FOUND` from `requireMembership` reads "project not found" on a project the admin does not
administer; the refusal keeps the broker's words.

- [ ] **Step 4: The driver**

```ts
// packages/mcp/src/confirmation.ts
// Spec 025 FR-041, E13, E15: confirm a planned change in the client's own pop-up when it can show
// one, else by the Slack Confirm button; apply it, decline it, or report that it waits. One trace
// ID runs through every call of one change (FR-052).
import { ADMIN_CHANGE_PROGRESS_MS, ADMIN_CHANGE_SLACK_WAIT_MS, type AdminChangeView } from "@agentx/contracts";
import type { AdminControlPlaneClient } from "./admin-client.js";
import { ToolError } from "./errors.js";
import type { ToolCall } from "./tools.js";

export const SLACK_POLL_MS = 5_000;
/** The pop-up gets at most this long, and always ends before the change's own 10 minutes. */
const ELICITATION_MAX_MS = 9 * 60_000;

export interface ConfirmationRun {
  admin: AdminControlPlaneClient;
  change: AdminChangeView;
  traceId: string;
  elicit?: ToolCall["elicit"];
  progress?: ToolCall["progress"];
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  now(): number;
  signal: AbortSignal;
  log?(entry: Record<string, unknown>): void;
}

const CODES = new Set(["CONFIRMATION_UNAVAILABLE", "CONFIRMATION_DECLINED", "CONFIRMATION_EXPIRED", "CHANGE_STALE", "SLACK_UNAVAILABLE", "ADMIN_REQUIRED"]);

/** E15: why a change did not apply, as FR-049's code, naming the change. */
export function changeError(change: AdminChangeView): ToolError {
  const named = (text: string) => `change ${change.changeId}: ${text}`;
  if (change.status === "declined") return new ToolError("CONFIRMATION_DECLINED", named("it was declined, so nothing changed"));
  if (change.status === "expired") return new ToolError("CONFIRMATION_EXPIRED", named(`it expired at ${change.expiresAt} without a confirmation, so nothing changed`));
  const code = change.error?.code;
  const message = named(change.error?.message ?? "it was not applied");
  if (code !== undefined && CODES.has(code)) return new ToolError(code as ToolError["code"], message);
  if (code === "RUNTIME_UNAVAILABLE") return new ToolError("CONTROL_PLANE_UNAVAILABLE", message);
  return new ToolError("INVALID_REQUEST", message);
}

const iso = (ms: number) => new Date(ms).toISOString();
const ended = (change: AdminChangeView) => change.status !== "pending" && change.status !== "applying";

async function waitForSlack(run: ConfirmationRun, note: string): Promise<{ outcome: "applied" | "awaiting_confirmation"; change: AdminChangeView }> {
  let change = await run.admin.startSlackConfirmation(run.change.changeId, run.traceId);
  const started = run.now();
  let lastProgress = -ADMIN_CHANGE_PROGRESS_MS;
  const total = ADMIN_CHANGE_SLACK_WAIT_MS / 1_000;
  while (!run.signal.aborted && run.now() - started < ADMIN_CHANGE_SLACK_WAIT_MS) {
    const elapsed = run.now() - started;
    if (elapsed - lastProgress >= ADMIN_CHANGE_PROGRESS_MS) {
      lastProgress = elapsed;
      await run.progress?.(Math.floor(elapsed / 1_000), total, `${note}Waiting for your Confirm in Slack: ${Math.ceil((ADMIN_CHANGE_SLACK_WAIT_MS - elapsed) / 1_000)} seconds left`);
    }
    await run.sleep(SLACK_POLL_MS, run.signal);
    try {
      change = await run.admin.getChange(run.change.changeId, run.traceId);
    } catch (error) {
      // A failed check is tried again at the next poll; the press still applies server side (D7).
      run.log?.({ event: "change.poll_failed", changeId: run.change.changeId, code: error instanceof ToolError ? error.code : "unknown" });
      continue;
    }
    if (ended(change)) break;
  }
  if (change.status === "applied") return { outcome: "applied", change };
  if (ended(change)) throw changeError(change);
  return { outcome: "awaiting_confirmation", change };
}

export async function confirmChange(run: ConfirmationRun): Promise<{ outcome: "applied" | "awaiting_confirmation"; change: AdminChangeView }> {
  const offered = run.change.methodsOffered;
  const slack = offered.includes("slack");
  if (offered.includes("elicitation") && run.elicit !== undefined) {
    const requestedAt = iso(run.now());
    const timeout = Math.max(1_000, Math.min(ELICITATION_MAX_MS, Date.parse(run.change.expiresAt) - run.now() - 30_000));
    const answer = await run.elicit(`${run.change.effect}\n\nApply this change? It expires at ${run.change.expiresAt}.`, timeout, run.signal);
    const answeredAt = iso(run.now());
    if (answer === "accept") {
      const applied = await run.admin.applyChange(run.change.changeId, { method: "elicitation", requestedAt, answeredAt }, run.traceId);
      if (applied.status === "applied") return { outcome: "applied", change: applied };
      throw changeError(applied);
    }
    if (answer === "decline" || answer === "cancel") {
      const declined = await run.admin.declineChange(run.change.changeId, { method: "elicitation", reason: answer === "decline" ? "declined" : "cancelled", answeredAt }, run.traceId);
      throw changeError(declined);
    }
    // The pop-up could not be shown or answered: Slack if it was offered, else the change is dropped.
    run.log?.({ event: "change.elicitation_failed", changeId: run.change.changeId });
    if (!slack) {
      await run.admin.declineChange(run.change.changeId, { method: "elicitation", reason: "failed", answeredAt }, run.traceId);
      throw new ToolError("CONFIRMATION_DECLINED", `change ${run.change.changeId}: the confirmation pop-up could not be shown, so nothing changed`);
    }
    return waitForSlack(run, "the pop-up could not be shown. ");
  }
  if (slack) return waitForSlack(run, "");
  throw new ToolError("CONFIRMATION_UNAVAILABLE", `change ${run.change.changeId}: no confirmation method is available in this session`);
}
```

- [ ] **Step 5: `elicit` on the tool call**

In `packages/mcp/src/tools.ts`, add to `ToolCall`:
`/** Spec 025 FR-041: the client's pop-up; absent when the client declared no elicitation. */ elicit?(message: string, timeoutMs: number, signal: AbortSignal): Promise<"accept" | "decline" | "cancel" | "failed">;`

In `packages/mcp/src/server.ts`'s shared handler, build it:

```ts
      const capabilities = server.server.getClientCapabilities();
      // An empty elicitation object means form support in older clients; SDK 1.30.1's elicitInput
      // wants `form`, so the request is sent directly, without a mode (the spec's original shape).
      const elicit = capabilities?.elicitation === undefined ? undefined : async (message: string, timeoutMs: number, signal: AbortSignal) => {
        try {
          const answer = await server.server.request(
            { method: "elicitation/create", params: { message: safeText(message, 4_000), requestedSchema: { type: "object", properties: { confirm: { type: "boolean", title: "Apply this change", default: false } }, required: ["confirm"] } } },
            ElicitResultSchema,
            { signal, timeout: timeoutMs },
          );
          if (answer.action === "accept") return answer.content?.confirm === true ? "accept" as const : "decline" as const;
          return answer.action;
        } catch {
          return "failed" as const;
        }
      };
```

and add `...(elicit === undefined ? {} : { elicit })` to the `call` object. `ElicitResultSchema`
comes from `@modelcontextprotocol/sdk/types.js`. Export `confirmation.js` from `index.ts`.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/contract/mcp-confirmation.test.ts tests/contract/mcp-admin-client.test.ts tests/contract/mcp-tools.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/mcp/src tests/contract/mcp-confirmation.test.ts
git commit -m "feat(mcp): change calls, and the confirmation driver: the pop-up first, then Slack (spec 025 phase 25e)"
```

---

### Task 13: The change tools, `agentx_admin_changes`, and when they are offered

FR-030's nine admin change tools and `agentx_admin_changes`; FR-028 and FR-041's offer (change
tools only with a confirmation method; `CONFIRMATION_UNAVAILABLE` for a direct call); E15, E18.
**Depends on Q9** and **Q11**.

**Files:**
- Create: `packages/mcp/src/change-tools.ts`
- Modify: `packages/mcp/src/offer.ts` (groups)
- Modify: `packages/mcp/src/server.ts` (`auditTools`, `changeTools`; the client's capability to the offer)
- Modify: `packages/mcp/src/compatibility.ts` (`confirm`; `adminApiFits`'s minor)
- Modify: `packages/mcp/src/client.ts` (`confirm` in the configuration)
- Modify: `packages/mcp/src/tools.ts` (`ToolContext.confirmation`, `clientVersion`; export `requestIdFor`)
- Modify: `packages/cli/src/mcp/serve.ts` (the three groups' offer; the confirmation methods)
- Test: `tests/contract/mcp-change-tools.test.ts`

**Interfaces:**
- Consumes: Task 12's `confirmChange`, `changeError`; 25d's `adminOf`, `ToolOffer`, `adminApiFits`.
- Produces:
  - `export const ADMIN_CHANGE_TOOLS: readonly ToolDefinition[]` (nine, in FR-030's order) and
    `export const ADMIN_AUDIT_TOOLS: readonly ToolDefinition[]` (`agentx_admin_changes`);
  - `AdminOffer` gains `audit?: ToolError | undefined` and `changes?: ToolError | undefined` (a
    group is offered only when its key is present and holds `undefined`; 25d's offers, which name
    only `admin`, offer neither);
  - `ToolOffer`'s `tools` map values become `{ tool: Switchable; group: "admin" | "audit" | "changes" }`;
  - `createAgentXMcpServer` options gain `auditTools?`, `changeTools?`; `adminOffer` receives
    `{ elicitation: boolean }` (whether the client declared the capability);
  - `adminApiFits(version, requiredMinor = REQUIRED_ADMIN_MINOR)`; `Compatibility.confirm?: { elicitation: boolean; slack: boolean }`;
  - `ToolContext.confirmation?(): Promise<{ elicitation: boolean; slack: boolean }>` (the environment's
    and the admin's own; the server adds the client's), `ToolContext.clientVersion?: string`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/mcp-change-tools.test.ts
// Spec 025 FR-028, FR-030, FR-041: the change tools, offered only with a confirmation method, each
// planning, confirming and applying in one call.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { ADMIN_AUDIT_TOOLS, ADMIN_CHANGE_TOOLS, ADMIN_READ_TOOLS, ToolError, createAgentXMcpServer, type AdminControlPlaneClient, type AdminOffer, type ToolContext } from "../../packages/mcp/src/index.js";
import { toolError } from "../support/mcp-tool-error.js";

const CHANGE = "55555555-5555-4555-8555-555555555555";
const pending = { changeId: CHANGE, kind: "bind_channel" as const, status: "pending" as const, effect: "Bind channel #ledger-dev (C0LEDGER01) to project ledger.", methodsOffered: ["elicitation" as const], createdAt: "2026-10-02T09:00:00.000Z", expiresAt: "2026-10-02T09:10:00.000Z" };

async function connect(options: { admin?: Partial<AdminControlPlaneClient>; elicitation?: boolean; offer?: (client: { elicitation: boolean }) => Promise<AdminOffer>; answer?: "accept" | "decline" }) {
  const context = (): ToolContext => ({
    client: {} as never, clientName: "claude-code", clientVersion: "2.1.0", serverVersion: "0.0.7", adminSignedIn: async () => true,
    compatibility: async () => ({ env: "staging", apiVersion: "1.2", adminApiVersion: "1.1", confirm: { elicitation: true, slack: false } }),
    confirmation: async () => ({ elicitation: true, slack: false }),
    now: () => Date.parse("2026-10-02T09:00:01.000Z"), sleep: async () => undefined, newRequestId: () => "88888888-8888-4888-8888-888888888888",
    ...(options.admin === undefined ? {} : { admin: options.admin as AdminControlPlaneClient }),
  });
  const offer = options.offer ?? (async (client: { elicitation: boolean }) => ({ admin: undefined, audit: undefined, changes: client.elicitation ? undefined : new ToolError("CONFIRMATION_UNAVAILABLE", "no confirmation method is available in this session") }));
  const server = createAgentXMcpServer({ version: "0.0.7", context, adminTools: ADMIN_READ_TOOLS, auditTools: ADMIN_AUDIT_TOOLS, changeTools: ADMIN_CHANGE_TOOLS, adminOffer: offer });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "claude-code", version: "2.1.0" }, { capabilities: options.elicitation === false ? {} : { elicitation: { form: {} } } });
  const asked: string[] = [];
  if (options.elicitation !== false) client.setRequestHandler(ElicitRequestSchema, async (request) => { asked.push(String(request.params.message)); return options.answer === "decline" ? { action: "decline" } : { action: "accept", content: { confirm: true } }; });
  await client.connect(clientSide);
  return { client, asked };
}

describe("the change tools (FR-030)", () => {
  it("are FR-030's nine, in order, plus agentx_admin_changes", () => {
    expect(ADMIN_CHANGE_TOOLS.map((tool) => tool.name)).toEqual([
      "agentx_admin_register_project_revision", "agentx_admin_bind_channel", "agentx_admin_unbind_channel", "agentx_admin_register_credential", "agentx_admin_stop_workspace",
      "agentx_admin_grant_project_access", "agentx_admin_revoke_project_access", "agentx_admin_revoke_signin", "agentx_admin_set_workspace_limits",
    ]);
    expect(ADMIN_AUDIT_TOOLS.map((tool) => tool.name)).toEqual(["agentx_admin_changes"]);
    expect(JSON.stringify([...ADMIN_CHANGE_TOOLS, ...ADMIN_AUDIT_TOOLS].map((tool) => tool.description))).not.toContain(String.fromCharCode(0x2014));
  });

  it("plans, shows the effect in the pop-up, applies on yes, and answers the change ID and outcome", async () => {
    const proposeChange = vi.fn(async () => pending);
    const applyChange = vi.fn(async () => ({ ...pending, status: "applied" as const, methodUsed: "elicitation" as const, result: { binding: { channelId: "C0LEDGER01" } } }));
    const { client, asked } = await connect({ admin: { proposeChange, applyChange } });
    await expect.poll(async () => (await client.listTools()).tools.some((tool) => tool.name === "agentx_admin_bind_channel")).toBe(true);
    const result = await client.callTool({ name: "agentx_admin_bind_channel", arguments: { channel: "#ledger-dev", project: "ledger" } });
    expect(proposeChange).toHaveBeenCalledWith({ requestId: expect.any(String) as unknown, change: { kind: "bind_channel", channel: "#ledger-dev", project: "ledger" }, client: { cliVersion: "0.0.7", mcpClient: { name: "claude-code", version: "2.1.0" } }, methods: ["elicitation"] }, "88888888-8888-4888-8888-888888888888");
    expect(asked[0]).toContain("Bind channel #ledger-dev (C0LEDGER01) to project ledger.");
    expect(result.structuredContent).toMatchObject({ change_id: CHANGE, outcome: "applied", method: "elicitation", effect: pending.effect });
  });

  it("answers CONFIRMATION_DECLINED naming the change when the admin says no", async () => {
    const { client } = await connect({ admin: { proposeChange: async () => pending, declineChange: async () => ({ ...pending, status: "declined" as const }) }, answer: "decline" });
    await expect.poll(async () => (await client.listTools()).tools.some((tool) => tool.name === "agentx_admin_unbind_channel")).toBe(true);
    expect(toolError(await client.callTool({ name: "agentx_admin_unbind_channel", arguments: { channel: "C0LEDGER01" } }))).toMatchObject({ code: "CONFIRMATION_DECLINED", message: expect.stringContaining(CHANGE) as unknown });
  });

  it("offers no change tool, and answers CONFIRMATION_UNAVAILABLE, in a client with neither method (FR-041)", async () => {
    const { client } = await connect({ admin: {}, elicitation: false });
    await expect.poll(async () => (await client.listTools()).tools.some((tool) => tool.name === "agentx_admin_changes")).toBe(true);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names.filter((name) => ADMIN_CHANGE_TOOLS.some((tool) => tool.name === name))).toEqual([]);
    expect(toolError(await client.callTool({ name: "agentx_admin_set_workspace_limits", arguments: { per_person: 5 } }))).toMatchObject({ code: "CONFIRMATION_UNAVAILABLE", next_step: "use a client that supports elicitation, link a Slack user, or use the agentx CLI" });
  });

  it("maps the limits tool's snake_case input, and refuses an empty one before planning", async () => {
    const proposeChange = vi.fn(async () => pending);
    const { client } = await connect({ admin: { proposeChange, applyChange: async () => ({ ...pending, status: "applied" as const }) } });
    await expect.poll(async () => (await client.listTools()).tools.some((tool) => tool.name === "agentx_admin_set_workspace_limits")).toBe(true);
    await client.callTool({ name: "agentx_admin_set_workspace_limits", arguments: { per_person: 5 } });
    expect(proposeChange).toHaveBeenCalledWith(expect.objectContaining({ change: { kind: "set_workspace_limits", perPerson: 5 } }), expect.any(String));
    expect(toolError(await client.callTool({ name: "agentx_admin_set_workspace_limits", arguments: {} }))).toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("lists the audit records with agentx_admin_changes, newest first, with the next cursor", async () => {
    const changes = vi.fn(async () => ({ cursor: "more", changes: [{
      changeId: CHANGE, kind: "bind_channel" as const, traceId: "t", status: "applied" as const, outcome: "confirmed" as const, admin: { issuer: "i", subject: "s", displayName: "Ada" }, client: { cliVersion: "0.0.7", mcpClientName: "claude-code" },
      change: {}, effect: pending.effect, methodsOffered: ["elicitation" as const], methodUsed: "elicitation" as const, proposedAt: "2026-10-02T09:00:00.000Z", appliedAt: "2026-10-02T09:01:00.000Z",
    }] }));
    const { client } = await connect({ admin: { changes } });
    await expect.poll(async () => (await client.listTools()).tools.some((tool) => tool.name === "agentx_admin_changes")).toBe(true);
    const result = await client.callTool({ name: "agentx_admin_changes", arguments: { outcome: "confirmed", limit: 10 } });
    expect(changes).toHaveBeenCalledWith(expect.objectContaining({ outcome: "confirmed", limit: 10, since: expect.any(String) as unknown }));
    expect(result.structuredContent).toMatchObject({ next_cursor: "more", changes: [{ change_id: CHANGE, outcome: "confirmed", admin: "Ada", method_used: "elicitation" }] });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/contract/mcp-change-tools.test.ts`
Expected: FAIL: `ADMIN_CHANGE_TOOLS` is not exported.

- [ ] **Step 3: Offer groups**

In `packages/mcp/src/offer.ts`: add `audit?: ToolError | undefined; changes?: ToolError | undefined`
to `AdminOffer`; make the constructor's `tools` a `Map<string, { tool: Switchable; group: "admin" | "audit" | "changes" }>`;
and decide per group:

```ts
const UPGRADE = new ToolError("UPGRADE_REQUIRED", "this AgentX has no admin change tools yet", "ask your AgentX admin to upgrade AgentX, or use an older CLI");
/** A group is offered only when named and undefined; while the admin group is refused, all are, for its reason. */
function refusalOf(offer: AdminOffer, group: "admin" | "audit" | "changes"): ToolError | undefined {
  if (offer.admin !== undefined) return offer.admin;
  if (group === "admin") return undefined;
  return group in offer ? offer[group] : UPGRADE;
}
```

`refresh` enables a tool when `refusalOf(current, entry.group) === undefined` and disables it
otherwise; `refusal(name)` answers `refusalOf(current, entry.group)` for a disabled tool.
`read` now receives `{ elicitation: boolean }` (see Step 4). 25d's tests pass an `adminOffer` that
names only `admin`; their admin read tools behave as before.

- [ ] **Step 4: The server**

In `packages/mcp/src/server.ts`: register `options.auditTools ?? []` (group `audit`) and
`options.changeTools ?? []` (group `changes`) exactly as 25d's admin tools (disabled at once), all
in one map with their groups, and call the offer's reader with
`{ elicitation: server.server.getClientCapabilities()?.elicitation !== undefined }`. Pass the
client's version to the context: `options.context(server.server.getClientVersion()?.name, server.server.getClientVersion()?.version)`
(the second parameter is optional in `context`'s type, so 25b's callers are unchanged).

In `packages/mcp/src/compatibility.ts`: `adminApiFits(version, requiredMinor = REQUIRED_ADMIN_MINOR)`
compares the minor with `requiredMinor`; `Compatibility` gains `confirm?`, copied from the
configuration (`client.ts`'s `ConfigurationSchema` gains
`confirm: z.object({ elicitation: z.boolean(), slack: z.boolean() }).optional()`).

- [ ] **Step 5: The tools**

```ts
// packages/mcp/src/change-tools.ts
// Spec 025 FR-030: the admin change tools. Each call plans the change, gets a confirmation the
// model cannot give (the client's pop-up, or the Slack Confirm button), and only then applies it,
// all in one call (FR-039 to FR-041). agentx_admin_changes reads the audit records (FR-052).
import { ADMIN_LIST_MAX, AdminChangeOutcomeSchema, type AdminChangeInput } from "@agentx/contracts";
import { z } from "zod";
import { adminOf } from "./admin-tools.js";
import { confirmChange, changeError } from "./confirmation.js";
import { ToolError } from "./errors.js";
import { requestIdFor, type ToolCall, type ToolContext, type ToolDefinition, type ToolResult } from "./tools.js";

const requestIdInput = z.string().uuid().optional().describe("a UUID of your choosing; send the same one again to retry safely. When left out, an identical call within 15 minutes counts as a retry of the first");
const ChangeShape = { change_id: z.string(), outcome: z.enum(["applied", "awaiting_confirmation"]), effect: z.string(), method: z.string().optional(), result: z.record(z.string(), z.unknown()).optional(), expires_at: z.string(), request_id: z.string() };
const HOW = "It first shows exactly what will change and asks you to confirm in a pop-up, or with the Confirm button AgentX sends you in Slack; nothing changes until you do. If you confirm in Slack after this call stops waiting, the change still applies within 10 minutes; check it with agentx_admin_changes.";

async function runChange(context: ToolContext, call: ToolCall, input: Record<string, unknown>, change: AdminChangeInput): Promise<ToolResult> {
  const admin = adminOf(context);
  const allowed = (await context.confirmation?.()) ?? { elicitation: false, slack: false };
  const methods = [...(call.elicit !== undefined && allowed.elicitation ? ["elicitation" as const] : []), ...(allowed.slack ? ["slack" as const] : [])];
  if (methods.length === 0) throw new ToolError("CONFIRMATION_UNAVAILABLE", "no confirmation method is available in this session");
  const traceId = context.newRequestId();
  const requestId = requestIdFor(context, call, input, ["admin_change", change]);
  const planned = await admin.proposeChange({
    requestId, change, methods,
    client: { cliVersion: context.serverVersion, ...(context.clientName === undefined ? {} : { mcpClient: { name: context.clientName.slice(0, 200), ...(context.clientVersion === undefined ? {} : { version: context.clientVersion.slice(0, 64) }) } }) },
  }, traceId);
  // A repeated request ID answers a change already decided.
  const settled = planned.status === "pending"
    ? await confirmChange({ admin, change: planned, traceId, ...(call.elicit === undefined ? {} : { elicit: call.elicit }), ...(call.progress === undefined ? {} : { progress: call.progress }), sleep: (ms, signal) => context.sleep(ms, signal), now: () => context.now(), signal: call.signal, ...(call.log === undefined ? {} : { log: call.log }) })
    : planned.status === "applied" ? { outcome: "applied" as const, change: planned } : (() => { throw changeError(planned); })();
  const view = settled.change;
  return {
    structured: {
      change_id: view.changeId, outcome: settled.outcome, effect: view.effect, expires_at: view.expiresAt, request_id: requestId,
      ...(view.methodUsed === undefined ? {} : { method: view.methodUsed }), ...(view.result === undefined ? {} : { result: view.result }),
    },
    text: settled.outcome === "applied"
      ? `Applied change ${view.changeId}: ${view.effect}`
      : `Change ${view.changeId} is waiting for your Confirm in Slack until ${view.expiresAt}: ${view.effect} Check it with agentx_admin_changes.`,
  };
}

const tool = (name: string, title: string, what: string, inputSchema: z.ZodRawShape, toChange: (input: Record<string, unknown>) => AdminChangeInput): ToolDefinition => ({
  name, title, description: `${what} ${HOW}`, inputSchema: { ...inputSchema, request_id: requestIdInput }, outputSchema: ChangeShape,
  handler: (context, input, call) => runChange(context, call, input, toChange(input)),
});
const text = (value: unknown) => value as string;

export const ADMIN_CHANGE_TOOLS: readonly ToolDefinition[] = [
  tool("agentx_admin_register_project_revision", "Register an AgentX project revision",
    "Registers a new revision of an existing project from its full definition, keeping the project's worker settings. The confirmation shows the new revision number, each changed field, and the registration preflight's findings.",
    { definition: z.record(z.string(), z.unknown()).describe("the whole project definition, with name and the next revision number") },
    (input) => ({ kind: "register_project_revision", definition: input.definition as Record<string, unknown> })),
  tool("agentx_admin_bind_channel", "Bind a Slack channel to an AgentX project",
    "Binds a Slack channel to a project, so new threads there use the project's latest revision. The confirmation shows the channel, what it is bound to today, and the revision new threads will use.",
    { channel: z.string().min(1).max(80).describe("a channel ID such as C0123456789, or a public channel's name"), project: z.string().min(1).max(63).describe("the project's exact name") },
    (input) => ({ kind: "bind_channel", channel: text(input.channel), project: text(input.project) })),
  tool("agentx_admin_unbind_channel", "Unbind a Slack channel",
    "Removes a channel's binding: new messages there get no reply, and existing thread workspaces are kept.",
    { channel: z.string().min(1).max(80).describe("a channel ID, or a public channel's name") },
    (input) => ({ kind: "unbind_channel", channel: text(input.channel) })),
  tool("agentx_admin_register_credential", "Register an AgentX connector credential",
    "Registers a connector credential by reference, type and secret name. Never pass a secret's value: AgentX refuses any input that looks like one. The confirmation shows whether the secret exists and reads as that type, and which projects name the reference.",
    { ref: z.string().min(1).max(63).describe("the credential reference connectors name"), type: z.string().min(1).max(64).describe("static-secret, oauth-client-credentials or oauth-refresh-token"), secret_name: z.string().min(1).max(512).describe("the secret's name under agentx/connectors/, never its value") },
    (input) => ({ kind: "register_credential", ref: text(input.ref), type: text(input.type), secretName: text(input.secret_name) })),
  tool("agentx_admin_stop_workspace", "Stop a workspace's running task",
    "Cancels the task running in a workspace; its compute stops on its own when idle. The confirmation shows the workspace, its project, owner and status, and the task that will be cancelled.",
    { workspace_id: z.string().uuid().describe("the workspace ID, from agentx_admin_list_workspaces") },
    (input) => ({ kind: "stop_workspace", workspaceId: text(input.workspace_id) })),
  tool("agentx_admin_grant_project_access", "Grant a developer access to an AgentX project",
    "Lets a developer hand tasks to a project from their AI tool, whatever channels they are in. Name them by Slack user ID (which works before their first sign-in), by the email they signed in with, or by developer ID. The confirmation shows who they are and their current access.",
    { project: z.string().min(1).max(63).describe("the project's exact name"), developer: z.string().min(1).max(254).describe("a Slack user ID such as U0123456789, an email, or a developer ID") },
    (input) => ({ kind: "grant_project_access", project: text(input.project), developer: text(input.developer) })),
  tool("agentx_admin_revoke_project_access", "Revoke a developer's granted project access",
    "Removes a developer's grant for a project; their running tasks keep running, and channel membership may still give them access, which the confirmation says.",
    { project: z.string().min(1).max(63).describe("the project's exact name"), developer: z.string().min(1).max(254).describe("a Slack user ID, an email, or a developer ID") },
    (input) => ({ kind: "revoke_project_access", project: text(input.project), developer: text(input.developer) })),
  tool("agentx_admin_revoke_signin", "End a developer's AgentX sign-in",
    "Ends every AgentX sign-in session a developer has, at once; they may sign in again. Their running tasks keep running.",
    { developer: z.string().min(1).max(254).describe("a Slack user ID, an email, or a developer ID") },
    (input) => ({ kind: "revoke_signin", developer: text(input.developer) })),
  tool("agentx_admin_set_workspace_limits", "Set AgentX's workspace limits",
    "Changes how many workspaces one person, and the whole organization, may have open. It takes effect at the next workspace creation, with no stack update; existing workspaces keep running. The confirmation shows the current and new limits, the counts, and who is already at or over the new limit.",
    { per_person: z.number().int().min(1).max(50).optional().describe("the per-person limit, 1 to 50"), per_organization: z.number().int().min(1).max(1_000).optional().describe("the organization limit, 1 to 1,000") },
    (input) => {
      if (input.per_person === undefined && input.per_organization === undefined) throw new ToolError("INVALID_REQUEST", "give per_person, per_organization or both");
      return { kind: "set_workspace_limits", ...(input.per_person === undefined ? {} : { perPerson: input.per_person as number }), ...(input.per_organization === undefined ? {} : { perOrganization: input.per_organization as number }) };
    }),
];

export const ADMIN_AUDIT_TOOLS: readonly ToolDefinition[] = [{
  name: "agentx_admin_changes",
  title: "Read AgentX admin change records",
  description: "Lists admin change records, newest first: who asked and from which client, the exact change, how it was confirmed (and by which Slack user), its outcome with the time of each step, the result or error, refused attempts, and its trace ID. since defaults to 7 days ago; records are kept 30 days. Send next_cursor back as cursor for more.",
  inputSchema: {
    since: z.string().datetime({ offset: true }).optional().describe("ISO time to start from; 7 days ago by default"),
    until: z.string().datetime({ offset: true }).optional().describe("ISO time to stop at"),
    admin: z.string().min(1).max(256).optional().describe("only changes this admin asked for, by their sign-in subject"),
    outcome: AdminChangeOutcomeSchema.optional().describe("confirmed, declined, expired or failed"),
    limit: z.number().int().min(1).max(ADMIN_LIST_MAX).optional().describe("how many to show, 1 to 100; 25 by default"),
    cursor: z.string().min(1).max(2_048).optional().describe("next_cursor from the previous call"),
  },
  outputSchema: { changes: z.array(z.record(z.string(), z.unknown())), next_cursor: z.string().optional() },
  async handler(context, input) {
    const since = (input.since as string | undefined) ?? new Date(context.now() - 7 * 86_400_000).toISOString();
    const page = await adminOf(context).changes({ since, ...Object.fromEntries(["until", "admin", "outcome", "limit", "cursor"].filter((key) => input[key] !== undefined).map((key) => [key, input[key]])) });
    const changes = page.changes.map((record) => ({
      change_id: record.changeId, kind: record.kind, status: record.status, ...(record.outcome === undefined ? {} : { outcome: record.outcome }),
      admin: record.admin.displayName ?? record.admin.subject, client: record.client, change: record.change, effect: record.effect,
      methods_offered: record.methodsOffered, ...(record.methodUsed === undefined ? {} : { method_used: record.methodUsed }), ...(record.pressedBy === undefined ? {} : { pressed_by: record.pressedBy }),
      proposed_at: record.proposedAt, ...Object.fromEntries((["confirmationRequestedAt", "answeredAt", "appliedAt", "failedAt", "expiredAt"] as const).filter((key) => record[key] !== undefined).map((key) => [key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`), record[key]])),
      ...(record.result === undefined ? {} : { result: record.result }), ...(record.error === undefined ? {} : { error: record.error }),
      ...(record.refusedAttempts === undefined ? {} : { refused_attempts: record.refusedAttempts }), trace_id: record.traceId,
    }));
    return {
      structured: { changes, ...(page.cursor === undefined ? {} : { next_cursor: page.cursor }) },
      text: `${changes.length} change record${changes.length === 1 ? "" : "s"}.${page.cursor === undefined ? "" : " More remain: call again with cursor set to next_cursor."}`,
    };
  },
}];
```

Export `requestIdFor` from `tools.ts` (it is module-private today; the change tools reuse it so
a retried call reaches AgentX as the same request) and both lists from `index.ts`. Add to
`ToolContext`: `confirmation?(): Promise<{ elicitation: boolean; slack: boolean }>;` and
`clientVersion?: string;`.

- [ ] **Step 6: `agentx mcp`'s offer and methods**

In `packages/cli/src/mcp/serve.ts`, extend 25d's `adminOffer` and give the context `confirmation`
and `clientVersion`:

```ts
  let me: { at: number; value: Promise<AdminMeResponse | undefined> } | undefined;
  /** The admin's Slack link, read at most once a minute (FR-041's "whether the signed-in admin has a Slack link"). */
  const adminMe = () => {
    if (me === undefined || now() - me.at > 60_000) me = { at: now(), value: admin.me().catch(() => undefined) };
    return me.value;
  };
  const confirmation = async () => {
    const confirm = (await compatibility()).confirm ?? { elicitation: false, slack: false };
    return { elicitation: confirm.elicitation, slack: confirm.slack && (await adminMe())?.slack.linked === true };
  };
  const adminOffer = async (client: { elicitation: boolean }): Promise<AdminOffer> => {
    const reads = await readsOffer();            // 25d's body, renamed: undefined or the refusal
    if (reads !== undefined) return { admin: reads, audit: reads, changes: reads };
    if (adminApiFits((await compatibility()).adminApiVersion, 1) !== "fits") {
      const upgrade = new ToolError("UPGRADE_REQUIRED", "this AgentX has no admin change tools yet", UPGRADE_AGENTX_STEP);
      return { admin: undefined, audit: upgrade, changes: upgrade };
    }
    const methods = await confirmation();
    const any = (client.elicitation && methods.elicitation) || methods.slack;
    return { admin: undefined, audit: undefined, changes: any ? undefined : new ToolError("CONFIRMATION_UNAVAILABLE", "no confirmation method is available in this session") };
  };
```

and pass `auditTools: ADMIN_AUDIT_TOOLS, changeTools: ADMIN_CHANGE_TOOLS` to
`createAgentXMcpServer`, with `confirmation` and `...(clientVersion === undefined ? {} : { clientVersion })`
in the context. `readsOffer` is 25d's `adminOffer` body returning its `admin` field.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run tests/contract/mcp-change-tools.test.ts tests/contract/mcp-admin-offer.test.ts tests/contract/mcp-admin-session.test.ts tests/contract/mcp-admin-tools.test.ts tests/contract/mcp-tools.test.ts tests/contract/mcp-stdio.test.ts && npm run typecheck`
Expected: PASS. 25d's offer tests name only `admin`, so their audit and change tools (none) and
their admin read tools behave as before; `mcp-admin-session.test.ts`'s control plane answers
admin API 1.0, so its list stays at nineteen tools.

- [ ] **Step 8: Commit**

```bash
git add packages/mcp/src packages/cli/src/mcp/serve.ts tests/contract/mcp-change-tools.test.ts
git commit -m "feat(mcp): the admin change tools and agentx_admin_changes, offered only with a confirmation method (spec 025 phase 25e)"
```

---
### Task 14: `agentx admin changes`, and `agentx admin project grant` and `revoke`

FR-052's CLI export; the owner's requirement of a CLI equivalent for granting (and revoking) a
developer's project access, through the same change path (E17). **Depends on Q4** and **Q6**.

**Files:**
- Create: `packages/cli/src/admin/changes.ts`
- Modify: `packages/cli/src/main.ts` (three commands)
- Test: `tests/contract/admin-changes-cli.test.ts`

**Interfaces:**
- Consumes: `ProposeAdminChangeRequest`, `AdminChangeResponseSchema`, `AdminChangesResponseSchema`,
  `AdminChangeInput` (Task 1); `adminResponseBody` (admin/http.ts); `parseSince` (admin/turns.ts);
  `processPrompter` (init/prompts.ts); `CLI_VERSION` (version.ts).
- Produces:
  - `export async function runCliChange(input: { controlPlaneUrl: string; accessToken: string; change: AdminChangeInput; cliVersion: string; confirm(effect: string): Promise<boolean>; write(line: string): void; newId?(): string }, fetchImplementation?: typeof fetch): Promise<{ outcome: "applied" | "declined"; change: AdminChangeView }>`;
  - `export async function exportChanges(input: { controlPlaneUrl: string; accessToken: string; since: string; write(line: string): void | Promise<void>; json: boolean }, fetchImplementation?: typeof fetch): Promise<{ exported: number; since: string }>`;
  - commands `agentx admin changes --since <duration>` (JSON Lines with `--json`),
    `agentx admin project grant --project <name> --developer <ref> [--yes]`,
    `agentx admin project revoke --project <name> --developer <ref> [--yes]`;
  - `CliDependencies.confirm?(question: string): Promise<boolean>` (tests answer the prompt).

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/admin-changes-cli.test.ts
// Spec 025 FR-052, E17: the CLI exports change records, and grants or revokes project access
// through the change path: it shows the effect, asks, and applies with the cli method.
import { describe, expect, it, vi } from "vitest";
import { exportChanges, runCliChange } from "../../packages/cli/src/admin/changes.js";

const URL = "https://abc123.execute-api.us-east-1.amazonaws.com";
const CHANGE = "55555555-5555-4555-8555-555555555555";
const view = (status: string) => ({ changeId: CHANGE, kind: "grant_project_access", status, effect: "Grant Slack user U0NEW00001 (not signed in to AgentX yet; the grant applies when they sign in with Slack) access to project payments.", methodsOffered: ["cli"], createdAt: "2026-10-02T09:00:00.000Z", expiresAt: "2026-10-02T09:10:00.000Z", ...(status === "applied" ? { methodUsed: "cli" } : {}) });

function control(answers: Record<string, unknown>) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new globalThis.URL(String(input));
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    calls.push({ method: init?.method ?? "GET", path: `${url.pathname}${url.search}`, ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) as unknown }) });
    return Response.json(answers[key] ?? { error: { code: "NOT_FOUND", message: "route not found" } }, { status: answers[key] === undefined ? 404 : 200 });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

describe("runCliChange (E17, Q6)", () => {
  it("proposes with the cli method, prints the effect, asks, and applies", async () => {
    const { fetch, calls } = control({ "POST /v1/admin/changes": { change: view("pending") }, [`POST /v1/admin/changes/${CHANGE}/apply`]: { change: view("applied") } });
    const lines: string[] = [];
    const confirm = vi.fn(async () => true);
    const result = await runCliChange({ controlPlaneUrl: URL, accessToken: "admin-token", change: { kind: "grant_project_access", project: "payments", developer: "U0NEW00001" }, cliVersion: "0.0.7", confirm, write: (line) => lines.push(line) }, fetch);
    expect(result.outcome).toBe("applied");
    expect(calls[0]).toMatchObject({ method: "POST", path: "/v1/admin/changes", body: { change: { kind: "grant_project_access", project: "payments", developer: "U0NEW00001" }, client: { cliVersion: "0.0.7" }, methods: ["cli"] } });
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Grant Slack user U0NEW00001"));
    expect(calls[1]).toMatchObject({ method: "POST", path: `/v1/admin/changes/${CHANGE}/apply`, body: { method: "cli" } });
    expect(lines.join("\n")).toContain("Applied.");
  });

  it("declines on no, and applies nothing", async () => {
    const { fetch, calls } = control({ "POST /v1/admin/changes": { change: view("pending") }, [`POST /v1/admin/changes/${CHANGE}/decline`]: { change: view("declined") } });
    const result = await runCliChange({ controlPlaneUrl: URL, accessToken: "admin-token", change: { kind: "revoke_project_access", project: "payments", developer: "U0NEW00001" }, cliVersion: "0.0.7", confirm: async () => false, write: () => undefined }, fetch);
    expect(result.outcome).toBe("declined");
    expect(calls.map((call) => call.path)).toEqual(["/v1/admin/changes", `/v1/admin/changes/${CHANGE}/decline`]);
    expect(calls[1]?.body).toEqual({ method: "cli", reason: "declined", answeredAt: expect.any(String) as unknown });
  });

  it("keeps AgentX's own refusal code", async () => {
    const fetch = vi.fn(async () => Response.json({ error: { code: "NOT_FOUND", message: "nobody has signed in to AgentX with new@example.com yet; name them by Slack user ID, or ask them to sign in first" } }, { status: 404 })) as unknown as typeof globalThis.fetch;
    await expect(runCliChange({ controlPlaneUrl: URL, accessToken: "t", change: { kind: "grant_project_access", project: "payments", developer: "new@example.com" }, cliVersion: "0.0.7", confirm: async () => true, write: () => undefined }, fetch)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("exportChanges (FR-052)", () => {
  it("follows the cursor and writes one line per record, as JSON Lines with --json", async () => {
    const record = { changeId: CHANGE, kind: "bind_channel", traceId: "t", status: "applied", outcome: "confirmed", admin: { issuer: "i", subject: "admin-subject", displayName: "Ada" }, client: { cliVersion: "0.0.7" }, change: {}, effect: "Bind.", methodsOffered: ["cli"], proposedAt: "2026-10-02T09:00:00.000Z" };
    let page = 0;
    const fetch = vi.fn(async () => { page += 1; return Response.json(page === 1 ? { changes: [record], cursor: "next" } : { changes: [{ ...record, changeId: "66666666-6666-4666-8666-666666666666" }] }); }) as unknown as typeof globalThis.fetch;
    const json: string[] = [];
    expect(await exportChanges({ controlPlaneUrl: URL, accessToken: "t", since: "2026-10-01T00:00:00.000Z", write: (line) => { json.push(line); }, json: true }, fetch)).toEqual({ exported: 2, since: "2026-10-01T00:00:00.000Z" });
    expect(JSON.parse(json[0]!)).toMatchObject({ changeId: CHANGE });
    page = 0;
    const text: string[] = [];
    await exportChanges({ controlPlaneUrl: URL, accessToken: "t", since: "2026-10-01T00:00:00.000Z", write: (line) => { text.push(line); }, json: false }, fetch);
    expect(text[0]).toBe(`2026-10-02T09:00:00.000Z  confirmed  bind_channel  Ada  ${CHANGE}\n`);
  });
});
```

Add, in the same file, the commands' own checks, which run before any sign-in or network call
(as `admin-task-share-mode.test.ts` does for `admin task share-mode`):

```ts
import { executeCli } from "../../packages/cli/src/main.js";

describe("the commands (E17)", () => {
  it("need --project and --developer, and a valid --since, before calling AgentX", async () => {
    const fetch = vi.fn();
    let stderr = "";
    const io = { fetchImplementation: fetch as unknown as typeof globalThis.fetch, stdout: { write: () => true }, stderr: { write: (text: string) => { stderr += text; return true; } } };
    expect(await executeCli(["admin", "project", "grant", "--developer", "U0NEW00001"], io)).not.toBe(0);
    expect(stderr).toContain("--project");
    expect(await executeCli(["admin", "project", "revoke", "--project", "payments"], io)).not.toBe(0);
    expect(stderr).toContain("--developer");
    expect(await executeCli(["admin", "changes", "--since", "45d"], io)).not.toBe(0);
    expect(stderr).toContain("--since must be more than zero and at most 30d");
    expect(fetch).not.toHaveBeenCalled();
  });
});
```

The full flows (sign-in, change, confirm, apply) are `runCliChange`'s tests above and Task 17's.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/contract/admin-changes-cli.test.ts`
Expected: FAIL: `admin/changes.js` does not exist.

- [ ] **Step 3: Write the CLI module**

```ts
// packages/cli/src/admin/changes.ts
// Spec 025 FR-052, E17 (Q6): the CLI's side of the admin change path. A person typing an agentx
// command is the confirmation (D12), recorded as the cli method; nothing applies before they say yes.
import { randomUUID } from "node:crypto";
import { AdminChangeResponseSchema, AdminChangesResponseSchema, agentXError, type AdminChangeInput, type AdminChangeView } from "@agentx/contracts";
import { adminResponseBody } from "./http.js";

const base = (url: string) => url.replace(/\/$/, "");
async function send(input: { controlPlaneUrl: string; accessToken: string }, method: "GET" | "POST", path: string, body: unknown, fetchImplementation: typeof fetch): Promise<unknown> {
  const response = await fetchImplementation(`${base(input.controlPlaneUrl)}${path}`, {
    method,
    headers: { authorization: `Bearer ${input.accessToken}`, "x-agentx-trace-id": randomUUID(), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return adminResponseBody(response);
}
const change = (value: unknown): AdminChangeView => {
  const parsed = AdminChangeResponseSchema.safeParse(value);
  if (!parsed.success) throw agentXError("RUNTIME_UNAVAILABLE", "control plane returned an invalid change");
  return parsed.data.change;
};

export async function runCliChange(input: { controlPlaneUrl: string; accessToken: string; change: AdminChangeInput; cliVersion: string; confirm(effect: string): Promise<boolean>; write(line: string): void; newId?(): string }, fetchImplementation: typeof fetch = fetch): Promise<{ outcome: "applied" | "declined"; change: AdminChangeView }> {
  const planned = change(await send(input, "POST", "/v1/admin/changes", { requestId: (input.newId ?? randomUUID)(), change: input.change, client: { cliVersion: input.cliVersion }, methods: ["cli"] }, fetchImplementation));
  input.write(planned.effect);
  const requestedAt = new Date().toISOString();
  const yes = await input.confirm(planned.effect);
  const answeredAt = new Date().toISOString();
  if (!yes) {
    const declined = change(await send(input, "POST", `/v1/admin/changes/${planned.changeId}/decline`, { method: "cli", reason: "declined", answeredAt }, fetchImplementation));
    input.write("Nothing changed.");
    return { outcome: "declined", change: declined };
  }
  const applied = change(await send(input, "POST", `/v1/admin/changes/${planned.changeId}/apply`, { method: "cli", requestedAt, answeredAt }, fetchImplementation));
  input.write(applied.status === "applied" ? "Applied." : `Not applied: ${applied.error?.message ?? applied.status}.`);
  return { outcome: applied.status === "applied" ? "applied" : "declined", change: applied };
}

export async function exportChanges(input: { controlPlaneUrl: string; accessToken: string; since: string; write(line: string): void | Promise<void>; json: boolean }, fetchImplementation: typeof fetch = fetch): Promise<{ exported: number; since: string }> {
  let cursor: string | undefined;
  let exported = 0;
  const seen = new Set<string>();
  do {
    const query = new URLSearchParams({ since: input.since, limit: "100", ...(cursor === undefined ? {} : { cursor }) });
    const page = AdminChangesResponseSchema.safeParse(await send(input, "GET", `/v1/admin/changes?${query.toString()}`, undefined, fetchImplementation));
    if (!page.success) throw agentXError("RUNTIME_UNAVAILABLE", "control plane returned an invalid change page");
    for (const record of page.data.changes) {
      await input.write(input.json ? `${JSON.stringify(record)}\n` : `${record.proposedAt}  ${record.outcome ?? record.status}  ${record.kind}  ${record.admin.displayName ?? record.admin.subject}  ${record.changeId}\n`);
      exported += 1;
    }
    cursor = page.data.cursor;
    if (cursor !== undefined) {
      if (seen.has(cursor)) throw agentXError("RUNTIME_UNAVAILABLE", "control plane repeated a change page cursor; export stopped");
      seen.add(cursor);
    }
  } while (cursor !== undefined);
  return { exported, since: input.since };
}
```

- [ ] **Step 4: The commands**

In `packages/cli/src/main.ts`:
- add `confirm?(question: string): Promise<boolean>` to `CliDependencies`, and
  `const confirmPrompt = (yes: boolean) => async (question: string) => yes || (await (dependencies.confirm ?? ((text: string) => (process.stdin.isTTY === true ? processPrompter(services.stderr).confirm(text, { defaultValue: false }) : Promise.reject(agentXError("CONFIG_INVALID", "this change needs a yes; run it in a terminal, or pass --yes")))))(question));`;
- under `adminProject`, add both commands:

```ts
  for (const action of ["grant", "revoke"] as const) {
    adminProject
      .command(action)
      .description(action === "grant" ? "let a developer hand tasks to this project from an AI tool: shows the change and asks first" : "remove a developer's granted access to a project: shows the change and asks first")
      .requiredOption("--project <name>", "the project's name")
      .requiredOption("--developer <who>", "a Slack user ID such as U0123456789, the email they signed in with, or a developer ID")
      .option("--yes", "apply without asking; the change is still printed", false)
      .action(async (options: { project: string; developer: string; yes: boolean }, command: Command) => {
        const globals = globalOptions(command);
        const { settings, accessToken } = await authenticate(globals, services.tokenStore);
        const result = await runCliChange({
          controlPlaneUrl: settings.controlPlaneUrl, accessToken, cliVersion: CLI_VERSION,
          change: { kind: action === "grant" ? "grant_project_access" : "revoke_project_access", project: AgentXNameSchema.parse(options.project), developer: options.developer },
          confirm: (effect) => confirmPrompt(options.yes)(`${effect}\nApply this change?`),
          write: (line) => { services.stderr.write(`${line}\n`); },
        }, services.fetchImplementation);
        services.stdout.write(formatSuccess({ outcome: result.outcome, changeId: result.change.changeId }, globals.json));
      });
  }
```

- beside `adminTurns`:

```ts
  admin
    .command("changes")
    .description("list admin change records (kept 30 days): who asked, the change, how it was confirmed and how it ended; --json writes JSON Lines")
    .requiredOption("--since <duration>", "how far back, such as 30m, 12h or 7d (at most 30d)")
    .action(async (options: { since: string }, command: Command) => {
      const globals = globalOptions(command);
      const since = parseSince(options.since);
      const { settings, accessToken } = await authenticate(globals, services.tokenStore);
      const result = await exportChanges({ controlPlaneUrl: settings.controlPlaneUrl, accessToken, since, json: globals.json, write: (line) => { services.stdout.write(line); } }, services.fetchImplementation);
      services.stderr.write(`${result.exported} change record${result.exported === 1 ? "" : "s"} since ${result.since}\n`);
    });
```

`authenticate` is today's admin sign-in check ("run agentx login" when absent), exactly as every
`agentx admin` command uses it.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/contract/admin-changes-cli.test.ts tests/contract/slack-admin-cli.test.ts tests/contract/turns-cli.test.ts && npm run typecheck`
Expected: PASS; existing `agentx admin` command tests are unchanged (FR-042).

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/admin/changes.ts packages/cli/src/main.ts tests/contract/admin-changes-cli.test.ts
git commit -m "feat(cli): agentx admin changes, and admin project grant and revoke through the change path (spec 025 phase 25e)"
```

---

### Task 15: `agentx config set limits.*` through the change path

FR-053 and spec 015 FR-048: the owner's requirement that `agentx config set
limits.workspacesPerMember` and `limits.workspacesPerOrg` work after 25e, lifted from their "until
25e" refusal and routed through the same change path, with its confirmation and audit (E17,
E19). **Depends on Q6.**

**Files:**
- Modify: `packages/cli/src/config/commands.ts`
- Modify: `packages/cli/src/config/cli.ts` (`adminSession` in the context)
- Modify: `packages/cli/src/main.ts` (pass the admin session for an environment)
- Test: `tests/contract/config-limits-change.test.ts`
- Modify (deliberate change): `tests/contract/config-commands.test.ts`

**Interfaces:**
- Consumes: `runCliChange` (Task 14); `ConfigServices` (config/commands.ts).
- Produces: `ConfigServices.adminSession?(env: string): Promise<{ controlPlaneUrl: string; accessToken: string } | undefined>`
  and `ConfigServices.fetch?: typeof fetch`; `ConfigCommandContext.adminSession?` (same type).

- [ ] **Step 1: Replace the pinned refusal (deliberate, named)**

`tests/contract/config-commands.test.ts`'s test "refuses the workspace limits until the control
plane's change tool exists (question 4)" asserted
`.rejects.toThrow("limits.workspacesPerMember is the control plane's workspace limits setting; AgentX changes it with the admin change tool from spec 025 phase 25e, which this release does not have yet")`.
Phase 25e is that release, and the owner requires the key to work, so the test is replaced, not
loosened, by one that pins the new refusal when no admin sign-in is held:

```ts
  it("needs the admin sign-in for the workspace limits, which change through the admin change path (spec 025 phase 25e)", async () => {
    await expect(runConfigSet(services({ store: await seeded(), adminSession: async () => undefined }), ENV, { key: "limits.workspacesPerMember", value: "5", yes: true }))
      .rejects.toThrow(`limits.workspacesPerMember changes through AgentX's admin change path, which needs this computer's admin sign-in; run agentx --env ${ENV} login --admin, then try again`);
  });
```

- [ ] **Step 2: Write the failing test**

```ts
// tests/contract/config-limits-change.test.ts
// Spec 025 FR-053, E17, E19: agentx config set limits.* plans the change, shows it, asks, and applies
// it through the admin change path with the cli method; the broker's next creation uses it.
import { describe, expect, it } from "vitest";
import { runConfigSet, type ConfigServices } from "../../packages/cli/src/config/commands.js";
import { createAdminChangeBroker } from "../support/admin-change-broker.js";
import { SLACK_CHANNEL, SLACK_TEAM, ensureWorkspace } from "../support/slack-broker.js";
import { configServicesFor } from "../support/config-services.js";

/** The CLI's fetch, into the broker in process, with the admin sign-in's claims (API Gateway's JWT authorizer). */
function brokerFetch(harness: Awaited<ReturnType<typeof createAdminChangeBroker>>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const answer = await harness.admin(init?.method ?? "GET", `${url.pathname}${url.search}`, { ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as unknown } : {}) });
    return Response.json(answer.body, { status: answer.status });
  }) as unknown as typeof fetch;
}

describe("agentx config set limits.* (FR-053, owner requirement)", () => {
  it("shows who is over the new limit, asks, and the next creation uses it", async () => {
    const harness = await createAdminChangeBroker();
    for (const ts of ["1695500000.000401", "1695500000.000402", "1695500000.000403"]) await ensureWorkspace(harness.handler, `${SLACK_TEAM}/${SLACK_CHANNEL}/${ts}`, "U0PRIYA001");
    const asked: string[] = [];
    const services: ConfigServices = await configServicesFor({
      adminSession: async () => ({ controlPlaneUrl: "https://abc123.execute-api.us-east-1.amazonaws.com", accessToken: "admin-token-for-tests" }),
      fetch: brokerFetch(harness),
      prompter: { confirm: async (question: string) => { asked.push(question); return true; } } as never,
    });
    expect(await runConfigSet(services, "staging", { key: "limits.workspacesPerMember", value: "2", yes: false })).toEqual({ changed: true });
    expect(asked[0]).toContain("At or over 2 per person: Slack member U0PRIYA001 (3 open).");
    expect(harness.db.get("SETTINGS", "WORKSPACE_LIMITS")).toMatchObject({ perPerson: 2, perOrganization: 20 });
    const audit = harness.db.find((item) => item.entityType === "ADMIN_CHANGE_AUDIT")[0];
    expect(audit).toMatchObject({ kind: "set_workspace_limits", methodUsed: "cli", outcome: "confirmed" });
    // Existing workspaces keep running; the next one for this member is refused, another member's is not.
    expect((await ensureWorkspace(harness.handler, `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000404`, "U0PRIYA001")).body).toMatchObject({ outcome: "LIMIT_REACHED", limit: "MEMBER", maximum: 2 });
    expect((await ensureWorkspace(harness.handler, `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000405`, "U0OMAR0001")).body).toMatchObject({ outcome: "WORKSPACE", created: true });
  });

  it("changes nothing on no, and the audit says declined", async () => {
    const harness = await createAdminChangeBroker();
    const services = await configServicesFor({
      adminSession: async () => ({ controlPlaneUrl: "https://abc123.execute-api.us-east-1.amazonaws.com", accessToken: "admin-token-for-tests" }),
      fetch: brokerFetch(harness),
      prompter: { confirm: async () => false } as never,
    });
    expect(await runConfigSet(services, "staging", { key: "limits.workspacesPerOrg", value: "40", yes: false })).toEqual({ changed: false });
    expect(harness.db.get("SETTINGS", "WORKSPACE_LIMITS")).toBeUndefined();
    expect(harness.db.find((item) => item.entityType === "ADMIN_CHANGE_AUDIT")[0]).toMatchObject({ outcome: "declined", methodUsed: "cli" });
  });
});
```

`configServicesFor(overrides)` is the `services()` factory of `tests/contract/config-commands.test.ts`
moved into `tests/support/config-services.ts` (a move, not a copy; `config-commands.test.ts`
imports it from there), with `store` seeded as that file's `seeded()` does, and `configServicesFor`
awaiting that seeding. `ensureWorkspace` (`tests/support/slack-broker.ts`) answers the thread
workspace result itself as its body (`outcome`, `limit`, `maximum`, `created`).

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run tests/contract/config-limits-change.test.ts tests/contract/config-commands.test.ts`
Expected: FAIL: the key is still refused with the "until 25e" words.

- [ ] **Step 4: Route the limits through the change path**

In `packages/cli/src/config/commands.ts`:
- add `adminSession?(env: string): Promise<{ controlPlaneUrl: string; accessToken: string } | undefined>`
  and `fetch?: typeof fetch` to `ConfigServices`;
- replace the `LIMITS_REFUSAL` throw in `runConfigSet` with
  `if (target.kind === "control-plane-setting") return setLimitsThroughChange(services, env, entry, input);`
  and remove the now unused `LIMITS_REFUSAL`;
- add:

```ts
/** Spec 025 FR-053, E17: the workspace limits change through the admin change path, with its audit. */
async function setLimitsThroughChange(services: ConfigServices, env: string, entry: ConfigKey, input: { value?: string; yes: boolean }): Promise<{ changed: boolean }> {
  if (input.value === undefined) throw agentXError("CONFIG_INVALID", `give the new value: agentx config set ${entry.key} <value>`);
  const value = Number(entry.parse(input.value));
  const session = await services.adminSession?.(env);
  if (session === undefined) throw agentXError("AUTH_REQUIRED", `${entry.key} changes through AgentX's admin change path, which needs this computer's admin sign-in; run agentx --env ${env} login --admin, then try again`);
  const field = (entry.target as { field: "perPerson" | "perOrganization" }).field;
  const result = await runCliChange({
    controlPlaneUrl: session.controlPlaneUrl, accessToken: session.accessToken, cliVersion: CLI_VERSION,
    change: { kind: "set_workspace_limits", [field]: value },
    confirm: async (effect) => input.yes || services.prompter.confirm(`${effect}\nApply this change?`, { defaultValue: false }),
    write: services.write,
  }, services.fetch ?? fetch);
  return { changed: result.outcome === "applied" };
}
```

  importing `runCliChange` from `../admin/changes.js` and `CLI_VERSION` from `../version.js`.

In `packages/cli/src/config/cli.ts`, add `adminSession?` to `ConfigCommandContext` and pass
`...(context.adminSession === undefined ? {} : { adminSession: context.adminSession })` and
`fetch: context.fetch` into the services. In `main.ts`, pass to `registerConfigCommands`:

```ts
    adminSession: async (env: string) => {
      try {
        const settings = await deploymentSettings({ ...globalOptions(program), env });
        const tokens = await services.tokenStore.get(tokenStoreKey(settings.auth));
        return tokens !== undefined && tokens.expiresAt > Date.now() ? { controlPlaneUrl: settings.controlPlaneUrl, accessToken: tokens.accessToken } : undefined;
      } catch {
        return undefined;
      }
    },
```

`config list` and `config get` keep showing the install default with its note (unchanged).

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/contract/config-limits-change.test.ts tests/contract/config-commands.test.ts tests/contract/config-keys.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/config packages/cli/src/main.ts tests/support/config-services.ts tests/contract/config-limits-change.test.ts tests/contract/config-commands.test.ts
git commit -m "feat(cli): agentx config set limits.* through the admin change path, with its confirmation and audit (spec 025 phase 25e)"
```

---

### Task 16: A close's outcome is audited (25c's C22)

E20, FR-037's "each task or publish operation MUST write a completed record": the close is the one
developer action whose outcome had no record.

**Files:**
- Modify: `packages/broker/src/aws/developer-tasks.ts` (`finishTaskClose`)
- Modify: `packages/broker/src/aws/broker.ts` (`completedTurnItems`: a refused close)
- Test: `tests/contract/developer-task-close-audit.test.ts`

**Interfaces:**
- Consumes: `aiToolTurn`, `partyOfTask` (task-records.ts); `WorkspaceClosePreflightResultSchema`
  (contracts); 25b's close path.
- Produces: a `completed` AI-tool turn record with `action: "close"`: outcome `succeeded` in the
  close's own transaction, or `refused` with the unpublished repositories in the close
  preflight's result transaction.

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/developer-task-close-audit.test.ts
// Spec 025 E20 (25c's C22): a close's outcome gets its completed audit record.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MAYA, createDeveloperTaskBroker } from "../support/developer-task-broker.js";

async function readyTask() {
  const harness = await createDeveloperTaskBroker();
  const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix it", client: "claude-code" });
  const taskId = (started.body.task as { taskId: string }).taskId;
  const task = harness.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string };
  const active = () => String((harness.db.get(`WORKSPACE#${task.workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
  return { ...harness, taskId, workspaceId: task.workspaceId, active };
}
const closeRecords = (db: { find(predicate: (item: Record<string, unknown>) => boolean): Array<Record<string, unknown>> }, taskId: string) =>
  db.find((item) => item.pk === `TASK#${taskId}` && item.action === "close");

describe("a close's completed record (E20)", () => {
  it("records a close that completes, in the close's own transaction", async () => {
    const { db, dev, finish, taskId, workspaceId } = await readyTask();
    const prepareId = String((db.get(`WORKSPACE#${workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
    await finish(workspaceId, prepareId, "FAILED", { error: "npm ci exited 1" });
    expect((await dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/close`, { requestId: randomUUID() })).body).toMatchObject({ closed: true });
    expect(closeRecords(db, taskId).map((record) => [record.phase, record.outcome])).toEqual(expect.arrayContaining([["accepted", "accepted"], ["completed", "succeeded"]]));
  });

  it("records a close refused for unpublished work, naming the repositories", async () => {
    const { db, dev, finish, taskId, workspaceId, active } = await readyTask();
    // As 25b's close tests: the prepare, then the first task, end; then the close's preflight runs.
    await finish(workspaceId, active(), "SUCCEEDED");
    await finish(workspaceId, active(), "SUCCEEDED");
    await dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/close`, { requestId: randomUUID() });
    await finish(workspaceId, active(), "SUCCEEDED", { result: { safeToClose: false, repositories: [{ name: "demo", reasons: ["worktree_changes"] }] } });
    const completed = closeRecords(db, taskId).find((record) => record.phase === "completed");
    expect(completed).toMatchObject({ outcome: "refused", responseText: "Not closed: unpublished work in demo (worktree_changes)" });
  });

  it("records a close that completes after its preflight", async () => {
    const { db, dev, finish, taskId, workspaceId, active } = await readyTask();
    await finish(workspaceId, active(), "SUCCEEDED");
    await finish(workspaceId, active(), "SUCCEEDED");
    await dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/close`, { requestId: randomUUID() });
    await finish(workspaceId, active(), "SUCCEEDED", { result: { safeToClose: true, repositories: [] } });
    expect(closeRecords(db, taskId).filter((record) => record.phase === "completed")).toEqual([expect.objectContaining({ outcome: "succeeded" })]);
  });
});
```

The results' shapes are those of 25b's close tests (`tests/contract/developer-task-close.test.ts`):
a prepare and a first task that end `SUCCEEDED`, then the close preflight's
`{ safeToClose, repositories: [{ name, reasons }] }` with a reason `WorkspaceCloseReasonSchema`
allows (`worktree_changes`).

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/contract/developer-task-close-audit.test.ts`
Expected: FAIL: only the `accepted` close record exists.

- [ ] **Step 3: Write the two records**

In `finishTaskClose` (developer-tasks.ts), add to `closing(current)`'s items, when
`deps.actions.turnRecordsTableName` is set:

```ts
    // E20 (25c C22): the close's own completed record, in the close's transaction, so it commits once.
    ...(deps.actions.turnRecordsTableName === undefined ? [] : [{ Put: {
      TableName: deps.actions.turnRecordsTableName,
      Item: aiToolTurn({
        party: partyOfTask(current), turnId: closeOperationId ?? randomUUID(), action: "close", phase: "completed", outcome: "succeeded",
        receivedAt: now, finishedAt: now, request: "close", response: "The task is closed, and its workspace is released.",
        ...(closeOperationId === undefined ? {} : { operationId: closeOperationId }),
      }),
      ConditionExpression: "attribute_not_exists(pk)",
    } }]),
```

In `completedTurnItems` (broker.ts), before `if (ended === undefined) return [];`, add a branch
for a close that did not close:

```ts
  if (operation.kind === "close" && terminalStatus === "SUCCEEDED") {
    const preflight = WorkspaceClosePreflightResultSchema.safeParse(outcome.result);
    const requester = operation.requestedBy;
    if (preflight.success && !preflight.data.safeToClose && requester !== undefined && "kind" in requester && requester.kind === "developer") {
      const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(pointer.taskId));
      if (task === undefined) return [];
      const listed = preflight.data.repositories.map((repository) => `${repository.name} (${repository.reasons.join(", ")})`).join("; ");
      return [{ Put: { TableName: table, Item: aiToolTurn({
        party: partyOfTask(task), turnId: operation.id, operationId: operation.id, action: "close", phase: "completed", outcome: "refused",
        receivedAt: operation.createdAt, finishedAt: now, request: "close", response: `Not closed: unpublished work in ${listed}`,
      }), ConditionExpression: "attribute_not_exists(pk)" } }];
    }
  }
```

(import `aiToolTurn` and `partyOfTask` from `../developer/task-records.js`, and `randomUUID` in
developer-tasks.ts). A close preflight that is safe finishes the close in `finishTaskClose`, which
writes the `succeeded` record there; this branch covers only the refusal.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/contract/developer-task-close-audit.test.ts tests/contract/developer-task-close.test.ts tests/contract/developer-task-records.test.ts`
Expected: PASS. 25b's close tests counted the close's records as `accepted` only in places that
filter by phase; if one asserts the exact list of a task's records, it gains the `completed` entry
by appending (SC-008), and the task says so in its commit message.

- [ ] **Step 5: Commit**

```bash
git add packages/broker/src/aws/developer-tasks.ts packages/broker/src/aws/broker.ts tests/contract/developer-task-close-audit.test.ts
git commit -m "feat(broker): a close's completed audit record, succeeded or refused (spec 025 phase 25e, 25c C22)"
```

---
### Task 17: Admin changes end to end: SC-005, SC-011 and SC-013

User Story 6's Independent Test: the MCP SDK's client, with and without elicitation, drives `agentx
mcp`'s server against the broker in process. Every change tool is tried with a declined
confirmation and must leave AgentX's state as it was (SC-005); each outcome has a complete audit
record whose trace ID is in every step's log line (SC-011); a limits change takes effect at the
next creation with no stack update (SC-013).

**Files:**
- Modify: `tests/support/mcp-broker-client.ts` (`mcpBrokerFetch`'s configuration; `adminSignedInClient`'s
  elicitation, clock and `onSleep`)
- Test: `tests/contract/mcp-admin-change-flow.test.ts`

**Interfaces:**
- Consumes: everything above; `createAdminChangeBroker` (Task 7); 25d's `adminSignedInClient`.
- Produces: `mcpBrokerFetch(harness, options?: { adminApiVersion?: string; confirm?: { elicitation: boolean; slack: boolean } })`
  (defaults as in 25d: `"1.0"`, no `confirm`); `adminSignedInClient(harness, { ..., elicitation?: "accept" | "decline" | false, clock?: { now(): number; advance(ms: number): void }, onSleep?: () => Promise<void>, config?: Parameters<typeof mcpBrokerFetch>[1] })`.

- [ ] **Step 1: Extend the support**

In `tests/support/mcp-broker-client.ts`: `mcpBrokerFetch`'s configuration answer takes the
options (`adminApiVersion`, and `confirm` when given); `adminSignedInClient` builds its `Client`
with `capabilities: { elicitation: { form: {} } }` unless `elicitation` is `false`, answers
`elicitation/create` with `{ action: "accept", content: { confirm: true } }` or
`{ action: "decline" }`, and passes the MCP server a clock whose `now` is `options.clock.now`
and whose `sleep(ms)` calls `options.clock.advance(ms)` and then `await options.onSleep?.()`.

- [ ] **Step 2: Write the test**

```ts
// tests/contract/mcp-admin-change-flow.test.ts
// Spec 025 User Story 6, SC-005, SC-011, SC-013, end to end: agentx mcp's server, the broker in
// process, an admin sign-in, a client with or without elicitation, and the Slack press.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ADMIN_SLACK, createAdminChangeBroker } from "../support/admin-change-broker.js";
import { MAYA, OMAR, grantProject } from "../support/developer-task-broker.js";
import { adminSignedInClient } from "../support/mcp-broker-client.js";
import { SLACK_CHANNEL, SLACK_TEAM, ensureWorkspace } from "../support/slack-broker.js";

const CONFIG = { adminApiVersion: "1.1", confirm: { elicitation: true, slack: true } };
const PLANTED = `ghp_${"E".repeat(36)}`;
let lines: string[] = [];
beforeEach(() => { lines = []; vi.spyOn(console, "log").mockImplementation((line: string) => { lines.push(String(line)); }); });
afterEach(() => vi.restoreAllMocks());
const logs = () => lines.flatMap((line) => { try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; } });
/** Everything but the change path's own records: what a declined change must leave unchanged. */
const stateOf = (db: { items: Map<string, Record<string, unknown>> }) => JSON.stringify([...db.items.entries()]
  .filter(([, item]) => !["ADMIN_CHANGE", "ADMIN_CHANGE_REQUEST", "ADMIN_CHANGE_AUDIT"].includes(String(item.entityType)))
  .sort(([left], [right]) => left.localeCompare(right)));

describe("an admin changes AgentX from an AI tool (US6)", () => {
  it("binds a channel after the pop-up's yes, and the record says who, how, when and with which trace ID (SC-011)", async () => {
    const broker = await createAdminChangeBroker();
    const mcp = await adminSignedInClient(broker, { elicitation: "accept", clock: broker.clock, config: CONFIG });
    await expect.poll(async () => (await mcp.names()).includes("agentx_admin_bind_channel")).toBe(true);
    const bound = await mcp.tool("agentx_admin_bind_channel", { channel: "#ledger-dev", project: "payments" });
    expect(bound.value).toMatchObject({ outcome: "applied", method: "elicitation" });
    expect(broker.db.get(`SLACK_BINDING#${SLACK_TEAM}`, "CHANNEL#C0LEDGER01")).toMatchObject({ projectName: "payments" });
    const record = ((await mcp.tool("agentx_admin_changes")).value.changes as Array<Record<string, unknown>>)[0]!;
    expect(record).toMatchObject({
      change_id: bound.value.change_id, outcome: "confirmed", admin: "Ada", client: { cliVersion: expect.any(String) as unknown, mcpClientName: "claude-code", mcpClientVersion: "2.1.0" },
      methods_offered: ["elicitation", "slack"], method_used: "elicitation", proposed_at: expect.any(String) as unknown, confirmation_requested_at: expect.any(String) as unknown,
      answered_at: expect.any(String) as unknown, applied_at: expect.any(String) as unknown, result: expect.any(Object) as unknown,
    });
    const traced = logs().filter((entry) => entry.changeId === bound.value.change_id);
    expect(traced.map((entry) => entry.event)).toEqual(expect.arrayContaining(["admin_change.proposed", "admin_change.claimed", "admin_change.applied"]));
    for (const entry of traced) expect(entry.traceId, String(entry.event)).toBe(record.trace_id);
  });

  it("leaves AgentX's state as it was for every change tool the admin declines (SC-005)", async () => {
    const broker = await createAdminChangeBroker();
    grantProject(broker.db, OMAR);
    const started = await broker.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix it", client: "claude-code" });
    const task = broker.db.get(`DEVTASK#${(started.body.task as { taskId: string }).taskId}`, "META") as { workspaceId: string };
    await broker.finish(task.workspaceId, String((broker.db.get(`WORKSPACE#${task.workspaceId}`, "META") as { activeOperationId: string }).activeOperationId), "SUCCEEDED");
    const mcp = await adminSignedInClient(broker, { elicitation: "decline", clock: broker.clock, config: CONFIG });
    await expect.poll(async () => (await mcp.names()).includes("agentx_admin_set_workspace_limits")).toBe(true);
    const calls: Array<[string, Record<string, unknown>]> = [
      ["agentx_admin_register_project_revision", { definition: { name: "payments", revision: 2, repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }], setup: [], readiness: [], orchestratorInstructions: "Delegate work." } }],
      ["agentx_admin_bind_channel", { channel: "C0LEDGER01", project: "payments" }],
      ["agentx_admin_unbind_channel", { channel: SLACK_CHANNEL }],
      ["agentx_admin_register_credential", { ref: "linear", type: "static-secret", secret_name: "agentx/connectors/linear" }],
      ["agentx_admin_stop_workspace", { workspace_id: task.workspaceId }],
      ["agentx_admin_grant_project_access", { project: "payments", developer: "U0NEW00001" }],
      ["agentx_admin_revoke_project_access", { project: "payments", developer: OMAR.developerId }],
      ["agentx_admin_revoke_signin", { developer: MAYA.developerId }],
      ["agentx_admin_set_workspace_limits", { per_person: 5 }],
    ];
    for (const [name, args] of calls) {
      const before = stateOf(broker.db);
      const answer = await mcp.tool(name, args);
      expect(answer.error, name).toMatchObject({ code: "CONFIRMATION_DECLINED" });
      expect(stateOf(broker.db), name).toBe(before);
    }
    // FR-051: one record per request, each declined.
    expect(broker.db.find((item) => item.entityType === "ADMIN_CHANGE_AUDIT").map((item) => item.outcome)).toEqual(calls.map(() => "declined"));
  });

  it("confirms by the Slack button in a client without the pop-up, even after the wait, and never twice", async () => {
    const broker = await createAdminChangeBroker();
    let pressed = false;
    const mcp = await adminSignedInClient(broker, {
      elicitation: false, clock: broker.clock, config: CONFIG,
      onSleep: async () => {
        const waiting = broker.db.find((item) => item.entityType === "ADMIN_CHANGE" && item.slackRequestedAt !== undefined && item.status === "pending")[0];
        if (waiting !== undefined && !pressed) { pressed = true; await broker.press(String(waiting.changeId), "confirm"); }
      },
    });
    await expect.poll(async () => (await mcp.names()).includes("agentx_admin_unbind_channel")).toBe(true);
    const unbound = await mcp.tool("agentx_admin_unbind_channel", { channel: SLACK_CHANNEL });
    expect(unbound.value).toMatchObject({ outcome: "applied", method: "slack" });
    expect(broker.db.get(`SLACK_BINDING#${SLACK_TEAM}`, `CHANNEL#${SLACK_CHANNEL}`)).toBeUndefined();
    expect(await broker.press(String(unbound.value.change_id), "confirm")).toMatchObject({ outcome: "not_pending" });
    expect(broker.audit(String(unbound.value.change_id))).toMatchObject({ outcome: "confirmed", methodUsed: "slack", pressedBy: ADMIN_SLACK });
  });

  it("answers awaiting_confirmation after five minutes, and the record reads expired after ten", async () => {
    const broker = await createAdminChangeBroker();
    const mcp = await adminSignedInClient(broker, { elicitation: false, clock: broker.clock, config: CONFIG });
    await expect.poll(async () => (await mcp.names()).includes("agentx_admin_bind_channel")).toBe(true);
    const waiting = await mcp.tool("agentx_admin_bind_channel", { channel: "C0LEDGER01", project: "payments" });
    expect(waiting.value).toMatchObject({ outcome: "awaiting_confirmation" });
    broker.clock.advance(6 * 60_000);
    const record = ((await mcp.tool("agentx_admin_changes")).value.changes as Array<Record<string, unknown>>)[0];
    expect(record).toMatchObject({ change_id: waiting.value.change_id, outcome: "expired" });
    expect(broker.db.get(`SLACK_BINDING#${SLACK_TEAM}`, "CHANNEL#C0LEDGER01")).toBeUndefined();
  });

  it("offers no change tool, and refuses a direct call, when neither method is available (FR-041, US6 scenario 4)", async () => {
    const broker = await createAdminChangeBroker({ slackLinked: false });
    const mcp = await adminSignedInClient(broker, { elicitation: false, clock: broker.clock, config: CONFIG });
    await expect.poll(async () => (await mcp.names()).includes("agentx_admin_changes")).toBe(true);
    expect((await mcp.names()).filter((name) => name.startsWith("agentx_admin_") && !["agentx_admin_changes", "agentx_admin_health", "agentx_admin_failed_tasks", "agentx_admin_turns", "agentx_admin_usage", "agentx_admin_list_projects", "agentx_admin_list_channels", "agentx_admin_list_credentials", "agentx_admin_list_workspaces"].includes(name))).toEqual([]);
    expect((await mcp.tool("agentx_admin_bind_channel", { channel: "C0LEDGER01", project: "payments" })).error).toMatchObject({ code: "CONFIRMATION_UNAVAILABLE" });
  });

  it("changes the per-person limit with no stack update, and the next creation uses it (SC-013, US6 scenario 7)", async () => {
    const broker = await createAdminChangeBroker();
    const mcp = await adminSignedInClient(broker, { elicitation: "accept", clock: broker.clock, config: CONFIG });
    await expect.poll(async () => (await mcp.names()).includes("agentx_admin_set_workspace_limits")).toBe(true);
    expect((await mcp.tool("agentx_admin_set_workspace_limits", { per_person: 1 })).value).toMatchObject({ outcome: "applied" });
    expect((await ensureWorkspace(broker.handler, `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000501`, "U0PRIYA001")).body).toMatchObject({ outcome: "WORKSPACE" });
    expect((await ensureWorkspace(broker.handler, `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000502`, "U0PRIYA001")).body).toMatchObject({ outcome: "LIMIT_REACHED", maximum: 1 });
    // The harness has no CloudFormation client at all: nothing could have updated a stack.
  });

  it("keeps a planted secret out of the change records, the tool results and the logs (SC-004)", async () => {
    const broker = await createAdminChangeBroker();
    const mcp = await adminSignedInClient(broker, { elicitation: "decline", clock: broker.clock, config: CONFIG });
    await expect.poll(async () => (await mcp.names()).includes("agentx_admin_register_project_revision")).toBe(true);
    await mcp.tool("agentx_admin_register_project_revision", { definition: { name: "payments", revision: 2, repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }], setup: [], readiness: [], orchestratorInstructions: `Use ${PLANTED}.` } });
    await mcp.tool("agentx_admin_register_credential", { ref: "linear", type: "static-secret", secret_name: `agentx/connectors/${PLANTED}` });
    await mcp.tool("agentx_admin_changes");
    expect(JSON.stringify(broker.db.find((item) => item.entityType === "ADMIN_CHANGE_AUDIT"))).not.toContain(PLANTED);
    expect(mcp.answers.join("\n")).not.toContain(PLANTED);
    expect(lines.join("\n")).not.toContain(PLANTED);
  });
});
```

The first test's `methods_offered` is both methods: the client declared elicitation and the admin
is linked to a Slack user; the pop-up comes first (FR-041), so the Slack step never starts. The
credential tool refuses its planted input at planning (Task 5), and that refusal's audit record
holds the input redacted.

- [ ] **Step 3: Run it**

Run: `npx vitest run tests/contract/mcp-admin-change-flow.test.ts tests/contract/mcp-admin-flow.test.ts tests/contract/mcp-developer-flow.test.ts`
Expected: PASS. A failure here is a defect in the task that owns the code: fix it there, with its
own failing test first, never by loosening this file's expectations.

- [ ] **Step 4: Commit**

```bash
git add tests/support/mcp-broker-client.ts tests/contract/mcp-admin-change-flow.test.ts
git commit -m "test(spec-025): admin changes end to end: SC-005's declines, SC-011's traces, SC-013's limit"
```

---

### Task 18: Record the rulings and the owner's answers in the spec

This task changes no code. It writes this plan's rulings, and the owner's answers to
[phase-25e-questions.md](phase-25e-questions.md) as given (not as recommended, where the owner
chose otherwise), into the spec. If an answer differs from the recommendation this plan followed,
stop: the owning task changes first (with its test), then this task records it.

**Files:**
- Modify: `specs/025-mcp-server/spec.md`
- Modify: `specs/025-mcp-server/plans/README.md`

- [ ] **Step 1: Amend the spec**
  - FR-030, the change tools' table and notes: a revision keeps its project's runtime binding, and a
    first revision needs `agentx admin project register` (Q5); stopping a workspace cancels its
    running task, and its compute stops when idle (Q2); `agentx_admin_revoke_signin` ends every
    session and the person may sign in again (Q3); a developer is named by Slack user ID (before
    their first sign-in too), by an email they signed in with, or by developer ID (Q4); a channel is
    named by ID or by a public channel's name (Q8); `applied` and `awaiting_confirmation` are
    results, and declined, expired and stale changes are FR-049's errors naming the change ID (Q9).
  - FR-039: the pending change's keys, and the request ID's idempotency (E2).
  - FR-040: "applied at most once": re-plan and compare the hash, then one conditional claim, then
    the handler; a change stuck applying for over 2 minutes reads as failed; the honest window
    between the check and the handler's own write (E5).
  - FR-041: the Slack step is started by the MCP server (`POST /v1/admin/changes/<id>/slack`), the
    notifier's DM comes from the state table's stream (D23's filter, never a third reader), a press
    reaches the broker asynchronously through the ingress (E13, E14); `mcp.confirm.elicitation` is
    the stack parameter `McpConfirmElicitation`, changed with `agentx config set
    mcp.confirmElicitation` (Q1); a typed `agentx` command is the `cli` method (Q6).
  - FR-042: "Every existing `agentx admin` command keeps working unchanged. The new `agentx admin
    project grant|revoke` and `agentx config set limits.*` go through the change path with the
    `cli` method and its audit" (owner requirement, 2026-09-29).
  - FR-051: the audit record lives in the TurnRecords table under `CHANGE#<id>`, under its own
    export partition, with at most 20 refused attempts (E3). FR-015's line for changes not about one
    project (credentials, sign-ins, limits): the admin claim only (Q7).
  - FR-052: `agentx admin changes --since <duration> [--json]` (JSON Lines with `--json`).
  - FR-053: `agentx config set limits.*` changes the setting through the change path (owner
    requirement, E17, E19).
  - FR-037: "A close's outcome gets its `completed` record (outcome `succeeded`, or `refused` with
    the repositories), phase 25e" replaces "in phase 25e (C22)".
  - FR-048 / D28: `ADMIN_API_VERSION` moves to `1.1` (Q11).
  - Decisions: add **D32** (E5: at most once, and why not one transaction around the existing
    handlers), **D33** (E3: the audit record in the TurnRecords table, stepped forward only), **D34**
    (E13, E14: the Slack step, the notifier's DM, the asynchronous press), and **D35** (E17: the
    `cli` method), each one paragraph, marked with the owner's decision date.
- [ ] **Step 2: Update the phase README.** The 25d row starts "Merged as PR #<n>."; the 25e row
  says "Built, see PR #<n>." with the questions link beside its plan.
- [ ] **Step 3: Check the copy** with `grep -c "$(printf '\342\200\224')" specs/025-mcp-server/spec.md specs/025-mcp-server/plans/README.md` (prints 0 for each), then commit:

```bash
git add specs/025-mcp-server/spec.md specs/025-mcp-server/plans/README.md
git commit -m "docs(spec-025): record the phase 25e rulings and the owner's answers"
```

---

### Task 19: Live check in a throwaway environment (owner present)

This task changes no code unless it finds a defect. A defect is fixed with a failing test first, in
the task that owns the code, then reviewed. It tests the real flow: Claude Code's pop-up, the Slack
Confirm button in a real direct message, a decline, an expiry, a stale change, a limits change, the
CLI's change path, and reading every record back. It needs:
- the owner's explicit go-ahead;
- an admin AWS session for account 944937319445 (`aws login --profile agentx-admin`, driven from
  this session, the owner's preference; or CloudShell);
- **no other throwaway environment in the account** (the Elastic IP quota): confirm `live25d` and
  any other `live*` are torn down before Step 3;
- a Slack workspace with two test users (the admin, whose Slack email is the Cognito admin user's
  email, and a second person), a GitHub organization or account, and a test repository the owner
  names; never production's Slack app, GitHub App, stacks, secrets or `/agentx/production/*`;
- Claude Code on the owner's machine, and a second MCP client without elicitation support (Codex,
  or Claude Code with elicitation turned off, whichever the owner has).

It uses a new environment, `live25e`, in `us-east-1`.

- [ ] **Step 1: Prepare (read-only)**: build and pack the release (`--version 0.0.7`), read
  production's image digests read-only, and confirm nothing named `live25e` or `live*` exists, as
  25d's Step 1.
- [ ] **Step 2: Owner approval.** Tell the owner what it creates (the stacks with the new grants,
  filter and `McpConfirmElicitation` parameter; a GitHub App and a Slack app in their test org and
  workspace; a KMS key; the sign-in table; a Cognito admin user; EC2 instances and volumes while
  tasks run), what it costs while it exists (about $3 a day plus task time), and that Step 12
  tears it all down.
- [ ] **Step 3: Install**, as 25d's Step 3 (Cognito admin, Slack at `developer-signin`), register
  the test project, bind a test channel, invite the bot. Sign in as a developer, then `agentx
  --env live25e login --admin`; `claude mcp add` as 25d's Step 4. `/mcp` lists the eight read
  tools, `agentx_admin_changes` and the nine change tools (Claude Code declares elicitation).
- [ ] **Step 4: The pop-up (US6 scenarios 1 and 2).** "Bind #<second test channel> to <project>":
  Claude Code shows AgentX's pop-up with the exact effect (the channel, "bound to nothing today",
  the revision); accept. The channel is bound (`agentx admin` or Slack). "Now unbind it" and decline
  in the pop-up: nothing changes, and the tool says the change was declined.
- [ ] **Step 5: The Slack button (US6 scenario 3, D7).** In the second client (no elicitation),
  ask to bind the channel again: a direct message from AgentX arrives with the effect and Confirm
  and Cancel; wait past the tool's 5 minutes (it answers `awaiting_confirmation`), then press
  Confirm within the 10 minutes: the change applies, the message is edited to "Applied, confirmed
  by" the admin, and pressing again does nothing. Ask the second Slack user to press a forwarded
  copy if Slack allows it; either way `agentx_admin_changes` shows no apply by them.
- [ ] **Step 6: Expiry and staleness (US6 scenario 5).** Ask for a change in the second client
  and let 10 minutes pass: its record reads `expired`, the message's buttons do nothing but say
  it expired. Ask for "unbind #<channel>" in Claude Code, and before accepting, unbind it with
  `agentx --env live25e admin slack unbind` in a terminal; accept: `CHANGE_STALE`, nothing else
  changes.
- [ ] **Step 7: The workspace limits (US6 scenario 7, SC-013).** "Set the per-person workspace
  limit to 1": the pop-up names the people at or over it; accept; start two tasks as the developer
  from the first client: the second is refused `WORKSPACE_LIMIT`. Check that no CloudFormation
  stack update happened (`aws cloudformation describe-stack-events` for the control plane: none
  since install). Then, in a terminal, `agentx --env live25e config set limits.workspacesPerMember
  3`: it prints the effect, asks, applies on "y"; `agentx_admin_changes` shows it with `cli`.
- [ ] **Step 8: Grants and sign-ins (the owner's requirement).** `agentx --env live25e admin
  project grant --project <project> --developer <second user's Slack ID>`: the effect says they
  have not signed in yet; apply. The second user signs in with Slack and lists the project. Then
  `agentx_admin_revoke_signin` for them in Claude Code: their next tool call gets
  `SIGN_IN_REQUIRED`; they sign in again and it works.
- [ ] **Step 9: No method (US6 scenario 4).** `agentx --env live25e config set
  mcp.confirmElicitation disabled`; in Claude Code, the change tools stay only because the admin
  has a Slack link: the next change goes to Slack, not the pop-up. Unlink by using a Cognito admin
  whose email matches no Slack user (or by the owner's choice), and the change tools disappear;
  a direct call answers `CONFIRMATION_UNAVAILABLE`. Set it back to `enabled`.
- [ ] **Step 10: Read everything back (FR-052, SC-011).** `agentx --env live25e admin changes
  --since 2h` and `--json`: every change of Steps 4 to 9, applied, declined, expired and failed,
  each with who, the client, the change, the method, the times and the trace ID; `aws logs
  filter-log-events` for one change's trace ID over the broker, notifier and ingress log groups
  finds its proposed, slack_requested, dm_posted, press_received, claimed and applied lines. The
  `AdminChangeOutcome` metric has a data point per outcome.
- [ ] **Step 11: No secret leaked (SC-004).** Ask Claude Code to register a revision whose
  instructions quote `ghp_` plus 36 letters, and decline it; the pop-up, the Slack message (if any),
  the record and every log group show `[REDACTED]` and never the token. Local files as 25b's Step 11.
- [ ] **Step 12: Tear down**, exactly as 25b's Step 12 for `live25e`, and confirm nothing named
  `live25e` remains, so the next live check has room.
- [ ] **Step 13: Record the evidence** in the PR description: each scenario's outcome and timing
  (how long the DM took to arrive; how long a press took to apply), each defect fixed, and any
  finding that changes a ruling above. Raise those with the owner before merge.

## Not in this phase

- **Later, by owner decision:** an admin change tool for a shared task's mode (Q10: `agentx admin
  task share-mode` covers it); a grant by email before the person's first sign-in (Q4's other
  option); stopping a workspace's compute by hand (Q2's other option; idle sessions stop on their
  own); the hosted MCP endpoint; admin changes in the legacy production deployment (D14).
- **Not planned:** a third confirmation method (FR-041: "There is no other method"; the `cli`
  method is the typed command D12 already allowed).

## Self-review

- **Spec coverage.** FR-030's nine change tools: Tasks 5 and 6 (plans), 7 (routes), 13 (tools), 17
  (each one declined end to end); `agentx_admin_changes`: Tasks 2, 7, 13. FR-039: Tasks 1, 7.
  FR-040: Task 7 (at most once, stale, reused, declined), 17. FR-041: Tasks 7 (offered methods, the
  press), 8 (the DM), 9 (the ingress), 11 (the configuration), 12 (the order and the fallback), 13
  (the offer, `CONFIRMATION_UNAVAILABLE`). FR-042: E17, Tasks 14, 15 (and every existing admin
  test unchanged). FR-051: Tasks 2, 7, 17. FR-052: Tasks 2 (logs, metric), 7, 8, 9 (each step's
  line), 13, 14 (`agentx admin changes`), 17 (SC-011). FR-053: Tasks 4, 6, 13, 15, 17 (SC-013).
  US6 scenarios 1 to 7: Task 17 and Task 7. SC-005: Task 7's matrix and Task 17's declines for
  every tool. The owner's requirement: `agentx_admin_grant_project_access` (Tasks 4, 6, 13) and its
  CLI (Task 14); `agentx config set limits.*` through the change path (Task 15), with the refusal
  test replaced by name. 25c's C22: Task 16.
- **Placeholder scan.** Every code step shows its code. Two steps read a fact first and say what to
  do with it: Task 13's `readsOffer` (25d's `adminOffer` body, renamed) and Task 15's
  `configServicesFor` (a move of `config-commands.test.ts`'s own factory).
- **Type consistency.** `PendingChange` (Task 7) is what the notifier (Task 8) and the ingress's
  trace read (Task 9) see; `AdminChangeView` and `AdminChangeAuditRecord` (Task 1) are what the
  routes (Task 7), the MCP client (Task 12), the tools (Task 13) and the CLI (Tasks 14, 15) use.
  `PlanDependencies`, `ChangePlan` and `PLANNERS` are Task 5's, extended by Task 6.
  `AdminActionDependencies` (Task 4) is built once in `planDependencies` (Task 5). `AdminOffer`
  keeps 25d's `admin` and gains optional `audit` and `changes` (Task 13), so 25d's callers and
  tests are unchanged.
- **Review Focus.** Each line has its test in the owning task: 1 in Task 7, 2 in Task 7, 3 in
  Task 12, 4 in Tasks 5 and 17, 5 in Task 15.
- **Owner questions.** Q1 to Q11 each name the tasks that depend on them; Task 18 records the
  answers, and stops for any answer that differs from the recommendation.
