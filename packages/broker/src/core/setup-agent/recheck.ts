// L4-DR (DEC 254z c; setup-upkeep-plan.md 2.1, slices U3 and U4): the drift check at task start and the free automatic re-check. NO MODEL runs anywhere in this file, and none is ever asked.
//
// At the start of a task (`setupDriftAtStart`, called by `startTask` before its transaction) the broker lists the setup files of each repository at the base commit through the code host and compares them with the
// snapshot saved when the setup was approved (`compareSetupSnapshot`). No drift: nothing is written, nothing is shown. Drift, or a comparison that cannot be told (never read as "no drift"): Rovara starts the
// project's EXISTING setup check by itself, as the project's system owner (nobody's AI and no person's rights), at most once per (project revision, base commits), held by the project's monthly cap on automatic
// runs (`claimAutomaticRun`: at the cap nothing starts). The task goes on through Understand and Plan; only the first coding run waits (`setupGateBeforeBuild`).
//
// Rows, in the project's setup partition (`setupPartition(orgId, project)`), so another company's project of the same name never meets them:
//   RECHECK#<key>      one re-check per (project revision, base commits): its state, which attempt, the check it runs, what changed (fixed classes only)
//   RECHECK_CURRENT    the project's latest re-check (the pointer a later start advances first)
//   DRIFT_TASK#<task>  which re-check a task waits on, and whether it has been let through
//   REPAIR_NOTICE      the one admin card of the project's "Setup needs repair" state
//
// What a result means (`classifySetupRecheck`, through the nightly-health classifier, `test-env/nightly-health.ts`; nothing reads a log):
//   passed         the setup works on the newer code: silent; the snapshot's baseline moves to the re-checked commits.
//   tests_failing  a TEST command failed while the setup commands passed: not a setup problem. Never blocks (the failing tests belong to the base branch). The baseline moves: the setup was proved on this code.
//   unclear        a stalled check, an unreadable result: never blocks.
//   broken         a setup step failed (twice: one retry for a machine fault): ONLY THIS BLOCKS. The project's own setup state becomes "failed" (so new starts are refused by today's rule), the project gets one admin
//                  card, and a task waiting at Build is paused with fixed words. A fix is a NEW setup candidate: a person approves it (never automatic); approving it moves the project to a new revision, which ends the pause.
import { createHash } from "node:crypto";
import {
  canonicalJson, change, compareSetupSnapshot, projectMetaKey, systemOwnerIdOf, when,
  type ProjectDefinition, type SetupDriftClass, type TransactItem,
} from "@agentx/contracts";
import { claimAutomaticRun, eventIdOf, releaseAutomaticRun, type AutomaticRunsDeps } from "../automatic-runs/cap.js";
import { overwriteRow, putRow } from "../automation/kit.js";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import { iso, log } from "../task-flow/support.js";
import { classifyNightlyHealth, type NightlyHealth } from "../test-env/nightly-health.js";
import { buildSetupCheck, relayCheck, setupStateOf, setupStateOfCheck, type SetupCheckMark, type SetupState } from "./check.js";
import {
  driftTaskKey, isRow, recheckCurrentKey, recheckRowKey, repairNoticeKey, setupBrokenTaskWords, setupRepairCardOf,
  type DriftTaskRow, type RecheckRow, type RecheckState, type RepairNoticeRow, type SetupRepairCard,
} from "./recheck-rows.js";
import { expiryAfter } from "./keys.js";
import { commitsOf, readCurrentSetupFiles, readSetupSnapshot, snapshotItem, takeSetupSnapshot, allowedHostsOf } from "./snapshot.js";

export * from "./recheck-rows.js";
const expiry = (deps: Pick<TaskFlowDeps, "now">) => expiryAfter((deps.now?.() ?? new Date()).getTime(), KEEP_SECONDS);
const automaticDeps = (deps: TaskFlowDeps): AutomaticRunsDeps => ({ store: deps.store, now: () => (deps.now?.() ?? new Date()).getTime(), companyId: deps.companyId, audit: deps.audit });
const errorName = (error: unknown): string => (error instanceof Error ? error.name : "unknown");
/** As long as the cap's own claim lives (62 days), so a re-check key that comes back is never answered by a claim whose row is gone. */
const KEEP_SECONDS = 62 * 86_400;
/** A failed first check is retried only after this, so a short outage of the host or the machines does not fail both tries. */
export const RECHECK_RETRY_DELAY_MS = 5 * 60_000;
/** A task that has waited this long at Build for the re-check goes on: a result that has not come is "unclear", which never blocks (the check's own limit is 50 minutes, and a retry may follow). */
export const RECHECK_WAIT_MAX_MS = 55 * 60_000;
/** The most failed-step text a row keeps (the check's own failing step is already redacted, on one line and cut to this). */
const STEP_KEPT = 300;

