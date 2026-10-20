import { types } from "node:util";
import { createHash } from "node:crypto";
import { z } from "zod";
import { E2EApplicationApprovalBindingSchema, E2EApplicationBuildSourceManifestSchema,
  E2EApplicationBuildSourceRefSchema, E2EApplicationCliHostDescriptorSchema, E2EApplicationLaunchTargetSchema,
  E2EApplicationPreparedGroupFactsSchema, E2EAppArtifactRefSchema, E2EAppBuildManifestSchema,
  E2EApplicationPlanIntentSchema, E2EExecutionPlanSchema, E2ERuntimeCapabilityDescriptorSchema, E2EScenarioBundleSchema,
  E2ERegisteredRuntimeSchema, canonicalJson, copyBoundedE2EJsonData, copyBoundedE2ESourceBytes,
  e2eAppBuildManifestDigest, e2ePolicyDigest, e2eScenarioBundleDigest, selectE2EApplicationExecutionPlan,
  projectE2EApplicationPortableSelection, validateE2EAppBuildBinding, verifyE2ESourceSnapshot, E2EApplicationPortableProjectionSchema,
  E2EApplicationExecutionAdmissionSchema, E2EApplicationGroupAdmissionSchema, E2ERoundSchema, E2ERunBindingSchema,
  type CandidateManifest, type E2EApplicationApprovalBinding, type E2EApplicationBuildSourceManifest,
  type E2EApplicationBuildSourceRef, type E2EApplicationCliHostDescriptor, type E2EApplicationCompilationContext,
  type E2EApplicationLaunchTarget, type E2EApplicationPreparedGroupFacts, type E2EApplicationPlanSelectionInput,
  type E2EAppArtifactRef, type E2EAppBuildManifest, type E2EExecutionPlan, type E2EExpectedCase,
  type E2EApplicationPortableProjection, type E2EApplicationGroupAdmission, type E2ERound, type E2ERunBinding,
  type E2EApplicationExecutionAdmission,
  type E2ERegisteredRuntime, type E2EScenario, type E2EScenarioBundle, type E2ESourceSnapshot, type E2EPolicy } from "@agentx/contracts";
import { compileE2EScenarios } from "./scenarios.js";

export type { E2EApplicationCompilationContext };
import { validateE2EApplicationBuildSourceManifest } from "./application-build-source.js";
import { isPinnedRovaraHttpEngine } from "./rovara-http-engine-descriptor.js";
import { createE2EApplicationSelectionPacket, type E2EApplicationSourcePosition } from "./application-identity.js";
import { E2E_APPLICATION_DECLARATION_PATH, E2E_APPLICATION_GENERATED_CONFIG_PATH, E2E_APPLICATION_GROUP_COMPILER_PROTOCOL,
  E2E_APPLICATION_COMPILER_PROTOCOL, E2E_APPLICATION_SELECTION_PACKET_PATH, expectedE2EApplicationConfigDigest,
  renderE2EApplicationConfigWrapper, renderE2EApplicationDeclaration, renderE2EApplicationGeneratedTest,
  renderE2EApplicationSelectionPacket, type E2EApplicationCompiledFile, type E2EApplicationCompiledInventory } from "./application-templates.js";

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const applicationTestPath = ".agentx/e2e/generated-application.test.ts";
const groupInventoryProtocol = E2E_APPLICATION_GROUP_COMPILER_PROTOCOL;
const applicationModelRouteSchema = z.object({ routeId: z.string().trim().min(1).max(120), routeRevision: z.string().trim().min(1).max(120) }).strict().nullable();

export type E2EApplicationCompiledShard = Readonly<{
  shardId: string; targetId: string; files: ReadonlyMap<string, string>; inventory: E2EApplicationCompiledInventory;
  expectedConfigDigest: string; selection: ReturnType<typeof createE2EApplicationSelectionPacket>;
  expectedCases: readonly E2EExpectedCase[];
}>;
export type E2EApplicationCompiledGroupInventory = Readonly<{
  schemaVersion: 1; compilerProtocol: typeof groupInventoryProtocol; groupId: string;
  cliHost: { profileId: string; descriptor: E2EApplicationCliHostDescriptor }; preparedEnvironmentDigest: string;
  originByApplicationId: readonly { applicationId: string; origin: string }[];
  shards: readonly { shardId: string; targetId: string; inventoryDigest: string; expectedConfigDigest: string; expectedCaseIds: readonly string[] }[];
  groupConfigManifestDigest: string; digest: string;
}>;
export type E2ECompiledApplicationSuite = Readonly<{
  protocol: "trusted-e2e-application/v1"; bundle: E2EScenarioBundle;
  group: E2EExecutionPlan["groups"][number] & { mocks: readonly E2EExecutionPlan["mocks"][number][] };
  cliHost: { profileId: string; descriptor: E2EApplicationCliHostDescriptor };
  preparedEnvironmentDigest: string; originByApplicationId: readonly { applicationId: string; origin: string }[];
  files: ReadonlyMap<string, string>; inventory: E2EApplicationCompiledGroupInventory; groupConfigManifestDigest: string;
  shards: readonly E2EApplicationCompiledShard[]; expectedCases: readonly E2EExpectedCase[]; selectionPacketPath: string;
  applicationBindings: ReadonlyMap<string, { approval: E2EApplicationApprovalBinding; build: E2EAppBuildManifest; artifacts: readonly E2EAppArtifactRef[]; buildSource: { manifest: E2EApplicationBuildSourceManifest; reference: E2EApplicationBuildSourceRef } }>;
  runtimeBindings: ReadonlyMap<string, E2ERegisteredRuntime>; assertionBindings: ReadonlyMap<string, readonly { index: number; kind: string; digest: string }[]>;
  runtimeAdmissionContext: E2EApplicationCompilationContext; runtimeAdmission: Readonly<{ schemaVersion: "e2e-application-compiled-admission/v1";
    expectedCandidate: CandidateManifest; sourceSnapshot: E2ESourceSnapshot; sourceSnapshotDigest: string; contextDigest: string;
    bundleDigest: string; compiledInventoryDigest: string; applicationBindingsDigest: string; runtimeBindingsDigest: string;
    launchTargetsDigest: string; assertionBindingsDigest: string }>;
}>;

function ordinaryRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError(`${label} must be an ordinary record`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))) throw new TypeError(`${label} has unknown keys`);
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of ownKeys as string[]) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) throw new TypeError(`${label} must contain enumerable data properties only`);
    result[key] = descriptor.value as unknown;
  }
  return result;
}
function ordinaryArray<T>(value: unknown, max: number, label: string, copy: (entry: unknown) => T): T[] {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError(`${label} must be an ordinary array`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (!lengthDescriptor || !("value" in lengthDescriptor) || typeof lengthDescriptor.value !== "number") throw new TypeError(`${label} must expose an ordinary array length`);
  const length = lengthDescriptor.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > max || Reflect.ownKeys(descriptors).some((key) => key !== "length" && (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= length))) throw new TypeError(`${label} is outside its own-data bound`);
  return Array.from({ length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) throw new TypeError(`${label} must contain dense data entries`);
    return copy(descriptor.value as unknown);
  });
}
function bounded<T>(value: T, maxBytes = 1_048_576): T {
  return copyBoundedE2EJsonData(value, { maxBytes, maxDepth: 64 }) as T;
}
function snapshotCopy(value: unknown): E2ESourceSnapshot {
  const snapshot = ordinaryRecord(value, ["candidate", "commitSha", "treeSha", "treeComplete", "treePaths", "sources"], "application source snapshot");
  const candidate = bounded(snapshot.candidate, 262_144) as CandidateManifest;
  const treePaths = ordinaryArray(snapshot.treePaths, 100_000, "application source tree paths", (path) => bounded(path, 2048) as string);
  const sources = ordinaryArray(snapshot.sources, 512, "application source blobs", (raw) => {
    const source = ordinaryRecord(raw, ["path", "sha256", "bytes", "kind"], "application source blob");
    const kind = parseSourceKind(source.kind);
    return { path: bounded(source.path, 2048) as string, sha256: bounded(source.sha256, 128) as string,
      bytes: copyBoundedE2ESourceBytes(source.bytes, 512 * 1024), kind };
  });
  if (snapshot.treeComplete !== true || typeof snapshot.commitSha !== "string" || typeof snapshot.treeSha !== "string") throw new TypeError("application source snapshot identity is invalid");
  return { candidate, commitSha: snapshot.commitSha, treeSha: snapshot.treeSha, treeComplete: true, treePaths, sources };
}
function parseSourceKind(value: unknown): "blob" | "symlink" | "submodule" {
  if (value !== "blob" && value !== "symlink" && value !== "submodule") throw new TypeError("application source kind is invalid");
  return value;
}
function snapshotCopyFromWireOrBytes(value: unknown): E2ESourceSnapshot {
  const raw = ordinaryRecord(value, ["candidate", "commitSha", "treeSha", "treeComplete", "treePaths", "sources"], "portable projection source snapshot");
  const firstSourceDescriptor = Array.isArray(raw.sources) ? Object.getOwnPropertyDescriptor(raw.sources, "0") : undefined;
  const firstSource = firstSourceDescriptor && "value" in firstSourceDescriptor ? firstSourceDescriptor.value as unknown : undefined;
  if (firstSource && typeof firstSource === "object" && !ArrayBuffer.isView(firstSource)
    && "bytesBase64" in firstSource) return snapshotFromWire(value);
  return snapshotCopy(value);
}
function snapshotToWire(snapshot: E2ESourceSnapshot): unknown {
  return { candidate: snapshot.candidate, commitSha: snapshot.commitSha, treeSha: snapshot.treeSha, treeComplete: true,
    treePaths: snapshot.treePaths, sources: snapshot.sources.map((source) => {
      if (source.kind !== "blob") throw new Error("portable projection source wire format only permits inspected blobs");
      return { path: source.path, sha256: source.sha256, bytesBase64: Buffer.from(source.bytes).toString("base64"), kind: "blob" };
    }) };
}
function portableProjectionToWire(projection: E2EApplicationPortableProjection): unknown {
  const selection = ordinaryRecord(projection.selectionInput, ["candidateDigest", "expectedCandidate", "sourceSnapshot", "planDigest", "policy", "scenarios",
    "selectedTargetIds", "sandboxAvailability", "runtimeAvailability", "portableApprovalBinding", "approvedSemanticApproval", "mockableComponents"], "portable projection selection input");
  return { scope: projection.scope, selectionInput: { ...selection, sourceSnapshot: snapshotToWire(snapshotCopy(projection.selectionInput.sourceSnapshot)) },
    executionPlan: projection.executionPlan, bundle: projection.bundle };
}
function portableProjectionCopy(value: unknown): E2EApplicationPortableProjection {
  const raw = ordinaryRecord(value, ["scope", "selectionInput", "executionPlan", "bundle"], "portable application projection");
  const selection = ordinaryRecord(raw.selectionInput, ["candidateDigest", "expectedCandidate", "sourceSnapshot", "planDigest", "policy", "scenarios",
    "selectedTargetIds", "sandboxAvailability", "runtimeAvailability", "portableApprovalBinding", "approvedSemanticApproval", "mockableComponents"], "portable projection selection input");
  const selectionInput: Record<string, unknown> = {
    candidateDigest: bounded(selection.candidateDigest, 128), expectedCandidate: bounded(selection.expectedCandidate, 262_144),
    sourceSnapshot: snapshotCopyFromWireOrBytes(selection.sourceSnapshot), planDigest: bounded(selection.planDigest, 128),
    policy: bounded(selection.policy), scenarios: bounded(selection.scenarios), selectedTargetIds: bounded(selection.selectedTargetIds),
    sandboxAvailability: bounded(selection.sandboxAvailability), runtimeAvailability: bounded(selection.runtimeAvailability),
  };
  for (const key of ["portableApprovalBinding", "approvedSemanticApproval", "mockableComponents"] as const) {
    if (selection[key] !== undefined) selectionInput[key] = bounded(selection[key]);
  }
  return E2EApplicationPortableProjectionSchema.parse({ scope: bounded(raw.scope), selectionInput,
    executionPlan: bounded(raw.executionPlan, 2 * 1024 * 1024), bundle: bounded(raw.bundle, 2 * 1024 * 1024) }) as E2EApplicationPortableProjection;
}
function mapCopy<K extends string, V>(input: unknown, max: number, label: string, copy: (value: unknown) => V): Map<K, V> {
  if (!(input instanceof Map) || types.isProxy(input) || input.size > max) throw new TypeError(`${label} must be an ordinary bounded Map`);
  const result = new Map<K, V>();
  for (const [key, value] of input.entries()) {
    if (typeof key !== "string" || key.length === 0 || result.has(key as K)) throw new TypeError(`${label} keys must be unique strings`);
    result.set(key as K, copy(value));
  }
  return result;
}
function snapshotDigest(snapshot: E2ESourceSnapshot): string {
  const hash = createHash("sha256");
  hash.update(canonicalJson({ candidate: snapshot.candidate, commitSha: snapshot.commitSha, treeSha: snapshot.treeSha, treeComplete: true }));
  for (const path of [...snapshot.treePaths].sort()) hash.update(`\0tree\0${path}`);
  for (const source of [...snapshot.sources].sort((a, b) => a.path.localeCompare(b.path))) hash.update(`\0source\0${source.path}\0${source.kind}\0${source.sha256}\0${sha256(source.bytes)}`);
  return hash.digest("hex");
}
function selectedContextCopy(input: unknown): E2EApplicationCompilationContext {
  const context = ordinaryRecord(input, ["selectionInput", "executionPlan", "bundle", "applicationBindings", "runtimeBindings", "launchTargets", "modelRoute", "cliHostsByProfile", "preparedEnvironmentsByGroup"], "application compilation context");
  const selectionRaw = ordinaryRecord(context.selectionInput, ["candidateDigest", "expectedCandidate", "sourceSnapshot", "planDigest", "policy", "scenarios", "selectedTargetIds", "sandboxAvailability", "runtimeAvailability", "portableApprovalBinding", "approvedSemanticApproval", "mockableComponents", "intent", "intentDigest", "setupProposal", "setupApproval", "applicationApprovalBinding", "registeredRuntimes", "runtimeAccountRefs", "now"], "application selection input");
  const selectionInput = { ...selectionRaw, expectedCandidate: bounded(selectionRaw.expectedCandidate, 262_144), sourceSnapshot: snapshotCopy(selectionRaw.sourceSnapshot),
    policy: bounded(selectionRaw.policy), scenarios: bounded(selectionRaw.scenarios), selectedTargetIds: bounded(selectionRaw.selectedTargetIds),
    sandboxAvailability: bounded(selectionRaw.sandboxAvailability), runtimeAvailability: bounded(selectionRaw.runtimeAvailability),
    ...(selectionRaw.portableApprovalBinding === undefined ? {} : { portableApprovalBinding: bounded(selectionRaw.portableApprovalBinding) }),
    approvedSemanticApproval: bounded(selectionRaw.approvedSemanticApproval),
    ...(selectionRaw.mockableComponents === undefined ? {} : { mockableComponents: bounded(selectionRaw.mockableComponents) }),
    intent: E2EApplicationPlanIntentSchema.parse(bounded(selectionRaw.intent)),
    intentDigest: bounded(selectionRaw.intentDigest), setupProposal: bounded(selectionRaw.setupProposal), setupApproval: bounded(selectionRaw.setupApproval),
    applicationApprovalBinding: bounded(selectionRaw.applicationApprovalBinding), registeredRuntimes: bounded(selectionRaw.registeredRuntimes),
    runtimeAccountRefs: bounded(selectionRaw.runtimeAccountRefs), now: selectionRaw.now } as E2EApplicationPlanSelectionInput;
  const applicationBindings = mapCopy(context.applicationBindings, 12, "application build bindings", (raw) => {
    const item = ordinaryRecord(raw, ["approval", "build", "artifacts", "buildSource"], "application build binding value");
    const buildSource = ordinaryRecord(item.buildSource, ["manifest", "reference"], "application build-source binding");
    return { approval: E2EApplicationApprovalBindingSchema.parse(bounded(item.approval)), build: E2EAppBuildManifestSchema.parse(bounded(item.build)),
      artifacts: ordinaryArray(item.artifacts, 32, "application artifacts", (artifact) => E2EAppArtifactRefSchema.parse(bounded(artifact))),
      buildSource: { manifest: E2EApplicationBuildSourceManifestSchema.parse(bounded(buildSource.manifest)), reference: E2EApplicationBuildSourceRefSchema.parse(bounded(buildSource.reference)) } };
  });
  const runtimeBindings = mapCopy(context.runtimeBindings, 12, "application runtime bindings", (raw) => E2ERegisteredRuntimeSchema.parse(bounded(raw)));
  const launchTargets = ordinaryArray(context.launchTargets, 12, "application launch targets", (raw) => E2EApplicationLaunchTargetSchema.parse(bounded(raw)));
  const cliHostsByProfile = mapCopy(context.cliHostsByProfile, 12, "application CLI hosts", (raw) => E2EApplicationCliHostDescriptorSchema.parse(bounded(raw)));
  const preparedEnvironmentsByGroup = mapCopy(context.preparedEnvironmentsByGroup, 4, "application prepared environments", (raw) => E2EApplicationPreparedGroupFactsSchema.parse(bounded(raw)));
  const modelRoute = applicationModelRouteSchema.parse(bounded(context.modelRoute));
  return { selectionInput, executionPlan: E2EExecutionPlanSchema.parse(bounded(context.executionPlan)), bundle: E2EScenarioBundleSchema.parse(bounded(context.bundle)),
    applicationBindings, runtimeBindings, launchTargets, modelRoute, cliHostsByProfile, preparedEnvironmentsByGroup };
}

