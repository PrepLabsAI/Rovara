// Spec 063 (FR-001): services an administrator lets sign Rovara users in. Each gets tokens addressed to it (its own
// audience), which Rovara's own API never accepts unless the client has full access (spec 066), and may ask Rovara what
// a signed-in person can do.
import { z } from "zod";
import { OrgIdSchema } from "./company-scope.js";
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

/**
 * Spec 065: what a sign-in client may do on Rovara as the signed-in person, beyond the access check. An administrator
 * names them when registering the client; the client asks for them at sign-in and its tokens carry the allowed ones.
 * Plan v3.2 lane ID: each /v1/dev/* route needs one of them (the broker's route table, dev-route-scopes.ts), or full
 * access. A scope only narrows what the person may do; it never adds a right.
 */
export const CLIENT_SCOPES = [
  "projects:members", "projects:create",
  "profile:name", "tasks:read", "tasks:start", "tasks:act", "tasks:share", "decisions:decide",
] as const;
export const ClientScopeSchema = z.enum(CLIENT_SCOPES);
export type ClientScope = z.infer<typeof ClientScopeSchema>;
const ClientScopesSchema = z.array(ClientScopeSchema).max(CLIENT_SCOPES.length).refine((scopes) => new Set(scopes).size === scopes.length, "scopes must be unique");

/** The scopes a token's space-separated `scope` claim names, keeping only known ones. */
export function scopesOf(claim: unknown): ClientScope[] {
  if (typeof claim !== "string") return [];
  return claim.split(" ").filter((scope): scope is ClientScope => ClientScopeSchema.safeParse(scope).success);
}

/** What an administrator registers. `secretHash` (SHA-256, hex) makes it confidential; the secret itself is never sent. */
export const SignInClientRegistrationSchema = z.object({
  name: z.string().trim().min(1).max(80),
  audience: SignInClientAudienceSchema,
  redirectUris: z.array(SignInRedirectUriSchema).max(10).refine((uris) => new Set(uris).size === uris.length, "redirect URLs must be unique"),
  /** It may sign people in from a terminal, with a loopback redirect, as `agentx login` does. */
  loopback: z.boolean(),
  secretHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  /** Spec 065: what it may do as the signed-in person; none when absent. */
  scopes: ClientScopesSchema.optional(),
  /**
   * An update that keeps the client's secret: Rovara carries the stored hash over (the CLI never sees it). Never with a
   * new `secretHash`, and refused for a client that has no secret.
   */
  keepSecret: z.literal(true).optional(),
  /**
   * Spec 066: Rovara's developer API accepts its tokens as the signed-in person, with all their rights, as it does the
   * Rovara CLI's. Only for a confidential client, so its tokens are only ever issued to the service itself.
   */
  fullAccess: z.literal(true).optional(),
}).strict()
  .refine((registration) => registration.loopback || registration.redirectUris.length > 0, "a client needs a redirect URL, a loopback redirect, or both")
  .refine((registration) => registration.keepSecret === undefined || registration.secretHash === undefined, "keep the secret or give a new one, not both")
  .refine((registration) => registration.fullAccess === undefined || registration.keepSecret === true || registration.secretHash !== undefined, { message: "only a confidential client can have full access", path: ["fullAccess"] });
export type SignInClientRegistration = z.infer<typeof SignInClientRegistrationSchema>;

const ClientRecord = z.object({
  companyId: OrgIdSchema.optional(),
  installLevel: z.literal(true).optional(),
  clientId: SignInClientIdSchema,
  name: z.string().min(1).max(80),
  audience: SignInClientAudienceSchema,
  redirectUris: z.array(z.string().max(2_048)).max(10),
  loopback: z.boolean(),
  secretHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  scopes: ClientScopesSchema.optional(),
  fullAccess: z.literal(true).optional(),
  /**
   * DEC 236h: this client is the Rovara web app, the one surface where a security review finding may be accepted (with a fresh step-up). Written only by the operator or the install that seeds Cloud's web
   * app client: the registration schema above has no such field, so an administrator's registration, a company's included, can never carry it, and an update by registration drops it. Only with full access.
   */
  webApp: z.literal(true).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  updatedBy: z.string().min(1).max(512),
}).strict();
const oneOwner = (record: { companyId?: string | undefined; installLevel?: true | undefined }) => record.companyId === undefined || record.installLevel === undefined;
export const SignInClientRecordSchema = ClientRecord.refine(oneOwner, "a client has one owner").refine((record) => record.webApp === undefined || record.fullAccess === true, "the web app client has full access");
export type SignInClientRecord = z.infer<typeof SignInClientRecordSchema>;

