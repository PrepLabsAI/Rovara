// The weekly pass that proposes Rovara's `.rovara/lessons.md` through one batched pull request. These tests are the invariants;
// the mutation checks (eligibility filter removed, adoption allowed, ignored-PR rule removed, hand-edit hold removed) are recorded in the this install.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { LESSON_FILE_BRANCH_PATTERN } from "@rovara-code/contracts";
import { setLearnedLessonsGate } from "../../../packages/lessons/src/policy.js";
import { parseLessonsFile } from "../../../packages/lessons/src/repo-file-format.js";
import { DAY, FILE, FakeRepoHost, OTHER_PLACE, passSetup, personApproved, repoLesson } from "./repo-file-helpers.js";

afterEach(() => { setLearnedLessonsGate(() => true); });
const idsIn = (text: string | undefined): string[] => (text === undefined ? [] : parseLessonsFile(text).blocks.map((b) => b.id));
/** Runs a pass and merges the pull request it opened, as a person would; returns the pull request number. */
async function runAndMerge(w: ReturnType<typeof passSetup>): Promise<number> {
  const result = await w.run();
  expect(result.status).toBe("opened");
  const number = Number((result as { number: string }).number);
  w.host.merge(number);
  return number;
}

describe("the first pull request", () => {
  it("proposes the eligible lessons in a new file on a new random branch, from the default head, without force, with the pointer", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson("les_aaaa0001"), repoLesson("les_aaaa0002"));
    await w.enable();
    const head = w.host.heads.get("main")!;
    const result = await w.run();
    expect(result).toMatchObject({ status: "opened", adds: 2, removals: 0, edits: 0 });
    const state = await w.current();
    expect(state.open!.branch).toMatch(LESSON_FILE_BRANCH_PATTERN);
    expect(idsIn(w.host.file(state.open!.branch, FILE))).toEqual(["les_aaaa0001", "les_aaaa0002"]);
    expect(w.host.file(state.open!.branch, "AGENTS.md")).toContain(".rovara/lessons.md");
    const commit = w.host.writes.find((write) => write.op === "commit")!;
    expect(commit).toMatchObject({ force: false, parent: head, branch: state.open!.branch });
    expect(w.host.file("main", FILE)).toBeUndefined();
    expect(w.host.open).toHaveLength(1);
    expect(w.host.open[0]!.body.indexOf("Proposed new lessons")).toBeGreaterThan(0);
    expect(state.pointerProposed).toBe(true);
  });

  it("audits before it writes, and a ledger that is down means nothing is written at all", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson("les_aaaa0001"));
    await w.enable();
    let auditedBeforeCommit = -1;
    w.host.beforeCommit = () => { auditedBeforeCommit = w.audit.actions().filter((a) => a === "lesson.repo_file_pr_opened").length; };
    await w.run();
    expect(auditedBeforeCommit).toBe(1);

    const down = passSetup();
    await down.seedLessons(repoLesson("les_aaaa0001"));
    await down.enable();
    down.failAudit.on = true;
    expect(await down.run()).toEqual({ status: "problem", problem: "audit_down" });
    expect(down.host.writes).toEqual([]);
    expect(down.host.calls).not.toContain("commitFiles");
    expect((await down.current()).lastPassAt).toBeUndefined();
  });
});

