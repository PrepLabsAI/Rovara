/**
 * The attributes of the two sign-in table rows a task person read projects. One list per row family, shared by the readers (the broker's task person runtime and the dispatcher's lessons
 * people port project exactly these) and by the infrastructure grant that lets the dispatcher read them (infra/lib/dispatcher-lessons-people.ts names exactly these in its IAM condition),
 * so a read and its grant cannot drift apart.
 */

/** A `DEVELOPER#<developerId>` / `META` row. */
export const TASK_PERSON_DEVELOPER_RECORD_ATTRIBUTES = [
  "pk", "sk", "developerId", "provider", "issuer", "subject", "slackUserId", "revoked", "displayName",
] as const;

/** A `COMPANY_MEMBER#<developerId>` / `COMPANY` row: the fields of the reviewed `Membership` record (aws/company-check.ts). */
export const TASK_PERSON_COMPANY_MEMBER_ATTRIBUTES = [
  "pk", "sk", "entityType", "personId", "companyId", "role", "joinedAt", "joinedVia", "revokedAt", "revokedBy",
] as const;
