// agentx init end to end through executeCli, with every AWS, GitHub, Slack, browser and clock
// dependency injected. Nothing here reaches AWS, GitHub or Slack; the GitHub manifest listener is
// real, on 127.0.0.1.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentXError, environmentStackName } from "@agentx/contracts";
import { CDK_CONSTRUCT_IDS } from "../../packages/cli/src/deploy/cdk-engine.js";
import { prepareDeployment } from "../../packages/cli/src/deploy/commands.js";
import { executeCli } from "../../packages/cli/src/main.js";
import { environmentCachePath } from "../../packages/cli/src/environments/cache.js";
import { lockParameterName } from "../../packages/cli/src/environments/lock.js";
import { readEnvironmentSettings, settingsParameterName } from "../../packages/cli/src/environments/settings.js";
import { INIT_STEP_IDS, installAnswersParameterName, installProgressParameterName, readInstallAnswers, readInstallProgress } from "../../packages/cli/src/init/install-state.js";
import { DEFAULT_CLASSIFIER_MODEL, DEFAULT_ORCHESTRATOR_MODEL, DEFAULT_WORKER_MODEL } from "../../packages/cli/src/init/answers.js";
import { initSteps, type InitCliDependencies } from "../../packages/cli/src/init/commands.js";
import { estimateMonthlyCost, suggestedBudgetUsd } from "../../packages/cli/src/init/cost.js";
import { markOperatorStop } from "../../packages/cli/src/init/stop.js";
import { INSTALL_STEP_ORDER } from "../../packages/cli/src/init/ui/journey.js";
import {
  allStackOutputs, browserThatCreatesGitHubApp, fakeGitHubApi, fakeSlackApi, HOLDER, memoryInitSecrets, passingChecks, scriptedDeployer, scriptedPrompter,
  settingsScript, slackIngressFetch, T0, TEST_BOT_TOKEN, TEST_CLI_INVOCATION, TEST_PRIVATE_KEY, TEST_SIGNING_SECRET,
} from "../support/init-fakes.js";
import { stagingSettings } from "../support/environment-fixtures.js";
import { SIGN_IN_PARAMETERS, fakeCloudFormation } from "../support/fake-cloudformation.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";
import type { SetupServices } from "../../packages/cli/src/setup/services.js";
import { ADMIN_EMAIL, FOUNDATION_OUTPUTS, fakeAlerts, fakeCognito, fakeControlPlane, fakeRepositories, fakeSlackChannels, setupServices, turn } from "../support/setup-fakes.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const tmp = async (prefix: string) => { const dir = await mkdtemp(join(tmpdir(), prefix)); dirs.push(dir); return dir; };
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

async function releaseDir(version = "1.2.3", regions = ["us-east-1"]): Promise<string> {
  const dir = await tmp("agentx-init-release-");
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
    schemaVersion: 1, version, gitCommit: "a".repeat(40), environmentPlaceholder: "qqenv-placeholderqq", templates, packages: [],
    images: { worker: `public.ecr.aws/agentx/worker@sha256:${"a".repeat(64)}`, slack: `public.ecr.aws/agentx/slack@sha256:${"b".repeat(64)}` },
  }));
  return dir;
}

/** What the finishing steps read from the stacks: every deployed output, with the foundation's EC2
 * worker outputs as the real foundation stack has them (allStackOutputs's are placeholders). */
async function finishStackOutputs(name: string): Promise<Record<string, string> | undefined> {
  const outputs = allStackOutputs()[name];
  return outputs === undefined || name !== environmentStackName("staging", "foundation") ? outputs : { ...outputs, ...FOUNDATION_OUTPUTS };
}

async function harness(options: { releaseVersion?: string; regions?: string[] } = {}) {
  let clock = T0;
  const store = new MemoryParameterStore();
  // The control plane creates agentx/<env>/slack with a placeholder; the fake deployer does not, so it exists up front.
  const secrets = memoryInitSecrets({ "agentx/staging/slack": JSON.stringify({ botToken: "unset", signingSecret: "placeholder" }) });
  const deployer = scriptedDeployer(allStackOutputs());
  const github = fakeGitHubApi();
  const opened: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const home = await tmp("agentx-init-home-");
  const release = await releaseDir(options.releaseVersion, options.regions);
  // F15: the finishing steps' services, so every run that completes does so without AWS, GitHub or
  // Slack. The fake Slack app (fakeSlackApi) is team T0TEAM with bot U0BOT; the turn is received a
  // day after T0, so it counts whenever the run's fake clock starts the e2e step.
  const plane = fakeControlPlane();
  plane.turns = [turn({ subject: "T0TEAM/C0PAY00001/1790000000.000100", receivedAt: new Date(T0 + 86_400_000).toISOString() })];
  const alerts = fakeAlerts({ confirmAfterPolls: 0, budgetUsd: FIRST_RUN_BUDGET_USD });
  const cognito = fakeCognito();
  const setup = setupServices({
    cognito,
    fetch: plane.fetch,
    repositories: fakeRepositories({ "acme/payments-api": { files: { "go.mod": "module example.com/pay" } } }),
    slackChannels: fakeSlackChannels([{ id: "C0PAY00001", name: "payments", isPrivate: false, isMember: true }]),
    alerts,
    stackOutputs: finishStackOutputs,
    configDir: await tmp("agentx-projects-"),
  });
  const deps: InitCliDependencies = {
    cliInvocation: TEST_CLI_INVOCATION,
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
    openBrowser: browserThatCreatesGitHubApp(opened),
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    processEnv: {},
    setup,
  };
  /** Without --region: the region comes from the prompt's default (or --yes refuses). */
  const runWithoutRegion = (argv: string[], overrides: Partial<InitCliDependencies> = {}) =>
    executeCli(["--env", "staging", "init", "--release", release, ...argv], {
      stdout: { write: (text: string) => out.push(text) },
      stderr: { write: (text: string) => err.push(text) },
      environments: { home },
      init: { ...deps, ...overrides },
    });
  const run = (argv: string[], overrides: Partial<InitCliDependencies> = {}) => runWithoutRegion(["--region", "us-east-1", ...argv], overrides);
  /** Issue 152: no --release (and no --region unless argv gives one), as a source-built agentx runs with --engine cdk --source. */
  const runWithoutRelease = (argv: string[], overrides: Partial<InitCliDependencies> = {}) =>
    executeCli(["--env", "staging", "init", ...argv], {
      stdout: { write: (text: string) => out.push(text) },
      stderr: { write: (text: string) => err.push(text) },
      environments: { home },
      init: { ...deps, ...overrides },
    });
  return { store, secrets, deployer, github, opened, out, err, home, release, plane, alerts, cognito, setup, deps, run, runWithoutRegion, runWithoutRelease,
    printed: () => `${out.join("")}${err.join("")}`,
    /** Where the output stands now, and everything printed since (one run's output, on a rerun). */
    mark: () => ({ out: out.length, err: err.length }),
    printedSince: (mark: { out: number; err: number }) => `${out.slice(mark.out).join("")}${err.slice(mark.err).join("")}`,
  };
}

type Harness = Awaited<ReturnType<typeof harness>>;

/** Everything a secret must never reach: the printed output, every SSM value, and this machine's
 * environment cache file (F21). */
async function everywhereButSecrets(h: Harness): Promise<string> {
  const cache = await readFile(environmentCachePath(h.home, "staging"), "utf8").catch(() => "");
  return [h.printed(), ...h.store.values.values(), cache].join("\n");
}

// The settings a first run answers (spec 048 FR-020: your email, the owner, the install name and
// the app name; yes to the Advanced settings, every default taken but alerts to the ops address),
// then the plan.
const FIRST_RUN = [...settingsScript({ email: ADMIN_EMAIL, owner: "acme", advanced: { alertEmail: "ops@example.com" } }), true];
// FIRST_RUN's answers for a run with --engine cdk, whose settings form leaves the engine out.
const CDK_FIRST_RUN = [...settingsScript({ email: ADMIN_EMAIL, owner: "acme", flags: { engine: "cdk" }, advanced: { alertEmail: "ops@example.com" } }), true];
// The Slack step: installed, the token, the signing secret, "the right bot?"; then the Slack
// service step's "Request URL Verified?" (Task 9's fix round added both confirms).
const SLACK = ["installed", "1111111111.2222222222222", "fedcba9876543210fedcba9876543210", TEST_SIGNING_SECRET, TEST_BOT_TOKEN, true, true];
// Developer sign-in is part of the approved plan, so its step asks nothing.
const SIGNIN: Array<string | boolean> = [];
// The finishing steps (F15): repository; project name; use the proposed commands; channel; the
// three connector offers; "did the test alarm arrive?". Your email comes from the settings (spec 048 FR-020).
const FINISH = ["acme/payments-api", "", true, "payments", false, false, false, true];
// The budget FIRST_RUN's all-default models produce: the estimate plus 20%, one source with cost.ts.
const FIRST_RUN_BUDGET_USD = suggestedBudgetUsd(estimateMonthlyCost({ orchestrator: DEFAULT_ORCHESTRATOR_MODEL, classifier: DEFAULT_CLASSIFIER_MODEL, worker: DEFAULT_WORKER_MODEL }));
// A GitHub App made beforehand, and both Slack secrets, so --yes needs no prompt at all.
const UNATTENDED = [
  "--yes", "--no-browser", "--github-account", "acme", "--github-app-id", "424242", "--github-installation-id", "777",
  "--github-private-key-env", "GH_KEY", "--slack-bot-token-env", "BOT", "--slack-signing-secret-env", "SIGNING",
  "--slack-client-id", "1111111111.2222222222222", "--slack-client-secret-env", "SLACK_CLIENT_SECRET",
  // F15: the finishing steps' answers.
  "--admin-email", ADMIN_EMAIL, "--repository", "acme/payments-api", "--channel", "payments", "--connectors", "none",
];
/** `argv` without `flag` and its value. */
const without = (argv: readonly string[], flag: string): string[] => argv.filter((_, index) => argv[index] !== flag && argv[index - 1] !== flag);
const UNATTENDED_ENV = { GH_KEY: TEST_PRIVATE_KEY, BOT: TEST_BOT_TOKEN, SIGNING: TEST_SIGNING_SECRET, SLACK_CLIENT_SECRET: "fedcba9876543210fedcba9876543210" };
const WEBHOOK = "https://events.pagerduty.com/integration/0123SECRETintegrationKEY/enqueue";

