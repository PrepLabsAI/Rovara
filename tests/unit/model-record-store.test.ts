// TE-F8: the recording store seam (O35 phase A). Expiry, company scoping, limits, erase, crash sweep, file modes and links, the placement table, the labels and the evidence seam.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RECORDING_ANSWER_BYTES_MAX, RECORDING_REPO_WARNING, RECORDING_ROVARA_STORAGE_WARNING, RECORDING_STORE_TASK_CACHE, RECORDING_STORE_WORDS, RECORDING_TASK_ENTRIES_MAX, RECORDING_TTL_MS_DEFAULT, RECORDING_TTL_MS_MAX, RECORDING_UNAVAILABLE_ACTION, RECORDING_UNAVAILABLE_SENTENCE,
  checkRecordingScope, createMemoryRecordingStore, entryFromFileText, recordedDependencyFor, recordedLabel, recordingPlacement, shortDayOf, type RecordingEntry, type RecordingScope, type RecordingStore,
} from "@agentx/contracts";
import { createTaskRecordingStore, recordingCompanyDirName, recordingTaskDirName } from "../../packages/worker/src/model-record-store-task.js";
import { COMPANY_A, COMPANY_B, DAY_MS, T0 } from "./model-record-support.js";

const keyN = (n: number): string => n.toString(16).padStart(64, "0");
const A: RecordingScope = { companyId: COMPANY_A.orgId, taskId: "task-1" };
const B: RecordingScope = { companyId: COMPANY_B.orgId, taskId: "task-1" };
const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

function entry(n: number, over: Partial<RecordingEntry> = {}, now = T0): RecordingEntry {
  return {
    key: keyN(n), family: "openai_compatible", row: "openai", itemIds: [keyN(1000 + n)], recordedOn: "2026-11-13", recordedAtMs: now, expiresAtMs: now + RECORDING_TTL_MS_DEFAULT, replayCount: 0,
    answer: { status: 200, headers: [["content-type", "application/json"]], chunks: [enc("one"), enc("two")], settle: { status: 200, class: "ok", inputTokens: 3, outputTokens: 4, costMicros: 7, estimated: false } },
    ...over,
  };
}

let dirs: string[] = [];
const clock = { now: T0 };
const tempRoot = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "f8-store-"));
  dirs.push(dir);
  return dir;
};
beforeEach(() => {
  clock.now = T0;
});
afterEach(() => {
  for (const dir of dirs) {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // gone
    }
    rmSync(dir, { recursive: true, force: true });
  }
  dirs = [];
});

