// ENV-ROOM (core switch-on blocker, 2026-11-15): a named environment's broker is given its names packed (AGENTX_NAMES, since ENV-ROOM 2 in its SSM parameter, read by the
// handler), its constrained settings packed (AGENTX_SETTINGS) and
// nothing it can derive from the environment's name, and hydrateBrokerEnvironment puts every value back. This proves, on the synthesized named template, that what the broker
// ends up with is exactly what CloudFormation would have put in each variable before:
//  - each packed name's piece is followed back to its resource, and the variable is compared with that resource's Ref or attribute as CloudFormation gives it (the resolver's
//    CloudFormation semantics, not the hydrator's own code);
//  - each packed setting is compared with its parameter's value;
//  - each derived value is compared with what the infrastructure names the resource with, and where another function is still given the same value whole (the dispatcher's
//    catalog id and core dispatch queue URLs), with that;
//  - the hydrated broker has every variable the legacy template's broker is given, so no reader goes without.
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { BROKER_ACCOUNT_VARIABLE, BROKER_NAMES, BROKER_NAMES_PARAMETER_VARIABLE, BROKER_SETTINGS, BROKER_SETTINGS_VARIABLE, DERIVED_BROKER_VARIABLES, coreDispatchDeadLetterName, coreDispatchQueueName, type BrokerNameSpec } from "@agentx/contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { environmentNaming } from "../../infra/lib/naming.js";
import { hydrateBrokerEnvironment, type MutableEnvironment } from "../../packages/broker/src/aws/broker-environment.js";
import { loadBrokerNamesParameter } from "../../packages/broker/src/aws/broker-names-parameter.js";
import { brokerNamesParameterOf } from "../support/broker-environment-template.js";
import { DEPLOY_PARAMETER_VALUES, RESOLVER_ACCOUNT, RESOLVER_REGION, controlPlaneOf } from "../support/lambda-environment-size.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

/** The named control plane, synthesized (the measure itself, tests/support/lambda-environment-size.ts, takes the template). */
function synthesized(env: string): { template: unknown; stackName: string } {
  const stack = buildAgentXApp({ agentxEnv: env }).node.children.find((child): child is Stack => Stack.isStack(child) && child.node.id === "AgentXControlPlane");
  if (stack === undefined) throw new Error("no control plane stack");
  return { template: Template.fromStack(stack).toJSON(), stackName: stack.stackName };
}

type Variables = Record<string, unknown>;
const brokerOf = (template: { Resources: Record<string, { Type: string; Properties?: Record<string, unknown> }> }, type = "Broker"): Variables => {
  const entry = Object.entries(template.Resources).find(([id, resource]) => resource.Type === "AWS::Lambda::Function" && new RegExp(`^${type}[0-9A-F]{8}$`, "u").test(id));
  if (entry === undefined) throw new Error(`no ${type}`);
  return ((entry[1].Properties?.Environment as { Variables?: Variables } | undefined)?.Variables) ?? {};
};

/** The pieces of a packed variable's Fn::Join, as `code -> the intrinsic that gives its value`. */
function packedPieces(raw: unknown): Map<string, unknown> {
  const join = (raw as { "Fn::Join"?: [string, unknown[]] })["Fn::Join"];
  if (join === undefined || join[0] !== "") throw new Error("a packed variable is one Fn::Join with no separator");
  const pieces = new Map<string, unknown>();
  const parts = join[1];
  for (let index = 0; index < parts.length; index += 2) {
    const code = /^,?([a-z]{2})=$/u.exec(String(parts[index]))?.[1];
    if (code === undefined) throw new Error(`unexpected piece ${String(parts[index])}`);
    pieces.set(code, parts[index + 1]);
  }
  return pieces;
}

/** The logical id (less its hash) each packed code must point at: a swapped pair of codes would otherwise build valid but wrong values. */
const EXPECTED_RESOURCE: Record<string, string> = {
  ts: "State", ar: "Artifacts", st: "DeveloperSignInTable", id: "DeveloperSignInFunction", sl: "SlackThreads", tr: "TurnRecords", pe: "PlanEvidence", sq: "SlackRequestQueue",
  so: "SlackOrchestratorTaskRole", cs: "CompanySecretsRole", ck: "ChatGptConnectionKey", kt: "DeveloperSignInTaskTokenKey", kp: "DeveloperSignInPolicyHookKey",
  pv: "SessionsProvisioner", dl: "SessionsDeleter", ti: "HttpApi", dq: "DispatchDeadLetterQueue", sr: "SlackRequestDeadLetterQueue", dn: "DeveloperTaskNotifierNoticeDeadLetterQueue",
  ds: "DeveloperTaskNotifierStreamFailureQueue", ce: "ChannelApiEventDeadLetters",
};

