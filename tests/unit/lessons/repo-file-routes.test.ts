// The status, the maintainer's switches (audited first), the route layer, and the nightly job that runs the weekly pass without a new schedule.
import { afterEach, describe, expect, it } from "vitest";
import { setLearnedLessonsGate } from "../../../packages/core/src/lessons/policy.js";
import { lessonsRepoFileJob, type RepoFileRuntime } from "../../../packages/core/src/lessons/repo-file-job.js";
import { repoFileAction, repoFileStatus } from "../../../packages/core/src/lessons/repo-file-routes.js";
import { newRepoFileState } from "../../../packages/core/src/lessons/repo-file-state.js";
import { PLACE, WS, passSetup, repoLesson } from "./repo-file-helpers.js";

afterEach(() => { setLearnedLessonsGate(() => true); });
const runtimeOf = (w: ReturnType<typeof passSetup>, over: Partial<RepoFileRuntime> = {}): RepoFileRuntime => ({ deps: w.deps, targets: async () => [w.target], newHolder: () => "job-1", ...over });
const KEY = { workspaceId: WS, project: "proj-1" };

describe("status", () => {
  it("lists the switched-on repositories with their notices, the repositories still available, and says when lessons are off", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson("les_aaaa0001"));
    expect(await repoFileStatus(runtimeOf(w), KEY)).toEqual({ lessonsOff: false, canEnable: true, repos: [], available: ["api"] });
    await w.enable({ unmerged: 3 });
    const status = await repoFileStatus(runtimeOf(w), KEY);
    expect(status.repos[0]).toMatchObject({ repo: "api", enabled: true, additionsPaused: true, notices: ["Rovara has paused new lessons until a lessons PR is merged; 0 removals are waiting"] });
    expect(status.available).toEqual([]);
    const off = passSetup({ mode: "Off" });
    expect((await repoFileStatus(runtimeOf(off), KEY)).lessonsOff).toBe(true);
    (w.host as unknown as { commitFiles?: unknown }).commitFiles = undefined;
    expect(await repoFileStatus(runtimeOf(w), KEY)).toMatchObject({ canEnable: false });
  });

  it("shows a repository that left the project as such", async () => {
    const w = passSetup();
    await w.enable();
    const status = await repoFileStatus(runtimeOf(w, { targets: async () => [] }), KEY);
    expect(status.repos[0]).toMatchObject({ problem: "repository_gone" });
  });
});

