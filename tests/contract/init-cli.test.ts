// agentx init end to end through executeCli, with every AWS, GitHub, Slack, browser and clock
// dependency injected. Nothing here reaches AWS, GitHub or Slack; the GitHub manifest listener is
// real, on 127.0.0.1.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentXError, environmentStackName } from "@agentx/contracts";
import { prepareDeployment } from "../../packages/cli/src/deploy/commands.js";
import { executeCli } from "../../packages/cli/src/main.js";
import { environmentCachePath } from "../../packages/cli/src/environments/cache.js";
import { lockParameterName } from "../../packages/cli/src/environments/lock.js";
import { readEnvironmentSettings, settingsParameterName } from "../../packages/cli/src/environments/settings.js";
import { INIT_STEP_IDS, installAnswersParameterName, installProgressParameterName, readInstallProgress } from "../../packages/cli/src/init/install-state.js";
import { initSteps, nextStepsText, type InitCliDependencies } from "../../packages/cli/src/init/commands.js";
import {
  allStackOutputs, browserThatCreatesGitHubApp, fakeGitHubApi, fakeSlackApi, HOLDER, memoryInitSecrets, passingChecks, scriptedDeployer, scriptedPrompter,
  slackIngressFetch, T0, TEST_BOT_TOKEN, TEST_PRIVATE_KEY, TEST_SIGNING_SECRET,
} from "../support/init-fakes.js";
import { stagingSettings } from "../support/environment-fixtures.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";

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
  const deps: InitCliDependencies = {
    deploy: { identity: { get: async () => ({ account: "123456789012", arn: HOLDER }) }, store, secrets, deployer },
    initSecrets: secrets,
    checks: passingChecks(),
    github,
    slack: fakeSlackApi(),
    stackStatus: { status: async () => undefined },
    fetch: slackIngressFetch({ signingSecret: TEST_SIGNING_SECRET }),
    openBrowser: browserThatCreatesGitHubApp(opened),
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    processEnv: {},
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
  return { store, secrets, deployer, github, opened, out, err, home, release, run, runWithoutRegion, printed: () => `${out.join("")}${err.join("")}` };
}

type Harness = Awaited<ReturnType<typeof harness>>;

/** Everything a secret must never reach: the printed output, every SSM value, and this machine's
 * environment cache file (F21). */
async function everywhereButSecrets(h: Harness): Promise<string> {
  const cache = await readFile(environmentCachePath(h.home, "staging"), "utf8").catch(() => "");
  return [h.printed(), ...h.store.values.values(), cache].join("\n");
}

// The questions a first run asks with every default taken (Task 4's order), then the plan.
const FIRST_RUN = ["", "", "", "", "", "", "", "", "ops@example.com", "acme", "", "", "", "", true];
// The Slack step: installed, the token, the signing secret, "the right bot?"; then the Slack
// service step's "Request URL Verified?" (Task 9's fix round added both confirms).
const SLACK = ["installed", TEST_BOT_TOKEN, TEST_SIGNING_SECRET, true, true];
// A GitHub App made beforehand, and both Slack secrets, so --yes needs no prompt at all.
const UNATTENDED = [
  "--yes", "--no-browser", "--github-account", "acme", "--github-app-id", "424242", "--github-installation-id", "777",
  "--github-private-key-env", "GH_KEY", "--slack-bot-token-env", "BOT", "--slack-signing-secret-env", "SIGNING",
];
const UNATTENDED_ENV = { GH_KEY: TEST_PRIVATE_KEY, BOT: TEST_BOT_TOKEN, SIGNING: TEST_SIGNING_SECRET };
const WEBHOOK = "https://events.pagerduty.com/integration/0123SECRETintegrationKEY/enqueue";

