import { readFileSync } from "node:fs";
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { CONTROL_PLANE_LAMBDAS, type CfnTemplate } from "../../scripts/test-deploy.js";
import { lambdaRoleIds } from "../../scripts/test-deploy-check.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

// LIVEFIX-1: the notifier read WORKFLOW_DISPATCH, its IAM grant allowed only four other partition keys, and every blocked VERIFY/REVIEW card was refused by DynamoDB for an hour and then
// dropped. This guard is the CI form of "does the code only touch keys its role may": for every control-plane Lambda, each State-table partition key written literally in the Lambda's own
// source file (`pk: "NAME"` or `pk: \`NAME#${...}\``) must be allowed by one of the role's DynamoDB statements, for the action the call makes when that can be read from the code around it.
//
// What it cannot see, said plainly: keys built by a helper in another file (taskKey, workspaceKey and the like) and keys named only in a shared module. Those stay covered by the infrastructure
// tests of each construct; this guard closes the class "a new inline key literal in a Lambda's entry file has no grant".

skipLambdaBundling();

type Statement = { Effect?: string; Action?: string | string[]; Resource?: unknown; Condition?: Record<string, Record<string, string | string[]>> };
type Resource = { Type: string; Properties?: Record<string, unknown> };

function controlPlaneTemplate(): CfnTemplate {
  const env = "agentxlivetest123";
  const stack = buildAgentXApp({ agentxEnv: env, "agentx:e2eQualificationTransport": "enabled" }).node.children
    .filter((child): child is Stack => Stack.isStack(child))
    .find((candidate) => candidate.stackName === `agentx-${env}-control-plane`);
  if (stack === undefined) throw new Error(`expected the real ${env} control-plane stack`);
  return Template.fromStack(stack).toJSON();
}

const list = <T>(value: T | T[] | undefined): T[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

/** Every statement of every policy attached to the role (separate policies and the role's own inline ones). */
function statementsOfRole(template: CfnTemplate, roleLogicalId: string): Statement[] {
  const statements: Statement[] = [];
  const document = (value: unknown) => list((value as { Statement?: Statement | Statement[] } | undefined)?.Statement);
  for (const [logicalId, resource] of Object.entries((template.Resources ?? {}) as Record<string, Resource>)) {
    const properties = resource.Properties ?? {};
    if ((resource.Type === "AWS::IAM::Policy" || resource.Type === "AWS::IAM::ManagedPolicy")
      && list(properties.Roles as unknown[]).some((role) => (role as { Ref?: string } | undefined)?.Ref === roleLogicalId)) statements.push(...document(properties.PolicyDocument));
    if (resource.Type === "AWS::IAM::Role" && logicalId === roleLogicalId) {
      for (const inline of list(properties.Policies as Array<{ PolicyDocument?: unknown }> | undefined)) statements.push(...document(inline.PolicyDocument));
    }
  }
  return statements;
}

const globToRegExp = (glob: string): RegExp => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);

/** Whether the role's statements let it perform `action` on a State-table item whose partition key is `key`. A DynamoDB statement without a LeadingKeys condition allows every key. */
function roleAllowsKey(statements: readonly Statement[], action: string | undefined, key: string): boolean {
  return statements.some((statement) => {
    if (statement.Effect !== "Allow") return false;
    const actions = list(statement.Action).filter((candidate) => candidate.toLowerCase().startsWith("dynamodb:"));
    if (actions.length === 0) return false;
    if (action !== undefined && !actions.some((candidate) => globToRegExp(candidate.toLowerCase()).test(`dynamodb:${action}`.toLowerCase()))) return false;
    const condition = statement.Condition;
    if (condition === undefined) return true;
    const conditionKeys = Object.keys(condition);
    // Only the LeadingKeys form this repository writes is understood; any other condition is not read as an allowance (fails closed).
    if (conditionKeys.length !== 1 || conditionKeys[0] !== "ForAllValues:StringLike") return false;
    const patterns = list(condition["ForAllValues:StringLike"]?.["dynamodb:LeadingKeys"]);
    return patterns.some((pattern) => globToRegExp(pattern).test(key));
  });
}

interface KeyUse { prefix: string; sample: string; action: string | undefined; line: number }

const ACTION_MARKERS: ReadonlyArray<[RegExp, string]> = [
  [/getItem\b|GetCommand\b/g, "GetItem"], [/QueryCommand\b/g, "Query"], [/PutCommand\b|\bPut:/g, "PutItem"],
  [/UpdateCommand\b|\bUpdate:/g, "UpdateItem"], [/DeleteCommand\b|\bDelete:/g, "DeleteItem"], [/\bConditionCheck:/g, "ConditionCheckItem"],
];

