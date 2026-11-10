// Ported from Cloud's `rovara-code/milestones.ts`: the milestone hook. A milestone ("questions", "plan_ready", "pr_ready", "merged", ...) is one item in the task's partition, written in
// the same transaction as the change that caused it (`items`), together with a line on the task's session. After the commit, `deliver` tells every handler registered with `register` (a chat or tracker adapter, the
// outbound-events sender); a handler that was not told, or threw, is told again by the sweep (`deliverDue`), at most `CODE_MILESTONE_ATTEMPTS_MAX` times. A handler can be told twice (the process can stop between the handler
// returning and the record being written), so it must be safe to hear a milestone again.
//
// On the document store port (decision 51): a handler's claim on a milestone is one conditional update (a lease and an attempt counted together), and the sweep reads the due-time index. The stored form is Cloud's:
// the same `CODE_MILESTONE#<kind>#<n>` rows in the task's partition, the same `dispatchDuePk` / `dispatchDueSk` index attributes under `CODE_MILESTONE`, and the same `tries_<handler>` / `done_<handler>` / `lease_<handler>` attributes.
import {
  CODE_MILESTONES_BEFORE_PR, CodeMilestoneSchema, INDEX_EXPIRY_ATTRIBUTE, WORKFLOW_DISPATCH_DUE_INDEX, change, codeMilestoneKey, queryAll, sessionEventId, when,
  type CodeMilestone, type DocumentStore, type StoredDocument, type TransactItem, type UpdateOp,
} from "@agentx/contracts";
import { sessionEventItem } from "../sessions/store.js";
import type { CodeMilestones } from "../merge/seams.js";

/** How many times one handler is told one milestone before the install gives up on it. */
export const CODE_MILESTONE_ATTEMPTS_MAX = 5;
/** The sweep's partition in the due-time index, apart from the dispatch rows' and the plan evidence rows'. */
export const CODE_MILESTONE_DUE_PK = "CODE_MILESTONE";
/** How long a handler's claim on a milestone holds; a process that dies mid-run holds it no longer. */
export const CODE_MILESTONE_LEASE_MS = 60_000;
/** A failed handler is told again after this long, times the attempts so far. */
export const CODE_MILESTONE_RETRY_MS = 60_000;
/** A milestone is kept this long after it happened (the store's expiry). */
export const CODE_MILESTONE_RETENTION_SECONDS = 30 * 86_400;
const SWEEP_LIMIT = 25;
const KEY_PREFIX = "CODE_MILESTONE#";

/** The index the sweep reads. A store given to `createDocumentMilestones` must keep it (it is the dispatch rows' index; the milestone rows use a partition of their own in it). */
export const CODE_MILESTONE_INDEX = { name: WORKFLOW_DISPATCH_DUE_INDEX.name, partitionAttribute: WORKFLOW_DISPATCH_DUE_INDEX.partitionKey, sortAttribute: WORKFLOW_DISPATCH_DUE_INDEX.sortKey } as const;

export interface CodeMilestoneHandler {
  /** Lowercase letters, digits and underscores: the name is part of the attributes that record what the handler was told. */
  name: string;
  on(milestone: CodeMilestone): Promise<void>;
}

export interface DocumentMilestonesOptions {
  store: Pick<DocumentStore, "get" | "query" | "queryIndex" | "update">;
  now: () => number;
  log?: ((event: string, fields: Record<string, unknown>) => void) | undefined;
}

export interface DocumentMilestones extends CodeMilestones {
  /**
   * Registers a handler for every milestone. Register before the first milestone is written: a milestone written while no handler is registered is marked delivered and a handler registered later never hears it.
   * Handlers are told in the order registered. Returns the function that removes it again (tests use it).
   */
  register(handler: CodeMilestoneHandler): () => void;
  /** The sweep: up to 25 milestones that are due, oldest first, from the due-time index. Each task's milestones are delivered as after a commit. */
  deliverDue(): Promise<{ attempted: number }>;
}

