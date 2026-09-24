# Phase 1a: Gateway Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the feature 007 GitHub MCP engine into a new `@agentx/gateway` package behind
provider-neutral interfaces, with GitHub as the first connector and no change in behavior.

**Architecture:** `@agentx/gateway` owns the MCP client, the generic engine (`discoverTools`,
`approveTools`, `executeTool`) and the interfaces `ConnectorDefinition`, `CredentialProvider`,
`Binder`, `Guard` and `Ledger`. `packages/gateway/src/github.ts` supplies GitHub's endpoint, the
`owner`/`repo` binder and the issue-not-pull-request guard. The broker keeps its feature 007 exports
(`discoverGitHubTools`, `executeGitHubTool`, `approvedTools` and their types) as a thin layer that
delegates to the gateway, so `packages/broker/src/aws/broker.ts` and every existing test are
untouched.

**Tech Stack:** TypeScript 5.9 (strict, `exactOptionalPropertyTypes`, NodeNext), Node 22.19–22.x,
npm workspaces, Vitest 5, MCP SDK 1.30.1, Zod 4 (through `@agentx/contracts`).

**Spec:** [../spec.md](../spec.md) (FR-001–FR-006 in part, SC-001), plan: [../plan.md](../plan.md).

## Global Constraints

- Node `>=22.19.0 <23`; run every command with `node --version` printing `v22.x`.
- Pinned versions only: `@modelcontextprotocol/sdk` `1.30.1`, `@agentx/contracts` `0.1.0`.
- Workspace packages resolve through their built `dist`: run `npm run build` before `npm test`.
- No change to any existing test's assertions (SC-001). No change to `broker.ts`.
- Status codes and result statuses are unchanged. Two error messages generalize their wording:
  discovery says "check GitHub App issue permissions" instead of "check installation permissions",
  and the routing refusal says "GitHub routing arguments are server controlled".
- Commit messages follow `type(scope): summary` and end with
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

1. **Redelivery across the release.** A write stored by the old broker is replayed after the new
   one deploys. It must replay, not fail `IDEMPOTENCY_CONFLICT`; the fingerprint must still hash
   `{ requestId, repository, tool, schemaHash, arguments }`. Pinned in Task 3.
2. **A turn that discovered tools on the old broker calls the new one.** The schema hash must be
   identical, or the call fails "definition changed". Pinned in Task 4.
3. **Release image build.** The worker and Slack Dockerfiles run `npm ci` after copying each
   workspace `package.json`; a workspace missing there breaks the release. Pinned in Task 1.
4. **Credential issuance fails** (App not installed on a repository). The result must be `FAILED`
   before any write, never `UNKNOWN`, and the connector must not be contacted. Pinned in Task 3.
5. **Lambda bundling.** esbuild must resolve `@agentx/gateway` when synthesizing the broker.
   Checked by `npm run infra:synth` in Task 5.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/gateway/package.json`, `tsconfig.json` | New workspace package |
| `packages/gateway/src/index.ts` | Public exports |
| `packages/gateway/src/mcp-client.ts` | MCP Streamable HTTP client (moved verbatim) |
| `packages/gateway/src/util.ts` | `isObject`, `canonical`, `fingerprint`, `resultText`, `withDeadline` |
| `packages/gateway/src/types.ts` | Interfaces and result types |
| `packages/gateway/src/engine.ts` | `approveTools`, `discoverTools`, `executeTool` |
| `packages/gateway/src/github.ts` | GitHub endpoint, binder, guard, `githubConnector` |
| `packages/broker/src/mcp-client.ts` | Re-export from the gateway |
| `packages/broker/src/github-mcp.ts` | Feature 007 names delegating to the gateway |
| `tsconfig.json`, `packages/broker/tsconfig.json`, `packages/broker/package.json`, `package-lock.json` | Wiring |
| `environments/base/Dockerfile`, `environments/slack/Dockerfile`, `scripts/release-production.ts` | Image inputs |
| `tests/contract/workspace-packages.test.ts` | Every workspace is copied into both images |
| `tests/contract/gateway-engine.test.ts` | Engine behavior with a non-GitHub fixture connector |
| `tests/contract/gateway-github.test.ts` | GitHub schema-hash stability |

---

### Task 1: Create the gateway package and move the MCP client

**Files:**
- Create: `packages/gateway/package.json`, `packages/gateway/tsconfig.json`, `packages/gateway/src/index.ts`
- Move: `packages/broker/src/mcp-client.ts` → `packages/gateway/src/mcp-client.ts`
- Create: `packages/broker/src/mcp-client.ts` (re-export)
- Modify: `tsconfig.json`, `packages/broker/tsconfig.json`, `packages/broker/package.json`, `package-lock.json`
- Modify: `environments/base/Dockerfile:8-13`, `environments/slack/Dockerfile:8-13`, `scripts/release-production.ts:39-70`
- Test: `tests/contract/workspace-packages.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `@agentx/gateway` exporting `connectMcp`, `McpConnection`, `McpToolResult` with the
  exact signatures of the current `packages/broker/src/mcp-client.ts`.

- [ ] **Step 1: Write the failing test**

Create `tests/contract/workspace-packages.test.ts`:

```ts
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SLACK_ORCHESTRATOR_IMAGE_INPUTS, WORKER_IMAGE_INPUTS } from "../../scripts/release-production.js";

const workspaces = readdirSync("packages", { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

describe("workspace packages in release images", () => {
  it.each([
    ["environments/base/Dockerfile", WORKER_IMAGE_INPUTS],
    ["environments/slack/Dockerfile", SLACK_ORCHESTRATOR_IMAGE_INPUTS],
  ] as const)("%s copies every workspace manifest before npm ci", (dockerfile, inputs) => {
    const text = readFileSync(dockerfile, "utf8");
    for (const name of workspaces) {
      expect(text).toContain(`COPY packages/${name}/package.json packages/${name}/package.json`);
      expect(inputs.some((input) => input === `packages/${name}/package.json` || input === `packages/${name}`)).toBe(true);
    }
  });

  it("includes the gateway", () => {
    expect(workspaces).toContain("gateway");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/contract/workspace-packages.test.ts`
Expected: FAIL on `includes the gateway` (`expected [...] to contain 'gateway'`).

- [ ] **Step 3: Create the package**

`packages/gateway/package.json`:

