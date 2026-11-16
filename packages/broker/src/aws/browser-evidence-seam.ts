// TE-H1 browser evidence (DEC 241): Cloud has no browser evidence yet (DEFERRED 1b-X5: a per-company executor gate). The callback exists on Code (`services/callbacks.ts`); on Cloud the route is listed so a worker that tries it
// is told one fixed sentence, never "route not found" (which would read as a fault), and nothing is read, stored or echoed. Cloud never sends the recipe or issues the capability, so this is the seam and not a path anything takes today.
import { BROWSER_EVIDENCE_NOT_ON_CLOUD, agentXError } from "@agentx/contracts";

/** The callback action Code serves and Cloud refuses. */
export const BROWSER_EVIDENCE_CALLBACK_ACTION = "browser-evidence";
/** Slice 3: the sign-in callback is refused the same way (Cloud holds no saved sign-in a worker could ask for). */
export const BROWSER_EVIDENCE_SIGN_IN_CALLBACK_ACTION = "browser-evidence-sign-in";

/** Throws the fixed refusal for the browser-evidence actions; any other action passes. */
export function refuseBrowserEvidenceOnCloud(action: string): void {
  if (action === BROWSER_EVIDENCE_CALLBACK_ACTION || action === BROWSER_EVIDENCE_SIGN_IN_CALLBACK_ACTION) throw agentXError("NOT_FOUND", BROWSER_EVIDENCE_NOT_ON_CLOUD);
}
