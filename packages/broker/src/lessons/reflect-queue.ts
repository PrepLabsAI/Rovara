// The queue a finished task's reflection waits in. The message holds ids and one fixed word only (never a person's words, a task title or any text): the org, the task, how
// the task ended and the request that asked. A worker (`reflect-worker.ts`) reads everything else fresh, so what it reflects on is what is true when it runs (an erased person, a deleted place and a changed
// project setting are all seen).
import { LESSONS_REFLECT_MAX_RECEIVES, LESSONS_REFLECT_QUEUE, LESSONS_REFLECT_VISIBILITY_SECONDS, OrgIdSchema, type JsonValue, type Queue, type QueueService } from "@agentx/contracts";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { HumanEditJob } from "./capture-types.js";

/** `sent_back`: a person sent the still-open task back with their words (learn on send-back): reflected now, so the correction can help the next task before this one ends. */
export const REFLECT_OUTCOMES = ["merged", "closed", "abandoned", "reverted", "sent_back"] as const;
export type ReflectOutcome = (typeof REFLECT_OUTCOMES)[number];

/** The most send-backs of ONE task that are reflected on while it is open (each is one paid learning call, inside the company's monthly learning cap); later ones are learned at the task's end. */
export const SEND_BACK_REFLECTIONS_MAX = 3;

const IdSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:#-]+$/u);
/**
 * One reflection: ids and one fixed word. A `sent_back` message also carries `round`, which human send-back of the task it is (1, 2, ...): its lease is per round (`reflectLeaseOutcome`), so a redelivery of the same
 * round is paid once and the next round is its own reflection. Every other outcome has no round.
 */
export const ReflectMessageSchema = z.object({ orgId: OrgIdSchema, taskId: IdSchema, outcome: z.enum(REFLECT_OUTCOMES), requestId: IdSchema, round: z.number().int().min(1).max(SEND_BACK_REFLECTIONS_MAX).optional() }).strict()
  .refine((message) => (message.outcome === "sent_back") === (message.round !== undefined));
export type ReflectMessage = z.infer<typeof ReflectMessageSchema>;

/** The word the reflection's lease is taken on: the outcome, and for a send-back its round (`sent_back-2`). */
export const reflectLeaseOutcome = (message: Pick<ReflectMessage, "outcome" | "round">): string => (message.outcome === "sent_back" ? `sent_back-${String(message.round)}` : message.outcome);
/**
 * The queue's dedupe id of a send-back's reflection: the same task and round is the same message (a second notice of the same send-back is stored once). Within the message's 200-character id: a task id too long for it
 * is replaced by its SHA-256 (the same task still gives the same id).
 */
export function sendBackRequestId(taskId: string, round: number): string {
  const plain = `${taskId}:sent_back:${String(round)}`;
  return plain.length <= 200 ? plain : `${createHash("sha256").update(taskId, "utf8").digest("hex")}:sent_back:${String(round)}`;
}

