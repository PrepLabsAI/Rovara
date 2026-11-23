// Browser testing in a project's setup (owner decisions 417, 420, 421): the write path of the core's route family `/v1/app/projects/{project}/browser-testing` (core-host/browser-testing-routes.ts).
//
//   refresh   reads the repository at its default branch's head: which kinds of user it declares, how the app starts, whether it declares a sign-in. Creates or refreshes the DRAFT (and, while browser testing is
//             on, the newer change beside the approved one). The files are stored once, content-addressed; the draft points at them.
//   choices   the two things an owner picks: the proof kept and the time limit of a check. Conditional on the draft revision the person saw.
//   check     makes a CANDIDATE revision of the project (apply.ts `storeSetupCandidate`: stored, never the project's latest, so no task starts on it) whose policy is the owner's choices over the stored files, and
//             starts the existing commands check on it. The draft cannot change while the candidate waits.
//   decision  through the ONE approval gate (setup-approval.ts), by a live company owner or admin only. Approving writes the policy, the approval and the test accounts in the decision's own transaction.
//   discard   drops a waiting browser testing candidate; the draft stays.
//   pause     new plans skip browser checks; plans already approved keep theirs (the pause is read only by the planning seam).
//
// What it never does: store a password, a secret or a token; sign in to anything; change the address (the sandbox address is Rovara's and is not shown); or write a company policy any other way (the old admin
// route still refuses a named company, broker.ts `NAMED_COMPANY_SETUP_APPROVAL_REFUSED`).
import {
  ProjectDefinitionSchema, agentXError, canonicalJson, change, projectPk, projectRevisionKey, queryAll, when,
  type AgentXError, type E2EReadyRuntimeProfile, type E2ESourceSnapshot, type ObjectStorage, type OrgId,
} from "@agentx/contracts";
import { z } from "zod";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import { discardSetupApply, readSetupApply, setupApplyKey, storeSetupCandidate, waitingSetupApply, type SetupApplyRow } from "./apply.js";
import { browserApprovalKey } from "./browser-testing-approval.js";
import {
  BROWSER_PROOF_DEFAULT, BROWSER_RUN_TIMEOUT_DEFAULT_MS, BROWSER_RUN_TIMEOUT_MAX_MS, BROWSER_RUN_TIMEOUT_MIN_MS, BROWSER_SIGNIN_SK_PREFIX, BROWSER_TESTING_WORDS, BrowserDraftRowSchema, BrowserProofSchema, BrowserSignInRowSchema,
  BrowserStateRowSchema, browserDraftKey, browserStateKey,
  type BrowserCandidateFacts, type BrowserDraftRow, type BrowserFound, type BrowserProof,
} from "./browser-testing-state.js";
import {
  browserPolicy, proposalObject, readApproved, readRepository, readSource, sourceObject, storeProposalObject, storeSourceObject, type BrowserRepository,
} from "./browser-testing-proposal.js";

export interface BrowserTestingDeps {
  flow: TaskFlowDeps;
  objects: ObjectStorage;
  now: () => number;
  /** Reads the repository at the head of its default branch, as the sandbox will see it. Throws when it cannot (the code host is down, the repository is not one Rovara can read). */
  capture: (repository: BrowserRepository) => Promise<E2ESourceSnapshot>;
  /** The web and API runtime profiles READY for this project, for the proposal's targets. */
  readyProfiles: (project: string) => Promise<readonly E2EReadyRuntimeProfile[]>;
  /** Whether Rovara can start the sandbox for this project right now (a ready runtime that passed every egress probe). */
  sandboxAvailable: (project: string) => Promise<boolean>;
}

const REQUEST_ID = z.string().uuid();
export const RefreshBodySchema = z.object({ requestId: REQUEST_ID }).strict();
export const ChoicesBodySchema = z.object({
  requestId: REQUEST_ID, expectedDraftRevision: z.number().int().min(1),
  proof: BrowserProofSchema.optional(), runTimeoutMs: z.number().int().min(BROWSER_RUN_TIMEOUT_MIN_MS).max(BROWSER_RUN_TIMEOUT_MAX_MS).optional(),
}).strict().refine((body) => body.proof !== undefined || body.runTimeoutMs !== undefined, { message: "nothing to change" });
export const CheckBodySchema = z.object({ requestId: REQUEST_ID, expectedDraftRevision: z.number().int().min(1) }).strict();
export const SimpleBodySchema = z.object({ requestId: REQUEST_ID }).strict();

