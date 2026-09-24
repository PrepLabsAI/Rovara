# Phase 1b: Connector Configuration, Schema Flattening, Ledger and Catalog Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a project declare connectors in `integrations.connectors` (GitHub first, legacy
`githubMcp` still accepted), keep vendor tools whose schemas use `$ref`/`$defs`/`allOf`, report
tools that cannot be offered instead of dropping them silently, generalize the write ledger, and
cache discovered catalogs so turns stop paying a vendor round trip per repository.

**Architecture:** Contracts gain `ConnectorsSchema` and `githubConnectorOf(definition)`, which
resolves either configuration form to one GitHub connector. The gateway gains `flattenSchema`,
`reviewTools` (tools plus skipped reasons) and `CatalogCache`. The broker's GitHub route reads the
connector through `githubConnectorOf`, serves discovery from the cache keyed by project, revision,
connector and repository, invalidates it after a failed call, and writes the ledger through a
generic `DynamoConnectorLedger`. The orchestrator and the `/github/` route contract are unchanged.

**Tech Stack:** TypeScript 5.9 strict, Node 22.19–22.x, Zod 4, Vitest 5, MCP SDK 1.30.1 (Ajv).

**Spec:** [../spec.md](../spec.md) — FR-007, FR-008, FR-009, FR-010, FR-031; plan [../plan.md](../plan.md).

## Spec amendments carried by this phase

1. **Routes and workspace-resolution fields move to phase 2** (T007, T011). Their only consumer is
   the orchestrator's new presentation, and the connector catalog's presented shape (`target`
   enum, prefixed names) is phase 2 work. Shipping them now would add routes nothing calls.
2. **The GitHub connector keeps the `GITHUB_MCP#` ledger key** (FR-031). Moving it to
   `CONNECTOR#github#` needs a cross-key check that still races an old broker during the release;
   keeping the key removes the race. New connector types use `CONNECTOR#<name>#`.
3. **A GitHub connector has no `credentialRef` and scopes by repository name** (FR-009). Its
   credential is each repository's GitHub App reference, exactly as feature 007 behaves; scopes are
   `all-repositories` or a list of registered repository names.
4. **The catalog cache is in memory per broker container**, not a DynamoDB item (data model). It
   needs no table change, and a cold container simply rediscovers.
5. **Connector types other than `github` are refused until their phase** (5 and 6).

Task 5 writes these into `spec.md`, `data-model.md`, `contracts/project-config.md` and `tasks.md`.

## Global Constraints

- Node `>=22.19.0 <23`; `npm run build` before `npm test`.
- No new runtime dependency; MCP SDK stays `1.30.1`.
- Existing test assertions stay unchanged except the two gateway-engine expectations Task 2 names,
  which change because `allOf` schemas become representable.
- The `/v1/.../github/tools|call` request and response shapes are unchanged.
- A definition registered with `integrations.githubMcp` keeps working without re-registration.
- `packages/contracts` is a worker image input, so this phase rebuilds the worker image; the
  release deploys the runtime before the control plane, so the worker accepts `connectors` first.
- Commit messages `type(scope): summary`, ending
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

1. **A vendor changes a schema while a catalog is cached.** The call fails "definition changed"
   and the model is told to rediscover; it must not keep receiving the stale cached catalog.
   Pinned in Task 4 (failed call invalidates).
2. **A property literally named `definitions` or `$defs`.** Flattening must keep it; only the
   schema keywords are removed. Pinned in Task 2.
3. **A vendor schema whose `$ref`s form a DAG that expands hugely.** Flattening must refuse once a
   node budget is spent while resolving, before memory grows with the expansion. Pinned in Task 2.
4. **A revision that narrows a GitHub connector's scopes.** A thread must lose access to the
   removed repository on its next discovery and call. Pinned in Task 1 (resolver) and Task 4
   (route returns 404 for an out-of-scope repository).
5. **Both `githubMcp` and `connectors` in one definition.** Registration must refuse it rather
   than pick one. Pinned in Task 1.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/contracts/src/github-mcp.ts` | Export `ToolApprovalSchema`; `GitHubMcpPolicySchema` built from it |
| `packages/contracts/src/connectors.ts` | `ConnectorNameSchema`, `GitHubConnectorSchema`, `ConnectorConfigSchema`, `ConnectorsSchema` |
| `packages/contracts/src/project.ts` | `integrations.connectors`, cross-field checks, `githubConnectorOf`, `RepositoryDefinition` type |
| `packages/contracts/src/index.ts` | Export connectors |
| `packages/gateway/src/schema.ts` | `flattenSchema` |
| `packages/gateway/src/engine.ts` | `reviewTools`, `SkippedTool`; `approveTools` and `discoverTools` use it |
| `packages/gateway/src/catalog-cache.ts` | `CatalogCache` |
| `packages/broker/src/aws/connector-ledger.ts` | `DynamoConnectorLedger` (replaces `aws/github-mcp.ts`) |
| `packages/broker/src/aws/broker.ts` | GitHub route and `threadIntegrations` through `githubConnectorOf`; cache |
| `packages/broker/src/github-mcp.ts` | `GitHubMcpCatalog` type export |
| Tests | `connector-config`, `gateway-schema`, `gateway-engine` (2 expectations), `catalog-cache`, `connector-ledger`, `slack-control-plane` (2 new cases) |

---

### Task 1: Connector configuration and the GitHub resolver

**Files:**
- Modify: `packages/contracts/src/github-mcp.ts:1-12`
- Create: `packages/contracts/src/connectors.ts`
- Modify: `packages/contracts/src/project.ts:131-162` and append helpers
- Modify: `packages/contracts/src/index.ts`
- Test: `tests/contract/connector-config.test.ts`

**Interfaces:**
- Consumes: `McpToolNameSchema`, `ProjectDefinitionSchema`, `RepositoryDefinitionSchema`.
- Produces:
  - `ToolApprovalSchema` (exact current tool-approval object, `.strict()`)
  - `ConnectorNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,19}$/)`
  - `GitHubConnectorSchema` → `{ name; type: "github"; scopes: "all-repositories" | string[]; tools: ToolApproval[] }`
  - `ConnectorConfigSchema` (discriminated union on `type`, `github` only), `ConnectorsSchema` (1..8, unique names, at most one `github`)
  - `type RepositoryDefinition = z.infer<typeof RepositoryDefinitionSchema>`
  - `interface ResolvedGitHubConnector { name: string; repositories: RepositoryDefinition[]; policy: GitHubMcpPolicy }`
  - `function githubConnectorOf(project: Pick<ProjectDefinition, "repositories" | "integrations">): ResolvedGitHubConnector | undefined`

- [ ] **Step 1: Write the failing test**

Create `tests/contract/connector-config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ProjectDefinitionSchema, githubConnectorOf } from "../../packages/contracts/src/index.js";

