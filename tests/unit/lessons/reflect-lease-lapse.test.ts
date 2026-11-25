// LP-14 (R4-0 item 3), the money look at the reflection lease: when the lease lapses (or the attempt fails) around a learning call on the HOSTED path, how many model calls can one reflection make?
// The hosted learning model is the gateway's (`createGatewayLearningModel`), so the calls counted here are the requests that reach a (fake) gateway, through the real worker, the real lease in a document store and
// the real model path. The rule under test (reflect-claims.ts): once a call may have reached the provider the lease carries `callStartedAt` and the reflection is SPENT, never run again.
//   BOUND: one reflection pays for the calls of ONE attempt (the reflector, then the curator's judge for each draft: every one marks the lease); a second attempt exists only when no call was started. Across
//   attempts that never reached the gateway the lease allows LESSONS_REFLECT_MAX_ATTEMPTS runs and then answers `exhausted`. Each call that does reach the gateway is held to the call's own cap
//   (hosted-learning.ts, CAP_WORDS) and to the company's learning month, which the GATEWAY holds (gateway-learning.ts: `gatewayLearningSpend` always answers ok, one place decides the money).
import { describe, expect, it, vi } from "vitest";
import { DocumentStoreError, LESSONS_REFLECT_MAX_ATTEMPTS } from "@agentx/contracts";
import { LEASE_MS, documentReflectClaims, reflectClaimKey } from "../../../packages/broker/src/lessons/reflect-claims.js";
import { createGatewayLearningModel } from "../../../packages/broker/src/lessons/gateway-learning.js";
import { runReflectMessage, type ReflectWorkerDeps } from "../../../packages/broker/src/lessons/reflect-worker.js";
import { MemoryDocumentStore } from "../../../packages/broker/src/ports/memory-document-store.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa";
const T0 = 1_800_000_000_000;
const CALL = { purpose: "reflect" as const, system: "You write lessons.", user: "What did this task teach?", maxOutputTokens: 800, workspaceId: ORG, project: "payments" };
const body = JSON.stringify({ orgId: ORG, taskId: "task-1", outcome: "merged", requestId: "req-1" });
const okAnswer = () => new Response(JSON.stringify({ model: "m", content: [{ type: "text", text: "{}" }] }), { status: 200, headers: { "content-type": "application/json" } });

class Db extends MemoryDocumentStore {
  constructor() { super({ ttlAttribute: "indexExpiresAt" }); }
  state() { return this.get(reflectClaimKey(ORG, "task-1", "merged")) as Promise<Record<string, unknown>>; }
}

/** The world: ONE lease table, ONE fake gateway whose requests are counted, and a clock the test moves. */
function world(reply: () => Response | Promise<Response> = okAnswer) {
  const db = new Db();
  const clock = { now: T0 };
  let n = 0;
  const claims = documentReflectClaims({ store: db, keysOutcome: async () => "clear", newAttemptId: () => `att-${++n}` });
  const gateway = vi.fn<(url: URL | string, init?: RequestInit) => Promise<Response>>(async () => await reply());
  const model = createGatewayLearningModel({ gatewayUrl: "https://gateway.example", token: async () => ({ token: "one-call-token", model: "claude-haiku" }), fetch: gateway as unknown as typeof fetch, now: () => clock.now });
  const logs: string[] = [];
  /** A worker that learns the way the reflector does: one call to the learning model, then `after` (a fault after the reply, or nothing). */
  const worker = (after: () => Promise<void> = async () => undefined): ReflectWorkerDeps => ({
    claims, now: () => clock.now, deadlineMs: 240_000, log: (event) => { logs.push(event); },
    async learn() {
      await model.complete(CALL);
      await after();
      return { status: "reflected", retry: false };
    },
  });
  return { db, clock, claims, gateway, model, worker, logs };
}

