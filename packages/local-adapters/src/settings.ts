// Port lane L3: reading a plug-in's block of the config file (`PluginContext.settings`). The config is owner-controlled, but a typo in
// it should be named, not ignored, so unknown settings are refused. No secret is ever read here.
import { isAbsolute, resolve } from "node:path";
import type { JsonObject, JsonValue } from "@agentx/contracts";

export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsError";
  }
}

export function allowOnly(settings: JsonObject, allowed: readonly string[]): void {
  for (const key of Object.keys(settings)) if (!allowed.includes(key)) throw new SettingsError(`unknown setting ${JSON.stringify(key).slice(0, 40)}`);
}

export function optionalNumber(settings: JsonObject, key: string, minimum: number, maximum: number): number | undefined {
  const value: JsonValue | undefined = settings[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) throw new SettingsError(`${key} is a whole number from ${minimum} to ${maximum}`);
  return value;
}

/** The database file. A relative path is relative to the folder the process runs in. `:memory:` is refused: a configured store keeps its data. */
export function databasePath(settings: JsonObject): string {
  const value = settings.path;
  if (typeof value !== "string" || value === "" || value.includes("\u0000")) throw new SettingsError("path is the database file, as text");
  if (value === ":memory:" || value.startsWith("file:")) throw new SettingsError("path is a file path (not :memory: or a file: URL)");
  return isAbsolute(value) ? value : resolve(value);
}

export function synchronousSetting(settings: JsonObject): "FULL" | "NORMAL" | undefined {
  const value = settings.synchronous;
  if (value === undefined) return undefined;
  if (value !== "FULL" && value !== "NORMAL") throw new SettingsError("synchronous is FULL or NORMAL");
  return value;
}
