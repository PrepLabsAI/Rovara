// The company switch for the sole-owner exception on loosening: OFF applies at once, ON is a proposal a DIFFERENT eligible admin approves, every write is conditional and fenced, a fenced refusal is
// retryable, and nothing loosens without a ledger line. (The tier-0 approval setting's own change flow, which this file used to test beside it, was deleted in lessons connect fix 1: the preset replaced it.)
import { describe, expect, it } from "vitest";
import {
  approveSoleOwnerSwitch, setSoleOwnerSwitch, type SoleOwnerSwitchChange, type SoleOwnerSwitchDeps, type SoleOwnerSwitchStore, type Tier0Fence,
} from "../../../packages/lessons/src/sole-owner-switch.js";
import { lessonAuditSink } from "../../../packages/lessons/src/audit-sink.js";
import { Audit, Clock, WS } from "./lesson-helpers.js";

function world(over: { eligible?: string[]; owners?: string[]; complete?: boolean } = {}) {
  const audit = new Audit();
  const clock = new Clock();
  const group = { complete: over.complete ?? true, membershipVersion: 3, ownerIds: over.owners ?? ["owner"], eligibleIds: over.eligible ?? ["owner", "ann", "bob"], lastEligibleLossAtMs: null as number | null };
  const authority = { async eligibility() { return { ...group, fence: [{ pinned: group.membershipVersion }] }; } };
  return { audit, clock, group, authority };
}

class SwitchStore implements SoleOwnerSwitchStore {
  value = true; rows = new Map<string, SoleOwnerSwitchChange>(); writes: boolean[] = []; membershipNow = (): number => 3; beforeWrite: (() => void) | undefined; failRead = false;
  async read(): Promise<boolean> { if (this.failRead) throw new Error("bad"); return this.value; }
  async write(_ws: string, enabled: boolean, _meta: { by: string; at: number }, from: boolean, fence?: Tier0Fence): Promise<boolean> {
    this.beforeWrite?.();
    if (fence !== undefined && fence.membershipVersion !== this.membershipNow()) return false;
    if (this.value !== from) return false;
    this.value = enabled; this.writes.push(enabled); return true;
  }
  async create(change: SoleOwnerSwitchChange): Promise<boolean> { if (this.rows.has(change.id)) return false; this.rows.set(change.id, structuredClone(change)); return true; }
  async get(_ws: string, id: string): Promise<SoleOwnerSwitchChange | undefined> { const c = this.rows.get(id); return c === undefined ? undefined : structuredClone(c); }
  async open(_ws: string, now: number): Promise<SoleOwnerSwitchChange | undefined> { return [...this.rows.values()].find((c) => c.state === "pending" && c.expiresAt > now); }
  async transition(_ws: string, id: string, from: SoleOwnerSwitchChange["state"], to: SoleOwnerSwitchChange["state"]): Promise<boolean> { const c = this.rows.get(id); if (c === undefined || c.state !== from) return false; c.state = to; return true; }
}
function switchWorld(over: Parameters<typeof world>[0] = {}) {
  const w = world(over);
  const store = new SwitchStore();
  store.membershipNow = () => w.group.membershipVersion;
  const deps: SoleOwnerSwitchDeps = { store, audit: w.audit, authority: w.authority, now: w.clock.now, newId: (() => { let n = 0; return () => `sw-${++n}`; })() };
  return { ...w, store, sdeps: deps };
}