function identityPlatform(target: E2EExecutionPlan["effectiveTargets"][number]): string {
  if (target.kind === "mobile" || target.kind === "desktop") return target.os;
  return target.kind;
}
function assertionDigests(scenario: E2EScenario): Array<{ index: number; kind: string; digest: string }> {
  return scenario.assertions.map((assertion, index) => ({ index, kind: assertion.kind, digest: sha256(canonicalJson([assertion])) }));
}
export function validateE2EApplicationLaunchTarget(target: E2EExecutionPlan["effectiveTargets"][number], launch: E2EApplicationLaunchTarget,
  runtime: E2ERegisteredRuntime, capture: E2EApplicationPlanSelectionInput["policy"]["capture"]): void {
  if (launch.targetId !== target.targetId || launch.profileId !== target.runtimeProfileId || runtime.profileId !== target.runtimeProfileId
    || launch.factoryManifestDigest !== runtime.manifestDigest) throw new Error("application launch target differs from its source target or installed runtime descriptor");
  const capability = E2ERuntimeCapabilityDescriptorSchema.parse(runtime.capabilities);
  const expectedArtifacts = [capture.screenshots ? "screenshot" : null, capture.video ? "video" : null].filter((item): item is "screenshot" | "video" => item !== null);
  // An API target runs on Rovara's own HTTP engine, which has no state hook: its `state` assertions are the runtime's approved probes,
  // so the engine's state capability is false whatever assertions the runtime supports.
  const expectedState = target.kind === "api" && launch.engine !== null ? false : capability.supportedAssertions.includes("state");
  if (canonicalJson(launch.artifactCapabilities) !== canonicalJson(expectedArtifacts) || launch.stateCapability !== expectedState) {
    throw new Error("application launch artifact or state capabilities differ from the approved capture policy and installed runtime");
  }
  if (target.kind === "api") {
    // Engine-less, or exactly Rovara's pinned HTTP engine that the runtime profile also advertises; no other engine, and never an app.
    if (launch.app !== null || capability.kind !== "api" || (launch.engine !== null && (!isPinnedRovaraHttpEngine(launch.engine)
      || launch.engine.name !== capability.engine.name || launch.engine.version !== capability.engine.version || launch.engine.spiVersion !== capability.engine.spiVersion))) {
      throw new Error("API application target must be engine-less or use Rovara's pinned HTTP engine, and stay app-less");
    }
  } else {
    if (launch.engine === null || launch.app === null) throw new Error("UI application target requires its real installed engine and application identity");
    if (launch.engine.name !== capability.engine.name || launch.engine.version !== capability.engine.version || launch.engine.spiVersion !== capability.engine.spiVersion
      || launch.engine.platform !== identityPlatform(target) || !launch.engine.capabilities.every((item, index, list) => index === 0 || list[index - 1]! < item)) throw new Error("application engine declaration differs from the installed runtime identity or target platform");
    if (launch.app.identity.length === 0 || launch.app.environment !== "test") throw new Error("application launch identity is missing or not test-scoped");
    if (launch.app.identity !== target.applicationId) throw new Error("application launch identity differs from the selected source application");
    if (target.kind === "web") {
      if (capability.kind !== "web" || !capability.browsers.includes(target.browser)) throw new Error("web launch descriptor does not support the selected source browser");
    } else if (target.kind === "mobile") {
      if (capability.kind !== target.os || capability.os !== target.os || !capability.deviceProfileIds.includes(target.deviceProfileId)
        || launch.app.bundleId !== target.appId) throw new Error("mobile launch descriptor does not bind the selected source bundle and device profile");
    } else if (target.kind === "desktop") {
      const expectedKind = target.driver === "electron" ? "electron" : "native-desktop";
      if (capability.kind !== expectedKind || capability.os !== target.os || capability.driver !== target.driver
        || launch.app.bundleId !== target.appId) throw new Error("desktop launch descriptor does not bind the selected source bundle, OS, and driver");
    }
    if (launch.engine.capabilities.length < 2 || !launch.engine.capabilities.includes("actions") || !launch.engine.capabilities.includes("observation")) {
      throw new Error("application engine is missing required action or observation capabilities");
    }
    // The runner computes an engine's `artifacts` and `state` capabilities from the hooks it carries, and the executor carries only what the admission allows, so the
    // declared list names them exactly when the declared artifact and state capabilities do.
    if (target.kind === "web" && (launch.engine.capabilities.includes("artifacts") !== (launch.artifactCapabilities.length > 0)
      || launch.engine.capabilities.includes("state") !== launch.stateCapability)) {
      throw new Error("application engine capabilities differ from the declared artifact and state capabilities");
    }
  }
}
function validateBindings(context: E2EApplicationCompilationContext, plan: E2EExecutionPlan, snapshot: E2ESourceSnapshot): {
  appGroups: E2EExecutionPlan["groups"]; applicationBindings: E2EApplicationCompilationContext["applicationBindings"];
  runtimeBindings: E2EApplicationCompilationContext["runtimeBindings"]; targetById: Map<string, E2EExecutionPlan["effectiveTargets"][number]>;
  launchById: Map<string, E2EApplicationLaunchTarget>; cliByProfile: Map<string, E2EApplicationCliHostDescriptor>;
  preparedByGroup: Map<string, E2EApplicationPreparedGroupFacts>;
} {
  const appGroups = plan.groups.filter((group) => group.mode === "real-runtime" || group.mode === "hybrid");
  const targetById = new Map(plan.effectiveTargets.map((target) => [target.targetId, target]));
  const runnableTargetIds = [...new Set(appGroups.flatMap((group) => group.targetIds))].sort();
  const appIds = [...new Set(runnableTargetIds.map((targetId) => targetById.get(targetId)!.applicationId))].sort();
  if (canonicalJson([...context.applicationBindings.keys()].sort()) !== canonicalJson(appIds)) throw new Error("application build binding map does not exactly cover runnable application groups");
  for (const applicationId of appIds) {
    const binding = context.applicationBindings.get(applicationId)!;
    if (!context.selectionInput.applicationApprovalBinding
      || canonicalJson(binding.approval) !== canonicalJson(context.selectionInput.applicationApprovalBinding)) {
      throw new Error("application build binding approval differs from the exact selected application approval");
    }
    if (binding.approval.applications.some((app) => app.applicationId === applicationId) === false) throw new Error("application build binding lacks its exact approval identity");
    const valid = validateE2EAppBuildBinding({ finalSnapshot: snapshot, binding: binding.approval, manifest: binding.build, artifacts: [...binding.artifacts] });
    if (valid.applicationId !== applicationId || binding.build.manifestDigest !== e2eAppBuildManifestDigest(binding.build)) throw new Error("application output build binding is invalid");
    validateE2EApplicationBuildSourceManifest({ manifest: binding.buildSource.manifest, reference: binding.buildSource.reference,
      expectedCandidate: context.selectionInput.expectedCandidate, inspectionSnapshot: snapshot });
    if (binding.buildSource.manifest.candidateDigest !== snapshot.candidate.digest) throw new Error("application build source is from another candidate");
  }
  const profileIds = [...new Set(appGroups.map((group) => targetById.get(group.targetIds[0]!)!.runtimeProfileId))].sort();
  if (appGroups.some((group) => new Set(group.targetIds.map((targetId) => targetById.get(targetId)!.runtimeProfileId)).size !== 1)
    || canonicalJson([...context.cliHostsByProfile.keys()].sort()) !== canonicalJson(profileIds)) throw new Error("application groups must be homogeneous by profile and have exactly one installed CLI host descriptor per runnable profile");
  const groupIds = appGroups.map((group) => group.groupId).sort();
  if (canonicalJson([...context.preparedEnvironmentsByGroup.keys()].sort()) !== canonicalJson(groupIds)) throw new Error("prepared environment facts must exactly cover runnable application groups");
  const launchTargets = [...context.launchTargets].sort((a, b) => a.targetId.localeCompare(b.targetId));
  if (canonicalJson(launchTargets.map((item) => item.targetId)) !== canonicalJson(runnableTargetIds)) throw new Error("application launch targets must exactly cover runnable targets");
  const runtimeRefs = new Map(context.selectionInput.intent.applicationRuntimeRefs.map((item) => [item.targetId, item]));
  for (const targetId of runnableTargetIds) {
    const target = targetById.get(targetId)!;
    const ref = runtimeRefs.get(targetId);
    const runtime = context.runtimeBindings.get(target.runtimeProfileId);
    const launch = context.launchTargets.find((item) => item.targetId === targetId)!;
    if (!ref || ref.applicationId !== target.applicationId || ref.runtimeProfileId !== target.runtimeProfileId || !runtime) throw new Error("runnable application target has no exact assignment or registered runtime profile");
    validateE2EApplicationLaunchTarget(target, launch, runtime, context.selectionInput.policy.capture);
  }
  if (context.runtimeBindings.size !== profileIds.length || [...context.runtimeBindings.keys()].some((id) => !profileIds.includes(id))) throw new Error("runtime binding map contains a missing or foreign profile");
  const selectedRuntimeRows = context.selectionInput.registeredRuntimes.filter((runtime) => profileIds.includes(runtime.profileId));
  if (new Set(selectedRuntimeRows.map((runtime) => runtime.profileId)).size !== selectedRuntimeRows.length) {
    throw new Error("selection input contains an ambiguous registered runtime profile");
  }
  const selectedRuntimeByProfile = new Map(selectedRuntimeRows.map((runtime) => [runtime.profileId, runtime]));
  for (const profileId of profileIds) {
    const selectedRuntime = selectedRuntimeByProfile.get(profileId);
    const suppliedRuntime = context.runtimeBindings.get(profileId);
    if (!selectedRuntime || !suppliedRuntime || canonicalJson(selectedRuntime) !== canonicalJson(suppliedRuntime)) {
      throw new Error("runtime binding differs from the exact selected registered runtime row");
    }
  }
  for (const group of appGroups) {
    const facts = context.preparedEnvironmentsByGroup.get(group.groupId)!;
    const targetSet = group.targetIds.map((targetId) => targetById.get(targetId)!);
    const ownedAppIds = [...new Set(targetSet.filter((target) => target.kind === "web" || target.kind === "api").map((target) => target.applicationId))].sort();
    if (canonicalJson(facts.originByApplicationId.map((item) => item.applicationId)) !== canonicalJson(ownedAppIds)) throw new Error("prepared origin map must include exactly the group-owned web and API applications");
    for (const target of targetSet.filter((item) => item.kind === "web")) {
      const origin = facts.originByApplicationId.find((item) => item.applicationId === target.applicationId)?.origin;
      const launch = context.launchTargets.find((item) => item.targetId === target.targetId);
      if (!origin || launch?.app?.url !== origin) throw new Error("prepared web origin differs from its fixed application launch origin");
    }
  }
  return { appGroups, applicationBindings: context.applicationBindings, runtimeBindings: context.runtimeBindings, targetById,
    launchById: new Map(context.launchTargets.map((item) => [item.targetId, item])), cliByProfile: new Map(context.cliHostsByProfile),
    preparedByGroup: new Map(context.preparedEnvironmentsByGroup) };
}