/** The identity of one re-check: the project's revision and the base commit of every repository. Two tasks on the same commits are one re-check. */
export const recheckKeyOf = (revision: number, commits: Readonly<Record<string, string>>): string =>
  createHash("sha256").update(canonicalJson({ revision, commits: Object.entries(commits).sort(([a], [b]) => (a < b ? -1 : 1)) })).digest("hex").slice(0, 48);

/** A version-5 shaped id made from text, so a repeated request id is the same one. */
const uuidOf = (text: string): string => {
  const hex = createHash("sha256").update(`rovara-setup-recheck\0${text}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

/**
 * What a finished check says about the SETUP, through the nightly-health classifier. A step before the tests failed is `environment` (the classifier's own first rule); a failing TEST command with the setup
 * commands passed is `tests`; a stalled check, a missing or unreadable step is `unclear`. Only `environment` is ever "setup broken".
 */
export function classifySetupRecheck(state: SetupState): NightlyHealth {
  const step = state.failedStep;
  if (typeof step !== "string" || step === "" || state.failedStage === undefined) return classifyNightlyHealth(undefined);
  if (state.failedStage === "test_command") return { class: "tests", setupProved: true };
  // Only a setup COMMAND the worker names is a broken setup. A failed clone, an expired host credential, a machine that would not start, a dev container: nothing there says the project's own setup commands fail, so none
  // of them is read as one (an outage of the code host or of the machines never pauses a project).
  if (state.failedStage === "setup_command") return classifyNightlyHealth({ steps: [{ step: "setup", status: "failed" }], checks: [], tests: { total: 0, passed: 0, failures: 0, errors: 0, skipped: 0 } });
  return { class: "unclear", cause: "other" };
}

// ---- the start of a task: read, compare, maybe re-check

/**
 * The drift check at the start of one task (a task that is not a setup run). NEVER throws and never blocks the start: any fault is logged by its kind and the task starts as it always did. Returns the items the start
 * adds to its OWN transaction (the link that says which re-check the task waits on), or none.
 */
export async function setupDriftAtStart(deps: TaskFlowDeps, input: { project: string; taskId: string; definition: ProjectDefinition }): Promise<TransactItem[]> {
  try {
    return await driftAtStart(deps, input);
  } catch (error) {
    log(deps, { event: "setup_drift.failed", taskId: input.taskId, error: errorName(error) });
    return [];
  }
}

async function driftAtStart(deps: TaskFlowDeps, input: { project: string; taskId: string; definition: ProjectDefinition }): Promise<TransactItem[]> {
  const { project, definition, taskId } = input;
  const orgId = deps.companyId;
  if (deps.codeHosts === undefined) return [];
  // An earlier re-check of this project that finished meanwhile is settled first (its result, its baseline), so this start sees the project as it now is.
  await advanceCurrentRecheck(deps, project).catch((error: unknown) => log(deps, { event: "setup_drift.advance_failed", error: errorName(error) }));
  const stored = await readSetupSnapshot(deps.store, orgId, project);
  // A project whose setup nobody ever approved (and checked) has no promise to keep. One whose setup was checked before snapshots existed has no baseline yet: it is re-checked once, and the pass saves it.
  if (stored === undefined && (await setupStateOf(deps, project, definition)).status !== "ready") return [];
  const read = await readCurrentSetupFiles(deps, definition);
  // The code host cannot be asked (down, no such read): the task starts (DEC 254zzl); a project that has a baseline says so quietly, since the check it promised could not be made.
  if (read.status === "not_checked") { log(deps, { event: "setup_drift.not_checked", taskId }); return stored === undefined ? [] : [uncheckedLink(deps, project, taskId, [])]; }
  const drift = compareSetupSnapshot(stored, read.repositories, allowedHostsOf(definition));
  if (drift.drift === "none") { log(deps, { event: "setup_drift.none", taskId }); return []; }
  // DEC 254zzl: with the company's system runs OFF (hosted default) Rovara starts nothing by itself. The comparison above only read names, so it still says quietly that the setup may be out of date; the task starts
  // normally, and a person starts "Re-check setup". The laptop has no such switch (absent: on).
  if (deps.systemRuns?.enabled() === false) {
    log(deps, { event: "setup_drift.system_runs_off", taskId, classes: drift.drift === "changed" ? drift.classes.length : 0 });
    return [uncheckedLink(deps, project, taskId, drift.drift === "changed" ? drift.classes : [], "off")];
  }
  const commits = commitsOf(read.repositories);
  // No commit to pin means no stable identity for a re-check: the task goes on, and a later start tries again.
  if (commits === undefined) { log(deps, { event: "setup_drift.not_checked", taskId }); return [uncheckedLink(deps, project, taskId, drift.drift === "changed" ? drift.classes : [])]; }
  const classes = drift.drift === "changed" ? drift.classes : [];
  // A change that can be told is one re-check per commit; one that cannot (no baseline, a listing over the limits) is one per revision per day, so a baseline that can never be saved cannot burn the cap on every commit.
  const key = drift.drift === "changed" ? recheckKeyOf(definition.revision, commits) : recheckKeyOf(definition.revision, { "~unknown": iso(deps).slice(0, 10) });
  // One re-check in flight per project: a start that finds one running joins it (a newer commit is looked at by the next start once it ends).
  const running = await runningRecheckOf(deps, project, definition.revision);
  const outcome = running !== undefined ? "joined" : await ensureRecheck(deps, { project, definition, key, commits, classes });
  const linkKey = running?.key ?? key;
  // The cap is used: the re-check cannot run, the task STILL STARTS (DEC 254zzl), released at once, with the quiet note.
  if (outcome === "capped") { log(deps, { event: "setup_drift.capped", taskId }); return [uncheckedLink(deps, project, taskId, classes)]; }
  log(deps, { event: "setup_drift.recheck", taskId, outcome, classes: classes.length });
  const row: DriftTaskRow = { entityType: "SETUP_DRIFT_TASK", orgId, project, taskId, recheckKey: linkKey, state: "pending", at: iso(deps) };
  return [putRow(driftTaskKey(orgId, project, taskId), row.entityType, { ...row, ...expiry(deps) })];
}

/** The project's latest re-check when it is still running for this revision (and has not outlived the wait limit). */
async function runningRecheckOf(deps: TaskFlowDeps, project: string, revision: number): Promise<RecheckRow | undefined> {
  const pointer = await deps.store.get(recheckCurrentKey(deps.companyId, project));
  if (!isRow(pointer, deps.companyId, project, "SETUP_RECHECK_CURRENT") || typeof pointer?.["key"] !== "string") return undefined;
  const row = await readRecheck(deps, project, pointer["key"]);
  if (row === undefined || row.state !== "running" || row.setupRevision !== revision) return undefined;
  return (deps.now?.() ?? new Date()).getTime() - Date.parse(row.startedAt) > RECHECK_WAIT_MAX_MS ? undefined : row;
}

/** The link of a task whose re-check could not be made: nothing to wait on (released at once), and the quiet note on its page. */
function uncheckedLink(deps: TaskFlowDeps, project: string, taskId: string, classes: SetupDriftClass[], reason?: "off"): TransactItem {
  const row: DriftTaskRow = { entityType: "SETUP_DRIFT_TASK", orgId: deps.companyId, project, taskId, recheckKey: "", state: "released", at: iso(deps), releasedAt: iso(deps), noRecheck: { classes, ...(reason === undefined ? {} : { reason }) } };
  return putRow(driftTaskKey(deps.companyId, project, taskId), row.entityType, { ...row, ...expiry(deps) });
}

type Ensured = "started" | "joined" | "capped";

/** The re-check for this key: the one already there (any state: one per commit), or a new one started now. */
async function ensureRecheck(deps: TaskFlowDeps, input: { project: string; definition: ProjectDefinition; key: string; commits: Record<string, string>; classes: SetupDriftClass[] }): Promise<Ensured> {
  const { project, key } = input;
  const orgId = deps.companyId;
  if (isRow(await deps.store.get(recheckRowKey(orgId, project, key)), orgId, project, "SETUP_RECHECK")) return "joined";
  const auto = automaticDeps(deps);
  const claimId = claimIdOf(key, 1);
  // The project's monthly cap on automatic runs holds this like any automatic run: at the cap nothing starts and the pause is recorded once.
  const claim = await claimAutomaticRun(auto, { orgId, project, requestId: claimId, job: "scheduled_check" });
  if (!claim.claimed) return "capped";
  const started = buildSetupCheck(deps, { project, revision: input.definition.revision, startedBy: systemOwnerIdOf(orgId, project), requestId: uuidOf(claimId), candidate: true });
  const at = iso(deps);
  const row: RecheckRow = { entityType: "SETUP_RECHECK", orgId, project, key, setupRevision: input.definition.revision, commits: input.commits, classes: input.classes, state: "running", attempt: 1, check: started.mark, startedAt: at };
  try {
    const result = await deps.store.transact([
      putRow(recheckRowKey(orgId, project, key), row.entityType, { ...row, ...expiry(deps) }),
      overwriteRow(recheckCurrentKey(orgId, project), "SETUP_RECHECK_CURRENT", { orgId, project, key, ...expiry(deps) }),
      ...started.items,
      ...deps.audit.stage({ eventId: eventIdOf("setup-recheck-started", orgId, project, key), companyId: orgId, at, actor: { type: "system", id: "rovara" }, action: "setup_recheck.started", subject: { type: "project", id: project }, details: { job: "scheduled_check", attempt: 1, classes: input.classes } }),
    ]);
    if (!result.applied) {
      // Another start put the same re-check there first: the task joins that one. The place in the cap is that start's (the claim is one per re-check, so this call's claim WAS its own), and only a start that
      // left no re-check behind gives it back.
      if (!(await recheckExists(deps, project, key))) await releaseAutomaticRun(auto, { orgId, project, requestId: claimId });
      return "joined";
    }
  } catch (error) {
    if (!(await recheckExists(deps, project, key).catch(() => false))) await releaseAutomaticRun(auto, { orgId, project, requestId: claimId });
    throw error;
  }
  await relayCheck(deps, started);
  return "started";
}

const recheckExists = async (deps: TaskFlowDeps, project: string, key: string): Promise<boolean> => isRow(await deps.store.get(recheckRowKey(deps.companyId, project, key)), deps.companyId, project, "SETUP_RECHECK");
const claimIdOf = (key: string, attempt: 1 | 2): string => `setup-recheck-${key}-${String(attempt)}`;

// ---- progress: every read of a re-check moves it on

async function readRecheck(deps: TaskFlowDeps, project: string, key: string): Promise<RecheckRow | undefined> {
  const stored = await deps.store.get(recheckRowKey(deps.companyId, project, key));
  return isRow(stored, deps.companyId, project, "SETUP_RECHECK") ? (stored as unknown as RecheckRow) : undefined;
}

/** The project's latest re-check, moved on if its check has ended. A project with none answers undefined. */
export async function advanceCurrentRecheck(deps: TaskFlowDeps, project: string): Promise<RecheckRow | undefined> {
  const pointer = await deps.store.get(recheckCurrentKey(deps.companyId, project));
  if (!isRow(pointer, deps.companyId, project, "SETUP_RECHECK_CURRENT") || typeof pointer?.["key"] !== "string") return undefined;
  return advanceRecheck(deps, project, pointer["key"]);
}

/**
 * Moves one re-check on from what its check now says (derived from the check's own workspace, as `setupStateOfCheck` always does): still running -> nothing; passed -> the baseline moves; failed -> one retry for a
 * machine fault, then the result is classified. Safe to call from anywhere and any number of times: every write holds only while the row is as read, so two callers settle it once.
 */
export async function advanceRecheck(deps: TaskFlowDeps, project: string, key: string): Promise<RecheckRow | undefined> {
  const row = await readRecheck(deps, project, key);
  if (row === undefined) return row;
  if (row.state === "broken") { await markProjectBroken(deps, project, row); return row; }
  if (row.state !== "running") return row;
  const orgId = deps.companyId;
  const revision = await deps.projects.revision(project, row.setupRevision);
  if (revision === undefined) return row;
  const state = await setupStateOfCheck(deps, row.check, revision.definition);
  if (state.status === "checking" || state.status === "unchecked") return row;
  const at = iso(deps);
  const still = when.and(when.eq("state", "running"), when.eq("attempt", row.attempt), when.eq(["check", "workspaceId"], row.check.workspaceId));
  const settled = async (next: RecheckState, extra: TransactItem[] = [], failedStep?: string): Promise<RecheckRow | undefined> => {
    const result = await deps.store.transact([
      { kind: "update", key: recheckRowKey(orgId, project, key), ops: [change.set("state", next), change.set("decidedAt", at), ...(failedStep === undefined ? [] : [change.set("failedStep", failedStep)])], condition: still },
      ...extra,
    ]);
    // A lost race is the other caller's settlement: read what it wrote.
    if (!result.applied) return readRecheck(deps, project, key);
    return { ...row, state: next, decidedAt: at, ...(failedStep === undefined ? {} : { failedStep }) };
  };
  if (state.status === "ready") return settled("passed", await baselineMoves(deps, project, revision.definition, row));
  const health = classifySetupRecheck(state);
  const failedStep = (state.failedStep ?? "").slice(0, STEP_KEPT);
  if (health.class === "tests") return settled("tests_failing", await baselineMoves(deps, project, revision.definition, row));
  if (row.attempt === 1) {
    // The first failure is noted when it is first seen; the retry waits out `RECHECK_RETRY_DELAY_MS` from then (a short outage must not fail both tries).
    if (row.failedSeenAt === undefined) {
      await deps.store.update({ key: recheckRowKey(orgId, project, key), ops: [change.set("failedSeenAt", at)], condition: when.and(still, when.notExists("failedSeenAt")) }).catch(() => undefined);
      return readRecheck(deps, project, key);
    }
    if ((deps.now?.() ?? new Date()).getTime() - Date.parse(row.failedSeenAt) < RECHECK_RETRY_DELAY_MS) return row;
    return retryRecheck(deps, project, revision.definition, row, still);
  }
  if (health.class === "environment") {
    const done = await settled("broken", await brokenItems(deps, project, row, failedStep), failedStep);
    if (done?.state === "broken") await markProjectBroken(deps, project, done);
    return done;
  }
  return settled("unclear");
}

/** The write that moves the snapshot's baseline to the re-checked commits (the setup was proved on this code). Nothing when it cannot be read whole: the next re-check, for another commit, tries again. */
async function baselineMoves(deps: TaskFlowDeps, project: string, definition: ProjectDefinition, row: RecheckRow): Promise<TransactItem[]> {
  try {
    // Only for the project's CURRENT revision: a re-check of an older one proved nothing for a setup that was approved since.
    if ((await deps.projects.latest(project))?.definition.revision !== row.setupRevision) return [];
    const snapshot = await takeSetupSnapshot(deps, { definition, setupRevision: row.setupRevision, at: iso(deps), commits: row.commits });
    return snapshot === undefined ? [] : [snapshotItem(deps.companyId, project, snapshot)];
  } catch {
    return [];
  }
}

/**
 * Whether a "broken" re-check still holds: the project's own setup state is still THIS re-check's failed check. A person's newer check (a "check again" that passed) or a newly approved setup replaced the mark, and the
 * break no longer holds anyone back. A project with no record to read a mark from is held (nothing could have replaced it).
 */
async function brokenStillHolds(deps: Pick<TaskFlowDeps, "store" | "companyId">, project: string, row: RecheckRow): Promise<boolean> {
  const meta = await deps.store.get(projectMetaKey(deps.companyId, project));
  if (meta === undefined) return true;
  return (meta["setupCheck"] as Partial<SetupCheckMark> | undefined)?.workspaceId === row.check.workspaceId;
}

/** Whether a second attempt of this re-check exists now (its check differs from the first's). */
async function retryLeftBehind(deps: TaskFlowDeps, project: string, first: RecheckRow): Promise<boolean> {
  const now = await readRecheck(deps, project, first.key);
  return now !== undefined && now.attempt === 2 && now.check.workspaceId !== first.check.workspaceId;
}

/** One retry for a machine fault: a second check, under the cap again. A cap that is full ends the re-check as unclear (never as broken: nothing was proved either way). */
async function retryRecheck(deps: TaskFlowDeps, project: string, definition: ProjectDefinition, row: RecheckRow, still: ReturnType<typeof when.and>): Promise<RecheckRow | undefined> {
  const orgId = deps.companyId;
  const auto = automaticDeps(deps);
  const claimId = claimIdOf(row.key, 2);
  const claim = await claimAutomaticRun(auto, { orgId, project, requestId: claimId, job: "scheduled_check" });
  const at = iso(deps);
  if (!claim.claimed) {
    await deps.store.transact([{ kind: "update", key: recheckRowKey(orgId, project, row.key), ops: [change.set("state", "unclear"), change.set("decidedAt", at)], condition: still }]);
    return readRecheck(deps, project, row.key);
  }
  const started = buildSetupCheck(deps, { project, revision: definition.revision, startedBy: systemOwnerIdOf(orgId, project), requestId: uuidOf(claimId), candidate: true });
  try {
    const result = await deps.store.transact([
      { kind: "update", key: recheckRowKey(orgId, project, row.key), ops: [change.set("attempt", 2), change.set("check", { ...started.mark })], condition: still },
      ...started.items,
      ...deps.audit.stage({ eventId: eventIdOf("setup-recheck-started", orgId, project, row.key, "2"), companyId: orgId, at, actor: { type: "system", id: "rovara" }, action: "setup_recheck.started", subject: { type: "project", id: project }, details: { job: "scheduled_check", attempt: 2, classes: row.classes } }),
    ]);
    if (!result.applied) {
      // The claim is one per re-check and attempt, so another caller's live second attempt holds it too: it goes back only when no second attempt was left behind.
      if (!(await retryLeftBehind(deps, project, row))) await releaseAutomaticRun(auto, { orgId, project, requestId: claimId });
      return readRecheck(deps, project, row.key);
    }
  } catch (error) {
    if (!(await retryLeftBehind(deps, project, row).catch(() => false))) await releaseAutomaticRun(auto, { orgId, project, requestId: claimId });
    throw error;
  }
  await relayCheck(deps, started);
  return readRecheck(deps, project, row.key);
}

/** What "setup broken" writes with its settlement: the project's ONE admin card, and the audit event. */
async function brokenItems(deps: TaskFlowDeps, project: string, row: RecheckRow, failedStep: string): Promise<TransactItem[]> {
  const orgId = deps.companyId;
  const at = iso(deps);
  const notice: RepairNoticeRow = { entityType: "SETUP_REPAIR_NOTICE", orgId, project, key: row.key, failedStep, classes: row.classes, at };
  return [
    overwriteRow(repairNoticeKey(orgId, project), notice.entityType, { ...notice, ...expiry(deps) }),
    ...deps.audit.stage({ eventId: eventIdOf("setup-recheck-broken", orgId, project, row.key), companyId: orgId, at, actor: { type: "system", id: "rovara" }, action: "setup_recheck.broken", subject: { type: "project", id: project }, details: { classes: row.classes } }),
  ];
}

/**
 * The project's own setup state becomes the failed re-check, so a new start is refused by today's rule (`setupFailedMessage`), the setup page says it, and a person's "check again" or an approved new setup replaces it.
 * Idempotent, and never over a NEWER mark (a person's own check that began after this re-check did). A project with no record to mark is left as it is. Never throws.
 */
async function markProjectBroken(deps: TaskFlowDeps, project: string, row: RecheckRow): Promise<void> {
  try {
    const key = projectMetaKey(deps.companyId, project);
    const meta = await deps.store.get(key);
    if (meta === undefined) return;
    const seen = meta["setupCheck"] as Partial<SetupCheckMark> | undefined;
    if (seen?.workspaceId === row.check.workspaceId) return;
    // Never over a mark of a newer setup (an approval writes its own candidate's check), and never for a revision that is no longer the project's.
    if (typeof seen?.revision === "number" && seen.revision > row.check.revision) return;
    if ((await deps.projects.latest(project))?.definition.revision !== row.setupRevision) return;
    if (typeof seen?.workspaceId === "string" && !(Date.parse(String(seen.startedAt)) <= Date.parse(row.check.startedAt))) return;
    await deps.store.update({ key, ops: [change.set("setupCheck", { ...row.check })], condition: seen?.workspaceId === undefined ? when.notExists("setupCheck") : when.eq(["setupCheck", "workspaceId"], seen.workspaceId) });
  } catch (error) {
    log(deps, { event: "setup_drift.mark_failed", error: errorName(error) });
  }
}

/** The project's open admin card, when its setup is broken and no newer setup has been approved since. */
export async function readSetupRepairCard(deps: Pick<TaskFlowDeps, "store" | "companyId" | "projects">, project: string): Promise<(SetupRepairCard & { classes: SetupDriftClass[]; at: string }) | undefined> {
  const stored = await deps.store.get(repairNoticeKey(deps.companyId, project));
  if (!isRow(stored, deps.companyId, project, "SETUP_REPAIR_NOTICE")) return undefined;
  const notice = stored as unknown as RepairNoticeRow;
  const recheck = await deps.store.get(recheckRowKey(deps.companyId, project, notice.key));
  const latest = await deps.projects.latest(project);
  if (!isRow(recheck, deps.companyId, project, "SETUP_RECHECK") || latest === undefined || (recheck as unknown as RecheckRow).setupRevision !== latest.definition.revision) return undefined;
  if (!(await brokenStillHolds(deps, project, recheck as unknown as RecheckRow))) return undefined;
  return { ...setupRepairCardOf(notice.failedStep), classes: notice.classes, at: notice.at };
}

// ---- the wait before Build

export type BuildGate = { answer: "go" } | { answer: "wait" } | { answer: "blocked"; words: string };

/**
 * Asked before a task's first coding run. A task with no drift link goes on, and so does one whose re-check passed, found only failing tests, or could not be told. It WAITS while the re-check runs (up to
 * `RECHECK_WAIT_MAX_MS`, after which an answer that has not come is unclear and never blocks). It is paused ONLY for "setup broken", and only while the project is still at the revision that broke; a newly approved
 * setup is a new revision and lets it through. A repeated question after the task went on answers `go` at once. Never throws: a fault lets the task go on.
 */
export async function setupGateBeforeBuild(deps: TaskFlowDeps, input: { project: string; taskId: string }): Promise<BuildGate> {
  try {
    const orgId = deps.companyId;
    const linkKey = driftTaskKey(orgId, input.project, input.taskId);
    const stored = await deps.store.get(linkKey);
    if (!isRow(stored, orgId, input.project, "SETUP_DRIFT_TASK") || stored?.["taskId"] !== input.taskId) return { answer: "go" };
    const link = stored as unknown as DriftTaskRow;
    if (link.state === "released") return { answer: "go" };
    const release = async (): Promise<BuildGate> => {
      await deps.store.update({ key: linkKey, ops: [change.set("state", "released"), change.set("releasedAt", iso(deps))], condition: when.eq("state", "pending") }).catch(() => undefined);
      return { answer: "go" };
    };
    const row = await advanceRecheck(deps, input.project, link.recheckKey);
    if (row === undefined) return release();
    if (row.state === "running") {
      const waited = (deps.now?.() ?? new Date()).getTime() - Date.parse(row.startedAt);
      return waited > RECHECK_WAIT_MAX_MS ? release() : { answer: "wait" };
    }
    if (row.state !== "broken") return release();
    const latest = await deps.projects.latest(input.project);
    // A new setup was approved since: it has its own baseline, and this task is no longer held back by the old break.
    if (latest === undefined || latest.definition.revision !== row.setupRevision) return release();
    // The project's mark may not have been written when the break was settled (a store fault): it is written again now, and only a mark that is someone else's (a newer check) lifts the break.
    if (!(await brokenStillHolds(deps, input.project, row))) {
      await markProjectBroken(deps, input.project, row);
      if (!(await brokenStillHolds(deps, input.project, row))) return release();
    }
    return { answer: "blocked", words: setupBrokenTaskWords(row.failedStep ?? "setup") };
  } catch (error) {
    log(deps, { event: "setup_drift.gate_failed", taskId: input.taskId, error: errorName(error) });
    return { answer: "go" };
  }
}

