// Plan 3 Task 14b: what an org says about comment-triggered workflows. A repository whose workflows act on comments, issues or labels makes
// every agent comment there need a person (comment-commands.ts); an org owner or admin who has read those workflows can opt the repository
// out of that one rule. The opt-out is bound to the digest of the files they reviewed and lapses on its own when that digest changes.
import { z } from "zod";
import { OrgIdSchema } from "./company-scope.js";
import { AgentXNameSchema } from "./project-node.js";

/** A GitHub repository as `owner/name`: an owner login (letters, digits, `-` and `_`) and a name that is not `.` or `..`. */
export const CommentTriggerRepositorySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}\/(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/, "must be a repository as owner/name");
export const COMMENT_TRIGGER_REASON_MAX = 300;
/** The most files a scan lists: 100 workflows, the bot configs, up to 50 reached files and the remote actions they use. */
export const COMMENT_TRIGGER_FILES_MAX = 400;
/** The most characters a path or an action reference in a scan's file list can have. */
export const COMMENT_TRIGGER_FILE_NAME_MAX = 512;

const Hex64 = z.string().regex(/^[a-f0-9]{64}$/);

/** An active opt-out as the guardrails view lists it. */
export const CommentTriggerOptOutSchema = z.object({
  project: AgentXNameSchema,
  repository: CommentTriggerRepositorySchema,
  digest: Hex64,
  files: z.array(z.string().max(COMMENT_TRIGGER_FILE_NAME_MAX)).max(COMMENT_TRIGGER_FILES_MAX),
  reviewedBy: z.string(),
  reviewedAt: z.string(),
  reason: z.string().min(1).max(COMMENT_TRIGGER_REASON_MAX),
}).strict();
export type CommentTriggerOptOut = z.infer<typeof CommentTriggerOptOutSchema>;

/** `PUT /v1/app/projects/{p}/connectors/github/comment-triggers`. */
export const CommentTriggerOptOutRequestSchema = z.object({
  requestId: z.string().uuid(),
  repository: CommentTriggerRepositorySchema,
  expectedDigest: Hex64,
  reason: z.string().trim().min(1).max(COMMENT_TRIGGER_REASON_MAX).refine((reason) => !/[\p{Cc}\p{Cf}]/u.test(reason), "must not contain control characters"),
}).strict();
export type CommentTriggerOptOutRequest = z.infer<typeof CommentTriggerOptOutRequestSchema>;

/** What a stored opt-out holds beyond the listed fields. */
export const StoredCommentTriggerOptOutSchema = CommentTriggerOptOutSchema.extend({
  orgId: OrgIdSchema,
  /** The blob sha of each file the digest covers, so a lapse can name the files that changed. */
  fileShas: z.record(z.string(), z.string()),
  approvalId: z.string(),
}).strict();
export type StoredCommentTriggerOptOut = z.infer<typeof StoredCommentTriggerOptOutSchema>;

/** The refusal when the workflows changed between the admin looking and confirming (Task 14). */
export const COMMENT_TRIGGER_STALE_TEXT = "the workflows changed since you looked; review them again";
/** The refusal when the workflows cannot be read completely, so there is nothing a person could review. */
export const COMMENT_TRIGGER_UNREADABLE_TEXT = "Rovara can't read this repository's workflows completely, so they can't be reviewed. Try again shortly.";

const MAX_NOTICE_FILES = 10;
const NOTICE_NAME_MAX = 120;
const UNSAFE_NAME_CHARACTERS = /[\p{Cc}\p{Cf}]/gu;

/**
 * The notice maintainers and admins get when an opt-out lapses. `files` are the paths that changed; each is shown without control or format
 * characters and cut to a length, and at most ten are named.
 */
export function commentTriggerLapseNotice(repository: string, files: readonly string[]): string {
  const clean = files.map((file) => [...file.replace(UNSAFE_NAME_CHARACTERS, "")].slice(0, NOTICE_NAME_MAX).join(""));
  const shown = clean.slice(0, MAX_NOTICE_FILES);
  const named = shown.length === 0 ? "the workflow files" : `${shown.join(", ")}${clean.length > shown.length ? ` and ${String(clean.length - shown.length)} more` : ""}`;
  return `Rovara is asking again about comment-triggered workflows in ${repository}: ${named} changed. Agent comments there wait for a person until an admin reviews them.`;
}

/** What the page shows beside a repository's scan: what the scan reads, and what it can't see. Fixed text; nothing from a repository goes in it. */
export const COMMENT_TRIGGER_COVERAGE_NOTE = "Rovara reads every workflow of the repository, the scripts and manifests they name, local actions and the shell scripts those run in turn. For npm, make and well-known Python tools it reads their configuration files, not the tests or code they run. It can't see code fetched or built at run time, a command run by bare name or found on the PATH, files a Python or JavaScript script imports, or a Docker build context; where it can't tell which file runs, it asks a person.";

/**
 * Why a scan failed closed, in a few fixed words an admin can act on. Only the scan's own reasons are here: nothing from the repository is ever put in a hint.
 * A scan that fails closed for a reason with no hint here carries none.
 */
export const COMMENT_TRIGGER_HINTS = {
  directory: "use working-directory instead of cd",
  dynamic: "name scripts by a fixed path, not by an expression or a variable",
  path: "keep paths inside the repository: no .., glob or brace expansion",
  folderFlag: "use working-directory instead of -C, --prefix, --cwd or --chdir",
  runtimeFiles: "name each script in the run block instead of finding or piping them",
  missing: "name only files that exist in the repository",
  pythonModule: "run Python scripts by path instead of python -m",
  shell: "use a standard shell or a plain script path for shell:",
  submodule: "files in a submodule can't be read; copy them into the repository",
  plainCommand: "write the command name plainly, without a backslash or empty quotes",
  rootAction: "make the root action composite, or move it into a folder",
  arguments: "pass the files a script runs by name in the run block that calls it",
} as const;
export type CommentTriggerHint = (typeof COMMENT_TRIGGER_HINTS)[keyof typeof COMMENT_TRIGGER_HINTS];
