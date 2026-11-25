// DEC 254t (a), row A3: the SSRF guard for a company's own OpenAI-compatible endpoint (`custom_endpoint`). The gateway runs inside
// Rovara's network with its own credentials nearby (the ECS task metadata at 169.254.170.2, the instance metadata at 169.254.169.254
// and fd00:ec2::254, the VPC resolver, other tasks), so an address a company types is never trusted:
//   - the address: https only, port 443 only, no user or password, no query or fragment, a host name with a dot (or an IP literal that
//     passes the address check below); checked when it is saved AND again on every call;
//   - the call: the name is resolved at CALL time and refused if ANY address it resolves to is not a public unicast address
//     (endpointAddressProblem, tested address by address); the connection then goes to the checked address only (a pinned lookup,
//     SNI and Host stay the name, so TLS still proves the name), so a DNS rebind between the check and the connect cannot swap it;
//   - never a redirect (Node's https.request follows none; a 3xx answer is an error answer), and the money core's deadline and byte
//     limit bound time and size.
// Every refusal is fixed words that never repeat the address.
import { isIP } from "node:net";
import type { LookupAddress, LookupOptions } from "node:dns";

/** Fixed words for an endpoint address the guard refuses (never the address itself). */
export const ENDPOINT_ADDRESS_REFUSED = "This address can't be used: it must be an https address on port 443 of a public host.";

/** IPv4 ranges that are not public unicast: [first octets as a 32-bit number, prefix length]. */
const V4_REFUSED: ReadonlyArray<[string, number]> = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // RFC 1918
  ["100.64.0.0", 10], // shared address space (carrier NAT)
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local: 169.254.169.254 (instance metadata), 169.254.170.2 (ECS task metadata)
  ["172.16.0.0", 12], // RFC 1918
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // RFC 1918
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, and 255.255.255.255 broadcast
];

function v4Number(address: string): number | undefined {
  const parts = address.split(".");
  if (parts.length !== 4 || !parts.every((p) => /^(?:0|[1-9]\d{0,2})$/u.test(p) && Number(p) <= 255)) return undefined;
  return parts.reduce((n, p) => n * 256 + Number(p), 0);
}
function inV4(n: number, base: string, prefix: number): boolean {
  const start = v4Number(base)!;
  const size = 2 ** (32 - prefix);
  return n >= start && n < start + size;
}
function v4Refused(address: string): boolean {
  const n = v4Number(address);
  return n === undefined || V4_REFUSED.some(([base, prefix]) => inV4(n, base, prefix));
}

