// The init steps that deploy stacks: each drives 15c2's deployEnvironment for its parts, under the
// lock the step runner already holds. Before deploying, a step waits for any of its stacks still
// busy from an interrupted run (CloudFormation keeps going after a terminal closes).
import { agentXError, environmentStackName } from "@agentx/contracts";
import { deployIdentityAnswers, deployImagesAnswers, progressLine } from "../deploy/commands.js";
import { deployEnvironment, type DeployAnswers } from "../deploy/deploy-environment.js";
import { installOrder, type DeployPart } from "../deploy/parameters.js";
import { writeEnvironmentCache } from "../environments/cache.js";
import { readEnvironmentSettings } from "../environments/settings.js";
import type { InitContext, StackStatusReader } from "./context.js";
import type { InitAnswers, InstallProgress } from "./install-state.js";
import type { InitStep, ProgressHandle } from "./steps.js";

export const DEPLOY_STEP_PARTS = {
  access: ["access"],
  core: ["foundation", "identity"],
  "control-plane": ["control-plane", "runtime"],
  "slack-service": ["slack"],
} as const satisfies Record<string, readonly DeployPart[]>;
export type DeployStepId = keyof typeof DEPLOY_STEP_PARTS;

export const IDLE_WAIT_TIMEOUT_MS = 60 * 60 * 1000;
const IDLE_POLL_MS = 15_000;

/** The deploy answers for `parts`. GitHub is filled only for the control plane, which cannot deploy
 * before the github-app step has recorded the app's installation; earlier parts do not read it. */
export function initDeployAnswers(answers: InitAnswers, progress: InstallProgress, parts: readonly DeployPart[]): DeployAnswers {
  let github: DeployAnswers["github"] = { account: "", appId: "", installationId: "", privateKeySecretArn: "" };
  if (parts.includes("control-plane")) {
    const app = progress.github;
    if (app?.installationId === undefined) {
      throw agentXError("CONFIG_INVALID", "the control plane needs the GitHub App's installation; the github-app step must finish first");
    }
    github = { account: app.account, appId: app.appId, installationId: app.installationId, privateKeySecretArn: app.privateKeySecretArn };
  }
  const images = deployImagesAnswers(answers.images);
  return {
    env: answers.env,
    region: answers.region,
    account: answers.account,
    models: answers.models,
    identity: deployIdentityAnswers(answers.identity),
    github,
    ...(answers.permissionsBoundaryArn === undefined ? {} : { permissionsBoundaryArn: answers.permissionsBoundaryArn }),
    ...(answers.operatorPrincipalArn === undefined ? {} : { operatorPrincipalArn: answers.operatorPrincipalArn }),
    ...(images === undefined ? {} : { images }),
    slackAppPostedMessages: answers.slack.appPostedMessages,
    ...(answers.budget === undefined ? {} : { budget: answers.budget }),
  };
}

/** The status of a stack CloudFormation is still working on, or undefined when it is idle or does
 * not exist. REVIEW_IN_PROGRESS is a change set awaiting review on a stack with no resources yet:
 * nothing is running, so deploying over it is fine. */
const busyStatus = (status: string | undefined): string | undefined =>
  status !== undefined && status.endsWith("_IN_PROGRESS") && status !== "REVIEW_IN_PROGRESS" ? status : undefined;

/** Waits, stack by stack, until none of `stackNames` is busy, saying once per stack that it waits.
 * Gives up once `timeoutMs` (60 minutes) has passed in total, with what to do. Settled statuses,
 * including failed ones such as ROLLBACK_COMPLETE, are not waited for: the deploy reports those. */
export async function waitForIdleStacks(input: {
  reader: StackStatusReader; stackNames: readonly string[]; sleep: (ms: number) => Promise<void>; write: (line: string) => void; now: () => number;
  pollMs?: number; timeoutMs?: number;
}): Promise<void> {
  const timeout = input.timeoutMs ?? IDLE_WAIT_TIMEOUT_MS;
  // One budget for the whole step, so a step with two busy stacks still gives up after 60 minutes.
  const started = input.now();
  for (const stackName of input.stackNames) {
    let busy = busyStatus(await input.reader.status(stackName));
    if (busy !== undefined) input.write(`Waiting for ${stackName}: it is ${busy} from an earlier run`);
    while (busy !== undefined) {
      if (input.now() - started >= timeout) {
        throw agentXError("CONFIG_INVALID", `stack ${stackName} is still ${busy} after ${Math.round(timeout / 60_000)} minutes; check it in the CloudFormation console, then run agentx init again`);
      }
      await input.sleep(input.pollMs ?? IDLE_POLL_MS);
      busy = busyStatus(await input.reader.status(stackName));
    }
  }
}

export function deployStep(input: { id: DeployStepId; title: string; after?: (context: InitContext, progress: ProgressHandle) => Promise<void> }): InitStep<InitContext> {
  return {
    id: input.id,
    title: input.title,
    async run(context, progress) {
      const { env, answers } = context;
      const order = installOrder(answers.identity.mode);
      const parts = DEPLOY_STEP_PARTS[input.id].filter((part) => order.includes(part));
      await waitForIdleStacks({ reader: context.stackStatus, stackNames: parts.map((part) => environmentStackName(env, part)), sleep: context.sleep, write: context.write, now: context.now });
      const deployment = await context.deployment();
      const result = await deployEnvironment({
        mode: "install",
        engine: answers.engine,
        answers: initDeployAnswers(answers, progress.current(), parts),
        release: context.release,
        deployer: deployment.deployer,
        store: deployment.store,
        secrets: deployment.secrets,
        holder: context.holder,
        parts: [...parts],
        lockHeld: true,
        onEvent: (event) => context.write(progressLine(event)),
        now: context.now,
      });
      if (input.id === "slack-service") {
        const settings = result.settingsWritten ? await readEnvironmentSettings(deployment.store, env) : undefined;
        if (settings === undefined) {
          throw agentXError("CONFIG_INVALID", `the Slack service deployed but environment ${env}'s settings were not written because not every stack reports its outputs; check the agentx-${env}-* stacks in CloudFormation, then run agentx init again`);
        }
        const path = await writeEnvironmentCache(context.home, settings);
        context.write(`Environment settings written to /agentx/${env}/settings; this machine's copy is ${path}`);
      }
      if (input.after !== undefined) await input.after(context, progress);
      return { status: "done" };
    },
  };
}
