// Lessons in the repo: lessons that went missing from `.rovara/lessons.md` in one change (more than max(3, 25%) of the known ones) are held a week, and then a PERSON is asked: the company owner or
// someone who can approve lessons confirms the retire, or keeps the lessons (they stay live and the next weekly pull request proposes their blocks back). A small number still retires at once. Nothing retires by itself after the week.
import { afterEach, describe, expect, it } from "vitest";
import { LessonsRepoFileBodySchema } from "@agentx/contracts";
import { setLearnedLessonsGate } from "../../../packages/broker/src/lessons/policy.js";
import { lessonsRepoFilePublishJob, type RepoFileRuntime } from "../../../packages/broker/src/lessons/repo-file-job.js";
import { rowOf } from "../../../packages/broker/src/lessons/repo-file-pr.js";
import { repoFileAction, repoFileStatus } from "../../../packages/broker/src/lessons/repo-file-routes.js";
import { parseLessonsFile } from "../../../packages/broker/src/lessons/repo-file-format.js";
import { DAY, FILE, WS, passSetup, repoLesson } from "./repo-file-helpers.js";

afterEach(() => { setLearnedLessonsGate(undefined); });
type W = ReturnType<typeof passSetup>;
const WHO = { developerId: "a".repeat(64) };
const runtimeOf = (w: W): RepoFileRuntime => ({ deps: w.deps, targets: async () => [w.target], newHolder: () => "job-1" });
const act = (w: W, action: "retire_confirm" | "retire_keep", held: string | undefined, decider: { developerId: string } | null = WHO) =>
  repoFileAction(runtimeOf(w), w.key, { action, repo: "api", ...(held === undefined ? {} : { held }) }, decider ?? undefined);
/** The nightly job as it runs: the erasure sweep first (not needed here), then the publish pass and the retire-only read-back for every switched-on repository. */
const night = (w: W) => lessonsRepoFilePublishJob(runtimeOf(w), WS, ["proj-1"], 60_000, 0);
const retired = async (w: W) => (await w.store.listAllHeads(w.key)).filter((l) => l.status === "retired");
const cutAfterFirst = (w: W): void => { const text = w.host.file("main", FILE)!; w.host.setFile("main", FILE, text.slice(0, text.indexOf("<!-- rovara:les_bbbb0002 -->"))); };

/** Eight merged lessons, then a change that takes seven of them out of the file; the second pass is a week later, so a person is being asked. */
async function awaiting(): Promise<{ w: W; digest: string }> {
  const w = passSetup();
  await w.seedLessons(...Array.from({ length: 8 }, (_, i) => repoLesson(`les_bbbb000${String(i + 1)}`)));
  await w.enable();
  const result = await w.run();
  w.host.merge(Number((result as { number: string }).number));
  cutAfterFirst(w);
  w.week();
  await w.run();
  w.week();
  await w.run();
  return { w, digest: (await w.current()).readBackHeld!.digest };
}

describe("a mass disappearance after its week", () => {
  it("is not retired: the row says a person is asked (retireConfirm and the fixed notice), and before the week it says when", async () => {
    const w = passSetup();
    await w.seedLessons(...Array.from({ length: 8 }, (_, i) => repoLesson(`les_bbbb000${String(i + 1)}`)));
    await w.enable();
    const result = await w.run();
    w.host.merge(Number((result as { number: string }).number));
    cutAfterFirst(w);
    w.week();
    await w.run();
    const first = await w.current();
    const early = rowOf(first, w.clock.now());
    expect(early.retireConfirm).toBeUndefined();
    const date = new Date(first.readBackHeld!.at + 7 * DAY).toISOString().slice(0, 10);
    expect(early.notices).toContain(`7 lessons are missing from the lessons file; on or after ${date} a person will be asked to confirm retiring them unless they are restored`);

    w.week();
    await w.run();
    const state = await w.current();
    expect(await retired(w)).toEqual([]);
    expect(state.readBackHeld).toMatchObject({ missing: 7 });
    expect(state.readBackHeld!.verdict).toBeUndefined();
    const row = rowOf(state, w.clock.now());
    expect(row.retireConfirm).toEqual({ missing: 7, since: first.readBackHeld!.at, digest: state.readBackHeld!.digest });
    const since = new Date(first.readBackHeld!.at).toISOString().slice(0, 10);
    expect(row.notices).toContain(`7 lessons have been missing from the lessons file since ${since}. Confirm to retire them, or keep them`);
    // Still waiting a month later, and still nothing retired: it stays that way until a person decides.
    for (let i = 0; i < 4; i += 1) { w.week(); await w.run(); }
    expect(await retired(w)).toEqual([]);
    expect((await w.current()).readBackHeld!.at).toBe(first.readBackHeld!.at);
    expect((await repoFileStatus(runtimeOf(w), w.key)).repos[0]!.retireConfirm).toMatchObject({ missing: 7 });
    for (const notice of row.notices) expect(notice.length).toBeLessThanOrEqual(300);
  });

  it("a small number missing still retires at once, with no person asked", async () => {
    const w = passSetup();
    await w.seedLessons(...Array.from({ length: 8 }, (_, i) => repoLesson(`les_bbbb000${String(i + 1)}`)));
    await w.enable();
    const result = await w.run();
    w.host.merge(Number((result as { number: string }).number));
    const text = w.host.file("main", FILE)!;
    w.host.setFile("main", FILE, ["les_bbbb0001", "les_bbbb0002"].reduce((t, id) => t.replace(new RegExp(`<!-- rovara:${id} -->\\n[^\\n]*\\n`, "u"), ""), text));
    w.week();
    await w.run();
    expect(await retired(w)).toHaveLength(2);
    expect((await w.current()).readBackHeld).toBeUndefined();
    expect(rowOf(await w.current(), w.clock.now()).retireConfirm).toBeUndefined();
  });
});

