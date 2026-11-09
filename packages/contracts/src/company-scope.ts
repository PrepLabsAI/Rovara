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
 * A person's role in the company. Code has one implicit company and its owner; the roles are kept so the keys and wire shapes match Cloud's. Cloud adds an
 * enterprise-only `auditor` role in its own org file.
 */
export const OrgRoleSchema = z.enum(["owner", "admin", "member"]);
export type OrgRole = z.infer<typeof OrgRoleSchema>;

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
