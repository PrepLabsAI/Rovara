# Phase 3: Credentials and Registration Preflight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give connectors other than GitHub a way to get credentials. The pieces are:

- an administrator-managed credential registry;
- `static-secret` and `oauth-client-credentials` providers, with token caching and one re-mint;
- a structured not-connected result when a credential is missing or rejected;
- registration preflight that reports what each connector will actually offer.

**Architecture:** The gateway owns everything vendor-neutral:

- the providers and the `CredentialUnavailable` error;
- a typed `McpUnauthorized` error raised when an MCP server answers HTTP 401;
- the engine rule "on 401, invalidate and re-issue once, then report not connected".

The broker owns the AWS-backed parts:

- the registry in the state table;
- the Secrets Manager secret source and the DynamoDB token cache;
- the admin routes;
- registration checks.

Nothing in phase 3 adds a connector type. Phase 5 (Linear) is the first consumer of
`CredentialRegistry.provider()`. The GitHub connector keeps its GitHub App issuer, and gains only
the 401 retry and the not-connected mapping.

**Tech Stack:** TypeScript 5.9 strict, Node 22.19–22.x, Zod 4, Vitest 5, MCP SDK 1.30.1, AWS SDK v3,
CDK 2, commander.

**Spec:** [../spec.md](../spec.md): FR-003, FR-004, FR-011, FR-012, FR-013, FR-014, FR-019, FR-023
(the warning); tasks T020–T024. Data: [../data-model.md](../data-model.md). Routes:
[../contracts/control-api.md](../contracts/control-api.md).

## Global Constraints

- **No regressions.** Every existing test passes with its assertions unchanged, with one exception.
  The admin command list in `tests/contract/cli-main.test.ts` gains `"credential"` (Task 5), because
  that test snapshots the command surface.
- **No vendor names.** Nothing outside `packages/gateway/src/github.ts` names a vendor (FR-001). The
  providers are generic, and the token endpoint is always a constructor argument that comes from
  code, never from a secret.
- **Secrets stay secret.** Secret values and minted tokens never appear in:
  - logs;
  - error messages;
  - HTTP responses;
  - ledger records;
  - test snapshots.

  A token-endpoint error surfaces only an OAuth `error` code matching `^[a-z_]{1,64}$`.
- **Secret names.** Connector secret names must begin with `agentx/connectors/`. The built-in GitHub
  App entry is the only exception, and it cannot be registered or replaced.
- **Older callers keep working.**
  - Registration preflight runs only when the request body has `preflight: true`. Older command-line
    clients and existing tests never trigger vendor calls during registration.
  - The legacy `/github/tools|call` routes keep feature 007 shapes and status codes.
- **One re-issue at most.** A second 401 is reported as not connected and never loops.
- **Node and build.** Node `>=22.19.0 <23`. Run `npm run build` before `npm test`. Node 22:
  `export PATH=/private/tmp/claude-501/node-v22.20.0-darwin-arm64/bin:$PATH`.
- **Commits.** Messages are `type(scope): summary`, ending with
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- **User preference.** Fix cheap review findings and anything that fails silently before the PR
  instead of deferring them.

## Review Focus

1. **Secret leakage through error paths.** A token endpoint that echoes `client_secret`, a Secrets
   Manager error that quotes the secret, or a thrown `Error` whose message holds the token must
   never reach a result, log or response. Tests: Task 3 (echoing endpoint), Task 4 (list and
   register responses).
2. **Retry bounds.** Two consecutive 401s produce exactly two credential issues and two connection
   attempts, and then not connected. If `invalidate` itself throws, the retry still happens.
   Tests: Task 2.
3. **Rolling deploy.**
   - A new command-line client against an old broker gets no `preflight` field back, and the client
     says so on stderr instead of silently claiming success.
   - An old command-line client against a new broker makes no vendor call.
   - Tests: Task 6.
4. **Rotation.**
   - Re-registering a credential deletes its cached tokens.
   - An invalidate after a 401 also drops the in-memory secret, so a rotated secret is re-read.
   - Tests: Task 3 and Task 4.
5. **Registration latency and failure isolation.** Preflight discovers every scope in parallel. One
   failing scope makes that connector's status `not_connected` or `unavailable`. It never fails the
   registration. Tests: Task 6.

## File Structure

| File | Responsibility |
|---|---|
| `packages/contracts/src/credentials.ts` (new) | Credential types, registration input, record, list entry, secret payload schemas |
| `packages/contracts/src/connectors.ts` | Tool budget constants and `toolBudget`, `approvedToolCount`, `presentedNameProblems`; preflight report schemas |
| `packages/gateway/src/mcp-client.ts` | `McpUnauthorized` on HTTP 401 during connect/discovery |
| `packages/gateway/src/credentials.ts` (new) | `CredentialUnavailable`, `SecretSource`, `TokenCache`, `staticSecretProvider`, `oauthClientCredentialsProvider` |
| `packages/gateway/src/types.ts` | `CredentialProvider.invalidate?` |
| `packages/gateway/src/engine.ts` | `ConnectorNotConnected`; one re-issue on 401; `not_connected` results |
| `packages/broker/src/aws/credentials.ts` (new) | `CredentialRegistry`, `DynamoTokenCache`, `secretsManagerSource` |
| `packages/broker/src/aws/registration-preflight.ts` (new) | `preflightConnectors` |
| `packages/broker/src/aws/broker.ts` | Wiring only: admin credential routes, connector-route not-connected catalog, registration checks, bootstrap |
| `infra/lib/control-plane.ts` | `secretsmanager:GetSecretValue` on `agentx/connectors/*` |
| `packages/cli/src/admin/credential.ts` (new) | `registerCredential`, `listCredentials` |
| `packages/cli/src/admin/register.ts`, `packages/cli/src/main.ts` | `preflight: true`, warnings to stderr, `admin credential` commands |
| `tests/support/admin-broker.ts` (new) | Minimal broker harness for admin-route tests |
| `tests/support/fake-dynamodb.ts` | Generic `begins_with` key condition and `DeleteCommand` on queried items |

## Pre-decided Rulings

- **Registry key layout.** Records live at `pk = CREDENTIALS, sk = REF#<ref>`, so one Query lists
  them. Tokens live at `pk = CREDENTIAL#<ref>, sk = TOKEN#<scopeKey>`. This amends the data model,
  which put records at `CREDENTIAL#<ref>/META`, because listing that layout would need a Scan.
  Task 7 updates the data model. Cost if wrong: a one-time key migration before any credential
  exists in production.
- **No TTL for token items.** The state table has no TTL attribute. Enabling one on a live table
  risks deleting unrelated items that share the attribute name. There is one token item per
  credential and scope set, overwritten on re-mint, and expiry is checked on read. Cost if wrong:
  a few stale items.
- **Only 401 means rejected.** HTTP 403 can mean a missing permission rather than a bad credential,
  so it stays `vendor_error`. Cost if wrong: a revoked key that answers 403 shows as a vendor error.
- **Budget counts approvals.** At registration, the budget is 6 in-house tools plus every approved
  connector tool. That is the most the model could ever see, and it needs no vendor call. With
  at most 32 approvals and one GitHub connector, the refusal above 40 cannot trigger until phase 5,
  so it is tested as a pure function.
- **Refusals apply to new revisions only.** Name-length, budget and `target` refusals run only when
  a revision is new. Re-submitting an already-registered revision stays idempotent even if it
  predates these checks.
- **The `credentialRef` check moves to phase 5.** The "credentialRef not in the registry" refusal
  waits for phase 5, because no connector type carries a `credentialRef` until then.

---

### Task 1: Credential contracts and the tool budget

**Files:**
- Create: `packages/contracts/src/credentials.ts`
- Modify: `packages/contracts/src/connectors.ts`, `packages/contracts/src/index.ts`
- Test: `tests/contract/credential-contracts.test.ts` (new), `tests/contract/orchestrator-boundary.test.ts` (one added test)

**Interfaces:**
- Produces:
  - `CredentialTypeSchema`, `RegistrableCredentialTypeSchema`, `CredentialRegistrationSchema`;
  - `CredentialRecordSchema`, `CredentialListEntrySchema`;
  - `StaticSecretSchema`, `OAuthClientCredentialsSecretSchema`;
  - `IN_HOUSE_TOOL_COUNT`, `TOOL_WARNING_THRESHOLD`, `TOOL_LIMIT`;
  - `approvedToolCount(definition)`, `toolBudget(approved)`, `presentedNameProblems(definition)`;
  - `ConnectorPreflightSchema`, `RegistrationPreflightSchema`, and their types.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/contract/credential-contracts.test.ts
import { describe, expect, it } from "vitest";
import {
  CredentialRegistrationSchema, OAuthClientCredentialsSecretSchema, StaticSecretSchema,
} from "../../packages/contracts/src/credentials.js";
import {
  IN_HOUSE_TOOL_COUNT, approvedToolCount, presentedNameProblems, toolBudget,
} from "../../packages/contracts/src/connectors.js";

describe("credential registration input", () => {
  it("accepts the two registrable types with a connector secret name", () => {
    expect(CredentialRegistrationSchema.parse({ ref: "linear-payments", type: "oauth-client-credentials", secretName: "agentx/connectors/linear-payments" }))
      .toEqual({ ref: "linear-payments", type: "oauth-client-credentials", secretName: "agentx/connectors/linear-payments" });
    expect(CredentialRegistrationSchema.safeParse({ ref: "jira-sa", type: "static-secret", secretName: "agentx/connectors/jira-sa" }).success).toBe(true);
  });

  it("refuses reserved and built-in types, other secret prefixes and extra fields", () => {
    for (const type of ["github-app", "oauth-refresh-token", "per-user", "basic"]) {
      expect(CredentialRegistrationSchema.safeParse({ ref: "x", type, secretName: "agentx/connectors/x" }).success).toBe(false);
    }
    expect(CredentialRegistrationSchema.safeParse({ ref: "x", type: "static-secret", secretName: "prod/db-password" }).success).toBe(false);
    expect(CredentialRegistrationSchema.safeParse({ ref: "x", type: "static-secret", secretName: "agentx/connectors/../x" }).success).toBe(false);
    expect(CredentialRegistrationSchema.safeParse({ ref: "Bad Ref", type: "static-secret", secretName: "agentx/connectors/x" }).success).toBe(false);
    expect(CredentialRegistrationSchema.safeParse({ ref: "x", type: "static-secret", secretName: "agentx/connectors/x", tokenEndpoint: "https://evil.test" }).success).toBe(false);
  });
});

