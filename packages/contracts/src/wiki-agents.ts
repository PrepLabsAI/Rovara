// Lead 4 A1 (DEC 254zh/254zi; wiki design review fixes 5 and 8): what a task's agents are given of the project wiki, and what the worker reports back.
//
//  - `wikiContext`: the invocation field the broker fills at delivery (never stored or queued) from W2's store, as `readPage(project, id, "agent")` returns it: no pending note, no flagged or
//    not-found claim, no page marked wrong. It carries ONE project's pages (the project the task belongs to); the worker refuses a payload it cannot parse strictly.
//  - The worker puts the pages in a READ-ONLY folder of the workspace OUTSIDE every repository (`WIKI_AGENT_FOLDER`), writes the `AGENTX-WIKI.md` index (`WIKI_AGENT_INDEX_MAX_BYTES`) into the
//    step's context, and re-checks each page's cited files against the task's base commit; a claim whose place changed is marked "may be out of date" in the agent's copy.
//  - Wiki text is untrusted data: a page is written from repository text, so it is framed, cleaned of hidden characters and of frame tags, and never changes an instruction.
//  - `wikiReadReport`: a small progress-event report (which pages were given, which the agent read), kept per company, project AND task (`wikiUseKey`) so the task page can show "Wiki pages this
//    task read". It is the worker's own report, not proof.
//  - The project's switch "Give the wiki to agents" is a row (`wikiAgentSwitchKey`), OFF until a person turns it on.
import { z } from "zod";
import { OrgIdSchema, type OrgId } from "./browser-ids.js";
import { orgScoped } from "./company-scope.js";
import { AGENTX_NAME_PATTERN } from "./names.js";
import { WIKI_LIMITS, WikiBlockSchema, WikiCitationSchema, WikiIdSchema, WikiPageIdSchema, WikiPageKindSchema, WikiProjectSchema, WikiRepoCommitSchema, WikiTaskIdSchema } from "./wiki-store.js";

/** The worker lists this when it can take `wikiContext`. In `WORKER_INVOCATION_FEATURES`; an older worker is sent none, which is safe (the task runs as without the wiki). */
export const WIKI_AGENT_FEATURE = "task.wikiContext.v1" as const;
/** The folder (in the workspace root, beside the repositories and in none of them) the pages are placed in, read-only. */
export const WIKI_AGENT_FOLDER = "agentx-wiki";
export const WIKI_AGENT_PAGES_FOLDER = "pages";
export const WIKI_AGENT_INDEX_FILE = "AGENTX-WIKI.md";
/** The index in every step's prompt stays within this many bytes. */
export const WIKI_AGENT_INDEX_MAX_BYTES = 4 * 1024;
/** The fixed instruction every step gets with the index. */
export const WIKI_AGENT_INSTRUCTION = "The wiki is a map written by a machine. Use it to choose where to look. Confirm in the code. If they disagree, the code wins.";
/** The mark on a paragraph whose cited file changed since the page was written (or could not be checked now). */
export const WIKI_STALE_MARK = "[may be out of date]";

/** The workflow modes whose steps are given the wiki: the stages that read and decide (`undefined` is a plain task step). Never a setup run, a spec write or a check round. The broker and the worker both ask this. */
const WIKI_AGENT_MODES: ReadonlySet<string | undefined> = new Set([undefined, "UNDERSTAND", "PLAN", "PLAN_CRITIQUE", "IMPLEMENT", "REVIEW"]);
export const wikiModeAllows = (mode: string | undefined): boolean => WIKI_AGENT_MODES.has(mode);

export const WIKI_AGENT_LIMITS = {
  /** Pages in one delivery. */
  pages: 40,
  /** Approved notes shown at the top of one page. */
  notesPerPage: 10,
  /** The whole `wikiContext`, as JSON, in UTF-8 bytes (the broker stops adding pages before this; the schema refuses more). */
  contextBytes: 160 * 1024,
  /** A page with more than this share of its cited paragraphs out of date is not given at all ("pages mostly out of date" never reach an agent). */
  mostlyStaleShare: 0.5,
} as const;

