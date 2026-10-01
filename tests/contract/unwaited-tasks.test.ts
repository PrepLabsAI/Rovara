// Issue 173 (owner decisions 2026-10-01): the reconciler backstop. A Slack thread's coding task
// idle for 24 hours (no new worker event) with nobody waiting on it is cancelled inside the
// reconciler, through the shared cancel code the cancel route uses, and the thread gets one note.
// A waiter is a thread activeTurn naming the task whose seenAt is under 15 minutes old; one with no
// seenAt (written by an older Slack service) counts as a waiter until the task is idle 48 hours.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  UNSTAMPED_WAITER_GRACE_MS, UNWAITED_TASK_IDLE_LIMIT_MS, UNWAITED_TASK_NOTE, WAITER_SEEN_WITHIN_MS,
  lastActivityAt, slackBotTokenFrom, sweepUnwaitedTasks,
} from "../../packages/broker/src/aws/unwaited-tasks.js";
import {
  SLACK_CHANNEL, SLACK_TEAM, createBroker, ensureWorkspace, loadSlackBroker, markReady, registerSlackProject, serviceCall,
} from "../support/slack-broker.js";

const threadTs = "1695500000.000001";
const subject = `${SLACK_TEAM}/${SLACK_CHANNEL}/${threadTs}`;
const THREAD = { channelId: SLACK_CHANNEL, threadTs };
const pratik = "U0123456789";
const HOUR = 3_600_000;

beforeAll(async () => {
  await loadSlackBroker();
});

/** A bound thread whose workspace runs one coding task, last active `idle` milliseconds before `now`. */
async function runningTask(options: { idle?: number } = {}) {
  const broker = createBroker({ slackThreadsTableName: "threads" });
  await registerSlackProject(broker.handler);
  const workspaceId = (await ensureWorkspace(broker.handler, subject, pratik)).body.workspaceId as string;
  markReady(broker.db, workspaceId);
  const conversation = await serviceCall(broker.handler, subject, pratik, "POST", `/v1/service/workspaces/${workspaceId}/conversations`);
  const task = await serviceCall(broker.handler, subject, pratik, "POST", `/v1/service/workspaces/${workspaceId}/tasks`, {
    requestId: randomUUID(), conversationId: (conversation.body.conversation as { id: string }).id, prompt: "run the tests",
  });
  expect(task.status).toBe(202);
  const operationId = (task.body.operation as { id: string }).id;
  const now = new Date(Date.now() + 1_000);
  const at = (msBeforeNow: number) => new Date(now.getTime() - msBeforeNow).toISOString();
  const current = () => broker.db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${operationId}`)!;
  current().status = "RUNNING";
  current().createdAt = at((options.idle ?? UNWAITED_TASK_IDLE_LIMIT_MS + 60_000) + HOUR);
  current().updatedAt = at(options.idle ?? UNWAITED_TASK_IDLE_LIMIT_MS + 60_000);
  /** Records a worker event `msBeforeNow` before now, as the broker's event callback stores it. */
  const event = (msBeforeNow: number) => {
    const sequence = Number(current().eventSequence ?? 0) + 1;
    current().eventSequence = sequence;
    broker.db.set({ pk: `OPERATION#${operationId}`, sk: `EVENT#${String(sequence).padStart(12, "0")}`, entityType: "EVENT", workspaceId, operationId, sequence, type: "tool_start", timestamp: at(msBeforeNow) });
  };
  const activeTurn = (turn: Record<string, unknown>) => broker.db.set({ pk: `THREAD#${subject}`, sk: "META", workspaceId, activeTurn: turn });
  const logs: Array<Record<string, unknown>> = [];
  const postNote = vi.fn<(thread: { channelId: string; threadTs: string }, text: string) => Promise<void>>(async () => undefined);
  const sweep = (when = now) => sweepUnwaitedTasks({
    client: broker.db, tableName: "state", threadsTableName: "threads", callbackSigningKey: "c".repeat(64),
    postNote, log: (entry) => { logs.push(entry); },
  }, [workspaceId], when);
  const cancels = () => broker.db.find((item) => item.entityType === "OPERATION" && item.workspaceId === workspaceId && item.kind === "cancel");
  return { ...broker, workspaceId, operationId, now, at, current, event, activeTurn, logs, postNote, sweep, cancels };
}

