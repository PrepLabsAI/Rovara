// The dispatcher's lessons people port (aws/worker-machines/dispatcher-people.ts) needs `DEVELOPER_SIGNIN_TABLE_NAME` and two projected GetItem reads of the sign-in table. This pins, on the
// control plane as synthesized for every layout (the legacy install, a named environment, and the longest environment name), exactly what the dispatcher is given: the variable (the real table,
// never conditional), the one inline policy (two statements, GetItem only, the table's ARN only, the shared attribute lists), that no other dispatcher statement reaches the sign-in table, what the
// grant allows and refuses under the permissions boundary, and that the role's inline size and the function's environment stay inside their limits.
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { TASK_PERSON_COMPANY_MEMBER_ATTRIBUTES, TASK_PERSON_DEVELOPER_RECORD_ATTRIBUTES, defaultBoundaryStatements } from "@agentx/contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { legacyRuntimeBoundaryStatements } from "../../infra/lib/legacy-runtime-boundary.js";
import { TASK_PERSON_COMPANY_MEMBER_ATTRIBUTES as RUNTIME_MEMBER, TASK_PERSON_DEVELOPER_RECORD_ATTRIBUTES as RUNTIME_DEVELOPER } from "../../packages/broker/src/aws/task-person-runtime.js";
import { dispatcherIds, dispatcherPolicies, dispatcherRolePolicy, dynamoAllows, expectedPeopleStatements, SIGNIN_TABLE_VARIABLE, type JsonStatement } from "../support/dispatcher-lessons-people-template.js";
import { LAMBDA_ENVIRONMENT_LIMIT_BYTES, Resolver, controlPlaneOf, DEPLOY_PARAMETER_VALUES } from "../support/lambda-environment-size.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Json = Record<string, unknown>;
type Template_ = { Resources: Record<string, { Type: string; Properties: Json }> };
interface Layout { name: string; env: string | undefined; template: Template_; stackName: string }

/** IAM's limit on a role's inline policies together, and the repo's convention of keeping 1,500 characters spare. */
const INLINE_LIMIT = 10_240;
const INLINE_SPARE = 1_500;
const LONGEST_ENV = "headroom-longest-env"; // 20 characters: the contract maximum.

function synthesize(env: string | undefined): { template: Template_; stackName: string } {
  const app = buildAgentXApp(env === undefined ? {} : { agentxEnv: env });
  const stack = app.node.children.find((child): child is Stack => Stack.isStack(child) && child.node.id === "AgentXControlPlane");
  if (stack === undefined) throw new Error("no control plane stack");
  return { template: Template.fromStack(stack).toJSON() as Template_, stackName: stack.stackName };
}

const layouts: Layout[] = [];
beforeAll(() => {
  for (const [name, env] of [["legacy", undefined], ["named", "staging"], ["longest name", LONGEST_ENV]] as const) layouts.push({ name, env, ...synthesize(env) });
}, 240_000);

const scope = (env: string) => ({ env, partition: "aws", region: "us-east-1", account: "111122223333", artifactBucketArn: "arn:aws:s3:::agentx-artifacts", pullThroughPrefix: "agentx", cloudFormationRoleName: `agentx-${env}-cloudformation` });
const MEMBER_READ = { action: "dynamodb:GetItem", leadingKeys: ["COMPANY_MEMBER#abc"], attributes: [...TASK_PERSON_COMPANY_MEMBER_ATTRIBUTES], select: undefined };
const DEVELOPER_READ = { action: "dynamodb:GetItem", leadingKeys: ["DEVELOPER#abc"], attributes: [...TASK_PERSON_DEVELOPER_RECORD_ATTRIBUTES], select: undefined };

describe("the attribute lists the grant names are the ones the runtime projects", () => {
  it("are the shared lists, whole, in order", () => {
    expect([...RUNTIME_MEMBER]).toEqual([...TASK_PERSON_COMPANY_MEMBER_ATTRIBUTES]);
    expect([...RUNTIME_DEVELOPER]).toEqual([...TASK_PERSON_DEVELOPER_RECORD_ATTRIBUTES]);
    expect([...TASK_PERSON_DEVELOPER_RECORD_ATTRIBUTES]).not.toContain("mergedInto");
  });
});

