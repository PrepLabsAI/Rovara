// SC-003: a full `agentx init --ui` install driven entirely from the page, with nothing typed in
// the terminal after the command. The wizard server and the GitHub manifest listener are both
// real, on 127.0.0.1; every AWS, GitHub, Slack and clock dependency is injected, so nothing here
// reaches AWS, GitHub or Slack.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { environmentStackName } from "@agentx/contracts";
import { executeCli } from "../../packages/cli/src/main.js";
import { prepareDeployment } from "../../packages/cli/src/deploy/commands.js";
import type { InitCliDependencies } from "../../packages/cli/src/init/commands.js";
import { READY_HOLD_MS, READY_OUTCOME, holdReadyScreen } from "../../packages/cli/src/init/commands.js";
import { NO_BROWSER_LINE } from "../../packages/cli/src/init/ui-mode.js";
import { installAnswersParameterName, readInstallProgress, writeInstallAnswers, type InitAnswers } from "../../packages/cli/src/init/install-state.js";
import { allStackOutputs, fakeGitHubApi, fakeSlackApi, passingChecks, sampleAnswers, scriptedDeployer, scriptedPrompter, TEST_BOT_TOKEN, TEST_SIGNING_SECRET } from "../support/init-fakes.js";
import { fakeWizardOperator } from "../support/wizard-browser.js";
import { ADMIN_EMAIL } from "../support/setup-fakes.js";
import { markOperatorStop } from "../../packages/cli/src/init/stop.js";
import { WIZARD_TOKEN_HEADER, type WizardPlan, type WizardSnapshot } from "../../packages/cli/src/init/ui/protocol.js";
import { FINISH, FIRST_RUN, harness, releaseDir, SETTINGS, SIGNIN, SLACK, SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, TERMINAL_FIRST_RUN, TERMINAL_SLACK } from "../support/init-ui-harness.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const tmp = async (prefix: string) => { const dir = await mkdtemp(join(tmpdir(), prefix)); dirs.push(dir); return dir; };

const LINEAR_KEY = `lin_api_${"k".repeat(40)}SECRETlinearKEY`;
// FINISH with Linear connected: yes to the offer, the key (typed on the page), the team (the
// default, the key's only team), then no to Jira and Asana.
const FINISH_WITH_LINEAR = ["acme/payments-api", "", true, "payments", true, LINEAR_KEY, "", false, false, true];

