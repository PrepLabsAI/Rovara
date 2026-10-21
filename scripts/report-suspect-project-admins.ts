// A read-only report of project administrator memberships that the N2b loophole may have granted (task AUTH3).
//
//   npx tsx scripts/report-suspect-project-admins.ts --profile <aws profile> (--env <name> | --stack <stack> | --table <table>)
//     [--region <region>] [--pause-ms <ms>] [--json]
//
// Before AUTH1, registering a revision of an existing project silently made the registrant a project administrator, and those
// rows are indistinguishable from legitimate ones (an administrator row carries no grantedBy). A legitimate administrator is
// the registrant of the project's lowest revision, or an instance administrator whose takeover left a PROJECT_OWNERSHIP_TAKEOVER
// audit row. This lists every other administrator membership, and every project that has no administrator at all.
//
// Exactly one of --env, --stack or --table decides the table: --env reads StateTableName from the stack agentx-<env>-control-plane,
// --stack reads it from the named stack (production's legacy control-plane stack is AgentXControlPlane), --table names the table
// and skips the stack lookup. There is no default.
//
// It reads the state table with Scan and nothing else; `readOnlyClient` refuses every other command, so a write cannot be sent
// even by mistake. The only other call is CloudFormation DescribeStacks, for the table name. It prints identifiers only: project
// names, owner keys (hashes), timestamps and revision numbers, never a project definition, runtime binding or takeover reason.
//
// The scan paces itself so it does not compete with the live broker for table throughput: 400 items a page, a pause between
// pages (--pause-ms, default 200), progress on stderr, and an abort after 5 throttled pages in a row.
import { pathToFileURL } from "node:url";
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { environmentStackName } from "../packages/contracts/src/environments.js";

const DEFAULT_REGION = "us-east-1";
const DEFAULT_PAUSE_MS = 200;
const PAGE_LIMIT = 400;
const MAX_CONSECUTIVE_THROTTLES = 5;
/** The SDK retries a throttled call this many times in all before it throws; the script then waits and counts the page as throttled. */
const SDK_MAX_ATTEMPTS = 3;
const THROTTLE_ERRORS = new Set(["ProvisionedThroughputExceededException", "ThrottlingException", "RequestLimitExceeded", "ThrottledException"]);

/** The only command this script sends to the table. */
export type ReadCommand = ScanCommand;
export interface ReportClient {
  send(command: ReadCommand): Promise<unknown>;
}

/** Wraps a client so that anything but a Scan is refused before it leaves the process. */
export function readOnlyClient(inner: ReportClient): ReportClient {
  return {
    send(command) {
      if (command instanceof ScanCommand) return inner.send(command);
      const name = (command as { constructor?: { name?: string } } | undefined)?.constructor?.name ?? typeof command;
      return Promise.reject(new Error(`report-suspect-project-admins is read-only; refusing to send ${name}`));
    },
  };
}

export type TableTarget = { kind: "env" | "stack" | "table"; name: string };

export interface ReportArgs {
  target: TableTarget;
  profile: string;
  region: string;
  json: boolean;
  pauseMs: number;
}

export function parseReportArgs(argv: readonly string[]): ReportArgs {
  const values = new Map<string, string>();
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (argument === "--json") {
      if (json) throw new Error(`${argument} was given twice`);
      json = true;
    } else if (["--env", "--stack", "--table", "--profile", "--region", "--pause-ms"].includes(argument)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      if (values.has(argument)) throw new Error(`${argument} was given twice`);
      values.set(argument, value);
      index += 1;
    } else {
      throw new Error(`unknown option ${argument}`);
    }
  }
  const targets = (["env", "stack", "table"] as const).filter((kind) => values.has(`--${kind}`));
  if (targets.length !== 1) throw new Error("give exactly one of --env, --stack or --table (there is no default environment)");
  const kind = targets[0]!;
  const name = values.get(`--${kind}`)!;
  if (kind === "stack" && !/^[A-Za-z][A-Za-z0-9-]{0,127}$/.test(name)) throw new Error(`--stack ${JSON.stringify(name)} is not a CloudFormation stack name`);
  if (kind === "table" && !/^[A-Za-z0-9_.-]{3,255}$/.test(name)) throw new Error(`--table ${JSON.stringify(name)} is not a DynamoDB table name`);
  const profile = values.get("--profile");
  if (profile === undefined) throw new Error("--profile is required (the AWS profile to read with)");
  const pause = values.get("--pause-ms");
  if (pause !== undefined && !/^\d{1,6}$/.test(pause)) throw new Error("--pause-ms must be a non-negative whole number of milliseconds");
  return { target: { kind, name }, profile, region: values.get("--region") ?? DEFAULT_REGION, json, pauseMs: pause === undefined ? DEFAULT_PAUSE_MS : Number(pause) };
}

