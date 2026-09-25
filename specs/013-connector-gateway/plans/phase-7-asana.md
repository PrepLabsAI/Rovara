# Phase 7: Asana Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An administrator can create their own Asana MCP app, sign a dedicated bot user in once
with `agentx admin credential authorize`, approve Asana tools for one project, and members can
search, list, read, create, update and comment on that project's tasks from a Slack thread, with
the access token refreshed headlessly and every call held to the project.

**Architecture:** A new vendor-neutral credential provider, `oauth-refresh-token`
(`packages/gateway/src/refresh-token.ts`), mints access tokens from a refresh token stored in the
credential's Secrets Manager secret. It shares the access token across broker containers through
the existing token cache, lets only one container refresh at a time through a new
`DynamoRefreshLease`, and writes a rotated refresh token back to the secret. The administration
client gains `agentx admin credential authorize` (`packages/cli/src/admin/authorize.ts`), which runs
the browser sign-in (authorization code, PKCE S256, state) on a loopback listener and stores the
refresh token. Asana vocabulary lives only in `packages/gateway/src/asana.ts`: endpoint, project
binder, project guard and item-argument declarations. The broker gains `asanaConnectorType`;
routes, ledger, catalog cache, presentation and orchestrator do not change (SC-002).

**Tech Stack:** TypeScript 5.9 strict, Node 22.19 to 22.x, Zod 4, Vitest 5, MCP SDK 1.30.1
(Streamable HTTP), AWS SDK v3 3.1134.0 (Secrets Manager, DynamoDB document client), AWS CDK.

**Spec:** [../spec.md](../spec.md), **Amendment 1**: User Story 6, FR-033 to FR-041, SC-008, and the
amendment's decisions. Also FR-001, FR-004, FR-005, FR-009, FR-011 to FR-014, FR-019, FR-024,
SC-002, SC-005; [../contracts/project-config.md](../contracts/project-config.md) (registration
outcomes, mandatory vendor-side restriction); [../contracts/evaluation.md](../contracts/evaluation.md).
Predecessors: [phase-3-credentials.md](phase-3-credentials.md) (registry and providers),
[phase-5b-binder.md](phase-5b-binder.md) (optional binding, guard scope), and the two connector
plans this one follows, [phase-5-linear.md](phase-5-linear.md) and [phase-6-jira.md](phase-6-jira.md).
Owner requirements: every organisation creates its own Asana app and bot user; AgentX never holds
anyone's credentials.

**Branch:** `feat/013-phase-7-asana`, from `mainline` at `af67c2c` (phases 1a to 6 and 4 merged),
with `mainline` at `1992d5e` (spec 014 phase 14a: Slack ingress, formatter, `replySurface`) merged
in before Task 1. 14a touches no file or anchor this plan edits except `infra/lib/control-plane.ts`
and `README.md`, whose anchors are unchanged. One pull request. Spec 014 phases 14b to 14d are in
flight on their own branches; see "Coordination with spec 014".

**Task map to `tasks.md`:** T041 = Tasks 1 to 3. T042 = Task 4. T043 = Tasks 5 to 7. T044 = Task 8.
T045 = Task 9.

## Global Constraints

- **No regressions.** Every existing test passes with its assertions unchanged, except these three
  named assertion changes, each forced by a deliberate addition:
  1. `tests/contract/credential-contracts.test.ts`, "refuses reserved and built-in types, other
     secret prefixes and extra fields": the loop `["github-app", "oauth-refresh-token", "per-user", "basic"]`
     becomes `["github-app", "per-user", "basic"]`, because `oauth-refresh-token` becomes registrable
     (Task 3).
  2. `tests/contract/connector-types.test.ts`, "has a built-in entry for every type
     ConnectorConfigSchema accepts": `toEqual(["github", "linear", "jira"])` becomes
     `toEqual(["github", "linear", "jira", "asana"])` (Task 6).
  3. `tests/contract/cli-main.test.ts`, "exposes administration only": `subcommands(admin, "credential")`
     `toEqual(["register", "list"])` becomes `toEqual(["register", "authorize", "list"])` (Task 4).
- **Characterization first.** Task 1 pins the shared behaviour this phase leans on, on unchanged
  `mainline`, before any code changes. Its tests never change afterwards.
- **Strict TDD.** Every code step is preceded by a failing test that is run and seen failing.
- **GitHub, Linear and Jira unchanged.** Their catalogs, schema hashes, ledger keys and messages
  stay byte-identical. The existing `oauth-client-credentials` and `static-secret` providers are not
  edited.
- **Vendor code placement (FR-001).** Asana's endpoint, token endpoint and argument names
  (`task_id`, `project`, `project_id`, `default_project`, `projects_any`, `tasks[].task` and the rest)
  live in `packages/gateway/src/asana.ts`. The provider (`refresh-token.ts`), the lease, the
  registry and the CLI command are vendor-neutral. OAuth sign-in endpoints are data in
  `packages/contracts/src/oauth-profiles.ts`, as `JIRA_PROJECT_TOOL_ACCESS` already is.
- **Secret safety.** No access token, refresh token, authorization code or client secret appears
  in a response, log line, error message, CLI output, fixture or snapshot. Log lines name an error's
  class only.
- **Test imports.** Tests that drive broker code import gateway classes from `"@agentx/gateway"`
  (dist). Gateway-only tests import `packages/gateway/src`.
- **Dependencies.** No new third-party package in the repository. The CLI gains
  `@aws-sdk/client-secrets-manager` at `3.1134.0`, the version the broker already pins; the lockfile
  changes by one line.
- **Docs style.** Plain, short sentences. No em-dashes in any document this phase writes.
- **Open source.** Every organisation creates its own Asana app and bot user. The guide never
  assumes our workspace, project or app; our values appear only in `quickstart.md` evidence.
- **Node and build.** `export PATH=/private/tmp/claude-501/node-v22.20.0-darwin-arm64/bin:$PATH`;
  `npm run build` before `npm test`.
- **Full check per task.** `npm run typecheck && npm run lint && npm run build && npm test` (plus
  `npm run infra:synth` in Task 3). Two existing timing tests
  (`turn-record-contract.test.ts` "linear time", `slack-service.test.ts` "extends visibility") can
  fail on a loaded machine; rerun the suite before suspecting this phase.
- **Commits.** `type(scope): summary`, ending with
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Never use `git stash`.
- **Fix before the PR.** Fix cheap review findings and anything that fails silently before the PR.

## Review Focus

