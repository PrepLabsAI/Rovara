// The after-merge watcher (M7, first slice). Three entry points, each checked at runtime and each OFF unless the project's `afterMergeWatch` setting says on:
//
//   observeDeployment   a deploy fact. The revision is resolved through the merge-commit index (company, repository and commit), so a commit Rovara did not merge is ignored and nothing says whether it exists.
//                       A successful deploy opens a watch for the window; a failed one is reported and closed at once; one in progress is ignored.
//   observeSignal       an alarm (a trigger event the engine already defines). It is recorded on each open watch of its project whose window it falls in, and reported once for that watch.
//   closeDueWatches     the sweep: closes the watches whose window ended ("deployed, healthy for N min" when no alarm is left that nobody marked expected), and sends again what could not be sent.
//
// A report is written WITH the change that needs it (a `reportPending` flag and a queue row, in the same transaction), then sent, then cleared. A report that could not be sent stays pending and goes out on the
// next sweep, at least once (a reporter that sees a `reportId` twice posts once). Nothing here deploys, starts paid work, or opens a revert: a person's press does that (actions.ts).
import { createHash } from "node:crypto";
import { DocumentStoreError, INDEX_EXPIRY_ATTRIBUTE, OrgIdSchema, change, when, type DocumentStore, type OrgId, type StoredDocument, type TransactItem } from "@agentx/contracts";
import { findMergeCommit } from "../proof/revert/merge-commit-index.js";
import { inertLine } from "../proof/inert-text.js";
import { PAGES_MAX, TooManyRows, pageOf, readBounded } from "./bounded.js";
import { parseDeployFact, readAlarm } from "./facts.js";
import type { AfterMergeDeps, AfterMergeReport, AfterMergeSettings } from "./ports.js";
import {
  ALARMS_PER_WATCH_MAX, ALARM_ENTITY, QUEUE_ENTITY, expiring, WATCH_ENTITY, WATCH_KEPT_DAYS, alarmKey, alarmsOfWatch, allOpen, allPending, expectedKey, expiryOf, openKey, openOfProject, pendingKey, readAlarm as readAlarmRow,
  readExpected, readOpen, readPending, readWatch, watchKey, WatchRowSchema, type AlarmRow, type PendingRow, type WatchRow,
} from "./records.js";
import { afterMergeSettingsOf } from "./settings.js";

/** The most open watches one alarm looks at, and the most due watches and pending reports one sweep handles. A range over the first is refused whole; the sweep's remainder waits for the next sweep. */
export const OPEN_WATCHES_MAX = 200;
export const SWEEP_BATCH_MAX = 100;
/** An alarm dated further ahead than this is not believed. */
const FUTURE_SKEW_MS = 60_000;
const REPORT_WORDS_MAX = 120;

export type DeploymentOutcome =
  | { kind: "off" }
  | { kind: "unavailable" }
  | { kind: "ignored"; reason: "invalid_fact" | "not_ours" | "environment_not_watched" | "in_progress" }
  | { kind: "opened"; windowEndsAt: string }
  | { kind: "already_watched" }
  | { kind: "deploy_failed" };

export type SignalOutcome =
  | { kind: "off" }
  | { kind: "unavailable" }
  | { kind: "ignored"; reason: "invalid_event" | "not_an_alarm" | "no_open_watch" }
  | { kind: "recorded"; watches: number; reported: number; silenced: number; dropped?: number };

export interface SweepOutcome { closed: number; delivered: number; more: boolean }

export const ttlAttributeOf = (store: Pick<DocumentStore, "ttlAttribute">): string => store.ttlAttribute ?? INDEX_EXPIRY_ATTRIBUTE;
const validCompany = (orgId: unknown): orgId is OrgId => OrgIdSchema.safeParse(orgId).success;