const logicalIdOf = (intrinsic: unknown): string => {
  const node = intrinsic as { Ref?: string; "Fn::GetAtt"?: [string, string] };
  const id = node.Ref ?? node["Fn::GetAtt"]?.[0];
  if (id === undefined) throw new Error(`not a resource reference: ${JSON.stringify(intrinsic)}`);
  return id;
};

const legacyBrokerKeys = (): string[] => {
  const app = buildAgentXApp({});
  const stack = app.node.children.find((child): child is Stack => Stack.isStack(child) && child.node.id === "AgentXControlPlane")!;
  return Object.keys(brokerOf(Template.fromStack(stack).toJSON() as never));
};

for (const env of ["staging", "a1234567890123456789"] as const) {
  describe(`environment ${env}: the hydrated broker has the values CloudFormation would have passed`, () => {
    const { template, resolver } = controlPlaneOf(env, synthesized(env));
    const raw = brokerOf(template);
    const given: MutableEnvironment = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, resolver.text(value)]));
    const env0 = { ...given, AWS_REGION: RESOLVER_REGION };
    const hydrated: MutableEnvironment = { ...env0 };
    // ENV-ROOM 2: the names come from their SSM parameter, as the handler reads it (its value resolved the way CloudFormation writes it), then hydration runs as before.
    const parameter = brokerNamesParameterOf(template, String(raw[BROKER_NAMES_PARAMETER_VARIABLE]));
    const parameterValue = resolver.text((template.Resources[parameter.id]!.Properties as { Value: unknown }).Value);
    beforeAll(async () => {
      await loadBrokerNamesParameter(hydrated, async () => ({ type: "String", value: parameterValue }));
      hydrateBrokerEnvironment(hydrated);
    });
    const names = packedPieces(parameter.names);
    const settings = packedPieces(raw[BROKER_SETTINGS_VARIABLE]);
    const naming = environmentNaming(env);

    it("is given the account, the packed variables, and none of the variables it builds", () => {
      expect(given[BROKER_ACCOUNT_VARIABLE]).toBe(RESOLVER_ACCOUNT);
      const built = new Set([...Object.values(BROKER_NAMES).map((spec) => spec.variable), ...Object.values(BROKER_SETTINGS).map((spec) => spec.variable), ...DERIVED_BROKER_VARIABLES.map((entry) => entry.variable)]);
      expect(Object.keys(raw).filter((key) => built.has(key))).toEqual([]);
    });

    it("packs every name in the table, and every setting", () => {
      expect([...names.keys()].sort()).toEqual(Object.values(BROKER_NAMES).map((spec) => spec.code).sort());
      // #1149: the layout marker is the legacy install's own; a named environment never packs it.
      expect([...settings.keys()].sort()).toEqual(Object.values(BROKER_SETTINGS).filter((spec) => spec.code !== BROKER_SETTINGS.installLayout.code).map((spec) => spec.code).sort());
    });

    it("points each code at the resource it names, not another of the same kind", () => {
      for (const [code, prefix] of Object.entries(EXPECTED_RESOURCE)) expect(logicalIdOf(names.get(code)), code).toMatch(new RegExp(`^${prefix}(?:[0-9A-F]{8})?$`, "u"));
      expect(Object.keys(EXPECTED_RESOURCE).sort()).toEqual(Object.values(BROKER_NAMES).map((spec) => spec.code).sort());
    });

    for (const spec of Object.values(BROKER_NAMES) as BrokerNameSpec[]) {
      if (spec.kind === "deadLetterQueue") continue;
      it(`${spec.variable} (${spec.code}, ${spec.kind}) is the resource's own value`, () => {
        const id = logicalIdOf(names.get(spec.code));
        const builders: Record<string, () => string> = {
          name: () => resolver.text(names.get(spec.code)),
          queueUrl: () => resolver.ref(id),
          kmsKeyArn: () => resolver.getAtt(id, "Arn"),
          stateMachineArn: () => resolver.ref(id),
          lambdaFunctionArn: () => resolver.getAtt(id, "Arn"),
          roleArn: () => resolver.getAtt(id, "Arn"),
          apiIssuer: () => `${resolver.getAtt(id, "ApiEndpoint")}/v1/auth`,
        };
        const expected = builders[spec.kind]!();
        expect(hydrated[spec.variable]).toBe(expected);
      });
    }

    it("HEALTH_DEAD_LETTER_QUEUES lists each dead-letter queue's URL under its label, as the legacy template's JSON did", () => {
      const queues = (Object.values(BROKER_NAMES) as BrokerNameSpec[]).filter((spec) => spec.kind === "deadLetterQueue");
      expect(hydrated.HEALTH_DEAD_LETTER_QUEUES).toBe(JSON.stringify(Object.fromEntries(queues.map((spec) => [spec.label, resolver.ref(logicalIdOf(names.get(spec.code)))]))));
    });

    for (const spec of Object.values(BROKER_SETTINGS).filter((each) => !("switchFlag" in each) && each.code !== BROKER_SETTINGS.installLayout.code)) {
      it(`${spec.variable} (${spec.code}) is its parameter's value`, () => {
        const parameter = (settings.get(spec.code) as { Ref?: string }).Ref;
        expect(parameter, "a setting is a parameter's value").toBeDefined();
        const value = DEPLOY_PARAMETER_VALUES[parameter!] ?? resolver.ref(parameter!);
        // A host setting (the core's model gateway, core switch-on blocker 2026-11-17) reaches the broker as its https origin.
        const expected = "httpsOrigin" in spec && spec.httpsOrigin === true ? `https://${value}` : value;
        expect(hydrated[spec.variable]).toBe(expected);
      });
    }

    // DEC 254zg (a), 254zk: a switch flag is its switch's condition as "1" or "0", and the broker reads it as "enabled" or "disabled" (the measure takes Fn::If's first branch).
    for (const spec of Object.values(BROKER_SETTINGS).filter((each) => "switchFlag" in each)) {
      it(`${spec.variable} (${spec.code}) is its switch's condition, packed as 1 or 0`, () => {
        const packed = settings.get(spec.code) as { "Fn::If"?: [string, unknown, unknown] };
        expect(packed["Fn::If"]?.slice(1)).toEqual(["1", "0"]);
        expect((template as { Conditions?: Record<string, unknown> }).Conditions?.[packed["Fn::If"]![0]], "a real condition").toBeDefined();
        expect(hydrated[spec.variable]).toBe("enabled");
      });
    }

    it("derives the values the infrastructure names things with, and the ones another function is still given whole", () => {
      const dispatcher = Object.fromEntries(Object.entries(brokerOf(template, "Dispatcher")).map(([key, value]) => [key, resolver.text(value)]));
      expect(hydrated).toMatchObject({
        CONNECTOR_SECRET_PREFIX: naming.connectorSecretPrefix,
        SWEBENCH_SETTINGS_PREFIX: naming.ec2.workerSettingsPrefix,
        AGENTX_E2E_AGENT_SETTINGS_PREFIX: naming.ec2.workerSettingsPrefix,
        AGENTX_ALARM_PREFIX: naming.alarmName(""),
        AGENTX_METRICS_NAMESPACE: naming.metricsNamespace,
        AGENTX_PROJECT_SETUP_RUNTIME_CATALOG_ID: dispatcher.AGENTX_PROJECT_SETUP_RUNTIME_CATALOG_ID,
        AGENTX_E2E_FEATURE_RUNTIME_CATALOG_ID: `${naming.resourcePrefix}-e2e-mock-runtime-v1`,
        CORE_DISPATCH_QUEUE_URL: dispatcher.CORE_DISPATCH_QUEUE_URL,
        CORE_DISPATCH_DEAD_LETTER_URL: dispatcher.CORE_DISPATCH_DEAD_LETTER_URL,
        // The channel adapters' secret prefix, as infra/lib/channel-adapters.ts writes their secrets under it (core switch-on blocker 2026-11-17: room for the gateway settings).
        CHANNEL_ADAPTER_SECRET_PREFIX: `agentx/${env}/`,
      });
      // The core dispatch queues are the template's own, by their fixed names.
      const queueNames = Object.values(template.Resources).filter((resource) => resource.Type === "AWS::SQS::Queue").map((resource) => resource.Properties?.QueueName);
      expect(queueNames).toEqual(expect.arrayContaining([coreDispatchQueueName(env), coreDispatchDeadLetterName(env)]));
    });

    it("ends with every variable the legacy template's broker is given", () => {
      const missing = legacyBrokerKeys().filter((key) => hydrated[key] === undefined);
      expect(missing).toEqual([]);
    });
  });
}