describe("the backstop's limits (#173)", () => {
  it("are 24 hours idle, a 15-minute waiter window and a 48-hour grace for unstamped waiters, and the note says so plainly", () => {
    expect(UNWAITED_TASK_IDLE_LIMIT_MS).toBe(24 * HOUR);
    expect(WAITER_SEEN_WITHIN_MS).toBe(15 * 60_000);
    expect(UNSTAMPED_WAITER_GRACE_MS).toBe(48 * HOUR);
    expect(UNWAITED_TASK_NOTE).toContain("idle for over 24 hours with nobody waiting on it");
    expect(UNWAITED_TASK_NOTE).not.toMatch(/—|–/);
  });

  it("measures activity from the latest worker event, else the operation's updatedAt, never later than now", () => {
    const now = new Date("2026-10-01T12:00:00.000Z");
    expect(lastActivityAt({ createdAt: "2026-09-29T00:00:00.000Z", updatedAt: "2026-09-30T00:00:00.000Z" }, undefined, now)).toBe(Date.parse("2026-09-30T00:00:00.000Z"));
    expect(lastActivityAt({ createdAt: "2026-09-29T00:00:00.000Z", updatedAt: "2026-09-30T00:00:00.000Z" }, { timestamp: "2026-10-01T06:00:00.000Z" }, now)).toBe(Date.parse("2026-10-01T06:00:00.000Z"));
    expect(lastActivityAt({ createdAt: "2026-09-29T00:00:00.000Z", updatedAt: "2026-09-30T00:00:00.000Z" }, { timestamp: "2027-01-01T00:00:00.000Z" }, now)).toBe(now.getTime());
    expect(lastActivityAt({ createdAt: "2026-09-29T00:00:00.000Z" }, { timestamp: "not a time" }, now)).toBe(Date.parse("2026-09-29T00:00:00.000Z"));
  });
});

describe("the backstop: when it cancels (#173)", () => {
  it("cancels a task idle past the limit with nobody waiting, through the shared cancel path, and posts the note once", async () => {
    const { db, sweep, current, cancels, postNote, logs, workspaceId, operationId } = await runningTask();
    const result = await sweep();
    expect(result.cancelled).toEqual([operationId]);
    expect(current().status).toBe("CANCEL_REQUESTED");
    expect(cancels()).toHaveLength(1);
    const cancel = cancels()[0]!;
    expect(cancel).toMatchObject({ kind: "cancel", status: "ACCEPTED", targetOperationId: operationId });
    expect(cancel).not.toHaveProperty("requestedBy");
    const outbox = db.find((item) => item.entityType === "OUTBOX" && item.operationId === cancel.id)[0];
    expect(outbox?.invocation).toMatchObject({ kind: "cancel", payload: { targetOperationId: operationId } });
    expect(postNote).toHaveBeenCalledExactlyOnceWith(THREAD, UNWAITED_TASK_NOTE);
    expect(logs).toContainEqual(expect.objectContaining({ event: "unwaited_task.cancelled", workspaceId, operationId }));
    await sweep();
    expect(postNote).toHaveBeenCalledOnce();
    expect(cancels()).toHaveLength(1);
  });

  it("never stops a task idle under the limit, and stops it once it passes", async () => {
    const { sweep, now, current } = await runningTask({ idle: UNWAITED_TASK_IDLE_LIMIT_MS - 60_000 });
    await sweep();
    expect(current().status).toBe("RUNNING");
    await sweep(new Date(now.getTime() + 2 * 60_000));
    expect(current().status).toBe("CANCEL_REQUESTED");
  });

  it("never stops a task still producing events, however long it has run", async () => {
    const { sweep, event, current } = await runningTask({ idle: 5 * UNWAITED_TASK_IDLE_LIMIT_MS });
    event(10 * 60_000);
    await sweep();
    expect(current().status).toBe("RUNNING");
  });

  it("cancels when the thread's activeTurn is stale (seenAt over 15 minutes old) or names another operation", async () => {
    const stale = await runningTask();
    stale.activeTurn({ eventId: "Ev1", workspaceId: stale.workspaceId, operationId: stale.operationId, seenAt: stale.at(WAITER_SEEN_WITHIN_MS + 60_000) });
    await stale.sweep();
    expect(stale.current().status).toBe("CANCEL_REQUESTED");

    const other = await runningTask();
    other.activeTurn({ eventId: "Ev1", workspaceId: other.workspaceId, operationId: randomUUID(), seenAt: other.at(60_000) });
    await other.sweep();
    expect(other.current().status).toBe("CANCEL_REQUESTED");
  });
});

