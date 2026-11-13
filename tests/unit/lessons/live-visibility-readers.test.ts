// The answers a reader remembers, and the one deadline of a check.
// -: a reader asked for two viewers never hands one the other's answer;: a failed answer is not remembered.
// -: ONE deadline for a whole check (the audience read and the comparison after it share it); the pull request description's two readers read each source task once.
import { describe, expect, it } from "vitest";
import { createLessonLiveReader } from "../../../packages/lessons/src/live-visibility.js";
import { withLessonAudiences, type LessonAudiencePort, type LessonTaskAudience } from "../../../packages/lessons/src/task-audience.js";
import type { TaskVisibilityPort } from "../../../packages/lessons/src/access-port.js";
import type { Lesson } from "../../../packages/lessons/src/types.js";
import { KEY, lessonRecord, wideAudience } from "./lesson-helpers.js";

const team: TaskVisibilityPort = { read: async () => new Map() };
const portOf = (table: Record<string, LessonTaskAudience | undefined>, delayMs = 0): { port: TaskVisibilityPort; reads: string[][] } => {
  const reads: string[][] = [];
  const audiences: LessonAudiencePort = {
    async read(_org, ids) {
      reads.push([...ids]);
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return new Map(ids.map((id) => [id, table[id]]));
    },
  };
  return { port: withLessonAudiences(team, audiences), reads };
};
const fromTasks = (id: string, tasks: string[]): Lesson =>
  lessonRecord({ id, type: "convention", tier: 1, approvals: [{ approvalId: "ap", by: "ann", at: 1, mode: "one" }], provenance: { ...lessonRecord().provenance, supportTasks: tasks } });
const ids = (lessons: readonly Lesson[]): string[] => lessons.map((lesson) => lesson.id);
const viewerOf = (developerId: string) => ({ developerId });
/** A source task's audience: the owner x by name, and a roster of people the test names. */
const source = (roster: string[], over: Partial<LessonTaskAudience> = {}): LessonTaskAudience =>
  wideAudience({ extras: new Set(["x"]), onRoster: async (person) => roster.includes(person), ...over });

describe("the answers a reader remembers depend on who is reading", () => {
  const lesson = fromTasks("les_viewers01", ["src"]);
  const table = { src: source(["inside"]) };

  it("one reader asked for a person who can open the source task and then for one who cannot: each gets their own answer, in either order", async () => {
    for (const order of [["inside", "outside"], ["outside", "inside"]] as const) {
      const reader = createLessonLiveReader({ port: portOf(table).port, key: KEY, where: "t" });
      const answers: Record<string, string[]> = {};
      for (const who of order) answers[who] = ids(await reader.keep(viewerOf(who), [lesson]));
      expect(answers, order.join(",")).toEqual({ inside: ["les_viewers01"], outside: [] });
    }
  });

  it("a person's answer is not reused for nobody in particular (and the other way round)", async () => {
    // The source task is open to the roster, but a People denial hides it from the project: a person on the roster who is not denied reads it, nobody in particular does not.
    const narrowed = { src: source(["inside"], { denied: new Set(["someone-else"]) }) };
    for (const order of [["person", "nobody"], ["nobody", "person"]] as const) {
      const reader = createLessonLiveReader({ port: portOf(narrowed).port, key: KEY, where: "t" });
      const answers: Record<string, string[]> = {};
      for (const mode of order) answers[mode] = ids(await reader.keep(mode === "person" ? viewerOf("inside") : undefined, [lesson]));
      expect(answers, order.join(",")).toEqual({ person: ["les_viewers01"], nobody: [] });
    }
  });

  it("the same viewer asked twice reads the roster once (the answer is remembered for that viewer)", async () => {
    let rosterReads = 0;
    const counted = { src: source([], { onRoster: async () => { rosterReads += 1; return true; } }) };
    const reader = createLessonLiveReader({ port: portOf(counted).port, key: KEY, where: "t" });
    expect(ids(await reader.keep(viewerOf("inside"), [lesson]))).toEqual(["les_viewers01"]);
    expect(ids(await reader.keep(viewerOf("inside"), [lesson]))).toEqual(["les_viewers01"]);
    expect(rosterReads).toBe(1);
  });
});