describe("agentx init", () => {
  it("lists its steps in the recorded order", () => {
    expect(initSteps({ github: fakeGitHubApi(), slack: fakeSlackApi() }).map((step) => step.id)).toEqual([...INSTALL_STEP_ORDER]);
  });

  const YES = ["--yes", "--admin-email", ADMIN_EMAIL, "--alert-email", "ops@example.com", "--github-account", "acme", "--channel", "payments"];
  it.each<[string, string[], Partial<InitCliDependencies>, string]>([
    ["model access and the Anthropic form", [], { checks: passingChecks({ converse: async () => { throw Object.assign(new Error("Model use case details have not been submitted for this account"), { name: "ResourceNotFoundException" }); } }) }, "one-time usage form"],
    // "app name" alone also matches the plan's "an app named", which a run that never checked the length printed.
    ["a name too long", ["--github-app-name", "x".repeat(35)], {}, "the app name must be at most 34 characters"],
    ["a clashing stack", [], { stackStatus: { status: async (name) => (name === environmentStackName("staging", "access") ? "CREATE_COMPLETE" : undefined) } }, "already has stacks or settings"],
    ["the GitHub owner", [], { github: { ...fakeGitHubApi(), owner: async () => undefined } }, "GitHub has no organization or user named acme"],
    ["the budget value", ["--budget", "12abc"], {}, "--budget must be a whole number"],
    ["the email address", ["--alert-email", "not-an-email"], {}, "is not an email address"],
  ])("SC-009: %s is reported before anything is created", async (_item, argv, overrides, words) => {
    const h = await harness();
    expect(await h.run([...YES, ...argv], overrides)).not.toBe(0);
    expect(h.printed()).toContain(words);
    expect(h.deployer.requests).toEqual([]);
    expect(h.store.values.has(installAnswersParameterName("staging"))).toBe(false);
    expect(h.github.conversions).toEqual([]);
  });

  it("Fix round 1: --yes with the GitHub owner lookup throwing prints exactly the clash check's own line", async () => {
    const h = await harness();
    const github = { ...fakeGitHubApi(), owner: async () => { throw new Error("GitHub owner lookup failed with HTTP 403"); } };
    expect(await h.run([...YES], { github })).not.toBe(0);
    const line = h.printed().split("\n").find((each) => each.startsWith("- could not check the GitHub owner"));
    expect(line).toBe("- could not check the GitHub owner acme (GitHub owner lookup failed with HTTP 403); check your network and run agentx init again");
  });

  it("FR-028: an app made beforehand (--github-app-id) is this install's own, so its name is no clash", async () => {
    const h = await harness();
    const github = { ...h.github, appBySlug: async () => ({ owner: { login: "acme" } }) };
    expect(await h.run([...UNATTENDED, "--alert-email", "ops@example.com"], { processEnv: UNATTENDED_ENV, github })).toBe(0);
    expect(h.printed()).not.toContain("GitHub already has an app named");
  });

  it("stops after the step --stop-after names, records it, and says how to finish", async () => {
    const h = await harness();
    expect(await h.run(["--stop-after", "developer-signin"], { prompter: scriptedPrompter([...FIRST_RUN, ...SLACK, ...SIGNIN]) })).toBe(0);
    const progress = await readInstallProgress(h.store, "staging");
    expect(progress?.steps["developer-signin"]?.status).toBe("done");
    expect(progress?.steps["admin-user"]).toBeUndefined();
    expect(h.printed()).toContain("Stopped after the developer-signin step, as --stop-after asked. Run agentx init --env staging --region us-east-1 again to finish.");
    expect(h.store.values.has(lockParameterName("staging"))).toBe(false);
  });

  it("finishes a run --stop-after cut short on the next plain run, from the step after the one it named", async () => {
    const h = await harness();
    expect(await h.run(["--stop-after", "developer-signin"], { prompter: scriptedPrompter([...FIRST_RUN, ...SLACK, ...SIGNIN]) })).toBe(0);
    const mark = h.mark();
    const prompter = scriptedPrompter([...FINISH]);
    expect(await h.run(["--json"], { prompter })).toBe(0);
    expect(prompter.remaining()).toBe(0);
    const result = (JSON.parse(h.printedSince(mark).split("\n").find((line) => line.startsWith("{\"ok\"")) ?? "{}") as { data?: { status: string; ran: string[]; skipped: string[]; stoppedAfter?: string } }).data;
    expect(result?.status).toBe("complete");
    expect(result?.ran).toContain("admin-user");
    const beforeStop = ["access", "core", "github-app", "control-plane", "slack-app", "slack-service", "developer-signin"];
    expect(result?.skipped).toEqual(expect.arrayContaining(beforeStop));
    expect(result?.ran.filter((id) => beforeStop.includes(id))).toEqual([]);
    expect(result?.stoppedAfter).toBeUndefined();
  });

  it("spec 048 FR-020: asks the GitHub owner's type only when GitHub cannot say, and says why", async () => {
    const h = await harness();
    // GitHub cannot answer the settings' lookup; by the answer checks (spec 048 FR-028) it answers
    // again. Fix round 1: keyed on the owner-type question being answered, not on a lookup count,
    // so an unrelated extra lookup elsewhere would not break this test for the wrong reason.
    let settingsAnswered = false;
    const github = { ...fakeGitHubApi(), owner: async () => { if (!settingsAnswered) throw new Error("GitHub owner lookup failed with HTTP 403"); return { login: "acme", type: "User" as const }; } };
    // The settings, then the owner's type (a personal account), then no to the plan.
    const base = scriptedPrompter([...FIRST_RUN.slice(0, -1), "user", false]);
    const prompter: typeof base = {
      ...base,
      async choose(question, choices, options) {
        const answer = await base.choose(question, choices, options);
        if (question === "Is acme an organization or a personal account?") settingsAnswered = true;
        return answer;
      },
    };
    expect(await h.run([], { prompter, github })).not.toBe(0);
    expect(prompter.asked.at(-2)).toBe("Is acme an organization or a personal account?");
    expect(h.printed()).toContain("Could not look up acme on GitHub (GitHub owner lookup failed with HTTP 403); asking instead.");
    expect(h.printed()).toContain("install declined; nothing was created");
  });

  it("refuses --stop-after with --export, which runs no init step", async () => {
    const h = await harness();
    expect(await h.run(["--export", join(h.home, "bundle"), "--stop-after", "developer-signin"], { prompter: scriptedPrompter([]) })).not.toBe(0);
    expect(h.printed()).toContain("--stop-after cannot be used with --export");
  });

  it("refuses a --stop-after that names no step", async () => {
    const h = await harness();
    expect(await h.run(["--stop-after", "everything"], { prompter: scriptedPrompter([]) })).not.toBe(0);
    expect(h.printed()).toContain("--stop-after");
  });

  it("a first run asks, checks, shows the plan, deploys every stack, creates both apps, writes settings and the local cache, and ends on a threaded Slack reply", async () => {
    // The harness's finishing services (F15): one repository, the payments channel, a confirmed
    // alert subscription and the budget FIRST_RUN takes (F16, the estimate plus 20%), and a turn received a day later.
    const h = await harness();
    const prompter = scriptedPrompter([...FIRST_RUN, ...SLACK, ...SIGNIN, ...FINISH]);
    expect(await h.run([], { prompter })).toBe(0);
    expect(prompter.remaining()).toBe(0);
    expect(h.plane.registered).toHaveLength(1);
    expect(h.plane.bindings).toEqual(["T0TEAM/C0PAY00001"]);
    expect(h.deployer.requests.map((request) => request.part)).toEqual(["access", "foundation", "identity", "control-plane", "runtime", "slack"]);
    const progress = await readInstallProgress(h.store, "staging");
    expect(INIT_STEP_IDS.every((id) => progress?.steps[id]?.status === "done")).toBe(true);
    expect((await readEnvironmentSettings(h.store, "staging"))?.engine).toBe("templates");
    await expect(stat(environmentCachePath(h.home, "staging"))).resolves.toBeDefined();
    expect(h.store.values.has(lockParameterName("staging"))).toBe(false);
    const printed = h.printed();
    expect(printed).toContain("Estimated monthly total");
    // The manual next steps of earlier installs (create the admin user, agentx login, register
    // and bind a project) are gone: init did them.
    expect(printed).toContain("AgentX environment staging is ready.\n  Talk to it: mention @agentx in #payments (project payments-api).");
    expect(printed).not.toContain("aws cognito-idp admin-create-user");
    expect(printed).toContain("  Developers sign in with: node /opt/agentx/dist/main.js login https://abc123.execute-api.us-east-1.amazonaws.com\n");
    const everywhere = await everywhereButSecrets(h);
    expect(everywhere).toContain("abc123.execute-api");
    expect(everywhere).not.toContain("fedcba9876543210fedcba9876543210");
    for (const secret of [TEST_PRIVATE_KEY.split("\n")[1]!, TEST_BOT_TOKEN, TEST_SIGNING_SECRET, h.secrets.values.get("agentx/staging/callback-signing-key")!]) {
      expect(secret.length).toBeGreaterThan(10);
      expect(everywhere).not.toContain(secret);
    }
  });

  it("a resume that finishes after the alert confirmation wait still ends with the developer sign-in command", async () => {
    const h = await harness();
    const alerts = fakeAlerts({ confirmAfterPolls: 1_000, budgetUsd: FIRST_RUN_BUDGET_USD });
    const setup = { ...h.setup, alerts };
    // Everything up to the alerts step, which waits for the subscription to be confirmed.
    expect(await h.run([], { prompter: scriptedPrompter([...FIRST_RUN, ...SLACK, ...SIGNIN, ...FINISH.slice(0, -1)]), setup })).toBe(0);
    expect((await readInstallProgress(h.store, "staging"))?.steps.alerts?.status).toBe("waiting");
    alerts.confirmAll();
    const mark = h.mark();
    const prompter = scriptedPrompter([true]);
    expect(await h.run([], { prompter, setup })).toBe(0);
    expect(prompter.remaining()).toBe(0);
    const resumed = h.printedSince(mark);
    expect(resumed).toContain("already done: Turn on developer sign-in");
    expect(resumed).toContain("AgentX environment staging is ready.");
    expect(resumed).toContain("  Developers sign in with: node /opt/agentx/dist/main.js login https://abc123.execute-api.us-east-1.amazonaws.com\n");
  });

  it("a rerun after the e2e check failed repeats only that check: no second admin and no second project", async () => {
    const h = await harness();
    const answered = h.plane.turns;
    h.plane.turns = [turn({ subject: "T0TEAM/C0PAY00001/1790000000.000100", receivedAt: new Date(T0 + 86_400_000).toISOString(), disposition: "error" })];
    expect(await h.run([], { prompter: scriptedPrompter([...FIRST_RUN, ...SLACK, ...SIGNIN, ...FINISH]) })).not.toBe(0);
    expect(h.printed()).toContain("then run agentx --env staging init again");
    h.plane.turns = answered;
    const mark = h.mark();
    const prompter = scriptedPrompter([]);
    expect(await h.run([], { prompter })).toBe(0);
    const rerun = h.printedSince(mark);
    expect(rerun).toContain("already done: Sign in to AgentX");
    expect(rerun).toContain("already done: Set up your first project");
    expect(rerun).toContain("AgentX environment staging is ready.");
    expect(h.cognito.created).toEqual([ADMIN_EMAIL]);
    expect(h.plane.registered).toHaveLength(1);
    expect(h.plane.bindings).toEqual(["T0TEAM/C0PAY00001"]);
  });

  it("resumes at the step that failed and never creates a second GitHub App", async () => {
    const h = await harness();
    h.deployer.fail.set(environmentStackName("staging", "control-plane"), new Error("Resource limit exceeded"));
    expect(await h.run([], { prompter: scriptedPrompter(FIRST_RUN) })).not.toBe(0);
    expect(h.printed()).toContain('init stopped at "Start the AgentX service": Resource limit exceeded. Run agentx init --env staging --region us-east-1 again to continue from this step.');
    expect(h.store.values.has(lockParameterName("staging"))).toBe(false);
    h.deployer.fail.clear();
    h.deployer.requests.length = 0;
    expect(await h.run([], { prompter: scriptedPrompter([...SLACK, ...SIGNIN, ...FINISH]) })).toBe(0);
    expect(h.printed()).toContain("Resuming the install of environment staging.");
    expect(h.github.conversions).toHaveLength(1);
    expect(h.deployer.requests.map((request) => request.part)).toEqual(["control-plane", "runtime", "slack"]);
  });

  // Fix round 1: the terminal path has no page and no onStepFailure hook, so a step's own stop
  // (markOperatorStop) prints and stops exactly as any other step error does; only the page's
  // own onStepFailure/runInit catch treat it differently (spec 048 FR-060 fix, Plan ruling 8).
  it("spec 048 FR-060 fix: the terminal path is unaffected by a step's own stop", async () => {
    const h = await harness();
    h.deployer.fail.set(environmentStackName("staging", "control-plane"), markOperatorStop(new Error("the person chose not to continue")));
    expect(await h.run([], { prompter: scriptedPrompter(FIRST_RUN) })).not.toBe(0);
    expect(h.printed()).toContain('init stopped at "Start the AgentX service": the person chose not to continue. Run agentx init --env staging --region us-east-1 again to continue from this step.');
  });

  it("changes nothing when run again after it finished", async () => {
    const h = await harness();
    await h.run([], { prompter: scriptedPrompter([...FIRST_RUN, ...SLACK, ...SIGNIN, ...FINISH]) });
    const before = h.store.values.get(installProgressParameterName("staging"));
    const settingsBefore = h.store.values.get(settingsParameterName("staging"));
    h.deployer.requests.length = 0;
    expect(await h.run([], { prompter: scriptedPrompter([]) })).toBe(0);
    expect(h.deployer.requests).toEqual([]);
    expect(h.store.values.get(installProgressParameterName("staging"))).toBe(before);
    expect(h.store.values.get(settingsParameterName("staging"))).toBe(settingsBefore);
    expect(h.printed()).toContain("already done: Start the Slack connection");
  });

  it("stops before creating anything when a model cannot be used", async () => {
    const h = await harness();
    const denied = Object.assign(new Error("Model use case details have not been submitted for this account."), { name: "AccessDeniedException" });
    expect(await h.run([], { prompter: scriptedPrompter(FIRST_RUN.slice(0, -1)), checks: passingChecks({ converse: async () => { throw denied; } }) })).toBe(2);
    expect(h.printed()).toContain("init cannot start; nothing was created");
    expect(h.store.calls.filter((call) => call.op === "put")).toEqual([]);
    expect(h.deployer.requests).toEqual([]);
  });

  it("waits for a Slack admin's approval, exits 0, and continues on the next run", async () => {
    const h = await harness();
    expect(await h.run(["--json"], { prompter: scriptedPrompter([...FIRST_RUN, "approval"]) })).toBe(0);
    expect(JSON.parse(h.out.join(""))).toMatchObject({ ok: true, data: { status: "waiting", step: "slack-app" } });
    expect(await h.run([], { prompter: scriptedPrompter([...SLACK, ...SIGNIN, ...FINISH]) })).toBe(0);
    expect((await readInstallProgress(h.store, "staging"))?.steps["slack-service"]?.status).toBe("done");
  });

  it("carries on when no browser can be opened: GitHub takes the pasted address, Slack just prints its link", async () => {
    const h = await harness();
    const tried: string[] = [];
    // xdg-open missing (CloudShell, SSH hosts, containers), or Windows, where openSystemBrowser throws AUTH_REQUIRED.
    const openBrowser = async (url: string) => { tried.push(url); throw Object.assign(new Error("spawn xdg-open ENOENT"), { code: "ENOENT" }); };
    const prompter = scriptedPrompter([...FIRST_RUN, "0123456789abcdef0123", ...SLACK, ...SIGNIN, ...FINISH]);
    expect(await h.run([], { prompter, openBrowser })).toBe(0);
    expect(prompter.remaining()).toBe(0);
    expect(h.github.conversions).toEqual(["0123456789abcdef0123"]);
    expect(tried.some((url) => url.startsWith("https://api.slack.com/apps?new_app=1"))).toBe(true);
    expect(h.printed()).toContain("could not open a browser; open the address above (or pass --no-browser)");
    expect(h.printed()).not.toContain("Refresh your AWS session");
    expect((await readInstallProgress(h.store, "staging"))?.steps["slack-service"]?.status).toBe("done");
  });

  it("defaults the region to AWS_REGION, then AWS_DEFAULT_REGION, when the release covers it", async () => {
    const regions = ["us-east-1", "us-west-2"];
    // Taking the region prompt's default ("") then --resume with nothing stored names the region it looked in.
    const lookedIn = async (processEnv: NodeJS.ProcessEnv) => {
      const h = await harness({ regions });
      const prompter = scriptedPrompter([""]);
      expect(await h.runWithoutRegion(["--resume"], { prompter, processEnv })).toBe(2);
      expect(prompter.asked).toEqual(["AWS region"]);
      return /resume in account 123456789012 \(([a-z0-9-]+)\)/.exec(h.printed())?.[1];
    };
    expect(await lookedIn({ AWS_REGION: "us-west-2", AWS_DEFAULT_REGION: "us-east-1" })).toBe("us-west-2");
    expect(await lookedIn({ AWS_DEFAULT_REGION: "us-west-2" })).toBe("us-west-2");
    expect(await lookedIn({ AWS_REGION: "eu-west-1", AWS_DEFAULT_REGION: "us-west-2" })).toBe("us-west-2");
    expect(await lookedIn({ AWS_REGION: "eu-west-1" })).toBe("us-east-1");
    expect(await lookedIn({})).toBe("us-east-1");
  });

  it("under --yes, refuses to guess the region", async () => {
    const h = await harness();
    expect(await h.runWithoutRegion([...UNATTENDED, "--alert-email", "ops@example.com"], { processEnv: { ...UNATTENDED_ENV, AWS_REGION: "us-east-1" } })).toBe(2);
    expect(h.printed()).toContain("with --yes, pass --region <region>");
    expect(h.store.calls).toEqual([]);
  });

  // Init deploys through agentx deploy's engine, but its errors must never send the engineer to agentx deploy or an answers file.
  it("reports an engine error in a deploy step without mentioning agentx deploy or an answers file", async () => {
    const h = await harness();
    h.deployer.fail.set(environmentStackName("staging", "access"), agentXError("CONFIG_INVALID", "stack agentx-staging-access failed to create earlier and must be deleted before it can be deployed again (aws cloudformation delete-stack --stack-name agentx-staging-access --region us-east-1)"));
    expect(await h.run([], { prompter: scriptedPrompter(FIRST_RUN) })).toBe(2);
    const printed = h.printed();
    expect(printed).toContain('init stopped at "Set up AWS permissions": stack agentx-staging-access failed to create earlier');
    expect(printed).toContain("Run agentx init --env staging --region us-east-1 again to continue from this step.");
    expect(printed).not.toContain("agentx deploy");
    expect(printed).not.toContain("answers file");
  });

  it("refuses to resume with a different answer", async () => {
    const h = await harness();
    await h.run([], { prompter: scriptedPrompter([...FIRST_RUN, "approval"]) });
    expect(await h.run(["--orchestrator-model", "zai.glm-4.7"], { prompter: scriptedPrompter([]) })).toBe(2);
    expect(h.printed()).toContain("--orchestrator-model zai.glm-4.7 differs from what this install started with");
  });

  it("refuses the deployment adopted with fixed stack names, and an environment installed without init", async () => {
    const legacy = await harness();
    await legacy.store.put(settingsParameterName("staging"), JSON.stringify({ ...stagingSettings, naming: "legacy" }));
    expect(await legacy.run([], { prompter: scriptedPrompter([]) })).toBe(2);
    expect(legacy.printed()).toContain("environment staging is the deployment adopted with fixed stack names; agentx init cannot install over it");

    const deployed = await harness();
    await deployed.store.put(settingsParameterName("staging"), JSON.stringify(stagingSettings));
    expect(await deployed.run([], { prompter: scriptedPrompter([]) })).toBe(2);
    expect(deployed.printed()).toContain("environment staging is already installed, but not by agentx init");
  });

  it("with --resume and nothing to resume, says how to start", async () => {
    const h = await harness();
    expect(await h.run(["--resume"], { prompter: scriptedPrompter([]) })).toBe(2);
    expect(h.printed()).toContain("there is no install of environment staging to resume in account 123456789012 (us-east-1); run agentx init without --resume to start one");
  });

  it("runs with no prompts at all under --yes and flags, with a GitHub App made beforehand", async () => {
    const h = await harness();
    const code = await h.run([...UNATTENDED, "--alert-email", "ops@example.com"], { processEnv: UNATTENDED_ENV });
    expect(code).toBe(0);
    expect(h.github.conversions).toEqual([]);
    expect(h.opened).toEqual([]);
    expect((await readInstallProgress(h.store, "staging"))?.github?.installationId).toBe("777");
    // The plan is printed even though --yes answers its question.
    expect(h.printed()).toContain("Estimated monthly total");
    // The finishing steps took their answers from the flags, and --connectors none offered nothing.
    expect(h.plane.bindings).toEqual(["T0TEAM/C0PAY00001"]);
    expect((await readInstallProgress(h.store, "staging"))?.connectors ?? []).toEqual([]);
    expect(h.printed()).toContain("AgentX environment staging is ready.");
    expect(h.printed()).toContain("No connectors yet.");
  });

  it("prints the ready message in --json under --yes", async () => {
    const h = await harness();
    expect(await h.run([...UNATTENDED, "--alert-email", "ops@example.com", "--json"], { processEnv: UNATTENDED_ENV })).toBe(0);
    const data = (JSON.parse(h.out.join("")) as { data: { status: string; ready?: string } }).data;
    expect(data.status).toBe("complete");
    expect(data.ready).toContain("AgentX environment staging is ready.");
    expect(data.ready).toContain("Developers sign in with: node /opt/agentx/dist/main.js login https://abc123.execute-api.us-east-1.amazonaws.com");
  });

  it("under --yes without --connectors, adds none and says how to add them later", async () => {
    const h = await harness();
    const argv = UNATTENDED.filter((_, index) => UNATTENDED[index] !== "--connectors" && UNATTENDED[index - 1] !== "--connectors");
    expect(argv).not.toContain("--connectors");
    expect(await h.run([...argv, "--alert-email", "ops@example.com"], { processEnv: UNATTENDED_ENV })).toBe(0);
    expect(h.printed()).toContain("No connectors added; add them later with agentx --env staging connector add linear|jira|asana");
    expect((await readInstallProgress(h.store, "staging"))?.connectors ?? []).toEqual([]);
    expect(h.printed()).toContain("AgentX environment staging is ready.");
  });

  it("under --yes, a first run refuses before anything is created when a finishing flag is missing, naming it", async () => {
    for (const flag of ["--admin-email", "--channel"]) {
      const h = await harness();
      const argv = without(UNATTENDED, flag);
      expect(await h.run([...argv, "--alert-email", "ops@example.com"], { processEnv: UNATTENDED_ENV })).toBe(2);
      expect(h.printed()).toContain(`agentx init --yes needs ${flag}`);
      expect(h.store.calls.filter((call) => call.op === "put")).toEqual([]);
      expect(h.secrets.values.has("agentx/staging/github-app")).toBe(false);
      expect(h.deployer.requests).toEqual([]);
    }
  });

  it("under --yes, a resume whose admin and channel are recorded needs neither flag", async () => {
    const h = await harness();
    const answered = h.plane.turns;
    h.plane.turns = [turn({ subject: "T0TEAM/C0PAY00001/1790000000.000100", receivedAt: new Date(T0 + 86_400_000).toISOString(), disposition: "error" })];
    expect(await h.run([...UNATTENDED, "--alert-email", "ops@example.com"], { processEnv: UNATTENDED_ENV })).not.toBe(0);
    h.plane.turns = answered;
    const mark = h.mark();
    expect(await h.run(without(without(UNATTENDED, "--admin-email"), "--channel"), { processEnv: UNATTENDED_ENV })).toBe(0);
    const rerun = h.printedSince(mark);
    expect(rerun).not.toContain("needs --");
    expect(rerun).toContain("AgentX environment staging is ready.");
  });

  it("under --yes, a resume that still needs the channel is refused at that step, naming --channel", async () => {
    const h = await harness();
    h.deployer.fail.set(environmentStackName("staging", "control-plane"), new Error("Resource limit exceeded"));
    expect(await h.run([...UNATTENDED, "--alert-email", "ops@example.com"], { processEnv: UNATTENDED_ENV })).not.toBe(0);
    h.deployer.fail.clear();
    const mark = h.mark();
    expect(await h.run(without(UNATTENDED, "--channel"), { processEnv: UNATTENDED_ENV })).not.toBe(0);
    const rerun = h.printedSince(mark);
    expect(rerun).not.toContain("agentx init --yes needs");
    expect(rerun).toContain('init stopped at "Set up your first project"');
    expect(rerun).toContain("with --yes, pass --channel");
    const progress = await readInstallProgress(h.store, "staging");
    expect(progress?.admin?.username).toBe(ADMIN_EMAIL);
    expect(progress?.project?.channelId).toBeUndefined();
  });

  it("under --yes with your own OIDC, needs no --admin-email", async () => {
    const h = await harness();
    const argv = UNATTENDED.filter((_, index) => UNATTENDED[index] !== "--admin-email" && UNATTENDED[index - 1] !== "--admin-email");
    const oidc = ["--identity", "oidc", "--oidc-issuer", "https://login.example.com", "--oidc-audience", "agentx", "--oidc-client-id", "cli", "--admin-claim", "groups", "--admin-values", "agentx-admins"];
    h.deployer.fail.set(environmentStackName("staging", "access"), new Error("stop at access"));
    expect(await h.run([...argv, ...oidc, "--alert-email", "ops@example.com"], { processEnv: UNATTENDED_ENV })).not.toBe(0);
    expect(h.printed()).not.toContain("needs --admin-email");
    expect(h.printed()).toContain("stop at access");
  });

  it("under --yes with your own OIDC and alerts answered by a flag, needs no email at all (spec 048 FR-020)", async () => {
    const h = await harness();
    const argv = without(UNATTENDED, "--admin-email");
    const oidc = ["--identity", "oidc", "--oidc-issuer", "https://login.example.com", "--oidc-audience", "agentx", "--oidc-client-id", "cli", "--admin-claim", "groups", "--admin-values", "agentx-admins"];
    h.deployer.fail.set(environmentStackName("staging", "access"), new Error("stop at access"));
    expect(await h.run([...argv, ...oidc, "--no-alerts"], { processEnv: UNATTENDED_ENV })).not.toBe(0);
    expect(h.printed()).not.toContain("needs an answer");
    expect(h.printed()).not.toContain("needs --admin-email");
    expect(h.printed()).toContain("stop at access");
    const saved = await readInstallAnswers(h.store, "staging");
    expect(saved).toMatchObject({ identity: { mode: "oidc" }, alert: { kind: "none" } });
    expect(saved?.adminEmail).toBeUndefined();
  });

  it("refuses a --connectors typo before asking or deploying anything", async () => {
    const h = await harness();
    const prompter = scriptedPrompter([]);
    expect(await h.run(["--connectors", "lnear"], { prompter })).toBe(2);
    expect(h.printed()).toContain("--connectors lnear is not a connector; use linear, jira, asana or none, separated by commas");
    expect(prompter.asked).toEqual([]);
    expect(h.store.calls).toEqual([]);
    expect(h.deployer.requests).toEqual([]);
  });

  it("writes the first project's file to the global --config-dir", async () => {
    const h = await harness();
    const configDir = await tmp("agentx-config-dir-");
    // Every finishing service but configDir: init fills that one from --config-dir.
    const setup: Partial<SetupServices> = { ...h.setup };
    delete setup.configDir;
    expect(await h.run(["--config-dir", configDir], { prompter: scriptedPrompter([...FIRST_RUN, ...SLACK, ...SIGNIN, ...FINISH]), setup })).toBe(0);
    await expect(stat(join(configDir, "payments-api.yaml"))).resolves.toBeDefined();
  });

  it("refuses --github-app-id without the installation and key flags", async () => {
    const h = await harness();
    expect(await h.run(["--github-app-id", "424242"], { prompter: scriptedPrompter([]) })).toBe(2);
    expect(h.printed()).toContain("--github-app-id, --github-installation-id and --github-private-key-file (or --github-private-key-env) go together");
  });

  it("without --release, a CLI built from source says to pass --release", async () => {
    const out: string[] = [];
    const home = await tmp("agentx-init-home-");
    // Every AWS-facing dependency throws, so a change of order could never reach real AWS clients.
    const unexpected = () => { throw new Error("test setup: AWS must not be called before the release is found"); };
    const code = await executeCli(["--env", "staging", "init", "--region", "us-east-1"], {
      stdout: { write: (t: string) => out.push(t) },
      stderr: { write: (t: string) => out.push(t) },
      environments: { home },
      init: {
        releaseVersion: null,
        deploy: { identity: { get: unexpected }, store: { get: unexpected, put: unexpected, delete: unexpected, list: unexpected }, secrets: { get: unexpected, create: unexpected } },
        initSecrets: { get: unexpected, create: unexpected, put: unexpected, arn: unexpected },
        checks: passingChecks({ converse: unexpected, ec2Quota: unexpected, elasticIps: unexpected }),
        stackStatus: { status: unexpected },
        fetch: unexpected,
        prompter: scriptedPrompter([]),
      },
    });
    expect(code).toBe(2);
    expect(out.join("")).toContain("pass --release <dir>");
    expect(out.join("")).not.toContain("test setup");
  });

  it("prints the completed run as JSON with --json", async () => {
    const h = await harness();
    expect(await h.run(["--json"], { prompter: scriptedPrompter([...FIRST_RUN, ...SLACK, ...SIGNIN, ...FINISH]) })).toBe(0);
    expect(JSON.parse(h.out.join(""))).toMatchObject({
      ok: true,
      data: { status: "complete", env: "staging", resumed: false, controlPlaneUrl: "https://abc123.execute-api.us-east-1.amazonaws.com", ready: expect.stringContaining("AgentX environment staging is ready.") as unknown },
    });
  });

  it("keeps the step failure when removing temporary files fails too", async () => {
    const h = await harness();
    h.deployer.fail.set(environmentStackName("staging", "control-plane"), new Error("Resource limit exceeded"));
    const prepare: InitCliDependencies["prepareDeployment"] = async (input) => ({
      ...(await prepareDeployment(input)),
      cleanup: async () => { throw new Error("directory busy"); },
    });
    expect(await h.run([], { prompter: scriptedPrompter(FIRST_RUN), prepareDeployment: prepare })).not.toBe(0);
    expect(h.printed()).toContain('init stopped at "Start the AgentX service": Resource limit exceeded.');
    expect(h.printed()).toContain("could not remove temporary files: directory busy");
  });

  it("keeps the result when removing temporary files fails after a finished run", async () => {
    const h = await harness();
    const prepare: InitCliDependencies["prepareDeployment"] = async (input) => ({
      ...(await prepareDeployment(input)),
      cleanup: async () => { throw new Error("directory busy"); },
    });
    expect(await h.run([], { prompter: scriptedPrompter([...FIRST_RUN, ...SLACK, ...SIGNIN, ...FINISH]), prepareDeployment: prepare })).toBe(0);
    expect(h.printed()).toContain("AgentX environment staging is ready.");
    expect(h.printed()).toContain("could not remove temporary files: directory busy");
  });

  // F23: InitAnswers only takes x.y.z, so a prerelease would otherwise fail after the plan.
  it("refuses a prerelease release before asking anything", async () => {
    const h = await harness({ releaseVersion: "1.2.3-rc.1" });
    const prompter = scriptedPrompter([]);
    expect(await h.run([], { prompter })).toBe(2);
    expect(h.printed()).toContain("release 1.2.3-rc.1 is a prerelease");
    expect(prompter.asked).toEqual([]);
    expect(h.store.calls).toEqual([]);
  });

  // F7: the cdk --source check runs once, when the answers are known, and before the plan.
  it("refuses the cdk engine without --source before showing the plan", async () => {
    const h = await harness();
    expect(await h.run(["--engine", "cdk"], { prompter: scriptedPrompter(CDK_FIRST_RUN.slice(0, -1)) })).toBe(2);
    expect(h.printed()).toContain("the cdk engine needs --source <a checkout of tag v1.2.3>");
    expect(h.printed()).not.toContain("Estimated monthly total");
    expect(h.store.calls.filter((call) => call.op === "put")).toEqual([]);
  });

  // Issue 152: a source-built agentx with --engine cdk --source needs no release directory.
  describe("a source-built agentx with --engine cdk --source (issue 152)", () => {
    const HEAD = "e".repeat(40);
    const WORKER = `123456789012.dkr.ecr.us-east-1.amazonaws.com/agentx/worker@sha256:${"d".repeat(64)}`;
    const SLACK_IMAGE = `123456789012.dkr.ecr.us-east-1.amazonaws.com/agentx/slack@sha256:${"e".repeat(64)}`;
    const IMAGES = ["--worker-image", WORKER, "--slack-image", SLACK_IMAGE];
    const MANIFEST_URL = "https://github.com/PrepLabsAI/AgentX/releases/download/v1.4.0/release.json";
    /** A clean checkout at tag v1.4.0. */
    const taggedSource = { async run(_command: string, args: string[]) {
      if (args[0] === "status") return { stdout: "" };
      if (args[0] === "rev-parse") return { stdout: `${HEAD}\n` };
      return { stdout: "v1.4.0\n" };
    } };
    /** GitHub serves `manifest` (or nothing) for the tag; every other address goes to `inner`. */
    const githubRelease = (inner: typeof fetch, manifest?: string): typeof fetch & { github: string[] } => {
      const requested: string[] = [];
      const handler = async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const target = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
        if (!target.startsWith("https://github.com/PrepLabsAI/AgentX/releases/")) return inner(url, init);
        requested.push(target);
        return target === MANIFEST_URL && manifest !== undefined ? new Response(manifest, { status: 200 }) : new Response("Not Found", { status: 404 });
      };
      return Object.assign(handler, { github: requested });
    };
    const publishedManifest = JSON.stringify({
      schemaVersion: 1, version: "1.4.0", gitCommit: HEAD, environmentPlaceholder: "qqenv-placeholderqq",
      templates: ["us-east-1", "us-west-2"].map((region) => ({ region, part: "access", file: `templates/${region}/access.template.json`, sha256: "0".repeat(64) })),
      packages: [], images: { worker: `public.ecr.aws/agentx/agentx-worker@sha256:${"b".repeat(64)}`, slack: `public.ecr.aws/agentx/agentx-slack@sha256:${"c".repeat(64)}` },
    });

    it("installs with both image flags and no release: the version is the tag's, and nothing is downloaded", async () => {
      const h = await harness();
      const fetchWithGitHub = githubRelease(h.deps.fetch as typeof fetch);
      const prompter = scriptedPrompter([...CDK_FIRST_RUN, ...SLACK, ...SIGNIN, ...FINISH]);
      const code = await h.runWithoutRelease(["--region", "us-east-1", "--engine", "cdk", "--source", "/src", ...IMAGES], {
        releaseVersion: null, fetch: fetchWithGitHub, prompter, deploy: { ...h.deps.deploy, commandRunner: taggedSource },
      });
      expect(h.printed()).not.toContain("AgentX error");
      expect(code).toBe(0);
      expect(fetchWithGitHub.github).toEqual([]);
      expect(await readInstallAnswers(h.store, "staging")).toMatchObject({ engine: "cdk", releaseVersion: "1.4.0", images: { worker: WORKER, slack: SLACK_IMAGE } });
      expect((await readEnvironmentSettings(h.store, "staging"))?.version).toBe("1.4.0");
    });

    it("without image flags, reads the tag's release.json and never the tarball, and offers its regions", async () => {
      const h = await harness();
      const fetchWithGitHub = githubRelease(h.deps.fetch as typeof fetch, publishedManifest);
      // us-west-2 is only in the published release.json, not in the harness's release directory.
      const prompter = scriptedPrompter(["us-west-2", ...CDK_FIRST_RUN]);
      const code = await h.runWithoutRelease(["--engine", "cdk", "--source", "/src", "--stop-after", "prerequisites"], {
        releaseVersion: null, fetch: fetchWithGitHub, prompter, deploy: { ...h.deps.deploy, commandRunner: taggedSource },
      });
      expect(h.printed()).not.toContain("AgentX error");
      expect(code).toBe(0);
      expect(prompter.asked[0]).toBe("AWS region");
      expect(fetchWithGitHub.github).toEqual([MANIFEST_URL]);
      expect(await readInstallAnswers(h.store, "staging")).toMatchObject({ engine: "cdk", releaseVersion: "1.4.0", region: "us-west-2" });
    });

    it("takes the region from the AWS configuration when there is no release.json to list regions", async () => {
      const h = await harness();
      const prompter = scriptedPrompter([...CDK_FIRST_RUN]);
      const code = await h.runWithoutRelease(["--engine", "cdk", "--source", "/src", ...IMAGES, "--stop-after", "prerequisites"], {
        releaseVersion: null, fetch: githubRelease(h.deps.fetch as typeof fetch), prompter, processEnv: { AWS_REGION: "eu-west-1" }, deploy: { ...h.deps.deploy, commandRunner: taggedSource },
      });
      expect(h.printed()).not.toContain("AgentX error");
      expect(code).toBe(0);
      expect(prompter.asked).not.toContain("AWS region");
      expect(await readInstallAnswers(h.store, "staging")).toMatchObject({ region: "eu-west-1" });
      // Review M6: the region taken without asking is said.
      expect(h.printed()).toContain("Region eu-west-1, from your AWS configuration; pass --region to choose another");
    });

    it("offers and defaults to the configured region although release.json does not list it: the cdk engine synthesizes for any region (review M7)", async () => {
      const h = await harness();
      const prompter = scriptedPrompter(["", ...CDK_FIRST_RUN]);
      const code = await h.runWithoutRelease(["--engine", "cdk", "--source", "/src", "--stop-after", "prerequisites"], {
        releaseVersion: null, fetch: githubRelease(h.deps.fetch as typeof fetch, publishedManifest), prompter, processEnv: { AWS_REGION: "eu-west-1" }, deploy: { ...h.deps.deploy, commandRunner: taggedSource },
      });
      expect(h.printed()).not.toContain("AgentX error");
      expect(code).toBe(0);
      expect(await readInstallAnswers(h.store, "staging")).toMatchObject({ region: "eu-west-1" });
    });

    it("resumes an install begun with both image flags without them, although the tag has no published release.json (review I2)", async () => {
      const h = await harness();
      const first = await h.runWithoutRelease(["--region", "us-east-1", "--engine", "cdk", "--source", "/src", ...IMAGES, "--stop-after", "prerequisites"], {
        releaseVersion: null, fetch: githubRelease(h.deps.fetch as typeof fetch), prompter: scriptedPrompter([...CDK_FIRST_RUN]), deploy: { ...h.deps.deploy, commandRunner: taggedSource },
      });
      expect(first).toBe(0);
      const mark = h.mark();
      const prompter = scriptedPrompter([...SLACK, ...SIGNIN, ...FINISH]);
      const code = await h.runWithoutRelease(["--region", "us-east-1", "--engine", "cdk", "--source", "/src"], {
        releaseVersion: null, fetch: githubRelease(h.deps.fetch as typeof fetch), prompter, deploy: { ...h.deps.deploy, commandRunner: taggedSource },
      });
      expect(h.printedSince(mark)).not.toContain("AgentX error");
      expect(code).toBe(0);
      expect(h.printedSince(mark)).toContain("Resuming the install of environment staging.");
      expect((await readEnvironmentSettings(h.store, "staging"))?.version).toBe("1.4.0");
    });

    it("runs the real cdk deployment: build, one synth whose folder is removed, then cdk deploy (review M9)", async () => {
      const h = await harness();
      await h.store.put("/cdk-bootstrap/hnb659fds/version", "21");
      const calls: Array<{ line: string; cwd: string }> = [];
      const synthDirs: string[] = [];
      const runner = {
        async run(command: string, args: string[], options: { cwd: string }) {
          calls.push({ line: [command, ...args.slice(0, 3)].join(" "), cwd: options.cwd });
          if (command === "git") return taggedSource.run(command, args);
          if (args[2] === "synth") {
            const outDir = args[args.indexOf("-o") + 1] as string;
            synthDirs.push(outDir);
            const artifacts: Record<string, unknown> = {};
            for (const [part, id] of Object.entries(CDK_CONSTRUCT_IDS)) {
              await writeFile(join(outDir, `${id}.template.json`), JSON.stringify({ Parameters: {} }));
              artifacts[id] = { type: "aws:cloudformation:stack", properties: { templateFile: `${id}.template.json`, stackName: environmentStackName("staging", part as never) } };
            }
            await writeFile(join(outDir, "manifest.json"), JSON.stringify({ version: "54.0.0", artifacts }));
          }
          const outputsFile = args.indexOf("--outputs-file") >= 0 ? args[args.indexOf("--outputs-file") + 1] : undefined;
          if (outputsFile !== undefined) await writeFile(outputsFile, JSON.stringify(allStackOutputs()));
          return { stdout: "" };
        },
      };
      // No deployer override: the real prepareDeployment builds the cdk engine.
      const deploy = { ...h.deps.deploy };
      delete deploy.deployer;
      const code = await h.runWithoutRelease(["--region", "us-east-1", "--engine", "cdk", "--source", "/src", ...IMAGES, "--stop-after", "access"], {
        releaseVersion: null, fetch: githubRelease(h.deps.fetch as typeof fetch), prompter: scriptedPrompter([...CDK_FIRST_RUN]),
        deploy: { ...deploy, commandRunner: runner, stackOutputs: async () => undefined },
      });
      expect(h.printed()).not.toContain("AgentX error");
      expect(code).toBe(0);
      const lines = calls.filter((call) => call.line.startsWith("npm") || call.line.startsWith("npx")).map((call) => call.line);
      expect(lines).toEqual(["npm ci", "npm run build", "npx --no-install cdk synth", "npx --no-install cdk deploy"]);
      expect(calls.every((call) => call.cwd === "/src")).toBe(true);
      expect(synthDirs).toHaveLength(1);
      await expect(stat(synthDirs[0] as string)).rejects.toThrow();
    });

    it("refuses with no region anywhere, naming --region, before asking anything", async () => {
      const h = await harness();
      const prompter = scriptedPrompter([]);
      const code = await h.runWithoutRelease(["--engine", "cdk", "--source", "/src", ...IMAGES], {
        releaseVersion: null, fetch: githubRelease(h.deps.fetch as typeof fetch), prompter, deploy: { ...h.deps.deploy, commandRunner: taggedSource },
      });
      expect(code).toBe(2);
      expect(h.printed()).toContain("with no release.json there is no list of regions to choose from; pass --region <region>, or set a region in your AWS configuration");
      expect(prompter.asked).toEqual([]);
    });

    // Review I2: a resume's saved answers may hold the images, so the refusal waits for the store
    // read, but still comes before any question.
    it("refuses when the tag has no published release.json and an image flag is missing, naming both flags, before asking anything", async () => {
      const h = await harness();
      const prompter = scriptedPrompter([]);
      const code = await h.runWithoutRelease(["--region", "us-east-1", "--engine", "cdk", "--source", "/src", "--worker-image", WORKER], {
        releaseVersion: null, fetch: githubRelease(h.deps.fetch as typeof fetch), prompter, deploy: { ...h.deps.deploy, commandRunner: taggedSource },
      });
      expect(code).toBe(2);
      expect(h.printed()).toContain(`release 1.4.0 has no published release.json at ${MANIFEST_URL}, so its images are unknown; pass --worker-image and --slack-image, or --release <dir>`);
      expect(prompter.asked).toEqual([]);
      expect(h.store.calls.filter((call) => call.op === "put")).toEqual([]);
    });

    it("needs --source on the command line", async () => {
      const h = await harness();
      const code = await h.runWithoutRelease(["--region", "us-east-1", "--engine", "cdk", ...IMAGES], { releaseVersion: null, prompter: scriptedPrompter([]) });
      expect(code).toBe(2);
      expect(h.printed()).toContain("the cdk engine needs --source <a checkout of a release tag>");
    });

    it("refuses a --release that does not match the source's tag, before showing the plan", async () => {
      const h = await harness();
      // The harness's --release holds 1.2.3; the checkout is at v1.4.0.
      const code = await h.run(["--engine", "cdk", "--source", "/src"], { prompter: scriptedPrompter(CDK_FIRST_RUN.slice(0, -1)), deploy: { ...h.deps.deploy, commandRunner: taggedSource } });
      expect(code).toBe(2);
      expect(h.printed()).toContain("the cdk engine must run from a checkout of tag v1.2.3; /src is at v1.4.0");
      expect(h.printed()).not.toContain("Estimated monthly total");
      expect(h.store.calls.filter((call) => call.op === "put")).toEqual([]);
    });
  });

  it("refuses --account that is not the account of the AWS credentials", async () => {
    const h = await harness();
    expect(await h.run(["--account", "999999999999"], { prompter: scriptedPrompter([]) })).toBe(2);
    expect(h.printed()).toContain("--account 999999999999 does not match your AWS credentials, which are for account 123456789012");
  });

  // F14: the answers and the alert secret are saved only under the environment lock.
  it("saves nothing when someone else holds the environment lock", async () => {
    const h = await harness();
    h.store.values.set(lockParameterName("staging"), JSON.stringify({ holder: "arn:aws:sts::123456789012:assumed-role/Admin/bob", command: "deploy install", acquiredAt: new Date(T0).toISOString() }));
    const code = await h.run([...UNATTENDED, "--alert-webhook-env", "HOOK"], { processEnv: { ...UNATTENDED_ENV, HOOK: WEBHOOK } });
    expect(code).toBe(2);
    expect(h.printed()).toContain(`locked by arn:aws:sts::123456789012:assumed-role/Admin/bob running "deploy install" since ${new Date(T0).toISOString()}; wait for it to finish, then run the same agentx command again`);
    expect(h.store.values.has(installAnswersParameterName("staging"))).toBe(false);
    expect(h.secrets.values.has("agentx/staging/alert-endpoint")).toBe(false);
  });

  it("offers to take over its own lock left by a closed terminal", async () => {
    const h = await harness();
    h.store.values.set(lockParameterName("staging"), JSON.stringify({ holder: HOLDER, command: "init", acquiredAt: new Date(T0 - 60_000).toISOString() }));
    const prompter = scriptedPrompter([...FIRST_RUN, true, ...SLACK, ...SIGNIN, ...FINISH]);
    expect(await h.run([], { prompter })).toBe(0);
    expect(prompter.asked).toContain("Environment staging is locked by your own earlier agentx init since 2026-09-26T23:59:00.000Z. Take the lock over? Say yes only if that run is no longer going.");
    expect(h.store.values.has(lockParameterName("staging"))).toBe(false);
  });

  it("keeps an alert webhook address only in its secret, and replaces it on resume only when given again", async () => {
    const h = await harness();
    h.deployer.fail.set(environmentStackName("staging", "control-plane"), new Error("Resource limit exceeded"));
    expect(await h.run([...UNATTENDED, "--alert-webhook-env", "HOOK"], { processEnv: { ...UNATTENDED_ENV, HOOK: WEBHOOK } })).not.toBe(0);
    expect(h.secrets.values.get("agentx/staging/alert-endpoint")).toBe(WEBHOOK);
    expect(h.printed()).toContain("https://events.pagerduty.com/...");

    // A resume without the flag keeps the stored address.
    expect(await h.run(UNATTENDED, { processEnv: UNATTENDED_ENV })).not.toBe(0);
    expect(h.secrets.values.get("agentx/staging/alert-endpoint")).toBe(WEBHOOK);

    // A resume with the flag replaces it.
    const rotated = WEBHOOK.replace("0123SECRET", "4567ROTATED");
    h.deployer.fail.clear();
    expect(await h.run([...UNATTENDED, "--alert-webhook-env", "HOOK"], { processEnv: { ...UNATTENDED_ENV, HOOK: rotated } })).toBe(0);
    expect(h.secrets.values.get("agentx/staging/alert-endpoint")).toBe(rotated);

    const everywhere = await everywhereButSecrets(h);
    expect(everywhere).toContain("https://events.pagerduty.com/...");
    for (const secret of ["0123SECRETintegrationKEY", "4567ROTATEDintegrationKEY", TEST_BOT_TOKEN, TEST_SIGNING_SECRET, TEST_PRIVATE_KEY.split("\n")[1]!]) {
      expect(everywhere).not.toContain(secret);
    }
  });

  it("refuses, on resume, a webhook address on a different host", async () => {
    const h = await harness();
    h.deployer.fail.set(environmentStackName("staging", "control-plane"), new Error("Resource limit exceeded"));
    await h.run([...UNATTENDED, "--alert-webhook-env", "HOOK"], { processEnv: { ...UNATTENDED_ENV, HOOK: WEBHOOK } });
    expect(await h.run([...UNATTENDED, "--alert-webhook-env", "HOOK"], { processEnv: { ...UNATTENDED_ENV, HOOK: "https://api.opsgenie.com/v2/SECRETother" } })).toBe(2);
    expect(h.printed()).toContain("--alert-webhook-env HOOK (https://api.opsgenie.com/...) differs from what this install started with (https://events.pagerduty.com/...)");
    expect(h.secrets.values.get("agentx/staging/alert-endpoint")).toBe(WEBHOOK);
    expect(h.printed()).not.toContain("SECRETother");
  });
});

