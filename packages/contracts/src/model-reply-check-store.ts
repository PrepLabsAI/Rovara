// TE-F11: sole owner of MODEL_PROBE_REQUEST. Service over DocumentStore, not a new plug-in port.
// Full customer prompts: O35 laptop storage is local, never uploaded. Hosted use stays unwired until the
// coordinator chooses the customer's bucket or explicit admin opt-in (masked, encrypted, region-bound, audited).
// O35 specifies admin-set retention, not a numeric maximum: this service requires a supplied ceiling and
// additionally refuses more than 30 days. Every probe expires; content-free erase fences do not expire.
import { z } from "zod";
import { INDEX_EXPIRY_ATTRIBUTE } from "./admin.js";
import { companyScoped } from "./ports/company-scope.js";
import { when, type DocumentStore, type StoredDocument } from "./ports/document-store.js";
import type { HostScope } from "./plugins/common.js";
import { ReplyStoreBranchSchema, ReplyStoreFamilySchema, ReplyStoreProjectSchema, ReplyStoreReplyIdSchema } from "./model-reply-store.js";
import { ReplyProbeSchema, type ReplyProbe, type ReplyProbeSource } from "./model-reply-check.js";
import { boundedJson, objectOf } from "./model-reply-check-read.js";
import { sha256HexOf } from "./service-catalog-verify.js";

