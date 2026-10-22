import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIsolatedE2EApplication } from "../../packages/verifier/src/application-runtime.js";
import { webApiProbeRunInput } from "../../packages/verifier/src/host/web-api-probe-plan.js";
import { INFERRED_APP_FILES, INFERRED_FIXTURE_ROOT, createInferredExecutorPlan, type InferredPlanOptions } from "./e2e-inferred-fixture.js";
import { createLinuxHost, type ProbeRun } from "./linux-runtime.js";

const kept: string[] = [];
/** Removes the kept copies of out directories and the candidate copies this module made. */
export async function removeInferredDirs(): Promise<void> {
  for (const dir of kept.splice(0)) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

/**
 * Runs the inferred-recipe fixture app (no project contract: discovery's `npm ci` and `npm start`, signed-out scenarios only) through the production Docker host and lifecycle, as
 * the worker does, and keeps a copy of the completed run's out directory. The candidate is a copy of the fixture, as a `git archive` extraction would be.
 */
export async function runInferredProbe(options: InferredPlanOptions = {}): Promise<ProbeRun> {
  const fixture = createInferredExecutorPlan(options);
  const keep = realpathSync(await mkdtemp(join(tmpdir(), "rovara-inferred-kept-")));
  kept.push(keep);
  const candidate = join(keep, "candidate");
  for (const file of INFERRED_APP_FILES) await cp(join(INFERRED_FIXTURE_ROOT, file), join(candidate, file), { recursive: true });
  let credentialsLeaked: boolean | null = null; let outDir: string | null = null;
  const { host } = await createLinuxHost(fixture, {
    candidateSourceDir: candidate,
    async onRunOutput(run) {
      await cp(run.outDir, join(keep, "out"), { recursive: true });
      outDir = join(keep, "out");
      const files = (await readdir(outDir, { withFileTypes: true, recursive: true })).filter((entry) => entry.isFile());
      credentialsLeaked = (await Promise.all(files.map(async (entry) => run.containsCredential(await readFile(join(entry.parentPath, entry.name)))))).some(Boolean);
    },
  });
  const run = await runIsolatedE2EApplication({ input: webApiProbeRunInput(fixture) as never, compiled: fixture.compiled, ports: host, signal: AbortSignal.timeout(280_000) });
  return { fixture, run, exitCode: run.lifecycle.process.exitCode, outDir, credentialsLeaked, host };
}