export interface RegisteredRevision {
  revision: number;
  registeredAt: string;
}

export interface GrantedBy {
  issuer: string;
  subject: string;
}

export interface SuspectAdministrator {
  project: string;
  /** The membership's owner key: the SHA-256 the broker derives from issuer and subject. */
  subject: string;
  grantedAt: string | null;
  grantedBy: string | GrantedBy | null;
  /** The revisions this subject registered, lowest first. */
  revisionsRegistered: RegisteredRevision[];
  /** The owner key that registered the project's lowest revision. */
  originalRegistrant: string;
}

export interface ProjectWithoutAdministrator {
  project: string;
  originalRegistrant: string;
  latestRevision: number;
}

/** A project whose lowest revision was not the first one registered: the "original registrant" may then be someone who came later. */
export interface OrderingAnomaly {
  project: string;
  lowestRevision: number;
  lowestRevisionRegisteredAt: string;
  lowestRevisionRegistrant: string;
  earliestRevision: number;
  earliestRegisteredAt: string;
  earliestRegistrant: string;
}

export interface Report {
  suspectAdministrators: SuspectAdministrator[];
  projectsWithoutAdministrator: ProjectWithoutAdministrator[];
  /** Administrators who are not the original registrant but whose membership a takeover audit row explains. */
  explainedByTakeover: Array<{ project: string; subject: string; takenOverAt: string }>;
  /** Administrator memberships of a project that has no revision row at all. */
  administratorsOfUnknownProjects: Array<{ project: string; subject: string }>;
  orderingAnomalies: OrderingAnomaly[];
  /** Rows of the three kinds that lacked a field the report needs even after falling back to the key. */
  skippedRows: { revisions: number; memberships: number; takeovers: number };
  counts: { projects: number; revisions: number; administrators: number; takeovers: number };
  notes: string[];
}

const SNAPSHOT_NOTE = "A scan is not a snapshot: a registration landing mid-scan can briefly show an administrator of an unknown project or a project without an administrator. Re-run to confirm those two lists before acting on them.";

type Item = Record<string, unknown>;

export interface CollectOptions {
  /** Pause between pages in milliseconds. Defaults to 0 here; the command line defaults to 200. */
  pauseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  progress?: (pages: number, items: number) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

function isThrottle(error: unknown): boolean {
  return error instanceof Error && THROTTLE_ERRORS.has(error.name);
}

/** Every item a Scan returns, following LastEvaluatedKey to the end, one page of 400 at a time. */
async function scanAll(client: ReportClient, input: ConstructorParameters<typeof ScanCommand>[0], options: CollectOptions): Promise<Item[]> {
  const sleep = options.sleep ?? defaultSleep;
  const pauseMs = options.pauseMs ?? 0;
  const items: Item[] = [];
  let startKey: Record<string, unknown> | undefined;
  let pages = 0;
  let throttled = 0;
  for (;;) {
    let page: { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
    try {
      page = await client.send(new ScanCommand({ ...input, Limit: PAGE_LIMIT, ConsistentRead: true, ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }) })) as typeof page;
    } catch (error) {
      if (!isThrottle(error)) throw error;
      throttled += 1;
      if (throttled >= MAX_CONSECUTIVE_THROTTLES) {
        throw new Error(`DynamoDB throttled ${MAX_CONSECUTIVE_THROTTLES} times in a row at page ${pages + 1}; aborting so the scan does not compete with the live broker. Nothing was written. Re-run later or with a larger --pause-ms.`, { cause: error });
      }
      await sleep(Math.max(pauseMs, 500) * throttled);
      continue;
    }
    throttled = 0;
    pages += 1;
    items.push(...(page.Items ?? []));
    options.progress?.(pages, items.length);
    const next = page.LastEvaluatedKey;
    if (next === undefined) return items;
    if (startKey !== undefined && JSON.stringify(next) === JSON.stringify(startKey)) throw new Error("a scan did not advance: it returned the key it was given");
    startKey = next;
    if (pauseMs > 0) await sleep(pauseMs);
  }
}