1. **The refresh fails.** A revoked sign-in, a reset client secret or a malformed secret must read
   as "not connected" with the exact fix (`agentx admin credential authorize --ref <ref>`), never as
   a generic vendor error; a 5xx or a network fault must stay transient and must not tell an
   administrator to sign in again. Tests: Task 2 ("reports a refused refresh token as not
   connected", "treats a server error ... as transient", "missing or malformed secret"), Task 7
   ("reports a revoked sign-in as not connected").
2. **Asana rotates the refresh token.** The new token must be saved before its access token is
   used, used on the next refresh by this and every other container, and never lost silently when
   the save fails. Tests: Task 2 ("writes a rotated refresh token back", "a second container uses
   the rotated token", "keeps a rotated token it could not save", "retries once with a refresh token
   another container rotated"), Task 3 (log line by error name only), Task 7 (write-back through
   the broker).
3. **Two containers refresh at the same moment.** Only one may present the refresh token (a
   vendor with reuse detection would revoke the whole grant otherwise); the other must get the same
   access token; a container that dies mid-refresh must not block the others for longer than one
   call. Tests: Task 2 ("lets only one of two containers refresh at a time", "takes over the lease
   from a container that died", "releases the lease after a failed refresh"), Task 3
   (`DynamoRefreshLease` ownership and expiry).
4. **The sign-in redirect is forged, stale or refused.** A redirect with another state (or none)
   must be answered and ignored without ending the wait; an `error` redirect with the right state
   must stop with nothing stored; the code must be bound to the PKCE verifier; the listener must bind
   127.0.0.1 only. Tests: Task 4 ("ignores a redirect with the wrong state", "stops without storing
   anything when the sign-in is refused", the S256 check in the first test, "times out").
5. **A token leaks into output.** No access token, refresh token, code or client secret in CLI
   output, API responses, `credential list`, error messages or broker log lines, including on
   failure paths. Tests: Task 2 (refused-refresh message), Task 3 (unsaved-rotation log), Task 4
   (command-line run), Task 7 ("never reveals ...").
6. **A write reaches another project.** A comment, update, subtask, dependency or project move
   aimed at a task outside the scope's project must be refused before any upstream write, and a
   model-supplied project must be refused before connecting. Tests: Task 5 (guard table), Task 7
   ("refuses a write to another project's task with zero upstream writes").
7. **Asana's `get_task` answer differs from the assumed REST shape.** Every task check must refuse
   ("Could not confirm ..."), never allow. Tests: Task 5 ("fails closed when the task cannot be read,
   has an unexpected shape, or is a different task"); Task 9 captures the real shape.

## Scoping design

Asana has workspaces, teams, projects, sections and tasks, and a task can be in several projects.
Linear holds a connector to a team and Jira to a project; for Asana the unit is **a project**, and
a connector lists one scope per project: `{ alias, projectGid }`.

- **Why not a workspace.** In the recorded `tools/list` (39 tools), only the interactive widget
  tools (`create_task_confirm`, `create_project_confirm`, `create_project_confirm_populate`) take a
  `workspace` argument. `search_tasks`, `get_tasks`, `get_task` and the write tools do not, so
  AgentX could neither bind nor check a workspace. A project is both bindable and checkable.
- **Binder (bound where present, 5b `optionalProperties`).** `project` (`get_tasks`), `project_id`
  (`get_project`), `default_project` (`create_tasks`) and `projects_any` (`search_tasks`) are removed
  from the model's schema and set to the scope's project GID. A list, a search, a create and a
  project read can therefore only reach that project. A model-supplied value is refused by the
  engine before any connection (existing 5b behaviour).
- **Guard (lookup, fail closed).** Every other call names tasks. Before it is sent, every task it
  names (`task_id`; `tasks[].parent` in `create_tasks`; `tasks[].task`, `tasks[].parent` and the four
  dependency lists in `update_tasks`) is read with `get_task` on the same connection and must list the
  scope's project, directly or through its parent up to three levels (Asana subtasks are often in no
  project). An error, an unrecognised shape or a different GID refuses the call. At most 10 tasks and
  10 reads per call. Arguments that would replace the project context or move a task between
  projects are refused outright.
- **Only guarded tools.** `ASANA_PROJECT_TOOL_ACCESS` pins eight tools and their access; the schema
  refuses any other Asana tool, so there is no unguarded Asana tool to approve.
- **Generic for spec 014.** The guard is driven by a declarative table, `ASANA_TASK_REFERENCES`
  (tool to argument paths such as `["tasks", "*", "task"]`), and the connector declares
  `ASANA_ITEM_ARGUMENTS = ["task_id"]`, the top-level argument through which a tool names an existing
  task. That is the one line of connector data 14c1's `ConnectorDefinition.itemArguments` needs.
- **Vendor side (mandatory).** Asana OAuth has no scopes: the token reaches whatever the bot user
  can see. The guide makes the bot user a guest or member of only the intended project and proves it
  (Step 6). The guard is the second line.

## Coordination with spec 014

Spec 014 phase 14a is merged into this branch; 14b to 14d are in flight (`~/web/AgentX-p14`). This
phase does not edit anything 014 edits: `ConnectorDefinition`, `PresentedTool`, `catalog.ts`, the orchestrator and the Slack service
are untouched.

| Shared piece | What this phase does | What the second to land does |
|---|---|---|
| `ConnectorDefinition.itemArguments` (14c1 R1) | Does not exist on `mainline`; this phase exports `ASANA_ITEM_ARGUMENTS = ["task_id"]` from `asana.ts` and pins it in a test | Adds `itemArguments: [...ASANA_ITEM_ARGUMENTS],` to `asanaConnector` and `["asana", "task_id"]` to 14c1's item-argument test |
| Vendor fixture loader (`tests/support/vendor-fixtures.ts`) | Adds `"asana"` to `VendorFixture` | 14c1 appends its own loader; keep both |
| `BUILT_IN_CONNECTOR_TYPES`, `ConnectorConfigSchema` | Adds `asana` | Nothing; 14c does not change them |
| Pinned vendor classes (14c2 "pin every vendor fixture's class in a test") | Nothing | Adds Asana's eight tools to that test; see the conflicts below |

Conflicts found, for the 014 owner (not resolved here):

1. **`update_tasks` names its items inside an array (`tasks[].task`).** 14c1 R1 gives a tool the
   first declared item argument its top-level schema has. `update_tasks` has no `task_id`, so its
   `itemArgument` is `null` and 14c2's `baseClass` classes every update of existing tasks as a
   **create**, which runs without asking (only the bulk rule above 5 items would ask). Options for
   014: accept argument paths such as `tasks[].task` (this phase already publishes them as
   `ASANA_TASK_REFERENCES`), or a per-tool map. Until then an administrator can add the action-policy
   rule `{ connector: asana, tool: update_tasks, treatAs: change }` (14c1 R4).
2. **Completing a task is not a lifecycle key.** Asana closes a task with `completed: true` (and
   `approval_status`). 14c2's `LIFECYCLE_KEYS` has `state`, `status`, `closed`, `archived` and others
   but not `completed`, so "mark it complete" is a change, not destructive. Adding `completed` to
   `LIFECYCLE_KEYS` is vendor-neutral.
3. **`delete_task`** carries a destructive name, and this phase refuses to approve it at all, so
   the two agree.

## File Structure

| File | Responsibility |
|---|---|
| `packages/contracts/src/credentials.ts` | `oauth-refresh-token` registrable; `OAuthRefreshTokenSecretSchema`; `OAuthAppSecretSchema` |
| `packages/contracts/src/oauth-profiles.ts` (new) | `OAUTH_AUTHORIZATION_PROFILES` (`asana`), `oauthProfile(name)` |
| `packages/contracts/src/connectors.ts` | `ASANA_PROJECT_TOOL_ACCESS`, `AsanaScopeSchema`, `AsanaConnectorSchema`, union option |
| `packages/gateway/src/credentials.ts` | `oauth-refresh-token` secret shape; `readLimitedText` exported (internal) |
| `packages/gateway/src/refresh-token.ts` (new) | `SecretStore`, `RefreshLease`, `oauthRefreshTokenProvider` |
| `packages/gateway/src/asana.ts` (new) | Endpoints, `AsanaProjectScope`, `ASANA_ITEM_ARGUMENTS`, `ASANA_TASK_REFERENCES`, binder, guard, `asanaConnector` |
| `packages/broker/src/aws/credentials.ts` | `secretsManagerSource().write`, `DynamoRefreshLease`, registry builds the refresh provider, `tokenCached` for it |
| `packages/broker/src/aws/asana-connector-type.ts` (new) | `asanaConnectorType` |
| `packages/broker/src/aws/connector-types.ts` | `BUILT_IN_CONNECTOR_TYPES.asana` |
| `packages/broker/src/aws/registration-preflight.ts` | "an Asana" in the credential-type refusal |
| `packages/cli/src/admin/authorize.ts` (new) | `authorizeCredential`, `secretsManagerAuthorizeSecrets`, loopback listener |
| `packages/cli/src/main.ts`, `auth.ts`, `package.json` | `admin credential authorize`; `openSystemBrowser` exported; SDK dependency |
| `infra/lib/control-plane.ts` | Tag-limited `secretsmanager:PutSecretValue` on `agentx/connectors/*` |
| `tests/fixtures/vendors/asana-tools.json` | Asana's whole `tools/list`, recorded 2026-09-24 (committed with this plan) |
| `tests/fixtures/vendors/asana-get-task.json` (new) | The `get_task` shape the guard reads (REST shape until Task 9 captures the live one) |
| `tests/support/refresh-token-fakes.ts`, `fake-asana.ts` (new) | Clock, cache, lease, secret store, token endpoint; fake Asana token endpoint and MCP server |
| `tests/contract/refresh-token-*.test.ts`, `gateway-refresh-token.test.ts`, `credential-authorize.test.ts`, `gateway-asana.test.ts`, `asana-connector.test.ts` (new) | Unit and contract tests |
| `tests/integration/asana-connector.test.ts` (new) | Fake Asana plus broker routes, end to end |
| `tests/live/asana-live.test.ts` (new) | Skipped unless `AGENTX_LIVE_ASANA_CLIENT_ID` is set |
| `tests/eval/cases/asana.jsonl`, `fixtures/payments-asana.yaml`, `catalogs/asana.json` (new) | Evaluation cases |
| `docs/connectors/asana.md` (new) | Setup guide for self-hosters |
| `README.md`, `specs/013-connector-gateway/contracts/project-config.md`, `quickstart.md`, `tasks.md` | Documents |

## Pre-decided Rulings

1. **Scope is a project (`projectGid`), never a workspace.** See "Scoping design". Cost if wrong:
   an organisation that wants workspace-wide search must list each project as a scope.
2. **Only eight Asana tools, access pinned** (`get_task`, `get_task_stories`, `get_tasks`,
   `search_tasks`, `get_project` read; `create_tasks`, `update_tasks`, `add_comment` write). Every
   Asana connector is project-scoped, so there is no unguarded mode (unlike Jira without
   `projectKey`). Cost if wrong: a new Asana tool needs a guard rule, a code change, before it can be
   approved.
3. **Refused arguments.** `get_tasks`: `tag`, `section`, `user_task_list` and `assignee` (Asana's
   list needs exactly one context, and any of these could replace the bound project; the refusal
   points at `search_tasks` with `assignee_any`). `create_tasks`: a `project_id` other than the
   scope's, `section_id`, `assignee_section`. `update_tasks`: `add_projects`, `remove_projects`,
   `assignee_section`. Cost if wrong: a free-plan workspace cannot ask "my tasks in this project"
   (no `search_tasks`), and tasks cannot be placed in a section on create; both are open questions.
4. **Subtasks inherit their parent's project, up to three levels,** because Asana shows a subtask
   to whoever can see its parent and subtasks are usually in no project. Cost if wrong: one extra
   read per level; a four-level subtask is refused.
5. **Attribution only on `add_comment`'s `text`** (`attributionKeys: ["text"]`). `html_text` would
   break with a plain footer; task notes are inside `tasks[]` items, which the engine does not sign.
   The guide says so. Cost if wrong: some writes lack the footer.
6. **Provider mechanics.** Access token cached in the state table under `CREDENTIAL#<ref>` /
   `TOKEN#refresh-token` (the existing `DynamoTokenCache`), reused until five minutes (at most half
   its lifetime) before expiry. Lease `CREDENTIAL#<ref>` / `LEASE#refresh`, TTL 15 s (the 10 s token
   request plus two secret writes), waiters poll every 250 ms for up to 16 s so they outlive a dead
   holder within one 20 s call. The secret is read fresh under the lease (no five-minute secret
   cache). A refused refresh re-reads the secret once and retries if the token changed. Cost if
   wrong: at worst one extra refresh; never a stale token.
7. **Failure classes.** Token endpoint HTTP 400, 401 or 403 is `CredentialUnavailable` (not
   connected) naming `agentx admin credential authorize --ref <ref>`, with only a safe OAuth error
   code; anything else is a plain `Error` (vendor error). Cost if wrong: an administrator is told to
   sign in again for a problem signing in does not fix, or not told when it would.
8. **Lease failures fail open.** A DynamoDB error while taking or releasing the lease is logged by
   class and treated as acquired, so an outage cannot stop every refresh; ruling 6's re-read covers
   the race this allows. Cost if wrong: under a DynamoDB outage and a rotating vendor, two
   containers could both refresh and one would need a re-authorize.
9. **Write-back permission.** The broker may `PutSecretValue` only on `agentx/connectors/*` secrets
   tagged `agentx-writable: refresh-token`. `authorize` tags the secret, and the guide's
   `create-secret` adds the tag too. Cost if wrong: if an organisation's SCP forbids tag-based
   conditions, write-back fails, which is logged and survivable while Asana does not rotate.
10. **Sign-in runs in the CLI with the administrator's AWS credentials.** The CLI reads the app's
    client from the secret, runs the flow, writes and tags the secret, then registers through the
    control plane. The alternative, a control-plane route doing the exchange, would keep the client
    secret off the laptop but add an admin route and a vendor profile to the broker. Cost if wrong:
    a later move of the exchange into the control plane; the provider and secret shape stay.
11. **Callback listener.** Binds `127.0.0.1` on the redirect URI's port (8765 for Asana, whose app
    registers `http://localhost:8765/callback`); accepts `GET` on the redirect path only; compares
    state in constant time; ignores a wrong or missing state with a 400 page and keeps waiting;
    stops on an `error` redirect with the right state; accepts one code; 410 afterwards; five-minute
    timeout; `EADDRINUSE` says which port. Cost if wrong: a stale tab waits for the timeout.
12. **Secret shapes.** Stored: `{ clientId, clientSecret, refreshToken }`, strict. Before the first
    sign-in: `{ clientId, clientSecret }` (`OAuthAppSecretSchema`, strict, refresh token optional so
    a re-authorize also parses). Cost if wrong: none found.
13. **`get_task` shape.** The guard accepts only `{ data: { gid, projects: [{ gid }] | memberships:
    [{ project: { gid } }], parent: { gid } | null } }`, and requires `data.gid` to equal the task
    asked for. The spike recorded `tools/list` but no `get_task` result, so
    `asana-get-task.json` is built from Asana's REST shape and Task 9 replaces it with the captured
    one. Cost if wrong: every task check refuses until the parser is fixed; never a leak.
14. **Test harness.** Integration tests drive the real `connectMcp` against a local fake Asana
    through `ConnectorTypeContext.connect` (asserting the endpoint is `ASANA_MCP_ENDPOINT`), and send
    token requests to the fake through `ConnectorCredentialsConfiguration.fetchImplementation`
    (asserting the URL is `ASANA_TOKEN_ENDPOINT`). Production passes neither. Cost if wrong: none;
    Task 9 uses the production paths.
15. **Presentation strings.** Label `Asana tasks`, vendor `Asana`, scope noun `Asana project`. The
    manifest already lists `asana` as a known vendor. Cost if wrong: wording only.
16. **The vendor fixture is committed ahead, with this plan.** The spike's output lived in a
    temporary directory, so `tests/fixtures/vendors/asana-tools.json` (sha256
    `5c46c262f0bb1e8b31a95976f530871d2ed4fa6bdd7ea1ce2d4d5a25afbdb7f8`, 39 tools) is on the branch
    before Task 1. Task 5 checks the hash and does not re-record it.
17. **Refusal wording.** The shared credential-type refusal said "a Asana connector"; it now picks
    "an" before a vowel. Linear and Jira messages are unchanged. A cheap finding, fixed in Task 6.
18. **Live check in two parts.** Part A (before the PR) runs the real `authorize` code and the
    broker against real Asana with one browser sign-in. Part B (after the production release) is a
    Slack thread. T045 is checked after Part B.

---

### Task 1: Characterize the shared behaviour phase 7 relies on

Pins, on unchanged `mainline`, what the refresh-token provider and the Asana type lean on: the
registry's `tokenCached` rule, re-registration deleting only `TOKEN#` rows (the new lease row lives
beside them), and the engine turning a provider's `CredentialUnavailable` into `not_connected` and
anything else into `vendor_error`. These tests must pass before any change and are never edited
afterwards.

**Files:**
- Create: `tests/contract/refresh-token-characterization.test.ts`

**Interfaces:**
- Consumes: `executeTool`, `discoverTools`, `CredentialUnavailable`, `ConnectorNotConnected` (gateway,
  unchanged); `createAdminBroker`, `adminCall` (`tests/support/admin-broker.ts`, unchanged).
- Produces: nothing later tasks import.

- [ ] **Step 1: Confirm the vendor fixture committed with this plan**

Run: `shasum -a 256 tests/fixtures/vendors/asana-tools.json`
Expected: `5c46c262f0bb1e8b31a95976f530871d2ed4fa6bdd7ea1ce2d4d5a25afbdb7f8`. If it differs or is
missing, stop and ask the controller; do not re-record it.

- [ ] **Step 2: Write the characterization tests**

```ts
// Phase 7 characterization: shared behaviour the oauth-refresh-token provider and the Asana
// connector rely on, pinned before any phase 7 change. Every test here passes on mainline af67c2c
// and must keep passing, unchanged, through the phase.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  ConnectorNotConnected, CredentialUnavailable, discoverTools, executeTool,
  type ConnectorContext, type ConnectorDefinition, type Invocation, type Ledger, type McpConnection,
} from "../../packages/gateway/src/index.js";
import { adminCall, createAdminBroker } from "../support/admin-broker.js";

const githubApp = { ref: "github-app", secretName: "arn:aws:secretsmanager:us-east-1:111122223333:secret:github-key" };
const secretValues: Record<string, string> = {
  "agentx/connectors/tracker": JSON.stringify({ apiKey: "tracker-key-value" }),
  "agentx/connectors/oauth": JSON.stringify({ clientId: "id", clientSecret: "oauth-secret-value", scopes: ["read"] }),
};
const secrets = { read: vi.fn(async (name: string) => secretValues[name]) };

describe("credential registry behaviour phase 7 keeps", () => {
  it("never reports a cached token for a static-secret credential, even with a token row present", async () => {
    const { db, handler } = await createAdminBroker({ connectorCredentials: { secrets, githubApp } });
    await adminCall(handler, { method: "POST", path: "/v1/admin/credentials", body: { ref: "tracker", type: "static-secret", secretName: "agentx/connectors/tracker" } });
    db.set({ pk: "CREDENTIAL#tracker", sk: "TOKEN#abc", token: "stray-token", expiresAt: Date.now() + 3_600_000 });
    const listed = await adminCall(handler, { method: "GET", path: "/v1/admin/credentials" });
    expect(listed.body.credentials).toContainEqual(expect.objectContaining({ ref: "tracker", type: "static-secret", tokenCached: false }));
  });

  it("re-registering deletes the credential's TOKEN# rows and leaves its other rows alone", async () => {
    const { db, handler } = await createAdminBroker({ connectorCredentials: { secrets, githubApp } });
    const body = { ref: "oauth", type: "oauth-client-credentials", secretName: "agentx/connectors/oauth" };
    await adminCall(handler, { method: "POST", path: "/v1/admin/credentials", body });
    db.set({ pk: "CREDENTIAL#oauth", sk: "TOKEN#abc", token: "cached-token", expiresAt: Date.now() + 3_600_000 });
    db.set({ pk: "CREDENTIAL#oauth", sk: "LEASE#refresh", owner: "someone", expiresAt: Date.now() + 15_000 });
    await adminCall(handler, { method: "POST", path: "/v1/admin/credentials", body });
    expect(db.get("CREDENTIAL#oauth", "TOKEN#abc")).toBeUndefined();
    expect(db.get("CREDENTIAL#oauth", "LEASE#refresh")).toMatchObject({ owner: "someone" });
  });
});

interface SiteScope { alias: string; siteId: string }

function connectorWith(issue: ConnectorDefinition<SiteScope>["credentials"]["issue"]) {
  const tools: McpConnection["tools"] = [{ name: "list_items", description: "List items", inputSchema: { type: "object", properties: { siteId: { type: "string" } }, required: ["siteId"] } }];
  const connector: ConnectorDefinition<SiteScope> = {
    label: "Tracker", endpoint: new URL("https://mcp.tracker.test/mcp"), permissionsHint: "Tracker key permissions",
    credentials: { issue }, binder: { properties: ["siteId"], bind: (scope) => ({ siteId: scope.siteId }) }, guards: [],
  };
  const context: ConnectorContext<SiteScope> = {
    workspaceId: "workspace", ownerKey: "alice", scopeAlias: "payments", scope: { alias: "payments", siteId: "site-1" },
    policy: { tools: [{ name: "list_items", access: "read" }] }, requestedBy: { teamId: "T1", userId: "U1" },
  };
  const records = new Map<string, Invocation>();
  const ledger: Ledger = {
    claim: async (record) => { if (records.has(record.requestId)) return false; records.set(record.requestId, record); return true; },
    get: async (id) => records.get(id),
    finish: async (record) => { records.set(record.requestId, record); },
  };
  const connect = vi.fn(async () => ({ tools, call: vi.fn(), close: vi.fn(async () => undefined) }));
  return { connector, context, ledger, connect };
}

describe("engine reporting phase 7 relies on", () => {
  it("reports a credential the provider cannot issue as FAILED not_connected, with the provider's message", async () => {
    const { connector, context, ledger, connect } = connectorWith(async () => { throw new CredentialUnavailable("credential tracker: the token endpoint refused the refresh token"); });
    const result = await executeTool({ requestId: randomUUID(), scope: "payments", tool: "list_items", schemaHash: "0".repeat(64), arguments: {} }, connector, context, { ledger, connect });
    expect(result).toMatchObject({
      status: "FAILED", reason: "not_connected",
      text: "Tracker is not connected for this project: credential tracker: the token endpoint refused the refresh token. An administrator must fix its credential.",
    });
    expect(connect).not.toHaveBeenCalled();
  });

  it("reports any other provider failure as a vendor error, not as not connected", async () => {
    const { connector, context, ledger, connect } = connectorWith(async () => { throw new Error("token endpoint returned HTTP 503"); });
    const result = await executeTool({ requestId: randomUUID(), scope: "payments", tool: "list_items", schemaHash: "0".repeat(64), arguments: {} }, connector, context, { ledger, connect });
    expect(result).toMatchObject({ status: "FAILED", reason: "vendor_error", text: "Tracker MCP request failed before any write. Check Tracker key permissions and MCP availability." });
  });

  it("names the connector and the provider's message when discovery cannot get a credential", async () => {
    const { connector, context, connect } = connectorWith(async () => { throw new CredentialUnavailable("credential tracker: sign in again"); });
    await expect(discoverTools(connector, context, { connect })).rejects.toEqual(new ConnectorNotConnected("Tracker is not connected: credential tracker: sign in again"));
  });
});
```

- [ ] **Step 3: Run them on unchanged code**

Run: `npm run build && npx vitest run tests/contract/refresh-token-characterization.test.ts`
Expected: PASS, 5 tests. (Verified on `af67c2c`.) If any fails, the premise of a later task is
wrong; stop and report which.

- [ ] **Step 4: Commit**

```bash
git add tests/contract/refresh-token-characterization.test.ts
git commit -m "test(broker): characterize registry token rows and not-connected reporting before phase 7

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The `oauth-refresh-token` provider in the gateway

**Files:**
- Create: `packages/contracts/src/oauth-profiles.ts`, `packages/gateway/src/refresh-token.ts`,
  `tests/support/refresh-token-fakes.ts`, `tests/contract/refresh-token-contracts.test.ts`,
  `tests/contract/gateway-refresh-token.test.ts`
- Modify: `packages/contracts/src/credentials.ts`, `packages/contracts/src/index.ts`,
  `packages/gateway/src/credentials.ts`, `packages/gateway/src/index.ts`

**Interfaces:**
- Consumes: `CachedToken`, `TokenCache`, `SecretSource`, `CredentialUnavailable`,
  `parseConnectorSecret` (gateway `credentials.ts`); `CredentialProvider` (gateway `types.ts`).
- Produces:

```ts
// @agentx/contracts
export const OAuthRefreshTokenSecretSchema: z.ZodObject<{ clientId; clientSecret; refreshToken }>; // strict
export const OAuthAppSecretSchema: /* same, refreshToken optional, strict */;
export type OAuthRefreshTokenSecret = { clientId: string; clientSecret: string; refreshToken: string };
export interface OAuthAuthorizationProfile { authorizeUrl: string; tokenUrl: string; resource?: string; redirectUri: string }
export const OAUTH_AUTHORIZATION_PROFILES: { asana: OAuthAuthorizationProfile };
export function oauthProfile(name: string): OAuthAuthorizationProfile | undefined;
// @agentx/gateway
export function parseConnectorSecret(type: "oauth-refresh-token", raw: string | undefined, ref: string, secretName: string): OAuthRefreshTokenSecret;
export interface SecretStore extends SecretSource { write(secretName: string, value: string): Promise<void> }
export interface RefreshLease { acquire(owner: string, ttlMs: number): Promise<boolean>; release(owner: string): Promise<void> }
export const REFRESH_TOKEN_CACHE_KEY = "refresh-token";
export const REFRESH_LEASE_TTL_MS = 15_000;
export const REFRESH_LEASE_WAIT_MS = 16_000;
export function oauthRefreshTokenProvider(options: {
  ref: string; secretName: string; secrets: SecretStore; tokens: TokenCache; lease: RefreshLease; tokenEndpoint: URL;
  fetchImplementation?: typeof fetch; now?: () => number; sleep?: (milliseconds: number) => Promise<void>;
  onRotationUnsaved?: (errorName: string) => void;
}): CredentialProvider<unknown>;
// tests/support/refresh-token-fakes.ts
export function fakeClock(start?: number): { now; sleep; advance };
export function memoryTokenCache(): TokenCache & { items: Map<string, CachedToken> };
export function memoryLease(clock): RefreshLease & { holder(); acquisitions; refusals; firstRefusal: Promise<void> };
export function memorySecretStore(values): SecretStore & { values; writes; failWrites: number };
export function fakeTokenEndpoint(options): FakeTokenEndpoint;
```

`RegistrableCredentialTypeSchema` is **not** changed here: until Task 3 teaches the registry to
build this provider, registering the type must stay impossible.

- [ ] **Step 1: Write the failing contract tests**

```ts
// tests/contract/refresh-token-contracts.test.ts
import { describe, expect, it } from "vitest";
import {
  OAUTH_AUTHORIZATION_PROFILES, OAuthAppSecretSchema, OAuthRefreshTokenSecretSchema, oauthProfile,
} from "../../packages/contracts/src/index.js";

describe("oauth-refresh-token secrets and sign-in profiles (phase 7)", () => {
  it("parses the stored secret only with a client and a refresh token, and nothing that could redirect the broker", () => {
    const secret = { clientId: "1234567890", clientSecret: "client-secret-value", refreshToken: "refresh-token-value" };
    expect(OAuthRefreshTokenSecretSchema.parse(secret)).toEqual(secret);
    expect(OAuthRefreshTokenSecretSchema.safeParse({ clientId: "1234567890", clientSecret: "client-secret-value" }).success).toBe(false);
    expect(OAuthRefreshTokenSecretSchema.safeParse({ ...secret, refreshToken: "" }).success).toBe(false);
    expect(OAuthRefreshTokenSecretSchema.safeParse({ ...secret, tokenEndpoint: "https://evil.test" }).success).toBe(false);
  });

  it("reads the app secret before the first sign-in, still strictly", () => {
    expect(OAuthAppSecretSchema.parse({ clientId: "1234567890", clientSecret: "s" })).toEqual({ clientId: "1234567890", clientSecret: "s" });
    expect(OAuthAppSecretSchema.safeParse({ clientId: "1234567890", clientSecret: "s", refreshToken: "r" }).success).toBe(true);
    expect(OAuthAppSecretSchema.safeParse({ clientId: "1234567890", clientSecret: "s", redirectUri: "https://evil.test" }).success).toBe(false);
    expect(OAuthAppSecretSchema.safeParse({ clientId: "1234567890" }).success).toBe(false);
  });

  it("carries Asana's sign-in endpoints, proven live on 2026-09-24, and no profile for other types", () => {
    expect(OAUTH_AUTHORIZATION_PROFILES.asana).toEqual({
      authorizeUrl: "https://app.asana.com/-/oauth_authorize",
      tokenUrl: "https://app.asana.com/-/oauth_token",
      resource: "https://mcp.asana.com/v2/mcp",
      redirectUri: "http://localhost:8765/callback",
    });
    expect(oauthProfile("asana")).toBe(OAUTH_AUTHORIZATION_PROFILES.asana);
    expect(oauthProfile("linear")).toBeUndefined();
    expect(oauthProfile("toString")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Write the test fakes**

```ts
// Fakes for the oauth-refresh-token provider: a clock, a shared token cache, a lease with real
// expiry, a secret store and an OAuth token endpoint that can rotate or refuse refresh tokens.
import type { CachedToken, RefreshLease, SecretStore, TokenCache } from "../../packages/gateway/src/index.js";

export interface Clock { now: () => number; sleep: (milliseconds: number) => Promise<void> }

/** Time moves only when a caller sleeps, so lease waits are deterministic. */
export function fakeClock(start = 1_800_000_000_000): Clock & { advance: (milliseconds: number) => void } {
  let current = start;
  return {
    now: () => current,
    sleep: async (milliseconds) => { current += milliseconds; await new Promise<void>((resolve) => setImmediate(resolve)); },
    advance: (milliseconds) => { current += milliseconds; },
  };
}

export function memoryTokenCache(): TokenCache & { items: Map<string, CachedToken> } {
  const items = new Map<string, CachedToken>();
  return {
    items,
    get: async (key) => items.get(key),
    put: async (key, value) => { items.set(key, value); },
    delete: async (key) => { items.delete(key); },
  };
}

/** One lease shared by every provider given it, the way DynamoRefreshLease is shared by containers. */
export function memoryLease(clock: Pick<Clock, "now">): RefreshLease & { holder(): string | undefined; acquisitions: number; refusals: number; firstRefusal: Promise<void> } {
  let held: { owner: string; expiresAt: number } | undefined;
  let refused!: () => void;
  const firstRefusal = new Promise<void>((resolve) => { refused = resolve; });
  const lease = {
    firstRefusal,
    acquisitions: 0,
    refusals: 0,
    holder: () => (held !== undefined && held.expiresAt > clock.now() ? held.owner : undefined),
    async acquire(owner: string, ttlMs: number) {
      if (held !== undefined && held.expiresAt > clock.now() && held.owner !== owner) { lease.refusals += 1; refused(); return false; }
      held = { owner, expiresAt: clock.now() + ttlMs };
      lease.acquisitions += 1;
      return true;
    },
    async release(owner: string) { if (held?.owner === owner) held = undefined; },
  };
  return lease;
}

export function memorySecretStore(values: Record<string, string>): SecretStore & { values: Record<string, string>; writes: Array<{ name: string; value: string }>; failWrites: number } {
  const store = {
    values,
    writes: [] as Array<{ name: string; value: string }>,
    failWrites: 0,
    read: async (name: string) => store.values[name],
    async write(name: string, value: string) {
      if (store.failWrites > 0) {
        store.failWrites -= 1;
        const error = new Error("simulated write failure");
        error.name = "AccessDeniedException";
        throw error;
      }
      store.writes.push({ name, value });
      store.values[name] = value;
    },
  };
  return store;
}

export interface FakeTokenEndpoint {
  fetch: typeof fetch;
  /** Every refresh token presented, in order. */
  presented: string[];
  /** Requests received, counted before any hold. */
  requested: number;
  /** The refresh token the endpoint currently accepts. */
  valid(): string;
  /** When true, each successful refresh issues a new refresh token and revokes the old one. */
  rotate: boolean;
  /** When set, every refresh answers this status and body. */
  fail?: { status: number; body: string } | undefined;
  /** Resolves each refresh only when release() is called, to hold refreshes in flight. */
  hold: boolean;
  release(): void;
  accessTokens: string[];
}

export function fakeTokenEndpoint(options: { clientId: string; clientSecret: string; refreshToken: string; expiresIn?: number }): FakeTokenEndpoint {
  let valid = options.refreshToken;
  let serial = 0;
  const waiting: Array<() => void> = [];
  const endpoint: FakeTokenEndpoint = {
    presented: [],
    requested: 0,
    accessTokens: [],
    rotate: false,
    hold: false,
    valid: () => valid,
    release: () => { for (const resume of waiting.splice(0)) resume(); },
    fetch: async (_url, init) => {
      const form = new URLSearchParams(init?.body as string);
      endpoint.requested += 1;
      if (endpoint.hold) await new Promise<void>((resolve) => waiting.push(resolve));
      if (endpoint.fail) return new Response(endpoint.fail.body, { status: endpoint.fail.status });
      if (form.get("client_id") !== options.clientId || form.get("client_secret") !== options.clientSecret) {
        return Response.json({ error: "invalid_client" }, { status: 401 });
      }
      if (form.get("grant_type") !== "refresh_token") return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
      const presented = form.get("refresh_token") ?? "";
      endpoint.presented.push(presented);
      if (presented !== valid) return Response.json({ error: "invalid_grant" }, { status: 400 });
      serial += 1;
      const accessToken = `access-token-${serial}-${"a".repeat(40)}`;
      endpoint.accessTokens.push(accessToken);
      const body: Record<string, unknown> = { access_token: accessToken, token_type: "bearer", expires_in: options.expiresIn ?? 3_600 };
      if (endpoint.rotate) {
        valid = `refresh-token-rotated-${serial}`;
        body.refresh_token = valid;
      } else {
        body.refresh_token = presented;
      }
      return Response.json(body);
    },
  };
  return endpoint;
}
```

- [ ] **Step 3: Write the failing provider tests**

```ts
// tests/contract/gateway-refresh-token.test.ts
import { describe, expect, it, vi } from "vitest";
import {
  CredentialUnavailable, REFRESH_LEASE_TTL_MS, REFRESH_TOKEN_CACHE_KEY, oauthRefreshTokenProvider, parseConnectorSecret,
} from "../../packages/gateway/src/index.js";
import { fakeClock, fakeTokenEndpoint, memoryLease, memorySecretStore, memoryTokenCache } from "../support/refresh-token-fakes.js";

const SECRET = "agentx/connectors/asana-bot";
const CLIENT = { clientId: "1210000000000001", clientSecret: "client-secret-value-0123456789" };
const REFRESH = "refresh-token-original-value";
const endpointUrl = new URL("https://auth.vendor.test/-/oauth_token");

/** One broker container: its own provider over the shared cache, lease and secret store. */
function setup(options: { rotate?: boolean; expiresIn?: number } = {}) {
  const clock = fakeClock();
  const tokens = memoryTokenCache();
  const lease = memoryLease(clock);
  const secrets = memorySecretStore({ [SECRET]: JSON.stringify({ ...CLIENT, refreshToken: REFRESH }) });
  const endpoint = fakeTokenEndpoint({ ...CLIENT, refreshToken: REFRESH, ...(options.expiresIn === undefined ? {} : { expiresIn: options.expiresIn }) });
  endpoint.rotate = options.rotate ?? false;
  const unsaved: string[] = [];
  const container = () => oauthRefreshTokenProvider({
    ref: "asana-bot", secretName: SECRET, secrets, tokens, lease, tokenEndpoint: endpointUrl,
    fetchImplementation: endpoint.fetch, now: clock.now, sleep: clock.sleep, onRotationUnsaved: (name) => unsaved.push(name),
  });
  return { clock, tokens, lease, secrets, endpoint, unsaved, container };
}

describe("parseConnectorSecret for oauth-refresh-token", () => {
  it("parses the client and refresh token, and names only the secret when malformed", () => {
    const raw = JSON.stringify({ ...CLIENT, refreshToken: REFRESH });
    expect(parseConnectorSecret("oauth-refresh-token", raw, "asana-bot", SECRET)).toEqual({ ...CLIENT, refreshToken: REFRESH });
    const withoutToken = JSON.stringify(CLIENT);
    expect(() => parseConnectorSecret("oauth-refresh-token", withoutToken, "asana-bot", SECRET))
      .toThrow(new CredentialUnavailable(`credential asana-bot: secret ${SECRET} must be JSON {"clientId": "...", "clientSecret": "...", "refreshToken": "..."}`));
  });
});

describe("oauth-refresh-token provider", () => {
  it("refreshes with the stored refresh token, form-encoded, without following redirects, and caches the access token", async () => {
    const { endpoint, tokens } = setup();
    const fetchSpy = vi.fn(endpoint.fetch);
    const provider = oauthRefreshTokenProvider({
      ref: "asana-bot", secretName: SECRET, secrets: memorySecretStore({ [SECRET]: JSON.stringify({ ...CLIENT, refreshToken: REFRESH }) }),
      tokens, lease: memoryLease({ now: Date.now }), tokenEndpoint: endpointUrl, fetchImplementation: fetchSpy,
    });
    const issued = await provider.issue(undefined, "read");
    expect(issued).toEqual({ token: endpoint.accessTokens[0], bindings: {} });
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(endpointUrl);
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(Object.fromEntries(new URLSearchParams(init?.body as string))).toEqual({
      grant_type: "refresh_token", refresh_token: REFRESH, client_id: CLIENT.clientId, client_secret: CLIENT.clientSecret,
    });
    expect(tokens.items.get(REFRESH_TOKEN_CACHE_KEY)?.token).toBe(endpoint.accessTokens[0]);
  });

  it("reuses the access token until five minutes before its one-hour expiry, then refreshes", async () => {
    const { endpoint, clock, container } = setup();
    const provider = container();
    const first = await provider.issue(undefined, "read");
    clock.advance(54 * 60_000);
    expect(await provider.issue(undefined, "read")).toEqual(first);
    expect(endpoint.presented).toHaveLength(1);
    clock.advance(2 * 60_000);
    const second = await provider.issue(undefined, "read");
    expect(second.token).not.toBe(first.token);
    expect(endpoint.presented).toEqual([REFRESH, REFRESH]);
  });

  it("does not write the secret when the refresh token comes back unchanged or absent (as Asana did on 2026-09-24)", async () => {
    const { secrets, container } = setup();
    await container().issue(undefined, "read");
    expect(secrets.writes).toEqual([]);
  });

  it("writes a rotated refresh token back to the secret before using its access token, and uses it next time", async () => {
    const { secrets, endpoint, clock, container } = setup({ rotate: true });
    const provider = container();
    await provider.issue(undefined, "read");
    expect(secrets.writes).toEqual([{ name: SECRET, value: JSON.stringify({ ...CLIENT, refreshToken: "refresh-token-rotated-1" }) }]);
    clock.advance(56 * 60_000);
    await provider.issue(undefined, "read");
    expect(endpoint.presented).toEqual([REFRESH, "refresh-token-rotated-1"]);
    expect(JSON.parse(secrets.values[SECRET]!)).toEqual({ ...CLIENT, refreshToken: "refresh-token-rotated-2" });
  });

  it("a second container uses the rotated token the first one saved, never the revoked one", async () => {
    const { endpoint, clock, container } = setup({ rotate: true });
    await container().issue(undefined, "read");
    clock.advance(56 * 60_000);
    await container().issue(undefined, "read");
    expect(endpoint.presented).toEqual([REFRESH, "refresh-token-rotated-1"]);
  });

  it("keeps a rotated token it could not save, retries the write once, reports it by error name only, and still serves the call", async () => {
    const { secrets, endpoint, clock, unsaved, container } = setup({ rotate: true });
    secrets.failWrites = 2;
    const provider = container();
    const issued = await provider.issue(undefined, "read");
    expect(issued.token).toBe(endpoint.accessTokens[0]);
    expect(unsaved).toEqual(["AccessDeniedException"]);
    expect(JSON.parse(secrets.values[SECRET]!)).toEqual({ ...CLIENT, refreshToken: REFRESH });
    clock.advance(56 * 60_000);
    await provider.issue(undefined, "read");
    expect(endpoint.presented).toEqual([REFRESH, "refresh-token-rotated-1"]);
    expect(JSON.parse(secrets.values[SECRET]!)).toEqual({ ...CLIENT, refreshToken: "refresh-token-rotated-2" });
  });

  it("reports a refused refresh token as not connected with the re-authorize command, never echoing the body or a token", async () => {
    const { endpoint, container } = setup();
    endpoint.fail = { status: 400, body: JSON.stringify({ error: "invalid_grant", error_description: `token ${REFRESH} revoked` }) };
    const failure = await container().issue(undefined, "read").catch((error: unknown) => error);
    expect(failure).toEqual(new CredentialUnavailable("credential asana-bot: the token endpoint refused the refresh token with HTTP 400 (invalid_grant); the bot user must sign in again with agentx admin credential authorize --ref asana-bot"));
    expect(String((failure as Error).message)).not.toContain(REFRESH);
    expect(String((failure as Error).message)).not.toContain(CLIENT.clientSecret);
  });

  it("reports a refused client (401 invalid_client) as not connected too", async () => {
    const { endpoint, container } = setup();
    endpoint.fail = { status: 401, body: JSON.stringify({ error: "invalid_client" }) };
    await expect(container().issue(undefined, "read")).rejects.toThrow(CredentialUnavailable);
  });

  it("treats a server error or a response without an access token as transient, never as not connected", async () => {
    const { endpoint, container } = setup();
    endpoint.fail = { status: 503, body: `upstream down ${REFRESH}` };
    const failure = await container().issue(undefined, "read").catch((error: unknown) => error);
    expect(failure).not.toBeInstanceOf(CredentialUnavailable);
    expect((failure as Error).message).toBe("token endpoint returned HTTP 503");
    endpoint.fail = { status: 200, body: "{}" };
    await expect(container().issue(undefined, "read")).rejects.toThrow("token endpoint returned no access token");
  });

  it("reports a missing or malformed secret as not connected, naming only the secret", async () => {
    const { secrets, container } = setup();
    secrets.values[SECRET] = JSON.stringify(CLIENT);
    await expect(container().issue(undefined, "read")).rejects.toThrow(`credential asana-bot: secret ${SECRET} must be JSON`);
  });

  it("coalesces concurrent calls in one container into one refresh", async () => {
    const { endpoint, container } = setup();
    const provider = container();
    endpoint.hold = true;
    const calls = [provider.issue(undefined, "read"), provider.issue(undefined, "read"), provider.issue(undefined, "write")];
    await vi.waitFor(() => expect(endpoint.requested).toBe(1));
    endpoint.hold = false;
    endpoint.release();
    const results = await Promise.all(calls);
    expect(new Set(results.map((result) => result.token)).size).toBe(1);
    expect(endpoint.presented).toEqual([REFRESH]);
  });

  it("lets only one of two containers refresh at a time; the other waits for its token", async () => {
    const { endpoint, lease, container } = setup({ rotate: true });
    const first = container();
    const second = container();
    endpoint.hold = true;
    const one = first.issue(undefined, "read");
    await vi.waitFor(() => expect(lease.holder()).toBeDefined());
    const two = second.issue(undefined, "read");
    await lease.firstRefusal;
    endpoint.hold = false;
    endpoint.release();
    const [a, b] = await Promise.all([one, two]);
    expect(a.token).toBe(b.token);
    expect(endpoint.presented).toEqual([REFRESH]);
    expect(lease.holder()).toBeUndefined();
  });

  it("retries once with a refresh token another container rotated and saved after this one read the secret", async () => {
    const { secrets, endpoint, container } = setup({ rotate: true });
    const original = secrets.values[SECRET]!;
    // Another container already spent REFRESH and saved the token that replaced it; this one read the secret first.
    await container().issue(undefined, "read");
    const saved = secrets.values[SECRET]!;
    let reads = 0;
    secrets.read = async () => (reads++ === 0 ? original : saved);
    const late = oauthRefreshTokenProvider({
      ref: "asana-bot", secretName: SECRET, secrets, tokens: memoryTokenCache(), lease: memoryLease({ now: Date.now }),
      tokenEndpoint: endpointUrl, fetchImplementation: endpoint.fetch,
    });
    const issued = await late.issue(undefined, "read");
    expect(issued.token).toBe(endpoint.accessTokens[1]);
    expect(endpoint.presented).toEqual([REFRESH, REFRESH, "refresh-token-rotated-1"]);
    expect((JSON.parse(secrets.values[SECRET]!) as { refreshToken: string }).refreshToken).toBe("refresh-token-rotated-2");
  });

  it("takes over the lease from a container that died holding it, within one call", async () => {
    const { lease, endpoint, container } = setup();
    expect(await lease.acquire("dead-container", REFRESH_LEASE_TTL_MS)).toBe(true);
    const issued = await container().issue(undefined, "read");
    expect(issued.token).toBe(endpoint.accessTokens[0]);
  });

  it("releases the lease after a failed refresh, so the next call can try", async () => {
    const { endpoint, lease, container } = setup();
    endpoint.fail = { status: 503, body: "" };
    const provider = container();
    await expect(provider.issue(undefined, "read")).rejects.toThrow("HTTP 503");
    expect(lease.holder()).toBeUndefined();
    endpoint.fail = undefined;
    expect((await provider.issue(undefined, "read")).token).toBe(endpoint.accessTokens[0]);
  });

  it("invalidate drops the cached access token so the next call refreshes, and keeps the refresh token", async () => {
    const { endpoint, tokens, secrets, container } = setup();
    const provider = container();
    await provider.issue(undefined, "read");
    await provider.invalidate!(undefined);
    expect(tokens.items.has(REFRESH_TOKEN_CACHE_KEY)).toBe(false);
    await provider.issue(undefined, "read");
    expect(endpoint.presented).toEqual([REFRESH, REFRESH]);
    expect((JSON.parse(secrets.values[SECRET]!) as { refreshToken: string }).refreshToken).toBe(REFRESH);
  });

  it("does not store an access token from a refresh that was in flight when invalidate ran", async () => {
    const { endpoint, tokens, container } = setup();
    const provider = container();
    endpoint.hold = true;
    const pending = provider.issue(undefined, "read");
    await vi.waitFor(() => expect(endpoint.requested).toBe(1));
    await provider.invalidate!(undefined);
    endpoint.hold = false;
    endpoint.release();
    await pending;
    expect(tokens.items.has(REFRESH_TOKEN_CACHE_KEY)).toBe(false);
  });
});
```

- [ ] **Step 4: Run and watch them fail**

Run: `npm run build && npx vitest run tests/contract/refresh-token-contracts.test.ts tests/contract/gateway-refresh-token.test.ts`
Expected: FAIL; `OAuthRefreshTokenSecretSchema`, `OAUTH_AUTHORIZATION_PROFILES` and
`oauthRefreshTokenProvider` are not exported, so the tests fail with "Cannot read properties of
undefined" and "is not a function".

- [ ] **Step 5: Add the contracts**

In `packages/contracts/src/credentials.ts`, replace the doc comment above `CredentialTypeSchema`:

```ts
/** Every provider type. github-app is built in; per-user is reserved for a later release. */
```

and insert, just above `export type CredentialType =`:

```ts
/**
 * An OAuth app's client and the refresh token a bot user's one-time sign-in produced
 * (`agentx admin credential authorize`). The broker writes a rotated refresh token back here.
 */
export const OAuthRefreshTokenSecretSchema = z.object({
  clientId: z.string().min(1).max(1_024),
  clientSecret: z.string().min(1).max(8_192),
  refreshToken: z.string().min(1).max(8_192),
}).strict();

/** The same secret before its first sign-in: `authorize` reads the client from it and adds the refresh token. */
export const OAuthAppSecretSchema = OAuthRefreshTokenSecretSchema.extend({ refreshToken: z.string().min(1).max(8_192).optional() });
```

and append after `export type OAuthClientCredentialsSecret = ...;`:

```ts
export type OAuthRefreshTokenSecret = z.infer<typeof OAuthRefreshTokenSecretSchema>;
export type OAuthAppSecret = z.infer<typeof OAuthAppSecretSchema>;
```

Create `packages/contracts/src/oauth-profiles.ts`:

```ts
/**
 * Where an administrator's browser signs a bot user in, per connector type, for
 * `agentx admin credential authorize`. The broker reads only `tokenUrl`, through the connector
 * type in the gateway. Values are the vendor's own and are the same for every organization; the
 * organization's app (its client ID and secret) lives in its own Secrets Manager secret.
 */
export interface OAuthAuthorizationProfile {
  /** The vendor's authorization endpoint. */
  readonly authorizeUrl: string;
  /** The vendor's token endpoint, for the code exchange and every refresh. */
  readonly tokenUrl: string;
  /** RFC 8707 resource indicator sent with the authorization request, when the vendor requires one. */
  readonly resource?: string;
  /** The redirect URI the administrator registers in the vendor app. The CLI listens on its port, on 127.0.0.1. */
  readonly redirectUri: string;
}

export const OAUTH_AUTHORIZATION_PROFILES = {
  asana: {
    authorizeUrl: "https://app.asana.com/-/oauth_authorize",
    tokenUrl: "https://app.asana.com/-/oauth_token",
    resource: "https://mcp.asana.com/v2/mcp",
    redirectUri: "http://localhost:8765/callback",
  },
} as const satisfies Record<string, OAuthAuthorizationProfile>;

export type OAuthProfileName = keyof typeof OAUTH_AUTHORIZATION_PROFILES;

/** The profile for a connector type, or undefined when that type has no browser sign-in. */
export function oauthProfile(name: string): OAuthAuthorizationProfile | undefined {
  return Object.hasOwn(OAUTH_AUTHORIZATION_PROFILES, name) ? OAUTH_AUTHORIZATION_PROFILES[name as OAuthProfileName] : undefined;
}
```

In `packages/contracts/src/index.ts`, add after `export * from "./github-mcp.js";`:

```ts
export * from "./oauth-profiles.js";
```

- [ ] **Step 6: Add the secret shape and the provider**

In `packages/gateway/src/credentials.ts`:

1. Replace the contracts import with:

```ts
import {
  OAuthClientCredentialsSecretSchema, OAuthRefreshTokenSecretSchema, StaticSecretSchema,
  type OAuthClientCredentialsSecret, type OAuthRefreshTokenSecret, type StaticSecret,
} from "@agentx/contracts";
```

2. Export `readLimitedText` (change `async function readLimitedText(` to
   `export async function readLimitedText(`) and add this last line to its doc comment:

```ts
 * @internal Shared with the refresh-token provider; not part of the gateway's public contract.
```

3. Add the third shape to `SECRET_SHAPES`:

```ts
  "oauth-refresh-token": { schema: OAuthRefreshTokenSecretSchema, shape: '{"clientId": "...", "clientSecret": "...", "refreshToken": "..."}' },
```

4. Replace the last two `parseConnectorSecret` signatures (the union overload and the
   implementation line) with:

```ts
export function parseConnectorSecret(type: "oauth-refresh-token", raw: string | undefined, ref: string, secretName: string): OAuthRefreshTokenSecret;
export function parseConnectorSecret(type: keyof typeof SECRET_SHAPES, raw: string | undefined, ref: string, secretName: string): StaticSecret | OAuthClientCredentialsSecret | OAuthRefreshTokenSecret;
export function parseConnectorSecret(type: keyof typeof SECRET_SHAPES, raw: string | undefined, ref: string, secretName: string): StaticSecret | OAuthClientCredentialsSecret | OAuthRefreshTokenSecret {
```

Create `packages/gateway/src/refresh-token.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { OAuthRefreshTokenSecret } from "@agentx/contracts";
import { CredentialUnavailable, parseConnectorSecret, readLimitedText, type CachedToken, type SecretSource, type TokenCache } from "./credentials.js";
import type { CredentialProvider } from "./types.js";
import { isObject } from "./util.js";

/** A secret source that can also replace a secret's value, for a rotated refresh token. */
export interface SecretStore extends SecretSource {
  /** Replaces the secret's value. A thrown error's message must never hold the value. */
  write(secretName: string, value: string): Promise<void>;
}

/** One refresh at a time per credential, across every broker container. */
export interface RefreshLease {
  /** Takes the lease for `ttlMs` unless another owner holds an unexpired one; false when it is held. */
  acquire(owner: string, ttlMs: number): Promise<boolean>;
  /** Gives the lease up if `owner` still holds it. */
  release(owner: string): Promise<void>;
}

/** The shared-cache key for a refresh-token credential's access token; one per credential reference. */
export const REFRESH_TOKEN_CACHE_KEY = "refresh-token";
/** Longer than one refresh can take: the 10 s token request plus two secret writes. */
export const REFRESH_LEASE_TTL_MS = 15_000;
/** Longer than the lease, so a waiter takes over from a holder that died, within one 20 s call. */
export const REFRESH_LEASE_WAIT_MS = 16_000;
const LEASE_POLL_MS = 250;
const REFRESH_MARGIN_MS = 300_000;
const DEFAULT_EXPIRES_IN_S = 3_600;
const TOKEN_TIMEOUT_MS = 10_000;
const MAX_TOKEN_RESPONSE = 65_536;

interface Refreshed { token: string; expiresAt: number; lifetimeMs: number; refreshToken?: string | undefined }

/**
 * Mints access tokens from a refresh token a bot user's one-time sign-in produced. The access
 * token is shared across containers through `tokens` and reused until five minutes (at most half
 * its lifetime) before expiry. Only the holder of `lease` refreshes; the others wait for its token.
 * A rotated refresh token is written back to the secret before its access token is used. A refused
 * refresh is CredentialUnavailable, which callers report as not connected; anything else is transient.
 */
export function oauthRefreshTokenProvider(options: {
  ref: string;
  secretName: string;
  secrets: SecretStore;
  tokens: TokenCache;
  lease: RefreshLease;
  tokenEndpoint: URL;
  fetchImplementation?: typeof fetch;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  /** Told the error class name when a rotated refresh token could not be saved; never the token. */
  onRotationUnsaved?: (errorName: string) => void;
}): CredentialProvider<unknown> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const owner = randomUUID();
  let memory: (CachedToken & { refreshAt: number }) | undefined;
  /** A rotated refresh token this container holds because saving it failed. It is newer than the secret's. */
  let unsaved: string | undefined;
  /** Bumped by invalidate() so a refresh already in flight cannot write a stale token back afterwards. */
  let generation = 0;
  let inFlight: Promise<CachedToken> | undefined;

  const storedUsable = (token: CachedToken | undefined): token is CachedToken => token !== undefined && token.expiresAt - REFRESH_MARGIN_MS > now();

  function remember(token: CachedToken, refreshAt: number, generationAtStart: number): CachedToken {
    if (generation === generationAtStart) memory = { ...token, refreshAt };
    return token;
  }

  async function readClient(): Promise<OAuthRefreshTokenSecret> {
    return parseConnectorSecret("oauth-refresh-token", await options.secrets.read(options.secretName), options.ref, options.secretName);
  }

  async function exchange(client: OAuthRefreshTokenSecret, refreshToken: string): Promise<Refreshed> {
    const response = await fetchImplementation(options.tokenEndpoint, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: client.clientId, client_secret: client.clientSecret }).toString(),
    });
    const text = await readLimitedText(response, MAX_TOKEN_RESPONSE);
    let body: unknown;
    try { body = JSON.parse(text); } catch { body = undefined; }
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      const code = isObject(body) && typeof body.error === "string" && /^[a-z_]{1,64}$/.test(body.error) ? ` (${body.error})` : "";
      throw new CredentialUnavailable(`credential ${options.ref}: the token endpoint refused the refresh token with HTTP ${response.status}${code}; the bot user must sign in again with agentx admin credential authorize --ref ${options.ref}`);
    }
    if (!response.ok) throw new Error(`token endpoint returned HTTP ${response.status}`);
    if (!isObject(body) || typeof body.access_token !== "string" || body.access_token.length === 0) throw new Error("token endpoint returned no access token");
    const seconds = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : DEFAULT_EXPIRES_IN_S;
    const rotated = typeof body.refresh_token === "string" && body.refresh_token.length > 0 ? body.refresh_token : undefined;
    return { token: body.access_token, expiresAt: now() + seconds * 1000, lifetimeMs: seconds * 1000, refreshToken: rotated };
  }

  /** Writes a rotated refresh token back, trying twice. On failure this container keeps it in memory. */
  async function saveRotated(client: OAuthRefreshTokenSecret, refreshToken: string): Promise<void> {
    const value = JSON.stringify({ clientId: client.clientId, clientSecret: client.clientSecret, refreshToken });
    let failure: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await options.secrets.write(options.secretName, value);
        unsaved = undefined;
        return;
      } catch (error) { failure = error; }
    }
    unsaved = refreshToken;
    options.onRotationUnsaved?.(failure instanceof Error ? failure.name : "unknown");
  }

  async function refreshUnderLease(generationAtStart: number): Promise<CachedToken> {
    const deadline = now() + REFRESH_LEASE_WAIT_MS;
    for (;;) {
      const stored = await options.tokens.get(REFRESH_TOKEN_CACHE_KEY);
      if (storedUsable(stored)) return remember(stored, stored.expiresAt - REFRESH_MARGIN_MS, generationAtStart);
      if (await options.lease.acquire(owner, REFRESH_LEASE_TTL_MS)) break;
      if (now() >= deadline) throw new Error("another AgentX process is still refreshing this credential; try again");
      await sleep(LEASE_POLL_MS);
    }
    try {
      // Another container may have refreshed between the read above and taking the lease.
      const stored = await options.tokens.get(REFRESH_TOKEN_CACHE_KEY);
      if (storedUsable(stored)) return remember(stored, stored.expiresAt - REFRESH_MARGIN_MS, generationAtStart);
      // Read under the lease, never from a cache, so a token another container rotated and saved is the one used.
      let client = await readClient();
      let current = unsaved ?? client.refreshToken;
      let refreshed: Refreshed;
      try {
        refreshed = await exchange(client, current);
      } catch (error) {
        if (!(error instanceof CredentialUnavailable)) throw error;
        // A container that outlived its lease may have rotated the token, and saved it, meanwhile.
        const latest = await options.tokens.get(REFRESH_TOKEN_CACHE_KEY);
        if (storedUsable(latest)) return remember(latest, latest.expiresAt - REFRESH_MARGIN_MS, generationAtStart);
        client = await readClient();
        if (client.refreshToken === current) throw error;
        current = client.refreshToken;
        unsaved = undefined;
        refreshed = await exchange(client, current);
      }
      if (refreshed.refreshToken !== undefined && refreshed.refreshToken !== current) await saveRotated(client, refreshed.refreshToken);
      const token: CachedToken = { token: refreshed.token, expiresAt: refreshed.expiresAt };
      if (generation === generationAtStart) {
        remember(token, refreshed.expiresAt - Math.min(REFRESH_MARGIN_MS, refreshed.lifetimeMs / 2), generationAtStart);
        await options.tokens.put(REFRESH_TOKEN_CACHE_KEY, token);
        // invalidate() may have run while the put was in flight; its delete may have landed first.
        if (generation !== generationAtStart) await options.tokens.delete(REFRESH_TOKEN_CACHE_KEY);
      }
      return token;
    } finally {
      await options.lease.release(owner).catch(() => undefined);
    }
  }

  return {
    async issue() {
      if (memory !== undefined && now() < memory.refreshAt) return { token: memory.token, bindings: {} };
      if (!inFlight) {
        const task = refreshUnderLease(generation);
        inFlight = task;
        // Only this call's own entry is cleared: invalidate() may already have replaced it.
        void task.finally(() => { if (inFlight === task) inFlight = undefined; }).catch(() => undefined);
      }
      const token = await inFlight;
      return { token: token.token, bindings: {} };
    },
    async invalidate() {
      generation += 1;
      memory = undefined;
      inFlight = undefined;
      await options.tokens.delete(REFRESH_TOKEN_CACHE_KEY);
    },
  };
}
```

In `packages/gateway/src/index.ts`, add after `export * from "./mcp-client.js";`:

```ts
export * from "./refresh-token.js";
```

- [ ] **Step 7: Run and watch them pass**

Run the Step 4 command. Expected: PASS (3 contract tests, 18 provider tests).

- [ ] **Step 8: Full check and commit**

```bash
npm run typecheck && npm run lint && npm run build && npm test
git add packages/contracts/src/credentials.ts packages/contracts/src/oauth-profiles.ts packages/contracts/src/index.ts \
  packages/gateway/src/credentials.ts packages/gateway/src/refresh-token.ts packages/gateway/src/index.ts \
  tests/support/refresh-token-fakes.ts tests/contract/refresh-token-contracts.test.ts tests/contract/gateway-refresh-token.test.ts
git commit -m "feat(gateway): add the oauth-refresh-token provider with a cross-container lease and rotation write-back

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Register `oauth-refresh-token` credentials in the broker

**Files:**
- Create: `tests/contract/refresh-token-registry.test.ts`, `tests/contract/refresh-token-infrastructure.test.ts`
- Modify: `packages/contracts/src/credentials.ts` (`RegistrableCredentialTypeSchema`),
  `packages/broker/src/aws/credentials.ts`, `infra/lib/control-plane.ts`,
  `tests/contract/refresh-token-contracts.test.ts` (append), `tests/contract/credential-contracts.test.ts`
  (named assertion 1)

**Interfaces:**
- Consumes: Task 2's `oauthRefreshTokenProvider`, `SecretStore`, `RefreshLease`, and the fakes.
- Produces:

```ts
// packages/broker/src/aws/credentials.ts
export interface ConnectorCredentialsConfiguration { secrets: SecretSource | SecretStore; githubApp: { ref: string; secretName: string }; fetchImplementation?: typeof fetch }
export function secretsManagerSource(client: { send(command: GetSecretValueCommand | PutSecretValueCommand): Promise<{ SecretString?: string; SecretBinary?: Uint8Array }> }): SecretStore;
export class DynamoRefreshLease implements RefreshLease {
  constructor(client: DynamoDBDocumentClient, tableName: string, ref: string, now?: () => number);
}
// CredentialRegistry.provider(ref, { tokenEndpoint }) now builds oauthRefreshTokenProvider for an
// oauth-refresh-token record; list() reports tokenCached for it.
```

- [ ] **Step 1: Write the failing tests**

Append to `tests/contract/refresh-token-contracts.test.ts`, and add `CredentialRegistrationSchema` to
its import list:

```ts
describe("oauth-refresh-token registration (phase 7)", () => {
  it("registers an oauth-refresh-token credential with a connector secret name", () => {
    expect(CredentialRegistrationSchema.parse({ ref: "asana-bot", type: "oauth-refresh-token", secretName: "agentx/connectors/asana-bot" }))
      .toEqual({ ref: "asana-bot", type: "oauth-refresh-token", secretName: "agentx/connectors/asana-bot" });
    expect(CredentialRegistrationSchema.safeParse({ ref: "asana-bot", type: "oauth-refresh-token", secretName: "prod/asana" }).success).toBe(false);
  });
});
```

Create `tests/contract/refresh-token-registry.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { PutSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { CredentialUnavailable } from "@agentx/gateway";
import { DynamoRefreshLease, secretsManagerSource } from "../../packages/broker/src/aws/credentials.js";
import { adminCall, createAdminBroker } from "../support/admin-broker.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { fakeTokenEndpoint, memorySecretStore } from "../support/refresh-token-fakes.js";

const githubApp = { ref: "github-app", secretName: "arn:aws:secretsmanager:us-east-1:111122223333:secret:github-key" };
const SECRET = "agentx/connectors/asana-bot";
const CLIENT = { clientId: "1210000000000001", clientSecret: "client-secret-value-0123456789" };
const REFRESH = "refresh-token-original-value";
const tokenEndpoint = new URL("https://auth.vendor.test/-/oauth_token");
const register = (handler: Parameters<typeof adminCall>[0], body: Record<string, unknown>) => adminCall(handler, { method: "POST", path: "/v1/admin/credentials", body });

describe("oauth-refresh-token in the credential registry", () => {
  it("registers a secret holding a refresh token and refuses one without, naming only the shape", async () => {
    const secrets = memorySecretStore({ [SECRET]: JSON.stringify({ ...CLIENT, refreshToken: REFRESH }), "agentx/connectors/asana-new": JSON.stringify(CLIENT) });
    const { handler } = await createAdminBroker({ connectorCredentials: { secrets, githubApp } });
    const registered = await register(handler, { ref: "asana-bot", type: "oauth-refresh-token", secretName: SECRET });
    expect(registered.status).toBe(201);
    expect(registered.body).toMatchObject({ credential: { ref: "asana-bot", type: "oauth-refresh-token", tokenCached: false } });
    const refused = await register(handler, { ref: "asana-new", type: "oauth-refresh-token", secretName: "agentx/connectors/asana-new" });
    expect(refused.body).toMatchObject({ error: { code: "CONFIG_INVALID", message: 'credential asana-new: secret agentx/connectors/asana-new must be JSON {"clientId": "...", "clientSecret": "...", "refreshToken": "..."}' } });
    expect(JSON.stringify([registered.body, refused.body])).not.toMatch(/client-secret-value|refresh-token-original/);
  });

  it("refreshes through the registry, shares the access token in DynamoDB, leaves no lease behind, and lists tokenCached", async () => {
    const secrets = memorySecretStore({ [SECRET]: JSON.stringify({ ...CLIENT, refreshToken: REFRESH }) });
    const endpoint = fakeTokenEndpoint({ ...CLIENT, refreshToken: REFRESH });
    const { db, handler, registry } = await createAdminBroker({ connectorCredentials: { secrets, githubApp, fetchImplementation: endpoint.fetch } });
    await register(handler, { ref: "asana-bot", type: "oauth-refresh-token", secretName: SECRET });
    const issued = await registry!.provider("asana-bot", { tokenEndpoint }).issue(undefined, "read");
    expect(issued).toEqual({ token: endpoint.accessTokens[0], bindings: {} });
    expect(db.get("CREDENTIAL#asana-bot", "TOKEN#refresh-token")).toMatchObject({ entityType: "CREDENTIAL_TOKEN", token: endpoint.accessTokens[0] });
    expect(db.get("CREDENTIAL#asana-bot", "LEASE#refresh")).toBeUndefined();
    const listed = await adminCall(handler, { method: "GET", path: "/v1/admin/credentials" });
    expect(listed.body.credentials).toContainEqual(expect.objectContaining({ ref: "asana-bot", type: "oauth-refresh-token", tokenCached: true }));
    expect(JSON.stringify(listed.body)).not.toContain(endpoint.accessTokens[0]);
  });

  it("needs a token endpoint from the connector type, and a store that can write", async () => {
    const secrets = memorySecretStore({ [SECRET]: JSON.stringify({ ...CLIENT, refreshToken: REFRESH }) });
    const { handler, registry } = await createAdminBroker({ connectorCredentials: { secrets, githubApp } });
    await register(handler, { ref: "asana-bot", type: "oauth-refresh-token", secretName: SECRET });
    await expect(registry!.provider("asana-bot").issue(undefined, "read")).rejects.toThrow(new CredentialUnavailable("credential asana-bot needs a token endpoint from its connector type"));

    const readOnly = { read: vi.fn(async (name: string) => secrets.values[name]) };
    const second = await createAdminBroker({ connectorCredentials: { secrets: readOnly, githubApp } });
    await register(second.handler, { ref: "asana-bot", type: "oauth-refresh-token", secretName: SECRET });
    await expect(second.registry!.provider("asana-bot", { tokenEndpoint }).issue(undefined, "read"))
      .rejects.toThrow(new CredentialUnavailable("credential asana-bot: this deployment cannot save a rotated refresh token"));
  });

  it("logs a rotated token it could not save by error name only", async () => {
    const secrets = memorySecretStore({ [SECRET]: JSON.stringify({ ...CLIENT, refreshToken: REFRESH }) });
    secrets.failWrites = 2;
    const endpoint = fakeTokenEndpoint({ ...CLIENT, refreshToken: REFRESH });
    endpoint.rotate = true;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const { handler, registry } = await createAdminBroker({ connectorCredentials: { secrets, githubApp, fetchImplementation: endpoint.fetch } });
      await register(handler, { ref: "asana-bot", type: "oauth-refresh-token", secretName: SECRET });
      await registry!.provider("asana-bot", { tokenEndpoint }).issue(undefined, "read");
      const lines = log.mock.calls.map(([line]) => String(line));
      expect(lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.event === "connector.refresh_token_unsaved"))
        .toEqual([{ component: "broker", event: "connector.refresh_token_unsaved", credential: "asana-bot", error: "AccessDeniedException" }]);
      expect(lines.join("\n")).not.toMatch(/refresh-token-rotated|refresh-token-original|access-token-|client-secret-value/);
    } finally { log.mockRestore(); }
  });
});

describe("DynamoRefreshLease", () => {
  it("grants one owner at a time, lets the owner renew, and hands over after expiry", async () => {
    const db = new FakeDynamoDb();
    let now = 1_000;
    const lease = new DynamoRefreshLease(db as never, "state", "asana-bot", () => now);
    expect(await lease.acquire("a", 15_000)).toBe(true);
    expect(await lease.acquire("b", 15_000)).toBe(false);
    expect(await lease.acquire("a", 15_000)).toBe(true);
    now += 15_001;
    expect(await lease.acquire("b", 15_000)).toBe(true);
    expect(db.get("CREDENTIAL#asana-bot", "LEASE#refresh")).toMatchObject({ entityType: "CREDENTIAL_LEASE", owner: "b" });
  });

  it("releases only the owner's own lease", async () => {
    const db = new FakeDynamoDb();
    const lease = new DynamoRefreshLease(db as never, "state", "asana-bot", () => 1_000);
    await lease.acquire("a", 15_000);
    await lease.release("b");
    expect(db.get("CREDENTIAL#asana-bot", "LEASE#refresh")).toMatchObject({ owner: "a" });
    await lease.release("a");
    expect(db.get("CREDENTIAL#asana-bot", "LEASE#refresh")).toBeUndefined();
  });

  it("treats a DynamoDB failure as acquired and logs only the error name", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const lease = new DynamoRefreshLease({ send: vi.fn(async () => { throw Object.assign(new Error("throttled detail"), { name: "ThrottlingException" }); }) } as never, "state", "asana-bot");
      expect(await lease.acquire("a", 15_000)).toBe(true);
      await expect(lease.release("a")).resolves.toBeUndefined();
      const lines = log.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
      expect(lines.map((line) => [line.event, line.operation, line.error])).toEqual([
        ["connector.refresh_lease_failed", "acquire", "ThrottlingException"],
        ["connector.refresh_lease_failed", "release", "ThrottlingException"],
      ]);
      expect(JSON.stringify(lines)).not.toContain("throttled detail");
    } finally { log.mockRestore(); }
  });
});

describe("Secrets Manager write", () => {
  it("replaces the secret value with PutSecretValue", async () => {
    const send = vi.fn<(command: unknown) => Promise<object>>(async () => ({}));
    await secretsManagerSource({ send }).write("agentx/connectors/asana-bot", "{\"refreshToken\":\"r\"}");
    const command = send.mock.calls[0]![0] as PutSecretValueCommand;
    expect(command).toBeInstanceOf(PutSecretValueCommand);
    expect(command.input).toEqual({ SecretId: "agentx/connectors/asana-bot", SecretString: "{\"refreshToken\":\"r\"}" });
  });
});
```

Create `tests/contract/refresh-token-infrastructure.test.ts`:

```ts
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";

interface Statement { Action: string | string[]; Resource: unknown; Condition?: unknown }

function statements(template: Template): Statement[] {
  return (Object.values(template.findResources("AWS::IAM::Policy")) as Array<{ Properties: { PolicyDocument: { Statement: Statement[] } } }>)
    .flatMap((policy) => policy.Properties.PolicyDocument.Statement);
}

describe("refresh-token write-back grant (phase 7)", () => {
  it("lets the broker replace only connector secrets tagged agentx-writable: refresh-token, and nothing else", () => {
    const template = Template.fromStack(new ControlPlaneStack(new App(), "RefreshTokenControlPlane"));
    const writes = statements(template).filter((statement) => [statement.Action].flat().some((action) => /^secretsmanager:(Put|Update|Create|Delete|Tag|Restore)/.test(action)));
    expect(writes).toHaveLength(1);
    expect([writes[0]!.Action].flat()).toEqual(["secretsmanager:PutSecretValue"]);
    expect(JSON.stringify(writes[0]!.Resource)).toContain("secret:agentx/connectors/*");
    expect(writes[0]!.Condition).toEqual({ StringEquals: { "secretsmanager:ResourceTag/agentx-writable": "refresh-token" } });
  });
});
```

In `tests/contract/credential-contracts.test.ts` (named assertion change 1), replace
`for (const type of ["github-app", "oauth-refresh-token", "per-user", "basic"]) {` with:

```ts
    for (const type of ["github-app", "per-user", "basic"]) {
```

- [ ] **Step 2: Run and watch them fail**

Run: `npm run build && npx vitest run tests/contract/refresh-token-contracts.test.ts tests/contract/refresh-token-registry.test.ts tests/contract/refresh-token-infrastructure.test.ts`
Expected: FAIL; the registration is refused ("invalid credential registration"),
`DynamoRefreshLease` is not exported, `secretsManagerSource(...).write` is not a function, and no
`PutSecretValue` statement exists.

- [ ] **Step 3: Make the type registrable**

In `packages/contracts/src/credentials.ts`:

```ts
export const RegistrableCredentialTypeSchema = z.enum(["static-secret", "oauth-client-credentials", "oauth-refresh-token"]);
```

- [ ] **Step 4: Teach the registry, the Secrets Manager source and the lease**

In `packages/broker/src/aws/credentials.ts`:

1. Imports:

```ts
import { GetSecretValueCommand, PutSecretValueCommand } from "@aws-sdk/client-secrets-manager";
```

and add `oauthRefreshTokenProvider`, `type RefreshLease` and `type SecretStore` to the
`@agentx/gateway` import list.

2. Replace the configuration interface's doc comment and `secrets` line:

```ts
/**
 * How a deployment reads connector secrets, and the built-in GitHub App entry it lists first. A
 * store that can also write is needed only by oauth-refresh-token credentials, to save a rotated token.
 */
export interface ConnectorCredentialsConfiguration {
  secrets: SecretSource | SecretStore;
```

3. After `const TOKEN_PREFIX = "TOKEN#";` add:

```ts
const LEASE_KEY = "LEASE#refresh";
```

4. Replace the head of `secretsManagerSource` (doc comment, signature and the opening of the
   returned object) so it also writes:

```ts
/**
 * Reads a Secrets Manager secret, and replaces one for a rotated refresh token. A missing secret is
 * `undefined`; an access denial names only the secret. The broker role may write only secrets the
 * administrator tagged `agentx-writable: refresh-token` (see infra/lib/control-plane.ts).
 */
export function secretsManagerSource(client: {
  send(command: GetSecretValueCommand | PutSecretValueCommand): Promise<{ SecretString?: string; SecretBinary?: Uint8Array }>;
}): SecretStore {
  return {
    async write(name, value) {
      await client.send(new PutSecretValueCommand({ SecretId: name, SecretString: value }));
    },
```

(The existing `async read(name) { ... }` follows unchanged.)

5. Insert, just above `/** Registered connector credentials: records name a secret, never hold one. */`:

```ts
/**
 * One refresh at a time per refresh-token credential across broker containers: a conditional put
 * on `CREDENTIAL#<ref>` / `LEASE#refresh`. A DynamoDB failure is logged (class name only) and
 * treated as acquired, so an outage cannot stop every refresh; the provider's re-read of the secret
 * after a refused refresh covers the race that allows.
 */
export class DynamoRefreshLease implements RefreshLease {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
    private readonly ref: string,
    private readonly now: () => number = Date.now,
  ) {}

  async acquire(owner: string, ttlMs: number): Promise<boolean> {
    try {
      await this.client.send(new PutCommand({
        TableName: this.tableName,
        Item: { pk: tokenPartition(this.ref), sk: LEASE_KEY, entityType: "CREDENTIAL_LEASE", owner, expiresAt: this.now() + ttlMs },
        ConditionExpression: "attribute_not_exists(pk) OR expiresAt < :now OR #owner = :owner",
        ExpressionAttributeNames: { "#owner": "owner" },
        ExpressionAttributeValues: { ":now": this.now(), ":owner": owner },
      }));
      return true;
    } catch (error) {
      if (error instanceof Error && error.name === "ConditionalCheckFailedException") return false;
      this.failed("acquire", error);
      return true;
    }
  }

  async release(owner: string): Promise<void> {
    try {
      await this.client.send(new DeleteCommand({
        TableName: this.tableName,
        Key: { pk: tokenPartition(this.ref), sk: LEASE_KEY },
        ConditionExpression: "#owner = :owner",
        ExpressionAttributeNames: { "#owner": "owner" },
        ExpressionAttributeValues: { ":owner": owner },
      }));
    } catch (error) {
      if (error instanceof Error && error.name === "ConditionalCheckFailedException") return;
      this.failed("release", error);
    }
  }

  private failed(operation: "acquire" | "release", error: unknown): void {
    const errorName = error instanceof Error ? error.name : "unknown";
    console.log(JSON.stringify({ component: "broker", event: "connector.refresh_lease_failed", credential: this.ref, operation, error: errorName }));
  }
}
```

6. In `list()`, report a cached token for refresh-token credentials too:

```ts
      if (record.type === "oauth-client-credentials" || record.type === "oauth-refresh-token") {
```

7. In `buildProvider`, after the `if (!tokenEndpoint) throw ...` line, insert:

```ts
    if (record.type === "oauth-refresh-token") {
      const secrets = this.options.secrets;
      if (!("write" in secrets)) throw new CredentialUnavailable(`credential ${record.ref}: this deployment cannot save a rotated refresh token`);
      return oauthRefreshTokenProvider({
        ...base,
        secrets,
        tokens: new DynamoTokenCache(this.documentClient, this.tableName, record.ref),
        lease: new DynamoRefreshLease(this.documentClient, this.tableName, record.ref, this.now),
        tokenEndpoint,
        onRotationUnsaved: (errorName) => {
          console.log(JSON.stringify({ component: "broker", event: "connector.refresh_token_unsaved", credential: record.ref, error: errorName }));
        },
        ...(this.options.fetchImplementation ? { fetchImplementation: this.options.fetchImplementation } : {}),
      });
    }
```

8. Replace the `validateSecret` doc comment's two lines with:

```ts
   * Proves the secret exists and has the type's shape. An OAuth secret is only read and parsed:
   * its token endpoint belongs to the connector type, so registration never mints or refreshes.
```

`packages/broker/src/aws/broker.ts` needs no edit: it already passes
`secretsManagerSource(secretsManager)` (a real `SecretsManagerClient`), which now also writes.

- [ ] **Step 5: Grant the tag-limited write**

In `infra/lib/control-plane.ts`, after the `GetSecretValue` statement on `agentx/connectors/*`:

```ts
    // A rotated OAuth refresh token is written back to its own secret. Only secrets that
    // `agentx admin credential authorize` tagged for it are writable, never other connector secrets.
    broker.addToRolePolicy(new iam.PolicyStatement({
      actions: ["secretsmanager:PutSecretValue"],
      resources: [this.formatArn({ service: "secretsmanager", resource: "secret", resourceName: "agentx/connectors/*", arnFormat: ArnFormat.COLON_RESOURCE_NAME })],
      conditions: { StringEquals: { "secretsmanager:ResourceTag/agentx-writable": "refresh-token" } },
    }));
```

- [ ] **Step 6: Run and watch them pass**

Run the Step 2 command, then `npx vitest run tests/contract/credential-registry.test.ts tests/contract/credential-contracts.test.ts tests/contract/infrastructure.test.ts tests/contract/refresh-token-characterization.test.ts`.
Expected: PASS.

- [ ] **Step 7: Full check, synthesis and commit**

```bash
npm run typecheck && npm run lint && npm run build && npm test && npm run infra:synth
git add packages/contracts/src/credentials.ts packages/broker/src/aws/credentials.ts infra/lib/control-plane.ts \
  tests/contract/refresh-token-contracts.test.ts tests/contract/refresh-token-registry.test.ts \
  tests/contract/refresh-token-infrastructure.test.ts tests/contract/credential-contracts.test.ts
git commit -m "feat(broker): register oauth-refresh-token credentials with a DynamoDB refresh lease and tag-limited write-back

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `agentx admin credential authorize`

**Files:**
- Create: `packages/cli/src/admin/authorize.ts`, `tests/contract/credential-authorize.test.ts`
- Modify: `packages/cli/src/main.ts`, `packages/cli/src/auth.ts` (export `openSystemBrowser`),
  `packages/cli/package.json`, `package-lock.json`, `tests/contract/cli-main.test.ts` (named assertion 3)

**Interfaces:**
- Consumes: `createPkceParameters()` (`packages/cli/src/auth.ts`, unchanged), `registerCredential`
  (`packages/cli/src/admin/credential.ts`, unchanged), Task 2's `OAuthAppSecretSchema`,
  `OAUTH_AUTHORIZATION_PROFILES`, `oauthProfile`, Task 3's registrable type.
- Produces:

```ts
// packages/cli/src/admin/authorize.ts
export const WRITABLE_TAG: { Key: "agentx-writable"; Value: "refresh-token" };
export interface AuthorizeSecrets { read(secretName: string): Promise<string | undefined>; write(secretName: string, value: string): Promise<void>; tag(secretName: string): Promise<void> }
export interface AuthorizeInput {
  controlPlaneUrl: string; accessToken: string; ref: string; secretName: string; provider: string;
  secrets: AuthorizeSecrets; openBrowser: (url: string) => Promise<void>; showUrl: (url: string) => void;
  fetchImplementation?: typeof fetch; timeoutMilliseconds?: number; listenPort?: number; onListening?: (port: number) => void;
}
export function secretsManagerAuthorizeSecrets(client: Pick<SecretsManagerClient, "send">): AuthorizeSecrets;
export function authorizeCredential(input: AuthorizeInput): Promise<unknown>; // the control plane's registration response
// packages/cli/src/auth.ts
export async function openSystemBrowser(url: string): Promise<void>; // was module-private
// packages/cli/src/main.ts
export interface CliDependencies { /* ... */ authorize?: { secrets?: AuthorizeSecrets; openBrowser?: (url: string) => Promise<void>; listenPort?: number; onListening?: (port: number) => void } }
```

- [ ] **Step 1: Add the dependency**

In `packages/cli/package.json`, add to `dependencies` (keep the keys sorted):

```json
    "@aws-sdk/client-secrets-manager": "3.1134.0",
```

Run: `npm install --ignore-scripts`
Expected: `package-lock.json` changes by one line (the CLI workspace's dependency entry); no new
package is downloaded.

- [ ] **Step 2: Write the failing tests**

```ts
// tests/contract/credential-authorize.test.ts
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GetSecretValueCommand, PutSecretValueCommand, TagResourceCommand } from "@aws-sdk/client-secrets-manager";
import { describe, expect, it, vi } from "vitest";
import { authorizeCredential, secretsManagerAuthorizeSecrets, type AuthorizeSecrets } from "../../packages/cli/src/admin/authorize.js";
import { tokenStoreKey } from "../../packages/cli/src/auth.js";
import { executeCli } from "../../packages/cli/src/main.js";
import { InMemoryTokenStore } from "../../packages/cli/src/token-store.js";

const SECRET = "agentx/connectors/asana-bot";
const CLIENT = { clientId: "1210000000000001", clientSecret: "client-secret-value-0123456789" };
const REFRESH = "refresh-token-from-sign-in";
const ACCESS = "access-token-from-sign-in";
const CODE = "authorization-code-value";
const CONTROL_PLANE = "https://agentx.example.test";

function secretsWith(value: string | undefined): AuthorizeSecrets & { writes: Array<[string, string]>; tags: string[] } {
  const store = {
    writes: [] as Array<[string, string]>,
    tags: [] as string[],
    read: vi.fn(async () => value),
    write: vi.fn(async (name: string, next: string) => { store.writes.push([name, next]); }),
    tag: vi.fn(async (name: string) => { store.tags.push(name); }),
  };
  return store;
}

/** The vendor's token endpoint and the control plane, behind one fetch. */
function vendorAndControlPlane(options: { tokenStatus?: number; tokenBody?: Record<string, unknown> } = {}) {
  const exchanges: Array<Record<string, string>> = [];
  const registrations: unknown[] = [];
  const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
    const href = url instanceof URL ? url.href : typeof url === "string" ? url : url.url;
    if (href === "https://app.asana.com/-/oauth_token") {
      expect(init).toMatchObject({ method: "POST", redirect: "error" });
      exchanges.push(Object.fromEntries(new URLSearchParams(init?.body as string)));
      return Response.json(options.tokenBody ?? { access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600, token_type: "bearer" }, { status: options.tokenStatus ?? 200 });
    }
    if (href === `${CONTROL_PLANE}/v1/admin/credentials`) {
      registrations.push(JSON.parse(init?.body as string));
      return Response.json({ credential: { ref: "asana-bot", type: "oauth-refresh-token", builtIn: false, tokenCached: false }, replaced: false }, { status: 201 });
    }
    throw new Error(`unexpected fetch ${href}`);
  });
  return { fetchImplementation, exchanges, registrations };
}

/** Plays the browser: reads the authorize URL, then calls the local listener with the given query. */
function browser(query: (authorize: URL) => Record<string, string>[]) {
  let port = 0;
  const seen: URL[] = [];
  const answers: number[] = [];
  return {
    seen, answers,
    onListening: (bound: number) => { port = bound; },
    openBrowser: async (url: string) => {
      const authorize = new URL(url);
      seen.push(authorize);
      for (const params of query(authorize)) {
        const response = await fetch(`http://127.0.0.1:${port}/callback?${new URLSearchParams(params).toString()}`);
        answers.push(response.status);
        await response.text();
      }
    },
  };
}

const base = (secrets: AuthorizeSecrets, fetchImplementation: typeof fetch, play: ReturnType<typeof browser>) => ({
  controlPlaneUrl: CONTROL_PLANE, accessToken: "admin-token", ref: "asana-bot", secretName: SECRET, provider: "asana",
  secrets, fetchImplementation, openBrowser: play.openBrowser, onListening: play.onListening, listenPort: 0, showUrl: () => undefined,
});

describe("agentx admin credential authorize", () => {
  it("signs in with PKCE S256 and a state, stores the refresh token beside the client, tags the secret and registers it", async () => {
    const secrets = secretsWith(JSON.stringify(CLIENT));
    const { fetchImplementation, exchanges, registrations } = vendorAndControlPlane();
    const play = browser((authorize) => [{ code: CODE, state: authorize.searchParams.get("state")! }]);
    const result = await authorizeCredential(base(secrets, fetchImplementation, play));

    const authorize = play.seen[0]!;
    expect(`${authorize.origin}${authorize.pathname}`).toBe("https://app.asana.com/-/oauth_authorize");
    expect(Object.fromEntries(authorize.searchParams)).toEqual({
      response_type: "code", client_id: CLIENT.clientId, redirect_uri: "http://localhost:8765/callback",
      state: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/) as unknown, code_challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) as unknown,
      code_challenge_method: "S256", resource: "https://mcp.asana.com/v2/mcp",
    });
    expect(exchanges).toHaveLength(1);
    const exchange = exchanges[0]!;
    expect(exchange).toMatchObject({ grant_type: "authorization_code", code: CODE, redirect_uri: "http://localhost:8765/callback", client_id: CLIENT.clientId, client_secret: CLIENT.clientSecret });
    expect(createHash("sha256").update(exchange.code_verifier!).digest("base64url")).toBe(authorize.searchParams.get("code_challenge"));
    expect(secrets.writes).toEqual([[SECRET, JSON.stringify({ ...CLIENT, refreshToken: REFRESH })]]);
    expect(secrets.tags).toEqual([SECRET]);
    expect(registrations).toEqual([{ ref: "asana-bot", type: "oauth-refresh-token", secretName: SECRET }]);
    expect(JSON.stringify(result)).not.toMatch(new RegExp(`${REFRESH}|${ACCESS}|${CODE}|${CLIENT.clientSecret}`));
  });

  it("ignores a redirect with the wrong state, then accepts the right one", async () => {
    const secrets = secretsWith(JSON.stringify(CLIENT));
    const { fetchImplementation, exchanges } = vendorAndControlPlane();
    const play = browser((authorize) => [
      { code: "attacker-code", state: "not-the-state" },
      { code: "attacker-code" },
      { code: CODE, state: authorize.searchParams.get("state")! },
    ]);
    await authorizeCredential(base(secrets, fetchImplementation, play));
    expect(play.answers).toEqual([400, 400, 200]);
    expect(exchanges.map((entry) => entry.code)).toEqual([CODE]);
  });

  it("stops without storing anything when the sign-in is refused", async () => {
    const secrets = secretsWith(JSON.stringify(CLIENT));
    const { fetchImplementation, exchanges, registrations } = vendorAndControlPlane();
    const play = browser((authorize) => [{ error: "access_denied", state: authorize.searchParams.get("state")! }]);
    await expect(authorizeCredential(base(secrets, fetchImplementation, play))).rejects.toMatchObject({ code: "AUTH_REQUIRED", message: expect.stringContaining("refused or cancelled (access_denied); nothing was stored") as unknown });
    expect([exchanges, secrets.writes, registrations]).toEqual([[], [], []]);
  });

  it("times out when no sign-in arrives", async () => {
    const secrets = secretsWith(JSON.stringify(CLIENT));
    const { fetchImplementation } = vendorAndControlPlane();
    const play = browser(() => []);
    await expect(authorizeCredential({ ...base(secrets, fetchImplementation, play), timeoutMilliseconds: 50 })).rejects.toMatchObject({ code: "AUTH_REQUIRED", message: expect.stringContaining("no sign-in arrived") as unknown });
    expect(secrets.writes).toEqual([]);
  });

  it("reports a refused code exchange by its OAuth error code only, and stores nothing", async () => {
    const secrets = secretsWith(JSON.stringify(CLIENT));
    const { fetchImplementation, registrations } = vendorAndControlPlane({ tokenStatus: 400, tokenBody: { error: "invalid_grant", error_description: `bad code ${CODE}` } });
    const play = browser((authorize) => [{ code: CODE, state: authorize.searchParams.get("state")! }]);
    const failure = await authorizeCredential(base(secrets, fetchImplementation, play)).catch((error: unknown) => error) as Error;
    expect(failure.message).toContain("the token endpoint refused the sign-in with HTTP 400 (invalid_grant); nothing was stored");
    expect(failure.message).not.toContain(CODE);
    expect([secrets.writes, registrations]).toEqual([[], []]);
  });

  it("refuses a sign-in that returns no refresh token", async () => {
    const secrets = secretsWith(JSON.stringify(CLIENT));
    const { fetchImplementation } = vendorAndControlPlane({ tokenBody: { access_token: ACCESS, expires_in: 3600 } });
    const play = browser((authorize) => [{ code: CODE, state: authorize.searchParams.get("state")! }]);
    await expect(authorizeCredential(base(secrets, fetchImplementation, play))).rejects.toThrow("returned no refresh token");
    expect(secrets.writes).toEqual([]);
  });

  it("checks the provider and the secret before opening a browser", async () => {
    const { fetchImplementation } = vendorAndControlPlane();
    const play = browser(() => []);
    await expect(authorizeCredential({ ...base(secretsWith(JSON.stringify(CLIENT)), fetchImplementation, play), provider: "linear" }))
      .rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("no browser sign-in for provider linear; known providers: asana") as unknown });
    await expect(authorizeCredential(base(secretsWith(undefined), fetchImplementation, play)))
      .rejects.toMatchObject({ message: expect.stringContaining(`secret ${SECRET} was not found; create it as JSON {"clientId": "...", "clientSecret": "..."} first`) as unknown });
    const leaky = secretsWith(JSON.stringify({ apiKey: "leaky-secret-value" }));
    const malformed = await authorizeCredential(base(leaky, fetchImplementation, play)).catch((error: unknown) => error) as Error;
    expect(malformed.message).toContain(`secret ${SECRET} must be JSON`);
    expect(malformed.message).not.toContain("leaky-secret-value");
    await expect(authorizeCredential({ ...base(secretsWith(JSON.stringify(CLIENT)), fetchImplementation, play), secretName: "prod/asana" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(play.seen).toEqual([]);
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("reads, writes and tags the secret through Secrets Manager", async () => {
    const send = vi.fn(async (command: unknown) => (command instanceof GetSecretValueCommand ? { SecretString: "{}" } : {}));
    const secrets = secretsManagerAuthorizeSecrets({ send } as never);
    expect(await secrets.read(SECRET)).toBe("{}");
    await secrets.write(SECRET, "value");
    await secrets.tag(SECRET);
    const [read, write, tag] = send.mock.calls.map(([command]) => command as { input: unknown });
    expect(read).toBeInstanceOf(GetSecretValueCommand);
    expect(write).toBeInstanceOf(PutSecretValueCommand);
    expect(write!.input).toEqual({ SecretId: SECRET, SecretString: "value" });
    expect(tag).toBeInstanceOf(TagResourceCommand);
    expect(tag!.input).toEqual({ SecretId: SECRET, Tags: [{ Key: "agentx-writable", Value: "refresh-token" }] });
    const missing = secretsManagerAuthorizeSecrets({ send: vi.fn(async () => { throw Object.assign(new Error("nope"), { name: "ResourceNotFoundException" }); }) } as never);
    expect(await missing.read(SECRET)).toBeUndefined();
  });

  it("runs from the command line, printing the sign-in URL and the result but never a token, the code or the client secret", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentx-authorize-"));
    const deploymentFile = join(directory, "deployment.yaml");
    await writeFile(deploymentFile, `controlPlaneUrl: ${CONTROL_PLANE}\nauth:\n  issuer: https://identity.example.test\n  clientId: cli\n  audience: agentx\n`);
    const tokenStore = new InMemoryTokenStore();
    await tokenStore.set(tokenStoreKey({ issuer: "https://identity.example.test", clientId: "cli", audience: "agentx" }), { accessToken: "admin-token", expiresAt: Date.now() + 3_600_000 });
    const secrets = secretsWith(JSON.stringify(CLIENT));
    const { fetchImplementation, registrations } = vendorAndControlPlane();
    const play = browser((authorize) => [{ code: CODE, state: authorize.searchParams.get("state")! }]);
    let stdout = "";
    let stderr = "";
    const exitCode = await executeCli(
      ["--deployment-file", deploymentFile, "admin", "credential", "authorize", "--ref", "asana-bot", "--secret", SECRET, "--provider", "asana"],
      {
        fetchImplementation, tokenStore,
        stdout: { write: (text: string) => { stdout += text; } }, stderr: { write: (text: string) => { stderr += text; } },
        authorize: { secrets, openBrowser: play.openBrowser, listenPort: 0, onListening: play.onListening },
      },
    );
    expect(exitCode).toBe(0);
    expect(registrations).toHaveLength(1);
    expect(stderr).toContain("https://app.asana.com/-/oauth_authorize?");
    expect(stderr).toContain(`Stored the refresh token in ${SECRET} and registered asana-bot as oauth-refresh-token.`);
    expect(JSON.parse(stdout)).toMatchObject({ credential: { ref: "asana-bot", type: "oauth-refresh-token" } });
    expect(`${stdout}${stderr}`).not.toMatch(new RegExp(`${REFRESH}|${ACCESS}|${CODE}|${CLIENT.clientSecret}`));
  });
});
```

In `tests/contract/cli-main.test.ts` (named assertion change 3):

```ts
    expect(subcommands(admin, "credential")).toEqual(["register", "authorize", "list"]);
```

- [ ] **Step 3: Run and watch them fail**

Run: `npm run build && npx vitest run tests/contract/credential-authorize.test.ts tests/contract/cli-main.test.ts`
Expected: FAIL; `packages/cli/src/admin/authorize.js` does not exist and the command list lacks
`authorize`.

- [ ] **Step 4: Implement the command**

Create `packages/cli/src/admin/authorize.ts`:

```ts
import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import {
  GetSecretValueCommand, PutSecretValueCommand, TagResourceCommand, type SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import {
  CredentialRegistrationSchema, OAUTH_AUTHORIZATION_PROFILES, OAuthAppSecretSchema, agentXError, oauthProfile,
} from "@agentx/contracts";
import { createPkceParameters } from "../auth.js";
import { registerCredential } from "./credential.js";

/** The tag the broker role's PutSecretValue grant requires (infra/lib/control-plane.ts). */
export const WRITABLE_TAG = { Key: "agentx-writable", Value: "refresh-token" } as const;
const SIGN_IN_TIMEOUT_MS = 300_000;
const TOKEN_TIMEOUT_MS = 10_000;
const APP_SECRET_SHAPE = '{"clientId": "...", "clientSecret": "..."}';

/** What `authorize` needs from Secrets Manager, with the administrator's own AWS credentials. */
export interface AuthorizeSecrets {
  /** The secret's value, or undefined when it does not exist. */
  read(secretName: string): Promise<string | undefined>;
  write(secretName: string, value: string): Promise<void>;
  /** Tags the secret so the broker may write a rotated refresh token back to it. */
  tag(secretName: string): Promise<void>;
}

export interface AuthorizeInput {
  controlPlaneUrl: string;
  accessToken: string;
  ref: string;
  secretName: string;
  /** A key of OAUTH_AUTHORIZATION_PROFILES, such as "asana". */
  provider: string;
  secrets: AuthorizeSecrets;
  openBrowser: (url: string) => Promise<void>;
  /** Told the sign-in URL, so an administrator without a local browser can open it elsewhere. */
  showUrl: (url: string) => void;
  fetchImplementation?: typeof fetch;
  timeoutMilliseconds?: number;
  /** Tests only: listen on this port instead of the redirect URI's, and report the port bound. */
  listenPort?: number;
  onListening?: (port: number) => void;
}

/** Reads, writes and tags secrets with the administrator's AWS credentials. */
export function secretsManagerAuthorizeSecrets(client: Pick<SecretsManagerClient, "send">): AuthorizeSecrets {
  return {
    async read(secretName) {
      try {
        const response = await client.send(new GetSecretValueCommand({ SecretId: secretName }));
        return response.SecretString;
      } catch (error) {
        if (error instanceof Error && error.name === "ResourceNotFoundException") return undefined;
        throw agentXError("CONFIG_INVALID", `could not read secret ${secretName} with your AWS credentials (${error instanceof Error ? error.name : "unknown error"})`);
      }
    },
    async write(secretName, value) {
      await client.send(new PutSecretValueCommand({ SecretId: secretName, SecretString: value }));
    },
    async tag(secretName) {
      await client.send(new TagResourceCommand({ SecretId: secretName, Tags: [{ ...WRITABLE_TAG }] }));
    },
  };
}

/**
 * Signs a bot user in once through the browser (authorization code with PKCE S256 and a random
 * state), stores the refresh token in the credential's secret beside the app's client, tags the
 * secret for write-back, and registers it as oauth-refresh-token. Never prints or returns a token,
 * the authorization code or the client secret.
 */
export async function authorizeCredential(input: AuthorizeInput): Promise<unknown> {
  const registration = CredentialRegistrationSchema.safeParse({ ref: input.ref, type: "oauth-refresh-token", secretName: input.secretName });
  if (!registration.success) throw agentXError("CONFIG_INVALID", `invalid credential registration: ${registration.error.issues[0]?.message}`);
  const profile = oauthProfile(input.provider);
  if (!profile) throw agentXError("CONFIG_INVALID", `no browser sign-in for provider ${input.provider}; known providers: ${Object.keys(OAUTH_AUTHORIZATION_PROFILES).join(", ")}`);

  const raw = await input.secrets.read(input.secretName);
  if (raw === undefined) throw agentXError("CONFIG_INVALID", `secret ${input.secretName} was not found; create it as JSON ${APP_SECRET_SHAPE} first`);
  let json: unknown;
  try { json = JSON.parse(raw); } catch { json = undefined; }
  const app = OAuthAppSecretSchema.safeParse(json);
  if (!app.success) throw agentXError("CONFIG_INVALID", `secret ${input.secretName} must be JSON ${APP_SECRET_SHAPE}`);
  const { clientId, clientSecret } = app.data;

  const pkce = createPkceParameters();
  const callback = await listenForCallback({
    redirectUri: new URL(profile.redirectUri),
    state: pkce.state,
    timeoutMilliseconds: input.timeoutMilliseconds ?? SIGN_IN_TIMEOUT_MS,
    ...(input.listenPort === undefined ? {} : { port: input.listenPort }),
  });
  let code: string;
  try {
    input.onListening?.(callback.port);
    const authorize = new URL(profile.authorizeUrl);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("client_id", clientId);
    authorize.searchParams.set("redirect_uri", profile.redirectUri);
    authorize.searchParams.set("state", pkce.state);
    authorize.searchParams.set("code_challenge", pkce.challenge);
    authorize.searchParams.set("code_challenge_method", "S256");
    if (profile.resource !== undefined) authorize.searchParams.set("resource", profile.resource);
    input.showUrl(authorize.href);
    // The printed URL still works when no browser can be opened here.
    await input.openBrowser(authorize.href).catch(() => undefined);
    code = await callback.code;
  } finally {
    callback.close();
  }

  const refreshToken = await exchangeCode({
    tokenUrl: new URL(profile.tokenUrl), code, verifier: pkce.verifier, redirectUri: profile.redirectUri, clientId, clientSecret,
    fetchImplementation: input.fetchImplementation ?? fetch,
  });
  await input.secrets.write(input.secretName, JSON.stringify({ clientId, clientSecret, refreshToken }));
  await input.secrets.tag(input.secretName);
  return registerCredential({ controlPlaneUrl: input.controlPlaneUrl, accessToken: input.accessToken, ref: input.ref, type: "oauth-refresh-token", secretName: input.secretName }, input.fetchImplementation);
}

async function exchangeCode(input: {
  tokenUrl: URL; code: string; verifier: string; redirectUri: string; clientId: string; clientSecret: string; fetchImplementation: typeof fetch;
}): Promise<string> {
  const response = await input.fetchImplementation(input.tokenUrl, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code", code: input.code, redirect_uri: input.redirectUri, code_verifier: input.verifier,
      client_id: input.clientId, client_secret: input.clientSecret,
    }).toString(),
  });
  let body: unknown;
  try { body = await response.json(); } catch { body = undefined; }
  const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
  if (!response.ok) {
    const code = typeof record.error === "string" && /^[a-z_]{1,64}$/.test(record.error) ? ` (${record.error})` : "";
    throw agentXError("AUTH_REQUIRED", `the token endpoint refused the sign-in with HTTP ${response.status}${code}; nothing was stored`);
  }
  if (typeof record.refresh_token !== "string" || record.refresh_token.length === 0) {
    throw agentXError("AUTH_REQUIRED", "the token endpoint returned no refresh token, so AgentX could not stay signed in; check the app type in the setup guide. Nothing was stored");
  }
  return record.refresh_token;
}

/**
 * Waits for one browser redirect carrying the expected state. A request with any other state is
 * answered and ignored, so a stale tab or another page cannot end or take over the sign-in. Binds
 * 127.0.0.1 only. Rejects on an `error` redirect with the right state, or after the timeout.
 */
async function listenForCallback(options: { redirectUri: URL; state: string; timeoutMilliseconds: number; port?: number }): Promise<{ port: number; code: Promise<string>; close: () => void }> {
  const { redirectUri } = options;
  if (redirectUri.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(redirectUri.hostname) || redirectUri.port === "") {
    throw agentXError("CONFIG_INVALID", "the provider's redirect URI must be http://localhost:<port>/<path>");
  }
  const expected = Buffer.from(options.state);
  const matches = (state: string | null) => {
    if (state === null) return false;
    const given = Buffer.from(state);
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
  let settled = false;
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const code = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  // The redirect can arrive while the browser is still being opened, before anyone awaits `code`.
  code.catch(() => undefined);
  const finish = (outcome: { code: string } | { error: Error }) => {
    if (settled) return;
    settled = true;
    if ("code" in outcome) resolveCode(outcome.code); else rejectCode(outcome.error);
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET" || url.pathname !== redirectUri.pathname) { response.writeHead(404).end(); return; }
    if (settled) { response.writeHead(410, { "content-type": "text/plain" }).end("This sign-in has already finished. You can close this tab."); return; }
    if (!matches(url.searchParams.get("state"))) {
      response.writeHead(400, { "content-type": "text/plain" }).end("This sign-in link is not the one AgentX is waiting for. Use the link the command printed.");
      return;
    }
    const error = url.searchParams.get("error");
    const authorizationCode = url.searchParams.get("code");
    if (error !== null || !authorizationCode) {
      response.writeHead(200, { "content-type": "text/plain" }).end("Sign-in was not completed. You can close this tab and run the command again.");
      const shown = error !== null && /^[a-z_]{1,64}$/.test(error) ? ` (${error})` : "";
      finish({ error: agentXError("AUTH_REQUIRED", `the sign-in was refused or cancelled${shown}; nothing was stored`) });
      return;
    }
    response.writeHead(200, { "content-type": "text/plain" }).end("AgentX received the sign-in. You can close this tab.");
    finish({ code: authorizationCode });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      reject(error.code === "EADDRINUSE"
        ? agentXError("CONFIG_INVALID", `port ${redirectUri.port} is in use; stop whatever is listening on it and run the command again`)
        : error);
    });
    server.listen(options.port ?? Number(redirectUri.port), "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("sign-in listener did not bind TCP");
  const timer = setTimeout(() => finish({ error: agentXError("AUTH_REQUIRED", `no sign-in arrived within ${Math.round(options.timeoutMilliseconds / 1000)} seconds; nothing was stored`) }), options.timeoutMilliseconds);
  timer.unref();
  return {
    port: address.port,
    code,
    close: () => { clearTimeout(timer); server.closeAllConnections(); server.close(); },
  };
}
```

In `packages/cli/src/auth.ts`, export the existing browser opener (no other change):

```ts
export async function openSystemBrowser(url: string): Promise<void> {
```

In `packages/cli/src/main.ts`:

1. Imports (replace the `./auth.js` import; add the two new lines above the `./admin/credential.js`
   import and after `commander`'s):

```ts
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { Command } from "commander";
import { authorizeCredential, secretsManagerAuthorizeSecrets, type AuthorizeSecrets } from "./admin/authorize.js";
import { listCredentials, registerCredential } from "./admin/credential.js";
```

```ts
import { loginWithPkce, openSystemBrowser, tokenStoreKey } from "./auth.js";
```

2. Add to `CliDependencies`:

```ts
  /** `admin credential authorize` overrides, for tests. */
  authorize?: {
    secrets?: AuthorizeSecrets;
    openBrowser?: (url: string) => Promise<void>;
    listenPort?: number;
    onListening?: (port: number) => void;
  };
```

3. In `admin credential register`, change the `--type` help to
   `"static-secret, oauth-client-credentials or oauth-refresh-token"`.

4. Insert the new command between `register` and `list`:

```ts
  adminCredential
    .command("authorize")
    .description("sign the connector's bot user in once in a browser, store its refresh token in the secret, and register it as oauth-refresh-token")
    .requiredOption("--ref <reference>", "credential reference used by connectors' credentialRef")
    .requiredOption("--secret <name>", "Secrets Manager secret holding the app's {\"clientId\", \"clientSecret\"}, agentx/connectors/<name>")
    .requiredOption("--provider <name>", "whose sign-in page to use: asana")
    .option("--region <region>", "AWS region of the secret; defaults to your AWS configuration")
    .action(async (options: { ref: string; secret: string; provider: string; region?: string }, command: Command) => {
      const globals = globalOptions(command);
      const { settings, accessToken } = await authenticate(globals, services.tokenStore);
      const overrides = dependencies.authorize ?? {};
      const result = await authorizeCredential({
        controlPlaneUrl: settings.controlPlaneUrl,
        accessToken,
        ref: options.ref,
        secretName: options.secret,
        provider: options.provider,
        secrets: overrides.secrets ?? secretsManagerAuthorizeSecrets(new SecretsManagerClient(options.region ? { region: options.region } : {})),
        openBrowser: overrides.openBrowser ?? openSystemBrowser,
        showUrl: (url) => { services.stderr.write(`Sign in as the connector's bot user. If no browser opened, open this URL:\n${url}\n`); },
        fetchImplementation: services.fetchImplementation,
        ...(overrides.listenPort === undefined ? {} : { listenPort: overrides.listenPort }),
        ...(overrides.onListening ? { onListening: overrides.onListening } : {}),
      });
      services.stderr.write(`Stored the refresh token in ${options.secret} and registered ${options.ref} as oauth-refresh-token.\n`);
      services.stdout.write(formatSuccess(result, globals.json));
    });
```

- [ ] **Step 5: Run and watch them pass**

Run the Step 3 command. Expected: PASS (9 authorize tests; the CLI surface test).

- [ ] **Step 6: Full check and commit**

```bash
npm run typecheck && npm run lint && npm run build && npm test
git add packages/cli/src/admin/authorize.ts packages/cli/src/main.ts packages/cli/src/auth.ts packages/cli/package.json package-lock.json \
  tests/contract/credential-authorize.test.ts tests/contract/cli-main.test.ts
git commit -m "feat(cli): add agentx admin credential authorize for a one-time bot-user sign-in

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: The Asana connector definition in the gateway: binder and project guard

**Files:**
- Create: `packages/gateway/src/asana.ts`, `tests/fixtures/vendors/asana-get-task.json`,
  `tests/contract/gateway-asana.test.ts`
- Modify: `packages/contracts/src/connectors.ts` (only `ASANA_PROJECT_TOOL_ACCESS`; the schema
  comes in Task 6), `packages/gateway/src/index.ts`, `tests/support/vendor-fixtures.ts`
- Already on the branch: `tests/fixtures/vendors/asana-tools.json` (Ruling 16)

**Interfaces:**
- Consumes: 5b's `Binder.optionalProperties`, `GuardInput.scope`, `GuardRejection`; `resultText`,
  `isObject` (gateway `util.ts`); `OAUTH_AUTHORIZATION_PROFILES` (Task 2).
- Produces:

```ts
// @agentx/contracts
export const ASANA_PROJECT_TOOL_ACCESS: {
  readonly get_task: "read"; readonly get_task_stories: "read"; readonly get_tasks: "read"; readonly search_tasks: "read";
  readonly get_project: "read"; readonly create_tasks: "write"; readonly update_tasks: "write"; readonly add_comment: "write";
};
// @agentx/gateway
export const ASANA_MCP_ENDPOINT: URL;   // https://mcp.asana.com/v2/mcp
export const ASANA_TOKEN_ENDPOINT: URL; // https://app.asana.com/-/oauth_token
export interface AsanaProjectScope { alias: string; projectGid: string }
export const ASANA_ITEM_ARGUMENTS: readonly ["task_id"];
export const ASANA_TASK_REFERENCES: Readonly<Record<string, readonly (readonly string[])[]>>;
export const asanaBinder: Binder<AsanaProjectScope>;
export const asanaProjectGuard: Guard;
export function asanaConnector(credentials: CredentialProvider<AsanaProjectScope>): ConnectorDefinition<AsanaProjectScope>;
// tests/support/vendor-fixtures.ts
export type VendorFixture = "linear" | "jira" | "asana";
```

- [ ] **Step 1: Add the `get_task` fixture and the loader entry**

`tests/fixtures/vendors/asana-get-task.json` (Asana's REST shape, Ruling 13; Task 9 replaces it with
the captured answer, names changed):

```json
{
  "data": {
    "gid": "1210000000000101",
    "name": "Flaky login test",
    "resource_type": "task",
    "completed": false,
    "assignee": null,
    "due_on": null,
    "notes": "Fails about one run in five.",
    "parent": null,
    "projects": [{ "gid": "1210000000000010", "name": "Payments", "resource_type": "project" }],
    "memberships": [
      { "project": { "gid": "1210000000000010", "name": "Payments" }, "section": { "gid": "1210000000000011", "name": "To do" } }
    ],
    "workspace": { "gid": "1210000000000001", "name": "Example workspace", "resource_type": "workspace" }
  }
}
```

In `tests/support/vendor-fixtures.ts`, add under the "Recorded 2026-09-24" comment line:

```ts
// asana-tools.json is Asana's whole tools/list (39 tools), recorded 2026-09-24 from https://mcp.asana.com/v2/mcp.
```

and change the type:

```ts
export type VendorFixture = "linear" | "jira" | "asana";
```

- [ ] **Step 2: Write the failing tests**

```ts
// tests/contract/gateway-asana.test.ts
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ASANA_PROJECT_TOOL_ACCESS } from "../../packages/contracts/src/index.js";
import {
  ASANA_ITEM_ARGUMENTS, ASANA_MCP_ENDPOINT, ASANA_TASK_REFERENCES, ASANA_TOKEN_ENDPOINT, asanaBinder, asanaConnector, executeTool, reviewTools,
  type AsanaProjectScope, type ConnectorContext, type Invocation, type Ledger, type McpToolResult, type ToolApproval,
} from "../../packages/gateway/src/index.js";
import { vendorTools } from "../support/vendor-fixtures.js";

const PROJECT = "1210000000000010";
const OTHER_PROJECT = "1210000000000020";
const scope: AsanaProjectScope = { alias: "payments", projectGid: PROJECT };
const GET_TASK = JSON.parse(readFileSync(new URL("../fixtures/vendors/asana-get-task.json", import.meta.url), "utf8")) as { data: Record<string, unknown> };

/** The get_task shape for a task in the given projects, optionally a subtask of `parent`. */
const taskResult = (gid: string, projects: string[], parent?: string): McpToolResult => ({
  content: [{ type: "text", text: JSON.stringify({ data: {
    ...GET_TASK.data, gid,
    projects: projects.map((project) => ({ gid: project, name: "Project" })),
    memberships: projects.map((project) => ({ project: { gid: project, name: "Project" } })),
    parent: parent === undefined ? null : { gid: parent, name: "Parent" },
  } }) }],
});

const approvals: ToolApproval[] = Object.entries(ASANA_PROJECT_TOOL_ACCESS).map(([name, access]) => ({ name, access }));

/** Tasks the fake knows: GID to projects and parent. */
const TASKS: Record<string, { projects: string[]; parent?: string }> = {
  "1210000000000101": { projects: [PROJECT] },
  "1210000000000102": { projects: [PROJECT, OTHER_PROJECT] },
  "1210000000000201": { projects: [OTHER_PROJECT] },
  "1210000000000301": { projects: [], parent: "1210000000000101" },
  "1210000000000302": { projects: [], parent: "1210000000000301" },
  "1210000000000401": { projects: [], parent: "1210000000000201" },
};

function harness(options: { policy?: ToolApproval[]; getTask?: (gid: string) => McpToolResult } = {}) {
  const tools = vendorTools("asana");
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  const call = vi.fn(async (name: string, args: Record<string, unknown>): Promise<McpToolResult> => {
    calls.push({ name, arguments: args });
    if (name === "get_task") {
      const gid = String(args.task_id);
      if (options.getTask) return options.getTask(gid);
      const task = TASKS[gid];
      return task ? taskResult(gid, task.projects, task.parent) : { isError: true, content: [{ type: "text", text: "Not found" }] };
    }
    return { content: [{ type: "text", text: JSON.stringify({ data: { ok: true } }) }] };
  });
  const connect = vi.fn(async (input: { endpoint: URL; tools: readonly string[] }) => {
    expect(input.endpoint.href).toBe(ASANA_MCP_ENDPOINT.href);
    return { tools: tools.filter((tool) => input.tools.includes(tool.name)), call, close: vi.fn(async () => undefined) };
  });
  const connector = asanaConnector({ issue: async () => ({ token: "asana-access-token-value", bindings: {} }) });
  const context: ConnectorContext<AsanaProjectScope> = {
    workspaceId: "workspace", ownerKey: "owner", scopeAlias: "payments", scope, policy: { tools: options.policy ?? approvals },
    requestedBy: { teamId: "T1", userId: "U1" },
  };
  const records = new Map<string, Invocation>();
  const ledger: Ledger = {
    claim: async (record) => { if (records.has(record.requestId)) return false; records.set(record.requestId, record); return true; },
    get: async (id) => records.get(id),
    finish: async (record) => { records.set(record.requestId, record); },
  };
  const reviewed = reviewTools({ tools }, connector, context);
  const hash = (tool: string) => reviewed.tools.find((entry) => entry.name === tool)!.schemaHash;
  const run = (tool: string, args: Record<string, unknown>) => executeTool(
    { requestId: randomUUID(), scope: "payments", tool, schemaHash: hash(tool), arguments: args },
    connector, context, { ledger, connect, attribution: "Requested by Slack member U1 via AgentX" },
  );
  const writes = () => calls.filter((entry) => entry.name !== "get_task" && ASANA_PROJECT_TOOL_ACCESS[entry.name as keyof typeof ASANA_PROJECT_TOOL_ACCESS] === "write");
  return { reviewed, run, calls, writes, connect };
}

describe("Asana connector definition", () => {
  it("talks to Asana's MCP server and refreshes at Asana's token endpoint", () => {
    expect(ASANA_MCP_ENDPOINT.href).toBe("https://mcp.asana.com/v2/mcp");
    expect(ASANA_TOKEN_ENDPOINT.href).toBe("https://app.asana.com/-/oauth_token");
    expect(asanaConnector({ issue: vi.fn() })).toMatchObject({ label: "Asana", attributionKeys: ["text"] });
  });

  it("offers all eight guarded tools from the recorded catalog with the project arguments removed", () => {
    const { reviewed } = harness();
    expect(reviewed.skipped).toEqual([]);
    expect(reviewed.tools.map((tool) => tool.name).sort()).toEqual(Object.keys(ASANA_PROJECT_TOOL_ACCESS).sort());
    const properties = (tool: string) => Object.keys(reviewed.tools.find((entry) => entry.name === tool)!.inputSchema.properties as Record<string, unknown>);
    expect(properties("get_tasks")).not.toContain("project");
    expect(properties("get_project")).not.toContain("project_id");
    expect(properties("create_tasks")).not.toContain("default_project");
    expect(properties("search_tasks")).not.toContain("projects_any");
    expect(properties("get_task")).toContain("task_id");
    expect(asanaBinder.properties).toEqual([]);
  });

  it("declares task_id as the item argument for spec 014, and every top-level task reference uses it", () => {
    expect(ASANA_ITEM_ARGUMENTS).toEqual(["task_id"]);
    const topLevel = Object.values(ASANA_TASK_REFERENCES).flat().filter((path) => path.length === 1).map((path) => path[0]);
    expect(new Set(topLevel)).toEqual(new Set(ASANA_ITEM_ARGUMENTS));
  });
});

describe("Asana project guard", () => {
  it("binds the project on lists, searches and project reads", async () => {
    const { run, calls } = harness();
    expect(await run("get_tasks", { completed_since: "2026-09-01T00:00:00Z" })).toMatchObject({ status: "SUCCEEDED" });
    expect(await run("search_tasks", { text: "login", completed: false })).toMatchObject({ status: "SUCCEEDED" });
    expect(await run("get_project", {})).toMatchObject({ status: "SUCCEEDED" });
    expect(calls).toEqual([
      { name: "get_tasks", arguments: { completed_since: "2026-09-01T00:00:00Z", project: PROJECT } },
      { name: "search_tasks", arguments: { text: "login", completed: false, projects_any: PROJECT } },
      { name: "get_project", arguments: { project_id: PROJECT } },
    ]);
  });

  it("refuses a model-supplied project on any tool before connecting", async () => {
    const { run, connect } = harness();
    await expect(run("get_tasks", { project: OTHER_PROJECT })).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("Asana routing arguments are server controlled") as unknown });
    await expect(run("search_tasks", { projects_any: `${PROJECT},${OTHER_PROJECT}` })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(connect).not.toHaveBeenCalled();
  });

  it("refuses get_tasks filters that would replace the project context", async () => {
    const { run, calls } = harness();
    for (const args of [{ tag: "1210000000000900" }, { section: "1210000000000901" }, { user_task_list: "1210000000000902" }, { assignee: "me" }]) {
      const result = await run("get_tasks", args);
      expect(result).toMatchObject({ status: "FAILED", reason: "policy_denied" });
      expect(result.text).toContain("works only in the payments project");
    }
    expect(calls).toEqual([]);
  });

  it("reads and comments on a task in the project, signing only the plain-text comment", async () => {
    const { run, calls } = harness();
    expect(await run("get_task", { task_id: "1210000000000101" })).toMatchObject({ status: "SUCCEEDED" });
    expect(await run("add_comment", { task_id: "1210000000000102", text: "Fixed in main." })).toMatchObject({ status: "SUCCEEDED" });
    expect(calls.map((entry) => entry.name)).toEqual(["get_task", "get_task", "get_task", "add_comment"]);
    expect(calls[1]).toEqual({ name: "get_task", arguments: { task_id: "1210000000000101" } });
    expect(calls[3]!.arguments).toEqual({ task_id: "1210000000000102", text: "Fixed in main.\n\n—\nRequested by Slack member U1 via AgentX" });
  });

  it("refuses to comment on, read or list the stories of a task in another project, and writes nothing", async () => {
    const { run, writes } = harness();
    for (const [tool, args] of [["add_comment", { task_id: "1210000000000201", text: "x" }], ["get_task", { task_id: "1210000000000201" }], ["get_task_stories", { task_id: "1210000000000201" }]] as const) {
      const result = await run(tool, args);
      expect(result).toMatchObject({ status: "FAILED", reason: "policy_denied", text: "Asana task 1210000000000201 is not in the payments project this connector may use." });
    }
    expect(writes()).toEqual([]);
  });

  it("follows a subtask up to its parent's project, at most three levels", async () => {
    const { run, calls } = harness();
    expect(await run("add_comment", { task_id: "1210000000000302", text: "x" })).toMatchObject({ status: "SUCCEEDED" });
    expect(calls.filter((entry) => entry.name === "get_task").map((entry) => entry.arguments.task_id)).toEqual(["1210000000000302", "1210000000000301", "1210000000000101"]);
    expect(await run("add_comment", { task_id: "1210000000000401", text: "x" })).toMatchObject({ status: "FAILED", reason: "policy_denied" });
  });

  it("fails closed when the task cannot be read, has an unexpected shape, or is a different task", async () => {
    const notFound = await harness().run("add_comment", { task_id: "1210000000000999", text: "x" });
    expect(notFound).toMatchObject({ status: "FAILED", reason: "policy_denied", text: "Asana task 1210000000000999 was not found or this connector cannot see it." });
    const shapes: McpToolResult[] = [
      { content: [{ type: "text", text: "Task: Flaky login test (project Payments)" }] },
      { content: [{ type: "text", text: JSON.stringify({ gid: "1210000000000101", projects: [{ gid: PROJECT }] }) }] },
      { content: [{ type: "text", text: JSON.stringify({ data: { gid: "1210000000000101" } }) }] },
      taskResult("1210000000000555", [PROJECT]),
    ];
    for (const shape of shapes) {
      const { run, writes } = harness({ getTask: () => shape });
      const result = await run("add_comment", { task_id: "1210000000000101", text: "x" });
      expect(result).toMatchObject({ status: "FAILED", reason: "policy_denied", text: "Could not confirm that Asana task 1210000000000101 is in the payments project, so the request was not sent." });
      expect(writes()).toEqual([]);
    }
  });

  it("refuses a task URL or name instead of a task ID, before any call", async () => {
    const { run, calls } = harness();
    for (const task_id of ["https://app.asana.com/0/1210000000000010/1210000000000101", "Flaky login test", "0123"]) {
      expect(await run("add_comment", { task_id, text: "x" })).toMatchObject({ status: "FAILED", text: expect.stringContaining("Pass the Asana task ID") as unknown });
    }
    expect(calls).toEqual([]);
  });

  it("creates tasks only in the project: binds default_project, allows its own project_id and a parent in it, refuses the rest", async () => {
    const { run, calls, writes } = harness();
    expect(await run("create_tasks", { tasks: [{ name: "Fix login" }, { name: "Subtask", parent: "1210000000000101" }, { name: "Same project", project_id: PROJECT }] })).toMatchObject({ status: "SUCCEEDED" });
    expect(calls.at(-1)).toEqual({ name: "create_tasks", arguments: { tasks: [{ name: "Fix login" }, { name: "Subtask", parent: "1210000000000101" }, { name: "Same project", project_id: PROJECT }], default_project: PROJECT } });
    const refused = [
      { tasks: [{ name: "Elsewhere", project_id: OTHER_PROJECT }] },
      { tasks: [{ name: "Sub elsewhere", parent: "1210000000000201" }] },
      { tasks: [{ name: "Sectioned", section_id: "1210000000000011" }] },
      { tasks: [{ name: "Mine", assignee_section: "1210000000000012" }] },
    ];
    for (const args of refused) expect(await run("create_tasks", args)).toMatchObject({ status: "FAILED", reason: "policy_denied" });
    expect(writes()).toHaveLength(1);
  });

  it("updates tasks only when every task, parent and dependency is in the project, and never moves a task between projects", async () => {
    const { run, writes } = harness();
    expect(await run("update_tasks", { tasks: [{ task: "1210000000000101", completed: true }, { task: "1210000000000102", add_dependencies: ["1210000000000101"], parent: null }] })).toMatchObject({ status: "SUCCEEDED" });
    const refused = [
      { tasks: [{ task: "1210000000000201", name: "x" }] },
      { tasks: [{ task: "1210000000000101", add_dependencies: ["1210000000000201"] }] },
      { tasks: [{ task: "1210000000000101", parent: "1210000000000201" }] },
      { tasks: [{ task: "1210000000000101", add_projects: [{ project_id: OTHER_PROJECT }] }] },
      { tasks: [{ task: "1210000000000101", remove_projects: [PROJECT] }] },
      { tasks: Array.from({ length: 11 }, (_unused, index) => ({ task: `12100000000011${String(index).padStart(2, "0")}`, completed: true })) },
    ];
    for (const args of refused) expect(await run("update_tasks", args)).toMatchObject({ status: "FAILED", reason: "policy_denied" });
    expect(writes()).toHaveLength(1);
  });

  it("refuses a tool the guard cannot hold to the project, even if a policy approves it", async () => {
    const { run, calls } = harness({ policy: [...approvals, { name: "delete_task", access: "write" }] });
    expect(await run("delete_task", { task: "1210000000000101" })).toMatchObject({ status: "FAILED", reason: "policy_denied", text: "delete_task cannot be limited to an Asana project, so this connector does not run it." });
    expect(calls).toEqual([]);
  });
});
```

- [ ] **Step 3: Run and watch them fail**

Run: `npm run build && npx vitest run tests/contract/gateway-asana.test.ts`
Expected: FAIL; `ASANA_PROJECT_TOOL_ACCESS` and the `asana` exports are undefined.

- [ ] **Step 4: Add the tool table to the contracts**

In `packages/contracts/src/connectors.ts`, insert just above
`const RepositoryNameSchema = z.string().regex(AGENTX_NAME_PATTERN);`:

```ts
/**
 * The Asana tools AgentX can hold to one project, and the access each must be approved with.
 * An Asana connector may approve only these.
 */
export const ASANA_PROJECT_TOOL_ACCESS = {
  get_task: "read",
  get_task_stories: "read",
  get_tasks: "read",
  search_tasks: "read",
  get_project: "read",
  create_tasks: "write",
  update_tasks: "write",
  add_comment: "write",
} as const satisfies Record<string, "read" | "write">;
```

- [ ] **Step 5: Implement the connector definition**

Create `packages/gateway/src/asana.ts`:

```ts
import { ASANA_PROJECT_TOOL_ACCESS, OAUTH_AUTHORIZATION_PROFILES } from "@agentx/contracts";
import { GuardRejection, type Binder, type ConnectorDefinition, type CredentialProvider, type Guard, type GuardInput } from "./types.js";
import { isObject, resultText } from "./util.js";

/** Asana's hosted MCP server. OAuth only: a bot user's access token, refreshed by oauth-refresh-token. */
export const ASANA_MCP_ENDPOINT = new URL("https://mcp.asana.com/v2/mcp");
export const ASANA_TOKEN_ENDPOINT = new URL(OAUTH_AUTHORIZATION_PROFILES.asana.tokenUrl);

/** An Asana project a connector may address, by the alias the model sees and the project's GID. */
export interface AsanaProjectScope { alias: string; projectGid: string }

/**
 * The argument through which an Asana tool names one existing task, for spec 014's action gate
 * (`ConnectorDefinition.itemArguments`, most specific first). update_tasks names its tasks inside
 * `tasks[].task`; see ASANA_TASK_REFERENCES.
 */
export const ASANA_ITEM_ARGUMENTS = ["task_id"] as const;

/**
 * Asana names the project `project` (get_tasks), `project_id` (get_project), `default_project`
 * (create_tasks) and `projects_any` (search_tasks). Each is bound, where the tool has it, to the
 * scope's project GID, so a list, a search and a create can only reach that project.
 */
export const asanaBinder: Binder<AsanaProjectScope> = {
  properties: [],
  optionalProperties: ["project", "project_id", "default_project", "projects_any"],
  bind: (scope) => ({ project: scope.projectGid, project_id: scope.projectGid, default_project: scope.projectGid, projects_any: scope.projectGid }),
};

/** A path into a tool's arguments; "*" is each element of an array. */
type ArgumentPath = readonly string[];

/**
 * Where each guarded tool names an existing task. Every task named here is read with get_task and
 * must be in the scope's project (or be a subtask of one that is) before the call is sent.
 */
export const ASANA_TASK_REFERENCES: Readonly<Record<string, readonly ArgumentPath[]>> = {
  get_task: [["task_id"]],
  get_task_stories: [["task_id"]],
  add_comment: [["task_id"]],
  create_tasks: [["tasks", "*", "parent"]],
  update_tasks: [
    ["tasks", "*", "task"], ["tasks", "*", "parent"],
    ["tasks", "*", "add_dependencies", "*"], ["tasks", "*", "remove_dependencies", "*"],
    ["tasks", "*", "add_dependents", "*"], ["tasks", "*", "remove_dependents", "*"],
  ],
};

/** Arguments that would reach outside the project or move a task between projects. */
const REFUSED_ARGUMENTS: Readonly<Record<string, readonly ArgumentPath[]>> = {
  get_tasks: [["tag"], ["section"], ["user_task_list"], ["assignee"]],
  create_tasks: [["tasks", "*", "section_id"], ["tasks", "*", "assignee_section"]],
  update_tasks: [["tasks", "*", "add_projects"], ["tasks", "*", "remove_projects"], ["tasks", "*", "assignee_section"]],
};

const GID = /^[1-9][0-9]{0,19}$/;
/** The most get_task reads one call may cost, parents included. */
const MAX_LOOKUPS = 10;
/** How far up the parent chain a subtask is followed to find its project. */
const MAX_PARENT_DEPTH = 3;
const NO_SCOPE = "The Asana project check could not run, so the request was not sent.";
const INVALID_GID = "Pass the Asana task ID (the long number in the task's URL), not a URL, name or other text.";

function scopeOf(scope: unknown): AsanaProjectScope {
  if (!isObject(scope) || typeof scope.alias !== "string" || scope.alias === "" || typeof scope.projectGid !== "string" || !GID.test(scope.projectGid)) throw new GuardRejection(NO_SCOPE);
  return { alias: scope.alias, projectGid: scope.projectGid };
}

/** Every value at a path, with the concrete path it was found at. Absent, null and [] are skipped. */
function valuesAt(value: unknown, path: ArgumentPath, at: string[] = []): Array<{ value: unknown; at: string }> {
  if (value === undefined || value === null) return [];
  if (path.length === 0) return Array.isArray(value) && value.length === 0 ? [] : [{ value, at: at.join(".") }];
  const [head, ...rest] = path;
  if (head === "*") {
    if (!Array.isArray(value)) return [{ value, at: at.join(".") }];
    return value.flatMap((item, index) => valuesAt(item, rest, [...at, String(index)]));
  }
  if (!isObject(value)) return [];
  return valuesAt(value[head!], rest, [...at, head!]);
}

/** The task GIDs the call names, after refusing arguments that could leave the project. */
function taskReferences(tool: string, args: Readonly<Record<string, unknown>>, project: AsanaProjectScope): string[] {
  for (const path of REFUSED_ARGUMENTS[tool] ?? []) {
    const found = valuesAt(args, path)[0];
    if (found !== undefined) {
      throw new GuardRejection(`This Asana connector works only in the ${project.alias} project, so ${found.at} is not allowed on ${tool}.${tool === "get_tasks" ? " Use search_tasks to filter by assignee." : ""}`);
    }
  }
  if (tool === "create_tasks") {
    for (const { value } of valuesAt(args, ["tasks", "*", "project_id"])) {
      if (value !== project.projectGid) throw new GuardRejection(`This Asana connector creates tasks only in the ${project.alias} project. Leave project_id out.`);
    }
  }
  const references = new Set<string>();
  for (const path of ASANA_TASK_REFERENCES[tool] ?? []) {
    for (const { value } of valuesAt(args, path)) {
      if (typeof value !== "string" || !GID.test(value)) throw new GuardRejection(INVALID_GID);
      references.add(value);
    }
  }
  if (references.size > MAX_LOOKUPS) throw new GuardRejection(`This Asana request names more than ${MAX_LOOKUPS} tasks. Split it into smaller requests.`);
  return [...references];
}

/** The live get_task result is `{ data: { gid, projects: [{ gid }], parent, memberships } }`; nothing else is trusted. */
function taskOf(text: string): { gid: string; projects: string[]; parent: string | undefined } | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return undefined; }
  const data = isObject(parsed) && isObject(parsed.data) ? parsed.data : undefined;
  if (!data || typeof data.gid !== "string") return undefined;
  const projects = new Set<string>();
  let listed = false;
  if (Array.isArray(data.projects)) {
    listed = true;
    for (const entry of data.projects) if (isObject(entry) && typeof entry.gid === "string") projects.add(entry.gid);
  }
  if (Array.isArray(data.memberships)) {
    listed = true;
    for (const entry of data.memberships) if (isObject(entry) && isObject(entry.project) && typeof entry.project.gid === "string") projects.add(entry.project.gid);
  }
  if (!listed) return undefined;
  const parent = isObject(data.parent) && typeof data.parent.gid === "string" ? data.parent.gid : undefined;
  return { gid: data.gid, projects: [...projects], parent };
}

/**
 * Reads the task with get_task and refuses unless it, or a parent up to three levels up, is in the
 * scope's project. Subtasks are often in no project themselves; Asana shows them to whoever can
 * see the parent. Fails closed on an error, an unreadable result or a different task.
 */
async function confirmInProject(connection: GuardInput["connection"], gid: string, project: AsanaProjectScope, budget: { left: number }): Promise<void> {
  let current = gid;
  for (let depth = 0; depth <= MAX_PARENT_DEPTH; depth += 1) {
    if (budget.left <= 0) throw new GuardRejection(`This Asana request needs more than ${MAX_LOOKUPS} task checks. Split it into smaller requests.`);
    budget.left -= 1;
    const result = await connection.call("get_task", { task_id: current, include_subtasks: false, include_comments: false });
    if (result.isError) throw new GuardRejection(`Asana task ${gid} was not found or this connector cannot see it.`);
    const task = taskOf(resultText(result));
    if (task === undefined || task.gid !== current) throw new GuardRejection(`Could not confirm that Asana task ${gid} is in the ${project.alias} project, so the request was not sent.`);
    if (task.projects.includes(project.projectGid)) return;
    if (task.parent === undefined) break;
    current = task.parent;
  }
  throw new GuardRejection(`Asana task ${gid} is not in the ${project.alias} project this connector may use.`);
}

/**
 * The bot user may see more than the project scopes. Only the tools in ASANA_PROJECT_TOOL_ACCESS
 * run; before a call reads or changes an existing task, every task it names is confirmed in the
 * scope's project, so nothing is sent otherwise.
 */
export const asanaProjectGuard: Guard = {
  requiredTools: (tool) => Object.hasOwn(ASANA_TASK_REFERENCES, tool) && tool !== "get_task" ? ["get_task"] : [],
  async check({ tool, arguments: args, connection, scope }) {
    const project = scopeOf(scope);
    if (!Object.hasOwn(ASANA_PROJECT_TOOL_ACCESS, tool)) throw new GuardRejection(`${tool} cannot be limited to an Asana project, so this connector does not run it.`);
    const budget = { left: MAX_LOOKUPS };
    for (const gid of taskReferences(tool, args, project)) await confirmInProject(connection, gid, project, budget);
  },
};

export function asanaConnector(credentials: CredentialProvider<AsanaProjectScope>): ConnectorDefinition<AsanaProjectScope> {
  return {
    label: "Asana",
    endpoint: ASANA_MCP_ENDPOINT,
    permissionsHint: "the bot user's sign-in (run agentx admin credential authorize again if it was revoked) and its access to the Asana project",
    credentials,
    binder: asanaBinder,
    guards: [asanaProjectGuard],
    attributionKeys: ["text"],
  };
}
```

In `packages/gateway/src/index.ts`, add as the first line:

```ts
export * from "./asana.js";
```

- [ ] **Step 6: Run and watch them pass**

Run the Step 3 command. Expected: PASS, 14 tests.

- [ ] **Step 7: Full check and commit**

```bash
npm run typecheck && npm run lint && npm run build && npm test
git add packages/contracts/src/connectors.ts packages/gateway/src/asana.ts packages/gateway/src/index.ts \
  tests/support/vendor-fixtures.ts tests/fixtures/vendors/asana-get-task.json tests/contract/gateway-asana.test.ts
git commit -m "feat(gateway): add the Asana connector with a project binder and a fail-closed project guard

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: The `asana` connector type in the contracts and the broker

**Files:**
- Create: `packages/broker/src/aws/asana-connector-type.ts`, `tests/contract/asana-connector.test.ts`
- Modify: `packages/contracts/src/connectors.ts`, `packages/broker/src/aws/connector-types.ts`,
  `packages/broker/src/aws/registration-preflight.ts` (Ruling 17),
  `tests/contract/connector-types.test.ts` (named assertion 2)

**Interfaces:**
- Consumes: Task 5's `asanaConnector`, `ASANA_TOKEN_ENDPOINT`, `AsanaProjectScope`,
  `ASANA_PROJECT_TOOL_ACCESS`; Task 3's registry building the refresh provider from
  `provider(ref, { tokenEndpoint })`; `credentialRefusals` (phase 5, unchanged signature).
- Produces:

```ts
// @agentx/contracts
export const AsanaScopeSchema: z.ZodObject<{ alias; projectGid }>;
export const AsanaConnectorSchema; // in ConnectorConfigSchema's union
export type AsanaConnectorConfig = z.infer<typeof AsanaConnectorSchema>;
// packages/broker/src/aws/asana-connector-type.ts
export const asanaConnectorType: ConnectorType; // label "Asana tasks", vendor "Asana", scopeNoun "Asana project", accepts ["oauth-refresh-token"]
```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/contract/asana-connector.test.ts
import { describe, expect, it, vi } from "vitest";
import { ASANA_PROJECT_TOOL_ACCESS, ConnectorsSchema, ProjectDefinitionSchema, StoredProjectDefinitionSchema } from "../../packages/contracts/src/index.js";
import { ASANA_MCP_ENDPOINT } from "../../packages/gateway/src/index.js";
import { asanaConnectorType } from "../../packages/broker/src/aws/asana-connector-type.js";
import { BUILT_IN_CONNECTOR_TYPES, resolveConnectors } from "../../packages/broker/src/aws/connector-types.js";
import { CredentialRegistry } from "../../packages/broker/src/aws/credentials.js";
import { credentialRefusals } from "../../packages/broker/src/aws/registration-preflight.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const PROJECT = "1210000000000010";
const tools = [{ name: "search_tasks", access: "read" }, { name: "get_task", access: "read" }, { name: "create_tasks", access: "write" }, { name: "add_comment", access: "write" }];
const asana = (overrides: Record<string, unknown> = {}) => ({ name: "asana", type: "asana", credentialRef: "asana-bot", scopes: [{ alias: "payments", projectGid: PROJECT }], tools, ...overrides });
const project = (connectors: unknown[]) => ({
  name: "payments", revision: 1,
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }],
  setup: [], readiness: [], orchestratorInstructions: "x", integrations: { connectors },
});

function registry(records: Array<{ ref: string; type: string }> = []) {
  const db = new FakeDynamoDb();
  for (const record of records) db.set({ pk: "CREDENTIALS", sk: `REF#${record.ref}`, entityType: "CREDENTIAL", ref: record.ref, type: record.type, secretName: `agentx/connectors/${record.ref}`, registeredBy: "admin", registeredAt: "2026-09-25T00:00:00.000Z" });
  const secrets = { read: vi.fn(async () => undefined), write: vi.fn(async () => undefined) };
  return new CredentialRegistry({ secrets, githubApp: { ref: "github-app", secretName: "agentx/github-app" }, documentClient: db as never, tableName: "state" });
}

describe("asana connector configuration", () => {
  it("accepts an asana connector beside github, with every guarded tool at its pinned access", () => {
    const github = { name: "github", type: "github", scopes: "all-repositories", tools: [{ name: "list_issues", access: "read" }] };
    const all = Object.entries(ASANA_PROJECT_TOOL_ACCESS).map(([name, access]) => ({ name, access }));
    expect(ProjectDefinitionSchema.safeParse(project([github, asana({ tools: all, identity: "service" })])).success).toBe(true);
  });

  it("refuses an unguarded tool, a wrong access, duplicate aliases or projects, a bad GID and a missing credential", () => {
    const issues = (value: unknown) => {
      const parsed = ConnectorsSchema.safeParse([value]);
      return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
    };
    expect(issues(asana({ tools: [{ name: "delete_task", access: "write" }] }))).toContain("connector asana: tool delete_task cannot be limited to an Asana project; approve only get_task, get_task_stories, get_tasks, search_tasks, get_project, create_tasks, update_tasks, add_comment");
    expect(issues(asana({ tools: [{ name: "add_comment", access: "read" }] }))).toContain("connector asana: tool add_comment must be approved with access: write");
    expect(issues(asana({ scopes: [{ alias: "a", projectGid: PROJECT }, { alias: "a", projectGid: "1210000000000020" }] }))).toContain("connector asana: scope aliases must be unique");
    expect(issues(asana({ scopes: [{ alias: "a", projectGid: PROJECT }, { alias: "b", projectGid: PROJECT }] }))).toContain("connector asana: scopes must name different Asana projects");
    expect(issues(asana({ scopes: [{ alias: "a", projectGid: "https://app.asana.com/0/1210000000000010" }] }))).not.toEqual([]);
    expect(issues(asana({ credentialRef: undefined }))).not.toEqual([]);
    expect(issues(asana({ scopes: [] }))).not.toEqual([]);
  });

  it("validates a stored asana entry strictly", () => {
    expect(StoredProjectDefinitionSchema.safeParse(project([asana()])).success).toBe(true);
    expect(StoredProjectDefinitionSchema.safeParse(project([asana({ extra: true })])).success).toBe(false);
  });
});

describe("asana connector type", () => {
  it("is built in and resolves label, vendor, scope noun, ledger and an oauth-refresh-token credential", () => {
    expect(BUILT_IN_CONNECTOR_TYPES.asana).toBe(asanaConnectorType);
    const [connector] = resolveConnectors(ProjectDefinitionSchema.parse(project([asana()])), { credentialRegistry: registry() });
    expect(connector).toMatchObject({
      name: "asana", type: "asana", label: "Asana tasks", vendor: "Asana", scopeNoun: "Asana project", attribution: true,
      ledger: { prefix: "CONNECTOR#asana#", entityType: "CONNECTOR_INVOCATION" },
      credential: { ref: "asana-bot", accepts: ["oauth-refresh-token"] },
      scopes: [{ alias: "payments", scope: { alias: "payments", projectGid: PROJECT } }],
    });
  });

  it("is not connected until an oauth-refresh-token credential is registered under its reference", async () => {
    const resolve = (records: Array<{ ref: string; type: string }>) => resolveConnectors(ProjectDefinitionSchema.parse(project([asana()])), { credentialRegistry: registry(records) })[0]!;
    expect(await resolve([]).definition()).toEqual({ notConnected: "credential asana-bot is not registered" });
    expect(await resolve([{ ref: "asana-bot", type: "static-secret" }]).definition())
      .toEqual({ notConnected: "credential asana-bot is static-secret; an Asana connector needs an oauth-refresh-token credential from agentx admin credential authorize" });
    expect(await resolve([{ ref: "asana-bot", type: "static-secret" }]).configured()).toBe(false);
    const connected = resolve([{ ref: "asana-bot", type: "oauth-refresh-token" }]);
    expect(await connected.configured()).toBe(true);
    expect(await connected.definition()).toMatchObject({ label: "Asana", endpoint: ASANA_MCP_ENDPOINT });
    const [withoutRegistry] = resolveConnectors(ProjectDefinitionSchema.parse(project([asana()])), {});
    expect(await withoutRegistry!.definition()).toEqual({ notConnected: "connector credentials are not configured in this deployment" });
  });

  it("is refused at registration unless its reference is a registered oauth-refresh-token credential, in plain English", async () => {
    const connectors = (records: Array<{ ref: string; type: string }>) => {
      const credentials = registry(records);
      return { credentials, resolved: resolveConnectors(ProjectDefinitionSchema.parse(project([asana()])), { credentialRegistry: credentials }) };
    };
    const unregistered = connectors([]);
    expect(await credentialRefusals(unregistered.resolved, unregistered.credentials)).toEqual(["connector asana: credential asana-bot is not registered; run agentx admin credential register first"]);
    const wrong = connectors([{ ref: "asana-bot", type: "static-secret" }]);
    expect(await credentialRefusals(wrong.resolved, wrong.credentials)).toEqual(["connector asana: credential asana-bot is static-secret; an Asana connector needs oauth-refresh-token"]);
    const right = connectors([{ ref: "asana-bot", type: "oauth-refresh-token" }]);
    expect(await credentialRefusals(right.resolved, right.credentials)).toEqual([]);
  });

  it("reports a malformed stored entry as unusable, naming the rule, never throwing", () => {
    const result = asanaConnectorType.resolve({ name: "asana", type: "asana", credentialRef: "asana-bot", scopes: [{ alias: "payments", projectGid: PROJECT }], tools: [{ name: "delete_task", access: "write" }] }, ProjectDefinitionSchema.parse(project([asana()])), {});
    expect(result).toEqual({ unusable: expect.stringMatching(/^invalid asana connector configuration: entry; connector asana: tool delete_task cannot be limited/) as unknown });
  });
});
```

In `tests/contract/connector-types.test.ts` (named assertion change 2):

```ts
    expect(schemaTypes).toEqual(["github", "linear", "jira", "asana"]);
```

- [ ] **Step 2: Run and watch them fail**

Run: `npm run build && npx vitest run tests/contract/asana-connector.test.ts tests/contract/connector-types.test.ts`
Expected: FAIL; `asana-connector-type.js` does not exist and the schema has no `asana` option.

- [ ] **Step 3: Add the schema**

In `packages/contracts/src/connectors.ts`, replace the `ConnectorConfigSchema` line with:

```ts
/** An Asana project GID: the long number in the project's URL. */
const AsanaGidSchema = z.string().regex(/^[1-9][0-9]{0,19}$/, "projectGid must be an Asana project GID, the long number in the project's URL");

export const AsanaScopeSchema = z.object({ alias: ConnectorAliasSchema, projectGid: AsanaGidSchema }).strict();

/**
 * Asana reads an oauth-refresh-token credential (a bot user signed in once) through the credential
 * registry. Each scope is one Asana project, and only the tools the project guard can hold to a
 * project may be approved, each with its pinned access.
 */
export const AsanaConnectorSchema = z.object({
  name: ConnectorNameSchema,
  type: z.literal("asana"),
  credentialRef: z.string().regex(AGENTX_NAME_PATTERN),
  identity: z.literal("service").optional(),
  scopes: z.array(AsanaScopeSchema).min(1).max(32),
  tools: ToolApprovalListSchema,
  attribution: z.boolean().optional(),
}).strict().superRefine((connector, context) => {
  const issue = (message: string) => context.addIssue({ code: "custom", message: `connector ${connector.name}: ${message}` });
  if (new Set(connector.scopes.map((scope) => scope.alias)).size !== connector.scopes.length) issue("scope aliases must be unique");
  if (new Set(connector.scopes.map((scope) => scope.projectGid)).size !== connector.scopes.length) issue("scopes must name different Asana projects");
  const guarded = Object.keys(ASANA_PROJECT_TOOL_ACCESS);
  for (const tool of connector.tools) {
    const pinned = Object.hasOwn(ASANA_PROJECT_TOOL_ACCESS, tool.name) ? (ASANA_PROJECT_TOOL_ACCESS as Record<string, "read" | "write">)[tool.name] : undefined;
    if (pinned === undefined) issue(`tool ${tool.name} cannot be limited to an Asana project; approve only ${guarded.join(", ")}`);
    else if (tool.access !== pinned) issue(`tool ${tool.name} must be approved with access: ${pinned}`);
  }
});

export const ConnectorConfigSchema = z.discriminatedUnion("type", [GitHubConnectorSchema, LinearConnectorSchema, JiraConnectorSchema, AsanaConnectorSchema]);
```

and add after `export type LinearConnectorConfig = ...;`:

```ts
export type AsanaConnectorConfig = z.infer<typeof AsanaConnectorSchema>;
```

- [ ] **Step 4: Add the connector type and register it**

Create `packages/broker/src/aws/asana-connector-type.ts`:

```ts
import { AsanaConnectorSchema, type CredentialType } from "@agentx/contracts";
import { ASANA_TOKEN_ENDPOINT, asanaConnector, type AsanaProjectScope } from "@agentx/gateway";
import { connectorLedgerKeys } from "./connector-ledger.js";
import type { ConnectorType, ResolvedConnector } from "./connector-types.js";

const ACCEPTS: readonly CredentialType[] = ["oauth-refresh-token"];
const NOT_CONFIGURED = "connector credentials are not configured in this deployment";
const MAX_REASON = 300;

/** Asana through its hosted MCP server, as a bot user signed in once (oauth-refresh-token). */
export const asanaConnectorType: ConnectorType = {
  type: "asana",
  resolve(config, _project, context) {
    // Stored data is validated here, not trusted: a malformed entry is unusable, never a throw.
    const parsed = AsanaConnectorSchema.safeParse(config);
    if (!parsed.success) {
      const fields = [...new Set(parsed.error.issues.map((issue) => issue.path[0] === undefined ? "entry" : String(issue.path[0])))];
      // Rule messages name only the connector, its scopes and its tools, never a credential value.
      const rules = parsed.error.issues.filter((issue) => issue.code === "custom").map((issue) => issue.message);
      return { unusable: [`invalid asana connector configuration: ${fields.join(", ")}`, ...rules].join("; ").slice(0, MAX_REASON) };
    }
    const asana = parsed.data;
    const registry = context.credentialRegistry;
    const connector: ResolvedConnector<AsanaProjectScope> = {
      name: asana.name,
      type: "asana",
      label: "Asana tasks",
      vendor: "Asana",
      scopeNoun: "Asana project",
      scopes: asana.scopes.map((scope) => ({ alias: scope.alias, scope: { alias: scope.alias, projectGid: scope.projectGid } })),
      policy: { tools: asana.tools },
      approvals: asana.tools,
      attribution: asana.attribution !== false,
      ledger: connectorLedgerKeys(asana.name),
      credential: { ref: asana.credentialRef, accepts: ACCEPTS },
      configured: async () => (await registry?.typeOf(asana.credentialRef)) === "oauth-refresh-token",
      async definition() {
        if (!registry) return { notConnected: NOT_CONFIGURED };
        const type = await registry.typeOf(asana.credentialRef);
        if (type === undefined) return { notConnected: `credential ${asana.credentialRef} is not registered` };
        // Asana's MCP server takes only OAuth user tokens: no API keys and no client credentials.
        if (type !== "oauth-refresh-token") return { notConnected: `credential ${asana.credentialRef} is ${type}; an Asana connector needs an oauth-refresh-token credential from agentx admin credential authorize` };
        return asanaConnector(registry.provider(asana.credentialRef, { tokenEndpoint: ASANA_TOKEN_ENDPOINT }));
      },
      ...(context.connect ? { connect: context.connect } : {}),
    };
    return connector;
  },
};
```

In `packages/broker/src/aws/connector-types.ts`, import it above the `./credentials.js` import:

```ts
import { asanaConnectorType } from "./asana-connector-type.js";
```

and replace the map:

```ts
export const BUILT_IN_CONNECTOR_TYPES: Readonly<Record<string, ConnectorType>> = { github: githubConnectorType, linear: linearConnectorType, jira: jiraConnectorType, asana: asanaConnectorType };
```

In `packages/broker/src/aws/registration-preflight.ts`, `credentialRefusals`, replace the
wrong-type line with:

```ts
    else if (!credential.accepts.includes(type)) refusals.push(`connector ${connector.name}: credential ${credential.ref} is ${type}; ${/^[AEIOU]/.test(connector.vendor) ? "an" : "a"} ${connector.vendor} connector needs ${credential.accepts.join(" or ")}`);
```

The Linear and Jira assertions ("a Linear connector needs static-secret", "a Jira connector
needs static-secret") keep passing unchanged.

- [ ] **Step 5: Run and watch them pass**

Run the Step 2 command, then `npx vitest run tests/contract/linear-connector.test.ts tests/contract/registration-preflight.test.ts`.
Expected: PASS.

- [ ] **Step 6: Full check and commit**

```bash
npm run typecheck && npm run lint && npm run build && npm test
git add packages/contracts/src/connectors.ts packages/broker/src/aws/asana-connector-type.ts packages/broker/src/aws/connector-types.ts \
  packages/broker/src/aws/registration-preflight.ts tests/contract/asana-connector.test.ts tests/contract/connector-types.test.ts
git commit -m "feat(broker): add the asana connector type, reading an oauth-refresh-token credential

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: A fake Asana and the whole flow through the broker routes

Drives registration, discovery and calls through the real broker routes, the real `connectMcp`
(Streamable HTTP) and the real registry and provider, against a local server that plays Asana's
token endpoint and MCP server. Tasks 1 to 6 should already make it pass; a failure here is a bug
in one of them, to be pinned by a failing unit test in that task's file before it is fixed.

**Files:**
- Create: `tests/support/fake-asana.ts`, `tests/integration/asana-connector.test.ts`

**Interfaces:**
- Consumes: every earlier task; `createBroker`, `call`, `ensureWorkspace`, `markReady`
  (`tests/support/slack-broker.ts`); `memorySecretStore` (Task 2).
- Produces:

```ts
// tests/support/fake-asana.ts
export interface FakeAsanaTask { projects: string[]; parent?: string }
export interface FakeAsana {
  mcpUrl: URL; tokenUrl: URL; calls: Array<{ name: string; arguments: Record<string, unknown> }>;
  authorizations: Array<string | undefined>; refreshes: string[]; rotate: boolean;
  expireAccessTokens(): void; revokeRefreshToken(): void; close(): Promise<void>;
}
export function startFakeAsana(options: { clientId: string; clientSecret: string; refreshToken: string; tasks: Record<string, FakeAsanaTask> }): Promise<FakeAsana>;
```

- [ ] **Step 1: Write the fake**

```ts
// A local server that answers like Asana: an OAuth token endpoint (refresh grant only) at
// /-/oauth_token and a Streamable HTTP MCP server at /v2/mcp serving the recorded tools/list
// (vendors/asana-tools.json) and the get_task shape (vendors/asana-get-task.json). The MCP server
// answers 401 unless the Bearer token is an access token it issued and has not revoked.
import { createServer } from "node:http";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { vendorTools } from "./vendor-fixtures.js";

const GET_TASK = JSON.parse(readFileSync(new URL("../fixtures/vendors/asana-get-task.json", import.meta.url), "utf8")) as { data: Record<string, unknown> };

export interface FakeAsanaTask { projects: string[]; parent?: string }

export interface FakeAsana {
  mcpUrl: URL;
  tokenUrl: URL;
  calls: Array<{ name: string; arguments: Record<string, unknown> }>;
  authorizations: Array<string | undefined>;
  /** Every refresh token presented to the token endpoint, in order. */
  refreshes: string[];
  /** When true, each refresh issues a new refresh token and revokes the one presented. */
  rotate: boolean;
  /** Revokes every access token issued so far, as if they had expired. */
  expireAccessTokens(): void;
  /** Revokes the current refresh token, as if the bot user's grant was removed in Asana. */
  revokeRefreshToken(): void;
  close(): Promise<void>;
}

export async function startFakeAsana(options: { clientId: string; clientSecret: string; refreshToken: string; tasks: Record<string, FakeAsanaTask> }): Promise<FakeAsana> {
  const tools = vendorTools("asana");
  const issued = new Set<string>();
  let validRefresh: string | undefined = options.refreshToken;
  let serial = 0;
  const text = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
  const fake = {
    calls: [] as FakeAsana["calls"],
    authorizations: [] as FakeAsana["authorizations"],
    refreshes: [] as string[],
    rotate: false,
    expireAccessTokens: () => { issued.clear(); },
    revokeRefreshToken: () => { validRefresh = undefined; },
  };
  const answer = (name: string, args: Record<string, unknown>) => {
    fake.calls.push({ name, arguments: args });
    if (name === "get_task") {
      const gid = String(args.task_id);
      const task = options.tasks[gid];
      if (!task) return { isError: true, content: [{ type: "text", text: "Error: task not found" }] };
      return text({ data: {
        ...GET_TASK.data, gid,
        projects: task.projects.map((project) => ({ gid: project, name: "Project", resource_type: "project" })),
        memberships: task.projects.map((project) => ({ project: { gid: project, name: "Project" } })),
        parent: task.parent === undefined ? null : { gid: task.parent, name: "Parent" },
      } });
    }
    if (name === "create_tasks") return text({ data: { succeeded: [{ gid: "1210000000000901", name: "created" }], failed: [] } });
    if (name === "add_comment") return text({ data: { gid: "1210000000000950", resource_subtype: "comment_added" } });
    if (name === "search_tasks" || name === "get_tasks") return text({ data: Object.keys(options.tasks).map((gid) => ({ gid, name: `Task ${gid}` })) });
    return text({ data: {} });
  };
  const server = createServer((request, response) => { void (async () => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/-/oauth_token" && request.method === "POST") {
      const form = new URLSearchParams(body);
      const json = (status: number, value: unknown) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
      if (form.get("client_id") !== options.clientId || form.get("client_secret") !== options.clientSecret) { json(401, { error: "invalid_client" }); return; }
      if (form.get("grant_type") !== "refresh_token") { json(400, { error: "unsupported_grant_type" }); return; }
      const presented = form.get("refresh_token") ?? "";
      fake.refreshes.push(presented);
      if (validRefresh === undefined || presented !== validRefresh) { json(400, { error: "invalid_grant", error_description: `refresh token ${presented} is not valid` }); return; }
      serial += 1;
      const accessToken = `asana-access-${serial}-${"x".repeat(48)}`;
      issued.add(accessToken);
      if (fake.rotate) validRefresh = `asana-refresh-rotated-${serial}-${"y".repeat(40)}`;
      json(200, { access_token: accessToken, token_type: "bearer", expires_in: 3600, refresh_token: validRefresh, data: { id: 1, name: "AgentX bot" } });
      return;
    }
    if (url.pathname !== "/v2/mcp") { response.writeHead(404).end(); return; }
    fake.authorizations.push(request.headers.authorization);
    if (request.method !== "POST") { response.writeHead(405).end(); return; }
    const bearer = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1];
    if (bearer === undefined || !issued.has(bearer)) { response.writeHead(401).end(); return; }
    const message = JSON.parse(body) as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    if (message.id === undefined) { response.writeHead(202).end(); return; }
    const result = message.method === "initialize"
      ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fake-asana", version: "1" } }
      : message.method === "tools/list" ? { tools } : answer(message.params?.name ?? "", message.params?.arguments ?? {});
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  })().catch(() => { response.writeHead(500).end(); }); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing fake Asana port");
  const origin = `http://127.0.0.1:${address.port}`;
  return Object.assign(fake, {
    mcpUrl: new URL(`${origin}/v2/mcp`),
    tokenUrl: new URL(`${origin}/-/oauth_token`),
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  });
}
```

- [ ] **Step 2: Write the flow test**

```ts
// tests/integration/asana-connector.test.ts
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { ASANA_MCP_ENDPOINT, ASANA_TOKEN_ENDPOINT, connectMcp } from "@agentx/gateway";
import { asanaConnectorType } from "../../packages/broker/src/aws/asana-connector-type.js";
import { githubConnectorType, type ConnectorType } from "../../packages/broker/src/aws/connector-types.js";
import { ConnectorCatalogSchema } from "../../packages/contracts/src/connectors.js";
import { SlackThreadWorkspaceResultSchema } from "../../packages/contracts/src/slack.js";
import { startFakeAsana, type FakeAsana } from "../support/fake-asana.js";
import { memorySecretStore } from "../support/refresh-token-fakes.js";
import { call, createBroker, ensureWorkspace, loadSlackBroker, markReady, orchestratorPrincipal, type Handler } from "../support/slack-broker.js";

const team = "T0BSHLLUGBD";
const channel = "C0123456789";
const thread = `${team}/${channel}/1695500000.000001`;
const pratik = "U0123456789";
const admin = { subject: "admin-subject", admin: true };
const service = { principal: orchestratorPrincipal, thread, slackUser: pratik };

const SECRET = "agentx/connectors/asana-bot";
const CLIENT = { clientId: "1210000000000777", clientSecret: `asana-client-secret-${"s".repeat(24)}` };
const REFRESH = `asana-refresh-original-${"r".repeat(40)}`;
const PROJECT = "1210000000000010";
const OTHER_PROJECT = "1210000000000020";
const TASKS = {
  "1210000000000101": { projects: [PROJECT] },
  "1210000000000201": { projects: [OTHER_PROJECT] },
  "1210000000000301": { projects: [], parent: "1210000000000101" },
};

const asanaConfig = {
  name: "asana", type: "asana", credentialRef: "asana-bot",
  scopes: [{ alias: "payments", projectGid: PROJECT }],
  tools: [
    { name: "search_tasks", access: "read" },
    { name: "get_task", access: "read" },
    { name: "get_tasks", access: "read" },
    { name: "create_tasks", access: "write" },
    { name: "add_comment", access: "write" },
  ],
};

function projectRegistrationBody(): Record<string, unknown> {
  return {
    definition: {
      name: "payments", revision: 1,
      repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }],
      setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
      integrations: { connectors: [asanaConfig] },
    },
    runtimeBinding: {
      runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/agentx_production_worker-YVirjlFgvk",
      endpointQualifier: "DEFAULT", deploymentMode: "instances-ebs",
      capacityProviderArn: "arn:aws:bedrock-agentcore:us-east-1:111122223333:capacity-provider/agentx_production_capacity_v3-VwkM93EABZ",
    },
    preflight: true,
  };
}

