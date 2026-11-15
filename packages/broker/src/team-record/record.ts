// The Team record in Code (DEC 225/226: engine-side memory, company-scoped): what people decided and said about a project's work, kept per project so later tasks can search it. This first slice keeps:
//   decision         a person's send-back reason or close reason on a task (who decided, what they said);
//   review_feedback  a project member's comment on one of the task's pull requests (a code host comment by an account with write standing);
//   task             the task itself: its title, its person's request and how it ended.
// Search is keyword only (BM25 per best passage, `search-fusion.ts`) over the project's newest rows: no infrastructure. A deployed embedder adds the meaning side later (fused with RRF); the rows do not change.
//
// Company and project: every row lives in the project's partition `teamRecordPk(company, project)`, so a project's erase wipes them with its lessons, and nothing is shared across companies or projects. Every
// entry point takes the company it was built for and refuses any other. Rows hold only words a PERSON of the company wrote (an outsider's words, an agent's words and a bot's are never kept) and a person's
// rows are found by an author pointer (a keyed hash of the person, never the raw id in a key), so erasing a person removes every row they wrote.
//
// Keys (pk `teamRecordPk(company, project)`):
//   TREC#<occurredAt ISO>#<row id>    the row: kind, text (cleaned, capped), task id, author id, source ref, when; expires after RECORD_KEEP_DAYS
//   TRECA#<author hash>#<row id>      the author pointer (the row's sort key), for the person erase
//   TRECS#<source hash>               "this source was recorded" (idempotency: one row per source, however often a task end is heard)
import { createHash } from "node:crypto";
import { OrgIdSchema, queryAll, teamRecordPk, type DocumentStore, type OrgId, type StoredDocument } from "@agentx/contracts";
import { cleanForLearning } from "../lessons/guards.js";
import { bm25PassageScores, keywordNeedles } from "./search-fusion.js";

export const TEAM_RECORD_KINDS = ["decision", "review_feedback", "task"] as const;
export type TeamRecordKind = (typeof TEAM_RECORD_KINDS)[number];

/** The longest text a row keeps. */
export const RECORD_TEXT_MAX = 2_000;
/** How long a row is kept. */
export const RECORD_KEEP_DAYS = 365;
/** The newest rows of a project one search reads (the keyword side's window). */
export const RECORD_SEARCH_WINDOW = 2_000;
/** The most hits one search answers. */
export const RECORD_SEARCH_LIMIT_MAX = 20;
/** The longest snippet a hit carries. */
export const RECORD_SNIPPET_MAX = 280;

const ROW_PREFIX = "TREC#";
/** The most items one store query returns (the document store port's limit). */
const QUERY_PAGE_MAX = 1_000;
const AUTHOR_PREFIX = "TRECA#";
const SOURCE_PREFIX = "TRECS#";

export interface TeamRecordDraft {
  project: string;
  kind: TeamRecordKind;
  text: string;
  taskId: string;
  /** The person who wrote the words (a company person id). */
  authorId: string;
  /** A stable name of where the words came from (`task:<id>:sendback:<request>`, `<repo place>#pr<n>:<comment id>`): one row per source. */
  sourceRef: string;
  /** A link a reader can open (a pull request), if there is one. */
  url?: string | undefined;
  occurredAt: string;
}

export interface TeamRecordRow extends TeamRecordDraft { id: string }

export interface TeamRecordHitRow { row: TeamRecordRow; score: number }

/** Thrown for a call about another company than the record was built for. */
export class TeamRecordCompanyError extends Error {
  constructor() { super("the team record was asked about another company"); this.name = "TeamRecordCompanyError"; }
}

const hex = (value: string, length: number): string => createHash("sha256").update(value).digest("hex").slice(0, length);

export interface TeamRecord {
  readonly companyId: OrgId;
  /** Writes one row; a source already recorded is not written again. Returns whether it wrote. */
  put(draft: TeamRecordDraft): Promise<boolean>;
  /** The project's rows that best match the query (keyword), best first. */
  search(project: string, query: string, limit: number): Promise<TeamRecordHitRow[]>;
  /** Removes every row the person wrote in these projects (the person erase). Returns how many rows were removed. */
  erasePerson(projects: readonly string[], personId: string): Promise<number>;
}

