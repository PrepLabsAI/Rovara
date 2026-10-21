import { createHash } from "node:crypto";
import {
  E2EApplicationPlanIntentSchema, E2EApplicationSelectionRecordSchema, E2EPolicySchema, Ec2RuntimeBindingSchema, canonicalJson,
  deriveE2ESyntheticRuntimeAccountRef, E2EApplicationIdentityMissingError, e2eApplicationMetadataSourceRefs, e2eRuntimeKindMatchesTarget, inspectE2ERepository, isE2EQualifiedRuntimeProfileId, readE2EApplicationProjectContract,
  type E2EApplicationPlanIntent, type E2EApplicationProjectContract, type E2EApplicationSelectionRecord, type E2ERegisteredRuntime, type E2ERuntimeAccountRef, type E2ERuntimeAvailability,
  type E2ESetupProposal, type E2ESourceSnapshot, type Ec2RuntimeBinding, type PlanApprovalRef,
} from "@agentx/contracts";
import { deriveE2EApplicationFeatureExecutionSelection } from "./application-feature-plan-intent.js";
import { E2EAccountRegistryError, latestAccountRef, type E2EAccountRegistryEntry } from "./application-account-registry.js";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const REASON_MAX_CHARS = 600;
/** What the Owner and the planner are told to do with portable criteria in a version 2 plan (Ruling BE). */
export const BE_REMEDY = "put portable checks in a schemaVersion 1 plan or drop them";
/** Why a version 2 plan may not run web and API targets together (Ruling BF). */
export const BF_REASON = "one runtime kind per plan in M1.2";
const BLOCKED_LISTED = 5;

/** A refusal reason a person can read: one line of at most REASON_MAX_CHARS, with no control characters (planner-written IDs reach it). */
function clean(text: string): string {
  const line = text.replace(/\p{Cc}+/gu, " ").replace(/\s+/gu, " ").trim();
  return line.length > REASON_MAX_CHARS ? `${line.slice(0, REASON_MAX_CHARS - 3)}...` : line;
}

export type ApplicationPlanApprovalInput = {
  /** The plan's v2 intent, exactly as the canonical artifact holds it. */
  intent: E2EApplicationPlanIntent;
  taskId: string;
  /** The canonical plan artifact being approved. */
  artifact: { id: string; sha256: string };
  /** The approved setup's verified source snapshot and its proposal, with the approval that binds them (never the prepared checkout). */
  snapshot: E2ESourceSnapshot;
  setupProposal: E2ESetupProposal;
  setupApproval: PlanApprovalRef;
  /** The task's pinned project policy. */
  policy: unknown;
  /** The runtime rows READY for the project's runtime binding, read at approval time (not cached from planning). */
  registeredRuntimes: E2ERegisteredRuntime[];
  runtimeCatalogId: string;
  runtimeBinding: Ec2RuntimeBinding;
  now: number;
  /** The test accounts the plan's runtime account refs are held to (Task 3.1). */
  accounts: ApplicationAccountsInput;
  /**
   * The plan identity the derivation is made under. Approval leaves it out (the identity of the canonical plan artifact); dispatch gives its own, derived
   * from the approved graph run, revision and actor, so the admission it builds is bound to that one round.
   */
  planDigest?: string;
};

/**
 * The registry rows the broker read for the plan's accounts, and what the evaluation is for:
 * - `approve`: the Owner approves a plan now. Each scenario's account ref must equal the account's latest registered ref, parsed on both sides, and the registry's
 *   definition must stand behind the approved contract and be unexpired. The M1.2 stand-in is never accepted.
 * - `reapprove`: the Owner approves the same, already approved plan again (a retry after the accounts or the runtime changed). The plan still carries the ref it was
 *   approved with; the latest registered ref is pinned instead.
 * - `current`: dispatch, admission and verification. The refs pinned at approval (`pinned`) are what runs, and the registry must still hold exactly them. A record approved
 *   under M1.2 pinned none; its plan's recipe-derived stand-in refs are read as they are while the registry holds nothing for the account.
 */
export type ApplicationAccountsInput = { entries: readonly E2EAccountRegistryEntry[]; mode: "approve" | "reapprove" | "current"; pinned: readonly E2ERuntimeAccountRef[] };

