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
it.each(["admin", "owner"])("only a live %s forwards the three strict member kinds with membership-derived authority", async (role) => {
  const h = world(); h.seed(actor, role);
  expect(await h.forward(caller, request)).toEqual({ ok: true });
  expect(await h.forward(caller, { kind: "company-member-list", companyId: A, limit: 1 })).toEqual({ ok: true, members: [], more: false });
  expect(await h.forward(caller, { kind: "company-member-revoke", companyId: A, personId: target })).toEqual({ ok: true });
  expect(h.forwarded).toEqual([{ ...request, createdBy: actor }, { kind: "company-member-list", companyId: A, limit: 1 }, { kind: "company-member-revoke", companyId: A, personId: target, createdBy: actor }]);
  expect(h.db.refusals).toEqual([]);
});
it.each([{ companyId: B }, { createdBy: target }, { actorRole: "owner" }, { orgId: B }, { kind: "company-member-restore" }, { kind: "company-create" }, { role: "private-canary" }])("forged/extra claim or nonwhitelisted kind never invokes: %s", async (damage) => {
  const h = world(); expect((await h.forward(caller, { ...request, ...damage })).ok).toBe(false); expect(h.forwarded).toEqual([]);
});
it.each(["member", "revoked", "missing", "foreign", "malformed", "slack-unlinked"])("refuses non-authoritative caller %s with fixed words", async (mode) => {
  const h = world();
  if (mode === "missing" || mode === "slack-unlinked") h.db.delete(membershipKey(actor).pk, "COMPANY");
  else h.seed(actor, mode === "member" ? "member" : mode === "malformed" ? "private-canary" : "admin", mode === "foreign" ? B : A, mode === "revoked" ? { revokedAt: at } : {});
  expect(await h.forward(mode === "slack-unlinked" ? { ...caller, developerId: "slack:U123", amr: "slack" } : caller, request)).toEqual({ ok: false, error: "not_found" });
  expect(h.forwarded).toEqual([]);
});
it("preserves step-up fixed response and rechecks actor when Lambda runs after broker authentication", async () => {
  const h = world();
  expect(await h.forward(caller, { ...request, role: "owner" })).toEqual({ ok: false, error: "unavailable", message: "only an owner can change or remove an owner" });
  h.seed(actor, "owner");
  expect(await h.forward(caller, { ...request, role: "owner" })).toEqual({ ok: false, error: "step_up_required", message: "this role change needs a fresh sign-in check; sign in again and retry" });
  const send = h.db.send; let reads = 0;
  h.db.send = async (command) => {
    const result = await send(command);
    if (command.constructor.name === "GetCommand" && ++reads === 1) h.seed(actor, "member");
    return result;
  };
  expect(await h.forward(caller, { kind: "company-member-revoke", companyId: A, personId: target })).toEqual({ ok: false, error: "unavailable" });
});
it.each(["read", "invoke", "oversized", "malformed", "foreign-member"])("transport %s refuses without echoing causes or partial rows", async (mode) => {
  const h = world();
  if (mode === "read") h.db.injectFault({ command: "GetCommand", error: { name: "AccessDeniedException", message: "private-canary" } });
  const forward = companyMembersThroughLambda({ documentClient: h.db, tableName: "signin", invoke: async () => {
    if (mode === "invoke") throw new Error("private-canary");
    const payload = mode === "oversized" ? "x".repeat(1_100_001) : JSON.stringify(mode === "foreign-member" ? { ok: true, more: false, members: [{ entityType: "COMPANY_MEMBERSHIP", personId: target, companyId: B, role: "member", joinedAt: at }] } : { ok: false, error: "private-canary" });
    return { Payload: Buffer.from(payload) };
  } });
  expect(await forward(caller, { kind: "company-member-list", companyId: A })).toEqual({ ok: false, error: mode === "read" ? "not_found" : "unavailable" });
});

it.each([{ companyId: A }, { role: "owner" }, { actorId: actor }, { token: { sub: actor } }])("rejects extra caller claims before reading or forwarding: %s", async (claim) => {
  const h = world();
  expect(await h.forward({ ...caller, ...claim }, request)).toEqual({ ok: false, error: "not_found" });
  expect(h.forwarded).toEqual([]); expect(h.db.commandNames()).toEqual([]);
});

it.each(["function-error", "missing-payload", "json", "missing-list", "write-list", "too-many-members", "foreign-cursor"])("validates the complete Lambda response: %s", async (mode) => {
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

it("FIX-2 accepts optional positive epoch-seconds authTime without forwarding it", async () => {
  const h = world(); const authenticated = { ...caller, authTime: 1_794_700_800 };
  expect(await h.forward(authenticated, request)).toEqual({ ok: true });
  expect(h.forwarded).toEqual([{ ...request, createdBy: actor }]);
});
it.each([0, -1, 1.5, "private-canary", null, Infinity, NaN])("FIX-2 refuses malformed authTime: %s", async (authTime) => {
  const h = world(); const authenticated = { ...caller, authTime };
  expect(await h.forward(authenticated, request)).toEqual({ ok: false, error: "not_found" });
  expect(h.forwarded).toEqual([]); expect(h.db.commandNames()).toEqual([]);
});
it.each(["private-canary", Buffer.from(JSON.stringify({ v: 1, companyId: B, personId: actor })).toString("base64url")])("FIX-2 malformed request cursor is invalid_request: %s", async (cursor) => {
  const h = world();
  expect(await h.forward(caller, { kind: "company-member-list", companyId: A, cursor })).toEqual({ ok: false, error: "invalid_request" });
  expect(h.forwarded).toEqual([]);
});
it.each(["company-member-role-set", "company-member-revoke"])("FIX-2 forwards the fixed owner refusal: %s", async (kind) => {
  const h = world(); h.seed(target, "owner");
  expect(await h.forward(caller, kind === "company-member-role-set" ? request : { kind, companyId: A, personId: target })).toEqual({ ok: false, error: "unavailable", message: "only an owner can change or remove an owner" });
});

// Fault-inject a lost actor between the live-row validation and payload construction.
// The helper must refuse the resulting actorless write before calling the Lambda.
it.each([request, { kind: "company-member-revoke", companyId: A, personId: target }])("FIX-3 refuses a forwarded write missing createdBy before invoke: %s", async (event) => {
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
