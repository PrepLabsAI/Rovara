// R4: membership is an internal, replaceable person -> company read. T3 writes the
// sign-in-table membership. A token's company is never membership.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import type { DeveloperTaskActions } from "./developer-task-actions.js";
import { AgentXError, agentXError, IMPLICIT_COMPANY_ID, OrgIdSchema, OrgRoleSchema, type DocumentStore, type OrgRole } from "@agentx/contracts";

export interface CompanyMembershipReader { companyOf(personId: string): Promise<string | undefined>; membershipOf?(personId: string): Promise<{ companyId: string; role: OrgRole } | undefined> }
const SIGN_IN_AGAIN = "your AgentX sign-in has ended; run agentx login <url> again";
export const Membership = z.object({
  entityType: z.literal("COMPANY_MEMBERSHIP"), personId: z.string(), companyId: OrgIdSchema,
  role: OrgRoleSchema, joinedAt: z.iso.datetime(),
  // DEC 253z: "self-serve" is the first owner of a company they made with an invite code. DEC 254b (b): "import" was copied from the install's old
  // company layout by an operator (company-import.ts). Older rows still read.
  joinedVia: z.enum(["preapproval", "legacy", "self-serve", "import"]).optional(),
  revokedAt: z.iso.datetime().optional(), revokedBy: z.string().min(1).max(256).optional(),
});
export const membershipKey = (personId: string) => ({ pk: `COMPANY_MEMBER#${personId}`, sk: "COMPANY" });

function membershipReader(read: (personId: string) => Promise<unknown>): CompanyMembershipReader {
  // Lane W: `membershipOf` adds the live role (for "a company administrator may change it"); `companyOf` answers exactly as before.
  const membershipOf = async (personId: string) => {
    if (typeof personId !== "string" || personId.length === 0 || personId.length > 256 || /[#\s]/.test(personId)) return undefined;
    try {
      const parsed = Membership.safeParse(await read(personId));
      return parsed.success && parsed.data.personId === personId && parsed.data.revokedAt === undefined ? { companyId: parsed.data.companyId, role: parsed.data.role } : undefined;
    } catch { throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN); }
  };
  return { membershipOf, async companyOf(personId) { return (await membershipOf(personId))?.companyId; } };
}

export function companyMembershipFromStore(store: Pick<DocumentStore, "get">): CompanyMembershipReader {
  return membershipReader((personId) => store.get(membershipKey(personId)));
}

export function companyMembershipFromDynamo(client: { send(command: unknown): Promise<unknown> }, tableName: string): CompanyMembershipReader {
  return membershipReader(async (personId) => {
    const response = await client.send(new GetCommand({ TableName: tableName, Key: membershipKey(personId), ConsistentRead: true })) as { Item?: unknown };
    return response?.Item;
  });
}

/** Only an absent dependency disables the check; every supplied reader fails closed. */
export async function resolveCompany(reader: CompanyMembershipReader | undefined, personId: string): Promise<string | undefined> {
  if (reader === undefined) return undefined;
  try {
    const company = OrgIdSchema.safeParse(await reader.companyOf(personId));
    if (company.success) return company.data;
  } catch { /* No reader cause belongs in a caller's response. */ }
  throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
}

/** P0-14: an administrator's sign-in that is in no company of Code's (an install operator usually is in none). Not "your sign-in has ended": signing in again cannot change it. */
export const ADMIN_NOT_IN_A_COMPANY = "this admin sign-in is not a member of a company in Code's company records, so it cannot act on one company's records; sign in as an administrator of that company";

/**
 * P0-14: as resolveCompany, for an administrator's own company: a reader that fails still refuses with the fixed sign-in words (fail closed), but a clean answer of no company
 * (or a malformed one) is `refusal()` (default FORBIDDEN ADMIN_NOT_IN_A_COMPANY), which tells the administrator what is wrong instead of looping on "login" again. Never looser:
 * every path that resolveCompany refused still refuses.
 */
export async function resolveAdminCompany(reader: CompanyMembershipReader | undefined, personId: string, refusal: () => AgentXError = () => agentXError("FORBIDDEN", ADMIN_NOT_IN_A_COMPANY)): Promise<string | undefined> {
  if (reader === undefined) return undefined;
  let value: unknown;
  try { value = await reader.companyOf(personId); } catch { throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN); }
  const company = OrgIdSchema.safeParse(value);
  if (company.success) return company.data;
  throw refusal();
}

/** Old rows belong to the fixed company, never whichever company is asking today. */
export function recordInCompany(record: unknown, companyId: string | undefined): boolean {
  if (companyId === undefined) return true;
  if (record === null || typeof record !== "object") return false;
  const value = (record as { companyId?: unknown }).companyId;
  const company = OrgIdSchema.safeParse(value === undefined ? IMPLICIT_COMPANY_ID : value);
  return company.success && company.data === companyId;
}

function taskProjectCompany(task: { companyId?: unknown }): string {
  const company = OrgIdSchema.safeParse(task.companyId);
  if (!company.success) throw agentXError("FORBIDDEN", "Slack channel is not bound to a project");
  return company.data;
}

/** A task's legacy project read must match the task's persisted, valid company, never a same-name row from another layout. */
export function assertTaskProjectCompany(task: { companyId?: unknown }, projectRow: unknown): void {
  if (!recordInCompany(projectRow, taskProjectCompany(task))) {
    throw agentXError("FORBIDDEN", "Slack channel is not bound to a project");
  }
}

/** Read one legacy revision for a persisted task. Missing rows retain the reader's existing handling; present rows must belong to the task before use. */
export async function readTaskLegacyProject<T>(task: { companyId?: unknown }, read: () => Promise<T>): Promise<T> {
  taskProjectCompany(task); // Invalid or absent scope must refuse before model/integration reads.
  const project = await read();
  if (project !== undefined) assertTaskProjectCompany(task, project);
  return project;
}

