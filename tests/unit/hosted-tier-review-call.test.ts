// TIER-GROWTH-MERGE: the hosted call itself (core-host/hosted-tier-review.ts `call`), after the meter has let it through: its own worst-case check before anything is sent, what it books and when, that nothing is repeated once a
// request may have reached the model, and what the token it mints says. The task's records are stubbed (the payer and workspace reads); the gateway is a stub `fetch`.
import { describe, expect, it, vi } from "vitest";
import { parseTaskTokenClaims } from "@agentx/contracts";
import { gatewayCallUsd } from "../../packages/broker/src/core-host/gateway-call-price.js";
import { TierReviewCapError, TierReviewNoRetry, TierReviewUnsupported, callWithDeadline, tierReviewTask } from "../../packages/broker/src/core/build-step/tier-review-calls.js";
import { hostedTierReview } from "../../packages/broker/src/core-host/hosted-tier-review.js";
import { runPriceFor } from "../support/hosted-run-price.js";
import { signingWorld } from "../support/model-gateway.js";

vi.mock("../../packages/broker/src/core/task-flow/stage-machine.js", async (original) => ({ ...(await original<object>()), readWorkspace: async () => ({ id: "11111111-1111-4111-8111-111111111111", projectName: "demo" }) }));
vi.mock("../../packages/broker/src/core/task-flow/reads.js", async (original) => ({ ...(await original<object>()), workspaceOperations: async () => [{ kind: "task", id: "22222222-2222-4222-8222-222222222222", fence: 3, companyId: "org_corehost00000000000a" }] }));
vi.mock("../../packages/broker/src/core/model-gateway/describer.js", async (original) => ({ ...(await original<object>()), taskPayerOf: async () => ({ payer: { kind: "project", project: "demo" }, person: undefined, origin: "app", repairDraft: false }) }));

const COMPANY = "org_corehost00000000000a";
const MODEL = "claude-sonnet-4-6";
const signer = signingWorld().signer;
const price = { ...runPriceFor(MODEL), companyId: COMPANY };
const TASK = { pk: "TASK#t1", sk: "TASK", taskId: "t1", companyId: COMPANY, project: "demo", workspaceId: "w1", workflow: { stage: "WAIT_FOR_MERGE" } };
const PROMPT = "review this ".repeat(50);

/** A store with the rows a restart would keep: the task, and whatever the adapter puts. */
function rowsStore() {
  const rows = new Map<string, Record<string, unknown>>();
  return { rows, store: {
    get: async () => TASK,
    put: async ({ item }: { item: { pk: string; sk: string } }) => { rows.set(`${item.pk}|${item.sk}`, item); },
    query: async ({ pk }: { pk: string }) => ({ items: [...rows.values()].filter((row) => row["pk"] === pk) }),
    delete: async ({ key }: { key: { pk: string; sk: string } }) => { rows.delete(`${key.pk}|${key.sk}`); },
  } };
}

function world(input: { store?: ReturnType<typeof rowsStore>["store"];  room?: number; reply?: () => Promise<Response> | Response; booking?: (report: unknown) => Promise<boolean>; timeoutMs?: number } = {}) {
  const posts: Array<{ headers: Headers; body: string }> = [];
  const booked: unknown[] = [];
  const fetchStub = (async (url: string | URL, init?: RequestInit) => {
    const where = new URL(String(url));
    if (where.pathname.endsWith("/rate-quote")) return Response.json({ runPrice: { ...price, expiresAt: Date.now() + 300_000 } });
    posts.push({ headers: new Headers(init?.headers), body: init?.body as string });
    if (input.reply === undefined) return Response.json({ content: [{ type: "text", text: "{\"findings\":[]}" }], usage: { input_tokens: 10, output_tokens: 5 } });
    const reply = input.reply;
    return new Promise<Response>((resolve, reject) => { init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))); Promise.resolve(reply()).then(resolve, reject); });
  }) as unknown as typeof fetch;
  const flow = { store: input.store ?? rowsStore().store, companyId: COMPANY, admission: { admit: async () => ({ allowed: true }) }, modelAccess: { route: async () => ({ alias: MODEL }) } };
  const built = hostedTierReview({
    env: { ROVARA_CORE_MODEL_GATEWAY_URL: "https://gateway.example", ROVARA_CORE_AGENT_MODEL: MODEL }, taskTokens: () => ({ signer, issuer: "https://api.example/v1/auth" }), flow: flow as never, companyId: COMPANY, now: () => new Date(),
    taskRoomUsd: async () => input.room ?? 5, booking: { bookUsageReport: input.booking ?? (async (report) => { booked.push(report); return true; }) }, fetch: fetchStub, ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  })!;
  const run = (prompt = PROMPT) => tierReviewTask.run({ taskId: "t1" }, () => built.call({ model: undefined, prompt, purpose: "code_review", signal: new AbortController().signal }));
  return { built, run, posts, booked };
}
const claimsOf = (token: string) => JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()) as { stp: string; mdl: string[]; ws: string; op: string; tid: string; exp: number; iat: number; jti: string; runPrice?: unknown; reviewer?: { kind: string; slot: string; ceilingUsd: number } };

