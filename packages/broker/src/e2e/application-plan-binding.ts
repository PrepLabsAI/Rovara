import { createHash } from "node:crypto";
import {
  canonicalJson, E2EApplicationApprovalBindingSchema, E2EApplicationPlanIntentSchema, E2EAppArtifactRefSchema,
  E2EAppBuildManifestSchema, E2EAppRecipeSchema, E2ESetupProposalSchema, PlanApprovalRefSchema, e2eAppBuildManifestDigest,
  e2eApplicationApprovalBindingDigest, inspectE2ERepository, verifyE2ESourceSnapshot,
  type E2EApplicationApprovalBinding, type E2EApplicationPlanIntent, type E2EAppArtifactRef,
  type E2EAppBuildManifest, type E2EAppRecipe, type E2ESetupProposal, type SourceRef,
  type E2ESourceSnapshot,
} from "@agentx/contracts";
import { e2eApplicationMetadataSourcePaths, e2eApplicationMetadataSourceRefs } from "@agentx/contracts";
export { e2eApplicationMetadataSourceRefs } from "@agentx/contracts";

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const dependencyLockfileName = /^(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lock(?:b)?|gradle\.lockfile|packages\.lock\.json|Podfile\.lock|Package\.resolved|Cargo\.lock|Gemfile\.lock|composer\.lock|poetry\.lock|Pipfile\.lock|uv\.lock|go\.sum)$/i;
function parsedRecipe(recipe: unknown, applicationId: string): E2EAppRecipe {
  if (recipe === null || recipe === undefined) throw new Error(`application ${applicationId} has no source-backed launch recipe`);
  const parsed = E2EAppRecipeSchema.parse(recipe);
  const { recipeDigest, ...body } = parsed;
  if (sha256(canonicalJson(body)) !== recipeDigest) throw new Error(`application ${applicationId} recipe digest does not match its canonical recipe body`);
  return parsed;
}

function assertSnapshot(snapshot: E2ESourceSnapshot): ReturnType<typeof inspectE2ERepository> {
  verifyE2ESourceSnapshot(snapshot, snapshot.candidate);
  return inspectE2ERepository(snapshot, snapshot.candidate);
}

function sameRefs(left: readonly SourceRef[], right: readonly SourceRef[]): boolean {
  return canonicalJson([...left].sort((a, b) => a.path.localeCompare(b.path)))
    === canonicalJson([...right].sort((a, b) => a.path.localeCompare(b.path)));
}

