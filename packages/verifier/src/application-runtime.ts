import { E2ERunBindingSchema, canonicalJson, e2ePolicyDigest, type E2ECollection, type E2ERunInput,
  type E2ERuntimePorts, type E2ERunBinding } from "@agentx/contracts";
import { createHash } from "node:crypto";
import type { E2EActualApplicationRun } from "./application-collection.js";
import { runIsolatedE2E } from "./runtime.js";
import { e2eCompiledRuntime, validateE2ECompiledApplicationAdmission, type E2ECompiledApplicationSuite } from "./application-scenarios.js";

const READBACK_CAP_MS = 30_000;
export type E2EApplicationRuntimePorts = E2ERuntimePorts & Readonly<{ readActualRun(signal: AbortSignal): Promise<E2EActualApplicationRun> }>;
export type E2EIsolatedApplicationRun = Readonly<{ lifecycle: E2ECollection; actualRun: E2EActualApplicationRun | null; unavailableReason: string | null }>;

function validateRunInput(input: E2ERunInput, compiled: E2ECompiledApplicationSuite, binding: E2ERunBinding): void {
  const context = compiled.runtimeAdmissionContext;
  const runtime = e2eCompiledRuntime(compiled);
  const expectedBuildDigest = createHash("sha256").update(canonicalJson(compiled.inventory)).digest("hex");
  const targetIds = new Set(compiled.group.targetIds);
  const applicationIds = [...new Set(context.selectionInput.intent.applicationRuntimeRefs.filter((ref) => targetIds.has(ref.targetId))
    .map((ref) => ref.applicationId))].sort();
  const expectedApplications = applicationIds.map((applicationId) => {
    const binding = compiled.applicationBindings.get(applicationId);
    const approved = binding?.approval.applications.find((item) => item.applicationId === applicationId);
    if (!binding || !approved) throw new Error("application runtime profile lacks an exact approved build and recipe binding");
    return { applicationId, appBuildManifestDigest: binding.build.manifestDigest, appRecipe: approved.recipe };
  });
  if (canonicalJson(input.binding) !== canonicalJson(binding)
    || canonicalJson(input.suite.expectedCases) !== canonicalJson(compiled.expectedCases)
    || canonicalJson(input.suite.bundle) !== canonicalJson(compiled.bundle)
    || input.profile.profileId !== compiled.group.runtimeProfileId || !runtime
    || input.profile.runtimeManifestDigest !== runtime.manifestDigest
    || canonicalJson([...input.profile.applications].sort((a, b) => a.applicationId.localeCompare(b.applicationId))) !== canonicalJson(expectedApplications)
    || binding.candidateDigest !== compiled.runtimeAdmission.expectedCandidate.digest
    || binding.planDigest !== context.selectionInput.planDigest
    || binding.executionPlanDigest !== context.executionPlan.digest
    || binding.policyDigest !== e2ePolicyDigest(context.selectionInput.policy)
    || binding.bundleDigest !== compiled.bundle.bundleDigest
    || binding.appBuildDigest !== expectedBuildDigest
    || binding.environmentDigest !== compiled.preparedEnvironmentDigest
    || binding.runtimeManifestDigest !== runtime.manifestDigest
    || binding.mockManifestDigest !== compiled.group.mockManifestDigest
    // An audit replay names no route but keeps the policy's revision, which is what its binding carries (the admission validator holds every binding to the policy's).
    || binding.modelRouteRevision !== (context.modelRoute?.routeRevision ?? (context.replay === undefined ? null : context.selectionInput.policy.modelRouteRevision))
    || canonicalJson(binding.expectedCases) !== canonicalJson(compiled.expectedCases)) {
    throw new Error("application lifecycle descriptor, runtime profile, bundle, or immutable compiled admission differs from the exact run input");
  }
}

async function readWithCap(ports: E2EApplicationRuntimePorts, callerSignal: AbortSignal): Promise<{ value: E2EActualApplicationRun | null; reason: string | null }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const abortFromCaller = () => controller.abort(callerSignal.reason);
  let onHarvestAbort: (() => void) | undefined;
  if (callerSignal.aborted) controller.abort(callerSignal.reason);
  else callerSignal.addEventListener("abort", abortFromCaller, { once: true });
  try {
    if (controller.signal.aborted) throw new Error("application proof readback was cancelled before dispatch");
    const cancelled = new Promise<never>((_, reject) => {
      onHarvestAbort = () => reject(new Error(timedOut ? "private application proof readback exceeded its 30 second cap" : "application proof readback was cancelled"));
      controller.signal.addEventListener("abort", onHarvestAbort, { once: true });
    });
    const value = await Promise.race([ports.readActualRun(controller.signal), cancelled, new Promise<never>((_, reject) => { timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("private application proof readback exceeded its 30 second cap"));
      reject(new Error("private application proof readback exceeded its 30 second cap"));
    }, READBACK_CAP_MS); })]);
    if (controller.signal.aborted || callerSignal.aborted || timedOut) return { value: null, reason: "application proof readback completed after cancellation and was not adopted" };
    return { value, reason: null };
  } catch (error) { return { value: null, reason: error instanceof Error ? error.message : "application proof readback failed" }; }
  finally {
    if (timer) clearTimeout(timer);
    if (onHarvestAbort) controller.signal.removeEventListener("abort", onHarvestAbort);
    callerSignal.removeEventListener("abort", abortFromCaller);
  }
}

/** Runs the generic owned lifecycle, then performs bounded private proof readback only after close. */
export async function runIsolatedE2EApplication(input: { input: E2ERunInput; compiled: E2ECompiledApplicationSuite;
  ports: E2EApplicationRuntimePorts; signal: AbortSignal }): Promise<E2EIsolatedApplicationRun> {
  const sourceSnapshot = input.compiled.runtimeAdmissionContext.selectionInput.sourceSnapshot;
  validateE2ECompiledApplicationAdmission(input.compiled, sourceSnapshot);
  const binding = E2ERunBindingSchema.parse(input.input.binding);
  if (canonicalJson(binding.expectedCases) !== canonicalJson(input.compiled.expectedCases) || binding.groupId !== input.compiled.group.groupId) throw new Error("application lifecycle binding does not match the exact compiled group");
  if (binding.executionMode !== input.compiled.group.mode || binding.mockManifestDigest !== input.compiled.group.mockManifestDigest
    || binding.runtimeManifestDigest !== e2eCompiledRuntime(input.compiled)?.manifestDigest
    || !input.compiled.shards.every((shard) => input.compiled.inventory.shards.some((item) => item.shardId === shard.shardId && item.targetId === shard.targetId))) throw new Error("application lifecycle runtime profile, group mode, or shard inventory differs from compiled admission");
  validateRunInput(input.input, input.compiled, binding);
  const lifecycle = await runIsolatedE2E(input.input, input.ports, input.signal);
  if (lifecycle.cleanup !== "confirmed") return { lifecycle, actualRun: null, unavailableReason: "application owned cleanup is pending or failed; actual proof readback was not attempted" };
  const readback = await readWithCap(input.ports, input.signal);
  if (!readback.value) return { lifecycle, actualRun: null, unavailableReason: readback.reason };
  if (!readback.value.cleanupConfirmed || readback.value.cleanupServerListening !== false || !readback.value.supervisorReadback) {
    return { lifecycle, actualRun: null, unavailableReason: "actual application supervisor readback does not confirm post-close cleanup and raw proof bytes" };
  }
  return { lifecycle, actualRun: readback.value, unavailableReason: null };
}
