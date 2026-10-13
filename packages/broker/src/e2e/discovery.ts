import { createHash } from "node:crypto";
import {
  E2EAppRecipeSchema, E2ERepositoryInspectionSchema, E2ESetupProposalSchema, canonicalJson,
  type CandidateManifest, type E2ERepositoryInspection, type E2ESetupProposal,
} from "@agentx/contracts";

const MAX_SOURCE_FILES = 512;
const MAX_SOURCE_FILE_BYTES = 512 * 1024;
const MAX_SOURCE_TOTAL_BYTES = 4 * 1024 * 1024;
const unsafePathPart = /^(?:\.git|\.github|\.aws|\.ssh|\.env(?:\..*)?|secrets?|credentials?|.*(?:token|password|private[-_]?key).*)$/i;
const runnerUnsafe = /(^|\/)(?:\.env(?:\..*)?|secrets?|credentials?|.*(?:token|password|private[-_]?key).*)$/i;

export type VerifiedE2ESource = { path: string; sha256: string; bytes: Uint8Array; kind?: "blob" | "symlink" | "submodule" };
export type VerifiedE2ESourceSnapshot = {
  candidate: CandidateManifest;
  treeSha?: string;
  treeComplete: boolean;
  treePaths?: readonly string[];
  sources: readonly VerifiedE2ESource[];
};
export type PortableOperation = { applicationId: string; targetIds: readonly string[]; manifestPath: string; exportName: string; operationId: string; sourceRefs: readonly { path: string; sha256: string }[] };

function normalizedPath(path: string): boolean {
  return path.length > 0 && path.length <= 1024 && !path.startsWith("/") && !path.includes("\\")
    && !path.split("/").some((part) => part === "" || part === "." || part === ".." || unsafePathPart.test(part));
}
function verifySnapshot(snapshot: VerifiedE2ESourceSnapshot): Map<string, VerifiedE2ESource> {
  if (snapshot.treeComplete !== true) throw new Error("immutable source tree is incomplete or truncated");
  if (snapshot.sources.length > MAX_SOURCE_FILES) throw new Error("source snapshot exceeds the file count limit");
  const paths = new Set(snapshot.treePaths ?? snapshot.sources.map((source) => source.path));
  const sources = new Map<string, VerifiedE2ESource>();
  let total = 0;
  for (const source of snapshot.sources) {
    if (!normalizedPath(source.path) || !paths.has(source.path)) throw new Error("source path is unsafe or outside the immutable snapshot tree");
    if (source.kind === "symlink" || source.kind === "submodule") throw new Error("symlink and submodule content cannot be used as candidate source");
    if (source.bytes.byteLength > MAX_SOURCE_FILE_BYTES) throw new Error("source file exceeds the size limit");
    total += source.bytes.byteLength;
    if (total > MAX_SOURCE_TOTAL_BYTES) throw new Error("source snapshot exceeds the total byte limit");
    const actual = createHash("sha256").update(source.bytes).digest("hex");
    if (actual !== source.sha256) throw new Error("source snapshot sha256 does not match the verified bytes");
    if (sources.has(source.path)) throw new Error("source snapshot paths must be unique");
    sources.set(source.path, source);
  }
  return sources;
}