let currentFake: FakeAsana | undefined;

/** A broker serving asana against a fresh fake Asana (token endpoint and MCP server). */
async function setupFake() {
  const fake = await startFakeAsana({ ...CLIENT, refreshToken: REFRESH, tasks: TASKS });
  currentFake = fake;
  const connect: typeof connectMcp = (input) => {
    expect(input.endpoint.href).toBe(ASANA_MCP_ENDPOINT.href);
    return connectMcp({ ...input, endpoint: fake.mcpUrl });
  };
  const asana: ConnectorType = { type: "asana", resolve: (config, project, context) => asanaConnectorType.resolve(config, project, { ...context, connect }) };
  // The registry's token requests go to Asana's token endpoint; here that is the fake's.
  const fetchImplementation: typeof fetch = (url, init) => {
    const href = url instanceof URL ? url.href : typeof url === "string" ? url : url.url;
    expect(href).toBe(ASANA_TOKEN_ENDPOINT.href);
    return fetch(fake.tokenUrl, init);
  };
  const secrets = memorySecretStore({ [SECRET]: JSON.stringify({ ...CLIENT, refreshToken: REFRESH }), "agentx/connectors/asana-key": JSON.stringify({ apiKey: "not-an-asana-credential" }) });
  const { db, handler } = createBroker({
    connectorTypes: { github: githubConnectorType, asana },
    connectorCredentials: { secrets, githubApp: { ref: "github-app", secretName: "agentx/connectors/github-app" }, fetchImplementation },
  });
  return { fake, db, handler, secrets };
}

