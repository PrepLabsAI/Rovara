// Browser testing in a project's setup (owner decision 421: SOURCE-BACKED, nothing typed): the rows it keeps and the words it says. Nothing here holds a password, a token or a secret of any kind: the
// user kinds, the start command and the sign-in page all come from the repository's own files, and every test login is made up fresh for each check by the sandbox.
//
//   BROWSER_DRAFT   (the project's setup partition)  the draft the owner edits: what the repository says (a pointer to the stored proposal and the facts read from it) and the two choices (proof, time limit)
//   E2E_BROWSER_STATE  (the project's own partition)  Pause, and the one served fault of the 90-day renewal. Read by the page, and by the planning seam for Pause; nothing else reads `paused`
//   E2E_BROWSER_SIGNIN#<hash>  (the project's own partition)  the result of the latest real browser check for one kind of user: signed in, or refused
import { createHash } from "node:crypto";
import { z } from "zod";
import { projectPk, type DocumentKey, type DocumentStore, type OrgId } from "@agentx/contracts";
import { setupPartition } from "./keys.js";

export const browserDraftKey = (orgId: OrgId, project: string): DocumentKey => ({ pk: setupPartition(orgId, project), sk: "BROWSER_DRAFT" });
/** Pause and the renewal fault. `paused` is read by the planning seam and the page and by nothing else (a test lists the readers). */
export const browserStateKey = (orgId: OrgId, project: string): DocumentKey => ({ pk: projectPk(orgId, project), sk: "E2E_BROWSER_STATE" });
export const browserSignInKey = (orgId: OrgId, project: string, profileId: string): DocumentKey => ({
  pk: projectPk(orgId, project), sk: `E2E_BROWSER_SIGNIN#${createHash("sha256").update(profileId, "utf8").digest("hex").slice(0, 32)}`,
});
export const BROWSER_SIGNIN_SK_PREFIX = "E2E_BROWSER_SIGNIN#";

/** The longest a check may run: Rovara's hard limit. The shortest is a minute: a build and an app start need more than that anyway. */
export const BROWSER_RUN_TIMEOUT_MIN_MS = 60_000;
export const BROWSER_RUN_TIMEOUT_MAX_MS = 1_800_000;
export const BROWSER_RUN_TIMEOUT_DEFAULT_MS = 600_000;
/** The most kinds of user one approval can store (two rows each, in the approval's one transaction). */
export const BROWSER_USER_KINDS_MAX = 16;

export const BrowserProofSchema = z.object({ screenshotMode: z.enum(["failed", "all"]), video: z.boolean() }).strict();
export type BrowserProof = z.infer<typeof BrowserProofSchema>;
export const BROWSER_PROOF_DEFAULT: BrowserProof = Object.freeze({ screenshotMode: "failed", video: false });

const text = (max: number) => z.string().max(max);
/** One kind of user the repository declares. */
export const BrowserUserKindSchema = z.object({ profileId: text(120), roleRef: text(200), signInPath: text(500).nullable() }).strict();
export type BrowserUserKind = z.infer<typeof BrowserUserKindSchema>;

/** One application as the repository describes it. `recipeSource`: "repo" when its own contract declares how to start it, "inferred" for Rovara's usual way. */
export const BrowserFoundApplicationSchema = z.object({
  applicationId: text(120), recipeSource: z.enum(["repo", "inferred"]),
  build: z.array(text(300)).max(16), start: text(300), healthPath: text(500), healthStatus: z.number().int(),
  userKinds: z.array(BrowserUserKindSchema).max(BROWSER_USER_KINDS_MAX),
  /** Whether the repository declares how to sign in (a user kind with a login form). False: signed-out pages only. */
  signInDeclared: z.boolean(),
  /** Where the file goes and its text, when the repository declares no sign-in: valid against the contract's own schema, and it needs a seed step beside it. */
  snippet: z.object({ path: text(200), text: text(8_000), needsSeedStep: z.literal(true) }).strict().nullable(),
}).strict();
export type BrowserFoundApplication = z.infer<typeof BrowserFoundApplicationSchema>;

export const BrowserFoundSchema = z.object({
  applications: z.array(BrowserFoundApplicationSchema).max(4),
  /** Why nothing can be set up from this repository: it names no web or API application Rovara can start, or it needs input Rovara cannot take. */
  problem: z.enum(["no-application", "needs-input", "too-many-user-kinds", "more-than-one-repository"]).nullable(),
}).strict();
export type BrowserFound = z.infer<typeof BrowserFoundSchema>;