describe("the reflection lease on the hosted path: how many learning calls can one reflection make", () => {
  it("a lease that lapses WHILE the call is out: the redelivery does not call again (the call was marked before it was sent), and the late worker's own next call is refused too", async () => {
    let release!: () => void;
    const w = world(() => new Promise<Response>((resolve) => { release = () => resolve(okAnswer()); }));
    // The reflector's call, then the curator's judge call: both go through the same attempt.
    const first = runReflectMessage({ ...w.worker(), async learn() { await w.model.complete(CALL); await w.model.complete(CALL).catch(() => undefined); return { status: "reflected" as const, retry: false }; } }, body);
    await vi.waitFor(() => expect(w.gateway).toHaveBeenCalledTimes(1));
    expect(typeof (await w.db.state())["callStartedAt"]).toBe("number");
    // The first worker stalls past its lease; the queue hands the message to a second worker.
    w.clock.now = T0 + LEASE_MS + 1;
    expect(await runReflectMessage(w.worker(), body)).toEqual({ result: "already", retry: false });
    expect(w.gateway).toHaveBeenCalledTimes(1);
    expect((await w.db.state())["leaseState"]).toBe("spent");
    // The first worker's call comes back and it would make its judge's call: the lease is no longer its own to mark, so no request is sent.
    release();
    await first;
    expect(w.gateway).toHaveBeenCalledTimes(1);
  });

  it("a lease that lapses before the call is sent: the second worker makes the one call, and the stalled first worker's call is refused (its mark is conditional on its own attempt)", async () => {
    const w = world();
    let letFirstGo!: () => void;
    const held = new Promise<void>((resolve) => { letFirstGo = resolve; });
    const first = runReflectMessage({ ...w.worker(), async learn() { await held; await w.model.complete(CALL); return { status: "reflected" as const, retry: false }; } }, body);
    await vi.waitFor(async () => expect((await w.db.state())["attempt"]).toBe(1));
    w.clock.now = T0 + LEASE_MS + 1;
    expect(await runReflectMessage(w.worker(), body)).toEqual({ result: "reflected", retry: false });
    expect(w.gateway).toHaveBeenCalledTimes(1);
    letFirstGo();
    await first;
    expect(w.gateway).toHaveBeenCalledTimes(1);
  });

  it("a fault AFTER the reply (a store write, a parse) used to run the whole reflection again, and paid twice: now the call's mark makes the retry a no-op", async () => {
    const w = world();
    const failing = w.worker(async () => { throw new DocumentStoreError("unavailable", "down"); });
    expect(await runReflectMessage(failing, body)).toMatchObject({ result: "failed", retry: true });
    expect(w.gateway).toHaveBeenCalledTimes(1);
    // The message comes back after its backoff.
    w.clock.now += 61_000;
    expect(await runReflectMessage(w.worker(), body)).toEqual({ result: "already", retry: false });
    expect(w.gateway).toHaveBeenCalledTimes(1);
    expect((await w.db.state())["leaseState"]).toBe("spent");
  });

  it("the worker's own deadline (the call is still out, the race gives up) retries the message, and the retry does not call again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const w = world(() => new Promise<Response>(() => undefined));
      const run = runReflectMessage({ ...w.worker(), deadlineMs: 1_000, graceMs: 100 }, body);
      await vi.advanceTimersByTimeAsync(1_200);
      expect(await run).toMatchObject({ result: "timed_out", retry: true });
      expect(w.gateway).toHaveBeenCalledTimes(1);
      w.clock.now += 61_000;
      expect(await runReflectMessage(w.worker(), body)).toEqual({ result: "already", retry: false });
      expect(w.gateway).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it("the bound: attempts that never reach the gateway are capped at the lease's attempts, then exhausted; no request is ever sent", async () => {
    const w = world();
    const never = (): ReflectWorkerDeps => ({ ...w.worker(), async learn() { throw new Error("the task could not be read"); } });
    for (let attempt = 1; attempt <= LESSONS_REFLECT_MAX_ATTEMPTS; attempt += 1) {
      expect(await runReflectMessage(never(), body)).toMatchObject({ result: "failed", retry: true });
      expect((await w.db.state())["attempt"]).toBe(attempt);
      w.clock.now += 61_000;
    }
    expect(await runReflectMessage(never(), body)).toEqual({ result: "exhausted", retry: true });
    expect(w.gateway).not.toHaveBeenCalled();
  });

  it("a call the gateway refused (lessons_paused: nothing sent to a provider, nothing spent) takes its mark back, and a gateway answer that failed in any other way keeps it", async () => {
    const paused = world(() => new Response(JSON.stringify({ error: { type: "lessons_paused" } }), { status: 403, headers: { "x-rovara-lessons-pause": "monthly_limit" } }));
    await runReflectMessage({ ...paused.worker(), learn: async () => { await paused.model.complete(CALL).catch(() => undefined); return { status: "not_reflected" as const, retry: false }; } }, body);
    expect((await paused.db.state())["callStartedAt"]).toBeUndefined();
    const down = world(() => new Response("bad gateway", { status: 502 }));
    await runReflectMessage({ ...down.worker(), learn: async () => { await down.model.complete(CALL).catch(() => undefined); return { status: "not_reflected" as const, retry: false }; } }, body);
    expect(typeof (await down.db.state())["callStartedAt"]).toBe("number");
  });
});