/** The partition-key literals of a source file, each with the DynamoDB action named closest before it (undefined when the code around it names none). */
function keyUses(source: string): KeyUse[] {
  const uses: KeyUse[] = [];
  const literal = /\bpk:\s*(["'`])([A-Z][A-Z0-9_]*)(#?)/g;
  for (let match = literal.exec(source); match !== null; match = literal.exec(source)) {
    const [, quote, name, hash] = match;
    const sample = hash === "#" ? `${name}#x` : name!;
    const before = source.slice(Math.max(0, match.index - 350), match.index);
    let action: string | undefined;
    let nearest = -1;
    for (const [pattern, candidate] of ACTION_MARKERS) {
      for (const found of before.matchAll(pattern)) if (found.index > nearest) { nearest = found.index; action = candidate; }
    }
    void quote;
    uses.push({ prefix: hash === "#" ? `${name}#` : name!, sample, action, line: source.slice(0, match.index).split("\n").length });
  }
  return uses;
}

const repoRoot = new URL("../../", import.meta.url);
const template = controlPlaneTemplate();
const roles = lambdaRoleIds(template);

describe("every control-plane Lambda's DynamoDB key literals are allowed by its IAM grant", () => {
  it("covers every Lambda test-deploy moves, so a new one cannot skip the guard", () => {
    for (const [unit, { logicalId }] of Object.entries(CONTROL_PLANE_LAMBDAS)) expect(roles[logicalId], `${unit} has a role in the template`).toBeDefined();
  });

  for (const [unit, { logicalId, entry }] of Object.entries(CONTROL_PLANE_LAMBDAS)) {
    it(`${unit}: each partition key its entry file names is granted for the action it makes`, () => {
      const statements = statementsOfRole(template, roles[logicalId]!);
      const refused = keyUses(readFileSync(new URL(entry, repoRoot), "utf8"))
        .filter((use) => !roleAllowsKey(statements, use.action, use.sample))
        .map((use) => `${entry}:${use.line} ${use.action ?? "any action"} on ${use.prefix}`);
      expect(refused).toEqual([]);
    });
  }

  it("is not vacuous: the notifier file names WORKFLOW_DISPATCH, and a role without that key is refused it", () => {
    const uses = keyUses(readFileSync(new URL(CONTROL_PLANE_LAMBDAS["developer-task-notifier"].entry, repoRoot), "utf8"));
    expect(uses.map((use) => use.prefix)).toEqual(expect.arrayContaining(["WORKFLOW_DISPATCH", "DEVTASK#", "WORKSPACE#", "CHATGPT_NOTICE#"]));
    const withoutIt: Statement[] = [{ Effect: "Allow", Action: ["dynamodb:GetItem", "dynamodb:Query"], Condition: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DEVTASK#*"] } } }];
    expect(roleAllowsKey(withoutIt, "GetItem", "WORKFLOW_DISPATCH")).toBe(false);
    expect(roleAllowsKey(withoutIt, "GetItem", "DEVTASK#t1")).toBe(true);
    // The action matters as well as the key: a read grant is no write grant.
    expect(roleAllowsKey(withoutIt, "PutItem", "DEVTASK#t1")).toBe(false);
    // A statement with no key condition allows every key; any condition this guard cannot read allows none.
    expect(roleAllowsKey([{ Effect: "Allow", Action: "dynamodb:*" }], "UpdateItem", "ANYTHING#x")).toBe(true);
    expect(roleAllowsKey([{ Effect: "Allow", Action: "dynamodb:GetItem", Condition: { StringEquals: { "dynamodb:LeadingKeys": ["X"] } } }], "GetItem", "X")).toBe(false);
  });

  it("the notifier's grant for WORKFLOW_DISPATCH is a single-item read, never a query, a write or a wildcard", () => {
    const statements = statementsOfRole(template, roles[CONTROL_PLANE_LAMBDAS["developer-task-notifier"].logicalId]!);
    expect(roleAllowsKey(statements, "GetItem", "WORKFLOW_DISPATCH")).toBe(true);
    for (const action of ["Query", "PutItem", "UpdateItem", "DeleteItem", "Scan"]) expect(roleAllowsKey(statements, action, "WORKFLOW_DISPATCH"), action).toBe(false);
    expect(roleAllowsKey(statements, "GetItem", "WORKFLOW_DISPATCH_OTHER")).toBe(false);
  });
});
