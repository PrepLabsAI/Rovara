import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createE2EAppAdapterPacket } from "../../packages/verifier/src/runtime-adapter.js";
import type { E2ECompiledSuite } from "../../packages/verifier/src/scenarios.js";
import type { E2ESourceSnapshot } from "@agentx/contracts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

describe("fixed ordinary-source adapter", () => {
  it("retains exact candidate bytes and emits a distinct wrapper for named invocation and inspection", () => {
    const source = "export async function run(input) { return { ...input, observed: true }; }\n";
    const manifest = JSON.stringify({ name: "app", exports: { "./rows": "./src/app.js" } });
    const snapshot = { sources: [{ path: "apps/app/package.json", bytes: new TextEncoder().encode(manifest), sha256: sha(manifest), kind: "blob" }, { path: "apps/app/src/app.js", bytes: new TextEncoder().encode(source), sha256: sha(source), kind: "blob" }] } as unknown as E2ESourceSnapshot;
    const compiled = { caseBindings: new Map([["case", { applicationId: "app", manifestPath: "apps/app/package.json", moduleSpecifier: "./src/app.js", packageExportSubpath: "./rows", callableSelector: { kind: "named", exportName: "run" } }]]), expectedCases: [{ caseId: "case", scenarioId: "scenario" }], bundle: { scenarios: [{ scenarioId: "scenario" }] } } as unknown as E2ECompiledSuite;
    const feature = createE2EAppAdapterPacket({ compiled, snapshot, caseId: "case", mode: "feature" });
    const inspectionCompiled = { ...compiled, caseBindings: new Map([["case", { ...compiled.caseBindings.get("case"), callableSelector: null, expectedExportNames: ["run"] }]]) } as unknown as E2ECompiledSuite;
    const inspect = createE2EAppAdapterPacket({ compiled: inspectionCompiled, snapshot, caseId: "case", mode: "inspect" });
    expect(feature.status).toBe("ready");
    expect(inspect.status).toBe("ready");
    expect(feature.packet?.entry).toBe("__agentx_adapter__/entry.mjs");
    expect(new TextDecoder().decode(feature.packet?.files.find((file) => file.path === "apps/app/src/app.js")?.bytes)).toBe(source);
    const featureEntry = new TextDecoder().decode(feature.packet?.files.find((file) => file.path === feature.packet?.entry)?.bytes);
    expect(featureEntry).toContain("../apps/app/src/app.js");
    expect(featureEntry).not.toContain("original-module.mjs");
    expect(feature.packet?.files.some((file) => file.path === "apps/app/package.json")).toBe(true);
    expect(feature.packet?.files.find((file) => file.path === feature.packet?.entry)?.bytes).not.toEqual(inspect.packet?.files.find((file) => file.path === inspect.packet?.entry)?.bytes);
    expect(feature.originalSourceDigest).not.toBe(feature.adapterDigest);
  });

  it("resolves the registered application package when other candidates expose the same export", () => {
    const source = "export default async function(input) { return { app: input.app }; }\n";
    const manifest = JSON.stringify({ name: "app", type: "module", exports: { "./rows": "./src/app.js" } });
    const otherManifest = JSON.stringify({ name: "other", type: "module", exports: { "./rows": "./src/app.js" } });
    const snapshot = { sources: [
      { path: "apps/app/package.json", bytes: new TextEncoder().encode(manifest), sha256: sha(manifest), kind: "blob" },
      { path: "apps/app/src/app.js", bytes: new TextEncoder().encode(source), sha256: sha(source), kind: "blob" },
      { path: "apps/other/package.json", bytes: new TextEncoder().encode(otherManifest), sha256: sha(otherManifest), kind: "blob" },
      { path: "apps/other/src/app.js", bytes: new TextEncoder().encode(source), sha256: sha(source), kind: "blob" },
    ] } as unknown as E2ESourceSnapshot;
    const compiled = { caseBindings: new Map([["case", { applicationId: "app", manifestPath: "apps/app/package.json", moduleSpecifier: "./src/app.js", packageExportSubpath: "./rows", callableSelector: { kind: "default" } }]]), expectedCases: [{ caseId: "case", scenarioId: "scenario" }], bundle: { scenarios: [{ scenarioId: "scenario" }] } } as unknown as E2ECompiledSuite;
    const packet = createE2EAppAdapterPacket({ compiled, snapshot, caseId: "case", mode: "feature" });
    expect(packet.status).toBe("ready");
    expect(packet.packet?.files.map((item) => item.path)).toContain("apps/app/src/app.js");
    expect(packet.packet?.files.map((item) => item.path)).not.toContain("apps/other/src/app.js");
  });

  it("resolves a compiler-attested repository-root package without guessing an apps path", () => {
    const source = "export default async function(input) { return input; }\n";
    const manifest = JSON.stringify({ name: "root-app", type: "module", exports: { "./rows": "./src/app.js" } });
    const snapshot = { sources: [
      { path: "package.json", bytes: new TextEncoder().encode(manifest), sha256: sha(manifest), kind: "blob" },
      { path: "src/app.js", bytes: new TextEncoder().encode(source), sha256: sha(source), kind: "blob" },
    ] } as unknown as E2ESourceSnapshot;
    const compiled = { caseBindings: new Map([["case", { applicationId: "root-app", manifestPath: "package.json", moduleSpecifier: "./src/app.js", packageExportSubpath: "./rows", callableSelector: { kind: "default" } }]]), expectedCases: [{ caseId: "case", scenarioId: "scenario" }], bundle: { scenarios: [{ scenarioId: "scenario" }] } } as unknown as E2ECompiledSuite;
    const packet = createE2EAppAdapterPacket({ compiled, snapshot, caseId: "case", mode: "feature" });
    expect(packet.status).toBe("ready");
    expect(packet.packet?.files.map((item) => item.path)).toContain("src/app.js");
    expect(new TextDecoder().decode(packet.packet?.files.find((item) => item.path === packet.packet?.entry)?.bytes)).toContain("../src/app.js");
  });

  it("installs only the exact source-bound GET mock and denies unmatched real fetches", () => {
    const source = "export default async function run(input) { return fetch(`/api/rows?kind=${input.kind}`).then((response) => response.json()); }\n";
    const manifest = JSON.stringify({ name: "app", type: "module", exports: { "./rows": "./src/app.js" } });
    const openapi = JSON.stringify({ openapi: "3.0.3", info: { title: "rows", version: "1" }, paths: { "/api/rows": { get: { operationId: "getRows" } } } });
    const snapshot = { sources: [
      { path: "apps/app/package.json", bytes: new TextEncoder().encode(manifest), sha256: sha(manifest), kind: "blob" },
      { path: "apps/app/src/app.js", bytes: new TextEncoder().encode(source), sha256: sha(source), kind: "blob" },
      { path: "apps/app/openapi.json", bytes: new TextEncoder().encode(openapi), sha256: sha(openapi), kind: "blob" },
    ] } as unknown as E2ESourceSnapshot;
    const apiFixture = { schemaVersion: "source-backed-api-fixtures/v1", operationId: "getRows", method: "GET", path: "/api/rows", inputField: "kind", variants: [
      { id: "success", inputValue: "success", status: 200, body: { rows: [] } },
      { id: "refusal", inputValue: "refusal", status: 403, body: { error: "refused" } },
      { id: "invalid-data", inputValue: "invalid", status: 200, body: { rows: "bad" } },
    ] };
    const compiled = { caseBindings: new Map([["case", { applicationId: "app", manifestPath: "apps/app/package.json", requestedTargetId: "requested", moduleSpecifier: "./src/app.js", packageExportSubpath: "./rows", callableSelector: { kind: "default" } }]]), expectedCases: [{ caseId: "case", scenarioId: "scenario" }], bundle: { scenarios: [{ scenarioId: "scenario" }] }, group: { mocks: [{ componentId: "api-schema-abc", requestedTargetId: "requested", kind: "api", contractDigest: "0".repeat(64), fixtureVersion: "openapi-json-fixture-v1", sourceRefs: [{ path: "apps/app/openapi.json", sha256: sha(openapi) }], reason: "phase-unavailable", apiFixture }] } } as unknown as E2ECompiledSuite;
    const packet = createE2EAppAdapterPacket({ compiled, snapshot, caseId: "case", mode: "feature", mockSpecs: compiled.group.mocks });
    const entry = new TextDecoder().decode(packet.packet?.files.find((file) => file.path === packet.packet?.entry)?.bytes);
    expect(packet.declaredMockComponentIds).toEqual(["api-schema-abc"]);
    expect(entry).toContain("candidate request does not preserve the approved input-to-request binding");
    expect(entry).toContain("network request is outside the declared source-backed mock inventory");
    expect(entry).toContain("http://agentx-mock.invalid");
  });
});
