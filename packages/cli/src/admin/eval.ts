import { SlackChannelIdSchema, SlackTeamIdSchema, SwebenchChannelRequestSchema, agentXError } from "@agentx/contracts";
import { readJsonResponse, serverError } from "./http.js";

interface EvalChannelInput {
  controlPlaneUrl: string;
  accessToken: string;
  teamId: string;
  channelId: string;
}

/** Spec 043 FR-002: enables SWE-bench runs in a bound channel, with its per-run cost ceiling. */
export async function enableEvalChannel(input: EvalChannelInput & { maxCostUsd?: number }, fetchImplementation: typeof fetch = fetch): Promise<unknown> {
  const body = SwebenchChannelRequestSchema.parse(input.maxCostUsd === undefined ? {} : { maxCostUsd: input.maxCostUsd });
  return sendEvalChannelRequest(input, "PUT", fetchImplementation, JSON.stringify(body));
}

export async function showEvalChannel(input: EvalChannelInput, fetchImplementation: typeof fetch = fetch): Promise<unknown> {
  return sendEvalChannelRequest(input, "GET", fetchImplementation);
}

export async function disableEvalChannel(input: EvalChannelInput, fetchImplementation: typeof fetch = fetch): Promise<unknown> {
  return sendEvalChannelRequest(input, "DELETE", fetchImplementation);
}

/** A --max-cost-usd value: a number, bounded by the contract when the request is built. */
export function parseMaxCostUsd(value: string): number {
  const parsed = Number(value);
  if (value.trim() === "" || !Number.isFinite(parsed)) throw agentXError("CONFIG_INVALID", "--max-cost-usd must be a number of US dollars, from 1 to 100");
  return parsed;
}

async function sendEvalChannelRequest(input: EvalChannelInput, method: "PUT" | "GET" | "DELETE", fetchImplementation: typeof fetch, body?: string): Promise<unknown> {
  const teamId = SlackTeamIdSchema.parse(input.teamId);
  const channelId = SlackChannelIdSchema.parse(input.channelId);
  const response = await fetchImplementation(`${input.controlPlaneUrl.replace(/\/$/, "")}/v1/admin/evals/channels/${teamId}/${channelId}`, {
    method,
    headers: {
      authorization: `Bearer ${input.accessToken}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body }),
  });
  const { ok, status, body: parsed } = await readJsonResponse(response);
  if (!ok) {
    const message = parsed === undefined ? `HTTP ${status}` : (serverError(parsed).message ?? `HTTP ${status}`);
    const action = method === "PUT" ? "enabling" : method === "DELETE" ? "disabling" : "reading";
    throw agentXError(status === 404 ? "NOT_FOUND" : "RUNTIME_UNAVAILABLE", `${action} SWE-bench runs failed: ${message}`);
  }
  if (parsed === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "control plane returned an invalid response");
  return parsed;
}
