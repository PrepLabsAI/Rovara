// DEC 254b (b): plans an operator's copy of one company of the install's old layout into Code's own company records, and its undo. Reads only.
// The broker reads the State table (the old layout, install-company.ts) and the sign-in table (merges, Code's memberships, the company record and its member
// mirror); the sign-in Lambda writes (developer/company-import.ts). A plan is deterministic (sorted, no clock), so an admin change's re-plan at apply hashes
// the same when nothing changed, and differs (the change goes stale) when anything did.
//
// Who is imported: every ORG#<company>/MEMBER#<person> record whose person reads, today, as a member of this company: their own DEVELOPER_ORG pointer names
// it, they are not banned or removed, their sign-in is not revoked and was not merged away (a merged-away id is never imported: the survivor is imported once,
// from their own member record), and their role is one Code knows. Owners included, roles copied.
// Refused, whole run, nothing written: an unknown role (the install's Auditor), a person already in ANOTHER company in Code's records (live or removed), an
// unreadable record, no open company, more than COMPANY_IMPORT_MEMBERS_MAX members, or no owner after the import.
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import {
  COMPANY_IMPORT_MEMBERS_MAX, IMPLICIT_COMPANY_ID, OrgIdSchema, OrgRoleSchema, companyScoped,
  type CompanyImportPreview, type OrgId, type OrgRole,
} from "@agentx/contracts";
import { Membership, membershipKey } from "./company-check.js";
import { MERGE_HOPS_MAX, developerOrgPointerKey, installCompanyBanKey, installCompanyKey, installCompanyMemberKey } from "./install-company.js";
import { CompanyRecord, companyKey } from "../developer/company-membership.js";

type Client = { send(command: unknown): Promise<unknown> };
type Item = Record<string, unknown>;
export interface CompanyImportReads { documentClient: Client; tableName: string; signInTableName: string }

const PersonId = z.string().regex(/^[a-f0-9]{64}$/);
const Iso = z.iso.datetime();
/** Mirror rows read for an undo, imported or not. */
const MIRROR_ROWS_MAX = 1_000;
/** Reads in flight at once. */
const READS_AT_ONCE = 8;

export interface ImportPlan {
  preview: CompanyImportPreview;
  /** What the sign-in Lambda writes on apply (empty unless ready). */
  write: { companyId: string; name: string; writeCompany: boolean; members: Array<{ personId: string; role: OrgRole; joinedAt?: string }> };
}
export interface UndoPlan {
  preview: CompanyImportPreview;
  remove: { companyId: string; members: Array<{ personId: string; role: OrgRole; joinedAt: string; importedAt: string }>; company?: { name: string; createdAt: string; importedAt: string } };
}

/** Refuses the whole read: the caller answers one fixed refusal. Carries no cause. */
class Unreadable extends Error { constructor() { super("company import record unreadable"); } }
const unreadable = (): never => { throw new Unreadable(); };

async function get(client: Client, tableName: string, key: { pk: string; sk: string }): Promise<Item | undefined> {
  const answer = await client.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true })) as { Item?: unknown };
  const item = answer?.Item;
  if (item === undefined) return undefined;
  if (item === null || typeof item !== "object" || Array.isArray(item) || (item as Item).pk !== key.pk || (item as Item).sk !== key.sk) return unreadable();
  return item as Item;
}

/** Every item under `pk` whose sort key starts with `prefix`, consistent, at most `max` (more: undefined, the caller refuses). */
async function queryAll(client: Client, tableName: string, pk: string, prefix: string, max: number): Promise<Item[] | undefined> {
  const items: Item[] = [];
  let start: Item | undefined;
  for (let pages = 0; pages < 64; pages++) {
    const answer = await client.send(new QueryCommand({
      TableName: tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": pk, ":prefix": prefix },
      ConsistentRead: true, ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: unknown; LastEvaluatedKey?: Item };
    if (!Array.isArray(answer?.Items)) return unreadable();
    for (const item of answer.Items as Item[]) {
      if (item === null || typeof item !== "object" || item.pk !== pk || typeof item.sk !== "string" || !item.sk.startsWith(prefix)) return unreadable();
      items.push(item);
    }
    if (items.length > max) return undefined;
    start = answer.LastEvaluatedKey;
    if (start === undefined) return items;
  }
  return undefined;
}

async function mapLimited<T, R>(items: T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(READS_AT_ONCE, items.length) }, async () => {
    while (next < items.length) { const index = next++; out[index] = await work(items[index]!); }
  }));
  return out;
}

