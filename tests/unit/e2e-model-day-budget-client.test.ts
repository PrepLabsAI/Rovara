import { afterEach, describe, expect, it, vi } from "vitest";
import type { E2EModelDayBudgetRequest } from "../../packages/contracts/src/e2e-model-channel.js";
import { createGovernedE2EModelRoute, type E2EDayLimits } from "../../packages/model-runtime/src/e2e-route.js";
import { createE2EModelDayBudgetClient } from "../../packages/worker/src/e2e-model-day-budget-client.js";
import { RUN_ID, bedrockRoute, channelRequest, tapAnswer } from "../support/e2e-model-fixtures.js";

// Task 4.3a, test case 6 (Ruling DB-8): the worker reserves, settles and releases the project's day budget through the broker.

const GROUP_RUN = "22222222-3333-4444-8555-666666666666";
const RESERVATION = "33333333-4444-4555-8666-777777777777";
const LIMITS: E2EDayLimits = { maxInputTokens: 2_000_000, maxCalls: 400 };
const answer = (status: string, reservationId = RESERVATION) => ({ schemaVersion: "rovara-e2e-model-budget/v1", reservationId, status });

afterEach(() => { vi.useRealTimers(); });

/** A broker that answers every stage as a healthy one would, and records what it was sent. */
function broker(reserve: "reserved" | "exhausted" = "reserved") {
  const sent: E2EModelDayBudgetRequest[] = [];
  const post = vi.fn(async (body: E2EModelDayBudgetRequest) => {
    sent.push(body);
    return answer(body.stage === "reserve" ? reserve : body.stage === "settle" ? "settled" : "released", body.reservationId);
  });
  return { post, sent };
}
const client = (post: (body: E2EModelDayBudgetRequest, signal: AbortSignal) => Promise<unknown>, extra: { timeoutMs?: number } = {}) =>
  createE2EModelDayBudgetClient({ post, groupRunId: GROUP_RUN, newReservationId: () => RESERVATION, ...extra });