export function proposeE2ESetup(input: { inspection: E2ERepositoryInspection; snapshot: VerifiedE2ESourceSnapshot }): E2ESetupProposal {
  const parsed = E2ERepositoryInspectionSchema.parse(input.inspection);
  const sourceBytes = verifySnapshot(input.snapshot);
  if (parsed.candidateDigest !== input.snapshot.candidate.digest) throw new Error("inspection candidate does not match the immutable source snapshot");
  const snapshotRefs = new Map([...sourceBytes].map(([path, source]) => [path, source.sha256]));
  for (const ref of parsed.sources) if (snapshotRefs.get(ref.path) !== ref.sha256) throw new Error("inspection source hash does not match the immutable snapshot");
  const requireSource = (path: string) => {
    if (!snapshotRefs.has(path)) throw new Error("inspection references source path outside the snapshot: " + path);
  };
  for (const application of parsed.applications) for (const path of application.sourcePaths) requireSource(path);
  for (const edge of parsed.dependencyEdges) for (const path of edge.sourcePaths) requireSource(path);
  for (const missing of parsed.missingInputs) for (const path of missing.sourcePaths) requireSource(path);
  const appIds = new Set(parsed.applications.map((application) => application.applicationId));
  const targetsById = new Map(parsed.proposedTargets.map((target) => [target.targetId, target]));
  for (const target of parsed.proposedTargets) if (!appIds.has(target.applicationId)) throw new Error("target references an unknown discovered application");
  for (const edge of parsed.dependencyEdges) if (!appIds.has(edge.fromApplicationId)) throw new Error("dependency edge references an unknown application");
  const applicationIds = new Set(parsed.applications.map((application) => application.applicationId));
  for (const scenario of parsed.proposedScenarios) {
    if (scenario.requestedTargetIds.some((targetId) => !targetsById.has(targetId))) throw new Error("scenario assignment references an unknown requested target");
    if (!scenario.requestedTargetIds.some((targetId) => applicationIds.has(targetsById.get(targetId)!.applicationId))) throw new Error("scenario assignment does not reference a discovered application target");
  }
  for (const missing of parsed.missingInputs) if (missing.targetIds.some((targetId) => !targetsById.has(targetId))) throw new Error("missing input references an unknown target");
  const proposal = {
    candidateDigest: parsed.candidateDigest, applications: parsed.applications, targets: parsed.proposedTargets,
    dependencyEdges: parsed.dependencyEdges, scenarios: parsed.proposedScenarios, sources: parsed.sources,
    missingInputs: parsed.missingInputs,
    state: parsed.missingInputs.some((item) => item.disposition === "blocking") ? "needs-input" : "proposed",
  } as const;
  return E2ESetupProposalSchema.parse(proposal);
}

