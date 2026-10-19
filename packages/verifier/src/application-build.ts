import { createHash } from "node:crypto";
import { types } from "node:util";
import { canonicalJson, copyBoundedE2EJsonData, copyBoundedE2ESourceBytes, E2EApplicationApprovalBindingSchema, E2EApplicationBuildBindingSchema,
  E2EApplicationBuildSourceManifestSchema, E2EApplicationBuildSourceRefSchema, E2EApplicationEvidenceRefSchema,
  E2EAppArtifactOutputSchema, E2EAppArtifactRefSchema, E2EAppBuildManifestSchema, E2EAppRecipeSchema,
  validateE2EAppBuildBinding, verifyE2ESourceSnapshot,
  type E2EApplicationApprovalBinding, type E2EApplicationBuildBinding, type E2EApplicationBuildSourceManifest,
  type E2EApplicationBuildSourceRef, type E2EApplicationEvidenceRef, type E2EAppArtifactOutput,
  type E2EAppArtifactRef, type E2EAppBuildManifest, type E2EAppRecipe, type E2ERuntimeProfile, type E2ESourceSnapshot } from "@agentx/contracts";
import { validateE2EApplicationBuildSourceManifest } from "./application-build-source.js";

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export type E2EApplicationBuildInput = Readonly<{
  snapshot: E2ESourceSnapshot;
  buildSource: { manifest: E2EApplicationBuildSourceManifest; reference: E2EApplicationBuildSourceRef };
  approval: E2EApplicationApprovalBinding;
  approvedRecipe: E2EAppRecipe;
  runtimeProfile: E2ERuntimeProfile;
  binding: E2EApplicationBuildBinding;
  signal: AbortSignal;
}>;
export type E2EApplicationBuildPorts = Readonly<{
  allocateBuild(input: { snapshot: E2ESourceSnapshot; buildSource: E2EApplicationBuildInput["buildSource"]; recipe: E2EAppRecipe; profile: E2ERuntimeProfile; binding: E2EApplicationBuildBinding }, signal: AbortSignal): Promise<{ leaseId: string; sourceReceiptRef: E2EApplicationEvidenceRef }>;
  executeBuild(lease: { leaseId: string; sourceReceiptRef: E2EApplicationEvidenceRef }, input: E2EApplicationBuildInput, signal: AbortSignal): Promise<{ processStatus: number | null; timedOut: boolean }>;
  observeOutput(lease: { leaseId: string; sourceReceiptRef: E2EApplicationEvidenceRef }, input: E2EApplicationBuildInput, signal: AbortSignal): Promise<{ outputs: E2EAppArtifactOutput[]; toolchainManifestDigest: string; supervisorReceiptRef: E2EApplicationEvidenceRef }>;
  close(lease: { leaseId: string; sourceReceiptRef?: E2EApplicationEvidenceRef }, signal: AbortSignal): Promise<{ confirmed: boolean }>;
}>;

