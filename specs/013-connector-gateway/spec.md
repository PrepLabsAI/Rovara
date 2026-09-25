# Feature Specification: Connector Gateway

**Feature Branch**: `feat/013-connector-gateway`

**Created**: 2026-09-24

**Status**: Draft for review

**Input**: Add Linear and Jira alongside GitHub without per-provider copies of the GitHub MCP
bridge, make the orchestrator pick the right tool, and make every turn diagnosable. Asana follows
later on the same interface.

**Constitution**: Version 2.1.0. Principle I permits administrator-enabled third-party connector
tools, scoped by project and each connector's registered scope, and requires the third-party
credential itself to be limited to that scope. No further amendment.

## Context

Feature 007 connects the control plane to GitHub's hosted MCP server, discovers tools, exposes the
administrator-approved intersection through one generic Pi bridge, and executes calls with durable
deduplication. That engine is the right one: policy intersection, argument narrowing, fail-closed
schema hashes, a write ledger whose unknown outcomes never replay, token redaction, and bounded
requests. It is also GitHub-shaped in nine places: the endpoint constant, the `owner`/`repo`
schema surgery, the GitHub App credential call, the `/github/` routes, the `GITHUB_MCP#` ledger
key, the `GitHubMcp*` contracts, the `github_<tool>_<hash>` tool names, the issue-versus-PR
preflight, and the orchestrator prompt. Discovery also runs once per repository per turn, so
tools are duplicated per repository and each turn pays a token mint and an MCP connection for
every repository.

Live threads in the bound test channel show what the orchestrator does with its current tool set.
It answered "Please provide the title and body for the pull request" to a request to list files;
it returned no text three times; and, before the GitHub tools were deployed to it, it described
missing tools as a limitation of its own. The model sees twelve in-house tools, seven of which are
pull-request actions that differ by one verb, and two recovery tools that the system prompt says
not to use in ordinary turns. Tool names carry opaque hash suffixes. Nothing records which tools a
turn was offered or which one it chose, so none of these failures can be measured.

