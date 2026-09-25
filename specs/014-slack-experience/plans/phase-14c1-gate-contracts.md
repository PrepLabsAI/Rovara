# Phase 14c Part 1: Action Gate Contracts, Dormant, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship, with no user-visible change, everything the control plane must serve before the
Slack service can turn the action gate on: the project's `actionPolicy`, the vendor's MCP hints
and each connector's declared item argument paths on the tool catalog, each only to a Slack service
that asks for it.

**Architecture:** Contracts gain `ActionPolicySchema` (strict registration checks), `ToolHints`,
item argument paths (`ItemPathSchema` and a bounded resolver, R7) and a per-tool `itemArguments`
on `PresentedTool`. The gateway keeps `readOnlyHint` and
`destructiveHint` from `tools/list` (today it drops them), and each connector definition declares,
as its own data, the argument paths through which its tools name an existing item (`id` for Linear,
`issueIdOrKey` for Jira, `issue_number` and `pull_number` for GitHub; a path may reach inside an
object or an array of objects, such as `tasks[].task`). The broker sends those
catalog fields only with the request header `x-agentx-include: gate`, and the latest revision's
`actionPolicy` only to a thread-workspace request with `includeActionPolicy: true`, on every path
that builds a thread result, including 14b's `createUnpreparedThreadWorkspace` (C1). The Slack
service starts sending `includeActionPolicy: true` (so 14b PR B can insert `lazyPreparation: true`
before it, C2) and parses the field, but nothing reads these fields until part 2.

**Tech Stack:** TypeScript 5.9 strict, Node 22.19 to 22.x, Vitest 5, Zod 4.6, MCP SDK 1.30.1.

**Spec:** [../spec.md](../spec.md): FR-014 (hints, approved access), FR-015 (rules, strict
registration), and the owner decisions in `.superpowers/sdd/014-decisions.md` (D1 detail: item
arguments as connector data; the cross-plan order and C1, C2, C7, C8).

**Order and branch:** 14a, then 14b PR A, then **this part**, then 14b PR B, then 14c part 2
([phase-14c2-gate-on.md](phase-14c2-gate-on.md)), then 14d. Branch `feat/014c1-gate-contracts`,
cut from mainline once 14a and 14b PR A have merged. This plan is written against mainline plus
those two phases.

