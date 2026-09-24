import { SlackChannelIdSchema, SlackTeamIdSchema, agentXError } from "@agentx/contracts";

interface SlackChannelInput {
  controlPlaneUrl: string;
  accessToken: string;
  teamId: string;
  channelId: string;
}

export async function bindSlackChannel(
  input: SlackChannelInput & { projectName: string },
  fetchImplementation: typeof fetch = fetch,
): Promise<unknown> {
  return sendBindingRequest(input, "PUT", fetchImplementation, JSON.stringify({ projectName: input.projectName }));
}

export async function unbindSlackChannel(
  input: SlackChannelInput,
  fetchImplementation: typeof fetch = fetch,
): Promise<unknown> {
  return sendBindingRequest(input, "DELETE", fetchImplementation);
}

async function sendBindingRequest(
  input: SlackChannelInput,
  method: "PUT" | "DELETE",
  fetchImplementation: typeof fetch,
  body?: string,
): Promise<unknown> {
  const teamId = SlackTeamIdSchema.parse(input.teamId);
  const channelId = SlackChannelIdSchema.parse(input.channelId);
  const response = await fetchImplementation(
    `${input.controlPlaneUrl.replace(/\/$/, "")}/v1/admin/slack/bindings/${teamId}/${channelId}`,
    {
      method,
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body }),
    },
  );
  const result: unknown = await response.json();
  if (!response.ok) {
    const message = serverMessage(result) ?? `HTTP ${response.status}`;
    throw agentXError("RUNTIME_UNAVAILABLE", `Slack channel ${method === "PUT" ? "binding" : "unbinding"} failed: ${message}`);
  }
  return result;
}

function serverMessage(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || !("error" in value)) return undefined;
  const error = value.error;
  if (!error || typeof error !== "object" || !("message" in error)) return undefined;
  return typeof error.message === "string" ? error.message : undefined;
}
