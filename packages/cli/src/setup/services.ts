// Every AWS and vendor interface the setup modules (phase 15d2) use, injected so tests replace
// them all. init builds one SetupServices per run; the day-2 commands build one per command.
import { AdminAddUserToGroupCommand, AdminCreateUserCommand, AdminGetUserCommand } from "@aws-sdk/client-cognito-identity-provider";
import type { LoginOptions } from "../auth.js";
import type { StoredTokens, TokenStore } from "../token-store.js";

export interface AdminSession { controlPlaneUrl: string; accessToken: string }

export interface CognitoAdmin {
  /** The user's status (for example FORCE_CHANGE_PASSWORD, CONFIRMED), or undefined when absent. */
  userStatus(poolId: string, username: string): Promise<string | undefined>;
  /** AdminCreateUser with email and email_verified; Cognito emails a temporary password. */
  createUser(poolId: string, email: string): Promise<void>;
  addToGroup(poolId: string, username: string, group: string): Promise<void>;
}

export interface SetupServices {
  tokenStore: TokenStore;
  cognito: CognitoAdmin;
  login: (options: LoginOptions) => Promise<StoredTokens>;
  fetch: typeof fetch;
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
    async addToGroup(poolId, username, group) {
      await client.send(new AdminAddUserToGroupCommand({ UserPoolId: poolId, Username: username, GroupName: group }));
    },
  };
}
