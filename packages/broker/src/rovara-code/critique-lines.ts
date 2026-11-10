// What a person reads about the plan check, under the plan. Kept apart from the critic's model choice so the message wording can use it without the model routing.
import { CRITIC_NOT_CHECKED_LINE, CRITIC_STOPPED_AT_LIMIT_LINE, CRITIC_STOPPED_AT_SPENDING_LIMIT_LINE, redactText, type WorkflowCritique } from "@agentx/contracts";

export { CRITIC_NOT_CHECKED_LINE, CRITIC_STOPPED_AT_LIMIT_LINE, CRITIC_STOPPED_AT_SPENDING_LIMIT_LINE };

/** The line the plan view shows when the project allows only one model, so the same one wrote and checked the plan. */
export const sameModelNote = (project: string): string => `This plan was checked by the same model that wrote it, because ${project} allows only one model.`;
/** The line the plan view shows when the one revision the check asked for could not be paid for, so the plan is shown as it was written. */
export const notRevisedLine = (limit: "planning" | "other" | undefined): string =>
  `I couldn't revise this plan for the second model's points, because ${limit === "planning" ? "the planning limit" : "a spending limit"} was reached first. It is shown as it was.`;

/**
 * The lines a person reads about the plan check, under the plan: the same-model note, how many problems the second model found (and what they were), and when the check stopped short.
 * Every point is the critic's text, redacted and on one line; the person decides what to make of it.
 */
export function critiqueLines(critique: WorkflowCritique | undefined, project: string): string[] {
  if (critique === undefined) return [];
  const lines: string[] = [];
  if (critique.sameModelAsPlanner === true) lines.push(sameModelNote(project));
  if (critique.status === "stopped_at_limit") lines.push(critique.limit === "other" ? CRITIC_STOPPED_AT_SPENDING_LIMIT_LINE : CRITIC_STOPPED_AT_LIMIT_LINE);
  const latest = critique.critiques.at(-1);
  if (latest === undefined) {
    if (critique.status === "done") lines.push(CRITIC_NOT_CHECKED_LINE);
    return lines;
  }
  // The plan was revised after this check and the revised plan was not checked again: the points below are about the earlier version, and are said to be.
  const earlierVersion = critique.revisions > 0 && critique.notRevised !== true && critique.critiques.length <= critique.revisions;
  const blocking = latest.points.filter((point) => point.severity === "blocking").length;
  const revised = critique.revisions > 0 && critique.notRevised !== true && !earlierVersion ? " I revised the plan once after its first check." : "";
  if (earlierVersion) {
    lines.push("A second model checked an earlier version of this plan. The plan was revised after that check, and the revised plan was not checked again.");
    for (const point of latest.points) lines.push(`${point.severity === "blocking" ? "Earlier problem" : "Earlier note"}: ${redactText(point.text).replace(/\s+/gu, " ").trim().slice(0, 500)}`);
    return lines;
  }
  lines.push(latest.points.length === 0 ? `A second model checked this plan and found nothing to change.${revised}`
    : `A second model checked this plan${blocking === 0 ? "" : ` and found ${blocking === 1 ? "a problem" : `${blocking} problems`} it thinks should be fixed`}.${revised}`);
  if (critique.notRevised === true) lines.push(notRevisedLine(critique.limit));
  for (const point of latest.points) lines.push(`${point.severity === "blocking" ? "Problem" : "Note"}: ${redactText(point.text).replace(/\s+/gu, " ").trim().slice(0, 500)}`);
  return lines;
}
