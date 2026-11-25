/**
 * F1 lane L0: the never-loosen rule as ONE function, not per lane.
 *
 * A lane that turns a stored, enforced value into a constant, or merges it into another row, must not loosen a limit somebody set. `effective` gives the STRICTER of the stored
 * value and the constant for a row that loosens; a row that loosens nothing takes the stored value, else the constant. A lane that would change a stored value must also run the
 * read-only count of stored values stricter than the constant and stop for the owner when it is above zero (never silently drop).
 *
 * Inverse rule for learning: nothing may turn learning OFF for a company that has it on, so its row has no `loosens` and the lane only ever makes it more on.
 */
import type { SettingLoosens } from "./types.js";

export function effective(row: { readonly loosens?: SettingLoosens }, stored: number | undefined, constant: number): number;
export function effective(row: { readonly loosens?: SettingLoosens }, stored: boolean | undefined, constant: boolean): boolean;
export function effective(row: { readonly loosens?: SettingLoosens }, stored: number | boolean | undefined, constant: number | boolean): number | boolean {
  if (stored === undefined) return constant;
  if (typeof stored === "boolean" && typeof constant === "boolean") {
    // `on` loosens: the stricter value is off. `off` loosens: the stricter value is on.
    if (row.loosens === "on") return stored && constant;
    if (row.loosens === "off") return stored || constant;
    return stored;
  }
  if (typeof stored === "number" && typeof constant === "number") {
    // `higher` loosens: the stricter value is the lower one. `lower` loosens: the stricter value is the higher one.
    if (row.loosens === "higher") return Math.min(stored, constant);
    if (row.loosens === "lower") return Math.max(stored, constant);
    return stored;
  }
  throw new Error("effective() takes a stored value and a constant of the same type");
}
