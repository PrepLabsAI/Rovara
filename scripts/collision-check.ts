/**
 * Physical-key collision check for an in-place CloudFormation update (switch-over incident, 2026-11-16).
 *
 * The staging switch-over to code/next 1d40766b2 failed on agentx-staging-control-plane with
 * 409 AlreadyExists: two NEW route logical IDs (CoreModelAccessRoute, DeveloperSignInCoreAppRoute6D4AEEF7)
 * reused the route keys of two live routes (ModelAccessRoute, DeveloperSignInAppRouteBAD38FAA) that the
 * same update removes. CloudFormation creates new resources first and deletes removed ones only in
 * cleanup, so any resource whose unique physical key (route key, fixed name, alias, export name...)
 * equals a removed resource's key fails to create (or, for policy-style resources that attach to one
 * parent, the later delete wipes the new one).
 *
 * This compares each stack's LIVE template with its NEW template and reports every ADDED logical ID
 * whose unique key equals a REMOVED logical ID's key (same stack: certain failure; another stack: fails
 * when the adding stack deploys first), or a KEPT resource's key (a duplicate of a live resource); and every KEPT
 * logical ID whose key changes to a key a removed resource still holds (the update also runs before cleanup).
 * A stack with only a live template (deleted) or only a new template (new) still takes part.
 *
 * Usage:
 *   node scripts/collision-check.ts --dir <preview dir>       (pairs <stack>.live-template.json with <stack>.template.json,
 *                                                              and <stack>.live-params.json / <stack>.params.json when present)
 *   node scripts/collision-check.ts --pair <stack> <live.json> <new.json> [--pair ...]
 *   add --json for a machine-readable report.
 * Exit 0 = no collision, 1 = at least one collision, 2 = usage or input error.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export type Template = { Resources?: Record<string, { Type: string; Properties?: Record<string, unknown> }>; Outputs?: Record<string, { Export?: { Name?: unknown } }>; Parameters?: Record<string, { Default?: unknown }> };
export type StackInput = { stack: string; live: Template; next: Template; liveParams?: Record<string, string>; nextParams?: Record<string, string> };
export type Collision = { kind: "removed-same-stack" | "removed-other-stack" | "kept-duplicate" | "kept-key-change"; key: string; added: { stack: string; id: string; type: string }; existing: { stack: string; id: string; type: string } };

type KeySpec = { required: string[]; optional?: Record<string, string>; each?: string };
/** Unique physical keys per type. `each` names an array property: one key per element. */
export const KEY_SPECS: Record<string, KeySpec[]> = {
  "AWS::ApiGatewayV2::Route": [{ required: ["ApiId", "RouteKey"] }],
  "AWS::ApiGatewayV2::Stage": [{ required: ["ApiId", "StageName"] }],
  "AWS::ApiGatewayV2::ApiMapping": [{ required: ["DomainName"], optional: { ApiMappingKey: "" } }],
  "AWS::ApiGatewayV2::DomainName": [{ required: ["DomainName"] }],
  "AWS::ApiGatewayV2::Authorizer": [{ required: ["ApiId", "Name"] }],
  "AWS::AppSync::ChannelNamespace": [{ required: ["ApiId", "Name"] }],
  "AWS::Athena::WorkGroup": [{ required: ["Name"] }],
  "AWS::Budgets::Budget": [{ required: ["Budget.BudgetName"] }],
  "AWS::CloudFront::Distribution": [{ required: [], each: "DistributionConfig.Aliases" }],
  "AWS::CloudFront::OriginAccessControl": [{ required: ["OriginAccessControlConfig.Name"] }],
  "AWS::CloudFront::ResponseHeadersPolicy": [{ required: ["ResponseHeadersPolicyConfig.Name"] }],
  "AWS::CloudWatch::Alarm": [{ required: ["AlarmName"] }],
  "AWS::CloudWatch::Dashboard": [{ required: ["DashboardName"] }],
  "AWS::Cognito::UserPoolDomain": [{ required: ["Domain"] }],
  "AWS::Cognito::UserPoolGroup": [{ required: ["UserPoolId", "GroupName"] }],
  "AWS::Cognito::UserPoolIdentityProvider": [{ required: ["UserPoolId", "ProviderName"] }],
  "AWS::Cognito::ManagedLoginBranding": [{ required: ["UserPoolId", "ClientId"] }],
  "AWS::DynamoDB::Table": [{ required: ["TableName"] }],
  "AWS::EC2::SecurityGroup": [{ required: ["GroupName"], optional: { VpcId: "" } }],
  "AWS::EC2::SecurityGroupIngress": [{ required: ["GroupId", "IpProtocol"], optional: { FromPort: "", ToPort: "", CidrIp: "", CidrIpv6: "", SourceSecurityGroupId: "", SourcePrefixListId: "" } }],
  "AWS::EC2::SecurityGroupEgress": [{ required: ["GroupId", "IpProtocol"], optional: { FromPort: "", ToPort: "", CidrIp: "", CidrIpv6: "", DestinationSecurityGroupId: "", DestinationPrefixListId: "" } }],
  "AWS::EC2::LaunchTemplate": [{ required: ["LaunchTemplateName"] }],
  "AWS::EC2::VPCEndpoint": [{ required: ["VpcId", "ServiceName"] }],
  "AWS::EC2::Route": [{ required: ["RouteTableId"], optional: { DestinationCidrBlock: "", DestinationIpv6CidrBlock: "", DestinationPrefixListId: "" } }],
  "AWS::EC2::VPCGatewayAttachment": [{ required: ["VpcId"] }],
  "AWS::EC2::SubnetRouteTableAssociation": [{ required: ["SubnetId"] }],
  "AWS::ECR::Repository": [{ required: ["RepositoryName"] }],
  "AWS::ECR::PullThroughCacheRule": [{ required: ["EcrRepositoryPrefix"] }],
  "AWS::ECR::RepositoryCreationTemplate": [{ required: ["Prefix"] }],
  "AWS::ECS::Cluster": [{ required: ["ClusterName"] }],
  "AWS::ECS::Service": [{ required: ["ServiceName"], optional: { Cluster: "default" } }],
  "AWS::ElasticLoadBalancingV2::LoadBalancer": [{ required: ["Name"] }],
  "AWS::ElasticLoadBalancingV2::TargetGroup": [{ required: ["Name"] }],
  "AWS::ElasticLoadBalancingV2::Listener": [{ required: ["LoadBalancerArn", "Port"] }],
  "AWS::ElasticLoadBalancingV2::ListenerRule": [{ required: ["ListenerArn", "Priority"] }],
  "AWS::Events::Rule": [{ required: ["Name"], optional: { EventBusName: "default" } }],
  "AWS::IAM::InstanceProfile": [{ required: ["InstanceProfileName"] }],
  "AWS::IAM::ManagedPolicy": [{ required: ["ManagedPolicyName"] }],
  "AWS::IAM::Role": [{ required: ["RoleName"] }],
  "AWS::IAM::Policy": [{ required: ["PolicyName"], each: "Roles" }, { required: ["PolicyName"], each: "Users" }, { required: ["PolicyName"], each: "Groups" }],
  "AWS::KMS::Alias": [{ required: ["AliasName"] }],
  "AWS::Lambda::Function": [{ required: ["FunctionName"] }],
  "AWS::Lambda::EventSourceMapping": [{ required: ["FunctionName", "EventSourceArn"] }],
  "AWS::Lambda::EventInvokeConfig": [{ required: ["FunctionName", "Qualifier"] }],
  "AWS::Lambda::Url": [{ required: ["TargetFunctionArn"], optional: { Qualifier: "" } }],
  "AWS::Logs::LogGroup": [{ required: ["LogGroupName"] }],
  "AWS::Logs::MetricFilter": [{ required: ["LogGroupName", "FilterName"] }],
  "AWS::Logs::SubscriptionFilter": [{ required: ["LogGroupName", "FilterName"] }],
  "AWS::Logs::DeliverySource": [{ required: ["Name"] }],
  "AWS::Logs::DeliveryDestination": [{ required: ["Name"] }],
  "AWS::Logs::Delivery": [{ required: ["DeliverySourceName", "DeliveryDestinationArn"] }],
  "AWS::RDS::DBCluster": [{ required: ["DBClusterIdentifier"] }],
  "AWS::RDS::DBInstance": [{ required: ["DBInstanceIdentifier"] }],
  "AWS::RDS::DBSubnetGroup": [{ required: ["DBSubnetGroupName"] }],
  "AWS::Route53::RecordSet": [{ required: ["Name", "Type"], optional: { HostedZoneId: "", HostedZoneName: "", SetIdentifier: "" } }],
  "AWS::Route53Resolver::FirewallRuleGroupAssociation": [{ required: ["VpcId", "FirewallRuleGroupId"] }, { required: ["VpcId", "Priority"] }],
  "AWS::Route53Resolver::ResolverQueryLoggingConfigAssociation": [{ required: ["ResourceId"] }],
  "AWS::S3::Bucket": [{ required: ["BucketName"] }],
  // One policy per parent: creating the new one overwrites, and deleting the old one afterwards wipes it.
  "AWS::S3::BucketPolicy": [{ required: ["Bucket"] }],
  "AWS::SQS::QueuePolicy": [{ required: [], each: "Queues" }],
  "AWS::SNS::TopicPolicy": [{ required: [], each: "Topics" }],
  "AWS::S3Tables::TableBucket": [{ required: ["TableBucketName"] }],
  "AWS::S3Tables::Namespace": [{ required: ["TableBucketARN", "Namespace"] }],
  "AWS::S3Tables::Table": [{ required: ["TableBucketARN", "Namespace", "TableName"] }],
  "AWS::S3Vectors::VectorBucket": [{ required: ["VectorBucketName"] }],
  "AWS::SNS::Topic": [{ required: ["TopicName"] }],
  "AWS::SQS::Queue": [{ required: ["QueueName"] }],
  "AWS::SSM::Parameter": [{ required: ["Name"] }],
  "AWS::Scheduler::Schedule": [{ required: ["Name"], optional: { GroupName: "default" } }],
  "AWS::Scheduler::ScheduleGroup": [{ required: ["Name"] }],
  "AWS::SecretsManager::Secret": [{ required: ["Name"] }],
  "AWS::StepFunctions::StateMachine": [{ required: ["StateMachineName"] }],
};
const EXPORT_TYPE = "AWS::CloudFormation::Export";