const OPENROUTER_KEY = "sk-or-v1-feedface0123456789OPENROUTERSECRET";
const OPENROUTER_ARN = "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/openrouter-AbCdEf";
// A first run choosing OpenRouter: FIRST_RUN's settings with OpenRouter as the provider, then the
// three model ids and the key (hidden), then the plan's confirm.
const OPENROUTER_FIRST_RUN = [
  ...settingsScript({ email: ADMIN_EMAIL, owner: "acme", advanced: { modelProvider: "openrouter", alertEmail: "ops@example.com" } }),
  "qwen/qwen3-coder", "qwen/qwen3-coder", "anthropic/claude-sonnet-4", OPENROUTER_KEY, true,
];
const OPENROUTER_FLAGS = ["--model-provider", "openrouter", "--orchestrator-model", "qwen/qwen3-coder", "--classifier-model", "qwen/qwen3-coder", "--worker-model", "qwen/qwen3-coder"];

function recordingOpenRouterChecks() {
  const calls: Array<{ modelId: string; secretArn?: string; key?: string }> = [];
  return { calls, checks: passingChecks({ openRouter: async (modelId, config, key) => { calls.push({ modelId, ...(config.secretArn === undefined ? {} : { secretArn: config.secretArn }), ...(key === undefined ? {} : { key }) }); } }) };
}