describe("only eligible lessons ever appear", () => {
  it("keeps out every lesson that is not eligible for THIS repository, in the file and in the pull request body", async () => {
    const w = passSetup({ names: ["Ann Lee"] });
    const good = repoLesson("les_good0001");
    const bad = [
      repoLesson("les_othr0001", { place: OTHER_PLACE }),
      repoLesson("les_norp0001", { provenance: { ...good.provenance, repoOnly: undefined } }),
      repoLesson("les_rest0001", { provenance: { ...good.provenance, audience: { kind: "restricted", acl: { source: "slack", scope: "slack:channel/C1", capturedAt: "t", liveCheck: "on_read" } } } }),
      repoLesson("les_trial001", { trial: { state: "trial", startedAt: 1 } }),
      repoLesson("les_name0001", { body: "Ask Ann Lee before you change retries." }),
      repoLesson("les_hand0001", { body: "Ping @octocat about the retry helper." }),
      repoLesson("les_gone0001", { status: "retired" }),
      repoLesson("les_tier20001", { tier: 2 }),
      repoLesson("les_harm0001", { counters: { loaded: 3, helpful: 0, harmful: 1, citationStale: 0 } }),
      repoLesson("les_noap0001", { trial: undefined, approvals: [{ approvalId: "a", by: "system:auto", at: 1, mode: "auto" }] }),
    ];
    await w.seedLessons(good, ...bad);
    await w.enable();
    expect(await w.run()).toMatchObject({ status: "opened", adds: 1 });
    const state = await w.current();
    expect(idsIn(w.host.file(state.open!.branch, FILE))).toEqual(["les_good0001"]);
    const body = w.host.open[0]!.body;
    for (const lesson of bad) { expect(body).not.toContain(lesson.id); expect(JSON.stringify(w.host.writes)).not.toContain(lesson.id); }
    expect(Object.keys(state.open!.added)).toEqual(["les_good0001"]);
  });

  it("proposes nothing, and opens no pull request, when nothing is eligible", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson("les_othr0001", { place: OTHER_PLACE }));
    await w.enable();
    expect(await w.run()).toEqual({ status: "no_changes" });
    expect(w.host.writes).toEqual([]);
    expect(w.host.prs).toEqual([]);
  });

  it("under the Regulated preset only person-approved lessons are added", async () => {
    const w = passSetup({ preset: "regulated" });
    await w.seedLessons(repoLesson("les_stab0001"), personApproved(repoLesson("les_pers0001")));
    await w.enable();
    await w.run();
    expect(idsIn(w.host.file((await w.current()).open!.branch, FILE))).toEqual(["les_pers0001"]);
  });
});

describe("an unchanged set opens nothing", () => {
  it("after a merge, the next weekly pass has no changes and writes nothing (byte-identical)", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson("les_aaaa0001"), repoLesson("les_aaaa0002"));
    await w.enable();
    await runAndMerge(w);
    const merged = w.host.file("main", FILE);
    w.host.writes.length = 0;
    w.week();
    expect(await w.run()).toEqual({ status: "no_changes" });
    expect(w.host.writes.filter((write) => write.op === "commit" || write.op === "create")).toEqual([]);
    expect(w.host.file("main", FILE)).toBe(merged);
    expect(Object.keys((await w.current()).rendered).sort()).toEqual(["les_aaaa0001", "les_aaaa0002"]);
  });

  it("the same proposals as the open pull request leave it alone (no new branch, no close)", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson("les_aaaa0001"));
    await w.enable();
    await w.run();
    const first = (await w.current()).open!;
    w.host.writes.length = 0;
    w.week();
    expect(await w.run()).toEqual({ status: "left" });
    expect(w.host.writes).toEqual([]);
    expect((await w.current()).open!.branch).toBe(first.branch);
    expect((await w.current()).unmerged).toBe(1);
  });

  it("is one pass a week: a second run inside the week does nothing", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson("les_aaaa0001"));
    await w.enable();
    await w.run();
    w.clock.advance(2 * DAY);
    expect(await w.run()).toEqual({ status: "skipped", reason: "not_due" });
  });
});