function at(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path.split(".")) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

type Ctx = { stack: string; params: Record<string, string>; declared: Set<string> };
const PSEUDO = new Set(["AWS::Region", "AWS::AccountId", "AWS::Partition", "AWS::URLSuffix"]);

function token(name: string, ctx: Ctx): string {
  if (name === "AWS::StackName") return ctx.stack;
  if (PSEUDO.has(name)) return `<${name}>`;
  const dot = name.indexOf(".");
  if (dot > 0) return `<getatt:${ctx.stack}/${name}>`;
  if (Object.hasOwn(ctx.params, name)) return ctx.params[name]!;
  // A declared parameter with no known value stays a token; any other name is a resource (even one this template omits).
  if (ctx.declared.has(name)) return `<param:${name}>`;
  return `<ref:${ctx.stack}/${name}>`;
}

/** Resolves the intrinsics a physical name is built from to one comparable string. */
export function resolve(value: unknown, ctx: Ctx): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return JSON.stringify(value.map((item) => resolve(item, ctx)));
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 1) {
      const [fn, arg] = entries[0]!;
      if (fn === "Ref" && typeof arg === "string") return token(arg, ctx);
      if (fn === "Fn::GetAtt") {
        const parts = Array.isArray(arg) ? arg.map(String) : String(arg).split(".");
        return `<getatt:${ctx.stack}/${parts.join(".")}>`;
      }
      if (fn === "Fn::Sub") {
        const [text, vars] = Array.isArray(arg) ? [String(arg[0]), (arg[1] ?? {}) as Record<string, unknown>] : [String(arg), {}];
        return text.replace(/\$\{([^}!][^}]*)\}/gu, (_m, name: string) => (Object.hasOwn(vars, name) ? resolve(vars[name], ctx) : token(name, ctx)));
      }
      if (fn === "Fn::Join" && Array.isArray(arg) && Array.isArray(arg[1])) return (arg[1] as unknown[]).map((item) => resolve(item, ctx)).join(String(arg[0]));
      if (fn === "Fn::ImportValue") return `<import:${resolve(arg, ctx)}>`;
      if (fn === "Fn::Select" && Array.isArray(arg)) {
        const list: unknown = (arg as unknown[])[1];
        if (Array.isArray(list)) return resolve(list[Number(resolve(arg[0], ctx))], ctx);
        if (list !== null && typeof list === "object" && "Fn::Split" in list) {
          const split = (list as { "Fn::Split": unknown[] })["Fn::Split"];
          return resolve(split[1], ctx).split(String(split[0]))[Number(resolve(arg[0], ctx))] ?? "";
        }
      }
      return JSON.stringify({ [fn]: resolve(arg, ctx) });
    }
    return JSON.stringify(Object.fromEntries(entries.map(([k, v]) => [k, resolve(v, ctx)])));
  }
  return "";
}

