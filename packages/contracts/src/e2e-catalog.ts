import { createHash } from "node:crypto";
import * as ts from "typescript";
import {
  E2EAppRecipeSchema, E2ERepositoryInspectionSchema, E2ESetupProposalSchema, type E2EAppRecipe, type E2ERepositoryInspection, type E2ESetupProposal, type E2ETarget,
} from "./e2e.js";
import { canonicalJson } from "./canonical-json.js";
import { bindE2EApplicationAccountTargets, readE2EApplicationProjectContract, type E2EApplicationProjectContract } from "./e2e-application-accounts.js";
import { verifyE2ESourceSnapshot, type E2ESourceSnapshot } from "./e2e-source.js";
import { WEB_API_RUNTIME_PROFILE_ID } from "./e2e-web-api-qualification.js";
import { e2ePackageManifests, e2eRunnerUnsafePath, parseE2EPackageManifest } from "./e2e-package-manifests.js";
import type { CandidateManifest } from "./task-workflow.js";

const MAX_SOURCE_FILES = 512;
const MAX_SOURCE_FILE_BYTES = 512 * 1024;
const unsafePathPart = /^(?:\.git|\.github|\.aws|\.ssh|\.env(?:\..*)?|secrets?|credentials?|.*(?:token|password|private[-_]?key).*)$/i;
const runnerUnsafe = e2eRunnerUnsafePath;

