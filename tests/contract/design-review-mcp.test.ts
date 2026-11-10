// The MCP tool that reads a task's design review. It only reads: the cost choice, the answers and picking a paused review up are the owner's acts on the task's local page. Its text is Rovara's words, and what the
// reviewers and the planner wrote is passed through as plain data.
import { describe, expect, it, vi } from "vitest";
import { DEVELOPER_TOOLS } from "../../packages/mcp/src/index.js";

const state = {
  taskId: "11111111-1111-4111-8111-111111111111", status: "Waiting for your choice about what the review may cost.", facts: ["Spent so far: $0.00."],
  findings: [{ severity: "blocker", section: "§3", text: "Nothing bounds the retry.\u0007", from: "critic", open: true }],
  hold: { why: "The price of the model is not known", note: "If you run it anyway, Rovara counts it at $15 and $75 per million tokens (input and output). A dearer model can cost more than the limit.", choices: ["Run it anyway", "Skip design review"] },
  questions: { round: 1, items: [{ id: "q1", text: "How many times may it retry?", options: [{ id: "a", label: "Three" }, { id: "b", label: "Once" }] }] },
  parked: true, blockerReasonNeeded: true,
};

describe("agentx_get_design_review", () => {
  const tool = DEVELOPER_TOOLS.find((entry) => entry.name === "agentx_get_design_review")!;

  it("is a read: it asks for the task's review and says what waits for the owner, and that the owner acts on the page", async () => {
    const client = { getDesignReview: vi.fn(async () => state) };
    const result = await tool.handler({ client } as never, { task_id: state.taskId }, {} as never);
    expect(client.getDesignReview).toHaveBeenCalledWith(state.taskId);
    expect(result.structured).toMatchObject({ parked: true, blocker_reason_needed: true, hold: { choices: ["Run it anyway", "Skip design review"] }, questions: [{ id: "q1", options: ["Three", "Once"] }], findings: [{ severity: "blocker", open: true }] });
    expect(result.text).toContain("Waiting for the owner's choice");
    expect(result.text).toContain("counts it at $15 and $75");
    expect(result.text).toContain("The planner asks 1 question");
    expect(result.text).toContain("1 finding, 1 open.");
    expect(result.text).toContain("A tool cannot.");
    // A control character in a model's words does not reach the reader.
    const findings = (result.structured as { findings: Array<{ text: string }> }).findings;
    expect(findings[0]?.text).not.toContain("\u0007");
    expect(findings[0]?.text).toContain("Nothing bounds the retry.");
    expect(result.text).not.toContain("\u0007");
  });

  it("takes only a task id and changes nothing", () => {
    expect(Object.keys(tool.inputSchema)).toEqual(["task_id"]);
    expect(tool.description).toContain("It only reads");
  });
});
