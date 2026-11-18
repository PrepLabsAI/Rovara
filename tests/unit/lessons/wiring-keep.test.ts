// L4-LP12b (3): the answer to the weekly list's "Keep it?" card. A person who decides lessons renews a lesson a question stands on; nobody else can, nothing else changes, and the answer is audited before the write.
import { describe, expect, it } from "vitest";
import { keepByPerson } from "../../../packages/broker/src/lessons/keep.js";
import type { ApproveDeps } from "../../../packages/broker/src/lessons/approve.js";
import type { AccessCheckPort } from "../../../packages/broker/src/lessons/access-port.js";
import { evidencePk } from "../../../packages/broker/src/lessons/evidence.js";
import { Audit, KEY, WS, allSharedTasks, allowAllAccess, directory, lessonRecord, settings } from "./lesson-helpers.js";
import { A, DAY, world } from "./phase12-helpers.js";

const ID = "les_quiet001";

async function quiet(over: { lesson?: Parameters<typeof lessonRecord>[0]; asked?: boolean | "renewals-only" | "garbage"; access?: AccessCheckPort; dir?: ReturnType<typeof directory>; audit?: Audit | { emit: () => Promise<void> } } = {}) {
  const w = await world();
  const lesson = lessonRecord({ id: ID, scope: { repos: ["api"] }, expiresAt: w.clock.now() + DAY, counters: { loaded: 4, helpful: 1, harmful: 0, citationStale: 0 }, ...over.lesson });
  await w.add(lesson);
  const askedAt = w.clock.now() - 5 * DAY;
  if (over.asked === "garbage") await w.documents.put({ item: { pk: evidencePk(A, KEY.project), sk: `F#${ID}`, entityType: "LESSON_FADE", lessonId: ID, renewals: "many", at: 1 } });
  else if (over.asked !== false) await w.evidence.writeFade(KEY, ID, over.asked === "renewals-only" ? { renewals: 1 } : { renewals: 1, askedAt }, w.clock.now());
  const audit = over.audit ?? new Audit();
  const deps: ApproveDeps & { evidence: typeof w.evidence } = { access: over.access ?? allowAllAccess, store: w.store, directory: over.dir ?? directory(), settings: settings(), audit, now: w.clock.now, evidence: w.evidence };
  return { w, deps, audit, lesson, keep: (actorId = "ann", lessonId = ID, workspaceId = WS) => keepByPerson(deps, { workspaceId, project: KEY.project, lessonId, actorId }) };
}

