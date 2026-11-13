// IaC resources detector (test services D7; design test-services.md 3.2). Reads infrastructure code (CloudFormation and SAM templates, including a committed `cdk.out`; Terraform `*.tf`; AWS CDK source in TypeScript,
// JavaScript and Python) for the AWS resources the project declares: DynamoDB tables WITH their key schema, S3 buckets, SQS queues, SNS topics (with the declared queues that subscribe), Secrets Manager secrets (the name
// only: a value is never read), SSM parameters (a String's literal default only), KMS keys (with their alias) and EventBridge buses and rules. Rovara local AWS creates them when it starts (5.4), so tests that expect them
// find them. A resource of any other AWS service the table knows (a Kinesis stream, a state machine, a user pool) is not created: its SERVICE is a candidate and the emulator starts empty for it. The services come from the
// emulator's table (CloudFormation `AWS::<name>::`, Terraform `aws_<prefix>_`, CDK module names), with a small override list for the prefixes Terraform and CDK spell differently; a Terraform type no service owns is a
// `mentioned` candidate, never dropped. The existing `iac.ts` only says which kind of IaC the repository uses; this file reads what is in it.
// Reads only: a template is data, never deployed, and no Terraform or CDK command is run. YAML is read under `safe-yaml.ts`'s limits. A name is kept only when it is written as a plain identifier (letters, digits,
// `.`, `_`, `-`); anything built from a function or a variable falls back to the template's own id for the resource. The key schema is attribute NAMES and the types S, N or B.
import { awsServiceKeyFromCfnType, looksLikeSecretValue, normaliseAwsServiceKey } from "@rovara-code/contracts";
import { callArguments, candidate, DEPENDENCY_SKIP_DIRS, isTableAwsService, mergeCandidates, MAX_RESOURCES, normalizeAwsService } from "./dependency-candidates.js";
import { ownEntries, ownGet, pairOf, parseSafeYaml, YAML_REFUSAL_WORDS } from "./safe-yaml.js";
import { lineOf, type DependencyCandidate, type DependencyKeyAttribute, type DependencyResource, type Detector, type RepositoryReader } from "./types.js";
import { isMap, isScalar } from "yaml";
import type { Pair } from "yaml";

