// The two presses of the after-merge card (M7, first slice): "It's expected" and Revert. Both are a PERSON's act (owner decisions O13, O24, O32):
//
//   markExpected   silences one alarm for one pull request only (other alarms still alert; other pull requests are untouched). The reason is optional. The press and its audit event commit in ONE transaction.
//   pressRevert    starts a revert task through the normal start path, once. Rovara never opens a revert by itself: nothing in the watcher calls the starter except this press. The press counts as a human moment.
//
// Both refuse unless the watcher is on for the project (read live), the actor is a person, and the host's authority says that person may act on the task. A doubt (a failing authority, an unreadable row, a store
// fault) is a refusal or `unavailable`, never a pass. Refusals are fixed words: nothing a caller sent is echoed.
import { createHash } from "node:crypto";
import { OrgIdSchema, when, type AuditEvent, type DocumentStore, type OrgId, type StoredDocument, type TransactItem } from "@agentx/contracts";
import { readBounded } from "./bounded.js";
import { SIGNAL_KEY, isRepositoryName } from "./facts.js";
import type { AfterMergeActionDeps, AfterMergeSettings } from "./ports.js";
import {
  ALARMS_PER_WATCH_MAX, EXPECTED_ENTITY, EXPECTED_KEPT_DAYS, expiring, REVERT_ENTITY, alarmsOfPullRequest, expectedKey, expiryOf, readAlarm, readExpected, readRevert, readWatch, revertKey, watchesOfPullRequest, type WatchRow,
} from "./records.js";
import { afterMergeSettingsOf } from "./settings.js";
import { guarded, ttlAttributeOf } from "./watch.js";

/** The most environments one pull request is watched in that a press looks at. */
const WATCHES_PER_PULL_REQUEST_MAX = 50;
export const REASON_MAX = 500;
const NO_CONTROLS = /^[^\p{Cc}\p{Cf}]*$/u;

export interface PersonActor { type: "person"; personId: string }
export type Refusal = "off" | "not_allowed" | "not_found" | "not_offered" | "invalid_request" | "invalid_reason";

export type ExpectedOutcome = { kind: "recorded" } | { kind: "already" } | { kind: "refused"; reason: Refusal } | { kind: "unavailable" };
export type RevertOutcome =
  | { kind: "started"; taskId: string }
  | { kind: "already_started"; taskId: string }
  | { kind: "refused"; reason: Refusal }
  | { kind: "failed" }
  | { kind: "unavailable" };

const refuse = (reason: Refusal): { kind: "refused"; reason: Refusal } => ({ kind: "refused", reason });
const isPerson = (actor: unknown): actor is PersonActor => {
  if (actor === null || typeof actor !== "object") return false;
  const { type, personId } = actor as Record<string, unknown>;
  return type === "person" && typeof personId === "string" && personId.length > 0 && personId.length <= 200 && NO_CONTROLS.test(personId);
};
const hex = (...parts: string[]): string => createHash("sha256").update(parts.join("\n")).digest("hex");

interface Standing { watch: WatchRow; settings: AfterMergeSettings }

/** The checks both presses share, in a fixed order. The watches of the pull request are read in this company only. */
async function standing(deps: AfterMergeActionDeps, orgId: OrgId, input: { actor: unknown; repository: unknown; number: unknown }): Promise<Standing | { kind: "refused"; reason: Refusal }> {
  const { actor, repository, number } = input;
  if (!isPerson(actor)) return refuse("not_allowed");
  if (!isRepositoryName(repository) || typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) return refuse("invalid_request");
  if (deps.settings === undefined) return refuse("off");
  const range = watchesOfPullRequest(orgId, repository.toLowerCase(), number);
  const watches = (await readBounded(deps.store, range, WATCHES_PER_PULL_REQUEST_MAX)).map((row) => readWatch(row, orgId)).filter((row): row is WatchRow => row !== undefined);
  const watch = watches[0];
  if (watch === undefined) return refuse("not_found");
  const settings = await afterMergeSettingsOf(deps.settings, orgId, watch.project);
  if (settings === undefined) return refuse("off");
  let allowed: boolean;
  try {
    allowed = await deps.authority.mayAct(orgId, actor.personId, { taskId: watch.taskId, project: watch.project }) === true;
  } catch {
    allowed = false;
  }
  return allowed ? { watch, settings } : refuse("not_allowed");
}

