// L4-NETG follow-up (DEC 254zzz90): the exact S3 hosts a project's allowed websites lifted from the sandbox S3 deny, published for the worker host's egress gateway.
//
// The gateway (contracts egress-gateway-source.ts, host mode) denies every Amazon S3 name to the sandbox side (sandbox-deny-domains.ts) except exact hosts listed in ONE small file it reads from a folder only this worker can write
// (sandbox-egress.sh makes /var/lib/rovara-egress, owned by the worker's user, read-only in the gateway; no sandbox mounts it). Each prepare rewrites it from the project's list, so a host that left the project's allowed websites leaves
// the file too, and a prepare with no S3 host removes it. Only gateway-mode workers have the folder; anywhere else this does nothing. A failure here is logged and never fatal: the S3 simply stays denied.
import { lstat, rename, rm, writeFile } from "node:fs/promises";
import { isProjectAllowableS3Host, PROJECT_S3_ALLOW_MAX } from "@agentx/contracts";
import { gatewayEgressFromEnvironment } from "./task-sandbox.js";

/** Fixed: the gateway reads exactly this path; nothing in the environment or the project can name another. */
export const EGRESS_ALLOW_DIRECTORY = "/var/lib/rovara-egress";
export const EGRESS_ALLOW_FILE = `${EGRESS_ALLOW_DIRECTORY}/project-allow.json`;

export async function publishEgressS3Allow(hosts: readonly string[] | undefined, environment: NodeJS.ProcessEnv = process.env, directory: string = EGRESS_ALLOW_DIRECTORY): Promise<"published" | "cleared" | "skipped" | "failed"> {
  if (!gatewayEgressFromEnvironment(environment)) return "skipped";
  const file = `${directory}/project-allow.json`;
  try {
    const folder = await lstat(directory);
    if (!folder.isDirectory() || folder.isSymbolicLink()) return "failed";
    const clean = [...new Set((hosts ?? []).filter((host) => isProjectAllowableS3Host(host)))].sort().slice(0, PROJECT_S3_ALLOW_MAX);
    if (clean.length === 0) {
      await rm(file, { force: true });
      return "cleared";
    }
    const temporary = `${file}.${String(process.pid)}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ hosts: clean })}\n`, { mode: 0o600 });
    await rename(temporary, file);
    return "published";
  } catch {
    // The S3 stays denied: a stale file is removed when it can be, and the gateway treats an unreadable one as empty.
    await rm(file, { force: true }).catch(() => undefined);
    return "failed";
  }
}
