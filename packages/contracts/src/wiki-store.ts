// The project wiki's store contract (lead 4, W2; DEC 254zh/254zi; wiki-design-review.md fixes 2, 5, 6, 7). Shapes, limits, keys, fixed words and the store port that the build run (W3),
// the agents' copy (A1), corrections (C1), the MCP read tools (M1), the answer service (J1) and Cloud's Wiki tab (W5) build on.
//
// Rules this contract fixes:
//  - ROWS ONLY, keyed by company AND project: every wiki row lives in ONE partition per company and project, `ORG#<company>#WIKI#<project>` (`wikiPartition`). The company purge deletes
//    every `ORG#<company>#...` partition by key, so it removes the wiki with no purge change; a project's wiki never shares a partition with another project's, so a read keyed by one project
//    cannot return another's rows. No company-wide wiki read exists.
//  - Stored code quotes are short (at most `WIKI_QUOTE_MAX` = 200 characters), redacted, and rows only (a new data class, listed in docs/architecture/company-inventory.md).
//  - A claim is stored only when its source was found (W1's strict prose check); later it can become `changed` (a cited file moved on) or `not_found` (a re-check failed). The words are
//    "source found", never "verified".
//  - Notes: people see a note at once; agents see it only after a project maintainer (or a company owner or admin) approves it.
//  - Flags ("Mark wrong"): a person's optional reason is their words (erased with them); an open flag hides its claim, or its whole page, from agents.
//  - A removed repository (or one Rovara lost access to) has its pages and every cross-repo page that names it deleted at once (`deleteRepository`).
//  - Answer records (J1) expire 30 days after they are written, like Ask's. Expiry is app-driven, not a table TTL: a read treats a record past its `expiresAt` as gone, and a bounded
//    sweep (`expireAnswers`, run on every answer write and schedulable) deletes expired rows.
import { z } from "zod";
import { type OrgId } from "./browser-ids.js";
import { AGENTX_NAME_PATTERN } from "./names.js";

// ---- Limits -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const WIKI_LIMITS = {
  /** Pages in one project's wiki (W0's `pagesPerProject`). */
  pagesPerProject: 300,
  /** The prose of one page (headings, paragraphs and diagrams), in UTF-8 bytes. */
  pageTextBytes: 8_192,
  /** Blocks (headings, paragraphs, diagrams) on one page. */
  blocksPerPage: 120,
  /** Claims on one page, and citations per claim. */
  claimsPerPage: 80,
  citationsPerClaim: 3,
  /** Claims one paragraph or diagram rests on. */
  claimsPerBlock: 12,
  /** Repositories one page names (the overview and "How the repos connect" name several). */
  reposPerPage: 20,
  /** A note's text and a "Mark wrong" reason, in characters. */
  noteChars: 2_000,
  reasonChars: 500,
  /** Notes and open flags kept per page. */
  notesPerPage: 50,
  flagsPerPage: 200,
  /** What a build record keeps of dropped claims and skipped places. */
  droppedPerBuild: 500,
  skippedPerBuild: 200,
} as const;

/** The longest stored code quote, in characters (code points). Longer quotes are cut; every stored quote is redacted first. */
export const WIKI_QUOTE_MAX = 200;
/** How long an answer record is kept (days), like Ask's answers. */
export const WIKI_ANSWER_RETENTION_DAYS = 30;
/** The most expired answer records one sweep deletes. */
export const WIKI_ANSWER_SWEEP_MAX = 200;

// ---- Small shapes -----------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** No control or format characters (a hidden direction mark or a NUL can't ride along in stored text). New lines are allowed only where a schema says so. */
const NO_CONTROL = /^[^\p{Cc}\p{Cf}]*$/u;
const NO_CONTROL_BUT_NEWLINES = /^(?:[^\p{Cc}\p{Cf}]|\n)*$/u;
const line = (max: number) => z.string().min(1).max(max).regex(NO_CONTROL);
const prose = (max: number) => z.string().min(1).max(max).regex(NO_CONTROL_BUT_NEWLINES);
const isoTime = z.string().datetime({ offset: false });

