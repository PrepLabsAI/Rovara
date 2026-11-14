// Test services, slice 3 (s3-fakes-run): the worker's fixture delivery. It asks the broker for the digest the plan pinned, refuses an answer for another digest, an address that is not https and one that has run out,
// downloads at once and holds the bytes to the digest (the content digest is verified). Every refusal is a fixed word; the address and the broker's words are never in an error.
import { describe, expect, it } from "vitest";
import { FixtureSetSchema, canonicalJson, fixtureEntry, fixtureSetDigest, type FixtureSet } from "@agentx/contracts";
import { FixtureDeliveryRefused, createFixtureDelivery, type FixtureSetCallback } from "../../packages/worker/src/fixture-delivery.js";
import { createWorkerCallbackSinks } from "../../packages/worker/src/callback-client.js";

const dependency = { id: "payments", family: "http:api.example-pay.com", protocol: "http_json", target: "api.example-pay.com" } as const;
const match = { ignorePaths: [] as string[] };
const makeSet = (revision = 1): FixtureSet => FixtureSetSchema.parse({
  schemaVersion: 2, dependency, origin: "written", writtenBy: "Priya", revision, syntheticOnly: true, match,
  entries: [fixtureEntry({ dependency, match }, { method: "GET", path: "/v1/ping", contentType: "", body: "" }, { status: 200, headers: [], contentType: "application/json", body: '{"ok":true}', latencyMs: 0 })], faults: [],
});
const SET = makeSet();
const DIGEST = fixtureSetDigest(SET);
const NOW = Date.parse("2026-11-03T10:00:00.000Z");
const URL_OK = "https://fixtures.example.test/private/org_aaaaaaaaaaaaaaaaaaaa/fixtures/x?X-Amz-Signature=SECRETSIG";
const reply = (over: Record<string, unknown> = {}) => ({ requestId: "r-1", digest: DIGEST, url: URL_OK, expiresAt: new Date(NOW + 900_000).toISOString(), ...over });
const body = (bytes: string, init: ResponseInit = {}) => (() => Promise.resolve(new Response(bytes, { status: 200, ...init }))) as unknown as typeof fetch;
const bytesOf = (set: FixtureSet) => canonicalJson(set);
const make = (callback: FixtureSetCallback, fetchImpl: typeof fetch) => createFixtureDelivery(callback, { fetchImpl, now: () => NOW });
const reasonOf = async (promise: Promise<unknown>): Promise<string> => {
  try { await promise; return "delivered"; } catch (error) {
    expect(error).toBeInstanceOf(FixtureDeliveryRefused);
    expect((error as Error).message).not.toMatch(/SECRETSIG|fixtures\.example|https?:|org_/u);
    return (error as FixtureDeliveryRefused).reason;
  }
};

