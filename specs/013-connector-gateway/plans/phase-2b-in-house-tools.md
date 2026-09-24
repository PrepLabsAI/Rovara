# Phase 2b: In-house Tools, Recovery and Attribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the seven pull-request lifecycle tools with one `agentx_manage_pull_request`,
proven call-for-call identical. Offer the two recovery tools only when the thread has an unfinished
operation, tell the model the old names for one release, and sign every connector write that
carries a body or description with the requesting Slack member and thread.

**Architecture:** Changes to the in-house tools are made test-first against characterization
tests that pin today's `OrchestrationApi` calls. The retired tools' fixtures then become the new
tool's mapping tests. The broker reports `recoverableOperations` for `includeConnectors` clients,
and the orchestrator activates recovery tools and adds a manifest line only when that list is
non-empty. Attribution is applied server-side by the gateway engine at call time, like bound
arguments. The broker builds the footer text from the Slack identity and an optional display-name
header, which the Slack service fills from `users.info`.

**Tech Stack:** TypeScript 5.9 strict, Node 22.19–22.x, Zod 4, TypeBox 1.3, Vitest 5, Pi 0.85.1.

**Spec:** [../spec.md](../spec.md): FR-020, FR-021, FR-022, FR-024; tasks T016, T017, T019, T038.

## Global Constraints

- **User requirement, binding:** changes to Pratik's in-house `agentx_*` tools follow strict TDD.
  Characterization tests pin current behavior before any change. Each retired tool has a 1:1 mapping
  test showing the new tool produces the identical `api.managePullRequest` call. No existing test
  assertion is weakened or removed unless this plan names it and states where the same behavior is
  asserted instead.
- The snapshot of the five unchanged in-house tools (`agentx_submit_task`,
  `agentx_create_pull_request`, `agentx_task_status`, `agentx_task_result`, `agentx_follow_up`),
  recorded in Task 1, must stay byte-identical through Task 5.
- Tool parameter schemas stay free of `anyOf`/`oneOf`: express enums as `{ type: "string", enum: [...] }`.
- `/v1/.../github/tools|call` shapes are unchanged. Thread-workspace fields are added only for
  `includeConnectors: true`.
- The attribution footer is appended only to a `body` or `description` argument the model actually
  supplied, only on write tools, and never replaces a value.
- `users:read` is optional. When the name lookup fails, the footer says `Slack member <user ID>`.
- Node `>=22.19.0 <23`; `npm run build` before `npm test`. Node 22:
  `export PATH=/private/tmp/claude-501/node-v22.20.0-darwin-arm64/bin:$PATH`.
- Commit messages `type(scope): summary`, ending
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

1. **A title or body sent with `append`, `sync`, `close` or `reopen`.** The retired tools could not
   send them. The new tool must drop them, not forward them to the broker. Pinned in Task 2.
2. **A thread whose previous turn left an operation running.** The recovery tools and its ID must
   appear. A thread with no such operation must not see them. Pinned in Task 3.
3. **An update call without a body.** The footer must not create a body, because that would erase
   the issue's existing text. Pinned in Task 5.
4. **A redelivered write with attribution.** It must replay from the ledger, not conflict. The
   footer is not part of the request fingerprint. Pinned in Task 5.
5. **A display name with Unicode or control characters.** The header must survive SigV4 signing,
   and the footer must not carry control characters. Pinned in Task 5.

---

## File Structure

| File | Responsibility |
|---|---|
| `tests/support/pull-request-cases.ts` | Shared fixtures for the seven lifecycle actions |
| `tests/contract/pull-request-tools.test.ts` | Characterization (Task 1), then mapping (Task 2) |
| `packages/orchestrator/src/orchestration-tools.ts` | `agentx_manage_pull_request`; `RECOVERY_TOOL_NAMES`; `recovery` option |
| `packages/contracts/src/slack.ts` | `recoverableOperations`; `slackThreadUrl` |
| `packages/broker/src/aws/broker.ts` | `recoverableOperations`; display-name header; footer text |
| `packages/broker/src/auth.ts` | `slack.requesterName` |
| `packages/orchestrator/src/orchestrator.ts`, `manifest.ts` | Conditional recovery tools; manifest recovery line; rename line; pull-request line |
| `packages/slack-service/src/processor.ts`, `runtime.ts`, `main.ts`, `signing-fetch.ts` | Pass `recoverableOperations`; display-name lookup and header |
| `packages/contracts/src/connectors.ts`, `project.ts` | `attribution` flag |
| `packages/gateway/src/engine.ts` | `EngineOptions.attribution` applied at call time |
| `packages/broker/src/github-mcp.ts` | Forward `attribution` |

---

### Task 1: Characterize the seven lifecycle tools and the five unchanged tools

**Files:**
- Create: `tests/support/pull-request-cases.ts`, `tests/contract/pull-request-tools.test.ts`
- Modify: `tests/contract/orchestrator-boundary.test.ts` (one new case and its snapshot)

**Interfaces:**
- Produces: `LIFECYCLE_CASES` (tool name, action, params) and `managePullRequestApi()` test helper.
  No production code changes.

- [ ] **Step 1: Write the shared fixtures**

`tests/support/pull-request-cases.ts`:

```ts
import { vi } from "vitest";

export const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
export const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
export const OPERATION_ID = "33333333-3333-4333-8333-333333333333";
export const REQUEST_ID = "44444444-4444-4444-8444-444444444444";

/** What each retired lifecycle tool sent, so the replacement can be held to exactly the same calls. */
export const LIFECYCLE_CASES = [
  { tool: "agentx_update_pull_request", action: "edit", params: { repository: "web", pullRequestNumber: 12, title: "New title", body: "New body" } },
  { tool: "agentx_append_pull_request", action: "append", params: { repository: "web", pullRequestNumber: 12 } },
  { tool: "agentx_sync_pull_request", action: "sync", params: { repository: "web", pullRequestNumber: 12 } },
  { tool: "agentx_close_pull_request", action: "close", params: { repository: "web", pullRequestNumber: 12 } },
  { tool: "agentx_reopen_pull_request", action: "reopen", params: { repository: "web", pullRequestNumber: 12 } },
  { tool: "agentx_replace_pull_request", action: "replace", params: { repository: "web", pullRequestNumber: 12, title: "Clean history", body: "Replaces #12" } },
  { tool: "agentx_revert_pull_request", action: "revert", params: { repository: "web", pullRequestNumber: 12, title: "Revert #12" } },
] as const;

export function managePullRequestApi() {
  return {
    submitTask: vi.fn(),
    taskStatus: vi.fn(),
    taskResult: vi.fn(),
    followUp: vi.fn(),
    createPullRequest: vi.fn(),
    managePullRequest: vi.fn(async () => ({ operation: { id: OPERATION_ID } })),
    pullRequestResult: vi.fn(async () => ({ status: "SUCCEEDED", url: "https://github.com/example/web/pull/12" })),
  };
}
```