/** A project name (the project's AgentX name) and a repository's name inside the project: the same lower-case pattern, so neither can hold a `#`. */
export const WikiProjectSchema = z.string().regex(AGENTX_NAME_PATTERN);
export const WikiRepoSchema = z.string().regex(AGENTX_NAME_PATTERN);
/** A page id: a lower-case slug (`overview`, `repo-beacon-api`, `beacon-api--billing`). Stable across refreshes, so notes and flags stay on their page. */
export const WikiPageIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,119}$/u);
/** Claim, block, note, flag, build and answer ids: short opaque ids, never a `#`. */
export const WikiIdSchema = z.string().regex(/^[A-Za-z0-9_-]{4,64}$/u);
/** A full commit hash (SHA-1 or SHA-256): every page is written from a fixed commit of each repository. */
export const WikiCommitSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
/** A path inside a repository: relative, no `..` segment, no backslash, no control characters. */
export const WikiPathSchema = z.string().min(1).max(256).regex(NO_CONTROL).refine((path) => !path.startsWith("/") && !path.includes("\\") && !path.split("/").some((part) => part === ".." || part === "." || part === ""), "not a safe path");
export const WikiPersonIdSchema = z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/u);
export const WikiTaskIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);

export const WIKI_PAGE_KINDS = ["overview", "repo", "module", "connections", "data_flow", "glossary", "patterns", "how_to_run", "docs"] as const;
export const WikiPageKindSchema = z.enum(WIKI_PAGE_KINDS);
export type WikiPageKind = z.infer<typeof WikiPageKindSchema>;

/** Which commit of a repository a page was written from. */
export const WikiRepoCommitSchema = z.object({ repo: WikiRepoSchema, commit: WikiCommitSchema }).strict();
export type WikiRepoCommit = z.infer<typeof WikiRepoCommitSchema>;

// ---- Claims and citations --------------------------------------------------------------------------------------------------------------------------------------------------------------

/** Where a claim came from: a file and line at a fixed commit, with a short redacted quote of what is there (for re-checking; never shown to people). */
export const WikiCitationSchema = z.object({
  repo: WikiRepoSchema,
  path: WikiPathSchema,
  commit: WikiCommitSchema,
  line: z.number().int().min(1).max(10_000_000),
  lineEnd: z.number().int().min(1).max(10_000_000).optional(),
  quote: line(WIKI_QUOTE_MAX * 4).refine((quote) => [...quote].length <= WIKI_QUOTE_MAX, "a quote is at most 200 characters"),
}).strict().refine((citation) => citation.lineEnd === undefined || citation.lineEnd >= citation.line, "lineEnd is before line");
export type WikiCitation = z.infer<typeof WikiCitationSchema>;

/**
 * A claim's source state. `found`: W1's strict prose check found every quote at its cited line (the only state a claim is WRITTEN in). `changed`: a cited file changed since (the free
 * freshness check); the claim "may be out of date". `not_found`: a later re-check did not find it; never given to agents.
 */
export const WIKI_SOURCE_STATES = ["found", "changed", "not_found"] as const;
export const WikiSourceStateSchema = z.enum(WIKI_SOURCE_STATES);
export type WikiSourceState = z.infer<typeof WikiSourceStateSchema>;

export const WikiClaimSchema = z.object({
  claimId: WikiIdSchema,
  /** The sentence the claim makes (prose, one line). */
  text: line(600),
  citations: z.array(WikiCitationSchema).min(1).max(WIKI_LIMITS.citationsPerClaim),
  source: WikiSourceStateSchema,
  /** When the source state was last decided. */
  checkedAt: isoTime,
}).strict();
export type WikiClaim = z.infer<typeof WikiClaimSchema>;

// ---- Pages ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** The prose of a page, in order. A paragraph or a diagram names the claims it rests on, so a stale or flagged claim marks (or hides) exactly its paragraph. */
export const WikiBlockSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("heading"), blockId: WikiIdSchema, level: z.union([z.literal(2), z.literal(3)]), text: line(200) }).strict(),
  z.object({ kind: z.literal("paragraph"), blockId: WikiIdSchema, text: prose(4_000), claimIds: z.array(WikiIdSchema).max(WIKI_LIMITS.claimsPerBlock) }).strict(),
  z.object({ kind: z.literal("diagram"), blockId: WikiIdSchema, mermaid: prose(4_000), claimIds: z.array(WikiIdSchema).max(WIKI_LIMITS.claimsPerBlock) }).strict(),
]);
export type WikiBlock = z.infer<typeof WikiBlockSchema>;

