import "./mutation-spot-offline.js";
// Q1 proof through the REAL runner: abort joins the SIGTERM-resistant child before returning.
// Writes before SIGKILL stay in the disposable copy; the candidate is never restored or reused.
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createCheckRunners } from "../../packages/worker/src/verification/checks.js";
import { snapshotCandidate } from "../../packages/worker/src/verification/mutation-restore.js";
import { runMutationSpotCheck } from "../../packages/worker/src/verification/mutation-spot-check.js";
import { fixture, report } from "./mutation-spot-support.js";

// The existing worker image carries deployment markers that intentionally refuse local child
// execution. These fixtures test the explicitly local runner, including when hosted in that image.
beforeEach(() => { vi.stubEnv("AGENTX_RUNTIME", ""); vi.stubEnv("AGENTX_WORKER_PROCESS_SCOPE", ""); });
afterEach(() => vi.unstubAllEnvs());

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(predicate: () => Promise<boolean> | boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await predicate())) { if (Date.now() >= deadline) throw new Error("test child did not reach its handshake"); await delay(10); }
}
it("a real SIGTERM-resistant child is reaped after abort and writes only in its disposable copy", async () => {
  const f = await fixture();
  const ready = join(f.root, "ready"); const release = join(f.root, "release"); const wrote = join(f.root, "wrote");
  const terminated = join(f.root, "terminated");
  let pid: number | undefined; let copied = ""; let running: Promise<unknown> | undefined;
  const before = await snapshotCandidate(f.directory);
  const entries = (await readdir(f.directory)).sort();
  const candidateUnchanged = async () => {
    expect(await snapshotCandidate(f.directory)).toEqual(before);
    expect((await readdir(f.directory)).sort()).toEqual(entries);
  };
  try {
    const script = `
      const fs = require("node:fs");
      if (fs.readFileSync("value.ts", "utf8").includes("= true")) { fs.writeFileSync("report.json", ${JSON.stringify(report("passed"))}); process.exit(0); }
      const [ready, release, wrote, terminated] = ${JSON.stringify([ready, release, wrote, terminated])};
      process.on("SIGTERM", () => {
        fs.writeFileSync("value.ts", "written before kill\\n");
        fs.writeFileSync(terminated, "yes");
      });
      fs.writeFileSync("value.ts", "written before abort\\n");
      fs.writeFileSync(ready, String(process.pid));
      setInterval(() => {
        if (!fs.existsSync(release)) return;
        fs.writeFileSync("value.ts", "written after abort\\n");
        fs.writeFileSync(wrote, "yes");
        process.exit(0);
      }, 10);
    `;
    f.selection[0]!.command = { cwd: ".", executable: process.execPath, args: ["-e", script, "--", "--outputFile=report.json", "--json"], timeoutSeconds: 30 };
    running = runMutationSpotCheck({ repositories: [f.repository], selection: f.selection, seed: f.repository.candidateTreeSha, scratchRoot: f.scratchRoot,
      limits: { perMutantTimeMs: 1_000, totalTimeMs: 30_000 }, runners: (directory) => { copied = directory; return createCheckRunners({ rootPath: directory, local: true }); } });
    await until(async () => (await readFile(ready, "utf8").catch(() => "")) !== "");
    pid = Number(await readFile(ready, "utf8"));
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    expect(alive(pid)).toBe(true); // positive control: the actual writer started
    expect(await readFile(join(copied, "value.ts"), "utf8")).toBe("written before abort\n");
    await candidateUnchanged();
    expect(await running).toMatchObject({ trustedAfter: false, counted: 0, caught: 0, mutants: [{ outcome: "timed_out" }] });
    expect(alive(pid)).toBe(false); // already reaped when B11 returns, without a test-side wait/kill
    expect(await readFile(terminated, "utf8")).toBe("yes"); // ignored TERM and wrote before KILL
    expect(await readFile(join(copied, "value.ts"), "utf8")).toBe("written before kill\n");
    await expect(readFile(wrote, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await candidateUnchanged();
    await writeFile(release, "go");
    expect(alive(pid)).toBe(false);
    await expect(readFile(wrote, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(copied, "value.ts"), "utf8")).toBe("written before kill\n");
    await candidateUnchanged();
  } finally {
    if (pid === undefined) { const raw = await readFile(ready, "utf8").catch(() => ""); if (/^[1-9][0-9]*$/u.test(raw)) pid = Number(raw); }
    if (pid !== undefined && alive(pid)) { process.kill(pid, "SIGKILL"); await until(() => !alive(pid!)); }
    await running;
    await rm(f.root, { recursive: true, force: true });
  }
});
it("a crashed child leaves only abandoned scratch and needs no candidate recovery writes", async () => {
  const f = await fixture(); const before = await snapshotCandidate(f.directory);
  try {
    f.selection[0]!.command = { cwd: ".", executable: process.execPath, args: ["-e", `const fs = require("node:fs"); if (fs.readFileSync("value.ts", "utf8").includes("= true")) { fs.writeFileSync("report.json", ${JSON.stringify(report("passed"))}); process.exit(0); } fs.writeFileSync("value.ts", "crash residue"); process.kill(process.pid, "SIGKILL");`, "--", "--outputFile=report.json", "--json"], timeoutSeconds: 30 };
    const result = await runMutationSpotCheck({ repositories: [f.repository], selection: f.selection, seed: f.repository.candidateTreeSha, scratchRoot: f.scratchRoot,
      runners: (directory) => createCheckRunners({ rootPath: directory, local: true }) });
    expect(result).toMatchObject({ trustedAfter: true, counted: 0, mutants: [{ outcome: "invalid" }] });
    expect(await snapshotCandidate(f.directory)).toEqual(before);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