```json
{
  "name": "@agentx/gateway",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "dependencies": {
    "@agentx/contracts": "0.1.0",
    "@modelcontextprotocol/sdk": "1.30.1"
  }
}
```

`packages/gateway/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src/**/*.ts"],
  "references": [{ "path": "../contracts" }]
}
```

Move the client verbatim and leave a re-export behind:

```bash
git mv packages/broker/src/mcp-client.ts packages/gateway/src/mcp-client.ts
```

`packages/broker/src/mcp-client.ts`:

```ts
export { connectMcp, type McpConnection, type McpToolResult } from "@agentx/gateway";
```

`packages/gateway/src/index.ts`:

```ts
export * from "./mcp-client.js";
```

- [ ] **Step 4: Wire the build**

In `tsconfig.json`, add the gateway after contracts:

```json
    { "path": "packages/contracts" },
    { "path": "packages/gateway" },
    { "path": "packages/broker" },
```

`packages/broker/tsconfig.json` references become:

```json
  "references": [{ "path": "../contracts" }, { "path": "../gateway" }]
```

In `packages/broker/package.json` add `"@agentx/gateway": "0.1.0",` after `"@agentx/contracts": "0.1.0",`.

Run: `npm install`
Expected: `package-lock.json` gains `packages/gateway` and `node_modules/@agentx/gateway` entries;
no other version changes (`git diff package-lock.json` shows only gateway entries).

- [ ] **Step 5: Add the gateway to both images' inputs**

In `environments/base/Dockerfile` and `environments/slack/Dockerfile`, after the contracts line:

```dockerfile
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/gateway/package.json packages/gateway/package.json
```

In `scripts/release-production.ts`, add `"packages/gateway/package.json",` after
`"packages/broker/package.json",` in both `WORKER_IMAGE_INPUTS` and
`SLACK_ORCHESTRATOR_IMAGE_INPUTS`.

- [ ] **Step 6: Build and run the tests**

Run: `npm run build && npx vitest run tests/contract/workspace-packages.test.ts tests/integration/github-mcp.test.ts tests/contract/release-command.test.ts`
Expected: PASS. `github-mcp.test.ts` now exercises `connectMcp` through the broker re-export.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway packages/broker tsconfig.json package-lock.json environments scripts/release-production.ts tests/contract/workspace-packages.test.ts
git commit -m "feat(gateway): add the gateway package and move the MCP client into it"
```

---

### Task 2: Gateway types and generic tool approval

**Files:**
- Create: `packages/gateway/src/util.ts`, `packages/gateway/src/types.ts`, `packages/gateway/src/engine.ts`
- Modify: `packages/gateway/src/index.ts`
- Test: `tests/contract/gateway-engine.test.ts`

**Interfaces:**
- Consumes: `McpConnection`, `McpToolResult` from Task 1.
- Produces:
  - `type Access = "read" | "write"`
  - `interface ToolApproval { name: string; access: Access; allowedArguments?: string[] | undefined; argumentValues?: Record<string, Array<string | number | boolean>> | undefined }`
  - `interface ConnectorPolicy { tools: ToolApproval[] }`
  - `interface IssuedCredential { token: string; bindings: Readonly<Record<string, unknown>> }`
  - `type Actor = SlackRequester`
  - `interface CredentialProvider<Scope> { issue(scope: Scope, access: Access, actor?: Actor): Promise<IssuedCredential> }`
  - `interface Binder<Scope> { readonly properties: readonly string[]; bind(scope: Scope, credential: IssuedCredential): Record<string, unknown> }`
  - `interface GuardInput { tool: string; arguments: Readonly<Record<string, unknown>>; bound: Readonly<Record<string, unknown>>; connection: Pick<McpConnection, "call"> }`
  - `interface Guard { requiredTools(tool: string, args: Readonly<Record<string, unknown>>): readonly string[]; check(input: GuardInput): Promise<void> }`
  - `class GuardRejection extends Error`
  - `interface ConnectorDefinition<Scope> { label: string; endpoint: URL; permissionsHint: string; credentials: CredentialProvider<Scope>; binder: Binder<Scope>; guards: readonly Guard[] }`
  - `interface ConnectorContext<Scope> { requestedBy?: SlackRequester; workspaceId: string; ownerKey: string; scopeAlias: string; scope: Scope; policy: ConnectorPolicy; settingsRevision?: number }`
  - `interface CatalogTool { name: string; scope: string; description: string; inputSchema: Record<string, unknown>; schemaHash: string; access: Access }`
  - `interface ToolRequest { requestId: string; scope: string; tool: string; schemaHash: string; arguments: Record<string, unknown> }`
  - `interface ToolResult { requestId: string; status: "SUCCEEDED" | "FAILED" | "UNKNOWN" | "IN_PROGRESS"; text: string; truncated: boolean; replayed: boolean }`
  - `interface Invocation { requestedBy?: SlackRequester; requestId: string; workspaceId: string; ownerKey: string; repository: string; tool: string; fingerprint: string; createdAt: string; updatedAt: string; result: ToolResult; settingsRevision?: number }`
  - `interface Ledger { claim(record: Invocation): Promise<boolean>; get(requestId: string): Promise<Invocation | undefined>; finish(record: Invocation): Promise<void> }`
  - `function approveTools<Scope>(connection: Pick<McpConnection, "tools">, connector: Pick<ConnectorDefinition<Scope>, "binder">, context: ConnectorContext<Scope>): CatalogTool[]`
  - `util.ts`: `isObject`, `canonical`, `fingerprint(value: unknown): string`, `resultText(result: McpToolResult): string`, `withDeadline<T>(promise: Promise<T>, signal: AbortSignal): Promise<T>`

- [ ] **Step 1: Write the failing test**

Create `tests/contract/gateway-engine.test.ts`:

```ts
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  approveTools,
  type ConnectorContext,
  type ConnectorDefinition,
  type Guard,
  type Invocation,
  type Ledger,
  type McpConnection,
  type McpToolResult,
  type ToolRequest,
} from "../../packages/gateway/src/index.js";

interface TrackerScope { alias: string; siteId: string }

const scope: TrackerScope = { alias: "payments", siteId: "site-42" };
const text = (value: unknown): McpToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties: { siteId: { type: "string" }, ...properties },
  required: ["siteId", ...required],
});

