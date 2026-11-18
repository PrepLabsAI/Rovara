// ENV-ROOM: a named environment's broker is given its generated names packed (AGENTX_NAMES), its constrained settings packed (AGENTX_SETTINGS) and nothing it derives from the
// environment's name (packages/contracts/src/broker-environment.ts). For template tests that ask "what does the broker get for X", this unpacks a synthesized broker's Variables
// into one entry per variable the broker's code reads:
//  - a packed name: the BARE intrinsic the control plane packs (a queue's QueueName, a key's Ref (its id), a role's Ref (its name), a function's Ref, a state machine's Name),
//    not the URL or ARN the broker builds from it (tests/contract/broker-environment.test.ts proves the built values);
//  - HEALTH_DEAD_LETTER_QUEUES: `{ label: the queue's QueueName intrinsic }`;
//  - a packed setting: its parameter's Ref;
//  - a derived variable: the literal the broker derives from AGENTX_ENV (a core dispatch queue's URL as its fixed queue name).
// A legacy broker (nothing packed) is returned as it is.
// ENV-ROOM 2 (2026-11-17): a named broker's names are in their SSM parameter, not its Variables; pass the template and they are read from there (the parameter's Value less its
// `v1:<revision>:` prefix), and the parameter's name and revision are left out, as the broker's code reads neither once the handler has read the names.
import {
  BROKER_NAMES, BROKER_NAMES_PARAMETER_VARIABLE, BROKER_NAMES_REVISION_VARIABLE, BROKER_NAMES_VARIABLE, BROKER_SETTINGS, BROKER_SETTINGS_VARIABLE, DERIVED_BROKER_VARIABLES,
  type BrokerNameSpec, type BrokerSettingSpec,
} from "@agentx/contracts";

type TemplateResource = { Type: string; Properties?: Record<string, unknown>; DependsOn?: string[] };
export interface ResourcesTemplate { Resources: Record<string, TemplateResource> }

/** The SSM parameter a pointer names, in a synthesized template: its logical id and its Value split into the revision and the names list's Fn::Join (as AGENTX_NAMES was). */
export function brokerNamesParameterOf(template: ResourcesTemplate, pointer: string): { id: string; revision: string; names: { "Fn::Join": [string, unknown[]] } } {
  const found = Object.entries(template.Resources).filter(([, resource]) => resource.Type === "AWS::SSM::Parameter" && resource.Properties?.Name === pointer);
  if (found.length !== 1) throw new Error(`expected one parameter named ${pointer}, found ${found.length}`);
  const [id, resource] = found[0]!;
  const join = (resource.Properties?.Value as { "Fn::Join"?: [string, unknown[]] } | undefined)?.["Fn::Join"];
  if (join === undefined || join[0] !== "") throw new Error(`${pointer}'s value is not one Fn::Join with no separator`);
  // A snapshot's normalizedTemplate (template-snapshot.ts) writes every 64-hex string, the revision too, as <asset-hash>.
  const match = /^v1:([0-9a-f]{64}|<asset-hash>):(.*)$/u.exec(String(join[1][0]));
  if (match === null) throw new Error(`${pointer}'s value does not start with v1 and a revision`);
  const rest = join[1].slice(1);
  return { id, revision: match[1]!, names: { "Fn::Join": ["", match[2] === "" ? rest : [match[2]!, ...rest]] } };
}

function pieces(raw: unknown): Map<string, unknown> {
  const join = (raw as { "Fn::Join"?: [string, unknown[]] } | undefined)?.["Fn::Join"];
  const found = new Map<string, unknown>();
  if (join === undefined) return found;
  for (let index = 0; index < join[1].length; index += 2) {
    const code = /^,?([a-z]{2})=$/u.exec(String(join[1][index]))?.[1];
    if (code === undefined) throw new Error(`unexpected packed piece ${JSON.stringify(join[1][index])}`);
    found.set(code, join[1][index + 1]);
  }
  return found;
}

