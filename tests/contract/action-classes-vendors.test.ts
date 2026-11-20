// Pins the class AgentX gives every tool in the recorded vendor catalogs (spec 014 D1), from the
// vendor's hints and each connector's declared item arguments, with no vendor name in gate code.
import { describe, expect, it } from "vitest";
import { schemaHasItemPath } from "../../packages/contracts/src/index.js";
import { asanaConnector, type McpConnection } from "../../packages/gateway/src/index.js";
import { baseClass, type ToolFacts } from "../../packages/orchestrator/src/action-policy.js";
import { vendorToolsWithAnnotations } from "../support/vendor-fixtures.js";

const unused = { issue: () => { throw new Error("not used"); } };

function facts(connector: string, tool: McpConnection["tools"][number], itemArguments: readonly string[]): ToolFacts {
  const annotations = tool.annotations ?? {};
  return {
    connector, upstreamName: tool.name, access: annotations.readOnlyHint === true ? "read" : "write",
    hints: { readOnlyHint: annotations.readOnlyHint as boolean, destructiveHint: annotations.destructiveHint as boolean },
    itemArguments: itemArguments.filter((path) => schemaHasItemPath(tool.inputSchema, path)),
  };
}

describe("the class of every recorded vendor tool", () => {

  it("Asana: completing a task inside update_tasks is destructive", () => {
    const update = facts("asana", vendorToolsWithAnnotations("asana").find((tool) => tool.name === "update_tasks")!, asanaConnector(unused).itemArguments!);
    expect(baseClass("asana__update_tasks", update, { tasks: [{ task: "1201", completed: true }] })).toBe("destructive");
    expect(baseClass("asana__update_tasks", update, { tasks: [{ task: "1201", name: "Renamed" }] })).toBe("change");
  });

});
