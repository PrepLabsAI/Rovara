// Setup run carry-over (DEC 254zzz431): "Run again" after an ENDED setup run (any end: a limit, a website wait, a hang, Stop, the budget) starts from what the last run found, not from nothing.
// What is carried is the last run's PARTIAL PROPOSAL (as stored) and a short SUMMARY of its journal (the commands that worked and failed, the websites it asked for), bounded to `SETUP_CARRY_OVER_MAX_BYTES`.
//
// Where it comes from, and only from there:
//   - the project's own pointer (`SETUP_DRAFT#<project>` / AGENT, in the COMPANY's partition), and the task and journal rows that pointer names, each checked again to be this company's and this project's;
//   - a run that has ENDED (its end was recorded, or its task is closed): a run that is still going, or that only reads as stale and may still be alive, is never read;
//   - within the 31 days the journal rows are kept.
// It is built once, when the re-run starts, and kept on the new task (`setupAgentCarryOver`); it never comes from the client's request. Building it never fails a start: any error leaves the run starting as it always did.
// The text in it came from the repository and from commands (the journal's command and output were redacted when they were stored). It is DATA: the worker shows it to the model in a block that says so.
import {
  SETUP_CARRY_OVER_HOSTS_MAX, SETUP_CARRY_OVER_LINE_CHARS, SETUP_CARRY_OVER_MAX_BYTES, SETUP_CARRY_OVER_PROPOSAL_MAX_BYTES, SetupCarryOverSchema, redactText,
  type DocumentStore, type SetupCarryOver, type SetupCarryOverCut, type SetupJournalEntry, type SetupProposal,
} from "@agentx/contracts";
import { taskKey } from "../task-flow/keys.js";
import type { TaskRecord } from "../task-flow/records.js";
import type { SetupAgentPointer, SetupAgentView } from "./agent.js";
import { listHostAsks } from "./host-ask.js";
import { readSetupJournal } from "./journal.js";
import { SETUP_KEEP_SECONDS } from "./keys.js";

const bytes = (text: string): number => Buffer.byteLength(text, "utf8");
const plain = (text: string, max: number): string => redactText(text).replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/gu, " ").trim().slice(0, max);

/** The proposal's parts that are left out first, in order, when it does not fit its share. Each is a whole member of the stored proposal. */
const CUT_MEMBERS: ReadonlyArray<readonly [SetupCarryOverCut, keyof SetupProposal]> = [
  ["devcontainer", "devcontainer"], ["notes", "notes"], ["promptLocations", "promptLocations"], ["browserEvidence", "browserEvidence"], ["intake", "intake"], ["sources", "sources"], ["knowledge", "knowledge"],
  ["specTarget", "specTarget"], ["foundNotUsed", "foundNotUsed"], ["testEnvironment", "testEnvironment"],
];

/**
 * The stored proposal as JSON text of at most `SETUP_CARRY_OVER_PROPOSAL_MAX_BYTES`, and what was left out to get there (nothing left out: the proposal exactly as stored). When even the cut proposal does not fit,
 * there is no text and the cut says `all`. Pure.
 */
export function carriedProposalOf(proposal: SetupProposal | undefined): { text: string | undefined; cut: SetupCarryOverCut[] } | undefined {
  if (proposal === undefined) return undefined;
  // Measured as it is carried: a JSON string inside the carry-over, where every quote and backslash is escaped again.
  const fits = (value: unknown): string | undefined => { const text = JSON.stringify(value); return bytes(JSON.stringify(text)) <= SETUP_CARRY_OVER_PROPOSAL_MAX_BYTES ? text : undefined; };
  const whole = fits(proposal);
  if (whole !== undefined) return { text: whole, cut: [] };
  const cut: SetupCarryOverCut[] = [];
  let current: Record<string, unknown> = { ...proposal };
  for (const [name, member] of CUT_MEMBERS) {
    const present = current[member];
    if (present === undefined || present === "" || (Array.isArray(present) && present.length === 0)) continue;
    current = Object.fromEntries(Object.entries(current).filter(([key]) => key !== member));
    cut.push(name);
    const text = fits(current);
    if (text !== undefined) return { text, cut };
  }
  // Still too big: every item keeps only its first citation.
  const firstCitation = (value: unknown): unknown => (Array.isArray(value) ? value.map(firstCitation) : typeof value === "object" && value !== null
    ? Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, key === "from" && Array.isArray(inner) ? inner.slice(0, 1) : firstCitation(inner)])) : value);
  current = firstCitation(current) as Record<string, unknown>;
  cut.push("extraCitations");
  const trimmed = fits(current);
  return trimmed === undefined ? { text: undefined, cut: [...cut, "all"] } : { text: trimmed, cut };
}

