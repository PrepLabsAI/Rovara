import { join } from "node:path";
import type { Node } from "typescript";
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID } from "@agentx/contracts";
import * as keys from "../../packages/broker/src/core/task-flow/keys.js";

const A = IMPLICIT_COMPANY_ID;
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
});

// Only these task-flow modules are in T1; core/company purge remains the independently inventoried T4 path.
const roots = ["core/task-flow", "core/setup-agent", "core/e2e", "core/proof", "core/build-step", "core/plan", "core/merge", "core/design-review", "core/test-env", "core/sessions", "core/model-gateway", "core/work-breakdown", "services", "e2e"];
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
