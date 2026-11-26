// A read-only gate for every IAM policy document the infrastructure synthesizes.
//
// Why: IAM refuses some documents only when they are CREATED, never in a template diff, a change set or cfn-lint. The 0.5.51 access deploy rolled back with
// `Resource vendor must be fully qualified and cannot contain regexes` because one Deny statement named its Resource `arn:<partition>:*rovara-<env>-*rel*` (a wildcard in the
// SERVICE field of the ARN). Two checks here find that class before a deploy:
//   1. LOCAL, no AWS: every Resource and NotResource string of every document must have a literal service name (the third ARN component: no `*`, no `?`, no `${...}`), exactly IAM's rule.
//   2. IAM Access Analyzer `validate-policy` (read-only; it only reads the document you send): every document is sent as IDENTITY_POLICY (roles' inline policies, managed policies and
//      permissions boundaries) or RESOURCE_POLICY (role trust documents, and bucket, queue, topic, key and other resource policies); any ERROR or SECURITY_WARNING finding fails,
//      unless scripts/iam-policy-findings-allowlist.json names it (label, issue code and the reason it is accepted).
//
// The documents come from synthesizing the app the way a release does: the deployment that predates environments (with and without its optional stacks), a named environment with every
// feature flag on, and the environment release pipeline. CloudFormation intrinsics are resolved with placeholder values of the right SHAPE (partition aws, a 12-digit account, us-west-2;
// a resource's ARN becomes an ARN of its own service), so the analyzer sees real-looking ARNs.
//
// The AWS command is the caller's, so a guard script can be passed. Nothing here creates, updates or deletes anything. Usage, from the repository root:
//   tsx scripts/validate-iam-policies.ts --local-only
//   tsx scripts/validate-iam-policies.ts --aws "<command>" [--region <region>]          e.g. --aws "~/.local/share/rovara-tools/staging-aws.sh aws" --region us-west-2
//   tsx scripts/validate-iam-policies.ts --aws "<command>" --file <document.json> [--type IDENTITY_POLICY|RESOURCE_POLICY]   (one document, e.g. an old one)
//   add --cloud-templates <cdk.out directory> (repeatable, one per Cloud app) to ALSO check the synthesized Cloud stacks (the same documents checks, plus: every IAM role carries a permissions
//   boundary); add --cloud-only to check just those and skip Code's own synth. The input contract is documented in scripts/iam-cloud-templates.ts.
//   add --dump <directory> to write every extracted document there as JSON.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildAgentXApp } from "../infra/lib/app.js";
import { boundaryProblems, loadCloudStacks, type CloudStack } from "./iam-cloud-templates.js";

/** The analyzer's policy types this gate uses; a role trust document is a RESOURCE_POLICY of resource type AWS::IAM::AssumeRolePolicyDocument. */
export type PolicyKind = "IDENTITY_POLICY" | "RESOURCE_POLICY";
export interface PolicyDocument { label: string; kind: PolicyKind; resourceType?: string; document: unknown }
export interface Finding { findingType: string; issueCode: string; findingDetails: string }
export interface Allowed { label: string; issueCode: string; reason: string }

/** The apps a release can synthesize, as CDK context (the region is a placeholder too: every document names us-west-2). The named one turns every feature flag on, so no role hides behind a flag. */
export const SCAN_CONTEXTS: ReadonlyArray<{ name: string; context: Record<string, unknown> }> = [
  { name: "legacy", context: { agentxRegion: "us-west-2" } },
  { name: "legacy-optional", context: { agentxRegion: "us-west-2", agentxBetaAccess: "enabled", agentxBetaDomain: "enabled", agentxInstaller: "enabled", agentxCiRunner: "enabled", "agentx:autoRequalify": "enabled", "agentx:autoRequalifySchedule": "enabled", "agentx:e2eQualificationTransport": "enabled" } },
  { name: "named", context: { agentxEnv: "staging", agentxRegion: "us-west-2", "agentx:autoRequalify": "enabled", "agentx:autoRequalifySchedule": "enabled", "agentx:e2eQualificationTransport": "enabled", agentxInstaller: "enabled", agentxCiRunner: "enabled" } },
  { name: "release-pipeline", context: { agentxReleasePipeline: "staging", agentxRegion: "us-west-2" } },
];

