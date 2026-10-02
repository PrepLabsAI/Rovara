// tests/contract/init-log-file.test.ts
// Spec 048 FR-070 and FR-071: the page-mode log file gets everything the terminal no longer
// shows, and never the page's session token.
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
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
});
