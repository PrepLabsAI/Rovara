// the runtime every native connector shares. `nativeConnection` is an MCP connection whose tools run in the broker: it lists only the
// approved tools, validates every call's arguments against the tool's schema, and answers text of a bounded size. `vendorFetch` is the only way a tool
// reaches its vendor: one allowed host, https, no redirect, a bounded answer, and no credential in a failure. `safeLookup` refuses a non-public address when
// the connection is made. No test here reaches a network.
import { PassThrough } from "node:stream";
import { CredentialUnavailable, ToolRefusal, discoverTools, executeTool, type ConnectorDefinition, type Ledger } from "@agentx/gateway";
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
  it("lists only the approved tools, each read-only, with the routing arguments required in its schema", () => {
    const listed = connection(["echo", "big"]).tools;
    expect(listed.map((tool) => tool.name)).toEqual(["echo", "big"]);
    for (const tool of listed) {
      expect(tool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
      expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
      expect((tool.inputSchema["required"] as string[]).slice(0, 2).sort()).toEqual(["organization", "projectSlug"]);
      expect(Object.keys(tool.inputSchema["properties"] as object)).toEqual(expect.arrayContaining(["organization", "projectSlug"]));
    }
    expect(connection([]).tools).toEqual([]);
    expect(connection(["nothing-like-it"]).tools).toEqual([]);
  });

  it("refuses to call a tool that was not approved, even one the runtime has", async () => {
    await expect(connection(["echo"]).call("big", SCOPE_ARGS)).rejects.toThrow("MCP tool not allowed or unavailable");
  });

  it("refuses an extra argument with the exact text and makes no vendor request", async () => {
    const fetch = vi.fn();
    const result = await connection(["echo"], fetch as never).call("echo", { ...SCOPE_ARGS, text: "hi", url: "https://evil.example/" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("echo: url is not allowed");
    expect(fetch).not.toHaveBeenCalled();
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

  it("truncates a long answer to 32,768 characters with (truncated), and emits no structured content (review I-2)", async () => {
    const result = await connection(["big"]).call("big", SCOPE_ARGS);
    const text = textOf(result);
    expect(text).toHaveLength(NATIVE_TEXT_LIMIT);
    expect(text.endsWith("(truncated)")).toBe(true);
    expect(result).not.toHaveProperty("structuredContent");
  });

  it("scrubs the token before it cuts, so no part of one that straddles the cut survives (review I-1)", async () => {
    const text = textOf(await connection(["straddling"]).call("straddling", SCOPE_ARGS));
    expect(text.length).toBeLessThanOrEqual(NATIVE_TEXT_LIMIT);
    expect(text).toContain("[REDACTED]");
    for (let start = 0; start + 8 <= TOKEN.length; start += 1) expect(text.includes(TOKEN.slice(start, start + 8)), TOKEN.slice(start, start + 8)).toBe(false);
  });

  it("refuses __proto__ as an argument no schema declares (review M-2)", async () => {
    const args = JSON.parse('{"organization":"acme","projectSlug":"web-app","__proto__":{"x":1}}') as Record<string, unknown>;
    const result = await connection(["echo"]).call("echo", args);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("echo: __proto__ is not allowed");
    // The same name inside a nested object, where a schema declares its keys.
    const nested = JSON.parse('{"organization":"acme","projectSlug":"web-app","items":[{"name":"a","__proto__":{"x":1}}]}') as Record<string, unknown>;
    expect(textOf(await connection(["echo"]).call("echo", nested))).toBe("echo: items.0.__proto__ is not allowed");
  });

  it("replaces the token with [REDACTED] in anything a tool answers or refuses with", async () => {
    await expect(connection(["quoting"]).call("quoting", SCOPE_ARGS)).rejects.toMatchObject({ message: "the vendor said [REDACTED]" });
    expect(textOf(await connection(["leaking"]).call("leaking", SCOPE_ARGS))).toBe("the vendor echoed [REDACTED] back");
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

  it("asks for the call's credential once, after the arguments are checked, with the tool and its scope, and runs the tool with it", async () => {
    const credentialFor = vi.fn(async () => ({ token: CALL_TOKEN }));
    const result = await build(credentialFor).call("shows_token", { ...SCOPE_ARGS, text: "hi" });
    expect(credentialFor).toHaveBeenCalledTimes(1);
    expect(credentialFor).toHaveBeenCalledWith("shows_token", { organization: "acme", projectSlug: "web-app" });
    // The tool ran as the call's credential, and the answer is scrubbed of it.
    expect(textOf(result)).toBe("ran as [REDACTED] in acme/web-app");
    expect(textOf(result)).not.toContain(CALL_TOKEN);
  });

  it("asks for nothing when the call is refused first: an unknown tool, a missing or wrong routing value, a bad argument", async () => {
    const credentialFor = vi.fn(async () => ({ token: CALL_TOKEN }));
    const connection = build(credentialFor);
    await expect(connection.call("not_a_tool", SCOPE_ARGS)).rejects.toThrow("MCP tool not allowed or unavailable");
    expect(textOf(await connection.call("shows_token", { organization: "acme" }))).toBe("shows_token: projectSlug is required");
    expect(textOf(await connection.call("shows_token", { ...SCOPE_ARGS, organization: 5 }))).toBe("shows_token: organization is not allowed");
    expect(textOf(await connection.call("shows_token", { ...SCOPE_ARGS, text: "x".repeat(11) }))).toBe("shows_token: text is not allowed");
    expect(textOf(await connection.call("shows_token", { ...SCOPE_ARGS, extra: 1 }))).toBe("shows_token: extra is not allowed");
    expect(credentialFor).not.toHaveBeenCalled();
  });

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

  it("answers a refusal in the credential step as a refusal, and any other failure without naming it", async () => {
    const refused = await build(async () => { throw new NativeToolRefusal(`no token for ${TOKEN}`, "vendor_error"); }).call("shows_token", SCOPE_ARGS).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ToolRefusal);
    expect(refused).toMatchObject({ message: "no token for [REDACTED]", reason: "vendor_error" });
    const crashed = await build(async () => { throw new Error(`boom ${TOKEN}`); }).call("shows_token", SCOPE_ARGS);
    expect(crashed.isError).toBe(true);
    expect(textOf(crashed)).toBe("shows_token failed");
  });

  it("scrubs the call's own credential from a refusal's words, and from a vendor failure's", async () => {
    const quotes: NativeTool<Scope> = { name: "quotes", description: "Quotes", inputSchema: { type: "object", properties: {}, additionalProperties: false }, run: async (_args, ctx) => { throw new NativeToolRefusal(`GitHub said ${ctx.credential.token}`, "vendor_error"); } };
    const refused = await build(async () => ({ token: CALL_TOKEN }), [quotes]).call("quotes", SCOPE_ARGS).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ToolRefusal);
    expect(refused).toMatchObject({ message: "GitHub said [REDACTED]", reason: "vendor_error" });
    const unreachable: NativeTool<Scope> = { name: "unreachable", description: "Fails", inputSchema: { type: "object", properties: {}, additionalProperties: false }, run: async (_args, ctx) => { throw new VendorFetchError(`failed with ${ctx.credential.token}`); } };
    expect(await build(async () => ({ token: CALL_TOKEN }), [unreachable]).call("unreachable", SCOPE_ARGS).catch((error: unknown) => error)).toMatchObject({ message: "failed with [REDACTED]" });
  });

  it("keeps the connection's own credential when there is no credentialFor", async () => {
    expect(textOf(await connection(["leaking"]).call("leaking", SCOPE_ARGS))).toBe("the vendor echoed [REDACTED] back");
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

  it("reads a JSON answer, sends the caller's headers, and holds the request to the fixed-origin fetch that never follows a redirect", async () => {
    const { fn, calls } = fakeFetch(() => new Response(JSON.stringify({ slug: "acme" }), { status: 200, headers: { "content-type": "application/json" } }));
    const response = await vendorFetch({ url: URL_OK, allowedHosts: HOSTS, headers: { authorization: `Bearer ${TOKEN}` }, fetch: fn });
    expect(response).toMatchObject({ status: 200, json: { slug: "acme" } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init?.redirect).toBe("error");
    expect(new Headers(calls[0]!.init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
  });

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

  it("gives up on a vendor that does not answer, with a fixed message", async () => {
    const hang = fakeFetch((_url, init) => new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener("abort", () => reject(init.signal!.reason as Error)); }));
    await expect(vendorFetch({ url: URL_OK, allowedHosts: HOSTS, timeoutMs: 20, fetch: hang.fn })).rejects.toThrow("the vendor did not answer in time");
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

  it("vendorFetcher reads a path against its base, and reaches nothing else", async () => {
    const { fn, calls } = fakeFetch(() => new Response("[]", { status: 200 }));
    const fetcher = vendorFetcher({ base: new URL("https://us.sentry.io/api/0/"), fetch: fn, headers: { authorization: `Bearer ${TOKEN}` } });
    expect((await fetcher("organizations/acme/")).status).toBe(200);
    expect(calls[0]!.url).toBe("https://us.sentry.io/api/0/organizations/acme/");
    expect(new Headers(calls[0]!.init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    await expect(fetcher("https://evil.example/x")).rejects.toThrow("not to an allowed vendor address");
    await expect(fetcher("//evil.example/x")).rejects.toThrow("not to an allowed vendor address");
    expect(calls).toHaveLength(1);
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


/** A tool run through the real engine (discovery, then `executeTool`) over a `nativeConnection`, as a connector would be. */
async function throughEngine(tool: NativeTool<Scope>) {
  const connect = (async (target: { tools: readonly string[]; token: string }) => nativeConnection<Scope>([tool], target.tools, { credential: { token: target.token, bindings: {} }, fetch: vi.fn() as never, routing: ROUTING })) as never;
  const definition: ConnectorDefinition<{ alias: string }> = {
    label: "Toy", endpoint: new URL("https://toy.example/"), permissionsHint: "the toy token",
    credentials: { issue: async () => ({ token: TOKEN, bindings: {} }) },
    binder: { properties: ["organization", "projectSlug"], bind: () => SCOPE_ARGS },
    guards: [],
  };
  const context = { workspaceId: "ws", ownerKey: "owner", scopeAlias: "a", scope: { alias: "a" }, settingsRevision: 1, policy: { tools: [{ name: tool.name, access: "read" as const }] } };
  const ledger: Ledger = { claim: async () => true, get: async () => undefined, finish: async () => undefined };
  const discovered = (await discoverTools(definition, context, { connect })).tools.find((entry) => entry.name === tool.name)!;
  return executeTool({ requestId: "11111111-1111-4111-8111-111111111111", scope: "a", tool: tool.name, schemaHash: discovered.schemaHash, arguments: {} }, definition, context, { connect, ledger });
}

describe("what the model sees through the engine", () => {
  it("is the capped, scrubbed text of an oversized answer, and never more than 32,768 characters (review I-2)", async () => {
    const result = await throughEngine(big);
    expect(result.status).toBe("SUCCEEDED");
    expect(result.text.length).toBeLessThanOrEqual(NATIVE_TEXT_LIMIT);
    expect(result.text.endsWith("(truncated)")).toBe(true);
    const cut = await throughEngine(straddling);
    for (let start = 0; start + 8 <= TOKEN.length; start += 1) expect(cut.text.includes(TOKEN.slice(start, start + 8))).toBe(false);
  });

  it("is the refusal words we wrote, scrubbed of the token, with their reason, and never a crash's words (review M-1)", async () => {
    expect(await throughEngine(refusing)).toMatchObject({ status: "FAILED", reason: "policy_denied", text: "that issue is not in web" });
    expect(await throughEngine(failing)).toMatchObject({ status: "FAILED", reason: "vendor_error", text: "the vendor could not be reached" });
    expect(await throughEngine(quoting)).toMatchObject({ status: "FAILED", reason: "policy_denied", text: "the vendor said [REDACTED]" });
    const crashed = await throughEngine(crashing);
    expect(crashed).toMatchObject({ status: "FAILED", reason: "vendor_error" });
    expect(crashed.text).toContain("MCP request failed before any write");
    expect(JSON.stringify(crashed)).not.toContain("boom");
  });
});
