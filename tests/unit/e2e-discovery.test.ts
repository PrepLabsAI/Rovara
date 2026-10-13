import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createCandidateManifest } from "@agentx/contracts";
import { inspectE2ERepository, proposeE2ESetup, type VerifiedE2ESourceSnapshot } from "../../packages/broker/src/e2e/discovery.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const target = { targetId: "api", applicationId: "server", runtimeProfileId: "api-phase-unavailable", accountProfileId: "synthetic", kind: "api" as const, protocol: "http" as const, originRef: "app-origin" };
const source = "openapi: 3.0.0\n";
const snapshot: VerifiedE2ESourceSnapshot = {
  candidate: createCandidateManifest([{ repositoryId: "acme/shop", commitSha: "a".repeat(40), treeSha: "b".repeat(40) }]),
  sources: [{ path: "api/openapi.yaml", sha256: hash(source), bytes: Buffer.from(source) }],
  treeComplete: true,
};
const inspection = {
  candidateDigest: snapshot.candidate.digest,
  sources: [{ path: "api/openapi.yaml", sha256: hash(source) }],
  applications: [{ applicationId: "server", kind: "api" as const, sourcePaths: ["api/openapi.yaml"], recipe: null }],
  proposedTargets: [target],
  dependencyEdges: [],
  proposedScenarios: [],
  missingInputs: [{ inputId: "auth", targetIds: ["api"], kind: "auth" as const, disposition: "mock-substitutable" as const, reason: "External identity is not connected", sourcePaths: ["api/openapi.yaml"] }],
};

describe("source-backed E2E setup proposal", () => {
  it("accepts only source refs whose bytes belong to the immutable candidate snapshot", () => {
    expect(proposeE2ESetup({ inspection, snapshot })).toMatchObject({ candidateDigest: snapshot.candidate.digest, state: "proposed", targets: [target] });
    expect(() => proposeE2ESetup({ inspection: { ...inspection, candidateDigest: "c".repeat(64) }, snapshot })).toThrow(/candidate/);
    expect(() => proposeE2ESetup({ inspection: { ...inspection, sources: [{ path: "api/openapi.yaml", sha256: "d".repeat(64) }] }, snapshot })).toThrow(/hash|snapshot/);
  });

  it("refuses fabricated paths and incomplete trees, while preserving a mock-ready connection gap", () => {
    expect(() => proposeE2ESetup({ inspection: { ...inspection, applications: [{ ...inspection.applications[0]!, sourcePaths: ["missing.yaml"] }] }, snapshot })).toThrow(/source|path/);
    expect(() => proposeE2ESetup({ inspection, snapshot: { ...snapshot, treeComplete: false } })).toThrow(/complete|truncated/);
    expect(proposeE2ESetup({ inspection, snapshot }).missingInputs[0]?.disposition).toBe("mock-substitutable");
  });
});

describe("immutable four-platform discovery", () => {
  it("maps mixed monorepo manifests to distinct platform targets and source-bound portable exports", async () => {
    const contents: Record<string, string> = {
      "apps/web/package.json": JSON.stringify({ name: "web-app", dependencies: { react: "1" }, scripts: { start: "vite" }, exports: { ".": "./src/index.js" } }),
      "apps/web/src/index.js": "export const run = () => true",
      "apps/api/package.json": JSON.stringify({ name: "api-app", dependencies: { express: "1" }, scripts: { start: "node api.js" }, exports: { ".": "./src/index.js" } }),
      "apps/api/src/index.js": "export const run = () => true",
      "apps/api/openapi.yaml": "openapi: 3.0.0",
      "apps/mobile/package.json": JSON.stringify({ name: "mobile-app", dependencies: { "react-native": "1" }, scripts: { start: "metro" }, exports: { ".": "./src/index.js" } }),
      "apps/mobile/src/index.js": "export const run = () => true",
      "apps/mobile/android/app/src/main/AndroidManifest.xml": "<manifest />",
      "apps/mobile/ios/Info.plist": "<plist />",
      "apps/desktop/package.json": JSON.stringify({ name: "desktop-app", dependencies: { electron: "1" }, scripts: { start: "electron ." }, exports: { ".": "./src/main.js" } }),
      "apps/desktop/src/main.js": "export const run = () => true",
      "apps/native/Windows/App.csproj": "<Project />",
      "apps/native/macOS/App.xcodeproj/project.pbxproj": "// project",
      "apps/native/linux/CMakeLists.txt": "project(native)",
    };
    const sources = Object.entries(contents).map(([path, text]) => ({ path, sha256: hash(text), bytes: Buffer.from(text), kind: "blob" as const }));
    const mixed: VerifiedE2ESourceSnapshot = {
      candidate: snapshot.candidate, treeComplete: true, treePaths: sources.map((source) => source.path), sources,
    };
    const discovered = inspectE2ERepository(mixed);
    expect(discovered.inspection.proposedTargets.map((item) => item.kind)).toEqual(["web", "api", "mobile", "mobile", "desktop", "desktop", "desktop", "desktop"]);
    expect(discovered.inspection.proposedTargets.filter((item) => item.kind === "mobile").map((item) => item.os)).toEqual(["android", "ios"]);
    expect(discovered.inspection.proposedTargets.filter((item) => item.kind === "desktop").map((item) => item.os).sort()).toEqual(["linux", "linux", "macos", "windows"]);
    expect(discovered.inspection.applications.find((item) => item.applicationId === "api-app")?.sourcePaths).toContain("apps/api/openapi.yaml");
    expect(discovered.inspection.dependencyEdges.some((edge) => edge.toComponentId.startsWith("api-schema-") && edge.sourcePaths.includes("apps/api/openapi.yaml"))).toBe(true);
    expect(discovered.portableOperations.every((item) => item.sourceRefs.every((ref) => sources.some((source) => source.path === ref.path && source.sha256 === ref.sha256)))).toBe(true);
    expect(discovered.inspection.proposedScenarios).toEqual([]);
    expect(discovered.inspection.missingInputs.some((item) => item.kind === "business-rule")).toBe(false);
    expect(proposeE2ESetup({ inspection: discovered.inspection, snapshot: mixed }).state).toBe("proposed");
  });

  it("marks conflicting start and dev recipes as targeted blocking input", () => {
    const text = JSON.stringify({ name: "shop", scripts: { start: "serve", dev: "vite" }, exports: { ".": "./src/index.js" } });
    const code = "export const run = () => true";
    const files = [
      { path: "package.json", sha256: hash(text), bytes: Buffer.from(text), kind: "blob" as const },
      { path: "src/index.js", sha256: hash(code), bytes: Buffer.from(code), kind: "blob" as const },
    ];
    const conflicted: VerifiedE2ESourceSnapshot = { candidate: snapshot.candidate, treeComplete: true, treePaths: files.map((item) => item.path), sources: files };
    const result = inspectE2ERepository(conflicted);
    expect(result.inspection.applications[0]?.recipe).toBeNull();
    expect(result.inspection.missingInputs[0]).toMatchObject({ kind: "runtime", disposition: "blocking" });
  });
});
