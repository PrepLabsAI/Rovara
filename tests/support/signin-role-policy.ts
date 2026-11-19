// DEC 254zzz33: what the synthesized named control plane lets the sign-in function's role do on the sign-in table, as DynamoDB would authorize it: every item of a
// TransactWriteItems is authorized as its own action (Put -> PutItem, Update -> UpdateItem, Delete -> DeleteItem, ConditionCheck -> ConditionCheckItem) on its partition key.
// Used to prove each code path's calls are covered (tests/contract/signin-company-grants.test.ts, sign-in-links.test.ts). No AWS call; any condition this evaluator
// does not know refuses (fails closed).
// The caller synthesizes the template (a deployment test may import the CDK; this support file does not).

type Resource = { Type: string; Properties: Record<string, unknown> };
type Statement = { Effect: string; Action: string | string[]; Resource: unknown; Condition?: Record<string, Record<string, unknown>> };
export interface TableCall { action: string; pk: string }
export interface SignInRolePolicy { allows(call: TableCall): boolean; statements: Statement[]; template: { Resources: Record<string, Resource> } }

const glob = (pattern: string, flags = "") => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/gu, "\\$&").replaceAll("*", ".*").replaceAll("?", ".")}$`, flags);

/** A synthesized named control plane's sign-in role statements on the sign-in table. */
export function signInRolePolicy(options: { template: unknown }): SignInRolePolicy {
  const template = options.template as { Resources: Record<string, Resource> };
  const ids = Object.keys(template.Resources);
  const role = ids.filter((id) => /^DeveloperSignInFunctionServiceRole[0-9A-F]{8}$/u.test(id));
  const table = ids.filter((id) => /^DeveloperSignInTable[0-9A-F]{8}$/u.test(id) && template.Resources[id]!.Type === "AWS::DynamoDB::Table");
  if (role.length !== 1 || table.length !== 1) throw new Error("test setup: sign-in role or table not found");
  const statements = Object.values(template.Resources)
    .filter((resource) => resource.Type === "AWS::IAM::Policy" && JSON.stringify(resource.Properties.Roles) === JSON.stringify([{ Ref: role[0] }]))
    .flatMap((resource) => (resource.Properties.PolicyDocument as { Statement: Statement[] }).Statement);
  const onTable = (statement: Statement) => [statement.Resource].flat().some((resource) => JSON.stringify(resource) === JSON.stringify({ "Fn::GetAtt": [table[0], "Arn"] }));
  const conditionHolds = (condition: Statement["Condition"], pk: string): boolean => Object.entries(condition ?? {}).every(([operator, fields]) => Object.entries(fields).every(([key, value]) => {
    if (key !== "dynamodb:LeadingKeys") return false;
    const values = [value].flat() as string[];
    if (operator === "Null") return values.length === 1 && values[0] === (pk === "" ? "true" : "false");
    if (pk === "") return operator.startsWith("ForAllValues:");
    if (operator === "ForAllValues:StringLike") return values.some((pattern) => glob(pattern).test(pk));
    if (operator === "ForAllValues:StringEquals") return values.includes(pk);
    return false;
  }));
  return {
    statements, template,
    allows: ({ action, pk }) => statements.some((statement) => statement.Effect === "Allow" && onTable(statement)
      && [statement.Action].flat().some((pattern) => glob(pattern, "i").test(action)) && conditionHolds(statement.Condition, pk))
      && !statements.some((statement) => statement.Effect === "Deny" && onTable(statement) && [statement.Action].flat().some((pattern) => glob(pattern, "i").test(action))),
  };
}

const ITEM_ACTIONS: Record<string, string> = { Put: "dynamodb:PutItem", Update: "dynamodb:UpdateItem", Delete: "dynamodb:DeleteItem", ConditionCheck: "dynamodb:ConditionCheckItem" };
const COMMAND_ACTIONS: Record<string, string> = { GetCommand: "dynamodb:GetItem", PutCommand: "dynamodb:PutItem", UpdateCommand: "dynamodb:UpdateItem", DeleteCommand: "dynamodb:DeleteItem", QueryCommand: "dynamodb:Query" };

/** The sign-in table calls one SDK command makes, as IAM authorizes them. */
export function tableCallsOf(command: { constructor: { name: string }; input: Record<string, unknown> }, tableName: string): TableCall[] {
  const input = command.input as { TableName?: string; Key?: { pk?: unknown }; Item?: { pk?: unknown }; KeyConditionExpression?: string; ExpressionAttributeValues?: Record<string, unknown>; TransactItems?: Array<Record<string, { TableName?: string; Key?: { pk?: unknown }; Item?: { pk?: unknown } }>> };
  if (command.constructor.name === "TransactWriteCommand") {
    return (input.TransactItems ?? []).flatMap((item) => Object.entries(item).filter(([, body]) => body.TableName === tableName).map(([kind, body]) => {
      const pk = body.Key?.pk ?? body.Item?.pk;
      return { action: ITEM_ACTIONS[kind] ?? `unexpected:${kind}`, pk: typeof pk === "string" ? pk : "" };
    }));
  }
  // A batch or transactional read naming the table is not modelled here: it fails closed rather than passing unchecked.
  if (JSON.stringify((command.input as { RequestItems?: unknown }).RequestItems ?? {}).includes(`"${tableName}"`) || (command.constructor.name === "TransactGetCommand" && JSON.stringify(input).includes(`"${tableName}"`))) {
    return [{ action: `unexpected:${command.constructor.name}`, pk: "" }];
  }
  if (input.TableName !== tableName) return [];
  const placeholder = /\bpk\s*=\s*(:\w+)/u.exec(input.KeyConditionExpression ?? "")?.[1];
  const pk = input.Key?.pk ?? input.Item?.pk ?? (placeholder === undefined ? undefined : input.ExpressionAttributeValues?.[placeholder]);
  return [{ action: COMMAND_ACTIONS[command.constructor.name] ?? `unexpected:${command.constructor.name}`, pk: typeof pk === "string" ? pk : "" }];
}

/** A document client that refuses, as DynamoDB would with AccessDenied, any sign-in table call `policy` does not allow, and records every call it saw. */
export function underSignInRole<C extends { send(command: never): Promise<unknown> }>(client: C, policy: Pick<SignInRolePolicy, "allows">, tableName: string, seen: Array<TableCall & { allowed: boolean }>) {
  return {
    send: async (command: { constructor: { name: string }; input: Record<string, unknown> }): Promise<unknown> => {
      const calls = tableCallsOf(command, tableName).map((call) => ({ ...call, allowed: policy.allows(call) }));
      seen.push(...calls);
      if (calls.some((call) => !call.allowed)) throw Object.assign(new Error("not authorized to perform this action"), { name: "AccessDeniedException" });
      return client.send(command as never);
    },
  };
}