describe("the backstop: what it never touches (#173)", () => {
  it("never cancels a task a live turn waits on (activeTurn names it, seen within 15 minutes)", async () => {
    const { sweep, activeTurn, workspaceId, operationId, at, current, cancels, postNote } = await runningTask();
    activeTurn({ eventId: "Ev1", workspaceId, operationId, seenAt: at(WAITER_SEEN_WITHIN_MS - 60_000) });
    expect((await sweep()).cancelled).toEqual([]);
    expect(current().status).toBe("RUNNING");
    expect(cancels()).toHaveLength(0);
    expect(postNote).not.toHaveBeenCalled();
  });

  it("counts an activeTurn with no seenAt (an older Slack service) as a waiter until the task is idle 48 hours", async () => {
    const young = await runningTask({ idle: UNSTAMPED_WAITER_GRACE_MS - 60_000 });
    young.activeTurn({ eventId: "Ev1", workspaceId: young.workspaceId, operationId: young.operationId });
    await young.sweep();
    expect(young.current().status).toBe("RUNNING");

    const old = await runningTask({ idle: UNSTAMPED_WAITER_GRACE_MS + 60_000 });
    old.activeTurn({ eventId: "Ev1", workspaceId: old.workspaceId, operationId: old.operationId });
    await old.sweep();
    expect(old.current().status).toBe("CANCEL_REQUESTED");
  });

  it("counts an unreadable activeTurn or seenAt as a waiter, in case it names the task", async () => {
    const unreadable = await runningTask();
    unreadable.activeTurn({ eventId: "Ev1" });
    await unreadable.sweep();
    expect(unreadable.current().status).toBe("RUNNING");

    const badStamp = await runningTask();
    badStamp.activeTurn({ eventId: "Ev1", workspaceId: badStamp.workspaceId, operationId: badStamp.operationId, seenAt: "yesterday" });
    await badStamp.sweep();
    expect(badStamp.current().status).toBe("RUNNING");
  });

  it("never cancels a task started from an AI tool (an MCP developer task)", async () => {
    const pointed = await runningTask();
    pointed.db.set({ pk: `WORKSPACE#${pointed.workspaceId}`, sk: "DEVELOPER_TASK", entityType: "DEVELOPER_TASK_POINTER", taskId: randomUUID() });
    await pointed.sweep();
    expect(pointed.current().status).toBe("RUNNING");

    const requested = await runningTask();
    requested.current().requestedBy = { kind: "developer", developerId: "a".repeat(64), provider: "slack" };
    await requested.sweep();
    expect(requested.current().status).toBe("RUNNING");
  });

  it("never touches CANCEL_REQUESTED or finished tasks, other kinds, or an operation that no longer owns its workspace", async () => {
    for (const status of ["CANCEL_REQUESTED", "SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"]) {
      const task = await runningTask();
      task.current().status = status;
      await task.sweep();
      expect(task.current().status).toBe(status);
      expect(task.cancels()).toHaveLength(0);
    }
    for (const kind of ["prepare", "publish", "maintain", "close"]) {
      const task = await runningTask();
      task.current().kind = kind;
      await task.sweep();
      expect(task.current().status).toBe("RUNNING");
    }
    const released = await runningTask();
    released.db.get(`WORKSPACE#${released.workspaceId}`, "META")!.activeOperationId = randomUUID();
    await released.sweep();
    expect(released.current().status).toBe("RUNNING");
  });

  it("never touches a workspace no Slack thread owns", async () => {
    const { db, sweep, current } = await runningTask();
    delete db.find((item) => item.entityType === "SLACK_THREAD")[0]!.thread;
    await sweep();
    expect(current().status).toBe("RUNNING");
  });
});

