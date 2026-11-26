// RD-2.0-READ-RULE: the ONE "may this person read this task" function. Five rules answered this question before, each its own way (the task read's own reader check, the stored share's
// fallback, the events' own owner-or-share test, the diff's People page rule, the plan and proof's owner rule); every caller now asks `decideTaskRead` with the read it is
// serving, and the table below says which kinds of person that read admits. A handler of a read never decides who may see the task: it is given the decision.
//
//   - The company is checked FIRST, before any seam is asked: another company's task, or none, is "not found" whatever else is true of the person.
//   - A read lists the ways it admits a person, in order (`ADMITTED_BY`). The core's own rule (`reads`, `acts`) is asked through the access port; the stored share (spec 067) and the old
//     People page rule come through `TaskReadSeams`, which the host binds once (their one implementation stays in aws/).
//   - The stored share is asked only after the core's own rule said "not found" (never after any other failure), and only for a task of the caller's own company. A share row with a role
//     this code does not know is NOT a share: fail closed, logged once per read, whatever the role might have meant (rule 8: an older reader cannot know if it is wider or narrower).
//   - A share admits a person to the task, and then `SHARED_PARTS` says per read whether that part is shown to that role; a part that is not shown answers TASK_PART_NOT_SHOWN with the
//     words below (never the missing task's answer for a person the page shows the task to).
//   - `money` and `sourceCode` are part of the decision, so a handler cannot show either by accident.
//   - OWNER DECISION 254zzz577 (READ-RULE-SHARE-B), three rules on top of the share cells below. (1) The STORED share works for a person with NO project grant, but ONLY a SAME-COMPANY person: the company is checked first for every read, and the
//     stored share's seam proves a live member of the TASK's company (not a project grant; where no company layer is wired it falls back to the project grant). The Slack CHANNEL share is NOT widened by this lane: it holds no individual grant, but its
//     person must still reach the project through one of its bound channels (the identity proof's `targetProjectAccess`), so a person with no project access at all is refused; it also needs the Slack proof of the install's own workspace (a
//     Slack Connect or foreign-workspace person is refused). Whether the channel share should work with no project access at all is an owner question and an identity-proof change. (2) REMOVAL WINS: a person the task's People list names `denied`
//     (a deny, or a removal) is never admitted by a share of either kind (the stored share's seam refuses them; the People rule, which the channel share goes through, refuses them). (3) The stored share and the People list's viewer ("Can view")
//     read the same page (the plan and the proof included) and can comment; a People viewer is still admitted only through the identity proof, which needs a project grant.
//   - OWNER DECISION 254zzz558 (option A): a person a task is SHARED with (the stored share, "Can view"; or the Slack channel it is shared into) reads the WHOLE task page, the code changes included, and can comment; a person with no
//     share is refused as before. So the share cells below are all "shown", and `ADMITTED_BY` lets both kinds of share into every part of the page: the task read, the events, the timeline, the question box (answers), the spec, the checks and their files, the code changes, the diff, the plan, the proof and the comments.
import { rethrowMembershipReadFailure } from "../membership-read.js";
import { AgentXError, agentXError, type OrgRole, type Principal } from "@agentx/contracts";
import { taskOwnerView } from "../../developer/task-owner-view.js";
import { taskNotFound } from "./access.js";
import type { TaskCaller, TaskFlowDeps } from "./deps.js";
import { readTask } from "./reads.js";
import type { TaskRecord } from "./records.js";

/** Every read that asks "may this person read this task". */
export type TaskRead =
  /** `GET /v1/dev/tasks/{id}` */ | "task"
  /** the answers read of a project (a question about a task) */ | "answers"
  /** the task list's round (`taskReadable`) */ | "readable"
  /** the merge standing's "a reader is told so" */ | "merge"
  /** `GET .../events` */ | "events"
  /** `.../readers`: the owner shares, a reader is told only the owner may */ | "share"
  /** `GET .../diff`: the code of a pull request */ | "diff"
  /** `GET .../plan` */ | "plan"
  /** `GET .../evidence` */ | "evidence"
  /** `GET .../comments`: the plan comments (the old People page rule, as the diff) */ | "comments"
  /** the task page's new reads (RD-2.0) */ | "spec" | "checks" | "changes" | "timeline"
  /** `GET /v1/app/tasks/{id}/evidence/{sha}` (RD-2d): the file behind a link of the checks read (command output, a screenshot); a part of the checks, so a share is not shown it */ | "evidenceFile";

