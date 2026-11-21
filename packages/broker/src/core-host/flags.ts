// Engine host: the on/off switch grammar the core's own feature switches share (the lessons switch, the system-runs flag), and the core engine's fixed setting.
//
// The core engine has no switch any more (#1275): every NEW task of a deployed install starts on the core. A task still records its engine when it starts (engine-stamp.ts) and keeps it to
// the end, so a task the spec 056 workflow started earlier is still routed there by its missing stamp until that workflow is removed (#1274).
//
// A feature switch value is `off`, `on` (every company) or `on:<company id>[:<company id>...]`. Anything else reads as OFF and is reported as a problem: a typo never switches a company over.
import { OrgIdSchema, type OrgId } from "@agentx/contracts";

/** The step groups of a core task. `decide`, `sessions` and `notify` ride with `flow`. */
export const CORE_AREAS = ["merge", "build", "flow"] as const;
export type CoreArea = (typeof CORE_AREAS)[number];

export type CoreSwitch = { mode: "off" } | { mode: "on" } | { mode: "on-for"; companies: readonly OrgId[] };

const OFF: CoreSwitch = { mode: "off" };

export interface ParsedSwitch {
  value: CoreSwitch;
  /** Why the raw text was not a switch value (it then reads as off). Never echoes the text: it may be anything. */
  problem?: string;
}

/** Reads one switch value. Fail closed: anything that is not exactly a switch value is OFF. */
export function parseCoreSwitch(raw: string | undefined): ParsedSwitch {
  const text = raw?.trim() ?? "";
  if (text === "" || text === "off" || text === "0") return { value: OFF };
  if (text === "on") return { value: { mode: "on" } };
  if (!text.startsWith("on:")) return { value: OFF, problem: "not off, on or on:<company ids>" };
  const ids = text.slice(3).split(":");
  if (ids.some((id) => !OrgIdSchema.safeParse(id).success)) return { value: OFF, problem: "a company id is not well formed" };
  return { value: { mode: "on-for", companies: [...new Set(ids)] as OrgId[] } };
}

export function switchCovers(value: CoreSwitch, companyId: string): boolean {
  switch (value.mode) {
    case "off": return false;
    case "on": return true;
    case "on-for": return value.companies.includes(companyId);
  }
}

/**
 * Whether a switch NAMES this company (`on:<company id>[:...]`). `on` (every company) names nobody: it cannot tell a pilot company from any other. Used where a default is on only for the companies an install
 * lists by name (the weekly lessons summary).
 */
export function switchNames(value: CoreSwitch, companyId: string): boolean {
  return value.mode === "on-for" && value.companies.includes(companyId);
}

/** The weekly summary's pilot list of this install: the host's own, else the companies the lessons switch names. */
export const digestPilotOf = (options: { lessonsSwitch: CoreSwitch; digestPilot?: ((companyId: OrgId) => boolean) | undefined }): ((companyId: OrgId) => boolean) =>
  options.digestPilot ?? ((companyId) => switchNames(options.lessonsSwitch, companyId));

/** Which engine each area of a NEW task starts on. Kept as a value (not a constant `true`) because each task's stamp records it (`flagSnapshot`). */
export interface CoreEngineFlags {
  /** The companies whose new tasks start on the core. */
  combined: CoreSwitch;
  /** An area's own narrowing; undefined: it follows `combined`. */
  areas: Readonly<Partial<Record<CoreArea, CoreSwitch>>>;
}

/** The install's setting since #1275: every area of every company's new task on the core. */
export const CORE_ENGINE_ON: CoreEngineFlags = Object.freeze({ combined: Object.freeze({ mode: "on" as const }), areas: Object.freeze({}) });

/** Whether a NEW task of this company runs this area on the core. Both the combined value and the area's own (when set) must cover it. */
export function coreAreaOn(flags: CoreEngineFlags, area: CoreArea, companyId: string): boolean {
  if (!switchCovers(flags.combined, companyId)) return false;
  const own = flags.areas[area];
  return own === undefined || switchCovers(own, companyId);
}

/** A short, stable text of the setting, kept on each task's stamp so a reader can tell which settings a task started under. Holds ids only. */
export function flagSnapshot(flags: CoreEngineFlags): string {
  const one = (value: CoreSwitch): string => (value.mode === "on-for" ? `on:${[...value.companies].sort().join(":")}` : value.mode);
  const parts = [`cc=${one(flags.combined)}`, ...CORE_AREAS.flatMap((area) => (flags.areas[area] === undefined ? [] : [`${area}=${one(flags.areas[area])}`]))];
  return parts.join(";");
}