describe("a person who decides answers Keep", () => {
  it("renews the lesson for a whole window, starts its fade state again and records who kept it, before the write; nothing else of the lesson changes (golden)", async () => {
    const k = await quiet();
    const before = (await k.w.store.get(KEY, ID))!;
    expect(await k.keep()).toEqual({ ok: true });
    const after = (await k.w.store.get(KEY, ID))!;
    expect(after.expiresAt).toBe(k.w.clock.now() + 90 * DAY);
    expect(after.lastValidatedAt).toBe(k.w.clock.now());
    expect({ ...after, expiresAt: 0, lastValidatedAt: 0, version: 0, updatedAt: 0 }).toEqual({ ...before, expiresAt: 0, lastValidatedAt: 0, version: 0, updatedAt: 0 });
    expect(await k.w.evidence.readFade(KEY, ID)).toMatchObject({ renewals: 0 });
    expect((await k.w.evidence.readFade(KEY, ID) as { askedAt?: number }).askedAt).toBeUndefined();
    const events = (k.audit as Audit).events.filter((event) => event.action === "lesson.kept");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ workspaceId: WS, project: KEY.project, lessonId: ID, actor: "ann", facts: {} });
  });

  it("the answer is used up: the question is gone, so a second press changes nothing and is not an error that loses anything", async () => {
    const k = await quiet();
    expect(await k.keep()).toEqual({ ok: true });
    const once = (await k.w.store.get(KEY, ID))!.expiresAt;
    k.w.clock.advance(DAY);
    expect(await k.keep("bob")).toEqual({ ok: false, code: "not_pending" });
    expect((await k.w.store.get(KEY, ID))!.expiresAt).toBe(once);
    expect((k.audit as Audit).events.filter((event) => event.action === "lesson.kept")).toHaveLength(1);
  });

  it("someone who does not decide lessons cannot keep one, and nothing is recorded or changed (mutant: no eligibility check keeps it)", async () => {
    const k = await quiet();
    const before = (await k.w.store.get(KEY, ID))!;
    expect(await k.keep("mallory")).toEqual({ ok: false, code: "not_eligible" });
    expect(await k.w.store.get(KEY, ID)).toEqual(before);
    expect(await k.w.evidence.readFade(KEY, ID)).toMatchObject({ renewals: 1, askedAt: expect.any(Number) as number });
    expect((k.audit as Audit).events).toEqual([]);
  });

  it("who decides is read now: an eligibility that cannot be read in full refuses (fail closed)", async () => {
    const k = await quiet({ dir: directory({ complete: false }) });
    expect(await k.keep()).toEqual({ ok: false, code: "eligibility_unavailable" });
    expect((await k.w.store.get(KEY, ID))!.expiresAt).toBe(k.w.clock.now() + DAY);
  });

  it("only while a question stands: a lesson nobody was asked about, or one whose state only counts renewals, is not renewed by this (mutant: keeping any active lesson)", async () => {
    for (const asked of [false, "renewals-only"] as const) {
      const k = await quiet({ asked });
      expect(await k.keep(), String(asked)).toEqual({ ok: false, code: "not_pending" });
      expect((await k.w.store.get(KEY, ID))!.expiresAt, String(asked)).toBe(k.w.clock.now() + DAY);
      expect((k.audit as Audit).events, String(asked)).toEqual([]);
    }
  });

  it("a fade state that cannot be read is not 'no question': nothing is changed", async () => {
    const k = await quiet({ asked: "garbage" });
    expect(await k.keep()).toEqual({ ok: false, code: "eligibility_unavailable" });
    expect((await k.w.store.get(KEY, ID))!.expiresAt).toBe(k.w.clock.now() + DAY);
  });

  it("only an active lesson: a retired, expired or missing one is not renewed", async () => {
    for (const status of ["retired", "expired", "pending", "rejected"] as const) {
      const k = await quiet({ lesson: { status } });
      expect(await k.keep(), status).toEqual({ ok: false, code: "not_pending" });
    }
    const k = await quiet();
    expect(await k.keep("ann", "les_missing01")).toEqual({ ok: false, code: "not_found" });
  });

  it("a lesson the person may not read cannot be decided: refused, nothing changed", async () => {
    const restricted = { ...lessonRecord().provenance, audience: { kind: "restricted" as const, acl: { source: "slack" as const, scope: "slack:T/C", principals: ["U1"], capturedAt: "x", liveCheck: "none" as const } } };
    const k = await quiet({ lesson: { provenance: restricted }, access: { mayRead: async (_org, _viewer, places) => places.map(() => false), taskVisibility: allSharedTasks } });
    expect(await k.keep()).toEqual({ ok: false, code: "not_permitted" });
    expect((await k.w.store.get(KEY, ID))!.expiresAt).toBe(k.w.clock.now() + DAY);
    expect((k.audit as Audit).events).toEqual([]);
  });

  it("no record, no change: a ledger that cannot be written leaves the lesson and its question exactly as they were", async () => {
    const k = await quiet({ audit: { emit: async () => { throw new Error("ledger down"); } } });
    expect(await k.keep()).toEqual({ ok: false, code: "audit_unavailable" });
    expect((await k.w.store.get(KEY, ID))!.expiresAt).toBe(k.w.clock.now() + DAY);
    expect(await k.w.evidence.readFade(KEY, ID)).toMatchObject({ renewals: 1, askedAt: expect.any(Number) as number });
  });

  it("a reset of the question that could not be written is reported, not called kept", async () => {
    const k = await quiet();
    const failing = { ...k.deps, evidence: { readFade: (key: typeof KEY, id: string) => k.w.evidence.readFade(key, id), writeFade: async () => false } };
    expect(await keepByPerson(failing, { workspaceId: WS, project: KEY.project, lessonId: ID, actorId: "ann" })).toEqual({ ok: false, code: "conflict" });
    expect(await k.w.evidence.readFade(KEY, ID)).toMatchObject({ askedAt: expect.any(Number) as number });
  });

  it("uses the project's own fade setting for the window", async () => {
    const k = await quiet();
    const deps = { ...k.deps, settings: settings({ expiryDays: 30 }) };
    expect(await keepByPerson(deps, { workspaceId: WS, project: KEY.project, lessonId: ID, actorId: "ann" })).toEqual({ ok: true });
    expect((await k.w.store.get(KEY, ID))!.expiresAt).toBe(k.w.clock.now() + 30 * DAY);
  });

  it("two companies: a question and a lesson of company A cannot be answered through company B's keys", async () => {
    const k = await quiet();
    // The same lesson id asked about under another company's workspace id finds nothing there and changes nothing of A's.
    expect(await k.keep("ann", ID, "org_bbbbbbbbbbbbbbbbbbbb")).toMatchObject({ ok: false });
    expect((await k.w.store.get(KEY, ID))!.expiresAt).toBe(k.w.clock.now() + DAY);
    expect(await k.w.evidence.readFade(KEY, ID)).toMatchObject({ renewals: 1, askedAt: expect.any(Number) as number });
  });
});