/**
 * Lessons capture: a human fix-up commit on a merged Rovara pull request, to be read from the code host and learned from (the code host capture). A sibling message type on the same queue (the same
 * worker, dead-letter queue and alarms). It holds coordinates only: the company, the task, the repository's address, the pull request's number and link, and the two commits to compare. Never a diff, a file name, a
 * commit message, a person's name or any words: the worker reads the compare live and proves the authors itself. `kind` is what tells it from a reflection (which has none).
 */
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const PlainSchema = (max: number) => z.string().min(1).max(max).regex(/^[^\s\p{Cc}\p{Cf}]+$/u);
export const HumanEditMessageSchema = z.object({
  kind: z.literal("human_edit"),
  orgId: OrgIdSchema,
  taskId: IdSchema,
  requestId: IdSchema,
  repo: z.object({ host: IdSchema, id: PlainSchema(100), fullName: PlainSchema(200), isPrivate: z.boolean(), defaultBranch: PlainSchema(255).optional() }).strict(),
  project: PlainSchema(200),
  pullRequest: z.object({ number: z.number().int().positive(), url: PlainSchema(500).regex(/^https:\/\//u) }).strict(),
  candidateHeadSha: z.string().regex(SHA),
  headSha: z.string().regex(SHA),
  headRef: PlainSchema(255).optional(),
}).strict();
export type HumanEditMessage = z.infer<typeof HumanEditMessageSchema>;

/** The queue message of a human edit, from the tap's job. The workspace of the job is the company (a job whose workspace is not a company id is refused). */
export function humanEditMessageOf(job: HumanEditJob, requestId: string): HumanEditMessage {
  const { repo } = job;
  return HumanEditMessageSchema.parse({
    kind: "human_edit", orgId: repo.workspaceId, taskId: job.taskId, requestId,
    repo: { host: repo.host, id: repo.id, fullName: repo.fullName, isPrivate: repo.isPrivate, ...(repo.defaultBranch === undefined ? {} : { defaultBranch: repo.defaultBranch }) },
    project: job.project, pullRequest: { number: job.pullRequest.number, url: job.pullRequest.url }, candidateHeadSha: job.candidateHeadSha, headSha: job.headSha, ...(job.headRef === undefined ? {} : { headRef: job.headRef }),
  });
}

/** The job the tap's `runHumanEdit` takes, from a message. The repository's workspace and project are the message's (the company and the project the tap read from its own indexes). */
export function humanEditJobOf(message: HumanEditMessage): HumanEditJob {
  return {
    repo: { host: message.repo.host, id: message.repo.id, fullName: message.repo.fullName, isPrivate: message.repo.isPrivate, workspaceId: message.orgId, project: message.project, ...(message.repo.defaultBranch === undefined ? {} : { defaultBranch: message.repo.defaultBranch }) },
    project: message.project, taskId: message.taskId, pullRequest: message.pullRequest, candidateHeadSha: message.candidateHeadSha, headSha: message.headSha, ...(message.headRef === undefined ? {} : { headRef: message.headRef }),
  };
}

/** What the queue carries: a finished task's reflection, or a human edit. */
export type ReflectQueueMessage = ReflectMessage | HumanEditMessage;

/** The lease a human edit takes: one per task and head commit (the same identity as the tap's once-claim), in the reflections' own lease table. */
export const humanEditLeaseOutcome = (message: Pick<HumanEditMessage, "headSha">): string => `human_edit-${message.headSha}`;

/** Where a reflection (or a human edit) is sent. Throws when the queue did not take it (the caller turns that into one fixed log line). */
export interface ReflectQueue { send(message: ReflectQueueMessage): Promise<void> }

/** How long a task end (or the nightly job) waits for the queue. The caller's own deadline is the last guard, for a queue that does not answer. */
export const REFLECT_SEND_TIMEOUT_MS = 2000;

/** Declares the reflection queue where the install keeps its queues: the same options everywhere it is asked for, so a worker and a sender agree. */
export function reflectQueueOf(queues: QueueService): Promise<Queue> {
  return queues.queue(LESSONS_REFLECT_QUEUE, { visibilityTimeoutSeconds: LESSONS_REFLECT_VISIBILITY_SECONDS, maxReceiveCount: LESSONS_REFLECT_MAX_RECEIVES });
}

/** The sender over the `queue` point. A message of ids only; the same message sent twice inside the dedupe window is stored once. */
export function queueReflectQueue(queue: Queue, options: { timeoutMs?: number } = {}): ReflectQueue {
  const timeoutMs = options.timeoutMs ?? REFLECT_SEND_TIMEOUT_MS;
  return {
    async send(message) {
      const body = ("kind" in message ? HumanEditMessageSchema.parse(message) : ReflectMessageSchema.parse(message)) as unknown as JsonValue;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          queue.enqueue({ body, dedupeId: message.requestId }),
          new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("the reflection queue did not answer in time")), timeoutMs); }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}

/** The worker's side of a retry: the message comes back after `seconds`, not after the queue's whole visibility timeout. Best effort (the caller ignores a failure). */
export interface ReflectVisibility { delay(receiptHandle: string, seconds: number): Promise<void> }
export function queueReflectVisibility(queue: Queue): ReflectVisibility {
  return { async delay(receiptHandle, seconds) { await queue.changeVisibility(receiptHandle, seconds); } };
}

/** The human edit in a queue record's body, or undefined when it is not exactly one (never throws). */
export function parseHumanEditMessage(body: string): HumanEditMessage | undefined {
  try {
    const parsed = HumanEditMessageSchema.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** The message in a queue record's body, or undefined when it is not exactly one (never throws). */
export function parseReflectMessage(body: string): ReflectMessage | undefined {
  try {
    const parsed = ReflectMessageSchema.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
