// Test services TS24: the worker refuses a delivered fixture set that is not the pinned one.
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { FixtureSetSchema, canonicalJson, fixtureEntry, fixtureSetDigest, type FixtureSet } from "@rovara-code/contracts";
import { FixtureFetchRefused, fetchFixtureSet } from "../../packages/worker/src/fixture-fetch.js";

const dependency = { id: "payments-api", family: "http:api.example-pay.com", protocol: "http_json", target: "api.example-pay.com" } as const;
const match = { ignorePaths: [] as string[] };
const make = (revision = 1): FixtureSet => FixtureSetSchema.parse({
  schemaVersion: 2, dependency, origin: "written", writtenBy: "Priya", revision, syntheticOnly: true, match,
  entries: [fixtureEntry({ dependency, match }, { method: "GET", path: "/v1/ping", contentType: "", body: "" }, { status: 200, headers: [], contentType: "application/json", body: '{"ok":true}', latencyMs: 0 })], faults: [],
});
const bytesOf = (set: FixtureSet) => new TextEncoder().encode(canonicalJson(set));
const reply = (body: Uint8Array | string, init: ResponseInit = {}) => (() => Promise.resolve(new Response(body, { status: 200, ...init }))) as unknown as typeof fetch;
const refused = async (promise: Promise<unknown>): Promise<string> => { try { await promise; return "accepted"; } catch (error) { return error instanceof FixtureFetchRefused ? error.reason : `other:${String(error)}`; } };

