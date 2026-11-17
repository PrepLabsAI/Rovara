import { z } from "zod";
import { SlackUserIdSchema } from "./browser-ids.js";
import { BUILT_IN_SIGN_IN_METHODS } from "./outside-account.js";

/**
 * Web task channel C1 (plan 4.1, decisions D1, D2, D4): how a task person proves who they are, fixed when they are registered.
 * `slack`: a Slack sign-in, or an OIDC or GitHub sign-in linked to a Slack account; proved fresh through Slack, exactly as before.
 * `web`: any other built-in sign-in (cloud, saml, or oidc or github with no Slack link). It carries no Slack account id.
 */
export const TaskPersonIdentityKindSchema = z.enum(["slack", "web"]);
export type TaskPersonIdentityKind = z.infer<typeof TaskPersonIdentityKindSchema>;

/** D4 (no account linking): the words that tell two identities of one name apart, by sign-in method. */
export const TASK_PERSON_METHOD_LABELS = {
  slack: "Slack", oidc: "OIDC", github: "GitHub", cloud: "Cloud", saml: "SAML",
} as const satisfies Record<(typeof BUILT_IN_SIGN_IN_METHODS)[number], string>;

const CHAT_ACCOUNT_FIELD = "slackUserId";
const isBuiltInMethod = (value: unknown): value is (typeof BUILT_IN_SIGN_IN_METHODS)[number] =>
  typeof value === "string" && (BUILT_IN_SIGN_IN_METHODS as readonly string[]).includes(value);

/**
 * The kind of a stored task person identity (a PERSON row, or an identity built from one), or undefined when it is malformed.
 * The chat account field is read by key presence, never guessed: present means `slack` and it must be a valid Slack user id
 * on a `slack`, `oidc` or `github` method (DEC 254n 2: a GitHub sign-in linked to Slack is checked like an OIDC one); absent means `web` and the method must not be `slack`. Anything else is undefined, which
 * every caller treats as a fixed refusal, never as the other kind.
 */
export function taskPersonIdentityKind(fields: Readonly<Record<string, unknown>>): TaskPersonIdentityKind | undefined {
  const method = fields["method"];
  if (!isBuiltInMethod(method)) return undefined;
  if (!Object.hasOwn(fields, CHAT_ACCOUNT_FIELD)) return method === "slack" ? undefined : "web";
  if (!SlackUserIdSchema.safeParse(fields[CHAT_ACCOUNT_FIELD]).success) return undefined;
  return method === "slack" || method === "oidc" || method === "github" ? "slack" : undefined;
}

/**
 * The kind of one PEOPLE list entry, or undefined when it is malformed. An entry written before C1 has a chat account id and
 * no method, and is `slack` exactly as before. A `web` entry has a method and no chat account id. An entry with both, or
 * with neither, is undefined.
 */
export function taskPeopleEntryKind(entry: Readonly<Record<string, unknown>>): TaskPersonIdentityKind | undefined {
  const hasAccount = Object.hasOwn(entry, CHAT_ACCOUNT_FIELD);
  const hasMethod = Object.hasOwn(entry, "method");
  if (hasAccount && !hasMethod) return SlackUserIdSchema.safeParse(entry[CHAT_ACCOUNT_FIELD]).success ? "slack" : undefined;
  if (!hasAccount && hasMethod) return taskPersonIdentityKind(entry) === "web" ? "web" : undefined;
  return undefined;
}

export const TaskPeopleRoleSchema = z.enum(["owner", "commenter", "viewer", "denied"]);
export type TaskPeopleRole = z.infer<typeof TaskPeopleRoleSchema>;

export const TaskPeopleViewSchema = z.object({
  revision: z.number().int().positive(),
  orphaned: z.boolean(),
  people: z.array(z.object({
    personId: z.string().uuid(),
    name: z.string().min(1).max(80),
    role: TaskPeopleRoleSchema,
    you: z.boolean(),
    effectiveRole: z.enum(["owner", "commenter", "viewer"]).nullable(),
  }).strict()).max(100),
  canManage: z.boolean(),
  canTakeOwnership: z.boolean(),
  addPeopleUrl: z.string().url().optional(),
}).strict();
export type TaskPeopleView = z.infer<typeof TaskPeopleViewSchema>;

export const TaskPeopleRoleRequestSchema = z.object({
  requestId: z.string().uuid(),
  expectedPeopleRevision: z.number().int().positive(),
  personId: z.string().uuid(),
  role: TaskPeopleRoleSchema,
}).strict();
export type TaskPeopleRoleRequest = z.infer<typeof TaskPeopleRoleRequestSchema>;

