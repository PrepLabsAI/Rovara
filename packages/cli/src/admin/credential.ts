import {
  AgentXErrorCodeSchema,
  CredentialRegistrationSchema,
  agentXError,
} from "@agentx/contracts";

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
  const result: unknown = await response.json();
  if (!response.ok) {
    const parsedCode = AgentXErrorCodeSchema.safeParse(serverErrorCode(result));
    const code = parsedCode.success ? parsedCode.data : "RUNTIME_UNAVAILABLE";
    const message = serverMessage(result) ?? `HTTP ${response.status}`;
    throw agentXError(code, message);
  }
  return result;
}

function serverErrorCode(value: unknown): unknown {
  if (!value || typeof value !== "object" || !("error" in value)) return undefined;
  const error = value.error;
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return error.code;
}

function serverMessage(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || !("error" in value)) return undefined;
  const error = value.error;
  if (!error || typeof error !== "object" || !("message" in error)) return undefined;
  return typeof error.message === "string" ? error.message : undefined;
}