const PLACEHOLDER = { partition: "aws", account: "111122223333", region: "us-west-2", urlSuffix: "amazonaws.com" };
const SERVICE_OF_TYPE: Record<string, string> = {
  StepFunctions: "states", Cognito: "cognito-idp", ApiGatewayV2: "apigateway", CloudWatch: "cloudwatch", Events: "events", Logs: "logs", SecretsManager: "secretsmanager",
};

type Resources = Record<string, { Type: string; Properties?: Record<string, unknown> }>;
interface Template { Resources?: Resources }
type Json = unknown;
const isObject = (value: Json): value is Record<string, Json> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The part of a resource's ARN after the account field, by service (the default is `<type>/<name>`). */
const ARN_TAIL: Record<string, (kind: string, name: string) => string> = {
  lambda: (_kind, name) => `function:${name}`,
  logs: (_kind, name) => `log-group:${name}`,
  sqs: (_kind, name) => name,
  sns: (_kind, name) => name,
  kms: (_kind, name) => `key/${name}`,
  secretsmanager: (_kind, name) => `secret:${name}-AbCdEf`,
  states: (_kind, name) => `stateMachine:${name}`,
};
/** The resource types whose `Ref` is the ARN (for the others it is a name, an id or a URL). */
const REF_IS_ARN = new Set(["AWS::IAM::ManagedPolicy", "AWS::SecretsManager::Secret", "AWS::SNS::Topic", "AWS::StepFunctions::StateMachine", "AWS::ECS::TaskDefinition"]);

function arnOf(service: string, kind: string, name: string): string {
  if (service === "s3") return `arn:aws:s3:::${name}`;
  const region = service === "iam" ? "" : PLACEHOLDER.region;
  const tail = ARN_TAIL[service]?.(kind, name) ?? `${kind.toLowerCase()}/${name}`;
  return `arn:aws:${service}:${region}:${PLACEHOLDER.account}:${tail}`;
}

/** What `Ref` and `GetAtt` of a resource stand for: an ARN of the resource's own service for an `Arn` attribute (or a `Ref` that is an ARN), else a plain name. */
function resourceToken(resources: Resources, id: string, attribute: string | undefined): string {
  const type = resources[id]?.Type ?? "AWS::Unknown::Thing";
  const [, rawService = "unknown", rawKind = "thing"] = type.split("::");
  const service = SERVICE_OF_TYPE[rawService] ?? rawService.toLowerCase();
  const name = `placeholder${id}`;
  if (attribute !== undefined && !/arn$/iu.test(attribute)) return `${name}${attribute.replace(/\W/gu, "")}`;
  if (attribute === undefined && !REF_IS_ARN.has(type)) return name;
  return arnOf(service, rawKind, name);
}

/** What a template parameter stands for, by its name: an account id, or an ARN of the service the name points at (the default is a topic's: only the shape matters). */
const PARAMETER_SHAPES: ReadonlyArray<[RegExp, (name: string) => string]> = [
  [/AccountId$/u, () => PLACEHOLDER.account],
  [/Secret\w*Arn$/u, (name) => arnOf("secretsmanager", "secret", `placeholder${name}`)],
  [/Key\w*Arn$/u, (name) => arnOf("kms", "key", `placeholder${name}`)],
  [/(Role|Principal)\w*Arn$/u, (name) => arnOf("iam", "role", `placeholder${name}`)],
  [/Bucket\w*Arn$/u, (name) => arnOf("s3", "bucket", `placeholder${name}`)],
  [/ConnectionArn$/u, (name) => arnOf("codestar-connections", "connection", `placeholder${name}`)],
  [/Arn$/u, (name) => arnOf("sns", "topic", `placeholder${name}`)],
];

