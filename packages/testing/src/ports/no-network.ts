// A tripwire for "no request reaches a real model host": while it is installed, any attempt to open a socket to a non-loopback address, to resolve a name, to make an `http(s).request` or a `fetch` to anything but loopback is
// RECORDED and REFUSED (it throws, so the code under test sees a failure and the test sees the attempt). It stubs the lowest door, `net.Socket.prototype.connect` (every `net`, `tls`, `http`, `https` and `undici` connection goes
// through it), plus `dns.lookup`, `http.request`, `https.request` and `globalThis.fetch` so the attempt is named even before a socket is made.
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

export interface NetworkAttempt {
  readonly door: "socket" | "dns" | "http" | "https" | "fetch";
  /** The host or address asked for, as text (a unix socket path is `unix`). Never a header or a body. */
  readonly target: string;
}

export interface NetworkTripwire {
  readonly attempts: readonly NetworkAttempt[];
  restore(): void;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);
const isLoopbackHost = (host: string | undefined): boolean => host !== undefined && (LOOPBACK.has(host) || /^127\./u.test(host));

/** The host a `net` connect call names, from its many argument forms. */
function connectTarget(args: unknown[]): string {
  // `net.connect` hands the socket its normalised arguments as ONE array: `[options, callback]`.
  const first = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
  if (typeof first === "object" && first !== null) {
    const options = first as { host?: string; path?: string };
    if (typeof options.path === "string") return "unix";
    return options.host ?? "localhost";
  }
  if (typeof first === "string") return "unix";
  return typeof args[1] === "string" ? args[1] : "localhost";
}

/** Installs the tripwire. Call `restore()` in a `finally`; installing twice without restoring is refused. */
export function installNetworkTripwire(): NetworkTripwire {
  if ((globalThis as { __rovaraTripwire?: boolean }).__rovaraTripwire === true) throw new Error("the network tripwire is already installed");
  (globalThis as { __rovaraTripwire?: boolean }).__rovaraTripwire = true;
  const attempts: NetworkAttempt[] = [];
  const refuse = (door: NetworkAttempt["door"], target: string): never => {
    attempts.push({ door, target });
    throw new Error(`network tripwire: a ${door} call to ${target} was refused`);
  };

  // eslint-disable-next-line @typescript-eslint/unbound-method -- the original is put back as it was, and called with the real socket as `this`
  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function patched(this: net.Socket, ...args: unknown[]) {
    const target = connectTarget(args);
    if (target !== "unix" && !isLoopbackHost(target)) refuse("socket", target);
    return Reflect.apply(originalConnect, this, args) as net.Socket;
  };

  const originalLookup = dns.lookup;
  (dns as { lookup: unknown }).lookup = ((host: string, ...rest: unknown[]) => {
    if (!isLoopbackHost(host)) refuse("dns", host);
    return Reflect.apply(originalLookup, dns, [host, ...rest]) as unknown;
  });

  const wrapRequest = (module: typeof http | typeof https, door: "http" | "https") => {
    const originalRequest = module.request;
    const originalGet = module.get;
    const hostOf = (args: unknown[]): string => {
      const first = args[0];
      if (typeof first === "string") {
        try {
          return new URL(first).hostname;
        } catch {
          return first;
        }
      }
      if (first instanceof URL) return first.hostname;
      const options = first as { hostname?: string; host?: string } | undefined;
      return options?.hostname ?? options?.host ?? "localhost";
    };
    (module as { request: unknown }).request = ((...args: unknown[]) => {
      const host = hostOf(args);
      if (!isLoopbackHost(host)) refuse(door, host);
      return Reflect.apply(originalRequest, module, args) as unknown;
    });
    (module as { get: unknown }).get = ((...args: unknown[]) => {
      const host = hostOf(args);
      if (!isLoopbackHost(host)) refuse(door, host);
      return Reflect.apply(originalGet, module, args) as unknown;
    });
    return () => {
      (module as { request: unknown }).request = originalRequest;
      (module as { get: unknown }).get = originalGet;
    };
  };
  const restoreHttp = wrapRequest(http, "http");
  const restoreHttps = wrapRequest(https, "https");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: unknown) => {
    let host = "localhost";
    try {
      host = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : (input as { url: string }).url).hostname;
    } catch {
      host = "unparseable";
    }
    if (!isLoopbackHost(host)) return Promise.resolve().then(() => refuse("fetch", host));
    return Reflect.apply(originalFetch, globalThis, [input, init]) as Promise<Response>;
  });

  return {
    attempts,
    restore() {
      net.Socket.prototype.connect = originalConnect;
      (dns as { lookup: unknown }).lookup = originalLookup;
      restoreHttp();
      restoreHttps();
      globalThis.fetch = originalFetch;
      (globalThis as { __rovaraTripwire?: boolean }).__rovaraTripwire = false;
    },
  };
}

/** Runs `body` under the tripwire and returns what it attempted; always restores. */
export async function withNetworkTripwire<T>(body: () => Promise<T>): Promise<{ result: T | undefined; error: unknown; attempts: readonly NetworkAttempt[] }> {
  const tripwire = installNetworkTripwire();
  try {
    return { result: await body(), error: undefined, attempts: [...tripwire.attempts] };
  } catch (error) {
    return { result: undefined, error, attempts: [...tripwire.attempts] };
  } finally {
    tripwire.restore();
  }
}
