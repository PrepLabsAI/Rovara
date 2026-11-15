import { expect, it, vi } from "vitest";
import { IMPLICIT_COMPANY_ID, companyScoped } from "@agentx/contracts";
import { CompanySignInStore } from "../../packages/broker/src/developer/company-membership.js";
import { companyOperator } from "../../packages/broker/src/developer/company-operator.js";
import { membershipKey } from "../../packages/broker/src/aws/company-check.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const A = `org_${"a".repeat(20)}`, B = `org_${"b".repeat(20)}`;
const p = "1".repeat(64), q = "2".repeat(64), actor = "3".repeat(64);
const at = "2026-11-15T00:00:00.000Z";
const lastOwner = { ok: false, error: "unavailable", message: "a company must keep at least one active owner" };
const stepUp = { ok: false, error: "step_up_required", message: "this role change needs a fresh sign-in check; sign in again and retry" };
const unavailable = { ok: false, error: "unavailable" };
const mirrorKey = (companyId: string, personId: string) => ({ pk: companyScoped(companyId, "MEMBERS"), sk: `MEMBER#${personId}` });
function world() {
  const db = new FakeDynamoDb(); let time = Date.parse(at);
  const store = new CompanySignInStore({ documentClient: db, tableName: "signin", now: () => time });
  const logs: Record<string, unknown>[] = [];
  const invoke = (event: unknown) => companyOperator({ store, now: () => time, log: (entry) => logs.push(entry) }, event);
  const seed = (personId = p, role: "member" | "admin" | "owner" = "owner", companyId = A, extra = {}) => {
    const fields = { personId, companyId, role, joinedAt: at, ...extra };
    db.set({ ...membershipKey(personId), ...fields, entityType: "COMPANY_MEMBERSHIP" });
    db.set({ ...mirrorKey(companyId, personId), ...fields, entityType: "COMPANY_MEMBER_VIEW" });
  };
  return { db, store, invoke, logs, seed, tick: (ms: number) => { time += ms; } };
}
const roleSet = (personId = p, role = "member", companyId = A) => ({ kind: "company-member-role-set" as const, companyId, personId, role });
const revoke = (personId = p) => ({ kind: "company-member-revoke" as const, companyId: A, personId });
const list = (companyId = A, extra = {}) => ({ kind: "company-member-list", companyId, ...extra });
function assertMirror(h: ReturnType<typeof world>, personId: string) {
  const member = h.db.get(membershipKey(personId).pk, "COMPANY")!;
  const key = mirrorKey(member.companyId as string, personId);
  expect(h.db.get(key.pk, key.sk)).toEqual({ ...member, ...key, entityType: "COMPANY_MEMBER_VIEW" });
}

it("role-set writes the mirror and one attributed audit atomically; same role is a no-op", async () => {
  const h = world(); verifyStepUp(h); h.seed(p, "admin"); h.seed(actor, "admin");
  expect(await h.invoke({ ...roleSet(), createdBy: actor })).toEqual({ ok: true });
  expect(await h.store.membership(p)).toMatchObject({ role: "member", updatedBy: actor, updatedAt: at });
  assertMirror(h, p);
  expect(h.db.find((row) => row.entityType === "COMPANY_LOG")).toEqual([expect.objectContaining({ event: "company-member-role-set", companyId: A, personId: p, fromRole: "admin", toRole: "member", createdBy: actor, createdAt: at })]);
  const before = [...h.db.items.values()]; const logs = [...h.logs];
  expect(await h.invoke({ ...roleSet(), createdBy: actor })).toEqual({ ok: true });
  expect([...h.db.items.values()]).toEqual(before); expect(h.logs).toEqual(logs);
  expect(h.db.refusals).toEqual([]);
});

it.each(["admin", "owner"])("refuses target %s at the #660 seam, including an unchanged elevated role", async (role) => {
  const h = world(); h.seed(p, role as "admin" | "owner"); h.seed(actor, "owner");
  const before = [...h.db.items.values()];
  expect(await h.invoke({ ...roleSet(p, role), createdBy: actor })).toEqual(stepUp);
  expect([...h.db.items.values()]).toEqual(before); expect(h.logs).toEqual([]);
});