/** A reference to something that is not a resource of the template: a parameter, shaped by its name, or an unknown name. */
function parameterToken(name: string): string {
  return PARAMETER_SHAPES.find(([pattern]) => pattern.test(name))?.[1](name) ?? `placeholder${name}`;
}

function pseudoParameter(name: string): string | undefined {
  const values: Record<string, string> = {
    "AWS::Partition": PLACEHOLDER.partition, "AWS::AccountId": PLACEHOLDER.account, "AWS::Region": PLACEHOLDER.region, "AWS::URLSuffix": PLACEHOLDER.urlSuffix,
    "AWS::StackName": "placeholder-stack", "AWS::StackId": `arn:aws:cloudformation:${PLACEHOLDER.region}:${PLACEHOLDER.account}:stack/placeholder-stack/11111111-2222-3333-4444-555555555555`,
  };
  return values[name];
}

const NO_VALUE = Symbol("AWS::NoValue");
export interface Context { resources: Resources; unresolved: Set<string> }

function substitute(text: string, variables: Record<string, Json>, context: Context): string {
  return text.replace(/\$\{([^}!][^}]*)\}/gu, (_whole, name: string) => {
    const [head = "", attribute] = name.split(".", 2);
    if (variables[head] !== undefined) return String(resolve(variables[head], context));
    return pseudoParameter(name) ?? (context.resources[head] === undefined ? parameterToken(head) : resourceToken(context.resources, head, attribute));
  });
}

function resolveRef(name: string, context: Context): Json {
  if (name === "AWS::NoValue") return NO_VALUE;
  return pseudoParameter(name) ?? (context.resources[name] === undefined ? parameterToken(name) : resourceToken(context.resources, name, undefined));
}

function resolveGetAtt(value: Json, context: Context): Json {
  const [id, attribute] = typeof value === "string" ? value.split(".", 2) : (value as string[]);
  return resourceToken(context.resources, id ?? "", attribute);
}

function resolveIf(args: Json[], context: Context): Json {
  const [, whenTrue, whenFalse] = args;
  const first = resolve(whenTrue, context);
  return first === NO_VALUE ? resolve(whenFalse, context) : first;
}

function resolveIntrinsic(name: string, argument: Json, context: Context): Json {
  switch (name) {
    case "Ref": return resolveRef(argument as string, context);
    case "Fn::GetAtt": return resolveGetAtt(argument, context);
    case "Fn::Sub": return Array.isArray(argument) ? substitute(argument[0] as string, argument[1] as Record<string, Json>, context) : substitute(argument as string, {}, context);
    case "Fn::Join": { const [separator, parts] = argument as [string, Json]; const items = Array.isArray(parts) ? parts.map((part) => resolve(part, context)) : [resolve(parts, context)].flat(); return items.filter((item) => item !== NO_VALUE).join(separator); }
    case "Fn::If": return resolveIf(argument as Json[], context);
    case "Fn::Select": { const [index, list] = argument as [number | string, Json]; return (resolve(list, context) as Json[])[Number(index)]; }
    case "Fn::Split": { const [separator, text] = argument as [string, Json]; return String(resolve(text, context)).split(separator); }
    case "Fn::ImportValue": case "Fn::FindInMap": case "Fn::Base64": return `placeholder${JSON.stringify(argument).replace(/\W/gu, "").slice(0, 40)}`;
    default: context.unresolved.add(name); return `placeholder${name.replace(/\W/gu, "")}`;
  }
}