/** A strict body or the fixed refusal (the field names, never the values). */
export function parseBody<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  throw agentXError("CONFIG_INVALID", BROWSER_TESTING_WORDS.invalid);
}

const iso = (deps: Pick<BrowserTestingDeps, "now">): string => new Date(deps.now()).toISOString();
const draftOf = (raw: unknown): BrowserDraftRow | undefined => { const parsed = BrowserDraftRowSchema.safeParse(raw); return parsed.success ? parsed.data : undefined; };

/** The project's one repository, or the fixed reason browser testing cannot be set up on it. */
function repositoryOf(definition: { repositories: ReadonlyArray<{ name: string; url: string; defaultBranch: string; host?: { kind: string } | undefined }> }): BrowserRepository {
  if (definition.repositories.length !== 1) throw agentXError("CONFIG_INVALID", BROWSER_TESTING_WORDS.oneRepository);
  const only = definition.repositories[0]!;
  return { name: only.name, url: only.url, defaultBranch: only.defaultBranch, ...(only.host === undefined ? {} : { host: { kind: only.host.kind } }) };
}

async function latestOf(deps: BrowserTestingDeps, project: string): Promise<{ definition: NonNullable<Awaited<ReturnType<TaskFlowDeps["projects"]["latest"]>>>["definition"]; row: Record<string, unknown> }> {
  const latest = await deps.flow.projects.latest(project);
  if (latest === undefined) throw agentXError("NOT_FOUND", BROWSER_TESTING_WORDS.projectNotFound);
  if (latest.archived === true) throw agentXError("PROJECT_ARCHIVED", BROWSER_TESTING_WORDS.archived);
  const row = await deps.flow.store.get(projectRevisionKey(deps.flow.companyId, project, latest.definition.revision));
  if (row === undefined) throw agentXError("RUNTIME_UNAVAILABLE", BROWSER_TESTING_WORDS.unreadable);
  return { definition: latest.definition, row };
}

// ---- the page's read

export interface BrowserSummary { found: BrowserFound; proof: BrowserProof; runTimeoutMs: number }
export interface BrowserTestingView {
  project: string; canManage: boolean; viewerRole: string;
  state: "not-set-up" | "draft" | "checking" | "check-failed" | "waiting" | "on" | "paused";
  paused: boolean; sandboxAvailable: boolean; faults: string[];
  /** A setup change of another kind (commands, a website) is waiting: browser testing cannot change until it is decided. */
  setupWaiting: boolean;
  draft: { revision: number; foundAt: string; found: BrowserFound; proof: BrowserProof; runTimeoutMs: number; locked: boolean; stale: boolean } | null;
  /** The waiting browser testing change, rendered from its STORED proposal (what was checked), never from the draft. */
  candidate: { status: "checking" | "ready" | "failed"; failedStep?: string; checkedAt?: string; revision: number; summary: BrowserSummary | null;
    approval: { requestId: string; revision: number; artifactDigest: string } | null; canApprove: boolean } | null;
  approved: { revision: number; approvedAt: string | null; approvedBy: string | null; decidedByYou: boolean; summary: BrowserSummary | null } | null;
  /** A newer repository read or choice beside the approved setup; the approved one stays in force until it is approved. */
  newerChange: { kind: "repo" | "choices"; found: BrowserFound; newUserKinds: string[]; removedUserKinds: string[]; proof: BrowserProof; runTimeoutMs: number } | null;
  accounts: Array<{ profileId: string; roleRef: string; signInPath: string | null; lastSignIn: { status: "ok" | "refused"; checkedAt: string } | null }>;
}

function summaryOfPolicy(found: BrowserFound, policy: unknown): BrowserSummary {
  const record = (policy ?? {}) as { capture?: { screenshotMode?: string; video?: unknown }; limits?: { runTimeoutMs?: unknown } };
  return {
    found, proof: { screenshotMode: record.capture?.screenshotMode === "all" ? "all" : "failed", video: record.capture?.video === true },
    runTimeoutMs: typeof record.limits?.runTimeoutMs === "number" ? record.limits.runTimeoutMs : BROWSER_RUN_TIMEOUT_DEFAULT_MS,
  };
}