it.each([roleSet(), revoke()])("last owner is refused with fixed bytes: %s", async (event) => {
  const h = world(); verifyStepUp(h); h.seed(); h.seed(q, "owner", A, { revokedAt: at, revokedBy: "operator" });
  const before = [...h.db.items.values()];
  expect(await h.invoke({ ...event, createdBy: "personId" in event ? event.personId : p })).toEqual(lastOwner);
  expect([...h.db.items.values()]).toEqual(before); expect(h.logs).toEqual([]);
});

it.each(["role-role", "revoke-revoke", "role-revoke"])("last-owner race %s: both commit orders and interleaved reads", async (mode) => {
  for (const reverse of [false, true]) {
    const h = world(); verifyStepUp(h); h.seed(); h.seed(q);
    const calls = [mode.startsWith("role") ? roleSet() : revoke(), mode.endsWith("role") ? roleSet(q) : revoke(q)];
    const send = h.db.send; const pending: Array<() => Promise<void>> = [];
    let both!: () => void; const ready = new Promise<void>((resolve) => { both = resolve; });
    h.db.send = (command) => {
      if (command.constructor.name !== "TransactWriteCommand") return send(command);
      return new Promise((resolve, reject) => {
        pending.push(async () => { try { resolve(await send(command)); } catch (error) { reject(error instanceof Error ? error : new Error("transaction failed")); } });
        if (pending.length === 2) both();
      });
    };
    const results = calls.map((event) => h.invoke({ ...event, createdBy: "personId" in event ? event.personId : p }));
    await ready;
    for (const commit of reverse ? pending.toReversed() : pending) await commit();
    const answers = await Promise.all(results);
    expect(answers.filter((answer) => answer.ok)).toHaveLength(1);
    expect(answers.filter((answer) => !answer.ok)).toEqual([lastOwner]);
    const owners = h.db.find((row) => row.entityType === "COMPANY_MEMBERSHIP" && row.role === "owner" && row.revokedAt === undefined);
    expect(owners).toHaveLength(1); assertMirror(h, p); assertMirror(h, q);
    expect(h.db.refusals).toEqual([]);
  }
});

it.each([false, true])("sequential demote/revoke cannot remove the final owner (reverse=%s)", async (reverse) => {
  const h = world(); verifyStepUp(h); h.seed(); h.seed(q);
  const calls = reverse ? [revoke(q), roleSet()] : [roleSet(), revoke(q)];
  expect(await h.invoke({ ...calls[0], createdBy: calls[0]!.personId })).toEqual({ ok: true });
  expect(await h.invoke({ ...calls[1], createdBy: calls[1]!.personId })).toEqual(lastOwner);
});

it("a stale mirror is never owner authority", async () => {
  const h = world(); verifyStepUp(h); h.seed(); h.seed(q);
  h.db.set({ ...h.db.get(membershipKey(q).pk, "COMPANY")!, role: "member" });
  expect(await h.invoke({ ...roleSet(), createdBy: p })).toEqual(lastOwner);
  expect(await h.store.membership(p)).toMatchObject({ role: "owner" });
});

it("role-set refuses a revoked member; absent/foreign and malformed targets have fixed answers", async () => {
  const h = world(); h.seed(p, "admin", A, { revokedAt: at, revokedBy: "operator" });
  expect(await h.invoke(roleSet())).toEqual({ ok: false, error: "unavailable", message: "restore this member before changing their role" });
  expect(await h.invoke(roleSet(q))).toEqual({ ok: false, error: "not_found" });
  expect(await h.invoke(roleSet(p, "member", B))).toEqual({ ok: false, error: "not_found" });
  h.db.set({ ...h.db.get(membershipKey(p).pk, "COMPANY")!, role: "private-canary" });
  expect(await h.invoke(roleSet())).toEqual(unavailable); expect(h.logs).toEqual([]);
});

it.each([null, [], {}, { role: "private-canary" }, { personId: 5 }, { companyId: B, role: "bad" }, { createdBy: "operator" }, { actorRole: "admin" }, { role: undefined }])("runtime-validates role input with fixed words: %s", async (damage) => {
  const h = world();
  const event = damage === null || Array.isArray(damage) ? damage : { ...roleSet(), ...damage };
  // The empty object leaves a well-formed but missing target.
  expect(await h.invoke(event)).toEqual(damage !== null && !Array.isArray(damage) && Object.keys(damage).length === 0 ? { ok: false, error: "not_found" } : { ok: false, error: "invalid_request" });
  expect(h.db.items.size).toBe(0); expect(h.logs).toEqual([]);
});

