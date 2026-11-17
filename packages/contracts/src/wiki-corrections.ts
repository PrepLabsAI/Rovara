// The project wiki's corrections (lead 4, C1; DEC 254zh/254zi): how people fix a machine-written wiki. The store is W2's (`wiki-store.ts`); this file is the routes' contract, for Cloud's Wiki tab.
//
//   GET    /v1/app/projects/{project}/wiki/pages/{pageId}/corrections                          what THIS caller may do on the page and which notes need a look (any project role)
//   POST   /v1/app/projects/{project}/wiki/pages/{pageId}/notes                                { text, file? }       Add a note (contributor and up). Pending: people see it at once, agents only after approval
//   POST   /v1/app/projects/{project}/wiki/pages/{pageId}/notes/{noteId}/approve               {}                    maintainer (or company owner or admin) only: from then agents get the note
//   POST   /v1/app/projects/{project}/wiki/pages/{pageId}/notes/{noteId}/delete                {}                    the note's author, or a maintainer
//   POST   /v1/app/projects/{project}/wiki/pages/{pageId}/notes/{noteId}/suggest-lesson        {}                    the note's author, or a maintainer: a PENDING lesson an admin approves; never auto-approved
//   POST   /v1/app/projects/{project}/wiki/pages/{pageId}/flags                                { claimId?, reason? } Mark wrong (contributor and up): hides the claim, or the page, from agents at once
//   POST   /v1/app/projects/{project}/wiki/pages/{pageId}/flags/resolve                        {}                    maintainer only: closes every open mark on the page
//   GET    /v1/app/projects/{project}/wiki/disputed                                            maintainer only: marks still open after the page was rewritten
//
// Rules (the routes' file says how each is kept):
//  - The caller's role is read LIVE from membership for the project (never from the body, a query or a header). A company owner or admin is a maintainer of every project. No role, a project the
//    company does not have and another company's project all give the same 404. A role that may read but not do the act gets a fixed 403.
//  - Nothing here takes a person id, an author, a company or a role from a body. Bodies are strict: an unknown field is refused.
//  - "Delete" is a POST (the route table has no DELETE rows); the answers never echo the caller's words.
import { z } from "zod";
import { WikiIdSchema, WikiPageIdSchema, WikiPathSchema, WikiRepoSchema, WikiShownNoteSchema, WIKI_LIMITS } from "./wiki-store.js";

const NO_CONTROL_BUT_NEWLINES = /^(?:[^\p{Cc}\p{Cf}]|\n)*$/u;
const words = (max: number) => z.string().min(1).max(max).regex(NO_CONTROL_BUT_NEWLINES).refine((text) => text.trim() !== "", "words, not blanks");

export const WikiAddNoteRequestSchema = z.object({
  text: words(WIKI_LIMITS.noteChars),
  /** A file the note is tied to: when it changes the author and the project's maintainers are asked to check the note. */
  file: z.object({ repo: WikiRepoSchema, path: WikiPathSchema }).strict().optional(),
}).strict();
export type WikiAddNoteRequest = z.infer<typeof WikiAddNoteRequestSchema>;

export const WikiMarkWrongRequestSchema = z.object({
  /** The claim that is wrong; absent: the whole page. */
  claimId: WikiIdSchema.optional(),
  /** Why, in the person's words (optional; erased with them; never given to agents). */
  reason: words(WIKI_LIMITS.reasonChars).optional(),
}).strict();
export type WikiMarkWrongRequest = z.infer<typeof WikiMarkWrongRequestSchema>;

/** The body of approve, delete, suggest-lesson and resolve: nothing (who acts comes from the sign-in). */
export const WikiNoBodySchema = z.object({}).strict();

export const WIKI_CORRECTION_ROLES = ["maintainer", "contributor", "viewer"] as const;

/** What the caller may do on a page: Cloud shows only these controls. */
export const WikiYouCanSchema = z.object({
  role: z.enum(WIKI_CORRECTION_ROLES),
  addNote: z.boolean(),
  markWrong: z.boolean(),
  approveNotes: z.boolean(),
  resolveMarks: z.boolean(),
  seeDisputed: z.boolean(),
}).strict();
export type WikiYouCan = z.infer<typeof WikiYouCanSchema>;