describe("agentx init with an Anthropic API key (spec 054)", () => {
  const ANTHROPIC_KEY = "sk-ant-api03-0123456789abcdefKEYSECRET";
  const ANTHROPIC_ARN = "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/anthropic-AbCdEf";

  it("stores the key before any stack, checks the models with it, passes only the ARN on, and a resume with --anthropic-key-env rotates it", async () => {
    const h = await harness();
    const calls: Array<{ provider: string; modelId: string; key?: string }> = [];
    const checks = passingChecks({ directProvider: async (provider, modelId, _config, key) => { calls.push({ provider, modelId, ...(key === undefined ? {} : { key }) }); } });
    h.deployer.fail.set(environmentStackName("staging", "control-plane"), new Error("Resource limit exceeded"));
    const argv = [...UNATTENDED, "--alert-email", "ops@example.com", "--model-provider", "anthropic", "--anthropic-key-env", "ANTHROPIC_KEY_FOR_AGENTX"];
    expect(await h.run(argv, { processEnv: { ...UNATTENDED_ENV, ANTHROPIC_KEY_FOR_AGENTX: ANTHROPIC_KEY }, checks })).not.toBe(0);
    expect(h.secrets.values.get("agentx/staging/anthropic")).toBe(ANTHROPIC_KEY);
    expect(checks.models).toEqual([]);
    expect(calls).toEqual([
      { provider: "anthropic", modelId: "claude-sonnet-4-6", key: ANTHROPIC_KEY },
      { provider: "anthropic", modelId: "claude-haiku-4-5", key: ANTHROPIC_KEY },
    ]);
    const saved = (await readInstallAnswers(h.store, "staging"))?.models;
    expect(saved).toMatchObject({ orchestrator: "claude-sonnet-4-6", classifier: "claude-haiku-4-5", worker: "claude-sonnet-4-6", anthropic: { secretArn: ANTHROPIC_ARN } });

    h.deployer.fail.clear();
    const rotated = ANTHROPIC_KEY.replace("0123456789", "9876543210");
    expect(await h.run(argv, { processEnv: { ...UNATTENDED_ENV, ANTHROPIC_KEY_FOR_AGENTX: rotated }, checks })).toBe(0);
    expect(h.secrets.values.get("agentx/staging/anthropic")).toBe(rotated);
    const withArn = h.deployer.requests.filter((request) => "AnthropicSecretArn" in request.parameters);
    expect([...new Set(withArn.map((request) => request.part))]).toEqual(["control-plane", "runtime", "slack"]);
    expect(withArn.every((request) => request.parameters.AnthropicSecretArn === ANTHROPIC_ARN)).toBe(true);
    const everywhere = await everywhereButSecrets(h);
    for (const key of [ANTHROPIC_KEY, rotated]) {
      expect(everywhere).not.toContain(key);
      expect(JSON.stringify(h.deployer.requests.map((request) => request.parameters))).not.toContain(key);
    }
  });
});

