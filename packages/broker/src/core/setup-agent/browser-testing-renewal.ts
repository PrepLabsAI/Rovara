// Browser testing: keeping the project's test accounts usable, and recording how sign-in went.
//
// RENEWAL (owner decision 421, MUST). A synthetic account definition expires 90 days after it is written (contracts `E2E_SYNTHETIC_ACCOUNT_TTL_DAYS`), and until now only registering a setup again renewed one. A project
// approved through this page writes its accounts once, so without this every company's browser checks would stop signing in on day 90. Renewal writes the SAME definition as the next revision (the same contract,
// profile, role, tenant and scope, a new expiry) under the approval that is already in force: it needs no new approval, and it never writes a changed one. It runs
//   - after every passed browser check (`afterPassedRound`),
//   - on a planning read of the project (`forPlanning`), when a definition has `E2E_SYNTHETIC_ACCOUNT_RENEWAL_DAYS` or fewer days left, or has lapsed.
// It reads the contract from the APPROVED stored proposal, never from the repository as it is now: a repository that changed since the approval is a change that waits for approval, and renewal never carries it.
// A renewal that cannot be written is a served fault (the page says so, and the task that skipped its browser check says the same), not a quiet skip.
import {
  E2E_SYNTHETIC_ACCOUNT_RENEWAL_DAYS, E2EApplicationAccountDefinitionSchema, Ec2RuntimeBindingSchema, canonicalJson, change, inspectE2ERepository, projectPk, projectRevisionKey, queryAll, readE2EApplicationProjectContract, when,
  type DocumentStore, type E2ESourceSnapshot, type ObjectStorage, type OrgId, type TransactItem,
} from "@agentx/contracts";
import { accountDefinitionRow, accountLatestRow, e2eAccountDefinitionKey, e2eAccountLatestKey, planSyntheticAccountWrites } from "../../e2e/application-account-registry.js";
import { readAccountRegistryEntries } from "../e2e/account-registry.js";
import { BROWSER_TESTING_WORDS, browserSignInKey, browserStateKey } from "./browser-testing-state.js";
import { readApproved } from "./browser-testing-proposal.js";

const DAY_MS = 86_400_000;
const LATEST_PREFIX = "E2E_ACCOUNT_LATEST#";

export interface BrowserRenewalDeps {
  store: DocumentStore; companyId: OrgId; objects: ObjectStorage; now: () => number;
  log?: ((entry: Record<string, unknown>) => void) | undefined;
}

export type RenewalResult = { status: "none" } | { status: "renewed"; accounts: number } | { status: "failed" };

/** Whether any registered account of the project has `E2E_SYNTHETIC_ACCOUNT_RENEWAL_DAYS` or fewer days left (or has lapsed). Reads pointers and definitions only: the cheap test before anything bigger is read. */
export async function accountsNeedRenewal(deps: Pick<BrowserRenewalDeps, "store" | "companyId" | "now">, project: string, withinMs = E2E_SYNTHETIC_ACCOUNT_RENEWAL_DAYS * DAY_MS): Promise<boolean> {
  const pointers = await queryAll(deps.store, { pk: projectPk(deps.companyId, project), sk: { op: "beginsWith", prefix: LATEST_PREFIX } });
  for (const pointer of pointers) {
    const [applicationId, profileId] = String(pointer.sk).slice(LATEST_PREFIX.length).split("#");
    if (applicationId === undefined || profileId === undefined || typeof pointer["revision"] !== "number") return true;
    const definition = E2EApplicationAccountDefinitionSchema.safeParse(stripKeys(await deps.store.get(e2eAccountDefinitionKey(deps.companyId, project, applicationId, profileId, pointer["revision"]))));
    // A definition that cannot be read is not renewed here (repairing it is an approval's job), and it is not "needing renewal" either.
    if (definition.success && Date.parse(definition.data.expiresAt) - deps.now() <= withinMs) return true;
  }
  return false;
}

function stripKeys(row: Record<string, unknown> | undefined): unknown {
  if (row === undefined) return undefined;
  const { pk: _pk, sk: _sk, entityType: _type, ...body } = row;
  void _pk; void _sk; void _type;
  return body;
}

/** Whether a renewed definition is the registered one with only its revision and expiry moved. */
const sameButForTerm = (left: unknown, right: unknown): boolean => {
  const bare = (value: unknown) => { const { revision: _revision, expiresAt: _expiresAt, ...rest } = (value ?? {}) as Record<string, unknown>; void _revision; void _expiresAt; return canonicalJson(rest); };
  return bare(left) === bare(right);
};

