// The old workflow route `POST /v1/dev/tasks/{id}/workflow/review-findings` (DEC 236h): accepting a SECURITY review finding is the web page's alone, the Rovara web app's own full-access session (DEC 254zzz73:
// no step-up). The Rovara CLI's token, an AI tool's token, a scoped sign-in client's token and ANOTHER full-access client's token (the caller's own `webApp` is absent) may still accept the code review's findings,
// and fix any finding, as before.
//   - What makes a caller the page: the sign-in client the operator marked `webApp` (full access, spec 066; the marker is never set by an administrator's registration), read from its registration in the
//     sign-in step, never from a header, a query or a body. No other caller is the page, whatever it sends. Who may accept (the task's owner) is the route's own rule, unchanged.
// The refusals use fixed words and never echo anything the request carried. The same rule is the core engine's (`core/task-flow/security-accept.ts`).
import { agentXError, openReviewFindings, type WorkflowResolveFindingsInput, type WorkflowSnapshot } from "@agentx/contracts";

export const SECURITY_ACCEPT_ON_THE_PAGE = "Accepting a security finding needs the Rovara web page";

/** What the rule reads of the caller: whether it is the Rovara web app's client. */
export interface SecurityAcceptCaller {
  webApp?: true | undefined;
}

/** How many of the findings the request accepts are the security review's. */
export function acceptedSecurityFindings(workflow: WorkflowSnapshot, request: WorkflowResolveFindingsInput): number {
  const open = new Map(openReviewFindings(workflow).map((finding) => [finding.findingId, finding]));
  return request.resolutions.filter((resolution) => resolution.action === "ACCEPT" && open.get(resolution.findingId)?.role === "SECURITY").length;
}

/**
 * Refuses the request, with nothing written, when it accepts a security finding and the caller is not the Rovara web app's session. A request that accepts no security finding (it fixes
 * them, or accepts only the code review's) is not asked for anything more.
 */
export function requireWebPageForSecurityAccept(caller: SecurityAcceptCaller, workflow: WorkflowSnapshot, request: WorkflowResolveFindingsInput): void {
  if (acceptedSecurityFindings(workflow, request) === 0) return;
  if (caller.webApp !== true) throw agentXError("FORBIDDEN", SECURITY_ACCEPT_ON_THE_PAGE);
}