/** Discover a bounded app graph from an immutable source snapshot. Discovery parses data only; it never imports or executes candidate code. */
export function inspectE2ERepository(snapshot: VerifiedE2ESourceSnapshot): { inspection: E2ERepositoryInspection; portableOperations: PortableOperation[] } {
  const sources = verifySnapshot(snapshot);
  const refs = [...sources.values()].filter((source) => !runnerUnsafe.test(source.path)).map(({ path, sha256 }) => ({ path, sha256 }));
  const applications: E2ERepositoryInspection["applications"] = [];
  const proposedTargets: E2ERepositoryInspection["proposedTargets"] = [];
  const dependencyEdges: E2ERepositoryInspection["dependencyEdges"] = [];
  const missingInputs: E2ERepositoryInspection["missingInputs"] = [];
  const portableOperations: PortableOperation[] = [];
  const addApplication = (applicationId: string, kind: "web" | "api" | "mobile" | "desktop", sourcePaths: string[], targets: E2ERepositoryInspection["proposedTargets"], recipe: E2ERepositoryInspection["applications"][number]["recipe"] = null) => {
    applications.push({ applicationId, kind, sourcePaths, recipe });
    proposedTargets.push(...targets);
  };
  const manifests = [...sources.values()].filter((source) => /(^|\/)package\.json$/.test(source.path) && !runnerUnsafe.test(source.path));
  for (const manifest of manifests.slice(0, 32)) {
    let data: unknown;
    try { data = JSON.parse(Buffer.from(manifest.bytes).toString("utf8")); } catch { continue; }
    if (data === null || typeof data !== "object" || Array.isArray(data)) continue;
    const pkg = data as { name?: unknown; scripts?: Record<string, unknown>; dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown>; exports?: unknown };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const relDir = manifest.path.includes("/") ? manifest.path.slice(0, manifest.path.lastIndexOf("/")) : ".";
    const appId = typeof pkg.name === "string" && /^[a-zA-Z0-9_.@/-]{1,120}$/.test(pkg.name) ? pkg.name : "app-" + createHash("sha256").update(relDir).digest("hex").slice(0, 12);
    const appFiles = [...sources.keys()].filter((path) => relDir === "." || path.startsWith(relDir + "/"));
    const mobile = ["react-native", "expo"].some((name) => name in deps);
    const electron = "electron" in deps;
    const api = ["express", "fastify", "@hono/node-server", "koa"].some((name) => name in deps) || /(^|\/)(api|server)(\/|$)/i.test(relDir);
    const kind = api ? "api" : mobile ? "mobile" : electron ? "desktop" : "web";
    const sourcePaths = [manifest.path, ...appFiles.filter((path) => /(?:openapi|swagger|schema|routes?|controllers?|AndroidManifest\.xml|Info\.plist|project\.pbxproj)/i.test(path))];
    const packageDependencies = Object.keys(deps ?? {});
    const ops: PortableOperation[] = [];
    if (pkg.exports !== null && typeof pkg.exports === "object" && !Array.isArray(pkg.exports)) {
      for (const [name, targetPath] of Object.entries(pkg.exports)) {
        if (typeof targetPath !== "string" || !targetPath.startsWith("./")) continue;
        const resolved = relDir === "." ? targetPath.slice(2) : relDir + "/" + targetPath.slice(2);
        const file = sources.get(resolved);
        if (file && normalizedPath(resolved) && !runnerUnsafe.test(resolved)) {
          sourcePaths.push(resolved);
          ops.push({ applicationId: appId, targetIds: [], manifestPath: manifest.path, exportName: name, operationId: name.replace(/^\./, "module-").slice(0, 120), sourceRefs: [{ path: resolved, sha256: file.sha256 }] });
        }
      }
    }
    let target: E2ERepositoryInspection["proposedTargets"][number];
    let additionalTargets: E2ERepositoryInspection["proposedTargets"] = [];
    if (kind === "web") target = { targetId: "web-" + (applications.length + 1), applicationId: appId, runtimeProfileId: "web-phase-unavailable", accountProfileId: "synthetic", kind: "web", browser: "chromium", viewport: { width: 1280, height: 720 } };
    else if (kind === "api") target = { targetId: "api-" + (applications.length + 1), applicationId: appId, runtimeProfileId: "api-phase-unavailable", accountProfileId: "synthetic", kind: "api", protocol: "http", originRef: "app-origin" };
    else if (kind === "mobile") {
      const android = appFiles.some((path) => /\/android\/.*AndroidManifest\.xml$/.test("/" + path));
      const ios = appFiles.some((path) => /\/ios\/.*(?:Info\.plist|project\.pbxproj)$/.test("/" + path));
      target = android
        ? { targetId: "android-" + (applications.length + 1), applicationId: appId, runtimeProfileId: "android-phase-unavailable", accountProfileId: "synthetic", kind: "mobile", os: "android", appId, deviceProfileId: "no-device-selected" }
        : { targetId: "ios-" + (applications.length + 1), applicationId: appId, runtimeProfileId: "ios-phase-unavailable", accountProfileId: "synthetic", kind: "mobile", os: "ios", appId, deviceProfileId: "no-device-selected" };
      if (ios && android) additionalTargets.push({ targetId: "ios-" + (applications.length + 1), applicationId: appId, runtimeProfileId: "ios-phase-unavailable", accountProfileId: "synthetic", kind: "mobile", os: "ios", appId, deviceProfileId: "no-device-selected" });
    } else target = { targetId: "desktop-" + (applications.length + 1), applicationId: appId, runtimeProfileId: "electron-phase-unavailable", accountProfileId: "synthetic", kind: "desktop", os: "linux", driver: "electron", appId };
    let recipe: E2ERepositoryInspection["applications"][number]["recipe"] = null;
    const hasStart = typeof pkg.scripts?.start === "string" && pkg.scripts.start.trim() !== "";
    const hasDev = typeof pkg.scripts?.dev === "string" && pkg.scripts.dev.trim() !== "";
    if (kind === "web" || kind === "api") if (hasStart !== hasDev) {
      const script = hasStart ? "start" : "dev";
      const recipeBody = {
        schemaVersion: 1 as const, build: [],
        launch: { kind: "service" as const, start: { program: "npm", args: ["run", script], cwd: relDir, timeoutMs: 60_000, env: {} }, health: { path: "/", expectedStatus: 200 } },
        serviceProfileIds: [], seedProfileId: "synthetic-seed-v1", accountProfileIds: ["synthetic"], allowedOrigins: ["app-origin"],
      };
      recipe = E2EAppRecipeSchema.parse({ ...recipeBody, recipeDigest: createHash("sha256").update(canonicalJson(recipeBody)).digest("hex") });
    } else if (hasStart && hasDev) {
      missingInputs.push({ inputId: "recipe-choice-" + (applications.length + 1), targetIds: [target.targetId], kind: "runtime", disposition: "blocking", reason: "The repository declares both start and dev recipes; choose the intended application launch contract", sourcePaths: [manifest.path] });
    }
    if (kind === "mobile" || kind === "desktop") {
      const runtimeSources = sourcePaths.filter((path) => /AndroidManifest\.xml$|Info\.plist$|project\.pbxproj$|\.csproj$|\.sln$|CMakeLists\.txt$|meson\.build$/.test(path));
      missingInputs.push({ inputId: "native-runtime-" + (applications.length + 1), targetIds: [target.targetId, ...additionalTargets.map((item) => item.targetId)], kind: "runtime", disposition: "mock-substitutable", reason: `The ${kind} build and launch runtime profile is unavailable in this phase`, sourcePaths: runtimeSources.length ? runtimeSources : [manifest.path] });
    }
    addApplication(appId, kind, sourcePaths, [target, ...additionalTargets], recipe);
    for (const dependency of packageDependencies) {
      const dependedManifest = manifests.find((candidate) => {
        try { const value = JSON.parse(Buffer.from(candidate.bytes).toString("utf8")) as { name?: unknown }; return value.name === dependency; } catch { return false; }
      });
      if (dependedManifest) dependencyEdges.push({ fromApplicationId: appId, toComponentId: "package-" + createHash("sha256").update(dependency).digest("hex").slice(0, 12), contractRef: `${manifest.path}#dependencies.${dependency}`, sourcePaths: [manifest.path, dependedManifest.path] });
    }
    for (const path of sourcePaths.filter((item) => /(^|\/)(?:openapi|swagger)\.(?:json|ya?ml)$/i.test(item))) {
      dependencyEdges.push({ fromApplicationId: appId, toComponentId: "api-schema-" + createHash("sha256").update(path).digest("hex").slice(0, 12), contractRef: path, sourcePaths: [manifest.path, path] });
    }
    for (const operation of ops) { (operation.targetIds as string[]).push(target.targetId, ...additionalTargets.map((item) => item.targetId)); portableOperations.push(operation); }
  }
  for (const source of sources.values()) {
    if (!/(^|\/)(?:openapi|swagger)\.(?:json|ya?ml)$/i.test(source.path) || runnerUnsafe.test(source.path)) continue;
    if (applications.some((application) => application.sourcePaths.includes(source.path))) continue;
    const dir = source.path.includes("/") ? source.path.slice(0, source.path.lastIndexOf("/")) : ".";
    const appId = "api-contract-" + createHash("sha256").update(source.path).digest("hex").slice(0, 12);
    const targetId = "api-schema-" + (proposedTargets.length + 1);
    addApplication(appId, "api", [source.path], [{ targetId, applicationId: appId, runtimeProfileId: "api-phase-unavailable", accountProfileId: "synthetic", kind: "api", protocol: "http", originRef: "app-origin" }]);
    missingInputs.push({ inputId: "service-recipe-" + (applications.length), targetIds: [targetId], kind: "runtime", disposition: "mock-substitutable", reason: "An API schema was found without a source-backed service launch recipe", sourcePaths: [source.path] });
  }
  const nativeDesktop = [...sources.values()].filter((source) => /(?:\.csproj$|\.sln$|\.xcodeproj\/project\.pbxproj$|\.xcworkspace\/contents\.xcworkspacedata$|(?:^|\/)linux\/(?:CMakeLists\.txt|meson\.build)$)/i.test(source.path));
  const seenNativeApps = new Set<string>();
  for (const source of nativeDesktop) {
    const appDir = source.path.includes("/") ? source.path.slice(0, source.path.lastIndexOf("/")) : ".";
    const key = appDir.replace(/\/(?:linux|[^/]+\.xcodeproj|[^/]+\.xcworkspace)$/, "");
    if (seenNativeApps.has(key) || applications.some((application) => application.sourcePaths.includes(source.path))) continue;
    seenNativeApps.add(key);
    const appId = "native-desktop-" + createHash("sha256").update(key).digest("hex").slice(0, 12);
    const targetId = "desktop-native-" + (proposedTargets.length + 1);
    const os = /\.csproj$|\.sln$/i.test(source.path) ? "windows" : /\.xcodeproj\/|\.xcworkspace\//i.test(source.path) ? "macos" : "linux";
    const appSources = [...sources.keys()].filter((path) => path === source.path || path.startsWith(key + "/"));
    addApplication(appId, "desktop", appSources.slice(0, 128), [{ targetId, applicationId: appId, runtimeProfileId: `native-${os}-phase-unavailable`, accountProfileId: "synthetic", kind: "desktop", os, driver: "native", appId }]);
    missingInputs.push({ inputId: "native-runtime-" + appId, targetIds: [targetId], kind: "runtime", disposition: "mock-substitutable", reason: `The ${os} native build and launch profile is unavailable in this phase`, sourcePaths: [source.path] });
  }
  const inspection = E2ERepositoryInspectionSchema.parse({ candidateDigest: snapshot.candidate.digest, sources: refs, applications, proposedTargets, dependencyEdges, proposedScenarios: [], missingInputs });
  return { inspection, portableOperations };
}

