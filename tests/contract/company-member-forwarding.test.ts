import { expect, it, vi } from "vitest";
import { companyMemberActionsThroughLambda, companyMembersThroughLambda } from "../../packages/broker/src/aws/company-member-forwarding.js";
import { CompanySignInStore } from "../../packages/broker/src/developer/company-membership.js";
import { companyOperator } from "../../packages/broker/src/developer/company-operator.js";
import { membershipKey } from "../../packages/broker/src/aws/company-check.js";
import { CompanyMember } from "../../packages/broker/src/developer/company-member-contract.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const A = `org_${"a".repeat(20)}`, B = `org_${"b".repeat(20)}`;
const actor = "1".repeat(64), target = "2".repeat(64), at = "2026-11-15T00:00:00.000Z";
const caller = { developerId: actor, sessionId: "authenticated-session", amr: "oidc" as const, name: "Admin" };
function world() {
  const db = new FakeDynamoDb(); const forwarded: Record<string, unknown>[] = [];
  const seed = (personId: string, role: string, companyId = A, extra = {}) => db.set({ ...membershipKey(personId), entityType: "COMPANY_MEMBERSHIP", personId, role, companyId, joinedAt: at, ...extra });
  seed(actor, "admin"); seed(target, "member");
  const store = new CompanySignInStore({ documentClient: db, tableName: "signin", now: () => Date.parse(at) });
  const forward = companyMembersThroughLambda({ documentClient: db, tableName: "signin", invoke: async (payload) => {
    const event = JSON.parse(Buffer.from(payload).toString()) as Record<string, unknown>; forwarded.push(event);
    return { Payload: Buffer.from(JSON.stringify(await companyOperator({ store, now: () => Date.parse(at), log: () => {} }, event))) };
  } });
  return { db, forward, forwarded, seed };
}
const request = { kind: "company-member-role-set", companyId: A, personId: target, role: "member" };
it.each([ { createdBy: target }])("forged/extra claim or nonwhitelisted kind never invokes: %s", async (damage) => {
  const h = world(); expect((await h.forward(caller, { ...request, ...damage })).ok).toBe(false); expect(h.forwarded).toEqual([]);
});
it.each([ "oversized", "malformed", "foreign-member"])("transport %s refuses without echoing causes or partial rows", async (mode) => {
  const h = world();
  if (mode === "read") h.db.injectFault({ command: "GetCommand", error: { name: "AccessDeniedException", message: "private-canary" } });
  const forward = companyMembersThroughLambda({ documentClient: h.db, tableName: "signin", invoke: async () => {
    if (mode === "invoke") throw new Error("private-canary");
    const payload = mode === "oversized" ? "x".repeat(1_100_001) : JSON.stringify(mode === "foreign-member" ? { ok: true, more: false, members: [{ entityType: "COMPANY_MEMBERSHIP", personId: target, companyId: B, role: "member", joinedAt: at }] } : { ok: false, error: "private-canary" });
    return { Payload: Buffer.from(payload) };
  } });
  expect(await forward(caller, { kind: "company-member-list", companyId: A })).toEqual({ ok: false, error: mode === "read" ? "not_found" : "unavailable" });
});


it.each([ "write-list"])("validates the complete Lambda response: %s", async (mode) => {
  const h = world();
  const forward = companyMembersThroughLambda({ documentClient: h.db, tableName: "signin", invoke: async () => {
    if (mode === "function-error") return { FunctionError: "private-canary", Payload: Buffer.from('{"ok":true}') };
    if (mode === "missing-payload") return {};
    const member = { entityType: "COMPANY_MEMBERSHIP", personId: target, companyId: A, role: "member", joinedAt: at };
    const reply = mode === "missing-list" ? { ok: true } : { ok: true, members: mode === "too-many-members" ? [member, member] : [], more: mode === "foreign-cursor", ...(mode === "foreign-cursor" ? { cursor: Buffer.from(JSON.stringify({ v: 1, companyId: B, personId: actor })).toString("base64url") } : {}) };
    return { Payload: Buffer.from(mode === "json" ? "private-canary" : JSON.stringify(reply)) };
  } });
  expect(await forward(caller, mode === "write-list" ? request : { kind: "company-member-list", companyId: A, limit: 1 })).toEqual({ ok: false, error: "unavailable" });
});


it("Lane W selects actions without constructing a member kind outside the helper", async () => {
  const h = world(); const sent: unknown[] = [];
  const actions = companyMemberActionsThroughLambda({ documentClient: h.db, tableName: "signin", invoke: async (payload) => {
    const event = JSON.parse(Buffer.from(payload).toString()) as { kind: string }; sent.push(event);
    return { Payload: Buffer.from(JSON.stringify(event.kind === "company-member-list" ? { ok: true, members: [], more: false } : { ok: true })) };
  } });
  expect(await actions.list(caller, { companyId: A, limit: 1 })).toEqual({ ok: true, members: [], more: false });
  expect(await actions.revoke(caller, { companyId: A, personId: target })).toEqual({ ok: true });
  expect(await actions.setRole(caller, { companyId: A, personId: target, role: "member" })).toEqual({ ok: true });
  expect(sent).toEqual([{ kind: "company-member-list", companyId: A, limit: 1 }, { kind: "company-member-revoke", companyId: A, personId: target, createdBy: actor }, { ...request, createdBy: actor }]);
  for (const action of [actions.list, actions.revoke, actions.setRole]) {
    expect(await action(caller, { ...request })).toEqual({ ok: false, error: "invalid_request" });
    expect(await action(caller, null)).toEqual({ ok: false, error: "invalid_request" });
  }
  expect(sent).toHaveLength(3);
});

it.each(["private-canary"])("FIX-2 malformed request cursor is invalid_request: %s", async (cursor) => {
  const h = world();
  expect(await h.forward(caller, { kind: "company-member-list", companyId: A, cursor })).toEqual({ ok: false, error: "invalid_request" });
  expect(h.forwarded).toEqual([]);
});

// Fault-inject a lost actor between the live-row validation and payload construction.
// The helper must refuse the resulting actorless write before calling the Lambda.
it.each([request])("FIX-3 refuses a forwarded write missing createdBy before invoke: %s", async (event) => {
  const h = world();
  let reads = 0;
  const parsed = { entityType: "COMPANY_MEMBERSHIP" as const, companyId: A, role: "admin" as const, joinedAt: at,
    get personId(): string { return ++reads === 1 ? actor : undefined as unknown as string; },
  };
  const fault = vi.spyOn(CompanyMember, "parse").mockReturnValue(parsed);
  try {
    expect(await h.forward(caller, event)).toEqual({ ok: false, error: "unavailable" });
    expect(h.forwarded).toEqual([]);
    expect(h.db.commandNames()).not.toContain("TransactWriteCommand");
  } finally { fault.mockRestore(); }
});
