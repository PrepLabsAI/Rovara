import { join } from "node:path";
import type { Node } from "typescript";
import type { TaskRecord } from "../../packages/broker/src/core/task-flow/records.js";
import { describe, expect, it, vi } from "vitest";
import { IMPLICIT_COMPANY_ID, type StoredDocument } from "@agentx/contracts";
import * as keys from "../../packages/broker/src/core/task-flow/keys.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";

const A = IMPLICIT_COMPANY_ID;
const B = "org_bbbbbbbbbbbbbbbbbbbb";
// Runtime calls deliberately exercise the new mandatory argument before its implementation exists.
const call = (fn: unknown, ...args: string[]) => (fn as (...values: string[]) => unknown)(...args);
describe("company task-flow keys", () => {
  it("scopes every workspace constructor and request; refuses invalid companies", () => {
    expect(call(keys.workspaceKey, A, "ws")).toEqual({ pk: `ORG#${A}#WORKSPACE#ws`, sk: "META" });
    expect(call(keys.operationKey, A, "ws", "op")).toEqual({ pk: `ORG#${A}#WORKSPACE#ws`, sk: "OPERATION#op" });
    expect(call(keys.taskPointerKey, A, "ws")).toEqual({ pk: `ORG#${A}#WORKSPACE#ws`, sk: "DEVELOPER_TASK" });
    expect(call(keys.conversationKey, A, "ws", "conv")).toEqual({ pk: `ORG#${A}#WORKSPACE#ws`, sk: "CONVERSATION#conv" });
    expect(keys.workspacePartition(A, "ws")).toBe(`ORG#${A}#WORKSPACE#ws`);
    expect(keys.operationEventKey(A, "ws", "op", 7)).toEqual({ pk: `ORG#${A}#WORKSPACE#ws`, sk: "EVENT#op#0000000007" });
    expect(call(keys.operationRequestKey, A, "owner", "ws", "req")).toEqual({ pk: `ORG#${A}#IDEMPOTENCY#owner#ws`, sk: "REQUEST#req" });
    for (const company of ["", "bad", "org_short", `${A}#other`]) {
      for (const fn of [keys.workspaceKey, keys.operationKey, keys.taskPointerKey, keys.conversationKey, keys.operationRequestKey, keys.operationEventKey, keys.workspacePartition]) {
        expect(() => call(fn, company, "ws", "op", "req")).toThrow("invalid workspace company");
      }
    }
  });
  it("locates scoped first, admits only implicit legacy, and refuses corrupt ownership", async () => {
    const { locateWorkspace } = await import("../../packages/broker/src/core/task-flow/workspace-location.js");
    const store = new MemoryDocumentStore();
    const get = vi.spyOn(store, "get");
    const legacy = { pk: "WORKSPACE#ws", sk: "META", id: "ws" };
    await store.put({ item: legacy });
    expect((await locateWorkspace({ store, companyId: A }, "ws"))?.scope).toBe("legacy");
    get.mockClear();
    expect(await locateWorkspace({ store, companyId: B }, "ws")).toBeUndefined();
    expect(get.mock.calls).toEqual([[{ pk: `ORG#${B}#WORKSPACE#ws`, sk: "META" }]]);
    for (const companyId of [B, "bad", "", null]) {
      await store.put({ item: { ...legacy, companyId } });
      expect(await locateWorkspace({ store, companyId: A }, "ws")).toBeUndefined();
    }
    await store.put({ item: { ...legacy, companyId: A } });
    await store.put({ item: { ...legacy, pk: `ORG#${A}#WORKSPACE#ws`, companyId: A } });
    expect((await locateWorkspace({ store, companyId: A }, "ws"))?.scope).toBe("company");
    expect(await locateWorkspace({ store, companyId: A }, "missing")).toBeUndefined();
    get.mockClear();
    await expect(locateWorkspace({ store, companyId: "" }, "ws")).rejects.toThrow("invalid workspace company");
    expect(get).not.toHaveBeenCalled();
  });
});

