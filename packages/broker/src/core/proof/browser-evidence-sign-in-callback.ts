// TE-H1 browser evidence, slice 3: the `browser-evidence-sign-in` callback. A CHECKS run whose recipe has a sign-in asks here for the project's saved values, and nowhere else: the broker answers from the company's secret store,
// for the company, project and reference IT sent in the run's own invocation, and never from anything the worker says (the request body is empty and is not read).
//
// What is checked before a value is read: the operation is the live CHECKS operation of this install that the broker itself sent a recipe with a sign-in to (so the capability, the fence, the workspace and the company came from the
// callback layer's own read of the company's store); the reference in THAT stored invocation is the reference of the task's own project (`isBrowserEvidenceSignInRefOf`: a recipe that names another project's, a connection's
// or a server's secret reads nothing). The answer is `{ status: "ready", values }` or `{ status: "not_set" }`, with no other word in it, and the route says `no-store`. A refusal is one fixed sentence: it names no secret, no
// path and no project. The values are never written to the operation, the task, the pack, an event or a log by this code.
import { BrowserEvidencePayloadSchema, agentXError, type BrowserEvidenceSignInAnswer } from "@agentx/contracts";
import { isLiveOperation } from "../e2e/uploads-chunks.js";
import type { BrowserEvidenceOperation } from "./browser-evidence-upload.js";
import type { BrowserEvidenceSignIn } from "./browser-evidence-sign-in.js";

const FORBIDDEN = "browser evidence sign-in requires the active CHECKS operation that was asked for it";

export interface BrowserEvidenceSignInCallbackDeps {
  signIn: Pick<BrowserEvidenceSignIn, "read">;
  /** The company the operation runs for (the callback layer's own read; never the request's). */
  companyId: string;
  /** The project of the task this operation belongs to, read from the company's own store. Undefined when it cannot be read. */
  projectOf(operation: BrowserEvidenceOperation): Promise<string | undefined>;
}

export async function handleBrowserEvidenceSignIn(deps: BrowserEvidenceSignInCallbackDeps, operation: BrowserEvidenceOperation): Promise<BrowserEvidenceSignInAnswer> {
  const payload = operation.dispatch?.payload;
  const recipe = typeof payload === "object" && payload !== null && !Array.isArray(payload) ? BrowserEvidencePayloadSchema.safeParse((payload as Record<string, unknown>)["browserEvidence"]) : undefined;
  if (operation.kind !== "task" || operation.workflowMode !== "CHECKS" || !isLiveOperation(operation.status) || recipe === undefined || !recipe.success || recipe.data.signIn === undefined) throw agentXError("CALLBACK_FORBIDDEN", FORBIDDEN);
  const project = await deps.projectOf(operation);
  if (project === undefined) throw agentXError("CALLBACK_FORBIDDEN", FORBIDDEN);
  const values = await deps.signIn.read(deps.companyId, project, recipe.data.signIn.credentialRef);
  return values === undefined ? { status: "not_set" } : { status: "ready", values };
}
