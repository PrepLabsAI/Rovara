// Engine host: the on/off switch grammar the core's own feature switches share (the lessons switch, the system-runs flag), and the step groups of the core.
//
// The core engine has no switch (#1275, D1): every NEW task of a deployed install starts on the core. Whether an EXISTING task is the core's is its mark (core-task-mark.ts, `isCoreTask`
// in aws/engine-boundary.ts), never a setting here.
//
// A feature switch value is `off`, `on` (every company) or `on:<company id>[:<company id>...]`. Anything else reads as OFF and is reported as a problem: a typo never switches a company over.
import { OrgIdSchema, type OrgId } from "@agentx/contracts";

/** The step groups of a core task: the registry's plug-in points, the scheduled jobs and the required services are grouped by them (never a routing input: every area is always on). `decide`, `sessions` and `notify` ride with `flow`. */
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