it.each(["revoked", "member", "foreign", "missing", "malformed"])("supplied actor must be a live same-company admin/owner: %s", async (damage) => {
  const h = world(); h.seed(p, "admin");
  if (damage !== "missing") h.seed(actor, damage === "member" ? "member" : "admin", damage === "foreign" ? B : A, damage === "revoked" ? { revokedAt: at } : damage === "malformed" ? { role: "private-canary" } : {});
  const before = [...h.db.items.values()];
  expect(await h.invoke({ ...roleSet(), createdBy: actor })).toEqual(unavailable);
  expect([...h.db.items.values()]).toEqual(before);
});

it.each(["company-member-role-set", "company-member-revoke", "company-member-restore"])("%s rechecks actor in its transaction, including self and witness overlap", async (kind) => {
  for (const actorId of [actor, p, q]) {
    const h = world(); verifyStepUp(h); h.seed(p, "owner", A, kind === "company-member-restore" ? { revokedAt: at } : {}); h.seed(q); h.seed(actor, "owner");
    if (kind === "company-member-restore" && actorId === p) continue;
    const send = h.db.send;
    h.db.send = async (command) => {
      if (command.constructor.name === "TransactWriteCommand") h.db.set({ ...h.db.get(membershipKey(actorId).pk, "COMPANY")!, revokedAt: at });
      return send(command);
    };
    expect((await h.invoke({ kind, companyId: A, personId: p, ...(kind === "company-member-role-set" ? { role: "member" } : {}), createdBy: actorId })).ok).toBe(false);
    expect(h.db.find((row) => row.entityType === "COMPANY_LOG")).toEqual([]);
    expect(h.db.refusals).toEqual([]);
  }
});

it("operator omission preserves operator attribution; every member writer commits both rows in one transaction", async () => {
  const h = world(); verifyStepUp(h); const transactions: Array<Record<string, unknown>> = [];
  const send = h.db.send;
  h.db.send = async (command) => { if (command.constructor.name === "TransactWriteCommand") transactions.push(command.input); return send(command); };
  await h.store.preapprove(IMPLICIT_COMPANY_ID, "member@example.test", "admin", 1);
  expect(await h.store.join({ companyId: IMPLICIT_COMPANY_ID, personId: p, email: "member@example.test" })).toMatchObject({ ok: true }); assertMirror(h, p);
  expect(await h.invoke(roleSet(p, "member", IMPLICIT_COMPANY_ID))).toEqual({ ok: true }); assertMirror(h, p);
  expect(await h.store.membership(p)).toMatchObject({ updatedBy: "operator" });
  expect(await h.store.setRevoked(IMPLICIT_COMPANY_ID, p, true)).toBe(true); assertMirror(h, p);
  expect(await h.store.membership(p)).toMatchObject({ revokedBy: "operator" });
  expect(await h.store.setRevoked(IMPLICIT_COMPANY_ID, p, false)).toBe(true); assertMirror(h, p);
  const legacy = ownerKeyForSubject("https://legacy.example.test", "legacy");
  h.db.set({ pk: `DEVELOPER#${legacy}`, sk: "META", entityType: "DEVELOPER", provider: "oidc", issuer: "https://legacy.example.test", subject: "legacy", revoked: false, firstSignInAt: at });
  expect(await h.store.join({ companyId: IMPLICIT_COMPANY_ID, personId: legacy })).toMatchObject({ ok: true }); assertMirror(h, legacy);
  let writes = 0;
  for (const transaction of transactions) {
    const entries = transaction.TransactItems as Array<Record<string, { Item?: Record<string, unknown>; Key?: Record<string, unknown> }>>;
    for (const entry of entries) {
      const item = entry.Put?.Item ?? entry.Update?.Key;
      if (typeof item?.pk !== "string" || !item.pk.startsWith("COMPANY_MEMBER#")) continue;
      writes++;
      expect(entries.some((entry) => entry.Put?.Item?.entityType === "COMPANY_MEMBER_VIEW")).toBe(true);
    }
  }
  expect(writes).toBe(5); expect(h.db.refusals).toEqual([]);
});