function fixture(guards: Guard[] = []) {
  const tools: McpConnection["tools"] = [
    { name: "list_items", description: "List items", inputSchema: schema({ state: { type: "string", enum: ["open", "closed", "archived"] } }) },
    { name: "create_item", description: "Create an item", inputSchema: schema({ title: { type: "string" }, priority: { type: "string" } }, ["title"]) },
    { name: "unscoped", description: "No site property", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
    { name: "composed", description: "Uses allOf", inputSchema: { ...schema({}), allOf: [] } },
    { name: "unapproved", description: "Not in policy", inputSchema: schema({}) },
  ];
  const issue = vi.fn<ConnectorDefinition<TrackerScope>["credentials"]["issue"]>(async () => ({ token: "tracker-secret-token", bindings: {} }));
  const connector: ConnectorDefinition<TrackerScope> = {
    label: "Tracker",
    endpoint: new URL("https://mcp.tracker.test/mcp"),
    permissionsHint: "Tracker key permissions",
    credentials: { issue },
    binder: { properties: ["siteId"], bind: (value) => ({ siteId: value.siteId }) },
    guards,
  };
  const context: ConnectorContext<TrackerScope> = {
    workspaceId: "workspace", ownerKey: "alice", scopeAlias: scope.alias, scope,
    policy: { tools: [
      { name: "list_items", access: "read", argumentValues: { state: ["open", "closed"] } },
      { name: "create_item", access: "write", allowedArguments: ["title"] },
      { name: "unscoped", access: "read" },
      { name: "composed", access: "read" },
    ] },
  };
  const records = new Map<string, Invocation>();
  const ledger: Ledger = {
    claim: async (record) => { if (records.has(record.requestId)) return false; records.set(record.requestId, structuredClone(record)); return true; },
    get: async (id) => records.get(id),
    finish: async (record) => { records.set(record.requestId, structuredClone(record)); },
  };
  const call = vi.fn<(name: string, args: Record<string, unknown>) => Promise<McpToolResult>>(async () => text({ ok: true }));
  const close = vi.fn(async () => undefined);
  const connect = vi.fn(async (_options: { tools: readonly string[]; token: string }) => ({ tools, call, close }));
  const request = (tool: string, args: Record<string, unknown> = {}): ToolRequest => ({
    requestId: randomUUID(), scope: "payments", tool, arguments: args,
    schemaHash: approveTools({ tools }, connector, context).find((entry) => entry.name === tool)!.schemaHash,
  });
  return { tools, issue, connector, context, records, ledger, call, close, connect, request };
}

describe("gateway tool approval", () => {
  it("removes bound properties and skips tools it cannot bind or represent", () => {
    const f = fixture();
    const catalog = approveTools({ tools: f.tools }, f.connector, f.context);
    expect(catalog.map((tool) => tool.name)).toEqual(["list_items", "create_item"]);
    expect(catalog.every((tool) => tool.scope === "payments")).toBe(true);
    const list = catalog[0]!.inputSchema;
    expect((list.properties as Record<string, unknown>).siteId).toBeUndefined();
    expect(list.required).toEqual(["state"]);
    expect((list.properties as Record<string, { enum: string[] }>).state.enum).toEqual(["open", "closed"]);
    expect((catalog[1]!.inputSchema.properties as Record<string, unknown>).priority).toBeUndefined();
    expect(catalog[1]!.access).toBe("write");
  });
});

export { createHash, fixture, text };
```

(The trailing export keeps `createHash`, `fixture` and `text` referenced until Task 3 adds tests
that use them; Task 3 removes it.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/contract/gateway-engine.test.ts`
Expected: FAIL with `approveTools` not exported from `packages/gateway/src/index.js`.

- [ ] **Step 3: Write `util.ts`**

`packages/gateway/src/util.ts`:

```ts
import { createHash } from "node:crypto";
import type { McpToolResult } from "./mcp-client.js";

export function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export function resultText(result: McpToolResult): string {
  if (result.structuredContent !== undefined) return JSON.stringify(result.structuredContent);
  return (result.content ?? []).filter((entry) => entry.type === "text").map((entry) => entry.text ?? "").join("\n");
}

export async function withDeadline<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort: () => void = () => undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error("Connector request deadline exceeded"));
      signal.addEventListener("abort", onAbort, { once: true });
    })]);
  } finally { signal.removeEventListener("abort", onAbort); }
}
```

- [ ] **Step 4: Write `types.ts`**

`packages/gateway/src/types.ts`:

```ts
import type { SlackRequester } from "@agentx/contracts";
import type { McpConnection } from "./mcp-client.js";

export type Access = "read" | "write";

export interface ToolApproval {
  name: string;
  access: Access;
  allowedArguments?: string[] | undefined;
  argumentValues?: Record<string, Array<string | number | boolean>> | undefined;
}

export interface ConnectorPolicy { tools: ToolApproval[] }

export interface IssuedCredential {
  token: string;
  /** Routing values the issuer is authoritative for, such as the GitHub App's account and repository. */
  bindings: Readonly<Record<string, unknown>>;
}

/** The Slack member a call is made for. Service-identity providers ignore it. */
export type Actor = SlackRequester;

export interface CredentialProvider<Scope> {
  issue(scope: Scope, access: Access, actor?: Actor): Promise<IssuedCredential>;
}

export interface Binder<Scope> {
  /** Required string properties removed from the model's schema and supplied by the server. */
  readonly properties: readonly string[];
  bind(scope: Scope, credential: IssuedCredential): Record<string, unknown>;
}

export interface GuardInput {
  tool: string;
  arguments: Readonly<Record<string, unknown>>;
  bound: Readonly<Record<string, unknown>>;
  connection: Pick<McpConnection, "call">;
}

export interface Guard {
  /** Upstream tools the check needs on the call's connection besides the called tool. */
  requiredTools(tool: string, args: Readonly<Record<string, unknown>>): readonly string[];
  /** Throws GuardRejection to refuse the call before it executes. */
  check(input: GuardInput): Promise<void>;
}

/** A guard's refusal. Its message is returned to the model as a FAILED result. */
export class GuardRejection extends Error {}

export interface ConnectorDefinition<Scope> {
  /** Vendor name used in messages, such as "GitHub". */
  label: string;
  endpoint: URL;
  /** What an administrator should check when the vendor refuses, such as "GitHub App issue permissions". */
  permissionsHint: string;
  credentials: CredentialProvider<Scope>;
  binder: Binder<Scope>;
  guards: readonly Guard[];
}

export interface ConnectorContext<Scope> {
  requestedBy?: SlackRequester;
  workspaceId: string;
  ownerKey: string;
  scopeAlias: string;
  scope: Scope;
  policy: ConnectorPolicy;
  /** The project revision whose policy authorized this call. */
  settingsRevision?: number;
}

export interface CatalogTool {
  name: string;
  scope: string;
  description: string;
  inputSchema: Record<string, unknown>;
  schemaHash: string;
  access: Access;
}

export interface ToolRequest {
  requestId: string;
  scope: string;
  tool: string;
  schemaHash: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  requestId: string;
  status: "SUCCEEDED" | "FAILED" | "UNKNOWN" | "IN_PROGRESS";
  text: string;
  truncated: boolean;
  replayed: boolean;
}

export interface Invocation {
  requestedBy?: SlackRequester;
  requestId: string;
  workspaceId: string;
  ownerKey: string;
  /** The scope alias. Stored as `repository` because feature 007 records use that name. */
  repository: string;
  tool: string;
  fingerprint: string;
  createdAt: string;
  updatedAt: string;
  result: ToolResult;
  settingsRevision?: number;
}

export interface Ledger {
  claim(record: Invocation): Promise<boolean>;
  get(requestId: string): Promise<Invocation | undefined>;
  finish(record: Invocation): Promise<void>;
}
```

- [ ] **Step 5: Write `approveTools` in `engine.ts`**

`packages/gateway/src/engine.ts`:

```ts
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { McpConnection } from "./mcp-client.js";
import type { CatalogTool, ConnectorContext, ConnectorDefinition } from "./types.js";
import { fingerprint, isObject } from "./util.js";

/** Derive schemas from discovery, narrow by admin policy, and bind routing outside model arguments. */
export function approveTools<Scope>(
  connection: Pick<McpConnection, "tools">,
  connector: Pick<ConnectorDefinition<Scope>, "binder">,
  context: ConnectorContext<Scope>,
): CatalogTool[] {
  const tools: CatalogTool[] = [];
  for (const upstream of connection.tools) {
    const policy = context.policy.tools.find((entry) => entry.name === upstream.name);
    if (!policy) continue;
    if (JSON.stringify(upstream.inputSchema).length > 32_768) throw new Error("MCP schema exceeded limit");
    const schema = structuredClone(upstream.inputSchema);
    // Plain object schemas only. Fail closed on shapes the narrowing cannot reason about.
    if (schema.type !== "object" || !isObject(schema.properties) || schema.$ref || schema.allOf || schema.anyOf || schema.oneOf || schema.patternProperties) continue;
    const properties = schema.properties;
    const required = Array.isArray(schema.required) ? schema.required as string[] : [];
    const bindable = (name: string) => {
      const property = properties[name];
      return isObject(property) && property.type === "string" && required.includes(name);
    };
    if (!connector.binder.properties.every(bindable)) continue;
    for (const name of connector.binder.properties) delete properties[name];
    schema.required = required.filter((name) => !connector.binder.properties.includes(name));
    if (policy.allowedArguments) {
      if ((schema.required as string[]).some((name) => !policy.allowedArguments!.includes(name))) continue;
      for (const name of Object.keys(properties)) if (!policy.allowedArguments.includes(name)) delete properties[name];
    }
    let incompatible = false;
    for (const [name, values] of Object.entries(policy.argumentValues ?? {})) {
      const property = properties[name];
      if (!isObject(property)) { incompatible = true; break; }
      const upstreamEnum = Array.isArray(property.enum) ? property.enum : undefined;
      const permitted = upstreamEnum ? values.filter((value) => upstreamEnum.includes(value)) : values;
      if (!permitted.length) { incompatible = true; break; }
      properties[name] = { ...property, enum: permitted };
      if (!(schema.required as string[]).includes(name)) (schema.required as string[]).push(name);
    }
    if (incompatible) continue;
    schema.additionalProperties = false;
    // Compile during discovery too; schemas we cannot validate must never be advertised.
    new AjvJsonSchemaValidator().getValidator(schema);
    tools.push({
      name: upstream.name,
      scope: context.scopeAlias,
      description: (upstream.description ?? upstream.name).slice(0, 16_384),
      inputSchema: schema,
      // Hashed under the feature 007 key `repository` so hashes survive the release.
      schemaHash: fingerprint({ upstream, policy, repository: context.scope }),
      access: policy.access,
    });
  }
  return tools;
}
```

`packages/gateway/src/index.ts`:

```ts
export * from "./engine.js";
export * from "./mcp-client.js";
export * from "./types.js";
export * from "./util.js";
```

- [ ] **Step 6: Build and run the test**

Run: `npm run build && npx vitest run tests/contract/gateway-engine.test.ts`
Expected: PASS (1 test).

- [ ] **Step 7: Commit**

```bash
git add packages/gateway tests/contract/gateway-engine.test.ts
git commit -m "feat(gateway): add connector interfaces and provider-neutral tool approval"
```

---

### Task 3: Generic discovery and execution

**Files:**
- Modify: `packages/gateway/src/engine.ts`
- Test: `tests/contract/gateway-engine.test.ts`

**Interfaces:**
- Consumes: Task 2 types, `approveTools`, `util.ts`; `connectMcp` from Task 1; `agentXError` from `@agentx/contracts`.
- Produces:
  - `interface EngineOptions { connect?: typeof connectMcp }`
  - `function discoverTools<Scope>(connector: ConnectorDefinition<Scope>, context: ConnectorContext<Scope>, options?: EngineOptions): Promise<{ tools: CatalogTool[] }>`
  - `function executeTool<Scope>(request: ToolRequest, connector: ConnectorDefinition<Scope>, context: ConnectorContext<Scope>, options: EngineOptions & { ledger: Ledger }): Promise<ToolResult>`
  - `function requestFingerprint(request: ToolRequest): string`

- [ ] **Step 1: Write the failing tests**

In `tests/contract/gateway-engine.test.ts`, replace the gateway import with:

```ts
import {
  approveTools,
  discoverTools,
  executeTool,
  GuardRejection,
  type ConnectorContext,
  type ConnectorDefinition,
  type Guard,
  type Invocation,
  type Ledger,
  type McpConnection,
  type McpToolResult,
  type ToolRequest,
} from "../../packages/gateway/src/index.js";
```

Delete the trailing `export { createHash, fixture, text };` line, and append:

```ts
const legacyFingerprint = (value: unknown): string => {
  const sort = (item: unknown): unknown => Array.isArray(item) ? item.map(sort)
    : item && typeof item === "object" ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, sort(entry)]))
    : item;
  return createHash("sha256").update(JSON.stringify(sort(value))).digest("hex");
};

describe("gateway execution", () => {
  it("injects bound values from the scope and passes the requester to the credential provider", async () => {
    const f = fixture();
    const context = { ...f.context, requestedBy: { teamId: "T1", userId: "U1" } };
    const request = f.request("list_items", { state: "open" });
    expect(await executeTool(request, f.connector, context, { connect: f.connect, ledger: f.ledger })).toMatchObject({ status: "SUCCEEDED" });
    expect(f.call).toHaveBeenCalledWith("list_items", { state: "open", siteId: "site-42" });
    expect(f.issue).toHaveBeenCalledWith(scope, "read", { teamId: "T1", userId: "U1" });
    expect(f.connect).toHaveBeenCalledWith(expect.objectContaining({ tools: ["list_items"], token: "tracker-secret-token" }));
  });

  it("refuses a model-supplied bound property before contacting the vendor", async () => {
    const f = fixture();
    await expect(executeTool(f.request("list_items", { state: "open", siteId: "other" }), f.connector, f.context, { connect: f.connect, ledger: f.ledger }))
      .rejects.toThrow(/Tracker routing arguments are server controlled/);
    expect(f.connect).not.toHaveBeenCalled();
  });

  it("runs guards on the call's connection before executing and returns their refusal", async () => {
    const check = vi.fn<Guard["check"]>(async ({ arguments: args, bound }) => {
      expect(bound).toEqual({ siteId: "site-42" });
      if (args.title === "blocked") throw new GuardRejection("Blocked by guard.");
    });
    const f = fixture([{ requiredTools: (tool) => tool === "create_item" ? ["list_items"] : [], check }]);
    const result = await executeTool(f.request("create_item", { title: "blocked" }), f.connector, f.context, { connect: f.connect, ledger: f.ledger });
    expect(result).toMatchObject({ status: "FAILED", text: "Blocked by guard." });
    expect(f.connect).toHaveBeenCalledWith(expect.objectContaining({ tools: ["create_item", "list_items"] }));
    expect(f.call).not.toHaveBeenCalled();
  });

  it("keeps feature 007 fingerprints so stored records replay across the release", async () => {
    const f = fixture();
    const request = f.request("create_item", { title: "Flaky login" });
    const stored = legacyFingerprint({ requestId: request.requestId, repository: "payments", tool: "create_item", schemaHash: request.schemaHash, arguments: request.arguments });
    f.records.set(request.requestId, {
      requestId: request.requestId, workspaceId: "workspace", ownerKey: "alice", repository: "payments", tool: "create_item",
      fingerprint: stored, createdAt: "2026-09-23T00:00:00.000Z", updatedAt: "2026-09-23T00:00:01.000Z",
      result: { requestId: request.requestId, status: "SUCCEEDED", text: "stored", truncated: false, replayed: false },
    });
    expect(await executeTool(request, f.connector, f.context, { connect: f.connect, ledger: f.ledger }))
      .toEqual({ requestId: request.requestId, status: "SUCCEEDED", text: "stored", truncated: false, replayed: true });
    expect(f.connect).not.toHaveBeenCalled();
  });

  it("redacts the credential from results", async () => {
    const f = fixture();
    f.call.mockResolvedValueOnce({ content: [{ type: "text", text: "echo tracker-secret-token" }] });
    const result = await executeTool(f.request("list_items", { state: "open" }), f.connector, f.context, { connect: f.connect, ledger: f.ledger });
    expect(result.text).toBe("echo [REDACTED]");
  });

  it("reports a credential failure as FAILED before any write without contacting the vendor", async () => {
    const f = fixture();
    f.issue.mockRejectedValueOnce(new Error("app not installed"));
    const result = await executeTool(f.request("create_item", { title: "Bug" }), f.connector, f.context, { connect: f.connect, ledger: f.ledger });
    expect(result).toMatchObject({ status: "FAILED", text: "Tracker MCP request failed before any write. Check Tracker key permissions and MCP availability." });
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.records.get(result.requestId)?.result.status).toBe("FAILED");
  });

  it("names the connector and its permissions when discovery fails", async () => {
    const f = fixture();
    f.connect.mockRejectedValueOnce(new Error("401"));
    await expect(discoverTools(f.connector, f.context, { connect: f.connect }))
      .rejects.toThrow(/Tracker MCP discovery failed; check Tracker key permissions and endpoint availability/);
  });

  it("discovers the approved catalog and closes the connection", async () => {
    const f = fixture();
    const catalog = await discoverTools(f.connector, f.context, { connect: f.connect });
    expect(catalog.tools.map((tool) => tool.name)).toEqual(["list_items", "create_item"]);
    expect(f.connect).toHaveBeenCalledWith(expect.objectContaining({ tools: ["list_items", "create_item", "unscoped", "composed"] }));
    expect(f.close).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/contract/gateway-engine.test.ts`
Expected: FAIL with `discoverTools`/`executeTool` not exported.

- [ ] **Step 3: Implement discovery and execution**

Replace the imports at the top of `packages/gateway/src/engine.ts` with:

```ts
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { agentXError } from "@agentx/contracts";
import { connectMcp, type McpConnection } from "./mcp-client.js";
import {
  GuardRejection,
  type CatalogTool,
  type ConnectorContext,
  type ConnectorDefinition,
  type Invocation,
  type Ledger,
  type ToolRequest,
  type ToolResult,
} from "./types.js";
import { fingerprint, isObject, resultText, withDeadline } from "./util.js";
```

Append to `packages/gateway/src/engine.ts`:

```ts
export interface EngineOptions { connect?: typeof connectMcp }

class PolicyFailure extends Error {}

/** Feature 007 fingerprinted requests under the key `repository`; keep it so stored records replay. */
export function requestFingerprint(request: ToolRequest): string {
  return fingerprint({ requestId: request.requestId, repository: request.scope, tool: request.tool, schemaHash: request.schemaHash, arguments: request.arguments });
}

export async function discoverTools<Scope>(
  connector: ConnectorDefinition<Scope>,
  context: ConnectorContext<Scope>,
  options: EngineOptions = {},
): Promise<{ tools: CatalogTool[] }> {
  let connection: McpConnection | undefined;
  const signal = AbortSignal.timeout(20_000);
  try {
    const credential = await withDeadline(connector.credentials.issue(context.scope, "read", context.requestedBy), signal);
    connection = await (options.connect ?? connectMcp)({ endpoint: connector.endpoint, token: credential.token, tools: context.policy.tools.map((tool) => tool.name), signal });
    return { tools: approveTools(connection, connector, context) };
  } catch {
    throw agentXError("RUNTIME_UNAVAILABLE", `${connector.label} MCP discovery failed; check ${connector.permissionsHint} and endpoint availability`);
  } finally { await connection?.close().catch(() => undefined); }
}

export async function executeTool<Scope>(
  request: ToolRequest,
  connector: ConnectorDefinition<Scope>,
  context: ConnectorContext<Scope>,
  options: EngineOptions & { ledger: Ledger },
): Promise<ToolResult> {
  const label = connector.label;
  const policy = context.policy.tools.find((tool) => tool.name === request.tool);
  if (!policy) throw agentXError("FORBIDDEN", `${label} MCP tool is not approved for this project`);
  if (connector.binder.properties.some((name) => Object.hasOwn(request.arguments, name))) {
    throw agentXError("FORBIDDEN", `${label} routing arguments are server controlled`);
  }
  const write = policy.access === "write";
  const durable = write || context.requestedBy !== undefined;
  const pending = publicResult(request, "IN_PROGRESS", write
    ? `This write is running or its outcome is unknown. Inspect ${label} before issuing a new write; do not automatically retry.`
    : "This read is running or its result has not been recorded.");
  let record: Invocation = {
    requestId: request.requestId, workspaceId: context.workspaceId, ownerKey: context.ownerKey,
    repository: request.scope, tool: request.tool, fingerprint: requestFingerprint(request),
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), result: pending,
    ...(context.requestedBy === undefined ? {} : { requestedBy: context.requestedBy }),
    ...(context.settingsRevision === undefined ? {} : { settingsRevision: context.settingsRevision }),
  };
  if (durable && !await options.ledger.claim(record)) {
    const previous = await options.ledger.get(request.requestId);
    if (!previous) throw agentXError("RUNTIME_UNAVAILABLE", "MCP invocation record unavailable; retry only with the same request ID");
    if (previous.ownerKey !== context.ownerKey || previous.workspaceId !== context.workspaceId) throw agentXError("NOT_FOUND", "MCP invocation not found");
    if (previous.requestedBy?.teamId !== context.requestedBy?.teamId || previous.requestedBy?.userId !== context.requestedBy?.userId) throw agentXError("NOT_FOUND", "MCP invocation not found");
    if (previous.fingerprint !== record.fingerprint) throw agentXError("IDEMPOTENCY_CONFLICT", "MCP request ID already used with different inputs");
    return { ...previous.result, replayed: true };
  }
  let connection: McpConnection | undefined;
  let writeAttempted = false;
  let response: ToolResult;
  const signal = AbortSignal.timeout(20_000);
  try {
    const credential = await withDeadline(connector.credentials.issue(context.scope, policy.access, context.requestedBy), signal);
    const tools = [request.tool];
    for (const guard of connector.guards) {
      for (const name of guard.requiredTools(request.tool, request.arguments)) if (!tools.includes(name)) tools.push(name);
    }
    connection = await (options.connect ?? connectMcp)({ endpoint: connector.endpoint, token: credential.token, tools, signal });
    const approved = approveTools(connection, connector, context).find((tool) => tool.name === request.tool);
    if (!approved || approved.schemaHash !== request.schemaHash) throw new PolicyFailure("MCP tool definition changed or is unavailable. Refresh tool discovery before submitting a new request.");
    const validate = new AjvJsonSchemaValidator().getValidator(approved.inputSchema);
    if (!validate(request.arguments).valid) throw new PolicyFailure("Arguments do not match the approved MCP tool schema.");
    const bound = connector.binder.bind(context.scope, credential);
    const args = { ...request.arguments, ...bound };
    const upstream = connection.tools.find((tool) => tool.name === request.tool)!;
    if (!new AjvJsonSchemaValidator().getValidator(upstream.inputSchema)(args).valid) throw new PolicyFailure("Arguments do not match the upstream MCP tool schema.");
    for (const guard of connector.guards) await guard.check({ tool: request.tool, arguments: request.arguments, bound, connection });
    signal.throwIfAborted();
    writeAttempted = write;
    const result = await connection.call(request.tool, args);
    if (result.isError) throw new Error("MCP tool reported an error");
    response = publicResult(request, "SUCCEEDED", resultText(result).split(credential.token).join("[REDACTED]"));
  } catch (error) {
    response = error instanceof PolicyFailure || error instanceof GuardRejection
      ? publicResult(request, "FAILED", error.message)
      : publicResult(request, writeAttempted ? "UNKNOWN" : "FAILED", writeAttempted
        ? `${label} write outcome is unknown. Inspect ${label} before issuing another request. Do not automatically retry.`
        : `${label} MCP request failed before any write. Check ${connector.permissionsHint} and MCP availability.`);
  } finally { await connection?.close().catch(() => undefined); }
  if (durable) {
    record = { ...record, updatedAt: new Date().toISOString(), result: response };
    try { await options.ledger.finish(record); }
    catch {
      return publicResult(request, write ? "UNKNOWN" : "FAILED", write
        ? `Could not persist the ${label} write outcome. Inspect ${label}; retry only with the same request ID to recover its record.`
        : `Could not persist the ${label} read outcome.`);
    }
  }
  return response;
}

function publicResult(request: ToolRequest, status: ToolResult["status"], text: string): ToolResult {
  return { requestId: request.requestId, status, text: text.slice(0, 64_000), truncated: text.length > 64_000, replayed: false };
}
```

- [ ] **Step 4: Build and run the tests**

Run: `npm run build && npx vitest run tests/contract/gateway-engine.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/engine.ts tests/contract/gateway-engine.test.ts
git commit -m "feat(gateway): add provider-neutral discovery and durable execution"
```

---

### Task 4: GitHub connector and the broker compatibility layer

**Files:**
- Create: `packages/gateway/src/github.ts`
- Modify: `packages/gateway/src/index.ts`
- Replace: `packages/broker/src/github-mcp.ts`
- Modify: `packages/broker/package.json` (drop the direct MCP SDK dependency), `package-lock.json`
- Test: `tests/contract/gateway-github.test.ts`; existing `tests/contract/github-mcp.test.ts`,
  `tests/contract/github-mcp-broker.test.ts`, `tests/integration/github-mcp.test.ts`,
  `tests/integration/hosted-slack-mcp.test.ts`, `tests/integration/mcp-orchestrator.test.ts` unchanged

**Interfaces:**
- Consumes: Task 2–3 exports.
- Produces:
  - `interface GitHubRepositoryScope { name: string; url: string; credentialRef: string }`
  - `type GitHubIssuer = (repository: GitHubRepositoryScope, access: Access) => Promise<{ owner: string; repo: string; token: string }>`
  - `const GITHUB_MCP_ENDPOINT: URL`
  - `const githubBinder: Binder<GitHubRepositoryScope>`
  - `const issueNotPullRequestGuard: Guard`
  - `function githubConnector(issue: GitHubIssuer): ConnectorDefinition<GitHubRepositoryScope>`
  - Broker keeps: `approvedTools`, `discoverGitHubTools`, `executeGitHubTool`, `GitHubMcpContext`,
    `GitHubMcpDependencies`, `GitHubMcpInvocation`, `GitHubMcpStore` with their current signatures.

- [ ] **Step 1: Write the failing test**

Create `tests/contract/gateway-github.test.ts`:

```ts
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { approvedTools, type GitHubMcpContext } from "../../packages/broker/src/github-mcp.js";
import { GITHUB_MCP_ENDPOINT, githubBinder } from "../../packages/gateway/src/index.js";

const sort = (item: unknown): unknown => Array.isArray(item) ? item.map(sort)
  : item && typeof item === "object" ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, sort(entry)]))
  : item;
const legacyHash = (value: unknown) => createHash("sha256").update(JSON.stringify(sort(value))).digest("hex");

describe("GitHub connector on the gateway", () => {
  it("keeps feature 007 schema hashes so in-flight turns survive the release", () => {
    const repository = { name: "app", url: "https://github.com/acme/app.git", credentialRef: "github-app" };
    const policy = { name: "list_issues", access: "read" as const };
    const context: GitHubMcpContext = { workspaceId: "w", ownerKey: "o", repository, policy: { tools: [policy] } };
    const upstream = { name: "list_issues", description: "List", inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" } }, required: ["owner", "repo"] } };
    const [tool] = approvedTools({ tools: [upstream] }, context);
    expect(tool?.schemaHash).toBe(legacyHash({ upstream, policy, repository }));
    expect(tool?.repository).toBe("app");
  });

  it("binds owner and repo from the App-issued credential and uses GitHub's hosted endpoint", () => {
    expect(GITHUB_MCP_ENDPOINT.href).toBe("https://api.githubcopilot.com/mcp/");
    expect(githubBinder.properties).toEqual(["owner", "repo"]);
    const scope = { name: "app", url: "https://github.com/acme/app.git", credentialRef: "github-app" };
    expect(githubBinder.bind(scope, { token: "t", bindings: { owner: "acme", repo: "app" } })).toEqual({ owner: "acme", repo: "app" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/contract/gateway-github.test.ts`
Expected: FAIL with `GITHUB_MCP_ENDPOINT`/`githubBinder` not exported.

- [ ] **Step 3: Write the GitHub connector**

`packages/gateway/src/github.ts`:

```ts
import { GuardRejection, type Access, type Binder, type ConnectorDefinition, type Guard } from "./types.js";
import { isObject, resultText } from "./util.js";

export interface GitHubRepositoryScope { name: string; url: string; credentialRef: string }

/** Mints a repository-scoped installation token and names the repository it is valid for. */
export type GitHubIssuer = (repository: GitHubRepositoryScope, access: Access) => Promise<{ owner: string; repo: string; token: string }>;

export const GITHUB_MCP_ENDPOINT = new URL("https://api.githubcopilot.com/mcp/");

/** The App's installation token is authoritative for owner and repo, so the binder takes them from it. */
export const githubBinder: Binder<GitHubRepositoryScope> = {
  properties: ["owner", "repo"],
  bind: (_scope, credential) => ({ owner: credential.bindings.owner, repo: credential.bindings.repo }),
};

/**
 * GitHub's issue endpoints also accept pull-request numbers. This scope guard keeps issue tools off
 * pull requests so AgentX's validated pull-request workflows cannot be bypassed.
 */
export const issueNotPullRequestGuard: Guard = {
  requiredTools: (tool, args) => args.issue_number !== undefined && tool !== "issue_read" ? ["issue_read"] : [],
  async check({ arguments: args, bound, connection }) {
    if (args.issue_number === undefined) return;
    const number = args.issue_number;
    if (!Number.isSafeInteger(number) || (number as number) < 1) throw new GuardRejection("Invalid issue number.");
    const result = await connection.call("issue_read", { method: "get", owner: bound.owner, repo: bound.repo, issue_number: number });
    if (result.isError) throw new Error("Issue preflight failed");
    const issue: unknown = JSON.parse(resultText(result));
    const expected = `https://github.com/${String(bound.owner)}/${String(bound.repo)}/issues/${number as number}`.toLowerCase();
    if (!isObject(issue) || issue.number !== number || typeof issue.html_url !== "string" || issue.html_url.toLowerCase() !== expected || issue.pull_request) {
      throw new GuardRejection("This integration requires an issue in the selected repository, not a pull request or another resource.");
    }
  },
};