export const applicationAccountKey = (ref: { applicationId: string; profileId: string }) => `${ref.applicationId}\0${ref.profileId}`;
const sameRef = (left: E2ERuntimeAccountRef, right: E2ERuntimeAccountRef) => canonicalJson(left) === canonicalJson(right);
const describeAccount = (applicationId: string, profileId: string) => `account profile ${profileId} of application ${applicationId}`;

/**
 * The account ref one executable (application, account profile) runs with, or why it cannot. Every lookup is by the pair and must find exactly one account: an owner and a
 * viewer of one application each get their own ref. Refusals are `accounts-changed-reapprove` (the registered account is not the one the plan stands on) or the registry's
 * own not-registered / ambiguous messages; a plan that carries no ref for the account is a plan defect.
 */
function pinAccountRef(input: { accounts: ApplicationAccountsInput; contract: E2EApplicationProjectContract | null; applicationId: string; profileId: string; recipeDigest: string;
  planRefs: readonly E2ERuntimeAccountRef[]; now: number }): { ok: true; ref: E2ERuntimeAccountRef } | { ok: false; reason: string; scope: ApplicationRefusalScope } {
  const { accounts, applicationId, profileId } = input;
  const what = describeAccount(applicationId, profileId);
  const matching = (refs: readonly E2ERuntimeAccountRef[]) => refs.filter((ref) => ref.applicationId === applicationId && ref.profileId === profileId);
  const planned = matching(input.planRefs);
  if (planned.length !== 1) return { ok: false, scope: "plan", reason: `the plan has ${planned.length === 0 ? "no" : "more than one"} runtime account reference for ${what}; copy runtimeAccountRefs from the planning context` };
  const planRef = planned[0]!;
  const registered = accounts.entries.some((entry) => entry.definition.applicationId === applicationId && entry.definition.profileId === profileId);
  const latest = (): E2ERuntimeAccountRef => {
    if (input.contract === null) throw new E2EAccountRegistryError("account-not-registered", `no account definition is registered for ${what}: the application has no project contract in the approved source`);
    return latestAccountRef({ contract: input.contract, entries: accounts.entries, applicationId, profileId, now: input.now });
  };
  const changed = (detail: string) => ({ ok: false as const, scope: "accounts" as const, reason: `accounts-changed-reapprove: ${what} ${detail}` });
  try {
    if (accounts.mode === "approve") {
      const current = latest();
      return sameRef(planRef, current) ? { ok: true, ref: current }
        : changed(`is registered at revision ${current.revision} now, and the plan's runtime account reference is not that one; copy runtimeAccountRefs from the planning context`);
    }
    if (accounts.mode === "reapprove") return { ok: true, ref: latest() };
    const pinned = matching(accounts.pinned);
    if (pinned.length > 1) return changed("has more than one pinned account reference");
    if (pinned.length === 1) {
      if (!registered) return changed("is no longer registered");
      const current = latest();
      return sameRef(pinned[0]!, current) ? { ok: true, ref: pinned[0]! } : changed(`was approved at revision ${pinned[0]!.revision} and is registered at revision ${current.revision} now`);
    }
    // An M1.2 record: the plan's ref is the recipe-derived stand-in, which no new approval accepts but a record approved under M1.2 is read with.
    const standIn = deriveE2ESyntheticRuntimeAccountRef({ applicationId, accountProfileId: profileId, recipeDigest: input.recipeDigest });
    if (!sameRef(planRef, standIn)) return { ok: false, scope: "plan", reason: `the runtime account reference for ${what} is not the synthetic account identity this plan was approved with; copy runtimeAccountRefs from the planning context` };
    if (registered) return changed("has a registered definition now, and the plan was approved with the recipe-derived account identity");
    return { ok: true, ref: standIn };
  } catch (error) {
    if (error instanceof E2EAccountRegistryError) return { ok: false, scope: "accounts", reason: error.message };
    throw error;
  }
}

/** As operationStep does: a portable scenario is exactly one portable step. One that goes on to application steps is refused as a mix. */
const isPortableScenario = (scenario: E2EApplicationPlanIntent["scenarios"][number]) => scenario.steps.length === 1
  && (scenario.steps[0]?.kind === "invoke-contract" || scenario.steps[0]?.kind === "inspect-contract");

