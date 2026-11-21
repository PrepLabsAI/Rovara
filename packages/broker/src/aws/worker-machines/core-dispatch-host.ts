// Engine host (migration plan v3.2 lane E2, step 4): the dispatcher Lambda as the host of the core's `runDispatchOnce`. Ported from the monolith's host.
//
// The dispatcher is fed by SQS through a Lambda event source mapping, so it never polls: the batch arrives in the event. The core's dispatch consumer receives from a `Queue`. This module joins
// the two: the batch's core dispatch messages (`{ v: 1, companyId, workspaceId, operationId }`, what the core's outbox stages: core/task-flow/accept.ts) are served to `runDispatchOnce` as a
// queue that holds exactly those records, once each, and what the core does with each one becomes the Lambda's answer for it:
//   - ack:               the record is done (Lambda deletes it);
//   - changeVisibility:  the record is hidden for that long (SQS ChangeMessageVisibility) and reported as a batch item failure, so it comes back then;
//   - deadLetter:        handed to the dead-letter function when there is one; otherwise reported as a failure and left to the queue's redrive policy;
//   - nothing at all:    reported as a failure (a fault the core did not model): a record is never dropped unless the core acknowledged it.
//
// Whose a record is: the message names its company, and the workspace's own record must name the same one (read strongly, never cached); otherwise the record is nobody's and comes back
// (the redrive policy sets it aside). Each company's records run through that company's own flow dependencies, whose machines adapter must be bound to the same company.
//
// The claim and the signature stay in the dispatcher's role: the core claims the operation (fenced) before it builds anything, and the machines adapter signs with the KMS key only this role may use.
// It is off unless the switch says otherwise, and an off host takes no record.
import { randomUUID } from "node:crypto";
import { OrgIdSchema, type OrgId, type Queue, type QueueCapabilities, type QueueService, type ReceivedMessage } from "@agentx/contracts";
import { runDispatchOnce, type DispatchReport } from "../../core/task-flow/dispatch.js";
import type { TaskFlowDeps } from "../../core/task-flow/deps.js";

/** A record of the dispatcher's SQS batch, as far as the host reads it. */
export interface CoreDispatchRecord {
  messageId: string;
  receiptHandle?: string;
  body: string;
  attributes?: { ApproximateReceiveCount?: string; SentTimestamp?: string };
}

/** The core's dispatch message (`core/task-flow/accept.ts` `DispatchMessage`), parsed strictly: anything else is not the core's. */
export interface CoreDispatchMessage {
  v: 1;
  companyId: OrgId;
  workspaceId: string;
  operationId: string;
  /** A queued cancel of the operation (core/task-flow/money-stop.ts): the cancel's own id. Absent: an ordinary dispatch. */
  cancel?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A dispatch message is four short fields; a body longer than this is not one (it is never parsed). */
const MESSAGE_MAX_CHARS = 1_024;

export function coreDispatchMessage(body: string): CoreDispatchMessage | undefined {
  if (typeof body !== "string" || body.length > MESSAGE_MAX_CHARS) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const fields = value as Record<string, unknown>;
  // The four fields of a dispatch, and a queued cancel's own id as a fifth (money-stop.ts); nothing else.
  const keys = Object.keys(fields).sort().join(",");
  if (keys !== "companyId,operationId,v,workspaceId" && keys !== "cancel,companyId,operationId,v,workspaceId") return undefined;
  if (fields.v !== 1 || typeof fields.workspaceId !== "string" || typeof fields.operationId !== "string") return undefined;
  if (Object.hasOwn(fields, "cancel") && (typeof fields.cancel !== "string" || !UUID.test(fields.cancel))) return undefined;
  const company = OrgIdSchema.safeParse(fields.companyId);
  if (!company.success || !UUID.test(fields.workspaceId) || !UUID.test(fields.operationId)) return undefined;
  return { v: 1, companyId: company.data, workspaceId: fields.workspaceId, operationId: fields.operationId, ...(typeof fields.cancel === "string" ? { cancel: fields.cancel } : {}) };
}

export interface CoreDispatchHostDependencies {
  /** The company a workspace belongs to, from its record (strongly consistent); undefined when there is none. */
  companyOfWorkspace: (workspaceId: string) => Promise<OrgId | undefined>;
  /** The core's dependencies for one company, with `queues` serving this batch's dispatch queue. Its `machines` must be that company's adapter. */
  depsFor: (companyId: OrgId, queues: QueueService) => TaskFlowDeps | Promise<TaskFlowDeps>;
  /** The core's dispatch queue name (`TaskFlowDeps.dispatchQueue`). Default `task-dispatch`. */
  dispatchQueue?: string;
  /** SQS ChangeMessageVisibility on the record's receipt handle. */
  changeVisibility: (receiptHandle: string, seconds: number) => Promise<void>;
  /** Moves a record to the dead letters now. Absent: the record is reported as failed and the queue's redrive policy moves it after its last receive. */
  deadLetter?: (record: CoreDispatchRecord, reason: string) => Promise<void>;
  log?: (entry: Record<string, unknown>) => void;
}

export interface CoreDispatchResult {
  /** The records the host took (the core's). Every other record of the batch is today's path's. */
  taken: ReadonlySet<string>;
  /** The taken records Lambda must not delete (`batchItemFailures`). */
  failures: string[];
  reports: DispatchReport[];
}

type Settlement = "ack" | "retry" | "dead";

const CAPABILITIES: QueueCapabilities = { ordered: false, dedupe: false, maxDelaySeconds: 900, detectsStaleHandle: true, deadLettersById: false };

/** A `Queue` that holds one Lambda batch's records of one company: each is received once, and settled at most once. */
export class LambdaBatchQueue implements Queue {
  readonly capabilities = CAPABILITIES;
  readonly #records: CoreDispatchRecord[];
  readonly #handles = new Map<string, CoreDispatchRecord>();
  readonly #settled = new Map<string, Settlement>();
  #next = 0;