/** Whether a milestone of this kind is written for a task of this definition version: before the pull request only for 1.1.0, so version 1 records stay as they were. */
export function codeMilestoneWrittenFor(kind: CodeMilestone["kind"], definitionVersion: string): boolean {
  return definitionVersion !== "1.0.0" || !CODE_MILESTONES_BEFORE_PR.includes(kind);
}

/** A due time as an index sort key: fixed width, so text order is time order. */
const dueKey = (time: number): string => String(Math.max(0, Math.trunc(time))).padStart(15, "0");

/**
 * The items that record the `n`th milestone of its kind: a Put that only succeeds when absent, and, when the milestone names a session, one line on that session's timeline (the same line again on a repeat). Add them to
 * the transaction of the change that caused the milestone. A milestone before the pull request needs `options.definitionVersion` (it throws without), and one that version does not get gives no items.
 */
export function codeMilestoneItems(milestone: CodeMilestone, n: number, options: { definitionVersion?: string } = {}): TransactItem[] {
  const clean = CodeMilestoneSchema.parse(milestone);
  // Fail closed: a milestone before the pull request is written only for a 1.1.0 task, so a caller that does not say which version the task is does not get to guess.
  if (options.definitionVersion === undefined && CODE_MILESTONES_BEFORE_PR.includes(clean.kind)) throw new Error(`a ${clean.kind} milestone needs the task's definition version`);
  if (options.definitionVersion !== undefined && !codeMilestoneWrittenFor(clean.kind, options.definitionVersion)) return [];
  const key = codeMilestoneKey(clean.taskId, clean.kind, n);
  const at = Date.parse(clean.at);
  const row = JSON.parse(JSON.stringify({
    ...key, entityType: "CODE_MILESTONE", n, ...clean,
    dispatchDuePk: CODE_MILESTONE_DUE_PK, dispatchDueSk: `${dueKey(at)}#${key.pk}#${key.sk}`,
    [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(at / 1000) + CODE_MILESTONE_RETENTION_SECONDS,
  })) as StoredDocument;
  const items: TransactItem[] = [{ kind: "put", item: row, condition: when.absent() }];
  if (clean.sessionId !== undefined) {
    items.push(sessionEventItem({ orgId: clean.orgId, sessionId: clean.sessionId }, {
      eventId: sessionEventId("code_milestone", `${clean.taskId}\n${clean.kind}\n${String(n)}`), at: clean.at, type: "status", actor: { kind: "system" }, text: clean.text,
    }));
  }
  return items;
}

const milestoneOf = (item: StoredDocument): CodeMilestone | undefined => {
  const parsed = CodeMilestoneSchema.safeParse({
    kind: item["kind"], orgId: item["orgId"], taskId: item["taskId"], at: item["at"], text: item["text"],
    ...(item["sessionId"] === undefined ? {} : { sessionId: item["sessionId"] }),
    ...(item["pullRequests"] === undefined ? {} : { pullRequests: item["pullRequests"] }),
    ...(item["bindings"] === undefined ? {} : { bindings: item["bindings"] }),
    ...(item["to"] === undefined ? {} : { to: item["to"] }),
  });
  return parsed.success ? parsed.data : undefined;
};

export function createDocumentMilestones(options: DocumentMilestonesOptions): DocumentMilestones {
  const { store, now } = options;
  const handlers: CodeMilestoneHandler[] = [];
  const log = (event: string, fields: Record<string, unknown>): void => (options.log ?? (() => undefined))(event, fields);
  const update = async (item: StoredDocument, input: { ops: readonly UpdateOp[]; condition: ReturnType<typeof when.and> }): Promise<boolean> =>
    (await store.update({ key: { pk: item.pk, sk: item.sk }, ops: input.ops, condition: input.condition })).applied;

  /**
   * Tells the registered handlers each milestone of the task they have not yet heard. A handler takes a claim on the milestone first (a lease and an attempt counted in one conditional write), so two deliveries that meet
   * tell it once; a handler that threw is told again by the next delivery, until it has had `CODE_MILESTONE_ATTEMPTS_MAX` attempts. A milestone every handler has heard or been given up on leaves the sweep's index. Never
   * throws for a handler's failure.
   */
  async function deliver(taskId: string): Promise<void> {
    const registered = [...handlers];
    const rows = await queryAll(store, { pk: `DEVTASK#${taskId}`, sk: { op: "beginsWith", prefix: KEY_PREFIX } });
    for (const item of rows) {
      if (item["deliveredAt"] !== undefined) continue;
      const milestone = item["taskId"] === taskId ? milestoneOf(item) : undefined;
      const settle = (): Promise<boolean> => update(item, { ops: [change.set("deliveredAt", new Date(now()).toISOString()), change.remove("dispatchDuePk"), change.remove("dispatchDueSk")], condition: when.and(when.present(), when.notExists("deliveredAt")) });
      if (milestone === undefined) {
        log("code_milestone.unreadable", { taskId });
        await settle();
        continue;
      }
      let settled = true;
      let attempts = 0;
      for (const handler of registered) {
        const [tries, done, lease] = [`tries_${handler.name}`, `done_${handler.name}`, `lease_${handler.name}`];
        let used = typeof item[tries] === "number" ? item[tries] : 0;
        if (item[done] !== true && used < CODE_MILESTONE_ATTEMPTS_MAX) {
          const at = now();
          const claimed = await update(item, {
            ops: [change.set(lease, at + CODE_MILESTONE_LEASE_MS), change.add(tries, 1)],
            condition: when.and(when.present(), when.notExists(done), when.or(when.notExists(lease), when.lt(lease, at)), when.or(when.notExists(tries), when.lt(tries, CODE_MILESTONE_ATTEMPTS_MAX))),
          });
          if (!claimed) {
            settled = false;
            continue;
          }
          used += 1;
          try {
            await handler.on(milestone);
            await update(item, { ops: [change.set(done, true), change.remove(lease)], condition: when.present() });
            continue;
          } catch (error) {
            log("code_milestone.handler_failed", { taskId, kind: milestone.kind, handler: handler.name, attempt: used, error: error instanceof Error ? error.name : "unknown" });
            await update(item, { ops: [change.remove(lease)], condition: when.present() });
          }
        }
        if (item[done] !== true && used < CODE_MILESTONE_ATTEMPTS_MAX) {
          settled = false;
          attempts = Math.max(attempts, used);
        }
      }
      if (settled) await settle();
      else {
        await update(item, { ops: [change.set("dispatchDueSk", `${dueKey(now() + CODE_MILESTONE_RETRY_MS * Math.max(1, attempts))}#${item.pk}#${item.sk}`)], condition: when.and(when.present(), when.notExists("deliveredAt")) });
      }
    }
  }

  return {
    items: (milestone, n, itemOptions) => codeMilestoneItems(milestone, n, itemOptions),
    deliver,
    register(handler) {
      if (!/^[a-z][a-z0-9_]{0,30}$/u.test(handler.name)) throw new Error("a milestone handler's name is lowercase letters, digits and underscores");
      if (handlers.some((existing) => existing.name === handler.name)) throw new Error("a milestone handler with this name is already registered");
      handlers.push(handler);
      return () => {
        const at = handlers.indexOf(handler);
        if (at >= 0) handlers.splice(at, 1);
      };
    },
    async deliverDue() {
      // ":" sorts after the "#" that follows each due time, so `${due(now)}:` includes every row due at or before now.
      const page = await store.queryIndex({ index: CODE_MILESTONE_INDEX.name, partition: CODE_MILESTONE_DUE_PK, sort: { op: "lte", value: `${dueKey(now())}:` }, limit: SWEEP_LIMIT });
      const tasks = new Set(page.items.map((row) => row["taskId"]).filter((id): id is string => typeof id === "string"));
      for (const taskId of tasks) {
        try {
          await deliver(taskId);
        } catch (error) {
          log("code_milestone.sweep_failed", { taskId, error: error instanceof Error ? error.name : "unknown" });
        }
      }
      return { attempted: page.items.length };
    },
  };
}