const blockTextBytes = (block: WikiBlock): number => Buffer.byteLength(block.kind === "diagram" ? block.mermaid : block.text, "utf8");

/** A page as the build run writes it (W3). The store checks it again: claims all `found`, every block's claims on the page, the size limits, ids unique. */
export const WikiPageWriteSchema = z.object({
  pageId: WikiPageIdSchema,
  kind: WikiPageKindSchema,
  title: line(120),
  summary: line(300),
  /** The parent page in the tree (a module page's repo page). Absent: top level. */
  parentId: WikiPageIdSchema.optional(),
  /** Where the page sits among its siblings. */
  order: z.number().int().min(0).max(10_000),
  /** The repositories the page is about, each at the commit it was written from. A page naming a removed repository is deleted with it. */
  repos: z.array(WikiRepoCommitSchema).min(1).max(WIKI_LIMITS.reposPerPage),
  blocks: z.array(WikiBlockSchema).min(1).max(WIKI_LIMITS.blocksPerPage),
  claims: z.array(WikiClaimSchema).max(WIKI_LIMITS.claimsPerPage),
  /** The build that wrote it. */
  buildId: WikiIdSchema,
}).strict().superRefine((page, ctx) => {
  const issue = (message: string): void => { ctx.addIssue({ code: z.ZodIssueCode.custom, message }); };
  if (page.parentId === page.pageId) issue("a page can't be its own parent");
  const repos = new Set(page.repos.map((entry) => entry.repo));
  if (repos.size !== page.repos.length) issue("a repository is named twice");
  const blockIds = page.blocks.map((block) => block.blockId);
  if (new Set(blockIds).size !== blockIds.length) issue("a block id is used twice");
  const claimIds = page.claims.map((claim) => claim.claimId);
  if (new Set(claimIds).size !== claimIds.length) issue("a claim id is used twice");
  const known = new Set(claimIds);
  for (const block of page.blocks) if (block.kind !== "heading" && block.claimIds.some((id) => !known.has(id))) issue("a block names a claim that is not on the page");
  if (page.blocks.reduce((sum, block) => sum + blockTextBytes(block), 0) > WIKI_LIMITS.pageTextBytes) issue("the page's text is over 8 KB");
  const commits = new Map(page.repos.map((entry) => [entry.repo, entry.commit]));
  for (const claim of page.claims) {
    if (claim.source !== "found") issue("a claim is written only when its source was found");
    for (const citation of claim.citations) if (commits.get(citation.repo) !== citation.commit) issue("a citation is not at the commit the page was written from");
  }
});
export type WikiPageWrite = z.infer<typeof WikiPageWriteSchema>;

/** A page as stored and read back (the write plus when it was written). */
export type WikiPage = WikiPageWrite & { writtenAt: string };

/** One line of the page index: what the tree, `wiki_list` and the agents' `AGENTX-WIKI.md` are made from. No prose, no quotes. */
export const WikiIndexEntrySchema = z.object({
  pageId: WikiPageIdSchema,
  kind: WikiPageKindSchema,
  title: z.string(),
  summary: z.string(),
  parentId: WikiPageIdSchema.optional(),
  order: z.number().int(),
  repos: z.array(WikiRepoCommitSchema),
  writtenAt: isoTime,
  /** How many of the page's claims are `found` and how many `changed` (the free freshness line: "3 of 12 cited claims may be out of date"). */
  claims: z.object({ found: z.number().int().min(0), changed: z.number().int().min(0) }).strict(),
  /** An open "Mark wrong" on the whole page (it is hidden from agents). */
  flagged: z.boolean(),
}).strict();
export type WikiIndexEntry = z.infer<typeof WikiIndexEntrySchema>;

// ---- Notes and flags --------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const WikiNoteApprovalSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("pending") }).strict(),
  z.object({ state: z.literal("approved"), by: WikiPersonIdSchema, at: isoTime }).strict(),
]);
export type WikiNoteApproval = z.infer<typeof WikiNoteApprovalSchema>;

