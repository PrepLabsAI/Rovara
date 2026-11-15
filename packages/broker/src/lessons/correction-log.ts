// The correction log: what the "same mistake twice" measure (`metric.ts`) reads on Code. One compact row per correction a member of the company gave on a finished task, written where the task's
// corrections are already worked out (`task-end.ts`), in the company's own partition (`companyScoped(company, "LESSON_CORRECTION#<project>")`):
//   - NO correction text is kept. What is kept: the task, when, the kind, the files it names, the author's id (so the person erase can delete their rows) and a SIGNATURE: keyed hashes of the
//     correction's words, keyed with a random key kept per project (`LESSON_CORRECTION_KEY#<project>`, also in the company's partition), so the words cannot be rebuilt from a word list without that key.
//   - Only a member's own words are logged: a send-back whose words are code's, an erased sender's, an outsider's, and a revert (no words) are not. So the measure's "corrections" are the ones it can judge.
//   - Each correction is written once whatever reflects the task again (a retried delivery, a revert's re-reflection, the nightly pass): a claim row per task and correction comes first.
//   - Rows live 180 days (the store's time-to-live), the measure's longest reach (a 90-day lookback before a month).
// The matcher (`signatureMatcher`) needs no model and spends nothing: two corrections, or a correction and a lesson, are the same advice when their signatures are alike enough and neither says
// "never" where the other does not. A row without a signature cannot be judged: the matcher throws and the measure counts it as unjudged.
import { createHash, createHmac, randomBytes } from "node:crypto";
import { companyScoped, type DocumentStore } from "@agentx/contracts";
import type { TaskCorrection } from "./counters.js";
import { cleanForLearning, polarity } from "./guards.js";
import type { CorrectionMatcher, CorrectionRecord, CorrectionSource } from "./metric.js";
import type { CorrectionKind } from "./ports.js";
import { lessonTextOf, tokenSetOf } from "./similarity.js";

export const CORRECTION_LOG_KEEP_SECONDS = 180 * 86_400;
/** The marker a signature carries when its words say "never" (or do not, avoid, ...). */
export const NEGATED_MARK = "~neg";
const SIGNATURE_MAX = 400;
const SIGNATURE_TEXT_MAX = 2000;
/** The most corrections one task logs. */
const PER_TASK_MAX = 100;
const PAGE = 500;
/** Alike enough: Jaccard of the two signatures at least this, or one contains this share of the other when the smaller has at least `CONTAINMENT_MIN_HASHES` hashes (the v1.2 rule). */
export const SIMILARITY_JACCARD_MIN = 0.45;
export const SIMILARITY_CONTAINMENT_MIN = 0.8;
export const CONTAINMENT_MIN_HASHES = 8;
const KINDS: ReadonlySet<CorrectionKind> = new Set(["send_back", "review_comment", "human_edit", "revert"]);

export const correctionLogPk = (companyId: string, project: string): string => companyScoped(companyId, `LESSON_CORRECTION#${project}`);
const keyRowKey = (companyId: string, project: string) => ({ pk: companyScoped(companyId, `LESSON_CORRECTION_KEY#${project}`), sk: "KEY" });
/** Times are written as 16 digits, so the sort key orders by time. */
const timeSk = (at: number, taskId: string, id: string): string => `C#${String(Math.max(0, Math.floor(at))).padStart(16, "0")}#${taskId}#${id}`;
const claimSk = (taskId: string, id: string): string => `T#${taskId}#${id}`;

type LogStore = Pick<DocumentStore, "get" | "put" | "query" | "delete" | "ttlAttribute">;

/** The project's signature key, or undefined when none was ever made (nothing was logged). */
export async function readSignatureKey(store: Pick<DocumentStore, "get">, companyId: string, project: string): Promise<string | undefined> {
  const row = await store.get(keyRowKey(companyId, project));
  const key = row?.["key"];
  return typeof key === "string" && /^[a-f0-9]{64}$/u.test(key) ? key : undefined;
}

