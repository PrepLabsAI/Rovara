// L4-SQS (journey audit B3c and B18, 2026-11-18): the lessons reflection queue on AWS, and the dispatcher's SQS reach. What must hold, on the synthesised named templates (no AWS call):
//   1. the queue exists with the options lessons/reflect-queue.ts declares (visibility timeout 1800 s, max receive 5), a dead-letter queue of its own (only this queue may redrive to it), SQS-managed
//      encryption like the core dispatch queues, every request over TLS; the dead letters keep 14 days;
//   2. the grants are on the queues' own resource policies, for the broker alone (the one producer and the one consumer of the reflection queue), exactly the actions the code calls:
//      queue = SendMessage, ReceiveMessage, DeleteMessage, ChangeMessageVisibility, GetQueueAttributes; dead letters = GetQueueAttributes only (the adapter reads the dead-letter queue's ARN and kind
//      when it opens the queue; nothing sends to or reads it). Nothing for the dispatcher, no identity policy names either queue (the broker role's inline policy is at IAM's size limit);
//   3. the URLs are derived (from the environment's name), so the broker's 4 KB environment grows by nothing and the dispatcher is given neither;
//   4. the permissions boundary and the deploy role allow all of it (evaluated from the policy code), and a role without a grant is implicitly denied (control);
//   5. the legacy template has none of it, and every widening of the statements below is caught.
import { isDeepStrictEqual } from "node:util";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import {
  CORE_LESSONS_REFLECT_DEAD_LETTER_URL_VARIABLE, CORE_LESSONS_REFLECT_QUEUE_URL_VARIABLE, DERIVED_BROKER_VARIABLES, LESSONS_REFLECT_MAX_RECEIVES, LESSONS_REFLECT_VISIBILITY_SECONDS, coreDispatchDeadLetterName, coreDispatchQueueName,
  coreLessonsReflectDeadLetterName, coreLessonsReflectQueueName, defaultBoundaryStatements, serviceRoleStatements, type PolicyScope, type PolicyStatementJson,
} from "@agentx/contracts";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { CORE_BROKER_QUEUE_ACTIONS, CORE_BROKER_REFLECT_DEAD_LETTER_ACTIONS, CORE_BROKER_REFLECT_QUEUE_ACTIONS } from "../../infra/lib/core-engine.js";
import { environmentNaming } from "../../infra/lib/naming.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";
import { unpackedBrokerVariables } from "../support/broker-environment-template.js";

skipLambdaBundling();

type Resource = { Type: string; Properties: Record<string, unknown> };
type Json = { Resources: Record<string, Resource> };
type Statement = { Sid?: string; Effect: string; Action: string | string[]; Resource: unknown; Principal?: unknown; Condition?: unknown };

