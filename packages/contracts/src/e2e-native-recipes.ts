import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json.js";
import { E2EAppRecipeSchema, type E2EAppRecipe, type E2EMissingInput } from "./e2e.js";
import { verifyE2ESourceSnapshot, type E2ESourceSnapshot } from "./e2e-source.js";

type Source = E2ESourceSnapshot["sources"][number];
const sha = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const literalId = /^[A-Za-z0-9][A-Za-z0-9.-]{0,199}$/;
const GRADLE_SHA = "d725d707bfabd4dfdc958c624003b3c80accc03f7037b5122c4b1d0ef15cecab";
const androidToolchainRequirements = {
  schemaVersion: "native-toolchain-requirements/v1", platform: "android", gradle: "8.9", gradleDistributionSha256: GRADLE_SHA,
  androidGradlePlugin: "8.7.3", java: "17", compileSdk: 35, targetSdk: 35, minimumSdk: 26, buildTools: "34.0.0", abi: "x86_64",
  requiredInstalledManifestFields: ["gradlePath", "gradleSha256", "jdkPath", "jdkVersion", "androidSdkRoot", "platform35Sha256", "buildTools34Sha256", "emulatorImageSha256", "dependencyClosureDigest"],
};
const iosToolchainRequirements = {
  schemaVersion: "native-toolchain-requirements/v1", platform: "ios", xcode: "16.4", sdk: "iphonesimulator18.5", swiftLanguageMode: "5",
  deploymentTarget: "16.0", abi: "arm64", deviceFamily: "iPhone",
  requiredInstalledManifestFields: ["developerDir", "xcodeBuild", "simulatorSdk", "simulatorRuntime", "simulatorDeviceType", "agentDeviceRunner", "toolchainManifestDigest"],
};