describe("one open Rovara pull request per repository, nothing adopted", () => {
  it("a changed proposal opens a new pull request on a new branch, then closes the previous one and deletes its branch", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson("les_aaaa0001"));
    await w.enable();
    await w.run();
    const first = (await w.current()).open!;
    await w.seedLessons(repoLesson("les_aaaa0002"));
    w.week();
    expect(await w.run()).toMatchObject({ status: "opened", adds: 2 });
    const second = (await w.current()).open!;
    expect(second.branch).not.toBe(first.branch);
    expect(w.host.open.map((pr) => pr.source)).toEqual([second.branch]);
    expect(w.host.branchNames).toEqual([second.branch]);
    expect((await w.current()).closing).toEqual([]);
    // The new one was up before the old one came down.
    const order = w.host.writes.map((write) => `${write.op}:${write.branch ?? write.id}`);
    expect(order.indexOf(`create:${second.branch}`)).toBeLessThan(order.indexOf(`delete:${first.branch}`));
    expect(w.audit.events.filter((e) => e.action === "lesson.repo_file_pr_closed")).toHaveLength(1);
  });

  it("on a host that cannot say who made a pull request, the old Rovara pull request is still found by its branch and recorded head, closed, and no new one piles up beside it", async () => {
    const host = new FakeRepoHost();
    host.omitAuthorship = true;
    const w = passSetup({ host });
    await w.seedLessons(repoLesson("les_aaaa0001"));
    await w.enable();
    await w.run();
    const first = (await w.current()).open!;
    await w.seedLessons(repoLesson("les_aaaa0002"));
    w.week();
    await w.run();
    const second = (await w.current()).open!;
    expect(w.host.open.map((pr) => pr.source)).toEqual([second.branch]);
    expect(w.host.branchNames).toEqual([second.branch]);
    expect((await w.current()).closing).toEqual([]);
    expect(first.branch).not.toBe(second.branch);
  });

  it("on a host that cannot say who made a pull request, one a person pushed to since is not taken as Rovara's and is left open", async () => {
    const host = new FakeRepoHost();
    host.omitAuthorship = true;
    const w = passSetup({ host });
    await w.seedLessons(repoLesson("les_aaaa0001"));
    await w.enable();
    await w.run();
    const first = (await w.current()).open!;
    host.setFile(first.branch, "notes.txt", "the team added this");
    await w.seedLessons(repoLesson("les_aaaa0002"));
    w.week();
    await w.run();
    expect(w.host.open.map((pr) => pr.source)).toContain(first.branch);
    expect(w.host.writes.filter((x) => x.op === "delete" && x.branch === first.branch)).toEqual([]);
  });

  it("never uses a branch that already exists, even one with Rovara's prefix and the name it would have chosen; the person's branch is untouched", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson("les_aaaa0001"));
    await w.enable();
    const theirs = "rovara/lessons-000000000001";
    w.host.setFile(theirs, "notes.txt", "the team's own work");
    w.host.setFile("main", "README.md", "x");
    const before = w.host.heads.get(theirs);
    await w.run();
    const state = await w.current();
    expect(state.open!.branch).not.toBe(theirs);
    expect(w.host.heads.get(theirs)).toBe(before);
    expect(w.host.file(theirs, "notes.txt")).toBe("the team's own work");
    expect(w.host.writes.map((write) => write.branch)).not.toContain(theirs);
  });

  it("leaves a person's pull request and branches alone: only branches Rovara recorded are ever written, closed or deleted", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson("les_aaaa0001"));
    await w.enable();
    w.host.setFile("feature/billing", "src/a.ts", "a");
    w.host.prs.push({ number: 99, source: "feature/billing", target: "main", baseRevision: w.host.heads.get("main")!, title: "Billing", body: "", state: "open" });
    for (let week = 0; week < 3; week += 1) { await w.seedLessons(repoLesson(`les_more00${String(week)}`)); await w.run(); w.week(); }
    expect(w.host.prs.find((pr) => pr.number === 99)!.state).toBe("open");
    expect(w.host.files.has("feature/billing")).toBe(true);
    const ours = new Set(w.host.writes.flatMap((write) => (write.branch === undefined ? [] : [write.branch])));
    for (const branch of ours) expect(branch).toMatch(LESSON_FILE_BRANCH_PATTERN);
    expect(w.host.writes.filter((write) => write.id === "99")).toEqual([]);
  });

  it("a pull request a person pushed to is theirs: not closed, not written, its branch kept; with nothing to remove nothing new is opened beside it", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson("les_aaaa0001"));
    await w.enable();
    await w.run();
    const open = (await w.current()).open!;
    w.host.setFile(open.branch, FILE, `${w.host.file(open.branch, FILE)!}\nA line the team added to the pull request.\n`);
    await w.seedLessons(repoLesson("les_aaaa0002"));
    w.host.writes.length = 0;
    w.week();
    expect(await w.run()).toEqual({ status: "no_changes" });
    expect(w.host.writes).toEqual([]);
    expect((await w.current()).theirs.map((t) => t.branch)).toEqual([open.branch]);
    expect(w.host.open).toHaveLength(1);
    expect(w.host.files.has(open.branch)).toBe(true);
  });

  it("a pull request the team closed counts as unmerged and its branch is deleted; one a person pushed to keeps its branch", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson("les_aaaa0001"));
    await w.enable();
    await w.run();
    const first = (await w.current()).open!;
    w.host.close(1);
    await w.seedLessons(repoLesson("les_aaaa0002"));
    w.week();
    await w.run();
    expect(w.host.files.has(first.branch)).toBe(false);
    expect((await w.current()).unmerged).toBe(1);
    const second = (await w.current()).open!;
    w.host.setFile(second.branch, "notes.txt", "a person's commit");
    w.host.close(2);
    await w.seedLessons(repoLesson("les_aaaa0003"));
    w.week();
    await w.run();
    expect(w.host.files.has(second.branch)).toBe(true);
    expect((await w.current()).unmerged).toBe(2);
  });

  it("cleans up a write whose pull request was never recorded: the next pass deletes that branch (and only that) before opening afresh", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson("les_aaaa0001"));
    await w.enable();
    w.host.failCalls.add("reconcileChangeRequest");
    expect(await w.run()).toEqual({ status: "problem", problem: "write_refused" });
    const stray = (await w.current()).pending!.branch;
    expect(w.host.files.has(stray)).toBe(true);
    w.host.failCalls.delete("reconcileChangeRequest");
    w.week();
    expect(await w.run()).toMatchObject({ status: "opened" });
    expect(w.host.files.has(stray)).toBe(false);
    expect(w.host.branchNames).toHaveLength(1);
    expect(w.host.open).toHaveLength(1);
  });

  it("a push to the default branch between the read and the write does not move the base: the branch is made at the head the file was read at", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson("les_aaaa0001"));
    await w.enable();
    const read = w.host.heads.get("main")!;
    w.host.beforeCommit = () => { w.host.setFile("main", "other.txt", "pushed meanwhile"); };
    await w.run();
    const state = await w.current();
    expect(state.open!.baseRevision).toBe(read);
    expect(w.host.writes.find((write) => write.op === "commit")!.parent).toBe(read);
  });
});