/** Every unique physical key of one resource (empty when its name is generated or the type has none). */
export function resourceKeys(type: string, properties: Record<string, unknown>, ctx: Ctx): string[] {
  const keys: string[] = [];
  for (const spec of KEY_SPECS[type] ?? []) {
    const required = spec.required.map((path) => at(properties, path));
    if (required.some((value) => value === undefined)) continue;
    const parts = [...spec.required.map((path, i) => `${path}=${resolve(required[i], ctx)}`), ...Object.entries(spec.optional ?? {}).map(([path, fallback]) => {
      const value = at(properties, path);
      return `${path}=${value === undefined ? fallback : resolve(value, ctx)}`;
    })];
    if (spec.each === undefined) { keys.push(`${type}|${parts.join("|")}`); continue; }
    const list = at(properties, spec.each);
    if (!Array.isArray(list)) continue;
    for (const item of list) keys.push(`${type}|${[...parts, `${spec.each}=${resolve(item, ctx)}`].join("|")}`);
  }
  return keys;
}

type Entry = { stack: string; id: string; type: string; keys: string[] };
function index(stack: string, template: Template, params: Record<string, string>): Map<string, Entry> {
  const resources = template.Resources ?? {};
  const defaults = Object.fromEntries(Object.entries(template.Parameters ?? {}).filter(([, p]) => typeof p.Default === "string" || typeof p.Default === "number").map(([k, p]) => [k, String(p.Default)]));
  const ctx: Ctx = { stack, params: { ...defaults, ...params }, declared: new Set(Object.keys(template.Parameters ?? {})) };
  const out = new Map<string, Entry>();
  for (const [id, resource] of Object.entries(resources)) out.set(id, { stack, id, type: resource.Type, keys: resourceKeys(resource.Type, resource.Properties ?? {}, ctx) });
  for (const [id, output] of Object.entries(template.Outputs ?? {})) {
    if (output.Export?.Name === undefined) continue;
    out.set(`Outputs.${id}`, { stack, id: `Outputs.${id}`, type: EXPORT_TYPE, keys: [`${EXPORT_TYPE}|Name=${resolve(output.Export.Name, ctx)}`] });
  }
  return out;
}