describe("secret payloads", () => {
  it("parses a static key and client credentials with a fixed scope set", () => {
    expect(StaticSecretSchema.parse({ apiKey: "k" })).toEqual({ apiKey: "k" });
    expect(OAuthClientCredentialsSecretSchema.parse({ clientId: "id", clientSecret: "s", scopes: ["read", "write"] }))
      .toEqual({ clientId: "id", clientSecret: "s", scopes: ["read", "write"] });
  });

  it("refuses a secret that could redirect the broker or is missing fields", () => {
    expect(StaticSecretSchema.safeParse({ apiKey: "" }).success).toBe(false);
    expect(OAuthClientCredentialsSecretSchema.safeParse({ clientId: "id", clientSecret: "s", scopes: [] }).success).toBe(false);
    expect(OAuthClientCredentialsSecretSchema.safeParse({ clientId: "id", clientSecret: "s", scopes: ["read"], tokenEndpoint: "https://evil.test" }).success).toBe(false);
  });
});

describe("tool budget at registration", () => {
  it("counts in-house tools plus every approved connector tool", () => {
    const definition = { repositories: [], integrations: { connectors: [{ name: "github", type: "github", scopes: "all-repositories", tools: [{ name: "a", access: "read" }, { name: "b", access: "write" }] }] } };
    expect(approvedToolCount(definition as never)).toBe(2);
    expect(approvedToolCount({ repositories: [], integrations: { githubMcp: { tools: [{ name: "a", access: "read" }] } } } as never)).toBe(1);
    expect(approvedToolCount({ repositories: [] } as never)).toBe(0);
  });

  it("warns above 20 visible tools and refuses above 40", () => {
    expect(toolBudget(20 - IN_HOUSE_TOOL_COUNT)).toEqual({ maximum: 20 });
    expect(toolBudget(21 - IN_HOUSE_TOOL_COUNT)).toEqual({ maximum: 21, warning: "the model could see 21 tools; above 20, tool choice gets less reliable. Approve fewer connector tools." });
    expect(toolBudget(41 - IN_HOUSE_TOOL_COUNT)).toMatchObject({ maximum: 41, refusal: "this project could expose 41 tools; at most 40 are allowed. Approve fewer connector tools." });
  });

  it("names every approval whose presented name exceeds 64 characters", () => {
    const long = "t".repeat(57);
    const definition = { repositories: [], integrations: { connectors: [{ name: "github", type: "github", scopes: "all-repositories", tools: [{ name: long, access: "read" }, { name: "short", access: "read" }] }] } };
    expect(presentedNameProblems(definition as never)).toEqual([`connector github tool ${long}: presented name github__${long} exceeds 64 characters`]);
  });
});
```

Add to `tests/contract/orchestrator-boundary.test.ts`:

```ts
it("keeps the shared registration budget in step with the orchestrator", async () => {
  const { IN_HOUSE_TOOL_COUNT, TOOL_LIMIT } = await import("../../packages/contracts/src/connectors.js");
  const { ORCHESTRATION_TOOL_NAMES } = await import("../../packages/orchestrator/src/orchestration-tools.js");
  const { MAX_VISIBLE_TOOLS } = await import("../../packages/orchestrator/src/orchestrator.js");
  expect(ORCHESTRATION_TOOL_NAMES).toHaveLength(IN_HOUSE_TOOL_COUNT);
  expect(MAX_VISIBLE_TOOLS).toBe(TOOL_LIMIT);
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npm run build && npx vitest run tests/contract/credential-contracts.test.ts tests/contract/orchestrator-boundary.test.ts`
Expected: FAIL. The new test file cannot find module `credentials.js`, and the orchestrator-boundary
test fails because `IN_HOUSE_TOOL_COUNT` is not exported.

- [ ] **Step 3: Implement**

```ts
// packages/contracts/src/credentials.ts
import { z } from "zod";
import { AGENTX_NAME_PATTERN } from "./names.js";

/** Every provider type. github-app is built in; the last two are reserved for later releases. */
export const CredentialTypeSchema = z.enum(["github-app", "static-secret", "oauth-client-credentials", "oauth-refresh-token", "per-user"]);
export const RegistrableCredentialTypeSchema = z.enum(["static-secret", "oauth-client-credentials"]);
export const CONNECTOR_SECRET_PREFIX = "agentx/connectors/";

const SecretNameSchema = z.string().regex(/^agentx\/connectors\/[A-Za-z0-9_+=.@-]{1,128}$/, "secret name must be agentx/connectors/<name>");

export const CredentialRegistrationSchema = z.object({
  ref: z.string().regex(AGENTX_NAME_PATTERN),
  type: RegistrableCredentialTypeSchema,
  secretName: SecretNameSchema,
}).strict();

export const CredentialRecordSchema = CredentialRegistrationSchema.extend({
  registeredBy: z.string().min(1).max(256),
  registeredAt: z.iso.datetime(),
}).strict();

export const CredentialListEntrySchema = z.object({
  ref: z.string(),
  type: CredentialTypeSchema,
  secretName: z.string(),
  builtIn: z.boolean(),
  tokenCached: z.boolean(),
  registeredBy: z.string().optional(),
  registeredAt: z.string().optional(),
}).strict();

export const StaticSecretSchema = z.object({ apiKey: z.string().min(1).max(8_192) }).strict();
export const OAuthClientCredentialsSecretSchema = z.object({
  clientId: z.string().min(1).max(1_024),
  clientSecret: z.string().min(1).max(8_192),
  scopes: z.array(z.string().regex(/^[\x21-\x7e]{1,128}$/)).min(1).max(32),
}).strict();

export type CredentialType = z.infer<typeof CredentialTypeSchema>;
export type CredentialRegistration = z.infer<typeof CredentialRegistrationSchema>;
export type CredentialRecord = z.infer<typeof CredentialRecordSchema>;
export type CredentialListEntry = z.infer<typeof CredentialListEntrySchema>;
export type StaticSecret = z.infer<typeof StaticSecretSchema>;
export type OAuthClientCredentialsSecret = z.infer<typeof OAuthClientCredentialsSecretSchema>;
```

The secret-name pattern allows no `/` after the prefix and no `..` segments, because its character
class has no `/`.

Append to `packages/contracts/src/connectors.ts`. `ProjectDefinition` is imported as a type only,
from `./project.js`. If that creates a cycle, take a structural parameter
`{ integrations?: { githubMcp?: { tools: unknown[] }; connectors?: Array<{ name: string; tools: Array<{ name: string }> }> } }`
instead.

```ts
/** Six in-house tools when recovery tools are shown; kept equal to ORCHESTRATION_TOOL_NAMES by a test. */
export const IN_HOUSE_TOOL_COUNT = 6;
export const TOOL_WARNING_THRESHOLD = 20;
export const TOOL_LIMIT = 40;

interface ConnectorApprovals {
  integrations?: {
    githubMcp?: { tools: ReadonlyArray<{ name: string }> } | undefined;
    connectors?: ReadonlyArray<{ name: string; tools: ReadonlyArray<{ name: string }> }> | undefined;
  } | undefined;
}

export function approvedToolCount(definition: ConnectorApprovals): number {
  const legacy = definition.integrations?.githubMcp?.tools.length ?? 0;
  return legacy + (definition.integrations?.connectors ?? []).reduce((sum, connector) => sum + connector.tools.length, 0);
}

/** The most tools the model could see: every in-house tool plus every approval. */
export function toolBudget(approved: number): { maximum: number; warning?: string; refusal?: string } {
  const maximum = IN_HOUSE_TOOL_COUNT + approved;
  if (maximum > TOOL_LIMIT) return { maximum, refusal: `this project could expose ${maximum} tools; at most ${TOOL_LIMIT} are allowed. Approve fewer connector tools.` };
  if (maximum > TOOL_WARNING_THRESHOLD) return { maximum, warning: `the model could see ${maximum} tools; above ${TOOL_WARNING_THRESHOLD}, tool choice gets less reliable. Approve fewer connector tools.` };
  return { maximum };
}

export function presentedNameProblems(definition: ConnectorApprovals): string[] {
  const connectors = definition.integrations?.githubMcp
    ? [{ name: "github", tools: definition.integrations.githubMcp.tools }]
    : definition.integrations?.connectors ?? [];
  return connectors.flatMap((connector) => connector.tools
    .map((tool) => `${connector.name}__${tool.name}`)
    .filter((presented) => presented.length > 64)
    .map((presented) => `connector ${connector.name} tool ${presented.slice(connector.name.length + 2)}: presented name ${presented} exceeds 64 characters`));
}

export const ConnectorPreflightSchema = z.object({
  name: ConnectorNameSchema,
  status: z.enum(["connected", "not_connected", "unavailable"]),
  problem: z.string().max(512).optional(),
  offered: z.array(z.string().max(64)).max(40),
  skipped: z.array(z.object({ tool: z.string().max(64), reason: z.string().max(256) }).strict()).max(64),
}).strict();

export const RegistrationPreflightSchema = z.object({
  connectors: z.array(ConnectorPreflightSchema).max(8),
}).strict();

export type ConnectorPreflight = z.infer<typeof ConnectorPreflightSchema>;
export type RegistrationPreflight = z.infer<typeof RegistrationPreflightSchema>;
```

Export `./credentials.js` from `packages/contracts/src/index.ts`.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npm run build && npx vitest run tests/contract/credential-contracts.test.ts tests/contract/orchestrator-boundary.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite and commit**

Run: `npm run typecheck && npm run lint && npm run build && npm test`. Expected: all pass.

```bash
git add packages/contracts/src tests/contract/credential-contracts.test.ts tests/contract/orchestrator-boundary.test.ts
git commit -m "feat(contracts): credential registry schemas and registration tool budget"
```

---

### Task 2: Rejected and missing credentials become "not connected"

**Files:**
- Modify:
  - `packages/gateway/src/mcp-client.ts`, `packages/gateway/src/types.ts`, `packages/gateway/src/engine.ts`;
  - `packages/gateway/src/index.ts`;
  - `packages/broker/src/aws/broker.ts`, the connector route discovery only.
- Create: `packages/gateway/src/credentials.ts`, with only `CredentialUnavailable` in this task
  (Task 3 adds the providers).
- Test:
  - `tests/integration/github-mcp.test.ts`, one added test;
  - `tests/contract/gateway-engine.test.ts`, added tests;
  - `tests/contract/slack-control-plane.test.ts`, added tests.

**Interfaces:**
- Produces:
  - `class McpUnauthorized extends Error`, from `mcp-client.ts`;
  - `class CredentialUnavailable extends Error`, from `credentials.ts`;
  - `class ConnectorNotConnected extends AgentXError`, code `RUNTIME_UNAVAILABLE`, from `engine.ts`;
  - `CredentialProvider.invalidate?(scope: Scope): Promise<void>`.
- Consumed by: Task 3 (providers throw `CredentialUnavailable` and implement `invalidate`), Task 6
  (preflight maps `ConnectorNotConnected` to `not_connected`).

- [ ] **Step 1: Write the failing tests**

In `tests/integration/github-mcp.test.ts`, add:

```ts
it("reports an HTTP 401 as a rejected credential and any other failure unchanged", async () => {
  const { McpUnauthorized } = await import("../../packages/gateway/src/mcp-client.js");
  const open = (status: number) => connectMcp({
    endpoint: new URL("https://mcp.example.test/"), token: "rejected-token", tools: ["issue_read"], signal: AbortSignal.timeout(5000),
    fetchImplementation: async () => new Response("denied rejected-token", { status }),
  });
  const unauthorized = await open(401).catch((error: unknown) => error);
  expect(unauthorized).toBeInstanceOf(McpUnauthorized);
  expect(String((unauthorized as Error).message)).not.toContain("rejected-token");
  expect(await open(500).catch((error: unknown) => error)).not.toBeInstanceOf(McpUnauthorized);
  expect(await open(403).catch((error: unknown) => error)).not.toBeInstanceOf(McpUnauthorized);
});
```

In `tests/contract/gateway-engine.test.ts`, import `McpUnauthorized`, `CredentialUnavailable` and
`ConnectorNotConnected` from the gateway sources, then add:

```ts
describe("credentials that are missing or rejected", () => {
  it("re-issues once after a 401 and succeeds with the new credential", async () => {
    const f = fixture();
    const invalidate = vi.fn(async () => undefined);
    f.connector.credentials.invalidate = invalidate;
    f.issue.mockResolvedValueOnce({ token: "stale", bindings: {} }).mockResolvedValueOnce({ token: "fresh", bindings: {} });
    f.connect.mockRejectedValueOnce(new McpUnauthorized());
    const result = await executeTool(f.request("list_items", { state: "open" }), f.connector, f.context, { connect: f.connect, ledger: f.ledger });
    expect(result.status).toBe("SUCCEEDED");
    expect(invalidate).toHaveBeenCalledOnce();
    expect(f.connect.mock.calls.map(([options]) => options.token)).toEqual(["stale", "fresh"]);
  });

  it("reports a second 401 as not connected without a third attempt, even when invalidate fails", async () => {
    const f = fixture();
    f.connector.credentials.invalidate = vi.fn(async () => { throw new Error("cache down"); });
    f.connect.mockRejectedValue(new McpUnauthorized());
    const result = await executeTool(f.request("create_item", { title: "Bug" }), f.connector, f.context, { connect: f.connect, ledger: f.ledger });
    expect(result).toMatchObject({ status: "FAILED", reason: "not_connected" });
    expect(result.text).toContain("Tracker is not connected");
    expect(f.issue).toHaveBeenCalledTimes(2);
    expect(f.connect).toHaveBeenCalledTimes(2);
    expect(f.call).not.toHaveBeenCalled();
  });

  it("reports a missing credential as not connected with the administrator-facing reason", async () => {
    const f = fixture();
    f.issue.mockRejectedValueOnce(new CredentialUnavailable("credential tracker-key is not registered"));
    const result = await executeTool(f.request("create_item", { title: "Bug" }), f.connector, f.context, { connect: f.connect, ledger: f.ledger });
    expect(result).toMatchObject({ status: "FAILED", reason: "not_connected" });
    expect(result.text).toContain("credential tracker-key is not registered");
    expect(f.connect).not.toHaveBeenCalled();
  });

  it("raises ConnectorNotConnected from discovery, which keeps the RUNTIME_UNAVAILABLE code", async () => {
    const f = fixture();
    f.connect.mockRejectedValue(new McpUnauthorized());
    const error = await discoverTools(f.connector, f.context, { connect: f.connect }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConnectorNotConnected);
    expect(error).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(f.connect).toHaveBeenCalledTimes(2);
  });

  it("keeps a plain issuer failure a vendor error, as before", async () => {
    const f = fixture();
    f.issue.mockRejectedValueOnce(new Error("app not installed"));
    const result = await executeTool(f.request("create_item", { title: "Bug" }), f.connector, f.context, { connect: f.connect, ledger: f.ledger });
    expect(result).toMatchObject({ status: "FAILED", reason: "vendor_error" });
  });
});
```

In `tests/contract/slack-control-plane.test.ts`, add two tests beside the existing connector-route
tests, using its `createBroker`, `registerProjectAndBind`, `ensureWorkspace` and `markReady`
helpers:

1. A GitHub `connect` fake that always throws `new McpUnauthorized()`. Then:
   - `GET /connectors/github/tools` returns 200 with
     `{ catalog: { connector: "github", notConnected: true, tools: [], skipped: [] } }`;
   - exactly one `console.log` line has `event: "connector.not_connected"`, with project, revision,
     connector, scope and a `message`;
   - no logged line contains `installation-secret`.
2. The same fake on the legacy `GET /github/tools?repository=demo` returns HTTP 503 with error code
   `RUNTIME_UNAVAILABLE`, exactly as a discovery failure did before.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npm run build && npx vitest run tests/integration/github-mcp.test.ts tests/contract/gateway-engine.test.ts tests/contract/slack-control-plane.test.ts`
Expected: FAIL. `McpUnauthorized`, `CredentialUnavailable` and `ConnectorNotConnected` are not
exported, and the connector route returns 503.

- [ ] **Step 3: Implement**

`mcp-client.ts`:

```ts
/** The MCP server answered HTTP 401: the credential was rejected. Carries no server text. */
export class McpUnauthorized extends Error {
  constructor() { super("MCP server rejected the credential"); this.name = "McpUnauthorized"; }
}
```

In `connectMcp`, declare `let unauthorized = false;`. In the wrapped `fetch`, after the response
arrives, add `if (response.status === 401) unauthorized = true;`. In the existing `catch`, after
`client.close()`, add `throw unauthorized ? new McpUnauthorized() : error;`.

`credentials.ts` (new):

```ts
/** A credential is missing, malformed or refused. The message is for an administrator and never holds a secret. */
export class CredentialUnavailable extends Error {
  constructor(message: string) { super(message); this.name = "CredentialUnavailable"; }
}
```

`types.ts`, on `CredentialProvider`:

```ts
/** Drops any cached credential after the vendor rejected it; the next issue() mints or reads a fresh one. */
invalidate?(scope: Scope): Promise<void>;
```

`engine.ts`:

```ts
/** Discovery found the connector's credential missing or rejected. RUNTIME_UNAVAILABLE keeps feature 007 callers unchanged. */
export class ConnectorNotConnected extends AgentXError {
  constructor(message: string) { super("RUNTIME_UNAVAILABLE", message, errorStatus("RUNTIME_UNAVAILABLE")); this.name = "ConnectorNotConnected"; }
}

/** Issues a credential and connects; after a 401, invalidates and tries exactly once more. */
async function openConnection<Scope>(
  connector: ConnectorDefinition<Scope>, context: ConnectorContext<Scope>, access: Access,
  tools: string[], signal: AbortSignal, options: EngineOptions,
): Promise<{ credential: IssuedCredential; connection: McpConnection }> {
  for (let attempt = 0; ; attempt += 1) {
    const credential = await withDeadline(connector.credentials.issue(context.scope, access, context.requestedBy), signal);
    try {
      return { credential, connection: await (options.connect ?? connectMcp)({ endpoint: connector.endpoint, token: credential.token, tools, signal }) };
    } catch (error) {
      if (!(error instanceof McpUnauthorized)) throw error;
      if (attempt > 0) throw new CredentialUnavailable(`${connector.label} rejected the credential twice; check ${connector.permissionsHint}`);
      await connector.credentials.invalidate?.(context.scope).catch(() => undefined);
    }
  }
}
```

- **`discoverTools`.** Use `openConnection(connector, context, "read", policyToolNames, signal, options)`.
  In its `catch`:
  - a `CredentialUnavailable` becomes
    `throw new ConnectorNotConnected(\`${connector.label} is not connected: ${error.message}\`)`;
  - every other error keeps the existing `RUNTIME_UNAVAILABLE` agentXError.
- **`executeTool`.** Replace the `issue` and `connect` lines with
  `({ credential, connection } = await openConnection(connector, context, policy.access, tools, signal, options))`.
  The first branch of the `catch` chain becomes:

```ts
error instanceof CredentialUnavailable
  ? publicResult(request, "FAILED", `${label} is not connected for this project: ${error.message}. An administrator must fix its credential.`, "not_connected")
  : /* existing DefinitionChanged / PolicyFailure / writeAttempted / vendor_error chain */
```

`connection` must still be assigned so that `finally` closes it.

Export `./credentials.js` from the gateway index.

In `broker.ts`, in the connector-route discovery loop, wrap the `discoverGitHubScope` call:

```ts
let discovered: GitHubMcpCatalog;
try {
  discovered = await discoverGitHubScope(dependencies, identity, workspace, project, github, repository);
} catch (error) {
  if (!(error instanceof ConnectorNotConnected)) throw error;
  console.log(JSON.stringify({
    component: "broker", event: "connector.not_connected", project: workspace.projectName,
    revision: project.definition.revision, connector: github.name, scope: repository.name,
    message: stripCode(error.message, error.code),
  }));
  return json({ catalog: { connector: github.name, notConnected: true, tools: [], skipped: [] } }, request.requestId);
}
```

The legacy route is unchanged. `ConnectorNotConnected` is an `AgentXError` with code
`RUNTIME_UNAVAILABLE`, so the route still answers 503.

- [ ] **Step 4: Run the tests and watch them pass**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Run the full suite and commit**

Run: `npm run typecheck && npm run lint && npm run build && npm test`. Expected: all pass, with no
existing assertion changed.

```bash
git add packages/gateway/src packages/broker/src/aws/broker.ts tests/integration/github-mcp.test.ts tests/contract/gateway-engine.test.ts tests/contract/slack-control-plane.test.ts
git commit -m "feat(gateway): report missing or rejected credentials as not connected, re-issuing once after a 401"
```

---

### Task 3: `static-secret` and `oauth-client-credentials` providers

**Files:**
- Modify: `packages/gateway/src/credentials.ts`
- Test: `tests/contract/gateway-credentials.test.ts` (new)

**Interfaces:**
- Consumes:
  - from Task 1: `StaticSecretSchema`, `OAuthClientCredentialsSecretSchema`;
  - from Task 2: `CredentialUnavailable`, `CredentialProvider.invalidate`.
- Produces:

```ts
export interface SecretSource { read(secretName: string): Promise<string | undefined> }  // undefined: no such secret
export interface CachedToken { token: string; expiresAt: number }                         // epoch milliseconds
export interface TokenCache { get(key: string): Promise<CachedToken | undefined>; put(key: string, value: CachedToken): Promise<void>; delete(key: string): Promise<void> }
export function staticSecretProvider(options: { ref: string; secretName: string; secrets: SecretSource; now?: () => number }): CredentialProvider<unknown>;
export function oauthClientCredentialsProvider(options: { ref: string; secretName: string; secrets: SecretSource; tokens: TokenCache; tokenEndpoint: URL; fetchImplementation?: typeof fetch; now?: () => number }): CredentialProvider<unknown>;
export function scopeKey(scopes: readonly string[]): string;  // 32 hex chars of SHA-256 over the sorted scopes
```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/contract/gateway-credentials.test.ts
import { describe, expect, it, vi } from "vitest";
import {
  CredentialUnavailable, oauthClientCredentialsProvider, scopeKey, staticSecretProvider,
  type CachedToken, type SecretSource, type TokenCache,
} from "../../packages/gateway/src/credentials.js";

const secrets = (values: Record<string, string>): SecretSource & { read: ReturnType<typeof vi.fn> } => ({
  read: vi.fn(async (name: string) => values[name]),
});
function memoryCache(): TokenCache & { items: Map<string, CachedToken> } {
  const items = new Map<string, CachedToken>();
  return { items, get: async (key) => items.get(key), put: async (key, value) => { items.set(key, value); }, delete: async (key) => { items.delete(key); } };
}
const client = JSON.stringify({ clientId: "client-id", clientSecret: "client-secret-value", scopes: ["write", "read"] });
const endpoint = new URL("https://auth.vendor.test/oauth/token");

describe("static-secret provider", () => {
  it("returns the API key, rereads after five minutes or after invalidate, and never binds routing values", async () => {
    let now = 0;
    const source = secrets({ "agentx/connectors/jira": JSON.stringify({ apiKey: "key-1" }) });
    const provider = staticSecretProvider({ ref: "jira", secretName: "agentx/connectors/jira", secrets: source, now: () => now });
    expect(await provider.issue(undefined, "read")).toEqual({ token: "key-1", bindings: {} });
    await provider.issue(undefined, "write");
    expect(source.read).toHaveBeenCalledOnce();
    now = 300_000;
    await provider.issue(undefined, "read");
    expect(source.read).toHaveBeenCalledTimes(2);
    await provider.invalidate?.(undefined);
    await provider.issue(undefined, "read");
    expect(source.read).toHaveBeenCalledTimes(3);
  });

  it("reports a missing or malformed secret as unavailable without echoing its content", async () => {
    const missing = staticSecretProvider({ ref: "jira", secretName: "agentx/connectors/jira", secrets: secrets({}) });
    await expect(missing.issue(undefined, "read")).rejects.toThrow(new CredentialUnavailable("credential jira: secret agentx/connectors/jira was not found"));
    const malformed = staticSecretProvider({ ref: "jira", secretName: "agentx/connectors/jira", secrets: secrets({ "agentx/connectors/jira": JSON.stringify({ token: "leaky-value" }) }) });
    const error = await malformed.issue(undefined, "read").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CredentialUnavailable);
    expect((error as Error).message).toBe('credential jira: secret agentx/connectors/jira must be JSON {"apiKey": "..."}');
    expect((error as Error).message).not.toContain("leaky-value");
  });
});

describe("oauth-client-credentials provider", () => {
  const tokenResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("mints with the fixed scope set, form-encoded, without following redirects", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () => tokenResponse({ access_token: "token-1", expires_in: 3600, token_type: "Bearer" }));
    const provider = oauthClientCredentialsProvider({ ref: "linear", secretName: "s", secrets: secrets({ s: client }), tokens: memoryCache(), tokenEndpoint: endpoint, fetchImplementation, now: () => 0 });
    expect(await provider.issue(undefined, "read")).toEqual({ token: "token-1", bindings: {} });
    const [url, init] = fetchImplementation.mock.calls[0]!;
    expect(String(url)).toBe(endpoint.href);
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect(new Headers(init?.headers).get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({ grant_type: "client_credentials", client_id: "client-id", client_secret: "client-secret-value", scope: "write read" });
  });

  it("reuses a token until five minutes before expiry, from memory and then from the shared cache", async () => {
    let now = 0;
    const tokens = memoryCache();
    const fetchImplementation = vi.fn<typeof fetch>(async () => tokenResponse({ access_token: `token-${fetchImplementation.mock.calls.length}`, expires_in: 3600 }));
    const options = { ref: "linear", secretName: "s", secrets: secrets({ s: client }), tokens, tokenEndpoint: endpoint, fetchImplementation, now: () => now };
    const first = oauthClientCredentialsProvider(options);
    await first.issue(undefined, "read");
    await first.issue(undefined, "read");
    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(tokens.items.get(scopeKey(["read", "write"]))).toEqual({ token: "token-1", expiresAt: 3_600_000 });
    // Another container reads the shared cache instead of minting.
    expect(await oauthClientCredentialsProvider(options).issue(undefined, "read")).toMatchObject({ token: "token-1" });
    expect(fetchImplementation).toHaveBeenCalledOnce();
    now = 3_600_000 - 300_000;
    expect(await first.issue(undefined, "read")).toMatchObject({ token: "token-2" });
  });

  it("invalidate deletes the cached token and rereads the secret, so a rotated secret is used", async () => {
    const tokens = memoryCache();
    const source = secrets({ s: client });
    const fetchImplementation = vi.fn<typeof fetch>(async () => tokenResponse({ access_token: `token-${fetchImplementation.mock.calls.length}`, expires_in: 3600 }));
    const provider = oauthClientCredentialsProvider({ ref: "linear", secretName: "s", secrets: source, tokens, tokenEndpoint: endpoint, fetchImplementation, now: () => 0 });
    await provider.issue(undefined, "read");
    await provider.invalidate?.(undefined);
    expect(tokens.items.size).toBe(0);
    expect(await provider.issue(undefined, "read")).toMatchObject({ token: "token-2" });
    expect(source.read).toHaveBeenCalledTimes(2);
  });

  it("reports refused client credentials as unavailable with only the OAuth error code", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () => tokenResponse({ error: "invalid_client", error_description: "bad client-secret-value" }, 401));
    const provider = oauthClientCredentialsProvider({ ref: "linear", secretName: "s", secrets: secrets({ s: client }), tokens: memoryCache(), tokenEndpoint: endpoint, fetchImplementation });
    const error = await provider.issue(undefined, "read").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CredentialUnavailable);
    expect((error as Error).message).toBe("credential linear: the token endpoint refused the client credentials with HTTP 401 (invalid_client)");
  });

  it("treats a server error or a response without a token as transient, never echoing the body", async () => {
    for (const response of [new Response("oops client-secret-value", { status: 502 }), tokenResponse({ token_type: "Bearer" })]) {
      const provider = oauthClientCredentialsProvider({ ref: "linear", secretName: "s", secrets: secrets({ s: client }), tokens: memoryCache(), tokenEndpoint: endpoint, fetchImplementation: vi.fn<typeof fetch>(async () => response) });
      const error = await provider.issue(undefined, "read").catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(CredentialUnavailable);
      expect((error as Error).message).not.toContain("client-secret-value");
    }
  });

  it("assumes one hour when the endpoint omits expires_in", async () => {
    const tokens = memoryCache();
    const provider = oauthClientCredentialsProvider({ ref: "linear", secretName: "s", secrets: secrets({ s: client }), tokens, tokenEndpoint: endpoint, fetchImplementation: vi.fn<typeof fetch>(async () => tokenResponse({ access_token: "t" })), now: () => 10 });
    await provider.issue(undefined, "read");
    expect([...tokens.items.values()]).toEqual([{ token: "t", expiresAt: 3_600_010 }]);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npm run build && npx vitest run tests/contract/gateway-credentials.test.ts`
Expected: FAIL, because `staticSecretProvider` is not exported.

- [ ] **Step 3: Implement** in `packages/gateway/src/credentials.ts`, below `CredentialUnavailable`:

```ts
import { createHash } from "node:crypto";
import { OAuthClientCredentialsSecretSchema, StaticSecretSchema, type OAuthClientCredentialsSecret, type StaticSecret } from "@agentx/contracts";
import type { CredentialProvider } from "./types.js";
import { isObject } from "./util.js";

export interface SecretSource { read(secretName: string): Promise<string | undefined> }
export interface CachedToken { token: string; expiresAt: number }
export interface TokenCache {
  get(key: string): Promise<CachedToken | undefined>;
  put(key: string, value: CachedToken): Promise<void>;
  delete(key: string): Promise<void>;
}

const SECRET_TTL_MS = 300_000;
const REFRESH_MARGIN_MS = 300_000;
const DEFAULT_EXPIRES_IN_S = 3_600;
const TOKEN_TIMEOUT_MS = 10_000;
const MAX_TOKEN_RESPONSE = 65_536;

export function scopeKey(scopes: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify([...scopes].sort())).digest("hex").slice(0, 32);
}

/** Reads and parses a secret, caching it in memory for five minutes. */
function cachedSecret<T>(options: { ref: string; secretName: string; secrets: SecretSource; now: () => number }, parse: (value: unknown) => T | undefined, shape: string) {
  let cached: { value: T; readAt: number } | undefined;
  return {
    async get(): Promise<T> {
      if (cached && options.now() - cached.readAt < SECRET_TTL_MS) return cached.value;
      const raw = await options.secrets.read(options.secretName);
      if (raw === undefined) throw new CredentialUnavailable(`credential ${options.ref}: secret ${options.secretName} was not found`);
      let json: unknown;
      try { json = JSON.parse(raw); } catch { json = undefined; }
      const value = parse(json);
      if (value === undefined) throw new CredentialUnavailable(`credential ${options.ref}: secret ${options.secretName} must be JSON ${shape}`);
      cached = { value, readAt: options.now() };
      return value;
    },
    clear() { cached = undefined; },
  };
}

export function staticSecretProvider(options: { ref: string; secretName: string; secrets: SecretSource; now?: () => number }): CredentialProvider<unknown> {
  const secret = cachedSecret<StaticSecret>({ ...options, now: options.now ?? Date.now }, (value) => {
    const parsed = StaticSecretSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  }, '{"apiKey": "..."}');
  return {
    async issue() { return { token: (await secret.get()).apiKey, bindings: {} }; },
    async invalidate() { secret.clear(); },
  };
}

export function oauthClientCredentialsProvider(options: {
  ref: string; secretName: string; secrets: SecretSource; tokens: TokenCache; tokenEndpoint: URL;
  fetchImplementation?: typeof fetch; now?: () => number;
}): CredentialProvider<unknown> {
  const now = options.now ?? Date.now;
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const secret = cachedSecret<OAuthClientCredentialsSecret>({ ...options, now }, (value) => {
    const parsed = OAuthClientCredentialsSecretSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  }, '{"clientId": "...", "clientSecret": "...", "scopes": ["..."]}');
  let memory: (CachedToken & { key: string }) | undefined;
  let lastKey: string | undefined;
  const usable = (token: CachedToken | undefined): token is CachedToken => token !== undefined && token.expiresAt - REFRESH_MARGIN_MS > now();

  async function mint(client: OAuthClientCredentialsSecret): Promise<CachedToken> {
    const response = await fetchImplementation(options.tokenEndpoint, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: client.clientId, client_secret: client.clientSecret, scope: client.scopes.join(" ") }).toString(),
    });
    const text = await response.text();
    if (text.length > MAX_TOKEN_RESPONSE) throw new Error("token endpoint response exceeded limit");
    let body: unknown;
    try { body = JSON.parse(text); } catch { body = undefined; }
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      const code = isObject(body) && typeof body.error === "string" && /^[a-z_]{1,64}$/.test(body.error) ? ` (${body.error})` : "";
      throw new CredentialUnavailable(`credential ${options.ref}: the token endpoint refused the client credentials with HTTP ${response.status}${code}`);
    }
    if (!response.ok) throw new Error(`token endpoint returned HTTP ${response.status}`);
    if (!isObject(body) || typeof body.access_token !== "string" || body.access_token.length === 0) throw new Error("token endpoint returned no access token");
    const seconds = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : DEFAULT_EXPIRES_IN_S;
    return { token: body.access_token, expiresAt: now() + seconds * 1000 };
  }

  return {
    async issue() {
      const client = await secret.get();
      const key = scopeKey(client.scopes);
      lastKey = key;
      if (memory?.key === key && usable(memory)) return { token: memory.token, bindings: {} };
      const stored = await options.tokens.get(key);
      if (usable(stored)) {
        memory = { ...stored, key };
        return { token: stored.token, bindings: {} };
      }
      const minted = await mint(client);
      memory = { ...minted, key };
      await options.tokens.put(key, minted);
      return { token: minted.token, bindings: {} };
    },
    async invalidate() {
      memory = undefined;
      secret.clear();
      if (lastKey !== undefined) await options.tokens.delete(lastKey);
    },
  };
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Run the full suite and commit**

