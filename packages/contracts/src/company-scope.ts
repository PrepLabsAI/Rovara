// The company scope of every key (decisions 45.6 and 51): Rovara Code runs as ONE implicit company and keeps Cloud's `ORG#<orgId>#...` key scheme, so
// Code and Cloud share one key layout and Cloud consumes Code with no key migration. This is the small base the key builders in org-scoped-keys.ts and a
// few contract files need. It holds no company record, member, invite, budget or audit shape: those are Cloud's (decision 41) and stay in Cloud's own
// org files, which import from here (port lane L1: this file replaces Cloud's org.ts and org-node.ts for everything Code keeps).
import { createHash } from "node:crypto";
import { z } from "zod";
import { OrgIdSchema, type OrgId } from "./browser-ids.js";
import { COMPANY_KEY_PREFIX, companyScoped } from "./ports/company-scope.js";

export { OrgIdSchema, type OrgId };

/**
 * A person's role in the company, the closed list: Code has one implicit company and its owner; the roles are kept so the keys and wire shapes match Cloud's. Cloud adds an enterprise-only `auditor` role in its own org file.
 * Code code that SELECTS or AUTHORISES by role parses with this schema: a name outside the list is refused, so a new role never passes a check by being unknown. Shapes that must carry a role they do not act on use
 * `OrgRoleNameSchema` (lane P3, item I3).
 */
export const OrgRoleSchema = z.enum(["owner", "admin", "member"]);
export type OrgRole = z.infer<typeof OrgRoleSchema>;

/**
 * An open role name for a shared answer about a person (lane P3, item I3): the company defines its roles, so Code and Cloud need no second schema for an answer about an `auditor`. The core ACTS only on `KNOWN_ORG_ROLES`
 * (`isKnownOrgRole`) and gives any other name no power. A name that is also a property of every object (`constructor`, `toString`) is refused, so a role never becomes a key into a table's prototype; look roles up with `ownRoleEntry`.
 */
export const OrgRoleNameSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/).refine((name) => !(name in Object.prototype), "not a role name");
export type OrgRoleName = z.infer<typeof OrgRoleNameSchema>;

/** The role names the core knows how to act on. */
export const KNOWN_ORG_ROLES = ["owner", "admin", "member"] as const;
export type KnownOrgRole = (typeof KNOWN_ORG_ROLES)[number];

/** Whether the core knows this role name. An unknown name (`auditor`, a company's own) is valid data and carries no power in the core. */
export function isKnownOrgRole(role: string): role is KnownOrgRole {
  return (KNOWN_ORG_ROLES as readonly string[]).includes(role);
}

/** A table's entry for a role, by the table's OWN keys only: `undefined` for a name the table does not list, including `constructor` and `__proto__`. */
export function ownRoleEntry<T>(table: Readonly<Record<string, T>>, role: string): T | undefined {
  return Object.hasOwn(table, role) ? table[role] : undefined;
}

const ORG_ID_BODY_LENGTH = 20;

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

/** The deterministic company id for a single-company environment (ruling R3): base36 of SHA-256(env). Code uses it for its one implicit company. */
export function singleOrgIdForEnv(env: string): OrgId {
  const digest = createHash("sha256").update(env, "utf8").digest();
  const body = bytesToBigInt(digest).toString(36).padStart(ORG_ID_BODY_LENGTH, "0").slice(0, ORG_ID_BODY_LENGTH);
  return OrgIdSchema.parse(`org_${body}`);
}

export interface OrgKey {
  pk: string;
  sk: string;
}

/** `ORG#<orgId>`: the partition of one company's own record. Uses the one prefix W0's `companyScoped` uses. */
export function orgPk(orgId: OrgId): string {
  return `${COMPANY_KEY_PREFIX}${orgId}`;
}

/**
 * `ORG#<orgId>#<key>`. The same function as W0's `companyScoped` (ports/company-scope.ts): there is one implementation, and new code uses `companyScoped`. This name stays
 * because Cloud's key builders (org-scoped-keys.ts and others) call it; an org id always matches `org_[0-9a-z]{20}`, so W0's check for '#' and white space never fires.
 */
export const orgScoped: (orgId: OrgId, key: string) => string = companyScoped;
