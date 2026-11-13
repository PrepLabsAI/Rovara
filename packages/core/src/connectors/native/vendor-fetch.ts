// How a native connector (Sentry, Datadog, PagerDuty, Vercel, ...) reaches its vendor. Every request goes through the fixed-origin fetch of
// `connections/vendor-hosts.ts` (`originHeldFetch`): one allowed host, https only, no login in the address, and a redirect refused rather than followed, so
// the vendor cannot send a call, and the token in it, somewhere else. Underneath it, by default, a fetch whose connection lookup refuses any address that is
// not public at the moment of connecting (`safeLookup`), so a host that resolved publicly when it was configured and resolves privately later is still not
// reached. A failure says what went wrong in fixed words; it never carries a URL, a header or any part of a vendor's answer, so it cannot carry a token.
import { isPublicAddress } from "@agentx/gateway";
import { dnsResolveHost, type ResolveHost } from "../../connections/endpoint-check.js";
import { lookupFetch, pinnedLookup, type ConnectionLookup, type RequestFunction } from "../../connections/pinned-endpoint.js";
import { originHeldFetch } from "../../connections/vendor-hosts.js";

export const VENDOR_TIMEOUT_MS = 15_000;
export const VENDOR_MAX_BYTES = 1_048_576;

/** A vendor request that failed or was refused. The message is fixed text. */
export class VendorFetchError extends Error {
  constructor(message: string) { super(message); this.name = "VendorFetchError"; }
}

export interface VendorResponse {
  status: number;
  /** The body parsed as JSON, when it is. */
  json?: unknown;
  /** The body as text. */
  text?: string;
  /** For a redirect that was asked to be captured (`redirect: "capture"`): where it points. It was not followed. */
  location?: string;
}

/** A request to the vendor: a path under the connector's base URL, or a full URL on the same host. */
export type VendorFetch = (target: string | URL, options?: {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  /** `capture`: a redirect is answered as `{ status, location }` instead of refused. It is never followed; the caller decides whether to ask anywhere else. */
  redirect?: "capture";
}) => Promise<VendorResponse>;

type LookupCallback = (error: Error | null, address?: string | Array<{ address: string; family: number }>, family?: number) => void;

/**
 * A node `lookup` that resolves the name itself and answers only when every address is public (`isPublicAddress`); otherwise the connection fails. It runs
 * when the connection is made, not when the connector was saved.
 */
export function safeLookup(resolveHost: ResolveHost = dnsResolveHost): ConnectionLookup {
  return (hostname, options, callback) => {
    const done: LookupCallback | undefined = typeof options === "function" ? options : callback;
    if (done === undefined) return;
    resolveHost(hostname).then((addresses) => {
      if (addresses.length === 0 || !addresses.every(isPublicAddress)) {
        done(Object.assign(new Error("the host resolves to an address that is not public"), { code: "ECONNREFUSED" }));
        return;
      }
      pinnedLookup(addresses)(hostname, options, done);
    }, () => done(Object.assign(new Error("the host could not be looked up"), { code: "ENOTFOUND" })));
  };
}

let defaultFetch: typeof fetch | undefined;
let defaultRedirectFetch: typeof fetch | undefined;

/**
 * The fetch under every native connector in production: connects through `safeLookup`, one connection per request, no redirects. With `returnRedirects` a redirect
 * is handed back (status and Location, no body) instead of refused, for the one connector that reads where GitHub sends a log; `vendorFetch`
 * still refuses it unless the request asks to capture it, and nothing follows it.
 */
export function safeVendorFetch(options: { resolveHost?: ResolveHost; request?: RequestFunction; returnRedirects?: boolean } = {}): typeof fetch {
  const returnRedirects = options.returnRedirects === true;
  if (options.resolveHost === undefined && options.request === undefined) {
    return returnRedirects ? (defaultRedirectFetch ??= lookupFetch(safeLookup(), { returnRedirects: true })) : (defaultFetch ??= lookupFetch(safeLookup()));
  }
  return lookupFetch(safeLookup(options.resolveHost), { ...(options.request === undefined ? {} : { request: options.request }), ...(returnRedirects ? { returnRedirects: true } : {}) });
}