const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

/** `<prefix>X` in `key` gives X. */
function afterPrefix(key: unknown, prefix: string): string | undefined {
  const text = str(key);
  return text !== undefined && text.startsWith(prefix) && text.length > prefix.length ? text.slice(prefix.length) : undefined;
}

function grantedByOf(value: unknown): string | GrantedBy | null {
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object") {
    const { issuer, subject } = value as { issuer?: unknown; subject?: unknown };
    if (typeof issuer === "string" && typeof subject === "string") return { issuer, subject };
  }
  return null;
}

interface ProjectFacts {
  revisions: Array<RegisteredRevision & { registeredBy: string }>;
}

export async function collectReport(rawClient: ReportClient, tableName: string, options: CollectOptions = {}): Promise<Report> {
  const client = readOnlyClient(rawClient);
  // One paginated scan reads the three row kinds, so the table is read once: the filter keeps only these entity types and the
  // projection names the identifiers and timestamps used here (no definition, binding or takeover reason is ever requested).
  const items = await scanAll(client, {
    TableName: tableName,
    FilterExpression: "#t IN (:project, :membership, :takeover)",
    ProjectionExpression: "pk, sk, #t, registeredBy, registeredAt, ownerKey, projectName, #role, grantedAt, grantedBy, takenBy, #at",
    ExpressionAttributeNames: { "#t": "entityType", "#role": "role", "#at": "at" },
    ExpressionAttributeValues: { ":project": "PROJECT", ":membership": "MEMBERSHIP", ":takeover": "PROJECT_OWNERSHIP_TAKEOVER" },
  }, options);
  const skipped = { revisions: 0, memberships: 0, takeovers: 0 };

  const projects = new Map<string, ProjectFacts>();
  let revisionCount = 0;
  for (const item of items.filter((candidate) => candidate.entityType === "PROJECT")) {
    const name = afterPrefix(item.pk, "PROJECT#");
    const match = /^REV#(\d+)$/.exec(str(item.sk) ?? "");
    const registeredBy = str(item.registeredBy);
    if (name === undefined || match === null || registeredBy === undefined) {
      skipped.revisions += 1;
      continue;
    }
    const facts = projects.get(name) ?? { revisions: [] };
    facts.revisions.push({ revision: Number(match[1]), registeredAt: str(item.registeredAt) ?? "", registeredBy });
    projects.set(name, facts);
    revisionCount += 1;
  }
  for (const facts of projects.values()) facts.revisions.sort((a, b) => a.revision - b.revision);

  // project -> takenBy -> latest audit timestamp
  const takeovers = new Map<string, Map<string, string>>();
  const takeoverItems = items.filter((candidate) => candidate.entityType === "PROJECT_OWNERSHIP_TAKEOVER");
  for (const item of takeoverItems) {
    const project = str(item.projectName) ?? afterPrefix(item.pk, "PROJECT_TAKEOVER#");
    const takenBy = str(item.takenBy);
    if (project === undefined || takenBy === undefined) {
      skipped.takeovers += 1;
      continue;
    }
    const byOwner = takeovers.get(project) ?? new Map<string, string>();
    const at = str(item.at) ?? "";
    if ((byOwner.get(takenBy) ?? "") <= at) byOwner.set(takenBy, at);
    takeovers.set(project, byOwner);
  }

  const suspects: SuspectAdministrator[] = [];
  const explained: Report["explainedByTakeover"] = [];
  const unknown: Report["administratorsOfUnknownProjects"] = [];
  const administered = new Set<string>();
  let administrators = 0;
  for (const item of items.filter((candidate) => candidate.entityType === "MEMBERSHIP" && candidate.role === "administrator")) {
    const project = afterPrefix(item.sk, "PROJECT#");
    const subject = str(item.ownerKey) ?? afterPrefix(item.pk, "MEMBER#");
    if (project === undefined || subject === undefined) {
      skipped.memberships += 1;
      continue;
    }
    administrators += 1;
    administered.add(project);
    const facts = projects.get(project);
    if (facts === undefined || facts.revisions[0] === undefined) {
      unknown.push({ project, subject });
      continue;
    }
    const originalRegistrant = facts.revisions[0].registeredBy;
    if (subject === originalRegistrant) continue;
    const takenOverAt = takeovers.get(project)?.get(subject);
    if (takenOverAt !== undefined) {
      explained.push({ project, subject, takenOverAt });
      continue;
    }
    suspects.push({
      project,
      subject,
      grantedAt: str(item.grantedAt) ?? null,
      grantedBy: grantedByOf(item.grantedBy),
      revisionsRegistered: facts.revisions.filter((revision) => revision.registeredBy === subject).map(({ revision, registeredAt }) => ({ revision, registeredAt })),
      originalRegistrant,
    });
  }

  const without: ProjectWithoutAdministrator[] = [];
  const anomalies: OrderingAnomaly[] = [];
  for (const [project, facts] of projects) {
    if (!administered.has(project)) {
      without.push({ project, originalRegistrant: facts.revisions[0]!.registeredBy, latestRevision: facts.revisions[facts.revisions.length - 1]!.revision });
    }
    // The lowest revision should also be the first registered. If a later registration stored a lower number, it is "original" only by number.
    const lowest = facts.revisions[0]!;
    const dated = facts.revisions.filter((revision) => revision.registeredAt !== "");
    const earliest = dated.reduce<(typeof dated)[number] | undefined>((best, revision) => (best === undefined || revision.registeredAt < best.registeredAt ? revision : best), undefined);
    if (lowest.registeredAt !== "" && earliest !== undefined && earliest.registeredAt < lowest.registeredAt) {
      anomalies.push({
        project, lowestRevision: lowest.revision, lowestRevisionRegisteredAt: lowest.registeredAt, lowestRevisionRegistrant: lowest.registeredBy,
        earliestRevision: earliest.revision, earliestRegisteredAt: earliest.registeredAt, earliestRegistrant: earliest.registeredBy,
      });
    }
  }

  const byProjectThenSubject = (a: { project: string; subject: string }, b: { project: string; subject: string }) =>
    a.project.localeCompare(b.project) || a.subject.localeCompare(b.subject);
  return {
    suspectAdministrators: suspects.sort(byProjectThenSubject),
    projectsWithoutAdministrator: without.sort((a, b) => a.project.localeCompare(b.project)),
    explainedByTakeover: explained.sort(byProjectThenSubject),
    administratorsOfUnknownProjects: unknown.sort(byProjectThenSubject),
    orderingAnomalies: anomalies.sort((a, b) => a.project.localeCompare(b.project)),
    skippedRows: skipped,
    counts: { projects: projects.size, revisions: revisionCount, administrators, takeovers: takeoverItems.length },
    notes: [SNAPSHOT_NOTE],
  };
}

