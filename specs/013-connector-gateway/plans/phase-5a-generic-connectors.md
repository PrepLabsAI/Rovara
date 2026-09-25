# Phase 5a: Generic Connector Routes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the control plane's connector handling generic, so adding Linear, Jira or Asana
means adding one connector-type definition and nothing in the routes, catalog cache, ledger,
registration check or thread setup (SC-002). GitHub behaviour stays exactly as it is.

**Architecture:** A new broker module `connector-types.ts` defines `ConnectorType`. Each type turns
a project's connector configuration into a `ResolvedConnector` carrying:

- its name, label, vendor and scope noun;
- its scopes, each an alias plus the value the binder needs;
- its approval policy and attribution setting;
- its ledger keys;
- a way to obtain the engine's `ConnectorDefinition`, or the reason it is not connected.

The GitHub type wraps what `broker.ts` does today. A new module `connector-routes.ts` serves
`/connectors/{name}/tools|call` for any resolved connector, and uses the gateway engine directly.
Registration preflight and thread setup iterate resolved connectors. The legacy `/github/` routes
keep their feature 007 code path and share the catalog cache.

Older Slack services must never receive a connector type they cannot parse. The broker therefore
returns non-GitHub connectors only to callers that send a new opt-in flag,
`includeAllConnectorTypes: true`.

**Tech Stack:** TypeScript 5.9 strict, Node 22.19–22.x, Zod 4, Vitest 5, MCP SDK 1.30.1.

**Spec:** [../spec.md](../spec.md): SC-002, FR-001, FR-009, FR-015–FR-019, FR-030, FR-031.
The plan argues from [../plan.md](../plan.md) ("Connector routes"). Its predecessor is
[phase-3-credentials.md](phase-3-credentials.md), and it builds on phase 3's `CredentialRegistry`.

**Branch:** `feat/013-generic-connectors`, stacked on the phase 3 head. It is opened as a PR that
depends on the phase 3 PR, and is rebased if phase 3's review changes it.

## Global Constraints

- **No regressions.** Every existing test passes with its assertions unchanged. This phase is a
  refactor for GitHub. The only new behaviour is for connector types other than GitHub, and those
  are exercised only through a test-only type.
- **GitHub strings stay the same.** These keep their exact current text:
  - the thread label `GitHub issues`;
  - the presented description vendor `GitHub`;
  - the scope noun `repository`;
  - the not-connected call text
    `GitHub issues is not connected for this project. An administrator must configure its credential.`;
  - the `connector.not_connected`, `connector.tools_skipped` and `connector.attribution_dropped`
    log fields;
  - the GitHub ledger key `GITHUB_MCP#`.
- **Legacy routes.** The `/github/tools|call` routes keep feature 007 request and response shapes
  and status codes. They share the catalog cache with the connector route under the same keys:
  JSON of `[project, revision, connector, alias]`.
- **Ledger keys.** Types other than GitHub write ledger records under `CONNECTOR#<name>#<requestId>`
  with `entityType` `CONNECTOR_INVOCATION`, using the existing `connectorLedger(name)`.
- **Thread setup and older Slack services.**
  - `includeConnectors: true` alone still returns only `github` connectors.
  - `includeAllConnectorTypes: true` also returns every other resolved connector.
  - The new Slack service sends both flags.
  - `ThreadConnectorSchema.type` widens from the literal `github` to the connector-name pattern, so
    new services accept any type.
- **No new connector type in production.** `ConnectorConfigSchema` still accepts only `github`.
  Phases 5–7 each add one type.
- **Code placement.** `broker.ts` edits are wiring only: routes, dependency fields, and calls into
  the new modules. Route logic lives in `connector-routes.ts`, and type logic in
  `connector-types.ts`.
- **Secret safety.** Secret values and tokens never appear in responses or logs.
- **Test imports.** Tests that drive broker code import gateway classes from `@agentx/gateway`.
  Gateway-only tests import `packages/gateway/src`.