function shardId(groupId: string, targetId: string): string { return `shard-${sha256(canonicalJson([groupId, targetId])).slice(0, 32)}`; }
function emitInventory(files: ReadonlyMap<string, string>, expectedConfigDigest: string): E2EApplicationCompiledInventory {
  const inventoryFiles: E2EApplicationCompiledFile[] = [...files].map(([path, content]) => Object.freeze({ path, sha256: sha256(content), byteLength: Buffer.byteLength(content),
    role: path === applicationTestPath ? "test" : path === E2E_APPLICATION_GENERATED_CONFIG_PATH ? "config" : path === E2E_APPLICATION_SELECTION_PACKET_PATH ? "selection-packet" : "declaration" }));
  const body = { schemaVersion: 1 as const, compilerProtocol: E2E_APPLICATION_COMPILER_PROTOCOL,
    upstream: { package: "e2e" as const, version: "0.20.0" as const, idAlgorithm: "e2e-0.20.0-test-id-result-id/v1" as const,
      configDigestAlgorithm: "e2e-0.20.0-sanitized-config/v1" as const, expectedConfigDigest }, files: inventoryFiles };
  return Object.freeze({ ...body, files: Object.freeze(inventoryFiles), digest: sha256(canonicalJson(body)) });
}
function verifyShard(shard: E2EApplicationCompiledShard): void {
  if (shard.inventory.compilerProtocol !== E2E_APPLICATION_COMPILER_PROTOCOL || shard.inventory.upstream.version !== "0.20.0"
    || shard.inventory.upstream.expectedConfigDigest !== shard.expectedConfigDigest) throw new Error("application shard inventory has an unsupported compiler or upstream identity");
  const expected = [...shard.files].map(([path, content]) => ({ path, sha256: sha256(content), byteLength: Buffer.byteLength(content) })).sort((a, b) => a.path.localeCompare(b.path));
  const actual = [...shard.inventory.files].map(({ path, sha256: hash, byteLength }) => ({ path, sha256: hash, byteLength })).sort((a, b) => a.path.localeCompare(b.path));
  if (canonicalJson(expected) !== canonicalJson(actual) || sha256(canonicalJson({ schemaVersion: shard.inventory.schemaVersion,
    compilerProtocol: shard.inventory.compilerProtocol, upstream: shard.inventory.upstream, files: shard.inventory.files })) !== shard.inventory.digest) throw new Error("application shard generated-file inventory changed");
}

