// DEC 254t (a), row A3: a company's own OpenAI-compatible endpoint as its agents' AI (`custom_endpoint`). The company admin registers
// an https base URL, a key and up to ENDPOINT_MODELS_MAX models (the name the endpoint serves, and the catalog model it stands for, used
// for prices and limits). All of it is sealed together as ONE company account in the write-only learning document (provider
// "endpoint", product-keys.ts), so the address and the key never sit in a record, an answer or a log; the gateway opens it only for the
// verified company. Calls go through agent-openai.ts's translation and the SSRF guard (endpoint-guard.ts): DNS resolved at call time,
// every address checked, the connection pinned to the checked address, no redirects.
import dns from "node:dns";
import https from "node:https";
import type { ClientRequest } from "node:http";
import { bodyFacts, OPENAI_AGENT_MODEL, translatedAnswer } from "./agent-openai.js";
import { checkedAddress, ENDPOINT_RESOLVE_MS, endpointTarget, pinnedLookup, type EndpointResolver, type EndpointTarget } from "./endpoint-guard.js";
import { record } from "./model-gateway-token.js";
import { NotSentError, type ProviderTransport } from "./provider.js";

/** The contracts' MAX_MODELS_PER_SOURCE (this package imports no contracts). */
export const ENDPOINT_MODELS_MAX = 20;
export const ENDPOINT_KEY = /^[\x21-\x7e]{8,1024}$/u;
const CATALOG_PROVIDER = /^[a-z][a-z0-9-]{0,31}$/u;
const CATALOG_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/u;
export const ENDPOINT_CONNECTION_MAX_BYTES = 16 * 1024;

export interface EndpointModel { name: string; catalog: { provider: string; modelId: string } }
export interface EndpointConnection { scheme: "openai_compatible"; baseUrl: string; key: string; models: EndpointModel[] }

/** The sealed text of a connection, or undefined when it is not exactly that shape (the store refuses it as invalid). */
export function parseEndpointConnect(text: unknown): EndpointConnection | undefined {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > ENDPOINT_CONNECTION_MAX_BYTES) return undefined;
  let value: unknown;
  try { value = JSON.parse(text) as unknown; } catch { return undefined; }
  const c = record(value);
  if (c === undefined || Object.keys(c).length !== 4 || c.scheme !== "openai_compatible" || typeof c.key !== "string" || !ENDPOINT_KEY.test(c.key)) return undefined;
  if (endpointTarget(c.baseUrl) === undefined || !Array.isArray(c.models) || c.models.length < 1 || c.models.length > ENDPOINT_MODELS_MAX) return undefined;
  const models: EndpointModel[] = [];
  const names = new Set<string>();
  for (const each of c.models) {
    const m = record(each); const catalog = record(m?.catalog);
    if (m === undefined || catalog === undefined || Object.keys(m).length !== 2 || Object.keys(catalog).length !== 2) return undefined;
    if (typeof m.name !== "string" || !OPENAI_AGENT_MODEL.test(m.name) || names.has(m.name)) return undefined;
    if (typeof catalog.provider !== "string" || !CATALOG_PROVIDER.test(catalog.provider) || typeof catalog.modelId !== "string" || !CATALOG_MODEL.test(catalog.modelId)) return undefined;
    names.add(m.name);
    models.push({ name: m.name, catalog: { provider: catalog.provider, modelId: catalog.modelId } });
  }
  return { scheme: "openai_compatible", baseUrl: c.baseUrl as string, key: c.key, models };
}

export function serializeEndpointConnection(c: EndpointConnection): string {
  return JSON.stringify({ scheme: c.scheme, baseUrl: c.baseUrl, key: c.key, models: c.models.map((m) => ({ name: m.name, catalog: { provider: m.catalog.provider, modelId: m.catalog.modelId } })) });
}

/** Per-try timeout of the endpoint resolver (one try each for A and AAAA). */
export const ENDPOINT_RESOLVE_TRY_MS = 2_000;
/** The DNS answers a name that exists but has no record of that type gives: no addresses of that family, not a failure. */
const NO_RECORDS = new Set(["ENODATA", "ENOTFOUND"]);
/** What the endpoint resolver needs from c-ares (node:dns promises Resolver): A, AAAA, and cancelling what is in flight. */
export interface DnsResolverLike { resolve4(hostname: string): Promise<string[]>; resolve6(hostname: string): Promise<string[]>; cancel(): void }
/**
 * A3-REVIEW-1 M1: a fresh c-ares resolver per call. Unlike dns.lookup (getaddrinfo on libuv's 4-thread pool, shared with the gateway's own
 * DynamoDB and KMS calls), c-ares does not use the thread pool, so a nameserver that never answers cannot starve the rest of the process.
 */
export const defaultDnsResolver = (): DnsResolverLike => new dns.promises.Resolver({ timeout: ENDPOINT_RESOLVE_TRY_MS, tries: 1 });

/**
 * The endpoint resolver: A and AAAA through c-ares, every address returned (IPv4 first), bounded in time. A family with no records is
 * empty; any other DNS error (SERVFAIL, timeout, refused) throws, so the call is refused, never half-resolved. Abort or the overall timer
 * cancels the lookups in flight.
 */