- [ ] **Step 2: Write the characterization test (it must pass on current code)**

`tests/contract/pull-request-tools.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createOrchestrationTools } from "../../packages/orchestrator/src/orchestration-tools.js";
import { CONVERSATION_ID, LIFECYCLE_CASES, OPERATION_ID, REQUEST_ID, WORKSPACE_ID, managePullRequestApi } from "../support/pull-request-cases.js";

describe("pull-request lifecycle tools (characterization)", () => {
  it.each(LIFECYCLE_CASES)("$tool sends action $action with exactly its parameters", async ({ tool, action, params }) => {
    const api = managePullRequestApi();
    const tools = createOrchestrationTools(api, { workspaceId: WORKSPACE_ID, conversationId: CONVERSATION_ID }, { requestId: () => REQUEST_ID });
    const onUpdate = vi.fn();
    const result = await tools.find((entry) => entry.name === tool)!.execute("call-1", params, undefined, onUpdate, {} as never);
    expect(api.managePullRequest).toHaveBeenCalledExactlyOnceWith({ workspaceId: WORKSPACE_ID, requestId: REQUEST_ID, action, ...params });
    expect(api.pullRequestResult).toHaveBeenCalledOnce();
    expect(api.pullRequestResult.mock.calls[0]?.[0]).toEqual({ workspaceId: WORKSPACE_ID, operationId: OPERATION_ID });
    expect(typeof (api.pullRequestResult.mock.calls[0]?.[1] as { onProgress?: unknown } | undefined)?.onProgress).toBe("function");
    const accepted = JSON.parse((onUpdate.mock.calls[0]?.[0] as { content: Array<{ text: string }> }).content[0]!.text) as unknown;
    expect(accepted).toEqual({ operationId: OPERATION_ID, status: "ACCEPTED", message: `AgentX accepted pull request ${action}.` });
    expect(JSON.parse((result.content[0] as { text: string }).text) as unknown).toEqual({ status: "SUCCEEDED", url: "https://github.com/example/web/pull/12" });
    expect(api.submitTask).not.toHaveBeenCalled();
    expect(api.createPullRequest).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Snapshot the five tools that will not change**

In `tests/contract/orchestrator-boundary.test.ts`, add after the existing characterization case:

```ts
  it("keeps the five tools outside the pull-request lifecycle byte-for-byte (regression guard)", () => {
    const api = { submitTask: vi.fn(), taskStatus: vi.fn(), taskResult: vi.fn(), followUp: vi.fn(), createPullRequest: vi.fn(), pullRequestResult: vi.fn() };
    const unchanged = ["agentx_submit_task", "agentx_create_pull_request", "agentx_task_status", "agentx_task_result", "agentx_follow_up"];
    const tools = createOrchestrationTools(api, { workspaceId: crypto.randomUUID(), conversationId: crypto.randomUUID() })
      .filter((tool) => unchanged.includes(tool.name));
    expect(tools.map((tool) => tool.name)).toEqual(unchanged);
    expect(tools.map(({ name, label, description, parameters }) => ({ name, label, description, parameters }))).toMatchSnapshot();
  });
