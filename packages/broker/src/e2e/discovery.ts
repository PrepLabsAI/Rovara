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
  if (platform === "android") {
    const marker = parts.findIndex((part, i) => part === "src" && parts[i + 1] === "main");
    if (marker >= 0 && parts[marker + 2] === "AndroidManifest.xml") return parts.slice(0, marker).join("/") || ".";
    if (/build\.gradle(?:\.kts)?$/i.test(path)) return parts.slice(0, -1).join("/") || ".";
    if (/AndroidManifest\.xml$/i.test(path)) return parts.slice(0, -1).join("/") || ".";
    return undefined;
  }
  const index = parts.indexOf(platform);
  if (index < 0) return undefined;
  const prefix = parts.slice(0, index);
  const rest = parts.slice(index + 1);
  return [...prefix, platform, ...rest.slice(0, -1)].join("/") || platform;
}
function componentDepth(path: string): number {
  return path === "." ? 0 : path.split("/").filter(Boolean).length;
}
function nativeDesktopRoot(path: string): { root: string; os: "windows" | "macos" | "linux" } | undefined {
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

type OpenStepValue = string | OpenStepValue[] | { [key: string]: OpenStepValue };
function parseOpenStep(text: string): OpenStepValue {
  if (Buffer.byteLength(text, "utf8") > MAX_SOURCE_FILE_BYTES) throw new Error("PBX source exceeds parser size limit");
  const tokens: string[] = [];
  for (let i = 0; i < text.length;) {
    const char = text[i]!;
    if (/\s/.test(char)) { i += 1; continue; }
    if (text.startsWith("//", i)) { const end = text.indexOf("\n", i + 2); i = end < 0 ? text.length : end + 1; continue; }
    if (text.startsWith("/*", i)) { const end = text.indexOf("*/", i + 2); if (end < 0) throw new Error("unterminated PBX comment"); i = end + 2; continue; }
    if ("{}()=;,".includes(char)) { tokens.push(char); i += 1; continue; }
    if (char === '"') {
      let value = ""; i += 1; let closed = false;
      while (i < text.length) { const next = text[i++]!; if (next === '"') { closed = true; break; } if (next === "\\") { if (i >= text.length) break; value += text[i++]!; } else value += next; }
      if (!closed) throw new Error("unterminated PBX string"); tokens.push(JSON.stringify(value)); continue;
    }
    const start = i;
    while (i < text.length && !/[\s{}()=;,\"]/.test(text[i]!)) i += 1;
    if (start === i) throw new Error("invalid PBX token");
    tokens.push(text.slice(start, i));
    if (tokens.length > 100_000) throw new Error("PBX token budget exceeded");
  }
  let cursor = 0; let nodes = 0;
  const parse = (depth: number): OpenStepValue => {
    if (++nodes > 50_000 || depth > 48) throw new Error("PBX structure budget exceeded");
    const token = tokens[cursor++];
    if (token === "{") {
      const result: Record<string, OpenStepValue> = Object.create(null) as Record<string, OpenStepValue>;
      while (tokens[cursor] !== "}") {
        const keyToken = tokens[cursor++]; if (keyToken === undefined || keyToken === "=" || keyToken === ";") throw new Error("invalid PBX dictionary key");
        const key = keyToken.startsWith('"') ? JSON.parse(keyToken) as string : keyToken;
        if (tokens[cursor++] !== "=") throw new Error("invalid PBX dictionary assignment");
        if (Object.hasOwn(result, key)) throw new Error("duplicate PBX dictionary key");
        result[key] = parse(depth + 1);
        if (tokens[cursor++] !== ";") throw new Error("invalid PBX dictionary terminator");
      }
      cursor += 1; return result;
    }
    if (token === "(") {
      const result: OpenStepValue[] = [];
      while (tokens[cursor] !== ")") { result.push(parse(depth + 1)); if (tokens[cursor] === ",") cursor += 1; else if (tokens[cursor] !== ")") throw new Error("invalid PBX array separator"); }
      cursor += 1; return result;
    }
    if (token === undefined || ["}", ")", "=", ";", ","].includes(token)) throw new Error("invalid PBX value");
    return token.startsWith('"') ? JSON.parse(token) as string : token;
  };
  const value = parse(0);
  if (cursor !== tokens.length || value === null || Array.isArray(value) || typeof value !== "object") throw new Error("invalid PBX root object");
  return value;
}
function dict(value: OpenStepValue | undefined): Record<string, OpenStepValue> | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined; }
function array(value: OpenStepValue | undefined): OpenStepValue[] | undefined { return Array.isArray(value) ? value : undefined; }
function stringValue(value: OpenStepValue | undefined): string | undefined { return typeof value === "string" ? value : undefined; }
type AppleProjectTarget = { ref: string; platform?: "ios" | "macos"; bundleId?: string; plistPath?: string };
function parseAppleProject(path: string, text: string): { targets: AppleProjectTarget[]; error?: string } {
  try {
    const root = dict(parseOpenStep(text)); const objects = dict(root?.objects); const projectRef = stringValue(root?.rootObject);
    if (!objects || !projectRef) throw new Error("PBX project root or objects are missing");
    const project = dict(objects[projectRef]);
    if (stringValue(project?.isa) !== "PBXProject") throw new Error("PBX rootObject does not reference PBXProject");
    const targetRefs = array(project?.targets);
    if (!targetRefs || targetRefs.length > 128 || targetRefs.some((ref) => typeof ref !== "string")) throw new Error("PBX application target list is invalid or exceeds limits");
    const output: AppleProjectTarget[] = [];
    for (const targetRefValue of targetRefs) {
      const ref = stringValue(targetRefValue)!; const target = dict(objects[ref]);
      if (!target || stringValue(target.isa) !== "PBXNativeTarget") throw new Error("PBX target reference is missing or has the wrong type");
      if (stringValue(target.productType) !== "com.apple.product-type.application") continue;
      const configListRef = stringValue(target.buildConfigurationList); const configList = dict(configListRef ? objects[configListRef] : undefined);
      if (!configList || stringValue(configList.isa) !== "XCConfigurationList") throw new Error("PBX target configuration list is missing or has the wrong type");
      const configRefs = array(configList.buildConfigurations);
      if (!configRefs || configRefs.length === 0 || configRefs.length > 32) throw new Error("PBX build configurations are invalid or exceed limits");
      const configs = configRefs.map((configRefValue) => {
        const configRef = stringValue(configRefValue); const config = dict(configRef ? objects[configRef] : undefined);
        if (!config || stringValue(config.isa) !== "XCBuildConfiguration") throw new Error("PBX build configuration is missing or has the wrong type");
        const settings = dict(config.buildSettings); if (!settings) throw new Error("PBX build settings are missing");
        return settings;
      });
      const values = (key: string) => [...new Set(configs.map((settings) => stringValue(settings[key])).filter((value): value is string => value !== undefined))];
      const sdkRoots = values("SDKROOT"); const platformLists = values("SUPPORTED_PLATFORMS"); const bundleIds = values("PRODUCT_BUNDLE_IDENTIFIER"); const plistPaths = values("INFOPLIST_FILE");
      const platformNames = [...sdkRoots, ...platformLists.flatMap((value) => value.split(/\s+/))].filter(Boolean);
      const iosFacts = platformNames.some((name) => ["iphoneos", "iphonesimulator"].includes(name));
      const macFacts = platformNames.some((name) => name === "macosx");
      const platform = iosFacts === macFacts ? undefined : iosFacts ? "ios" : "macos";
      const normalizedBundle = bundleIds.length === 1 && /^[A-Za-z0-9][A-Za-z0-9.-]{0,199}$/.test(bundleIds[0]!) ? bundleIds[0] : undefined;
      let resolvedPlist: string | undefined;
      if (plistPaths.length === 1) {
        const xcodeproj = /^(.*?\.xcodeproj)\/project\.pbxproj$/i.exec(path)?.[1];
        const projectDir = xcodeproj ? xcodeproj.includes("/") ? xcodeproj.slice(0, xcodeproj.lastIndexOf("/")) : "." : undefined;
        const raw = plistPaths[0]!.replace(/^\$\((?:SRCROOT|PROJECT_DIR)\)\/?|^\$\{(?:SRCROOT|PROJECT_DIR)\}\/?/, "");
        if (projectDir !== undefined && normalizedPath(raw)) {
          const joined = projectDir === "." ? raw : `${projectDir}/${raw}`;
          if (normalizedPath(joined)) resolvedPlist = joined;
        }
      }
      output.push({ ref, ...(platform ? { platform } : {}), ...(normalizedBundle ? { bundleId: normalizedBundle } : {}), ...(resolvedPlist ? { plistPath: resolvedPlist } : {}) });
    }
    return { targets: output };
  } catch (error) { return { targets: [], error: error instanceof Error ? error.message.slice(0, 240) : "PBX metadata is unsupported" }; }
}
function plistMetadata(text: string): { bundleId?: string; packageType?: string; platforms: string[] } {
  const value = (key: string) => new RegExp(`<key>\\s*${key}\\s*<\\/key>\\s*<string>\\s*([^<]*?)\\s*<\\/string>`, "i").exec(text)?.[1]?.trim();
  const platformArray = /<key>\s*CFBundleSupportedPlatforms\s*<\/key>\s*<array>([\s\S]*?)<\/array>/i.exec(text)?.[1] ?? "";
  const bundleId = value("CFBundleIdentifier"); const packageType = value("CFBundlePackageType");
  return { ...(bundleId ? { bundleId } : {}), ...(packageType ? { packageType } : {}), platforms: [...platformArray.matchAll(/<string>\s*([^<]+?)\s*<\/string>/gi)].map((match) => match[1]!.trim()) };
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
  const manifests = [...sources.values()].filter((source) => /(^|\/)package\.json$/.test(source.path) && !runnerUnsafe.test(source.path)).sort((a, b) => a.path.localeCompare(b.path));
  const manifestDirs = manifests.map((manifest) => manifest.path.includes("/") ? manifest.path.slice(0, manifest.path.lastIndexOf("/")) : ".");
  const deepestPackageDir = (path: string) => manifestDirs.filter((dir) => dir === "." || path.startsWith(dir + "/"))
    .sort((a, b) => componentDepth(b) - componentDepth(a) || a.localeCompare(b))[0];
  const declaredNames = new Map<string, number>();
  const manifestsByName = new Map<string, typeof manifests>();
  for (const manifest of manifests) {
    try {
      const value = JSON.parse(Buffer.from(manifest.bytes).toString("utf8")) as { name?: unknown };
      if (typeof value.name === "string" && /^[a-zA-Z0-9_.@/-]{1,120}$/.test(value.name)) {
        declaredNames.set(value.name, (declaredNames.get(value.name) ?? 0) + 1);
        manifestsByName.set(value.name, [...(manifestsByName.get(value.name) ?? []), manifest]);
      }
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
      if (kind === "web" || kind === "api") return !/(?:\.csproj$|\.sln$|\.xcodeproj\/project\.pbxproj$|\.xcworkspace\/contents\.xcworkspacedata$|(?:^|\/)linux\/(?:CMakeLists\.txt|meson\.build)$|(?:^|\/)AndroidManifest\.xml$|(?:^|\/)Info\.plist$|(?:^|\/)build\.gradle(?:\.kts)?$)/i.test(path);
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
      const androidManifests = appFiles.filter((path) => /(?:^|\/)AndroidManifest\.xml$/i.test(path));
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
      const candidates = manifestsByName.get(dependency) ?? [];
      const spec = deps[dependency];
      const rel = manifest.path.includes("/") ? manifest.path.slice(0, manifest.path.lastIndexOf("/")) : ".";
      let explicitDir: string | undefined;
      if (typeof spec === "string" && /^(?:file|link):\.\.?\//.test(spec)) {
        const raw = spec.replace(/^(?:file|link):/, ""); const parts = rel === "." ? [] : rel.split("/");
        let safe = true;
        for (const part of raw.split("/")) { if (!part || part === ".") continue; if (part === "..") { if (!parts.length) { safe = false; break; } parts.pop(); } else parts.push(part); }
        if (safe) explicitDir = parts.join("/") || ".";
      }
      const supplier = explicitDir === undefined
        ? candidates.length === 1 ? candidates[0] : undefined
        : candidates.find((candidate) => (candidate.path.includes("/") ? candidate.path.slice(0, candidate.path.lastIndexOf("/")) : ".") === explicitDir);
      if (supplier) {
        dependencyEdges.push({ fromApplicationId: appId, toComponentId: "package-" + createHash("sha256").update(supplier.path).digest("hex").slice(0, 12), contractRef: `${manifest.path}#dependencies.${dependency}`, sourcePaths: [manifest.path, supplier.path].sort() });
      } else if (candidates.length > 1) {
        missingInputs.push({ inputId: "dependency-source-" + createHash("sha256").update(`${manifest.path}\0${dependency}`).digest("hex").slice(0, 12), targetIds: [], kind: "runtime", disposition: "blocking", reason: `Dependency ${dependency} has multiple source suppliers; establish a workspace source relation`, sourcePaths: [manifest.path, ...candidates.map((candidate) => candidate.path)].sort() });
      }
    }
    for (const path of sourcePaths.filter((item) => /(^|\/)(?:openapi|swagger)\.(?:json|ya?ml)$/i.test(item))) {
      dependencyEdges.push({ fromApplicationId: appId, toComponentId: "api-schema-" + createHash("sha256").update(path).digest("hex").slice(0, 12), contractRef: path, sourcePaths: [manifest.path, path] });
    }
    for (const operation of ops) { (operation.targetIds as string[]).push(...appTargets.map((item) => item.targetId)); portableOperations.push(operation); }
  }
  for (const source of [...sources.values()].sort((a, b) => a.path.localeCompare(b.path))) {
    if (!/(^|\/)(?:openapi|swagger)\.(?:json|ya?ml)$/i.test(source.path) || runnerUnsafe.test(source.path) || sources.has(source.path) && applications.some((application) => application.sourcePaths.includes(source.path))) continue;
    if (applications.some((application) => application.sourcePaths.includes(source.path))) continue;
    const dir = source.path.includes("/") ? source.path.slice(0, source.path.lastIndexOf("/")) : ".";
    const appId = "api-contract-" + createHash("sha256").update(source.path).digest("hex").slice(0, 12);
    const stableId = createHash("sha256").update(source.path).digest("hex").slice(0, 12);
    const targetId = "api-schema-" + stableId;
    addApplication(appId, "api", [source.path], [{ targetId, applicationId: appId, runtimeProfileId: "api-phase-unavailable", accountProfileId: "synthetic", kind: "api", protocol: "http", originRef: "app-origin" }]);
    missingInputs.push({ inputId: "service-recipe-" + stableId, targetIds: [targetId], kind: "runtime", disposition: "mock-substitutable", reason: "An API schema was found without a source-backed service launch recipe", sourcePaths: [source.path] });
  }
  const appleOwnedPaths = new Set<string>();
  const xcodeProjects = [...sources.values()].filter((source) => /\.xcodeproj\/project\.pbxproj$/i.test(source.path)).sort((a, b) => a.path.localeCompare(b.path));
  for (const projectSource of xcodeProjects) {
    appleOwnedPaths.add(projectSource.path);
    const project = parseAppleProject(projectSource.path, Buffer.from(projectSource.bytes).toString("utf8"));
    const projectRecords = project.targets;
    if (project.error || projectRecords.length === 0) {
      const id = createHash("sha256").update(projectSource.path).digest("hex").slice(0, 12);
      missingInputs.push({ inputId: "apple-project-metadata-" + id, targetIds: [], kind: "target-selection", disposition: "blocking", reason: project.error ? `Apple project metadata is unresolved: ${project.error}` : "Apple project has no source-confirmed application target", sourcePaths: [projectSource.path] });
      continue;
    }
    const reusedPackageTargetOwners = new Set<string>();
    for (const record of projectRecords) {
      if (record.plistPath) appleOwnedPaths.add(record.plistPath);
      const ownerPaths = [projectSource.path, ...(record.plistPath && sources.has(record.plistPath) ? [record.plistPath] : [])].sort();
      const stable = createHash("sha256").update(`${projectSource.path}\0${record.ref}`).digest("hex").slice(0, 12);
      if (!record.platform || !record.bundleId || !record.plistPath || !sources.has(record.plistPath)) {
        const kind = record.platform === "ios" ? "mobile" : record.platform === "macos" ? "desktop" : undefined;
        const appId = "apple-project-" + stable;
        if (kind) addApplication(appId, kind, ownerPaths, []);
        missingInputs.push({ inputId: "apple-target-metadata-" + stable, targetIds: [], kind: "target-selection", disposition: "blocking", reason: "Apple target platform, bundle identity, or associated in-snapshot INFOPLIST_FILE is unresolved", sourcePaths: ownerPaths });
        continue;
      }
      const plistText = Buffer.from(sources.get(record.plistPath)!.bytes).toString("utf8");
      const plist = plistMetadata(plistText);
      const supported = plist.platforms.length === 0 || (record.platform === "ios"
        ? plist.platforms.every((value) => value === "iPhoneOS" || value === "iPhoneSimulator")
        : plist.platforms.every((value) => value === "MacOSX"));
      if ((plist.packageType !== undefined && plist.packageType !== "APPL") || (plist.bundleId !== undefined && plist.bundleId !== record.bundleId) || !supported) {
        const appId = "apple-project-" + stable;
        addApplication(appId, record.platform === "ios" ? "mobile" : "desktop", ownerPaths, []);
        missingInputs.push({ inputId: "apple-target-metadata-" + stable, targetIds: [], kind: "target-selection", disposition: "blocking", reason: "Apple target and associated plist application/platform/bundle metadata do not agree", sourcePaths: ownerPaths });
        continue;
      }
      const existingOwner = applications.find((application) => application.sourcePaths.includes(record.plistPath!));
      const existingTarget = existingOwner && proposedTargets.find((target) => target.applicationId === existingOwner.applicationId
        && ((record.platform === "ios" && target.kind === "mobile" && target.os === "ios" && target.appId === record.bundleId)
          || (record.platform === "macos" && target.kind === "desktop" && target.os === "macos" && target.appId === record.bundleId)));
      if (existingOwner && existingTarget) {
        existingOwner.sourcePaths = [...new Set([...existingOwner.sourcePaths, projectSource.path])].sort();
        if (reusedPackageTargetOwners.has(existingOwner.applicationId)) {
          const targetId = "apple-target-" + stable;
          const target = record.platform === "ios"
            ? { targetId, applicationId: existingOwner.applicationId, runtimeProfileId: "ios-phase-unavailable", accountProfileId: "synthetic", kind: "mobile" as const, os: "ios" as const, appId: record.bundleId, deviceProfileId: "no-device-selected" }
            : { targetId, applicationId: existingOwner.applicationId, runtimeProfileId: "native-macos-phase-unavailable", accountProfileId: "synthetic", kind: "desktop" as const, os: "macos" as const, driver: "native" as const, appId: record.bundleId };
          proposedTargets.push(target);
          missingInputs.push({ inputId: "native-runtime-" + stable, targetIds: [targetId], kind: "runtime", disposition: "mock-substitutable", reason: `The ${record.platform} native build and launch profile is unavailable in this phase`, sourcePaths: ownerPaths });
        } else {
          reusedPackageTargetOwners.add(existingOwner.applicationId);
        }
        continue;
      }
      const applicationId = "apple-" + stable;
      const targetId = "apple-target-" + stable;
      const target = record.platform === "ios"
        ? { targetId, applicationId, runtimeProfileId: "ios-phase-unavailable", accountProfileId: "synthetic", kind: "mobile" as const, os: "ios" as const, appId: record.bundleId, deviceProfileId: "no-device-selected" }
        : { targetId, applicationId, runtimeProfileId: "native-macos-phase-unavailable", accountProfileId: "synthetic", kind: "desktop" as const, os: "macos" as const, driver: "native" as const, appId: record.bundleId };
      addApplication(applicationId, record.platform === "ios" ? "mobile" : "desktop", ownerPaths, [target]);
      missingInputs.push({ inputId: "native-runtime-" + stable, targetIds: [targetId], kind: "runtime", disposition: "mock-substitutable", reason: `The ${record.platform} native build and launch profile is unavailable in this phase`, sourcePaths: ownerPaths });
    }
  }
  for (const source of [...sources.values()].filter((item) => /Info\.plist$/i.test(item.path)).sort((a, b) => a.path.localeCompare(b.path))) {
    if (appleOwnedPaths.has(source.path) || applications.some((application) => application.sourcePaths.includes(source.path))) continue;
    const metadata = plistMetadata(Buffer.from(source.bytes).toString("utf8"));
    const ios = metadata.platforms.length > 0 && metadata.platforms.every((value) => value === "iPhoneOS" || value === "iPhoneSimulator");
    const mac = metadata.platforms.length > 0 && metadata.platforms.every((value) => value === "MacOSX");
    const stable = createHash("sha256").update(source.path).digest("hex").slice(0, 12);
    if (metadata.packageType !== "APPL" || !metadata.bundleId || ios === mac) {
      missingInputs.push({ inputId: "apple-plist-platform-" + stable, targetIds: [], kind: "target-selection", disposition: "blocking", reason: "Standalone Apple plist does not establish an application bundle and one supported platform", sourcePaths: [source.path] });
      continue;
    }
    const applicationId = "apple-plist-" + stable; const targetId = "apple-target-" + stable;
    const target = ios
      ? { targetId, applicationId, runtimeProfileId: "ios-phase-unavailable", accountProfileId: "synthetic", kind: "mobile" as const, os: "ios" as const, appId: metadata.bundleId, deviceProfileId: "no-device-selected" }
      : { targetId, applicationId, runtimeProfileId: "native-macos-phase-unavailable", accountProfileId: "synthetic", kind: "desktop" as const, os: "macos" as const, driver: "native" as const, appId: metadata.bundleId };
    addApplication(applicationId, ios ? "mobile" : "desktop", [source.path], [target]);
    missingInputs.push({ inputId: "native-runtime-" + stable, targetIds: [targetId], kind: "runtime", disposition: "mock-substitutable", reason: `The ${ios ? "ios" : "macos"} native build and launch profile is unavailable in this phase`, sourcePaths: [source.path] });
  }
  const nativeMobile = [...sources.values()].filter((source) => /(?:^|\/)AndroidManifest\.xml$|(?:^|\/)build\.gradle(?:\.kts)?$|(^|\/)ios\/.*(?:Info\.plist|project\.pbxproj|Package\.swift)$/.test(source.path)).sort((a, b) => a.path.localeCompare(b.path));
  const nativeGroups = new Map<string, { platform: "android" | "ios"; root: string; identitySource: string; sourcePaths: string[] }>();
  for (const source of nativeMobile) {
    const platform: "android" | "ios" = /AndroidManifest\.xml$|build\.gradle(?:\.kts)?$/.test(source.path) ? "android" : "ios";
    const root = nativeProjectRoot(source.path, platform);
    if (!root) continue;
    const key = `${platform}\0${root}`;
    const group = nativeGroups.get(key) ?? { platform, root, identitySource: source.path, sourcePaths: [] };
    group.sourcePaths.push(source.path);
    if (platform === "android" && /AndroidManifest\.xml$/.test(source.path) || platform === "ios" && /Info\.plist$/.test(source.path)) group.identitySource = source.path;
    nativeGroups.set(key, group);
  }
  for (const group of nativeGroups.values()) group.sourcePaths.sort();
  for (const group of nativeGroups.values()) {
    const { platform, root, identitySource } = group;
    if (applications.some((application) => application.sourcePaths.includes(identitySource))) continue;
    const identityText = Buffer.from(sources.get(identitySource)!.bytes).toString("utf8");
    const androidBuild = group.sourcePaths.filter((path) => /build\.gradle(?:\.kts)?$/.test(path)).map((path) => Buffer.from(sources.get(path)!.bytes).toString("utf8"));
    const hasAndroidApplication = platform === "android" && (androidBuild.some((text) => /com\.android\.application/.test(text)) || /<application\b/i.test(identityText));
    if (platform === "android" && !hasAndroidApplication) continue;
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
    const actualTargets = proposedTargets.filter((target) => target.kind === "mobile" && target.os === platform && entries.some((entry) => applications.find((application) => application.applicationId === target.applicationId)?.sourcePaths.includes(entry.sourcePath)));
    missingInputs.push({ inputId: `${platform}-project-selection-${createHash("sha256").update(owner).digest("hex").slice(0, 10)}`, targetIds: actualTargets.map((target) => target.targetId), kind: "target-selection", disposition: "blocking", reason: `Multiple ${platform} project identities are owned by this package; select the intended app`, sourcePaths: entries.map((entry) => entry.sourcePath).sort() });
  }
  const unownedNativeRoots = new Map<string, Array<{ platform: "android" | "ios"; root: string; identitySource: string; sourcePaths: string[] }>>();
  for (const group of nativeGroups.values()) {
    if (deepestPackageDir(group.identitySource) !== undefined || applications.some((application) => application.sourcePaths.includes(group.identitySource) && application.sourcePaths.some((path) => /\.xcodeproj\/project\.pbxproj$/.test(path)))) continue;
    const parent = group.root.includes("/") ? group.root.slice(0, group.root.lastIndexOf("/")) : ".";
    if (parent !== group.platform) continue;
    const key = `${group.platform}\0${parent}`;
    unownedNativeRoots.set(key, [...(unownedNativeRoots.get(key) ?? []), group]);
  }
  for (const [key, entries] of unownedNativeRoots) {
    if (entries.length < 2) continue;
    const [platform, parent] = key.split("\0") as ["android" | "ios", string];
    const targetIds = proposedTargets.filter((target) => target.kind === "mobile" && target.os === platform && entries.some((group) => applications.find((application) => application.applicationId === target.applicationId)?.sourcePaths.includes(group.identitySource))).map((target) => target.targetId);
    missingInputs.push({ inputId: `${platform}-project-selection-${createHash("sha256").update(parent).digest("hex").slice(0, 10)}`, targetIds, kind: "target-selection", disposition: "blocking", reason: `Multiple ${platform} project identities share this source root; select the intended app`, sourcePaths: entries.map((group) => group.identitySource).sort() });
  }
  const nativeDesktop = [...sources.values()].filter((source) => /(?:\.csproj$|\.sln$|\.xcworkspace\/contents\.xcworkspacedata$|(?:^|\/)linux\/(?:CMakeLists\.txt|meson\.build)$)/i.test(source.path)).sort((a, b) => a.path.localeCompare(b.path));
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

