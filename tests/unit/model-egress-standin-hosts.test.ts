// L4-VX G10 (moved here from ai-builder-standin.test.ts by L4-EVV): what Influur's own tests would meet when they call a real Google host.
// Batch 17: the batch-16 form of these cases (#984 adds the narrow Google Vertex AI group, owner decision 2026-11-17); the test-round case that read modelHostBlockList / findRedirectEscapes /
// builtinModelCatalog stays dropped (owner DEC 254zzz24).
import { describe, expect, it } from "vitest";
import { hostAlreadyAllowed, refuseSetupHost } from "../../packages/broker/src/core/setup-agent/host-refusal.js";

describe("Google hosts and the default allow list (batch 16: #984 adds the narrow Google Vertex AI group, owner decision 2026-11-17)", () => {
  const vertexHost = "us-central1-aiplatform.googleapis.com";
  it("a Google host outside the group is covered only when a project adds it by exact name (an owner or admin approves it)", () => {
    const project = ["www.googleapis.com"];
    expect(hostAlreadyAllowed("www.googleapis.com", project)).toBe(true);
    // A wildcard is not implied: an unlisted region and another Google host stay blocked.
    expect(hostAlreadyAllowed("me-central7-aiplatform.googleapis.com", project)).toBe(false);
    expect(hostAlreadyAllowed("storage.googleapis.com", project)).toBe(false);
    // A hosted install can be asked for these names (no card is refused).
    expect(refuseSetupHost(vertexHost)).toBeUndefined();
    // Storage under Google is refused outright, however the project asks.
    expect(refuseSetupHost("storage.googleapis.com")).toBe("raw_storage");
  });
});