**Amended 2026-09-25 (owner-approved gate fixes).** Item arguments widen from top-level names to
simple paths (R1, R7; Tasks 2 and 3), for spec 013 phase 7's Asana `update_tasks`, which names its
tasks as `tasks[].task`. The per-tool field becomes `itemArguments: string[]` (it was
`itemArgument: string | null`), so a tool that offers several declared paths keeps them all. The
code blocks of `item-paths.ts` and its test, and part 2's amended `action-policy.ts` with its tests
and vendor pins, were run in isolation (Vitest, and `tsc` with this repository's compiler flags);
the other amended blocks (catalog, preflight, route tests) were not re-applied to the scratch copy,
so the implementer runs every step's commands as written. Part 2 R19 carries the classification side
and `completed`.

**Verified:** every code block was applied, task by task, to a scratch copy of mainline `af67c2c`
(spec 013 phase 4 merged) with every code block and test of the 14a plan and of 14b PR A (Tasks 1
to 6) applied first. With this part's four tasks applied, `npm run build`, `npm run typecheck`,
`npm run lint` and `npm test` pass (1,336 tests, one existing skip), and no existing test line is
removed besides the one named below. Spec 013 phase 4 added a `refresh` option to connector
discovery; Task 3 keeps it.

**Re-checked 2026-09-25 on mainline `8076e1e`** (14a #51, 14b PR A #52 and this amendment #53
merged): every file each task modifies exists and every anchor still matches. The unimplemented tree
passes 1,367 tests with one skip, so the 1,336 above is history, not a target.

## Global Constraints

- **No regressions.** Every existing test passes with its assertions unchanged, with one exception:
  `tests/contract/thread-workspace-request.test.ts` pins the exact opt-in body, so its expected
  line becomes `includeAllConnectorTypes: true, includeRecoverableOperations: true, includeActionPolicy: true,`
  (14b PR B later inserts `lazyPreparation: true` before `includeActionPolicy`, C2). Existing test
  files otherwise only gain appended tests (`generic-connector-routes.test.ts`,
  `registration-preflight.test.ts`); support files gain
  an appended loader (`tests/support/vendor-fixtures.ts`) and one field (`itemArguments` on the
  test-only tracker type, which the route strips without the header).
- **Golden files are append-only.** No snapshot changes. The GitHub golden catalog test in
  `slack-control-plane.test.ts` stays green without edits.
- **Wire compatibility.** The control plane releases before the Slack service and older services
  parse strictly: `hints` and `itemArguments` only with `x-agentx-include: gate`; `actionPolicy`
  only with `includeActionPolicy: true`.
- **Schema hashes do not change.** The hash already covers the whole upstream entry, annotations
  included (Task 1 pins one).
- **No gate logic names a vendor.** Vendor names appear only in connector definitions (the
  connector's own data), fixtures, tests and guides.
- **Node and build.** Node `>=22.19.0 <23`, `npm run build` before `npm test`. Node 22:
  `export PATH=/private/tmp/claude-501/node-v22.20.0-darwin-arm64/bin:$PATH`.
- **Commits.** `type(scope): summary`, ending with
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Never use `git stash`.
- **Docs style.** Plain, short sentences. No em-dashes.
- **Fix before the PR.** Fix cheap review findings and anything that fails silently before the PR.

## Review Focus

1. **An older Slack service reads the catalog.** Expected: without `x-agentx-include: gate`, every
   tool has exactly the six fields it parses today. Test: Task 1 (characterization) and Task 3.
2. **The vendor changes its annotations.** Expected: the schema hash is the one pinned before this
   part (hints are read, not hashed again). Test: Task 1 pins
   `c5c4fb16e67e06a1fda262e7262e6b5a64b59f5bd85beef35923851dcdb16728`; Task 3 re-checks it.
3. **A new thread that has no compute yet (14b).** Expected: `createUnpreparedThreadWorkspace` also
   carries the policy on opt-in (C1), and not without it. Test: Task 4, "sends the action policy
   with a new thread's record that has no compute yet ...".
4. **An administrator's allowedArguments removes the item argument.** Expected: the tool's
   `itemArguments` is `[]`, so the gate treats every call as a create, because the model can no
   longer name an item. Test: Task 3, "offers no item argument that an administrator's
   allowedArguments removed".
5. **A rule that can never apply.** Expected: registration refuses it (unknown connector, pattern
   matching no approved tool, both or neither of `outcome` and `treatAs`) and stores nothing.
   Tests: Tasks 2 and 4.
6. **A tool names its item inside an array of objects** (`tasks[].task`). Expected: the path
   resolves only through the shapes it names, at most four steps deep: a missing path, an empty
   array or objects without the item resolve to nothing (a create in part 2); a present item
   resolves (a change); the tool's `itemArguments` lists the path only when its schema offers it.
   Tests: Task 2, `item-paths.test.ts`; Task 3, "offers an item argument path inside an array of
   objects ...".
7. **A connector declares a malformed path.** Expected: registration preflight refuses it before
   contacting the vendor, every built-in declaration is pinned well formed, and if one is ever
   served it is served as no declaration, so part 2 treats every write as a change (fails closed,
   never a create). Tests: Task 2, "reports a malformed, duplicated or empty declaration"; Task 3,
   "declares only well-formed item argument paths for every built-in connector", "refuses a connector whose definition declares a malformed item argument path ..." and "serves a
   malformed declaration as none".
## File Structure

| File | Responsibility |
|---|---|
| `packages/contracts/src/action-policy.ts` (new) | `ActionPolicySchema`, `toolPatternMatches`, `IN_HOUSE_TOOL_NAMES`, `actionPolicyProblems` |
| `packages/contracts/src/item-paths.ts` (new) | `ItemPathSchema`, `ITEM_PATH_MAX_STEPS`, `parseItemPath`, `itemPathProblems`, `itemPathHolders`, `itemPathValues`, `schemaHasItemPath` (R7) |
| `packages/contracts/src/connectors.ts` | `ToolHintsSchema`, `PresentedTool.hints`, `PresentedTool.itemArguments`, `connectorApprovals` |
| `packages/contracts/src/project.ts`, `slack.ts`, `index.ts` | `actionPolicy` on the project and on the thread workspace result |
| `packages/gateway/src/mcp-client.ts`, `types.ts`, `engine.ts`, `catalog.ts` | Carry the hints; `ConnectorDefinition.itemArguments`; compute each tool's `itemArguments` |
| `packages/gateway/src/github.ts`, `linear.ts`, `jira.ts` | Each connector's item arguments |
| `packages/broker/src/aws/connector-routes.ts`, `broker.ts` | Serve the gate fields and the policy on opt-in |
| `packages/broker/src/aws/registration-preflight.ts` | Refuse a malformed item argument declaration (R7) |
| `packages/slack-service/src/thread-workspace-request.ts` | Opts in with `includeActionPolicy: true` |

## Pre-decided Rulings

- **R1. Item arguments are connector data.** `ConnectorDefinition.itemArguments` lists, most
  specific first, the argument paths (R7) through which that vendor's tools name an existing item.
  The presented tool carries, as `itemArguments`, every declared path its (narrowed) schema offers,
  in the declared order; `[]` when it offers none; and no field when the connector declares none (or
  declares a malformed path, R7). Part 2's gate treats a call as a change when any of them resolves
  to a present value, so a new connector needs one line, and the gate names no vendor. Linear: `id`
  (save_issue and save_comment update the item named by id and create one without it). Jira:
  `issueIdOrKey`. GitHub: `issue_number`, `pull_number`. These top-level names are paths of one step
  and behave exactly as before. Asana (spec 013 phase 7) will declare `["task_id", "tasks[].task"]`
  from its `ASANA_TASK_REFERENCES`; whichever of phase 7 and this part merges second sets that
  declaration on `asanaConnector` (the field ships here, so this matches phase 7's own plan); part 2
  R19 adds Asana to the classification tests.
- **R2. Hints only tighten.** Part 2 reads them only where AgentX's own rules cannot decide (see
  part 2, R3). Here they are carried as booleans only; anything else is dropped.
- **R3. One header for the gate's catalog fields.** `x-agentx-include: gate` (a comma list is
  accepted). A header, not a query string: `tests/integration/mcp-orchestrator.test.ts` fakes match
  the URL's ending.
- **R4. `treatAs` uses AgentX's classes:** `read`, `create`, `change`, `destructive` (part 2, D1).
- **R5. Rule semantics.** With `connector`, `tool` matches that connector's own tool names;
  without it, the presented names (`<connector>__<tool>`, `agentx_*`). `*` matches any run of
  characters. Registration refuses a rule for an unconfigured connector, or whose pattern matches
  no approved tool. A stored revision is not re-checked.
- **R6. Rollback floor (C7).** A stored revision with `actionPolicy` fails the strict parse of any
  component older than 14c: the control plane, the runtime (the worker receives the project
  definition in every prepare invocation) and the administration CLI (it validates the project
  file locally). So: register a policy only after the 14c runtime and control plane are both
  released; neither may roll back below 14c afterwards; administrators need the 14c CLI. Part 2's
  rollout repeats this.
- **R7. Item argument path grammar (amended 2026-09-25).** A path is `step ( "." step | "[]." step )*`
  with at most `ITEM_PATH_MAX_STEPS` (4) steps, each step 1 to 64 of `A-Z a-z 0-9 _ -`: a name
  (`id`), a name inside an object argument (`fields.key`), or a name inside each object of an array
  argument (`tasks[].task`). The named value itself is never an array (`tasks[]` is malformed), and
  there are no indexes, wildcards or other syntax. Resolving reads only the shapes the path names:
  `.` needs a plain object and `[].` an array, whose non-object entries are skipped; anything else
  resolves to nothing. A value is present when it is not `undefined`, `null` or `""`. A path's
  holders (the objects that hold its last step) are what part 2 also searches for lifecycle keys.
  A tool offers a path when each step is a declared property of its input schema, read through
  `items` after `[]`. A declaration of 1 to 16 distinct well-formed paths is usable. Registration
  preflight refuses a connector whose definition declares anything else, before it contacts the
  vendor; a test pins every built-in declaration; and a malformed declaration that is ever served
  anyway is served as no declaration, so part 2 treats every write as a change (never a create).
  The module is vendor-neutral and lives in contracts, because both the gateway (presenting) and
  the orchestrator (classifying) use it.

---

### Task 1: Characterize the catalog route for an annotated vendor tool

Pins, before any code changes, the fields and schema hash the connector route serves for a vendor
tool that carries MCP annotations. It passes on mainline plus 14a and 14b PR A.

**Files:**
- Modify: `tests/contract/generic-connector-routes.test.ts` (append one `describe` block at the end)

**Interfaces:**
- Consumes: `trackerBroker`, `trackerConfig`, `registerTrackerKey`, `service`, `call`, already in that file.
- Produces: the `describe("vendor tool annotations on the connector route (feature 014)")` block
  with `annotated` and `annotatedConfig`, extended by Task 3.

- [ ] **Step 1: Append the characterization**

```ts
describe("vendor tool annotations on the connector route (feature 014)", () => {
  const annotated = { name: "close_item", description: "Close an item", annotations: { title: "Close item", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: "object", properties: { siteId: { type: "string" }, id: { type: "string" } }, required: ["siteId", "id"] } };
  const annotatedConfig = { ...trackerConfig, scopes: [{ alias: "payments", siteId: "site-payments-1" }],
    tools: [{ name: "list_items", access: "read" }, { name: "create_item", access: "write" }, { name: "close_item", access: "write" }] };

  it("serves each tool with exactly the six fields an older Slack service parses, and a hash that already covers the annotations (characterization)", async () => {
    const { handler, path } = await trackerBroker({ extraTools: [annotated], config: annotatedConfig });
    expect((await registerTrackerKey(handler)).status).toBe(201);
    const discovered = await call(handler, { method: "GET", path: `${path}/tools`, service });
    const catalog = ConnectorCatalogSchema.parse(discovered.body.catalog);
    expect(catalog.tools.map((tool) => Object.keys(tool).sort())).toEqual(Array(3).fill(["access", "description", "inputSchema", "name", "scopes", "upstreamName"]));
    expect(catalog.tools.find((tool) => tool.name === "tracker__close_item")!.scopes).toEqual([{ alias: "payments", schemaHash: "c5c4fb16e67e06a1fda262e7262e6b5a64b59f5bd85beef35923851dcdb16728" }]);
  });
});
```

- [ ] **Step 2: Run it; it passes on the unchanged code**

Run: `export PATH=/private/tmp/claude-501/node-v22.20.0-darwin-arm64/bin:$PATH && npm run build && npx vitest run tests/contract/generic-connector-routes.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/contract/generic-connector-routes.test.ts
git commit -m "test(broker): characterize the catalog of an annotated vendor tool before the action gate

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Contracts for the action policy, hints and item arguments

**Files:**
- Create: `packages/contracts/src/action-policy.ts`, `packages/contracts/src/item-paths.ts`
- Modify: `packages/contracts/src/connectors.ts`, `project.ts`, `slack.ts`, `index.ts`
- Test: `tests/contract/action-policy-contracts.test.ts`, `tests/contract/item-paths.test.ts`

**Interfaces:**
- Produces:

```ts
export const IN_HOUSE_TOOL_NAMES: readonly [...six agentx_* names];
export const ToolPatternSchema, ActionPolicyRuleSchema, ActionPolicySchema;
export type ActionPolicyRule = { tool: string; connector?: string; whenArguments?: string[]; outcome?: "allow" | "ask" | "deny"; treatAs?: "read" | "create" | "change" | "destructive"; reason?: string };
export type ActionPolicy = { rules: ActionPolicyRule[] };
export function toolPatternMatches(pattern: string, name: string): boolean;
export function actionPolicyProblems(project): string[];
export const ToolHintsSchema; export type ToolHints = { readOnlyHint?: boolean; destructiveHint?: boolean };
// PresentedTool gains hints?: ToolHints and itemArguments?: string[] (item argument paths)
export const ITEM_PATH_MAX_STEPS = 4;
export const ItemPathSchema; // a name, a.b or a[].b, at most four steps (R7)
export interface ItemPathStep { name: string; each: boolean }
export function parseItemPath(path: string): ItemPathStep[] | undefined;
export function itemPathProblems(paths: readonly string[] | undefined): string[];
export function itemPathHolders(args: Record<string, unknown>, path: string): Array<Record<string, unknown>>;
export function itemPathValues(args: Record<string, unknown>, path: string): unknown[];
export function schemaHasItemPath(inputSchema: Record<string, unknown>, path: string): boolean;
export function connectorApprovals(definition): Array<{ name: string; tools: ReadonlyArray<{ name: string }> }>;
// ProjectDefinition, StoredProjectDefinition and the WORKSPACE thread result gain actionPolicy?: ActionPolicy
```

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/action-policy-contracts.test.ts
import { describe, expect, it } from "vitest";
import {
  ActionPolicySchema,
  IN_HOUSE_TOOL_NAMES,
  PresentedToolSchema,
  ProjectDefinitionSchema,
  SlackThreadWorkspaceResultSchema,
  StoredProjectDefinitionSchema,
  toolPatternMatches,
} from "../../packages/contracts/src/index.js";
import { ORCHESTRATION_TOOL_NAMES } from "../../packages/orchestrator/src/orchestration-tools.js";

const repository = { name: "api", url: "https://github.com/example/api.git", path: "repo/api", defaultBranch: "main", credentialRef: "github-app" };
const project = (actionPolicy: unknown, connectors: unknown[] = [{ name: "github", type: "github", scopes: "all-repositories", tools: [{ name: "list_issues", access: "read" }, { name: "issue_write", access: "write" }] }]) => ({
  name: "payments", revision: 1, repositories: [repository], setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  integrations: { connectors }, actionPolicy,
});
const issues = (value: unknown) => {
  const parsed = ProjectDefinitionSchema.safeParse(value);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
};

describe("action policy contracts", () => {
  it("names the same in-house tools as the orchestrator", () => {
    expect([...IN_HOUSE_TOOL_NAMES]).toEqual([...ORCHESTRATION_TOOL_NAMES]);
  });

  it("matches tool patterns whole, with * as any run of characters", () => {
    expect(toolPatternMatches("save_issue", "save_issue")).toBe(true);
    expect(toolPatternMatches("save_issue", "save_issues")).toBe(false);
    expect(toolPatternMatches("delete_*", "delete_comment")).toBe(true);
    expect(toolPatternMatches("*__save_*", "linear__save_issue")).toBe(true);
    expect(toolPatternMatches("*", "anything")).toBe(true);
    expect(toolPatternMatches("save-issue", "save_issue")).toBe(false);
  });

  it("requires exactly one of outcome and treatAs, and refuses unknown fields and bad patterns", () => {
    expect(ActionPolicySchema.safeParse({ rules: [{ tool: "delete_*", connector: "linear", outcome: "deny" }] }).success).toBe(true);
    for (const treatAs of ["read", "create", "change", "destructive"]) {
      expect(ActionPolicySchema.safeParse({ rules: [{ tool: "save_issue", connector: "linear", treatAs }] }).success).toBe(true);
    }
    expect(ActionPolicySchema.safeParse({ rules: [{ tool: "save_issue", connector: "linear", treatAs: "write" }] }).success).toBe(false);
    expect(ActionPolicySchema.safeParse({ rules: [{ tool: "save_issue", outcome: "ask", treatAs: "change" }] }).success).toBe(false);
    expect(ActionPolicySchema.safeParse({ rules: [{ tool: "save_issue" }] }).success).toBe(false);
    expect(ActionPolicySchema.safeParse({ rules: [{ tool: "save_issue", outcome: "maybe" }] }).success).toBe(false);
    expect(ActionPolicySchema.safeParse({ rules: [{ tool: "save issue", outcome: "ask" }] }).success).toBe(false);
    expect(ActionPolicySchema.safeParse({ rules: [{ tool: "save_issue", outcome: "ask", when: "always" }] }).success).toBe(false);
    expect(ActionPolicySchema.safeParse({ rules: [] }).success).toBe(false);
  });

  it("registers rules that name a configured connector's approved tools, a presented name or an in-house tool", () => {
    expect(issues(project({ rules: [
      { tool: "issue_write", connector: "github", whenArguments: ["state"], treatAs: "destructive" },
      { tool: "github__list_*", outcome: "allow" },
      { tool: "agentx_create_pull_request", outcome: "ask", reason: "Pull requests need a person." },
    ] }))).toEqual([]);
  });

  it("refuses a rule for a connector the project does not configure, or a pattern that matches nothing", () => {
    expect(issues(project({ rules: [{ tool: "save_issue", connector: "linear", outcome: "ask" }] })))
      .toEqual(["action policy rule 1: connector linear is not configured"]);
    expect(issues(project({ rules: [{ tool: "delete_*", connector: "github", outcome: "deny" }] })))
      .toEqual(["action policy rule 1: delete_* matches no approved github tool"]);
    expect(issues(project({ rules: [{ tool: "linear__*", outcome: "deny" }] })))
      .toEqual(["action policy rule 1: linear__* matches no tool this project offers"]);
  });

  it("reads the legacy githubMcp policy as a connector named github", () => {
    const legacy = { ...project({ rules: [{ tool: "issue_write", connector: "github", outcome: "ask" }] }), integrations: { githubMcp: { tools: [{ name: "issue_write", access: "write" }] } } };
    expect(issues(legacy)).toEqual([]);
  });

  it("keeps serving a stored revision with an action policy", () => {
    expect(StoredProjectDefinitionSchema.safeParse(project({ rules: [{ tool: "issue_write", connector: "github", outcome: "ask" }] })).success).toBe(true);
  });

  it("carries a presented tool's two hints and item arguments and nothing else, and an optional action policy on the thread workspace result", () => {
    const tool = { name: "linear__save_issue", upstreamName: "save_issue", description: "Save.", inputSchema: {}, access: "write", scopes: [{ alias: "charterarc", schemaHash: "a".repeat(64) }] };
    expect(PresentedToolSchema.safeParse({ ...tool, hints: { readOnlyHint: false, destructiveHint: true }, itemArguments: ["id"] }).success).toBe(true);
    expect(PresentedToolSchema.safeParse({ ...tool, itemArguments: [] }).success).toBe(true);
    expect(PresentedToolSchema.safeParse({ ...tool, itemArguments: ["task_id", "tasks[].task"] }).success).toBe(true);
    expect(PresentedToolSchema.safeParse({ ...tool, itemArguments: ["has space"] }).success).toBe(false);
    expect(PresentedToolSchema.safeParse({ ...tool, itemArguments: ["tasks[]"] }).success).toBe(false);
    expect(PresentedToolSchema.safeParse({ ...tool, itemArgument: "id" }).success).toBe(false);
    expect(PresentedToolSchema.safeParse({ ...tool, hints: { idempotentHint: true } }).success).toBe(false);
    expect(SlackThreadWorkspaceResultSchema.safeParse({
      outcome: "WORKSPACE", workspaceId: "11111111-1111-4111-8111-111111111111", status: "READY", operationId: null, created: false,
      orchestratorInstructions: "Delegate.", actionPolicy: { rules: [{ tool: "*", outcome: "ask" }] },
    }).success).toBe(true);
  });
});
```

```ts
// tests/contract/item-paths.test.ts
import { describe, expect, it } from "vitest";
import { ITEM_PATH_MAX_STEPS, ItemPathSchema, itemPathHolders, itemPathProblems, itemPathValues, schemaHasItemPath } from "../../packages/contracts/src/index.js";

describe("item argument paths (spec 014)", () => {
  it("accepts a name, a.b and a[].b, with at most four steps", () => {
    expect(ITEM_PATH_MAX_STEPS).toBe(4);
    for (const path of ["id", "issueIdOrKey", "issue_number", "fields.key", "tasks[].task", "a[].b.c[].d"]) expect(ItemPathSchema.safeParse(path).success).toBe(true);
    for (const path of ["", "tasks[]", "tasks[].", ".id", "id.", "a..b", "a[0].b", "a[]b", "a.*.b", "has space", "a.b.c.d.e", "a[].b[].c[].d[].e", "x".repeat(65)]) {
      expect(ItemPathSchema.safeParse(path).success).toBe(false);
    }
  });

  it("finds no item when the path is missing, empty, of another shape or malformed", () => {
    expect(itemPathValues({ title: "x" }, "id")).toEqual([]);
    expect(itemPathValues({ id: "" }, "id")).toEqual([]);
    expect(itemPathValues({ id: null }, "id")).toEqual([]);
    expect(itemPathValues({ tasks: [] }, "tasks[].task")).toEqual([]);
    expect(itemPathValues({ tasks: [{ name: "new" }] }, "tasks[].task")).toEqual([]);
    expect(itemPathValues({ tasks: { task: "11" } }, "tasks[].task")).toEqual([]);
    expect(itemPathValues({ tasks: ["11", "12"] }, "tasks[].task")).toEqual([]);
    expect(itemPathValues({ fields: [{ key: "PAY-7" }] }, "fields.key")).toEqual([]);
    expect(itemPathValues({ tasks: [{ task: "11" }] }, "tasks[]")).toEqual([]);
  });

  it("finds each present item: top level, nested, or in every object of an array", () => {
    expect(itemPathValues({ id: "T-5" }, "id")).toEqual(["T-5"]);
    expect(itemPathValues({ issue_number: 42 }, "issue_number")).toEqual([42]);
    expect(itemPathValues({ fields: { key: "PAY-7" } }, "fields.key")).toEqual(["PAY-7"]);
    expect(itemPathValues({ tasks: [{ task: "11" }, { name: "new" }, { task: "12" }] }, "tasks[].task")).toEqual(["11", "12"]);
    expect(itemPathHolders({ tasks: [{ task: "11", completed: true }, 3, null] }, "tasks[].task")).toEqual([{ task: "11", completed: true }]);
    expect(itemPathHolders({ id: "T-5" }, "id")).toEqual([{ id: "T-5" }]);
  });

  it("never reads deeper than the path's own steps", () => {
    const deep = { a: [{ b: { c: [{ d: "x", e: { f: "y" } }] } }] };
    expect(itemPathValues(deep, "a[].b.c[].d")).toEqual(["x"]);
    expect(itemPathValues(deep, "a[].b.c[].e.f")).toEqual([]);
    expect(itemPathHolders(deep, "a[].b.c[].e.f")).toEqual([]);
  });

  it("reports a malformed, duplicated or empty declaration", () => {
    expect(itemPathProblems(undefined)).toEqual([]);
    expect(itemPathProblems(["id"])).toEqual([]);
    expect(itemPathProblems(["task_id", "tasks[].task"])).toEqual([]);
    expect(itemPathProblems(["id", "tasks[]"])).toEqual(["malformed item argument path \"tasks[]\""]);
    expect(itemPathProblems(["id", "id"])).toEqual(["duplicate item argument path id"]);
    expect(itemPathProblems([])).toEqual(["declare 1 to 16 item argument paths"]);
  });

  it("tells whether a tool's input schema offers a path", () => {
    const schema = { type: "object", properties: {
      id: { type: "string" },
      fields: { type: "object", properties: { key: { type: "string" } } },
      tasks: { type: "array", items: { type: "object", properties: { task: { type: "string" } } } },
    } };
    expect(schemaHasItemPath(schema, "id")).toBe(true);
    expect(schemaHasItemPath(schema, "fields.key")).toBe(true);
    expect(schemaHasItemPath(schema, "tasks[].task")).toBe(true);
    expect(schemaHasItemPath(schema, "tasks.task")).toBe(false);
    expect(schemaHasItemPath(schema, "fields[].key")).toBe(false);
    expect(schemaHasItemPath(schema, "tasks[].name")).toBe(false);
    expect(schemaHasItemPath(schema, "task_id")).toBe(false);
    expect(schemaHasItemPath(schema, "tasks[]")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/contract/action-policy-contracts.test.ts tests/contract/item-paths.test.ts`
Expected: FAIL; `ActionPolicySchema`, `IN_HOUSE_TOOL_NAMES`, `toolPatternMatches` and `ItemPathSchema`
are not exported.

- [ ] **Step 3: Create `packages/contracts/src/action-policy.ts`**

```ts
import { z } from "zod";
import { ConnectorNameSchema, connectorApprovals } from "./connectors.js";

/**
 * The orchestrator's in-house tools, which action policy rules may name. Kept equal to the
 * orchestrator's ORCHESTRATION_TOOL_NAMES by a test, as IN_HOUSE_TOOL_COUNT is.
 */
export const IN_HOUSE_TOOL_NAMES = [
  "agentx_submit_task",
  "agentx_create_pull_request",
  "agentx_task_status",
  "agentx_task_result",
  "agentx_follow_up",
  "agentx_manage_pull_request",
] as const;

/** A tool name in which `*` stands for any run of characters, such as `delete_*`. */
export const ToolPatternSchema = z.string().regex(/^[A-Za-z0-9_*-]{1,64}$/);

/**
 * One administrator rule. With `connector`, `tool` matches that connector's own tool names
 * (`save_item`); without it, `tool` matches the names the model sees (`tracker__save_item`,
 * `agentx_create_pull_request`). `whenArguments` limits the rule to calls that set one of those
 * arguments. A rule either decides (`outcome`) or reclassifies the action (`treatAs`): a read and a
 * create run, a change goes to the classifier, a destructive action always asks.
 */
export const ActionPolicyRuleSchema = z.object({
  tool: ToolPatternSchema,
  connector: ConnectorNameSchema.optional(),
  whenArguments: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)).min(1).max(16).optional(),
  outcome: z.enum(["allow", "ask", "deny"]).optional(),
  treatAs: z.enum(["read", "create", "change", "destructive"]).optional(),
  reason: z.string().min(1).max(200).optional(),
}).strict().refine((rule) => (rule.outcome === undefined) !== (rule.treatAs === undefined), "an action policy rule sets exactly one of outcome and treatAs");

/** A project's additions to the action gate's built-in defaults (feature 014). */
export const ActionPolicySchema = z.object({
  rules: z.array(ActionPolicyRuleSchema).min(1).max(64),
}).strict();

/** Whether a tool name matches a rule's pattern, where `*` is any run of characters. */
export function toolPatternMatches(pattern: string, name: string): boolean {
  // The pattern alphabet has no regular-expression metacharacters besides `*`.
  return new RegExp(`^${pattern.split("*").join(".*")}$`, "u").test(name);
}

type PolicyProject = Parameters<typeof connectorApprovals>[0] & { actionPolicy?: ActionPolicy | undefined };

/**
 * Registration refuses a rule that can never apply: one that names a connector the project does
 * not configure, or whose pattern matches none of the tools it could govern.
 */
export function actionPolicyProblems(project: PolicyProject): string[] {
  const connectors = connectorApprovals(project);
  const presented = [...IN_HOUSE_TOOL_NAMES, ...connectors.flatMap((connector) => connector.tools.map((tool) => `${connector.name}__${tool.name}`))];
  const problems: string[] = [];
  for (const [index, rule] of (project.actionPolicy?.rules ?? []).entries()) {
    const label = `action policy rule ${index + 1}`;
    if (rule.connector === undefined) {
      if (!presented.some((name) => toolPatternMatches(rule.tool, name))) problems.push(`${label}: ${rule.tool} matches no tool this project offers`);
      continue;
    }
    const connector = connectors.find((entry) => entry.name === rule.connector);
    if (!connector) problems.push(`${label}: connector ${rule.connector} is not configured`);
    else if (!connector.tools.some((tool) => toolPatternMatches(rule.tool, tool.name))) problems.push(`${label}: ${rule.tool} matches no approved ${rule.connector} tool`);
  }
  return problems;
}

export type ActionPolicyRule = z.infer<typeof ActionPolicyRuleSchema>;
export type ActionPolicy = z.infer<typeof ActionPolicySchema>;
```

- [ ] **Step 3b: Create `packages/contracts/src/item-paths.ts` (R7)**

```ts
import { z } from "zod";

/** The most steps an item argument path may have, so resolving one is bounded. */
export const ITEM_PATH_MAX_STEPS = 4;

/**
 * Where a connector's tools name an existing item (feature 014): an argument name (`id`), a name
 * inside an object argument (`fields.key`), or a name inside each object of an array argument
 * (`tasks[].task`). A step is 1 to 64 of A-Z, a-z, 0-9, `_` and `-`; a path has at most
 * ITEM_PATH_MAX_STEPS steps (the `{0,3}` below); `[]` only ever comes before a `.`, so the named
 * value itself is never an array.
 */
export const ItemPathSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}(?:(?:\.|\[\]\.)[A-Za-z0-9_-]{1,64}){0,3}$/u);

/** One step of a path. `each` means the value at this step is an array whose objects the next step reads. */
export interface ItemPathStep { name: string; each: boolean }

/** The steps of a well-formed path, or undefined for a malformed one. */
export function parseItemPath(path: string): ItemPathStep[] | undefined {
  if (!ItemPathSchema.safeParse(path).success) return undefined;
  return path.split(".").map((part) => part.endsWith("[]") ? { name: part.slice(0, -2), each: true } : { name: part, each: false });
}

/** Why a connector's declared item arguments cannot be used: malformed, duplicated, none or more than 16. */
export function itemPathProblems(paths: readonly string[] | undefined): string[] {
  if (paths === undefined) return [];
  const problems: string[] = [];
  if (paths.length === 0 || paths.length > 16) problems.push("declare 1 to 16 item argument paths");
  for (const [index, path] of paths.entries()) {
    if (parseItemPath(path) === undefined) problems.push(`malformed item argument path ${JSON.stringify(path.slice(0, 80))}`);
    else if (paths.indexOf(path) !== index) problems.push(`duplicate item argument path ${path}`);
  }
  return problems;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A value that names something: not undefined, null or the empty string. */
function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

/**
 * The objects that hold a path's last step in a call's arguments: the arguments themselves for a
 * name, the object at `a` for `a.b`, and each object of the array at `a` for `a[].b`. A value of any
 * other shape, and a malformed path, holds nothing. It never reads deeper than the path's own steps.
 */
export function itemPathHolders(args: Record<string, unknown>, path: string): Array<Record<string, unknown>> {
  const steps = parseItemPath(path);
  if (steps === undefined) return [];
  let holders: Array<Record<string, unknown>> = [args];
  for (const step of steps.slice(0, -1)) {
    holders = holders.flatMap((holder) => {
      const value = Object.hasOwn(holder, step.name) ? holder[step.name] : undefined;
      if (step.each) return Array.isArray(value) ? value.filter(isPlainObject) : [];
      return isPlainObject(value) ? [value] : [];
    });
  }
  return holders;
}

/** The present values a path names in a call's arguments; empty when it is missing, empty or malformed. */
export function itemPathValues(args: Record<string, unknown>, path: string): unknown[] {
  const last = parseItemPath(path)?.at(-1)?.name;
  if (last === undefined) return [];
  return itemPathHolders(args, path).flatMap((holder) => Object.hasOwn(holder, last) && isPresent(holder[last]) ? [holder[last]] : []);
}

/** Whether a tool's input schema offers a path: each step a declared property, read through `items` after `[]`. */
export function schemaHasItemPath(inputSchema: Record<string, unknown>, path: string): boolean {
  const steps = parseItemPath(path);
  if (steps === undefined) return false;
  let schema: unknown = inputSchema;
  for (const step of steps) {
    const properties = isPlainObject(schema) && isPlainObject(schema.properties) ? schema.properties : undefined;
    if (properties === undefined || !Object.hasOwn(properties, step.name)) return false;
    schema = properties[step.name];
    if (step.each) schema = isPlainObject(schema) ? schema.items : undefined;
  }
  return true;
}
```

- [ ] **Step 4: Hints, item arguments and `connectorApprovals` in `packages/contracts/src/connectors.ts`**

Add `import { ItemPathSchema } from "./item-paths.js";` after the `zod` import, and replace the
`PresentedToolSchema` declaration with:

```ts
/**
 * The two MCP tool annotations the action gate reads (feature 014). They come from the vendor, so
 * the gate lets them make a tool stricter, never looser.
 */
export const ToolHintsSchema = z.object({
  readOnlyHint: z.boolean().optional(),
  destructiveHint: z.boolean().optional(),
}).strict();

export const PresentedToolSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  upstreamName: McpToolNameSchema,
  description: z.string().max(2_048),
  inputSchema: z.record(z.string(), z.unknown()),
  access: z.enum(["read", "write"]),
  scopes: z.array(z.object({ alias: ConnectorAliasSchema, schemaHash: SchemaHashSchema }).strict()).min(1).max(32),
  // The two fields below are sent only to a Slack service that sends x-agentx-include: gate;
  // older services parse this schema strictly (feature 014).
  hints: ToolHintsSchema.optional(),
  /**
   * The connector's item argument paths (item-paths.ts) that this tool's schema offers, in the
   * connector's order; a call that sets any of them names an existing item. Empty when the connector
   * declares paths and this tool offers none (so a call creates), absent when the connector declares
   * none.
   */
  itemArguments: z.array(ItemPathSchema).max(16).optional(),
}).strict();
```

Add `export type ToolHints = z.infer<typeof ToolHintsSchema>;` directly above
`export type PresentedTool = ...`, and directly above `export function presentedNameProblems`:

```ts
/** Each connector's name and approved tools. The feature 007 githubMcp policy reads as a connector named github. */
export function connectorApprovals(definition: ConnectorApprovals): Array<{ name: string; tools: ReadonlyArray<{ name: string }> }> {
  return definition.integrations?.githubMcp
    ? [{ name: "github", tools: definition.integrations.githubMcp.tools }]
    : [...(definition.integrations?.connectors ?? [])];
}
```

- [ ] **Step 5: `actionPolicy` on the project and the thread workspace result**

In `packages/contracts/src/project.ts`, add
`import { ActionPolicySchema, actionPolicyProblems } from "./action-policy.js";` above the
`github-mcp.js` import; add `actionPolicy: ActionPolicySchema.optional(),` after the `integrations`
entry of `projectDefinitionObject`; and replace the `ProjectDefinitionSchema` line with:

```ts
export const ProjectDefinitionSchema = projectDefinitionObject(ConnectorsSchema)
  .superRefine(checkProjectDefinition)
  // Only registration checks that each rule can apply; a stored revision was checked when registered.
  .superRefine((project, context) => {
    for (const message of actionPolicyProblems(project)) context.addIssue({ code: "custom", path: ["actionPolicy"], message });
  });
```

In `packages/contracts/src/slack.ts`, add `import { ActionPolicySchema } from "./action-policy.js";`
above the `connectors.js` import, and in the `WORKSPACE` object of
`SlackThreadWorkspaceResultSchema`, after `settingsRevision`:

```ts
      // The latest revision's action policy, sent only to a service that sends includeActionPolicy: true.
      actionPolicy: ActionPolicySchema.optional(),
```

In `packages/contracts/src/index.ts`, add `export * from "./action-policy.js";` as the first line
and `export * from "./item-paths.js";` as the second.

- [ ] **Step 6: Run it and watch it pass**

Run: `npm run build && npx vitest run tests/contract/action-policy-contracts.test.ts tests/contract/item-paths.test.ts tests/contract/connector-config.test.ts tests/contract/contracts.test.ts tests/contract/slack-contracts.test.ts tests/contract/lazy-workspace-contracts.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/src tests/contract/action-policy-contracts.test.ts tests/contract/item-paths.test.ts
git commit -m "feat(contracts): action policy, tool hints and item argument paths for the action gate

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Carry hints and item arguments through discovery, on opt-in

**Files:**
- Modify: `packages/gateway/src/mcp-client.ts`, `types.ts`, `engine.ts`, `catalog.ts`, `github.ts`,
  `linear.ts`, `jira.ts`; `packages/broker/src/aws/connector-routes.ts`; `packages/broker/src/aws/broker.ts` (connector route);
  `packages/broker/src/aws/registration-preflight.ts` (R7 refusal)
- Modify: `tests/support/vendor-fixtures.ts` (append), `tests/support/tracker-connector.ts` (one field),
  `tests/contract/generic-connector-routes.test.ts` (extend Task 1's block),
  `tests/contract/registration-preflight.test.ts` (append one test)
- Test: `tests/contract/gateway-hints.test.ts`

**Interfaces:**
- Consumes: `ToolHints`, `itemPathProblems`, `schemaHasItemPath` (Task 2); Task 1's `annotated` and `annotatedConfig`.
- Produces: `McpToolAnnotations`; `CatalogTool.hints`; `ConnectorDefinition.itemArguments?: readonly string[]` (paths, R7);
  `presentCatalog({ ..., itemArguments? })`; `PresentedCatalogTool.hints` and `.itemArguments?: string[]`;
  `discoverConnector({ ..., includeGateFields? })`; `vendorToolsWithAnnotations(vendor)`.

- [ ] **Step 1: Add the fixture loader that keeps annotations**

Append to `tests/support/vendor-fixtures.ts`:

```ts
/** The same tools with the vendor's MCP annotations kept, as the SDK's listTools returns them (feature 014). */
export function vendorToolsWithAnnotations(vendor: VendorFixture): McpConnection["tools"] {
  const raw = JSON.parse(readFileSync(new URL(`../fixtures/vendors/${vendor}-tools.json`, import.meta.url), "utf8")) as Array<{
    name: string; description?: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown>;
  }>;
  return raw.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, ...(annotations === undefined ? {} : { annotations }) }));
}
```

In `tests/support/tracker-connector.ts`, after `attributionKeys: ["body"],` in the definition, add
`itemArguments: ["id"],`.

- [ ] **Step 2: Write the failing tests**

```ts
// tests/contract/gateway-hints.test.ts
import { describe, expect, it } from "vitest";
import { itemPathProblems } from "../../packages/contracts/src/index.js";
import { githubConnector, jiraConnector, linearBinder, linearConnector, presentCatalog, reviewTools, type CatalogTool } from "../../packages/gateway/src/index.js";
import { vendorTools, vendorToolsWithAnnotations } from "../support/vendor-fixtures.js";