```

- [ ] **Step 4: Run them against the unchanged code**

Run: `npm run build && npx vitest run tests/contract/pull-request-tools.test.ts tests/contract/orchestrator-boundary.test.ts`
Expected: PASS (7 characterization cases plus the new snapshot, which is written now). Record in the
report that these pass without any production change. That is their purpose.

- [ ] **Step 5: Commit**

```bash
git add tests/support/pull-request-cases.ts tests/contract/pull-request-tools.test.ts tests/contract/orchestrator-boundary.test.ts tests/contract/__snapshots__/orchestrator-boundary.test.ts.snap
git commit -m "test(orchestrator): characterize the pull-request lifecycle tools before consolidation"
```

---

### Task 2: Replace the seven tools with `agentx_manage_pull_request`

**Files:**
- Modify: `packages/orchestrator/src/orchestration-tools.ts:7-20,188-232` (name list and the lifecycle loop)
- Modify: `packages/orchestrator/src/manifest.ts` (pull-request line)
- Modify: `tests/contract/pull-request-tools.test.ts` (becomes the mapping test)
- Modify: `tests/contract/orchestrator-boundary.test.ts` snapshot of the full tool list (regenerated, see Step 5)
- Modify: `tests/contract/connector-tools.test.ts` (manifest pull-request line, 3 expectations)

**Interfaces:**
- Consumes: Task 1 fixtures.
- Produces: `ORCHESTRATION_TOOL_NAMES = ["agentx_submit_task", "agentx_create_pull_request", "agentx_task_status", "agentx_task_result", "agentx_follow_up", "agentx_manage_pull_request"]`; `RETIRED_PULL_REQUEST_TOOLS` (the seven old names mapped to their actions).

- [ ] **Step 1: Turn the characterization into the mapping test (failing)**

Replace the `describe` block in `tests/contract/pull-request-tools.test.ts` with:

```ts
describe("agentx_manage_pull_request replaces the seven lifecycle tools call for call", () => {
  it.each(LIFECYCLE_CASES)("action $action sends exactly what $tool sent", async ({ action, params }) => {
    const api = managePullRequestApi();
    const tools = createOrchestrationTools(api, { workspaceId: WORKSPACE_ID, conversationId: CONVERSATION_ID }, { requestId: () => REQUEST_ID });
    const onUpdate = vi.fn();
    const result = await tools.find((entry) => entry.name === "agentx_manage_pull_request")!.execute("call-1", { action, ...params }, undefined, onUpdate, {} as never);
    expect(api.managePullRequest).toHaveBeenCalledExactlyOnceWith({ workspaceId: WORKSPACE_ID, requestId: REQUEST_ID, action, ...params });
    expect(api.pullRequestResult).toHaveBeenCalledOnce();
    expect(api.pullRequestResult.mock.calls[0]?.[0]).toEqual({ workspaceId: WORKSPACE_ID, operationId: OPERATION_ID });
    expect(typeof (api.pullRequestResult.mock.calls[0]?.[1] as { onProgress?: unknown } | undefined)?.onProgress).toBe("function");
    const accepted = JSON.parse((onUpdate.mock.calls[0]?.[0] as { content: Array<{ text: string }> }).content[0]!.text) as unknown;
    expect(accepted).toEqual({ operationId: OPERATION_ID, status: "ACCEPTED", message: `AgentX accepted pull request ${action}.` });
    expect(JSON.parse((result.content[0] as { text: string }).text) as unknown).toEqual({ status: "SUCCEEDED", url: "https://github.com/example/web/pull/12" });
    expect(api.submitTask).not.toHaveBeenCalled();
    expect(api.createPullRequest).not.toHaveBeenCalled();
  });

  it.each(["append", "sync", "close", "reopen"] as const)("drops a title and body sent with %s, as the retired tool could not send them", async (action) => {
    const api = managePullRequestApi();
    const tools = createOrchestrationTools(api, { workspaceId: WORKSPACE_ID, conversationId: CONVERSATION_ID }, { requestId: () => REQUEST_ID });
    await tools.find((entry) => entry.name === "agentx_manage_pull_request")!
      .execute("call-1", { action, repository: "web", pullRequestNumber: 12, title: "Ignored", body: "Ignored" }, undefined, undefined, {} as never);
    expect(api.managePullRequest).toHaveBeenCalledExactlyOnceWith({ workspaceId: WORKSPACE_ID, requestId: REQUEST_ID, action, repository: "web", pullRequestNumber: 12 });
  });

  it("no longer offers the retired tool names", () => {
    const tools = createOrchestrationTools(managePullRequestApi(), { workspaceId: WORKSPACE_ID, conversationId: CONVERSATION_ID });
    for (const { tool } of LIFECYCLE_CASES) expect(tools.map((entry) => entry.name)).not.toContain(tool);
  });
});
```

The assertions of each case are the Task 1 assertions verbatim. Only the entry point changes, from
`<old tool>` with `params` to `agentx_manage_pull_request` with `{ action, ...params }`. That is the
1:1 proof.

Run: `npx vitest run tests/contract/pull-request-tools.test.ts`
Expected: FAIL. `agentx_manage_pull_request` is not found (TypeError on `.execute` of undefined).

- [ ] **Step 2: Implement the tool**

In `packages/orchestrator/src/orchestration-tools.ts`:

Replace the seven lifecycle entries of `ORCHESTRATION_TOOL_NAMES` with `"agentx_manage_pull_request",`
(the list becomes the six names under Interfaces). Add after the list:

```ts
/** Retired in feature 013; kept so the orchestrator can tell the model the new name for one release. */
export const RETIRED_PULL_REQUEST_TOOLS = {
  agentx_update_pull_request: "edit",
  agentx_append_pull_request: "append",
  agentx_sync_pull_request: "sync",
  agentx_close_pull_request: "close",
  agentx_reopen_pull_request: "reopen",
  agentx_replace_pull_request: "replace",
  agentx_revert_pull_request: "revert",
} as const;

const PULL_REQUEST_ACTIONS = ["edit", "append", "sync", "close", "reopen", "replace", "revert"] as const;
type PullRequestAction = (typeof PULL_REQUEST_ACTIONS)[number];
/** Only these actions ever carried a title or body. */
const TITLED_ACTIONS = new Set<PullRequestAction>(["edit", "replace", "revert"]);
```

Replace the whole `const lifecycleTools = [...]` declaration and its `for` loop with:

```ts
  tools.push(defineTool({
    name: "agentx_manage_pull_request",
    label: "Manage pull request",
    description:
      "Change an existing AgentX-owned pull request. Actions: edit its title or body; append new workspace commits with a normal fast-forward push; " +
      "sync by merging the latest base branch into it; close it; reopen a closed, unmerged one; replace it with clean history (the new pull request is " +
      "created before the original is closed); revert a merged one with a reviewable revert pull request. History is never rebased or force-pushed. " +
      "Title and body apply only to edit, replace and revert. Call only for the action the user explicitly asked for.",
    parameters: Type.Object({
      repository: Type.String({ minLength: 1, maxLength: 63 }),
      pullRequestNumber: Type.Integer({ minimum: 1 }),
      action: Type.Unsafe<PullRequestAction>({ type: "string", enum: [...PULL_REQUEST_ACTIONS] }),
      title: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
      body: Type.Optional(Type.String({ maxLength: 32_768 })),
    }),
    execute: async (_id, parameters, signal, onUpdate) => {
      const request = parameters as { repository: string; pullRequestNumber: number; action: PullRequestAction; title?: string; body?: string };
      const titled = TITLED_ACTIONS.has(request.action);
      const accepted = await api.managePullRequest({
        workspaceId: context.workspaceId,
        requestId: nextRequestId(),
        repository: request.repository,
        pullRequestNumber: request.pullRequestNumber,
        action: request.action,
        ...(titled && request.title !== undefined ? { title: request.title } : {}),
        ...(titled && request.body !== undefined ? { body: request.body } : {}),
      });
      const operationId = acceptedOperationId(accepted);
      onUpdate?.(toolResult({ operationId, status: "ACCEPTED", message: `AgentX accepted pull request ${request.action}.` }));
      return toolResult(await api.pullRequestResult(
        { workspaceId: context.workspaceId, operationId },
        {
          ...(signal === undefined ? {} : { signal }),
          onProgress: (progress) => onUpdate?.(toolResult(progress)),
        },
      ));
    },
  }));