/** One line of the summary for a command: how it ended, then the command, and for a failure the last line of its output. Plain, one line, at most `SETUP_CARRY_OVER_LINE_CHARS` (+ a little for the output). */
export function journalLineOf(entry: SetupJournalEntry): string {
  const outcome = entry.timedOut ? "timed out" : entry.exitCode === 0 ? "worked" : entry.exitCode === null ? "did not finish" : `failed (exit ${String(entry.exitCode)})`;
  const typed = entry.source === "person" ? " (typed by a person)" : "";
  const last = entry.exitCode === 0 ? "" : plain(entry.tail.trim().split("\n").filter((row) => row.trim() !== "").at(-1) ?? "", 100);
  return `#${String(entry.n)} ${outcome}${typed}: ${plain(entry.command, SETUP_CARRY_OVER_LINE_CHARS - 40)}${last === "" ? "" : ` | output ended: ${last}`}`.slice(0, SETUP_CARRY_OVER_LINE_CHARS + 100);
}

/**
 * The carry-over for an ended run: its proposal (cut to its share) and the newest journal lines that fit what the proposal leaves. The summary is cut first (the oldest lines go first), then the proposal's parts, and the
 * whole stays within `maxBytes` (the contract's `SETUP_CARRY_OVER_MAX_BYTES`; a test may ask for less). Undefined when there is nothing to carry (no proposal and no command). Pure.
 */
export function buildCarryOver(input: { fromRun: string; endedAs: SetupCarryOver["endedAs"]; proposal: SetupProposal | undefined; journal: readonly SetupJournalEntry[]; hosts: SetupCarryOver["journal"]["hosts"] }, maxBytes: number = SETUP_CARRY_OVER_MAX_BYTES): SetupCarryOver | undefined {
  const carried = carriedProposalOf(input.proposal);
  let hosts = input.hosts.slice(0, SETUP_CARRY_OVER_HOSTS_MAX);
  const lines = input.journal.map(journalLineOf);
  if (carried?.text === undefined && lines.length === 0) return undefined;
  const make = (kept: readonly string[]): SetupCarryOver => ({
    version: 1, fromRun: input.fromRun, endedAs: input.endedAs,
    ...(carried === undefined ? {} : { ...(carried.text === undefined ? {} : { proposal: carried.text }), ...(carried.cut.length === 0 ? {} : { proposalCut: carried.cut }) }),
    journal: { total: input.journal.length, lines: [...kept], hosts },
  });
  // The website list gives way before the proposal: the last-named hosts go until the proposal alone fits.
  while (hosts.length > 0 && bytes(JSON.stringify(make([]))) > maxBytes) hosts = hosts.slice(0, -1);
  // The newest lines first, as many as fit; the oldest are left out (`journal.total` says how many commands ran).
  let kept: string[] = [];
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const next = [lines[index] as string, ...kept];
    if (bytes(JSON.stringify(make(next))) > maxBytes) break;
    kept = next;
  }
  const value = make(kept);
  const parsed = SetupCarryOverSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export interface SetupCarryOverDeps {
  store: DocumentStore;
  companyId: SetupAgentPointer["orgId"];
  now: () => number;
}

