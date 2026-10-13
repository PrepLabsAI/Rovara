import { createHash } from "node:crypto";
import {
  E2EAppRecipeSchema, E2ERepositoryInspectionSchema, E2ESetupProposalSchema, canonicalJson,
  verifyE2ESourceSnapshot, type CandidateManifest, type E2ERepositoryInspection, type E2ESetupProposal, type E2ESourceSnapshot,
} from "@agentx/contracts";

const MAX_SOURCE_FILES = 512;
const MAX_SOURCE_FILE_BYTES = 512 * 1024;
const MAX_SOURCE_TOTAL_BYTES = 4 * 1024 * 1024;
const unsafePathPart = /^(?:\.git|\.github|\.aws|\.ssh|\.env(?:\..*)?|secrets?|credentials?|.*(?:token|password|private[-_]?key).*)$/i;
const runnerUnsafe = /(^|\/)(?:\.env(?:\..*)?|secrets?|credentials?|.*(?:token|password|private[-_]?key).*)$/i;

export type VerifiedE2ESource = E2ESourceSnapshot["sources"][number];
export type VerifiedE2ESourceSnapshot = E2ESourceSnapshot;
export type PortableOperation = { applicationId: string; targetIds: readonly string[]; manifestPath: string; exportName: string; operationId: string; sourceRefs: readonly { path: string; sha256: string }[] };