/**
 * The identity of an approved application intent: the digest of the plan's intent as the schema reads it (`fullIntent`), with its optional members as the plan
 * holds them. Approval records it, dispatch derives it again, and verification binds the stored plan to the record with it. The input is the stored intent or its
 * parse, never the round's derived intent (`applicationRoundIntent`), which writes the members the planner leaves out as empty lists.
 */
export function applicationIntentDigest(intent: E2EApplicationPlanIntent): string {
  return sha256(canonicalJson(E2EApplicationPlanIntentSchema.parse(intent)));
}

/**
 * The intent with the account refs an approval pinned in place of the ones the stored plan carries (the plan's refs for accounts without a pinned one stay). Approval
 * pins the registry's latest refs, so a plan approved again after an account moved on still runs the account that is registered; the stored plan, and the digest that
 * binds it to its approval (`applicationIntentDigest`), are never changed.
 */
export function applicationIntentWithAccountRefs(intent: E2EApplicationPlanIntent, pinned: readonly E2ERuntimeAccountRef[]): E2EApplicationPlanIntent {
  const parsed = E2EApplicationPlanIntentSchema.parse(intent);
  const byKey = new Map(pinned.map((ref) => [applicationAccountKey(ref), ref]));
  return E2EApplicationPlanIntentSchema.parse({ ...parsed, runtimeAccountRefs: parsed.runtimeAccountRefs.map((ref) => byKey.get(applicationAccountKey(ref)) ?? ref) });
}

/**
 * The intent an application round is derived and admitted on, from the plan's intent as the schema reads it: its application scenarios and the targets they name,
 * with the members that belong to portable checks emptied and the source-backed mock selections kept for those targets. It is the one derivation of that intent,
 * used by the admission (which stores it as `admission.intent`) and by verification (which holds the approved plan to the admission by deriving it again), so a stored
 * plan that leaves out what the schema makes optional is the same intent as the admission that writes those members out as empty lists.
 */
export function applicationRoundIntent(intent: E2EApplicationPlanIntent): E2EApplicationPlanIntent {
  const fullIntent = E2EApplicationPlanIntentSchema.parse(intent);
  const applicationScenarios = fullIntent.scenarios.filter((scenario) => !isPortableScenario(scenario));
  const applicationTargetIds = new Set(applicationScenarios.flatMap((scenario) => scenario.requestedTargetIds));
  return E2EApplicationPlanIntentSchema.parse({ ...fullIntent,
    requestedTargetIds: fullIntent.requestedTargetIds.filter((targetId) => applicationTargetIds.has(targetId)),
    portableOperationRefs: [], semanticExportDeltas: [], scenarios: applicationScenarios,
    mockFixtureRefs: (fullIntent.mockFixtureRefs ?? []).filter((ref) => applicationTargetIds.has(ref.requestedTargetId)) });
}

/** What the approval's own derivation produced, for a caller that builds an admission from the same facts it just checked. */
export type ApplicationDerivation = ReturnType<typeof deriveE2EApplicationFeatureExecutionSelection>;
/**
 * Why an approval was refused, when the cause is knowable. `plan`: the plan itself can never run as written (portable criteria, web and api together, no application
 * scenario, a target with no source-owned identity), so only a corrected plan helps. `runtime`: the registered runtime cannot carry it now (no READY row of the kind, bound
 * elsewhere, not READY), so only the runtime being qualified again helps. `accounts`: a test account the plan stands on is not the registered one now (a newer revision, an
 * expired or unreadable definition, none registered), so only approving the checks again, or the setup being approved again, helps. Anything else has no scope and the
 * reason says what changed.
 */
export type ApplicationRefusalScope = "plan" | "runtime" | "accounts";
export type ApplicationPlanApproval =
  { ok: true; selection: E2EApplicationSelectionRecord; derivation: ApplicationDerivation;
    /** The account refs the round runs with, one per executable (application, account profile): what approval pins and what dispatch holds the registry to. */
    accountRefs: E2ERuntimeAccountRef[] }
  | { ok: false; reason: string; scope?: ApplicationRefusalScope };