/** An IPv6 address as 16 bytes (an embedded dotted IPv4 tail included). undefined: not an IPv6 address this guard can read. */
function v6Bytes(address: string): number[] | undefined {
  if (address.includes("%")) return undefined; // zone ids name an interface: never public
  let text = address;
  let tail: number[] = [];
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/u.exec(text);
  if (dotted !== null) {
    const n = v4Number(dotted[1]!);
    if (n === undefined) return undefined;
    tail = [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
    text = `${text.slice(0, dotted.index)}0:0`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const group = (s: string) => s === "" ? [] : s.split(":");
  const head = group(halves[0]!); const rest = halves.length === 2 ? group(halves[1]!) : [];
  if (![...head, ...rest].every((g) => /^[0-9a-f]{1,4}$/iu.test(g))) return undefined;
  const missing = 8 - head.length - rest.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return undefined;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest].map((g) => parseInt(g, 16));
  const bytes = groups.flatMap((g) => [(g >> 8) & 255, g & 255]);
  if (tail.length === 4) bytes.splice(12, 4, ...tail);
  return bytes.length === 16 ? bytes : undefined;
}
const prefixMatch = (bytes: readonly number[], prefix: readonly number[], bits: number) => {
  for (let i = 0; i < bits; i += 1) {
    const byte = Math.floor(i / 8); const bit = 7 - (i % 8);
    if (((bytes[byte]! >> bit) & 1) !== ((prefix[byte] ?? 0) >> bit & 1)) return false;
  }
  return true;
};
/** IPv6 prefixes inside 2000::/3 that are still not public unicast. Everything outside 2000::/3 is refused outright. */
const V6_REFUSED_IN_GLOBAL: ReadonlyArray<[number[], number]> = [
  [[0x20, 0x01, 0x00, 0x00], 23], // IETF protocol assignments: Teredo 2001::/32, benchmarking, ORCHID
  [[0x20, 0x01, 0x0d, 0xb8], 32], // documentation
  [[0x20, 0x02], 16], // 6to4 (an IPv4 address inside, possibly a private one)
  [[0x3f, 0xff], 20], // documentation (2024)
];
function v6Refused(address: string): boolean {
  const bytes = v6Bytes(address);
  if (bytes === undefined) return true;
  // Only global unicast (2000::/3). This alone refuses ::, ::1, IPv4-compatible ::a.b.c.d, IPv4-mapped ::ffff:a.b.c.d, NAT64 64:ff9b::/96,
  // discard 100::/64, ULA fc00::/7 (fd00:ec2::254 included), link-local fe80::/10, site-local fec0::/10 and multicast ff00::/8.
  if (!prefixMatch(bytes, [0x20], 3)) return true;
  return V6_REFUSED_IN_GLOBAL.some(([prefix, bits]) => prefixMatch(bytes, prefix, bits));
}

/** True when `address` (an IP address as DNS or a URL gives it) is NOT a public unicast address; anything unreadable is refused. */
export function endpointAddressProblem(address: string): boolean {
  const bare = address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
  const family = isIP(bare);
  if (family === 4) return v4Refused(bare);
  if (family === 6) return v6Refused(bare);
  return true;
}

export interface EndpointTarget { hostname: string; path: string; literal: boolean }
const HOST_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/u;
/**
 * A company's endpoint base URL, checked: https, port 443, no user/password, no query/fragment, a public IP literal or a host name with
 * a dot that is not a local name. The base path (e.g. `/v1`) is kept; `/chat/completions` is added to it. undefined: refused.
 */
export function endpointTarget(baseUrl: unknown): EndpointTarget | undefined {
  // Dot segments (plain or encoded) are refused as written, before the URL parser quietly resolves them.
  if (typeof baseUrl !== "string" || baseUrl.length > 2048 || /[\s\0\\]/u.test(baseUrl) || /%2e|\/\.\.?(?:\/|$)/iu.test(baseUrl)) return undefined;
  let url: URL;
  try { url = new URL(baseUrl); } catch { return undefined; }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || (url.port !== "" && url.port !== "443") || url.search !== "" || url.hash !== "" || baseUrl.includes("@")) return undefined;
  const host = url.hostname.toLowerCase();
  const literal = isIP(host.startsWith("[") ? host.slice(1, -1) : host) !== 0;
  if (literal) { if (endpointAddressProblem(host)) return undefined; }
  else {
    const name = host.endsWith(".") ? host.slice(0, -1) : host;
    const labels = name.split(".");
    if (labels.length < 2 || !labels.every((l) => HOST_LABEL.test(l)) || /^\d+$/u.test(labels.at(-1)!)) return undefined;
    if (["localhost", "local", "internal", "localdomain", "home.arpa", "intranet", "lan", "corp"].some((suffix) => name === suffix || name.endsWith(`.${suffix}`))) return undefined;
  }
  const base = url.pathname.replace(/\/+$/u, "");
  if (base.length > 512 || !/^(?:\/[A-Za-z0-9._~-]+)*$/u.test(base) || base.split("/").some((s) => s === "." || s === "..")) return undefined;
  return { hostname: host.startsWith("[") ? host.slice(1, -1) : host, path: `${base}/chat/completions`, literal };
}

/** How the gateway resolves a name: every address it answers (the system resolver by default, injected in tests). */
export type EndpointResolver = (hostname: string, signal: AbortSignal) => Promise<ReadonlyArray<{ address: string; family: number }>>;
export const ENDPOINT_MAX_ADDRESSES = 32;
export const ENDPOINT_RESOLVE_MS = 5_000;

/**
 * Resolves the name now and returns the one address to connect to, or undefined when the name has no address, too many, or ANY
 * address that is not public unicast (an attacker controls every answer of their own name, so one bad answer refuses all).
 */
export async function checkedAddress(target: EndpointTarget, resolve: EndpointResolver, signal: AbortSignal): Promise<{ address: string; family: 4 | 6 } | undefined> {
  if (target.literal) return endpointAddressProblem(target.hostname) ? undefined : { address: target.hostname, family: isIP(target.hostname) === 6 ? 6 : 4 };
  let raw: unknown;
  try { raw = await resolve(target.hostname, signal); } catch { return undefined; }
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > ENDPOINT_MAX_ADDRESSES) return undefined;
  const addresses: string[] = [];
  for (const answer of raw as unknown[]) {
    const address = (answer as { address?: unknown } | null)?.address;
    if (typeof address !== "string" || endpointAddressProblem(address)) return undefined;
    addresses.push(address);
  }
  // A3-REVIEW-1 L1: pin an IPv4 answer when there is one (the gateway's network has no IPv6); every answer was checked above either way.
  const first = addresses.find((address) => isIP(address) === 4) ?? addresses[0]!;
  return { address: first, family: isIP(first) === 6 ? 6 : 4 };
}

/** A `lookup` for the connection that only ever answers the checked address: the socket cannot reach anything else. */
export function pinnedLookup(address: string, family: 4 | 6): (hostname: string, options: LookupOptions, callback: (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void) => void {
  return (_hostname, options, callback) => {
    if (options.all === true) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}
