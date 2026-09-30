// SC-003: a full `agentx init --ui` install driven entirely from the page, with nothing typed in
// the terminal after the command. The wizard server and the GitHub manifest listener are both
// real, on 127.0.0.1; every AWS, GitHub, Slack and clock dependency is injected, so nothing here
// reaches AWS, GitHub or Slack.
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { environmentStackName } from "@agentx/contracts";
import { executeCli } from "../../packages/cli/src/main.js";
import { environmentCachePath } from "../../packages/cli/src/environments/cache.js";
import type { InitCliDependencies } from "../../packages/cli/src/init/commands.js";
import { INIT_STEP_IDS, installAnswersParameterName, readInstallProgress } from "../../packages/cli/src/init/install-state.js";
import { readEnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import {
  allStackOutputs, browserThatCreatesGitHubApp, fakeGitHubApi, fakeSlackApi, HOLDER, memoryInitSecrets, passingChecks, scriptedDeployer, scriptedPrompter,
  slackIngressFetch, T0, TEST_BOT_TOKEN, TEST_SIGNING_SECRET,
} from "../support/init-fakes.js";
import { fakeWizardOperator } from "../support/wizard-browser.js";
import { SIGN_IN_PARAMETERS, fakeCloudFormation } from "../support/fake-cloudformation.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";
import { ADMIN_EMAIL, FOUNDATION_OUTPUTS, fakeAlerts, fakeControlPlane, fakeRepositories, fakeSlackChannels, setupServices, turn } from "../support/setup-fakes.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const tmp = async (prefix: string) => { const dir = await mkdtemp(join(tmpdir(), prefix)); dirs.push(dir); return dir; };
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

async function releaseDir(): Promise<string> {
  const dir = await tmp("agentx-init-ui-release-");
  const templates = [];
  await mkdir(join(dir, "templates", "us-east-1"), { recursive: true });
  for (const part of ["access", "foundation", "identity", "control-plane", "runtime", "slack"]) {
    const file = `templates/us-east-1/${part}.template.json`;
    await writeFile(join(dir, file), "{}");
    templates.push({ region: "us-east-1", part, file, sha256: sha256("{}") });
  }
  await writeFile(join(dir, "release.json"), JSON.stringify({
    schemaVersion: 1, version: "1.2.3", gitCommit: "a".repeat(40), environmentPlaceholder: "qqenv-placeholderqq", templates, packages: [],
    images: { worker: `public.ecr.aws/agentx/worker@sha256:${"a".repeat(64)}`, slack: `public.ecr.aws/agentx/slack@sha256:${"b".repeat(64)}` },
  }));
  return dir;
}

// The same answers the terminal path's tests script (init-cli.test.ts), in the same order: `agentx
// init --ui` asks exactly the questions it always asked, only on a page. FIRST_RUN includes the
// budget's amount and scope after the alert address; FINISH is the finishing steps (phase 15d2):
// admin email; repository; project name; use the proposed commands; channel; the three connector
// offers; "did the test alarm arrive?".
const FIRST_RUN = ["", "", "", "", "", "", "", "", "", "ops@example.com", "", "", "acme", "", "", "", "", true];
const SLACK = ["installed", TEST_BOT_TOKEN, TEST_SIGNING_SECRET, true, true];
const SIGNIN = ["", "1111111111.2222222222222", "fedcba9876543210fedcba9876543210", true];
const FINISH = [ADMIN_EMAIL, "acme/payments-api", "", true, "payments", false, false, false, true];
const LINEAR_KEY = `lin_api_${"k".repeat(40)}SECRETlinearKEY`;
// FINISH with Linear connected: yes to the offer, the key (typed on the page), the team (the
// default, the key's only team), then no to Jira and Asana.
const FINISH_WITH_LINEAR = [ADMIN_EMAIL, "acme/payments-api", "", true, "payments", true, LINEAR_KEY, "", false, false, true];

/** What the finishing steps read from the stacks: every deployed output, with the foundation's EC2
 * worker outputs as the real foundation stack has them (allStackOutputs's are placeholders). */
async function finishStackOutputs(name: string): Promise<Record<string, string> | undefined> {
  const outputs = allStackOutputs()[name];
  return outputs === undefined || name !== environmentStackName("staging", "foundation") ? outputs : { ...outputs, ...FOUNDATION_OUTPUTS };
}

async function harness() {
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
  // alert subscription and the $100 budget FIRST_RUN takes, and a turn received a day after T0.
  const projects = await tmp("agentx-init-ui-projects-");
  const plane = fakeControlPlane();
  plane.turns = [turn({ subject: "T0TEAM/C0PAY00001/1790000000.000100", receivedAt: new Date(T0 + 86_400_000).toISOString() })];
  const setup = setupServices({
    fetch: plane.fetch,
    repositories: fakeRepositories({ "acme/payments-api": { files: { "go.mod": "module example.com/pay" } } }),
    slackChannels: fakeSlackChannels([{ id: "C0PAY00001", name: "payments", isPrivate: false, isMember: true }]),
    alerts: fakeAlerts({ confirmAfterPolls: 0, budgetUsd: 100 }),
    stackOutputs: finishStackOutputs,
    configDir: projects,
  });
  const base: InitCliDependencies = {
    deploy: { identity: { get: async () => ({ account: "123456789012", arn: HOLDER }) }, store, secrets, deployer },
    initSecrets: secrets,
    checks: passingChecks(),
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
    store, secrets, deployer, github, plane, out, err, home, base, run, runUi,
    printed: () => `${out.join("")}${err.join("")}`,
    /** The terminal, every SSM value, this machine's environment cache, and the project files the
     * finishing steps wrote. */
    everywhere: async () => [
      out.join(""), err.join(""), ...store.values.values(), await readFile(environmentCachePath(home, "staging"), "utf8").catch(() => ""),
      ...(await Promise.all((await readdir(projects)).map((name) => readFile(join(projects, name), "utf8")))),
    ].join("\n"),
  };
}

describe("agentx init --ui", () => {
  it("runs the whole install from the page, with nothing typed in the terminal", async () => {
    const h = await harness();
    const { code, operator } = await h.runUi([...FIRST_RUN, ...SLACK, ...SIGNIN, ...FINISH]);
    expect(code).toBe(0);
    expect(operator.remaining()).toBe(0);
    expect(operator.fieldErrors).toEqual([]);
    // The page opened, and the questions it showed are init's own, in init's own order.
    expect(operator.opened[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?t=/);
    expect(operator.asked).toContain("Deploy engine");
    expect(operator.asked).toContain("Create all of this?");
    expect(operator.asked).toContain("Slack bot token");
    expect(operator.asked).toHaveLength(FIRST_RUN.length + SLACK.length + SIGNIN.length + FINISH.length);

    expect(h.deployer.requests.map((request) => request.part)).toEqual(["access", "foundation", "identity", "control-plane", "runtime", "slack"]);
    const progress = await readInstallProgress(h.store, "staging");
    expect(INIT_STEP_IDS.every((id) => progress?.steps[id]?.status === "done")).toBe(true);
    expect((await readEnvironmentSettings(h.store, "staging"))?.engine).toBe("templates");

    // FR-004: the checklist and the log pane both filled in from the run's own streams.
    const last = operator.states.at(-1);
    expect(last?.steps.map((step) => step.id)).toEqual([...INIT_STEP_IDS]);
    expect(operator.states.some((state) => state.steps.some((step) => step.status === "running"))).toBe(true);
    expect(operator.states.at(-1)?.steps.every((step) => step.status === "done")).toBe(true);
    expect(last?.log.join("\n")).toContain("done: Create and install the GitHub App");
  });

  it("FR-012: no secret typed on the page reaches the page's state, the log, the terminal, SSM or the cache", async () => {
    const h = await harness();
    // FINISH_WITH_LINEAR: the finishing steps' own secret, the Linear API key, is typed on the page too.
    const { code, operator } = await h.runUi([...FIRST_RUN, ...SLACK, ...SIGNIN, ...FINISH_WITH_LINEAR]);
    expect(code).toBe(0);
    expect(operator.remaining()).toBe(0);
    expect(operator.asked).toContain("Linear API key");
    const seen = JSON.stringify(operator.states);
    const everywhere = await h.everywhere();
    for (const secret of [TEST_BOT_TOKEN, TEST_SIGNING_SECRET, "fedcba9876543210fedcba9876543210", LINEAR_KEY]) {
      expect(secret.length).toBeGreaterThan(10);
      expect(seen).not.toContain(secret);
      expect(everywhere).not.toContain(secret);
    }
    // The secrets really were collected and stored, so the absence above means something.
    expect(h.secrets.values.get("agentx/staging/slack")).toContain(TEST_BOT_TOKEN);
    expect(JSON.parse(h.secrets.values.get("agentx/staging/connectors/linear") ?? "{}")).toEqual({ apiKey: LINEAR_KEY });
    expect(h.plane.credentials).toContainEqual({ ref: "linear", type: "static-secret", secretName: "agentx/staging/connectors/linear" });
  });

  it("FR-005: the priced plan is a review screen, and declining it creates nothing", async () => {
    const h = await harness();
    const { code, operator } = await h.runUi([...FIRST_RUN.slice(0, -1), false]);
    expect(code).not.toBe(0);
    // The plan and its confirm are on screen together: the confirm is the review screen's button.
    const review = operator.states.find((state) => state.plan !== undefined && state.question !== undefined);
    expect(review?.plan).toContain("Estimated monthly total");
    expect(review?.plan).toContain("AgentX will create environment staging in account 123456789012");
    expect(review?.question).toMatchObject({ kind: "confirm", text: "Create all of this?", defaultConfirm: false });
    // Nothing was created before it: no step had even started when the plan went up.
    expect(review?.steps.every((step) => step.status === "pending")).toBe(true);
    expect(h.deployer.requests).toEqual([]);
    expect(h.store.values.has(installAnswersParameterName("staging"))).toBe(false);
    expect(h.printed()).toContain("install declined; nothing was created");
    expect(operator.states.at(-1)).toMatchObject({ phase: "failed" });
  });

  it("FR-006: a part-finished install opens on a resume screen naming what is done and what is next", async () => {
    const h = await harness();
    h.deployer.fail.set(environmentStackName("staging", "control-plane"), new Error("Resource limit exceeded"));
    expect(await h.run([], { prompter: scriptedPrompter(FIRST_RUN) })).not.toBe(0);
    h.deployer.fail.clear();

    const { code, operator } = await h.runUi([...SLACK, ...SIGNIN, ...FINISH]);
    expect(code).toBe(0);
    const resume = operator.states.find((state) => state.resume !== undefined)?.resume;
    expect(resume?.completed).toEqual([
      "Check prerequisites",
      "Deploy the access stack (IAM roles, artifact bucket, image cache)",
      "Deploy the foundation and identity stacks",
      "Create and install the GitHub App",
    ]);
    expect(resume?.continueFrom).toBe("Deploy the control plane and runtime");
    // The resumed run reuses the app the first one made, exactly as the terminal path does.
    expect(h.github.conversions).toHaveLength(1);
  });

  it("FR-003: a rejected answer comes back on the field instead of ending the run", async () => {
    const h = await harness();
    const script = [...FIRST_RUN];
    // The alert email address, with a typo first.
    script.splice(9, 1, "not-an-email", "ops@example.com");
    const { code, operator } = await h.runUi([...script, ...SLACK, ...SIGNIN, ...FINISH]);
    expect(code).toBe(0);
    // Once from the POST's own reply, once on the question that came back carrying it.
    expect(operator.fieldErrors).toEqual(["must be an email address", "must be an email address"]);
    expect(operator.asked.filter((question) => question === "Alert email address")).toHaveLength(2);
  });

  it("--ui and --yes are refused together, and --no-ui is the terminal path", async () => {
    const h = await harness();
    expect(await h.run(["--ui", "--yes"])).not.toBe(0);
    expect(h.printed()).toContain("agentx init --ui asks its questions on a page; --yes answers them without asking");
    expect(await h.run(["--no-ui"], { prompter: scriptedPrompter([...FIRST_RUN, ...SLACK, ...SIGNIN, ...FINISH]) })).toBe(0);
  });

  it("asks the finishing steps' questions on the page, and ends the page on the developer sign-in command", async () => {
    const h = await harness();
    const { code, operator } = await h.runUi([...FIRST_RUN, ...SLACK, ...SIGNIN, ...FINISH]);
    expect(code).toBe(0);
    expect(operator.remaining()).toBe(0);
    // Every finishing question and confirmation was a field on the page, in the steps' own order.
    const finishing = operator.asked.slice(FIRST_RUN.length + SLACK.length + SIGNIN.length);
    expect(finishing).toHaveLength(FINISH.length);
    expect(finishing[0]).toBe("Your email address, for your AgentX admin user");
    expect(finishing).toContain("Connect Linear to payments-api now? (You can add it later with agentx connector add linear)");
    // Nothing was asked in the terminal: no scripted terminal prompter exists in this run, and the
    // terminal output carries no question text.
    expect(h.printed()).not.toContain("Your email address, for your AgentX admin user");
    expect(h.plane.bindings).toEqual(["T0TEAM/C0PAY00001"]);
    // The finishing steps' progress lines reached the page's log pane.
    const last = operator.states.at(-1);
    expect(last?.log.join("\n")).toContain("done: Set up the first project and its channel");
    expect(last?.log.join("\n")).toContain("done: Check that AgentX answers in Slack");
    // The page ends on the same summary the terminal does, developer sign-in command and all.
    expect(last).toMatchObject({ phase: "finished" });
    expect(last?.outcome).toContain("AgentX environment staging is ready.");
    expect(last?.outcome).toContain("  Talk to it: mention <@U0BOT> in #payments (project payments-api, revision 1).");
    expect(last?.outcome).toContain("  Developers sign in with: npx @charterarc/agentx login https://abc123.execute-api.us-east-1.amazonaws.com");
    expect(h.out.join("")).toContain("  Developers sign in with: npx @charterarc/agentx login https://abc123.execute-api.us-east-1.amazonaws.com\n");
  });

  it("--from-bundle works through the page: only what the export did not know is asked there, and a bad bundle is refused before the page opens", async () => {
    const h = await harness();
    const dir = await tmp("agentx-init-ui-bundle-");
    await writeFile(join(dir, "init-answers.json"), JSON.stringify({
      schemaVersion: 1, env: "staging", region: "us-east-1", account: "123456789012", engine: "templates", releaseVersion: "1.2.3",
      identity: { mode: "cognito" }, models: { orchestrator: "us.anthropic.claude-sonnet-4-6", classifier: "amazon.nova-lite-v1:0", worker: "amazon.nova-pro-v1:0" },
    }));
    // A bundle for another environment is refused before the wizard starts: no page is opened.
    const wrong = await tmp("agentx-init-ui-bundle-dev-");
    await writeFile(join(wrong, "init-answers.json"), (await readFile(join(dir, "init-answers.json"), "utf8")).replace('"env":"staging"', '"env":"dev"'));
    const refused = fakeWizardOperator([]);
    expect(await h.run(["--ui", "--resume", "--from-bundle", wrong], { openBrowser: refused.open })).not.toBe(0);
    expect(refused.opened).toEqual([]);
    expect(h.printed()).toContain("the bundle is for environment dev; pass --env dev");

    // The platform team's access stack exists already; the run stops after it, at foundation.
    const deployer = scriptedDeployer(allStackOutputs(), [environmentStackName("staging", "access")]);
    deployer.fail.set(environmentStackName("staging", "foundation"), new Error("stop after access"));
    const operator = fakeWizardOperator(["", "ops@example.com", "", "", "acme", "", "", "", "", true]);
    const code = await h.run(["--ui", "--resume", "--from-bundle", dir], {
      openBrowser: operator.open,
      stackStatus: { status: async (name: string) => (name === "agentx-staging-access" ? "CREATE_COMPLETE" : undefined) },
      deploy: { identity: { get: async () => ({ account: "123456789012", arn: "arn:aws:sts::123456789012:assumed-role/agentx-staging-operator/alice" }) }, store: h.store, secrets: h.secrets, deployer },
    });
    await operator.settled();
    expect(code).not.toBe(0);
    expect(operator.remaining()).toBe(0);
    expect(operator.asked).toContain("Alert email address");
    expect(operator.asked).toContain("Create all of this?");
    expect(operator.asked).not.toContain("Deploy engine");
    expect(operator.states.at(-1)).toMatchObject({ phase: "failed" });
    expect(operator.states.at(-1)?.outcome).toContain("stop after access");
    expect((await readInstallProgress(h.store, "staging"))?.steps.access).toMatchObject({ status: "done", note: "deployed by your platform team from the export bundle" });
    expect(deployer.requests.map((request) => request.part)).toEqual(["foundation"]);
  });

  it("Q5: every other site is a button on the page, and the installer opens only the page itself", async () => {
    const h = await harness();
    const { code, operator } = await h.runUi([...FIRST_RUN, ...SLACK, ...SIGNIN, ...FINISH]);
    expect(code).toBe(0);
    expect(operator.opened).toHaveLength(1);
    expect(operator.opened[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?t=/);
    expect(operator.clicked).toContain("https://github.com/apps/agentx-acme-staging/installations/new");
    expect(operator.clicked).toContain("https://api.slack.com/apps/A0APP/event-subscriptions");
    expect(operator.clicked.some((url) => /^http:\/\/127\.0\.0\.1:\d+\/github\/start/.test(url))).toBe(true);
  });

  it("the terminal path still opens every site in the system browser", async () => {
    const h = await harness();
    const opened: string[] = [];
    expect(await h.run([], { prompter: scriptedPrompter([...FIRST_RUN, ...SLACK, ...SIGNIN, ...FINISH]), openBrowser: browserThatCreatesGitHubApp(opened) })).toBe(0);
    expect(opened).toContain("https://github.com/apps/agentx-acme-staging/installations/new");
    expect(opened).toContain("https://api.slack.com/apps/A0APP/event-subscriptions");
  });

  it("FR-020: asks which AWS profile on the page, uses it, and shows the account before anything is created", async () => {
    const h = await harness();
    await mkdir(join(h.home, ".aws"), { recursive: true });
    await writeFile(join(h.home, ".aws", "config"), "[default]\nregion = us-east-1\n[profile dev]\nsso_session = acme\n");
    const processEnv: NodeJS.ProcessEnv = {};
    const operator = fakeWizardOperator(["dev", ...FIRST_RUN, ...SLACK, ...SIGNIN, ...FINISH]);
    expect(await h.run(["--ui"], { openBrowser: operator.open, processEnv })).toBe(0);
    await operator.settled();
    expect(operator.asked[0]).toBe("AWS profile to install with");
    expect(processEnv.AWS_PROFILE).toBe("dev");
    // The account is on the page by the time the review screen asks to create anything.
    const review = operator.states.find((state) => state.question?.text === "Create all of this?");
    expect(review?.cards?.find((card) => card.id === "aws")?.lines[0]).toBe("AgentX installs into account 123456789012 in us-east-1.");
  });

  it("FR-022: the region picker offers only the release's regions", async () => {
    const h = await harness();
    // No --region, so the region is the first question; then the first-run answers, and no to the plan.
    const operator = fakeWizardOperator(["", ...FIRST_RUN.slice(0, -1), false]);
    await executeCli(["--env", "staging", "init", "--release", await releaseDir(), "--ui"], {
      stdout: { write: () => undefined }, stderr: { write: () => undefined }, environments: { home: h.home },
      init: { ...h.base, openBrowser: operator.open },
    });
    await operator.settled();
    const region = operator.states.find((state) => state.question?.text === "AWS region")?.question;
    expect(region?.choices?.map((choice) => choice.value)).toEqual(["us-east-1"]);
  });

  it("FR-023: a failed prerequisite is a checklist on the page, and checking again after the fix goes on", async () => {
    const h = await harness();
    let quotaReads = 0;
    const checks = passingChecks({ ec2Quota: async () => { quotaReads += 1; return quotaReads === 1 ? 0 : 32; } });
    // Every first-run answer, then "Check the prerequisites again?" yes, then the review screen.
    const operator = fakeWizardOperator([...FIRST_RUN.slice(0, -1), true, true, ...SLACK, ...SIGNIN, ...FINISH]);
    expect(await h.run(["--ui"], { openBrowser: operator.open, checks })).toBe(0);
    await operator.settled();
    expect(operator.asked).toContain("Check the prerequisites again?");
    const cards = operator.states.flatMap((state) => state.cards?.filter((card) => card.id === "prerequisites") ?? []);
    const failed = cards.find((card) => card.status === "failed");
    expect(failed?.checks?.find((check) => check.label === "EC2 vCPU quota")).toMatchObject({ ok: false });
    // Review Focus 5: the card after the fix lists only the new results.
    const last = cards.at(-1);
    expect(last?.status).toBe("ok");
    expect(last?.checks?.every((check) => check.ok)).toBe(true);
    expect(last?.checks?.filter((check) => check.label === "EC2 vCPU quota")).toHaveLength(1);
    // Every check ran again, not only the one that failed.
    expect(last?.checks?.map((check) => check.label)).toEqual(failed?.checks?.map((check) => check.label));
    expect(last?.checks?.map((check) => check.label).slice(0, 3)).toEqual(["Region", "EC2 vCPU quota", "Elastic IPs"]);
    expect(last?.checks?.some((check) => check.label.startsWith("Model "))).toBe(true);
  });

  it("FR-023: saying no to checking again creates nothing", async () => {
    const h = await harness();
    const operator = fakeWizardOperator([...FIRST_RUN.slice(0, -1), false]);
    expect(await h.run(["--ui"], { openBrowser: operator.open, checks: passingChecks({ ec2Quota: async () => 0 }) })).not.toBe(0);
    await operator.settled();
    expect(h.printed()).toContain("init cannot start; nothing was created");
    expect(h.deployer.requests).toEqual([]);
    expect(h.store.values.has(installAnswersParameterName("staging"))).toBe(false);
  });

  it("FR-023: a failure no check reports is still on the checklist, in the error's own words", async () => {
    const h = await harness();
    const checks = passingChecks({ cdkBootstrapped: async () => false, runCdkBootstrap: async () => { throw new Error("CDKToolkit stack creation was rolled back"); } });
    // --engine cdk skips the engine question; then yes to "Run cdk bootstrap ... now?", and no to checking again.
    const operator = fakeWizardOperator([...FIRST_RUN.slice(1, -1), true, false]);
    expect(await h.run(["--ui", "--engine", "cdk", "--source", await tmp("agentx-init-ui-source-")], { openBrowser: operator.open, checks })).not.toBe(0);
    await operator.settled();
    expect(operator.asked).toContain("Check the prerequisites again?");
    const failed = operator.states.flatMap((state) => state.cards?.filter((card) => card.id === "prerequisites" && card.status === "failed") ?? []).at(-1);
    expect(failed?.checks?.find((check) => !check.ok)).toEqual({ label: "Prerequisites", ok: false, detail: "CDKToolkit stack creation was rolled back" });
    expect(h.deployer.requests).toEqual([]);
  });

  it("FR-030 and FR-031: the GitHub App is created and installed through the wizard's own address, shown as cards", async () => {
    const h = await harness();
    const { code, operator } = await h.runUi([...FIRST_RUN, ...SLACK, ...SIGNIN, ...FINISH]);
    expect(code).toBe(0);
    const wizardOrigin = new URL(operator.opened[0] ?? "").origin;
    expect(operator.clicked).toContain(`${wizardOrigin}/github/start?t=${new URL(operator.opened[0] ?? "").searchParams.get("t") ?? ""}`);
    expect(h.github.conversions).toEqual(["0123456789abcdef0123"]);
    const stages = operator.states.flatMap((state) => state.cards?.filter((card) => card.id === "github").map((card) => card.lines[0]) ?? []);
    // The app's name is the first run's default ("AgentX <account> <env>"); its slug is GitHub's.
    expect(stages).toContain('Create the GitHub App "AgentX acme staging" for acme. GitHub opens with everything filled in; press Create GitHub App.');
    expect(stages).toContain("Install agentx-acme-staging on acme and choose the repositories AgentX may use.");
    expect(stages.at(-1)).toBe("agentx-acme-staging is installed on acme.");
  });
});