describe.each(["memory", "file"])("the %s store keeps the seam's rules", (kind) => {
  let store: RecordingStore;
  beforeEach(() => {
    store = kind === "memory" ? createMemoryRecordingStore({ now: () => clock.now }) : createTaskRecordingStore({ root: join(tempRoot(), "recordings"), now: () => clock.now });
  });

  it("holds what was put, byte for byte, with its chunk boundaries, and says so in the index", async () => {
    await store.put(A, entry(1));
    const got = (await store.get(A, keyN(1)))!;
    expect(got.answer.chunks.map((chunk) => new TextDecoder().decode(chunk))).toEqual(["one", "two"]);
    expect(got.answer.settle).toEqual(entry(1).answer.settle);
    expect(await store.list(A)).toEqual([{ key: keyN(1), itemIds: [keyN(1001)], recordedOn: "2026-11-13", expiresAtMs: T0 + RECORDING_TTL_MS_DEFAULT, replayCount: 0, bytes: 6 }]);
    expect(await store.get(A, keyN(2))).toBeUndefined();
  });

  it("keeps two companies apart even with the same task id and the same key", async () => {
    await store.put(A, entry(1, { itemIds: [keyN(7)] }));
    expect(await store.get(B, keyN(1))).toBeUndefined();
    expect(await store.list(B)).toEqual([]);
    await store.put(B, entry(1, { answer: { ...entry(1).answer, chunks: [enc("B-only")] } }));
    expect(new TextDecoder().decode((await store.get(A, keyN(1)))!.answer.chunks[0])).toBe("one");
    expect(new TextDecoder().decode((await store.get(B, keyN(1)))!.answer.chunks[0])).toBe("B-only");
  });

  it("keeps two tasks of one company apart", async () => {
    await store.put(A, entry(1));
    expect(await store.get({ ...A, taskId: "task-2" }, keyN(1))).toBeUndefined();
  });

  it("never returns an expired entry, and drops it", async () => {
    await store.put(A, entry(1));
    clock.now = T0 + RECORDING_TTL_MS_DEFAULT + 1;
    expect(await store.get(A, keyN(1))).toBeUndefined();
    expect(await store.list(A)).toEqual([]);
    expect(await store.markReplayed(A, keyN(1))).toBe(0);
  });

  it.each([
    ["no expiry (already past)", { expiresAtMs: T0 }],
    ["an expiry that is not a whole number", { expiresAtMs: Number.NaN }],
    ["an expiry more than a week out", { expiresAtMs: T0 + RECORDING_TTL_MS_MAX + 1 }],
    ["a key that is not a hash", { key: "../../etc/passwd" }],
    ["an answer that is not a success", { answer: { ...entry(1).answer, status: 500 } }],
  ])("refuses an entry with %s", async (_name, over) => {
    await expect(store.put(A, entry(1, over as Partial<RecordingEntry>))).rejects.toThrow(/recording refused/u);
    expect(await store.list(A)).toEqual([]);
  });

  it("refuses an answer over the size limit, and a task over its entry limit, but not an overwrite at the limit", async () => {
    await expect(store.put(A, entry(1, { answer: { ...entry(1).answer, chunks: [new Uint8Array(RECORDING_ANSWER_BYTES_MAX + 1)] } }))).rejects.toThrow(/too_large/u);
    for (let n = 1; n <= RECORDING_TASK_ENTRIES_MAX; n += 1) await store.put(A, entry(n));
    await expect(store.put(A, entry(RECORDING_TASK_ENTRIES_MAX + 1))).rejects.toThrow(/too_many/u);
    await store.put(A, entry(1));
    expect(await store.list(A)).toHaveLength(RECORDING_TASK_ENTRIES_MAX);
  });

  it("counts replays", async () => {
    await store.put(A, entry(1));
    expect(await store.markReplayed(A, keyN(1))).toBe(1);
    expect(await store.markReplayed(A, keyN(1))).toBe(2);
    expect((await store.list(A))[0]!.replayCount).toBe(2);
    expect(await store.markReplayed(B, keyN(1))).toBe(0);
  });

  it("deletes a task's recordings and no other task's, then a company's all", async () => {
    await store.put(A, entry(1));
    await store.put(A, entry(2));
    await store.put({ ...A, taskId: "task-2" }, entry(3));
    await store.put(B, entry(4));
    expect(await store.deleteTask(A)).toBe(2);
    expect(await store.list(A)).toEqual([]);
    expect(await store.list({ ...A, taskId: "task-2" })).toHaveLength(1);
    expect(await store.eraseCompany(COMPANY_A.orgId)).toBe(1);
    expect(await store.list({ ...A, taskId: "task-2" })).toEqual([]);
    expect(await store.list(B)).toHaveLength(1);
    expect(await store.deleteTask(A)).toBe(0);
  });

  it("sweeps what is expired and nothing else", async () => {
    await store.put(A, entry(1, { expiresAtMs: T0 + 1000 }));
    await store.put(A, entry(2));
    clock.now = T0 + 2000;
    expect(await store.sweep()).toBe(1);
    expect((await store.list(A)).map((row) => row.key)).toEqual([keyN(2)]);
    expect(await store.sweep()).toBe(0);
  });

  it("a replay-count update does not extend the life of an entry", async () => {
    await store.put(A, entry(1));
    clock.now = T0 + RECORDING_TTL_MS_DEFAULT - 10;
    await store.markReplayed(A, keyN(1));
    clock.now = T0 + RECORDING_TTL_MS_DEFAULT + 10;
    expect(await store.get(A, keyN(1))).toBeUndefined();
  });
});

