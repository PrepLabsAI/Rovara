import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SlackTeamIdSchema, agentXError } from "@agentx/contracts";
import { slackDirectory } from "../developer/slack-directory.js";
import { createTaskPersonProofHandler } from "./task-person-proof-handler.js";

export interface TaskPersonProofLambdaContext {
  getRemainingTimeInMillis(): number;
}

const UNAVAILABLE = () => agentXError("SLACK_UNAVAILABLE", "task person identity proof is unavailable");
const SECRET_ARN = /^arn:aws:secretsmanager:us-east-1:944937319445:secret:agentx\/agentxlivetest123\/slack-[A-Za-z0-9]+$/;

function botTokenFromSecret(secretString: string): string {
  let value: unknown;
  try {
    value = JSON.parse(secretString) as unknown;
  } catch {
    throw UNAVAILABLE();
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw UNAVAILABLE();
  const token = (value as Record<string, unknown>).botToken;
  if (typeof token !== "string" || !/^xoxb-\S+$/.test(token)) throw UNAVAILABLE();
  return token;
}

/** Dedicated named-TEST Lambda runtime. Credentials are read once per proof invocation and never cached across invocations. */
export async function handler(event: unknown, context: TaskPersonProofLambdaContext) {
  const env = process.env;
  const teamId = env.SLACK_TEAM_ID;
  const secretArn = env.SLACK_SECRET_ARN;
  if (env.AGENTX_ENV !== "agentxlivetest123" || teamId === undefined || !SlackTeamIdSchema.safeParse(teamId).success
    || secretArn === undefined || !SECRET_ARN.test(secretArn)) throw UNAVAILABLE();

  const region = env.AWS_REGION === undefined ? "us-east-1" : env.AWS_REGION;
  if (region !== "us-east-1") throw UNAVAILABLE();
  const secrets = new SecretsManagerClient({ region, maxAttempts: 1 });
  const proof = createTaskPersonProofHandler({
    expectedTeamId: teamId,
    now: () => Date.now(),
    remainingTimeMs: () => context.getRemainingTimeInMillis(),
    async readProof(request, admission) {
      let credential: Promise<string> | undefined;
      const botToken = async (): Promise<string> => {
        if (admission.abortSignal.aborted || Date.now() >= admission.deadlineAt) throw UNAVAILABLE();
        credential ??= secrets.send(new GetSecretValueCommand({ SecretId: secretArn }), { abortSignal: admission.abortSignal }).then((reply) => {
          if (admission.abortSignal.aborted || Date.now() >= admission.deadlineAt || typeof reply.SecretString !== "string") throw UNAVAILABLE();
          return botTokenFromSecret(reply.SecretString);
        });
        return credential;
      };
      const directory = slackDirectory({
        teamId,
        botToken,
        fetch,
        now: () => Date.now(),
        maxCallsPerRequest: 100,
        maxInfoCallsPerRequest: 1,
      });
      return directory.taskDispatchPersonProof(request, {
        deadlineAt: admission.deadlineAt,
        slackCallsLimit: admission.slackCallsLimit,
        abortSignal: admission.abortSignal,
      });
    },
  });
  return proof(event);
}
