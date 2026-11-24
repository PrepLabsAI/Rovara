// R1 + L1 (6.1): the generic account-link rows (core/people/account-links.ts): two rows per link in one conditional transaction, under the company; first link wins; one account per person per provider;
// both rows must agree to count; the tenant is part of the key and is never empty; an audit row names people and the provider only.
import { describe, expect, it } from "vitest";
import type { OrgId } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import {
  accountLinkAuditPk, accountLinkKey, accountLinkOf, accountLinksPk, accountOfKey, cleanDisplay, linkAccount, listAccountLinks, personAccountLink, unlinkAccount, unlinkPersonEverywhere, unlinkProviderForCompany,
} from "../../packages/broker/src/core/people/account-links.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const AT = "2026-11-17T10:00:00.000Z";
const W1 = "aaaa1111-0000-4000-8000-00000000000a";
const W2 = "bbbb2222-0000-4000-8000-00000000000b";
const input = (over: Partial<Parameters<typeof linkAccount>[1]> = {}) => ({
  companyId: A, provider: "linear", tenant: W1, accountId: "user-ada", personId: "dev_ada", display: "Ada L", linkedAt: AT, ...over,
});
const ref = (over: Partial<{ provider: string; tenant: string; accountId: string }> = {}) => ({ provider: "linear", tenant: W1, accountId: "user-ada", ...over });

describe("linking", () => {
  it("first link wins: another person gets 'taken' and nothing changes; the same person again is 'same'; a different account for the same person is refused", async () => {
    const store = new MemoryDocumentStore();
    expect(await linkAccount(store, input())).toBe("linked");
    expect(await linkAccount(store, input())).toBe("same");
    expect(await linkAccount(store, input({ personId: "dev_bo" }))).toBe("taken");
    expect((await accountLinkOf(store, A, ref()))?.personId).toBe("dev_ada");
    expect(await personAccountLink(store, A, "dev_bo", "linear")).toBeUndefined();
    expect(await linkAccount(store, input({ accountId: "user-ada-2" }))).toBe("person_has_another");
    expect(await accountLinkOf(store, A, ref({ accountId: "user-ada-2" }))).toBeUndefined();
    expect(await personAccountLink(store, A, "dev_ada", "linear")).toMatchObject({ accountId: "user-ada", tenant: W1, display: "Ada L", via: "self", linkedAt: AT });
  });

  it("the same account id in another workspace is another account; another provider is another link", async () => {
    const store = new MemoryDocumentStore();
    await linkAccount(store, input());
    expect(await accountLinkOf(store, A, ref({ tenant: W2 }))).toBeUndefined();
    // The same person, another provider: its own link.
    expect(await linkAccount(store, input({ provider: "jira", tenant: "acme.example.net" }))).toBe("linked");
    expect((await personAccountLink(store, A, "dev_ada", "jira"))?.tenant).toBe("acme.example.net");
    expect((await personAccountLink(store, A, "dev_ada", "linear"))?.tenant).toBe(W1);
  });

  it("refuses a provider, tenant, account or person that is not plain (and an EMPTY tenant), writing nothing", async () => {
    const store = new MemoryDocumentStore();
    for (const bad of [{ tenant: "" }, { tenant: "a#b" }, { tenant: "a b" }, { accountId: "" }, { accountId: "a#b" }, { accountId: "x".repeat(101) }, { provider: "" }, { provider: "Linear" }, { provider: "a#b" }, { personId: "a#b" }, { personId: "" }, { companyId: "nope" }]) {
      await expect(linkAccount(store, input(bad))).rejects.toThrow();
    }
    expect(await personAccountLink(store, A, "dev_ada", "linear")).toBeUndefined();
    expect(await listAccountLinks(store, A, "linear")).toEqual([]);
  });

  it("keeps the display text bounded and free of control characters; an audit row names the people and the provider, never the account id or the display text", async () => {
    const store = new MemoryDocumentStore();
    expect(cleanDisplay("  Ada\u0000\n  Lovelace  ")).toBe("Ada Lovelace");
    expect(cleanDisplay("x".repeat(500))).toHaveLength(100);
    expect(cleanDisplay(42)).toBe("");
    await linkAccount(store, input({ display: "Ada\u0007 L", audit: { at: AT, actor: "dev_ada", by: "self" } }));
    expect((await personAccountLink(store, A, "dev_ada", "linear"))?.display).toBe("Ada L");
    const audit = (await store.query({ pk: accountLinkAuditPk(A) })).items;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "tracker.account_linked", provider: "linear", personId: "dev_ada", actor: "dev_ada", by: "self", at: AT });
    expect(JSON.stringify(audit)).not.toContain("user-ada");
    expect(JSON.stringify(audit)).not.toContain("Ada L");
  });
});