Run the full suite as in Task 1. Then commit:

```bash
git add packages/gateway/src/credentials.ts tests/contract/gateway-credentials.test.ts
git commit -m "feat(gateway): static-secret and oauth-client-credentials providers"
```

---

### Task 4: Credential registry, admin routes and the secret grant

**Files:**
- Create: `packages/broker/src/aws/credentials.ts`, `tests/support/admin-broker.ts`, `tests/contract/credential-registry.test.ts`
- Modify:
  - `packages/broker/src/aws/broker.ts` (routes, dependencies, bootstrap);
  - `tests/support/fake-dynamodb.ts`;
  - `infra/lib/control-plane.ts`;
  - `tests/contract/infrastructure.test.ts` (one added test).

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces:

```ts
export interface ConnectorCredentialsConfiguration {
  secrets: SecretSource;
  githubApp: { ref: string; secretName: string };
  fetchImplementation?: typeof fetch;
}
export class CredentialRegistry {
  constructor(options: ConnectorCredentialsConfiguration & { documentClient: DynamoDBDocumentClient; tableName: string; now?: () => number });
  register(identity: AuthenticatedIdentity, body: unknown): Promise<{ credential: CredentialListEntry; replaced: boolean }>;
  list(identity: AuthenticatedIdentity): Promise<{ credentials: CredentialListEntry[] }>;
  /** Phase 5 entry point: a provider that resolves the record on each issue, so re-registration takes effect. */
  provider(ref: string, options?: { tokenEndpoint?: URL }): CredentialProvider<unknown>;
}
export class DynamoTokenCache implements TokenCache { constructor(client: DynamoDBDocumentClient, tableName: string, ref: string) }
export function secretsManagerSource(client: { send(command: GetSecretValueCommand): Promise<{ SecretString?: string; SecretBinary?: Uint8Array }> }): SecretSource;
```