it("a failed member transaction leaves membership, mirror and audit unchanged", async () => {
  const h = world(); verifyStepUp(h); h.seed(p, "admin"); const before = [...h.db.items.values()];
  h.db.injectFault({ command: "TransactWriteCommand", error: { name: "AccessDeniedException", message: "private-canary" } });
  expect(await h.invoke(roleSet())).toEqual(unavailable);
  expect([...h.db.items.values()]).toEqual(before); expect(h.logs).toEqual([]);
});

it("lists both companies separately with identical raw person ids; 100 rows and opaque continuation work", async () => {
  const h = world();
  for (let i = 0; i < 101; i++) {
    const personId = i.toString(16).padStart(64, "0");
    h.seed(personId, "member", A); h.seed(personId, "admin", B);
  }
  const first = await h.invoke(list(A));
  expect(first).toMatchObject({ ok: true, more: true, cursor: expect.any(String) as unknown });
  const page = first as { members: Array<{ companyId: string; role: string }>; cursor: string };
  expect(page.members).toHaveLength(100); expect(page.members.every((m) => m.companyId === A && m.role === "member")).toBe(true);
  const last = await h.invoke(list(A, { cursor: page.cursor }));
  expect(last).toMatchObject({ ok: true, more: false, members: [expect.objectContaining({ companyId: A })] });
  expect(last).not.toHaveProperty("cursor");
  const other = await h.invoke(list(B, { limit: 100 }));
  expect((other as { members: Array<{ companyId: string; role: string }> }).members.every((m) => m.companyId === B && m.role === "admin")).toBe(true);
  expect(await h.invoke(list(B, { cursor: page.cursor }))).toEqual({ ok: false, error: "invalid_request" });
});

it.each([0, 101, 1.1, "1", null])("rejects invalid list limit %s", async (limit) => {
  const h = world(); expect(await h.invoke(list(A, { limit }))).toEqual({ ok: false, error: "invalid_request" }); expect(h.db.commandNames()).toEqual([]);
});

it.each(["private-canary", "x".repeat(1_000_000), 1, null])("rejects malformed cursor without storage or echoed input", async (cursor) => {
  const h = world(); expect(await h.invoke(list(A, { cursor }))).toEqual({ ok: false, error: "invalid_request" }); expect(h.db.commandNames()).toEqual([]);
});

it.each([{ role: "private-canary" }, { personId: q }, { companyId: B }, { revokedAt: false }, { entityType: "wrong" }])("refuses the whole list for malformed row %s", async (damage) => {
  const h = world(); h.seed(); h.seed(q);
  const key = mirrorKey(A, p); h.db.set({ ...h.db.get(key.pk, key.sk)!, ...damage });
  expect(await h.invoke(list())).toEqual(unavailable); expect(h.logs).toEqual([]);
});

it("continues DynamoDB filter-short pages, including empty pages, to the requested limit", async () => {
  const h = world(); for (let i = 0; i < 8; i++) h.seed(i.toString(16).padStart(64, "0"), i < 5 ? "member" : "admin");
  const send = h.db.send; let queries = 0;
  h.db.send = async (command) => {
    if (command.constructor.name === "QueryCommand") {
      queries++;
      return send({ ...command, constructor: command.constructor, input: { ...command.input, Limit: 1, FilterExpression: "#role = :role", ExpressionAttributeNames: { "#role": "role" }, ExpressionAttributeValues: { ...command.input.ExpressionAttributeValues as object, ":role": "admin" } } });
    }
    return send(command);
  };
  expect(await h.invoke(list(A, { limit: 2 }))).toMatchObject({ ok: true, more: true, members: [expect.objectContaining({ role: "admin" }), expect.objectContaining({ role: "admin" })] });
  expect(queries).toBe(7);
});

it.each(["time", "bytes", "cycle", "missing-items", "foreign-cursor"])("list total budget/response %s fails closed without a partial answer", async (mode) => {
  const h = world(); h.seed(); h.seed(q);
  const send = h.db.send;
  h.db.send = async (command) => {
    if (command.constructor.name !== "QueryCommand") return send(command);
    if (mode === "time") { const result = await send(command); h.tick(10_001); return result; }
    if (mode === "bytes") return { Items: [h.db.get(mirrorKey(A, p).pk, mirrorKey(A, p).sk)], padding: "x".repeat(1_100_001) };
    if (mode === "missing-items") return {};
    return { Items: [], LastEvaluatedKey: mirrorKey(mode === "foreign-cursor" ? B : A, p) };
  };
  expect(await h.invoke(list())).toEqual(unavailable);
});

