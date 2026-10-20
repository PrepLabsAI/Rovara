#!/usr/bin/env tsx
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { executorContainerArgs } from "../packages/verifier/src/host/executor-container.js";
import { verifyExecutorSeccompProfile } from "../packages/verifier/src/host/executor-seccomp.js";

/**
 * The one definition of how the executor image is smoke-tested. It is used by the release path (`smokeTestExecutor` in release-common.ts, which test-deploy
 * uses too), by the CI `linux-runtime` job and by the release workflow's executor push (`npx tsx scripts/executor-smoke.ts <image>`, before anything is pushed).
 * The container runs as the worker's Docker host runs the executor: the sandbox and limit flags come from `executorContainerArgs` in the verifier, the same
 * source the host builds the executor's `docker run` from, and the profile is checked by the same `verifyExecutorSeccompProfile` the host uses. Only the
 * network (none), the mounts and `--pull=never` differ. Chromium's own sandbox is on and never skipped: without the pinned seccomp profile it fails closed.
 * It imports the verifier's built output, so run `npm run build` first.
 */

/** The pinned profile in this checkout (the file the worker image ships); the Docker CLI reads it on the machine that runs `docker`. */
export function repoExecutorSeccompProfilePath(): string {
  return resolve(fileURLToPath(new URL("../packages/verifier/assets/executor-seccomp.json", import.meta.url)));
}

/** `docker` arguments of the smoke run; throws unless `profilePath` is the regular file with exactly the bytes pinned in contracts. */
export function executorSmokeDockerArgs(image: string, profilePath: string = repoExecutorSeccompProfilePath()): string[] {
  return ["run", "--rm", "--network", "none", ...executorContainerArgs(verifyExecutorSeccompProfile(profilePath)), image, "node", "/opt/agentx/packages/verifier/dist/executor/smoke.js"];
}

/** What Chromium and the smoke check say when the sandbox itself could not start or is not shown to be on. */
const SANDBOX_FAILURE = /No usable sandbox|Failed to move to new namespace|chromium is not sandboxed/i;
/** Chromium exited before it listened: the sandbox is the likely reason on a restricted Docker VM, but not the only one. */
const EARLY_EXIT = /chromium exited before it opened a debugging port/i;

const VM_FIX = [
  "The VM's kernel probably blocks unprivileged user namespaces for AppArmor-confined containers. On colima run:",
  "  colima ssh -- sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0",
  "(temporary: it resets when the VM restarts) and retry. On another Linux Docker host run the same sysctl there; also check user.max_user_namespaces is above 0.",
  "The executor never runs Chromium with --no-sandbox: the fix is the VM's setting, never the image or the flags.",
];

/**
 * An operator-facing explanation of a failed smoke run (`output` is its stderr and stdout together), or null when it is not about Chromium. Only the
 * sandbox's own messages get the Docker VM diagnosis as the cause; an early exit alone is "probably the sandbox, or another early crash".
 */
export function explainExecutorSmokeFailure(output: string): string | null {
  if (SANDBOX_FAILURE.test(output)) {
    return ["executor image smoke test failed: Chromium's sandbox could not start in this Docker VM (the container ran under the pinned seccomp profile with every capability dropped).", ...VM_FIX].join("\n");
  }
  if (EARLY_EXIT.test(output)) {
    return ["executor image smoke test failed: Chromium exited before it opened a debugging port. That is probably its sandbox, or another early crash: read the output above.",
      "If the output names the sandbox, namespaces or permissions:", ...VM_FIX].join("\n");
  }
  return null;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const image = process.argv[2];
  if (image === undefined) { process.stderr.write("usage: tsx scripts/executor-smoke.ts <executor image>\n"); process.exit(2); }
  const result = spawnSync("docker", executorSmokeDockerArgs(image), { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const explained = explainExecutorSmokeFailure(`${result.stderr}\n${result.stdout}`);
    if (explained !== null) process.stderr.write(`\n${explained}\n`);
    process.exit(result.status ?? 1);
  }
}
