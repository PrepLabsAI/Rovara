// Spec 025 A13: the health route's production probes, built only from what the environment
// provides. Named environments set the alarm prefix and the queue list; the legacy deployment sets
// neither, so alarms and queues answer "not set up". A client is called only by a probe, when a
// request asks for health; building the probes calls nothing and parses nothing.
import { DescribeAlarmsCommand, type DescribeAlarmsCommandOutput } from "@aws-sdk/client-cloudwatch";
import { GetQueueAttributesCommand, type GetQueueAttributesCommandOutput } from "@aws-sdk/client-sqs";
import type { SlackAuthCheckResponse } from "@agentx/contracts";
import type { AdminHealthProbes } from "./admin-health.js";

export interface HealthProbeInput {
  cloudWatch: { send(command: DescribeAlarmsCommand): Promise<DescribeAlarmsCommandOutput> };
  sqs: { send(command: GetQueueAttributesCommand): Promise<GetQueueAttributesCommandOutput> };
  /** AGENTX_RELEASE_VERSION. */
  release?: string | undefined;
  /** AGENTX_ALARM_PREFIX: `agentx-<env>-`, named environments only. */
  alarmPrefix?: string | undefined;
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

export function healthProbes(input: HealthProbeInput): AdminHealthProbes {
  const { alarmPrefix: prefix, deadLetterQueues: queues } = input;
  return {
    ...(input.release ? { release: input.release } : {}),
    ...(prefix ? {
      alarms: async () => {
        const found: Array<{ name: string; state: string }> = [];
        let NextToken: string | undefined;
        do {
          const page = await input.cloudWatch.send(new DescribeAlarmsCommand({ AlarmNamePrefix: prefix, MaxRecords: 100, ...(NextToken === undefined ? {} : { NextToken }) }));
          // CloudWatch always returns both fields; the fallbacks only keep the types total. An
          // empty name matches no alarm an admin would act on, and INSUFFICIENT_DATA is neither
          // OK nor ALARM, so a missing field can never hide a firing alarm or report one falsely.
          for (const alarm of [...(page.MetricAlarms ?? []), ...(page.CompositeAlarms ?? [])]) {
            const name = alarm.AlarmName ?? "";
            // Alarm suffixes are single words (infra naming.alarmName), so a further hyphen after
            // the prefix names a sibling environment: prod's prefix also matches agentx-prod-eu-*.
            if (name.startsWith(prefix) && name.slice(prefix.length).includes("-")) continue;
            found.push({ name, state: alarm.StateValue ?? "INSUFFICIENT_DATA" });
          }
          NextToken = page.NextToken;
        } while (NextToken !== undefined);
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