const userKindIds = (found: BrowserFound): string[] => found.applications.flatMap((application) => application.userKinds.map((kind) => kind.profileId));

/** What the page reads. Every fact comes from a stored row or a stored, re-verified proposal; nothing is computed from the repository here. */
export async function browserTestingView(deps: BrowserTestingDeps, input: { project: string; canManage: boolean; viewerRole: string; personId: string; canDecide: boolean }): Promise<BrowserTestingView> {
  const { flow } = deps;
  const orgId = flow.companyId;
  const { project } = input;
  const latest = await flow.projects.latest(project);
  if (latest === undefined) throw agentXError("NOT_FOUND", BROWSER_TESTING_WORDS.projectNotFound);
  const latestRow = await flow.store.get(projectRevisionKey(orgId, project, latest.definition.revision));
  const repository = latest.definition.repositories.length === 1 ? repositoryOf(latest.definition) : undefined;
  const [draftRaw, applyRow, stateRaw, approvalRaw] = await Promise.all([
    flow.store.get(browserDraftKey(orgId, project)), readSetupApply({ flow, store: flow.store, companyId: orgId, now: deps.now }, project),
    flow.store.get(browserStateKey(orgId, project)), flow.store.get(browserApprovalKey(orgId, project)),
  ]);
  const state = BrowserStateRowSchema.safeParse(stateRaw ?? {});
  const paused = state.success && state.data.paused === true;
  const faults: string[] = [];
  if (state.success && state.data.renewalFault !== undefined) faults.push(state.data.renewalFault.code);
  const sandboxAvailable = await deps.sandboxAvailable(project).catch(() => false);
  if (!sandboxAvailable) faults.push("sandbox-unavailable");

  // What is in force: the latest revision holds a policy and the approval that was proved for it.
  const approvalRef = latestRow?.["setupApproval"] as { proposalRef?: unknown; proposalSha256?: unknown; candidateDigest?: unknown; decision?: unknown } | undefined;
  const hasPolicy = latest.definition.e2e !== undefined;
  let approved: BrowserTestingView["approved"] = null;
  if (hasPolicy && approvalRef?.decision === "approve" && typeof approvalRef.proposalRef === "string" && typeof approvalRef.proposalSha256 === "string" && typeof approvalRef.candidateDigest === "string" && repository !== undefined) {
    const read = typeof latestRow?.["registeredBy"] === "string"
      ? await readApproved(deps.objects, { proposalRef: approvalRef.proposalRef, proposalSha256: approvalRef.proposalSha256, candidateDigest: approvalRef.candidateDigest }, repository, latestRow["registeredBy"]) : undefined;
    const fact = approvalRaw?.["revision"] === latest.definition.revision ? approvalRaw : undefined;
    if (read === undefined) faults.push("approved-setup-unreadable");
    approved = {
      revision: latest.definition.revision, approvedAt: typeof fact?.["approvedAt"] === "string" ? fact["approvedAt"] : null, approvedBy: typeof fact?.["approvedBy"] === "string" ? fact["approvedBy"] : null,
      decidedByYou: fact?.["approvedBy"] === input.personId, summary: read === undefined ? null : summaryOfPolicy(read.found, read.policy),
    };
  }

  const draft = draftOf(draftRaw);
  const waiting = applyRow !== undefined && applyRow.state === "checking" ? applyRow : undefined;
  const waitingBrowser = waiting?.browserTesting === undefined ? undefined : waiting;
  const setupWaiting = waiting !== undefined && waitingBrowser === undefined;

  let candidate: BrowserTestingView["candidate"] = null;
  if (waitingBrowser !== undefined && repository !== undefined) {
    const facts = waitingBrowser.browserTesting!;
    const registeredBy = (await flow.store.get(projectRevisionKey(orgId, project, waitingBrowser.baseRevision)))?.["registeredBy"];
    const stored = typeof registeredBy === "string" ? await readApproved(deps.objects, facts, repository, registeredBy) : undefined;
    const ready = waitingBrowser.checkState.status === "ready";
    candidate = {
      status: waitingBrowser.checkState.status === "failed" ? "failed" : ready ? "ready" : "checking",
      ...(waitingBrowser.checkState.failedStep === undefined ? {} : { failedStep: waitingBrowser.checkState.failedStep }),
      ...(waitingBrowser.checkState.checkedAt === undefined ? {} : { checkedAt: waitingBrowser.checkState.checkedAt }),
      revision: waitingBrowser.candidateRevision, summary: stored === undefined ? null : summaryOfPolicy(stored.found, stored.policy),
      approval: ready ? { requestId: `setup-${waitingBrowser.digest.slice(0, 40)}-${String(waitingBrowser.candidateRevision)}`, revision: waitingBrowser.candidateRevision, artifactDigest: waitingBrowser.digest } : null,
      canApprove: ready && input.canDecide,
    };
  }

  let newerChange: BrowserTestingView["newerChange"] = null;
  if (approved?.summary != null && draft !== undefined && draft.baseRevision <= latest.definition.revision) {
    const sameFacts = canonicalJson(draft.found) === canonicalJson(approved.summary.found);
    const sameChoices = canonicalJson(draft.proof) === canonicalJson(approved.summary.proof) && draft.runTimeoutMs === approved.summary.runTimeoutMs;
    if (!sameFacts || !sameChoices) {
      const was = new Set(userKindIds(approved.summary.found)), now = new Set(userKindIds(draft.found));
      newerChange = { kind: sameFacts ? "choices" : "repo", found: draft.found, newUserKinds: [...now].filter((id) => !was.has(id)), removedUserKinds: [...was].filter((id) => !now.has(id)), proof: draft.proof, runTimeoutMs: draft.runTimeoutMs };
    }
  }

  const shownFound = candidate?.summary?.found ?? approved?.summary?.found ?? draft?.found ?? null;
  const signIns = new Map<string, { status: "ok" | "refused"; checkedAt: string }>();
  for (const item of await queryAll(flow.store, { pk: projectPk(orgId, project), sk: { op: "beginsWith", prefix: BROWSER_SIGNIN_SK_PREFIX } })) {
    const parsed = BrowserSignInRowSchema.safeParse(item);
    if (parsed.success) signIns.set(parsed.data.profileId, { status: parsed.data.status, checkedAt: parsed.data.checkedAt });
  }
  const accounts = (shownFound?.applications ?? []).flatMap((application) => application.userKinds).map((kind) => ({ ...kind, lastSignIn: approved === null ? null : signIns.get(kind.profileId) ?? null }));

  const viewState: BrowserTestingView["state"] = approved !== null ? (paused ? "paused" : "on")
    : candidate !== null ? (candidate.status === "failed" ? "check-failed" : candidate.status === "ready" ? "waiting" : "checking") : draft !== undefined ? "draft" : "not-set-up";
  return {
    project, canManage: input.canManage, viewerRole: input.viewerRole, state: viewState, paused, sandboxAvailable, faults, setupWaiting,
    draft: draft === undefined ? null : {
      revision: draft.draftRevision, foundAt: draft.foundAt, found: draft.found, proof: draft.proof, runTimeoutMs: draft.runTimeoutMs,
      locked: waiting !== undefined, stale: draft.baseRevision !== latest.definition.revision && approved === null,
    },
    candidate, approved, newerChange, accounts,
  };
}

