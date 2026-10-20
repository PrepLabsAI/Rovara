import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { E2E_EXECUTOR_SECCOMP_PROFILE_SHA256 } from "@agentx/contracts";

const MAX_PROFILE_BYTES = 128 * 1024;

/**
 * Where the executor container's seccomp profile sits on the worker. The Docker CLI reads a `--security-opt seccomp=<path>` file on the client side,
 * which is the worker container, so the profile ships in the worker image beside the other verifier assets instead of being installed on the host at boot.
 */
export function installedExecutorSeccompProfilePath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "../../assets/executor-seccomp.json");
}

/**
 * Returns `path` (the installed profile by default) only when it is a regular file holding exactly the bytes pinned in contracts. Anything else throws:
 * the executor never starts under a profile that is not the reviewed one, and there is no unconfined or default-profile fallback.
 */
export function verifyExecutorSeccompProfile(path: string = installedExecutorSeccompProfilePath()): string {
  let bytes: Buffer;
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.size > MAX_PROFILE_BYTES) throw new Error("not a regular file of plausible size");
    bytes = readFileSync(path);
  } catch (error) { throw new Error(`executor-seccomp-profile-unreadable: ${error instanceof Error ? error.message : "unreadable"}`, { cause: error }); }
  if (createHash("sha256").update(bytes).digest("hex") !== E2E_EXECUTOR_SECCOMP_PROFILE_SHA256) throw new Error("executor-seccomp-profile-digest-mismatch");
  return path;
}
