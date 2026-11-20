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
    // Fix round 1 (I1): "closed" is an inflection of "close", so the name alone now signals; a read-approved tool still reads.
    expect(destructiveSignal("list_closed_items", {})).toBe("the tool's name says \"close\"");
    expect(baseClass("tracker__list_closed_items", tracker("list_closed_items", "read", { itemArguments: [] }), {})).toBe("read");
    expect(destructiveSignal("list_open_items", {})).toBeUndefined();
    // Completing an item closes it in some trackers (R19).
    expect(LIFECYCLE_KEYS.has("completed")).toBe(true);
    expect(destructiveSignal("save_item", { id: "T-1", completed: true })).toBe("the call sets \"completed\"");
    expect(destructiveSignal("edit_item", { fields: { completed: false } })).toBe("the call sets \"fields.completed\"");
  });

  it("treats a tool whose connector declares no item argument as a change, never as destructive without a signal", () => {
    expect(baseClass("tracker__save_item", tracker("save_item", "write", { itemArguments: undefined }), { title: "x" })).toBe("change");
    expect(baseClass("mystery_tool", undefined, { x: 1 })).toBe("change");
    expect(evaluatePolicy({ name: "tracker__save_item", args: { id: "T-5" }, facts: tracker("save_item", "write") })).toEqual({ actionClass: "change" });
  });

  it("classifies in-house tools in code: coding work is a change only while the thread has no compute", () => {
    // Fix round 1 (M3): with no worker passed, the task tools that depend on compute fail closed as a change.
    expect(IN_HOUSE_TOOL_NAMES.map((name) => baseClass(name, undefined, {}))).toEqual(["change", "change", "read", "read", "change", "change"]);
    expect(baseClass("agentx_submit_task", undefined, {}, prepared(false))).toBe("change");
    expect(baseClass("agentx_submit_task", undefined, {}, prepared(true))).toBe("read");
    expect(baseClass("agentx_follow_up", undefined, {}, prepared(false))).toBe("read");
    for (const action of ["close", "replace", "revert"]) expect(baseClass("agentx_manage_pull_request", undefined, { action })).toBe("destructive");
    for (const action of ["edit", "append", "sync", "reopen"]) expect(baseClass("agentx_manage_pull_request", undefined, { action })).toBe("change");
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

});