/** A note by a named person, pinned to a page. Shown to people at once; given to agents only once approved. It survives every refresh (it is stored apart from the page). */
export const WikiNoteSchema = z.object({
  noteId: WikiIdSchema,
  pageId: WikiPageIdSchema,
  text: prose(WIKI_LIMITS.noteChars),
  authorId: WikiPersonIdSchema,
  createdAt: isoTime,
  /** A file the note is tied to (its author and the admins are asked to check it when the file changes). */
  file: z.object({ repo: WikiRepoSchema, path: WikiPathSchema }).strict().optional(),
  approval: WikiNoteApprovalSchema,
}).strict();
export type WikiNote = z.infer<typeof WikiNoteSchema>;
export const WikiNoteAddSchema = WikiNoteSchema.pick({ pageId: true, text: true, authorId: true, file: true });
export type WikiNoteAdd = z.infer<typeof WikiNoteAddSchema>;

/** Who said a page or claim was wrong: a person ("Mark wrong", with an optional reason in their words), a task's step, or an answer that found the code disagreed. */
export const WikiFlaggedBySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("person"), personId: WikiPersonIdSchema }).strict(),
  z.object({ kind: z.literal("task"), taskId: WikiTaskIdSchema }).strict(),
  z.object({ kind: z.literal("answer"), answerId: WikiIdSchema }).strict(),
]);
export type WikiFlaggedBy = z.infer<typeof WikiFlaggedBySchema>;

export const WIKI_FLAG_STATES = ["open", "resolved"] as const;
export const WikiFlagSchema = z.object({
  flagId: WikiIdSchema,
  pageId: WikiPageIdSchema,
  /** The claim marked wrong; absent: the whole page. */
  claimId: WikiIdSchema.optional(),
  by: WikiFlaggedBySchema,
  /** A person's reason, in their words (optional; erased with the person). Never set for a task's or an answer's flag. */
  reason: prose(WIKI_LIMITS.reasonChars).optional(),
  createdAt: isoTime,
  state: z.enum(WIKI_FLAG_STATES),
}).strict().refine((flag) => flag.reason === undefined || flag.by.kind === "person", "only a person's flag has a reason");
export type WikiFlag = z.infer<typeof WikiFlagSchema>;
export const WikiFlagAddSchema = z.object({ pageId: WikiPageIdSchema, claimId: WikiIdSchema.optional(), by: WikiFlaggedBySchema, reason: prose(WIKI_LIMITS.reasonChars).optional() }).strict()
  .refine((flag) => flag.reason === undefined || flag.by.kind === "person", "only a person's flag has a reason");
export type WikiFlagAdd = z.infer<typeof WikiFlagAddSchema>;

// ---- Build records ----------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const WIKI_BUILD_KINDS = ["first", "refresh", "nightly"] as const;
export const WIKI_BUILD_STATES = ["running", "done", "stopped", "failed"] as const;
export const WIKI_BUILD_STOP_REASONS = ["cap", "person", "repo_unreadable", "no_ai_key", "unpriced_model", "failed"] as const;
/** Why a claim was dropped (W1's `ClaimDropReason`): fixed words, never the claim's or the file's text. */
export const WIKI_CLAIM_DROP_REASONS = ["uncited", "source_not_found", "unreadable", "code_name_not_in_quote", "too_many_code_names"] as const;
export const WIKI_SKIP_REASONS = ["secret_shaped", "generated", "vendored", "binary", "too_large", "page_cap", "unreadable"] as const;

export const WikiBuildRecordSchema = z.object({
  buildId: WikiIdSchema,
  kind: z.enum(WIKI_BUILD_KINDS),
  state: z.enum(WIKI_BUILD_STATES),
  /** The person who pressed Build or Refresh now; absent for a nightly refresh. */
  startedBy: WikiPersonIdSchema.optional(),
  /** The task the build runs as (paid by the project, on its monthly limit). */
  taskId: WikiTaskIdSchema.optional(),
  startedAt: isoTime,
  endedAt: isoTime.optional(),
  /** The default-branch commit of each repository the build read (fixed for the whole build). */
  repos: z.array(WikiRepoCommitSchema).max(WIKI_LIMITS.reposPerPage * 5),
  counts: z.object({ pagesWritten: z.number().int().min(0), claimsKept: z.number().int().min(0), claimsDropped: z.number().int().min(0), skipped: z.number().int().min(0) }).strict(),
  dropped: z.array(z.object({ pageId: WikiPageIdSchema, reason: z.enum(WIKI_CLAIM_DROP_REASONS) }).strict()).max(WIKI_LIMITS.droppedPerBuild),
  skipped: z.array(z.object({ repo: WikiRepoSchema, path: WikiPathSchema.optional(), reason: z.enum(WIKI_SKIP_REASONS) }).strict()).max(WIKI_LIMITS.skippedPerBuild),
  /** What the build spent so far, in cents. */
  spentCents: z.number().int().min(0).optional(),
  stopReason: z.enum(WIKI_BUILD_STOP_REASONS).optional(),
}).strict();
export type WikiBuildRecord = z.infer<typeof WikiBuildRecordSchema>;