describe("agentx init", () => {
  it("lists its steps in the recorded order", () => {
    expect(initSteps({ github: fakeGitHubApi(), slack: fakeSlackApi() }).map((step) => step.id)).toEqual([...INIT_STEP_IDS]);
  });

  it("a first run asks, checks, shows the plan, deploys every stack, creates both apps, and writes settings and the local cache", async () => {
    const h = await harness();
    const prompter = scriptedPrompter([...FIRST_RUN, ...SLACK]);
    expect(await h.run([], { prompter })).toBe(0);
    expect(prompter.remaining()).toBe(0);
    expect(h.deployer.requests.map((request) => request.part)).toEqual(["access", "foundation", "identity", "control-plane", "runtime", "slack"]);
    const progress = await readInstallProgress(h.store, "staging");
    expect(INIT_STEP_IDS.every((id) => progress?.steps[id]?.status === "done")).toBe(true);
    expect((await readEnvironmentSettings(h.store, "staging"))?.engine).toBe("templates");
    await expect(stat(environmentCachePath(h.home, "staging"))).resolves.toBeDefined();
    expect(h.store.values.has(lockParameterName("staging"))).toBe(false);
    const printed = h.printed();
    expect(printed).toContain("Estimated monthly total");
    expect(printed).toContain("AgentX environment staging is deployed. Control plane: https://abc123.execute-api.us-east-1.amazonaws.com");
    expect(printed).toContain("agentx login --env staging");
    expect(printed).toContain("aws cognito-idp admin-create-user --user-pool-id us-east-1_abc");
    const everywhere = await everywhereButSecrets(h);
    expect(everywhere).toContain("abc123.execute-api");
    for (const secret of [TEST_PRIVATE_KEY.split("\n")[1]!, TEST_BOT_TOKEN, TEST_SIGNING_SECRET, h.secrets.values.get("agentx/staging/callback-signing-key")!]) {
      expect(secret.length).toBeGreaterThan(10);
      expect(everywhere).not.toContain(secret);
    }
  });

  it("resumes at the step that failed and never creates a second GitHub App", async () => {
    const h = await harness();
    h.deployer.fail.set(environmentStackName("staging", "control-plane"), new Error("Resource limit exceeded"));
    expect(await h.run([], { prompter: scriptedPrompter(FIRST_RUN) })).not.toBe(0);
    expect(h.printed()).toContain('init stopped at "Deploy the control plane and runtime": Resource limit exceeded. Run agentx init --env staging --region us-east-1 again to continue from this step.');
    expect(h.store.values.has(lockParameterName("staging"))).toBe(false);
    h.deployer.fail.clear();
    h.deployer.requests.length = 0;
    expect(await h.run([], { prompter: scriptedPrompter(SLACK) })).toBe(0);
    expect(h.printed()).toContain("Resuming the install of environment staging.");
    expect(h.github.conversions).toHaveLength(1);
    expect(h.deployer.requests.map((request) => request.part)).toEqual(["control-plane", "runtime", "slack"]);
  });

  it("changes nothing when run again after it finished", async () => {
    const h = await harness();
    await h.run([], { prompter: scriptedPrompter([...FIRST_RUN, ...SLACK]) });
    const before = h.store.values.get(installProgressParameterName("staging"));
    const settingsBefore = h.store.values.get(settingsParameterName("staging"));
    h.deployer.requests.length = 0;
    expect(await h.run([], { prompter: scriptedPrompter([]) })).toBe(0);
    expect(h.deployer.requests).toEqual([]);
    expect(h.store.values.get(installProgressParameterName("staging"))).toBe(before);
    expect(h.store.values.get(settingsParameterName("staging"))).toBe(settingsBefore);
    expect(h.printed()).toContain("already done: Deploy the Slack service");
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
    expect(await h.run([], { prompter: scriptedPrompter(SLACK) })).toBe(0);
    expect((await readInstallProgress(h.store, "staging"))?.steps["slack-service"]?.status).toBe("done");
  });

  it("carries on when no browser can be opened: GitHub takes the pasted address, Slack just prints its link", async () => {
    const h = await harness();
    const tried: string[] = [];
    // xdg-open missing (CloudShell, SSH hosts, containers), or Windows, where openSystemBrowser throws AUTH_REQUIRED.
    const openBrowser = async (url: string) => { tried.push(url); throw Object.assign(new Error("spawn xdg-open ENOENT"), { code: "ENOENT" }); };
    const prompter = scriptedPrompter([...FIRST_RUN, "0123456789abcdef0123", ...SLACK]);
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
    expect(printed).toContain('init stopped at "Deploy the access stack (IAM roles, artifact bucket, image cache)": stack agentx-staging-access failed to create earlier');
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
        checks: passingChecks({ converse: unexpected, ec2Quota: unexpected }),
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
    expect(await h.run(["--json"], { prompter: scriptedPrompter([...FIRST_RUN, ...SLACK]) })).toBe(0);
    expect(JSON.parse(h.out.join(""))).toMatchObject({
      ok: true,
      data: { status: "complete", env: "staging", resumed: false, controlPlaneUrl: "https://abc123.execute-api.us-east-1.amazonaws.com" },
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
    expect(h.printed()).toContain('init stopped at "Deploy the control plane and runtime": Resource limit exceeded.');
    expect(h.printed()).toContain("could not remove temporary files: directory busy");
  });

  it("keeps the result when removing temporary files fails after a finished run", async () => {
    const h = await harness();
    const prepare: InitCliDependencies["prepareDeployment"] = async (input) => ({
      ...(await prepareDeployment(input)),
      cleanup: async () => { throw new Error("directory busy"); },
    });
    expect(await h.run([], { prompter: scriptedPrompter([...FIRST_RUN, ...SLACK]), prepareDeployment: prepare })).toBe(0);
    expect(h.printed()).toContain("AgentX environment staging is deployed.");
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
    expect(await h.run(["--engine", "cdk"], { prompter: scriptedPrompter(FIRST_RUN.slice(1, -1)) })).toBe(2);
    expect(h.printed()).toContain("the cdk engine needs --source <a checkout of tag v1.2.3>");
    expect(h.printed()).not.toContain("Estimated monthly total");
    expect(h.store.calls.filter((call) => call.op === "put")).toEqual([]);
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
    expect(h.printed()).toContain("locked by arn:aws:sts::123456789012:assumed-role/Admin/bob");
    expect(h.store.values.has(installAnswersParameterName("staging"))).toBe(false);
    expect(h.secrets.values.has("agentx/staging/alert-endpoint")).toBe(false);
  });

  it("offers to take over its own lock left by a closed terminal", async () => {
    const h = await harness();
    h.store.values.set(lockParameterName("staging"), JSON.stringify({ holder: HOLDER, command: "init", acquiredAt: new Date(T0 - 60_000).toISOString() }));
    const prompter = scriptedPrompter([...FIRST_RUN, true, ...SLACK]);
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

describe("nextStepsText", () => {
  it("names the admin user steps for your own OIDC provider without Cognito commands", () => {
    const text = nextStepsText({ ...stagingSettings, identity: { ...stagingSettings.identity, mode: "oidc", issuer: "https://login.example.com" } });
    expect(text).toContain("Make sure your own OIDC provider marks you as an AgentX administrator.");
    expect(text).not.toContain("cognito-idp");
    expect(text).toContain("agentx login --env staging");
  });
});