```

In `packages/orchestrator/src/manifest.ts` change the pull-request line to:

```ts
    `- Pull requests (${repositories}): agentx_create_pull_request, agentx_manage_pull_request`,
```

- [ ] **Step 3: Update the three manifest expectations that name the old wording**

In `tests/contract/connector-tools.test.ts`, the three exact-string manifest expectations contain
`"- Pull requests (…): agentx_create_pull_request and the pull-request tools"`. Change only that
element to `"- Pull requests (…): agentx_create_pull_request, agentx_manage_pull_request"`, keeping the
repository list in each. This changes wording, not coverage.

- [ ] **Step 4: Run the mapping and regression tests**

Run: `npm run build && npx vitest run tests/contract/pull-request-tools.test.ts tests/contract/connector-tools.test.ts tests/contract/orchestrator-boundary.test.ts`
Expected: `pull-request-tools` PASS (7 + 4 + 1). `connector-tools` PASS. `orchestrator-boundary`: the
new five-tool snapshot PASSES unchanged, and the older full-list snapshot FAILS (intended: the
seven tools became one).

- [ ] **Step 5: Regenerate only the full-list snapshot**

Run: `npx vitest run tests/contract/orchestrator-boundary.test.ts -t "characterizes the in-house agentx_\* tools byte-for-byte" -u`
Then read the snapshot diff (`git diff tests/contract/__snapshots__/orchestrator-boundary.test.ts.snap`).
Expected: the seven lifecycle entries are replaced by one `agentx_manage_pull_request` entry. The
five other entries are unchanged, and the five-tool snapshot is untouched. Paste the diff summary
into the report.

- [ ] **Step 6: Full suite and commit**

Run: `npm run build && npm test`. Expected: all pass. Tests that compare against
`ORCHESTRATION_TOOL_NAMES` follow the constant.

```bash
git add packages/orchestrator tests/contract/pull-request-tools.test.ts tests/contract/connector-tools.test.ts tests/contract/__snapshots__/orchestrator-boundary.test.ts.snap
git commit -m "feat(orchestrator): replace the seven pull-request lifecycle tools with agentx_manage_pull_request"
```

---

### Task 3: Recovery tools only when a thread has an unfinished operation

**Files:**
- Modify: `packages/contracts/src/slack.ts` (WORKSPACE branch)
- Modify: `packages/broker/src/aws/broker.ts` (`existingThreadWorkspace` `applied`, new-workspace return)
- Modify: `packages/orchestrator/src/orchestration-tools.ts`, `orchestrator.ts`, `manifest.ts`
- Modify: `packages/slack-service/src/processor.ts`, `runtime.ts`
- Test: `tests/contract/slack-control-plane.test.ts`, `tests/integration/mcp-orchestrator.test.ts`, `tests/contract/connector-tools.test.ts`, `tests/integration/hosted-slack-mcp.test.ts`

**Interfaces:**
- Produces:
  - Thread result `recoverableOperations?: string[]` (uuid, ≤5), sent only for `includeConnectors`
  - `RECOVERY_TOOL_NAMES = ["agentx_task_status", "agentx_task_result"] as const`
  - `createOrchestrationTools(api, context, { …, recovery?: boolean })` (default `true`: existing callers unchanged)
  - `OrchestratorOptions.recoverableOperations?: readonly string[]`; `TurnInput.recoverableOperations?: string[]`
  - `capabilitiesManifest({ …, recoverableOperations?: readonly string[] })`

- [ ] **Step 1: Write the failing tests**

`tests/contract/slack-control-plane.test.ts`, inside `describe("hosted Slack GitHub MCP", …)`:

```ts
  it("reports a thread's unfinished operation as recoverable, only to connector-aware services", async () => {
    const { db, handler } = createBroker({ githubMcp: { credentials: vi.fn(), connect: vi.fn() } });
    await registerProjectAndBind(handler, true);
    const service = { principal: orchestratorPrincipal, thread: threadOne, slackUser: pratik };
    const resolve = (includeConnectors: boolean) => call(handler, { method: "POST", path: "/v1/service/threads/workspace", service,
      body: { requestId: randomUUID(), includeIntegrations: true, ...(includeConnectors ? { includeConnectors: true } : {}) } });
    const created = await resolve(true);
    expect(created.body.recoverableOperations).toEqual([]);
    const workspaceId = created.body.workspaceId as string;
    markReady(db, workspaceId);
    expect((await resolve(true)).body.recoverableOperations).toEqual([]);
    const running = randomUUID();
    const workspace = db.get(`WORKSPACE#${workspaceId}`, "META")!;
    workspace.status = "BUSY";
    workspace.activeOperationId = running;
    expect((await resolve(true)).body.recoverableOperations).toEqual([running]);
    expect((await resolve(false)).body).not.toHaveProperty("recoverableOperations");
  });
```

`tests/contract/connector-tools.test.ts`, in `describe("capabilities manifest", …)`:

```ts
  it("points the model at an unfinished operation", () => {
    const manifest = capabilitiesManifest({ repositories: ["demo"], connectors: [], catalogs: [], recoverableOperations: ["55555555-5555-4555-8555-555555555555"] });
    expect(manifest).toContain("An earlier operation in this thread has not finished: 55555555-5555-4555-8555-555555555555. Check it with agentx_task_status or agentx_task_result before starting new work.");
  });
```

`tests/integration/mcp-orchestrator.test.ts`, add:

```ts
  it("offers the recovery tools only when the thread has an unfinished operation", async () => {
    const workspaceId = randomUUID();
    const api = new ControlPlaneApi("https://agentx.example.test", "agentx-jwt", workspaceId, vi.fn<typeof fetch>());
    const create = async (recoverableOperations?: string[]) => createOrchestratorRuntime({
      stateDirectory: await createFixtureDirectory("agentx-mcp-runtime-"), projectInstructions: "Delegate coding.",
      api, context: { workspaceId, conversationId: randomUUID() },
      model: { provider: "amazon-bedrock", modelId: "amazon.nova-pro-v1:0" }, repositories: ["demo"],
      ...(recoverableOperations === undefined ? {} : { recoverableOperations }),
    });
    const idle = await create();
    try {
      expect(idle.session.getActiveToolNames()).toEqual(ORCHESTRATION_TOOL_NAMES.filter((name) => !(RECOVERY_TOOL_NAMES as readonly string[]).includes(name)));
    } finally { await idle.dispose(); }
    const operation = randomUUID();
    const recovering = await create([operation]);
    try {
      expect(recovering.session.getActiveToolNames()).toEqual([...ORCHESTRATION_TOOL_NAMES]);
      expect(recovering.session.systemPrompt).toContain(operation);
    } finally { await recovering.dispose(); }
  });