export function githubConnector(issue: GitHubIssuer): ConnectorDefinition<GitHubRepositoryScope> {
  return {
    label: "GitHub",
    endpoint: GITHUB_MCP_ENDPOINT,
    permissionsHint: "GitHub App issue permissions",
    credentials: {
      async issue(scope, access) {
        const issued = await issue(scope, access);
        return { token: issued.token, bindings: { owner: issued.owner, repo: issued.repo } };
      },
    },
    binder: githubBinder,
    guards: [issueNotPullRequestGuard],
  };
}
```

Add to `packages/gateway/src/index.ts`:

```ts
export * from "./github.js";
```

- [ ] **Step 4: Replace the broker module with a compatibility layer**

Replace the whole of `packages/broker/src/github-mcp.ts` with:

```ts
import type { GitHubMcpPolicy, GitHubMcpRequest, GitHubMcpResult, GitHubMcpTool, SlackRequester } from "@agentx/contracts";
import {
  approveTools,
  discoverTools,
  executeTool,
  githubBinder,
  githubConnector,
  type CatalogTool,
  type ConnectorContext,
  type GitHubIssuer,
  type GitHubRepositoryScope,
  type Invocation,
  type Ledger,
  type McpConnection,
  type connectMcp,
} from "@agentx/gateway";

