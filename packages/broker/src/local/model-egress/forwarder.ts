// TE-F1c (te-f1 design 7, SSRF): the laptop's in-process FORWARDER, the one place the laptop's model call leaves the process. It is the transport the laptop adapter hands the core's checked request to.
//
// On EVERY call (a DNS answer changes, and so does a host's owner): the host must be a plain public name (F1-a's `lookupNameFor`), it is resolved here (the fully qualified name, so the machine's search domains never apply), and
// `planConnection` refuses the call when ANY address in the answer is private, loopback, link-local or reserved (one private address among public ones is a rebinding or split-horizon attempt, not a choice to make) or the name is
// under a denied suffix. The connection goes to the ADDRESS that was checked (the connection never resolves again), with the row's host as the TLS name and the certificate verified against it: https only, port 443 only. A 3xx
// is handed back as it is and NEVER followed (the adapter turns it into a refusal).
//
// Faults are two fixed errors (`EgressSsrfError`, `EgressUnreachableError`) that carry no word from the system or the provider. The lookup and the request are injected so tests open no socket.
import dns from "node:dns";
import https from "node:https";
import type { OutboundRequest } from "@agentx/contracts";
import { MODEL_EGRESS_DENIED_SUFFIXES, lookupNameFor, planConnection } from "@agentx/contracts";

export class EgressSsrfError extends Error {
  constructor() {
    super("the provider address was refused");
    this.name = "EgressSsrfError";
  }
}
export class EgressUnreachableError extends Error {
  constructor() {
    super("the provider could not be reached");
    this.name = "EgressUnreachableError";
  }
}

export type LaptopHttpsRequest = typeof https.request;

export interface ProviderResponse {
  readonly status: number;
  readonly headers: Array<[string, string]>;
  readonly body: AsyncIterable<Uint8Array>;
}
/** The transport the adapter calls: the same shape the conformance suite's fake provider has. */
export type ProviderTransport = (request: OutboundRequest, signal?: AbortSignal) => Promise<ProviderResponse>;

export interface LaptopTransportOptions {
  /** Every address of a name. Default: the system resolver (`all`, as it answers). */
  readonly lookup?: (name: string) => Promise<readonly string[]>;
  /** `https.request`. Injected in tests. */
  readonly request?: LaptopHttpsRequest;
  /** The most response bytes read from one call. Default 10 MB (the design's response limit). */
  readonly responseBytesMax?: number;
  /** A call's total time. Default 10 minutes. */
  readonly totalMs?: number;
}

const systemLookup = async (name: string): Promise<readonly string[]> => (await dns.promises.lookup(name, { all: true, verbatim: true })).map((entry) => entry.address);

export function createLaptopTransport(options: LaptopTransportOptions = {}): ProviderTransport {
  const lookup = options.lookup ?? systemLookup;
  const httpsRequest = options.request ?? https.request;
  const responseMax = options.responseBytesMax ?? 10 * 1024 * 1024;
  const totalMs = options.totalMs ?? 10 * 60 * 1000;

  return async (request, signal) => {
    const name = lookupNameFor(request.host);
    if (name === undefined || MODEL_EGRESS_DENIED_SUFFIXES.some((suffix) => request.host === suffix || request.host.endsWith(`.${suffix}`))) throw new EgressSsrfError();
    if (signal?.aborted === true) throw new EgressUnreachableError();
    let answers: readonly string[];
    try {
      answers = await lookup(name);
    } catch {
      throw new EgressUnreachableError();
    }
    const plan = planConnection(request.host, answers);
    if (!plan.ok) throw new EgressSsrfError();

    const headers: Record<string, string> = { host: request.host };
    for (const [headerName, value] of request.headers) headers[headerName] = value;
    headers["content-length"] = String(request.body.byteLength);
    const path = request.query.length === 0 ? request.path : `${request.path}?${request.query}`;

    const incoming = await new Promise<NonNullable<Parameters<Parameters<LaptopHttpsRequest>[1] & ((response: never) => void)>[0]>>((resolve, reject) => {
      let settled = false;
      const fail = (): void => { if (!settled) { settled = true; reject(new EgressUnreachableError()); } };
      const call = httpsRequest(
        { host: plan.address, port: plan.port, servername: plan.tlsServerName, method: request.method, path, headers, agent: false, rejectUnauthorized: true },
        (response) => { settled = true; resolve(response as never); },
      );
      const timer = setTimeout(() => { call.destroy(); fail(); }, totalMs);
      call.on("error", () => { clearTimeout(timer); fail(); });
      const onAbort = (): void => { call.destroy(); fail(); };
      signal?.addEventListener("abort", onAbort, { once: true });
      call.on("close", () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); });
      call.end(Buffer.from(request.body.buffer, request.body.byteOffset, request.body.byteLength));
    });

    const responseHeaders: Array<[string, string]> = [];
    for (const [headerName, value] of Object.entries((incoming as { headers: Record<string, string | string[] | undefined> }).headers)) {
      if (typeof value === "string") responseHeaders.push([headerName, value]);
      else if (Array.isArray(value)) for (const item of value) responseHeaders.push([headerName, item]);
    }
    const source = incoming as unknown as AsyncIterable<Uint8Array> & { statusCode?: number; destroy(): void };
    return {
      status: source.statusCode ?? 0,
      headers: responseHeaders,
      body: (async function* () {
        let total = 0;
        try {
          for await (const part of source) {
            total += part.byteLength;
            if (total > responseMax) {
              source.destroy();
              throw new EgressUnreachableError();
            }
            yield part;
          }
        } catch (error) {
          throw error instanceof EgressUnreachableError ? error : new EgressUnreachableError();
        }
      })(),
    };
  };
}