describe("removals come first, with reasons, and the ignored-PR rule", () => {
  async function mergedFileWith(ids: string[]) {
    const w = passSetup();
    await w.seedLessons(...ids.map((id) => repoLesson(id)));
    await w.enable();
    await runAndMerge(w);
    return w;
  }

  it("lists removals first with a reason each, then edits, then adds", async () => {
    const w = await mergedFileWith(["les_aaaa0001", "les_aaaa0002", "les_aaaa0003", "les_aaaa0004"]);
    // 1 retired, 2 harmful, 3 text refined (an edit), a new one (an add).
    const store = w.store;
    const lessons = await store.listAllHeads(w.key);
    const by = (id: string) => lessons.find((l) => l.id === id)!;
    await store.commit(w.key, await store.setVersion(w.key), [
      { ...by("les_aaaa0001"), version: 2, status: "retired" },
      { ...by("les_aaaa0003"), version: 2, body: "A refined wording of the third lesson." },
    ], 5);
    await store.mutate(w.key, "les_aaaa0002", (lesson) => ({ counters: { ...lesson.counters, harmful: 1 } }));
    await w.seedLessons(repoLesson("les_aaaa0005"));
    w.week();
    expect(await w.run()).toMatchObject({ status: "opened", removals: 2, edits: 1, adds: 1 });
    const body = w.host.open[0]!.body;
    const positions = ["Proposed removals (2)", "Proposed edits (1)", "Proposed new lessons (1)"].map((heading) => body.indexOf(heading));
    expect(positions.every((p) => p > 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(body).toMatch(/les_aaaa0001.*Rovara no longer proposes this lesson/u);
    expect(body).toMatch(/les_aaaa0002.*Rovara no longer proposes this lesson/u);
    const next = w.host.file((await w.current()).open!.branch, FILE)!;
    expect(idsIn(next)).toEqual(["les_aaaa0003", "les_aaaa0004", "les_aaaa0005"]);
    expect(next).toContain("A refined wording of the third lesson.");
  });

  it("after 3 unmerged weekly pull requests stops adding and editing, still proposes removals, says so, and never grows", async () => {
    const w = await mergedFileWith(["les_aaaa0001", "les_aaaa0002"]);
    const store = w.store;
    const head = (await store.listAllHeads(w.key)).find((l) => l.id === "les_aaaa0001")!;
    await store.commit(w.key, await store.setVersion(w.key), [{ ...head, version: 2, status: "expired" }], 5);
    const sizes: number[] = [];
    for (let week = 1; week <= 5; week += 1) {
      await w.seedLessons(repoLesson(`les_new00${String(week)}`));
      w.week();
      await w.run();
      const open = (await w.current()).open;
      sizes.push(open === undefined ? 0 : open.removals + open.edits + open.adds);
      expect(w.host.open.length).toBeLessThanOrEqual(1);
    }
    const state = await w.current();
    expect(state.unmerged).toBeGreaterThanOrEqual(3);
    // Weeks 1-3 carry adds; from the fourth on only the one removal.
    expect(sizes.slice(0, 3).every((n) => n >= 2)).toBe(true);
    expect(sizes.slice(3)).toEqual([1, 1]);
    expect(state.open).toMatchObject({ removals: 1, adds: 0, edits: 0 });
    const body = w.host.open[0]!.body;
    expect(body).toContain("Rovara has paused new lessons until a lessons PR is merged; 1 removal is waiting");
    expect(body).toMatch(/les_aaaa0001.*not helped for a long time/u);
    expect(idsIn(w.host.file(state.open!.branch, FILE))).toEqual(["les_aaaa0002"]);
  });

  it("a merge resets the count and additions come back", async () => {
    const w = await mergedFileWith(["les_aaaa0001"]);
    for (let week = 1; week <= 3; week += 1) { await w.seedLessons(repoLesson(`les_new00${String(week)}`)); w.week(); await w.run(); }
    w.week(); await w.run();
    expect((await w.current()).unmerged).toBeGreaterThanOrEqual(3);
    // Nothing removable, nothing added: no pull request is open beside it, and it is closed.
    expect((await w.current()).open).toBeUndefined();
    expect(w.host.open).toHaveLength(0);
    // The team merges a removal-free week by resuming: simulate by a lesson being retired so that a removals-only PR exists, and merging it.
    const store = w.store;
    const head = (await store.listAllHeads(w.key)).find((l) => l.id === "les_aaaa0001")!;
    await store.commit(w.key, await store.setVersion(w.key), [{ ...head, version: 2, status: "retired" }], 9);
    w.week();
    expect(await w.run()).toMatchObject({ status: "opened", removals: 1, adds: 0 });
    w.host.merge(w.host.open[0]!.number);
    w.week();
    const result = await w.run();
    expect((await w.current()).unmerged).toBe(0);
    expect(result.status).toBe("opened");
    expect((result as { adds: number }).adds).toBeGreaterThan(0);
  });
});

describe("the team's own edits are never overwritten (hand-edit hold, released by read-back)", () => {
  it("a block a person reworded becomes the lesson's own text, so Rovara's later wording never wins and nothing is held", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson("les_aaaa0001"), repoLesson("les_aaaa0002"));
    await w.enable();
    await runAndMerge(w);
    const merged = w.host.file("main", FILE)!;
    w.host.setFile("main", FILE, merged.replace("Lesson text for les_aaaa0001: use the shared helper.", "The team's own wording of the first lesson."));
    const store = w.store;
    const lessons = await store.listAllHeads(w.key);
    const first = lessons.find((l) => l.id === "les_aaaa0001")!;
    await store.commit(w.key, await store.setVersion(w.key), [{ ...first, version: 2, body: "Rovara's new wording that must not win." }], 5);
    await w.seedLessons(repoLesson("les_aaaa0003"));
    w.week();
    expect(await w.run()).toMatchObject({ status: "opened", edits: 0, adds: 1 });
    const state = await w.current();
    expect(state.held).toEqual([]);
    expect((await store.get(w.key, "les_aaaa0001"))!.body).toBe("The team's own wording of the first lesson.");
    const next = w.host.file(state.open!.branch, FILE)!;
    expect(next).toContain("The team's own wording of the first lesson.");
    expect(next).not.toContain("Rovara's new wording that must not win.");
    // The lesson is Rovara's now: retiring it in Rovara proposes its removal like any other lesson.
    const reread = (await store.get(w.key, "les_aaaa0001"))!;
    await store.commit(w.key, await store.setVersion(w.key), [{ ...reread, version: reread.version + 1, status: "retired" }], 6);
    w.host.merge(w.host.open[0]!.number);
    w.week();
    await w.run();
    expect((await w.current()).open?.removed ?? []).toContain("les_aaaa0001");
  });

  it("a block the team moved to another section is theirs too", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson("les_aaaa0001"));
    await w.enable();
    await runAndMerge(w);
    const merged = w.host.file("main", FILE)!;
    w.host.setFile("main", FILE, merged.replace("## Whole repository", "## Our retry rules"));
    await w.seedLessons(repoLesson("les_aaaa0002"));
    w.week();
    await w.run();
    expect((await w.current()).held).toEqual(["les_aaaa0001"]);
  });

  it("keeps blocks the team wrote (no id line), unknown ids, paragraphs and sections byte for byte in every pull request", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson("les_aaaa0001"));
    await w.enable();
    await runAndMerge(w);
    const merged = w.host.file("main", FILE)!;
    const team = `${merged}\n- A bullet the team wrote with no id line.\n\n## Team notes\n\nFree text the team wrote.\n\n<!-- rovara:les_copied01 -->\n- Copied from elsewhere.\n`;
    w.host.setFile("main", FILE, team);
    await w.seedLessons(repoLesson("les_aaaa0002"));
    w.week();
    await w.run();
    const next = w.host.file((await w.current()).open!.branch, FILE)!;
    for (const kept of ["- A bullet the team wrote with no id line.", "## Team notes", "Free text the team wrote.", "<!-- rovara:les_copied01 -->", "- Copied from elsewhere."]) expect(next).toContain(kept);
    expect(idsIn(next)).toContain("les_aaaa0002");
  });

  it("a block the team removed is never proposed back", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson("les_aaaa0001"), repoLesson("les_aaaa0002"));
    await w.enable();
    await runAndMerge(w);
    w.host.setFile("main", FILE, parseFile(w.host.file("main", FILE)!).replace(/<!-- rovara:les_aaaa0001 -->\n- [^\n]*\n\n?/u, ""));
    await w.seedLessons(repoLesson("les_aaaa0003"));
    w.week();
    await w.run();
    const state = await w.current();
    expect(state.declined).toContain("les_aaaa0001");
    expect(idsIn(w.host.file(state.open!.branch, FILE))).toEqual(["les_aaaa0002", "les_aaaa0003"]);
  });
});
const parseFile = (text: string): string => text;

