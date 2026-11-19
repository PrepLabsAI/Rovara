// The project's monthly cap on automatic runs: the runs a system owner starts (the nightly run, a saved image's rebuild, a scheduled check) are counted per project per UTC month, and a sensible default cap
// (`DEFAULT_AUTOMATIC_RUNS_PER_MONTH`) pauses them when it is hit. The owner edits it on the local page. What is counted is RUNS STARTED: an automatic run is given no model key, so a run count is what a
// cap can hold to.
// Data, under the project's partition (kept with a time-to-live, the same rows and keys as the hosted product):
//   AUTOMATIC_RUNS#SETTINGS            the cap the owner set, who and when, and the request ids already applied (a replay changes nothing)
//   AUTOMATIC_RUNS#MONTH#YYYY-MM       the month's count of runs started
//   AUTOMATIC_RUNS#RUN#<requestId>     one per run claimed, so a retried start counts once and a run that never started gives its place back
//   AUTOMATIC_RUNS#STARTED#<hash>      one per run that started (job, when, its task), for the project page
//   AUTOMATIC_RUNS#PAUSED#YYYY-MM      written once, with the pause's audit event, when the cap is first reached in the month
import { createHash } from "node:crypto";
import {
  DEFAULT_AUTOMATIC_RUNS_PER_MONTH, INDEX_EXPIRY_ATTRIBUTE, MAX_AUTOMATIC_RUNS_PER_MONTH, agentXError, change, projectPk, when,
  type AuditSink, type AutomaticJob, type OrgId, type TransactItem,
} from "@agentx/contracts";
import { coded, iso, overwriteRow, putRow, type Table } from "../automation/kit.js";

const DAY_MS = 86_400_000;
const SETTINGS_SK = "AUTOMATIC_RUNS#SETTINGS";
/** The prefix of the row kept for each run that started (its job, when, and its task), for the project page. */
export const AUTOMATIC_RUNS_STARTED_PREFIX = "AUTOMATIC_RUNS#STARTED#";
const SETTING_REQUESTS_KEPT = 20;
const WRITE_ATTEMPTS = 3;
const CLAIM_ATTEMPTS = 3;
const CLAIM_BACKOFF_MS = 20;
const monthSk = (month: string) => `AUTOMATIC_RUNS#MONTH#${month}`;
const key = (orgId: OrgId, project: string, sk: string) => ({ pk: projectPk(orgId, project), sk });
export const monthOf = (ms: number): string => new Date(ms).toISOString().slice(0, 7);

export interface AutomaticRunsDeps extends Table {
  companyId: OrgId;
  audit: AuditSink;
}

const wholeCap = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= MAX_AUTOMATIC_RUNS_PER_MONTH;

/** A stable audit event id for a fact that happens once. */
export const eventIdOf = (...parts: string[]): string => `evt_${createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 40)}`;

/** The project's monthly cap: what the owner set, else the default. A stored cap that is not a whole number in range reads as the default (a damaged row never lifts the cap or stops every run). */
export async function readAutomaticRunsCap(deps: Table, orgId: OrgId, project: string): Promise<{ cap: number; isDefault: boolean }> {
  const stored = await deps.store.get(key(orgId, project, SETTINGS_SK));
  return wholeCap(stored?.["monthlyCap"]) ? { cap: stored["monthlyCap"], isDefault: false } : { cap: DEFAULT_AUTOMATIC_RUNS_PER_MONTH, isDefault: true };
}

export interface AutomaticRunsUse { month: string; cap: number; capIsDefault: boolean; used: number; paused: boolean }

/** What the project page says: this month's runs against the cap, and whether the cap has paused them. */
export async function readAutomaticRunsUse(deps: Table, orgId: OrgId, project: string): Promise<AutomaticRunsUse> {
  const month = monthOf(deps.now());
  const [{ cap, isDefault }, used] = await Promise.all([readAutomaticRunsCap(deps, orgId, project), countOf(deps, orgId, project, month)]);
  return { month, cap, capIsDefault: isDefault, used, paused: used >= cap };
}

export type AutomaticRunClaim = { claimed: true; used: number; cap: number; replay: boolean } | { claimed: false; used: number; cap: number };

