import { it } from "vitest";
import { assertTwoCompanyIsolation } from "../../packages/testing/src/isolation/two-company.js";
import { taskflowKeysCompanies } from "../support/ports/taskflow-keys-companies.js";
it("S4: identical raw ids share one real Dynamo adapter store and dispatch each company's operation", async () => {
  await assertTwoCompanyIsolation(taskflowKeysCompanies());
  await assertTwoCompanyIsolation(taskflowKeysCompanies(true));
});

it("the kit rejects each key/resolver guard mutant and accepts the control", async () => {
  const { expect } = await import("vitest");
  const { taskflowGuardProbe } = await import("../support/ports/taskflow-keys-companies.js");
  await assertTwoCompanyIsolation(await taskflowGuardProbe());
  for (const mutant of ["drop-company", "any-legacy", "skip-stored-company"] as const) {
    await expect(assertTwoCompanyIsolation(await taskflowGuardProbe(mutant))).rejects.toThrow();
  }
});
