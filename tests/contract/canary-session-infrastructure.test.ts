// tests/contract/canary-session-infrastructure.test.ts
// CANARY-SESSION, the infrastructure: the legacy control plane's canary function exists only when the deploy names all four placement values with CanarySessionPlacementEnvironment beta; its resource policy
// holds one permission (the step role); its role can do exactly what a session start and end do; the token key's deny names its role only while it exists; the named layout has none of it.
import { Stack } from "aws-cdk-lib";
import { beforeAll, describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { CANARY_SESSION_PARAMETERS } from "../../infra/lib/canary-session.js";
import { CANARY_SESSION_STEP_ROLE_SUFFIX } from "@agentx/contracts";
import { CANARY_RESOURCE_TYPES, canaryDeploy } from "../support/canary-session-template.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";
import { legacyProductionStacks, normalizedTemplate } from "../support/template-snapshot.js";
import { CANARY, COMPANY, OTHER_COMPANY, OWNER, world } from "../support/canary-session-world.js";
import { tableCallsOf, type TableCall } from "../support/signin-role-policy.js";

skipLambdaBundling();

type Json = Record<string, unknown>;
type Resource = { Type: string; Properties: Json; Condition?: string };
type Statement = { Effect: string; Action: string | string[]; Resource: unknown; Sid?: string; Condition?: Record<string, Record<string, unknown>>; Principal?: unknown };
type Template = { Parameters: Record<string, Json>; Conditions: Record<string, unknown>; Rules?: Record<string, { RuleCondition: unknown; Assertions: Array<{ Assert: unknown }> }>; Resources: Record<string, Resource>; Outputs: Record<string, Json & { Condition?: string }> };

const STEP_ROLE = `example${CANARY_SESSION_STEP_ROLE_SUFFIX}`;
const FULL: Record<string, string> = { CanarySessionPlacementEnvironment: "beta", CanarySessionPerson: CANARY, CanarySessionCompany: COMPANY, CanarySessionStepRoleName: STEP_ROLE };
const EMPTY: Record<string, string> = Object.fromEntries(CANARY_SESSION_PARAMETERS.map((name) => [name, ""]));

let template: Template;
beforeAll(() => {
  const stack = legacyProductionStacks().find((candidate) => candidate.stackName === "AgentXControlPlane")!;
  template = normalizedTemplate(stack) as Template;
}, 120_000);

const isCanary = (id: string) => id.startsWith("DeveloperSignInCanarySession");
const canaryIds = () => Object.keys(template.Resources).filter(isCanary);
const deploy = (values: Record<string, string>) => canaryDeploy(template, values);

describe("the canary session function exists only for the beta settings", () => {
  it("declares exactly four placement parameters, all empty by default, each with the one pattern its row names; the issuer is not one of them (it is read from the stack)", () => {
    const declared = Object.keys(template.Parameters).filter((name) => name.startsWith("CanarySession"));
    expect(declared.sort()).toEqual([...CANARY_SESSION_PARAMETERS].sort());
    expect(declared).toEqual(["CanarySessionCompany", "CanarySessionPerson", "CanarySessionPlacementEnvironment", "CanarySessionStepRoleName"]);
    for (const name of declared) {
      expect(template.Parameters[name]!.Default, name).toBe("");
      expect(template.Parameters[name]!.AllowedValues, `${name} uses a pattern, not allowedValues`).toBeUndefined();
      expect(String(template.Parameters[name]!.Description), name).toMatch(/^PLACEMENT, operator only, beta only\./u);
    }
    const accepts = (name: string, value: string) => new RegExp(template.Parameters[name]!.AllowedPattern as string, "u").test(value);
    expect(accepts("CanarySessionPlacementEnvironment", "beta")).toBe(true);
    for (const wrong of ["staging", "production", "Beta", "beta ", " beta", "betas", "prod"]) expect(accepts("CanarySessionPlacementEnvironment", wrong), wrong).toBe(false);
    expect(accepts("CanarySessionPerson", CANARY) && accepts("CanarySessionCompany", COMPANY) && accepts("CanarySessionStepRoleName", STEP_ROLE)).toBe(true);
    for (const empty of declared) expect(accepts(empty, ""), `${empty} may be empty`).toBe(true);
  });

  it("the step role is a NAME pinned to the canary stack's role name ending: an ARN (any account), a production-shaped or another name is refused at the parameter", () => {
    const accepts = (value: string) => new RegExp(template.Parameters.CanarySessionStepRoleName!.AllowedPattern as string, "u").test(value);
    const ok = `example${CANARY_SESSION_STEP_ROLE_SUFFIX}`;
    expect(accepts(ok)).toBe(true);
    for (const wrong of [
      `arn:aws:iam::111122223333:role/${ok}`, `arn:aws:iam::999988887777:role/${ok}`, "example-production-canary-step-role", "example-staging-canary-step-role", "admin", `path/${ok}`, `${ok}-x`, ` ${ok}`, `${ok}\n`, `Example${CANARY_SESSION_STEP_ROLE_SUFFIX}`,
      CANARY_SESSION_STEP_ROLE_SUFFIX.slice(1), `x${CANARY_SESSION_STEP_ROLE_SUFFIX.slice(1)}`, "*", "*-beta-canary-step-role",
    ]) expect(accepts(wrong), JSON.stringify(wrong)).toBe(false);
  });

  it("with the defaults (production's deploy answers) the template creates none of it", () => {
    expect(canaryIds().length).toBeGreaterThan(0);
    const { created, ruleOk, allowed } = deploy(EMPTY);
    expect(created).toEqual([]);
    expect(ruleOk).toBe(true);
    expect(allowed).toBe(true);
  });

  it("with all four set and CanarySessionPlacementEnvironment beta it creates exactly the function, its log group, role, role policy, one invoke permission, two metric filters and three alarms", () => {
    const { created, ruleOk, allowed } = deploy(FULL);
    expect(allowed && ruleOk).toBe(true);
    expect(created.map((id) => template.Resources[id]!.Type).sort()).toEqual([...CANARY_RESOURCE_TYPES].sort());
    expect(created.sort()).toEqual(canaryIds().sort());
  });

  it("any other environment value is refused at deploy (not an allowed value), and any partial set fails the template rule: nothing is built quietly", () => {
    for (const environment of ["staging", "production", "Beta", "beta "]) expect(deploy({ ...FULL, CanarySessionPlacementEnvironment: environment }).allowed, environment).toBe(false);
    for (const name of CANARY_SESSION_PARAMETERS) {
      const partial = { ...FULL, [name]: "" };
      const answer = deploy(partial);
      expect(answer.ruleOk, `${name} empty`).toBe(false);
      expect(answer.created, `${name} empty`).toEqual([]);
    }
    for (const name of CANARY_SESSION_PARAMETERS) {
      const only = { ...EMPTY, [name]: FULL[name]! };
      expect(deploy(only).ruleOk, `only ${name}`).toBe(false);
    }
  });

  it("every resource of the function carries the one condition, and no canary resource is anything else", () => {
    const conditions = new Set(canaryIds().map((id) => template.Resources[id]!.Condition));
    expect(conditions.size).toBe(1);
    expect([...conditions][0]).toMatch(/^DeveloperSignInCanarySessionCanarySessionIsOn/u);
    const outputs = Object.entries(template.Outputs).filter(([name]) => name.startsWith("CanarySession"));
    expect(outputs.map(([name, output]) => [name, output.Condition])).toEqual([["CanarySessionFunctionArn", [...conditions][0]]]);
  });

  it("the legacy name is fixed (known before the stack exists) and its ARN is the output", () => {
    const fn = Object.entries(template.Resources).find(([id, resource]) => isCanary(id) && resource.Type === "AWS::Lambda::Function")!;
    expect(fn[1].Properties.FunctionName).toBe("agentx-production-canary-session");
    expect(template.Outputs.CanarySessionFunctionArn!.Value).toEqual({ "Fn::GetAtt": [fn[0], "Arn"] });
  });

  it("the function's environment pins beta and the issuer, takes the person and company from parameters, and holds no secret", () => {
    const fn = Object.entries(template.Resources).find(([id, resource]) => isCanary(id) && resource.Type === "AWS::Lambda::Function")![1];
    const variables = (fn.Properties.Environment as { Variables: Json }).Variables;
    expect(variables).toMatchObject({ CANARY_ENVIRONMENT: { Ref: "CanarySessionPlacementEnvironment" }, CANARY_DEVELOPER_ID: { Ref: "CanarySessionPerson" }, CANARY_COMPANY_ID: { Ref: "CanarySessionCompany" }, AGENTX_ENV: "production" });
    // The issuer is READ from the stack: the very value the sign-in function signs for, never a parameter.
    expect(variables.CANARY_ISSUER).toEqual(variables.DEVELOPER_TOKEN_ISSUER);
    expect(JSON.stringify(variables.CANARY_ISSUER)).toContain("HasPublicApiUrl");
    expect(Object.keys(variables).sort()).toEqual(["AGENTX_ENV", "CANARY_COMPANY_ID", "CANARY_DEVELOPER_ID", "CANARY_ENVIRONMENT", "CANARY_ISSUER", "DEVELOPER_SIGNIN_TABLE_NAME", "DEVELOPER_TOKEN_ISSUER", "DEVELOPER_TOKEN_KEY_ARN"]);
    expect(JSON.stringify(variables)).not.toMatch(/secret/iu);
  });
});

describe("who may call it", () => {
  const fnId = () => Object.entries(template.Resources).find(([id, resource]) => isCanary(id) && resource.Type === "AWS::Lambda::Function")![0];
  const references = (id: string) => Object.entries(template.Resources).filter(([other, resource]) => other !== id && JSON.stringify(resource).includes(`"${id}"`)).map(([other, resource]) => `${other}:${resource.Type}`);

  it("the function's resource policy holds exactly one permission: invoke, for the step role (its name from the parameter, its account this stack's own) and nothing else", () => {
    const permissions = Object.entries(template.Resources).filter(([, resource]) => resource.Type === "AWS::Lambda::Permission" && JSON.stringify(resource.Properties.FunctionName).includes(fnId()));
    expect(permissions).toHaveLength(1);
    expect(permissions[0]![1].Properties).toStrictEqual({ Action: "lambda:InvokeFunction", FunctionName: { "Fn::GetAtt": [fnId(), "Arn"] }, Principal: { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":iam::", { Ref: "AWS::AccountId" }, ":role/", { Ref: "CanarySessionStepRoleName" }]] } });
  });

  it("has no HTTP route, integration, function URL, event source, schedule, alias or other trigger, and no role in this stack is granted invoke on it", () => {
    // Only its invoke permission and its own invocations alarm (a dimension) name the function.
    expect(references(fnId()).sort()).toEqual([
      `${Object.keys(template.Resources).find((id) => id.startsWith("DeveloperSignInCanarySessionInvocationsAlarm"))}:AWS::CloudWatch::Alarm`,
      `${Object.keys(template.Resources).find((id) => id.startsWith("DeveloperSignInCanarySessionFunctionStepRoleInvokes"))}:AWS::Lambda::Permission`,
    ].sort());
    const types = new Set(Object.values(template.Resources).filter((resource) => JSON.stringify(resource).includes("canary-session") || JSON.stringify(resource).includes("CanarySession")).map((resource) => resource.Type));
    for (const forbidden of ["AWS::ApiGatewayV2::Route", "AWS::ApiGatewayV2::Integration", "AWS::Lambda::Url", "AWS::Lambda::EventSourceMapping", "AWS::Events::Rule", "AWS::Scheduler::Schedule", "AWS::Lambda::Alias", "AWS::Lambda::Version", "AWS::SNS::Subscription"]) expect(types.has(forbidden), forbidden).toBe(false);
    // No policy anywhere grants lambda:InvokeFunction on this function: a Resource naming its ARN, or any wildcard Lambda resource, in any identity policy of the stack.
    for (const [id, resource] of Object.entries(template.Resources)) {
      if (resource.Type !== "AWS::IAM::Policy" && resource.Type !== "AWS::IAM::ManagedPolicy") continue;
      const statements = (resource.Properties.PolicyDocument as { Statement: Statement[] }).Statement;
      for (const statement of statements) {
        if (statement.Effect !== "Allow" || ![statement.Action].flat().some((action) => /^lambda:(\*|invoke)/iu.test(action))) continue;
        expect(JSON.stringify(statement.Resource), `${id} ${statement.Sid ?? ""}`).not.toContain(fnId());
        expect(JSON.stringify(statement.Resource), `${id} ${statement.Sid ?? ""}`).not.toMatch(/^"\*"$/u);
      }
    }
  });

  it("DeveloperSignIn's own permission (the API route) is unchanged and its invokers are the broker and the API only", () => {
    const signIn = Object.entries(template.Resources).filter(([id, resource]) => resource.Type === "AWS::Lambda::Permission" && /^DeveloperSignInFunction/u.test(id));
    expect(signIn.map(([id]) => id.replace(/[0-9A-F]{8}$/u, ""))).toEqual(["DeveloperSignInFunctionApiInvoke"]);
    expect(signIn[0]![1].Properties.Principal).toBe("apigateway.amazonaws.com");
    expect(Object.values(template.Resources).some((resource) => resource.Type === "AWS::Lambda::Permission" && JSON.stringify(resource).includes("CanarySessionStepRoleName") && !JSON.stringify(resource).includes(fnId()))).toBe(false);
  });
});