const byPerson = <T extends { personId: string }>(rows: T[]) => [...rows].sort((a, b) => (a.personId < b.personId ? -1 : a.personId > b.personId ? 1 : 0));
const refusedPlan = (mode: "import" | "undo", companyId: string, refusal: NonNullable<CompanyImportPreview["refusal"]>): CompanyImportPreview =>
  ({ mode, companyId, ready: false, refusal, company: mode === "import" ? "exists" : "keep", members: [], skipped: [], refused: [] });

/** Where a sign-in id's merges end: itself when it was never merged. A loop, a malformed link or a chain past MERGE_HOPS_MAX is unreadable. */
async function survivorOf(deps: CompanyImportReads, personId: string, first: Item | undefined): Promise<string> {
  const seen = new Set([personId]);
  let current = personId, record = first;
  for (let hop = 0; hop <= MERGE_HOPS_MAX; hop++) {
    const next = record?.mergedInto;
    if (next === undefined) return current;
    if (!PersonId.safeParse(next).success || seen.has(next as string)) return unreadable();
    seen.add(next as string);
    current = next as string;
    record = await get(deps.documentClient, deps.signInTableName, { pk: `DEVELOPER#${current}`, sk: "META" });
  }
  return unreadable();
}

type Verdict =
  | { kind: "write"; personId: string; role: OrgRole; joinedAt?: string }
  | { kind: "skip"; personId: string; reason: CompanyImportPreview["skipped"][number]["reason"]; survivorId?: string; liveOwner?: boolean }
  | { kind: "refuse"; personId: string; reason: CompanyImportPreview["refused"][number]["reason"] };

async function judge(deps: CompanyImportReads, companyId: OrgId, record: Item, mirrored: Set<string>): Promise<Verdict> {
  const personId = (record.sk as string).slice("MEMBER#".length);
  try {
    if (record.developerId !== undefined && record.developerId !== personId) return { kind: "refuse", personId, reason: "unreadable_record" };
    // The install's own removal deletes the member record; a record that still says removed is read as removed, never as a member.
    if (record.removedAt !== undefined || record.status === "removed") return { kind: "skip", personId, reason: "removed" };
    const developer = await get(deps.documentClient, deps.signInTableName, { pk: `DEVELOPER#${personId}`, sk: "META" });
    if (developer !== undefined && developer.revoked !== undefined && typeof developer.revoked !== "boolean") return { kind: "refuse", personId, reason: "unreadable_record" };
    if (developer?.mergedInto !== undefined) return { kind: "skip", personId, reason: "merged", survivorId: await survivorOf(deps, personId, developer) };
    if (developer?.revoked === true) return { kind: "skip", personId, reason: "sign_in_revoked" };
    const [pointer, ban] = await Promise.all([
      get(deps.documentClient, deps.tableName, developerOrgPointerKey(personId)),
      get(deps.documentClient, deps.tableName, installCompanyBanKey(companyId, personId)),
    ]);
    if (pointer !== undefined && !OrgIdSchema.safeParse(pointer.orgId).success) return { kind: "refuse", personId, reason: "unreadable_record" };
    if (pointer?.orgId !== companyId) return { kind: "skip", personId, reason: "removed" };
    if (ban !== undefined) return { kind: "skip", personId, reason: "banned" };
    const role = OrgRoleSchema.safeParse(record.role);
    if (!role.success) return { kind: "refuse", personId, reason: "unknown_role" };
    const existing = await get(deps.documentClient, deps.signInTableName, membershipKey(personId));
    if (existing !== undefined) {
      const member = Membership.safeParse(existing);
      if (!member.success || member.data.personId !== personId) return { kind: "refuse", personId, reason: "unreadable_record" };
      if (member.data.companyId !== companyId) return { kind: "refuse", personId, reason: "member_of_another_company" };
      return { kind: "skip", personId, reason: "already_member", liveOwner: member.data.revokedAt === undefined && member.data.role === "owner" };
    }
    // A mirror row with no membership is not Code's own state: never written over, never guessed at.
    if (mirrored.has(personId)) return { kind: "refuse", personId, reason: "unreadable_record" };
    const joinedAt = Iso.safeParse(record.joinedAt);
    return { kind: "write", personId, role: role.data, ...(joinedAt.success ? { joinedAt: joinedAt.data } : {}) };
  } catch (error) {
    if (error instanceof Unreadable) return { kind: "refuse", personId, reason: "unreadable_record" };
    throw error;
  }
}