export function unpackedBrokerVariables(variables: Record<string, unknown>, template?: ResourcesTemplate): Record<string, unknown> {
  if (!(BROKER_NAMES_VARIABLE in variables) && !(BROKER_SETTINGS_VARIABLE in variables) && !(BROKER_NAMES_PARAMETER_VARIABLE in variables)) return variables;
  const { [BROKER_NAMES_VARIABLE]: inline, [BROKER_SETTINGS_VARIABLE]: settings, [BROKER_NAMES_PARAMETER_VARIABLE]: pointer, ...rest } = variables;
  // The revision is not a variable the broker's code reads.
  delete rest[BROKER_NAMES_REVISION_VARIABLE];
  let names = inline;
  if (pointer !== undefined) {
    if (template === undefined) throw new Error("this broker's names are in their SSM parameter: pass the template to unpack them");
    if (typeof pointer !== "string") throw new Error("the broker's names parameter pointer is not a string");
    names = brokerNamesParameterOf(template, pointer).names;
  }
  const out: Record<string, unknown> = { ...rest };
  const nameSpecs = new Map((Object.values(BROKER_NAMES) as BrokerNameSpec[]).map((spec) => [spec.code, spec]));
  const settingSpecs = new Map((Object.values(BROKER_SETTINGS) as BrokerSettingSpec[]).map((spec) => [spec.code, spec]));
  const deadLetters: Record<string, unknown> = {};
  for (const [code, value] of pieces(names)) {
    const spec = nameSpecs.get(code);
    if (spec === undefined) throw new Error(`unknown name code ${code}`);
    if (spec.kind === "deadLetterQueue") deadLetters[spec.label!] = value;
    else out[spec.variable] = value;
  }
  if (Object.keys(deadLetters).length > 0) out.HEALTH_DEAD_LETTER_QUEUES = deadLetters;
  for (const [code, value] of pieces(settings)) {
    const spec = settingSpecs.get(code);
    if (spec === undefined) throw new Error(`unknown setting code ${code}`);
    // A switch flag (BrokerSettingSpec.switchFlag) packed as "1"/"0" reads as the broker reads it.
    out[spec.variable] = spec.switchFlag === true && (value === "1" || value === "0") ? (value === "1" ? "enabled" : "disabled") : value;
  }
  const env = rest.AGENTX_ENV;
  if (typeof env === "string") for (const entry of DERIVED_BROKER_VARIABLES) out[entry.variable] = entry.kind === "text" ? entry.value(env) : entry.queueName(env);
  return out;
}

/** Takes the pieces with these codes out of a packed variable's Fn::Join (in place), for digest and snapshot tests that remove one feature's additions. */
export function removePackedPieces(variables: Record<string, unknown>, variable: string, codes: readonly string[]): void {
  const join = (variables[variable] as { "Fn::Join"?: [string, unknown[]] } | undefined)?.["Fn::Join"];
  if (join === undefined) throw new Error(`${variable} is not packed`);
  const parts = join[1];
  const kept: unknown[] = [];
  for (let index = 0; index < parts.length; index += 2) {
    const code = /^,?([a-z]{2})=$/u.exec(String(parts[index]))![1]!;
    if (!codes.includes(code)) kept.push(`${kept.length === 0 ? "" : ","}${code}=`, parts[index + 1]);
  }
  if (kept.length === 0) delete variables[variable];
  else join[1] = kept;
}

/**
 * ENV-ROOM 2, taken back out for digest and snapshot tests recorded before it. Strictly checks everything it changes in a named control plane, then puts the template back as it was:
 *  - the one SSM String parameter holding the names: removed, and its list put back in the function's Variables as AGENTX_NAMES, where AGENTX_NAMES_PARAMETER is (the revision
 *    dropped); the function's DependsOn on it removed;
 *  - the broker's IAM, made room for: the parameter's ARN (the last resource of its ssm:GetParameters statement) removed; dynamodb:GetRecords and dynamodb:GetShardIterator put back
 *    on the State statement; the merged lambda:InvokeFunction (plan evidence, sign-in) and states:StartExecution (session deleter, SWE-bench) statements split back into the four
 *    statements CDK wrote before, in their places.
 * Throws on anything else, so a change to any of these cannot hide behind this.
 */
