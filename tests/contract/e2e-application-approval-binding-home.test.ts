import { describe, expect, it } from "vitest";
import * as contracts from "@agentx/contracts";
import * as broker from "../../packages/broker/src/e2e/application-plan-binding.js";

// The approval binding derivation is pure, so it lives in contracts where the verifier's production probe runner can use it
// without importing the broker. The broker module stays as the path every existing caller imports from.
describe("application approval binding derivation", () => {
  it("is defined in contracts and re-exported unchanged by the broker module", () => {
    expect(typeof contracts.deriveE2EApplicationApprovalBinding).toBe("function");
    expect(broker.deriveE2EApplicationApprovalBinding).toBe(contracts.deriveE2EApplicationApprovalBinding);
    expect(broker.validateE2EAppBuildBinding).toBe(contracts.validateE2EAppBuildBinding);
    expect(broker.e2eApplicationMetadataSourceRefs).toBe(contracts.e2eApplicationMetadataSourceRefs);
  });
});
