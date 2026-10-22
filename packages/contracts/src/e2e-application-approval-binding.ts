import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json.js";
import { E2EApplicationApprovalBindingSchema, E2EApplicationPlanIntentSchema, PlanApprovalRefSchema, e2eApplicationApprovalBindingDigest,
  type E2EApplicationApprovalBinding, type E2EApplicationPlanIntent, type SourceRef } from "./e2e-application.js";
import { e2eApplicationMetadataSourcePaths, e2eApplicationMetadataSourceRefs } from "./e2e-application-metadata.js";
import { e2eTargetSourceIdentity, inspectE2EApplicationRepository, isE2EPlaceholderRuntimeProfileId, isE2EQualifiedRuntimeProfileId, withE2EAnonymousTargets } from "./e2e-catalog.js";
import { E2EAppRecipeSchema, E2ESetupProposalSchema, type E2EAppRecipe, type E2ESetupProposal } from "./e2e.js";
import { verifyE2ESourceSnapshot, type E2ESourceSnapshot } from "./e2e-source.js";

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function parsedRecipe(recipe: unknown, applicationId: string): E2EAppRecipe {
  if (recipe === null || recipe === undefined) throw new Error(`application ${applicationId} has no source-backed launch recipe`);
  const parsed = E2EAppRecipeSchema.parse(recipe);
  const { recipeDigest, ...body } = parsed;
  if (sha256(canonicalJson(body)) !== recipeDigest) throw new Error(`application ${applicationId} recipe digest does not match its canonical recipe body`);
  return parsed;
}

function assertSnapshot(snapshot: E2ESourceSnapshot): ReturnType<typeof inspectE2EApplicationRepository> {
  verifyE2ESourceSnapshot(snapshot, snapshot.candidate);
  return inspectE2EApplicationRepository(snapshot, snapshot.candidate);
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
  // The setup proposal holds the base targets; their implicit signed-out variants are derived from them, as discovery derives the source ones.
  const setupTargets = new Map(withE2EAnonymousTargets(setupProposal.targets, discovered.anonymous).map((target) => [target.targetId, target]));
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
      || canonicalJson(e2eTargetSourceIdentity(sourceTarget)) !== canonicalJson(e2eTargetSourceIdentity(priorTarget))) {
      throw new Error(`application runtime target ${ref.targetId} differs from the source-derived and setup-approved target identity`);
    }
    // A web/API target approved against a qualified runtime profile can only be assigned to that profile, and a ref can name a qualified profile
    // only for a target approved on it (a placeholder-approved target stays unavailable).
    if (ref.runtimeProfileId !== priorTarget.runtimeProfileId
      && (!isE2EPlaceholderRuntimeProfileId(priorTarget.runtimeProfileId) || isE2EQualifiedRuntimeProfileId(ref.runtimeProfileId))) {
      throw new Error(`application runtime target ${ref.targetId} runtime profile differs from its setup-approved runtime profile`);
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