function messageOf(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  const text = error instanceof Error ? `${error.message} ${String((error as { cause?: unknown }).cause instanceof Error ? ((error as { cause: Error }).cause.message) : "")}` : "";
  if (name === "TimeoutError" || name === "AbortError") return "the vendor did not answer in time";
  if (/redirect/iu.test(text)) return "the vendor answered with a redirect, which is refused";
  return "the vendor could not be reached";
}

/**
 * The body as text, or undefined when it is longer than `limit` bytes; stops reading at the cap. It also ends with `signal`: the transport stops watching the
 * signal once the headers have arrived, so a vendor that sends headers and then trickles the body would otherwise hold the call until the platform's own limit.
 */
async function readCapped(response: Response, limit: number, signal: AbortSignal): Promise<string | undefined> {
  if (response.body === null) return "";
  const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let total = 0;
  let stop: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    stop = () => reject(signal.reason instanceof Error ? signal.reason : new DOMException("This operation was aborted", "AbortError"));
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
  });
  aborted.catch(() => undefined);
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      total += value.byteLength;
      if (total > limit) return undefined;
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    if (stop !== undefined) signal.removeEventListener("abort", stop);
    // Whatever ended the read (the cap, the deadline, a failure), the rest of the body is not wanted.
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * One request to one of `allowedHosts`, over the fixed-origin fetch: https, no redirect, a timeout, and a body of at most `maxBytes`. Refused with a
 * `VendorFetchError` (fixed text) for any other host, a redirect, a slow or oversized answer, or a failure to connect.
 */
export async function vendorFetch(input: {
  url: URL | string;
  allowedHosts: readonly string[];
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
  /** A redirect answers `{ status, location }` instead of a refusal (the request itself still never follows it). */
  captureRedirect?: boolean;
  /** The fetch under the origin hold; defaults to `safeVendorFetch()`. */
  fetch?: typeof fetch;
}): Promise<VendorResponse> {
  let url: URL;
  try { url = new URL(input.url); } catch { throw new VendorFetchError("the request is not to an allowed vendor address"); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || !input.allowedHosts.includes(host)) throw new VendorFetchError("the request is not to an allowed vendor address");
  const held = originHeldFetch(input.fetch ?? safeVendorFetch(), host);
  // One deadline for the whole exchange: connecting, the headers and the body.
  const signal = AbortSignal.timeout(input.timeoutMs ?? VENDOR_TIMEOUT_MS);
  let response: Response;
  try {
    response = await held(url, {
      method: input.method ?? "GET",
      headers: input.headers ?? {},
      ...(input.body === undefined ? {} : { body: input.body }),
      signal,
    });
  } catch (error) {
    throw new VendorFetchError(error instanceof TypeError && /anywhere but/u.test(error.message) ? "the request is not to an allowed vendor address" : messageOf(error));
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    if (input.captureRedirect === true) {
      const location = response.headers.get("location");
      return { status: response.status, ...(location === null ? {} : { location }) };
    }
    throw new VendorFetchError("the vendor answered with a redirect, which is refused");
  }
  let text: string | undefined;
  try {
    text = await readCapped(response, input.maxBytes ?? VENDOR_MAX_BYTES, signal);
  } catch (error) {
    throw new VendorFetchError(messageOf(error));
  }
  if (text === undefined) throw new VendorFetchError("the vendor answered with more than a connector reads");
  let json: unknown;
  try { json = text === "" ? undefined : JSON.parse(text); } catch { json = undefined; }
  return { status: response.status, text, ...(json === undefined ? {} : { json }) };
}

/** A `VendorFetch` for one vendor: paths are read against `base`, and nothing but `base`'s host is reachable. */
export function vendorFetcher(options: { base: URL; fetch?: typeof fetch; timeoutMs?: number; maxBytes?: number; headers?: Record<string, string> }): VendorFetch {
  const allowedHosts = [options.base.hostname.toLowerCase()];
  return (target, request = {}) => {
    let url: URL;
    try { url = new URL(target, options.base); } catch { return Promise.reject(new VendorFetchError("the request is not to an allowed vendor address")); }
    return vendorFetch({
      url, allowedHosts,
      ...(request.method === undefined ? {} : { method: request.method }),
      headers: { ...options.headers, ...request.headers },
      ...(request.body === undefined ? {} : { body: request.body }),
      ...(request.redirect === "capture" ? { captureRedirect: true } : {}),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  };
}