/** The project's signature key, made once (the first writer wins; a later one reads the first's). */
async function signatureKey(store: LogStore, companyId: string, project: string): Promise<string> {
  const found = await readSignatureKey(store, companyId, project);
  if (found !== undefined) return found;
  const key = randomBytes(32).toString("hex");
  const written = await store.put({ item: { ...keyRowKey(companyId, project), entityType: "LESSON_CORRECTION_KEY", key }, condition: { op: "notExists", path: ["pk"] } });
  if (written.applied) return key;
  const again = await readSignatureKey(store, companyId, project);
  if (again === undefined) throw new Error("lessons: the correction key could not be read");
  return again;
}

/** The signature of a text: each distinct word (as `tokenSetOf` reads them) as a keyed hash, sorted, at most 400; and the "never" mark when the text says so. Empty for a text with no words. */
export function signatureOf(text: string, key: string): string[] {
  const clean = cleanForLearning(text, SIGNATURE_TEXT_MAX);
  const hashes = [...tokenSetOf(clean)].map((token) => createHmac("sha256", key).update(token, "utf8").digest("hex").slice(0, 16)).sort().slice(0, SIGNATURE_MAX);
  if (hashes.length === 0) return [];
  return polarity(clean) === "negative" ? [...hashes, NEGATED_MARK] : hashes;
}

/**
 * Logs a finished task's corrections: only a member's own words (a correction with an author and not `fixed`), each once. Best effort for the caller (it never throws for one row: a row that fails is
 * left out). `at` is the time the task's corrections were worked out (the same time the counters use).
 */
export async function logTaskCorrections(store: LogStore, input: { companyId: string; project: string; taskId: string; corrections: readonly TaskCorrection[]; now: number }): Promise<{ logged: number }> {
  const own = input.corrections.filter((c) => c.fixed !== true && c.authorId !== undefined && c.text.trim() !== "").slice(0, PER_TASK_MAX);
  if (own.length === 0) return { logged: 0 };
  const key = await signatureKey(store, input.companyId, input.project);
  const pk = correctionLogPk(input.companyId, input.project);
  const expires = store.ttlAttribute === undefined ? {} : { [store.ttlAttribute]: Math.floor(input.now / 1000) + CORRECTION_LOG_KEEP_SECONDS };
  let logged = 0;
  for (const correction of own) {
    // The correction's id: its kind, author and words, so the same correction met again (another reflection of the task) is the same row.
    const id = createHash("sha256").update(`${correction.kind}\u0000${correction.authorId ?? ""}\u0000${correction.text}`, "utf8").digest("hex").slice(0, 24);
    try {
      const claimed = await store.put({ item: { pk, sk: claimSk(input.taskId, id), entityType: "LESSON_CORRECTION_CLAIM", authorId: correction.authorId!, ...expires }, condition: { op: "notExists", path: ["pk"] } });
      if (!claimed.applied) continue;
      const signature = signatureOf(correction.text, key);
      try {
        await store.put({ item: {
          pk, sk: timeSk(correction.at, input.taskId, id), entityType: "LESSON_CORRECTION", taskId: input.taskId, at: correction.at, kind: correction.kind, member: true,
          authorId: correction.authorId!, paths: correction.paths.slice(0, 50).map((p) => p.slice(0, 500)), signature, ...expires,
        } });
        logged += 1;
      } catch {
        // The claim goes back, so a later reflection of the task logs it.
        await store.delete({ key: { pk, sk: claimSk(input.taskId, id) } }).catch(() => undefined);
      }
    } catch { /* a row that cannot be written is left out */ }
  }
  return { logged };
}

