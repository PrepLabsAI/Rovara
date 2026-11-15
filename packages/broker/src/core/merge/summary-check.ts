// TE-B4: the one "Rovara" Check on each pull request head, kept by the tracking pass (testing plan O48).
//
// After a tracking pass has read a pull request (and judged its change proof, TE-B5), `syncSummaryCheck` works out the Check for the head (contracts' pure `rovaraCheckOf`) and writes it to the code host
// only when it changed. A new head gets a new run; the old head's run is left as it is. The write uses the host's own narrow Check permission: an install that has not granted it answers
// `no_permission`, and the pull request body stays the only summary (asked again after an hour). When Rovara stops following a task, `stopSummaryChecks` sets any run still in progress to
// neutral once, so a required Check never hangs. Everything here is best effort: a failure is logged and never fails the pass.
//
// One small record per pull request, not part of the tracking item (its digest and stored shape are untouched):
//   DEVTASK#<task> / ROVARA_CHECK#<repo>#<n>   the head, the run id, the digest of what was last written, when the head was first seen, its status
// Without a `SummaryCheckSource` (the `summaryCheck` gate off) nothing here runs.
import { createHash } from "node:crypto";
import {
  rovaraCheckOf, type ChangeRequestStatus, type CodeHost, type DocumentStore, type HostScope, type OrgId, type ReadBudget, type RovaraCheckFullSuite, type RovaraCheckInput, type RovaraCheckPayload, type RovaraCheckProblem,
} from "@agentx/contracts";
import { plain } from "./store.js";
import { readProofHold } from "./proof-hold.js";
import type { MergeTask } from "./seams.js";

/** What the host supplies so the Check can be kept. Absent: no Check (gate `summaryCheck` off). */
export interface SummaryCheckSource {
  /** The `summaryCheck` gate for the task's company and project. False: no Check is written for it. */
  enabled(task: MergeTask): Promise<boolean> | boolean;
  /** What the evidence says for the head beyond the proof: a Rovara problem, checks that did not run, the full suite after the draft. Undefined: nothing more is known. */
  facts?(input: { task: MergeTask; repositoryId: string; number: number; headSha: string }): Promise<{ problem?: RovaraCheckProblem | undefined; fullSuite?: RovaraCheckFullSuite | undefined } | undefined>;
  /** The name of a person as Rovara shows it (the override's actor). Undefined: "a person". */
  personName?(orgId: OrgId, personId: string): Promise<string | undefined>;
  /** Where the Check's "Details" opens: the task's signed-in page. Only an https address is used. */
  detailsUrl?(task: MergeTask): string | undefined;
}

export const SUMMARY_CHECK_ENTITY = "ROVARA_CHECK";
/** How long after a refused write (no Check permission) the write is tried again. */
export const SUMMARY_CHECK_PERMISSION_RETRY_MS = 3_600_000;
/** The most pull requests one stop pass looks at. */
const STOP_MAX = 50;

