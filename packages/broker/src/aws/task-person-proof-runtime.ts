import { slackCallerToken, type SlackCallerWorkspaces } from "./slack-workspace-tokens.js";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { IMPLICIT_COMPANY_ID, SlackTeamIdSchema, TaskDispatchProofRequestSchema, SlackWorkspaceScopeSchema, agentXError } from "@agentx/contracts";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { slackCompanyDependenciesFromEnvironment } from "./slack-company-wiring.js";
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
async function legacyHandler(event: unknown, context: TaskPersonProofLambdaContext) {
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

/**
 * L2-2 PR 18d: in company mode, a proof for the install's own work (no workspace named at all, or both scopes naming the implicit company and the install's team) keeps
 * today's handler; anything else takes the company path, which checks the scope in full.
 */
export function proofIsInstalls(event: unknown, legacyTeamId: string | undefined): boolean {
  if (legacyTeamId === undefined || event === null || typeof event !== "object" || Array.isArray(event)) return false;
  const outer = (event as { workspace?: unknown }).workspace;
  const request = (event as { request?: unknown }).request;
  const inner = request !== null && typeof request === "object" && !Array.isArray(request) ? (request as { workspace?: unknown }).workspace : undefined;
  if (outer === undefined && inner === undefined) return true;
  const install = (scope: unknown) => scope !== null && typeof scope === "object" && !Array.isArray(scope)
    && (scope as { teamId?: unknown }).teamId === legacyTeamId && (scope as { companyId?: unknown }).companyId === IMPLICIT_COMPANY_ID;
  return install(outer) && install(inner);
}

export function createTaskPersonProofRuntime(options: { workspaces?: SlackCallerWorkspaces; legacyTeamId?: string; fetch?: typeof fetch; env?: NodeJS.ProcessEnv; legacy?: typeof legacyHandler } = {}) {
  const legacy = options.legacy ?? legacyHandler;
  return async (event: unknown, context: TaskPersonProofLambdaContext) => {
    if (options.workspaces === undefined || proofIsInstalls(event, options.legacyTeamId)) return legacy(event, context);
    const env = options.env ?? process.env;
    if (env.AGENTX_ENV !== "agentxlivetest123" || (env.AWS_REGION ?? "us-east-1") !== "us-east-1") throw UNAVAILABLE();
    const parsed = TaskDispatchProofRequestSchema.safeParse(event);
    if (!parsed.success) throw UNAVAILABLE();
    const scope = SlackWorkspaceScopeSchema.safeParse(parsed.data.workspace);
    const nested = SlackWorkspaceScopeSchema.safeParse(parsed.data.request.workspace);
    if (!scope.success || !nested.success || scope.data.companyId !== nested.data.companyId || scope.data.teamId !== nested.data.teamId) throw UNAVAILABLE();
    const workspaces = options.workspaces;
    return createTaskPersonProofHandler({ expectedTeamId: scope.data.teamId, now: Date.now, remainingTimeMs: () => context.getRemainingTimeInMillis(),
      readProof: async (request, admission) => {
        if (admission.abortSignal.aborted || Date.now() >= admission.deadlineAt) throw UNAVAILABLE();
        const credential = await slackCallerToken(workspaces, scope.data);
        const directory = slackDirectory({ teamId: scope.data.teamId, now: Date.now, fetch: options.fetch ?? fetch, maxCallsPerRequest: 100, maxInfoCallsPerRequest: 1,
          botToken: () => {
            if (admission.abortSignal.aborted || Date.now() >= admission.deadlineAt) throw UNAVAILABLE();
            return Promise.resolve(credential);
          } });
        return directory.taskDispatchPersonProof(request, admission);
      },
    })(parsed.data);
  };
}
/** L2-2 PR 18d: Slack company mode (slack-company-wiring.ts); off (the default, and while this function has no switch variables), today's proof. */
export function proofFromEnvironment(env: NodeJS.ProcessEnv): ReturnType<typeof createTaskPersonProofRuntime> {
  const region = env.AWS_REGION === undefined ? {} : { region: env.AWS_REGION };
  const dynamo = new DynamoDBClient(region);
  const wiring = slackCompanyDependenciesFromEnvironment(env, { documentClient: DynamoDBDocumentClient.from(dynamo), dynamo, secrets: new SecretsManagerClient(region) });
  return wiring === undefined ? createTaskPersonProofRuntime() : createTaskPersonProofRuntime({ workspaces: wiring.workspaces, legacyTeamId: wiring.legacyTeamId });
}
export const handler = proofFromEnvironment(process.env);
