// Engine host (migration plan v3.2 lane E2): the core engine switch's deployment half, on the synthesised templates. Ported from the monolith's core-engine infrastructure test.
// What must hold:
//   1. the switch: a stack parameter CoreEngine, off by default, plain text only, a plain variable on the broker, set by `agentx config set coreEngine.switch`, kept by an upgrade;
//   2. the core dispatch queue: its own queue and dead letters, a redrive limit above the core's 20 attempts, the existing dispatch queue unchanged, granted to the broker only, on the queues' own
//      policies (the broker role's inline policy is at its size limit);
//   3. the job schedules: one per scheduled row of the core's job table, enabled only while the switch is not off, through a role that can invoke the broker and nothing else;
//   4. no new deploy-role service: CloudFormation's actions for these resource types are within the deploy role's and the boundary's services, and the new role has no fixed name.
//   5. (step 4) the dispatcher consumes the core queue: its own mapping, enabled only while the switch is not off, one record per invocation; reads of exactly that queue on its role; the
//      deleter start and the callback signing key only while the switch is not off; no EC2 terminate; the State table's outbox pending index. The legacy template has none of it.
// Dropped from the monolith's test, with reason: the packed-settings and Slack-ingress cases (Code's broker does not pack settings; the ingress wiring comes with the Slack step), the catalog
// repositories (another lane's), and the IAM simulation (Code has no simulator support; the services check stands in).
import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import {
  BOUNDARY_SERVICES, CORE_AGENT_MODEL_MAX_LENGTH, CORE_AGENT_MODEL_PATTERN, CORE_AGENT_MODEL_VARIABLE, CORE_MODEL_GATEWAY_HOST_MAX_LENGTH, CORE_MODEL_GATEWAY_HOST_PATTERN, CORE_MODEL_GATEWAY_URL_VARIABLE, CORE_DISPATCH_ATTEMPTS_MAX, CORE_DISPATCH_BATCH_SIZE, CORE_DISPATCH_DEAD_LETTER_URL_VARIABLE, CORE_DISPATCH_QUEUE_ARN_VARIABLE, CORE_DISPATCH_QUEUE_URL_VARIABLE, OUTBOX_PENDING_INDEX, CORE_ENGINE_BROKER_WIRED, CORE_DISPATCH_MAX_RECEIVES, CORE_ENGINE_PARAMETER_PATTERN, CORE_ENGINE_VARIABLE, CORE_JOB_EVENT_SOURCE, CORE_JOB_SCHEDULES, HEALTH_ALARM_SUFFIXES, POLICY_HOOK_PARAMETER_MAX_LENGTH,
  SERVICE_ROLE_SERVICES, coreDispatchDeadLetterName, coreDispatchQueueName,
} from "@agentx/contracts";
import { CORE_ANSWERS_MODEL_MAX_LENGTH, CORE_ANSWERS_MODEL_PATTERN, CORE_ANSWERS_MODEL_VARIABLE, CORE_CLAUDE_AGENT_MODEL } from "@agentx/contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { CORE_BROKER_QUEUE_ACTIONS, CORE_DISPATCHER_QUEUE_ACTIONS, CORE_DISPATCH_DEAD_LETTERS_ALARM } from "../../infra/lib/core-engine.js";
import { environmentNaming } from "../../infra/lib/naming.js";
import { DISPATCH_ATTEMPTS_MAX } from "../../packages/broker/src/core/task-flow/dispatch.js";
import { CORE_ENGINE_VARIABLE as BROKER_SWITCH_VARIABLE, CORE_JOBS, CORE_SCHEDULE_SOURCE, parseCoreSwitch, readCoreEngineFlags } from "../../packages/broker/src/core-host/index.js";
import { configKey, coreEngineValueWhenWired } from "../../packages/cli/src/config/keys.js";
import { OPERATOR_PARAMETERS } from "../../packages/cli/src/deploy/parameters.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Resource = { Type: string; Condition?: string; Properties: Record<string, unknown> };
type Json = { Parameters: Record<string, { Default?: string; AllowedPattern?: string; MaxLength?: number }>; Conditions?: Record<string, unknown>; Resources: Record<string, Resource> };
type Statement = { Sid?: string; Effect: string; Action: string | string[]; Resource: unknown; Principal?: unknown };