const part = (value: string, what: string): string => {
  if (value.length === 0 || value.length > 200 || /[#\p{Cc}]/u.test(value)) throw new Error(`${what} is not a usable key part`);
  return value;
};
export const summaryCheckKey = (taskId: string, repositoryId: string, number: number): { pk: string; sk: string } =>
  ({ pk: `DEVTASK#${part(taskId, "a task id")}`, sk: `${SUMMARY_CHECK_ENTITY}#${part(repositoryId, "a repository id")}#${String(number)}` });

export interface SummaryCheckRecord {
  orgId: OrgId;
  taskId: string;
  repositoryId: string;
  number: number;
  headSha: string;
  firstSeenAtMs: number;
  runId?: string;
  digest?: string;
  status?: RovaraCheckPayload["status"];
  noPermissionAtMs?: number;
}

const SHA = /^[a-f0-9]{40}$/u;
/** A stored record of this org and task, or undefined (never one of another). */
export function summaryCheckRecordOf(stored: Record<string, unknown> | undefined, orgId: OrgId, taskId: string): SummaryCheckRecord | undefined {
  if (stored === undefined || stored["entityType"] !== SUMMARY_CHECK_ENTITY || stored["orgId"] !== orgId || stored["taskId"] !== taskId) return undefined;
  const { repositoryId, number, headSha, firstSeenAtMs, runId, digest, status, noPermissionAtMs } = stored;
  if (typeof repositoryId !== "string" || typeof number !== "number" || !Number.isSafeInteger(number) || typeof headSha !== "string" || !SHA.test(headSha) || typeof firstSeenAtMs !== "number" || !Number.isFinite(firstSeenAtMs)) return undefined;
  return {
    orgId, taskId, repositoryId, number, headSha, firstSeenAtMs,
    ...(typeof runId === "string" && runId.length > 0 && runId.length <= 100 ? { runId } : {}),
    ...(typeof digest === "string" ? { digest } : {}),
    ...(status === "in_progress" || status === "completed" ? { status } : {}),
    ...(typeof noPermissionAtMs === "number" && Number.isFinite(noPermissionAtMs) ? { noPermissionAtMs } : {}),
  };
}

const httpsOnly = (url: string | undefined): string | undefined => {
  if (url === undefined || url.length > 2_000) return undefined;
  try {
    return new URL(url).protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
};
const digestOf = (payload: RovaraCheckPayload, detailsUrl: string | undefined): string => createHash("sha256").update(JSON.stringify([payload, detailsUrl ?? null])).digest("hex");
const errorName = (error: unknown): string => (error instanceof Error ? error.name : "unknown");

/** The source word of Rovara's own checks on this host, or undefined (no such method, or it failed: then nothing is dropped and nothing posted). */
export async function ownCheckSourceOf(codeHost: CodeHost, scope: HostScope): Promise<string | undefined> {
  if (codeHost.summaryCheckSource === undefined) return undefined;
  try {
    const source = await codeHost.summaryCheckSource(scope);
    return typeof source === "string" && source.length > 0 && source.length <= 200 ? source : undefined;
  } catch {
    return undefined;
  }
}

export interface SummaryCheckDependencies {
  store: Pick<DocumentStore, "get" | "put">;
  now(): number;
  source: SummaryCheckSource;
  log?(event: string, fields: Record<string, unknown>): void;
}

export interface SummaryCheckPass {
  task: MergeTask & { orgId: OrgId };
  pullRequest: { repositoryId: string; number: number };
  codeHost: CodeHost;
  repositoryUrl: string;
  scope: HostScope;
  budget?: ReadBudget | undefined;
  status: Pick<ChangeRequestStatus, "headRevision" | "draft" | "state">;
  ci: RovaraCheckInput["ci"];
  ciMode: RovaraCheckInput["ciMode"];
  /** The head is one Rovara pushed (a person's head was never checked by Rovara). */
  headByRovara: boolean;
  /** The pull request is ready for review as Rovara reads it (taken out of draft, or never a draft and given its reviewers). */
  ready: boolean;
  /** The pass judged the proof with a `ProofHoldSource`. False: there is no proof hold, so a ready pull request is simply ready. */
  proofHoldOn: boolean;
}

/** The proof part of the Check, from what TE-B5 recorded for this head. */
async function proofOf(deps: SummaryCheckDependencies, pass: SummaryCheckPass): Promise<{ proof: RovaraCheckInput["proof"]; override?: { by: string } }> {
  const judged = await readProofHold(deps.store, pass.task, { repositoryId: pass.pullRequest.repositoryId, number: pass.pullRequest.number, headSha: pass.status.headRevision });
  if (judged !== undefined) {
    const { record } = judged;
    if (record.holds) {
      // A hold names its reasons; one that names none is not read as any particular reason (never a guess): the head reads as not judged.
      if (record.reasons.length === 0) return { proof: { kind: "not_judged" } };
      const override = judged.override === undefined ? undefined : { by: (await deps.source.personName?.(pass.task.orgId, judged.override.actorId).catch(() => undefined)) ?? "" };
      return { proof: { kind: "held", reasons: record.reasons, provenCount: record.provenCount }, ...(override === undefined ? {} : { override }) };
    }
    return { proof: { kind: "proceed", warns: record.warns, relaxed: record.relaxed, provenCount: record.provenCount, reasons: record.warns ? record.reasons : [] } };
  }
  // Nothing judged for this head: with no proof hold a ready pull request is ready; with one, a pull request that was never a draft was never judged and says only "Ready".
  if (pass.ready && (!pass.proofHoldOn || !pass.status.draft)) return { proof: { kind: "proceed", warns: false, relaxed: false, provenCount: 0, reasons: [] } };
  return { proof: { kind: "not_judged" } };
}

/** Works out the head's Check and writes it when it changed. Best effort: never throws. */
export async function syncSummaryCheck(deps: SummaryCheckDependencies, pass: SummaryCheckPass): Promise<"written" | "unchanged" | "off" | "no_permission" | "failed"> {
  try {
    if (pass.codeHost.upsertSummaryCheck === undefined || pass.status.state !== "open") return "off";
    if (!(await deps.source.enabled(pass.task))) return "off";
    if ((await ownCheckSourceOf(pass.codeHost, pass.scope)) === undefined) return "off";
    const now = deps.now();
    const head = pass.status.headRevision;
    if (!SHA.test(head)) return "failed";
    const key = summaryCheckKey(pass.task.taskId, pass.pullRequest.repositoryId, pass.pullRequest.number);
    const stored = summaryCheckRecordOf(await deps.store.get(key), pass.task.orgId, pass.task.taskId);
    const same = stored !== undefined && stored.headSha === head ? stored : undefined;
    if (same?.noPermissionAtMs !== undefined && now - same.noPermissionAtMs < SUMMARY_CHECK_PERMISSION_RETRY_MS) return "no_permission";
    const firstSeenAtMs = same?.firstSeenAtMs ?? now;
    const facts = await deps.source.facts?.({ task: pass.task, repositoryId: pass.pullRequest.repositoryId, number: pass.pullRequest.number, headSha: head });
    const { proof, override } = await proofOf(deps, pass);
    const problem = facts?.problem ?? (pass.headByRovara ? undefined : "not_run");
    const payload = rovaraCheckOf({
      proof, ...(override === undefined ? {} : { override }), ...(problem === undefined ? {} : { problem }),
      ci: pass.ci, ciMode: pass.ciMode, fullSuite: facts?.fullSuite ?? "not_needed", firstSeenAtMs, nowMs: now,
    });
    const detailsUrl = httpsOnly(deps.source.detailsUrl?.(pass.task));
    const digest = digestOf(payload, detailsUrl);
    if (same?.runId !== undefined && same.digest === digest) return "unchanged";
    const written = await pass.codeHost.upsertSummaryCheck({ url: pass.repositoryUrl }, { headRevision: head, payload, ...(same?.runId === undefined ? {} : { runId: same.runId }), ...(detailsUrl === undefined ? {} : { detailsUrl }) }, pass.scope, pass.budget);
    const record: SummaryCheckRecord = {
      orgId: pass.task.orgId, taskId: pass.task.taskId, repositoryId: pass.pullRequest.repositoryId, number: pass.pullRequest.number, headSha: head, firstSeenAtMs,
      ...(written === "no_permission" ? { noPermissionAtMs: now } : { runId: written.runId, digest, status: payload.status }),
    };
    await deps.store.put({ item: plain({ ...key, entityType: SUMMARY_CHECK_ENTITY, ...record }) });
    if (written === "no_permission") {
      deps.log?.("summary_check.no_permission", { taskId: pass.task.taskId, number: pass.pullRequest.number });
      return "no_permission";
    }
    return "written";
  } catch (error) {
    deps.log?.("summary_check.failed", { taskId: pass.task.taskId, number: pass.pullRequest.number, error: errorName(error) });
    return "failed";
  }
}

export interface StopDependencies extends SummaryCheckDependencies {
  store: Pick<DocumentStore, "get" | "put" | "query">;
  repository(project: string, revision: number, repositoryId: string, orgId: OrgId): Promise<{ url: string; codeHost: CodeHost } | undefined>;
  scope(orgId: OrgId): HostScope;
}

/** Rovara stopped following the task: every run of it still in progress is set to neutral, once. Best effort: never throws. Returns how many were finished. */
export async function stopSummaryChecks(deps: StopDependencies, task: MergeTask & { orgId: OrgId }): Promise<number> {
  let finished = 0;
  try {
    const page = await deps.store.query({ pk: `DEVTASK#${part(task.taskId, "a task id")}`, sk: { op: "beginsWith", prefix: `${SUMMARY_CHECK_ENTITY}#` }, limit: STOP_MAX });
    for (const item of page.items) {
      const record = summaryCheckRecordOf(item, task.orgId, task.taskId);
      if (record === undefined || record.status !== "in_progress" || record.runId === undefined) continue;
      try {
        const home = await deps.repository(task.project, task.startingRevision, record.repositoryId, task.orgId);
        if (home?.codeHost.upsertSummaryCheck === undefined) continue;
        const payload = rovaraCheckOf({ proof: { kind: "not_judged" }, ci: "pending", ciMode: "their_ci_fix", fullSuite: "not_needed", firstSeenAtMs: record.firstSeenAtMs, nowMs: deps.now(), stopped: true });
        const written = await home.codeHost.upsertSummaryCheck({ url: home.url }, { headRevision: record.headSha, payload, runId: record.runId }, deps.scope(task.orgId));
        if (written === "no_permission") continue;
        await deps.store.put({ item: plain({ ...summaryCheckKey(task.taskId, record.repositoryId, record.number), entityType: SUMMARY_CHECK_ENTITY, ...record, digest: digestOf(payload, undefined), status: payload.status }) });
        finished += 1;
      } catch (error) {
        deps.log?.("summary_check.stop_failed", { taskId: task.taskId, number: record.number, error: errorName(error) });
      }
    }
  } catch (error) {
    deps.log?.("summary_check.stop_failed", { taskId: task.taskId, error: errorName(error) });
  }
  return finished;
}
