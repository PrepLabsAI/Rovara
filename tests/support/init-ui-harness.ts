// SC-003: the shared harness for `agentx init --ui`: a full install driven entirely from the page.
// Moved out of init-ui-cli.test.ts (Task 17) so the whole-journey copy-lint tests can reuse it
// without duplicating the server and fake setup. The wizard server and the GitHub manifest listener
// are both real, on 127.0.0.1; every AWS, GitHub, Slack and clock dependency is injected, so nothing
// here reaches AWS, GitHub or Slack.
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { environmentStackName } from "@agentx/contracts";
import { executeCli } from "../../packages/cli/src/main.js";
import { environmentCachePath } from "../../packages/cli/src/environments/cache.js";
import { DEFAULT_CLASSIFIER_MODEL, DEFAULT_ORCHESTRATOR_MODEL, DEFAULT_WORKER_MODEL } from "../../packages/cli/src/init/answers.js";
import type { InitCliDependencies } from "../../packages/cli/src/init/commands.js";
import { estimateMonthlyCost, suggestedBudgetUsd } from "../../packages/cli/src/init/cost.js";
import { initLogPath } from "../../packages/cli/src/init/log-file.js";
import {
  allStackOutputs, browserThatCreatesGitHubApp, fakeGitHubApi, fakeSlackApi, HOLDER, memoryInitSecrets, passingChecks, scriptedDeployer,
  settingsScript, slackIngressFetch, T0, TEST_BOT_TOKEN, TEST_SIGNING_SECRET,
} from "./init-fakes.js";
import { fakeWizardOperator } from "./wizard-browser.js";
import { SIGN_IN_PARAMETERS, fakeCloudFormation } from "./fake-cloudformation.js";
import { MemoryParameterStore } from "./memory-parameter-store.js";
import { ADMIN_EMAIL, FOUNDATION_OUTPUTS, fakeAlerts, fakeControlPlane, fakeRepositories, fakeSlackChannels, setupServices, turn } from "./setup-fakes.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const tmp = async (prefix: string) => { const dir = await mkdtemp(join(tmpdir(), prefix)); dirs.push(dir); return dir; };
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export async function releaseDir(regions: readonly string[] = ["us-east-1"]): Promise<string> {
  const dir = await tmp("agentx-init-ui-release-");
  const templates = [];
  for (const region of regions) {
    await mkdir(join(dir, "templates", region), { recursive: true });
    for (const part of ["access", "foundation", "identity", "control-plane", "runtime", "slack"]) {
      const file = `templates/${region}/${part}.template.json`;
      await writeFile(join(dir, file), "{}");
      templates.push({ region, part, file, sha256: sha256("{}") });
    }
  }
  await writeFile(join(dir, "release.json"), JSON.stringify({
    schemaVersion: 1, version: "1.2.3", gitCommit: "a".repeat(40), environmentPlaceholder: "qqenv-placeholderqq", templates, packages: [],
    images: { worker: `public.ecr.aws/agentx/worker@sha256:${"a".repeat(64)}`, slack: `public.ecr.aws/agentx/slack@sha256:${"b".repeat(64)}` },
  }));
  return dir;
}

// Spec 048 phase 2: the page posts the settings as one form (FR-020), then confirms the plan.
// FINISH is the finishing steps (phase 15d2), which no longer ask your email (the settings hold
// it): repository; project name; use the proposed commands; channel; the three connector offers;
// "did the test alarm arrive?".
/** The settings form: your email (the admin user), the owner, and alerts to the ops address. */
export const SETTINGS = JSON.stringify({ email: ADMIN_EMAIL, githubAccount: "acme", alertEmail: "ops@example.com" });
export const FIRST_RUN = [SETTINGS, "create"];
/** The same settings answered in the terminal, in the form's order, then the plan's confirm. */
export const TERMINAL_FIRST_RUN = [...settingsScript({ email: ADMIN_EMAIL, owner: "acme", advanced: { alertEmail: "ops@example.com" } }), true];
export const SLACK_CLIENT_ID = "1111111111.2222222222222";
export const SLACK_CLIENT_SECRET = "fedcba9876543210fedcba9876543210";
export const SLACK_VALUES = JSON.stringify({
  clientId: SLACK_CLIENT_ID,
  clientSecret: SLACK_CLIENT_SECRET,
  signingSecret: TEST_SIGNING_SECRET,
  botToken: TEST_BOT_TOKEN,
});
export const SLACK = ["installed", SLACK_VALUES, true, true];
/** The Slack app step answered in the terminal, where the form's values are separate prompts. */
export const TERMINAL_SLACK = ["installed", SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, TEST_SIGNING_SECRET, TEST_BOT_TOKEN, true, true];
export const SIGNIN: Array<string | boolean> = [];
export const FINISH = ["acme/payments-api", "", true, "payments", false, false, false, true];
/** The three recommended models FIRST_RUN takes. */
export const DEFAULTS = { orchestrator: DEFAULT_ORCHESTRATOR_MODEL, classifier: DEFAULT_CLASSIFIER_MODEL, worker: DEFAULT_WORKER_MODEL };
// The budget FIRST_RUN's all-default models produce: the estimate plus 20%, one source with cost.ts.
export const FIRST_RUN_BUDGET_USD = suggestedBudgetUsd(estimateMonthlyCost(DEFAULTS));