- **Node and build.** Node `>=22.19.0 <23`, with `npm run build` before `npm test`. Node 22:
  `export PATH=/private/tmp/claude-501/node-v22.20.0-darwin-arm64/bin:$PATH`.
- **Commits.** Messages are `type(scope): summary`, ending with
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- **Fix before the PR.** Fix cheap review findings and anything that fails silently before the PR.

## Review Focus

1. **The GitHub route's catalog, schema hashes and ledger records must be byte-identical before and
   after.** A changed hash would fail every in-flight call with `schema_changed` after deploy.
   Tests: Task 2 golden test.
2. **An older Slack service must not receive a `tracker`, `linear` or `jira` connector.** Its
   strict parse would fail every turn. Tests: Task 3.
3. **A connector of a type this deployment does not know is ignored and logged, never thrown.** This
   covers a stored revision from a newer control plane after a rollback. Tests: Task 1.
4. **A registry-backed connector whose credential is unregistered is not connected, at every point:**
   thread setup (`connected: false`), discovery (a `notConnected` catalog) and calls (FAILED
   `not_connected`). Tests: Task 2 and Task 3.
5. **The legacy route and the connector route share one catalog cache entry per scope.** A schema
   change seen through either route invalidates it for both. Tests: Task 2.

## File Structure

| File | Responsibility |
|---|---|
| `packages/broker/src/aws/connector-types.ts` (new) | `ConnectorType`, `ResolvedConnector`, `ConnectorTypeContext`, `githubConnectorType`, `resolveConnectors` |
| `packages/broker/src/aws/connector-routes.ts` (new) | `discoverConnector`, `callConnector`, `connectorCatalogKey`, shared log helpers |
| `packages/broker/src/aws/broker.ts` | Wiring: the connector route calls `connector-routes.ts`; thread setup and registration use `resolveConnectors`; new optional dependency `connectorTypes` |
| `packages/broker/src/aws/registration-preflight.ts` | Iterates resolved connectors instead of GitHub only |
| `packages/broker/src/aws/credentials.ts` | `CredentialRegistry.has(ref)` for thread-setup `connected` |
| `packages/contracts/src/connectors.ts` | `ThreadConnectorSchema.type` widened |
| `packages/slack-service/src/thread-workspace-request.ts` | Sends `includeAllConnectorTypes: true` |
| `tests/support/tracker-connector.ts` (new) | A test-only `tracker` connector type backed by the credential registry |

## Pre-decided Rulings

- **The test-only type is not added to the schema.** It reaches the broker as a stored project
  record, seeded directly in the fake database, because `requireLatestProject` does not re-parse
  stored definitions. It is injected through the optional `connectorTypes` dependency. This proves
  SC-002 end to end without widening `ConnectorConfigSchema` before phase 5. Cost if wrong: phase 5
  also adds an HTTP test of its own.
- **Registry-backed connectors check the credential only for existence.** `connected` means "the
  credential reference is registered", checked with one read per thread turn. It does not mean
  "the vendor accepts it". Rejection shows up at discovery, as today. Cost if wrong: a thread lists
  a connector whose key the vendor has revoked, and the first discovery reports it.
- **One catalog cache.** The cache stores gateway `CatalogTool[]` and `skipped` per scope, and the
  legacy route maps them to feature 007's shape. Schema hashes do not change, because both paths
  call the same `reviewTools`.

---

### Task 1: Connector types and resolution

**Files:**
- Create: `packages/broker/src/aws/connector-types.ts`, `tests/support/tracker-connector.ts`,
  `tests/contract/connector-types.test.ts`
- Modify: `packages/broker/src/aws/credentials.ts` (`has(ref)`)

**Interfaces:**
- Produces:

