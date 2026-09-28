import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadProjectConfig } from "../../packages/cli/src/config.js";
import { firstProjectStep } from "../../packages/cli/src/init/finish-steps.js";
import { executeCli } from "../../packages/cli/src/main.js";
import { realSetupContext, type SetupCommandContext, type SetupRun } from "../../packages/cli/src/setup/command-context.js";
import { unattendedPrompter } from "../../packages/cli/src/init/prompts.js";
import { addProject, ec2Binding, registerRevision } from "../../packages/cli/src/setup/project-add.js";
import { SETUP_TIMEOUT, TEST_TIMEOUT } from "../../packages/cli/src/setup/project-files.js";
import { fakeGitHubApi, initContext, memoryInitSecrets, progressHandle, scriptedPrompter, TEST_PRIVATE_KEY, type TestInitContext } from "../support/init-fakes.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";
import { CONTROL_PLANE, STAGING_SETTINGS, accessToken, fakeControlPlane, fakeRepositories, memoryTokenStore, setupServices } from "../support/setup-fakes.js";

const FOUNDATION = { Ec2WorkerLaunchTemplateId: "lt-0123456789abcdef0", Ec2WorkerSubnets: "us-east-1a=subnet-0aaa1111bbbb2222c,us-east-1b=subnet-0ddd3333eeee4444f" };
let configDir: string;
beforeEach(async () => { configDir = await mkdtemp(join(tmpdir(), "agentx-projects-")); });
afterEach(async () => { await rm(configDir, { recursive: true, force: true }); });

const repositoriesFake = () => fakeRepositories({
  "acme/payments-api": { files: { "package.json": JSON.stringify({ scripts: { test: "vitest run" } }), "package-lock.json": "{}" } },
  "acme/docs": { files: {} },
});
const services = (plane = fakeControlPlane(), repositories = repositoriesFake()) => ({
  fetch: plane.fetch, repositories, configDir, stackOutputs: async (name: string) => (name === "agentx-staging-foundation" ? FOUNDATION : undefined),
});
const session = { controlPlaneUrl: CONTROL_PLANE, accessToken: "admin-token" };

describe("the ec2-ebs binding from the foundation's outputs", () => {
  it("uses the launch template and every zone's subnet, 20 GiB gp3", () => {
    expect(ec2Binding(FOUNDATION, "agentx-staging-foundation")).toEqual({
      deploymentMode: "ec2-ebs", launchTemplateId: "lt-0123456789abcdef0",
      subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0aaa1111bbbb2222c" }, { availabilityZone: "us-east-1b", subnetId: "subnet-0ddd3333eeee4444f" }],
      volumeSizeGiB: 20, volumeType: "gp3",
    });
  });

  it("says which output is missing and what to do", () => {
    expect(() => ec2Binding({}, "agentx-staging-foundation")).toThrow("stack agentx-staging-foundation has no Ec2WorkerLaunchTemplateId output; upgrade the environment to a release with EC2 workers, then run this again");
    expect(() => ec2Binding({ Ec2WorkerLaunchTemplateId: FOUNDATION.Ec2WorkerLaunchTemplateId }, "agentx-staging-foundation")).toThrow("stack agentx-staging-foundation has no Ec2WorkerSubnets output");
  });

  it("says when the foundation stack does not exist at all, rather than blaming a missing output", () => {
    expect(() => ec2Binding(undefined, "agentx-staging-foundation")).toThrow("stack agentx-staging-foundation does not exist in this account and region; check --env and --region, or finish agentx init first");
  });
});

