import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/** The one built-in host entry of M1.1: the executor's CLI host, serving both the web-Chromium and the API-HTTP target. */
export const E2E_EXECUTOR_HOST_PROFILE_ID = "linux-arm64-web-api-v1" as const;
export const E2E_EXECUTOR_HOST_ENTRY_POINT_ID = "rovara-e2e-executor-host/v1" as const;
export const E2E_EXECUTOR_HOST_MODULE_PATH = "dist/executor/host-entry.js" as const;
/**
 * The host module is one re-export line, so its emitted bytes, and therefore the digest the registry pins, are the same everywhere. The broker takes the
 * descriptor an admission names from here, with no file to read; a test keeps the digest equal to the registry's and the source equal to this line.
 */
export const E2E_EXECUTOR_HOST_ENTRY_SOURCE = 'export { createE2EApplicationCliHost } from "./host.js";\n' as const;
export const E2E_EXECUTOR_HOST_DESCRIPTOR = Object.freeze({ entryPointId: E2E_EXECUTOR_HOST_ENTRY_POINT_ID,
  entryPointManifestDigest: createHash("sha256").update(E2E_EXECUTOR_HOST_ENTRY_SOURCE).digest("hex") });
const REGISTRY_PATH = "assets/application-runtime-v1/cli-hosts.json";

const registrySchema = z.object({ schemaVersion: z.literal("application-cli-host-registry/v1"),
  hosts: z.array(z.object({ profileId: z.string().min(1).max(120), entryPointId: z.string().min(1).max(120),
    entryPointManifestDigest: z.string().regex(/^[a-f0-9]{64}$/), modulePath: z.string().min(1).max(2048) }).strict()).max(12) }).strict();

export type ExecutorHostAvailability = Readonly<{ available: true } | { available: false; reason: string }>;

/**
 * Answers, before any case runs, whether the installed registry names a host module for this compiled suite. The CLI process
 * would otherwise discover a missing registry as a raw file error halfway through its config load; the executor reports the
 * run unavailable instead.
 */
export async function verifyExecutorHostRegistration(cliHost: { profileId: string; descriptor: { entryPointId: string; entryPointManifestDigest: string } },
  options: { packageRoot?: string } = {}): Promise<ExecutorHostAvailability> {
  const root = resolve(options.packageRoot ?? join(dirname(fileURLToPath(import.meta.url)), "../.."));
  let registryText: string;
  try { registryText = await readFile(join(root, REGISTRY_PATH), "utf8"); }
  catch { return { available: false, reason: "host registry is not installed in this verifier package" }; }
  let registry: z.infer<typeof registrySchema>;
  try { registry = registrySchema.parse(JSON.parse(registryText)); }
  catch { return { available: false, reason: "host registry is not a valid registry document" }; }
  const rows = registry.hosts.filter((row) => row.profileId === cliHost.profileId && row.entryPointId === cliHost.descriptor.entryPointId
    && row.entryPointManifestDigest === cliHost.descriptor.entryPointManifestDigest);
  if (rows.length !== 1) return { available: false, reason: "the compiled suite names a CLI host that this package does not register" };
  const modulePath = resolve(root, rows[0]!.modulePath);
  const rel = relative(root, modulePath);
  if (isAbsolute(rows[0]!.modulePath) || rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return { available: false, reason: "the registered host module path escapes the verifier package" };
  }
  let moduleBytes: Buffer;
  try { moduleBytes = await readFile(modulePath); }
  catch { return { available: false, reason: "the registered host module is not built" }; }
  if (createHash("sha256").update(moduleBytes).digest("hex") !== rows[0]!.entryPointManifestDigest) {
    return { available: false, reason: "the registered host module differs from its manifest digest" };
  }
  return { available: true };
}