/** The elements of a list, each resolved: an `Fn::If` element that yields both branches stays one element (the true branch), and an `AWS::NoValue` element is dropped. */
function resolveList(list: Json[], context: Context): Json[] {
  return list.flatMap((item) => {
    if (isObject(item) && Object.keys(item).length === 1 && "Fn::If" in item) {
      const [, whenTrue, whenFalse] = item["Fn::If"] as Json[];
      return [whenTrue, whenFalse].map((branch) => resolve(branch, context)).filter((branch) => branch !== NO_VALUE);
    }
    const resolved = resolve(item, context);
    return resolved === NO_VALUE ? [] : [resolved];
  });
}

/** A template value with every CloudFormation intrinsic replaced by a placeholder of the right shape. */
export function resolve(value: Json, context: Context): Json {
  if (Array.isArray(value)) return resolveList(value, context);
  if (!isObject(value)) return value;
  const keys = Object.keys(value);
  const intrinsic = keys.length === 1 ? keys[0] : undefined;
  if (intrinsic !== undefined && (intrinsic === "Ref" || intrinsic.startsWith("Fn::"))) return resolveIntrinsic(intrinsic, value[intrinsic], context);
  const out: Record<string, Json> = {};
  for (const key of keys) {
    const resolved = resolve(value[key], context);
    if (resolved !== NO_VALUE) out[key] = resolved;
  }
  return out;
}

const looksLikePolicy = (value: Json): value is Record<string, Json> => isObject(value) && "Statement" in value && ("Version" in value || Array.isArray(value.Statement));

function parsedPolicy(value: Json): Json {
  if (typeof value !== "string" || !value.includes('"Statement"')) return undefined;
  try { return JSON.parse(value) as Json; } catch { return undefined; }
}

/** Every policy document inside a resolved property tree (an object with a Statement, or a string holding one), with the property path it sits at. */
function documentsIn(value: Json, path: string): Array<{ path: string; document: Json }> {
  const asString = parsedPolicy(value);
  if (asString !== undefined && looksLikePolicy(asString)) return [{ path, document: asString }];
  if (looksLikePolicy(value)) return [{ path, document: value }];
  if (Array.isArray(value)) return value.flatMap((item, index) => documentsIn(item, `${path}[${index}]`));
  if (isObject(value)) return Object.entries(value).flatMap(([key, item]) => documentsIn(item, `${path}.${key}`));
  return [];
}

/** The analyzer's policy type, and its resource type where it takes one, for a document found at `path` of a resource of `type`. */
function kindOf(type: string, path: string): { kind: PolicyKind; resourceType?: string } {
  if (type === "AWS::IAM::Role" && path.startsWith("AssumeRolePolicyDocument")) return { kind: "RESOURCE_POLICY", resourceType: "AWS::IAM::AssumeRolePolicyDocument" };
  if (type === "AWS::S3::BucketPolicy") return { kind: "RESOURCE_POLICY", resourceType: "AWS::S3::Bucket" };
  return { kind: type.startsWith("AWS::IAM::") ? "IDENTITY_POLICY" : "RESOURCE_POLICY" };
}

/** Every IAM policy document of one synthesized template: role, user, group, managed and inline policies, boundaries, trust documents and resource policies. */
export function extractPolicyDocuments(stackName: string, template: Template): { documents: PolicyDocument[]; unresolved: string[] } {
  const resources = template.Resources ?? {};
  const context: Context = { resources, unresolved: new Set() };
  const documents: PolicyDocument[] = [];
  for (const [id, resource] of Object.entries(resources)) {
    const properties = resolve(resource.Properties ?? {}, context);
    for (const { path, document } of documentsIn(properties, "")) {
      const clean = path.replace(/^\./u, "");
      documents.push({ label: `${stackName}/${id}/${clean}`, ...kindOf(resource.Type, clean), document });
    }
  }
  return { documents, unresolved: [...context.unresolved] };
}

