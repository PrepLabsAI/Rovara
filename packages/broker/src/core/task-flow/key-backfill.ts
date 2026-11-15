// Offline/operator-only. Deliberately not registered as a core job or wired to any event.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { IMPLICIT_COMPANY_ID, OrgIdSchema, agentXError, orgProjectCatalogPk, workspaceProjectIndexValue, when, type DocumentStore, type StoredDocument } from "@agentx/contracts";
import { legacyWorkspaceKey } from "./legacy-keys.js";
import { workspaceKey } from "./keys.js";

export interface WorkspaceBackfillDeps {
  companyId: string;
  store: DocumentStore;
  now?: () => number;
  /** Operator-owned, stable across pages/restarts. Never a client-supplied key. No wiring in this lane. */
  continuationKey: Uint8Array;
}
export interface WorkspaceBackfillReport { scanned: number; moved: number; skippedActive: number; skippedForeign: number; failed: number; more: boolean; continuation?: string }
const ZERO = "0".repeat(64);
const text = z.string().min(1).max(4096);
const currentSchema = z.object({ id: text, phase: z.enum(["copy", "source", "target", "switch", "resume", "delete"]), after: text.optional(),
  hash: z.string().regex(/^[a-f0-9]{64}$/), count: z.number().int().min(0).max(1_000_000_000),
  expectedHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), expectedCount: z.number().int().min(0).max(1_000_000_000).optional(), metaHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const stateSchema = z.object({ v: z.literal(1), dryRun: z.boolean(), catalogAfter: text.optional(), project: text.optional(), indexCursor: text.optional(), indexDone: z.boolean(), current: currentSchema.optional() }).strict();
type State = z.infer<typeof stateSchema>;
function invalid(): never { throw agentXError("CONFIG_INVALID", "invalid backfill continuation"); }
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
function hash(row: StoredDocument): string {
  const { pk: _pk, ...content } = row;
  void _pk;
  return createHash("sha256").update(canonical(content)).digest("hex");
}
const roll = (previous: string, row: StoredDocument) => createHash("sha256").update(previous).update(hash(row)).digest("hex");
function encode(state: State, key: Uint8Array): string {
  const body = Buffer.from(JSON.stringify(state)).toString("base64url");
  return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}
function decode(value: unknown, key: Uint8Array, dryRun: boolean): State {
  if (typeof value !== "string" || value.length > 32_768 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(value)) return invalid();
  const [body, mac] = value.split(".") as [string, string];
  const expected = createHmac("sha256", key).update(body).digest();
  const received = Buffer.from(mac, "base64url");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return invalid();
  try { const state = stateSchema.parse(JSON.parse(Buffer.from(body, "base64url").toString("utf8"))); if (state.dryRun !== dryRun) return invalid(); return state; } catch { return invalid(); }
}
const owned = (row: StoredDocument): boolean => [row.companyId, row.orgId].every((value) => value === undefined || (OrgIdSchema.safeParse(value).success && value === IMPLICIT_COMPANY_ID));
const eligible = (row: StoredDocument, now: number): boolean => row.status === "CLOSED" && row.activeOperationId === null
  && typeof row.closedAt === "string" && Number.isFinite(Date.parse(row.closedAt)) && Date.parse(row.closedAt) < now - 86_400_000
  && typeof row.updatedAt === "string" && Number.isFinite(Date.parse(row.updatedAt)) && Date.parse(row.updatedAt) < now - 86_400_000;

/** One bounded page: <=25 workspaces, <=500 total row reads/writes, <=8 MiB read bytes, and no new I/O after 5s. */
export async function backfillWorkspaceKeysPage(deps: WorkspaceBackfillDeps, input: { continuation?: string; limit: number; dryRun?: boolean }): Promise<WorkspaceBackfillReport> {
  if (deps.companyId !== IMPLICIT_COMPANY_ID || !(deps.continuationKey instanceof Uint8Array) || deps.continuationKey.byteLength < 32 || deps.continuationKey.byteLength > 128
    || input === null || typeof input !== "object" || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 25 || (input.dryRun !== undefined && typeof input.dryRun !== "boolean")) throw agentXError("CONFIG_INVALID", "invalid backfill request");
  const now = deps.now ?? Date.now; const started = now(); const monotonicStarted = performance.now();
  if (!Number.isFinite(started)) throw agentXError("CONFIG_INVALID", "invalid backfill clock");
  const state: State = input.continuation === undefined ? { v: 1, dryRun: input.dryRun === true, indexDone: false } : decode(input.continuation, deps.continuationKey, input.dryRun === true);
  const report: WorkspaceBackfillReport = { scanned: state.current === undefined ? 0 : 1, moved: 0, skippedActive: 0, skippedForeign: 0, failed: 0, more: false };
  let rows = 0, bytes = 0, visits = state.current === undefined ? 0 : 1, calls = 0;
  const elapsed = () => Math.max(now() - started, performance.now() - monotonicStarted);
  // The port has no cancellation signal. A timeout stops this call's state machine; an uncertain
  // single in-flight write may finish, so every checkpoint safely repeats its last conditional step.
  const withinDeadline = async <T>(call: () => Promise<T>): Promise<T> => {
    const remaining = 5000 - elapsed();
    if (!Number.isFinite(remaining) || remaining <= 0) throw new Error("backfill deadline");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([call(), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("backfill deadline")), remaining); })]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  };
  const store: Pick<DocumentStore, "get" | "query" | "queryIndex" | "put" | "transact" | "delete"> = {
    get: (request) => withinDeadline(() => deps.store.get(request)),
    query: (request) => withinDeadline(() => deps.store.query(request)),
    queryIndex: (request) => withinDeadline(() => deps.store.queryIndex(request)),
    put: (request) => withinDeadline(() => deps.store.put(request)),
    transact: (request) => withinDeadline(() => deps.store.transact(request)),
    delete: (request) => withinDeadline(() => deps.store.delete(request)),
  };
  const budget = (reserve = 1) => rows + reserve <= 500 && bytes <= 8 * 1024 * 1024 - 8 * 400 * 1024 && calls + reserve <= 1000 && elapsed() < 5000;
  const counted = <T extends StoredDocument | undefined>(row: T): T => { rows++; if (row !== undefined) bytes += Buffer.byteLength(JSON.stringify(row)); return row; };
  const get = async (key: { pk: string; sk: string }) => { calls++; return counted(await store.get(key)); };
  const more = (): WorkspaceBackfillReport => ({ ...report, more: true, continuation: encode(state, deps.continuationKey) });
  const finish = () => { delete state.current; };
  try {
    while (budget(10)) {
      if (state.current === undefined) {
        if (visits >= input.limit) return more();
        if (state.project === undefined) {
          calls++;
          const catalog = await store.query({ pk: orgProjectCatalogPk(IMPLICIT_COMPANY_ID), sk: state.catalogAfter === undefined ? { op: "beginsWith", prefix: "PROJECT#" } : { op: "gt", value: state.catalogAfter }, limit: 1 });
          const row = catalog.items[0]; rows += catalog.items.length;
          if (row === undefined) return report;
          bytes += Buffer.byteLength(JSON.stringify(row));
          if (!row.sk.startsWith("PROJECT#")) return report;
          state.catalogAfter = row.sk; state.project = row.sk.slice("PROJECT#".length); state.indexDone = false; delete state.indexCursor;
        }
        if (state.indexDone) { delete state.project; continue; }
        calls++;
        const page = await store.queryIndex({ index: "byWorkspaceProject", partition: workspaceProjectIndexValue(IMPLICIT_COMPANY_ID, state.project), limit: 1, ...(state.indexCursor === undefined ? {} : { cursor: state.indexCursor }) });
        rows += page.items.length; bytes += Buffer.byteLength(JSON.stringify(page.items));
        const advanceIndex = () => {
          if (page.cursor === undefined) { state.indexDone = true; delete state.indexCursor; } else state.indexCursor = page.cursor;
        };
        const listed = page.items[0];
        if (listed === undefined) { advanceIndex(); continue; }
        visits++; report.scanned++;
        // Re-read only legacy META. Advance the index checkpoint only after this read succeeds:
        // an interrupted read must retry this workspace, including the final item of the index.
        if (typeof listed.id !== "string" || listed.pk !== legacyWorkspaceKey(listed.id).pk || listed.sk !== "META") { advanceIndex(); continue; }
        const meta = await get(legacyWorkspaceKey(listed.id));
        advanceIndex();
        if (meta === undefined) continue;
        if (!owned(meta)) { report.skippedForeign++; continue; }
        if (!eligible(meta, started)) { report.skippedActive++; continue; }
        if (state.dryRun) continue;
        state.current = { id: listed.id, phase: "copy", hash: ZERO, count: 0, metaHash: hash(meta) };
      }
      const current = state.current;
      const legacy = legacyWorkspaceKey(current.id), scoped = workspaceKey(IMPLICIT_COMPANY_ID, current.id);
      const meta = await get(legacy);
      if (meta === undefined) { finish(); continue; }
      if (!owned(meta)) { report.skippedForeign++; finish(); continue; }
      if (!eligible(meta, started) || hash(meta) !== current.metaHash) { report.skippedActive++; finish(); continue; }
      const targetMeta = await get(scoped);
      if (targetMeta !== undefined && hash(targetMeta) !== current.metaHash) { report.failed++; finish(); continue; }
      // A previous call may have crashed after publishing META. Only verified, matching remnants may be removed.
      if (targetMeta !== undefined && current.phase !== "delete" && current.phase !== "resume") { current.phase = "resume"; delete current.after; }
      if (current.phase === "switch") {
        calls++; rows += 2;
        const written = await store.transact([
          { kind: "check", key: legacy, condition: when.and(when.eq("status", "CLOSED"), when.eq("activeOperationId", null),
            when.eq("updatedAt", meta.updatedAt as string), when.eq("closedAt", meta.closedAt as string),
            meta.companyId === undefined ? when.notExists("companyId") : when.eq("companyId", meta.companyId),
            meta.orgId === undefined ? when.notExists("orgId") : when.eq("orgId", meta.orgId)) },
          { kind: "put", item: { ...meta, pk: scoped.pk }, condition: when.absent() },
        ]);
        if (!written.applied) { report.failed++; finish(); continue; }
        current.phase = "delete"; delete current.after; continue;
      }
      calls++;
      const sourcePk = current.phase === "target" ? scoped.pk : legacy.pk;
      const page = await store.query({ pk: sourcePk, ...(current.after === undefined ? {} : { sk: { op: "gt" as const, value: current.after } }), limit: 1 });
      const row = page.items[0]; rows += page.items.length;
      if (row === undefined) {
        if (current.phase === "delete") {
          calls++; rows++;
          const removed = await store.delete({ key: legacy, condition: when.and(when.eq("status", "CLOSED"), when.eq("activeOperationId", null), when.eq("updatedAt", meta.updatedAt as string)) });
          if (removed.applied) report.moved++; else report.failed++;
          finish(); continue;
        }
        if (current.phase === "resume") { current.phase = "delete"; delete current.after; continue; }
        if (current.phase === "copy") { current.expectedCount = current.count; current.expectedHash = current.hash; current.phase = "source"; }
        else {
          if (current.count !== current.expectedCount || current.hash !== current.expectedHash) { report.failed++; finish(); continue; }
          current.phase = current.phase === "source" ? "target" : "switch";
        }
        current.hash = ZERO; current.count = 0; delete current.after; continue;
      }
      bytes += Buffer.byteLength(JSON.stringify(row));
      if (row.sk !== "META") {
        if (current.phase === "copy") {
          const destination = { pk: scoped.pk, sk: row.sk };
          const existing = await get(destination);
          if (existing !== undefined && hash(existing) !== hash(row)) { report.failed++; finish(); continue; }
          if (existing === undefined) {
            calls++; rows++;
            const written = await store.put({ item: { ...row, pk: scoped.pk }, condition: when.absent() });
            if (!written.applied) { const found = await get(destination); if (found === undefined || hash(found) !== hash(row)) { report.failed++; finish(); continue; } }
          }
        } else if (current.phase === "delete" || current.phase === "resume") {
          const destination = await get({ pk: scoped.pk, sk: row.sk });
          if (destination === undefined || hash(destination) !== hash(row)) { report.failed++; finish(); continue; }
          if (current.phase === "delete") { calls++; rows++; await store.delete({ key: { pk: legacy.pk, sk: row.sk } }); }
        }
        if (current.phase !== "delete") { current.hash = roll(current.hash, row); current.count++; }
      }
      current.after = row.sk;
    }
    return more();
  } catch {
    // State advances only after each confirmed step. The signed checkpoint can repeat a failed/uncertain step safely.
    report.failed++;
    return more();
  }
}
