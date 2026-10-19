import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Ec2RuntimeBindingSchema, RuntimeInstallChallengeSchema, RuntimeInstallationProposalSchema, WebApiRuntimeInstallProposalSchema, canonicalJson, webApiRuntimeInstallProposalSha256 } from "@agentx/contracts";
import { z } from "zod";
import { adminResponseBody } from "./http.js";

type Auth = Readonly<{ controlPlaneUrl: string; accessToken: string }>;
type Fetcher = typeof fetch;
const RuntimeInstallChallengeResponseEnvelopeSchema = z.object({ requestId: z.string().min(1).max(256) }).passthrough();

async function post(auth: Auth, path: string, body: unknown, fetchImplementation: Fetcher): Promise<unknown> {
  const response = await fetchImplementation(`${auth.controlPlaneUrl.replace(/\/$/, "")}${path}`, {
    method: "POST", headers: { authorization: `Bearer ${auth.accessToken}`, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return adminResponseBody(response);
}

/** Requests a short-lived one-use challenge through the current administrator session. */
export async function requestRuntimeInstallChallenge(input: Auth & {
  bindingFile: string; endpoint: string; generation: number; transportCorrelationId: string;
  profileId: "linux-arm64-docker-v1" | "darwin-arm64-colima-v1" | "linux-arm64-web-api-v1"; outputFile: string;
}, fetchImplementation: Fetcher = fetch): Promise<{ challengeId: string; outputFile: string; expiresAt: string }> {
  const bindingInput: unknown = JSON.parse(await readFile(resolve(input.bindingFile), "utf8"));
  const binding = Ec2RuntimeBindingSchema.parse(bindingInput);
  const value = await post(input, "/v1/admin/runtime-installation/challenges", {
    binding, endpoint: input.endpoint, generation: input.generation,
    transportCorrelationId: input.transportCorrelationId, profileId: input.profileId,
  }, fetchImplementation);
  const envelope = RuntimeInstallChallengeResponseEnvelopeSchema.parse(value);
  const challengePayload = Object.fromEntries(Object.entries(envelope).filter(([key]) => key !== "requestId"));
  const challenge = RuntimeInstallChallengeSchema.parse(challengePayload);
  const destination = resolve(input.outputFile);
  await writeFile(destination, `${canonicalJson(challenge)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return { challengeId: challenge.challengeId, outputFile: destination, expiresAt: challenge.expiresAt };
}

/**
 * Submits the exact strict proposal through the current administrator session: a standard P0 proposal, or a web/API one (its own schema and digest,
 * with the retained evidence the registrar re-derives every observation from). Anything that is neither never leaves this machine.
 */
export async function submitRuntimeInstallProposal(input: Auth & { proposalFile: string }, fetchImplementation: Fetcher = fetch): Promise<unknown> {
  const proposal: unknown = JSON.parse(await readFile(resolve(input.proposalFile), "utf8"));
  if ((proposal as { schemaVersion?: unknown } | null)?.schemaVersion === "runtime-installation-proposal/v2") {
    const webApi = WebApiRuntimeInstallProposalSchema.parse(proposal);
    return post(input, "/v1/admin/runtime-installation/registrations", { proposal: webApi, proposalSha256: webApiRuntimeInstallProposalSha256(webApi) }, fetchImplementation);
  }
  const parsed = RuntimeInstallationProposalSchema.parse(proposal);
  const proposalSha256 = createHash("sha256").update(canonicalJson(parsed)).digest("hex");
  return post(input, "/v1/admin/runtime-installation/registrations", { proposal: parsed, proposalSha256 }, fetchImplementation);
}
