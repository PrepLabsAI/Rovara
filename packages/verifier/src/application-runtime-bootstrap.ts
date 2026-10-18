import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { E2EApplicationCliHostDescriptorSchema, E2EApplicationLaunchTargetSchema, E2EExpectedCaseSchema, E2ETargetSchema, APPLICATION_E2E_TEST_PATH, canonicalJson, copyBoundedE2EJsonData } from "@agentx/contracts";
import type { E2EConfig, ModelInstance, Reporter } from "e2e";
import { isEngineHandle, type EngineHandle } from "e2e/engine";
import { z } from "zod";
import { E2EApplicationSelectionPacketSchema } from "./application-identity.js";
import type { E2EApplicationCompiledShard } from "./application-scenarios.js";
import { E2E_APPLICATION_DECLARATION_PATH, E2E_APPLICATION_GENERATED_CONFIG_PATH, E2E_APPLICATION_SELECTION_PACKET_PATH,
  expectedE2EApplicationConfigDigest, renderE2EApplicationConfigWrapper } from "./application-templates.js";
import { expectedE2EApplicationReporterDigest } from "./application-runtime-assets.js";
import { E2EApplicationSupervisorReadbackSchema, e2eApplicationPrivateTransferMaxBytes, e2eApplicationSupervisorEvidenceEntryMax } from "./application-result-adapter.js";
import type { E2EApplicationSupervisorReadback } from "./application-result-adapter.js";
import { createInstalledE2EApplicationSupervisorReadbackClient } from "./application-runtime-cli.js";

const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const HOSTS_REGISTRY = "assets/application-runtime-v1/cli-hosts.json";
const MAX_FILE = 1_048_576;

export type E2EApplicationCliLaunchContext = Readonly<{
  schemaVersion: "e2e-application-cli-launch/v1"; launchId: string; shardId: string; compiledInventoryDigest: string; groupCompiledInventoryDigest: string;
  bindingDigest: string; roundId: string; runId: string; cliHost: { profileId: string; descriptor: { entryPointId: string; entryPointManifestDigest: string } };
  selectedTarget: z.infer<typeof E2ETargetSchema>; transportId: string; transportCorrelationId: string; deadlineAt: string;
}>;
export type E2EApplicationCliHost = Readonly<{ profileId: string; descriptor: { entryPointId: string; entryPointManifestDigest: string };
  launchContext: E2EApplicationCliLaunchContext; installedModule: string; engine?: EngineHandle; modelFactory?: () => ModelInstance;
  runCase(caseId: string, fixtures: unknown): Promise<void> }>;
type E2EApplicationCliHostFactoryResult = Readonly<{ profileId: string; descriptor: { entryPointId: string; entryPointManifestDigest: string };
  engine?: EngineHandle; modelFactory?: () => ModelInstance; runCase(caseId: string, fixtures: unknown): Promise<void> }>;

const launchSchema = z.object({ schemaVersion: z.literal("e2e-application-cli-launch/v1"),
  launchId: z.string().uuid(), shardId: z.string().min(1).max(120),
  compiledInventoryDigest: z.string().regex(/^[a-f0-9]{64}$/), groupCompiledInventoryDigest: z.string().regex(/^[a-f0-9]{64}$/),
  bindingDigest: z.string().regex(/^[a-f0-9]{64}$/),
  roundId: z.string().uuid(), runId: z.string().uuid(),
  cliHost: z.object({ profileId: z.string().min(1).max(120), descriptor: E2EApplicationCliHostDescriptorSchema }).strict(),
  selectedTarget: E2ETargetSchema,
  transportId: z.string().min(1).max(256), transportCorrelationId: z.string().uuid(),
  deadlineAt: z.string().datetime({ offset: true }) }).strict();

type Registration = { launch: E2EApplicationCliLaunchContext; host: E2EApplicationCliHost; installedModule: string };
const registrationKey = Symbol.for("agentx.e2e.application.cli-host.v1");
function currentRegistration(): Registration | undefined { return (globalThis as Record<PropertyKey, unknown>)[registrationKey] as Registration | undefined; }
function packageRoot(): string { return resolve(dirname(fileURLToPath(import.meta.url)), ".."); }
function inside(root: string, path: string): boolean { const rel = relative(root, path); return rel === "" || rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); }

