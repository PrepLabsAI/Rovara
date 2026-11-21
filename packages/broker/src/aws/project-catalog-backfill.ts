// Controller-only catalog migration; the runner supplies the same timeout/operator boundary as L4.
import { GetCommand, QueryCommand, TransactWriteCommand, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import {
  AgentXNameSchema, IMPLICIT_COMPANY_ID, OrgIdSchema, PROJECT_CATALOG_PK, StoredProjectDefinitionSchema, canonicalJson,
  orgProjectCatalogKey, orgProjectCatalogPk, orgSettingsKey, projectMetaKey, projectRevisionKey,
} from "@agentx/contracts";
import { projectIncarnationTombstone, requireProjectIncarnation } from "../core/project-incarnation.js";
import { coreProjectSnapshotFence } from "./core-project-backfill.js";
import type { CoreBackfillDependencies } from "./core-project-backfill.js";
import { projectKey } from "./project-records.js";
import { ownPartitionRow, recordInCompany } from "./company-check.js";

type Row = Record<string, unknown>;
type Write = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];
const runSchema = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const requestSchema = z.object({
  action: z.enum(["discover", "verify", "unmark", "undo-run"]), companyId: OrgIdSchema.optional(), runId: runSchema.optional(),
  dryRun: z.boolean().default(true), mark: z.boolean().default(false), continuation: z.string().max(2048).optional(),
}).strict().refine(r => r.action === "discover" || (r.companyId !== undefined && r.runId !== undefined))
  // Only the implicit company reads the flag: a named company's own partition is authoritative without one (see project-settings.ts), so marking it would change nothing.
  .refine(r => !r.mark || (r.action === "verify" && r.companyId === IMPLICIT_COMPANY_ID)).refine(r => r.continuation === undefined || r.action === "discover");