it("owner discovery finds a witness beyond the first 100 non-owners", async () => {
  const h = world(); verifyStepUp(h);
  for (let i = 0; i < 150; i++) h.seed(i.toString(16).padStart(64, "0"), "member");
  h.seed(p); h.seed(q);
  expect(await h.invoke({ ...roleSet(), createdBy: p })).toEqual({ ok: true });
  expect(await h.invoke({ ...revoke(q), createdBy: q })).toEqual(lastOwner);
});

it("empty filtered pages stop at the total query cap with an explicit resumable short page", async () => {
  const h = world(); const send = h.db.send; let queries = 0;
  h.db.send = (command) => {
    if (command.constructor.name !== "QueryCommand") return send(command);
    queries++;
    return Promise.resolve({ Items: [], LastEvaluatedKey: mirrorKey(A, queries.toString(16).padStart(64, "0")), ScannedCount: 1 });
  };
  expect(await h.invoke(list())).toMatchObject({ ok: true, members: [], more: true, cursor: expect.any(String) as unknown });
  expect(queries).toBe(32);
});

it("a concurrent target promotion cannot bypass last-owner protection through a stale demotion/revoke snapshot", async () => {
  for (const event of [roleSet(), revoke()]) {
    const h = world(); verifyStepUp(h); h.seed(p, "admin"); const send = h.db.send;
    h.db.send = async (command) => {
      if (command.constructor.name === "TransactWriteCommand") h.seed(p, "owner");
      return send(command);
    };
    expect(await h.invoke(event)).toEqual(unavailable);
    expect(await h.store.membership(p)).toMatchObject({ role: "owner" });
    assertMirror(h, p); expect(h.db.find((row) => row.entityType === "COMPANY_LOG")).toEqual([]);
  }
});

it.each([p, q])("self-actor and owner-witness overlap commit without duplicate transaction actions: %s", async (createdBy) => {
  const h = world(); verifyStepUp(h); h.seed(); h.seed(q);
  expect(await h.invoke({ ...roleSet(), createdBy })).toEqual({ ok: true });
  assertMirror(h, p); expect(h.db.refusals).toEqual([]);
});

it.each(["member", "revoked"])("self actor changed between actor and target reads refuses: %s", async (damage) => {
  const h = world(); h.seed(p, "admin"); const send = h.db.send; let reads = 0;
  h.db.send = async (command) => {
    const result = await send(command);
    if (command.constructor.name === "GetCommand" && ++reads === 1) h.seed(p, damage === "member" ? "member" : "admin", A, damage === "revoked" ? { revokedAt: at } : {});
    return result;
  };
  expect(await h.invoke({ ...revoke(), createdBy: p })).toEqual(unavailable);
  expect(h.db.find((row) => row.entityType === "COMPANY_LOG")).toEqual([]);
});

it("bounds total evaluated items with an explicit continuation, not a silent short result", async () => {
  const h = world(); let queries = 0; const send = h.db.send;
  h.db.send = (command) => {
    if (command.constructor.name !== "QueryCommand") return send(command);
    queries++;
    return Promise.resolve({ Items: [], ScannedCount: 100, LastEvaluatedKey: mirrorKey(A, queries.toString(16).padStart(64, "0")) });
  };
  expect(await h.invoke(list())).toMatchObject({ ok: true, members: [], more: true, cursor: expect.any(String) as unknown });
  expect(queries).toBe(10);
});

it("applies the byte budget across pages, including empty filtered pages", async () => {
  const h = world(); let queries = 0; const send = h.db.send;
  h.db.send = (command) => {
    if (command.constructor.name !== "QueryCommand") return send(command);
    queries++;
    return Promise.resolve({ Items: [], ScannedCount: 1, LastEvaluatedKey: mirrorKey(A, queries.toString(16).padStart(64, "0")), padding: "x".repeat(600_000) });
  };
  expect(await h.invoke(list())).toEqual(unavailable); expect(queries).toBe(2);
});