export const IAC_RESOURCES_MAX_FILES = 80;
const FAMILY_OF_KIND: Record<DependencyResource["kind"], string> = {
  table: "aws:dynamodb", bucket: "aws:s3", queue: "aws:sqs", topic: "aws:sns", secret: "aws:secrets-manager", parameter: "aws:ssm", key: "aws:kms", bus: "aws:eventbridge", rule: "aws:eventbridge",
};
const PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/u;
/** A name written as a plain identifier and not shaped like a key (a table or bucket name is carried by design, so it must never be a secret by accident). */
const plainName = (value: unknown): string | undefined => (typeof value === "string" && PLAIN_NAME.test(value) && !looksLikeSecretValue(value) ? value : undefined);
/** Secret and parameter names keep their `/` path; a name is carried by design, so it must never be a secret by accident. */
const SECRET_NAME = /^[A-Za-z0-9][A-Za-z0-9/_+=.@-]{0,255}$/u;
const PARAMETER_NAME = /^\/?[A-Za-z0-9_./-]{1,200}$/u;
const KEY_ALIAS = /^alias\/[A-Za-z0-9/_-]{1,250}$/u;
const notSecretText = (value: string): boolean => !looksLikeSecretValue(value) && !looksLikeSecretValue(value.toUpperCase());
const matching = (pattern: RegExp, value: unknown): string | undefined => (typeof value === "string" && pattern.test(value) && notSecretText(value) ? value : undefined);
/** A literal parameter default: one plain printable line, no template syntax (`${...}`), not shaped like a key. Anything built from a function, a reference or a variable is not a literal. */
const literalValue = (value: unknown): string | undefined => (typeof value === "string" && value.length <= 200 && /^[\x20-\x7e]*$/u.test(value) && !/\$\{|\{\{|^!/u.test(value) && notSecretText(value) ? value : undefined);
/** Only a plain `String` parameter is seeded (a type that is not written is `String`, as in CloudFormation and Terraform's default); a SecureString or a StringList is left to the tests. */
const isStringParameter = (value: unknown): boolean => value === undefined || value === "String";
const attributeType = (value: unknown): "S" | "N" | "B" | undefined => {
  const text = typeof value === "string" ? value.toUpperCase() : "";
  return text === "S" || text === "STRING" ? "S" : text === "N" || text === "NUMBER" ? "N" : text === "B" || text === "BINARY" ? "B" : undefined;
};
const attribute = (name: unknown, type: unknown): DependencyKeyAttribute | undefined => {
  const checked = plainName(name);
  // A key attribute whose type is not written is a string key: DynamoDB keys are S, N or B, and S is by far the common one. The type is only filled in when the template says it.
  return checked === undefined ? undefined : { name: checked, type: attributeType(type) ?? "S" };
};

function emit(out: DependencyCandidate[], path: string, line: number, resource: DependencyResource): void {
  out.push(candidate(FAMILY_OF_KIND[resource.kind], "declared", { path, line }, { resources: [resource], seenBy: ["iac"] }));
}

// ---- CloudFormation and SAM

const CFN_KINDS: Record<string, DependencyResource["kind"]> = {
  "AWS::DynamoDB::Table": "table", "AWS::DynamoDB::GlobalTable": "table", "AWS::Serverless::SimpleTable": "table", "AWS::S3::Bucket": "bucket", "AWS::SQS::Queue": "queue", "AWS::SNS::Topic": "topic",
  "AWS::SecretsManager::Secret": "secret", "AWS::SSM::Parameter": "parameter", "AWS::KMS::Key": "key", "AWS::Events::EventBus": "bus", "AWS::Events::Rule": "rule",
};
const CFN_NAME_PROPERTY: Record<DependencyResource["kind"], string> = { table: "TableName", bucket: "BucketName", queue: "QueueName", topic: "TopicName", secret: "Name", parameter: "Name", key: "KeyAlias", bus: "Name", rule: "Name" };

/** The logical id a `!Ref X`, `!GetAtt X.Arn`, `{ Ref: X }` or `{ "Fn::GetAtt": [X, "Arn"] }` points at (YAML reads a short-form tag as its text). Undefined for anything else. */
function refTarget(value: unknown): string | undefined {
  if (typeof value === "string") return /^[A-Za-z0-9]{1,255}(?:\.[A-Za-z0-9.]{1,60})?$/u.test(value) ? value.split(".")[0] : undefined;
  const ref = ownGet(value, "Ref");
  if (typeof ref === "string") return refTarget(ref);
  const attribute = ownGet(value, "Fn::GetAtt");
  if (Array.isArray(attribute)) return refTarget(attribute[0]);
  return typeof attribute === "string" ? refTarget(attribute) : undefined;
}

/** The CloudFormation type of a resource, when it is written. */
const cfnType = (value: unknown): string | undefined => { const type = ownGet(value, "Type"); return typeof type === "string" ? type : undefined; };

function cfnResource(logicalId: string, value: unknown, literal: string | undefined): DependencyResource | undefined {
  const type = cfnType(value);
  const kind = type !== undefined && Object.hasOwn(CFN_KINDS, type) ? CFN_KINDS[type] : undefined;
  if (kind === undefined) return undefined;
  const properties = ownGet(value, "Properties");
  if (kind === "secret") {
    // The name only. Whatever the template says about the value (a generated string, a reference) is never read.
    const name = matching(SECRET_NAME, ownGet(properties, "Name")) ?? plainName(logicalId.slice(0, 64));
    return name === undefined ? undefined : { kind, name };
  }
  if (kind === "parameter") {
    const name = matching(PARAMETER_NAME, ownGet(properties, "Name")) ?? plainName(logicalId.slice(0, 64));
    if (name === undefined) return undefined;
    if (!isStringParameter(ownGet(properties, "Type"))) return undefined;
    return { kind, name, ...(literal === undefined ? {} : { value: literal }) };
  }
  if (kind === "key") {
    // A key is called by its logical id; its alias comes from an `AWS::KMS::Alias` that targets it (`templateResources`).
    const name = plainName(logicalId.slice(0, 64));
    return name === undefined ? undefined : { kind, name };
  }
  if (kind === "rule") {
    const name = matching(/^[A-Za-z0-9._-]{1,64}$/u, ownGet(properties, "Name")) ?? plainName(logicalId.slice(0, 64));
    if (name === undefined) return undefined;
    const resource: DependencyResource = { kind, name };
    const schedule = ownGet(properties, "ScheduleExpression");
    if (typeof schedule === "string" && /^(?:rate|cron)\([A-Za-z0-9 ,*?/#L,W-]{1,100}\)$/u.test(schedule)) resource.schedule = schedule;
    const pattern = ownGet(properties, "EventPattern");
    if (pattern !== null && typeof pattern === "object" && !Array.isArray(pattern)) { const text = JSON.stringify(pattern); if (text.length <= 1_000 && !text.includes("${")) resource.pattern = text; }
    const bus = ownGet(properties, "EventBusName");
    const busName = typeof bus === "string" ? plainName(bus) : undefined;
    if (busName !== undefined && busName !== "default") resource.bus = busName;
    // A rule with neither a schedule nor a literal pattern cannot be created as written: its service is still a candidate (`templateResources`).
    return resource.pattern === undefined && resource.schedule === undefined ? undefined : resource;
  }
  const name = plainName(ownGet(properties, CFN_NAME_PROPERTY[kind])) ?? plainName(logicalId.slice(0, 64));
  if (name === undefined) return undefined;
  const resource: DependencyResource = { kind, name };
  if (kind === "table") {
    if (type === "AWS::Serverless::SimpleTable") {
      const key = attribute(ownGet(ownGet(properties, "PrimaryKey"), "Name"), ownGet(ownGet(properties, "PrimaryKey"), "Type"));
      resource.keySchema = { partitionKey: key ?? { name: "id", type: "S" } };
    } else {
      const definitions = ownGet(properties, "AttributeDefinitions");
      const types = new Map<string, unknown>();
      for (const definition of Array.isArray(definitions) ? definitions.slice(0, 40) : []) { const name = ownGet(definition, "AttributeName"); if (typeof name === "string") types.set(name, ownGet(definition, "AttributeType")); }
      const schema = ownGet(properties, "KeySchema");
      let partition: DependencyKeyAttribute | undefined;
      let sort: DependencyKeyAttribute | undefined;
      for (const entry of Array.isArray(schema) ? schema.slice(0, 4) : []) {
        const name = ownGet(entry, "AttributeName");
        const item = attribute(name, typeof name === "string" ? types.get(name) : undefined);
        if (ownGet(entry, "KeyType") === "HASH") partition = item;
        else if (ownGet(entry, "KeyType") === "RANGE") sort = item;
      }
      if (partition !== undefined) resource.keySchema = { partitionKey: partition, ...(sort === undefined ? {} : { sortKey: sort }) };
    }
  }
  return resource;
}

interface TemplateEntry {
  logicalId: string;
  line: number;
  value: unknown;
  /** A parameter's literal `Value` (in YAML: a plain scalar with no tag, since a `!Ref` is not a literal). */
  literal?: string | undefined;
}

/**
 * The resources of one template, in order, with the queues each topic delivers to and the alias each key has: an SNS subscription (`Subscription` on the topic, or an `AWS::SNS::Subscription`) whose protocol is `sqs`
 * and whose endpoint is a queue of the same template, and an `AWS::KMS::Alias` whose target is a key of it. Any other type of a service the table knows is a candidate of that service.
 */
function templateResources(entries: readonly TemplateEntry[], path: string, out: DependencyCandidate[]): void {
  const made = new Map<string, { entry: TemplateEntry; resource: DependencyResource }>();
  for (const entry of entries) {
    const resource = cfnResource(entry.logicalId, entry.value, entry.literal);
    if (resource !== undefined) { made.set(entry.logicalId, { entry, resource }); continue; }
    const type = cfnType(entry.value);
    const key = type === undefined ? undefined : awsServiceKeyFromCfnType(type);
    if (key !== undefined) out.push(candidate(`aws:${key}`, "declared", { path, line: entry.line }, { seenBy: ["iac"] }));
  }
  const subscribe = (topicId: string | undefined, subscription: unknown): void => {
    const topic = topicId === undefined ? undefined : made.get(topicId)?.resource;
    const protocol = ownGet(subscription, "Protocol");
    const queue = made.get(refTarget(ownGet(subscription, "Endpoint")) ?? "")?.resource;
    if (topic === undefined || topic.kind !== "topic" || typeof protocol !== "string" || protocol.toLowerCase() !== "sqs" || queue === undefined || queue.kind !== "queue") return;
    topic.queues = [...new Set([...(topic.queues ?? []), queue.name])].slice(0, 8);
  };
  for (const entry of entries) {
    const type = cfnType(entry.value);
    const properties = ownGet(entry.value, "Properties");
    if (type === "AWS::SNS::Topic") {
      const listed = ownGet(properties, "Subscription");
      for (const subscription of (Array.isArray(listed) ? (listed as unknown[]) : []).slice(0, 16)) subscribe(entry.logicalId, subscription);
    } else if (type === "AWS::SNS::Subscription") subscribe(refTarget(ownGet(properties, "TopicArn")), properties);
    else if (type === "AWS::KMS::Alias") {
      const alias = matching(KEY_ALIAS, ownGet(properties, "AliasName"));
      if (alias === undefined) continue;
      const target = made.get(refTarget(ownGet(properties, "TargetKeyId")) ?? "")?.resource;
      if (target !== undefined && target.kind === "key" && target.alias === undefined) target.alias = alias;
      else if (target === undefined) made.set(entry.logicalId, { entry, resource: { kind: "key", name: plainName(entry.logicalId.slice(0, 64)) ?? "key", alias } });
    }
  }
  for (const { entry, resource } of made.values()) emit(out, path, entry.line, resource);
}

function readTemplate(path: string, text: string, out: DependencyCandidate[], notes: string[]): void {
  if (!text.includes("AWS::")) return;
  if (path.endsWith(".json")) {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return; }
    const entries = ownEntries(ownGet(parsed, "Resources")).slice(0, 500).map(([logicalId, value]): TemplateEntry => ({ logicalId, line: lineOfKey(text, logicalId), value, literal: literalValue(ownGet(ownGet(value, "Properties"), "Value")) }));
    templateResources(entries, path, out);
    return;
  }
  const parsed = parseSafeYaml(text);
  if (!parsed.ok) { notes.push(`An infrastructure template ${YAML_REFUSAL_WORDS[parsed.reason]}, so it was not read.`); return; }
  const safe = parsed.value;
  const resources = pairOf(safe.document.contents, "Resources");
  if (resources === undefined || !isMap(resources.value)) return;
  const entries: TemplateEntry[] = [];
  for (const pair of resources.value.items.slice(0, 500)) {
    if (!isScalar(pair.key) || typeof pair.key.value !== "string") continue;
    entries.push({ logicalId: pair.key.value, line: safe.lineOf(pair.key), value: safe.toPlain(pair.value), literal: yamlLiteralValue(pair) });
  }
  templateResources(entries, path, out);
}

/** A parameter's `Value` in a YAML template when it is a plain string scalar: not one with a tag (`!Ref X` reads as the text `X`, which is a reference and not a value). */
function yamlLiteralValue(resource: Pair): string | undefined {
  const value = pairOf(pairOf(resource.value, "Properties")?.value, "Value")?.value;
  return isScalar(value) && value.tag === undefined && typeof value.value === "string" ? literalValue(value.value) : undefined;
}

function lineOfKey(text: string, key: string): number {
  const at = text.indexOf(`"${key}"`);
  return at < 0 ? 1 : lineOf(text, at);
}

// ---- Terraform

const TF_KINDS: Record<string, DependencyResource["kind"]> = {
  aws_dynamodb_table: "table", aws_s3_bucket: "bucket", aws_sqs_queue: "queue", aws_sns_topic: "topic", aws_secretsmanager_secret: "secret", aws_ssm_parameter: "parameter", aws_kms_key: "key",
  aws_cloudwatch_event_bus: "bus", aws_cloudwatch_event_rule: "rule",
};
const TF_NAME_ATTRIBUTE: Record<DependencyResource["kind"], string> = { table: "name", bucket: "bucket", queue: "name", topic: "name", secret: "name", parameter: "name", key: "", bus: "name", rule: "name" };

/**
 * Terraform type prefixes (the part after `aws_`, words joined by `-`) that are not the key, legacy key or boto3 name of the service that owns them, longest first. Everything else is read from the emulator's table:
 * the first words of the type up to the first one the table knows (`aws_sqs_queue_policy` is `sqs`, `aws_api_gateway_rest_api` is `api-gateway`).
 */
const TF_PREFIX_OVERRIDES: ReadonlyArray<readonly [string, string]> = [
  ["cloudwatch-event", "eventbridge"], ["cloudwatch-log", "cloudwatch-logs"], ["cloudwatch-metric", "cloudwatch"], ["cognito-identity-pool", "cognito-identity"], ["cognito-user", "cognito-identity-provider"], ["cognito-identity-provider", "cognito-identity-provider"],
  ["kinesis-firehose", "firehose"], ["kinesis-analytics", "kinesisanalytics"], ["api-gateway", "api-gateway"], ["db", "rds"], ["lb", "elastic-load-balancing-v2"], ["alb", "elastic-load-balancing-v2"], ["elb", "elastic-load-balancing"],
  ["instance", "ec2"], ["vpc", "ec2"], ["subnet", "ec2"], ["security-group", "ec2"], ["ebs", "ec2"], ["eip", "ec2"], ["nat-gateway", "ec2"], ["internet-gateway", "ec2"], ["route-table", "ec2"], ["launch-template", "ec2"], ["key-pair", "ec2"],
  ["lambda", "lambda"], ["sfn", "sfn"],
];

/**
 * The key of the service a Terraform resource type (`aws_sqs_queue`) belongs to, or the first word of the type when no service of the table owns it (`mapped: false`: a `mentioned` candidate, never dropped). Undefined only
 * when the type has no usable first word.
 */
export function awsServiceOfTerraformType(type: string): { key: string; mapped: boolean } | undefined {
  if (!type.startsWith("aws_")) return undefined;
  const words = type.slice(4).split("_").filter((word) => word !== "");
  for (const [prefix, key] of TF_PREFIX_OVERRIDES) {
    const own = prefix.split("-");
    if (own.every((word, index) => words[index] === word)) return { key, mapped: isTableAwsService(key) };
  }
  for (let count = 1; count <= Math.min(words.length, 3); count += 1) {
    const spelling = words.slice(0, count).join("-");
    const key = normaliseAwsServiceKey(spelling);
    if (key !== undefined) return { key, mapped: true };
    const other = normalizeAwsService(spelling, "boto3");
    if (other !== undefined && isTableAwsService(other)) return { key: normaliseAwsServiceKey(other) ?? other, mapped: true };
  }
  const first = words[0];
  return first !== undefined && /^[a-z][a-z0-9]{1,39}$/u.test(first) ? { key: first, mapped: false } : undefined;
}

/** The text of the `{ ... }` block that opens at `open`, braces in strings and comments skipped, at most `max` characters. */
function braceBody(text: string, open: number, max = 20_000): string {
  let depth = 0;
  let quote = false;
  const end = Math.min(text.length, open + max);
  for (let i = open; i < end; i += 1) {
    const char = text[i]!;
    if (quote) { if (char === "\\") i += 1; else if (char === "\"") quote = false; continue; }
    if (char === "\"") quote = true;
    else if (char === "#" || (char === "/" && text[i + 1] === "/")) { while (i < end && text[i] !== "\n") i += 1; }
    else if (char === "{") depth += 1;
    else if (char === "}") { depth -= 1; if (depth === 0) return text.slice(open + 1, i); }
  }
  return text.slice(open + 1, end);
}

const tfString = (body: string, name: string): string | undefined => new RegExp(`^[ \\t]*${name}[ \\t]*=[ \\t]*"([^"$\\n]*)"`, "mu").exec(body)?.[1];
/** The `type.label` a reference such as `aws_sqs_queue.jobs.arn` or `aws_kms_key.main.key_id` points at. */
const tfReference = (body: string, name: string): string | undefined => new RegExp(`^[ \\t]*${name}[ \\t]*=[ \\t]*(aws_[a-z0-9_]+\\.[A-Za-z0-9_-]+)\\.[a-z_]+[ \\t]*$`, "mu").exec(body)?.[1];
/** A heredoc JSON document (`event_pattern = <<EOF ... EOF`) or `jsonencode` call is not read as a literal: only a heredoc that parses as a JSON object is. */
function tfHeredocJson(body: string, name: string): string | undefined {
  const match = new RegExp(`^[ \\t]*${name}[ \\t]*=[ \\t]*<<[-~]?([A-Z_]{2,20})\\n([\\s\\S]{1,1100}?)\\n[ \\t]*\\1[ \\t]*$`, "mu").exec(body);
  if (match === null || match[2]!.includes("${")) return undefined;
  try { const value: unknown = JSON.parse(match[2]!); return value !== null && typeof value === "object" && !Array.isArray(value) ? JSON.stringify(value) : undefined; } catch { return undefined; }
}

function readTerraform(path: string, text: string, out: DependencyCandidate[]): void {
  // `type.label` of the resources a later block refers to: the topic or queue a subscription joins, the key an alias names.
  const byReference = new Map<string, DependencyResource>();
  const emitted: Array<{ line: number; resource: DependencyResource }> = [];
  const aliases: Array<{ line: number; alias: string; target: string | undefined; label: string }> = [];
  const subscriptions: Array<{ topic: string | undefined; queue: string | undefined; protocol: string | undefined }> = [];
  for (const match of text.matchAll(/^[ \t]*resource[ \t]+"(aws_[a-z0-9_]{2,80})"[ \t]+"([A-Za-z0-9_-]{1,64})"[ \t]*\{/gmu)) {
    const type = match[1]!;
    const label = match[2]!;
    const line = lineOf(text, match.index);
    const body = braceBody(text, match.index + match[0].length - 1);
    if (type === "aws_sns_topic_subscription") { subscriptions.push({ topic: tfReference(body, "topic_arn"), queue: tfReference(body, "endpoint"), protocol: tfString(body, "protocol") }); continue; }
    if (type === "aws_kms_alias") {
      const alias = matching(KEY_ALIAS, tfString(body, "name"));
      if (alias !== undefined) aliases.push({ line, alias, target: tfReference(body, "target_key_id"), label });
      continue;
    }
    const kind = Object.hasOwn(TF_KINDS, type) ? TF_KINDS[type] : undefined;
    if (kind === undefined) {
      const service = awsServiceOfTerraformType(type);
      if (service !== undefined) out.push(candidate(`aws:${service.key}`, service.mapped ? "declared" : "mentioned", { path, line }, { seenBy: ["iac"] }));
      continue;
    }
    // Nested `attribute { name = ... }` blocks carry their own `name`: take them out first so the resource's own settings are read from what is left.
    const types = new Map<string, string>();
    let top = body;
    for (const block of body.matchAll(/^[ \t]*attribute[ \t]*\{/gmu)) {
      const inner = braceBody(body, block.index + block[0].length - 1, 1_000);
      const name = tfString(inner, "name");
      if (name !== undefined) types.set(name, tfString(inner, "type") ?? "S");
      top = top.replace(inner, "");
    }
    let resource: DependencyResource | undefined;
    if (kind === "secret") { const name = matching(SECRET_NAME, tfString(top, "name")) ?? plainName(label); resource = name === undefined ? undefined : { kind, name }; }
    else if (kind === "parameter") {
      const name = matching(PARAMETER_NAME, tfString(top, "name")) ?? plainName(label);
      if (name !== undefined && isStringParameter(tfString(top, "type"))) {
        const value = literalValue(tfString(top, "value"));
        resource = { kind, name, ...(value === undefined ? {} : { value }) };
      }
    } else if (kind === "key") { const name = plainName(label); resource = name === undefined ? undefined : { kind, name }; }
    else if (kind === "rule") {
      const name = matching(/^[A-Za-z0-9._-]{1,64}$/u, tfString(top, "name")) ?? plainName(label);
      const schedule = matching(/^(?:rate|cron)\([A-Za-z0-9 ,*?/#L,W-]{1,100}\)$/u, tfString(top, "schedule_expression"));
      const pattern = tfHeredocJson(top, "event_pattern");
      const busReference = tfReference(top, "event_bus_name");
      const busLiteral = plainName(tfString(top, "event_bus_name"));
      if (name !== undefined && (schedule !== undefined || pattern !== undefined)) {
        resource = { kind, name, ...(schedule === undefined ? {} : { schedule }), ...(pattern === undefined ? {} : { pattern }) };
        const bus = busReference === undefined ? busLiteral : byReference.get(busReference)?.name;
        if (bus !== undefined && bus !== "default") resource.bus = bus;
      }
    } else {
      const name = plainName(tfString(top, TF_NAME_ATTRIBUTE[kind])) ?? plainName(label);
      if (name !== undefined) {
        resource = { kind, name };
        if (kind === "table") {
          const partition = tfString(top, "hash_key");
          const sort = tfString(top, "range_key");
          const partitionKey = partition === undefined ? undefined : attribute(partition, types.get(partition));
          if (partitionKey !== undefined) { const sortKey = sort === undefined ? undefined : attribute(sort, types.get(sort)); resource.keySchema = { partitionKey, ...(sortKey === undefined ? {} : { sortKey }) }; }
        }
      }
    }
    if (resource === undefined) {
      // A resource that cannot be created as written (a rule with no schedule or pattern) still makes its service a candidate.
      out.push(candidate(FAMILY_OF_KIND[kind], "declared", { path, line }, { seenBy: ["iac"] }));
      continue;
    }
    byReference.set(`${type}.${label}`, resource);
    emitted.push({ line, resource });
  }
  for (const subscription of subscriptions) {
    const topic = subscription.topic === undefined ? undefined : byReference.get(subscription.topic);
    const queue = subscription.queue === undefined ? undefined : byReference.get(subscription.queue);
    if (topic?.kind === "topic" && queue?.kind === "queue" && subscription.protocol?.toLowerCase() === "sqs") topic.queues = [...new Set([...(topic.queues ?? []), queue.name])].slice(0, 8);
  }
  for (const item of aliases) {
    const target = item.target === undefined ? undefined : byReference.get(item.target);
    if (target?.kind === "key" && target.alias === undefined) target.alias = item.alias;
    else if (target === undefined) emitted.push({ line: item.line, resource: { kind: "key", name: plainName(item.label) ?? "key", alias: item.alias } });
  }
  for (const item of emitted) emit(out, path, item.line, item.resource);
}

// ---- AWS CDK source

const CDK_CLASSES: Record<string, DependencyResource["kind"]> = { Table: "table", TableV2: "table", Bucket: "bucket", Queue: "queue", Topic: "topic" };
/** Classes whose names are common words (`Key`, `Rule`, `Secret`): read only in a file that imports the service's CDK module, so an unrelated `Rule` is never taken for an EventBridge rule. */
const CDK_MODULE_CLASSES: Record<string, { kind: DependencyResource["kind"]; module: RegExp }> = {
  Secret: { kind: "secret", module: /aws-secretsmanager|aws_secretsmanager/u },
  StringParameter: { kind: "parameter", module: /aws-ssm|aws_ssm/u },
  Key: { kind: "key", module: /aws-kms|aws_kms/u },
  EventBus: { kind: "bus", module: /aws-events|aws_events/u },
};
const CDK_NAME_PROPERTY: Record<DependencyResource["kind"], [string, string]> = {
  table: ["tableName", "table_name"], bucket: ["bucketName", "bucket_name"], queue: ["queueName", "queue_name"], topic: ["topicName", "topic_name"], secret: ["secretName", "secret_name"],
  parameter: ["parameterName", "parameter_name"], key: ["alias", "alias"], bus: ["eventBusName", "event_bus_name"], rule: ["ruleName", "rule_name"],
};

function cdkKey(args: string, camel: string, snake: string): DependencyKeyAttribute | undefined {
  // TypeScript: partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING }   Python: partition_key=dynamodb.Attribute(name="pk", type=dynamodb.AttributeType.STRING)
  const ts = new RegExp(`\\b${camel}\\s{0,40}:\\s{0,40}\\{([^}]*)\\}`, "u").exec(args)?.[1];
  const py = new RegExp(`\\b${snake}\\s{0,40}=\\s{0,40}[\\w.]*Attribute\\(([^)]*)\\)`, "u").exec(args)?.[1];
  const inner = ts ?? py;
  if (inner === undefined) return undefined;
  const name = /\bname\s{0,40}[:=]\s{0,40}["'`]([^"'`$]+)["'`]/u.exec(inner)?.[1];
  const type = /AttributeType\.([A-Z]+)/u.exec(inner)?.[1];
  return attribute(name, type);
}

/** The CDK module names (`aws-cdk-lib/aws-sqs`, `@aws-cdk/aws-sqs`, `aws_cdk.aws_sqs`, `from aws_cdk import aws_sqs`) a source file imports, with the line. */
function cdkModules(text: string): Array<{ module: string; line: number }> {
  const found: Array<{ module: string; line: number }> = [];
  for (const match of text.matchAll(/["'](?:aws-cdk-lib|@aws-cdk)\/aws-([a-z0-9-]{2,40})["']/gu)) found.push({ module: match[1]!, line: lineOf(text, match.index) });
  for (const match of text.matchAll(/\baws_cdk\.aws_([a-z0-9_]{2,40})\b/gu)) found.push({ module: match[1]!.replace(/_/gu, "-"), line: lineOf(text, match.index) });
  for (const line of text.matchAll(/^[ \t]*from[ \t]+aws_cdk[ \t]+import[ \t]+([^\n]{1,300})$/gmu)) {
    for (const word of line[1]!.matchAll(/\baws_([a-z0-9_]{2,40})\b/gu)) found.push({ module: word[1]!.replace(/_/gu, "-"), line: lineOf(text, line.index) });
  }
  // TypeScript and JavaScript: the names an alias import of the CDK library lists (`aws_s3 as s3, aws_sns`, possibly over several lines), and the same names taken from a require of it.
  for (const block of text.matchAll(/(?:\bimport\s{0,10}\{([^}]{1,600})\}\s{0,10}from|\bconst\s{1,10}\{([^}]{1,600})\}\s{0,10}=\s{0,10}require\()\s{0,10}["'](?:aws-cdk-lib|@aws-cdk\/core)["']/gu)) {
    for (const word of (block[1] ?? block[2] ?? "").matchAll(/\baws_([a-z0-9_]{2,40})\b/gu)) found.push({ module: word[1]!.replace(/_/gu, "-"), line: lineOf(text, block.index) });
  }
  return found;
}
/** CDK module names that are not the key, legacy key or boto3 name of the service they are about (`aws-cognito` is user pools). */
const CDK_MODULE_OVERRIDES: Readonly<Record<string, string>> = { cognito: "cognito-identity-provider" };

function readCdk(path: string, text: string, out: DependencyCandidate[]): void {
  if (!/aws-cdk-lib|@aws-cdk\/|aws_cdk/u.test(text)) return;
  for (const { module, line } of cdkModules(text)) {
    const service = CDK_MODULE_OVERRIDES[module] ?? normalizeAwsService(module, "boto3");
    if (service !== undefined && isTableAwsService(service)) out.push(candidate(`aws:${normaliseAwsServiceKey(service) ?? service}`, "mentioned", { path, line }, { seenBy: ["iac"] }));
  }
  const classes = [...Object.keys(CDK_CLASSES), ...Object.keys(CDK_MODULE_CLASSES)].join("|");
  const pattern = path.endsWith(".py")
    ? new RegExp(`\\b(?:([A-Za-z_0-9]+)\\s{0,20}=\\s{0,20})?(?:[a-z_0-9]+\\.)?(${classes})\\(\\s{0,120}(?:self|scope)\\s{0,40},\\s{0,40}["']([^"']+)["']`, "gu")
    : new RegExp(`(?:\\b(?:const|let|var)\\s{1,10}([A-Za-z_0-9]+)\\s{0,20}=\\s{0,20}|\\bthis\\.([A-Za-z_0-9]+)\\s{0,20}=\\s{0,20})?\\bnew\\s{1,40}(?:[A-Za-z0-9_]+\\.)?(${classes})\\s{0,120}\\(\\s{0,120}(?:this|scope|stack)\\s{0,40},\\s{0,40}["'\`]([^"'\`]+)["'\`]`, "gu");
  const variables = new Map<string, DependencyResource>();
  const found: Array<{ line: number; resource: DependencyResource }> = [];
  for (const match of text.matchAll(pattern)) {
    const python = path.endsWith(".py");
    const variable = python ? match[1] : (match[1] ?? match[2]);
    const className = (python ? match[2] : match[3])!;
    const id = (python ? match[3] : match[4])!;
    const module = Object.hasOwn(CDK_MODULE_CLASSES, className) ? CDK_MODULE_CLASSES[className]! : undefined;
    if (module !== undefined && !module.module.test(text)) continue;
    const kind = module?.kind ?? CDK_CLASSES[className]!;
    const open = text.indexOf("(", match.index + match[0].indexOf(className));
    const args = callArguments(text, open, 2_000);
    const [camel, snake] = CDK_NAME_PROPERTY[kind];
    const named = new RegExp(`\\b(?:${camel}\\s{0,40}:|${snake}\\s{0,40}=)\\s{0,40}["'\`]([^"'\`$]+)["'\`]`, "u").exec(args)?.[1];
    let resource: DependencyResource | undefined;
    if (kind === "secret") { const name = matching(SECRET_NAME, named) ?? plainName(id.slice(0, 64)); resource = name === undefined ? undefined : { kind, name }; }
    else if (kind === "parameter") {
      const name = matching(PARAMETER_NAME, named) ?? plainName(id.slice(0, 64));
      const value = literalValue(new RegExp(`\\b(?:stringValue\\s{0,40}:|string_value\\s{0,40}=)\\s{0,40}["'\`]([^"'\`$]+)["'\`]`, "u").exec(args)?.[1]);
      resource = name === undefined ? undefined : { kind, name, ...(value === undefined ? {} : { value }) };
    } else if (kind === "key") { const name = plainName(id.slice(0, 64)); const alias = matching(KEY_ALIAS, named); resource = name === undefined ? undefined : { kind, name, ...(alias === undefined ? {} : { alias }) }; }
    else if (kind === "bus") { const name = plainName(named) ?? plainName(id.slice(0, 64)); resource = name === undefined ? undefined : { kind, name }; }
    else {
      const name = plainName(named) ?? plainName(id.slice(0, 64));
      if (name === undefined) continue;
      resource = { kind, name };
      if (kind === "table") {
        const partitionKey = cdkKey(args, "partitionKey", "partition_key");
        const sortKey = cdkKey(args, "sortKey", "sort_key");
        if (partitionKey !== undefined) resource.keySchema = { partitionKey, ...(sortKey === undefined ? {} : { sortKey }) };
      }
    }
    if (resource === undefined) continue;
    if (variable !== undefined) variables.set(variable, resource);
    found.push({ line: lineOf(text, match.index), resource });
  }
  // `topic.addSubscription(new subs.SqsSubscription(queue))` (Python: `topic.add_subscription(subs.SqsSubscription(queue))`) with both written as variables of this file.
  for (const match of text.matchAll(/\b([A-Za-z_0-9]+)\s{0,10}\.\s{0,10}(?:addSubscription|add_subscription)\s{0,10}\(\s{0,20}(?:new\s{1,10})?(?:[A-Za-z0-9_]+\.)?SqsSubscription\s{0,10}\(\s{0,20}([A-Za-z_0-9]+)/gu)) {
    const topic = variables.get(match[1]!);
    const queue = variables.get(match[2]!);
    if (topic?.kind === "topic" && queue?.kind === "queue") topic.queues = [...new Set([...(topic.queues ?? []), queue.name])].slice(0, 8);
  }
  for (const item of found) emit(out, path, item.line, item.resource);
}

// ---- the detector

const TEMPLATE_FILE = /(?:^|\/)(?:template|serverless|[^/]*\.template|[^/]*\.cfn|samconfig)\.(?:ya?ml|json)$|(?:^|\/)(?:cloudformation|cfn|sam|templates|infra|infrastructure|cdk\.out|deploy)\/[^/]*\.(?:ya?ml|json)$/u;
const CDK_SOURCE = /(?:^|\/)(?:cdk|infra|infrastructure|iac|deploy|stacks?|lib|bin)\/[^/]+\.(?:ts|js|py)$|(?:stack|-stack)\.(?:ts|js)$|_stack\.py$/u;

/** Whether the detector reads this path at all: not under a folder it skips, and a Terraform file, a template by name or place, or infrastructure source. A pointer to any other file gives no resources. */
export function iacFileIsRead(path: string): boolean {
  return !DEPENDENCY_SKIP_DIRS.test(path) && (path.endsWith(".tf") || (TEMPLATE_FILE.test(path) && !path.endsWith("samconfig.toml")) || (CDK_SOURCE.test(path) && !path.endsWith(".d.ts")));
}

async function files(repo: RepositoryReader): Promise<string[]> {
  const live = repo.paths.filter((path) => !DEPENDENCY_SKIP_DIRS.test(path));
  const chosen = [
    ...live.filter((path) => path.endsWith(".tf")),
    ...live.filter((path) => TEMPLATE_FILE.test(path) && !path.endsWith("samconfig.toml")),
    ...live.filter((path) => CDK_SOURCE.test(path) && !path.endsWith(".d.ts")),
  ];
  return [...new Set(chosen)].slice(0, IAC_RESOURCES_MAX_FILES);
}

export const detectIacResources: Detector = async ({ repo }) => {
  const found: DependencyCandidate[] = [];
  const notes: string[] = [];
  for (const path of await files(repo)) {
    const text = await repo.read(path);
    if (text === undefined) continue;
    if (path.endsWith(".tf")) readTerraform(path, text, found);
    else if (/\.(?:ya?ml|json)$/u.test(path)) readTemplate(path, text, found, notes);
    else readCdk(path, text, found);
  }
  const dependencies = mergeCandidates(found);
  const cut = found.length > 0 && dependencies.some((item) => (item.hints.resources?.length ?? 0) >= MAX_RESOURCES);
  if (cut) notes.push(`More than ${String(MAX_RESOURCES)} resources of one kind were found in infrastructure code; the first ${String(MAX_RESOURCES)} are kept.`);
  return dependencies.length === 0 && notes.length === 0 ? {} : { ...(dependencies.length === 0 ? {} : { dependencies }), notes };
};
