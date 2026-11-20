// the runtime every native connector shares. `nativeConnection` is an MCP connection whose tools run in the broker: it lists only the
// approved tools, validates every call's arguments against the tool's schema, and answers text of a bounded size. `vendorFetch` is the only way a tool
// reaches its vendor: one allowed host, https, no redirect, a bounded answer, and no credential in a failure. `safeLookup` refuses a non-public address when
// the connection is made. No test here reaches a network.
import { PassThrough } from "node:stream";
import { CredentialUnavailable, ToolRefusal } from "@agentx/gateway";
import { describe, expect, it, vi } from "vitest";
import { lookupFetch, pinnedLookup } from "../../packages/broker/src/connections/pinned-endpoint.js";
import { NATIVE_TEXT_LIMIT, NativeToolRefusal, nativeConnection, type NativeTool } from "../../packages/broker/src/connectors/native/runtime.js";
import { VendorFetchError, safeLookup, safeVendorFetch, vendorFetch, vendorFetcher } from "../../packages/broker/src/connectors/native/vendor-fetch.js";

const TOKEN = "sntrys_VERYSECRETTOKEN0123456789";

const ROUTING = {
  properties: { organization: { type: "string", minLength: 1 }, projectSlug: { type: "string", minLength: 1 } },
  scopeOf: (values: Record<string, string>) => ({ organization: values["organization"]!, projectSlug: values["projectSlug"]! }),
};
type Scope = ReturnType<typeof ROUTING.scopeOf>;

const echo: NativeTool<Scope> = {
  name: "echo",
  description: "Echoes",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", maxLength: 10 },
      limit: { type: "integer", minimum: 1, maximum: 5 },
      mode: { type: "string", enum: ["a", "b"] },
      items: { type: "array", maxItems: 2, items: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false } },
    },
    required: [],
    additionalProperties: false,
  },
  run: async (args, ctx) => ({ text: `echo ${JSON.stringify(args)} in ${ctx.scope.organization}/${ctx.scope.projectSlug}` }),
};
const big: NativeTool<Scope> = { name: "big", description: "Big", inputSchema: { type: "object", properties: {}, additionalProperties: false }, run: async () => ({ text: "x".repeat(50_000) }) };
const refusing: NativeTool<Scope> = { name: "refusing", description: "Refuses", inputSchema: { type: "object", properties: {}, additionalProperties: false }, run: async () => { throw new NativeToolRefusal("that issue is not in web"); } };
const failing: NativeTool<Scope> = { name: "failing", description: "Fails", inputSchema: { type: "object", properties: {}, additionalProperties: false }, run: async () => { throw new VendorFetchError("the vendor could not be reached"); } };
const crashing: NativeTool<Scope> = { name: "crashing", description: "Crashes", inputSchema: { type: "object", properties: {}, additionalProperties: false }, run: async () => { throw new Error(`boom with ${TOKEN}`); } };
const quoting: NativeTool<Scope> = { name: "quoting", description: "Quotes", inputSchema: { type: "object", properties: {}, additionalProperties: false }, run: async () => { throw new NativeToolRefusal(`the vendor said ${TOKEN}`); } };
const leaking: NativeTool<Scope> = { name: "leaking", description: "Leaks", inputSchema: { type: "object", properties: {}, additionalProperties: false }, run: async () => ({ text: `the vendor echoed ${TOKEN} back` }) };
const straddling: NativeTool<Scope> = { name: "straddling", description: "Straddles", inputSchema: { type: "object", properties: {}, additionalProperties: false }, run: async () => ({ text: `${"x".repeat(NATIVE_TEXT_LIMIT - 22)}${TOKEN}${"y".repeat(500)}` }) };
const ALL = [echo, big, refusing, failing, crashing, quoting, leaking, straddling];
const SCOPE_ARGS = { organization: "acme", projectSlug: "web-app" };

function connection(approved: readonly string[], fetch: Parameters<typeof nativeConnection>[2]["fetch"] = vi.fn() as never) {
  return nativeConnection<Scope>(ALL, approved, { credential: { token: TOKEN, bindings: {} }, fetch, routing: ROUTING });
}
const textOf = (result: { content?: Array<{ text?: string | undefined }> | undefined }) => result.content?.map((entry) => entry.text ?? "").join("") ?? "";