describe("agentx init with OpenRouter", () => {
  it("asks for the key hidden, stores it raw in agentx/<env>/openrouter before any stack, and passes only its ARN on", async () => {
    const h = await harness();
    const { calls, checks } = recordingOpenRouterChecks();
    const prompter = scriptedPrompter([...OPENROUTER_FIRST_RUN, ...SLACK, ...SIGNIN, ...FINISH]);
    const hidden: string[] = [];
    const recording = { ...prompter, secret: async (question: string, options: { flag: string; multiline?: boolean }) => { hidden.push(question); return prompter.secret(question, options); } };
    expect(await h.run([], { prompter: recording, checks })).toBe(0);
    expect(prompter.remaining()).toBe(0);
    expect(hidden[0]).toBe("OpenRouter API key");
    expect(h.secrets.values.get("agentx/staging/openrouter")).toBe(OPENROUTER_KEY);
    // The preflight used the key before it was stored, so no Bedrock fallback was checked.
    expect(checks.models).toEqual([]);
    expect(calls.map((call) => call.key)).toEqual([OPENROUTER_KEY, OPENROUTER_KEY]);
    expect(h.printed()).toContain("agentx/staging/openrouter");
    expect((await readInstallAnswers(h.store, "staging"))?.models.openRouter).toEqual({ secretArn: OPENROUTER_ARN });
    const openRouterParameters = h.deployer.requests.filter((request) => "OpenRouterSecretArn" in request.parameters);
    expect(openRouterParameters.map((request) => request.part)).toEqual(["control-plane", "runtime", "slack"]);
    expect(openRouterParameters.every((request) => request.parameters.OpenRouterSecretArn === OPENROUTER_ARN)).toBe(true);
    const everywhere = await everywhereButSecrets(h);
    expect(everywhere).not.toContain(OPENROUTER_KEY);
    expect(JSON.stringify(h.deployer.requests.map((request) => request.parameters))).not.toContain(OPENROUTER_KEY);
  });

  it("a resume after the key was stored does not ask for it again", async () => {
    const h = await harness();
    const { checks } = recordingOpenRouterChecks();
    h.deployer.fail.set(environmentStackName("staging", "control-plane"), new Error("Resource limit exceeded"));
    expect(await h.run([], { prompter: scriptedPrompter(OPENROUTER_FIRST_RUN), checks })).not.toBe(0);
    expect(h.secrets.values.get("agentx/staging/openrouter")).toBe(OPENROUTER_KEY);
    h.deployer.fail.clear();
    const prompter = scriptedPrompter([...SLACK, ...SIGNIN, ...FINISH]);
    expect(await h.run([], { prompter, checks })).toBe(0);
    expect(prompter.remaining()).toBe(0);
    expect(prompter.asked).not.toContain("OpenRouter API key");
    expect(await everywhereButSecrets(h)).not.toContain(OPENROUTER_KEY);
  });

  it("with --yes, takes the key from --openrouter-key-file, and a rerun of the same command replaces it and asks nothing", async () => {
    const h = await harness();
    const keyFile = join(await tmp("agentx-openrouter-key-"), "key");
    await writeFile(keyFile, `${OPENROUTER_KEY}\n`);
    const { checks } = recordingOpenRouterChecks();
    h.deployer.fail.set(environmentStackName("staging", "control-plane"), new Error("Resource limit exceeded"));
    const argv = [...UNATTENDED, "--alert-email", "ops@example.com", ...OPENROUTER_FLAGS, "--openrouter-key-file", keyFile];
    expect(await h.run(argv, { processEnv: UNATTENDED_ENV, checks })).not.toBe(0);
    expect(h.secrets.values.get("agentx/staging/openrouter")).toBe(OPENROUTER_KEY);
    h.deployer.fail.clear();
    const rotated = OPENROUTER_KEY.replace("feedface", "0ddba11x");
    await writeFile(keyFile, rotated);
    expect(await h.run(argv, { processEnv: UNATTENDED_ENV, checks })).toBe(0);
    expect(h.secrets.values.get("agentx/staging/openrouter")).toBe(rotated);
    const everywhere = await everywhereButSecrets(h);
    for (const key of [OPENROUTER_KEY, rotated]) expect(everywhere).not.toContain(key);
  });

  it("with --yes and no key flag, refuses before creating anything and names the flags", async () => {
    const h = await harness();
    expect(await h.run([...UNATTENDED, "--alert-email", "ops@example.com", ...OPENROUTER_FLAGS], { processEnv: UNATTENDED_ENV })).toBe(2);
    for (const flag of ["--openrouter-key-file", "--openrouter-key-env", "--openrouter-secret-arn"]) expect(h.printed()).toContain(flag);
    expect(h.store.values.has(installAnswersParameterName("staging"))).toBe(false);
    expect(h.secrets.values.has("agentx/staging/openrouter")).toBe(false);
    expect(h.deployer.requests).toEqual([]);
  });

  it("with --yes and only --worker-provider openrouter, refuses without a key or ARN and names the key flags", async () => {
    const h = await harness();
    expect(await h.run([...UNATTENDED, "--alert-email", "ops@example.com", "--worker-provider", "openrouter", "--worker-model", "qwen/qwen3-coder"], { processEnv: UNATTENDED_ENV })).toBe(2);
    for (const flag of ["--openrouter-key-file", "--openrouter-key-env", "--openrouter-secret-arn"]) expect(h.printed()).toContain(flag);
    expect(h.store.values.has(installAnswersParameterName("staging"))).toBe(false);
    expect(h.secrets.values.has("agentx/staging/openrouter")).toBe(false);
    expect(h.deployer.requests).toEqual([]);
  });

  it("with --openrouter-secret-arn, asks for no key, stores none, and refuses a key flag on resume", async () => {
    const h = await harness();
    const own = "arn:aws:secretsmanager:us-east-1:123456789012:secret:my-openrouter-AbCdEf";
    const { calls, checks } = recordingOpenRouterChecks();
    h.deployer.fail.set(environmentStackName("staging", "control-plane"), new Error("Resource limit exceeded"));
    expect(await h.run([...UNATTENDED, "--alert-email", "ops@example.com", ...OPENROUTER_FLAGS, "--openrouter-secret-arn", own], { processEnv: UNATTENDED_ENV, checks })).not.toBe(0);
    expect(h.secrets.values.has("agentx/staging/openrouter")).toBe(false);
    expect(calls[0]).toEqual({ modelId: "qwen/qwen3-coder", secretArn: own });
    expect((await readInstallAnswers(h.store, "staging"))?.models.openRouter).toEqual({ secretArn: own });
    expect(await h.run([...UNATTENDED, "--openrouter-key-env", "OR_KEY"], { processEnv: { ...UNATTENDED_ENV, OR_KEY: OPENROUTER_KEY } })).toBe(2);
    expect(h.printed()).toContain("--openrouter-key-env OR_KEY differs from what this install started with");
    expect(h.printed()).not.toContain(OPENROUTER_KEY);
  });

  it("keeps Bedrock the default under --yes", async () => {
    const h = await harness();
    expect(await h.run([...UNATTENDED, "--alert-email", "ops@example.com"], { processEnv: UNATTENDED_ENV })).toBe(0);
    const models = (await readInstallAnswers(h.store, "staging"))?.models;
    expect(models?.orchestrator).toBe("us.anthropic.claude-sonnet-4-6");
    expect(models?.providers).toBeUndefined();
    expect(models?.openRouter).toBeUndefined();
    expect(h.secrets.values.has("agentx/staging/openrouter")).toBe(false);
  });
});

