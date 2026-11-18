// Lead 4 L4-LPPL: the hosted lessons people port, over the install's own member, grant and sign-in records. Company and project isolation, live reads, fail closed.
import { describe, expect, it } from "vitest";
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { companyScoped, type OrgId } from "@agentx/contracts";
import { createHostedLessonsPeople, HOSTED_PEOPLE_MEMBERS_MAX } from "../../packages/broker/src/aws/hosted-lessons-people.js";
import { OtherCompanyError } from "../../packages/broker/src/lessons/hosted-people.js";
import { personErasedKey } from "../../packages/broker/src/core/people/erase.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";

const A = "org_lppl000000000000000a" as OrgId;
const B = "org_lppl000000000000000b" as OrgId;
const SIGN_IN = "signin";
const STATE = "state";
const NOW = Date.parse("2026-11-18T12:00:00.000Z");
const id = (n: number): string => n.toString(16).padStart(64, "0");
const [OWN_A, ADMIN_A, MAINT_A, DEV_A, PLAIN_A, OWN_B, DEV_B, GONE_A] = [id(1), id(2), id(3), id(4), id(5), id(6), id(7), id(8)];

type Row = Record<string, unknown>;

/** A document client over a map of items by table and key. Counts every send; supports reads and one-partition queries (the member list's). */
function world() {
  const rows = new Map<string, Row>();
  const key = (table: string, pk: string, sk: string) => `${table}|${pk}|${sk}`;
  const sends: string[] = [];
  const failing = { query: false, getPk: undefined as string | undefined };
  const put = (table: string, row: Row) => { rows.set(key(table, String(row.pk), String(row.sk)), row); };
  const client = {
    async send(command: unknown) {
      if (command instanceof GetCommand) {
        const { TableName, Key } = command.input as { TableName: string; Key: { pk: string; sk: string } };
        sends.push(`get:${TableName}:${Key.pk}`);
        if (failing.getPk !== undefined && Key.pk.startsWith(failing.getPk)) throw new Error("store down");
        return { Item: rows.get(key(TableName, Key.pk, Key.sk)) };
      }
      if (command instanceof QueryCommand) {
        const input = command.input as { TableName: string; ExpressionAttributeValues: Record<string, string>; Limit?: number; ExclusiveStartKey?: { sk: string } };
        sends.push(`query:${input.TableName}:${input.ExpressionAttributeValues[":pk"]}`);
        if (failing.query) throw new Error("store down");
        const pk = input.ExpressionAttributeValues[":pk"]!;
        const all = [...rows.entries()].filter(([k]) => k.startsWith(`${input.TableName}|${pk}|`)).map(([, row]) => row).sort((l, r) => String(l.sk).localeCompare(String(r.sk)));
        const after = input.ExclusiveStartKey === undefined ? all : all.filter((row) => String(row.sk) > input.ExclusiveStartKey!.sk);
        const limit = input.Limit ?? 100;
        const items = after.slice(0, limit);
        const more = after.length > limit;
        return { Items: items, ScannedCount: items.length, ...(more ? { LastEvaluatedKey: { pk, sk: String(items.at(-1)!.sk) } } : {}) };
      }
      throw new Error("only reads");
    },
  };
  /** A member: the authoritative row, the company's list row, and (optionally) a project grant. */
  const member = (personId: string, companyId: OrgId, role: "owner" | "admin" | "member", extra: Row = {}) => {
    const base = { entityType: "COMPANY_MEMBERSHIP", personId, companyId, role, joinedAt: "2026-10-01T00:00:00.000Z", joinedVia: "preapproval", ...extra };
    put(SIGN_IN, { pk: `COMPANY_MEMBER#${personId}`, sk: "COMPANY", ...base });
    put(SIGN_IN, { pk: companyScoped(companyId, "MEMBERS"), sk: `MEMBER#${personId}`, ...base, entityType: "COMPANY_MEMBER_VIEW" });
  };
  const grant = (personId: string, project: string, role: "developer" | "administrator") => put(STATE, { pk: `MEMBER#${personId}`, sk: `PROJECT#${project}`, projectName: project, role });
  const developer = (personId: string, extra: Row = {}) => put(SIGN_IN, { pk: `DEVELOPER#${personId}`, sk: "META", entityType: "DEVELOPER", displayName: `Name ${personId.slice(-2)}`, provider: "oidc", ...extra });
  /** Changes one member's authoritative row only (the list row is left as it was: the answer must come from the authoritative one). */
  const patchAuthoritative = (personId: string, patch: Row) => {
    const k = key(SIGN_IN, `COMPANY_MEMBER#${personId}`, "COMPANY");
    rows.set(k, { ...rows.get(k)!, ...patch });
  };
  return { client, rows, sends, failing, put, member, grant, developer, patchAuthoritative };
}