```

(add `RECOVERY_TOOL_NAMES` to that file's `orchestration-tools.js` import).

Run: `npm run build && npx vitest run tests/contract/slack-control-plane.test.ts -t "recoverable" tests/contract/connector-tools.test.ts tests/integration/mcp-orchestrator.test.ts`
Expected: FAIL. There is no `recoverableOperations` field, no manifest line, and the recovery tools
are always active.

- [ ] **Step 2: Contract and broker**

`packages/contracts/src/slack.ts`: in the WORKSPACE branch after `repositories`, add
`recoverableOperations: z.array(z.string().uuid()).max(5).optional(),`.

`packages/broker/src/aws/broker.ts`:
- In `existingThreadWorkspace`, add to `applied`:
  `...(include.connectors ? { recoverableOperations: workspace.status === "BUSY" && workspace.activeOperationId ? [workspace.activeOperationId] : [] } : {}),`
- In `ensureThreadWorkspace`'s new-workspace return, add
  `...(include.connectors ? { recoverableOperations: [] } : {}),` after the `threadIntegrations` spread.

- [ ] **Step 3: Orchestrator and Slack service**

`orchestration-tools.ts`: add `export const RECOVERY_TOOL_NAMES = ["agentx_task_status", "agentx_task_result"] as const;`
Extend the options type with `recovery?: boolean`. After the in-house tools are built and before
connector tools are appended, add:

```ts
  if (options.recovery === false) {
    const recovery = new Set<string>(RECOVERY_TOOL_NAMES);
    for (let index = tools.length - 1; index >= 0; index -= 1) if (recovery.has(tools[index]!.name)) tools.splice(index, 1);
  }
```

`orchestrator.ts`: add `recoverableOperations?: readonly string[];` to `OrchestratorOptions`. Pass
`recovery: (options.recoverableOperations?.length ?? 0) > 0` into `createOrchestrationTools`, and pass
`...(options.recoverableOperations?.length ? { recoverableOperations: options.recoverableOperations } : {})`
into `capabilitiesManifest`.

`manifest.ts`: add `recoverableOperations?: readonly string[];` to the input. Before the close-command
line, push:

```ts
  if (input.recoverableOperations?.length) {
    lines.push(`An earlier operation in this thread has not finished: ${input.recoverableOperations.join(", ")}. Check it with agentx_task_status or agentx_task_result before starting new work.`);
  }
```

`processor.ts`: add `recoverableOperations?: string[];` to `TurnInput` and pass
`...(workspace.recoverableOperations === undefined ? {} : { recoverableOperations: workspace.recoverableOperations }),`
in the `runTurn` call. `runtime.ts`: forward it the same way.

- [ ] **Step 4: Update the active-tool expectations that assumed recovery tools are always present**

In `tests/integration/mcp-orchestrator.test.ts` and `tests/integration/hosted-slack-mcp.test.ts`, the
`getActiveToolNames()` expectations built from `ORCHESTRATION_TOOL_NAMES` now expect the list without
`RECOVERY_TOOL_NAMES` (for example
`[...ORCHESTRATION_TOOL_NAMES.filter((name) => !(RECOVERY_TOOL_NAMES as readonly string[]).includes(name)), "github__future_issue_tool"]`).
This follows FR-021. The recovery-present case is asserted by the new test in Step 1. List each
changed line in the report.

- [ ] **Step 5: Run and commit**

Run: `npm run build && npx vitest run tests/contract/slack-control-plane.test.ts tests/contract/connector-tools.test.ts tests/integration/mcp-orchestrator.test.ts tests/integration/hosted-slack-mcp.test.ts tests/contract/orchestrator-boundary.test.ts tests/contract/pull-request-tools.test.ts`, then `npm test`.
Expected: PASS. The five-tool snapshot is unchanged. (`createOrchestrationTools` defaults
`recovery` to `true`, so the boundary tests still see all six tools.)

```bash
git add packages tests
git commit -m "feat(orchestrator): offer recovery tools only when a thread has an unfinished operation"
```

---

### Task 4: Tell the model the retired names for one release

**Files:**
- Modify: `packages/orchestrator/src/orchestrator.ts` (`orchestratorSystemPrompt`)
- Test: `tests/contract/orchestrator-boundary.test.ts`; regenerate `tests/contract/__snapshots__/tool-presentation.test.ts.snap`

**Interfaces:**
- Consumes: `RETIRED_PULL_REQUEST_TOOLS` (Task 2).

- [ ] **Step 1: Write the failing test**

In `tests/contract/orchestrator-boundary.test.ts`, add:

```ts
  it("names every retired pull-request tool and its replacement action", () => {
    const prompt = orchestratorSystemPrompt("Delegate.");
    for (const [tool, action] of Object.entries(RETIRED_PULL_REQUEST_TOOLS)) {
      expect(prompt).toContain(`${tool} → agentx_manage_pull_request action "${action}"`);
    }
    expect(prompt).toContain("If a call to a retired name fails, use agentx_manage_pull_request instead.");
  });
```

(import `RETIRED_PULL_REQUEST_TOOLS` from `orchestration-tools.js`).

Run: `npx vitest run tests/contract/orchestrator-boundary.test.ts -t "retired"`. Expected: FAIL.

- [ ] **Step 2: Implement**

In `orchestrator.ts`, import `RETIRED_PULL_REQUEST_TOOLS` and, in `orchestratorSystemPrompt`, add
this entry directly after the `"Use agentx_create_pull_request only when …"` line:

```ts
    `Retired tool names (renamed in feature 013): ${Object.entries(RETIRED_PULL_REQUEST_TOOLS).map(([tool, action]) => `${tool} → agentx_manage_pull_request action "${action}"`).join("; ")}. If a call to a retired name fails, use agentx_manage_pull_request instead.`,
