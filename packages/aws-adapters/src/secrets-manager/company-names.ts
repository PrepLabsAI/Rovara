import { OrgIdSchema, TEST_ACCOUNT_SECRET_TAG_KEYS } from "@agentx/contracts";

/** Existing paths, without the install's `agentx/<env>/` prefix. Never rename stored secrets. */
export const COMPANY_SECRET_PATHS = ["org-connectors", "org-hooks", "org-test-accounts"] as const;
export const COMPANY_SECRET_TAG_KEY = TEST_ACCOUNT_SECRET_TAG_KEYS.org;

/** A complete relative name with one valid company segment. Bounded before splitting untrusted input. */
export function companyOfSecretName(value: string): { path: typeof COMPANY_SECRET_PATHS[number]; company: string } | undefined {
  if (typeof value !== "string" || value.length > 512) return undefined;
  const parts = value.split("/");
  const path = COMPANY_SECRET_PATHS.find((candidate) => candidate === parts[0]);
  if (path === undefined || parts.length < 3 || !OrgIdSchema.safeParse(parts[1]).success) return undefined;
  if (parts.some((part) => part === "." || part === ".." || !/^[A-Za-z0-9_+=.@-]+$/u.test(part))) return undefined;
  return { path, company: parts[1]! };
}

/**
 * The leaves a company's CreateSecret makes WITHOUT tags (PRIVATE-PACKAGES P1b): the company's package token per registry host, `pkgreg_<hostKey>`. A tagged create also needs TagResource, which the company role
 * does not hold (its own note in infra/lib/company-secrets.ts), so these names are made untagged under their own create statement, whose resource is exactly `.../org-connectors/<company>/pkgreg_*`. The NAME is the
 * fence (the company is in the path, and the session's company tag is in the IAM resource). Everything else keeps the tagged create.
 */
export const UNTAGGED_CREATE_LEAF = /^pkgreg_[a-z0-9]{1,32}$/u;
export function isUntaggedCreateName(relativeName: string): boolean {
  const parts = relativeName.split("/");
  return parts.length === 3 && parts[0] === "org-connectors" && UNTAGGED_CREATE_LEAF.test(parts[2]!);
}
