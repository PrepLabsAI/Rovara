// TE-C3 part A: the full suite after the draft (testing plan M3; design proof-test-env 4.5 and owner question Q3), in Code's core on the document store.
//
// When a round ran the affected tests only, or fell back to the full suite and did not finish it, the pull request opens as a draft that says "full suite pending", a follow-up full run on that exact commit
// is queued, and its result updates the pull request, the merge card and the "Rovara" Check. This module is the follow-up's state, its bounds, and the facts and words its readers take. Dispatching the run
// (a CHECKS operation on the commit) and the worker's result callback are wiring for part B.
//
// Rules:
//   - one follow-up per task and commit (queueing twice is the same follow-up, charged once); a newer commit takes the task's pointer, so the older follow-up's result is refused and it reads superseded;
//   - a result is accepted only for the commit it names, from a follow-up still waiting for it, and only once;
//   - a project's follow-ups per day are capped; over the cap the pull request says "not run" instead of "pending";
//   - the day's count is read before the budget is asked (`admit`), so a run past the cap is never charged; a charge for a run that did not queue (a lost race) is released (`release`); a budget refusal is
//     "not run", any other error goes on up (at publication, a store fault is "not queued: a Rovara problem");
//   - asking again for the same commit is a replay and never moves the task's pointer (a delayed replay of an older commit cannot supersede a newer one); only a follow-up that Rovara could not finish
//     (errored, or past the longest run) is queued again by a replay, and it then takes the pointer only if it is the newest;
//   - a run Rovara could not finish (its own fault: the machine, the sandbox) is `errored`: never a failed suite, so a Rovara fault never blocks a merge or turns the Check to failure;
//   - one that waited longer than a run can take reads expired, never passed;
//   - merge stays allowed while pending, on a MEDIUM card (Q3 option a), unless the company chose to block until it passes (option b); a failed follow-up is a HIGH card and is not mergeable from the card;
//     a Rovara fault (errored, expired, superseded, not queued for a Rovara reason) is a MEDIUM card that never blocks, whatever the policy.
//
// Records, in the company's own partition (`ORG#<co>#FULLRUN`): RUN#<project>#<task>#<digest16> (the follow-up), LATEST#<project>#<task> (the commit the task's pointer names) and DAY#<project>#<date>
// (the day's count). All expire.
import {
  INDEX_EXPIRY_ATTRIBUTE, agentXError, change, companyScoped, when, type DecisionRisk, type DocumentStore, type EvidenceSelectionSchema, type OrgId, type RovaraCheckFullSuite, type TransactItem,
} from "@agentx/contracts";
import type { z } from "zod";
import type { FullSuiteState } from "./verification-result.js";
import { BUDGET_CODES } from "../test-env/nightly.js";

type EvidenceSelection = z.infer<typeof EvidenceSelectionSchema>;

export interface FollowupDeps {
  store: Pick<DocumentStore, "get" | "transact" | "update">;
  now(): number;
  /** Charges the follow-up to the project's budget. Throws the scope's own error when a budget has no room. Nothing is queued without it. */
  admit(input: { orgId: OrgId; project: string; taskId: string; purpose: "full_suite_followup" }): Promise<void>;
  /** Gives back a charge `admit` made for a run that then did not queue (a lost race). Optional: without it the charge stands. */
  release?(input: { orgId: OrgId; project: string; taskId: string; purpose: "full_suite_followup" }): Promise<void>;
}

export const FOLLOWUP_DAILY_CAP = 20;
/** A follow-up that has not reported in this long is over: the full suite does not take longer than this. */
export const FOLLOWUP_MAX_RUN_MS = 4 * 3_600_000;
const TTL_MS = 30 * 24 * 3_600_000;
const DAY_TTL_MS = 3 * 86_400_000;
export const FOLLOWUP_ENTITY = "FULLRUN";