/**
 * Evaluates whether the Owner may approve a plan carrying an application intent, against the approved setup and the READY rows now.
 *
 * It refuses (never approves, never drops a scenario, never falls back to portable) when a target the plan lists as executable is not on its
 * approved qualified profile, has no READY row of its kind bound to the project's runtime binding, would run a step or assertion its
 * descriptor lacks, uses an agent step, has only an inferred launch recipe, or names an account other than the synthetic one derived from
 * its recipe. A target the plan itself lists as unavailable is approved: its criteria are recorded as waiting and end UNKNOWN, which blocks
 * publication. Anything that cannot be evaluated is a refusal too.
 */
export function evaluateApplicationPlanApproval(input: ApplicationPlanApprovalInput): ApplicationPlanApproval {
  const refuse = (reason: string, scope?: ApplicationRefusalScope): ApplicationPlanApproval => ({ ok: false, reason: clean(reason), ...(scope === undefined ? {} : { scope }) });
  try {
    const parsed = E2EApplicationPlanIntentSchema.safeParse(input.intent);
    if (!parsed.success) return refuse(`the application intent is not valid: ${parsed.error.issues[0]?.message ?? "unreadable"}`, "plan");
    const fullIntent = parsed.data;
    const policy = E2EPolicySchema.parse(input.policy);
    const mixed = fullIntent.scenarios.find((scenario) => !isPortableScenario(scenario) && scenario.steps.some((step) => step.kind === "invoke-contract" || step.kind === "inspect-contract"));
    if (mixed !== undefined) return refuse(`scenario ${mixed.scenarioId} cannot mix portable and application steps`, "plan");
    const applicationScenarios = fullIntent.scenarios.filter((scenario) => !isPortableScenario(scenario));
    if (applicationScenarios.length === 0) return refuse("the plan has no application scenario, so it is a portable plan: use schemaVersion 1", "plan");
    // Ruling BE: one CHECKS operation carries one admission, and an application admission runs no portable child group, so a version 2 plan carries no
    // portable criteria in M1.2 (mixed rounds wait for M1.3). Nothing is dropped silently: the plan is refused and the owner asks for the plan to be corrected.
    const portableScenarios = fullIntent.scenarios.filter((scenario) => isPortableScenario(scenario));
    if (portableScenarios.length > 0) {
      return refuse(`scenario ${portableScenarios.map((scenario) => scenario.scenarioId).join(", ")} is a portable check, and a plan with application scenarios runs only application scenarios in M1.2: ${BE_REMEDY}`, "plan");
    }
    // The same goes for the portable members a plan can carry without a portable scenario: they would be dropped from the derived intent without a word.
    const portableMembers = [(fullIntent.portableOperationRefs?.length ?? 0) > 0 ? "portableOperationRefs" : undefined, fullIntent.semanticExportDeltas.length > 0 ? "semanticExportDeltas" : undefined]
      .filter((name) => name !== undefined);
    if (portableMembers.length > 0) {
      return refuse(`a plan with application scenarios must leave ${portableMembers.join(" and ")} empty, since they belong to portable checks and would run nothing in M1.2: ${BE_REMEDY}`, "plan");
    }
    const scenarioIds = new Set(fullIntent.scenarios.map((scenario) => scenario.scenarioId));
    const omitted = policy.baselineScenarioIds.filter((id) => !scenarioIds.has(id));
    if (omitted.length > 0) return refuse(`the plan omits baseline scenarios pinned by the approved setup: ${omitted.join(", ")}`);
    const applicationScenarioIds = new Set(applicationScenarios.map((scenario) => scenario.scenarioId));
    const intent = applicationRoundIntent(fullIntent);
    const applicationPolicy = { ...policy, baselineScenarioIds: policy.baselineScenarioIds.filter((id) => applicationScenarioIds.has(id)) };
    const bindingDigest = sha256(canonicalJson(Ec2RuntimeBindingSchema.parse(input.runtimeBinding)));
    const discovered = inspectE2ERepository(input.snapshot, input.snapshot.candidate);
    // Ruling BF: an application round carries exactly one runtime kind (the verifier keys its runtime bindings by profile, so a web row and an api row of
    // one profile cannot be admitted together). Kind-aware rounds wait for M1.3.
    const executableKinds = [...new Set(intent.applicationRuntimeRefs.flatMap((ref) => {
      const target = policy.targets.find((item) => item.targetId === ref.targetId);
      return target === undefined ? [] : [target.kind];
    }))].sort();
    if (executableKinds.length > 1) return refuse(`the plan's executable targets span ${executableKinds.join(" and ")}: ${BF_REASON}`, "plan");
    const availability: E2ERuntimeAvailability[] = [];
    const accountRefs: E2ERuntimeAccountRef[] = [];
    const usedRows: Array<{ kind: "web" | "api"; row: E2ERegisteredRuntime }> = [];
    for (const ref of intent.applicationRuntimeRefs) {
      const target = policy.targets.find((item) => item.targetId === ref.targetId);
      if (target === undefined) return refuse(`target ${ref.targetId} is not in the pinned project policy`);
      if (target.kind !== "web" && target.kind !== "api") return refuse(`target ${ref.targetId} is a ${target.kind} target; only web and API targets run application scenarios`);
      if (!isE2EQualifiedRuntimeProfileId(target.runtimeProfileId)) {
        return refuse(`target ${ref.targetId} is approved on runtime profile ${target.runtimeProfileId}, which cannot run application scenarios; list it in unavailableTargetRefs or ask an administrator to approve it on the qualified profile`);
      }
      if (ref.runtimeProfileId !== target.runtimeProfileId) return refuse(`the plan runs target ${ref.targetId} on runtime profile ${ref.runtimeProfileId}, not the runtime profile ${target.runtimeProfileId} it was approved on`);
      const application = discovered.inspection.applications.find((item) => item.applicationId === ref.applicationId);
      // A target whose application has no source-owned identity can never run (planning lists it as no-source-identity and gives it no reference).
      if (application !== undefined) {
        try { e2eApplicationMetadataSourceRefs(input.snapshot, application.applicationId, application.sourcePaths); }
        catch (error) {
          if (error instanceof E2EApplicationIdentityMissingError) return refuse(`target ${ref.targetId} has no source-owned application identity (no-source-identity), so it cannot run application scenarios; a plan must not name it`, "plan");
          throw error;
        }
      }
      if (application?.recipe === undefined || application.recipe === null) return refuse(`application ${ref.applicationId} has no launch recipe in the approved source`);
      // The synthetic account authorizes nothing beyond what the approved project contract declares: its profile must be a declared synthetic test account.
      const contract = readE2EApplicationProjectContract(input.snapshot, ref.applicationId);
      if (contract !== null && contract.accountProfiles.find((profile) => profile.profileId === ref.accountProfileId)?.scope !== "synthetic-test") {
        return refuse(`account profile ${ref.accountProfileId} is not declared as a synthetic test account by the application's project contract`);
      }
      // Test accounts are registered from the approved project contract; an application with only an inferred launch recipe has none to run as.
      if (contract === null) return refuse(`needs-project-contract: application ${ref.applicationId} has no project contract in the approved source, so target ${ref.targetId} has no registered test account to run application scenarios as`);
      // The account the case runs as is the registry's (owner decision D5), found by this application and this account profile, exactly one of it.
      const pinned = pinAccountRef({ accounts: input.accounts, contract, applicationId: ref.applicationId, profileId: ref.accountProfileId,
        recipeDigest: application.recipe.recipeDigest, planRefs: intent.runtimeAccountRefs, now: input.now });
      if (!pinned.ok) return refuse(pinned.reason, pinned.scope);
      if (!accountRefs.some((item) => applicationAccountKey(item) === applicationAccountKey(pinned.ref))) accountRefs.push(pinned.ref);
      const row = input.registeredRuntimes.find((item) => item.runtimeCatalogId === input.runtimeCatalogId && item.profileId === ref.runtimeProfileId
        && e2eRuntimeKindMatchesTarget({ ...target, runtimeProfileId: ref.runtimeProfileId }, item.capabilities));
      if (row === undefined) return refuse(`no ${target.kind} runtime of profile ${ref.runtimeProfileId} is READY for this project's runtime binding, so target ${ref.targetId} cannot run application scenarios now`, "runtime");
      if (row.bindingDigest !== bindingDigest) return refuse(`the ${target.kind} runtime of profile ${ref.runtimeProfileId} is bound to another runtime binding than this project's`, "runtime");
      if (row.state !== "READY" || Date.parse(row.qualifiedAt) > input.now || Date.parse(row.expiresAt) <= input.now) {
        return refuse(`the ${target.kind} runtime of profile ${ref.runtimeProfileId} is not READY now (state ${row.state}, expires ${row.expiresAt})`, "runtime");
      }
      availability.push({ targetId: ref.targetId, profileId: ref.runtimeProfileId, connection: "connected", approval: "approved", qualification: "qualified",
        authorizationRevision: `feature-${row.runtimeCatalogId}-${row.catalogRevision}-${row.generation}`.slice(0, 120) });
      if (!usedRows.some((used) => used.row === row)) usedRows.push({ kind: target.kind, row });
    }
    // The approval-time identity of the plan: the canonical artifact. Dispatch derives its own plan digest and re-runs the whole selection.
    const planDigest = input.planDigest ?? sha256(canonicalJson({ domain: "workflow-e2e-application-approval-plan/v1", taskId: input.taskId, artifactId: input.artifact.id, artifactSha256: input.artifact.sha256 }));
    const semanticApproval = { artifactId: input.artifact.id, digest: input.artifact.sha256 };
    // The round runs with the pinned refs, whatever refs the stored plan carries (a re-approved plan still holds the ones it was first approved with).
    const roundIntent = applicationIntentWithAccountRefs(intent, accountRefs);
    const selection = deriveE2EApplicationFeatureExecutionSelection({ intent: roundIntent, snapshot: input.snapshot, artifactId: semanticApproval.artifactId,
      artifactSha256: semanticApproval.digest, planDigest, approvedSemanticApproval: semanticApproval, setupProposal: input.setupProposal,
      setupApproval: input.setupApproval, policy: applicationPolicy, registeredRuntimes: input.registeredRuntimes, runtimeAvailability: availability,
      runtimeAccountRefs: roundIntent.runtimeAccountRefs, runtimeCatalogId: input.runtimeCatalogId, runtimeBinding: input.runtimeBinding, featureVerifier: null, now: input.now });
    // A criterion on a target the plan called executable that the selection could not make executable is a refusal; the rest wait as UNKNOWN.
    const executableTargetIds = [...new Set(intent.applicationRuntimeRefs.map((ref) => ref.targetId))].sort();
    const criteria = new Map(selection.plan.criteria.map((criterion) => [criterion.criterionId, criterion]));
    const blocked = selection.plan.unavailableCriteria.flatMap((item) => {
      const criterion = criteria.get(item.criterionId);
      return criterion !== undefined && executableTargetIds.includes(criterion.requestedTargetId)
        ? [`scenario ${criterion.scenarioId} on target ${criterion.requestedTargetId}: ${item.reason}`] : [];
    });
    if (blocked.length > 0) {
      const more = blocked.length > BLOCKED_LISTED ? `; and ${blocked.length - BLOCKED_LISTED} more` : "";
      return refuse(`the plan lists targets as executable whose scenarios cannot run now (${blocked.slice(0, BLOCKED_LISTED).join("; ")}${more})`);
    }
    return { ok: true, derivation: selection, selection: E2EApplicationSelectionRecordSchema.parse({
      schemaVersion: "e2e-application-selection/v1", intentDigest: applicationIntentDigest(fullIntent), planDigest, semanticApproval, setupApproval: input.setupApproval,
      applicationApprovalBindingDigest: selection.applicationApprovalBinding?.bindingDigest ?? null, applicationExecutionPlanDigest: selection.plan.digest,
      applicationBundleDigest: selection.bundle.bundleDigest, executableTargetIds,
      unavailableCriteria: selection.plan.unavailableCriteria.map((item) => ({ criterionId: item.criterionId, reason: item.reason })),
      runtimeRows: usedRows.map(({ kind, row }) => ({ kind, profileId: row.profileId, runtimeCatalogId: row.runtimeCatalogId, catalogRevision: row.catalogRevision,
        generation: row.generation, bindingDigest: row.bindingDigest, capabilityDigest: row.capabilityDigest, expiresAt: row.expiresAt })),
      accountRefs, evaluatedAt: new Date(input.now).toISOString() }), accountRefs };
  } catch (error) {
    return refuse(`the plan could not be derived against the approved setup and the ready runtimes: ${error instanceof Error ? error.message : "unreadable input"}`);
  }
}
