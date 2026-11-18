// L4-VX G10 (moved here from ai-builder-standin.test.ts by L4-EVV: the name-use guard in model-egress-block.test.ts excludes tests/unit/model-egress-*.test.ts): what Influur's own tests would meet when they call a real Google host.
import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_ALLOW_DOMAINS, builtinModelCatalog, findRedirectEscapes, modelHostBlockList } from "@agentx/contracts";
import { laptopSandboxDenyList } from "../../packages/broker/src/local/isolation/sandbox-model-deny.js";
import { hostAlreadyAllowed, refuseSetupHost } from "../../packages/broker/src/core/setup-agent/host-refusal.js";

describe("a real Google host called without an allow-list entry (what Influur's own tests would meet)", () => {
  const vertexHost = "us-central1-aiplatform.googleapis.com";
  const tokenHosts = ["oauth2.googleapis.com", "www.googleapis.com", "sts.googleapis.com", "iamcredentials.googleapis.com"];
  it("the default DNS allow list has no Google host, so every name below is NXDOMAIN in a hosted sandbox until the project adds it", () => {
    expect(DEFAULT_AGENT_ALLOW_DOMAINS.filter(host => host.includes("google"))).toEqual([]);
    for (const host of [vertexHost, "aiplatform.googleapis.com", ...tokenHosts]) expect(hostAlreadyAllowed(host, [])).toBe(false);
  });
  it("a project adds a host by exact name through a setup host ask (an owner or admin approves it); only then is it covered", () => {
    const project = [vertexHost, "oauth2.googleapis.com"];
    expect(hostAlreadyAllowed(vertexHost, project)).toBe(true);
    expect(hostAlreadyAllowed("oauth2.googleapis.com", project)).toBe(true);
    // A wildcard is not implied: another region and another Google host stay blocked.
    expect(hostAlreadyAllowed("europe-west1-aiplatform.googleapis.com", project)).toBe(false);
    expect(hostAlreadyAllowed("www.googleapis.com", project)).toBe(false);
    // A hosted install can be asked for these names (no card is refused); a laptop's deny list refuses the model host with fixed words and leaves the token hosts askable.
    expect(refuseSetupHost(vertexHost)).toBeUndefined();
    expect(refuseSetupHost(vertexHost, undefined, laptopSandboxDenyList())).toBe("model_host");
    expect(refuseSetupHost("oauth2.googleapis.com", undefined, laptopSandboxDenyList())).toBeUndefined();
    // Storage under Google is refused outright, however the project asks.
    expect(refuseSetupHost("storage.googleapis.com")).toBe("raw_storage");
  });
  it("in a test round a model host is blocked by name even if the project allowed it: the run says so in fixed words, the token hosts are not flagged", () => {
    const blocked = modelHostBlockList(builtinModelCatalog().rows, []);
    expect(blocked).toContain(vertexHost);
    const found = findRedirectEscapes(blocked, [vertexHost, "oauth2.googleapis.com"]);
    expect(found).toEqual([{ host: vertexHost, kind: "ignored_redirect", sentence: `not run: client ignored the redirect (called ${vertexHost})` }]);
    // A Vertex location the catalog does not list is still named, as an unlisted model host.
    expect(findRedirectEscapes(blocked, ["me-central7-aiplatform.googleapis.com"])[0]).toMatchObject({ kind: "unlisted_model_host" });
  });
});
