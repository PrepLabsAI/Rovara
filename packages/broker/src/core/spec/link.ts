// The line a code pull request carries so a reader finds the spec: `Spec: <link> @ <commit>`. The link is printed only when it is exactly a pull request of the meta repository Rovara opened;
// anything else is left out, so a description never carries a link someone else chose.
import type { SpecPullRequest } from "./state.js";

const GITHUB_REPOSITORY = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/u;

/** The spec line, or undefined when the recorded pull request is not a pull request of `metaRepositoryUrl`. */
export function specLinkLine(link: SpecPullRequest, metaRepositoryUrl: string): string | undefined {
  const repository = GITHUB_REPOSITORY.exec(metaRepositoryUrl);
  const recorded = GITHUB_REPOSITORY.exec(link.repositoryUrl);
  if (repository === null || recorded === null) return undefined;
  if (repository[1]!.toLowerCase() !== recorded[1]!.toLowerCase() || repository[2]!.toLowerCase() !== recorded[2]!.toLowerCase()) return undefined;
  const expected = `https://github.com/${repository[1]!}/${repository[2]!}/pull/${String(link.number)}`;
  if (link.url.toLowerCase() !== expected.toLowerCase()) return undefined;
  return `Spec: ${expected} @ ${link.commit}`;
}

/** The description with the spec line first. A body whose FIRST line is already exactly this line (a retry) is not given a second; a line elsewhere that merely looks like one counts for nothing. */
export function withSpecLink(body: string, line: string | undefined): string {
  if (line === undefined || body.split("\n", 1)[0] === line) return body;
  return `${line}\n\n${body}`;
}

/** The spec pull request's own description: it names the task and says Rovara opened it and never merges. No model text. */
export function specPullRequestBody(input: { taskTitle: string; taskPageUrl?: string | undefined; requirementCount: number; /** Design review: the one line of counts, from `designReviewedLine`. */ designLine?: string | undefined }): string {
  return [
    `Rovara wrote this spec from the plan a person approved for: ${input.taskTitle.replace(/[\r\n@<>]+/gu, " ").slice(0, 200)}`,
    "",
    `It lists ${String(input.requirementCount)} requirement${input.requirementCount === 1 ? "" : "s"}. The code pull request is reviewed against them. Edit the files here if the spec is wrong; Rovara will ask the task owner whether to re-plan.`,
    ...(input.designLine === undefined ? [] : ["", input.designLine]),
    ...(input.taskPageUrl === undefined ? [] : ["", `Rovara task: ${input.taskPageUrl}`]),
    "",
    "Opened by Rovara. A person merges it.",
  ].join("\n");
}
