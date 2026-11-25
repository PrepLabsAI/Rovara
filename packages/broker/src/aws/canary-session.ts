// packages/broker/src/aws/canary-session.ts
// The CanarySession Lambda: wires developer/canary-session.ts to AWS. It exists only where the deploy sets the canary parameters (infra/lib/canary-session.ts: beta only). There is no HTTP
// route, function URL or event source: a direct invoke by the canary stack's step role (the function's one resource-policy permission) is the only way in. It reads no secret.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { KMSClient } from "@aws-sdk/client-kms";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { CanaryMintStore, canarySessionConfigFromEnvironment, createCanarySession, type CanaryAnswer } from "../developer/canary-session.js";
import { CompanySignInStore } from "../developer/company-membership.js";
import { DeveloperSignInStore } from "../developer/store.js";
import { kmsTokenSigner } from "../developer/tokens.js";

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/** Reads the given environment (never process.env directly), so it can be tested. The mint counter lives in the sign-in table, with the sessions. */
export function createAwsCanarySession(env: NodeJS.ProcessEnv): (event: unknown) => Promise<CanaryAnswer> {
  const region = env.AWS_REGION === undefined ? {} : { region: env.AWS_REGION };
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient(region), { marshallOptions: { removeUndefinedValues: true } });
  const tableName = required(env, "DEVELOPER_SIGNIN_TABLE_NAME");
  const now = () => Date.now();
  return createCanarySession({
    config: canarySessionConfigFromEnvironment(env),
    store: new DeveloperSignInStore({ documentClient, tableName, now }),
    company: new CompanySignInStore({ documentClient, tableName, now }),
    counter: new CanaryMintStore({ documentClient, tableName, now }),
    signer: kmsTokenSigner({ kms: new KMSClient(region), keyId: required(env, "DEVELOPER_TOKEN_KEY_ARN") }),
    now,
    log: (entry) => console.log(JSON.stringify(entry)),
  });
}

let built: ReturnType<typeof createAwsCanarySession> | undefined;

/** Fails closed: a function that cannot be built (a missing variable) answers `refused`, never an error that names the variable. */
export const handler = async (event: unknown): Promise<CanaryAnswer> => {
  try {
    built ??= createAwsCanarySession(process.env);
  } catch {
    return { ok: false, error: "refused" };
  }
  return built(event);
};