export function findCollisions(inputs: StackInput[]): { collisions: Collision[]; unclassifiedTypes: string[] } {
  const removed: Entry[] = [];
  const kept: Entry[] = [];
  const added: Entry[] = [];
  const rekeyed: Entry[] = [];
  const unclassified = new Set<string>();
  for (const input of inputs) {
    const live = index(input.stack, input.live, input.liveParams ?? {});
    const next = index(input.stack, input.next, { ...(input.liveParams ?? {}), ...(input.nextParams ?? {}) });
    for (const [id, entry] of live) {
      const successor = next.get(id);
      if (successor === undefined || successor.type !== entry.type) removed.push(entry);
      else kept.push(entry);
    }
    for (const [id, entry] of next) {
      if (!(KEY_SPECS[entry.type] !== undefined || entry.type === EXPORT_TYPE)) unclassified.add(entry.type);
      const predecessor = live.get(id);
      if (predecessor === undefined || predecessor.type !== entry.type) added.push(entry);
      else {
        const fresh = entry.keys.filter((key) => !predecessor.keys.includes(key));
        if (fresh.length > 0) rekeyed.push({ ...entry, keys: fresh });
      }
    }
  }
  const collisions: Collision[] = [];
  const byKey = (entries: Entry[]) => {
    const map = new Map<string, Entry[]>();
    for (const entry of entries) for (const key of entry.keys) map.set(key, [...(map.get(key) ?? []), entry]);
    return map;
  };
  const removedByKey = byKey(removed);
  const keptByKey = byKey(kept);
  for (const entry of added) {
    for (const key of entry.keys) {
      for (const old of removedByKey.get(key) ?? []) collisions.push({ kind: old.stack === entry.stack ? "removed-same-stack" : "removed-other-stack", key, added: { stack: entry.stack, id: entry.id, type: entry.type }, existing: { stack: old.stack, id: old.id, type: old.type } });
      for (const old of keptByKey.get(key) ?? []) collisions.push({ kind: "kept-duplicate", key, added: { stack: entry.stack, id: entry.id, type: entry.type }, existing: { stack: old.stack, id: old.id, type: old.type } });
    }
  }
  for (const entry of rekeyed) {
    for (const key of entry.keys) {
      for (const old of removedByKey.get(key) ?? []) collisions.push({ kind: "kept-key-change", key, added: { stack: entry.stack, id: entry.id, type: entry.type }, existing: { stack: old.stack, id: old.id, type: old.type } });
    }
  }
  return { collisions, unclassifiedTypes: [...unclassified].sort() };
}

