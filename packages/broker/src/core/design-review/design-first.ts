// Design review stage (Slack and Linear intake): "design first" typed in a request (`design first: ...`), recorded on the task so the Understand step's mode resolution can read it. The record is the
// person's ask and nothing more: it turns the review on only while the design review stage exists for the company (`dr` on and the company allows it), and the company's lock and the high-risk rules apply exactly as they do to the button.
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { taskKey } from "../../developer/task-records.js";
import { parseDesignFirstPrefix } from "../../rovara-code/explicit-path.js";
import { agentXError, DESIGN_FIRST_UNAVAILABLE_MESSAGE, type OrgId } from "@agentx/contracts";
import type { ProjectPlaybookReader } from "./playbook-store.js";
import { designReviewAvailableFor } from "./switch.js";

/**
 * The `design first:` prefix of a request typed in Slack or a Linear ticket, read ONLY while the design review stage exists for the company (`dr` on and the company allows it; with `dr` off nothing is read). Otherwise the text is not looked at: it is
 * returned as it came (no prefix is stripped and nothing is recorded), exactly as it was handled before the stage existed.
 */
export async function designFirstRequestOf(deps: ProjectPlaybookReader, orgId: OrgId, text: string, env: NodeJS.ProcessEnv = process.env): Promise<{ designFirst: boolean; rest: string }> {
  return (await designReviewAvailableFor(deps, orgId, env)) ? parseDesignFirstPrefix(text) : { designFirst: false, rest: text };
}

/** What the web start refuses with when the box's "Design first" is sent while the stage does not exist for the company. It says nothing about why. */
export const DESIGN_FIRST_UNAVAILABLE = DESIGN_FIRST_UNAVAILABLE_MESSAGE;

/**
 * The web start box : the ticked "Design first" option (`asked`) and a leading `design first:` in the typed text mean the same thing as in Slack and Linear, and both are honoured only while the stage exists for the
 * company (`dr` on and the company allows it; the project's own mode is not asked, a project set to Off can still ask for one task). The ticked option with the stage unavailable is REFUSED (`CONFIG_INVALID`, no reason given),
 * never dropped, so a stale page cannot believe a review was asked for. A typed prefix with the stage unavailable is left in the text, as it is for Slack. `deps` absent means the stage cannot be read: unavailable.
 */
export async function designFirstWebStart(deps: ProjectPlaybookReader | undefined, orgId: OrgId, input: { text: string; asked: boolean }, env: NodeJS.ProcessEnv = process.env): Promise<{ designFirst: boolean; text: string }> {
  const available = deps !== undefined && await designReviewAvailableFor(deps, orgId, env);
  if (!available) {
    if (input.asked) throw agentXError("CONFIG_INVALID", DESIGN_FIRST_UNAVAILABLE);
    return { designFirst: false, text: input.text };
  }
  const typed = parseDesignFirstPrefix(input.text);
  if (typed.designFirst && typed.rest.trim() === "") throw agentXError("CONFIG_INVALID", "input.text: request is empty");
  // The text after the prefix is trimmed, as Slack trims it; text with no prefix is exactly what was typed.
  return { designFirst: input.asked || typed.designFirst, text: typed.designFirst ? typed.rest.trim() : typed.rest };
}

export interface DesignFirstRequest { by: string; at: string }

/** Records the ask on a task that was just started. Best effort: a failure leaves the task as a plain one, and the button is still there. */
export async function markDesignFirst(deps: { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string }, taskId: string, by: string, now: () => string = () => new Date().toISOString()): Promise<void> {
  try {
    await deps.documentClient.send(new UpdateCommand({
      TableName: deps.tableName, Key: taskKey(taskId), UpdateExpression: "SET designFirst = :request", ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(closedAt) AND attribute_not_exists(designFirst)",
      ExpressionAttributeValues: { ":request": { by, at: now() } },
    }));
  } catch { /* a task that cannot be marked runs as a plain one */ }
}
