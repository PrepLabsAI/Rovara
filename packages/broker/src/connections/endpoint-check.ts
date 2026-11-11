// The check an endpoint URL passes before the broker saves it or calls it. The
// broker runs outside the project VPC, so its calls never meet the DNS firewall and need no staff approval: this is the only thing
// between a company's MCP endpoint and the broker's own network. A refusal names no part of the URL and no address, so it can be shown to
// the person who typed the URL and written to a log.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isPublicAddress } from "@agentx/gateway";
import { agentXError, isAllowedDomain } from "@agentx/contracts";

/** Every address a host name resolves to. It throws when the lookup itself fails. */
export type ResolveHost = (host: string) => Promise<readonly string[]>;

/** Names that only ever reach a machine, its network or a private zone. */
const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".home.arpa"] as const;

export interface CheckedEndpoint {
  url: URL;
  /** The addresses the host resolved to when it was checked, all public. */
  addresses: string[];
}

/** The addresses the system resolver gives a host, IPv4 and IPv6. */
export const dnsResolveHost: ResolveHost = async (host) => (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);

const refuse = (message: string) => agentXError("CONFIG_INVALID", message);

/**
 * The URL, parsed, when it is one the broker may call: https only on the standard port, no user info, a public DNS name (an exact host that
 * the public domain rules accept, so never an IP literal, a single label, a public suffix or a wildcard) and every address it resolves to
 * public. Run it at save and again immediately before every call: a name can start to resolve somewhere private after it was saved. The
 * transport resolves the name again when it connects, so a rebinding between the two lookups is not stopped here; that is why the second
 * check sits as close to the call as it can.
 */
export async function checkEndpointUrl(value: string, resolveHost: ResolveHost): Promise<CheckedEndpoint> {
  let url: URL;
  try { url = new URL(value); } catch { throw refuse("the endpoint is not a valid URL"); }
  if (url.protocol !== "https:") throw refuse("the endpoint must use https");
  if (url.username !== "" || url.password !== "") throw refuse("the endpoint must not carry a username or password");
  if (url.port !== "" && url.port !== "443") throw refuse("the endpoint must use the standard https port");
  const host = url.hostname.toLowerCase();
  if (isIP(host.replace(/^\[|\]$/g, "")) !== 0 || host.startsWith("[")) throw refuse("the endpoint host must be a DNS name, not an IP address");
  if (host === "localhost" || LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) throw refuse("the endpoint host is a local name");
  // `*.examplehost.com` passes the domain rules as a wildcard; an endpoint is one exact host.
  if (host.startsWith("*") || !isAllowedDomain(host)) throw refuse("the endpoint host must be a public DNS name such as mcp.examplehost.com");
  let addresses: readonly string[];
  try {
    addresses = await resolveHost(host);
  } catch {
    // A lookup failure says nothing safe about the host, so the call does not go ahead; the error text is not passed on.
    throw agentXError("RUNTIME_UNAVAILABLE", "the endpoint host could not be looked up; try again");
  }
  if (addresses.length === 0) throw refuse("the endpoint host did not resolve to any address");
  if (!addresses.every(isPublicAddress)) throw refuse("the endpoint host resolves to an address that is not a public address, so the broker does not call it");
  return { url, addresses: [...addresses] };
}