async function stagedAudit(deps: AfterMergeActionDeps, event: AuditEvent): Promise<TransactItem[] | "unavailable"> {
  try {
    return [...deps.audit.stage(event)];
  } catch {
    deps.log?.("after_merge.audit_unavailable", { level: "warn" });
    return "unavailable";
  }
}

// ---- It's expected

export async function markExpected(deps: AfterMergeActionDeps, orgId: OrgId, input: { actor: unknown; repository: unknown; number: unknown; signalKey: unknown; reason?: unknown }): Promise<ExpectedOutcome> {
  if (!OrgIdSchema.safeParse(orgId).success) return refuse("invalid_request");
  const { signalKey, reason } = input;
  if (typeof signalKey !== "string" || !SIGNAL_KEY.test(signalKey)) return refuse("invalid_request");
  if (reason !== undefined && (typeof reason !== "string" || Array.from(reason).length > REASON_MAX || !NO_CONTROLS.test(reason))) return refuse("invalid_reason");
  const result = await guarded(deps, async (): Promise<ExpectedOutcome> => {
    const checked = await standing(deps, orgId, input);
    if ("kind" in checked) return checked;
    const { watch } = checked;
    const personId = (input.actor as PersonActor).personId;
    // Only an alarm this pull request has seen can be marked expected: no row is made for a key nobody sent.
    const seen = (await readBounded(deps.store, alarmsOfPullRequest(orgId, watch.repository, watch.number), WATCHES_PER_PULL_REQUEST_MAX * ALARMS_PER_WATCH_MAX)).some((stored) => readAlarm(stored, orgId)?.signalKey === signalKey);
    if (!seen) return refuse("not_found");
    if (readExpected(await deps.store.get(expectedKey(orgId, watch.repository, watch.number, signalKey)), orgId) !== undefined) return { kind: "already" };
    const now = deps.now().toISOString();
    const audit = await stagedAudit(deps, {
      eventId: hex("after_merge.expected", orgId, watch.repository, String(watch.number), signalKey), companyId: orgId, at: now, actor: { type: "person", id: personId }, action: "after_merge.expected",
      subject: { type: "change_request", id: `${watch.repository}#${String(watch.number)}` }, details: { repository: watch.repository, number: watch.number, taskId: watch.taskId, signalKey, ...(reason === undefined ? {} : { reason }) },
    });
    if (audit === "unavailable") return { kind: "unavailable" };
    const row: StoredDocument = {
      ...expectedKey(orgId, watch.repository, watch.number, signalKey), entityType: EXPECTED_ENTITY, orgId, taskId: watch.taskId, repository: watch.repository, number: watch.number, signalKey, personId, at: now,
      ...(reason === undefined ? {} : { reason }), ...expiring(ttlAttributeOf(deps.store), expiryOf(deps.now().getTime(), EXPECTED_KEPT_DAYS)),
    };
    const written = await deps.store.transact([{ kind: "put", item: row, condition: when.absent() }, ...audit]);
    if (written.applied) return { kind: "recorded" };
    // A lost condition on the press itself (step 0) means it was already recorded (whatever the audit step did); only the audit's step failing alone means nothing was written.
    return written.failed.includes(0) ? { kind: "already" } : { kind: "unavailable" };
  });
  return result === "unavailable" ? { kind: "unavailable" } : result;
}

// ---- Revert

