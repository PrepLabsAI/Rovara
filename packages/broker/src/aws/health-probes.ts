// Spec 025 A13: the health route's production probes, built only from what the environment
// provides. Named environments set the alarm prefix and the queue list; the legacy deployment sets
// neither, so alarms and queues answer "not set up". A client is called only by a probe, when a
// request asks for health; building the probes calls nothing and parses nothing.
import { DescribeAlarmsCommand, type DescribeAlarmsCommandOutput } from "@aws-sdk/client-cloudwatch";
import { GetQueueAttributesCommand, type GetQueueAttributesCommandOutput } from "@aws-sdk/client-sqs";
import { HEALTH_ALARM_CONDITIONAL_SUFFIXES, HEALTH_ALARM_SUFFIXES, MISSING_ALARM_STATE, type SlackAuthCheckResponse } from "@agentx/contracts";
import type { AdminHealthProbes } from "./admin-health.js";

export interface HealthProbeInput {
  cloudWatch: { send(command: DescribeAlarmsCommand): Promise<DescribeAlarmsCommandOutput> };
  sqs: { send(command: GetQueueAttributesCommand): Promise<GetQueueAttributesCommandOutput> };
  /** AGENTX_RELEASE_VERSION. */
  release?: string | undefined;
  /** AGENTX_ALARM_PREFIX: `agentx-<env>-`, named environments only. */
  alarmPrefix?: string | undefined;
  /** The alarm suffixes to read; HEALTH_ALARM_SUFFIXES unless a test passes its own. */
  alarmSuffixes?: readonly string[] | undefined;
  /** HEALTH_DEAD_LETTER_QUEUES: JSON `{ "<name>": "<queue URL>" }`, named environments only. */
  deadLetterQueues?: string | undefined;
  slackAuthCheck?: (() => Promise<SlackAuthCheckResponse>) | undefined;
  github: { installationCount(): Promise<number> };
  log: (entry: Record<string, unknown>) => void;
}

/** A malformed list throws inside the probe, which the route answers as unknown. */
function queueList(value: string): Array<[string, string]> {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new TypeError("the dead-letter queue list is not an object");
  const entries = Object.entries(parsed);
  if (!entries.every((entry): entry is [string, string] => typeof entry[1] === "string")) throw new TypeError("a dead-letter queue URL is not a string");
  return entries;
}

// DescribeAlarms takes at most 100 names a call.
const ALARM_NAMES_PER_CALL = 100;

export function healthProbes(input: HealthProbeInput): AdminHealthProbes {
  const { alarmPrefix: prefix, alarmSuffixes: suffixes = HEALTH_ALARM_SUFFIXES, deadLetterQueues: queues } = input;
  const conditional = new Set<string>(HEALTH_ALARM_CONDITIONAL_SUFFIXES);
  return {
    ...(input.release ? { release: input.release } : {}),
    // Issue 206: by exact name, never by prefix. CloudWatch authorizes a call that names its alarms
    // against each alarm's ARN, which the broker's grant covers; a prefix listing is authorized
    // against *, which it is not granted, so it was always denied. Metric alarms only: composite
    // alarms need a grant on *, and the infra refuses to create one.
    ...(prefix ? {
      alarms: async () => {
        const listed = suffixes.map((suffix) => `${prefix}${suffix}`);
        const found: Array<{ name: string; state: string }> = [];
        for (let start = 0; start < listed.length; start += ALARM_NAMES_PER_CALL) {
          const AlarmNames = listed.slice(start, start + ALARM_NAMES_PER_CALL);
          let NextToken: string | undefined;
          do {
            const page = await input.cloudWatch.send(new DescribeAlarmsCommand({ AlarmNames, AlarmTypes: ["MetricAlarm"], MaxRecords: 100, ...(NextToken === undefined ? {} : { NextToken }) }));
            // CloudWatch always returns the fields; the fallbacks only keep the types total. An
            // empty name matches no alarm an admin would act on, and INSUFFICIENT_DATA is neither
            // OK nor ALARM, so a missing field can never hide a firing alarm or report one falsely.
            for (const alarm of page.MetricAlarms ?? []) {
              const name = alarm.AlarmName ?? "";
              // Alarm suffixes are single words (infra naming.alarmName), so a further hyphen after
              // the prefix names a sibling environment's alarm (agentx-prod-eu-* under agentx-prod-).
              // The probe asks only for listed single-word names, so this guards a malformed list.
              if (name.startsWith(prefix) && name.slice(prefix.length).includes("-")) continue;
              found.push({ name, state: alarm.StateValue ?? "INSUFFICIENT_DATA" });
            }
            NextToken = page.NextToken;
          } while (NextToken !== undefined);
        }
        // A listed alarm CloudWatch did not return was deleted, or never deployed: say so, rather
        // than let the route report fewer alarms as all clear. The throttling alarms exist only
        // on Bedrock, so their absence says nothing (and a deleted one on Bedrock goes unflagged).
        const returned = new Set(found.map((alarm) => alarm.name));
        for (const [index, name] of listed.entries()) {
          if (!returned.has(name) && !conditional.has(suffixes[index] ?? "")) found.push({ name, state: MISSING_ALARM_STATE });
        }
        return found;
      },
    } : {}),
    ...(queues ? {
      queueDepths: async () => Promise.all(queueList(queues).map(async ([name, url]) => {
        try {
          const attributes = await input.sqs.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ["ApproximateNumberOfMessages"] }));
          const count = Number(attributes.Attributes?.ApproximateNumberOfMessages ?? Number.NaN);
          // A missing or unreadable count was not read: null, never a reassuring 0.
          return { name, depth: Number.isFinite(count) ? count : null };
        } catch (error) {
          // The queue's name only: its URL carries the account.
          input.log({ event: "admin.health_queue_failed", queue: name, error: error instanceof Error ? error.name : "unknown" });
          return { name, depth: null };
        }
      })),
    } : {}),
    ...(input.slackAuthCheck === undefined ? {} : { slackAuthCheck: input.slackAuthCheck }),
    githubInstallations: () => input.github.installationCount(),
  };
}
