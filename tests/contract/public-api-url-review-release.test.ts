// Opus review (CODE-PUBLIC-URL), uncommitted: the legacy release must be able to CREATE the control plane (the rebuild case the guard exists for). readPublicApiInputs reads the running
// control plane with describeStack, which throws on a stack that does not exist, so a release with no AgentXControlPlane stops before deploying anything. plannedPublicApiUrl already takes
// `controlPlane: undefined` (a fresh stack: no confirm needed); the reader must give it that.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadPublicApiUrlContracts, plannedPublicApiUrl } from "../../scripts/release-production.js";

const source = readFileSync(join(import.meta.dirname, "..", "..", "scripts", "release-production.ts"), "utf8");

beforeAll(async () => { await loadPublicApiUrlContracts(); });

describe("review: the legacy release on a missing control plane (rebuild)", () => {
  it("reads the running control plane only if it exists", () => {
    expect(source).toContain("controlPlane: describeIfExists(runner, options.region, CONTROL_PLANE_STACK),");
  });

  it("a fresh control plane takes the address stack's origin without the confirm", () => {
    const address = { Outputs: [{ OutputKey: "PublicApiOrigin", OutputValue: "https://api.example.dev" }] };
    expect(plannedPublicApiUrl({ address, controlPlane: undefined, foundation: undefined, proposed: undefined, required: true, confirmChange: false })).toBe("https://api.example.dev");
  });
});