/** Every synthesized IAM policy document of every app in SCAN_CONTEXTS. Lambda bundling is switched off: the documents do not depend on the bundle. */
export function synthesizePolicyDocuments(contexts = SCAN_CONTEXTS): { documents: PolicyDocument[]; unresolved: string[] } {
  const documents: PolicyDocument[] = [];
  const unresolved = new Set<string>();
  for (const { name, context } of contexts) {
    const app = buildAgentXApp({ "aws:cdk:bundling-stacks": [], ...context });
    for (const stack of app.synth().stacks) {
      const found = extractPolicyDocuments(`${name}:${stack.stackName}`, stack.template as Template);
      documents.push(...found.documents);
      for (const item of found.unresolved) unresolved.add(item);
    }
  }
  return { documents, unresolved: [...unresolved] };
}

const asList = (value: Json): string[] => (value === undefined ? [] : (Array.isArray(value) ? value : [value]).filter((item): item is string => typeof item === "string"));

/** Every Resource and NotResource string of a document. */
export function resourceStrings(document: Json): string[] {
  const statements = isObject(document) ? (Array.isArray(document.Statement) ? document.Statement : [document.Statement]) : [];
  return statements.flatMap((statement) => (isObject(statement) ? [...asList(statement.Resource), ...asList(statement.NotResource)] : []));
}

/**
 * IAM's rule for an ARN in a policy's Resource or NotResource: the service (third component) must be a literal name. A bare `*` as the whole value is fine (all resources), and a string that is not
 * an ARN (it has no `arn:` prefix) is not this rule's business. The partition (second component) may be anything the template can hold, and the region and account may be wildcards.
 */
export function serviceFieldProblem(resource: string): string | undefined {
  if (resource === "*" || !resource.startsWith("arn:")) return undefined;
  const parts = resource.split(":");
  const service = parts[2];
  if (service === undefined || !/^[a-z0-9-]+$/u.test(service)) return `the service field ${JSON.stringify(service ?? "")} of ${resource} is not a literal service name`;
  return undefined;
}

/** `label: problem` for every Resource or NotResource string whose service field is not literal. */
export function serviceFieldProblems(documents: readonly PolicyDocument[]): string[] {
  return documents.flatMap((entry) => resourceStrings(entry.document).flatMap((resource) => {
    const problem = serviceFieldProblem(resource);
    return problem === undefined ? [] : [`${entry.label}: ${problem}`];
  }));
}

export interface AnalyzerOptions { awsCommand: string[]; region?: string }

/** One `aws accessanalyzer validate-policy` call; the caller's command prefix, so a guard script can wrap it. */
export function validatePolicy(entry: PolicyDocument, options: AnalyzerOptions, run: (file: string, args: string[]) => string = (file, args) => execFileSync(file, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, AWS_MAX_ATTEMPTS: "1", AWS_PAGER: "" } })): Finding[] {
  const [file, ...prefix] = options.awsCommand;
  if (file === undefined) throw new Error("--aws needs a command");
  const args = [...prefix, "accessanalyzer", "validate-policy", "--policy-type", entry.kind, "--policy-document", JSON.stringify(entry.document), "--output", "json"];
  if (entry.resourceType !== undefined) args.push("--validate-policy-resource-type", entry.resourceType);
  if (options.region !== undefined) args.push("--region", options.region);
  const output = JSON.parse(run(file, args)) as { findings?: Finding[] };
  return output.findings ?? [];
}

const BLOCKING = new Set(["ERROR", "SECURITY_WARNING"]);
/** Whether a finding fails the gate: an ERROR or SECURITY_WARNING that no allow-list entry (the document's label ends with it, and the issue code) accepts. */
export const isBlocking = (finding: Finding, labels: readonly string[], allowed: readonly Allowed[]): boolean =>
  BLOCKING.has(finding.findingType) && !allowed.some((item) => item.issueCode === finding.issueCode && labels.some((label) => label.endsWith(item.label)));

