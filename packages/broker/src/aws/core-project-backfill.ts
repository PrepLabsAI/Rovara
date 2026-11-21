// Operator-only migration. No scheduling or HTTP route; legacy rows are never deleted.
import { createHash, randomUUID } from "node:crypto";
import { GetCommand, QueryCommand, TransactWriteCommand, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { canonicalJson, IMPLICIT_COMPANY_ID, OrgIdSchema, OrgRoleSchema, StoredProjectDefinitionSchema, orgProjectCatalogKey, orgSettingsKey, projectMetaKey, projectRevisionKey } from "@agentx/contracts";
import { planProjectIncarnation, requireProjectIncarnation, uninitializedProjectMeta } from "../core/project-incarnation.js";
import { Membership, membershipKey, recordInCompany } from "./company-check.js";
import { GithubInstallationBindings } from "./github-credentials.js";
import { projectKey } from "./project-records.js";
import { projectMemberKey } from "./admin-actions.js";
import { grantKeyFor } from "./company-layout.js";

type Row = Record<string, unknown>;
type Write = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];
export interface CoreBackfillDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  signInTableName: string;
  now?: () => number;
}
type State = Pick<CoreBackfillDependencies, "documentClient" | "tableName">;
const nameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/);
const personSchema = z.string().regex(/^[a-f0-9]{64}$/);
const revisionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const mappingSchema = z.object({
  companyId: OrgIdSchema,
  projectNames: z.array(nameSchema).max(100),
  bindings: z.array(z.object({ installationId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), accountLogin: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/) }).strict()).max(25).default([]),
  people: z.array(z.object({ personId: personSchema, role: OrgRoleSchema }).strict()).max(100).default([]),
  grants: z.array(z.object({ personId: personSchema, projectName: nameSchema, role: z.enum(["developer", "administrator"]) }).strict()).max(100).default([]),
}).strict().superRefine((input, ctx) => {
  const names = new Set(input.projectNames), people = new Set(input.people.map(p => p.personId));
  if (names.size !== input.projectNames.length || people.size !== input.people.length
    || new Set(input.bindings.map(b => b.installationId)).size !== input.bindings.length
    || new Set(input.grants.map(g => `${g.personId}/${g.projectName}`)).size !== input.grants.length
    || input.grants.some(g => !names.has(g.projectName) || !people.has(g.personId))
    || input.projectNames.length + input.bindings.length + input.people.length + input.grants.length > 100) ctx.addIssue({ code: "custom", message: "invalid input" });
});
type Mapping = z.infer<typeof mappingSchema>;
const inventorySchema = z.array(z.object({ project: nameSchema, revision: revisionSchema, revisionDigest: z.string().regex(/^[a-f0-9]{64}$/), catalogDigest: z.string().regex(/^[a-f0-9]{64}$/), metaDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(100);
const requestSchema = z.object({ ...mappingSchema.shape, mode: z.literal("migrate-incarnations").optional(), inventory: inventorySchema.optional(), dryRun: z.boolean().default(true), runId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).optional(), limit: z.number().int().min(1).max(25).default(25), continuation: z.string().min(1).max(2048).optional() }).strict();
const cursorSchema = z.object({ version: z.literal(1), digest: z.string().regex(/^[a-f0-9]{64}$/), phase: z.number().int().min(0).max(3), index: z.number().int().min(0).max(100), after: z.string().regex(/^REV#[0-9]{12,16}$/).optional() }).strict();
type Cursor = z.infer<typeof cursorSchema>;
export interface CoreBackfillReport { scanned: number; written: number; skippedExisting: number; skippedConflict: number; failed: number; more: boolean; continuation?: string; refused?: "invalid_input"; issues: Array<{ phase: number; index: number; reason: "conflict" | "unavailable" | "source_missing" }> }
const report = (): CoreBackfillReport => ({ scanned: 0, written: 0, skippedExisting: 0, skippedConflict: 0, failed: 0, more: false, issues: [] });
const unavailable = () => new Error("core backfill unavailable");
const conflict = () => new Error("core project conflict");
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const owned = (row: Row, company: string) => row["companyId"] === undefined || row["companyId"] === company;
async function get(deps: State, key: { pk: string; sk: string }, tableName = deps.tableName): Promise<Row | undefined> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true })) as { Item?: Row };
  return response.Item;
}
// Exact snapshot fences include every field read, including absence of ownership. No blind replacement.
export function coreProjectSnapshotFence(value: object | undefined) {
  const row = value as Row | undefined;
  if (row === undefined) return { ConditionExpression: "attribute_not_exists(pk)" };
  const fields = Object.keys(row).filter(k => k !== "pk" && k !== "sk").sort();
  const names: Record<string, string> = {}, values: Record<string, unknown> = {};
  const expressions = fields.map((key, index) => { names[`#f${index}`] = key; values[`:v${index}`] = row[key]; return `#f${index} = :v${index}`; });
  for (const [index, field] of ["companyId", "orgId", "project", "incarnationRevision", "status", "setupCheck", "lifecycleRevision", "indexExpiresAt", "expiresAt"].entries()) {
    if (row[field] === undefined) { names[`#absent${index}`] = field; expressions.push(`attribute_not_exists(#absent${index})`); }
  }
  return { ConditionExpression: ["attribute_exists(pk)", ...expressions].join(" AND "), ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}), ...(fields.length ? { ExpressionAttributeValues: values } : {}) };
}
function sourceDefinition(source: Row) {
  const parsed = StoredProjectDefinitionSchema.safeParse(source["definition"]);
  if (!parsed.success || source["entityType"] !== "PROJECT" || !nameSchema.safeParse(parsed.data.name).success || !revisionSchema.safeParse(parsed.data.revision).success) throw conflict();
  const key = projectKey(parsed.data.name, parsed.data.revision);
  if (source["pk"] !== key.pk || source["sk"] !== key.sk) throw conflict();
  return parsed.data;
}
function matchingRevision(row: Row, source: Row, company: string) {
  const content = (value: Row) => Object.fromEntries(Object.entries(value).filter(([key]) => !["pk", "sk", "companyId", "backfillRunId"].includes(key)));
  return row["entityType"] === "PROJECT" && owned(row, company) && equal(content(row), content(source));
}
/** Before catalog verification, an unattributed registration still retains its canonical identity. */
async function planUnattributedProjectIdentity(deps: State, source: Row): Promise<Awaited<ReturnType<typeof planCoreProjectWrites>> | undefined> {
  const flag = await get(deps, orgSettingsKey(IMPLICIT_COMPANY_ID, "PROJECT_CATALOG_INDEX"));
  if (flag === undefined) {
    const definition = sourceDefinition(source);
    const legacy = await deps.documentClient.send(new QueryCommand({ TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :rev)", ExpressionAttributeValues: { ":pk": projectKey(definition.name, 1).pk, ":rev": "REV#" }, ConsistentRead: true, Limit: 1 })) as { Items?: Row[] };
    const identity = await planCanonicalProjectIdentity(deps, IMPLICIT_COMPANY_ID, definition.name, (legacy.Items?.length ?? 0) > 0);
    return { status: "unknown_company", writes: identity.writes, incarnationRevision: identity.revision };
  }
  if (!z.object({ verifiedAt: z.iso.datetime(), count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), runId: z.string().min(1).max(100) }).safeParse(flag).success) throw conflict();
  return undefined;
}

/** The broker appends these writes to its legacy transaction. Backfill supplies the explicit operator company.
 * Forward writes follow D1 when the legacy source has no explicit company. */
export async function planCoreProjectWrites(deps: State, value: unknown, mappedCompany?: string, backfillRunId?: string): Promise<{ status: "ready" | "existing" | "unknown_company"; writes: Write[]; incarnationRevision: number }> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw conflict();
  const source = value as Row;
  // Forward registration keeps the pre-catalog behavior until the implicit
  // company's catalog has been verified. Operator backfill supplies a mapping
  // and continues to use D1 attribution without consulting this rollout flag.
  if (mappedCompany === undefined && source["companyId"] === undefined) {
    const identity = await planUnattributedProjectIdentity(deps, source);
    if (identity !== undefined) return identity;
  }
  // D1: legacy projects without an explicit company belong to the implicit company.
  const companyValue = mappedCompany === undefined ? source["companyId"] ?? IMPLICIT_COMPANY_ID : mappedCompany;
  const parsedCompany = OrgIdSchema.safeParse(companyValue);
  if (!parsedCompany.success || !owned(source, parsedCompany.data)) throw conflict();
  const company = parsedCompany.data, definition = sourceDefinition(source);
  const revisionKey = projectRevisionKey(company, definition.name, definition.revision);
  const catalogKey = orgProjectCatalogKey(company, definition.name);
  const existing = await get(deps, revisionKey), catalog = await get(deps, catalogKey);
  if (existing !== undefined && !matchingRevision(existing, source, company)) throw conflict();
  if (catalog !== undefined && (catalog["entityType"] !== "PROJECT_CATALOG" || !owned(catalog, company)
    || (catalog["name"] !== undefined && catalog["name"] !== definition.name) || !revisionSchema.safeParse(catalog["latestRevision"]).success)) throw conflict();
  const latest = catalog?.["latestRevision"] as number | undefined;
  const historyChecks: Write[] = [];
  // An existing catalog must be justified by matching legacy + own-company content, never a foreign lookup.
  if (latest !== undefined && latest !== definition.revision) {
    const oldSource = await get(deps, projectKey(definition.name, latest));
    const oldCore = await get(deps, projectRevisionKey(company, definition.name, latest));
    if (oldSource === undefined || oldCore === undefined || !owned(oldSource, company) || !matchingRevision(oldCore, oldSource, company)) throw conflict();
    const validated = sourceDefinition(oldSource);
    if (validated.name !== definition.name || validated.revision !== latest) throw conflict();
    historyChecks.push(
      { ConditionCheck: { TableName: deps.tableName, Key: projectKey(definition.name, latest), ...coreProjectSnapshotFence(oldSource) } },
      { ConditionCheck: { TableName: deps.tableName, Key: projectRevisionKey(company, definition.name, latest), ...coreProjectSnapshotFence(oldCore) } },
    );
  }
  const identity = await planCanonicalProjectIdentity(deps, company, definition.name, existing !== undefined || catalog !== undefined);
  const writes: Write[] = [...historyChecks, ...identity.writes];
  if (existing === undefined) writes.push({ Put: { TableName: deps.tableName, Item: { ...source, ...revisionKey, companyId: company, ...(backfillRunId === undefined ? {} : { backfillRunId }) }, ...coreProjectSnapshotFence(undefined) } });
  else writes.push({ ConditionCheck: { TableName: deps.tableName, Key: revisionKey, ...coreProjectSnapshotFence(existing) } });
  if (latest === undefined || latest < definition.revision) {
    writes.push({ Put: { TableName: deps.tableName, Item: { ...Object.fromEntries(Object.entries(catalog ?? {}).filter(([key]) => key !== "backfillRunId")), ...catalogKey, ...(backfillRunId !== undefined && (catalog === undefined || catalog["backfillRunId"] === backfillRunId) ? { backfillRunId } : {}), entityType: "PROJECT_CATALOG", companyId: company, name: definition.name, incarnationRevision: identity.revision, latestRevision: definition.revision }, ...coreProjectSnapshotFence(catalog) } });
  } else writes.push({ ConditionCheck: { TableName: deps.tableName, Key: catalogKey, ...coreProjectSnapshotFence(catalog) } });
  return { status: existing !== undefined && latest !== undefined && latest >= definition.revision ? "existing" : "ready", writes, incarnationRevision: identity.revision };
}
/** Shared with native registration: the META write/check joins the caller's registration transaction. */
export async function planCanonicalProjectIdentity(deps: State, companyId: string, project: string, hasContent: boolean): Promise<{ revision: number; writes: Write[] }> {
  const key = projectMetaKey(companyId, project), previous = await get(deps, key);
  const history = await deps.documentClient.send(new QueryCommand({ TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :rev)", ExpressionAttributeValues: { ":pk": projectRevisionKey(companyId, project, 1).pk, ":rev": "REV#" }, ConsistentRead: true, Limit: 1 })) as { Items?: Row[] };
  const authoritativeCatalog = companyId === IMPLICIT_COMPANY_ID ? await get(deps, { pk: "PROJECT_CATALOG", sk: `PROJECT#${project}` }) : undefined;
  let next: Row;
  try { next = planProjectIncarnation(companyId, project, previous, hasContent || (history.Items?.length ?? 0) > 0 || authoritativeCatalog?.["incarnationRevision"] !== undefined); } catch { throw conflict(); }
  return { revision: next["incarnationRevision"] as number, writes: [equal(previous ?? null, next)
    ? { ConditionCheck: { TableName: deps.tableName, Key: key, ...coreProjectSnapshotFence(previous) } }
    : { Put: { TableName: deps.tableName, Item: next, ...coreProjectSnapshotFence(previous) } }] };
}
const snapshotDigest = (row: Row | undefined) => createHash("sha256").update(canonicalJson(row ?? null)).digest("hex");
async function migrateIncarnation(deps: State, companyId: string, inventory: z.infer<typeof inventorySchema>[number], dryRun: boolean): Promise<boolean> {
  const project = inventory.project, metaKey = projectMetaKey(companyId, project), catalogKey = orgProjectCatalogKey(companyId, project), revisionKey = projectRevisionKey(companyId, project, inventory.revision);
  const [meta, catalog, row] = await Promise.all([get(deps, metaKey), get(deps, catalogKey), get(deps, revisionKey)]);
  const definition = StoredProjectDefinitionSchema.safeParse(row?.["definition"]);
  if (catalog?.["entityType"] !== "PROJECT_CATALOG" || !owned(catalog, companyId) || (catalog["name"] !== undefined && catalog["name"] !== project)
    || catalog["latestRevision"] !== inventory.revision || row?.["entityType"] !== "PROJECT" || !owned(row, companyId)
    || !definition.success || definition.data.name !== project || definition.data.revision !== inventory.revision) throw conflict();
  if (snapshotDigest(row) !== inventory.revisionDigest) throw conflict();
  if (meta?.["incarnationRevision"] !== undefined) {
    try { requireProjectIncarnation(companyId, project, meta); } catch { throw conflict(); }
    if (meta["status"] === "deleted" || catalog["incarnationRevision"] !== meta["incarnationRevision"]) throw conflict();
    return false;
  }
  // The pre-rollout snapshot, including an explicitly inventoried absent META, is initialization authority.
  // A catalogue already stamped by any initializer proves a subsequently lost META: never repair it.
  if (catalog["incarnationRevision"] !== undefined || !uninitializedProjectMeta(companyId, project, meta)
    || snapshotDigest(row) !== inventory.revisionDigest || snapshotDigest(catalog) !== inventory.catalogDigest || snapshotDigest(meta) !== inventory.metaDigest) throw conflict();
  await transact(deps, [
    { ConditionCheck: { TableName: deps.tableName, Key: revisionKey, ...coreProjectSnapshotFence(row) } },
    { Put: { TableName: deps.tableName, Item: { ...catalog, incarnationRevision: 1 }, ...coreProjectSnapshotFence(catalog) } },
    { Update: { TableName: deps.tableName, Key: metaKey, UpdateExpression: "SET entityType = :entity, companyId = :company, #project = :project, #status = :status, incarnationRevision = :incarnation",
      ExpressionAttributeNames: { "#project": "project", "#status": "status", ...coreProjectSnapshotFence(meta).ExpressionAttributeNames },
      ExpressionAttributeValues: { ":entity": "PROJECT_META", ":company": companyId, ":project": project, ":status": meta?.["status"] ?? "active", ":incarnation": 1, ...coreProjectSnapshotFence(meta).ExpressionAttributeValues },
      ConditionExpression: coreProjectSnapshotFence(meta).ConditionExpression } },
  ], dryRun);
  return true;
}
/** Fence the legacy ownership evidence in the same transaction, without duplicating a history check. */
export function guardCoreProjectSource(deps: State, source: unknown, writes: Write[]): Write[] {
  if (writes.length === 0) return writes;
  if (source === null || typeof source !== "object" || Array.isArray(source)) throw conflict();
  const row = source as Row, definition = sourceDefinition(row), key = projectKey(definition.name, definition.revision);
  if (writes.some(write => write.ConditionCheck?.Key?.["pk"] === key.pk && write.ConditionCheck.Key["sk"] === key.sk)) return writes;
  return [...writes, { ConditionCheck: { TableName: deps.tableName, Key: key, ...coreProjectSnapshotFence(row) } }];
}
/** One total budget for all phases, including reused binding writer I/O. The host cancels I/O; no detached timeout race. */
function bounded(deps: CoreBackfillDependencies) {
  const now = deps.now ?? Date.now, started = now(); let commands = 0, bytes = 0, items = 0;
  const check = () => { if (now() - started > 5000 || commands > 500 || bytes > 2_000_000 || items > 500) throw unavailable(); };
  return { ...deps, documentClient: { async send(command: unknown) {
    commands++; check();
    const response = await deps.documentClient.send(command) as { Item?: unknown; Items?: unknown[] };
    bytes += Buffer.byteLength(JSON.stringify(response) ?? ""); items += (response.Item === undefined ? 0 : 1) + (response.Items?.length ?? 0); check();
    return response;
  } } };
}
/** Migration accepts only the complete verified project inventory, never other import phases. */
function validateIncarnationMigration(request: z.infer<typeof requestSchema>): void {
  const { mode, inventory, runId } = request;
  if (mode === undefined ? inventory !== undefined : runId === undefined || inventory === undefined || inventory.length !== request.projectNames.length
    || new Set(inventory.map(row => row.project)).size !== inventory.length || inventory.some(row => !request.projectNames.includes(row.project))
    || request.bindings.length > 0 || request.people.length > 0 || request.grants.length > 0) throw unavailable();
}

/** Revision pagination belongs only to the legacy project-import phase. */
function validateBackfillCursor(cursor: Cursor, digest: string, mode: "migrate-incarnations" | undefined): void {
  if (cursor.digest !== digest || (cursor.after !== undefined && (cursor.phase !== 0 || mode !== undefined))) throw unavailable();
}

function parseRequest(value: unknown, deps: CoreBackfillDependencies) {
  if (Buffer.byteLength(JSON.stringify(value) ?? "") > 65_536) throw unavailable();
  const request = requestSchema.parse(value);
  const { dryRun, limit, continuation, runId, mode, inventory, ...rawMapping } = request;
  validateIncarnationMigration(request);
  const mapping = mappingSchema.parse(rawMapping);
  const digest = createHash("sha256").update(canonicalJson({ mapping, ...(mode === undefined ? {} : { mode, inventory }), dryRun, ...(runId === undefined ? {} : { runId }), tableName: deps.tableName, signInTableName: deps.signInTableName })).digest("hex");
  let cursor: Cursor = { version: 1, digest, phase: 0, index: 0 };
  if (continuation !== undefined) {
    if (!/^[A-Za-z0-9_-]+$/.test(continuation)) throw unavailable();
    const bytes = Buffer.from(continuation, "base64url");
    if (bytes.toString("base64url") !== continuation) throw unavailable();
    cursor = cursorSchema.parse(JSON.parse(bytes.toString("utf8")));
    validateBackfillCursor(cursor, digest, mode);
    const lengths = [mapping.projectNames.length, mapping.bindings.length, mapping.people.length, mapping.grants.length];
    if (cursor.index >= lengths[cursor.phase]!) throw unavailable();
  }
  return { mapping, dryRun, limit, cursor, runId, mode, inventory };
}
const encode = (cursor: Cursor) => Buffer.from(JSON.stringify(cursor)).toString("base64url");
/** DEC 254zzz80: the grant in the mapped company's own layout (company-layout.ts: a named company's own partition; the built-in company: the legacy row). */
function grantKey(companyId: string, personId: string, projectName: string) { return grantKeyFor(companyId, personId, projectName); }
function personKey(personId: string) { return { pk: `DEVELOPER#${personId}`, sk: "META" }; }
async function person(deps: CoreBackfillDependencies, personId: string) {
  const row = await get(deps, personKey(personId), deps.signInTableName);
  const valid = z.object({ entityType: z.literal("DEVELOPER"), provider: z.enum(["oidc", "slack", "github"]), issuer: z.string().min(1).max(2048), subject: z.string().min(1).max(1024), firstSignInAt: z.iso.datetime(), revoked: z.literal(false), developerId: personSchema.optional() }).safeParse(row);
  if (!valid.success || row === undefined || (valid.data.developerId !== undefined && valid.data.developerId !== personId)) throw conflict();
  return row;
}
function memberMatches(row: Row, companyId: string, personId: string, role?: string) {
  const parsed = Membership.safeParse(row);
  return parsed.success && parsed.data.companyId === companyId && parsed.data.personId === personId && parsed.data.revokedAt === undefined && (role === undefined || parsed.data.role === role);
}
async function transact(deps: State, writes: Write[], dryRun: boolean) {
  if (!dryRun) await deps.documentClient.send(new TransactWriteCommand({ TransactItems: writes }));
}
async function processBinding(deps: CoreBackfillDependencies, mapping: Mapping, index: number, dryRun: boolean) {
  const binding = mapping.bindings[index]!;
  // Read the actual binding, never ownerOf's pre-backfill implicit fallback.
  const key = { pk: `GITHUB_INSTALLATION#${binding.installationId}`, sk: "BINDING" };
  const existing = await get(deps, key);
  if (existing !== undefined) {
    if (existing["entityType"] !== "GITHUB_INSTALLATION_BINDING" || existing["companyId"] !== mapping.companyId || existing["installationId"] !== binding.installationId || existing["accountLogin"] !== binding.accountLogin
      || !z.iso.datetime().safeParse(existing["boundAt"]).success || typeof existing["boundBy"] !== "string") throw conflict();
    return false;
  }
  if (await get(deps, { pk: `GITHUB_INSTALLATION#${binding.installationId}`, sk: "AUDIT#CLAIM" }) !== undefined) throw conflict();
  if (!dryRun) {
    await new GithubInstallationBindings(deps.documentClient, deps.tableName, deps.now).claimOperator(mapping.companyId, binding);
    const verified = await get(deps, key);
    if (verified?.["companyId"] !== mapping.companyId || verified["installationId"] !== binding.installationId) throw unavailable();
  }
  return true;
}
async function processPerson(deps: CoreBackfillDependencies, mapping: Mapping, index: number, dryRun: boolean) {
  const p = mapping.people[index]!, source = await person(deps, p.personId);
  const key = membershipKey(p.personId), existing = await get(deps, key, deps.signInTableName);
  if (existing !== undefined) { if (!memberMatches(existing, mapping.companyId, p.personId, p.role)) throw conflict(); return false; }
  const row = Membership.parse({ entityType: "COMPANY_MEMBERSHIP", companyId: mapping.companyId, personId: p.personId, role: p.role, joinedAt: new Date((deps.now ?? Date.now)()).toISOString() });
  await transact(deps, [
    { ConditionCheck: { TableName: deps.signInTableName, Key: personKey(p.personId), ...coreProjectSnapshotFence(source) } },
    { Put: { TableName: deps.signInTableName, Item: { ...key, ...row }, ...coreProjectSnapshotFence(undefined) } },
  ], dryRun);
  if (!dryRun && !memberMatches((await get(deps, key, deps.signInTableName)) ?? {}, mapping.companyId, p.personId, p.role)) throw unavailable();
  return true;
}
async function processGrant(deps: CoreBackfillDependencies, mapping: Mapping, index: number, dryRun: boolean, expectedRole: string) {
  const g = mapping.grants[index]!, source = await person(deps, g.personId);
  const memberKey = membershipKey(g.personId), member = await get(deps, memberKey, deps.signInTableName);
  // Preview may use the explicitly planned membership only; real writes require the durable row.
  if (member === undefined ? !dryRun : !memberMatches(member, mapping.companyId, g.personId, expectedRole)) throw conflict();
  const key = grantKey(mapping.companyId, g.personId, g.projectName), existing = await get(deps, key);
  const reverseKey = projectMemberKey(g.projectName, g.personId, mapping.companyId), reverse = await get(deps, reverseKey);
  if (reverse !== undefined && (reverse["entityType"] !== "PROJECT_MEMBER" || reverse["role"] !== g.role)) throw conflict();
  if (existing !== undefined) {
    if (existing["entityType"] !== "MEMBERSHIP" || existing["ownerKey"] !== g.personId || existing["projectName"] !== g.projectName || existing["role"] !== g.role || !owned(existing, mapping.companyId)) throw conflict();
    if (reverse !== undefined) return false;
  }
  const grantedAt = typeof existing?.["grantedAt"] === "string" ? existing["grantedAt"] : new Date((deps.now ?? Date.now)()).toISOString();
  const reverseRow = { ...reverseKey, entityType: "PROJECT_MEMBER", role: g.role, grantedAt };
  const reversePut: Write = { Put: { TableName: deps.tableName, Item: reverseRow,
    ...(reverse === undefined
      ? { ConditionExpression: "attribute_not_exists(pk)" }
      : { ConditionExpression: "#role = :role", ExpressionAttributeNames: { "#role": "role" }, ExpressionAttributeValues: { ":role": g.role } }),
  } };
  await transact(deps, [
    { ConditionCheck: { TableName: deps.signInTableName, Key: personKey(g.personId), ...coreProjectSnapshotFence(source) } },
    { ConditionCheck: { TableName: deps.signInTableName, Key: memberKey, ...coreProjectSnapshotFence(member) } },
    ...(existing === undefined ? [{ Put: { TableName: deps.tableName, Item: { ...key, entityType: "MEMBERSHIP", ownerKey: g.personId, projectName: g.projectName, role: g.role, grantId: randomUUID(), grantedAt }, ...coreProjectSnapshotFence(undefined) } } as Write] : []),
    reversePut,
  ], dryRun);
  if (!dryRun && ((await get(deps, key))?.["role"] !== g.role || (await get(deps, reverseKey))?.["role"] !== g.role)) throw unavailable();
  return true;
}
function isIncarnationMigrationPhase(phase: number, mode: "migrate-incarnations" | undefined): boolean {
  return phase === 0 && mode === "migrate-incarnations";
}

export async function backfillCorePage(dependencies: CoreBackfillDependencies, value: unknown): Promise<CoreBackfillReport> {
  const result = report();
  let request: ReturnType<typeof parseRequest>;
  try { request = parseRequest(value, dependencies); } catch { return { ...result, refused: "invalid_input" }; }
  const { mapping, dryRun, limit } = request, deps = bounded(dependencies);
  const roles = new Map(mapping.people.map(p => [p.personId, p.role]));
  let cursor = request.cursor;
  const lengths = [mapping.projectNames.length, mapping.bindings.length, mapping.people.length, mapping.grants.length];
  const advance = () => { while (cursor.phase < 4 && cursor.index >= lengths[cursor.phase]!) cursor = { ...cursor, phase: cursor.phase + 1, index: 0 }; };
  advance();
  while (cursor.phase < 4 && result.scanned < limit) {
    const current = { ...cursor }; let next = { ...cursor, index: cursor.index + 1 }; delete next.after;
    result.scanned++;
    try {
      let written = false;
      if (isIncarnationMigrationPhase(cursor.phase, request.mode)) {
        written = await migrateIncarnation(deps, mapping.companyId, request.inventory!.find(row => row.project === mapping.projectNames[cursor.index])!, dryRun);
      } else if (cursor.phase === 0) {
        const name = mapping.projectNames[cursor.index]!;
        const page = await deps.documentClient.send(new QueryCommand({ TableName: deps.tableName,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :rev)", ExpressionAttributeValues: { ":pk": projectKey(name, 1).pk, ":rev": "REV#" },
          ConsistentRead: true, ScanIndexForward: true, Limit: 1,
          ...(cursor.after === undefined ? {} : { ExclusiveStartKey: { pk: projectKey(name, 1).pk, sk: cursor.after } }),
        })) as { Items?: Row[]; LastEvaluatedKey?: Row };
        if (page.Items?.length !== 1) {
          if (page.Items?.length === 0 && cursor.after !== undefined && page.LastEvaluatedKey === undefined) { cursor = next; advance(); result.scanned--; continue; }
          throw conflict();
        }
        const source = page.Items[0]!;
        if (page.LastEvaluatedKey !== undefined) {
          if (page.LastEvaluatedKey["pk"] !== projectKey(name, 1).pk || page.LastEvaluatedKey["sk"] !== source["sk"] || !/^REV#[0-9]{12,16}$/.test(String(source["sk"]))) throw unavailable();
          next = { ...cursor, after: String(source["sk"]) };
        }
        if (sourceDefinition(source).name !== name) throw conflict();
        if (request.runId !== undefined && !recordInCompany(source, mapping.companyId)) throw conflict();
        const plan = await planCoreProjectWrites(deps, source, mapping.companyId, request.runId);
        written = plan.status === "ready";
        if (written) await transact(deps, [ { ConditionCheck: { TableName: deps.tableName, Key: projectKey(name, sourceDefinition(source).revision), ...coreProjectSnapshotFence(source) } }, ...plan.writes ], dryRun);
        if (!dryRun && written && (await planCoreProjectWrites(deps, source, mapping.companyId)).status !== "existing") throw unavailable();
      } else if (cursor.phase === 1) written = await processBinding(deps, mapping, cursor.index, dryRun);
      else if (cursor.phase === 2) written = await processPerson(deps, mapping, cursor.index, dryRun);
      else written = await processGrant(deps, mapping, cursor.index, dryRun, roles.get(mapping.grants[cursor.index]!.personId)!);
      if (written) result.written++; else result.skippedExisting++;
    } catch (error) {
      if (error instanceof Error && error.message === "core project conflict") { result.skippedConflict++; result.issues.push({ phase: current.phase, index: current.index, reason: "conflict" }); }
      else { result.failed++; result.issues.push({ phase: current.phase, index: current.index, reason: "unavailable" }); result.more = true; result.continuation = encode(current); return result; }
    }
    cursor = next; advance();
  }
  result.more = cursor.phase < 4;
  if (result.more) result.continuation = encode(cursor);
  return result;
}
/** Read-only: indexes identify the exact operator input needing correction, without echoing customer content. */
export async function checkCorePeople(dependencies: CoreBackfillDependencies, value: unknown): Promise<{ gaps: Array<{ person?: number; grant?: number; reason: string }>; refused?: "invalid_input"; failed?: boolean }> {
  let mapping: Mapping;
  try { if (Buffer.byteLength(JSON.stringify(value) ?? "") > 65_536) throw unavailable(); mapping = mappingSchema.parse(value); } catch { return { gaps: [], refused: "invalid_input" }; }
  const deps = bounded(dependencies), gaps: Array<{ person?: number; grant?: number; reason: string }> = [];
  try {
    for (const [index, p] of mapping.people.entries()) {
      try { await person(deps, p.personId); } catch (e) { if (!(e instanceof Error) || e.message !== "core project conflict") throw e; gaps.push({ person: index, reason: "person_missing_or_revoked" }); }
      const row = await get(deps, membershipKey(p.personId), deps.signInTableName);
      if (row === undefined) gaps.push({ person: index, reason: "membership_missing" });
      else if (!memberMatches(row, mapping.companyId, p.personId, p.role)) gaps.push({ person: index, reason: "membership_conflict" });
    }
    for (const [index, g] of mapping.grants.entries()) {
      const row = await get(deps, grantKey(mapping.companyId, g.personId, g.projectName));
      if (row === undefined) gaps.push({ grant: index, reason: "grant_missing" });
      else if (row["entityType"] !== "MEMBERSHIP" || row["projectName"] !== g.projectName || row["ownerKey"] !== g.personId || row["role"] !== g.role || !owned(row, mapping.companyId)) gaps.push({ grant: index, reason: "grant_conflict" });
    }
    return { gaps };
  } catch { return { gaps, failed: true }; }
}
