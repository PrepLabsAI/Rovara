import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { CredentialUnavailable } from "./credentials.js";

/** Every address a name resolves to, as node:dns lookup with `all: true` returns them. */
export type AddressLookup = (hostname: string) => Promise<ReadonlyArray<{ address: string }>>;

/**
 * Spec 055 FR-010: the endpoint resolves to an address AgentX must not call. A credential-class
 * failure, so the connector reads as not connected with this reason rather than as a vendor error.
 */
export class EndpointRefused extends CredentialUnavailable {
  constructor(message: string) { super(message); this.name = "EndpointRefused"; }
}

const IPV4_BLOCKED: ReadonlyArray<[string, number]> = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];
/** Loopback, unspecified, IPv4-translated (NAT64, 6to4, Teredo), discard, documentation, ULA, link-local, site-local and multicast. */
const IPV6_BLOCKED: ReadonlyArray<[string, number]> = [
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 32], ["2001:db8::", 32],
  ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
];

const BLOCKED = (() => {
  const list = new BlockList();
  for (const [network, prefix] of IPV4_BLOCKED) list.addSubnet(network, prefix, "ipv4");
  for (const [network, prefix] of IPV6_BLOCKED) list.addSubnet(network, prefix, "ipv6");
  return list;
})();

/** Whether an address is a public unicast one. IPv4-mapped IPv6 is judged by its IPv4 address. Anything unparsable is not. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return !BLOCKED.check(address, family === 4 ? "ipv4" : "ipv6");
}

const defaultLookup: AddressLookup = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

/**
 * Resolves the endpoint's host and refuses it when any address is not public, before a credential
 * is issued or sent. A resolution failure is an ordinary error (the vendor is unreachable), never a
 * refusal. The transport resolves the name again, so this does not stop DNS rebinding (spec 055).
 */
export async function checkEndpointAddresses(endpoint: URL, lookup: AddressLookup = defaultLookup): Promise<void> {
  const addresses = await lookup(endpoint.hostname);
  if (addresses.length === 0) throw new Error("endpoint host did not resolve");
  const blocked = addresses.find((entry) => !isPublicAddress(entry.address));
  if (blocked !== undefined) {
    throw new EndpointRefused(`endpoint host ${endpoint.hostname} resolves to ${blocked.address}, which is not a public address, so AgentX does not connect to it`);
  }
}