// ---- writes

const anotherWaiting = (): AgentXError => agentXError("WORKSPACE_BUSY", BROWSER_TESTING_WORDS.anotherWaiting);
const stale = () => agentXError("CHANGE_STALE", BROWSER_TESTING_WORDS.stale);
/** Nothing changes while a candidate waits: the draft is what the candidate was made from. The condition is checked inside every write's own transaction too. */
const notWaiting = (orgId: OrgId, project: string) => ({ kind: "check" as const, key: setupApplyKey(orgId, project), condition: when.or(when.absent(), when.not(when.eq("state", "checking"))) });

/** Creates or refreshes the draft from the repository as it is now. Idempotent per request id. */
export async function refreshDraft(deps: BrowserTestingDeps, project: string, by: string, body: z.infer<typeof RefreshBodySchema>): Promise<void> {
  const { flow } = deps;
  const orgId = flow.companyId;
  const key = browserDraftKey(orgId, project);
  const before = draftOf(await flow.store.get(key));
  if (before !== undefined && before.lastRequestId === body.requestId && before.updatedBy === by) return;
  const { definition } = await latestOf(deps, project);
  const repository = repositoryOf(definition);
  if ((await waitingSetupApply(flow.store, orgId, project)) !== undefined) throw anotherWaiting();
  let read: ReturnType<typeof readRepository>;
  try {
    read = readRepository(await deps.capture(repository), await deps.readyProfiles(project));
  } catch { throw agentXError("RUNTIME_UNAVAILABLE", BROWSER_TESTING_WORDS.unreadable); }
  const source = sourceObject({ companyId: orgId, project, repository, read });
  try { await storeSourceObject(deps.objects, source); } catch { throw agentXError("RUNTIME_UNAVAILABLE", BROWSER_TESTING_WORDS.unreadable); }
  const at = iso(deps);
  const row: BrowserDraftRow = {
    ...key, entityType: "E2E_BROWSER_DRAFT", orgId, project, draftRevision: (before?.draftRevision ?? 0) + 1, baseRevision: definition.revision,
    proof: before?.proof ?? { ...BROWSER_PROOF_DEFAULT }, runTimeoutMs: before?.runTimeoutMs ?? BROWSER_RUN_TIMEOUT_DEFAULT_MS,
    sourceRef: source.ref, sourceSha256: source.sha256, candidateDigest: read.candidateDigest, commitSha: read.commitSha, found: read.found, foundAt: at, updatedAt: at, updatedBy: by, lastRequestId: body.requestId,
  };
  const result = await flow.store.transact([
    { kind: "put", item: JSON.parse(JSON.stringify(row)) as never, condition: before === undefined ? when.absent() : when.eq("draftRevision", before.draftRevision) },
    notWaiting(orgId, project),
  ]);
  if (!result.applied) throw (await waitingSetupApply(flow.store, orgId, project)) !== undefined ? anotherWaiting() : stale();
  if (before !== undefined && before.sourceRef !== source.ref) await deps.objects.delete(before.sourceRef).catch(() => undefined);
}

