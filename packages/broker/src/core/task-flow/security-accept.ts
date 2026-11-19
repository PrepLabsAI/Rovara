// Task actions (DEC 236h): accepting a SECURITY review finding is the person's own act on Rovara's web page. A script token and an API token (the CLI, an AI tool) may never accept one; they
// may still accept the code review's findings, where the move allows it. The proof is two things the caller cannot write itself: the surface (`via`, which only the page's own route sets to "page") and the
// client (`TaskCaller.webApp`: the Rovara web app's own sign-in client, not any full-access client). DEC 254zzz73: no step-up; who may accept (the task's owner) is the move's own rule, unchanged.
// The refusals use fixed words and never echo anything the request carried.
import { agentXError, openReviewFindings, type WorkflowResolveFindingsInput, type WorkflowSnapshot } from "@agentx/contracts";
import type { TaskCaller } from "./deps.js";
import type { FindingAcceptMethod } from "./finding-accept.js";

export const SECURITY_ACCEPT_ON_THE_PAGE = "Accepting a security finding needs the Rovara web page";

/** How many of the findings the request accepts are the given review's. */
export function acceptedOfRole(workflow: WorkflowSnapshot, request: WorkflowResolveFindingsInput, role: "CRITIC" | "SECURITY"): number {
  const open = new Map(openReviewFindings(workflow).map((finding) => [finding.findingId, finding]));
  return request.resolutions.filter((resolution) => resolution.action === "ACCEPT" && open.get(resolution.findingId)?.role === role).length;
}

/**
 * Refuses the request, with nothing written, when it accepts a security finding and the caller is not the web page. A request that accepts no security finding (it fixes them, or accepts only
 * the code review's) is not asked for anything more.
 */
export function requirePageForSecurityAccept(caller: TaskCaller, via: FindingAcceptMethod, workflow: WorkflowSnapshot, request: WorkflowResolveFindingsInput): void {
  if (acceptedOfRole(workflow, request, "SECURITY") === 0) return;
  // A script token, an API token's route (the laptop's, the CLI's, an AI tool's), or any client but the web app's own is never the page.
  if (caller.scriptToken !== undefined || via !== "page" || caller.webApp !== true) throw agentXError("FORBIDDEN", SECURITY_ACCEPT_ON_THE_PAGE);
}