// The bundle's answers, as writeExportBundle writes them (Task 14's export-bundle test pins that).
async function bundleDir(overrides: Record<string, unknown> = {}): Promise<string> {
  const dir = await tmp("agentx-bundle-");
  await writeFile(join(dir, "init-answers.json"), JSON.stringify({
    schemaVersion: 1, env: "staging", region: "us-east-1", account: "123456789012", engine: "templates", releaseVersion: "1.2.3",
    identity: { mode: "cognito" }, models: { orchestrator: "us.anthropic.claude-sonnet-4-6", classifier: "us.anthropic.claude-haiku-4-5-20251001-v1:0", worker: "us.anthropic.claude-sonnet-4-6" },
    ...overrides,
  }));
  return dir;
}
const OPERATOR = "arn:aws:sts::123456789012:assumed-role/agentx-staging-operator/alice";
// A bundle resume's settings leave out what the export knew (the install name, engine, sign-in,
// models, boundary and operator); then the plan.
const BUNDLE_RUN = [...settingsScript({ email: ADMIN_EMAIL, owner: "acme", fixed: true, advanced: { alertEmail: "ops@example.com" } }), true];
const ACCESS_DEPLOYED = { status: async (name: string) => (name === "agentx-staging-access" ? "CREATE_COMPLETE" : undefined) };

