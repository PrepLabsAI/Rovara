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