describe("agentx init --ui", () => {
  it("FR-009: the page is open before the release is fetched, so a failed download is a failure screen", async () => {
    const h = await harness();
    const operator = fakeWizardOperator([]);
    const missing: typeof fetch = async () => new Response("not found", { status: 404 });
    const code = await executeCli(["--env", "staging", "init", "--region", "us-east-1", "--ui"], {
      stdout: { write: () => undefined }, stderr: { write: (text: string) => h.err.push(text) }, environments: { home: h.home },
      init: { ...h.base, releaseVersion: "9.9.9", fetch: missing, openBrowser: operator.open },
    });
    await operator.settled();
    expect(code).not.toBe(0);
    expect(operator.states.some((state) => state.failure?.what.toLowerCase().includes("release 9.9.9 was not found"))).toBe(true);
    expect(h.err.join("")).toMatch(/^The AgentX installer is open in your browser: http:\/\/127\.0\.0\.1:/m);
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

  it("FR-006: a part-finished install opens on a resume screen naming what is done and what is next", async () => {
    const h = await harness();
    h.deployer.fail.set(environmentStackName("staging", "control-plane"), new Error("Resource limit exceeded"));
    expect(await h.run([], { prompter: scriptedPrompter(TERMINAL_FIRST_RUN) })).not.toBe(0);
    h.deployer.fail.clear();

    const { code, operator } = await h.runUi([...SLACK, ...SIGNIN, ...FINISH]);
    expect(code).toBe(0);
    const resume = operator.states.find((state) => state.resume !== undefined)?.resume;
    expect(resume?.completed).toEqual([
      "Check your account and choices",
      "Set up AWS permissions",
      "Build the network and sign-in",
    ]);
    expect(resume?.continueFrom).toBe("Start the Rovara service");
    // The first run stopped before the GitHub app step, so the app is made once, by the resumed run.
    expect(h.github.conversions).toHaveLength(1);
  });

  it("--ui and --yes are refused together, and --no-ui is the terminal path", async () => {
    const h = await harness();
    expect(await h.run(["--ui", "--yes"])).not.toBe(0);
    expect(h.printed()).toContain("agentx init --ui asks its questions on a page; --yes answers them without asking");
    expect(await h.run(["--no-ui"], { prompter: scriptedPrompter([...TERMINAL_FIRST_RUN, ...TERMINAL_SLACK, ...SIGNIN, ...FINISH]) })).toBe(0);
  });

  it("--from-bundle works through the page: only what the export did not know is asked there, and a bad bundle is refused before the page opens", async () => {
    const h = await harness();
    const dir = await tmp("agentx-init-ui-bundle-");
    await writeFile(join(dir, "init-answers.json"), JSON.stringify({
      schemaVersion: 1, env: "staging", region: "us-east-1", account: "123456789012", engine: "templates", releaseVersion: "1.2.3",
      identity: { mode: "cognito" }, models: { orchestrator: "us.anthropic.claude-sonnet-4-6", classifier: "us.anthropic.claude-haiku-4-5-20251001-v1:0", worker: "us.anthropic.claude-sonnet-4-6" },
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
    // The settings form (only what the export did not know), the plan, then Stop for now.
    const operator = fakeWizardOperator([...FIRST_RUN, "stop"]);
    const code = await h.run(["--ui", "--resume", "--from-bundle", dir], {
      openBrowser: operator.open,
      stackStatus: { status: async (name: string) => (name === "agentx-staging-access" ? "CREATE_COMPLETE" : undefined) },
      deploy: { identity: { get: async () => ({ account: "123456789012", arn: "arn:aws:sts::123456789012:assumed-role/agentx-staging-operator/alice" }) }, store: h.store, secrets: h.secrets, deployer },
    });
    await operator.settled();
    expect(code).not.toBe(0);
    expect(operator.remaining()).toBe(0);
    expect(operator.asked).toContain("Your settings");
    const form = operator.states.map((state) => state.question).find((question) => question?.kind === "form" && question.text === "Your settings");
    expect(form?.fields?.map((field) => field.name)).toContain("alertEmail");
    expect(form?.fields?.map((field) => field.name)).not.toContain("engine");
    expect(operator.asked).toContain("Create all of this?");
    expect(operator.asked).not.toContain("Deploy engine");
    expect(operator.states.at(-1)).toMatchObject({ phase: "failed" });
    expect(operator.states.flatMap((state) => (state.failure === undefined ? [] : [state.failure])).at(-1)?.details[0]).toContain("stop after access");
    expect((await readInstallProgress(h.store, "staging"))?.steps.access).toMatchObject({ status: "done", note: "deployed by your platform team from the export bundle" });
    expect(deployer.requests.map((request) => request.part)).toEqual(["foundation"]);
  });

  it("spec 048 FR-060: a deployment that failed to prepare (npm ci, build or synth) is prepared again on Try this step again", async () => {
    const h = await harness();
    let prepared = 0;
    let cleanedUp = 0;
    const prepare: InitCliDependencies["prepareDeployment"] = async (input) => {
      prepared += 1;
      if (prepared === 1) throw new Error("npm ci exited with code 1");
      return { ...(await prepareDeployment(input)), cleanup: async () => { cleanedUp += 1; } };
    };
    const operator = fakeWizardOperator([...FIRST_RUN, "retry", ...SLACK, ...SIGNIN, ...FINISH]);
    expect(await h.run(["--ui"], { openBrowser: operator.open, prepareDeployment: prepare })).toBe(0);
    await operator.settled();
    expect(operator.remaining()).toBe(0);
    expect(prepared).toBe(2);
    expect(cleanedUp).toBe(1);
  });

  it("spec 048 FR-060: a failure outside a step still shows the screen, with Stop for now only", async () => {
    const h = await harness();
    const operator = fakeWizardOperator(["stop"]);
    expect(await h.run(["--ui", "--account", "999999999999"], { openBrowser: operator.open })).not.toBe(0);
    await operator.settled();
    const failing = operator.states.find((state) => state.failure !== undefined && state.question !== undefined);
    expect(failing?.failure?.what).toBe("The install could not go on.");
    expect(failing?.failure?.details[0]).toContain("--account 999999999999 does not match your AWS credentials");
    expect(failing?.question?.buttons?.map((button) => button.label)).toEqual(["Stop for now"]);
  });

  // Fix round 1 (Plan ruling 8): a step's own run throwing a stop the person already chose (a
  // deploy step marked with markOperatorStop, the same way a declined "check again" question
  // inside a step marks its error) is not a failure; the page shows no failure screen and asks no
  // second question for it.
  it("spec 048 FR-060 fix: a stop the deploy step itself chose shows no failure screen or question", async () => {
    const h = await harness();
    h.deployer.fail.set(environmentStackName("staging", "control-plane"), markOperatorStop(new Error("the person chose not to continue")));
    const operator = fakeWizardOperator([...FIRST_RUN]);
    expect(await h.run(["--ui"], { openBrowser: operator.open })).not.toBe(0);
    await operator.settled();
    expect(operator.remaining()).toBe(0);
    expect(operator.states.every((state) => state.failure === undefined)).toBe(true);
    expect(operator.asked).not.toContain("The install stopped. What next?");
    const last = operator.states.at(-1);
    expect(last).toMatchObject({ phase: "failed" });
    expect(last?.commands).toEqual([{ label: "Continue later with", command: "node /opt/agentx/dist/main.js --env staging init --region us-east-1" }]);
  });

  it("FR-022: the region picker offers only the release's regions", async () => {
    const h = await harness();
    // No --region, so the region is the first question; then the first-run answers, through to the end.
    const operator = fakeWizardOperator(["", ...FIRST_RUN, ...SLACK, ...SIGNIN, ...FINISH]);
    await executeCli(["--env", "staging", "init", "--release", await releaseDir(), "--ui"], {
      stdout: { write: () => undefined }, stderr: { write: () => undefined }, environments: { home: h.home },
      init: { ...h.base, openBrowser: operator.open },
    });
    await operator.settled();
    const region = operator.states.find((state) => state.question?.text === "AWS region")?.question;
    expect(region?.choices?.map((choice) => choice.value)).toEqual(["us-east-1"]);
  });

  it("FR-022: with no AWS_REGION, the picked profile's region is the region question's default", async () => {
    const h = await harness();
    await mkdir(join(h.home, ".aws"), { recursive: true });
    await writeFile(join(h.home, ".aws", "config"), "[default]\nregion = us-east-1\n[profile dev]\nsso_session = acme\nregion = us-west-2\n");
    // The profile, then the region (us-east-1, not the default), then the first-run answers, through to the end.
    const operator = fakeWizardOperator(["dev", "us-east-1", ...FIRST_RUN, ...SLACK, ...SIGNIN, ...FINISH]);
    await executeCli(["--env", "staging", "init", "--release", await releaseDir(["us-east-1", "us-west-2"]), "--ui"], {
      stdout: { write: () => undefined }, stderr: { write: () => undefined }, environments: { home: h.home },
      init: { ...h.base, openBrowser: operator.open, processEnv: {} },
    });
    await operator.settled();
    const region = operator.states.find((state) => state.question?.text === "AWS region")?.question;
    expect(region?.choices?.map((choice) => choice.value)).toEqual(["us-east-1", "us-west-2"]);
    expect(region?.defaultValue).toBe("us-west-2");
  });

  it("FR-018 and SC-009: stopping at the account checks asks no setting and creates nothing", async () => {
    const h = await harness();
    const operator = fakeWizardOperator([false]);
    expect(await h.run(["--ui"], { openBrowser: operator.open, checks: passingChecks({ ec2Quota: async () => 0 }) })).not.toBe(0);
    await operator.settled();
    expect(operator.asked).toEqual(["Check your AWS account again?"]);
    expect(h.printed()).toContain("init cannot start; nothing was created");
    expect(h.deployer.requests).toEqual([]);
    expect(h.store.values.has(installAnswersParameterName("staging"))).toBe(false);
  });

  it("FR-028: an answer check that fails offers Change answers, and the settings come back with every answer kept", async () => {
    const h = await harness();
    // Spread from the harness's own fake, so the conversions counted below are this run's.
    const github = { ...h.github, owner: async (login: string) => (login === "acme" ? { login: "acme", type: "Organization" as const } : undefined) };
    const wrong = JSON.stringify({ email: ADMIN_EMAIL, githubAccount: "acmee", alertEmail: "ops@example.com" });
    const operator = fakeWizardOperator([wrong, "organization", "change", SETTINGS, "create", ...SLACK, ...SIGNIN, ...FINISH]);
    expect(await h.run(["--ui"], { openBrowser: operator.open, github })).toBe(0);
    await operator.settled();
    const forms = operator.states.map((state) => state.question).filter((question) => question?.kind === "form" && question.text === "Your settings");
    const second = forms.find((question) => question?.fields?.find((field) => field.name === "githubAccount")?.value === "acmee");
    expect(second?.fields?.find((field) => field.name === "email")?.value).toBe(ADMIN_EMAIL);
    const failed = operator.states.flatMap((state) => state.cards ?? []).find((card) => card.id === "prerequisites" && card.status === "failed");
    expect(failed?.checks?.find((check) => check.label === "GitHub owner")?.detail).toBe("GitHub has no organization or user named acmee. Check the spelling.");
    expect(h.github.conversions).toHaveLength(1); // the app was made once, after the fix
  });

  it("FR-029 and Review Focus 2: Change answers keeps every answer and recomputes an app name the user never typed", async () => {
    const h = await harness();
    const github = { ...fakeGitHubApi({ owner: "acme-labs" }), owner: async (login: string) => ({ login, type: "Organization" as const }) };
    const moved = JSON.stringify({ email: ADMIN_EMAIL, githubAccount: "acme-labs", alertEmail: "ops@example.com" });
    const operator = fakeWizardOperator([SETTINGS, "change", moved, "create"], { beforeAnswer: async (question) => { if (question.text === "Create all of this?" && h.store.values.size > 0) throw new Error("test setup: something was saved before Create AgentX"); } });
    // --stop-after prerequisites: the run ends before the GitHub step, which is all this test needs.
    expect(await h.run(["--ui", "--stop-after", "prerequisites"], { openBrowser: operator.open, github })).toBe(0);
    await operator.settled();
    const plans = operator.states.map((state) => state.plan).filter((plan): plan is WizardPlan => plan !== undefined);
    expect(plans[0]?.sections[1]?.lines[0]).toContain("\"Rovara acme (staging)\" owned by acme.");
    expect(plans.at(-1)?.sections[1]?.lines[0]).toContain("\"Rovara acme-labs (staging)\" owned by acme-labs.");
    const second = operator.states.map((state) => state.question).filter((question) => question?.text === "Your settings")[1];
    expect(second?.fields?.find((field) => field.name === "email")?.value).toBe(ADMIN_EMAIL);
    expect(second?.fields?.find((field) => field.name === "alertEmail")?.value).toBe("ops@example.com");
    expect(second?.fields?.find((field) => field.name === "appName")?.value).toBe("");
    const answers = JSON.parse(h.store.values.get(installAnswersParameterName("staging")) ?? "{}") as InitAnswers;
    expect(answers.github).toEqual({ account: "acme-labs", accountType: "organization", appName: "Rovara acme-labs (staging)" });
  });

  it("FR-020: a new install name is the install's name from then on, and a used one is refused", async () => {
    const h = await harness();
    const renamed = JSON.stringify({ email: ADMIN_EMAIL, githubAccount: "acme", installName: "trial", alertEmail: "ops@example.com" });
    const operator = fakeWizardOperator([renamed, "create"]);
    expect(await h.run(["--ui", "--stop-after", "prerequisites"], { openBrowser: operator.open })).toBe(0);
    await operator.settled();
    expect(h.store.values.has(installAnswersParameterName("trial"))).toBe(true);
    expect(h.store.values.has(installAnswersParameterName("staging"))).toBe(false);
    expect(operator.states.at(-1)?.header.installName).toBe("trial");

    const again = await harness();
    await writeInstallAnswers(again.store, sampleAnswers({ env: "trial" }));
    const refused = fakeWizardOperator([renamed, "stop"]);
    expect(await again.run(["--ui"], { openBrowser: refused.open })).not.toBe(0);
    await refused.settled();
    const card = refused.states.flatMap((state) => state.cards ?? []).find((each) => each.id === "prerequisites" && each.status === "failed");
    expect(card?.checks?.find((check) => check.label === "Install name")?.detail).toBe("This AWS account and region already have an AgentX install named trial. Choose another install name.");
  });

  it("FR-023: a failure no check reports is still on the checklist, in the error's own words", async () => {
    const h = await harness();
    const checks = passingChecks({ cdkBootstrapped: async () => false, runCdkBootstrap: async () => { throw new Error("CDKToolkit stack creation was rolled back"); } });
    // --engine cdk leaves the engine out of the settings form; then yes to "Run cdk bootstrap ... now?", and Stop for now (spec 048 FR-028).
    const operator = fakeWizardOperator([...FIRST_RUN.slice(0, -1), true, "stop"]);
    // Issue 152: init checks --source is a clean checkout of the release's tag before the
    // prerequisites, so the source is one: an empty commit tagged v1.2.3, the harness release's version.
    const source = await tmp("agentx-init-ui-source-");
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { cwd: source, stdio: "ignore" });
    git("init", "-q");
    git("commit", "-q", "--allow-empty", "-m", "release");
    git("tag", "v1.2.3");
    expect(await h.run(["--ui", "--engine", "cdk", "--source", source], { openBrowser: operator.open, checks })).not.toBe(0);
    await operator.settled();
    expect(operator.asked).toContain("Your answers need a change. What next?");
    const failed = operator.states.flatMap((state) => state.cards?.filter((card) => card.id === "prerequisites" && card.status === "failed") ?? []).at(-1);
    expect(failed?.checks?.find((check) => !check.ok)).toEqual({ label: "Prerequisites", ok: false, detail: "CDKToolkit stack creation was rolled back" });
    expect(h.deployer.requests).toEqual([]);
  });

  it("Q8: the terminal path still stops when Slack refuses the token", async () => {
    const h = await harness();
    const slack = fakeSlackApi({ authTest: async () => ({ ok: false, error: "invalid_auth" }) });
    expect(await h.run([], { prompter: scriptedPrompter([...TERMINAL_FIRST_RUN, "installed", SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, TEST_SIGNING_SECRET, TEST_BOT_TOKEN]), slack })).not.toBe(0);
    expect(h.printed()).toContain("Slack refused the bot token (invalid_auth); copy it again from OAuth & Permissions");
  });

  it("FR-050 and Q5: the admin sign-in page is a button on the install page, never a tab opened by itself", async () => {
    const h = await harness();
    const SIGN_IN = "https://auth.example.test/oauth2/authorize?client_id=c&state=s";
    const login: typeof h.setup.login = async (options) => { await options.openBrowser?.(SIGN_IN); return h.setup.login(options); };
    const operator = fakeWizardOperator([...FIRST_RUN, ...SLACK, ...SIGNIN, ...FINISH]);
    expect(await h.run(["--ui"], { openBrowser: operator.open, setup: { ...h.setup, login } })).toBe(0);
    await operator.settled();
    expect(operator.clicked).toContain(SIGN_IN);
    expect(operator.opened).toHaveLength(1);
    const during = operator.states.find((state) => state.link?.url === SIGN_IN);
    expect(during?.link?.label).toBe("Open auth.example.test");
    expect(during?.cards?.find((card) => card.id === "admin")?.status).toBe("waiting");
  });

  it("spec 048 FR-058 and FR-059: the ready screen is shown once, and the installer stays up until Close installer or 30 minutes", async () => {
    const h = await harness();
    let during: WizardSnapshot | undefined;
    const operator = fakeWizardOperator([...FIRST_RUN, ...SLACK, ...SIGNIN, ...FINISH]);
    const code = await h.run(["--ui"], {
      openBrowser: operator.open,
      sleep: async (ms) => {
        if (ms !== READY_HOLD_MS) return h.advance(ms);
        const { origin, searchParams } = new URL(operator.opened[0] ?? "http://x");
        during = (await (await fetch(`${origin}/state`, { headers: { [WIZARD_TOKEN_HEADER]: searchParams.get("t") ?? "" } })).json()) as WizardSnapshot;
      },
    });
    await operator.settled();
    expect(code).toBe(0);
    const ready = during?.cards?.find((card) => card.id === "ready");
    expect(ready?.status).toBe("ok");
    expect(during?.outcome).toBe(READY_OUTCOME);
    for (const line of ready?.lines ?? []) expect(during?.outcome ?? "").not.toContain(line);
  });

  it("holds until Close installer, and no longer", async () => {
    let resolveClose: () => void = () => undefined;
    const closeRequested = new Promise<void>((resolvePromise) => { resolveClose = resolvePromise; });
    const waited: number[] = [];
    const holding = holdReadyScreen({ closeRequested, ms: READY_HOLD_MS, sleep: (ms) => { waited.push(ms); return new Promise(() => undefined); } });
    resolveClose();
    await holding;
    expect(waited).toEqual([30 * 60_000]);
  });

  it("--json with the page prints the result without the page's own internal flag", async () => {
    const h = await harness();
    const { code } = await h.runUi([...FIRST_RUN], ["--stop-after", "prerequisites", "--json"]);
    expect(code).toBe(0);
    const printed = JSON.parse(h.out.join("")) as { ok: boolean; data: Record<string, unknown> };
    expect(printed.ok).toBe(true);
    expect(printed.data).toMatchObject({ status: "complete", env: "staging", stoppedAfter: "prerequisites" });
    expect(printed.data).not.toHaveProperty("pageMode");
  });

  // The terminal path refuses without a TTY; a developer running the suite with one attached would
  // be asked on stdin instead, so the test runs only where stdin is not a TTY (always, in CI).
  it.skipIf(process.stdin.isTTY === true)("User Story 4: with no browser, the terminal asks, after one line saying how to get the page", async () => {
    const h = await harness();
    const refused = fakeWizardOperator([]);
    // No TTY in the test process: the terminal path refuses, as before, but only after the line.
    expect(await h.run([], { openBrowser: refused.open, isInteractive: () => true, browserAvailable: () => false })).not.toBe(0);
    expect(refused.opened).toEqual([]);
    expect(h.printed()).toContain("No browser here, so agentx init asks in this terminal. To use the install page instead, run agentx init --ui --no-browser and open the address it prints (over SSH, forward its port with ssh -L).");
  });

  it.skipIf(process.stdin.isTTY === true)("--no-browser with neither flag is the terminal, with the same line", async () => {
    const h = await harness();
    const none = fakeWizardOperator([]);
    expect(await h.run(["--no-browser"], { openBrowser: none.open, isInteractive: () => true, browserAvailable: () => true })).not.toBe(0);
    expect(none.opened).toEqual([]);
    expect(h.printed()).toContain("No browser here, so agentx init asks in this terminal.");
  });

  it.skipIf(process.stdin.isTTY === true)("over SSH (the run's own environment) the default is the terminal, with the same line", async () => {
    const h = await harness();
    const none = fakeWizardOperator([]);
    // No browserAvailable override: the SSH_CONNECTION below reaches it only through processEnv.
    expect(await h.run([], { openBrowser: none.open, isInteractive: () => true, processEnv: { SSH_CONNECTION: "10.0.0.2 51000 10.0.0.1 22" } })).not.toBe(0);
    expect(none.opened).toEqual([]);
    expect(h.printed()).toContain(NO_BROWSER_LINE);
  });
});
