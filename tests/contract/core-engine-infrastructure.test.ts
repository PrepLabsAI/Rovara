// Engine host (migration plan v3.2 lane E2): the core engine's deployment half, on the synthesised templates. Ported from the monolith's core-engine infrastructure test.
// What must hold:
//   1. no switch (#1275): no CoreEngine or CoreAllowedCompanies parameter, no switch variable on either function, no `coreEngine.switch` config key;
//   2. the core dispatch queue: its own queue and dead letters, a redrive limit above the core's 20 attempts, the existing dispatch queue unchanged, granted to the broker only, on the queues' own
//      policies (the broker role's inline policy is at its size limit);
//   3. the job schedules: one per scheduled row of the core's job table, enabled (the upkeep night follows CoreSystemRuns), through a role that can invoke the broker and nothing else;
//   4. no new deploy-role service: CloudFormation's actions for these resource types are within the deploy role's and the boundary's services, and the new role has no fixed name.
//   5. (step 4) the dispatcher consumes the core queue: its own mapping, enabled, one record per invocation; reads of exactly that queue on its role; the deleter start and the callback
//      signing key; no EC2 terminate; the State table's outbox pending index.
// Dropped from the monolith's test, with reason: the packed-settings and Slack-ingress cases (Code's broker does not pack settings; the ingress wiring comes with the Slack step), the catalog
// repositories (another lane's), and the IAM simulation (Code has no simulator support; the services check stands in).
import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import {
  CORE_DISPATCHER_TIMEOUT_SECONDS, CORE_DISPATCH_CLAIM_STALE_MS, WORKER_POST_TIMEOUT_MS, OUTBOX_RELAY_OWNERSHIP_MS, BOUNDARY_SERVICES, CORE_AGENT_MODEL_MAX_LENGTH, CORE_AGENT_MODEL_PATTERN, CORE_AGENT_MODEL_VARIABLE, CORE_MODEL_GATEWAY_HOST_MAX_LENGTH, CORE_MODEL_GATEWAY_HOST_PATTERN, CORE_MODEL_GATEWAY_URL_VARIABLE, CORE_DISPATCH_ATTEMPTS_MAX, CORE_DISPATCH_BATCH_SIZE, CORE_DISPATCH_DEAD_LETTER_URL_VARIABLE, CORE_DISPATCH_QUEUE_ARN_VARIABLE, CORE_DISPATCH_QUEUE_URL_VARIABLE, OUTBOX_PENDING_INDEX, CORE_DISPATCH_MAX_RECEIVES, CORE_JOB_EVENT_SOURCE, CORE_JOB_SCHEDULES, HEALTH_ALARM_SUFFIXES, POLICY_HOOK_PARAMETER_MAX_LENGTH,
  SERVICE_ROLE_SERVICES, coreAttentionEmailFunctionName, coreDispatchDeadLetterName, coreDispatchQueueName,
} from "@agentx/contracts";
import { CORE_ANSWERS_MODEL_MAX_LENGTH, CORE_ANSWERS_MODEL_PATTERN, CORE_ANSWERS_MODEL_VARIABLE, CORE_CLAUDE_AGENT_MODEL, CORE_LEARNING_MODEL_MAX_LENGTH, CORE_LEARNING_MODEL_PATTERN, CORE_LEARNING_MODEL_VARIABLE, isCoreLearningModelId } from "@agentx/contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { CORE_BROKER_QUEUE_ACTIONS, CORE_DISPATCHER_QUEUE_ACTIONS, CORE_DISPATCH_DEAD_LETTERS_ALARM } from "../../infra/lib/core-engine.js";
import { environmentNaming } from "../../infra/lib/naming.js";
import { DISPATCH_ATTEMPTS_MAX } from "../../packages/broker/src/core/task-flow/dispatch.js";
import { CORE_JOBS, CORE_SCHEDULE_SOURCE } from "../../packages/broker/src/core-host/index.js";
import { configKey } from "../../packages/cli/src/config/keys.js";
import { OPERATOR_PARAMETERS } from "../../packages/cli/src/deploy/parameters.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";
import { unpackedBrokerVariables } from "../support/broker-environment-template.js";
import { withoutBrokerMemberConditionCheck } from "../support/broker-member-condition-check-template.js";

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
    expect(json.Parameters.CoreAgentModel).toMatchObject({ Default: "", AllowedPattern: "^([a-z0-9][a-z0-9._:-]{0,63})?$", MaxLength: 64 });
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

  it("make room in the broker: the channel adapters' secret prefix is derived", () => {
    expect(brokerVariables).not.toHaveProperty("CHANNEL_ADAPTER_SECRET_PREFIX");
  });

  it("are used by nothing else (no IAM, no other function), in the named and the app's template alike", () => {
    for (const template of [json, inApp]) {
      const users = Object.entries(template.Resources).filter(([, resource]) => /"Ref":"Core(ModelGatewayHost|AgentModel)"/u.test(JSON.stringify(resource))).map(([id]) => id.replace(/[0-9A-F]{8}$/u, ""));
      expect(users.sort()).toEqual(["Broker", "Dispatcher"]);
    }
  });

  it("are in the legacy (production) template too since #1148, empty by default, and its broker derives the same secret prefix it was given whole (#1149)", () => {
    const legacyJson = legacy.toJSON() as Json;
    expect(legacyJson.Parameters.CoreModelGatewayHost).toMatchObject({ Default: "" });
    expect(legacyJson.Parameters.CoreAgentModel).toMatchObject({ Default: "" });
    const legacyBroker = Object.entries(legacyJson.Resources).find(([id, resource]) => /^Broker[0-9A-F]{8}$/u.test(id) && resource.Type === "AWS::Lambda::Function")!;
    expect(unpackedBrokerVariables((legacyBroker[1].Properties.Environment as { Variables: Record<string, unknown> }).Variables, legacyJson as never).CHANNEL_ADAPTER_SECRET_PREFIX).toBe("agentx/production/");
  });
});

