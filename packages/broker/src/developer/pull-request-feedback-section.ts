// D2: the "Fixes from PR feedback" section of a workflow pull request's description. After an approved PR feedback fix
// is pushed, the description lists briefly what was changed for which comments, from each approved proposal's summary,
// and is kept up to date across rounds. The summaries come from a reviewer reading untrusted comments: each is redacted
// and made inert for GitHub (no mention, link or cross-reference) before it is written.

/** Around the description's lines about the checks and reviews of the code on the pull request (since this release). */
export const PULL_REQUEST_STATUS_START = "<!-- agentx:checks-and-reviews -->";
export const PULL_REQUEST_STATUS_END = "<!-- /agentx:checks-and-reviews -->";
/** Around the same block in a Rovara Code (version 2) description, which never says AgentX. */
export const ROVARA_STATUS_START = "<!-- rovara:checks-and-reviews -->";
export const ROVARA_STATUS_END = "<!-- /rovara:checks-and-reviews -->";


/** The description's line when the reviewers saw only part of the change (workflowPullRequestStatusLines writes it). */
export const PULL_REQUEST_PARTIAL_REVIEW_LINE = "The change was too large to show the reviewers in full, so the reviews covered only part of it. Review the rest by hand.";