describe("nativeConnection", () => {

  it("refuses to call a tool that was not approved, even one the runtime has", async () => {
    await expect(connection(["echo"]).call("big", SCOPE_ARGS)).rejects.toThrow("MCP tool not allowed or unavailable");
  });

  it("refuses a wrong-typed, out-of-range, unlisted-value or over-long argument at its path, and a missing routing value", async () => {
    const call = (args: Record<string, unknown>) => connection(["echo"]).call("echo", { ...SCOPE_ARGS, ...args });
    for (const [args, path] of [
      [{ limit: "3" }, "limit"], [{ limit: 3.5 }, "limit"], [{ limit: 0 }, "limit"], [{ limit: 6 }, "limit"], [{ text: 5 }, "text"], [{ text: "x".repeat(11) }, "text"],
      [{ mode: "c" }, "mode"], [{ items: "a" }, "items"], [{ items: [{}, {}, {}] }, "items"], [{ items: [{ name: 1 }] }, "items.0.name"], [{ items: [{ name: "a", extra: 1 }] }, "items.0.extra"],
    ] as const) {
      const result = await call(args);
      expect(textOf(result), JSON.stringify(args)).toBe(`echo: ${path} is not allowed`);
      expect(result.isError).toBe(true);
    }
    // A required key inside an item is named by its path.
    expect(textOf(await connection(["echo"]).call("echo", { ...SCOPE_ARGS, items: [{}] }))).toBe("echo: items.0.name is required");
    const missing = await connection(["echo"]).call("echo", { organization: "acme" });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toBe("echo: projectSlug is required");
    expect(textOf(await connection(["echo"]).call("echo", { organization: "acme", projectSlug: 7 }))).toBe("echo: projectSlug is not allowed");
  });

  it("runs a valid call with the routing values as its scope and the rest as its arguments", async () => {
    const result = await connection(["echo"]).call("echo", { ...SCOPE_ARGS, text: "hi", limit: 2, mode: "a", items: [{ name: "n" }] });
    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toBe('echo {"text":"hi","limit":2,"mode":"a","items":[{"name":"n"}]} in acme/web-app');
  });

  it("answers a tool's refusal as an error with its words, a vendor failure with its fixed words, and anything else without naming what was thrown", async () => {
    // The words we write reach the model: the connection throws a ToolRefusal, which the engine returns as the call's failure (a vendor body never does).
    const refused = await connection(["refusing"]).call("refusing", SCOPE_ARGS).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ToolRefusal);
    expect(refused).toMatchObject({ message: "that issue is not in web", reason: "policy_denied" });
    const unreachable = await connection(["failing"]).call("failing", SCOPE_ARGS).catch((error: unknown) => error);
    expect(unreachable).toBeInstanceOf(ToolRefusal);
    expect(unreachable).toMatchObject({ message: "the vendor could not be reached", reason: "vendor_error" });
    const crashed = await connection(["crashing"]).call("crashing", SCOPE_ARGS);
    expect(crashed.isError).toBe(true);
    expect(textOf(crashed)).toBe("crashing failed");
    expect(JSON.stringify(crashed)).not.toContain(TOKEN);
  });
});

