// Port lane L2: what the plug-in modules of this folder share. A module reads its own `settings` block of the plug-in config file; it fails with a
// `bad_config` that names the fields that are wrong and never echoes a value (a setting can sit next to a path or a name that is private).
import { readFile } from "node:fs/promises";
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
 * not a secret store, and it is printed by tools that show configuration).
 */
export const SecretSourceSchema = z.union([
  z.object({ env: z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/) }).strict(),
  z.object({ file: z.string().min(1).max(1_024) }).strict(),
]);
export type SecretSource = z.infer<typeof SecretSourceSchema>;

/** A reader that fetches the secret each time it is called (so a rotation is picked up), and fails with a fixed sentence when it is not there. */
export function secretReader(source: SecretSource, environment: NodeJS.ProcessEnv = process.env): (options?: { refresh?: boolean }) => Promise<string> {
  return async () => {
    const value = "env" in source ? environment[source.env] : await readFile(source.file, "utf8").catch(() => undefined);
    const trimmed = value?.trim();
    if (trimmed === undefined || trimmed === "") throw new Error("the secret is not available");
    return trimmed;
  };
}
