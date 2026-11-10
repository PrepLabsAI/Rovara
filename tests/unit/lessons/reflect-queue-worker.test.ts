// The reflection queue: the message holds ids only; the worker claims a reflection once, runs it under a deadline, and answers a batch the partial way (only the messages that need another try come back).
import { describe, expect, it, vi } from "vitest";
import { DocumentStoreError, LESSONS_REFLECT_DEAD_LETTER_QUEUE, LESSONS_REFLECT_LEASE_GRACE_SECONDS, LESSONS_REFLECT_MAX_ATTEMPTS, LESSONS_REFLECT_MAX_RECEIVES, LESSONS_REFLECT_QUEUE, LESSONS_REFLECT_RETRY_BACKOFF_SECONDS, LESSONS_WORKER_TIMEOUT_SECONDS } from "@agentx/contracts";
import { CLAIM_TTL_SECONDS, LEASE_MS, documentReflectClaims, reflectClaimKey, type ClaimStore, type Lease, type TakeResult } from "../../../packages/broker/src/lessons/reflect-claims.js";
import { ReflectMessageSchema, parseReflectMessage, queueReflectQueue, queueReflectVisibility, reflectQueueOf } from "../../../packages/broker/src/lessons/reflect-queue.js";
import { handleReflectBatch, retryDelaySeconds, runReflectMessage, type ReflectWorkerDeps } from "../../../packages/broker/src/lessons/reflect-worker.js";
import { logRef } from "../../../packages/broker/src/lessons/log-ref.js";
import { currentLearningAttempt, learningCallMayStart } from "../../../packages/broker/src/lessons/learning-deadline.js";
import { MemoryDocumentStore } from "../../../packages/broker/src/ports/memory-document-store.js";
import { MemoryQueueService } from "../../../packages/broker/src/ports/memory-queue.js";

const TEST_ORG = "org_aaaaaaaaaaaaaaaaaaaa";

/** A document store with the few reads and writes these tests make on a lease item. */
class LeaseDb extends MemoryDocumentStore {
  constructor() { super({ ttlAttribute: "indexExpiresAt" }); }
  async item(pk: string, sk: string): Promise<Record<string, unknown>> { return (await this.get({ pk, sk })) as Record<string, unknown>; }
  async set(item: Record<string, unknown>): Promise<void> { await this.put({ item: item as never }); }
  fail(): void { this.injectFault(new DocumentStoreError("unavailable", "down")); }
}

const message = (over: Record<string, unknown> = {}) => ({ orgId: TEST_ORG, taskId: "task-1", outcome: "merged", requestId: "req-1", ...over });
const body = (over: Record<string, unknown> = {}) => JSON.stringify(message(over));

describe("the message", () => {
  it("is exactly four ids and a fixed outcome word; anything else (extra text, a title, a bad outcome) is not a message", () => {
    expect(parseReflectMessage(body())).toEqual(message());
    for (const bad of [{ title: "Fix the login" }, { outcome: "exploded" }, { orgId: "not-an-org" }, { taskId: "" }, { taskId: "has space and\nnewline" }, { requestId: "x".repeat(300) }]) {
      expect(parseReflectMessage(body(bad)), JSON.stringify(bad)).toBeUndefined();
    }
    expect(parseReflectMessage("not json")).toBeUndefined();
    expect(ReflectMessageSchema.safeParse({ ...message(), text: "a person's words" }).success).toBe(false);
  });
  it("is sent as that JSON to the reflection queue, and the same request sent twice is stored once", async () => {
    const queue = await reflectQueueOf(new MemoryQueueService());
    const sender = queueReflectQueue(queue);
    await sender.send(message() as never);
    await sender.send(message() as never);
    await expect(sender.send({ ...message(), outcome: "nope" } as never)).rejects.toThrow();
    const received = await queue.receive({ maxMessages: 5 });
    expect(received).toHaveLength(1);
    expect(received[0]!.body).toEqual(message());
    expect(queue.name).toBe(LESSONS_REFLECT_QUEUE);
    expect(LESSONS_REFLECT_DEAD_LETTER_QUEUE).not.toBe(LESSONS_REFLECT_QUEUE);
    expect(LESSONS_REFLECT_MAX_RECEIVES).toBe(5);
  });
});


