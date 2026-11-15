import { IMPLICIT_COMPANY_ID, OrgIdSchema, projectPk, type OrgId } from "@agentx/contracts";

/**
 * The E2E account registry and the AI navigation day budget were first stored under the unscoped partition `PROJECT#<name>`, and now sit under the company's project
 * partition (`projectPk`). Rows written before the move are still read, for Code's one implicit company and for no other: a second company's same-named project never
 * sees them, and nothing new is ever written under the old key. (An open budget reservation under the old key is settled where it is.)
 */
export const LEGACY_KEY_SCOPE = "legacy-unscoped" as const;
/** A company id, or the old unscoped partition (`LEGACY_KEY_SCOPE`). Both are strings, so the old scope is only ever passed by name. */
export type KeyScope = string;

const IMPLICIT_COMPANY = OrgIdSchema.parse(IMPLICIT_COMPANY_ID);

/** The partition of a project's rows: the company's, or (for rows written before the move) the unscoped one. */
export const scopedProjectPk = (scope: KeyScope, project: string): string => (scope === LEGACY_KEY_SCOPE ? `PROJECT#${project}` : projectPk(scope, project));

/** The old scope to fall back to for this company's reads: only the implicit company has rows there. */
export const legacyScopeOf = (orgId: OrgId): typeof LEGACY_KEY_SCOPE | undefined => (orgId === IMPLICIT_COMPANY ? LEGACY_KEY_SCOPE : undefined);