const scope = { alias: "charterarc", teamId: "c408e946-78aa-4db8-923e-f78053dd954f" };
const approvals = [
  { name: "list_issues", access: "read" as const },
  { name: "save_issue", access: "write" as const },
  { name: "delete_comment", access: "write" as const },
];
const context = { workspaceId: "w", ownerKey: "o", scopeAlias: "charterarc", scope, policy: { tools: approvals } };

describe("vendor hints through discovery", () => {
  it("keeps readOnlyHint and destructiveHint from the recorded Linear annotations, and nothing else", () => {
    const reviewed = reviewTools({ tools: vendorToolsWithAnnotations("linear") }, { binder: linearBinder }, context);
    expect(reviewed.tools.map((tool) => [tool.name, tool.hints])).toEqual([
      ["list_issues", { readOnlyHint: true, destructiveHint: false }],
      ["save_issue", { readOnlyHint: false, destructiveHint: true }],
      ["delete_comment", { readOnlyHint: false, destructiveHint: true }],
    ]);
  });

  it("adds no hints when the vendor sent none, or sent them as something other than booleans", () => {
    expect(reviewTools({ tools: vendorTools("linear") }, { binder: linearBinder }, context).tools.every((tool) => !("hints" in tool))).toBe(true);
    const odd = vendorToolsWithAnnotations("linear").map((tool) => ({ ...tool, annotations: { readOnlyHint: "yes", destructiveHint: 1 } }));
    expect(reviewTools({ tools: odd }, { binder: linearBinder }, context).tools.every((tool) => !("hints" in tool))).toBe(true);
  });

  it("merges hints across scopes, keeping the stricter reading", () => {
    const tool = (alias: string, hints?: CatalogTool["hints"]): CatalogTool => ({
      name: "close_item", scope: alias, description: "Close an item.", access: "write", schemaHash: alias.padEnd(64, "0"),
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
      ...(hints === undefined ? {} : { hints }),
    });
    const present = (first?: CatalogTool["hints"], second?: CatalogTool["hints"]) => presentCatalog({
      connector: "tracker", label: "Tracker", scopeNoun: "site", approvals: [{ name: "close_item" }],
      scopes: [{ alias: "payments", tools: [tool("payments", first)] }, { alias: "billing", tools: [tool("billing", second)] }],
    }).tools[0]!.hints;
    expect(present({ readOnlyHint: false, destructiveHint: true }, { readOnlyHint: false, destructiveHint: false })).toEqual({ readOnlyHint: false, destructiveHint: true });
    expect(present({ readOnlyHint: true, destructiveHint: false }, { readOnlyHint: true, destructiveHint: false })).toEqual({ readOnlyHint: true, destructiveHint: false });
    expect(present({ readOnlyHint: true }, undefined)).toBeUndefined();
    expect(present(undefined, undefined)).toBeUndefined();
  });

  it("names the argument through which each presented tool addresses an existing item, from the connector's data", () => {
    const unused = { issue: () => { throw new Error("not used"); } };
    const reviewed = reviewTools({ tools: vendorToolsWithAnnotations("linear") }, { binder: linearBinder }, context);
    const presented = presentCatalog({
      connector: "linear", label: "Linear", scopeNoun: "team", approvals: approvals.map(({ name }) => ({ name })),
      scopes: [{ alias: "charterarc", tools: reviewed.tools }], itemArguments: linearConnector(unused).itemArguments,
    });
    expect(presented.tools.map((tool) => [tool.name, tool.itemArguments])).toEqual([
      ["linear__list_issues", []], ["linear__save_issue", ["id"]], ["linear__delete_comment", ["id"]],
    ]);
    expect(jiraConnector(unused, { projectScoped: true }).itemArguments).toEqual(["issueIdOrKey"]);
    const undeclared = presentCatalog({ connector: "linear", label: "Linear", scopeNoun: "team", approvals: [{ name: "save_issue" }], scopes: [{ alias: "charterarc", tools: reviewed.tools }] });
    expect(undeclared.tools[0]).not.toHaveProperty("itemArguments");
  });

  it("declares only well-formed item argument paths for every built-in connector", () => {
    const unused = { issue: () => { throw new Error("not used"); } };
    const github = githubConnector(() => { throw new Error("not used"); });
    for (const declared of [github.itemArguments, linearConnector(unused).itemArguments, jiraConnector(unused, { projectScoped: true }).itemArguments]) {
      expect(declared).toBeDefined();
      expect(itemPathProblems(declared)).toEqual([]);
    }
  });

  it("offers an item argument path inside an array of objects, and serves a malformed declaration as none", () => {
    const tool: CatalogTool = {
      name: "update_items", scope: "payments", description: "Update items.", access: "write", schemaHash: "a".repeat(64),
      inputSchema: { type: "object", properties: { items: { type: "array", items: { type: "object", properties: { item: { type: "string" }, completed: { type: "boolean" } } } } }, additionalProperties: false },
    };
    const present = (itemArguments: readonly string[]) => presentCatalog({
      connector: "tracker", label: "Tracker", scopeNoun: "site", approvals: [{ name: "update_items" }], scopes: [{ alias: "payments", tools: [tool] }], itemArguments,
    }).tools[0]!;
    expect(present(["item_id", "items[].item"]).itemArguments).toEqual(["items[].item"]);
    expect(present(["items.item"]).itemArguments).toEqual([]);
    expect(present(["item_id", "items[]"])).not.toHaveProperty("itemArguments");
  });

  it("offers no item argument that an administrator's allowedArguments removed", () => {
    const narrowed = reviewTools({ tools: vendorToolsWithAnnotations("linear") }, { binder: linearBinder },
      { ...context, policy: { tools: [{ name: "save_issue", access: "write" as const, allowedArguments: ["title", "description"] }] } });
    const presented = presentCatalog({ connector: "linear", label: "Linear", scopeNoun: "team", approvals: [{ name: "save_issue" }], scopes: [{ alias: "charterarc", tools: narrowed.tools }], itemArguments: ["id"] });
    expect(presented.tools[0]!.itemArguments).toEqual([]);
  });
});
```

In `tests/contract/generic-connector-routes.test.ts`, replace the final `});` of Task 1's block
(the last line of the file) with:

```ts
  it("adds the vendor's hints and the item argument only for a service that sends x-agentx-include: gate, and keeps the hash", async () => {
    const { handler, path } = await trackerBroker({ extraTools: [annotated], config: annotatedConfig });
    expect((await registerTrackerKey(handler)).status).toBe(201);
    const catalog = ConnectorCatalogSchema.parse((await call(handler, { method: "GET", path: `${path}/tools`, service, headers: { "x-agentx-include": "gate" } })).body.catalog);
    const close = catalog.tools.find((tool) => tool.name === "tracker__close_item")!;
    expect(close.hints).toEqual({ readOnlyHint: false, destructiveHint: true });
    expect(catalog.tools.map((tool) => [tool.name, tool.itemArguments])).toEqual([["tracker__list_items", []], ["tracker__create_item", []], ["tracker__close_item", ["id"]]]);
    expect(close.scopes).toEqual([{ alias: "payments", schemaHash: "c5c4fb16e67e06a1fda262e7262e6b5a64b59f5bd85beef35923851dcdb16728" }]);
    expect(catalog.tools.filter((tool) => tool.hints !== undefined).map((tool) => tool.name)).toEqual(["tracker__close_item"]);
    const plain = ConnectorCatalogSchema.parse((await call(handler, { method: "GET", path: `${path}/tools?include=gate`, service, headers: { "x-agentx-include": "other" } })).body.catalog);
    expect(plain.tools.every((tool) => tool.hints === undefined && !("itemArguments" in tool))).toBe(true);
  });
});
```

- [ ] **Step 3: Run them and watch them fail**

Run: `npm run build && npx vitest run tests/contract/gateway-hints.test.ts tests/contract/generic-connector-routes.test.ts`
Expected: FAIL; no tool has `hints` or `itemArguments`. Task 1's characterization still passes.

- [ ] **Step 4: Type the annotations and the item arguments**

In `packages/gateway/src/mcp-client.ts`, replace the start of `McpConnection` with:

```ts
/** MCP tool annotations as a vendor sends them. Only the two hints the action gate reads are typed. */
export interface McpToolAnnotations {
  readOnlyHint?: unknown;
  destructiveHint?: unknown;
  [key: string]: unknown;
}

