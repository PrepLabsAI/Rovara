// Spec 063 (FR-001): services an administrator lets sign Rovara users in. Each gets tokens addressed to it (its own
// audience), which Rovara's own API never accepts, and may ask Rovara what a signed-in person can do.
import { z } from "zod";
import { AGENTX_CLI_CLIENT_ID, DEVELOPER_TOKEN_AUDIENCE } from "./developer.js";
import { publicHttpsUrlProblem } from "./mcp-connector.js";

/** A sign-in client's ID: lower-case, and never the Rovara CLI's own. */
export const SignInClientIdSchema = z.string().regex(/^[a-z][a-z0-9-]{1,31}$/).refine((id) => id !== AGENTX_CLI_CLIENT_ID, "agentx-cli is Rovara's own CLI");

/** The audience its tokens carry: its own, never Rovara's. */
export const SignInClientAudienceSchema = z.string().regex(/^[a-z][a-z0-9.:/-]{1,127}$/).refine((audience) => audience !== DEVELOPER_TOKEN_AUDIENCE, "agentx-developer is Rovara's own audience");

/** An exact HTTPS redirect URL on a public host, with no query or fragment. */
export const SignInRedirectUriSchema = z.string().max(2_048).superRefine((value, context) => {
  const problem = publicHttpsUrlProblem(value, "redirect URL");
  if (problem !== undefined) context.addIssue({ code: "custom", message: problem });
});

/** What an administrator registers. `secretHash` (SHA-256, hex) makes it confidential; the secret itself is never sent. */
export const SignInClientRegistrationSchema = z.object({
  name: z.string().trim().min(1).max(80),
  audience: SignInClientAudienceSchema,
  redirectUris: z.array(SignInRedirectUriSchema).max(10).refine((uris) => new Set(uris).size === uris.length, "redirect URLs must be unique"),
  /** It may sign people in from a terminal, with a loopback redirect, as `agentx login` does. */
  loopback: z.boolean(),
  secretHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict().refine((registration) => registration.loopback || registration.redirectUris.length > 0, "a client needs a redirect URL, a loopback redirect, or both");
export type SignInClientRegistration = z.infer<typeof SignInClientRegistrationSchema>;

export const SignInClientRecordSchema = z.object({
  clientId: SignInClientIdSchema,
  name: z.string().min(1).max(80),
  audience: SignInClientAudienceSchema,
  redirectUris: z.array(z.string().max(2_048)).max(10),
  loopback: z.boolean(),
  secretHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  updatedBy: z.string().min(1).max(512),
}).strict();
export type SignInClientRecord = z.infer<typeof SignInClientRecordSchema>;

/** A client as anyone but the sign-in server sees it: never its secret's hash. */
export const SignInClientViewSchema = SignInClientRecordSchema.omit({ secretHash: true }).extend({ confidential: z.boolean() }).strict();
export type SignInClientView = z.infer<typeof SignInClientViewSchema>;

export function signInClientView(record: SignInClientRecord): SignInClientView {
  const { secretHash, ...rest } = record;
  return { ...rest, confidential: secretHash !== undefined };
}

/** Where the sign-in table keeps the registry: one partition, one row per client. */
export const SIGN_IN_CLIENTS_PK = "SIGNIN_CLIENTS";
export const signInClientKey = (clientId: string) => ({ pk: SIGN_IN_CLIENTS_PK, sk: `CLIENT#${SignInClientIdSchema.parse(clientId)}` });

// ---- FR-004: the access check, POST /v1/dev/access ----

/** With a confidential client's secret (HTTP Basic), the developer to ask about; with a person's token, nothing. */
export const AccessCheckRequestSchema = z.object({ developerId: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
export type AccessCheckRequest = z.infer<typeof AccessCheckRequestSchema>;

/** Who the person is and what they can use now. `notices` names a check that could not run (`slack_unavailable`). */
export const AccessCheckResponseSchema = z.object({
  developerId: z.string().regex(/^[a-f0-9]{64}$/),
  displayName: z.string(),
  administrator: z.boolean(),
  projects: z.array(z.object({ name: z.string().min(1), access: z.enum(["granted", "channel"]) }).strict()),
  notices: z.array(z.string()),
}).strict();
export type AccessCheckResponse = z.infer<typeof AccessCheckResponseSchema>;

// ---- The broker's requests to the sign-in Lambda, which owns the registry ----

export const PutSignInClientRequestSchema = z.object({ kind: z.literal("put-sign-in-client"), client: SignInClientRecordSchema }).strict();
export type PutSignInClientRequest = z.infer<typeof PutSignInClientRequestSchema>;
export const RemoveSignInClientRequestSchema = z.object({ kind: z.literal("remove-sign-in-client"), clientId: SignInClientIdSchema }).strict();
export type RemoveSignInClientRequest = z.infer<typeof RemoveSignInClientRequestSchema>;
export const ListSignInClientsRequestSchema = z.object({ kind: z.literal("list-sign-in-clients") }).strict();
export type ListSignInClientsRequest = z.infer<typeof ListSignInClientsRequestSchema>;

export type SignInClientsResponse =
  | { ok: true; clients?: SignInClientView[]; removed?: boolean }
  | { ok: false; error: "invalid_request" | "unavailable" };
