// Guided onboarding PR 20 (design section 3d step 3): a Linear OAuth app event, already verified and routed by `linear-app-webhook.ts` to ONE company's project (by the workspace's
// bound company, then the project's picked team), goes into the SAME intake an API-key project's own Linear hook uses: `startFromTrackerDelivery` over `linearTracker` with a hook.
// The only differences are where the hook's pieces come from, never what is done with them:
//   - the hook is the project's own team pick (project, the company's CONNECTED workspace, the picked team) and its secret is the app's one signing secret, so the delivery is
//     verified again over its raw bytes and the workspace and the project's STORED team pick (re-read here) are checked again by the same code (`linearIssueCreated`) the per-project hook runs;
//   - the issue is read, and replies are written, with the COMPANY's own OAuth access token (actor=app, `linearCompanyApiAccess`), never an API key, never another company's token.
//     A call under another company's scope is refused before any token is read.
// A company whose connection is not `connected` (needs_reconnect, disconnected, missing) starts nothing and is logged with its status (the notice is Cloud's, PR 13).
// Once: the intake engine holds each event once per company, project and ticket by the event's id (`linear:issue:<Linear issue id>:create`, then the label), so the same Linear event
// that also reaches a project's own API-key hook, or a redelivery whose body differs, starts one task. `Linear-Delivery` is not used: it differs per webhook (the app's and a project's).
import { AgentXError, OrgIdSchema, TrackerWriteRefusedError, agentXError, type HostScope, type OrgId, type RawDelivery, type Tracker } from "@agentx/contracts";
import type { IntakePorts } from "../core/intake/engine.js";
import { startFromTrackerDelivery } from "../core/intake/tracker-events.js";
import { createLinearApiAccess, workspaceOfIssueUrl } from "../plugins/tracker/linear/api.js";
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

/** Codes of a refusal that a retry of the same delivery would meet again. */
const PERMANENT_CODES: ReadonlySet<string> = new Set(["CALLBACK_FORBIDDEN", "FORBIDDEN", "CONFIG_INVALID"]);

export const LINEAR_OTHER_COMPANY = "This Linear connection belongs to another company.";

/**
 * The Linear tracker for ONE company over its OAuth connection: reads and replies with that company's own access token only. `hook` (an app event's project hook) makes it accept
 * that one delivery; without it the tracker accepts none. Every call names its company in its scope, and a scope of another company is refused before anything is read.
 */
export function linearCompanyTracker(input: {
  connections: Pick<LinearConnections, "accessToken">; companyId: string; hook?: { hook: LinearHook; secret: string } | undefined; fetch?: typeof fetch | undefined;
  /** The connected workspace's url key: an issue read whose link is in another workspace (the token changed workspace meanwhile) is no issue. */
  workspace?: string | undefined;
}): Tracker {
  const company = OrgIdSchema.parse(input.companyId);
  const api = linearCompanyApiAccess(input.connections, company, input.fetch);
  const read = api.readIssue;
  const write = api.reply;
  if (read === undefined || write === undefined) throw agentXError("CONFIG_INVALID", "the Linear access is incomplete");
  const own = (orgId: string): void => { if (orgId !== company) throw agentXError("FORBIDDEN", LINEAR_OTHER_COMPANY); };
  const access: LinearTrackerAccess = {
    readIssue: async (orgId, key) => {
      own(orgId);
      const issue = await read(orgId, key);
      return issue === undefined || (input.workspace !== undefined && workspaceOfIssueUrl(issue.url) !== input.workspace.toLowerCase()) ? undefined : issue;
    },
    // The company's own port, whole: a reply (in a thread, when the request names a parent) and a rewrite of a comment Rovara wrote (the ticket thread's root, edited in place). Each names its company, and another company's is refused before anything is sent.
    reply: {
      reply: async (request) => { own(request.orgId); return write.reply(request); },
      ...(write.edit === undefined ? {} : { edit: async (request: Parameters<NonNullable<typeof write.edit>>[0]) => { own(request.orgId); return write.edit!(request); } }),
    },
    ...(input.hook === undefined ? {} : { hook: async (scope: HostScope) => ("orgId" in scope && scope.orgId === company ? input.hook : undefined) }),
  };
  return linearTracker(access);
}

export interface LinearAppIntakeWiring {
  connections: Pick<LinearConnections, "connection" | "accessToken" | "teamPicks">;
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
    // The project's team as it is stored NOW (never the event's own word): a pick removed or changed since routing starts nothing for the old team.
    const pick = (await wiring.connections.teamPicks(companyId)).find((entry) => entry.project === event.project);
    if (pick === undefined) {
      wiring.log({ event: "linear.intake_skipped", ...ids, reason: "no_team_pick" });
      return;
    }
    const ports = await wiring.intakeFor?.(companyId);
    if (ports === undefined) {
      wiring.log({ event: "linear.intake_not_wired", ...ids });
      return;
    }
    const app = await wiring.app();
    if (app === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "Linear app webhooks are not set up");
    const hook: LinearHook = { project: event.project, organizationId: connection.organizationId, teamId: pick.teamId };
    const tracker = linearCompanyTracker({ connections: wiring.connections, companyId, hook: { hook, secret: app.webhookSecret }, fetch: wiring.fetch, workspace: connection.urlKey });
    let results: Awaited<ReturnType<typeof startFromTrackerDelivery>>;
    try {
      results = await startFromTrackerDelivery({ ports, orgId: companyId, project: event.project, tracker, scope: { orgId: companyId }, delivery: event.delivery });
    } catch (error) {
      // A refusal that will never pass (the delivery, the scope, the request or Linear's write access) is said once and answered 200, so Linear does not retry it; anything else
      // may pass and is thrown for a 503 and Linear's retry. The error's code only, never its words.
      const permanent = error instanceof TrackerWriteRefusedError || (error instanceof AgentXError && PERMANENT_CODES.has(error.code));
      wiring.log({ event: "linear.intake_failed", ...ids, code: error instanceof AgentXError ? error.code : error instanceof TrackerWriteRefusedError ? "TRACKER_WRITE_REFUSED" : "unknown", retry: !permanent });
      if (permanent) return;
      throw error;
    }
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