/** The import's plan. Reads only. */
export async function planCompanyImport(deps: CompanyImportReads, companyId: string): Promise<ImportPlan> {
  const company = OrgIdSchema.parse(companyId);
  const none = (refusal: NonNullable<CompanyImportPreview["refusal"]>): ImportPlan => ({ preview: refusedPlan("import", company, refusal), write: { companyId: company, name: "", writeCompany: false, members: [] } });
  if (company === IMPLICIT_COMPANY_ID) return none("built_in_company");
  try {
    const meta = await get(deps.documentClient, deps.tableName, installCompanyKey(company));
    const name = typeof meta?.name === "string" ? meta.name.trim() : "";
    if (meta === undefined || meta.closedAt !== undefined || name.length < 1 || name.length > 80) return none("no_open_company");
    const records = await queryAll(deps.documentClient, deps.tableName, installCompanyKey(company).pk, "MEMBER#", COMPANY_IMPORT_MEMBERS_MAX);
    if (records === undefined) return none("too_many_members");
    if (records.some((record) => !PersonId.safeParse((record.sk as string).slice("MEMBER#".length)).success || record.sk !== installCompanyMemberKey(company, (record.sk as string).slice(7)).sk)) return none("unreadable");
    const stored = await get(deps.documentClient, deps.signInTableName, companyKey(company));
    if (stored !== undefined) {
      const parsed = CompanyRecord.safeParse(stored);
      if (!parsed.success || parsed.data.companyId !== company) return none("unreadable");
    }
    const mirror = await queryAll(deps.documentClient, deps.signInTableName, companyScoped(company, "MEMBERS"), "MEMBER#", MIRROR_ROWS_MAX);
    if (mirror === undefined) return none("too_many_members");
    const mirrored = new Set(mirror.map((row) => (row.sk as string).slice("MEMBER#".length)));
    const verdicts = await mapLimited(records, (record) => judge(deps, company, record, mirrored));
    const write = byPerson(verdicts.flatMap((v) => v.kind === "write" ? [{ personId: v.personId, role: v.role, ...(v.joinedAt === undefined ? {} : { joinedAt: v.joinedAt }) }] : []));
    const skipped = byPerson(verdicts.flatMap((v) => v.kind === "skip" ? [{ personId: v.personId, reason: v.reason, ...(v.survivorId === undefined ? {} : { survivorId: v.survivorId }) }] : []));
    const refused = byPerson(verdicts.flatMap((v) => v.kind === "refuse" ? [{ personId: v.personId, reason: v.reason }] : []));
    const hasOwner = write.some((member) => member.role === "owner") || verdicts.some((v) => v.kind === "skip" && v.liveOwner === true);
    const refusal = refused.length === 0 && !hasOwner ? "no_owner" as const : undefined;
    const ready = refused.length === 0 && refusal === undefined;
    return {
      preview: { mode: "import", companyId: company, ready, ...(refusal === undefined ? {} : { refusal }), company: stored === undefined ? "write" : "exists",
        members: write.map(({ personId, role }) => ({ personId, role })), skipped, refused },
      write: { companyId: company, name, writeCompany: ready && stored === undefined, members: ready ? write : [] },
    };
  } catch (error) {
    if (error instanceof Unreadable) return none("unreadable");
    throw error;
  }
}