// ---- The payload -----------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** A claim as the agent's copy needs it: the places it came from (for the re-check at the task's base commit). The sentence itself is in the block that rests on it. */
export const WikiAgentClaimSchema = z.object({
  claimId: WikiIdSchema,
  /** `changed`: the free freshness check found a cited file moved on since the page was written. Never `not_found` (the store keeps those from agents). */
  source: z.enum(["found", "changed"]),
  citations: z.array(WikiCitationSchema).min(1).max(WIKI_LIMITS.citationsPerClaim),
}).strict();
export type WikiAgentClaim = z.infer<typeof WikiAgentClaimSchema>;

export const WikiAgentPageSchema = z.object({
  pageId: WikiPageIdSchema,
  kind: WikiPageKindSchema,
  title: z.string().min(1).max(120),
  summary: z.string().max(300),
  parentId: WikiPageIdSchema.optional(),
  order: z.number().int().min(0).max(10_000),
  repos: z.array(WikiRepoCommitSchema).min(1).max(WIKI_LIMITS.reposPerPage),
  /** The agent view's blocks: nothing resting on a flagged or not-found claim. */
  blocks: z.array(WikiBlockSchema).min(1).max(WIKI_LIMITS.blocksPerPage),
  claims: z.array(WikiAgentClaimSchema).max(WIKI_LIMITS.claimsPerPage),
  /** Notes a maintainer approved (pinned at the top of the page). Text only: who wrote it is not sent. */
  notes: z.array(z.object({ noteId: WikiIdSchema, text: z.string().min(1).max(WIKI_LIMITS.noteChars) }).strict()).max(WIKI_AGENT_LIMITS.notesPerPage),
  /** Blocks resting on a claim the store marks `changed`. */
  staleBlockIds: z.array(WikiIdSchema).max(WIKI_LIMITS.blocksPerPage),
}).strict();
export type WikiAgentPage = z.infer<typeof WikiAgentPageSchema>;

export const WikiContextSchema = z.object({
  v: z.literal(1),
  /** The task's own project (the broker takes it from the task, never from a caller). */
  project: WikiProjectSchema,
  pages: z.array(WikiAgentPageSchema).min(1).max(WIKI_AGENT_LIMITS.pages),
  /** Pages the project's wiki has that did not fit (listed in the index as "not placed here"). */
  leftOut: z.number().int().min(0).max(10_000),
}).strict().refine((context) => Buffer.byteLength(JSON.stringify(context), "utf8") <= WIKI_AGENT_LIMITS.contextBytes, "the wiki context is over its size limit");
export type WikiContext = z.infer<typeof WikiContextSchema>;

// ---- The report --------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** Why a delivered page was not placed for the agent. */
export const WIKI_DROP_REASONS = ["mostly_out_of_date", "not_readable"] as const;
export const WikiReadReportSchema = z.object({
  v: z.literal(1),
  project: WikiProjectSchema,
  phase: z.enum(["given", "read"]),
  /** `given`: the pages placed for the agent, and how many of their paragraphs are marked out of date. `read`: the pages the agent opened. */
  pages: z.array(z.object({ pageId: WikiPageIdSchema, stale: z.number().int().min(0).max(WIKI_LIMITS.blocksPerPage) }).strict()).max(WIKI_AGENT_LIMITS.pages),
  /** Pages left out of the agent's copy after the re-check (`given` only). */
  dropped: z.array(z.object({ pageId: WikiPageIdSchema, reason: z.enum(WIKI_DROP_REASONS) }).strict()).max(WIKI_AGENT_LIMITS.pages),
}).strict();
export type WikiReadReport = z.infer<typeof WikiReadReportSchema>;

/** The progress-event field the worker carries its report in: `{ wikiReadReport: <report> }`. */
export const WIKI_READ_REPORT_FIELD = "wikiReadReport";

