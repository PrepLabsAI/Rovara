// Port lane P6 (item E1, owner decision 62): the ids of event sources, event types and trackers are OPEN, and an adapter registers its own. The fixed lists in `trigger-specs.ts` (`EVENT_SOURCES`, `EVENT_TYPES`),
// `intake.ts` (`INTAKE_CHANNELS`) and `connections.ts` (`ConnectionTypeSchema`) keep exactly the entries they have and get NO new ones (a test holds them): a tracker or a monitoring source that Rovara does not
// know registers itself instead. Nothing here names a vendor.
//
// Chains and triggers are not switched on in Code yet (decision 45.10), so no reader of the fixed lists is changed here. When they are, they check a trigger with `checkEventTrigger` below, which takes
// the built-in lists AND what the registered adapters declared, and an unknown source, type or filter key is refused (never read as "any").
import { z } from "zod";
import { EVENT_FILTER_KEYS, EVENT_SOURCES, EVENT_TYPES, TRIGGER_FILTER_VALUES_MAX } from "./trigger-specs.js";

/** An event source, tracker or intake system id: lower-case words, digits, hyphens and underscores (the shape `IntakeSystemSchema` already uses). */
export const OpenSourceIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/u, "a short lower-case name");
/** An event type: dotted lower-case words, such as `issue.created` or `item.assigned_to_rovara`. */
export const OpenEventTypeSchema = z.string().max(60).regex(/^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/u, "dotted lower-case words such as issue.created");
const FilterKeySchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/u);

/**
 * What an adapter declares about the events it can start work from: for each event type, the keys a trigger may filter on. The source id is the adapter's own kind (a tracker called `examplehost`
 * registers the source `examplehost`).
 */
export const EventSourceRegistrationSchema = z.object({
  types: z.record(OpenEventTypeSchema, z.array(FilterKeySchema).max(10)).refine((types) => Object.keys(types).length >= 1 && Object.keys(types).length <= 32, "one to thirty-two event types"),
}).strict();
export type EventSourceRegistration = z.infer<typeof EventSourceRegistrationSchema>;

/** A source id with its declaration: what a caller holds after reading the registry. */
export interface RegisteredEventSource extends EventSourceRegistration {
  source: string;
}

export function isBuiltInEventSource(source: string): boolean {
  return (EVENT_SOURCES as readonly string[]).includes(source);
}

export interface SkippedEventSource {
  source: string;
  /** `built_in_id`: the id belongs to a built-in source (a Linear or Jira tracker's natural kind), so its registration is not used; `duplicate`: another registration has it; `invalid`: the id or its types are not well formed. */
  reason: "built_in_id" | "duplicate" | "invalid";
}

/**
 * The event sources a trigger may name: the built-in ones and the registered ones. One registration that cannot be used is SKIPPED and reported, it never fails the others (a tracker whose kind is `jira`
 * must not make every trigger check fail): a plug-in adds a source, it cannot take over `github`, and the built-in entry of that name stays the one in force. Returns a map from source id to its event types
 * and their filter keys, and the registrations that were skipped (for a log line or the admin page).
 */
export function eventSourceCatalog(registered: readonly RegisteredEventSource[]): { sources: ReadonlyMap<string, Readonly<Record<string, readonly string[]>>>; skipped: SkippedEventSource[] } {
  const sources = new Map<string, Readonly<Record<string, readonly string[]>>>();
  const skipped: SkippedEventSource[] = [];
  for (const source of EVENT_SOURCES) {
    const types: Record<string, readonly string[]> = {};
    for (const type of EVENT_TYPES[source]) types[type] = Object.hasOwn(EVENT_FILTER_KEYS, `${source}:${type}`) ? EVENT_FILTER_KEYS[`${source}:${type}`]! : [];
    sources.set(source, types);
  }
  for (const entry of registered) {
    const id = OpenSourceIdSchema.safeParse(entry.source);
    const types = EventSourceRegistrationSchema.safeParse({ types: entry.types });
    if (!id.success || !types.success) {
      skipped.push({ source: id.success ? id.data : "invalid", reason: "invalid" });
      continue;
    }
    if (sources.has(id.data)) {
      skipped.push({ source: id.data, reason: isBuiltInEventSource(id.data) ? "built_in_id" : "duplicate" });
      continue;
    }
    sources.set(id.data, types.data.types);
  }
  return { sources, skipped };
}

/**
 * Why a trigger's event spec is not allowed, in plain words; `[]` when it is. An unknown source, an unknown type, a filter key the type does not take and a filter with too many values are refused.
 */
export function checkEventTrigger(spec: { source: string; type: string; filter?: Readonly<Record<string, readonly string[]>> | undefined }, registered: readonly RegisteredEventSource[]): string[] {
  const types = eventSourceCatalog(registered).sources.get(spec.source);
  if (types === undefined) return [`there is no event source called ${spec.source}`];
  const keys = Object.hasOwn(types, spec.type) ? types[spec.type] : undefined;
  if (keys === undefined) return [`${spec.source} has no ${spec.type} event; it has ${Object.keys(types).join(", ")}`];
  const problems: string[] = [];
  for (const [key, values] of Object.entries(spec.filter ?? {})) {
    if (!keys.includes(key)) problems.push(`${spec.type} can't be filtered by ${key}; it takes ${keys.join(", ") || "no filters"}`);
    else if (values.length === 0 || values.length > TRIGGER_FILTER_VALUES_MAX) problems.push(`${key} takes one to ${String(TRIGGER_FILTER_VALUES_MAX)} values`);
  }
  return problems;
}
