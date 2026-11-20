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
    expect(w.get).toHaveBeenCalledWith(settings.jwks, expect.objectContaining({ method: "GET", redirect: "error", signal: expect.any(AbortSignal) as AbortSignal }));
    w.advance(1);
    expect(await w.send()).toMatchObject({ answered: true });
    expect(w.get).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["wrong shape", () => new Response('{"keys":{}}')],
    ["redirect", () => new Response(JSON.stringify({ keys: [key.jwk] }), { status: 302, headers: { location: "https://other.example/keys" } })],
    ["oversize", () => new Response(JSON.stringify({ keys: [key.jwk], extra: "x".repeat(65_536) }))],
  ])("makes %s unavailable with fixed logging and no answer request", async (_name, response) => {
    const w = world(async () => response());
    expect(await w.send()).toEqual({ answered: false });
    expect(w.post).not.toHaveBeenCalled();
    expect(w.log.mock.calls).toEqual([[{ component: "policy-hook", event: "jwks.unavailable" }]]);
  });

  it.each(["body"])("times out stalled %s at two seconds", async (phase) => {
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

  it("uses the existing fixed unavailable words at admission", async () => {
    const w = world(async () => json([foreign.jwk]));
    const base = { admit: async () => ({ allowed: true }), stage: async () => ({ decision: { allowed: true }, items: [] }), release: async () => undefined, settle: async () => undefined };
    const admission = withPolicyHookAdmission(base as unknown as Parameters<typeof withPolicyHookAdmission>[0], w.client, { holdMs: 0 });
    expect(await admission.admit({ companyId: COMPANY, idempotencyKey: "k", action: "task.start", projectName: "demo", subject: { type: "task", id: "task-1" } })).toMatchObject({ allowed: false, message: POLICY_HOOK_WORDS.startNoAnswer });
  });
});
