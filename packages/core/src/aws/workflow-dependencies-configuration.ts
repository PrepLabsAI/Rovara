import type { DeveloperApiConfiguration } from "./developer-routes.js";
import { developerSinceFromEnvironment } from "./developer-routes.js";

export function workflowDependenciesConfigurationFromEnvironment(environment: Record<string, string | undefined>): {
  workflowDependenciesEnabled: boolean;
} {
  return { workflowDependenciesEnabled: environment.AGENTX_WORKFLOW_DEPENDENCIES_ENABLED === "true" };
}

type DeveloperApiIntegrations = Omit<DeveloperApiConfiguration,
  "issuer" | "env" | "methods" | "slackTeamId" | "since" | "signInTableName" |
  "taskPeopleConfiguration" | "workflowDependenciesEnabled" | "inviteTaskPerson">;

/** The deployed developer configuration factory; transports remain injected and this seam is directly contract-tested. */
export function createDeveloperApiConfiguration(
  environment: Record<string, string | undefined>,
  integrations: (issuer: string, identityFunctionName: string) => DeveloperApiIntegrations,
  inviteTaskPerson?: DeveloperApiConfiguration["inviteTaskPerson"],
): DeveloperApiConfiguration | undefined {
  const issuer = environment.DEVELOPER_TOKEN_ISSUER;
  if (!issuer) return undefined;
  const identityFunctionName = environment.DEVELOPER_IDENTITY_FUNCTION_ARN;
  if (!identityFunctionName) throw new Error("DEVELOPER_IDENTITY_FUNCTION_ARN is required");
  const signInTableName = environment.DEVELOPER_SIGNIN_TABLE_NAME;
  if (!signInTableName) throw new Error("DEVELOPER_SIGNIN_TABLE_NAME is required");
  const env = environment.AGENTX_ENV;
  if (!env) throw new Error("AGENTX_ENV is required");
  const slackTeamId = environment.SLACK_TEAM_ID ?? "";
  return {
    ...integrations(issuer, identityFunctionName),
    issuer,
    env,
    methods: { slack: environment.DEVELOPER_SIGNIN_SLACK === "enabled", oidc: (environment.DEVELOPER_OIDC_ISSUER ?? "") !== "" },
    ...(slackTeamId === "" ? {} : { slackTeamId }),
    since: developerSinceFromEnvironment(environment),
    signInTableName,
    ...workflowDependenciesConfigurationFromEnvironment(environment),
    taskPeopleConfiguration: { peopleChangesEnabled: environment.AGENTX_TASK_PEOPLE_CHANGES_ENABLED === "true" },
    ...(inviteTaskPerson === undefined ? {} : { inviteTaskPerson }),
  };
}
