// Lessons phase 2 (lessons architecture research Q3, "honest evidence"): the graded evidence behind a lesson's strength, kept as small rows beside the lessons, NEVER inside a lesson row (a lesson row has a strict schema, so a field
// added to it would make a build that has not rolled out yet drop the whole lesson; separate rows are read by this build only, and an older build ignores them).
//
// Rows, under the company's own partition AND the project (`companyScoped`), written only for the company the sink was built for and read back only through the same keys:
//   E#<lesson>#<id>          one piece of evidence (the sort key has NO time, so the same piece written again, a redelivery of a task's end, is the same row and is written once): `for` (a share, 1/k, of one clean merge that settled after the 14-day revert window) or `against` (a person's direct mark, or a correction that came back although the lesson was
//                            loaded). Weight 0 to 1. A REVERT is never a row here: it is not evidence against a lesson (it takes the queued mark back and may raise "under question" elsewhere, `revert-question.ts`).
//   R#<lesson>#<task>        one task's repeat result for the lesson: the task ended with the lesson loaded (`matched`), and whether the correction `back` came although the lesson said it ("the correction stopped coming back").
//   B#<lesson>               the baseline: the marks a lesson already had in its counters when its first evidence row was written (so the first row does not throw them away); it ages out of the window like any evidence.
//   F#<lesson>               the fade state of a lesson that was renewed for a quiet window (`expiry.ts`): how many quiet renewals it has used and when a person was asked.
// A row holds ids, numbers and fixed words only: no title, no words of a lesson or a task, no path, no person. A person erase has nothing to remove; the company purge removes the ORG partition; every row carries its own
// `keepUntil` (checked by the reader, whether or not the store has swept it) and the store's own time-to-live attribute where it names one.
import { createHash } from "node:crypto";
import { companyScoped, when, type DocumentStore, type OrgId } from "@agentx/contracts";
import { EVIDENCE_KEEP_DAYS, FADE_KEEP_DAYS, SIGNALS_ROWS_MAX } from "./scoring-settings.js";
import type { LessonEvidence } from "./strength.js";

const DAY = 86_400_000;
const ID = /^[A-Za-z0-9_-]{4,64}$/u;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
const PAGE = 200;

/** The partition of a project's evidence rows. */
export const evidencePk = (companyId: string, project: string): string => companyScoped(companyId, `LESSON_EVIDENCE#${project}`);
const short = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 24);
const weightOf = (weight: number): number => Math.round(Math.min(1, Math.max(0, weight)) * 10_000) / 10_000;

export interface EvidenceNote { workspaceId: string; project: string; lessonId: string; kind: "for" | "against"; /** 0 (nothing) to 1 (a whole mark). */ weight: number; at: number; /** A stable name of this one piece (a task id, a person's mark reference): the same id written twice is one row. */ id: string }
export interface RepeatNote { workspaceId: string; project: string; lessonId: string; taskId: string; /** The correction came back although the lesson was loaded. */ back: boolean; at: number }
export interface FadeState { renewals: number; askedAt?: number | undefined; at: number }

/** What writes the evidence rows. Every method returns false rather than throwing: counting is information and never fails the mark that caused it. */
export interface EvidenceSink {
  note(input: EvidenceNote): Promise<boolean>;
  repeat(input: RepeatNote): Promise<boolean>;
  /** The marks the lesson's counters held before its first evidence row; written once (the first writer decides), a no-op after. */
  baseline(input: { workspaceId: string; project: string; lessonId: string; forW: number; againstW: number; at: number }): Promise<boolean>;
  /** The fade state, undefined when there is none, and "unreadable" when the store could not be read (the sweep then decides nothing). */
  readFade(key: { workspaceId: string; project: string }, lessonId: string): Promise<FadeState | undefined | "unreadable">;
  writeFade(key: { workspaceId: string; project: string }, lessonId: string, state: { renewals: number; askedAt?: number | undefined }, now: number): Promise<boolean>;
}

type Store = Pick<DocumentStore, "put" | "get" | "query"> & { ttlAttribute?: string | undefined };

