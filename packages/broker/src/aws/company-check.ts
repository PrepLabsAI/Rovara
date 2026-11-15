// R4: membership is an internal, replaceable person -> company read. Only tests write the
// approved stand-in today; T3 owns creation. A token's company is never membership.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import type { DeveloperTaskActions } from "./developer-task-actions.js";
import { agentXError, IMPLICIT_COMPANY_ID, OrgIdSchema, OrgRoleSchema, type DocumentStore } from "@agentx/contracts";

export interface CompanyMembershipReader { companyOf(personId: string): Promise<string | undefined> }
const SIGN_IN_AGAIN = "your AgentX sign-in has ended; run agentx login <url> again";
const Membership = z.object({
  entityType: z.literal("COMPANY_MEMBERSHIP"), personId: z.string(), companyId: OrgIdSchema,
  role: OrgRoleSchema, joinedAt: z.iso.datetime(),
});
const membershipKey = (personId: string) => ({ pk: `COMPANY_MEMBER#${personId}`, sk: "COMPANY" });

function membershipReader(read: (personId: string) => Promise<unknown>): CompanyMembershipReader {
  return { async companyOf(personId) {
    if (typeof personId !== "string" || personId.length === 0 || personId.length > 256 || /[#\s]/.test(personId)) return undefined;
    try {
      const parsed = Membership.safeParse(await read(personId));
      return parsed.success && parsed.data.personId === personId ? parsed.data.companyId : undefined;
    } catch { throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN); }
  } };
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

/** Old rows belong to the fixed company, never whichever company is asking today. */
export function recordInCompany(record: unknown, companyId: string | undefined): boolean {
  if (companyId === undefined) return true;
  if (record === null || typeof record !== "object") return false;
  const value = (record as { companyId?: unknown }).companyId;
  const company = OrgIdSchema.safeParse(value === undefined ? IMPLICIT_COMPANY_ID : value);
  return company.success && company.data === companyId;
}

export const COMPANY_READ_LIMITS = { commands: 512, items: 2_000, bytes: 8_000_000, files: 64, milliseconds: 10_000 } as const;

/** One budget for checked SDK reads and task-action results. The host owns the I/O
 * timeout; elapsed time is checked before/after awaits, with no detached timeout race. */
export function boundedCompanyReads(client: { send(command: unknown): Promise<unknown> }, clock: () => number = Date.now) {
  const started = clock();
  let commands = 0; let items = 0; let bytes = 0; let files = 0;
  const check = () => {
    if (commands > COMPANY_READ_LIMITS.commands || items > COMPANY_READ_LIMITS.items || bytes > COMPANY_READ_LIMITS.bytes || files > COMPANY_READ_LIMITS.files || clock() - started > COMPANY_READ_LIMITS.milliseconds) {
      throw agentXError("CONFIG_INVALID", "company read limit exceeded");
    }
  };
  const run = async <T>(work: () => Promise<T>, count: (result: T) => number, readFiles = 0): Promise<T> => {
    commands++; files += readFiles; check();
    const result = await work();
    items += count(result);
    bytes += Buffer.byteLength(JSON.stringify(result) ?? "", "utf8");
    check(); return result;
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