export interface McpConnection {
  tools: Array<{ name: string; description?: string | undefined; inputSchema: Record<string, unknown>; annotations?: McpToolAnnotations | undefined }>;
```

In `packages/gateway/src/types.ts`, change the first import to
`import type { SlackRequester, ToolHints } from "@agentx/contracts";`, add after `attributionKeys`
in `ConnectorDefinition`:

```ts
  /**
   * The argument paths through which this vendor's tools name an existing item, most specific first
   * (feature 014): a name, `a.b` or `a[].b` (contracts item-paths.ts). The action gate treats a call
   * in which any of them resolves to a present value as a change, and a call on a tool that offers
   * none of them as a create. Connector data, so the gate itself names no vendor.
   */
  itemArguments?: readonly string[];
```

and as the last field of `CatalogTool`:

```ts
  /** The vendor's readOnlyHint and destructiveHint, when it sent them as booleans (feature 014). Never hashed separately. */
  hints?: ToolHints | undefined;
```

- [ ] **Step 5: Read the hints in `packages/gateway/src/engine.ts`**

Change the imports to:

```ts
import { AgentXError, agentXError, errorStatus, type ToolHints } from "@agentx/contracts";
import { connectMcp, McpUnauthorized, type McpConnection, type McpToolAnnotations } from "./mcp-client.js";
```

In `review`, after `access: policy.access,` in the pushed tool, add `...toolHints(upstream.annotations),`
(the `schemaHash` line is not edited), and above `export function approveTools`:

```ts
/** The two MCP annotations the action gate reads, kept only when the vendor sent them as booleans. */
function toolHints(annotations: McpToolAnnotations | undefined): { hints: ToolHints } | Record<string, never> {
  const hints: ToolHints = {};
  if (typeof annotations?.readOnlyHint === "boolean") hints.readOnlyHint = annotations.readOnlyHint;
  if (typeof annotations?.destructiveHint === "boolean") hints.destructiveHint = annotations.destructiveHint;
  return Object.keys(hints).length > 0 ? { hints } : {};
}
```

- [ ] **Step 6: Present them in `packages/gateway/src/catalog.ts`**

Add `import { itemPathProblems, schemaHasItemPath, type ToolHints } from "@agentx/contracts";` as
the first line. Add to `PresentedCatalogTool`, after `scopes`:

```ts
  hints?: ToolHints | undefined;
  /** See PresentedToolSchema.itemArguments: the declared paths this tool offers, [] for none, absent when the connector declares none. */
  itemArguments?: string[] | undefined;
```

Add to `presentCatalog`'s input type, after `scopes`:

```ts
  /** The connector's item argument paths (ConnectorDefinition.itemArguments). */
  itemArguments?: readonly string[] | undefined;
```

After the `scopes:` line of the pushed tool, add:

```ts
      ...mergeHints(entries.map(({ tool }) => tool.hints)),
      // A malformed declaration is served as none, so the gate treats every write as a change (R7).
      ...(input.itemArguments === undefined || itemPathProblems(input.itemArguments).length > 0
        ? {}
        : { itemArguments: input.itemArguments.filter((path) => schemaHasItemPath(inputSchema, path)) }),
```

and above `function describe(`:

```ts
/** Across scopes the stricter reading wins: destructive if any scope says so, read-only only if every scope says so. */
function mergeHints(all: ReadonlyArray<ToolHints | undefined>): { hints: ToolHints } | Record<string, never> {
  const hints: ToolHints = {};
  if (all.some((entry) => entry?.destructiveHint === true)) hints.destructiveHint = true;
  else if (all.every((entry) => entry?.destructiveHint === false)) hints.destructiveHint = false;
  if (all.some((entry) => entry?.readOnlyHint === false)) hints.readOnlyHint = false;
  else if (all.every((entry) => entry?.readOnlyHint === true)) hints.readOnlyHint = true;
  return Object.keys(hints).length > 0 ? { hints } : {};
}
```

- [ ] **Step 7: Declare each connector's item arguments**

In `packages/gateway/src/github.ts`, after `attributionKeys: ["body"],` in `githubConnector`:
`itemArguments: ["issue_number", "pull_number"],`. In `packages/gateway/src/linear.ts`, after
`attributionKeys: ["description", "body"],` in `linearConnector`:

```ts
    // save_issue and save_comment update the item named by id, and create one without it.
    itemArguments: ["id"],
```

In `packages/gateway/src/jira.ts`, after `attributionKeys: ["description", "commentBody"],` in
`jiraConnector`: `itemArguments: ["issueIdOrKey"],`.

- [ ] **Step 8: Serve them only on opt-in (broker)**

In `packages/broker/src/aws/connector-routes.ts`, add `type PresentedCatalogTool,` to the
`@agentx/gateway` import, and add to `discoverConnector`'s input type, after spec 013 phase 4's
`refresh` (which follows `catalogs`). Replace

```ts
  catalogs: CatalogCache<ScopeDiscovery>;
  refresh?: boolean;
}): Promise<ConnectorCatalog> {
```

with

```ts
  catalogs: CatalogCache<ScopeDiscovery>;
  refresh?: boolean;
  /** Only a Slack service that asks gets the action gate's fields; an older one parses each tool strictly. */
  includeGateFields?: boolean;
}): Promise<ConnectorCatalog> {
```

Then replace its last two lines

```ts
  const presented = presentCatalog({ connector: connector.name, label: connector.vendor, scopeNoun: connector.scopeNoun, approvals: connector.approvals, scopes });
  return { connector: connector.name, tools: presented.tools, skipped: presented.skipped };
}
```

with

```ts
  const presented = presentCatalog({
    connector: connector.name, label: connector.vendor, scopeNoun: connector.scopeNoun, approvals: connector.approvals, scopes,
    itemArguments: definition.itemArguments,
  });
  return { connector: connector.name, tools: input.includeGateFields === true ? presented.tools : presented.tools.map(withoutGateFields), skipped: presented.skipped };
}

