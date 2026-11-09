// IaC resources detector (test services D7; design test-services.md 3.2). Reads infrastructure code (CloudFormation and SAM templates, including a committed `cdk.out`; Terraform `*.tf`; AWS CDK source in TypeScript,
// JavaScript and Python) for the AWS resources the project declares: DynamoDB tables WITH their key schema, S3 buckets, SQS queues and SNS topics. Rovara local AWS creates them when it starts (5.4), so tests that
// expect them find them. The existing `iac.ts` only says which kind of IaC the repository uses; this file reads what is in it.
// Reads only: a template is data, never deployed, and no Terraform or CDK command is run. YAML is read under `safe-yaml.ts`'s limits. A name is kept only when it is written as a plain identifier (letters, digits,
// `.`, `_`, `-`); anything built from a function or a variable falls back to the template's own id for the resource. The key schema is attribute NAMES and the types S, N or B.
import { looksLikeSecretValue } from "@agentx/contracts";
import { callArguments, candidate, DEPENDENCY_SKIP_DIRS, mergeCandidates, MAX_RESOURCES } from "./dependency-candidates.js";
import { ownEntries, ownGet, pairOf, parseSafeYaml, YAML_REFUSAL_WORDS } from "./safe-yaml.js";
import { lineOf, type DependencyCandidate, type DependencyKeyAttribute, type DependencyResource, type Detector, type RepositoryReader } from "./types.js";
import { isMap, isScalar } from "yaml";

export const IAC_RESOURCES_MAX_FILES = 80;
const FAMILY_OF_KIND: Record<DependencyResource["kind"], string> = { table: "aws:dynamodb", bucket: "aws:s3", queue: "aws:sqs", topic: "aws:sns" };
const PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/u;
/** A name written as a plain identifier and not shaped like a key (a table or bucket name is carried by design, so it must never be a secret by accident). */
const plainName = (value: unknown): string | undefined => (typeof value === "string" && PLAIN_NAME.test(value) && !looksLikeSecretValue(value) ? value : undefined);
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

const CFN_KINDS: Record<string, DependencyResource["kind"]> = { "AWS::DynamoDB::Table": "table", "AWS::DynamoDB::GlobalTable": "table", "AWS::Serverless::SimpleTable": "table", "AWS::S3::Bucket": "bucket", "AWS::SQS::Queue": "queue", "AWS::SNS::Topic": "topic" };
const CFN_NAME_PROPERTY: Record<DependencyResource["kind"], string> = { table: "TableName", bucket: "BucketName", queue: "QueueName", topic: "TopicName" };

function cfnResource(logicalId: string, value: unknown): DependencyResource | undefined {
  const type = ownGet(value, "Type");
  const kind = typeof type === "string" && Object.hasOwn(CFN_KINDS, type) ? CFN_KINDS[type] : undefined;
  if (kind === undefined) return undefined;
  const properties = ownGet(value, "Properties");
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

function readTemplate(path: string, text: string, out: DependencyCandidate[], notes: string[]): void {
  if (!text.includes("AWS::")) return;
  if (path.endsWith(".json")) {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return; }
    for (const [logicalId, value] of ownEntries(ownGet(parsed, "Resources")).slice(0, 500)) {
      const resource = cfnResource(logicalId, value);
      if (resource !== undefined) emit(out, path, lineOfKey(text, logicalId), resource);
    }
    return;
  }
  const parsed = parseSafeYaml(text);
  if (!parsed.ok) { notes.push(`An infrastructure template ${YAML_REFUSAL_WORDS[parsed.reason]}, so it was not read.`); return; }
  const safe = parsed.value;
  const resources = pairOf(safe.document.contents, "Resources");
  if (resources === undefined || !isMap(resources.value)) return;
  for (const pair of resources.value.items.slice(0, 500)) {
    if (!isScalar(pair.key) || typeof pair.key.value !== "string") continue;
    const resource = cfnResource(pair.key.value, safe.toPlain(pair.value));
    if (resource !== undefined) emit(out, path, safe.lineOf(pair.key), resource);
  }
}

function lineOfKey(text: string, key: string): number {
  const at = text.indexOf(`"${key}"`);
  return at < 0 ? 1 : lineOf(text, at);
}

// ---- Terraform

