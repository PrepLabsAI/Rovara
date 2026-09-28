// Every AWS and vendor interface the setup modules (phase 15d2) use, injected so tests replace
// them all. init builds one SetupServices per run; the day-2 commands build one per command.
import { AdminAddUserToGroupCommand, AdminCreateUserCommand, AdminGetUserCommand, AdminListGroupsForUserCommand } from "@aws-sdk/client-cognito-identity-provider";
import type { LoginOptions } from "../auth.js";
import type { StackOutputs } from "../deploy/parameters.js";
import type { GitHubApi } from "../init/github-app.js";
import type { StoredTokens, TokenStore } from "../token-store.js";
import type { SlackChannelApi } from "./channel-add.js";
import type { GitHubRepositoryApi } from "./project-files.js";

export interface AdminSession { controlPlaneUrl: string; accessToken: string }

export interface CognitoAdmin {
  /** The user's status (for example FORCE_CHANGE_PASSWORD, CONFIRMED), "UNKNOWN" when Cognito
   * returns none, or undefined when the user does not exist. */
  userStatus(poolId: string, username: string): Promise<string | undefined>;
  /** AdminCreateUser with email and email_verified; Cognito emails a temporary password. */
  createUser(poolId: string, email: string): Promise<void>;
  /** The names of the groups the user is in (the first 60; AgentX makes one). */
  groups(poolId: string, username: string): Promise<string[]>;
  addToGroup(poolId: string, username: string, group: string): Promise<void>;
}

export interface SetupServices {
  tokenStore: TokenStore;
  cognito: CognitoAdmin;
  login: (options: LoginOptions) => Promise<StoredTokens>;
  fetch: typeof fetch;
  /** Task 6: the repositories the GitHub App sees, and their build files. */
  repositories: GitHubRepositoryApi;
  /** Task 6: the installation token (15d1's GitHub API). */
  github: Pick<GitHubApi, "listInstallations" | "installationToken">;
  /** Task 7: a stack's outputs (the foundation's EC2 worker outputs), or undefined when the stack
   * does not exist. */
  stackOutputs: (stackName: string) => Promise<StackOutputs | undefined>;
  /** Task 7: where project files live (the global --config-dir, default ~/.agentx/projects). */
  configDir: string;
  /** Task 8: finding and joining the project's Slack channel with the bot token. */
  slackChannels: SlackChannelApi;
  /** Task 8: the bot token's workspace and bot user (15d1's auth.test). */
  slackIdentity: (botToken: string) => Promise<{ teamId: string; botUserId: string }>;
}

const errorName = (error: unknown) => (error instanceof Error ? error.name : undefined);

export function cognitoAdmin(client: { send(command: unknown): Promise<unknown> }): CognitoAdmin {
  return {
    async userStatus(poolId, username) {
      try {
        return ((await client.send(new AdminGetUserCommand({ UserPoolId: poolId, Username: username }))) as { UserStatus?: string }).UserStatus ?? "UNKNOWN";
      } catch (error) {
        if (errorName(error) === "UserNotFoundException") return undefined;
        throw error;
      }
    },
    async createUser(poolId, email) {
      // No MessageAction and no TemporaryPassword: Cognito makes the temporary password and emails
      // it, so the CLI never sees it.
      await client.send(new AdminCreateUserCommand({
        UserPoolId: poolId, Username: email, DesiredDeliveryMediums: ["EMAIL"],
        UserAttributes: [{ Name: "email", Value: email }, { Name: "email_verified", Value: "true" }],
      }));
    },
    async groups(poolId, username) {
      const answer = (await client.send(new AdminListGroupsForUserCommand({ UserPoolId: poolId, Username: username, Limit: 60 }))) as { Groups?: Array<{ GroupName?: string }> };
      return (answer.Groups ?? []).flatMap((group) => (group.GroupName === undefined ? [] : [group.GroupName]));
    },
    async addToGroup(poolId, username, group) {
      await client.send(new AdminAddUserToGroupCommand({ UserPoolId: poolId, Username: username, GroupName: group }));
    },
  };
}