`AwsBrokerInput` gains `connectorCredentials?: ConnectorCredentialsConfiguration`. It stays optional,
so existing harnesses are unchanged.

- [ ] **Step 1: Extend the fake and write the failing tests**

`tests/support/fake-dynamodb.ts`. The query accepts any `pk = :pk AND begins_with(sk, :<name>)`
key condition. Keep the existing behavior for `:revision` and read the prefix from the named
placeholder:

```ts
const match = /^pk = :pk AND begins_with\(sk, (:[a-zA-Z]+)\)$/.exec(String(input.KeyConditionExpression));
if (!match) throw new Error(`FakeDynamoDb does not support the key condition ${String(input.KeyConditionExpression)}`);
const prefix = values[match[1]!] as string;
```

`tests/support/admin-broker.ts`. Build this helper once by reusing the dependency set of
`createBroker` in `slack-control-plane.test.ts`: a fake DynamoDB, no Slack, and optional `githubMcp`
and `connectorCredentials`. It exports:
- `createAdminBroker(options)`, returning `{ db, handler }`;
- `adminCall(handler, { method, path, body?, admin?: boolean })`, which sends the JWT authorizer
  claims `{ iss: issuer, sub: "admin-subject", groups: admin === false ? [] : ["admins"] }` and
  returns `{ status, body }`.

