// TE-F3/F3d: the base score cache. An eval's score on the base commit is expensive (model calls), so Rovara keeps the last one it measured, keyed by everything the score depends on. This is NOT TE-C1's baseline: C1 (a
// baseline per base commit, nearest trusted ancestor, trusted writers) will implement the same `BaseScoreCache` seam and reuse `evalBaseCacheKey`; switching is one constructor change, and old records are a cache, so they are
// dropped, not migrated (DECISIONS 152a: nothing to read first).
//
// WHY IT IS SAFE
//   - Every key part is immutable or content-addressed (a commit id, an eval-set hash, a hidden-set hash, a command fingerprint, a catalog row, a model), and the company and project are in it. Change any one and the key
//     changes: a miss and a fresh base run, never a stale score.
//   - Only Rovara's own base round of that very commit writes it (`EvalBaseWriteProvenance`). A value read from a file the coding agent could write is never cached.
//   - Legacy records hold aggregate scores. New records can also hold three question samples; these stay in the company-scoped store and are never returned as private-set agent feedback.
//   - A record that is corrupt, tampered with, filed under the wrong key, another company's, or expired is a miss. A store that is down is a miss (the cache is only an optimisation).
// The store is the existing `DocumentStore` port with company-scoped partitions (no new port, so no DECISIONS 42/63 item): partition `ORG#<company>#EVALBASE`, sort key `K#<key>`, a 30-day expiry.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";
import { EvalQuestionRowsSchema, MeasuresFileEntrySchema } from "./measures-file.js";
import { EVIDENCE_MEASURES_MAX } from "./evidence.js";
import { companyScoped } from "./ports/company-scope.js";
import { DOCUMENT_STORE_LIMITS, when, type DocumentStore, type StoredDocument } from "./ports/document-store.js";
import { sha256HexOf } from "./service-catalog-verify.js";

/** The longest a cached base score is used (DECISIONS 170: "a maximum age"). A project may set it lower (`maxAgeDays`), never higher. */
export const EVAL_BASE_CACHE_TTL_DAYS = 30;
const DAY_SECONDS = 86_400;
const PARTITION = "EVALBASE";
const KEY_DOMAIN = "rovara-eval-base/v1\n";
const COMMAND_DOMAIN = "rovara-eval-command/v1\n";

/** The rounds that can have measured a base score (a working sandbox's round never fills the cache). */
export const EVAL_BASE_ROUND_KINDS = ["check_sealed", "check_unsealed"] as const;

export const EvalBaseRecordSchema = z.object({
  schemaVersion: z.literal(1),
  /** Per-measure base scores and their spread, as the runner reported them in Rovara's own base round. */
  measures: z.array(MeasuresFileEntrySchema).min(1).max(EVIDENCE_MEASURES_MAX),
  questions: EvalQuestionRowsSchema.refine(rows => rows.every(row => row.samples.length === 3), "three saved runs required").optional(),
  caseCount: z.number().int().min(0).max(100_000_000),
  /** The day the base round ran. */
  recordedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  roundKind: z.enum(EVAL_BASE_ROUND_KINDS),
  /** The measures-file schema version the runner wrote. */
  runnerSchemaVersion: z.number().int().min(1).max(1_000),
}).strict();
export type EvalBaseRecord = z.infer<typeof EvalBaseRecordSchema>;

/** Everything a base score depends on. The `hiddenSetHash` is the hidden set's SHA-256, or the word `none`. */
export interface EvalBaseCacheKeyParts {
  readonly company: string;
  readonly project: string;
  /** Writer attestation commit (40/64 hex). V1 keys include it; dependency-keyed V2 reads do not. */
  readonly baseCommit: string;
  /** Trusted hash of ALL code files at this revision; omit only for legacy per-commit records. */
  readonly codeHash?: string;
  /** Pinned scorer/judge, required together with codeHash. */
  readonly judgePin?: string;
  readonly evalSetHash: string;
  readonly hiddenSetHash: string;
  /** `evalCommandFingerprint` of the eval command. */
  readonly commandFingerprint: string;
  /** The catalog row id of the model the eval called. */
  readonly catalogRowId: string;
  readonly model: string;
  /** The EXACT model version the eval called (the provider's snapshot or version id, not the family name). A new version is a new key: the old code is re-run only then (DECISIONS 170). */
  readonly modelVersion: string;
  /** Fingerprint of the rule, pinned judge, image and route used to measure the score. */
  readonly settingsFingerprint: string;
}

