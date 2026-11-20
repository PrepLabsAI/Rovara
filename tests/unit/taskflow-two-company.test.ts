import { it } from "vitest";
import { assertTwoCompanyIsolation } from "../../packages/testing/src/isolation/two-company.js";
import { taskflowKeysCompanies } from "../support/ports/taskflow-keys-companies.js";
it("S4: identical raw ids share one real Dynamo adapter store and dispatch each company's operation", async () => {
  await assertTwoCompanyIsolation(taskflowKeysCompanies());
  await assertTwoCompanyIsolation(taskflowKeysCompanies(true));
});