describe("agentx project add (FR-040)", () => {
  it("offers the repositories, proposes the commands, registers revision 1 on ec2-ebs and writes the file", async () => {
    const plane = fakeControlPlane();
    // repository, project name (default), use the proposed commands
    const prompter = scriptedPrompter(["acme/payments-api", "", true]);
    const lines: string[] = [];
    const result = await addProject({ env: "staging", session, githubToken: "ghs_x", prompter, write: (line) => lines.push(line), services: services(plane), flags: {} });
    expect(result).toEqual({ name: "payments-api", revision: 1, file: join(configDir, "payments-api.yaml") });
    const sent = plane.registered[0] as { definition: Record<string, unknown>; runtimeBinding: { deploymentMode: string } };
    expect(sent.runtimeBinding.deploymentMode).toBe("ec2-ebs");
    expect(sent.definition).toMatchObject({
      name: "payments-api", revision: 1,
      repositories: [{ name: "payments-api", url: "https://github.com/acme/payments-api.git", path: "repo/payments-api", defaultBranch: "main", credentialRef: "github-agentx-sdlc" }],
      setup: [{ executable: "npm", args: ["ci"] }], readiness: [{ executable: "npm", args: ["test"] }],
    });
    expect(lines.join("\n")).toContain("Proposed from package.json and package-lock.json: npm ci");
    const file = await readFile(result.file, "utf8");
    expect(file).toContain("name: payments-api");
    expect(file).not.toContain("admin-token");
    expect(file).not.toContain("ghs_x");
  });

  it("writes a file agentx admin project register --file reads back, whose header gives the whole register command (F27)", async () => {
    const result = await addProject({ env: "staging", session, githubToken: "ghs_x", prompter: scriptedPrompter(["acme/payments-api", "", true]), write: () => undefined, services: services(), flags: {} });
    const file = await readFile(result.file, "utf8");
    expect(file).toContain(`agentx admin project register --env staging --file ${result.file} --deployment-mode ec2-ebs --launch-template-id lt-0123456789abcdef0 --subnets us-east-1a=subnet-0aaa1111bbbb2222c,us-east-1b=subnet-0ddd3333eeee4444f`);
    expect(file).toContain("agentx connector add");
    const loaded = await loadProjectConfig({ projectName: "payments-api", configDirectory: configDir });
    expect(loaded).toMatchObject({ name: "payments-api", revision: 1 });
  });

  it("uses the shared timeouts for the proposed and the typed commands (F22)", async () => {
    const plane = fakeControlPlane();
    await addProject({ env: "staging", session, githubToken: "ghs_x", prompter: scriptedPrompter(["acme/payments-api", "", false, "npm install", "npm run test:unit"]), write: () => undefined, services: services(plane), flags: {} });
    const definition = (plane.registered[0] as { definition: { setup: Array<{ timeoutSeconds: number }>; readiness: Array<{ timeoutSeconds: number }> } }).definition;
    expect(definition.setup[0]!.timeoutSeconds).toBe(SETUP_TIMEOUT);
    expect(definition.readiness[0]!.timeoutSeconds).toBe(TEST_TIMEOUT);
  });

  it("takes every answer from flags, asking nothing", async () => {
    const plane = fakeControlPlane();
    const result = await addProject({
      env: "staging", session, githubToken: "ghs_x", prompter: scriptedPrompter([]), write: () => undefined, services: services(plane),
      flags: { repository: "acme/docs", projectName: "docs", setupCommand: "", testCommand: "make check" },
    });
    expect(result.name).toBe("docs");
    expect((plane.registered[0] as { definition: { setup: unknown[]; readiness: Array<{ executable: string }> } }).definition.setup).toEqual([]);
    expect((plane.registered[0] as { definition: { readiness: Array<{ executable: string; args: string[] }> } }).definition.readiness).toMatchObject([{ executable: "make", args: ["check"] }]);
  });

  it("lets the engineer type the commands when they do not accept the proposal", async () => {
    const plane = fakeControlPlane();
    const prompter = scriptedPrompter(["acme/payments-api", "", false, "npm install", "npm run test:unit"]);
    await addProject({ env: "staging", session, githubToken: "ghs_x", prompter, write: () => undefined, services: services(plane), flags: {} });
    expect((plane.registered[0] as { definition: { setup: Array<{ args: string[] }>; readiness: Array<{ args: string[] }> } }).definition).toMatchObject({ setup: [{ args: ["install"] }], readiness: [{ args: ["run", "test:unit"] }] });
  });

  it("asks for the commands, offering none, when no build file is known", async () => {
    const plane = fakeControlPlane();
    const lines: string[] = [];
    // repository, project name (default), setup (default: none), test
    const prompter = scriptedPrompter(["acme/docs", "", "", "make check"]);
    await addProject({ env: "staging", session, githubToken: "ghs_x", prompter, write: (line) => lines.push(line), services: services(plane), flags: {} });
    expect(lines.join("\n")).toContain("No build file AgentX knows in acme/docs, so no command is proposed.");
    expect((plane.registered[0] as { definition: { setup: unknown[]; readiness: Array<{ args: string[] }> } }).definition).toMatchObject({ setup: [], readiness: [{ executable: "make", args: ["check"] }] });
  });

  it("refuses a repository the app cannot see, naming the ones it can", async () => {
    await expect(addProject({ env: "staging", session, githubToken: "ghs_x", prompter: scriptedPrompter([]), write: () => undefined, services: services(), flags: { repository: "acme/secret" } }))
      .rejects.toThrow("the GitHub App cannot see acme/secret; it sees acme/payments-api, acme/docs. Add the repository to the app's installation, or choose one of those");
  });

  it("refuses a --project-name that is not a project name, before anything is registered or written", async () => {
    const plane = fakeControlPlane();
    await expect(addProject({ env: "staging", session, githubToken: "ghs_x", prompter: scriptedPrompter([]), write: () => undefined, services: services(plane), flags: { repository: "acme/docs", projectName: "../escape", setupCommand: "", testCommand: "" } }))
      .rejects.toThrow('--project-name "../escape" is not valid; a project name is 1 to 63 lowercase letters, digits and hyphens, starting with a letter');
    expect(plane.registered).toEqual([]);
  });

  it("refuses when the app sees no repository, saying where to choose some", async () => {
    await expect(addProject({ env: "staging", session, githubToken: "ghs_x", prompter: scriptedPrompter([]), write: () => undefined, services: services(fakeControlPlane(), fakeRepositories({})), flags: {} }))
      .rejects.toThrow("the GitHub App sees no repositories; choose at least one in the app's installation settings, then run this again");
  });

  it("refuses when the control plane lists no GitHub App credential, before registering", async () => {
    const plane = fakeControlPlane();
    plane.credentials.length = 0;
    await expect(addProject({ env: "staging", session, githubToken: "ghs_x", prompter: scriptedPrompter([]), write: () => undefined, services: services(plane), flags: { repository: "acme/docs", projectName: "docs", setupCommand: "", testCommand: "" } }))
      .rejects.toThrow("the control plane lists no GitHub App credential; check the control-plane stack's GitHubAppId parameter");
    expect(plane.registered).toEqual([]);
  });

  it("registers no second revision when run again with the same answers, and asks GitHub and the control plane nothing (fix round 1)", async () => {
    const plane = fakeControlPlane();
    const flags = { repository: "acme/payments-api", projectName: "payments-api", setupCommand: "npm ci", testCommand: "npm test" };
    const first = await addProject({ env: "staging", session, githubToken: "ghs_x", prompter: scriptedPrompter([]), write: () => undefined, services: services(plane), flags });
    const requestsBefore = plane.requests.length;
    const repositories = repositoriesFake();
    let listed = 0;
    const counting = { ...repositories, list: async (token: string) => { listed += 1; return repositories.list(token); } };
    const lines: string[] = [];
    const again = await addProject({ env: "staging", session, githubToken: "ghs_x", prompter: scriptedPrompter([]), write: (line) => lines.push(line), services: services(plane, counting), flags });
    expect(again).toEqual(first);
    expect(plane.registered).toHaveLength(1);
    expect(plane.requests.length).toBe(requestsBefore);
    expect(listed).toBe(0);
    expect(repositories.reads).toEqual([]);
    expect(lines.join("\n")).toContain("Project payments-api is already registered (revision 1) with these settings; nothing to change.");
  });

  it("an interactive rerun names the same repository and project, and registers nothing", async () => {
    const plane = fakeControlPlane();
    await addProject({ env: "staging", session, githubToken: "ghs_x", prompter: scriptedPrompter(["acme/payments-api", "", true]), write: () => undefined, services: services(plane), flags: {} });
    const again = await addProject({ env: "staging", session, githubToken: "ghs_x", prompter: scriptedPrompter(["acme/payments-api", ""]), write: () => undefined, services: services(plane), flags: {} });
    expect(again.revision).toBe(1);
    expect(plane.registered).toHaveLength(1);
  });

  it("refuses when a file at the project's path is not an AgentX project file (fix round 1)", async () => {
    const plane = fakeControlPlane();
    await writeFile(join(configDir, "docs.yaml"), "just: some notes\n");
    await expect(addProject({ env: "staging", session, githubToken: "ghs_x", prompter: scriptedPrompter([]), write: () => undefined, services: services(plane), flags: { repository: "acme/docs", projectName: "docs", setupCommand: "", testCommand: "" } }))
      .rejects.toThrow(`a file already exists at ${join(configDir, "docs.yaml")} that is not an AgentX project file; move it or choose another --project-name`);
    expect(plane.registered).toEqual([]);
  });

  it("with --yes, refuses to guess among several repositories, naming --repository and some of them (fix round 1)", async () => {
    const many = fakeRepositories(Object.fromEntries(["acme/a1", "acme/a2", "acme/a3", "acme/a4", "acme/a5", "acme/a6", "acme/a7"].map((name) => [name, { files: {} }])));
    const plane = fakeControlPlane();
    await expect(addProject({ env: "staging", session, githubToken: "ghs_x", prompter: unattendedPrompter(), write: () => undefined, services: services(plane, many), flags: {} }))
      .rejects.toThrow("the GitHub App sees 7 repositories (for example acme/a1, acme/a2, acme/a3, acme/a4, acme/a5, and 2 more); pass --repository <owner/name> to choose the first project's");
    expect(plane.registered).toEqual([]);
  });

  it("with --yes, takes the only repository the app sees", async () => {
    const plane = fakeControlPlane();
    const one = fakeRepositories({ "acme/docs": { files: {} } });
    const result = await addProject({ env: "staging", session, githubToken: "ghs_x", prompter: unattendedPrompter(), write: () => undefined, services: services(plane, one), flags: {} });
    expect(result.name).toBe("docs");
    expect(plane.registered).toHaveLength(1);
  });

  it("refuses to overwrite an existing project with different answers, saying how to change it", async () => {
    const plane = fakeControlPlane();
    await addProject({ env: "staging", session, githubToken: "ghs_x", prompter: scriptedPrompter([""]), write: () => undefined, services: services(plane), flags: { repository: "acme/payments-api", setupCommand: "npm ci", testCommand: "npm test" } });
    await expect(addProject({ env: "staging", session, githubToken: "ghs_x", prompter: scriptedPrompter([""]), write: () => undefined, services: services(plane), flags: { repository: "acme/payments-api", setupCommand: "npm install", testCommand: "npm test" } }))
      .rejects.toThrow(`project payments-api already exists (${join(configDir, "payments-api.yaml")}) with a different setup command; to change it, edit that file, raise its revision, and register it as its header says, or choose another --project-name`);
    expect(plane.registered).toHaveLength(1);
  });

  it("refuses a rerun that names a different repository for an existing project", async () => {
    const plane = fakeControlPlane();
    await addProject({ env: "staging", session, githubToken: "ghs_x", prompter: scriptedPrompter([]), write: () => undefined, services: services(plane), flags: { repository: "acme/payments-api", projectName: "payments-api", setupCommand: "", testCommand: "" } });
    await expect(addProject({ env: "staging", session, githubToken: "ghs_x", prompter: scriptedPrompter([]), write: () => undefined, services: services(plane), flags: { repository: "acme/docs", projectName: "payments-api", setupCommand: "", testCommand: "" } }))
      .rejects.toThrow("project payments-api already exists");
    expect(plane.registered).toHaveLength(1);
  });

  it("registers a later revision from the file with the preflight's report", async () => {
    const plane = fakeControlPlane();
    const first = await addProject({ env: "staging", session, githubToken: "ghs_x", prompter: scriptedPrompter(["acme/payments-api", "", true]), write: () => undefined, services: services(plane), flags: {} });
    const definition = { ...(plane.registered[0] as { definition: Record<string, unknown> }).definition, revision: 2 } as never;
    const again = await registerRevision({ env: "staging", session, definition, services: services(plane) });
    expect(again.revision).toBe(2);
    expect(again.file).toBe(first.file);
    expect(YAML.parse(await readFile(first.file, "utf8"))).toMatchObject({ revision: 2 });
  });

  it("writes no file when the control plane refuses the registration", async () => {
    const plane = fakeControlPlane();
    const refusing = { ...services(plane), fetch: (async (url: string | URL | Request, init?: RequestInit) => (init?.method === "POST"
      ? new Response(JSON.stringify({ error: { code: "CONFIG_INVALID", message: "revision 1 of payments-api already exists" } }), { status: 409, headers: { "content-type": "application/json" } })
      : plane.fetch(url, init))) as typeof fetch };
    await expect(addProject({ env: "staging", session, githubToken: "ghs_x", prompter: scriptedPrompter([""]), write: () => undefined, services: refusing, flags: { repository: "acme/payments-api", setupCommand: "", testCommand: "" } }))
      .rejects.toThrow("project registration failed with HTTP 409: revision 1 of payments-api already exists");
    await expect(readFile(join(configDir, "payments-api.yaml"), "utf8")).rejects.toThrow("ENOENT");
  });
});

