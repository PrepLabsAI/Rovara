import { createHash } from "node:crypto";
import {
  E2EPolicySchema, E2ERoundSchema, E2ERunBindingSchema, E2E_EXECUTOR_COMPILED_ORIGIN, E2E_HARD_LIMITS, canonicalJson,
  e2eAppBuildManifestDigest, e2eApplicationLockfileRefs, e2ePolicyDigest, validateE2EAppBuildBinding,
  type E2ECreatorAuthority, type E2EApplicationBuildSourceManifest, type E2EApplicationBuildSourceRef, type E2EApplicationExecutionAdmission, type E2EApplicationGroupAdmission,
  type E2EApplicationLaunchTarget, type E2EApplicationPlanIntent, type E2EAppArtifactRef, type E2EAppBuildManifest, type E2ERegisteredRuntime, type E2ERound,
  type E2EApplicationSelectionRecord, type E2ESetupProposal, type E2ESourceSnapshot, type Ec2RuntimeBinding, type PlanApprovalRef,
} from "@agentx/contracts";
import {
  DEFAULT_DEADLINE_GRACE_MS, E2E_EXECUTOR_HOST_DESCRIPTOR, E2E_EXECUTOR_HOST_PROFILE_ID, STALE_RUN_SWEEP_AGE_MS, compileE2EApplicationScenarios, decodeE2EApplicationExecutionAdmission,
  encodeE2EApplicationExecutionAdmission, validateE2EApplicationBuildSourceManifest, validateE2EApplicationExecutionAdmission, webApiApplicationLaunchTarget,
  type E2EApplicationCompilationContext,
} from "@agentx/verifier";
import { ApplicationPlanDefect, applicationAccountsRefusal, applicationRoundRefusal, applicationRuntimeRefusal } from "./application-dispatch-check.js";
import type { E2EAccountRegistryEntry } from "./application-account-registry.js";
import { BF_REASON, evaluateApplicationPlanApproval } from "./application-plan-approval.js";

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

/** Everything the broker knows when it admits one application round, none of it from the worker. */
export type ApplicationAdmissionInput = Readonly<{
  taskId: string; operationId: string; operationFence: number; workflowRevision: number; roundId: string;
  /** A fresh run id for each group, in plan order. */
  runId: () => string;
  /** The approved plan's canonical v2 intent, whole. */
  intent: E2EApplicationPlanIntent;
  /** The canonical plan artifact the Owner approved. */
  artifact: { id: string; sha256: string };
  /** The exported candidate, as the stored export holds it: its commit, tree, complete path inventory and source blobs. */
  snapshot: E2ESourceSnapshot;
  /** The approved setup's proposal and the approval that binds it. */
  setupProposal: E2ESetupProposal; setupApproval: PlanApprovalRef;
  /** The task's pinned project policy. */
  policy: unknown;
  /** The runtime rows READY now. Only the row of the one kind the plan runs is passed on to the verifier (Ruling BF). */
  registeredRuntimes: readonly E2ERegisteredRuntime[];
  runtimeCatalogId: string; runtimeBinding: Ec2RuntimeBinding;
  /** The candidate's exported build source: the manifest and the reference an admission carries (`candidateBuildSourceAdmissionReference`). */
  buildSource: { manifest: E2EApplicationBuildSourceManifest; reference: E2EApplicationBuildSourceRef };
  /** The registry rows of the plan's test accounts, read for this dispatch. The round runs with the refs the approval pinned, and refuses if the registry no longer holds exactly them. */
  accountEntries: readonly E2EAccountRegistryEntry[];
  /** What the Owner approved (`workflow.e2e.applicationSelection`): the selection derived here for the candidate must agree with it on targets, runtime rows and intent. */
  recordedSelection: E2EApplicationSelectionRecord;
  /** The plan identity of this round (its approved graph run, revision and actor), not the approval-time one. */
  planDigest: string;
  /** The creator's access as the broker proved it now; the admission keeps it so verification can refuse a grant re-issued or a role changed during the round. */
  creatorAuthority?: E2ECreatorAuthority;
  now: number;
}>;

export type ApplicationAdmission = Readonly<{
  admission: E2EApplicationExecutionAdmission;
  /** The canonical bytes the broker stores, content addressed by `sha256`. */
  bytes: Buffer; sha256: string;
  /** The admission's own digest (`admissionDigest`). */
  admissionDigest: string;
  roundId: string;
  /** One run id per admitted group, in the round's group order: what the CHECKS operation and the evidence uploads are keyed by. */
  groupRunIds: string[];
  /** The one runtime kind of the round. */
  kind: "web" | "api";
}>;