/**
 * How the person was admitted (NOT who they are: a handler that wants "the owner" asks `mode === "owner"` and gets the task's own person on every read, and a co-owner only where the owner rule is the way in).
 * `owner`: the task's own person, or the company's owner rule. `reader`: the company's read rule (a co-owner, or a commenter or viewer of the People list; they are not told apart because that costs a second live proof). `page`: the old People page rule (the diff). `shared`: the stored share. `script`: a script token's own closed list.
 */
export type TaskReadMode = "owner" | "reader" | "page" | "shared" | "script";

/** The roles a stored share can hold today. A role that is not here is not a share. */
export const SHARED_ROLES = ["viewer"] as const;
export type SharedRole = (typeof SHARED_ROLES)[number];

/** What the stored share's seam answers: the row's role as stored (any text), for a person who is still a live member of the task's COMPANY (no project grant is needed) and whom the task's People list does not name `denied`; undefined for anyone else. */
export interface StoredShare { role: string }

/** The host's two old rules, bound once. A seam that is absent admits nobody by that way. */
export interface TaskReadSeams {
  /** The stored share (spec 067) of this person on this task of the caller's own company, with the live COMPANY membership proved (no project grant is needed, DEC 254zzz577) and the People list's deny (a removal) already applied. A throw is "no" (or a failure: see `ADMITTED_BY`). */
  sharedReader?(person: { developerId: string; name: string }, task: TaskRecord): Promise<StoredShare | undefined>;
  /**
   * The old People page rule (the diff, the comments): resolves when it admits, throws its own refusal when it does not. It resolves `{ holdsOwnTask: true }` when it admitted the task's own person by their stored id (a task
   * with no People list) and so ALREADY re-read their hold on their task (the hotfix's `requireOwnTask`): the live-grant seam is not asked a second time for that admission. A People entry is admitted without any grant read:
   * the seam asks for it. It resolves `{ viaChannelShare: true }` when it admitted a person the People list does not name, who reads only because the task is shared into a Slack channel they are in (live membership, the
   * project's channel-use switch): that person holds no grant by design, and `CHANNEL_SHARE_PARTS` says what it shows.
   */
  peoplePage?(task: TaskRecord): Promise<void | { holdsOwnTask: true } | { viaChannelShare: true }>;
  /**
   * The person's standing NOW: a current grant on the task's project IN THE TASK'S COMPANY (the repository's own access). The host passes the task's company, so the seam reads only that company's grant row (a person moved to another
   * company never has its same-named grant counted); the live company membership itself is checked once, at the start of the request. Asked after EVERY way of being admitted but the stored share (which proves its own project
   * membership), for the task's stored person with no People list exactly as for People entries: no path assumes the grant was proved. A person it refuses is not admitted by that way. A throw is "no".
   * Bound by the hosted host; absent on a laptop, where nothing is proved and so no source code is shown.
   */
  liveGrant?(person: { personId: string }, task: TaskRecord): Promise<boolean>;
}

export type Basis = "developer" | "acts" | "reads" | "page" | "shared" | "channel";

/**
 * The ways each read admits a person, in order: the one table of who may read what. `shared` is asked only after `reads` said not found, and a lookup that fails is "no". `developer` is the task's stored person. (Today's answers: the golden of tests/contract/rd-2-0-read-rule-golden.test.ts.)
 */
const ADMITTED_BY: Readonly<Record<TaskRead, readonly Basis[]>> = {
  task: ["reads", "shared", "channel"], answers: ["reads", "shared", "channel"], readable: ["reads"], merge: ["reads"],
  // The events are for everyone the task is shown to (a co-owner, the People list's commenters and viewers, a share); the readers routes stay the task's person and a share (told only the owner may share).
  events: ["developer", "reads", "shared", "channel"], share: ["developer", "shared"],
  // The page rule (People) first; then the stored share and, for the parts the page rule does not already cover, the Slack channel share (`channel`: only a person the People list does not name, who reads because the task is shared into a channel they are in).
  // READ-RULE-SHARE-B (rule 3, owner DEC 254zzz577): the People list's commenters and viewers ("Can view") read the plan and the proof like a share does (`reads` after `acts`: the owner rule still says "owner" first).
  diff: ["page", "shared"], comments: ["page", "shared"], plan: ["acts", "reads", "shared", "channel"], evidence: ["acts", "reads", "shared", "channel"],
  spec: ["reads", "shared", "channel"], checks: ["reads", "shared", "channel"], changes: ["reads", "shared", "channel"], timeline: ["reads", "shared", "channel"], evidenceFile: ["reads", "shared", "channel"],
};