export const MODEL_PROBE_REQUEST_KIND = "MODEL_PROBE_REQUEST";
export const REPLY_PROBE_MAX_RETENTION_SECONDS = 30 * 86400;
const Query = z.object({ project: ReplyStoreProjectSchema, branch: ReplyStoreBranchSchema, family: ReplyStoreFamilySchema }).strict();
export type ReplyProbeQuery = z.infer<typeof Query>;
const Person = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u);
const Time = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const Put = Query.extend({ personId: Person, probe: ReplyProbeSchema, expiresAt: Time }).strict();
const Read = Query.extend({ replyId: ReplyStoreReplyIdSchema }).strict();
const RecordSchema = Query.extend({ kind: z.literal(MODEL_PROBE_REQUEST_KIND), schemaVersion: z.literal(1), personId: Person, expiresAt: Time, indexExpiresAt: Time, createdAt: Time, body: z.string().max(256 * 1024), probe: ReplyProbeSchema.omit({ frame: true }).extend({ frame: ReplyProbeSchema.shape.frame.omit({ body: true }) }), pk: z.string(), sk: z.string() }).strict();
type Failure = { ok: false; word: "not_allowed" | "not_found" };
const denied = (): Failure => ({ ok: false, word: "not_allowed" });
const missing = (): Failure => ({ ok: false, word: "not_found" });
const hash = (text: string) => sha256HexOf(new TextEncoder().encode(text));
const sortKey = (query: ReplyProbeQuery, replyId: string) => `PROBE#${hash(JSON.stringify([query.project, query.branch, query.family, replyId]))}`;
export interface ReplyProbeStore {
  put(scope: HostScope, input: z.infer<typeof Put>): Promise<{ ok: true } | Failure>;
  read(scope: HostScope, input: z.infer<typeof Read>): Promise<{ ok: true; probe: ReplyProbe } | Failure>;
  list(scope: HostScope, query: ReplyProbeQuery): Promise<{ ok: true; probes: ReplyProbe[] } | Failure>;
  source(scope: HostScope, query: ReplyProbeQuery): ReplyProbeSource;
  erasePerson(scope: HostScope, personId: string): Promise<{ ok: true; deleted: number } | Failure>;
  deleteCompany(scope: HostScope): Promise<{ ok: true; deleted: number } | Failure>;
}
export interface ReplyProbeStoreOptions {
  store: DocumentStore;
  companyOf(scope: HostScope): string | undefined | Promise<string | undefined>;
  /** Epoch seconds from the caller; no clock inside this service. */
  now(): number;
  /** Administrator's O35 retention ceiling. Mandatory; no default. */
  retentionSeconds: number;
}
export function createReplyProbeStore(options: ReplyProbeStoreOptions): ReplyProbeStore {
  const { store } = options;
  const partition = async (scope: HostScope): Promise<string | undefined> => {
    const company = await options.companyOf(scope);
    return typeof company === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(company) ? companyScoped(company, MODEL_PROBE_REQUEST_KIND) : undefined;
  };
  const companyFence = (pk: string) => ({ pk, sk: "ERASED#company" });
  const personFence = (pk: string, person: string) => ({ pk, sk: `ERASED#person#${hash(person)}` });
  const fenced = async (pk: string, person?: string): Promise<boolean> => (await store.get(companyFence(pk))) !== undefined || (person !== undefined && (await store.get(personFence(pk, person))) !== undefined);
  const clock = (): number | undefined => { const n = options.now(); return Number.isSafeInteger(n) && n > 0 ? n : undefined; };
  async function decode(row: StoredDocument, pk: string, now: number): Promise<ReplyProbe | undefined> {
    const parsed = RecordSchema.safeParse(row); if (!parsed.success) return undefined;
    const r = parsed.data;
    if (r.pk !== pk || r.sk !== sortKey(r, r.probe.replyId) || r.expiresAt <= now || r.indexExpiresAt !== r.expiresAt || r.createdAt > now || r.expiresAt - r.createdAt > REPLY_PROBE_MAX_RETENTION_SECONDS || r.probe.family !== r.family || r.probe.rowId !== r.probe.frame.row || r.probe.frame.headers.length !== 0 || r.probe.frame.query !== "" || await fenced(pk, r.personId)) return undefined;
    if (objectOf(boundedJson(r.body)?.value) === undefined) return undefined;
    return { ...r.probe, frame: { ...r.probe.frame, body: new TextEncoder().encode(r.body) } };
  }
  /** All company probes, bounded to 20 pages. A truncated scan refuses, never reports success. */
  async function rows(pk: string): Promise<StoredDocument[] | undefined> {
    const all: StoredDocument[] = []; let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = await store.query({ pk, sk: { op: "beginsWith", prefix: "PROBE#" }, limit: 1000, ...(cursor === undefined ? {} : { cursor }) });
      if (result.items.some((r) => r.pk !== pk || !r.sk.startsWith("PROBE#"))) return undefined;
      all.push(...result.items); cursor = result.cursor;
      if (cursor === undefined) return all;
    }
    return undefined;
  }
  async function erase(scope: HostScope, person?: string): Promise<{ ok: true; deleted: number } | Failure> {
    try {
      const pk = await partition(scope); if (pk === undefined || (person !== undefined && !Person.safeParse(person).success)) return denied();
      // Fence FIRST. Concurrent puts check both fences in the same transaction as their write.
      const fence = person === undefined ? companyFence(pk) : personFence(pk, person);
      const previous = await store.get(fence);
      let after = typeof previous?.after === "string" ? previous.after : "PROBE#";
      if (after !== "PROBE#" && !/^PROBE#[0-9a-f]{64}$/u.test(after)) return denied();
      await store.put({ item: { ...fence, erased: true, after } });
      let deleted = 0; let cursor: string | undefined;
      for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
        const page = await store.query({ pk, sk: { op: "gt", value: after }, limit: 1000, ...(cursor === undefined ? {} : { cursor }) });
        if (page.items.some((row) => row.pk !== pk || !/^PROBE#[0-9a-f]{64}$/u.test(row.sk))) return denied();
        for (const row of page.items) if (person === undefined || row.personId === person) {
          const result = await store.delete({ key: { pk, sk: row.sk }, ...(person === undefined ? {} : { condition: when.eq("personId", person) }) });
          if (result.applied) deleted++;
        }
        const last = page.items.at(-1);
        if (last !== undefined) {
          // Persist a content-free key hash, never an adapter's opaque cursor (which could contain data).
          after = last.sk;
          await store.put({ item: { ...fence, erased: true, after } });
          cursor = undefined;
        } else cursor = page.cursor;
        if (page.cursor === undefined) return { ok: true, deleted };
      }
      // Bounded work with progress: the fence keeps reads/writes closed; a retry resumes after the last scanned key.
      return denied();
    } catch { return denied(); }
  }
  const service: ReplyProbeStore = {
    async put(scope, value) {
      try {
        const input = Put.safeParse(value); const pk = await partition(scope); const now = clock(); const retention = options.retentionSeconds;
        if (!input.success || pk === undefined || now === undefined || !Number.isSafeInteger(retention) || retention <= 0 || retention > REPLY_PROBE_MAX_RETENTION_SECONDS) return denied();
        const { probe, personId, expiresAt, ...query } = input.data;
        if (expiresAt <= now || expiresAt - now > retention || probe.family !== query.family || probe.rowId !== probe.frame.row || probe.frame.headers.length !== 0 || probe.frame.query !== "" || probe.frame.body.byteLength > 256 * 1024) return denied();
        const body = new TextDecoder("utf-8", { fatal: true }).decode(probe.frame.body);
        if (objectOf(boundedJson(body)?.value) === undefined) return denied();
        const frame = { row: probe.frame.row, method: probe.frame.method, path: probe.frame.path, query: probe.frame.query, headers: probe.frame.headers };
        const item = { pk, sk: sortKey(query, probe.replyId), ...query, kind: MODEL_PROBE_REQUEST_KIND, schemaVersion: 1, personId, expiresAt, [INDEX_EXPIRY_ATTRIBUTE]: expiresAt, createdAt: now, body, probe: { ...probe, frame } };
        if (new TextEncoder().encode(JSON.stringify(item)).byteLength > 300 * 1024) return denied();
        const result = await store.transact([
          { kind: "check", key: companyFence(pk), condition: when.absent() },
          { kind: "check", key: personFence(pk, personId), condition: when.absent() },
          // Attribution is immutable. Replacing a probe never lets another person launder an erase obligation.
          { kind: "put", item, condition: when.or(when.absent(), when.eq("personId", personId)) },
        ]);
        return result.applied ? { ok: true } : denied();
      } catch { return denied(); }
    },
    async read(scope, value) {
      try {
        const input = Read.safeParse(value); const pk = await partition(scope); const now = clock();
        if (!input.success || pk === undefined || now === undefined) return missing();
        const row = await store.get({ pk, sk: sortKey(input.data, input.data.replyId) });
        const probe = row === undefined ? undefined : await decode(row, pk, now);
        return probe === undefined ? missing() : { ok: true, probe };
      } catch { return missing(); }
    },
    async list(scope, value) {
      try {
        const input = Query.safeParse(value); const pk = await partition(scope); const now = clock();
        if (!input.success || pk === undefined || now === undefined || await fenced(pk)) return missing();
        const held = await rows(pk); if (held === undefined) return denied();
        const probes: ReplyProbe[] = [];
        for (const row of held) {
          if (row.project !== input.data.project || row.branch !== input.data.branch || row.family !== input.data.family) continue;
          const probe = await decode(row, pk, now); if (probe !== undefined) probes.push(probe);
          if (probes.length > 2000) return denied();
        }
        return { ok: true, probes: probes.sort((a, b) => a.replyId < b.replyId ? -1 : a.replyId > b.replyId ? 1 : 0) };
      } catch { return missing(); }
    },
    source(scope, query) { return { async readProbes() { const result = await service.list(scope, query); return result.ok ? result.probes : []; } }; },
    erasePerson: (scope, person) => erase(scope, person),
    deleteCompany: (scope) => erase(scope),
  };
  return service;
}
