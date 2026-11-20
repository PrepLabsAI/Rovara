import { expect,it } from "vitest";
import { assertTwoCompanyIsolation } from "../../packages/testing/src/isolation/two-company.js";
import { secretsCompanies } from "../support/ports/secrets-companies.js";
it.each(["name-check","fallback","shared-session","untagged-writer"] as const)("kit self-proof catches %s",async(leak)=>{await expect(assertTwoCompanyIsolation(secretsCompanies(leak))).rejects.toThrow();});