// ---- Answer records (J1 writes them; they expire) ---------------------------------------------------------------------------------------------------------------------------------------

export const WIKI_ANSWER_CHANNELS = ["slack", "web", "linear", "mcp"] as const;
export const WikiAnswerRecordWriteSchema = z.object({
  answerId: WikiIdSchema,
  askedBy: WikiPersonIdSchema,
  channel: z.enum(WIKI_ANSWER_CHANNELS),
  /** The question and the answer, in the asker's and the model's words (erased with the asker; gone after 30 days). */
  question: prose(2_000),
  answer: prose(6_000),
  outcome: z.enum(["answered", "partly", "dont_know"]),
  sources: z.array(WikiCitationSchema).max(8),
  pagesRead: z.array(WikiPageIdSchema).max(20),
}).strict();
export type WikiAnswerRecordWrite = z.infer<typeof WikiAnswerRecordWriteSchema>;
/** `notRight`: the asker pressed "Not right" on this answer (J5; the one change a record gets after it is written). */
export type WikiAnswerRecord = WikiAnswerRecordWrite & { createdAt: string; expiresAt: number; notRight?: boolean };

// ---- Keys: in wiki-keys.ts (the key builders the company inventory reads), re-exported here --------------------------------------------------------------------------------------
export * from "./wiki-keys.js";

// ---- Read routes (W2; Cloud's Wiki tab calls them as the signed-in person) ------------------------------------------------------------------------------------------------------------
//
//   GET /v1/app/projects/{project}/wiki                               the page index and the last build's state
//   GET /v1/app/projects/{project}/wiki/pages/{pageId}                one page: prose, claims (no quotes), notes (pending ones marked), open flag count
//   GET /v1/app/projects/{project}/wiki/pages/{pageId}/sources        the files and lines the page cites, at their commits (no quotes)
//
// Any project role reads (a company owner or admin, or a person with a role on the project). Anyone else, another company's project, a missing project or page and a malformed name all
// get the same 404 in fixed words. A script token is refused (the MCP `wiki` permission is M1's). No route writes; the build (W3/W4) and corrections (C1) bring their own.

export const WIKI_PROJECT_NOT_FOUND = "project not found";
export const WIKI_PAGE_NOT_FOUND = "That wiki page is not there.";
export const WIKI_UNAVAILABLE = "The project wiki could not be read just now. Try again.";
export const WIKI_NOT_FOR_SCRIPT_TOKENS = "A script token cannot read the project wiki.";
/** The fixed footer line under every page. */
export const WIKI_TRUST_LINE = "Written by Rovara from the code. It can be wrong. The code is the truth.";

export const WikiLastBuildSchema = z.object({ buildId: WikiIdSchema, kind: z.enum(WIKI_BUILD_KINDS), state: z.enum(WIKI_BUILD_STATES), startedAt: isoTime, endedAt: isoTime.optional(), stopReason: z.enum(WIKI_BUILD_STOP_REASONS).optional() }).strict();

export const WikiIndexResponseSchema = z.object({
  project: WikiProjectSchema,
  /** `empty`: no page yet ("No wiki yet. A project admin builds it on Project setup."). */
  state: z.enum(["empty", "ready"]),
  pages: z.array(WikiIndexEntrySchema).max(WIKI_LIMITS.pagesPerProject),
  lastBuild: WikiLastBuildSchema.optional(),
}).strict();
export type WikiIndexResponse = z.infer<typeof WikiIndexResponseSchema>;

/** A claim as people see it: no quotes. */
export const WikiShownClaimSchema = z.object({
  claimId: WikiIdSchema,
  text: z.string(),
  source: WikiSourceStateSchema,
  citations: z.array(z.object({ repo: WikiRepoSchema, path: z.string(), commit: WikiCommitSchema, line: z.number().int(), lineEnd: z.number().int().optional() }).strict()),
  /** An open "Mark wrong" on this claim. */
  flagged: z.boolean(),
}).strict();
export type WikiShownClaim = z.infer<typeof WikiShownClaimSchema>;