/** The documents sent to the analyzer once each (identical documents of one kind are one call), with the labels that share them. */
export function uniqueDocuments(documents: readonly PolicyDocument[]): Array<PolicyDocument & { labels: string[] }> {
  const byHash = new Map<string, PolicyDocument & { labels: string[] }>();
  for (const entry of documents) {
    const key = createHash("sha256").update(`${entry.kind}|${entry.resourceType ?? ""}|${JSON.stringify(entry.document)}`).digest("hex");
    const known = byHash.get(key);
    if (known === undefined) byHash.set(key, { ...entry, labels: [entry.label] });
    else known.labels.push(entry.label);
  }
  return [...byHash.values()];
}

interface Options { awsCommand?: string[]; region?: string; localOnly: boolean; cloudTemplates: string[]; cloudOnly: boolean; dump?: string; file?: string; type?: PolicyKind; allowlist: string }

function parseArgs(argv: string[]): Options {
  const options: Options = { localOnly: false, cloudTemplates: [], cloudOnly: false, allowlist: join(import.meta.dirname, "iam-policy-findings-allowlist.json") };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = () => { index += 1; const value = argv[index]; if (value === undefined) throw new Error(`${flag} needs a value`); return value; };
    if (flag === "--local-only") options.localOnly = true;
    else if (flag === "--aws") options.awsCommand = next().replace(/^~/u, homedir()).split(/\s+/u).filter((part) => part !== "");
    else if (flag === "--region") options.region = next();
    else if (flag === "--cloud-templates") options.cloudTemplates.push(next());
    else if (flag === "--cloud-only") options.cloudOnly = true;
    else if (flag === "--dump") options.dump = next();
    else if (flag === "--file") options.file = next();
    else if (flag === "--type") options.type = next() as PolicyKind;
    else if (flag === "--allowlist") options.allowlist = next();
    else throw new Error(`unknown argument ${flag}`);
  }
  return checkedOptions(options);
}

/** The combinations of flags that would silently skip a check are refused. */
function checkedOptions(options: Options): Options {
  if (options.file !== undefined && (options.cloudOnly || options.cloudTemplates.length > 0)) throw new Error("--file checks one document and cannot be combined with --cloud-templates or --cloud-only");
  if (options.cloudOnly && options.cloudTemplates.length === 0) throw new Error("--cloud-only needs at least one --cloud-templates <directory>");
  return options;
}

function readAllowlist(path: string): Allowed[] {
  try { return JSON.parse(readFileSync(path, "utf8")) as Allowed[]; } catch { return []; }
}

function dumpDocuments(directory: string, documents: readonly PolicyDocument[]): void {
  mkdirSync(directory, { recursive: true });
  documents.forEach((entry, index) => writeFileSync(join(directory, `${String(index).padStart(3, "0")}-${entry.label.replace(/[^A-Za-z0-9._-]+/gu, "_").slice(0, 120)}.json`), `${JSON.stringify(entry.document, null, 2)}\n`));
}

function report(entry: PolicyDocument & { labels: string[] }, findings: Finding[], allowed: readonly Allowed[]): number {
  const blocking = findings.filter((finding) => isBlocking(finding, entry.labels, allowed));
  const counts = findings.reduce<Record<string, number>>((all, finding) => ({ ...all, [finding.findingType]: (all[finding.findingType] ?? 0) + 1 }), {});
  console.log(`${blocking.length > 0 ? "FAIL" : "ok  "} ${entry.kind} ${entry.labels.join(" = ")} ${JSON.stringify(counts)}`);
  for (const finding of findings.filter((item) => BLOCKING.has(item.findingType) || item.findingType === "WARNING")) console.log(`      ${finding.findingType} ${finding.issueCode}: ${finding.findingDetails}${blocking.includes(finding) ? "" : " (accepted or not blocking)"}`);
  return blocking.length;
}