export function deriveE2EApplicationApprovalBinding(input: {
  preparedSnapshot: E2ESourceSnapshot;
  intent: E2EApplicationPlanIntent;
  artifactId: string;
  artifactSha256: string;
  planDigest: string;
  setupProposal: E2ESetupProposal;
  setupApproval: { artifactId: string; digest: string };
}): E2EApplicationApprovalBinding {
  if (!/^[a-f0-9]{64}$/.test(input.artifactSha256) || !/^[a-f0-9]{64}$/.test(input.planDigest)) throw new Error("canonical feature artifact identity is invalid");
  const intent = E2EApplicationPlanIntentSchema.parse(input.intent);
  const setupProposal = E2ESetupProposalSchema.parse(input.setupProposal);
  const setupApproval = PlanApprovalRefSchema.parse(input.setupApproval);
  const semanticApproval = PlanApprovalRefSchema.parse({ artifactId: input.artifactId, digest: input.artifactSha256 });
    if (setupProposal.state !== "proposed") {
      const recipeChoice = setupProposal.missingInputs.find((input) => input.kind === "runtime" && /start and dev/i.test(input.reason));
      if (recipeChoice) throw new Error(`application launch recipe is ambiguous: ${recipeChoice.reason}`);
      throw new Error("approved setup proposal still has blocking inputs");
    }
  if (sha256(canonicalJson(setupProposal)) !== setupApproval.digest) throw new Error("setup approval digest does not identify the canonical setup proposal");

  const discovered = assertSnapshot(input.preparedSnapshot);
  const applicationById = new Map(discovered.inspection.applications.map((application) => [application.applicationId, application]));
  const targetById = new Map(discovered.inspection.proposedTargets.map((target) => [target.targetId, target]));
  const setupApplications = new Map(setupProposal.applications.map((application) => [application.applicationId, application]));
  const setupTargets = new Map(setupProposal.targets.map((target) => [target.targetId, target]));
  const applicationIds = [...new Set(intent.applicationRuntimeRefs.map((ref) => ref.applicationId))].sort();
  const applications: E2EApplicationApprovalBinding["applications"] = [];

  for (const applicationId of applicationIds) {
    const sourceApplication = applicationById.get(applicationId);
    const priorApplication = setupApplications.get(applicationId);
    if (!sourceApplication || !priorApplication) throw new Error(`approved application ${applicationId} is not present in both protected source and setup proposal`);
    if (sourceApplication.kind !== priorApplication.kind) throw new Error(`application ${applicationId} source kind changed since setup approval`);
    const recipe = parsedRecipe(sourceApplication.recipe, applicationId);
    const priorRecipe = parsedRecipe(priorApplication.recipe, applicationId);
    if (canonicalJson(recipe) !== canonicalJson(priorRecipe)) throw new Error(`application ${applicationId} recipe metadata changed since setup approval; replan is required`);
    const selectedRefs = e2eApplicationMetadataSourceRefs(input.preparedSnapshot, applicationId, sourceApplication.sourcePaths);
    const previousPaths = e2eApplicationMetadataSourcePaths(priorApplication.sourcePaths, setupProposal.sources.map((ref) => ref.path), applicationId);
    if (canonicalJson(previousPaths) !== canonicalJson(selectedRefs.map((ref) => ref.path))) throw new Error(`application ${applicationId} identity or lockfile source set changed since setup approval`);
    const priorRefs = new Map(setupProposal.sources.map((ref) => [ref.path, ref.sha256]));
    if (selectedRefs.some((ref) => priorRefs.get(ref.path) !== ref.sha256)) throw new Error(`application ${applicationId} authority-bearing source metadata changed since setup approval`);
    applications.push({ applicationId, sourceRefs: selectedRefs, recipe });
  }

  const runtimeRefs: E2EApplicationApprovalBinding["runtimeRefs"] = intent.applicationRuntimeRefs.map((ref) => {
    const sourceApplication = applicationById.get(ref.applicationId);
    const priorApplication = setupApplications.get(ref.applicationId);
    const sourceTarget = targetById.get(ref.targetId);
    const priorTarget = setupTargets.get(ref.targetId);
    const appApproval = applications.find((application) => application.applicationId === ref.applicationId);
    if (!sourceApplication || !priorApplication || !sourceTarget || !priorTarget || !appApproval
      || sourceTarget.applicationId !== ref.applicationId || priorTarget.applicationId !== ref.applicationId
      || canonicalJson(sourceTarget) !== canonicalJson(priorTarget)) {
      throw new Error(`application runtime target ${ref.targetId} differs from the source-derived and setup-approved target identity`);
    }
    if (ref.accountProfileId !== sourceTarget.accountProfileId) {
      throw new Error(`application runtime target ${ref.targetId} account profile differs from its source-derived and setup-approved assignment`);
    }
    if (!intent.scenarios.some((scenario) => scenario.requestedTargetIds.includes(ref.targetId)
      && scenario.accountProfileId === ref.accountProfileId
      && scenario.requestedTargetIds.some((targetId) => targetById.get(targetId)?.applicationId === ref.applicationId))) {
      throw new Error(`application runtime target ${ref.targetId} is not assigned to a scenario for its application and account`);
    }
    if (ref.runtimeProfileId.endsWith("-phase-unavailable") || ref.runtimeProfileId === "no-device-selected") {
      throw new Error(`application runtime target ${ref.targetId} must use an explicitly approved runtime profile`);
    }
    if (ref.recipeDigest !== appApproval.recipe.recipeDigest || !sameRefs(ref.sourceRefs, appApproval.sourceRefs)) {
      throw new Error(`application runtime target ${ref.targetId} source or recipe references differ from the selected source metadata`);
    }
    return ref;
  });

  for (const targetId of intent.requestedTargetIds) {
    if (!targetById.has(targetId) || !setupTargets.has(targetId)) throw new Error(`requested target ${targetId} is not source-discovered and setup-approved`);
  }

  for (const accountContext of intent.accountContextRefs) {
    const application = applicationById.get(accountContext.applicationId);
    const source = input.preparedSnapshot.sources.find((item) => item.path === accountContext.sourcePath && item.kind === "blob");
    const assigned = runtimeRefs.some((ref) => ref.applicationId === accountContext.applicationId && ref.accountProfileId === accountContext.profileId);
    if (!application || !assigned || !application.sourcePaths.includes(accountContext.sourcePath) || source?.sha256 !== accountContext.sourceSha256) {
      throw new Error(`account context ${accountContext.applicationId}/${accountContext.profileId} does not identify approved application source and runtime profile`);
    }
  }

  for (const scenario of intent.scenarios) {
    for (const targetId of scenario.requestedTargetIds) {
      const target = targetById.get(targetId);
      if (!target || !setupTargets.has(targetId)) throw new Error(`scenario target ${targetId} is not source-discovered and setup-approved`);
      const runtimeRef = runtimeRefs.find((ref) => ref.targetId === targetId);
      const approvedAccount = intent.runtimeAccountRefs.some((account) => account.applicationId === target.applicationId
        && account.profileId === scenario.accountProfileId);
      if (!runtimeRef || runtimeRef.applicationId !== target.applicationId || runtimeRef.accountProfileId !== scenario.accountProfileId
        || scenario.accountProfileId !== target.accountProfileId || !approvedAccount) {
        throw new Error(`scenario account profile for target ${targetId} differs from its source-derived and approved account assignment`);
      }
      if (target.kind === "web" || target.kind === "api" || target.kind === "mobile" || target.kind === "desktop") {
        if (intent.applicationRuntimeRefs.some((ref) => ref.targetId === targetId) && !scenario.steps.some((step) => step.kind !== "invoke-contract" && step.kind !== "inspect-contract")) {
          throw new Error(`real application target ${targetId} cannot be represented only by a portable operation reference`);
        }
      }
    }
  }

  const accountRefs = intent.runtimeAccountRefs;
  const body: Omit<E2EApplicationApprovalBinding, "bindingDigest"> = {
    schemaVersion: "e2e-application-approval/v1",
    semanticApproval, planDigest: input.planDigest,
    setupApproval, proposalSource: { candidateDigest: input.preparedSnapshot.candidate.digest,
      commitSha: input.preparedSnapshot.commitSha, treeSha: input.preparedSnapshot.treeSha },
    applications, runtimeRefs, accountRefs,
  };
  return E2EApplicationApprovalBindingSchema.parse({ ...body, bindingDigest: e2eApplicationApprovalBindingDigest(body) });
}

