// Seeding Rovara local AWS from the project's own infrastructure code (test services, slice 2, TS22; design test-services.md 3.2 D7 and 5.4). The D7 detector found the tables (with their key schema), buckets and queues the
// project declares; the plan carries them as `awsResources` (contracts/src/test-services-aws-resources.ts, names and attribute types only). Once the emulator is healthy, in every phase that starts one (the working phase and EACH
// sealed round, which has its own emulator), this module turns them into the emulator's seed document and sends it to `POST /_rovara/seed` with the run's control token (emulator-control.ts). The project's own seed commands
// run afterwards, as they do for Postgres.
//
// The seed document is the front's (the fork's `SeedService`): `{ region, s3: { buckets: [{ name }] }, dynamodb: { tables: [{ request: <CreateTable> }] }, sqs: { queues: [{ name, attributes }] },
// sns: { topics: [{ name, subscriptions: [{ protocol, endpoint }] }] }, secretsmanager: { secrets: [{ name, value }] }, ssm: { parameters: [{ name, value, type }] }, kms: { keys: [{ alias, description }] },
// events: { buses: [name], rules: [{ name, bus, pattern | schedule }] } }` (its sections keep the fork's service names, not the table's keys). Every request is built here from fixed words and from names that passed the
// contract's strict forms again; nothing else of the repository is sent. A secret's value is NEVER read from the repository: the value is a placeholder made here for each seed (as is a String parameter's when the template builds it).
//
// Rules this module keeps, each with a test (tests/unit/worker-service-seed-aws.test.ts):
//   - FAIL CLOSED. A resource that does not have its strict form, a duplicate, a region that is not one, a table without its key, an emulator that answers anything but a complete success: the seed fails with ONE fixed sentence
//     (`EmulatorSeedError`) and the run does not continue. The emulator applies a document step by step and reports each, so the answer is checked step by step too: every resource must be there, and there is nothing else.
//   - No secret and no repository string in an error, a log or an argument. The control token is `emulator-control.ts`'s business; the document is a file of the run's directory, not an argument.
//   - A run with no resources sends nothing.
import { constants as fsConstants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { TaskAwsResourcesSchema, awsSeededKinds, type TaskAwsResource } from "@rovara-code/contracts";
import { EmulatorControlError, emulatorControlCall, type EmulatorControlTarget } from "./emulator-control.js";
import { boundedReader, ENV_DETECT_MAX_FILE_BYTES } from "./env-detect/index.js";
import { runDetectorsGuarded, type GuardOptions } from "./env-detect/guarded.js";
import { iacFileIsRead } from "./env-detect/iac-resources.js";
import type { DependencyResource } from "./env-detect/types.js";
import { hiddenWorkspaceDirectories } from "./workspace-state.js";

export type EmulatorSeedFailure = "refused" | "failed" | "stopped";
const SENTENCES: Record<EmulatorSeedFailure, string> = {
  refused: "The project's AWS resources cannot be created in the test services",
  failed: "The test services' AWS resources were not created",
  stopped: "The test services' AWS resources were stopped",
};

/** The one error of the seeding. `message` is a fixed sentence: no resource name, no emulator text. */
export class EmulatorSeedError extends Error {
  /** Why the infrastructure file was refused, in a fixed sentence (`IAC_REFUSAL_NOTES`), when it was. Never a name or a path from the repository. */
  readonly note: string | undefined;
  constructor(readonly reason: EmulatorSeedFailure, note?: IacRefusal) {
    super(SENTENCES[reason]);
    this.name = "EmulatorSeedError";
    this.note = note === undefined ? undefined : IAC_REFUSAL_NOTES[note];
  }
}

/** The ways the plan's infrastructure file is refused as a source of resources, each with one fixed note for the log. */
export const IAC_REFUSAL_NOTES = {
  unsafe_path: "The infrastructure file the plan names is not a plain file inside the project",
  not_read: "The infrastructure file the plan names is not one that setup reads for resources",
  too_large: "The infrastructure file the plan names is too large to read",
  unreadable: "The infrastructure file the plan names could not be read",
  stopped: "Reading the infrastructure file took too long and was stopped",
  noted: "Reading the infrastructure file raised a problem (a file the parser refused, or more resources than are read)",
  none: "The infrastructure file the plan names declares no resources for the services in the plan",
  invalid: "The infrastructure file declares a resource that cannot be created",
} as const;
export type IacRefusal = keyof typeof IAC_REFUSAL_NOTES;

const REGION = /^[a-z]{2}(?:-[a-z]+)+-[0-9]{1,2}$/u;

interface DynamoKey { AttributeName: string; KeyType: "HASH" | "RANGE" }
interface DynamoAttribute { AttributeName: string; AttributeType: "S" | "N" | "B" }
export interface AwsSeedDocument {
  region: string;
  s3?: { buckets: Array<{ name: string }> };
  dynamodb?: { tables: Array<{ request: { TableName: string; KeySchema: DynamoKey[]; AttributeDefinitions: DynamoAttribute[]; BillingMode: "PAY_PER_REQUEST" } }> };
  sqs?: { queues: Array<{ name: string; attributes?: { FifoQueue: "true" } }> };
  sns?: { topics: Array<{ name: string; subscriptions?: Array<{ protocol: "sqs"; endpoint: string }> }> };
  secretsmanager?: { secrets: Array<{ name: string; value: string }> };
  ssm?: { parameters: Array<{ name: string; value: string; type: "String" }> };
  kms?: { keys: Array<{ alias?: string; description?: string }> };
  events?: { buses?: string[]; rules?: Array<{ name: string; bus?: string; pattern?: string; schedule?: string }> };
}

/** The account the emulator names in the ARNs it makes (a queue's URL is `.../000000000000/<name>`), which a subscription's endpoint must use. */
const EMULATOR_ACCOUNT_ID = "000000000000";

/** A made-up value for a secret or a parameter whose value the template does not write: plain letters and digits, fresh for each seed, and nothing the repository wrote. */
export function placeholderSecretValue(): string {
  return `rovara-placeholder-${randomBytes(9).toString("base64url").replace(/[^A-Za-z0-9]/gu, "a")}`;
}

/**
 * The seed document for the resources. Pure apart from the placeholder values (`placeholder`, a fresh one by default). Refuses (`EmulatorSeedError("refused")`) a resource list the contract does not accept, and a region that
 * is not one. A table is on-demand (no capacity to guess), its key schema is the declared one and its attribute definitions are exactly its key attributes; a queue named `*.fifo` is a FIFO queue; a bucket is just created
 * in the region; a topic is subscribed to the declared queues by ARN (a queue the document does not create is refused); a parameter keeps the literal default the template wrote, or gets a placeholder.
 */
export function buildAwsSeedDocument(region: string, resources: readonly TaskAwsResource[], placeholder: () => string = placeholderSecretValue): AwsSeedDocument {
  const parsed = TaskAwsResourcesSchema.safeParse(resources);
  if (!REGION.test(region) || !parsed.success) throw new EmulatorSeedError("refused");
  const document: AwsSeedDocument = { region };
  const buckets = parsed.data.flatMap((resource) => (resource.kind === "bucket" ? [{ name: resource.name }] : []));
  const tables = parsed.data.flatMap((resource) => {
    if (resource.kind !== "table") return [];
    const { partitionKey, sortKey } = resource.keySchema;
    const keys: DynamoKey[] = [{ AttributeName: partitionKey.name, KeyType: "HASH" }, ...(sortKey === undefined ? [] : [{ AttributeName: sortKey.name, KeyType: "RANGE" as const }])];
    const definitions: DynamoAttribute[] = [{ AttributeName: partitionKey.name, AttributeType: partitionKey.type }, ...(sortKey === undefined ? [] : [{ AttributeName: sortKey.name, AttributeType: sortKey.type }])];
    return [{ request: { TableName: resource.name, KeySchema: keys, AttributeDefinitions: definitions, BillingMode: "PAY_PER_REQUEST" as const } }];
  });
  const queues = parsed.data.flatMap((resource) => (resource.kind === "queue" ? [resource.name.endsWith(".fifo") ? { name: resource.name, attributes: { FifoQueue: "true" as const } } : { name: resource.name }] : []));
  const queueNames = new Set(queues.map((queue) => queue.name));
  const topics = parsed.data.flatMap((resource) => {
    if (resource.kind !== "topic") return [];
    const subscriptions = (resource.queues ?? []).map((name) => {
      if (!queueNames.has(name)) throw new EmulatorSeedError("refused");
      return { protocol: "sqs" as const, endpoint: `arn:aws:sqs:${region}:${EMULATOR_ACCOUNT_ID}:${name}` };
    });
    return [{ name: resource.name, ...(subscriptions.length === 0 ? {} : { subscriptions }) }];
  });
  const secrets = parsed.data.flatMap((resource) => (resource.kind === "secret" ? [{ name: resource.name, value: placeholder() }] : []));
  const parameters = parsed.data.flatMap((resource) => (resource.kind === "parameter" ? [{ name: resource.name, value: resource.value ?? placeholder(), type: "String" as const }] : []));
  const keys = parsed.data.flatMap((resource) => (resource.kind === "key" ? [resource.alias === undefined ? { description: resource.name } : { alias: resource.alias, description: resource.name }] : []));
  const buses = parsed.data.flatMap((resource) => (resource.kind === "bus" ? [resource.name] : []));
  const rules = parsed.data.flatMap((resource) => (resource.kind === "rule" ? [{ name: resource.name, ...(resource.bus === undefined ? {} : { bus: resource.bus }), ...(resource.pattern === undefined ? {} : { pattern: resource.pattern }), ...(resource.schedule === undefined ? {} : { schedule: resource.schedule }) }] : []));
  if (buckets.length > 0) document.s3 = { buckets };
  if (tables.length > 0) document.dynamodb = { tables };
  if (queues.length > 0) document.sqs = { queues };
  if (topics.length > 0) document.sns = { topics };
  if (secrets.length > 0) document.secretsmanager = { secrets };
  if (parameters.length > 0) document.ssm = { parameters };
  if (keys.length > 0) document.kms = { keys };
  if (buses.length > 0 || rules.length > 0) document.events = { ...(buses.length > 0 ? { buses } : {}), ...(rules.length > 0 ? { rules } : {}) };
  return document;
}

/** The step the front reports for each kind of resource (`service`, `action`), and the name it reports it under: a key is named by its alias, or by its description (the label) when it has none. */
function stepOf(resource: TaskAwsResource): readonly [string, string, string] {
  switch (resource.kind) {
    case "bucket": return ["s3", "CreateBucket", resource.name];
    case "table": return ["dynamodb", "CreateTable", resource.name];
    case "queue": return ["sqs", "CreateQueue", resource.name];
    case "topic": return ["sns", "CreateTopic", resource.name];
    case "secret": return ["secretsmanager", "CreateSecret", resource.name];
    case "parameter": return ["ssm", "PutParameter", resource.name];
    case "key": return ["kms", "CreateKey", resource.alias ?? resource.name];
    case "bus": return ["events", "CreateEventBus", resource.name];
    case "rule": return ["events", "PutRule", resource.name];
  }
}

/**
 * Checks the emulator's report of the document (`{ ok, failed, steps: [{ service, action, name, ok }] }`) against the resources sent: it must say `ok` with no failure, every step must be `ok`, and each resource must have
 * exactly its step. Anything else (a missing step, an extra one, a step that failed, a shape that is not the report) fails the seed.
 */
export function seedReportCovers(report: unknown, resources: readonly TaskAwsResource[]): boolean {
  if (typeof report !== "object" || report === null) return false;
  const { ok, failed, steps } = report as { ok?: unknown; failed?: unknown; steps?: unknown };
  if (ok !== true || failed !== 0 || !Array.isArray(steps) || steps.length !== resources.length) return false;
  const reported = new Set<string>();
  for (const step of steps as unknown[]) {
    if (typeof step !== "object" || step === null) return false;
    const { service, action, name, ok: stepOk } = step as { service?: unknown; action?: unknown; name?: unknown; ok?: unknown };
    if (stepOk !== true || typeof service !== "string" || typeof action !== "string" || typeof name !== "string") return false;
    reported.add(`${service}\0${action}\0${name}`);
  }
  return resources.every((resource) => reported.has(stepOf(resource).join("\0")));
}

export interface SeedEmulatorInput {
  /** The emulator and the means to talk to it (its control token is in here and nowhere else). */
  target: EmulatorControlTarget;
  region: string;
  /** The plan's `awsResources`. */
  resources: readonly TaskAwsResource[];
}

/**
 * Creates the resources in the running emulator. Call it once per emulator, after it is healthy and before the project's own seed commands. Resolves when every resource is there; throws `EmulatorSeedError` (a fixed
 * sentence) otherwise. A run with no resources makes no call.
 */
export async function seedEmulator(input: SeedEmulatorInput): Promise<void> {
  if (input.resources.length === 0) return;
  const document = buildAwsSeedDocument(input.region, input.resources);
  let answer: string;
  try {
    answer = await emulatorControlCall(input.target, { path: "seed", method: "POST", body: JSON.stringify(document), print: true });
  } catch (error) {
    throw new EmulatorSeedError(error instanceof EmulatorControlError && error.reason !== "too_large" ? error.reason : "failed");
  }
  let report: unknown;
  try { report = JSON.parse(answer); } catch { throw new EmulatorSeedError("failed"); }
  if (!seedReportCovers(report, input.resources)) throw new EmulatorSeedError("failed");
}

// ---- the project's declared resources, read from its infrastructure code (D7)

const IAC_FILE = /\.(?:tf|ya?ml|json|ts|js|py)$/u;
/** The detector reads no file past this (its own per-file cap); a larger pointer is refused rather than half read. */
export const IAC_FILE_MAX_BYTES = ENV_DETECT_MAX_FILE_BYTES;
/** The longest the detector may run over the one file (it runs in a thread that is ended at the limit). */
export const IAC_DETECT_LIMIT_MS = 10_000;

/** A detected resource in the form the contract accepts: the kind's own fields only (a parameter is always a `String`). */
function seedResourceOf(resource: DependencyResource): Record<string, unknown> {
  const { kind, name } = resource;
  switch (kind) {
    case "table": return { kind, name, keySchema: resource.keySchema };
    case "topic": return { kind, name, ...(resource.queues === undefined ? {} : { queues: resource.queues }) };
    case "parameter": return { kind, name, ...(resource.value === undefined ? {} : { value: resource.value }) };
    case "key": return { kind, name, ...(resource.alias === undefined ? {} : { alias: resource.alias }) };
    case "rule": return { kind, name, ...(resource.bus === undefined ? {} : { bus: resource.bus }), ...(resource.pattern === undefined ? {} : { pattern: resource.pattern }), ...(resource.schedule === undefined ? {} : { schedule: resource.schedule }) };
    default: return { kind, name };
  }
}

/**
 * The resources the plan's infrastructure pointer declares, for the services the run serves. `ref.path` is the plan's pointer (the broker never read it): it must resolve, through every link, to a
 * regular file under one of the repositories' own folders, not under a hidden folder of the workspace, with a name the detector reads, small, opened without following a link and the very file that was resolved. It is read
 * as it is NOW (the candidate tree, not the base: the agent may have edited it). The D7 detector's reading is the one the setup used (names and key attributes only); a resource of a service the run does not serve (a service not in `services`, or one that
 * starts empty) is left out, a table the detector found no key for is a refusal (it cannot be created), and the result must pass the contract's strict forms. FAIL CLOSED: the pointer must be a path the
 * detector reads, the file at most 256 KiB, the detector runs in a time-limited thread, ANY note it makes (a template the parser refused, a cut at its resource limit, a stop) refuses, and a file that gives no resource
 * for the plan's services refuses too. Every refusal is `EmulatorSeedError("refused")` with a fixed note (`IAC_REFUSAL_NOTES`).
 */
export async function readAwsResourcesFromIac(input: { ref: { path: string }; services: readonly string[]; rootPath: string; repositoryPaths: readonly string[]; guard?: GuardOptions }): Promise<TaskAwsResource[]> {
  const fail = (note: IacRefusal): never => { throw new EmulatorSeedError("refused", note); };
  // The detector reads a path only if it is one of its patterns and not under a skipped folder: a pointer anywhere else would find nothing, and "nothing" is a refusal, said first and plainly.
  if (!iacFileIsRead(input.ref.path)) return fail("not_read");
  let text: string;
  try {
    const root = await realpath(resolve(input.rootPath));
    const real = await realpath(resolve(root, input.ref.path));
    const within = (path: string, folder: string): boolean => path === folder || path.startsWith(`${folder}${sep}`);
    const repositories = (await Promise.all(input.repositoryPaths.map((path) => realpath(path).catch(() => undefined)))).filter((path): path is string => path !== undefined);
    const hidden = await Promise.all((await hiddenWorkspaceDirectories(root)).map((path) => realpath(path).catch(() => path)));
    if (!IAC_FILE.test(real) || !repositories.some((folder) => real.startsWith(`${folder}${sep}`)) || hidden.some((folder) => within(real, folder))) return fail("unsafe_path");
    const resolved = await stat(real);
    const handle = await open(real, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.dev !== resolved.dev || info.ino !== resolved.ino) return fail("unsafe_path");
      if (info.size > IAC_FILE_MAX_BYTES) return fail("too_large");
      text = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof EmulatorSeedError) throw error;
    return fail("unreadable");
  }
  // The file is the agent's to edit and the detector's patterns are text patterns, so the detector runs in a THREAD with a time limit and its own memory limit (env-detect/guarded.ts), over a reader that holds this one file
  // (256 KiB at most). A thread that was stopped says so in the detection's notes; ANY note is a refusal (a template the parser refused, a cut at the detector's resource limit, a timeout).
  const { reader } = boundedReader([input.ref.path], (path) => Promise.resolve(path === input.ref.path ? text : undefined));
  const detection = await runDetectorsGuarded(reader, ".", { timeoutMs: IAC_DETECT_LIMIT_MS, ...input.guard, only: ["iac-resources"] }).catch(() => undefined);
  if (detection === undefined) return fail("stopped");
  if (detection.notes.length > 0) return fail(detection.notes.some((note) => /took too long/u.test(note)) ? "stopped" : "noted");
  // The kinds the plan's services have a seed handler for (`AWS_SEEDED_KINDS`); a resource of a service the plan does not name is left out, and so is one of a service that starts empty.
  const kinds = new Set<string>(input.services.flatMap((service) => awsSeededKinds(service)));
  const found: unknown[] = [];
  for (const candidate of detection.dependencies ?? []) {
    for (const resource of candidate.hints.resources ?? []) {
      if (!kinds.has(resource.kind)) continue;
      found.push(seedResourceOf(resource));
    }
  }
  // A topic delivers only to queues this seed creates: a queue of a service the plan does not name is not there to subscribe.
  const queueNames = new Set(found.flatMap((item) => ((item as { kind?: unknown }).kind === "queue" ? [(item as { name: string }).name] : [])));
  for (const item of found as Array<{ kind?: unknown; queues?: string[] }>) {
    if (item.kind !== "topic" || item.queues === undefined) continue;
    const kept = item.queues.filter((name) => queueNames.has(name));
    if (kept.length === 0) delete item.queues;
    else item.queues = kept;
  }
  // Nothing found is a refusal too: the plan pointed at this file because setup saw resources in it, so an empty answer means the file moved on or the pointer is wrong, and a run with no resources would only fail later and less clearly.
  if (found.length === 0) return fail("none");
  const parsed = TaskAwsResourcesSchema.safeParse(found);
  return parsed.success ? parsed.data : fail("invalid");
}
