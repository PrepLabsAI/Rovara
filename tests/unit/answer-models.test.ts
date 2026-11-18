// The two model seams of the answer service (lead 4, J1): the laptop adapter over the Ask model path, and the hosted gateway adapter (L4-E builds the gateway side). Also the code source adapter both use.
import { describe, expect, it } from "vitest";
import { AnswerModelRefused, type AnswerModelTurn } from "../../packages/broker/src/core/answers/ports.js";
import { createLocalAnswerModel } from "../../packages/broker/src/local/answer-model.js";
import { AnswersGatewayError, createGatewayAnswerModel, type AnswersGateway } from "../../packages/broker/src/core/answers/gateway-model.js";
import { createAnswerCodeSource, ANSWER_FILE_MAX_BYTES } from "../../packages/broker/src/core/answers/code-source.js";
import type { AskAnswerer } from "../../packages/broker/src/core/sessions/ask.js";

const turn = (over: Partial<AnswerModelTurn> = {}): AnswerModelTurn => ({ system: "rules", transcript: "t".repeat(4_000), maxOutputTokens: 1_500, signal: new AbortController().signal, remainingCents: 15, ...over });
const usage = { input: 1_000, output: 200, cacheRead: 0, cacheWrite: 0, provider: "anthropic", modelId: "m" };
// $3 per million in, $15 per million out.
const prices = { findCap: () => ({ price: { inputMicrosPerMillionTokens: 3_000_000, outputMicrosPerMillionTokens: 15_000_000 }, currency: "USD", origin: "provider" as const }) };

describe("the laptop answer model (the Ask model path)", () => {
  const answerer = (over: Partial<AskAnswerer> = {}): AskAnswerer & { calls: unknown[] } => {
    const calls: unknown[] = [];
    return { calls, available: async () => true, answer: async (input) => { calls.push(input); return { text: "reply", model: "anthropic/m", usage }; }, ...over };
  };

  it("is available only when the Ask model is, and passes the rules as the context and the transcript as the question (no tools)", async () => {
    const ask = answerer();
    const model = createLocalAnswerModel({ answerer: ask, choice: async () => ({ provider: "anthropic", model: "m" }), prices });
    expect(await model.available()).toBe(true);
    expect(await createLocalAnswerModel({ answerer: answerer({ available: async () => false }), choice: async () => undefined }).available()).toBe(false);
    expect(await createLocalAnswerModel({ answerer: answerer({ available: async () => { throw new Error("x"); } }), choice: async () => undefined }).available()).toBe(false);
    const session = await model.open({ companyId: "c", project: "p", personId: "x", answerId: "a", ceilingCents: 15 });
    const reply = await session.complete(turn());
    expect(ask.calls[0]).toMatchObject({ context: "rules", question: "t".repeat(4_000), maxOutputTokens: 1_500, taskId: "answers" });
    // 1,000 in at $3/M and 200 out at $15/M: $0.006 = 0.6 cents, rounded up.
    expect(reply).toEqual({ text: "reply", model: "anthropic/m", tokens: { input: 1_000, output: 200 }, costCents: 1 });
    await session.finish({ tokens: 0 });
  });

  it("a reply that says nothing of its use is charged its worst case, never nothing", async () => {
    const model = createLocalAnswerModel({ answerer: answerer({ answer: async () => ({ text: "reply", model: "anthropic/m" }) }), choice: async () => ({ provider: "anthropic", model: "m" }), prices });
    const session = await model.open({ companyId: "c", project: "p", personId: "x", answerId: "a", ceilingCents: 15 });
    const reply = await session.complete(turn());
    // 1,000 tokens in at $3/M plus 1,500 out at $15/M is 2.55 cents at the worst.
    expect(reply.costCents).toBe(3);
    expect(reply.tokens).toBeUndefined();
  });

  it("refuses a turn whose worst case is over what is left, before the model is called", async () => {
    const ask = answerer();
    const model = createLocalAnswerModel({ answerer: ask, choice: async () => ({ provider: "anthropic", model: "m" }), prices });
    const session = await model.open({ companyId: "c", project: "p", personId: "x", answerId: "a", ceilingCents: 15 });
    // 1,000 tokens in plus 1,500 out at those prices is 2.5 cents at the worst.
    await expect(session.complete(turn({ remainingCents: 1 }))).rejects.toMatchObject({ reason: "over_budget" });
    expect(ask.calls).toEqual([]);
    await expect(session.complete(turn({ remainingCents: 3 }))).resolves.toMatchObject({ text: "reply" });
  });

  it("a model with no price is not refused on money (the token ceiling stands in) and its turn has no cost", async () => {
    const ask = answerer();
    const model = createLocalAnswerModel({ answerer: ask, choice: async () => ({ provider: "local", model: "m" }), prices: { findCap: () => undefined } });
    const session = await model.open({ companyId: "c", project: "p", personId: "x", answerId: "a", ceilingCents: 15 });
    const reply = await session.complete(turn({ remainingCents: 0 }));
    expect(reply.costCents).toBeUndefined();
    expect(reply.tokens).toEqual({ input: 1_000, output: 200 });
    // A price that is not in dollars is no price either.
    const other = createLocalAnswerModel({ answerer: ask, choice: async () => ({ provider: "x", model: "m" }), prices: { findCap: () => ({ price: { inputMicrosPerMillionTokens: 1, outputMicrosPerMillionTokens: 1 }, currency: "EUR", origin: "provider" as const }) } });
    expect((await (await other.open({ companyId: "c", project: "p", personId: "x", answerId: "a", ceilingCents: 15 })).complete(turn())).costCents).toBeUndefined();
  });

  it("maps a missing model or key to 'not set up' and any other failure to 'unavailable', never carrying the provider's words", async () => {
    for (const [reason, expected] of [["no_model", "not_set_up"], ["no_credential", "not_set_up"], ["provider_not_set_up", "not_set_up"], ["provider_status_500", "unavailable"], ["timed_out", "unavailable"]] as const) {
      const model = createLocalAnswerModel({ answerer: answerer({ answer: async () => { throw Object.assign(new Error("sk-secret in provider words"), { reason }); } }), choice: async () => ({ provider: "anthropic", model: "m" }) });
      const session = await model.open({ companyId: "c", project: "p", personId: "x", answerId: "a", ceilingCents: 15 });
      const error = await session.complete(turn()).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AnswerModelRefused);
      expect((error as AnswerModelRefused).reason).toBe(expected);
      expect((error as Error).message).not.toContain("secret");
    }
    const none = createLocalAnswerModel({ answerer: answerer(), choice: async () => undefined });
    await expect((await none.open({ companyId: "c", project: "p", personId: "x", answerId: "a", ceilingCents: 15 })).complete(turn())).rejects.toMatchObject({ reason: "not_set_up" });
  });
});