const build = (w: ReturnType<typeof world>, over: { signInTableName?: string | undefined; now?: () => number } = {}) =>
  createHostedLessonsPeople({ documentClient: w.client, stateTableName: STATE, signInTableName: "signInTableName" in over ? over.signInTableName : SIGN_IN, now: over.now ?? (() => NOW) });
const noStore = { store: async () => { throw new Error("no store"); } };

function seeded() {
  const w = world();
  w.member(OWN_A, A, "owner"); w.member(ADMIN_A, A, "admin"); w.member(MAINT_A, A, "member"); w.member(DEV_A, A, "member"); w.member(PLAIN_A, A, "member");
  w.member(OWN_B, B, "owner"); w.member(DEV_B, B, "member");
  w.grant(MAINT_A, "web", "administrator"); w.grant(DEV_A, "web", "developer");
  // The same project name in the other company: its own people.
  w.grant(DEV_B, "web", "developer");
  for (const person of [OWN_A, ADMIN_A, MAINT_A, DEV_A, PLAIN_A, OWN_B, DEV_B]) w.developer(person);
  return w;
}
const peopleA = (w: ReturnType<typeof world>) => build(w)(A, noStore);
const peopleB = (w: ReturnType<typeof world>) => build(w)(B, noStore);

describe("hosted lessons people: company isolation", () => {
  it("refuses every question that names another company, reading nothing", async () => {
    const w = seeded();
    const people = peopleA(w);
    w.sends.length = 0;
    const asks: Array<() => Promise<unknown>> = [
      () => people.approvers(B, "web"), () => people.approvers(B, undefined), () => people.onProjectRoster(B, "web", DEV_B), () => people.projectMembers!(B, "web"),
      () => people.linkedAccounts(B, DEV_B), () => people.displayName(B, DEV_B), () => people.isErased(B, DEV_B), () => people.resolveMember!(B, DEV_B),
    ];
    for (const ask of asks) await expect(ask()).rejects.toBeInstanceOf(OtherCompanyError);
    expect(w.sends).toEqual([]);
  });

  it("keeps two companies' same-named project apart: rosters, approvers and a grant never cross", async () => {
    const w = seeded();
    const a = peopleA(w), b = peopleB(w);
    expect(await a.projectMembers!(A, "web")).toEqual([OWN_A, ADMIN_A, MAINT_A, DEV_A].sort());
    expect(await b.projectMembers!(B, "web")).toEqual([OWN_B, DEV_B].sort());
    // A grant on the project does not put a person of the other company on this company's roster, in either direction.
    expect(await a.onProjectRoster(A, "web", DEV_B)).toBe(false);
    expect(await b.onProjectRoster(B, "web", DEV_A)).toBe(false);
    expect(await b.onProjectRoster(B, "web", OWN_A)).toBe(false);
    expect((await a.approvers(A, "web")).eligibleIds).toEqual([OWN_A, ADMIN_A, MAINT_A].sort());
    expect((await b.approvers(B, "web")).eligibleIds).toEqual([OWN_B]);
    expect((await b.approvers(B, "web")).ownerIds).toEqual([OWN_B]);
  });

  it("names a person only of this company: another company's person, and nobody, have no name", async () => {
    const w = seeded();
    const a = peopleA(w);
    expect(await a.displayName(A, DEV_A)).toBe(`Name ${DEV_A.slice(-2)}`);
    expect(await a.displayName(A, DEV_B)).toBeUndefined();
    expect(await a.displayName(A, id(999))).toBeUndefined();
    expect(await a.displayName(A, "rovara-system")).toBeUndefined();
  });

  it("never reads an erase receipt of another company as this company's", async () => {
    const w = seeded();
    const store = new MemoryDocumentStore();
    await store.put({ item: { ...personErasedKey(B, DEV_A), entityType: "PERSON_ERASED", personId: DEV_A } });
    const a = build(w)(A, { store: async () => store });
    expect(await a.isErased(A, DEV_A)).toBe(false);
    await store.put({ item: { ...personErasedKey(A, DEV_A), entityType: "PERSON_ERASED", personId: DEV_A } });
    expect(await a.isErased(A, DEV_A)).toBe(true);
    expect(await a.isErased(A, DEV_B)).toBe(false);
    // An id no receipt can exist for is never named.
    expect(await a.isErased(A, "bad id#")).toBe(true);
  });
});

