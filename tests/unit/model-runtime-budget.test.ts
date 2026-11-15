import { describe, expect, it } from "vitest";
import { budgetScopeOfProxyBody } from "../../packages/model-runtime/src/budget.js";
describe("model gateway budget refusal", () => {
  it.each([
    [422, '{"error":{"type":"budget_exceeded","message":"Budget has been exceeded! Team=x"}}', "org"],
    [422, '{"error":{"type":"budget_exceeded","message":"ExceededBudget: User=x"}}', "member"],
    [422, '{"error":{"type":"budget_exceeded","message":"Budget has been exceeded! Key=x"}}', "task"],
    [400, '{"error":{"type":"budget_exceeded","message":"Budget has been exceeded! Team=x"}}', undefined],
    [422, "{", undefined], [422, "null", undefined], [422, "{}", undefined], [422, '{"error":null}', undefined],
    [422, '{"error":{"message":"Budget has been exceeded! Team=x"}}', undefined],
    [422, '{"error":{"type":"budget_exceeded","message":5}}', undefined],
    [422, '{"error":{"type":"budget_exceeded","message":"unknown"}}', undefined],
  ] as const)("golden: preserves the existing response classification (%s, %s)", (status, body, expected) => {
    expect(budgetScopeOfProxyBody(status, body)).toBe(expected);
  });
  it("recognizes the project cap without keeping the project or credential text", () => {
    expect(budgetScopeOfProxyBody(422, JSON.stringify({ error: { type: "budget_exceeded", message: "Budget has been exceeded! Project=private-marker" } }))).toBe("project");
  });
});