it("advertises current broker capability even before a gateway, without changing unconfigured model constraints", () => {
  for (const template of [named.toJSON(), inApp, legacy.toJSON()]) {
    expect((template as { Outputs: Record<string, unknown> }).Outputs.ModelRunPriceVersion).toMatchObject({ Value: "1" });
  }
  for (const context of [{ CoreModelGatewayHost: "gateway.example" }, { agentxEnv: "staging", CoreModelGatewayHost: "gateway.example" }]) {
    const stack = buildAgentXApp(context).node.children.find((child): child is Stack => Stack.isStack(child) && child.node.id === "AgentXControlPlane")!;
    const template = Template.fromStack(stack).toJSON() as Json & { Outputs: Record<string, unknown> };
    expect(template.Parameters.CoreAgentModel).toMatchObject({ Default: "", AllowedPattern: CORE_AGENT_MODEL_PATTERN, MaxLength: CORE_AGENT_MODEL_MAX_LENGTH });
    expect(template.Outputs.ModelRunPriceVersion).toMatchObject({ Value: "1" });
    expect(new RegExp(template.Parameters.CoreAgentModel!.AllowedPattern!, "u").test("openai/gpt-5-mini")).toBe(true);
  }
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

  it("is in the legacy (production) template too since #1148, empty by default (the agent model)", () => {
    expect((legacy.toJSON() as Json).Parameters.CoreAnswersModel).toMatchObject({ Default: "" });
  });

  it("is kept across an upgrade and set only by its config key", () => {
    expect(OPERATOR_PARAMETERS["control-plane"]).toContain("CoreAnswersModel");
    expect(configKey("coreEngine.answersModel")).toMatchObject({ target: { kind: "stack-parameter", part: "control-plane", parameter: "CoreAnswersModel" }, defaultValue: "" });
  });
});

// DEC 254zzz58: the hosted lessons' learning model, a stack parameter of its own, for the BROKER only. Additive: a new parameter (default empty) and one packed piece (`lm`), no IAM.
describe("the hosted lessons learning model (stack parameter CoreLearningModel)", () => {
  it("is declared empty by default (claude-haiku-5-5), with the Claude-only pattern and length", () => {
    expect(json.Parameters.CoreLearningModel).toMatchObject({ Type: "String", Default: "", AllowedPattern: CORE_LEARNING_MODEL_PATTERN, MaxLength: CORE_LEARNING_MODEL_MAX_LENGTH });
    expect(CORE_LEARNING_MODEL_MAX_LENGTH).toBe(39);
    const pattern = new RegExp(CORE_LEARNING_MODEL_PATTERN, "u");
    for (const ok of ["", "claude-haiku-5-5", "claude-sonnet-5", `claude-${"a".repeat(32)}`]) expect(pattern.test(ok), ok).toBe(true);
    for (const bad of ["zai.glm-5", "us.anthropic.claude-haiku-5-5", "Claude-haiku", "claude-", "claude-a,b", "claude-a=b", "claude-a b", `claude-${"a".repeat(33)}`]) expect(pattern.test(bad), bad).toBe(false);
    // The stack pattern admits exactly the ids the broker's own check admits (plus empty).
    for (const value of ["claude-haiku-5-5", "claude-a.b-c", `claude-${"a".repeat(32)}`, "claude-A", "claude-.a", "zai.glm-5"]) expect(pattern.test(value), value).toBe(isCoreLearningModelId(value));
  });

  it("is packed for the BROKER only (lm), never as a variable of its own, and the dispatcher has no piece of it", () => {
    expect(packedSettings(brokerVariables).get("lm")).toStrictEqual({ Ref: "CoreLearningModel" });
    expect(brokerVariables).not.toHaveProperty(CORE_LEARNING_MODEL_VARIABLE);
    expect(packedSettings(dispatcherVariables).has("lm")).toBe(false);
    expect(dispatcherVariables).not.toHaveProperty(CORE_LEARNING_MODEL_VARIABLE);
  });

  it("is used by the broker's environment alone: no IAM statement, no other function, no other resource, in the named and the app's template alike", () => {
    for (const template of [json, inApp]) {
      const users = Object.entries(template.Resources).filter(([, resource]) => /"Ref":"CoreLearningModel"/u.test(JSON.stringify(resource))).map(([id, resource]) => `${id.replace(/[0-9A-F]{8}$/u, "")}:${resource.Type}`);
      expect(users).toEqual(["Broker:AWS::Lambda::Function"]);
    }
  });

  it("is in the legacy (production) template too since #1148, empty by default (claude-haiku-5-5)", () => {
    expect((legacy.toJSON() as Json).Parameters.CoreLearningModel).toMatchObject({ Default: "" });
  });

  it("is kept across an upgrade and set only by its config key", () => {
    expect(OPERATOR_PARAMETERS["control-plane"]).toContain("CoreLearningModel");
    expect(configKey("coreEngine.learningModel")).toMatchObject({ target: { kind: "stack-parameter", part: "control-plane", parameter: "CoreLearningModel" }, defaultValue: "" });
  });
});