describe("its mint log line is watched (arch ruling: alarmed on more than deploy-time use)", () => {
  const ofType = (type: string) => Object.entries(template.Resources).filter(([id, resource]) => isCanary(id) && resource.Type === type);
  const topic = () => Object.keys(template.Resources).find((id) => /^OperatorAlerts[0-9A-F]{8}$/u.test(id) && template.Resources[id]!.Type === "AWS::SNS::Topic")!;

  it("turns the mint and refusal log events of the function's own log group into metrics", () => {
    const filters = ofType("AWS::Logs::MetricFilter").map(([, resource]) => resource.Properties as { FilterPattern: string; LogGroupName: unknown; MetricTransformations: Array<{ MetricName: string; MetricNamespace: string; MetricValue: string }> });
    expect(filters.map((filter) => [filter.FilterPattern, filter.MetricTransformations.map((t) => [t.MetricName, t.MetricNamespace, t.MetricValue])]).sort()).toEqual([
      ['{ $.event = "signin.canary_refused" }', [["CanarySessionRefusals", "AgentX", "1"]]], ['{ $.event = "signin.canary_session" }', [["CanarySessionMints", "AgentX", "1"]]],
    ]);
    const group = ofType("AWS::Logs::LogGroup")[0]![0];
    for (const filter of filters) expect(filter.LogGroupName).toEqual({ Ref: group });
  });

  it("alarms on 7 mints in an hour (a run mints at most 3), on any refusal and on 15 calls in an hour, each telling the operator alerts topic, none treating silence as a breach", () => {
    const alarms = ofType("AWS::CloudWatch::Alarm").map(([, resource]) => resource.Properties as Record<string, unknown>);
    const by = Object.fromEntries(alarms.map((alarm) => [String(alarm.AlarmName), alarm]));
    expect(Object.keys(by).sort()).toEqual(["AgentXCanarySessionInvocations", "AgentXCanarySessionMints", "AgentXCanarySessionRefused"]);
    expect(by.AgentXCanarySessionMints).toMatchObject({ Namespace: "AgentX", MetricName: "CanarySessionMints", Statistic: "Sum", Period: 3600, Threshold: 7, ComparisonOperator: "GreaterThanOrEqualToThreshold" });
    expect(by.AgentXCanarySessionRefused).toMatchObject({ Namespace: "AgentX", MetricName: "CanarySessionRefusals", Statistic: "Sum", Period: 3600, Threshold: 1 });
    expect(by.AgentXCanarySessionInvocations).toMatchObject({ Namespace: "AWS/Lambda", MetricName: "Invocations", Statistic: "Sum", Period: 3600, Threshold: 15 });
    for (const alarm of alarms) expect(alarm, String(alarm.AlarmName)).toMatchObject({ AlarmActions: [{ Ref: topic() }], TreatMissingData: "notBreaching", EvaluationPeriods: 1 });
  });
});

