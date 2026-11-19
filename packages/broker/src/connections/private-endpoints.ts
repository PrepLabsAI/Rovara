// The check an MCP server on the owner's own network passes before the broker calls it, in place of the "public addresses only" rule of checkEndpointUrl (endpoint-check.ts, which
// keeps applying to a connection's public address unchanged).
//
// A public connection's token goes only to a public host. A server on the owner's own network has a private address. What stands between a pasted address and the rest of the network is,
// in order:
//   1. the operator's ranges (`ROVARA_PRIVATE_MCP_CIDRS`): with none named every private server is refused;
//   2. the allow-list: the host and port of an entry an admin approved. Nothing else is called;
//   3. the addresses the host resolves to: none may be one Rovara never calls (this machine, link-local and metadata addresses, multicast), and, when the entry names
//      ranges, each must be inside one;
//   4. the connection itself, which is pinned to the addresses that were checked (pinned-endpoint.ts), so a name that changes its answer between the check and the
//      connection is not reached.
// Addresses on the never-called list stay refused whatever the allow-list says: an admin's approval cannot reach the instance metadata service.
import { BlockList, isIP } from "node:net";
import { agentXError } from "@agentx/contracts";
import { dnsResolveHost, type CheckedEndpoint, type ResolveHost } from "./endpoint-check.js";
import { pinnedFetch, type McpEndpointGuard, type RequestFunction } from "./pinned-endpoint.js";

const NEVER: ReadonlyArray<[string, number, "ipv4" | "ipv6"]> = [
  ["0.0.0.0", 8, "ipv4"], ["127.0.0.0", 8, "ipv4"], ["169.254.0.0", 16, "ipv4"], ["224.0.0.0", 4, "ipv4"], ["240.0.0.0", 4, "ipv4"],
  ["::", 128, "ipv6"], ["::1", 128, "ipv6"], ["fe80::", 10, "ipv6"], ["ff00::", 8, "ipv6"], ["fd00:ec2::", 32, "ipv6"],
  // Other metadata services, and the IPv6 forms that carry an IPv4 address inside (so 169.254.169.254 cannot be written another way): NAT64, IPv4-compatible, 6to4, Teredo.
  ["100.100.100.200", 32, "ipv4"], ["64:ff9b::", 96, "ipv6"], ["64:ff9b:1::", 48, "ipv6"], ["::", 96, "ipv6"], ["2002::", 16, "ipv6"], ["2001::", 32, "ipv6"],
];
const NEVER_LIST = (() => {
  const list = new BlockList();
  for (const [network, prefix, family] of NEVER) list.addSubnet(network, prefix, family);
  return list;
})();

/** Addresses Rovara never calls, an admin's approval notwithstanding. An address that does not parse is one too. */
export function isNeverCalledAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  // An IPv4 address written as IPv6 (::ffff:169.254.169.254) is judged by its IPv4 address.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/iu.exec(address);
  if (mapped?.[1] !== undefined) return NEVER_LIST.check(mapped[1], "ipv4");
  return NEVER_LIST.check(address, family === 4 ? "ipv4" : "ipv6");
}

/** The private ranges an install may point at (RFC 1918, shared address space as EKS uses it, unique local). */
const PRIVATE_RANGES: ReadonlyArray<[string, number, "ipv4" | "ipv6"]> = [["10.0.0.0", 8, "ipv4"], ["172.16.0.0", 12, "ipv4"], ["192.168.0.0", 16, "ipv4"], ["100.64.0.0", 10, "ipv4"], ["fc00::", 7, "ipv6"]];

/**
 * The install-level ranges the operator sets once (`ROVARA_PRIVATE_MCP_CIDRS`, comma separated), outside which no private MCP server is tested or called. Each must lie
 * inside a private range: a public range, a broad one, or a loopback/link-local range is a mistake and stops the install, never a silent widening. Unset gives none,
 * and then every test and call is refused.
 */