const named = Template.fromStack(new ControlPlaneStack(new App(), "R2NamedControlPlane", { naming: environmentNaming("staging") }));
const legacy = Template.fromStack(new ControlPlaneStack(new App(), "R2LegacyControlPlane"));
const json = named.toJSON() as Json;
// The role path and the permissions boundary are put on by the app's aspects, so those facts are read from the app's own control plane stack.
const inApp = (() => {
  const stack = buildAgentXApp({ agentxEnv: "staging" }).node.children.filter((child): child is Stack => Stack.isStack(child)).find((candidate) => candidate.stackName === "agentx-staging-control-plane")!;
  return Template.fromStack(stack).toJSON() as Json;
})();
const resources = (template: Template, type: string): Array<[string, Resource]> => Object.entries((template.toJSON() as Json).Resources).filter(([, resource]) => resource.Type === type);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [value]);
const broker = resources(named, "AWS::Lambda::Function").find(([id]) => /^Broker[0-9A-F]{8}$/u.test(id))!;
const brokerVariables = (broker[1].Properties.Environment as { Variables: Record<string, unknown> }).Variables;
const brokerRoleId = ((broker[1].Properties.Role as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"])[0];
const dispatcher = resources(named, "AWS::Lambda::Function").find(([id]) => /^Dispatcher[0-9A-F]{8}$/u.test(id))!;
const dispatcherVariables = (dispatcher[1].Properties.Environment as { Variables: Record<string, unknown> }).Variables;
const dispatcherRoleId = ((dispatcher[1].Properties.Role as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"])[0];

const ORG_A = `org_${"a1".repeat(10)}`;
const ORG_B = `org_${"z9".repeat(10)}`;

/** A packed AGENTX_SETTINGS (Fn::Join of `code=` and value pieces) as code -> piece. */
function packedSettings(variables: Record<string, unknown>): Map<string, unknown> {
  const parts = (variables.AGENTX_SETTINGS as { "Fn::Join": [string, unknown[]] })["Fn::Join"][1];
  const pieces = new Map<string, unknown>();
  for (let index = 0; index < parts.length; index += 2) pieces.set(/^,?([a-z]{2})=$/u.exec(String(parts[index]))![1]!, parts[index + 1]);
  return pieces;
}

// Core switch-on blocker (2026-11-17): the model gateway's host and the agent model, kept across upgrades (tests/contract/core-gateway-settings.test.ts has the CLI and the broker's read).
describe("the model gateway settings (stack parameters CoreModelGatewayHost and CoreAgentModel)", () => {
  it("are declared empty by default, with the contracts' pattern and length", () => {
    expect(json.Parameters.CoreModelGatewayHost).toMatchObject({ Default: "", AllowedPattern: CORE_MODEL_GATEWAY_HOST_PATTERN, MaxLength: CORE_MODEL_GATEWAY_HOST_MAX_LENGTH });
    expect(json.Parameters.CoreAgentModel).toMatchObject({ Default: "", AllowedPattern: CORE_AGENT_MODEL_PATTERN, MaxLength: CORE_AGENT_MODEL_MAX_LENGTH });
  });

  it("are packed for BOTH the broker and the dispatcher (gw, am), never as variables of their own", () => {
    for (const [name, variables] of [["broker", brokerVariables], ["dispatcher", dispatcherVariables]] as const) {
      const pieces = packedSettings(variables);
      expect(pieces.get("gw"), name).toStrictEqual({ Ref: "CoreModelGatewayHost" });
      expect(pieces.get("am"), name).toStrictEqual({ Ref: "CoreAgentModel" });
      expect(variables, name).not.toHaveProperty(CORE_MODEL_GATEWAY_URL_VARIABLE);
      expect(variables, name).not.toHaveProperty(CORE_AGENT_MODEL_VARIABLE);
    }
  });

  it("make room in the broker: its switch is packed (sw) and the channel adapters' secret prefix is derived; the dispatcher keeps its own switch variable", () => {
    expect(packedSettings(brokerVariables).get("sw")).toStrictEqual({ Ref: "CoreEngine" });
    expect(brokerVariables).not.toHaveProperty("CHANNEL_ADAPTER_SECRET_PREFIX");
    expect(dispatcherVariables[CORE_ENGINE_VARIABLE]).toStrictEqual({ Ref: "CoreEngine" });
    expect(packedSettings(dispatcherVariables).has("sw")).toBe(false);
  });

  it("are used by nothing else (no IAM, no other function), in the named and the app's template alike", () => {
    for (const template of [json, inApp]) {
      const users = Object.entries(template.Resources).filter(([, resource]) => /"Ref":"Core(ModelGatewayHost|AgentModel)"/u.test(JSON.stringify(resource))).map(([id]) => id.replace(/[0-9A-F]{8}$/u, ""));
      expect(users.sort()).toEqual(["Broker", "Dispatcher"]);
    }
  });

  it("are absent from the legacy (production) template, whose broker is still given the secret prefix whole", () => {
    const legacyJson = legacy.toJSON() as Json;
    expect(legacyJson.Parameters).not.toHaveProperty("CoreModelGatewayHost");
    expect(legacyJson.Parameters).not.toHaveProperty("CoreAgentModel");
    const legacyBroker = Object.entries(legacyJson.Resources).find(([id, resource]) => /^Broker[0-9A-F]{8}$/u.test(id) && resource.Type === "AWS::Lambda::Function")!;
    expect((legacyBroker[1].Properties.Environment as { Variables: Record<string, unknown> }).Variables.CHANNEL_ADAPTER_SECRET_PREFIX).toBe("agentx/production/");
  });
});

// L4-AM (DEC 254zzn(2)): the hosted answers model, a stack parameter of its own, for the BROKER only.
describe("the hosted answers model (stack parameter CoreAnswersModel)", () => {
  it("is declared empty by default (answers use the agent model), with a Claude-only pattern and a short length", () => {
    expect(json.Parameters.CoreAnswersModel).toMatchObject({ Default: "", AllowedPattern: CORE_ANSWERS_MODEL_PATTERN, MaxLength: CORE_ANSWERS_MODEL_MAX_LENGTH });
    expect(CORE_ANSWERS_MODEL_MAX_LENGTH).toBe(39);
    const pattern = new RegExp(CORE_ANSWERS_MODEL_PATTERN, "u");
    for (const ok of ["", "claude-haiku-5-5", "claude-sonnet-4-6", `claude-${"a".repeat(32)}`]) expect(pattern.test(ok), ok).toBe(true);
    for (const bad of ["zai.glm-5", "us.anthropic.claude-haiku-5-5", "Claude-haiku", "claude-", "claude-a,b", "claude-a=b", "claude-a b", "claude-a\n", `claude-${"a".repeat(33)}`, "https://x/claude-a"]) expect(pattern.test(bad), bad).toBe(false);
    // The stack pattern admits exactly the ids the broker's own check admits (plus empty): no gap between them.
    for (const value of ["claude-haiku-5-5", "claude-a.b-c", `claude-${"a".repeat(32)}`, "claude-A", "claude-.a"]) expect(pattern.test(value), value).toBe(CORE_CLAUDE_AGENT_MODEL.test(value));
  });

  it("is packed for the BROKER only (aa), never as a variable of its own, and the dispatcher has no piece of it", () => {
    expect(packedSettings(brokerVariables).get("aa")).toStrictEqual({ Ref: "CoreAnswersModel" });
    expect(brokerVariables).not.toHaveProperty(CORE_ANSWERS_MODEL_VARIABLE);
    expect(packedSettings(dispatcherVariables).has("aa")).toBe(false);
    expect(dispatcherVariables).not.toHaveProperty(CORE_ANSWERS_MODEL_VARIABLE);
  });

  it("is used by the broker's environment alone: no IAM statement, no other function, no other resource, in the named and the app's template alike", () => {
    for (const template of [json, inApp]) {
      const users = Object.entries(template.Resources).filter(([, resource]) => /"Ref":"CoreAnswersModel"/u.test(JSON.stringify(resource))).map(([id, resource]) => `${id.replace(/[0-9A-F]{8}$/u, "")}:${resource.Type}`);
      expect(users).toEqual(["Broker:AWS::Lambda::Function"]);
    }
  });

  it("is absent from the legacy (production) template", () => {
    expect((legacy.toJSON() as Json).Parameters).not.toHaveProperty("CoreAnswersModel");
    expect(JSON.stringify((legacy.toJSON() as Json).Resources)).not.toContain("CoreAnswersModel");
  });

  it("is kept across an upgrade and set only by its config key", () => {
    expect(OPERATOR_PARAMETERS["control-plane"]).toContain("CoreAnswersModel");
    expect(configKey("coreEngine.answersModel")).toMatchObject({ target: { kind: "stack-parameter", part: "control-plane", parameter: "CoreAnswersModel" }, defaultValue: "" });
  });
});

describe("the switch (stack parameter CoreEngine)", () => {
  const parameter = json.Parameters.CoreEngine!;

  it("is a stack parameter in a named environment: off by default, at most 64 characters", () => {
    expect(parameter).toMatchObject({ Default: "off", MaxLength: 64, AllowedPattern: CORE_ENGINE_PARAMETER_PATTERN });
  });

  it("takes off, on, drain, or one or two company ids, and nothing that could carry a separator", () => {
    const allowed = new RegExp(parameter.AllowedPattern!, "u");
    for (const value of ["off", "on", "drain", `on:${ORG_A}`, `on:${ORG_A}:${ORG_B}`]) expect(allowed.test(value), value).toBe(true);
    for (const value of ["", "OFF", "On", "0", "1", "true", "on:", "on:org_x", `on:${ORG_A}:`, `on:${ORG_A}:${ORG_B}:${ORG_A}`, `on:${ORG_A},${ORG_B}`, `on:${ORG_A}=1`, `on: ${ORG_A}`, `on:${ORG_A.toUpperCase()}`, `on:${ORG_A}/x`, "off\n", `on:${ORG_A}"`, `drain:${ORG_A}`, "on:org_" + "a".repeat(21)]) {
      expect(allowed.test(value), JSON.stringify(value)).toBe(false);
    }
  });

  it("is read by the broker's own parser as the value it names: every value the parameter takes is a clean switch, never a reported problem", () => {
    expect(BROKER_SWITCH_VARIABLE).toBe(CORE_ENGINE_VARIABLE);
    for (const value of ["off", "on", "drain", `on:${ORG_A}`, `on:${ORG_A}:${ORG_B}`]) {
      expect(parseCoreSwitch(value).problem, value).toBeUndefined();
      expect(readCoreEngineFlags({ [CORE_ENGINE_VARIABLE]: value }).problems).toEqual([]);
    }
    expect(readCoreEngineFlags({ [CORE_ENGINE_VARIABLE]: `on:${ORG_A}:${ORG_B}` }).combined).toEqual({ mode: "on-for", companies: [ORG_A, ORG_B] });
  });

  it("reaches the broker packed in its settings (sw; core switch-on blocker 2026-11-17: room for the gateway settings)", () => {
    expect(brokerVariables).not.toHaveProperty(CORE_ENGINE_VARIABLE);
    expect(JSON.stringify(brokerVariables.AGENTX_SETTINGS)).toMatch(/sw=",\{"Ref":"CoreEngine"\}/u);
  });

  it("is missing from the legacy (production) template, which has no parameter, queue or schedule for it", () => {
    const text = JSON.stringify(legacy.toJSON());
    for (const word of ["CoreEngine", CORE_ENGINE_VARIABLE, "core-dispatch", CORE_JOB_EVENT_SOURCE]) expect(text, word).not.toContain(word);
  });

  it("is set with `agentx config set coreEngine.switch`, refused before anything changes when it is not a clean value, and an upgrade keeps it", () => {
    const entry = configKey("coreEngine.switch");
    expect(entry.target).toEqual({ kind: "stack-parameter", part: "control-plane", parameter: "CoreEngine" });
    expect(entry.defaultValue).toBe("off");
    // L6: the broker runs the core engine, so every clean value is accepted (switching on still needs an allowed-companies list; the default `none` refuses every company).
    expect(CORE_ENGINE_BROKER_WIRED).toBe(true);
    expect(entry.parse(" off ")).toBe("off");
    for (const value of ["on", "drain", `on:${ORG_A}`, `on:${ORG_A}:${ORG_B}`]) {
      expect(entry.parse(value), value).toBe(value);
      expect(new RegExp(CORE_ENGINE_PARAMETER_PATTERN, "u").test(value), value).toBe(true);
      expect(coreEngineValueWhenWired(value)).toBe(value);
    }
    expect(coreEngineValueWhenWired(" on ")).toBe("on");
    for (const value of ["", "1", "true", "on:", "drained", `drain:${ORG_A}`, `on:${ORG_A},${ORG_B}`, `on:${ORG_A}:${ORG_B}:${ORG_A}`]) {
      expect(() => entry.parse(value), value).toThrow("coreEngine.switch must be off, on, drain, or on:<company id>");
    }
    // The refusal never echoes the value it was given.
    expect(() => entry.parse("on:secret-looking-text")).toThrow(expect.objectContaining({ message: expect.not.stringContaining("secret-looking-text") as string }) as Error);
    expect(OPERATOR_PARAMETERS["control-plane"]).toContain("CoreEngine");
  });
});

describe("the core dispatch queue", () => {
  const queues = resources(named, "AWS::SQS::Queue");
  const byName = (name: string) => queues.find(([, resource]) => resource.Properties.QueueName === name);
  const queue = byName(coreDispatchQueueName("staging"))!;
  const deadLetters = byName(coreDispatchDeadLetterName("staging"))!;

  it("is a queue of its own with fixed per-environment names, plus dead letters", () => {
    expect(queue).toBeDefined();
    expect(deadLetters).toBeDefined();
    expect(coreDispatchQueueName("staging")).toBe("agentx-staging-core-dispatch");
    expect(coreDispatchDeadLetterName("staging")).toBe("agentx-staging-core-dispatch-dead");
    expect(queues.filter(([, resource]) => /core-dispatch/u.test(String(resource.Properties.QueueName)))).toHaveLength(2);
  });

  it("redrives to its dead letters only after more receives than the core's own attempts", () => {
    expect(CORE_DISPATCH_ATTEMPTS_MAX).toBe(DISPATCH_ATTEMPTS_MAX);
    const policy = queue[1].Properties.RedrivePolicy as { maxReceiveCount: number; deadLetterTargetArn: { "Fn::GetAtt": [string, string] } };
    expect(policy.maxReceiveCount).toBe(CORE_DISPATCH_MAX_RECEIVES);
    expect(policy.maxReceiveCount).toBeGreaterThan(DISPATCH_ATTEMPTS_MAX);
    expect(policy.deadLetterTargetArn["Fn::GetAtt"]).toEqual([deadLetters[0], "Arn"]);
    expect(deadLetters[1].Properties).not.toHaveProperty("RedrivePolicy");
  });

  it("is encrypted with SQS-managed keys, holds a message two minutes while a step starts, and keeps dead letters 14 days", () => {
    expect(queue[1].Properties).toMatchObject({ SqsManagedSseEnabled: true, VisibilityTimeout: 120 });
    expect(deadLetters[1].Properties).toMatchObject({ SqsManagedSseEnabled: true, MessageRetentionPeriod: 14 * 24 * 60 * 60 });
  });

  it("leaves the existing dispatch queue as it was (positive control: that one keeps its own lower limit)", () => {
    const existing = queues.find(([id]) => id.startsWith("DispatchQueue"))!;
    expect((existing[1].Properties.RedrivePolicy as { maxReceiveCount: number }).maxReceiveCount).toBeLessThan(CORE_DISPATCH_MAX_RECEIVES);
    expect(existing[0]).not.toBe(queue[0]);
  });

  it("is granted to the broker alone, on each queue's own policy, never on the broker's role (whose inline policy is at IAM's size limit)", () => {
    const policies = resources(named, "AWS::SQS::QueuePolicy").filter(([, policy]) => JSON.stringify(policy.Properties.Queues).includes(queue[0]) || JSON.stringify(policy.Properties.Queues).includes(deadLetters[0]));
    expect(policies).toHaveLength(2);
    for (const [target, [, policy]] of [[queue[0], policies.find(([, p]) => JSON.stringify(p.Properties.Queues) === JSON.stringify([{ Ref: queue[0] }]))!], [deadLetters[0], policies.find(([, p]) => JSON.stringify(p.Properties.Queues) === JSON.stringify([{ Ref: deadLetters[0] }]))!]] as const) {
      const all = (policy.Properties.PolicyDocument as { Statement: Statement[] }).Statement;
      // #663 review: the one Deny is every request not over TLS (enforceSSL); the one Allow is the broker's.
      expect(all).toHaveLength(2);
      expect(all.filter((statement) => statement.Effect === "Deny")).toEqual([{ Action: "sqs:*", Condition: { Bool: { "aws:SecureTransport": "false" } }, Effect: "Deny", Principal: { AWS: "*" }, Resource: { "Fn::GetAtt": [target, "Arn"] } }]);
      const statements = all.filter((statement) => statement.Effect !== "Deny");
      expect(statements).toHaveLength(1);
      expect(statements[0]!.Effect).toBe("Allow");
      expect(statements[0]!.Principal).toEqual({ AWS: { "Fn::GetAtt": [brokerRoleId, "Arn"] } });
      expect(list(statements[0]!.Action).sort()).toEqual([...CORE_BROKER_QUEUE_ACTIONS].sort());
      expect(statements[0]!.Resource).toEqual({ "Fn::GetAtt": [target, "Arn"] });
    }
    // No identity policy in the stack names the dead letters, and only the dispatcher's names the queue (its consumer's reads, step 4): the broker role is unchanged.
    for (const [, policy] of resources(named, "AWS::IAM::Policy")) {
      const text = JSON.stringify(policy.Properties.PolicyDocument);
      expect(text).not.toContain(deadLetters[0]);
      if (text.includes(queue[0])) expect(JSON.stringify(policy.Properties.Roles)).toContain(dispatcherRoleId);
    }
    // No mapping reads the dead letters.
    for (const [, mapping] of resources(named, "AWS::Lambda::EventSourceMapping")) expect(JSON.stringify(mapping.Properties.EventSourceArn)).not.toContain(deadLetters[0]);
  });

  it("has an alarm on its dead letters, which tells the operator and is one the health route reads", () => {
    const alarm = resources(named, "AWS::CloudWatch::Alarm").find(([id]) => id.includes("CoreEngine") && id.includes("DeadLettersAlarm"))!;
    expect(alarm[1].Properties).toMatchObject({ AlarmName: "agentx-staging-CoreDispatchDeadLetters", MetricName: "ApproximateNumberOfMessagesVisible", Namespace: "AWS/SQS", Threshold: 1, ComparisonOperator: "GreaterThanOrEqualToThreshold", TreatMissingData: "notBreaching" });
    expect(JSON.stringify(alarm[1].Properties.Dimensions)).toContain(deadLetters[0]);
    expect(list(alarm[1].Properties.AlarmActions)).toHaveLength(1);
    expect(HEALTH_ALARM_SUFFIXES).toContain(CORE_DISPATCH_DEAD_LETTERS_ALARM);
  });
});

describe("the core job schedules", () => {
  const schedules = resources(named, "AWS::Scheduler::Schedule").filter(([id]) => id.includes("CoreEngine"));
  const group = resources(named, "AWS::Scheduler::ScheduleGroup").find(([id]) => id.includes("CoreEngine"))!;
  const role = resources(named, "AWS::IAM::Role").find(([id]) => id.includes("CoreEngine") && id.includes("InvokeRole"))!;

  it("are one per scheduled row of the core's job table, with its rate, and the stream row has none", () => {
    expect(CORE_JOB_SCHEDULES).toContainEqual({ job: "person-erase-resume", rate: "rate(15 minutes)" });
    expect(CORE_JOB_SCHEDULES.length).toBe(CORE_JOBS.filter((job) => job.trigger.kind === "schedule").length);
    for (const job of CORE_JOBS) {
      const scheduled = CORE_JOB_SCHEDULES.find((entry) => entry.job === job.name);
      if (job.trigger.kind === "schedule") expect(scheduled, job.name).toEqual({ job: job.name, rate: job.trigger.rate });
      else expect(scheduled, job.name).toBeUndefined();
    }
    expect(schedules).toHaveLength(CORE_JOB_SCHEDULES.length);
    expect(schedules.map(([, resource]) => (JSON.parse(String((resource.Properties.Target as { Input: string }).Input)) as { job: string }).job).sort()).toEqual(CORE_JOB_SCHEDULES.map((entry) => entry.job).sort());
  });

  it("send the event the broker's job entry reads: `{ source: agentx.core-job, job }`, to the broker, through the schedules' role", () => {
    expect(CORE_SCHEDULE_SOURCE).toBe(CORE_JOB_EVENT_SOURCE);
    for (const [, schedule] of schedules) {
      const target = schedule.Properties.Target as { Arn: unknown; RoleArn: unknown; Input: string; RetryPolicy: Record<string, number> };
      const event = JSON.parse(target.Input) as { source: string; job: string };
      expect(event.source).toBe("agentx.core-job");
      expect(Object.keys(event).sort()).toEqual(["job", "source"]);
      expect(CORE_JOB_SCHEDULES.some((entry) => entry.job === event.job && entry.rate === schedule.Properties.ScheduleExpression)).toBe(true);
      expect(target.Arn).toEqual({ "Fn::GetAtt": [broker[0], "Arn"] });
      expect(target.RoleArn).toEqual({ "Fn::GetAtt": [role[0], "Arn"] });
      expect(schedule.Properties.FlexibleTimeWindow).toEqual({ Mode: "OFF" });
      expect(schedule.Properties.GroupName).toEqual({ Ref: group[0] });
      expect(target.RetryPolicy).toEqual({ MaximumRetryAttempts: 1, MaximumEventAgeInSeconds: 120 });
    }
  });

  it("run only while the switch is not off: the state is a condition on the parameter, and the resources are always there", () => {
    const conditions = json.Conditions!;
    const conditionId = Object.keys(conditions).find((id) => id.includes("CoreEngineIsOn"))!;
    expect(conditions[conditionId]).toEqual({ "Fn::Not": [{ "Fn::Equals": [{ Ref: "CoreEngine" }, "off"] }] });
    for (const [id, schedule] of schedules) {
      expect(schedule.Properties.State, id).toEqual({ "Fn::If": [conditionId, "ENABLED", "DISABLED"] });
      expect(schedule.Condition, id).toBeUndefined();
    }
    expect(group[1].Condition).toBeUndefined();
  });

  it("use a role that only the scheduler can assume, for this group, that can invoke the broker and nothing else", () => {
    const trust = (role[1].Properties.AssumeRolePolicyDocument as { Statement: Array<{ Principal: { Service: string }; Condition: { StringEquals: Record<string, unknown> } }> }).Statement;
    expect(trust).toHaveLength(1);
    expect(trust[0]!.Principal).toEqual({ Service: "scheduler.amazonaws.com" });
    expect(trust[0]!.Condition.StringEquals["aws:SourceArn"]).toEqual({ "Fn::GetAtt": [group[0], "Arn"] });
    expect(trust[0]!.Condition.StringEquals).toHaveProperty("aws:SourceAccount");
    const policies = resources(named, "AWS::IAM::Policy").filter(([, policy]) => ((policy.Properties.Roles ?? []) as unknown[]).some((ref) => (ref as { Ref?: string }).Ref === role[0]));
    const statements = policies.flatMap(([, policy]) => (policy.Properties.PolicyDocument as { Statement: Statement[] }).Statement);
    expect(statements).toEqual([{ Effect: "Allow", Action: "lambda:InvokeFunction", Resource: { "Fn::GetAtt": [broker[0], "Arn"] } }]);
  });

  it("make a role with a generated name under the environment's path and with the permissions boundary: no fixed-name role, so no new line in either boundary", () => {
    const inAppRole = Object.entries(inApp.Resources).find(([id, resource]) => resource.Type === "AWS::IAM::Role" && id.includes("CoreEngineJobs") && id.includes("InvokeRole"))![1];
    expect(inAppRole.Properties).not.toHaveProperty("RoleName");
    expect(inAppRole.Properties.Path).toBe("/agentx/staging/");
    expect(inAppRole.Properties.PermissionsBoundary).toBeDefined();
    expect(group[1].Properties ?? {}).not.toHaveProperty("Name");
  });
});

describe("no new deploy-role service", () => {
  it("every resource type the construct adds is one whose service the deploy role and the default boundary already allow, and the stack makes no managed policy", () => {
    const added = Object.entries(inApp.Resources).filter(([id]) => id.startsWith("CoreEngineJobs")).map(([, resource]) => resource.Type);
    const services = new Set(added.map((type) => type.split("::")[1]!.toLowerCase()));
    expect([...services].sort()).toEqual(["cloudwatch", "iam", "lambda", "scheduler", "sqs"]);
    for (const service of ["cloudwatch", "lambda", "scheduler", "sqs"]) {
      expect(SERVICE_ROLE_SERVICES, service).toContain(service);
      expect(BOUNDARY_SERVICES, service).toContain(service);
    }
    // IAM: only a role under the environment's path and its inline policy, and the dispatcher's conditional inline policy (the deploy role's IamRoles grant); a managed policy would be refused by both.
    expect(added.filter((type) => type.startsWith("AWS::IAM::")).sort()).toEqual(["AWS::IAM::Policy", "AWS::IAM::Policy", "AWS::IAM::Role"]);
    expect(Object.values(inApp.Resources).filter((resource) => resource.Type === "AWS::IAM::ManagedPolicy")).toEqual([]);
  });
});

describe("the dispatcher as the core queue's consumer (step 4)", () => {
  const queueId = resources(named, "AWS::SQS::Queue").find(([, resource]) => resource.Properties.QueueName === coreDispatchQueueName("staging"))![0];
  const deadId = resources(named, "AWS::SQS::Queue").find(([, resource]) => resource.Properties.QueueName === coreDispatchDeadLetterName("staging"))![0];
  const mappings = resources(named, "AWS::Lambda::EventSourceMapping").filter(([, mapping]) => JSON.stringify(mapping.Properties.EventSourceArn).includes(queueId));
  const isOn = Object.keys(json.Conditions ?? {}).find((name) => name.includes("CoreEngineIsOn"))!;

  it("reads the queue through one mapping of its own, one record per invocation, reporting each failure, enabled only while the switch is not off", () => {
    expect(mappings).toHaveLength(1);
    const [, mapping] = mappings[0]!;
    expect(mapping.Properties.FunctionName).toEqual({ Ref: dispatcher[0] });
    expect(mapping.Properties.EventSourceArn).toEqual({ "Fn::GetAtt": [queueId, "Arn"] });
    expect(mapping.Properties.BatchSize).toBe(CORE_DISPATCH_BATCH_SIZE);
    expect(CORE_DISPATCH_BATCH_SIZE).toBe(1);
    expect(mapping.Properties.FunctionResponseTypes).toEqual(["ReportBatchItemFailures"]);
    expect(mapping.Properties.Enabled).toEqual({ "Fn::If": [isOn, true, false] });
    // The DispatchQueue's own mapping is untouched (positive control).
    expect(resources(named, "AWS::Lambda::EventSourceMapping").filter(([id]) => id.startsWith("DispatchQueueMapping"))).toHaveLength(1);
  });

  it("may receive, delete and hide a message of exactly this queue, never send and never the dead letters, and the mapping waits for that grant", () => {
    const statements = resources(named, "AWS::IAM::Policy")
      .filter(([, policy]) => JSON.stringify(policy.Properties.Roles).includes(dispatcherRoleId))
      .flatMap(([, policy]) => (policy.Properties.PolicyDocument as { Statement: Statement[] }).Statement)
      .filter((statement) => JSON.stringify(statement.Resource).includes(queueId));
    expect(statements).toHaveLength(1);
    expect(list(statements[0]!.Action).sort()).toEqual([...CORE_DISPATCHER_QUEUE_ACTIONS].sort());
    expect(CORE_DISPATCHER_QUEUE_ACTIONS).not.toContain("sqs:SendMessage");
    expect(statements[0]!.Resource).toEqual({ "Fn::GetAtt": [queueId, "Arn"] });
    expect(JSON.stringify(statements)).not.toContain(deadId);
    const defaultPolicy = resources(named, "AWS::IAM::Policy").find(([id, policy]) => id.startsWith("DispatcherServiceRoleDefaultPolicy") && JSON.stringify(policy.Properties.Roles).includes(dispatcherRoleId))!;
    expect(JSON.stringify((json.Resources[mappings[0]![0]] as unknown as { DependsOn?: unknown }).DependsOn ?? [])).toContain(defaultPolicy[0]);
  });

  it("starts the deleter only while the switch is not off, by a policy of its own under the condition, and holds no EC2 terminate", () => {
    const core = resources(named, "AWS::IAM::Policy").filter(([id]) => id.includes("CoreEngineJobs") && id.includes("DispatcherCorePolicy"));
    expect(core).toHaveLength(1);
    expect(core[0]![1].Condition).toBe(isOn);
    expect(core[0]![1].Properties.Roles).toEqual([{ Ref: dispatcherRoleId }]);
    const statements = (core[0]![1].Properties.PolicyDocument as { Statement: Statement[] }).Statement;
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatchObject({ Sid: "CoreStartSessionDeleter", Effect: "Allow", Action: "states:StartExecution" });
    expect(JSON.stringify(statements[0]!.Resource)).toContain("Deleter");
    for (const [, policy] of resources(named, "AWS::IAM::Policy").filter(([, p]) => JSON.stringify(p.Properties.Roles).includes(dispatcherRoleId))) {
      expect(JSON.stringify(policy.Properties.PolicyDocument)).not.toContain("ec2:TerminateInstances");
    }
  });

  it("is told the switch, the queue's ARN and URLs, and the callback signing key only while the switch is not off", () => {
    expect(dispatcherVariables[CORE_ENGINE_VARIABLE]).toEqual({ Ref: "CoreEngine" });
    expect(dispatcherVariables[CORE_DISPATCH_QUEUE_ARN_VARIABLE]).toEqual({ "Fn::GetAtt": [queueId, "Arn"] });
    expect(dispatcherVariables[CORE_DISPATCH_QUEUE_URL_VARIABLE]).toEqual({ Ref: queueId });
    expect(dispatcherVariables[CORE_DISPATCH_DEAD_LETTER_URL_VARIABLE]).toEqual({ Ref: deadId });
    expect(dispatcherVariables.CALLBACK_SIGNING_KEY).toEqual({ "Fn::If": [isOn, { Ref: "CallbackSigningKey" }, ""] });
    // The install's own workers place a core workspace's worker: the same values the broker places a sign-in client's project with.
    expect(dispatcherVariables.EC2_WORKER_SUBNETS).toEqual({ Ref: "Ec2WorkerSubnets" });
    expect(dispatcherVariables.EC2_WORKER_LAUNCH_TEMPLATE_ID).toEqual({ Ref: "Ec2WorkerLaunchTemplateId" });
    expect(dispatcherVariables.EC2_WORKER_SUBNETS).toEqual(brokerVariables.EC2_WORKER_SUBNETS);
  });

  it("keeps the core outbox's pending index on the State table", () => {
    const table = resources(named, "AWS::DynamoDB::Table").find(([id]) => id.startsWith("State"))!;
    const indexes = table[1].Properties.GlobalSecondaryIndexes as Array<{ IndexName: string; KeySchema: Array<{ AttributeName: string; KeyType: string }>; Projection: { ProjectionType: string } }>;
    const pending = indexes.find((index) => index.IndexName === OUTBOX_PENDING_INDEX.name)!;
    expect(pending.KeySchema).toEqual([{ AttributeName: OUTBOX_PENDING_INDEX.partitionAttribute, KeyType: "HASH" }, { AttributeName: OUTBOX_PENDING_INDEX.sortAttribute, KeyType: "RANGE" }]);
    expect(pending.Projection.ProjectionType).toBe("ALL");
  });

  it("is missing from the legacy (production) template: no core variable on the dispatcher, no core mapping, no conditional policy, no outbox pending index", () => {
    const text = JSON.stringify(legacy.toJSON());
    expect((resources(legacy, "AWS::Lambda::Function").find(([id]) => /^Dispatcher[0-9A-F]{8}$/u.test(id))![1].Properties.Environment as { Variables: Record<string, unknown> }).Variables).not.toHaveProperty("EC2_WORKER_SUBNETS");
    for (const word of [CORE_DISPATCH_QUEUE_ARN_VARIABLE, CORE_DISPATCH_QUEUE_URL_VARIABLE, CORE_DISPATCH_DEAD_LETTER_URL_VARIABLE, "DispatcherCorePolicy", "DispatcherMapping", OUTBOX_PENDING_INDEX.name, CORE_ENGINE_VARIABLE]) expect(text).not.toContain(word);
    const legacyDispatcher = resources(legacy, "AWS::Lambda::Function").find(([id]) => /^Dispatcher[0-9A-F]{8}$/u.test(id))!;
    expect((legacyDispatcher[1].Properties.Environment as { Variables: Record<string, unknown> }).Variables).not.toHaveProperty("CALLBACK_SIGNING_KEY");
  });
});


describe("L9 core outbox stream reader reuse", () => {
  it("keeps two State readers and filters core outbox INSERTs on the notifier", () => {
    const mappings = resources(named, "AWS::Lambda::EventSourceMapping").filter(([, entry]) => JSON.stringify(entry.Properties.EventSourceArn).includes("StreamArn"));
    expect(mappings).toHaveLength(2);
    const mapping = mappings.find(([id]) => id.startsWith("DeveloperTaskNotifierStateStreamMapping"))![1];
    expect(mapping.Properties.FunctionResponseTypes).toEqual(["ReportBatchItemFailures"]);
    const filters = (mapping.Properties.FilterCriteria as { Filters: Array<{ Pattern: string }> }).Filters;
    expect(filters).toHaveLength(5);
    expect(filters.map(({ Pattern }) => JSON.parse(Pattern) as unknown)).toContainEqual({ eventName: ["INSERT"], dynamodb: { NewImage: { entityType: { S: ["OUTBOX"] }, pk: { S: [{ prefix: "ORG#" }] }, outboxState: { S: [{ exists: true }] } } } });
  });
});

it("grants the reused notifier only InvokeFunction on this broker, with no third stream principal", () => {
  const brokerId = resources(named, "AWS::Lambda::Function").find(([id]) => /^Broker[0-9A-F]{8}$/u.test(id))![0];
  const policies = resources(named, "AWS::IAM::Policy");
  const notifier = policies.find(([id]) => id.startsWith("DeveloperTaskNotifierFunctionServiceRoleDefaultPolicy"))![1];
  const statements = (notifier.Properties.PolicyDocument as { Statement: Statement[] }).Statement;
  expect(statements.filter((entry) => JSON.stringify(entry.Action).includes("lambda:"))).toEqual([
    { Sid: "RelayCoreOutboxToBroker", Effect: "Allow", Action: "lambda:InvokeFunction", Resource: { "Fn::GetAtt": [brokerId, "Arn"] } },
  ]);
  const streamReaders = policies.flatMap(([id, policy]) => {
    const streamGrants = (policy.Properties.PolicyDocument as { Statement: Statement[] }).Statement.filter((entry) => JSON.stringify(entry.Action).includes("dynamodb:DescribeStream"));
    for (const grant of streamGrants) {
      expect(grant.Resource).toEqual({ "Fn::GetAtt": [resources(named, "AWS::DynamoDB::Table").find(([tableId]) => /^State[0-9A-F]{8}$/u.test(tableId))![0], "StreamArn"] });
      expect([grant.Action].flat().sort()).toEqual(["dynamodb:DescribeStream", "dynamodb:GetRecords", "dynamodb:GetShardIterator"].sort());
    }
    return streamGrants.map(() => id);
  });
  expect(streamReaders).toHaveLength(2);
  expect(streamReaders.every((id) => id.startsWith("OutboxPublisher") || id.startsWith("DeveloperTaskNotifier"))).toBe(true);
});


it("excludes company rows from the existing publisher reader in named environments only", () => {
  const mapping = resources(named, "AWS::Lambda::EventSourceMapping").find(([id]) => id.startsWith("OutboxStreamMapping"))![1];
  expect(mapping.Properties.FilterCriteria).toEqual({ Filters: [{ Pattern: JSON.stringify({ dynamodb: { NewImage: { pk: { S: [{ "anything-but": { prefix: "ORG#" } }] } } } }) }] });
});

describe("L1a broker environment derivation", () => {
  const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value).replace(/[a-f0-9]{64}/gu, "<asset-hash>")).digest("hex");
  it("derives both dispatch queue URLs at runtime without adding broker environment entries", () => {
    const before = structuredClone(inApp);
    const queues = Object.entries(before.Resources).filter(([, resource]) => resource.Type === "AWS::SQS::Queue");
    const queue = queues.find(([, resource]) => resource.Properties.QueueName === coreDispatchQueueName("staging"))!;
    const dead = queues.find(([, resource]) => resource.Properties.QueueName === coreDispatchDeadLetterName("staging"))!;
    const broker = Object.entries(before.Resources).find(([id, resource]) => /^Broker[0-9A-F]{8}$/u.test(id) && resource.Type === "AWS::Lambda::Function")!;
    const variables = (broker[1].Properties.Environment as { Variables: Record<string, unknown> }).Variables;
    expect(variables).not.toHaveProperty("CORE_DISPATCH_QUEUE_URL");
    expect(variables).not.toHaveProperty("CORE_DISPATCH_DEAD_LETTER_URL");
    expect(queue[1].Properties.QueueName).toBe(coreDispatchQueueName("staging"));
    expect(dead[1].Properties.QueueName).toBe(coreDispatchDeadLetterName("staging"));
    expect(broker[1].Properties.Environment).toBeDefined();
  });

  it("constrains all five kept core settings and passes them to both functions without IAM changes", () => {
    const parameters = inApp.Parameters as Record<string, { Default?: string; AllowedPattern?: string; MaxLength?: number }>;
    expect(parameters).toMatchObject({
      CoreAllowedCompanies: { Default: "none", AllowedPattern: "^(none|all|org_[0-9a-z]{20}(:org_[0-9a-z]{20})?)$", MaxLength: 64 },
      CoreTaskCapUsd: { Default: "5", AllowedPattern: "^([1-9][0-9]{0,2}|1000)$", MaxLength: 4 },
      CoreCompanyDayCapUsd: { Default: "25", AllowedPattern: "^([1-9][0-9]{0,2}|1000)$", MaxLength: 4 },
      CoreLessons: { Default: "off", AllowedPattern: "^(off|on|on:org_[0-9a-z]{20}(:org_[0-9a-z]{20})?)$", MaxLength: 64 },
      CorePolicyHook: { Default: "", AllowedPattern: "^[ -~]*$", MaxLength: POLICY_HOOK_PARAMETER_MAX_LENGTH },
    });
    for (const logicalPrefix of ["Broker", "Dispatcher"]) {
      const fn = Object.entries(inApp.Resources).find(([id, resource]) => id.startsWith(logicalPrefix) && resource.Type === "AWS::Lambda::Function")![1];
      const variables = (fn.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
      expect(variables.AGENTX_SETTINGS).toBeDefined();
      expect(variables.ROVARA_POLICY_HOOK).toEqual({ Ref: "CorePolicyHook" });
      expect(variables).not.toHaveProperty("ROVARA_CORE_ALLOWED_COMPANIES");
      expect(JSON.stringify(variables)).toContain("CoreAllowedCompanies");
      expect(JSON.stringify(variables)).toContain("CoreTaskCapUsd");
      expect(JSON.stringify(variables)).toContain("CoreCompanyDayCapUsd");
      expect(JSON.stringify(variables)).toContain("CoreLessons");
    }
    expect(parameters).not.toHaveProperty("CoreAllowedCompaniesLong");
    expect(Object.values(inApp.Resources).filter((resource) => resource.Type === "AWS::IAM::Policy")).toHaveLength(Object.values(json.Resources).filter((resource) => resource.Type === "AWS::IAM::Policy").length);
  });

  it("keeps the entire legacy template byte-identical (apart from normalized bundled asset hashes)", () => {
    expect(digest(legacy.toJSON())).toBe("9a7942afbd5561cef0077003fe43e470ef6b83993bef9ca72068f9e475247b06");
  });
});
import { createHash } from "node:crypto";


it("exposes only the exact core model-access GET without an authorizer on named installs", () => {
  const routes = resources(named, "AWS::ApiGatewayV2::Route").map(([, resource]) => resource.Properties);
  expect(routes.find((route) => route.RouteKey === "GET /v1/internal/model-access")).toMatchObject({ AuthorizationType: "NONE" });
  expect(routes.find((route) => route.RouteKey === "ANY /{proxy+}")).toMatchObject({ AuthorizationType: "JWT" });
  expect(routes.some((route) => route.RouteKey === "GET /v1/internal/{proxy+}")).toBe(false);
  expect(resources(legacy, "AWS::ApiGatewayV2::Route").some(([, resource]) => resource.Properties.RouteKey === "GET /v1/internal/model-access")).toBe(false);
});