describe("the backstop: races and failures (#173)", () => {
  /** Runs `during` just before the cancel's transaction is written. */
  const beforeCancelWrite = (db: ReturnType<typeof createBroker>["db"], during: () => Promise<void> | void) => {
    const original = db.send;
    let raced = false;
    db.send = async (command) => {
      if (!raced && command.constructor.name === "TransactWriteCommand" && JSON.stringify(command.input).includes("\"CANCEL_REQUESTED\"")) {
        raced = true;
        await during();
      }
      return original(command);
    };
    return () => raced;
  };

  it("never overwrites a task that finished while the cancel was being written, and posts nothing", async () => {
    const { db, sweep, current, cancels, postNote } = await runningTask();
    const raced = beforeCancelWrite(db, () => { current().status = "SUCCEEDED"; });
    expect((await sweep()).cancelled).toEqual([]);
    expect(raced()).toBe(true);
    expect(current().status).toBe("SUCCEEDED");
    expect(cancels()).toHaveLength(0);
    expect(postNote).not.toHaveBeenCalled();
  });

  it("loses quietly to a member's stop that lands first: one cancel, the member's, and no note", async () => {
    const { db, handler, sweep, current, cancels, postNote, logs } = await runningTask();
    const raced = beforeCancelWrite(db, async () => {
      const stop = await handler({ source: "agentx.slack-ingress", action: "stop-task", thread: { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs }, userId: "U0456789012" });
      expect(JSON.parse(stop.body)).toMatchObject({ outcome: "CANCEL_REQUESTED" });
    });
    expect(await sweep()).toMatchObject({ cancelled: [], failed: [] });
    expect(raced()).toBe(true);
    expect(current().status).toBe("CANCEL_REQUESTED");
    expect(cancels()).toHaveLength(1);
    expect(cancels()[0]).toMatchObject({ requestedBy: { userId: "U0456789012" } });
    expect(postNote).not.toHaveBeenCalled();
    expect(logs).toContainEqual(expect.objectContaining({ event: "unwaited_task.skipped", reason: "already-cancelling" }));
  });

  it("logs a failed cancel by its error name only, and retries it on the next run", async () => {
    const { db, sweep, current, postNote, logs, workspaceId, operationId } = await runningTask();
    const original = db.send;
    let failOnce = true;
    db.send = async (command) => {
      if (failOnce && command.constructor.name === "TransactWriteCommand") {
        failOnce = false;
        throw Object.assign(new Error("PLANTED-CANCEL-MESSAGE xoxb-secret"), { name: "ProvisionedThroughputExceededException" });
      }
      return original(command);
    };
    expect(await sweep()).toMatchObject({ cancelled: [], failed: [operationId] });
    expect(current().status).toBe("RUNNING");
    expect(logs).toContainEqual({ event: "unwaited_task.cancel_failed", workspaceId, operationId, errorName: "ProvisionedThroughputExceededException" });
    expect(JSON.stringify(logs)).not.toContain("PLANTED");
    expect(postNote).not.toHaveBeenCalled();
    expect(await sweep()).toMatchObject({ cancelled: [operationId], failed: [] });
    expect(postNote).toHaveBeenCalledOnce();
  });

  it("logs a failed read by its error name, counts it apart, and goes on to the next workspace", async () => {
    const broken = await runningTask();
    const original = broken.db.send;
    broken.db.send = async (command) => {
      if (JSON.stringify(command.input).includes(`WORKSPACE#${broken.workspaceId}`)) throw Object.assign(new Error("PLANTED-READ"), { name: "ThrottlingException" });
      return original(command);
    };
    const result = await sweepUnwaitedTasks({
      client: broken.db, tableName: "state", threadsTableName: "threads", callbackSigningKey: "c".repeat(64), postNote: broken.postNote, log: (entry) => { broken.logs.push(entry); },
    }, [broken.workspaceId, randomUUID()], broken.now);
    expect(result).toMatchObject({ cancelled: [], failed: [], readFailures: [broken.workspaceId] });
    expect(broken.logs).toContainEqual({ event: "unwaited_task.read_failed", workspaceId: broken.workspaceId, errorName: "ThrottlingException" });
    expect(JSON.stringify(broken.logs)).not.toContain("PLANTED");
  });

  it("logs a failed note by its error name only and does not post it again (the task is already cancelled)", async () => {
    const { sweep, postNote, logs, workspaceId, operationId } = await runningTask();
    postNote.mockRejectedValueOnce(Object.assign(new Error("PLANTED-NOTE-MESSAGE"), { name: "SlackPostError" }));
    expect(await sweep()).toMatchObject({ cancelled: [operationId], noteFailures: 1 });
    expect(logs).toContainEqual({ event: "unwaited_task.note_failed", workspaceId, operationId, errorName: "SlackPostError" });
    expect(JSON.stringify(logs)).not.toContain("PLANTED");
    await sweep();
    expect(postNote).toHaveBeenCalledOnce();
  });
});

describe("the backstop: the bot token (#173)", () => {
  it("reads the bot token from the Slack secret", () => {
    expect(slackBotTokenFrom(JSON.stringify({ signingSecret: "s".repeat(32), botToken: "xoxb-1-2-3" }))).toBe("xoxb-1-2-3");
  });

  it("names a missing or unreadable secret SlackSecretInvalid, never carrying its text", () => {
    for (const text of [undefined, "", "not json PLANTED-SECRET", JSON.stringify({ botToken: "PLANTED-SECRET" })]) {
      let thrown: unknown;
      try {
        slackBotTokenFrom(text);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ name: "SlackSecretInvalid" });
      expect(String((thrown as Error).message)).not.toContain("PLANTED");
    }
  });
});