function dataRecord(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError(`${label} must be an ordinary record`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !allowed.includes(key))) throw new TypeError(`${label} has unknown fields`);
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!("value" in descriptor) || !descriptor.enumerable) throw new TypeError(`${label} must contain own data fields`);
    result[key] = descriptor.value as unknown;
  }
  return result;
}
function dataArray(value: unknown, max: number, label: string): unknown[] {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max) throw new TypeError(`${label} must be an ordinary bounded array`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => key !== "length" && (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))) throw new TypeError(`${label} has extra properties`);
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new TypeError(`${label} must contain dense own-data entries`);
    return descriptor.value as unknown;
  });
}
function freezeJson<T>(value: T): T {
  if (value && typeof value === "object" && !Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}
function copySnapshot(value: unknown): E2ESourceSnapshot {
  const raw = dataRecord(value, ["candidate", "commitSha", "treeSha", "treeComplete", "treePaths", "sources"], "build source snapshot");
  const rawSources = dataArray(raw.sources, 512, "build source inventory");
  const sourceRecords = rawSources.map((source) => dataRecord(source, ["path", "sha256", "bytes", "kind"], "build source blob"));
  const metadata = copyBoundedE2EJsonData({ candidate: raw.candidate, commitSha: raw.commitSha, treeSha: raw.treeSha,
    treeComplete: raw.treeComplete, treePaths: raw.treePaths,
    sources: sourceRecords.map((item) => {
      return { path: item.path, sha256: item.sha256, kind: item.kind };
    }) }, { maxBytes: 8 * 1024 * 1024, maxDepth: 32 }) as Omit<E2ESourceSnapshot, "sources"> & { sources: Array<{ path: string; sha256: string; kind: "blob" }> };
  const sources = sourceRecords.map((item, index) => {
    const identity = metadata.sources[index]!;
    if (identity.kind !== "blob") throw new Error("build inspection snapshot contains a non-blob source");
    return { ...identity, bytes: copyBoundedE2ESourceBytes(item.bytes, 512 * 1024), kind: "blob" as const };
  });
  return freezeJson({ ...metadata, sources });
}
function snapshotForPort(snapshot: E2ESourceSnapshot): E2ESourceSnapshot {
  return Object.freeze({ ...snapshot, sources: Object.freeze(snapshot.sources.map((source) => Object.freeze({ ...source,
    bytes: copyBoundedE2ESourceBytes(source.bytes, 512 * 1024) }))) });
}
function bounded<T>(value: unknown, label: string, maxBytes = 1_048_576): T {
  return copyBoundedE2EJsonData(value, { maxBytes, maxDepth: 64 }) as T;
}
function validateBuildInput(input: E2EApplicationBuildInput): {
  snapshot: E2ESourceSnapshot; buildSource: E2EApplicationBuildInput["buildSource"]; approval: E2EApplicationApprovalBinding;
  recipe: E2EAppRecipe; profile: E2ERuntimeProfile; binding: E2EApplicationBuildBinding;
} {
  if (!input.signal || typeof input.signal.aborted !== "boolean" || typeof input.signal.addEventListener !== "function") throw new TypeError("application build requires an AbortSignal");
  const snapshot = copySnapshot(input.snapshot);
  verifyE2ESourceSnapshot(snapshot, snapshot.candidate);
  const buildSource = dataRecord(input.buildSource, ["manifest", "reference"], "build source binding");
  const approval = E2EApplicationApprovalBindingSchema.parse(bounded(input.approval, "application approval binding", 1_048_576));
  const manifest = E2EApplicationBuildSourceManifestSchema.parse(bounded(buildSource.manifest, "build source manifest", 16 * 1024 * 1024));
  const reference = E2EApplicationBuildSourceRefSchema.parse(bounded(buildSource.reference, "build source reference", 32_768));
  const recipe = E2EAppRecipeSchema.parse(bounded(input.approvedRecipe, "approved application recipe", 262_144));
  const profile = bounded<E2ERuntimeProfile>(input.runtimeProfile, "runtime profile");
  const binding = E2EApplicationBuildBindingSchema.parse(bounded(input.binding, "application build binding", 32_768));
  validateE2EApplicationBuildSourceManifest({ manifest, reference, expectedCandidate: snapshot.candidate, inspectionSnapshot: snapshot });
  if (!profile || profile.profileId !== binding.runtimeProfileId || profile.runtimeManifestDigest !== binding.runtimeManifestDigest
    || !/^[a-f0-9]{64}$/.test(profile.networkPolicyDigest) || !/^[a-f0-9]{64}$/.test(profile.seedDigest)) throw new Error("application build runtime profile identity is invalid");
  const recipeBody = Object.fromEntries(Object.entries(recipe).filter(([key]) => key !== "recipeDigest"));
  if (sha256(canonicalJson(recipeBody)) !== recipe.recipeDigest || recipe.recipeDigest !== binding.recipeDigest
    || binding.applicationId !== approval.applications.find((item) => item.applicationId === binding.applicationId)?.applicationId
    || approval.bindingDigest !== binding.applicationApprovalDigest || approval.proposalSource.candidateDigest !== binding.candidateDigest
    || approval.planDigest !== binding.planDigest || manifest.candidateDigest !== binding.candidateDigest
    || manifest.manifestDigest !== binding.buildSourceManifestDigest || reference.manifestDigest !== manifest.manifestDigest
    || reference.sha256 !== binding.buildSourceSha256) throw new Error("application build ticket does not bind approved candidate, recipe, application, and exact source archive");
  if (snapshot.candidate.digest !== binding.candidateDigest || snapshot.commitSha !== manifest.repository.commitSha || snapshot.treeSha !== manifest.repository.treeSha
    || snapshot.candidate.repositories[0]?.repositoryId !== manifest.repository.repositoryId) throw new Error("application build source snapshot differs from its ticket and manifest");
  if (!profile.applications.some((application) => application.applicationId === binding.applicationId && application.appBuildManifestDigest.length === 64)) throw new Error("application build runtime profile does not include the approved application");
  const approved = approval.applications.find((application) => application.applicationId === binding.applicationId);
  if (!approved || canonicalJson(approved.recipe) !== canonicalJson(recipe)) throw new Error("application build recipe differs from the source-backed approved recipe");
  return { snapshot, buildSource: { manifest, reference }, approval, recipe, profile, binding };
}

async function closeLease(ports: E2EApplicationBuildPorts, lease: { leaseId: string; sourceReceiptRef?: E2EApplicationEvidenceRef }): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("build cleanup deadline exceeded")), 60_000);
  try {
    const outcome = await Promise.race([
      Promise.resolve().then(() => ports.close(Object.freeze({ ...lease }), controller.signal)),
      new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("application build cleanup is pending")), { once: true })),
    ]);
    return outcome.confirmed === true;
  } finally { clearTimeout(timer); }
}

