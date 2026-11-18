// Naming phase 1: a project's stored action policy written before the rename names in-house tools as `agentx_...`.
// Those rules keep applying (read as the `rovara_` twin); the old id is never offered as a tool.
import { describe, expect, it } from "vitest";
import { IN_HOUSE_TOOL_NAMES, actionPolicyProblems, inHouseToolPattern, type ActionPolicy } from "../../packages/contracts/src/index.js";
import { evaluatePolicy } from "../../packages/orchestrator/src/action-policy.js";

const policy = (tool: string, outcome: "allow" | "ask" | "deny"): ActionPolicy => ({ rules: [{ tool, outcome, reason: "test" }] });

describe("a stored rule that names an in-house tool by its old id", () => {
  it("is read as the rovara_ twin, for an exact id and a glob, and only for the leading prefix", () => {
    expect(inHouseToolPattern("agentx_create_pull_request")).toBe("rovara_create_pull_request");
    expect(inHouseToolPattern("agentx_*")).toBe("rovara_*");
    expect(inHouseToolPattern("rovara_create_pull_request")).toBe("rovara_create_pull_request");
    expect(inHouseToolPattern("agentx__list_items")).toBe("agentx__list_items");
    expect(inHouseToolPattern("tracker__agentx_x")).toBe("tracker__agentx_x");
  });

  it("still denies and asks the call it was written for", () => {
    const create = { name: "rovara_create_pull_request", args: { repository: "web" } };
    expect(evaluatePolicy({ ...create, policy: policy("agentx_create_pull_request", "deny") }).settled).toMatchObject({ outcome: "deny" });
    expect(evaluatePolicy({ ...create, policy: policy("agentx_*", "ask") }).settled).toMatchObject({ outcome: "ask" });
    expect(evaluatePolicy({ ...create, policy: policy("rovara_create_pull_request", "deny") }).settled).toMatchObject({ outcome: "deny" });
    // A rule for another tool does not touch it.
    expect(evaluatePolicy({ ...create, policy: policy("agentx_submit_task", "deny") }).settled?.outcome).not.toBe("deny");
  });

  it("registers (the rule matches a tool the project offers) and the old id is not an offered tool", () => {
    const project = (tool: string) => ({ name: "web", revision: 1, actionPolicy: policy(tool, "ask") }) as Parameters<typeof actionPolicyProblems>[0];
    expect(actionPolicyProblems(project("agentx_create_pull_request"))).toEqual([]);
    expect(actionPolicyProblems(project("agentx_*"))).toEqual([]);
    expect(actionPolicyProblems(project("agentx_no_such_tool"))).toEqual(["action policy rule 1: agentx_no_such_tool matches no tool this project offers"]);
    expect([...IN_HOUSE_TOOL_NAMES].some((name) => name.startsWith("agentx_"))).toBe(false);
  });
});