export function parseInstallCidrs(raw: string | undefined, rovaraCidrs: readonly string[] = [], name = "ROVARA_PRIVATE_MCP_CIDRS"): string[] {
  if (raw === undefined || raw.trim() === "") return [];
  return raw.split(",").map((part) => part.trim()).filter((part) => part !== "").map((cidr) => {
    const [network, prefixText, extra] = cidr.split("/");
    const family = network === undefined ? 0 : isIP(network);
    if (network === undefined || prefixText === undefined || extra !== undefined || family === 0 || !/^\d{1,3}$/u.test(prefixText)) throw agentXError("CONFIG_INVALID", `${name}: "${cidr.slice(0, 60)}" is not a range such as 10.0.0.0/8`);
    const prefix = Number(prefixText);
    const inside = PRIVATE_RANGES.some(([base, basePrefix, baseFamily]) => {
      if (baseFamily !== (family === 4 ? "ipv4" : "ipv6") || prefix < basePrefix || prefix > (family === 4 ? 32 : 128)) return false;
      const list = new BlockList();
      list.addSubnet(base, basePrefix, baseFamily);
      return list.check(network, baseFamily);
    });
    if (!inside || isNeverCalledAddress(network)) throw agentXError("CONFIG_INVALID", `${name}: "${cidr.slice(0, 60)}" is not inside a private range`);
    // The network Rovara itself runs in is never a place for a customer's MCP server: a range that contains it, sits inside it or equals it is a mistake that would let a test
    // of a pasted address find the install's own services.
    if (rovaraCidrs.some((own) => cidrsOverlap(cidr, own))) throw agentXError("CONFIG_INVALID", `${name}: "${cidr.slice(0, 60)}" overlaps the network Rovara itself runs in`);
    return cidr;
  });
}

/** Whether two ranges share an address. Ranges nest, so they do exactly when one contains the other's first address. Ranges that do not parse overlap everything (fail closed). */
export function cidrsOverlap(a: string, b: string): boolean {
  const first = (cidr: string): { network: string; family: "ipv4" | "ipv6" } | undefined => {
    const [network, prefix] = cidr.split("/");
    const family = network === undefined ? 0 : isIP(network);
    return network === undefined || prefix === undefined || family === 0 ? undefined : { network, family: family === 4 ? "ipv4" : "ipv6" };
  };
  const left = first(a), right = first(b);
  if (left === undefined || right === undefined) return true;
  if (left.family !== right.family) return false;
  const listA = cidrBlockList([a]), listB = cidrBlockList([b]);
  if (listA === undefined || listB === undefined) return true;
  return listA.check(right.network, right.family) || listB.check(left.network, left.family);
}

/** Whether an address lies inside any of the ranges (an IPv4 address written as IPv6 is judged by its IPv4 address). */
function insideAnyRange(address: string, cidrs: readonly string[]): boolean {
  if (cidrs.length === 0) return false;
  const list = cidrBlockList(cidrs);
  // Ranges that do not parse count as containing everything: the address is then refused, never let through.
  if (list === undefined) return true;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/iu.exec(address);
  if (mapped?.[1] !== undefined) return list.check(mapped[1], "ipv4");
  return list.check(address, isIP(address) === 4 ? "ipv4" : "ipv6");
}

export interface AllowedTarget {
  host: string;
  port: number;
  /** When set, every address the host resolves to must be inside one of these ranges (`10.2.0.0/16`). */
  cidrs?: readonly string[] | undefined;
}

const HOST_NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/u;

/** The host and port of an address an admin pasted, or the reason it cannot be a private MCP server. */
export function parsePrivateTarget(value: string): { url: URL; host: string; port: number } | { problem: string } {
  let url: URL;
  try { url = new URL(value); } catch { return { problem: "that is not a web address" }; }
  if (url.protocol !== "https:") return { problem: "the address must start with https://" };
  if (url.username !== "" || url.password !== "") return { problem: "the address must not hold a user name or password" };
  if (url.search !== "" || url.hash !== "") return { problem: "the address must not have a query or fragment" };
  const host = url.hostname.toLowerCase();
  // A certificate names a host, not an address, so an IP address would not verify; the host name is what the allow-list holds.
  if (host.startsWith("[") || isIP(host) !== 0) return { problem: "use the server's host name, not an IP address (its certificate names the host)" };
  if (!HOST_NAME.test(host)) return { problem: "the host name is not valid" };
  const port = url.port === "" ? 443 : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return { problem: "the port is not valid" };
  return { url, host, port };
}

/** The ranges as a block list, or undefined when one does not parse. */
export function cidrBlockListOf(cidrs: readonly string[]): BlockList | undefined {
  return cidrBlockList(cidrs);
}

function cidrBlockList(cidrs: readonly string[]): BlockList | undefined {
  const list = new BlockList();
  try {
    for (const cidr of cidrs) {
      const [network, prefix] = cidr.split("/");
      const family = network === undefined ? 0 : isIP(network);
      if (network === undefined || prefix === undefined || family === 0 || !/^\d{1,3}$/u.test(prefix)) return undefined;
      list.addSubnet(network, Number(prefix), family === 4 ? "ipv4" : "ipv6");
    }
  } catch {
    return undefined;
  }
  return list;
}