describe("a failed answer is not remembered", () => {
  it("a roster read that fails withholds the lesson that time, and the next ask reads again and keeps it", async () => {
    let down = true;
    let calls = 0;
    const flaky = { src: source([], { onRoster: async () => { calls += 1; if (down) throw new Error("down"); return true; } }) };
    const reader = createLessonLiveReader({ port: portOf(flaky).port, key: KEY, where: "t" });
    const lesson = fromTasks("les_flaky0001", ["src"]);
    expect(await reader.keep(viewerOf("inside"), [lesson])).toEqual([]);
    expect(calls).toBe(1);
    down = false;
    expect(ids(await reader.keep(viewerOf("inside"), [lesson]))).toEqual(["les_flaky0001"]);
    expect(calls).toBe(2);
  });
});

describe("one deadline for a whole check", () => {
  // The running task T names w, who must be a person of the source task too; the source task's roster is slow. The audience read takes `STEP` ms and the roster read `STEP` ms: together more than `LIMIT`,
  // each alone less. With a window per step the check passes; with one deadline for the check it is withheld.
  const STEP = 150;
  const LIMIT = 250;
  const slowRoster = (): LessonTaskAudience => source([], { onRoster: async () => { await new Promise((resolve) => setTimeout(resolve, STEP)); return true; } });
  const table = (): Record<string, LessonTaskAudience | undefined> => ({ run: source([], { extras: new Set(["x", "w"]) }), src: slowRoster() });
  const lesson = fromTasks("les_deadline01", ["src"]);

  it("the audience read and the comparison after it share one deadline: together they are cut at the limit", async () => {
    const reader = createLessonLiveReader({ port: portOf(table(), STEP).port, key: KEY, where: "t", running: { taskId: "run" }, timeoutMs: LIMIT });
    expect(await reader.keep(undefined, [lesson])).toEqual([]);
  });

  it("positive control: with room for both steps the same check keeps the lesson", async () => {
    const reader = createLessonLiveReader({ port: portOf(table(), STEP).port, key: KEY, where: "t", running: { taskId: "run" }, timeoutMs: 4 * STEP });
    expect(ids(await reader.keep(undefined, [lesson]))).toEqual(["les_deadline01"]);
  });

  it("a caller's own deadline (a function) still caps the check", async () => {
    const reader = createLessonLiveReader({ port: portOf(table(), STEP).port, key: KEY, where: "t", running: { taskId: "run" }, timeoutMs: () => 60 });
    expect(await reader.keep(undefined, [lesson])).toEqual([]);
  });

  it("each check gets its own deadline: a second keep on the same reader is not starved by the first", async () => {
    const reader = createLessonLiveReader({ port: portOf(table(), 10).port, key: KEY, where: "t", running: { taskId: "run" }, timeoutMs: 1_000 });
    expect(ids(await reader.keep(undefined, [lesson]))).toEqual(["les_deadline01"]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ids(await reader.keep(undefined, [lesson]))).toEqual(["les_deadline01"]);
  });
});

describe("the pull request's two readers read each source task once", () => {
  it("withoutRunningTask shares the audiences already read: the running task and every source task are read in ONE batch, and the nobody reader reads nothing more", async () => {
    const p = portOf({ run: source([]), a: source([]), b: source([]) });
    const counting = createLessonLiveReader({ port: p.port, key: KEY, where: "pull_request", running: { taskId: "run" } });
    const wide = counting.withoutRunningTask();
    const lessons = [fromTasks("les_prone0001", ["a"]), fromTasks("les_prtwo0001", ["a", "b"])];
    expect(ids(await counting.keep(undefined, lessons))).toEqual(["les_prone0001", "les_prtwo0001"]);
    expect(ids(await wide.keep(undefined, lessons))).toEqual(["les_prone0001", "les_prtwo0001"]);
    expect(p.reads).toEqual([["run", "a", "b"]]);
  });

  it("the nobody reader keeps its own rule: a source task with a People denial is not kept by it, though the running reader keeps it", async () => {
    const p = portOf({ run: source([]), a: source([], { denied: new Set(["z"]) }) });
    const running = createLessonLiveReader({ port: p.port, key: KEY, where: "pull_request", running: { taskId: "run" } });
    const lesson = fromTasks("les_prdeny001", ["a"]);
    // run does not deny z, a does: z could open the running task but not the source task, so the running reader refuses too.
    expect(await running.keep(undefined, [lesson])).toEqual([]);
    const p2 = portOf({ run: source([], { denied: new Set(["z"]) }), a: source([], { denied: new Set(["z"]) }) });
    const running2 = createLessonLiveReader({ port: p2.port, key: KEY, where: "pull_request", running: { taskId: "run" } });
    expect(ids(await running2.keep(undefined, [lesson]))).toEqual(["les_prdeny001"]);
    expect(await running2.withoutRunningTask().keep(undefined, [lesson])).toEqual([]);
    expect(p2.reads).toEqual([["run", "a"]]);
  });
});