async function countOf(deps: Table, orgId: OrgId, project: string, month: string): Promise<number> {
  const counter = await deps.store.get(key(orgId, project, monthSk(month)));
  const count = counter?.["count"];
  return typeof count === "number" && Number.isInteger(count) && count > 0 ? count : 0;
}

/**
 * Takes one place of the month for a run, once per `requestId`: the run's claim and the month's count commit together, and only while the count is under the cap. A claim already made (a retried start)
 * answers as claimed and counts nothing more. When the cap is what refuses, the pause is recorded once for the month with its audit event.
 */
export async function claimAutomaticRun(deps: AutomaticRunsDeps, input: { orgId: OrgId; project: string; requestId: string; job: AutomaticJob }): Promise<AutomaticRunClaim> {
  const now = deps.now();
  const month = monthOf(now);
  const { cap } = await readAutomaticRunsCap(deps, input.orgId, input.project);
  // A retried start whose claim is already there is counted once and answered as claimed, whatever the cap is now (the owner may have lowered it since: the run exists).
  const claimKey = key(input.orgId, input.project, `AUTOMATIC_RUNS#RUN#${input.requestId}`);
  if (await deps.store.get(claimKey) !== undefined) return { claimed: true, used: await countOf(deps, input.orgId, input.project, month), cap, replay: true };
  // A cap of 0 pauses them all. The counter's own test ("no count yet, or under the cap") would let the month's FIRST run through, because a month with no count has no row to compare, so 0 is refused here.
  if (cap < 1) {
    await recordPause(deps, input.orgId, input.project, month, cap);
    return { claimed: false, used: await countOf(deps, input.orgId, input.project, month), cap };
  }
  const expires = Math.floor((now + 62 * DAY_MS) / 1000);
  const counter = key(input.orgId, input.project, monthSk(month));
  const claim = key(input.orgId, input.project, `AUTOMATIC_RUNS#RUN#${input.requestId}`);
  const items: TransactItem[] = [
    putRow(claim, "AUTOMATIC_RUN_CLAIM", { orgId: input.orgId, project: input.project, requestId: input.requestId, job: input.job, month, claimedAt: iso(deps), [INDEX_EXPIRY_ATTRIBUTE]: expires }),
    { kind: "update", key: counter,
      ops: [change.setIfAbsent(["entityType"], "AUTOMATIC_RUNS_MONTH"), change.set(["orgId"], input.orgId), change.set(["project"], input.project), change.set(["month"], month), change.set([INDEX_EXPIRY_ATTRIBUTE], expires), change.add(["count"], 1)],
      condition: when.or(when.notExists("count"), when.lt("count", cap)) },
  ];
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
    const result = await deps.store.transact(items);
    if (result.applied) return { claimed: true, used: await countOf(deps, input.orgId, input.project, month), cap, replay: false };
    const claimFailed = result.failed.includes(0);
    const counterFailed = result.failed.includes(1);
    // This request's claim is already there (a retried start): counted once, whatever the count is now.
    if (claimFailed && await deps.store.get(claim) !== undefined) return { claimed: true, used: await countOf(deps, input.orgId, input.project, month), cap, replay: true };
    // Only the COUNTER's own failed condition is the cap. Another reason (a race with a concurrent write) is not the cap, so it never pauses anything: it is tried again, and then told as a fault that may pass.
    if (counterFailed && !claimFailed) {
      await recordPause(deps, input.orgId, input.project, month, cap);
      return { claimed: false, used: await countOf(deps, input.orgId, input.project, month), cap };
    }
    await new Promise((resolve) => setTimeout(resolve, CLAIM_BACKOFF_MS * 2 ** attempt));
  }
  throw agentXError("WORKSPACE_BUSY", "the project's automatic-run count was busy; the run was not started, try again with the same request_id");
}

