import { describe, expect, it } from "vitest";
import { IN_HOUSE_TOOL_NAMES, type ActionPolicy } from "../../packages/contracts/src/index.js";
import {
  BULK_ITEM_LIMIT, LIFECYCLE_KEYS, baseClass, destructiveSignal, evaluatePolicy, itemCount, itemReference, nameWords, type ToolFacts,
} from "../../packages/orchestrator/src/action-policy.js";

const tracker = (upstreamName: string, access: "read" | "write", extra: Partial<ToolFacts> = {}): ToolFacts =>
  ({ connector: "tracker", upstreamName, access, itemArguments: ["id"], ...extra });
const prepared = (value: boolean) => ({ prepared: () => value });

describe("action classes (spec 014 D1)", () => {
  it("splits tool names into words and finds destructive words and lifecycle keys", () => {
    expect(nameWords("transitionJiraIssue")).toEqual(["transition", "jira", "issue"]);
    expect(nameWords("delete_comment")).toEqual(["delete", "comment"]);
    expect(destructiveSignal("closeItem", {})).toBe("the tool's name says \"close\"");
    expect(destructiveSignal("save_item", { id: "T-1", state: "Done" })).toBe("the call sets \"state\"");
    expect(destructiveSignal("edit_item", { fields: { resolution: "Fixed" } })).toBe("the call sets \"fields.resolution\"");
    expect(destructiveSignal("save_item", { id: "T-1", state: null, title: "x" })).toBeUndefined();
    expect(destructiveSignal("list_closed_items", {})).toBeUndefined();
    // Completing an item closes it in some trackers (R19).
    expect(LIFECYCLE_KEYS.has("completed")).toBe(true);
    expect(destructiveSignal("save_item", { id: "T-1", completed: true })).toBe("the call sets \"completed\"");
    expect(destructiveSignal("edit_item", { fields: { completed: false } })).toBe("the call sets \"fields.completed\"");
  });

  it("reads a read-approved tool, even one that filters by a lifecycle key", () => {
    expect(baseClass("tracker__list_items", tracker("list_items", "read", { itemArguments: [] }), { state: "open" })).toBe("read");
    expect(baseClass("tracker__list_items", tracker("list_items", "read", { hints: { readOnlyHint: false } }), {})).toBe("create");
  });

  it("creates when the call names no existing item, changes when it names one, and destroys on a destructive word or lifecycle key", () => {
    const save = tracker("save_item", "write");
    expect(baseClass("tracker__save_item", save, { title: "Refund" })).toBe("create");
    expect(baseClass("tracker__save_item", save, { id: "T-5", priority: 2 })).toBe("change");
    expect(baseClass("tracker__save_item", save, { id: "T-5", state: "Done" })).toBe("destructive");
    expect(baseClass("tracker__delete_item", tracker("delete_item", "write"), { id: "T-5" })).toBe("destructive");
    expect(baseClass("tracker__add_note", tracker("add_note", "write", { itemArguments: [] }), { body: "x" })).toBe("create");
  });

  it("reads item arguments inside arrays of objects: a present item changes, none creates, and a lifecycle key in an item object destroys", () => {
    const update = tracker("update_items", "write", { itemArguments: ["item_id", "items[].item"] });
    expect(baseClass("tracker__update_items", update, { items: [{ item: "11", title: "Renamed" }] })).toBe("change");
    expect(baseClass("tracker__update_items", update, { item_id: "11", title: "Renamed" })).toBe("change");
    expect(baseClass("tracker__update_items", update, { items: [] })).toBe("create");
    expect(baseClass("tracker__update_items", update, { items: [{ title: "New" }] })).toBe("create");
    expect(baseClass("tracker__update_items", update, { title: "x" })).toBe("create");
    expect(baseClass("tracker__update_items", update, { items: [{ item: "11", completed: true }] })).toBe("destructive");
    expect(destructiveSignal("update_items", { items: [{ item: "11" }, { item: "12", completed: true }] }, ["items[].item"]))
      .toBe("the call sets \"items[].completed\"");
    // Only objects that hold one of the tool's item paths are searched, so a create's array is not.
    expect(baseClass("tracker__create_items", tracker("create_items", "write", { itemArguments: [] }), { items: [{ title: "Done already", completed: true }] })).toBe("create");
    expect(itemReference(update, { items: [{ item: "11" }, { item: "12" }] })).toBe("items[].item=11,12");
  });

  it("treats a tool whose connector declares no item argument as a change, never as destructive without a signal", () => {
    expect(baseClass("tracker__save_item", tracker("save_item", "write", { itemArguments: undefined }), { title: "x" })).toBe("change");
    expect(baseClass("mystery_tool", undefined, { x: 1 })).toBe("change");
    expect(evaluatePolicy({ name: "tracker__save_item", args: { id: "T-5" }, facts: tracker("save_item", "write") })).toEqual({ actionClass: "change" });
  });

  it("classifies in-house tools in code: coding work is a change only while the thread has no compute", () => {
    expect(IN_HOUSE_TOOL_NAMES.map((name) => baseClass(name, undefined, {}))).toEqual(["read", "change", "read", "read", "read", "change"]);
    expect(baseClass("agentx_submit_task", undefined, {}, prepared(false))).toBe("change");
    expect(baseClass("agentx_submit_task", undefined, {}, prepared(true))).toBe("read");
    expect(baseClass("agentx_follow_up", undefined, {}, prepared(false))).toBe("read");
    for (const action of ["close", "replace", "revert"]) expect(baseClass("agentx_manage_pull_request", undefined, { action })).toBe("destructive");
    for (const action of ["edit", "append", "sync", "reopen"]) expect(baseClass("agentx_manage_pull_request", undefined, { action })).toBe("change");
  });

  it("names the existing item a call changes, when the connector declares how", () => {
    expect(itemReference(tracker("save_item", "write"), { id: "T-5" })).toBe("id=T-5");
    expect(itemReference(tracker("save_item", "write"), { title: "x" })).toBeUndefined();
    expect(itemReference(undefined, { id: "T-5" })).toBeUndefined();
  });

  it("counts the items a call touches as its longest array, at most two levels into the arguments", () => {
    expect(itemCount({ title: "x" })).toBe(0);
    expect(itemCount({ ids: ["a", "b", "c"] })).toBe(3);
    expect(itemCount({ update: { labels: [1, 2, 3, 4, 5, 6, 7] } })).toBe(7);
    expect(itemCount({ items: [{ ids: [1, 2, 3, 4, 5, 6, 7, 8] }] })).toBe(1);
  });
});

