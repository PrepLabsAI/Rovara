#!/usr/bin/env tsx
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { E2E_EXECUTOR_SECCOMP_PROFILE_SHA256 } from "../packages/contracts/src/e2e-executor.js";

/**
 * The one definition of how the executor image is smoke-tested, shared by the release path (`smokeTestExecutor` in release-common.ts, which test-deploy uses
 * too) and the CI `linux-runtime` job (`tsx scripts/executor-smoke.ts <image>`): the executor container as the worker's Docker host runs it, with
 * Chromium's own sandbox on. Without the pinned seccomp profile Chromium fails closed, as it must; there is no flag that skips the sandbox.
 */

/** The pinned profile in this checkout (the file the worker image ships); the Docker CLI reads it on the machine that runs `docker`. */
export function repoExecutorSeccompProfilePath(): string {
  return resolve(fileURLToPath(new URL("../packages/verifier/assets/executor-seccomp.json", import.meta.url)));
}

/** `docker` arguments of the smoke run; throws unless `profilePath` is a regular file with exactly the bytes pinned in contracts. */
export function executorSmokeDockerArgs(image: string, profilePath: string = repoExecutorSeccompProfilePath()): string[] {
  let bytes: Buffer;
  try {
    const info = lstatSync(profilePath);
    if (!info.isFile() || info.size > 128 * 1024) throw new Error("not a regular file of plausible size");
    bytes = readFileSync(profilePath);
  } catch (error) { throw new Error(`executor-seccomp-profile-unreadable: ${error instanceof Error ? error.message : "unreadable"}`, { cause: error }); }
  if (createHash("sha256").update(bytes).digest("hex") !== E2E_EXECUTOR_SECCOMP_PROFILE_SHA256) throw new Error("executor-seccomp-profile-digest-mismatch");
  return ["run", "--rm", "--init", "--network", "none", "--cap-drop=ALL", "--security-opt", "no-new-privileges", "--security-opt", `seccomp=${profilePath}`,
    "--read-only", "--tmpfs", "/tmp:rw,exec,nosuid,nodev,size=512m", "--shm-size", "1g",
    image, "node", "/opt/agentx/packages/verifier/dist/executor/smoke.js"];
}

const SANDBOX_FAILURE = /No usable sandbox|Failed to move to new namespace|chromium exited before it opened a debugging port|chromium is not sandboxed/i;

/**
 * An operator-facing explanation when the smoke output shows Chromium's sandbox could not start, else null. On a Docker VM whose kernel restricts
 * unprivileged user namespaces for AppArmor-confined containers (Ubuntu 24.04, as in colima's default VM) that restriction has to be lifted for the
 * VM; the sandbox is never turned off.
 */
export function explainExecutorSmokeFailure(output: string): string | null {
  if (!SANDBOX_FAILURE.test(output)) return null;
  return [
    "executor image smoke test failed: Chromium's sandbox could not start in this Docker VM (the container ran under the pinned seccomp profile with every capability dropped).",
    "The VM's kernel probably blocks unprivileged user namespaces for AppArmor-confined containers. On colima run:",
    "  colima ssh -- sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0",
    "(temporary: it resets when the VM restarts) and retry. On another Linux Docker host run the same sysctl there; also check user.max_user_namespaces is above 0.",
    "The executor never runs Chromium with --no-sandbox: the fix is the VM's setting, never the image or the flags.",
  ].join("\n");
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const image = process.argv[2];
  if (image === undefined) { process.stderr.write("usage: tsx scripts/executor-smoke.ts <executor image>\n"); process.exit(2); }
  const result = spawnSync("docker", executorSmokeDockerArgs(image), { stdio: ["ignore", "inherit", "pipe"], encoding: "utf8" });
  process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const explained = explainExecutorSmokeFailure(result.stderr);
    if (explained !== null) process.stderr.write(`\n${explained}\n`);
    process.exit(result.status ?? 1);
  }
}