describe("reading", () => {
  it("a row counts only when it names this company, provider, tenant, account and person: copied and malformed rows are nobody", async () => {
    const store = new MemoryDocumentStore();
    const key = accountLinkKey(A, ref());
    const base = { ...key, entityType: "ACCOUNT_LINK", companyId: A, provider: "linear", tenant: W1, accountId: "user-ada", personId: "dev_ada", display: "Ada", via: "self", linkedAt: AT };
    const variants: Array<[string, Record<string, string | number>]> = [
      ["another company", { companyId: B }], ["another tenant", { tenant: W2 }], ["another account", { accountId: "user-bo" }], ["another provider", { provider: "jira" }], ["wrong entity", { entityType: "SOMETHING" }],
      ["bad person", { personId: "a#b" }], ["no person", { personId: 5 }], ["not self", { via: "admin" }], ["no time", { linkedAt: 5 }], ["empty tenant", { tenant: "" }],
    ];
    for (const [name, row] of variants) {
      await store.put({ item: { ...base, ...row } });
      expect(await accountLinkOf(store, A, ref()), name).toBeUndefined();
    }
    await store.put({ item: base });
    expect((await accountLinkOf(store, A, ref()))?.personId).toBe("dev_ada");
    // Company B's read of the same account finds nobody (its own partition), and a malformed ref is nobody without a read.
    expect(await accountLinkOf(store, B, ref())).toBeUndefined();
    expect(await accountLinkOf(store, A, ref({ tenant: "" }))).toBeUndefined();
    expect(await accountLinkOf(store, A, ref({ accountId: "a#b" }))).toBeUndefined();
    expect(accountLinksPk(A)).not.toBe(accountLinksPk(B));
  });

  it("a row copied under another company's key (its companyId still A) is nobody there", async () => {
    const store = new MemoryDocumentStore();
    await linkAccount(store, input());
    const row = await store.get(accountLinkKey(A, ref()));
    await store.put({ item: { ...row!, ...accountLinkKey(B, ref()) } });
    expect(await accountLinkOf(store, B, ref())).toBeUndefined();
  });

  it("a person row alone (the account row names someone else, says another time, or is gone) is no link", async () => {
    const store = new MemoryDocumentStore();
    await linkAccount(store, input());
    const accountKey = accountLinkKey(A, ref());
    const row = await store.get(accountKey);
    await store.delete({ key: accountKey });
    expect(await personAccountLink(store, A, "dev_ada", "linear")).toBeUndefined();
    await store.put({ item: { ...row!, personId: "dev_bo" } });
    expect(await personAccountLink(store, A, "dev_ada", "linear")).toBeUndefined();
    await store.put({ item: { ...row!, linkedAt: "2026-11-18T10:00:00.000Z" } });
    expect(await personAccountLink(store, A, "dev_ada", "linear")).toBeUndefined();
  });

  it("lists one provider's links of the company, newest first, leaving out rows that do not check out", async () => {
    const store = new MemoryDocumentStore();
    await linkAccount(store, input());
    await linkAccount(store, input({ personId: "dev_bo", accountId: "user-bo", linkedAt: "2026-11-18T10:00:00.000Z" }));
    await linkAccount(store, input({ companyId: B, personId: "dev_cy", accountId: "user-cy" }));
    await linkAccount(store, input({ provider: "jira", tenant: "acme.example.net", personId: "dev_di", accountId: "5b10" }));
    await store.put({ item: { ...accountLinkKey(A, ref({ accountId: "user-bad" })), entityType: "ACCOUNT_LINK", companyId: B, provider: "linear", tenant: W1, accountId: "user-bad", personId: "dev_x", display: "", via: "self", linkedAt: AT } });
    expect((await listAccountLinks(store, A, "linear")).map((link) => link.personId)).toEqual(["dev_bo", "dev_ada"]);
    expect((await listAccountLinks(store, A, "jira")).map((link) => link.personId)).toEqual(["dev_di"]);
    expect((await listAccountLinks(store, B, "linear")).map((link) => link.personId)).toEqual(["dev_cy"]);
    expect(await listAccountLinks(store, A, "Nope#")).toEqual([]);
  });
});