/** What each shared role is shown, per read. Exhaustive over `SHARED_ROLES` and every read: a role or read with no cell does not compile. Only a read that `ADMITTED_BY` lets a share into is ever asked. The viewer is shown the whole task page, the code changes included (the owner's answer to Q1, DEC 254zzz558, option A). A `"withheld"` cell still answers TASK_PART_NOT_SHOWN with `SHARED_WORDS`. */
const SHARED_PARTS: Readonly<Record<SharedRole, Readonly<Record<TaskRead, "shown" | "withheld">>>> = {
  viewer: {
    task: "shown", answers: "shown", readable: "shown", merge: "shown", events: "shown", share: "shown", diff: "shown", comments: "shown", plan: "shown", evidence: "shown",
    spec: "shown", checks: "shown", changes: "shown", timeline: "shown", evidenceFile: "shown",
  },
};

/** The words of a part a share is not shown (TASK_PART_NOT_SHOWN, 403): the one table. */
const SHARED_WORDS = {
  lead: "The owner shared this task's summary with you.",
  fallback: "This part is not shown.",
  parts: { spec: "The plan is not shown.", checks: "The checks are not shown.", changes: "The code changes are not shown.", evidenceFile: "The checks are not shown." } as Partial<Record<TaskRead, string>>,
};
const sharedWords = (read: TaskRead): string => `${SHARED_WORDS.lead} ${SHARED_WORDS.parts[read] ?? SHARED_WORDS.fallback}`;

/**
 * WHAT A SLACK SHARE GRANTS (the owner's answer, DEC 254zzz558, option A): a person with NO project grant who reads a task only because it is shared into a bound Slack channel they are in (the old page rule's
 * implicit commenter: a stored People list, the person registered on it, the project letting channel members use it, live membership of the share's channel) reads the whole task page, the code changes included, and can
 * comment (the comment is judged by the comment action's own rule, which gives this person the People list's commenter role). Each read is its OWN cell, so a later answer is one line: `"withheld"` makes that read refuse such
 * a person as a missing task. The grant is not asked of them (they have none, by design); their decision carries source code and code details exactly because this table says the code is theirs to see (the diff cell is "shown").
 * A person with no share is not here at all, and neither is the task's own person (they are asked by their own ways in). The merge standing, the task list's round and the readers routes are not part of the page and are not here.
 */
export const CHANNEL_SHARE_PARTS: Readonly<Partial<Record<TaskRead, "shown" | "withheld">>> = {
  // The page the share opens: the task itself, its events and timeline, and the question box (the answers read, which may now cite the plan, a part of the page the share is shown).
  task: "shown",
  answers: "shown",
  events: "shown",
  timeline: "shown",
  comments: "shown",
  diff: "shown",
  plan: "shown",
  evidence: "shown",
  spec: "shown",
  checks: "shown",
  changes: "shown",
  evidenceFile: "shown",
};

/** The refusal of a read for a person who is not shown the task. The words differ by read as they did before the rules were one (a client that matched them still reads them). */
function refusal(read: TaskRead, taskId: string): AgentXError {
  return read === "events" || read === "share" ? agentXError("TASK_NOT_FOUND", `no task ${taskId} of yours`) : taskNotFound();
}

/** Figures belong to the stored task owner or a live company admin: a co-owner's right to act does not disclose another person's money (DEC 254zzz398). Scope budgets stay private. */
export function maySeeTaskMoney(input: { companyId: string; membershipCompanyId: string; principal: Pick<Principal, "companyId" | "personId">; scriptToken: boolean; role: OrgRole | undefined; task: Pick<TaskRecord, "companyId" | "developerId"> & { developerName?: unknown } }): boolean {
  return !input.scriptToken && input.principal.companyId === input.companyId && input.membershipCompanyId === input.companyId && input.task.companyId === input.companyId
    && (input.role === "owner" || input.role === "admin" || input.role === "member" && taskOwnerView(input.task)?.developerId === input.principal.personId);
}