It must set the same `process.env` values in a `beforeAll`-safe way, and import the broker
dynamically, as `slack-control-plane.test.ts` does.

`tests/contract/credential-registry.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { CredentialUnavailable } from "../../packages/gateway/src/credentials.js";
import { adminCall, createAdminBroker } from "../support/admin-broker.js";

const githubApp = { ref: "github-app", secretName: "arn:aws:secretsmanager:us-east-1:111122223333:secret:github-key" };
const secretValues: Record<string, string> = {
  "agentx/connectors/jira-sa": JSON.stringify({ apiKey: "jira-key-value" }),
  "agentx/connectors/linear": JSON.stringify({ clientId: "id", clientSecret: "linear-secret-value", scopes: ["read"] }),
};
const secrets = { read: vi.fn(async (name: string) => secretValues[name]) };

describe("credential registry routes", () => {
  it("registers, lists with the built-in GitHub App first, and never returns a secret value", async () => {
    const { handler } = await createAdminBroker({ connectorCredentials: { secrets, githubApp } });
    const registered = await adminCall(handler, { method: "POST", path: "/v1/admin/credentials", body: { ref: "jira-sa", type: "static-secret", secretName: "agentx/connectors/jira-sa" } });
    expect(registered.status).toBe(201);
    expect(registered.body).toMatchObject({ replaced: false, credential: { ref: "jira-sa", type: "static-secret", builtIn: false, tokenCached: false } });
    const listed = await adminCall(handler, { method: "GET", path: "/v1/admin/credentials" });
    expect(listed.status).toBe(200);
    expect((listed.body.credentials as Array<{ ref: string }>).map((entry) => entry.ref)).toEqual(["github-app", "jira-sa"]);
    expect(listed.body.credentials).toContainEqual({ ref: "github-app", type: "github-app", secretName: githubApp.secretName, builtIn: true, tokenCached: false });
    expect(JSON.stringify([registered.body, listed.body])).not.toMatch(/jira-key-value|linear-secret-value/);
  });

  it("requires the administrator claim", async () => {
    const { handler } = await createAdminBroker({ connectorCredentials: { secrets, githubApp } });
    expect((await adminCall(handler, { method: "GET", path: "/v1/admin/credentials", admin: false })).status).toBe(403);
    expect((await adminCall(handler, { method: "POST", path: "/v1/admin/credentials", admin: false, body: { ref: "jira-sa", type: "static-secret", secretName: "agentx/connectors/jira-sa" } })).status).toBe(403);
  });

  it("refuses the built-in reference, a missing secret and a secret of the wrong shape, naming only the secret", async () => {
    const { handler } = await createAdminBroker({ connectorCredentials: { secrets, githubApp } });
    const refuse = async (body: Record<string, unknown>) => adminCall(handler, { method: "POST", path: "/v1/admin/credentials", body });
    expect((await refuse({ ref: "github-app", type: "static-secret", secretName: "agentx/connectors/jira-sa" })).body).toMatchObject({ error: { code: "CONFIG_INVALID", message: "github-app is the built-in GitHub App credential and cannot be replaced" } });
    expect((await refuse({ ref: "missing", type: "static-secret", secretName: "agentx/connectors/missing" })).body).toMatchObject({ error: { code: "CONFIG_INVALID", message: "credential missing: secret agentx/connectors/missing was not found" } });
    const wrong = await refuse({ ref: "linear", type: "static-secret", secretName: "agentx/connectors/linear" });
    expect(wrong.body).toMatchObject({ error: { code: "CONFIG_INVALID", message: 'credential linear: secret agentx/connectors/linear must be JSON {"apiKey": "..."}' } });
    expect(JSON.stringify(wrong.body)).not.toContain("linear-secret-value");
  });

  it("replacing a credential deletes its cached tokens and reports tokenCached", async () => {
    const { db, handler } = await createAdminBroker({ connectorCredentials: { secrets, githubApp } });
    await adminCall(handler, { method: "POST", path: "/v1/admin/credentials", body: { ref: "linear", type: "oauth-client-credentials", secretName: "agentx/connectors/linear" } });
    db.set({ pk: "CREDENTIAL#linear", sk: "TOKEN#abc", token: "cached-token", expiresAt: Date.now() + 3_600_000 });
    expect((await adminCall(handler, { method: "GET", path: "/v1/admin/credentials" })).body.credentials).toContainEqual(expect.objectContaining({ ref: "linear", tokenCached: true }));
    const replaced = await adminCall(handler, { method: "POST", path: "/v1/admin/credentials", body: { ref: "linear", type: "oauth-client-credentials", secretName: "agentx/connectors/linear" } });
    expect(replaced.body).toMatchObject({ replaced: true, credential: { tokenCached: false } });
    expect(db.get("CREDENTIAL#linear", "TOKEN#abc")).toBeUndefined();
  });

  it("answers RUNTIME_UNAVAILABLE when the deployment has no credential configuration", async () => {
    const { handler } = await createAdminBroker({});
    expect((await adminCall(handler, { method: "GET", path: "/v1/admin/credentials" })).body).toMatchObject({ error: { code: "RUNTIME_UNAVAILABLE" } });
  });
});

describe("registry providers", () => {
  it("resolves the record on each issue and reports unregistered or unusable references as unavailable", async () => {
    const { handler, registry } = await createAdminBroker({ connectorCredentials: { secrets, githubApp } });
    const provider = registry!.provider("jira-sa");
    await expect(provider.issue(undefined, "read")).rejects.toThrow(new CredentialUnavailable("credential jira-sa is not registered; run agentx admin credential register"));
    await adminCall(handler, { method: "POST", path: "/v1/admin/credentials", body: { ref: "jira-sa", type: "static-secret", secretName: "agentx/connectors/jira-sa" } });
    expect(await provider.issue(undefined, "read")).toEqual({ token: "jira-key-value", bindings: {} });
    await adminCall(handler, { method: "POST", path: "/v1/admin/credentials", body: { ref: "linear", type: "oauth-client-credentials", secretName: "agentx/connectors/linear" } });
    await expect(registry!.provider("linear").issue(undefined, "read")).rejects.toThrow(CredentialUnavailable);
    await expect(registry!.provider("github-app").issue(undefined, "read")).rejects.toThrow("credential github-app is the built-in GitHub App and serves only the github connector");
  });
});

describe("Secrets Manager source and token cache", () => {
  it("maps a missing secret to undefined and an access denial to CredentialUnavailable", async () => {
    const { secretsManagerSource } = await import("../../packages/broker/src/aws/credentials.js");
    const failing = (name: string) => ({ send: vi.fn(async () => { throw Object.assign(new Error("denied"), { name }); }) });
    await expect(secretsManagerSource(failing("ResourceNotFoundException")).read("agentx/connectors/x")).resolves.toBeUndefined();
    await expect(secretsManagerSource(failing("AccessDeniedException")).read("agentx/connectors/x")).rejects.toBeInstanceOf(CredentialUnavailable);
    await expect(secretsManagerSource(failing("ThrottlingException")).read("agentx/connectors/x")).rejects.not.toBeInstanceOf(CredentialUnavailable);
  });

  it("logs and swallows a token cache write failure without the token", async () => {
    const { DynamoTokenCache } = await import("../../packages/broker/src/aws/credentials.js");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const cache = new DynamoTokenCache({ send: vi.fn(async () => { throw new Error("throttled"); }) } as never, "state", "linear");
      await expect(cache.put("abc", { token: "secret-token", expiresAt: 1 })).resolves.toBeUndefined();
      await expect(cache.get("abc")).resolves.toBeUndefined();
      const lines = log.mock.calls.map(([line]) => String(line));
      expect(lines.some((line) => line.includes("connector.token_cache_failed"))).toBe(true);
      expect(lines.join("\n")).not.toContain("secret-token");
    } finally { log.mockRestore(); }
  });
});
```

