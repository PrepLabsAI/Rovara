// SC-003: a full `agentx init --ui` install driven entirely from the page, with nothing typed in
// the terminal after the command. The wizard server and the GitHub manifest listener are both
// real, on 127.0.0.1; every AWS, GitHub, Slack and clock dependency is injected, so nothing here
// reaches AWS, GitHub or Slack.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

// The same answers the terminal path's tests script, in the same order: `agentx init --ui` asks
// exactly the questions it always asked, only on a page.
const FIRST_RUN = ["", "", "", "", "", "", "", "", "", "ops@example.com", "acme", "", "", "", "", true];
const SLACK = ["installed", TEST_BOT_TOKEN, TEST_SIGNING_SECRET, true, true];
const SIGNIN = ["", "1111111111.2222222222222", "fedcba9876543210fedcba9876543210", true];

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
    store, secrets, deployer, github, out, err, home, run, runUi,
    printed: () => `${out.join("")}${err.join("")}`,
    everywhere: async () => [out.join(""), err.join(""), ...store.values.values(), await readFile(environmentCachePath(home, "staging"), "utf8").catch(() => "")].join("\n"),
  };
}

describe("agentx init --ui", () => {
  it("runs the whole install from the page, with nothing typed in the terminal", async () => {
    const h = await harness();
    const { code, operator } = await h.runUi([...FIRST_RUN, ...SLACK, ...SIGNIN]);
    expect(code).toBe(0);
    expect(operator.remaining()).toBe(0);
    expect(operator.fieldErrors).toEqual([]);
    // The page opened, and the questions it showed are init's own, in init's own order.
    expect(operator.opened[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?t=/);
    expect(operator.asked).toContain("Deploy engine");
    expect(operator.asked).toContain("Create all of this?");
    expect(operator.asked).toContain("Slack bot token");
    expect(operator.asked).toHaveLength(FIRST_RUN.length + SLACK.length + SIGNIN.length);

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
    const { operator } = await h.runUi([...FIRST_RUN, ...SLACK, ...SIGNIN]);
    const seen = JSON.stringify(operator.states);
    const everywhere = await h.everywhere();
    for (const secret of [TEST_BOT_TOKEN, TEST_SIGNING_SECRET, "fedcba9876543210fedcba9876543210"]) {
      expect(secret.length).toBeGreaterThan(10);
      expect(seen).not.toContain(secret);
      expect(everywhere).not.toContain(secret);
    }
    // The secrets really were collected and stored, so the absence above means something.
    expect(h.secrets.values.get("agentx/staging/slack")).toContain(TEST_BOT_TOKEN);
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

    const { code, operator } = await h.runUi([...SLACK, ...SIGNIN]);
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
    const { code, operator } = await h.runUi([...script, ...SLACK, ...SIGNIN]);
    expect(code).toBe(0);
    // Once from the POST's own reply, once on the question that came back carrying it.
    expect(operator.fieldErrors).toEqual(["must be an email address", "must be an email address"]);
    expect(operator.asked.filter((question) => question === "Alert email address")).toHaveLength(2);
  });

  it("--ui and --yes are refused together, and --no-ui is the terminal path", async () => {
    const h = await harness();
    expect(await h.run(["--ui", "--yes"])).not.toBe(0);
    expect(h.printed()).toContain("agentx init --ui asks its questions on a page; --yes answers them without asking");
    expect(await h.run(["--no-ui"], { prompter: scriptedPrompter([...FIRST_RUN, ...SLACK, ...SIGNIN]) })).toBe(0);
  });
});
