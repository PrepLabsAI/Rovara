import {
  CredentialRegistrationSchema,
  agentXError,
} from "@agentx/contracts";
import { adminResponseBody } from "./http.js";

interface CredentialAdminInput {
  controlPlaneUrl: string;
  accessToken: string;
}

interface RegisterCredentialInput extends CredentialAdminInput {
  ref: string;
  type: string;
  secretName: string;
  /** Spec 055: the one MCP host the credential may be sent to. */
  host?: string;
}

export async function registerCredential(
  input: RegisterCredentialInput,
  fetchImplementation: typeof fetch = fetch,
): Promise<unknown> {
  const parsed = CredentialRegistrationSchema.safeParse({
    ref: input.ref,
    type: input.type,
    secretName: input.secretName,
    ...(input.host === undefined ? {} : { host: input.host }),
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
  return adminResponseBody(response);
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
  return adminResponseBody(response);
}

function credentialsUrl(controlPlaneUrl: string): string {
  return `${controlPlaneUrl.replace(/\/$/, "")}/v1/admin/credentials`;
}
