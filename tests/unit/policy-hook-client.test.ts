// Lane H: the HTTP sender. A forged yes, a yes replayed for another task, an expired answer, an answer for another question or kind, an unsigned one, a
// failing or silent service: each is no answer. The audit line carries ids and fixed words only, never the question or answer text.
import { describe, expect, it } from "vitest";
import { createPolicyHookClient } from "../../packages/broker/src/core/policy-hook/client.js";
import { COMPANY, ISSUER, fakeService, makeKey, memoryAudit, settingsFor, signAnswer, signerOf } from "./policy-hook-fixture.js";

const install = makeKey("install-key-1");
const hookKey = makeKey("hook-key-1");
const forger = makeKey("hook-key-1");
const T0 = 1_800_000_000_000;
const start = (tid: string) => ({ cid: COMPANY, pid: "web", per: "person-1", tid, path: "FULL" as const });

function client(fetch: typeof globalThis.fetch, extra: { now?: () => number; keys?: ReturnType<typeof makeKey>[] } = {}) {
  const audit = memoryAudit();
  const logs: Array<Record<string, unknown>> = [];
  const c = createPolicyHookClient({ settings: settingsFor(...(extra.keys ?? [hookKey])), install: { issuer: ISSUER, signer: signerOf(install) }, fetch, now: extra.now ?? (() => T0), audit: audit.sink, log: (event) => logs.push(event) });
  return { c, audit, logs };
}

describe("policy hook sender", () => {

  it("a forged yes (signed by a key that is not pinned, even with the pinned kid) is no answer", async () => {
    const service = fakeService({ key: forger, now: () => T0, answer: () => ({ allow: true }) });
    const { c } = client(service.fetch);
    expect(await c.send((await c.prepare("start", start("task_1")))!)).toEqual({ answered: false });
  });

  it("a service that fails, throws, times out, redirects or sends too much is no answer", async () => {
    const big = signAnswer(hookKey, { v: 1 }) + "A".repeat(9000);
    for (const fetch of [
      (async () => new Response("down", { status: 503 })) as typeof globalThis.fetch,
      (async () => { throw new Error("connect ECONNREFUSED secret-host"); }) as typeof globalThis.fetch,
      (async () => { throw new DOMException("timeout", "TimeoutError"); }) as typeof globalThis.fetch,
      (async () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example" } })) as typeof globalThis.fetch,
      (async () => new Response(big, { status: 200 })) as typeof globalThis.fetch,
    ]) {
      const { c } = client(fetch);
      expect(await c.send((await c.prepare("start", start("task_1")))!)).toEqual({ answered: false });
    }
  });

  it("an install issuer that is not https is never sent", async () => {
    let called = false;
    const c = createPolicyHookClient({ settings: settingsFor(hookKey), install: { issuer: "http://install-a.example/v1/auth", signer: signerOf(install) }, fetch: async () => { called = true; return new Response("", { status: 500 }); }, now: () => T0 });
    expect(await c.prepare("start", start("task_1"))).toBeUndefined();
    expect(called).toBe(false);
  });

});