/** Runs a step that reads or writes the store; a store fault is logged with its code only and answers `unavailable`. Any other error is a bug and is thrown. */
export async function guarded<T>(deps: Pick<AfterMergeDeps, "log">, step: () => Promise<T>): Promise<T | "unavailable"> {
  try {
    return await step();
  } catch (error) {
    if (error instanceof TooManyRows) {
      deps.log?.("after_merge.too_many_rows", { level: "warn" });
      return "unavailable";
    }
    if (error instanceof DocumentStoreError) {
      deps.log?.("after_merge.store_unavailable", { level: "warn", code: error.code });
      return "unavailable";
    }
    throw error;
  }
}

const hex = (...parts: string[]): string => createHash("sha256").update(parts.join("\n")).digest("hex");

// ---- the deploy

export async function observeDeployment(deps: AfterMergeDeps, orgId: OrgId, input: unknown): Promise<DeploymentOutcome> {
  if (!validCompany(orgId)) return { kind: "ignored", reason: "invalid_fact" };
  if (deps.settings === undefined) return { kind: "off" };
  const fact = parseDeployFact(input);
  if (fact === undefined) return { kind: "ignored", reason: "invalid_fact" };
  const result = await guarded(deps, async (): Promise<DeploymentOutcome> => {
    const merge = await findMergeCommit(deps.store, { orgId, repositoryFullName: fact.repository, sha: fact.revision });
    if (merge === undefined) return { kind: "ignored", reason: "not_ours" };
    let task: Awaited<ReturnType<AfterMergeDeps["tasks"]["read"]>>;
    try {
      task = await deps.tasks.read(orgId, merge.taskId);
    } catch {
      deps.log?.("after_merge.task_unavailable", { level: "warn" });
      return { kind: "unavailable" };
    }
    if (task === undefined || task.orgId !== orgId || task.taskId !== merge.taskId) return { kind: "ignored", reason: "not_ours" };
    const settings = await afterMergeSettingsOf(deps.settings, orgId, task.project);
    if (settings === undefined) return { kind: "off" };
    if (settings.environments.length > 0 && !settings.environments.some((name) => name.toLowerCase() === fact.environment.toLowerCase())) return { kind: "ignored", reason: "environment_not_watched" };
    if (fact.state === "in_progress") return { kind: "ignored", reason: "in_progress" };
    const nowMs = deps.now().getTime();
    const failed = fact.state === "failure";
    const windowEndsMs = nowMs + settings.windowMinutes * 60_000;
    const ttl = ttlAttributeOf(deps.store);
    const key = watchKey(orgId, fact.repository, merge.number, fact.environment);
    const row: StoredDocument = {
      ...key, entityType: WATCH_ENTITY, orgId, taskId: merge.taskId, project: task.project, repository: fact.repository, repositoryId: merge.repositoryId, number: merge.number, url: merge.url, revision: fact.revision,
      environment: fact.environment, source: fact.source, state: failed ? "closed" : "open", ...(failed ? { outcome: "deploy_failed", closedAt: new Date(nowMs).toISOString(), reportPending: true } : {}),
      openedAt: new Date(nowMs).toISOString(), windowEndsAt: new Date(windowEndsMs).toISOString(), windowMinutes: settings.windowMinutes, alarmCount: 0, ...expiring(ttl, expiryOf(windowEndsMs, WATCH_KEPT_DAYS)),
    };
    // A row this code could not read back is never written (a merge record with an odd link or number).
    if (!WatchRowSchema.safeParse(row).success) return { kind: "ignored", reason: "not_ours" };
    const items: TransactItem[] = [{ kind: "put", item: row, condition: when.absent() }];
    if (failed) items.push(pendingItem(orgId, "watch", fact.repository, merge.number, fact.environment, "-", ttl, nowMs));
    else items.push({ kind: "put", item: { ...openKey(orgId, task.project, fact.repository, merge.number, fact.environment), entityType: QUEUE_ENTITY, queue: "open", orgId, project: task.project, repository: fact.repository, number: merge.number, environment: fact.environment, windowEndsAtMs: windowEndsMs, ...expiring(ttl, expiryOf(windowEndsMs, WATCH_KEPT_DAYS)) } });
    const written = await deps.store.transact(items);
    if (!written.applied) return { kind: "already_watched" };
    if (failed) {
      await deliverPending(deps, orgId, pendingRowOf(orgId, "watch", fact.repository, merge.number, fact.environment, "-"));
      return { kind: "deploy_failed" };
    }
    return { kind: "opened", windowEndsAt: new Date(windowEndsMs).toISOString() };
  });
  return result === "unavailable" ? { kind: "unavailable" } : result;
}