/** The measure's correction source over one company's log. A key of any other company reads nothing. Reads at most `limit` + 1 rows of the range (in pages). */
export function correctionLogSource(store: Pick<DocumentStore, "query">, companyId: string): CorrectionSource {
  return {
    async list(key, range, limit) {
      if (key.workspaceId !== companyId) return { corrections: [], truncated: false };
      const corrections: CorrectionRecord[] = [];
      let cursor: string | undefined;
      const sk = { op: "between" as const, low: timeSk(range.since, "", "").slice(0, 18), high: `${timeSk(range.until, "", "").slice(0, 18)}~` };
      do {
        const page = await store.query({ pk: correctionLogPk(companyId, key.project), sk, limit: PAGE, ...(cursor === undefined ? {} : { cursor }) });
        for (const item of page.items) {
          const record = recordOf(item);
          if (record === undefined || record.at < range.since || record.at >= range.until) continue;
          if (corrections.length >= limit) return { corrections, truncated: true };
          corrections.push(record);
        }
        cursor = page.cursor;
      } while (cursor !== undefined);
      return { corrections, truncated: false };
    },
  };
}

/** A stored row as the measure reads it; anything malformed is left out. */
function recordOf(item: Record<string, unknown>): CorrectionRecord | undefined {
  const { sk, taskId, at, kind, member, paths, signature } = item;
  if (item["entityType"] !== "LESSON_CORRECTION" || typeof sk !== "string" || typeof taskId !== "string" || typeof at !== "number" || !Number.isFinite(at)) return undefined;
  if (typeof kind !== "string" || !KINDS.has(kind as CorrectionKind) || member !== true) return undefined;
  const sig = Array.isArray(signature) ? signature.filter((s): s is string => typeof s === "string").slice(0, SIGNATURE_MAX + 1) : [];
  const files = Array.isArray(paths) ? paths.filter((p): p is string => typeof p === "string") : [];
  return { id: sk, taskId, at, kind: kind as CorrectionKind, member: true, paths: files, signature: sig };
}

function alike(a: readonly string[], b: readonly string[]): boolean {
  if (a.includes(NEGATED_MARK) !== b.includes(NEGATED_MARK)) return false;
  const setA = new Set(a.filter((h) => h !== NEGATED_MARK));
  const setB = new Set(b.filter((h) => h !== NEGATED_MARK));
  if (setA.size === 0 || setB.size === 0) return false;
  let shared = 0;
  for (const h of setA) if (setB.has(h)) shared += 1;
  const jaccard = shared / (setA.size + setB.size - shared);
  const smaller = Math.min(setA.size, setB.size);
  return jaccard >= SIMILARITY_JACCARD_MIN || (smaller >= CONTAINMENT_MIN_HASHES && shared / smaller >= SIMILARITY_CONTAINMENT_MIN);
}

/** The matcher with no model: signatures compared. `key` is the project's signature key (undefined: nothing was logged, and every comparison is unjudged). */
export function signatureMatcher(key: string | undefined): CorrectionMatcher {
  const need = (c: CorrectionRecord): readonly string[] => {
    if (key === undefined || c.signature === undefined || c.signature.length === 0) throw new Error("no signature");
    return c.signature;
  };
  return {
    async sameAsCorrection(earlier, later) { return alike(need(earlier), need(later)); },
    async sameAsLesson(correction, lesson) { return alike(need(correction), signatureOf(lessonTextOf(lesson), key!)); },
  };
}

/** Removes every logged correction (and its claim) one person gave, in one project of one company. Throws on a failed read or delete (the erase retries). */
export async function eraseLoggedCorrections(store: Pick<DocumentStore, "query" | "delete">, companyId: string, project: string, personId: string): Promise<number> {
  const pk = correctionLogPk(companyId, project);
  let removed = 0;
  let cursor: string | undefined;
  do {
    const page = await store.query({ pk, limit: PAGE, ...(cursor === undefined ? {} : { cursor }) });
    for (const item of page.items) {
      if (item["authorId"] !== personId) continue;
      await store.delete({ key: { pk: item.pk, sk: item.sk } });
      removed += 1;
    }
    cursor = page.cursor;
  } while (cursor !== undefined);
  return removed;
}
