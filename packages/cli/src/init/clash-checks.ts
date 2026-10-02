// packages/cli/src/init/clash-checks.ts
// Spec 048 FR-028 and FR-065: the answer checks beyond AWS's own: the install name is not used here
// already, the GitHub owner exists and is the kind the answers say, and the app name fits both
// platforms and is free on GitHub. Each is a PrerequisiteCheck for the checklist; nothing is
// created, and a GitHub that cannot answer is "could not check", never a wrong answer.
import { environmentStackName } from "@agentx/contracts";
import { installOrder } from "../deploy/parameters.js";
import type { StackStatusReader } from "./context.js";
import { githubAppSlug, type GitHubApi } from "./github-app.js";
import type { InitAnswers } from "./install-state.js";
import type { CheckAudience, PrerequisiteCheck } from "./prerequisites.js";
import { GITHUB_APP_NAME_LIMIT, SLACK_APP_NAME_LIMIT } from "./settings-form.js";

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const kindWord = (type: "organization" | "user"): string => (type === "organization" ? "an organization" : "a personal account");

export async function clashChecks(input: {
  answers: InitAnswers; stackStatus: StackStatusReader; github: GitHubApi; audience: CheckAudience; installUsed: (env: string) => Promise<boolean>;
  /** Stacks this run expects to exist already, never a clash: an export bundle's access stack,
   * which the platform team deployed before this run. */
  expectedStacks?: readonly string[];
  /** True with an app made beforehand (--github-app-id): it is this install's own app, so GitHub
   * having an app of that name is no clash, and only the name's length is checked. */
  preMadeApp?: boolean;
}): Promise<PrerequisiteCheck[]> {
  const { answers } = input;
  const page = input.audience === "page";
  const checks: PrerequisiteCheck[] = [];

  const expected = new Set(input.expectedStacks ?? []);
  const stacks = installOrder(answers.identity.mode).map((part) => environmentStackName(answers.env, part)).filter((stack) => !expected.has(stack));
  // Fix round 1: a failed stack read (AccessDenied on DescribeStacks) or a failed `installUsed`
  // (an SSM read) must become a failed check like every other clash check here, never escape and
  // abort `checkPrerequisites` part way through (its `extraChecks` call has no try/catch of its
  // own, so an uncaught throw here would drop every problem collected before it).
  try {
    const existing: string[] = [];
    for (const stack of stacks) if ((await input.stackStatus.status(stack)) !== undefined) existing.push(stack);
    if (existing.length > 0 || (await input.installUsed(answers.env))) {
      checks.push({
        label: "Install name", ok: false,
        detail: page
          ? `This AWS account and region already have an AgentX install named ${answers.env}. Choose another install name.`
          : `environment ${answers.env} already has stacks or settings in this account and region; choose another --env`,
        ...(page && existing.length > 0 ? { technical: existing.join(", ") } : {}),
      });
    } else {
      checks.push({ label: "Install name", ok: true, detail: `${answers.env} is free in this account and region` });
    }
  } catch (error) {
    checks.push({
      label: "Install name", ok: false,
      detail: page
        ? "AgentX could not check whether the install name is free. Check your access to AWS, then check again."
        : `could not check whether environment ${answers.env} is free (${reason(error)}); check your AWS access and run agentx init again`,
      ...(page ? { technical: reason(error) } : {}),
    });
  }

  // Review Focus 3: github.owner itself, never the settings' ownerType (which reads a failed lookup
  // as "GitHub cannot say"): undefined is "no such owner", a throw is "could not check".
  const owner = answers.github.account;
  if (input.github.owner !== undefined) {
    try {
      const found = await input.github.owner(owner);
      if (found === undefined) {
        checks.push({ label: "GitHub owner", ok: false, detail: page ? `GitHub has no organization or user named ${owner}. Check the spelling.` : `GitHub has no organization or user named ${owner}; check --github-account` });
      } else {
        const actual = found.type === "Organization" ? "organization" : "user";
        checks.push(actual === answers.github.accountType
          ? { label: "GitHub owner", ok: true, detail: `${owner} is ${kindWord(actual)} on GitHub` }
          : {
            label: "GitHub owner", ok: false,
            detail: page
              ? `${owner} is ${actual === "user" ? "a personal GitHub account" : "a GitHub organization"}, not ${kindWord(answers.github.accountType)}. Change the answer.`
              : `${owner} is ${kindWord(actual)} on GitHub, not ${kindWord(answers.github.accountType)}; check --github-account-type`,
          });
      }
    } catch (error) {
      checks.push({
        label: "GitHub owner", ok: false,
        detail: page ? `AgentX could not reach GitHub to check ${owner}. Check your network, then check again.` : `could not check the GitHub owner ${owner} (${reason(error)}); check your network and run agentx init again`,
        ...(page ? { technical: reason(error) } : {}),
      });
    }
  }

  const { appName } = answers.github;
  if (appName.length > GITHUB_APP_NAME_LIMIT || answers.slack.appName.length > SLACK_APP_NAME_LIMIT) {
    checks.push({ label: "App name", ok: false, detail: page ? `The app name is longer than GitHub's ${GITHUB_APP_NAME_LIMIT} characters or Slack's ${SLACK_APP_NAME_LIMIT}. Choose a shorter app name.` : `the app name must be at most ${GITHUB_APP_NAME_LIMIT} characters for GitHub and ${SLACK_APP_NAME_LIMIT} for Slack; check --github-app-name and --slack-app-name` });
  } else if (input.preMadeApp !== true && input.github.appBySlug !== undefined) {
    const slug = githubAppSlug(appName);
    try {
      const app = await input.github.appBySlug(slug);
      checks.push(app === undefined
        ? { label: "App name", ok: true, detail: `${appName} is free on GitHub` }
        : { label: "App name", ok: false, detail: page ? `GitHub already has an app named ${appName}. Choose another app name.` : `GitHub already has an app named ${appName}; choose another with --github-app-name`, technical: slug });
    } catch (error) {
      checks.push({
        label: "App name", ok: false,
        detail: page ? "AgentX could not reach GitHub to check the app name. Check your network, then check again." : `could not check the app name on GitHub (${reason(error)}); check your network and run agentx init again`,
        ...(page ? { technical: reason(error) } : {}),
      });
    }
  } else {
    checks.push({ label: "App name", ok: true, detail: `${appName} fits GitHub and Slack` });
  }
  return checks;
}
