import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "@agentx/contracts";
import { createE2ERuntimeAssets, parseE2EFirstPartyCapture } from "../../packages/verifier/src/runtime-assets.js";
import { expectedE2EConfigDigest } from "../../packages/verifier/src/identity.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const compiled = () => {
  const files = new Map([
    ["e2e.config.json", JSON.stringify({ projectId: "rovara-contract-p0", tests: [".agentx/e2e/generated-contract.test.ts"], targets: [{ name: "contract-api", platform: "contract-api" }], workers: 1, retries: 0, timeout: 10_000, cache: "off" }) + "\n"],
    [".agentx/e2e/generated-contract.test.ts", "import { test } from 'e2e';\n"],
    [".agentx/e2e/selection-packet.json", "{}\n"],
  ]);
  const config = JSON.parse(files.get("e2e.config.json")!) as { projectId: string; tests: string[]; targets: { name: string; platform: string }[]; workers: number; retries: number; timeout: number; cache: "off" };
  const expectedConfigDigest = expectedE2EConfigDigest(config);
  const inventoryFiles = [...files].map(([path, content]) => ({ path, sha256: sha(content), byteLength: Buffer.byteLength(content), role: path.endsWith(".json") && path !== "e2e.config.json" ? "selection-packet" as const : path.endsWith(".json") ? "config" as const : "test" as const }));
  const inventoryBody = { schemaVersion: 1 as const, compilerProtocol: "trusted-e2e-compiler/v1" as const, upstream: { package: "e2e" as const, version: "0.20.0" as const, idAlgorithm: "e2e-0.20.0-test-id-result-id/v1" as const, configDigestAlgorithm: "e2e-0.20.0-sanitized-config/v1" as const, expectedConfigDigest }, files: inventoryFiles };
  return { files, expectedConfigDigest, inventory: { ...inventoryBody, digest: sha(canonicalJson(inventoryBody)) } };
};

describe("managed E2E runtime assets", () => {
  it("accepts exactly one launch-bound run-start capture and classifies missing or duplicate rows as unknown", () => {
    const line = JSON.stringify({ schemaVersion: "e2e-run-start-capture/v1", challenge: "launch-1111111111111111", runId: "01a135e3-7073-77fe-ba64-1e8ddc903406", seq: 4, at: "2026-10-13T15:31:00.371Z" }) + "\n";
    expect(parseE2EFirstPartyCapture(new TextEncoder().encode(line), "launch-1111111111111111").status).toBe("valid");
    expect(parseE2EFirstPartyCapture(new Uint8Array(), "launch-1111111111111111").status).toBe("missing");
    expect(parseE2EFirstPartyCapture(new TextEncoder().encode(line + line), "launch-1111111111111111").status).toBe("duplicate");
  });

  it("keeps the immutable compiler files separate and computes a reporter-empty launch digest", () => {
    const input = compiled();
    const assets = createE2ERuntimeAssets(input as never, { launchId: "launch-1111111111111111", capturePath: "/owned/run-start.jsonl", workerBridgePath: "/owned/worker-bridge.mjs" });
    expect([...assets.compilerFiles.keys()]).toEqual([...input.files.keys()]);
    expect(assets.compilerFiles.get("e2e.config.json")).toBe(input.files.get("e2e.config.json"));
    expect(assets.launchConfigDigest).not.toBe(input.expectedConfigDigest);
    expect(assets.launchProjection.reporters).toEqual([]);
    expect(assets.assets["runtime-config.mjs"]).toContain("reporters: [reporter]");
    expect(assets.assets["worker-bridge.mjs"]).toContain('item.probeId === "module-export-names"');
    expect(assets.assets["worker-bridge.mjs"]).toContain('inventory.protocol !== "registered-module-export-inventory/v1"');
    expect(assets.assetDigests).toEqual(Object.fromEntries(Object.entries(assets.assets).map(([name, content]) => [name, sha(content)])));
  });

  it("rejects changed compiler config and unsafe capture locations", () => {
    const input = compiled();
    const altered = { ...input, files: new Map(input.files).set("e2e.config.json", "{}\n") };
    expect(() => createE2ERuntimeAssets(altered as never, { launchId: "launch-1111111111111111", capturePath: "/owned/run-start.jsonl", workerBridgePath: "/owned/worker-bridge.mjs" })).toThrow(/compiler|config/i);
    expect(() => createE2ERuntimeAssets(input as never, { launchId: "launch-1111111111111111", capturePath: "/tmp/run-start.jsonl", workerBridgePath: "/owned/worker-bridge.mjs" })).toThrow(/owned|path/i);
  });
});