/** A row in a company's own partition: the partition key (`ORG#<company>#...`) already names its company, so the row may leave `companyId`/`orgId` out (Code's own writers and the
 * switch-over move do). A row that names a company must name THIS one: a present, different (or malformed) owner is drift, never this company's data. */
export function ownPartitionRow(row: Record<string, unknown>, companyId: string): boolean {
  return (!Object.hasOwn(row, "companyId") || row["companyId"] === companyId) && (!Object.hasOwn(row, "orgId") || row["orgId"] === companyId);
}

export const COMPANY_READ_LIMITS = { commands: 512, items: 2_000, bytes: 8_000_000, files: 64, milliseconds: 10_000 } as const;

/** Internal pagination signal; other read routes retain the fixed refusal. */
export class CompanyReadItemLimit extends AgentXError {
  constructor() { super("CONFIG_INVALID", "company read limit exceeded", 400); }
}

/** One budget for checked SDK reads and task-action results. The host owns the I/O
 * timeout; elapsed time is checked before/after awaits, with no detached timeout race. */
export function boundedCompanyReads(client: { send(command: unknown): Promise<unknown> }, clock: () => number = Date.now) {
  const started = clock();
  let commands = 0; let items = 0; let bytes = 0; let files = 0;
  let itemLimitReached = false;
  const check = (itemContinuation = false) => {
    if (itemLimitReached && !itemContinuation) throw new CompanyReadItemLimit();
    if (commands > COMPANY_READ_LIMITS.commands || items > COMPANY_READ_LIMITS.items || bytes > COMPANY_READ_LIMITS.bytes || files > COMPANY_READ_LIMITS.files || clock() - started > COMPANY_READ_LIMITS.milliseconds) {
      throw agentXError("CONFIG_INVALID", "company read limit exceeded");
    }
  };
  const run = async <T>(work: () => Promise<T>, count: (result: T) => number, readFiles = 0): Promise<T> => {
    if (itemLimitReached) throw new CompanyReadItemLimit();
    commands++; files += readFiles; check();
    const result = await work();
    bytes += Buffer.byteLength(JSON.stringify(result) ?? "", "utf8");
    check();
    // Admit a whole result or none of it. Lists resume before the unfinished task;
    // the rejected read still counts toward the command, byte and time bounds.
    const nextItems = items + count(result);
    if (nextItems > COMPANY_READ_LIMITS.items) { itemLimitReached = true; throw new CompanyReadItemLimit(); }
    items = nextItems;
    return result;
  };
  return { check,
    read: <T>(work: () => Promise<T>, readFiles = 0) => run(work, (result) => Array.isArray(result) ? result.length : result === undefined ? 0 : 1, readFiles),
    client: { send: (command: unknown): Promise<unknown> => run(() => client.send(command), (result) => {
      const response = result as { Item?: unknown; Items?: unknown[] } | undefined;
      return (response?.Item === undefined ? 0 : 1) + (Array.isArray(response?.Items) ? response.Items.length : 0);
    }) },
  };
}

/** Cache only within one checked call: two tasks sharing a workspace share its reads. */
export function companyReadActions(actions: DeveloperTaskActions, scope: ReturnType<typeof boundedCompanyReads>): DeveloperTaskActions {
  const memo = <A extends unknown[], T>(work: (...args: A) => Promise<T>, files = 0) => {
    const cache = new Map<string, Promise<T>>();
    return (...args: A): Promise<T> => {
      const key = JSON.stringify(args);
      const prior = cache.get(key);
      if (prior !== undefined) return prior;
      const result = scope.read(() => work(...args), files);
      cache.set(key, result); return result;
    };
  };
  return { ...actions,
    workspace: memo((...args: Parameters<DeveloperTaskActions["workspace"]>) => actions.workspace(...args)),
    operations: memo((...args: Parameters<DeveloperTaskActions["operations"]>) => actions.operations(...args)),
    projectRevision: memo((...args: Parameters<DeveloperTaskActions["projectRevision"]>) => actions.projectRevision(...args)),
    pullRequests: memo((...args: Parameters<DeveloperTaskActions["pullRequests"]>) => actions.pullRequests(...args)),
    eventsNewestFirst: memo((...args: Parameters<DeveloperTaskActions["eventsNewestFirst"]>) => actions.eventsNewestFirst(...args)),
    artifacts: memo((...args: Parameters<DeveloperTaskActions["artifacts"]>) => actions.artifacts(...args)),
    readArtifact: memo((...args: Parameters<DeveloperTaskActions["readArtifact"]>) => actions.readArtifact(...args), 1),
    channelTurns: memo((...args: Parameters<DeveloperTaskActions["channelTurns"]>) => actions.channelTurns(...args)),
    channelActivity: memo((...args: Parameters<DeveloperTaskActions["channelActivity"]>) => actions.channelActivity(...args)),
  };
}

/**
 * Web task channel C2 (plan 4.1 rule 3): the web proof's strict reading of one stored `COMPANY_MEMBER#<personId>` row. No row, or a revoked one,
 * is a proven absence (undefined). A row that is present but does not parse, or names another person, is unreadable: it throws, so the proof
 * answers unavailable and nothing is reconciled from data nobody could read.
 */
export function strictLiveMembership(item: unknown, personId: string): { companyId: string } | undefined {
  if (item === undefined) return undefined;
  const parsed = Membership.safeParse(item);
  if (!parsed.success || parsed.data.personId !== personId) throw agentXError("SLACK_UNAVAILABLE", "task person identity proof is unavailable");
  return parsed.data.revokedAt === undefined ? { companyId: parsed.data.companyId } : undefined;
}