export function createTeamRecord(input: { store: DocumentStore; companyId: OrgId; now: () => number }): TeamRecord {
  const { store, companyId } = input;
  if (!OrgIdSchema.safeParse(companyId).success) throw new TeamRecordCompanyError();
  const pkOf = (project: string): string => teamRecordPk(companyId, project);
  // The author pointer is keyed by a hash of the company and the person, so a raw person id is never part of a key.
  const authorHash = (personId: string): string => hex(`team-record-author\u0000${companyId}\u0000${personId}`, 32);
  const ttl = (): Record<string, number> => (store.ttlAttribute === undefined ? {} : { [store.ttlAttribute]: Math.floor(input.now() / 1000) + RECORD_KEEP_DAYS * 86_400 });

  async function put(draft: TeamRecordDraft): Promise<boolean> {
    if (!(TEAM_RECORD_KINDS as readonly string[]).includes(draft.kind) || draft.project === "" || draft.authorId === "") return false;
    const text = cleanForLearning(draft.text, RECORD_TEXT_MAX);
    if (text.trim() === "") return false;
    const id = hex(`team-record-row\u0000${companyId}\u0000${draft.project}\u0000${draft.sourceRef}`, 24);
    const pk = pkOf(draft.project);
    const sk = `${ROW_PREFIX}${draft.occurredAt}#${id}`;
    const row: StoredDocument = {
      pk, sk, entityType: "TEAM_RECORD_ROW", id, kind: draft.kind, project: draft.project, text, taskId: draft.taskId, authorId: draft.authorId, sourceRef: draft.sourceRef.slice(0, 300),
      occurredAt: draft.occurredAt, ...(draft.url === undefined ? {} : { url: draft.url.slice(0, 500) }), ...ttl(),
    };
    const result = await store.transact([
      { kind: "put", item: { pk, sk: `${SOURCE_PREFIX}${hex(draft.sourceRef, 32)}`, entityType: "TEAM_RECORD_SOURCE", rowSk: sk, ...ttl() }, condition: { op: "notExists", path: ["pk"] } },
      { kind: "put", item: row },
      { kind: "put", item: { pk, sk: `${AUTHOR_PREFIX}${authorHash(draft.authorId)}#${id}`, entityType: "TEAM_RECORD_AUTHOR", rowSk: sk, ...ttl() } },
    ]);
    return result.applied;
  }

  const rowOf = (item: StoredDocument, project: string): TeamRecordRow | undefined => {
    if (item["entityType"] !== "TEAM_RECORD_ROW" || item["project"] !== project || !item.pk.startsWith(pkOf(project))) return undefined;
    const kind = item["kind"];
    if (typeof kind !== "string" || !(TEAM_RECORD_KINDS as readonly string[]).includes(kind)) return undefined;
    const field = (name: string): string | undefined => (typeof item[name] === "string" ? (item[name]) : undefined);
    const id = field("id"), text = field("text"), taskId = field("taskId"), authorId = field("authorId"), sourceRef = field("sourceRef"), occurredAt = field("occurredAt");
    if (id === undefined || text === undefined || taskId === undefined || authorId === undefined || sourceRef === undefined || occurredAt === undefined) return undefined;
    // A row past its time may still be read until it is swept: it is not shown.
    const expiry = store.ttlAttribute === undefined ? undefined : item[store.ttlAttribute];
    if (typeof expiry === "number" && expiry * 1000 <= input.now()) return undefined;
    return { id, project, kind: kind as TeamRecordKind, text, taskId, authorId, sourceRef, occurredAt, ...(field("url") === undefined ? {} : { url: field("url") }) };
  };

  async function search(project: string, query: string, limit: number): Promise<TeamRecordHitRow[]> {
    if (keywordNeedles(query).length === 0) return [];
    // The newest rows, a page (the store's limit) at a time, up to the window.
    const items: StoredDocument[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.query({ pk: pkOf(project), sk: { op: "beginsWith", prefix: ROW_PREFIX }, descending: true, limit: Math.min(QUERY_PAGE_MAX, RECORD_SEARCH_WINDOW - items.length), ...(cursor === undefined ? {} : { cursor }) });
      items.push(...page.items);
      cursor = page.cursor;
    } while (cursor !== undefined && items.length < RECORD_SEARCH_WINDOW);
    const rows = items.flatMap((item) => { const row = rowOf(item, project); return row === undefined ? [] : [row]; });
    const scores = bm25PassageScores(query, rows.map((row) => row.text));
    return rows.map((row, index) => ({ row, score: scores[index] ?? 0 })).filter((hit) => hit.score > 0).sort((a, b) => b.score - a.score).slice(0, Math.max(0, Math.min(limit, RECORD_SEARCH_LIMIT_MAX)));
  }

  async function erasePerson(projects: readonly string[], personId: string): Promise<number> {
    let removed = 0;
    const prefix = `${AUTHOR_PREFIX}${authorHash(personId)}#`;
    for (const project of projects) {
      const pk = pkOf(project);
      for (const pointer of await queryAll(store, { pk, sk: { op: "beginsWith", prefix } })) {
        const rowSk = pointer["rowSk"];
        if (typeof rowSk === "string" && rowSk.startsWith(ROW_PREFIX)) {
          const row = await store.get({ pk, sk: rowSk });
          // The source mark goes too, so nothing about the person's words is left; the row is removed before its pointer (a retry finds the pointer again).
          if (row !== undefined && typeof row["sourceRef"] === "string") await store.delete({ key: { pk, sk: `${SOURCE_PREFIX}${hex(row["sourceRef"], 32)}` } });
          await store.delete({ key: { pk, sk: rowSk } });
          removed += 1;
        }
        await store.delete({ key: { pk, sk: pointer.sk } });
      }
    }
    return removed;
  }

  return { companyId, put, search, erasePerson };
}
