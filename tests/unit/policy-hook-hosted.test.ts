import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HostedPolicyHookSettingsSchema, PolicyHookSettingsSchema, POLICY_HOOK_WORDS, policyHookKeyThumbprint,
} from "../../packages/contracts/src/policy-hook.js";
import { createHostedPolicyHookClient } from "../../packages/broker/src/core/policy-hook/hosted.js";
import { withPolicyHookAdmission } from "../../packages/broker/src/core/policy-hook/admission.js";
import { ADDRESS, COMPANY, ISSUER, fakeService, makeKey, settingsFor, signerOf } from "./policy-hook-fixture.js";

const key = makeKey("hook");
const foreign = makeKey("foreign");
const install = { issuer: ISSUER, signer: signerOf(makeKey("install")) };
const settings = { address: ADDRESS, jwks: "https://rules.example/keys", thumbprints: [policyHookKeyThumbprint(key.jwk)] };
const question = { cid: COMPANY, pid: "demo", tid: "task-1" };
const json = (keys: unknown[]) => new Response(JSON.stringify({ keys }));

afterEach(() => { vi.useRealTimers(); });

describe("hosted policy-hook settings", () => {
  it("keeps the config-file schema inline and makes hosted settings strict", () => {
    expect(PolicyHookSettingsSchema.safeParse(settingsFor(key)).success).toBe(true);
    expect(PolicyHookSettingsSchema.safeParse(settings).success).toBe(false);
    expect(HostedPolicyHookSettingsSchema.safeParse(settings).success).toBe(true);
    expect(HostedPolicyHookSettingsSchema.safeParse({ ...settings, thumbprints: [...settings.thumbprints, policyHookKeyThumbprint(foreign.jwk)] }).success).toBe(true);
    for (const bad of [
      settingsFor(key), { ...settings, extra: true }, { ...settings, keys: [key.jwk] },
      { ...settings, thumbprints: [] }, { ...settings, thumbprints: ["a".repeat(42)] },
      { ...settings, thumbprints: ["+".repeat(43)] }, { ...settings, thumbprints: ["a".repeat(43), "b".repeat(43), "c".repeat(43)] },
      { ...settings, thumbprints: [...settings.thumbprints, ...settings.thumbprints] },
    ]) expect(HostedPolicyHookSettingsSchema.safeParse(bad).success).toBe(false);
    for (const field of ["address", "jwks"]) {
      for (const url of ["http://rules.example/keys", "http://localhost/keys", "https://user:password@rules.example/keys", "https://rules.example/keys?secret=x", "https://rules.example/keys#x", `https://rules.example/${"a".repeat(200)}`, "bad"]) {
        expect(HostedPolicyHookSettingsSchema.safeParse({ ...settings, [field]: url }).success).toBe(false);
      }
    }
  });

  it("matches the published RFC 7638 section 3.1 example thumbprint", () => {
    // RFC 7638 section 3.1: the RSA key of RFC 7517 appendix A.1, and its published SHA-256 JWK thumbprint.
    const n = "0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw";
    expect(policyHookKeyThumbprint({ kty: "RSA", e: "AQAB", n })).toBe("NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs");
  });

  it("hashes only e, kty, n in RFC 7638 lexicographic order", () => {
    const canonical = `{"e":"${key.jwk.e}","kty":"RSA","n":"${key.jwk.n}"}`;
    const expected = createHash("sha256").update(canonical).digest("base64url");
    expect(policyHookKeyThumbprint(key.jwk)).toBe(expected);
    expect(policyHookKeyThumbprint({ ...key.jwk, kid: "changed" })).toBe(expected);
  });
});

function world(jwks: typeof fetch, answeringKey = key, hostedSettings = settings) {
  let time = 1_800_000_000_000;
  const now = () => time;
  const service = fakeService({ key: answeringKey, now, answer: () => ({ allow: true }) });
  const get = vi.fn(jwks);
  const post = vi.fn(service.fetch);
  const log = vi.fn();
  const fetcher: typeof fetch = (url, init) => init?.method === "GET" ? get(url, init) : post(url, init);
  const client = createHostedPolicyHookClient(hostedSettings, install, { fetch: fetcher, now, log });
  const send = async () => {
    const prepared = await client.prepare("start", question);
    expect(prepared).toBeDefined();
    return await client.send(prepared!);
  };
  return { client, get, post, log, send, advance: (ms: number) => { time += ms; } };
}

