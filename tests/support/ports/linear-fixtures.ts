// Linear fixtures: a hook (the project and the Linear workspace and team it speaks for), a signing secret that is not real, and a delivery signed exactly as `Linear-Signature` is.
import { createHmac } from "node:crypto";
import type { RawDelivery } from "@agentx/contracts";
import type { LinearHook } from "../../../packages/broker/src/plugins/tracker/linear/webhook.js";

export const LINEAR_ORG = "11111111-1111-4111-8111-111111111111";
export const TEAM = "22222222-2222-4222-8222-222222222222";
export const SECRET = "linear-test-signing-secret-not-real";
export const HOOK: LinearHook = { project: "web", organizationId: LINEAR_ORG, teamId: TEAM };
export const NOW = Date.parse("2026-11-02T10:00:00.000Z");

export function linearBody(over: { id?: string; identifier?: string; labels?: string[]; action?: string; organizationId?: string; teamId?: string } = {}): Record<string, unknown> {
  const identifier = over.identifier ?? "ENG-1";
  return {
    action: over.action ?? "create", type: "Issue", createdAt: new Date(NOW).toISOString(), organizationId: over.organizationId ?? LINEAR_ORG, webhookTimestamp: NOW - 5_000, webhookId: "wh-1",
    url: `https://linear.app/acme/issue/${identifier}/x`, actor: { id: "user-dana", type: "user", name: "Dana" },
    data: { id: over.id ?? "3f2b1c4e-0000-4000-8000-000000000001", identifier, number: 1, title: "Checkout fails", teamId: over.teamId ?? TEAM, team: { id: over.teamId ?? TEAM, key: "ENG" },
      labels: (over.labels ?? ["rovara"]).map((name) => ({ id: `lbl-${name}`, name })), url: `https://linear.app/acme/issue/${identifier}/x` },
  };
}
export const signedLinear = (body: unknown, secret = SECRET): RawDelivery => {
  const rawBody = JSON.stringify(body);
  return { rawBody, headers: { "linear-signature": createHmac("sha256", secret).update(Buffer.from(rawBody, "utf8")).digest("hex") } };
};