function withoutGateFields(tool: PresentedCatalogTool): PresentedCatalogTool {
  const copy = { ...tool };
  delete copy.hints;
  delete copy.itemArguments;
  return copy;
}
```

In `packages/broker/src/aws/broker.ts`, in the connector route, keep spec 013 phase 4's `refresh`
query and replace

```ts
      return json({ catalog: await discoverConnector({ connector, workspace, context, catalogs: dependencies.catalogs, refresh: url.searchParams.get("refresh") === "1" }) }, request.requestId);
```

with

```ts
      // Only a Slack service that sends x-agentx-include: gate gets the action gate's fields (feature 014).
      const includeGateFields = request.headers["x-agentx-include"]?.split(",").map((entry) => entry.trim()).includes("gate") === true;
      return json({ catalog: await discoverConnector({
        connector, workspace, context, catalogs: dependencies.catalogs, refresh: url.searchParams.get("refresh") === "1", includeGateFields,
      }) }, request.requestId);
```

- [ ] **Step 8b: Refuse a malformed declaration at registration (R7)**

Append to the `"registration preflight across connector types"` block of
`tests/contract/registration-preflight.test.ts` (replace that block's closing `});`):

```ts
  it("refuses a connector whose definition declares a malformed item argument path, before contacting its vendor", async () => {
    const project = ProjectDefinitionSchema.parse(definition(githubConnector(["list_issues"])));
    const connect = vi.fn();
    const malformed: ResolvedConnector = {
      name: "paths", type: "paths", label: "Paths connector", vendor: "Paths",
      scopeNoun: "scope", scopes: [{ alias: "only", scope: {} }],
      policy: { tools: [] }, approvals: [], attribution: false,
      ledger: { prefix: "CONNECTOR#paths#", entityType: "CONNECTOR_INVOCATION" },
      connect, configured: async () => true,
      definition: () => Promise.resolve({
        label: "Paths", endpoint: new URL("https://mcp.paths.test/mcp"), permissionsHint: "Paths permissions",
        credentials: { issue: () => Promise.reject(new Error("not used")) },
        binder: { properties: [], bind: () => ({}) }, guards: [],
        itemArguments: ["id", "tasks[]"],
      }),
    };

    const result = await preflightConnectors([malformed], project, "owner-key");
    expect(result.refusals).toEqual(["connector paths: malformed item argument path \"tasks[]\""]);
    expect(result.report.connectors).toEqual([
      { name: "paths", status: "unavailable", problem: "connector paths declares unusable item arguments", offered: [], skipped: [] },
    ]);
    expect(connect).not.toHaveBeenCalled();
  });
});
```

In `packages/broker/src/aws/registration-preflight.ts`, add `itemPathProblems` to the
`@agentx/contracts` import, and directly after the `if ("notConnected" in resolved) { ... }` block of
`preflightConnector`:

```ts
  // Item argument paths are the connector's own data (feature 014, R7). A malformed declaration is
  // refused here, before any vendor contact; if one were served anyway, it is served as none.
  const pathProblems = itemPathProblems(resolved.itemArguments);
  if (pathProblems.length > 0) {
    return {
      entry: { name: connector.name, status: "unavailable", problem: `connector ${connector.name} declares unusable item arguments`, offered: [], skipped: [] },
      refusals: pathProblems.map((problem) => `connector ${connector.name}: ${problem}`),
    };
  }