export const WikiShownNoteSchema = z.object({
  noteId: WikiIdSchema,
  text: z.string(),
  /** The author's display name now ("a former member" once they are erased or gone). */
  author: z.string(),
  createdAt: isoTime,
  file: z.object({ repo: WikiRepoSchema, path: z.string() }).strict().optional(),
  /** `pending`: people see it; agents do not until a maintainer approves it. */
  approval: z.enum(["pending", "approved"]),
}).strict();
export type WikiShownNote = z.infer<typeof WikiShownNoteSchema>;

export const WikiPageResponseSchema = z.object({
  project: WikiProjectSchema,
  page: z.object({
    pageId: WikiPageIdSchema,
    kind: WikiPageKindSchema,
    title: z.string(),
    summary: z.string(),
    parentId: WikiPageIdSchema.optional(),
    repos: z.array(WikiRepoCommitSchema),
    writtenAt: isoTime,
    blocks: z.array(WikiBlockSchema),
    claims: z.array(WikiShownClaimSchema),
  }).strict(),
  notes: z.array(WikiShownNoteSchema),
  /** Open "Mark wrong" flags on the page and its claims (who and why are not shown here). */
  openFlags: z.number().int().min(0),
  trustLine: z.literal(WIKI_TRUST_LINE),
}).strict();
export type WikiPageResponse = z.infer<typeof WikiPageResponseSchema>;

export const WikiSourcesResponseSchema = z.object({
  project: WikiProjectSchema,
  pageId: WikiPageIdSchema,
  /** Each cited file once, with the line ranges cited in it and the claims that cite it. */
  files: z.array(z.object({
    repo: WikiRepoSchema,
    path: z.string(),
    commit: WikiCommitSchema,
    ranges: z.array(z.object({ line: z.number().int(), lineEnd: z.number().int().optional() }).strict()),
    claimIds: z.array(WikiIdSchema),
  }).strict()),
}).strict();
export type WikiSourcesResponse = z.infer<typeof WikiSourcesResponseSchema>;

// ---- The store port (broker: core/wiki/store.ts, `createWikiStore`) ---------------------------------------------------------------------------------------------------------------------

/** Who reads a page: a person (every note, pending marked; every claim) or an agent (approved notes only; flagged and `not_found` claims and the blocks resting on them left out). */
export type WikiAudience = "person" | "agent";

/** What an agent learns of an open flag: which page or claim is marked, never who marked it or why. */
export type WikiAgentFlag = Pick<WikiFlag, "flagId" | "pageId" | "state" | "claimId">;

/** A page as read for an audience. For an agent, a page with an open page-level flag is not returned at all. */
export interface WikiPageRead {
  page: WikiPage;
  notes: WikiNote[];
  /** Open flags on the page and its claims. For audience "person" each is the whole flag (who, why, when); an agent gets only which claim (or the page) is marked. */
  flags: Array<WikiAgentFlag & Partial<Pick<WikiFlag, "by" | "reason" | "createdAt">>>;
  /** Block ids whose claims include a `changed` one ("may be out of date"). */
  staleBlockIds: string[];
}

/**
 * The build run's write seam (W3's `WikiPageSink`): one project's pages in one company, both fixed when the sink is made (`WikiStore.pageSink(project)`). `putPage` writes or rewrites a
 * page (notes and flags on it are kept); `deletePages` deletes pages with their notes and flags (unknown ids are skipped; answers how many went); `listPages` is the page index.
 */
export interface WikiPageSink {
  readonly companyId: OrgId;
  readonly project: string;
  putPage(page: WikiPageWrite): Promise<void>;
  deletePages(pageIds: readonly string[]): Promise<number>;
  listPages(): Promise<WikiIndexEntry[]>;
}

export interface WikiRepositoryDeletion { pages: number; notes: number; flags: number }
export interface WikiPersonErasure { notes: number; reasons: number; answers: number }