```ts
export interface ConnectorScope<Scope> { alias: string; scope: Scope }
export interface ResolvedConnector<Scope = unknown> {
  name: string;
  type: string;
  /** Thread and manifest label, for example "GitHub issues". */
  label: string;
  /** Vendor name in presented descriptions, for example "GitHub". */
  vendor: string;
  scopeNoun: string;
  scopes: ReadonlyArray<ConnectorScope<Scope>>;
  policy: ConnectorPolicy;
  approvals: readonly PresentationApproval[];
  attribution: boolean;
  ledger: { prefix: string; entityType: string };
  /** Whether this deployment can reach the connector at all; cheap, used at thread setup. */
  configured(): Promise<boolean>;
  /** The engine definition, or why the connector is not connected in this deployment. */
  definition(): Promise<ConnectorDefinition<Scope> | { notConnected: string }>;
  connect?: typeof connectMcp;
}
export interface ConnectorTypeContext {
  githubMcp?: GitHubMcpDependencies;
  credentialRegistry?: CredentialRegistry;
}
export interface ConnectorType {
  type: string;
  /** Returns undefined, with a reason, when the configuration cannot be served by this type. */
  resolve(config: StoredConnectorConfig, project: ProjectDefinition, context: ConnectorTypeContext): ResolvedConnector | { unusable: string };
}
export type StoredConnectorConfig = { name: string; type: string } & Record<string, unknown>;
export const githubConnectorType: ConnectorType;
export function resolveConnectors(project: ProjectDefinition, context: ConnectorTypeContext, types?: Readonly<Record<string, ConnectorType>>): ResolvedConnector[];
```

`CredentialRegistry.has(ref: string): Promise<boolean>` returns true when a valid stored record
exists (it reuses `recordOf`).

- [ ] **Step 1: Write the failing tests**

```ts
// tests/contract/connector-types.test.ts
import { describe, expect, it, vi } from "vitest";
import { githubConnectorType, resolveConnectors } from "../../packages/broker/src/aws/connector-types.js";
import { trackerConnectorType } from "../support/tracker-connector.js";

const repositories = [
  { name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" },
  { name: "docs", url: "https://github.com/example/docs.git", path: "repo/docs", defaultBranch: "main", credentialRef: "github-app" },
];
const project = (integrations: unknown) => ({ name: "payments", revision: 3, repositories, setup: [], readiness: [], orchestratorInstructions: "x", integrations }) as never;
const githubMcp = { credentials: vi.fn(), connect: vi.fn() };

describe("connector resolution", () => {
  it("resolves the legacy githubMcp policy as the github connector over every repository", () => {
    const [github] = resolveConnectors(project({ githubMcp: { tools: [{ name: "list_issues", access: "read" }] } }), { githubMcp });
    expect(github).toMatchObject({
      name: "github", type: "github", label: "GitHub issues", vendor: "GitHub", scopeNoun: "repository", attribution: true,
      ledger: { prefix: "GITHUB_MCP#", entityType: "GITHUB_MCP_INVOCATION" },
    });
    expect(github!.scopes.map((scope) => scope.alias)).toEqual(["demo", "docs"]);
  });

  it("resolves a github connector's named scopes and attribution setting", async () => {
    const [github] = resolveConnectors(project({ connectors: [{ name: "gh", type: "github", scopes: ["docs"], attribution: false, tools: [{ name: "list_issues", access: "read" }] }] }), { githubMcp });
    expect(github).toMatchObject({ name: "gh", attribution: false });
    expect(github!.scopes.map((scope) => scope.alias)).toEqual(["docs"]);
    expect(await github!.configured()).toBe(true);
  });

  it("reports github as not configured when the deployment has no GitHub MCP", async () => {
    const [github] = resolveConnectors(project({ githubMcp: { tools: [{ name: "list_issues", access: "read" }] } }), {});
    expect(await github!.configured()).toBe(false);
    expect(await github!.definition()).toEqual({ notConnected: "GitHub MCP is not configured in this deployment" });
  });

  it("resolves an injected type in definition order after github and ignores, with a log line, a type it does not know", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const connectors = resolveConnectors(project({ connectors: [
        { name: "github", type: "github", scopes: "all-repositories", tools: [{ name: "list_issues", access: "read" }] },
        { name: "tracker", type: "tracker", credentialRef: "tracker-key", scopes: [{ alias: "payments", siteId: "site-42" }], tools: [{ name: "list_items", access: "read" }] },
        { name: "future", type: "future-vendor", tools: [{ name: "x", access: "read" }] },
      ] }), { githubMcp }, { github: githubConnectorType, tracker: trackerConnectorType });
      expect(connectors.map((connector) => connector.name)).toEqual(["github", "tracker"]);
      expect(connectors[1]).toMatchObject({ ledger: { prefix: "CONNECTOR#tracker#", entityType: "CONNECTOR_INVOCATION" } });
      const lines = log.mock.calls.map(([line]) => String(line)).filter((line) => line.includes("connector.type_unknown"));
      expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([{ component: "broker", event: "connector.type_unknown", project: "payments", revision: 3, connector: "future", type: "future-vendor" }]);
    } finally { log.mockRestore(); }
  });
});
```

