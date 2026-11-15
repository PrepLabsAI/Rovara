// TE-F1c: the laptop's in-process forwarder: resolve the row's host, refuse any answer that is private, loopback, link-local or reserved (on EVERY call: the rebinding test), connect to the address it checked with the row's host as
// the TLS name, https and port 443 only, no redirect followed. Every test runs under the network tripwire with the lookup and the request injected: nothing here can reach a real host.
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installNetworkTripwire, type NetworkTripwire } from "../../packages/testing/src/ports/no-network.js";
import { EgressSsrfError, EgressUnreachableError, createLaptopTransport, type LaptopHttpsRequest } from "../../packages/broker/src/local/model-egress/forwarder.js";

let tripwire: NetworkTripwire;
beforeEach(() => { tripwire = installNetworkTripwire(); });
afterEach(() => { tripwire.restore(); expect(tripwire.attempts).toEqual([]); });

const enc = (text: string) => new TextEncoder().encode(text);
const outbound = (over: Record<string, unknown> = {}) => ({ host: "generativelanguage.googleapis.com", method: "POST" as const, path: "/v1beta/models/m:generateContent", query: "alt=sse", headers: [["content-type", "application/json"], ["x-goog-api-key", "k".repeat(20)]] as ReadonlyArray<readonly [string, string]>, body: enc("{\"a\":1}"), ...over });

interface Seen { options: Record<string, unknown>; written: string[]; destroyed: boolean }
/** A fake `https.request`: records the options and the body, answers with the given status, headers and body parts. */
function fakeRequest(answer: { status?: number; headers?: Record<string, string>; parts?: string[]; error?: boolean } = {}): { request: LaptopHttpsRequest; seen: Seen[] } {
  const seen: Seen[] = [];
  const request: LaptopHttpsRequest = ((options: Record<string, unknown>, callback: (response: unknown) => void) => {
    const entry: Seen = { options, written: [], destroyed: false };
    seen.push(entry);
    const emitter = new EventEmitter() as EventEmitter & { write(chunk: Uint8Array): boolean; end(chunk?: Uint8Array): void; destroy(): void };
    emitter.write = (chunk) => { entry.written.push(Buffer.from(chunk).toString()); return true; };
    emitter.end = (chunk) => {
      if (chunk !== undefined) entry.written.push(Buffer.from(chunk).toString());
      queueMicrotask(() => {
        if (answer.error === true) { emitter.emit("error", new Error("socket hang up")); return; }
        const response = Object.assign((async function* () { for (const part of answer.parts ?? ["{}"]) yield Buffer.from(part); })(), { statusCode: answer.status ?? 200, headers: answer.headers ?? { "content-type": "application/json" }, destroy() { /* ok */ } });
        callback(response);
      });
    };
    emitter.destroy = () => { entry.destroyed = true; };
    return emitter;
  }) as unknown as LaptopHttpsRequest;
  return { request, seen };
}
const PUBLIC = "142.250.80.42";
const drain = async (response: { body: AsyncIterable<Uint8Array> }): Promise<string> => { let text = ""; for await (const part of response.body) text += Buffer.from(part).toString(); return text; };

