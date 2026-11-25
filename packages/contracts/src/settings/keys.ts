/**
 * F1 lane L0: the key list and the one-key-one-repository rule.
 *
 * Code's rows and Cloud's rows are two files under ONE schema. A key may be in only one of them: `assertNoKeyInBoth` is what Cloud's test calls with Code's `SETTING_KEYS` (the
 * only part of Code's rows the Cloud repository needs, exported through the browser-safe API package when F3 moves this folder), and what Code's own test calls with a fixture.
 * Cloud's rows file (packages/contracts/src/settings-rows.ts there, written with `defineRow` from the pinned package) is a follow-up: Cloud is not in this repository.
 */
import type { SettingRow } from "./types.js";

export function settingKeys(rows: readonly SettingRow[]): string[] {
  return rows.map((row) => row.key);
}

/** The keys that are in both lists, sorted. */
export function keysInBoth(code: readonly string[], cloud: readonly string[]): string[] {
  const inCode = new Set(code);
  return [...new Set(cloud.filter((key) => inCode.has(key)))].sort();
}

export function assertNoKeyInBoth(code: readonly string[], cloud: readonly string[]): void {
  const both = keysInBoth(code, cloud);
  if (both.length > 0) throw new Error(`a setting key must be owned by one repository; in both Code's and Cloud's rows: ${both.join(", ")}`);
}