export type E2EPortableSourceInspection = Readonly<{ parseable: boolean; exports: readonly Readonly<{ name: string; kind: "callable" | "data" | "unresolved" }>[] }>;
/** Bounded AST-only capability classification; it never loads or evaluates candidate code. */
export function inspectE2EPortableSource(source: string, path: string): E2EPortableSourceInspection {
  if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_FILE_BYTES) return { parseable: false, exports: [] };
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (!/^(?:js|mjs|cjs|jsx|ts|tsx)$/.test(ext)) return { parseable: false, exports: [] };
  const kind = ext === "tsx" ? ts.ScriptKind.TSX : ext === "jsx" ? ts.ScriptKind.JSX : /^(?:js|mjs|cjs)$/.test(ext) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind);
  if ((file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length > 0) return { parseable: false, exports: [] };
  const declarations = new Map<string, ts.Expression>();
  const directCallable = new Set<string>();
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) directCallable.add(statement.name.text);
    if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) declarations.set(declaration.name.text, declaration.initializer);
    }
  }
  const resolve = (expression: ts.Expression, visited = new Set<string>(), budget = { steps: 0 }): "callable" | "data" | "unresolved" => {
    if (++budget.steps > 128) return "unresolved";
    if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) return "callable";
    if (ts.isClassExpression(expression)) return "data";
    if (ts.isIdentifier(expression)) {
      const name = expression.text;
      if (directCallable.has(name)) return "callable";
      if (visited.has(name)) return "unresolved";
      const value = declarations.get(name);
      if (!value) return "unresolved";
      const next = new Set(visited); next.add(name);
      return resolve(value, next, budget);
    }
    return "data";
  };
  const output = new Map<string, "callable" | "data" | "unresolved">();
  for (const statement of file.statements) {
    if (ts.isExportAssignment(statement)) {
      if (!statement.isExportEquals) output.set("default", resolve(statement.expression));
      continue;
    }
    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly || statement.moduleSpecifier || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue;
      for (const element of statement.exportClause.elements) {
        if (element.isTypeOnly) continue;
        const name = element.name.text;
        const localName = element.propertyName?.text ?? name;
        const value = declarations.get(localName);
        output.set(name, directCallable.has(localName) ? "callable" : value ? resolve(value, new Set([localName])) : "unresolved");
      }
      continue;
    }
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) ?? [] : [];
    if (!modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    const isDefault = modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
    if (ts.isFunctionDeclaration(statement) && statement.body && (statement.name || isDefault)) output.set(isDefault ? "default" : statement.name!.text, "callable");
    else if (ts.isClassDeclaration(statement)) output.set(isDefault ? "default" : statement.name?.text ?? "default", "data");
    else if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      output.set(isDefault ? "default" : declaration.name.text, resolve(declaration.initializer, new Set([declaration.name.text])));
    }
  }
  return { parseable: true, exports: [...output].map(([name, value]) => ({ name, kind: value })).sort((a, b) => a.name.localeCompare(b.name)) };
}

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
    while (i < text.length && !/[\s{}()=;," ]/.test(text[i]!)) i += 1;
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
    if (!project || stringValue(project.isa) !== "PBXProject") throw new Error("PBX rootObject does not reference PBXProject");
    const targetRefs = array(project?.targets);
    if (!targetRefs || targetRefs.length > 128 || targetRefs.some((ref) => typeof ref !== "string")) throw new Error("PBX application target list is invalid or exceeds limits");
    if (new Set(targetRefs).size !== targetRefs.length) throw new Error("PBX application target list contains duplicate source-target references");
    const projectConfigurations = new Map<string, Record<string, OpenStepValue>>();
    const ambiguousProjectConfigurationNames = new Set<string>();
    const projectConfigurationsWithExternalBase = new Set<string>();
    const projectConfigListRef = stringValue(project.buildConfigurationList);
    const projectConfigList = dict(projectConfigListRef ? objects[projectConfigListRef] : undefined);
    if (stringValue(projectConfigList?.isa) === "XCConfigurationList") {
      const projectConfigRefs = array(projectConfigList?.buildConfigurations);
      if (projectConfigRefs && projectConfigRefs.length <= 32) for (const configRefValue of projectConfigRefs) {
        const configRef = stringValue(configRefValue); const config = dict(configRef ? objects[configRef] : undefined);
        const name = stringValue(config?.name); const settings = dict(config?.buildSettings);
        if (config && stringValue(config.isa) === "XCBuildConfiguration" && name && settings && !projectConfigurations.has(name) && !ambiguousProjectConfigurationNames.has(name)) {
          projectConfigurations.set(name, settings);
          if (stringValue(config.baseConfigurationReference) !== undefined) projectConfigurationsWithExternalBase.add(name);
        }
        else if (name) { projectConfigurations.delete(name); ambiguousProjectConfigurationNames.add(name); }
      }
    }
    const projectDir = /^(.*?\.xcodeproj)\/project\.pbxproj$/i.exec(path)?.[1];
    const plistPathFor = (rawValue: string | undefined): string | undefined => {
      if (!rawValue || /\\/.test(rawValue)) return undefined;
      const raw = rawValue.replace(/^\$\((?:SRCROOT|PROJECT_DIR)\)\/?|^\$\{(?:SRCROOT|PROJECT_DIR)\}\/?/, "");
      if (/\$\(|\$\{/.test(raw)) return undefined;
      if (!projectDir || !normalizedPath(raw)) return undefined;
      const joined = projectDir.includes("/") ? `${projectDir.slice(0, projectDir.lastIndexOf("/"))}/${raw}` : raw;
      return normalizedPath(joined) ? joined : undefined;
    };
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
        const settings = dict(config.buildSettings) ?? {};
        const name = stringValue(config.name);
        const inherited = name ? projectConfigurations.get(name) : undefined;
        const hasExternalBaseConfig = stringValue(config.baseConfigurationReference) !== undefined;
        const fact = (key: string): string | undefined => {
          const own = stringValue(settings[key]);
          const value = own ?? (!hasExternalBaseConfig && name && !projectConfigurationsWithExternalBase.has(name) && inherited ? stringValue(inherited[key]) : undefined);
          return value?.trim() || undefined;
        };
        const sdk = fact("SDKROOT");
        const supported = fact("SUPPORTED_PLATFORMS")?.split(/\s+/).filter(Boolean) ?? [];
        const platformNames = [...(sdk ? [sdk] : []), ...supported];
        const ios = platformNames.some((value) => value === "iphoneos" || value === "iphonesimulator");
        const mac = platformNames.some((value) => value === "macosx");
        const recognized = platformNames.length > 0 && platformNames.every((value) => ["iphoneos", "iphonesimulator", "macosx"].includes(value));
        const platform: "ios" | "macos" | undefined = recognized && ios !== mac ? ios ? "ios" : "macos" : undefined;
        const bundleId = fact("PRODUCT_BUNDLE_IDENTIFIER");
        const normalizedBundle = bundleId && /^[A-Za-z0-9][A-Za-z0-9.-]{0,199}$/.test(bundleId) ? bundleId : undefined;
        return { platform, bundleId: normalizedBundle, plistPath: plistPathFor(fact("INFOPLIST_FILE")) };
      });
      const complete = configs.every((config) => config.platform && config.bundleId && config.plistPath);
      const oneValue = <T>(values: Array<T | undefined>): T | undefined => values.length > 0 && values.every((value) => value !== undefined && value === values[0]) ? values[0] : undefined;
      const platform = complete ? oneValue<"ios" | "macos">(configs.map((config) => config.platform)) : undefined;
      const bundleId = complete ? oneValue<string>(configs.map((config) => config.bundleId)) : undefined;
      const resolvedPlist = complete ? oneValue<string>(configs.map((config) => config.plistPath)) : undefined;
      output.push({ ref, ...(platform ? { platform } : {}), ...(bundleId ? { bundleId } : {}), ...(resolvedPlist ? { plistPath: resolvedPlist } : {}) });
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

/** A web or API runtime profile whose catalog row is READY for the installation (see admitE2ERegisteredRuntime). */
export type E2EReadyRuntimeProfile = Readonly<{ kind: "web" | "api"; profileId: string }>;
/** The runtime profile ids a setup proposal may name for web and API targets. */
const QUALIFIED_RUNTIME_PROFILE_IDS: readonly string[] = [WEB_API_RUNTIME_PROFILE_ID];
const unavailableRuntimeProfile = { web: "web-phase-unavailable", api: "api-phase-unavailable" } as const;

/** Whether a runtime profile id is the placeholder discovery assigns (or the empty device choice), not an approved profile. */
export function isE2EPlaceholderRuntimeProfileId(profileId: string): boolean {
  return profileId.endsWith("-phase-unavailable") || profileId === "no-device-selected";
}

/**
 * The target as source discovery derives it. A web or API target may carry the qualified runtime profile it was approved against, which is not
 * derivable from source; this maps that one choice back to the discovery placeholder so an approved target compares equal to its source identity.
 * Every other field, and every other profile id, is returned unchanged and so still mismatches.
 */
export function e2eTargetSourceIdentity<T extends E2ETarget>(target: T): T {
  return (target.kind === "web" || target.kind === "api") && QUALIFIED_RUNTIME_PROFILE_IDS.includes(target.runtimeProfileId)
    ? { ...target, runtimeProfileId: unavailableRuntimeProfile[target.kind] } : target;
}

/** The profile a target of this kind is proposed against; with several READY profiles of one kind the lexically first wins, so the choice is deterministic. */
function readyProfileId(readyProfiles: readonly E2EReadyRuntimeProfile[], kind: "web" | "api"): string | undefined {
  return readyProfiles.filter((item) => item.kind === kind).map((item) => item.profileId).sort()[0];
}

/**
 * Proposes the setup for an inspected source snapshot. Web and API targets are proposed against the READY profile of their kind when
 * `readyProfiles` has one; otherwise (and for every other target kind) they keep the phase-unavailable placeholder inspection assigned.
 */
export function proposeE2ESetup(input: { inspection: E2ERepositoryInspection; snapshot: VerifiedE2ESourceSnapshot; expectedCandidate: CandidateManifest;
  readyProfiles?: readonly E2EReadyRuntimeProfile[] }): E2ESetupProposal {
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
  const readyProfiles = input.readyProfiles ?? [];
  const targets = parsed.proposedTargets.map((target) => {
    if (target.kind !== "web" && target.kind !== "api") return target;
    const profileId = readyProfileId(readyProfiles, target.kind);
    return profileId === undefined || target.runtimeProfileId !== unavailableRuntimeProfile[target.kind] ? target : { ...target, runtimeProfileId: profileId };
  });
  const proposal = {
    candidateDigest: parsed.candidateDigest, applications: parsed.applications, targets,
    dependencyEdges: parsed.dependencyEdges, scenarios: parsed.proposedScenarios, sources: parsed.sources,
    missingInputs: parsed.missingInputs,
    state: parsed.missingInputs.some((item) => item.disposition === "blocking") ? "needs-input" : "proposed",
  } as const;
  return E2ESetupProposalSchema.parse(proposal);
}

/**
 * Re-derives a stored proposal from its source. A web or API target may carry a runtime profile other than the placeholder: the READY profile
 * it was proposed against. That choice is not derivable from source (it was current catalog state at proposal time), so verification takes it
 * from the proposal, re-derives everything else, and rejects any mismatch. Only a qualified web/API profile id is accepted; readiness itself is re-checked at planning.
 */
export function verifyE2ESetupProposal(proposal: E2ESetupProposal, snapshot: VerifiedE2ESourceSnapshot, expectedCandidate: CandidateManifest): E2ESetupProposal {
  const readyProfiles: E2EReadyRuntimeProfile[] = [];
  const proposedTargets = proposal.targets.map((target) => {
    if ((target.kind !== "web" && target.kind !== "api") || target.runtimeProfileId.endsWith("-phase-unavailable")) return target;
    if (!QUALIFIED_RUNTIME_PROFILE_IDS.includes(target.runtimeProfileId)) throw new Error("setup proposal names a runtime profile that is not a qualified web/API profile");
    readyProfiles.push({ kind: target.kind, profileId: target.runtimeProfileId });
    return { ...target, runtimeProfileId: unavailableRuntimeProfile[target.kind] };
  });
  const inspection: E2ERepositoryInspection = { candidateDigest: proposal.candidateDigest, sources: proposal.sources, applications: proposal.applications,
    proposedTargets, dependencyEdges: proposal.dependencyEdges, proposedScenarios: proposal.scenarios, missingInputs: proposal.missingInputs };
  const verified = proposeE2ESetup({ inspection, snapshot, expectedCandidate, readyProfiles });
  if (canonicalJson(E2ESetupProposalSchema.parse(proposal)) !== canonicalJson(verified)) throw new Error("setup proposal differs from independently source-derived proposal");
  return verified;
}

const NODE_WEB_PORT = "4317";
const NODE_LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json"];

/** `npm ci` plus an optional `npm run build`, then `npm start`, for a root package that has a start script and a lockfile; otherwise null. */
function nodeServiceRecipe(manifest: unknown, treePaths: ReadonlySet<string>): E2EAppRecipe | null {
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) return null;
  const scripts = (manifest as { scripts?: unknown }).scripts;
  const script = (name: string) => scripts !== null && typeof scripts === "object" && !Array.isArray(scripts) && typeof (scripts as Record<string, unknown>)[name] === "string"
    && ((scripts as Record<string, string>)[name] as string).trim() !== "";
  if (!script("start") || !NODE_LOCKFILES.some((path) => treePaths.has(path))) return null;
  const command = (args: string[], timeoutMs: number) => ({ program: "npm", args, cwd: ".", timeoutMs, env: {} });
  const body = {
    schemaVersion: 1 as const, build: [command(["ci"], 300_000), ...(script("build") ? [command(["run", "build"], 300_000)] : [])],
    launch: { kind: "service" as const, start: { ...command(["start"], 60_000), env: { PORT: NODE_WEB_PORT } }, health: { path: "/", expectedStatus: 200 } },
    serviceProfileIds: [], seedProfileId: "synthetic-seed-v1", accountProfileIds: ["synthetic"], allowedOrigins: ["app-origin"],
  };
  return E2EAppRecipeSchema.parse({ ...body, recipeDigest: createHash("sha256").update(canonicalJson(body)).digest("hex") });
}

/**
 * The launch recipe discovery yields for the snapshot's root web/API package when it comes from the source rather than the generic start-script
 * fallback: the explicit project contract's recipe, unchanged, or the one inferred from `scripts.start`, `scripts.build` and an npm lockfile.
 * It is read from discovery's own result, so it is null exactly when discovery proposes no such recipe (a start and dev conflict, a non-web
 * package, a malformed contract or native sidecar, no root package, or no lockfile).
 */
export function inferNodeWebRecipe(snapshot: E2ESourceSnapshot): E2EAppRecipe | null {
  const { inspection, recipeOrigins } = discoverE2ERepository(snapshot, snapshot.candidate);
  const root = inspection.applications.find((item) => (item.kind === "web" || item.kind === "api") && item.sourcePaths[0] === "package.json");
  return root !== undefined && recipeOrigins.get(root.applicationId) !== "start-script" ? root.recipe : null;
}

/** Discover a bounded app graph from an immutable source snapshot. Discovery parses data only; it never imports or executes candidate code. */
export function inspectE2ERepository(snapshot: VerifiedE2ESourceSnapshot, expectedCandidate: CandidateManifest): { inspection: E2ERepositoryInspection; portableOperations: PortableOperation[] } {
  const { inspection, portableOperations } = discoverE2ERepository(snapshot, expectedCandidate);
  return { inspection, portableOperations };
}

/** Where an application's discovered recipe came from; only the generic `npm run <script>` fallback is not a source-declared or lockfile-backed launch contract. */
type RecipeOrigin = "project-contract" | "inferred-node" | "start-script";

function discoverE2ERepository(snapshot: VerifiedE2ESourceSnapshot, expectedCandidate: CandidateManifest): { inspection: E2ERepositoryInspection; portableOperations: PortableOperation[]; recipeOrigins: ReadonlyMap<string, RecipeOrigin> } {
  const recipeOrigins = new Map<string, RecipeOrigin>();
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
  const manifests = e2ePackageManifests(sources.values());
  const manifestDirs = manifests.map((manifest) => manifest.path.includes("/") ? manifest.path.slice(0, manifest.path.lastIndexOf("/")) : ".");
  const deepestPackageDir = (path: string) => manifestDirs.filter((dir) => dir === "." || path.startsWith(dir + "/"))
    .sort((a, b) => componentDepth(b) - componentDepth(a) || a.localeCompare(b))[0];
  const declaredNames = new Map<string, number>();
  const manifestsByName = new Map<string, typeof manifests>();
  for (const manifest of manifests) {
    try {
      const value = parseE2EPackageManifest(manifest) as { name?: unknown } | null;
      if (typeof value?.name === "string" && /^[a-zA-Z0-9_.@/-]{1,120}$/.test(value.name)) {
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
    try { data = parseE2EPackageManifest(manifest); } catch { continue; }
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
    let projectContract: E2EApplicationProjectContract | null = null;
    let projectContractMalformed = false;
    // Source project contracts are web/API only and need a valid package name; anything else keeps the mainline discovery path.
    if (validName !== undefined && (kind === "web" || kind === "api")) try { projectContract = readE2EApplicationProjectContract(snapshot, appId); }
    catch {
      projectContractMalformed = true;
      missingInputs.push({ inputId: "application-project-contract-" + createHash("sha256").update(manifest.path).digest("hex").slice(0, 12),
        targetIds: [], kind: "runtime", disposition: "blocking", reason: "Source-owned application project contract is malformed, ambiguous, or outside its approved owning package", sourcePaths: [manifest.path] });
    }
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
    const additionalTargets: E2ERepositoryInspection["proposedTargets"] = [];
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
        const metadata = plistMetadata(iosText);
        const platformProven = metadata.packageType === "APPL" && metadata.platforms.length > 0 && metadata.platforms.every((value) => value === "iPhoneOS" || value === "iPhoneSimulator");
        if (iosId && platformProven) mobileTargets.push({ targetId: "ios-" + createHash("sha256").update(`${relDir}\0${nativeProjectRoot(iosPath, "ios")}\0${iosId}`).digest("hex").slice(0, 10), applicationId: appId, runtimeProfileId: "ios-phase-unavailable", accountProfileId: "synthetic", kind: "mobile", os: "ios", appId: iosId, deviceProfileId: "no-device-selected" });
      }
      const mobileTargetsByPlatform = new Map<string, Array<Extract<E2ERepositoryInspection["proposedTargets"][number], { kind: "mobile" }>>>();
      for (const item of mobileTargets) if (item.kind === "mobile") mobileTargetsByPlatform.set(item.os, [...(mobileTargetsByPlatform.get(item.os) ?? []), item]);
      for (const [platform, items] of mobileTargetsByPlatform) if (items.length > 1) missingInputs.push({ inputId: `${platform}-project-selection-${createHash("sha256").update(relDir).digest("hex").slice(0, 10)}`, targetIds: items.map((item) => item.targetId), kind: "target-selection", disposition: "blocking", reason: `Multiple ${platform} project identities are owned by this framework package; select the intended app`, sourcePaths: appFiles.filter((path) => new RegExp(`(^|/)${platform}/`).test(path)).slice(0, 32) });
      target = mobileTargets.shift();
      if (target) additionalTargets.push(...mobileTargets);
      if (!target && androidManifests.length === 0 && iosMetadata.length === 0) missingInputs.push({ inputId: "mobile-target-" + createHash("sha256").update(manifest.path).digest("hex").slice(0, 10), targetIds: [], kind: "target-selection", disposition: "blocking", reason: "React Native package has no native platform manifest with an application identity", sourcePaths: [manifest.path] });

    } else target = { targetId: "desktop-" + (applications.length + 1), applicationId: appId, runtimeProfileId: "electron-phase-unavailable", accountProfileId: "synthetic", kind: "desktop", os: "linux", driver: "electron", appId };
    let recipe: E2ERepositoryInspection["applications"][number]["recipe"] = null;
    let recipeFromInference = false;
    const hasStart = typeof pkg.scripts?.start === "string" && pkg.scripts.start.trim() !== "";
    const hasDev = typeof pkg.scripts?.dev === "string" && pkg.scripts.dev.trim() !== "";
    if (projectContract !== null) recipe = projectContract.recipe;
    if (kind === "web" || kind === "api") {
      if (hasStart !== hasDev) {
        if (projectContract === null && !projectContractMalformed) {
          const script = hasStart ? "start" : "dev";
          const inferred = hasStart && relDir === "." ? nodeServiceRecipe(pkg, new Set(snapshot.treePaths)) : null;
          const recipeBody = {
            schemaVersion: 1 as const, build: [],
            launch: { kind: "service" as const, start: { program: "npm", args: ["run", script], cwd: relDir, timeoutMs: 60_000, env: {} }, health: { path: "/", expectedStatus: 200 } },
            serviceProfileIds: [], seedProfileId: "synthetic-seed-v1", accountProfileIds: ["synthetic"], allowedOrigins: ["app-origin"],
          };
          recipeFromInference = inferred !== null;
          recipe = inferred ?? E2EAppRecipeSchema.parse({ ...recipeBody, recipeDigest: createHash("sha256").update(canonicalJson(recipeBody)).digest("hex") });
        }
      } else if (hasStart && hasDev) {
        if (projectContract === null && !projectContractMalformed) missingInputs.push({ inputId: "recipe-choice-" + (applications.length + 1), targetIds: target ? [target.targetId] : [], kind: "runtime", disposition: "blocking", reason: "The repository declares both start and dev recipes; choose the intended application launch contract", sourcePaths: [manifest.path] });
      }
    }
    let appTargets = target ? [target, ...additionalTargets] : [];
    if (projectContract !== null) {
      try { appTargets = bindE2EApplicationAccountTargets({ contract: projectContract, applicationId: appId, baseTargets: appTargets }); }
      catch {
        missingInputs.push({ inputId: "application-account-targets-" + createHash("sha256").update(manifest.path).digest("hex").slice(0, 12),
          targetIds: appTargets.map((item) => item.targetId), kind: "target-selection", disposition: "blocking", reason: "Source account variants do not bind exact compatible base targets within the target inventory limit", sourcePaths: [manifest.path] });
        recipe = null;
      }
    }
    if (kind === "mobile" || kind === "desktop") {
      const runtimeSources = sourcePaths.filter((path) => /AndroidManifest\.xml$|Info\.plist$|project\.pbxproj$|\.csproj$|\.sln$|CMakeLists\.txt$|meson\.build$/.test(path));
      if (appTargets.length) missingInputs.push({ inputId: "native-runtime-" + (applications.length + 1), targetIds: appTargets.map((item) => item.targetId), kind: "runtime", disposition: "mock-substitutable", reason: `The ${kind} build and launch runtime profile is unavailable in this phase`, sourcePaths: runtimeSources.length ? runtimeSources : [manifest.path] });
    }
    if (recipe !== null) recipeOrigins.set(appId, projectContract !== null ? "project-contract" : recipeFromInference ? "inferred-node" : "start-script");
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
    const appId = "api-contract-" + createHash("sha256").update(source.path).digest("hex").slice(0, 12);
    const stableId = createHash("sha256").update(source.path).digest("hex").slice(0, 12);
    const targetId = "api-schema-" + stableId;
    addApplication(appId, "api", [source.path], [{ targetId, applicationId: appId, runtimeProfileId: "api-phase-unavailable", accountProfileId: "synthetic", kind: "api", protocol: "http", originRef: "app-origin" }]);
    missingInputs.push({ inputId: "service-recipe-" + stableId, targetIds: [targetId], kind: "runtime", disposition: "mock-substitutable", reason: "An API schema was found without a source-backed service launch recipe", sourcePaths: [source.path] });
  }
  const appleOwnedPaths = new Set<string>();
  const pbxCreatedApplications = new Set<string>();
  const consumedFrameworkTargets = new Set<string>();
  const appleTargetProjectSources = new Map<string, string>();
  const xcodeProjects = [...sources.values()].filter((source) => /\.xcodeproj\/project\.pbxproj$/i.test(source.path)).sort((a, b) => a.path.localeCompare(b.path));
  const preexistingFrameworkTargets = new Set(proposedTargets.filter((target) => !pbxCreatedApplications.has(target.applicationId)).map((target) => `${target.applicationId}\0${target.targetId}`));
  const appleProjectsByPath = new Map(xcodeProjects.map((source) => [source.path, parseAppleProject(source.path, Buffer.from(source.bytes).toString("utf8"))]));
  for (const projectSource of xcodeProjects) {
    appleOwnedPaths.add(projectSource.path);
    const project = appleProjectsByPath.get(projectSource.path)!;
    const projectRecords = [...project.targets].sort((a, b) => a.ref.localeCompare(b.ref));
    if (project.error || projectRecords.length === 0) {
      const id = createHash("sha256").update(projectSource.path).digest("hex").slice(0, 12);
      missingInputs.push({ inputId: "apple-project-metadata-" + id, targetIds: [], kind: "target-selection", disposition: "blocking", reason: project.error ? `Apple project metadata is unresolved: ${project.error}` : "Apple project has no source-confirmed application target", sourcePaths: [projectSource.path] });
      continue;
    }
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
      const matches = applications.flatMap((application) => {
        if (!application.sourcePaths.includes(record.plistPath!)) return [];
        return proposedTargets.filter((target) => target.applicationId === application.applicationId
          && ((record.platform === "ios" && target.kind === "mobile" && target.os === "ios" && target.appId === record.bundleId)
            || (record.platform === "macos" && target.kind === "desktop" && target.os === "macos" && target.appId === record.bundleId))
          && preexistingFrameworkTargets.has(`${target.applicationId}\0${target.targetId}`))
          .map((target) => ({ application, target }));
      });
      const frameworkMatch = matches.length === 1 ? matches[0] : undefined;
      const inverseMatches = frameworkMatch ? [...appleProjectsByPath.values()].flatMap((candidateProject) => candidateProject.targets)
        .filter((candidate) => candidate.platform === record.platform && candidate.bundleId === record.bundleId && candidate.plistPath === record.plistPath).length : 0;
      const uniquelyCorroboratedFrameworkMatch = frameworkMatch && inverseMatches === 1 ? frameworkMatch : undefined;
      if (uniquelyCorroboratedFrameworkMatch) {
        const key = `${uniquelyCorroboratedFrameworkMatch.application.applicationId}\0${uniquelyCorroboratedFrameworkMatch.target.targetId}`;
        uniquelyCorroboratedFrameworkMatch.application.sourcePaths = [...new Set([...uniquelyCorroboratedFrameworkMatch.application.sourcePaths, projectSource.path])].sort();
        appleTargetProjectSources.set(uniquelyCorroboratedFrameworkMatch.target.targetId, projectSource.path);
        if (!consumedFrameworkTargets.has(key)) {
          consumedFrameworkTargets.add(key);
          continue;
        }
      }
      const existingOwners = frameworkMatch ? [frameworkMatch.application] : applications.filter((application) => application.sourcePaths.includes(record.plistPath!));
      if (existingOwners.length > 1) {
        missingInputs.push({ inputId: "apple-target-ownership-" + stable, targetIds: [], kind: "target-selection", disposition: "blocking", reason: "Multiple existing applications own this Apple plist; target ownership is ambiguous", sourcePaths: ownerPaths });
        continue;
      }
      const existingOwner = existingOwners[0];
      const applicationId = existingOwner?.applicationId ?? "apple-" + createHash("sha256").update(`${projectSource.path}\0${record.plistPath}`).digest("hex").slice(0, 12);
      const targetId = "apple-target-" + stable;
      const target = record.platform === "ios"
        ? { targetId, applicationId, runtimeProfileId: "ios-phase-unavailable", accountProfileId: "synthetic", kind: "mobile" as const, os: "ios" as const, appId: record.bundleId, deviceProfileId: "no-device-selected" }
        : { targetId, applicationId, runtimeProfileId: "native-macos-phase-unavailable", accountProfileId: "synthetic", kind: "desktop" as const, os: "macos" as const, driver: "native" as const, appId: record.bundleId };
      if (existingOwner) {
        existingOwner.sourcePaths = [...new Set([...existingOwner.sourcePaths, ...ownerPaths])].sort();
        proposedTargets.push(target);
      } else {
        addApplication(applicationId, record.platform === "ios" ? "mobile" : "desktop", ownerPaths, [target]);
        pbxCreatedApplications.add(applicationId);
      }
      appleTargetProjectSources.set(targetId, projectSource.path);
      missingInputs.push({ inputId: "native-runtime-" + stable, targetIds: [targetId], kind: "runtime", disposition: "mock-substitutable", reason: `The ${record.platform} native build and launch profile is unavailable in this phase`, sourcePaths: ownerPaths });
      if (matches.length > 0 && !uniquelyCorroboratedFrameworkMatch) {
        missingInputs.push({ inputId: "native-association-" + stable, targetIds: [targetId], kind: "runtime", disposition: "mock-substitutable", reason: "The source-backed native build association is ambiguous; the portable framework target is retained without claiming this PBX reference", sourcePaths: ownerPaths });
      }
    }
  }
  for (const source of [...sources.values()].filter((item) => /Info\.plist$/i.test(item.path)).sort((a, b) => a.path.localeCompare(b.path))) {
    if (appleOwnedPaths.has(source.path)) continue;
    const alreadyOwnedByTarget = applications.some((application) => application.sourcePaths.includes(source.path)
      && proposedTargets.some((target) => target.applicationId === application.applicationId
        && ((target.kind === "mobile" && target.os === "ios") || (target.kind === "desktop" && target.os === "macos"))));
    if (alreadyOwnedByTarget) continue;
    appleOwnedPaths.add(source.path);
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
    if (ios) appleTargetProjectSources.set(targetId, source.path);
    missingInputs.push({ inputId: "native-runtime-" + stable, targetIds: [targetId], kind: "runtime", disposition: "mock-substitutable", reason: `The ${ios ? "ios" : "macos"} native build and launch profile is unavailable in this phase`, sourcePaths: [source.path] });
  }
  const packageIosProjectTargets = new Map<string, Map<string, { targetIds: string[]; sourcePaths: Set<string> }>>();
  for (const target of proposedTargets.filter((item) => item.kind === "mobile" && item.os === "ios")) {
    const application = applications.find((item) => item.applicationId === target.applicationId);
    const sourcePath = appleTargetProjectSources.get(target.targetId) ?? application?.sourcePaths.find((item) => /Info\.plist$/i.test(item));
    if (!sourcePath) continue;
    const owner = deepestPackageDir(sourcePath);
    if (owner === undefined) continue;
    const projectIdentity = appleTargetProjectSources.get(target.targetId) ?? nativeProjectRoot(sourcePath, "ios");
    if (!projectIdentity) continue;
    const projects = packageIosProjectTargets.get(owner) ?? new Map<string, { targetIds: string[]; sourcePaths: Set<string> }>();
    const entry = projects.get(projectIdentity) ?? { targetIds: [], sourcePaths: new Set<string>() };
    entry.targetIds.push(target.targetId);
    entry.sourcePaths.add(sourcePath);
    projects.set(projectIdentity, entry);
    packageIosProjectTargets.set(owner, projects);
  }
  for (const [owner, projects] of packageIosProjectTargets) {
    if (projects.size < 2) continue;
    const targetIds = [...projects.values()].flatMap((entry) => entry.targetIds).sort();
    const sourcePaths = [...new Set([...projects.values()].flatMap((entry) => [...entry.sourcePaths]))].sort();
    missingInputs.push({ inputId: "ios-project-selection-" + createHash("sha256").update(owner).digest("hex").slice(0, 10), targetIds, kind: "target-selection", disposition: "blocking", reason: "Multiple ios project identities are owned by this framework package; select the intended app", sourcePaths });
  }
  for (const source of [...sources.values()].filter((item) => /(^|\/)Package\.swift$|\.xcworkspace\/contents\.xcworkspacedata$|(^|\/)ios\/.*project\.pbxproj$/i.test(item.path)).sort((a, b) => a.path.localeCompare(b.path))) {
    if (appleOwnedPaths.has(source.path)) continue;
    appleOwnedPaths.add(source.path);
    const stable = createHash("sha256").update(source.path).digest("hex").slice(0, 12);
    missingInputs.push({ inputId: "apple-source-metadata-" + stable, targetIds: [], kind: "target-selection", disposition: "blocking", reason: "Apple source metadata does not prove a supported application platform and target", sourcePaths: [source.path] });
  }
  const nativeMobile = [...sources.values()].filter((source) => /(?:^|\/)AndroidManifest\.xml$|(?:^|\/)build\.gradle(?:\.kts)?$/.test(source.path)).sort((a, b) => a.path.localeCompare(b.path));
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
  return { inspection, portableOperations, recipeOrigins };
}
