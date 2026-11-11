// The setup agent's stored rows. They keep Cloud's key layout (`SETUP_DRAFT#<project>` partition of the company), so a Cloud install can read what a laptop wrote and the other way round:
//   AGENT                       the project's pointer to its current run
//   JOURNAL#<task>#<nnnn>       one row per command a run ran
//   CMD#<task>#<nnn>, CMDCOUNT#<task>, CMDREQ#<task>#<request>   a person's commands for a run
//   SETUP_HOST_ASK#<host> (in the project's own partition)       a website the run could not reach
import { INDEX_EXPIRY_ATTRIBUTE, projectPk, setupDraftKey, type DocumentKey, type OrgId } from "@agentx/contracts";

/** Rows of a run are kept this long, like the other setup rows. */
export const SETUP_KEEP_SECONDS = 31 * 86_400;

export interface RunScope { orgId: OrgId; project: string; taskId: string }

/** The partition of a project's setup rows. */
export const setupPartition = (orgId: OrgId, project: string): string => setupDraftKey(orgId, project).pk;
export const setupAgentKey = (orgId: OrgId, project: string): DocumentKey => ({ pk: setupPartition(orgId, project), sk: "AGENT" });
export const journalKey = (scope: RunScope, n: number): DocumentKey => ({ pk: setupPartition(scope.orgId, scope.project), sk: `JOURNAL#${scope.taskId}#${String(n).padStart(4, "0")}` });
export const hostAskKey = (orgId: OrgId, project: string, host: string): DocumentKey => ({ pk: projectPk(orgId, project), sk: `SETUP_HOST_ASK#${host}` });
export const HOST_ASK_SK_PREFIX = "SETUP_HOST_ASK#";
export const hostRefusedCountKey = (orgId: OrgId, project: string, taskId: string, kind: string): DocumentKey => ({ pk: projectPk(orgId, project), sk: `SETUP_HOST_REFUSED#${taskId}#${kind}` });

export const expiryOf = (nowMs: number): { [INDEX_EXPIRY_ATTRIBUTE]: number } => ({ [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(nowMs / 1000) + SETUP_KEEP_SECONDS });