function registerCredential(handler: Handler, type = "oauth-refresh-token", secretName = SECRET) {
  return call(handler, { method: "POST", path: "/v1/admin/credentials", user: admin, body: { ref: "asana-bot", type, secretName } });
}

async function readyBroker() {
  const setup = await setupFake();
  expect((await registerCredential(setup.handler)).status).toBe(201);
  expect((await call(setup.handler, { method: "POST", path: "/v1/admin/projects", user: admin, body: projectRegistrationBody() })).status).toBe(201);
  expect((await call(setup.handler, { method: "PUT", path: `/v1/admin/slack/bindings/${team}/${channel}`, user: admin, body: { projectName: "payments" } })).status).toBe(200);
  const workspaceId = (await ensureWorkspace(setup.handler, thread, pratik)).body.workspaceId as string;
  markReady(setup.db, workspaceId);
  const path = `/v1/service/workspaces/${workspaceId}/connectors/asana`;
  const discovered = await call(setup.handler, { method: "GET", path: `${path}/tools`, service });
  expect(discovered.status).toBe(200);
  const catalog = ConnectorCatalogSchema.parse(discovered.body.catalog);
  const hashOf = (tool: string) => catalog.tools.find((entry) => entry.name === `asana__${tool}`)!.scopes[0]!.schemaHash;
  const run = (tool: string, args: Record<string, unknown>, requestId: string = randomUUID()) =>
    call(setup.handler, { method: "POST", path: `${path}/call`, service, body: { requestId, scope: "payments", tool, schemaHash: hashOf(tool), arguments: args } });
  return { ...setup, workspaceId, path, catalog, run };
}