describe("no core engine switch (#1275)", () => {
  it("declares no CoreEngine or CoreAllowedCompanies parameter, in the named, the app's and the legacy template alike", () => {
    for (const template of [json, inApp, legacy.toJSON() as Json]) {
      expect(template.Parameters).not.toHaveProperty("CoreEngine");
      expect(template.Parameters).not.toHaveProperty("CoreAllowedCompanies");
      expect(JSON.stringify(template)).not.toMatch(/"Ref":"Core(Engine|AllowedCompanies)"/u);
      expect(Object.keys(template.Conditions ?? {}).some((id) => id.includes("CoreEngineIsOn"))).toBe(false);
    }
  });

  it("gives neither function a switch: no packed sw or ac, no ROVARA_CORE_ENGINE or ROVARA_CORE_ALLOWED_COMPANIES variable", () => {
    for (const [name, variables] of [["broker", brokerVariables], ["dispatcher", dispatcherVariables]] as const) {
      const pieces = packedSettings(variables);
      expect(pieces.has("sw"), name).toBe(false);
      expect(pieces.has("ac"), name).toBe(false);
      expect(variables, name).not.toHaveProperty("ROVARA_CORE_ENGINE");
      expect(variables, name).not.toHaveProperty("ROVARA_CORE_ALLOWED_COMPANIES");
    }
  });

  it("has no `coreEngine.switch` config key, and an upgrade keeps neither parameter", () => {
    expect(() => configKey("coreEngine.switch")).toThrow();
    expect(OPERATOR_PARAMETERS["control-plane"]).not.toContain("CoreEngine");
    expect(OPERATOR_PARAMETERS["control-plane"]).not.toContain("CoreAllowedCompanies");
  });

  it("is in the legacy (production) template too since #1148, with its queue under production's name (tests/contract/legacy-core-engine-infrastructure.test.ts)", () => {
    const text = JSON.stringify(legacy.toJSON());
    for (const word of ["agentx-production-core-dispatch", CORE_JOB_EVENT_SOURCE]) expect(text, word).toContain(word);
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
    // Real synthesized values, not another copy of either infrastructure timeout.
    expect(CORE_DISPATCH_CLAIM_STALE_MS).toBeGreaterThan(Number(queue[1].Properties.VisibilityTimeout) * 1_000 + WORKER_POST_TIMEOUT_MS);
    for (const template of [named, legacy]) {
      const broker = resources(template, "AWS::Lambda::Function").find(([id]) => /^Broker[0-9A-F]{8}$/u.test(id))![1];
      expect(OUTBOX_RELAY_OWNERSHIP_MS).toBeGreaterThan(Number(broker.Properties.Timeout) * 1_000);
      const dispatcher = resources(template, "AWS::Lambda::Function").find(([id]) => /^Dispatcher[0-9A-F]{8}$/u.test(id))![1];
      expect(dispatcher.Properties.Timeout).toBe(CORE_DISPATCHER_TIMEOUT_SECONDS);
      expect(CORE_DISPATCHER_TIMEOUT_SECONDS).toBe(60);
      expect(CORE_DISPATCH_CLAIM_STALE_MS).toBeGreaterThan(Number(dispatcher.Properties.Timeout) * 1_000);
    }
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

  it("are enabled, and the upkeep night follows CoreSystemRuns; the resources are always there", () => {
    const conditions = json.Conditions!;
    const systemRunsId = Object.keys(conditions).find((id) => id.includes("CoreSystemRunsIsOn"))!;
    for (const [id, schedule] of schedules) {
      const job = (JSON.parse(String((schedule.Properties.Target as { Input: string }).Input)) as { job: string }).job;
      // L4-P1: every row but the upkeep night is ENABLED; the upkeep night follows the CoreSystemRuns flag (default off, so it is DISABLED until an operator turns it on).
      expect(schedule.Properties.State, id).toEqual(job === "upkeep-night" ? { "Fn::If": [systemRunsId, "ENABLED", "DISABLED"] } : "ENABLED");
      expect(schedule.Condition, id).toBeUndefined();
    }
    expect(group[1].Condition).toBeUndefined();
  });

  it("holds the hourly upkeep night off until CoreSystemRuns is on, and adds exactly that one schedule (owner DEC 254zzl)", () => {
    const conditions = json.Conditions!;
    const systemRunsId = Object.keys(conditions).find((id) => id.includes("CoreSystemRunsIsOn"))!;
    expect(conditions[systemRunsId]).toEqual({ "Fn::Not": [{ "Fn::Equals": [{ Ref: "CoreSystemRuns" }, "off"] }] });
    const night = schedules.filter(([, schedule]) => (JSON.parse(String((schedule.Properties.Target as { Input: string }).Input)) as { job: string }).job === "upkeep-night");
    expect(night).toHaveLength(1);
    expect(night[0]![1].Properties.ScheduleExpression).toBe("rate(1 hour)");
    expect(night[0]![1].Properties.GroupName).toEqual({ Ref: group[0] });
    expect(json.Parameters.CoreSystemRuns).toMatchObject({ Type: "String", Default: "off", AllowedPattern: "^(off|on|on:org_[0-9a-z]{20}(:org_[0-9a-z]{20})?)$", MaxLength: 64 });
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
    expect([...services].sort()).toEqual(["cloudwatch", "iam", "lambda", "logs", "scheduler", "sqs"]);
    for (const service of ["cloudwatch", "lambda", "logs", "scheduler", "sqs"]) {
      expect(SERVICE_ROLE_SERVICES, service).toContain(service);
      expect(BOUNDARY_SERVICES, service).toContain(service);
    }
    // IAM: only a role under the environment's path and its inline policy, and the dispatcher's conditional inline policy (the deploy role's IamRoles grant); a managed policy would be refused by both.
    // Web task channel C8 (option b): the attention email sender's role and its inline policy (both only while CoreAttentionEmail is on).
    expect(added.filter((type) => type.startsWith("AWS::IAM::")).sort()).toEqual(["AWS::IAM::Policy", "AWS::IAM::Policy", "AWS::IAM::Policy", "AWS::IAM::Role", "AWS::IAM::Role"]);
    expect(Object.values(inApp.Resources).filter((resource) => resource.Type === "AWS::IAM::ManagedPolicy")).toEqual([]);
  });
});

// Web task channel C8, option b (DEC 254zm(3)): the attention email's own sender function. The guard: OFF builds nothing; on, one function with one narrow statement, invoked by the broker through the
// function's own policy; the broker's role and environment do not grow.
describe("the attention email (CoreAttentionEmail, default off)", () => {
  const attention = Object.entries(inApp.Resources).filter(([id]) => id.startsWith("CoreEngineJobsAttentionEmail"));
  const conditionId = Object.keys(inApp.Conditions ?? {}).find((id) => id.startsWith("CoreEngineJobsAttentionEmailAttentionEmailIsOn"))!;
  const of = (type: string) => attention.filter(([, resource]) => resource.Type === type);
  const inAppBroker = Object.entries(inApp.Resources).find(([id, resource]) => /^Broker[0-9A-F]{8}$/u.test(id) && resource.Type === "AWS::Lambda::Function")!;
  const inAppBrokerRoleId = ((inAppBroker[1].Properties.Role as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"])[0];

  it("declares the switch off by default, the host with the gateway host's pattern, and the sender as one plain address", () => {
    expect(inApp.Parameters.CoreAttentionEmail).toMatchObject({ Default: "off", AllowedValues: ["off", "on"] });
    expect(inApp.Parameters.CoreAttentionEmailHost).toMatchObject({ Default: "", AllowedPattern: CORE_MODEL_GATEWAY_HOST_PATTERN, MaxLength: CORE_MODEL_GATEWAY_HOST_MAX_LENGTH });
    expect(inApp.Parameters.CoreAttentionEmailSender).toMatchObject({ Default: "", MaxLength: 254 });
    expect(inApp.Conditions![conditionId]).toEqual({ "Fn::Equals": [{ Ref: "CoreAttentionEmail" }, "on"] });
  });

  it("builds nothing while off: every resource it adds is under AttentionEmailIsOn, so the default template creates none of them", () => {
    expect(attention.map(([, resource]) => resource.Type).sort()).toEqual(["AWS::IAM::Policy", "AWS::IAM::Role", "AWS::Lambda::Function", "AWS::Lambda::Permission", "AWS::Logs::LogGroup"]);
    for (const [id, resource] of attention) expect(resource.Condition, id).toBe(conditionId);
    // Nothing outside the construct names its function or its role.
    const ids = attention.map(([id]) => id);
    for (const [id, resource] of Object.entries(inApp.Resources)) if (!ids.includes(id)) for (const own of ids) expect(JSON.stringify(resource), `${id} -> ${own}`).not.toContain(`"${own}"`);
  });

  it("gives the sender's role exactly one statement of its own: ses:SendEmail on the CoreAttentionEmailSender identity, From pinned; no SES right anywhere else in the stack (DEC 254zzz73: no step-up sender)", () => {
    const [[, policy]] = of("AWS::IAM::Policy") as [[string, Resource]];
    const statements = (policy.Properties.PolicyDocument as { Statement: Statement[] }).Statement;
    expect(statements.filter((statement) => statement.Sid === "AttentionEmailSend")).toEqual([{
      Sid: "AttentionEmailSend", Effect: "Allow", Action: "ses:SendEmail",
      Resource: { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":ses:", { Ref: "AWS::Region" }, ":", { Ref: "AWS::AccountId" }, ":identity/", { Ref: "CoreAttentionEmailSender" }]] },
      Condition: { StringEquals: { "ses:FromAddress": { Ref: "CoreAttentionEmailSender" } } },
    }]);
    // The rest is the function's tracing default only.
    expect(statements.filter((statement) => statement.Sid !== "AttentionEmailSend").flatMap((statement) => list(statement.Action)).sort()).toEqual(["xray:PutTelemetryRecords", "xray:PutTraceSegments"]);
    const sesPolicies = Object.entries(inApp.Resources).filter(([, resource]) => resource.Type === "AWS::IAM::Policy" && JSON.stringify(resource.Properties).includes("ses:"));
    expect(sesPolicies.map(([id]) => id.replace(/[0-9A-F]{8}$/u, "")).sort()).toEqual(["CoreEngineJobsAttentionEmailSenderServiceRoleDefaultPolicy"]);
    expect(JSON.stringify(inApp.Resources[inAppBrokerRoleId])).not.toContain("ses:");
  });

  it("lets the broker invoke it by the function's own policy (the broker's role is not touched), and names the function so the broker derives it", () => {
    const [[, permission]] = of("AWS::Lambda::Permission") as [[string, Resource]];
    const [[functionId, fn]] = of("AWS::Lambda::Function") as [[string, Resource]];
    expect(permission.Properties).toEqual({ Action: "lambda:InvokeFunction", FunctionName: { "Fn::GetAtt": [functionId, "Arn"] }, Principal: { "Fn::GetAtt": [inAppBrokerRoleId, "Arn"] } });
    expect(fn.Properties.FunctionName).toBe(coreAttentionEmailFunctionName("staging"));
    expect((fn.Properties.Environment as { Variables: Record<string, unknown> }).Variables).toEqual({
      ATTENTION_EMAIL_FROM: { Ref: "CoreAttentionEmailSender" }, ATTENTION_EMAIL_LINK_ORIGIN: { "Fn::Join": ["", ["https://", { Ref: "CoreAttentionEmailHost" }]] },
    });
    // The broker's identity policies do not mention it; its environment has only the packed switch (no variable of its own).
    const brokerPolicies = Object.values(inApp.Resources).filter((resource) => resource.Type === "AWS::IAM::Policy" && JSON.stringify(resource.Properties.Roles ?? []).includes(inAppBrokerRoleId));
    for (const resource of brokerPolicies) expect(JSON.stringify(resource)).not.toContain(functionId);
    expect(JSON.stringify(inApp.Resources[inAppBrokerRoleId])).not.toContain(functionId);
    const variables = (inAppBroker[1].Properties.Environment as { Variables: Record<string, unknown> }).Variables;
    expect(Object.keys(variables).filter((name) => /ATTENTION/u.test(name))).toEqual([]);
    const pieces = packedSettings(variables);
    expect(pieces.get("ae")).toStrictEqual({ Ref: "CoreAttentionEmail" });
    // The web app's host is the sender's alone: the broker never has it.
    expect([...pieces.keys()].filter((code) => code === "ah")).toEqual([]);
    expect(JSON.stringify(variables)).not.toContain("CoreAttentionEmailHost");
  });

  it("refuses on without its own sender or without the web app's host (DEC 254zzz73: no step-up sender to compare with)", () => {
    const rules = (inApp as { Rules?: Record<string, { RuleCondition: unknown; Assertions: Array<{ Assert: unknown }> }> }).Rules!;
    const rule = Object.entries(rules).find(([id]) => id.startsWith("CoreEngineJobsAttentionEmailAttentionEmailOwnSender"))![1];
    expect(rule.RuleCondition).toEqual({ "Fn::Equals": [{ Ref: "CoreAttentionEmail" }, "on"] });
    expect(rule.Assertions.map((assertion) => assertion.Assert)).toEqual([
      { "Fn::Not": [{ "Fn::Equals": [{ Ref: "CoreAttentionEmailSender" }, ""] }] },
      { "Fn::Not": [{ "Fn::Equals": [{ Ref: "CoreAttentionEmailHost" }, ""] }] },
    ]);
  });

  it("is kept across upgrades, and the legacy template has it too since #1148, off by default, under production's sender name", () => {
    for (const name of ["CoreAttentionEmail", "CoreAttentionEmailHost", "CoreAttentionEmailSender"]) expect(OPERATOR_PARAMETERS["control-plane"], name).toContain(name);
    const legacyJson = legacy.toJSON() as Json;
    expect(Object.keys(legacyJson.Parameters ?? {}).filter((name) => name.startsWith("CoreAttentionEmail")).sort()).toEqual(["CoreAttentionEmail", "CoreAttentionEmailHost", "CoreAttentionEmailSender"]);
    expect(legacyJson.Parameters.CoreAttentionEmail).toMatchObject({ Default: "off" });
    expect(JSON.stringify(legacyJson)).toContain("agentx-production-attention-email");
  });
});

describe("the dispatcher as the core queue's consumer (step 4)", () => {
  const queueId = resources(named, "AWS::SQS::Queue").find(([, resource]) => resource.Properties.QueueName === coreDispatchQueueName("staging"))![0];
  const deadId = resources(named, "AWS::SQS::Queue").find(([, resource]) => resource.Properties.QueueName === coreDispatchDeadLetterName("staging"))![0];
  const mappings = resources(named, "AWS::Lambda::EventSourceMapping").filter(([, mapping]) => JSON.stringify(mapping.Properties.EventSourceArn).includes(queueId));

  it("reads the queue through one mapping of its own, one record per invocation, reporting each failure, always enabled", () => {
    expect(mappings).toHaveLength(1);
    const [, mapping] = mappings[0]!;
    expect(mapping.Properties.FunctionName).toEqual({ Ref: dispatcher[0] });
    expect(mapping.Properties.EventSourceArn).toEqual({ "Fn::GetAtt": [queueId, "Arn"] });
    expect(mapping.Properties.BatchSize).toBe(CORE_DISPATCH_BATCH_SIZE);
    expect(CORE_DISPATCH_BATCH_SIZE).toBe(1);
    expect(mapping.Properties.FunctionResponseTypes).toEqual(["ReportBatchItemFailures"]);
    expect(mapping.Properties.Enabled).toBe(true);
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

  it("starts the deleter by a policy of its own (no condition), and holds no EC2 terminate", () => {
    const core = resources(named, "AWS::IAM::Policy").filter(([id]) => id.includes("CoreEngineJobs") && id.includes("DispatcherCorePolicy"));
    expect(core).toHaveLength(1);
    expect(core[0]![1].Condition).toBeUndefined();
    expect(core[0]![1].Properties.Roles).toEqual([{ Ref: dispatcherRoleId }]);
    const statements = (core[0]![1].Properties.PolicyDocument as { Statement: Statement[] }).Statement;
    // The deleter's start, and the one secret that holds the callback signing key (read by name; exactly that secret's ARN).
    expect(statements).toHaveLength(2);
    expect(statements[0]).toMatchObject({ Sid: "CoreStartSessionDeleter", Effect: "Allow", Action: "states:StartExecution" });
    expect(JSON.stringify(statements[0]!.Resource)).toContain("Deleter");
    const secretId = resources(named, "AWS::SecretsManager::Secret").find(([, secret]) => secret.Properties.Name === "agentx/staging/callback-key")![0];
    expect(statements[1]).toEqual({ Sid: "ReadCallbackSigningKey", Effect: "Allow", Action: "secretsmanager:GetSecretValue", Resource: { Ref: secretId } });
    for (const [, policy] of resources(named, "AWS::IAM::Policy").filter(([, p]) => JSON.stringify(p.Properties.Roles).includes(dispatcherRoleId))) {
      expect(JSON.stringify(policy.Properties.PolicyDocument)).not.toContain("ec2:TerminateInstances");
    }
  });

  it("is told the queue's ARN and URLs, and the callback signing key's secret name", () => {
    expect(dispatcherVariables[CORE_DISPATCH_QUEUE_ARN_VARIABLE]).toEqual({ "Fn::GetAtt": [queueId, "Arn"] });
    expect(dispatcherVariables[CORE_DISPATCH_QUEUE_URL_VARIABLE]).toEqual({ Ref: queueId });
    expect(dispatcherVariables[CORE_DISPATCH_DEAD_LETTER_URL_VARIABLE]).toEqual({ Ref: deadId });
    // The key itself is never an environment value: only the name of its secret.
    expect(dispatcherVariables.CALLBACK_SIGNING_KEY_SECRET_ID).toBe("agentx/staging/callback-key");
    expect(dispatcherVariables).not.toHaveProperty("CALLBACK_SIGNING_KEY");
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

  it("is in the legacy (production) template too since #1148: the dispatcher's core variables, its core mapping, its core policy and the outbox pending index", () => {
    const text = JSON.stringify(legacy.toJSON());
    expect((resources(legacy, "AWS::Lambda::Function").find(([id]) => /^Dispatcher[0-9A-F]{8}$/u.test(id))![1].Properties.Environment as { Variables: Record<string, unknown> }).Variables).toHaveProperty("EC2_WORKER_SUBNETS");
    for (const word of [CORE_DISPATCH_QUEUE_ARN_VARIABLE, CORE_DISPATCH_QUEUE_URL_VARIABLE, "DispatcherCorePolicy", "DispatcherMapping", OUTBOX_PENDING_INDEX.name]) expect(text, word).toContain(word);
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

  it("constrains the kept core settings and passes them to both functions without IAM changes", () => {
    const parameters = inApp.Parameters as Record<string, { Default?: string; AllowedPattern?: string; MaxLength?: number }>;
    expect(parameters).toMatchObject({
      CoreTaskCapUsd: { Default: "5", AllowedPattern: "^([1-9][0-9]{0,2}|1000)$", MaxLength: 4 },
      CoreCompanyDayCapUsd: { Default: "25", AllowedPattern: "^([1-9][0-9]{0,2}|1000)$", MaxLength: 4 },
      CoreLessons: { Default: "off", AllowedPattern: "^(off|on|on:org_[0-9a-z]{20}(:org_[0-9a-z]{20})?)$", MaxLength: 64 },
      CoreSystemRuns: { Default: "off", AllowedPattern: "^(off|on|on:org_[0-9a-z]{20}(:org_[0-9a-z]{20})?)$", MaxLength: 64 },
      CorePolicyHook: { Default: "", AllowedPattern: "^[ -~]*$", MaxLength: POLICY_HOOK_PARAMETER_MAX_LENGTH },
    });
    // L4-P2: the system-runs flag (the operator's ceiling) is given to BOTH functions: the dispatcher's setup gate before a build can retry a re-check, and that retry must stop when the flag goes off. An environment value only; no IAM.
    for (const [logicalPrefix, holdsSystemRuns] of [["Broker", true], ["Dispatcher", true]] as const) {
      const fn = Object.entries(inApp.Resources).find(([id, resource]) => id.startsWith(logicalPrefix) && resource.Type === "AWS::Lambda::Function")![1];
      const variables = (fn.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
      expect(JSON.stringify(variables).includes("CoreSystemRuns"), logicalPrefix).toBe(holdsSystemRuns);
      expect(variables.AGENTX_SETTINGS).toBeDefined();
      expect(variables.ROVARA_POLICY_HOOK).toEqual({ Ref: "CorePolicyHook" });
      expect(variables).not.toHaveProperty("ROVARA_CORE_ALLOWED_COMPANIES");
      expect(JSON.stringify(variables)).not.toContain("CoreAllowedCompanies");
      expect(JSON.stringify(variables)).toContain("CoreTaskCapUsd");
      expect(JSON.stringify(variables)).toContain("CoreCompanyDayCapUsd");
      expect(JSON.stringify(variables)).toContain("CoreLessons");
    }
    expect(parameters).not.toHaveProperty("CoreAllowedCompaniesLong");
    expect(Object.values(inApp.Resources).filter((resource) => resource.Type === "AWS::IAM::Policy")).toHaveLength(Object.values(json.Resources).filter((resource) => resource.Type === "AWS::IAM::Policy").length);
  });

  // DEC 254za: re-pinned for the callback signing key's secret (the legacy template carries it too).
  it("keeps the legacy template byte-identical apart from the exact broker capability output, member check and normalized asset hashes", () => {
    // Machine size stack (#877 + #887 + DEC 254zr): re-pinned. Measured against code/next a38f1ab0d, the legacy template differs in exactly three places: (1) the provisioner's RunInstances
    // condition gains StringEquals ec2:InstanceType (ten types); (2) ResolveWorkerAmi's Resource becomes the arm64 parameter plus the public x86_64 AL2023 parameter; (3) the provisioner state
    // machine's definition (new states SizeChosen, the *Sized and X86 launches, SizedLaunchFailed, SizeUnavailable; Start, LaunchConfiguration, RunInstance*, RecordInstance carry the size).
    // Batch 14: measured on the combined tree (batch 13 + the machine size stack); the legacy synth differs from batch 13's head only in the three machine size places above.
    // #1129: re-pinned for the company layer, the sign-in extras and the company-secrets role in the legacy template (both company switches off by default).
    // SIGNIN-AUDIT: re-pinned for the sign-in role's conditional AUDIT-family PutItem on State.
    // #1131: re-pinned. The legacy (production) template gains the reliability parts named environments had: the DispatchDeadLetters, StuckCancels and UnwaitedTaskFailures
    // alarms, the reconciler's idle Slack backstop (its settings, ReadThreadWaiters, PostUnwaitedTaskNote, the Slack poster) and callback key read, and the hand-off grant's ordering.
    // #1149: re-pinned. The legacy broker packs its environment (the names parameter /agentx/production/broker-names, AGENTX_SETTINGS with the legacy layout marker, the
    // names parameter's read in its ssm:GetParameters statement); tests/contract/legacy-broker-packed-environment.test.ts proves it boots with the same values.
    // #1148: re-pinned for the core engine in the legacy template (CoreEngine off by default).
    // SIGNIN-STATE-TABLE: re-pinned for ONE change: the sign-in function's STATE_TABLE_NAME is the plain Ref to State instead of an Fn::If on SlackCompanyModeOn to "" (rule D: with the
    // old Fn::If put back, the old pin db40b76d... held; the legacy-templates snapshot diff is that one hunk).
    // LEGACY-WORKER-CAPABILITY-ROUTES: the legacy template gains the ContextToolsListRoute and DesignReviewPacketRoute resources (named environments already had them).
    // #1275: and loses the core engine switch (the CoreEngine and CoreAllowedCompanies parameters, their packed sw/ac pieces and the dispatcher's ROVARA_CORE_ENGINE, the CoreEngineIsOn
    // condition: schedules ENABLED, the dispatcher's core mapping enabled, its core policy and callback key unconditional).
    // The merged template adds both the exact first-gateway output and the narrow
    // SIGNIN-MEMBER-CONDITIONCHECK statement (DEC 254zzz282 B014-A). Assert each
    // addition before removing it; all historical pins still cover every other byte.
    const beforeFirstGateway = structuredClone(legacy.toJSON()) as Json & { Outputs: Record<string, unknown> };
    expect(beforeFirstGateway.Outputs.ModelRunPriceVersion).toEqual({ Value: "1", Description: "Broker signs task run-price ceilings; deploy gateway before broker before workers" });
    delete beforeFirstGateway.Outputs.ModelRunPriceVersion;
    expect(digest(beforeFirstGateway), "legacy without the first-gateway output retains the upstream member-check pin").toBe("8f8df2aeed3082d74b0fee456be77fb5e562b86eb2c047b79f3585aa439ec150");
    const beforeMemberCheck = withoutBrokerMemberConditionCheck(beforeFirstGateway);
    expect(digest(beforeMemberCheck), "legacy without the first-gateway output and broker member check").toBe("512fbc833e978fd35b1ccd570e0833ccda983f1a4a000b75afa5ac7992529d62");
    // Rule D proof: removing exactly the two capability routes retains the switch-removal pin.
    const withoutCapabilityRoutes = structuredClone(beforeMemberCheck);
    delete withoutCapabilityRoutes.Resources.ContextToolsListRoute;
    delete withoutCapabilityRoutes.Resources.DesignReviewPacketRoute;
    expect(digest(withoutCapabilityRoutes), "legacy with the two capability routes taken out").toBe("33220db5faf6815c6effbb6c57c7b495eb26d73fe7fdf6b21bb10433718659d4");
    expect(digest(legacy.toJSON())).toBe("99c852b0d794c4b0d27ec6b804839c1c3592fa8eeacaaa55dbbedb90153d4665");
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

// DEC 254z-amend3: test services, on by default with the owner's opt-out, kept across upgrades.
describe("the test services setting (stack parameter TestServices)", () => {
  const typed = json as unknown as { Parameters: Record<string, { Default?: string; AllowedValues?: string[] }> };
  it("is declared on (\"1\") by default, with exactly the values 1 and 0, named environments only (the legacy template has none)", () => {
    expect(typed.Parameters.TestServices).toMatchObject({ Default: "1", AllowedValues: ["1", "0"] });
    // #1148: the legacy (production) template too.
    expect((legacy.toJSON() as Json).Parameters.TestServices).toMatchObject({ Default: "1", AllowedValues: ["1", "0"] });
  });

  it("is packed for the broker and the dispatcher (td), never as a variable of their own, and given whole to the session steps", () => {
    expect(packedSettings(dispatcherVariables).get("td")).toStrictEqual({ Ref: "TestServices" });
    expect(packedSettings(brokerVariables).get("td")).toStrictEqual({ Ref: "TestServices" });
    expect(brokerVariables).not.toHaveProperty("ROVARA_TEST_SERVICES");
    const steps = resources(named, "AWS::Lambda::Function").find(([id]) => /^SessionsSteps[0-9A-F]{8}$/u.test(id))!;
    expect((steps[1].Properties.Environment as { Variables: Record<string, unknown> }).Variables.ROVARA_TEST_SERVICES).toStrictEqual({ Ref: "TestServices" });
    const users = Object.entries(json.Resources).filter(([, resource]) => /"Ref":"TestServices"/u.test(JSON.stringify(resource))).map(([id]) => id.replace(/[0-9A-F]{8}$/u, ""));
    expect(users.sort()).toEqual(["Broker", "Dispatcher", "SessionsSteps"]);
  });

  it("is an operator setting an upgrade keeps", () => {
    expect(OPERATOR_PARAMETERS["control-plane"]).toContain("TestServices");
  });
});

// DEC 254zm: whether the install's starter copies are in place, so Code's workers run test services. Off (`none`) by default, kept across upgrades.
describe("the test service images setting (stack parameter TestServiceImages)", () => {
  const typed = json as unknown as { Parameters: Record<string, { Default?: string; AllowedValues?: string[] }> };
  it("is declared none by default, with exactly the values none and mirrored, named environments only", () => {
    expect(typed.Parameters.TestServiceImages).toMatchObject({ Default: "none", AllowedValues: ["none", "mirrored"] });
    // #1148: the legacy (production) template too.
    expect((legacy.toJSON() as Json).Parameters.TestServiceImages).toMatchObject({ Default: "none", AllowedValues: ["none", "mirrored"] });
  });

  it("is packed for the broker and the dispatcher (ti), and given whole to the session steps beside the switch", () => {
    expect(packedSettings(dispatcherVariables).get("ti")).toStrictEqual({ Ref: "TestServiceImages" });
    expect(packedSettings(brokerVariables).get("ti")).toStrictEqual({ Ref: "TestServiceImages" });
    expect(brokerVariables).not.toHaveProperty("ROVARA_TEST_SERVICES_HOSTED_IMAGES");
    const steps = resources(named, "AWS::Lambda::Function").find(([id]) => /^SessionsSteps[0-9A-F]{8}$/u.test(id))!;
    expect((steps[1].Properties.Environment as { Variables: Record<string, unknown> }).Variables.ROVARA_TEST_SERVICES_HOSTED_IMAGES).toStrictEqual({ Ref: "TestServiceImages" });
    const users = Object.entries(json.Resources).filter(([, resource]) => /"Ref":"TestServiceImages"/u.test(JSON.stringify(resource))).map(([id]) => id.replace(/[0-9A-F]{8}$/u, ""));
    expect(users.sort()).toEqual(["Broker", "Dispatcher", "SessionsSteps"]);
  });

  it("is an operator setting an upgrade keeps, set with `agentx config set testServices.images`", () => {
    expect(OPERATOR_PARAMETERS["control-plane"]).toContain("TestServiceImages");
    const key = configKey("testServices.images");
    expect(key.target).toEqual({ kind: "stack-parameter", part: "control-plane", parameter: "TestServiceImages" });
    expect(key.parse("mirrored")).toBe("mirrored");
    expect(key.parse("none")).toBe("none");
    for (const bad of ["Mirrored", "yes", "1", ""]) expect(() => key.parse(bad), bad).toThrow();
  });
});