`tests/support/tracker-connector.ts` exports `trackerConnectorType: ConnectorType` and
`TRACKER_ENDPOINT`. It serves type `tracker` with:

- label `Tracker issues`, vendor `Tracker` and scope noun `site`;
- scopes `{ alias, siteId }`;
- a binder that binds `siteId`;
- no guards;
- `attributionKeys: ["body"]`;
- `ledger: connectorLedger(name)`.

Its `configured()` returns `credentialRegistry?.has(credentialRef)`. Its `definition()` returns
`{ notConnected: "credential <ref> is not registered" }` when the reference is not registered.
Otherwise it returns a `ConnectorDefinition` whose credentials are
`credentialRegistry.provider(credentialRef)`, a static secret. The endpoint is `TRACKER_ENDPOINT`,
`https://mcp.tracker.test/mcp`.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npm run build && npx vitest run tests/contract/connector-types.test.ts`
Expected: FAIL, because the module is not found.

- [ ] **Step 3: Implement**

`connector-types.ts`. `githubConnectorType.resolve`:
1. Read `githubConnectorOf({ repositories, integrations: { connectors: [config] } })` for a
   connectors entry.
2. Build `scopes` from the resolved repositories as `{ alias: repository.name, scope: repository }`.
3. `configured()` returns `context.githubMcp !== undefined`.
4. `definition()` returns `githubConnector(issuer)` using `context.githubMcp.credentials`, or
   `{ notConnected: "GitHub MCP is not configured in this deployment" }`.
5. `connect` is `context.githubMcp?.connect`, and `ledger` is `GITHUB_LEDGER`.

`resolveConnectors(project, context, types = { github: githubConnectorType })`:
1. A legacy `integrations.githubMcp` becomes one synthesized config
   `{ name: "github", type: "github", scopes: "all-repositories", tools }`.
2. Otherwise, walk `integrations.connectors` in order.
3. A type missing from `types` logs `connector.type_unknown` and is skipped.
4. An `{ unusable }` result logs `connector.unusable` with the reason and is skipped.

`CredentialRegistry.has(ref)`: a consistent `GetCommand` on `CREDENTIALS / REF#<ref>`, true when
`recordOf` accepts the item.

- [ ] **Step 4: Run the tests and watch them pass.** Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Run the full suite and commit**

Run: `npm run typecheck && npm run lint && npm run build && npm test`. Expected: all pass.

```bash
git add packages/broker/src/aws/connector-types.ts packages/broker/src/aws/credentials.ts tests/support/tracker-connector.ts tests/contract/connector-types.test.ts
git commit -m "feat(broker): connector types resolve a project's connectors generically"
```

---

### Task 2: One route for every connector type

**Files:**
- Create: `packages/broker/src/aws/connector-routes.ts`, `tests/contract/generic-connector-routes.test.ts`
- Modify:
  - `packages/broker/src/aws/broker.ts`: the connector route block, the legacy route's cache use,
    and the dependency `connectorTypes?: Record<string, ConnectorType>`;
  - `tests/contract/slack-control-plane.test.ts`: add a GitHub golden test only.

**Interfaces:**
- Consumes: Task 1.
- Produces:

