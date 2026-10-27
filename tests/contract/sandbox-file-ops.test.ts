// the file-tool helper that runs inside the task's container. Its second layer never lets the
// kernel follow a symlink: a link the task flips between a check and the open must not reach a file outside the root.
// The walk uses /proc/self/fd, so the filesystem tests run on Linux only (CI); elsewhere
// they are skipped with a printed reason, and the platform-free tests below still run.
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FILE_OPS_NODE_FLAGS } from "../../packages/worker/src/file-ops-exec.js";
import {
  FILE_OPS_TEMP_PREFIX,
  MAX_REQUEST_ARGUMENT_BYTES,
  globToRegExp,
  parseRequestArgument,
  runFileOp,
  type SandboxFileRequest,
  type SandboxFileResponse,
} from "../../packages/worker/src/sandbox-file-ops.js";

const linux = process.platform === "linux";
if (!linux) console.log("sandbox-file-ops.test.ts: filesystem tests skipped, they need /proc/self/fd (Linux); they run in CI");
const onLinux = linux ? describe : describe.skip;

const OUTSIDE_SECRET = "TOP-SECRET-OUTSIDE-CONTENT";
const INSIDE_SECRET = "inside-secret-content";

let base: string;
let root: string;
let outside: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "agentx-file-ops-")));
  root = join(base, "ws");
  outside = join(base, "outside");
  await mkdir(join(root, "real", "docs"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(root, "real", "secret.txt"), INSIDE_SECRET);
  await writeFile(join(root, "real", "docs", "guide.md"), "guide\n");
  await writeFile(join(outside, "secret.txt"), OUTSIDE_SECRET);
  await writeFile(join(outside, "outside-only.txt"), OUTSIDE_SECRET);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

function bytes(text: string | Buffer): AsyncIterable<Uint8Array> {
  const buffer = typeof text === "string" ? Buffer.from(text) : text;
  return (async function* () {
    // Several chunks, so a write is not one buffer.
    for (let offset = 0; offset < buffer.length; offset += 65_536) yield buffer.subarray(offset, offset + 65_536);
  })();
}

async function op(request: Record<string, unknown>, input?: AsyncIterable<Uint8Array>): Promise<SandboxFileResponse> {
  return runFileOp({ root, ...request } as SandboxFileRequest, input);
}

function failure(response: SandboxFileResponse): string {
  if (response.ok) throw new Error(`expected a refusal, got ${JSON.stringify(response.result).slice(0, 200)}`);
  return response.code;
}

function contentOf(response: SandboxFileResponse): string {
  if (!response.ok) throw new Error(`expected a result, got ${response.code}: ${response.message}`);
  return Buffer.from((response.result as { contentBase64: string }).contentBase64, "base64").toString("utf8");
}

describe("sandbox-file-ops (no filesystem)", () => {
  it("turns a glob into a path expression", () => {
    expect(globToRegExp("*.ts").test("a.ts")).toBe(true);
    expect(globToRegExp("*.ts").test("src/a.ts")).toBe(false);
    expect(globToRegExp("**/*.ts").test("src/deep/a.ts")).toBe(true);
    expect(globToRegExp("**/*.ts").test("a.ts")).toBe(true);
    expect(globToRegExp("**/node_modules/**").test("a/node_modules")).toBe(true);
    expect(globToRegExp("**/node_modules/**").test("a/node_modules/b/c.js")).toBe(true);
    expect(globToRegExp("**/node_modules/**").test("a/not_node_modules/b")).toBe(false);
    expect(globToRegExp("src/**/*.spec.ts").test("src/x/y.spec.ts")).toBe(true);
    expect(globToRegExp("*.{ts,tsx}").test("a.tsx")).toBe(true);
    expect(globToRegExp("file?.txt").test("file1.txt")).toBe(true);
    expect(globToRegExp("[!a]b").test("cb")).toBe(true);
    expect(globToRegExp("[!a]b").test("ab")).toBe(false);
  });

  it("refuses a request argument longer than 16 KiB, and one that is not base64url JSON", () => {
    expect(() => parseRequestArgument("x".repeat(MAX_REQUEST_ARGUMENT_BYTES + 1))).toThrow(/longer than/u);
    expect(() => parseRequestArgument(Buffer.from("not json").toString("base64url"))).toThrow(/base64url JSON/u);
    expect(parseRequestArgument(Buffer.from(JSON.stringify({ root: "/w", op: "exists", path: "a" })).toString("base64url"))).toEqual({ root: "/w", op: "exists", path: "a" });
  });

  it("refuses a root that is not an absolute path, without touching any file", async () => {
    expect(failure(await runFileOp({ root: "relative", op: "exists", path: "a" }))).toBe("INVALID");
    expect(failure(await runFileOp({ root: "/ws/", op: "exists", path: "a" }))).toBe("INVALID");
  });
});

onLinux("sandbox-file-ops (Linux filesystem)", () => {
  it("reads a file inside the root, by relative or absolute path", async () => {
    expect(contentOf(await op({ op: "readFile", path: "real/secret.txt" }))).toBe(INSIDE_SECRET);
    expect(contentOf(await op({ op: "readFile", path: join(root, "real", "secret.txt") }))).toBe(INSIDE_SECRET);
    expect(failure(await op({ op: "readFile", path: "real/missing.txt" }))).toBe("ENOENT");
    expect(failure(await op({ op: "readFile", path: "real" }))).toBe("EISDIR");
    expect(contentOf(await op({ op: "readFile", path: "real/secret.txt", head: 6 }))).toBe(INSIDE_SECRET.slice(0, 6));
  });

  it("refuses a root that has a symlink in it", async () => {
    await symlink(root, join(base, "rootlink"));
    expect(failure(await runFileOp({ root: join(base, "rootlink"), op: "exists", path: "real" }))).toBe("INVALID");
  });

  it("refuses a read through a link that leads outside, and follows a link that stays inside", async () => {
    await symlink("../outside", join(root, "link"));
    await symlink("real/docs", join(root, "docs"));
    await symlink("real/secret.txt", join(root, "alias.txt"));
    await symlink(join(root, "real"), join(root, "absolute-inside"));
    await symlink(join(outside, "secret.txt"), join(root, "absolute-outside.txt"));
    expect(failure(await op({ op: "readFile", path: "link/secret.txt" }))).toBe("OUTSIDE");
    expect(contentOf(await op({ op: "readFile", path: "docs/guide.md" }))).toBe("guide\n");
    expect(contentOf(await op({ op: "readFile", path: "alias.txt" }))).toBe(INSIDE_SECRET);
    expect(contentOf(await op({ op: "readFile", path: "absolute-inside/secret.txt" }))).toBe(INSIDE_SECRET);
    expect(failure(await op({ op: "readFile", path: "absolute-outside.txt" }))).toBe("OUTSIDE");
    expect(failure(await op({ op: "readFile", path: "../outside/secret.txt" }))).toBe("OUTSIDE");
    expect(failure(await op({ op: "readFile", path: join(outside, "secret.txt") }))).toBe("OUTSIDE");
    expect(failure(await op({ op: "readFile", path: `${root}/real/../../outside/secret.txt` }))).toBe("OUTSIDE");
  });

  it("follows a link out of one folder and back into another without leaving the root", async () => {
    await mkdir(join(root, "a", "b"), { recursive: true });
    await symlink("../../real", join(root, "a", "b", "up"));
    expect(contentOf(await op({ op: "readFile", path: "a/b/up/secret.txt" }))).toBe(INSIDE_SECRET);
    await symlink("../../../outside", join(root, "a", "b", "too-far"));
    expect(failure(await op({ op: "readFile", path: "a/b/too-far/secret.txt" }))).toBe("OUTSIDE");
  });

  it("refuses a loop of links", async () => {
    await symlink("two", join(root, "one"));
    await symlink("one", join(root, "two"));
    expect(failure(await op({ op: "readFile", path: "one" }))).toBe("INVALID");
  });

  it("refuses a write through a symlinked final component, and leaves outside unchanged", async () => {
    await symlink(join(outside, "secret.txt"), join(root, "final-link.txt"));
    await symlink("../outside/secret.txt", join(root, "relative-link.txt"));
    expect(failure(await op({ op: "writeFile", path: "final-link.txt", size: 3 }, bytes("bad")))).toBe("OUTSIDE");
    expect(failure(await op({ op: "writeFile", path: "relative-link.txt", size: 3 }, bytes("bad")))).toBe("OUTSIDE");
    expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe(OUTSIDE_SECRET);
    expect((await readdir(outside)).sort()).toEqual(["outside-only.txt", "secret.txt"]);
  });

  it("writes through a link that stays inside the root, to the file it leads to", async () => {
    await symlink("real/secret.txt", join(root, "alias.txt"));
    expect((await op({ op: "writeFile", path: "alias.txt", size: 4 }, bytes("done"))).ok).toBe(true);
    expect(await readFile(join(root, "real", "secret.txt"), "utf8")).toBe("done");
  });

  it("holds under a race that flips a link between inside and outside", async () => {
    await symlink("real", join(root, "x"));
    let flipping = true;
    const flipper = (async () => {
      let toOutside = true;
      while (flipping) {
        const temporary = join(root, `x-flip-${toOutside ? "o" : "i"}`);
        await rm(temporary, { force: true });
        await symlink(toOutside ? "../outside" : "real", temporary);
        await rename(temporary, join(root, "x")).catch(() => undefined);
        toOutside = !toOutside;
        await new Promise<void>((done) => setImmediate(done));
      }
    })();
    // The control: the plain filesystem API, which follows the link, does read the outside file while it flips. Without
    // that, the checks below would pass because the race never ran.
    let naiveLeaks = 0;
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if ((await readFile(join(root, "x", "secret.txt"), "utf8").catch(() => "")) === OUTSIDE_SECRET) naiveLeaks += 1;
    }
    expect(naiveLeaks).toBeGreaterThan(0);
    const results: SandboxFileResponse[] = [];
    const count = 500;
    const jobs: Array<Promise<void>> = [];
    for (let index = 0; index < count; index += 1) {
      jobs.push(op({ op: "readFile", path: "x/secret.txt" }).then((r) => { results.push(r); }));
      jobs.push(op({ op: "writeFile", path: `x/new-${index % 5}.txt`, size: 3 }, bytes("new")).then((r) => { results.push(r); }));
      jobs.push(op({ op: "mkdir", path: "x/d1/d2" }).then((r) => { results.push(r); }));
      jobs.push(op({ op: "readdir", path: "x" }).then((r) => { results.push(r); }));
      jobs.push(op({ op: "grep", pattern: "secret", path: "x", limit: 50 }).then((r) => { results.push(r); }));
      if (index % 50 === 0) await Promise.all(jobs.splice(0));
    }
    await Promise.all(jobs);
    flipping = false;
    await flipper;
    expect(results).toHaveLength(count * 5);
    const everything = JSON.stringify(results);
    expect(everything).not.toContain(OUTSIDE_SECRET);
    expect(everything).not.toContain("outside-only");
    expect(everything).not.toContain(outside);
    // Something went through: a race that refuses everything would pass the checks above for the wrong reason.
    expect(results.filter((result) => result.ok).length).toBeGreaterThan(0);
    expect((await readdir(outside)).sort()).toEqual(["outside-only.txt", "secret.txt"]);
    expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe(OUTSIDE_SECRET);
  }, 120_000);

  it("lists and searches from the root without leaving it through dir -> / or dir2 -> ../outside", async () => {
    await symlink("/", join(root, "dir"));
    await symlink("../outside", join(root, "dir2"));
    const glob = await op({ op: "glob", pattern: "**/*", cwd: root, ignore: [], limit: 1_000 });
    const grep = await op({ op: "grep", pattern: "secret", path: root, limit: 100 });
    for (const response of [glob, grep]) {
      expect(response.ok).toBe(true);
      const text = JSON.stringify(response);
      expect(text).not.toContain(outside);
      expect(text).not.toContain("/etc");
      expect(text).not.toContain("outside-only");
      expect(text).not.toContain(OUTSIDE_SECRET);
    }
    // The links themselves are listed, as paths, and never descended into.
    expect((glob as { result: { paths: string[] } }).result.paths).toEqual(expect.arrayContaining([`${root}/dir`, `${root}/dir2`]));
    expect((glob as { result: { paths: string[] } }).result.paths.some((path) => path.startsWith(`${root}/dir/`) || path.startsWith(`${root}/dir2/`))).toBe(false);
  });

  it("finds files by glob, with ignore patterns, a limit, and absolute results", async () => {
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(root, "node_modules", "pkg", "index.js"), "x");
    await writeFile(join(root, "real", "a.spec.ts"), "x");
    const found = await op({ op: "glob", pattern: "**/*.spec.ts", cwd: root, ignore: ["**/node_modules/**", "**/.git/**"], limit: 10 });
    expect(found).toEqual({ ok: true, result: { paths: [`${root}/real/a.spec.ts`] } });
    const named = await op({ op: "glob", pattern: "*.md", cwd: root, ignore: ["**/node_modules/**"], limit: 10 });
    expect(named).toEqual({ ok: true, result: { paths: [`${root}/real/docs/guide.md`] } });
    const limited = await op({ op: "glob", pattern: "**/*", cwd: root, ignore: ["**/node_modules/**"], limit: 2 });
    expect((limited as { result: { paths: string[] } }).result.paths).toHaveLength(2);
  });

  it("searches file contents, with context, a glob filter and a limit", async () => {
    await writeFile(join(root, "real", "lines.txt"), "one\ntwo needle\nthree\nfour\nfive needle\n");
    const found = await op({ op: "grep", pattern: "needle", path: "real", glob: "*.txt", limit: 10, context: 1 });
    expect(found.ok).toBe(true);
    const result = (found as { result: { searchIsDirectory: boolean; blocks: Array<{ path: string; lines: Array<{ n: number; text: string; match: boolean }> }>; limitReached: boolean } }).result;
    expect(result.searchIsDirectory).toBe(true);
    expect(result.blocks.map((block) => block.path)).toEqual([`${root}/real/lines.txt`, `${root}/real/lines.txt`]);
    expect(result.blocks[0]!.lines).toEqual([{ n: 1, text: "one", match: false }, { n: 2, text: "two needle", match: true }, { n: 3, text: "three", match: false }]);
    const limited = await op({ op: "grep", pattern: "needle", path: "real/lines.txt", limit: 1 });
    expect((limited as { result: { limitReached: boolean; searchIsDirectory: boolean } }).result).toMatchObject({ limitReached: true, searchIsDirectory: false });
    const literal = await op({ op: "grep", pattern: "a.b(", path: "real", literal: true, limit: 5 });
    expect((literal as { result: { blocks: unknown[] } }).result.blocks).toEqual([]);
    expect(failure(await op({ op: "grep", pattern: "(", path: "real", limit: 5 }))).toBe("INVALID");
    expect(failure(await op({ op: "grep", pattern: "x", path: "missing", limit: 5 }))).toBe("ENOENT");
  });

  it("gives a pattern that needs Unicode its `u` flag, and counts the lines of a file of any size", async () => {
    await writeFile(join(root, "real", "letters.txt"), "plain\nacc\u00e9nt\n");
    const letters = await op({ op: "grep", pattern: "^\\p{L}+$", path: "real/letters.txt", limit: 5 });
    expect((letters as { result: { blocks: Array<{ lines: Array<{ text: string }> }> } }).result.blocks.map((block) => block.lines[0]!.text)).toEqual(["plain", "acc\u00e9nt"]);
    const emoji = await op({ op: "grep", pattern: "\\u{1F600}", path: "real/letters.txt", limit: 5 });
    expect(emoji.ok).toBe(true);
    await writeFile(join(root, "real", "count.txt"), "one\ntwo\nthree");
    await writeFile(join(root, "real", "count-nl.txt"), "one\ntwo\n");
    await writeFile(join(root, "real", "count-empty.txt"), "");
    await writeFile(join(root, "real", "count-big.txt"), `${"x".repeat(1023)}\n`.repeat(5_000));
    expect(await op({ op: "countLines", path: "real/count.txt" })).toEqual({ ok: true, result: { lineCount: 3 } });
    expect(await op({ op: "countLines", path: "real/count-nl.txt" })).toEqual({ ok: true, result: { lineCount: 2 } });
    expect(await op({ op: "countLines", path: "real/count-empty.txt" })).toEqual({ ok: true, result: { lineCount: 0 } });
    expect(await op({ op: "countLines", path: "real/count-big.txt" })).toEqual({ ok: true, result: { lineCount: 5_000 } });
    expect(failure(await op({ op: "countLines", path: "real" }))).toBe("EISDIR");
    await symlink("../../outside/secret.txt", join(root, "real", "out-link"));
    expect(failure(await op({ op: "countLines", path: "real/out-link" }))).toBe("OUTSIDE");
  });

  it("lists a symlinked directory that leads outside as OUTSIDE, and lists the entries of one inside", async () => {
    await symlink("../outside", join(root, "out"));
    await symlink("real/docs", join(root, "docs"));
    expect(failure(await op({ op: "readdir", path: "out" }))).toBe("OUTSIDE");
    expect(failure(await op({ op: "stat", path: "out" }))).toBe("OUTSIDE");
    expect(failure(await op({ op: "exists", path: "out" }))).toBe("OUTSIDE");
    expect(await op({ op: "readdir", path: "docs" })).toEqual({ ok: true, result: { entries: [{ name: "guide.md", kind: "file" }] } });
    const listed = await op({ op: "readdir", path: "." });
    const entries = (listed as { result: { entries: Array<{ name: string; kind: string }> } }).result.entries;
    expect(entries).toEqual(expect.arrayContaining([{ name: "docs", kind: "dir" }, { name: "out", kind: "gone" }, { name: "real", kind: "dir" }]));
  });

  it("answers stat, exists and access", async () => {
    expect(await op({ op: "exists", path: "real/secret.txt" })).toEqual({ ok: true, result: { exists: true } });
    expect(await op({ op: "exists", path: "real/nope.txt" })).toEqual({ ok: true, result: { exists: false } });
    expect(await op({ op: "exists", path: "nope/nope.txt" })).toEqual({ ok: true, result: { exists: false } });
    expect(await op({ op: "stat", path: "real" })).toMatchObject({ ok: true, result: { type: "dir" } });
    expect(await op({ op: "stat", path: "real/secret.txt" })).toMatchObject({ ok: true, result: { type: "file", size: INSIDE_SECRET.length } });
    expect(failure(await op({ op: "stat", path: "nope" }))).toBe("ENOENT");
    expect((await op({ op: "access", path: "real/secret.txt" })).ok).toBe(true);
    expect((await op({ op: "access", path: "real/secret.txt", write: true })).ok).toBe(true);
    expect(failure(await op({ op: "access", path: "nope" }))).toBe("ENOENT");
  });

  it("makes directories one verified component at a time, and refuses to make one through an outside link", async () => {
    expect((await op({ op: "mkdir", path: "made/deep/er" })).ok).toBe(true);
    expect((await readdir(join(root, "made", "deep"))).sort()).toEqual(["er"]);
    expect((await op({ op: "mkdir", path: "made/deep/er" })).ok).toBe(true);
    await symlink("../outside", join(root, "out"));
    expect(failure(await op({ op: "mkdir", path: "out/created" }))).toBe("OUTSIDE");
    expect(await readdir(outside)).not.toContain("created");
    expect(failure(await op({ op: "mkdir", path: "real/secret.txt/under" }))).toBe("ENOTDIR");
  });

  it("writes atomically, byte for byte, and creates a missing file with the default mode", async () => {
    const content = Buffer.alloc(300 * 1024);
    for (let index = 0; index < content.length; index += 1) content[index] = [0, 1, 7, 9, 10, 13, 27, 34, 39, 92, 127, 200, 255][index % 13]!;
    expect((await op({ op: "writeFile", path: "real/big.bin", size: content.length }, bytes(content))).ok).toBe(true);
    expect((await readFile(join(root, "real", "big.bin"))).equals(content)).toBe(true);
    const names = await readdir(join(root, "real"));
    expect(names.some((name) => name.startsWith(FILE_OPS_TEMP_PREFIX))).toBe(false);
    expect((await op({ op: "writeFile", path: "real/secret.txt", size: 5 }, bytes("fresh"))).ok).toBe(true);
    expect(await readFile(join(root, "real", "secret.txt"), "utf8")).toBe("fresh");
    expect(failure(await op({ op: "writeFile", path: "missing/dir/file.txt", size: 1 }, bytes("x")))).toBe("ENOENT");
    expect(failure(await op({ op: "writeFile", path: "real", size: 1 }, bytes("x")))).toBe("EISDIR");
  });

  it("keeps an existing file's mode on write", async () => {
    await chmod(join(root, "real", "secret.txt"), 0o755);
    expect((await op({ op: "writeFile", path: "real/secret.txt", size: 3 }, bytes("new"))).ok).toBe(true);
    const { mode } = await stat(join(root, "real", "secret.txt"));
    expect(mode & 0o777).toBe(0o755);
  });

  it("leaves the old target unchanged and no temporary file when the content is cut short or fails", async () => {
    const cut = (async function* () { yield Buffer.from("half of it"); })();
    expect(failure(await op({ op: "writeFile", path: "real/secret.txt", size: 100 }, cut))).toBe("INVALID");
    const broken = (async function* () { yield Buffer.from("some"); throw new Error("stream closed"); })();
    expect((await op({ op: "writeFile", path: "real/secret.txt", size: 100 }, broken)).ok).toBe(false);
    const extra = bytes("way too much content");
    expect(failure(await op({ op: "writeFile", path: "real/secret.txt", size: 4 }, extra))).toBe("INVALID");
    expect(await readFile(join(root, "real", "secret.txt"), "utf8")).toBe(INSIDE_SECRET);
    expect((await readdir(join(root, "real"))).filter((name) => name.startsWith(FILE_OPS_TEMP_PREFIX))).toEqual([]);
    expect(failure(await op({ op: "writeFile", path: "real/huge", size: 11 * 1024 * 1024 }, bytes("x")))).toBe("TOO_LARGE");
  });

  const unprivileged = process.getuid?.() !== 0;
  (unprivileged ? it : it.skip)("maps permission failures to EACCES, and refuses to replace a read-only file", async () => {
    await writeFile(join(root, "real", "private.txt"), "private");
    await chmod(join(root, "real", "private.txt"), 0o000);
    expect(failure(await op({ op: "readFile", path: "real/private.txt" }))).toBe("EACCES");
    expect(failure(await op({ op: "access", path: "real/private.txt" }))).toBe("EACCES");
    await writeFile(join(root, "real", "readonly.txt"), "keep");
    await chmod(join(root, "real", "readonly.txt"), 0o444);
    expect(failure(await op({ op: "writeFile", path: "real/readonly.txt", size: 3 }, bytes("new")))).toBe("EACCES");
    expect(failure(await op({ op: "access", path: "real/readonly.txt", write: true }))).toBe("EACCES");
    expect(await readFile(join(root, "real", "readonly.txt"), "utf8")).toBe("keep");
    expect((await readdir(join(root, "real"))).filter((name) => name.startsWith(FILE_OPS_TEMP_PREFIX))).toEqual([]);
    await chmod(join(root, "real", "private.txt"), 0o600);
  });

  it("sweeps leftover temporary files, never follows a link, and a snapshot taken after lists none", async () => {
    await writeFile(join(root, "real", `${FILE_OPS_TEMP_PREFIX}leftover-1`), "partial");
    await writeFile(join(root, "real", "docs", `${FILE_OPS_TEMP_PREFIX}leftover-2`), "partial");
    await writeFile(join(outside, `${FILE_OPS_TEMP_PREFIX}not-mine`), "outside");
    await symlink("../outside", join(root, "out"));
    expect(await op({ op: "sweep", path: "." })).toEqual({ ok: true, result: { removed: 2 } });
    expect(await readdir(join(root, "real"))).not.toContain(`${FILE_OPS_TEMP_PREFIX}leftover-1`);
    expect(await readdir(outside)).toContain(`${FILE_OPS_TEMP_PREFIX}not-mine`);
    expect(await op({ op: "sweep", path: "no-such-folder" })).toEqual({ ok: true, result: { removed: 0 } });
    const snapshot = await op({ op: "glob", pattern: "**/*", cwd: root, ignore: [], limit: 1_000 });
    expect(JSON.stringify(snapshot)).not.toContain(FILE_OPS_TEMP_PREFIX);
  });

  it("is a one-file process: one JSON line out, content on stdin, exit 0 whatever the outcome", async () => {
    const run = (request: Record<string, unknown>, stdin?: Buffer) => runHelperProcess(request, stdin === undefined ? {} : { stdin });
    const written = await run({ op: "writeFile", path: "real/via-process.txt", size: 5 }, Buffer.from("hello"));
    expect(written.code).toBe(0);
    expect(JSON.parse(written.stdout)).toEqual({ ok: true, result: {} });
    expect(written.stdout.trim().split("\n")).toHaveLength(1);
    const read = await run({ op: "readFile", path: "real/via-process.txt" });
    expect(JSON.parse(read.stdout)).toEqual({ ok: true, result: { contentBase64: Buffer.from("hello").toString("base64") } });
    const refused = await run({ op: "readFile", path: "../outside/secret.txt" });
    expect(refused.code).toBe(0);
    expect(JSON.parse(refused.stdout)).toMatchObject({ ok: false, code: "OUTSIDE" });
  });

  it("answers a grep and a glob through its search thread, as the process does", async () => {
    const grep = await runHelperProcess({ op: "grep", pattern: "inside", path: "real", limit: 5 });
    expect(JSON.parse(grep.stdout)).toMatchObject({ ok: true, result: { searchIsDirectory: true, blocks: [{ path: `${root}/real/secret.txt` }] } });
    const glob = await runHelperProcess({ op: "glob", pattern: "*.md", cwd: root, ignore: [], limit: 5 });
    expect(JSON.parse(glob.stdout)).toEqual({ ok: true, result: { paths: [`${root}/real/docs/guide.md`] } });
  });

  describe("a pattern that backtracks catastrophically (ReDoS)", () => {
    const DEADLINE = { AGENTX_FILE_OPS_DEADLINE_MS: "600" };
    const gone = (pid: number | undefined): boolean => {
      if (pid === undefined) return false;
      try { process.kill(pid, 0); return false; } catch { return true; }
    };

    it("gives up on `(a+)+$` against a 28-character line within the deadline, and the helper process is gone", async () => {
      await writeFile(join(root, "real", "evil.txt"), `${"a".repeat(28)}!\n`);
      const started = Date.now();
      const result = await runHelperProcess({ op: "grep", pattern: "(a+)+$", path: "real/evil.txt", limit: 5 }, { env: DEADLINE });
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, code: "PATTERN_TOO_SLOW" });
      // It says the search was slow and what to do; it does not blame the pattern outright (a big tree is slow too).
      const message = (JSON.parse(result.stdout) as { message: string }).message;
      expect(message).toMatch(/^the search took longer than \d+ s and was stopped; narrow the path/u);
      expect(message).toContain("simplify the pattern");
      expect(result.code).toBe(0);
      // Unbounded, this match takes about 10 s; the deadline is 0.6 s, plus the start of the process.
      expect(Date.now() - started).toBeLessThan(6_000);
      expect(gone(result.pid)).toBe(true);
    }, 30_000);

    it("gives up on the glob `*a*a*a*a*a*a*b` against a long name within the deadline, and the helper process is gone", async () => {
      await writeFile(join(root, "real", "a".repeat(200)), "x");
      const started = Date.now();
      const result = await runHelperProcess({ op: "glob", pattern: "*a*a*a*a*a*a*b", cwd: root, ignore: [], limit: 5 }, { env: DEADLINE });
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, code: "PATTERN_TOO_SLOW" });
      expect(Date.now() - started).toBeLessThan(6_000);
      expect(gone(result.pid)).toBe(true);
    }, 30_000);

    it("with V8's linear-time fallback on (the flag the worker starts the helper with), the same grep finishes at once", async () => {
      await writeFile(join(root, "real", "evil.txt"), `${"a".repeat(28)}!\n`);
      const started = Date.now();
      const result = await runHelperProcess({ op: "grep", pattern: "(a+)+$", path: "real/evil.txt", limit: 5 }, { env: { AGENTX_FILE_OPS_DEADLINE_MS: "20000" }, flags: [...FILE_OPS_NODE_FLAGS] });
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, result: { blocks: [] } });
      expect(Date.now() - started).toBeLessThan(6_000);
    }, 30_000);
  });
});

/** The helper as a real process (Node strips the types of the source), the way `docker exec` runs it. */
function runHelperProcess(request: Record<string, unknown>, options: { stdin?: Buffer; env?: Record<string, string>; flags?: string[] } = {}) {
  const helper = resolve(import.meta.dirname, "../../packages/worker/src/sandbox-file-ops.ts");
  return new Promise<{ code: number | null; stdout: string; pid: number | undefined }>((done, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", ...(options.flags ?? []), helper, Buffer.from(JSON.stringify({ root, ...request })).toString("base64url")], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, ...options.env } });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => done({ code, stdout, pid: child.pid }));
    child.stdin.end(options.stdin);
  });
}