/** The owner's two choices. Conditional on the draft revision they looked at, and refused while a candidate waits. */
export async function saveChoices(deps: BrowserTestingDeps, project: string, by: string, body: z.infer<typeof ChoicesBodySchema>): Promise<void> {
  const { flow } = deps;
  const orgId = flow.companyId;
  const key = browserDraftKey(orgId, project);
  const before = draftOf(await flow.store.get(key));
  if (before === undefined) throw agentXError("CHANGE_STALE", BROWSER_TESTING_WORDS.noDraft);
  if (before.lastRequestId === body.requestId && before.updatedBy === by) return;
  await latestOf(deps, project);
  if (before.draftRevision !== body.expectedDraftRevision) throw stale();
  if ((await waitingSetupApply(flow.store, orgId, project)) !== undefined) throw anotherWaiting();
  const ops = [
    change.set("draftRevision", before.draftRevision + 1), change.set("lastRequestId", body.requestId), change.set("updatedBy", by), change.set("updatedAt", iso(deps)),
    ...(body.proof === undefined ? [] : [change.set("proof", body.proof)]), ...(body.runTimeoutMs === undefined ? [] : [change.set("runTimeoutMs", body.runTimeoutMs)]),
  ];
  const result = await flow.store.transact([{ kind: "update", key, ops, condition: when.eq("draftRevision", before.draftRevision) }, notWaiting(orgId, project)]);
  if (!result.applied) throw (await waitingSetupApply(flow.store, orgId, project)) !== undefined ? anotherWaiting() : stale();
}

