/**
 * F1: Code's settings rows, all of them: today the install layer (install-rows.ts). The customer layer's rows (a company's, a project's, a person's settings) join in L1c.
 * Cloud's rows live in the Cloud repository under the same schema; no key may be in both (keys.ts).
 */
import type { SettingRow } from "./types.js";
import { CONFIG_ONLY_ROWS, INSTALL_ROWS } from "./install-rows.js";

export { CONFIG_ONLY_ROWS, INSTALL_ROWS } from "./install-rows.js";

export const CODE_SETTING_ROWS: readonly SettingRow[] = [...INSTALL_ROWS, ...CONFIG_ONLY_ROWS];

/** The keys of Code's rows: all of Code's rows the Cloud repository needs for its no-key-in-both test. */
export const SETTING_KEYS: readonly string[] = CODE_SETTING_ROWS.map((row) => row.key);