export async function pressRevert(deps: AfterMergeActionDeps, orgId: OrgId, input: { actor: unknown; repository: unknown; number: unknown }): Promise<RevertOutcome> {
  if (!OrgIdSchema.safeParse(orgId).success) return refuse("invalid_request");
  const result = await guarded(deps, async (): Promise<RevertOutcome> => {
    const checked = await standing(deps, orgId, input);
    if ("kind" in checked) return checked;
    const { watch, settings } = checked;
    if (settings.revert !== "offer_revert") return refuse("not_offered");
    if (!(await hasUnexpectedAlarm(deps.store, orgId, watch))) return refuse("not_offered");
    const personId = (input.actor as PersonActor).personId;
    const key = revertKey(orgId, watch.repository, watch.number);
    let row = readRevert(await deps.store.get(key), orgId);
    if (row?.state === "started" && row.revertTaskId !== undefined) return { kind: "already_started", taskId: row.revertTaskId };
    const requestId = hex("after_merge.revert", orgId, watch.repository, String(watch.number));
    const mergeCommit = watch.revision;
    if (row === undefined) {
      const now = deps.now();
      const audit = await stagedAudit(deps, {
        eventId: requestId, companyId: orgId, at: now.toISOString(), actor: { type: "person", id: personId }, action: "after_merge.revert_requested",
        subject: { type: "change_request", id: `${watch.repository}#${String(watch.number)}` }, details: { repository: watch.repository, number: watch.number, taskId: watch.taskId, mergeCommit },
      });
      if (audit === "unavailable") return { kind: "unavailable" };
      const claim: StoredDocument = {
        ...key, entityType: REVERT_ENTITY, orgId, taskId: watch.taskId, repository: watch.repository, number: watch.number, url: watch.url, mergeCommit, requestId, requestedBy: personId, requestedAt: now.toISOString(),
        state: "starting", ...expiring(ttlAttributeOf(deps.store), expiryOf(now.getTime(), EXPECTED_KEPT_DAYS)),
      };
      const written = await deps.store.transact([{ kind: "put", item: claim, condition: when.absent() }, ...audit]);
      if (!written.applied) {
        // Another press claimed it first (or the audit's step failed): read what is there. Nothing there means nothing was written.
        row = readRevert(await deps.store.get(key), orgId);
        if (row === undefined) return { kind: "unavailable" };
        if (row.state === "started" && row.revertTaskId !== undefined) return { kind: "already_started", taskId: row.revertTaskId };
      }
    }
    if (row !== undefined && row.requestedBy !== personId) {
      // A different person pressing again after a failed start: the press that reaches the starter is audited too (the claim row must still be the one read).
      const retryAt = deps.now().toISOString();
      const retry = await stagedAudit(deps, {
        eventId: hex("after_merge.revert_retried", requestId, personId, retryAt), companyId: orgId, at: retryAt, actor: { type: "person", id: personId }, action: "after_merge.revert_retried",
        subject: { type: "change_request", id: `${watch.repository}#${String(watch.number)}` }, details: { repository: watch.repository, number: watch.number, taskId: watch.taskId, mergeCommit },
      });
      if (retry === "unavailable") return { kind: "unavailable" };
      const checked = await deps.store.transact([{ kind: "check", key, condition: when.and(when.eq("orgId", orgId), when.eq("state", "starting")) }, ...retry]);
      if (!checked.applied) return { kind: "unavailable" };
    }
    try {
      const started = await deps.starter.start({ requestId, orgId, taskId: watch.taskId, repository: watch.repository, number: watch.number, url: watch.url, mergeCommit, requestedBy: row?.requestedBy ?? personId });
      if (typeof started?.taskId !== "string" || started.taskId.length === 0 || started.taskId.length > 200) throw new Error("no task");
      await deps.store.update({ key, ops: [{ op: "set", path: ["state"], value: "started" }, { op: "set", path: ["revertTaskId"], value: started.taskId }], condition: when.and(when.eq("orgId", orgId), when.eq("state", "starting")) });
      return { kind: "started", taskId: started.taskId };
    } catch {
      deps.log?.("after_merge.revert_start_failed", { level: "warn" });
      return { kind: "failed" };
    }
  });
  return result === "unavailable" ? { kind: "unavailable" } : result;
}

/** A pull request's revert is offered only while one of its alarms is one nobody marked expected. */
async function hasUnexpectedAlarm(store: DocumentStore, orgId: OrgId, watch: WatchRow): Promise<boolean> {
  const alarms = (await readBounded(store, alarmsOfPullRequest(orgId, watch.repository, watch.number), WATCHES_PER_PULL_REQUEST_MAX * ALARMS_PER_WATCH_MAX)).map((stored) => readAlarm(stored, orgId)).filter((row) => row !== undefined);
  if (alarms.length === 0) return false;
  const keys = [...new Set(alarms.map((alarm) => alarm.signalKey))].map((signalKey) => expectedKey(orgId, watch.repository, watch.number, signalKey));
  const silenced = new Set<string>();
  for (let from = 0; from < keys.length; from += 100) {
    for (const stored of await store.getMany(keys.slice(from, from + 100))) {
      const signal = readExpected(stored, orgId)?.signalKey;
      if (signal !== undefined) silenced.add(signal);
    }
  }
  return alarms.some((alarm) => !silenced.has(alarm.signalKey));
}