  constructor(readonly name: string, records: readonly CoreDispatchRecord[], private readonly dependencies: Pick<CoreDispatchHostDependencies, "changeVisibility" | "deadLetter">) {
    this.#records = [...records];
  }

  /** Records not yet received by the core. */
  get unreceived(): number {
    return this.#records.length - this.#next;
  }

  /** The records Lambda must not delete: every one not acknowledged (or moved to the dead letters by the dead-letter function). */
  failures(): string[] {
    return this.#records.filter((record) => {
      const settled = this.#settled.get(record.messageId);
      return settled !== "ack" && !(settled === "dead" && this.dependencies.deadLetter !== undefined);
    }).map((record) => record.messageId);
  }

  async enqueue(): Promise<never> {
    throw new Error("a dispatcher batch takes no new messages");
  }

  async receive(options: { maxMessages?: number } = {}): Promise<ReceivedMessage[]> {
    const count = Math.max(1, Math.min(options.maxMessages ?? 1, 10));
    const taken = this.#records.slice(this.#next, this.#next + count);
    this.#next += taken.length;
    return taken.map((record) => {
      const receiptHandle = randomUUID();
      this.#handles.set(receiptHandle, record);
      const sent = Number(record.attributes?.SentTimestamp);
      const receiveCount = Number.parseInt(record.attributes?.ApproximateReceiveCount ?? "1", 10);
      return {
        messageId: record.messageId,
        receiptHandle,
        // The host parsed it before it took the record, so it is the core's message.
        body: JSON.parse(record.body) as ReceivedMessage["body"],
        attributes: {},
        receiveCount: Number.isSafeInteger(receiveCount) && receiveCount >= 1 ? receiveCount : 1,
        enqueuedAt: new Date(Number.isFinite(sent) && sent > 0 ? sent : 0).toISOString(),
      };
    });
  }

  async ack(receiptHandle: string): Promise<boolean> {
    return this.#settle(receiptHandle, "ack") !== undefined;
  }

  async changeVisibility(receiptHandle: string, seconds: number): Promise<boolean> {
    const record = this.#settle(receiptHandle, "retry");
    if (record === undefined) return false;
    // Without a receipt handle (a test event) the record still comes back after the queue's own visibility timeout.
    if (record.receiptHandle !== undefined) await this.dependencies.changeVisibility(record.receiptHandle, Math.max(0, Math.min(Math.floor(seconds), 43_200)));
    return true;
  }

  async deadLetter(receiptHandle: string, reason: string): Promise<boolean> {
    // Settled as a retry until the dead-letter function has the record: if it throws, the record is a batch item failure and comes back (never deleted and lost).
    const record = this.#settle(receiptHandle, "retry");
    if (record === undefined) return false;
    if (this.dependencies.deadLetter !== undefined) await this.dependencies.deadLetter(record, reason);
    this.#settled.set(record.messageId, "dead");
    return true;
  }

  async listDeadLetters(): Promise<{ items: [] }> {
    return { items: [] };
  }

  async redrive(): Promise<boolean> {
    return false;
  }

  async discardDeadLetter(): Promise<boolean> {
    return false;
  }

  /** Settles a delivery once: a second settlement of the same handle (or of a record already settled) is stale. */
  #settle(receiptHandle: string, how: Settlement): CoreDispatchRecord | undefined {
    const record = this.#handles.get(receiptHandle);
    if (record === undefined || this.#settled.has(record.messageId)) return undefined;
    this.#settled.set(record.messageId, how);
    this.#handles.delete(receiptHandle);
    return record;
  }
}