function compileGroup(context: E2EApplicationCompilationContext, group: E2EExecutionPlan["groups"][number],
  index: ReturnType<typeof validateBindings>): E2ECompiledApplicationSuite {
  const targetIds = [...group.targetIds].sort();
  if (targetIds.length < 1 || targetIds.length > 3 || group.expectedCases.length === 0 || group.expectedCases.length > 64) throw new Error("application group has no cases or exceeds its approved limits");
  const profileId = index.targetById.get(targetIds[0]!)!.runtimeProfileId;
  if (targetIds.some((targetId) => index.targetById.get(targetId)?.runtimeProfileId !== profileId)) throw new Error("application group mixes runtime profiles");
  const cliDescriptor = index.cliByProfile.get(profileId);
  if (!cliDescriptor) throw new Error("application group has no exact installed CLI host descriptor");
  const cliHost = { profileId, descriptor: E2EApplicationCliHostDescriptorSchema.parse(cliDescriptor) };
  const prepared = index.preparedByGroup.get(group.groupId);
  if (!prepared) throw new Error("application group has no protected prepared environment facts");
  const targetById = index.targetById;
  const groupCases = group.expectedCases;
  const scenarios = context.bundle.scenarios;
  const assertionBindings = new Map<string, readonly { index: number; kind: string; digest: string }[]>();
  for (const expected of groupCases) {
    const scenario = scenarios.find((item) => item.scenarioId === expected.scenarioId);
    if (!scenario || !scenario.assertions.length || expected.assertionDigests.length !== scenario.assertions.length) throw new Error("application expected case lacks its exact approved scenario assertions");
    const bindings = assertionDigests(scenario);
    if (canonicalJson(bindings.map((item) => item.digest)) !== canonicalJson(expected.assertionDigests)) throw new Error("application case assertion digests do not match the compiled source scenario");
    assertionBindings.set(expected.caseId, Object.freeze(bindings));
  }
  const shards: E2EApplicationCompiledShard[] = [];
  for (const targetId of targetIds) {
    const target = targetById.get(targetId)!;
    const launchTarget = index.launchById.get(targetId)!;
    const expectedCases = groupCases.filter((item) => item.targetId === targetId);
    if (expectedCases.length === 0) throw new Error("application target shard has no exact assigned cases");
    const ids = new Set(expectedCases.map((item) => item.caseId));
    const caseScenarios = scenarios.filter((scenario) => expectedCases.some((item) => item.scenarioId === scenario.scenarioId));
    const timeoutMs = Math.min(...expectedCases.map(() => context.selectionInput.policy.limits.caseTimeoutMs), context.selectionInput.policy.limits.runTimeoutMs);
    const groupUsesModel = caseScenarios.some((scenario) => scenario.steps.some((step) => step.kind === "agent"));
    const modelRoute = groupUsesModel ? context.modelRoute : null;
    if (groupUsesModel && (!modelRoute || modelRoute.routeRevision !== context.selectionInput.policy.modelRouteRevision)) throw new Error("agent-bearing application group has no exact approved model route metadata");
    const tests = renderE2EApplicationGeneratedTest({ cases: expectedCases, scenarios: caseScenarios, timeoutMs, assertionsByCase: assertionBindings });
    const configDigest = expectedE2EApplicationConfigDigest({ projectId: "rovara-application-e2e", tests: [applicationTestPath], target: launchTarget,
      timeout: timeoutMs, modelRoute });
    const sourceByCaseId = new Map<string, E2EApplicationSourcePosition>();
    const lines = tests.split("\n");
    expectedCases.forEach((item) => {
      const title = item.upstreamTestId.slice(item.upstreamTestId.lastIndexOf("::") + 2);
      const indexLine = lines.findIndex((line) => line.startsWith(`test(${JSON.stringify(title)},`));
      if (indexLine < 0) throw new Error("generated application test source position could not be derived");
      // The installed 0.20 runner reports the original generated source's
      // one-based line, including the declaration-only global block.
      sourceByCaseId.set(item.caseId, { file: applicationTestPath, line: indexLine + 1, column: 1 });
    });
    const titleByCaseId = new Map(expectedCases.map((item) => [item.caseId, item.upstreamTestId.slice(item.upstreamTestId.lastIndexOf("::") + 2)]));
    const packet = createE2EApplicationSelectionPacket({ plan: context.executionPlan, groupId: group.groupId, shardId: shardId(group.groupId, targetId), targetId,
      targetPlatform: identityPlatform(target), titleByCaseId, sourceByCaseId });
    if (packet.tuples.length !== ids.size) throw new Error("application shard public-list packet does not cover its exact case set");
    const files = new Map<string, string>([
      [applicationTestPath, tests], [E2E_APPLICATION_GENERATED_CONFIG_PATH, renderE2EApplicationConfigWrapper()],
      [E2E_APPLICATION_SELECTION_PACKET_PATH, renderE2EApplicationSelectionPacket(packet)],
      [E2E_APPLICATION_DECLARATION_PATH, renderE2EApplicationDeclaration({ target: launchTarget, cliHost,
        preparedEnvironmentDigest: prepared.preparedEnvironmentDigest, originByApplicationId: prepared.originByApplicationId,
        timeoutMs, modelRoute, expectedConfigDigest: configDigest, cases: expectedCases, assertionsByCase: assertionBindings })],
    ]);
    const inventory = emitInventory(files, configDigest);
    const shard: E2EApplicationCompiledShard = Object.freeze({ shardId: shardId(group.groupId, targetId), targetId, files,
      inventory, expectedConfigDigest: configDigest, selection: packet, expectedCases: Object.freeze(expectedCases) });
    verifyShard(shard);
    shards.push(shard);
  }
  const expectedCases = shards.flatMap((shard) => shard.expectedCases);
  if (expectedCases.length !== groupCases.length || new Set(expectedCases.map((item) => item.caseId)).size !== expectedCases.length
    || canonicalJson([...expectedCases.map((item) => item.caseId)].sort()) !== canonicalJson([...groupCases.map((item) => item.caseId)].sort())) throw new Error("application target shards do not partition the complete group case set");
  const manifestRows = shards.map((shard) => ({ shardId: shard.shardId, targetId: shard.targetId, expectedConfigDigest: shard.expectedConfigDigest }));
  const groupConfigManifestDigest = sha256(canonicalJson(manifestRows));
  const files = new Map<string, string>();
  for (const shard of shards) for (const [path, content] of shard.files) files.set(`shards/${shard.shardId}/${path}`, content);
  const body = { schemaVersion: 1 as const, compilerProtocol: groupInventoryProtocol, groupId: group.groupId, cliHost,
    preparedEnvironmentDigest: prepared.preparedEnvironmentDigest, originByApplicationId: prepared.originByApplicationId,
    shards: shards.map((shard) => ({ shardId: shard.shardId, targetId: shard.targetId, inventoryDigest: shard.inventory.digest,
      expectedConfigDigest: shard.expectedConfigDigest, expectedCaseIds: shard.expectedCases.map((item) => item.caseId) })), groupConfigManifestDigest };
  const inventory: E2EApplicationCompiledGroupInventory = Object.freeze({ ...body, digest: sha256(canonicalJson(body)) });
  const groupMocks = context.executionPlan.mocks.filter((mock) => group.targetIds.includes(mock.effectiveTargetId));
  const bindingsDigest = sha256(canonicalJson([...context.applicationBindings].sort(([a], [b]) => a.localeCompare(b))));
  const runtimeDigest = sha256(canonicalJson([...context.runtimeBindings].sort(([a], [b]) => a.localeCompare(b))));
  const launchDigest = sha256(canonicalJson(context.launchTargets));
  const assertionDigest = sha256(canonicalJson([...assertionBindings].sort(([a], [b]) => a.localeCompare(b))));
  const contextDigest = sha256(canonicalJson({ selectionInput: { ...context.selectionInput, sourceSnapshot: undefined }, executionPlan: context.executionPlan,
    bundle: context.bundle, applicationBindings: [...context.applicationBindings], runtimeBindings: [...context.runtimeBindings], launchTargets: context.launchTargets,
    modelRoute: context.modelRoute, cliHostsByProfile: [...context.cliHostsByProfile], preparedEnvironmentsByGroup: [...context.preparedEnvironmentsByGroup] }));
  const snapshot = context.selectionInput.sourceSnapshot;
  const runtimeAdmission = Object.freeze({ schemaVersion: "e2e-application-compiled-admission/v1" as const,
    expectedCandidate: context.selectionInput.expectedCandidate, sourceSnapshot: snapshot, sourceSnapshotDigest: snapshotDigest(snapshot), contextDigest,
    bundleDigest: context.bundle.bundleDigest, compiledInventoryDigest: inventory.digest, applicationBindingsDigest: bindingsDigest,
    runtimeBindingsDigest: runtimeDigest, launchTargetsDigest: launchDigest, assertionBindingsDigest: assertionDigest });
  return Object.freeze({ protocol: "trusted-e2e-application/v1", bundle: context.bundle,
    group: Object.freeze({ ...group, mocks: Object.freeze(groupMocks) }), cliHost, preparedEnvironmentDigest: prepared.preparedEnvironmentDigest,
    originByApplicationId: Object.freeze([...prepared.originByApplicationId]), files, inventory, groupConfigManifestDigest,
    shards: Object.freeze(shards), expectedCases: Object.freeze(expectedCases), selectionPacketPath: `shards/${shards[0]!.shardId}/${E2E_APPLICATION_SELECTION_PACKET_PATH}`,
    applicationBindings: context.applicationBindings, runtimeBindings: context.runtimeBindings,
    assertionBindings, runtimeAdmissionContext: context, runtimeAdmission });
}

