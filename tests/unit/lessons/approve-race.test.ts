// Two-person approval under races. An approval is given for one version of one text; no single person can complete a two-person approval by sending requests at the same
// time, and a go-live is a conditional write that requires the stored version to be the version the approvals were given for. Every ordering below ends with the same promise:
// nothing is live unless two different people approved THAT text.
import { describe, expect, it } from "vitest";
import { activateLesson, approveLesson, rollbackLessonSet, type ApproveDeps } from "../../../packages/core/src/lessons/approve.js";
import { InMemoryLessonStore } from "../../../packages/core/src/lessons/store.js";
import type { LessonAuditEvent } from "../../../packages/core/src/lessons/ports.js";
import { Audit, Clock, KEY, directory, lessonRecord, seed, settings, allowAllAccess } from "./lesson-helpers.js";

const ID = "les_pend0001";
const base = (over: Parameters<typeof lessonRecord>[0] = {}) => lessonRecord({ id: ID, status: "pending", tier: 2, tierReasons: ["reviewer_stage"], type: "review_check", stages: ["REVIEW"], approvals: [], pendingExpiresAt: 9e15, provenance: { ...lessonRecord().provenance, authors: ["carl"] }, ...over });
const input = (approverId: string, extra: Record<string, unknown> = {}) => ({ ...KEY, lessonId: ID, approverId, ...extra });
const edit = (who: string) => ({ title: `${who}'s new rule`, description: "d", body: `Always do what ${who} wrote here.` });

function setup() {
  const store = new InMemoryLessonStore();
  const audit = new Audit();
  const clock = new Clock();
  let n = 0;
  const deps: ApproveDeps = { access: allowAllAccess, store, directory: directory(), settings: settings(), audit, now: clock.now, newId: () => `ap-${++n}` };
  /** Runs `during` once, at the first audit event the predicate accepts: i.e. while that request is between its read and its write. */
  const interleave = (when: (e: LessonAuditEvent) => boolean, during: () => Promise<unknown>): { ran: () => boolean } => {
    let fired = false;
    const real = audit.emit.bind(audit);
    audit.emit = async (e) => { await real(e); if (!fired && when(e)) { fired = true; await during(); } };
    return { ran: () => fired };
  };
  return { deps, store, audit, interleave };
}
const live = async (store: InMemoryLessonStore) => (await store.get(KEY, ID))!;
const whoApproved = (l: { approvals: Array<{ by: string }> }) => l.approvals.map((a) => a.by);