export const WikiNoteStateSchema = z.object({
  noteId: WikiIdSchema,
  /** The caller wrote it. */
  mine: z.boolean(),
  canDelete: z.boolean(),
  canApprove: z.boolean(),
  /** The note reads like a rule ("always", "never", "must") and the caller may suggest it as a lesson. */
  canSuggestLesson: z.boolean(),
  /** The file the note is tied to has changed since the page was written (a claim citing it is `changed` or `not_found`). Shown to the note's author and to maintainers only. */
  mayBeOutOfDate: z.boolean(),
}).strict();
export type WikiNoteState = z.infer<typeof WikiNoteStateSchema>;

export const WikiCorrectionsResponseSchema = z.object({
  project: z.string(),
  pageId: WikiPageIdSchema,
  you: WikiYouCanSchema,
  notes: z.array(WikiNoteStateSchema),
}).strict();
export type WikiCorrectionsResponse = z.infer<typeof WikiCorrectionsResponseSchema>;

export const WikiNoteAddedResponseSchema = z.object({ note: WikiShownNoteSchema }).strict();
export type WikiNoteAddedResponse = z.infer<typeof WikiNoteAddedResponseSchema>;
export const WikiNoteApprovedResponseSchema = z.object({ noteId: WikiIdSchema, approval: z.literal("approved") }).strict();
export const WikiNoteDeletedResponseSchema = z.object({ deleted: z.literal(true) }).strict();
export const WikiMarkedResponseSchema = z.object({ flagId: WikiIdSchema, pageId: WikiPageIdSchema, claimId: WikiIdSchema.optional() }).strict();
export type WikiMarkedResponse = z.infer<typeof WikiMarkedResponseSchema>;
export const WikiResolvedResponseSchema = z.object({ resolved: z.number().int().min(0) }).strict();
/** `proposed`: a pending lesson an admin approves in the lessons inbox; `already_proposed`: this note was suggested before (the same lesson). */
export const WikiSuggestedResponseSchema = z.object({ state: z.enum(["proposed", "already_proposed"]), lessonId: z.string() }).strict();
export type WikiSuggestedResponse = z.infer<typeof WikiSuggestedResponseSchema>;

export const WikiDisputedItemSchema = z.object({
  flagId: WikiIdSchema,
  pageId: WikiPageIdSchema,
  pageTitle: z.string(),
  claimId: WikiIdSchema.optional(),
  /** The claim as the page now says it (the same claim written again). */
  claimText: z.string().optional(),
  markedBy: z.string(),
  markedAt: z.string(),
  reason: z.string().optional(),
}).strict();
/** The most disputed marks one answer holds. */
export const WIKI_DISPUTED_MAX = 100;
/** `more`: the list was cut at `WIKI_DISPUTED_MAX` (close some marks and read again). */
export const WikiDisputedResponseSchema = z.object({ project: z.string(), items: z.array(WikiDisputedItemSchema).max(WIKI_DISPUTED_MAX), more: z.boolean() }).strict();
export type WikiDisputedResponse = z.infer<typeof WikiDisputedResponseSchema>;

// ---- Fixed words ----------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const WIKI_NEEDS_WORKING_ROLE = "Only people with a working role on this project can do that.";
export const WIKI_NEEDS_MAINTAINER = "Only a project maintainer, or an owner or admin of the company, can do that.";
export const WIKI_NOTE_NOT_YOURS = "Only the person who wrote a note, or a project maintainer, can do that.";
export const WIKI_NOTE_NOT_FOUND = "That note is not there.";
export const WIKI_NOT_A_RULE = "That note is too long to be a lesson. Shorten it to a rule of a few lines first.";
export const WIKI_LESSON_REFUSED = "That note cannot be suggested as a lesson. Reword it as advice about the code.";
export const WIKI_LESSONS_OFF = "Lessons are off for this project, so a note cannot be suggested as one.";
export const WIKI_BAD_REQUEST = "That request is not valid.";
export const WIKI_TOO_MANY = "This page has as many notes or marks as it can hold.";
export const WIKI_NO_SUCH_CLAIM = "That claim is not on the page.";
export const WIKI_ACTION_FAILED = "That could not be saved. Try again.";

/** A note that reads like a rule: the page then offers "Suggest it as a lesson". */
export function wikiNoteLooksLikeRule(text: string): boolean {
  return /\b(always|never|must)\b/iu.test(text);
}
/** The longest note that can become a lesson (a lesson's body is at most 600 characters). */
export const WIKI_LESSON_BODY_MAX = 600;