describe("fetching an approved set", () => {
  it("asks for the pinned digest and nothing else, strips the broker's request id, and returns the set when the bytes are exactly it", async () => {
    const asked: unknown[] = [];
    const delivery = make((request) => { asked.push(request); return Promise.resolve(reply()); }, body(bytesOf(SET)));
    expect(await delivery(DIGEST)).toEqual(SET);
    expect(asked).toEqual([{ digest: DIGEST }]);
  });
  it("verifies the content digest: other bytes, a swapped revision, a truncated body and a padded body are refused", async () => {
    const callback: FixtureSetCallback = () => Promise.resolve(reply());
    expect(await reasonOf(make(callback, body(bytesOf(makeSet(2))))(DIGEST))).toBe("wrong_answer");
    expect(await reasonOf(make(callback, body(bytesOf(SET).slice(0, 100)))(DIGEST))).toBe("wrong_answer");
    expect(await reasonOf(make(callback, body(`${bytesOf(SET)}\n`))(DIGEST))).toBe("wrong_answer");
    expect(await reasonOf(make(callback, body('{"nonsense":true}'))(DIGEST))).toBe("wrong_answer");
  });
  it("refuses an answer for another digest, an address that is not https, a time that is not one, and an address that has run out", async () => {
    const other = "f".repeat(64);
    expect(await reasonOf(make(() => Promise.resolve(reply({ digest: other })), body(bytesOf(SET)))(DIGEST))).toBe("wrong_answer");
    for (const url of ["http://fixtures.example.test/x", "file:///etc/passwd", "ftp://x.invalid/y", "not a url", ""]) expect(await reasonOf(make(() => Promise.resolve(reply({ url })), body(bytesOf(SET)))(DIGEST)), url).toBe("wrong_answer");
    expect(await reasonOf(make(() => Promise.resolve(reply({ expiresAt: "tomorrow" })), body(bytesOf(SET)))(DIGEST))).toBe("wrong_answer");
    expect(await reasonOf(make(() => Promise.resolve(reply({ expiresAt: new Date(NOW - 1).toISOString() })), body(bytesOf(SET)))(DIGEST))).toBe("expired");
    expect(await reasonOf(make(() => Promise.resolve({ ...reply(), extra: 1 }), body(bytesOf(SET)))(DIGEST))).toBe("wrong_answer");
  });
  it("downloads nothing for an answer it refused, and never follows a redirect", async () => {
    let downloads = 0;
    const counting = (() => { downloads += 1; return Promise.resolve(new Response(bytesOf(SET))); }) as unknown as typeof fetch;
    await reasonOf(make(() => Promise.resolve(reply({ digest: "f".repeat(64) })), counting)(DIGEST));
    await reasonOf(make(() => Promise.resolve(reply({ url: "http://x.invalid/y" })), counting)(DIGEST));
    expect(downloads).toBe(0);
    expect(await reasonOf(make(() => Promise.resolve(reply()), body("", { status: 302, headers: { location: "https://evil.example.com/" } }))(DIGEST))).toBe("unavailable");
  });
  it("says 'refused' when the broker refuses (another company's set, a digest outside the plan, a closed task, a withdrawn set read alike), and 'unavailable' when the download fails", async () => {
    expect(await reasonOf(make(() => Promise.reject(new Error("CALLBACK_FORBIDDEN: this operation cannot be given that fixture set")), body(bytesOf(SET)))(DIGEST))).toBe("refused");
    expect(await reasonOf(make(() => Promise.resolve(reply()), () => Promise.reject(new Error("offline")))(DIGEST))).toBe("unavailable");
    expect(await reasonOf(make(() => Promise.resolve(reply()), body("denied", { status: 403 }))(DIGEST))).toBe("unavailable");
  });
  it("refuses a digest that is not 64 hex before it asks anyone, and a stopped run before it asks or downloads", async () => {
    let asked = 0;
    const callback: FixtureSetCallback = () => { asked += 1; return Promise.resolve(reply()); };
    for (const bad of ["", "abc", "G".repeat(64), `${DIGEST} `]) expect(await reasonOf(make(callback, body(bytesOf(SET)))(bad)), bad).toBe("bad_digest");
    const stopped = new AbortController();
    stopped.abort();
    expect(await reasonOf(make(callback, body(bytesOf(SET)))(DIGEST, stopped.signal))).toBe("unavailable");
    expect(asked).toBe(0);
  });
  it("keeps nothing: each fetch asks again, so a set withdrawn after one round is not served in the next", async () => {
    let asks = 0;
    const delivery = make(() => { asks += 1; return asks === 1 ? Promise.resolve(reply()) : Promise.reject(new Error("withdrawn")); }, body(bytesOf(SET)));
    expect(await delivery(DIGEST)).toEqual(SET);
    expect(await reasonOf(delivery(DIGEST))).toBe("refused");
  });
});

describe("the callback itself", () => {
  it("is one POST to the operation's fixture-set route with the run's own capability and a body of the digest alone", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImplementation = ((url: string, init: RequestInit) => { calls.push({ url, init }); return Promise.resolve(new Response(JSON.stringify(reply()), { status: 200 })); }) as unknown as typeof fetch;
    const sinks = createWorkerCallbackSinks({
      controlPlaneUrl: "https://control.example.test/", fetchImplementation,
      invocation: { protocolVersion: 1, kind: "task", operationId: "22222222-2222-4222-8222-222222222222", workspaceId: "11111111-1111-4111-8111-111111111111", fence: 1, projectRevision: 1, callbackCapability: "cap.sig", payload: {} } as never,
    });
    const answer = await sinks.fixtureSet({ digest: DIGEST });
    expect((answer as { digest: string }).digest).toBe(DIGEST);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://control.example.test/v1/internal/workspaces/11111111-1111-4111-8111-111111111111/operations/22222222-2222-4222-8222-222222222222/fixture-set");
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>)["x-agentx-callback-capability"]).toBe("cap.sig");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ digest: DIGEST });
  });
  it("fails with a fixed message when the broker refuses (HTTP 403)", async () => {
    const sinks = createWorkerCallbackSinks({
      controlPlaneUrl: "https://control.example.test", fetchImplementation: () => Promise.resolve(new Response("{}", { status: 403 })),
      invocation: { protocolVersion: 1, kind: "task", operationId: "22222222-2222-4222-8222-222222222222", workspaceId: "11111111-1111-4111-8111-111111111111", fence: 1, projectRevision: 1, callbackCapability: "cap.sig", payload: {} } as never,
    });
    await expect(sinks.fixtureSet({ digest: DIGEST })).rejects.toThrow(/fixture-set failed with HTTP 403/u);
  });
});