function parent(path: string): string { return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "."; }
function joined(root: string, path: string): string { return root === "." ? path : `${root}/${path}`; }
function safeRelativeSourcePath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !/^[A-Za-z]:/.test(path) && !path.includes("\\")
    && !path.split("/").some((part) => part === "" || part === "." || part === "..");
}
function text(source: Source | undefined): string | undefined {
  if (!source || source.kind !== "blob") return undefined;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(source.bytes); } catch { return undefined; }
}
type OpenStepValue = string | OpenStepValue[] | { [key: string]: OpenStepValue };
class OpenStepParser {
  private offset = 0;
  private nodes = 0;
  constructor(private readonly source: string) { if (Buffer.byteLength(source, "utf8") > 2 * 1024 * 1024) throw new Error("PBX source exceeds parser bound"); }
  private fail(): never { throw new Error("unsupported or malformed OpenStep project structure"); }
  private skip(): void {
    for (;;) {
      while (/\s/.test(this.source[this.offset] ?? "")) this.offset++;
      if (this.source.startsWith("//", this.offset)) { const end = this.source.indexOf("\n", this.offset + 2); this.offset = end < 0 ? this.source.length : end + 1; continue; }
      if (this.source.startsWith("/*", this.offset)) { const end = this.source.indexOf("*/", this.offset + 2); if (end < 0) this.fail(); this.offset = end + 2; continue; }
      break;
    }
  }
  private atom(): string {
    this.skip(); const start = this.offset; let parens = 0;
    while (this.offset < this.source.length) {
      const char = this.source[this.offset]!;
      if (char === "(") { parens++; this.offset++; continue; }
      if (char === ")" && parens > 0) { parens--; this.offset++; continue; }
      if (parens === 0 && /[\s{}=;,"()]/.test(char)) break;
      this.offset++;
    }
    if (this.offset === start || parens !== 0) this.fail();
    return this.source.slice(start, this.offset);
  }
  private string(): string {
    this.offset++; let value = "";
    while (this.offset < this.source.length) {
      const char = this.source[this.offset++]!;
      if (char === '"') return value;
      if (char === "\\") { if (this.offset >= this.source.length) this.fail(); value += this.source[this.offset++]!; }
      else value += char;
      if (value.length > 8192) this.fail();
    }
    return this.fail();
  }
  private count(): void { if (++this.nodes > 100_000) this.fail(); }
  private value(depth: number): OpenStepValue {
    if (depth > 64) this.fail(); this.skip(); this.count();
    const char = this.source[this.offset];
    if (char === '"') return this.string();
    if (char === "{") {
      this.offset++; const result: { [key: string]: OpenStepValue } = Object.create(null) as { [key: string]: OpenStepValue };
      for (;;) {
        this.skip(); if (this.source[this.offset] === "}") { this.offset++; return result; }
        const key = this.source[this.offset] === '"' ? this.string() : this.atom();
        if (Object.prototype.hasOwnProperty.call(result, key)) this.fail();
        this.skip(); if (this.source[this.offset++] !== "=") this.fail();
        result[key] = this.value(depth + 1); this.skip(); if (this.source[this.offset++] !== ";") this.fail();
      }
    }
    if (char === "(") {
      this.offset++; const result: OpenStepValue[] = [];
      for (;;) {
        this.skip(); if (this.source[this.offset] === ")") { this.offset++; return result; }
        result.push(this.value(depth + 1)); this.skip();
        if (this.source[this.offset] === ",") this.offset++;
        else if (this.source[this.offset] !== ")") this.fail();
      }
    }
    return this.atom();
  }
  parse(): { [key: string]: OpenStepValue } {
    this.skip(); const value = this.value(0); this.skip();
    if (this.offset !== this.source.length || !value || typeof value !== "object" || Array.isArray(value)) this.fail();
    return value;
  }
}
function record(value: OpenStepValue | undefined): { [key: string]: OpenStepValue } | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}
function strings(value: OpenStepValue | undefined): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : undefined;
}
function parsePbxLinkage(source: string): { appTargetCount: number; targetId?: string; projectLinkedTarget: boolean } | undefined {
  try {
    const document = new OpenStepParser(source).parse(); const objects = record(document.objects); const rootObject = document.rootObject;
    if (!objects || typeof rootObject !== "string") return undefined;
    const projects = Object.entries(objects).filter(([, value]) => record(value)?.isa === "PBXProject");
    const targets = Object.entries(objects).filter(([, value]) => record(value)?.isa === "PBXNativeTarget");
    const rootProject = record(objects[rootObject]);
    const appTargets = targets.filter(([, value]) => {
      const target = record(value); return target?.name === "NativeExport" && target.productType === "com.apple.product-type.application";
    });
    const targetId = appTargets.length === 1 ? appTargets[0]![0] : undefined;
    const projectTargets = strings(rootProject?.targets);
    if (projects.length !== 1 || projects[0]![0] !== rootObject || targets.length !== 1 || appTargets.length !== 1 || !projectTargets) return undefined;
    return { appTargetCount: targets.length, ...(targetId ? { targetId } : {}), projectLinkedTarget: Boolean(targetId && projectTargets.includes(targetId)) };
  } catch { return undefined; }
}
type SchemeNode = { name: string; attributes: Record<string, string>; children: SchemeNode[] };
function parseSchemeXml(source: string): { name: string; reference?: Record<string, string> } | undefined {
  if (Buffer.byteLength(source, "utf8") > 64 * 1024) return undefined;
  let offset = source.charCodeAt(0) === 0xfeff ? 1 : 0; const stack: SchemeNode[] = []; const roots: SchemeNode[] = []; let nodeCount = 0;
  const decode = (value: string): string | undefined => {
    if (/&(?!amp;|lt;|gt;|quot;|apos;)/.test(value)) return undefined;
    return value.replace(/&(amp|lt|gt|quot|apos);/g, (_match, entity: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[entity]!);
  };
  while (offset < source.length) {
    if (source.startsWith("<?xml", offset)) { const end = source.indexOf("?>", offset + 5); if (end < 0 || roots.length || stack.length) return undefined; offset = end + 2; continue; }
    if (source.startsWith("<!--", offset)) { const end = source.indexOf("-->", offset + 4); if (end < 0) return undefined; offset = end + 3; continue; }
    if (source[offset] !== "<") { const end = source.indexOf("<", offset); const textPart = source.slice(offset, end < 0 ? source.length : end); if (textPart.trim()) return undefined; offset = end < 0 ? source.length : end; continue; }
    let end = offset + 1; let quote = "";
    while (end < source.length) { const char = source[end]!; if (quote) { if (char === quote) quote = ""; } else if (char === '"' || char === "'") quote = char; else if (char === ">") break; end++; }
    if (end >= source.length || quote) return undefined;
    const token = source.slice(offset + 1, end); offset = end + 1;
    if (token.startsWith("!") || token.startsWith("?")) return undefined;
    if (token.startsWith("/")) {
      const closeMatch = /^\/([A-Za-z_][A-Za-z0-9_.:-]*)\s*$/.exec(token);
      const current = stack.pop(); if (!closeMatch || !current || closeMatch[1] !== current.name) return undefined; continue;
    }
    const selfClosing = token.endsWith("/"); const body = selfClosing ? token.slice(0, -1) : token;
    const nameMatch = /^([A-Za-z_][A-Za-z0-9_.:-]*)/.exec(body); if (!nameMatch) return undefined;
    const name = nameMatch[1]!; let cursor = name.length; let needsSeparator = false;
    const attributes: Record<string, string> = Object.create(null) as Record<string, string>;
    while (cursor < body.length) {
      const whitespaceStart = cursor;
      while (/\s/.test(body[cursor] ?? "")) cursor++;
      if (cursor >= body.length) break;
      if (needsSeparator && cursor === whitespaceStart) return undefined;
      const attr = /^[A-Za-z_][A-Za-z0-9_.:-]*/.exec(body.slice(cursor)); if (!attr) return undefined; const attrName = attr[0]; cursor += attrName.length;
      while (/\s/.test(body[cursor] ?? "")) cursor++;
      if (body[cursor++] !== "=") return undefined;
      while (/\s/.test(body[cursor] ?? "")) cursor++;
      const delimiter = body[cursor++]; if (delimiter !== '"' && delimiter !== "'") return undefined;
      const valueStart = cursor; while (cursor < body.length && body[cursor] !== delimiter) cursor++;
      if (cursor >= body.length || Object.prototype.hasOwnProperty.call(attributes, attrName)) return undefined;
      const value = decode(body.slice(valueStart, cursor)); if (value === undefined) return undefined;
      attributes[attrName] = value; cursor++; needsSeparator = true;
    }
    const node: SchemeNode = { name, attributes, children: [] }; if (++nodeCount > 512 || stack.length >= 32) return undefined;
    if (stack.length) stack[stack.length - 1]!.children.push(node); else roots.push(node);
    if (!selfClosing) stack.push(node);
  }
  if (stack.length || roots.length !== 1 || roots[0]!.name !== "Scheme") return undefined;
  const root = roots[0]!; const buildActions = root.children.filter((child) => child.name === "BuildAction");
  const entryLists = buildActions.length === 1 ? buildActions[0]!.children.filter((child) => child.name === "BuildActionEntries") : [];
  const entries = entryLists.length === 1 ? entryLists[0]!.children.filter((child) => child.name === "BuildActionEntry") : [];
  const references = root.children.flatMap(function walk(node: SchemeNode): SchemeNode[] { return node.name === "BuildableReference" ? [node] : node.children.flatMap(walk); });
  const reference = entries.length === 1 ? entries[0]!.children.filter((child) => child.name === "BuildableReference") : [];
  if (entryLists.length !== 1 || entries.length !== 1 || references.length !== 1 || reference.length !== 1) return undefined;
  return { name: root.name, reference: reference[0]!.attributes };
}
function missing(targetId: string, reason: string, paths: readonly string[]): E2EMissingInput[] {
  const sourcePaths = [...new Set(paths)].sort().slice(0, 128);
  return [{ inputId: `native-recipe-${createHash("sha256").update(`${targetId}\0${reason}\0${sourcePaths.join("\0")}`).digest("hex").slice(0, 12)}`,
    targetIds: [targetId], kind: "runtime", disposition: "blocking", reason, sourcePaths }];
}
function buildRecipe(input: { appId: string; program: string; args: string[]; cwd: string; artifactRef: string }): E2EAppRecipe {
  const body = { schemaVersion: 1 as const,
    build: [{ program: input.program, args: input.args, cwd: input.cwd, timeoutMs: 300_000, env: {} }],
    launch: { kind: "application" as const, appId: input.appId, artifactRef: input.artifactRef, arguments: [] },
    serviceProfileIds: [], seedProfileId: "native-orders-seed-v1", accountProfileIds: ["synthetic", "owner", "viewer", "cross-tenant"], allowedOrigins: [] };
  return E2EAppRecipeSchema.parse({ ...body, recipeDigest: sha(body) });
}

function deriveAndroid(input: { sources: readonly Source[]; targetId: string }): { recipe: E2EAppRecipe | null; missingInputs: E2EMissingInput[] } {
  const manifests = input.sources.filter((source) => /(?:^|\/)src\/main\/AndroidManifest\.xml$/.test(source.path));
  if (manifests.length !== 1) return { recipe: null, missingInputs: missing(input.targetId, "Android project must have exactly one owning application manifest", manifests.map((item) => item.path)) };
  const manifest = manifests[0]!;
  const moduleRoot = parent(parent(parent(manifest.path)));
  if (moduleRoot.split("/").at(-1) !== "app") return { recipe: null, missingInputs: missing(input.targetId, "only the single source-owned Android :app application module is supported", [manifest.path, joined(parent(moduleRoot), "settings.gradle")]) };
  const moduleBuildPath = joined(moduleRoot, "build.gradle");
  const moduleBuild = input.sources.find((source) => source.path === moduleBuildPath);
  const moduleText = text(moduleBuild);
  const manifestText = text(manifest);
  const root = parent(moduleRoot);
  const rootBuildPath = joined(root, "build.gradle");
  const settingsPath = joined(root, "settings.gradle");
  const wrapperPath = joined(root, "gradle/wrapper/gradle-wrapper.properties");
  const toolchainPath = joined(moduleRoot, "toolchain-requirements.json");
  const rootBuild = text(input.sources.find((source) => source.path === rootBuildPath));
  const settings = text(input.sources.find((source) => source.path === settingsPath));
  const wrapper = text(input.sources.find((source) => source.path === wrapperPath));
  const toolchain = text(input.sources.find((source) => source.path === toolchainPath));
  const relevant = [manifest.path, moduleBuildPath, rootBuildPath, settingsPath, wrapperPath, toolchainPath];
  if (!moduleText || !manifestText || !rootBuild || !settings || !wrapper || !toolchain) return { recipe: null, missingInputs: missing(input.targetId, "Android source is missing literal module, root settings, wrapper or toolchain requirement metadata", relevant) };
  const pluginVersion = /id\s+['"]com\.android\.application['"]\s+version\s+['"]([^'"]+)['"]/.exec(rootBuild)?.[1];
  const pluginAssignments = [...rootBuild.matchAll(/id\s+['"]com\.android\.application['"]\s+version\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
  const modulePlugins = [...moduleText.matchAll(/\bid\s+['"]com\.android\.application['"]/g)];
  const rootPluginMentions = [...rootBuild.matchAll(/com\.android\.application/g)];
  const modulePluginMentions = [...moduleText.matchAll(/com\.android\.application/g)];
  const packageId = /\bpackage\s*=\s*["']([^"']+)["']/.exec(manifestText)?.[1];
  const applicationIds = [...moduleText.matchAll(/\bapplicationId\s+["']([^"']+)["']/g)].map((match) => match[1]);
  const namespaces = [...moduleText.matchAll(/\bnamespace\s+["']([^"']+)["']/g)].map((match) => match[1]);
  const applicationId = applicationIds[0];
  const namespace = namespaces[0];
  const gradleVersion = /^distributionUrl=.*\/gradle-([0-9.]+)-bin\.zip\s*$/m.exec(wrapper)?.[1];
  const distributionSha = /^distributionSha256Sum=([a-f0-9]{64})\s*$/m.exec(wrapper)?.[1];
  const distributionUrls = [...wrapper.matchAll(/^distributionUrl=.*$/gm)];
  const distributionChecksums = [...wrapper.matchAll(/^distributionSha256Sum=.*$/gm)];
  const moduleScript = moduleText;
  const issues: string[] = [];
  if (modulePlugins.length !== 1 || modulePluginMentions.length !== modulePlugins.length || pluginAssignments.length !== 1
    || rootPluginMentions.length !== pluginAssignments.length || pluginVersion !== "8.7.3") issues.push("owning Android module must use exactly one pinned literal application plugin 8.7.3 assignment");
  if (!packageId || !literalId.test(packageId) || applicationIds.length !== 1 || [...moduleText.matchAll(/\bapplicationId\b/g)].length !== applicationIds.length
    || namespaces.length !== 1 || [...moduleText.matchAll(/\bnamespace\b/g)].length !== namespaces.length || applicationId !== packageId || namespace !== packageId) issues.push("Android package, applicationId and namespace must be one matching literal identity without repeated or unsupported setters");
  if (distributionUrls.length !== 1 || [...wrapper.matchAll(/\bdistributionUrl\b/g)].length !== distributionUrls.length
    || distributionChecksums.length !== 1 || [...wrapper.matchAll(/\bdistributionSha256Sum\b/g)].length !== distributionChecksums.length
    || gradleVersion !== "8.9" || distributionSha !== GRADLE_SHA || !/^distributionUrl=https\\:\/\/services\.gradle\.org\/distributions\/gradle-8\.9-bin\.zip\s*$/m.test(wrapper)) issues.push("Gradle wrapper must pin one verified 8.9 distribution URL and checksum");
  const includeStatements = [...settings.matchAll(/\binclude\s+([^\n;]+)/g)].map((match) => match[1]!.trim());
  if (includeStatements.length !== 1 || !/^(['"]):app\1$/.test(includeStatements[0]!) || !/rootProject\.name\s*=\s*['"]Native['"]/.test(settings)) issues.push("Android settings must identify only the supported :app module");
  if (/productFlavors|flavorDimensions|externalNativeBuild|applicationIdSuffix|manifestPlaceholders|sourceSets|\bkotlin\s*\{|\bdependencies\s*\{|\b(?:api|implementation|compileOnly|runtimeOnly|testImplementation|androidTestImplementation)\s*(?:\(|['"])|fileTree\s*\(/i.test(moduleScript)
    || input.sources.some((source) => source.path.startsWith(`${moduleRoot}/`) && /\.(?:kt|c|cc|cpp|cxx|so)$/.test(source.path))) issues.push("Android project uses unsupported flavors, native or Kotlin sources, identity overrides, or application dependencies");
  const singleLiteral = (pattern: RegExp): string[] => [...moduleScript.matchAll(pattern)].map((match) => match[1]!);
  const compileSdks = singleLiteral(/\bcompileSdk\s+(\d+)\b/g);
  const buildTools = singleLiteral(/\bbuildToolsVersion\s+['"]([^'"]+)['"]/g);
  const minimumSdks = singleLiteral(/\bminSdk\s+(\d+)\b/g);
  const targetSdks = singleLiteral(/\btargetSdk\s+(\d+)\b/g);
  if (compileSdks.length !== 1 || compileSdks[0] !== "35" || buildTools.length !== 1 || buildTools[0] !== "34.0.0"
    || minimumSdks.length !== 1 || minimumSdks[0] !== "26" || targetSdks.length !== 1 || targetSdks[0] !== "35"
    || [...moduleText.matchAll(/\bcompileSdk\b/g)].length !== compileSdks.length || [...moduleText.matchAll(/\bbuildToolsVersion\b/g)].length !== buildTools.length
    || [...moduleText.matchAll(/\bminSdk\b/g)].length !== minimumSdks.length || [...moduleText.matchAll(/\btargetSdk\b/g)].length !== targetSdks.length) issues.push("Android module must use exactly one supported literal assignment for each frozen API and build-tools value");
  if (/\/\/|\/\*/.test(`${moduleScript}\n${rootBuild}\n${settings}`)) issues.push("Android build comments are unsupported by the bounded literal parser");
  if (/\$\{|\bproject\.|providers\.|findProperty\(|apply\s+from|includeBuild/.test(`${moduleText}\n${rootBuild}\n${settings}`)) issues.push("Android build contains dynamic identity or build configuration");
  try {
    if (Buffer.byteLength(toolchain, "utf8") > 8192 || canonicalJson(JSON.parse(toolchain)) !== canonicalJson(androidToolchainRequirements)) issues.push("Android toolchain requirement tuple differs from the frozen source profile");
  } catch { issues.push("Android toolchain requirement metadata is not bounded valid UTF-8 JSON"); }
  if (issues.length || !packageId) return { recipe: null, missingInputs: missing(input.targetId, issues.join("; ") || "Android identity is unresolved", relevant) };
  const args = ["--offline", "--no-daemon", "--console=plain", "--dependency-verification=strict", ":app:assembleDebug"];
  return { recipe: buildRecipe({ appId: packageId, program: "gradle", args, cwd: root, artifactRef: "app/build/outputs/apk/debug/app-debug.apk" }), missingInputs: [] };
}

function deriveIOS(input: { sources: readonly Source[]; targetId: string }): { recipe: E2EAppRecipe | null; missingInputs: E2EMissingInput[] } {
  const projects = input.sources.filter((source) => /(?:^|\/)NativeExport\.xcodeproj\/project\.pbxproj$/.test(source.path));
  if (projects.length !== 1) return { recipe: null, missingInputs: missing(input.targetId, "iOS project must have one supported owning Xcode project", projects.map((item) => item.path)) };
  const project = projects[0]!;
  const root = parent(parent(project.path));
  const pbx = text(project) ?? "";
  const projectDir = parent(project.path);
  const schemes = input.sources.filter((source) => source.path.startsWith(`${projectDir}/xcshareddata/xcschemes/`) && source.path.endsWith(".xcscheme"));
  const plistAssignments = [...pbx.matchAll(/\bINFOPLIST_FILE\s*=\s*([^;]+);/g)].map((match) => match[1]!.trim().replace(/^['"]|['"]$/g, ""));
  const plistPathValue = plistAssignments.length > 0 && new Set(plistAssignments).size === 1 ? plistAssignments[0] : undefined;
  const plistPath = plistPathValue && !/[$(){}\\]/.test(plistPathValue) && safeRelativeSourcePath(plistPathValue)
    ? joined(root, plistPathValue) : joined(root, "NativeExport/Info.plist");
  const plistSource = input.sources.find((source) => source.path === plistPath);
  const plist = text(plistSource) ?? "";
  const schemePath = schemes.length === 1 ? schemes[0]!.path : "";
  const scheme = text(schemes[0]) ?? "";
  const toolchainPath = joined(root, "toolchain-requirements.json");
  const toolchain = text(input.sources.find((source) => source.path === toolchainPath));
  const relevant = [project.path, ...schemes.map((item) => item.path), plistPath, toolchainPath];
  const linkage = parsePbxLinkage(pbx);
  const schemeLinkage = parseSchemeXml(scheme);
  const schemeReference = schemeLinkage?.reference;
  const targetId = linkage?.targetId;
  const packageTypes = [...pbx.matchAll(/PRODUCT_BUNDLE_PACKAGE_TYPE\s*=\s*([^;]+);/g)].map((match) => match[1]!.trim().replace(/^['"]|['"]$/g, ""));
  const bundleIds = [...pbx.matchAll(/PRODUCT_BUNDLE_IDENTIFIER\s*=\s*([^;]+);/g)].map((match) => match[1]!.trim().replace(/^['"]|['"]$/g, ""));
  const deployments = [...pbx.matchAll(/IPHONEOS_DEPLOYMENT_TARGET\s*=\s*([^;]+);/g)].map((match) => match[1]!.trim().replace(/^['"]|['"]$/g, ""));
  const architectures = [...pbx.matchAll(/(?:ARCHS|SUPPORTED_PLATFORMS)\s*=\s*([^;]+);/g)].map((match) => match[1]!.trim());
  const archValues = [...pbx.matchAll(/ARCHS\s*=\s*([^;]+);/g)].map((match) => match[1]!.trim().replace(/^['"]|['"]$/g, ""));
  const supportedPlatforms = [...pbx.matchAll(/SUPPORTED_PLATFORMS\s*=\s*([^;]+);/g)].map((match) => match[1]!.trim().replace(/^['"]|['"]$/g, ""));
  const plistId = /<key>\s*CFBundleIdentifier\s*<\/key>\s*<string>\s*([^<\s]+)\s*<\/string>/i.exec(plist)?.[1];
  const plistType = /<key>\s*CFBundlePackageType\s*<\/key>\s*<string>\s*([^<]+)\s*<\/string>/i.exec(plist)?.[1];
  const issues: string[] = [];
  if (!linkage || linkage.appTargetCount !== 1 || !targetId || !linkage.projectLinkedTarget
    || !packageTypes.length || packageTypes.some((value) => value !== "APPL")) issues.push("iOS project must contain one application target linked from its PBXProject root");
  if (schemes.length !== 1 || !schemes[0]!.path.endsWith("/NativeExport.xcscheme") || !schemeLinkage || !schemeReference
    || schemeReference.BuildableIdentifier !== "primary" || schemeReference.BlueprintIdentifier !== targetId || schemeReference.BlueprintName !== "NativeExport"
    || schemeReference.BuildableName !== "NativeExport.app" || schemeReference.ReferencedContainer !== "container:NativeExport.xcodeproj") {
    issues.push("iOS project must have one structurally placed shared scheme reference linked to its PBX application target and project");
  }
  if (!plistPathValue || !plistSource || !plistId || !literalId.test(plistId) || bundleIds.length === 0 || new Set(bundleIds).size !== 1 || bundleIds[0] !== plistId || plistType !== "APPL") issues.push("iOS bundle identity and associated application plist must agree as literals");
  if (deployments.length === 0 || new Set(deployments).size !== 1 || deployments[0] !== "16.0") issues.push("iOS project must pin one literal 16.0 simulator deployment target");
  if (architectures.some((value) => /\$\(|\$\{|x86_64|iphoneos/.test(value)) || archValues.length === 0 || archValues.some((value) => value !== "arm64")
    || supportedPlatforms.length === 0 || supportedPlatforms.some((value) => value !== "iphonesimulator")
    || !pbx.includes("SWIFT_VERSION = 5.0") || /baseConfigurationReference\s*=/.test(pbx)) issues.push("iOS project must be arm64 simulator-only, use Swift 5 mode, and avoid external xcconfig resolution");
  if (/XCRemoteSwiftPackageReference|PBXNativeTarget\s*\{[^}]*productType\s*=\s*com\.apple\.product-type\.application\.on-demand-install-capable|PRODUCT_BUNDLE_IDENTIFIER\s*=\s*\$/.test(pbx)) issues.push("iOS project has a floating package, unsupported target, or dynamic bundle setting");
  if (!toolchain) issues.push("iOS source is missing its frozen Xcode and simulator toolchain requirement metadata");
  else try {
    if (Buffer.byteLength(toolchain, "utf8") > 8192 || canonicalJson(JSON.parse(toolchain)) !== canonicalJson(iosToolchainRequirements)) issues.push("iOS toolchain requirement tuple differs from the frozen source profile");
  } catch { issues.push("iOS toolchain requirement metadata is not bounded valid UTF-8 JSON"); }
  if (issues.length || !plistId || !schemePath) return { recipe: null, missingInputs: missing(input.targetId, issues.join("; ") || "iOS source tuple is unresolved", relevant) };
  const args = ["-project", "NativeExport.xcodeproj", "-scheme", "NativeExport", "-configuration", "Debug", "-sdk", "iphonesimulator18.5",
    "-destination", "generic/platform=iOS Simulator", "-derivedDataPath", ".agentx-build/DerivedData", "-disableAutomaticPackageResolution",
    "-onlyUsePackageVersionsFromResolvedFile", "CODE_SIGNING_ALLOWED=NO", "ARCHS=arm64", "build"];
  return { recipe: buildRecipe({ appId: plistId, program: "xcodebuild", args, cwd: root, artifactRef: ".agentx-build/DerivedData/Build/Products/Debug-iphonesimulator/NativeExport.app" }), missingInputs: [] };
}

/** Conservatively derives only the two frozen native source tuples; it executes no project tooling. */
export function deriveE2ENativeApplicationRecipe(input: { snapshot: E2ESourceSnapshot; applicationId: string; targetId: string }): { recipe: E2EAppRecipe | null; missingInputs: E2EMissingInput[] } {
  let sources: readonly Source[];
  try { sources = [...verifyE2ESourceSnapshot(input.snapshot, input.snapshot.candidate).values()]; }
  catch { return { recipe: null, missingInputs: missing(input.targetId, "native source recipe snapshot is not a verified immutable source selection", []) }; }
  if (input.targetId.startsWith("android-")) return deriveAndroid({ sources, targetId: input.targetId });
  if (input.targetId.startsWith("ios-") || input.targetId.startsWith("apple-target-")) return deriveIOS({ sources, targetId: input.targetId });
  return { recipe: null, missingInputs: missing(input.targetId, `native application ${input.applicationId} has no selected Android or iOS target`, []) };
}
