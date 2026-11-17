// DEC 254zb (TE-C5 part C): what one machine of each size costs, for the setup card's cost note and, once the owner decides how machine time meets the
// spending caps (plan Q5), a machine start's admission estimate. Nothing charges or holds money from this table yet.
//
// A pinned table, not a live AWS Price List read: the EC2 offer file is several gigabytes, too big for a Lambda to read per start. The figures are the on-demand Linux,
// shared-tenancy list prices per hour, the same in us-east-1 and us-west-2 (Code's SUPPORTED_REGIONS), as of PRICES_CHECKED; a release re-checks them with a read-only
// `aws pricing get-products` on staging. The estimate is cautious: the list price plus MACHINE_PRICE_MARGIN_PERCENT, rounded UP to whole micros. A size or region not in the
// table has no estimate (undefined), never $0. Disks and data transfer are the same for every size and are not part of it.
import type { Cost } from "./ports/json.js";
import { MACHINE_LAUNCH_TYPES } from "./machine-size-launch.js";

export const MACHINE_PRICES_CHECKED = "2026-11-17 (AWS on-demand list prices; re-check on staging before switch-on)";
/** The regions whose list price for these types is the one below. */
export const MACHINE_PRICE_REGIONS: readonly string[] = Object.freeze(["us-east-1", "us-west-2"]);
/** Added on top of the list price, in percent, so an estimate is never below what AWS charges. */
export const MACHINE_PRICE_MARGIN_PERCENT = 10;

/** US dollars per hour, on-demand Linux, per instance type. */
export const MACHINE_HOURLY_USD: Readonly<Record<string, number>> = Object.freeze({
  "m6g.large": 0.077,
  "m6g.xlarge": 0.154,
  "m6g.2xlarge": 0.308,
  "m6i.large": 0.096,
  "m6i.xlarge": 0.192,
  "m6i.2xlarge": 0.384,
});

const MICROS_PER_USD = 1_000_000;


/** The cautious cost of `minutes` (a whole number, 1 to 10,080) on one machine of `rowId` in `region`. Undefined for anything not in the table. */
export function machineCost(rowId: unknown, region: unknown, minutes: number): Cost | undefined {
  if (typeof rowId !== "string" || !Object.hasOwn(MACHINE_LAUNCH_TYPES, rowId)) return undefined;
  if (typeof region !== "string" || !MACHINE_PRICE_REGIONS.includes(region)) return undefined;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10_080) return undefined;
  const hourly = MACHINE_HOURLY_USD[MACHINE_LAUNCH_TYPES[rowId]!.instanceType];
  if (hourly === undefined) return undefined;
  // Whole numbers only (list prices have at most 4 decimals): micros per hour, times (100 + margin) percent, times minutes, over 60 x 100, rounded up.
  const microsPerHour = Math.round(hourly * MICROS_PER_USD);
  return { micros: Math.ceil((microsPerHour * (100 + MACHINE_PRICE_MARGIN_PERCENT) * minutes) / 6000), currency: "USD" };
}