type Learn = ReflectWorkerDeps["learn"];
const reflected: Learn = async () => ({ status: "reflected", retry: false });

/** A lease store in memory for the worker's own logic (a durable one is tested below). */
function memoryClaims(script: TakeResult[] = []) {
  const taken: string[] = [];
  const finished: Array<{ state: string; attemptId: string }> = [];
  const marks: string[] = [];
  const seen = new Set<string>();
  const claims: ClaimStore = {
    take: async (m) => {
      const next = script.shift();
      if (next !== undefined) return next;
      const key = `${m.orgId}#${m.taskId}#${m.outcome}`;
      if (seen.has(key)) return { kind: "already" };
      seen.add(key); taken.push(key);
      return { kind: "taken", lease: lease(m, 1) };
    },
    finish: async (held, state) => { finished.push({ state, attemptId: held.attemptId }); },
    markCallStarted: async (held) => { marks.push(`mark:${held.attemptId}`); },
    clearCallStarted: async (held) => { marks.push(`clear:${held.attemptId}`); },
  };
  return { claims, taken, finished, marks };
}
const lease = (m: { orgId: string; taskId: string; outcome: string }, attempt: number): Lease => ({ orgId: m.orgId, taskId: m.taskId, outcome: m.outcome, attempt, attemptId: `att-${attempt}`, key: reflectClaimKey(m.orgId, m.taskId, m.outcome) });

function worker(over: Partial<ReflectWorkerDeps> = {}, script: TakeResult[] = []) {
  const memory = memoryClaims(script);
  const learn = vi.fn(reflected);
  const logs: Array<{ event: string; fields: Record<string, string | number> }> = [];
  const delays: Array<{ handle: string; seconds: number }> = [];
  const deps: ReflectWorkerDeps = {
    claims: memory.claims, learn, now: () => 1_000_000, deadlineMs: 240_000, visibility: { delay: async (handle, seconds) => { delays.push({ handle, seconds }); } },
    log: (event, fields) => logs.push({ event, fields }), ...over,
  };
  return { deps, learn, logs, delays, ...memory, events: () => logs.map((l) => l.event), classes: () => logs.filter((l) => l.event === "lessons_worker.result").map((l) => l.fields["class"]) };
}

