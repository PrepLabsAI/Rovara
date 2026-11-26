// The model seam of the answer service (lead 4, J1): the hosted gateway adapter (L4-E builds the gateway side). Also the code source adapter it uses.
import { describe, expect, it } from "vitest";
import type { AnswerModelTurn } from "../../packages/broker/src/core/answers/ports.js";
import { AnswersGatewayError, createGatewayAnswerModel, type AnswersGateway } from "../../packages/broker/src/core/answers/gateway-model.js";
import { createAnswerCodeSource, ANSWER_FILE_MAX_BYTES } from "../../packages/broker/src/core/answers/code-source.js";

const turn = (over: Partial<AnswerModelTurn> = {}): AnswerModelTurn => ({ system: "rules", transcript: "t".repeat(4_000), maxOutputTokens: 1_500, signal: new AbortController().signal, remainingCents: 15, ...over });

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

  it("reads only the project's repositories, only at a full commit hash, bounded by size", async () => {
    const log: string[] = [];
    const source = createAnswerCodeSource([handle("web", log)], ["web"]);
    expect(await source.read("web", "src/a.ts", "a".repeat(40), { untilLine: 9, timeoutMs: 100 })).toBe("text");
    expect(await source.read("other", "src/a.ts", "a".repeat(40), { timeoutMs: 100 })).toBeUndefined();
    expect(await source.read("web", "src/a.ts", "main", { timeoutMs: 100 })).toBeUndefined();
    expect(log.filter((entry) => entry.startsWith("read:"))).toEqual([`read:https://x/web.git:src/a.ts:aaaa:9:${String(ANSWER_FILE_MAX_BYTES)}`]);
  });
});
