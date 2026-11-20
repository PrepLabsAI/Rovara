// tests/contract/init-log-file.test.ts
// Spec 048 FR-070 and FR-071: the page-mode log file gets everything the terminal no longer
// shows, and never the page's session token.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { Writable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initLogPath, openInitLog } from "../../packages/cli/src/init/log-file.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("the install log file", () => {

  it("hides a value in its URL-encoded form too", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentx-log-")); dirs.push(home);
    const path = initLogPath(home, "staging");
    const log = await openInitLog(path);
    log.hide("token+with/slash=");
    log.write("raw token+with/slash= and encoded token%2Bwith%2Fslash%3D\n");
    await log.close();
    expect(await readFile(path, "utf8")).toBe("raw <hidden> and encoded <hidden>\n");
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