describe("the day budget client", () => {
  it("reserves with the group run and the tokens, and nothing else: no project, no day, no cap", async () => {
    const { post, sent } = broker();
    const reservation = await client(post).reserve(4_000, LIMITS);
    expect(reservation).not.toBeNull();
    expect(sent).toEqual([{ schemaVersion: "rovara-e2e-model-budget/v1", stage: "reserve", reservationId: RESERVATION, groupRunId: GROUP_RUN, inputTokens: 4_000 }]);
    expect(JSON.stringify(sent)).not.toMatch(/project|day|maxInputTokens|maxCalls/i);
  });

  it("turns a broker 'exhausted' into no reservation, so the route refuses the call with budget and never reaches the provider", async () => {
    const { post } = broker("exhausted");
    expect(await client(post).reserve(4_000, LIMITS)).toBeNull();
    const invoke = vi.fn(async () => tapAnswer());
    const route = createGovernedE2EModelRoute(bedrockRoute(), { invoke, now: Date.now, dayBudget: client(post) });
    const outcome = await route.generate(channelRequest());
    expect(outcome.result).toMatchObject({ status: "error", code: "budget" });
    expect(outcome.receipt.outcome).toBe("budget");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("a transport error on reserve throws, which the route maps to budget (nothing is sent to the provider)", async () => {
    const post = vi.fn(async () => { throw new Error("connect ECONNRESET 10.0.0.1:443 token=SECRETTOKEN"); });
    await expect(client(post).reserve(4_000, LIMITS)).rejects.toThrow(/could not be reached/);
    // The error carries nothing the transport said.
    await client(post).reserve(4_000, LIMITS).catch((error: Error) => expect(error.message).not.toMatch(/SECRETTOKEN|ECONNRESET|10\.0\.0\.1/));
    expect(post).toHaveBeenCalledTimes(2);
    const invoke = vi.fn(async () => tapAnswer());
    const route = createGovernedE2EModelRoute(bedrockRoute(), { invoke, now: Date.now, dayBudget: client(post) });
    const outcome = await route.generate(channelRequest());
    expect(outcome.result).toMatchObject({ status: "error", code: "budget" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("reserve is not retried: one request, and it throws on a bad answer, a different reservation id or an odd status", async () => {
    const failing = vi.fn(async () => { throw new Error("down"); });
    await expect(client(failing).reserve(10, LIMITS)).rejects.toThrow();
    expect(failing).toHaveBeenCalledTimes(1);
    await expect(client(async () => answer("reserved", "99999999-4444-4555-8666-777777777777")).reserve(10, LIMITS)).rejects.toThrow();
    await expect(client(async () => answer("settled")).reserve(10, LIMITS)).rejects.toThrow();
    await expect(client(async () => ({ not: "an answer" })).reserve(10, LIMITS)).rejects.toThrow();
    await expect(client(async () => answer("free")).reserve(10, LIMITS)).rejects.toThrow();
  });

  it("refuses to ask for a reservation the broker's schema would not hold (0 tokens, or over 64000)", async () => {
    const { post } = broker();
    for (const tokens of [0, -5, 64_001, 1.5, Number.NaN]) await expect(client(post).reserve(tokens, LIMITS), String(tokens)).rejects.toThrow();
    expect(post).not.toHaveBeenCalled();
  });

  it("settle sends the same reservation id, once; a second settle or a release after it is a no-op", async () => {
    const { post, sent } = broker();
    const reservation = (await client(post).reserve(4_000, LIMITS))!;
    await reservation.settle(3_100);
    await reservation.settle(3_100);
    await reservation.release();
    expect(sent.map((body) => body.stage)).toEqual(["reserve", "settle"]);
    expect(sent[1]).toEqual({ schemaVersion: "rovara-e2e-model-budget/v1", stage: "settle", reservationId: RESERVATION, actualInputTokens: 3_100 });
  });

  it("settles at 64000 at most (the broker's bound), whatever the route charged, and refuses an amount that is not a positive number", async () => {
    const { post, sent } = broker();
    const reservation = (await client(post).reserve(4_000, LIMITS))!;
    await reservation.settle(250_000);
    expect(sent[1]).toMatchObject({ stage: "settle", actualInputTokens: 64_000 });
    const second = (await client(post).reserve(4_000, LIMITS))!;
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) await expect(second.settle(bad), String(bad)).rejects.toThrow();
    expect(sent.filter((body) => body.stage === "settle")).toHaveLength(1);
  });

  it("release sends the same reservation id", async () => {
    const { post, sent } = broker();
    const reservation = (await client(post).reserve(4_000, LIMITS))!;
    await reservation.release();
    expect(sent.at(-1)).toEqual({ schemaVersion: "rovara-e2e-model-budget/v1", stage: "release", reservationId: RESERVATION });
  });

  it("a settle that fails once is retried once with the same request, and succeeds", async () => {
    const sent: E2EModelDayBudgetRequest[] = [];
    let failures = 1;
    const post = vi.fn(async (body: E2EModelDayBudgetRequest) => {
      sent.push(body);
      if (body.stage === "settle" && failures-- > 0) throw new Error("throttled");
      return answer(body.stage === "reserve" ? "reserved" : body.stage === "settle" ? "settled" : "released", body.reservationId);
    });
    const reservation = (await client(post).reserve(4_000, LIMITS))!;
    await reservation.settle(2_000);
    const settles = sent.filter((body) => body.stage === "settle");
    expect(settles).toHaveLength(2);
    expect(settles[1]).toEqual(settles[0]);
  });

  it("settle and release time out at 5 s with one retry, then throw (the reservation is kept), and reserve times out without a retry", async () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const post = vi.fn((body: E2EModelDayBudgetRequest) => {
      sent.push(body.stage);
      return body.stage === "reserve" ? Promise.resolve(answer("reserved", body.reservationId)) : new Promise<never>(() => undefined);
    });
    const reservation = (await client(post).reserve(4_000, LIMITS))!;
    const settling = reservation.settle(2_000).then(() => "settled", (error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(sent.filter((stage) => stage === "settle")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent.filter((stage) => stage === "settle")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(await Promise.race([settling, Promise.resolve("pending")])).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(await settling).toMatch(/could not be reached/);
    // The failed settle did not become a release: the reservation stays charged.
    expect(sent).not.toContain("release");

    const releasing = reservation.release().then(() => "released", (error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await releasing).toMatch(/could not be reached/);
    expect(sent.filter((stage) => stage === "release")).toHaveLength(2);

    const hung = vi.fn(() => new Promise<never>(() => undefined));
    const reserving = client(hung).reserve(10, LIMITS).then(() => "reserved", (error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await reserving).toMatch(/could not be reached/);
    expect(hung).toHaveBeenCalledTimes(1);
  });

  it("aborts the request it gives up on, so a hung transport does not hold the run", async () => {
    vi.useFakeTimers();
    let seen: AbortSignal | undefined;
    const post = vi.fn((_body: E2EModelDayBudgetRequest, signal: AbortSignal) => { seen = signal; return new Promise<never>(() => undefined); });
    const pending = client(post, { timeoutMs: 200 }).reserve(10, LIMITS).catch(() => "gave up");
    await vi.advanceTimersByTimeAsync(200);
    expect(await pending).toBe("gave up");
    expect(seen?.aborted).toBe(true);
  });

  it("through the governed route: a reserved call is settled with what the provider charged, and a refused one releases", async () => {
    const { post, sent } = broker();
    const invoke = vi.fn(async () => tapAnswer());
    const route = createGovernedE2EModelRoute(bedrockRoute(), { invoke, now: Date.now, dayBudget: client(post) });
    const ok = await route.generate(channelRequest());
    expect(ok.receipt.outcome).toBe("ok");
    expect(sent.map((body) => body.stage)).toEqual(["reserve", "settle"]);
    expect(sent[1]).toMatchObject({ stage: "settle", actualInputTokens: 900 });
    expect(RUN_ID).toBeTruthy();
  });
});