export function caresResolver(make: () => DnsResolverLike = defaultDnsResolver, totalMs = ENDPOINT_RESOLVE_MS): EndpointResolver {
  return async (hostname, signal) => {
    const resolver = make();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const family = async (lookup: Promise<string[]>, kind: 4 | 6) => {
      try { return (await lookup).map((address) => ({ address, family: kind })); }
      catch (error) { if (NO_RECORDS.has(String((error as { code?: unknown } | null)?.code))) return []; throw new Error("resolve failed", { cause: error }); }
    };
    try {
      const stop = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("resolve timeout")), totalMs);
        onAbort = () => reject(new Error("aborted"));
        if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true });
      });
      const answers = await Promise.race([Promise.all([family(resolver.resolve4(hostname), 4), family(resolver.resolve6(hostname), 6)]), stop]);
      return [...answers[0], ...answers[1]];
    } finally {
      clearTimeout(timer);
      if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
      try { resolver.cancel(); } catch { /* nothing in flight */ }
    }
  };
}
/** The deployed resolver (c-ares). */
export const systemResolver: EndpointResolver = caresResolver();

/**
 * A3-REVIEW-1 M1: at most this many endpoint name resolutions at once per company, and per serving process. Past either, the call is
 * refused as not sent ($0) with ENDPOINT_BUSY's fixed words.
 */
export const ENDPOINT_RESOLVES_PER_COMPANY = 2;
export const ENDPOINT_RESOLVES_PER_PROCESS = 16;
export class EndpointResolveLimiter {
  #total = 0; readonly #byCompany = new Map<string, number>();
  constructor(private readonly perCompany = ENDPOINT_RESOLVES_PER_COMPANY, private readonly perProcess = ENDPOINT_RESOLVES_PER_PROCESS) {}
  /** A release function, or undefined when the company or the process is at its limit. */
  take(company: string): (() => void) | undefined {
    const mine = this.#byCompany.get(company) ?? 0;
    if (mine >= this.perCompany || this.#total >= this.perProcess) return undefined;
    this.#byCompany.set(company, mine + 1); this.#total += 1;
    let released = false;
    return () => {
      if (released) return; released = true;
      this.#total -= 1;
      const left = (this.#byCompany.get(company) ?? 1) - 1;
      if (left <= 0) this.#byCompany.delete(company); else this.#byCompany.set(company, left);
    };
  }
}
/** The serving process's one limiter. */
export const processResolveLimiter = new EndpointResolveLimiter();

export type EndpointRefusal = "address" | "busy";
export interface EndpointTransportOptions {
  resolve?: EndpointResolver; request?: typeof https.request;
  /** Told why the call was refused before sending: the address check, or too many resolutions at once (the route answers its own words). */
  onRefused?: (reason: EndpointRefusal) => void;
  /** The company the call is for (the limiter's per-company count) and the limiter. Default: an unnamed company on the process limiter. */
  company?: string; limiter?: EndpointResolveLimiter;
}

/**
 * The transport for ONE company's endpoint: the target's path only; the name resolved now and every address checked; the socket pinned
 * to the checked address (SNI and Host stay the name, so TLS proves it); TLS verified; port 443; one attempt; no redirect following; the
 * key only as a bearer token. A refused address is "not sent" ($0). A 2xx answer is translated (agent-openai.ts); any other status passes
 * through for the route to classify, unread here.
 */
export function createEndpointTransport(target: EndpointTarget, options: EndpointTransportOptions = {}): ProviderTransport {
  const resolve = options.resolve ?? systemResolver;
  const request = options.request ?? https.request;
  return async (input) => {
    if (input.signal.aborted || input.path !== target.path) throw new NotSentError();
    let facts: { model: string; streaming: boolean };
    try { facts = bodyFacts(input.body); } catch { throw new NotSentError(); }
    const release = (options.limiter ?? processResolveLimiter).take(options.company ?? "");
    if (release === undefined) { options.onRefused?.("busy"); throw new NotSentError(); }
    let pinned: Awaited<ReturnType<typeof checkedAddress>>;
    try { pinned = await checkedAddress(target, resolve, input.signal); } finally { release(); }
    if (pinned === undefined) { options.onRefused?.("address"); throw new NotSentError(); }
    if (input.signal.aborted) throw new NotSentError();
    return new Promise((done, reject) => {
      let connected = false;
      const fail = () => reject(connected ? new Error("provider unavailable") : new NotSentError());
      let call: ClientRequest;
      try {
        call = request({
          hostname: target.hostname, ...(target.literal ? {} : { servername: target.hostname }), lookup: pinnedLookup(pinned.address, pinned.family),
          port: 443, path: target.path, method: "POST", agent: false, rejectUnauthorized: true,
          headers: { "content-type": "application/json", authorization: `Bearer ${input.key}`, "content-length": String(input.body.byteLength) },
        }, (response) => {
          const status = response.statusCode ?? 0;
          const cancel = () => response.destroy();
          const raw = response as AsyncIterable<Uint8Array>;
          if (status < 200 || status >= 300) { done({ status, body: raw, cancel }); return; }
          done(translatedAnswer("endpoint", facts, status, raw, cancel));
        });
      } catch { reject(new NotSentError()); return; }
      const abort = () => { call.destroy(); fail(); };
      call.once("socket", (socket) => socket.once("secureConnect", () => { connected = true; }));
      call.once("error", fail);
      call.once("close", () => input.signal.removeEventListener("abort", abort));
      input.signal.addEventListener("abort", abort, { once: true });
      if (input.signal.aborted) abort();
      else { try { call.end(input.body); } catch { call.destroy(); fail(); } }
    });
  };
}
