// A read-only report of project administrator memberships that the N2b loophole may have granted (task AUTH3).
//
//   npx tsx scripts/report-suspect-project-admins.ts --env <name> --profile <aws profile> [--region <region>] [--json]
//
// Before AUTH1, registering a revision of an existing project silently made the registrant a project administrator, and those
// rows are indistinguishable from legitimate ones (an administrator row carries no grantedBy). A legitimate administrator is
// the registrant of the project's lowest revision, or an instance administrator whose takeover left a PROJECT_OWNERSHIP_TAKEOVER
// audit row. This lists every other administrator membership, and every project that has no administrator at all.
//
// It reads the state table with Scan (paginated, consistent) and nothing else; `readOnlyClient` refuses every other command, so a
// write cannot be sent even by mistake. It names no environment by default and prints identifiers only: project names, owner
// keys (hashes), timestamps and revision numbers, never a project definition, runtime binding or takeover reason.
import { pathToFileURL } from "node:url";
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { environmentStackName } from "../packages/contracts/src/environments.js";

const DEFAULT_REGION = "us-east-1";

/** The only commands this script may send: reads. */
export type ReadCommand = ScanCommand | QueryCommand | GetCommand;
export interface ReportClient {
  send(command: ReadCommand): Promise<unknown>;
}

/** Wraps a client so that anything but a read command is refused before it leaves the process. */
export function readOnlyClient(inner: ReportClient): ReportClient {
  return {
    send(command) {
      if (command instanceof ScanCommand || command instanceof QueryCommand || command instanceof GetCommand) return inner.send(command);
      const name = (command as { constructor?: { name?: string } } | undefined)?.constructor?.name ?? typeof command;
      return Promise.reject(new Error(`report-suspect-project-admins is read-only; refusing to send ${name}`));
    },
  };
}

export interface ReportArgs {
  env: string;
  profile: string;
  region: string;
  json: boolean;
}

export function parseReportArgs(argv: readonly string[]): ReportArgs {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (argument === "--json") {
      if (flags.has(argument)) throw new Error(`${argument} was given twice`);
      flags.add(argument);
    } else if (argument === "--env" || argument === "--profile" || argument === "--region") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      if (values.has(argument)) throw new Error(`${argument} was given twice`);
      values.set(argument, value);
      index += 1;
    } else {
      throw new Error(`unknown option ${argument}`);
    }
  }
  const env = values.get("--env");
  if (env === undefined) throw new Error("--env is required (there is no default environment)");
  const profile = values.get("--profile");
  if (profile === undefined) throw new Error("--profile is required (the AWS profile to read with)");
  return { env, profile, region: values.get("--region") ?? DEFAULT_REGION, json: flags.has("--json") };
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

export interface Report {
  suspectAdministrators: SuspectAdministrator[];
  projectsWithoutAdministrator: ProjectWithoutAdministrator[];
  /** Administrators who are not the original registrant but whose membership a takeover audit row explains. */
  explainedByTakeover: Array<{ project: string; subject: string; takenOverAt: string }>;
  /** Administrator memberships of a project that has no revision row at all. */
  administratorsOfUnknownProjects: Array<{ project: string; subject: string }>;
  counts: { projects: number; revisions: number; administrators: number; takeovers: number };
}

type Item = Record<string, unknown>;

/** Every item a Scan returns, following LastEvaluatedKey to the end. */
async function scanAll(client: ReportClient, input: ConstructorParameters<typeof ScanCommand>[0]): Promise<Item[]> {
  const items: Item[] = [];
  let startKey: Record<string, unknown> | undefined;
  for (;;) {
    const page = await client.send(new ScanCommand({ ...input, ConsistentRead: true, ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }) })) as
      { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
    items.push(...(page.Items ?? []));
    const next = page.LastEvaluatedKey;
    if (next === undefined) return items;
    if (startKey !== undefined && JSON.stringify(next) === JSON.stringify(startKey)) throw new Error("a scan did not advance: it returned the key it was given");
    startKey = next;
  }
}

const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

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