const refusal = applicationRoundRefusal;
const failure = (error: unknown) => (error instanceof Error ? error.message : "unreadable input");

/**
 * Builds the application admission a worker decodes (`decodeE2EApplicationExecutionAdmission`) for one single-kind round, from the approved intent, the exported
 * candidate and the approved setup, and checks it with the worker's own validator before returning it. Every input that is missing or does not agree is a
 * refusal (an `ApplicationDispatchRefusal`) with a specific reason: nothing is defaulted, and nothing falls back to the portable path.
 *
 * The selection and the application approval binding are derived against the exported candidate (the source the round builds), under this round's plan
 * identity; that derivation re-checks the candidate against the approved setup, so an application whose recipe, identity metadata or targets changed since
 * the setup was approved is refused ("replan"). Only the READY row of the plan's one runtime kind goes into the admission.
 */
export function buildApplicationExecutionAdmission(input: ApplicationAdmissionInput): ApplicationAdmission {
  const policy = (() => { try { return E2EPolicySchema.parse(input.policy); } catch (error) { throw refusal(`the pinned project policy is not valid: ${failure(error)}`); } })();
  const refs = input.intent.applicationRuntimeRefs;
  if (refs.length === 0) throw new ApplicationPlanDefect("the approved plan has no target that can run application scenarios, so there is nothing to run");

  // Ruling BF: one runtime kind per round. The row of that kind alone is passed on (a profile registers a web row and an api row, which the verifier cannot tell apart).
  const kinds = [...new Set(refs.map((ref) => policy.targets.find((target) => target.targetId === ref.targetId)?.kind))];
  if (kinds.some((kind) => kind !== "web" && kind !== "api")) throw new ApplicationPlanDefect("a target of the approved plan is not in the project policy or is not a web or API target");
  if (kinds.length > 1) throw new ApplicationPlanDefect(`the plan's executable targets span ${kinds.join(" and ")}: ${BF_REASON}`);
  const kind = kinds[0] as "web" | "api";
  const rows = input.registeredRuntimes.filter((row) => row.capabilities.kind === kind);

  const evaluation = evaluateApplicationPlanApproval({ intent: input.intent, taskId: input.taskId, artifact: input.artifact, snapshot: input.snapshot, setupProposal: input.setupProposal,
    setupApproval: input.setupApproval, policy, registeredRuntimes: rows, runtimeCatalogId: input.runtimeCatalogId, runtimeBinding: input.runtimeBinding, now: input.now,
    planDigest: input.planDigest, accounts: { entries: input.accountEntries, mode: "current", pinned: input.recordedSelection.accountRefs } });
  if (!evaluation.ok) {
    throw evaluation.scope === "runtime" ? applicationRuntimeRefusal(evaluation.reason) : evaluation.scope === "plan" ? new ApplicationPlanDefect(evaluation.reason)
      : evaluation.scope === "accounts" ? applicationAccountsRefusal(evaluation.reason) : refusal(evaluation.reason);
  }
  // The selection derived here, for the candidate and this round, must be the one the Owner approved on what decides what runs: the targets, the runtime rows and the intent.
  const approved = input.recordedSelection;
  const derived = evaluation.selection;
  const differs = canonicalJson([...derived.executableTargetIds].sort()) !== canonicalJson([...approved.executableTargetIds].sort()) ? "the executable targets"
    : canonicalJson(derived.runtimeRows) !== canonicalJson(approved.runtimeRows) ? "the runtime rows"
      : derived.intentDigest !== approved.intentDigest ? "the plan intent" : undefined;
  if (differs !== undefined) throw refusal(`the selection derived for this candidate differs from the one that was approved in ${differs}`);
  const { derivation } = evaluation;
  const selection = derivation.selectionInput;
  // Ruling BE: an application round carries no portable child group.
  if (derivation.portableProjection !== null || derivation.portableApprovalBinding !== null) throw new ApplicationPlanDefect("the approved plan carries portable checks, which an application round does not run");
  const approval = derivation.applicationApprovalBinding;
  if (approval === null) throw refusal("the approved plan has no application approval binding");
  const plan = derivation.plan;
  const groups = plan.groups;
  if (groups.length === 0) throw refusal("no scenario of the approved plan can run now");
  if (groups.some((group) => group.mode !== "real-runtime" && group.mode !== "hybrid")) throw refusal("the approved plan has a group that is not a real application group");
  if (groups.length > 4) throw refusal("the approved plan has more execution groups than one round runs");

  const targetById = new Map(plan.effectiveTargets.map((target) => [target.targetId, target]));
  const runnableTargets = [...new Set(groups.flatMap((group) => group.targetIds))].sort().map((targetId) => {
    const target = targetById.get(targetId);
    if (target === undefined || (target.kind !== "web" && target.kind !== "api")) throw refusal(`target ${targetId} cannot run as a web or API application target`);
    return { targetId, kind: target.kind, applicationId: target.applicationId, runtimeProfileId: target.runtimeProfileId };
  });
  const profileIds = [...new Set(runnableTargets.map((target) => target.runtimeProfileId))].sort();
  for (const profileId of profileIds) {
    if (profileId !== E2E_EXECUTOR_HOST_PROFILE_ID) throw applicationRuntimeRefusal(`no installed browser and API host is registered for runtime profile ${profileId}`);
  }
  const runtimeFor = (profileId: string): E2ERegisteredRuntime => {
    const row = selection.registeredRuntimes.find((item) => item.profileId === profileId);
    if (row === undefined) throw applicationRuntimeRefusal(`no ${kind} runtime of profile ${profileId} is READY`);
    return row;
  };

  // The exported build source must be this candidate's, exactly.
  const candidate = input.snapshot.candidate;
  const repository = candidate.repositories[0];
  const { manifest, reference } = input.buildSource;
  if (candidate.repositories.length !== 1 || repository === undefined) throw refusal("the candidate must hold exactly one repository");
  if (manifest.candidateDigest !== candidate.digest || manifest.repository.repositoryId !== repository.repositoryId || manifest.repository.commitSha !== input.snapshot.commitSha
    || manifest.repository.treeSha !== input.snapshot.treeSha) {
    throw refusal("the exported build source is for another candidate, commit or tree than the one being checked");
  }
  try {
    validateE2EApplicationBuildSourceManifest({ manifest, reference, expectedCandidate: candidate, inspectionSnapshot: input.snapshot });
  } catch (error) { throw refusal(`the exported build source did not validate: ${failure(error)}`); }

  const admittedAtMs = input.now;
  const admittedAt = new Date(admittedAtMs).toISOString();
  const spanMs = Math.min(policy.limits.runTimeoutMs, E2E_HARD_LIMITS.runTimeoutMs);
  // The run is torn down at its deadline plus the host's grace; the stale-run sweep must never reach a live run.
  if (spanMs + DEFAULT_DEADLINE_GRACE_MS >= STALE_RUN_SWEEP_AGE_MS) throw applicationRuntimeRefusal("the round's allowed run time is not shorter than the stale-run sweep");
  const deadlineAt = new Date(admittedAtMs + spanMs).toISOString();
  // A runtime that stops being READY mid-round would leave a finished run unverifiable, so a round does not start on one that expires before it could end.
  for (const profileId of profileIds) {
    const row = runtimeFor(profileId);
    if (Date.parse(row.expiresAt) < Date.parse(deadlineAt)) throw applicationRuntimeRefusal(`the ${kind} runtime of profile ${profileId} expires at ${row.expiresAt}, before this round could end at ${deadlineAt}`);
  }

  // One build identity per application: the candidate, the approved recipe and lockfiles, the exported source and the installed toolchain. The output digest names
  // what the host builds from exactly these inputs; nothing is prebuilt.
  const applicationIds = [...new Set(runnableTargets.map((target) => target.applicationId))].sort();
  const applicationBindings = applicationIds.map((applicationId) => {
    const approved = approval.applications.find((item) => item.applicationId === applicationId);
    if (approved === undefined) throw refusal(`application ${applicationId} is not in the application approval`);
    const targets = runnableTargets.filter((target) => target.applicationId === applicationId);
    const runtime = runtimeFor(targets[0]!.runtimeProfileId);
    const outputs = [...new Set(targets.map((target) => target.kind))].sort().map((platform) => ({
      artifactId: `build-${sha256(canonicalJson({ domain: "rovara-docker-build-artifact-id/v1", applicationId, platform, manifestDigest: manifest.manifestDigest })).slice(0, 32)}`,
      sha256: sha256(canonicalJson({ domain: "rovara-docker-build-output/v1", candidateDigest: candidate.digest, applicationId, recipeDigest: approved.recipe.recipeDigest,
        buildSourceManifestDigest: manifest.manifestDigest, platform })), appId: applicationId, platform }));
    const buildBody = { schemaVersion: "e2e-app-build/v1" as const, candidateDigest: candidate.digest, applicationId,
      repository: { repositoryId: repository.repositoryId, commitSha: input.snapshot.commitSha, treeSha: input.snapshot.treeSha },
      recipeDigest: approved.recipe.recipeDigest, lockfileRefs: e2eApplicationLockfileRefs(approved.sourceRefs), toolchainManifestDigest: runtime.manifestDigest, outputs, createdAt: admittedAt };
    const build: E2EAppBuildManifest = { ...buildBody, manifestDigest: e2eAppBuildManifestDigest(buildBody) };
    const artifacts: E2EAppArtifactRef[] = outputs.map((output) => ({ ...output, buildManifestDigest: build.manifestDigest }));
    try { validateE2EAppBuildBinding({ finalSnapshot: input.snapshot, binding: approval, manifest: build, artifacts }); }
    catch (error) { throw refusal(`the build identity of application ${applicationId} does not match the approval: ${failure(error)}`); }
    return { key: applicationId, value: { approval, build, artifacts, buildSource: { manifest, reference } } };
  });

  const runtimeBindings = profileIds.map((profileId) => ({ key: profileId, value: runtimeFor(profileId) }));
  const launchTargets: E2EApplicationLaunchTarget[] = runnableTargets.map((target) => {
    try { return webApiApplicationLaunchTarget({ target, runtime: runtimeFor(target.runtimeProfileId), capture: selection.policy.capture }); }
    catch (error) { throw refusal(`the launch declaration of target ${target.targetId} could not be built: ${failure(error)}`); }
  });
  const cliHosts = profileIds.map((profileId) => ({ profileId, descriptor: { ...E2E_EXECUTOR_HOST_DESCRIPTOR } }));
  const preparedEnvironments = groups.map((group) => {
    const members = group.targetIds.map((targetId) => runnableTargets.find((target) => target.targetId === targetId)!);
    const runtime = runtimeFor(members[0]!.runtimeProfileId);
    return { groupId: group.groupId,
      preparedEnvironmentDigest: sha256(canonicalJson({ domain: "rovara-docker-prepared-environment/v1", groupId: group.groupId, runtimeProfileId: runtime.profileId,
        runtimeManifestDigest: runtime.manifestDigest, networkPolicyDigest: runtime.capabilities.networkPolicyDigest, targetIds: [...group.targetIds].sort() })),
      originByApplicationId: [...new Set(members.map((target) => target.applicationId))].sort().map((applicationId) => ({ applicationId, origin: E2E_EXECUTOR_COMPILED_ORIGIN })) };
  }).sort((left, right) => (left.groupId < right.groupId ? -1 : 1));

  const context: E2EApplicationCompilationContext = { selectionInput: selection, executionPlan: plan, bundle: derivation.bundle,
    applicationBindings: new Map(applicationBindings.map((item) => [item.key, item.value])), runtimeBindings: new Map(runtimeBindings.map((item) => [item.key, item.value])),
    launchTargets, modelRoute: null, cliHostsByProfile: new Map(cliHosts.map((item) => [item.profileId, item.descriptor])),
    preparedEnvironmentsByGroup: new Map(preparedEnvironments.map(({ groupId, ...facts }) => [groupId, facts])) };

  const policyDigest = e2ePolicyDigest(selection.policy);
  const groupRuns = groups.map((group) => {
    let compiled: ReturnType<typeof compileE2EApplicationScenarios>;
    try { compiled = compileE2EApplicationScenarios({ context, groupId: group.groupId }); }
    catch (error) { throw refusal(`group ${group.groupId} could not be compiled from the approved plan: ${failure(error)}`); }
    const availability = selection.runtimeAvailability.find((item) => group.targetIds.includes(item.targetId));
    const binding = E2ERunBindingSchema.parse({ schemaVersion: 1, runId: input.runId(), roundId: input.roundId, taskId: input.taskId, operationId: input.operationId,
      operationFence: input.operationFence, workflowRevision: input.workflowRevision, groupId: group.groupId, executionPlanDigest: plan.digest, executionMode: group.mode,
      mockManifestDigest: group.mockManifestDigest, authorizationRevision: availability?.authorizationRevision ?? "unavailable", candidateDigest: candidate.digest,
      planDigest: input.planDigest, policyDigest, bundleDigest: derivation.bundle.bundleDigest, appBuildDigest: sha256(canonicalJson(compiled.inventory)),
      environmentDigest: compiled.preparedEnvironmentDigest, runtimeManifestDigest: runtimeFor(compiled.cliHost.profileId).manifestDigest,
      modelRouteRevision: selection.policy.modelRouteRevision, expectedCases: compiled.expectedCases, admittedAt, deadlineAt });
    const admitted: E2EApplicationGroupAdmission = { protocol: "trusted-e2e-application/v1", outerBinding: binding, cliHost: compiled.cliHost,
      preparedEnvironmentDigest: compiled.preparedEnvironmentDigest, originByApplicationId: [...compiled.originByApplicationId], compiledInventoryDigest: compiled.inventory.digest,
      shards: compiled.inventory.shards.map((shard) => ({ shardId: shard.shardId, targetId: shard.targetId, inventoryDigest: shard.inventoryDigest,
        configDigest: shard.expectedConfigDigest, expectedCaseIds: [...shard.expectedCaseIds] })) };
    return { binding, admitted };
  });
  const round: E2ERound = E2ERoundSchema.parse({ schemaVersion: 1, roundId: input.roundId, taskId: input.taskId, operationId: input.operationId, operationFence: input.operationFence,
    workflowRevision: input.workflowRevision, executionPlanDigest: plan.digest, admittedAt, deadlineAt, limits: selection.policy.limits, groupBindings: groupRuns.map((item) => item.binding) });

  const wire = { candidate: input.snapshot.candidate, commitSha: input.snapshot.commitSha, treeSha: input.snapshot.treeSha, treeComplete: true as const,
    treePaths: input.snapshot.treePaths, sources: input.snapshot.sources.map((source) => {
      if (source.kind !== "blob") throw refusal(`source ${source.path} is not a regular file`);
      return { path: source.path, sha256: source.sha256, bytesBase64: Buffer.from(source.bytes).toString("base64"), kind: "blob" as const };
    }) };
  const body = { schemaVersion: "workflow-e2e-application-admission/v1" as const, taskId: input.taskId, operationId: input.operationId, operationFence: input.operationFence,
    workflowRevision: input.workflowRevision, candidateDigest: candidate.digest, candidateCommitSha: input.snapshot.commitSha, candidateTreeSha: input.snapshot.treeSha,
    sourceSnapshot: wire, intent: selection.intent, intentDigest: selection.intentDigest, selectionInput: { ...selection, sourceSnapshot: wire },
    applicationApprovalBinding: approval, applicationBindings, runtimeBindings, launchTargets: [...launchTargets].sort((left, right) => (left.targetId < right.targetId ? -1 : 1)),
    modelRoute: null, cliHosts, preparedEnvironments, policy: selection.policy, bundle: derivation.bundle, executionPlan: plan,
    ...(input.creatorAuthority === undefined ? {} : { creatorAuthority: input.creatorAuthority }), portableProjection: null, round,
    groups: groupRuns.map((item) => item.admitted).sort((left, right) => (left.outerBinding.groupId < right.outerBinding.groupId ? -1 : 1)) };
  let bytes: Buffer;
  let admission: E2EApplicationExecutionAdmission;
  try {
    bytes = Buffer.from(encodeE2EApplicationExecutionAdmission({ ...body, admissionDigest: sha256(canonicalJson(body)) } as unknown as E2EApplicationExecutionAdmission), "utf8");
    // Exactly what the worker does with the stored bytes: decode them, then validate the whole admission again from its own content.
    admission = decodeE2EApplicationExecutionAdmission(bytes);
    validateE2EApplicationExecutionAdmission(admission);
  } catch (error) { throw refusal(`the admission could not be built within its limits or did not validate: ${failure(error)}`); }
  return { admission, bytes, sha256: sha256(bytes), admissionDigest: admission.admissionDigest, roundId: input.roundId,
    groupRunIds: round.groupBindings.map((binding) => binding.runId), kind };
}