function normalizedPath(path: string): boolean {
  return path.length > 0 && path.length <= 1024 && !path.startsWith("/") && !path.includes("\\")
    && !path.split("/").some((part) => part === "" || part === "." || part === ".." || unsafePathPart.test(part));
}
function platformDirectory(path: string, platform: "android" | "ios"): string | undefined {
  const parts = path.split("/");
  const index = parts.indexOf(platform);
  return index < 0 ? undefined : parts.slice(0, index).join("/") || ".";
}
function iosBundleIdentifier(path: string, text: string): string | undefined {
  const raw = /Info\.plist$/i.test(path)
    ? /<key>\s*CFBundleIdentifier\s*<\/key>\s*<string>\s*([^<\s][^<]*?)\s*<\/string>/i.exec(text)?.[1]
    : /(?:^|\n)\s*PRODUCT_BUNDLE_IDENTIFIER\s*=\s*([^;\r\n]+)\s*;/m.exec(text)?.[1]?.trim().replace(/^['"]|['"]$/g, "");
  return raw && !/[()$]/.test(raw) && /^[A-Za-z0-9][A-Za-z0-9.-]{0,199}$/.test(raw) ? raw : undefined;
}
export function portableOperationId(exportName: string, applicationId?: string): string {
  if (exportName !== "." && (!exportName.startsWith("./") || exportName.slice(2).split("/").some((part) => part === "" || part === "." || part === ".." || part.includes("*")))) throw new Error("only exact normalized package export names are supported");
  return "op-" + createHash("sha256").update(canonicalJson([applicationId ?? "", exportName])).digest("hex");
}

function verifySnapshot(snapshot: VerifiedE2ESourceSnapshot, expectedCandidate: CandidateManifest): Map<string, VerifiedE2ESource> {
  const sources = verifyE2ESourceSnapshot(snapshot, expectedCandidate);
  if (sources.size > MAX_SOURCE_FILES || [...sources.values()].some((source) => source.bytes.byteLength > MAX_SOURCE_FILE_BYTES)) throw new Error("source snapshot exceeds the supported byte or file count limit");
  return sources;
}

export function proposeE2ESetup(input: { inspection: E2ERepositoryInspection; snapshot: VerifiedE2ESourceSnapshot; expectedCandidate: CandidateManifest }): E2ESetupProposal {
  const parsed = E2ERepositoryInspectionSchema.parse(input.inspection);
  const sourceBytes = verifySnapshot(input.snapshot, input.expectedCandidate);
  if (parsed.candidateDigest !== input.snapshot.candidate.digest) throw new Error("inspection candidate does not match the immutable source snapshot");
  const derived = inspectE2ERepository(input.snapshot, input.expectedCandidate).inspection;
  if (canonicalJson(parsed) !== canonicalJson(derived)) throw new Error("inspection does not match source-derived applications, targets, recipes, graph and input catalog");
  if (parsed.proposedScenarios.length !== 0) throw new Error("feature scenarios require a separate approved feature plan");
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

export function verifyE2ESetupProposal(proposal: E2ESetupProposal, snapshot: VerifiedE2ESourceSnapshot, expectedCandidate: CandidateManifest): E2ESetupProposal {
  const inspection: E2ERepositoryInspection = { candidateDigest: proposal.candidateDigest, sources: proposal.sources, applications: proposal.applications,
    proposedTargets: proposal.targets, dependencyEdges: proposal.dependencyEdges, proposedScenarios: proposal.scenarios, missingInputs: proposal.missingInputs };
  const verified = proposeE2ESetup({ inspection, snapshot, expectedCandidate });
  if (canonicalJson(E2ESetupProposalSchema.parse(proposal)) !== canonicalJson(verified)) throw new Error("setup proposal differs from independently source-derived proposal");
  return verified;
}

/** Discover a bounded app graph from an immutable source snapshot. Discovery parses data only; it never imports or executes candidate code. */
export function inspectE2ERepository(snapshot: VerifiedE2ESourceSnapshot, expectedCandidate: CandidateManifest): { inspection: E2ERepositoryInspection; portableOperations: PortableOperation[] } {
  const sources = verifySnapshot(snapshot, expectedCandidate);
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
  const declaredNames = new Map<string, number>();
  for (const manifest of manifests) {
    try {
      const value = JSON.parse(Buffer.from(manifest.bytes).toString("utf8")) as { name?: unknown };
      if (typeof value.name === "string" && /^[a-zA-Z0-9_.@/-]{1,120}$/.test(value.name)) declaredNames.set(value.name, (declaredNames.get(value.name) ?? 0) + 1);
    } catch { /* Invalid manifests do not contribute an application identity. */ }
  }
  for (const manifest of manifests.slice(0, 32)) {
    let data: unknown;
    try { data = JSON.parse(Buffer.from(manifest.bytes).toString("utf8")); } catch { continue; }
    if (data === null || typeof data !== "object" || Array.isArray(data)) continue;
    const pkg = data as { name?: unknown; scripts?: Record<string, unknown>; dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown>; exports?: unknown };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const relDir = manifest.path.includes("/") ? manifest.path.slice(0, manifest.path.lastIndexOf("/")) : ".";
    const validName = typeof pkg.name === "string" && /^[a-zA-Z0-9_.@/-]{1,120}$/.test(pkg.name) ? pkg.name : undefined;
    const appId = validName === undefined ? "app-" + createHash("sha256").update(relDir).digest("hex").slice(0, 12)
      : (declaredNames.get(validName) ?? 0) > 1 ? `${validName.slice(0, 106)}-${createHash("sha256").update(relDir).digest("hex").slice(0, 12)}` : validName;
    const appFiles = [...sources.keys()].filter((path) => relDir === "." || path.startsWith(relDir + "/"));
    const mobile = ["react-native", "expo"].some((name) => name in deps);
    const electron = "electron" in deps;
    const api = ["express", "fastify", "@hono/node-server", "koa"].some((name) => name in deps) || /(^|\/)(api|server)(\/|$)/i.test(relDir);
    const kind = api ? "api" : mobile ? "mobile" : electron ? "desktop" : "web";
    const sourcePaths = [manifest.path, ...appFiles.filter((path) => /(?:openapi|swagger|schema|routes?|controllers?|AndroidManifest\.xml|Info\.plist|project\.pbxproj)/i.test(path))].slice(0, 128);
    const packageDependencies = Object.keys(deps ?? {});
    const ops: PortableOperation[] = [];
    if (pkg.exports !== null && typeof pkg.exports === "object" && !Array.isArray(pkg.exports)) {
      for (const [name, targetPath] of Object.entries(pkg.exports)) {
        if (typeof targetPath !== "string" || !targetPath.startsWith("./")) continue;
        const resolved = relDir === "." ? targetPath.slice(2) : relDir + "/" + targetPath.slice(2);
        const file = sources.get(resolved);
        if (file && normalizedPath(resolved) && !runnerUnsafe.test(resolved)) {
          sourcePaths.push(resolved);
          try { ops.push({ applicationId: appId, targetIds: [], manifestPath: manifest.path, exportName: name, operationId: portableOperationId(name, appId), sourceRefs: [{ path: resolved, sha256: file.sha256 }] }); } catch { /* Unsupported export patterns remain undiscovered. */ }
        }
      }
    }
    let target: E2ERepositoryInspection["proposedTargets"][number] | undefined;
    let additionalTargets: E2ERepositoryInspection["proposedTargets"] = [];
    if (kind === "web") target = { targetId: "web-" + (applications.length + 1), applicationId: appId, runtimeProfileId: "web-phase-unavailable", accountProfileId: "synthetic", kind: "web", browser: "chromium", viewport: { width: 1280, height: 720 } };
    else if (kind === "api") target = { targetId: "api-" + (applications.length + 1), applicationId: appId, runtimeProfileId: "api-phase-unavailable", accountProfileId: "synthetic", kind: "api", protocol: "http", originRef: "app-origin" };
    else if (kind === "mobile") {
      const androidManifest = appFiles.find((path) => /(^|\/)android\/.*AndroidManifest\.xml$/.test(path));
      const iosMetadata = appFiles.find((path) => /(^|\/)ios\/.*Info\.plist$/.test(path)) ?? appFiles.find((path) => /(^|\/)ios\/.*project\.pbxproj$/.test(path));
      const androidText = androidManifest ? Buffer.from(sources.get(androidManifest)!.bytes).toString("utf8") : "";
      const iosText = iosMetadata ? Buffer.from(sources.get(iosMetadata)!.bytes).toString("utf8") : "";
      const androidId = /\bpackage\s*=\s*["']([^"']+)["']/.exec(androidText)?.[1];
      const iosId = iosMetadata ? iosBundleIdentifier(iosMetadata, iosText) : undefined;
      const mobileTargets: E2ERepositoryInspection["proposedTargets"] = [];
      if (androidManifest && androidId) mobileTargets.push({ targetId: "android-" + createHash("sha256").update(`${relDir}\0${androidId}`).digest("hex").slice(0, 10), applicationId: appId, runtimeProfileId: "android-phase-unavailable", accountProfileId: "synthetic", kind: "mobile", os: "android", appId: androidId, deviceProfileId: "no-device-selected" });
      if (iosMetadata && iosId) mobileTargets.push({ targetId: "ios-" + createHash("sha256").update(`${relDir}\0${iosId}`).digest("hex").slice(0, 10), applicationId: appId, runtimeProfileId: "ios-phase-unavailable", accountProfileId: "synthetic", kind: "mobile", os: "ios", appId: iosId, deviceProfileId: "no-device-selected" });
      target = mobileTargets.shift() as E2ERepositoryInspection["proposedTargets"][number];
      if (target) additionalTargets.push(...mobileTargets);
      else missingInputs.push({ inputId: "mobile-target-" + createHash("sha256").update(manifest.path).digest("hex").slice(0, 10), targetIds: [], kind: "target-selection", disposition: "blocking", reason: "React Native package has no native platform manifest with an application identity", sourcePaths: [manifest.path] });
      if (androidManifest && !androidId) missingInputs.push({ inputId: "android-identity-" + createHash("sha256").update(androidManifest).digest("hex").slice(0, 10), targetIds: [], kind: "target-selection", disposition: "blocking", reason: "Android manifest does not declare a resolvable package identity", sourcePaths: [androidManifest] });
      if (iosMetadata && !iosId) missingInputs.push({ inputId: "ios-identity-" + createHash("sha256").update(iosMetadata).digest("hex").slice(0, 10), targetIds: [], kind: "target-selection", disposition: "blocking", reason: "iOS metadata does not declare a resolvable bundle identifier", sourcePaths: [iosMetadata] });
    } else target = { targetId: "desktop-" + (applications.length + 1), applicationId: appId, runtimeProfileId: "electron-phase-unavailable", accountProfileId: "synthetic", kind: "desktop", os: "linux", driver: "electron", appId };
    let recipe: E2ERepositoryInspection["applications"][number]["recipe"] = null;
    const hasStart = typeof pkg.scripts?.start === "string" && pkg.scripts.start.trim() !== "";
    const hasDev = typeof pkg.scripts?.dev === "string" && pkg.scripts.dev.trim() !== "";
    if (kind === "web" || kind === "api") {
      if (hasStart !== hasDev) {
        const script = hasStart ? "start" : "dev";
        const recipeBody = {
          schemaVersion: 1 as const, build: [],
          launch: { kind: "service" as const, start: { program: "npm", args: ["run", script], cwd: relDir, timeoutMs: 60_000, env: {} }, health: { path: "/", expectedStatus: 200 } },
          serviceProfileIds: [], seedProfileId: "synthetic-seed-v1", accountProfileIds: ["synthetic"], allowedOrigins: ["app-origin"],
        };
        recipe = E2EAppRecipeSchema.parse({ ...recipeBody, recipeDigest: createHash("sha256").update(canonicalJson(recipeBody)).digest("hex") });
      } else if (hasStart && hasDev) {
        missingInputs.push({ inputId: "recipe-choice-" + (applications.length + 1), targetIds: target ? [target.targetId] : [], kind: "runtime", disposition: "blocking", reason: "The repository declares both start and dev recipes; choose the intended application launch contract", sourcePaths: [manifest.path] });
      }
    }
    const appTargets = target ? [target, ...additionalTargets] : [];
    if (kind === "mobile" || kind === "desktop") {
      const runtimeSources = sourcePaths.filter((path) => /AndroidManifest\.xml$|Info\.plist$|project\.pbxproj$|\.csproj$|\.sln$|CMakeLists\.txt$|meson\.build$/.test(path));
      if (appTargets.length) missingInputs.push({ inputId: "native-runtime-" + (applications.length + 1), targetIds: appTargets.map((item) => item.targetId), kind: "runtime", disposition: "mock-substitutable", reason: `The ${kind} build and launch runtime profile is unavailable in this phase`, sourcePaths: runtimeSources.length ? runtimeSources : [manifest.path] });
    }
    addApplication(appId, kind, sourcePaths, appTargets, recipe);
    for (const dependency of packageDependencies) {
      const dependedManifest = manifests.find((candidate) => {
        try { const value = JSON.parse(Buffer.from(candidate.bytes).toString("utf8")) as { name?: unknown }; return value.name === dependency; } catch { return false; }
      });
      if (dependedManifest) dependencyEdges.push({ fromApplicationId: appId, toComponentId: "package-" + createHash("sha256").update(dependency).digest("hex").slice(0, 12), contractRef: `${manifest.path}#dependencies.${dependency}`, sourcePaths: [manifest.path, dependedManifest.path] });
    }
    for (const path of sourcePaths.filter((item) => /(^|\/)(?:openapi|swagger)\.(?:json|ya?ml)$/i.test(item))) {
      dependencyEdges.push({ fromApplicationId: appId, toComponentId: "api-schema-" + createHash("sha256").update(path).digest("hex").slice(0, 12), contractRef: path, sourcePaths: [manifest.path, path] });
    }
    for (const operation of ops) { (operation.targetIds as string[]).push(...appTargets.map((item) => item.targetId)); portableOperations.push(operation); }
  }
  for (const source of sources.values()) {
    if (!/(^|\/)(?:openapi|swagger)\.(?:json|ya?ml)$/i.test(source.path) || runnerUnsafe.test(source.path) || sources.has(source.path) && applications.some((application) => application.sourcePaths.includes(source.path))) continue;
    if (applications.some((application) => application.sourcePaths.includes(source.path))) continue;
    const dir = source.path.includes("/") ? source.path.slice(0, source.path.lastIndexOf("/")) : ".";
    const appId = "api-contract-" + createHash("sha256").update(source.path).digest("hex").slice(0, 12);
    const targetId = "api-schema-" + (proposedTargets.length + 1);
    addApplication(appId, "api", [source.path], [{ targetId, applicationId: appId, runtimeProfileId: "api-phase-unavailable", accountProfileId: "synthetic", kind: "api", protocol: "http", originRef: "app-origin" }]);
    missingInputs.push({ inputId: "service-recipe-" + (applications.length), targetIds: [targetId], kind: "runtime", disposition: "mock-substitutable", reason: "An API schema was found without a source-backed service launch recipe", sourcePaths: [source.path] });
  }
  const nativeMobile = [...sources.values()].filter((source) => /(^|\/)android\/.*(?:AndroidManifest\.xml|build\.gradle(?:\.kts)?)$|(^|\/)ios\/.*(?:Info\.plist|project\.pbxproj|Package\.swift)$/.test(source.path));
  const mobileAppSeen = new Set<string>();
  for (const source of nativeMobile) {
    const isAndroid = /(^|\/)android\//.test(source.path);
    const platform = isAndroid ? "android" : "ios";
    const base = platformDirectory(source.path, platform);
    if (!base) continue;
    const prefix = base === "." ? `${platform}/` : `${base}/${platform}/`;
    const sameAppMetadata = [...sources.keys()].filter((path) => path === source.path || path.startsWith(prefix));
    const androidManifestPath = isAndroid ? sameAppMetadata.find((path) => /AndroidManifest\.xml$/.test(path)) : undefined;
    const iosMetadataPath = !isAndroid ? sameAppMetadata.find((path) => /Info\.plist$/.test(path)) ?? sameAppMetadata.find((path) => /(?:project\.pbxproj|Package\.swift)$/.test(path)) : undefined;
    const identitySource = isAndroid ? androidManifestPath ?? sameAppMetadata.find((path) => /build\.gradle(?:\.kts)?$/.test(path)) : iosMetadataPath;
    if (!identitySource) continue;
    if (mobileAppSeen.has(`${isAndroid}:${base}`) || applications.some((application) => application.sourcePaths.includes(identitySource))) continue;
    const identityText = Buffer.from(sources.get(identitySource)!.bytes).toString("utf8");
    const nativeAppId = isAndroid ? /\bpackage\s*=\s*["']([^"']+)["']/.exec(identityText)?.[1] : iosBundleIdentifier(identitySource, identityText);
    mobileAppSeen.add(`${isAndroid}:${base}`);
    const appId = "native-mobile-" + createHash("sha256").update(`${isAndroid}:${base}`).digest("hex").slice(0, 12);
    const platformName = isAndroid ? "Android" : "iOS";
    const appSources = sameAppMetadata.slice(0, 128);
    if (!nativeAppId) {
      addApplication(appId, "mobile", appSources, []);
      missingInputs.push({ inputId: `native-mobile-identity-${appId}`, targetIds: [], kind: "target-selection", disposition: "blocking", reason: `${platformName} source metadata has no resolvable application identifier`, sourcePaths: [identitySource] });
      continue;
    }
    const targetId = `${isAndroid ? "android" : "ios"}-` + createHash("sha256").update(`${base}\0${nativeAppId}`).digest("hex").slice(0, 10);
    const platformPrefix = base === "." ? `${isAndroid ? "android" : "ios"}/` : `${base}/${isAndroid ? "android" : "ios"}/`;
    const nativeSources = [...sources.keys()].filter((path) => path.startsWith(platformPrefix)).slice(0, 128);
    addApplication(appId, "mobile", nativeSources, [{ targetId, applicationId: appId, runtimeProfileId: isAndroid ? "android-phase-unavailable" : "ios-phase-unavailable", accountProfileId: "synthetic", kind: "mobile", os: isAndroid ? "android" : "ios", appId: nativeAppId, deviceProfileId: "no-device-selected" }]);
    missingInputs.push({ inputId: `native-mobile-runtime-${appId}`, targetIds: [targetId], kind: "runtime", disposition: "mock-substitutable", reason: `The ${isAndroid ? "Android" : "iOS"} build and launch profile is unavailable in this phase`, sourcePaths: [identitySource] });
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
  if (new Set(applications.map((application) => application.applicationId)).size !== applications.length) throw new Error("discovery produced duplicate application identities");
  if (new Set(proposedTargets.map((target) => target.targetId)).size !== proposedTargets.length) throw new Error("discovery produced duplicate target identities");
  const edgeKeys = dependencyEdges.map((edge) => canonicalJson([edge.fromApplicationId, edge.toComponentId, edge.contractRef]));
  if (new Set(edgeKeys).size !== edgeKeys.length) throw new Error("discovery produced duplicate dependency graph edges");
  const inspection = E2ERepositoryInspectionSchema.parse({ candidateDigest: snapshot.candidate.digest, sources: refs, applications, proposedTargets, dependencyEdges, proposedScenarios: [], missingInputs });
  return { inspection, portableOperations };
}

