// R5 step 1 (DEC 254zzz444): the role the hosted Slack service (the AI-turn orchestrator) assumes, tagged with ONE company, to read that company's Slack bot token and nothing else.
// The names live here so that the ControlPlane stack (which creates the role), the Slack stack (which hands the container its ARN, with no new stack parameter), the permissions boundary
// (which must allow the assume) and the tests all build the same ARN from the environment alone. Like the saved environment image roles the name is FIXED: CloudFormation looks a fixed-name role
// up by its path-less ARN before it creates it, so the deploy role's lookup statement needs the same name.
import { environmentRolePath, type PolicyStatementJson } from "./access-policies.js";

const ENV_NAME = /^[a-z][a-z0-9-]{0,19}$/u;

/** Short on purpose: the boundary and the deploy role's lookup statement both spell it out (a boundary has a hard size limit; the statement below also carries NO Sid for the same reason, IAM does not require one). */
export function slackTokenReaderRoleName(env: string): string {
  if (!ENV_NAME.test(env)) throw new Error("not an environment name");
  return `agentx-${env}-slk`;
}

export interface SlackTokenReaderScope {
  env: string;
  partition: string;
  account: string;
  /** A named environment's roles sit under `/agentx/<env>/` (EnvironmentRolePath); the legacy deployment (production) has no role path. */
  named: boolean;
}

/** The role's real ARN: under the environment's path for a named environment, at the root for the legacy deployment. */
export function slackTokenReaderRoleArn(scope: SlackTokenReaderScope): string {
  return `arn:${scope.partition}:iam::${scope.account}:role${scope.named ? environmentRolePath(scope.env) : "/"}${slackTokenReaderRoleName(scope.env)}`;
}

/** The variable that gives the Slack container the role's ARN (empty or absent: the service reads through its own role, as before). */
export const SLACK_COMPANY_TOKEN_ROLE_VARIABLE = "SLACK_COMPANY_TOKEN_ROLE_ARN";
/**
 * Release 1 only: `shared` lets the service fall back to its own role's family-wide read when the scoped session cannot be made or read (a boundary or trust not deployed yet).
 * Release 2 removes the variable (and the orchestrator's family-wide read), after which a failed scoped read refuses.
 */
export const SLACK_COMPANY_TOKEN_FALLBACK_VARIABLE = "SLACK_COMPANY_TOKEN_FALLBACK";

/**
 * NOT WIRED (owner's boundary is designed with the ACCESS-DENIES lane): the one statement the default permission boundary needs so the orchestrator's role may assume the reader role. The role's own trust names
 * the orchestrator and the one session tag, so the boundary needs no principal or tag condition (the ceiling only says what a bounded role may do; the trust says who). Add it next to `AssumeSessionRoles`.
 */
export function slackTokenReaderBoundaryStatement(scope: SlackTokenReaderScope): Omit<PolicyStatementJson, "Sid"> {
  return { Effect: "Allow", Action: ["sts:AssumeRole", "sts:TagSession"], Resource: slackTokenReaderRoleArn(scope) };
}

/** NOT WIRED: the path-less ARN to add to `IamFixedNameRolesNotYetCreated`'s Resource list (the deploy role's and the boundary's lookup of a fixed-name role before it exists). */
export function slackTokenReaderLookupResource(scope: Omit<SlackTokenReaderScope, "named">): string {
  return `arn:${scope.partition}:iam::${scope.account}:role/${slackTokenReaderRoleName(scope.env)}`;
}