const TF_KINDS: Record<string, DependencyResource["kind"]> = { aws_dynamodb_table: "table", aws_s3_bucket: "bucket", aws_sqs_queue: "queue", aws_sns_topic: "topic" };
const TF_NAME_ATTRIBUTE: Record<DependencyResource["kind"], string> = { table: "name", bucket: "bucket", queue: "name", topic: "name" };

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

function readTerraform(path: string, text: string, out: DependencyCandidate[]): void {
  for (const match of text.matchAll(/^[ \t]*resource[ \t]+"(aws_dynamodb_table|aws_s3_bucket|aws_sqs_queue|aws_sns_topic)"[ \t]+"([A-Za-z0-9_-]{1,64})"[ \t]*\{/gmu)) {
    const kind = TF_KINDS[match[1]!]!;
    const body = braceBody(text, match.index + match[0].length - 1);
    // Nested `attribute { name = ... }` blocks carry their own `name`: take them out first so the resource's own settings are read from what is left.
    const types = new Map<string, string>();
    let top = body;
    for (const block of body.matchAll(/^[ \t]*attribute[ \t]*\{/gmu)) {
      const inner = braceBody(body, block.index + block[0].length - 1, 1_000);
      const name = tfString(inner, "name");
      if (name !== undefined) types.set(name, tfString(inner, "type") ?? "S");
      top = top.replace(inner, "");
    }
    const name = plainName(tfString(top, TF_NAME_ATTRIBUTE[kind])) ?? plainName(match[2]);
    if (name === undefined) continue;
    const resource: DependencyResource = { kind, name };
    if (kind === "table") {
      const partition = tfString(top, "hash_key");
      const sort = tfString(top, "range_key");
      const partitionKey = partition === undefined ? undefined : attribute(partition, types.get(partition));
      if (partitionKey !== undefined) { const sortKey = sort === undefined ? undefined : attribute(sort, types.get(sort)); resource.keySchema = { partitionKey, ...(sortKey === undefined ? {} : { sortKey }) }; }
    }
    emit(out, path, lineOf(text, match.index), resource);
  }
}

// ---- AWS CDK source

const CDK_CLASSES: Record<string, DependencyResource["kind"]> = { Table: "table", TableV2: "table", Bucket: "bucket", Queue: "queue", Topic: "topic" };
const CDK_NAME_PROPERTY: Record<DependencyResource["kind"], [string, string]> = { table: ["tableName", "table_name"], bucket: ["bucketName", "bucket_name"], queue: ["queueName", "queue_name"], topic: ["topicName", "topic_name"] };

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

function readCdk(path: string, text: string, out: DependencyCandidate[]): void {
  if (!/aws-cdk-lib|@aws-cdk\/|aws_cdk/u.test(text)) return;
  const pattern = path.endsWith(".py")
    ? /\b(?:[a-z_0-9]+\.)?(Table|TableV2|Bucket|Queue|Topic)\(\s{0,120}(?:self|scope)\s{0,40},\s{0,40}["']([^"']+)["']/gu
    : /\bnew\s{1,40}(?:[A-Za-z0-9_]+\.)?(Table|TableV2|Bucket|Queue|Topic)\s{0,120}\(\s{0,120}(?:this|scope|stack)\s{0,40},\s{0,40}["'`]([^"'`]+)["'`]/gu;
  for (const match of text.matchAll(pattern)) {
    const kind = CDK_CLASSES[match[1]!]!;
    const open = text.indexOf("(", match.index);
    const args = callArguments(text, open, 2_000);
    const [camel, snake] = CDK_NAME_PROPERTY[kind];
    const named = new RegExp(`\\b(?:${camel}\\s{0,40}:|${snake}\\s{0,40}=)\\s{0,40}["'\`]([^"'\`$]+)["'\`]`, "u").exec(args)?.[1];
    const name = plainName(named) ?? plainName(match[2]?.slice(0, 64));
    if (name === undefined) continue;
    const resource: DependencyResource = { kind, name };
    if (kind === "table") {
      const partitionKey = cdkKey(args, "partitionKey", "partition_key");
      const sortKey = cdkKey(args, "sortKey", "sort_key");
      if (partitionKey !== undefined) resource.keySchema = { partitionKey, ...(sortKey === undefined ? {} : { sortKey }) };
    }
    emit(out, path, lineOf(text, match.index), resource);
  }
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
