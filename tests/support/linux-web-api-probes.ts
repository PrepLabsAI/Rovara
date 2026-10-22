import { chmodSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { collectE2EApplicationRun } from "../../packages/verifier/src/application-collection.js";
import { createProcessDockerCli } from "../../packages/verifier/src/host/docker-application-host.js";
import { createWebApiProbeRunner, type WebApiProbeRunnerDeps } from "../../packages/verifier/src/host/web-api-probe-runner.js";
import { createScriptedQualificationModelChannel } from "../../packages/worker/src/e2e-qualification-model-channel.js";

/**
 * The CI runner is not the EC2 worker: its Node sits at a different path than the executor container's, and the collector checks that the toolchain
 * the executor reported is the one reading the result. So this swaps in the reported path for the duration of that one check; nothing else about
 * the production runner is changed.
 */
export const collectOnThisHost: typeof collectE2EApplicationRun = (input) => {
  const original = process.execPath;
  process.execPath = input.actual.runnerToolchain.execPath;
  try { return collectE2EApplicationRun(input); } finally { process.execPath = original; }
};

/**
 * The production probe runner on this host's real Docker; the Linux tests' only way to run a qualification probe. The agent probes run behind the worker's real scripted model channel.
 * The proxy hands its socket to uid 1000 only when the worker is root (the EC2 worker is); a CI runner's own user owns it and the executor image runs as `node` (1000), so a test
 * opens the socket file to every local user for the run (the socket sits in a 0700 directory of the run that nothing else can enter).
 */
export function createLinuxProbeRunner(input: Omit<WebApiProbeRunnerDeps, "docker" | "collect" | "modelChannelFor">) {
  return createWebApiProbeRunner({ ...input, docker: createProcessDockerCli(), collect: collectOnThisHost,
    modelChannelFor: (request) => createScriptedQualificationModelChannel(request, { afterOpen: (path) => chmodSync(path, 0o666) }) });
}

const scratch: string[] = [];
/** A throwaway run root (shared with the Docker host at the same path) and a private evidence root for one qualification. */
export async function linuxProbeScratch(): Promise<{ runRoot: string; evidenceRoot: string }> {
  // Short on purpose: the model socket of an agent probe (<runRoot>/<run id>/model/model.sock) must fit a unix socket's 103 bytes, and a CI runner's tmpdir can be far deeper.
  const root = await realpath(await mkdtemp("/tmp/rvwa-"));
  scratch.push(root);
  const evidenceRoot = join(root, "evidence");
  await mkdir(evidenceRoot, { mode: 0o700 });
  await chmod(evidenceRoot, 0o700);
  return { runRoot: join(root, "runs"), evidenceRoot };
}
export async function removeWebApiProbeScratch(): Promise<void> {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}
