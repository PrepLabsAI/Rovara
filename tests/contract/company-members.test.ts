import { expect, it } from "vitest";
import { companyScoped } from "@agentx/contracts";
import { CompanySignInStore } from "../../packages/broker/src/developer/company-membership.js";
import { companyOperator } from "../../packages/broker/src/developer/company-operator.js";
import { membershipKey } from "../../packages/broker/src/aws/company-check.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const A = `org_${"a".repeat(20)}`, B = `org_${"b".repeat(20)}`;
const p = "1".repeat(64), q = "2".repeat(64), actor = "3".repeat(64);
const at = "2026-11-15T00:00:00.000Z";
const lastOwner = { ok: false, error: "unavailable", message: "a company must keep at least one active owner" };
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

it.each(["admin", "owner"])("DEC 254zzz73: an unchanged elevated role %s is a no-op for a live owner, with no step-up seam", async (role) => {
  const h = world(); h.seed(p, role as "admin" | "owner"); h.seed(actor, "owner");
  const before = [...h.db.items.values()];
  expect(await h.invoke({ ...roleSet(p, role), createdBy: actor })).toEqual({ ok: true });
  expect([...h.db.items.values()]).toEqual(before); expect(h.logs).toEqual([]);
});

it.each([roleSet(), revoke()])("last owner is refused with fixed bytes: %s", async (event) => {
  const h = world(); h.seed(); h.seed(q, "owner", A, { revokedAt: at, revokedBy: "operator" });
  const before = [...h.db.items.values()];
  expect(await h.invoke({ ...event, createdBy: "personId" in event ? event.personId : p })).toEqual(lastOwner);
  expect([...h.db.items.values()]).toEqual(before); expect(h.logs).toEqual([]);
});