export const FOLLOWUP_STATES = ["queued", "running", "passed", "failed", "errored", "superseded"] as const;
export type FollowupState = (typeof FOLLOWUP_STATES)[number];
/** What a reader sees: the stored state, `expired` for one that waited too long, or `not_queued` when the cap or the budget kept it from being queued. */
export type FollowupView = FollowupState | "expired" | "not_queued";

export interface FollowupCounts { passed: number; failed: number; total: number; flaky: number; finishedAt: string }
/** What the worker reports: the suite ran to the end (`completed`, with its counts), or Rovara could not finish it (`rovara_problem`: never read as test failures). */
export type FollowupResult = ({ outcome: "completed" } & FollowupCounts) | { outcome: "rovara_problem"; finishedAt: string };
export interface Followup { state: FollowupView; candidateDigest: string; headSha: string; queuedAt: string; result?: FollowupCounts }

export interface FollowupTarget { orgId: OrgId; project: string; taskId: string; candidateDigest: string }

const DIGEST = /^[a-f0-9]{64}$/u;
const SHA = /^[a-f0-9]{40}$/u;
const PART = /^[A-Za-z0-9_.-]{1,100}$/u;
type Item = Record<string, unknown>;

function checked(input: FollowupTarget & { headSha?: string }): void {
  if (!PART.test(input.taskId) || !PART.test(input.project) || !DIGEST.test(input.candidateDigest) || (input.headSha !== undefined && !SHA.test(input.headSha)) || typeof input.orgId !== "string") {
    throw agentXError("CONFIG_INVALID", "the follow-up names a project, a task, a commit and a code digest");
  }
}
const runKey = (input: FollowupTarget) => ({ pk: companyScoped(input.orgId, FOLLOWUP_ENTITY), sk: `RUN#${input.project}#${input.taskId}#${input.candidateDigest.slice(0, 16)}` });
const latestKey = (input: Omit<FollowupTarget, "candidateDigest">) => ({ pk: companyScoped(input.orgId, FOLLOWUP_ENTITY), sk: `LATEST#${input.project}#${input.taskId}` });
const dayKey = (orgId: OrgId, project: string, ms: number) => ({ pk: companyScoped(orgId, FOLLOWUP_ENTITY), sk: `DAY#${project}#${new Date(ms).toISOString().slice(0, 10)}` });
/** Every record expires (the index expiry attribute every Rovara table sweeps). */
const expiry = (at: number): Record<string, number> => ({ [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(at / 1000) });

const COUNTS_OK = (counts: number[]): boolean => counts.every((count) => Number.isSafeInteger(count) && count >= 0);

/**
 * Whether a round's evidence calls for a follow-up: the selection ran fewer tests than the suite holds (affected tests only), or the full suite was meant to run (by choice or as a fallback) and a test check did
 * not finish in the round (the suite does not fit the round). A selection that does not add up, or none at all, needs none (never a guess).
 */
export function needsFullSuiteFollowup(input: { selection: Pick<EvidenceSelection, "method" | "selected" | "total" | "fallbackReason"> | undefined; testChecks: ReadonlyArray<{ after: "passed" | "failed" | "timed_out" | "unknown" | "not_run" }> }): boolean {
  const selection = input.selection;
  if (selection === undefined || !COUNTS_OK([selection.selected, selection.total]) || selection.selected > selection.total) return false;
  if (selection.method !== "coverage_map" && selection.method !== "import_graph" && selection.method !== "declared" && selection.method !== "full") return false;
  if (selection.selected < selection.total) return true;
  if (selection.method !== "full") return false;
  return input.testChecks.some((check) => check.after === "not_run" || check.after === "timed_out" || check.after === "unknown");
}

/** `unavailable`: Rovara could not queue it (a store fault): a Rovara problem, never the customer's limit. */
export type QueueOutcome = { queued: true; replayed: boolean } | { queued: false; reason: "daily_cap" | "budget" | "unavailable" };

/** Queues the follow-up for a commit, idempotently. A new commit takes the task's pointer; a replay never moves it. Bounded by the project's daily cap and its budget. */
export async function queueFullSuiteFollowup(deps: FollowupDeps, input: FollowupTarget & { headSha: string }): Promise<QueueOutcome> {
  checked(input);
  const now = deps.now();
  const key = runKey(input);
  const existing = await deps.store.get(key);
  if (existing !== undefined && (existing["candidateDigest"] !== input.candidateDigest || existing["orgId"] !== input.orgId)) throw agentXError("CONFIG_INVALID", "the follow-up names a commit another follow-up holds");
  const since = typeof existing?.["startedAtMs"] === "number" ? existing["startedAtMs"] : existing?.["queuedAtMs"];
  const unfinished = existing !== undefined && (existing["state"] === "errored"
    || ((existing["state"] === "queued" || existing["state"] === "running") && typeof since === "number" && now - since > FOLLOWUP_MAX_RUN_MS));
  // Same task and commit: the same follow-up (also after it finished: it is not run twice). Only one Rovara could not finish is queued again.
  if (existing !== undefined && !unfinished) return { queued: true, replayed: true };
  // The day's count first: a run past the cap is never charged.
  const day = await deps.store.get(dayKey(input.orgId, input.project, now));
  if (typeof day?.["count"] === "number" && day["count"] >= FOLLOWUP_DAILY_CAP) return { queued: false, reason: "daily_cap" };
  const charge = { orgId: input.orgId, project: input.project, taskId: input.taskId, purpose: "full_suite_followup" as const };
  try {
    await deps.admit(charge);
  } catch (error) {
    const code = (error as { code?: unknown } | undefined)?.code;
    if (typeof code === "string" && BUDGET_CODES.has(code)) return { queued: false, reason: "budget" };
    throw error;
  }
  const run = {
    ...key, entityType: FOLLOWUP_ENTITY, kind: "run", orgId: input.orgId, project: input.project, taskId: input.taskId, candidateDigest: input.candidateDigest, headSha: input.headSha, state: "queued",
    queuedAtMs: now, queuedAt: new Date(now).toISOString(), ...expiry(now + TTL_MS),
  };
  const items: TransactItem[] = [
    // A new run: only if there is none. A run queued again: only if it is still the one this call read (its state and its clock).
    existing === undefined
      ? { kind: "put", condition: when.absent(), item: run }
      : { kind: "put", condition: when.and(when.present(), when.eq("state", existing["state"] as string), when.eq("queuedAtMs", existing["queuedAtMs"] as number)), item: run },
    {
      kind: "update", key: dayKey(input.orgId, input.project, now),
      ops: [change.set("entityType", FOLLOWUP_ENTITY), change.add("count", 1), change.set(INDEX_EXPIRY_ATTRIBUTE, Math.floor((now + DAY_TTL_MS) / 1000))],
      condition: when.or(when.notExists("count"), when.lt("count", FOLLOWUP_DAILY_CAP)),
    },
    // The pointer: taken only by the newest queueing, so a late or replayed write of an older commit cannot take it back.
    {
      kind: "put", condition: when.or(when.absent(), when.lte("queuedAtMs", now)),
      item: { ...latestKey(input), entityType: FOLLOWUP_ENTITY, kind: "latest", orgId: input.orgId, digest: input.candidateDigest, queuedAtMs: now, ...expiry(now + TTL_MS) },
    },
  ];
  const written = await deps.store.transact(items);
  if (written.applied) return { queued: true, replayed: false };
  await deps.release?.(charge).catch(() => undefined);
  // Lost a race with the same follow-up, or the day filled up meanwhile, or a newer commit holds the pointer.
  const now2 = await deps.store.get(key);
  if (now2 !== undefined && now2["state"] === "queued" && now2["queuedAtMs"] !== existing?.["queuedAtMs"]) return { queued: true, replayed: true };
  return written.failed.includes(1) ? { queued: false, reason: "daily_cap" } : { queued: false, reason: "unavailable" };
}

async function transition(deps: FollowupDeps, input: FollowupTarget, from: readonly FollowupState[], set: Record<string, string | number | Record<string, string | number>>): Promise<boolean> {
  checked(input);
  const latest = await deps.store.get(latestKey(input));
  // A newer commit has taken the pointer: this follow-up is superseded and its result is not wanted.
  if (latest?.["digest"] !== input.candidateDigest || latest["orgId"] !== input.orgId) return false;
  // A follow-up past the longest run is over: it reads expired, and nothing late is taken for it.
  const run = await deps.store.get(runKey(input));
  const since = typeof run?.["startedAtMs"] === "number" ? run["startedAtMs"] : run?.["queuedAtMs"];
  if (typeof since !== "number" || deps.now() - since > FOLLOWUP_MAX_RUN_MS) return false;
  const written = await deps.store.update({
    key: runKey(input),
    ops: Object.entries(set).map(([name, value]) => change.set([name], value)),
    condition: when.and(when.present(), when.eq("candidateDigest", input.candidateDigest), when.eq("orgId", input.orgId), when.or(...from.map((state) => when.eq("state", state)))),
  });
  return written.applied;
}

/** The worker took the run. False when it is not waiting for one (done, superseded, unknown). */
export const markFollowupRunning = (deps: FollowupDeps, input: FollowupTarget): Promise<boolean> => transition(deps, input, ["queued"], { state: "running", startedAtMs: deps.now() });

function checkedResult(result: FollowupResult): { state: "passed" | "failed" | "errored"; counts?: FollowupCounts } {
  const refuse = (): never => { throw agentXError("CONFIG_INVALID", "the full run's result is not one Rovara can read"); };
  if (typeof result !== "object" || result === null || typeof result.finishedAt !== "string" || !Number.isFinite(Date.parse(result.finishedAt)) || result.finishedAt.length > 40) return refuse();
  if (result.outcome === "rovara_problem") return { state: "errored" };
  if (result.outcome !== "completed") return refuse();
  const { passed, failed, total, flaky } = result;
  if (!COUNTS_OK([passed, failed, total, flaky]) || total !== passed + failed || total === 0 || flaky > total) return refuse();
  return { state: failed === 0 ? "passed" : "failed", counts: { passed, failed, total, flaky, finishedAt: result.finishedAt } };
}

/** Records the full run's result. Accepted once, for the commit the follow-up is for, while it still waits. A result that does not add up is refused (never a guessed pass). */
export async function recordFollowupResult(deps: FollowupDeps, input: FollowupTarget & { result: FollowupResult }): Promise<boolean> {
  const { state, counts } = checkedResult(input.result);
  return transition(deps, input, ["queued", "running"], { state, finishedAtMs: deps.now(), ...(counts === undefined ? {} : { result: { ...counts } }) });
}

/** What a reader sees for a commit: the stored state; `superseded` when a newer commit took the pointer; `expired` when it waited past the longest a run can take; undefined when there is none or it is damaged. */
export async function readFollowup(deps: Pick<FollowupDeps, "store" | "now">, input: FollowupTarget): Promise<Followup | undefined> {
  checked(input);
  const item: Item | undefined = await deps.store.get(runKey(input));
  if (item === undefined || item["orgId"] !== input.orgId || item["candidateDigest"] !== input.candidateDigest || typeof item["headSha"] !== "string" || typeof item["queuedAt"] !== "string" || typeof item["queuedAtMs"] !== "number") return undefined;
  const stored = item["state"];
  if (!(FOLLOWUP_STATES as readonly unknown[]).includes(stored)) return undefined;
  let state = stored as FollowupState;
  const latest = await deps.store.get(latestKey(input));
  if (latest !== undefined && latest["digest"] !== input.candidateDigest && (state === "queued" || state === "running")) state = "superseded";
  let view: FollowupView = state;
  const since = typeof item["startedAtMs"] === "number" ? item["startedAtMs"] : item["queuedAtMs"];
  if ((state === "queued" || state === "running") && deps.now() - since > FOLLOWUP_MAX_RUN_MS) view = "expired";
  const raw = item["result"] as Record<string, unknown> | undefined;
  const result = raw !== undefined && COUNTS_OK([raw["passed"], raw["failed"], raw["total"], raw["flaky"]] as number[]) && typeof raw["finishedAt"] === "string"
    ? { passed: raw["passed"] as number, failed: raw["failed"] as number, total: raw["total"] as number, flaky: raw["flaky"] as number, finishedAt: raw["finishedAt"] } : undefined;
  if ((state === "passed" || state === "failed") && result === undefined) return undefined;
  return { state: view, candidateDigest: input.candidateDigest, headSha: item["headSha"], queuedAt: item["queuedAt"], ...(result !== undefined && (state === "passed" || state === "failed") ? { result } : {}) };
}

// ---- what readers take

/** The "Rovara" Check's full-suite fact (TE-B4). A Rovara fault (errored, expired, superseded, not queued) is `not_run`, which is neutral: never failure, and never a success with no full run behind it. */
export function checkFullSuiteOf(followup: Followup | undefined, needed: boolean): RovaraCheckFullSuite {
  if (!needed) return "not_needed";
  switch (followup?.state) {
    case "queued": case "running": return "pending";
    case "passed": return "passed";
    case "failed": return "failed";
    default: return "not_run";
  }
}

/**
 * The pull request's testing row state (`planned.fullSuite`). Undefined for a follow-up that FAILED: the Testing view is then not shown (testing-section.ts: a failed follow-up is not an input), and the
 * follow-up's own line, the Check and the merge card say it failed. Never "not run" for a suite that ran.
 */
export function fullSuiteStateOf(followup: Followup | undefined, needed: boolean): FullSuiteState | undefined {
  if (!needed) return "not_needed";
  const state = followup?.state;
  if (state === "queued" || state === "running") return "pending";
  if (state === "passed") return "not_needed";
  if (state === "failed") return undefined;
  return "not_run";
}

/** The pull request's line for the follow-up: counts and fixed words only. Undefined when there is nothing to say. */
export function followupLine(followup: Followup | undefined, queued: QueueOutcome | undefined): string | undefined {
  if (followup === undefined) {
    if (queued?.queued !== false) return undefined;
    if (queued.reason === "budget") return "Full suite: not run on this commit (the project's budget has no room for it).";
    if (queued.reason === "unavailable") return "Full suite: not run on this commit (Rovara could not queue it: a Rovara problem, not your tests).";
    return `Full suite: not run today (project cap ${String(FOLLOWUP_DAILY_CAP)} reached).`;
  }
  const number = (count: number) => count.toLocaleString("en-US");
  const result = followup.result;
  switch (followup.state) {
    case "queued": return "Full suite: pending. A full run on this commit is queued, and this section updates when it finishes.";
    case "running": return "Full suite: pending. A full run on this commit is running, and this section updates when it finishes.";
    case "passed": return `Full suite: passed on this commit (${number(result?.passed ?? 0)} of ${number(result?.total ?? 0)}${(result?.flaky ?? 0) > 0 ? `; ${number(result?.flaky ?? 0)} known flaky` : ""}).`;
    case "failed": return `Full suite: failed on this commit (${number(result?.failed ?? 0)} of ${number(result?.total ?? 0)} failing). See the task page for which.`;
    case "errored": return "Full suite: Rovara could not finish the full run on this commit (a Rovara problem, not your tests).";
    case "expired": return "Full suite: the follow-up run did not report. It was not run to the end on this commit.";
    case "superseded": return "Full suite: replaced by a run on a newer commit.";
    case "not_queued": return "Full suite: not run on this commit.";
  }
}

export type FullSuiteMergePolicy = "allow_pending" | "block_until_passed";
export interface FullSuiteMergeGate { allowed: boolean; risk: DecisionRisk; reason: "none_needed" | "pending" | "failed" | "not_run" | "rovara_problem" | "passed" }

/**
 * What the follow-up does to the merge card (Q3). Pending: allowed on a MEDIUM card, or blocked under `block_until_passed`. Failed: a HIGH card, not mergeable from the card. Not queued for the customer's own
 * limit (the daily cap, the budget): medium, or blocked under the stricter policy. A Rovara fault (errored, expired, superseded, not queued because Rovara could not, or nothing known): a MEDIUM card that is
 * ALWAYS allowed, whatever the policy (a Rovara fault never blocks a merge). Passed and none needed add nothing. `baseRisk` is never lowered.
 */
export function fullSuiteMergeGate(input: { policy: FullSuiteMergePolicy; followup: Followup | undefined; needed: boolean; baseRisk: DecisionRisk; notQueued?: QueueOutcome | undefined }): FullSuiteMergeGate {
  const order: DecisionRisk[] = ["low", "medium", "high"];
  const atLeast = (risk: DecisionRisk): DecisionRisk => (order.indexOf(risk) > order.indexOf(input.baseRisk) ? risk : input.baseRisk);
  if (!input.needed) return { allowed: true, risk: input.baseRisk, reason: "none_needed" };
  const state = input.followup?.state;
  if (state === "passed") return { allowed: true, risk: input.baseRisk, reason: "passed" };
  if (state === "failed") return { allowed: false, risk: atLeast("high"), reason: "failed" };
  if (state === "queued" || state === "running") return { allowed: input.policy === "allow_pending", risk: atLeast("medium"), reason: "pending" };
  const customerLimit = input.followup === undefined && input.notQueued?.queued === false && (input.notQueued.reason === "daily_cap" || input.notQueued.reason === "budget");
  if (customerLimit) return { allowed: input.policy === "allow_pending", risk: atLeast("medium"), reason: "not_run" };
  return { allowed: true, risk: atLeast("medium"), reason: "rovara_problem" };
}

// ---- the two seams part B calls

/**
 * At publication: whether this round's evidence needs a follow-up, and if so, queue it (bounded, idempotent). What the pull request says comes back with it: the testing row state and the line.
 * A queue that throws (a store fault) is reported as not queued with no line, never as pending: the row then reads "not run".
 */
export async function followupAtPublication(
  deps: FollowupDeps,
  input: FollowupTarget & { headSha: string; selection: Parameters<typeof needsFullSuiteFollowup>[0]["selection"]; testChecks: Parameters<typeof needsFullSuiteFollowup>[0]["testChecks"] },
): Promise<{ needed: boolean; queued?: QueueOutcome; fullSuite: FullSuiteState; line?: string }> {
  const needed = needsFullSuiteFollowup({ selection: input.selection, testChecks: input.testChecks });
  if (!needed) return { needed: false, fullSuite: "not_needed" };
  let queued: QueueOutcome;
  let followup: Followup | undefined;
  try {
    queued = await queueFullSuiteFollowup(deps, input);
    followup = queued.queued ? await readFollowup(deps, input) : undefined;
  } catch {
    // A store fault (or any error other than the budget's): a Rovara problem, never "pending" and never the customer's limit.
    queued = { queued: false, reason: "unavailable" };
    followup = undefined;
  }
  const line = followupLine(followup, queued);
  return { needed, queued, fullSuite: fullSuiteStateOf(followup, needed) ?? "not_run", ...(line === undefined ? {} : { line }) };
}

/** For the "Rovara" Check's source (`SummaryCheckSource.facts`): the full-suite fact of a head's commit. A read that fails is `not_run` (neutral), never a guess. */
export async function fullSuiteCheckFact(deps: Pick<FollowupDeps, "store" | "now">, input: FollowupTarget & { needed: boolean }): Promise<RovaraCheckFullSuite> {
  if (!input.needed) return "not_needed";
  const followup = await readFollowup(deps, input).catch(() => undefined);
  return checkFullSuiteOf(followup, true);
}
