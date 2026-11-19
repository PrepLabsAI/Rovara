// Guided onboarding PR 7 (design section 3d step 3): the Linear OAuth app's webhooks, one route for every workspace that authorized the app (POST /v1/linear/webhooks).
//
// In order, and nothing is read before the step before it holds:
//   1. the raw body (at most 1 MB) must carry a `Linear-Signature` that is the hex HMAC-SHA256 of exactly those bytes under the app's signing secret (by reference: read from
//      the app's secret, never a variable or a log), compared in constant time (plugins/tracker/linear/webhook.ts `verifyLinearSignature`, the per-project hook's own check);
//   2. its `webhookTimestamp` (ms) must be within 60 seconds of now (Linear's guidance), in either direction;
//   3. the same body is taken once (a replay inside the window is a no-op);
//   4. `organizationId` is routed to the company it is bound to (LINEAR_WORKSPACE#<id>); an unknown workspace is a 200 no-op with the SAME answer as a delivered one (no oracle);
//   5. "OAuthApp revoked": the company's connection is marked disconnected and its tokens dropped;
//   6. Issue and Comment events: only then routed to the company's projects whose picked team is the event's team, each handed to `deliver` (company, project, team, type,
//      action, the parsed body, the delivery itself). Nothing in the body names a company or a project; only the binding and the company's own picks do. PR 20's `deliver`
//      (linear-app-intake.ts) puts each into the project's tracker intake; a company that is not connected gets a log line and nothing else.
// The per-project hook secret path (an API-key project's own Linear webhook, `linearTracker({ hook })`) is untouched: it verifies with the same function and its own secret.
import { z } from "zod";
import type { RawDelivery } from "@agentx/contracts";
import { verifyLinearSignature } from "../plugins/tracker/linear/webhook.js";
import { linearDeliveryOf } from "./linear-app-intake.js";
import type { LinearAppSettings, LinearConnections } from "./linear-connections.js";

export const LINEAR_WEBHOOK_PATH = "/v1/linear/webhooks";
/** How far `webhookTimestamp` may be from now. */
export const LINEAR_WEBHOOK_WINDOW_MS = 60_000;
const MAX_BODY_BYTES = 1_048_576;

/** One event Linear sent for one of the company's projects (by the project's picked team). */
export interface LinearProjectEvent {
  companyId: string;
  project: string;
  teamId: string;
  type: "Issue" | "Comment";
  action: string;
  body: unknown;
  /** The Linear workspace the delivery is from (the company's bound one). */
  organizationId: string;
  /** The delivery as received (the raw body and its signature header), so the intake verifies it again with the per-project hook's own code (PR 20). */
  delivery: RawDelivery;
}

export interface LinearWebhookWiring {
  connections: Pick<LinearConnections, "companyOfWorkspace" | "connection" | "teamPicks" | "markRevoked" | "takeDelivery" | "releaseDelivery">;
  app: () => Promise<LinearAppSettings | undefined>;
  now: () => number;
  /** Hands one event to the project's tracker work. Absent: the routing is logged (event names and ids only) and nothing else happens. */
  deliver?: (event: LinearProjectEvent) => Promise<void>;
  log: (entry: Record<string, unknown>) => void;
}

export type LinearWebhookAnswer = { status: 200; body: { ok: true } } | { status: 401; body: { error: { code: "CALLBACK_FORBIDDEN"; message: string } } } | { status: 503; body: { error: { code: "RUNTIME_UNAVAILABLE"; message: string } } };

export const WEBHOOK_REFUSED = "the delivery is not a valid Linear app delivery";
export const WEBHOOK_NOT_SET_UP = "Linear app webhooks are not set up";
const OK: LinearWebhookAnswer = { status: 200, body: { ok: true } };
const refused = (): LinearWebhookAnswer => ({ status: 401, body: { error: { code: "CALLBACK_FORBIDDEN", message: WEBHOOK_REFUSED } } });
const unavailable = (): LinearWebhookAnswer => ({ status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: WEBHOOK_NOT_SET_UP } } });

const Id = z.string().regex(/^[A-Za-z0-9-]{1,100}$/);
const Envelope = z.object({ type: z.string().max(64), action: z.string().max(64), organizationId: Id, webhookTimestamp: z.number().int().positive() }).passthrough();
const IssueTeam = z.object({ data: z.object({ teamId: Id.optional(), team: z.object({ id: Id.optional() }).passthrough().optional() }).passthrough() }).passthrough();
const CommentTeam = z.object({ data: z.object({ issue: z.object({ teamId: Id.optional(), team: z.object({ id: Id.optional() }).passthrough().optional() }).passthrough().optional() }).passthrough() }).passthrough();
const Revoked = z.object({ oauthClientId: z.string().max(128).optional() }).passthrough();