describe("the task file store on disk", () => {
  let root: string;
  let store: RecordingStore;
  const fileOf = (scope: RecordingScope, n: number): string => join(root, recordingCompanyDirName(scope.companyId), recordingTaskDirName(scope.taskId), `${keyN(n)}.rec`);
  const mode = (path: string): number => statSync(path).mode & 0o777;
  beforeEach(() => {
    root = join(tempRoot(), "recordings");
    store = createTaskRecordingStore({ root, now: () => clock.now });
  });

  it("writes files 0600 and directories 0700, and puts nothing outside its root", async () => {
    await store.put(A, entry(1));
    expect(mode(fileOf(A, 1))).toBe(0o600);
    for (const dir of [root, join(root, recordingCompanyDirName(A.companyId)), join(root, recordingCompanyDirName(A.companyId), recordingTaskDirName(A.taskId))]) expect(mode(dir)).toBe(0o700);
    expect(readdirSync(join(root, ".."))).toEqual(["recordings"]);
  });

  it("writes 0600 whatever the process umask is, and leaves no temp file behind", async () => {
    let previous: number | undefined;
    try {
      previous = process.umask(0);
    } catch {
      previous = undefined; // a worker thread cannot change the umask: the 0600 test above still holds
    }
    try {
      await store.put(A, entry(1));
      expect(mode(fileOf(A, 1))).toBe(0o600);
      expect(mode(join(root, recordingCompanyDirName(A.companyId)))).toBe(0o700);
      // A umask that takes owner bits away would leave the file at 0400 if the mode were not set on the open handle.
      if (previous !== undefined) {
        process.umask(0o277);
        await store.put(A, entry(2));
        expect(mode(fileOf(A, 2))).toBe(0o600);
      }
    } finally {
      if (previous !== undefined) process.umask(previous);
    }
    expect(readdirSync(join(root, recordingCompanyDirName(A.companyId), recordingTaskDirName(A.taskId))).every((name) => name.endsWith(".rec"))).toBe(true);
  });

  it("names directories by hash: the same task id under two companies is two directories, and ids that differ only by case do not merge", async () => {
    const lower: RecordingScope = { companyId: "org_Case", taskId: "t" };
    const upper: RecordingScope = { companyId: "org_case", taskId: "t" };
    await store.put(lower, entry(1));
    await store.put(upper, entry(1, { answer: { ...entry(1).answer, chunks: [enc("upper")] } }));
    expect(recordingCompanyDirName(lower.companyId)).not.toBe(recordingCompanyDirName(upper.companyId));
    expect(new TextDecoder().decode((await store.get(lower, keyN(1)))!.answer.chunks[0])).toBe("one");
    expect(readdirSync(root).every((name) => /^[a-f0-9]{64}$/u.test(name))).toBe(true);
  });

  it("refuses a scope whose id could become a path", async () => {
    for (const bad of [{ companyId: "../x", taskId: "t" }, { companyId: "c", taskId: "a/b" }, { companyId: "", taskId: "t" }, { companyId: "c", taskId: "t".repeat(200) }]) {
      await expect(store.put(bad, entry(1))).rejects.toThrow(/scope/u);
      await expect(store.get(bad, keyN(1))).rejects.toThrow(/scope/u);
    }
    expect(checkRecordingScope({ companyId: "c", taskId: "t" })).toEqual({ companyId: "c", taskId: "t" });
    expect(checkRecordingScope(Object.defineProperty({}, "companyId", { get: () => { throw new Error("x"); } }))).toBeUndefined();
  });

  it("does not follow a link: the link is removed and its target is left alone", async () => {
    await store.put(A, entry(1));
    const outside = join(tempRoot(), "outside.txt");
    writeFileSync(outside, readFileSync(fileOf(A, 1)), { mode: 0o600 });
    rmSync(fileOf(A, 1));
    symlinkSync(outside, fileOf(A, 1));
    expect(await store.get(A, keyN(1))).toBeUndefined();
    expect(existsSync(fileOf(A, 1))).toBe(false);
    expect(existsSync(outside)).toBe(true);
  });

  it("distrusts a file with group or world bits, a corrupt file, and a file that is not an entry", async () => {
    await store.put(A, entry(1));
    chmodSync(fileOf(A, 1), 0o644);
    expect(await store.get(A, keyN(1))).toBeUndefined();
    expect(existsSync(fileOf(A, 1))).toBe(false);
    await store.put(A, entry(2));
    writeFileSync(fileOf(A, 2), "{ not json", { mode: 0o600 });
    expect(await store.get(A, keyN(2))).toBeUndefined();
    await store.put(A, entry(3));
    writeFileSync(fileOf(A, 3), JSON.stringify({ version: 1, extra: true }), { mode: 0o600 });
    expect(await store.list(A)).toEqual([]);
  });

  it("an entry copied into another company's directory is a miss there (its own header names its owner)", async () => {
    await store.put(A, entry(1));
    mkdirSync(join(root, recordingCompanyDirName(B.companyId), recordingTaskDirName(B.taskId)), { recursive: true });
    writeFileSync(fileOf(B, 1), readFileSync(fileOf(A, 1)), { mode: 0o600 });
    expect(await store.get(B, keyN(1))).toBeUndefined();
    expect(await store.get(A, keyN(1))).toBeDefined();
  });

  it("sweeps a crash's leftovers: expired entries, stale temp files, empty directories; keeps live entries, a young temp file and files it does not own", async () => {
    await store.put(A, entry(1, { expiresAtMs: T0 + 1000 }));
    await store.put(A, entry(2));
    await store.put(B, entry(3, { expiresAtMs: T0 + 1000 }));
    const taskDir = join(root, recordingCompanyDirName(A.companyId), recordingTaskDirName(A.taskId));
    const stale = join(taskDir, `${keyN(9)}.rec.${"a".repeat(16)}.tmp`);
    const young = join(taskDir, `${keyN(8)}.rec.${"b".repeat(16)}.tmp`);
    const foreign = join(taskDir, "notes.txt");
    for (const path of [stale, young, foreign]) writeFileSync(path, "x", { mode: 0o600 });
    const old = new Date(T0 + 2000 - 10 * 60 * 1000);
    utimesSync(stale, old, old);
    const fresh = new Date(T0 + 2000);
    utimesSync(young, fresh, fresh);
    clock.now = T0 + 2000;
    expect(await store.sweep()).toBe(3);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(young) && existsSync(foreign)).toBe(true);
    expect((await store.list(A)).map((row) => row.key)).toEqual([keyN(2)]);
    expect(existsSync(join(root, recordingCompanyDirName(B.companyId)))).toBe(false);
  });

  it("markReplayed never brings a deleted task back", async () => {
    await store.put(A, entry(1));
    await store.deleteTask(A);
    expect(await store.markReplayed(A, keyN(1))).toBe(0);
    expect(existsSync(join(root, recordingCompanyDirName(A.companyId), recordingTaskDirName(A.taskId)))).toBe(false);
    // And one racing a delete: the entry was read, the directory goes, the rewrite fails and recreates nothing.
    await store.put(A, entry(2));
    const pending = store.markReplayed(A, keyN(2));
    await store.deleteTask(A);
    await pending;
    expect(existsSync(join(root, recordingCompanyDirName(A.companyId), recordingTaskDirName(A.taskId)))).toBe(false);
  });

  it("will not write into, or read from, a directory or file owned by someone else", async () => {
    await store.put(A, entry(1));
    const real = process.getuid!();
    const spy = vi.spyOn(process, "getuid").mockReturnValue(real + 1);
    try {
      await expect(store.put(A, entry(2))).rejects.toThrow(/not a directory of ours/u);
      expect(await store.get(A, keyN(1))).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it("sweep removes an empty directory but never a directory that is not empty", async () => {
    await store.put(A, entry(1, { expiresAtMs: T0 + 1000 }));
    const taskDir = join(root, recordingCompanyDirName(A.companyId), recordingTaskDirName(A.taskId));
    writeFileSync(join(taskDir, "keep-me.txt"), "not ours", { mode: 0o600 });
    clock.now = T0 + 2000;
    await store.sweep();
    expect(existsSync(join(taskDir, "keep-me.txt"))).toBe(true);
    rmSync(join(taskDir, "keep-me.txt"));
    await store.sweep();
    expect(existsSync(taskDir)).toBe(false);
  });

  it("a root that does not exist yet is fine for list, delete and sweep (nothing recorded)", async () => {
    const fresh = createTaskRecordingStore({ root: join(tempRoot(), "never-made"), now: () => clock.now });
    expect(await fresh.list(A)).toEqual([]);
    expect(await fresh.deleteTask(A)).toBe(0);
    expect(await fresh.eraseCompany(A.companyId)).toBe(0);
    expect(await fresh.sweep()).toBe(0);
  });

  it("task end removes the directory, so nothing of the task is left on disk", async () => {
    await store.put(A, entry(1));
    await store.deleteTask(A);
    expect(existsSync(join(root, recordingCompanyDirName(A.companyId), recordingTaskDirName(A.taskId)))).toBe(false);
  });

  it("reads a file written in today's format (a golden), and ignores nothing else", () => {
    const golden = JSON.stringify({
      version: 1, companyId: "org_x", taskId: "t", key: keyN(5), family: "gemini", row: "gemini", itemIds: [keyN(6)], recordedOn: "2026-11-13", recordedAtMs: T0, expiresAtMs: T0 + DAY_MS, replayCount: 2,
      answer: { status: 200, headers: [["content-type", "application/json"]], chunks: [Buffer.from("hi").toString("base64")], settle: { status: 200, class: "ok", costMicros: 0, estimated: false } },
    });
    const parsed = entryFromFileText(golden)!;
    expect(parsed.scope).toEqual({ companyId: "org_x", taskId: "t" });
    expect(new TextDecoder().decode(parsed.entry.answer.chunks[0])).toBe("hi");
    expect(entryFromFileText(golden.replace('"version":1', '"version":2'))).toBeUndefined();
    expect(entryFromFileText(golden.replace('"estimated":false', '"estimated":false,"x":1'))).toBeUndefined();
  });
});

describe("the placement table (O35)", () => {
  it("laptop: a local file, never uploaded", () => {
    expect(recordingPlacement({ laptop: true, cloudAccountConnected: true }).primary).toEqual({ store: "local_file", isDefault: true });
  });
  it("a connected cloud account: the customer's bucket by default; admin opt-ins only as alternatives with their warnings", () => {
    const placement = recordingPlacement({ cloudAccountConnected: true, adminAllowsRovaraStorage: true, adminAllowsRepoStorage: true });
    expect(placement.primary).toEqual({ store: "customer_bucket", isDefault: true });
    expect(placement.alternatives.map((choice) => choice.store)).toEqual(["rovara", "repo"]);
    expect(placement.alternatives).toEqual([
      { store: "rovara", isDefault: false, adminOptIn: true, warning: RECORDING_ROVARA_STORAGE_WARNING },
      { store: "repo", isDefault: false, adminOptIn: true, warning: RECORDING_REPO_WARNING },
    ]);
    expect(RECORDING_REPO_WARNING).toMatch(/git history forever/u);
  });
  it("no bucket but an admin opt-in: that opt-in, with its warning, never as a default", () => {
    expect(recordingPlacement({ adminAllowsRovaraStorage: true }).primary).toMatchObject({ store: "rovara", isDefault: false, adminOptIn: true });
    expect(recordingPlacement({ adminAllowsRepoStorage: true }).primary).toMatchObject({ store: "repo", isDefault: false, adminOptIn: true });
  });
  it("neither: unavailable, in the exact words", () => {
    expect(recordingPlacement({}).primary).toEqual({ store: "unavailable", isDefault: false, sentence: "Connect a bucket, or ask your admin", action: "send to admin" });
    expect(RECORDING_UNAVAILABLE_SENTENCE).toBe("Connect a bucket, or ask your admin");
    expect(RECORDING_UNAVAILABLE_ACTION).toBe("send to admin");
  });
  it("phase A works whatever the placement is", () => {
    for (const settings of [{}, { laptop: true }, { cloudAccountConnected: true }]) expect(recordingPlacement(settings).phaseA).toBe("task_cache");
  });
});

describe("the label and the evidence seam", () => {
  it("says 'Recorded on <day>' and never 'Real'", () => {
    expect(recordedLabel("2026-11-13")).toBe("Recorded on 13 Nov (this task)");
    expect(recordedLabel("2026-11-03", "project")).toBe("Recorded on 3 Nov");
    expect(recordedLabel("not-a-date")).toBe("Recorded (this task)");
    expect(shortDayOf("2026-13-01")).toBeUndefined();
    expect(shortDayOf("2026-11-32")).toBeUndefined();
  });
  it("recordedDependencyFor gives the v2 dependency fields: trust `recorded`, the day, the store word", () => {
    const fields = recordedDependencyFor({ recordedOn: "2026-11-13" });
    expect(fields).toEqual({ trust: "recorded", recordedOn: "2026-11-13", recording: { store: "task_cache", recordedOn: "2026-11-13" }, labelText: "Recorded on 13 Nov (this task)" });
    expect(JSON.stringify(fields)).not.toMatch(/real/iu);
    expect(recordedDependencyFor({ store: "customer_bucket", recordedOn: "2026-11-13" })?.labelText).toBe("Recorded on 13 Nov");
  });
  it("gives nothing when the summary has no usable day: no today, no 1970, no invented date", () => {
    expect(recordedDependencyFor({})).toBeUndefined();
    expect(recordedDependencyFor({ recordedOn: "garbage" })).toBeUndefined();
    expect(recordedDependencyFor({ recordedOn: "2026-13-40" })).toBeUndefined();
    expect(recordedDependencyFor({ store: "task_cache" })).toBeUndefined();
  });
  it("adds its word to the four evidence store words, additively", () => {
    expect(RECORDING_STORE_TASK_CACHE).toBe("task_cache");
    expect([...RECORDING_STORE_WORDS].sort()).toEqual(["customer_bucket", "local_file", "repo", "rovara", "task_cache"]);
  });
});