describe("the switches", () => {
  it("turning on is audited BEFORE it changes anything, and a ledger that is down changes nothing", async () => {
    const w = passSetup();
    w.failAudit.on = true;
    expect(await repoFileAction(runtimeOf(w), KEY, { action: "on", repo: "api" })).toEqual({ ok: false, code: "audit_unavailable" });
    expect(await w.state.get(w.key, PLACE)).toBeUndefined();
    w.failAudit.on = false;
    const on = await repoFileAction(runtimeOf(w), KEY, { action: "on", repo: "api", pointers: ["CLAUDE.md"] });
    expect(on).toMatchObject({ ok: true, row: { enabled: true } });
    expect(w.audit.events.map((e) => [e.action, e.facts])).toEqual([["lesson.repo_file_switched", { enabled: true }]]);
    expect((await w.current()).pointers).toEqual(["CLAUDE.md"]);
    // Again is a no-op.
    await repoFileAction(runtimeOf(w), KEY, { action: "on", repo: "api" });
    expect(w.audit.events).toHaveLength(1);
  });

  it("turning on while lessons are off still records the choice (watch rows, state, audit) with no host call, and says what it waits for", async () => {
    const cases = [
      { name: "install switch off", w: () => { const w = passSetup(); setLearnedLessonsGate(() => false); return w; }, waitingFor: "install" },
      { name: "install switch unreadable", w: () => { const w = passSetup(); setLearnedLessonsGate(() => { throw new Error("unreadable"); }); return w; }, waitingFor: "install" },
      { name: "project mode off", w: () => passSetup({ mode: "Off" }), waitingFor: "project" },
    ] as const;
    for (const c of cases) {
      const w = c.w();
      const on = await repoFileAction(runtimeOf(w), KEY, { action: "on", repo: "api" });
      expect(on, c.name).toMatchObject({ ok: true, row: { repo: "api", enabled: true, waitingFor: c.waitingFor } });
      expect(w.audit.events.map((e) => [e.action, e.facts]), c.name).toEqual([["lesson.repo_file_switched", { enabled: true }]]);
      expect((await w.state.get(KEY, PLACE))?.enabled, c.name).toBe(true);
      expect((await w.state.listPrs(KEY)).rows.filter((r) => r.kind === "watch").length, c.name).toBe(1);
      expect(w.host.calls, c.name).toEqual([]);
      expect(w.host.writes, c.name).toEqual([]);
      // Switching on again, and the status, say the same thing.
      expect(await repoFileAction(runtimeOf(w), KEY, { action: "on", repo: "api" }), c.name).toMatchObject({ ok: true, row: { waitingFor: c.waitingFor } });
      expect((await repoFileStatus(runtimeOf(w), KEY)).repos[0], c.name).toMatchObject({ enabled: true, waitingFor: c.waitingFor });
      setLearnedLessonsGate(() => true);
    }
  });

  it("turning on while lessons are on carries no waiting note, in the answer or the status", async () => {
    const w = passSetup({ mode: "On" });
    const on = await repoFileAction(runtimeOf(w), KEY, { action: "on", repo: "api" });
    expect(on).toMatchObject({ ok: true, row: { enabled: true } });
    expect(on.ok && "waitingFor" in on.row).toBe(false);
    expect("waitingFor" in (await repoFileStatus(runtimeOf(w), KEY)).repos[0]!).toBe(false);
  });

  it("refuses an unknown repository and a host that cannot write", async () => {
    const w = passSetup();
    expect(await repoFileAction(runtimeOf(w), KEY, { action: "on", repo: "nope" })).toEqual({ ok: false, code: "not_found" });
    (w.host as unknown as { deleteBranch?: unknown }).deleteBranch = undefined;
    expect(await repoFileAction(runtimeOf(w), KEY, { action: "on", repo: "api" })).toEqual({ ok: false, code: "host_cannot_write" });
    expect(await repoFileAction(runtimeOf(w), KEY, { action: "off", repo: "api" })).toEqual({ ok: false, code: "not_found" });
  });

  it("turning off closes Rovara's open pull request and deletes its branch, leaves the merged file, and proposes nothing more", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson("les_aaaa0001"));
    await w.enable();
    await w.run();
    const open = (await w.current()).open!;
    const result = await repoFileAction(runtimeOf(w), KEY, { action: "off", repo: "api" });
    expect(result).toMatchObject({ ok: true, row: { enabled: false } });
    expect(w.host.open).toHaveLength(0);
    expect(w.host.files.has(open.branch)).toBe(false);
    expect((await w.current()).open).toBeUndefined();
    expect(w.audit.actions()).toContain("lesson.repo_file_pr_closed");
    w.week();
    expect(await w.run()).toEqual({ status: "skipped", reason: "not_enabled" });
  });

  it("turning off leaves a pull request a person pushed to alone", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson("les_aaaa0001"));
    await w.enable();
    await w.run();
    const open = (await w.current()).open!;
    w.host.setFile(open.branch, "notes.txt", "a person's commit");
    await repoFileAction(runtimeOf(w), KEY, { action: "off", repo: "api" });
    expect(w.host.open).toHaveLength(1);
    expect(w.host.files.has(open.branch)).toBe(true);
    expect((await w.current()).open).toBeUndefined();
  });

  it("resume starts again after the team deleted the file; the pointer answers are remembered", async () => {
    const w = passSetup();
    await w.enable({ fileDeleted: true, fileSeen: true, pointerProposed: true, pointerMissing: true, rendered: { les_aaaa0001: "x:y" } });
    expect(await repoFileAction(runtimeOf(w), KEY, { action: "resume", repo: "api" })).toMatchObject({ ok: true, row: { fileDeleted: false } });
    expect((await w.current()).fileSeen).toBe(false);
    expect(await repoFileAction(runtimeOf(w), KEY, { action: "pointer_add", repo: "api" })).toMatchObject({ ok: true });
    expect(await w.current()).toMatchObject({ pointerProposed: false, pointerMissing: false });
    expect(await repoFileAction(runtimeOf(w), KEY, { action: "pointer_decline", repo: "api" })).toMatchObject({ ok: true, row: { pointer: "declined" } });
  });
});