describe("init --resume --from-bundle (FR-026)", () => {
  it("asks only what the export did not know, records access as done, and goes on with core", async () => {
    const h = await harness();
    const dir = await bundleDir();
    // The platform team's access stack exists already, with its outputs.
    const deployer = scriptedDeployer(allStackOutputs(), [environmentStackName("staging", "access")]);
    deployer.fail.set(environmentStackName("staging", "foundation"), new Error("stop after access"));
    const prompter = scriptedPrompter(BUNDLE_RUN);
    const code = await h.run(["--resume", "--from-bundle", dir], {
      prompter, stackStatus: ACCESS_DEPLOYED,
      deploy: { ...h.deps.deploy, deployer, identity: { get: async () => ({ account: "123456789012", arn: OPERATOR }) } },
    });
    expect(code).not.toBe(0);
    expect(h.printed()).toContain("stop after access");
    expect(prompter.remaining()).toBe(0);
    expect(prompter.asked).not.toContain("Deploy engine");
    const progress = await readInstallProgress(h.store, "staging");
    expect(progress?.steps.access).toMatchObject({ status: "done", note: "deployed by your platform team from the export bundle" });
    expect(progress?.steps.prerequisites?.status).toBe("done");
    expect(deployer.requests.map((request) => request.part)).toEqual(["foundation"]);
    expect(h.deployer.requests).toEqual([]);
    const saved = await readInstallAnswers(h.store, "staging");
    expect(saved).toMatchObject({ engine: "templates", identity: { mode: "cognito" }, github: { account: "acme" }, alert: { kind: "email", address: "ops@example.com" } });
    expect(saved?.models.worker).toBe("us.anthropic.claude-sonnet-4-6");
  });

  it("records access as done on a rerun whose first run saved the answers but stopped before the progress", async () => {
    const h = await harness();
    const dir = await bundleDir();
    const deployer = scriptedDeployer(allStackOutputs(), [environmentStackName("staging", "access")]);
    deployer.fail.set(environmentStackName("staging", "foundation"), new Error("stop after access"));
    const deploy = { ...h.deps.deploy, deployer, identity: { get: async () => ({ account: "123456789012", arn: OPERATOR }) } };
    expect(await h.run(["--resume", "--from-bundle", dir], { prompter: scriptedPrompter(BUNDLE_RUN), stackStatus: ACCESS_DEPLOYED, deploy })).not.toBe(0);
    // A crash between saving the answers and recording access leaves answers and no progress.
    h.store.values.delete(installProgressParameterName("staging"));
    const mark = h.mark();
    expect(await h.run(["--resume", "--from-bundle", dir], { prompter: scriptedPrompter([]), stackStatus: ACCESS_DEPLOYED, deploy })).not.toBe(0);
    const rerun = h.printedSince(mark);
    expect(rerun).not.toContain("you are using the AgentX operator role");
    expect(rerun).toContain("already done: Set up AWS permissions");
    expect((await readInstallProgress(h.store, "staging"))?.steps.access).toMatchObject({ status: "done", note: "deployed by your platform team from the export bundle" });
    expect(deployer.requests.map((request) => request.part)).toEqual(["foundation", "foundation"]);
  });

  it("refuses a bundle whose permission boundary differs from the deployed access stack's", async () => {
    const h = await harness();
    const boundary = "arn:aws:iam::123456789012:policy/team-boundary";
    const stackStatus = { ...ACCESS_DEPLOYED, parameters: async () => ({ PermissionsBoundaryArn: "arn:aws:iam::123456789012:policy/other-boundary" }) };
    const code = await h.run(["--resume", "--from-bundle", await bundleDir({ permissionsBoundaryArn: boundary })], { prompter: scriptedPrompter([]), stackStatus });
    expect(code).not.toBe(0);
    expect(h.printed()).toContain(`the bundle's permission boundary (${boundary}) differs from the one the access stack agentx-staging-access was deployed with (arn:aws:iam::123456789012:policy/other-boundary)`);
    expect(h.store.values.has(installAnswersParameterName("staging"))).toBe(false);
    // The default boundary is an empty parameter; a bundle with no boundary matches it.
    const matching = { ...ACCESS_DEPLOYED, parameters: async () => ({ PermissionsBoundaryArn: "" }) };
    const deployer = scriptedDeployer(allStackOutputs(), [environmentStackName("staging", "access")]);
    deployer.fail.set(environmentStackName("staging", "foundation"), new Error("stop after access"));
    expect(await h.run(["--resume", "--from-bundle", await bundleDir()], { prompter: scriptedPrompter(BUNDLE_RUN), stackStatus: matching, deploy: { ...h.deps.deploy, deployer } })).not.toBe(0);
    expect(h.printed()).toContain("stop after access");
  });

  it("refuses when the platform team has not deployed the access stack yet", async () => {
    const h = await harness();
    const code = await h.run(["--resume", "--from-bundle", await bundleDir()], { prompter: scriptedPrompter([]), stackStatus: { status: async () => undefined } });
    expect(code).not.toBe(0);
    expect(h.printed()).toContain("the access stack agentx-staging-access does not exist yet; ask your platform team to run deploy-access.sh from the bundle, then run this again");
  });

  it("refuses an access stack that rolled back", async () => {
    const h = await harness();
    const code = await h.run(["--resume", "--from-bundle", await bundleDir()], { prompter: scriptedPrompter([]), stackStatus: { status: async () => "ROLLBACK_COMPLETE" } });
    expect(code).not.toBe(0);
    expect(h.printed()).toContain("the access stack agentx-staging-access is ROLLBACK_COMPLETE; ask your platform team to fix it");
    expect(h.store.values.has(installAnswersParameterName("staging"))).toBe(false);
  });

  it("refuses a bundle for another account", async () => {
    const h = await harness();
    const code = await h.run(["--resume", "--from-bundle", await bundleDir({ account: "999999999999" })], { prompter: scriptedPrompter([]), stackStatus: { status: async () => "CREATE_COMPLETE" } });
    expect(code).not.toBe(0);
    expect(h.printed()).toContain("the bundle is for account 999999999999, but your AWS credentials are for account 123456789012");
  });

  it("refuses a bundle for another environment or region, and --from-bundle without --resume", async () => {
    const h = await harness();
    const options = { prompter: scriptedPrompter([]), stackStatus: ACCESS_DEPLOYED };
    expect(await h.run(["--resume", "--from-bundle", await bundleDir({ env: "dev" })], options)).not.toBe(0);
    expect(h.printed()).toContain("the bundle is for environment dev; pass --env dev");
    expect(await h.run(["--resume", "--from-bundle", await bundleDir({ region: "eu-west-1" })], options)).not.toBe(0);
    expect(h.printed()).toContain("the bundle is for region eu-west-1; pass --region eu-west-1");
    expect(await h.run(["--from-bundle", await bundleDir()], options)).not.toBe(0);
    expect(h.printed()).toContain("--from-bundle goes with --resume");
    expect(h.store.values.has(installAnswersParameterName("staging"))).toBe(false);
    expect(h.deployer.requests).toEqual([]);
  });

  it("refuses a flag that contradicts the bundle's answers", async () => {
    const h = await harness();
    const code = await h.run(["--resume", "--from-bundle", await bundleDir(), "--engine", "cdk", "--source", "/tmp/x"], { prompter: scriptedPrompter(BUNDLE_RUN), stackStatus: ACCESS_DEPLOYED });
    expect(code).not.toBe(0);
    expect(h.printed()).toContain("--engine cdk differs from what this install started with (templates)");
    expect(h.store.values.has(installAnswersParameterName("staging"))).toBe(false);
  });
});