/** The document-store sink of one company. A call for another company, or a project, lesson or task that is not shaped as one, writes nothing. */
export function documentEvidenceSink(store: Store, companyId: OrgId): EvidenceSink {
  const ttl = (at: number, days: number): Record<string, number> => (store.ttlAttribute === undefined ? {} : { [store.ttlAttribute]: Math.floor(at / 1000) + days * 86_400 });
  const mine = (input: { workspaceId: string; project: string; lessonId: string; at?: number }): boolean => input.workspaceId === companyId && NAME.test(input.project) && ID.test(input.lessonId) && (input.at === undefined || (Number.isFinite(input.at) && input.at > 0));
  return {
    async note(input) {
      if (!mine(input) || !Number.isFinite(input.weight) || input.weight <= 0 || input.id.length === 0) return false;
      try {
        // The key holds no time: the same piece (kind and id) is one row, however often and whenever it is delivered; the first delivery decides its time.
        await store.put({
          item: {
            pk: evidencePk(companyId, input.project), sk: `E#${input.lessonId}#${short(`${input.kind}\u0000${input.id}`)}`, entityType: "LESSON_EVIDENCE", kind: input.kind, project: input.project, lessonId: input.lessonId,
            w: weightOf(input.weight), at: input.at, keepUntil: input.at + EVIDENCE_KEEP_DAYS * DAY, ...ttl(input.at, EVIDENCE_KEEP_DAYS),
          },
          condition: when.absent(),
        });
        return true;
      } catch { return false; }
    },
    async baseline(input) {
      // Kept as long as the fade state (far longer than the evidence window; the reader ages it out by its own time), so the marker is never swept and written again (that would count every row still in the window twice). Written even when both are 0: it is the marker that says "this lesson's evidence rows begin here", so a mark made later is never counted twice (by its row and by the baseline).
      if (!mine(input) || !Number.isFinite(input.forW) || !Number.isFinite(input.againstW)) return false;
      try {
        await store.put({
          item: {
            pk: evidencePk(companyId, input.project), sk: `B#${input.lessonId}`, entityType: "LESSON_EVIDENCE", kind: "baseline", project: input.project, lessonId: input.lessonId,
            forW: Math.min(10_000, Math.max(0, Math.floor(input.forW))), againstW: Math.min(10_000, Math.max(0, Math.floor(input.againstW))), at: input.at, keepUntil: input.at + FADE_KEEP_DAYS * DAY, ...ttl(input.at, FADE_KEEP_DAYS),
          },
          condition: when.absent(),
        });
        return true;
      } catch { return false; }
    },
    async repeat(input) {
      if (!mine(input) || !ID.test(input.taskId.replace(/-/gu, "_"))) return false;
      try {
        const result = await store.put({
          item: {
            pk: evidencePk(companyId, input.project), sk: `R#${input.lessonId}#${input.taskId}`, entityType: "LESSON_EVIDENCE", kind: "repeat", project: input.project, lessonId: input.lessonId, taskId: input.taskId,
            matched: true, back: input.back, at: input.at, keepUntil: input.at + EVIDENCE_KEEP_DAYS * DAY, ...ttl(input.at, EVIDENCE_KEEP_DAYS),
          },
          // A task that matched is written once as "did not come back"; only a judge's later finding may turn it to "came back", and nothing turns it back (a repeat of the delivery changes nothing).
          ...(input.back ? {} : { condition: when.absent() }),
        });
        return result.applied || input.back;
      } catch { return false; }
    },
    async readFade(key, lessonId) {
      if (key.workspaceId !== companyId || !NAME.test(key.project) || !ID.test(lessonId)) return undefined;
      try {
        const row = await store.get({ pk: evidencePk(companyId, key.project), sk: `F#${lessonId}` });
        if (row === undefined) return undefined;
        if (row["entityType"] !== "LESSON_FADE" || row["lessonId"] !== lessonId || typeof row["renewals"] !== "number" || typeof row["at"] !== "number") return "unreadable";
        return { renewals: row["renewals"], at: row["at"], ...(typeof row["askedAt"] === "number" ? { askedAt: row["askedAt"] } : {}) };
      } catch { return "unreadable"; }
    },
    async writeFade(key, lessonId, state, now) {
      if (key.workspaceId !== companyId || !NAME.test(key.project) || !ID.test(lessonId) || !Number.isInteger(state.renewals) || state.renewals < 0) return false;
      try {
        await store.put({
          item: {
            pk: evidencePk(companyId, key.project), sk: `F#${lessonId}`, entityType: "LESSON_FADE", project: key.project, lessonId, renewals: state.renewals, ...(state.askedAt === undefined ? {} : { askedAt: state.askedAt }), at: now,
            keepUntil: now + FADE_KEEP_DAYS * DAY, ...ttl(now, FADE_KEEP_DAYS),
          },
        });
        return true;
      } catch { return false; }
    },
  };
}

