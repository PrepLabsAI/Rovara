import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OrgIdSchema, companyScoped, companyOfKey, testAccountSecretName, TEST_ACCOUNT_SECRET_TAG_KEYS } from "@agentx/contracts";
import { COMPANY_SECRET_PATHS, COMPANY_SECRET_TAG_KEY, companyOfSecretName } from "../../packages/aws-adapters/src/secrets-manager/company-names.js";
import { admitSecretName, orgConnectorSecretName, orgMcpServerSecretName } from "../../packages/broker/src/connections/org-secrets.js";
const A = "org_aaaaaaaaaaaaaaaaaaaa";
describe("company secret names", () => {
  it("pins every family and the existing tag key", () => {
    expect(COMPANY_SECRET_PATHS).toEqual(["org-connectors", "org-hooks", "org-test-accounts"]);
    expect(COMPANY_SECRET_TAG_KEY).toBe(TEST_ACCOUNT_SECRET_TAG_KEYS.org);
    for (const path of COMPANY_SECRET_PATHS) expect(companyOfSecretName(`${path}/${A}/shared-secret`)).toEqual({ path, company: A });
  });
  it("round-trips the single org grammar through DynamoDB keys without using them as secret names", () => {
    for (const ch of "0123456789abcdefghijklmnopqrstuvwxyz") {
      const company = `org_${ch.repeat(20)}`;
      expect(OrgIdSchema.safeParse(company).success).toBe(true);
      expect(companyOfKey(companyScoped(company, "secret"))).toBe(company);
      expect(companyOfSecretName(`org-connectors/${company}/x`)?.company).toBe(company);
      expect(companyOfSecretName(companyScoped(company, "secret"))).toBeUndefined();
    }
    for (const company of ["", "org_a", `${A}a`, `${A}#`, `${A} `, A.toUpperCase()]) expect(companyOfSecretName(`org-connectors/${company}/x`)).toBeUndefined();
  });
  it("rejects traversal, partial names, unknown families and wrong runtime types as a whole", () => {
    for (const name of [null, 1, {}, `org-connectors/${A}`, `org-connectors/${A}/../x`, `org-connectors/${A}/x/..`, `org-connectors/${A}//x`, `org-model-keys/${A}/x`, "x".repeat(1_000_000)]) expect(companyOfSecretName(name as string)).toBeUndefined();
  });
  it("agrees with broker builders, admission and customer test accounts", () => {
    for (const name of [orgConnectorSecretName("local", A, "shared-secret"), orgMcpServerSecretName("local", A, "shared-secret"), `agentx/local/org-hooks/${A}/shared-secret`]) {
      expect(admitSecretName("local", A, name)).toBe(A);
      expect(COMPANY_SECRET_PATHS).toContain(companyOfSecretName(name.slice("agentx/local/".length))?.path);
    }
    const account = testAccountSecretName("local", A, "acct_aaaaaaaaaaaaaaaaaaaa");
    expect(companyOfSecretName(account.slice("agentx/local/".length))).toEqual({path: "org-test-accounts", company: A});
  });
  it("pins the intentionally unwired read families in the inventory", () => {
    for (const path of ["../../docs/ports.md", "../../docs/architecture/company-inventory.md"]) {
      const docs = readFileSync(new URL(path, import.meta.url), "utf8");
      for (const row of ["org-connectors", "org-hooks", "org-test-accounts", "T4/T5", "lane G", "T7", "R2"]) expect(docs).toContain(row);
    }
  });
});
