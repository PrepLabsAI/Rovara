// Spec 062 FR-051: the CLI side of the channel adapter admin routes. Every call is an administrator's; the broker checks
// they administer each project named.
import {
  RegisteredChannelIdSchema,
  ChannelAdapterRecordSchema,
  ChannelAdapterRegistrationSchema,
  ChannelOpaqueIdSchema,
  agentXError,
  type ChannelAdapterRecord,
  type ChannelAdapterRegistration,
} from "@rovara-code/contracts";
import { readJsonResponse, serverError } from "./http.js";

export interface AdminCall { controlPlaneUrl: string; accessToken: string }

async function call(session: AdminCall, method: "GET" | "PUT" | "DELETE", path: string, fetchImplementation: typeof fetch, body?: unknown): Promise<Record<string, unknown>> {
  const response = await fetchImplementation(`${session.controlPlaneUrl.replace(/\/$/, "")}${path}`, {
    method,
    headers: { authorization: `Bearer ${session.accessToken}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const { ok, status, body: parsed } = await readJsonResponse(response);
  if (!ok) {
    const error = parsed === undefined ? undefined : serverError(parsed);
    if (status === 404 && error?.message?.includes("channel adapters are not enabled") === true) {
      throw agentXError("NOT_FOUND", "channel adapters are not enabled in this environment; deploy it with the ChannelAdapters parameter set to enabled");
    }
    throw agentXError("RUNTIME_UNAVAILABLE", `the control plane refused ${method} ${path}: ${error?.message ?? `HTTP ${status}`}`);
  }
  if (typeof parsed !== "object" || parsed === null) throw agentXError("RUNTIME_UNAVAILABLE", "control plane returned an invalid response");
  return parsed as Record<string, unknown>;
}

const segment = (value: string) => encodeURIComponent(value);
const channelOf = (value: string) => RegisteredChannelIdSchema.parse(value);
const idOf = (value: string, what: string) => {
  const parsed = ChannelOpaqueIdSchema.safeParse(value);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", `${what} must be 1–128 characters from letters, digits and . _ : + @ = -`);
  return parsed.data;
};

/** Registers or changes an adapter. The signing secret is in the answer only when it was made (first time, or rotate). */
export async function registerAdapter(
  session: AdminCall,
  input: { channel: string; registration: ChannelAdapterRegistration; rotate?: boolean },
  fetchImplementation: typeof fetch = fetch,
): Promise<{ adapter: ChannelAdapterRecord; signingSecret?: string }> {
  const channel = channelOf(input.channel);
  const registration = ChannelAdapterRegistrationSchema.parse(input.registration);
  const answer = await call(session, "PUT", `/v1/admin/channels/${segment(channel)}${input.rotate === true ? "?rotate=true" : ""}`, fetchImplementation, registration);
  const adapter = ChannelAdapterRecordSchema.parse(answer.adapter);
  return { adapter, ...(typeof answer.signingSecret === "string" ? { signingSecret: answer.signingSecret } : {}) };
}

export async function listAdapters(session: AdminCall, fetchImplementation: typeof fetch = fetch): Promise<ChannelAdapterRecord[]> {
  const answer = await call(session, "GET", "/v1/admin/channels", fetchImplementation);
  return ChannelAdapterRecordSchema.array().parse(answer.adapters);
}

export async function removeAdapter(session: AdminCall, channel: string, fetchImplementation: typeof fetch = fetch): Promise<void> {
  await call(session, "DELETE", `/v1/admin/channels/${segment(channelOf(channel))}`, fetchImplementation);
}

export async function bindAdapterSpace(
  session: AdminCall,
  input: { channel: string; tenant: string; space: string; projectName: string },
  fetchImplementation: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  const path = `/v1/admin/channels/${segment(channelOf(input.channel))}/bindings/${segment(idOf(input.tenant, "--tenant"))}/${segment(idOf(input.space, "--space"))}`;
  return call(session, "PUT", path, fetchImplementation, { projectName: input.projectName });
}

export async function unbindAdapterSpace(session: AdminCall, input: { channel: string; tenant: string; space: string }, fetchImplementation: typeof fetch = fetch): Promise<void> {
  const path = `/v1/admin/channels/${segment(channelOf(input.channel))}/bindings/${segment(idOf(input.tenant, "--tenant"))}/${segment(idOf(input.space, "--space"))}`;
  await call(session, "DELETE", path, fetchImplementation);
}

/** FR-031: an administrator removes an actor's link, so the actor must link again before acting. */
export async function unlinkAdapterUser(session: AdminCall, input: { channel: string; tenant: string; userId: string }, fetchImplementation: typeof fetch = fetch): Promise<void> {
  const path = `/v1/admin/channel-links/${segment(channelOf(input.channel))}/${segment(idOf(input.tenant, "--tenant"))}/${segment(idOf(input.userId, "--user"))}`;
  await call(session, "DELETE", path, fetchImplementation);
}
