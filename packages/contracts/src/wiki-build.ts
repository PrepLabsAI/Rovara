// Wiki W3 (DEC 254zh, 254zi): the contract of the wiki build run. "Build the wiki" starts a run (a task with purpose `wiki_build`) that reads the project's repositories at ONE fixed commit
// each (the default branch's head when the run started) with read-only tools, no shell and no network, and writes pages one at a time. The broker hands out each page and checks each page
// the worker sends back before it is kept, so a run that stops keeps every page it finished, and a run that continues does not write them again. Browser-safe: no Node import.
//
// What the schemas guarantee:
//   - every limit has a default and a hard maximum; a project can lower a limit, a company lock only lowers it further (the setup run's rule, `effectiveSetupAgentLimits`);
//   - the run pays from the PROJECT's monthly limit (`WIKI_BUILD_PAYER_KIND`), never a person's, and has its own hard build cap (`budgetCents`); there is no wiki-only allowance (review fix 3);
//   - a page starts only when what was spent plus the page's reserve fits under the cap (`wikiPageFits`): the cap is never exceeded by a page that was started;
//   - a page draft is plain data: titles and sentences on one line, quotes at most `WIKI_QUOTE_MAX_CHARS`, bounded counts. Nothing in a draft decides anything; the broker re-reads every citation;
//   - dollar figures here are placeholders until the first real build measures cost (DEC 254zi: the first build on our own repository is the measurement).
import { z } from "zod";
import { WikiPageIdSchema, type WikiPageKind } from "./wiki-store.js";

const NO_HIDDEN = /^[^\p{Cc}\p{Cf}]*$/u;
function line(max: number, min = 1) {
  return z.string().min(min).max(max).regex(NO_HIDDEN, "one plain line");
}
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

/** The task purpose of a wiki build run. */
export const WIKI_BUILD_PURPOSE = "wiki_build" as const;
/** The operation mode of a build run's own step. */
export const WIKI_BUILD_WORKFLOW_MODE = "WIKI_BUILD" as const;
/** A worker that lists this runs a wiki build (`workflowMode: "WIKI_BUILD"`); the broker sends one only to such a worker. */
export const WIKI_BUILD_FEATURE = "task.wikiBuild.v1" as const;
/** The tools a build run's model session has: read-only file tools. No shell, no write, no network tool (the worker enforces it; a test names this list). */
export const WIKI_BUILD_TOOLS = ["read", "grep", "find", "ls"] as const;
/** Who pays: the project (its monthly limit), never the person who pressed Build. */
export const WIKI_BUILD_PAYER_KIND = "project" as const;

// ---- limits

export const WIKI_BUILD_LIMIT_NAMES = ["pages", "budgetCents", "wallClockMin", "pageReserveCents"] as const;
export type WikiBuildLimitName = (typeof WIKI_BUILD_LIMIT_NAMES)[number];

/**
 * `pages`: pages one run may write (W0's per-project page cap). `budgetCents`: the build's own hard cap (placeholder $25 until the first measured build). `wallClockMin`: the run's clock.
 * `pageReserveCents`: what one page is assumed to cost at most before it starts; a page starts only when spend + reserve fits under the cap.
 */
export const WIKI_BUILD_LIMITS_DEFAULT = { pages: 300, budgetCents: 2_500, wallClockMin: 180, pageReserveCents: 100 } as const satisfies Record<WikiBuildLimitName, number>;
export const WIKI_BUILD_LIMITS_MAX = { pages: 300, budgetCents: 10_000, wallClockMin: 480, pageReserveCents: 500 } as const satisfies Record<WikiBuildLimitName, number>;
/** The smallest page reserve a setting may give: a reserve of zero would let the last page start with nothing left. */
export const WIKI_PAGE_RESERVE_MIN_CENTS = 10 as const;

const limitField = (name: WikiBuildLimitName) => z.number().int().min(name === "pageReserveCents" ? WIKI_PAGE_RESERVE_MIN_CENTS : 1).max(WIKI_BUILD_LIMITS_MAX[name]);