const repository = (name: string) => ({
  name, url: `https://github.com/example/${name}.git`, path: `repo/${name}`, defaultBranch: "main", credentialRef: "github-app",
});
const tools = [{ name: "list_issues", access: "read" }];
const project = (integrations?: unknown) => ({
  name: "payments", revision: 1, repositories: [repository("api"), repository("web")],
  setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  ...(integrations === undefined ? {} : { integrations }),
});
const issues = (value: unknown) => {
  const parsed = ProjectDefinitionSchema.safeParse(value);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
};

describe("connector configuration", () => {
  it("resolves a github connector over all repositories", () => {
    const definition = ProjectDefinitionSchema.parse(project({ connectors: [{ name: "github", type: "github", scopes: "all-repositories", tools }] }));
    const github = githubConnectorOf(definition);
    expect(github?.name).toBe("github");
    expect(github?.repositories.map((entry) => entry.name)).toEqual(["api", "web"]);
    expect(github?.policy).toEqual({ tools });
  });

  it("limits a github connector to its listed repositories", () => {
    const definition = ProjectDefinitionSchema.parse(project({ connectors: [{ name: "gh", type: "github", scopes: ["web"], tools }] }));
    expect(githubConnectorOf(definition)?.repositories.map((entry) => entry.name)).toEqual(["web"]);
    expect(githubConnectorOf(definition)?.name).toBe("gh");
  });

  it("reads the legacy githubMcp policy as a github connector over all repositories", () => {
    const definition = ProjectDefinitionSchema.parse(project({ githubMcp: { tools } }));
    expect(githubConnectorOf(definition)).toEqual({ name: "github", repositories: definition.repositories, policy: { tools } });
    expect(githubConnectorOf(ProjectDefinitionSchema.parse(project()))).toBeUndefined();
  });

  it("refuses both configuration forms in one definition", () => {
    expect(issues(project({ githubMcp: { tools }, connectors: [{ name: "github", type: "github", scopes: "all-repositories", tools }] })))
      .toContain("use either integrations.githubMcp or integrations.connectors, not both");
  });

  it("refuses scopes that name an unregistered repository", () => {
    expect(issues(project({ connectors: [{ name: "github", type: "github", scopes: ["mobile"], tools }] })))
      .toContain("connector github scopes unregistered repository mobile");
  });

  it("refuses duplicate names, a second github connector and types that are not supported yet", () => {
    const github = { name: "github", type: "github", scopes: "all-repositories", tools };
    expect(issues(project({ connectors: [github, github] }))).toContain("connector names must be unique");
    expect(issues(project({ connectors: [github, { ...github, name: "github-two" }] }))).toContain("at most one github connector is supported");
    expect(issues(project({ connectors: [{ name: "linear", type: "linear", credentialRef: "x", scopes: [], tools }] })).length).toBeGreaterThan(0);
    expect(issues(project({ connectors: [{ ...github, name: "GitHub" }] })).length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/contract/connector-config.test.ts`
Expected: FAIL — `githubConnectorOf` is not exported (TypeError: githubConnectorOf is not a function).

- [ ] **Step 3: Extract the tool approval schema**

In `packages/contracts/src/github-mcp.ts`, replace the `GitHubMcpPolicySchema` declaration with:

```ts
export const ToolApprovalSchema = z.object({
  name: McpToolNameSchema,
  access: z.enum(["read", "write"]),
  allowedArguments: z.array(z.string().min(1).max(128)).max(64).optional(),
  argumentValues: z.record(z.string().min(1).max(128), z.array(z.union([z.string().max(256), z.number(), z.boolean()])).min(1).max(32)).optional(),
}).strict();
export const ToolApprovalListSchema = z.array(ToolApprovalSchema).min(1).max(32)
  .refine((tools) => new Set(tools.map((tool) => tool.name)).size === tools.length, "duplicate MCP tool approval");
export const GitHubMcpPolicySchema = z.object({ tools: ToolApprovalListSchema }).strict();
```

Add `export type ToolApproval = z.infer<typeof ToolApprovalSchema>;` beside the other type exports.

- [ ] **Step 4: Add the connector schemas**

Create `packages/contracts/src/connectors.ts`:

```ts
import { z } from "zod";
import { ToolApprovalListSchema } from "./github-mcp.js";

/** Becomes the tool prefix `<name>__<tool>`, so it is short and lowercase. */
export const ConnectorNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,19}$/);
const RepositoryNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);

/** GitHub uses each scoped repository's own GitHub App credential, as feature 007 does. */
export const GitHubConnectorSchema = z.object({
  name: ConnectorNameSchema,
  type: z.literal("github"),
  scopes: z.union([z.literal("all-repositories"), z.array(RepositoryNameSchema).min(1).max(32)]),
  tools: ToolApprovalListSchema,
}).strict();

export const ConnectorConfigSchema = z.discriminatedUnion("type", [GitHubConnectorSchema]);

export const ConnectorsSchema = z.array(ConnectorConfigSchema).min(1).max(8).superRefine((connectors, context) => {
  if (new Set(connectors.map((connector) => connector.name)).size !== connectors.length) {
    context.addIssue({ code: "custom", message: "connector names must be unique" });
  }
  if (connectors.filter((connector) => connector.type === "github").length > 1) {
    context.addIssue({ code: "custom", message: "at most one github connector is supported" });
  }
});

export type GitHubConnectorConfig = z.infer<typeof GitHubConnectorSchema>;
export type ConnectorConfig = z.infer<typeof ConnectorConfigSchema>;
```

In `packages/contracts/src/index.ts` add `export * from "./connectors.js";` after the errors line.

- [ ] **Step 5: Wire connectors into the project definition**

In `packages/contracts/src/project.ts`:

Add the import after the `GitHubMcpPolicySchema` import:

```ts
import { ConnectorsSchema } from "./connectors.js";
import type { GitHubMcpPolicy } from "./github-mcp.js";
```

Replace the `integrations` line with:

```ts
    integrations: z.object({
      githubMcp: GitHubMcpPolicySchema.optional(),
      connectors: ConnectorsSchema.optional(),
    }).strict().optional(),
```

At the end of the `ProjectDefinitionSchema` `superRefine` callback, after the overlapping-paths loop,
add:

```ts
    if (project.integrations?.githubMcp && project.integrations.connectors) {
      context.addIssue({ code: "custom", path: ["integrations"], message: "use either integrations.githubMcp or integrations.connectors, not both" });
    }
    for (const connector of project.integrations?.connectors ?? []) {
      if (connector.scopes === "all-repositories") continue;
      for (const name of connector.scopes) {
        if (!names.has(name)) {
          context.addIssue({ code: "custom", path: ["integrations", "connectors"], message: `connector ${connector.name} scopes unregistered repository ${name}` });
        }
      }
    }
```

Append after the `ProjectDefinition` type exports:

```ts
export type RepositoryDefinition = z.infer<typeof RepositoryDefinitionSchema>;

export interface ResolvedGitHubConnector {
  name: string;
  repositories: RepositoryDefinition[];
  policy: GitHubMcpPolicy;
}

/**
 * The project's GitHub connector from either configuration form. Definitions registered with the
 * feature 007 `githubMcp` policy read as a connector named `github` over every repository.
 */
export function githubConnectorOf(project: Pick<ProjectDefinition, "repositories" | "integrations">): ResolvedGitHubConnector | undefined {
  const legacy = project.integrations?.githubMcp;
  if (legacy) return { name: "github", repositories: project.repositories, policy: legacy };
  const connector = project.integrations?.connectors?.find((entry) => entry.type === "github");
  if (!connector) return undefined;
  const scopes = connector.scopes;
  const repositories = scopes === "all-repositories"
    ? project.repositories
    : project.repositories.filter((repository) => scopes.includes(repository.name));
  return { name: connector.name, repositories, policy: { tools: connector.tools } };
}
```

- [ ] **Step 6: Build and run the tests**

Run: `npm run build && npx vitest run tests/contract/connector-config.test.ts tests/contract/contracts.test.ts tests/contract/github-mcp.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts tests/contract/connector-config.test.ts
git commit -m "feat(contracts): declare connectors in the project definition"
```

---

### Task 2: Schema flattening and skipped-tool reasons

**Files:**
- Create: `packages/gateway/src/schema.ts`
- Modify: `packages/gateway/src/engine.ts` (`approveTools` becomes a wrapper of `reviewTools`; `discoverTools` returns `skipped`)
- Modify: `packages/gateway/src/index.ts`
- Test: `tests/contract/gateway-schema.test.ts`; `tests/contract/gateway-engine.test.ts`

**Interfaces:**
- Consumes: `isObject` from `util.ts`; Task 2/3 of phase 1a engine.
- Produces:
  - `type FlattenResult = { schema: Record<string, unknown> } | { unsupported: string }`
  - `function flattenSchema(input: Record<string, unknown>): FlattenResult`
  - `interface SkippedTool { tool: string; reason: string }`
  - `function reviewTools<Scope>(connection: Pick<McpConnection, "tools">, connector: Pick<ConnectorDefinition<Scope>, "binder">, context: ConnectorContext<Scope>): { tools: CatalogTool[]; skipped: SkippedTool[] }`
  - `discoverTools` now resolves `{ tools: CatalogTool[]; skipped: SkippedTool[] }`

- [ ] **Step 1: Write the failing schema tests**

Create `tests/contract/gateway-schema.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { flattenSchema } from "../../packages/gateway/src/index.js";

describe("vendor schema flattening", () => {
  it("inlines local $defs references and drops the definitions", () => {
    const result = flattenSchema({
      type: "object",
      properties: { team: { $ref: "#/$defs/Team" }, labels: { type: "array", items: { $ref: "#/definitions/Label" } } },
      required: ["team"],
      $defs: { Team: { type: "string", description: "Team ID" } },
      definitions: { Label: { type: "string" } },
    });
    expect(result).toEqual({ schema: {
      type: "object",
      properties: { team: { type: "string", description: "Team ID" }, labels: { type: "array", items: { type: "string" } } },
      required: ["team"],
    } });
  });

  it("merges allOf object parts and lets a $ref's sibling annotations win", () => {
    const result = flattenSchema({
      allOf: [
        { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
        { type: "object", properties: { body: { $ref: "#/$defs/Text", description: "Issue body" } }, additionalProperties: false },
      ],
      $defs: { Text: { type: "string", description: "Markdown" } },
    });
    expect(result).toEqual({ schema: {
      type: "object",
      properties: { title: { type: "string" }, body: { type: "string", description: "Issue body" } },
      required: ["title"],
    } });
  });

  it("keeps properties named definitions or $defs", () => {
    const result = flattenSchema({ type: "object", properties: { definitions: { type: "string" }, $defs: { type: "number" } } });
    expect(result).toEqual({ schema: { type: "object", properties: { definitions: { type: "string" }, $defs: { type: "number" } } } });
  });

  it("refuses recursive, external, unresolvable and conflicting schemas", () => {
    expect(flattenSchema({ type: "object", properties: { node: { $ref: "#/$defs/Node" } }, $defs: { Node: { type: "object", properties: { child: { $ref: "#/$defs/Node" } } } } }))
      .toEqual({ unsupported: "recursive reference #/$defs/Node" });
    expect(flattenSchema({ type: "object", properties: { a: { $ref: "https://example.test/a.json" } } }))
      .toEqual({ unsupported: "external reference https://example.test/a.json" });
    expect(flattenSchema({ type: "object", properties: { a: { $ref: "#/$defs/Missing" } } }))
      .toEqual({ unsupported: "unresolvable reference #/$defs/Missing" });
    expect(flattenSchema({ allOf: [{ type: "object", properties: { a: { type: "string" } } }, { type: "object", properties: { a: { type: "number" } } }] }))
      .toEqual({ unsupported: "conflicting definitions of property a" });
    expect(flattenSchema({ allOf: [{ type: "object" }, { type: "array" }] }))
      .toEqual({ unsupported: "conflicting type" });
  });

  it("refuses a reference graph that expands beyond the size bound", () => {
    const $defs: Record<string, unknown> = { L0: { type: "string", description: "x".repeat(64) } };
    for (let level = 1; level <= 16; level += 1) {
      $defs[`L${level}`] = { type: "object", properties: { a: { $ref: `#/$defs/L${level - 1}` }, b: { $ref: `#/$defs/L${level - 1}` } } };
    }
    expect(flattenSchema({ type: "object", properties: { root: { $ref: "#/$defs/L16" } }, $defs }))
      .toEqual({ unsupported: "flattened schema exceeds 20000 nodes" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/contract/gateway-schema.test.ts`
Expected: FAIL — `flattenSchema` is not a function.

- [ ] **Step 3: Implement `schema.ts`**

Create `packages/gateway/src/schema.ts`:

```ts
import { isObject } from "./util.js";

export type FlattenResult = { schema: Record<string, unknown> } | { unsupported: string };

const MAX_DEPTH = 64;
/** Bounds expansion of shared `$ref`s while resolving, before memory can grow with it. */
const MAX_NODES = 20_000;
/** Keywords that describe rather than constrain; the first value wins when parts are merged. */
const ANNOTATIONS = new Set(["description", "title", "examples", "default", "$comment", "deprecated"]);

class Unsupported extends Error {}

/**
 * Inline local `$ref`s and merge `allOf` parts so policy narrowing can reason about one plain
 * object schema. The vendor's original schema still validates every call.
 */
export function flattenSchema(input: Record<string, unknown>): FlattenResult {
  try {
    const resolved = resolveNode(input, input, [], 0, { remaining: MAX_NODES });
    if (!isObject(resolved)) return { unsupported: "schema is not an object" };
    return { schema: resolved };
  } catch (error) {
    if (error instanceof Unsupported) return { unsupported: error.message };
    throw error;
  }
}

function resolveNode(node: unknown, root: Record<string, unknown>, stack: readonly string[], depth: number, budget: { remaining: number }): unknown {
  if (depth > MAX_DEPTH) throw new Unsupported(`schema nesting exceeds ${MAX_DEPTH} levels`);
  if (Array.isArray(node)) return node.map((item) => resolveNode(item, root, stack, depth + 1, budget));
  if (!isObject(node)) return node;
  budget.remaining -= 1;
  if (budget.remaining < 0) throw new Unsupported(`flattened schema exceeds ${MAX_NODES} nodes`);
  if (typeof node.$ref === "string") {
    const ref = node.$ref;
    if (ref === "#" || stack.includes(ref)) throw new Unsupported(`recursive reference ${ref}`);
    const target = resolveNode(lookup(root, ref), root, [...stack, ref], depth + 1, budget);
    const siblings = Object.fromEntries(Object.entries(node).filter(([key]) => key !== "$ref"));
    if (Object.keys(siblings).length === 0) return target;
    return mergeAll([resolveNode(siblings, root, stack, depth + 1, budget), target]);
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "$defs" || key === "definitions") continue;
    out[key] = key === "properties" && isObject(value)
      ? Object.fromEntries(Object.entries(value).map(([name, schema]) => [name, resolveNode(schema, root, stack, depth + 1, budget)]))
      : resolveNode(value, root, stack, depth + 1, budget);
  }
  if (!Array.isArray(out.allOf)) return out;
  const parts = out.allOf as unknown[];
  delete out.allOf;
  return mergeAll([out, ...parts]);
}

function lookup(root: Record<string, unknown>, ref: string): unknown {
  if (!ref.startsWith("#/")) throw new Unsupported(`external reference ${ref}`);
  let node: unknown = root;
  for (const raw of ref.slice(2).split("/")) {
    const segment = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isObject(node) || !Object.hasOwn(node, segment)) throw new Unsupported(`unresolvable reference ${ref}`);
    node = node[segment];
  }
  return node;
}

function mergeAll(parts: readonly unknown[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const part of parts) {
    if (!isObject(part)) throw new Unsupported("allOf member is not an object schema");
    for (const [key, value] of Object.entries(part)) {
      if (key === "properties") {
        if (!isObject(value)) throw new Unsupported("properties is not an object");
        const target: Record<string, unknown> = isObject(merged.properties) ? merged.properties : {};
        for (const [name, schema] of Object.entries(value)) {
          if (Object.hasOwn(target, name) && JSON.stringify(target[name]) !== JSON.stringify(schema)) {
            throw new Unsupported(`conflicting definitions of property ${name}`);
          }
          target[name] = schema;
        }
        merged.properties = target;
      } else if (key === "required") {
        if (!Array.isArray(value)) throw new Unsupported("required is not an array");
        const existing = Array.isArray(merged.required) ? merged.required as unknown[] : [];
        merged.required = [...new Set([...existing, ...value])];
      } else if (key === "additionalProperties") {
        // Narrowing sets its own additionalProperties; the vendor schema still validates the call.
        continue;
      } else if (Object.hasOwn(merged, key)) {
        if (ANNOTATIONS.has(key)) continue;
        if (JSON.stringify(merged[key]) !== JSON.stringify(value)) throw new Unsupported(`conflicting ${key}`);
      } else {
        merged[key] = value;
      }
    }
  }
  return merged;
}
```

Add `export * from "./schema.js";` to `packages/gateway/src/index.ts` (after `mcp-client`).

- [ ] **Step 4: Run the schema tests**

Run: `npm run build && npx vitest run tests/contract/gateway-schema.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the failing engine expectations**

In `tests/contract/gateway-engine.test.ts`:

(a) In `fixture()`, change the `composed` tool to a real `allOf` and add an `anyOf` tool and an
approved tool the vendor does not offer:

```ts
    { name: "composed", description: "Uses allOf", inputSchema: { allOf: [schema({}), { type: "object", properties: { note: { $ref: "#/$defs/Note" } } }], $defs: { Note: { type: "string" } } } },
    { name: "either", description: "Uses anyOf", inputSchema: { anyOf: [schema({})] } },
```

and in `context.policy.tools` add `{ name: "either", access: "read" }, { name: "retired", access: "read" }`.

(b) Replace the first test's first expectation and add a skipped-reasons test:

```ts
    expect(catalog.map((tool) => tool.name)).toEqual(["list_items", "create_item", "composed"]);
```

```ts
  it("reports every approved tool it cannot offer, with a reason", () => {
    const f = fixture();
    const review = reviewTools({ tools: f.tools }, f.connector, f.context);
    expect(review.skipped).toEqual([
      { tool: "retired", reason: "not offered by the vendor" },
      { tool: "unscoped", reason: "missing server-bound property siteId" },
      { tool: "either", reason: "schema is not a plain object" },
    ]);
    expect((review.tools.find((tool) => tool.name === "composed")!.inputSchema.properties as Record<string, unknown>).note).toEqual({ type: "string" });
  });
```

(c) In `discovers the approved catalog and closes the connection`, replace the two expectations
with:

```ts
    expect(catalog.tools.map((tool) => tool.name)).toEqual(["list_items", "create_item", "composed"]);
    expect(catalog.skipped.map((entry) => entry.tool)).toEqual(["retired", "unscoped", "either"]);
    expect(f.connect).toHaveBeenCalledWith(expect.objectContaining({ tools: ["list_items", "create_item", "unscoped", "composed", "either", "retired"] }));
```

(d) Add `reviewTools,` to the gateway import list.

- [ ] **Step 6: Run to verify they fail**

Run: `npx vitest run tests/contract/gateway-engine.test.ts`
Expected: FAIL — `reviewTools` is not a function, and the catalog lacks `composed`.

- [ ] **Step 7: Implement `reviewTools`**

In `packages/gateway/src/engine.ts`, add `import { flattenSchema } from "./schema.js";` and replace
the whole `approveTools` function with:

```ts
export interface SkippedTool { tool: string; reason: string }

/** Derive schemas from discovery, narrow by admin policy, bind routing outside model arguments, and say why any approved tool is not offered. */
export function reviewTools<Scope>(
  connection: Pick<McpConnection, "tools">,
  connector: Pick<ConnectorDefinition<Scope>, "binder">,
  context: ConnectorContext<Scope>,
): { tools: CatalogTool[]; skipped: SkippedTool[] } {
  const tools: CatalogTool[] = [];
  const skipped: SkippedTool[] = [];
  const offered = new Set(connection.tools.map((tool) => tool.name));
  for (const approval of context.policy.tools) {
    if (!offered.has(approval.name)) skipped.push({ tool: approval.name, reason: "not offered by the vendor" });
  }
  for (const upstream of connection.tools) {
    const policy = context.policy.tools.find((entry) => entry.name === upstream.name);
    if (!policy) continue;
    if (JSON.stringify(upstream.inputSchema).length > 32_768) throw new Error("MCP schema exceeded limit");
    const flattened = flattenSchema(upstream.inputSchema);
    if ("unsupported" in flattened) { skipped.push({ tool: upstream.name, reason: flattened.unsupported }); continue; }
    const schema = flattened.schema;
    if (schema.type !== "object" || !isObject(schema.properties) || schema.anyOf || schema.oneOf || schema.patternProperties) {
      skipped.push({ tool: upstream.name, reason: "schema is not a plain object" });
      continue;
    }
    const properties = schema.properties;
    const required = Array.isArray(schema.required) ? schema.required as string[] : [];
    const unbindable = connector.binder.properties.find((name) => {
      const property = properties[name];
      return !(isObject(property) && property.type === "string" && required.includes(name));
    });
    if (unbindable !== undefined) { skipped.push({ tool: upstream.name, reason: `missing server-bound property ${unbindable}` }); continue; }
    for (const name of connector.binder.properties) delete properties[name];
    schema.required = required.filter((name) => !connector.binder.properties.includes(name));
    if (policy.allowedArguments) {
      const outside = (schema.required as string[]).filter((name) => !policy.allowedArguments!.includes(name));
      if (outside.length) { skipped.push({ tool: upstream.name, reason: `requires arguments outside allowedArguments: ${outside.join(", ")}` }); continue; }
      for (const name of Object.keys(properties)) if (!policy.allowedArguments.includes(name)) delete properties[name];
    }
    let incompatible: string | undefined;
    for (const [name, values] of Object.entries(policy.argumentValues ?? {})) {
      const property = properties[name];
      if (!isObject(property)) { incompatible = name; break; }
      const upstreamEnum = Array.isArray(property.enum) ? property.enum : undefined;
      const permitted = upstreamEnum ? values.filter((value) => upstreamEnum.includes(value)) : values;
      if (!permitted.length) { incompatible = name; break; }
      properties[name] = { ...property, enum: permitted };
      if (!(schema.required as string[]).includes(name)) (schema.required as string[]).push(name);
    }
    if (incompatible !== undefined) { skipped.push({ tool: upstream.name, reason: `argumentValues do not match ${incompatible}` }); continue; }
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
  return { tools, skipped };
}

export function approveTools<Scope>(
  connection: Pick<McpConnection, "tools">,
  connector: Pick<ConnectorDefinition<Scope>, "binder">,
  context: ConnectorContext<Scope>,
): CatalogTool[] {
  return reviewTools(connection, connector, context).tools;
}
```

In `discoverTools`, change the return type to `Promise<{ tools: CatalogTool[]; skipped: SkippedTool[] }>`
and its success line to `return reviewTools(connection, connector, context);`.

- [ ] **Step 8: Run the gateway and GitHub suites**

Run: `npm run build && npx vitest run tests/contract/gateway-engine.test.ts tests/contract/gateway-schema.test.ts tests/contract/gateway-github.test.ts tests/contract/github-mcp.test.ts tests/contract/github-mcp-broker.test.ts`
Expected: PASS (gateway-engine now 10 tests).

- [ ] **Step 9: Commit**

```bash
git add packages/gateway tests/contract/gateway-schema.test.ts tests/contract/gateway-engine.test.ts
git commit -m "feat(gateway): flatten vendor schemas and report tools it cannot offer"
```

---

### Task 3: Generic connector ledger

**Files:**
- Create: `packages/broker/src/aws/connector-ledger.ts`
- Delete: `packages/broker/src/aws/github-mcp.ts`
- Modify: `packages/broker/src/aws/broker.ts:61,338` (import and construction)
- Test: `tests/contract/connector-ledger.test.ts`

**Interfaces:**
- Consumes: `Invocation`, `Ledger` from `@agentx/gateway`.
- Produces:
  - `const GITHUB_LEDGER = { prefix: "GITHUB_MCP#", entityType: "GITHUB_MCP_INVOCATION" }`
  - `function connectorLedgerKeys(connector: string): { prefix: string; entityType: string }` → `CONNECTOR#<connector>#`, `CONNECTOR_INVOCATION`
  - `class DynamoConnectorLedger implements Ledger { constructor(client: DynamoDBDocumentClient, tableName: string, workspaceId: string, keys: { prefix: string; entityType: string }, connector: string) }`

- [ ] **Step 1: Write the failing test**

Create `tests/contract/connector-ledger.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DynamoConnectorLedger, GITHUB_LEDGER, connectorLedgerKeys } from "../../packages/broker/src/aws/connector-ledger.js";
import type { Invocation } from "../../packages/gateway/src/index.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const invocation = (status: Invocation["result"]["status"]): Invocation => ({
  requestId: "0f0e8a52-5a4c-4c1e-9d55-3d1f4f0f6a11", workspaceId: "w1", ownerKey: "owner", repository: "payments", tool: "create_issue",
  fingerprint: "f".repeat(64), createdAt: "2026-09-24T00:00:00.000Z", updatedAt: "2026-09-24T00:00:00.000Z",
  result: { requestId: "0f0e8a52-5a4c-4c1e-9d55-3d1f4f0f6a11", status, text: "", truncated: false, replayed: false },
});

describe("connector ledger", () => {
  it("writes new connectors under CONNECTOR#<name># and claims each request once", async () => {
    const db = new FakeDynamoDb();
    const ledger = new DynamoConnectorLedger(db as never, "state", "w1", connectorLedgerKeys("linear"), "linear");
    expect(await ledger.claim(invocation("IN_PROGRESS"))).toBe(true);
    expect(await ledger.claim(invocation("IN_PROGRESS"))).toBe(false);
    await ledger.finish(invocation("SUCCEEDED"));
    expect(db.get("WORKSPACE#w1", "CONNECTOR#linear#0f0e8a52-5a4c-4c1e-9d55-3d1f4f0f6a11"))
      .toMatchObject({ entityType: "CONNECTOR_INVOCATION", connector: "linear", result: { status: "SUCCEEDED" } });
    expect((await ledger.get(invocation("IN_PROGRESS").requestId))?.result.status).toBe("SUCCEEDED");
  });

  it("keeps the feature 007 key for the github connector", async () => {
    const db = new FakeDynamoDb();
    const ledger = new DynamoConnectorLedger(db as never, "state", "w1", GITHUB_LEDGER, "github");
    await ledger.claim(invocation("IN_PROGRESS"));
    expect(db.get("WORKSPACE#w1", "GITHUB_MCP#0f0e8a52-5a4c-4c1e-9d55-3d1f4f0f6a11"))
      .toMatchObject({ entityType: "GITHUB_MCP_INVOCATION", connector: "github" });
  });

  it("refuses to finish a record that is no longer in progress", async () => {
    const db = new FakeDynamoDb();
    const ledger = new DynamoConnectorLedger(db as never, "state", "w1", connectorLedgerKeys("jira"), "jira");
    await ledger.claim(invocation("IN_PROGRESS"));
    await ledger.finish(invocation("FAILED"));
    await expect(ledger.finish(invocation("SUCCEEDED"))).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/contract/connector-ledger.test.ts`
Expected: FAIL — cannot resolve `packages/broker/src/aws/connector-ledger.js`.

- [ ] **Step 3: Implement the ledger**

Create `packages/broker/src/aws/connector-ledger.ts`:

```ts
import { GetCommand, PutCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { Invocation, Ledger } from "@agentx/gateway";

/** GitHub keeps its feature 007 key, so records written before and during the release stay one record. */
export const GITHUB_LEDGER = { prefix: "GITHUB_MCP#", entityType: "GITHUB_MCP_INVOCATION" } as const;

export function connectorLedgerKeys(connector: string): { prefix: string; entityType: string } {
  return { prefix: `CONNECTOR#${connector}#`, entityType: "CONNECTOR_INVOCATION" };
}

export class DynamoConnectorLedger implements Ledger {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
    private readonly workspaceId: string,
    private readonly keys: { prefix: string; entityType: string },
    private readonly connector: string,
  ) {}

  async claim(record: Invocation): Promise<boolean> {
    try {
      await this.client.send(new PutCommand({
        TableName: this.tableName,
        Item: this.item(record),
        ConditionExpression: "attribute_not_exists(pk)",
      }));
      return true;
    } catch (error) {
      if (error instanceof Error && error.name === "ConditionalCheckFailedException") return false;
      throw error;
    }
  }

  async get(requestId: string): Promise<Invocation | undefined> {
    const response = await this.client.send(new GetCommand({ TableName: this.tableName, Key: this.key(requestId), ConsistentRead: true }));
    return response.Item as Invocation | undefined;
  }

  async finish(record: Invocation): Promise<void> {
    await this.client.send(new PutCommand({
      TableName: this.tableName,
      Item: this.item(record),
      ConditionExpression: "fingerprint = :fingerprint AND ownerKey = :owner AND #result.#status = :pending",
      ExpressionAttributeNames: { "#result": "result", "#status": "status" },
      ExpressionAttributeValues: { ":fingerprint": record.fingerprint, ":owner": record.ownerKey, ":pending": "IN_PROGRESS" },
    }));
  }

  private item(record: Invocation) {
    return { ...this.key(record.requestId), entityType: this.keys.entityType, connector: this.connector, ...record };
  }

  private key(requestId: string) {
    return { pk: `WORKSPACE#${this.workspaceId}`, sk: `${this.keys.prefix}${requestId}` };
  }
}
```

In `packages/broker/src/aws/broker.ts`, replace
`import { DynamoGitHubMcpStore } from "./github-mcp.js";` with
`import { DynamoConnectorLedger, GITHUB_LEDGER } from "./connector-ledger.js";`, and replace
`store: new DynamoGitHubMcpStore(dependencies.documentClient, dependencies.tableName, workspace.id),`
with
`store: new DynamoConnectorLedger(dependencies.documentClient, dependencies.tableName, workspace.id, GITHUB_LEDGER, "github"),`
(Task 4 replaces `"github"` with the resolved connector name.) Then delete the old store:

```bash
git rm packages/broker/src/aws/github-mcp.ts
```

- [ ] **Step 4: Build and run**

Run: `npm run build && npx vitest run tests/contract/connector-ledger.test.ts tests/contract/github-mcp-broker.test.ts tests/contract/slack-control-plane.test.ts`
Expected: PASS; existing tests still find records under `GITHUB_MCP#` with `entityType` `GITHUB_MCP_INVOCATION`.

- [ ] **Step 5: Commit**

```bash
git add packages/broker tests/contract/connector-ledger.test.ts
git commit -m "refactor(broker): write connector invocations through a generic ledger"
```

---

### Task 4: Catalog cache and the broker route on the connector resolver

**Files:**
- Create: `packages/gateway/src/catalog-cache.ts`; modify `packages/gateway/src/index.ts`
- Modify: `packages/broker/src/github-mcp.ts` (export `GitHubMcpCatalog`)
- Modify: `packages/broker/src/aws/broker.ts` (dependencies type, handler factory, GitHub route, `threadIntegrations`)
- Test: `tests/contract/catalog-cache.test.ts`; `tests/contract/slack-control-plane.test.ts` (helper parameter plus two cases)

**Interfaces:**
- Consumes: `githubConnectorOf` (Task 1), `DynamoConnectorLedger`, `GITHUB_LEDGER` (Task 3).
- Produces:
  - `class CatalogCache<T> { constructor(options: { ttlMs: number; maxEntries: number; now?: () => number }); get(key: string): T | undefined; set(key: string, value: T): void; delete(key: string): void }`
  - `type GitHubMcpCatalog = { tools: GitHubMcpTool[] }` from `packages/broker/src/github-mcp.ts`
  - `AwsBrokerDependencies.catalogs?: CatalogCache<GitHubMcpCatalog>`

- [ ] **Step 1: Write the failing cache test**

Create `tests/contract/catalog-cache.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CatalogCache } from "../../packages/gateway/src/index.js";

describe("catalog cache", () => {
  it("returns a value until its time-to-live passes", () => {
    let now = 1_000;
    const cache = new CatalogCache<string>({ ttlMs: 600_000, maxEntries: 4, now: () => now });
    cache.set("a", "catalog");
    now += 599_999;
    expect(cache.get("a")).toBe("catalog");
    now += 1;
    expect(cache.get("a")).toBeUndefined();
  });

  it("evicts the oldest entry at capacity and supports deletion", () => {
    const cache = new CatalogCache<number>({ ttlMs: 60_000, maxEntries: 2 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    cache.delete("b");
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBe(3);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/contract/catalog-cache.test.ts`
Expected: FAIL — `CatalogCache` is not a constructor.

- [ ] **Step 3: Implement the cache**

Create `packages/gateway/src/catalog-cache.ts`:

```ts
/** Discovered catalogs per container. A miss only costs a rediscovery; execution always rechecks the vendor. */
export class CatalogCache<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();
  private readonly now: () => number;

  constructor(private readonly options: { ttlMs: number; maxEntries: number; now?: () => number }) {
    this.now = options.now ?? Date.now;
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    this.entries.delete(key);
    while (this.entries.size >= this.options.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAt: this.now() + this.options.ttlMs });
  }

  delete(key: string): void {
    this.entries.delete(key);
  }
}
```

Add `export * from "./catalog-cache.js";` to `packages/gateway/src/index.ts`.

Run: `npm run build && npx vitest run tests/contract/catalog-cache.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 4: Write the failing route cases**

In `tests/contract/slack-control-plane.test.ts`, change the two helpers so a test can pass its
own `integrations`:

```ts
async function registerProjectAndBind(handler: Handler, integrations: boolean | Record<string, unknown> = false): Promise<void> {
  await registerRevision(handler, 1, integrations);
```

```ts
async function registerRevision(handler: Handler, revision: number, integrations: boolean | Record<string, unknown> = false): Promise<void> {
```

and replace the `...(githubMcp ? { integrations: ... } : {}),` line in `registerRevision` with:

```ts
        ...(integrations === true
          ? { integrations: { githubMcp: { tools: [{ name: "issue_write", access: "write" }, { name: "list_issues", access: "read" }] } } }
          : integrations ? { integrations } : {}),
```

Then add inside `describe("hosted Slack GitHub MCP", ...)`:

```ts
  it("serves a github connector declared in integrations.connectors", async () => {
    const credentials = vi.fn(async () => ({ owner: "example", repo: "demo", token: "installation-secret" }));
    const invoke = vi.fn(async () => ({ content: [{ type: "text", text: "GitHub result" }] }));
    const connect = vi.fn(async () => ({
      tools: [{ name: "list_issues", description: "Native list_issues", inputSchema: {
        type: "object", properties: { owner: { type: "string" }, repo: { type: "string" } }, required: ["owner", "repo"],
      } }], call: invoke, close: async () => undefined,
    }));
    const { db, handler } = createBroker({ githubMcp: { credentials, connect } });
    await registerProjectAndBind(handler, { connectors: [{ name: "github", type: "github", scopes: ["demo"], tools: [{ name: "list_issues", access: "read" }] }] });
    const resolved = await ensureWorkspace(handler, threadOne, pratik);
    expect(resolved.body.githubMcpRepositories).toEqual(["demo"]);
    const workspaceId = resolved.body.workspaceId as string;
    markReady(db, workspaceId);
    const service = { principal: orchestratorPrincipal, thread: threadOne, slackUser: pratik };
    const path = `/v1/service/workspaces/${workspaceId}/github`;
    const catalog = await call(handler, { method: "GET", path: `${path}/tools?repository=demo`, service });
    const tool = GitHubMcpCatalogSchema.parse(catalog.body.catalog).tools[0]!;
    const request = { requestId: randomUUID(), repository: "demo", tool: "list_issues", schemaHash: tool.schemaHash, arguments: {} };
    expect((await call(handler, { method: "POST", path: `${path}/call`, service, body: request })).body.result).toMatchObject({ status: "SUCCEEDED" });
    expect(db.get(`WORKSPACE#${workspaceId}`, `GITHUB_MCP#${request.requestId}`)).toMatchObject({ connector: "github" });
  });

  it("reuses a revision's discovered catalog and rediscovers after a new revision or a failed call", async () => {
    const credentials = vi.fn(async () => ({ owner: "example", repo: "demo", token: "installation-secret" }));
    const invoke = vi.fn(async () => ({ content: [{ type: "text", text: "GitHub result" }] }));
    const connect = vi.fn(async () => ({
      tools: [{ name: "list_issues", description: "Native list_issues", inputSchema: {
        type: "object", properties: { owner: { type: "string" }, repo: { type: "string" } }, required: ["owner", "repo"],
      } }], call: invoke, close: async () => undefined,
    }));
    const { db, handler } = createBroker({ githubMcp: { credentials, connect } });
    const integrations = { connectors: [{ name: "github", type: "github", scopes: "all-repositories", tools: [{ name: "list_issues", access: "read" }] }] };
    await registerProjectAndBind(handler, integrations);
    const workspaceId = (await ensureWorkspace(handler, threadOne, pratik)).body.workspaceId as string;
    markReady(db, workspaceId);
    const service = { principal: orchestratorPrincipal, thread: threadOne, slackUser: pratik };
    const path = `/v1/service/workspaces/${workspaceId}/github`;
    const discover = () => call(handler, { method: "GET", path: `${path}/tools?repository=demo`, service });
    const first = await discover();
    await discover();
    expect(connect).toHaveBeenCalledTimes(1);
    await registerRevision(handler, 2, integrations);
    await discover();
    expect(connect).toHaveBeenCalledTimes(2);
    invoke.mockResolvedValueOnce({ isError: true, content: [{ type: "text", text: "upstream failure" }] } as never);
    const tool = GitHubMcpCatalogSchema.parse(first.body.catalog).tools[0]!;
    const failed = await call(handler, { method: "POST", path: `${path}/call`, service, body: { requestId: randomUUID(), repository: "demo", tool: "list_issues", schemaHash: tool.schemaHash, arguments: {} } });
    expect(failed.body.result).toMatchObject({ status: "FAILED" });
    const callsAfterFailure = connect.mock.calls.length;
    await discover();
    expect(connect).toHaveBeenCalledTimes(callsAfterFailure + 1);
  });
```

- [ ] **Step 5: Run to verify they fail**

Run: `npx vitest run tests/contract/slack-control-plane.test.ts -t "connector|reuses"`
Expected: FAIL — the first case gets 403 ("GitHub MCP is not enabled") because the route only reads
`githubMcp`; the second sees `connect` called twice for two discoveries.

- [ ] **Step 6: Route through the resolver with the cache**

In `packages/broker/src/github-mcp.ts`, add after the `GitHubMcpStore` alias:

```ts
export interface GitHubMcpCatalog { tools: GitHubMcpTool[] }
```

and change `discoverGitHubTools`'s return type to `Promise<GitHubMcpCatalog>`.

In `packages/broker/src/aws/broker.ts`:

1. Add `githubConnectorOf,` to the `@agentx/contracts` import list, add
   `import { CatalogCache } from "@agentx/gateway";`, and change the github-mcp import to
   `import { discoverGitHubTools, executeGitHubTool, type GitHubMcpCatalog, type GitHubMcpDependencies } from "../github-mcp.js";`.
2. In `AwsBrokerDependencies`, after `githubMcp?: GitHubMcpDependencies;`, add
   `catalogs?: CatalogCache<GitHubMcpCatalog>;`.
3. As the first statement of `createAwsBrokerHandler`, add:

```ts
  // One cache per container: discovery per revision, connector and repository costs one vendor round trip.
  dependencies = { ...dependencies, catalogs: dependencies.catalogs ?? new CatalogCache<GitHubMcpCatalog>({ ttlMs: 600_000, maxEntries: 256 }) };
```

4. In `routeWorkspaceRequest`, replace from `const policy = project.definition.integrations?.githubMcp;`
   through `return json({ result }, request.requestId);` with:

```ts
    const github = githubConnectorOf(project.definition);
    if (!github) throw agentXError("FORBIDDEN", "GitHub MCP is not enabled for this project revision");
    if (!dependencies.githubMcp) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub MCP is not configured");
    const parsed = request.method === "POST" ? GitHubMcpRequestSchema.safeParse(body) : undefined;
    if (parsed && !parsed.success) throw agentXError("CONFIG_INVALID", "invalid GitHub MCP request");
    const repositoryName = parsed?.success ? parsed.data.repository : url.searchParams.get("repository");
    const repository = github.repositories.find((entry) => entry.name === repositoryName);
    if (!repository) throw agentXError("NOT_FOUND", "registered repository not found");
    const context = {
      workspaceId: workspace.id,
      ownerKey: identity.ownerKey,
      repository,
      policy: github.policy,
      settingsRevision: project.definition.revision,
      ...requesterOf(identity),
    };
    const cacheKey = JSON.stringify([workspace.projectName, project.definition.revision, github.name, repository.name]);
    if (!parsed?.success) {
      const cached = dependencies.catalogs?.get(cacheKey);
      if (cached) return json({ catalog: cached }, request.requestId);
      const catalog = await discoverGitHubTools(context, dependencies.githubMcp);
      dependencies.catalogs?.set(cacheKey, catalog);
      return json({ catalog }, request.requestId);
    }
    const result = await executeGitHubTool(parsed.data, context, {
      ...dependencies.githubMcp,
      store: new DynamoConnectorLedger(dependencies.documentClient, dependencies.tableName, workspace.id, GITHUB_LEDGER, github.name),
    });
    // A failed call may mean the vendor changed the tool; the next discovery must see the change.
    if (result.status === "FAILED" && !result.replayed) dependencies.catalogs?.delete(cacheKey);
    return json({ result }, request.requestId);
```

5. Replace `threadIntegrations` with:

```ts
function threadIntegrations(project: ProjectDefinition): { githubMcpRepositories?: string[] } {
  const github = githubConnectorOf(project);
  return github ? { githubMcpRepositories: github.repositories.map((repository) => repository.name) } : {};
}
```

- [ ] **Step 7: Build and run the broker suites**

Run: `npm run build && npx vitest run tests/contract/slack-control-plane.test.ts tests/contract/github-mcp-broker.test.ts tests/contract/catalog-cache.test.ts tests/integration/hosted-slack-mcp.test.ts`
Expected: PASS, including the two new cases and every existing case.

- [ ] **Step 8: Commit**

```bash
git add packages/gateway packages/broker tests/contract/catalog-cache.test.ts tests/contract/slack-control-plane.test.ts
git commit -m "feat(broker): serve GitHub from integrations.connectors and cache discovered catalogs"
```

---

### Task 5: Documentation, verification and pull request

**Files:**
- Modify: `specs/013-connector-gateway/spec.md` (FR-008, FR-009, FR-031; Decisions), `data-model.md`,
  `contracts/project-config.md`, `tasks.md`; `specs/007-github-mcp/quickstart.md`; `README.md`
  ("GitHub MCP through hosted Slack")

- [ ] **Step 1: Record the amendments**

- `spec.md` FR-031 becomes: "The GitHub connector MUST keep writing feature 007 ledger records under
  `GITHUB_MCP#<requestId>`; other connector types write `CONNECTOR#<name>#<requestId>`."
- `spec.md` FR-008 appends: "The cache is held in memory per broker container and a failed call
  invalidates its entry."
- `spec.md` FR-009 appends: "A `github` connector has no `credentialRef`; it uses each scoped
  repository's GitHub App reference, and its scopes are `all-repositories` or repository names."
- `spec.md` Decisions gains "**Connector routes and workspace-resolution fields ship with the
  presentation in phase 2**, their only consumer. Decided 2026-09-24."
- `data-model.md`: Catalog entry section says "in memory per broker container, 10-minute TTL, at most
  256 entries"; Invocation section states the GitHub key exception; Connector section drops
  `credentialRef` for `github` and documents the repository-name scopes.
- `contracts/project-config.md`: the `github` example drops `credentialRef`, and the registration
  table gains "Connector type other than `github` (until phases 5–6) | Refused".
- `tasks.md`: move T007 and T011 under Phase 2; check T006, T008, T009, T010.
- `specs/007-github-mcp/quickstart.md` step 2 and `README.md` show the equivalent
  `integrations.connectors` form beside `githubMcp`, and say a definition may use one, not both.

- [ ] **Step 2: Full verification**

```bash
npm run clean && npm ci && npm run typecheck && npm run lint && npm test && npm run infra:synth
```

Expected: all pass; tests = 286 + 6 (connector-config) + 5 (gateway-schema) + 1 (gateway-engine) +
3 (connector-ledger) + 2 (catalog-cache) + 2 (slack-control-plane) = 305.

- [ ] **Step 3: Commit, review and open the pull request**

```bash
git add specs README.md
git commit -m "docs(spec): record phase 1b of the connector gateway"
```

After the whole-branch review and its fix pass, push `feat/013-phase-1b-connectors` and open
`feat(gateway): connector configuration, schema flattening and catalog cache (013 phase 1b)`
against `mainline`, with a body stating the five amendments, the worker-image rebuild, and the
verification output.