function renderTable(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((header, column) => Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length)));
  const line = (cells: string[]) => cells.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd();
  return [line(headers), ...rows.map(line)];
}

export function formatReportTable(report: Report, context: { label: string; region: string }): string {
  const grantedBy = (value: SuspectAdministrator["grantedBy"]) => (value === null ? "-" : typeof value === "string" ? value : `${value.issuer}|${value.subject}`);
  const skippedTotal = report.skippedRows.revisions + report.skippedRows.memberships + report.skippedRows.takeovers;
  const out: string[] = [
    `Project administrator report for ${context.label} (${context.region}); read-only`,
    `Scanned ${report.counts.projects} projects, ${report.counts.revisions} revisions, ${report.counts.administrators} administrator memberships, ${report.counts.takeovers} takeover audit rows.`,
    `Skipped malformed rows: ${skippedTotal} (revisions ${report.skippedRows.revisions}, memberships ${report.skippedRows.memberships}, takeovers ${report.skippedRows.takeovers})`,
    ...report.notes.map((note) => `Note: ${note}`),
    "",
    `Suspect administrators: ${report.suspectAdministrators.length}`,
  ];
  if (report.suspectAdministrators.length > 0) {
    out.push(...renderTable(["PROJECT", "SUBJECT", "GRANTED_AT", "GRANTED_BY", "REVISIONS_REGISTERED", "ORIGINAL_REGISTRANT"], report.suspectAdministrators.map((suspect) => [
      suspect.project, suspect.subject, suspect.grantedAt ?? "-", grantedBy(suspect.grantedBy),
      suspect.revisionsRegistered.length === 0 ? "-" : suspect.revisionsRegistered.map((revision) => `${revision.revision}@${revision.registeredAt}`).join(","),
      suspect.originalRegistrant,
    ])));
  }
  out.push("", `Projects without an administrator: ${report.projectsWithoutAdministrator.length}`);
  if (report.projectsWithoutAdministrator.length > 0) {
    out.push(...renderTable(["PROJECT", "ORIGINAL_REGISTRANT", "LATEST_REVISION"], report.projectsWithoutAdministrator.map((entry) => [entry.project, entry.originalRegistrant, String(entry.latestRevision)])));
  }
  out.push("", `Ordering anomalies: ${report.orderingAnomalies.length} (the lowest revision is not the earliest registered; check by hand who the original registrant was)`);
  if (report.orderingAnomalies.length > 0) {
    out.push(...renderTable(["PROJECT", "LOWEST_REV", "LOWEST_REGISTERED_AT", "LOWEST_REGISTRANT", "EARLIEST_REV", "EARLIEST_REGISTERED_AT", "EARLIEST_REGISTRANT"], report.orderingAnomalies.map((entry) => [
      entry.project, String(entry.lowestRevision), entry.lowestRevisionRegisteredAt, entry.lowestRevisionRegistrant,
      String(entry.earliestRevision), entry.earliestRegisteredAt, entry.earliestRegistrant,
    ])));
  }
  out.push("", `Administrators explained by a takeover audit row: ${report.explainedByTakeover.length}`);
  if (report.explainedByTakeover.length > 0) {
    out.push(...renderTable(["PROJECT", "SUBJECT", "TAKEN_OVER_AT"], report.explainedByTakeover.map((entry) => [entry.project, entry.subject, entry.takenOverAt])));
  }
  out.push("", `Administrators of a project with no revision row: ${report.administratorsOfUnknownProjects.length}`);
  if (report.administratorsOfUnknownProjects.length > 0) {
    out.push(...renderTable(["PROJECT", "SUBJECT"], report.administratorsOfUnknownProjects.map((entry) => [entry.project, entry.subject])));
  }
  return out.join("\n");
}