/** A client as anyone but the sign-in server sees it: never its secret's hash. */
export const SignInClientViewSchema = ClientRecord.omit({ secretHash: true }).extend({ confidential: z.boolean() }).strict().refine(oneOwner, "a client has one owner");
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
  /** #634: true once the person chose their own name (`PUT /v1/dev/me/name`); false while it is the sign-in provider's. */
  nameChosen: z.boolean(),
  administrator: z.boolean(),
  /** `administrator` (spec 065): a project the person administers, which task access alone does not list. */
  projects: z.array(z.object({ name: z.string().min(1), access: z.enum(["granted", "channel", "administrator"]) }).strict()),
  notices: z.array(z.string()),
}).strict();
export type AccessCheckResponse = z.infer<typeof AccessCheckResponseSchema>;

// ---- The broker's requests to the sign-in Lambda, which owns the registry ----

/** `keepSecret`: carry the stored client's secret hash over, which only the sign-in server holds. */
export const PutSignInClientRequestSchema = z.object({ kind: z.literal("put-sign-in-client"), companyId: OrgIdSchema.optional(), client: SignInClientRecordSchema, keepSecret: z.literal(true).optional() }).strict();
export type PutSignInClientRequest = z.infer<typeof PutSignInClientRequestSchema>;
export const RemoveSignInClientRequestSchema = z.object({ kind: z.literal("remove-sign-in-client"), companyId: OrgIdSchema.optional(), clientId: SignInClientIdSchema }).strict();
export type RemoveSignInClientRequest = z.infer<typeof RemoveSignInClientRequestSchema>;
export const ListSignInClientsRequestSchema = z.object({ kind: z.literal("list-sign-in-clients"), companyId: OrgIdSchema.optional() }).strict();
export type ListSignInClientsRequest = z.infer<typeof ListSignInClientsRequestSchema>;

export type SignInClientsResponse =
  | { ok: true; clients?: SignInClientView[]; removed?: boolean }
  | { ok: false; error: "invalid_request" | "unavailable" };

// ---- Spec 065: a sign-in client's routes, /v1/dev/client/*, each acting as the signed-in person ----

/**
 * Spec 065b: `GET /v1/dev/client/repositories` (projects:create): the accounts the deployment's GitHub App is installed
 * on, and the repositories each lets it reach (the first 100 of each), to choose one for a new project.
 */
export interface ClientRepositoriesResponse {
  installations: Array<{
    installationId: number;
    accountLogin: string;
    accountType: "User" | "Organization";
    repositorySelection: "all" | "selected";
    status: "active" | "suspended";
    repositories: Array<{ fullName: string; githubRepositoryId: number; private: boolean; defaultBranch: string }>;
  }>;
}

/**
 * Spec 065b: `POST /v1/dev/client/projects` (projects:create): a project from one GitHub repository the deployment's
 * GitHub App can reach. Rovara builds the rest (the App's credential, the repository's default branch, the worker
 * settings); the commands run in the repository, one argument list each.
 */
export const CreateClientProjectRequestSchema = z.object({
  repository: z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/, "must be owner/name"),
  name: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/).optional(),
  setupCommands: z.array(z.string().trim().min(1).max(1_000)).max(16).optional(),
  testCommands: z.array(z.string().trim().min(1).max(1_000)).max(16).optional(),
}).strict();
export type CreateClientProjectRequest = z.infer<typeof CreateClientProjectRequestSchema>;

/** `GET /v1/dev/client/projects/{project}`: a project the signed-in person may use; needs no scope. */
export interface ClientProjectResponse {
  name: string;
  latestRevision: number;
  access: AccessCheckResponse["projects"][number]["access"];
  /** `fullName` is `owner/name` for a GitHub repository. */
  repositories: Array<{ name: string; url: string; defaultBranch: string; fullName?: string }>;
}

/** `GET /v1/dev/client/projects/{project}/members` (projects:members). */
export interface ClientProjectMembersResponse {
  project: string;
  members: Array<{ developerId: string; name: string; role: "administrator" | "developer"; grantedAt: string | null }>;
}

/** `PUT` or `DELETE /v1/dev/client/projects/{project}/members/{developer}` (projects:members). */
export interface ClientProjectMemberChangeResponse {
  project: string;
  developerId: string;
  /** PUT: granted (or already was); DELETE: revoked, or was not a member. */
  outcome: "granted" | "already_member" | "revoked" | "not_member";
}