async function canonicalFile(path: string, root: string, options: { requireOwner?: boolean; requirePrivateMode?: boolean } = {}): Promise<Buffer> {
  const absolute = resolve(path);
  if (!inside(root, absolute)) throw new Error("application CLI sidecar escapes the owned config root");
  let current = absolute;
  while (inside(root, current)) {
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new Error("application CLI sidecar ancestry contains a symlink");
    if (current === root) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const pathStat = await lstat(absolute);
  if (!pathStat.isFile() || pathStat.size > MAX_FILE || await realpath(absolute) !== absolute) throw new Error("application CLI sidecar is not a bounded canonical file");
  if (options.requireOwner !== false && typeof process.getuid === "function" && pathStat.uid !== process.getuid()) throw new Error("application CLI sidecar is not owned by this process");
  if (options.requirePrivateMode && (pathStat.mode & 0o077) !== 0) throw new Error("application CLI private file has group or world permissions");
  const handle = await open(absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat(); const current = await lstat(absolute);
    if (!opened.isFile() || current.isSymbolicLink() || opened.dev !== pathStat.dev || opened.ino !== pathStat.ino
      || current.dev !== opened.dev || current.ino !== opened.ino || opened.size > MAX_FILE
      || (options.requireOwner !== false && typeof process.getuid === "function" && opened.uid !== process.getuid())
      || (options.requirePrivateMode && (opened.mode & 0o077) !== 0)) throw new Error("application CLI file changed during safe open");
    const bytes = await handle.readFile();
    if (bytes.byteLength !== opened.size || bytes.byteLength > MAX_FILE) throw new Error("application CLI file changed while being read");
    return bytes;
  } finally { await handle.close(); }
}

function json(bytes: Uint8Array): unknown {
  const data = copyBoundedE2EJsonData(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), { maxBytes: MAX_FILE, maxDepth: 48 });
  return data;
}

export function registerE2EApplicationCliHost(host: E2EApplicationCliHost): void {
  const context = launchSchema.parse(host?.launchContext);
  if (!host || host.profileId !== context.cliHost.profileId || canonicalJson(host.descriptor) !== canonicalJson(context.cliHost.descriptor)
    || typeof host.installedModule !== "string" || !isAbsolute(host.installedModule)
    || typeof host.runCase !== "function"
    || (host.engine !== undefined && !isEngineHandle(host.engine))) throw new Error("application CLI host does not match the selected installed profile or provide its fixed proof channel");
  const existing = currentRegistration();
  const next: Registration = { launch: context, host: Object.freeze(host), installedModule: host.installedModule };
  if (existing) {
    if (existing.launch.launchId !== context.launchId || existing.installedModule !== next.installedModule || existing.host !== host) throw new Error("application CLI process already has a different immutable host registration");
    return;
  }
  Object.defineProperty(globalThis, registrationKey, { value: Object.freeze(next), configurable: false, enumerable: false, writable: false });
}

