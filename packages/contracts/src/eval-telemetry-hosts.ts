// L4-EINT (owner DEC 254zzz71): the TELEMETRY AND ANALYTICS hosts an eval's code may send events to (an error tracker, a trace collector, a product-analytics tool). A call to one of them gets a plain `OK` from the eval
// stand-in and is NOT a gap: it can never mark a run, so it can never make a failing question "not compared". The PR names the entries that were answered ("Telemetry calls answered with OK: sentry.io, posthog.com").
//
// THE LIST IS FIXED. It is this file's constant and nothing else: no repository file, environment variable, plan, setting or answer can add a host to it (`evalTelemetryEntryOf` takes a host name and reads only this
// constant; a test builds a plan, a recording and a setting that name a host and checks it is refused). A repository that sends its own events to its own collector gets the ordinary stand-in rule for an unplanned host
// (a made-up answer, counted: a gap), because a collector the list does not name could be anything. Editing the list is a code change, pinned by `tests/unit/eval-telemetry-hosts.test.ts` (the whole list is written out there).
//
// Matching is exact: a host is an entry when it IS the entry's name or ends with `.<name>` (a label boundary, so `notsentry.io` and `sentry.io.example.test` are not). Names are lower-case DNS names.
export interface EvalTelemetryEntry {
  /** What the PR shows (a name from this list only, never the host the code asked for). */
  readonly id: string;
  /** The exact domains: the name itself and every sub-domain of it. */
  readonly domains: readonly string[];
}

export const EVAL_TELEMETRY_HOSTS: readonly EvalTelemetryEntry[] = Object.freeze([
  { id: "sentry.io", domains: ["sentry.io"] },
  { id: "posthog.com", domains: ["posthog.com"] },
  { id: "datadoghq.com", domains: ["datadoghq.com", "datadoghq.eu"] },
  { id: "segment.io", domains: ["segment.io", "segment.com"] },
  { id: "mixpanel.com", domains: ["mixpanel.com"] },
  { id: "amplitude.com", domains: ["amplitude.com"] },
  { id: "honeycomb.io", domains: ["honeycomb.io"] },
  { id: "newrelic.com", domains: ["newrelic.com", "nr-data.net"] },
  { id: "grafana.net", domains: ["grafana.net"] },
  { id: "bugsnag.com", domains: ["bugsnag.com"] },
  { id: "rollbar.com", domains: ["rollbar.com"] },
  { id: "google-analytics.com", domains: ["google-analytics.com"] },
].map((entry) => Object.freeze({ id: entry.id, domains: Object.freeze([...entry.domains]) })));

/** The most entries one run's result names. */
export const EVAL_TELEMETRY_NAMES_MAX = EVAL_TELEMETRY_HOSTS.length;

const BY_ID: ReadonlySet<string> = new Set(EVAL_TELEMETRY_HOSTS.map((entry) => entry.id));
/** Whether a text is one of the fixed list's entry names (what a result may carry). */
export const isEvalTelemetryId = (value: unknown): value is string => typeof value === "string" && BY_ID.has(value);

/** The entry a host belongs to, or undefined. Only the fixed list is read. A host that is an address, has a trailing dot, upper-case letters or anything but plain DNS characters is not an entry. */
export function evalTelemetryEntryOf(host: unknown): string | undefined {
  if (typeof host !== "string" || host.length < 3 || host.length > 253 || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(host) || host.includes("..")) return undefined;
  for (const entry of EVAL_TELEMETRY_HOSTS) {
    for (const domain of entry.domains) if (host === domain || host.endsWith(`.${domain}`)) return entry.id;
  }
  return undefined;
}

/** The fixed answer of the stand-in to a telemetry call (any method, any path): 200 and `OK`. */
export const EVAL_TELEMETRY_ANSWER = Object.freeze({ status: 200, contentType: "text/plain", body: "OK" });
/** The fixed class word the stand-in's header carries for it. */
export const EVAL_TELEMETRY_CLASS = "telemetry";
/** The PR words (fixed; the names come from the fixed list). */
export const evalTelemetryLine = (ids: readonly string[]): string | undefined => {
  const named = [...new Set(ids.filter(isEvalTelemetryId))].sort();
  return named.length === 0 ? undefined : `Telemetry calls answered with OK: ${named.join(", ")}.`;
};