async function withinDeadline<T>(operation: (signal: AbortSignal) => Promise<T>, signal: AbortSignal, deadline: number, message: string): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const forwardAbort = () => controller.abort(signal.reason);
  const interrupted = new Promise<never>((_, reject) => {
    onAbort = () => { controller.abort(new Error(message)); reject(new Error(message)); };
    if (signal.aborted || Date.now() >= deadline) { onAbort(); return; }
    signal.addEventListener("abort", forwardAbort, { once: true });
    signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(onAbort, Math.max(1, Math.min(deadline - Date.now(), 2_147_483_647)));
  });
  try { return await Promise.race([Promise.resolve().then(() => {
    if (controller.signal.aborted || Date.now() >= deadline) throw new Error(message);
    return operation(controller.signal);
  }), interrupted]); }
  finally { if (timer) clearTimeout(timer); if (onAbort) signal.removeEventListener("abort", onAbort); signal.removeEventListener("abort", forwardAbort); }
}

export async function buildE2EApplication(input: E2EApplicationBuildInput, ports: E2EApplicationBuildPorts): Promise<{
  manifest: E2EAppBuildManifest; artifacts: E2EAppArtifactRef[]; supervisorReceiptRef: E2EApplicationEvidenceRef;
}> {
  const envelope = dataRecord(input, ["snapshot", "buildSource", "approval", "approvedRecipe", "runtimeProfile", "binding", "signal"], "application build input");
  const inputSignal = envelope.signal as AbortSignal;
  const validated = validateBuildInput({ snapshot: envelope.snapshot as E2ESourceSnapshot, buildSource: envelope.buildSource as E2EApplicationBuildInput["buildSource"],
    approval: envelope.approval as E2EApplicationApprovalBinding, approvedRecipe: envelope.approvedRecipe as E2EAppRecipe,
    runtimeProfile: envelope.runtimeProfile as E2ERuntimeProfile, binding: envelope.binding as E2EApplicationBuildBinding,
    signal: inputSignal });
  if (inputSignal.aborted || Date.now() >= Date.parse(validated.binding.deadlineAt)) throw new Error("application build preparation is cancelled or expired");
  const immutableInput: E2EApplicationBuildInput = Object.freeze({ snapshot: freezeJson(validated.snapshot),
    buildSource: freezeJson(validated.buildSource), approval: freezeJson(validated.approval), approvedRecipe: freezeJson(validated.recipe),
    runtimeProfile: freezeJson(validated.profile), binding: freezeJson(validated.binding), signal: inputSignal });
  let lease: { leaseId: string; sourceReceiptRef?: E2EApplicationEvidenceRef } | undefined;
  let cleanupAttempted = false;
  let allocationTimedOut = false;
  let lateAllocation: unknown;
  const closeOnce = async (knownLease: { leaseId: string; sourceReceiptRef?: E2EApplicationEvidenceRef }): Promise<boolean> => {
    if (cleanupAttempted) return false;
    cleanupAttempted = true;
    return closeLease(ports, knownLease);
  };
  const deadline = Date.parse(validated.binding.deadlineAt);
  try {
    const allocation = (callSignal: AbortSignal) => ports.allocateBuild({ snapshot: snapshotForPort(immutableInput.snapshot), buildSource: immutableInput.buildSource,
      recipe: immutableInput.approvedRecipe, profile: immutableInput.runtimeProfile, binding: immutableInput.binding }, callSignal).then((allocated) => {
      lateAllocation = allocated;
      if (allocationTimedOut) {
        const raw = dataRecord(allocated, ["leaseId", "sourceReceiptRef"], "late build allocation");
        if (typeof raw.leaseId === "string" && raw.leaseId.length > 0 && raw.leaseId.length <= 200) void closeOnce({ leaseId: raw.leaseId }).catch(() => undefined);
      }
      return allocated;
    });
    let allocated: unknown;
    try { allocated = await withinDeadline(allocation, inputSignal, deadline, "application build allocation exceeded its preparation deadline"); }
    catch (error) {
      allocationTimedOut = true;
      if (lateAllocation !== undefined) {
        const raw = dataRecord(lateAllocation, ["leaseId", "sourceReceiptRef"], "late build allocation");
        if (typeof raw.leaseId === "string" && raw.leaseId.length > 0 && raw.leaseId.length <= 200) void closeOnce({ leaseId: raw.leaseId }).catch(() => undefined);
      }
      throw error;
    }
    if (!allocated || typeof allocated !== "object" || Array.isArray(allocated) || Object.getPrototypeOf(allocated) !== Object.prototype) throw new Error("application build host returned an invalid allocation record");
    const leaseIdDescriptor = Object.getOwnPropertyDescriptor(allocated, "leaseId");
    if (!leaseIdDescriptor || !("value" in leaseIdDescriptor) || !leaseIdDescriptor.enumerable
      || typeof leaseIdDescriptor.value !== "string" || leaseIdDescriptor.value.length === 0 || leaseIdDescriptor.value.length > 200) throw new Error("application build host returned an invalid lease identity");
    // Retain the owned lease before validating the receipt so malformed replies still get one cleanup attempt.
    lease = { leaseId: leaseIdDescriptor.value };
    const receiptDescriptor = Object.getOwnPropertyDescriptor(allocated, "sourceReceiptRef");
    if (!receiptDescriptor || !("value" in receiptDescriptor) || !receiptDescriptor.enumerable) throw new Error("application build host returned an invalid source ingress receipt");
    lease.sourceReceiptRef = freezeJson(E2EApplicationEvidenceRefSchema.parse(bounded(receiptDescriptor.value, "source ingress receipt", 32_768)));
    if (!lease.leaseId || lease.leaseId.length > 200 || inputSignal.aborted || Date.now() >= Date.parse(validated.binding.deadlineAt)) throw new Error("application build allocation completed after cancellation or deadline");
    const processReply = await withinDeadline((callSignal) => ports.executeBuild(Object.freeze({ ...lease }) as { leaseId: string; sourceReceiptRef: E2EApplicationEvidenceRef },
      Object.freeze({ ...immutableInput, snapshot: snapshotForPort(immutableInput.snapshot), signal: callSignal }), callSignal), inputSignal, deadline,
    "application build execution exceeded its preparation deadline");
    const process = dataRecord(processReply, ["processStatus", "timedOut"], "application build process result");
    if (process.timedOut !== true && process.timedOut !== false) throw new Error("application build process result is invalid");
    if (process.timedOut || process.processStatus !== 0 || inputSignal.aborted || Date.now() >= Date.parse(validated.binding.deadlineAt)) throw new Error("application build command did not complete successfully within its preparation ticket");
    const observedReply = await withinDeadline((callSignal) => ports.observeOutput(Object.freeze({ ...lease }) as { leaseId: string; sourceReceiptRef: E2EApplicationEvidenceRef },
      Object.freeze({ ...immutableInput, snapshot: snapshotForPort(immutableInput.snapshot), signal: callSignal }), callSignal), inputSignal, deadline,
    "application build output observation exceeded its preparation deadline");
    const observed = dataRecord(observedReply, ["outputs", "toolchainManifestDigest", "supervisorReceiptRef"], "application build output observation");
    if (!Array.isArray(observed.outputs)) throw new Error("application build output observation is invalid");
    const outputs = observed.outputs.map((item) => E2EAppArtifactOutputSchema.parse(bounded(item, "build output", 32_768)));
    if (typeof observed.toolchainManifestDigest !== "string" || !/^[a-f0-9]{64}$/.test(observed.toolchainManifestDigest) || outputs.length === 0) throw new Error("application build output observation is incomplete");
    const repository = validated.snapshot.candidate.repositories[0]!;
    const body = { schemaVersion: "e2e-app-build/v1" as const, candidateDigest: validated.snapshot.candidate.digest,
      applicationId: validated.binding.applicationId,
      repository: { repositoryId: repository.repositoryId, commitSha: validated.snapshot.commitSha, treeSha: validated.snapshot.treeSha },
      recipeDigest: validated.recipe.recipeDigest,
      lockfileRefs: validated.approval.applications.find((item) => item.applicationId === validated.binding.applicationId)!.sourceRefs
        .filter((ref) => /(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lock(?:b)?|gradle\.lockfile|packages\.lock\.json|Podfile\.lock|Package\.resolved|Cargo\.lock|Gemfile\.lock|composer\.lock|poetry\.lock|Pipfile\.lock|uv\.lock|go\.sum)$/i.test(ref.path.slice(ref.path.lastIndexOf("/") + 1))),
      toolchainManifestDigest: observed.toolchainManifestDigest, outputs, createdAt: new Date().toISOString() };
    const manifest = E2EAppBuildManifestSchema.parse({ ...body, manifestDigest: sha256(canonicalJson(body)) });
    const artifacts = manifest.outputs.map((output) => E2EAppArtifactRefSchema.parse({ ...output, buildManifestDigest: manifest.manifestDigest }));
    validateE2EAppBuildBinding({ finalSnapshot: validated.snapshot, binding: validated.approval, manifest, artifacts });
    const receipt = E2EApplicationEvidenceRefSchema.parse(bounded(observed.supervisorReceiptRef, "supervisor receipt", 32_768));
    if (inputSignal.aborted || Date.now() >= deadline) throw new Error("application build output arrived after cancellation or deadline");
    const didClose = await closeOnce(lease);
    if (!didClose) throw new Error("application build cleanup is pending; output is not accepted");
    return { manifest, artifacts, supervisorReceiptRef: receipt };
  } catch (error) {
    if (lease && !cleanupAttempted) {
      try { await closeOnce(lease); } catch { /* one independent cleanup budget is consumed */ }
    }
    if (error instanceof Error && /^(?:application build|build source|application runtime|source snapshot|build ticket|approved recipe|application )/.test(error.message)) throw error;
    // eslint-disable-next-line preserve-caught-error -- Host exceptions may include untrusted app output; expose only the safe failure category.
    throw new Error("application build did not produce a safely observed and closed result");
  }
}
