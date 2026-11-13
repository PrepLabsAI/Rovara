// What a finished task's lessons can learn from the people's own words that the Team record already holds, read by the rows' deterministic source ids (the record core's
// source index), never by a scan:
//   - a "remember this" note: the `rovara.remembered` row `task:<task>:note:<note id>` (the words of the comment's author);
//   - a human reviewer's comment or review on one of the task's pull requests: the code-host tap's `github.review_comment` / `github.review` row
//     `<repository>#pr<number>:<review_comment|discussion|review><id>` (the code host's capture writes them; there is no second hook beside it).
// A row that is missing, belongs to another workspace, project or task, is hidden (an erased person's rows are deleted and tombstoned; a comment deleted at its source is tombstoned), has no text
// (retention A), or was written by anyone but a person who was a company member when they wrote it (a bot, an outsider) gives nothing. The caller reads the person's standing and erasure NOW:
// what is written down here is only who the row names and the words. Internal reads: the audience of the lesson is the subject's and the span's, set by the caller.
import type { PullRequestSurface } from "./capture-types.js";
import type { Audience } from "./types.js";

/** What the caller needs of one captured row of a person's words. */
export interface CapturedWords {
  /** The row's source id: the id a lesson cites. */
  id: string;
  /** The canonical developer id of the person the row names. */
  authorDeveloperId: string;
  text: string;
  audience: Audience;
  /** The place the row came from (a repository, a project), for the access check at read time. */
  scope: string;
  /** The account id the row's author has on the code host (the row's source id), for the checks made on the host's own account (exclusion). */
  authorSourceId: string;
  /** The record's name of the place's source (`github`, `codehost:<name>`). */
  source: string;
  /**
   * Whether the text the agent was shown is this author's own: no other person has a row on the comment, the host does not record an edit of it, and the comment was shown exactly as first written
   * (`shownAt` is not later than when it was first written). A change by an unlinked, excluded or since-erased person leaves no row, so the rows alone cannot prove it: a REVIEW body is proved only when the
   * host said at collection that it was never edited (`edited === false`: anyone with write access may edit another person's review, and nothing else would show it); a comment is refused when the host said
   * it was edited, and otherwise needs the time check. False when `shownAt` is not given (comments).
   */
  ownText: boolean;
  /** The inline comment's file, the line it was made on and the commit it was made on, when the host said them. */
  path?: string | undefined;
  line?: number | undefined;
  commitId?: string | undefined;
  /** Which side of the diff `line` is numbered on (`LEFT`: the base file; `RIGHT`: the file at `commitId`), when the host said. */
  side?: "LEFT" | "RIGHT" | undefined;
}

export type { PullRequestSurface };

export interface CapturedRowReader {
  /** The "remember this" note of one correction (the note id is the correction's id). */
  rememberedNote(input: { workspaceId: string; project: string; taskId: string; noteId: string }): Promise<CapturedWords | undefined>;
  /** One comment or review of a pull request, as its author first wrote it. `shownAt`: when the host last changed the comment, as the agent was shown it (epoch milliseconds); `edited`: whether the host recorded an edit of it at collection (absent: not said). Both for `ownText`. */
  pullRequestWords(input: { workspaceId: string; project: string; host: string; repository: string; number: number; surface: PullRequestSurface; commentId: string; shownAt?: number; edited?: boolean }): Promise<CapturedWords | undefined>;
}

export const pullRequestItemId = (repository: string, number: number): string => `${repository}#pr${String(number)}`;
/** The source id the code-host tap gives a pull request comment or review (codehost.ts `commentId` / the review case). */
export const pullRequestWordsId = (repository: string, number: number, surface: PullRequestSurface, commentId: string): string => `${pullRequestItemId(repository, number)}:${surface}${commentId}`;