describe("while lessons are off nothing is delivered and the pass makes no model call", () => {
  it.each(["Off", "Collect"] as const)("mode %s: no pull request, no read, no state change", async (mode) => {
    const w = passSetup({ mode });
    await w.seedLessons(repoLesson("les_aaaa0001"));
    await w.enable();
    expect(await w.run()).toEqual({ status: "skipped", reason: "lessons_off" });
    expect(w.host.calls).toEqual([]);
    expect(w.host.writes).toEqual([]);
    expect((await w.current()).revision).toBe(1);
  });

  it("the switch off (ll=0) is the same, even when the project's own mode is On", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson("les_aaaa0001"));
    await w.enable();
    setLearnedLessonsGate(() => false);
    expect(await w.run()).toEqual({ status: "skipped", reason: "lessons_off" });
    expect(w.host.writes).toEqual([]);
  });

  it("the pass imports no model, pipeline or reflection code", () => {
    for (const file of ["repo-file-pass", "repo-file-plan", "repo-file-format", "repo-file-pointer", "repo-file-pr", "repo-file-state"]) {
      const text = readFileSync(`packages/lessons/src/${file}.ts`, "utf8");
      expect(text, file).not.toMatch(/PipelineModel|from "\.\/reflect|model-gate|learningCompletion|callModel|\.complete\(/u);
    }
  });
});

