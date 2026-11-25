// A1-12's person at the surface that OUTLIVES Code's own task page (DEC 254zzz511): a CLI session on a /v1/dev route (a bearer token over a session row, `authenticateSession`). Requests go through the same tracked broker front as every other journey (`world.handler`), so the real-core proof sees them.
import { randomUUID } from "node:crypto";
import { bearerFor, type Developer } from "../../support/developer-task-broker.js";
import type { JourneyWorld } from "./hosted-core.js";

export const DAY_MS = 86_400_000;

export interface Answer { status: number; headers: Record<string, string>; text: string; json(): Record<string, unknown> }
const answerOf = (response: unknown): Answer => {
  const reply = response as { statusCode: number; headers?: Record<string, string>; body: string };
  return { status: reply.statusCode, headers: reply.headers ?? {}, text: reply.body, json: () => JSON.parse(reply.body) as Record<string, unknown> };
};

/**
 * A person's session row as the sign-in service writes it for a CLI or tool sign-in (no client, no review window): it ends at `endsAtSeconds` (epoch seconds; the CLI's own sign-in lasts
 * DEVELOPER_SESSION_SECONDS, a browser sign-in 30 days). Returns the person to sign requests with: the same registered identity as `who`, signed in with this session. `fields` overrides the
 * stored row (a revocation, a client).
 */
export function writeCliSession(world: JourneyWorld, who: Developer, endsAtSeconds: number, fields: Record<string, unknown> = {}): Developer {
  const sessionId = `s-${randomUUID()}`;
  world.harness.db.set({ pk: `SESSION#${sessionId}`, sk: "META", sessionId, developerId: who.developerId, amr: who.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: endsAtSeconds, ...fields });
  return { ...who, sessionId };
}

/** A /v1/dev request with the person's bearer token (minted now, so a clock moved later still gets a token the verifier accepts). */
export async function bearerRequest(world: JourneyWorld, who: Developer, method: string, path: string, body?: unknown): Promise<Answer> {
  return answerOf(await world.handler({ version: "2.0", rawPath: path.split("?")[0], rawQueryString: path.split("?")[1] ?? "",
    headers: { authorization: await bearerFor(who) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), requestContext: { requestId: randomUUID(), http: { method } } }));
}
