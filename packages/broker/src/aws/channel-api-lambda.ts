// Spec 062 Phase 7c2: the channel API's Lambda: the neutral channel ingress, with the built-in Slack adapter's router
// (Phase 7c2) and press handlers (Phase 7c3) when the deployment routes Slack through the channel API. Phase 7c3b: a
// ChatGPT connection handed off by a submitted form finishes in an asynchronous invoke of this same Lambda.
// DEC 254y(3), L2-2 PR 18e: Slack company mode (slack-company-wiring.ts). Off (either switch, no broker, or a half-configured Lambda), every Slack piece is today's, built
// exactly as before. On, each piece is two: the install's team keeps today's; any other tenant, or one that cannot be read, goes to the company piece (fail closed).
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { channelApiHandler, type ChannelActionSurface, type ChannelIngressEvent, type ChannelSurface } from "./channel-ingress.js";
import { isHandedOffChatGptFinish, type HandedOffChatGptFinish } from "./slack-chatgpt.js";
import { createAwsSlackChannelPresses, createAwsSlackChatGptFinish, splitChannelActionSurfaceByTenant } from "./slack-channel-presses.js";
import { createAwsSlackChannelRouter, splitChannelSurfaceByTenant } from "./slack-channel-router.js";
import { slackCompanyDependenciesFromEnvironment, slackCompanyModeRequested, type SlackCompanyWiring } from "./slack-company-wiring.js";
import type { SlackCompanyDependencies } from "./slack-person.js";
import type { BrokerReply } from "./slack-workflow-choice.js";

type Finish = (event: HandedOffChatGptFinish) => Promise<"connected" | "refused">;
/** The Slack pieces as each is made: called with no argument, today's piece exactly. */
export interface ChannelApiSlackMakers {
  router: (company?: SlackCompanyDependencies) => ChannelSurface;
  presses: (company?: SlackCompanyDependencies) => ChannelActionSurface;
  finish: (company?: SlackCompanyDependencies) => Finish;
}
const AWS_MAKERS: ChannelApiSlackMakers = { router: createAwsSlackChannelRouter, presses: createAwsSlackChannelPresses, finish: createAwsSlackChatGptFinish };

/** This Lambda's company wiring, or undefined (today's Lambda): link notices are issued by the broker through its existing invoke, as in the Slack Lambda. */
export function channelApiSlackCompany(env: NodeJS.ProcessEnv): SlackCompanyWiring | undefined {
  const functionName = env.BROKER_FUNCTION_NAME ?? "";
  if (!slackCompanyModeRequested(env) || functionName === "") return undefined;
  const clientConfiguration = env.AWS_REGION === undefined ? {} : { region: env.AWS_REGION };
  const dynamo = new DynamoDBClient(clientConfiguration);
  const lambda = new LambdaClient(clientConfiguration);
  return slackCompanyDependenciesFromEnvironment(env, {
    documentClient: DynamoDBDocumentClient.from(dynamo), dynamo, secrets: new SecretsManagerClient(clientConfiguration),
    async linkNotice(teamId, userId) {
      const response = await lambda.send(new InvokeCommand({ FunctionName: functionName, InvocationType: "RequestResponse", Payload: Buffer.from(JSON.stringify({ source: "agentx.slack-link-notice", teamId, userId })) }));
      if (response.FunctionError !== undefined || response.Payload === undefined) return undefined;
      const reply = JSON.parse(Buffer.from(response.Payload).toString("utf8")) as BrokerReply;
      if (reply.statusCode !== 200) return undefined;
      const text = (JSON.parse(reply.body ?? "{}") as { text?: unknown }).text;
      return typeof text === "string" && text.length <= 2_000 ? text : undefined;
    },
  });
}

/** The finish's own split: only a finish naming exactly the install's team is today's; any other (or unreadable) team gets the company finish, which refuses. */
export function splitChatGptFinishByTeam(legacy: Finish, company: Finish | undefined, legacyTeamId: string, installOnLegacy?: () => Promise<boolean>): Finish {
  if (company === undefined) return legacy;
  // #1300: the install's team keeps today's finish only while it is on the legacy path.
  return async (event) => {
    if ((event as { teamId?: unknown }).teamId !== legacyTeamId) return await company(event);
    return await (installOnLegacy === undefined || await installOnLegacy() ? legacy : company)(event);
  };
}

/** Each Slack piece, made once. Off (no wiring), each maker is called with no argument and its piece is returned as it is. */
export function channelApiSlackPieces(makers: ChannelApiSlackMakers, wiring: SlackCompanyWiring | undefined) {
  if (wiring === undefined) return { router: () => makers.router(), presses: () => makers.presses(), finish: () => makers.finish() };
  // Defence in depth, as in the broker's and the Slack Lambda's legacy views: another team's channel binding is "not bound" in today's pieces while company mode is on.
  const legacy: SlackCompanyDependencies = { slackInstallTeamOnly: wiring.legacyTeamId };
  const company: SlackCompanyDependencies = { workspaces: wiring.workspaces, ...(wiring.companies === undefined ? {} : { companies: wiring.companies }), onWorkspaceRemoved: (team) => wiring.forget(team) };
  return {
    router: () => splitChannelSurfaceByTenant(makers.router(legacy), makers.router(company), wiring.legacyTeamId, wiring.installOnLegacy),
    presses: () => splitChannelActionSurfaceByTenant(makers.presses(legacy), makers.presses(company), wiring.legacyTeamId, wiring.installOnLegacy),
    finish: () => splitChatGptFinishByTeam(makers.finish(legacy), makers.finish(company), wiring.legacyTeamId, wiring.installOnLegacy),
  };
}

export function createChannelApiLambda(env: NodeJS.ProcessEnv = process.env, makers: ChannelApiSlackMakers = AWS_MAKERS, companyOf: (env: NodeJS.ProcessEnv) => SlackCompanyWiring | undefined = channelApiSlackCompany) {
  const slackOn = () => env.BUILT_IN_ADAPTER === "enabled";
  let pieces: ReturnType<typeof channelApiSlackPieces> | undefined;
  const slack = () => (pieces ??= channelApiSlackPieces(makers, companyOf(env)));
  const api = channelApiHandler(
    () => (slackOn() ? { slack: slack().router() } : {}),
    () => (slackOn() ? { slack: slack().presses() } : {}),
  );
  let finish: Finish | undefined;
  return async (event: ChannelIngressEvent | HandedOffChatGptFinish) => {
    if (isHandedOffChatGptFinish(event)) {
      if (!slackOn()) throw new Error("Slack does not go through the channel API here");
      finish ??= slack().finish();
      return { outcome: await finish(event) };
    }
    return api(event);
  };
}

export const handler = createChannelApiLambda();