export interface ClientConfig {
  region: string;
  profile: string;
  maxAttempts: number;
}

/** What `main` reaches the outside world through; the tests pass fakes. */
export interface MainDependencies {
  createCloudFormation(config: ClientConfig): { send(command: DescribeStacksCommand): Promise<{ Stacks?: Array<{ Outputs?: Array<{ OutputKey?: string | undefined; OutputValue?: string | undefined }> | undefined }> | undefined }> };
  createDocumentClient(config: ClientConfig): ReportClient;
  out(text: string): void;
  err(text: string): void;
  sleep(ms: number): Promise<void>;
}

const realDependencies: MainDependencies = {
  createCloudFormation: (config) => {
    const client = new CloudFormationClient(config);
    return { send: (command) => client.send(command) };
  },
  createDocumentClient: (config) => {
    const client = DynamoDBDocumentClient.from(new DynamoDBClient(config));
    return { send: (command) => client.send(command) };
  },
  out: (text) => console.log(text),
  err: (text) => console.error(text),
  sleep: defaultSleep,
};

async function resolveTable(args: ReportArgs, config: ClientConfig, dependencies: MainDependencies): Promise<string> {
  if (args.target.kind === "table") return args.target.name;
  const stack = args.target.kind === "env" ? environmentStackName(args.target.name, "control-plane") : args.target.name;
  const described = await dependencies.createCloudFormation(config).send(new DescribeStacksCommand({ StackName: stack }));
  const table = described.Stacks?.[0]?.Outputs?.find((output) => output.OutputKey === "StateTableName")?.OutputValue;
  if (!table) throw new Error(`the stack ${stack} has no StateTableName output`);
  return table;
}

export async function main(argv: readonly string[], dependencies: MainDependencies = realDependencies): Promise<void> {
  const args = parseReportArgs(argv);
  const config: ClientConfig = { region: args.region, profile: args.profile, maxAttempts: SDK_MAX_ATTEMPTS };
  const table = await resolveTable(args, config, dependencies);
  const client = dependencies.createDocumentClient(config);
  const report = await collectReport(client, table, {
    pauseMs: args.pauseMs,
    sleep: (ms) => dependencies.sleep(ms),
    progress: (pages, items) => dependencies.err(`scan page ${pages}: ${items} items so far`),
  });
  if (args.json) {
    dependencies.out(JSON.stringify({ target: args.target, region: args.region, ...report }, null, 2));
  } else {
    dependencies.out(formatReportTable(report, { label: `${args.target.kind} ${args.target.name}`, region: args.region }));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