describe("the hosted gateway answer model (the answers purpose, L4-E)", () => {
  function gateway(over: Partial<AnswersGateway> = {}): AnswersGateway & { log: string[] } {
    const log: string[] = [];
    return {
      log,
      available: async () => true,
      reserve: async (input) => { log.push(`reserve:${input.companyId}:${input.project}:${input.personId}:${input.idempotencyKey}:${String(input.ceilingCents)}`); return { reservationId: "res-1" }; },
      call: async (input) => { log.push(`call:${input.reservationId}:${String(input.remainingCents)}`); return { text: "reply", model: "m", costCents: 4, tokens: { input: 10, output: 5 } }; },
      settle: async (input) => { log.push(`settle:${input.reservationId}:${String(input.costCents)}`); },
      ...over,
    };
  }

  it("reserves the ceiling once, calls inside the reservation, and settles once", async () => {
    const g = gateway();
    const model = createGatewayAnswerModel(g, "org_a");
    expect(await model.available()).toBe(true);
    const session = await model.open({ companyId: "org_a", project: "alpha", personId: "ada", answerId: "a1", ceilingCents: 15 });
    await session.complete(turn({ remainingCents: 15 }));
    await session.complete(turn({ remainingCents: 11 }));
    await session.finish({ costCents: 8, tokens: 30 });
    await session.finish({ costCents: 8, tokens: 30 });
    expect(g.log).toEqual(["reserve:org_a:alpha:ada:answer:a1:15", "call:res-1:15", "call:res-1:11", "settle:res-1:8"]);
  });

  it("settles at the gateway's own ceiling when the cost is unknown, and is made for one company only", async () => {
    const g = gateway();
    const model = createGatewayAnswerModel(g, "org_a");
    const session = await model.open({ companyId: "org_a", project: "alpha", personId: "ada", answerId: "a1", ceilingCents: 15 });
    await session.finish({ tokens: 5 });
    expect(g.log.at(-1)).toBe("settle:res-1:undefined");
    await expect(model.open({ companyId: "org_b", project: "alpha", personId: "ada", answerId: "a2", ceilingCents: 15 })).rejects.toMatchObject({ reason: "unavailable" });
    expect(g.log.filter((entry) => entry.startsWith("reserve:"))).toHaveLength(1);
  });

  it("maps the gateway's refusals by name and anything else to 'unavailable'; an unreachable gateway is not available", async () => {
    for (const [thrown, expected] of [[new AnswersGatewayError("over_budget"), "over_budget"], [new AnswersGatewayError("not_set_up"), "not_set_up"], [new Error("boom sk-x"), "unavailable"]] as const) {
      const model = createGatewayAnswerModel(gateway({ reserve: async () => { throw thrown; } }), "org_a");
      await expect(model.open({ companyId: "org_a", project: "p", personId: "x", answerId: "a", ceilingCents: 15 })).rejects.toMatchObject({ reason: expected });
      const called = createGatewayAnswerModel(gateway({ call: async () => { throw thrown; } }), "org_a");
      const session = await called.open({ companyId: "org_a", project: "p", personId: "x", answerId: "a", ceilingCents: 15 });
      await expect(session.complete(turn())).rejects.toMatchObject({ reason: expected });
    }
    expect(await createGatewayAnswerModel(gateway({ available: async () => { throw new Error("down"); } }), "org_a").available()).toBe(false);
    expect(await createGatewayAnswerModel(gateway({ available: async () => false }), "org_a").available()).toBe(false);
  });
});