it("rejects a single mirror whose sort key differs from its person id", async () => {
  const h = world(); h.seed(p, "member"); const key = mirrorKey(A, p);
  h.db.set({ ...h.db.get(key.pk, key.sk)!, personId: q });
  expect(await h.invoke(list())).toEqual(unavailable);
});

// Exercise transaction guards independently of the intentionally closed #660 seam.
function verifyStepUp(h: ReturnType<typeof world>) {
  return vi.spyOn(h.store as unknown as { requireMemberStepUp(role: string): void }, "requireMemberStepUp").mockImplementation(() => {});
}
const onlyOwner = { ok: false, error: "unavailable", message: "only an owner can change or remove an owner" };
it.each([roleSet(), revoke(), roleSet(p, "admin")])("FIX-2 admin cannot change or remove an owner: %s", async (event) => {
  const h = world(); h.seed(); h.seed(q); h.seed(actor, "admin");
  const before = [...h.db.items.values()];
  expect(await h.invoke({ ...event, createdBy: actor })).toEqual(onlyOwner);
  expect([...h.db.items.values()]).toEqual(before); expect(h.logs).toEqual([]);
});
it.each(["admin", "owner"] as const)("FIX-2 current %s demotion and removal need step-up", async (role) => {
  for (const event of [roleSet(), revoke()]) {
    const h = world(); h.seed(p, role); h.seed(actor, "owner");
    const before = [...h.db.items.values()];
    expect(await h.invoke({ ...event, createdBy: actor })).toEqual(stepUp);
    expect([...h.db.items.values()]).toEqual(before); expect(h.logs).toEqual([]);
  }
});
it("FIX-2 admin can keep a plain member role and revoke a plain member without step-up", async () => {
  const h = world(); h.seed(p, "member"); h.seed(actor, "admin");
  expect(await h.invoke({ ...roleSet(), createdBy: actor })).toEqual({ ok: true });
  expect(await h.invoke({ ...revoke(), createdBy: actor })).toEqual({ ok: true });
  assertMirror(h, p);
});
it.each([actor, q, p])("FIX-2 concurrent owner actor demotion fails atomically: %s", async (createdBy) => {
  for (const event of [roleSet(), revoke()]) {
    const h = world(); h.seed(); h.seed(q); h.seed(actor); verifyStepUp(h);
    const send = h.db.send;
    h.db.send = async (command) => {
      if (command.constructor.name === "TransactWriteCommand") h.seed(createdBy, "admin");
      return send(command);
    };
    expect((await h.invoke({ ...event, createdBy })).ok).toBe(false);
    expect(h.db.find((row) => row.entityType === "COMPANY_LOG")).toEqual([]);
    expect(h.db.refusals).toEqual([]);
  }
});
it.each(["private-canary", "f".repeat(63), 7, null])("FIX-2 invalid revokedBy refuses the whole stored row: %s", async (revokedBy) => {
  const h = world(); h.seed(p, "member", A, { revokedAt: at, revokedBy });
  expect(await h.invoke(list())).toEqual(unavailable);
  expect(await h.invoke({ kind: "company-member-restore", companyId: A, personId: p })).toEqual(unavailable);
});
it.each(["operator", actor])("FIX-2 valid revokedBy round trips: %s", async (revokedBy) => {
  const h = world(); h.seed(p, "member", A, { revokedAt: at, revokedBy });
  expect(await h.store.membership(p)).toMatchObject({ revokedBy });
});