describe("confirming the retire", () => {
  it("is audited first and only recorded: nothing is retired inside the request, the nightly retire-only pass retires them (cause removed_in_repository)", async () => {
    const { w, digest } = await awaiting();
    const callsBefore = w.host.calls.length;
    const answer = await act(w, "retire_confirm", digest);
    expect(answer.ok).toBe(true);
    expect(w.host.calls.length).toBe(callsBefore);
    const decided = w.audit.events.filter((e) => e.action === "lesson.repo_file_retire_decided");
    expect(decided).toEqual([expect.objectContaining({ actor: WHO.developerId, facts: { verdict: "retire", missing: 7 } })]);
    expect(await retired(w)).toEqual([]);
    expect((await w.current()).readBackHeld).toMatchObject({ verdict: "retire" });
    expect(rowOf(await w.current(), w.clock.now()).notices).toContain("Retiring 7 missing lessons was confirmed; Rovara retires them within a day");
    await night(w);
    expect(await retired(w)).toHaveLength(7);
    const state = await w.current();
    expect(state.readBackHeld).toBeUndefined();
    expect(state.readBack).toMatchObject({ retired: 7 });
    expect(w.audit.events.filter((e) => e.action === "lesson.retired" && e.facts["cause"] === "removed_in_repository")).toHaveLength(7);
    const order = w.audit.actions();
    expect(order.indexOf("lesson.repo_file_retire_decided")).toBeLessThan(order.lastIndexOf("lesson.retired"));
    expect(JSON.stringify(state)).not.toContain(WHO.developerId);
    // The weekly pass, when it next runs, declines the retired ids as it always did.
    w.week();
    await w.run();
    expect((await w.current()).declined.length).toBe(7);
  });

  it("a confirm while Rovara's weekly pull request is open leaves the pull request, unmerged and lastPassAt alone, now and when the nightly retire runs", async () => {
    const { w, digest } = await awaiting();
    await w.seedLessons(repoLesson("les_cccc0001"));
    w.week();
    const opened = await w.run();
    expect(opened.status).toBe("opened");
    const before = await w.current();
    const hostBefore = [...w.host.writes];
    const prs = JSON.stringify(w.host.prs);
    expect(before.open).toBeDefined();
    const digestNow = before.readBackHeld!.digest;
    expect(digestNow).toBe(digest);
    w.clock.advance(DAY);
    expect(await act(w, "retire_confirm", digest)).toMatchObject({ ok: true });
    await night(w);
    expect(await retired(w)).toHaveLength(7);
    const after = await w.current();
    expect(after.open).toEqual(before.open);
    expect(after.unmerged).toBe(before.unmerged);
    expect(after.lastPassAt).toBe(before.lastPassAt);
    expect(after.closing).toEqual(before.closing);
    expect(w.host.writes).toEqual(hostBefore);
    expect(JSON.stringify(w.host.prs)).toBe(prs);
  });

  it("while lessons are switched off nothing is retired by the nightly job; when they are switched on again it is", async () => {
    const { w, digest } = await awaiting();
    await act(w, "retire_confirm", digest);
    setLearnedLessonsGate(() => false);
    await night(w);
    expect(await retired(w)).toEqual([]);
    expect((await w.current()).readBackHeld).toMatchObject({ verdict: "retire" });
    setLearnedLessonsGate(() => true);
    await night(w);
    expect(await retired(w)).toHaveLength(7);
  });

  it("a ledger that is down changes nothing: no verdict, nothing retired", async () => {
    const { w, digest } = await awaiting();
    const before = await w.current();
    w.failAudit.on = true;
    expect(await act(w, "retire_confirm", digest)).toEqual({ ok: false, code: "audit_unavailable" });
    expect(await w.current()).toEqual(before);
    expect(await retired(w)).toEqual([]);
  });

  it("when the file changes after the confirm (before the nightly retire), nothing is retired and the hold starts over", async () => {
    const { w, digest } = await awaiting();
    expect(await act(w, "retire_confirm", digest)).toMatchObject({ ok: true });
    expect(await retired(w)).toEqual([]);
    // The team puts one lesson back: a different set is missing now.
    const text = w.host.file("main", FILE)!;
    w.host.setFile("main", FILE, `${text}\n### Whole repository\n\n<!-- rovara:les_bbbb0002 -->\n- Lesson text for les_bbbb0002: use the shared helper.\n`);
    await night(w);
    expect(await retired(w)).toEqual([]);
    const state = await w.current();
    expect(state.readBackHeld).toMatchObject({ missing: 6 });
    expect(state.readBackHeld!.verdict).toBeUndefined();
    expect(state.readBackHeld!.digest).not.toBe(digest);
    // The retire-only pass starts nothing on the host.
    expect(w.host.writes.filter((write) => write.op === "create")).toHaveLength(1);
  });

  it("a verdict saved while a pass is running is not overwritten: the pass's own write conflicts and the answer stands", async () => {
    const { w, digest } = await awaiting();
    const host = w.host as unknown as { fileAtRevision: (...args: unknown[]) => Promise<unknown> };
    const read = host.fileAtRevision.bind(w.host);
    let answered = false;
    host.fileAtRevision = async (...args: unknown[]) => {
      const text = await read(...args);
      // A new bullet in the file makes the pass write its read-back; the person's answer lands first.
      if (!answered) { answered = true; await act(w, "retire_keep", digest); }
      return typeof text === "string" ? `${text}\n- A bullet the team wrote while the pass was running.\n` : text;
    };
    w.week();
    expect(await w.run()).toMatchObject({ status: "problem", problem: "conflict" });
    expect(answered).toBe(true);
    expect((await w.current()).readBackHeld).toMatchObject({ verdict: "keep", digest });
  });

});

