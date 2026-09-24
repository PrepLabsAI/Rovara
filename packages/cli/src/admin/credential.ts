import {
  AgentXErrorCodeSchema,
  CredentialRegistrationSchema,
  agentXError,
} from "@agentx/contracts";
import { readJsonResponse, serverError } from "./http.js";

interface CredentialAdminInput {
  controlPlaneUrl: string;
  accessToken: string;
}

interface RegisterCredentialInput extends CredentialAdminInput {
  ref: string;
  type: string;
  secretName: string;
}

export async function registerCredential(
  input: RegisterCredentialInput,
  fetchImplementation: typeof fetch = fetch,
): Promise<unknown> {
  const parsed = CredentialRegistrationSchema.safeParse({
    ref: input.ref,
    type: input.type,
    secretName: input.secretName,
  });
  if (!parsed.success) {
    throw agentXError("CONFIG_INVALID", `invalid credential registration: ${parsed.error.issues[0]?.message}`);
  }
  const response = await fetchImplementation(credentialsUrl(input.controlPlaneUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(parsed.data),
  });
  return parseCredentialResponse(response);
}

export async function listCredentials(
  input: CredentialAdminInput,
  fetchImplementation: typeof fetch = fetch,
): Promise<unknown> {
  const response = await fetchImplementation(credentialsUrl(input.controlPlaneUrl), {
    method: "GET",
    headers: {
      authorization: `Bearer ${input.accessToken}`,
    },
  });
  return parseCredentialResponse(response);
}

function credentialsUrl(controlPlaneUrl: string): string {
  return `${controlPlaneUrl.replace(/\/$/, "")}/v1/admin/credentials`;
}

async function parseCredentialResponse(response: Response): Promise<unknown> {
  const { ok, status, body } = await readJsonResponse(response);
  if (!ok) {
    if (body === undefined) throw agentXError("RUNTIME_UNAVAILABLE", `HTTP ${status}`);
    const { code, message } = serverError(body);
    const parsedCode = AgentXErrorCodeSchema.safeParse(code);
    // An unlabeled body is classified by its status, as the project registration client does:
    // 5xx is the control plane's own fault, not a problem with what the administrator sent.
    const fallback = status >= 500 ? "RUNTIME_UNAVAILABLE" : "CONFIG_INVALID";
    throw agentXError(parsedCode.success ? parsedCode.data : fallback, message ?? `HTTP ${status}`);
  }
  if (body === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "control plane returned an invalid response");
  return body;
}