const namedStack = new ControlPlaneStack(new App(), "SqsNamedControlPlane", { naming: environmentNaming("staging") });
const named = Template.fromStack(namedStack).toJSON() as Json;
const legacy = Template.fromStack(new ControlPlaneStack(new App(), "SqsLegacyControlPlane")).toJSON() as Json;

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [value]);
const resourcesOf = (json: Json, type: string): Array<[string, Resource]> => Object.entries(json.Resources).filter(([, resource]) => resource.Type === type);
const queueNamed = (json: Json, name: string): [string, Resource] | undefined => resourcesOf(json, "AWS::SQS::Queue").find(([, resource]) => resource.Properties.QueueName === name);
const brokerOf = (json: Json) => resourcesOf(json, "AWS::Lambda::Function").find(([id]) => /^Broker[0-9A-F]{8}$/u.test(id))!;
const dispatcherOf = (json: Json) => resourcesOf(json, "AWS::Lambda::Function").find(([id]) => /^Dispatcher[0-9A-F]{8}$/u.test(id))!;
const roleIdOf = (fn: [string, Resource]): string => ((fn[1].Properties.Role as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"])[0];
const variablesOf = (fn: [string, Resource]): Record<string, unknown> => (fn[1].Properties.Environment as { Variables: Record<string, unknown> }).Variables;

const ids = (json: Json) => ({ queue: queueNamed(json, coreLessonsReflectQueueName("staging"))![0], dead: queueNamed(json, coreLessonsReflectDeadLetterName("staging"))![0] });
const policyFor = (json: Json, queueId: string): [string, Resource] => {
  const found = resourcesOf(json, "AWS::SQS::QueuePolicy").filter(([, policy]) => JSON.stringify(policy.Properties.Queues) === JSON.stringify([{ Ref: queueId }]));
  expect(found).toHaveLength(1);
  return found[0]!;
};
const statementsOf = (policy: [string, Resource]): Statement[] => (policy[1].Properties.PolicyDocument as { Statement: Statement[] }).Statement;

/** The TLS-only Deny every queue of the stack carries (enforceSSL). */
const tlsDeny = (arn: unknown): Statement => ({ Action: "sqs:*", Condition: { Bool: { "aws:SecureTransport": "false" } }, Effect: "Deny", Principal: { AWS: "*" }, Resource: arn });

/** The one Allow each queue policy must hold, exactly. */
const expectedAllow = (json: Json, target: string, sid: string, actions: readonly string[]): Statement => ({
  Sid: sid, Effect: "Allow", Action: [...actions], Principal: { AWS: { "Fn::GetAtt": [roleIdOf(brokerOf(json)), "Arn"] } }, Resource: { "Fn::GetAtt": [target, "Arn"] },
});

/**
 * The grants of the two reflection queues as violations: an empty list is the passing case, every widening below must make it non-empty. Checks both queue policies exactly (the TLS deny and the
 * broker's one Allow), that no identity policy anywhere names either queue, and that the dispatcher's role and variables carry neither.
 */
function violations(json: Json): string[] {
  const found: string[] = [];
  const { queue, dead } = ids(json);
  for (const [target, sid, actions] of [[queue, "BrokerUsesLessonsReflectQueue", CORE_BROKER_REFLECT_QUEUE_ACTIONS], [dead, "BrokerReadsLessonsReflectDeadLetterAttributes", CORE_BROKER_REFLECT_DEAD_LETTER_ACTIONS]] as const) {
    const statements = statementsOf(policyFor(json, target));
    const allows = statements.filter((statement) => statement.Effect !== "Deny");
    const denies = statements.filter((statement) => statement.Effect === "Deny");
    if (!isDeepStrictEqual(denies, [tlsDeny({ "Fn::GetAtt": [target, "Arn"] })])) found.push(`${target}: the Deny statements are not exactly the TLS-only one: ${JSON.stringify(denies)}`);
    // CDK writes a one-action statement's Action as a string and a longer one as a list: compare the action SET.
    const normalized = allows.map((statement) => ({ ...statement, Action: list(statement.Action) }));
    if (allows.length !== 1 || !isDeepStrictEqual(normalized[0], expectedAllow(json, target, sid, actions))) found.push(`${target}: the Allow is not exactly the broker's: ${JSON.stringify(allows)}`);
  }
  for (const [id, policy] of resourcesOf(json, "AWS::IAM::Policy")) {
    const text = JSON.stringify(policy.Properties.PolicyDocument);
    if (text.includes(queue) || text.includes(dead)) found.push(`the identity policy ${id} names a reflection queue`);
  }
  // No other queue policy mentions them, and none grants the dispatcher.
  for (const [id, policy] of resourcesOf(json, "AWS::SQS::QueuePolicy")) {
    if (id === policyFor(json, queue)[0] || id === policyFor(json, dead)[0]) continue;
    if (JSON.stringify(policy).includes(queue) || JSON.stringify(policy).includes(dead)) found.push(`another queue policy (${id}) names a reflection queue`);
  }
  const dispatcherRole = roleIdOf(dispatcherOf(json));
  for (const [id, policy] of resourcesOf(json, "AWS::SQS::QueuePolicy")) if ((id === policyFor(json, queue)[0] || id === policyFor(json, dead)[0]) && JSON.stringify(policy).includes(dispatcherRole)) found.push(`the dispatcher's role is in ${id}`);
  const dispatcherEnvironment = JSON.stringify(variablesOf(dispatcherOf(json)));
  if (dispatcherEnvironment.includes(queue) || dispatcherEnvironment.includes(dead) || dispatcherEnvironment.includes("REFLECT")) found.push("the dispatcher is given a reflection queue's URL or name");
  return found;
}

/** A copy of the template with one of the reflection queues' policies changed by `change` (the policy's statements). */
function mutated(which: "queue" | "dead", change: (statements: Statement[], target: string) => void): Json {
  const copy = structuredClone(named);
  const target = ids(copy)[which];
  change(statementsOf(policyFor(copy, target)), target);
  return copy;
}

describe("the lessons reflection queue (L4-SQS, B3c)", () => {
  const { queue, dead } = ids(named);

  it("has the fixed per-environment names, apart from the core dispatch queues", () => {
    expect(coreLessonsReflectQueueName("staging")).toBe("agentx-staging-lessons-reflect");
    expect(coreLessonsReflectDeadLetterName("staging")).toBe("agentx-staging-lessons-reflect-dead");
    const names = resourcesOf(named, "AWS::SQS::Queue").map(([, resource]) => resource.Properties.QueueName);
    expect(names).toEqual(expect.arrayContaining([coreLessonsReflectQueueName("staging"), coreLessonsReflectDeadLetterName("staging"), coreDispatchQueueName("staging"), coreDispatchDeadLetterName("staging")]));
    expect(queue).not.toBe(dead);
  });

  it("is declared as lessons/reflect-queue.ts asks for it: visibility 1800 s, five receives, then its OWN dead-letter queue (never the dispatch dead letters)", () => {
    expect(LESSONS_REFLECT_VISIBILITY_SECONDS).toBe(1800);
    expect(LESSONS_REFLECT_MAX_RECEIVES).toBe(5);
    const properties = named.Resources[queue]!.Properties;
    expect(properties.VisibilityTimeout).toBe(1800);
    const redrive = properties.RedrivePolicy as { maxReceiveCount: number; deadLetterTargetArn: { "Fn::GetAtt": [string, string] } };
    expect(redrive.maxReceiveCount).toBe(5);
    expect(redrive.deadLetterTargetArn["Fn::GetAtt"]).toEqual([dead, "Arn"]);
    expect(redrive.deadLetterTargetArn["Fn::GetAtt"][0]).not.toBe(queueNamed(named, coreDispatchDeadLetterName("staging"))![0]);
  });

  it("is encrypted with SQS-managed keys like the core dispatch queues; the dead letters keep 14 days, hold no redrive of their own, and accept redrives from this queue only", () => {
    expect(named.Resources[queue]!.Properties).toMatchObject({ SqsManagedSseEnabled: true });
    expect(named.Resources[dead]!.Properties).toMatchObject({ SqsManagedSseEnabled: true, MessageRetentionPeriod: 14 * 24 * 60 * 60 });
    expect(named.Resources[dead]!.Properties).not.toHaveProperty("RedrivePolicy");
    expect(named.Resources[dead]!.Properties.RedriveAllowPolicy).toEqual({ redrivePermission: "byQueue", sourceQueueArns: [{ "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":sqs:", { Ref: "AWS::Region" }, ":", { Ref: "AWS::AccountId" }, `:${coreLessonsReflectQueueName("staging")}`]] }] });
  });

  it("is granted on the queues' own policies, to the broker alone, with exactly the actions the code calls (queue: five; dead letters: GetQueueAttributes only)", () => {
    expect(violations(named)).toEqual([]);
    expect([...CORE_BROKER_REFLECT_QUEUE_ACTIONS].sort()).toEqual(["sqs:ChangeMessageVisibility", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ReceiveMessage", "sqs:SendMessage"]);
    expect([...CORE_BROKER_REFLECT_DEAD_LETTER_ACTIONS]).toEqual(["sqs:GetQueueAttributes"]);
    // Narrower than the dispatch queue's dead letters, which the adapter also re-sends from: here nothing sends to or reads the dead letters.
    expect(CORE_BROKER_QUEUE_ACTIONS.length).toBeGreaterThan(CORE_BROKER_REFLECT_DEAD_LETTER_ACTIONS.length);
  });

  it("derives its URLs from the environment's name: the broker's environment grows by nothing, and the dispatcher is given neither", () => {
    const derived = DERIVED_BROKER_VARIABLES.filter((entry) => entry.kind === "queueUrl");
    expect(derived.map((entry) => [entry.variable, (entry as { queueName: (env: string) => string }).queueName("staging")])).toEqual(expect.arrayContaining([
      [CORE_LESSONS_REFLECT_QUEUE_URL_VARIABLE, "agentx-staging-lessons-reflect"], [CORE_LESSONS_REFLECT_DEAD_LETTER_URL_VARIABLE, "agentx-staging-lessons-reflect-dead"],
    ]));
    const broker = unpackedBrokerVariables(variablesOf(brokerOf(named)), named);
    expect(broker[CORE_LESSONS_REFLECT_QUEUE_URL_VARIABLE]).toBe("agentx-staging-lessons-reflect");
    expect(broker[CORE_LESSONS_REFLECT_DEAD_LETTER_URL_VARIABLE]).toBe("agentx-staging-lessons-reflect-dead");
    // Not a variable of the function itself (derived at start from AGENTX_ENV), and nothing on the dispatcher.
    expect(Object.keys(variablesOf(brokerOf(named))).filter((key) => key.includes("REFLECT"))).toEqual([]);
    expect(Object.keys(variablesOf(dispatcherOf(named))).filter((key) => key.includes("REFLECT"))).toEqual([]);
  });

  it("leaves the dispatcher's SQS grants exactly as they were (B18: no widening; the only change is in code)", () => {
    const role = roleIdOf(dispatcherOf(named));
    const sqs = Object.values(named.Resources)
      .filter((resource) => resource.Type === "AWS::IAM::Policy" && JSON.stringify(resource.Properties.Roles).includes(role))
      .flatMap((resource) => (resource.Properties.PolicyDocument as { Statement: Statement[] }).Statement)
      .filter((statement) => list(statement.Action).some((action) => /^(sqs:|\*)/u.test(String(action))));
    // The spec 056 dispatch queue's consumer statement and the core queue's one (Receive, Delete, ChangeVisibility, GetQueueAttributes; never send, never the dead letters).
    expect(sqs.map((statement) => statement.Sid ?? "(spec 056 consumer)").sort()).toEqual(["(spec 056 consumer)", "ConsumeCoreDispatchQueue"].sort());
    for (const statement of sqs) expect(list(statement.Action)).not.toContain("sqs:SendMessage");
  });

  it("is not in the legacy template, which keeps its queues, its policies and its variables", () => {
    expect(JSON.stringify(legacy)).not.toMatch(/lessons-reflect|REFLECT_QUEUE|LessonsReflect/u);
    expect(resourcesOf(legacy, "AWS::SQS::Queue").some(([, resource]) => /reflect/u.test(String(resource.Properties.QueueName)))).toBe(false);
  });

  describe("widening mutants fail the exact check", () => {
    const mutants: Array<[string, "queue" | "dead", (statements: Statement[], target: string) => void]> = [
      ["queue: widens the actions to sqs:*", "queue", (s) => { s.find((x) => x.Effect === "Allow")!.Action = "sqs:*"; }],
      ["queue: adds sqs:PurgeQueue", "queue", (s) => { s.find((x) => x.Effect === "Allow")!.Action = [...CORE_BROKER_REFLECT_QUEUE_ACTIONS, "sqs:PurgeQueue"]; }],
      ["queue: drops sqs:SendMessage", "queue", (s) => { s.find((x) => x.Effect === "Allow")!.Action = CORE_BROKER_REFLECT_QUEUE_ACTIONS.filter((action) => action !== "sqs:SendMessage"); }],
      ["queue: a * principal", "queue", (s) => { s.find((x) => x.Effect === "Allow")!.Principal = { AWS: "*" }; }],
      ["queue: the account root as principal", "queue", (s) => { s.find((x) => x.Effect === "Allow")!.Principal = { AWS: { "Fn::Join": ["", ["arn:aws:iam::", { Ref: "AWS::AccountId" }, ":root"]] } }; }],
      ["queue: adds the dispatcher's role as a second principal", "queue", (s) => { s.find((x) => x.Effect === "Allow")!.Principal = { AWS: [{ "Fn::GetAtt": [roleIdOf(brokerOf(named)), "Arn"] }, { "Fn::GetAtt": [roleIdOf(dispatcherOf(named)), "Arn"] }] }; }],
      ["queue: a * resource", "queue", (s) => { s.find((x) => x.Effect === "Allow")!.Resource = "*"; }],
      ["queue: drops the TLS-only Deny", "queue", (s) => { s.splice(s.findIndex((x) => x.Effect === "Deny"), 1); }],
      ["queue: a second Allow for any principal", "queue", (s, t) => { s.push({ Effect: "Allow", Action: "sqs:SendMessage", Principal: { AWS: "*" }, Resource: { "Fn::GetAtt": [t, "Arn"] } }); }],
      ["queue: an Allow with a condition-free extra statement for the dispatcher", "queue", (s, t) => { s.push({ Effect: "Allow", Action: "sqs:SendMessage", Principal: { AWS: { "Fn::GetAtt": [roleIdOf(dispatcherOf(named)), "Arn"] } }, Resource: { "Fn::GetAtt": [t, "Arn"] } }); }],
      ["dead: adds sqs:SendMessage", "dead", (s) => { s.find((x) => x.Effect === "Allow")!.Action = ["sqs:GetQueueAttributes", "sqs:SendMessage"]; }],
      ["dead: adds sqs:ReceiveMessage", "dead", (s) => { s.find((x) => x.Effect === "Allow")!.Action = ["sqs:GetQueueAttributes", "sqs:ReceiveMessage"]; }],
      ["dead: the queue's five actions", "dead", (s) => { s.find((x) => x.Effect === "Allow")!.Action = [...CORE_BROKER_REFLECT_QUEUE_ACTIONS]; }],
      ["dead: a * principal", "dead", (s) => { s.find((x) => x.Effect === "Allow")!.Principal = { AWS: "*" }; }],
      ["dead: drops the TLS-only Deny", "dead", (s) => { s.splice(s.findIndex((x) => x.Effect === "Deny"), 1); }],
    ];
    for (const [name, which, change] of mutants) {
      it(name, () => {
        expect(violations(mutated(which, change)).length).toBeGreaterThan(0);
      });
    }

    it("an identity policy that names a reflection queue (on the broker's or the dispatcher's role) fails", () => {
      for (const fn of [brokerOf(named), dispatcherOf(named)]) {
        const copy = structuredClone(named);
        const policy = Object.values(copy.Resources).find((resource) => resource.Type === "AWS::IAM::Policy" && JSON.stringify(resource.Properties.Roles).includes(roleIdOf(fn)))!;
        (policy.Properties.PolicyDocument as { Statement: Statement[] }).Statement.push({ Effect: "Allow", Action: "sqs:SendMessage", Resource: { "Fn::GetAtt": [ids(copy).queue, "Arn"] } });
        expect(violations(copy).length).toBeGreaterThan(0);
      }
    });

    it("giving the dispatcher a reflection variable fails", () => {
      const copy = structuredClone(named);
      variablesOf(dispatcherOf(copy))[CORE_LESSONS_REFLECT_QUEUE_URL_VARIABLE] = { Ref: ids(copy).queue };
      expect(violations(copy).length).toBeGreaterThan(0);
    });

    it("changing the options the adapter checks (visibility, receives, the dead-letter target) is caught by the declaration test's expectations", () => {
      for (const change of [
        (properties: Record<string, unknown>) => { properties.VisibilityTimeout = 30; },
        (properties: Record<string, unknown>) => { (properties.RedrivePolicy as { maxReceiveCount: number }).maxReceiveCount = 6; },
        (properties: Record<string, unknown>) => { (properties.RedrivePolicy as { deadLetterTargetArn: unknown }).deadLetterTargetArn = { "Fn::GetAtt": [queueNamed(named, coreDispatchDeadLetterName("staging"))![0], "Arn"] }; },
      ]) {
        const copy = structuredClone(named);
        change(copy.Resources[ids(copy).queue]!.Properties);
        const properties = copy.Resources[ids(copy).queue]!.Properties;
        const redrive = properties.RedrivePolicy as { maxReceiveCount: number; deadLetterTargetArn: { "Fn::GetAtt": [string, string] } };
        const ok = properties.VisibilityTimeout === LESSONS_REFLECT_VISIBILITY_SECONDS && redrive.maxReceiveCount === LESSONS_REFLECT_MAX_RECEIVES && redrive.deadLetterTargetArn["Fn::GetAtt"][0] === ids(copy).dead;
        expect(ok).toBe(false);
      }
    });
  });
});

// A small IAM evaluator for the boundary simulation: glob match on actions and resources, no condition operator beyond what the policies here use (anything else throws, so the simulation never
// silently skips a condition). Explicit Deny wins; otherwise an Allow is needed. No AWS call.
const glob = (pattern: string, value: string, ignoreCase: boolean): boolean => {
  const source = pattern.replace(/[.+^${}()|[\]\\]/gu, "\\$&").replace(/\*/gu, ".*").replace(/\?/gu, ".");
  return new RegExp(`^${source}$`, ignoreCase ? "iu" : "u").test(value);
};
function conditionHolds(condition: unknown, context: Record<string, string>): boolean {
  if (condition === undefined) return true;
  return Object.entries(condition as Record<string, Record<string, string | string[]>>).every(([operator, keys]) => {
    if (operator !== "StringEquals" && operator !== "StringNotEquals" && operator !== "Bool") throw new Error(`the simulation does not evaluate condition operator ${operator}`);
    return Object.entries(keys).every(([key, expected]) => {
      const matches = list(expected).includes(context[key]);
      return operator === "StringNotEquals" ? !matches : matches;
    });
  });
}
function evaluate(statements: PolicyStatementJson[], action: string, resource: string, context: Record<string, string> = {}): "allow" | "deny" | "implicit-deny" {
  const applicable = statements.filter((statement) => list(statement.Action).some((pattern) => glob(String(pattern), action, true))
    && list(statement.Resource).some((pattern) => glob(String(pattern), resource, false)) && conditionHolds(statement.Condition, context));
  if (applicable.some((statement) => statement.Effect === "Deny")) return "deny";
  return applicable.some((statement) => statement.Effect === "Allow") ? "allow" : "implicit-deny";
}

describe("the permissions boundary and the deploy role allow the grants (simulated from the policy code)", () => {
  const scope: PolicyScope = {
    env: "staging", partition: "aws", region: "us-west-2", account: "111122223333", artifactBucketArn: "arn:aws:s3:::agentx-staging-artifacts", pullThroughPrefix: "agentx", cloudFormationRoleName: "agentx-staging-cloudformation",
  };
  const boundary = defaultBoundaryStatements(scope);
  const deploy = serviceRoleStatements(scope);
  const arn = (name: string) => `arn:aws:sqs:${scope.region}:${scope.account}:${name}`;
  const reflect = arn(coreLessonsReflectQueueName("staging"));
  const reflectDead = arn(coreLessonsReflectDeadLetterName("staging"));

  it("the boundary (sqs:* on *, no sqs Deny) allows every action the broker is granted on both queues; an action outside the boundary's services (sts:AssumeRole) is implicitly denied (control)", () => {
    for (const action of CORE_BROKER_REFLECT_QUEUE_ACTIONS) expect(evaluate(boundary, action, reflect), action).toBe("allow");
    for (const action of CORE_BROKER_REFLECT_DEAD_LETTER_ACTIONS) expect(evaluate(boundary, action, reflectDead), action).toBe("allow");
    expect(boundary.some((statement) => statement.Effect === "Deny" && list(statement.Action).some((action) => glob(String(action), "sqs:SendMessage", true)))).toBe(false);
    expect(evaluate(boundary, "sts:AssumeRole", `arn:aws:iam::${scope.account}:role/some-role`)).toBe("implicit-deny");
  });

  it("the deploy role may create, tag and attach a policy to the two queues with the actions it already holds for the core dispatch queues (no new deploy-role action)", () => {
    for (const resource of [reflect, reflectDead, arn(coreDispatchQueueName("staging")), arn(coreDispatchDeadLetterName("staging"))]) {
      for (const action of ["sqs:CreateQueue", "sqs:SetQueueAttributes", "sqs:GetQueueAttributes", "sqs:TagQueue", "sqs:DeleteQueue", "sqs:ListQueueTags"]) expect(evaluate(deploy, action, resource), `${action} ${resource}`).toBe("allow");
    }
  });

  describe("the queue policies, evaluated as SQS evaluates a same-account role principal", () => {
    const { queue, dead } = ids(named);
    const brokerRole = roleIdOf(brokerOf(named));
    const dispatcherRole = roleIdOf(dispatcherOf(named));
    /** SQS's own order: a Deny that matches wins; else an Allow whose principal, action and resource match; else implicit deny. The principal is a role of the stack, named by its logical id. */
    const as = (roleId: string, target: string, arnValue: string, action: string, secure = "true"): "allow" | "deny" | "implicit-deny" => {
      const principalMatches = (statement: Statement): boolean => list((statement.Principal as { AWS: unknown }).AWS).some((entry) => entry === "*" || JSON.stringify(entry) === JSON.stringify({ "Fn::GetAtt": [roleId, "Arn"] }));
      const matching = statementsOf(policyFor(named, target)).filter((statement) => principalMatches(statement)
        && list(statement.Action).some((pattern) => glob(String(pattern), action, true)) && conditionHolds(statement.Condition, { "aws:SecureTransport": secure }));
      void arnValue;
      if (matching.some((statement) => statement.Effect === "Deny")) return "deny";
      return matching.some((statement) => statement.Effect === "Allow") ? "allow" : "implicit-deny";
    };

    it("the broker: all five on the queue, GetQueueAttributes only on the dead letters", () => {
      for (const action of CORE_BROKER_REFLECT_QUEUE_ACTIONS) expect(as(brokerRole, queue, reflect, action), action).toBe("allow");
      expect(as(brokerRole, dead, reflectDead, "sqs:GetQueueAttributes")).toBe("allow");
      for (const action of ["sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:PurgeQueue", "sqs:SetQueueAttributes", "sqs:DeleteQueue"]) expect(as(brokerRole, dead, reflectDead, action), `dead ${action}`).toBe("implicit-deny");
      for (const action of ["sqs:PurgeQueue", "sqs:SetQueueAttributes", "sqs:DeleteQueue", "sqs:AddPermission", "sqs:RemovePermission"]) expect(as(brokerRole, queue, reflect, action), `queue ${action}`).toBe("implicit-deny");
    });

    it("the dispatcher (control for B18's narrowness): nothing on either reflection queue, so a send from there would fail, and no request over plain HTTP passes for anyone", () => {
      for (const action of [...CORE_BROKER_REFLECT_QUEUE_ACTIONS]) expect(as(dispatcherRole, queue, reflect, action), action).toBe("implicit-deny");
      expect(as(dispatcherRole, dead, reflectDead, "sqs:GetQueueAttributes")).toBe("implicit-deny");
      expect(as(brokerRole, queue, reflect, "sqs:SendMessage", "false")).toBe("deny");
    });
  });
});