/**
 * Whether THIS reader may read THIS task's source code: the patches AND the file paths of its changes (a path can reveal the structure of code; counts stay shown). The repository's own access in this codebase is the
 * person's live project grant (there is no per-person repository check), and it is true ONLY where that grant was re-read THIS request: by the live-grant seam for every way of being admitted (the stored person of a task with
 * no People list included), or by the stored share (which proves its own live company membership and whom the owner's DEC 254zzz577 lets read with no project grant: the code is theirs, like the channel share's), or (the owner's decision 254zzz558) by the Slack channel share, whose own table (`CHANNEL_SHARE_PARTS`) says the code is theirs to see: a person with
 * no grant who reads only because the task is shared into their channel. No seam (a laptop), no proof, no source code. A task of another company never has it.
 *
 * It is decided per reader and per task INSIDE `decideTaskRead`, so it runs on every request BEFORE any answer cache is consulted: a cache (the changes read's) must be keyed by the task and its pull request heads only,
 * hold the full answer, and be filtered through the CURRENT request's `decision.sourceCode` on every hit, so a reader who may not read source is never handed a cached diff or path list.
 */
export function mayReadSourceCode(reader: { grantProved: boolean; principal: Pick<Principal, "companyId"> }, task: Pick<TaskRecord, "companyId">): boolean {
  return reader.grantProved && task.companyId === reader.principal.companyId;
}

/**
 * Whether THIS reader may read the code-derived details of THIS task's checks: security scan items, review findings, failing-test names and output links (they quote or name code). The same rule as source code (`mayReadSourceCode`),
 * decided in the same place and so before any cache; the check states and counts stay visible to every reader the task is shown to.
 */
export function mayReadCodeDetails(reader: Parameters<typeof mayReadSourceCode>[0], task: Parameters<typeof mayReadSourceCode>[1]): boolean {
  return mayReadSourceCode(reader, task);
}

export interface TaskReadDecision {
  task: TaskRecord;
  mode: TaskReadMode;
  sharedRole?: SharedRole;
  /** The task's figures may be shown to this person (the company role rule, `maySeeTaskMoney`). */
  money: boolean;
  /** Source code may be shown to this person: the patches AND the file paths of the changes (`mayReadSourceCode`, decided for this reader and this task on every request). */
  sourceCode: boolean;
  /** Code-derived details of the checks may be shown to this person (`mayReadCodeDetails`); the states and counts always may. */
  codeDetails: boolean;
  /** Only `decideTaskRead` makes a decision: a function that takes one cannot be called without having asked the rule. */
  readonly decidedByReadRule: true;
}

export interface TaskReadInput {
  caller: TaskCaller;
  read: TaskRead;
  /** The caller's live company role from membership (for `money`); absent: no figures. */
  role?: OrgRole | undefined;
  /** The request is a script token's: it reads the task read alone, through its own closed list. */
  scriptToken?: boolean | undefined;
  seams?: TaskReadSeams | undefined;
}

interface Ask { deps: TaskFlowDeps; input: TaskReadInput; task: TaskRecord }
type Admission = { mode: TaskReadMode; sharedRole?: SharedRole; grantProved?: true; channelShare?: true } | undefined;

/** The core's own read rule: whoever may read (or, where the host has no separate read rule, act). A People denial reads as "no"; any other failure stays a failure. */
async function coreReads({ deps, input, task }: Ask): Promise<boolean> {
  const principal = input.caller.principal;
  try {
    return deps.access.canRead === undefined ? await deps.access.canAct(principal, task) : await deps.access.canRead(principal, task);
  } catch (error) {
    // A person the task's People list refuses reads exactly as for a task that does not exist (the People proof's own denial says the task has a list). Any other failure stays a failure.
    if (error instanceof AgentXError && error.code === "TASK_ACCESS_DENIED") return false;
    throw error;
  }
}

/** One function per way of being admitted. Each answers who the person is for that way, or undefined. */
const ADMIT: Readonly<Record<Basis, (ask: Ask) => Promise<Admission>>> = {
  developer: async ({ input, task }) => (task.developerId === input.caller.principal.personId ? { mode: "owner" } : undefined),
  // The owner rule: whoever may act. A failure of the rule is a failure of the read.
  acts: async ({ deps, input, task }) => (await deps.access.canAct(input.caller.principal, task) ? { mode: "owner" } : undefined),
  // The task's own person reads as "owner" on every read, a co-owner or a People reader as "reader".
  reads: async (ask) => (await coreReads(ask) ? { mode: ask.task.developerId === ask.input.caller.principal.personId ? "owner" : "reader" } : undefined),
  page: async ({ input, task }) => {
    const proof = await input.seams?.peoplePage?.(task);
    if (input.seams?.peoplePage === undefined) return undefined;
    if (proof === undefined) return { mode: "page" };
    if ("viaChannelShare" in proof) return CHANNEL_SHARE_PARTS[input.read] === "shown" ? { mode: "page", channelShare: true } : undefined;
    return { mode: "page", grantProved: true };
  },
  // The Slack channel share, for the reads the page rule is not listed on: asked only after every other way said no, and only a person the People list does not name (`viaChannelShare`) is admitted by it; a People entry is the core's own rule's.
  channel: async ({ input, task }) => {
    if (CHANNEL_SHARE_PARTS[input.read] !== "shown" || input.seams?.peoplePage === undefined || task.developerId === input.caller.principal.personId) return undefined;
    try {
      const proof = await input.seams.peoplePage(task);
      return proof !== undefined && "viaChannelShare" in proof ? { mode: "page", channelShare: true } : undefined;
    } catch (error) {
      if (isPageRefusal(error)) return undefined;
      throw error;
    }
  },
  shared: async ({ deps, input, task }) => {
    const sharedRole = await storedShare(deps, input, task);
    return sharedRole === undefined ? undefined : { mode: "shared", sharedRole };
  },
};