beforeAll(async () => { await loadSlackBroker(); });

let log: MockInstance<typeof console.log>;
beforeEach(() => { log = vi.spyOn(console, "log").mockImplementation(() => undefined); });
afterEach(async () => {
  log.mockRestore();
  await currentFake?.close();
  currentFake = undefined;
});

const writes = (fake: FakeAsana) => fake.calls.filter((entry) => entry.name === "create_tasks" || entry.name === "add_comment");

describe("asana connector, end to end against a fake Asana", () => {
  it("refuses registration until an oauth-refresh-token credential is registered, then registers with a connected preflight", async () => {
    const { fake, handler } = await setupFake();
    const refused = await call(handler, { method: "POST", path: "/v1/admin/projects", user: admin, body: projectRegistrationBody() });
    expect(refused.body).toMatchObject({ error: { code: "CONFIG_INVALID", message: "connector asana: credential asana-bot is not registered; run agentx admin credential register first" } });

    expect((await registerCredential(handler, "static-secret", "agentx/connectors/asana-key")).status).toBe(201);
    const wrongType = await call(handler, { method: "POST", path: "/v1/admin/projects", user: admin, body: projectRegistrationBody() });
    expect(wrongType.body).toMatchObject({ error: { code: "CONFIG_INVALID", message: "connector asana: credential asana-bot is static-secret; an Asana connector needs oauth-refresh-token" } });

    expect((await registerCredential(handler)).status).toBe(201);
    const registered = await call(handler, { method: "POST", path: "/v1/admin/projects", user: admin, body: projectRegistrationBody() });
    expect(registered.status).toBe(201);
    expect(registered.body.preflight).toEqual({ connectors: [{
      name: "asana", status: "connected",
      offered: ["asana__search_tasks", "asana__get_task", "asana__get_tasks", "asana__create_tasks", "asana__add_comment"],
      skipped: [],
    }] });
    expect(fake.refreshes).toEqual([REFRESH]);
    for (const authorization of fake.authorizations) expect(authorization).toMatch(/^Bearer asana-access-1-/);
  });

  it("hides the project arguments, binds the registered project, and signs a comment", async () => {
    const { fake, db, workspaceId, catalog, run } = await readyBroker();
    const properties = (tool: string) => Object.keys(catalog.tools.find((entry) => entry.name === `asana__${tool}`)!.inputSchema.properties as Record<string, unknown>);
    expect(properties("search_tasks")).not.toContain("projects_any");
    expect(properties("create_tasks")).not.toContain("default_project");
    expect(properties("get_tasks")).not.toContain("project");

    expect((await run("search_tasks", { text: "login" })).body.result).toMatchObject({ status: "SUCCEEDED" });
    expect(fake.calls.at(-1)).toEqual({ name: "search_tasks", arguments: { text: "login", projects_any: PROJECT } });
    const requestId = randomUUID();
    expect((await run("create_tasks", { tasks: [{ name: "Flaky login" }] }, requestId)).body.result).toMatchObject({ status: "SUCCEEDED" });
    expect(fake.calls.at(-1)).toEqual({ name: "create_tasks", arguments: { tasks: [{ name: "Flaky login" }], default_project: PROJECT } });
    expect(db.get(`WORKSPACE#${workspaceId}`, `CONNECTOR#asana#${requestId}`)).toMatchObject({ entityType: "CONNECTOR_INVOCATION" });

    expect((await run("add_comment", { task_id: "1210000000000301", text: "Deploying now." })).body.result).toMatchObject({ status: "SUCCEEDED" });
    const comment = fake.calls.at(-1)!;
    expect(comment.name).toBe("add_comment");
    expect(String(comment.arguments.text)).toMatch(/^Deploying now\.\n\n—\nRequested by `Slack member U0123456789` via AgentX · https:\/\/slack\.com\/archives\/C0123456789\/p1695500000000001$/);
  });

  it("refuses a write to another project's task with zero upstream writes", async () => {
    const { fake, run } = await readyBroker();
    const comment = await run("add_comment", { task_id: "1210000000000201", text: "Deploying now." });
    expect(comment.body.result).toMatchObject({ status: "FAILED", reason: "policy_denied", text: "Asana task 1210000000000201 is not in the payments project this connector may use." });
    const create = await run("create_tasks", { tasks: [{ name: "Sub", parent: "1210000000000201" }] });
    expect(create.body.result).toMatchObject({ status: "FAILED", reason: "policy_denied" });
    const moved = await run("get_tasks", { tag: "1210000000000900" });
    expect(moved.body.result).toMatchObject({ status: "FAILED", reason: "policy_denied" });
    expect(writes(fake)).toEqual([]);
  });

  it("refreshes after Asana rejects an expired access token, and the call still succeeds", async () => {
    const { fake, run } = await readyBroker();
    fake.expireAccessTokens();
    expect((await run("get_task", { task_id: "1210000000000101" })).body.result).toMatchObject({ status: "SUCCEEDED" });
    expect(fake.refreshes).toEqual([REFRESH, REFRESH]);
  });

  it("writes a rotated refresh token back to the secret and uses it on the next refresh", async () => {
    const { fake, secrets, run } = await readyBroker();
    fake.rotate = true;
    fake.expireAccessTokens();
    expect((await run("get_task", { task_id: "1210000000000101" })).body.result).toMatchObject({ status: "SUCCEEDED" });
    const saved = (JSON.parse(secrets.values[SECRET]!) as { refreshToken: string }).refreshToken;
    expect(saved).toMatch(/^asana-refresh-rotated-2-/);
    expect(secrets.writes).toHaveLength(1);
    fake.expireAccessTokens();
    expect((await run("get_task", { task_id: "1210000000000101" })).body.result).toMatchObject({ status: "SUCCEEDED" });
    expect(fake.refreshes.slice(-1)).toEqual([saved]);
  });

  it("reports a revoked sign-in as not connected, naming the re-authorize command, and writes nothing", async () => {
    const { fake, run } = await readyBroker();
    fake.revokeRefreshToken();
    fake.expireAccessTokens();
    const result = await run("add_comment", { task_id: "1210000000000101", text: "x" });
    expect(result.body.result).toMatchObject({
      status: "FAILED", reason: "not_connected",
      text: "Asana is not connected for this project: credential asana-bot: the token endpoint refused the refresh token with HTTP 400 (invalid_grant); the bot user must sign in again with agentx admin credential authorize --ref asana-bot. An administrator must fix its credential.",
    });
    expect(writes(fake)).toEqual([]);
  });

  it("lists asana at thread setup for services that opt in", async () => {
    const { handler } = await readyBroker();
    const response = await call(handler, { method: "POST", path: "/v1/service/threads/workspace", service,
      body: { requestId: randomUUID(), includeConnectors: true, includeAllConnectorTypes: true } });
    const { requestId, ...result } = response.body;
    expect(typeof requestId).toBe("string");
    const parsed = SlackThreadWorkspaceResultSchema.parse(result);
    expect(parsed.outcome === "WORKSPACE" && parsed.connectors).toEqual([{ name: "asana", type: "asana", label: "Asana tasks", scopes: ["payments"], connected: true }]);
  });

  it("never reveals an access token, a refresh token or the client secret in responses or logs", async () => {
    const { fake, secrets, handler, run, catalog } = await readyBroker();
    fake.rotate = true;
    const responses: unknown[] = [catalog];
    fake.expireAccessTokens();
    responses.push((await run("get_task", { task_id: "1210000000000101" })).body);
    responses.push((await run("add_comment", { task_id: "1210000000000201", text: "x" })).body);
    responses.push((await call(handler, { method: "GET", path: "/v1/admin/credentials", user: admin })).body);
    fake.revokeRefreshToken();
    fake.expireAccessTokens();
    responses.push((await run("get_task", { task_id: "1210000000000101" })).body);
    const secretsSeen = [REFRESH, CLIENT.clientSecret, (JSON.parse(secrets.values[SECRET]!) as { refreshToken: string }).refreshToken, "asana-access-"];
    const text = `${JSON.stringify(responses)}\n${log.mock.calls.map(([line]) => String(line)).join("\n")}`;
    for (const value of secretsSeen) expect(text).not.toContain(value);
  });
});
```

- [ ] **Step 3: Run it**

Run: `npm run build && npx vitest run tests/integration/asana-connector.test.ts`
Expected: PASS, 8 tests. If one fails, find the task that owns the behaviour, add a failing unit
test there that reproduces it, and fix it in that task's code.

- [ ] **Step 4: Full check and commit**

```bash
npm run typecheck && npm run lint && npm run build && npm test
git add tests/support/fake-asana.ts tests/integration/asana-connector.test.ts
git commit -m "test(integration): drive the asana connector end to end against a fake Asana token endpoint and MCP server

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Setup guide, documents, evaluation cases and the presentation snapshot (T044)