describe("the sole-owner switch setter (the only way routes change the switch)", () => {
  it("OFF applies at once by an eligible admin, audited; an audit outage does not block it; a stranger is refused", async () => {
    const w = switchWorld();
    expect(await setSoleOwnerSwitch(w.sdeps, { workspaceId: WS, enabled: false, requestedBy: "mallory" })).toEqual({ ok: false, code: "not_eligible" });
    expect(await setSoleOwnerSwitch(w.sdeps, { workspaceId: WS, enabled: false, requestedBy: "ann" })).toEqual({ ok: true, status: "applied", enabled: false });
    expect(w.store.value).toBe(false);
    expect(w.audit.events.at(-1)).toMatchObject({ action: "lesson.sole_owner_switch_changed", actor: "ann", facts: { from: true, to: false, mode: "direct", membershipVersion: 3 } });
    const down = switchWorld();
    down.audit.emit = async () => { throw new Error("audit down"); };
    expect(await setSoleOwnerSwitch(down.sdeps, { workspaceId: WS, enabled: false, requestedBy: "ann" })).toMatchObject({ ok: true, status: "applied" });
    expect(down.store.value).toBe(false);
  });
  it("ON is a loosening: a proposal; a DIFFERENT admin approves; the proposer cannot, in any spelling", async () => {
    const w = switchWorld();
    w.store.value = false;
    expect(await setSoleOwnerSwitch(w.sdeps, { workspaceId: WS, enabled: true, requestedBy: "ann" })).toEqual({ ok: true, status: "needs_approval", changeId: "sw-1" });
    expect(w.store.value).toBe(false);
    expect(await setSoleOwnerSwitch(w.sdeps, { workspaceId: WS, enabled: true, requestedBy: "bob" })).toEqual({ ok: false, code: "already_open" });
    expect(await approveSoleOwnerSwitch(w.sdeps, { workspaceId: WS, changeId: "sw-1", approverId: " ANN " })).toEqual({ ok: false, code: "second_person_required" });
    expect(await approveSoleOwnerSwitch(w.sdeps, { workspaceId: WS, changeId: "sw-1", approverId: "mallory" })).toEqual({ ok: false, code: "not_eligible" });
    expect(await approveSoleOwnerSwitch(w.sdeps, { workspaceId: WS, changeId: "sw-1", approverId: "bob" })).toEqual({ ok: true, enabled: true });
    expect(w.store.value).toBe(true);
    expect(w.audit.actions()).toEqual(["lesson.sole_owner_switch_proposed", "lesson.sole_owner_switch_changed"]);
    expect(w.audit.events.at(-1)).toMatchObject({ actor: "bob", facts: { mode: "second_person", proposedBy: "ann", from: false, to: true } });
  });
  it("the sole-owner exception does NOT apply to turning the switch back ON (one admin, no delay, cool-off over)", async () => {
    const w = switchWorld({ eligible: ["owner"], owners: ["owner"] });
    w.store.value = false;
    await setSoleOwnerSwitch(w.sdeps, { workspaceId: WS, enabled: true, requestedBy: "owner" });
    w.clock.advance(3 * 86_400_000);
    expect(await approveSoleOwnerSwitch(w.sdeps, { workspaceId: WS, changeId: "sw-1", approverId: "owner" })).toEqual({ ok: false, code: "second_person_required" });
    expect(w.store.value).toBe(false);
    // even if the switch for the exception were on
    expect(w.store.rows.get("sw-1")?.state).toBe("pending");
  });
  it("a no-op (already in that state) writes and proposes nothing", async () => {
    const w = switchWorld();
    expect(await setSoleOwnerSwitch(w.sdeps, { workspaceId: WS, enabled: true, requestedBy: "ann" })).toEqual({ ok: true, status: "applied", enabled: true });
    expect(w.store.writes).toEqual([]);
    expect(w.store.rows.size).toBe(0);
    expect(await setSoleOwnerSwitch(w.sdeps, { workspaceId: WS, enabled: "yes" as never, requestedBy: "ann" })).toEqual({ ok: false, code: "invalid_value" });
  });
  it("fails closed: unreadable eligibility or switch, proposal audit outage, expiry, stale, claimed twice, fence, and a taken-back change on audit outage", async () => {
    const a = switchWorld({ complete: false });
    expect(await setSoleOwnerSwitch(a.sdeps, { workspaceId: WS, enabled: false, requestedBy: "ann" })).toEqual({ ok: false, code: "eligibility_unavailable" });
    const b = switchWorld(); b.store.failRead = true;
    expect(await setSoleOwnerSwitch(b.sdeps, { workspaceId: WS, enabled: false, requestedBy: "ann" })).toEqual({ ok: false, code: "conflict" });
    const c = switchWorld(); c.store.value = false; c.audit.emit = async () => { throw new Error("audit down"); };
    expect(await setSoleOwnerSwitch(c.sdeps, { workspaceId: WS, enabled: true, requestedBy: "ann" })).toEqual({ ok: false, code: "audit_unavailable" });
    expect(c.store.rows.size).toBe(0);
    const d = switchWorld(); d.store.value = false; await setSoleOwnerSwitch(d.sdeps, { workspaceId: WS, enabled: true, requestedBy: "ann" });
    d.clock.advance(7 * 86_400_000 + 1);
    expect(await approveSoleOwnerSwitch(d.sdeps, { workspaceId: WS, changeId: "sw-1", approverId: "bob" })).toEqual({ ok: false, code: "expired" });
    const e = switchWorld(); e.store.value = false; await setSoleOwnerSwitch(e.sdeps, { workspaceId: WS, enabled: true, requestedBy: "ann" });
    e.store.value = true;
    expect(await approveSoleOwnerSwitch(e.sdeps, { workspaceId: WS, changeId: "sw-1", approverId: "bob" })).toEqual({ ok: false, code: "stale" });
    expect(await approveSoleOwnerSwitch(e.sdeps, { workspaceId: WS, changeId: "nope", approverId: "bob" })).toEqual({ ok: false, code: "not_found" });
    const f = switchWorld(); f.store.value = false; await setSoleOwnerSwitch(f.sdeps, { workspaceId: WS, enabled: true, requestedBy: "ann" });
    f.store.beforeWrite = () => { f.group.membershipVersion = 4; };
    expect(await approveSoleOwnerSwitch(f.sdeps, { workspaceId: WS, changeId: "sw-1", approverId: "bob" })).toEqual({ ok: false, code: "membership_changed_retry" });
    expect(f.store.value).toBe(false);
    expect(f.store.rows.get("sw-1")?.state).toBe("pending");
    const g = switchWorld(); g.store.value = false; await setSoleOwnerSwitch(g.sdeps, { workspaceId: WS, enabled: true, requestedBy: "ann" });
    g.audit.emit = async () => { throw new Error("audit down"); };
    expect(await approveSoleOwnerSwitch(g.sdeps, { workspaceId: WS, changeId: "sw-1", approverId: "bob" })).toEqual({ ok: false, code: "audit_unavailable" });
    expect(g.store.value).toBe(false);
    expect(g.store.writes).toEqual([true, false]);
    expect(g.store.rows.get("sw-1")?.state).toBe("cancelled");
  });
  it("a fenced refusal of the switch approval is retryable: pending again, audited; a retry re-checks eligibility, and a switch that moved cancels", async () => {
    const w = switchWorld(); w.store.value = false;
    await setSoleOwnerSwitch(w.sdeps, { workspaceId: WS, enabled: true, requestedBy: "ann" });
    const expiresAt = w.store.rows.get("sw-1")!.expiresAt;
    w.store.beforeWrite = () => { w.group.eligibleIds = ["owner", "ann"]; w.group.membershipVersion = 4; w.store.beforeWrite = undefined; };
    expect(await approveSoleOwnerSwitch(w.sdeps, { workspaceId: WS, changeId: "sw-1", approverId: "bob" })).toEqual({ ok: false, code: "membership_changed_retry" });
    expect(w.store.rows.get("sw-1")).toMatchObject({ state: "pending", expiresAt });
    expect(w.audit.events.at(-1)).toMatchObject({ action: "lesson.tier0_setting_refused_retryable", actor: "bob", facts: { scope: "company_switch", changeId: "sw-1" } });
    expect(await approveSoleOwnerSwitch(w.sdeps, { workspaceId: WS, changeId: "sw-1", approverId: "bob" })).toEqual({ ok: false, code: "not_eligible" });
    expect(w.store.writes).toEqual([]);
    expect(await approveSoleOwnerSwitch(w.sdeps, { workspaceId: WS, changeId: "sw-1", approverId: "owner" })).toEqual({ ok: true, enabled: true });
    const m = switchWorld(); m.store.value = false;
    await setSoleOwnerSwitch(m.sdeps, { workspaceId: WS, enabled: true, requestedBy: "ann" });
    m.store.beforeWrite = () => { m.store.value = true; m.group.membershipVersion = 4; };
    expect(await approveSoleOwnerSwitch(m.sdeps, { workspaceId: WS, changeId: "sw-1", approverId: "bob" })).toEqual({ ok: false, code: "stale" });
    expect(m.store.rows.get("sw-1")?.state).toBe("cancelled");
  });
  it("turning it OFF is fenced too: a membership change after the read stops it", async () => {
    const w = switchWorld();
    w.store.beforeWrite = () => { w.group.membershipVersion = 4; };
    expect(await setSoleOwnerSwitch(w.sdeps, { workspaceId: WS, enabled: false, requestedBy: "ann" })).toEqual({ ok: false, code: "stale" });
    expect(w.store.value).toBe(true);
  });
});