/** The pause, once per month, with its audit event in the same write. Best effort: the refusal stands whether or not this note could be written. */
async function recordPause(deps: AutomaticRunsDeps, orgId: OrgId, project: string, month: string, cap: number): Promise<void> {
  const at = iso(deps);
  try {
    const event = deps.audit.stage({ eventId: eventIdOf("automatic-runs-paused", orgId, project, month), companyId: deps.companyId, at, actor: { type: "system", id: "rovara" }, action: "automatic_runs.paused", subject: { type: "project", id: project }, details: { month, cap } });
    await deps.store.transact([
      putRow(key(orgId, project, `AUTOMATIC_RUNS#PAUSED#${month}`), "AUTOMATIC_RUNS_PAUSED", { orgId, project, month, cap, at, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor((deps.now() + 62 * DAY_MS) / 1000) }),
      ...event,
    ]);
  } catch { /* already noted this month (the marker exists), or the note could not be written: the refusal does not depend on it */ }
}

/** Gives a claim back when the run was never started (the start failed, or the night could not run today). Best effort and idempotent: the claim is deleted only if it is there, and the count goes down only with it. */
export async function releaseAutomaticRun(deps: Table, input: { orgId: OrgId; project: string; requestId: string }): Promise<void> {
  const claim = key(input.orgId, input.project, `AUTOMATIC_RUNS#RUN#${input.requestId}`);
  const stored = await deps.store.get(claim).catch(() => undefined);
  if (typeof stored?.["month"] !== "string") return;
  await deps.store.transact([
    { kind: "delete", key: claim, condition: when.present() },
    { kind: "update", key: key(input.orgId, input.project, monthSk(stored["month"])), ops: [change.add(["count"], -1)], condition: when.gt("count", 0) },
  ]).catch(() => undefined);
}

/**
 * The owner sets the project's monthly cap on automatic runs (0 to 2000; 0 pauses them). The caller (a local page act) has already proved it is the owner: nothing here reads who is asking from a request.
 * The change and its audit event commit together; the same `requestId` again changes nothing more. Raising the cap lets paused runs go on at once (the next fire counts against the new cap).
 */
export async function setAutomaticRunsCap(deps: AutomaticRunsDeps, input: { orgId: OrgId; project: string; changedBy: string; cap: number; requestId: string }): Promise<AutomaticRunsUse> {
  if (!/^[A-Za-z0-9_-]{8,64}$/u.test(input.requestId)) throw coded("CONFIG_INVALID", "requestId: a request id of 8 to 64 letters, digits, - or _");
  if (!wholeCap(input.cap)) throw coded("CONFIG_INVALID", `cap: a whole number from 0 to ${String(MAX_AUTOMATIC_RUNS_PER_MONTH)}`);
  const settingsKey = key(input.orgId, input.project, SETTINGS_SK);
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
    const stored = await deps.store.get(settingsKey);
    const seen = Array.isArray(stored?.["requestIds"]) ? stored["requestIds"].filter((id): id is string => typeof id === "string") : [];
    if (seen.includes(input.requestId)) return readAutomaticRunsUse(deps, input.orgId, input.project);
    const before = wholeCap(stored?.["monthlyCap"]) ? stored["monthlyCap"] : DEFAULT_AUTOMATIC_RUNS_PER_MONTH;
    const at = iso(deps);
    const event = deps.audit.stage({ eventId: eventIdOf("automatic-runs-cap", input.orgId, input.project, input.requestId), companyId: deps.companyId, at, actor: { type: "person", id: input.changedBy }, action: "automatic_runs.cap_changed", subject: { type: "project", id: input.project }, details: { fromCap: before, toCap: input.cap } });
    // Written only if no other change landed since it was read.
    const last = stored?.["lastRequestId"];
    const condition = stored === undefined ? when.absent() : typeof last === "string" ? when.eq("lastRequestId", last) : when.and(when.present(), when.notExists("lastRequestId"));
    const settings = overwriteRow(settingsKey, "AUTOMATIC_RUNS_SETTINGS", { orgId: input.orgId, project: input.project, monthlyCap: input.cap, changedBy: input.changedBy, changedAt: at, lastRequestId: input.requestId, requestIds: [...seen, input.requestId].slice(-SETTING_REQUESTS_KEPT) });
    const result = await deps.store.transact([{ ...settings, condition }, ...event]);
    if (!result.applied) continue;
    return readAutomaticRunsUse(deps, input.orgId, input.project);
  }
  throw coded("CHANGE_STALE", "the cap changed while it was being updated; try again");
}
