// TASK-TAKEOVER PR A: who a hosted task's next step runs for, and who is charged for it.
//
// The rule (one place; `hostedTaskAccess.checkStep` asks it for every task that has a People list):
//   - A task with a People list never takes the starter rule. The step is allowed only when a CURRENT owner passes the live proof NOW: each `owner` entry is proved again (the People proof, then the live company
//     membership and the project grant), never taken from its stored role. An orphaned list, or no owner who passes: refused (the one no-owner sentence). A list or a proof that cannot be READ is not an answer: it throws (a retryable error), so the step is tried again and a blip never blocks the workflow.
//   - The step runs for, and is charged to, one of the owners who passed (`owner` in the verdict: it becomes the step's requester, which is the model gateway's payer). With one owner that is the owner. With several:
//       1. the owner whose latest decision on the task led to the step (an approval, a request for changes, a send-back), while they are still an owner who passed;
//       2. else the owner who took the task over most recently (a take-over or a hand-over, from the People events);
//       3. else the first owner of the People list.
//     Never a person without access, and never nobody.
//   - A step a person's PRESS made due (their approval, send-back, retry, answers, findings: the dispatch row's `by`, or the request's own) is charged to THAT person while they are still an owner who passed; a presser who
//     lost access by then gets the step refused in the one no-owner sentence, never charged to someone else; a presser the list no longer calls an owner (handed over, taken over,
//     denied) has no press that stands, and the order above applies. The order above is for steps nobody pressed.
//   - What the starter's earlier steps spent stays with the starter: only the steps from now on follow the owner.
//   - The verdict carries the People revision fence, so a change of who owns the task between the check and the step's commit refuses the step.
import { OWNER_LEFT_PROJECT_WORDS, OWNER_UNREADABLE_WORDS, agentXError, when, type DocumentStore, type OrgId, type TransactItem } from "@agentx/contracts";
import { resolveTaskListOwners, type TaskPeopleDependencies } from "../developer/task-people.js";
import { taskOwnerKey, type DeveloperTaskRecord } from "../developer/task-records.js";
import type { StepVerdict } from "../core/task-flow/deps.js";

/** Most People event rows one choice reads (a longer history is not read: the choice falls to the first owner of the list). */
const EVENTS_MAX = 200;

/** The People events that say a person took the task over: a take-over by themself, or a hand-over to them. */
export const TAKEOVER_EVENT_VIA = ["take_over", "hand_over"] as const;

interface Inputs {
  store: DocumentStore;
  companyId: OrgId;
  people: TaskPeopleDependencies;
  /** The live seam the rest of the access rule uses: a person's live membership of this company, and their grant on the project. */
  liveMember: (personId: string) => Promise<unknown>;
  projectGrant: (personId: string, project: string, checkedCompany?: string) => Promise<boolean>;
}

/** The owner who made the task's latest owner decision, among `live` (a decision records the actor's task key, never a person id). */
function latestDecisionOwner(stored: Record<string, unknown>, taskId: string, live: readonly string[]): string | undefined {
  const workflow = stored["workflow"] as { decisions?: unknown } | undefined;
  const decisions = Array.isArray(workflow?.decisions) ? workflow.decisions as Array<{ actorId?: unknown }> : [];
  const last = decisions.at(-1)?.actorId;
  return typeof last === "string" ? live.find((personId) => taskOwnerKey(personId, taskId) === last) : undefined;
}

/** The owner among `live` who took the task over most recently (People events of a take-over or a hand-over to them), or undefined when none did or the events do not read. */
async function latestTakeoverOwner(store: DocumentStore, taskId: string, live: readonly string[]): Promise<string | undefined> {
  let items: readonly Record<string, unknown>[];
  // The rows are keyed by request id, not by time, so a history longer than the bound cannot be read newest-first: one row past the bound is read, and a longer history is "not read" (the first owner of the list), never a guess from its oldest rows.
  try { items = (await store.query({ pk: `DEVTASK#${taskId}`, sk: { op: "beginsWith", prefix: "PEOPLE_EVENT#" }, limit: EVENTS_MAX + 1 })).items; } catch { return undefined; }
  if (items.length > EVENTS_MAX) return undefined;
  let best: { personId: string; at: string } | undefined;
  for (const item of items) {
    const target = item["targetDeveloperId"];
    const at = item["createdAt"];
    if (item["afterRole"] !== "owner" || typeof target !== "string" || typeof at !== "string" || !live.includes(target)) continue;
    if (!(TAKEOVER_EVENT_VIA as readonly unknown[]).includes(item["via"])) continue;
    if (best === undefined || at > best.at) best = { personId: target, at };
  }
  return best?.personId;
}

/**
 * The one person a step runs for, among the owners who passed the proof (in the list's order, never empty): the owner of the latest decision, else the latest take-over, else the first. `store` is read only when the
 * choice is not already decided by the owner count or the latest decision.
 */
export async function chooseStepOwner(input: { store: DocumentStore; taskId: string; stored: Record<string, unknown>; live: readonly string[] }): Promise<string> {
  const { live } = input;
  if (live.length === 1) return live[0]!;
  return latestDecisionOwner(input.stored, input.taskId, live) ?? await latestTakeoverOwner(input.store, input.taskId, live) ?? live[0]!;
}

