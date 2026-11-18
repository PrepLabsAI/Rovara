// L4-GH: the link rows (core/people/github-links.ts): two rows per link in one conditional transaction, under the company; first link wins; one account per person; both rows must agree to count.
import { describe, expect, it } from "vitest";
import type { OrgId } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import {
  githubAccountKey, githubAuditPk, githubLinkOf, githubLinkReaderOver, githubPersonKey, linkGithubAccount, linkedGithubPerson, unlinkGithubAccount,
} from "../../packages/broker/src/core/people/github-links.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const AT = "2026-11-17T10:00:00.000Z";
const input = (over: Partial<Parameters<typeof linkGithubAccount>[1]> = {}) => ({ companyId: A, githubUserId: "7", login: "ada", personId: "dev_ada", linkedAt: AT, ...over });

describe("linking", () => {
  it("writes both rows under the company, keyed by GitHub's numeric id and by person, keeping only id, login and time", async () => {
    const store = new MemoryDocumentStore();
    expect(await linkGithubAccount(store, input())).toBe("linked");
    expect(await store.get(githubAccountKey(A, "7"))).toEqual({ ...githubAccountKey(A, "7"), entityType: "GITHUB_ACCOUNT_LINK", companyId: A, githubUserId: "7", login: "ada", personId: "dev_ada", linkedAt: AT });
    expect(await store.get(githubPersonKey(A, "dev_ada"))).toEqual({ ...githubPersonKey(A, "dev_ada"), entityType: "GITHUB_ACCOUNT_OF", companyId: A, personId: "dev_ada", githubUserId: "7", login: "ada", linkedAt: AT });
    expect(githubAccountKey(A, "7").pk).toBe(`ORG#${A}#GITHUB_ACCOUNT_LINK`);
    expect(githubPersonKey(A, "dev_ada").pk).toBe(`ORG#${A}#GITHUB_ACCOUNT_OF`);
  });
  it("first link wins: another person gets 'taken' and nothing changes; the same person again is 'same'; a different account for the same person is refused", async () => {
    const store = new MemoryDocumentStore();
    await linkGithubAccount(store, input());
    expect(await linkGithubAccount(store, input())).toBe("same");
    expect(await linkGithubAccount(store, input({ personId: "dev_bo", login: "bo" }))).toBe("taken");
    expect(await linkedGithubPerson(store, A, "7")).toBe("dev_ada");
    expect(await githubLinkOf(store, A, "dev_bo")).toBeUndefined();
    expect(await linkGithubAccount(store, input({ githubUserId: "8", login: "ada2" }))).toBe("person_has_another");
    expect(await linkedGithubPerson(store, A, "8")).toBeUndefined();
    expect(await githubLinkOf(store, A, "dev_ada")).toMatchObject({ accountId: "7" });
  });
  it("a racing pair of different people for one account: exactly one wins", async () => {
    const store = new MemoryDocumentStore();
    const outcomes = await Promise.all([linkGithubAccount(store, input()), linkGithubAccount(store, input({ personId: "dev_bo" }))]);
    expect(outcomes.filter((outcome) => outcome === "linked")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === "taken")).toHaveLength(1);
  });
  it("is per company: the same account links to each company's own person", async () => {
    const store = new MemoryDocumentStore();
    expect(await linkGithubAccount(store, input())).toBe("linked");
    expect(await linkGithubAccount(store, input({ companyId: B, personId: "dev_bo" }))).toBe("linked");
    expect(await linkedGithubPerson(store, A, "7")).toBe("dev_ada");
    expect(await linkedGithubPerson(store, B, "7")).toBe("dev_bo");
  });
  it("refuses an id, a login or a person that is not plain, writing nothing", async () => {
    const store = new MemoryDocumentStore();
    for (const bad of [{ githubUserId: "0" }, { githubUserId: "07" }, { githubUserId: "7#8" }, { githubUserId: "" }, { login: "has space" }, { login: "" }, { personId: "a#b" }, { personId: "" }, { companyId: "nope" }]) {
      await expect(linkGithubAccount(store, input(bad))).rejects.toThrow();
    }
    expect(await githubLinkOf(store, A, "dev_ada")).toBeUndefined();
  });
  it("records an audit row (person and act only) in the same transaction, and none when the link is refused", async () => {
    const store = new MemoryDocumentStore();
    await linkGithubAccount(store, input({ audit: { at: AT, actor: "dev_ada" } }));
    await linkGithubAccount(store, input({ personId: "dev_bo", audit: { at: AT, actor: "dev_bo" } }));
    const rows = (await store.query({ pk: githubAuditPk(A) })).items;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "linked", personId: "dev_ada", actor: "dev_ada", at: AT });
    // Never the GitHub id or login.
    expect(JSON.stringify(rows)).not.toMatch(/"7"|githubUserId|"ada"/u);
  });
});

