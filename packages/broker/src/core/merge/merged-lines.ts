// Rovara Code (Plan 6 Task 20): the line that says a pull request merged, for the Slack thread and for the merged milestone's text. One line for each pull request, `Merged: <url>`.
const GITHUB_PULL_REQUEST = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/u;

/** `Merged: <url>` for each merged pull request whose link is a GitHub pull request link (anything else is left out: it is printed to people). */
export function mergedLines(pullRequests: ReadonlyArray<{ url: string; state: string }>): string[] {
  return pullRequests.filter((pullRequest) => pullRequest.state === "MERGED" && GITHUB_PULL_REQUEST.test(pullRequest.url)).map((pullRequest) => `Merged: ${pullRequest.url}`);
}
