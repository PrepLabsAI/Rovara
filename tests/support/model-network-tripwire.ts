// TE-F2 part B test support: the network tripwire of the required "no request reaches a real model host" test. While installed:
//   - a NAME in `resolver` (the model hosts the block points at the helper, as F1-b's `--add-host` does) resolves to the loopback helper, and the dial is REWRITTEN to the helper's own port for 443 or 80 (privileged ports cannot
//     be bound in a test); the dial is logged by name and port;
//   - any other connect, DNS lookup, `http(s).request` or `fetch` to a non-loopback name or address is REFUSED (it throws) and recorded in `refused`: the test fails if `refused` is not empty;
//   - every socket that is really opened is opened to a loopback address (asserted at the lowest door).
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

export interface TripwireDial {
  readonly host: string;
  readonly port: number;
}
export interface TripwireRefusal {
  readonly door: "socket" | "dns" | "http" | "https" | "fetch";
  readonly target: string;
}
export interface ModelNetworkTripwire {
  readonly dials: TripwireDial[];
  readonly refused: TripwireRefusal[];
  /** Every address a real socket was opened to (all of them must be loopback). */
  readonly opened: string[];
  restore(): void;
}

const isLoopback = (host: string | undefined): boolean => host !== undefined && (host === "localhost" || host === "::1" || host === "[::1]" || /^127\./u.test(host));

export function installModelNetworkTripwire(input: { readonly resolver: ReadonlySet<string>; readonly ports: { readonly 443: number; readonly 80: number } }): ModelNetworkTripwire {
  const dials: TripwireDial[] = [];
  const refused: TripwireRefusal[] = [];
  const opened: string[] = [];
  const refuse = (door: TripwireRefusal["door"], target: string): never => {
    refused.push({ door, target });
    throw new Error(`network tripwire: a ${door} call to ${target} was refused`);
  };

  // eslint-disable-next-line @typescript-eslint/unbound-method -- put back as it was
  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function patched(this: net.Socket, ...args: unknown[]) {
    const first = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
    let host: string | undefined;
    let port: number | undefined;
    let rebuilt: unknown[] = args;
    if (typeof first === "object" && first !== null) {
      const options = first as { host?: string; port?: number; path?: string };
      if (typeof options.path === "string") return Reflect.apply(originalConnect, this, args) as net.Socket;
      host = options.host ?? "localhost";
      port = Number(options.port);
      if (input.resolver.has(host)) {
        dials.push({ host, port });
        const mapped = port === 443 ? input.ports[443] : port === 80 ? input.ports[80] : port;
        // in place: Node marks its normalised argument array with a symbol that a copy would lose
        options.host = "127.0.0.1";
        options.port = mapped;
        host = "127.0.0.1";
      }
    } else if (typeof first === "number") {
      host = typeof args[1] === "string" ? args[1] : "localhost";
      port = first;
      if (input.resolver.has(host)) {
        dials.push({ host, port });
        rebuilt = [port === 443 ? input.ports[443] : port === 80 ? input.ports[80] : port, "127.0.0.1", ...args.slice(2)];
        host = "127.0.0.1";
      }
    } else return Reflect.apply(originalConnect, this, args) as net.Socket;
    if (!isLoopback(host)) refuse("socket", host ?? "unknown");
    opened.push(host ?? "unknown");
    return Reflect.apply(originalConnect, this, rebuilt) as net.Socket;
  };

  const originalLookup = dns.lookup;
  (dns as { lookup: unknown }).lookup = ((host: string, ...rest: unknown[]) => {
    if (!isLoopback(host) && !input.resolver.has(host)) refuse("dns", host);
    return Reflect.apply(originalLookup, dns, [host, ...rest]) as unknown;
  });

  const hostOf = (args: unknown[]): string => {
    const value = args[0];
    if (typeof value === "string") {
      try {
        return new URL(value).hostname;
      } catch {
        return value;
      }
    }
    if (value instanceof URL) return value.hostname;
    const options = value as { hostname?: string; host?: string } | undefined;
    return options?.hostname ?? options?.host ?? "localhost";
  };
  const restorers: Array<() => void> = [];
  for (const [module, door] of [[http, "http"], [https, "https"]] as const) {
    const originalRequest = module.request;
    (module as { request: unknown }).request = (...args: unknown[]) => {
      const host = hostOf(args);
      if (!isLoopback(host) && !input.resolver.has(host)) refuse(door, host);
      return Reflect.apply(originalRequest, module, args) as unknown;
    };
    restorers.push(() => {
      (module as { request: unknown }).request = originalRequest;
    });
  }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((fetchInput: unknown, init?: unknown): Promise<Response> => {
    let host = "unparseable";
    try {
      host = new URL(typeof fetchInput === "string" ? fetchInput : fetchInput instanceof URL ? fetchInput.href : (fetchInput as { url: string }).url).hostname;
    } catch {
      // unparseable: refused below
    }
    if (!isLoopback(host) && !input.resolver.has(host)) return Promise.resolve().then(() => refuse("fetch", host));
    return Reflect.apply(originalFetch, globalThis, [fetchInput, init]) as Promise<Response>;
  });

  return {
    dials,
    refused,
    opened,
    restore() {
      net.Socket.prototype.connect = originalConnect;
      (dns as { lookup: unknown }).lookup = originalLookup;
      for (const restoreOne of restorers) restoreOne();
      globalThis.fetch = originalFetch;
    },
  };
}