describe("hosted pinned JWKS resolution", () => {
  it("accepts a matching key, ignores extra and malformed keys, and caches for five minutes", async () => {
    const w = world(async () => json([foreign.jwk, { ...key.jwk, d: "private" }, { ...key.jwk, alg: "HS256" }, key.jwk]));
    expect(w.get).not.toHaveBeenCalled();
    expect(await w.send()).toMatchObject({ answered: true, answer: { allow: true } });
    w.advance(299_999);
    expect(await w.send()).toMatchObject({ answered: true });
    expect(w.get).toHaveBeenCalledTimes(1);
    expect(w.get).toHaveBeenCalledWith(settings.jwks, expect.objectContaining({ method: "GET", redirect: "error", signal: expect.any(AbortSignal) }));
    w.advance(1);
    expect(await w.send()).toMatchObject({ answered: true });
    expect(w.get).toHaveBeenCalledTimes(2);
  });

  it("accepts either pinned key during rotation", async () => {
    const rotation = { ...settings, thumbprints: [policyHookKeyThumbprint(key.jwk), policyHookKeyThumbprint(foreign.jwk)] };
    for (const answeringKey of [key, foreign]) {
      const w = world(async () => json([key.jwk, foreign.jwk]), answeringKey, rotation);
      expect(await w.send()).toMatchObject({ answered: true });
    }
  });

  it("rejects an answer signed by an unpinned key even when that key is in the JWKS", async () => {
    const w = world(async () => json([key.jwk, foreign.jwk]), foreign);
    expect(await w.send()).toEqual({ answered: false });
  });

  it.each([
    ["zero matches", () => json([foreign.jwk])],
    ["invalid matching key", () => json([{ ...key.jwk, alg: "HS256" }])],
    ["empty keys", () => json([])],
    ["fetch error", () => { throw new Error("https://secret.example/?key=private"); }],
    ["bad JSON", () => new Response("{")],
    ["wrong shape", () => new Response('{"keys":{}}')],
    ["null", () => new Response("null")],
    ["redirect", () => new Response("", { status: 302, headers: { location: "https://other.example/keys" } })],
    ["followed redirect", () => { const response = json([key.jwk]); Object.defineProperty(response, "redirected", { value: true }); return response; }],
    ["status", () => new Response("", { status: 503 })],
    ["oversize", () => new Response(JSON.stringify({ keys: [key.jwk], extra: "x".repeat(65_536) }))],
  ])("makes %s unavailable with fixed logging and no answer request", async (_name, response) => {
    const w = world(async () => response());
    expect(await w.send()).toEqual({ answered: false });
    expect(w.post).not.toHaveBeenCalled();
    expect(w.log.mock.calls).toEqual([[{ component: "policy-hook", event: "jwks.unavailable" }]]);
  });

  it("caps streamed bytes even without Content-Length and cancels the body", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(32_768)); controller.enqueue(new Uint8Array(32_769)); }, cancel });
    const w = world(async () => new Response(body));
    expect(await w.send()).toEqual({ answered: false });
    expect(cancel).toHaveBeenCalled();
  });

  it("accepts exactly 64 KiB", async () => {
    const text = JSON.stringify({ keys: [key.jwk] });
    const w = world(async () => new Response(text.padEnd(65_536)));
    expect(await w.send()).toMatchObject({ answered: true });
  });

  it.each(["headers", "body"])("times out stalled %s at two seconds", async (phase) => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const cancel = vi.fn();
    const w = world(async (_url, init) => {
      signal = init?.signal ?? undefined;
      if (phase === "headers") return await new Promise<Response>(() => undefined);
      return new Response(new ReadableStream<Uint8Array>({ cancel }));
    });
    const result = w.send();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(w.log).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toEqual({ answered: false });
    expect(signal?.aborted).toBe(true);
    expect(w.post).not.toHaveBeenCalled();
    if (phase === "body") expect(cancel).toHaveBeenCalled();
  });

  it("shares an in-flight lookup and refuses expired keys after a failed refresh, then recovers", async () => {
    let fail = false;
    const w = world(async () => { if (fail) throw new Error("offline"); return json([key.jwk]); });
    expect(await Promise.all([w.send(), w.send()])).toMatchObject([{ answered: true }, { answered: true }]);
    expect(w.get).toHaveBeenCalledTimes(1);
    fail = true;
    w.advance(300_000);
    expect(await w.send()).toEqual({ answered: false });
    expect(await w.send()).toEqual({ answered: false });
    expect(w.post).toHaveBeenCalledTimes(2);
    fail = false;
    expect(await w.send()).toMatchObject({ answered: true });
  });

  it("uses the existing fixed unavailable words at admission", async () => {
    const w = world(async () => json([foreign.jwk]));
    const base = { admit: async () => ({ allowed: true }), stage: async () => ({ decision: { allowed: true }, items: [] }), release: async () => undefined, settle: async () => undefined };
    const admission = withPolicyHookAdmission(base, w.client, { holdMs: 0 });
    expect(await admission.admit({ companyId: COMPANY, idempotencyKey: "k", action: "task.start", projectName: "demo", subject: { type: "task", id: "task-1" } })).toMatchObject({ allowed: false, message: POLICY_HOOK_WORDS.startNoAnswer });
  });
});
