// L4-LM1c: the producer of the human-edit job. The tracking pass tells it when a pull request's head is not one of Rovara's own pushes (`HumanEditSink`, core/merge/seams.ts); it decides whether to queue the job the
// worker consumes (`reflect-worker.ts`, `learnFromHumanEdit`). It holds, in this order:
//   - the install's lessons switch and the project's learning mode FIRST, from the project alone: with learning Off, or only collecting, nothing is read from the code host and nothing is queued;
//   - the company: the task is read now and must be this company's (and the project the pass named); a push of any other company's task is ignored, and the code host it reads is the one the pass resolved for this
//     company's own installation (the caller built the push from the task's own project and the company's scope);
//   - once for each head: a row for (task, head commit) in the company's own partition says the head was already queued or already judged not worth reading, so a pass that sees the same head again (every pass does, until
//     the pull request ends) reads nothing and queues nothing; the queue's own dedupe id and the worker's lease are the same identity, so even a lost race costs one job, never two paid ones;
//   - the proof and the bounds (`readPersonEdit`): a person's commits only, a diff that is too large or teaches nothing is recorded as skipped with a fixed reason;
//   - the message: ids and one fixed word only (`humanEditMessageOf`). The diff is read again by the worker, live, never carried in the queue.
// A fault (the host cannot answer, the queue does not take the message) leaves no row, so the next pass tries again. Nothing here makes a model call.
import { companyScoped, when, type DocumentStore, type OrgId } from "@agentx/contracts";
import { createHash } from "node:crypto";
import { providerOf } from "../plugins/routing.js";
import type { HumanEditPush } from "../core/merge/seams.js";
import type { TaskRecord } from "../core/task-flow/records.js";
import type { HumanEditJob } from "./capture-types.js";
import { HumanEditAllowanceError, allowanceBudget, readPersonEdit, type HumanEditRead } from "./human-edit-read.js";
import { modeAllows, resolveLearning, type LearningSettingsReader } from "./policy.js";
import { humanEditMessageOf, type ReflectQueue } from "./reflect-queue.js";

/** How long the once-per-head row is kept: well past any pull request's life, and expired by the store's own clock. */
export const HUMAN_EDIT_ROW_KEEP_SECONDS = 90 * 86_400;
/** What the producer may spend on the host for one head: requests (the commits it walks, a page each), inside the pass's own allowance for it (core/merge/merge-tracking.ts), which is a little higher. */
export const HUMAN_EDIT_PRODUCER_REQUESTS_MAX = 24;
const HEAD = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

/** The row that says a head was dealt with: in the company's own partition, one for each task and head commit. */
export const humanEditRowKey = (companyId: OrgId, taskId: string, headSha: string): { pk: string; sk: string } => ({ pk: companyScoped(companyId, "LESSON_HUMAN_EDIT"), sk: `TASK#${taskId}#HEAD#${headSha}` });

/** The queue's dedupe id of one human edit: the same task and head is the same message. Within the message's 200 characters (a task id too long for it is hashed). */
export function humanEditRequestId(taskId: string, headSha: string): string {
  const plain = `${taskId}:human_edit:${headSha}`;
  return plain.length <= 200 ? plain : `${createHash("sha256").update(taskId, "utf8").digest("hex")}:human_edit:${headSha}`;
}

export interface HumanEditProducerDeps {
  companyId: OrgId;
  store: DocumentStore;
  settings: LearningSettingsReader;
  /** Whether lessons are on for this company now (read at every ask). */
  enabled: () => boolean;
  /** The task, when it is this company's. */
  ownTask(taskId: string): Promise<TaskRecord | undefined>;
  /** The reflection queue's sender. Throws when the queue does not take the message. */
  queue: () => Promise<ReflectQueue>;
  now: () => number;
  log: (event: string, fields?: Record<string, unknown>) => void;
}

/** What the producer did, for a test and the log line: fixed words. */
export type HumanEditProduced = "off" | "other_company" | "already" | "queued" | "skipped" | "not_queued" | "unread";

export function createHumanEditProducer(deps: HumanEditProducerDeps): (push: HumanEditPush) => Promise<HumanEditProduced> {
  const { companyId, store } = deps;
  const ttl = (): Record<string, number> => (store.ttlAttribute === undefined ? {} : { [store.ttlAttribute]: Math.floor(deps.now() / 1000) + HUMAN_EDIT_ROW_KEEP_SECONDS });
  return async (push) => {
    // The install's switch, then the task: the company's own, on the project the pass named.
    if (!deps.enabled()) return "off";
    if (push.task.orgId !== companyId) return "other_company";
    const task = await deps.ownTask(push.task.taskId);
    if (task === undefined || task.project !== push.task.project) return "other_company";
    // Behind the learning mode, from the project alone: Off and Collect read nothing from the host.
    if (!modeAllows((await resolveLearning(deps.settings, companyId, task.project)).mode, "reflect")) return "off";
    if (!HEAD.test(push.head) || !HEAD.test(push.base) || push.head === push.base) return "unread";
    const key = humanEditRowKey(companyId, task.taskId, push.head);
    if (await store.get(key) !== undefined) return "already";
    // A head that takes more requests than the allowance is too large: the same answer every time, so it is judged (recorded) and never read again.
    const read: HumanEditRead = await readPersonEdit({ host: push.repository.codeHost, repository: { url: push.repository.url }, scope: push.repository.scope, base: push.base, head: push.head, budget: allowanceBudget(push.budget, HUMAN_EDIT_PRODUCER_REQUESTS_MAX) })
      .catch((error: unknown) => { if (error instanceof HumanEditAllowanceError) return { kind: "skip", reason: "diff_too_large" } as const; throw error; });
    if (read.kind === "skip") {
      // Judged: the same head is never read again. Only the fixed reason is kept.
      await store.put({ item: { ...key, entityType: "LESSON_HUMAN_EDIT", state: "skipped", reason: read.reason, taskId: task.taskId, at: deps.now(), ...ttl() }, condition: when.absent() }).catch(() => undefined);
      deps.log("human_edit_skipped", { reason: read.reason });
      return "skipped";
    }
    // The job's repository, as the host itself names it (never from the pull request's words).
    const identity = await push.repository.codeHost.repositoryIdentity({ url: push.repository.url }, push.repository.scope);
    if (identity === undefined) return "unread";
    const job: HumanEditJob = {
      repo: { host: providerOf(push.repository.codeHost), id: identity.id, fullName: identity.fullName, isPrivate: identity.private ?? true, ...(identity.defaultBranch === undefined ? {} : { defaultBranch: identity.defaultBranch }), workspaceId: companyId, project: task.project },
      project: task.project, taskId: task.taskId, pullRequest: { number: push.pullRequest.number, url: push.pullRequest.url },
      candidateHeadSha: push.base, headSha: push.head, headRef: push.headRef,
    };
    const message = humanEditMessageOf(job, humanEditRequestId(task.taskId, push.head));
    // The claim first, so the head is queued once; a message the queue does not take gives the claim back, and the next pass tries again.
    const claimed = await store.put({ item: { ...key, entityType: "LESSON_HUMAN_EDIT", state: "queued", taskId: task.taskId, at: deps.now(), ...ttl() }, condition: when.absent() });
    if (!claimed.applied) return "already";
    try {
      await (await deps.queue()).send(message);
    } catch {
      await store.delete({ key, condition: { op: "eq", path: ["state"], value: "queued" } }).catch(() => undefined);
      deps.log("human_edit_not_queued");
      return "not_queued";
    }
    deps.log("human_edit_queued");
    return "queued";
  };
}