```

- [ ] **Step 3: Regenerate the prompt snapshot and check it**

Run: `npm run build && npx vitest run tests/contract/tool-presentation.test.ts -u`, then read
`git diff tests/contract/__snapshots__/tool-presentation.test.ts.snap`. Expected: only the retired-names
line and the manifest's pull-request line (from Task 2) differ in the system-prompt snapshot. The
presented connector tools are unchanged.

- [ ] **Step 4: Run and commit**

Run: `npx vitest run tests/contract/orchestrator-boundary.test.ts tests/contract/tool-presentation.test.ts` then `npm test`.

```bash
git add packages/orchestrator tests/contract/orchestrator-boundary.test.ts tests/contract/__snapshots__/tool-presentation.test.ts.snap
git commit -m "feat(orchestrator): tell the model the retired pull-request tool names for one release"
```

---

### Task 5: Attribution footer on connector writes

**Files:**
- Modify: `packages/gateway/src/engine.ts`
- Modify: `packages/contracts/src/connectors.ts`, `packages/contracts/src/project.ts`, `packages/contracts/src/slack.ts`
- Modify: `packages/broker/src/auth.ts`, `packages/broker/src/aws/broker.ts`, `packages/broker/src/github-mcp.ts`
- Modify: `packages/slack-service/src/signing-fetch.ts`, `packages/slack-service/src/main.ts`, `packages/slack-service/src/processor.ts`
- Test: `tests/contract/gateway-engine.test.ts`, `tests/contract/connector-config.test.ts`, `tests/contract/slack-control-plane.test.ts`, `tests/contract/signing-fetch.test.ts` (new)

**Interfaces:**
- Produces:
  - `EngineOptions.attribution?: string`
  - `GitHubConnectorSchema.attribution?: boolean`; `ResolvedGitHubConnector.attribution: boolean` (legacy `githubMcp` → `true`; connectors → `attribution ?? true`)
  - `slackThreadUrl(thread: SlackThread): string` in `@agentx/contracts` (moved; `processor.ts` re-exports it)
  - `AuthenticatedIdentity.slack.requesterName?: string`, parsed from header `x-agentx-slack-user-name` (percent-encoded)
  - `GitHubMcpDependencies.attribution?: string`
  - `createSignedServiceFetch({ …, userName?: string })`

- [ ] **Step 1: Write the failing tests**

`tests/contract/gateway-engine.test.ts`, in `describe("gateway execution", …)`:

```ts
  it("appends the attribution to a body the model supplied on a write, and to nothing else", async () => {
    const f = fixture();
    f.tools[1]!.inputSchema = schema({ title: { type: "string" }, body: { type: "string" } }, ["title"]);
    f.context.policy.tools[1] = { name: "create_item", access: "write", allowedArguments: ["title", "body"] };
    const options = { connect: f.connect, ledger: f.ledger, attribution: "Requested by Pratik via AgentX · https://slack.com/archives/C1/p1" };
    await executeTool(f.request("create_item", { title: "Bug", body: "Steps" }), f.connector, f.context, options);
    expect(f.call).toHaveBeenLastCalledWith("create_item", { title: "Bug", body: "Steps\n\n—\nRequested by Pratik via AgentX · https://slack.com/archives/C1/p1", siteId: "site-42" });
    await executeTool(f.request("create_item", { title: "No body" }), f.connector, f.context, options);
    expect(f.call).toHaveBeenLastCalledWith("create_item", { title: "No body", siteId: "site-42" });
    await executeTool(f.request("list_items", { state: "open" }), f.connector, f.context, options);
    expect(f.call).toHaveBeenLastCalledWith("list_items", { state: "open", siteId: "site-42" });
  });

  it("replays an attributed write from the ledger instead of conflicting", async () => {
    const f = fixture();
    f.tools[1]!.inputSchema = schema({ title: { type: "string" }, body: { type: "string" } }, ["title"]);
    f.context.policy.tools[1] = { name: "create_item", access: "write", allowedArguments: ["title", "body"] };
    const request = f.request("create_item", { title: "Bug", body: "Steps" });
    const options = { connect: f.connect, ledger: f.ledger, attribution: "Requested by Pratik via AgentX · https://slack.com/archives/C1/p1" };
    await executeTool(request, f.connector, f.context, options);
    expect(await executeTool(request, f.connector, f.context, options)).toMatchObject({ status: "SUCCEEDED", replayed: true });
    expect(f.call).toHaveBeenCalledOnce();
  });
```

`tests/contract/connector-config.test.ts`: add `attribution: true` to the object in the legacy
resolver expectation (`toEqual({ name: "github", repositories: …, policy: { tools } })` becomes
`{ name: "github", repositories: …, policy: { tools }, attribution: true }`), and add:

```ts
  it("turns attribution off only when a connector says so", () => {
    const off = ProjectDefinitionSchema.parse(project({ connectors: [{ name: "github", type: "github", scopes: "all-repositories", tools, attribution: false }] }));
    expect(githubConnectorOf(off)?.attribution).toBe(false);
    const on = ProjectDefinitionSchema.parse(project({ connectors: [{ name: "github", type: "github", scopes: "all-repositories", tools }] }));
    expect(githubConnectorOf(on)?.attribution).toBe(true);
  });
```

`tests/contract/signing-fetch.test.ts` (new):

```ts
import { describe, expect, it, vi } from "vitest";
import { createSignedServiceFetch } from "../../packages/slack-service/src/signing-fetch.js";

const thread = { teamId: "T0123456789", channelId: "C0123456789", threadTs: "1695500000.000001" };
const credentials = { accessKeyId: "test-key", secretAccessKey: "test-secret" };