describe("nativeConnection with a credential per call", () => {
  const showsToken: NativeTool<Scope> = {
    name: "shows_token", description: "Shows the token it runs with", inputSchema: { type: "object", properties: { text: { type: "string", maxLength: 10 } }, required: [], additionalProperties: false },
    run: async (_args, ctx) => ({ text: `ran as ${ctx.credential.token} in ${ctx.scope.organization}/${ctx.scope.projectSlug}` }),
  };
  const CALL_TOKEN = "ghs_PERCALLTOKEN0123456789";
  const build = (credentialFor: (tool: string, scope: Scope) => Promise<{ token: string }>, tools: readonly NativeTool<Scope>[] = [showsToken, echo]) =>
    nativeConnection<Scope>(tools, tools.map((tool) => tool.name), { credential: { token: TOKEN, bindings: {} }, fetch: vi.fn() as never, routing: ROUTING, credentialFor: async (tool, scope) => ({ ...(await credentialFor(tool, scope)), bindings: {} }) });

  it("scrubs the call's credential and the connection's own, before the cap", async () => {
    const both: NativeTool<Scope> = { name: "both", description: "Both", inputSchema: { type: "object", properties: {}, additionalProperties: false }, run: async (_args, ctx) => ({ text: `${"x".repeat(NATIVE_TEXT_LIMIT - 30)}${ctx.credential.token}${TOKEN}${"y".repeat(500)}` }) };
    const text = textOf(await build(async () => ({ token: CALL_TOKEN }), [both]).call("both", SCOPE_ARGS));
    expect(text.length).toBeLessThanOrEqual(NATIVE_TEXT_LIMIT);
    for (const secret of [CALL_TOKEN, TOKEN]) for (let start = 0; start + 8 <= secret.length; start += 1) expect(text.includes(secret.slice(start, start + 8)), secret.slice(start, start + 8)).toBe(false);
    expect(textOf(await build(async () => ({ token: CALL_TOKEN }), [leaking]).call("leaking", SCOPE_ARGS))).toBe("the vendor echoed [REDACTED] back");
  });

  it("lets a credential that is unavailable through, so the engine says the connector is not connected", async () => {
    const error = await build(async () => { throw new CredentialUnavailable("GitHub isn't connected"); }).call("shows_token", SCOPE_ARGS).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CredentialUnavailable);
    expect(error).toMatchObject({ message: "GitHub isn't connected" });
  });

});