/** The report in a worker progress payload, or undefined for anything else (a malformed report is dropped whole, never partly used). */
export function wikiReadReportOfProgress(payload: unknown): WikiReadReport | undefined {
  if (payload === null || typeof payload !== "object" || !Object.hasOwn(payload, WIKI_READ_REPORT_FIELD)) return undefined;
  const parsed = WikiReadReportSchema.safeParse((payload as Record<string, unknown>)[WIKI_READ_REPORT_FIELD]);
  return parsed.success ? parsed.data : undefined;
}

// ---- Keys: one partition per company AND project, apart from the wiki's own (the wiki's `deleteWiki` knows only its own row families) ------------------------------------------------------

const ProjectPart = z.string().regex(AGENTX_NAME_PATTERN);
export interface WikiUseKey { pk: string; sk: string }
/** `ORG#<company>#WIKIUSE#<project>`: the project's switch and the per-task page reports. The company purge removes it by its `ORG#<company>#` prefix. */
export function wikiUsePartition(orgId: OrgId, project: string): string {
  return orgScoped(OrgIdSchema.parse(orgId), `WIKIUSE#${ProjectPart.parse(project)}`);
}
/** The project's "Give the wiki to agents" switch row. Absent means OFF. */
export const wikiAgentSwitchKey = (orgId: OrgId, project: string): WikiUseKey => ({ pk: wikiUsePartition(orgId, project), sk: "SWITCH" });
/** What one task's agents were given and read of this project's wiki (keyed company, project and task). */
export const wikiUseKey = (orgId: OrgId, project: string, taskId: string): WikiUseKey => ({ pk: wikiUsePartition(orgId, project), sk: `TASK#${WikiTaskIdSchema.parse(taskId)}` });
/** The sort prefix of the task rows, for a delete or a list. */
export const WIKI_USE_TASK_PREFIX = "TASK#";

/** The delivery ref: which task and stage an operation's wiki was built for (so the report is filed under the right task). `ORG#<company>#WIKIUSE#<project>` / `OP#<operation>`. */
export const wikiUseRefKey = (orgId: OrgId, project: string, operationId: string): WikiUseKey => ({ pk: wikiUsePartition(orgId, project), sk: `OP#${z.string().regex(/^[0-9a-f-]{8,64}$/u).parse(operationId)}` });

/** A row of the project's use partition by its sort key (for a delete of what a query of the partition gave back): the sort key must be one of this slice's families. */
const USE_SK = /^(?:SWITCH|TASK#[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|OP#[0-9a-f-]{8,64})$/u;
export function wikiUseRowKey(orgId: OrgId, project: string, sk: string): WikiUseKey {
  if (!USE_SK.test(sk)) throw new Error("not a wiki use row's sort key");
  return { pk: wikiUsePartition(orgId, project), sk: `${sk}` };
}

export const WikiAgentSwitchRowSchema = z.object({ companyId: OrgIdSchema, project: WikiProjectSchema, entityType: z.literal("WIKI_AGENT_SWITCH"), on: z.boolean(), changedAt: z.string().datetime({ offset: false }) }).passthrough();
export const WikiUseRowSchema = z.object({
  companyId: OrgIdSchema, project: WikiProjectSchema, entityType: z.literal("WIKI_AGENT_USE"), taskId: WikiTaskIdSchema,
  given: z.array(WikiPageIdSchema).max(WIKI_AGENT_LIMITS.pages * 2), read: z.array(WikiPageIdSchema).max(WIKI_AGENT_LIMITS.pages * 2), updatedAt: z.string().datetime({ offset: false }),
}).passthrough();
export const WikiUseRefRowSchema = z.object({ companyId: OrgIdSchema, project: WikiProjectSchema, entityType: z.literal("WIKI_AGENT_USE_REF"), taskId: WikiTaskIdSchema, operationId: z.string().min(8).max(64) }).passthrough();