describe("the worker's fixture download", () => {
  const set = make();
  const digest = fixtureSetDigest(set);
  const url = "https://fixtures.invalid/private/org/fixtures/x?sig=abc";

  it("returns the set when the bytes are exactly the pinned one", async () => {
    expect(await fetchFixtureSet({ url, expectedDigest: digest, fetchImpl: reply(bytesOf(set)) })).toEqual(set);
  });
  it("refuses a set whose digest is not the pinned one: other bytes, a swapped revision, a truncated body, a padded body", async () => {
    expect(await refused(fetchFixtureSet({ url, expectedDigest: digest, fetchImpl: reply(bytesOf(make(2))) }))).toBe("digest_mismatch");
    expect(await refused(fetchFixtureSet({ url, expectedDigest: "a".repeat(64), fetchImpl: reply(bytesOf(set)) }))).toBe("digest_mismatch");
    expect(await refused(fetchFixtureSet({ url, expectedDigest: digest, fetchImpl: reply(bytesOf(set).slice(0, 100)) }))).toBe("digest_mismatch");
    expect(await refused(fetchFixtureSet({ url, expectedDigest: digest, fetchImpl: reply(`${canonicalJson(set)}\n`) }))).toBe("digest_mismatch");
  });
  it("refuses bytes that hash to the pinned digest but are not a fixture set", async () => {
    const junk = new TextEncoder().encode('{"nonsense":true}');
    const junkDigest = createHash("sha256").update(junk).digest("hex");
    expect(await refused(fetchFixtureSet({ url, expectedDigest: junkDigest, fetchImpl: reply(junk) }))).toBe("unreadable");
    const notUtf8 = Uint8Array.from([0xff, 0xfe, 0xfd]);
    expect(await refused(fetchFixtureSet({ url, expectedDigest: createHash("sha256").update(notUtf8).digest("hex"), fetchImpl: reply(notUtf8) }))).toBe("unreadable");
  });
  it("refuses a digest that is not 64 hex characters before it asks for anything", async () => {
    let asked = 0;
    const counting = (() => { asked += 1; return Promise.resolve(new Response("x")); }) as unknown as typeof fetch;
    for (const bad of ["", "abc", "G".repeat(64)]) expect(await refused(fetchFixtureSet({ url, expectedDigest: bad, fetchImpl: counting }))).toBe("bad_digest");
    expect(asked).toBe(0);
  });
  it.each(["http://fixtures.invalid/x", "ftp://fixtures.invalid/x", "file:///etc/passwd", "https://user:pass@fixtures.invalid/x", "not a url", "http://10.0.0.1/x"])("refuses the address %s", async (bad) => {
    let asked = 0;
    const counting = (() => { asked += 1; return Promise.resolve(new Response("x")); }) as unknown as typeof fetch;
    expect(await refused(fetchFixtureSet({ url: bad, expectedDigest: digest, fetchImpl: counting }))).toBe("bad_url");
    expect(asked).toBe(0);
  });
  it("never follows a redirect", async () => {
    expect(await refused(fetchFixtureSet({ url, expectedDigest: digest, fetchImpl: reply("", { status: 302, headers: { location: "https://evil.example.com/" } }) }))).toBe("redirect");
  });
  it("refuses an error answer and a missing body", async () => {
    expect(await refused(fetchFixtureSet({ url, expectedDigest: digest, fetchImpl: reply("denied", { status: 403 }) }))).toBe("http_error");
    expect(await refused(fetchFixtureSet({ url, expectedDigest: digest, fetchImpl: () => Promise.reject(new Error("offline")) }))).toBe("http_error");
  });
  it("stops a download over 4 MiB, whether or not the length was declared", async () => {
    const big = new Uint8Array(4 * 1024 * 1024 + 10);
    expect(await refused(fetchFixtureSet({ url, expectedDigest: digest, fetchImpl: reply(big, { headers: { "content-length": String(big.length) } }) }))).toBe("too_large");
    // Five MiB in five chunks with no declared length: over the limit by one chunk, so only the count of bytes read can stop it.
    let sent = 0;
    const finite = new ReadableStream<Uint8Array>({ pull(controller) { if (sent === 5) { controller.close(); return; } sent += 1; controller.enqueue(new Uint8Array(1024 * 1024)); } });
    expect(await refused(fetchFixtureSet({ url, expectedDigest: digest, fetchImpl: () => Promise.resolve(new Response(finite, { status: 200 })) }))).toBe("too_large");
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); } });
    expect(await refused(fetchFixtureSet({ url, expectedDigest: digest, fetchImpl: () => Promise.resolve(new Response(stream, { status: 200 })) }))).toBe("too_large");
  });
  it("stops a download that never ends", async () => {
    const hanging = ((_input: unknown, init?: RequestInit) => new Promise((_resolve, reject) => { init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))); })) as unknown as typeof fetch;
    expect(await refused(fetchFixtureSet({ url, expectedDigest: digest, fetchImpl: hanging, timeoutMs: 30 }))).toBe("timeout");
    const slow = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1])); } });
    expect(await refused(fetchFixtureSet({ url, expectedDigest: digest, fetchImpl: () => Promise.resolve(new Response(slow, { status: 200 })), timeoutMs: 30 }))).toBe("timeout");
  });

  describe("against a real server on loopback", () => {
    let server: Server | undefined;
    afterEach(async () => { await new Promise<void>((resolve) => { if (server === undefined) resolve(); else server.close(() => resolve()); server?.closeAllConnections(); }); server = undefined; });
    const serve = async (handler: Parameters<typeof createServer>[1]) => {
      server = createServer(handler);
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
      return `http://127.0.0.1:${String((server.address() as { port: number }).port)}/fixtures/x`;
    };
    it("refuses http to loopback unless the test-only option is on, and asks nothing", async () => {
      let reached = 0;
      const address = await serve((_request, response) => { reached += 1; response.end(Buffer.from(bytesOf(set))); });
      expect(await refused(fetchFixtureSet({ url: address, expectedDigest: digest }))).toBe("bad_url");
      expect(await refused(fetchFixtureSet({ url: address, expectedDigest: digest, testOnlyAllowLoopbackHttp: false }))).toBe("bad_url");
      expect(reached).toBe(0);
      // Even with the option on, only loopback is allowed over http.
      expect(await refused(fetchFixtureSet({ url: "http://10.0.0.1/x", expectedDigest: digest, testOnlyAllowLoopbackHttp: true }))).toBe("bad_url");
    });
    it("downloads and checks a set", async () => {
      const address = await serve((_request, response) => { response.writeHead(200, { "content-type": "application/json" }); response.end(Buffer.from(bytesOf(set))); });
      expect(await fetchFixtureSet({ url: address, expectedDigest: digest, testOnlyAllowLoopbackHttp: true })).toEqual(set);
    });
    it("does not follow the server's redirect to another address", async () => {
      let reached = 0;
      const target = await serve((_request, response) => { reached += 1; response.end("x"); });
      const second = createServer((_request, response) => { response.writeHead(302, { location: target }); response.end(); });
      await new Promise<void>((resolve) => second.listen(0, "127.0.0.1", () => resolve()));
      try {
        expect(await refused(fetchFixtureSet({ url: `http://127.0.0.1:${String((second.address() as { port: number }).port)}/x`, expectedDigest: digest, testOnlyAllowLoopbackHttp: true }))).toBe("redirect");
        expect(reached).toBe(0);
      } finally { await new Promise<void>((resolve) => { second.close(() => resolve()); second.closeAllConnections(); }); }
    });
  });
});