```ts
export function connectorCatalogKey(projectName: string, revision: number, connector: string, alias: string): string; // JSON.stringify([...]) — today's key
export async function discoverConnector(input: { connector: ResolvedConnector; workspace: WorkspaceInstance; project: RegisteredProjectRecord; context: ConnectorContextBase; catalogs: CatalogCache<ScopeDiscovery> }): Promise<ConnectorCatalog>;
export async function callConnector(input: { connector: ResolvedConnector; request: ConnectorCallRequest; workspace: WorkspaceInstance; project: RegisteredProjectRecord; context: ConnectorContextBase; attribution?: string; ledger: Ledger; catalogs: CatalogCache<ScopeDiscovery> }): Promise<ConnectorResult>;
export interface ScopeDiscovery { tools: CatalogTool[]; skipped: SkippedTool[] }
```

`ConnectorContextBase` is `{ workspaceId, ownerKey, requestedBy?, settingsRevision }`. The cache
type changes from `CatalogCache<GitHubMcpCatalog>` to `CatalogCache<ScopeDiscovery>`. The legacy
route maps a `ScopeDiscovery` to `GitHubMcpCatalog` with the existing `toGitHubTool` shape, and
exports that mapper from `github-mcp.ts`.

- [ ] **Step 1: Write the failing tests**

**GitHub golden test.** Add it to `tests/contract/slack-control-plane.test.ts` using its helpers.
Register a two-repository GitHub connector with `list_issues` (read) and `issue_write` (write),
then assert all of the following:
- The full `/connectors/github/tools` catalog equals a literal object, recorded by running the test
  once against the unmodified code in Step 2 and pasted in. This includes names, descriptions,
  input schemas and per-scope schema hashes.
- A write through `/connectors/github/call` writes `GITHUB_MCP#<requestId>` with `connector: "github"`.
- A discovery through the legacy route followed by one through the connector route makes exactly
  one vendor connection per repository. The cache is shared.
- A definition change seen through the connector route forces the legacy route to rediscover.

**Generic route test,** in `tests/contract/generic-connector-routes.test.ts`. Reuse
`slack-control-plane.test.ts`'s `createBroker`, `call`, `ensureWorkspace` and `markReady` helpers
by moving them into `tests/support/slack-broker.ts`. That move must not change any assertion in
`slack-control-plane.test.ts`: it only imports them. Build the broker with:
- `connectorTypes: { github: githubConnectorType, tracker: trackerConnectorType }`;
- a `connectorCredentials` configuration;
- the tracker's `connect` fake.

Seed a stored project revision whose connectors are GitHub plus `tracker`, with scopes `payments`
and `billing`. Then assert:
1. With `tracker-key` unregistered, the catalog is `{ connector: "tracker", notConnected: true, tools: [], skipped: [] }`,
   and one `connector.not_connected` line names `credential tracker-key is not registered`.
2. With `tracker-key` registered through `POST /v1/admin/credentials` (a static secret):
   - discovery returns `tracker__list_items` with a `target` enum of `["payments", "billing"]`;
   - the fake connection receives the registered API key as its token;
   - no schema exposes `siteId`.
3. A write call:
   - binds `siteId` for the chosen target;
   - appends the attribution footer to `body`;
   - writes `CONNECTOR#tracker#<requestId>` with `entityType: "CONNECTOR_INVOCATION"`;
   - a replay with the same request ID returns `replayed: true` without calling the vendor.
4. A call naming a tool that is not approved answers `FORBIDDEN`. A call naming an unknown scope
   answers `NOT_FOUND`. A call made while unregistered returns FAILED `not_connected`, and its text
   contains `Tracker issues is not connected`.
5. No response or log line contains the API key.

- [ ] **Step 2: Record the golden, then watch the new tests fail**

Run the golden test once on the unmodified code with a temporary `console.log` of the catalog.
Paste the value into the test as a literal and remove the log.
Run: `npm run build && npx vitest run tests/contract/generic-connector-routes.test.ts tests/contract/slack-control-plane.test.ts`
Expected: the golden passes on unmodified code. The generic tests FAIL, because the route answers
`NOT_FOUND "connector not found"` for `tracker`.

