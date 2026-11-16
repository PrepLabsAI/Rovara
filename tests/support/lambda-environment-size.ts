/**
 * How big a synthesized Lambda function's environment is once CloudFormation has filled it in. Lambda refuses a function whose
 * variables, keys and values together come to more than 4,096 bytes, and only the deploy says so. Two measures are kept: the compact JSON of the map (the stricter one, which
 * Cloud's staging deploys were held to) and the keys plus the values alone. Every intrinsic is resolved with the worst length CloudFormation can give it:
 *  - a name CloudFormation generates is `<stack name>-<logical id>-<13 random characters>`, cut at the resource type's limit (64 for a function or a role, 80 for a queue or a
 *    state machine, 63 for a bucket, 255 for a table);
 *  - a queue's Ref is its URL, a role's ARN carries the environment's role path, a key's id is a UUID;
 *  - a parameter is given what `parameterValues` says, else its longest allowed value, else its default, else `PARAMETER_FALLBACK`;
 *  - Fn::If takes the longer branch.
 * An intrinsic this does not know throws: a measure that guessed would be no measure.
 */

import { POLICY_HOOK_PARAMETER_MAX_LENGTH } from "@agentx/contracts";

type Json = Record<string, unknown>;
interface Resource { Type: string; Properties?: Json }
export interface Template { Resources: Record<string, Resource>; Parameters?: Record<string, { Default?: unknown; Type?: string; AllowedValues?: string[] }> }

export const LAMBDA_ENVIRONMENT_LIMIT_BYTES = 4096;
/** The longest region name there is (14 characters). */
export const RESOLVER_REGION = "ap-southeast-4";
export const RESOLVER_ACCOUNT = "123456789012";
const PARAMETER_FALLBACK = "p".repeat(64);

/**
 * The policy hook at its worst: the parameter's longest value, every character one that compact JSON must escape (the parameter allows any printable ASCII, so `"` and `\` pass
 * the deploy; the broker refuses bad settings later, at run time). Each costs two bytes in the stricter measure and one in keys plus values, so no real hook measures larger.
 */
function policyHookWorstCase(): string {
  return '"'.repeat(POLICY_HOOK_PARAMETER_MAX_LENGTH);
}

/** What a deploy gives the parameters, at a realistic worst length: a fully configured install (OIDC, Slack, two subnets, the core switch on for two companies). */
export const DEPLOY_PARAMETER_VALUES: Record<string, string> = {
  OidcIssuer: `https://cognito-idp.${RESOLVER_REGION}.amazonaws.com/${RESOLVER_REGION}_AbCdEfGhI`,
  OidcAudience: "1234567890abcdefghijklmnop",
  CallbackSigningKey: "k".repeat(64),
  GitHubAppId: "12345678",
  GitHubAppPrivateKeySecretArn: `arn:aws:secretsmanager:${RESOLVER_REGION}:${RESOLVER_ACCOUNT}:secret:agentx/a1234567890123456789/github-app-AbCdEf`,
  Ec2WorkerSubnets: [`${RESOLVER_REGION}a=subnet-0123456789abcdef0`, `${RESOLVER_REGION}b=subnet-0123456789abcdef1`].join(","),
  Ec2WorkerLaunchTemplateId: "lt-0123456789abcdef0",
  // A Slack team id is [TE][A-Z0-9]{2,31} (the parameter's AllowedPattern): 32 characters at most.
  SlackTeamId: `T${"0123456789ABCDEFGHIJKLMNOPQRSTUV".slice(0, 31)}`,
  DeveloperOidcIssuer: "https://login.example-company.okta.com/oauth2/default",
  DeveloperOidcClientId: "0oa1b2c3d4e5f6g7h8i9",
  // Epoch-seconds parameters allow 12 digits; the workspace limits are small counts (six digits is generous).
  DeveloperSignInSlackSince: "999999999999",
  DeveloperOidcSince: "999999999999",
  SlackMemberWorkspaceLimit: "999999",
  SlackOrganizationWorkspaceLimit: "999999",
  // Free-text parameters with no length limit, at a realistic worst (their defaults are "cognito:groups", '["agentx-admin"]' and "github-agentx-sdlc").
  AdminClaim: "https://identity.example-company.com/claims/groups",
  AdminValues: '["agentx-admin","platform-engineering-admins","security-operations"]',
  GitHubAppCredentialRef: "github-app-example-company-engineering",
  // The core switch's longest value (CORE_ENGINE_PARAMETER_PATTERN: two companies).
  CoreEngine: `on:org_${"a".repeat(20)}:org_${"b".repeat(20)}`,
  // The parameter's longest value (two company ids), though DEC 229a uses one until #737/#743 are proven.
  CoreAllowedCompanies: `org_${"a".repeat(20)}:org_${"b".repeat(20)}`,
  CoreTaskCapUsd: "1000",
  CoreCompanyDayCapUsd: "1000",
  CorePolicyHook: policyHookWorstCase(),
  CoreLessons: `on:org_${"a".repeat(20)}:org_${"b".repeat(20)}`,
};
const RANDOM = "A1B2C3D4E5F6G";
const UUID = "12345678-1234-1234-1234-123456789012";