Linear's hosted MCP server accepts an OAuth access token or API key in the `Authorization: Bearer`
header and can act as an application user. Atlassian's Rovo MCP server accepts a service-account
API key as a Bearer token once an organization administrator enables API-token authentication.
Asana's hosted MCP server documents interactive OAuth only; it is out of scope here, and the
credential interface is required to admit it later without other changes. (Superseded by
[Amendment 1](#amendment-1-2026-09-25-asana-connector-phase-7): Asana arrives in phase 7.)

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Existing GitHub Threads Keep Working Through the Refactor (Priority: P1)

A member uses the GitHub issue tools in a thread created before the gateway shipped, on a project
revision that still uses `integrations.githubMcp`. Listing, reading, creating, commenting and
assigning behave exactly as before; stored invocation records replay as before.

**Why this priority**: The gateway replaces the engine under a feature that is live. Nothing else
is worth shipping if this regresses.

**Independent Test**: Run the existing GitHub MCP contract and integration suites, unchanged,
against the gateway; register a revision with the legacy policy and drive a hosted Slack turn.

**Acceptance Scenarios**:

1. **Given** a revision registered with `integrations.githubMcp`, **When** a thread lists issues,
   **Then** the gateway serves it as a `github` connector without re-registration.
2. **Given** a write recorded under the feature 007 ledger key, **When** the same request ID is
   replayed, **Then** the stored result is returned and nothing executes.
3. **Given** a Slack service built before the gateway, **When** it calls `/github/tools` or
   `/github/call`, **Then** the broker serves it for one release.

---

### User Story 2 - Read and Write Linear Issues from a Thread (Priority: P1)

An administrator registers a Linear credential restricted to the payments team and approves a few
Linear tools. A member asks "what's open for payments in Linear?" and then "create a Linear issue
for the flaky login test". AgentX lists the team's issues and creates the issue with a footer that
names the requesting Slack member.

**Why this priority**: Linear is the first connector that is not GitHub and proves the gateway is
generic.

**Independent Test**: Against a local fake MCP server serving recorded Linear `tools/list`
fixtures, register a revision with a `linear` connector, run a hosted turn, and verify discovery,
scope binding, credential minting, execution, attribution and ledger records.

**Acceptance Scenarios**:

1. **Given** an approved Linear read tool, **When** a member asks for open issues, **Then** the
   orchestrator calls `linear__<tool>` and never starts a coding worker.
2. **Given** a static-secret Linear API key restricted to the team, **When** the first call needs
   a credential, **Then** the gateway reads it from Secrets Manager, sends it only as the Bearer
   header, and never logs or returns it.
3. **Given** an approved write tool with a description argument, **When** it executes, **Then** the
   description ends with the attribution footer for the requesting member.
4. **Given** a vendor schema that uses `$ref`/`$defs`, **When** it is discovered, **Then** the tool
   is flattened and offered, not silently dropped.

---

### User Story 3 - Read and Write Jira Issues from a Thread (Priority: P2)

An administrator registers a Jira service-account key and approves Jira tools for project `PAY`. A
member asks for the open `PAY` bugs and then creates one.

**Why this priority**: Second non-GitHub connector; depends on an Atlassian administrator enabling
API-token authentication for MCP, which is outside AgentX's control.

**Independent Test**: Same as User Story 2 with recorded Atlassian fixtures and a `jira` connector;
verify `cloudId` is bound server-side and absent from the model's schema.

**Acceptance Scenarios**:

1. **Given** a `jira` connector with a `cloudId` scope, **When** a tool is registered, **Then** the
   model's schema has no `cloudId` and every call carries the registered one.
2. **Given** API-token authentication disabled at Atlassian, **When** discovery runs, **Then**
   registration preflight reports an authentication failure naming the connector.

---

### User Story 4 - The Orchestrator Picks the Right Tool and Says What It Cannot Do (Priority: P1)

A member asks to list files, list GitHub issues, list Linear issues, change a pull request, and ask
about Jira in a project where Jira is not connected. Each request goes to the right tool, and the
Jira question gets a plain "Jira is not connected for this channel" answer.

**Why this priority**: More tools make wrong picks more likely; this story keeps the tool set small
and unambiguous as connectors are added.

**Independent Test**: Snapshot the tools and system prompt a project produces; replay the
evaluation cases against the configured model and compare accuracy with the committed baseline.

**Acceptance Scenarios**:

1. **Given** any registered project, **When** a turn starts, **Then** the system prompt begins with
   a capabilities manifest listing connected and not-connected capabilities.
2. **Given** the seven pull-request lifecycle actions, **When** tools are registered, **Then** the
   model sees one `agentx_manage_pull_request` tool with an `action` argument.
3. **Given** no interrupted operation in the workspace, **When** tools are registered, **Then** the
   recovery tools are not offered.
4. **Given** a connector approved in the revision whose credential is missing or rejected, **When**
   a tool is called, **Then** the result is a structured not-connected failure the model can relay.
5. **Given** a saved thread whose transcript names a retired tool, **When** the model calls it,
   **Then** it is told the replacement and succeeds on its next call.

---

### User Story 5 - An Operator Can See What Each Turn Was Offered and Chose (Priority: P2)

An operator exports the last week's turns, finds a wrong pick, sees the exact tool list and prompt
the model had, and adds it to the evaluation cases. A vendor changes a tool schema at night; an
alarm fires within minutes.

**Why this priority**: Without records, tool selection cannot be measured and vendor drift is found
by users.

**Independent Test**: Run hosted turns in the integration harness and verify one turn record per
turn with the fields below; inject schema drift and verify the metric and alarm definition.

**Acceptance Scenarios**:

1. **Given** a completed turn, **When** its record is read, **Then** it contains the offered tools
   with description hashes, request and response text, each call with validation result and
   outcome, stop reason, orchestrator usage and the worker operations it started.
2. **Given** records older than 30 days, **When** they are read, **Then** they are gone.
3. **Given** a discovery failure or schema drift, **When** it happens, **Then** a metric with the
   connector dimension is emitted and the shipped alarm evaluates it.

### Edge Cases

- A connector approves a tool the vendor no longer offers; registration preflight reports it and
  the remaining tools are offered.
- A vendor schema cannot be represented after flattening (recursive `$ref`, `oneOf` over
  incompatible objects); the tool is skipped with a metric and a preflight warning.
- An upstream schema already has a property named `target`; registration refuses that approval.
- Two connectors of the same type (two Linear workspaces); names differ and both are offered.
- A connector name plus tool name exceeds 64 characters; registration refuses it.
- The visible tool count exceeds 20 (warning) or 40 (registration refused).
- An OAuth client-credentials token is revoked because another process requested different scopes;
  the next call re-mints once, and a second rejection is reported as not connected.
- A Jira service-account key expires; calls fail as not connected until the secret is replaced.
- A turn is redelivered; its turn record is written once per Slack event.
- The orchestrator produces no text; the turn record sets `emptyResponse` and the metric counts it.
- "close this issue" in a thread; workspace closure matches only the exact close phrases, so the
  request reaches the model and a connector tool.

## Requirements *(mandatory)*

### Functional Requirements

**Gateway**

- **FR-001**: A new package `@agentx/gateway` MUST own all third-party tool behavior behind five
  interfaces: `Connector`, `CredentialProvider`, `Binder`, `Guard` and `Ledger`. The broker MUST
  NOT reference a vendor, vendor endpoint or vendor argument name outside that package.
- **FR-002**: The gateway MUST preserve feature 007 execution semantics for every connector:
  policy check, schema-hash check, validation against the narrowed and upstream schemas, bound
  arguments injected after validation, write claims before execution, UNKNOWN for attempted writes
  whose outcome is not known, no automatic retry of UNKNOWN or IN_PROGRESS writes, redaction of the
  credential from results, 20-second deadline and response-size limits.
- **FR-003**: `CredentialProvider.issue(scope, access, actor?)` MUST be the only way the gateway
  obtains a credential. v1 providers MUST ignore `actor`. Connectors MUST declare
  `identity: service`; `identity: user` is reserved.
- **FR-004**: v1 MUST implement `github-app` (the existing provider, moved), `static-secret` and
  `oauth-client-credentials`. The interface MUST admit an `oauth-refresh-token` provider without
  changes to routes, ledger, catalog or orchestrator.
- **FR-005**: Binders MUST remove server-controlled properties from the schema the model sees and
  inject the registered values at call time: `owner`, `repo` for GitHub; `cloudId` and, where the
  tool has it, the project key for Jira; the team identifier, where the tool has it, for Linear.
  A model-supplied value for a bound property MUST be refused.
- **FR-006**: The GitHub issue-number preflight from feature 007 MUST move unchanged into a GitHub
  `Guard`.
- **FR-007**: Discovery MUST flatten `$ref`/`$defs` and mergeable `allOf` before narrowing. A tool
  that still cannot be represented MUST be skipped with a metric and reported by registration
  preflight; it MUST NOT be skipped silently.
- **FR-008**: Discovery results MUST be cached per project revision and connector for 10 minutes.
  Execution MUST still compare the schema hash against the definition fetched on the connection
  used for the call. The cache is held in memory per broker container, and a failed call
  invalidates its entry.

**Configuration and credentials**

- **FR-009**: The project definition MUST accept `integrations.connectors`, a list of connectors
  each with a unique `name`, a `type`, a `credentialRef`, `scopes` and approved `tools`. A `github`
  connector has no `credentialRef`; it uses each scoped repository's GitHub App reference, and its
  scopes are `all-repositories` or repository names. Types other than `github` are refused until
  their phases add them.
- **FR-010**: A stored or submitted definition carrying `integrations.githubMcp` MUST be read as a
  single `github` connector over all registered repositories. A definition carrying both keys MUST
  be refused.
- **FR-011**: The control plane MUST resolve `credentialRef` through a credential registry of
  `{ ref, type, secretName }` records. Secrets MUST live under the Secrets Manager prefix
  `agentx/connectors/`, the only prefix the broker role may read besides the existing GitHub App
  secret. The existing GitHub App MUST appear in the registry without a deployment change.
- **FR-012**: The administration client MUST provide `agentx admin credential register` and
  `agentx admin credential list`, reading the control plane from the deployment file.
- **FR-013**: `oauth-client-credentials` MUST mint with one fixed scope set per credential, cache
  the token until five minutes before expiry, re-mint once after an authentication failure, and
  report a second failure as not connected.
- **FR-014**: Registration MUST connect to each connector and report: approved tools not found,
  tools skipped with reasons, authentication failures and the visible tool count against budget.
  Authentication failures MUST NOT block registration; unknown connector types MUST.

**Presentation**

- **FR-015**: Connector tools MUST be named `<connector>__<tool>`, at most 64 characters, with no
  hash suffix. There MUST be one tool per connector tool, not one per scope.
- **FR-016**: A connector with more than one scope MUST add a required `target` enum of scope
  aliases; with one scope the binder MUST fill it without an argument.
- **FR-017**: Each connector tool's description MUST be the administrator's override if present,
  otherwise the vendor's, followed by a generated target line and access line. Approved `examples`
  MUST be appended as example arguments. The assembled description MUST NOT exceed 2,048
  characters.
- **FR-018**: Every turn's system prompt MUST begin with a capabilities manifest generated from the
  workspace resolution: connected capabilities with their scopes and tool prefixes, the connectors
  that are not connected, and the workspace-close command. It MUST instruct the model to say
  plainly when a capability is not connected.
- **FR-019**: A call to an approved connector whose credential is missing, unregistered or
  rejected MUST return `status: FAILED, reason: not_connected` with the connector name and an
  administrator-facing message.
- **FR-020**: The seven pull-request lifecycle tools MUST be replaced by
  `agentx_manage_pull_request { repository, pullRequestNumber, action, title?, body? }` with
  `action` in `edit | append | sync | close | reopen | replace | revert`. Broker routes and
  behavior are unchanged.
- **FR-021**: `agentx_task_status` and `agentx_task_result` MUST be offered only when the workspace
  resolution reports a non-terminal operation started by the thread.
- **FR-022**: For one release, the system prompt MUST list each retired tool name with its
  replacement. Pi answers an unknown tool with "Tool <name> not found" before extension hooks run,
  so the mapping is the only recovery path.
- **FR-023**: Tool registration MUST warn above 20 visible tools and refuse above 40. In-house tools
  MUST precede connector tools; connectors MUST follow the definition's order.
- **FR-024**: Write tools with a body or description argument MUST have an attribution footer
  appended by the gateway naming the requesting Slack member and linking the thread, unless the
  connector sets `attribution: false`.

**Turn records and alarms**

- **FR-025**: The Slack service MUST write one turn record per Slack event to a `TurnRecords`
  table with a 30-day time-to-live, containing the fields in [data-model.md](data-model.md).
- **FR-026**: Turn records keep request text, response text and tool arguments, capped as
  specified. Before a record is written, known credential shapes (API keys, bearer tokens,
  passwords, connection strings and similar) MUST be replaced with `[REDACTED]`; this is
  best-effort pattern redaction, not a guarantee that no secret can appear. Request text, response
  text and tool arguments MUST NOT appear in CloudWatch logs. Turn records MUST be readable only
  through the administrator-only export route, MUST be stored encrypted at rest, and expire after
  30 days.
- **FR-027**: Orchestrator usage in a turn record MUST use the feature 011 `TaskUsageTelemetry`
  shape, moved to `@agentx/contracts` and shared with the worker.
- **FR-028**: The administration client MUST provide `agentx admin turns export --since <duration>`
  writing JSON Lines, served by an administrator-only route.
- **FR-029**: The broker and Slack service MUST emit the metrics listed in
  [contracts/metrics.md](contracts/metrics.md) with a `connector` dimension where applicable. The
  control-plane stack MUST ship the alarms listed there, notifying an SNS topic.

**Compatibility and verification**

- **FR-030**: `/v1/workspaces/{id}/github/tools` and `/github/call` MUST remain as aliases of the
  `github` connector routes for one release. The thread workspace response MUST keep
  `githubMcpRepositories` for clients that request it and add `connectors`.
- **FR-031**: The GitHub connector MUST keep writing feature 007 ledger records under
  `GITHUB_MCP#<requestId>`; other connector types write `CONNECTOR#<name>#<requestId>`. Keeping the
  GitHub key avoids a cross-key race with a broker from before the release.
- **FR-032**: The repository MUST contain a deterministic presentation snapshot test and a model
  replay evaluation (`npm run eval`) with committed cases and baseline, described in
  [contracts/evaluation.md](contracts/evaluation.md).

### Key Entities

- **Connector**: A named, typed third-party endpoint in a project revision, with its credential
  reference, scopes, approved tools, identity mode and attribution setting.
- **Scope**: An alias bound to server-controlled values (a repository, a Linear team, a Jira cloud
  and project) that a connector may address.
- **Credential record**: A registry entry mapping a credential reference to a provider type and a
  Secrets Manager name.
- **Catalog entry**: A discovered, flattened, narrowed tool with its presented name, description,
  schema, schema hash and access class.
- **Invocation**: The existing ledger record, generalized to carry the connector name.
- **Turn record**: What one orchestrator turn was offered, asked, chose and produced.

## Success Criteria *(mandatory)*

- **SC-001**: Every feature 007 contract and integration test passes against the gateway without
  modification to its assertions.
- **SC-002**: Adding a connector type requires a `CredentialProvider` class, an optional `Binder`
  and `Guard`, recorded fixtures and a setup guide; no change to routes, ledger, catalog,
  orchestrator or Slack service.
- **SC-003**: A typical project with GitHub, Linear and Jira approved at four tools each presents
  at most 16 tools to the model.
- **SC-004**: On the committed evaluation set, tool-selection accuracy with the new presentation is
  higher than with the pre-change presentation on the same model, and correct-refusal accuracy for
  not-connected capabilities is at least 90%.
- **SC-005**: Unauthorized, disabled, out-of-scope and not-connected requests cause zero upstream
  mutation attempts.
- **SC-006**: Every hosted turn produces exactly one turn record, including redelivered and failed
  turns.
- **SC-007**: Type checking, linting, tests and infrastructure synthesis pass at every phase.

## Decisions

- **Gateway is a package inside the broker, not a separate service.** It keeps one authentication
  path and one deployable while giving vendor logic a service-grade boundary that can be lifted out
  later. Decided 2026-09-24.
- **Bot identity in v1, with visible attribution.** The vendor sees the connector's service
  identity; the ledger records the Slack member; write bodies carry a footer. Per-user OAuth is
  deferred and has a reserved slot in the credential interface. Decided 2026-09-24.
- **The credential is the access boundary.** Project policy narrows what the model is offered;
  what AgentX can reach is decided at the vendor. Each connector's setup guide lists the
  vendor-side restriction as mandatory. Decided 2026-09-24 and recorded in constitution 2.1.0.
- **Native vendor tools, prefixed; no unified cross-vendor schema.** Decided 2026-09-24.
- **Consolidate the pull-request lifecycle tools now**, not after measurement, with Pratik's review
  of the tool-contract change. `agentx_create_pull_request` stays separate as the explicit publish
  gate. Decided 2026-09-24.
- **Turn records keep request text, response text and arguments for 30 days.** They are the raw
  material for evaluation cases. This supersedes the README statement that request and response
  text are never logged; CloudWatch logs still never carry them. Decided 2026-09-24.
- **Connector routes and workspace-resolution fields ship with the presentation in phase 2**, their
  only consumer. Phase 1b generalizes configuration, schemas, ledger and caching behind the existing
  `/github/` routes. Decided 2026-09-24.
- **Asana is deferred.** Its hosted MCP server documents interactive OAuth only. It will arrive as
  an `oauth-refresh-token` provider for an administrator-authorized bot user, or with per-user
  identity. Decided 2026-09-24. Superseded by Amendment 1 (bot user, `oauth-refresh-token`).
- **Retired tool names are handled by a prompt mapping, not a hook.** Pi's agent loop rejects an
  unknown tool before `tool_call` handlers run.
- **Linear uses a team-restricted API key, not client credentials.** Linear's client-credentials
  tokens act as the application with access to all public teams and cannot meet the mandatory
  vendor-side restriction. Decided 2026-09-24.

## Assumptions and Scope

- Orchestrator model selection is unchanged by this feature. The evaluation reports results per
  model so a later model change can be measured.
- The Slack app gains the `users:read` bot scope so the service can resolve a requester's display
  name for attribution; names are cached per service task.
- Linear and Atlassian tool names in examples are illustrative. Approvals must match discovered
  names, and registration preflight reports mismatches.
- Jira acceptance depends on an Atlassian organization administrator enabling API-token
  authentication for the Rovo MCP server and creating a service account restricted to the intended
  projects. Code-search and Teams tools require OAuth and are unavailable.
- Tool search, meta-tools and staged disclosure are out of scope; with a 20-tool budget they are
  not needed.
- A confirmation step for writes, per-user identity, Asana and a web dashboard for turn records are
  out of scope. (Asana is brought in scope by Amendment 1.)
- Deployed acceptance is not claimed by this document.

## Amendment 1 (2026-09-25): Asana connector, phase 7

**Status**: Amendment, draft for review. It adds User Story 6, FR-033 to FR-041 and SC-008, and
supersedes the "Asana is deferred" decision. Nothing above is otherwise changed. Detailed plan:
[plans/phase-7-asana.md](plans/phase-7-asana.md).

**Facts proven live on 2026-09-24.** Asana's MCP server is `https://mcp.asana.com/v2/mcp` and
accepts only OAuth user tokens: no API key and no client credentials. The client is an
organisation's own "Asana MCP" app with a client ID and secret; the authorize endpoint is
`https://app.asana.com/-/oauth_authorize` (with PKCE S256 and `resource=https://mcp.asana.com/v2/mcp`),
the token endpoint `https://app.asana.com/-/oauth_token`, and the redirect
`http://localhost:8765/callback`. Access tokens last 3,600 seconds. Refreshing worked headlessly,
and the refresh token was not rotated. `tools/list` returned 39 tools, recorded as the vendor
fixture.

### User Story 6 - Read and Write Asana Tasks from a Thread (Priority: P2)

An administrator creates an Asana MCP app for the organisation, invites a dedicated bot user to
the payments project only, signs the bot user in once with `agentx admin credential authorize`,
and approves Asana tools for that project. A member asks "what's open in Asana for payments?",
then "comment on the flaky login task that the fix is deployed". AgentX searches the project's
tasks and comments with a footer naming the member. Hours later, with nobody signed in, AgentX
still answers.

**Why this priority**: The third non-GitHub connector, and the first whose vendor accepts only
user OAuth. It proves FR-004: a refresh-token provider added without changing routes, ledger,
catalog or orchestrator.

**Independent Test**: Against a local fake Asana (an OAuth token endpoint and an MCP server serving
the recorded `tools/list`), register an `oauth-refresh-token` credential and an `asana` connector,
drive calls through the broker routes, and verify refresh, rotation write-back, project binding,
the project guard, not-connected reporting and zero cross-project writes.

**Acceptance Scenarios**:

1. **Given** a secret holding the app's client ID and secret, **When** an administrator runs
   `agentx admin credential authorize` and the bot user approves in the browser, **Then** the
   refresh token is stored in the same secret, the secret is tagged for write-back, and the
   credential is registered as `oauth-refresh-token`; no token, code or client secret is printed.
2. **Given** an expired or rejected access token, **When** a call needs one, **Then** AgentX
   refreshes without anyone signing in, at most once at a time across broker containers, and the
   call succeeds.
3. **Given** Asana returns a new refresh token, **When** AgentX refreshes, **Then** the new token is
   written back to the secret before its access token is used, and the next refresh uses it.
4. **Given** a revoked sign-in, **When** a call needs a token, **Then** the result is
   `FAILED, not_connected` with a message naming `agentx admin credential authorize --ref <ref>`,
   and registration preflight reports the connector as not connected.
5. **Given** a task in another project, **When** a member asks to read, update or comment on it,
   **Then** the call is refused as `policy_denied` and nothing is written to Asana.
6. **Given** a list, a search or a create, **When** the tool is presented and called, **Then** the
   project GID is absent from the model's schema and bound by the server.

### Edge Cases (Amendment 1)

- Two containers need a token at once: one refreshes; the other waits for its token. A container
  that dies while refreshing loses its lease after 15 seconds, within one 20-second call.
- A refresh outlives its lease and races a rotation: the refused one re-reads the secret once and
  retries with the token the other saved.
- Saving a rotated refresh token fails: that container keeps it in memory, logs
  `connector.refresh_token_unsaved` by error class only, and still serves the call. Other
  containers report not connected until the bot user signs in again.
- The browser redirect carries another state: it is answered and ignored, and the command keeps
  waiting for the right one until its five-minute timeout.
- The redirect carries an `error` with the right state: the command stops and stores nothing.
- A subtask in no project: accepted when its parent, up to three levels up, is in the project.
- Asana answers `get_task` in a shape AgentX does not accept: the call is refused, never allowed.
- A free Asana workspace: `search_tasks` fails as a vendor error; `get_tasks` works.

### Functional Requirements (Amendment 1)

- **FR-033** (amends FR-004 and FR-013): An `oauth-refresh-token` provider MUST read a secret of
  shape `{clientId, clientSecret, refreshToken}` and mint access tokens with the refresh grant at
  the token endpoint its connector type supplies. It MUST share the access token across broker
  containers and reuse it until five minutes (at most half its lifetime) before expiry; allow at
  most one refresh at a time per credential across containers; read the secret fresh when
  refreshing; write a rotated refresh token back to the same secret before its access token is
  used or cached, retrying once and otherwise keeping it in memory and logging the error class;
  report a refused refresh (HTTP 400, 401 or 403) as not connected, with a message naming
  `agentx admin credential authorize --ref <ref>`; and treat any other failure as transient.
- **FR-034** (amends FR-012): The administration client MUST provide
  `agentx admin credential authorize --ref <ref> --secret <name> --provider <name> [--region <r>]`.
  It reads the app's client from the secret with the administrator's AWS credentials; signs in with
  the authorization code flow, PKCE S256 and a random state of at least 128 bits compared in
  constant time; listens only on 127.0.0.1 at the provider's registered redirect port; accepts one
  redirect with the right state, ignores any other, stops on an `error` redirect, and times out
  after five minutes; requires a refresh token in the exchange; writes
  `{clientId, clientSecret, refreshToken}` to the secret, tags it `agentx-writable: refresh-token`,
  and registers it as `oauth-refresh-token`. It MUST NOT print or log a token, the authorization
  code or the client secret. Each provider's authorize URL, token URL, resource and redirect are
  data per connector type in `@agentx/contracts`; `asana` is the only one.
- **FR-035** (amends FR-011): The broker role MUST be allowed `secretsmanager:PutSecretValue` only on
  `agentx/connectors/*` secrets tagged `agentx-writable: refresh-token`, and no other secret write.
- **FR-036** (amends FR-009): A connector of type `asana` MUST have scopes `{alias, projectGid}`,
  one Asana project each, MUST accept only an `oauth-refresh-token` credential, and uses service
  identity (the bot user). Its endpoint is `https://mcp.asana.com/v2/mcp` and its token endpoint
  `https://app.asana.com/-/oauth_token`.
- **FR-037** (amends FR-005): The Asana binder MUST bind `project`, `project_id`, `default_project`
  and `projects_any`, where a tool has them, to the scope's project GID, and remove them from the
  model's schema.
- **FR-038**: Before an Asana call reads or changes an existing task, every task it names MUST be
  read with `get_task` and be in the scope's project, directly or through its parent up to three
  levels: the `task_id`; in `create_tasks` each parent; in `update_tasks` each task, parent and
  dependency. The check MUST fail closed on an error, an unrecognised result or a different task,
  and one call MUST name at most 10 tasks. Task references MUST be numeric GIDs. The guard MUST
  refuse `tag`, `section`, `user_task_list` and `assignee` on `get_tasks`; a `project_id` other
  than the scope's, `section_id` and `assignee_section` on `create_tasks`; and `add_projects`,
  `remove_projects` and `assignee_section` on `update_tasks`.
- **FR-039**: An Asana connector MUST approve only `get_task`, `get_task_stories`, `get_tasks`,
  `search_tasks` and `get_project` with `access: read`, and `create_tasks`, `update_tasks` and
  `add_comment` with `access: write`. Registration MUST refuse any other Asana tool or access.
- **FR-040**: The Asana connector MUST declare `task_id` as the argument through which a tool names
  an existing item, for spec 014's action gate, and publish its nested task references
  (`tasks[].task`, parents and dependencies) as argument paths.
- **FR-041** (applies FR-024): The attribution footer MUST be appended to `add_comment`'s `text`.
  Task notes inside `create_tasks` and `update_tasks` items and `html_text` comments are not signed.

### Success Criteria (Amendment 1)

- **SC-008**: In the fake-Asana flow test, cross-project requests cause zero upstream writes, a
  revoked sign-in is reported as not connected, and no access token, refresh token or client
  secret appears in any response or log line.

### Decisions (Amendment 1)

- **Asana is served by an administrator-authorized bot user through `oauth-refresh-token`.** Each
  organisation creates its own Asana MCP app and bot user; AgentX never runs a shared OAuth app.
  Per-user identity stays deferred. Decided by the owner 2026-09-24/25.
- **A scope is one Asana project, not a workspace.** Asana's MCP tools take no workspace argument
  except the interactive widget tools, so AgentX could not hold a search or a list to a workspace.
  Project arguments exist on the list, search, create and project-read tools, and every call that
  names a task can be checked with one `get_task`. A connector that needs several projects lists
  several scopes. Decided 2026-09-25.
- **The vendor-side restriction is the bot user's membership.** Asana OAuth has no scopes, so the
  bot user must be a guest or member of only the intended projects; the setup guide makes this
  mandatory and checkable. Constitution 2.1.0, Principle I.
- **The refresh token lives in Secrets Manager beside the app's client**, and the broker writes a
  rotated one back, narrowed by the tag condition in FR-035. Rotation was not observed on
  2026-09-24 but is handled. Decided by the owner 2026-09-25.
- **Refreshes are serialized across containers by a lease in the state table.** A lease that
  cannot be read or written is treated as acquired, so a DynamoDB fault never stops refreshing; a
  refused refresh re-reads the secret once, which covers the race that allows.
- **The sign-in runs in the administration client with the administrator's AWS credentials.** The
  refresh token goes from Asana to the administrator's machine to Secrets Manager and never
  through the control plane's API. The client gains the Secrets Manager SDK dependency the broker
  already pins.
- **OAuth sign-in profiles are data in `@agentx/contracts`**, as `JIRA_PROJECT_TOOL_ACCESS` is. The
  broker names no vendor (FR-001); the gateway's `asana.ts` holds every Asana argument name.

### Assumptions (Amendment 1)

- `get_task` answers `{ data: { gid, projects: [{ gid }], parent, memberships } }`, Asana's REST
  shape. The 2026-09-24 spike recorded `tools/list` but no `get_task` result; the phase 7 live
  check captures one. If the shape differs, every task check refuses until the parser is fixed.
- `search_tasks` needs a paid Asana plan.
- Whether a bot user joins as a guest, and whether it takes a seat, depends on the organisation's
  Asana plan and email domain.