describe("keeping the lessons", () => {
  it("they stay live and are not declined, the next pull request proposes their blocks back, and the hold clears once the file has them", async () => {
    const { w, digest } = await awaiting();
    expect(await act(w, "retire_keep", digest)).toMatchObject({ ok: true });
    expect(w.audit.events.filter((e) => e.action === "lesson.repo_file_retire_decided")).toEqual([expect.objectContaining({ facts: { verdict: "keep", missing: 7 } })]);
    expect(await retired(w)).toEqual([]);
    const live = (await w.store.listAllHeads(w.key)).filter((l) => l.status === "active");
    expect(live).toHaveLength(8);
    expect((await w.current()).declined).toEqual([]);
    const kept = rowOf(await w.current(), w.clock.now());
    expect(kept.retireConfirm).toBeUndefined();
    expect(kept.notices).toContain("7 missing lessons were kept; Rovara proposes them back in your lessons PR");
    // The next pass proposes them back as additions; nothing is retired or declined while the same set is missing.
    w.week();
    const result = await w.run();
    expect(result).toMatchObject({ status: "opened", adds: 7, removals: 0 });
    expect(await retired(w)).toEqual([]);
    expect((await w.current()).declined).toEqual([]);
    expect((await w.current()).readBackHeld).toMatchObject({ verdict: "keep" });
    w.host.merge(Number((result as { number: string }).number));
    w.week();
    await w.run();
    expect(parseLessonsFile(w.host.file("main", FILE)!).blocks).toHaveLength(8);
    expect((await w.current()).readBackHeld).toBeUndefined();
    expect(await retired(w)).toEqual([]);
    // Removing them again is a new disappearance: a new hold and a new card, after another week.
    cutAfterFirst(w);
    w.week();
    await w.run();
    const again = await w.current();
    expect(again.readBackHeld).toMatchObject({ missing: 7 });
    expect(again.readBackHeld!.verdict).toBeUndefined();
    expect(rowOf(again, w.clock.now()).retireConfirm).toBeUndefined();
    w.week();
    await w.run();
    expect(rowOf(await w.current(), w.clock.now()).retireConfirm).toMatchObject({ missing: 7 });
  });

  it("a keep ends when Rovara's restore pull request is merged: removing the same lessons again is a new hold, even between two passes", async () => {
    const { w, digest } = await awaiting();
    await act(w, "retire_keep", digest);
    const first = (await w.current()).readBackHeld!;
    w.week();
    const result = await w.run();
    expect(result).toMatchObject({ status: "opened", adds: 7 });
    w.host.merge(Number((result as { number: string }).number));
    // The team removes the same lessons again before Rovara looks at the file once more.
    cutAfterFirst(w);
    w.week();
    await w.run();
    const state = await w.current();
    expect(state.readBackHeld).toMatchObject({ missing: 7, digest });
    expect(state.readBackHeld!.verdict).toBeUndefined();
    expect(state.readBackHeld!.at).toBeGreaterThan(first.at);
    expect(await retired(w)).toEqual([]);
    expect(rowOf(state, w.clock.now()).retireConfirm).toBeUndefined();
    w.week();
    await w.run();
    expect(rowOf(await w.current(), w.clock.now()).retireConfirm).toMatchObject({ missing: 7 });
  });

  it("a keep ends when the team closes Rovara's restore pull request: a fresh week and a fresh card, not a state stuck with no card", async () => {
    const { w, digest } = await awaiting();
    await act(w, "retire_keep", digest);
    const first = (await w.current()).readBackHeld!;
    w.week();
    const result = await w.run();
    expect(result).toMatchObject({ status: "opened" });
    w.host.prs.find((pr) => String(pr.number) === (result as { number: string }).number)!.state = "closed";
    w.week();
    await w.run();
    const state = await w.current();
    expect(state.unmerged).toBe(1);
    expect(state.readBackHeld).toMatchObject({ missing: 7, digest });
    expect(state.readBackHeld!.verdict).toBeUndefined();
    expect(state.readBackHeld!.at).toBeGreaterThan(first.at);
    w.week();
    await w.run();
    expect(rowOf(await w.current(), w.clock.now()).retireConfirm).toMatchObject({ missing: 7 });
    expect(await retired(w)).toEqual([]);
  });

  it("while the keep stands and nothing else changes, no card comes and nothing retires, however many passes run", async () => {
    const { w, digest } = await awaiting();
    await act(w, "retire_keep", digest);
    w.host.failCalls.add("commitFiles");
    for (let i = 0; i < 3; i += 1) { w.week(); await w.run(); }
    expect(await retired(w)).toEqual([]);
    expect(rowOf(await w.current(), w.clock.now()).retireConfirm).toBeUndefined();
  });
});