describe("what its role may do", () => {
  const policy = () => Object.entries(template.Resources).find(([id, resource]) => isCanary(id) && resource.Type === "AWS::IAM::Policy")![1];
  const statements = () => (policy().Properties.PolicyDocument as { Statement: Statement[] }).Statement;

  it("is these statements and no others (no secret, no other table, no Lambda invoke, no wildcard resource beyond the trace writes)", () => {
    expect(statements().map((statement) => statement.Sid ?? "xray").sort()).toEqual(["EndSession", "ListCanaryCompanyMembers", "MintCounter", "ReadCanaryPersonAndCompany", "ReadTokenKey", "SignAccessToken", "StartSession", "xray"]);
    expect(statements().every((statement) => statement.Effect === "Allow")).toBe(true);
    const wildcard = statements().filter((statement) => statement.Resource === "*");
    expect(wildcard.map((statement) => statement.Action)).toEqual([["xray:PutTraceSegments", "xray:PutTelemetryRecords"]]);
    const actions = statements().flatMap((statement) => [statement.Action].flat()).sort();
    expect(actions).toEqual(["dynamodb:GetItem", "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:UpdateItem", "dynamodb:UpdateItem", "kms:GetPublicKey", "kms:Sign", "xray:PutTelemetryRecords", "xray:PutTraceSegments"]);
    expect(JSON.stringify(statements())).not.toMatch(/secretsmanager|lambda:|"\*"[^,\]]*dynamodb/u);
    // The key and the table are the sign-in function's own: the developer token key (signing and its public half only) and the sign-in table, by ARN reference.
    const keyArns = statements().filter((statement) => [statement.Action].flat().some((action) => action.startsWith("kms:"))).map((statement) => JSON.stringify(statement.Resource));
    expect(new Set(keyArns).size).toBe(1);
    expect(keyArns[0]).toMatch(/DeveloperSignInTokenKey/u);
    for (const statement of statements().filter((candidate) => [candidate.Action].flat().some((action) => action.startsWith("dynamodb:")))) expect(JSON.stringify(statement.Resource), statement.Sid).toMatch(/^\{"Fn::GetAtt":\["DeveloperSignInTable[0-9A-F]{8}","Arn"\]\}$/u);
  });

  it("every table statement is bound to key families by the leading-keys condition with the Null guard; the person's and company's keys are exact and built from the parameters", () => {
    for (const statement of statements().filter((candidate) => [candidate.Action].flat().some((action) => action.startsWith("dynamodb:")))) {
      expect(statement.Condition?.Null, statement.Sid).toEqual({ "dynamodb:LeadingKeys": "false" });
      expect(Object.keys(statement.Condition ?? {}).sort(), statement.Sid).toHaveLength(2);
    }
    const read = statements().find((statement) => statement.Sid === "ReadCanaryPersonAndCompany")!;
    expect(read.Condition!["ForAllValues:StringEquals"]).toBeDefined();
    expect(JSON.stringify(read.Condition)).toContain("CanarySessionPerson");
    expect(JSON.stringify(read.Condition)).toContain("CanarySessionCompany");
    expect(JSON.stringify(read.Condition)).not.toContain("*");
  });

  it("is enough: a mint, a refusal and a canary-end run under exactly this role, with every table call authorized as DynamoDB would", async () => {
    const resolved = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(resolved);
      if (typeof value === "object" && value !== null) {
        const object = value as Json;
        if ("Ref" in object) return FULL[object.Ref as string];
        if ("Fn::Join" in object) { const [separator, parts] = object["Fn::Join"] as [string, unknown[]]; return parts.map(resolved).join(separator); }
        return Object.fromEntries(Object.entries(object).map(([key, inner]) => [key, resolved(inner)]));
      }
      return value;
    };
    const glob = (pattern: string, flags = "") => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/gu, "\\$&").replaceAll("*", ".*").replaceAll("?", ".")}$`, flags);
    const allows = ({ action, pk }: TableCall): boolean => statements().some((statement) => {
      if (!JSON.stringify(statement.Resource).includes("DeveloperSignInTable") || ![statement.Action].flat().some((pattern) => glob(pattern, "i").test(action))) return false;
      const condition = resolved(statement.Condition) as Record<string, Record<string, unknown>>;
      return Object.entries(condition).every(([operator, fields]) => Object.entries(fields).every(([key, value]) => {
        const values = [value].flat() as string[];
        if (key !== "dynamodb:LeadingKeys") return false;
        if (operator === "Null") return values[0] === (pk === "" ? "true" : "false");
        if (pk === "") return operator.startsWith("ForAllValues:");
        return operator === "ForAllValues:StringLike" ? values.some((pattern) => glob(pattern).test(pk)) : operator === "ForAllValues:StringEquals" && values.includes(pk);
      }));
    });
    const seen: Array<TableCall & { allowed: boolean }> = [];
    const wrap = (db: { send(command: never): Promise<unknown> }) => ({
      send: async (command: { constructor: { name: string }; input: Record<string, unknown> }): Promise<unknown> => {
        const calls = tableCallsOf(command, "signin").map((call) => ({ ...call, allowed: allows(call) }));
        seen.push(...calls);
        if (calls.some((call) => !call.allowed)) throw Object.assign(new Error("not authorized to perform this action"), { name: "AccessDeniedException" });
        return db.send(command as never);
      },
    });
    const w = await world({ wrap });
    // A mint, a canary-end, and refusals reading the person, the membership, the company, its issuer row and its members: every call allowed.
    const minted = await w.run({ kind: "canary-session" }) as { ok: boolean };
    expect(minted.ok).toBe(true);
    expect(await w.run({ kind: "canary-end" })).toEqual({ ok: true });
    expect(seen.filter((call) => !call.allowed)).toEqual([]);
    const families = [...new Set(seen.map((call) => `${call.action} ${call.pk.replace(/[a-f0-9]{64}|org_[0-9a-z]{20}|[0-9a-f-]{36}|[0-9]{10}/gu, "<id>")}`))].sort();
    expect(families).toEqual([
      "dynamodb:GetItem CANARY_MINT#<id>", "dynamodb:GetItem COMPANY_MEMBER#<id>", "dynamodb:GetItem DEVELOPER#<id>", "dynamodb:GetItem ORG#<id>#COMPANY", "dynamodb:GetItem ORG#<id>#SIGNIN_ISSUER",
      "dynamodb:PutItem REFRESH#<id>", "dynamodb:PutItem SESSION#<id>", "dynamodb:Query ORG#<id>#MEMBERS", "dynamodb:UpdateItem CANARY_MINT#<id>", "dynamodb:UpdateItem SESSION#<id>",
    ].sort());
    // The policy is the person's and the company's own: another person's or company's row is refused under it.
    expect(allows({ action: "dynamodb:GetItem", pk: `DEVELOPER#${OWNER}` })).toBe(false);
    expect(allows({ action: "dynamodb:GetItem", pk: `ORG#${OTHER_COMPANY}#COMPANY` })).toBe(false);
    expect(allows({ action: "dynamodb:Query", pk: `ORG#${OTHER_COMPANY}#MEMBERS` })).toBe(false);
    expect(allows({ action: "dynamodb:DeleteItem", pk: `SESSION#x` })).toBe(false);
    expect(allows({ action: "dynamodb:PutItem", pk: `DEVELOPER#${CANARY}` })).toBe(false);
    expect(allows({ action: "dynamodb:GetItem", pk: "SESSION#x" })).toBe(false);
  });
});

