// tests/contract/init-log-file.test.ts
// Spec 048 FR-070 and FR-071: the page-mode log file gets everything the terminal no longer
// shows, and never the page's session token.
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { Writable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initLogPath, openInitLog } from "../../packages/cli/src/init/log-file.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("the install log file", () => {
  it("lives under ~/.agentx/logs, readable by its owner only, and hides what it is told to hide", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentx-log-")); dirs.push(home);
    const path = initLogPath(home, "staging");
    expect(path).toBe(join(home, ".agentx", "logs", "init-staging.log"));
    const log = await openInitLog(path);
    log.hide("test-session-token-aaaaaaaaaaaaaaaaaaa");
    log.write("done: Set up AWS permissions\n");
    log.write("opened http://127.0.0.1:5000/?t=test-session-token-aaaaaaaaaaaaaaaaaaa\n");
    await log.close();
    const text = await readFile(path, "utf8");
    expect(text).toBe("done: Set up AWS permissions\nopened http://127.0.0.1:5000/?t=<hidden>\n");
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("hides a value in its URL-encoded form too", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentx-log-")); dirs.push(home);
    const path = initLogPath(home, "staging");
    const log = await openInitLog(path);
    log.hide("token+with/slash=");
    log.write("raw token+with/slash= and encoded token%2Bwith%2Fslash%3D\n");
    await log.close();
    expect(await readFile(path, "utf8")).toBe("raw <hidden> and encoded <hidden>\n");
  });

  it("tightens an existing log file and folder to its owner only", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentx-log-")); dirs.push(home);
    const path = initLogPath(home, "staging");
    await mkdir(join(home, ".agentx", "logs"), { recursive: true, mode: 0o755 });
    await chmod(join(home, ".agentx", "logs"), 0o755);
    await writeFile(path, "an earlier run\n", { mode: 0o644 });
    await chmod(path, 0o644);
    const log = await openInitLog(path);
    log.write("this run\n");
    await log.close();
    expect(await readFile(path, "utf8")).toBe("an earlier run\nthis run\n");
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(join(home, ".agentx", "logs"))).mode & 0o777).toBe(0o700);
    }
  });

  it("refuses a log path it cannot open with a plain error, before anything else runs", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentx-log-")); dirs.push(home);
    // A file where the logs folder should be: the folder cannot be made, so the log cannot open.
    await mkdir(join(home, ".agentx"), { recursive: true });
    await writeFile(join(home, ".agentx", "logs"), "not a folder\n");
    const path = initLogPath(home, "staging");
    await expect(openInitLog(path)).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message: expect.stringContaining(`agentx init could not open its log file ${path} (`) as unknown,
    });
  });

  it("stops logging after a write fails, says so once, and never crashes the install", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentx-log-")); dirs.push(home);
    const path = initLogPath(home, "staging");
    const said: string[] = [];
    let writes = 0;
    const failing = new Writable({ write(_chunk, _encoding, callback) { writes += 1; callback(new Error("EIO: i/o error, write")); } });
    const log = await openInitLog(path, {
      onError: (line) => said.push(line),
      openFile: async () => ({ chmod: async () => undefined, close: async () => undefined, createWriteStream: () => failing }),
    });
    log.write("first\n");
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    log.write("second\n");
    await log.close();
    expect(writes).toBe(1);
    expect(said).toEqual([`The install log ${path} could not be written (EIO: i/o error, write). The install goes on without it.`]);
  });
});
