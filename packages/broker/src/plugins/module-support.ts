// Port lane L2: what the plug-in modules of this folder share. A module reads its own `settings` block of the plug-in config file; it fails with a
// `bad_config` that names the fields that are wrong and never echoes a value (a setting can sit next to a path or a name that is private).
import { isAbsolute } from "node:path";
import { z } from "zod";
import { IMPLICIT_COMPANY_ID, PluginRegistryError, type JsonObject, type PluginContext, type SecretValue } from "@agentx/contracts";
import { asSecretValue, createLocalSecretStore } from "../ports/secret-stores.js";

/** Parses a module's settings. The error lists field paths and the schema's own messages, never the values. */
export function readPluginSettings<T extends z.ZodType>(schema: T, settings: JsonObject, label: string): z.infer<T> {
  const parsed = schema.safeParse(settings);
  if (!parsed.success) {
    throw new PluginRegistryError("bad_config", `the settings of ${label} are not valid: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "settings"}: ${issue.message}`).join("; ")}`);
  }
  return parsed.data;
}

/**
 * Where a secret is read from, by name: an environment variable or a file. The config file never holds the secret itself (a settings block is
 * not a secret store, and it is printed by tools that show configuration). A file is an absolute path. This is Code's reference format for the
 * `secrets` socket: a `SecretSource` is a `SecretRef` (`@agentx/contracts`) that Code's adapter knows.
 */
export const SecretSourceSchema = z.union([
  z.object({ env: z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/) }).strict(),
  z.object({ file: z.string().min(1).max(1_024).refine((path) => isAbsolute(path), "an absolute path") }).strict(),
]);
export type SecretSource = z.infer<typeof SecretSourceSchema>;

/** The most bytes of a secret file that are read: a signing secret is a few dozen bytes. */
export { SECRET_FILE_MAX_BYTES } from "../ports/secret-stores.js";

const unavailable = (): Error => new Error("the secret is not available");

async function revealed(read: () => Promise<unknown>): Promise<string> {
  let value: SecretValue | undefined;
  try {
    value = asSecretValue(await read());
  } catch {
    throw unavailable();
  }
  const text = value?.reveal();
  if (text === undefined || text === "") throw unavailable();
  return text;
}

/**
 * A reader that fetches the secret each time it is called (so a rotation is picked up), and fails with a fixed sentence when it is not there.
 * It reads through Code's own `secrets` adapter (`createLocalSecretStore`): a file is held to the model key file's rules, opened once without
 * following a link, a plain file, not readable by other users on systems that have modes, and small.
 */
export function secretReader(source: SecretSource, environment: NodeJS.ProcessEnv = process.env): (options?: { refresh?: boolean }) => Promise<string> {
  const store = createLocalSecretStore({ environment });
  return () => revealed(() => store.read(IMPLICIT_COMPANY_ID, source));
}

/**
 * The same reader for a plug-in: the read goes to the registry's `secrets` adapter (owner decision 60), looked up on every read, so an adapter the config names is used
 * whatever its place in the config; with none registered it falls back to Code's own. A module uses this instead of writing a reader of its own.
 * A plug-in's settings secret is INSTALL-WIDE: it is read under the config's company (`defaultCompanyId`, the one implicit company in Code). A multi-company host (Cloud) must either read a
 * per-company secret by the caller's company with `SecretStore.read` itself, or change this helper to take the company per call; it must not rely on the default company for a secret that is a company's own.
 */
export function contextSecretReader(context: Pick<PluginContext, "registry" | "defaultCompanyId">, source: SecretSource, environment: NodeJS.ProcessEnv = process.env): (options?: { refresh?: boolean }) => Promise<string> {
  const fallback = createLocalSecretStore({ environment });
  return () => revealed(() => (context.registry.names("secrets").length > 0 ? context.registry.require("secrets") : fallback).read(context.defaultCompanyId, source));
}