describe("the hosted tier review call", () => {
  it("sends nothing when its own worst case for the prompt does not fit in what the task has left", async () => {
    const w = world({ room: 0.000001 });
    await expect(w.run()).rejects.toBeInstanceOf(TierReviewCapError);
    expect(w.posts).toHaveLength(0);
    expect(w.booked).toHaveLength(0);
  });

  it("mints a tier_review reviewer grant: step = kind, three members, the call's priced worst case as the ceiling, one model, 120 seconds, a fresh jti, the task's own workspace and operation, the signed price; the token is in the header only", async () => {
    const w = world();
    expect(await w.run()).toBe("{\"findings\":[]}");
    await w.run();
    const sent = w.posts[0]!;
    const claims = claimsOf(sent.headers.get("x-api-key")!);
    expect(claims).toMatchObject({ stp: "tier_review", mdl: [MODEL], tid: "t1", ws: "11111111-1111-4111-8111-111111111111", op: "22222222-2222-4222-8222-222222222222", reviewer: { kind: "tier_review", slot: "tier_code" } });
    expect(Object.keys(claims.reviewer!).sort(), "exactly kind, slot and ceilingUsd").toEqual(["ceilingUsd", "kind", "slot"]);
    expect(claims.reviewer!.ceilingUsd, "the ceiling is the worst case of the request as sent").toBe(gatewayCallUsd(price, { system: "", user: PROMPT, maxOutputTokens: 4096 }));
    expect(claims.exp - claims.iat).toBe(120);
    expect(claims.runPrice).toMatchObject({ model: MODEL, companyId: COMPANY });
    expect(parseTaskTokenClaims(claims), "Code's own schema reads the claims").toBeDefined();
    expect(claimsOf(w.posts[1]!.headers.get("x-api-key")!).jti, "one fresh grant per review").not.toBe(claims.jti);
    expect(sent.body).not.toContain(sent.headers.get("x-api-key"));
    expect(JSON.parse(sent.body)).toEqual({ model: MODEL, max_tokens: 4096, messages: [{ role: "user", content: PROMPT }] });
    expect(w.booked).toHaveLength(2);
  });

  it("asks under the slot of the review: tier_security for the security review", async () => {
    const w = world();
    await tierReviewTask.run({ taskId: "t1" }, () => w.built.call({ model: undefined, prompt: PROMPT, purpose: "security_review", signal: new AbortController().signal }));
    expect(claimsOf(w.posts[0]!.headers.get("x-api-key")!).reviewer?.slot).toBe("tier_security");
  });

  it("an older gateway that does not know the kind refuses with 401: nothing is booked, the review does not run, and it is a plain failure (the person reads could-not-run once the runs are spent)", async () => {
    vi.useFakeTimers();
    try {
      const w = world({ reply: () => new Response("{}", { status: 401 }) });
      const done = callWithDeadline((input) => tierReviewTask.run({ taskId: "t1" }, () => w.built.call(input)), { model: undefined, prompt: PROMPT, purpose: "code_review" }, 60_000);
      const assertion = expect(done).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(5_000);
      await assertion;
      await expect(done).rejects.not.toBeInstanceOf(TierReviewCapError);
      expect(w.booked).toHaveLength(0);
    } finally { vi.useRealTimers(); }
  });

  it("a socket cut after the request was written may have reached the model: booked at the worst case as an estimate, once, never repeated", async () => {
    const w = world({ reply: () => Promise.reject(new TypeError("fetch failed")) });
    await expect(callWithDeadline((input) => tierReviewTask.run({ taskId: "t1" }, () => w.built.call(input)), { model: undefined, prompt: PROMPT, purpose: "code_review" }, 10_000)).rejects.toBeInstanceOf(TierReviewNoRetry);
    expect(w.posts, "one request").toHaveLength(1);
    expect(w.booked).toHaveLength(1);
    expect((w.booked[0] as { entryId: string; payload: { costUsd: number } }).entryId).toContain("tier-review:estimate:");
    expect((w.booked[0] as { payload: { costUsd: number } }).payload.costUsd).toBeGreaterThan(0);
  });

  it("a connection refused before anything was sent is tried once more, and books nothing", async () => {
    vi.useFakeTimers();
    try {
      const w = world({ reply: () => Promise.reject(new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } })) });
      const done = callWithDeadline((input) => tierReviewTask.run({ taskId: "t1" }, () => w.built.call(input)), { model: undefined, prompt: PROMPT, purpose: "code_review" }, 60_000);
      const assertion = expect(done).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(5_000);
      await assertion;
      expect(w.posts).toHaveLength(2);
      expect(w.booked).toHaveLength(0);
    } finally { vi.useRealTimers(); }
  });

  it("a 502 may come after the model was called: booked at the gateway's figure, once, never repeated", async () => {
    const w = world({ reply: () => new Response("{}", { status: 502, headers: { "x-rovara-cost-usd": "0.0123" } }) });
    await expect(callWithDeadline((input) => tierReviewTask.run({ taskId: "t1" }, () => w.built.call(input)), { model: undefined, prompt: PROMPT, purpose: "code_review" }, 10_000)).rejects.toBeInstanceOf(TierReviewNoRetry);
    expect(w.posts).toHaveLength(1);
    expect(w.booked).toHaveLength(1);
    expect((w.booked[0] as { payload: { costUsd: number } }).payload.costUsd).toBeCloseTo(0.0123, 6);
  });

  it("a 422 is the spending limit only by its code: budget_exceeded for the task or company is; the grant's own refusal (Key=reviewer) or an unreadable one is an unsupported source, never retried", async () => {
    const limit = world({ reply: () => Response.json({ error: { type: "budget_exceeded", message: "Budget has been exceeded! Key=task" } }, { status: 422 }) });
    await expect(limit.run()).rejects.toBeInstanceOf(TierReviewCapError);
    const grant = world({ reply: () => Response.json({ error: { type: "budget_exceeded", message: "Budget has been exceeded! Key=reviewer" } }, { status: 422 }) });
    await expect(grant.run()).rejects.toBeInstanceOf(TierReviewUnsupported);
    const unreadable = world({ reply: () => new Response("nope", { status: 422 }) });
    await expect(unreadable.run()).rejects.toBeInstanceOf(TierReviewUnsupported);
    expect([limit, grant, unreadable].flatMap((w) => w.booked)).toHaveLength(0);
  });

  it("a failed booking survives a restart: a new adapter over the same store still refuses the task's next call until it is booked", async () => {
    const shared = rowsStore();
    let failing = true;
    const first = world({ store: shared.store, booking: async () => { if (failing) throw new Error("ledger down"); return true; } });
    await expect(first.run()).rejects.toBeInstanceOf(TierReviewNoRetry);
    const restarted = world({ store: shared.store, booking: async () => { if (failing) throw new Error("ledger down"); return true; } });
    expect(await restarted.built.meter({ taskId: "t1", purpose: "code_review", model: undefined, promptChars: 10, prompt: PROMPT })).toBe("unavailable");
    failing = false;
    expect(await restarted.built.meter({ taskId: "t1", purpose: "code_review", model: undefined, promptChars: 10, prompt: PROMPT })).toBe(true);
    expect([...shared.rows.keys()], "the row is gone once booked").toEqual([]);
  });

  it("keeps a booking that failed and refuses the task's next call until it is booked", async () => {
    let failing = true;
    const booked: unknown[] = [];
    const w = world({ booking: async (report) => { if (failing) throw new Error("ledger down"); booked.push(report); return true; } });
    await expect(w.run()).rejects.toBeInstanceOf(TierReviewNoRetry);
    expect(await w.built.meter({ taskId: "t1", purpose: "code_review", model: undefined, promptChars: 10, prompt: PROMPT }), "the ledger cannot say what the task spent: nothing more is paid").toBe("unavailable");
    failing = false;
    expect(await w.built.meter({ taskId: "t1", purpose: "code_review", model: undefined, promptChars: 10, prompt: PROMPT }), "booked now: the task may go on").toBe(true);
    expect(booked).toHaveLength(1);
  });
});