/** The keys an imported membership or mirror row holds, and nothing else: any other field means it was changed after the import. */
const IMPORTED_ROW_KEYS = ["pk", "sk", "entityType", "personId", "companyId", "role", "joinedAt", "joinedVia", "importedAt", "importedRole"].sort().join(",");
const IMPORTED_COMPANY_KEYS = ["pk", "sk", "entityType", "companyId", "name", "status", "createdAt", "createdBy", "importedAt"].sort().join(",");
const ImportedRow = z.object({ personId: PersonId, companyId: OrgIdSchema, role: OrgRoleSchema, importedRole: OrgRoleSchema, joinedAt: Iso, joinedVia: z.literal("import"), importedAt: Iso });

/** The undo's plan: exactly the rows an import wrote and nobody changed since. Reads only. */
export async function planCompanyImportUndo(deps: CompanyImportReads, companyId: string): Promise<UndoPlan> {
  const company = OrgIdSchema.parse(companyId);
  const none = (refusal: NonNullable<CompanyImportPreview["refusal"]>): UndoPlan => ({ preview: refusedPlan("undo", company, refusal), remove: { companyId: company, members: [] } });
  if (company === IMPLICIT_COMPANY_ID) return none("built_in_company");
  try {
    const mirror = await queryAll(deps.documentClient, deps.signInTableName, companyScoped(company, "MEMBERS"), "MEMBER#", MIRROR_ROWS_MAX);
    if (mirror === undefined) return none("too_many_members");
    const imported = mirror.filter((row) => row.joinedVia === "import");
    if (imported.length > COMPANY_IMPORT_MEMBERS_MAX) return none("too_many_members");
    const verdicts = await mapLimited(imported, async (view) => {
      const personId = (view.sk as string).slice("MEMBER#".length);
      if (!PersonId.safeParse(personId).success) return unreadable();
      const row = await get(deps.documentClient, deps.signInTableName, membershipKey(personId));
      const a = ImportedRow.safeParse(row), b = ImportedRow.safeParse(view);
      const same = row !== undefined && a.success && b.success && row.entityType === "COMPANY_MEMBERSHIP" && view.entityType === "COMPANY_MEMBER_VIEW"
        && a.data.personId === personId && b.data.personId === personId && a.data.companyId === company && b.data.companyId === company
        && a.data.role === a.data.importedRole && JSON.stringify(a.data) === JSON.stringify(b.data)
        && Object.keys(row).sort().join(",") === IMPORTED_ROW_KEYS && Object.keys(view).sort().join(",") === IMPORTED_ROW_KEYS;
      return same ? { remove: true as const, personId, role: a.data.role, joinedAt: a.data.joinedAt, importedAt: a.data.importedAt }
        : { remove: false as const, personId };
    });
    const remove = byPerson(verdicts.flatMap((v) => v.remove ? [{ personId: v.personId, role: v.role, joinedAt: v.joinedAt, importedAt: v.importedAt }] : []));
    const kept = byPerson(verdicts.flatMap((v) => v.remove ? [] : [{ personId: v.personId, reason: "changed_since_import" as const }]));
    const stored = await get(deps.documentClient, deps.signInTableName, companyKey(company));
    let companyRemove: UndoPlan["remove"]["company"];
    if (stored !== undefined) {
      const record = CompanyRecord.safeParse(stored);
      if (!record.success || record.data.companyId !== company) return none("unreadable");
      // Only the record an import made, unchanged, and only when no member is left in the company after this undo.
      if (record.data.createdBy === "import" && record.data.importedAt !== undefined && Object.keys(stored).sort().join(",") === IMPORTED_COMPANY_KEYS && remove.length === mirror.length) {
        companyRemove = { name: record.data.name, createdAt: record.data.createdAt, importedAt: record.data.importedAt };
      }
    }
    return {
      preview: { mode: "undo", companyId: company, ready: true, company: companyRemove === undefined ? "keep" : "delete", members: remove.map(({ personId, role }) => ({ personId, role })), skipped: kept, refused: [] },
      remove: { companyId: company, members: remove, ...(companyRemove === undefined ? {} : { company: companyRemove }) },
    };
  } catch (error) {
    if (error instanceof Unreadable) return none("unreadable");
    throw error;
  }
}