describe("the file and the host", () => {
  it("a file the team deleted pauses the repository: nothing retired, nothing re-added, until it is resumed", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson("les_aaaa0001"));
    await w.enable();
    await runAndMerge(w);
    w.host.setFile("main", FILE, undefined);
    w.week();
    expect(await w.run()).toEqual({ status: "skipped", reason: "file_deleted" });
    expect((await w.current()).fileDeleted).toBe(true);
    w.host.writes.length = 0;
    w.week();
    await w.seedLessons(repoLesson("les_aaaa0002"));
    expect(await w.run()).toEqual({ status: "skipped", reason: "file_deleted" });
    expect(w.host.writes).toEqual([]);
  });

  it.each([["symlink"], ["dir"]] as const)("a file that is a %s is left alone with a reason, and nothing is written", async (kind) => {
    const w = passSetup();
    await w.seedLessons(repoLesson("les_aaaa0001"));
    await w.enable();
    w.host.kinds.set(FILE, kind);
    expect(await w.run()).toEqual({ status: "problem", problem: "file_is_link" });
    expect(w.host.writes).toEqual([]);
    expect((await w.current()).problem).toBe("file_is_link");
  });

  it("a file over the cap is left alone; an unreadable repository or file retires nothing", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson("les_aaaa0001"));
    await w.enable();
    w.host.setFile("main", FILE, `# Team lessons for this repository\n${"x".repeat(70_000)}\n`);
    expect(await w.run()).toEqual({ status: "problem", problem: "file_too_big" });
    const w2 = passSetup();
    await w2.seedLessons(repoLesson("les_aaaa0001"));
    await w2.enable();
    w2.host.failCalls.add("baseBranchHead");
    expect(await w2.run()).toEqual({ status: "problem", problem: "repository_unreadable" });
    expect(w2.host.writes).toEqual([]);
  });

  it("a host that cannot write is a status, not a crash", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson("les_aaaa0001"));
    await w.enable();
    (w.host as unknown as { commitFiles?: unknown }).commitFiles = undefined;
    expect(await w.run()).toEqual({ status: "problem", problem: "host_cannot_write" });
  });

  it("names that cannot be read hold the week (nothing is written)", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson("les_aaaa0001"));
    await w.enable();
    w.names.throws = true;
    expect(await w.run()).toEqual({ status: "problem", problem: "names_unreadable" });
    expect(w.host.writes).toEqual([]);
  });

  it("two passes never run at once (the lease), and an expired lease does not block", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson("les_aaaa0001"));
    await w.enable({ lease: { holder: "someone-else", until: 1_800_000_000_000 + 60_000 } });
    expect(await w.run()).toEqual({ status: "skipped", reason: "busy" });
    w.clock.advance(5 * 60_000);
    expect(await w.run()).toMatchObject({ status: "opened" });
    expect((await w.current()).lease).toBeUndefined();
  });

  it("nothing left to propose closes Rovara's own stale pull request", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson("les_aaaa0001"));
    await w.enable();
    await w.run();
    const open = (await w.current()).open!;
    const lessons = await w.store.listAllHeads(w.key);
    await w.store.commit(w.key, await w.store.setVersion(w.key), [{ ...lessons[0]!, version: 2, status: "retired" }], 5);
    w.week();
    expect(await w.run()).toEqual({ status: "no_changes" });
    expect(w.host.open).toHaveLength(0);
    expect(w.host.files.has(open.branch)).toBe(false);
    expect((await w.current()).pointerProposed).toBe(false);
  });
});

