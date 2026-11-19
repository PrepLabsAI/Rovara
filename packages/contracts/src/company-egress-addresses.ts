// Rovara's fixed outbound addresses (lead 4, L4-EGR; designs-2026-11-17/static-egress-ip-design.md). The worker machines reach the internet only through the install's NAT gateways, each
// with its own Elastic IP, so a customer can allow-list them. The foundation stack outputs the addresses (NatEgressAddresses), the control plane takes them as a stack parameter of the
// same name, the broker holds them in ROVARA_EGRESS_ADDRESSES, and this route shows them to a company's owners and admins:
//
//   GET /v1/dev/company/egress-addresses   owner or admin of the company  -> CompanyEgressAddressesView
//
// The addresses belong to the install (one set, shared by every company on it); they are public addresses, not secrets. A company never sets or changes them. An install that has not
// been given them yet (an older release) answers an empty list, and the app shows nothing.
import { z } from "zod";

/** The foundation stack's output, and the control plane's stack parameter of the same name: the NAT gateways' Elastic IPs, comma-separated (empty on an install without them). */
export const NAT_EGRESS_ADDRESSES_OUTPUT = "NatEgressAddresses";
/** The variable the broker reads the addresses from (the stack parameter's value, as is). */
export const EGRESS_ADDRESSES_VARIABLE = "ROVARA_EGRESS_ADDRESSES";
/** The most addresses an install lists: two NAT gateways today (one per zone); room for a third zone and a spare. */
export const EGRESS_ADDRESSES_MAX = 4;
/** The days of notice Rovara promises before any of these addresses changes. The settings line, the docs and the pilot pack say this number. */
export const EGRESS_ADDRESS_NOTICE_DAYS = 30;

const OCTET = "(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])";
const IPV4 = `${OCTET}(?:\\.${OCTET}){3}`;
/** One public IPv4 address as text: four decimal octets, no leading zeros. Whether it is public is the foundation's own fact (an Elastic IP); a private or reserved range is refused as well. */
export const EGRESS_IPV4 = new RegExp(`^${IPV4}$`, "u");
/**
 * The stack parameter's AllowedPattern: empty, or 1 to EGRESS_ADDRESSES_MAX addresses separated by commas. No space, no quote, no other character, so the value is safe as a plain
 * environment variable. (It is not packed into AGENTX_SETTINGS: a packed value cannot hold a comma.)
 */
export const EGRESS_ADDRESSES_PARAMETER_PATTERN = `^(${IPV4}(,${IPV4}){0,${EGRESS_ADDRESSES_MAX - 1}})?$`;

/** Whether an address is in a range that is never a public internet address (private, loopback, link-local, carrier-grade NAT, multicast and reserved). */
export function isNonPublicIpv4(address: string): boolean {
  const [a, b] = address.split(".").map(Number) as [number, number];
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * The addresses in the broker's variable, or undefined when anything is off (never a partial list: a customer who allows a short list would find Rovara blocked). Absent or empty is an
 * empty list. An address twice, more than EGRESS_ADDRESSES_MAX, a space, a non-address or a non-public address makes the whole value unusable.
 */
export function parseEgressAddresses(raw: string | undefined): string[] | undefined {
  if (raw === undefined || raw === "") return [];
  const parts = raw.split(",");
  if (parts.length > EGRESS_ADDRESSES_MAX) return undefined;
  if (!parts.every((part) => EGRESS_IPV4.test(part) && !isNonPublicIpv4(part))) return undefined;
  return new Set(parts).size === parts.length ? parts : undefined;
}

/** What the read answers. Strict: nothing else is accepted by a reader (Cloud's, the app's). */
export const CompanyEgressAddressesViewSchema = z.object({
  addresses: z.array(z.string().regex(EGRESS_IPV4).refine((address) => !isNonPublicIpv4(address))).max(EGRESS_ADDRESSES_MAX),
}).strict().refine((view) => new Set(view.addresses).size === view.addresses.length, "an address is listed twice");
export type CompanyEgressAddressesView = z.infer<typeof CompanyEgressAddressesViewSchema>;

export const COMPANY_EGRESS_ADDRESSES_PATH = "/v1/dev/company/egress-addresses";
/** A person who is not a live owner or admin of their company. Fixed words. */
export const EGRESS_ADDRESSES_ADMIN_ONLY = "Only a company owner or admin can see Rovara's outbound addresses.";
/** The install's value is malformed, so nothing is shown rather than part of it. Fixed words. */
export const EGRESS_ADDRESSES_UNAVAILABLE = "Rovara's outbound addresses could not be read just now; try again.";
