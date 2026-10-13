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
function nativeProjectRoot(path: string, platform: "android" | "ios"): string | undefined {
  const parts = path.split("/");
  const index = parts.indexOf(platform);
  if (index < 0) return undefined;
  const prefix = parts.slice(0, index);
  const rest = parts.slice(index + 1);
  if (platform === "android") {
    const marker = rest.findIndex((part, i) => part === "src" && rest[i + 1] === "main");
    return [...prefix, platform, ...(marker >= 0 ? rest.slice(0, marker) : rest.slice(0, -1))].join("/") || platform;
  }
  return [...prefix, platform, ...rest.slice(0, -1)].join("/") || platform;
}
function componentDepth(path: string): number {
  return path === "." ? 0 : path.split("/").filter(Boolean).length;
}
function nativeDesktopRoot(path: string): { root: string; os: "windows" | "macos" | "linux" } | undefined {
  const xcode = /^(.*?\.xcodeproj)(?:\/|$)/i.exec(path);
  if (xcode && !/(^|\/)ios\//i.test(path)) return { root: xcode[1]!, os: "macos" };
  const workspace = /^(.*?\.xcworkspace)(?:\/|$)/i.exec(path);
  if (workspace && !/(^|\/)ios\//i.test(path)) return { root: workspace[1]!, os: "macos" };
  if (/\.csproj$|\.sln$/i.test(path)) return { root: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".", os: "windows" };
  if (/(?:^|\/)linux\/(?:CMakeLists\.txt|meson\.build)$/i.test(path)) return { root: path.slice(0, path.lastIndexOf("/")), os: "linux" };
  return undefined;
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
  const refs = [...sources.values()].filter((source) => !runnerUnsafe.test(source.path)).map(({ path, sha256 }) => ({ path, sha256 })).sort((a, b) => a.path.localeCompare(b.path));
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
  const manifestDirs = manifests.map((manifest) => manifest.path.includes("/") ? manifest.path.slice(0, manifest.path.lastIndexOf("/")) : ".");
  const deepestPackageDir = (path: string) => manifestDirs.filter((dir) => dir === "." || path.startsWith(dir + "/"))
    .sort((a, b) => componentDepth(b) - componentDepth(a) || a.localeCompare(b))[0];
  const declaredNames = new Map<string, number>();
  for (const manifest of manifests) {
    try {
      const value = JSON.parse(Buffer.from(manifest.bytes).toString("utf8")) as { name?: unknown };
      if (typeof value.name === "string" && /^[a-zA-Z0-9_.@/-]{1,120}$/.test(value.name)) declaredNames.set(value.name, (declaredNames.get(value.name) ?? 0) + 1);
    } catch { /* Invalid manifests do not contribute an application identity. */ }
  }
  const orderedManifests = [...manifests].sort((a, b) => {
    const aDir = a.path.includes("/") ? a.path.slice(0, a.path.lastIndexOf("/")) : ".";
    const bDir = b.path.includes("/") ? b.path.slice(0, b.path.lastIndexOf("/")) : ".";
    return componentDepth(aDir) - componentDepth(bDir) || aDir.localeCompare(bDir) || a.path.localeCompare(b.path);
  });
  for (const manifest of orderedManifests.slice(0, 32)) {
    let data: unknown;
    try { data = JSON.parse(Buffer.from(manifest.bytes).toString("utf8")); } catch { continue; }
    if (data === null || typeof data !== "object" || Array.isArray(data)) continue;
    const pkg = data as { name?: unknown; scripts?: Record<string, unknown>; dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown>; exports?: unknown };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const relDir = manifest.path.includes("/") ? manifest.path.slice(0, manifest.path.lastIndexOf("/")) : ".";
    const validName = typeof pkg.name === "string" && /^[a-zA-Z0-9_.@/-]{1,120}$/.test(pkg.name) ? pkg.name : undefined;
    const appId = validName === undefined ? "app-" + createHash("sha256").update(relDir).digest("hex").slice(0, 12)
      : (declaredNames.get(validName) ?? 0) > 1 ? `${validName.slice(0, 106)}-${createHash("sha256").update(relDir).digest("hex").slice(0, 12)}` : validName;
    const mobile = ["react-native", "expo"].some((name) => name in deps);
    const electron = "electron" in deps;
    const api = ["express", "fastify", "@hono/node-server", "koa"].some((name) => name in deps) || /(^|\/)(api|server)(\/|$)/i.test(relDir);
    const kind = api ? "api" : mobile ? "mobile" : electron ? "desktop" : "web";
    const packageNativeFiles = [...sources.keys()].filter((path) => (relDir === "." || path.startsWith(relDir + "/")) && deepestPackageDir(path) === relDir).sort();
    const nativeProjectCounts = new Map<string, number>();
    for (const platform of ["android", "ios"] as const) {
      const identities = packageNativeFiles.filter((path) => platform === "android" ? /AndroidManifest\.xml$/.test(path) : /Info\.plist$/.test(path));
      nativeProjectCounts.set(platform, new Set(identities.map((path) => nativeProjectRoot(path, platform))).size);
    }
    const appFiles = packageNativeFiles.filter((path) => {
      if (kind === "mobile") return !/(^|\/)(?:android|ios)\//i.test(path)
        || (/(^|\/)android\//i.test(path) ? nativeProjectCounts.get("android") === 1 : nativeProjectCounts.get("ios") === 1);
      if (/(^|\/)(?:android|ios)\//i.test(path)) return false;
      if (kind === "web" || kind === "api") return !/(?:\.csproj$|\.sln$|\.xcodeproj\/project\.pbxproj$|\.xcworkspace\/contents\.xcworkspacedata$|(?:^|\/)linux\/(?:CMakeLists\.txt|meson\.build)$)/i.test(path);
      return true;
    });
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
      const androidManifests = appFiles.filter((path) => /(^|\/)android\/.*AndroidManifest\.xml$/.test(path));
      const iosMetadata = appFiles.filter((path) => /(^|\/)ios\/.*Info\.plist$/.test(path));
      const mobileTargets: E2ERepositoryInspection["proposedTargets"] = [];
      for (const androidManifest of androidManifests) {
        const androidText = Buffer.from(sources.get(androidManifest)!.bytes).toString("utf8");
        const androidId = /\bpackage\s*=\s*["']([^"']+)["']/.exec(androidText)?.[1];
        if (androidId) mobileTargets.push({ targetId: "android-" + createHash("sha256").update(`${relDir}\0${nativeProjectRoot(androidManifest, "android")}\0${androidId}`).digest("hex").slice(0, 10), applicationId: appId, runtimeProfileId: "android-phase-unavailable", accountProfileId: "synthetic", kind: "mobile", os: "android", appId: androidId, deviceProfileId: "no-device-selected" });
        else missingInputs.push({ inputId: "android-identity-" + createHash("sha256").update(androidManifest).digest("hex").slice(0, 10), targetIds: [], kind: "target-selection", disposition: "blocking", reason: "Android manifest does not declare a resolvable package identity", sourcePaths: [androidManifest] });
      }
      for (const iosPath of iosMetadata) {
        const iosText = Buffer.from(sources.get(iosPath)!.bytes).toString("utf8");
        const iosId = iosBundleIdentifier(iosPath, iosText);
        if (iosId) mobileTargets.push({ targetId: "ios-" + createHash("sha256").update(`${relDir}\0${nativeProjectRoot(iosPath, "ios")}\0${iosId}`).digest("hex").slice(0, 10), applicationId: appId, runtimeProfileId: "ios-phase-unavailable", accountProfileId: "synthetic", kind: "mobile", os: "ios", appId: iosId, deviceProfileId: "no-device-selected" });
        else missingInputs.push({ inputId: "ios-identity-" + createHash("sha256").update(iosPath).digest("hex").slice(0, 10), targetIds: [], kind: "target-selection", disposition: "blocking", reason: "iOS metadata does not declare a resolvable bundle identifier", sourcePaths: [iosPath] });
      }
      const mobileTargetsByPlatform = new Map<string, Array<Extract<E2ERepositoryInspection["proposedTargets"][number], { kind: "mobile" }>>>();
      for (const item of mobileTargets) if (item.kind === "mobile") mobileTargetsByPlatform.set(item.os, [...(mobileTargetsByPlatform.get(item.os) ?? []), item]);
      for (const [platform, items] of mobileTargetsByPlatform) if (items.length > 1) missingInputs.push({ inputId: `${platform}-project-selection-${createHash("sha256").update(relDir).digest("hex").slice(0, 10)}`, targetIds: items.map((item) => item.targetId), kind: "target-selection", disposition: "blocking", reason: `Multiple ${platform} project identities are owned by this framework package; select the intended app`, sourcePaths: appFiles.filter((path) => new RegExp(`(^|/)${platform}/`).test(path)).slice(0, 32) });
      target = mobileTargets.shift();
      if (target) additionalTargets.push(...mobileTargets);
      if (!target) missingInputs.push({ inputId: "mobile-target-" + createHash("sha256").update(manifest.path).digest("hex").slice(0, 10), targetIds: [], kind: "target-selection", disposition: "blocking", reason: "React Native package has no native platform manifest with an application identity", sourcePaths: [manifest.path] });

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
  const nativeGroups = new Map<string, { platform: "android" | "ios"; root: string; identitySource: string; sourcePaths: string[] }>();
  for (const source of nativeMobile) {
    const platform: "android" | "ios" = /(^|\/)android\//.test(source.path) ? "android" : "ios";
    const root = nativeProjectRoot(source.path, platform);
    if (!root) continue;
    const key = `${platform}\0${root}`;
    const group = nativeGroups.get(key) ?? { platform, root, identitySource: source.path, sourcePaths: [] };
    group.sourcePaths.push(source.path);
    if (platform === "android" && /AndroidManifest\.xml$/.test(source.path) || platform === "ios" && /Info\.plist$/.test(source.path)) group.identitySource = source.path;
    nativeGroups.set(key, group);
  }
  for (const group of nativeGroups.values()) {
    const { platform, root, identitySource } = group;
    if (applications.some((application) => application.sourcePaths.includes(identitySource))) continue;
    const identityText = Buffer.from(sources.get(identitySource)!.bytes).toString("utf8");
    const nativeAppId = platform === "android" ? /\bpackage\s*=\s*["']([^"']+)["']/.exec(identityText)?.[1] : iosBundleIdentifier(identitySource, identityText);
    const appId = "native-mobile-" + createHash("sha256").update(`${platform}\0${root}`).digest("hex").slice(0, 12);
    const appSources = [...sources.keys()].filter((path) => path === root || path.startsWith(root + "/")).sort().slice(0, 128);
    const platformName = platform === "android" ? "Android" : "iOS";
    if (!nativeAppId) {
      addApplication(appId, "mobile", appSources.length ? appSources : [identitySource], []);
      missingInputs.push({ inputId: `native-mobile-identity-${appId}`, targetIds: [], kind: "target-selection", disposition: "blocking", reason: `${platformName} source metadata has no resolvable application identifier`, sourcePaths: [identitySource] });
      continue;
    }
    const targetId = `${platform}-` + createHash("sha256").update(`${platform}\0${root}\0${nativeAppId}`).digest("hex").slice(0, 10);
    addApplication(appId, "mobile", appSources, [{ targetId, applicationId: appId, runtimeProfileId: `${platform}-phase-unavailable`, accountProfileId: "synthetic", kind: "mobile", os: platform, appId: nativeAppId, deviceProfileId: "no-device-selected" }]);
    missingInputs.push({ inputId: `native-mobile-runtime-${appId}`, targetIds: [targetId], kind: "runtime", disposition: "mock-substitutable", reason: `The ${platformName} build and launch profile is unavailable in this phase`, sourcePaths: [identitySource] });
  }
  const packageNativeTargets = new Map<string, Array<{ platform: "android" | "ios"; targetId: string; sourcePath: string }>>();
  for (const group of nativeGroups.values()) {
    const owner = deepestPackageDir(group.identitySource);
    if (owner === undefined) continue;
    const key = `${owner}\0${group.platform}`;
    packageNativeTargets.set(key, [...(packageNativeTargets.get(key) ?? []), { platform: group.platform, targetId: `${group.platform}-` + createHash("sha256").update(`${group.platform}\0${group.root}\0${group.identitySource}`).digest("hex").slice(0, 10), sourcePath: group.identitySource }]);
  }
  for (const [key, entries] of packageNativeTargets) {
    if (entries.length < 2) continue;
    const [owner, platform] = key.split("\0") as [string, "android" | "ios"];
    const actualTargets = proposedTargets.filter((target) => target.kind === "mobile" && entries.some((entry) => target.targetId.startsWith(`${platform}-`) && target.os === platform && applications.find((application) => application.applicationId === target.applicationId)?.sourcePaths.includes(entry.sourcePath)));
    missingInputs.push({ inputId: `${platform}-project-selection-${createHash("sha256").update(owner).digest("hex").slice(0, 10)}`, targetIds: actualTargets.map((target) => target.targetId), kind: "target-selection", disposition: "blocking", reason: `Multiple ${platform} project identities are owned by this package; select the intended app`, sourcePaths: entries.map((entry) => entry.sourcePath).sort() });
  }
  const nativeDesktop = [...sources.values()].filter((source) => /(?:\.csproj$|\.sln$|\.xcodeproj\/project\.pbxproj$|\.xcworkspace\/contents\.xcworkspacedata$|(?:^|\/)linux\/(?:CMakeLists\.txt|meson\.build)$)/i.test(source.path)).sort((a, b) => a.path.localeCompare(b.path));
  const seenNativeApps = new Set<string>();
  for (const source of nativeDesktop) {
    const project = nativeDesktopRoot(source.path);
    if (!project) continue;
    const { root, os } = project;
    const key = `${os}\0${root}`;
    if (seenNativeApps.has(key)) continue;
    const packageOwner = deepestPackageDir(source.path);
    const packageManifest = packageOwner === undefined ? undefined : packageOwner === "." ? "package.json" : `${packageOwner}/package.json`;
    const mobileOwner = applications.some((application) => application.kind === "mobile"
      && packageManifest !== undefined && application.sourcePaths.includes(packageManifest)
      && application.sourcePaths.includes(source.path)
      && /(^|\/)ios\//i.test(source.path));
    if (mobileOwner) continue;
    seenNativeApps.add(key);
    const appId = "native-desktop-" + createHash("sha256").update(key).digest("hex").slice(0, 12);
    const targetId = "desktop-native-" + createHash("sha256").update(key).digest("hex").slice(0, 10);
    const appSources = [...sources.keys()].filter((path) => path === root || path.startsWith(root + "/")).sort();
    addApplication(appId, "desktop", appSources.slice(0, 128), [{ targetId, applicationId: appId, runtimeProfileId: `native-${os}-phase-unavailable`, accountProfileId: "synthetic", kind: "desktop", os, driver: "native", appId }]);
    missingInputs.push({ inputId: "native-runtime-" + appId, targetIds: [targetId], kind: "runtime", disposition: "mock-substitutable", reason: `The ${os} native build and launch profile is unavailable in this phase`, sourcePaths: [source.path] });
  }
  if (new Set(applications.map((application) => application.applicationId)).size !== applications.length) throw new Error("discovery produced duplicate application identities");
  if (new Set(proposedTargets.map((target) => target.targetId)).size !== proposedTargets.length) throw new Error("discovery produced duplicate target identities");
  const edgeKeys = dependencyEdges.map((edge) => canonicalJson([edge.fromApplicationId, edge.toComponentId, edge.contractRef]));
  if (new Set(edgeKeys).size !== edgeKeys.length) throw new Error("discovery produced duplicate dependency graph edges");
  applications.sort((a, b) => a.applicationId.localeCompare(b.applicationId));
  const kindOrder: Record<string, number> = { web: 0, api: 1, mobile: 2, desktop: 3 };
  proposedTargets.sort((a, b) => kindOrder[a.kind]! - kindOrder[b.kind]! || a.targetId.localeCompare(b.targetId));
  dependencyEdges.sort((a, b) => canonicalJson([a.fromApplicationId, a.toComponentId, a.contractRef]).localeCompare(canonicalJson([b.fromApplicationId, b.toComponentId, b.contractRef])));
  missingInputs.sort((a, b) => a.inputId.localeCompare(b.inputId));
  portableOperations.sort((a, b) => a.applicationId.localeCompare(b.applicationId) || a.exportName.localeCompare(b.exportName));
  const inspection = E2ERepositoryInspectionSchema.parse({ candidateDigest: snapshot.candidate.digest, sources: refs, applications, proposedTargets, dependencyEdges, proposedScenarios: [], missingInputs });
  return { inspection, portableOperations };
}

