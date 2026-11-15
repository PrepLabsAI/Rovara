// Engine host (migration plan v3.2 lane E2): the switch that sends NEW tasks of a deployed install to the core instead of the spec 056 workflow.
//
// One combined switch moves merge tracking, the build step and the task flow together. The per-area keys stay so a later lane can narrow one area, never widen it:
//
//   ROVARA_CORE_ENGINE                          the combined switch. `off` (or absent, or empty) sends every NEW task down the spec 056 workflow. Default: off.
//   ROVARA_CORE_ENGINE_MERGE / _BUILD / _FLOW   optional per-area narrowing: an area is on only where BOTH the combined switch and its own key say on.
//                                               Absent: the area follows the combined switch.
//
// A value is `off`, `on` (every company), `on:<company id>[:<company id>...]`, or `drain` (no new task on the core; the tasks it holds are served to their end).
// Anything else reads as OFF and is reported as a problem: a typo never switches a company over.
//
// A switch decides only where a NEW task starts. A task records its engine when it starts (engine-stamp.ts) and keeps it to the end, so turning the switch off never
// moves a running task. Ported from the monolith's host root (its flags.ts); the variable names are Code's own.
import { CORE_ENGINE_VARIABLE, OrgIdSchema, type OrgId } from "@agentx/contracts";

export { CORE_ENGINE_VARIABLE };

/** The step groups the combined switch moves. `decide`, `sessions` and `notify` ride with `flow` until a lane splits them. */
export const CORE_AREAS = ["merge", "build", "flow"] as const;
export type CoreArea = (typeof CORE_AREAS)[number];

export type CoreSwitch = { mode: "off" } | { mode: "on" } | { mode: "on-for"; companies: readonly OrgId[] };

export const CORE_AREA_VARIABLES: Readonly<Record<CoreArea, string>> = {
  merge: "ROVARA_CORE_ENGINE_MERGE",
  build: "ROVARA_CORE_ENGINE_BUILD",
  flow: "ROVARA_CORE_ENGINE_FLOW",
};

const OFF: CoreSwitch = { mode: "off" };

export interface ParsedSwitch {
  value: CoreSwitch;
  /** `drain`: the switch is off for NEW tasks, and the core still serves the tasks it holds to their end (callbacks, jobs, dispatch). The way back is on -> drain -> none in flight -> off. */
  drain?: true;
  /** Why the raw text was not a switch value (it then reads as off). Never echoes the text: it may be anything. */
  problem?: string;
}

/** Reads one switch value. Fail closed: anything that is not exactly a switch value is OFF. */
export function parseCoreSwitch(raw: string | undefined): ParsedSwitch {
  const text = raw?.trim() ?? "";
  if (text === "" || text === "off" || text === "0") return { value: OFF };
  if (text === "on") return { value: { mode: "on" } };
  if (text === "drain") return { value: OFF, drain: true };
  if (!text.startsWith("on:")) return { value: OFF, problem: "not off, on, drain or on:<company ids>" };
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

export interface CoreEngineFlags {
  /** The combined switch. */
  combined: CoreSwitch;
  /** Each area's own narrowing key; undefined: it follows `combined`. */
  areas: Readonly<Partial<Record<CoreArea, CoreSwitch>>>;
  /** Values that could not be read (each read as off). */
  problems: readonly { variable: string; problem: string }[];
  /** The combined switch says `drain`: no new task on the core, its tasks served to the end. */
  drain?: boolean;
}

export const CORE_ENGINE_OFF: CoreEngineFlags = Object.freeze({ combined: OFF, areas: Object.freeze({}), problems: Object.freeze([]) });

/** The switches from a function's environment. */
export function readCoreEngineFlags(env: NodeJS.ProcessEnv = process.env): CoreEngineFlags {
  const problems: { variable: string; problem: string }[] = [];
  const combined = parseCoreSwitch(env[CORE_ENGINE_VARIABLE]);
  if (combined.problem !== undefined) problems.push({ variable: CORE_ENGINE_VARIABLE, problem: combined.problem });
  const areas: Partial<Record<CoreArea, CoreSwitch>> = {};
  for (const area of CORE_AREAS) {
    const variable = CORE_AREA_VARIABLES[area];
    if (env[variable] === undefined) continue;
    const parsed = parseCoreSwitch(env[variable]);
    if (parsed.problem !== undefined) problems.push({ variable, problem: parsed.problem });
    // An area key can narrow, never serve on its own: `drain` on an area reads as off for that area.
    areas[area] = parsed.value;
  }
  return { combined: combined.value, areas, problems, ...(combined.drain === true ? { drain: true } : {}) };
}

/** Whether a NEW task of this company runs this area on the core. Both the combined switch and the area's own key (when set) must cover it. */
export function coreAreaOn(flags: CoreEngineFlags, area: CoreArea, companyId: string): boolean {
  if (!switchCovers(flags.combined, companyId)) return false;
  const own = flags.areas[area];
  return own === undefined || switchCovers(own, companyId);
}

/** Whether any area is on for any company: when false the host root builds nothing for new tasks. */
export function anyCoreAreaOn(flags: CoreEngineFlags): boolean {
  if (flags.combined.mode === "off") return false;
  return CORE_AREAS.some((area) => {
    const own = flags.areas[area];
    return own === undefined || own.mode !== "off";
  });
}

/**
 * Whether a function should build the host root at all: the combined switch is not off (`on`, `on:<ids>` or `drain`). Distinct from `anyCoreAreaOn` (whether a NEW task may start on the core):
 * in `drain` the root is built and serves the core's tasks to their end, while every new task stays on the spec 056 workflow. The infrastructure's CoreEngineIsOn condition is the same rule.
 */
export function coreEngineServes(flags: CoreEngineFlags): boolean {
  return flags.combined.mode !== "off" || flags.drain === true;
}

/** The companies the core serves new tasks for (for the scheduled jobs that run per company). `all` when the combined switch is plain `on`. */
export function coreCompanies(flags: CoreEngineFlags): readonly OrgId[] | "all" {
  if (!anyCoreAreaOn(flags)) return [];
  return flags.combined.mode === "on" ? "all" : flags.combined.mode === "on-for" ? flags.combined.companies : [];
}

/** A short, stable text of the switches, kept on each task's stamp so a reader can tell which settings a task started under. Holds ids only. */
export function flagSnapshot(flags: CoreEngineFlags): string {
  const one = (value: CoreSwitch): string => (value.mode === "on-for" ? `on:${[...value.companies].sort().join(":")}` : value.mode);
  const parts = [`cc=${one(flags.combined)}`, ...CORE_AREAS.flatMap((area) => (flags.areas[area] === undefined ? [] : [`${area}=${one(flags.areas[area])}`]))];
  return parts.join(";");
}