/** The explicit-name property of a resource type, where a fixed name replaces the generated one. */
const NAME_PROPERTY: Record<string, string> = {
  "AWS::Lambda::Function": "FunctionName",
  "AWS::SQS::Queue": "QueueName",
  "AWS::DynamoDB::Table": "TableName",
  "AWS::S3::Bucket": "BucketName",
  "AWS::IAM::Role": "RoleName",
  "AWS::SNS::Topic": "TopicName",
  "AWS::StepFunctions::StateMachine": "StateMachineName",
};
const NAME_LIMIT: Record<string, number> = {
  "AWS::Lambda::Function": 64,
  "AWS::SQS::Queue": 80,
  "AWS::DynamoDB::Table": 255,
  "AWS::S3::Bucket": 63,
  "AWS::IAM::Role": 64,
  "AWS::SNS::Topic": 256,
  "AWS::StepFunctions::StateMachine": 80,
};

export interface SizeOptions {
  /** The environment name, which sits in the stack name and in every role path. */
  env: string;
  stackName: string;
  parameterValues?: Record<string, string>;
}

export class Resolver {
  constructor(private readonly template: Template, private readonly options: SizeOptions) {}

  private nameOf(logicalId: string): string {
    const resource = this.template.Resources[logicalId];
    if (resource === undefined) throw new Error(`no resource ${logicalId}`);
    const property = NAME_PROPERTY[resource.Type];
    const fixed = property === undefined ? undefined : resource.Properties?.[property];
    if (fixed !== undefined) return this.text(fixed);
    return `${this.options.stackName}-${logicalId}-${RANDOM}`.slice(0, NAME_LIMIT[resource.Type] ?? 255);
  }

  ref(key: string): string {
    switch (key) {
      case "AWS::Region": return RESOLVER_REGION;
      case "AWS::AccountId": return RESOLVER_ACCOUNT;
      case "AWS::Partition": return "aws";
      case "AWS::URLSuffix": return "amazonaws.com";
      case "AWS::StackName": return this.options.stackName;
      default: break;
    }
    const parameter = this.template.Parameters?.[key];
    if (parameter !== undefined) {
      const given = this.options.parameterValues?.[key];
      if (given !== undefined) return given;
      if (parameter.AllowedValues !== undefined && parameter.AllowedValues.length > 0) return [...parameter.AllowedValues].sort((a, b) => b.length - a.length)[0]!;
      return parameter.Default === undefined ? PARAMETER_FALLBACK : typeof parameter.Default === "string" ? parameter.Default : JSON.stringify(parameter.Default);
    }
    const resource = this.template.Resources[key];
    if (resource === undefined) throw new Error(`Ref to ${key}, which is neither a parameter nor a resource`);
    switch (resource.Type) {
      case "AWS::SQS::Queue": return `https://sqs.${RESOLVER_REGION}.amazonaws.com/${RESOLVER_ACCOUNT}/${this.nameOf(key)}`;
      case "AWS::KMS::Key": return UUID;
      case "AWS::SNS::Topic": return `arn:aws:sns:${RESOLVER_REGION}:${RESOLVER_ACCOUNT}:${this.nameOf(key)}`;
      case "AWS::StepFunctions::StateMachine": return `arn:aws:states:${RESOLVER_REGION}:${RESOLVER_ACCOUNT}:stateMachine:${this.nameOf(key)}`;
      case "AWS::ApiGatewayV2::Api": return "abcdefghij";
      default: return this.nameOf(key);
    }
  }