**Files:**
- Create: `docs/connectors/asana.md`, `tests/eval/cases/asana.jsonl`,
  `tests/eval/fixtures/payments-asana.yaml`, `tests/eval/catalogs/asana.json`
- Modify: `tests/contract/tool-presentation.test.ts` (and its snapshot file), `README.md`,
  `specs/013-connector-gateway/contracts/project-config.md`, `specs/013-connector-gateway/tasks.md`

**Interfaces:**
- Consumes: Task 5's `asanaConnector` and fixture loader; Task 6's type (the eval fixture resolves
  through `BUILT_IN_CONNECTOR_TYPES`).
- Produces: nothing code imports.

- [ ] **Step 1: Write the failing evaluation cases and fixture**

`tests/eval/cases/asana.jsonl` (the existing `asana-not-connected` case in `seed.jsonl` already
covers the not-connected refusal; do not add a second case with that ID):

```json
{"id":"asana-list-open","project":"fixtures/payments-asana.yaml","prompt":"what's still open in Asana for payments?","expect":{"tool":"asana__search_tasks"},"source":"synthetic"}
{"id":"asana-read-one","project":"fixtures/payments-asana.yaml","prompt":"show me Asana task 1210000000000101","expect":{"tool":"asana__get_task","argsSubset":{"task_id":"1210000000000101"}},"source":"synthetic"}
{"id":"asana-create","project":"fixtures/payments-asana.yaml","prompt":"create an Asana task titled Fix the flaky login test","expect":{"tool":"asana__create_tasks"},"source":"synthetic"}
{"id":"asana-comment","project":"fixtures/payments-asana.yaml","prompt":"comment on Asana task 1210000000000101 that the fix is deployed","expect":{"tool":"asana__add_comment","argsSubset":{"task_id":"1210000000000101"}},"source":"synthetic"}
{"id":"asana-complete","project":"fixtures/payments-asana.yaml","prompt":"mark Asana task 1210000000000101 as complete","expect":{"tool":"asana__update_tasks"},"source":"synthetic"}
{"id":"asana-vs-github","project":"fixtures/payments-asana.yaml","prompt":"list the open GitHub issues in payments-api","expect":{"tool":"github__list_issues"},"source":"synthetic"}
```

