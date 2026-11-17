// Web task channel C1 (plan 4.1, 4.2 "Identity and records"; decisions D1, D2, D4): the one reader and writer of a task person's
// stored identity fields (PERSON#<personId> rows) and of PEOPLE list entries, for both identity kinds. A row written before C1
// parses exactly as before and is a `slack` identity. A malformed row is undefined here, which every caller turns into its fixed
// refusal; it is never read as the other kind. No key shape changes: a `web` row is the same row without the chat account id.
import {
  TASK_PERSON_METHOD_LABELS,
  agentXError,
  cleanDisplayName,
  redactAndCap,
  taskPeopleEntryKind,
  taskPersonIdentityKind,
  type DeveloperSignInMethod,
  type TaskPersonIdentityKind,
} from "@agentx/contracts";
import type { TaskPersonIdentity } from "./task-person-identity.js";

export type TaskPeopleEntryRole = "owner" | "commenter" | "viewer" | "denied";

/** One PEOPLE list entry. `slack`: { developerId, slackUserId, name, role } (the pre-C1 shape, unchanged). `web`: { developerId, name, role, method }. */
export interface TaskPeopleEntry {
  developerId: string;
  slackUserId?: string;
  name: string;
  role: TaskPeopleEntryRole;
  method?: DeveloperSignInMethod;
}

/** The name a `web` identity shows when its sign-in gave none that can be shown. A `slack` identity falls back to its Slack user id, as before. */
export const TASK_PERSON_UNNAMED = "Unnamed member";

const HEX64 = /^[a-f0-9]{64}$/;
const SLACK_ENTRY_KEYS = ["developerId", "slackUserId", "name", "role"] as const;
const WEB_ENTRY_KEYS = ["developerId", "name", "role", "method"] as const;
const SLACK_PERSON_ROW_KEYS = ["pk", "sk", "schemaVersion", "personId", "developerId", "slackUserId", "name", "method", "issuer", "subject", "createdAt"] as const;
const WEB_PERSON_ROW_KEYS = ["pk", "sk", "schemaVersion", "personId", "developerId", "name", "method", "issuer", "subject", "createdAt"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

export const safeTaskPersonName = (value: string, fallback: string): string => cleanDisplayName(redactAndCap(value, 80).text) ?? fallback;

/** The kind of an identity this module (or a proof) produced; undefined only for a malformed one. */
export function taskPersonKindOf(identity: TaskPersonIdentity): TaskPersonIdentityKind | undefined {
  return taskPersonIdentityKind(identity as unknown as Record<string, unknown>);
}

/** A `slack` identity, with its Slack user id in the type. */
export function isSlackTaskPerson(identity: TaskPersonIdentity): identity is TaskPersonIdentity & { slackUserId: string } {
  return taskPersonKindOf(identity) === "slack";
}

/** The display-name fallback for an identity of either kind. */
export function taskPersonNameFallback(identity: Pick<TaskPersonIdentity, "slackUserId">): string {
  return identity.slackUserId ?? TASK_PERSON_UNNAMED;
}

/** The exact key set of a PERSON row: the pre-C1 set when it carries a chat account id, the same set without it otherwise. */
export function taskPersonRowKeys(row: Record<string, unknown>): readonly string[] {
  return Object.hasOwn(row, "slackUserId") ? SLACK_PERSON_ROW_KEYS : WEB_PERSON_ROW_KEYS;
}

/** The identity fields of a PERSON row (or any object holding them), or undefined when they are malformed. */
export function parseTaskPersonIdentity(value: Record<string, unknown>): TaskPersonIdentity | undefined {
  const kind = taskPersonIdentityKind(value);
  if (kind === undefined || typeof value.developerId !== "string" || !HEX64.test(value.developerId) || typeof value.name !== "string"
    || typeof value.issuer !== "string" || value.issuer.length === 0 || value.issuer.length > 2048
    || typeof value.subject !== "string" || value.subject.length === 0 || value.subject.length > 512) return undefined;
  const slackUserId = kind === "slack" ? String(value.slackUserId) : undefined;
  if (safeTaskPersonName(value.name, slackUserId ?? TASK_PERSON_UNNAMED) !== value.name) return undefined;
  return {
    developerId: value.developerId,
    ...(slackUserId === undefined ? {} : { slackUserId }),
    name: value.name,
    method: value.method as DeveloperSignInMethod,
    issuer: value.issuer,
    subject: value.subject,
  };
}

/** One PEOPLE entry, returned as the very object stored (so an unchanged list writes back byte-identical), or undefined when malformed. */
export function parseTaskPeopleEntry(value: unknown): TaskPeopleEntry | undefined {
  if (!isRecord(value)) return undefined;
  const kind = taskPeopleEntryKind(value);
  if (kind === undefined || !exactKeys(value, kind === "slack" ? SLACK_ENTRY_KEYS : WEB_ENTRY_KEYS)) return undefined;
  if (typeof value.developerId !== "string" || !HEX64.test(value.developerId) || typeof value.name !== "string"
    || safeTaskPersonName(value.name, kind === "slack" ? String(value.slackUserId) : TASK_PERSON_UNNAMED) !== value.name
    || (value.role !== "owner" && value.role !== "commenter" && value.role !== "viewer" && value.role !== "denied")) return undefined;
  return value as unknown as TaskPeopleEntry;
}

/** The PEOPLE entry for an identity: the pre-C1 four keys for `slack` (byte-identical to before), the `web` four keys otherwise. */
export function taskPeopleEntryOf(identity: TaskPersonIdentity, role: TaskPeopleEntryRole): TaskPeopleEntry {
  const kind = taskPersonKindOf(identity);
  if (kind === undefined) throw agentXError("TASK_ACCESS_DENIED", "task access could not be verified");
  const name = safeTaskPersonName(identity.name, taskPersonNameFallback(identity));
  return kind === "slack"
    ? { developerId: identity.developerId, slackUserId: identity.slackUserId!, name, role }
    : { developerId: identity.developerId, name, role, method: identity.method };
}

/** D4: the label that tells two identities of one person apart, by sign-in method (" (Slack identity)", " (GitHub identity)", ...). */
export function taskPersonIdentitySuffix(method: DeveloperSignInMethod): string {
  return ` (${TASK_PERSON_METHOD_LABELS[method]} identity)`;
}