export function compileE2EApplicationScenarios(input: { context: E2EApplicationCompilationContext; groupId: string }): E2ECompiledApplicationSuite {
  const envelope = ordinaryRecord(input, ["context", "groupId"], "application compilation request");
  if (typeof envelope.groupId !== "string") throw new TypeError("application group ID is invalid");
  const context = selectedContextCopy(envelope.context);
  verifyE2ESourceSnapshot(context.selectionInput.sourceSnapshot, context.selectionInput.expectedCandidate);
  const derivedPlan = E2EExecutionPlanSchema.parse(selectE2EApplicationExecutionPlan(context.selectionInput));
  if (canonicalJson(derivedPlan) !== canonicalJson(context.executionPlan)) throw new Error("application execution plan differs from fresh complete selector derivation");
  if (canonicalJson(context.bundle.scenarios) !== canonicalJson(context.selectionInput.intent.scenarios)
    || context.bundle.planDigest !== context.selectionInput.planDigest || context.bundle.templateVersion !== "trusted-e2e-application/v1"
    || context.bundle.bundleDigest !== e2eScenarioBundleDigest(context.bundle)) throw new Error("application scenario bundle differs from its complete approved intent and full plan");
  const portable = projectE2EApplicationPortableSelection(context.selectionInput);
  if (portable && portable.selectionInput.policy.modelRouteRevision !== null) throw new Error("portable child selection must retain the canonical model-free policy projection");
  const index = validateBindings(context, derivedPlan, context.selectionInput.sourceSnapshot);
  const group = derivedPlan.groups.find((item) => item.groupId === envelope.groupId);
  if (!group || (group.mode !== "real-runtime" && group.mode !== "hybrid")) throw new Error("application group is absent or is not a runnable real-application group");
  return compileGroup(context, group, index);
}

export function validateE2ECompiledApplicationAdmission(compiled: E2ECompiledApplicationSuite, snapshotInput: unknown): E2ESourceSnapshot {
  const admission = compiled?.runtimeAdmission;
  if (!admission || admission.schemaVersion !== "e2e-application-compiled-admission/v1") throw new Error("compiled application suite has no compiler-origin admission record");
  const snapshot = snapshotCopy(snapshotInput);
  verifyE2ESourceSnapshot(snapshot, admission.expectedCandidate);
  if (snapshotDigest(snapshot) !== admission.sourceSnapshotDigest || snapshotDigest(admission.sourceSnapshot) !== admission.sourceSnapshotDigest) throw new Error("application candidate inspection snapshot changed after compiler admission");
  if (compiled.bundle.bundleDigest !== admission.bundleDigest || compiled.inventory.digest !== admission.compiledInventoryDigest
    || compiled.inventory.digest !== sha256(canonicalJson(Object.fromEntries(Object.entries(compiled.inventory).filter(([key]) => key !== "digest"))))) throw new Error("application generated group inventory or bundle changed after compilation");
  for (const shard of compiled.shards) verifyShard(shard);
  const recompilation = compileE2EApplicationScenarios({ context: compiled.runtimeAdmissionContext, groupId: compiled.group.groupId });
  const mapEntries = <K, V>(value: ReadonlyMap<K, V>) => [...value.entries()];
  const admissionFacts = (suite: E2ECompiledApplicationSuite) => ({ schemaVersion: suite.runtimeAdmission.schemaVersion,
    expectedCandidate: suite.runtimeAdmission.expectedCandidate, sourceSnapshotDigest: suite.runtimeAdmission.sourceSnapshotDigest,
    contextDigest: suite.runtimeAdmission.contextDigest, bundleDigest: suite.runtimeAdmission.bundleDigest,
    compiledInventoryDigest: suite.runtimeAdmission.compiledInventoryDigest, applicationBindingsDigest: suite.runtimeAdmission.applicationBindingsDigest,
    runtimeBindingsDigest: suite.runtimeAdmission.runtimeBindingsDigest, launchTargetsDigest: suite.runtimeAdmission.launchTargetsDigest,
    assertionBindingsDigest: suite.runtimeAdmission.assertionBindingsDigest });
  const shardFacts = (suite: E2ECompiledApplicationSuite) => suite.shards.map((shard) => ({ shardId: shard.shardId, targetId: shard.targetId,
    files: mapEntries(shard.files), inventory: shard.inventory, expectedConfigDigest: shard.expectedConfigDigest,
    selection: shard.selection, expectedCases: shard.expectedCases }));
  if (recompilation.inventory.digest !== compiled.inventory.digest || canonicalJson(recompilation.inventory) !== canonicalJson(compiled.inventory)
    || canonicalJson([...recompilation.files]) !== canonicalJson([...compiled.files])
    || canonicalJson(recompilation.bundle) !== canonicalJson(compiled.bundle)
    || canonicalJson(admissionFacts(recompilation)) !== canonicalJson(admissionFacts(compiled))
    || canonicalJson(recompilation.group) !== canonicalJson(compiled.group)
    || canonicalJson(recompilation.cliHost) !== canonicalJson(compiled.cliHost)
    || recompilation.preparedEnvironmentDigest !== compiled.preparedEnvironmentDigest
    || canonicalJson(recompilation.originByApplicationId) !== canonicalJson(compiled.originByApplicationId)
    || recompilation.groupConfigManifestDigest !== compiled.groupConfigManifestDigest
    || canonicalJson(recompilation.expectedCases) !== canonicalJson(compiled.expectedCases)
    || canonicalJson(shardFacts(recompilation)) !== canonicalJson(shardFacts(compiled))
    || canonicalJson(mapEntries(recompilation.applicationBindings)) !== canonicalJson(mapEntries(compiled.applicationBindings))
    || canonicalJson(mapEntries(recompilation.runtimeBindings)) !== canonicalJson(mapEntries(compiled.runtimeBindings))
    || canonicalJson(mapEntries(recompilation.assertionBindings)) !== canonicalJson(mapEntries(compiled.assertionBindings))
    || recompilation.selectionPacketPath !== compiled.selectionPacketPath
    || admission.contextDigest !== recompilation.runtimeAdmission.contextDigest || admission.applicationBindingsDigest !== recompilation.runtimeAdmission.applicationBindingsDigest
    || admission.runtimeBindingsDigest !== recompilation.runtimeAdmission.runtimeBindingsDigest || admission.launchTargetsDigest !== recompilation.runtimeAdmission.launchTargetsDigest
    || admission.assertionBindingsDigest !== recompilation.runtimeAdmission.assertionBindingsDigest) throw new Error("compiled application files, bindings, or launch context differ from fresh compiler derivation");
  return snapshot;
}

