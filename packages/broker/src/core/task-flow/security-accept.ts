// Task actions (DEC 236h): accepting a SECURITY review finding is the person's own act on Rovara's web page, with a fresh sign-in. A script token and an API token (the CLI, an AI tool) may never accept one; they
// may still accept the code review's findings, where the move allows it. The proof is two things the caller cannot write itself: the surface (`via`, which only the page's own route sets to "page") and a fresh
// step-up read from the verified access token (`TaskCaller.stepUp`, `freshStepUp`: Code's own factors only, never a Slack, Google or GitHub round trip; the age against the company's window).
// The refusals use fixed words and never echo anything the request carried.
import { agentXError, openReviewFindings, type WorkflowResolveFindingsInput, type WorkflowSnapshot } from "@agentx/contracts";
import { freshStepUp } from "../../core-host/step-up.js";
import type { TaskCaller } from "./deps.js";
import type { FindingAcceptMethod } from "./finding-accept.js";
import type { TaskActionsOptions } from "./owner-round.js";

export const SECURITY_ACCEPT_ON_THE_PAGE = "Accepting a security finding needs the Rovara web page with a fresh sign-in";

/** How many of the findings the request accepts are the given review's. */
export function acceptedOfRole(workflow: WorkflowSnapshot, request: WorkflowResolveFindingsInput, role: "CRITIC" | "SECURITY"): number {
  const open = new Map(openReviewFindings(workflow).map((finding) => [finding.findingId, finding]));
  return request.resolutions.filter((resolution) => resolution.action === "ACCEPT" && open.get(resolution.findingId)?.role === role).length;
}

/**
 * Refuses the request, with nothing written, when it accepts a security finding and the caller is not the web page with a fresh step-up. A request that accepts no security finding (it fixes them, or accepts only
 * the code review's) is not asked for anything more.
 */
export async function requirePageForSecurityAccept(
  options: Pick<TaskActionsOptions, "stepUpWindowSeconds">, caller: TaskCaller, via: FindingAcceptMethod, workflow: WorkflowSnapshot, request: WorkflowResolveFindingsInput, nowMs: number,
): Promise<void> {
  if (acceptedOfRole(workflow, request, "SECURITY") === 0) return;
  // A script token, or an API token's route (the laptop's, the CLI's, an AI tool's), is never the page.
  if (caller.scriptToken !== undefined || via !== "page") throw agentXError("FORBIDDEN", SECURITY_ACCEPT_ON_THE_PAGE);
  await freshStepUp(caller, options.stepUpWindowSeconds, nowMs, SECURITY_ACCEPT_ON_THE_PAGE);
}
