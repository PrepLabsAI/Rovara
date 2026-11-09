// Port lane L4b: the websites a local worker and its task sandboxes may reach.
//
// On a cloud install the machines resolve only the domains of `DEFAULT_AGENT_ALLOW_DOMAINS` plus a project's own allowed websites
// (the DNS firewall answers NXDOMAIN to everything else). A local worker has no DNS firewall, so its egress gateway
// (egress-gateway-source.ts) applies the same list itself. The rules are the cloud ones: a name is lower case, `*.example.com`
// covers subdomains at any depth and not `example.com` itself, an address is never a name, and an entry must pass `isAllowedDomain`
// (no bare suffix, no wildcard over a public suffix).
import { DEFAULT_AGENT_ALLOW_DOMAINS, isAllowedDomain } from "@agentx/contracts";

/** Names of the cloud VPC itself; they mean nothing on a laptop. */
const VPC_ONLY = new Set(["*.compute.internal", "*.ec2.internal", "*.42.10.in-addr.arpa"]);

/** The default list of a local install: the cloud default without the cloud network's own names. */
export const LOCAL_DEFAULT_ALLOW_DOMAINS: readonly string[] = DEFAULT_AGENT_ALLOW_DOMAINS.filter((entry) => !VPC_ONLY.has(entry));

/** The default list plus the owner's own entries. Throws, naming the position (never the value), for an entry the cloud would refuse. */
export function localAllowedDomains(extra: readonly string[] = []): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  const add = (entry: string): void => {
    if (!seen.has(entry)) {
      seen.add(entry);
      result.push(entry);
    }
  };
  for (const entry of LOCAL_DEFAULT_ALLOW_DOMAINS) add(entry);
  extra.forEach((entry, index) => {
    const domain = entry.toLowerCase();
    if (!isAllowedDomain(domain)) throw new Error(`allowed website number ${index + 1} must be a domain name such as artifacts.acme.dev or *.acme.dev`);
    add(domain);
  });
  return result;
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The same test the gateway makes: is this name on the list? (For tests and for what the broker prints; the gateway has its own copy of the text.) */
export function hostIsAllowed(host: string, list: readonly string[]): boolean {
  if (host.length === 0 || host.length > 253) return false;
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label)) || !/[a-z]/.test(labels[labels.length - 1]!)) return false;
  return list.some((entry) => (entry.startsWith("*.") ? host.length > entry.length - 1 && host.endsWith(entry.slice(1)) : host === entry));
}