describe("approval is tied to the exact version and text it was given for", () => {
  it("one person cannot put their own text live by sending an approval and an edit-and-approve at the same time", async () => {
    const { deps, store, interleave } = setup();
    await seed(store, base());
    expect(await approveLesson(deps, input("ann"))).toMatchObject({ ok: true, status: "pending" });
    const v = (await live(store)).version;
    let second: unknown;
    // Bob's plain approval of the text Ann saw; while its audit is written, Bob's edit-and-approve runs to the end.
    const hook = interleave((e) => e.action === "lesson.approved" && e.actor === "bob", async () => { second = await approveLesson(deps, input("bob", { expectedVersion: v, edit: edit("Bob") })); });
    const first = await approveLesson(deps, input("bob", { expectedVersion: v }));
    expect(hook.ran()).toBe(true);
    const l = await live(store);
    expect(l.status).toBe("pending");
    expect(l.title).toBe("Bob's new rule");
    expect(whoApproved(l)).toEqual(["bob"]);
    expect(l.provenance.editors).toEqual(["bob"]);
    expect(first).toEqual({ ok: false, code: "conflict" });
    expect(second).toMatchObject({ ok: true, status: "pending" });
  });

  it("the same race without an expected version: the plain approval re-reads, sees Bob's text, and Bob's second approval is refused", async () => {
    const { deps, store, interleave } = setup();
    await seed(store, base());
    await approveLesson(deps, input("ann"));
    interleave((e) => e.action === "lesson.approved" && e.actor === "bob", async () => { await approveLesson(deps, input("bob", { edit: edit("Bob") })); });
    const first = await approveLesson(deps, input("bob"));
    const l = await live(store);
    expect(first).toEqual({ ok: false, code: "already_approved" });
    expect(l).toMatchObject({ status: "pending", title: "Bob's new rule" });
    expect(whoApproved(l)).toEqual(["bob"]);
  });

  it("edit then approve (in order): the edit clears Ann's approval, the editor cannot finish alone, and a different person completes the new text", async () => {
    const { deps, store } = setup();
    await seed(store, base());
    await approveLesson(deps, input("ann"));
    expect(await approveLesson(deps, input("bob", { edit: edit("Bob") }))).toMatchObject({ ok: true, status: "pending", needs: "second_person" });
    let l = await live(store);
    expect(whoApproved(l)).toEqual(["bob"]);
    expect(l.provenance.editors).toEqual(["bob"]);
    expect(await approveLesson(deps, input("bob"))).toEqual({ ok: false, code: "already_approved" });
    expect(await approveLesson(deps, input("ann"))).toMatchObject({ ok: true, status: "active" });
    l = await live(store);
    expect(l.title).toBe("Bob's new rule");
    expect(whoApproved(l).sort()).toEqual(["ann", "bob"]);
  });

  it("two edits at the same time: the later writer re-reads, and only that writer's own approval stands on its text", async () => {
    const { deps, store, interleave } = setup();
    await seed(store, base());
    await approveLesson(deps, input("ann"));
    let other: unknown;
    interleave((e) => e.action === "lesson.approved" && e.actor === "bob", async () => { other = await approveLesson(deps, input("owner", { edit: edit("Owner") })); });
    const mine = await approveLesson(deps, input("bob", { edit: edit("Bob") }));
    const l = await live(store);
    expect(other).toMatchObject({ ok: true, status: "pending" });
    expect(mine).toMatchObject({ ok: true, status: "pending" });
    expect(l.status).toBe("pending");
    expect(l.title).toBe("Bob's new rule");
    expect(whoApproved(l)).toEqual(["bob"]);
    expect(l.provenance.editors?.slice().sort()).toEqual(["bob", "owner"]);
  });

  it("an edit that completes (tier 1) is made live on its own version only: a competing go-live that lands between the two steps wins whole, and the first is refused", async () => {
    const { deps, store, interleave } = setup();
    await seed(store, base({ tier: 1, tierReasons: ["not_a_fact"], type: "convention", stages: ["IMPLEMENT"] }));
    let other: unknown;
    // While Bob's go-live is audited (after his edit was saved), Ann edits the text again and goes live.
    interleave((e) => e.action === "lesson.activated", async () => { other = await approveLesson(deps, input("ann", { edit: edit("Ann") })); });
    const mine = await approveLesson(deps, input("bob", { edit: edit("Bob") }));
    const l = await live(store);
    expect(other).toMatchObject({ ok: true, status: "active" });
    expect(mine).toEqual({ ok: false, code: "not_pending" });
    // What is live is Ann's text under Ann's approval alone, not Bob's approval laid over it.
    expect(l).toMatchObject({ status: "active", title: "Ann's new rule" });
    expect(whoApproved(l)).toEqual(["ann"]);
  });

  it("approve during a rollback: the approval is not written over the restored text; it is decided again on what the rollback brought back", async () => {
    const { deps, store, interleave } = setup();
    // Set 1: the lesson as first proposed, Ann has approved it. Set 2: it was edited (approvals cleared).
    await seed(store, base({ approvals: [{ approvalId: "a1", by: "ann", at: 1, mode: "one" }], title: "Original rule", body: "Always do the original thing." }));
    const v1 = (await live(store));
    await store.commit(KEY, await store.setVersion(KEY), [{ ...v1, version: 2, title: "Edited rule", body: "Always do the edited thing.", approvals: [] }], 2);
    let rolled: unknown;
    interleave((e) => e.action === "lesson.approved" && e.actor === "bob", async () => { rolled = await rollbackLessonSet(deps, { ...KEY, targetSetVersion: 1, expectedSetVersion: 2, actorId: "owner" }); });
    const result = await approveLesson(deps, input("bob"));
    expect(rolled).toMatchObject({ ok: true });
    const l = await live(store);
    // Bob's first decision was made on the edited text and is dropped; his retry reads the restored text, where Ann's approval stands.
    expect(l.body).toBe("Always do the original thing.");
    expect(result).toMatchObject({ ok: true, status: "active" });
    expect(whoApproved(l).sort()).toEqual(["ann", "bob"]);
  });

  it("approve during a rollback's own go-live: a person's edit that lands first is not made live under the restored approvals", async () => {
    const { deps, store, interleave } = setup();
    await seed(store, base({ status: "active", approvals: [{ approvalId: "a1", by: "ann", at: 1, mode: "one" }, { approvalId: "a2", by: "owner", at: 1, mode: "second_person" }], expiresAt: 9e15, pendingExpiresAt: undefined }));
    const v1 = await live(store);
    await store.commit(KEY, await store.setVersion(KEY), [{ ...v1, version: 2, status: "stale" }], 2);
    let during: unknown;
    interleave((e) => e.action === "lesson.activated", async () => { during = await approveLesson(deps, input("bob", { edit: edit("Bob") })); });
    const rolled = await rollbackLessonSet(deps, { ...KEY, targetSetVersion: 1, expectedSetVersion: 2, actorId: "owner" });
    const l = await live(store);
    expect(rolled).toMatchObject({ ok: true });
    expect(during).toMatchObject({ ok: true, status: "pending" });
    expect(l.status).toBe("pending");
    expect(l.title).toBe("Bob's new rule");
    expect(whoApproved(l)).toEqual(["bob"]);
  });
});

describe("activateLesson is a conditional write on the approved version", () => {
  it("refuses when the stored version is not the pinned one, and when the set has moved", async () => {
    const { deps, store } = setup();
    await seed(store, base());
    const l = await live(store);
    const approvals = [{ approvalId: "x", by: "ann", at: 1, mode: "one" as const }, { approvalId: "y", by: "bob", at: 1, mode: "second_person" as const }];
    const sv = await store.setVersion(KEY);
    // The set moved since the decision was made.
    await store.commit(KEY, sv, [{ ...l, version: 2, title: "Someone else's text" }], 2);
    expect(await activateLesson(deps, KEY, l, approvals, undefined, "lesson.activated", { version: 1, setVersion: sv })).toBeUndefined();
    // The version differs even when the set version is current.
    const sv2 = await store.setVersion(KEY);
    expect(await activateLesson(deps, KEY, l, approvals, undefined, "lesson.activated", { version: 1, setVersion: sv2 })).toBeUndefined();
    expect((await live(store))).toMatchObject({ status: "pending", title: "Someone else's text" });
    // Pinned to what is stored: it goes live.
    const now = await live(store);
    expect(await activateLesson(deps, KEY, now, approvals, undefined, "lesson.activated", { version: now.version, setVersion: sv2 })).toMatchObject({ status: "active", title: "Someone else's text" });
  });
});
