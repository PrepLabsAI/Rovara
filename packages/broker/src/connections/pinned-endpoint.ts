// The MCP transport of a company's own endpoint. `checkEndpointUrl` resolves the host and refuses a private
// address, but node resolves the name again when it connects, so a name that answers "public" to the check and "10.0.0.5" to the connection would be
// reached. So before every MCP request the endpoint is checked, and the request is made by a fetch whose connection lookup answers only with the
// addresses that check returned. The lookup never asks DNS, so what was checked is what is connected to. Redirects are refused, and every request
// opens its own connection (`agent: false`), so none is reused across a check.
import { request as httpRequest, type ClientRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { agentXError } from "@agentx/contracts";
import type { connectMcp } from "@agentx/gateway";
import { checkEndpointUrl, dnsResolveHost, type ResolveHost } from "./endpoint-check.js";

type LookupCallback = (error: Error | null, address?: string | Array<{ address: string; family: number }>, family?: number) => void;
type LookupOptions = { family?: number | string; all?: boolean } | undefined;

/** node:http's and node:https's `request`, or a stand-in for a test. */
export type RequestFunction = (url: URL, options: RequestOptions, callback?: (response: IncomingMessage) => void) => ClientRequest;

/** Decides, before one MCP request, whether the endpoint may be called, and gives the fetch that request must use. */
export type McpEndpointGuard = (endpoint: URL) => Promise<typeof fetch>;

const hasLogin = (url: URL): boolean => url.username !== "" || url.password !== "";
const asError = (reason: unknown): Error => (reason instanceof Error ? reason : new Error(typeof reason === "string" ? reason : "the request was aborted"));
const familyOf = (value: number | string | undefined): 0 | 4 | 6 => (value === 4 || value === "IPv4" ? 4 : value === 6 || value === "IPv6" ? 6 : 0);

/**
 * A `lookup` for node's connection options that answers with `addresses` whatever name it is asked for, in the shape asked for (`all` or one),
 * keeping to the address family asked for. It does not resolve anything.
 */
export function pinnedLookup(addresses: readonly string[]): (hostname: string, options: LookupOptions | LookupCallback, callback?: LookupCallback) => void {
  if (addresses.length === 0 || addresses.some((address) => isIP(address) === 0)) throw agentXError("CONFIG_INVALID", "an endpoint can only be pinned to the addresses its check returned");
  const entries = addresses.map((address) => ({ address, family: isIP(address) }));
  return (_hostname, options, callback) => {
    const done = typeof options === "function" ? options : callback;
    const asked = typeof options === "function" ? undefined : options;
    if (done === undefined) return;
    const family = familyOf(asked?.family);
    const usable = family === 0 ? entries : entries.filter((entry) => entry.family === family);
    const first = usable[0];
    if (first === undefined) { done(Object.assign(new Error("the endpoint has no checked address of that family"), { code: "ENOTFOUND" })); return; }
    if (asked?.all === true) done(null, usable.map((entry) => ({ ...entry })));
    else done(null, first.address, first.family);
  };
}

/** Headers node sets for itself from the URL and the body: forwarding the caller's would let a header steer routing on the pinned address or disagree with the body. */
const OWN_HEADERS: ReadonlySet<string> = new Set(["host", "connection", "transfer-encoding", "content-length"]);

function headersOf(init: RequestInit | undefined, request: Request | undefined): Record<string, string> {
  const merged = new Headers(request?.headers);
  new Headers(init?.headers).forEach((value, key) => merged.set(key, value));
  const out: Record<string, string> = {};
  merged.forEach((value, key) => { if (!OWN_HEADERS.has(key.toLowerCase())) out[key] = value; });
  return out;
}

async function bodyOf(init: RequestInit | undefined, request: Request | undefined): Promise<Buffer | undefined> {
  const body = init?.body;
  if (body === undefined || body === null) return request === undefined || request.body === null ? undefined : Buffer.from(await request.arrayBuffer());
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString(), "utf8");
  throw new TypeError("a pinned fetch sends a string or bytes");
}

const BODYLESS = new Set([101, 204, 205, 304]);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * A `fetch` that connects only to `addresses` (see `pinnedLookup`), opens a connection per request, never follows a redirect and ends with the caller's
 * signal. It speaks what the MCP transport sends: a method, headers and a string body, and answers a streaming `Response`. Which addresses are allowed is
 * the caller's check (`mcpEndpointGuard`); this only keeps the connection to them.
 */
export function pinnedFetch(addresses: readonly string[], options: { request?: RequestFunction; origin?: string } = {}): typeof fetch {
  return lookupFetch(pinnedLookup(addresses), options);
}

/** A node connection `lookup`, as `pinnedLookup` and `safeLookup` build one. */
export type ConnectionLookup = ReturnType<typeof pinnedLookup>;