// Feature 007 names, kept while the broker moves to connector routes (feature 013, phase 1b).
export type GitHubMcpInvocation = Invocation;
export type GitHubMcpStore = Ledger;

export interface GitHubMcpDependencies {
  credentials(repository: { url: string; credentialRef: string }, access: "read" | "write"): Promise<{ owner: string; repo: string; token: string }>;
  connect?: typeof connectMcp;
}

export interface GitHubMcpContext {
  requestedBy?: SlackRequester;
  workspaceId: string;
  ownerKey: string;
  repository: GitHubRepositoryScope;
  policy: GitHubMcpPolicy;
  settingsRevision?: number;
}

export async function discoverGitHubTools(context: GitHubMcpContext, dependencies: GitHubMcpDependencies): Promise<{ tools: GitHubMcpTool[] }> {
  const { tools } = await discoverTools(githubConnector(issuer(dependencies)), connectorContext(context), connectOption(dependencies));
  return { tools: tools.map(toGitHubTool) };
}

export function approvedTools(connection: Pick<McpConnection, "tools">, context: GitHubMcpContext): GitHubMcpTool[] {
  return approveTools(connection, { binder: githubBinder }, connectorContext(context)).map(toGitHubTool);
}

export async function executeGitHubTool(
  request: GitHubMcpRequest,
  context: GitHubMcpContext,
  dependencies: GitHubMcpDependencies & { store: GitHubMcpStore },
): Promise<GitHubMcpResult> {
  return executeTool(
    { requestId: request.requestId, scope: request.repository, tool: request.tool, schemaHash: request.schemaHash, arguments: request.arguments },
    githubConnector(issuer(dependencies)),
    connectorContext(context),
    { ...connectOption(dependencies), ledger: dependencies.store },
  );
}