function lockfileRefs(sourceRefs: readonly SourceRef[]): SourceRef[] {
  return sourceRefs.filter((ref) => dependencyLockfileName.test(ref.path.slice(ref.path.lastIndexOf("/") + 1)));
}

function expectedOutputPlatform(target: ReturnType<typeof inspectE2ERepository>["inspection"]["proposedTargets"][number]): string {
  if (target.kind === "mobile") return target.os;
  if (target.kind === "desktop") return target.os;
  return target.kind;
}

export function validateE2EAppBuildBinding(input: {
  finalSnapshot: E2ESourceSnapshot;
  binding: E2EApplicationApprovalBinding;
  manifest: E2EAppBuildManifest;
  artifacts: E2EAppArtifactRef[];
}): { candidateDigest: string; applicationId: string; buildManifestDigest: string; artifactRefs: E2EAppArtifactRef[] } {
  const binding = E2EApplicationApprovalBindingSchema.parse(input.binding);
  const manifest = E2EAppBuildManifestSchema.parse(input.manifest);
  const artifactRefs = zParseArtifactRefs(input.artifacts);
  const discovered = assertSnapshot(input.finalSnapshot);
  const approvedApplication = binding.applications.find((application) => application.applicationId === manifest.applicationId);
  const currentApplication = discovered.inspection.applications.find((application) => application.applicationId === manifest.applicationId);
  if (!approvedApplication || !currentApplication) throw new Error(`build manifest application ${manifest.applicationId} is not approved and present in final source`);
  const currentRecipe = parsedRecipe(currentApplication.recipe, manifest.applicationId);
  if (canonicalJson(currentRecipe) !== canonicalJson(approvedApplication.recipe) || manifest.recipeDigest !== approvedApplication.recipe.recipeDigest) {
    throw new Error(`application ${manifest.applicationId} recipe changed after approval; replan is required`);
  }
  const currentRefs = e2eApplicationMetadataSourceRefs(input.finalSnapshot, manifest.applicationId, currentApplication.sourcePaths);
  if (!sameRefs(currentRefs, approvedApplication.sourceRefs)) throw new Error(`application ${manifest.applicationId} source-owned identity or lockfile metadata changed after approval`);
  for (const ref of approvedApplication.sourceRefs) {
    const currentSource = input.finalSnapshot.sources.find((source) => source.path === ref.path && source.kind === "blob");
    if (!currentSource || currentSource.sha256 !== ref.sha256) throw new Error(`approved application source reference changed or is missing: ${ref.path}`);
  }
  const approvedRuntimeRefs = binding.runtimeRefs.filter((ref) => ref.applicationId === manifest.applicationId);
  if (approvedRuntimeRefs.length === 0) throw new Error(`application ${manifest.applicationId} has no approved runtime target`);
  for (const ref of approvedRuntimeRefs) {
    const target = discovered.inspection.proposedTargets.find((candidate) => candidate.targetId === ref.targetId);
    if (!target || target.applicationId !== manifest.applicationId) throw new Error(`approved target ${ref.targetId} no longer identifies application ${manifest.applicationId}`);
    if (!sameRefs(ref.sourceRefs, approvedApplication.sourceRefs) || ref.recipeDigest !== approvedApplication.recipe.recipeDigest) {
      throw new Error(`approved target ${ref.targetId} application source or recipe identity changed`);
    }
  }

  const expectedLocks = lockfileRefs(approvedApplication.sourceRefs);
  if (!sameRefs(manifest.lockfileRefs, expectedLocks)) throw new Error("build manifest lockfile references differ from the exact approved lockfile set");
  if (manifest.candidateDigest !== input.finalSnapshot.candidate.digest || manifest.repository.repositoryId !== input.finalSnapshot.candidate.repositories[0]?.repositoryId
    || manifest.repository.commitSha !== input.finalSnapshot.commitSha || manifest.repository.treeSha !== input.finalSnapshot.treeSha) {
    throw new Error("build manifest candidate and repository identity do not match the complete final protected source");
  }
  if (manifest.manifestDigest !== e2eAppBuildManifestDigest(manifest)) throw new Error("build manifest digest does not match its canonical content");
  const expectedArtifacts = manifest.outputs.map((output) => ({ ...output, buildManifestDigest: manifest.manifestDigest }));
  if (canonicalJson([...artifactRefs].sort((a, b) => a.artifactId.localeCompare(b.artifactId)))
    !== canonicalJson([...expectedArtifacts].sort((a, b) => a.artifactId.localeCompare(b.artifactId)))) {
    throw new Error("artifact references do not match the exact build manifest output identities and hashes");
  }
  const assignedTargets = approvedRuntimeRefs.map((ref) => discovered.inspection.proposedTargets.find((target) => target.targetId === ref.targetId)!);
  for (const output of manifest.outputs) {
    const outputIdentityMatches = assignedTargets.some((target) => expectedOutputPlatform(target) === output.platform
      && output.appId === ("appId" in target ? target.appId : manifest.applicationId));
    if (!outputIdentityMatches) throw new Error(`build output ${output.artifactId} does not match a source-owned application platform and app ID`);
  }
  for (const target of assignedTargets) {
    if (!manifest.outputs.some((output) => expectedOutputPlatform(target) === output.platform
      && output.appId === ("appId" in target ? target.appId : manifest.applicationId))) {
      throw new Error(`build manifest has no output for approved application target ${target.targetId}`);
    }
  }
  return { candidateDigest: input.finalSnapshot.candidate.digest, applicationId: manifest.applicationId,
    buildManifestDigest: manifest.manifestDigest, artifactRefs: expectedArtifacts };
}

function zParseArtifactRefs(value: E2EAppArtifactRef[]): E2EAppArtifactRef[] {
  const parsed = value.map((item) => E2EAppArtifactRefSchema.parse(item));
  if (new Set(parsed.map((item) => item.artifactId)).size !== parsed.length) throw new Error("artifact references contain duplicate artifact IDs");
  return parsed;
}
