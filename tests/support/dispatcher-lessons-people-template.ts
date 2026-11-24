// The dispatcher's lessons people port (infra/lib/dispatcher-lessons-people.ts), as a synthesized control-plane template shows it, for the tests that pin "everything else" and for the tests
// that ask what the dispatcher's role may do on the sign-in table.
//  - `withoutDispatcherLessonsPeople` checks the addition is exactly this (one environment variable on the dispatcher, one inline policy of two GetItem statements) and takes it out, so the
//    pins and snapshots recorded before it still hold (Rule D: a re-pin is only for exactly this addition).
//  - `dispatcherRolePolicy` reads every statement the dispatcher's role has and answers, as DynamoDB would authorize it, whether one GetItem is allowed. Any condition key or operator it does
//    not know throws (fails closed), so a widened grant cannot pass by being unreadable.
import { expect } from "vitest";
import { TASK_PERSON_COMPANY_MEMBER_ATTRIBUTES, TASK_PERSON_DEVELOPER_RECORD_ATTRIBUTES } from "@agentx/contracts";

type Resource = { Type: string; Properties: Record<string, unknown>; DependsOn?: unknown; Condition?: string };
type Template = { Resources: Record<string, Resource> };
export interface JsonStatement { Sid?: string; Effect: string; Action?: string | string[]; NotAction?: string | string[]; Resource?: unknown; NotResource?: unknown; Condition?: Record<string, Record<string, unknown>> | undefined }

export const SIGNIN_TABLE_VARIABLE = "DEVELOPER_SIGNIN_TABLE_NAME";