// The real audit sink over the ledger. Loosening used to pass `requireAudit` with no ledger entry because the action had no contract name.
describe("the sole-owner switch over the real audit sink", () => {
  it("the proposal and the change are recorded under contract names, with contract facts that the ledger schema accepts", async () => {
    const written: unknown[] = [];
    const w = switchWorld();
    w.store.value = false;
    const sink = lessonAuditSink({ stage: () => [], record: async (event) => { written.push(event); } }, w.clock.now, WS);
    const deps: SoleOwnerSwitchDeps = { ...w.sdeps, audit: sink };
    await setSoleOwnerSwitch(deps, { workspaceId: WS, enabled: true, requestedBy: "ann" });
    expect(await approveSoleOwnerSwitch(deps, { workspaceId: WS, changeId: "sw-1", approverId: "bob" })).toEqual({ ok: true, enabled: true });
    const events = written as Array<{ action: string; eventId: string; details: Record<string, unknown> }>;
    expect(events.map((e) => e.action)).toEqual(["lesson.sole_owner_switch_proposed", "lesson.sole_owner_switch_changed"]);
    expect(events[1]!.details).toMatchObject({ fromEnabled: false, toEnabled: true, mode: "second_person" });
    expect(new Set(events.map((event) => event.eventId)).size).toBe(2);
  });
  it("with the ledger down the loosening is refused (proposal) and taken back (approval): not applied with no record", async () => {
    const w = switchWorld();
    w.store.value = false;
    const down: SoleOwnerSwitchDeps = { ...w.sdeps, audit: lessonAuditSink({ stage: () => [], record: async () => { throw new Error("ledger down"); } }, w.clock.now, WS) };
    expect(await setSoleOwnerSwitch(down, { workspaceId: WS, enabled: true, requestedBy: "ann" })).toEqual({ ok: false, code: "audit_unavailable" });
    expect(w.store.rows.size).toBe(0);
  });
});