export function createE2EApplicationPortableChildBindings(input: {
  projection: E2EApplicationPortableProjection; outerRound: E2ERound; outerPlan: E2EExecutionPlan;
  childRoundId: string; childRunIdsByGroup: ReadonlyMap<string, string>;
}): { childRound: E2ERound; mappings: readonly Extract<E2EApplicationGroupAdmission, { protocol: "trusted-e2e/v1" }>[] } {
  const envelope = ordinaryRecord(input, ["projection", "outerRound", "outerPlan", "childRoundId", "childRunIdsByGroup"], "portable child mapping request");
  const projection = portableProjectionCopy(envelope.projection);
  const outerRound = E2ERoundSchema.parse(bounded(envelope.outerRound, 1_048_576));
  const outerPlan = E2EExecutionPlanSchema.parse(bounded(envelope.outerPlan, 2 * 1024 * 1024));
  if (typeof envelope.childRoundId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(envelope.childRoundId)
    || envelope.childRoundId === outerRound.roundId) throw new Error("portable child round requires a fresh version-4 UUID");
  if (projection.scope.candidateDigest !== outerRound.groupBindings[0]?.candidateDigest
    || projection.scope.planDigest !== outerRound.groupBindings[0]?.planDigest || outerRound.executionPlanDigest !== outerPlan.digest
    || projection.bundle.planDigest !== projection.scope.planDigest || projection.bundle.bundleDigest !== e2eScenarioBundleDigest(projection.bundle)
    || projection.bundle.templateVersion !== "trusted-e2e/v1" || projection.selectionInput.candidateDigest !== projection.scope.candidateDigest
    || projection.selectionInput.planDigest !== projection.scope.planDigest || projection.selectionInput.policy.modelRouteRevision !== null) {
    throw new Error("portable child projection differs from its approved outer candidate, plan, or model-free bundle");
  }
  const projectedPlan = E2EExecutionPlanSchema.parse(projection.executionPlan);
  if (projectedPlan.candidateDigest !== projection.scope.candidateDigest) throw new Error("portable child plan identity is inconsistent");
  const projectedGroups = [...projectedPlan.groups].sort((a, b) => a.groupId.localeCompare(b.groupId));
  const outerGroups = [...outerPlan.groups].sort((a, b) => a.groupId.localeCompare(b.groupId));
  const outerBindings = [...outerRound.groupBindings].sort((a, b) => a.groupId.localeCompare(b.groupId));
  if (outerGroups.length !== outerBindings.length || outerGroups.some((group, index) => group.groupId !== outerBindings[index]?.groupId)) {
    throw new Error("outer round must bind every and only runnable group in the combined plan");
  }
  const portableIds = projectedGroups.map((group) => group.groupId);
  const rawMap = envelope.childRunIdsByGroup;
  if (!(rawMap instanceof Map) || types.isProxy(rawMap) || rawMap.size !== portableIds.length) throw new Error("portable child run ID map must exactly cover projected groups");
  const childRunIds = new Map<string, string>();
  for (const [groupId, runId] of rawMap.entries()) {
    if (typeof groupId !== "string" || typeof runId !== "string" || childRunIds.has(groupId)
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)
      || runId === outerRound.roundId || outerRound.groupBindings.some((binding) => binding.runId === runId)) throw new Error("portable child run IDs must be fresh unique version-4 UUIDs");
    childRunIds.set(groupId, runId);
  }
  if (canonicalJson([...childRunIds.keys()].sort()) !== canonicalJson(portableIds) || new Set(childRunIds.values()).size !== childRunIds.size) throw new Error("portable child run ID map has a missing, duplicate, or foreign group");
  const portablePolicyDigest = e2ePolicyDigest(projection.selectionInput.policy);
  const mappings: Extract<E2EApplicationGroupAdmission, { protocol: "trusted-e2e/v1" }>[] = [];
  const childBindings: E2ERunBinding[] = [];
  const projectionDigest = sha256(canonicalJson(portableProjectionToWire(projection)));
  for (const group of projectedGroups) {
    const outerGroup = outerGroups.find((item) => item.groupId === group.groupId);
    const outerBinding = outerRound.groupBindings.find((item) => item.groupId === group.groupId);
    if (!outerGroup || !outerBinding || canonicalJson(outerGroup) !== canonicalJson(group)
      || canonicalJson(outerBinding.expectedCases) !== canonicalJson(group.expectedCases)
      || outerBinding.executionMode !== group.mode || outerBinding.mockManifestDigest !== group.mockManifestDigest) throw new Error("portable projection changed an outer group, case, mode, or mock identity");
    const compiled = compileE2EScenarios(projection.bundle, projectedPlan.effectiveTargets, group, {
      selectionInput: projection.selectionInput, executionPlan: projectedPlan, group,
    });
    if (canonicalJson(compiled.expectedCases) !== canonicalJson(group.expectedCases)) throw new Error("portable child compiler changed projected expected cases");
    const childBinding = E2ERunBindingSchema.parse({ ...outerBinding, runId: childRunIds.get(group.groupId), roundId: envelope.childRoundId,
      executionPlanDigest: projectedPlan.digest, policyDigest: portablePolicyDigest, bundleDigest: projection.bundle.bundleDigest, modelRouteRevision: null });
    childBindings.push(childBinding);
    mappings.push(E2EApplicationGroupAdmissionSchema.parse({ protocol: "trusted-e2e/v1", outerBinding, childBinding,
      childRound: { ...outerRound, roundId: envelope.childRoundId, executionPlanDigest: projectedPlan.digest, groupBindings: [] },
      projectionDigest, compiledInventoryDigest: compiled.inventory.digest }) as Extract<E2EApplicationGroupAdmission, { protocol: "trusted-e2e/v1" }>);
  }
  const childRound = E2ERoundSchema.parse({ ...outerRound, roundId: envelope.childRoundId, executionPlanDigest: projectedPlan.digest,
    groupBindings: childBindings });
  const finalizedMappings = mappings.map((mapping) => E2EApplicationGroupAdmissionSchema.parse({ ...mapping, childRound }) as Extract<E2EApplicationGroupAdmission, { protocol: "trusted-e2e/v1" }>);
  return { childRound, mappings: Object.freeze(finalizedMappings) };
}

export type ValidatedE2EApplicationAdmission = Readonly<{
  admission: E2EApplicationExecutionAdmission; sourceSnapshot: E2ESourceSnapshot; executionPlan: E2EExecutionPlan;
  applicationSuites: readonly E2ECompiledApplicationSuite[];
  portableSuites: readonly ReturnType<typeof compileE2EScenarios>[];
}>;

export function assertE2EApplicationRoundWithinPolicy(round: E2ERound, policy: E2EPolicy): void {
  const boundedLimitKeys = ["runTimeoutMs", "startupTimeoutMs", "preparationTimeoutMs", "caseTimeoutMs", "maxActionsPerCase",
    "maxModelRequests", "maxInputTokens", "maxOutputTokens"] as const;
  if (boundedLimitKeys.some((key) => round.limits[key] > policy.limits[key])
    || (policy.limits.maxSpendUsd !== null && (round.limits.maxSpendUsd === null || round.limits.maxSpendUsd > policy.limits.maxSpendUsd))
    || Date.parse(round.deadlineAt) - Date.parse(round.admittedAt) > policy.limits.runTimeoutMs) {
    throw new Error("application admission round limits widen the approved policy or elapsed-time allowance");
  }
}

function snapshotFromWire(value: unknown): E2ESourceSnapshot {
  const raw = ordinaryRecord(value, ["candidate", "commitSha", "treeSha", "treeComplete", "treePaths", "sources"], "application admission source snapshot");
  const sources = ordinaryArray(raw.sources, 512, "application admission source blobs", (entry) => {
    const item = ordinaryRecord(entry, ["path", "sha256", "bytesBase64", "kind"], "application admission source blob");
    if (item.kind !== "blob" || typeof item.bytesBase64 !== "string") throw new Error("application admission source bytes have an invalid wire shape");
    const bytes = Buffer.from(item.bytesBase64, "base64");
    if (bytes.toString("base64") !== item.bytesBase64 || bytes.byteLength > 512 * 1024) throw new Error("application admission source bytes are not canonical bounded base64");
    return { path: item.path as string, sha256: item.sha256 as string, bytes, kind: "blob" as const };
  });
  return snapshotCopy({ ...raw, sources });
}

export function encodeE2EApplicationExecutionAdmission(admissionInput: E2EApplicationExecutionAdmission): string {
  const admission = E2EApplicationExecutionAdmissionSchema.parse(copyBoundedE2EJsonData(admissionInput, { maxBytes: 16 * 1024 * 1024, maxDepth: 64 }));
  return canonicalJson(admission);
}

export function decodeE2EApplicationExecutionAdmission(bytes: string | Uint8Array): E2EApplicationExecutionAdmission {
  const rawBytes = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : copyBoundedE2ESourceBytes(bytes, 16 * 1024 * 1024);
  if (rawBytes.byteLength > 16 * 1024 * 1024) throw new Error("application admission exceeds the private transfer ceiling");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(rawBytes); } catch { throw new Error("application admission is not valid UTF-8"); }
  let value: unknown;
  try { value = JSON.parse(text) as unknown; } catch { throw new Error("application admission is not valid JSON"); }
  const admission = E2EApplicationExecutionAdmissionSchema.parse(copyBoundedE2EJsonData(value, { maxBytes: 16 * 1024 * 1024, maxDepth: 64 }));
  if (canonicalJson(admission) !== text) throw new Error("application admission is not canonical JSON");
  return admission;
}

