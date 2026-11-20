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
  /** Each member's company: a named company keeps its grants in its own partition (DEC 254zzz80). */
  const companyOf = new Map<string, OrgId>();
  const member = (personId: string, companyId: OrgId, role: "owner" | "admin" | "member", extra: Row = {}) => {
    companyOf.set(personId, companyId);
    const base = { entityType: "COMPANY_MEMBERSHIP", personId, companyId, role, joinedAt: "2026-10-01T00:00:00.000Z", joinedVia: "preapproval", ...extra };
    put(SIGN_IN, { pk: `COMPANY_MEMBER#${personId}`, sk: "COMPANY", ...base });
    put(SIGN_IN, { pk: companyScoped(companyId, "MEMBERS"), sk: `MEMBER#${personId}`, ...base, entityType: "COMPANY_MEMBER_VIEW" });
  };
  /** A grant in the person's own company's partition (`ORG#<company>#MEMBER#<person>`, DEC 254zzz80). */
  const grant = (personId: string, project: string, role: "developer" | "administrator") => put(STATE, { pk: `ORG#${companyOf.get(personId)!}#MEMBER#${personId}`, sk: `PROJECT#${project}`, projectName: project, role });
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

  it("reports when an owner or admin was last lost: a removed one by their removal time, a demoted one by the role change", async () => {
    const none = await peopleA(seeded()).approvers(A, "web");
    expect(none.lastEligibleLossAtMs).toBeNull();
    const w = seeded();
    w.member(GONE_A, A, "admin", { revokedAt: "2026-11-18T08:00:00.000Z", revokedBy: OWN_A });
    expect((await peopleA(w).approvers(A, "web")).lastEligibleLossAtMs).toBe(Date.parse("2026-11-18T08:00:00.000Z"));
    // A removed PLAIN member is no loss company-wide, but for a project it may have been the maintainer (a plain member with an administrator grant), so it counts there.
    const v = seeded();
    v.member(id(30), A, "member", { revokedAt: "2026-11-18T09:00:00.000Z", revokedBy: OWN_A });
    expect((await peopleA(v).approvers(A, undefined)).lastEligibleLossAtMs).toBeNull();
    expect((await peopleA(v).approvers(A, "web")).lastEligibleLossAtMs).toBe(Date.parse("2026-11-18T09:00:00.000Z"));
    v.rows.delete(`${SIGN_IN}|COMPANY_MEMBER#${id(30)}|COMPANY`);
    v.rows.delete(`${SIGN_IN}|${companyScoped(A, "MEMBERS")}|MEMBER#${id(30)}`);
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

describe("hosted lessons people: the roster the names filter needs", () => {

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
    g.failing.getPk = `ORG#${A}#MEMBER#`;
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
    expect((await peopleA(w).projectMembers!(A, "web")).ids).toEqual([id(1)]);
  });

  it("refuses a company list row that names another company or a malformed person", async () => {
    const w = seeded();
    w.put(SIGN_IN, { pk: companyScoped(A, "MEMBERS"), sk: `MEMBER#${id(50)}`, entityType: "COMPANY_MEMBER_VIEW", personId: id(50), companyId: B, role: "owner", joinedAt: "2026-10-01T00:00:00.000Z" });
    await expect(peopleA(w).approvers(A, "web")).rejects.toThrow();
    await expect(peopleA(w).projectMembers!(A, "web")).rejects.toThrow();
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
});