// ---- the queue of reports

function pendingItem(orgId: OrgId, kind: "watch" | "alarm", repository: string, number: number, environment: string, signalKey: string, ttl: string, nowMs: number): TransactItem {
  return { kind: "put", item: { ...pendingKey(orgId, kind, repository, number, environment, signalKey), entityType: QUEUE_ENTITY, queue: "pending", orgId, kind, repository, number, environment, signalKey, ...expiring(ttl, expiryOf(nowMs, WATCH_KEPT_DAYS)) } };
}
function pendingRowOf(orgId: OrgId, kind: "watch" | "alarm", repository: string, number: number, environment: string, signalKey: string): PendingRow {
  const key = pendingKey(orgId, kind, repository, number, environment, signalKey);
  return { ...key, entityType: QUEUE_ENTITY, queue: "pending", orgId, kind, repository, number, environment, signalKey };
}

type Delivery = "sent" | "cleared" | "skipped" | "failed";

const WORDS = (text: string): string => inertLine(text, REPORT_WORDS_MAX);

function reportOf(kind: "healthy" | "alarm" | "deploy_failed", row: { taskId: string; repository: string; number: number; url: string; environment: string }, reportId: string, extra: { text: string; signalKey?: string; revert: boolean; expected: boolean }): AfterMergeReport {
  return {
    reportId, kind, taskId: row.taskId, repository: row.repository, number: row.number, url: row.url, environment: WORDS(row.environment), text: extra.text, ...(extra.signalKey === undefined ? {} : { signalKey: extra.signalKey }),
    actions: { revert: extra.revert, expected: extra.expected },
  };
}

/**
 * Sends one pending report and clears it. A report whose project has been switched off since is left alone (nothing runs while it is off); a report whose row is gone or unreadable is dropped; one whose alarm the
 * person marked expected meanwhile is cleared without being sent. A reporter that fails leaves it pending, with a fixed code in the log and no text from the failure.
 */
export async function deliverPending(deps: AfterMergeDeps, orgId: OrgId, pending: PendingRow): Promise<Delivery> {
  const queueKey = pendingKey(orgId, pending.kind, pending.repository, pending.number, pending.environment, pending.signalKey);
  const drop = async (): Promise<Delivery> => { await deps.store.delete({ key: queueKey }); return "cleared"; };
  if (pending.kind === "watch") {
    const watch = readWatch(await deps.store.get(watchKey(orgId, pending.repository, pending.number, pending.environment)), orgId);
    if (watch === undefined || watch.reportPending !== true || (watch.outcome !== "healthy" && watch.outcome !== "deploy_failed")) return drop();
    if (await afterMergeSettingsOf(deps.settings, orgId, watch.project) === undefined) return "skipped";
    const thisKey = watchKey(orgId, watch.repository, watch.number, watch.environment);
    const reportId = hex("after_merge.report", thisKey.pk, thisKey.sk, watch.outcome);
    const environment = WORDS(watch.environment);
    const text = watch.outcome === "healthy" ? `Deployed to ${environment}, healthy for ${String(watch.windowMinutes)} min.` : `Deploy to ${environment} failed.`;
    return send(deps, orgId, reportOf(watch.outcome, watch, reportId, { text, revert: false, expected: false }), { key: watchKey(orgId, watch.repository, watch.number, watch.environment), queueKey });
  }
  const alarm = readAlarmRow(await deps.store.get(alarmKey(orgId, pending.repository, pending.number, pending.environment, pending.signalKey)), orgId);
  if (alarm === undefined || alarm.reportPending !== true) return drop();
  if (await afterMergeSettingsOf(deps.settings, orgId, alarm.project) === undefined) return "skipped";
  if (readExpected(await deps.store.get(expectedKey(orgId, alarm.repository, alarm.number, alarm.signalKey)), orgId) !== undefined) {
    await clear(deps, alarmKey(orgId, alarm.repository, alarm.number, alarm.environment, alarm.signalKey), queueKey);
    return "cleared";
  }
  const thisKey = alarmKey(orgId, alarm.repository, alarm.number, alarm.environment, alarm.signalKey);
  const reportId = hex("after_merge.report", thisKey.pk, thisKey.sk, "alarm");
  const text = `Alarm after deploy to ${WORDS(alarm.environment)}: ${alarm.label}.`;
  return send(deps, orgId, reportOf("alarm", alarm, reportId, { text, signalKey: alarm.signalKey, revert: alarm.revertOffered, expected: alarm.expectedOffered }), { key: alarmKey(orgId, alarm.repository, alarm.number, alarm.environment, alarm.signalKey), queueKey });
}