// Only these task-flow modules are in T1; core/company purge remains the independently inventoried T4 path.
const roots = ["core/task-flow", "core/setup-agent", "core/e2e", "core/proof", "core/build-step", "core/plan", "core/merge", "core/design-review", "core/test-env", "core/sessions", "core/model-gateway", "core/work-breakdown", "services", "local", "e2e"];
it("rejects raw workspace/operation literals in task-flow modules, including a planted literal", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const ts = (await import("typescript")).default;
  const allowed = new Set(["core/task-flow/keys.ts", "core/task-flow/legacy-keys.ts",
    // ANSWER-3 / T1-REQUALIFY-DRAIN-COMPANY: companion must supply company before core switch-on.
    "e2e/requalify-hold.ts"]);
  const literals = (source: string) => {
    const result: string[] = [];
    const file = ts.createSourceFile("probe.ts", source, ts.ScriptTarget.Latest, true);
    const visit = (node: Node): void => {
      if ((ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && /WORKSPACE#|OPERATION#/.test(node.text)) result.push(node.text);
      ts.forEachChild(node, visit);
    };
    visit(file); return result;
  };
  expect(literals('const key = { pk: `WORKSPACE#${id}`, sk: "OPERATION#bad" };')).toHaveLength(2);
  const bad: string[] = [];
  const walk = (relative: string): void => {
    for (const item of readdirSync(join("packages/broker/src", relative), { withFileTypes: true })) {
      const file = `${relative}/${item.name}`;
      if (item.isDirectory()) walk(file);
      else if (file.endsWith(".ts") && !allowed.has(file) && literals(readFileSync(join("packages/broker/src", file), "utf8")).length > 0) bad.push(file);
    }
  };
  for (const root of roots) walk(root);
  expect(bad).toEqual([]);
});
it("refuses legacy resolver faults without echoing the adapter's cause", async () => {
  const { locateWorkspace } = await import("../../packages/broker/src/core/task-flow/workspace-location.js");
  const store = new MemoryDocumentStore();
  vi.spyOn(store, "get").mockImplementation(async (key) => { if (key.pk.startsWith("WORKSPACE#")) throw new Error(`secret-${B}`); return undefined; });
  await expect(locateWorkspace({ store, companyId: A }, "ws")).rejects.toThrow(/^RUNTIME_UNAVAILABLE: workspace unavailable$/);
});
it("keeps a foreign operation indistinguishable from a missing operation", async () => {
  const { readOperation } = await import("../../packages/broker/src/core/task-flow/results.js");
  const store = new MemoryDocumentStore();
  await store.put({ item: { ...keys.workspaceKey(A, "ws"), companyId: A } });
  await store.put({ item: { ...keys.operationKey(A, "ws", "op"), companyId: B, marker: "private-operation" } });
  expect(await readOperation({ store, companyId: A }, "ws", "op")).toBeUndefined();
  expect(await readOperation({ store, companyId: A }, "ws", "missing")).toBeUndefined();
});
it("pins one workspace location for all reads of a TaskView during cutover", async () => {
  const { taskViewOf } = await import("../../packages/broker/src/core/task-flow/reads.js");
  const { createHarness } = await import("../support/task-flow-harness.js");
  const { readFileSync } = await import("node:fs");
  const { materializeT1Golden } = await import("../support/t1-golden-normalizer.js");
  const fixture = materializeT1Golden(JSON.parse(readFileSync(new URL("../fixtures/t1-key-goldens/memory.json", import.meta.url), "utf8")) as { snapshots: Array<{ rows: StoredDocument[] }> });
  const rows = fixture.snapshots.at(-1)!.rows;
  const h = createHarness();
  for (const row of rows) await h.store.put({ item: row });
  const meta = rows.find((row) => row.entityType === "WORKSPACE")!;
  const task = rows.find((row) => row.entityType === "DEVELOPER_TASK")!;
  if (typeof meta.id !== "string") throw new Error("invalid fixture workspace");
  const workspaceId = meta.id;
  const get = h.store.get.bind(h.store); let copied = false;
  const reads = vi.spyOn(h.store, "get").mockImplementation(async (key) => {
    const found = await get(key);
    if (!copied && key.pk === meta.pk && key.sk === "META") {
      copied = true;
      for (const row of rows.filter((row: { pk: string }) => row.pk === meta.pk)) await h.store.put({ item: { ...row, pk: keys.workspaceKey(A, workspaceId).pk } });
    }
    return found;
  });
  const query = vi.spyOn(h.store, "query");
  await taskViewOf(h.deps, task as unknown as TaskRecord);
  expect(reads.mock.calls.filter(([key]) => key.sk === "DEVELOPER_TASK").map(([key]) => key.pk)).toEqual([meta.pk]);
  expect(query.mock.calls.map(([request]) => request.pk)).toEqual([meta.pk]);
});
it("nightly pointer lookup keeps the stored task company check", async () => {
  const { nightlyRunOfOperation } = await import("../../packages/broker/src/core/test-env/nightly-callback.js");
  const { NIGHTLY_RUN_PURPOSE } = await import("@agentx/contracts");
  const store = new MemoryDocumentStore();
  await store.put({ item: { ...keys.workspaceKey(A, "night"), companyId: A } });
  await store.put({ item: { ...keys.taskPointerKey(A, "night"), taskId: "task" } });
  await store.put({ item: { ...keys.taskKey("task"), taskId: "task", workspaceId: "night", companyId: B, purpose: NIGHTLY_RUN_PURPOSE, nightlyRun: {}, project: "payments" } });
  expect(await nightlyRunOfOperation({ store }, { workspaceId: "night", kind: "task", workflowMode: "CHECKS", status: "RUNNING", companyId: A })).toBeUndefined();
});
