import { types } from "node:util";
import { E2EScenarioBundleSchema, E2EExecutionGroupSchema, E2EExecutionPlanSchema, E2EPortableApprovalBindingSchema, canonicalJson, copyBoundedE2EJsonData, copyBoundedE2ESourceBytes, inspectE2EPortableSource, inspectE2ERepository, selectE2EExecutionPlan, verifyE2ESourceSnapshot, type CandidateManifest, type E2EExecutionPlan, type E2EExpectedCase, type E2EPolicy, type E2EScenario, type E2EScenarioBundle, type E2ESourceSnapshot, type E2EPlanSelectionInput } from "@agentx/contracts";
import { type E2ECompiledInventory } from "./identity.js";
import { emitE2ECompilationFiles, e2ePortableOperationDescriptorDigest, type E2EOperationRegistration } from "./templates.js";
import { assertPlanSubset } from "./selection.js";

export type E2EImmutableCompilationContext = Readonly<{
  selectionInput: E2EPlanSelectionInput;
  executionPlan: E2EExecutionPlan;
  group: E2EExecutionPlan["groups"][number];
}>;
export type E2ECompiledSuite = Readonly<{ bundle: E2EScenarioBundle; files: ReadonlyMap<string, string>; inventory: E2ECompiledInventory; expectedConfigDigest: string; expectedCases: readonly E2EExpectedCase[]; caseBindings: ReadonlyMap<string, { compilerCaseIdentity: string; candidateResponseScope: string; requestProtocol: string; operationId: string; accountProfileId: string; requestedTargetId: string; packageExportSubpath: string; moduleSpecifier: string; callableSelector: E2EOperationRegistration["callableSelector"]; descriptorDigest: string }>; selectionPacketPath: string }>;

export function compileE2EScenarios(bundleInput: E2EScenarioBundle, effectiveTargetsInput: E2EExecutionPlan["effectiveTargets"], groupInput: E2EExecutionPlan["groups"][number], contextInput: E2EImmutableCompilationContext): E2ECompiledSuite {
  const bundle = E2EScenarioBundleSchema.parse(copyBoundedE2EJsonData(bundleInput, { maxBytes: 262_144, maxDepth: 64 }));
  const context = copyCompilationContext(contextInput);
  const selection = context.selectionInput;
  const expectedCandidate: CandidateManifest = selection.expectedCandidate;
  const sourceSnapshot: E2ESourceSnapshot = selection.sourceSnapshot;
  verifyE2ESourceSnapshot(sourceSnapshot, expectedCandidate);
  const effectiveTargets = copyBoundedE2EJsonData(effectiveTargetsInput, { maxBytes: 262_144, maxDepth: 64 }) as E2EExecutionPlan["effectiveTargets"];
  const group = E2EExecutionGroupSchema.parse(copyBoundedE2EJsonData(groupInput, { maxBytes: 262_144, maxDepth: 64 }));
  if (canonicalJson(context.group) !== canonicalJson(group)) throw new Error("compilation context group and explicit group must be exact equal data");
  if (selection.candidateDigest !== expectedCandidate.digest || bundle.planDigest !== selection.planDigest || canonicalJson(bundle.scenarios) !== canonicalJson(selection.scenarios)) throw new Error("bundle does not match the approved candidate and plan assignments");
  const binding = E2EPortableApprovalBindingSchema.parse(selection.portableApprovalBinding);
  if (canonicalJson(binding.semanticApproval) !== canonicalJson(selection.approvedSemanticApproval)) throw new Error("planner input approval identity differs from its portable registration binding");
  const discovered = inspectE2ERepository(sourceSnapshot, expectedCandidate);
  const operations = new Map(discovered.portableOperations.map((operation) => [operation.operationId, operation]));
  const snapshotSources = new Map(sourceSnapshot.sources.map((item) => [item.path, item]));
  for (const registration of binding.operations) {
    const operation = operations.get(registration.operationId);
    if (!operation || operation.applicationId !== registration.applicationId || operation.exportName !== registration.packageExportSubpath || canonicalJson(operation.sourceRefs) !== canonicalJson(registration.sourceRefs)) throw new Error("registered operation identity is not in the verified source inventory");
    const manifest = snapshotSources.get(operation.manifestPath);
    const source = operation.sourceRefs.map((ref) => snapshotSources.get(ref.path)).find((item) => item !== undefined);
    if (!manifest || !source) throw new Error("registered operation has no verified manifest or source reference");
    const manifestData = JSON.parse(Buffer.from(manifest.bytes).toString("utf8")) as { exports?: unknown };
    const packageExports = manifestData.exports;
    const exportTarget = packageExports !== null && typeof packageExports === "object" ? (packageExports as Record<string, unknown>)[registration.packageExportSubpath] : undefined;
    const packageDirectory = operation.manifestPath.includes("/") ? operation.manifestPath.slice(0, operation.manifestPath.lastIndexOf("/")) : ".";
    const derivedSpecifier = packageDirectory === "." ? `./${source.path}` : `./${source.path.slice(packageDirectory.length + 1)}`;
    if (typeof exportTarget !== "string" || exportTarget !== derivedSpecifier || registration.moduleSpecifier !== exportTarget) throw new Error("package subpath, module source, and actual manifest export target do not agree");
    const descriptor = Object.fromEntries(Object.entries(registration).filter(([key]) => key !== "descriptorDigest"));
    if (registration.descriptorDigest !== e2ePortableOperationDescriptorDigest(descriptor as Omit<E2EOperationRegistration, "descriptorDigest">)) throw new Error("operation descriptor digest does not bind the verified source and response protocol identities");
    if (registration.purpose === "feature-invocation") {
      const inspected = inspectE2EPortableSource(Buffer.from(source.bytes).toString("utf8"), source.path);
      const selector = registration.callableSelector;
      const exportName = selector === null ? "" : selector.kind === "default" ? "default" : selector.exportName;
      if (!inspected.parseable || inspected.exports.find((item) => item.name === exportName)?.kind !== "callable") throw new Error(`registered callable selector is not a source-validated callable capability: ${source.path} ${JSON.stringify(inspected)}`);
    } else {
      const inspected = inspectE2EPortableSource(Buffer.from(source.bytes).toString("utf8"), source.path);
      if (!inspected.parseable || canonicalJson(inspected.exports.map((item) => item.name).sort()) !== canonicalJson([...(registration.expectedExportNames ?? [])].sort())) throw new Error("source-interface export names do not match the verified source module inventory");
    }
  }
  const derivedPlan = E2EExecutionPlanSchema.parse(selectE2EExecutionPlan(selection));
  if (canonicalJson(derivedPlan) !== canonicalJson(E2EExecutionPlanSchema.parse(context.executionPlan))) throw new Error("supplied execution plan differs from fresh shared planner derivation");
  assertPlanSubset(derivedPlan, effectiveTargets, group);
  const assignedGroup = derivedPlan.groups.find((candidate) => candidate.groupId === group.groupId)!;
  const ids = new Set(assignedGroup.expectedCases.map((item) => item.scenarioId));
  const scenarios = bundle.scenarios.filter((scenario) => ids.has(scenario.scenarioId));
  const emitted = emitE2ECompilationFiles({ expectedCases: assignedGroup.expectedCases, scenarios, group: assignedGroup, plan: derivedPlan, bundleDigest: bundle.bundleDigest, registrations: binding.operations, runTimeoutMs: selection.policy.limits.runTimeoutMs, caseTimeoutMs: selection.policy.limits.caseTimeoutMs });
  return Object.freeze({ bundle, files: emitted.files, inventory: emitted.inventory, expectedConfigDigest: emitted.expectedConfigDigest, expectedCases: Object.freeze([...assignedGroup.expectedCases]), caseBindings: emitted.caseBindings, selectionPacketPath: ".agentx/e2e/selection-packet.json" });
}