async function clear(deps: AfterMergeDeps, key: { pk: string; sk: string }, queueKey: { pk: string; sk: string }): Promise<void> {
  try {
    // Conditional on the flag, so a row that was removed or already cleared is never made again by this update.
    await deps.store.transact([{ kind: "update", key, ops: [change.remove(["reportPending"])], condition: when.eq("reportPending", true) }, { kind: "delete", key: queueKey }]);
  } catch (error) {
    if (!(error instanceof DocumentStoreError)) throw error;
    deps.log?.("after_merge.clear_failed", { level: "warn", code: error.code });
  }
}

async function send(deps: AfterMergeDeps, orgId: OrgId, report: AfterMergeReport, keys: { key: { pk: string; sk: string }; queueKey: { pk: string; sk: string } }): Promise<Delivery> {
  try {
    await deps.reporter.report(orgId, report);
  } catch {
    deps.log?.("after_merge.report_failed", { level: "warn", kind: report.kind });
    return "failed";
  }
  await clear(deps, keys.key, keys.queueKey);
  return "sent";
}

// ---- the alarm

export async function observeSignal(deps: AfterMergeDeps, orgId: OrgId, input: unknown): Promise<SignalOutcome> {
  if (!validCompany(orgId)) return { kind: "ignored", reason: "invalid_event" };
  if (deps.settings === undefined) return { kind: "off" };
  const reading = readAlarm(input);
  if (reading.kind === "invalid") return { kind: "ignored", reason: "invalid_event" };
  if (reading.kind === "not_an_alarm") return { kind: "ignored", reason: "not_an_alarm" };
  const alarm = reading.fact;
  const settings = await afterMergeSettingsOf(deps.settings, orgId, alarm.project);
  if (settings === undefined) return { kind: "off" };
  const nowMs = deps.now().getTime();
  if (alarm.occurredAtMs > nowMs + FUTURE_SKEW_MS) return { kind: "ignored", reason: "no_open_watch" };
  const result = await guarded(deps, async (): Promise<SignalOutcome> => {
    const open = (await readBounded(deps.store, openOfProject(orgId, alarm.project), deps.limits?.openWatchesMax ?? OPEN_WATCHES_MAX)).map((row) => readOpen(row, orgId)).filter((row): row is NonNullable<typeof row> => row !== undefined && row.project === alarm.project);
    const watches: WatchRow[] = [];
    for (const row of open) {
      const watch = readWatch(await deps.store.get(watchKey(orgId, row.repository, row.number, row.environment)), orgId);
      if (watch === undefined || watch.state !== "open" || watch.project !== alarm.project) continue;
      if (alarm.occurredAtMs < Date.parse(watch.openedAt) || alarm.occurredAtMs > Date.parse(watch.windowEndsAt)) continue;
      watches.push(watch);
    }
    if (watches.length === 0) return { kind: "ignored", reason: "no_open_watch" };
    let reported = 0, silenced = 0, dropped = 0;
    for (const watch of watches) {
      const outcome = await recordAlarm(deps, orgId, watch, alarm, settings, nowMs);
      if (outcome === "silenced") silenced += 1;
      else if (outcome === "dropped") dropped += 1;
      else if (outcome === "sent") reported += 1;
    }
    return { kind: "recorded", watches: watches.length, reported, silenced, ...(dropped > 0 ? { dropped } : {}) };
  });
  return result === "unavailable" ? { kind: "unavailable" } : result;
}