/** The old page rule's own "no" (the task is not shown to this person); any other failure of it stays a failure. */
const isPageRefusal = (error: unknown): error is AgentXError => error instanceof AgentXError && (error.code === "TASK_NOT_FOUND" || error.code === "TASK_ACCESS_DENIED");

/**
 * The decision for one read: who the person is to the task and what they may see, or a refusal. Throws TASK_NOT_FOUND for anyone no way admits (the same as for a task that does not exist),
 * TASK_PART_NOT_SHOWN for a person who is shown the task but not this part, and whatever the core's own rule fails with.
 */
export async function decideTaskRead(deps: TaskFlowDeps, input: TaskReadInput & ({ taskId: string } | { task: TaskRecord })): Promise<TaskReadDecision> {
  const { caller, read } = input;
  const task = "task" in input ? input.task : await readTask(deps, input.taskId);
  const taskId = "task" in input ? input.task.taskId : input.taskId;
  if (caller.principal.companyId !== deps.companyId || task === undefined || task.companyId !== deps.companyId) throw refusal(read, taskId);
  const ask: Ask = { deps, input, task };
  const decision = input.scriptToken === true ? await scriptDecision(ask) : await firstAdmission(ask);
  if (decision === undefined) throw refusal(read, taskId);
  return decision;
}

/** A script token reads the task read and (as far as the host then refuses it its own words) the proof index, through the owner rule's own closed list (the mount refuses it on every other path before it gets here), and is never shown source code. */
async function scriptDecision(ask: Ask): Promise<TaskReadDecision | undefined> {
  const { deps, input, task } = ask;
  if ((input.read !== "task" && input.read !== "evidence") || !(await deps.access.canAct(input.caller.principal, task))) return undefined;
  return await grantFor(ask, "acts") === "no" ? undefined : decisionOf(ask, { mode: "script" }, false);
}

/**
 * The first way of being admitted that holds, in the read's order, as a decision; a share that is admitted but not shown this part is told so. The People page rule says "no" by throwing its own refusal: where a way
 * after it (the stored share) may still admit the person, that refusal is kept and the next way is asked; if none admits, the page rule's own refusal is thrown, in its own words, as before.
 */
async function firstAdmission(ask: Ask): Promise<TaskReadDecision | undefined> {
  const ways = ADMITTED_BY[ask.input.read];
  let pageRefusal: AgentXError | undefined;
  for (const [index, basis] of ways.entries()) {
    const tried = await tryWay(ask, basis, index < ways.length - 1);
    if (tried.refusal !== undefined) { pageRefusal = tried.refusal; continue; }
    if (tried.admitted === undefined) continue;
    const decision = await admitBy(ask, basis, tried.admitted);
    if (decision !== undefined) return decision;
  }
  if (pageRefusal !== undefined) throw pageRefusal;
  return undefined;
}

/** One way in: who it admits, or (for the page rule, where a later way may still admit) its own refusal, kept. Any other failure stays a failure. */
async function tryWay(ask: Ask, basis: Basis, laterWays: boolean): Promise<{ admitted?: Admission; refusal?: AgentXError }> {
  try {
    return { admitted: await ADMIT[basis](ask) };
  } catch (error) {
    if (basis === "page" && laterWays && isPageRefusal(error)) return { refusal: error };
    throw error;
  }
}