describe("the nightly job", () => {
  it("does nothing, and asks the host nothing, for a project with no switched-on repository", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson("les_aaaa0001"));
    let asked = 0;
    const counts = await lessonsRepoFileJob(runtimeOf(w, { targets: async () => { asked += 1; return [w.target]; } }), WS, ["proj-1"], 10_000, 0);
    expect(counts).toMatchObject({ repoFilePrsOpened: 0 });
    expect(asked).toBe(0);
    expect(w.host.calls).toEqual([]);
  });

  it("opens the weekly pull request for a switched-on repository once, then leaves it for a week, and counts only", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson("les_aaaa0001"));
    await w.enable();
    expect(await lessonsRepoFileJob(runtimeOf(w), WS, ["proj-1"], 10_000, 3)).toMatchObject({ repoFilePrsOpened: 1 });
    w.clock.advance(86_400_000);
    expect(await lessonsRepoFileJob(runtimeOf(w), WS, ["proj-1"], 10_000, 4)).toMatchObject({ repoFilePrsOpened: 0 });
    expect(w.host.prs).toHaveLength(1);
  });

  it("a failing project does not stop the others, a repository that left is counted, and a switched-off one still finishes its closing", async () => {
    const w = passSetup();
    await w.enable({ closing: [{ branch: "rovara/lessons-0000000000aa", cause: "switched_off" }], pointers: undefined });
    const stray = w.host.setFile("rovara/lessons-0000000000aa", "x", "y");
    const state = await w.current();
    await w.state.put(KEY, { ...state, closing: [{ branch: "rovara/lessons-0000000000aa", cause: "switched_off", headRevision: stray }] }, state.revision);
    await w.state.put(KEY, { ...(await w.current()), enabled: false }, (await w.current()).revision);
    const counts = await lessonsRepoFileJob(runtimeOf(w, { targets: async (_ws, project) => { if (project === "bad") throw new Error("boom"); return [w.target]; } }), WS, ["bad", "proj-1"], 10_000, 0);
    expect(counts.repoFileFailures).toBe(0);
    expect(w.host.files.has("rovara/lessons-0000000000aa")).toBe(false);
    const latest = await w.current();
    await w.state.put(KEY, { ...latest, enabled: true }, latest.revision);
    const gone = await lessonsRepoFileJob(runtimeOf(w, { targets: async () => [] }), WS, ["proj-1"], 10_000, 0);
    expect(gone).toMatchObject({ repoFileProblems: 1 });
    expect(newRepoFileState(PLACE, "api").enabled).toBe(false);
  });

  it("stops at its time budget", async () => {
    const w = passSetup();
    await w.enable();
    const counts = await lessonsRepoFileJob(runtimeOf(w), WS, ["proj-1"], -1, 0);
    expect(counts.repoFileSkipped).toBe(2); // the sweep and the publish pass each skip the project
    expect(w.host.calls).toEqual([]);
  });
});

describe("an erased lesson that is only in the open pull request comes out at once", () => {
  it("closes Rovara's open pull request and deletes its branch (audited first), so the text never reaches the default branch; the next pass opens a fresh one without it", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson("les_aaaa0001"), repoLesson("les_aaaa0002"));
    await w.enable();
    await w.run();
    const open = (await w.current()).open!;
    // The lesson is erased in Rovara.
    const erased = (await w.store.listAllHeads(w.key)).find((l) => l.id === "les_aaaa0002")!;
    await w.store.commit(w.key, await w.store.setVersion(w.key), [{ ...erased, version: 2, status: "withdrawn" }], 9);
    await w.store.markGone(w.key, "les_aaaa0002", "withdrawn");
    const { closeOpenPullRequestFor } = await import("../../../packages/core/src/lessons/repo-file-routes.js");
    await closeOpenPullRequestFor(runtimeOf(w), w.key, "les_aaaa0002");
    expect(w.host.open).toHaveLength(0);
    expect(w.host.files.has(open.branch)).toBe(false);
    expect(w.audit.events.at(-1)).toMatchObject({ action: "lesson.repo_file_pr_closed", facts: { cause: "erased" } });
    expect(w.host.file("main", ".rovara/lessons.md")).toBeUndefined();
    // The next weekly pass sees its pull request closed and rebuilds without the lesson.
    w.week();
    expect(await w.run()).toMatchObject({ status: "opened", adds: 1 });
    expect(Object.keys((await w.current()).open!.added)).toEqual(["les_aaaa0001"]);
  });

  it("does nothing for a lesson the open pull request does not carry; a pull request a person pushed to is closed (their commits and branch stay)", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson("les_aaaa0001"));
    await w.enable();
    await w.run();
    const open = (await w.current()).open!;
    const { closeOpenPullRequestFor } = await import("../../../packages/core/src/lessons/repo-file-routes.js");
    await closeOpenPullRequestFor(runtimeOf(w), w.key, "les_other0001");
    expect(w.host.open).toHaveLength(1);
    w.host.setFile(open.branch, "notes.txt", "a person's commit");
    await w.store.markGone(w.key, "les_aaaa0001", "withdrawn");
    await closeOpenPullRequestFor(runtimeOf(w), w.key, "les_aaaa0001");
    expect(w.host.open).toHaveLength(0);
    expect(w.host.files.has(open.branch)).toBe(true);
  });
});