  getAtt(logicalId: string, attribute: string): string {
    const resource = this.template.Resources[logicalId];
    if (resource === undefined) throw new Error(`GetAtt on ${logicalId}, which is not a resource`);
    const name = (): string => this.nameOf(logicalId);
    switch (`${resource.Type}.${attribute}`) {
      case "AWS::IAM::Role.Arn": return `arn:aws:iam::${RESOLVER_ACCOUNT}:role/agentx/${this.options.env}/${name()}`;
      case "AWS::Lambda::Function.Arn": return `arn:aws:lambda:${RESOLVER_REGION}:${RESOLVER_ACCOUNT}:function:${name()}`;
      case "AWS::SQS::Queue.Arn": return `arn:aws:sqs:${RESOLVER_REGION}:${RESOLVER_ACCOUNT}:${name()}`;
      case "AWS::SQS::Queue.QueueName": return name();
      case "AWS::SQS::Queue.QueueUrl": return this.ref(logicalId);
      case "AWS::StepFunctions::StateMachine.Name": return name();
      case "AWS::DynamoDB::Table.Arn": return `arn:aws:dynamodb:${RESOLVER_REGION}:${RESOLVER_ACCOUNT}:table/${name()}`;
      case "AWS::S3::Bucket.Arn": return `arn:aws:s3:::${name()}`;
      case "AWS::KMS::Key.Arn": return `arn:aws:kms:${RESOLVER_REGION}:${RESOLVER_ACCOUNT}:key/${UUID}`;
      case "AWS::ApiGatewayV2::Api.ApiEndpoint": return `https://abcdefghij.execute-api.${RESOLVER_REGION}.amazonaws.com`;
      default: throw new Error(`GetAtt ${resource.Type}.${attribute} is not resolved by this measure`);
    }
  }

  /** A resolved value as text: what a variable's value is once CloudFormation has put its parts together. */
  text(value: unknown): string {
    const resolved = this.resolve(value);
    return typeof resolved === "string" ? resolved : JSON.stringify(resolved);
  }

  resolve(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((entry) => this.resolve(entry));
    if (value === null || typeof value !== "object") return value;
    const entries = Object.entries(value as Json);
    if (entries.length === 1 && (entries[0]![0] === "Ref" || entries[0]![0].startsWith("Fn::"))) {
      const [name, argument] = entries[0]!;
      switch (name) {
        case "Ref": return this.ref(String(argument));
        case "Fn::GetAtt": {
          const [id, attribute] = Array.isArray(argument) ? (argument as [string, string]) : String(argument).split(".", 2) as [string, string];
          return this.getAtt(id, attribute);
        }
        case "Fn::Join": {
          const [delimiter, list] = argument as [string, unknown[]];
          return (this.resolve(list) as unknown[]).map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry))).join(delimiter);
        }
        case "Fn::Select": {
          const [index, list] = argument as [unknown, unknown[]];
          return (this.resolve(list) as unknown[])[Number(this.resolve(index))];
        }
        case "Fn::Split": {
          const [delimiter, text] = argument as [string, unknown];
          return this.text(text).split(delimiter);
        }
        case "Fn::If": {
          const [, yes, no] = argument as [string, unknown, unknown];
          const left = this.resolve(yes);
          const right = this.resolve(no);
          return JSON.stringify(left).length >= JSON.stringify(right).length ? left : right;
        }
        case "Fn::ToJsonString": return JSON.stringify(this.resolve(argument));
        default: throw new Error(`${name} is not resolved by this measure`);
      }
    }
    return Object.fromEntries(entries.map(([key, entry]) => [key, this.resolve(entry)]));
  }
}

export interface LambdaEnvironment { logicalId: string; variables: Record<string, string>; bytes: number; keyValueBytes: number }

/** The compact JSON of a variable map, in bytes. */
export const environmentBytes = (variables: Record<string, string>): number => Buffer.byteLength(JSON.stringify(variables), "utf8");
/** The keys and the values alone, in bytes. */
export const keyValueBytes = (variables: Record<string, string>): number => Object.entries(variables).reduce((total, [key, value]) => total + Buffer.byteLength(key) + Buffer.byteLength(value), 0);

/** The Lambda functions of a template whose logical ids match, resolved at worst-case lengths. */
export function lambdaEnvironments(template: Template, options: SizeOptions, only: RegExp): LambdaEnvironment[] {
  const resolver = new Resolver(template, options);
  const found: LambdaEnvironment[] = [];
  for (const [logicalId, resource] of Object.entries(template.Resources)) {
    if (resource.Type !== "AWS::Lambda::Function" || !only.test(logicalId)) continue;
    const raw = (resource.Properties?.Environment as { Variables?: Json } | undefined)?.Variables ?? {};
    const variables = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, resolver.text(value)]));
    found.push({ logicalId, variables, bytes: environmentBytes(variables), keyValueBytes: keyValueBytes(variables) });
  }
  return found;
}

/**
 * A named environment's synthesized control plane (the test synthesizes it: `Template.fromStack(stack).toJSON()` and `stack.stackName`): the resolver over it, and the broker's and
 * dispatcher's environments.
 */
export function controlPlaneOf(env: string, synthesized: { template: unknown; stackName: string }): { template: Template; resolver: Resolver; functions: LambdaEnvironment[] } {
  const template = synthesized.template as Template;
  const options = { env, stackName: synthesized.stackName, parameterValues: DEPLOY_PARAMETER_VALUES };
  return { template, resolver: new Resolver(template, options), functions: lambdaEnvironments(template, options, /^(Broker|Dispatcher)[0-9A-F]{8}$/u) };
}