/** Reads only through the selected installed host's fixed supervisor channel; callers cannot supply paths or endpoints. */
export async function readE2EApplicationCliSupervisorReadback(input: {
  expected: { bindingDigest: string; compiledInventoryDigest: string; preparedEnvironmentDigest: string;
    groupCompiledInventoryDigest: string;
    launches: readonly { shardId: string; launchId: string; upstreamRunId: string }[]; caseCount: number };
  signal: AbortSignal;
}): Promise<E2EApplicationSupervisorReadback> {
  const registration = currentRegistration();
  if (!registration || input.signal.aborted) throw new Error("installed application supervisor proof channel is unavailable or cancelled");
  if (!Number.isSafeInteger(input.expected.caseCount) || input.expected.caseCount < 1 || input.expected.caseCount > 64
    || input.expected.launches.length < 1 || input.expected.launches.length > 3
    || new Set(input.expected.launches.map((item) => item.shardId)).size !== input.expected.launches.length) {
    throw new Error("installed supervisor readback request exceeds the exact group bounds");
  }
  const launch = registration.launch;
  const expectedLaunch = input.expected.launches.find((item) => item.shardId === launch.shardId);
  if (!expectedLaunch || expectedLaunch.launchId !== launch.launchId || launch.bindingDigest !== input.expected.bindingDigest
    || launch.groupCompiledInventoryDigest !== input.expected.groupCompiledInventoryDigest) throw new Error("installed supervisor proof read is outside its exact private launch assignment");
  const client = await createInstalledE2EApplicationSupervisorReadbackClient({ profileId: launch.cliHost.profileId, descriptor: launch.cliHost.descriptor });
  const rawParsed = await client.read({ transportId: launch.transportId, transportCorrelationId: launch.transportCorrelationId,
    bindingDigest: input.expected.bindingDigest, compiledInventoryDigest: input.expected.groupCompiledInventoryDigest,
    preparedEnvironmentDigest: input.expected.preparedEnvironmentDigest, launches: [...input.expected.launches].sort((a, b) => a.shardId.localeCompare(b.shardId)),
    caseCount: input.expected.caseCount,
    maxWireBytes: Math.min(26_214_400, e2eApplicationPrivateTransferMaxBytes(input.expected.caseCount, input.expected.launches.length)) }, input.signal);
  if (input.signal.aborted) throw new Error("installed supervisor proof read was cancelled and cannot be adopted");
  const parsedInput = E2EApplicationSupervisorReadbackSchema.parse(rawParsed);
  const parsed: E2EApplicationSupervisorReadback = Object.freeze({ schemaVersion: parsedInput.schemaVersion,
    receipt: Object.freeze({ ref: Object.freeze({ ...parsedInput.receipt.ref }), bytes: Uint8Array.from(parsedInput.receipt.bytes) }),
    evidence: Object.freeze(parsedInput.evidence.map((item) => Object.freeze({ ref: Object.freeze({ ...item.ref }), bytes: Uint8Array.from(item.bytes) }))) });
  const maxEvidenceEntries = e2eApplicationSupervisorEvidenceEntryMax(input.expected.caseCount);
  if (parsed.evidence.length > maxEvidenceEntries) throw new Error("installed supervisor proof byte inventory exceeds its exact global case bound");
  const totalBytes = parsed.receipt.bytes.byteLength + parsed.evidence.reduce((sum, item) => sum + item.bytes.byteLength, 0);
  const wireBytes = Buffer.byteLength(canonicalJson({ schemaVersion: parsed.schemaVersion,
    receipt: { ref: parsed.receipt.ref, bytesBase64: Buffer.from(parsed.receipt.bytes).toString("base64") },
    evidence: parsed.evidence.map((item) => ({ ref: item.ref, bytesBase64: Buffer.from(item.bytes).toString("base64") })) }));
  if (totalBytes > Math.min(26_214_400, e2eApplicationPrivateTransferMaxBytes(input.expected.caseCount, input.expected.launches.length))
    || wireBytes > Math.min(26_214_400, e2eApplicationPrivateTransferMaxBytes(input.expected.caseCount, input.expected.launches.length))) {
    throw new Error("installed supervisor proof channel exceeded its unchanged private transfer ceiling");
  }
  return parsed;
}

export async function installE2EApplicationCliBridge(input: { compiledShard: E2EApplicationCompiledShard; launchId: string; ownedDirectory: string }): Promise<void> {
  const registration = currentRegistration();
  if (!registration || registration.launch.launchId !== input.launchId || registration.launch.shardId !== input.compiledShard.shardId) throw new Error("application CLI bridge has no exact process-local host registration");
  const expected = new Map(input.compiledShard.expectedCases.map((item) => [item.caseId, item]));
  let active = false;
  const bridge = Object.freeze({ async runCase(caseId: string, fixtures: unknown): Promise<void> {
    if (active) throw new Error("application case bridge does not permit overlapping case execution");
    if (!expected.has(caseId)) throw new Error("application bridge received a case outside the exact compiled shard");
    if (Date.now() >= Date.parse(registration.launch.deadlineAt)) throw new Error("application case launch deadline elapsed");
    active = true;
    try { await registration.host.runCase(caseId, fixtures); } finally { active = false; }
  } });
  Object.defineProperty(globalThis, "__agentxE2EApplication", { value: bridge, configurable: false, enumerable: false, writable: false });
  void input.ownedDirectory;
}