export const BrowserDraftRowSchema = z.object({
  entityType: z.literal("E2E_BROWSER_DRAFT"), orgId: z.string(), project: z.string(),
  /** Goes up by one at every change; every change is conditional on the one the person looked at. */
  draftRevision: z.number().int().min(1), baseRevision: z.number().int().min(1),
  proof: BrowserProofSchema, runTimeoutMs: z.number().int().min(BROWSER_RUN_TIMEOUT_MIN_MS).max(BROWSER_RUN_TIMEOUT_MAX_MS),
  /** The SOURCE object a refresh stored (the files read and the proposal derived from them): the check and the approval use exactly these. */
  sourceRef: text(512), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/u), candidateDigest: z.string().regex(/^[a-f0-9]{64}$/u), commitSha: z.string().regex(/^[a-f0-9]{40,128}$/u),
  found: BrowserFoundSchema, foundAt: z.string(), updatedAt: z.string(), updatedBy: z.string(), lastRequestId: z.string(),
}).passthrough();
export type BrowserDraftRow = z.infer<typeof BrowserDraftRowSchema>;

/** What a SETUP_APPLY row carries when its candidate is a browser testing one (apply.ts `rowExtra`): what the approval writes beside the catalog move. */
export const BrowserCandidateFactsSchema = z.object({
  proposalRef: text(512), proposalSha256: z.string().regex(/^[a-f0-9]{64}$/u), candidateDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  /** The draft the check was made from: it is removed in the approval's transaction, and only while it is still at this revision. */
  draftRevision: z.number().int().min(1),
}).strict();
export type BrowserCandidateFacts = z.infer<typeof BrowserCandidateFactsSchema>;

export const BrowserStateRowSchema = z.object({
  paused: z.boolean().optional(), pausedAt: z.string().optional(), pausedBy: z.string().optional(), pauseRequestId: z.string().optional(),
  renewalFault: z.object({ at: z.string(), code: z.literal("accounts-refresh-failed") }).strict().optional(),
}).passthrough();
export type BrowserStateRow = z.infer<typeof BrowserStateRowSchema>;

export const BrowserSignInRowSchema = z.object({ profileId: text(120), status: z.enum(["ok", "refused"]), checkedAt: z.string() }).passthrough();

/** The fixed words. Nothing a caller sent is ever echoed, and nothing says "nothing was changed". */
export const BROWSER_TESTING_WORDS = {
  projectNotFound: "That project doesn't exist, or you don't have access to it.",
  notAllowed: "Only a company owner or admin can change browser testing. Ask your company's admins.",
  unreadable: "Rovara couldn't read this project's browser testing just now. Try again in a minute.",
  invalid: "The request wasn't in the shape Rovara expects.",
  stale: "This changed while you were looking. Refresh to see the current setup before you change anything.",
  anotherWaiting: "Another change is waiting for approval. Approve, reject or discard it first.",
  noDraft: "There is nothing to check yet. Start setting up first.",
  nothingWaiting: "There is no browser testing change waiting for a decision. Open the page again.",
  notChecked: "The setup check has not passed yet, so there is nothing to approve.",
  sandboxUnavailable: "Rovara can't start the test sandbox right now. What you set here is kept. Try again in a few minutes.",
  needsInput: "Rovara didn't find a web or API app it can start in this repository.",
  tooManyKinds: "This repository declares more kinds of user than one approval can hold. Remove some, then run the project setup again.",
  oneRepository: "Browser testing works on a project with one repository.",
  archived: "This project is archived. Unarchive it to change browser testing.",
  auditUnavailable: "Rovara couldn't record this change just now, so it was not made. Try again.",
  noProof: "Your approval could not be proved just now, so nothing was decided. Try again.",
  notHere: "Browser testing is decided on the project's Browser testing page.",
  adminOnly: "Only a company owner or admin can approve or reject browser testing.",
  accountsRefresh: "Rovara couldn't refresh this project's test accounts. Browser checks can't sign in until it does. Try again in a few minutes.",
  signInSetupFault: "Rovara couldn't sign in as a test user. This is a problem with the project's browser testing setup, not with this change.",
} as const;

/**
 * Whether the owner paused browser testing on the project. Read by the planning seam (new plans skip browser checks) and by the page, and by nothing else: the approval of a plan and the round that
 * follows never ask, so a plan already approved keeps its checks (core/e2e/application-planning.ts; a test lists every reader of this function).
 */
export async function readPaused(store: Pick<DocumentStore, "get">, orgId: OrgId, project: string): Promise<boolean> {
  const row = BrowserStateRowSchema.safeParse((await store.get(browserStateKey(orgId, project))) ?? {});
  return row.success && row.data.paused === true;
}