```

- [ ] **Step 9: Run them and watch them pass, with GitHub and the snapshots unchanged**

Run: `npm run build && npx vitest run tests/contract/gateway-hints.test.ts tests/contract/generic-connector-routes.test.ts tests/contract/gateway-binding.test.ts tests/contract/slack-control-plane.test.ts tests/contract/tool-presentation.test.ts tests/contract/registration-preflight.test.ts tests/contract/connector-types.test.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/gateway/src packages/broker/src/aws/connector-routes.ts packages/broker/src/aws/broker.ts packages/broker/src/aws/registration-preflight.ts tests/support tests/contract/gateway-hints.test.ts tests/contract/generic-connector-routes.test.ts tests/contract/registration-preflight.test.ts
git commit -m "feat(gateway): carry vendor hints and connector item argument paths to services that ask

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Send the action policy on every thread result path, on opt-in (C1)

**Files:**
- Modify: `packages/broker/src/aws/broker.ts` (`ensureThreadWorkspace`, its new-workspace result,
  14b's `createUnpreparedThreadWorkspace`, `existingThreadWorkspace`, `IntegrationInclude`)
- Modify: `packages/slack-service/src/thread-workspace-request.ts`,
  `tests/contract/thread-workspace-request.test.ts` (the one expected line)
- Test: `tests/contract/action-policy-routes.test.ts`

**Interfaces:**
- Consumes: `ProjectDefinition.actionPolicy` and the registration check (Task 2); 14b's `lazyPreparation` opt-in.
- Produces: `includeActionPolicy: true` on `POST /v1/threads/workspace` returns the latest revision's
  `actionPolicy` for new eager, new lazy (`UNPREPARED`) and existing threads.

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/action-policy-routes.test.ts
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { call, createBroker, loadSlackBroker, orchestratorPrincipal, type Handler } from "../support/slack-broker.js";

const team = "T0BSHLLUGBD";
const channel = "C0123456789";
const thread = `${team}/${channel}/1695500000.000001`;
const pratik = "U0123456789";
const admin = { subject: "admin-subject", admin: true };
const policy = { rules: [
  { tool: "issue_write", connector: "github", whenArguments: ["state"], treatAs: "destructive" },
  { tool: "agentx_create_pull_request", outcome: "ask", reason: "Pull requests need a person." },
] };

beforeAll(async () => { await loadSlackBroker(); });

function register(handler: Handler, revision: number, actionPolicy?: unknown) {
  return call(handler, { method: "POST", path: "/v1/admin/projects", user: admin, body: {
    definition: {
      name: "payments", revision,
      repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }],
      setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
      integrations: { connectors: [{ name: "github", type: "github", scopes: "all-repositories", tools: [{ name: "list_issues", access: "read" }, { name: "issue_write", access: "write" }] }] },
      ...(actionPolicy === undefined ? {} : { actionPolicy }),
    },
    runtimeBinding: {
      runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/agentx_production_worker-YVirjlFgvk",
      endpointQualifier: "DEFAULT", deploymentMode: "instances-ebs",
      capacityProviderArn: "arn:aws:bedrock-agentcore:us-east-1:111122223333:capacity-provider/agentx_production_capacity_v3-VwkM93EABZ",
    },
  } });
}

