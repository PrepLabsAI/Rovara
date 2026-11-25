// SETUP-CHECK-WATCH (gap C): a worker that could not deliver an operation's end to the broker logs `terminal_callback.failed`; the control plane counts the line (a metric filter on the worker log group)
// and alarms on the count. Exactly two new resources, in every deployment (the legacy production template too), no new permission, and the health probe reads the alarm.
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { HEALTH_ALARM_SUFFIXES } from "@agentx/contracts";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { environmentNaming } from "../../infra/lib/naming.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";
import { withoutWorkerCallbackAlarm } from "../support/worker-callback-alarm-template.js";

skipLambdaBundling();

describe("the worker's lost-callback alarm", () => {
  const named = Template.fromStack(new ControlPlaneStack(new App(), "CallbackAlarmControlPlane", { naming: environmentNaming("staging") }));
  const legacy = Template.fromStack(new ControlPlaneStack(new App(), "CallbackAlarmLegacyControlPlane"));

  it("adds the filter and the alarm and nothing else, in a named environment and the legacy production install", () => {
    for (const template of [named, legacy]) {
      const json = structuredClone(template.toJSON()) as { Resources: Record<string, { Type: string }> };
      const before = Object.keys(json.Resources).length;
      withoutWorkerCallbackAlarm(json);
      // Four: the worker's filter and alarm, and the dispatcher's stale-address filter and alarm (`withoutWorkerCallbackAlarm` takes both pairs out).
      expect(before - Object.keys(json.Resources).length).toBe(4);
    }
  });

  it("names the named environment's log group, metric namespace and alarm", () => {
    named.hasResourceProperties("AWS::Logs::MetricFilter", { LogGroupName: "/agentx/staging/worker", FilterPattern: "{ $.event = \"terminal_callback.failed\" }", MetricTransformations: [{ MetricName: "WorkerTerminalCallbackFailed", MetricNamespace: "AgentX/staging", MetricValue: "1" }] });
    named.hasResourceProperties("AWS::CloudWatch::Alarm", { AlarmName: "agentx-staging-WorkerTerminalCallbackFailed", MetricName: "WorkerTerminalCallbackFailed", Namespace: "AgentX/staging", Threshold: 1 });
    legacy.hasResourceProperties("AWS::Logs::MetricFilter", { LogGroupName: "/agentx/production/worker" });
    legacy.hasResourceProperties("AWS::CloudWatch::Alarm", { AlarmName: "AgentXWorkerTerminalCallbackFailed", Namespace: "AgentX" });
  });

  it("is read by the admin health probe, and grants no permission", () => {
    expect(HEALTH_ALARM_SUFFIXES).toContain("WorkerTerminalCallbackFailed");
    for (const template of [named, legacy]) {
      const policies = JSON.stringify(template.findResources("AWS::IAM::Policy"));
      expect(policies).not.toContain("PutMetricFilter");
      expect(policies).not.toContain("terminal_callback");
    }
  });
});