export async function collectReport(rawClient: ReportClient, tableName: string): Promise<Report> {
  const client = readOnlyClient(rawClient);
  // One paginated scan reads the three row kinds, so the table is read once: the filter keeps only these entity types and the
  // projection names the identifiers and timestamps used here (no definition, binding or takeover reason is ever requested).
  const items = await scanAll(client, {
    TableName: tableName,
    FilterExpression: "#t IN (:project, :membership, :takeover)",
    ProjectionExpression: "pk, sk, #t, registeredBy, registeredAt, ownerKey, projectName, #role, grantedAt, grantedBy, takenBy, #at",
    ExpressionAttributeNames: { "#t": "entityType", "#role": "role", "#at": "at" },
    ExpressionAttributeValues: { ":project": "PROJECT", ":membership": "MEMBERSHIP", ":takeover": "PROJECT_OWNERSHIP_TAKEOVER" },
  });
  const revisionItems = items.filter((item) => item.entityType === "PROJECT");
  const membershipItems = items.filter((item) => item.entityType === "MEMBERSHIP" && item.role === "administrator");
  const takeoverItems = items.filter((item) => item.entityType === "PROJECT_OWNERSHIP_TAKEOVER");

  const projects = new Map<string, ProjectFacts>();
  let revisionCount = 0;
  for (const item of revisionItems) {
    const pk = str(item.pk);
    const sk = str(item.sk);
    const registeredBy = str(item.registeredBy);
    const match = /^REV#(\d+)$/.exec(sk ?? "");
    if (pk === undefined || !pk.startsWith("PROJECT#") || match === null || registeredBy === undefined) continue;
    const name = pk.slice("PROJECT#".length);
    const facts = projects.get(name) ?? { revisions: [] };
    facts.revisions.push({ revision: Number(match[1]), registeredAt: str(item.registeredAt) ?? "", registeredBy });
    projects.set(name, facts);
    revisionCount += 1;
  }
  for (const facts of projects.values()) facts.revisions.sort((a, b) => a.revision - b.revision);

  // project -> takenBy -> latest audit timestamp
  const takeovers = new Map<string, Map<string, string>>();
  for (const item of takeoverItems) {
    const project = str(item.projectName);
    const takenBy = str(item.takenBy);
    if (project === undefined || takenBy === undefined) continue;
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
  for (const item of membershipItems) {
    const sk = str(item.sk);
    const subject = str(item.ownerKey);
    if (sk === undefined || !sk.startsWith("PROJECT#") || subject === undefined || item.role !== "administrator") continue;
    const project = sk.slice("PROJECT#".length);
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
  for (const [project, facts] of projects) {
    if (administered.has(project)) continue;
    without.push({ project, originalRegistrant: facts.revisions[0]!.registeredBy, latestRevision: facts.revisions[facts.revisions.length - 1]!.revision });
  }

  const byProjectThenSubject = (a: { project: string; subject: string }, b: { project: string; subject: string }) =>
    a.project.localeCompare(b.project) || a.subject.localeCompare(b.subject);
  return {
    suspectAdministrators: suspects.sort(byProjectThenSubject),
    projectsWithoutAdministrator: without.sort((a, b) => a.project.localeCompare(b.project)),
    explainedByTakeover: explained.sort(byProjectThenSubject),
    administratorsOfUnknownProjects: unknown.sort(byProjectThenSubject),
    counts: { projects: projects.size, revisions: revisionCount, administrators, takeovers: takeoverItems.length },
  };
}

function renderTable(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((header, column) => Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length)));
  const line = (cells: string[]) => cells.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd();
  return [line(headers), ...rows.map(line)];
}

export function formatReportTable(report: Report, context: { env: string; region: string }): string {
  const grantedBy = (value: SuspectAdministrator["grantedBy"]) => (value === null ? "-" : typeof value === "string" ? value : `${value.issuer}|${value.subject}`);
  const out: string[] = [
    `Project administrator report for ${context.env} (${context.region}); read-only`,
    `Scanned ${report.counts.projects} projects, ${report.counts.revisions} revisions, ${report.counts.administrators} administrator memberships, ${report.counts.takeovers} takeover audit rows.`,
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

async function stateTableName(args: ReportArgs): Promise<string> {
  const stack = environmentStackName(args.env, "control-plane");
  const cloudFormation = new CloudFormationClient({ region: args.region, profile: args.profile });
  const described = await cloudFormation.send(new DescribeStacksCommand({ StackName: stack }));
  const table = described.Stacks?.[0]?.Outputs?.find((output) => output.OutputKey === "StateTableName")?.OutputValue;
  if (!table) throw new Error(`the stack ${stack} has no StateTableName output`);
  return table;
}

export async function main(argv: readonly string[]): Promise<void> {
  const args = parseReportArgs(argv);
  const table = await stateTableName(args);
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: args.region, profile: args.profile, maxAttempts: 10 }));
  const report = await collectReport(documentClient, table);
  if (args.json) {
    console.log(JSON.stringify({ env: args.env, region: args.region, ...report }, null, 2));
  } else {
    console.log(formatReportTable(report, { env: args.env, region: args.region }));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