function readParams(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const list = JSON.parse(readFileSync(path, "utf8")) as Array<{ ParameterKey: string; ParameterValue?: string; UsePreviousValue?: boolean }>;
  return Object.fromEntries(list.filter((p) => p.UsePreviousValue !== true && p.ParameterValue !== undefined).map((p) => [p.ParameterKey, p.ParameterValue!]));
}

export function inputsFromDir(dir: string): StackInput[] {
  const names = readdirSync(dir);
  const stacks = new Set<string>();
  for (const name of names) {
    if (name.endsWith(".live-template.json")) stacks.add(name.slice(0, -".live-template.json".length));
    else if (name.endsWith(".template.json")) stacks.add(name.slice(0, -".template.json".length));
  }
  // A stack missing one side is new (no live template) or deleted (no new template): it still takes part, with an empty other side.
  const read = (path: string): Template => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as Template : { Resources: {} });
  return [...stacks].sort().map((stack) => ({
    stack,
    live: read(join(dir, `${stack}.live-template.json`)),
    next: read(join(dir, `${stack}.template.json`)),
    liveParams: readParams(join(dir, `${stack}.live-params.json`)),
    nextParams: readParams(join(dir, `${stack}.params.json`)),
  }));
}

export function main(argv: string[]): number {
  try {
    return run(argv);
  } catch {
    process.stderr.write("collision-check: an input file could not be read or parsed\n");
    return 2;
  }
}

function run(argv: string[]): number {
  const inputs: StackInput[] = [];
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") json = true;
    else if (arg === "--dir" && argv[i + 1] !== undefined) inputs.push(...inputsFromDir(argv[++i]!));
    else if (arg === "--pair" && argv[i + 3] !== undefined) {
      const [stack, live, next] = [argv[i + 1]!, argv[i + 2]!, argv[i + 3]!];
      inputs.push({ stack, live: JSON.parse(readFileSync(live, "utf8")) as Template, next: JSON.parse(readFileSync(next, "utf8")) as Template });
      i += 3;
    } else {
      process.stderr.write("usage: collision-check.ts (--dir <preview dir> | --pair <stack> <live.json> <new.json>)... [--json]\n");
      return 2;
    }
  }
  if (inputs.length === 0) { process.stderr.write("collision-check: no live/new template pairs found\n"); return 2; }
  const { collisions, unclassifiedTypes } = findCollisions(inputs);
  if (json) process.stdout.write(`${JSON.stringify({ stacks: inputs.map((i) => i.stack), collisions, unclassifiedTypes }, null, 2)}\n`);
  else {
    process.stdout.write(`collision-check: ${inputs.length} stack(s): ${inputs.map((i) => i.stack).join(", ")}\n`);
    for (const c of collisions) process.stdout.write(`COLLISION ${c.kind}: ${c.added.stack}/${c.added.id} (${c.added.type}) reuses ${c.existing.stack}/${c.existing.id}: ${c.key}\n`);
    if (unclassifiedTypes.length > 0) process.stdout.write(`note: types with no key rule (not checked): ${unclassifiedTypes.join(", ")}\n`);
    process.stdout.write(collisions.length === 0 ? "collision-check: CLEAN\n" : `collision-check: ${collisions.length} collision(s)\n`);
  }
  return collisions.length === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = main(process.argv.slice(2));