function copyRecord(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || types.isProxy(value) || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError(`${label} must be an ordinary record`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string" || !allowed.includes(key))) throw new TypeError(`${label} has unknown keys`);
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) throw new TypeError(`${label} must contain enumerable data properties only`);
    result[key] = descriptor.value;
  }
  return result;
}
function copyOwnArray(value: unknown, maxLength: number, label: string): unknown[] {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError(`${label} must be an ordinary array`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (!lengthDescriptor || typeof lengthDescriptor.value !== "number" || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 || lengthDescriptor.value > maxLength) throw new TypeError(`${label} is outside its length bound`);
  const length = lengthDescriptor.value;
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || key !== "length" && (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= length))) throw new TypeError(`${label} contains extra properties`);
  return Array.from({ length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) throw new TypeError(`${label} must contain dense data entries`);
    return descriptor.value as unknown;
  });
}
function copySnapshot(value: unknown): E2ESourceSnapshot {
  const record = copyRecord(value, ["candidate", "commitSha", "treeSha", "treeComplete", "treePaths", "sources"], "source snapshot");
  const candidate = copyBoundedE2EJsonData(record.candidate, { maxBytes: 262_144, maxDepth: 64 }) as CandidateManifest;
  const treePaths = copyBoundedE2EJsonData(record.treePaths, { maxBytes: 262_144, maxDepth: 64 }) as string[];
  const sources = copyOwnArray(record.sources, 512, "source array").map((raw): E2ESourceSnapshot["sources"][number] => {
    const source = copyRecord(raw, ["path", "sha256", "bytes", "kind"], "source entry");
    if (source.kind !== "blob" && source.kind !== "symlink" && source.kind !== "submodule") throw new TypeError("source kind is invalid");
    return { path: copyBoundedE2EJsonData(source.path, { maxBytes: 2048, maxDepth: 4 }) as string, sha256: copyBoundedE2EJsonData(source.sha256, { maxBytes: 128, maxDepth: 4 }) as string, bytes: copyBoundedE2ESourceBytes(source.bytes, 512 * 1024), kind: source.kind };
  });
  if (typeof record.commitSha !== "string" || typeof record.treeSha !== "string" || record.treeComplete !== true) throw new TypeError("source snapshot identity fields are invalid");
  return { candidate, commitSha: record.commitSha, treeSha: record.treeSha, treeComplete: true, treePaths, sources };
}
function copyCompilationContext(input: unknown): E2EImmutableCompilationContext {
  const context = copyRecord(input, ["selectionInput", "executionPlan", "group"], "immutable compilation context");
  const rawSelection = copyRecord(context.selectionInput, ["candidateDigest", "expectedCandidate", "sourceSnapshot", "planDigest", "policy", "scenarios", "selectedTargetIds", "sandboxAvailability", "runtimeAvailability", "mockableComponents", "portableApprovalBinding", "approvedSemanticApproval"], "selection input");
  const selection: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(rawSelection)) selection[key] = key === "sourceSnapshot" ? copySnapshot(value) : copyBoundedE2EJsonData(value, { maxBytes: 262_144, maxDepth: 64 });
  return {
    selectionInput: selection as unknown as E2EPlanSelectionInput,
    executionPlan: E2EExecutionPlanSchema.parse(copyBoundedE2EJsonData(context.executionPlan, { maxBytes: 262_144, maxDepth: 64 })),
    group: E2EExecutionGroupSchema.parse(copyBoundedE2EJsonData(context.group, { maxBytes: 262_144, maxDepth: 64 })),
  };
}

export type { E2EPolicy, E2EScenario };
