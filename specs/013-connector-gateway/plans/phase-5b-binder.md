# Phase 5b: Shared Binder Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one gateway binder bind a property on every tool (GitHub `owner`/`repo`, Jira
`cloudId`) or only on the tools that have it (Linear `team`/`teamId`, Jira `projectKey`), give
guards the call's scope, and let a guard rewrite the model's arguments (Jira's JQL), once, before
phases 5 and 6. Phases 5 and 6 add no gateway code. GitHub behaviour and
schema hashes stay byte-identical.

**Architecture:** `Binder` keeps `properties` exactly as it is (required on every approved tool) and
gains an optional `optionalProperties` list. A new gateway module `binding.ts` owns schema removal and the
list of server-controlled names. `reviewTools` records, per offered tool, which bound properties a
call on it sends; `executeTool` sends only those, refuses a model-supplied value for any declared
name, and refuses a call whose when-present value is missing. `Guard` gains an optional synchronous
`rewrite` that returns narrowed model arguments; bound values are applied after it and it cannot
set them. `GuardInput` gains `scope`, so a guard knows the team or project even on a tool whose
schema has no bound property.

**Tech Stack:** TypeScript 5.9 strict, Node 22.19–22.x, Vitest 5, MCP SDK 1.30.1 (AJV validator).

**Spec:** [../spec.md](../spec.md): FR-005 (binders), FR-002 (execution semantics), SC-002 (a new
type needs only a provider, an optional binder and guard, fixtures and a guide), SC-001 (feature 007
tests unchanged). It argues from [../plan.md](../plan.md) ("Project Structure": `types.ts`,
`engine.ts`). Its predecessor is [phase-5a-generic-connectors.md](phase-5a-generic-connectors.md).

**Branch:** `feat/013-phase-5b-binder`, cut from mainline after PR #40 merged phase 5a
(`feat/013-generic-connectors`). Phases 5 (Linear) and 6 (Jira) branch from this one.

**Verified:** Every code block in this plan was applied to a scratch copy of
`feat/013-generic-connectors` at `ad05989`. With all five tasks applied, `npm run typecheck`,
`npm run lint` and `npm test` pass (71 files, 540 tests), and every existing test passes unchanged.

## Global Constraints

- **No regressions.** Every existing test passes with its assertions unchanged. The only edits to
  existing test files are the `trackerBroker`/`seedTracker` helper parameters in
  `tests/contract/generic-connector-routes.test.ts` (Task 5); no existing `expect` changes.
- **GitHub byte-identical.** The GitHub golden test in `tests/contract/slack-control-plane.test.ts`
  (catalog, the four schema hashes, the whole ledger record) stays green without edits. The skip
  reason `missing server-bound property <name>` keeps its exact text for `properties`.
- **The schema-hash line does not change.** `fingerprint({ upstream, policy, repository: context.scope })`
  in `engine.ts` is not edited.
- **FR-002 order.** Bound arguments are injected after validation against the narrowed schema; the
  final arguments are validated against the vendor's own schema before any call; writes are claimed
  before execution; the ledger fingerprints the model's own arguments.
- **No vendor code.** No Linear or Jira connector type, endpoint or setup guide ships in 5b. Vendor
  names appear only in test fixtures and test scopes.
- **Test imports.** Tests that drive broker code import gateway classes from `@agentx/gateway`.
  Gateway-only tests import `packages/gateway/src`.
- **Node and build.** Node `>=22.19.0 <23`, with `npm run build` before `npm test`. Node 22:
  `export PATH=/private/tmp/claude-501/node-v22.20.0-darwin-arm64/bin:$PATH`.
- **Commits.** Messages are `type(scope): summary`, ending with
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- **Docs style.** Plain, short sentences. No em-dashes in prose.
- **Fix before the PR.** Fix cheap review findings and anything that fails silently before the PR.

## Review Focus

1. **A model supplies a bound name on a tool that does not have it**, such as `teamId` on Linear's
   `get_issue`. Expected: refused with `routing arguments are server controlled`, before any vendor
   connection. Test: Task 3, "refuses a model-supplied when-present property ...".
2. **A scope has no value for a when-present property the tool has**, for example a Linear scope
   saved without its team. Expected: the call is refused with an administrator-facing reason and
   never sent unrestricted; tools without the property still work. Test: Task 3, "fails closed ...".
3. **The vendor types a bound property as something other than a plain string**, such as
   `anyOf: [string, null]`, or lists it only in `required`. Expected: that tool is skipped with a
   reason registration preflight shows, never offered without its binding. Test: Task 2, "skips a
   tool whose when-present property is not a plain string ...".
4. **The vendor adds `team` to a tool while a thread is open.** Expected: the tool's schema hash
   changes, so an older request fails as `schema_changed` instead of going out unbound. Test:
   Task 2, "changes the schema hash when the vendor adds a when-present property ...".
5. **A rewritten write is retried with the same request ID.** Expected: the ledger replays the
   stored result by the model's own arguments; the guard does not run again and the vendor is not
   called again. Test: Task 4, "replays a rewritten write from the ledger ...".

## File Structure

| File | Responsibility |
|---|---|
| `packages/gateway/src/types.ts` | `Binder.optionalProperties`, `GuardInput.scope`, `RewriteInput`, `Guard.rewrite` |
| `packages/gateway/src/binding.ts` (new) | `boundNames`, `removeBoundProperties`: which names the server controls, and their removal from a flattened schema |
| `packages/gateway/src/engine.ts` | `reviewTools` delegates to an internal `review` that keeps per-tool bound names; `executeTool` injects only those, refuses missing values, applies `rewrite`, passes `scope` to guards |
| `packages/gateway/src/index.ts` | Exports `binding.ts` |
| `tests/fixtures/vendors/linear-tools.json` (new) | Six real Linear tools, verbatim |
| `tests/fixtures/vendors/jira-tools.json` (new) | Six real Atlassian tools, verbatim |
| `tests/support/vendor-fixtures.ts` (new) | `vendorTools(vendor)`: loads a fixture as `McpConnection["tools"]` |
| `tests/contract/gateway-binding.test.ts` (new) | GitHub characterization, when-present discovery and calls, guard scope, rewrite |
| `tests/support/tracker-connector.ts` | Optional per-scope `boardId`, bound when present |
| `tests/contract/generic-connector-routes.test.ts` | Helper parameters; one new end-to-end test |
| `README.md`, `specs/013-connector-gateway/plan.md`, `tasks.md` | Binder modes; phase 5b row; T040 |

## Pre-decided Rulings

- **R1. Binder API: keep `properties` (strict), add `optionalProperties?: readonly string[]`
  (bind only where the tool declares it).** This is the Linear plan's name; the Jira plan's
  `properties: (string | { name; when: "present" })[]` is renamed to it. A mixed-element
  `properties` would change the type every binder, the engine and three test fixtures read, next to
  the golden test. Two lists keep every existing binder valid with no edit. Cost if wrong: a third
  policy later (say "optional on every tool") is one more optional field; nothing migrates.
- **R2. "The tool has it" means the flattened schema lists it in `properties` or in `required`.** A
  present when-present property must be `type: "string"`; otherwise the tool is skipped with
  `server-bound property <name> is not a string`. A name in both lists is treated as `properties`.
  Cost if wrong: a vendor that types `team` as `anyOf: [string, null]` has that tool skipped, and
  the connector phase widens the check with a test.
- **R3. A call sends exactly the declared bound properties its tool has. Guards see the whole
  `bind()` result as `bound`, and the call's scope as `scope: unknown` (set to `context.scope`).**
  Jira's search guard and Linear's comment and get guards need the project or team although those
  tools have no such property. A key `bind()` returns that is not declared is no longer sent. No current binder
  returns one (GitHub returns `owner`/`repo`, the tracker `siteId`). Cost if wrong: a future binder
  that relied on sending an undeclared key must declare it.
- **R4. A missing or empty when-present value fails closed.** The call returns FAILED
  `policy_denied`, text `<label> has no server-bound value for <name>. An administrator must fix the
  connector configuration.`, before the vendor is called. Required `properties` keep today's path:
  the vendor schema requires them, so a missing one already fails upstream validation. Cost if
  wrong: one extra failure text; the alternative is Linear `list_issues` across every team.
- **R5. The refusal covers every declared name on every tool.** A model-supplied `team` is refused
  on `get_issue` too, with the existing FORBIDDEN text. Cost if wrong: none; such a tool's narrowed
  schema already has `additionalProperties: false`.
- **R6. Schema hashes do not change, for GitHub or anyone.** The hash is
  `fingerprint({ upstream, policy, repository: scope })` and never included the binder, so GitHub
  hashes are byte-identical by construction; Task 1 and the golden test pin them. Changing a
  binder's lists does not change hashes. That is safe because execution recomputes the narrowed
  schema and the refusal on the call's own connection. A vendor adding `team` to a tool changes the
  hash, because the vendor tool is hashed. Cost if wrong: putting the binder in the hash later
  would change every GitHub hash and fail every in-flight call with `schema_changed`.
- **R7. The `Guard.rewrite` hook lands in 5b, not phase 6.** It changes the order of
  `executeTool`, which FR-002 pins: rewrite, then bound values merged, upstream validation,
  attribution and checks.
  Doing it once, with the GitHub regressions proven, keeps `engine.ts` out of both connector PRs
  (SC-002) and keeps phases 5 and 6 parallel (`tasks.md`: "Phases 5 and 6 can run in parallel").
  Phase 6 writes only its JQL guard (`project = "KEY" AND (<model JQL>)`), including `ORDER BY`
  handling. The spec makes the vendor-side credential the access boundary; `rewrite` makes a scope
  mean what it says when one credential spans several projects. Cost if wrong: about 25 unused lines if phase 6 decides against JQL
  narrowing; it deletes them.
- **R8. `rewrite` is synchronous and pure; it has no connection.** A lookup against the vendor
  belongs in `check`, which already runs on the call's connection. Cost if wrong: making it async
  later is one call site.
- **R9. `rewrite` cannot touch routing.** Output that sets any declared bound name, in either mode,
  is refused (`<label> guard set a server-controlled argument.`, `policy_denied`); bound values are
  applied after it; its output is validated against the vendor's schema; the ledger fingerprints
  the model's own arguments. Attribution signs a long-text key only if the model supplied that key,
  using the rewritten value; a key a rewrite added is never signed, and bound values never are. Cost if
  wrong: none for GitHub, which has no `rewrite`.
- **R10. Fixtures are verbatim vendor entries, trimmed by tool.** They live at
  `tests/fixtures/vendors/{linear,jira}-tools.json`. Phases 5 and 6 may add tools; they must not
  remove or edit these six. Cost if wrong: a vendor schema change is re-recorded in one file.
- **R11. Linear uses two names for the team: `team` (name or ID) and `teamId` (ID).** `teamId` is on
  `list_documents`, `list_cycles` (required), `create_issue_label`, `save_issue_label` and
  `save_project_label`. Phase 5's binder should declare `optionalProperties: ["team", "teamId"]` and bind
  the team UUID to both, as 5b's tests do. Cost if wrong: binding only `team` leaves `teamId` in the
  model's schema, so those tools read or write across teams.
- **R12. The tracker test type gains an optional per-scope `boardId`, bound when present.** It
  proves SC-002 through the unchanged broker routes. Existing tracker tests do not use `boardId`
  and are unaffected. Cost if wrong: none; test-only code.
- **R13. Out of scope for 5b:** Linear `save_issue` updates by `id` and `get_issue` on another
  team's issue; Jira issue keys from another project. These are check-only guards in phases 5 and
  6, using the existing `Guard.check` and `requiredTools`.

---

### Task 1: Vendor fixtures and a GitHub characterization test

Pins GitHub's discovery output, schema hashes, skip reasons and call arguments before the binder
changes. It passes on the unchanged code.

**Files:**
- Create: `tests/fixtures/vendors/linear-tools.json`, `tests/fixtures/vendors/jira-tools.json`,
  `tests/support/vendor-fixtures.ts`, `tests/contract/gateway-binding.test.ts`

**Interfaces:**
- Consumes: `reviewTools`, `approveTools`, `executeTool`, `githubBinder` from
  `packages/gateway/src/index.js` (unchanged).
- Produces: `vendorTools(vendor: "linear" | "jira"): McpConnection["tools"]` in
  `tests/support/vendor-fixtures.ts`; `memoryLedger(): Ledger` and `ok: McpToolResult` at the top
  of `tests/contract/gateway-binding.test.ts`, used by Tasks 2–4.

- [ ] **Step 1: Create the trimmed fixtures**

The source files are the real `tools/list` output recorded on 2026-09-24. Keep these tools, in
this order, with every field verbatim:

- Linear: `list_issues` (optional `team`), `save_issue` (optional `team`, property-level `anyOf`),
  `list_issue_statuses` (required `team`), `list_documents` (optional `teamId`), `get_issue` (no
  team), `save_comment` (no team; `body` is the long-text field).
- Jira: `getJiraIssue`, `searchJiraIssuesUsingJql` (no `projectKey`), `createJiraIssue` (required
  `projectKey`), `addOrEditJiraIssueComment`, `executeRead` (optional `cloudId`),
  `atlassianUserInfo` (no `cloudId`).

```bash
export PATH=/private/tmp/claude-501/node-v22.20.0-darwin-arm64/bin:$PATH
SRC=/private/tmp/claude-501/-Users-abhishekgarg-web/ffaf1996-7c19-4dcc-8463-6c9e6e330dfc/scratchpad/plans
mkdir -p tests/fixtures/vendors
node -e '
const fs = require("fs");
const trim = (src, keep, out) => {
  const all = JSON.parse(fs.readFileSync(src, "utf8"));
  const kept = keep.map((name) => { const tool = all.find((entry) => entry.name === name); if (!tool) throw new Error(name); return tool; });
  fs.writeFileSync(out, JSON.stringify(kept, null, 2) + "\n");
};
trim(process.argv[1] + "/linear-tools.json", ["list_issues", "save_issue", "list_issue_statuses", "list_documents", "get_issue", "save_comment"], "tests/fixtures/vendors/linear-tools.json");
trim(process.argv[1] + "/jira-tools.json", ["getJiraIssue", "searchJiraIssuesUsingJql", "createJiraIssue", "addOrEditJiraIssueComment", "executeRead", "atlassianUserInfo"], "tests/fixtures/vendors/jira-tools.json");
' "$SRC"
```

Expected: two files, about 27.5 KB (Linear) and 23.7 KB (Jira). If the source folder is gone,
re-record with `tools/list` against `https://mcp.linear.app/mcp` and
`https://mcp.atlassian.com/v2/mcp` and keep the same tools.

- [ ] **Step 2: Write the fixture loader**

```ts
// tests/support/vendor-fixtures.ts
// Real vendor tools/list output, trimmed to the tools the binding tests need.
// Recorded 2026-09-24 from https://mcp.linear.app/mcp and https://mcp.atlassian.com/v2/mcp.
import { readFileSync } from "node:fs";
import type { McpConnection } from "../../packages/gateway/src/index.js";

export type VendorFixture = "linear" | "jira";

/** The tools a vendor offered, in its order, shaped as an MCP connection lists them. */
export function vendorTools(vendor: VendorFixture): McpConnection["tools"] {
  const raw = JSON.parse(readFileSync(new URL(`../fixtures/vendors/${vendor}-tools.json`, import.meta.url), "utf8")) as Array<{
    name: string; description?: string; inputSchema: Record<string, unknown>;
  }>;
  return raw.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}
```

- [ ] **Step 3: Write the characterization test**

The hashes below were recorded from the phase 5a code. `search_issues` pins that an *optional*
`owner` still skips a GitHub tool.

```ts
// tests/contract/gateway-binding.test.ts
import { describe, expect, it, vi } from "vitest";
import {
  approveTools,
  executeTool,
  githubBinder,
  reviewTools,
  type ConnectorContext,
  type ConnectorDefinition,
  type GitHubRepositoryScope,
  type Invocation,
  type Ledger,
  type McpConnection,
  type McpToolResult,
  type connectMcp,
} from "../../packages/gateway/src/index.js";

function memoryLedger(): Ledger {
  const records = new Map<string, Invocation>();
  return {
    claim: async (record) => { if (records.has(record.requestId)) return false; records.set(record.requestId, structuredClone(record)); return true; },
    get: async (id) => records.get(id),
    finish: async (record) => { records.set(record.requestId, structuredClone(record)); },
  };
}

const ok: McpToolResult = { content: [{ type: "text", text: "{\"ok\":true}" }] };

describe("GitHub binding stays byte-identical", () => {
  const tools: McpConnection["tools"] = [
    { name: "list_issues", description: "List issues in a repository", inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, state: { type: "string", enum: ["open", "closed", "all"] }, perPage: { type: "number" } }, required: ["owner", "repo"] } },
    { name: "issue_write", description: "Create or update an issue", inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, title: { type: "string" }, body: { type: "string" } }, required: ["owner", "repo", "title"] } },
    { name: "search_issues", description: "Search issues", inputSchema: { type: "object", properties: { query: { type: "string" }, owner: { type: "string" } }, required: ["query"] } },
    { name: "get_me", description: "Who am I", inputSchema: { type: "object", properties: {} } },
  ];
  const scope: GitHubRepositoryScope = { name: "demo", url: "https://github.com/example/demo.git", credentialRef: "github-app" };
  const context: ConnectorContext<GitHubRepositoryScope> = {
    workspaceId: "w", ownerKey: "o", scopeAlias: "demo", scope,
    policy: { tools: [
      { name: "list_issues", access: "read", argumentValues: { state: ["open", "closed"] } },
      { name: "issue_write", access: "write", allowedArguments: ["title", "body"] },
      { name: "search_issues", access: "read" },
      { name: "get_me", access: "read" },
    ] },
  };

  it("removes owner and repo, skips a tool that lacks either or has it optional, with the same reason text and hashes", () => {
    // Recorded from the phase 5a code before the binder changed (feature 013, phase 5b).
    expect(reviewTools({ tools }, { binder: githubBinder }, context)).toEqual({
      tools: [
        {
          name: "list_issues", scope: "demo", description: "List issues in a repository",
          inputSchema: { type: "object", properties: { state: { type: "string", enum: ["open", "closed"] }, perPage: { type: "number" } }, required: ["state"], additionalProperties: false },
          schemaHash: "43f2c9dcac73ccee04c89f461ce122d302b978a4be99eb1011684950d5db9daa", access: "read",
        },
        {
          name: "issue_write", scope: "demo", description: "Create or update an issue",
          inputSchema: { type: "object", properties: { title: { type: "string" }, body: { type: "string" } }, required: ["title"], additionalProperties: false },
          schemaHash: "f93da683b3799b4e0269da48af6ff98090670b5880c363fa87c28d40bc8b26cf", access: "write",
        },
      ],
      skipped: [
        { tool: "search_issues", reason: "missing server-bound property owner" },
        { tool: "get_me", reason: "missing server-bound property owner" },
      ],
    });
  });

  it("sends exactly the model's arguments plus owner and repo, and refuses a model-supplied owner", async () => {
    const call = vi.fn<(name: string, args: Record<string, unknown>) => Promise<McpToolResult>>(async () => ok);
    const connect = vi.fn<typeof connectMcp>(async () => ({ tools, call, close: async () => undefined }));
    const connector: ConnectorDefinition<GitHubRepositoryScope> = {
      label: "GitHub", endpoint: new URL("https://api.githubcopilot.com/mcp/"), permissionsHint: "GitHub App issue permissions",
      credentials: { issue: async () => ({ token: "installation-secret", bindings: { owner: "example", repo: "demo" } }) },
      binder: githubBinder, guards: [],
    };
    const schemaHash = approveTools({ tools }, connector, context).find((tool) => tool.name === "issue_write")!.schemaHash;
    const request = { requestId: "r-1", scope: "demo", tool: "issue_write", schemaHash, arguments: { title: "Bug" } };
    expect(await executeTool(request, connector, context, { connect, ledger: memoryLedger() })).toMatchObject({ status: "SUCCEEDED" });
    expect(call).toHaveBeenCalledExactlyOnceWith("issue_write", { title: "Bug", owner: "example", repo: "demo" });
    await expect(executeTool({ ...request, requestId: "r-2", arguments: { title: "Bug", owner: "other" } }, connector, context, { connect, ledger: memoryLedger() }))
      .rejects.toThrow(/GitHub routing arguments are server controlled/);
  });
});
```

- [ ] **Step 4: Run it; it passes on the unchanged code**

Run: `npm run build && npx vitest run tests/contract/gateway-binding.test.ts`
Expected: PASS, 2 tests. This is a characterization test. If a hash differs, stop: the branch is
not at the phase 5a head this plan was written against.

- [ ] **Step 5: Commit**

```bash
git add tests/fixtures/vendors tests/support/vendor-fixtures.ts tests/contract/gateway-binding.test.ts
git commit -m "test(gateway): record Linear and Jira fixtures and pin GitHub binding

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Discovery binds when-present properties

**Files:**
- Create: `packages/gateway/src/binding.ts`
- Modify: `packages/gateway/src/types.ts` (`Binder`), `packages/gateway/src/engine.ts`
  (`reviewTools`, lines 22–85 today), `packages/gateway/src/index.ts`
- Test: `tests/contract/gateway-binding.test.ts`

**Interfaces:**
- Consumes: `vendorTools`, `memoryLedger` from Task 1.
- Produces:

```ts
// types.ts
export interface Binder<Scope> {
  readonly properties: readonly string[];
  readonly optionalProperties?: readonly string[] | undefined;
  bind(scope: Scope, credential: IssuedCredential): Record<string, unknown>;
}
// binding.ts
export function boundNames(binder: Pick<Binder<unknown>, "properties" | "optionalProperties">): string[];
export function removeBoundProperties(schema: Record<string, unknown>, binder: Pick<Binder<unknown>, "properties" | "optionalProperties">): { bound: string[] } | { unbindable: string };
// engine.ts (internal, not exported)
function review<Scope>(connection, connector, context): { tools: Array<{ tool: CatalogTool; bound: string[] }>; skipped: SkippedTool[] };
```

In the test file, Task 2 also produces `LinearScope`, `JiraScope`, `linearScope`, `jiraScope`,
`linearBinder`, `jiraBinder`, `contextFor`, `propertiesOf`, `LINEAR_TOOLS` and `JIRA_TOOLS`, used by
Tasks 3 and 4.

- [ ] **Step 1: Write the failing tests**

Add `type Binder,` to the gateway import list (keep it sorted with the other `type` imports), and
add below the gateway import:

```ts
import { vendorTools } from "../support/vendor-fixtures.js";
```

Append to `tests/contract/gateway-binding.test.ts`:

```ts
interface LinearScope { alias: string; teamId: string }
interface JiraScope { alias: string; cloudId: string; projectKey: string }

const linearScope: LinearScope = { alias: "charterarc", teamId: "c408e946-78aa-4db8-923e-f78053dd954f" };
const jiraScope: JiraScope = { alias: "kan", cloudId: "1437bb04-4c88-4efd-9d38-658e8febfeba", projectKey: "KAN" };
const linearBinder: Binder<LinearScope> = { properties: [], optionalProperties: ["team", "teamId"], bind: (scope) => ({ team: scope.teamId, teamId: scope.teamId }) };
const jiraBinder: Binder<JiraScope> = { properties: ["cloudId"], optionalProperties: ["projectKey"], bind: (scope) => ({ cloudId: scope.cloudId, projectKey: scope.projectKey }) };

function contextFor<Scope extends { alias: string }>(scope: Scope, names: readonly string[], write: readonly string[] = []): ConnectorContext<Scope> {
  return {
    workspaceId: "w", ownerKey: "o", scopeAlias: scope.alias, scope,
    policy: { tools: names.map((name) => ({ name, access: write.includes(name) ? "write" as const : "read" as const })) },
  };
}

const propertiesOf = (tool: { inputSchema: Record<string, unknown> } | undefined) => Object.keys(tool!.inputSchema.properties as Record<string, unknown>);
const LINEAR_TOOLS = ["list_issues", "save_issue", "list_issue_statuses", "list_documents", "get_issue", "save_comment"];
const JIRA_TOOLS = ["getJiraIssue", "searchJiraIssuesUsingJql", "createJiraIssue", "addOrEditJiraIssueComment", "executeRead", "atlassianUserInfo"];

describe("when-present binding over real Linear tools", () => {
  const tools = vendorTools("linear");
  const review = reviewTools({ tools }, { binder: linearBinder }, contextFor(linearScope, LINEAR_TOOLS, ["save_issue", "save_comment"]));

  it("offers every approved tool, with or without a team property", () => {
    expect(review.tools.map((tool) => tool.name)).toEqual(LINEAR_TOOLS);
    expect(review.skipped).toEqual([]);
  });

  it("removes an optional team, a required team and a teamId, and leaves every other property", () => {
    const byName = (name: string) => review.tools.find((tool) => tool.name === name);
    for (const name of LINEAR_TOOLS) {
      expect(propertiesOf(byName(name))).not.toContain("team");
      expect(propertiesOf(byName(name))).not.toContain("teamId");
    }
    const upstream = (name: string) => Object.keys(tools.find((tool) => tool.name === name)!.inputSchema.properties as Record<string, unknown>);
    expect(propertiesOf(byName("list_issues"))).toEqual(upstream("list_issues").filter((name) => name !== "team"));
    expect(propertiesOf(byName("list_documents"))).toEqual(upstream("list_documents").filter((name) => name !== "teamId"));
    expect(propertiesOf(byName("get_issue"))).toEqual(upstream("get_issue"));
    expect(byName("list_issue_statuses")!.inputSchema).toEqual({ type: "object", properties: {}, required: [], $schema: "https://json-schema.org/draft/2020-12/schema", additionalProperties: false });
    expect(byName("save_comment")!.inputSchema.required).toEqual(["body"]);
  });

  it("keeps a property-level anyOf on save_issue", () => {
    const properties = review.tools.find((tool) => tool.name === "save_issue")!.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(properties.slaBreachesAt!.anyOf).toBeDefined();
  });
});

describe("required and when-present binding over real Jira tools", () => {
  const tools = vendorTools("jira");
  const review = reviewTools({ tools }, { binder: jiraBinder }, contextFor(jiraScope, JIRA_TOOLS, ["createJiraIssue", "addOrEditJiraIssueComment"]));

  it("binds cloudId on every tool and projectKey only where the tool has it", () => {
    expect(review.tools.map((tool) => tool.name)).toEqual(["getJiraIssue", "searchJiraIssuesUsingJql", "createJiraIssue", "addOrEditJiraIssueComment"]);
    const byName = (name: string) => review.tools.find((tool) => tool.name === name)!;
    expect(byName("createJiraIssue").inputSchema.required).toEqual(["summary", "issueType"]);
    expect(propertiesOf(byName("createJiraIssue"))).not.toContain("projectKey");
    expect(byName("searchJiraIssuesUsingJql").inputSchema.required).toEqual(["jql"]);
    for (const tool of review.tools) expect(propertiesOf(tool)).not.toContain("cloudId");
  });

  it("still skips a tool whose cloudId is optional or absent, with the existing reason", () => {
    expect(review.skipped).toEqual([
      { tool: "executeRead", reason: "missing server-bound property cloudId" },
      { tool: "atlassianUserInfo", reason: "missing server-bound property cloudId" },
    ]);
  });
});

describe("when-present properties the gateway cannot bind", () => {
  it("skips a tool whose when-present property is not a plain string, or is required but undefined", () => {
    const tools: McpConnection["tools"] = [
      { name: "typed", inputSchema: { type: "object", properties: { team: { type: "number" } } } },
      { name: "nullable", inputSchema: { type: "object", properties: { team: { anyOf: [{ type: "string" }, { type: "null" }] } } } },
      { name: "dangling", inputSchema: { type: "object", properties: {}, required: ["team"] } },
      { name: "plain", inputSchema: { type: "object", properties: { team: { type: "string" }, q: { type: "string" } } } },
    ];
    const review = reviewTools({ tools }, { binder: linearBinder }, contextFor(linearScope, ["typed", "nullable", "dangling", "plain"]));
    expect(review.tools.map((tool) => tool.name)).toEqual(["plain"]);
    expect(review.skipped).toEqual([
      { tool: "typed", reason: "server-bound property team is not a string" },
      { tool: "nullable", reason: "server-bound property team is not a string" },
      { tool: "dangling", reason: "server-bound property team is not a string" },
    ]);
  });

  it("changes the schema hash when the vendor adds a when-present property to a tool, so an older request is refused as schema_changed", () => {
    const before: McpConnection["tools"] = [{ name: "plain", inputSchema: { type: "object", properties: { q: { type: "string" } } } }];
    const after: McpConnection["tools"] = [{ name: "plain", inputSchema: { type: "object", properties: { q: { type: "string" }, team: { type: "string" } } } }];
    const context = contextFor(linearScope, ["plain"]);
    const old = reviewTools({ tools: before }, { binder: linearBinder }, context).tools[0]!;
    const now = reviewTools({ tools: after }, { binder: linearBinder }, context).tools[0]!;
    expect(now.inputSchema).toEqual(old.inputSchema);
    expect(now.schemaHash).not.toBe(old.schemaHash);
  });

  it("does not let a binding change the schema hash, which depends only on the vendor tool, the policy and the scope", () => {
    const tools: McpConnection["tools"] = [{ name: "plain", inputSchema: { type: "object", properties: { team: { type: "string" }, q: { type: "string" } } } }];
    const context = contextFor(linearScope, ["plain"]);
    const bound = reviewTools({ tools }, { binder: linearBinder }, context).tools[0]!;
    const unbound = reviewTools({ tools }, { binder: { properties: [], bind: () => ({}) } }, context).tools[0]!;
    expect(bound.schemaHash).toBe(unbound.schemaHash);
    expect(propertiesOf(bound)).toEqual(["q"]);
    expect(propertiesOf(unbound)).toEqual(["team", "q"]);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run tests/contract/gateway-binding.test.ts`
Expected: 5 FAIL ("removes an optional team ...", "binds cloudId on every tool ...", "skips a tool
whose when-present property ...", "changes the schema hash ...", "does not let a binding change
the schema hash ..."), for example `expected [ 'limit', 'cursor', ... ] to not include 'team'`.
Three new tests already pass ("offers every approved tool", "keeps a property-level anyOf", "still
skips a tool whose cloudId is optional"); they pin behaviour that must survive the change.

- [ ] **Step 3: Extend `Binder` in `packages/gateway/src/types.ts`**

Replace the `Binder` interface with:

```ts
export interface Binder<Scope> {
  /**
   * String properties every approved tool must require. They are removed from the model's schema and
   * supplied by the server. A tool without one, or with one optional, is skipped.
   */
  readonly properties: readonly string[];
  /**
   * String properties bound only on the tools that have them, required or optional. They are removed
   * from those tools' schemas and supplied by the server. Tools without them are offered unchanged.
   */
  readonly optionalProperties?: readonly string[] | undefined;
  /**
   * Values for the declared properties. Guards see every value; a call sends only the declared
   * properties its tool has.
   */
  bind(scope: Scope, credential: IssuedCredential): Record<string, unknown>;
}
```

- [ ] **Step 4: Create `packages/gateway/src/binding.ts`**

For `properties`, the check, the deletion and the `required` filter are the current engine lines
moved as they are, so GitHub output cannot change.

```ts
import type { Binder } from "./types.js";
import { isObject } from "./util.js";

type BinderNames = Pick<Binder<unknown>, "properties" | "optionalProperties">;

/** Every property the server controls. A model-supplied value for any of them is refused. */
export function boundNames(binder: BinderNames): string[] {
  return [...new Set([...binder.properties, ...(binder.optionalProperties ?? [])])];
}

/**
 * Removes the server-bound properties from a flattened object schema, in place.
 * Returns the names removed, which are the values a call on this tool sends, or why the tool cannot be offered.
 */
export function removeBoundProperties(schema: Record<string, unknown>, binder: BinderNames): { bound: string[] } | { unbindable: string } {
  const properties = isObject(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required as string[] : [];
  const missing = binder.properties.find((name) => {
    const property = properties[name];
    return !(isObject(property) && property.type === "string" && required.includes(name));
  });
  if (missing !== undefined) return { unbindable: `missing server-bound property ${missing}` };
  const present = (binder.optionalProperties ?? []).filter((name) => !binder.properties.includes(name) && (Object.hasOwn(properties, name) || required.includes(name)));
  const untyped = present.find((name) => {
    const property = properties[name];
    return !(isObject(property) && property.type === "string");
  });
  if (untyped !== undefined) return { unbindable: `server-bound property ${untyped} is not a string` };
  const bound = [...binder.properties, ...present];
  for (const name of bound) delete properties[name];
  schema.required = required.filter((name) => !bound.includes(name));
  return { bound };
}
```

Add as the first line of `packages/gateway/src/index.ts`:

```ts
export * from "./binding.js";
```

- [ ] **Step 5: Use it in `engine.ts`**

Add after the `./types.js` import:

```ts
import { removeBoundProperties } from "./binding.js";
```

Replace the whole `reviewTools` function (from its doc comment to the closing brace before
`export function approveTools`) with the block below. Only three things change: the body moves to
`review`, the binding lines call `removeBoundProperties`, and each pushed tool carries its `bound`
names. The `schemaHash` line is untouched.

```ts
/** Derive schemas from discovery, narrow by admin policy, bind routing outside model arguments, and say why any approved tool is not offered. */
export function reviewTools<Scope>(
  connection: Pick<McpConnection, "tools">,
  connector: Pick<ConnectorDefinition<Scope>, "binder">,
  context: ConnectorContext<Scope>,
): { tools: CatalogTool[]; skipped: SkippedTool[] } {
  const { tools, skipped } = review(connection, connector, context);
  return { tools: tools.map(({ tool }) => tool), skipped };
}

/** reviewTools, keeping for each offered tool the bound properties a call on it sends. */
function review<Scope>(
  connection: Pick<McpConnection, "tools">,
  connector: Pick<ConnectorDefinition<Scope>, "binder">,
  context: ConnectorContext<Scope>,
): { tools: Array<{ tool: CatalogTool; bound: string[] }>; skipped: SkippedTool[] } {
  const tools: Array<{ tool: CatalogTool; bound: string[] }> = [];
  const skipped: SkippedTool[] = [];
  const offered = new Set(connection.tools.map((tool) => tool.name));
  for (const approval of context.policy.tools) {
    if (!offered.has(approval.name)) skipped.push({ tool: approval.name, reason: "not offered by the vendor" });
  }
  for (const upstream of connection.tools) {
    const policy = context.policy.tools.find((entry) => entry.name === upstream.name);
    if (!policy) continue;
    if (JSON.stringify(upstream.inputSchema).length > 32_768) { skipped.push({ tool: upstream.name, reason: "schema exceeds 32768 characters" }); continue; }
    const flattened = flattenSchema(upstream.inputSchema);
    if ("unsupported" in flattened) { skipped.push({ tool: upstream.name, reason: flattened.unsupported }); continue; }
    const schema = flattened.schema;
    if (schema.type !== "object" || !isObject(schema.properties) || schema.anyOf || schema.oneOf || schema.patternProperties) {
      skipped.push({ tool: upstream.name, reason: "schema is not a plain object" });
      continue;
    }
    const properties = schema.properties;
    const binding = removeBoundProperties(schema, connector.binder);
    if ("unbindable" in binding) { skipped.push({ tool: upstream.name, reason: binding.unbindable }); continue; }
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
    if (JSON.stringify(schema).length > 32_768) { skipped.push({ tool: upstream.name, reason: "flattened schema exceeds 32768 characters" }); continue; }
    // Compile during discovery too; schemas we cannot validate must never be advertised.
    try { new AjvJsonSchemaValidator().getValidator(schema); } catch { skipped.push({ tool: upstream.name, reason: "schema does not compile" }); continue; }
    tools.push({ bound: binding.bound, tool: {
      name: upstream.name,
      scope: context.scopeAlias,
      description: (upstream.description ?? upstream.name).slice(0, 16_384),
      inputSchema: schema,
      // Hashed under the feature 007 key `repository` so hashes survive the release.
      schemaHash: fingerprint({ upstream, policy, repository: context.scope }),
      access: policy.access,
    } });
  }
  return { tools, skipped };
}
```

- [ ] **Step 6: Run the tests and watch them pass**

Run: `npx vitest run tests/contract/gateway-binding.test.ts tests/contract/gateway-engine.test.ts`
Expected: PASS. The Task 1 GitHub test still passes with the same hashes.

- [ ] **Step 7: Run the full suite and commit**

Run: `npm run typecheck && npm run lint && npm run build && npm test`. Expected: all pass, and the
GitHub golden test in `tests/contract/slack-control-plane.test.ts` passes unedited.

```bash
git add packages/gateway/src/binding.ts packages/gateway/src/types.ts packages/gateway/src/engine.ts packages/gateway/src/index.ts tests/contract/gateway-binding.test.ts
git commit -m "feat(gateway): binders can bind a property only on the tools that have it

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Calls send only the bound values a tool has

Until this task, a Linear call on a tool without `team` would still receive `team` and fail the
vendor schema. This task finishes FR-005 at call time.

**Files:**
- Modify: `packages/gateway/src/types.ts` (`GuardInput.scope`), `packages/gateway/src/engine.ts`
  (`executeTool`, one new private helper)
- Test: `tests/contract/gateway-binding.test.ts`

**Interfaces:**
- Consumes: `boundNames` (Task 2), the internal `review` (Task 2), test helpers from Tasks 1–2.
- Produces: `GuardInput.scope: unknown`, set to `context.scope` on every `check`.
- Produces: in the test file, `vendorRig(vendor, binder, scope, names, guards?)` returning
  `{ call, connect, connector, issue, request, send, run }`, used by Task 4. In `engine.ts`, the private
  `injectedValues(names, bound, connector)`.

- [ ] **Step 1: Write the failing tests**

Add `type Guard,` to the gateway import list. Append:

```ts
function vendorRig<Scope extends { alias: string }>(vendor: "linear" | "jira", binder: Binder<Scope>, scope: Scope, names: readonly string[], guards: Guard[] = []) {
  const tools = vendorTools(vendor);
  const call = vi.fn<(name: string, args: Record<string, unknown>) => Promise<McpToolResult>>(async () => ok);
  const connect = vi.fn<typeof connectMcp>(async () => ({ tools, call, close: async () => undefined }));
  const issue = vi.fn(async () => ({ token: `${vendor}-secret`, bindings: {} }));
  const connector: ConnectorDefinition<Scope> = {
    label: vendor === "linear" ? "Linear" : "Jira", endpoint: new URL(`https://mcp.${vendor}.test/mcp`), permissionsHint: "API key permissions",
    credentials: { issue },
    binder, guards,
  };
  const context = contextFor(scope, names, ["createJiraIssue", "save_issue"]);
  const ledger = memoryLedger();
  let sequence = 0;
  const request = (tool: string, args: Record<string, unknown>) => {
    sequence += 1;
    const schemaHash = approveTools({ tools }, connector, context).find((entry) => entry.name === tool)!.schemaHash;
    return { requestId: `r-${sequence}`, scope: scope.alias, tool, schemaHash, arguments: args };
  };
  const send = (built: ReturnType<typeof request>) => executeTool(built, connector, context, { connect, ledger });
  const run = (tool: string, args: Record<string, unknown>) => send(request(tool, args));
  return { call, connect, connector, issue, request, send, run };
}

describe("when-present binding at call time", () => {
  it("sends the team only to Linear tools that have it, under the name each tool uses", async () => {
    const rig = vendorRig("linear", linearBinder, linearScope, LINEAR_TOOLS);
    const team = linearScope.teamId;
    expect(await rig.run("list_issues", { query: "login" })).toMatchObject({ status: "SUCCEEDED" });
    expect(rig.call).toHaveBeenLastCalledWith("list_issues", { query: "login", team });
    expect(await rig.run("list_issue_statuses", {})).toMatchObject({ status: "SUCCEEDED" });
    expect(rig.call).toHaveBeenLastCalledWith("list_issue_statuses", { team });
    expect(await rig.run("list_documents", {})).toMatchObject({ status: "SUCCEEDED" });
    expect(rig.call).toHaveBeenLastCalledWith("list_documents", { teamId: team });
    expect(await rig.run("get_issue", { id: "CHA-1" })).toMatchObject({ status: "SUCCEEDED" });
    expect(rig.call).toHaveBeenLastCalledWith("get_issue", { id: "CHA-1" });
  });

  it("sends cloudId on every Jira call and projectKey only on createJiraIssue", async () => {
    const rig = vendorRig("jira", jiraBinder, jiraScope, JIRA_TOOLS);
    expect(await rig.run("createJiraIssue", { summary: "Bug", issueType: "Task" })).toMatchObject({ status: "SUCCEEDED" });
    expect(rig.call).toHaveBeenLastCalledWith("createJiraIssue", { summary: "Bug", issueType: "Task", cloudId: jiraScope.cloudId, projectKey: "KAN" });
    expect(await rig.run("getJiraIssue", { issueIdOrKey: "KAN-1" })).toMatchObject({ status: "SUCCEEDED" });
    expect(rig.call).toHaveBeenLastCalledWith("getJiraIssue", { issueIdOrKey: "KAN-1", cloudId: jiraScope.cloudId });
  });

  it("gives guards every bound value, including one the called tool does not have", async () => {
    const check = vi.fn<Guard["check"]>(async () => undefined);
    const rig = vendorRig("jira", jiraBinder, jiraScope, JIRA_TOOLS, [{ requiredTools: () => [], check }]);
    await rig.run("searchJiraIssuesUsingJql", { jql: "status = Done" });
    expect(check).toHaveBeenCalledWith(expect.objectContaining({ bound: { cloudId: jiraScope.cloudId, projectKey: "KAN" }, scope: jiraScope }));
    expect(rig.call).toHaveBeenLastCalledWith("searchJiraIssuesUsingJql", { jql: "status = Done", cloudId: jiraScope.cloudId });
  });

  it("refuses a model-supplied when-present property, on a tool that has it and on one that does not, before issuing a credential", async () => {
    const rig = vendorRig("linear", linearBinder, linearScope, LINEAR_TOOLS);
    await expect(rig.run("list_issues", { team: "Other team" })).rejects.toThrow(/Linear routing arguments are server controlled/);
    await expect(rig.run("get_issue", { id: "CHA-1", teamId: "other" })).rejects.toThrow(/Linear routing arguments are server controlled/);
    expect(rig.issue).not.toHaveBeenCalled();
    expect(rig.connect).not.toHaveBeenCalled();
  });

  it("fails closed, without calling the vendor, when the binder has no value for a when-present property the tool has", async () => {
    const binder: Binder<LinearScope> = { properties: [], optionalProperties: ["team"], bind: () => ({}) };
    const rig = vendorRig("linear", binder, linearScope, LINEAR_TOOLS);
    expect(await rig.run("list_issues", {})).toEqual({
      requestId: "r-1", status: "FAILED", reason: "policy_denied", truncated: false, replayed: false,
      text: "Linear has no server-bound value for team. An administrator must fix the connector configuration.",
    });
    expect(await rig.run("get_issue", { id: "CHA-1" })).toMatchObject({ status: "SUCCEEDED" });
    expect(rig.call).toHaveBeenCalledExactlyOnceWith("get_issue", { id: "CHA-1" });
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run tests/contract/gateway-binding.test.ts`
Expected: the 5 new tests FAIL. The first three return `status: "FAILED"` because `team`,
`teamId` or `projectKey` reach tools that lack them and break the vendor schema; the refusal test
resolves instead of rejecting; the fail-closed test sees a different result.

- [ ] **Step 3: Implement**

In `packages/gateway/src/types.ts`, replace `GuardInput` with:

```ts
export interface GuardInput {
  tool: string;
  arguments: Readonly<Record<string, unknown>>;
  bound: Readonly<Record<string, unknown>>;
  /** The call's scope, such as the Linear team or Jira project, for tools whose schema carries no bound property. */
  scope: unknown;
  connection: Pick<McpConnection, "call">;
}
```

In `packages/gateway/src/engine.ts`, change the binding import to:

```ts
import { boundNames, removeBoundProperties } from "./binding.js";
```

Add after `class DefinitionChanged extends PolicyFailure {}`:

```ts
/**
 * The bound values a call sends: those its tool has. A required binding's missing value fails the
 * upstream schema; a when-present one may be optional there, so its absence is refused here instead
 * of silently sending an unrestricted call.
 */
function injectedValues<Scope>(names: readonly string[], bound: Readonly<Record<string, unknown>>, connector: Pick<ConnectorDefinition<Scope>, "binder" | "label">): Record<string, unknown> {
  const injected: Record<string, unknown> = {};
  for (const name of names) {
    const value = bound[name];
    if (!connector.binder.properties.includes(name) && (typeof value !== "string" || value === "")) {
      throw new PolicyFailure(`${connector.label} has no server-bound value for ${name}. An administrator must fix the connector configuration.`);
    }
    injected[name] = value;
  }
  return injected;
}
```

In `executeTool`, replace the refusal condition:

```ts
  if (boundNames(connector.binder).some((name) => Object.hasOwn(request.arguments, name))) {
    throw agentXError("FORBIDDEN", `${label} routing arguments are server controlled`);
  }
```

Replace the lines from `const approved = approveTools(...)` through `const unsigned = ...` with:

```ts
    const reviewed = review(connection, connector, context).tools.find(({ tool }) => tool.name === request.tool);
    if (!reviewed || reviewed.tool.schemaHash !== request.schemaHash) {
      options.onDefinitionChanged?.();
      throw new DefinitionChanged("MCP tool definition changed or is unavailable. Refresh tool discovery before submitting a new request.");
    }
    const approved = reviewed.tool;
    const validate = new AjvJsonSchemaValidator().getValidator(approved.inputSchema);
    if (!validate(request.arguments).valid) throw new PolicyFailure("Arguments do not match the approved MCP tool schema.");
    const bound = connector.binder.bind(context.scope, credential);
    const injected = injectedValues(reviewed.bound, bound, connector);
    const upstream = connection.tools.find((tool) => tool.name === request.tool)!;
    const validateUpstream = new AjvJsonSchemaValidator().getValidator(upstream.inputSchema);
    const unsigned = { ...request.arguments, ...injected };
```

Replace the guard `check` loop with:

```ts
    for (const guard of connector.guards) await guard.check({ tool: request.tool, arguments: request.arguments, bound, scope: context.scope, connection });
```

Leave the rest of `executeTool` as it is. Guards still receive `bound`, the whole `bind()` result.
The GitHub issue guard ignores `scope`.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run tests/contract/gateway-binding.test.ts tests/contract/gateway-engine.test.ts`
Expected: PASS, including the existing "never signs a value the binder supplied" and "runs guards
... `bound` toEqual `{ siteId }`" tests, unedited.

- [ ] **Step 5: Run the full suite and commit**

Run: `npm run typecheck && npm run lint && npm run build && npm test`. Expected: all pass.

```bash
git add packages/gateway/src/types.ts packages/gateway/src/engine.ts tests/contract/gateway-binding.test.ts
git commit -m "feat(gateway): send each bound value only to tools that have it, refuse a missing one, give guards the scope

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Guards can rewrite the model's arguments

**Files:**
- Modify: `packages/gateway/src/types.ts` (`RewriteInput`, `Guard.rewrite`),
  `packages/gateway/src/engine.ts` (`executeTool`, one new private helper)
- Test: `tests/contract/gateway-binding.test.ts`

**Interfaces:**
- Consumes: `vendorRig`, `jiraBinder`, `jiraScope`, `JiraScope`, `linearBinder`, `linearScope`,
  `LinearScope`, `JIRA_TOOLS`, `contextFor`, `memoryLedger` (Tasks 1–3); `boundNames` (Task 2).
- Produces:

```ts
export interface RewriteInput {
  tool: string;
  arguments: Readonly<Record<string, unknown>>;
  bound: Readonly<Record<string, unknown>>;
  scope: unknown;
}
export interface Guard {
  requiredTools(tool: string, args: Readonly<Record<string, unknown>>): readonly string[];
  rewrite?(input: RewriteInput): Record<string, unknown>;
  check(input: GuardInput): Promise<void>;
}
```

Phase 6 implements its JQL guard against exactly this. The order inside `executeTool` becomes:
narrowed-schema validation, `bind`, the when-present value check, each guard's `rewrite` in order,
the merge `{ ...rewritten, ...injected }` (the same place bound values are merged today), upstream
validation, attribution (only keys the model supplied), each guard's `check` (with the rewritten
arguments and the scope), vendor call.

- [ ] **Step 1: Write the failing tests**

Add `GuardRejection,` to the gateway value imports (after `githubBinder`). Append:

```ts
/** A test stand-in for phase 6's JQL guard: every search is limited to the scope's project. */
const projectSearch: Guard = {
  requiredTools: () => [],
  check: async () => undefined,
  rewrite({ tool, arguments: args, scope }) {
    if (tool !== "searchJiraIssuesUsingJql") return { ...args };
    if (typeof args.jql !== "string" || /\border\s+by\b/i.test(args.jql)) throw new GuardRejection("Search without ORDER BY.");
    return { ...args, jql: `project = "${(scope as JiraScope).projectKey}" AND (${args.jql})` };
  },
};

describe("guards that rewrite the model's arguments", () => {
  it("sends the rewritten arguments, with bound values, and shows them to every check", async () => {
    const check = vi.fn<Guard["check"]>(async () => undefined);
    const rig = vendorRig("jira", jiraBinder, jiraScope, JIRA_TOOLS, [projectSearch, { requiredTools: () => [], check }]);
    expect(await rig.run("searchJiraIssuesUsingJql", { jql: "status = Done" })).toMatchObject({ status: "SUCCEEDED" });
    expect(rig.call).toHaveBeenLastCalledWith("searchJiraIssuesUsingJql", { jql: "project = \"KAN\" AND (status = Done)", cloudId: jiraScope.cloudId });
    expect(check).toHaveBeenCalledWith(expect.objectContaining({ arguments: { jql: "project = \"KAN\" AND (status = Done)" } }));
  });

  it("returns a rewrite refusal as a policy denial without calling the vendor", async () => {
    const rig = vendorRig("jira", jiraBinder, jiraScope, JIRA_TOOLS, [projectSearch]);
    expect(await rig.run("searchJiraIssuesUsingJql", { jql: "status = Done ORDER BY created" })).toMatchObject({ status: "FAILED", reason: "policy_denied", text: "Search without ORDER BY." });
    expect(rig.call).not.toHaveBeenCalled();
  });

  it("refuses a rewrite that sets a server-bound property, even one the tool does not have", async () => {
    const rig = vendorRig("jira", jiraBinder, jiraScope, JIRA_TOOLS, [{ requiredTools: () => [], check: async () => undefined, rewrite: ({ arguments: args }) => ({ ...args, projectKey: "OTHER" }) }]);
    expect(await rig.run("searchJiraIssuesUsingJql", { jql: "status = Done" })).toMatchObject({
      status: "FAILED", reason: "policy_denied", text: "Jira guard set a server-controlled argument.",
    });
    expect(rig.call).not.toHaveBeenCalled();
  });

  it("replays a rewritten write from the ledger by the model's own arguments, without rewriting or calling again", async () => {
    const rewrite = vi.fn<NonNullable<Guard["rewrite"]>>(({ arguments: args }) => ({ ...args, summary: `[KAN] ${String(args.summary)}` }));
    const rig = vendorRig("jira", jiraBinder, jiraScope, JIRA_TOOLS, [{ requiredTools: () => [], check: async () => undefined, rewrite }]);
    const request = rig.request("createJiraIssue", { summary: "Bug", issueType: "Task" });
    expect(await rig.send(request)).toMatchObject({ status: "SUCCEEDED", replayed: false });
    expect(rig.call).toHaveBeenLastCalledWith("createJiraIssue", { summary: "[KAN] Bug", issueType: "Task", cloudId: jiraScope.cloudId, projectKey: "KAN" });
    expect(await rig.send(request)).toMatchObject({ status: "SUCCEEDED", replayed: true });
    expect(rewrite).toHaveBeenCalledOnce();
    expect(rig.call).toHaveBeenCalledOnce();
  });

  it("signs a long-text field the model wrote, with its rewritten value, and never one a rewrite added", async () => {
    const tools = vendorTools("linear");
    const call = vi.fn<(name: string, args: Record<string, unknown>) => Promise<McpToolResult>>(async () => ok);
    const connect = vi.fn<typeof connectMcp>(async () => ({ tools, call, close: async () => undefined }));
    const prefix: Guard = { requiredTools: () => [], check: async () => undefined, rewrite: ({ arguments: args }) => ({ ...args, title: `[Payments] ${String(args.title)}` }) };
    const adds: Guard = { requiredTools: () => [], check: async () => undefined, rewrite: ({ arguments: args }) => typeof args.description === "string" ? { ...args, description: `${args.description} (triaged)` } : { ...args, description: "Filed from Slack." } };
    const connector: ConnectorDefinition<LinearScope> = {
      label: "Linear", endpoint: new URL("https://mcp.linear.test/mcp"), permissionsHint: "API key permissions",
      credentials: { issue: async () => ({ token: "linear-secret", bindings: {} }) },
      binder: linearBinder, guards: [prefix, adds],
    };
    const context = contextFor(linearScope, ["save_issue"], ["save_issue"]);
    const options = { connect, ledger: memoryLedger(), attribution: "Requested by Pratik via AgentX" };
    const schemaHash = approveTools({ tools }, connector, context)[0]!.schemaHash;
    await executeTool({ requestId: "w-1", scope: linearScope.alias, tool: "save_issue", schemaHash, arguments: { title: "Bug", description: "Steps" } }, connector, context, options);
    expect(call).toHaveBeenLastCalledWith("save_issue", { title: "[Payments] Bug", description: "Steps (triaged)\n\n—\nRequested by Pratik via AgentX", team: linearScope.teamId });
    await executeTool({ requestId: "w-2", scope: linearScope.alias, tool: "save_issue", schemaHash, arguments: { title: "Bug" } }, connector, context, options);
    expect(call).toHaveBeenLastCalledWith("save_issue", { title: "[Payments] Bug", description: "Filed from Slack.", team: linearScope.teamId });
  });

  it("validates the rewritten arguments against the vendor's schema", async () => {
    const rig = vendorRig("jira", jiraBinder, jiraScope, JIRA_TOOLS, [{ requiredTools: () => [], check: async () => undefined, rewrite: ({ arguments: args }) => ({ ...args, notAJiraArgument: true }) }]);
    expect(await rig.run("getJiraIssue", { issueIdOrKey: "KAN-1" })).toMatchObject({ status: "FAILED", reason: "policy_denied", text: "Arguments do not match the upstream MCP tool schema." });
    expect(rig.call).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run tests/contract/gateway-binding.test.ts`
Expected: the 6 new tests FAIL, because `rewrite` is never called: the search is sent with the
model's own `jql`, the refusal cases return `SUCCEEDED`, and the signing test sees no title prefix.

- [ ] **Step 3: Extend `Guard` in `packages/gateway/src/types.ts`**

Add `RewriteInput` after `GuardInput`, and replace the `Guard` interface, with:

```ts
export interface RewriteInput {
  tool: string;
  /** The model's arguments, after any earlier guard rewrote them. */
  arguments: Readonly<Record<string, unknown>>;
  /** Every value the binder returned, including ones the called tool does not have. */
  bound: Readonly<Record<string, unknown>>;
  /** The call's scope. */
  scope: unknown;
}
export interface Guard {
  /** Upstream tools the check needs on the call's connection besides the called tool. */
  requiredTools(tool: string, args: Readonly<Record<string, unknown>>): readonly string[];
  /**
   * Optional. Returns the model's arguments narrowed to the scope, such as a search limited to the
   * bound project. It runs after the model's arguments pass the narrowed schema, and before bound
   * values are merged, upstream validation, attribution and every check. It must not set a
   * server-bound property, and throws GuardRejection to refuse. The ledger still fingerprints the
   * model's own arguments.
   */
  rewrite?(input: RewriteInput): Record<string, unknown>;
  /** Throws GuardRejection to refuse the call before it executes. */
  check(input: GuardInput): Promise<void>;
}
```

- [ ] **Step 4: Implement in `engine.ts`**

Add after `class DefinitionChanged extends PolicyFailure {}`, before `injectedValues`:

```ts
/** Applies each guard's rewrite in order. Without one, the model's arguments pass through as the same object. */
function rewriteArguments<Scope>(request: ToolRequest, bound: Readonly<Record<string, unknown>>, scope: Scope, connector: Pick<ConnectorDefinition<Scope>, "binder" | "guards" | "label">): Record<string, unknown> {
  let args = request.arguments;
  const names = boundNames(connector.binder);
  for (const guard of connector.guards) {
    if (!guard.rewrite) continue;
    args = guard.rewrite({ tool: request.tool, arguments: args, bound, scope });
    if (names.some((name) => Object.hasOwn(args, name))) throw new PolicyFailure(`${connector.label} guard set a server-controlled argument.`);
  }
  return args;
}
```

In `executeTool`, replace the lines from `const injected = ...` through the guard `check` loop with:

```ts
    const injected = injectedValues(reviewed.bound, bound, connector);
    const modelArgs = rewriteArguments(request, bound, context.scope, connector);
    // Only keys the model wrote are signed, with the value a rewrite gave them; a key a rewrite added is not.
    const signable = modelArgs === request.arguments ? modelArgs : Object.fromEntries(Object.entries(modelArgs).filter(([key]) => Object.hasOwn(request.arguments, key)));
    const upstream = connection.tools.find((tool) => tool.name === request.tool)!;
    const validateUpstream = new AjvJsonSchemaValidator().getValidator(upstream.inputSchema);
    const unsigned = { ...modelArgs, ...injected };
    if (!validateUpstream(unsigned).valid) throw new PolicyFailure("Arguments do not match the upstream MCP tool schema.");
    // The footer is best effort: when it would break the vendor's schema (a body maxLength, say),
    // the model's own arguments go through unsigned rather than the write failing.
    const signed = withAttribution(unsigned, signable, write ? options.attribution : undefined, upstream.inputSchema, connector.attributionKeys);
    const dropped = signed !== unsigned && !validateUpstream(signed).valid;
    const args = dropped ? unsigned : signed;
    for (const guard of connector.guards) await guard.check({ tool: request.tool, arguments: modelArgs, bound, scope: context.scope, connection });
```

The ledger record and `requestFingerprint(request)` are computed from `request.arguments` earlier
in the function and do not change. With no `rewrite` (GitHub, tracker), `modelArgs` and `signable`
are `request.arguments` itself, so every existing call and signature is identical.

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npx vitest run tests/contract/gateway-binding.test.ts tests/contract/gateway-engine.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full suite and commit**

Run: `npm run typecheck && npm run lint && npm run build && npm test`. Expected: all pass.

```bash
git add packages/gateway/src/types.ts packages/gateway/src/engine.ts tests/contract/gateway-binding.test.ts
git commit -m "feat(gateway): guards can rewrite the model's arguments before a call

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: The tracker type binds a board through the unchanged routes, and documentation

Proves SC-002 for the new binder mode: a registry-backed type binds a when-present value through
the broker's connector routes with no change to routes, cache, ledger or catalog.

**Files:**
- Modify: `tests/support/tracker-connector.ts`, `tests/contract/generic-connector-routes.test.ts`,
  `README.md`, `specs/013-connector-gateway/plan.md`, `specs/013-connector-gateway/tasks.md`

**Interfaces:**
- Consumes: `Binder.optionalProperties` (Task 2) through `@agentx/gateway` (dist; run `npm run build`).
- Produces: `TrackerScope` gains `boardId?: string`; `trackerBroker(options?: { extraTools?: unknown[]; config?: Record<string, unknown> })`.

- [ ] **Step 1: Write the failing test**

In `tests/contract/generic-connector-routes.test.ts`, give the helpers parameters (no existing
assertion changes):

```ts
/** A broker serving github and the test-only tracker type, with a project whose latest revision configures both. */
async function trackerBroker(options: { extraTools?: unknown[]; config?: Record<string, unknown> } = {}) {
```

In its `tools: [...]` list, after the `delete_item` entry, add:

```ts
      ...(options.extraTools ?? []),
```

Replace `seedTracker(db);` with `seedTracker(db, options.config ?? trackerConfig);`, and change
`seedTracker` to:

```ts
function seedTracker(db: FakeDynamoDb, config: Record<string, unknown>): void {
  const [revision] = db.find((item) => item.pk === "PROJECT#payments" && String(item.sk).startsWith("REV#"));
  if (!revision) throw new Error("project revision is missing");
  const definition = revision.definition as { integrations: { connectors: unknown[] } };
  definition.integrations.connectors.push(config);
}
```

Add this test inside `describe("generic connector routes", ...)`, before "still answers connector
not found ...":

```ts
  it("binds a site's board only on tools that have one, through the unchanged routes, and refuses a board the model supplies", async () => {
    const boardTools = [
      { name: "move_item", description: "Move an item, optionally on a board", inputSchema: { type: "object", properties: {
        siteId: { type: "string" }, id: { type: "string" }, boardId: { type: "string" },
      }, required: ["siteId", "id"], additionalProperties: false } },
    ];
    const config = {
      ...trackerConfig,
      scopes: [{ alias: "payments", siteId: "site-payments-1", boardId: "board-7" }],
      tools: [{ name: "list_items", access: "read" }, { name: "move_item", access: "write" }],
    };
    const { handler, path, invoke } = await trackerBroker({ extraTools: boardTools, config });
    expect((await registerTrackerKey(handler)).status).toBe(201);
    const catalog = ConnectorCatalogSchema.parse((await call(handler, { method: "GET", path: `${path}/tools`, service })).body.catalog);
    expect(catalog.tools.map((tool) => tool.name)).toEqual(["tracker__list_items", "tracker__move_item"]);
    expect(JSON.stringify(catalog)).not.toContain("boardId");
    const hashOf = (name: string) => catalog.tools.find((tool) => tool.name === name)!.scopes[0]!.schemaHash;

    const moved = await call(handler, { method: "POST", path: `${path}/call`, service,
      body: { requestId: randomUUID(), scope: "payments", tool: "move_item", schemaHash: hashOf("tracker__move_item"), arguments: { id: "item-1" } } });
    expect(moved.body.result).toMatchObject({ status: "SUCCEEDED" });
    expect(invoke).toHaveBeenLastCalledWith("move_item", { id: "item-1", siteId: "site-payments-1", boardId: "board-7" });
    const listed = await call(handler, { method: "POST", path: `${path}/call`, service,
      body: { requestId: randomUUID(), scope: "payments", tool: "list_items", schemaHash: hashOf("tracker__list_items"), arguments: {} } });
    expect(listed.body.result).toMatchObject({ status: "SUCCEEDED" });
    expect(invoke).toHaveBeenLastCalledWith("list_items", { siteId: "site-payments-1" });

    const refused = await call(handler, { method: "POST", path: `${path}/call`, service,
      body: { requestId: randomUUID(), scope: "payments", tool: "move_item", schemaHash: hashOf("tracker__move_item"), arguments: { id: "item-1", boardId: "board-other" } } });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toEqual({ code: "FORBIDDEN", message: "Tracker routing arguments are server controlled" });
    expect(invoke).toHaveBeenCalledTimes(2);
  });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run build && npx vitest run tests/contract/generic-connector-routes.test.ts`
Expected: the new test FAILS at `expect(JSON.stringify(catalog)).not.toContain("boardId")`,
because the tracker binder does not bind `boardId` yet. Every existing test passes.

- [ ] **Step 3: Bind the board in the tracker type**

In `tests/support/tracker-connector.ts`, replace `TrackerScope` and `isTrackerScope`:

```ts
/** A site, and optionally the board that tools with a `boardId` property are limited to. */
export interface TrackerScope { alias: string; siteId: string; boardId?: string }

function isTrackerScope(value: unknown): value is TrackerScope {
  if (!value || typeof value !== "object") return false;
  const scope = value as Record<string, unknown>;
  return typeof scope.alias === "string" && typeof scope.siteId === "string" && (scope.boardId === undefined || typeof scope.boardId === "string");
}
```

and replace the `binder:` line in `definition()` with:

```ts
          binder: {
            properties: ["siteId"],
            optionalProperties: ["boardId"],
            bind: (scope) => scope.boardId === undefined ? { siteId: scope.siteId } : { siteId: scope.siteId, boardId: scope.boardId },
          },
```

The existing `connector-types.test.ts` assertion
`binder.bind({ alias: "payments", siteId: "site-42" }, ...)` `toEqual({ siteId: "site-42" })` still
holds, because a scope without a board binds only `siteId`.

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run tests/contract/generic-connector-routes.test.ts tests/contract/connector-types.test.ts tests/contract/registration-preflight.test.ts`
Expected: PASS.

- [ ] **Step 5: Update the documents**

- `README.md`, "Connector credentials": after the paragraph that begins "Each connector type is
  one definition in the control plane", add this paragraph:

  > A binder names the arguments the server fills in and the model never sees. Some are bound on
  > every tool, such as GitHub's owner and repository; a tool without them is not offered. Others
  > are bound only on the tools that have them, such as a Linear team; other tools are offered
  > unchanged. A request that supplies a bound argument itself is refused.

- `specs/013-connector-gateway/plan.md`, "Phases" table, add after the 5a row:

  `| 5b | Shared binder: bind a property on every tool or only where present; guards get the scope and can rewrite arguments | 5a | [plans/phase-5b-binder.md](plans/phase-5b-binder.md) |`

  and copy this plan to `specs/013-connector-gateway/plans/phase-5b-binder.md`.

- `specs/013-connector-gateway/tasks.md`, add before "## Phase 5: Linear (US2)":

  ```markdown
  ## Phase 5b: Shared binder (before 5 and 6)

  - [X] T040 Add `Binder.optionalProperties`, `GuardInput.scope` and `Guard.rewrite`; test with recorded Linear and Jira fixtures, the GitHub characterization and the tracker type.
  ```

  and change the Dependencies line to
  `1a → 1b → {2, 3}; 2 → 4; 3 → 5a → 5b → {5, 6}. Phases 5 and 6 can run in parallel.`

- [ ] **Step 6: Verify**

Run: `npm run typecheck && npm run lint && npm run build && npm test`. Expected: all pass. Then run
`git diff feat/013-generic-connectors -- tests/contract/slack-control-plane.test.ts tests/contract/gateway-engine.test.ts tests/contract/connector-types.test.ts`
and confirm it is empty, and that
`git diff feat/013-generic-connectors -- tests/contract/generic-connector-routes.test.ts` changes
no existing `expect` line.

- [ ] **Step 7: Commit**

```bash
git add tests/support/tracker-connector.ts tests/contract/generic-connector-routes.test.ts README.md specs/013-connector-gateway/plan.md specs/013-connector-gateway/tasks.md specs/013-connector-gateway/plans/phase-5b-binder.md
git commit -m "test(broker): bind a when-present value through the generic routes; document binder modes

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## What phases 5 and 6 take from here

- **Linear (phase 5):** `binder: { properties: [], optionalProperties: ["team", "teamId"], bind: (scope) => ({ team: scope.teamId, teamId: scope.teamId }) }` (R11).
  A check-only guard for `save_issue` with an `id`, `save_comment` and `get_issue`, which are not
  limited by team (R13); it reads the team from `GuardInput.scope`. Fixtures extend `tests/fixtures/vendors/linear-tools.json`.
- **Jira (phase 6):** `binder: { properties: ["cloudId"], optionalProperties: ["projectKey"], ... }`. A
  guard whose `rewrite` narrows `searchJiraIssuesUsingJql` to the scope's project, handling
  `ORDER BY` outside the parentheses, and whose `check` confirms an `issueIdOrKey` belongs to that
  project; both read the project from `scope`. Tools without a required `cloudId` (`executeRead`, `executeWrite`,
  `executeDestructive`, `discover`, `atlassianUserInfo`, `getAccessibleAtlassianResources`) are
  skipped by registration preflight; the setup guide says not to approve them.

## Self-Review

1. **Spec coverage.** FR-005: removal (Task 2), injection where present (Task 3), refusal (Task 3),
   the three vendors' shapes (Tasks 1–3, real fixtures). FR-002: injection after validation, upstream
   validation of the final arguments, ledger fingerprint of the model's arguments (Tasks 3–4).
   SC-001: no existing assertion changes (Task 5 Step 6). SC-002: the tracker type binds a new
   mode through unchanged routes (Task 5). GitHub byte-identity: Task 1 plus the golden test.
2. **Placeholders.** None. Every code step has the code; every run step has the command and the
   expected result.
3. **Type consistency.** `Binder.optionalProperties`, `boundNames`, `removeBoundProperties` returning
   `{ bound } | { unbindable }`, internal `review` returning `{ tool, bound }`, `injectedValues`,
   `rewriteArguments`, `RewriteInput`, `Guard.rewrite`, and the test helpers `vendorTools`,
   `memoryLedger`, `contextFor`, `vendorRig` keep the same names and shapes in every task.
4. **Review Focus.** Each of the five lines has its test in its owning task (Tasks 2, 3 and 4).
