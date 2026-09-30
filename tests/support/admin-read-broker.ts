// Spec 025 phase 25d: the developer task broker (payments registered and bound to the test channel,
// two signed-in developers) with an admin caller for the admin read routes.
import { randomUUID } from "node:crypto";
import { createDeveloperTaskBroker } from "./developer-task-broker.js";
import { issuer } from "./slack-broker.js";

export const ADMIN_SUBJECT = "admin-subject";
/** The built-in GitHub App credential every deployment's broker lists, as the Lambda entry point configures it. */
const GITHUB_APP_CREDENTIAL = { ref: "github-app", secretName: "arn:aws:secretsmanager:us-east-1:111122223333:secret:github-key" };

export async function createAdminReadBroker(options: Parameters<typeof createDeveloperTaskBroker>[0] = {}) {
  // Like the deployed broker, connector credentials are configured, so GET /v1/admin/credentials answers.
  const connectorCredentials = { secrets: { read: async () => undefined }, githubApp: GITHUB_APP_CREDENTIAL };
  const harness = await createDeveloperTaskBroker({ ...options, brokerExtra: { connectorCredentials, ...options.brokerExtra } });
  /** The OIDC entry point as an admin (the `groups` claim holds `admins`), or as a non-admin. */
  const admin = async (method: string, path: string, call: { admin?: boolean; subject?: string; headers?: Record<string, string> } = {}) => {
    const claims = { iss: issuer, sub: call.subject ?? ADMIN_SUBJECT, groups: call.admin === false ? [] : ["admins"] };
    const response = await harness.handler({
      version: "2.0", rawPath: path.split("?")[0], rawQueryString: path.split("?")[1] ?? "",
      headers: { authorization: "Bearer admin-token-for-tests", ...call.headers },
      requestContext: { requestId: randomUUID(), http: { method }, authorizer: { jwt: { claims } } },
    });
    return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
  };
  return { ...harness, admin };
}