/** One document's analyzer run, reported; a call that fails outright (a refusal of the document, a credential problem) counts as a failure. */
function validateOne(entry: PolicyDocument & { labels: string[] }, analyzer: AnalyzerOptions, allowed: readonly Allowed[]): number {
  try {
    return report(entry, validatePolicy(entry, analyzer), allowed);
  } catch (error) {
    console.log(`FAIL ${entry.kind} ${entry.labels.join(" = ")}: the analyzer call failed: ${error instanceof Error ? error.message.split("\n").slice(-3).join(" ") : String(error)}`);
    return 1;
  }
}

/** The documents of the Cloud stacks, labelled `cloud:<stack>/...` (the stacks come from a Cloud build step: scripts/iam-cloud-templates.ts). */
function cloudDocuments(stacks: readonly CloudStack[]): PolicyDocument[] {
  return stacks.flatMap(({ stackName, template }) => extractPolicyDocuments(`cloud:${stackName}`, template).documents);
}

/** The boundary problems of one --cloud-templates directory (each directory must hold a role on its own, so a wrong second directory cannot hide behind a good one). */
function setBoundaryProblems(stacks: readonly CloudStack[], index: number): string[] {
  const named = (problem: string): boolean => stacks.some(({ stackName }) => problem.startsWith(`${stackName}/`));
  return boundaryProblems(stacks).map((problem) => (named(problem) ? problem : `${problem} (--cloud-templates #${index + 1})`));
}

/** The documents to check, with the Cloud stacks that were read: the one `--file`, or every document the synthesized apps produce (announced on stdout) and the Cloud templates' documents. */
function loadDocuments(options: Options): { documents: PolicyDocument[]; cloudSets: CloudStack[][] } {
  if (options.file !== undefined) return { documents: [{ label: options.file, kind: options.type ?? "IDENTITY_POLICY", document: JSON.parse(readFileSync(options.file, "utf8")) as Json }], cloudSets: [] };
  const synthesized = options.cloudOnly ? { documents: [], unresolved: [] } : synthesizePolicyDocuments();
  const cloudSets = options.cloudTemplates.map(loadCloudStacks);
  const cloudStacks = cloudSets.flat();
  const documents = [...synthesized.documents, ...cloudDocuments(cloudStacks)];
  const sources = `${options.cloudOnly ? 0 : SCAN_CONTEXTS.length} synthesized apps${cloudStacks.length > 0 ? ` and ${cloudStacks.length} Cloud stacks` : ""}`;
  console.log(`${documents.length} policy documents from ${sources}${synthesized.unresolved.length > 0 ? `; unresolved intrinsics: ${synthesized.unresolved.join(", ")}` : ""}`);
  return { documents, cloudSets };
}

/** The analyzer pass over every unique document; the number of blocking problems. */
function validateAll(documents: readonly PolicyDocument[], options: Options, allowed: readonly Allowed[]): number {
  if (options.awsCommand === undefined) throw new Error("pass --aws <command> (or --local-only)");
  const analyzer: AnalyzerOptions = { awsCommand: options.awsCommand, ...(options.region === undefined ? {} : { region: options.region }) };
  return uniqueDocuments(documents).reduce((failures, entry) => failures + validateOne(entry, analyzer, allowed), 0);
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const allowed = readAllowlist(options.allowlist);
  const { documents, cloudSets } = loadDocuments(options);
  if (options.dump !== undefined) dumpDocuments(options.dump, documents);
  const local = serviceFieldProblems(documents);
  for (const problem of local) console.log(`FAIL local ${problem}`);
  const boundary = cloudSets.flatMap(setBoundaryProblems);
  for (const problem of boundary) console.log(`FAIL boundary ${problem}`);
  const failures = local.length + boundary.length + (options.localOnly ? 0 : validateAll(documents, options, allowed));
  console.log(failures === 0 ? "IAM policy validation passed" : `IAM policy validation FAILED: ${failures} blocking problem(s)`);
  process.exitCode = failures === 0 ? 0 : 1;
}

if (process.argv[1]?.endsWith("validate-iam-policies.ts")) main();
