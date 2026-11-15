// TE-B11 prerequisite: restoring bytes is safe only after the runner can no longer write.
// This is deliberately a real local CheckRunners probe, not the mutation runner's fake.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { isolatedGitEnvironment } from "../../packages/worker/src/git.js";
import { runIsolatedGit } from "../../packages/worker/src/isolated-repository.js";
import { createCheckRunners } from "../../packages/worker/src/verification/checks.js";

const original = "export const value = true;\n";
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
async function until(predicate: () => Promise<boolean> | boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("test child did not reach its handshake");
    await delay(10);
  }
}

it("the real runner is finished before a mutation restore can be trusted", async () => {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "b11-runner-")));
  const repository = join(scratch, "candidate");
  const target = join(repository, "value.ts");
  const ready = join(scratch, "ready");
  const release = join(scratch, "restore-finished");
  const wrote = join(scratch, "wrote-after-restore");
  const control = new AbortController();
  let pid: number | undefined;
  let running: Promise<unknown> | undefined;
  try {
    await mkdir(repository);
    // Fixture creation only; status assertions below use the actual isolated repository path.
    const env = isolatedGitEnvironment(repository, {
      GIT_LITERAL_PATHSPECS: "1", GIT_GLOB_PATHSPECS: "0", GIT_NOGLOB_PATHSPECS: "0", GIT_ICASE_PATHSPECS: "0",
    });
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Codex", "-c", "user.email=noreply@openai.com", ...args], { cwd: repository, env });
    git("init", "--quiet", "--template=");
    await writeFile(target, original);
    git("add", "--", "value.ts");
    git("commit", "--quiet", "-m", "test fixture\n\nCo-Authored-By: Codex <noreply@openai.com>");
    const status = () => runIsolatedGit(repository, ["status", "--porcelain=v2", "-z", "--untracked-files=no"], { mode: "read", index: "work" });
    const before = await status();
    const runners = createCheckRunners({ rootPath: repository, local: true });
    // A ready/restore handshake makes the late write deterministic, independent of machine load.
    // The process ignores SIGTERM, then exits itself after the write. Finally also kills/reaps it.
    const script = `
      const fs = require("node:fs");
      const [target, ready, release, wrote] = process.argv.slice(1);
      process.on("SIGTERM", () => {});
      fs.writeFileSync(ready, String(process.pid));
      setInterval(() => {
        if (!fs.existsSync(release)) return;
        fs.writeFileSync(target, "written after restore\\n");
        fs.writeFileSync(wrote, "yes");
        process.exit(0);
      }, 10);
    `;
    running = runners.runProjectCommand({ cwd: ".", executable: process.execPath, args: ["-e", script, target, ready, release, wrote], timeoutSeconds: 30 }, control.signal)
      .then(() => "returned", () => "rejected");
    await until(async () => (await readFile(ready, "utf8").catch(() => "")) !== "");
    pid = Number(await readFile(ready, "utf8"));
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    expect(alive(pid)).toBe(true); // positive control: the actual command ran
    control.abort();
    await running;
    await writeFile(target, original);
    expect(digest(await readFile(target, "utf8"))).toBe(digest(original));
    expect(await status()).toBe(before); // both proposed immediate restore checks pass
    await writeFile(release, "restore and status checks finished");
    await until(() => !alive(pid!));
    const lateWrite = await readFile(wrote, "utf8").catch(() => "");
    expect({ lateWrite, contents: await readFile(target, "utf8"), status: await status() }).toEqual({
      lateWrite: "", contents: original, status: before,
    });
  } finally {
    control.abort();
    if (pid === undefined) {
      const text = await readFile(ready, "utf8").catch(() => "");
      if (/^[1-9][0-9]*$/u.test(text)) pid = Number(text);
    }
    if (pid !== undefined && alive(pid)) {
      process.kill(pid, "SIGKILL");
      await until(() => !alive(pid!));
    }
    await running;
    // Drain the base runner's scheduled group-kill timer before this test worker exits.
    await delay(5_100);
    await rm(scratch, { recursive: true, force: true });
  }
});