describe("the worker", () => {
  it("takes the lease once: a redelivery of the same task and outcome never runs the model again, while another outcome of the same task is its own reflection", async () => {
    const w = worker();
    expect(await runReflectMessage(w.deps, body())).toEqual({ result: "reflected", retry: false });
    expect(await runReflectMessage(w.deps, body({ requestId: "req-2" }))).toEqual({ result: "already", retry: false });
    expect(w.learn).toHaveBeenCalledTimes(1);
    expect(w.learn).toHaveBeenCalledWith({ workspaceId: TEST_ORG, taskId: "task-1", outcome: "merged" });
    expect((await runReflectMessage(w.deps, body({ outcome: "reverted" }))).result).toBe("reflected");
    expect(w.learn).toHaveBeenCalledTimes(2);
    expect(w.finished.map((f) => f.state)).toEqual(["done", "done"]);
  });
  it("drops a message that is not four ids (one fixed log line, nothing taken, nothing run)", async () => {
    const w = worker();
    expect(await runReflectMessage(w.deps, body({ extra: "x" }))).toEqual({ result: "invalid", retry: false });
    expect(w.learn).not.toHaveBeenCalled();
    expect(w.taken).toHaveLength(0);
    expect(w.events()).toEqual(["lessons_worker.invalid_message"]);
  });
  it("a fault of the lease makes the message come back, with a backoff; a message that cannot be parsed or was already taken does not", async () => {
    const failing: ClaimStore = { ...memoryClaims().claims, take: async () => { throw new Error("table down"); } };
    const w = worker({ claims: failing });
    expect(await handleReflectBatch(w.deps, { Records: [{ messageId: "m1", body: body(), receiptHandle: "h1" }, { messageId: "m2", body: "junk", receiptHandle: "h2" }] })).toEqual({ batchItemFailures: [{ itemIdentifier: "m1" }] });
    expect(w.learn).not.toHaveBeenCalled();
    expect(w.delays).toEqual([{ handle: "h1", seconds: 60 }]);
    expect(w.classes()).toEqual(["claim_failed"]);
    const ok = worker();
    await runReflectMessage(ok.deps, body());
    expect(await handleReflectBatch(ok.deps, { Records: [{ messageId: "m3", body: body() }] })).toEqual({ batchItemFailures: [] });
  });
  it("a retry that carries a time the host gave waits for it (at least the backoff, at most 15 minutes, in whole seconds); one without a time keeps the backoff", async () => {
    const record = { messageId: "m1", body: body(), receiptHandle: "h", attributes: { ApproximateReceiveCount: "1" } };
    const waits = async (retryAt: number | undefined): Promise<number | undefined> => {
      const w = worker({ learn: async () => ({ status: "not_reflected", retry: true, ...(retryAt === undefined ? {} : { retryAt }) }), now: () => 1_000_000 });
      await handleReflectBatch(w.deps, { Records: [record] });
      return w.delays[0]?.seconds;
    };
    expect(await waits(1_000_000 + 120_500)).toBe(121);
    expect(await waits(1_000_000 + 10_000)).toBe(60);
    expect(await waits(1_000_000 + 3_600_000)).toBe(900);
    expect(await waits(1_000_000 - 5)).toBe(60);
    expect(await waits(undefined)).toBe(60);
  });
  it("a typed retryable fault ends the lease at retry and the message comes back after the backoff of its receive count (60, 300, then 900 s); a final outcome is answered", async () => {
    expect(LESSONS_REFLECT_RETRY_BACKOFF_SECONDS).toEqual([60, 300, 900]);
    expect([1, 2, 3, 4, 9].map(retryDelaySeconds)).toEqual([60, 300, 900, 900, 900]);
    const retrying = worker({ learn: async () => ({ status: "not_reflected", retry: true }) });
    const record = (receives: string) => ({ messageId: "m1", body: body(), receiptHandle: "h", attributes: { ApproximateReceiveCount: receives } });
    expect(await handleReflectBatch(retrying.deps, { Records: [record("2")] })).toEqual({ batchItemFailures: [{ itemIdentifier: "m1" }] });
    expect(retrying.finished).toEqual([{ state: "retry", attemptId: "att-1" }]);
    expect(retrying.delays).toEqual([{ handle: "h", seconds: 300 }]);
    expect(retrying.classes()).toEqual(["retry"]);
    const final = worker({ learn: async () => ({ status: "not_reflected", retry: false }) });
    expect(await handleReflectBatch(final.deps, { Records: [record("1")] })).toEqual({ batchItemFailures: [] });
    expect(final.finished).toEqual([{ state: "done", attemptId: "att-1" }]);
    expect(final.delays).toEqual([]);
  });
  it("a reflection that throws is a retryable fault too (the lease says retry; the ledger decides on the next take), and its text is never logged", async () => {
    const w = worker({ learn: async () => { throw new Error("boom with a person's words"); } });
    expect(await handleReflectBatch(w.deps, { Records: [{ messageId: "m1", body: body() }] })).toEqual({ batchItemFailures: [{ itemIdentifier: "m1" }] });
    expect(w.finished).toEqual([{ state: "retry", attemptId: "att-1" }]);
    expect(w.events()).toContain("lessons_worker.failed");
    expect(JSON.stringify(w.logs)).not.toContain("boom");
  });
  it("every worker log line about a task names it only as logRef(company, task), never the raw id", async () => {
    const ref = logRef(TEST_ORG, "task-1");
    const lines = async (w: ReturnType<typeof worker>, run: () => Promise<unknown>): Promise<Array<{ event: string; fields: Record<string, string | number> }>> => { await run(); return w.logs; };
    const waiting = worker({}, [{ kind: "wait" }]);
    const failed = worker({ learn: async () => { throw new Error("boom"); }, claims: { ...memoryClaims().claims, finish: async () => { throw new Error("table down"); } } });
    const ok = worker();
    const all = [
      ...(await lines(waiting, () => runReflectMessage(waiting.deps, body()))),
      ...(await lines(failed, () => runReflectMessage(failed.deps, body()))),
      ...(await lines(ok, () => runReflectMessage(ok.deps, body()))),
    ];
    const about = all.filter((l) => l.event !== "lessons_worker.backoff_failed");
    expect(about.map((l) => l.event)).toEqual(expect.arrayContaining(["lessons_worker.result", "lessons_worker.failed", "lessons_worker.finish_failed"]));
    for (const line of about) {
      expect(Object.keys(line.fields), line.event).not.toContain("taskId");
      expect(line.fields["task"], line.event).toBe(ref);
    }
    expect(JSON.stringify(all)).not.toContain("task-1");
  });
  it("a lease it must wait for (earlier keys not settled), or whose attempts are used up, comes back without running anything and without ending a lease", async () => {
    for (const kind of ["wait", "exhausted"] as const) {
      const w = worker({}, [{ kind }]);
      expect(await handleReflectBatch(w.deps, { Records: [{ messageId: "m1", body: body(), receiptHandle: "h" }] })).toEqual({ batchItemFailures: [{ itemIdentifier: "m1" }] });
      expect(w.learn).not.toHaveBeenCalled();
      expect(w.finished).toEqual([]);
      expect(w.classes()).toEqual([kind]);
    }
  });
  it("a failure to set the backoff or to end the lease never changes the answer", async () => {
    const w = worker({ learn: async () => ({ status: "not_reflected", retry: true }), visibility: { delay: async () => { throw new Error("sqs down"); } }, claims: { ...memoryClaims().claims, finish: async () => { throw new Error("table down"); } } });
    expect(await handleReflectBatch(w.deps, { Records: [{ messageId: "m1", body: body(), receiptHandle: "h" }] })).toEqual({ batchItemFailures: [{ itemIdentifier: "m1" }] });
    expect(w.events()).toEqual(expect.arrayContaining(["lessons_worker.finish_failed", "lessons_worker.backoff_failed"]));
  });
  it("the deadline aborts the signal the work holds (and no model call starts that could not finish inside it); the work that stops by itself is a retryable fault, not a loss", async () => {
    vi.useFakeTimers();
    try {
      const seen: boolean[] = [];
      let signal: AbortSignal | undefined;
      const w = worker({
        deadlineMs: 5_000, now: () => Date.now(),
        learn: () => new Promise((resolve) => {
          const attempt = currentLearningAttempt()!;
          signal = attempt.signal;
          seen.push(learningCallMayStart(Date.now(), 1_000), learningCallMayStart(Date.now() + 4_500, 1_000));
          attempt.signal!.addEventListener("abort", () => resolve({ status: "not_reflected", retry: true }));
        }),
      });
      const running = runReflectMessage(w.deps, body());
      await vi.advanceTimersByTimeAsync(5_000);
      expect(signal?.aborted).toBe(true);
      expect(await running).toEqual({ result: "not_reflected", retry: true });
      expect(w.finished).toEqual([{ state: "retry", attemptId: "att-1" }]);
      // Inside the work: a call of 1 s may start at the beginning, not 4.5 s in. Outside any worker there is no deadline.
      expect(seen).toEqual([true, false]);
      expect(learningCallMayStart(Date.now() + 10_000_000, 1_000_000)).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it("work that ignores the signal is given up a grace after it (the last guard), logged as a fault and retried; its attempt carries the lease's id and key", async () => {
    vi.useFakeTimers();
    try {
      let attemptSeen: ReturnType<typeof currentLearningAttempt>;
      const w = worker({ deadlineMs: 5_000, graceMs: 2_000, now: () => Date.now(), learn: () => { attemptSeen = currentLearningAttempt(); return new Promise(() => undefined); } });
      const running = runReflectMessage(w.deps, body());
      await vi.advanceTimersByTimeAsync(7_000);
      expect(await running).toEqual({ result: "timed_out", retry: true });
      expect(w.events()).toContain("lessons_worker.deadline");
      expect(w.finished).toEqual([{ state: "retry", attemptId: "att-1" }]);
      expect(attemptSeen).toMatchObject({ attemptId: "att-1", leaseKey: reflectClaimKey(TEST_ORG, "task-1", "merged") });
      expect(attemptSeen?.signal?.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it("the attempt hands the model path the lease's call mark (written before the call, taken back only for a call that was not sent), and says when it is the last attempt", async () => {
    let attemptSeen: ReturnType<typeof currentLearningAttempt>;
    const w = worker({ learn: async () => { attemptSeen = currentLearningAttempt(); await attemptSeen!.callStarting!(); await attemptSeen!.callNotSent!(); return { status: "reflected", retry: false }; } });
    await runReflectMessage(w.deps, body());
    expect(w.marks).toEqual(["mark:att-1", "clear:att-1"]);
    expect(attemptSeen?.lastAttempt).toBe(false);
    const last = worker({ learn: async () => { attemptSeen = currentLearningAttempt(); return { status: "reflected", retry: false }; } }, [{ kind: "taken", lease: lease(message(), LESSONS_REFLECT_MAX_ATTEMPTS) }]);
    await runReflectMessage(last.deps, body());
    expect(attemptSeen?.lastAttempt).toBe(true);
    // A mark that cannot be written is the model path's to handle (the call is not made); the worker does not hide it.
    const failing = worker({ claims: { ...memoryClaims().claims, markCallStarted: async () => { throw new Error("table down"); } }, learn: async () => { await currentLearningAttempt()!.callStarting!(); return { status: "reflected", retry: false }; } });
    expect(await runReflectMessage(failing.deps, body())).toEqual({ result: "failed", retry: true });
  });
  it("calls are counted per attempt: a later call taken back (not forwarded) undoes only its own mark, never an earlier call's; the mark is removed only when no started call is left", async () => {
    const w = worker({ learn: async () => {
      const attempt = currentLearningAttempt()!;
      await attempt.callStarting!();   // the reflector's call
      await attempt.callStarting!();   // the judge's call
      await attempt.callNotSent!();    // the judge's is refused before anything was sent
      w.marks.push("--");
      await attempt.callNotSent!();    // the reflector's own call is taken back too
      return { status: "reflected", retry: false };
    } });
    await runReflectMessage(w.deps, body());
    expect(w.marks).toEqual(["mark:att-1", "mark:att-1", "--", "clear:att-1"]);
  });
  it("reflect-call-started, judge-not-forwarded, timeout: the lease keeps its mark, so the next take does not run the reflection again", async () => {
    const T0 = 1_800_000_000_000;
    const db = new LeaseDb();
    const stateOf = () => db.item(reflectClaimKey(TEST_ORG, "task-1", "merged").pk, "CLAIM");
    const claims = documentReflectClaims({ store: db, keysOutcome: async () => "clear", newAttemptId: (() => { let n = 0; return () => `att-${++n}`; })() });
    const w = worker({
      claims, now: () => T0,
      learn: async () => {
        const attempt = currentLearningAttempt()!;
        await attempt.callStarting!();            // the reflector's call reached the provider
        await attempt.callStarting!();            // then the judge's call ...
        await attempt.callNotSent!();             // ... was refused before it sent anything
        throw new Error("timed out");             // and the attempt ends without a result: the lease goes to retry
      },
    });
    expect(await runReflectMessage(w.deps, body())).toEqual({ result: "failed", retry: true });
    expect((await stateOf())["leaseState"]).toBe("retry");
    expect(typeof (await stateOf())["callStartedAt"]).toBe("number");
    expect(await claims.take(message() as never, T0 + 1)).toEqual({ kind: "already" });
    expect((await stateOf())["leaseState"]).toBe("spent");
  });
  it("the deadline is also the invocation's remaining time less a minute; with no more than a minute left nothing is taken and the message comes back", async () => {
    vi.useFakeTimers();
    try {
      let deadlineAt = 0;
      const w = worker({ now: () => Date.now(), learn: async () => { deadlineAt = currentLearningAttempt()!.deadlineAt; return { status: "reflected", retry: false }; } });
      const start = Date.now();
      await runReflectMessage(w.deps, body(), { getRemainingTimeInMillis: () => 100_000 });
      expect(deadlineAt - start).toBe(40_000);
      const late = worker();
      expect(await runReflectMessage(late.deps, body(), { getRemainingTimeInMillis: () => 59_000 })).toEqual({ result: "no_time", retry: true });
      expect(late.taken).toHaveLength(0);
    } finally { vi.useRealTimers(); }
  });
});

describe("the lease in the State table", () => {
  const T0 = 1_800_000_000_000;
  const stateOf = (db: LeaseDb, m = message()) => db.item(reflectClaimKey(m.orgId, m.taskId, m.outcome).pk, "CLAIM");
  function leases(outcomes: Array<"clear" | "spent" | "pending"> | ((ids: readonly string[]) => "clear" | "spent" | "pending") = []) {
    const db = new LeaseDb();
    const asked: Array<readonly string[]> = [];
    let n = 0;
    const claims = documentReflectClaims({
      store: db, newAttemptId: () => `att-${++n}`,
      keysOutcome: async (_org, ids) => { asked.push(ids); return typeof outcomes === "function" ? outcomes(ids) : outcomes.shift() ?? "clear"; },
    });
    return { db, claims, asked };
  }
  const taken = (result: TakeResult): Lease => { if (result.kind !== "taken") throw new Error(`not taken: ${result.kind}`); return result.lease; };

  it("the key holds the org: LEARN#<org>#<task>#<outcome>; a task id another company sends can never use up this company's lease", async () => {
    const { db, claims } = leases();
    expect(reflectClaimKey("org_a", "t", "reverted")).toEqual({ pk: "LEARN#org_a#t#reverted", sk: "CLAIM" });
    const first = taken(await claims.take(message(), T0));
    expect(first).toMatchObject({ attempt: 1, attemptId: "att-1", key: { pk: `LEARN#${TEST_ORG}#task-1#merged`, sk: "CLAIM" } });
    const other = "org_zzzzzzzzzzzzzzzzzzzz";
    expect(taken(await claims.take(message({ orgId: other }) as never, T0)).key.pk).toBe(`LEARN#${other}#task-1#merged`);
    expect(await claims.take(message({ requestId: "again" }) as never, T0 + 5)).toEqual({ kind: "already" });
    expect(await stateOf(db)).toBeDefined();
    expect(await stateOf(db, message({ orgId: other }) as never)).toBeDefined();
  });
  it("starts running with a lease for the worker's timeout plus a minute, expires in 30 days, and holds the org, the times and the state only", async () => {
    const { db, claims } = leases();
    await claims.take(message(), T0);
    const item = await stateOf(db);
    expect(item).toMatchObject({ sk: "CLAIM", orgId: TEST_ORG, leaseState: "running", attempt: 1, attemptId: "att-1", leaseUntil: T0 + LEASE_MS, claimedAt: T0 / 1000, indexExpiresAt: T0 / 1000 + CLAIM_TTL_SECONDS });
    expect(LEASE_MS).toBe((LESSONS_WORKER_TIMEOUT_SECONDS + LESSONS_REFLECT_LEASE_GRACE_SECONDS) * 1000);
    expect(CLAIM_TTL_SECONDS).toBe(30 * 86_400);
    expect(Object.keys(item).sort()).toEqual(["attempt", "attemptId", "claimedAt", "entityType", "indexExpiresAt", "leaseState", "leaseUntil", "orgId", "pk", "sk"]);
  });
  it("a live lease is not taken by a second worker; done and spent are never taken again; another table fault is thrown", async () => {
    const { db, claims } = leases();
    const held = taken(await claims.take(message(), T0));
    expect(await claims.take(message() as never, T0 + 1000)).toEqual({ kind: "already" });
    await claims.finish(held, "done", T0 + 2000);
    expect(await claims.take(message() as never, T0 + LEASE_MS + 1)).toEqual({ kind: "already" });
    expect((await stateOf(db))["leaseState"]).toBe("done");
    db.fail();
    await expect(claims.take(message({ taskId: "task-2" }) as never, T0)).rejects.toThrow();
  });
  it("a retry is taken again only when every model key of the earlier attempt settled with nothing spent: then attempt + 1, a new id, and the old key ids cleared", async () => {
    const { db, claims, asked } = leases(["clear"]);
    const first = taken(await claims.take(message(), T0));
    // The model path notes the keys it minted on the lease item (mintOperationKey's recordOn).
    await db.set({ ...(await stateOf(db)), modelKeyIds: ["k1", "k2"] });
    await claims.finish(first, "retry", T0 + 1000);
    expect((await stateOf(db))["leaseState"]).toBe("retry");
    const second = taken(await claims.take(message(), T0 + 2000));
    expect(asked).toEqual([["k1", "k2"]]);
    expect(second).toMatchObject({ attempt: 2, attemptId: "att-2" });
    expect(await stateOf(db)).toMatchObject({ leaseState: "running", attempt: 2, attemptId: "att-2" });
    expect((await stateOf(db))["modelKeyIds"]).toBeUndefined();
  });
  it("any key that spent makes the work final (the lease becomes spent and is never taken again); a key not yet settled makes the taker wait, without using an attempt", async () => {
    const spent = leases(["spent"]);
    const first = taken(await spent.claims.take(message(), T0));
    await spent.claims.finish(first, "retry", T0);
    expect(await spent.claims.take(message() as never, T0 + 1)).toEqual({ kind: "already" });
    expect((await stateOf(spent.db))["leaseState"]).toBe("spent");
    expect(await spent.claims.take(message() as never, T0 + 2)).toEqual({ kind: "already" });

    const pending = leases(["pending", "clear"]);
    const one = taken(await pending.claims.take(message(), T0));
    await pending.claims.finish(one, "retry", T0);
    expect(await pending.claims.take(message() as never, T0 + 1)).toEqual({ kind: "wait" });
    expect(await stateOf(pending.db)).toMatchObject({ leaseState: "retry", attempt: 1 });
    expect(taken(await pending.claims.take(message() as never, T0 + 2)).attempt).toBe(2);
  });
  it("a lease whose attempt started the model call is SPENT whatever its keys settled at (an unpriced route books $0, spend can land after the sweep): never run again, in retry or after a lapse; the ledger is not even asked", async () => {
    for (const how of ["retry", "lapsed"] as const) {
      const { db, claims, asked } = leases(() => "clear");
      const held = taken(await claims.take(message(), T0));
      await claims.markCallStarted(held, T0 + 10);
      expect((await stateOf(db))["callStartedAt"]).toBe(T0 + 10);
      if (how === "retry") await claims.finish(held, "retry", T0 + 20);
      const at = how === "retry" ? T0 + 30 : T0 + LEASE_MS + 1;
      expect(await claims.take(message() as never, at)).toEqual({ kind: "already" });
      expect((await stateOf(db))["leaseState"]).toBe("spent");
      expect(await claims.take(message() as never, at + 1)).toEqual({ kind: "already" });
      expect(asked, how).toEqual([]);
    }
  });
  it("without a call mark the old rule stands (the keys decide), and the next attempt starts with no mark; a mark taken back (the call was not sent) lets the work run again; both writes are conditional on the attempt", async () => {
    const { db, claims } = leases(() => "clear");
    const first = taken(await claims.take(message(), T0));
    await claims.markCallStarted(first, T0 + 1);
    await claims.clearCallStarted(first);
    expect((await stateOf(db))["callStartedAt"]).toBeUndefined();
    await claims.finish(first, "retry", T0 + 2);
    const second = taken(await claims.take(message(), T0 + 3));
    expect(second.attempt).toBe(2);
    // The mark of an attempt that no longer holds the lease is refused, and so is taking one back: the call is not made.
    await expect(claims.markCallStarted(first, T0 + 4)).rejects.toThrow();
    await claims.markCallStarted(second, T0 + 5);
    await expect(claims.clearCallStarted(first)).rejects.toThrow();
    expect((await stateOf(db))["callStartedAt"]).toBe(T0 + 5);
    await claims.finish(second, "retry", T0 + 6);
    expect(await claims.take(message() as never, T0 + 7)).toEqual({ kind: "already" });
  });
  it("a worker that died (its lease ran out while running) is treated like a retry: the keys decide, a clear ledger lets the work run again, spent stops it", async () => {
    const dead = leases(["clear"]);
    taken(await dead.claims.take(message(), T0));
    expect(await dead.claims.take(message() as never, T0 + LEASE_MS - 1)).toEqual({ kind: "already" });
    expect(taken(await dead.claims.take(message() as never, T0 + LEASE_MS + 1)).attempt).toBe(2);
    expect(dead.asked).toEqual([[]]);

    const paid = leases(() => "spent");
    taken(await paid.claims.take(message(), T0));
    await paid.db.set({ ...(await stateOf(paid.db)), modelKeyIds: ["k9"] });
    expect(await paid.claims.take(message() as never, T0 + LEASE_MS + 1)).toEqual({ kind: "already" });
    expect((await stateOf(paid.db))["leaseState"]).toBe("spent");
    expect(paid.asked).toEqual([["k9"]]);
  });
  it("the attempts are capped; after the last retry the answer is exhausted (the message goes on to the dead-letter queue), and never a fourth run", async () => {
    expect(LESSONS_REFLECT_MAX_ATTEMPTS).toBe(3);
    const { claims } = leases(() => "clear");
    let at = T0;
    for (let attempt = 1; attempt <= LESSONS_REFLECT_MAX_ATTEMPTS; attempt += 1) {
      const held = taken(await claims.take(message(), at));
      expect(held.attempt).toBe(attempt);
      await claims.finish(held, "retry", at);
      at += 1000;
    }
    expect(await claims.take(message() as never, at)).toEqual({ kind: "exhausted" });
    expect(await claims.take(message() as never, at + 1)).toEqual({ kind: "exhausted" });
  });
  it("two workers taking the same retry at once: one runs, the other finds it taken (a write conditional on the attempt that was read)", async () => {
    const { claims } = leases(() => "clear");
    const held = taken(await claims.take(message(), T0));
    await claims.finish(held, "retry", T0);
    const both = await Promise.all([claims.take(message() as never, T0 + 1), claims.take(message() as never, T0 + 1)]);
    expect(both.map((r) => r.kind).sort()).toEqual(["already", "taken"]);
  });
  it("ending a lease that is no longer this attempt's (it lapsed and another worker took over) changes nothing", async () => {
    const { db, claims } = leases(() => "clear");
    const first = taken(await claims.take(message(), T0));
    const second = taken(await claims.take(message(), T0 + LEASE_MS + 1));
    await claims.finish(first, "done", T0 + LEASE_MS + 2);
    expect(await stateOf(db)).toMatchObject({ leaseState: "running", attemptId: second.attemptId });
    await claims.finish(second, "retry", T0 + LEASE_MS + 3);
    expect((await stateOf(db))["leaseState"]).toBe("retry");
  });
});

describe("the visibility backoff", () => {
  it("sets the message's visibility timeout on its queue by receipt handle", async () => {
    const changes: Array<[string, number]> = [];
    const queue = { changeVisibility: async (receipt: string, seconds: number) => { changes.push([receipt, seconds]); return true; } };
    await queueReflectVisibility(queue as never).delay("receipt-1", 300);
    expect(changes).toEqual([["receipt-1", 300]]);
  });
});

describe("the enqueue never holds a task end", () => {
  it("gives up at its own time limit when the queue does not answer", async () => {
    vi.useFakeTimers();
    try {
      const queue = queueReflectQueue({ enqueue: () => new Promise(() => undefined) } as never, { timeoutMs: 2000 });
      const outcome = queue.send(message() as never).then(() => "sent", () => "gave up");
      await vi.advanceTimersByTimeAsync(2000);
      expect(await outcome).toBe("gave up");
    } finally { vi.useRealTimers(); }
  });
});