/** When the run ended, from the task's own record: its recorded end, else its close, else the last write to a task that holds a result. Undefined: it has not ended (or says nothing of it). */
function endedAtOf(task: Partial<TaskRecord>): number | undefined {
  const at = [task.agentRunEnd?.at, task.closedAt, task.setupAgentResult === undefined ? undefined : task.updatedAt].find((value) => typeof value === "string");
  const parsed = at === undefined ? Number.NaN : Date.parse(at);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** The pointer's ended task when it is this company's and this project's own, a setup run, and ended within the journal's 31 days; otherwise undefined. Reads the task row only after the pointer and view agree. */
async function endedTaskOf(deps: SetupCarryOverDeps, project: string, before: { view: SetupAgentView; pointer?: SetupAgentPointer | undefined }): Promise<SetupAgentPointer | undefined> {
  const { view, pointer } = before;
  if (pointer === undefined || (view.status !== "ready" && view.status !== "failed") || view.taskId !== pointer.taskId) return undefined;
  if (pointer.orgId !== deps.companyId || pointer.project !== project) return undefined;
  const task = (await deps.store.get(taskKey(pointer.taskId))) as Partial<TaskRecord> | undefined;
  if (task === undefined || task.purpose !== "setup_agent" || ((task as { orgId?: string }).orgId ?? task.companyId) !== deps.companyId || task.project !== project) return undefined;
  const endedAt = endedAtOf(task);
  return endedAt === undefined || deps.now() - endedAt > SETUP_KEEP_SECONDS * 1_000 ? undefined : pointer;
}

/** The websites the run met: those a command found blocked, then the asks this run made (an ask's own state wins). */
async function hostsOf(deps: SetupCarryOverDeps, project: string, taskId: string, journal: readonly SetupJournalEntry[]): Promise<SetupCarryOver["journal"]["hosts"]> {
  const asks = await listHostAsks({ store: deps.store, now: deps.now }, deps.companyId, project, ["open", "approved", "refused"]).catch(() => []);
  const hosts = new Map<string, SetupCarryOver["journal"]["hosts"][number]["state"]>();
  for (const entry of journal) for (const host of entry.blockedHosts) hosts.set(host, "blocked");
  for (const ask of asks) if (ask.taskId === taskId) hosts.set(ask.host, ask.state);
  return [...hosts].map(([host, state]) => ({ host, state }));
}

/**
 * The carry-over for a run about to start, from the project's most recent run as the caller already read it (`readState`): the pointer's task, only when it ended within the journal's 31 days, belongs to this company and
 * this project, and its journal and host asks are read by that company and project. A pointer that is another company's or project's, a run still going or that only reads as stale, and a run older than 31 days give
 * undefined. Never throws.
 */
export async function setupCarryOverFor(deps: SetupCarryOverDeps, project: string, before: { view: SetupAgentView; pointer?: SetupAgentPointer | undefined }): Promise<SetupCarryOver | undefined> {
  try {
    const pointer = await endedTaskOf(deps, project, before);
    if (pointer === undefined) return undefined;
    const journal = await readSetupJournal({ store: deps.store }, { orgId: deps.companyId, project, taskId: pointer.taskId });
    return buildCarryOver({ fromRun: pointer.taskId, endedAs: before.view.stop ?? "infrastructure", proposal: before.view.proposal, journal, hosts: await hostsOf(deps, project, pointer.taskId, journal) });
  } catch {
    return undefined;
  }
}

/** What a served page view adds when a start would carry the last run's findings over: `{ carriesOver: true }`, else nothing. The same rule as the start's (`setupCarryOverFor`). */
export async function carriesOverField(deps: SetupCarryOverDeps, project: string, before: { view: SetupAgentView; pointer?: SetupAgentPointer | undefined }): Promise<{ carriesOver: true } | Record<string, never>> {
  return (await setupCarryOverFor(deps, project, before)) === undefined ? {} : { carriesOver: true };
}
