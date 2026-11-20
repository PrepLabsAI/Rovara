import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { WEB_API_NETWORK_POLICY, WEB_API_NETWORK_POLICY_DIGEST, WEB_API_PROBE_PROPOSAL_MAX_BYTES, WEB_API_REQUIRED_PROBES, canonicalJson } from "../../packages/contracts/src/index.js";

describe("web/API probe run binding", () => {

  it("requires the network wall probes, and a network policy digest that differs from the one runners had before the walls", () => {
    expect(WEB_API_REQUIRED_PROBES.slice(0, 11).map((probe) => probe.probeId).slice(-4, -1)).toEqual(["build-imds-denial-v1", "build-lateral-denial-v1", "app-host-denial-v1"]);
    expect(WEB_API_NETWORK_POLICY).toMatchObject({ schemaVersion: "e2e-web-api-network-policy/v2", hostAccess: "denied", privateRanges: "denied", buildNetwork: "per-run-internet-only" });
    // The v1 policy (internal network, no egress, no metadata) as it was hashed before the walls: a runner registered with it must not match.
    const v1 = { schemaVersion: "e2e-web-api-network-policy/v1", appNetwork: "per-run-internal", outsideEgress: "denied", instanceMetadata: "unreachable" };
    expect(WEB_API_NETWORK_POLICY_DIGEST).not.toBe(createHash("sha256").update(canonicalJson(v1)).digest("hex"));
    expect(WEB_API_NETWORK_POLICY_DIGEST).toBe(createHash("sha256").update(canonicalJson(WEB_API_NETWORK_POLICY)).digest("hex"));
  });

  it("bounds the whole proposal at 5 MiB", () => {
    expect(WEB_API_PROBE_PROPOSAL_MAX_BYTES).toBe(5 * 1024 * 1024);
  });

});