For the `registry` field used above, `createAdminBroker` also returns the `CredentialRegistry`
built from the same configuration. `createAwsBrokerHandler` accepts an injected
`credentialRegistry?: CredentialRegistry` for this purpose, and otherwise builds one from
`connectorCredentials`.

Add a test to `tests/contract/infrastructure.test.ts`: one IAM statement grants
`secretsmanager:GetSecretValue` on a resource whose joined string contains
`secret:agentx/connectors/*`, and no statement grants it on `*`.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npm run build && npx vitest run tests/contract/credential-registry.test.ts tests/contract/infrastructure.test.ts`
Expected: FAIL, because the module `credentials.js` is not found and the grant is missing.

- [ ] **Step 3: Implement**

`packages/broker/src/aws/credentials.ts`:
- **`secretsManagerSource`** sends `GetSecretValueCommand({ SecretId })` and returns `SecretString`,
  or `SecretBinary` decoded as UTF-8. It maps errors as follows:
  - `ResourceNotFoundException` returns `undefined`;
  - `AccessDeniedException` throws `new CredentialUnavailable(\`AgentX cannot read secret ${name}; connector secrets must be named agentx/connectors/<name> in this account and region\`)`;
  - anything else is rethrown.
- **`DynamoTokenCache`** keys items as `{ pk: \`CREDENTIAL#${ref}\`, sk: \`TOKEN#${key}\` }` and
  stores `{ entityType: "CREDENTIAL_TOKEN", token, expiresAt }`. `get` uses a consistent `GetCommand`,
  `put` uses `PutCommand`, and `delete` uses `DeleteCommand`. Each operation catches its error, logs
  `{"component":"broker","event":"connector.token_cache_failed","credential":ref,"operation":"get|put|delete"}`
  and resolves (`get` resolves to `undefined`).
- **`CredentialRegistry.register`**:
  1. Require `identity.isAdministrator`, or throw `FORBIDDEN "administrator claim is required"`.
  2. Parse the body with `CredentialRegistrationSchema`. A Zod error becomes
     `CONFIG_INVALID "invalid credential registration"`.
  3. Refuse `ref === githubApp.ref` with the message in the test.
  4. Validate the secret by building the provider for the type and calling `issue()` once:
     - `static-secret`: `staticSecretProvider(...)`;
     - `oauth-client-credentials`: read and parse the secret with `OAuthClientCredentialsSecretSchema`
       only. Do not mint, because the token endpoint belongs to the connector type.

     Map `CredentialUnavailable` to `CONFIG_INVALID` with its message.
  5. Read the existing item. Put
     `{ pk: "CREDENTIALS", sk: \`REF#${ref}\`, entityType: "CREDENTIAL", ...record, registeredBy: identity.ownerKey, registeredAt: now }`.
  6. If the item existed, query `pk = :pk AND begins_with(sk, :prefix)` with
     `{ ":pk": \`CREDENTIAL#${ref}\`, ":prefix": "TOKEN#" }` and delete each item.
  7. Return `{ credential: listEntry(record, false), replaced }`.
- **`list`**:
  1. Require the administrator claim.
  2. Query `pk = CREDENTIALS`, `begins_with(sk, "REF#")`.
  3. For each `oauth-client-credentials` record, run the token query. `tokenCached` means some item
     has `expiresAt > now`.
  4. Prepend the built-in entry.
- **`provider(ref, options)`** returns an object whose `issue` resolves the record each time:
  - a missing record throws the unregistered message;
  - `static-secret` delegates to a `staticSecretProvider`, memoized by `${ref}:${registeredAt}` so its
    secret cache survives between calls;
  - `oauth-client-credentials` needs `options.tokenEndpoint`, or throws
    `CredentialUnavailable("credential <ref> needs a token endpoint from its connector type")`. It
    delegates to a memoized `oauthClientCredentialsProvider` with `new DynamoTokenCache(..., ref)`;
  - `ref === githubApp.ref` throws the built-in message.

  `invalidate` delegates to the memoized provider, if one exists.

`broker.ts`:
- Add `connectorCredentials?` and `credentialRegistry?` to `AwsBrokerInput`. Build the registry in
  `createAwsBrokerHandler`.
- Add the routes immediately after `/v1/admin/projects`:

```ts
if (url.pathname === "/v1/admin/credentials" && (request.method === "POST" || request.method === "GET")) {
  if (!identity.isAdministrator) throw agentXError("FORBIDDEN", "administrator claim is required");
  if (!dependencies.credentialRegistry) throw agentXError("RUNTIME_UNAVAILABLE", "connector credentials are not configured in this deployment");
  return request.method === "POST"
    ? json(await dependencies.credentialRegistry.register(identity, body), request.requestId, 201)
    : json(await dependencies.credentialRegistry.list(identity), request.requestId);
}
```

- In the bootstrap, pass
  `connectorCredentials: { secrets: secretsManagerSource(secretsManager), githubApp: { ref: requiredEnvironment("GITHUB_APP_CREDENTIAL_REF"), secretName: githubPrivateKeySecretArn } }`.

`infra/lib/control-plane.ts`, beside the GitHub App grant:

```ts
broker.addToRolePolicy(new iam.PolicyStatement({
  actions: ["secretsmanager:GetSecretValue"],
  resources: [this.formatArn({ service: "secretsmanager", resource: "secret", resourceName: "agentx/connectors/*", arnFormat: ArnFormat.COLON_RESOURCE_NAME })],
}));
```

Import `ArnFormat` from `aws-cdk-lib` if it is not already imported.

- [ ] **Step 4: Run the tests and watch them pass**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Run the full suite, synthesize and commit**

Run: `npm run typecheck && npm run lint && npm run build && npm test && npm run infra:synth`.
Expected: all pass.

```bash
git add packages/broker/src/aws tests/support tests/contract/credential-registry.test.ts tests/contract/infrastructure.test.ts infra/lib/control-plane.ts
git commit -m "feat(broker): credential registry, admin routes and the connector secret grant"
```

---

### Task 5: `agentx admin credential register|list`

**Files:**
- Create: `packages/cli/src/admin/credential.ts`, `tests/contract/credential-cli.test.ts`
- Modify: `packages/cli/src/main.ts`, `tests/contract/cli-main.test.ts` (the one named assertion change)

**Interfaces:**
- Consumes: from Task 1, `CredentialRegistrationSchema`, `CredentialListEntrySchema` and
  `AgentXErrorCodeSchema`; from Task 4, the admin routes.
- Produces:
  - `registerCredential(input: { controlPlaneUrl: string; accessToken: string; ref: string; type: string; secretName: string }, fetchImplementation?)`;
  - `listCredentials(input: { controlPlaneUrl: string; accessToken: string }, fetchImplementation?)`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/contract/credential-cli.test.ts
import { describe, expect, it, vi } from "vitest";
import { listCredentials, registerCredential } from "../../packages/cli/src/admin/credential.js";

describe("credential administration client", () => {
  it("posts a validated registration with the bearer token and returns the server's entry", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () => Response.json({ credential: { ref: "linear" }, replaced: false }, { status: 201 }));
    const result = await registerCredential({ controlPlaneUrl: "https://agentx.example.test/", accessToken: "admin-token", ref: "linear", type: "oauth-client-credentials", secretName: "agentx/connectors/linear" }, fetchImplementation);
    expect(result).toEqual({ credential: { ref: "linear" }, replaced: false });
    const [url, init] = fetchImplementation.mock.calls[0]!;
    expect(url).toBe("https://agentx.example.test/v1/admin/credentials");
    expect(init).toMatchObject({ method: "POST" });
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer admin-token");
    expect(JSON.parse(String(init?.body))).toEqual({ ref: "linear", type: "oauth-client-credentials", secretName: "agentx/connectors/linear" });
  });

  it("refuses a bad secret name locally without calling the control plane", async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    await expect(registerCredential({ controlPlaneUrl: "https://agentx.example.test", accessToken: "t", ref: "linear", type: "static-secret", secretName: "prod/db" }, fetchImplementation)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("surfaces the server's error code and message", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () => Response.json({ error: { code: "CONFIG_INVALID", message: "credential linear: secret agentx/connectors/linear was not found" } }, { status: 400 }));
    await expect(registerCredential({ controlPlaneUrl: "https://agentx.example.test", accessToken: "t", ref: "linear", type: "static-secret", secretName: "agentx/connectors/linear" }, fetchImplementation))
      .rejects.toMatchObject({ code: "CONFIG_INVALID", message: "CONFIG_INVALID: credential linear: secret agentx/connectors/linear was not found" });
  });

  it("lists credentials", async () => {
    const credentials = [{ ref: "github-app", type: "github-app", secretName: "arn", builtIn: true, tokenCached: false }];
    const fetchImplementation = vi.fn<typeof fetch>(async () => Response.json({ credentials }));
    expect(await listCredentials({ controlPlaneUrl: "https://agentx.example.test", accessToken: "t" }, fetchImplementation)).toEqual({ credentials });
    expect(fetchImplementation.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
  });
});
```

In `tests/contract/cli-main.test.ts`, change the admin group assertion from
`["project", "workspace", "slack"]` to `["project", "workspace", "slack", "credential"]`. Then add
`expect(subcommands(admin, "credential")).toEqual(["register", "list"]);`. This is the one existing
assertion this phase changes. The new command group is a deliberate surface change.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npm run build && npx vitest run tests/contract/credential-cli.test.ts tests/contract/cli-main.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`packages/cli/src/admin/credential.ts`:
- **`registerCredential`** parses `{ ref, type, secretName }` with `CredentialRegistrationSchema`. A
  failure throws `agentXError("CONFIG_INVALID", "invalid credential registration: <first issue message>")`.
  It then sends a `POST` to `${controlPlaneUrl without trailing slash}/v1/admin/credentials` with
  `authorization` and `content-type: application/json`.
- **`listCredentials`** sends a `GET` to the same URL.
- **Errors.** When a response is not OK, throw `agentXError(code, message)`, where:
  - `code` is the server's `error.code` if `AgentXErrorCodeSchema` accepts it, otherwise
    `RUNTIME_UNAVAILABLE`;
  - `message` is the server's `error.message`, otherwise `HTTP <status>`.

In `main.ts`, add after the `slack` group:

```ts
const adminCredential = admin.command("credential").description("register connector credentials stored in Secrets Manager under agentx/connectors/");
adminCredential
  .command("register")
  .description("register or replace a credential reference; the secret must already exist")
  .requiredOption("--ref <reference>", "credential reference used by connectors' credentialRef")
  .requiredOption("--type <type>", "static-secret or oauth-client-credentials")
  .requiredOption("--secret <name>", "Secrets Manager secret name, agentx/connectors/<name>")
  .action(async (options: { ref: string; type: string; secret: string }, command: Command) => {
    const globals = globalOptions(command);
    const { settings, accessToken } = await authenticate(globals, services.tokenStore);
    services.stdout.write(formatSuccess(await registerCredential({ controlPlaneUrl: settings.controlPlaneUrl, accessToken, ref: options.ref, type: options.type, secretName: options.secret }, services.fetchImplementation), globals.json));
  });
