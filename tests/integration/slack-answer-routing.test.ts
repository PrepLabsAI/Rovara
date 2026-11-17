// Lead 4 J2: where the smart Just answer sits in the Slack routing (DEC 254z). A question, and an unclear message the classifier read cleanly, are answered first; every other kind and every classifier
// failure goes the way it always did; a decline (and a door that throws) is the old path unchanged.
import { describe, expect, it } from "vitest";
import type { RequestRouteKind, RequestRouteOutcome, SlackRequestMessage } from "@agentx/contracts";
import { routeSlackRequest, type RequestRoutingDependencies } from "../../packages/slack-service/src/request-routing.js";

const THREAD = { teamId: "T0AAAAAAA", channelId: "C0BOUND000", threadTs: "1700000000.000100" };
const message = (text = "How long do refunds last?"): SlackRequestMessage => ({ version: 1, eventId: "Ev0ABCDEF123", thread: THREAD, userId: "U0ASKER000", text, receivedAt: "2026-11-17T10:00:00.000Z" });

function setup(route: { kind: RequestRouteKind; outcome: RequestRouteOutcome } | undefined, justAnswer?: RequestRoutingDependencies["justAnswer"]) {
  const calls: string[] = [];
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const deps: RequestRoutingDependencies = {
    ...(route === undefined ? {} : { route: async () => route }),
    offer: async (input) => { calls.push(`offer:${input.suggestion}`); },
    notify: async (_thread, text) => { calls.push(`notify:${text.slice(0, 20)}`); },
    answer: async () => { calls.push("chat"); },
    answered: async () => { calls.push("answered"); },
    finish: async () => { calls.push("finish"); },
    log: (event, fields) => { logs.push({ event, fields: { ...fields } }); },
    ...(justAnswer === undefined ? {} : { justAnswer: async (m) => { calls.push("door"); return justAnswer(m); } }),
  };
  return { run: (text?: string) => routeSlackRequest(message(text), deps), calls, logs };
}

describe("answer first", () => {
  it("a question the door handled is not given to the chat agent, and counts as answered and finished once", async () => {
    const w = setup({ kind: "question", outcome: "ok" }, async () => "handled");
    await w.run();
    expect(w.calls).toEqual(["door", "finish", "answered"]);
  });

  it("an unclear message the classifier read cleanly is answered, with no card", async () => {
    const w = setup({ kind: "unclear", outcome: "ok" }, async () => "handled");
    await w.run("the checkout thing");
    expect(w.calls).toEqual(["door", "finish", "answered"]);
  });

  it("a declined question goes to the chat agent as before", async () => {
    const w = setup({ kind: "question", outcome: "ok" }, async () => "declined");
    await w.run();
    expect(w.calls).toEqual(["door", "chat", "answered"]);
  });

  it("a declined unclear message gets the card as before", async () => {
    const w = setup({ kind: "unclear", outcome: "ok" }, async () => "declined");
    await w.run("the checkout thing");
    expect(w.calls).toEqual(["door", "offer:unclear", "finish", "answered"]);
  });

  it("a door that throws is a decline", async () => {
    const question = setup({ kind: "question", outcome: "ok" }, async () => { throw new Error("boom CANARY"); });
    await question.run();
    expect(question.calls).toEqual(["door", "chat", "answered"]);
    expect(JSON.stringify(question.logs)).not.toContain("CANARY");
    const unclear = setup({ kind: "unclear", outcome: "ok" }, async () => { throw new Error("boom"); });
    await unclear.run("the checkout thing");
    expect(unclear.calls).toEqual(["door", "offer:unclear", "finish", "answered"]);
  });
});

describe("everything else goes the way it always did", () => {
  it.each([
    [{ kind: "small_change", outcome: "ok" }, "offer:small_change"], [{ kind: "large_change", outcome: "ok" }, "offer:large_change"],
    [{ kind: "unclear", outcome: "unavailable" }, "offer:unclear"], [{ kind: "unclear", outcome: "invalid" }, "offer:unclear"], [{ kind: "unclear", outcome: "timeout" }, "offer:unclear"],
  ] as const)("%j never reaches the door", async (route, expected) => {
    const w = setup(route, async () => "handled");
    await w.run("fix the typo in README");
    expect(w.calls).toEqual([expected, "finish", "answered"]);
  });

  it("no classifier at all gets the card, and small talk its fixed reply, without the door", async () => {
    const down = setup(undefined, async () => "handled");
    await down.run("something unclear");
    expect(down.calls).toEqual(["offer:unclear", "finish", "answered"]);
    const hello = setup({ kind: "question", outcome: "ok" }, async () => "handled");
    await hello.run("hello");
    expect(hello.calls[0]).toMatch(/^notify:/u);
    expect(hello.calls).not.toContain("door");
  });

  it("without a door, a question and an unclear message go exactly the old way", async () => {
    const question = setup({ kind: "question", outcome: "ok" });
    await question.run();
    expect(question.calls).toEqual(["chat", "answered"]);
    const unclear = setup({ kind: "unclear", outcome: "ok" });
    await unclear.run("the checkout thing");
    expect(unclear.calls).toEqual(["offer:unclear", "finish", "answered"]);
  });
});
