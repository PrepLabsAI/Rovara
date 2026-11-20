import { afterEach, describe, expect, it } from "vitest";
import { admittedRuntimeAccountRef } from "../../packages/verifier/src/application-result-adapter.js";
import { disposeRealCandidates } from "../support/e2e-application-candidate.js";

// One application, two accounts of it (orders-owner and orders-viewer), one target and one scenario for each: the plan shape of a multi-role test of one application. Every
// per-case fact that depends on the account (its runtime account reference above all) must come from the case's own account, never from the application's first one.

afterEach(disposeRealCandidates);


describe("one application with two accounts, one scenario on each", () => {

  describe("the oracle's lookup of a case's own runtime account reference", () => {
    // The compiled suite's own validation refuses a changed account list before the oracle looks a case's account up, so the lookup is tested on its own, with the
    // exact reasons it gives.
    const runtimeRef = { targetId: "target-viewer", applicationId: "orders", recipeDigest: "a".repeat(64), sourceRefs: [], runtimeProfileId: "web-1", accountProfileId: "orders-viewer" };
    const account = (profileId: string, revision = 1) => ({ applicationId: "orders", profileId, revision, secretId: `secret-${profileId}`, kind: "static-credential" }) as never;
    const refs = [account("orders-owner"), account("orders-viewer")];

    it("refuses, by name, an account with no reference and an account with more than one", () => {
      expect(() => admittedRuntimeAccountRef({ runtimeRef, accountProfileId: "orders-viewer", runtimeAccountRefs: [refs[0]!] }))
        .toThrow("the admitted selection has no runtime account reference for account profile orders-viewer of application orders");
      expect(() => admittedRuntimeAccountRef({ runtimeRef, accountProfileId: "orders-viewer", runtimeAccountRefs: [...refs, account("orders-viewer", 2)] }))
        .toThrow("the admitted selection has more than one runtime account reference for account profile orders-viewer of application orders");
    });

    it("refuses a runtime reference that is for another account than the case's, even when the case's own account has a reference (FX3 minor 3)", () => {
      expect(() => admittedRuntimeAccountRef({ runtimeRef: { ...runtimeRef, accountProfileId: "orders-owner" }, accountProfileId: "orders-viewer", runtimeAccountRefs: refs }))
        .toThrow("the admitted runtime reference of target target-viewer is for account profile orders-owner, not the case's account profile orders-viewer");
    });
  });

});