describe("where a call goes", () => {
  it("resolves the fully qualified name, connects to the address it checked with the row's host as the TLS name, over https on 443", async () => {
    const asked: string[] = [];
    const { request, seen } = fakeRequest({ parts: ["{\"ok\":", "true}"] });
    const transport = createLaptopTransport({ lookup: async (name) => { asked.push(name); return [PUBLIC]; }, request });
    const response = await transport(outbound());
    expect(await drain(response)).toBe("{\"ok\":true}");
    expect(response.status).toBe(200);
    expect(asked).toEqual(["generativelanguage.googleapis.com."]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.options).toMatchObject({ host: PUBLIC, port: 443, servername: "generativelanguage.googleapis.com", method: "POST", path: "/v1beta/models/m:generateContent?alt=sse", agent: false });
    expect(seen[0]!.options.rejectUnauthorized).not.toBe(false);
    expect((seen[0]!.options.headers as Record<string, string>).host).toBe("generativelanguage.googleapis.com");
    expect(seen[0]!.written.join("")).toBe("{\"a\":1}");
  });
  it("sends the credential header it was given and nothing it was not", async () => {
    const { request, seen } = fakeRequest();
    await createLaptopTransport({ lookup: async () => [PUBLIC], request })(outbound());
    const sent = seen[0]!.options.headers as Record<string, string>;
    expect(Object.keys(sent).sort()).toEqual(["content-length", "content-type", "host", "x-goog-api-key"]);
  });
  it("refuses a private, loopback, link-local, reserved or mapped answer, and an answer with ANY such address among public ones", async () => {
    for (const bad of ["10.0.0.5", "127.0.0.1", "169.254.169.254", "192.168.1.1", "172.16.0.9", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fc00::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "224.0.0.1", "not-an-address"]) {
      const { request, seen } = fakeRequest();
      await expect(createLaptopTransport({ lookup: async () => [bad], request })(outbound()), bad).rejects.toBeInstanceOf(EgressSsrfError);
      await expect(createLaptopTransport({ lookup: async () => [PUBLIC, bad], request })(outbound()), `mixed ${bad}`).rejects.toBeInstanceOf(EgressSsrfError);
      expect(seen, bad).toHaveLength(0);
    }
    const { request } = fakeRequest();
    await expect(createLaptopTransport({ lookup: async () => [], request })(outbound())).rejects.toBeInstanceOf(EgressSsrfError);
  });
  it("REBINDING: the first answer is public and the second is private: the second call is refused and connects to nothing", async () => {
    const answers = [[PUBLIC], ["10.0.0.5"]];
    const { request, seen } = fakeRequest();
    const transport = createLaptopTransport({ lookup: async () => answers.shift() ?? ["10.0.0.5"], request });
    expect((await transport(outbound())).status).toBe(200);
    await expect(transport(outbound())).rejects.toBeInstanceOf(EgressSsrfError);
    expect(seen).toHaveLength(1);
  });
  it("never resolves a second time to connect: the connection uses the checked address", async () => {
    let lookups = 0;
    const { request, seen } = fakeRequest();
    await createLaptopTransport({ lookup: async () => { lookups += 1; return [lookups === 1 ? PUBLIC : "10.9.9.9"]; }, request })(outbound());
    expect(lookups).toBe(1);
    expect(seen[0]!.options.host).toBe(PUBLIC);
    expect(seen[0]!.options).not.toHaveProperty("lookup");
  });
  it("refuses a host that is not a plain public name before any lookup: an address, a port, a path, an upper-case or a denied name", async () => {
    for (const host of ["127.0.0.1", "169.254.169.254", "[::1]", "api.openai.com:8443", "api.openai.com/x", "API.OPENAI.COM", "a b.example", "localhost", "evil.amazonaws.com", "xyz.lambda-url.on.aws", ""]) {
      let looked = false;
      const { request, seen } = fakeRequest();
      await expect(createLaptopTransport({ lookup: async () => { looked = true; return [PUBLIC]; }, request })(outbound({ host })), host).rejects.toBeInstanceOf(EgressSsrfError);
      expect(looked, host).toBe(false);
      expect(seen).toHaveLength(0);
    }
  });
  it("does not follow a redirect: the 3xx is handed back as it is and no second request is made", async () => {
    const { request, seen } = fakeRequest({ status: 302, headers: { location: "https://evil.example/x" } });
    const response = await createLaptopTransport({ lookup: async () => [PUBLIC], request })(outbound());
    expect(response.status).toBe(302);
    await drain(response);
    expect(seen).toHaveLength(1);
  });
});

describe("faults and limits", () => {
  it("a connection failure is 'unreachable', and a lookup failure too; neither carries the system's words", async () => {
    const a = fakeRequest({ error: true });
    const failure = await createLaptopTransport({ lookup: async () => [PUBLIC], request: a.request })(outbound()).then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(EgressUnreachableError);
    expect(String((failure as Error).message)).not.toMatch(/hang up/u);
    const b = fakeRequest();
    const failure2 = await createLaptopTransport({ lookup: async () => { throw new Error("getaddrinfo ENOTFOUND secret-host"); }, request: b.request })(outbound()).then(() => undefined, (error: unknown) => error);
    expect(failure2).toBeInstanceOf(EgressUnreachableError);
    expect(String((failure2 as Error).message)).not.toMatch(/secret-host/u);
  });
  it("stops reading a response past its limit", async () => {
    const { request } = fakeRequest({ parts: ["aaaa", "bbbb", "cccc"] });
    const response = await createLaptopTransport({ lookup: async () => [PUBLIC], request, responseBytesMax: 6 })(outbound());
    await expect(drain(response)).rejects.toBeInstanceOf(EgressUnreachableError);
  });
  it("destroys the request when the call is aborted", async () => {
    const { request, seen } = fakeRequest({ parts: [] });
    const controller = new AbortController();
    const transport = createLaptopTransport({ lookup: async () => [PUBLIC], request });
    controller.abort();
    await expect(transport(outbound(), controller.signal)).rejects.toBeInstanceOf(EgressUnreachableError);
    expect(seen.every((entry) => entry.destroyed) || seen.length === 0).toBe(true);
  });
});