/** A `QueueService` that answers the dispatch queue's name with the batch and refuses every other queue (the dispatch consumer asks for no other). */
function batchQueues(name: string, batch: LambdaBatchQueue): QueueService {
  return {
    async queue(asked: string) {
      if (asked !== name) throw new Error(`the dispatcher batch serves the queue ${name} only`);
      return batch;
    },
  };
}

export function createCoreDispatchHost(dependencies: CoreDispatchHostDependencies) {
  const queueName = dependencies.dispatchQueue ?? "task-dispatch";
  const log = dependencies.log ?? ((entry: Record<string, unknown>) => { process.stderr.write(`${JSON.stringify({ component: "dispatcher", ...entry })}\n`); });
  return {
    /** The records of a batch that are the core's. Today's path must skip exactly these. */
    take(records: readonly CoreDispatchRecord[]): Set<string> {
      return new Set(records.filter((record) => coreDispatchMessage(record.body) !== undefined).map((record) => record.messageId));
    },

    /** Runs the core's dispatch over the taken records, one company at a time, each company's records through its own adapter. */
    async handle(records: readonly CoreDispatchRecord[], taken: ReadonlySet<string>): Promise<CoreDispatchResult> {
      const failures: string[] = [];
      const reports: DispatchReport[] = [];
      const byCompany = new Map<OrgId, CoreDispatchRecord[]>();
      for (const record of records) {
        if (!taken.has(record.messageId)) continue;
        const message = coreDispatchMessage(record.body)!;
        let company: OrgId | undefined;
        try {
          company = await dependencies.companyOfWorkspace(message.workspaceId);
        } catch {
          company = undefined;
        }
        if (company === undefined || company !== message.companyId) {
          // No workspace to say whose it is, or one of another company than the message names: never guessed. It comes back, and the redrive policy sets it aside after its last receive.
          log({ event: "dispatch.core_company_unknown", messageId: record.messageId });
          failures.push(record.messageId);
          continue;
        }
        byCompany.set(company, [...(byCompany.get(company) ?? []), record]);
      }
      for (const [companyId, group] of byCompany) {
        const batch = new LambdaBatchQueue(queueName, group, dependencies);
        try {
          const deps = await dependencies.depsFor(companyId, batchQueues(queueName, batch));
          // A wiring fault, not the operation's: nothing is run and every record of the group comes back.
          if (deps.companyId !== companyId) throw new Error("the core's dependencies are for another company");
          if ((deps.machines as { companyId?: unknown }).companyId !== companyId) throw new Error("the core's machines adapter is for another company");
          while (batch.unreceived > 0) reports.push(await runDispatchOnce({ ...deps, dispatchQueue: queueName }, { maxMessages: 10 }));
        } catch (error) {
          log({ event: "dispatch.core_fault", error: error instanceof Error ? error.name : "unknown" });
        }
        failures.push(...batch.failures());
      }
      return { taken, failures, reports };
    },
  };
}

export type CoreDispatchHost = ReturnType<typeof createCoreDispatchHost>;