- [ ] **Step 3: Implement**

`connector-routes.ts`:
- **`discoverConnector`:**
  1. Resolve `definition()`. When it returns `{ notConnected }`, log `connector.not_connected`,
     with the field set from phase 3, and return the `notConnected` catalog.
  2. Otherwise, for each scope, read the cache or call gateway `discoverTools`. Log
     `connector.tools_skipped` for skipped tools, as today, then cache the result.
  3. Catch `ConnectorNotConnected` the same way phase 3 does: log it and return the `notConnected`
     catalog.
  4. Finally call `presentCatalog({ connector: name, label: vendor, scopeNoun, approvals, scopes })`.
- **`callConnector`** mirrors today's `executeGitHubConnectorTool` call:
  1. Validate the scope and the approval first, so malformed requests are refused the same way
     whether or not the connector is connected.
  2. When `definition()` returns `{ notConnected }`, return FAILED `not_connected` with the text
     `${label} is not connected for this project. An administrator must configure its credential.`
  3. Otherwise call gateway `executeTool` with the ledger, attribution, `onAttributionDropped` and
     `onDefinitionChanged` (which deletes the scope's cache key).

`broker.ts`:
- **Connector route.** Replace the connector route block with:
  1. authorize the workspace, as `authorizeGitHubConnector` does today;
  2. find the connector by name among `resolveConnectors(project.definition, ctx, dependencies.connectorTypes ?? BUILT_IN)`,
     or answer `NOT_FOUND "connector not found"`;
  3. call `discoverConnector` or `callConnector`.
- **Authorization.** The existing FORBIDDEN "GitHub MCP is not enabled for this project revision"
  stays for a project with no connectors at all, so existing tests pass unchanged.
- **Legacy route.** It keeps `executeGitHubTool`, and uses `connectorCatalogKey` plus the mapper
  for its cache.

- [ ] **Step 4: Run the tests and watch them pass.** Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Run the full suite and commit**

Run: `npm run typecheck && npm run lint && npm run build && npm test && npm run infra:synth`.
Expected: all pass, with no existing assertion changed.

```bash
git add packages/broker/src tests/support tests/contract/generic-connector-routes.test.ts tests/contract/slack-control-plane.test.ts
git commit -m "feat(broker): serve every connector type through one discovery and call route"
```

---

### Task 3: Thread setup lists every connector, to services that can parse it

**Files:**
- Modify:
  - `packages/broker/src/aws/broker.ts` (`threadIntegrations`, `IntegrationInclude`, the request flag);
  - `packages/contracts/src/connectors.ts`;
  - `packages/slack-service/src/thread-workspace-request.ts`.
- Test:
  - `tests/contract/generic-connector-routes.test.ts`, added tests;
  - `tests/contract/thread-workspace-request.test.ts`: its one `toEqual` gains
    `includeAllConnectorTypes: true`. This is the phase's one deliberate assertion change, because
    that test pins the request body;
  - `tests/contract/connector-contracts.test.ts`, one added test;
  - `tests/integration/mcp-orchestrator.test.ts`, one added test.

- [ ] **Step 1: Write the failing tests**

Thread-setup tests use the Task 2 setup.
- A request with `includeConnectors: true` only gets only the GitHub connector.
- A request with `includeAllConnectorTypes: true` as well gets both, in definition order. The
  tracker entry is `{ name: "tracker", type: "tracker", label: "Tracker issues", scopes: ["payments", "billing"], connected: false }`
  while unregistered, and `connected: true` after registration.
- The response parses with `SlackThreadWorkspaceResultSchema`.

Contract test: `ThreadConnectorSchema` accepts `type: "linear"` and refuses `type: "Bad Type"`.

Orchestrator test: a runtime built with connectors
`[{ name: "tracker", type: "tracker", label: "Tracker issues", scopes: ["payments"], connected: true }]`
and a tracker catalog registers `tracker__list_items`. Its manifest line reads
`- Tracker issues (payments): tracker__* tools`.

- [ ] **Step 2: Run the tests and watch them fail.**
Expected: the tracker connector is missing from the thread response, the schema refuses `linear`,
and the request body lacks the flag.

- [ ] **Step 3: Implement**
- **Contracts.** `ThreadConnectorSchema.type` becomes `ConnectorNameSchema` (the same pattern).
- **Thread setup.** `threadIntegrations` builds the connector list from `resolveConnectors`:
  - each entry is `{ name, type, label, scopes: aliases, connected: await configured() }`;
  - entries whose type is not `github` are filtered out unless `includeAllConnectorTypes === true`;
  - `githubMcpRepositories` still comes from the GitHub connector only.
- **Async.** Make `threadIntegrations` async, and await it at both call sites.
- **Slack service.** `threadWorkspaceRequest` adds `includeAllConnectorTypes: true`.

- [ ] **Step 4: Run the tests and watch them pass.** Then run the full suite once.

- [ ] **Step 5: Commit**

```bash
git add packages/broker/src/aws/broker.ts packages/contracts/src/connectors.ts packages/slack-service/src/thread-workspace-request.ts tests
git commit -m "feat(broker): list every connector type at thread setup for services that opt in"
```

---

### Task 4: Registration preflight for every connector type

**Files:**
- Modify: `packages/broker/src/aws/registration-preflight.ts`, `packages/broker/src/aws/broker.ts` (the call site)
- Test: `tests/contract/registration-preflight.test.ts` (added tests only)

- [ ] **Step 1: Write the failing test**

Register through the Task 2 harness, with the stored-record seeding replaced by a real registration.
Because `ConnectorConfigSchema` refuses `tracker`, drive `preflightConnectors` directly with a
parsed GitHub definition plus the resolved tracker connector. Assert:
- one report entry per connector, in order;
- the tracker entry is `not_connected` with `problem: "credential tracker-key is not registered"`
  while unregistered, and `connected` with `offered: ["tracker__list_items"]` after registration;
- the GitHub entry is unchanged.

All existing preflight tests must pass unchanged.

- [ ] **Step 2: Run the test and watch it fail.**

- [ ] **Step 3: Implement.** `preflightConnectors(connectors: ResolvedConnector[], definition, ownerKey)`
  runs, for each connector in parallel:
  1. resolve `definition()`;
  2. discover every scope in parallel;
  3. present the catalog with the connector's vendor and scope noun;
  4. apply the same status, problem and skipped rules as today;
  5. apply the target refusal when the connector has more than one scope.

  Warnings are unchanged. The GitHub-specific strings move into the GitHub type.

- [ ] **Step 4: Run the tests and watch them pass.** Then run the full suite once.

- [ ] **Step 5: Commit**

```bash
git add packages/broker/src/aws/registration-preflight.ts packages/broker/src/aws/broker.ts tests/contract/registration-preflight.test.ts
git commit -m "feat(broker): registration preflight covers every connector type"
```

---

### Task 5: Documentation

**Files:**
- Modify:
  - `specs/013-connector-gateway/contracts/control-api.md`: document the `includeAllConnectorTypes`
    flag, and that connector routes serve any configured type;
  - `specs/013-connector-gateway/data-model.md`: add `includeAllConnectorTypes` to the workspace
    resolution additions;
  - `specs/013-connector-gateway/plan.md`: add a phase 5a row linking this plan;
  - `README.md`: in the connectors section, say that each connector type is one definition, and
    name the three things a new type supplies: scopes, credential and binder.

- [ ] **Step 1: Update the documents.**
- [ ] **Step 2: Verify.** Run: `npm run typecheck && npm run lint && npm run build && npm test && npm run infra:synth`.
  Then confirm that the only existing assertion change on the branch since the phase 3 head is the
  thread-workspace-request body.
- [ ] **Step 3: Commit.** `git commit -m "docs: generic connector routes and the connector-type opt-in"`