it.each(["role-role", "revoke-revoke", "role-revoke"])("last-owner race %s: both commit orders and interleaved reads", async (mode) => {
  for (const reverse of [false, true]) {
    const h = world(); h.seed(); h.seed(q);
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

it.each([
  { label: "two live owners", extraOwner: false, expectedSuccesses: 1 },
  { label: "two live owners plus a removed former owner", extraOwner: "removed", expectedSuccesses: 1 },
  { label: "three live owners", extraOwner: "live", expectedSuccesses: 2 },
] as const)("owner step-down race keeps a live owner after every commit: $label", async ({ extraOwner, expectedSuccesses }) => {
  for (const reverse of [false, true]) {
    const h = world(); h.seed(p, "owner"); h.seed(q, "owner");
    if (extraOwner !== false) h.seed(actor, "owner", A, extraOwner === "removed" ? { revokedAt: at, revokedBy: "operator" } : {});
    const calls = [roleSet(p, "admin"), roleSet(q, "admin")];
    const send = h.db.send; const pending: Array<() => Promise<void>> = [];
    let both!: () => void; const ready = new Promise<void>((resolve) => { both = resolve; });
    let initialTransactions = 0;
    h.db.send = (command) => {
      if (command.constructor.name !== "TransactWriteCommand" || initialTransactions === 2) return send(command);
      initialTransactions += 1;
      return new Promise((resolve, reject) => {
        pending.push(async () => { try { resolve(await send(command)); } catch (error) { reject(error instanceof Error ? error : new Error("transaction failed")); } });
        if (pending.length === 2) both();
      });
    };
    const outcomesPromise = Promise.all(calls.map((event) => h.invoke({ ...event, createdBy: event.personId })));
    await ready;
    const commits = reverse ? pending.toReversed() : pending;
    for (const commit of commits) {
      await commit();
      const owners = h.db.find((row) => row.entityType === "COMPANY_MEMBERSHIP" && row.role === "owner" && row.revokedAt === undefined);
      expect(owners.length).toBeGreaterThanOrEqual(1);
    }
    const answers = await outcomesPromise;
    expect(answers.filter((answer) => answer.ok)).toHaveLength(expectedSuccesses);
    if (expectedSuccesses === 1) expect(answers.filter((answer) => !answer.ok)).toEqual([lastOwner]);
    expect(h.db.find((row) => row.entityType === "COMPANY_MEMBERSHIP" && row.role === "owner" && row.revokedAt === undefined)).toHaveLength(1);
    expect(h.db.refusals).toEqual([]);
  }
});

it.each([false, true])("sequential demote/revoke cannot remove the final owner (reverse=%s)", async (reverse) => {
  const h = world(); h.seed(); h.seed(q);
  const calls = reverse ? [revoke(q), roleSet()] : [roleSet(), revoke(q)];
  expect(await h.invoke({ ...calls[0], createdBy: calls[0]!.personId })).toEqual({ ok: true });
  expect(await h.invoke({ ...calls[1], createdBy: calls[1]!.personId })).toEqual(lastOwner);
});

it("a stale mirror is never owner authority", async () => {
  const h = world(); h.seed(); h.seed(q);
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
    const h = world(); h.seed(p, "owner", A, kind === "company-member-restore" ? { revokedAt: at } : {}); h.seed(q); h.seed(actor, "owner");
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
  const h = world();
  for (let i = 0; i < 150; i++) h.seed(i.toString(16).padStart(64, "0"), "member");
  h.seed(p); h.seed(q);
  expect(await h.invoke({ ...roleSet(), createdBy: p })).toEqual({ ok: true });
  expect(await h.invoke({ ...revoke(q), createdBy: q })).toEqual(lastOwner);
});

it.each([p, q])("self-actor and owner-witness overlap commit without duplicate transaction actions: %s", async (createdBy) => {
  const h = world(); h.seed(); h.seed(q);
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

const onlyOwner = { ok: false, error: "unavailable", message: "only an owner can change or remove an owner" };
it.each([roleSet(), revoke(), roleSet(p, "admin")])("FIX-2 admin cannot change or remove an owner: %s", async (event) => {
  const h = world(); h.seed(); h.seed(q); h.seed(actor, "admin");
  const before = [...h.db.items.values()];
  expect(await h.invoke({ ...event, createdBy: actor })).toEqual(onlyOwner);
  expect([...h.db.items.values()]).toEqual(before); expect(h.logs).toEqual([]);
});
it.each(["admin", "owner"] as const)("DEC 254zzz73: a live owner demotes and removes a current %s with no step-up", async (role) => {
  for (const event of [roleSet(), revoke()]) {
    const h = world(); h.seed(p, role); h.seed(actor, "owner");
    expect(await h.invoke({ ...event, createdBy: actor })).toEqual({ ok: true });
    expect(h.db.find((row) => row.entityType === "COMPANY_LOG")).toEqual([expect.objectContaining({ event: event.kind, personId: p, createdBy: actor, fromRole: role })]);
    assertMirror(h, p);
  }
});
it.each(["member", "admin", "owner"] as const)("DEC 254zzz73: without a step-up the role rule still holds: a plain member cannot change or remove a %s", async (role) => {
  for (const event of [roleSet(p, role === "member" ? "admin" : "member"), revoke()]) {
    const h = world(); h.seed(p, role); h.seed(q); h.seed(actor, "member");
    const before = [...h.db.items.values()];
    expect((await h.invoke({ ...event, createdBy: actor })).ok).toBe(false);
    expect([...h.db.items.values()]).toEqual(before); expect(h.logs).toEqual([]);
  }
});
it.each(["admin", "owner"] as const)("DEC 254zzz73: without a step-up the company rule still holds: an %s of another company changes nothing here", async (role) => {
  for (const event of [roleSet(p, "admin"), revoke()]) {
    const h = world(); h.seed(p, "member"); h.seed(actor, role, B);
    const before = [...h.db.items.values()];
    expect(await h.invoke({ ...event, createdBy: actor })).toEqual(unavailable);
    expect([...h.db.items.values()]).toEqual(before); expect(h.logs).toEqual([]);
  }
});
it.each([actor, q, p])("FIX-2 concurrent owner actor demotion fails atomically: %s", async (createdBy) => {
  for (const event of [roleSet(), revoke()]) {
    const h = world(); h.seed(); h.seed(q); h.seed(actor);
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

it.each(["admin", "owner"])("FIX-2 a member promoted to %s meanwhile cannot be removed on the stale snapshot", async (role) => {
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
it.each([roleSet(), roleSet(p, "admin"), revoke()])("FIX-3 operator overrides an owner and audits it: %s", async (event) => {
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
it.each([null, "", "operator", 0, false])("FIX-3 only omitted createdBy selects operator authority: %s", async (createdBy) => {
  for (const event of [roleSet(), revoke()]) {
    const h = world(); h.seed(); h.seed(q);
    const before = [...h.db.items.values()];
    expect(await h.invoke({ ...event, createdBy })).toEqual({ ok: false, error: "invalid_request" });
    expect([...h.db.items.values()]).toEqual(before); expect(h.logs).toEqual([]);
  }
});


it.each(["member", "admin"] as const)("FIX-4 admin cannot promote %s to owner", async (role) => {
  const h = world(); h.seed(p, role); h.seed(actor, "admin");
  const before = [...h.db.items.values()];
  expect(await h.invoke({ ...roleSet(p, "owner"), createdBy: actor })).toEqual(onlyOwner);
  expect([...h.db.items.values()]).toEqual(before); expect(h.logs).toEqual([]);
});
it.each(["member", "admin"] as const)("FIX-4 live owner promotes %s and keeps person attribution", async (role) => {
  const h = world(); h.seed(p, role); h.seed(actor, "owner");
  expect(await h.invoke({ ...roleSet(p, "owner"), createdBy: actor })).toEqual({ ok: true });
  expect(await h.store.membership(p)).toMatchObject({ role: "owner", updatedBy: actor });
  assertMirror(h, p);
  expect(h.db.find((row) => row.entityType === "COMPANY_LOG")).toEqual([expect.objectContaining({
    event: "company-member-role-set", companyId: A, personId: p, fromRole: role, toRole: "owner", createdBy: actor,
  })]);
  expect(h.db.find((row) => row.entityType === "COMPANY_LOG")[0]).not.toHaveProperty("ownerOverride");
  expect(h.db.refusals).toEqual([]);
});
it.each(["member", "admin"] as const)("FIX-4 operator promotes %s without step-up and audits owner override", async (role) => {
  const h = world(); h.seed(p, role);
  expect(await h.invoke(roleSet(p, "owner"))).toEqual({ ok: true });
  expect(await h.store.membership(p)).toMatchObject({ role: "owner", updatedBy: "operator" });
  assertMirror(h, p);
  expect(h.db.find((row) => row.entityType === "COMPANY_LOG")).toEqual([expect.objectContaining({
    event: "company-member-role-set", companyId: A, personId: p, fromRole: role, toRole: "owner", createdBy: "operator", ownerOverride: true,
  })]);
  expect(h.db.refusals).toEqual([]);
});
it.each(["demoted", "revoked", "foreign"])("FIX-4 promotion fails atomically when owner actor becomes %s before commit", async (damage) => {
  const h = world(); h.seed(p, "member"); h.seed(actor, "owner");
  const target = h.db.get(membershipKey(p).pk, "COMPANY");
  const mirror = h.db.get(mirrorKey(A, p).pk, mirrorKey(A, p).sk);
  const send = h.db.send;
  h.db.send = async (command) => {
    if (command.constructor.name === "TransactWriteCommand") h.seed(actor, damage === "demoted" ? "admin" : "owner", damage === "foreign" ? B : A, damage === "revoked" ? { revokedAt: at } : {});
    return send(command);
  };
  expect(await h.invoke({ ...roleSet(p, "owner"), createdBy: actor })).toEqual(unavailable);
  expect(h.db.get(membershipKey(p).pk, "COMPANY")).toEqual(target);
  expect(h.db.get(mirrorKey(A, p).pk, mirrorKey(A, p).sk)).toEqual(mirror);
  expect(h.db.find((row) => row.entityType === "COMPANY_LOG")).toEqual([]);
  expect(h.logs).toEqual([]); expect(h.db.refusals).toEqual([]);
});