const cursorSchema = z.object({ tableName: z.string(), after: AgentXNameSchema }).strict();
const fail = () => new Error("catalog backfill unavailable");
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
interface CompanyDiscovery { companyId: string; indexed: string[]; missing: string[]; conflicts: string[] }
export interface CatalogBackfillReport {
  ok: boolean; written: number; error?: "invalid_input" | "unavailable" | "conflict";
  companies?: CompanyDiscovery[]; mappings?: Array<{ companyId: string; projectNames: string[] }>;
  continuation?: string; missing?: string[]; extra?: string[]; conflicts?: string[];
  deleteCount?: number;
}
// ONE total I/O budget, including history, core copies and all transaction writes.
function bounded(deps: CoreBackfillDependencies) {
  const clock = deps.now ?? Date.now, began = clock(); let commands = 0, bytes = 0, items = 0;
  const check = () => { if (commands > 500 || bytes > 2_000_000 || items > 500 || clock() - began > 5000) throw fail(); };
  return { ...deps, documentClient: { async send(command: unknown) {
    commands++; check();
    const response = await deps.documentClient.send(command) as { Item?: Row; Items?: Row[] };
    bytes += Buffer.byteLength(JSON.stringify(response) ?? ""); items += (response.Item === undefined ? 0 : 1) + (response.Items?.length ?? 0); check();
    return response;
  } } };
}
type Deps = ReturnType<typeof bounded>;
async function get(deps: Deps, key: { pk: string; sk: string }) {
  return (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }))).Item;
}
async function page(deps: Deps, pk: string, prefix: string, limit: number, after?: Row) {
  return deps.documentClient.send(new QueryCommand({ TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: { ":pk": pk, ":prefix": prefix }, ConsistentRead: true, Limit: limit, ScanIndexForward: true,
    ...(after === undefined ? {} : { ExclusiveStartKey: after }) })) as Promise<{ Items?: Row[]; LastEvaluatedKey?: Row }>;
}
async function all(deps: Deps, pk: string, prefix: string) {
  const rows: Row[] = []; let after: Row | undefined;
  do {
    const result = await page(deps, pk, prefix, 100, after);
    rows.push(...result.Items ?? []);
    if (result.LastEvaluatedKey !== undefined && canonicalJson(result.LastEvaluatedKey) === canonicalJson(after ?? null)) throw fail();
    after = result.LastEvaluatedKey;
  } while (after !== undefined);
  return rows;
}
function nameOf(row: Row) {
  const name = AgentXNameSchema.parse(typeof row["sk"] === "string" && row["sk"].startsWith("PROJECT#") ? row["sk"].slice(8) : undefined);
  if (row["entityType"] !== "PROJECT_CATALOG" || row["name"] !== name || !revision.safeParse(row["latestRevision"]).success) throw fail();
  return name;
}
/** A row of the company's own catalog partition: Code's writers and the switch-over move may leave `name` out (the sort key carries it). */
function ownNameOf(row: Row) {
  const name = AgentXNameSchema.parse(typeof row["sk"] === "string" && row["sk"].startsWith("PROJECT#") ? row["sk"].slice(8) : undefined);
  if (row["entityType"] !== "PROJECT_CATALOG" || (Object.hasOwn(row, "name") && row["name"] !== name) || !revision.safeParse(row["latestRevision"]).success) throw fail();
  return name;
}
function coreMatches(core: Row, source: Row, companyId: string) {
  const content = (row: Row) => Object.fromEntries(Object.entries(row).filter(([key]) => !["pk", "sk", "companyId", "backfillRunId"].includes(key)));
  return core["companyId"] === companyId && recordInCompany(source, companyId) && canonicalJson(content(core)) === canonicalJson(content(source));
}
function fence(row: Row | undefined) {
  if (row === undefined) return { ConditionExpression: "attribute_not_exists(pk)" };
  const names: Record<string, string> = {}, values: Record<string, unknown> = {};
  const terms = Object.keys(row).filter(k => k !== "pk" && k !== "sk").sort().map((key, index) => {
    names[`#f${index}`] = key; values[`:f${index}`] = row[key]; return `#f${index} = :f${index}`;
  });
  return { ConditionExpression: ["attribute_exists(pk)", ...terms].join(" AND "),
    ...(terms.length === 0 ? {} : { ExpressionAttributeNames: names, ExpressionAttributeValues: values }) };
}
async function discover(deps: Deps, continuation?: string): Promise<CatalogBackfillReport> {
  let after: Row | undefined;
  if (continuation !== undefined) {
    if (!/^[A-Za-z0-9_-]+$/.test(continuation)) throw fail();
    const bytes = Buffer.from(continuation, "base64url"), cursor = cursorSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (bytes.toString("base64url") !== continuation || cursor.tableName !== deps.tableName || Buffer.from(canonicalJson(cursor)).toString("base64url") !== continuation) throw fail();
    after = { pk: PROJECT_CATALOG_PK, sk: `PROJECT#${cursor.after}` };
  }
  const result = await page(deps, PROJECT_CATALOG_PK, "PROJECT#", 100, after);
  const companies = new Map<string, CompanyDiscovery>();
  let last: string | undefined;
  for (const row of result.Items ?? []) {
    const name = nameOf(row); last = name;
    const history = await all(deps, `PROJECT#${name}`, "REV#"), latest = history.at(-1);
    if (latest === undefined || latest["entityType"] !== "PROJECT") throw fail();
    const companyId = OrgIdSchema.parse(latest["companyId"] ?? IMPLICIT_COMPANY_ID);
    const company = companies.get(companyId) ?? { companyId, indexed: [], missing: [], conflicts: [] };
    companies.set(companyId, company);
    const indexed = await get(deps, orgProjectCatalogKey(companyId, name));
    if (indexed === undefined) company.missing.push(name);
    else if (indexed["companyId"] !== companyId || indexed["entityType"] !== "PROJECT_CATALOG" || indexed["name"] !== name || !revision.safeParse(indexed["latestRevision"]).success) company.conflicts.push(name);
    else company.indexed.push(name);
    // Attribution of EVERY revision is exposed before L4 can copy older repositories (D3).
    const definition = latest["definition"] as { name?: unknown; revision?: unknown } | undefined;
    let conflict = definition?.name !== name || definition.revision !== row["latestRevision"];
    for (const source of history) {
      const def = StoredProjectDefinitionSchema.safeParse(source["definition"]);
      if (!recordInCompany(source, companyId) || source["entityType"] !== "PROJECT" || !def.success || def.data.name !== name) { conflict = true; continue; }
      const copy = await get(deps, projectRevisionKey(companyId, name, def.data.revision));
      if (copy !== undefined && !coreMatches(copy, source, companyId)) conflict = true;
    }
    if (conflict) {
      company.indexed = company.indexed.filter(n => n !== name); company.missing = company.missing.filter(n => n !== name);
      if (!company.conflicts.includes(name)) company.conflicts.push(name);
    }
  }
  if (result.LastEvaluatedKey !== undefined && last === undefined) throw fail();
  const groups = [...companies.values()].sort((a, b) => a.companyId.localeCompare(b.companyId));
  return { ok: true, written: 0, companies: groups,
    mappings: groups.filter(c => c.conflicts.length === 0).map(c => ({ companyId: c.companyId, projectNames: [...c.indexed, ...c.missing].sort() })),
    ...(result.LastEvaluatedKey === undefined ? {} : { continuation: Buffer.from(canonicalJson({ tableName: deps.tableName, after: last })).toString("base64url") }) };
}
async function verify(deps: Deps, companyId: string, runId: string, mark: boolean, dryRun: boolean): Promise<CatalogBackfillReport> {
  const catalog = await all(deps, PROJECT_CATALOG_PK, "PROJECT#"), own = await all(deps, orgProjectCatalogPk(companyId), "PROJECT#");
  const expected = new Map<string, number>(), conflicts: string[] = [];
  for (const row of catalog) {
    const name = nameOf(row), history = await all(deps, `PROJECT#${name}`, "REV#");
    const latest = history.at(-1);
    if (latest === undefined) throw fail();
    if (!recordInCompany(latest, companyId)) continue;
    const definition = latest["definition"] as { revision?: unknown } | undefined;
    if (definition?.revision !== row["latestRevision"]) { conflicts.push(name); continue; }
    expected.set(name, row["latestRevision"] as number);
    for (const source of history) {
      const def = source["definition"] as { name?: unknown; revision?: unknown } | undefined;
      if (source["entityType"] !== "PROJECT" || def?.name !== name || !revision.safeParse(def.revision).success || !recordInCompany(source, companyId)) { conflicts.push(name); break; }
      const copy = await get(deps, projectRevisionKey(companyId, name, def.revision as number));
      if (copy === undefined || !coreMatches(copy, source, companyId)) { conflicts.push(name); break; }
    }
  }
  // The company partition is authoritative: a project registered there directly (no shared row) is the company's own and is reported as `extra`, not a failure. Every own row must
  // still be well formed, name no other company, and select a revision of that name in the same partition; every shared project of this company must be in it, not behind it.
  const actual = new Set<string>();
  for (const row of own) {
    const name = ownNameOf(row); actual.add(name);
    const selected = await get(deps, projectRevisionKey(companyId, name, row["latestRevision"] as number));
    const selectedDefinition = selected?.["definition"] as { name?: unknown; revision?: unknown } | undefined;
    if (selectedDefinition?.name !== name || selectedDefinition.revision !== row["latestRevision"] || !ownPartitionRow(row, companyId) || (expected.has(name) && (row["latestRevision"] as number) < expected.get(name)!)
      || selected?.["entityType"] !== "PROJECT" || !ownPartitionRow(selected, companyId)) conflicts.push(name);
  }
  const missing = [...expected.keys()].filter(n => !actual.has(n)), extra = [...actual].filter(n => !expected.has(n));
  if (missing.length || conflicts.length) return { ok: false, written: 0, missing, extra, conflicts: [...new Set(conflicts)] };
  if (mark && own.length > 99) throw fail();
  if (!mark || dryRun) return { ok: true, written: 0, missing, extra, conflicts };
  const writes: Write[] = own.map((row, index) => index === 0
    ? { Put: { TableName: deps.tableName, Item: { ...row, backfillMarked: true }, ...fence(row) } }
    : { ConditionCheck: { TableName: deps.tableName, Key: orgProjectCatalogKey(companyId, ownNameOf(row)), ...fence(row) } });
  writes.push({ Put: { TableName: deps.tableName, Item: { ...orgSettingsKey(companyId, "PROJECT_CATALOG_INDEX"), verifiedAt: new Date((deps.now ?? Date.now)()).toISOString(), count: own.length, runId }, ...fence(undefined) } });
  await deps.documentClient.send(new TransactWriteCommand({ TransactItems: writes }));
  return { ok: true, written: 1 };
}
async function undo(deps: Deps, companyId: string, runId: string, dryRun: boolean): Promise<CatalogBackfillReport> {
  const flagKey = orgSettingsKey(companyId, "PROJECT_CATALOG_INDEX");
  if (await get(deps, flagKey) !== undefined) return { ok: false, written: 0, error: "conflict" };
  const rows = await all(deps, orgProjectCatalogPk(companyId), "PROJECT#"), writes: Write[] = [];
  // Rows in the partition without `companyId` are the company's own (Code's writers, the switch-over move) and are never this run's: they are kept. Any row naming another company
  // refuses the whole undo; a row this run tagged always carries the company (the run wrote it).
  for (const row of rows) {
    const name = ownNameOf(row);
    if (row["backfillMarked"] === true) return { ok: false, written: 0, error: "conflict" };
    if (!ownPartitionRow(row, companyId) || (row["backfillRunId"] === runId && row["companyId"] !== companyId)) return { ok: false, written: 0, error: "conflict" };
    const copies = await all(deps, projectRevisionKey(companyId, name, 1).pk, "REV#");
    const tagged = copies.filter(copy => copy["backfillRunId"] === runId);
    if (tagged.length > 0 && (row["backfillRunId"] !== runId || copies.some(copy => copy["backfillRunId"] !== runId))) return { ok: false, written: 0, error: "conflict" };
    for (const copy of copies) {
      if (!ownPartitionRow(copy, companyId) || (copy["backfillRunId"] === runId && copy["companyId"] !== companyId)) return { ok: false, written: 0, error: "conflict" };
      if (copy["backfillRunId"] !== runId) continue;
      const def = copy["definition"] as { revision?: unknown } | undefined;
      const rev = revision.parse(def?.revision);
      writes.push({ Delete: { TableName: deps.tableName, Key: projectRevisionKey(companyId, name, rev), ...fence(copy) } });
    }
    if (row["backfillRunId"] === runId) {
      const key = projectMetaKey(companyId, name), meta = await get(deps, key);
      if (companyId === IMPLICIT_COMPANY_ID) {
        // Undoing only a mirror: prove the authoritative legacy revision for EVERY removed copy at commit.
        for (const copy of tagged) {
          const sourceKey = projectKey(name, revision.parse((copy["definition"] as { revision?: unknown } | undefined)?.revision)), source = await get(deps, sourceKey);
          const content = (value: Row) => Object.fromEntries(Object.entries(value).filter(([field]) => !["pk", "sk", "companyId", "backfillRunId"].includes(field)));
          if (source === undefined || !recordInCompany(source, companyId) || canonicalJson(content(source)) !== canonicalJson(content(copy))) throw fail();
          writes.push({ ConditionCheck: { TableName: deps.tableName, Key: sourceKey, ...coreProjectSnapshotFence(source) } });
        }
        requireProjectIncarnation(companyId, name, meta);
        if (meta?.["status"] === "deleted") throw fail();
        writes.push({ ConditionCheck: { TableName: deps.tableName, Key: key, ...coreProjectSnapshotFence(meta) } });
      } else {
        writes.push({ Put: { TableName: deps.tableName, Item: projectIncarnationTombstone(companyId, name, meta, row), ...coreProjectSnapshotFence(meta) } });
      }
    }
    if (row["backfillRunId"] === runId && companyId !== IMPLICIT_COMPANY_ID) writes.push({ Delete: { TableName: deps.tableName, Key: orgProjectCatalogKey(companyId, name), ...fence(row) } });
  }
  if (writes.length > 99) throw fail();
  if (!dryRun && writes.length > 0) await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
    { ConditionCheck: { TableName: deps.tableName, Key: flagKey, ...fence(undefined) } }, ...writes,
  ] }));
  const deleteCount = writes.filter(write => write.Delete !== undefined).length;
  return { ok: true, written: dryRun ? 0 : deleteCount, deleteCount };
}
/** Input is runtime-checked; customer identifiers appear only in operator reports, never public route errors. */
export async function catalogBackfill(dependencies: CoreBackfillDependencies, value: unknown): Promise<CatalogBackfillReport> {
  const parsed = requestSchema.safeParse(value);
  if (!parsed.success) return { ok: false, written: 0, error: "invalid_input" };
  const request = parsed.data, deps = bounded(dependencies);
  try {
    if (request.action === "discover") return await discover(deps, request.continuation);
    const companyId = request.companyId!, runId = request.runId!;
    if (request.action === "verify") return await verify(deps, companyId, runId, request.mark, request.dryRun);
    if (request.action === "undo-run") return await undo(deps, companyId, runId, request.dryRun);
    const key = orgSettingsKey(companyId, "PROJECT_CATALOG_INDEX"), flag = await get(deps, key);
    if (flag?.["runId"] !== runId) return { ok: false, written: 0, error: "conflict" };
    if (!request.dryRun) await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [{ Delete: { TableName: deps.tableName, Key: key, ...fence(flag) } }] }));
    return { ok: true, written: request.dryRun ? 0 : 1 };
  } catch { return { ok: false, written: 0, error: "unavailable" }; }
}