describe("rules and built-in defaults", () => {
  it("runs reads and creates, asks for destructive actions and large writes, and leaves changes to the classifier", () => {
    expect(evaluatePolicy({ name: "tracker__list_items", args: {}, facts: tracker("list_items", "read") }).settled).toMatchObject({ outcome: "allow", kind: "read" });
    expect(evaluatePolicy({ name: "tracker__save_item", args: { title: "Refund" }, facts: tracker("save_item", "write") }).settled).toMatchObject({ outcome: "allow", kind: "create" });
    expect(evaluatePolicy({ name: "tracker__save_item", args: { id: "T-6", state: "Done" }, facts: tracker("save_item", "write") }).settled)
      .toEqual({ outcome: "ask", source: "default", kind: "destructive", reason: "the call sets \"state\"; destructive actions always ask" });
    const labels = (count: number) => ({ title: "x", labels: Array.from({ length: count }, (_, index) => `l${index}`) });
    expect(evaluatePolicy({ name: "tracker__save_item", args: labels(BULK_ITEM_LIMIT), facts: tracker("save_item", "write") }).settled).toMatchObject({ kind: "create" });
    expect(evaluatePolicy({ name: "tracker__save_item", args: labels(BULK_ITEM_LIMIT + 1), facts: tracker("save_item", "write") }).settled).toMatchObject({ outcome: "ask", kind: "bulk" });
    expect(evaluatePolicy({ name: "tracker__save_item", args: { id: "T-5" }, facts: tracker("save_item", "write") }).settled).toBeUndefined();
  });

  it("lets destructiveHint tighten only what AgentX cannot tell: a tool whose connector declares no item argument", () => {
    const hinted = (itemArguments: readonly string[] | undefined) => tracker("save_item", "write", { itemArguments, hints: { destructiveHint: true } });
    expect(evaluatePolicy({ name: "tracker__save_item", args: { title: "x" }, facts: hinted(undefined) }).settled).toMatchObject({ outcome: "ask", kind: "hint" });
    expect(evaluatePolicy({ name: "tracker__save_item", args: { title: "x" }, facts: hinted(["id"]) }).settled).toMatchObject({ outcome: "allow", kind: "create" });
    expect(evaluatePolicy({ name: "tracker__save_item", args: { id: "T-5" }, facts: hinted(["id"]) }).settled).toBeUndefined();
  });

  it("applies deny, then ask, then allow, whatever order the rules are listed in", () => {
    const policy: ActionPolicy = { rules: [
      { tool: "tracker__*", outcome: "allow" },
      { tool: "*_item", outcome: "ask" },
      { tool: "close_*", connector: "tracker", outcome: "deny", reason: "Closing is frozen for the audit." },
    ] };
    expect(evaluatePolicy({ name: "tracker__close_item", args: {}, facts: tracker("close_item", "write"), policy }).settled)
      .toEqual({ outcome: "deny", source: "rule", kind: "admin", rule: 3, reason: "Closing is frozen for the audit." });
    expect(evaluatePolicy({ name: "tracker__save_item", args: {}, facts: tracker("save_item", "write"), policy }).settled)
      .toEqual({ outcome: "ask", source: "rule", kind: "admin", rule: 2, reason: "an administrator's ask rule matches *_item" });
    expect(evaluatePolicy({ name: "tracker__list_things", args: { id: "x" }, facts: tracker("list_things", "write"), policy }).settled)
      .toMatchObject({ outcome: "allow", source: "rule", kind: "allowed", rule: 1 });
  });

  it("matches a connector rule on the vendor's tool name and a plain rule on the presented name, never across connectors", () => {
    const policy: ActionPolicy = { rules: [{ tool: "save_item", connector: "other", outcome: "deny" }, { tool: "save_item", outcome: "deny" }] };
    expect(evaluatePolicy({ name: "tracker__save_item", args: { id: "T-5" }, facts: tracker("save_item", "write"), policy }).settled).toBeUndefined();
  });

  it("reclassifies with the first matching treatAs rule, which whenArguments can narrow", () => {
    const policy: ActionPolicy = { rules: [
      { tool: "save_item", connector: "tracker", whenArguments: ["assignee"], treatAs: "destructive" },
      { tool: "transition_item", connector: "tracker", treatAs: "change" },
    ] };
    expect(evaluatePolicy({ name: "tracker__save_item", args: { title: "x", assignee: "bob" }, facts: tracker("save_item", "write"), policy }))
      .toMatchObject({ actionClass: "destructive", classRule: 1, settled: { kind: "destructive" } });
    expect(evaluatePolicy({ name: "tracker__transition_item", args: { id: "T-5", transitionName: "In Progress" }, facts: tracker("transition_item", "write"), policy }))
      .toEqual({ actionClass: "change", classRule: 2 });
  });

  it("governs in-house tools by rule too", () => {
    const policy: ActionPolicy = { rules: [{ tool: "agentx_submit_task", outcome: "ask", reason: "Coding work needs a person." }] };
    expect(evaluatePolicy({ name: "agentx_submit_task", args: { prompt: "fix it" }, policy }).settled).toMatchObject({ outcome: "ask", kind: "admin", rule: 1 });
    expect(evaluatePolicy({ name: "agentx_submit_task", args: { prompt: "fix it" }, worker: prepared(true) }).settled).toMatchObject({ outcome: "allow", kind: "read" });
  });
});