export const WikiBuildLimitsSchema = z.object({
  pages: limitField("pages"),
  budgetCents: limitField("budgetCents"),
  wallClockMin: limitField("wallClockMin"),
  pageReserveCents: limitField("pageReserveCents"),
}).strict();
export type WikiBuildLimits = z.infer<typeof WikiBuildLimitsSchema>;

/**
 * The limits a run uses. For each limit: the project's value (the default when absent or not valid), cut down to the company lock when there is one, never above the maximum. The page
 * reserve is the one limit that only goes UP under a lock (a bigger reserve is the stricter one). A damaged value is read as the default, never looser. Pure; never throws.
 */
export function effectiveWikiBuildLimits(project?: unknown, lock?: unknown): WikiBuildLimits {
  const valueOf = (source: unknown, name: WikiBuildLimitName): number | undefined => {
    if (typeof source !== "object" || source === null || Array.isArray(source)) return undefined;
    const raw: unknown = (source as Record<string, unknown>)[name];
    if (raw === undefined) return undefined;
    const parsed = limitField(name).safeParse(raw);
    return parsed.success ? parsed.data : Number.NaN;
  };
  const out = { ...WIKI_BUILD_LIMITS_DEFAULT } as Record<WikiBuildLimitName, number>;
  for (const name of WIKI_BUILD_LIMIT_NAMES) {
    const own = valueOf(project, name);
    let value: number = own === undefined || Number.isNaN(own) ? WIKI_BUILD_LIMITS_DEFAULT[name] : own;
    const locked = valueOf(lock, name);
    if (locked !== undefined) {
      const lockValue = Number.isNaN(locked) ? WIKI_BUILD_LIMITS_DEFAULT[name] : locked;
      value = name === "pageReserveCents" ? Math.max(value, lockValue) : Math.min(value, lockValue);
    }
    out[name] = Math.min(value, WIKI_BUILD_LIMITS_MAX[name]);
  }
  return WikiBuildLimitsSchema.parse(out);
}

/**
 * Whether one more page may start: the spend so far plus the page's reserve is at or under the cap. A spend that is not a whole number of cents at or above zero (unknown, damaged) never
 * fits: a run that cannot tell what it spent stops.
 */
export function wikiPageFits(spentCents: unknown, limits: Pick<WikiBuildLimits, "budgetCents" | "pageReserveCents">): boolean {
  if (typeof spentCents !== "number" || !Number.isSafeInteger(spentCents) || spentCents < 0) return false;
  return spentCents + limits.pageReserveCents <= limits.budgetCents;
}

// ---- stages and pages

/**
 * The page kinds a build writes (a subset of the store's `WIKI_PAGE_KINDS`), and their stages, in order: (1) the overview and one page per repository; (2) module pages, most active first;
 * (3) "How the repos connect", only with two or more repositories. The file map (W0) is the free stage 0 before any of these.
 */
export const WIKI_BUILD_PAGE_KINDS = ["overview", "repo", "module", "connections"] as const satisfies readonly WikiPageKind[];
export type WikiBuildPageKind = (typeof WIKI_BUILD_PAGE_KINDS)[number];
export const WIKI_STAGE_OF: Readonly<Record<WikiBuildPageKind, 1 | 2 | 3>> = { overview: 1, repo: 1, module: 2, connections: 3 };

/** One page the run will write: what it is about. No text from a repository decides it; the paths come from the file map's own listing. The id is the store's page id (W2). */
export const WikiPagePlanSchema = z.object({
  id: WikiPageIdSchema,
  kind: z.enum(WIKI_BUILD_PAGE_KINDS),
  stage: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  /** The page's repository (module and repository pages); absent on the overview and the connections page. */
  repo: line(100).optional(),
  /** The module's folder (module pages). */
  path: line(300).optional(),
  /** The page above it in the tree (a module page's repository page). */
  parentId: WikiPageIdSchema.optional(),
  /** Where it sits among its siblings. */
  position: z.number().int().min(0).max(10_000),
  /** Why it is where it is in the order: fixed, a person's "write first", the file map's activity rank, or size. */
  order: z.enum(["fixed", "write_first", "activity", "size"]),
}).strict();
export type WikiPagePlan = z.infer<typeof WikiPagePlanSchema>;