adminCredential
  .command("list")
  .description("list credential references, types, secret names and whether a token is cached; never secret values")
  .action(async (_options: unknown, command: Command) => {
    const globals = globalOptions(command);
    const { settings, accessToken } = await authenticate(globals, services.tokenStore);
    services.stdout.write(formatSuccess(await listCredentials({ controlPlaneUrl: settings.controlPlaneUrl, accessToken }, services.fetchImplementation), globals.json));
  });
```

- [ ] **Step 4: Run the tests and watch them pass**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Run the full suite and commit**

Run the full suite as in Task 1. Then commit:

```bash
git add packages/cli/src tests/contract/credential-cli.test.ts tests/contract/cli-main.test.ts
git commit -m "feat(cli): agentx admin credential register and list"
```

---

### Task 6: Registration checks and preflight

**Files:**
- Create: `packages/broker/src/aws/registration-preflight.ts`, `tests/contract/registration-preflight.test.ts`
- Modify:
  - `packages/broker/src/aws/broker.ts` (`registerProject` only);
  - `packages/gateway/src/catalog.ts` (export the target-conflict reason);
  - `packages/cli/src/admin/register.ts`, `packages/cli/src/main.ts`;
  - `tests/contract/credential-cli.test.ts` (added tests).

**Interfaces:**
- Consumes:
  - from Task 1: `approvedToolCount`, `toolBudget`, `presentedNameProblems`,
    `RegistrationPreflight`, `ConnectorPreflight`;
  - from Task 2: `ConnectorNotConnected`;
  - `discoverGitHubTools` and `presentCatalog`.
- Produces:
  - `preflightConnectors(definition, githubMcp, ownerKey): Promise<{ report: RegistrationPreflight; refusals: string[] }>`;
  - `TARGET_CONFLICT_REASON` from `@agentx/gateway`;
  - the registration response
    `{ project, duplicate, warnings?: string[], preflight?: RegistrationPreflight }`;
  - the command-line `registerProject` sends `preflight: true`, and the command writes each warning
    to stderr.

- [ ] **Step 1: Write the failing tests**

`tests/contract/registration-preflight.test.ts`. It uses `createAdminBroker` from Task 4 with a
`githubMcp` fake. `register(definitionOverrides, { preflight })` posts to `/v1/admin/projects`.

```ts
describe("registration preflight", () => {
  it("does not contact the vendor unless the request asks for preflight", async () => {
    const connect = vi.fn(); const credentials = vi.fn();
    const { handler } = await createAdminBroker({ githubMcp: { credentials, connect } });
    const registered = await register(handler, githubConnector(["list_issues"]));
    expect(registered.status).toBe(201);
    expect(registered.body.preflight).toBeUndefined();
    expect(connect).not.toHaveBeenCalled();
    expect(credentials).not.toHaveBeenCalled();
  });

  it("reports offered, missing and skipped tools per connector and names them in warnings", async () => {
    // Vendor offers list_issues with a plain schema and issue_write with an unrepresentable oneOf; approvals are list_issues, issue_write, retired_tool.
    const { handler } = await createAdminBroker({ githubMcp: vendor([plainTool("list_issues"), oneOfTool("issue_write")]) });
    const registered = await register(handler, githubConnector(["list_issues", "issue_write", "retired_tool"]), { preflight: true });
    expect(registered.status).toBe(201);
    expect(registered.body.preflight).toEqual({ connectors: [{
      name: "github", status: "connected", offered: ["github__list_issues"],
      skipped: [{ tool: "retired_tool", reason: "not offered by the vendor" }, { tool: "issue_write", reason: "schema is not a plain object" }],
    }] });
    expect(registered.body.warnings).toEqual([
      "connector github: tool retired_tool skipped: not offered by the vendor",
      "connector github: tool issue_write skipped: schema is not a plain object",
    ]);
  });

  it("registers when the vendor rejects the credential and reports the connector not connected", async () => {
    const { McpUnauthorized } = await import("../../packages/gateway/src/mcp-client.js");
    const { handler, db } = await createAdminBroker({ githubMcp: { credentials: async () => ({ owner: "example", repo: "demo", token: "installation-secret" }), connect: vi.fn(async () => { throw new McpUnauthorized(); }) } });
    const registered = await register(handler, githubConnector(["list_issues"]), { preflight: true });
    expect(registered.status).toBe(201);
    expect(registered.body.preflight).toMatchObject({ connectors: [{ name: "github", status: "not_connected", offered: [], skipped: [] }] });
    expect((registered.body.warnings as string[])[0]).toMatch(/^connector github: GitHub is not connected: GitHub rejected the credential twice/);
    expect(JSON.stringify(registered.body)).not.toContain("installation-secret");
    expect(db.get("PROJECT#payments", "REV#000000000001")).toBeDefined();
  });

  it("reports an unreachable vendor as unavailable without failing registration", async () => {
    const { handler } = await createAdminBroker({ githubMcp: { credentials: async () => ({ owner: "example", repo: "demo", token: "t" }), connect: vi.fn(async () => { throw new Error("ECONNRESET"); }) } });
    const registered = await register(handler, githubConnector(["list_issues"]), { preflight: true });
    expect(registered.status).toBe(201);
    expect(registered.body.preflight).toMatchObject({ connectors: [{ name: "github", status: "unavailable" }] });
  });

  it("reports a deployment without GitHub MCP as not connected", async () => {
    const { handler } = await createAdminBroker({});
    const registered = await register(handler, githubConnector(["list_issues"]), { preflight: true });
    expect(registered.body.preflight).toEqual({ connectors: [{ name: "github", status: "not_connected", problem: "GitHub MCP is not configured in this deployment", offered: [], skipped: [] }] });
  });

  it("refuses a new revision whose multi-repository tool already has a target argument, naming it", async () => {
    const { handler, db } = await createAdminBroker({ githubMcp: vendor([toolWithTarget("list_issues")]) });
    const refused = await register(handler, githubConnector(["list_issues"]), { preflight: true, repositories: ["demo", "docs"] });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ error: { code: "CONFIG_INVALID", message: "connector github tool list_issues already has a target argument and the connector has several scopes; remove its approval" } });
    expect(db.get("PROJECT#payments", "REV#000000000001")).toBeUndefined();
  });

  it("refuses a new revision with a presented name over 64 characters, but re-accepts an identical registered revision", async () => {
    const { handler, db } = await createAdminBroker({});
    const long = "t".repeat(57);
    expect((await register(handler, githubConnector([long]))).body).toMatchObject({ error: { code: "CONFIG_INVALID" } });
    // Seed a revision registered before this check existed; re-submitting it stays idempotent.
    seedRegisteredRevision(db, githubConnector([long]));
    expect((await register(handler, githubConnector([long]))).body).toMatchObject({ duplicate: true });
  });

  it("warns when the model could see more than 20 tools", async () => {
    const { handler } = await createAdminBroker({});
    const names = Array.from({ length: 15 }, (_, index) => `tool_${index}`);
    expect((await register(handler, githubConnector(names))).body.warnings).toEqual(["the model could see 21 tools; above 20, tool choice gets less reliable. Approve fewer connector tools."]);
  });
});
```

The `issue_write` reason in the second test must be the exact string the engine produces for a
top-level `oneOf`. Read `packages/gateway/src/schema.ts` and `reviewTools` first. If
`flattenSchema` reports it as unsupported, use that reason instead of
`"schema is not a plain object"`.

Write the helpers in the same file:
- `githubConnector(names)` returns
  `{ integrations: { connectors: [{ name: "github", type: "github", scopes: "all-repositories", tools: names.map((name) => ({ name, access: "read" })) }] } }`.
- `vendor(tools)` returns `{ credentials, connect }` fakes serving those tools, with a
  `credentials` fake that returns `repo` from the repository URL.
- `plainTool`, `oneOfTool` and `toolWithTarget` build tool definitions whose schemas carry the
  required `owner` and `repo` properties.
- `seedRegisteredRevision(db, overrides)` writes the `PROJECT#payments/REV#000000000001` item and
  its membership, with the exact definition that `register` would send.