async function bound(actionPolicy?: unknown) {
  const { db, handler } = createBroker();
  expect((await register(handler, 1, actionPolicy)).status).toBe(201);
  expect((await call(handler, { method: "PUT", path: `/v1/admin/slack/bindings/${team}/${channel}`, user: admin, body: { projectName: "payments" } })).status).toBe(200);
  return { db, handler };
}

function threadWorkspace(handler: Handler, flags: Record<string, boolean>) {
  return call(handler, { method: "POST", path: "/v1/service/threads/workspace",
    service: { principal: orchestratorPrincipal, thread, slackUser: pratik },
    body: { requestId: randomUUID(), includeIntegrations: true, includeSettingsRevision: true, includeConnectors: true, includeAllConnectorTypes: true, includeRecoverableOperations: true, ...flags } });
}

describe("action policy through the control plane", () => {
  it("sends the latest revision's action policy only to a service that asks for it, for new and existing threads", async () => {
    const { handler } = await bound(policy);
    const created = await threadWorkspace(handler, { includeActionPolicy: true });
    expect(created.status).toBe(200);
    expect(created.body.actionPolicy).toEqual(policy);
    const older = await threadWorkspace(handler, {});
    expect(older.body).not.toHaveProperty("actionPolicy");

    const narrower = { rules: [{ tool: "github__issue_write", outcome: "deny", reason: "Frozen for the audit." }] };
    expect((await register(handler, 2, narrower)).status).toBe(201);
    const existing = await threadWorkspace(handler, { includeActionPolicy: true });
    expect(existing.body).toMatchObject({ created: false, actionPolicy: narrower });
  });

  it("sends the action policy with a new thread's record that has no compute yet, only on opt-in", async () => {
    const { db, handler } = await bound(policy);
    const lazy = await threadWorkspace(handler, { lazyPreparation: true, includeActionPolicy: true });
    expect(lazy.status).toBe(200);
    expect(lazy.body).toMatchObject({ status: "UNPREPARED", created: true, actionPolicy: policy });
    expect(db.find((item) => item.entityType === "SLACK_LIMIT")).toHaveLength(0);
    const secondThread = await call(handler, { method: "POST", path: "/v1/service/threads/workspace",
      service: { principal: orchestratorPrincipal, thread: `${team}/${channel}/1695500000.000002`, slackUser: pratik },
      body: { requestId: randomUUID(), includeConnectors: true, includeAllConnectorTypes: true, lazyPreparation: true } });
    expect(secondThread.body).toMatchObject({ status: "UNPREPARED" });
    expect(secondThread.body).not.toHaveProperty("actionPolicy");
  });

  it("sends no action policy when the project has none", async () => {
    const { handler } = await bound();
    expect((await threadWorkspace(handler, { includeActionPolicy: true })).body).not.toHaveProperty("actionPolicy");
  });

  it("refuses to register a rule that can never apply, and stores nothing", async () => {
    const { db, handler } = await bound(policy);
    const refused = await register(handler, 2, { rules: [{ tool: "delete_*", connector: "github", outcome: "deny" }] });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain("action policy rule 1: delete_* matches no approved github tool");
    expect(db.get("PROJECT#payments", "REV#000000000002")).toBeUndefined();
    const both = await register(handler, 2, { rules: [{ tool: "issue_write", connector: "github", outcome: "ask", treatAs: "change" }] });
    expect(both.status).toBe(400);
    expect(JSON.stringify(both.body)).toContain("exactly one of outcome and treatAs");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run build && npx vitest run tests/contract/action-policy-routes.test.ts`
Expected: the two policy-delivery tests FAIL (`actionPolicy` is undefined); the registration and
no-policy tests pass through Task 2.

- [ ] **Step 3: Add the opt-in to `packages/broker/src/aws/broker.ts`**

In `ensureThreadWorkspace`, replace the `include` object with:

```ts
  // A separate opt-in (feature 014): services released before the action gate parse strictly.
  const includeActionPolicy = input.includeActionPolicy === true;
  const include: IntegrationInclude = {
    integrations: includeIntegrations,
    connectors: includeConnectors,
    allConnectorTypes: includeAllConnectorTypes,
    recoverableOperations: includeRecoverableOperations,
    actionPolicy: includeActionPolicy,
  };
```

Change the interface to
`interface IntegrationInclude { integrations: boolean; connectors: boolean; allConnectorTypes: boolean; recoverableOperations: boolean; actionPolicy: boolean }`.

Add one line after the `settingsRevision` spread in **both** results that read `project.definition`:
the new-workspace result at the end of `ensureThreadWorkspace`, and 14b's
`createUnpreparedThreadWorkspace` (C1):

```ts
    ...(include.actionPolicy && project.definition.actionPolicy ? { actionPolicy: project.definition.actionPolicy } : {}),
```

and after the `settingsRevision` spread of `existingThreadWorkspace`'s `applied` object:

```ts
    ...(include.actionPolicy && settings.definition.actionPolicy ? { actionPolicy: settings.definition.actionPolicy } : {}),
```

14b's older-service branch reaches `existingThreadWorkspace`, so it needs no line of its own.

- [ ] **Step 4: The Slack service opts in (C2)**

In `tests/contract/thread-workspace-request.test.ts`, the expected object's second line becomes
`includeAllConnectorTypes: true, includeRecoverableOperations: true, includeActionPolicy: true,`,
and in `packages/slack-service/src/thread-workspace-request.ts` the returned object's second line
becomes the same. The service parses the field (Task 2) and does not use it until part 2.

- [ ] **Step 5: Run it and watch it pass**

Run: `npm run build && npx vitest run tests/contract/action-policy-routes.test.ts tests/contract/thread-workspace-request.test.ts tests/contract/slack-control-plane.test.ts tests/contract/slack-lazy-workspace.test.ts tests/integration/slack-service.test.ts`
Expected: PASS.

- [ ] **Step 6: Check the whole branch**

Run:

```bash
npm run typecheck && npm run lint && npm run build && npm test
git diff "$(git merge-base HEAD origin/mainline)" -- tests | grep '^-[^-]'
git diff "$(git merge-base HEAD origin/mainline)" --stat -- tests/contract/__snapshots__
```

Expected: all pass; the first `git diff` prints exactly the old
`includeAllConnectorTypes: true, includeRecoverableOperations: true,` line of
`thread-workspace-request.test.ts`; the second prints nothing.

- [ ] **Step 7: Commit**

```bash
git add packages/broker/src/aws/broker.ts packages/slack-service/src/thread-workspace-request.ts tests/contract/thread-workspace-request.test.ts tests/contract/action-policy-routes.test.ts
git commit -m "feat(broker): send the action policy on every thread result, including new threads without compute

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Release

Part 1 changes no behaviour. The release order is as always: runtime (rebuilt, because contracts
changed; no behaviour change), then control plane, then Slack service (it asks for the policy and
parses it, and uses nothing yet). An older Slack service does not send the flag and gets no field. Do not register an `actionPolicy` yet: R6 (C7) applies once part 2 ships.

## Self-Review

1. **Spec coverage.** FR-014's inputs (hints carried, approved access kept, connector item
   argument paths, R7): Tasks 2 and 3. FR-015's schema and strict registration: Tasks 2 and 4. C1 and C2: Task 4. C8:
   own branch, no base check, no hard-coded totals.
2. **Placeholders.** None.
3. **Type consistency.** `ActionPolicy`, `ToolHints`, `ItemPathSchema`, `itemArguments` (connector
   declaration and per-tool field),
   `includeGateFields`, `includeActionPolicy` keep one name and shape across tasks and part 2.
4. **Review Focus.** Each line names its test.