describe("hosted lessons people: project isolation", () => {
  it("puts a person on the roster of the project they hold a grant on, and no other", async () => {
    const w = seeded();
    w.grant(DEV_A, "api", "developer");
    const a = peopleA(w);
    expect(await a.onProjectRoster(A, "web", DEV_A)).toBe(true);
    expect(await a.onProjectRoster(A, "api", DEV_A)).toBe(true);
    expect(await a.onProjectRoster(A, "api", MAINT_A)).toBe(false);
    expect(await a.onProjectRoster(A, "web", PLAIN_A)).toBe(false);
    expect(await a.projectMembers!(A, "api")).toEqual([OWN_A, ADMIN_A, DEV_A].sort());
  });

  it("makes a company owner or admin a member of every project, a project maintainer only of theirs", async () => {
    const w = seeded();
    const a = peopleA(w);
    for (const project of ["web", "api", "anything"]) {
      expect(await a.onProjectRoster(A, project, OWN_A)).toBe(true);
      expect(await a.onProjectRoster(A, project, ADMIN_A)).toBe(true);
    }
    expect(await a.onProjectRoster(A, "api", MAINT_A)).toBe(false);
  });

  it("approvers: a project's maintainer is eligible for that project only; the company-wide list holds owners and admins only", async () => {
    const w = seeded();
    const a = peopleA(w);
    expect((await a.approvers(A, "web")).eligibleIds).toEqual([OWN_A, ADMIN_A, MAINT_A].sort());
    expect((await a.approvers(A, "api")).eligibleIds).toEqual([OWN_A, ADMIN_A].sort());
    expect((await a.approvers(A, undefined)).eligibleIds).toEqual([OWN_A, ADMIN_A].sort());
    // A developer grant is a reader, never an approver.
    expect((await a.approvers(A, "web")).eligibleIds).not.toContain(DEV_A);
  });

  it("answers no for a name that is not a project's and refuses to list or approve for one", async () => {
    const w = seeded();
    const a = peopleA(w);
    expect(await a.onProjectRoster(A, "bad name/..", OWN_A)).toBe(false);
    expect(await a.onProjectRoster(A, "", OWN_A)).toBe(false);
    await expect(a.projectMembers!(A, "bad name/..")).rejects.toThrow();
    await expect(a.approvers(A, "bad name/..")).rejects.toThrow();
  });
});