export interface EvidenceTotals {
  evidence: Map<string, LessonEvidence>;
  /** Per lesson: tasks that ended with the lesson loaded, and those where the correction came back. */
  repeats: Map<string, { matched: number; back: number }>;
  /** Lessons asked to be kept after a second quiet window, with the time they were asked. */
  asked: Map<string, number>;
  truncated: boolean;
}

/**
 * Totals of one project's evidence inside the window, counted from that project's rows only (the partition is keyed by company AND project and each row is checked against both again; a row past its `keepUntil`, outside
 * the window or not shaped like a row of this module is left out). Read only and bounded by one total row limit.
 */
export async function readEvidenceTotals(store: Pick<DocumentStore, "query">, input: { companyId: OrgId; project: string; now: number; windowMs: number; rowsMax?: number }): Promise<EvidenceTotals> {
  const out: EvidenceTotals = { evidence: new Map(), repeats: new Map(), asked: new Map(), truncated: false };
  if (!NAME.test(input.project)) return out;
  const pk = evidencePk(input.companyId, input.project);
  const rowsMax = input.rowsMax ?? SIGNALS_ROWS_MAX;
  const since = input.now - input.windowMs;
  const add = (lessonId: string, kind: "for" | "against", w: number): void => {
    const entry = out.evidence.get(lessonId) ?? { forW: 0, againstW: 0 };
    if (kind === "for") entry.forW += w; else entry.againstW += w;
    out.evidence.set(lessonId, entry);
  };
  // Each kind of row is read under its own prefix and its own row budget, so a project with many pieces of evidence still shows every lesson's repeat counts and every question that waits.
  for (const prefix of ["E#", "B#", "R#", "F#"] as const) {
    let read = 0;
    for (let cursor: string | undefined; ;) {
      const take = Math.min(PAGE, rowsMax - read);
      if (take <= 0) { out.truncated = true; break; }
      const page = await store.query({ pk, sk: { op: "beginsWith", prefix }, limit: take, ...(cursor === undefined ? {} : { cursor }) });
      read += Math.max(1, page.items.length);
      for (const row of page.items) {
        if (row["pk"] !== pk || row["project"] !== input.project || typeof row["lessonId"] !== "string" || !ID.test(row["lessonId"]) || typeof row["keepUntil"] !== "number" || row["keepUntil"] <= input.now) continue;
        const lessonId = row["lessonId"];
        const at = row["at"];
        if (typeof at !== "number" || !Number.isFinite(at)) continue;
        if (row["entityType"] === "LESSON_FADE") {
          if (prefix === "F#" && typeof row["askedAt"] === "number") out.asked.set(lessonId, row["askedAt"]);
          continue;
        }
        if (row["entityType"] !== "LESSON_EVIDENCE" || at < since) continue;
        if (prefix === "E#" && (row["kind"] === "for" || row["kind"] === "against")) {
          const w = row["w"];
          if (typeof w === "number" && Number.isFinite(w) && w > 0 && w <= 1) add(lessonId, row["kind"], w);
        } else if (prefix === "B#" && row["kind"] === "baseline") {
          const forW = row["forW"], againstW = row["againstW"];
          if (typeof forW === "number" && Number.isFinite(forW) && forW >= 0) add(lessonId, "for", Math.min(forW, 10_000));
          if (typeof againstW === "number" && Number.isFinite(againstW) && againstW >= 0) add(lessonId, "against", Math.min(againstW, 10_000));
        } else if (prefix === "R#" && row["kind"] === "repeat" && typeof row["taskId"] === "string" && row["matched"] === true && typeof row["back"] === "boolean") {
          const entry = out.repeats.get(lessonId) ?? { matched: 0, back: 0 };
          entry.matched += 1;
          if (row["back"]) entry.back += 1;
          out.repeats.set(lessonId, entry);
        }
      }
      cursor = page.cursor;
      if (cursor === undefined) break;
    }
  }
  return out;
}