describe("what is refused", () => {
  it("a missing or different digest, a hold not yet a week old, and nothing held are all a conflict", async () => {
    const { w, digest } = await awaiting();
    const other = digest === "0".repeat(16) ? "1".repeat(16) : "0".repeat(16);
    expect(await act(w, "retire_confirm", other)).toEqual({ ok: false, code: "conflict" });
    expect(await act(w, "retire_keep", undefined)).toEqual({ ok: false, code: "conflict" });
    expect(w.audit.actions()).not.toContain("lesson.repo_file_retire_decided");
    expect((await w.current()).readBackHeld!.verdict).toBeUndefined();

    // Not yet a week: a fresh sighting.
    const fresh = passSetup();
    await fresh.seedLessons(...Array.from({ length: 8 }, (_, i) => repoLesson(`les_bbbb000${String(i + 1)}`)));
    await fresh.enable();
    const opened = await fresh.run();
    fresh.host.merge(Number((opened as { number: string }).number));
    cutAfterFirst(fresh);
    fresh.week();
    await fresh.run();
    const early = (await fresh.current()).readBackHeld!.digest;
    expect(await act(fresh, "retire_confirm", early)).toEqual({ ok: false, code: "conflict" });
    expect(await retired(fresh)).toEqual([]);
    // Nothing held at all.
    const none = passSetup();
    await none.enable();
    expect(await act(none, "retire_confirm", "0".repeat(16))).toEqual({ ok: false, code: "conflict" });
  });

  it("the same answer again returns the row unchanged and writes nothing more; a kept set may be retired; a confirmed retire cannot be turned into a keep", async () => {
    const { w, digest } = await awaiting();
    await act(w, "retire_keep", digest);
    const revision = (await w.current()).revision;
    const events = w.audit.events.length;
    expect(await act(w, "retire_keep", digest)).toMatchObject({ ok: true, row: { repo: "api" } });
    expect((await w.current()).revision).toBe(revision);
    expect(w.audit.events.length).toBe(events);
    // keep -> retire: recorded, audited, and carried out by the nightly job.
    expect(await act(w, "retire_confirm", digest)).toMatchObject({ ok: true });
    expect((await w.current()).readBackHeld!.verdict).toBe("retire");
    expect(w.audit.events.filter((e) => e.action === "lesson.repo_file_retire_decided").map((e) => e.facts["verdict"])).toEqual(["keep", "retire"]);
    const afterRetire = (await w.current()).revision;
    expect(await act(w, "retire_confirm", digest)).toMatchObject({ ok: true });
    expect((await w.current()).revision).toBe(afterRetire);
    // retire -> keep: a conflict, nothing changes.
    expect(await act(w, "retire_keep", digest)).toEqual({ ok: false, code: "conflict" });
    expect((await w.current()).readBackHeld!.verdict).toBe("retire");
    expect((await w.current()).revision).toBe(afterRetire);
    await night(w);
    expect(await retired(w)).toHaveLength(7);
  });

  it("a switched-off repository takes no answer", async () => {
    const { w, digest } = await awaiting();
    const state = await w.current();
    await w.state.put(w.key, { ...state, enabled: false }, state.revision);
    expect(await act(w, "retire_confirm", digest)).toEqual({ ok: false, code: "conflict" });
    expect(w.audit.actions()).not.toContain("lesson.repo_file_retire_decided");
  });

  it("without a decider the action is refused (the route is the one that checks who may answer)", async () => {
    const { w, digest } = await awaiting();
    expect(await act(w, "retire_confirm", digest, null)).toEqual({ ok: false, code: "not_permitted" });
    expect((await w.current()).readBackHeld!.verdict).toBeUndefined();
  });

  it("the body needs held for these two actions and refuses it for every other", () => {
    expect(LessonsRepoFileBodySchema.safeParse({ action: "retire_confirm", repo: "api" }).success).toBe(false);
    expect(LessonsRepoFileBodySchema.safeParse({ action: "retire_keep", repo: "api", held: "0123456789abcdef" }).success).toBe(true);
    expect(LessonsRepoFileBodySchema.safeParse({ action: "off", repo: "api", held: "0123456789abcdef" }).success).toBe(false);
    expect(LessonsRepoFileBodySchema.safeParse({ action: "retire_keep", repo: "api", held: "nope" }).success).toBe(false);
  });
});