describe.each(["legacy", "named", "longest name"])("the dispatcher's lessons people grant, %s layout", (name) => {
  const layout = () => layouts.find((candidate) => candidate.name === name)!;

  it("sets DEVELOPER_SIGNIN_TABLE_NAME to the real sign-in table, once, with no condition and no empty value", () => {
    const { template } = layout();
    const ids = dispatcherIds(template);
    const variables = (template.Resources[ids.dispatcher]!.Properties.Environment as { Variables: Json }).Variables;
    expect(variables[SIGNIN_TABLE_VARIABLE]).toStrictEqual({ Ref: ids.table });
    expect(template.Resources[ids.table]!.Type).toBe("AWS::DynamoDB::Table");
    // Nothing else in the template overwrites it for this function, and no other function was given a different table.
    expect(JSON.stringify(variables)).not.toContain('"Fn::If"');
    expect(Object.keys(variables).filter((key) => key === SIGNIN_TABLE_VARIABLE)).toHaveLength(1);
  });

  it("adds exactly one inline policy of two GetItem statements on the table's ARN, and no other dispatcher statement reaches the sign-in table", () => {
    const { template } = layout();
    const ids = dispatcherIds(template);
    const policies = dispatcherPolicies(template);
    const ours = policies.filter((policy) => policy.id.replace(/[0-9A-F]{8}$/u, "") === "DispatcherLessonsPeople");
    expect(ours).toHaveLength(1);
    expect(ours[0]!.statements).toStrictEqual(expectedPeopleStatements(ids.table));
    for (const statement of ours[0]!.statements) {
      expect(statement.Action).toBe("dynamodb:GetItem");
      expect(statement.Resource).toStrictEqual({ "Fn::GetAtt": [ids.table, "Arn"] });
      expect(JSON.stringify(statement)).not.toContain("/index/");
    }
    for (const policy of policies.filter((candidate) => candidate !== ours[0])) {
      for (const statement of policy.statements) expect(JSON.stringify(statement), `${policy.id} ${statement.Sid ?? ""}`).not.toContain(ids.table);
    }
    // The default policy (and every pin on it) is untouched: the dispatcher's own other policies are the default policy and the core engine's.
    expect(policies.map((policy) => policy.id.replace(/[0-9A-F]{8}$/u, "")).sort()).toEqual(["CoreEngineJobsDispatcherCorePolicy", "DispatcherLessonsPeople", "DispatcherServiceRoleDefaultPolicy"].sort());
  });

  it("allows the code's two real reads (strongly projected) and refuses everything else on the sign-in table", () => {
    const { template } = layout();
    const policy = dispatcherRolePolicy(template);
    expect(policy.allows(MEMBER_READ)).toBe(true);
    expect(policy.allows(DEVELOPER_READ)).toBe(true);
    // A projection of fewer attributes is still inside the grant.
    expect(policy.allows({ ...MEMBER_READ, attributes: ["pk", "sk"] })).toBe(true);
    const refused: Array<[string, Parameters<typeof policy.allows>[0]]> = [
      ["no projection (a whole-row read)", { ...MEMBER_READ, attributes: undefined }],
      ["another key prefix", { ...MEMBER_READ, leadingKeys: ["COMPANY#abc"] }],
      ["the other family's prefix with the member attributes", { ...DEVELOPER_READ, attributes: [...TASK_PERSON_COMPANY_MEMBER_ATTRIBUTES] }],
      ["a wider attribute", { ...DEVELOPER_READ, attributes: [...TASK_PERSON_DEVELOPER_RECORD_ATTRIBUTES, "mergedInto"] }],
      ["no key", { ...MEMBER_READ, leadingKeys: [] }],
      ["Query", { ...MEMBER_READ, action: "dynamodb:Query" }],
      ["Scan", { ...MEMBER_READ, action: "dynamodb:Scan" }],
      ["BatchGetItem", { ...MEMBER_READ, action: "dynamodb:BatchGetItem" }],
      ["PutItem", { ...MEMBER_READ, action: "dynamodb:PutItem" }],
      ["UpdateItem", { ...MEMBER_READ, action: "dynamodb:UpdateItem" }],
      ["DeleteItem", { ...MEMBER_READ, action: "dynamodb:DeleteItem" }],
      ["an index", { ...MEMBER_READ, resource: { "Fn::Join": ["", [policy.tableArn, "/index/*"]] } }],
      ["another table", { ...MEMBER_READ, resource: "arn:aws:dynamodb:us-east-1:111122223333:table/other" }],
    ];
    for (const [label, request] of refused) expect(policy.allows(request), label).toBe(false);
  });

  it("is inside the permissions boundary of its layout (nothing to change there)", () => {
    const table = "arn:aws:dynamodb:us-east-1:111122223333:table/the-sign-in-table";
    const request = { action: "dynamodb:GetItem", resource: table, leadingKeys: [], attributes: undefined };
    const { env } = layout();
    if (env === undefined) {
      const statements = new Stack().resolve(legacyRuntimeBoundaryStatements().map((statement): unknown => statement.toStatementJson())) as unknown as JsonStatement[];
      expect(dynamoAllows(statements.map((statement) => ({ ...statement, Condition: undefined })), request)).toBe(true);
    } else {
      expect(dynamoAllows(defaultBoundaryStatements(scope(env)) as unknown as JsonStatement[], request)).toBe(true);
    }
  });

  it("keeps the dispatcher role's inline policies and the function's environment inside their limits", () => {
    const { template, stackName, env } = layout();
    const resolver = new Resolver(template, { env: env ?? "production", stackName, parameterValues: DEPLOY_PARAMETER_VALUES });
    const size = dispatcherPolicies(template).reduce((total, policy) => {
      const document = JSON.stringify(resolver.resolve({ Version: "2012-10-17", Statement: policy.statements })).replace(/\s/gu, "");
      return total + document.length + resolver.text(policy.policyName ?? "").length;
    }, 0);
    expect(size).toBeLessThanOrEqual(INLINE_LIMIT - INLINE_SPARE);
    const dispatcher = controlPlaneOf(env ?? "production", { template, stackName }).functions.find((fn) => /^Dispatcher[0-9A-F]{8}$/u.test(fn.logicalId))!;
    expect(dispatcher.variables[SIGNIN_TABLE_VARIABLE]).toBeTruthy();
    expect(dispatcher.bytes).toBeLessThan(LAMBDA_ENVIRONMENT_LIMIT_BYTES);
    expect(dispatcher.keyValueBytes).toBeLessThan(LAMBDA_ENVIRONMENT_LIMIT_BYTES);
  });
});