describe("the code source", () => {
  const host = (log: string[], over: { head?: string; fail?: boolean } = {}) => ({
    baseBranchHead: async (repository: { url: string }, branch: string) => { log.push(`head:${repository.url}:${branch}`); if (over.fail === true) throw new Error("down"); return over.head ?? "a".repeat(40); },
    fileAtRevision: async (repository: { url: string }, path: string, revision: string, _scope: unknown, options?: { untilLine?: number; timeoutMs?: number; maxBytes?: number }) => { log.push(`read:${repository.url}:${path}:${revision.slice(0, 4)}:${String(options?.untilLine)}:${String(options?.maxBytes)}`); return "text"; },
  });
  const handle = (name: string, log: string[], over: { head?: string; fail?: boolean } = {}) => ({ name, defaultBranch: "main", repository: { url: `https://x/${name}.git` }, scope: { orgId: "org_a" }, host: host(log, over) }) as never;

  it("asks each repository's host for its head once per answer, leaves out one that cannot answer, and refuses a head that is not a full hash", async () => {
    const log: string[] = [];
    const source = createAnswerCodeSource([handle("web", log), handle("api", log, { fail: true }), handle("odd", log, { head: "main" })], ["web", "api", "odd", "unreadable"]);
    expect(source.repositories).toEqual(["web", "api", "odd"]);
    // The project's repositories are every one of them, readable or not.
    expect(source.projectRepositories).toEqual(["web", "api", "odd", "unreadable"]);
    expect([...(await source.heads())]).toEqual([["web", "a".repeat(40)]]);
    await source.heads();
    expect(log.filter((entry) => entry.startsWith("head:"))).toHaveLength(3);
  });

  it("reads only the project's repositories, only at a full commit hash, bounded by size", async () => {
    const log: string[] = [];
    const source = createAnswerCodeSource([handle("web", log)], ["web"]);
    expect(await source.read("web", "src/a.ts", "a".repeat(40), { untilLine: 9, timeoutMs: 100 })).toBe("text");
    expect(await source.read("other", "src/a.ts", "a".repeat(40), { timeoutMs: 100 })).toBeUndefined();
    expect(await source.read("web", "src/a.ts", "main", { timeoutMs: 100 })).toBeUndefined();
    expect(log.filter((entry) => entry.startsWith("read:"))).toEqual([`read:https://x/web.git:src/a.ts:aaaa:9:${String(ANSWER_FILE_MAX_BYTES)}`]);
  });
});