describe("the developer token key", () => {
  const keyPolicy = () => {
    const key = Object.entries(template.Resources).find(([id, resource]) => resource.Type === "AWS::KMS::Key" && id.startsWith("DeveloperSignInTokenKey"))![1];
    return (key.Properties.KeyPolicy as { Statement: Statement[] }).Statement;
  };

  it("denies signing and its public half to everyone but the sign-in function's role, and, only while the canary function exists, its role", () => {
    const deny = keyPolicy().find((statement) => statement.Sid === "SignAndGetPublicKeyOnlyAsDeveloperIdentity")!;
    const principals = (deny.Condition!.ArnNotEquals as Json)["aws:PrincipalArn"] as { "Fn::If": [string, unknown[], unknown] };
    const [condition, whenOn, whenOff] = principals["Fn::If"];
    expect(condition).toMatch(/^DeveloperSignInCanarySessionCanarySessionIsOn/u);
    expect(whenOff).toEqual({ "Fn::GetAtt": [expect.stringMatching(/^DeveloperSignInFunctionServiceRole[0-9A-F]{8}$/u), "Arn"] });
    expect(whenOn).toEqual([whenOff, { "Fn::GetAtt": [expect.stringMatching(/^DeveloperSignInCanarySessionFunctionServiceRole[0-9A-F]{8}$/u), "Arn"] }]);
    expect(deny.Effect).toBe("Deny");
    expect([deny.Action].flat().sort()).toEqual(["kms:GetPublicKey", "kms:Sign"]);
  });

  it("the other keys' policies do not name the canary role", () => {
    for (const [id, resource] of Object.entries(template.Resources)) {
      if (resource.Type === "AWS::KMS::Key" && !id.startsWith("DeveloperSignInTokenKey")) expect(JSON.stringify(resource), id).not.toContain("CanarySession");
    }
  });
});

describe("other layouts", () => {
  it("a named environment's control plane has no canary function, parameter, rule, output or key-policy reference", () => {
    const stacks = buildAgentXApp({ agentxEnv: "staging" }).node.children.filter((child): child is Stack => Stack.isStack(child));
    const named = normalizedTemplate(stacks.find((candidate) => candidate.stackName === "agentx-staging-control-plane")!);
    expect(JSON.stringify(named)).not.toMatch(/canary/iu);
  });

  it("no other legacy stack mentions it", () => {
    for (const stack of legacyProductionStacks().filter((candidate) => candidate.stackName !== "AgentXControlPlane")) expect(JSON.stringify(normalizedTemplate(stack)), stack.stackName).not.toMatch(/canary/iu);
  });
});