describe("unlinking", () => {
  it("removes both rows; with nothing linked it says so; the account row of someone else is left; an audit row is written in the same transaction", async () => {
    const store = new MemoryDocumentStore();
    expect(await unlinkAccount(store, A, "dev_ada", "linear")).toBe(false);
    await linkAccount(store, input());
    expect(await unlinkAccount(store, A, "dev_ada", "linear", { audit: { at: AT, actor: "dev_root", by: "admin" } })).toBe(true);
    expect(await store.get(accountLinkKey(A, ref()))).toBeUndefined();
    expect(await store.get(accountOfKey(A, "dev_ada", "linear"))).toBeUndefined();
    expect((await store.query({ pk: accountLinkAuditPk(A) })).items.map((item) => [item["action"], item["actor"], item["by"], item["personId"]])).toEqual([["tracker.account_unlinked", "dev_root", "admin", "dev_ada"]]);
    // Someone else holds the account row now: unlinking the first person leaves it.
    await linkAccount(store, input());
    await store.put({ item: { ...accountLinkKey(A, ref()), entityType: "ACCOUNT_LINK", companyId: A, provider: "linear", tenant: W1, accountId: "user-ada", personId: "dev_bo", display: "", via: "self", linkedAt: AT } });
    expect(await unlinkAccount(store, A, "dev_ada", "linear")).toBe(true);
    expect((await accountLinkOf(store, A, ref()))?.personId).toBe("dev_bo");
  });

  it("a person's removal and erase take every provider's link; another person's and another company's stay", async () => {
    const store = new MemoryDocumentStore();
    await linkAccount(store, input());
    await linkAccount(store, input({ provider: "jira", tenant: "acme.example.net", accountId: "5b10" }));
    await linkAccount(store, input({ personId: "dev_bo", accountId: "user-bo" }));
    await linkAccount(store, input({ companyId: B }));
    expect(await unlinkPersonEverywhere(store, A, "dev_ada")).toBe(2);
    expect(await personAccountLink(store, A, "dev_ada", "linear")).toBeUndefined();
    expect(await personAccountLink(store, A, "dev_ada", "jira")).toBeUndefined();
    expect((await personAccountLink(store, A, "dev_bo", "linear"))?.accountId).toBe("user-bo");
    expect((await personAccountLink(store, B, "dev_ada", "linear"))?.accountId).toBe("user-ada");
    expect(await unlinkPersonEverywhere(store, A, "dev_ada")).toBe(0);
    // dev_ada vs dev_adam: the prefix of one person's rows never reaches another's.
    await linkAccount(store, input({ personId: "dev_adam", accountId: "user-adam" }));
    await linkAccount(store, input({ personId: "dev_ada", accountId: "user-ada" }));
    expect(await unlinkPersonEverywhere(store, A, "dev_ada")).toBe(1);
    expect((await personAccountLink(store, A, "dev_adam", "linear"))?.accountId).toBe("user-adam");
  });

  it("a company's disconnect removes every link of that provider, only that company's, and rows that do not check out", async () => {
    const store = new MemoryDocumentStore();
    await linkAccount(store, input());
    await linkAccount(store, input({ personId: "dev_bo", accountId: "user-bo" }));
    await linkAccount(store, input({ provider: "jira", tenant: "acme.example.net", personId: "dev_di", accountId: "5b10" }));
    await linkAccount(store, input({ companyId: B, personId: "dev_cy", accountId: "user-cy" }));
    // An account row with no person row (cannot come from the writer) goes too.
    await store.put({ item: { ...accountLinkKey(A, ref({ accountId: "user-orphan" })), entityType: "ACCOUNT_LINK", companyId: A, provider: "linear", tenant: W1, accountId: "user-orphan", personId: "dev_ghost", display: "", via: "self", linkedAt: AT } });
    expect(await unlinkProviderForCompany(store, A, "linear")).toBe(2);
    expect(await listAccountLinks(store, A, "linear")).toEqual([]);
    expect(await store.get(accountLinkKey(A, ref({ accountId: "user-orphan" })))).toBeUndefined();
    expect((await listAccountLinks(store, A, "jira")).map((link) => link.personId)).toEqual(["dev_di"]);
    expect((await listAccountLinks(store, B, "linear")).map((link) => link.personId)).toEqual(["dev_cy"]);
  });
});