async function addressesOf(host: string, resolveHost: ResolveHost, rovaraCidrs: readonly string[] = []): Promise<string[]> {
  let addresses: readonly string[];
  try { addresses = await resolveHost(host); } catch { throw agentXError("RUNTIME_UNAVAILABLE", "the MCP server's host could not be looked up; try again"); }
  if (addresses.length === 0) throw agentXError("CONFIG_INVALID", "the MCP server's host did not resolve to any address");
  // The install's own network is on the never-called list too, and answers the same fixed way before anything connects, so a test of a pasted address cannot map its open ports.
  if (addresses.some((address) => isNeverCalledAddress(address) || insideAnyRange(address, rovaraCidrs))) throw agentXError("CONFIG_INVALID", "the MCP server's host resolves to an address Rovara never calls");
  return [...addresses];
}

/** The address, checked for a TEST of a pasted address: the form and the never-called list, but no allow-list (nothing is approved yet). */
export async function checkPrivateEndpointForProbe(value: string, installCidrs: readonly string[], resolveHost: ResolveHost = dnsResolveHost, rovaraCidrs: readonly string[] = []): Promise<CheckedEndpoint> {
  const target = parsePrivateTarget(value);
  if ("problem" in target) throw agentXError("CONFIG_INVALID", target.problem);
  const addresses = await addressesOf(target.host, resolveHost, rovaraCidrs);
  insideRanges(addresses, installCidrs);
  return { url: target.url, addresses };
}

/** Every address must be inside one of the ranges; no ranges, or a range that does not parse, is a refusal. */
function insideRanges(addresses: readonly string[], cidrs: readonly string[]): void {
  const ranges = cidrs.length === 0 ? undefined : cidrBlockList(cidrs);
  if (ranges === undefined) throw agentXError("FORBIDDEN", "no address range is set for MCP servers on this network; the operator sets ROVARA_PRIVATE_MCP_CIDRS");
  if (!addresses.every((address) => ranges.check(address, isIP(address) === 4 ? "ipv4" : "ipv6"))) throw agentXError("FORBIDDEN", "the MCP server's host resolves outside the address ranges set for this install");
}

/** The address, checked for a CALL: it must be on the allow-list, and its addresses must pass the never-called list and the entry's ranges. */
export async function checkAllowedPrivateEndpoint(value: string, allowed: readonly AllowedTarget[], resolveHost: ResolveHost = dnsResolveHost, rovaraCidrs: readonly string[] = []): Promise<CheckedEndpoint> {
  const target = parsePrivateTarget(value);
  if ("problem" in target) throw agentXError("CONFIG_INVALID", target.problem);
  const entry = allowed.find((item) => item.host.toLowerCase() === target.host && item.port === target.port);
  if (entry === undefined) throw agentXError("FORBIDDEN", "that MCP server is not on this install's allow-list");
  const addresses = await addressesOf(target.host, resolveHost, rovaraCidrs);
  // An entry with no ranges is refused, and so is a range that does not parse: a name is never trusted to resolve inside the network.
  if (entry.cidrs === undefined || entry.cidrs.length === 0 || cidrBlockList(entry.cidrs) === undefined) throw agentXError("CONFIG_INVALID", "no valid address range is set for this MCP server");
  insideRanges(addresses, entry.cidrs);
  return { url: target.url, addresses };
}

/** The guard for calls to approved private servers: checks the allow-list now, and gives the fetch pinned to the addresses it checked. */
export function privateMcpEndpointGuard(options: { allowed: () => Promise<readonly AllowedTarget[]>; resolveHost?: ResolveHost; request?: RequestFunction; rovaraCidrs?: readonly string[] | undefined }): McpEndpointGuard {
  return async (endpoint) => {
    const checked = await checkAllowedPrivateEndpoint(endpoint.href, await options.allowed(), options.resolveHost, options.rovaraCidrs);
    return pinnedFetch(checked.addresses, { origin: checked.url.origin, ...(options.request === undefined ? {} : { request: options.request }) });
  };
}

/** The guard for the TEST of a pasted address. It is used only when the owner adds or approves a server, never for a stage's call. */
export function probeMcpEndpointGuard(options: { installCidrs: readonly string[]; resolveHost?: ResolveHost; request?: RequestFunction; rovaraCidrs?: readonly string[] | undefined }): McpEndpointGuard {
  return async (endpoint) => {
    const checked = await checkPrivateEndpointForProbe(endpoint.href, options.installCidrs, options.resolveHost, options.rovaraCidrs);
    return pinnedFetch(checked.addresses, { origin: checked.url.origin, ...(options.request === undefined ? {} : { request: options.request }) });
  };
}
