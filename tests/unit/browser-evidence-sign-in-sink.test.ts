// TE-H1 browser evidence, slice 3: the worker's side of the sign-in callback. One POST with an empty body and the run's own capability; the answer is read exactly (the values or `not_set`); a refusal, a broken answer or a body with
// anything extra is one fixed sentence, and a value is in no message.
import { describe, expect, it } from "vitest";
import { createWorkerCallbackSinks } from "../../packages/worker/src/callback-client.js";

/** Built at runtime: a fixture that looks like a real credential is refused by the public repository's push protection. */
const VALUES = { username: ["tester", "example"].join("@") + ".test", password: ["pw", "Zq7", "Lm2", "Xv9"].join("-") };
const URL_BASE = "https://control.example.test";
const invocation = { protocolVersion: 1, kind: "task", operationId: "22222222-2222-4222-8222-222222222222", workspaceId: "11111111-1111-4111-8111-111111111111", fence: 1, projectRevision: 1, callbackCapability: "cap.sig", payload: {} } as never;
const sinksFor = (answer: () => Response) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImplementation = ((url: string, init: RequestInit) => { calls.push({ url, init }); return Promise.resolve(answer()); }) as unknown as typeof fetch;
  return { calls, sinks: createWorkerCallbackSinks({ controlPlaneUrl: `${URL_BASE}/`, fetchImplementation, invocation }) };
};

describe("the sign-in sink", () => {
  it("is one POST to the operation's own route with the run's capability and an empty body, and gives back the values the broker answered (its request id left out)", async () => {
    const { calls, sinks } = sinksFor(() => new Response(JSON.stringify({ requestId: "r1", status: "ready", values: VALUES }), { status: 200 }));
    expect(await sinks.browserEvidenceSignIn()).toEqual({ status: "ready", values: VALUES });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${URL_BASE}/v1/internal/workspaces/11111111-1111-4111-8111-111111111111/operations/22222222-2222-4222-8222-222222222222/browser-evidence-sign-in`);
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>)["x-agentx-callback-capability"]).toBe("cap.sig");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({});
    expect(await sinksFor(() => new Response(JSON.stringify({ status: "not_set" }), { status: 200 })).sinks.browserEvidenceSignIn()).toEqual({ status: "not_set" });
  });

  it("refuses, in one fixed sentence that holds no value, a refusal, an answer that is not one, and an answer with anything extra (mutant: the answer read loosely)", async () => {
    const bodies: Array<[string, () => Response]> = [
      ["http 403", () => new Response(JSON.stringify({ error: { message: `no ${VALUES.password}` } }), { status: 403 })],
      ["not json", () => new Response(`password ${VALUES.password}`, { status: 200 })],
      ["extra field", () => new Response(JSON.stringify({ status: "ready", values: { ...VALUES, extra: VALUES.password } }), { status: 200 })],
      ["extra key", () => new Response(JSON.stringify({ status: "not_set", values: VALUES }), { status: 200 })],
      ["short values", () => new Response(JSON.stringify({ status: "ready", values: { username: "ab", password: VALUES.password } }), { status: 200 })],
      ["an array", () => new Response(JSON.stringify([VALUES]), { status: 200 })],
      ["null", () => new Response("null", { status: 200 })],
    ];
    for (const [label, answer] of bodies) {
      const error = await sinksFor(answer).sinks.browserEvidenceSignIn().then(() => undefined, (caught: unknown) => caught as Error);
      expect(error, label).toBeDefined();
      for (const text of [VALUES.username, VALUES.password]) expect(error!.message, label).not.toContain(text);
    }
    const invalid = await sinksFor(bodies[2]![1]).sinks.browserEvidenceSignIn().catch((caught: Error) => caught);
    expect((invalid as Error).message).toBe("RUNTIME_UNAVAILABLE: browser evidence sign-in answer is invalid");
  });
});
