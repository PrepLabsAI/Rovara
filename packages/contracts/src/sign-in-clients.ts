// Spec 063 (FR-001): services an administrator lets sign Rovara users in. Each gets tokens addressed to it (its own
// audience), which Rovara's own API never accepts unless the client has full access (spec 066), and may ask Rovara what
// a signed-in person can do.
import { z } from "zod";
import { OrgIdSchema, OrgRoleSchema } from "./company-scope.js";
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
   * DEC 236h: this client is the Rovara web app, the one surface where a security review finding may be accepted. Written only by the operator or the install that seeds Cloud's web
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
  /**
   * DEC 253z/254: the person's company and company role, read from LIVE membership on this call (never a token claim or anything the caller sent), and the
   * company's name when it has a stored profile. All absent on a Code with no company records. `companyRole` is the company role (owner, admin, member),
   * not `administrator` (install administrator).
   */
  companyId: OrgIdSchema.optional(),
  companyRole: OrgRoleSchema.optional(),
  companyName: z.string().min(1).max(80).optional(),
  /**
   * DEC 254b (f): true only when THIS session's own sign-in joined the company by consuming a live pre-approval (an invite) for the session's company.
   * Recorded by Code's sign-in server on the session when it was minted; never from a claim, a request or an access rule. Absent otherwise (already a
   * member, a legacy join, a session with no company, a check by developer id, a Code with no company layer). Sent only with the company.
   * It describes the whole session (every check on it, also after refreshes), not "just joined". Absent does NOT mean "not the invited person": a
   * sign-in that spent the invite but then failed (an expired code) leaves the person a member, and later sign-ins never carry it.
   */
  joinedByInvite: z.boolean().optional(),
  /**
   * L4-SIGNIN: the Slack workspace id the person's own Slack sign-in came from, read from their stored profile and sent only on a check with the person's own
   * token of a Slack session. The web app remembers it in the browser and passes it back as Slack's `team` hint so the next sign-in opens on that workspace. A
   * workspace id is not a secret and not personal data, and nothing trusts it on the way back: Code reads the workspace from Slack's verified ID token.
   */
  slackTeamId: z.string().regex(/^T[A-Z0-9]{6,15}$/u).optional(),
}).strict().refine((answer) => (answer.companyId === undefined) === (answer.companyRole === undefined) && (answer.companyName === undefined || answer.companyId !== undefined)
  && (answer.joinedByInvite === undefined || answer.companyId !== undefined), "a company comes with its role, and a name or an invite join only with a company");
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

/**
 * Guided onboarding PR 6: the most repositories one create names (a project holds at most 32, `project-node.ts`), and the most a bulk create names.
 * A body over the cap is refused whole.
 */
export const CLIENT_PROJECT_REPOSITORIES_MAX = 32;
const ClientRepositoryNameSchema = CreateClientProjectRequestSchema.shape.repository;
const uniqueRepositories = z.array(ClientRepositoryNameSchema).min(1).max(CLIENT_PROJECT_REPOSITORIES_MAX)
  .refine((list) => new Set(list.map((name) => name.toLowerCase().replace(/\.git$/, ""))).size === list.length, "repositories must be different");
/**
 * Guided onboarding PR 6: `POST /v1/dev/client/projects` with `repositories` (instead of `repository`): ONE project holding every named repository
 * (1 to 32, each `owner/name` as the single form checks, no repeats ignoring case). Every repository must be on a GitHub App installation bound to the
 * caller's company; one that is not refuses the whole create, and nothing is written. The commands run in the first repository.
 */
export const CreateClientProjectsRequestSchema = z.object({
  repositories: uniqueRepositories,
  name: CreateClientProjectRequestSchema.shape.name,
  setupCommands: CreateClientProjectRequestSchema.shape.setupCommands,
  testCommands: CreateClientProjectRequestSchema.shape.testCommands,
}).strict();
export type CreateClientProjectsRequest = z.infer<typeof CreateClientProjectsRequestSchema>;

/** Guided onboarding PR 6: `POST /v1/dev/client/projects/bulk` (projects:create): one project per repository, each named after its repository. */
export const BulkCreateClientProjectsRequestSchema = z.object({ repositories: uniqueRepositories }).strict();
export type BulkCreateClientProjectsRequest = z.infer<typeof BulkCreateClientProjectsRequestSchema>;
/**
 * Why one repository of a bulk create made no project, in fixed words:
 * - `not_available`: not on a GitHub installation connected to the caller's company (another company's, an unconnected or suspended installation,
 *   or no such repository: the same answer for each);
 * - `name_taken`: a project with the repository's name exists; create it on its own with another name;
 * - `unavailable`: GitHub or Rovara could not be reached for it; send it again;
 * - `not_started`: the call ran out of time before this one; send it again.
 */
export const BULK_PROJECT_REFUSALS = ["not_available", "name_taken", "unavailable", "not_started"] as const;
export type BulkProjectRefusal = typeof BULK_PROJECT_REFUSALS[number];
export interface BulkCreateClientProjectsResponse {
  /** One row per requested repository, in the order asked. */
  results: Array<{ repository: string; outcome: "created"; project: string } | { repository: string; outcome: "refused"; reason: BulkProjectRefusal }>;
}

/** Guided onboarding PR 6: the most repositories one page of `GET /v1/dev/client/repositories/available` shows, and its default. */
export const REPOSITORY_CHOICES_PAGE_MAX = 100;
export const REPOSITORY_CHOICES_PAGE_DEFAULT = 50;
/**
 * Guided onboarding PR 6: `GET /v1/dev/client/repositories/available?q=&limit=&after=` (projects:create): the repositories the caller's company's
 * connected (bound, not suspended) GitHub installations reach, sorted by `fullName`, each with the caller's company's projects that already hold it
 * (another company's projects are never named). `q` filters by a case-insensitive part of `fullName`; `after` is the previous page's `next`.
 * `incomplete` is true when an installation reaches more repositories than GitHub listed (the first 100 of each are read).
 */
export interface ClientRepositoryChoicesResponse {
  repositories: Array<{ installationId: number; accountLogin: string; fullName: string; githubRepositoryId: number; private: boolean; defaultBranch: string; projects: string[] }>;
  next?: string;
  incomplete: boolean;
}
export const RepositoryChoicesQuerySchema = z.object({
  q: z.string().max(100).regex(/^[A-Za-z0-9_./-]*$/).optional(),
  limit: z.coerce.number().int().min(1).max(REPOSITORY_CHOICES_PAGE_MAX).optional(),
  after: z.string().min(3).max(201).regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/).optional(),
}).strict();

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