/** A `fetch` stand-in that answers with `respond` and records how it was called. */
function fakeFetch(respond: (url: URL, init: RequestInit | undefined) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push({ url: url.href, init });
    return respond(url, init);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("vendorFetch", () => {
  const HOSTS = ["us.sentry.io"];
  const URL_OK = "https://us.sentry.io/api/0/organizations/acme/";

  it("refuses a redirect to another host and does not follow it", async () => {
    const { fn, calls } = fakeFetch(() => new Response(null, { status: 302, headers: { location: "https://evil.example/steal" } }));
    await expect(vendorFetch({ url: URL_OK, allowedHosts: HOSTS, fetch: fn })).rejects.toThrow("the vendor answered with a redirect, which is refused");
    expect(calls.map((call) => new URL(call.url).hostname)).toEqual(["us.sentry.io"]);
    // A fetch that refuses redirects by throwing (as the real one does under redirect: "error") is the same refusal.
    const throwing = fakeFetch(() => { throw new TypeError("fetch failed", { cause: new Error("unexpected redirect") }); });
    await expect(vendorFetch({ url: URL_OK, allowedHosts: HOSTS, fetch: throwing.fn })).rejects.toThrow("the vendor answered with a redirect, which is refused");
  });

  it("refuses a 2 MB answer, and one that is longer than it said", async () => {
    const { fn } = fakeFetch(() => new Response("x".repeat(2 * 1024 * 1024), { status: 200 }));
    await expect(vendorFetch({ url: URL_OK, allowedHosts: HOSTS, fetch: fn })).rejects.toThrow("the vendor answered with more than a connector reads");
    const small = fakeFetch(() => new Response("y".repeat(200), { status: 200 }));
    await expect(vendorFetch({ url: URL_OK, allowedHosts: HOSTS, maxBytes: 100, fetch: small.fn })).rejects.toThrow("more than a connector reads");
    expect((await vendorFetch({ url: URL_OK, allowedHosts: HOSTS, maxBytes: 200, fetch: small.fn })).text).toHaveLength(200);
  });

  it("refuses any host but the allowed ones, another scheme and a login, making no request", async () => {
    const { fn, calls } = fakeFetch(() => new Response("{}"));
    for (const url of ["https://evil.example/", "https://de.sentry.io/", "http://us.sentry.io/api/0/", "https://user:pw@us.sentry.io/api/0/", "https://169.254.169.254/", "not a url"]) {
      await expect(vendorFetch({ url, allowedHosts: HOSTS, fetch: fn }), url).rejects.toThrow("the request is not to an allowed vendor address");
    }
    expect(calls).toEqual([]);
  });

  it("returns a redirect's status and Location, and follows nothing, only when asked to capture it", async () => {
    const redirect = () => new Response(null, { status: 302, headers: { location: "https://pipelines.actions.githubusercontent.com/abc/log.txt?sig=1" } });
    const { fn, calls } = fakeFetch(redirect);
    const captured = await vendorFetch({ url: URL_OK, allowedHosts: HOSTS, captureRedirect: true, fetch: fn });
    expect(captured).toEqual({ status: 302, location: "https://pipelines.actions.githubusercontent.com/abc/log.txt?sig=1" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init?.redirect).toBe("error");
    // Without it, the same answer is the same refusal as ever.
    await expect(vendorFetch({ url: URL_OK, allowedHosts: HOSTS, fetch: fakeFetch(redirect).fn })).rejects.toThrow("the vendor answered with a redirect, which is refused");
    // A redirect with no Location is captured as that: the caller decides what it means.
    const bare = await vendorFetch({ url: URL_OK, allowedHosts: HOSTS, captureRedirect: true, fetch: fakeFetch(() => new Response(null, { status: 302 })).fn });
    expect(bare).toStrictEqual({ status: 302 });
    // A 200 is unchanged by the option.
    expect((await vendorFetch({ url: URL_OK, allowedHosts: HOSTS, captureRedirect: true, fetch: fakeFetch(() => new Response("{}", { status: 200 })).fn })).status).toBe(200);
  });

  it("vendorFetcher passes the capture request through, for one request only", async () => {
    const { fn } = fakeFetch(() => new Response(null, { status: 302, headers: { location: "https://x.blob.core.windows.net/a" } }));
    const fetcher = vendorFetcher({ base: new URL("https://us.sentry.io/api/0/"), fetch: fn });
    expect(await fetcher("logs", { redirect: "capture" })).toEqual({ status: 302, location: "https://x.blob.core.windows.net/a" });
    await expect(fetcher("logs")).rejects.toThrow("the vendor answered with a redirect, which is refused");
  });

  it("names no token, header or URL in a failure, however the transport words it", async () => {
    const leaky = fakeFetch(() => { throw new Error(`connect failed to ${URL_OK}?token=${TOKEN} with Authorization: Bearer ${TOKEN}`); });
    const error = await vendorFetch({ url: `${URL_OK}?q=1`, allowedHosts: HOSTS, headers: { authorization: `Bearer ${TOKEN}` }, fetch: leaky.fn }).catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(VendorFetchError);
    expect((error as Error).message).toBe("the vendor could not be reached");
    expect(JSON.stringify([(error as Error).message, (error as Error).name, (error as Error).toString()])).not.toContain(TOKEN);
  });

  it("gives up on a vendor that sends headers and then stalls the body, with the same fixed message (review M-3)", async () => {
    const request = ((_url: URL, _options: unknown, callback?: (response: unknown) => void) => ({
      on: () => undefined,
      destroy: () => undefined,
      end: () => { callback?.(Object.assign(new PassThrough(), { statusCode: 200, headers: { "content-type": "application/json" }, statusMessage: "" })); },
    })) as never;
    const stalled = lookupFetch(pinnedLookup(["52.1.2.3"]), { request });
    const started = Date.now();
    await expect(vendorFetch({ url: URL_OK, allowedHosts: HOSTS, timeoutMs: 50, fetch: stalled })).rejects.toThrow("the vendor did not answer in time");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

});

/** Runs a node-style lookup and answers its callback arguments. */
const lookupWith = (addresses: string[] | Error, options: object = { all: true }) =>
  new Promise<unknown[]>((resolve) => {
    safeLookup(async () => { if (addresses instanceof Error) throw addresses; return addresses; })("vendor.example", options, ((...args: unknown[]) => resolve(args)));
  });

describe("safeLookup (rebinding, Review Focus 6)", () => {
  it("refuses 10.0.0.5, 169.254.169.254 and ::1 when the connection is made, and accepts 52.1.2.3", async () => {
    for (const address of ["10.0.0.5", "169.254.169.254", "::1", "127.0.0.1", "192.168.1.1", "172.16.0.1", "fd00::1", "100.64.0.1"]) {
      const [error] = await lookupWith([address]) as [Error & { code?: string }];
      expect(error, address).toBeInstanceOf(Error);
      expect(error.code).toBe("ECONNREFUSED");
      expect(error.message).not.toContain(address);
    }
    expect(await lookupWith(["52.1.2.3"])).toEqual([null, [{ address: "52.1.2.3", family: 4 }]]);
    expect(await lookupWith(["52.1.2.3"], {})).toEqual([null, "52.1.2.3", 4]);
  });

  it("refuses a name when any one of its addresses is not public, or it has none, or the lookup fails", async () => {
    const [mixed] = await lookupWith(["52.1.2.3", "10.0.0.5"]) as [Error];
    expect(mixed).toBeInstanceOf(Error);
    expect((await lookupWith([]))[0]).toBeInstanceOf(Error);
    const [failed] = await lookupWith(new Error("SERVFAIL for vendor.example")) as [Error & { code?: string }];
    expect(failed.code).toBe("ENOTFOUND");
    expect(failed.message).not.toContain("SERVFAIL");
  });

  it("is the lookup the default vendor fetch connects through, asked at connect time", async () => {
    const seen: Array<{ lookup: (host: string, options: object, callback: (...args: unknown[]) => void) => void }> = [];
    const request = vi.fn((_url: URL, options: never) => { seen.push(options); throw new Error("stop before any network"); });
    const resolveHost = vi.fn(async () => ["10.0.0.5"]);
    await expect(safeVendorFetch({ resolveHost, request: request as never })("https://us.sentry.io/api/0/")).rejects.toThrow();
    expect(resolveHost).not.toHaveBeenCalled();
    // Node asks the lookup when it connects; a name that resolves privately then is refused.
    const answer = await new Promise<unknown[]>((resolve) => seen[0]!.lookup("us.sentry.io", { all: true }, (...args) => resolve(args)));
    expect((answer[0] as Error).message).toContain("not public");
    expect(resolveHost).toHaveBeenCalledWith("us.sentry.io");
  });

  it("hands a redirect back to the caller to read, only when the fetch was built to, and never follows it", async () => {
    const redirecting = ((_url: URL, _options: unknown, callback?: (response: unknown) => void) => ({
      on: () => undefined,
      destroy: () => undefined,
      end: () => { callback?.(Object.assign(new PassThrough(), { statusCode: 302, headers: { location: "https://x.blob.core.windows.net/a?sig=1" }, statusMessage: "Found" })); },
    })) as never;
    await expect(lookupFetch(pinnedLookup(["52.1.2.3"]), { request: redirecting })("https://api.github.com/x")).rejects.toThrow("a redirect was refused");
    const returned = await lookupFetch(pinnedLookup(["52.1.2.3"]), { request: redirecting, returnRedirects: true })("https://api.github.com/x");
    expect(returned.status).toBe(302);
    expect(returned.headers.get("location")).toBe("https://x.blob.core.windows.net/a?sig=1");
    expect(returned.body).toBeNull();
    const resolveHost = async () => ["52.1.2.3"];
    await expect(safeVendorFetch({ resolveHost, request: redirecting })("https://api.github.com/x")).rejects.toThrow("a redirect was refused");
    expect((await safeVendorFetch({ resolveHost, request: redirecting, returnRedirects: true })("https://api.github.com/x")).status).toBe(302);
    // The default fetch is still the refusing one, and is not the one that returns redirects.
    expect(safeVendorFetch()).toBe(safeVendorFetch());
    expect(safeVendorFetch({ returnRedirects: true })).toBe(safeVendorFetch({ returnRedirects: true }));
    expect(safeVendorFetch({ returnRedirects: true })).not.toBe(safeVendorFetch());
  });
});


