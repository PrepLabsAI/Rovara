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
import { initLogPath } from "../../packages/cli/src/init/log-file.js";
import { NO_BROWSER_LINE } from "../../packages/cli/src/init/ui-mode.js";
import { READY_LINE, stageLine, terminalStepLine } from "../../packages/cli/src/init/ui/journey.js";
import { INIT_STEP_IDS, installAnswersParameterName, readInstallProgress } from "../../packages/cli/src/init/install-state.js";
import { readEnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import {
  allStackOutputs, browserThatCreatesGitHubApp, fakeSlackApi, passingChecks, scriptedDeployer, scriptedPrompter,
  TEST_BOT_TOKEN, TEST_PRIVATE_KEY, TEST_SIGNING_SECRET,
} from "../support/init-fakes.js";
import { fakeWizardOperator, snapshotOnReconnect } from "../support/wizard-browser.js";
import { ADMIN_EMAIL, fakeAlerts, fakeSlackChannels } from "../support/setup-fakes.js";
import { markOperatorStop } from "../../packages/cli/src/init/stop.js";
import { WIZARD_TOKEN_HEADER, type WizardSnapshot } from "../../packages/cli/src/init/ui/protocol.js";
import { FINISH, FIRST_RUN, FIRST_RUN_BUDGET_USD, harness, releaseDir, SIGNIN, SLACK } from "../support/init-ui-harness.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const tmp = async (prefix: string) => { const dir = await mkdtemp(join(tmpdir(), prefix)); dirs.push(dir); return dir; };

const LINEAR_KEY = `lin_api_${"k".repeat(40)}SECRETlinearKEY`;
// FINISH with Linear connected: yes to the offer, the key (typed on the page), the team (the
// default, the key's only team), then no to Jira and Asana.
const FINISH_WITH_LINEAR = [ADMIN_EMAIL, "acme/payments-api", "", true, "payments", true, LINEAR_KEY, "", false, false, true];

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
    expect(last?.log.join("\n")).toContain("done: Create the GitHub app");
  });

  it("spec 048 FR-070: with the page open, the terminal prints three start lines and one line per step", async () => {
    const h = await harness();
    const { code } = await h.runUi([...FIRST_RUN, ...SLACK, ...SIGNIN, ...FINISH]);
    expect(code).toBe(0);
    const lines = h.err.join("").trimEnd().split("\n");
    expect(lines[0]).toMatch(/^The AgentX installer is open in your browser: http:\/\/127\.0\.0\.1:\d+\/\?t=/);
    expect(lines.slice(1)).toEqual([
      "Keep this terminal open and your computer awake (about 44 minutes).",
      `Full log: ${initLogPath(h.home, "staging")}`,
      stageLine("get-started"),
      stageLine("your-choices"),
      ...INIT_STEP_IDS.map((id) => terminalStepLine(id)),
      READY_LINE,
    ]);
    expect(h.out.join("")).toBe("");
    // FR-070 and FR-071: the plan, the progress lines and the ready summary are in the log file, the token is not.
    const log = await readFile(initLogPath(h.home, "staging"), "utf8");
    expect(log).toContain("Estimated monthly total");
    expect(log).toContain("done: Start the AgentX service");
    expect(log).toContain("AgentX environment staging is ready.");
    const token = new URL(lines[0]?.split(": ").at(-1) ?? "http://x").searchParams.get("t") ?? "missing";
    expect(token.length).toBeGreaterThan(20);
    expect(log).not.toContain(token);
  });

  it("spec 048 FR-070: a failure is one line in the terminal, with the log file named", async () => {
    const h = await harness();
    h.deployer.fail.set(environmentStackName("staging", "control-plane"), new Error("Resource limit exceeded"));
    const { code } = await h.runUi([...FIRST_RUN, "stop"]);
    expect(code).not.toBe(0);
    expect(h.err.join("")).toContain(`[3/5] Stopped: Start the AgentX service did not finish. Resource limit exceeded. Details in the browser and in ${initLogPath(h.home, "staging")}.`);
    expect(h.err.join("")).not.toContain("==> ");
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
    expect(review?.plan).toContain("AgentX will create the install staging in AWS account 123456789012");
    expect(review?.question).toMatchObject({ kind: "confirm", text: "Create all of this?", defaultConfirm: false });
    // Nothing was created before it: no step had even started when the plan went up.
    expect(review?.steps.every((step) => step.status === "pending")).toBe(true);
    expect(h.deployer.requests).toEqual([]);
    expect(h.store.values.has(installAnswersParameterName("staging"))).toBe(false);
    expect(h.printed()).toContain("install declined; nothing was created");
    expect(operator.states.at(-1)).toMatchObject({ phase: "failed" });
  });

  it("spec 048 SC-009: a release with a private image is refused on the page before anything is created", async () => {
    const h = await harness();
    const manifest = JSON.parse(await readFile(join(h.release, "release.json"), "utf8")) as { images: Record<string, string> };
    manifest.images.worker = `123456789012.dkr.ecr.us-east-1.amazonaws.com/agentx/worker@sha256:${"a".repeat(64)}`;
    await writeFile(join(h.release, "release.json"), JSON.stringify(manifest));
    const { code, operator } = await h.runUi([...FIRST_RUN.slice(0, -1), false]);
    expect(code).not.toBe(0);
    const card = operator.states.flatMap((state) => state.cards ?? []).filter((shown) => shown.id === "prerequisites").at(-1);
    expect(card?.checks?.find((check) => check.label === "The coding image")).toMatchObject({ ok: false });
    expect(h.deployer.requests).toEqual([]);
    expect(h.store.values.has(installAnswersParameterName("staging"))).toBe(false);
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
      "Check your AWS account",
      "Set up AWS permissions",
      "Build the network and sign-in",
      "Create the GitHub app",
    ]);
    expect(resume?.continueFrom).toBe("Start the AgentX service");
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
    expect(last?.log.join("\n")).toContain("done: Set up your first project");
    expect(last?.log.join("\n")).toContain("done: Get a first reply in Slack");
    // FR-058: the page ends on the fixed outcome, never the full ready summary (the ready card
    // already said it in full).
    expect(last).toMatchObject({ phase: "finished", outcome: READY_OUTCOME });
    // FR-070: with the page open, nothing more reaches stdout; the full ready summary is in the log file.
    expect(h.out.join("")).toBe("");
    const log = await readFile(initLogPath(h.home, "staging"), "utf8");
    expect(log).toContain("AgentX environment staging is ready.\n  Talk to it: mention @agentx in #payments (project payments-api).\n");
    expect(log).toContain("  Developers sign in with: node /opt/agentx/dist/main.js login https://abc123.execute-api.us-east-1.amazonaws.com\n");
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
    const operator = fakeWizardOperator(["", "ops@example.com", "", "", "acme", "", "", "", "", true, "stop"]);
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
    expect(operator.states.flatMap((state) => (state.failure === undefined ? [] : [state.failure])).at(-1)?.details[0]).toContain("stop after access");
    expect((await readInstallProgress(h.store, "staging"))?.steps.access).toMatchObject({ status: "done", note: "deployed by your platform team from the export bundle" });
    expect(deployer.requests.map((request) => request.part)).toEqual(["foundation"]);
  });

  it("spec 048 FR-060: a failed deploy step stays on the page, and Try this step again finishes the install", async () => {
    const h = await harness();
    h.deployer.fail.set(environmentStackName("staging", "control-plane"), new Error("Resource limit exceeded"));
    const operator = fakeWizardOperator([...FIRST_RUN, "retry", ...SLACK, ...SIGNIN, ...FINISH], {
      beforeAnswer: async (question, wizardUrl) => {
        if (question.text !== "The install stopped. What next?") return;
        await snapshotOnReconnect(wizardUrl);
        h.deployer.fail.clear();
      },
    });
    expect(await h.run(["--ui"], { openBrowser: operator.open })).toBe(0);
    await operator.settled();
    expect(operator.remaining()).toBe(0);
    expect(h.deployer.requests.filter((request) => request.part === "control-plane")).toHaveLength(2);
    expect(operator.states.at(-1)?.failure).toBeUndefined();
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

  it("a page that reconnects during a failure gets the failure screen back", async () => {
    const h = await harness();
    h.deployer.fail.set(environmentStackName("staging", "control-plane"), new Error("Resource limit exceeded"));
    let reconnected: WizardSnapshot | undefined;
    const operator = fakeWizardOperator([...FIRST_RUN, "stop"], {
      beforeAnswer: async (question, wizardUrl) => { if (question.text === "The install stopped. What next?") reconnected = await snapshotOnReconnect(wizardUrl); },
    });
    expect(await h.run(["--ui"], { openBrowser: operator.open })).not.toBe(0);
    await operator.settled();
    expect(reconnected?.failure?.what).toBe("Start the AgentX service did not finish. Resource limit exceeded.");
    expect(reconnected?.question?.buttons?.map((button) => button.label)).toEqual(["Try this step again", "Stop for now"]);
    expect(reconnected?.steps.find((step) => step.id === "control-plane")?.status).toBe("failed");
    expect(reconnected?.journey.phases[2]).toMatchObject({ statusWord: "Stopped" });
    const last = operator.states.at(-1);
    expect(last).toMatchObject({ phase: "failed", outcome: "The install stopped. Your progress is saved." });
    expect(last?.commands).toEqual([{ label: "Continue later with", command: "node /opt/agentx/dist/main.js --env staging init --region us-east-1" }]);
    expect(`${last?.outcome ?? ""} ${last?.failure?.what ?? ""}`).not.toMatch(/Finished|INTERNAL_ERROR|CONFIG_INVALID/);
    expect(last?.journey.current).toBe("build");
    expect(last?.journey.phases.map((phase) => phase.statusWord)).toEqual(["Done", "Done", "Stopped", "Coming up", "Coming up"]);
    expect(last?.journey.timeLeftText).toBe("About 29 minutes left");
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
    expect(review?.cards?.find((card) => card.id === "aws")?.lines[0]).toBe("AgentX installs into AWS account 123456789012 in us-east-1.");
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

  it("FR-022: with no AWS_REGION, the picked profile's region is the region question's default", async () => {
    const h = await harness();
    await mkdir(join(h.home, ".aws"), { recursive: true });
    await writeFile(join(h.home, ".aws", "config"), "[default]\nregion = us-east-1\n[profile dev]\nsso_session = acme\nregion = us-west-2\n");
    // The profile, then the region (us-east-1, not the default), then the first-run answers, and no to the plan.
    const operator = fakeWizardOperator(["dev", "us-east-1", ...FIRST_RUN.slice(0, -1), false]);
    await executeCli(["--env", "staging", "init", "--release", await releaseDir(["us-east-1", "us-west-2"]), "--ui"], {
      stdout: { write: () => undefined }, stderr: { write: () => undefined }, environments: { home: h.home },
      init: { ...h.base, openBrowser: operator.open, processEnv: {} },
    });
    await operator.settled();
    const region = operator.states.find((state) => state.question?.text === "AWS region")?.question;
    expect(region?.choices?.map((choice) => choice.value)).toEqual(["us-east-1", "us-west-2"]);
    expect(region?.defaultValue).toBe("us-west-2");
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
    // FR-065: the release's images are checked right after the region, before EC2 and Elastic IPs.
    expect(last?.checks?.map((check) => check.label).slice(0, 5)).toEqual(["Region", "The coding image", "The Slack connection image", "EC2 vCPU quota", "Elastic IPs"]);
    expect(last?.checks?.some((check) => check.label.startsWith("Model "))).toBe(true);
  });

  it("FR-023: saying no to checking again creates nothing", async () => {
    const h = await harness();
    const operator = fakeWizardOperator([...FIRST_RUN.slice(0, -1), false]);
    expect(await h.run(["--ui"], { openBrowser: operator.open, checks: passingChecks({ ec2Quota: async () => 0 }) })).not.toBe(0);
    await operator.settled();
    // The question came with the failed checklist beside it.
    const asking = operator.states.find((state) => state.question?.text === "Check the prerequisites again?");
    const card = asking?.cards?.find((shown) => shown.id === "prerequisites");
    expect(card?.status).toBe("failed");
    expect(card?.checks?.find((check) => check.label === "EC2 vCPU quota")).toMatchObject({ ok: false });
    expect(h.printed()).toContain("init cannot start; nothing was created");
    expect(h.deployer.requests).toEqual([]);
    expect(h.store.values.has(installAnswersParameterName("staging"))).toBe(false);
  });

  it("FR-023: a failure no check reports is still on the checklist, in the error's own words", async () => {
    const h = await harness();
    const checks = passingChecks({ cdkBootstrapped: async () => false, runCdkBootstrap: async () => { throw new Error("CDKToolkit stack creation was rolled back"); } });
    // --engine cdk skips the engine question; then yes to "Run cdk bootstrap ... now?", and no to checking again.
    const operator = fakeWizardOperator([...FIRST_RUN.slice(1, -1), true, false]);
    // Issue 152: init checks --source is a clean checkout of the release's tag before the
    // prerequisites, so the source is one: an empty commit tagged v1.2.3, the harness release's version.
    const source = await tmp("agentx-init-ui-source-");
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { cwd: source, stdio: "ignore" });
    git("init", "-q");
    git("commit", "-q", "--allow-empty", "-m", "release");
    git("tag", "v1.2.3");
    expect(await h.run(["--ui", "--engine", "cdk", "--source", source], { openBrowser: operator.open, checks })).not.toBe(0);
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
    // The app's name is the first run's default ("AgentX <account> (<env>)"); its slug is GitHub's,
    // kept in the card's details rather than its words.
    expect(stages).toContain('Create the GitHub app "AgentX acme (staging)" for acme.');
    expect(stages).toContain('Install "AgentX acme (staging)" on acme. Choose only the repositories AgentX should work on.');
    expect(stages.at(-1)).toBe('"AgentX acme (staging)" is installed on acme.');
  });

  it("FR-040: the Slack app is created from a button, and a wrong token is refused on the field", async () => {
    const h = await harness();
    const typo = "xoxp-9999-USERtokenVALUE";
    const { code, operator } = await h.runUi([...FIRST_RUN, "installed", typo, TEST_BOT_TOKEN, TEST_SIGNING_SECRET, true, true, ...SIGNIN, ...FINISH]);
    expect(code).toBe(0);
    expect(operator.clicked.some((url) => url.startsWith("https://api.slack.com/apps?new_app=1&manifest_json="))).toBe(true);
    expect(operator.fieldErrors).toContain("that is a user token (xoxp-); paste the Bot User OAuth Token from OAuth & Permissions, which starts with xoxb-");
    expect(operator.asked.filter((question) => question === "Slack bot token")).toHaveLength(2);
    expect(JSON.stringify(operator.states)).not.toContain("USERtokenVALUE");
    expect(await h.everywhere()).not.toContain("USERtokenVALUE");
    const slack = operator.states.at(-1)?.cards?.find((card) => card.id === "slack");
    expect(slack).toMatchObject({ status: "ok", lines: ['"AgentX acme (staging)" is installed in the Acme workspace.'] });
  });

  it("Q8: when Slack refuses a token that looks right, the page asks for both again and saves nothing until one works", async () => {
    const h = await harness();
    let tests = 0;
    const slack = fakeSlackApi({
      authTest: async () => { tests += 1; return tests === 1 ? { ok: false, error: "invalid_auth" } : { ok: true, user_id: "U0BOT", bot_id: "B0BOT", team_id: "T0TEAM", team: "Acme", url: "https://acme.slack.com/", user: "agentx" }; },
    });
    // What was stored when the page asked to paste again, after the first refusal.
    let atRefusal: { secret: string | undefined; slack: unknown } | undefined;
    const operator = fakeWizardOperator([...FIRST_RUN, "installed", TEST_BOT_TOKEN, TEST_SIGNING_SECRET, true, TEST_BOT_TOKEN, TEST_SIGNING_SECRET, true, true, ...SIGNIN, ...FINISH], {
      beforeAnswer: async (question) => {
        if (question.text === "Paste the Slack bot token and signing secret again?") {
          atRefusal = { secret: h.secrets.values.get("agentx/staging/slack"), slack: (await readInstallProgress(h.store, "staging"))?.slack };
        }
      },
    });
    expect(await h.run(["--ui"], { openBrowser: operator.open, slack })).toBe(0);
    await operator.settled();
    expect(operator.asked).toContain("Paste the Slack bot token and signing secret again?");
    // Nothing was saved after the refusal: the secret holds what it held before, and no Slack app is recorded.
    expect(atRefusal).toEqual({ secret: JSON.stringify({ botToken: "unset", signingSecret: "placeholder" }), slack: undefined });
    // Once a token worked, both were stored.
    expect(JSON.parse(h.secrets.values.get("agentx/staging/slack") ?? "{}")).toMatchObject({ botToken: TEST_BOT_TOKEN, signingSecret: TEST_SIGNING_SECRET });
    const refused = operator.states.flatMap((state) => state.cards ?? []).find((card) => card.id === "slack" && card.status === "failed");
    expect(refused?.lines).toContain("Slack refused the bot token (invalid_auth); copy it again from OAuth & Permissions");
  });

  it("Q8: the terminal path still stops when Slack refuses the token", async () => {
    const h = await harness();
    const slack = fakeSlackApi({ authTest: async () => ({ ok: false, error: "invalid_auth" }) });
    expect(await h.run([], { prompter: scriptedPrompter([...FIRST_RUN, "installed", TEST_BOT_TOKEN, TEST_SIGNING_SECRET]), slack })).not.toBe(0);
    expect(h.printed()).toContain("Slack refused the bot token (invalid_auth); copy it again from OAuth & Permissions");
  });

  it("User Story 2: a first install shows each connect screen in order, each ends ok, and nothing was copied by hand", async () => {
    const h = await harness();
    const { code, operator } = await h.runUi([...FIRST_RUN, ...SLACK, ...SIGNIN, ...FINISH]);
    expect(code).toBe(0);
    const last = operator.states.at(-1);
    expect(last?.cards?.map((card) => [card.id, card.status])).toEqual([
      ["aws", "ok"], ["prerequisites", "ok"], ["github", "ok"], ["slack", "ok"], ["slack-urls", "ok"], ["admin", "ok"], ["project", "ok"], ["channel", "ok"], ["connectors", "ok"], ["alerts", "ok"], ["reply", "ok"], ["ready", "ok"],
    ]);
    // Every answer came from the scripted operator, and no answer was an address pasted back:
    // the GitHub code arrived through the wizard's own callback.
    expect(operator.asked).not.toContain("Paste that address (or just its code)");
    expect(operator.opened).toHaveLength(1);
    expect(operator.remaining()).toBe(0);
    expect(h.github.conversions).toEqual(["0123456789abcdef0123"]);
    // The screens came in order: each card first appears after the one before it.
    const firstSeen: string[] = [];
    for (const card of operator.states.flatMap((state) => state.cards ?? [])) if (!firstSeen.includes(card.id)) firstSeen.push(card.id);
    expect(firstSeen).toEqual(["aws", "prerequisites", "github", "slack", "slack-urls", "admin", "project", "channel", "connectors", "alerts", "reply", "ready"]);
  });

  it("FR-012: no secret reaches a card, a link, the page's state, the log, the terminal, SSM or the cache", async () => {
    const h = await harness();
    const { code, operator } = await h.runUi([...FIRST_RUN, ...SLACK, ...SIGNIN, ...FINISH_WITH_LINEAR]);
    expect(code).toBe(0);
    const cards = JSON.stringify(operator.states.map((state) => [state.cards, state.link]));
    for (const secret of [TEST_BOT_TOKEN, TEST_SIGNING_SECRET, "fedcba9876543210fedcba9876543210", LINEAR_KEY, TEST_PRIVATE_KEY.split("\n")[1] ?? "missing"]) {
      expect(secret.length).toBeGreaterThan(10);
      expect(cards).not.toContain(secret);
      expect(JSON.stringify(operator.states)).not.toContain(secret);
      expect(await h.everywhere()).not.toContain(secret);
    }
    // Every secret really went through the run and was stored, so the absence above means something.
    expect(operator.remaining()).toBe(0);
    const app = JSON.parse(h.secrets.values.get("agentx/staging/github-app") ?? "{}") as { privateKey?: string };
    expect(app.privateKey).toContain(TEST_PRIVATE_KEY.split("\n")[1] ?? "missing");
    const slack = JSON.parse(h.secrets.values.get("agentx/staging/slack") ?? "{}") as Record<string, string>;
    expect(slack).toMatchObject({ botToken: TEST_BOT_TOKEN, signingSecret: TEST_SIGNING_SECRET, clientSecret: "fedcba9876543210fedcba9876543210" });
    expect(JSON.parse(h.secrets.values.get("agentx/staging/connectors/linear") ?? "{}")).toEqual({ apiKey: LINEAR_KEY });
  });

  it("a page that reconnects mid-install gets every card back in its snapshot", async () => {
    const h = await harness();
    // While the review question is open, a second page connects, as a reloaded tab would.
    let reconnected: Awaited<ReturnType<typeof snapshotOnReconnect>> | undefined;
    const operator = fakeWizardOperator([...FIRST_RUN.slice(0, -1), false], {
      beforeAnswer: async (question, wizardUrl) => { if (question.text === "Create all of this?") reconnected = await snapshotOnReconnect(wizardUrl); },
    });
    await h.run(["--ui"], { openBrowser: operator.open });
    await operator.settled();
    const review = operator.states.find((state) => state.question?.text === "Create all of this?");
    expect(review?.cards?.map((card) => card.id)).toEqual(["aws", "prerequisites"]);
    expect(reconnected?.question?.text).toBe("Create all of this?");
    expect(reconnected?.cards?.map((card) => card.id)).toEqual(["aws", "prerequisites"]);
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

  it("Review Focus 2: a private channel shows the invite wait, then the binding, and the project card shows the repository", async () => {
    const h = await harness();
    const slackChannels = fakeSlackChannels([{ id: "C0PAY00001", name: "payments", isPrivate: true, isMember: true }], { visibleAfterFinds: 3 });
    const operator = fakeWizardOperator([...FIRST_RUN, ...SLACK, ...SIGNIN, ...FINISH]);
    expect(await h.run(["--ui"], { openBrowser: operator.open, setup: { ...h.setup, slackChannels } })).toBe(0);
    await operator.settled();
    const channel = operator.states.flatMap((state) => state.cards?.filter((card) => card.id === "channel") ?? []);
    expect(channel.map((card) => card.status)).toContain("waiting");
    expect(channel.at(-1)).toMatchObject({ status: "ok", lines: ["AgentX answers in #payments for payments-api."] });
    expect(operator.states.at(-1)?.cards?.find((card) => card.id === "project")?.lines).toEqual(["The project payments-api is set up for acme/payments-api."]);
  });

  it("the connectors card lists what was connected", async () => {
    const h = await harness();
    const { code, operator } = await h.runUi([...FIRST_RUN, ...SLACK, ...SIGNIN, ...FINISH_WITH_LINEAR]);
    expect(code).toBe(0);
    expect(operator.states.at(-1)?.cards?.find((card) => card.id === "connectors")?.lines).toEqual(["Connected to payments-api: Linear."]);
    expect(operator.states.at(-1)?.cards?.find((card) => card.id === "alerts")?.lines).toEqual(["Alerts go to ops@example.com, and the test alert arrived."]);
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

  it("FR-059 and #222: the page ends on a ready card whose commands work as shown, and the outcome does not repeat it (spec 048 FR-058)", async () => {
    const h = await harness();
    const { code, operator } = await h.runUi([...FIRST_RUN, ...SLACK, ...SIGNIN, ...FINISH]);
    expect(code).toBe(0);
    const last = operator.states.at(-1);
    const ready = last?.cards?.find((card) => card.id === "ready");
    expect(ready?.lines).toEqual([
      "Try it: in #payments, mention @agentx and ask it something.",
      "Send your developers the sign-in command below. They run it once, then use AgentX from Claude Code, Codex or Cursor.",
      "The AgentX CLI is not published yet, so this command works on this computer. Other computers need their own copy of the AgentX CLI first.",
      "No issue trackers connected yet.",
      `Everything here is also in ${initLogPath(h.home, "staging")}.`,
    ]);
    expect(ready?.commands).toEqual([
      { label: "Developer sign-in", command: "node /opt/agentx/dist/main.js login https://abc123.execute-api.us-east-1.amazonaws.com" },
      { label: "Check the install", command: "node /opt/agentx/dist/main.js --env staging doctor" },
      { label: "Connect an issue tracker", command: "node /opt/agentx/dist/main.js --env staging connector add linear --project payments-api" },
      { label: "Add a project", command: "node /opt/agentx/dist/main.js --env staging project add" },
      { label: "Send a test alert", command: "node /opt/agentx/dist/main.js --env staging alerts test" },
      { label: "Remove AgentX", command: "node /opt/agentx/dist/main.js --env staging destroy" },
    ]);
    expect(ready?.link?.url).toBe("https://slack.com/app_redirect?team=T0TEAM&channel=C0PAY00001");
    // FR-058: the outcome is the fixed line, never the ready card's own words repeated.
    expect(last?.outcome).toBe(READY_OUTCOME);
    expect(last?.phase).toBe("finished");
    expect(last?.journey.current).toBe("finish");
    expect(last?.journey.phases.map((phase) => phase.statusWord)).toEqual(["Done", "Done", "Done", "Done", "Done"]);
    expect(last?.journey.timeLeftText).toBe("Done");
  });

  it("spec 048 FR-059: a run paused waiting on a Slack admin's approval shows the plain outcome, a continue command, and the same reason in the terminal", async () => {
    const h = await harness();
    const operator = fakeWizardOperator([...FIRST_RUN, "approval"]);
    const code = await h.run(["--ui"], { openBrowser: operator.open });
    await operator.settled();
    expect(code).toBe(0);
    const last = operator.states.at(-1);
    expect(last?.outcome).toBe("The install is paused. Your progress is saved.");
    expect(last?.commands).toEqual([{ label: "Continue later with", command: "node /opt/agentx/dist/main.js --env staging init --region us-east-1" }]);
    expect(h.err.join("").trimEnd().split("\n").at(-1)).toEqual(
      `[4/5] Stopped: Waiting for a Slack admin to approve the app. Details in the browser and in ${initLogPath(h.home, "staging")}.`,
    );
    // A paused run is not drawn as finished: the waiting step's phase waits for you, and the time
    // left is what the install still has to do.
    expect(last?.phase).toBe("paused");
    expect(last?.journey.current).toBe("connect-slack");
    expect(last?.journey.stepNumber).toBe(4);
    expect(last?.journey.phases.map((phase) => phase.statusWord)).toEqual(["Done", "Done", "Done", "Waiting for you", "Coming up"]);
    expect(last?.journey.timeLeftText).toBe("About 16 minutes left");
  });

  it("spec 048 FR-059: a run paused waiting on the alert subscription shows its own plain reason", async () => {
    const h = await harness();
    const alerts = fakeAlerts({ confirmAfterPolls: 1_000, budgetUsd: FIRST_RUN_BUDGET_USD });
    const operator = fakeWizardOperator([...FIRST_RUN, ...SLACK, ...SIGNIN, ADMIN_EMAIL, "acme/payments-api", "", true, "payments", false, false, false, false]);
    const code = await h.run(["--ui"], { openBrowser: operator.open, setup: { ...h.setup, alerts } });
    await operator.settled();
    expect(code).toBe(0);
    const last = operator.states.at(-1);
    expect(last?.outcome).toBe("The install is paused. Your progress is saved.");
    expect(last?.commands).toEqual([{ label: "Continue later with", command: "node /opt/agentx/dist/main.js --env staging init --region us-east-1" }]);
    expect(h.err.join("").trimEnd().split("\n").at(-1)).toEqual(
      `[5/5] Stopped: Waiting for the alert subscription to be confirmed. Details in the browser and in ${initLogPath(h.home, "staging")}.`,
    );
    expect(last?.phase).toBe("paused");
    expect(last?.journey.current).toBe("finish");
    expect(last?.journey.stepNumber).toBe(5);
    expect(last?.journey.phases.map((phase) => phase.statusWord)).toEqual(["Done", "Done", "Done", "Done", "Waiting for you"]);
    expect(last?.journey.timeLeftText).toBe("About 2 minutes left");
  });

  it("a run stopped with --stop-after shows no ready card", async () => {
    const h = await harness();
    const { code, operator } = await h.runUi([...FIRST_RUN], ["--stop-after", "prerequisites"]);
    expect(code).toBe(0);
    expect(operator.states.at(-1)?.cards?.some((card) => card.id === "ready")).toBe(false);
  });

  it("User Story 3 and SC-003: a first install on the page ends with a reply, every card ok, and nothing typed in the terminal", async () => {
    const h = await harness();
    const { code, operator } = await h.runUi([...FIRST_RUN, ...SLACK, ...SIGNIN, ...FINISH]);
    expect(code).toBe(0);
    expect(operator.states.at(-1)?.cards?.map((card) => [card.id, card.status])).toEqual([
      ["aws", "ok"], ["prerequisites", "ok"], ["github", "ok"], ["slack", "ok"], ["slack-urls", "ok"],
      ["admin", "ok"], ["project", "ok"], ["channel", "ok"], ["connectors", "ok"], ["alerts", "ok"], ["reply", "ok"], ["ready", "ok"],
    ]);
    expect(h.plane.bindings).toEqual(["T0TEAM/C0PAY00001"]);
    expect(operator.opened).toHaveLength(1);
  });

  it("FR-012: no finishing secret reaches a card", async () => {
    const h = await harness();
    // The finishing steps' seams record what they were handed, so each secret below is proved to
    // have gone through the run before its absence from the cards is checked.
    const linearKeys: string[] = [];
    const vendors = { ...h.setup.vendors, linearTeams: async (key: string) => { linearKeys.push(key); return h.setup.vendors.linearTeams(key); } };
    const slackChannels = fakeSlackChannels([{ id: "C0PAY00001", name: "payments", isPrivate: false, isMember: true }]);
    const operator = fakeWizardOperator([...FIRST_RUN, ...SLACK, ...SIGNIN, ...FINISH_WITH_LINEAR]);
    const code = await h.run(["--ui"], { openBrowser: operator.open, setup: { ...h.setup, vendors, slackChannels } });
    await operator.settled();
    expect(code).toBe(0);
    expect(operator.remaining()).toBe(0);
    expect(linearKeys).toContain(LINEAR_KEY);
    expect(JSON.parse(h.secrets.values.get("agentx/staging/connectors/linear") ?? "{}")).toEqual({ apiKey: LINEAR_KEY });
    expect(slackChannels.tokens.length).toBeGreaterThan(0);
    expect(slackChannels.tokens.every((token) => token === TEST_BOT_TOKEN)).toBe(true);
    expect(JSON.parse(h.secrets.values.get("agentx/staging/slack") ?? "{}")).toMatchObject({ botToken: TEST_BOT_TOKEN, clientSecret: "fedcba9876543210fedcba9876543210" });
    const cards = JSON.stringify(operator.states.map((state) => state.cards));
    expect(cards).toContain("\"ready\"");
    for (const secret of [LINEAR_KEY, TEST_BOT_TOKEN, "fedcba9876543210fedcba9876543210"]) expect(cards).not.toContain(secret);
  });

  it("a resumed install shows the finishing cards of the steps it runs", async () => {
    const h = await harness();
    h.deployer.fail.set(environmentStackName("staging", "control-plane"), new Error("Resource limit exceeded"));
    expect(await h.run([], { prompter: scriptedPrompter(FIRST_RUN) })).not.toBe(0);
    h.deployer.fail.clear();
    const { code, operator } = await h.runUi([...SLACK, ...SIGNIN, ...FINISH]);
    expect(code).toBe(0);
    expect(operator.states.at(-1)?.cards?.map((card) => card.id)).toEqual(expect.arrayContaining(["admin", "project", "channel", "reply", "ready"]));
    expect(operator.states.at(-1)?.cards?.find((card) => card.id === "ready")?.status).toBe("ok");
  });

  it("FR-001: with neither flag, an interactive terminal that can open a browser gets the page", async () => {
    const h = await harness();
    const operator = fakeWizardOperator([...FIRST_RUN, ...SLACK, ...SIGNIN, ...FINISH]);
    // No --ui, and no injected prompter: the default decides.
    expect(await h.run([], { openBrowser: operator.open, isInteractive: () => true, browserAvailable: () => true })).toBe(0);
    await operator.settled();
    expect(operator.opened[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?t=/);
    expect(operator.remaining()).toBe(0);
    expect(h.printed()).not.toContain(NO_BROWSER_LINE);
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
