// The shapes of what capture hands to learning from a code host: a pull request's comments and reviews, and a person's edit to a Rovara pull request. Nothing here names a code host or a store: the host's
// adapter produces them (`CodeHost` port), and a hosted install's team record produces the same shapes from its own rows.
import type { Audience } from "./types.js";

/** Which words of a pull request: an inline comment, a comment on the conversation, or a review's own body. */
export type PullRequestSurface = "review_comment" | "discussion" | "review";

/** A repository as capture names it. The adapter resolves the company and project from its own connection, never from a delivery's body. */
export interface CodeHostRepo {
  /** The code host's connection name (`github`, or a plug-in's name). */
  host: string;
  id: string;
  fullName: string;
  isPrivate: boolean;
  defaultBranch?: string;
  workspaceId: string;
  project?: string;
}

/** One changed file of a human edit, in memory only. `hunks` are hunk headers and changed lines (at most 200), redacted. */
export interface HumanEditFile {
  path: string;
  additions: number;
  deletions: number;
  symbols: string[];
  hunks: string[];
}

export interface HumanEditInput {
  workspaceId: string;
  project: string;
  repo: string;
  taskId: string;
  pullRequest: { number: number; url: string };
  /** Every human author was a member with a live project role (otherwise nothing is handed on). */
  trust: "member";
  authorCount: number;
  /** The authors as canonical developer ids, each once (never a login or an email): so a lesson built from the edit names them, and their erasure reaches it. */
  authors: string[];
  /** Who may read what these lines say: the repository's audience (restricted, with a live access check, for a private repository) and its scope. Every span built from the lines carries them. */
  audience: Audience;
  scope: string;
  files: HumanEditFile[];
  /** The only thing of this input that may be kept. */
  link: string;
}

/** The learning extractor. It reads `files` once and keeps at most lessons and `link`. Never stores `files`. */
export interface HumanEditExtractorPort {
  extract(input: HumanEditInput): Promise<{ candidates: number }>;
}

/** What reading a human edit needs, small enough to be a queue message: the compare is made later. */
export interface HumanEditJob {
  repo: CodeHostRepo;
  project: string;
  taskId: string;
  pullRequest: { number: number; url: string };
  candidateHeadSha: string;
  headSha: string;
  /** The pull request's head branch, to match pushes against. */
  headRef?: string;
}