describe("signed service fetch", () => {
  it("sends the requester's display name percent-encoded and signed, and omits it when unknown", async () => {
    const baseFetch = vi.fn<typeof fetch>(async () => Response.json({}));
    await createSignedServiceFetch({ region: "us-east-1", credentials, thread, userId: "U0123456789", userName: "Zoë Ó\nBrien", baseFetch })("https://agentx.example.test/v1/threads/workspace", { method: "POST", body: "{}" });
    const sent = new Headers(baseFetch.mock.calls[0]?.[1]?.headers);
    expect(sent.get("x-agentx-slack-user-name")).toBe(encodeURIComponent("Zoë Ó Brien"));
    expect(sent.get("authorization")).toContain("x-agentx-slack-user-name");
    await createSignedServiceFetch({ region: "us-east-1", credentials, thread, userId: "U0123456789", baseFetch })("https://agentx.example.test/v1/threads/workspace", { method: "POST", body: "{}" });
    expect(new Headers(baseFetch.mock.calls[1]?.[1]?.headers).has("x-agentx-slack-user-name")).toBe(false);
  });
});
```

`tests/contract/slack-control-plane.test.ts`, inside `describe("hosted Slack GitHub MCP", …)`:

```ts
  it("signs connector writes with the requesting member and thread, unless the connector turns it off", async () => {
    const credentials = vi.fn(async () => ({ owner: "example", repo: "demo", token: "installation-secret" }));
    const invoke = vi.fn(async () => ({ content: [{ type: "text", text: "created" }] }));
    const connect = vi.fn(async () => ({
      tools: [{ name: "issue_write", description: "Create an issue", inputSchema: { type: "object", properties: {
        owner: { type: "string" }, repo: { type: "string" }, title: { type: "string" }, body: { type: "string" },
      }, required: ["owner", "repo", "title"] } }], call: invoke, close: async () => undefined,
    }));
    const { db, handler } = createBroker({ githubMcp: { credentials, connect } });
    const connector = { name: "github", type: "github", scopes: "all-repositories", tools: [{ name: "issue_write", access: "write" }] };
    await registerProjectAndBind(handler, { connectors: [connector] });
    const workspaceId = (await ensureWorkspace(handler, threadOne, pratik)).body.workspaceId as string;
    markReady(db, workspaceId);
    const service = { principal: orchestratorPrincipal, thread: threadOne, slackUser: pratik };
    const path = `/v1/service/workspaces/${workspaceId}/connectors/github`;
    const catalog = ConnectorCatalogSchema.parse((await call(handler, { method: "GET", path: `${path}/tools`, service })).body.catalog);
    const schemaHash = catalog.tools[0]!.scopes[0]!.schemaHash;
    const write = (headers: Record<string, string> = {}) => call(handler, { method: "POST", path: `${path}/call`, service, headers,
      body: { requestId: randomUUID(), scope: "demo", tool: "issue_write", schemaHash, arguments: { title: "Bug", body: "Steps" } } });
    const threadUrl = `https://slack.com/archives/${threadOne.split("/")[1]}/p${threadOne.split("/")[2]!.replace(".", "")}`;
    await write({ "x-agentx-slack-user-name": encodeURIComponent("Pratik Singhal") });
    expect(invoke).toHaveBeenLastCalledWith("issue_write", expect.objectContaining({ body: `Steps\n\n—\nRequested by Pratik Singhal via AgentX · ${threadUrl}` }));
    await write();
    expect(invoke).toHaveBeenLastCalledWith("issue_write", expect.objectContaining({ body: `Steps\n\n—\nRequested by Slack member ${pratik} via AgentX · ${threadUrl}` }));
    await write({ "x-agentx-slack-user-name": encodeURIComponent("Evil\u0007Name") });
    expect(invoke).toHaveBeenLastCalledWith("issue_write", expect.objectContaining({ body: `Steps\n\n—\nRequested by Evil Name via AgentX · ${threadUrl}` }));
    await registerRevision(handler, 2, { connectors: [{ ...connector, attribution: false }] });
    const catalogOff = ConnectorCatalogSchema.parse((await call(handler, { method: "GET", path: `${path}/tools`, service })).body.catalog);
    await call(handler, { method: "POST", path: `${path}/call`, service,
      body: { requestId: randomUUID(), scope: "demo", tool: "issue_write", schemaHash: catalogOff.tools[0]!.scopes[0]!.schemaHash, arguments: { title: "Bug", body: "Steps" } } });
    expect(invoke).toHaveBeenLastCalledWith("issue_write", expect.objectContaining({ body: "Steps" }));
  });
```

(`threadOne` in that file has the form `T…/C…/ts`. If its format differs, build `threadUrl` from the
same thread values the file uses, with `slackThreadUrl` from `packages/contracts/src/slack.ts`.)

Run: `npm run build && npx vitest run tests/contract/gateway-engine.test.ts tests/contract/connector-config.test.ts tests/contract/signing-fetch.test.ts tests/contract/slack-control-plane.test.ts -t "attribution|attributed|signs connector|display name"`
Expected: FAIL for each new case (no footer, no `attribution` field, no header).

- [ ] **Step 2: Gateway**

In `packages/gateway/src/engine.ts`:
- Extend `EngineOptions` with `/** Footer appended to a write's body or description when the model supplied one. */ attribution?: string;`
- In `executeTool`, replace `const args = { ...request.arguments, ...bound };` with
  `const args = withAttribution({ ...request.arguments, ...bound }, write ? options.attribution : undefined, upstream.inputSchema);`
  and move the `const upstream = connection.tools.find(...)!;` line above it.
- Add:

```ts
/** Signs a write without ever creating a body: an absent body on an update means "leave it unchanged". */
function withAttribution(args: Record<string, unknown>, attribution: string | undefined, schema: Record<string, unknown>): Record<string, unknown> {
  if (!attribution) return args;
  const properties = isObject(schema.properties) ? schema.properties : {};
  for (const key of ["body", "description"]) {
    const value = args[key];
    if (typeof value === "string" && Object.hasOwn(properties, key)) return { ...args, [key]: `${value}\n\n—\n${attribution}` };
  }
  return args;
}
```

The fingerprint stays `requestFingerprint(request)` (request arguments without the footer), so
replays match.

- [ ] **Step 3: Contracts**

- `connectors.ts`: add `attribution: z.boolean().optional(),` to `GitHubConnectorSchema`.
- `project.ts`: add `attribution: boolean;` to `ResolvedGitHubConnector`. Return `attribution: true` for
  the legacy form and `attribution: connector.attribution ?? true` for connectors.
- `slack.ts`: add

```ts
export function slackThreadUrl(thread: SlackThread): string {
  return `https://slack.com/archives/${thread.channelId}/p${thread.threadTs.replace(".", "")}`;
}
```

  and in `packages/slack-service/src/processor.ts` replace its local `slackThreadUrl` definition with
  `export { slackThreadUrl } from "@agentx/contracts";`, keeping the import it uses internally.

- [ ] **Step 4: Broker**

- `auth.ts`: add `requesterName?: string;` to `AuthenticatedIdentity.slack`.
- `broker.ts` `parseSlackHeaders`: after `requester`, add

```ts
    const requesterName = displayName(headers["x-agentx-slack-user-name"]);
    return { thread, requester, ...(requesterName === undefined ? {} : { requesterName }) };
