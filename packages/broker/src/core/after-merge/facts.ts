// What the watcher takes in, checked at runtime (a type is not a check): a deploy fact from any source, and an alarm from the trigger events the engine already defines. Both are untrusted. A fact that does not check
// is ignored with fixed words; nothing here echoes the input.
import { createHash } from "node:crypto";
import { COMMIT_ID_PATTERN, TriggerEventSchema, type EventSource } from "@agentx/contracts";
import { inertLine } from "../proof/inert-text.js";
import { isEnvironmentName } from "./settings.js";
import { DEPLOY_STATES, type DeployFact, type DeployFactSource } from "./ports.js";

const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u;
const FACT_KEYS = new Set(["repository", "revision", "environment", "state", "source"]);
const SOURCES: readonly DeployFactSource[] = ["code_host", "ci_import"];

/** True for `owner/name` as a code host could have issued it. */
export const isRepositoryName = (value: unknown): value is string => typeof value === "string" && REPOSITORY.test(value);

/** The fact with its repository and revision in lower case, or undefined when any part is missing, of the wrong type, unknown, or extra. */
export function parseDeployFact(value: unknown): DeployFact | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!FACT_KEYS.has(key)) return undefined;
  const { repository, revision, environment, state, source } = record;
  if (!isRepositoryName(repository) || typeof revision !== "string" || !COMMIT_ID_PATTERN.test(revision.toLowerCase())) return undefined;
  if (!isEnvironmentName(environment) || !(DEPLOY_STATES as readonly unknown[]).includes(state) || !(SOURCES as readonly unknown[]).includes(source)) return undefined;
  return { repository: repository.toLowerCase(), revision: revision.toLowerCase(), environment, state: state as DeployFact["state"], source: source as DeployFactSource };
}

/** The trigger events that are alarms: what the engine already names (decision 62 E1 closes that list; nothing is added). A Vercel deployment error counts, since it is a failing deploy someone should hear about. */
const ALARM_TYPES: Readonly<Partial<Record<EventSource, readonly string[]>>> = {
  cloudwatch: ["alarm.fired"], datadog: ["monitor.triggered"], sentry: ["alert.triggered"], grafana: ["alert.firing"], pagerduty: ["incident.triggered"], vercel: ["deployment.error"],
};

export interface AlarmFact { source: EventSource; type: string; project: string; occurredAtMs: number; signalKey: string; label: string }

/** The key of one alarm (its source, type and name), for the "It's expected" press: 64 hex characters, never the alarm's own words. */
export function signalKeyOf(input: { source: string; type: string; subjectId: string }): string {
  return createHash("sha256").update(`${input.source}\n${input.type}\n${input.subjectId}`).digest("hex");
}
export const SIGNAL_KEY = /^[0-9a-f]{64}$/u;

const LABEL_MAX = 120;

export type AlarmReading = { kind: "invalid" } | { kind: "not_an_alarm" } | { kind: "alarm"; fact: AlarmFact };

/** Reads a trigger event as an alarm. A shape that does not parse is `invalid`; a valid event that is not an alarm type is `not_an_alarm`. */
export function readAlarm(value: unknown): AlarmReading {
  const parsed = TriggerEventSchema.safeParse(value);
  if (!parsed.success) return { kind: "invalid" };
  const event = parsed.data;
  if (!(ALARM_TYPES[event.source] ?? []).includes(event.type)) return { kind: "not_an_alarm" };
  const occurredAtMs = Date.parse(event.occurredAt);
  if (!Number.isFinite(occurredAtMs)) return { kind: "invalid" };
  // The alarm's own words are untrusted text that reaches a pull request and a chat: made inert and cut. The input is cut first, so the work is bounded.
  const label = inertLine(event.subject.title.slice(0, 600), LABEL_MAX) || inertLine(event.subject.id.slice(0, 600), LABEL_MAX) || "an alarm";
  return { kind: "alarm", fact: { source: event.source, type: event.type, project: event.project, occurredAtMs, signalKey: signalKeyOf({ source: event.source, type: event.type, subjectId: event.subject.id }), label } };
}
