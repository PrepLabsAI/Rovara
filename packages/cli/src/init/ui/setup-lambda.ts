// The setup page's function (the installer stack, infra/lib/installer.ts): API Gateway's HTTP API
// events in, setup-handler.ts's responses out. Everything it needs is in its environment:
//   SETUP_TABLE      the setup table the installer job's relay writes
//   INSTALL_NAME     the install's name (agentx-<name>-* stacks)
//   SETUP_KEY_ID     the table's KMS key, which seals the admin's sign-in for the job
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { KMSClient } from "@aws-sdk/client-kms";
import { environmentStackName } from "@agentx/contracts";
import { kmsTokenSeal, type SetupIdentity } from "./setup-auth.js";
import { setupPageHandler, type SetupPageAuth, type SetupRequest, type SetupResponse } from "./setup-handler.js";
import { dynamoSetupStore, type SetupStore } from "./setup-store.js";

/** The parts of API Gateway's payload format 2.0 the page uses. */
export interface SetupPageEvent {
  rawPath?: string;
  rawQueryString?: string;
  headers?: Record<string, string | undefined>;
  cookies?: string[];
  body?: string;
  isBase64Encoded?: boolean;
  requestContext?: { domainName?: string; http?: { method?: string } };
}
export interface SetupPageResult { statusCode: number; headers: Record<string, string>; body: string; cookies?: string[] }

/** The identity stack's sign-in, once the installer job has deployed that stack; read until found. */
export function stackSetupIdentity(input: { cloudFormation: Pick<CloudFormationClient, "send">; env: string }): () => Promise<SetupIdentity | undefined> {
  let found: SetupIdentity | undefined;
  return async () => {
    if (found !== undefined) return found;
    try {
      const stack = (await input.cloudFormation.send(new DescribeStacksCommand({ StackName: environmentStackName(input.env, "identity") }))).Stacks?.[0];
      const output = (key: string) => stack?.Outputs?.find((each) => each.OutputKey === key)?.OutputValue;
      const hostedUiDomain = output("HostedUiDomain");
      const clientId = output("ClientId");
      if (typeof hostedUiDomain === "string" && typeof clientId === "string") found = { hostedUiDomain, clientId };
    } catch (error) {
      // Not deployed yet: the page says sign-in is still being set up.
      if (!(error instanceof Error && error.name === "ValidationError")) throw error;
    }
    return found;
  };
}

/** One request through the page's handler. The page's origin is the API's own address. */
export function setupPageFunction(input: { store: SetupStore; env: string; auth: SetupPageAuth }): (event: SetupPageEvent) => Promise<SetupPageResult> {
  return async (event) => {
    const domain = event.requestContext?.domainName ?? event.headers?.host ?? "";
    const handle = setupPageHandler({ store: input.store, env: input.env, origin: `https://${domain}`, auth: input.auth });
    const headers: Record<string, string | undefined> = { ...event.headers };
    // Payload format 2.0 moves the Cookie header into `cookies`.
    if (event.cookies !== undefined && event.cookies.length > 0) headers.cookie = event.cookies.join("; ");
    const request: SetupRequest = {
      method: event.requestContext?.http?.method ?? "GET",
      path: event.rawPath ?? "/",
      query: Object.fromEntries(new URLSearchParams(event.rawQueryString ?? "")),
      headers,
      ...(event.body === undefined ? {} : { body: event.isBase64Encoded === true ? Buffer.from(event.body, "base64").toString("utf8") : event.body }),
    };
    const response: SetupResponse = await handle(request);
    return { statusCode: response.status, headers: response.headers, body: response.body, ...(response.cookies === undefined ? {} : { cookies: response.cookies }) };
  };
}

const required = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
};

let run: ((event: SetupPageEvent) => Promise<SetupPageResult>) | undefined;

export async function handler(event: SetupPageEvent): Promise<SetupPageResult> {
  if (run === undefined) {
    const env = required("INSTALL_NAME");
    run = setupPageFunction({
      store: dynamoSetupStore({ client: new DynamoDBClient({}), table: required("SETUP_TABLE"), env }),
      env,
      auth: {
        kind: "cognito",
        identity: stackSetupIdentity({ cloudFormation: new CloudFormationClient({}), env }),
        seal: kmsTokenSeal({ client: new KMSClient({}), env, keyId: required("SETUP_KEY_ID") }),
      },
    });
  }
  return run(event);
}
