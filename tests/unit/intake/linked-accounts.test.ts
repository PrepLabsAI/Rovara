// The owner's linked outside accounts are matched on all three parts of the neutral shape: the tracker, the workspace or site, and the account. An account of another site, another tracker or another company is nobody.
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID } from "@rovara-code/contracts";
import { createLocalOwnerIdentity, localOwnerPrincipal } from "../../../packages/core/src/ports/policy-defaults.js";

const JIRA = { provider: "jira", tenant: "acme.atlassian.net", accountId: "712020:abc" };
const LINEAR = { provider: "linear", tenant: "", accountId: "u-owner" };

describe("who a linked outside account is", () => {
  const identity = createLocalOwnerIdentity({ linkedAccounts: [JIRA, LINEAR] });

  it("is the owner for exactly the account that was linked", async () => {
    expect((await identity.resolveExternalAccount(IMPLICIT_COMPANY_ID, JIRA))?.personId).toBe(localOwnerPrincipal().personId);
    expect((await identity.resolveExternalAccount(IMPLICIT_COMPANY_ID, LINEAR))?.personId).toBe(localOwnerPrincipal().personId);
  });

  it("is nobody for the same account id on another site (a Jira account is told by its site as well)", async () => {
    expect(await identity.resolveExternalAccount(IMPLICIT_COMPANY_ID, { ...JIRA, tenant: "other.atlassian.net" })).toBeUndefined();
    expect(await identity.resolveExternalAccount(IMPLICIT_COMPANY_ID, { ...JIRA, tenant: "" })).toBeUndefined();
    expect(await identity.resolveExternalAccount(IMPLICIT_COMPANY_ID, { ...LINEAR, tenant: "acme" })).toBeUndefined();
  });

  it("is nobody for another tracker with the same account id, another account, or another company", async () => {
    expect(await identity.resolveExternalAccount(IMPLICIT_COMPANY_ID, { ...JIRA, provider: "linear" })).toBeUndefined();
    expect(await identity.resolveExternalAccount(IMPLICIT_COMPANY_ID, { ...JIRA, accountId: "712020:xyz" })).toBeUndefined();
    expect(await identity.resolveExternalAccount("org_zzzzzzzzzzzzzzzzzzzz", JIRA)).toBeUndefined();
  });

  it("links nobody when the config lists none", async () => {
    expect(await createLocalOwnerIdentity().resolveExternalAccount(IMPLICIT_COMPANY_ID, JIRA)).toBeUndefined();
    expect(createLocalOwnerIdentity().capabilities.externalAccounts).toBe(false);
  });
});