/** Stores the candidate and starts the commands check on it. What is checked, and what the owner will approve, is the stored proposal made from the draft's own stored files. */
export async function checkDraft(deps: BrowserTestingDeps, project: string, by: string, body: z.infer<typeof CheckBodySchema>): Promise<void> {
  const { flow } = deps;
  const orgId = flow.companyId;
  const replay = await flow.store.get(setupApplyKey(orgId, project));
  if (replay !== undefined && replay["requestId"] === body.requestId && replay["by"] === by && replay["browserTesting"] !== undefined) return;
  const draft = draftOf(await flow.store.get(browserDraftKey(orgId, project)));
  if (draft === undefined) throw agentXError("CHANGE_STALE", BROWSER_TESTING_WORDS.noDraft);
  if (draft.draftRevision !== body.expectedDraftRevision) throw stale();
  const { definition, row } = await latestOf(deps, project);
  if (draft.baseRevision !== definition.revision) throw stale();
  if ((await waitingSetupApply(flow.store, orgId, project)) !== undefined) throw anotherWaiting();
  if (draft.found.problem !== null) throw agentXError("CONFIG_INVALID", draft.found.problem === "too-many-user-kinds" ? BROWSER_TESTING_WORDS.tooManyKinds : BROWSER_TESTING_WORDS.needsInput);
  const registeredBy = row["registeredBy"];
  if (typeof registeredBy !== "string" || registeredBy === "" || row["runtimeBinding"] === undefined || !(await deps.sandboxAvailable(project).catch(() => false))) throw agentXError("RUNTIME_UNAVAILABLE", BROWSER_TESTING_WORDS.sandboxUnavailable);
  const repository = repositoryOf(definition);
  const read = await readSource(deps.objects, draft.sourceRef, draft.sourceSha256, repository);
  if (read === undefined || read.candidateDigest !== draft.candidateDigest) throw stale();
  const policy = browserPolicy({ proposal: read.proposal, proof: draft.proof, runTimeoutMs: draft.runTimeoutMs, policyRevision: (definition.e2e?.policyRevision ?? 0) + 1 });
  const proposal = proposalObject({ companyId: orgId, project, issuerOwnerKey: registeredBy, repository, read, policy });
  if (proposal === undefined) throw agentXError("CONFIG_INVALID", BROWSER_TESTING_WORDS.needsInput);
  try { await storeProposalObject(deps.objects, proposal); } catch { throw agentXError("RUNTIME_UNAVAILABLE", BROWSER_TESTING_WORDS.unreadable); }
  const candidate = ProjectDefinitionSchema.safeParse({ ...definition, revision: definition.revision + 1, e2e: policy });
  if (!candidate.success) throw agentXError("CONFIG_INVALID", BROWSER_TESTING_WORDS.invalid);
  const facts: BrowserCandidateFacts = { proposalRef: proposal.ref, proposalSha256: proposal.sha256, candidateDigest: read.candidateDigest, draftRevision: draft.draftRevision };
  await storeSetupCandidate({ flow, store: flow.store, companyId: orgId, now: deps.now }, {
    project, by, requestId: body.requestId, taskId: "", baseRevision: definition.revision, candidate: candidate.data, replyExtra: { browserTesting: true },
    // The draft must still be the one the check was made from when the candidate is stored.
    alsoTransact: [{ kind: "check", key: browserDraftKey(orgId, project), condition: when.eq("draftRevision", draft.draftRevision) }],
    digestExtra: { browserTesting: { proposalSha256: proposal.sha256, candidateDigest: read.candidateDigest } }, rowExtra: { browserTesting: facts },
  });
}

/** Drops the waiting browser testing candidate. A candidate of another kind (a setup run's) is not this page's to drop. */
export async function discardCandidate(deps: BrowserTestingDeps, project: string, by: string): Promise<void> {
  const waiting = await waitingSetupApply(deps.flow.store, deps.flow.companyId, project);
  if (waiting === undefined) return;
  if (waiting.browserTesting === undefined) throw anotherWaiting();
  await discardSetupApply({ store: deps.flow.store, companyId: deps.flow.companyId, now: deps.now }, project, by);
}

/** Pause and resume: new plans skip browser checks while paused; every approved plan keeps its checks. Idempotent. */
export async function setPaused(deps: BrowserTestingDeps, project: string, by: string, paused: boolean, requestId: string): Promise<void> {
  const { flow } = deps;
  const orgId = flow.companyId;
  const { definition } = await latestOf(deps, project);
  if (definition.e2e === undefined) throw agentXError("CHANGE_STALE", BROWSER_TESTING_WORDS.nothingWaiting);
  const key = browserStateKey(orgId, project);
  const before = BrowserStateRowSchema.safeParse((await flow.store.get(key)) ?? {});
  if (before.success && before.data.pauseRequestId === requestId) return;
  await flow.store.update({ key, ops: [change.set("paused", paused), change.set("pausedAt", iso(deps)), change.set("pausedBy", by), change.set("pauseRequestId", requestId)] });
}

/** The waiting browser testing candidate's row, when there is one (the decision route's own check that what it decides is this page's). */
export async function waitingBrowserCandidate(deps: Pick<BrowserTestingDeps, "flow">, project: string): Promise<SetupApplyRow | undefined> {
  const waiting = await waitingSetupApply(deps.flow.store, deps.flow.companyId, project);
  return waiting?.browserTesting === undefined ? undefined : waiting;
}