async function recordAlarm(deps: AfterMergeDeps, orgId: OrgId, watch: WatchRow, alarm: { signalKey: string; label: string; source: string; type: string; project: string; occurredAtMs: number }, settings: AfterMergeSettings, nowMs: number): Promise<"sent" | "pending" | "duplicate" | "silenced" | "dropped"> {
  if (readExpected(await deps.store.get(expectedKey(orgId, watch.repository, watch.number, alarm.signalKey)), orgId) !== undefined) return "silenced";
  const key = alarmKey(orgId, watch.repository, watch.number, watch.environment, alarm.signalKey);
  if (await deps.store.get(key) !== undefined) return "duplicate";
  const ttl = ttlAttributeOf(deps.store);
  if (watch.alarmCount >= ALARMS_PER_WATCH_MAX) {
    const updated = await deps.store.update({ key: watchKey(orgId, watch.repository, watch.number, watch.environment), ops: [change.add(["alarmsDropped"], 1)], condition: when.eq("state", "open"), return: "new" });
    if (updated.applied && updated.item?.["alarmsDropped"] === 1) deps.log?.("after_merge.alarm_cap", { level: "warn", max: ALARMS_PER_WATCH_MAX });
    return "dropped";
  }
  const row: StoredDocument = {
    ...key, entityType: ALARM_ENTITY, orgId, taskId: watch.taskId, project: watch.project, repository: watch.repository, number: watch.number, url: watch.url, environment: watch.environment, signalKey: alarm.signalKey,
    label: alarm.label, source: alarm.source, type: alarm.type, occurredAt: new Date(alarm.occurredAtMs).toISOString(), recordedAt: new Date(nowMs).toISOString(), reportPending: true,
    revertOffered: settings.revert === "offer_revert", expectedOffered: true, ...expiring(ttl, expiryOf(nowMs, WATCH_KEPT_DAYS)),
  };
  const written = await deps.store.transact([
    { kind: "put", item: row, condition: when.absent() },
    { kind: "update", key: watchKey(orgId, watch.repository, watch.number, watch.environment), ops: [change.add(["alarmCount"], 1)], condition: when.and(when.eq("state", "open"), when.lt("alarmCount", ALARMS_PER_WATCH_MAX)) },
    pendingItem(orgId, "alarm", watch.repository, watch.number, watch.environment, alarm.signalKey, ttl, nowMs),
  ]);
  if (!written.applied) return "duplicate";
  const delivered = await deliverPending(deps, orgId, pendingRowOf(orgId, "alarm", watch.repository, watch.number, watch.environment, alarm.signalKey));
  return delivered === "sent" ? "sent" : "pending";
}

// ---- the window ends