// ---- what the worker sends back for a page

/** A stored quote: at most this many characters (review fix 2). Longer quotes are cut by the broker after the check, never stored whole. */
export const WIKI_QUOTE_MAX_CHARS = 200;
export const WIKI_PAGE_SECTIONS_MAX = 12;
export const WIKI_SECTION_CLAIMS_MAX = 24;
/** The store keeps at most 3 citations per claim (`WIKI_LIMITS.citationsPerClaim`). */
export const WIKI_CLAIM_CITATIONS_MAX = 3;
export const WIKI_PAGE_LINKS_MAX = 24;
/** Citations one page may carry in all: the page check reads them in chunks of the shared check's limit. */
export const WIKI_PAGE_CITATIONS_MAX = 256;

/** A place a sentence came from. The commit must be the run's pinned commit for that repository, or the citation is not found. */
export const WikiDraftCitationSchema = z.object({
  repo: line(100),
  path: line(512),
  commit: z.string().regex(COMMIT),
  line: z.number().int().min(1).max(10_000_000),
  /** A short exact quote from the file at that line. The model may send up to 400 characters; at most `WIKI_QUOTE_MAX_CHARS` are ever stored. */
  quote: z.string().min(1).max(400),
}).strict();
export type WikiDraftCitation = z.infer<typeof WikiDraftCitationSchema>;

/** Model-written text in a draft: bounded, and cleaned by the broker before anything is stored (hidden characters removed, one line, redacted). Not refused for a stray hidden character, which a model may copy from a file. */
const draftText = (max: number) => z.string().min(1).max(max);

export const WikiDraftClaimSchema = z.object({
  sentence: draftText(600),
  citations: z.array(WikiDraftCitationSchema).max(WIKI_CLAIM_CITATIONS_MAX),
}).strict();
export type WikiDraftClaim = z.infer<typeof WikiDraftClaimSchema>;

/** A section heading: model-written and not a claim, so it is short and stored inert. The page's title and summary are never the model's (see the broker's page check). */
export const WikiDraftSectionSchema = z.object({
  heading: draftText(80),
  claims: z.array(WikiDraftClaimSchema).max(WIKI_SECTION_CLAIMS_MAX),
}).strict();

/**
 * A link between two repositories ("How the repos connect"): a sentence, the citation on the FROM side and the citation on the TO side. It is kept only when both sides' sources are found,
 * in different repositories (review: "each link cited on both sides").
 */
export const WikiDraftLinkSchema = z.object({
  sentence: draftText(600),
  from: WikiDraftCitationSchema,
  to: WikiDraftCitationSchema,
}).strict();
export type WikiDraftLink = z.infer<typeof WikiDraftLinkSchema>;

export const WikiPageDraftSchema = z.object({
  pageId: z.string().min(1).max(120),
  sections: z.array(WikiDraftSectionSchema).max(WIKI_PAGE_SECTIONS_MAX),
  links: z.array(WikiDraftLinkSchema).max(WIKI_PAGE_LINKS_MAX).default([]),
}).strict().refine(
  (draft) => draft.sections.reduce((sum, section) => sum + section.claims.reduce((n, claim) => n + claim.citations.length, 0), 0) + draft.links.length * 2 <= WIKI_PAGE_CITATIONS_MAX,
  { message: "too many citations on one page", path: ["sections"] },
);
export type WikiPageDraft = z.infer<typeof WikiPageDraftSchema>;

// ---- how a run ends

/**
 * `built`: every planned page was handed out. `budget_used`: the next page did not fit under the cap. `pages_used`: the page limit. `time_used`: the clock. `stopped_by_person`: Stop.
 * `needs_ai_key`: the company has no AI key connected (or the gateway refused for that reason). `repo_unreadable`: Rovara could not read a repository at its commit. `access_lost`: the person who
 * started it can no longer build the wiki (read again before every page). `infrastructure`: anything else. `code_moved`: the commit the run was pinned to is no longer on the default branch (it was rewritten), so the run could not read it; a new Build pins the current head. `upkeep_paused` (lead 4 N1): a NIGHTLY refresh the gateway refused at the project's upkeep limit; only an
 * unattended run ends with it.
 */