function teamOf(type: "Issue" | "Comment", body: unknown): string | undefined {
  if (type === "Issue") {
    const parsed = IssueTeam.safeParse(body);
    return parsed.success ? parsed.data.data.teamId ?? parsed.data.data.team?.id : undefined;
  }
  const parsed = CommentTeam.safeParse(body);
  return parsed.success ? parsed.data.data.issue?.teamId ?? parsed.data.data.issue?.team?.id : undefined;
}

/**
 * One fixed line when a signature fails, naming the workspace the (unverified) body claims, so a per-workspace signing secret would show up quickly: Rovara assumes ONE app-wide
 * secret. The workspace id is read only when it has the shape of an id (so nothing else from the body can reach the log); the secret and the signature are never logged.
 */
function signatureFailed(wiring: LinearWebhookWiring, rawBody: string): void {
  let organizationId: string | undefined;
  try {
    const claimed = z.object({ organizationId: Id }).passthrough().safeParse(JSON.parse(rawBody));
    organizationId = claimed.success ? claimed.data.organizationId : undefined;
  } catch { organizationId = undefined; }
  try { wiring.log({ event: "linear.webhook_signature_failed", ...(organizationId === undefined ? {} : { organizationId }) }); } catch { /* a log that fails changes nothing */ }
}

/** One delivery, end to end. Never throws to the caller: every answer is one of three fixed ones (no echo of the body, the cause or a company). */
export async function handleLinearAppWebhook(wiring: LinearWebhookWiring, input: { rawBody: string | undefined; headers: Readonly<Record<string, string | undefined>> }): Promise<LinearWebhookAnswer> {
  let app: LinearAppSettings | undefined;
  try { app = await wiring.app(); } catch { app = undefined; }
  if (app === undefined) return unavailable();
  if (input.rawBody === undefined) return refused();
  const raw = Buffer.from(input.rawBody, "utf8");
  if (raw.byteLength > MAX_BODY_BYTES) return refused();
  // 1. The signature, over the raw bytes, before anything is parsed.
  if (!verifyLinearSignature(raw, input.headers, app.webhookSecret)) {
    signatureFailed(wiring, input.rawBody);
    return refused();
  }
  let parsedBody: unknown;
  try { parsedBody = JSON.parse(input.rawBody); } catch { return refused(); }
  const envelope = Envelope.safeParse(parsedBody);
  if (!envelope.success) return refused();
  // 2. Fresh: within the window either way (a future stamp is no more trusted than an old one).
  if (Math.abs(wiring.now() - envelope.data.webhookTimestamp) > LINEAR_WEBHOOK_WINDOW_MS) return refused();
  // 3. Once.
  try { if (!await wiring.connections.takeDelivery(input.rawBody)) return OK; } catch { return unavailable(); }
  try {
    // 4. The bound company, or nothing at all.
    const companyId = await wiring.connections.companyOfWorkspace(envelope.data.organizationId);
    if (companyId === undefined) return OK;
    const { type, action } = envelope.data;
    // 5. The app was revoked in that workspace.
    if (type === "OAuthApp" && action === "revoked") {
      const revoked = Revoked.safeParse(parsedBody);
      // A revoke naming another app's client is not this app's.
      if (revoked.success && revoked.data.oauthClientId !== undefined && revoked.data.oauthClientId !== app.clientId) return OK;
      await wiring.connections.markRevoked(envelope.data.organizationId);
      return OK;
    }
    if (type !== "Issue" && type !== "Comment") return OK;
    // 6. Only a connected company's projects, and only those whose picked team is the event's.
    const connection = await wiring.connections.connection(companyId);
    if (connection === undefined || connection.status !== "connected" || connection.organizationId !== envelope.data.organizationId) {
      // PR 20: no intake for a company whose connection needs reconnecting or is gone; said once per event, ids only (Cloud shows the notice, PR 13).
      wiring.log({ companyId, event: "linear.webhook_not_connected", reason: connection === undefined ? "not_connected" : connection.status !== "connected" ? connection.status : "other_workspace", type, action });
      return OK;
    }
    const teamId = teamOf(type, parsedBody);
    if (teamId === undefined) return OK;
    const projects = (await wiring.connections.teamPicks(companyId)).filter((pick) => pick.teamId.toLowerCase() === teamId.toLowerCase()).map((pick) => pick.project);
    for (const project of projects) {
      if (wiring.deliver === undefined) wiring.log({ companyId, event: "linear.webhook_routed", project, type, action });
      else await wiring.deliver({ companyId, project, teamId, type, action, body: parsedBody, organizationId: envelope.data.organizationId, delivery: linearDeliveryOf(input.rawBody, input.headers) });
    }
    return OK;
  } catch {
    // A store or delivery failure: Linear retries a 5xx, so the delivery is given back first. Fixed words only.
    await wiring.connections.releaseDelivery(input.rawBody).catch(() => undefined);
    return unavailable();
  }
}

/** The HTTP answer, as the broker's handler sends it. */
export function linearWebhookResponse(answer: LinearWebhookAnswer, requestId: string) {
  return { statusCode: answer.status, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify({ ...answer.body, requestId }) };
}
