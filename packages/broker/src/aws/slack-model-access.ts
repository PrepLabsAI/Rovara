// Rovara's Slack chat and message router on the COMPANY's AI (DEC 254zzz79 (3)): the Slack service's route family answers "how are this thread's model calls made?".
//
//   POST /v1/service/model-access   {}   ->   install | gateway(baseUrl, model, token) | unavailable      (contracts/slack-model-access.ts)
//
// Who and what are decided HERE, from the verified Slack thread, never from the body (which names nothing):
//  - a deployment with NO company mode (Slack company workspaces off: the customer's OWN single-tenant install) is `install`: its model runtime is the customer's own AWS account, as it always was;
//  - in company mode the COMPANY is the Slack workspace's own binding, read live (`companyOf`), never a person's, a header's or the body's; a workspace with no binding, one that only has the install team's
//    implicit company, and an unreadable binding are `unavailable` (no Rovara-paid fallback). The install team counts when it is bound to a company (DEC 254zzz79 (1));
//  - the project is the one the thread's channel is bound to (read live by the Slack identity);
//  - the token is minted per call for exactly that company and project (the answers step: the company's own connected AI source, the company's answers month and the one combined company cap count the call;
//    nothing is Rovara-paid), and the company's gateway refuses, in its own fixed words, a company with no AI connected or no room left.
// A conversation that is not a Slack thread, no gateway settings, no task-token signer, or any fault is `unavailable`. Nothing the caller sent, and nothing a fault said, is echoed.
import { IMPLICIT_COMPANY_ID, OrgIdSchema, type SlackChannelBinding, type SlackModelAccessResult, type SlackThread } from "@agentx/contracts";
import type { TokenSigner } from "../developer/tokens.js";
import { hostedAnswersModelName, mintAnswersCallToken } from "../core-host/gateway-answers.js";
import { readGatewayModelAccess } from "../core-host/gateway-model-access.js";

/** The gateway's base for an Anthropic client on the answers route: the client adds `/v1/messages`. */
export const SLACK_GATEWAY_BASE_SUFFIX = "/v1/answers";

export interface SlackModelAccessWiring {
  /** Whether Slack company mode is on in this deployment. Off: `install`, the customer's own AWS account. */
  companyMode: boolean;
  /** The company a Slack workspace is bound to (the binding row, read live); undefined: none. May throw: that is `unavailable`. */
  companyOf(teamId: string): Promise<string | undefined>;
  /** The deployment's environment (the gateway's address and models). */
  env: NodeJS.ProcessEnv;
  /** The install's task-token signer and issuer, read when asked (a deployment whose signer arrives late is picked up then). Absent or undefined: `unavailable`. */
  taskTokens?: (() => { signer: TokenSigner; issuer: string } | undefined) | undefined;
  now?: () => number;
  log?: ((entry: Record<string, unknown>) => void) | undefined;
}

const unavailable = { status: "unavailable" } as const satisfies SlackModelAccessResult;

/** The route's entry from the verified Slack service identity. A caller that is not a Slack thread never gets a token. */
export async function askSlackModelAccessForIdentity(wiring: SlackModelAccessWiring, identity: { slack?: { thread: SlackThread; binding: SlackChannelBinding } | undefined }): Promise<SlackModelAccessResult> {
  const log = (event: string, extra: Record<string, unknown> = {}): void => wiring.log?.({ component: "slack-model-access", event, ...extra });
  if (!wiring.companyMode) return { status: "install" };
  const slack = identity.slack;
  if (slack === undefined) return unavailable;
  try {
    const companyId = await wiring.companyOf(slack.thread.teamId);
    // The install team's implicit company is not a company of the gateway's: nothing here is Rovara-paid.
    if (companyId === undefined || companyId === IMPLICIT_COMPANY_ID || !OrgIdSchema.safeParse(companyId).success) return unavailable;
    const settings = readGatewayModelAccess(wiring.env);
    if (settings === undefined || "problem" in settings) return unavailable;
    const model = hostedAnswersModelName(wiring.env, settings.route.alias);
    if (model === undefined) return unavailable;
    let tokens: { signer: TokenSigner; issuer: string } | undefined;
    try { tokens = wiring.taskTokens?.(); } catch { tokens = undefined; }
    if (tokens === undefined || typeof tokens.issuer !== "string" || tokens.issuer === "" || typeof tokens.signer?.sign !== "function" || typeof tokens.signer.publicJwk !== "function") return unavailable;
    const token = await mintAnswersCallToken({ signer: tokens.signer, issuer: tokens.issuer, companyId: companyId, project: slack.binding.projectName, model, ...(wiring.now === undefined ? {} : { now: wiring.now }) });
    // The gateway origin plus the answers prefix is the base an Anthropic client adds `/v1/messages` to.
    return { status: "gateway", baseUrl: `${settings.gatewayUrl}${SLACK_GATEWAY_BASE_SUFFIX}`, model, token };
  } catch (error) {
    log("model_access.failed", { error: error instanceof Error ? error.name : "unknown" });
    return unavailable;
  }
}
