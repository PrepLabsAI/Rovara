// Spec 063 FR-001: the CLI side of sign-in clients. Registering and removing are admin changes (runCliChange); a
// confidential client's secret is made here and only its SHA-256 goes to Rovara, so no record or log ever holds it.
import { createHash, randomBytes } from "node:crypto";
import {
  SignInClientIdSchema, SignInClientRegistrationSchema, SignInClientViewSchema, agentXError,
  type SignInClientRegistration, type SignInClientView,
} from "@rovara-code/contracts";
import { adminResponseBody } from "./http.js";

export interface SignInClientAddOptions {
  name?: string;
  audience: string;
  redirect?: string[];
  loopback?: boolean;
  confidential?: boolean;
}

/** A client ID, refused with what a valid one looks like. */
export function signInClientId(value: string): string {
  const parsed = SignInClientIdSchema.safeParse(value);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", "the client ID must be 2–32 lower-case letters, digits or hyphens, starting with a letter, and not agentx-cli");
  return parsed.data;
}

/** A new confidential client secret and the hash Rovara keeps. */
export function newClientSecret(): { secret: string; secretHash: string } {
  const secret = randomBytes(32).toString("base64url");
  return { secret, secretHash: createHash("sha256").update(secret).digest("hex") };
}

/** The registration from the flags, refused with the first problem in words. */
export function signInClientRegistration(clientId: string, options: SignInClientAddOptions, secretHash?: string): SignInClientRegistration {
  const parsed = SignInClientRegistrationSchema.safeParse({
    name: options.name ?? clientId,
    audience: options.audience,
    redirectUris: options.redirect ?? [],
    loopback: options.loopback === true,
    ...(secretHash === undefined ? {} : { secretHash }),
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path[0] === "audience" ? "--audience" : issue?.path[0] === "redirectUris" ? "--redirect" : issue?.path[0] === "name" ? "--name" : "the client";
    throw agentXError("CONFIG_INVALID", `${where}: ${issue?.message ?? "invalid"}`);
  }
  return parsed.data;
}

export async function listSignInClients(session: { controlPlaneUrl: string; accessToken: string }, fetchImplementation: typeof fetch = fetch): Promise<SignInClientView[]> {
  let response: Response;
  try {
    response = await fetchImplementation(`${session.controlPlaneUrl.replace(/\/$/, "")}/v1/admin/sign-in-clients`, { headers: { authorization: `Bearer ${session.accessToken}` } });
  } catch {
    throw agentXError("RUNTIME_UNAVAILABLE", "could not reach AgentX to list sign-in clients; try again");
  }
  const body = await adminResponseBody(response);
  const clients = SignInClientViewSchema.array().safeParse((body as { clients?: unknown } | null)?.clients);
  if (!clients.success) throw agentXError("RUNTIME_UNAVAILABLE", "AgentX answered with sign-in clients this version of the CLI cannot read; upgrade the CLI");
  return clients.data;
}

export const describeSignInClient = (client: SignInClientView) =>
  `${client.clientId}  ${client.name}  audience: ${client.audience}  ${[...client.redirectUris, ...(client.loopback ? ["loopback"] : [])].join(", ")}${client.confidential ? "  confidential" : ""}`;
