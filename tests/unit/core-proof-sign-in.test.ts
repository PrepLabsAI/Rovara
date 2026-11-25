// The journey proof's one exemption, `signInRefused`, holds exactly a 401 and nothing else (tests/journeys/harness/core-proof.ts).
import { describe, expect, it } from "vitest";
import { createCoreProof } from "../journeys/harness/core-proof.js";

const event = (method: string, rawPath: string) => ({ rawPath, requestContext: { http: { method } } });
const handlerOf = (status: number) => (async () => ({ statusCode: status, headers: {}, body: "{}" })) as never;

describe("CoreProof.signInRefused", () => {
  it("accepts a 401 refused at sign-in, which the core never saw", async () => {
    const proof = createCoreProof();
    const handler = proof.track(handlerOf(401));
    await proof.signInRefused(async () => { const r = await (handler as (e: unknown) => Promise<{ statusCode: number }>)(event("GET", "/v1/dev/tasks/00000000-0000-4000-8000-000000000001")); return { status: r.statusCode }; });
    const person = proof.track(async () => ({ statusCode: 200, headers: {}, body: "{}" }) as never);
    void person;
    expect(proof.seen.map((r) => [r.kind, r.status])).toEqual([["sign-in", 401]]);
  });
  for (const status of [200, 403, 404]) {
    it(`refuses an exempted request that answers ${String(status)} (another company's member answers 404, never 401)`, async () => {
      const proof = createCoreProof();
      const handler = proof.track(handlerOf(status)) as (e: unknown) => Promise<{ statusCode: number }>;
      await proof.signInRefused(async () => { const r = await handler(event("POST", "/v1/dev/tasks/00000000-0000-4000-8000-000000000001/cancel")); return { status: r.statusCode }; });
      expect(() => proof.assertAllCore({ callbacks: false })).toThrow(/must be refused at sign-in/u);
    });
  }
  it("does not exempt a request made outside the wrapper", async () => {
    const proof = createCoreProof();
    const handler = proof.track(handlerOf(401)) as (e: unknown) => Promise<{ statusCode: number }>;
    await handler(event("GET", "/v1/dev/tasks/00000000-0000-4000-8000-000000000001"));
    expect(() => proof.assertAllCore({ callbacks: false })).toThrow(/the old handler answered, not the core/u);
  });
});