describe("the pointer", () => {
  it("is added once, to the agent files that exist, with Claude's import line for CLAUDE.md, and never created when another agent file exists", async () => {
    const w = passSetup();
    w.host.setFile("main", "CLAUDE.md", "# Claude notes\n");
    w.host.setFile("main", ".github/copilot-instructions.md", "Be kind.\n");
    await w.seedLessons(repoLesson("les_aaaa0001"));
    await w.enable();
    await w.run();
    const branch = (await w.current()).open!.branch;
    expect(w.host.file(branch, "CLAUDE.md")).toBe("# Claude notes\n\n@.rovara/lessons.md\n");
    expect(w.host.file(branch, ".github/copilot-instructions.md")).toContain("read `.rovara/lessons.md`");
    expect(w.host.file(branch, "AGENTS.md")).toBeUndefined();
  });

  it("a symbolic link is never written to, and a later pull request does not add it again", async () => {
    const w = passSetup();
    w.host.setFile("main", "CLAUDE.md", "# Claude notes\n");
    w.host.kinds.set("AGENTS.md", "symlink");
    await w.seedLessons(repoLesson("les_aaaa0001"));
    await w.enable();
    await w.run();
    const first = (await w.current()).open!;
    expect(w.host.file(first.branch, "AGENTS.md")).toBeUndefined();
    await w.seedLessons(repoLesson("les_aaaa0002"));
    w.host.merge(1);
    w.week();
    await w.run();
    const second = (await w.current()).open!;
    expect(w.host.file(second.branch, "CLAUDE.md")).toBe(w.host.file("main", "CLAUDE.md"));
  });

  it("shows 'pointer missing' once it was proposed and merged and no agent file names the lessons file, and stays quiet if declined", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson("les_aaaa0001"));
    await w.enable();
    await runAndMerge(w);
    w.host.setFile("main", "AGENTS.md", "# Agents\n");
    await w.seedLessons(repoLesson("les_aaaa0002"));
    w.week();
    await w.run();
    expect((await w.current()).pointerMissing).toBe(true);
    expect(w.host.file((await w.current()).open!.branch, "AGENTS.md")).toBe("# Agents\n");
  });
});
