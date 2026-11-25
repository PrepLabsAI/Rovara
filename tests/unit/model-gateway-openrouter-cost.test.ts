import { expect, it } from "vitest";
import { parseReportedCost } from "../../packages/model-gateway/src/reported-cost.js";
it("reads total cost and upstream cost details without hiding a larger upstream debit", () => {
 expect(parseReportedCost("openrouter", { cost: 0.000000001, cost_details: { upstream_inference_cost: 0.000002001 } })).toBe(3);
 expect(parseReportedCost("openrouter", { cost: 0.02, cost_details: { upstream_inference_cost: 0.01 } })).toBe(20000);
 expect(parseReportedCost("openrouter", { cost: 0.000001001 })).toBe(2);
 expect(parseReportedCost("openrouter", { cost: 0.02, cost_details: { upstream_inference_cost: -1 } })).toBeUndefined();
});