/**
 * One company's wiki store. The company is fixed when the store is made (from live membership, never a caller's input); every method takes the project, and every key is built from both.
 * Who may call which method is the caller's check (the routes: any project role reads; C1: contributors add notes and flags, maintainers approve; W3/W4: maintainers build and delete).
 * Inputs are parsed with the schemas above (a bad input is refused, never repaired), except that quotes are redacted and cut to `WIKI_QUOTE_MAX` before they are stored.
 */
export interface WikiStore {
  readonly companyId: OrgId;
  /** The build run's seam for one project (W3). */
  pageSink(project: string): WikiPageSink;
  /** The page index (bounded by `WIKI_LIMITS.pagesPerProject`). */
  readIndex(project: string): Promise<WikiIndexEntry[]>;
  readPage(project: string, pageId: string, audience: WikiAudience): Promise<WikiPageRead | undefined>;
  /** Writes (or rewrites) one page: its index row and body together. Notes and flags on it are kept. Refused past `pagesPerProject` pages. */
  writePage(project: string, page: WikiPageWrite): Promise<void>;
  /** Changes claims' source state (the freshness check, a re-check). Unknown claim ids are ignored; answers how many changed. */
  markClaims(project: string, pageId: string, changes: ReadonlyArray<{ claimId: string; source: WikiSourceState }>): Promise<number>;
  /** Deletes one page with its notes and flags. */
  deletePage(project: string, pageId: string): Promise<boolean>;
  /** Deletes every page naming the repository (single-repo and cross-repo pages), with their notes and flags. */
  deleteRepository(project: string, repo: string): Promise<WikiRepositoryDeletion>;
  /**
   * Deletes every page naming a repository that is not in `current` (the project's repositories now). Every reader that knows the project's current repositories calls it before reading
   * (the read routes do), so a repository removed from the project leaves nothing behind on the next read, whichever path removed it.
   */
  pruneRepositories(project: string, current: readonly string[]): Promise<WikiRepositoryDeletion>;
  /** Deletes the whole project wiki: pages, notes, flags, build records and answer records. */
  deleteWiki(project: string): Promise<number>;
  addNote(project: string, note: WikiNoteAdd): Promise<WikiNote>;
  /** Approves a pending note (the caller checked the approver is a maintainer or a company owner or admin). Answers undefined when there is no such note. */
  approveNote(project: string, pageId: string, noteId: string, by: string): Promise<WikiNote | undefined>;
  deleteNote(project: string, pageId: string, noteId: string): Promise<boolean>;
  addFlag(project: string, flag: WikiFlagAdd): Promise<WikiFlag>;
  /** Resolves every open flag on a page (a refresh rewrote it). */
  resolveFlags(project: string, pageId: string): Promise<number>;
  writeBuild(project: string, record: WikiBuildRecord): Promise<void>;
  readBuild(project: string, buildId: string): Promise<WikiBuildRecord | undefined>;
  /** The most recent build (by start time), if any. */
  lastBuild(project: string): Promise<WikiBuildRecord | undefined>;
  /** Writes an answer record that expires `WIKI_ANSWER_RETENTION_DAYS` after now (and first sweeps expired ones, `expireAnswers`). */
  writeAnswer(project: string, record: WikiAnswerRecordWrite): Promise<WikiAnswerRecord>;
  /** An answer record, or undefined when there is none or it has expired. */
  readAnswer(project: string, answerId: string): Promise<WikiAnswerRecord | undefined>;
  /**
   * The project's answer records that have not expired, in key order (J5: the gap list is read from them), at most `scanMax` of them; `more` is true when there were more rows than that. Records carry their asker's id:
   * the caller must never show it.
   */
  listAnswers(project: string, scanMax: number): Promise<{ records: WikiAnswerRecord[]; more: boolean }>;
  /** The asker presses "Not right" (J5): sets the record's `notRight` once. `marked` the first time, `already` after, undefined when there is no such record, it has expired, or it is not this person's. */
  markAnswerNotRight(project: string, answerId: string, personId: string): Promise<"marked" | "already" | undefined>;
  /** Deletes up to `limit` (default and most `WIKI_ANSWER_SWEEP_MAX`) answer records of the project whose time is past. Answers how many went. */
  expireAnswers(project: string, limit?: number): Promise<number>;
  /** The person-erase step: the person's notes and answer records are deleted and their "Mark wrong" reasons removed, in every given project. */
  erasePerson(projects: readonly string[], personId: string): Promise<WikiPersonErasure>;
}