export function withoutBrokerNamesParameter<T>(template: T): T {
  const resources = (template as unknown as ResourcesTemplate).Resources;
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
  const fail = (what: string): never => { throw new Error(`ENV-ROOM 2: ${what}`); };
  const brokers = Object.entries(resources).filter(([id, resource]) => resource.Type === "AWS::Lambda::Function" && /^Broker[0-9A-F]{8}$/u.test(id));
  if (brokers.length !== 1) fail("expected one broker function");
  const [brokerId, broker] = brokers[0]!;
  const environment = broker.Properties!.Environment as { Variables: Record<string, unknown> };
  const pointer = environment.Variables[BROKER_NAMES_PARAMETER_VARIABLE];
  const revision = environment.Variables[BROKER_NAMES_REVISION_VARIABLE];
  if (typeof pointer !== "string" || typeof revision !== "string" || BROKER_NAMES_VARIABLE in environment.Variables) fail("the broker does not point at its names parameter");
  const parameter = brokerNamesParameterOf(template as unknown as ResourcesTemplate, pointer as string);
  if (parameter.revision !== revision) fail("the broker's revision is not the parameter's");
  const parameterResource = resources[parameter.id]!;
  const { Tags: tags, ...parameterCore } = parameterResource.Properties!;
  delete parameterCore.Value;
  const expectedCore = { Description: "The broker's CloudFormation-generated resource names (AGENTX_NAMES); no secrets. Written by the control plane stack only.", Name: pointer, Tier: "Standard", Type: "String" };
  if (!same(Object.entries(parameterCore).sort(), Object.entries(expectedCore).sort())) fail("the parameter has properties this does not expect");
  if (tags !== undefined && !same(Object.keys(tags as object), ["agentx:env"])) fail("the parameter has tags this does not expect");
  if (Object.keys(parameterResource).some((key) => key !== "Type" && key !== "Properties")) fail("the parameter has attributes this does not expect");
  environment.Variables = Object.fromEntries(Object.entries(environment.Variables).flatMap(([key, value]) => key === BROKER_NAMES_PARAMETER_VARIABLE ? [[BROKER_NAMES_VARIABLE, parameter.names]] : key === BROKER_NAMES_REVISION_VARIABLE ? [] : [[key, value]]));
  const dependsOn = (broker.DependsOn ?? []).filter((id) => id !== parameter.id);
  if (dependsOn.length !== (broker.DependsOn ?? []).length - 1) fail("the broker does not depend on its names parameter");
  broker.DependsOn = dependsOn;
  if (Object.entries(resources).some(([id, resource]) => id !== brokerId && (resource.DependsOn ?? []).includes(parameter.id))) fail("something else depends on the parameter");
  delete resources[parameter.id];

  type Statement = { Action: unknown; Effect: string; Resource: unknown; Condition?: unknown; Sid?: string };
  const roleId = (broker.Properties!.Role as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"][0];
  // DEC 254zzz(2): BrokerCompanyImportReads is the broker's second role policy (the install company import's two sign-in table reads); it is not the default policy this edits.
  const policies = Object.entries(resources).filter(([id, resource]) => resource.Type === "AWS::IAM::Policy" && same(resource.Properties!.Roles, [{ Ref: roleId }]) && !/^DeveloperSignInBrokerCompanyImportReads[0-9A-F]{8}$/u.test(id)).map(([, resource]) => resource);
  if (policies.length !== 1) fail("expected the broker's one default policy");
  const document = policies[0]!.Properties!.PolicyDocument as { Statement: Statement[] };
  const statements = document.Statement;
  const one = (test: (statement: Statement) => boolean, what: string): Statement => {
    const found = statements.filter(test);
    if (found.length !== 1) fail(`expected one ${what} statement, found ${found.length}`);
    return found[0]!;
  };
  const arn = { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":ssm:", { Ref: "AWS::Region" }, ":", { Ref: "AWS::AccountId" }, `:parameter${pointer as string}`]] };
  const reads = one((statement) => statement.Action === "ssm:GetParameters", "ssm:GetParameters");
  const readResources = reads.Resource as unknown[];
  if (!same(readResources[readResources.length - 1], arn) || readResources.filter((resource) => same(resource, arn)).length !== 1 || reads.Condition !== undefined) fail("the parameter's ARN is not the GetParameters statement's last resource");
  reads.Resource = readResources.slice(0, -1);
  const state = one((statement) => Array.isArray(statement.Action) && statement.Action[0] === "dynamodb:BatchGetItem", "State");
  const stateActions = ["dynamodb:BatchGetItem", "dynamodb:Query", "dynamodb:GetItem", "dynamodb:Scan", "dynamodb:ConditionCheckItem", "dynamodb:BatchWriteItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:DescribeTable"];
  if (!same(state.Action, stateActions)) fail("the State statement's actions are not the ten it keeps");
  state.Action = [...stateActions, "dynamodb:GetRecords", "dynamodb:GetShardIterator"];
  const invoke = one((statement) => statement.Action === "lambda:InvokeFunction", "lambda:InvokeFunction");
  const invoked = invoke.Resource as unknown[];
  const fnArn = (prefix: string, index: number): boolean => { const id = (invoked[index] as { "Fn::GetAtt"?: [string, string] })["Fn::GetAtt"]?.[0] ?? ""; return id.startsWith(prefix) && same(invoked[index], { "Fn::GetAtt": [id, "Arn"] }) && same(invoked[index + 1], { "Fn::Join": ["", [{ "Fn::GetAtt": [id, "Arn"] }, ":*"]] }); };
  if (invoked.length !== 4 || !fnArn("PlanEvidence", 0) || !fnArn("DeveloperSignInFunction", 2) || Object.keys(invoke).length !== 3) fail("the merged invoke statement is not the two functions' grants");
  const start = one((statement) => statement.Action === "states:StartExecution", "states:StartExecution");
  const started = start.Resource as unknown[];
  if (!Array.isArray(started) || started.length !== 2 || !/^SessionsDeleter[0-9A-F]{8}$/u.test((started[0] as { Ref?: string }).Ref ?? "") || !JSON.stringify(started[1]).includes(":stateMachine:") || Object.keys(start).length !== 3) fail("the merged StartExecution statement is not the deleter's and SWE-bench's");
  const statement = (action: string, resource: unknown): Statement => ({ Action: action, Effect: "Allow", Resource: resource });
  const kept = statements.filter((candidate) => candidate !== invoke && candidate !== start);
  const at = (test: (candidate: Statement) => boolean): number => { const index = kept.findIndex(test); if (index < 0) fail("an anchor statement is missing"); return index; };
  kept.splice(at((candidate) => candidate === reads) + 1, 0, statement("states:StartExecution", started[1]), statement("lambda:InvokeFunction", invoked.slice(0, 2)));
  kept.splice(at((candidate) => Array.isArray(candidate.Action) && candidate.Action[0] === "secretsmanager:CreateSecret") + 1, 0, statement("lambda:InvokeFunction", invoked.slice(2)));
  kept.push(statement("states:StartExecution", started[0]));
  document.Statement = kept;
  return template;
}
