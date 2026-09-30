// Spec 025 A13: the broker's production health probes, from fake CloudWatch and SQS clients. Only
// the environment's values decide what is set up, and a client is called only by a probe.
import type { DescribeAlarmsCommand, DescribeAlarmsCommandOutput } from "@aws-sdk/client-cloudwatch";
import type { GetQueueAttributesCommand, GetQueueAttributesCommandOutput } from "@aws-sdk/client-sqs";
import { describe, expect, it } from "vitest";
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

  it("reads every page of the prefix's metric and composite alarms, only when asked", async () => {
    const { input, alarmCalls } = fakes({ pages: [
      { $metadata: {}, MetricAlarms: [{ AlarmName: "agentx-live25d-A", StateValue: "OK" }], NextToken: "page-2" },
      { $metadata: {}, CompositeAlarms: [{ AlarmName: "agentx-live25d-B", StateValue: "ALARM" }], MetricAlarms: [{}] },
    ] });
    const probes = healthProbes({ ...input, alarmPrefix: "agentx-live25d-" });
    expect(alarmCalls).toEqual([]);
    expect(await probes.alarms?.()).toEqual([
      { name: "agentx-live25d-A", state: "OK" },
      { name: "", state: "INSUFFICIENT_DATA" },
      { name: "agentx-live25d-B", state: "ALARM" },
    ]);
    expect(alarmCalls).toEqual([
      { AlarmNamePrefix: "agentx-live25d-", MaxRecords: 100 },
      { AlarmNamePrefix: "agentx-live25d-", MaxRecords: 100, NextToken: "page-2" },
    ]);
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
