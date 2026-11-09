// SEED-RISK-1, the worker's half: a LOCKED seed command runs only while its script, hashed again from the checkout right before the run, is what was approved. A difference, a link, or a worker without the check refuses
// it, and the command never runs.
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { seedScriptLockOf, type SeedScriptLock } from "@agentx/contracts";
import { SeedError, runSeeds, type SeedPorts } from "../../packages/worker/src/service-reset.js";
import { checkoutSeedReader, seedLockHoldsInCheckout } from "../../packages/worker/src/service-seed-lock.js";

const SEED = { cwd: "repo/web", executable: "npm", args: ["run", "seed"], timeoutSeconds: 900 };
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function checkout(files: Record<string, string> = { "package.json": JSON.stringify({ scripts: { seed: "node db/seed.js" } }), "db/seed.js": "require('pg');\n" }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "seed-lock-"));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, "repo/web", path, ".."), { recursive: true });
    await writeFile(join(root, "repo/web", path), text);
  }
  return root;
}
async function lockOf(root: string): Promise<SeedScriptLock> {
  const resolved = await seedScriptLockOf(SEED, checkoutSeedReader(root, SEED.cwd, [join(root, "repo/web")]));
  if (!resolved.ok) throw new Error(`no lock: ${resolved.refusal}`);
  return resolved.lock;
}
/** The seed ports, and the spy of the command runner (kept apart from the ports so it is never read as an unbound method). */
function ports(root: string | undefined): SeedPorts & { ran: ReturnType<typeof vi.fn> } {
  const ran = vi.fn(async () => ({ exitCode: 0, timedOut: false }));
  const lockHolds: SeedPorts["lockHolds"] = root === undefined ? undefined : (command, lock) => seedLockHoldsInCheckout(root, [join(root, "repo/web")], command, lock);
  return { ran, runCommand: ran, applyFixture: async () => undefined, ...(lockHolds === undefined ? {} : { lockHolds }) };
}
const signal = () => new AbortController().signal;

describe("a locked seed at run time", () => {
  it("runs when the checkout still hashes to the lock (positive control)", async () => {
    const root = await checkout();
    const lock = await lockOf(root);
    const seen = ports(root);
    await runSeeds("postgres", [{ command: SEED, lock }], seen, signal());
    expect(seen.ran).toHaveBeenCalledTimes(1);
  });

  it("is refused, and never runs, when the seed file changed since the approval", async () => {
    const root = await checkout();
    const lock = await lockOf(root);
    await writeFile(join(root, "repo/web/db/seed.js"), "require('child_process').exec('curl x');\n");
    const seen = ports(root);
    await expect(runSeeds("postgres", [{ command: SEED, lock }], seen, signal())).rejects.toMatchObject({ reason: "seed_changed" });
    expect(seen.ran).not.toHaveBeenCalled();
  });

  it("is refused when the script body changed, or a pre-script was added", async () => {
    for (const scripts of [{ seed: "node db/other.js" }, { seed: "node db/seed.js", preseed: "node db/seed.js" }]) {
      const root = await checkout();
      const lock = await lockOf(root);
      await writeFile(join(root, "repo/web/package.json"), JSON.stringify({ scripts }));
      const seen = ports(root);
      await expect(runSeeds("postgres", [{ command: SEED, lock }], seen, signal())).rejects.toBeInstanceOf(SeedError);
      expect(seen.ran).not.toHaveBeenCalled();
    }
  });

  it("is refused when the seed file became a link (even to the same text)", async () => {
    const root = await checkout();
    const lock = await lockOf(root);
    await writeFile(join(root, "repo/web/db/copy.js"), "require('pg');\n");
    await rm(join(root, "repo/web/db/seed.js"));
    await symlink(join(root, "repo/web/db/copy.js"), join(root, "repo/web/db/seed.js"));
    expect(await seedLockHoldsInCheckout(root, [join(root, "repo/web")], SEED, lock)).toBe(false);
  });

  it("is refused by a worker that has no lock check at all (fail closed); an unlocked seed runs as before", async () => {
    const root = await checkout();
    const lock = await lockOf(root);
    const without = ports(undefined);
    await expect(runSeeds("postgres", [{ command: SEED, lock }], without, signal())).rejects.toMatchObject({ reason: "seed_changed" });
    expect(without.ran).not.toHaveBeenCalled();
    await runSeeds("postgres", [{ command: SEED }], without, signal());
    expect(without.ran).toHaveBeenCalledTimes(1);
  });

  it("is refused when the candidate tree adds a package manager settings file (.npmrc) beside it or at the repository root", async () => {
    for (const where of ["repo/web/.npmrc", "repo/web/.yarnrc.yml"]) {
      const root = await checkout();
      const lock = await lockOf(root);
      await writeFile(join(root, where), "script-shell=./x.sh\n");
      expect(await seedLockHoldsInCheckout(root, [join(root, "repo/web")], SEED, lock)).toBe(false);
    }
  });

  it("is wired with the workspace and its repositories in all three places a seed runs (working phase, sealed round, reseed)", async () => {
    const source = await readFile(new URL("../../packages/worker/src/test-services-run.ts", import.meta.url), "utf8");
    const calls = source.split("seedPorts(").slice(1, -1).map((part) => part.slice(0, part.indexOf(";")));
    expect(calls).toHaveLength(3);
    for (const call of calls) expect(call).toMatch(/, root, input\.repositoryPaths\)/u);
    expect(source).toMatch(/lockHolds: \(command, lock\) => seedLockHoldsInCheckout\(rootPath, repositoryPaths, command, lock\)/u);
  });
});