`tests/eval/fixtures/payments-asana.yaml`:

```yaml
# GitHub plus an Asana connector scoped to one project, as docs/connectors/asana.md sets up.
name: payments
revision: 1
repositories:
  - name: payments-api
    url: https://github.com/example/payments-api.git
    path: repo/payments-api
    defaultBranch: main
    credentialRef: github-agentx-sdlc
setup: []
readiness: []
orchestratorInstructions: Delegate every repository read, edit, build and test to the worker.
integrations:
  connectors:
    - name: github
      type: github
      scopes: all-repositories
      tools:
        - { name: list_issues, access: read }
    - name: asana
      type: asana
      credentialRef: asana-bot
      scopes:
        - { alias: payments, projectGid: "1210000000000010" }
      tools:
        - { name: search_tasks, access: read }
        - { name: get_task, access: read }
        - { name: create_tasks, access: write }
        - { name: update_tasks, access: write }
        - { name: add_comment, access: write }
```

- [ ] **Step 2: Run and watch the harness fail**

Run: `npm run build && npx vitest run tests/contract/eval-harness.test.ts`
Expected: FAIL; there is no recorded catalog `tests/eval/catalogs/asana.json`.

- [ ] **Step 3: Generate the recorded catalog from the vendor fixture**

Recorded catalogs already lack the binder's bound properties (see `tests/eval/presentation.ts`).
Generate it deterministically:

```sh
node --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs";
const tools = JSON.parse(readFileSync("tests/fixtures/vendors/asana-tools.json", "utf8"));
const access = { get_task: "read", get_task_stories: "read", get_tasks: "read", search_tasks: "read", get_project: "read", create_tasks: "write", update_tasks: "write", add_comment: "write" };
const bound = ["project", "project_id", "default_project", "projects_any"];
const catalog = tools.filter((tool) => Object.hasOwn(access, tool.name)).map((tool) => {
  const inputSchema = structuredClone(tool.inputSchema);
  for (const name of bound) delete inputSchema.properties[name];
  if (Array.isArray(inputSchema.required)) inputSchema.required = inputSchema.required.filter((name) => !bound.includes(name));
  return { name: tool.name, access: access[tool.name], description: tool.description, inputSchema };
});
writeFileSync("tests/eval/catalogs/asana.json", `${JSON.stringify(catalog, null, 2)}\n`);
console.log(catalog.map((tool) => tool.name).join(","));
'
```

Expected output: `get_project,search_tasks,get_task,get_task_stories,create_tasks,update_tasks,add_comment,get_tasks`.
Run the Step 2 command again. Expected: PASS.

- [ ] **Step 4: Add the presentation snapshot**

Append to `tests/contract/tool-presentation.test.ts`, inside the `describe("what the orchestrator sees", ...)` block, after the Linear test:

```ts
  it("for a one-project Asana connector, from the recorded vendor fixture", async () => {
    const { asanaConnector } = await import("../../packages/gateway/src/index.js");
    const connector = asanaConnector({ issue: () => { throw new Error("not used by reviewTools"); } });
    const approvals = [
      { name: "search_tasks", access: "read" as const }, { name: "get_task", access: "read" as const },
      { name: "create_tasks", access: "write" as const }, { name: "update_tasks", access: "write" as const }, { name: "add_comment", access: "write" as const },
    ];
    const reviewed = reviewTools({ tools: vendorTools("asana") }, connector, {
      workspaceId: "registration", ownerKey: "owner-key", scopeAlias: "payments", scope: { alias: "payments", projectGid: "1210000000000010" }, policy: { tools: approvals },
    });
    expect(reviewed.skipped).toEqual([]);
    const presented = presentCatalog({ connector: "asana", label: "Asana", scopeNoun: "Asana project", approvals, scopes: [{ alias: "payments", tools: reviewed.tools }] });
    const catalog: ConnectorCatalog = { connector: "asana", tools: presented.tools, skipped: presented.skipped };
    const manifest = capabilitiesManifest({
      repositories: [],
      connectors: [{ name: "asana", type: "asana", label: "Asana tasks", scopes: ["payments"], connected: true }],
      catalogs: [catalog],
    });
    expect({ tools: presented.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })), skipped: presented.skipped }).toMatchSnapshot();
    expect(manifest.split("\n").find((line) => line.startsWith("- Asana tasks"))).toMatchSnapshot();
    expect(presented.tools.every((tool) => tool.description.length <= 2_048)).toBe(true);
  });
```

Run: `npx vitest run tests/contract/tool-presentation.test.ts`
Expected: PASS with "2 written" snapshots. Read the new entries in
`tests/contract/__snapshots__/tool-presentation.test.ts.snap`: five `asana__*` tools; no
`projects_any` in `asana__search_tasks` and no `default_project` in `asana__create_tasks`; the
manifest line `- Asana tasks (payments): asana__* tools`. Never run with `-u` to make an existing
snapshot pass.

- [ ] **Step 5: Write the setup guide**

Create `docs/connectors/asana.md`:

````markdown
# Asana connector

AgentX is open source and self-hosted. There is no shared Asana app. Your organisation creates its
own Asana app and its own bot user, stores the app's client secret and the bot user's refresh
token in your own AWS Secrets Manager, and registers them with `agentx admin credential authorize`.
This guide walks you through that, end to end, for one Asana project.

## What you get

AgentX can search, list, read, create, update and comment on Asana tasks in one project from
Slack. It acts as one Asana user, the bot user. Every task or comment it writes shows that user as
the author. A plain-text comment ends with a footer naming the Slack member who asked and linking
the thread.

## How access works

Asana's MCP server, `https://mcp.asana.com/v2/mcp`, accepts only OAuth tokens that act as a
signed-in user. It takes no API key and no client credentials. So AgentX works as a bot user that
signs in once in a browser. After that, AgentX renews its access every hour on its own with the
refresh token from that sign-in.

Two limits apply:

1. **The bot user (mandatory).** An Asana OAuth token has no scopes: it reaches everything the bot
   user can see. Make the bot user a guest, or a member, of only the projects AgentX may use
   (Step 1), and prove it (Step 6). That is the limit that counts.
