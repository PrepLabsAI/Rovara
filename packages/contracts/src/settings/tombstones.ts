/**
 * F1 lane L0: retired settings. A lane that removes a setting adds one entry here; readers drop a tombstoned stored field without failing (precedent: LEGACY_FRESH_SIGN_IN in
 * Cloud's company settings). The lint (scripts/settings-lints.ts, `tombstones`) fails when a tombstoned key appears anywhere except this file, the store adapters' tolerant-read
 * code and the stored-document tests. Empty until the first removal lane (R1) lands; L0, L1a-0 and L1b remove nothing.
 */
import type { SettingTombstone } from "./types.js";

export const SETTING_TOMBSTONES: readonly SettingTombstone[] = [];