describe("the first-project init step", () => {
  let context: TestInitContext | undefined;
  afterEach(async () => { if (context !== undefined) await rm(context.home, { recursive: true, force: true }); });

  const githubSecret = () => memoryInitSecrets({ "agentx/staging/github-app": JSON.stringify({ appId: "42", slug: "agentx-acme", account: "acme", privateKey: TEST_PRIVATE_KEY }) });

  it("registers the first project with the recorded installation and records it", async () => {
    const plane = fakeControlPlane();
    const github = fakeGitHubApi({ installationId: 777 });
    context = initContext({
      secrets: githubSecret(), prompter: scriptedPrompter(["acme/payments-api", "", true]),
      setup: setupServices({ fetch: plane.fetch, repositories: repositoriesFake(), github, configDir, stackOutputs: async (name) => (name === "agentx-staging-foundation" ? FOUNDATION : undefined) }),
    });
    (context.store as MemoryParameterStore).values.set("/agentx/staging/settings", JSON.stringify(STAGING_SETTINGS));
    const progress = progressHandle({ ...progressHandle().value(), github: { account: "acme", appId: "42", slug: "agentx-acme", privateKeySecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/github-app-AbCdEf", installationId: "777" } });
    expect(await firstProjectStep().run(context, progress)).toEqual({ status: "done", note: "project payments-api" });
    expect(progress.value().project).toEqual({ name: "payments-api", revision: 1 });
    expect(github.polls()).toBe(0);
    expect(plane.registered).toHaveLength(1);
    expect(context.lines.join("\n")).toContain("Registered project payments-api, revision 1, on EC2 workers.");
    expect(context.lines.join("\n")).not.toContain("ghs_installation-token-value");
  });

  it("takes the answers from init's flags", async () => {
    const plane = fakeControlPlane();
    context = initContext({
      secrets: githubSecret(), prompter: scriptedPrompter([]),
      flags: { repository: "acme/docs", projectName: "docs", setupCommand: "", testCommand: "make check" },
      setup: setupServices({ fetch: plane.fetch, repositories: repositoriesFake(), configDir, stackOutputs: async () => FOUNDATION }),
    });
    (context.store as MemoryParameterStore).values.set("/agentx/staging/settings", JSON.stringify(STAGING_SETTINGS));
    const progress = progressHandle();
    await firstProjectStep().run(context, progress);
    expect(progress.value().project).toEqual({ name: "docs", revision: 1 });
  });

  it("registers nothing again on a rerun that already recorded the project", async () => {
    const plane = fakeControlPlane();
    context = initContext({ prompter: scriptedPrompter([]), setup: setupServices({ fetch: plane.fetch, configDir }) });
    (context.store as MemoryParameterStore).values.set("/agentx/staging/settings", JSON.stringify(STAGING_SETTINGS));
    const progress = progressHandle({ ...progressHandle().value(), project: { name: "payments-api", revision: 1 } });
    expect(await firstProjectStep().run(context, progress)).toEqual({ status: "done", note: "project payments-api" });
    expect(plane.registered).toEqual([]);
  });
});

describe("agentx project add on the command line", () => {
  function fakeSetupContext(plane = fakeControlPlane()): SetupCommandContext & { regions: Array<string | undefined> } {
    const regions: Array<string | undefined> = [];
    const run = (command: Command): Omit<SetupRun, "session"> => {
      regions.push(command.optsWithGlobals<{ region?: string }>().region);
      return {
        env: "staging", settings: STAGING_SETTINGS,
        secrets: memoryInitSecrets({ "agentx/staging/github-app": JSON.stringify({ appId: "42", slug: "agentx-acme", account: "acme", privateKey: TEST_PRIVATE_KEY }) }),
        services: setupServices({ fetch: plane.fetch, repositories: repositoriesFake(), configDir, stackOutputs: async () => FOUNDATION }),
        prompter: scriptedPrompter([]), write: () => undefined,
        print: () => undefined,
      };
    };
    return {
      regions,
      openAws: async (command) => run(command),
      open: async (command) => ({ ...run(command), session: { controlPlaneUrl: CONTROL_PLANE, accessToken: accessToken({ "cognito:groups": ["agentx-admin"] }) } }),
    };
  }

  it("takes --region and every answer by flag, and registers the project", async () => {
    const plane = fakeControlPlane();
    const setup = fakeSetupContext(plane);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await executeCli(
      ["project", "add", "--env", "staging", "--region", "us-east-1", "--repository", "acme/docs", "--project-name", "docs", "--setup-command", "", "--test-command", "make check"],
      { setup, stdout: { write: (text: string) => stdout.push(text) }, stderr: { write: (text: string) => stderr.push(text) } },
    );
    expect(stderr.join("")).toBe("");
    expect(code).toBe(0);
    expect(setup.regions).toEqual(["us-east-1"]);
    expect(plane.registered).toHaveLength(1);
  });
});

describe("the real setup command context", () => {
  const command = (region?: string) => ({ optsWithGlobals: () => ({ env: "staging", json: false, configDir, ...(region === undefined ? {} : { region }) }) }) as unknown as Command;
  const context = (store: MemoryParameterStore) => realSetupContext({
    parameterStore: () => store, fetch: fakeControlPlane().fetch, tokenStore: memoryTokenStore(), stdout: { write: () => undefined }, stderr: { write: () => undefined },
  });

  it("says where it looked when the environment has no settings, and what to do", async () => {
    await expect(context(new MemoryParameterStore()).openAws(command("eu-west-1"))).rejects.toThrow("environment staging has no settings in eu-west-1; pass --region, or run agentx env list");
  });

  it("with no terminal, never guesses between several choices, but takes the only one", async () => {
    const store = new MemoryParameterStore();
    store.values.set("/agentx/staging/settings", JSON.stringify(STAGING_SETTINGS));
    const run = await context(store).openAws(command("us-east-1"));
    expect(run.services.configDir).toBe(configDir);
    const choices = [{ value: "acme/a", label: "acme/a" }, { value: "acme/b", label: "acme/b" }];
    await expect(run.prompter.choose("Which repository is the first project's?", choices, { flag: "--repository", defaultValue: "acme/a" }))
      .rejects.toThrow("Which repository is the first project's? needs an answer; with no terminal, pass --repository");
    expect(await run.prompter.choose("Which?", choices.slice(0, 1), { flag: "--repository", defaultValue: "acme/a" })).toBe("acme/a");
  });
});