const refused = (message: string): StepVerdict => ({ allowed: false, message });
const unreadable = (): Error => agentXError("RUNTIME_UNAVAILABLE", OWNER_UNREADABLE_WORDS);

/**
 * The owners the People proof passed that the access seam (the company's live member, with the project grant) also passes, in the list's order. A read of the seam that fails for every owner is not "nobody": it throws.
 */
async function liveOwnersOf(inputs: Inputs, project: string, ownerIds: readonly string[]): Promise<{ live: string[]; unread: string[] }> {
  const live: string[] = [];
  const unread: string[] = [];
  for (const personId of ownerIds) {
    try { if (await inputs.liveMember(personId) !== undefined && await inputs.projectGrant(personId, project, inputs.companyId)) live.push(personId); } catch { unread.push(personId); }
  }
  if (live.length === 0 && unread.length > 0) throw unreadable();
  return { live, unread };
}

/**
 * The step verdict for a task that has a People list (`stored` is its META row, read now). Allowed, naming the owner it rests on and fencing the People revision, only when a current owner passes the live proof now; refused
 * in the words table's sentences otherwise (`OWNER_LEFT_PROJECT_WORDS` when nobody who owns the task has access, `OWNER_UNREADABLE_WORDS` when who owns it could not be read). It never reads the task's starter as the person.
 */
export async function listStepVerdict(inputs: Inputs, task: { taskId: string; developerId: string; project: string }, stored: Record<string, unknown>, by?: string): Promise<StepVerdict> {
  // A read that fails is not an answer: it THROWS (a retryable error), so the step's dispatch row is tried again and a blip never blocks the workflow; only "nobody owns the task with the project" refuses.
  let found: Awaited<ReturnType<typeof resolveTaskListOwners>>;
  try { found = await resolveTaskListOwners(inputs.people, stored as unknown as DeveloperTaskRecord); } catch { throw unreadable(); }
  if (found === undefined || found.status === "UNKNOWN") throw unreadable();
  if (found.status === "OWNERLESS") return refused(OWNER_LEFT_PROJECT_WORDS);
  const { live, unread } = await liveOwnersOf(inputs, task.project, found.ownerIds);
  // A step a person's PRESS made due is charged to THEM, or refused: never to someone else. A presser the list still calls an owner who no longer passes (they lost the project by now) gets the step refused; a presser who
  // is no longer an owner of the task at all (handed over, taken over, denied) has no press that stands, and the order below applies as for a step nobody pressed.
  // (If the presser's own proof or membership could not be READ, nothing is known of them: that throws, it never says "no owner".)
  if (by !== undefined && !live.includes(by) && found.listed.includes(by)) {
    if (unread.includes(by) || found.unread.includes(by)) throw unreadable();
    return refused(OWNER_LEFT_PROJECT_WORDS);
  }
  if (live.length === 0) return refused(OWNER_LEFT_PROJECT_WORDS);
  const owner = by !== undefined && live.includes(by) ? by : await chooseStepOwner({ store: inputs.store, taskId: task.taskId, stored, live }).catch(() => { throw unreadable(); });
  const fence: TransactItem = { kind: "check", key: { pk: `DEVTASK#${task.taskId}`, sk: "PEOPLE" }, condition: when.eq("revision", found.peopleRevision) };
  const name = found.names.get(owner);
  return { allowed: true, owner: { personId: owner, ...(name === undefined ? {} : { name }) }, items: [fence] };
}

/** Whether a stored task is a setup run or a wiki build: those run on their own rule for the person they run for, People list or not. */
export const isSetupOrWikiRun = (stored: Record<string, unknown> | undefined): boolean => stored?.["purpose"] === "setup_agent" || stored?.["purpose"] === "wiki_build";

/**
 * The step verdict for a task, when the task has a People list: `listStepVerdict`, after the checks that the stored task is this company's own task as the step names it. Undefined when the starter's rule applies (no store
 * or task row to read, a setup run or wiki build, or a task with no People list). A list with no People dependencies to prove it with is refused (never the starter rule), and so is a stored task that is another's.
 */
export async function listedStepVerdict(inputs: Omit<Inputs, "store" | "people"> & { store: DocumentStore | undefined; people: TaskPeopleDependencies | undefined }, task: { taskId: string; developerId: string; project: string }, stored: Record<string, unknown> | undefined, by?: string): Promise<StepVerdict | undefined> {
  const { store, people } = inputs;
  if (store === undefined || stored === undefined || isSetupOrWikiRun(stored) || await store.get({ pk: `DEVTASK#${task.taskId}`, sk: "PEOPLE" }) === undefined) return undefined;
  if (people === undefined || stored["companyId"] !== inputs.companyId || stored["developerId"] !== task.developerId || stored["project"] !== task.project) return refused(OWNER_UNREADABLE_WORDS);
  return listStepVerdict({ ...inputs, store, people }, task, stored, by);
}