2. **The project file.** AgentX sets the project on every tool that takes one, and before it reads
   or changes an existing task, it checks that the task is in the project. See
   [What AgentX enforces](#what-agentx-enforces). This is a second line behind Step 1.

## Before you start

You need:

- An Asana account that can create apps in the Asana developer console, and permission to invite
  a user to your project.
- An email address for the bot user that nobody uses for anything else. A plus address such as
  `you+agentx@gmail.com` works.
- An AgentX control plane you can reach with `agentx login` as an administrator.
- AWS credentials for the control plane's account and region that can create, read, write and tag
  secrets: `secretsmanager:CreateSecret`, `GetSecretValue`, `PutSecretValue` and `TagResource` on
  `agentx/connectors/*`.
- A browser on the machine where you run `agentx`, and local port 8765 free.
- `jq` (included in macOS 15 and later).

## Step 1: Create the bot user and share only the project

1. Invite the bot user's email to the Asana project AgentX will use, with **Editor** access, so it
   can create tasks and comment. An address outside your organisation's email domain joins as a
   **guest**: it sees only what is shared with it, which is what you want.
2. Accept the invitation from the bot user's inbox and set its password.
3. Do not add the bot user to any team, portfolio or other project.

## Step 2: Create the Asana MCP app

1. Open the Asana developer console, `https://app.asana.com/0/my-apps`, and choose **Create new
   app**.
2. For the app type, choose **Asana MCP**. Not "External MCP", and not an API app: only an Asana MCP
   app can call `https://mcp.asana.com/v2/mcp`.
3. After the app is created, open its settings and add this redirect URL, exactly:
   `http://localhost:8765/callback`.
4. Copy the **Client ID** and the **Client secret**. There are no scopes to choose.

Never paste the client secret into a chat message or a screenshot. If it is ever exposed, reset
it in the developer console, then repeat Steps 3 and 4.

## Step 3: Store the app's client in Secrets Manager

The secret name must start with `agentx/connectors/`. Copy the client secret to the clipboard, then
run this. It asks for the client ID, which is not secret, and reads the client secret from the
clipboard so it never appears in your shell history:

```sh
export AWS_PROFILE=<your deployer profile> AWS_REGION=<your region>
printf 'Asana client ID: '; read -r ASANA_CLIENT_ID
pbpaste | tr -d '\n' | jq -Rc --arg id "$ASANA_CLIENT_ID" '{clientId: $id, clientSecret: .}' \
  | aws secretsmanager create-secret --name agentx/connectors/asana-bot \
      --tags Key=agentx-writable,Value=refresh-token --secret-string file:///dev/stdin
pbcopy < /dev/null
```

On Linux, replace `pbpaste` with `xclip -o -selection clipboard`. Use the default
`aws/secretsmanager` key. If you use a customer-managed KMS key, grant the broker role
`kms:Decrypt` and `kms:GenerateDataKey` on it.

The `agentx-writable` tag lets AgentX write a new refresh token back to this secret if Asana ever
issues one. AgentX may write only secrets with this tag. Step 4 adds it too, if you left it out.

## Step 4: Sign the bot user in and register the credential

In your browser, sign in to Asana as the bot user, or use a private window, so the sign-in is the
bot user's and not yours. Then run:

```sh
agentx admin credential authorize --ref asana-bot \
  --secret agentx/connectors/asana-bot --provider asana
```

The command opens Asana's sign-in page and prints its address too, in case no browser opens.
Approve access as the bot user. The browser shows "AgentX received the sign-in", and the command
prints:

```text
Stored the refresh token in agentx/connectors/asana-bot and registered asana-bot as oauth-refresh-token.
```

What the command did: it signed in with PKCE and a one-time state value, listened only on
`127.0.0.1:8765`, exchanged the code for a refresh token, wrote the refresh token into the secret
beside the client, tagged the secret, and registered it. It never prints a token, the code or the
client secret. `agentx admin credential list` now shows `asana-bot` with type
`oauth-refresh-token`.

If you run `agentx` on a remote machine over SSH, forward the port first:
`ssh -L 8765:127.0.0.1:8765 <host>`. The browser on your own machine then reaches the command.

## Step 5: Find the project GID

Open the project in Asana. Its address contains a long number after `/project/` (for example
`https://app.asana.com/1/1200000000000001/project/1210000000000010/list/...`) or, in older links,
right after `/0/` (`https://app.asana.com/0/1210000000000010/...`). That number is the project GID.

## Step 6: Prove the bot user sees only its project (mandatory)

Signed in to Asana as the bot user:

1. The sidebar lists only the project from Step 1, and no teams.
2. Search for the name of a task you know is in another project of your workspace. Asana finds
   nothing.

If the bot user sees more, remove it from those projects or teams and check again. Until it
passes, the check in [What AgentX enforces](#what-agentx-enforces) is the only limit.

## Step 7: Add Asana to the project file

Add a connector to `integrations.connectors`, with one scope per project:

```yaml
integrations:
  connectors:
    - name: asana
      type: asana
      credentialRef: asana-bot
      scopes:
        - { alias: payments, projectGid: "1210000000000010" }
      tools:
        - name: search_tasks
          access: read
          description: >-
            Search tasks in the payments Asana project by text, assignee, due date or completion.
            Use for "what's open" or "find the task about". Not for GitHub issues.
        - { name: get_task, access: read }
        - { name: create_tasks, access: write }
        - { name: update_tasks, access: write }
        - { name: add_comment, access: write }
```

Only these tools can be approved, each with the access shown:

| Tool | Access |
|---|---|
| `get_task`, `get_task_stories`, `get_tasks`, `search_tasks`, `get_project` | `read` |
| `create_tasks`, `update_tasks`, `add_comment` | `write` |

`search_tasks` works only on paid Asana plans. On a free workspace, approve `get_tasks` instead.
Registration refuses any other Asana tool, because AgentX cannot hold it to a project.

## Step 8: Register the project and read the preflight

Register the revision the usual way (`agentx --project <name> admin project register --file
<file> ...`). With `--json`, the result's `preflight` should read `"status":"connected"` for
`asana`, with each approved tool under `offered` and nothing under `skipped`.

Registration is refused if the credential reference is not registered or is not
`oauth-refresh-token`. It is not refused if Asana refuses the sign-in: preflight shows
`not_connected` with the reason, and you fix it with Step 4.

## Step 9: Try it in Slack

In a thread in a channel bound to the project, ask "what's open in Asana?", then "create an Asana
task titled Test from AgentX". The task appears in the project, created by the bot user.

## What AgentX enforces

The project GID is set by AgentX on every tool that takes one (`project`, `project_id`,
`default_project` and `projects_any`). The model cannot choose it; a request that tries is refused
before AgentX contacts Asana.

Before a call reads or changes an existing task, AgentX reads that task with `get_task` and
refuses the call unless the task is in the project. A subtask that is in no project itself is
accepted when its parent, up to three levels up, is in the project. This covers the task a call
names, and in `create_tasks` and `update_tasks` also every parent and dependency. A call can name
at most 10 tasks, and each check costs one extra read.

These are refused outright, because they reach outside the project or move a task between
projects: `tag`, `section`, `user_task_list` and `assignee` on `get_tasks` (use `search_tasks` with
`assignee_any` instead); `project_id` other than the project's own, `section_id` and
`assignee_section` on `create_tasks`; `add_projects`, `remove_projects` and `assignee_section` on
`update_tasks`. Task URLs and names are refused; the model must pass the task ID.

Not covered by these checks, so only Step 1 holds these to the project:

- Reply contents. A task in the project can list subtasks, dependencies or other projects it is
  also in, and AgentX returns what Asana returns.
- Users, custom fields and followers that a write names.

Only a comment's plain `text` is signed. A comment written as `html_text`, and the notes of tasks
created or updated, carry no footer.

Turn records keep each request's text and tool arguments for 30 days, with known credential
shapes redacted on a best-effort basis; they are readable only by administrators.

## Re-authorizing and disconnecting

If the bot user's access is removed, its password is reset or the app's client secret changes, the
refresh token stops working. AgentX then answers that Asana is not connected and names the fix:
run Step 4 again. If you reset the client secret, first update the secret's `clientSecret` with
Step 3's pipe, using `aws secretsmanager put-secret-value --secret-id agentx/connectors/asana-bot`
in place of `create-secret` and dropping `--tags`, then run Step 4.

To disconnect AgentX, signed in as the bot user, remove the app's access in Asana's account
settings, then delete the secret.

## Troubleshooting

- **"port 8765 is in use".** Another program, often another `agentx` command, is listening on it.
  Stop it and run Step 4 again.
- **Asana's page says the redirect URI is not allowed.** The app's redirect URL must be exactly
  `http://localhost:8765/callback` (Step 2, item 3).
- **"the token endpoint returned no refresh token".** The app is not an Asana MCP app. Create one
  of that type (Step 2).
- **"the token endpoint refused the sign-in with HTTP 400 (invalid_grant)".** The sign-in took too
  long or was used twice. Run Step 4 again.
- **Every call fails as not connected, "sign in again with agentx admin credential authorize".**
  The refresh token was revoked. Run Step 4 again.
- **A log line `connector.refresh_token_unsaved`.** Asana issued a new refresh token and AgentX
  could not save it, usually because the secret lacks the `agentx-writable` tag. Run Step 4 again,
  which tags the secret.
- **"Could not confirm that Asana task ... is in the ... project".** Asana answered `get_task` in a
  shape AgentX does not accept, so it refused the call rather than guess. Report it with the
  connector's version.
- **`search_tasks` fails with a vendor error.** The workspace is on a free plan. Approve
  `get_tasks` instead.
````

- [ ] **Step 6: Amend the other documents**

`README.md`, "Connector credentials": replace the two-shape sentence with:

```markdown
A secret is one of three shapes: `static-secret` is `{"apiKey": "..."}`; `oauth-client-credentials`
is `{"clientId", "clientSecret", "scopes": [...]}`; `oauth-refresh-token` is
`{"clientId", "clientSecret", "refreshToken"}`, written by `agentx admin credential authorize` after a
bot user signs in once in a browser. The broker may write a rotated refresh token back only to a
secret tagged `agentx-writable: refresh-token`.
```

and after the Jira sentence (`... see [docs/connectors/jira.md](docs/connectors/jira.md).`) add:

```markdown
Asana reads an
`oauth-refresh-token` credential for a bot user; see [docs/connectors/asana.md](docs/connectors/asana.md).
```

`specs/013-connector-gateway/contracts/project-config.md`: change the row
"Connector type other than `github`, `linear` or `jira`" to "... `github`, `linear`, `jira` or `asana`";
add after the "Jira credential reference of another type" row:

```markdown
| Asana tool other than the eight guarded tools, or with the wrong `access` | Refused, naming the tool (phase 7) |
| Asana scopes with a repeated alias or project GID | Refused (phase 7) |
| Asana credential reference that is not `oauth-refresh-token` | Refused, naming the type (phase 7) |
```

add to "Mandatory vendor-side restrictions":

```markdown
| `asana` | A dedicated bot user that is a guest or member of only the intended projects, proven by the setup guide's Step 6; an Asana MCP app owned by the organisation (phase 7) |
```

and before "The secret must use the default `aws/secretsmanager` key." add:

````markdown
An Asana credential is created by a browser sign-in instead (phase 7; see
[docs/connectors/asana.md](../../../docs/connectors/asana.md)):

```sh
agentx admin credential authorize --ref asana-bot \
  --secret agentx/connectors/asana-bot --provider asana   # secret first holds {"clientId","clientSecret"}
```
````

`specs/013-connector-gateway/tasks.md`: check T041, T042, T043 and T044.

- [ ] **Step 7: Check the guide's commands and style**

Run: `grep -n "—" docs/connectors/asana.md` (expected: no output) and
`grep -n "agentx admin credential authorize" docs/connectors/asana.md` (expected: the Step 4
command matches `agentx admin credential authorize --help`). Run
`node packages/cli/dist/main.js admin credential authorize --help` and compare the options.

- [ ] **Step 8: Full check and commit**

`docs/` is in `.gitignore`; the connector guides are force-added.

```bash
npm run typecheck && npm run lint && npm run build && npm test
git add -f docs/connectors/asana.md
git add README.md specs/013-connector-gateway/contracts/project-config.md specs/013-connector-gateway/tasks.md \
  tests/eval/cases/asana.jsonl tests/eval/fixtures/payments-asana.yaml tests/eval/catalogs/asana.json \
  tests/contract/tool-presentation.test.ts tests/contract/__snapshots__/tool-presentation.test.ts.snap
git commit -m "docs(asana): add the self-hosted setup guide, evaluation cases and the presentation snapshot

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Live check against a real Asana project (T045, controller and user)

Nothing here is inferred from mocks. Part A runs before the PR, on the controller's machine, with
the Keychain client ID and secret and one browser sign-in by the user. Part B runs after the
automatic production release. Check T045 only after Part B's evidence exists.

**Files:**
- Create: `tests/live/asana-live.test.ts`
- Modify: `tests/fixtures/vendors/asana-get-task.json` (if the captured shape differs),
  `specs/013-connector-gateway/quickstart.md` (`## Asana (US6)` evidence),
  `docs/connectors/asana.md` (correct any click path that differed), `specs/013-connector-gateway/tasks.md`

**Interfaces:**
- Consumes: `authorizeCredential` (Task 4), `openSystemBrowser`, `asanaConnectorType` (Task 6),
  `memorySecretStore` (Task 2), the broker harness.
- Produces: evidence only.

- [ ] **Step 1: Write the live test (skipped unless the client ID is set)**

```ts
// tests/live/asana-live.test.ts
// A live check against the real Asana MCP server (https://mcp.asana.com/v2/mcp) and token
// endpoint, skipped unless AGENTX_LIVE_ASANA_CLIENT_ID is set. The bot user signs in once in a
// browser through the real `agentx admin credential authorize` code (secrets held in memory, the
// control plane served in process). Then the broker from this branch registers the project,
// searches, creates a task, reads it, comments on it, refuses a task outside the project, refreshes
// headlessly from a second broker, and reports a revoked refresh token as not connected.
// Environment: AGENTX_LIVE_ASANA_CLIENT_ID, AGENTX_LIVE_ASANA_CLIENT_SECRET, AGENTX_LIVE_ASANA_PROJECT
// (the in-scope project GID) and, optionally, AGENTX_LIVE_ASANA_OUTSIDE_TASK (a task GID in another
// project). It creates one real task and one comment in the project. It prints evidence lines, and
// writes the raw get_task text to AGENTX_LIVE_ASANA_CAPTURE when set, never a token.
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { authorizeCredential, type AuthorizeSecrets } from "../../packages/cli/src/admin/authorize.js";
import { openSystemBrowser } from "../../packages/cli/src/auth.js";
import { ASANA_MCP_ENDPOINT, ASANA_TOKEN_ENDPOINT, connectMcp, resultText } from "@agentx/gateway";
import { asanaConnectorType } from "../../packages/broker/src/aws/asana-connector-type.js";
import { githubConnectorType } from "../../packages/broker/src/aws/connector-types.js";
import { CredentialRegistry } from "../../packages/broker/src/aws/credentials.js";
import { ConnectorCatalogSchema } from "../../packages/contracts/src/connectors.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { memorySecretStore } from "../support/refresh-token-fakes.js";
import { call, createBroker, ensureWorkspace, loadSlackBroker, markReady, orchestratorPrincipal, type Handler } from "../support/slack-broker.js";

const CLIENT_ID = process.env.AGENTX_LIVE_ASANA_CLIENT_ID;
const CLIENT_SECRET = process.env.AGENTX_LIVE_ASANA_CLIENT_SECRET;
const PROJECT = process.env.AGENTX_LIVE_ASANA_PROJECT;
const OUTSIDE_TASK = process.env.AGENTX_LIVE_ASANA_OUTSIDE_TASK ?? "1199999999999999";
const CAPTURE = process.env.AGENTX_LIVE_ASANA_CAPTURE;

const team = "T0BSHLLUGBD";
const channel = "C0123456789";
const thread = `${team}/${channel}/1695500000.000001`;
const pratik = "U0123456789";
const admin = { subject: "admin-subject", admin: true };
const service = { principal: orchestratorPrincipal, thread, slackUser: pratik };
const CONTROL_PLANE = "https://agentx.live.test";
const SECRET = "agentx/connectors/asana-bot";
const REVOKED_SECRET = "agentx/connectors/asana-revoked";

function registrationBody(revision: number, credentialRef: string, projectGid: string): Record<string, unknown> {
  return {
    definition: {
      name: "payments", revision,
      repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }],
      setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
      integrations: { connectors: [{
        name: "asana", type: "asana", credentialRef, scopes: [{ alias: "live", projectGid }],
        tools: [
          { name: "search_tasks", access: "read" }, { name: "get_tasks", access: "read" }, { name: "get_task", access: "read" },
          { name: "create_tasks", access: "write" }, { name: "add_comment", access: "write" },
        ],
      }] },
    },
    runtimeBinding: {
      runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/agentx_production_worker-YVirjlFgvk",
      endpointQualifier: "DEFAULT", deploymentMode: "instances-ebs",
      capacityProviderArn: "arn:aws:bedrock-agentcore:us-east-1:111122223333:capacity-provider/agentx_production_capacity_v3-VwkM93EABZ",
    },
    preflight: true,
  };
}

/** Serves the CLI's control-plane calls from the in-process broker, and everything else from the network. */
function routedFetch(handler: () => Handler): typeof fetch {
  return async (url, init) => {
    const href = url instanceof URL ? url.href : typeof url === "string" ? url : url.url;
    if (!href.startsWith(CONTROL_PLANE)) return fetch(url, init);
    const response = await call(handler(), { method: init?.method ?? "GET", path: new URL(href).pathname, user: admin, body: JSON.parse(init?.body as string) as unknown });
    return Response.json(response.body, { status: response.status });
  };
}

describe.skipIf(!CLIENT_ID)("asana connector, live check against the real project", () => {
  it("signs in once, registers, searches, creates, reads, comments, refuses, refreshes and reports a revoked sign-in", async () => {
    if (!CLIENT_ID || !CLIENT_SECRET || !PROJECT) throw new Error("AGENTX_LIVE_ASANA_CLIENT_ID, AGENTX_LIVE_ASANA_CLIENT_SECRET and AGENTX_LIVE_ASANA_PROJECT are required");
    await loadSlackBroker();
    const secrets = memorySecretStore({
      [SECRET]: JSON.stringify({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }),
      [REVOKED_SECRET]: JSON.stringify({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, refreshToken: "revoked-refresh-token" }),
    });
    const printed: string[] = [];
    const evidence = (line: string) => { printed.push(line); console.log(`asana live check: ${line}`); };
    const broker = () => createBroker({ connectorTypes: { github: githubConnectorType, asana: asanaConnectorType }, connectorCredentials: { secrets, githubApp: { ref: "github-app", secretName: "agentx/connectors/github-app" } } });
    const first = broker();

    // Step 1: the one-time browser sign-in through the real authorize code, registering in process.
    const authorizeSecrets: AuthorizeSecrets = { read: (name) => secrets.read(name), write: (name, value) => secrets.write(name, value), tag: async () => undefined };
    await authorizeCredential({
      controlPlaneUrl: CONTROL_PLANE, accessToken: "unused", ref: "asana-bot", secretName: SECRET, provider: "asana",
      secrets: authorizeSecrets, openBrowser: openSystemBrowser, showUrl: (url) => { console.log(`Sign in as the bot user: ${url}`); },
      fetchImplementation: routedFetch(() => first.handler),
    });
    const refreshToken = (JSON.parse(secrets.values[SECRET]!) as { refreshToken: string }).refreshToken;
    evidence(`step 1 signed in; refresh token stored (${refreshToken.length} characters)`);

    // Step 2: register the project with preflight.
    const registered = await call(first.handler, { method: "POST", path: "/v1/admin/projects", user: admin, body: registrationBody(1, "asana-bot", PROJECT) });
    expect(registered.status).toBe(201);
    const preflight = registered.body.preflight as { connectors: Array<{ status: string; offered: string[]; skipped: unknown[] }> };
    expect(preflight.connectors[0]).toMatchObject({ status: "connected", skipped: [] });
    evidence(`step 2 preflight ${preflight.connectors[0]!.status}, offered ${preflight.connectors[0]!.offered.join(", ")}`);
    expect((await call(first.handler, { method: "PUT", path: `/v1/admin/slack/bindings/${team}/${channel}`, user: admin, body: { projectName: "payments" } })).status).toBe(200);
    const workspaceId = (await ensureWorkspace(first.handler, thread, pratik)).body.workspaceId as string;
    markReady(first.db, workspaceId);
    const path = `/v1/service/workspaces/${workspaceId}/connectors/asana`;
    const catalog = ConnectorCatalogSchema.parse((await call(first.handler, { method: "GET", path: `${path}/tools`, service })).body.catalog);
    const run = async (handler: Handler, tool: string, args: Record<string, unknown>) => {
      const schemaHash = catalog.tools.find((entry) => entry.name === `asana__${tool}`)!.scopes[0]!.schemaHash;
      const response = await call(handler, { method: "POST", path: `${path}/call`, service, body: { requestId: randomUUID(), scope: "live", tool, schemaHash, arguments: args } });
      return response.body.result as { status: string; reason?: string; text: string };
    };

    // Step 3: list and search (search_tasks needs a paid Asana plan; a free workspace answers vendor_error).
    const listed = await run(first.handler, "get_tasks", { limit: 5 });
    expect(listed.status).toBe("SUCCEEDED");
    const searched = await run(first.handler, "search_tasks", { completed: false, limit: 5 });
    evidence(`step 3 get_tasks ${listed.status}; search_tasks ${searched.status}${searched.reason ? ` (${searched.reason})` : ""}`);

    // Step 4: create a task in the project.
    const created = await run(first.handler, "create_tasks", { tasks: [{ name: `AgentX live check ${new Date().toISOString()}`, notes: "Created by the AgentX phase 7 live check." }] });
    expect(created.status).toBe("SUCCEEDED");
    const taskGid = /"gid"\s*:\s*"(\d+)"/.exec(created.text)?.[1];
    expect(taskGid).toBeDefined();
    evidence(`step 4 create_tasks ${created.status}, task ${taskGid}`);

    // Step 5: capture Asana's raw get_task answer (the shape the guard parses), then read the task
    // through the broker, which only succeeds if the guard accepts that shape.
    if (CAPTURE) {
      const db = new FakeDynamoDb();
      db.set({ pk: "CREDENTIALS", sk: "REF#asana-bot", entityType: "CREDENTIAL", ref: "asana-bot", type: "oauth-refresh-token", secretName: SECRET, registeredBy: "live", registeredAt: new Date().toISOString() });
      const registry = new CredentialRegistry({ secrets, githubApp: { ref: "github-app", secretName: "agentx/connectors/github-app" }, documentClient: db as never, tableName: "state" });
      const { token } = await registry.provider("asana-bot", { tokenEndpoint: ASANA_TOKEN_ENDPOINT }).issue(undefined, "read");
      const connection = await connectMcp({ endpoint: ASANA_MCP_ENDPOINT, token, tools: ["get_task"], signal: AbortSignal.timeout(20_000) });
      try {
        await writeFile(CAPTURE, resultText(await connection.call("get_task", { task_id: taskGid!, include_subtasks: false, include_comments: false })));
      } finally { await connection.close(); }
    }
    const read = await run(first.handler, "get_task", { task_id: taskGid });
    evidence(`step 5 get_task ${read.status}${read.reason ? ` (${read.reason})` : ""}`);
    expect(read.status).toBe("SUCCEEDED");

    // Step 6: comment on it, signed.
    const commented = await run(first.handler, "add_comment", { task_id: taskGid, text: "Live check comment." });
    expect(commented.status).toBe("SUCCEEDED");
    evidence(`step 6 add_comment ${commented.status}`);

    // Step 7: a task outside the project is refused before any write.
    const refused = await run(first.handler, "add_comment", { task_id: OUTSIDE_TASK, text: "Must not be written." });
    expect(refused).toMatchObject({ status: "FAILED", reason: "policy_denied" });
    evidence(`step 7 outside task ${refused.status} ${refused.reason}`);

    // Step 8: a second broker with no cached access token refreshes headlessly.
    const second = broker();
    for (const item of first.db.items.values()) if (item.sk !== "TOKEN#refresh-token") second.db.set(structuredClone(item));
    const refreshed = await run(second.handler, "get_task", { task_id: taskGid });
    expect(refreshed.status).toBe("SUCCEEDED");
    const after = (JSON.parse(secrets.values[SECRET]!) as { refreshToken: string }).refreshToken;
    evidence(`step 8 refreshed from a second broker ${refreshed.status}; refresh token rotated: ${after === refreshToken ? "no" : "yes (written back)"}`);

    // Step 9: a revoked refresh token reports not connected at registration preflight.
    expect((await call(second.handler, { method: "POST", path: "/v1/admin/credentials", user: admin, body: { ref: "asana-revoked", type: "oauth-refresh-token", secretName: REVOKED_SECRET } })).status).toBe(201);
    const revoked = await call(second.handler, { method: "POST", path: "/v1/admin/projects", user: admin, body: registrationBody(2, "asana-revoked", PROJECT) });
    const revokedPreflight = revoked.body.preflight as { connectors: Array<{ status: string; problem?: string }> };
    expect(revokedPreflight.connectors[0]).toMatchObject({ status: "not_connected" });
    expect(revokedPreflight.connectors[0]!.problem).toContain("agentx admin credential authorize --ref asana-revoked");
    evidence(`step 9 revoked sign-in ${revokedPreflight.connectors[0]!.status}`);

    for (const line of printed) {
      expect(line).not.toContain(refreshToken);
      expect(line).not.toContain(CLIENT_SECRET);
    }
  }, 420_000);
});
```

Run: `npm run build && npx vitest run tests/live/asana-live.test.ts` without the variables.
Expected: 1 skipped; suite green. Commit it:

```bash
npm run typecheck && npm run lint && npm run build && npm test
git add tests/live/asana-live.test.ts
git commit -m "test(live): add the skipped-by-default Asana live check with a one-time bot-user sign-in

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 2: User prepares the bot user (mandatory before Part A)**

The user follows `docs/connectors/asana.md` Steps 1, 2, 5 and 6 on the reference workspace:
the bot user is a guest or member of one test project only; the Asana MCP app is the one whose
client ID and secret are in the Keychain as `agentx-asana-client-id` and
`agentx-asana-client-secret` (account `agentx`), with the redirect URL
`http://localhost:8765/callback`; Step 6 passes. The user gives the controller the test project's
GID and, if the bot user can see one, a task GID in another project (otherwise the test uses a GID
that does not exist, which the guard also refuses).

- [ ] **Step 3: Controller runs Part A; user signs in once**

In a browser where the bot user is signed in to Asana (or a private window), from the repository
root:

```sh
export PATH=/private/tmp/claude-501/node-v22.20.0-darwin-arm64/bin:$PATH
npm run build
export AGENTX_LIVE_ASANA_CLIENT_ID="$(security find-generic-password -s agentx-asana-client-id -a agentx -w)"
export AGENTX_LIVE_ASANA_CLIENT_SECRET="$(security find-generic-password -s agentx-asana-client-secret -a agentx -w)"
export AGENTX_LIVE_ASANA_PROJECT=<project GID from Step 2>
export AGENTX_LIVE_ASANA_OUTSIDE_TASK=<task GID outside it, or leave unset>
export AGENTX_LIVE_ASANA_CAPTURE="$(mktemp -d)/asana-get-task.live.json"
npx vitest run tests/live/asana-live.test.ts
unset AGENTX_LIVE_ASANA_CLIENT_ID AGENTX_LIVE_ASANA_CLIENT_SECRET
```

The test prints the sign-in URL and opens it. The user approves access as the bot user within five
minutes. Expected: 1 test passes and prints nine `asana live check:` lines (steps 1 to 9). The
refresh token exists only in the test's memory and is gone when it ends.

Step 5 first writes Asana's raw `get_task` answer to `$AGENTX_LIVE_ASANA_CAPTURE` (read with a
separate registry, outside the guard), then reads the task through the broker. If the broker read
fails with "Could not confirm that Asana task ... is in the ... project", the live shape differs
from Ruling 13: add a test to `tests/contract/gateway-asana.test.ts` that feeds the captured shape
(names replaced as in Step 4) and expects the check to pass; watch it fail; change `taskOf` in
`packages/gateway/src/asana.ts` to read that shape while still refusing anything else; rerun Part A.

- [ ] **Step 4: Replace the `get_task` fixture with the captured shape**

Copy the capture over `tests/fixtures/vendors/asana-get-task.json`, replacing the task's name,
notes, assignee, workspace name, user names and any email with neutral values and the GIDs with
`1210000000000101` (task), `1210000000000010` (project) and `1210000000000001` (workspace). Keep
every key and nesting exactly as captured. Run the full check; Tasks 5 and 7 must still pass.

- [ ] **Step 5: Record Part A evidence**

Append to `specs/013-connector-gateway/quickstart.md`:

```markdown
## Asana (US6)

Part A, before the PR: the real `agentx admin credential authorize` code and the broker from this
branch against real Asana (`tests/live/asana-live.test.ts`).

- Date: <date> (US Eastern), run locally from branch `feat/013-phase-7-asana`.
- Endpoints: `https://mcp.asana.com/v2/mcp`; token endpoint `https://app.asana.com/-/oauth_token`.
- App: the reference organisation's Asana MCP app; redirect `http://localhost:8765/callback`.
- Bot user: a guest in one test project only; guide Step 6 passed (sidebar, cross-project search).
- The nine evidence lines, as printed (they carry no token).
- Refresh token rotated on refresh: <yes/no, from step 8>.
- `get_task` shape: <matched Ruling 13 / differed: what changed>.
- Created task: <GID> (left in place or deleted).
```

Commit:

```bash
git add specs/013-connector-gateway/quickstart.md tests/fixtures/vendors/asana-get-task.json docs/connectors/asana.md
git commit -m "docs(013): record the Asana live check, part A

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6: Part B, after the production release**

1. The user creates the reference secret with the guide's Step 3 (`agentx/connectors/asana-bot`,
   tagged), then runs Step 4, `agentx admin credential authorize --ref asana-bot --secret
   agentx/connectors/asana-bot --provider asana`, signing in as the bot user. `agentx admin
   credential list` shows `asana-bot`, `oauth-refresh-token`.
2. The user adds the guide's Step 7 connector to the bound test project and registers it; preflight
   reads `connected`.
3. In the bound test channel: "what's open in Asana?" (a list or search), "create an Asana task
   titled AgentX part B check" (created by the bot user), and a comment on that task (signed with
   the footer). After more than one hour, ask again: the answer arrives without anyone signing in.
4. Record the thread link, the created task and the hour-later answer under
   `## Asana (US6)` as Part B, then check T045 in `tasks.md` and commit.

---

## Self-Review

1. **Spec coverage (Amendment 1).** FR-033: Task 2 (provider, cache, lease, rotation, failure
   classes) and Task 3 (registry). FR-034: Task 4. FR-035: Task 3 Step 5 and its infrastructure
   test. FR-036: Task 6. FR-037: Task 5 (binder) and Task 7 (schemas as presented). FR-038: Task 5.
   FR-039: Task 6 (schema) and Task 5 (guard refuses unlisted tools). FR-040: Task 5
   (`ASANA_ITEM_ARGUMENTS`, `ASANA_TASK_REFERENCES`) and "Coordination with spec 014". FR-041: Task 5
   (`attributionKeys: ["text"]`) and Task 7 (signed comment). SC-008: Task 7. User Story 6
   scenarios 1 to 6: Tasks 4, 7 (2, 3, 4, 5, 6), and 9 live. SC-002: no route, ledger, catalog or
   orchestrator file is touched. SC-005: Task 7 counts zero upstream writes.
2. **Placeholder scan.** No step says "similar to" or "add validation". The only values left to the
   executor are the live project GID and dates in Task 9's evidence, which exist only at run time.
3. **Type consistency.** `SecretStore`, `RefreshLease`, `REFRESH_TOKEN_CACHE_KEY` and
   `oauthRefreshTokenProvider` are defined in Task 2 and used with the same names in Tasks 3, 7 and 9.
   `AsanaProjectScope.projectGid` is the same field in Tasks 5, 6 and 7. `AuthorizeSecrets` (Task 4)
   is what Task 9 builds. The CLI option names in Task 4 match the guide in Task 8.
4. **Review Focus.** Each of the seven lines names the tests that pin it; all are in the tasks above.
5. **Verified.** Every code block in this plan was applied to a copy of `mainline` at `af67c2c`.
   With all nine tasks applied, `npm run typecheck`, `npm run lint`, `npm test` (1,261 passed, 2
   skipped: the Jira and Asana live checks) and `npm run infra:synth` passed. Task 1's tests passed on
   unchanged `af67c2c`. The order between tasks (for example, the registrable type waits for Task 3)
   was checked by reading each task's imports, not by running each intermediate state.