describe("the backstop: where it runs (#173)", () => {
  it("is wired only where the threads table, the Slack secret and the signing key are named (named environments)", async () => {
    const { unwaitedTaskBackstopWanted } = await import("../../packages/broker/src/aws/unwaited-tasks.js");
    const named = { SLACK_THREADS_TABLE_NAME: "threads", SLACK_SECRET_ARN: "arn:aws:secretsmanager:us-east-1:111122223333:secret:agentx/staging/slack-AbCdEf", CALLBACK_SIGNING_KEY: "k".repeat(32) };
    expect(unwaitedTaskBackstopWanted(named)).toBe(true);
    for (const missing of Object.keys(named)) {
      expect(unwaitedTaskBackstopWanted({ ...named, [missing]: undefined })).toBe(false);
    }
    expect(unwaitedTaskBackstopWanted({})).toBe(false);
  });
});

describe("the backstop: review hardening (#173)", () => {
  it("does not cancel when a worker event lands between the idle check and the cancel", async () => {
    const { db, sweep, current, event, cancels, postNote, logs } = await runningTask();
    const original = db.send;
    let raced = false;
    db.send = async (command) => {
      if (!raced && command.constructor.name === "TransactWriteCommand" && JSON.stringify(command.input).includes("\"CANCEL_REQUESTED\"")) {
        raced = true;
        event(0);
      }
      return original(command);
    };
    expect(await sweep()).toMatchObject({ cancelled: [], failed: [] });
    expect(raced).toBe(true);
    expect(current().status).toBe("RUNNING");
    expect(cancels()).toHaveLength(0);
    expect(postNote).not.toHaveBeenCalled();
    expect(logs).toContainEqual(expect.objectContaining({ event: "unwaited_task.skipped", reason: "active-again" }));
  });

  it("reads only the activeTurn from the thread's META row, never its notes", async () => {
    const { db, sweep } = await runningTask();
    const original = db.send;
    const threadReads: Array<Record<string, unknown>> = [];
    db.send = async (command) => {
      if (command.input.TableName === "threads") threadReads.push(command.input);
      return original(command);
    };
    await sweep();
    expect(threadReads).toHaveLength(1);
    expect(threadReads[0]).toMatchObject({ ProjectionExpression: "activeTurn" });
  });

  it("logs why it leaves a workspace alone when its Slack thread record is unreadable or points elsewhere", async () => {
    const unreadable = await runningTask();
    delete unreadable.db.find((item) => item.entityType === "SLACK_THREAD")[0]!.thread;
    await unreadable.sweep();
    expect(unreadable.logs).toContainEqual({ event: "unwaited_task.skipped", workspaceId: unreadable.workspaceId, reason: "thread-record-unreadable" });
    expect(unreadable.current().status).toBe("RUNNING");

    const rebound = await runningTask();
    rebound.db.find((item) => item.entityType === "SLACK_THREAD")[0]!.workspaceId = randomUUID();
    await rebound.sweep();
    expect(rebound.logs).toContainEqual({ event: "unwaited_task.skipped", workspaceId: rebound.workspaceId, reason: "thread-rebound" });
    expect(rebound.current().status).toBe("RUNNING");
  });

  it("leaves a workspace with no Slack thread at all (an API or CLI workspace) alone, quietly", async () => {
    const { db, sweep, logs, current } = await runningTask();
    const record = db.find((item) => item.entityType === "SLACK_THREAD")[0]!;
    db.delete(String(record.pk), String(record.sk));
    await sweep();
    expect(current().status).toBe("RUNNING");
    expect(logs).toEqual([]);
  });

  it("says when its configuration is only partly present, so a half-wired environment is visible", async () => {
    const { unwaitedTaskBackstopConfiguration } = await import("../../packages/broker/src/aws/unwaited-tasks.js");
    const named = { SLACK_THREADS_TABLE_NAME: "threads", SLACK_SECRET_ARN: "arn:aws:secretsmanager:us-east-1:111122223333:secret:agentx/staging/slack-AbCdEf", CALLBACK_SIGNING_KEY: "k".repeat(32) };
    expect(unwaitedTaskBackstopConfiguration(named)).toEqual({ state: "on" });
    expect(unwaitedTaskBackstopConfiguration({})).toEqual({ state: "off" });
    expect(unwaitedTaskBackstopConfiguration({ ...named, CALLBACK_SIGNING_KEY: undefined })).toEqual({ state: "partial", missing: ["CALLBACK_SIGNING_KEY"] });
  });
});