describe("fix round 1 (task 2 review)", () => {
  const write = (upstreamName: string, itemArguments: readonly string[] | undefined = ["id"]) => tracker(upstreamName, "write", { itemArguments });
  // Facts whose connector declares no item arguments (the default parameter above would turn undefined into ["id"]).
  const undeclared = (upstreamName: string): ToolFacts => ({ ...tracker(upstreamName, "write"), itemArguments: undefined });

  it("I1: splits capital runs and letter-digit joins, and matches simple inflections of destructive words", () => {
    expect(nameWords("XMLDelete")).toEqual(["xml", "delete"]);
    expect(nameWords("DELETEItem")).toEqual(["delete", "item"]);
    expect(nameWords("HTTPClose")).toEqual(["http", "close"]);
    expect(nameWords("delete2")).toEqual(["delete", "2"]);
    expect(nameWords("v2delete")).toEqual(["v", "2", "delete"]);
    for (const name of ["XMLDelete", "DELETEItem", "HTTPClose", "delete2", "v2delete", "deletes", "closes", "removed"]) {
      expect(destructiveSignal(name, {}), name).toBeDefined();
      expect(baseClass(`tracker__${name}`, write(name), {}), name).toBe("destructive");
    }
    expect(destructiveSignal("closes", {})).toBe("the tool's name says \"close\"");
    expect(destructiveSignal("removed", {})).toBe("the tool's name says \"remove\"");
    // Fix round 2 (N3): gerunds and a doubled final "l" before "ed"/"ing".
    for (const name of ["cancelled", "cancelling", "closing", "deleting", "removing", "merging", "archiving", "close_issues", "cancel_orders"]) {
      expect(destructiveSignal(name, {}), name).toBeDefined();
      expect(baseClass(`tracker__${name}`, write(name), {}), name).toBe("destructive");
    }
    expect(destructiveSignal("cancelling", {})).toBe("the tool's name says \"cancel\"");
    expect(destructiveSignal("closing", {})).toBe("the tool's name says \"close\"");
    for (const name of ["set_string", "add_thing", "save_setting", "add_listing", "update_settings", "add_listings"]) {
      expect(destructiveSignal(name, {}), name).toBeUndefined();
      expect(baseClass(`tracker__${name}`, write(name), { id: "1" }), name).toBe("change");
    }
    for (const name of ["undelete", "unarchive", "reopen"]) {
      expect(destructiveSignal(name, {}), name).toBeUndefined();
      expect(baseClass(`tracker__${name}`, write(name), { id: "1" }), name).toBe("change");
    }
  });

  it("I3: a tool that offers item paths is destructive on a lifecycle key at any depth up to four; a tool with none keeps the shallow search", () => {
    expect(baseClass("tracker__save_item", write("save_item"), { items: [{ id: "1", state: "closed" }] })).toBe("destructive");
    expect(destructiveSignal("save_item", { items: [{ id: "1", state: "closed" }] }, ["id"])).toBe("the call sets \"items[].state\"");
    expect(baseClass("tracker__save_item", write("save_item"), { id: "1", updates: [{ state: "closed" }] })).toBe("destructive");
    expect(baseClass("tracker__save_item", write("save_item"), { id: "1", fields: { inner: { status: "Done" } } })).toBe("destructive");
    expect(destructiveSignal("save_item", { fields: { inner: { status: "Done" } } }, ["id"])).toBe("the call sets \"fields.inner.status\"");
    // Undeclared item arguments search deeply too.
    expect(baseClass("tracker__save_item", undeclared("save_item"), { updates: [{ state: "closed" }] })).toBe("destructive");
    // Depth four is searched; depth five is not.
    expect(baseClass("tracker__save_item", write("save_item"), { id: "1", a: { b: { c: { status: "x" } } } })).toBe("destructive");
    expect(baseClass("tracker__save_item", write("save_item"), { id: "1", a: { b: { c: { d: { status: "x" } } } } })).toBe("change");
    // Only own keys count.
    const inherited = Object.create({ state: "closed" }) as Record<string, unknown>;
    expect(baseClass("tracker__save_item", write("save_item"), { id: "1", fields: inherited })).toBe("change");
    // A tool that offers no item path keeps the shallow search.
    expect(baseClass("tracker__create_items", write("create_items", []), { items: [{ title: "x", completed: true }] })).toBe("create");
  });

  it("M1: arguments that are not a plain object make a write a change, never a throw", () => {
    for (const args of [null, undefined, "x", 3, ["a"]] as unknown as Array<Record<string, unknown>>) {
      expect(baseClass("tracker__save_item", write("save_item"), args)).toBe("change");
      expect(baseClass("tracker__save_item", undeclared("save_item"), args)).toBe("change");
      expect(baseClass("mystery_tool", undefined, args)).toBe("change");
      expect(baseClass("agentx_manage_pull_request", undefined, args)).toBe("change");
      expect(() => destructiveSignal("save_item", args, ["id"])).not.toThrow();
      expect(itemReference(write("save_item"), args)).toBeUndefined();
      expect(evaluatePolicy({ name: "tracker__save_item", args, facts: write("save_item"),
        policy: { rules: [{ tool: "tracker__*", whenArguments: ["id"], outcome: "deny" }] } })).toEqual({ actionClass: "change" });
    }
  });

  it("D2: only a rule naming the exact tool allows or reclassifies a destructive or bulk call", () => {
    const destroy = { name: "tracker__delete_item", args: { id: "1" }, facts: write("delete_item") };
    expect(evaluatePolicy({ ...destroy, policy: { rules: [{ tool: "tracker__*", outcome: "allow" }] } }))
      .toMatchObject({ actionClass: "destructive", settled: { outcome: "ask", source: "default", kind: "destructive" } });
    expect(evaluatePolicy({ ...destroy, policy: { rules: [{ tool: "tracker__delete_item", outcome: "allow" }] } }).settled)
      .toMatchObject({ outcome: "allow", source: "rule", kind: "allowed", rule: 1 });
    expect(evaluatePolicy({ ...destroy, policy: { rules: [{ tool: "*", treatAs: "read" }] } }))
      .toMatchObject({ actionClass: "destructive", settled: { outcome: "ask", kind: "destructive" } });
    expect(evaluatePolicy({ ...destroy, policy: { rules: [{ tool: "delete_item", connector: "tracker", treatAs: "change" }] } }))
      .toEqual({ actionClass: "change", classRule: 1 });
    // A wildcard deny still denies a destructive call.
    expect(evaluatePolicy({ ...destroy, policy: { rules: [{ tool: "tracker__*", outcome: "deny" }] } }).settled).toMatchObject({ outcome: "deny", kind: "admin" });
    // Bulk: a wildcard allow or treatAs does not settle it, an exact allow does.
    const bulk = { name: "tracker__save_item", args: { title: "x", labels: ["1", "2", "3", "4", "5", "6"] }, facts: write("save_item") };
    expect(evaluatePolicy({ ...bulk, policy: { rules: [{ tool: "tracker__*", outcome: "allow" }] } }).settled).toMatchObject({ outcome: "ask", kind: "bulk" });
    expect(evaluatePolicy({ ...bulk, policy: { rules: [{ tool: "*_item", treatAs: "read" }] } })).toMatchObject({ actionClass: "create", settled: { outcome: "ask", kind: "bulk" } });
    expect(evaluatePolicy({ ...bulk, policy: { rules: [{ tool: "tracker__save_item", outcome: "allow" }] } }).settled).toMatchObject({ outcome: "allow", kind: "allowed" });
    // A wildcard allow still settles a change.
    expect(evaluatePolicy({ name: "tracker__save_item", args: { id: "1" }, facts: write("save_item"), policy: { rules: [{ tool: "tracker__*", outcome: "allow" }] } }).settled)
      .toMatchObject({ outcome: "allow", kind: "allowed" });
  });
});