/**
 * The renewal writes for the project's accounts, read against the APPROVED snapshot's contracts: for each synthetic account whose definition is the one the approved contract implies and is near its expiry
 * (or lapsed), the next revision of the same definition. Anything else (an account never written, an unreadable one, a definition that differs from what the approved contract implies) is left alone: writing
 * it would be a change, and a change needs an approval.
 */
export async function planAccountRenewals(deps: Pick<BrowserRenewalDeps, "store" | "companyId" | "now">, project: string, snapshot: E2ESourceSnapshot, proposalSha256: string): Promise<{ items: TransactItem[]; accounts: number }> {
  const items: TransactItem[] = [];
  let accounts = 0;
  const inspection = inspectE2ERepository(snapshot, snapshot.candidate).inspection;
  for (const application of inspection.applications) {
    let contract: ReturnType<typeof readE2EApplicationProjectContract>;
    try { contract = readE2EApplicationProjectContract(snapshot, application.applicationId); } catch { continue; }
    if (contract === null) continue;
    const pairs = contract.accountProfiles.filter((profile) => profile.scope === "synthetic-test").map((profile) => ({ applicationId: application.applicationId, profileId: profile.profileId }));
    const read = await readAccountRegistryEntries({ store: deps.store }, deps.companyId, project, pairs);
    // No `setup` and no `repairs`: the plan can only renew what is there or write a changed definition, and a changed one is skipped below.
    const writes = planSyntheticAccountWrites({ contract, applicationId: application.applicationId, prior: read.entries, now: deps.now() });
    for (const write of writes) {
      if (write.previousRevision === null || write.repair === true || write.touch === true) continue;
      const previous = read.entries.find((entry) => entry.definition.applicationId === write.definition.applicationId && entry.definition.profileId === write.definition.profileId);
      if (previous === undefined || previous.latest.revision !== write.previousRevision || !sameButForTerm(write.definition, previous.definition)) continue;
      const pointer = await deps.store.get(e2eAccountLatestKey(deps.companyId, project, write.definition.applicationId, write.definition.profileId));
      const approvedAt = typeof pointer?.["setupApprovedAt"] === "string" ? pointer["setupApprovedAt"] : undefined;
      const sha = typeof pointer?.["setupProposalSha256"] === "string" ? pointer["setupProposalSha256"] : proposalSha256;
      items.push(
        { kind: "put", item: accountDefinitionRow(deps.companyId, project, write.definition) as never, condition: when.absent() },
        { kind: "put", item: accountLatestRow(deps.companyId, project, write.definition.applicationId, write.definition.profileId, write.latest, approvedAt === undefined ? undefined : { approvedAt, proposalSha256: sha }) as never,
          condition: when.eq("revision", write.previousRevision) },
      );
      accounts += 1;
    }
  }
  return { items, accounts };
}

async function recordFault(deps: BrowserRenewalDeps, project: string, failed: boolean): Promise<void> {
  const key = browserStateKey(deps.companyId, project);
  try {
    if (failed) { await deps.store.update({ key, ops: [change.set("renewalFault", { at: new Date(deps.now()).toISOString(), code: "accounts-refresh-failed" })] }); return; }
    if ((await deps.store.get(key))?.["renewalFault"] !== undefined) await deps.store.update({ key, ops: [change.remove("renewalFault")] });
  } catch (error) { deps.log?.({ event: "browser_testing.renewal_fault_unrecorded", error: error instanceof Error ? error.name : "unknown" }); }
}

/** Renews against a snapshot already in hand (the planning seam decoded the approved one). Never throws: a failure is the `failed` result and the served fault. */
export async function renewWithSnapshot(deps: BrowserRenewalDeps, project: string, snapshot: E2ESourceSnapshot, proposalSha256: string): Promise<RenewalResult> {
  try {
    if (!(await accountsNeedRenewal(deps, project))) { await recordFault(deps, project, false); return { status: "none" }; }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const plan = await planAccountRenewals(deps, project, snapshot, proposalSha256);
      if (plan.items.length === 0) { await recordFault(deps, project, false); return { status: "none" }; }
      // A lost race is another renewal (or a change) that landed first: the plan is read again, and nothing is written twice.
      if ((await deps.store.transact(plan.items)).applied) { await recordFault(deps, project, false); return { status: "renewed", accounts: plan.accounts }; }
    }
    throw new Error("renewal lost its race twice");
  } catch (error) {
    deps.log?.({ event: "browser_testing.renewal_failed", project, error: error instanceof Error ? error.name : "unknown" });
    await recordFault(deps, project, true);
    return { status: "failed" };
  }
}