describe("hosted lessons people: approvers", () => {
  it("lists live owners and non-owner admins and maintainers; ownerIds is owners only", async () => {
    const w = seeded();
    const a = await peopleA(w).approvers(A, "web");
    expect(a.complete).toBe(true);
    expect(a.ownerIds).toEqual([OWN_A]);
    expect(a.eligibleIds).toEqual([OWN_A, ADMIN_A, MAINT_A].sort());
    // The non-owner admin is a decider (the notices that go to deciders use this list), though not an owner.
    expect(a.eligibleIds).toContain(ADMIN_A);
    expect(a.ownerIds).not.toContain(ADMIN_A);
  });

  it("changes the membership version exactly when who may approve changes", async () => {
    const w = seeded();
    const a = peopleA(w);
    const first = await a.approvers(A, "web");
    const again = await a.approvers(A, "web");
    expect(Number.isSafeInteger(first.membershipVersion)).toBe(true);
    expect(first.membershipVersion).toBeGreaterThanOrEqual(0);
    expect(again.membershipVersion).toBe(first.membershipVersion);
    // A person who cannot approve joining changes nothing; a new admin changes it; the other project's list differs.
    w.member(id(20), A, "member");
    expect((await a.approvers(A, "web")).membershipVersion).toBe(first.membershipVersion);
    expect((await a.approvers(A, "api")).membershipVersion).not.toBe(first.membershipVersion);
    w.member(id(21), A, "admin");
    expect((await a.approvers(A, "web")).membershipVersion).not.toBe(first.membershipVersion);
    // And the other company's is its own.
    expect((await peopleB(w).approvers(B, "web")).membershipVersion).not.toBe(first.membershipVersion);
  });

  it("reports when an owner or admin was last lost: a removed one by their removal time, a demoted one by the role change", async () => {
    const none = await peopleA(seeded()).approvers(A, "web");
    expect(none.lastEligibleLossAtMs).toBeNull();
    const w = seeded();
    w.member(GONE_A, A, "admin", { revokedAt: "2026-11-18T08:00:00.000Z", revokedBy: OWN_A });
    expect((await peopleA(w).approvers(A, "web")).lastEligibleLossAtMs).toBe(Date.parse("2026-11-18T08:00:00.000Z"));
    // A removed PLAIN member is no loss; a member whose role was changed to member is (an admin was demoted).
    const v = seeded();
    v.member(id(30), A, "member", { revokedAt: "2026-11-18T09:00:00.000Z", revokedBy: OWN_A });
    expect((await peopleA(v).approvers(A, "web")).lastEligibleLossAtMs).toBeNull();
    v.member(id(31), A, "member", { updatedAt: "2026-11-18T10:00:00.000Z", updatedBy: OWN_A });
    expect((await peopleA(v).approvers(A, "web")).lastEligibleLossAtMs).toBe(Date.parse("2026-11-18T10:00:00.000Z"));
    // The newest wins, and a time in the future is held to now (a clock apart never reads as unavailable).
    v.member(id(32), A, "owner", { revokedAt: "2026-11-18T09:30:00.000Z" });
    expect((await peopleA(v).approvers(A, "web")).lastEligibleLossAtMs).toBe(Date.parse("2026-11-18T10:00:00.000Z"));
    v.member(id(33), A, "admin", { revokedAt: "2030-01-01T00:00:00.000Z" });
    expect((await peopleA(v).approvers(A, "web")).lastEligibleLossAtMs).toBe(NOW);
  });
});

describe("hosted lessons people: live, at once", () => {
  it("drops a removed member from the roster, the approvers and the list on the very next read", async () => {
    const w = seeded();
    const a = peopleA(w);
    expect(await a.onProjectRoster(A, "web", MAINT_A)).toBe(true);
    expect((await a.approvers(A, "web")).eligibleIds).toContain(MAINT_A);
    expect(await a.projectMembers!(A, "web")).toContain(MAINT_A);
    // The authoritative row says removed; the company's list row (written with it in one transaction) is not what the answer rests on.
    w.patchAuthoritative(MAINT_A, { revokedAt: "2026-11-18T11:59:00.000Z" });
    expect(await a.onProjectRoster(A, "web", MAINT_A)).toBe(false);
    expect((await a.approvers(A, "web")).eligibleIds).not.toContain(MAINT_A);
    expect(await a.projectMembers!(A, "web")).not.toContain(MAINT_A);
  });

  it("drops an admin who was demoted to a plain member from the approvers and from rosters they had no grant for", async () => {
    const w = seeded();
    const a = peopleA(w);
    expect(await a.onProjectRoster(A, "api", ADMIN_A)).toBe(true);
    w.patchAuthoritative(ADMIN_A, { role: "member" });
    expect(await a.onProjectRoster(A, "api", ADMIN_A)).toBe(false);
    expect((await a.approvers(A, "web")).eligibleIds).not.toContain(ADMIN_A);
  });

  it("drops a person whose grant was removed, and keeps nothing between calls", async () => {
    const w = seeded();
    const a = peopleA(w);
    expect(await a.onProjectRoster(A, "web", DEV_A)).toBe(true);
    w.rows.delete(`${STATE}|MEMBER#${DEV_A}|PROJECT#web`);
    expect(await a.onProjectRoster(A, "web", DEV_A)).toBe(false);
    expect(await a.projectMembers!(A, "web")).not.toContain(DEV_A);
    const before = w.sends.length;
    await a.onProjectRoster(A, "web", DEV_A);
    expect(w.sends.length).toBeGreaterThan(before);
  });

  it("a person who joined is on the next roster read", async () => {
    const w = seeded();
    const a = peopleA(w);
    expect(await a.projectMembers!(A, "web")).not.toContain(id(40));
    w.member(id(40), A, "member"); w.grant(id(40), "web", "developer");
    expect(await a.projectMembers!(A, "web")).toContain(id(40));
  });
});