/** What the finishing steps read from the stacks: every deployed output, with the foundation's EC2
 * worker outputs as the real foundation stack has them (allStackOutputs's are placeholders). */
export async function finishStackOutputs(name: string): Promise<Record<string, string> | undefined> {
  const outputs = allStackOutputs()[name];
  return outputs === undefined || name !== environmentStackName("staging", "foundation") ? outputs : { ...outputs, ...FOUNDATION_OUTPUTS };
}

export async function harness() {
  let clock = T0;
  const store = new MemoryParameterStore();
  const secrets = memoryInitSecrets({ "agentx/staging/slack": JSON.stringify({ botToken: "unset", signingSecret: "placeholder" }) });
  const deployer = scriptedDeployer(allStackOutputs());
  const github = fakeGitHubApi();
  const out: string[] = [];
  const err: string[] = [];
  const home = await tmp("agentx-init-ui-home-");
  const release = await releaseDir();
  // The finishing steps' services, faked as the terminal path's tests fake them, so a run that
  // finishes reaches no AWS, GitHub or Slack: one repository, the payments channel, a confirmed
  // alert subscription and the budget FIRST_RUN takes (the estimate plus 20%), and a turn received
  // a day after T0.
  const projects = await tmp("agentx-init-ui-projects-");
  const plane = fakeControlPlane();
  plane.turns = [turn({ subject: "T0TEAM/C0PAY00001/1790000000.000100", receivedAt: new Date(T0 + 86_400_000).toISOString() })];
  const setup = setupServices({
    fetch: plane.fetch,
    repositories: fakeRepositories({ "acme/payments-api": { files: { "go.mod": "module example.com/pay" } } }),
    slackChannels: fakeSlackChannels([{ id: "C0PAY00001", name: "payments", isPrivate: false, isMember: true }]),
    alerts: fakeAlerts({ confirmAfterPolls: 0, budgetUsd: FIRST_RUN_BUDGET_USD }),
    stackOutputs: finishStackOutputs,
    configDir: projects,
  });
  const base: InitCliDependencies = {
    cliInvocation: { published: false, cliPath: "/opt/agentx/dist/main.js" },
    deploy: { identity: { get: async () => ({ account: "123456789012", arn: HOLDER }) }, store, secrets, deployer },
    initSecrets: secrets,
    checks: passingChecks(),
    // Spec 048 FR-015: no test reaches IAM for the account's alias.
    accountAlias: async () => undefined,
    github,
    slack: fakeSlackApi(),
    cloudFormation: fakeCloudFormation({ parameters: SIGN_IN_PARAMETERS }),
    stackStatus: { status: async () => undefined },
    fetch: slackIngressFetch({ signingSecret: TEST_SIGNING_SECRET }),
    // The terminal path's browser, for the runs here that do not use --ui. No run ever reaches
    // the real openSystemBrowser.
    openBrowser: browserThatCreatesGitHubApp([]),
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    processEnv: {},
    setup,
  };
  const run = (argv: string[], overrides: Partial<InitCliDependencies> = {}) =>
    executeCli(["--env", "staging", "init", "--release", release, "--region", "us-east-1", ...argv], {
      stdout: { write: (text: string) => out.push(text) },
      stderr: { write: (text: string) => err.push(text) },
      environments: { home },
      init: { ...base, ...overrides },
    });
  /** Runs `--ui` with an operator who answers `script` on the page and types nothing. */
  const runUi = async (script: (string | boolean)[], argv: string[] = []) => {
    const operator = fakeWizardOperator(script);
    const code = await run(["--ui", ...argv], { openBrowser: operator.open });
    await operator.settled();
    return { code, operator };
  };
  return {
    store, secrets, deployer, github, plane, setup, out, err, home, base, run, runUi, release,
    /** Moves the harness's own fake clock, the way the default `sleep` does; a test that overrides
     * `sleep` to intercept one particular wait calls this for every other one, so the run's own
     * polling loops still behave exactly as the default `sleep` would. */
    advance: (ms: number) => { clock += ms; },
    printed: () => `${out.join("")}${err.join("")}`,
    /** The terminal, every SSM value, this machine's environment cache, and the project files the
     * finishing steps wrote. */
    everywhere: async () => [
      out.join(""), err.join(""), ...store.values.values(), await readFile(environmentCachePath(home, "staging"), "utf8").catch(() => ""),
      await readFile(initLogPath(home, "staging"), "utf8").catch(() => ""),
      ...(await Promise.all((await readdir(projects)).map((name) => readFile(join(projects, name), "utf8")))),
    ].join("\n"),
  };
}