type Declaration = {
  schemaVersion: "e2e-application-cli-declaration/v1"; projectId: string; testPath: string;
  target: z.infer<typeof E2EApplicationLaunchTargetSchema>;
  cliHost: { profileId: string; descriptor: { entryPointId: string; entryPointManifestDigest: string } };
  preparedEnvironmentDigest: string; originByApplicationId: Array<{ applicationId: string; origin: string }>;
  timeoutMs: number; modelRoute: null | { routeId: string; routeRevision: string }; expectedConfigDigest: string;
  cases: Array<{ caseId: string; upstreamTestId: string; targetId: string; assertionBindings: Array<{ index: number; kind: string; digest: string }> }>;
};

const declarationSchema = z.object({ schemaVersion: z.literal("e2e-application-cli-declaration/v1"), projectId: z.literal("rovara-application-e2e"),
  testPath: z.literal(APPLICATION_E2E_TEST_PATH), target: E2EApplicationLaunchTargetSchema,
  cliHost: z.object({ profileId: z.string().min(1).max(120), descriptor: E2EApplicationCliHostDescriptorSchema }).strict(),
  preparedEnvironmentDigest: z.string().regex(/^[a-f0-9]{64}$/), originByApplicationId: z.array(z.object({ applicationId: z.string().min(1).max(120),
    origin: z.string().url().max(512) }).strict()).max(12), timeoutMs: z.number().int().positive().max(300_000),
  modelRoute: z.object({ routeId: z.string().min(1).max(120), routeRevision: z.string().min(1).max(120) }).strict().nullable(),
  expectedConfigDigest: z.string().regex(/^[a-f0-9]{64}$/), cases: z.array(z.object({ caseId: z.string().min(1).max(160),
    upstreamTestId: z.string().min(1).max(2048), targetId: z.string().min(1).max(80), assertionBindings: z.array(z.object({
      index: z.number().int().min(0).max(19), kind: z.string().min(1).max(64), digest: z.string().regex(/^[a-f0-9]{64}$/),
    }).strict()).min(1).max(20) }).strict()).min(1).max(64) }).strict();