it.each(["admin", "owner"])("FIX-2 concurrent member promotion to %s cannot bypass step-up", async (role) => {
  const h = world(); h.seed(p, "member"); h.seed(actor, "admin");
  const send = h.db.send;
  h.db.send = async (command) => {
    if (command.constructor.name === "TransactWriteCommand") h.seed(p, role as "admin" | "owner");
    return send(command);
  };
  expect(await h.invoke({ ...revoke(), createdBy: actor })).toEqual(unavailable);
  expect(await h.store.membership(p)).toMatchObject({ role });
  expect(h.db.find((row) => row.entityType === "COMPANY_LOG")).toEqual([]);
});
it.each([roleSet(), roleSet(p, "admin"), revoke()])("FIX-3 operator overrides an owner without step-up and audits it: %s", async (event) => {
  const h = world(); h.seed(); h.seed(q);
  expect(await h.invoke(event)).toEqual({ ok: true });
  assertMirror(h, p);
  const member = await h.store.membership(p);
  expect(member).toMatchObject(event.kind === "company-member-revoke" ? { role: "owner", revokedBy: "operator", revokedAt: at } : { role: event.role, updatedBy: "operator", updatedAt: at });
  const audits = h.db.find((row) => row.entityType === "COMPANY_LOG");
  expect(audits).toEqual([{
    pk: companyScoped(A, "COMPANY_LOG"), sk: expect.any(String) as unknown, entityType: "COMPANY_LOG",
    event: event.kind, companyId: A, personId: p, createdBy: "operator", createdAt: at,
    fromRole: "owner", toRole: event.kind === "company-member-revoke" ? "owner" : event.role, ownerOverride: true,
  }]);
  expect(h.db.refusals).toEqual([]);
});
it.each([roleSet(), revoke()])("FIX-3 operator cannot remove the last active owner: %s", async (event) => {
  const h = world(); h.seed(); h.seed(q, "owner", A, { revokedAt: at, revokedBy: "operator" });
  const before = [...h.db.items.values()];
  expect(await h.invoke(event)).toEqual(lastOwner);
  expect([...h.db.items.values()]).toEqual(before); expect(h.logs).toEqual([]);
});
it.each([roleSet(), revoke()])("FIX-3 operator witness is checked transactionally: %s", async (event) => {
  const h = world(); h.seed(); h.seed(q);
  const send = h.db.send;
  h.db.send = async (command) => {
    if (command.constructor.name === "TransactWriteCommand") h.seed(q, "member");
    return send(command);
  };
  expect(await h.invoke(event)).toEqual(lastOwner);
  expect(await h.store.membership(p)).toMatchObject({ role: "owner" });
  expect((await h.store.membership(p))?.revokedAt).toBeUndefined();
  expect(h.db.find((row) => row.entityType === "COMPANY_LOG")).toEqual([]);
});
it("FIX-3 operator promotes a replacement before demoting and revoking the former owner", async () => {
  const h = world(); h.seed(); h.seed(q, "member");
  expect(await h.invoke(roleSet(q, "owner"))).toEqual({ ok: true });
  const promoted = [...h.db.items.values()];
  expect(await h.invoke(roleSet(q, "owner"))).toEqual({ ok: true });
  expect([...h.db.items.values()]).toEqual(promoted);
  expect(await h.invoke(roleSet())).toEqual({ ok: true });
  expect(await h.invoke(revoke())).toEqual({ ok: true });
  expect(await h.invoke(revoke(q))).toEqual(lastOwner);
  expect(h.db.find((row) => row.entityType === "COMPANY_LOG").map(({ event, createdBy, ownerOverride }) => ({ event, createdBy, ownerOverride }))).toEqual([
    { event: "company-member-role-set", createdBy: "operator", ownerOverride: undefined },
    { event: "company-member-role-set", createdBy: "operator", ownerOverride: true },
    { event: "company-member-revoke", createdBy: "operator", ownerOverride: undefined },
  ]);
  assertMirror(h, p); assertMirror(h, q);
});
it("FIX-3 signed-in owner changes never acquire the operator audit marker", async () => {
  const h = world(); h.seed(); h.seed(q); verifyStepUp(h);
  expect(await h.invoke({ ...roleSet(), createdBy: q })).toEqual({ ok: true });
  const audit = h.db.find((row) => row.entityType === "COMPANY_LOG")[0]!;
  expect(audit.createdBy).toBe(q); expect(audit).not.toHaveProperty("ownerOverride");
});
it.each([null, "", "operator", 0, false])("FIX-3 only omitted createdBy selects operator authority: %s", async (createdBy) => {
  for (const event of [roleSet(), revoke()]) {
    const h = world(); h.seed(); h.seed(q);
    const before = [...h.db.items.values()];
    expect(await h.invoke({ ...event, createdBy })).toEqual({ ok: false, error: "invalid_request" });
    expect([...h.db.items.values()]).toEqual(before); expect(h.logs).toEqual([]);
  }
});
