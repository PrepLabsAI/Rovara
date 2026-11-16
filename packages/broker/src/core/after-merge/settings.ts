// The `afterMergeWatch` setting of a project, checked. The watcher is OFF unless the setting says `enabled: true` and every other part of it is one this code knows. The setting is its own: the automations switch
// (decisions 149 and 143c) does not stop the watcher, because it starts no paid work and never uses the unattended door (decision 160, item 5).
//
// A value from the store is untrusted: an unknown key, a wrong type, a number out of range, an unknown revert mode or a reader that throws all mean "off", never a guess at what was meant.
import type { OrgId } from "@agentx/contracts";
import type { AfterMergeSettings, AfterMergeSettingsReader } from "./ports.js";

export const AFTER_MERGE_DEFAULT_WINDOW_MINUTES = 30;
export const AFTER_MERGE_WINDOW_MINUTES_MAX = 1_440;
export const ENVIRONMENTS_MAX = 20;
/** An environment name is at most this many characters, with no control or format characters and no space at either end. */
export const ENVIRONMENT_NAME_MAX = 64;
const NO_CONTROLS = /^[^\p{Cc}\p{Cf}]+$/u;
const SETTING_KEYS = new Set(["enabled", "windowMinutes", "environments", "revert"]);

export function isEnvironmentName(value: unknown): value is string {
  return typeof value === "string" && Array.from(value).length <= ENVIRONMENT_NAME_MAX && value.length > 0 && NO_CONTROLS.test(value) && value.trim() === value;
}

/** The checked setting, or undefined (off) for anything that is not exactly an enabled, well-formed setting. */
export function parseAfterMergeSettings(value: unknown): AfterMergeSettings | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!SETTING_KEYS.has(key)) return undefined;
  if (record["enabled"] !== true) return undefined;
  const window = record["windowMinutes"] ?? AFTER_MERGE_DEFAULT_WINDOW_MINUTES;
  if (typeof window !== "number" || !Number.isInteger(window) || window < 1 || window > AFTER_MERGE_WINDOW_MINUTES_MAX) return undefined;
  const environments = record["environments"] ?? [];
  if (!Array.isArray(environments) || environments.length > ENVIRONMENTS_MAX || !environments.every(isEnvironmentName)) return undefined;
  const revert = record["revert"] ?? "report_only";
  if (revert !== "report_only" && revert !== "offer_revert") return undefined;
  return { windowMinutes: window, environments: [...environments], revert };
}

/** The project's setting, read live, or undefined (off): no reader, a reader that throws, or a value that does not check. */
export async function afterMergeSettingsOf(reader: AfterMergeSettingsReader | undefined, orgId: OrgId, project: string): Promise<AfterMergeSettings | undefined> {
  if (reader === undefined) return undefined;
  try {
    return parseAfterMergeSettings(await reader.read(orgId, project));
  } catch {
    return undefined;
  }
}
