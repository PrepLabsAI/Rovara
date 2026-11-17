// Guided onboarding PR 20 (design section 3d step 3): a Linear OAuth app event, already verified and routed by `linear-app-webhook.ts` to ONE company's project (by the workspace's
// bound company, then the project's picked team), goes into the SAME intake an API-key project's own Linear hook uses: `startFromTrackerDelivery` over `linearTracker` with a hook.
// The only differences are where the hook's pieces come from, never what is done with them:
//   - the hook is the project's own team pick (project, the company's CONNECTED workspace, the picked team) and its secret is the app's one signing secret, so the delivery is
//     verified again over its raw bytes and the workspace and team are checked again by the same code (`linearIssueCreated`) the per-project hook runs;
//   - the issue is read, and replies are written, with the COMPANY's own OAuth access token (actor=app, `linearCompanyApiAccess`), never an API key, never another company's token.
//     A call under another company's scope is refused before any token is read.
// A company whose connection is not `connected` (needs_reconnect, disconnected, missing) starts nothing and is logged with its status (the notice is Cloud's, PR 13).
// Once: the intake engine holds each event once per company, project and ticket by the event's id (`linear:issue:<Linear issue id>:create`, then the label), so the same Linear event
// that also reaches a project's own API-key hook, or a redelivery whose body differs, starts one task. `Linear-Delivery` is not used: it differs per webhook (the app's and a project's).
import { OrgIdSchema, agentXError, type HostScope, type OrgId, type RawDelivery, type Tracker } from "@agentx/contracts";
import type { IntakePorts } from "../core/intake/engine.js";
import { startFromTrackerDelivery } from "../core/intake/tracker-events.js";
import { createLinearApiAccess } from "../plugins/tracker/linear/api.js";
import { linearTracker, type LinearTrackerAccess } from "../plugins/tracker/linear/index.js";
import type { LinearHook } from "../plugins/tracker/linear/webhook.js";
import type { LinearProjectEvent } from "./linear-app-webhook.js";
import type { LinearAppSettings, LinearConnections } from "./linear-connections.js";

/**
 * The Linear tracker's access for ONE company over its OAuth connection: every call sends that company's own access token (`Bearer`), refreshed as needed. The app acts as
 * itself (actor=app), so what it writes is Rovara's own.
 */
export function linearCompanyApiAccess(connections: Pick<LinearConnections, "accessToken">, companyId: string, fetchImpl?: typeof fetch) {
  const company = OrgIdSchema.parse(companyId);
  return createLinearApiAccess({
    apiKey: async () => `Bearer ${await connections.accessToken(company)}`, companyId: company, ownAccountIsRovara: true, ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
  });
}

export const LINEAR_OTHER_COMPANY = "This Linear connection belongs to another company.";

/**
 * The Linear tracker for ONE company over its OAuth connection: reads and replies with that company's own access token only. `hook` (an app event's project hook) makes it accept
 * that one delivery; without it the tracker accepts none. Every call names its company in its scope, and a scope of another company is refused before anything is read.
 */
export function linearCompanyTracker(input: {
  connections: Pick<LinearConnections, "accessToken">; companyId: string; hook?: { hook: LinearHook; secret: string } | undefined; fetch?: typeof fetch | undefined;
}): Tracker {
  const company = OrgIdSchema.parse(input.companyId);
  const api = linearCompanyApiAccess(input.connections, company, input.fetch);
  const read = api.readIssue;
  const write = api.reply;
  if (read === undefined || write === undefined) throw agentXError("CONFIG_INVALID", "the Linear access is incomplete");
  const own = (orgId: string): void => { if (orgId !== company) throw agentXError("FORBIDDEN", LINEAR_OTHER_COMPANY); };
  const access: LinearTrackerAccess = {
    readIssue: async (orgId, key) => { own(orgId); return read(orgId, key); },
    reply: { reply: async (request) => { own(request.orgId); return write.reply(request); } },
    ...(input.hook === undefined ? {} : { hook: async (scope: HostScope) => ("orgId" in scope && scope.orgId === company ? input.hook : undefined) }),
  };
  return linearTracker(access);
}

export interface LinearAppIntakeWiring {
  connections: Pick<LinearConnections, "connection" | "accessToken">;
  app: () => Promise<LinearAppSettings | undefined>;
  /** The intake engine's ports for ONE company. Absent, or undefined for a company: this install has no tracker intake there, so the event is logged (ids only) and nothing starts. */
  intakeFor?: ((companyId: OrgId) => Promise<IntakePorts | undefined>) | undefined;
  fetch?: typeof fetch | undefined;
  log: (entry: Record<string, unknown>) => void;
}

/**
 * The webhook's `deliver`: one routed event into the company's intake. A failure that may pass throws, so the webhook gives the delivery back (503) and Linear retries it; the engine's
 * event id keeps the retry from starting a second task.
 */
export function linearAppIntakeDeliver(wiring: LinearAppIntakeWiring): (event: LinearProjectEvent) => Promise<void> {
  return async (event) => {
    const companyId = OrgIdSchema.parse(event.companyId);
    const ids = { companyId, project: event.project, type: event.type, action: event.action };
    // Read again here: the connection decides, at the moment of intake, which workspace this company speaks for and whether it may act at all.
    const connection = await wiring.connections.connection(companyId);
    if (connection === undefined || connection.status !== "connected" || connection.organizationId !== event.organizationId) {
      wiring.log({ event: "linear.intake_skipped", ...ids, reason: connection === undefined ? "not_connected" : connection.status !== "connected" ? connection.status : "other_workspace" });
      return;
    }
    const ports = await wiring.intakeFor?.(companyId);
    if (ports === undefined) {
      wiring.log({ event: "linear.intake_not_wired", ...ids });
      return;
    }
    const app = await wiring.app();
    if (app === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "Linear app webhooks are not set up");
    const hook: LinearHook = { project: event.project, organizationId: connection.organizationId, teamId: event.teamId };
    const tracker = linearCompanyTracker({ connections: wiring.connections, companyId, hook: { hook, secret: app.webhookSecret }, fetch: wiring.fetch });
    const results = await startFromTrackerDelivery({ ports, orgId: companyId, project: event.project, tracker, scope: { orgId: companyId }, delivery: event.delivery });
    wiring.log({ event: "linear.intake_delivered", ...ids, outcomes: results.map((result) => result.outcome === "skipped" ? "skipped" : result.outcome.outcome) });
  };
}

/** The headers a delivery is verified with again (the signature only), from what the webhook received. */
export function linearDeliveryOf(rawBody: string, headers: Readonly<Record<string, string | undefined>>): RawDelivery {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "linear-signature" && value !== undefined) return { rawBody, headers: { "linear-signature": value } };
  }
  return { rawBody, headers: {} };
}