function issuer(dependencies: GitHubMcpDependencies): GitHubIssuer {
  return (repository, access) => dependencies.credentials(repository, access);
}

function connectOption(dependencies: GitHubMcpDependencies): { connect?: typeof connectMcp } {
  return dependencies.connect === undefined ? {} : { connect: dependencies.connect };
}

function connectorContext(context: GitHubMcpContext): ConnectorContext<GitHubRepositoryScope> {
  return {
    workspaceId: context.workspaceId,
    ownerKey: context.ownerKey,
    scopeAlias: context.repository.name,
    scope: context.repository,
    policy: context.policy,
    ...(context.requestedBy === undefined ? {} : { requestedBy: context.requestedBy }),
    ...(context.settingsRevision === undefined ? {} : { settingsRevision: context.settingsRevision }),
  };
}

function toGitHubTool(tool: CatalogTool): GitHubMcpTool {
  return { name: tool.name, repository: tool.scope, description: tool.description, inputSchema: tool.inputSchema, schemaHash: tool.schemaHash, access: tool.access };
}
```

- [ ] **Step 5: Drop the broker's direct SDK dependency**

In `packages/broker/package.json` remove the line `"@modelcontextprotocol/sdk": "1.30.1",`.
Confirm nothing else in the broker imports it:

Run: `grep -rn "@modelcontextprotocol/sdk" packages/broker/src`
Expected: no output.

Run: `npm install`
Expected: `package-lock.json` moves the SDK under the gateway's dependencies; no version changes.

- [ ] **Step 6: Build and run every MCP test**

Run: `npm run build && npx vitest run tests/contract/gateway-github.test.ts tests/contract/github-mcp.test.ts tests/contract/github-mcp-broker.test.ts tests/integration/github-mcp.test.ts tests/integration/hosted-slack-mcp.test.ts tests/integration/mcp-orchestrator.test.ts`
Expected: PASS, with no edits to the five feature 007 test files (`git diff --stat tests/` lists only
new files).

- [ ] **Step 7: Commit**

```bash
git add packages/gateway packages/broker package-lock.json tests/contract/gateway-github.test.ts
git commit -m "refactor(broker): serve GitHub MCP through the gateway's GitHub connector"
```

---

### Task 5: Full verification and pull request

**Files:**
- Modify: `specs/013-connector-gateway/tasks.md` (check T001–T005)

**Interfaces:**
- Consumes: everything above.
- Produces: pull request `feat(gateway): extract the connector gateway (013 phase 1a)` to `mainline`.

- [ ] **Step 1: Run the full local suite from a clean build**

```bash
npm run clean && npm ci && npm run typecheck && npm run lint && npm test && npm run infra:synth
```

Expected: typecheck and lint pass; `npm test` reports every test file passing with a count equal to
the pre-change count plus 14 new tests (9 in `gateway-engine`, 2 in `gateway-github`, 3 in
`workspace-packages`); synthesis passes with the existing NoEcho and feature-flag warnings only.

- [ ] **Step 2: Confirm the scope of the diff**

Run: `git diff --stat origin/mainline -- packages/broker/src/aws tests/contract/github-mcp.test.ts tests/contract/github-mcp-broker.test.ts tests/integration`
Expected: no output. `broker.ts` and every existing test are unchanged.

- [ ] **Step 3: Check the tasks and commit**

Mark T001–T005 `[X]` in `specs/013-connector-gateway/tasks.md`.

```bash
git add specs/013-connector-gateway/tasks.md
git commit -m "docs(spec): record phase 1a of the connector gateway"
```

- [ ] **Step 4: Open the pull request**

```bash
git push origin HEAD:feat/013-phase-1a-gateway
gh pr create -R PrepLabsAI/AgentX --base mainline --head feat/013-phase-1a-gateway \
  --title "feat(gateway): extract the connector gateway (013 phase 1a)" \
  --body-file specs/013-connector-gateway/plans/phase-1a-pr.md
```

`specs/013-connector-gateway/plans/phase-1a-pr.md` holds the body: summary of the move, the two
generalized messages, the compatibility guarantees (fingerprints, schema hashes, unchanged tests),
the verification output, and the attribution line
`🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Write it in Step 4 from the
actual verification output, not in advance.