/**
 * A `fetch` that connects through `lookup` whatever name the URL holds, opens a connection per request, never follows a redirect and ends with the caller's
 * signal. `pinnedFetch` gives it a lookup that answers a fixed set of addresses; the native connectors' (`vendor-fetch.ts`) a lookup that resolves the name
 * and refuses any address that is not public, at connect time. A redirect is refused unless `returnRedirects` is set: then its status and
 * headers come back, with no body, for the caller to read; it is still never followed.
 */
export function lookupFetch(lookup: ConnectionLookup, options: { request?: RequestFunction; origin?: string; returnRedirects?: boolean } = {}): typeof fetch {
  return async (input, init) => {
    const original = input instanceof Request ? input : undefined;
    const url = new URL(original?.url ?? (input instanceof URL ? input.href : input));
    // Held to the endpoint that was checked: the lookup pins a DNS name, but an IP literal is connected to directly and `http:` is not the checked scheme.
    if (options.origin !== undefined && (url.origin !== options.origin || url.protocol !== "https:" || isIP(url.hostname.replace(/^\[|\]$/gu, "")) !== 0 || hasLogin(url))) {
      throw new TypeError("a request to anywhere but the checked endpoint was refused");
    }
    // The origin ignores a login, and node would send one as a Basic header that can replace the caller's own authorization: refused whatever the origin.
    if (hasLogin(url)) throw new TypeError("a request with a login in the address was refused");
    const signal = init?.signal ?? original?.signal ?? undefined;
    if (signal?.aborted === true) throw asError(signal.reason ?? new DOMException("This operation was aborted", "AbortError"));
    const method = (init?.method ?? original?.method ?? "GET").toUpperCase();
    const body = method === "GET" || method === "HEAD" ? undefined : await bodyOf(init, original);
    const headers = headersOf(init, original);
    if (body !== undefined) headers["content-length"] = String(body.byteLength);
    const send = options.request ?? ((target: URL, requestOptions: RequestOptions, callback?: (response: IncomingMessage) => void) =>
      (target.protocol === "https:" ? httpsRequest : httpRequest)(target, requestOptions, callback));
    return new Promise<Response>((resolve, reject) => {
      let request: ClientRequest | undefined;
      const onAbort = () => { const reason = asError(signal?.reason ?? new DOMException("This operation was aborted", "AbortError")); request?.destroy(reason); reject(reason); };
      try {
        request = send(url, { method, headers, lookup: lookup as RequestOptions["lookup"], agent: false }, (response) => {
          signal?.removeEventListener("abort", onAbort);
          const status = response.statusCode ?? 502;
          const redirected = REDIRECTS.has(status);
          if (redirected && options.returnRedirects !== true) { response.destroy(); reject(new TypeError("fetch failed: a redirect was refused")); return; }
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(response.headers)) for (const entry of Array.isArray(value) ? value : value === undefined ? [] : [value]) responseHeaders.append(key, entry);
          if (redirected) { response.destroy(); resolve(new Response(null, { status, statusText: response.statusMessage ?? "", headers: responseHeaders })); return; }
          const bodyless = BODYLESS.has(status) || method === "HEAD";
          if (bodyless) response.resume();
          resolve(new Response(bodyless ? null : Readable.toWeb(response) as ReadableStream<Uint8Array>, { status, statusText: response.statusMessage ?? "", headers: responseHeaders }));
        });
        signal?.addEventListener("abort", onAbort, { once: true });
        request.on("error", (error) => { signal?.removeEventListener("abort", onAbort); reject(error); });
        request.end(body);
      } catch (error) {
        signal?.removeEventListener("abort", onAbort);
        reject(asError(error));
      }
    });
  };
}

/**
 * The guard the broker puts in front of every request to a company's MCP endpoint: `checkEndpointUrl` now (https, a public DNS name, every address it
 * resolves to public), then the fetch pinned to those addresses. Each request checks again, so a host that starts to resolve somewhere private is
 * refused at its next request, and one that changes its answer between the check and the connection is not reached.
 */
export function mcpEndpointGuard(options: { resolveHost?: ResolveHost; request?: RequestFunction } = {}): McpEndpointGuard {
  const resolveHost = options.resolveHost ?? dnsResolveHost;
  return async (endpoint) => {
    const checked = await checkEndpointUrl(endpoint.href, resolveHost);
    return pinnedFetch(checked.addresses, { origin: checked.url.origin, ...(options.request === undefined ? {} : { request: options.request }) });
  };
}

/** `base` (the vendor connection) with the guard run before each connection and the pinned fetch handed to it. */
export function guardedConnect(base: typeof connectMcp, guard: McpEndpointGuard): typeof connectMcp {
  return async (input) => base({ ...input, fetchImplementation: await guard(input.endpoint) });
}