export function validateE2EApplicationExecutionAdmission(admissionInput: unknown): ValidatedE2EApplicationAdmission {
  const admission = E2EApplicationExecutionAdmissionSchema.parse(copyBoundedE2EJsonData(admissionInput, { maxBytes: 16 * 1024 * 1024, maxDepth: 64 }));
  const sourceSnapshot = snapshotFromWire(admission.sourceSnapshot);
  verifyE2ESourceSnapshot(sourceSnapshot, admission.selectionInput.expectedCandidate);
  const selectedSnapshot = snapshotFromWire(admission.selectionInput.sourceSnapshot);
  if (snapshotDigest(sourceSnapshot) !== snapshotDigest(selectedSnapshot)
    || canonicalJson(admission.intent) !== canonicalJson(admission.selectionInput.intent)
    || admission.intentDigest !== admission.selectionInput.intentDigest
    || canonicalJson(admission.applicationApprovalBinding) !== canonicalJson(admission.selectionInput.applicationApprovalBinding)
    || admission.candidateDigest !== sourceSnapshot.candidate.digest
    || canonicalJson(admission.policy) !== canonicalJson(admission.selectionInput.policy)
    || admission.intentDigest !== sha256(canonicalJson(admission.intent))) throw new Error("application admission changes its protected candidate, intent, approval, or policy identity");
  const selectionInput = { ...admission.selectionInput, sourceSnapshot } as unknown as E2EApplicationPlanSelectionInput;
  assertE2EApplicationRoundWithinPolicy(admission.round, admission.policy);
  const executionPlan = E2EExecutionPlanSchema.parse(selectE2EApplicationExecutionPlan(selectionInput));
  if (canonicalJson(executionPlan) !== canonicalJson(admission.executionPlan)) throw new Error("application admission plan differs from fresh complete selection derivation");
  const bundle = E2EScenarioBundleSchema.parse(admission.bundle);
  if (bundle.templateVersion !== "trusted-e2e-application/v1" || bundle.planDigest !== selectionInput.planDigest
    || canonicalJson(bundle.scenarios) !== canonicalJson(selectionInput.intent.scenarios) || bundle.bundleDigest !== e2eScenarioBundleDigest(bundle)) {
    throw new Error("application admission full bundle differs from its complete approved intent");
  }
  const applicationBindings = new Map(admission.applicationBindings.map(({ key, value }) => [key, value]));
  const runtimeBindings = new Map(admission.runtimeBindings.map(({ key, value }) => [key, value]));
  const launchTargets = admission.launchTargets;
  const cliHostsByProfile = new Map(admission.cliHosts.map(({ profileId, descriptor }) => [profileId, descriptor]));
  const preparedEnvironmentsByGroup = new Map(admission.preparedEnvironments.map(({ groupId, ...facts }) => [groupId, facts]));
  const context = { selectionInput, executionPlan, bundle, applicationBindings, runtimeBindings, launchTargets,
    modelRoute: admission.modelRoute, cliHostsByProfile, preparedEnvironmentsByGroup } as E2EApplicationCompilationContext;
  const runnableApplicationGroups = executionPlan.groups.filter((group) => group.mode === "real-runtime" || group.mode === "hybrid");
  const appAdmissions = admission.groups.filter((group) => group.protocol === "trusted-e2e-application/v1");
  const portableAdmissions = admission.groups.filter((group) => group.protocol === "trusted-e2e/v1");
  if (appAdmissions.length !== runnableApplicationGroups.length || appAdmissions.some((group) => !runnableApplicationGroups.some((planGroup) => planGroup.groupId === group.outerBinding.groupId))) {
    throw new Error("application admission does not exactly cover runnable application groups");
  }
  const applicationSuites = runnableApplicationGroups.map((group) => {
    const compiled = compileE2EApplicationScenarios({ context, groupId: group.groupId });
    const admitted = appAdmissions.find((item) => item.outerBinding.groupId === group.groupId)!;
    const outerBinding = admission.round.groupBindings.find((item) => item.groupId === group.groupId);
    const cliHost = admission.cliHosts.find((item) => item.profileId === compiled.cliHost.profileId);
    if (!outerBinding || canonicalJson(admitted.outerBinding) !== canonicalJson(outerBinding)
      || outerBinding.executionPlanDigest !== executionPlan.digest || outerBinding.executionMode !== group.mode
      || outerBinding.mockManifestDigest !== group.mockManifestDigest || canonicalJson(outerBinding.expectedCases) !== canonicalJson(group.expectedCases)
      || outerBinding.appBuildDigest !== sha256(canonicalJson(compiled.inventory))
      || outerBinding.environmentDigest !== compiled.preparedEnvironmentDigest
      || outerBinding.runtimeManifestDigest !== runtimeBindings.get(compiled.cliHost.profileId)?.manifestDigest
      || canonicalJson(admitted.cliHost) !== canonicalJson({ profileId: compiled.cliHost.profileId, descriptor: cliHost?.descriptor })
      || admitted.preparedEnvironmentDigest !== compiled.preparedEnvironmentDigest
      || canonicalJson(admitted.originByApplicationId) !== canonicalJson(compiled.originByApplicationId)
      || admitted.compiledInventoryDigest !== compiled.inventory.digest
      || canonicalJson(admitted.shards) !== canonicalJson(compiled.inventory.shards.map((shard) => ({ shardId: shard.shardId, targetId: shard.targetId,
        inventoryDigest: shard.inventoryDigest, configDigest: shard.expectedConfigDigest, expectedCaseIds: [...shard.expectedCaseIds] })))) {
      throw new Error("application admission group differs from fresh shard compilation, host descriptor, or prepared facts");
    }
    return compiled;
  });
  const portableProjection = projectE2EApplicationPortableSelection(selectionInput);
  if (canonicalJson(portableProjection ? portableProjectionToWire(portableProjection) : null) !== canonicalJson(admission.portableProjection)) throw new Error("portable child projection differs from fresh model-free selector derivation");
  const portableSuites: ReturnType<typeof compileE2EScenarios>[] = [];
  if (portableProjection) {
    if (portableAdmissions.length !== portableProjection.executionPlan.groups.length || portableAdmissions.length === 0) throw new Error("portable child admission does not cover every projected group");
    const first = portableAdmissions[0]!;
    if (portableAdmissions.some((item) => canonicalJson(item.childRound) !== canonicalJson(first.childRound))) throw new Error("portable group admissions disagree on the shared child round");
    const childRunIdsByGroup = new Map(portableAdmissions.map((item) => [item.childBinding.groupId, item.childBinding.runId]));
    const mapping = createE2EApplicationPortableChildBindings({ projection: portableProjection, outerRound: admission.round, outerPlan: executionPlan,
      childRoundId: first.childRound.roundId, childRunIdsByGroup });
    if (canonicalJson(mapping.childRound) !== canonicalJson(first.childRound) || canonicalJson(mapping.mappings) !== canonicalJson(portableAdmissions)) {
      throw new Error("portable child bindings or round differ from fresh exact mapping derivation");
    }
    for (const group of portableProjection.executionPlan.groups) portableSuites.push(compileE2EScenarios(portableProjection.bundle,
      portableProjection.executionPlan.effectiveTargets, group, { selectionInput: portableProjection.selectionInput,
        executionPlan: portableProjection.executionPlan, group }));
  } else if (portableAdmissions.length !== 0) throw new Error("portable child admissions exist without an approved projection");
  if (admission.round.executionPlanDigest !== executionPlan.digest || admission.round.taskId !== admission.taskId
    || admission.round.operationId !== admission.operationId || admission.round.operationFence !== admission.operationFence
    || admission.round.workflowRevision !== admission.workflowRevision
    || admission.round.groupBindings.some((binding) => binding.taskId !== admission.taskId || binding.operationId !== admission.operationId
      || binding.operationFence !== admission.operationFence || binding.workflowRevision !== admission.workflowRevision
      || binding.candidateDigest !== admission.candidateDigest || binding.planDigest !== selectionInput.planDigest
      || binding.policyDigest !== e2ePolicyDigest(admission.policy) || binding.bundleDigest !== bundle.bundleDigest
      || binding.modelRouteRevision !== admission.policy.modelRouteRevision)) throw new Error("application admission round or group binding differs from its workflow identity, combined plan, or full policy");
  return Object.freeze({ admission, sourceSnapshot, executionPlan, applicationSuites: Object.freeze(applicationSuites), portableSuites: Object.freeze(portableSuites) });
}