describe("the threshold: more than max(3, 25%) of the known ids", () => {
  const strip = (id: string) => (text: string) => text.replace(new RegExp(`<!-- rovara:${id} -->\\n- [^\\n]*\\n\\n?`, "u"), "");
  /** `known` merged lessons, then a change that takes `missing` of them out of the file, seen by the next pass. */
  async function afterChange(known: number, missing: number): Promise<W> {
    const ids = Array.from({ length: known }, (_, i) => `les_cccc${String(i + 1).padStart(4, "0")}`);
    const w = passSetup();
    await w.seedLessons(...ids.map((id) => repoLesson(id)));
    await w.enable();
    const result = await w.run();
    w.host.merge(Number((result as { number: string }).number));
    w.host.setFile("main", FILE, ids.slice(0, missing).reduce((text, id) => strip(id)(text), w.host.file("main", FILE)!));
    w.week();
    await w.run();
    return w;
  }

  it.each([[5, 3], [8, 3], [20, 5], [21, 6]] as const)("%i known, %i missing (at the limit): retired right away, nobody is asked", async (known, missing) => {
    const w = await afterChange(known, missing);
    expect(await retired(w)).toHaveLength(missing);
    expect((await w.current()).readBackHeld).toBeUndefined();
  });

  it.each([[5, 4], [8, 4], [20, 6], [21, 7]] as const)("%i known, %i missing (one over the limit): nothing is retired, the set is held for a person", async (known, missing) => {
    const w = await afterChange(known, missing);
    expect(await retired(w)).toEqual([]);
    expect((await w.current()).readBackHeld).toMatchObject({ missing });
  });
});