const hashless = (logicalId: string) => logicalId.replace(/[0-9A-F]{8}$/u, "");
const list = <T>(value: T | T[] | undefined): T[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);
const glob = (pattern: string, flags = "") => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/gu, "\\$&").replaceAll("*", ".*").replaceAll("?", ".")}$`, flags);

/** The logical ids of the template's one sign-in table, dispatcher function and dispatcher role. */
export function dispatcherIds(template: Template): { table: string; dispatcher: string; role: string } {
  const only = (type: string, pattern: RegExp): string => {
    const found = Object.entries(template.Resources).filter(([id, resource]) => resource.Type === type && pattern.test(id)).map(([id]) => id);
    expect(found, `${type} ${pattern}`).toHaveLength(1);
    return found[0]!;
  };
  return {
    table: only("AWS::DynamoDB::Table", /^DeveloperSignInTable[0-9A-F]{8}$/u),
    dispatcher: only("AWS::Lambda::Function", /^Dispatcher[0-9A-F]{8}$/u),
    role: only("AWS::IAM::Role", /^DispatcherServiceRole[0-9A-F]{8}$/u),
  };
}

/** The two statements the dispatcher is granted on the sign-in table: GetItem on the table's ARN alone, each limited to its partition-key prefix and its projected attributes. */
export function expectedPeopleStatements(tableId: string): JsonStatement[] {
  const grant = (sid: string, prefix: string, attributes: readonly string[]): JsonStatement => ({
    Sid: sid,
    Effect: "Allow",
    Action: "dynamodb:GetItem",
    Resource: { "Fn::GetAtt": [tableId, "Arn"] },
    Condition: {
      "ForAllValues:StringLike": { "dynamodb:LeadingKeys": [prefix] },
      "ForAllValues:StringEquals": { "dynamodb:Attributes": [...attributes] },
      StringEqualsIfExists: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
      Null: { "dynamodb:LeadingKeys": "false", "dynamodb:Attributes": "false" },
    },
  });
  return [
    grant("ReadCompanyMemberRoster", "COMPANY_MEMBER#*", TASK_PERSON_COMPANY_MEMBER_ATTRIBUTES),
    grant("ReadDeveloperDisplay", "DEVELOPER#*", TASK_PERSON_DEVELOPER_RECORD_ATTRIBUTES),
  ];
}

/** The dispatcher role's own policy resources (every AWS::IAM::Policy and ManagedPolicy naming the role, and the role's inline Policies): id, name, and document. */
export function dispatcherPolicies(template: Template): Array<{ id: string; policyName: unknown; statements: JsonStatement[] }> {
  const { role } = dispatcherIds(template);
  const named = (value: unknown) => list(value as unknown[]).some((entry) => JSON.stringify(entry) === JSON.stringify({ Ref: role }));
  const found = Object.entries(template.Resources)
    .filter(([, resource]) => (resource.Type === "AWS::IAM::Policy" || resource.Type === "AWS::IAM::ManagedPolicy") && named(resource.Properties.Roles))
    .map(([id, resource]) => ({ id, policyName: resource.Properties.PolicyName, statements: list((resource.Properties.PolicyDocument as { Statement: JsonStatement | JsonStatement[] }).Statement) }));
  const inline = ((template.Resources[role]!.Properties.Policies ?? []) as Array<{ PolicyName: unknown; PolicyDocument: { Statement: JsonStatement | JsonStatement[] } }>)
    .map((policy, index) => ({ id: `${role}.Policies[${index}]`, policyName: policy.PolicyName, statements: list(policy.PolicyDocument.Statement) }));
  return [...found, ...inline];
}

/**
 * Asserts the addition is exactly: the dispatcher's one `DEVELOPER_SIGNIN_TABLE_NAME` variable (a plain Ref of the sign-in table, never conditional) and one `DispatcherLessonsPeople` policy on
 * the dispatcher's role holding exactly the two statements, then removes both. Mutates and returns `input` (clone first to keep the original).
 */
export function withoutDispatcherLessonsPeople<T>(input: T): T {
  const template = input as unknown as Template;
  const ids = dispatcherIds(template);
  const variables = (template.Resources[ids.dispatcher]!.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
  expect(variables[SIGNIN_TABLE_VARIABLE]).toStrictEqual({ Ref: ids.table });
  delete variables[SIGNIN_TABLE_VARIABLE];
  const policies = Object.entries(template.Resources).filter(([id, resource]) => resource.Type === "AWS::IAM::Policy" && hashless(id) === "DispatcherLessonsPeople");
  expect(policies, "exactly one DispatcherLessonsPeople policy").toHaveLength(1);
  const [policyId, policy] = policies[0]!;
  expect(policy.Properties.Roles).toStrictEqual([{ Ref: ids.role }]);
  expect((policy.Properties.PolicyDocument as { Statement: unknown }).Statement).toStrictEqual(expectedPeopleStatements(ids.table));
  expect(Object.keys(policy.Properties).sort()).toStrictEqual(["PolicyDocument", "PolicyName", "Roles"]);
  expect(policy.Condition).toBeUndefined();
  expect(policy.DependsOn).toBeUndefined();
  delete template.Resources[policyId];
  return input;
}

/** One GetItem-style request as DynamoDB puts it to IAM: the action, the resource (an ARN, or the intrinsic that gives it), and the request context keys. */
export interface DynamoRequest { action: string; resource: unknown; leadingKeys: string[]; attributes?: string[] | undefined; select?: string | undefined }

/** The request's values for one condition key; undefined when the request carries none. Any other key throws. */
function contextOf(key: string, request: DynamoRequest): string[] | undefined {
  if (key === "dynamodb:LeadingKeys") return request.leadingKeys;
  if (key === "dynamodb:Attributes") return request.attributes;
  if (key === "dynamodb:Select") return request.select === undefined ? undefined : [request.select];
  throw new Error(`unsupported IAM condition key ${key}`);
}

function operatorHolds(operator: string, patterns: string[], context: string[] | undefined): boolean {
  switch (operator) {
    case "Null": return patterns.includes(String(context === undefined || context.length === 0));
    case "StringEqualsIfExists": return context === undefined || context.every((value) => patterns.includes(value));
    case "ForAllValues:StringEquals": return (context ?? []).every((value) => patterns.includes(value));
    case "ForAllValues:StringLike": return (context ?? []).every((value) => patterns.some((pattern) => glob(pattern).test(value)));
    default: throw new Error(`unsupported IAM condition operator ${operator}`);
  }
}

function conditionHolds(condition: JsonStatement["Condition"], request: DynamoRequest): boolean {
  return Object.entries(condition ?? {}).every(([operator, keys]) => Object.entries(keys).every(([key, expected]) => operatorHolds(operator, list(expected as string | string[]), contextOf(key, request))));
}

const resourceMatches = (resource: unknown, request: unknown): boolean => list(resource as unknown[]).some((entry) => (typeof entry === "string" && typeof request === "string" ? glob(entry).test(request) : JSON.stringify(entry) === JSON.stringify(request)));

/** Whether `statements` allow the request: an Allow matches (action, resource, condition) and no Deny does. */
export function dynamoAllows(statements: readonly JsonStatement[], request: DynamoRequest): boolean {
  const applies = (statement: JsonStatement): boolean => {
    const actionMatches = statement.NotAction !== undefined ? !list(statement.NotAction).some((pattern) => glob(pattern, "i").test(request.action)) : list(statement.Action).some((pattern) => glob(pattern, "i").test(request.action));
    if (!actionMatches) return false;
    const resourceHolds = statement.NotResource !== undefined ? !resourceMatches(statement.NotResource, request.resource) : resourceMatches(statement.Resource, request.resource);
    return resourceHolds && conditionHolds(statement.Condition, request);
  };
  const matching = statements.filter(applies);
  return matching.some((statement) => statement.Effect === "Allow") && !matching.some((statement) => statement.Effect === "Deny");
}

/** What a synthesized control plane's dispatcher role may do (all its policies together). */
export function dispatcherRolePolicy(template: Template): { statements: JsonStatement[]; tableArn: unknown; allows(request: Omit<DynamoRequest, "resource"> & { resource?: unknown }): boolean } {
  const ids = dispatcherIds(template);
  const statements = dispatcherPolicies(template).flatMap((policy) => policy.statements);
  const tableArn = { "Fn::GetAtt": [ids.table, "Arn"] };
  return { statements, tableArn, allows: (request) => dynamoAllows(statements, { ...request, resource: request.resource ?? tableArn }) };
}