export const WIKI_BUILD_END_WORDS = ["built", "budget_used", "pages_used", "time_used", "stopped_by_person", "needs_ai_key", "repo_unreadable", "access_lost", "infrastructure", "code_moved", "upkeep_paused"] as const;
export const WikiBuildEndWordSchema = z.enum(WIKI_BUILD_END_WORDS);
export type WikiBuildEndWord = z.infer<typeof WikiBuildEndWordSchema>;

/** The words a person is told (fixed; never a model's, a worker's or a repository's). */
export const WIKI_BUILD_WORDS = {
  busy: "Rovara is already building this project's wiki.",
  connectKey: "Connect an AI key to build the wiki.",
  notAllowed: "Only company owners and admins, or this project's admins, can build the wiki.",
  noRepositories: "This project has no repository Rovara can read, so there is nothing to build.",
  noMap: "Map the project's files first, then build the wiki.",
  nothingToContinue: "There is no stopped wiki build to continue.",
  raiseCap: "This wiki build already used its spending limit. Raise the limit, then continue.",
  built: "Wiki built.",
  budget_used: "The wiki build reached its spending limit. It kept the pages it finished.",
  pages_used: "The wiki build reached its page limit. It kept the pages it finished.",
  time_used: "The wiki build ran out of time. It kept the pages it finished.",
  stopped_by_person: "The wiki build was stopped. It kept the pages it finished.",
  needs_ai_key: "Connect an AI key to build the wiki. The pages already written are kept.",
  repo_unreadable: "Rovara could not read a repository at the commit it started from. It kept the pages it finished.",
  access_lost: "The person who started the wiki build can no longer build it. It kept the pages it finished.",
  infrastructure: "The wiki build could not go on. Try again; finished pages are kept.",
  code_moved: "The code changed while the wiki build was starting, so Rovara could not read the commit it planned from. Nothing was lost. Start the build again and it will plan from the latest code.",
  upkeep_paused: "Nightly upkeep reached its spending limit, so the wiki refresh paused. It kept the pages it finished.",
} as const satisfies Record<string, string>;

/** "Tell Rovara what matters": at most this many characters. Notes only steer order; they never become wiki text (every claim still needs a citation). */
export const WIKI_NOTES_MAX_CHARS = 2_000;

/** What a run reports. */
export const WikiBuildSummarySchema = z.object({
  pagesPlanned: z.number().int().min(0).max(WIKI_BUILD_LIMITS_MAX.pages + 2),
  pagesWritten: z.number().int().min(0).max(WIKI_BUILD_LIMITS_MAX.pages + 2),
  pagesKeptFromEarlier: z.number().int().min(0).max(WIKI_BUILD_LIMITS_MAX.pages + 2),
  claimsKept: z.number().int().min(0).max(1_000_000),
  claimsDropped: z.number().int().min(0).max(1_000_000),
  spentCents: z.number().int().min(0).max(1_000_000),
}).strict();
export type WikiBuildSummary = z.infer<typeof WikiBuildSummarySchema>;

/** The commits a run reads, one per repository: fixed when the run starts, the same for every page and every check. */
export const WikiBuildPinsSchema = z.array(z.object({ repo: line(100), commit: z.string().regex(COMMIT) }).strict()).min(1).max(32)
  .refine((pins) => new Set(pins.map((pin) => pin.repo)).size === pins.length, "pinned repositories must be unique");
export type WikiBuildPins = z.infer<typeof WikiBuildPinsSchema>;

/**
 * What the broker tells the worker about a wiki build: the limits the run started with and, as a cross-check only, the commit each repository was pinned at (the preparation carries the same pins and
 * refuses any difference). The company, the project and the task are NEVER in it: the worker's callback is scoped by the operation. Nothing here adds or changes what the run reads.
 */
export const WikiBuildWireSchema = z.object({ limits: WikiBuildLimitsSchema, pins: WikiBuildPinsSchema }).strict();
export type WikiBuildWire = z.infer<typeof WikiBuildWireSchema>;