describe("hosted lessons people: the roster the names filter needs", () => {
  it("lists plain project members with no project-side row (a grant made before the list existed) and names them", async () => {
    const w = seeded();
    const a = peopleA(w);
    // There is no PROJECT_MEMBERS# row for anybody here: the roster still has every grant holder, from the authoritative grant.
    expect([...w.rows.keys()].some((k) => k.includes("PROJECT_MEMBERS#"))).toBe(false);
    const roster = await a.projectMembers!(A, "web");
    expect(roster).toContain(DEV_A);
    expect(roster).not.toContain(PLAIN_A);
    const names = await Promise.all(roster.map((person) => a.displayName(A, person)));
    expect(names).toContain(`Name ${DEV_A.slice(-2)}`);
    expect(names).not.toContain(`Name ${PLAIN_A.slice(-2)}`);
    expect(names.every((name) => name !== undefined)).toBe(true);
  });

  it("is the same set as onProjectRoster says yes for", async () => {
    const w = seeded();
    const a = peopleA(w);
    const roster = new Set(await a.projectMembers!(A, "web"));
    for (const person of [OWN_A, ADMIN_A, MAINT_A, DEV_A, PLAIN_A, OWN_B, DEV_B, id(999)]) expect(roster.has(person), person).toBe(await a.onProjectRoster(A, "web", person));
  });

  it("throws, never a shorter list, when the company is too large or a read fails", async () => {
    const w = seeded();
    for (let n = 100; n < 100 + HOSTED_PEOPLE_MEMBERS_MAX; n += 1) w.member(id(n), A, "member");
    await expect(peopleA(w).projectMembers!(A, "web")).rejects.toThrow();
    await expect(peopleA(w).approvers(A, "web")).rejects.toThrow();
    const f = seeded();
    f.failing.query = true;
    await expect(peopleA(f).projectMembers!(A, "web")).rejects.toThrow();
    await expect(peopleA(f).approvers(A, "web")).rejects.toThrow();
    const g = seeded();
    g.failing.getPk = "MEMBER#";
    await expect(peopleA(g).projectMembers!(A, "web")).rejects.toThrow();
    await expect(peopleA(g).onProjectRoster(A, "web", DEV_A)).rejects.toThrow();
    const h = seeded();
    h.failing.getPk = "COMPANY_MEMBER#";
    await expect(peopleA(h).approvers(A, "web")).rejects.toThrow();
  });

  it("holds a roster of exactly the cap complete (the cap is a limit on what is served, not an off-by-one)", async () => {
    const w = world();
    for (let n = 1; n <= HOSTED_PEOPLE_MEMBERS_MAX; n += 1) w.member(id(n), A, n === 1 ? "owner" : "member");
    const answer = await peopleA(w).approvers(A, "web");
    expect(answer.ownerIds).toEqual([id(1)]);
    expect(await peopleA(w).projectMembers!(A, "web")).toEqual([id(1)]);
  });

  it("refuses a company list row that names another company or a malformed person", async () => {
    const w = seeded();
    w.put(SIGN_IN, { pk: companyScoped(A, "MEMBERS"), sk: `MEMBER#${id(50)}`, entityType: "COMPANY_MEMBER_VIEW", personId: id(50), companyId: B, role: "owner", joinedAt: "2026-10-01T00:00:00.000Z" });
    await expect(peopleA(w).approvers(A, "web")).rejects.toThrow();
    await expect(peopleA(w).projectMembers!(A, "web")).rejects.toThrow();
  });

  it("throws on an install with no company layer, on every read", async () => {
    const w = seeded();
    for (const table of [undefined, ""]) {
      const people = build(w, { signInTableName: table })(A, noStore);
      await expect(people.approvers(A, "web")).rejects.toThrow();
      await expect(people.projectMembers!(A, "web")).rejects.toThrow();
      await expect(people.onProjectRoster(A, "web", OWN_A)).rejects.toThrow();
      await expect(people.displayName(A, OWN_A)).rejects.toThrow();
      await expect(people.resolveMember!(A, OWN_A)).rejects.toThrow();
    }
  });
});