/** The approved setup of a task's pinned project revision, read and verified: its files, and the proposal digest the approval holds. Undefined when there is none or it cannot be read whole. */
async function approvedSetupOf(deps: BrowserRenewalDeps, project: string, revision: number): Promise<{ snapshot: E2ESourceSnapshot; proposalSha256: string } | undefined> {
  const row = await deps.store.get(projectRevisionKey(deps.companyId, project, revision));
  const approval = row?.["setupApproval"] as { decision?: unknown; proposalRef?: unknown; proposalSha256?: unknown; candidateDigest?: unknown } | undefined;
  const definition = row?.["definition"] as { repositories?: Array<{ name?: unknown; url?: unknown; defaultBranch?: unknown }> } | undefined;
  const repository = definition?.repositories?.length === 1 ? definition.repositories[0] : undefined;
  if (row === undefined || approval?.decision !== "approve" || typeof approval.proposalRef !== "string" || typeof approval.proposalSha256 !== "string" || typeof approval.candidateDigest !== "string"
    || typeof row["registeredBy"] !== "string" || repository === undefined || typeof repository.name !== "string" || typeof repository.url !== "string" || !Ec2RuntimeBindingSchema.safeParse(row["runtimeBinding"]).success) return undefined;
  const read = await readApproved(deps.objects, { proposalRef: approval.proposalRef, proposalSha256: approval.proposalSha256, candidateDigest: approval.candidateDigest },
    { name: repository.name, url: repository.url, defaultBranch: typeof repository.defaultBranch === "string" ? repository.defaultBranch : "main" }, row["registeredBy"]);
  return read === undefined ? undefined : { snapshot: read.snapshot, proposalSha256: approval.proposalSha256 };
}

/** After a passed browser check of a task pinned to `revision`: renew near-expiry accounts of the approved setup. Never throws. */
export async function renewAfterPassedRound(deps: BrowserRenewalDeps, project: string, revision: number): Promise<RenewalResult> {
  try {
    if (!(await accountsNeedRenewal(deps, project))) return { status: "none" };
    const approved = await approvedSetupOf(deps, project, revision);
    if (approved === undefined) return { status: "none" };
    return await renewWithSnapshot(deps, project, approved.snapshot, approved.proposalSha256);
  } catch (error) {
    deps.log?.({ event: "browser_testing.renewal_failed", project, error: error instanceof Error ? error.name : "unknown" });
    return { status: "failed" };
  }
}

/** The one reason a planning read gives when the renewal failed: the task that skipped its browser check says what the page says. */
export const RENEWAL_FAILED_REASON = BROWSER_TESTING_WORDS.accountsRefresh;

// ---- sign-in results

export interface SignInScenario { accountLabel: string; status: string; reason?: string | undefined }

/**
 * What a finished round says about each kind of user: a user whose cases were decided (passed or failed on their own assertions) signed in; a user whose cases could not run because the sign-in was
 * refused did not. Anything else (the round never reached the user, the label is not a plain profile id) is no record, never a guess. `loginFailedSentence` is the owner sentence of the `login-failed` group code.
 */
export function signInOutcomes(scenarios: readonly SignInScenario[], loginFailedSentence: string): Map<string, "ok" | "refused"> {
  const outcomes = new Map<string, "ok" | "refused">();
  for (const scenario of scenarios) {
    if (scenario.accountLabel === "rovara-anonymous" || scenario.accountLabel === "account") continue;
    if (scenario.status === "PASSED" || scenario.status === "FAILED") outcomes.set(scenario.accountLabel, "ok");
    else if (scenario.status === "UNKNOWN" && scenario.reason === loginFailedSentence && outcomes.get(scenario.accountLabel) !== "ok") outcomes.set(scenario.accountLabel, "refused");
  }
  return outcomes;
}

/** Keeps the latest result per kind of user. Never throws. */
export async function recordSignIns(deps: Pick<BrowserRenewalDeps, "store" | "companyId" | "now" | "log">, project: string, outcomes: ReadonlyMap<string, "ok" | "refused">): Promise<void> {
  const at = new Date(deps.now()).toISOString();
  for (const [profileId, status] of outcomes) {
    try { await deps.store.put({ item: { ...browserSignInKey(deps.companyId, project, profileId), entityType: "E2E_BROWSER_SIGNIN", orgId: deps.companyId, project, profileId, status, checkedAt: at } }); }
    catch (error) { deps.log?.({ event: "browser_testing.signin_unrecorded", error: error instanceof Error ? error.name : "unknown" }); }
  }
}