const inventorySidecarSchema = z.object({ schemaVersion: z.literal("e2e-application-cli-inventory/v1"), compiledInventoryDigest: z.string().regex(/^[a-f0-9]{64}$/),
  shardId: z.string().min(1).max(120), inventory: z.object({ schemaVersion: z.literal(1), compilerProtocol: z.literal("trusted-e2e-application-compiler/v1"),
    upstream: z.object({ package: z.literal("e2e"), version: z.literal("0.20.0"), idAlgorithm: z.literal("e2e-0.20.0-test-id-result-id/v1"),
      configDigestAlgorithm: z.literal("e2e-0.20.0-sanitized-config/v1"), expectedConfigDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    files: z.array(z.object({ path: z.string().min(1).max(2048), sha256: z.string().regex(/^[a-f0-9]{64}$/), byteLength: z.number().int().nonnegative().max(MAX_FILE),
      role: z.enum(["test", "config", "selection-packet", "declaration"]) }).strict()).min(1).max(512), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  selection: E2EApplicationSelectionPacketSchema, expectedCases: z.array(E2EExpectedCaseSchema).min(1).max(64) }).strict();
const hostRegistrySchema = z.object({ schemaVersion: z.literal("application-cli-host-registry/v1"),
  hosts: z.array(z.object({ profileId: z.string().min(1).max(120), entryPointId: z.string().min(1).max(120),
    entryPointManifestDigest: z.string().regex(/^[a-f0-9]{64}$/), modulePath: z.string().min(1).max(2048) }).strict()).max(12) }).strict()
  .superRefine((registry, context) => {
    if (new Set(registry.hosts.map((host) => host.profileId)).size !== registry.hosts.length) {
      context.addIssue({ code: "custom", path: ["hosts"], message: "installed host profile entries must be unique" });
    }
  });

export async function prepareE2EApplicationCliConfig(input: { configUrl: string }): Promise<E2EConfig> {
  const configPath = fileURLToPath(input.configUrl);
  const configRoot = dirname(configPath);
  if (basename(configPath) !== E2E_APPLICATION_GENERATED_CONFIG_PATH || await realpath(configPath) !== configPath) throw new Error("application config URL is not the generated owned config");
  const declarationPath = join(configRoot, E2E_APPLICATION_DECLARATION_PATH);
  const privateRoot = join(configRoot, ".agentx", "e2e");
  const launchPath = join(privateRoot, "application-cli-launch.json");
  const inventoryPath = join(privateRoot, "application-cli-inventory.json");
  const declarationBytes = await canonicalFile(declarationPath, configRoot, { requirePrivateMode: true });
  const launchBytes = await canonicalFile(launchPath, configRoot, { requirePrivateMode: true });
  const inventoryBytes = await canonicalFile(inventoryPath, configRoot, { requirePrivateMode: true });
  const declaration = declarationSchema.parse(json(declarationBytes)) as Declaration;
  const launch = launchSchema.parse(json(launchBytes)) as E2EApplicationCliLaunchContext;
  const inventory = inventorySidecarSchema.parse(json(inventoryBytes));
  const selectedPlatform = launch.selectedTarget.kind === "mobile" || launch.selectedTarget.kind === "desktop"
    ? launch.selectedTarget.os : launch.selectedTarget.kind;
  const selectedApplicationIdentityMatches = declaration.target.app === null
    ? declaration.originByApplicationId.some((item) => item.applicationId === launch.selectedTarget.applicationId)
    : declaration.target.app.identity === launch.selectedTarget.applicationId;
  if (declaration.schemaVersion !== "e2e-application-cli-declaration/v1" || declaration.cliHost.profileId !== launch.cliHost.profileId
    || canonicalJson(declaration.cliHost.descriptor) !== canonicalJson(launch.cliHost.descriptor) || inventory.schemaVersion !== "e2e-application-cli-inventory/v1"
    || inventory.compiledInventoryDigest !== launch.compiledInventoryDigest || inventory.shardId !== launch.shardId
    || launch.selectedTarget.targetId !== declaration.target.targetId || launch.selectedTarget.runtimeProfileId !== declaration.target.profileId
    || (declaration.target.engine === null ? launch.selectedTarget.kind !== "api" : selectedPlatform !== declaration.target.engine.platform)
    || !selectedApplicationIdentityMatches
    || declaration.cases.some((item) => item.targetId !== declaration.target.targetId)
    || new Set(declaration.cases.map((item) => item.caseId)).size !== declaration.cases.length
    || canonicalJson(declaration.cases.map((item) => item.caseId).sort()) !== canonicalJson(inventory.expectedCases.map((item) => item.caseId).sort())
    || inventory.expectedCases.some((item) => item.targetId !== launch.selectedTarget.targetId || item.accountProfileId !== launch.selectedTarget.accountProfileId)
    || canonicalJson(declaration.cases.map((item) => item.upstreamTestId).sort()) !== canonicalJson(inventory.selection.tuples.map((item) => item.upstreamTestId).sort())) throw new Error("application declaration, launch context and inventory disagree");
  const inv = inventory.inventory;
  const { digest, ...body } = inv;
  if (digest !== launch.compiledInventoryDigest || sha(canonicalJson(body)) !== digest) throw new Error("application compiled shard inventory digest is invalid");
  if (inv.upstream.expectedConfigDigest !== declaration.expectedConfigDigest
    || expectedE2EApplicationConfigDigest({ projectId: declaration.projectId, tests: [declaration.testPath], target: declaration.target,
      timeout: declaration.timeoutMs, modelRoute: declaration.modelRoute }) !== declaration.expectedConfigDigest) throw new Error("application config digest differs from its exact declaration and runner inventory");
  const files = inv.files;
  const fixedPaths: ReadonlySet<string> = new Set([E2E_APPLICATION_GENERATED_CONFIG_PATH, E2E_APPLICATION_DECLARATION_PATH, E2E_APPLICATION_SELECTION_PACKET_PATH]);
  const sourceFiles = new Map<string, string>();
  for (const file of files) {
    if (sourceFiles.has(file.path)) throw new Error("application compiler inventory repeats a path");
    if ((file.path === E2E_APPLICATION_GENERATED_CONFIG_PATH && file.role !== "config")
      || (file.path === E2E_APPLICATION_DECLARATION_PATH && file.role !== "declaration")
      || (file.path === E2E_APPLICATION_SELECTION_PACKET_PATH && file.role !== "selection-packet")
      || (!fixedPaths.has(file.path)
        && file.role !== "test")) throw new Error("application compiler inventory role differs from its fixed path");
    const absolute = resolve(configRoot, file.path);
    if (!inside(configRoot, absolute)) throw new Error("application compiler path escaped the owned root");
    const bytes = await canonicalFile(absolute, configRoot, { requirePrivateMode: true });
    if (bytes.byteLength !== file.byteLength || sha(bytes) !== file.sha256) throw new Error("application compiler file failed exact inventory verification");
    sourceFiles.set(file.path, bytes.toString("utf8"));
  }
  if (!sourceFiles.has(E2E_APPLICATION_GENERATED_CONFIG_PATH) || !sourceFiles.has(E2E_APPLICATION_DECLARATION_PATH)
    || !sourceFiles.has(E2E_APPLICATION_SELECTION_PACKET_PATH) || sourceFiles.size !== files.length
    || sourceFiles.get(E2E_APPLICATION_GENERATED_CONFIG_PATH) !== renderE2EApplicationConfigWrapper()
    || canonicalJson(JSON.parse(sourceFiles.get(E2E_APPLICATION_SELECTION_PACKET_PATH)!)) !== canonicalJson(inventory.selection)) {
    throw new Error("compiled application inventory omits or changes its exact config, declaration, or selection packet");
  }
  const expectedCases = z.array(E2EExpectedCaseSchema).min(1).max(64).parse(inventory.expectedCases);
  const selection = E2EApplicationSelectionPacketSchema.parse(inventory.selection);
  const selectionCases = selection.tuples.map((item) => ({ caseId: item.caseId, upstreamTestId: item.upstreamTestId }))
    .sort((a, b) => a.caseId.localeCompare(b.caseId));
  const declaredCases = declaration.cases.map((item) => ({ caseId: item.caseId, upstreamTestId: item.upstreamTestId }))
    .sort((a, b) => a.caseId.localeCompare(b.caseId));
  if (selection.shardId !== launch.shardId || selection.targetId !== declaration.target.targetId
    || declaration.cases.some((item) => {
      const expected = expectedCases.find((candidate) => candidate.caseId === item.caseId);
      return !expected || expected.upstreamTestId !== item.upstreamTestId || expected.targetId !== item.targetId
        || canonicalJson(expected.assertionDigests) !== canonicalJson(item.assertionBindings.map((binding) => binding.digest));
    }) || expectedCases.length !== declaration.cases.length || canonicalJson(selectionCases) !== canonicalJson(declaredCases)) {
    throw new Error("application sidecar expected cases, selection packet and assertion bindings disagree");
  }
  const registryPath = join(packageRoot(), HOSTS_REGISTRY);
  const registryRoot = packageRoot();
  const registryBytes = await canonicalFile(registryPath, registryRoot, { requireOwner: false });
  const registryValue = hostRegistrySchema.parse(json(registryBytes));
  const rows = registryValue.hosts;
  const matches = rows.filter((row) => row.profileId === launch.cliHost.profileId && row.entryPointId === launch.cliHost.descriptor.entryPointId
    && row.entryPointManifestDigest === launch.cliHost.descriptor.entryPointManifestDigest);
  if (matches.length !== 1) throw new Error("selected application CLI host profile is not registered in the installed verifier package");
  const hostRow = matches[0]!;
  if (hostRow.modulePath.startsWith("/") || hostRow.modulePath.includes("\\") || hostRow.modulePath.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("installed application host registry row has an unsafe module path");
  const hostModulePath = resolve(registryRoot, hostRow.modulePath);
  if (!inside(registryRoot, hostModulePath)) throw new Error("installed application host module escaped package root");
  const moduleBytes = await canonicalFile(hostModulePath, registryRoot, { requireOwner: false });
  if (sha(moduleBytes) !== hostRow.entryPointManifestDigest) throw new Error("installed application host module failed manifest digest verification");
  const mod = await import(pathToFileURL(hostModulePath).href) as { createE2EApplicationCliHost?: (input: { launchContext: E2EApplicationCliLaunchContext; declaration: Declaration }) => E2EApplicationCliHostFactoryResult };
  if (typeof mod.createE2EApplicationCliHost !== "function") throw new Error("installed application host entry point has no fixed host factory export");
  const host = mod.createE2EApplicationCliHost({ launchContext: launch, declaration });
  if (!host || host.profileId !== launch.cliHost.profileId || canonicalJson(host.descriptor) !== canonicalJson(launch.cliHost.descriptor)
    || typeof host.runCase !== "function" || (declaration.target.engine && !host.engine) || (!declaration.target.engine && host.engine)) throw new Error("installed application host factory returned a profile-incompatible host");
  const registeredHost: E2EApplicationCliHost = Object.freeze({ ...host, launchContext: launch, installedModule: hostModulePath });
  registerE2EApplicationCliHost(registeredHost);
  const shard: E2EApplicationCompiledShard = { shardId: launch.shardId, targetId: declaration.target.targetId,
    files: new Map([...sourceFiles].filter(([path]) => path !== E2E_APPLICATION_DECLARATION_PATH)),
    inventory: inv, expectedConfigDigest: declaration.expectedConfigDigest, selection, expectedCases };
  await installE2EApplicationCliBridge({ compiledShard: shard, launchId: launch.launchId, ownedDirectory: configRoot });
  const app = declaration.target.app === null ? undefined : declaration.target.app;
  const enginePlatform = declaration.target.engine?.platform;
  const target: E2EConfig["targets"][number] = { name: declaration.target.targetId, platform: enginePlatform ?? "api",
    ...(app ? { app } : {}), ...(host.engine ? { engine: host.engine } : {}) };
  const reporterPath = join(configRoot, "application-first-party-reporter.mjs");
  const reporterBytes = await canonicalFile(reporterPath, configRoot, { requirePrivateMode: true });
  if (sha(reporterBytes) !== expectedE2EApplicationReporterDigest(launch.launchId)) throw new Error("application first-party reporter differs from its launch-bound fixed asset");
  const reporterModule = await import(pathToFileURL(reporterPath).href) as { reporter?: Reporter };
  const reporter = reporterModule.reporter;
  if (!reporter || reporter.name !== "agentx-application-first-party-reporter/v1" || typeof reporter.onEvent !== "function") throw new Error("fixed application reporter asset has no valid reporter export");
  if (declaration.modelRoute && typeof host.modelFactory !== "function") throw new Error("governed model adapter is unavailable for the declared route");
  let model: ModelInstance | undefined;
  if (declaration.modelRoute) {
    const route = declaration.modelRoute;
    let resolved: ModelInstance | undefined;
    const getModel = () => {
      if (!resolved) {
        resolved = host.modelFactory!();
        if (resolved.provider !== "agentx-e2e" || resolved.modelId !== route.routeId || resolved.specificationVersion !== "v4") {
          resolved = undefined;
          throw new Error("installed host model adapter does not match the approved governed route");
        }
      }
      return resolved;
    };
    model = Object.freeze({ provider: "agentx-e2e", modelId: route.routeId, specificationVersion: "v4",
      doGenerate: (...args: never[]) => getModel().doGenerate(...args) });
  }
  const config: E2EConfig = { projectId: declaration.projectId, tests: [declaration.testPath], targets: [target], timeout: declaration.timeoutMs,
    workers: 1, retries: 0, cache: "off", reporters: [reporter], ...(model ? { agents: { default: { model } } } : {}) };
  return config;
}