- `register(handler, overrides, { preflight?, repositories? })` builds the same definition as
  `registerRevision` in `slack-control-plane.test.ts`, applies the overrides, and posts to
  `/v1/admin/projects` with `runtimeBinding`, plus `preflight: true` when requested.

Add to `tests/contract/credential-cli.test.ts`:

```ts
describe("project registration from the command line", () => {
  it("asks for preflight and writes each warning to stderr", async () => {
    // Drive executeCli with a fake fetch answering the registration with { project, duplicate: false, warnings: ["w1"], preflight: { connectors: [] } }.
    // Expect the POST body to include preflight: true, stdout to hold the JSON result, and stderr to contain "Warning: w1\n".
  });

  it("says so when the control plane did not run preflight", async () => {
    // The fake fetch answers without a preflight field; stderr contains "Warning: this control plane did not check connectors at registration; deploy the latest AgentX release to get the preflight report.\n".
  });
});
```

Write these two tests with the deployment-file, token-store and project-file fixtures that
`tests/contract/cli-execution.test.ts` already uses for `admin project register`. Copy its setup
exactly. If no such fixture exists, create the smallest YAML project file and deployment file
under the test's temp directory.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npm run build && npx vitest run tests/contract/registration-preflight.test.ts tests/contract/credential-cli.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `packages/gateway/src/catalog.ts`, export
`const TARGET_CONFLICT_REASON = "tool already has a target argument"`, and use it in the existing
`skipped.push`. The string value is unchanged.

`packages/broker/src/aws/registration-preflight.ts`:

```ts
export async function preflightConnectors(
  definition: ProjectDefinition,
  githubMcp: GitHubMcpDependencies | undefined,
  ownerKey: string,
): Promise<{ report: RegistrationPreflight; refusals: string[] }> {
  const github = githubConnectorOf(definition);
  if (!github) return { report: { connectors: [] }, refusals: [] };
  if (!githubMcp) return { report: { connectors: [{ name: github.name, status: "not_connected", problem: "GitHub MCP is not configured in this deployment", offered: [], skipped: [] }] }, refusals: [] };
  const settled = await Promise.allSettled(github.repositories.map((repository) => discoverGitHubTools(
    { workspaceId: "registration", ownerKey, repository, policy: github.policy, settingsRevision: definition.revision }, githubMcp,
  )));
  const notConnected = settled.find((entry): entry is PromiseRejectedResult => entry.status === "rejected" && entry.reason instanceof ConnectorNotConnected);
  const failed = settled.find((entry): entry is PromiseRejectedResult => entry.status === "rejected");
  if (notConnected || failed) {
    const reason = (notConnected ?? failed)!.reason as Error;
    const code = reason instanceof AgentXError ? reason.code : undefined;
    return { report: { connectors: [{
      name: github.name, status: notConnected ? "not_connected" : "unavailable",
      problem: (code ? stripCode(reason.message, code) : reason.message).slice(0, 512), offered: [], skipped: [],
    }] }, refusals: [] };
  }
  const discoveries = settled.map((entry) => (entry as PromiseFulfilledResult<GitHubMcpDiscovery>).value);
  const presented = presentCatalog({
    connector: github.name, label: "GitHub", scopeNoun: "repository", approvals: github.policy.tools,
    scopes: discoveries.map((discovery, index) => ({ alias: github.repositories[index]!.name, tools: discovery.tools.map(({ repository: scope, ...tool }) => ({ ...tool, scope })) })),
  });
  const skipped = uniqueSkipped([...discoveries.flatMap((discovery) => discovery.skipped), ...presented.skipped]);
  const refusals = github.repositories.length > 1
    ? presented.skipped.filter((entry) => entry.reason === TARGET_CONFLICT_REASON)
      .map((entry) => `connector ${github.name} tool ${entry.tool} already has a target argument and the connector has several scopes; remove its approval`)
    : [];
  return { report: { connectors: [{ name: github.name, status: "connected", offered: presented.tools.map((tool) => tool.name), skipped }] }, refusals };
}
```

`uniqueSkipped` keeps the first entry for each `tool` + `reason` pair, in order, capped at 64.
`stripCode` should move to a small exported helper if `broker.ts` keeps it private. Otherwise
inline the same prefix strip.

`registerProject` in `broker.ts`. The order is:
1. **Parse.**
2. **Existing revision.** When the revision exists:
   - keep the existing immutability check;
   - compute `warnings` as the budget warning plus any preflight warnings, when requested;
   - return `{ project, duplicate: true, ...(warnings.length ? { warnings } : {}), ...(preflight ? { preflight } : {}) }`.
3. **Static refusals, for new revisions only.**
   - Any `presentedNameProblems(definition)` item throws `CONFIG_INVALID`, with the items joined
     by `"; "`.
   - A `toolBudget(approvedToolCount(definition)).refusal` throws `CONFIG_INVALID`.
4. **Preflight,** if `input.preflight === true`. Any refusal throws `CONFIG_INVALID`, joined by
   `"; "`.
5. **The existing transaction.**
6. **The response.** Return `{ project, duplicate: false, ...(warnings.length ? { warnings } : {}), ...(preflight ? { preflight } : {}) }`.

Warnings come from the preflight report, in this order:
1. The budget warning.
2. For each connector:
   - if its status is not `connected`: `connector <name>: <problem>`. The problem text already says
     "is not connected" or names the discovery failure, so the warning does not repeat it;
   - for each skipped entry: `connector <name>: tool <tool> skipped: <reason>`.

Command-line tool:
- **`register.ts`** adds `preflight: true` to the posted body.
- **`main.ts`**, after writing the result to stdout:
  - write `Warning: <w>\n` to stderr for each string in `result.warnings`;
  - if the definition has `integrations` and the result has no `preflight`, also write the
    "did not check connectors" line from the test.

  Keep the JSON result on stdout unchanged.

- [ ] **Step 4: Run the tests and watch them pass**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Run the full suite and commit**

Run the full suite as in Task 1. Existing registration tests must pass unchanged, because they
never send `preflight`.

```bash
git add packages/broker/src packages/gateway/src/catalog.ts packages/cli/src tests/contract/registration-preflight.test.ts tests/contract/credential-cli.test.ts
git commit -m "feat(broker): registration budget, name checks and opt-in connector preflight"
```

---

### Task 7: Documentation, spec records and verification

**Files:**
- Modify:
  - `README.md`;
  - `specs/013-connector-gateway/data-model.md`, `contracts/control-api.md`,
    `contracts/project-config.md`;
  - `specs/013-connector-gateway/tasks.md` (check T020–T024), `plan.md` (phase 3 row links this
    plan).

- [ ] **Step 1: Update documents**
- **README.**
  - Add a "Connector credentials" subsection after the connectors section. It covers:
    creating the secret under `agentx/connectors/`; the two payload shapes;
    `agentx admin credential register|list`; and the fact that no connector type uses them until
    Linear.
  - Describe registration preflight: what it reports, that it never blocks on vendor
    authentication, and the 20-tool warning and 40-tool limit.
  - Add `connector.not_connected` and `connector.token_cache_failed` to the diagnostics events.
- **data-model.md.**
  - Record the key layout: records at `CREDENTIALS / REF#<ref>`; tokens at
    `CREDENTIAL#<ref> / TOKEN#<scopeKey>`, overwritten on re-mint and deleted on re-registration,
    with no TTL.
  - Record the list entry fields.
- **control-api.md.**
  - Document the registration body `preflight: true`, the response `warnings` and `preflight`,
    and the three statuses.
  - Document the credential route request and response bodies.
- **project-config.md.** Update the `list` sentence to match the list fields.

- [ ] **Step 2: Verify**

Run: `npm run typecheck && npm run lint && npm run build && npm test && npm run infra:synth`.
Expected: all pass. Record the test count.

Also confirm that the only change to an existing test assertion is the `cli-main` command list:

```bash
git diff <phase-3 base>..HEAD -- tests | grep '^-' | grep -v '^---'
```

- [ ] **Step 3: Commit**

```bash
git add README.md specs/013-connector-gateway
git commit -m "docs: connector credentials, registration preflight and phase 3 spec records"
```
