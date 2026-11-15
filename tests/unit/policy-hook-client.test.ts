// Lane H: the HTTP sender. A forged yes, a yes replayed for another task, an expired answer, an answer for another question or kind, an unsigned one, a
// failing or silent service: each is no answer. The audit line carries ids and fixed words only, never the question or answer text.
import { describe, expect, it } from "vitest";
import { createPolicyHookClient } from "../../packages/broker/src/core/policy-hook/client.js";
import { policyHookQuestionHash, readPolicyHookQuestion } from "../../packages/contracts/src/index.js";
import { ADDRESS, COMPANY, ISSUER, fakeService, makeKey, memoryAudit, settingsFor, signAnswer, signerOf } from "./policy-hook-fixture.js";

const install = makeKey("install-key-1");
const hookKey = makeKey("hook-key-1");
const nextKey = makeKey("hook-key-2");
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
  it("signs the question with the install key and posts it to the address; a signed, bound answer is believed", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const service = fakeService({ key: hookKey, now: () => T0, answer: () => ({ allow: true }) });
    const { c } = client(async (url, init) => { calls.push({ url: typeof url === "string" ? url : url instanceof URL ? url.href : url.url, init }); return service.fetch(url, init); });
    const prepared = (await c.prepare("start", start("task_1")))!;
    const read = readPolicyHookQuestion(prepared.text, T0 / 1000)!;
    expect(read.claims).toMatchObject({ v: 1, iss: ISSUER, kind: "start", rid: prepared.requestId, exp: read.claims.iat + 360, q: start("task_1") });
    expect(read.kid).toBe("install-key-1");
    expect(await c.send(prepared)).toEqual({ answered: true, answer: { allow: true }, expiresAt: (T0 / 1000 + 60) * 1000 });
    expect(calls[0]!.url).toBe(ADDRESS);
    expect(calls[0]!.init).toMatchObject({ method: "POST", redirect: "error", body: prepared.text });
  });

  it("a forged yes (signed by a key that is not pinned, even with the pinned kid) is no answer", async () => {
    const service = fakeService({ key: forger, now: () => T0, answer: () => ({ allow: true }) });
    const { c } = client(service.fetch);
    expect(await c.send((await c.prepare("start", start("task_1")))!)).toEqual({ answered: false });
  });

  it("a yes replayed for another task is no answer (bound to the request id and the question)", async () => {
    const service = fakeService({ key: hookKey, now: () => T0, answer: () => ({ allow: true }) });
    const { c } = client(service.fetch);
    const first = (await c.prepare("start", start("task_1")))!;
    const response = await service.fetch(ADDRESS, { method: "POST", body: first.text });
    const savedYes = await response.text();
    const second = (await c.prepare("start", start("task_2")))!;
    const replay: typeof fetch = async () => new Response(savedYes, { status: 200 });
    const { c: replayed } = client(replay);
    expect(await replayed.send(second)).toEqual({ answered: false });
    expect(await replayed.send(first)).toMatchObject({ answered: true });
  });

  it("an answer for the same request id but another question text is no answer", async () => {
    const service = fakeService({ key: hookKey, now: () => T0, answer: () => ({ allow: true }), mutate: (claims) => ({ ...claims, qh: policyHookQuestionHash("another question") }) });
    const { c } = client(service.fetch);
    expect(await c.send((await c.prepare("start", start("task_1")))!)).toEqual({ answered: false });
  });

  it("an expired answer, one issued in the future, or one living over 300 s is no answer", async () => {
    for (const mutate of [
      (claims: Record<string, unknown>) => ({ ...claims, iat: T0 / 1000 - 120, exp: T0 / 1000 - 60 }),
      (claims: Record<string, unknown>) => ({ ...claims, iat: T0 / 1000 + 31, exp: T0 / 1000 + 90 }),
      (claims: Record<string, unknown>) => ({ ...claims, exp: Number(claims["iat"]) + 301 }),
      (claims: Record<string, unknown>) => ({ ...claims, exp: claims["iat"] }),
    ]) {
      const service = fakeService({ key: hookKey, now: () => T0, answer: () => ({ allow: true }), mutate });
      const { c } = client(service.fetch);
      expect(await c.send((await c.prepare("start", start("task_1")))!)).toEqual({ answered: false });
    }
  });

  it("an answer of another kind, with an unknown field, or unsigned is no answer", async () => {
    const cases = [
      (claims: Record<string, unknown>) => ({ ...claims, kind: "values", a: { locks: {} } }),
      (claims: Record<string, unknown>) => ({ ...claims, a: { allow: true, extra: 1 } }),
      (claims: Record<string, unknown>) => ({ ...claims, extra: 1 }),
      (claims: Record<string, unknown>) => `${Buffer.from(JSON.stringify({ alg: "none", typ: "rovara-policy-answer+jwt", kid: "hook-key-1" })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.`,
    ];
    for (const mutate of cases) {
      const service = fakeService({ key: hookKey, now: () => T0, answer: () => ({ allow: true }), mutate });
      const { c } = client(service.fetch);
      expect(await c.send((await c.prepare("start", start("task_1")))!)).toEqual({ answered: false });
    }
  });

  it("either of two pinned keys is believed (rotation); a third is not", async () => {
    const service = fakeService({ key: nextKey, now: () => T0, answer: () => ({ allow: true }) });
    expect(await client(service.fetch, { keys: [hookKey, nextKey] }).c.send((await client(service.fetch, { keys: [hookKey, nextKey] }).c.prepare("start", start("t")))!)).toMatchObject({ answered: true });
    const { c } = client(service.fetch, { keys: [hookKey] });
    expect(await c.send((await c.prepare("start", start("t")))!)).toEqual({ answered: false });
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

  it("a valid answer padded past 8 KiB is no answer (the read stops at the limit)", async () => {
    const service = fakeService({ key: hookKey, now: () => T0, answer: () => ({ allow: true }) });
    const padded: typeof fetch = async (url, init) => new Response(`${await (await service.fetch(url, init)).text()}${" ".repeat(9000)}`, { status: 200 });
    const { c } = client(padded);
    expect(await c.send((await c.prepare("start", start("task_1")))!)).toEqual({ answered: false });
    const short: typeof fetch = async (url, init) => new Response(`${await (await service.fetch(url, init)).text()}${" ".repeat(100)}`, { status: 200 });
    const { c: ok } = client(short);
    expect(await ok.send((await ok.prepare("start", start("task_1")))!)).toMatchObject({ answered: true });
  });

  it("a valid answer under a status other than 200 is no answer", async () => {
    const service = fakeService({ key: hookKey, now: () => T0, answer: () => ({ allow: true }) });
    const wrongStatus: typeof fetch = async (url, init) => new Response(await (await service.fetch(url, init)).text(), { status: 503 });
    const { c } = client(wrongStatus);
    expect(await c.send((await c.prepare("start", start("task_1")))!)).toEqual({ answered: false });
  });

  it("a question that does not fit the contract is never sent", async () => {
    let called = false;
    const { c } = client(async () => { called = true; return new Response("", { status: 500 }); });
    expect(await c.prepare("start", { ...start("task 1") })).toBeUndefined();
    expect(await c.prepare("start", { ...start("t"), cid: "org_not-a-company" })).toBeUndefined();
    expect(await c.prepare("decide", { cid: COMPANY, stage: "verdict", what: "plan", styp: "task", sid: "t", extra: 1 } as never)).toBeUndefined();
    expect(called).toBe(false);
  });

  it("writes one audit line with ids and fixed words, never the question or answer text", async () => {
    const service = fakeService({ key: hookKey, now: () => T0, answer: () => ({ allow: false, code: "over_budget" }) });
    const { c, audit, logs } = client(service.fetch);
    const prepared = (await c.prepare("start", start("task_1")))!;
    const result = await c.send(prepared);
    await c.audit(prepared, { answered: result.answered, allow: false, attempts: 1 });
    expect(audit.events).toEqual([{ eventId: `policy-hook:${prepared.requestId}`, companyId: COMPANY, at: new Date(T0).toISOString(), actor: { type: "system", id: "policy-hook" }, action: "policy_hook.answered", details: { kind: "start", requestId: prepared.requestId, attempts: 1, allow: false } }]);
    const everything = JSON.stringify([audit.events, logs]);
    expect(everything.includes(prepared.text)).toBe(false);
    expect(everything.includes(prepared.text.split(".")[2]!)).toBe(false);
  });
});