/** A person admitted by one way: the live grant is re-read for EVERY way in but the stored share (which proves its own company membership; it needs no grant) and the channel share (no grant, by design): no path assumes the grant was proved, the task's stored person with no People list included. A share is then shown each part or not by its role. */
async function admitBy(ask: Ask, basis: Basis, admitted: NonNullable<Admission>): Promise<TaskReadDecision | undefined> {
  const grant = admitted.grantProved === true ? "yes" : admitted.channelShare === true ? "exempt" : await grantFor(ask, basis);
  if (grant === "no") return undefined;
  if (admitted.sharedRole !== undefined && SHARED_PARTS[admitted.sharedRole][ask.input.read] === "withheld") throw agentXError("TASK_PART_NOT_SHOWN", sharedWords(ask.input.read));
  return decisionOf(ask, admitted, grant === "yes" || grant === "exempt");
}

/** The decision for a person admitted this way: the task, how, and what they may be shown (money, source code and the checks' code details are decided here, for this reader and this task, on every request). */
function decisionOf({ deps, input, task }: Ask, admitted: NonNullable<Admission>, grantProved: boolean): TaskReadDecision {
  // `grantProved` is true where the live grant was re-read this request, or where the way in is the Slack channel share (its table says the code is the share's: no grant is asked of that person).
  const principal = input.caller.principal;
  const reader = { grantProved, principal };
  return {
    task, mode: admitted.mode, ...(admitted.sharedRole === undefined ? {} : { sharedRole: admitted.sharedRole }),
    money: input.role !== undefined && maySeeTaskMoney({ companyId: deps.companyId, membershipCompanyId: deps.companyId, principal, scriptToken: input.scriptToken === true, role: input.role, task }),
    sourceCode: mayReadSourceCode(reader, task),
    codeDetails: mayReadCodeDetails(reader, task),
    decidedByReadRule: true,
  };
}

/** Whether the way in already proves the live grant: the stored share (its own company membership: a share needs no grant) and the company's own rule where it says it re-reads the grant (`provesProjectGrant`); otherwise the host's live-grant seam is asked, once. */
async function grantFor(ask: Ask, basis: Basis): Promise<"yes" | "no" | "unbound"> {
  const own = basis === "shared" || ((basis === "acts" || basis === "reads") && ask.deps.access.provesProjectGrant === true);
  return own ? "yes" : liveGrantOf(ask);
}

/**
 * The live company membership and current project grant of the person, now: "yes", "no" (the way in is refused), or "unbound" (no seam: a laptop, where nothing is proved). A seam that throws is "no" (a membership or grant read that FAILED is the one retryable 503 instead). With no seam on an
 * access that says it proves the grant (the hosted host) the answer is "no", never "unbound": a host that forgets to bind the seam admits nobody by the ways that need it (fail closed, as the hotfix's own check does).
 */
async function liveGrantOf({ deps, input, task }: Ask): Promise<"yes" | "no" | "unbound"> {
  const seam = input.seams;
  if (seam?.liveGrant === undefined) return deps.access.provesProjectGrant === true ? "no" : "unbound";
  try {
    return await seam.liveGrant({ personId: input.caller.principal.personId }, task) ? "yes" : "no";
  } catch (error) {
    // A seam that answers is a fact; one whose membership or grant read FAILED is the retryable 503 (membership-read.ts), never "no" (which reads as "no such task").
    rethrowMembershipReadFailure(error);
    return "no";
  }
}

/** The stored share's role when it is one this code knows, a live company member's whom the People list does not deny, else undefined. An unknown role is logged and is no share. */
async function storedShare(deps: TaskFlowDeps, input: TaskReadInput, task: TaskRecord): Promise<SharedRole | undefined> {
  const seams = input.seams;
  if (seams?.sharedReader === undefined) return undefined;
  let found: StoredShare | undefined;
  try {
    found = await seams.sharedReader({ developerId: input.caller.principal.personId, name: input.caller.principal.displayName }, task);
  } catch (error) {
    rethrowMembershipReadFailure(error);
    // A lookup that fails is "no", on every read, and is said once in the log (fixed words: no person, no task, only the kind of failure).
    deps.log?.({ event: "developer.task_reader_lookup_failed", errorName: error instanceof Error ? error.name.slice(0, 40) : "unknown" });
    return undefined;
  }
  if (found === undefined) return undefined;
  const role = SHARED_ROLES.find((known) => known === found.role);
  if (role === undefined) {
    deps.log?.({ event: "developer.task_reader_unknown_role", taskId: task.taskId, role: String(found.role).slice(0, 40) });
    return undefined;
  }
  return role;
}
