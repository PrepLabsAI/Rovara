import { SlackChannelIdSchema, SlackTeamIdSchema, agentXError } from "@agentx/contracts";
import { readJsonResponse, serverError } from "./http.js";

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
  const { ok, status, body: parsedBody } = await readJsonResponse(response);
  if (!ok) {
    const message = parsedBody === undefined ? `HTTP ${status}` : (serverError(parsedBody).message ?? `HTTP ${status}`);
    throw agentXError("RUNTIME_UNAVAILABLE", `Slack channel ${method === "PUT" ? "binding" : "unbinding"} failed: ${message}`);
  }
  if (parsedBody === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "control plane returned an invalid response");
  return parsedBody;
}