describe("hosted lessons people: names", () => {
  it("names a former member (removed, record still readable) and nobody whose sign-in record is revoked or unreadable", async () => {
    const w = seeded();
    w.member(GONE_A, A, "member", { revokedAt: "2026-11-17T00:00:00.000Z" });
    w.developer(GONE_A);
    const a = peopleA(w);
    expect(await a.displayName(A, GONE_A)).toBe(`Name ${GONE_A.slice(-2)}`);
    w.developer(GONE_A, { revoked: true });
    expect(await a.displayName(A, GONE_A)).toBeUndefined();
    w.rows.delete(`${SIGN_IN}|DEVELOPER#${DEV_A}|META`);
    expect(await a.displayName(A, DEV_A)).toBeUndefined();
    w.failing.getPk = "DEVELOPER#";
    await expect(a.displayName(A, OWN_A)).rejects.toThrow();
  });

  it("gives a GitHub person's name through the one display helper (clean text, no address or markup)", async () => {
    const w = seeded();
    w.developer(DEV_A, { provider: "github", subject: "12345", displayName: "Ada <b>Lovelace</b> ada@example.com" });
    const name = await peopleA(w).displayName(A, DEV_A);
    expect(name).toBeDefined();
    expect(name).not.toMatch(/[<>@]/u);
  });

  it("has no outside accounts linked, so a person reads only places nothing restricts", async () => {
    expect(await peopleA(seeded()).linkedAccounts(A, DEV_A)).toEqual([]);
  });
});

describe("hosted lessons people: merged sign-ins and erase", () => {
  it("resolves a merged id to the member it became, in this company only", async () => {
    const w = seeded();
    w.developer(id(60), { mergedInto: DEV_A });
    const a = peopleA(w);
    expect(await a.resolveMember!(A, id(60))).toBe(DEV_A);
    expect(await a.resolveMember!(A, DEV_A)).toBe(DEV_A);
    // Never merged: stands for itself (a system id, a person with no record).
    expect(await a.resolveMember!(A, "rovara-system")).toBe("rovara-system");
    expect(await a.resolveMember!(A, id(61))).toBe(id(61));
    // A merge into a person of another company, a loop, an unreadable link and a chain that is too long are refused, never guessed.
    w.developer(id(62), { mergedInto: DEV_B });
    await expect(a.resolveMember!(A, id(62))).rejects.toThrow();
    w.developer(id(63), { mergedInto: id(64) }); w.developer(id(64), { mergedInto: id(63) });
    await expect(a.resolveMember!(A, id(63))).rejects.toThrow();
    w.developer(id(65), { mergedInto: "not-a-person" });
    await expect(a.resolveMember!(A, id(65))).rejects.toThrow();
    w.developer(id(66), { mergedInto: id(67) });
    await expect(a.resolveMember!(A, id(66))).rejects.toThrow();
    for (let n = 0; n < 9; n += 1) w.developer(id(80 + n), { mergedInto: id(81 + n) });
    w.developer(id(89)); w.member(id(89), A, "member");
    await expect(a.resolveMember!(A, id(80))).rejects.toThrow();
    // Eight merges (the bound) still resolve.
    for (let n = 0; n < 7; n += 1) w.developer(id(120 + n), { mergedInto: id(121 + n) });
    w.developer(id(127), { mergedInto: DEV_A });
    expect(await a.resolveMember!(A, id(120))).toBe(DEV_A);
  });

  it("follows a chain of merges to its end (within the bound)", async () => {
    const w = seeded();
    w.developer(id(70), { mergedInto: id(71) }); w.developer(id(71), { mergedInto: DEV_A });
    expect(await peopleA(w).resolveMember!(A, id(70))).toBe(DEV_A);
  });

  it("reads the erase receipt only when asked, from the store the company's runtime gives", async () => {
    const w = seeded();
    let asked = 0;
    const store = new MemoryDocumentStore();
    const a = build(w)(A, { store: async () => { asked += 1; return store; } });
    await a.approvers(A, "web"); await a.onProjectRoster(A, "web", DEV_A); await a.displayName(A, DEV_A);
    expect(asked).toBe(0);
    expect(await a.isErased(A, DEV_A)).toBe(false);
    expect(asked).toBe(1);
    const broken = build(w)(A, { store: async () => ({ get: async () => { throw new Error("store down"); } }) });
    await expect(broken.isErased(A, DEV_A)).rejects.toThrow();
  });
});

describe("hosted lessons people: building one reads nothing", () => {
  it("builds a port without reading, and without a table until asked", () => {
    const w = seeded();
    w.sends.length = 0;
    build(w, { signInTableName: undefined })(A, noStore);
    build(w)(A, noStore);
    expect(w.sends).toEqual([]);
  });
});
