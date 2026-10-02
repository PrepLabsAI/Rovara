// Spec 025 A13: the broker's production health probes, from fake CloudWatch and SQS clients. Only
// the environment's values decide what is set up, and a client is called only by a probe.
import type { DescribeAlarmsCommand, DescribeAlarmsCommandOutput } from "@aws-sdk/client-cloudwatch";
import type { GetQueueAttributesCommand, GetQueueAttributesCommandOutput } from "@aws-sdk/client-sqs";
import { describe, expect, it } from "vitest";
import { HEALTH_ALARM_SUFFIXES } from "@agentx/contracts";
import { healthProbes, type HealthProbeInput } from "../../packages/broker/src/aws/health-probes.js";
import { createAdminReadBroker } from "../support/admin-read-broker.js";

const QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/111111111111/agentx-live25d-planted-queue";

function fakes(options: { pages?: DescribeAlarmsCommandOutput[]; queues?: Record<string, GetQueueAttributesCommandOutput | Error> } = {}) {
  const alarmCalls: DescribeAlarmsCommand["input"][] = [];
  const queueCalls: GetQueueAttributesCommand["input"][] = [];
  const logs: Array<Record<string, unknown>> = [];
  const pages = [...(options.pages ?? [])];
  const input = {
    cloudWatch: { send: async (command: DescribeAlarmsCommand) => { alarmCalls.push(command.input); return pages.shift() ?? { $metadata: {} }; } },
    sqs: {
      send: async (command: GetQueueAttributesCommand) => {
        queueCalls.push(command.input);
        const answer = options.queues?.[command.input.QueueUrl ?? ""];
        if (answer === undefined) throw new Error("unexpected queue");
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
    github: { installationCount: async () => 2 },
    log: (entry: Record<string, unknown>) => { logs.push(entry); },
  } satisfies Partial<HealthProbeInput>;
  return { input, alarmCalls, queueCalls, logs };
}

describe("the broker's production health probes (A13)", () => {
  it("sets up neither alarms nor queues without their variables, and calls nothing", async () => {
    const { input, alarmCalls, queueCalls } = fakes();
    const probes = healthProbes(input);
    expect(probes).not.toHaveProperty("alarms");
    expect(probes).not.toHaveProperty("queueDepths");
    expect(probes).not.toHaveProperty("release");
    expect(probes).not.toHaveProperty("slackAuthCheck");
    expect(await probes.githubInstallations?.()).toBe(2);
    expect(alarmCalls).toEqual([]);
    expect(queueCalls).toEqual([]);
  });

  it("passes the release and the Slack auth check through", async () => {
    const { input } = fakes();
    const probes = healthProbes({ ...input, release: "0.0.6", slackAuthCheck: async () => ({ ok: true as const, teamId: "T1" }) });
    expect(probes.release).toBe("0.0.6");
    expect(await probes.slackAuthCheck?.()).toEqual({ ok: true, teamId: "T1" });
  });

  it("asks for every alarm a named environment can create, by exact name under the prefix, never by prefix (issue 206)", async () => {
    const { input, alarmCalls } = fakes({ pages: [{ $metadata: {}, MetricAlarms: [{ AlarmName: "agentx-live25d-SlackDeadLetters", StateValue: "OK" }] }] });
    const probes = healthProbes({ ...input, alarmPrefix: "agentx-live25d-" });
    expect(alarmCalls).toEqual([]);
    // Every other listed alarm is reported missing, except the two that exist only on Bedrock.
    expect(await probes.alarms?.()).toStrictEqual([
      { name: "agentx-live25d-SlackDeadLetters", state: "OK" },
      ...HEALTH_ALARM_SUFFIXES.filter((suffix) => !["SlackDeadLetters", "BedrockThrottling", "ClassifierThrottling"].includes(suffix))
        .map((suffix) => ({ name: `agentx-live25d-${suffix}`, state: "MISSING" })),
    ]);
    // A prefix listing is authorized against *, which the broker is not granted; named alarms are
    // authorized against their own ARNs, which its agentx-<env>-* grant covers.
    expect(alarmCalls).toStrictEqual([{ AlarmNames: HEALTH_ALARM_SUFFIXES.map((suffix) => `agentx-live25d-${suffix}`), AlarmTypes: ["MetricAlarm"], MaxRecords: 100 }]);
  });

  it("reads every page of the named metric alarms, only when asked (issue 206)", async () => {
    const { input, alarmCalls } = fakes({ pages: [
      { $metadata: {}, MetricAlarms: [{ AlarmName: "agentx-live25d-A", StateValue: "OK" }], NextToken: "page-2" },
      { $metadata: {}, MetricAlarms: [{ AlarmName: "agentx-live25d-B", StateValue: "ALARM" }, {}] },
    ] });
    const probes = healthProbes({ ...input, alarmPrefix: "agentx-live25d-", alarmSuffixes: ["A", "B"] });
    expect(alarmCalls).toEqual([]);
    expect(await probes.alarms?.()).toEqual([
      { name: "agentx-live25d-A", state: "OK" },
      { name: "agentx-live25d-B", state: "ALARM" },
      { name: "", state: "INSUFFICIENT_DATA" },
    ]);
    expect(alarmCalls).toStrictEqual([
      { AlarmNames: ["agentx-live25d-A", "agentx-live25d-B"], AlarmTypes: ["MetricAlarm"], MaxRecords: 100 },
      { AlarmNames: ["agentx-live25d-A", "agentx-live25d-B"], AlarmTypes: ["MetricAlarm"], MaxRecords: 100, NextToken: "page-2" },
    ]);
  });

  it("asks for at most 100 names a call, in order, so a long list is read in chunks (issue 206)", async () => {
    const suffixes = Array.from({ length: 205 }, (_, index) => `Alarm${index}`);
    const names = suffixes.map((suffix) => `agentx-live25d-${suffix}`);
    const { input, alarmCalls } = fakes({ pages: [
      { $metadata: {}, MetricAlarms: [{ AlarmName: names[0], StateValue: "OK" }] },
      { $metadata: {}, MetricAlarms: [{ AlarmName: names[100], StateValue: "ALARM" }] },
      { $metadata: {}, MetricAlarms: [{ AlarmName: names[204], StateValue: "OK" }] },
    ] });
    const probes = healthProbes({ ...input, alarmPrefix: "agentx-live25d-", alarmSuffixes: suffixes });
    const found = await probes.alarms?.();
    expect(found?.slice(0, 3)).toStrictEqual([
      { name: names[0], state: "OK" },
      { name: names[100], state: "ALARM" },
      { name: names[204], state: "OK" },
    ]);
    expect(found?.slice(3)).toStrictEqual(names.filter((_, index) => ![0, 100, 204].includes(index)).map((name) => ({ name, state: "MISSING" })));
    expect(alarmCalls).toStrictEqual([
      { AlarmNames: names.slice(0, 100), AlarmTypes: ["MetricAlarm"], MaxRecords: 100 },
      { AlarmNames: names.slice(100, 200), AlarmTypes: ["MetricAlarm"], MaxRecords: 100 },
      { AlarmNames: names.slice(200), AlarmTypes: ["MetricAlarm"], MaxRecords: 100 },
    ]);
  });

  it("calls nothing for an empty list, and reports no alarms", async () => {
    const { input, alarmCalls } = fakes();
    const probes = healthProbes({ ...input, alarmPrefix: "agentx-live25d-", alarmSuffixes: [] });
    expect(await probes.alarms?.()).toEqual([]);
    expect(alarmCalls).toEqual([]);
  });

  it("leaves out a sibling environment's alarms that share the prefix (prod's prefix also matches prod-eu)", async () => {
    // Alarm suffixes are single words (infra naming.alarmName), so a further hyphen after the
    // prefix belongs to another environment: agentx-prod-eu-SlackDeadLetters is prod-eu's.
    const { input } = fakes({ pages: [
      { $metadata: {}, MetricAlarms: [
        { AlarmName: "agentx-prod-SlackDeadLetters", StateValue: "OK" },
        { AlarmName: "agentx-prod-eu-SlackDeadLetters", StateValue: "ALARM" },
        { AlarmName: "agentx-prod-foundation-SessionReaperErrors", StateValue: "ALARM" },
      ] },
    ] });
    const probes = healthProbes({ ...input, alarmPrefix: "agentx-prod-", alarmSuffixes: ["SlackDeadLetters", "eu-SlackDeadLetters", "foundation-SessionReaperErrors"] });
    expect(await probes.alarms?.()).toStrictEqual([
      { name: "agentx-prod-SlackDeadLetters", state: "OK" },
      { name: "agentx-prod-eu-SlackDeadLetters", state: "MISSING" },
      { name: "agentx-prod-foundation-SessionReaperErrors", state: "MISSING" },
    ]);
  });

  it("answers the alarms unknown when CloudWatch refuses the call", async () => {
    const { input } = fakes();
    const denied = { ...input, cloudWatch: { send: async () => { throw Object.assign(new Error("not authorized"), { name: "AccessDenied" }); } } };
    const probes = healthProbes({ ...denied, alarmPrefix: "agentx-live25d-" });
    const { admin } = await createAdminReadBroker({ brokerExtra: { adminReads: { health: probes } } });
    const answer = await admin("GET", "/v1/admin/health");
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ alarms: [], alarmsCheck: { status: "unknown" } });
  });

  it("reads each listed queue's depth; a missing count or a failed read is null, logged without the URL", async () => {
    const { input, queueCalls, logs } = fakes({ queues: {
      "https://sqs.example/dispatch": { $metadata: {}, Attributes: { ApproximateNumberOfMessages: "3" } },
      "https://sqs.example/slack": { $metadata: {}, Attributes: {} },
      [QUEUE_URL]: Object.assign(new Error(`denied for ${QUEUE_URL}`), { name: "AccessDenied" }),
    } });
    const probes = healthProbes({ ...input, deadLetterQueues: JSON.stringify({ dispatch: "https://sqs.example/dispatch", "slack-requests": "https://sqs.example/slack", "developer-notices": QUEUE_URL }) });
    expect(queueCalls).toEqual([]);
    expect(await probes.queueDepths?.()).toEqual([
      { name: "dispatch", depth: 3 },
      { name: "slack-requests", depth: null },
      { name: "developer-notices", depth: null },
    ]);
    expect(queueCalls.map((call) => call.AttributeNames)).toEqual([["ApproximateNumberOfMessages"], ["ApproximateNumberOfMessages"], ["ApproximateNumberOfMessages"]]);
    expect(logs).toEqual([{ event: "admin.health_queue_failed", queue: "developer-notices", error: "AccessDenied" }]);
    expect(JSON.stringify(logs)).not.toContain("planted-queue");
  });

  it("builds with a malformed queue list, and the route answers the queues unknown", async () => {
    for (const malformed of ["{not json", "[\"https://sqs.example/dispatch\"]", "{\"dispatch\": 7}"]) {
      const { input } = fakes();
      const probes = healthProbes({ ...input, deadLetterQueues: malformed });
      await expect(probes.queueDepths?.()).rejects.toThrow();
      const { admin } = await createAdminReadBroker({ brokerExtra: { adminReads: { health: probes } } });
      const answer = await admin("GET", "/v1/admin/health");
      expect(answer.status).toBe(200);
      expect(answer.body).toMatchObject({ deadLetterQueues: [], deadLetterQueuesCheck: { status: "unknown" } });
    }
  });
});