describe("reading", () => {
  it("a row counts only when it names this company, this id and this person: copied and malformed rows are nobody", async () => {
    const store = new MemoryDocumentStore();
    const key = githubAccountKey(A, "7");
    const variants: Array<[string, Record<string, string | number>]> = [
      ["another company", { companyId: B }], ["another id", { githubUserId: "8" }], ["wrong entity", { entityType: "SOMETHING" }], ["bad person", { personId: "a#b" }], ["no person", { personId: 5 }],
    ];
    for (const [name, row] of variants) {
      await store.put({ item: { ...key, entityType: "GITHUB_ACCOUNT_LINK", companyId: A, githubUserId: "7", login: "ada", personId: "dev_ada", linkedAt: AT, ...row } });
      expect(await linkedGithubPerson(store, A, "7"), name).toBeUndefined();
    }
    expect(await linkedGithubPerson(store, A, "not-a-number")).toBeUndefined();
    expect(await linkedGithubPerson(store, A, "7#8")).toBeUndefined();
  });
  it("a person row alone (the account row names someone else, or is gone) is no link", async () => {
    const store = new MemoryDocumentStore();
    await linkGithubAccount(store, input());
    await store.delete({ key: githubAccountKey(A, "7") });
    expect(await githubLinkOf(store, A, "dev_ada")).toBeUndefined();
    await store.put({ item: { ...githubAccountKey(A, "7"), entityType: "GITHUB_ACCOUNT_LINK", companyId: A, githubUserId: "7", login: "ada", personId: "dev_bo", linkedAt: AT } });
    expect(await githubLinkOf(store, A, "dev_ada")).toBeUndefined();
  });
  it("the reader gives the person of an account and the account of a person", async () => {
    const store = new MemoryDocumentStore();
    await linkGithubAccount(store, input());
    const reader = githubLinkReaderOver(store);
    expect(await reader.personOf(A, "7")).toBe("dev_ada");
    expect(await reader.accountOf(A, "dev_ada")).toBe("7");
    expect(await reader.personOf(B, "7")).toBeUndefined();
    expect(await reader.accountOf(B, "dev_ada")).toBeUndefined();
  });
});

describe("unlinking", () => {
  it("removes both rows; with nothing linked it says so; the account row of someone else is left", async () => {
    const store = new MemoryDocumentStore();
    expect(await unlinkGithubAccount(store, A, "dev_ada")).toBe(false);
    await linkGithubAccount(store, input());
    expect(await unlinkGithubAccount(store, A, "dev_ada")).toBe(true);
    expect(await store.get(githubAccountKey(A, "7"))).toBeUndefined();
    expect(await store.get(githubPersonKey(A, "dev_ada"))).toBeUndefined();
    await linkGithubAccount(store, input());
    await store.put({ item: { ...githubAccountKey(A, "7"), entityType: "GITHUB_ACCOUNT_LINK", companyId: A, githubUserId: "7", login: "ada", personId: "dev_bo", linkedAt: AT } });
    expect(await unlinkGithubAccount(store, A, "dev_ada")).toBe(true);
    expect(await linkedGithubPerson(store, A, "7")).toBe("dev_bo");
  });
  it("is per company", async () => {
    const store = new MemoryDocumentStore();
    await linkGithubAccount(store, input());
    await linkGithubAccount(store, input({ companyId: B }));
    await unlinkGithubAccount(store, B, "dev_ada");
    expect(await githubLinkOf(store, A, "dev_ada")).toMatchObject({ accountId: "7" });
    expect(await githubLinkOf(store, B, "dev_ada")).toBeUndefined();
  });
});