const PART_RULES: ReadonlyArray<readonly [keyof EvalBaseCacheKeyParts, RegExp]> = [
  ["company", /^[^#\s]{1,100}$/u],
  ["project", /^[A-Za-z0-9._:-]{1,200}$/u],
  ["baseCommit", /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u],
  ["evalSetHash", /^[a-f0-9]{64}$/u],
  ["hiddenSetHash", /^(?:none|[a-f0-9]{64})$/u],
  ["commandFingerprint", /^[a-f0-9]{64}$/u],
  ["catalogRowId", /^[a-z][a-z0-9-]{0,39}$/u],
  ["model", /^[A-Za-z0-9._:/@+-]{1,200}$/u],
  ["modelVersion", /^[A-Za-z0-9._:/@+-]{1,200}$/u],
  ["settingsFingerprint", /^[a-f0-9]{64}$/u],
];

/** What the runner attests about a base round: it ran in a Rovara-only checkout of the base commit (nothing of the coding agent's), with the working sandbox paused. Without it a base score is neither compared nor cached. */
export interface EvalBaseAttestation {
  readonly checkout: "rovara_only";
  readonly workingSandboxPaused: true;
  readonly baseCommit: string;
}
const ATTESTATIONS = new WeakSet<object>();
/**
 * The ONLY way to make an attestation, branded so a hand-written object is not one. It must be called by the code that makes the Rovara-only checkout of the base commit, AFTER it has checked the working sandbox is paused (the
 * runner seam: TE-B1's fresh round is the natural home). The factory cannot verify that itself; what it prevents is a plain object (a runner's claim, a test double in production code) passing as one.
 */
export function attestRovaraOnlyBaseCheckout(args: { readonly baseCommit: string }): EvalBaseAttestation {
  if (typeof args.baseCommit !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(args.baseCommit)) throw new RangeError("an attestation names the base commit");
  const proof: EvalBaseAttestation = Object.freeze({ checkout: "rovara_only", workingSandboxPaused: true, baseCommit: args.baseCommit });
  ATTESTATIONS.add(proof);
  return proof;
}
/** True for an object `attestRovaraOnlyBaseCheckout` made. */
export function isEvalBaseAttestation(value: unknown): value is EvalBaseAttestation {
  return typeof value === "object" && value !== null && ATTESTATIONS.has(value);
}

/** SHA-256 (hex) of an eval command's text under a fixed domain. */
export function evalCommandFingerprint(command: string): string {
  return sha256HexOf(new TextEncoder().encode(`${COMMAND_DOMAIN}${command}`));
}

/**
 * The cache key: SHA-256 (hex) over a fixed domain and the canonical JSON of the NAMED parts (so text cannot move from one part to another). Throws RangeError naming the part, never its value, when a part is not what it must be.
 */
export function evalBaseCacheKey(parts: EvalBaseCacheKeyParts): string {
  const held = parts as unknown as Record<string, unknown>;
  for (const [name, rule] of PART_RULES) {
    const value = held[name];
    if (typeof value !== "string" || !rule.test(value)) throw new RangeError(`the ${name} is not a valid eval cache key part`);
  }
  const named: Record<string, string> = {};
  for (const [name] of PART_RULES) named[name] = held[name] as string;
  if (parts.codeHash !== undefined || parts.judgePin !== undefined) {
    if (typeof parts.codeHash !== "string" || !/^[a-f0-9]{64}$/u.test(parts.codeHash) || typeof parts.judgePin !== "string" || !/^[a-f0-9]{64}$/u.test(parts.judgePin)) throw new RangeError("the code hash and judge pin are required together");
    delete named["baseCommit"];
    named["codeHash"] = parts.codeHash;
    named["judgePin"] = parts.judgePin;
    return sha256HexOf(new TextEncoder().encode(`rovara-eval-base/v2\n${canonicalJson(named)}`));
  }
  return sha256HexOf(new TextEncoder().encode(`${KEY_DOMAIN}${canonicalJson(named)}`));
}

/** Who wrote a record: only Rovara's own base round, for the commit the key names. */
export interface EvalBaseWriteProvenance {
  readonly writer: "rovara_base_round";
  readonly baseCommit: string;
}

/** Persisted seconds, not milliseconds. A stale host may only finish its own mark. */
export interface EvalBaselineMark { readonly claimId: string; readonly startedAt: number; readonly expiresAt: number; readonly state: "measuring" | "finished" }
export type EvalBaselineStart = { status: "started"; mark: EvalBaselineMark } | { status: "measuring" | "unavailable" };
const MEASURING_SECONDS = 60 * 60;
const validClaimId = (value: unknown): boolean => typeof value === "string" && value.length === 36 && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
/** The read and write seam. TE-C1's baseline store implements the same two calls. */
export interface BaseScoreCache {
  /** The record for these parts, or undefined (a miss, an unreadable record, another company's, an expired one, a store that is down). */
  read(parts: EvalBaseCacheKeyParts): Promise<EvalBaseRecord | undefined>;
  /** Refresh requires these document-backed operations; score-only legacy caches can still serve saved scores. */
  readMeasurement?(parts: EvalBaseCacheKeyParts): Promise<"idle" | "measuring" | "unavailable">;
  startMeasurement?(parts: EvalBaseCacheKeyParts): Promise<EvalBaselineStart>;
  finishMeasurement?(parts: EvalBaseCacheKeyParts, mark: EvalBaselineMark): Promise<void>;
  write(parts: EvalBaseCacheKeyParts, record: EvalBaseRecord, provenance: EvalBaseWriteProvenance): Promise<"stored" | "refused">;
}

/** The cache over the document store, for one company. */
export function createDocumentBaseScoreCache(store: Pick<DocumentStore, "get" | "put" | "ttlAttribute">, options: { companyId: string; now?: () => number; /** A shorter maximum age than the default, in whole days (1 to 30). */ maxAgeDays?: number }): BaseScoreCache {
  const maxAgeDays = Number.isSafeInteger(options.maxAgeDays) && (options.maxAgeDays as number) >= 1 ? Math.min(EVAL_BASE_CACHE_TTL_DAYS, options.maxAgeDays as number) : EVAL_BASE_CACHE_TTL_DAYS;
  const pk = companyScoped(options.companyId, PARTITION);
  const now = options.now ?? Date.now;
  // The attribute the store sweeps, when it sweeps one. The record also keeps its own `expiresAt`, which `read` tests itself (a document past its time may be read until it is swept).
  const ttlAttribute = store.ttlAttribute;
  const keyFor = (parts: EvalBaseCacheKeyParts): string | undefined => {
    if (typeof parts !== "object" || parts === null || parts.company !== options.companyId) return undefined;
    try {
      return evalBaseCacheKey(parts);
    } catch {
      return undefined;
    }
  };
  const seconds = (): number => Math.floor(now() / 1000);
  const validMark = (found: StoredDocument, key: string, time: number): boolean =>
    found.pk === pk && found.sk === `M#${key}` && found["company"] === options.companyId && found["key"] === key && found["kind"] === "evalbase_measurement" &&
    (found["state"] === "measuring" || found["state"] === "finished") &&
    (found["claimId"] === undefined || validClaimId(found["claimId"])) &&
    typeof found["startedAt"] === "number" && Number.isSafeInteger(found["startedAt"]) && found["startedAt"] >= 0 && found["startedAt"] <= time &&
    typeof found["expiresAt"] === "number" && Number.isSafeInteger(found["expiresAt"]) && found["expiresAt"] === found["startedAt"] + MEASURING_SECONDS;
  const markItem = (key: string, mark: EvalBaselineMark): StoredDocument => ({ pk, sk: `M#${key}`, kind: "evalbase_measurement", company: options.companyId, key,
    claimId: mark.claimId, startedAt: mark.startedAt, expiresAt: mark.expiresAt, state: mark.state, ...(ttlAttribute === undefined ? {} : { [ttlAttribute]: mark.expiresAt }) });
  return {
    async readMeasurement(parts) {
      try {
        const key = keyFor(parts); const time = seconds();
        if (key === undefined || !Number.isSafeInteger(time) || time < 0) return "unavailable";
        const found = await store.get({ pk, sk: `M#${key}` });
        if (found === undefined) return "idle";
        if (!validMark(found, key, time)) return "unavailable";
        if (found["claimId"] === undefined) return "idle";
        return found["state"] === "measuring" && (found["expiresAt"] as number) > time ? "measuring" : "idle";
      } catch { return "unavailable"; }
    },
    async startMeasurement(parts) {
      try {
        const key = keyFor(parts); const time = seconds();
        if (key === undefined || !Number.isSafeInteger(time) || time < 0 || !Number.isSafeInteger(time + MEASURING_SECONDS)) return { status: "unavailable" };
        const previous = await store.get({ pk, sk: `M#${key}` });
        if (previous !== undefined && !validMark(previous, key, time)) return { status: "unavailable" };
        const mark: EvalBaselineMark = { claimId: randomUUID(), state: "measuring", startedAt: time, expiresAt: time + MEASURING_SECONDS };
        const written = await store.put({ item: markItem(key, mark), condition: when.or(when.absent(),
          when.and(when.eq("company", options.companyId), when.eq("key", key), when.eq("kind", "evalbase_measurement"),
            when.or(when.notExists("claimId"), when.eq("state", "finished"), when.and(when.eq("state", "measuring"), when.lte("expiresAt", time))))) });
        if (written.applied) return { status: "started", mark };
        const found = await store.get({ pk, sk: `M#${key}` });
        return { status: found !== undefined && validMark(found, key, time) && validClaimId(found["claimId"]) && found["state"] === "measuring" && (found["expiresAt"] as number) > time ? "measuring" : "unavailable" };
      } catch { return { status: "unavailable" }; }
    },
    async finishMeasurement(parts, mark) {
      try {
        const key = keyFor(parts);
        if (key === undefined || typeof mark !== "object" || mark === null || !validClaimId(mark.claimId) || !validMark(markItem(key, mark), key, seconds()) || mark.state !== "measuring") throw new Error("baseline mark could not be finished");
        await store.put({ item: markItem(key, { ...mark, state: "finished" }), condition: when.and(when.eq("claimId", mark.claimId), when.eq("state", "measuring"), when.eq("startedAt", mark.startedAt), when.eq("expiresAt", mark.expiresAt)) });
      } catch { throw new Error("baseline mark could not be finished"); }
    },
    async read(parts) {
      const key = keyFor(parts);
      if (key === undefined) return undefined;
      try {
        const found = await store.get({ pk, sk: `K#${key}` });
        if (found === undefined || found["kind"] !== "evalbase" || found["company"] !== options.companyId || found["key"] !== key || found.sk !== `K#${key}` || found.pk !== pk) return undefined;
        const expiresAt = found["expiresAt"];
        const writtenAt = found["writtenAt"];
        if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || expiresAt <= now() / 1000) return undefined;
        // The reader's own maximum age too: a record written under a longer one is not used past this one.
        if (typeof writtenAt !== "number" || !Number.isFinite(writtenAt) || writtenAt + maxAgeDays * DAY_SECONDS <= now() / 1000) return undefined;
        const parsed = EvalBaseRecordSchema.safeParse(found["record"]);
        return parsed.success ? parsed.data : undefined;
      } catch {
        return undefined;
      }
    },
    async write(parts, record, provenance) {
      if (typeof provenance !== "object" || provenance === null || provenance.writer !== "rovara_base_round" || provenance.baseCommit !== parts.baseCommit) return "refused";
      const key = keyFor(parts);
      if (key === undefined) return "refused";
      const parsed = EvalBaseRecordSchema.safeParse(record);
      if (!parsed.success) return "refused";
      const writtenAt = Math.floor(now() / 1000);
      const expiresAt = writtenAt + maxAgeDays * DAY_SECONDS;
      const item = { pk, sk: `K#${key}`, kind: "evalbase", company: options.companyId, key, writtenAt, expiresAt, ...(ttlAttribute === undefined ? {} : { [ttlAttribute]: expiresAt }), record: parsed.data } as unknown as StoredDocument;
      if (new TextEncoder().encode(JSON.stringify(item)).length > DOCUMENT_STORE_LIMITS.maxDocumentBytes) return "refused";
      try {
        const written = await store.put({ item });
        return written.applied ? "stored" : "refused";
      } catch {
        return "refused";
      }
    },
  };
}