describe("a plain --resume under the operator role", () => {
  it("with nothing to resume, points at --from-bundle", async () => {
    const h = await harness();
    const operator = { ...h.deps.deploy, identity: { get: async () => ({ account: "123456789012", arn: OPERATOR }) } };
    expect(await h.run(["--resume"], { prompter: scriptedPrompter([]), deploy: operator })).toBe(2);
    expect(h.printed()).toContain("there is no install of environment staging to resume in account 123456789012 (us-east-1); you are using the AgentX operator role, so if your platform team deployed the access stack from an export bundle, run agentx init --resume --from-bundle <the bundle directory>");
  });
});

describe("the access step under the operator role (FR-019)", () => {
  it("refuses with what to ask the platform team, instead of failing on IAM", async () => {
    const h = await harness();
    const operator = { ...h.deps.deploy, identity: { get: async () => ({ account: "123456789012", arn: OPERATOR }) } };
    // A first run as the operator: answers are saved, prerequisites pass, then access refuses.
    const code = await h.run([], { prompter: scriptedPrompter([...FIRST_RUN]), deploy: operator });
    expect(code).not.toBe(0);
    expect(h.printed()).toContain("the access stack needs admin rights, and you are using the AgentX operator role; ask your platform team to deploy it (agentx init --export, then deploy-access.sh), or run agentx init with admin credentials");
    expect(h.deployer.requests).toEqual([]);
  });
});

const EXPORTER = { get: async () => ({ account: "123456789012", arn: "arn:aws:iam::123456789012:user/exporter" }) };

describe("init --export and production (spec decision, 2026-09-27)", () => {
  it("writes a bundle for production when nothing is installed there", async () => {
    const h = await harness();
    const out = await tmp("agentx-export-");
    const code = await executeCli(["--env", "production", "init", "--export", join(out, "bundle"), "--region", "us-east-1", "--release", h.release, "--account", "123456789012"], { deploy: { store: new MemoryParameterStore(), identity: EXPORTER }, stdout: { write: () => true }, stderr: { write: () => true } });
    expect(code).toBe(0);
  });

  it("refuses production when SSM already holds its settings", async () => {
    const h = await harness();
    const store = new MemoryParameterStore();
    store.values.set("/agentx/production/settings", "{}");
    const err: string[] = [];
    const out = await tmp("agentx-export-");
    const code = await executeCli(["--env", "production", "init", "--export", join(out, "bundle"), "--region", "us-east-1", "--release", h.release, "--account", "123456789012"], { deploy: { store, identity: EXPORTER }, stdout: { write: () => true }, stderr: { write: (text: string) => err.push(text) } });
    expect(code).not.toBe(0);
    expect(err.join("")).toContain("environment production is already installed in this account; export a bundle for a new --env");
  });
});
