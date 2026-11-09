// Port lane L2: what the plug-in modules of this folder share. A module reads its own `settings` block of the plug-in config file; it fails with a
// `bad_config` that names the fields that are wrong and never echoes a value (a setting can sit next to a path or a name that is private).
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { PluginRegistryError, type JsonObject } from "@agentx/contracts";

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
 * not a secret store, and it is printed by tools that show configuration). A file is an absolute path.
 */
export const SecretSourceSchema = z.union([
  z.object({ env: z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/) }).strict(),
  z.object({ file: z.string().min(1).max(1_024).refine((path) => isAbsolute(path), "an absolute path") }).strict(),
]);
export type SecretSource = z.infer<typeof SecretSourceSchema>;

/** The most bytes of a secret file that are read: a signing secret is a few dozen bytes. */
export const SECRET_FILE_MAX_BYTES = 65_536;

/**
 * A reader that fetches the secret each time it is called (so a rotation is picked up), and fails with a fixed sentence when it is not there.
 * A file is held to the model key file's rules: opened once without following a link, a plain file, not readable by other users (on systems
 * that have modes), and small; it is checked and read through the one handle.
 */
export function secretReader(source: SecretSource, environment: NodeJS.ProcessEnv = process.env): (options?: { refresh?: boolean }) => Promise<string> {
  const unavailable = (): Error => new Error("the secret is not available");
  return async () => {
    let value: string | undefined;
    if ("env" in source) {
      value = environment[source.env];
    } else {
      let handle;
      try {
        handle = await open(source.file, constants.O_RDONLY | constants.O_NOFOLLOW);
      } catch {
        throw unavailable();
      }
      try {
        const details = await handle.stat();
        if (!details.isFile() || details.size > SECRET_FILE_MAX_BYTES || (process.platform !== "win32" && (details.mode & 0o077) !== 0)) throw unavailable();
        value = await handle.readFile("utf8");
      } finally {
        await handle.close();
      }
    }
    const trimmed = value?.trim();
    if (trimmed === undefined || trimmed === "") throw unavailable();
    return trimmed;
  };
}