export const TaskPeopleTakeOwnershipRequestSchema = z.object({
  requestId: z.string().uuid(),
  expectedPeopleRevision: z.number().int().positive(),
}).strict();
export type TaskPeopleTakeOwnershipRequest = z.infer<typeof TaskPeopleTakeOwnershipRequestSchema>;

export const TaskPeopleChangeResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("PENDING"), requestId: z.string().uuid(), confirmationUrl: z.string().url(), expiresAt: z.string().datetime() }).strict(),
  z.object({ status: z.literal("COMMITTED"), view: TaskPeopleViewSchema }).strict(),
]);
export type TaskPeopleChangeResult = z.infer<typeof TaskPeopleChangeResultSchema>;

/** Strict REST transport envelope. The outer requestId is HTTP trace metadata, never proposal identity. */
export const TaskPeopleViewResponseSchema = z.object({
  view: TaskPeopleViewSchema,
  requestId: z.string(),
}).strict();
export type TaskPeopleViewResponse = z.infer<typeof TaskPeopleViewResponseSchema>;

/** Strict REST transport envelope that preserves the change's own proposal requestId. */
export const TaskPeopleChangeResponseSchema = z.object({
  change: TaskPeopleChangeResultSchema,
  requestId: z.string(),
}).strict();
export type TaskPeopleChangeResponse = z.infer<typeof TaskPeopleChangeResponseSchema>;

export const TaskPeopleProposalSchema = z.object({
  requestId: z.string().uuid(),
  taskId: z.string().uuid(),
  expectedPeopleRevision: z.number().int().positive(),
  personId: z.string().uuid().optional(),
  role: TaskPeopleRoleSchema.optional(),
  kind: z.enum(["role", "takeOwnership"]),
  expiresAt: z.string().datetime(),
}).strict().superRefine((value, context) => {
  if (value.kind === "role" && (value.personId === undefined || value.role === undefined)) context.addIssue({ code: "custom", message: "role proposals require a person and role" });
  if (value.kind === "takeOwnership" && (value.personId !== undefined || value.role !== undefined)) context.addIssue({ code: "custom", message: "take-ownership proposals cannot name a person or role" });
});
export type TaskPeopleProposal = z.infer<typeof TaskPeopleProposalSchema>;

/** Web task channel C4 (plan 4.2 "Add a person from the web"; decision D3): at most this many people are offered, and each is re-checked live. */
export const TASK_PEOPLE_CANDIDATES_MAX = 200;
const TaskPersonDeveloperIdSchema = z.string().regex(/^[a-f0-9]{64}$/);

/** One person a task owner may add from the web: a live member of the task's company with a developer or administrator grant on its project. Name and opaque id only. */
export const TaskPeopleCandidateSchema = z.object({
  developerId: TaskPersonDeveloperIdSchema,
  name: z.string().min(1).max(80),
}).strict();
export type TaskPeopleCandidate = z.infer<typeof TaskPeopleCandidateSchema>;

/** `GET /v1/dev/tasks/{taskId}/people/candidates`: owner only. `complete` is false when the project has more people than were checked. */
export const TaskPeopleCandidatesSchema = z.object({
  candidates: z.array(TaskPeopleCandidateSchema).max(TASK_PEOPLE_CANDIDATES_MAX),
  complete: z.boolean(),
}).strict();
export type TaskPeopleCandidates = z.infer<typeof TaskPeopleCandidatesSchema>;

/** Strict REST transport envelope for the candidates read. */
export const TaskPeopleCandidatesResponseSchema = z.object({
  candidates: TaskPeopleCandidatesSchema,
  requestId: z.string(),
}).strict();
export type TaskPeopleCandidatesResponse = z.infer<typeof TaskPeopleCandidatesResponseSchema>;

/** `POST /v1/dev/tasks/{taskId}/people/add`: registers a web candidate on the task, then proposes the role (the existing confirm step commits it). Remove = role `denied` through people/role. */
export const TaskPeopleAddRequestSchema = z.object({
  requestId: z.string().uuid(),
  expectedPeopleRevision: z.number().int().positive(),
  developerId: TaskPersonDeveloperIdSchema,
  role: z.enum(["owner", "commenter", "viewer"]),
}).strict();
export type TaskPeopleAddRequest = z.infer<typeof TaskPeopleAddRequestSchema>;
