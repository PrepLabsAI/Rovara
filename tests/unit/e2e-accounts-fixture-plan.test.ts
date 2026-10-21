import { describe, expect, it } from "vitest";
import { readE2EApplicationProjectContract } from "@agentx/contracts";
import { createAccountsExecutorPlan } from "../support/e2e-accounts-fixture.js";

// The Task 3.2 fixture app goes through the real discovery, selection and compiler: three accounts in two tenants become three cases of one group.
describe("the accounts fixture plan", () => {
  it("compiles three web cases, one per account, in one group, and carries each account's login form in the plan", () => {
    const fixture = createAccountsExecutorPlan();
    expect(fixture.compiled.expectedCases).toHaveLength(3);
    expect(fixture.plan.admission.round.groupBindings).toHaveLength(1);
    expect(fixture.compiled.expectedCases.map((item) => item.accountProfileId).sort()).toEqual(["orders-owner", "orders-owner-b", "orders-viewer"]);
    expect(fixture.plan.accounts.map((account) => account.profileId)).toEqual(["orders-viewer", "orders-owner", "orders-owner-b"]);
    for (const account of fixture.plan.accounts) expect(account.login).toEqual({ kind: "form", path: "/", usernameTestId: "email", passwordTestId: "password", submitTestId: "login-submit", successTestId: "identity" });
    const snapshot = fixture.compiled.runtimeAdmissionContext.selectionInput.sourceSnapshot;
    const contract = readE2EApplicationProjectContract(snapshot, fixture.compiled.originByApplicationId[0]!.applicationId)!;
    expect(contract.recipe.seedProfileId).toBe("rovara-accounts-file/v1");
    expect(contract.recipe.seed).toMatchObject({ program: "node", args: ["seed.mjs"] });
    expect(contract.accountProfiles.map((profile) => [profile.profileId, profile.tenantRef, profile.roleRef])).toEqual(
      [["orders-viewer", "tenant-a", "viewer"], ["orders-owner", "tenant-a", "owner"], ["orders-owner-b", "tenant-b", "owner"]]);
  });

  it("compiles the API cases of the same accounts", () => {
    const fixture = createAccountsExecutorPlan({ api: true });
    expect(fixture.compiled.expectedCases.map((item) => item.accountProfileId).sort()).toEqual(["orders-owner", "orders-viewer"]);
    expect(fixture.compiled.shards.every((shard) => shard.targetId.length > 0)).toBe(true);
  });
});