export async function closeDueWatches(deps: AfterMergeDeps, orgId: OrgId): Promise<SweepOutcome> {
  const none: SweepOutcome = { closed: 0, delivered: 0, more: false };
  if (!validCompany(orgId) || deps.settings === undefined) return none;
  const result = await guarded(deps, async (): Promise<SweepOutcome> => {
    const nowMs = deps.now().getTime();
    const projects = new Map<string, AfterMergeSettings | undefined>();
    const settingsOf = async (project: string): Promise<AfterMergeSettings | undefined> => {
      if (!projects.has(project)) projects.set(project, await afterMergeSettingsOf(deps.settings, orgId, project));
      return projects.get(project);
    };
    let closed = 0, delivered = 0, handled = 0;
    // Page past rows of projects that are switched off, so they never block the others; at most one batch is handled, and `more` says the rest waits for the next sweep.
    let more = false;
    let cursor: string | undefined;
    for (let page = 0; page < PAGES_MAX; page += 1) {
      const result = await pageOf(deps.store, { ...allOpen(orgId), filter: when.lte("windowEndsAtMs", nowMs) }, { limit: SWEEP_BATCH_MAX, cursor });
      for (const stored of result.items) {
        const row = readOpen(stored, orgId);
        if (row === undefined || await settingsOf(row.project) === undefined) continue;
        if (handled >= SWEEP_BATCH_MAX) { more = true; break; }
        handled += 1;
        if (await closeOne(deps, orgId, row.project, row.repository, row.number, row.environment, nowMs)) closed += 1;
      }
      cursor = result.cursor;
      if (cursor === undefined || more) break;
    }
    if (cursor !== undefined) more = true;
    // Pending reports: the same, paging past reports that are skipped (project off) or keep failing, one batch of attempts a sweep.
    let attempts = 0;
    cursor = undefined;
    for (let page = 0; page < PAGES_MAX && attempts < SWEEP_BATCH_MAX; page += 1) {
      const result = await pageOf(deps.store, allPending(orgId), { limit: SWEEP_BATCH_MAX, cursor });
      for (const stored of result.items) {
        const row = readPending(stored, orgId);
        if (row === undefined || attempts >= SWEEP_BATCH_MAX) continue;
        const outcome = await deliverPending(deps, orgId, row);
        if (outcome === "skipped") continue;
        attempts += 1;
        if (outcome === "sent") delivered += 1;
      }
      cursor = result.cursor;
      if (cursor === undefined) break;
    }
    return { closed, delivered, more };
  });
  return result === "unavailable" ? none : result;
}

async function closeOne(deps: AfterMergeDeps, orgId: OrgId, project: string, repository: string, number: number, environment: string, nowMs: number): Promise<boolean> {
  const queueKey = openKey(orgId, project, repository, number, environment);
  const key = watchKey(orgId, repository, number, environment);
  const watch = readWatch(await deps.store.get(key), orgId);
  if (watch === undefined || watch.state !== "open" || watch.project !== project) {
    await deps.store.delete({ key: queueKey });
    return false;
  }
  const alarms: AlarmRow[] = [];
  for (const stored of await readBounded(deps.store, alarmsOfWatch(orgId, repository, number, environment), ALARMS_PER_WATCH_MAX)) {
    const alarm = readAlarmRow(stored, orgId);
    if (alarm !== undefined) alarms.push(alarm);
  }
  const expected = alarms.length === 0 ? [] : await deps.store.getMany(alarms.map((alarm) => expectedKey(orgId, repository, number, alarm.signalKey)));
  const unsilenced = alarms.filter((_alarm, index) => readExpected(expected[index], orgId) === undefined);
  const healthy = unsilenced.length === 0;
  const ttl = ttlAttributeOf(deps.store);
  const items: TransactItem[] = [
    {
      kind: "update", key, condition: when.and(when.eq("state", "open"), when.eq("orgId", orgId), when.eq("alarmCount", watch.alarmCount)),
      ops: [change.set(["state"], "closed"), change.set(["outcome"], healthy ? "healthy" : "alarm"), change.set(["closedAt"], new Date(nowMs).toISOString()), change.set([ttl], expiryOf(nowMs, WATCH_KEPT_DAYS)), ...(healthy ? [change.set(["reportPending"], true)] : [])],
    },
    { kind: "delete", key: queueKey },
    ...(healthy ? [pendingItem(orgId, "watch", repository, number, environment, "-", ttl, nowMs)] : []),
  ];
  const written = await deps.store.transact(items);
  if (!written.applied) return false;
  if (healthy) await deliverPending(deps, orgId, pendingRowOf(orgId, "watch", repository, number, environment, "-"));
  return true;
}