```

  and the helper:

```ts
/** A Slack display name from the orchestrator, percent-encoded; control characters become spaces. */
function displayName(value: string | undefined): string | undefined {
  if (!value || value.length > 512) return undefined;
  try {
    const name = decodeURIComponent(value).replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 80);
    return name.length > 0 ? name : undefined;
  } catch { return undefined; }
}
```

- Add `slackThreadUrl,` to the `@agentx/contracts` import, and add:

```ts
function attributionText(identity: AuthenticatedIdentity, github: GitHubConnector): string | undefined {
  if (!github.attribution || !identity.slack) return undefined;
  const who = identity.slack.requesterName ?? `Slack member ${identity.slack.requester.userId}`;
  return `Requested by ${who} via AgentX · ${slackThreadUrl(identity.slack.thread)}`;
}
```

- In both the legacy `/github/call` and the connector `/call` dependency objects, add
  `...(attributionText(identity, github) === undefined ? {} : { attribution: attributionText(identity, github)! }),`
  (or compute it once into a `const` before the call).
- `github-mcp.ts`: add `attribution?: string;` to `GitHubMcpDependencies`, and in
  `executeGitHubConnectorTool` forward
  `...(dependencies.attribution === undefined ? {} : { attribution: dependencies.attribution }),` into
  the engine options.

- [ ] **Step 5: Slack service**

- `signing-fetch.ts`: add `userName?: string;` to the options. After the user header, add
  `if (options.userName) headers["x-agentx-slack-user-name"] = encodeURIComponent(options.userName.replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 80));`
- `main.ts`: add a cached display-name lookup:

```ts
const userNames = new Map<string, { name: string | undefined; at: number }>();
/** Display name for footers; needs the optional users:read scope and falls back to undefined. */
async function slackUserName(userId: string): Promise<string | undefined> {
  const cached = userNames.get(userId);
  if (cached && Date.now() - cached.at < 60 * 60 * 1_000) return cached.name;
  let name: string | undefined;
  try {
    const response = await fetch(`https://slack.com/api/users.info?user=${encodeURIComponent(userId)}`, { headers: { authorization: `Bearer ${await slackBotToken()}` } });
    const body = await response.json() as { ok?: boolean; user?: { name?: string; real_name?: string; profile?: { display_name?: string; real_name?: string } } };
    if (body.ok) name = body.user?.profile?.display_name || body.user?.profile?.real_name || body.user?.real_name || body.user?.name || undefined;
  } catch { name = undefined; }
  userNames.set(userId, { name, at: Date.now() });
  return name;
}
```

  In `runTurn`, before `createSignedServiceFetch`, add `const userName = await slackUserName(input.message.userId);`
  and pass `...(userName === undefined ? {} : { userName })` to it.

- [ ] **Step 6: Run and commit**

Run: `npm run build && npx vitest run tests/contract/gateway-engine.test.ts tests/contract/connector-config.test.ts tests/contract/signing-fetch.test.ts tests/contract/slack-control-plane.test.ts tests/contract/github-mcp.test.ts tests/contract/github-mcp-broker.test.ts`, then `npm test`.
Expected: PASS. Existing GitHub tests pass unchanged. Their calls carry no Slack display name and
use the legacy policy, so where the test identity is a Slack thread, a write with a `body` now gains
the footer. If an existing assertion compares a written `body` exactly, update it to the footer
form and list it in the report. The footer is intended behavior per FR-024.

```bash
git add packages tests
git commit -m "feat(gateway): sign connector writes with the requesting member and thread"
```

---

### Task 6: Documentation, verification and pull request

**Files:**
- Modify: `README.md`; `specs/002-create-pull-request/contracts/cli.md`; `specs/003-safe-pr-lifecycle/contracts/cli.md`;
  `specs/013-connector-gateway/contracts/orchestrator-tools.md`; `specs/013-connector-gateway/tasks.md`

- [ ] **Step 1: Documents**

- README:
  - Slack app setup: add `users:read` as an optional bot scope, "used to show the requester's name
    in connector write footers; without it the footer shows the Slack member ID".
  - "Maintain an AgentX-owned PR" section: name the single tool `agentx_manage_pull_request` wherever
    the old per-action names appear.
  - GitHub MCP section: one sentence on the footer and the `attribution: false` switch.
- Specs 002 and 003 `contracts/cli.md`: where the lifecycle tool names appear, add "(feature 013
  consolidates these into `agentx_manage_pull_request` with an `action` argument)". Do not rewrite
  their history.
- `orchestrator-tools.md`: mark the consolidation, conditional recovery tools, rename line and footer
  as shipped. Document the recovery manifest line and the footer format.
- `tasks.md`: check T016, T017, T019 and T038.

- [ ] **Step 2: Full verification**

```bash
npm run clean && npm ci && npm run typecheck && npm run lint && npm test && npm run infra:synth
```

Expected: all pass. Report the test count. It is 343 plus this phase's new tests: Task 1 adds 7
cases and 1 snapshot case, and Task 2 replaces those 7 with 7 + 4 + 1.

- [ ] **Step 3: Commit**

```bash
git add README.md specs
git commit -m "docs(spec): record phase 2b of the connector gateway"
```

The controller runs the whole-branch review and opens the pull request.
