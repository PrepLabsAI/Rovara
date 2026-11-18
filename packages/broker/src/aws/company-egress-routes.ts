// Rovara's fixed outbound addresses on the deployed developer API (contracts company-egress-addresses.ts; lead 4, L4-EGR).
//
//   GET /v1/dev/company/egress-addresses   owner or admin of the company  -> { addresses: [...] }
//
// Rules:
//   - The company and role are the caller's LIVE membership (sign-in table), read at every call; never a body, query, header or token claim. Full access only (the route table's row).
//   - Only an owner or admin reads it (a member gets fixed words). The addresses are public and the same for every company on the install; the role gate is the product rule, not a secret.
//   - The addresses are the install's ROVARA_EGRESS_ADDRESSES, read once per call, with no AWS call and no stored record. Absent or empty: an empty list (an install that has not been given
//     them yet). A malformed value is never shown in part: the read says so in fixed words.
//   - Every refusal is fixed words: no address, company id or cause is echoed.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import type { z } from "zod";
import {
  agentXError, COMPANY_EGRESS_ADDRESSES_PATH, EGRESS_ADDRESSES_ADMIN_ONLY, EGRESS_ADDRESSES_UNAVAILABLE, OrgIdSchema, parseEgressAddresses, type CompanyEgressAddressesView,
} from "@agentx/contracts";
import { Membership, membershipKey } from "./company-check.js";
import type { DeveloperCaller } from "./developer-routes.js";
import type { AdaptedHttpRequest } from "./lambda.js";

const SIGN_IN_AGAIN = "your AgentX sign-in has ended; run agentx login <url> again";

export interface CompanyEgressWiring {
  /** The install's addresses as the broker's variable holds them (ROVARA_EGRESS_ADDRESSES); undefined where there is none. */
  addresses: () => string | undefined;
}

export interface CompanyEgressContext {
  documentClient: { send(command: unknown): Promise<unknown> };
  /** The sign-in table (memberships). */
  signInTableName: string;
  wiring: CompanyEgressWiring;
}

/** Whether this module answers the path (the dispatcher sends it here before anything is read). */
export function isCompanyEgressPath(path: string): boolean {
  return path === COMPANY_EGRESS_ADDRESSES_PATH;
}

/** The caller's live membership in `companyId`, or the sign-in refusal. */
async function liveMembership(ctx: CompanyEgressContext, caller: DeveloperCaller, companyId: string): Promise<z.infer<typeof Membership>> {
  try {
    const response = await ctx.documentClient.send(new GetCommand({ TableName: ctx.signInTableName, Key: membershipKey(caller.developerId), ConsistentRead: true })) as { Item?: unknown };
    const member = Membership.parse(response.Item);
    if (member.personId !== caller.developerId || member.companyId !== companyId || member.revokedAt !== undefined || !OrgIdSchema.safeParse(companyId).success) throw new Error("membership");
    return member;
  } catch { throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN); }
}

export async function routeCompanyEgress(ctx: CompanyEgressContext, caller: DeveloperCaller, companyId: string, request: AdaptedHttpRequest): Promise<CompanyEgressAddressesView> {
  if (request.method !== "GET") throw agentXError("NOT_FOUND", "not found");
  const member = await liveMembership(ctx, caller, companyId);
  // The live role first: nobody learns more than "owner or admin".
  if (member.role !== "owner" && member.role !== "admin") throw agentXError("FORBIDDEN", EGRESS_ADDRESSES_ADMIN_ONLY);
  let raw: string | undefined;
  try { raw = ctx.wiring.addresses(); } catch { throw agentXError("RUNTIME_UNAVAILABLE", EGRESS_ADDRESSES_UNAVAILABLE); }
  const addresses = parseEgressAddresses(raw);
  if (addresses === undefined) throw agentXError("RUNTIME_UNAVAILABLE", EGRESS_ADDRESSES_UNAVAILABLE);
  return { addresses };
}
