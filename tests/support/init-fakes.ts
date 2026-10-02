// Shared fakes for `agentx init` tests. Nothing here reaches AWS, GitHub or Slack.
import { createHmac, generateKeyPairSync, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTROL_PLANE_FOUNDATION_PARAMETERS, environmentStackName, type ReleaseManifest } from "@agentx/contracts";
import type { DeployRequest, StackDeployer, StackOutputs } from "../../packages/cli/src/deploy/deployer.js";
import type { LoadedRelease } from "../../packages/cli/src/deploy/release.js";
import { SecretAlreadyExistsError } from "../../packages/cli/src/deploy/signing-key.js";
import { lockParameterName } from "../../packages/cli/src/environments/lock.js";
import { readEnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import type { CliInvocation } from "../../packages/cli/src/init/cli-command.js";
import type { InitFlags } from "../../packages/cli/src/init/answers.js";
import type { InitContext, InitSecrets } from "../../packages/cli/src/init/context.js";
import type { GitHubApi } from "../../packages/cli/src/init/github-app.js";
import { emptyProgress, type InitAnswers, type InstallProgress } from "../../packages/cli/src/init/install-state.js";
import type { PrerequisiteChecks } from "../../packages/cli/src/init/prerequisites.js";
import type { Prompter } from "../../packages/cli/src/init/prompts.js";
import type { SlackApi } from "../../packages/cli/src/init/slack-app.js";
import { settingsFields, type SettingsFieldName } from "../../packages/cli/src/init/settings-form.js";
import type { ProgressHandle } from "../../packages/cli/src/init/steps.js";
import { openAdminSession } from "../../packages/cli/src/setup/admin-session.js";
import { fakeCloudFormation, SIGN_IN_PARAMETERS } from "./fake-cloudformation.js";
import { MemoryParameterStore } from "./memory-parameter-store.js";
import { setupServices } from "./setup-fakes.js";

/** A complete, valid set of `agentx init` answers, for tests that round-trip or size-check them
 * rather than exercising the prompts that collect them. */
export function sampleAnswers(overrides: Partial<InitAnswers> = {}): InitAnswers {
  return {
    schemaVersion: 1,
    env: "staging",
    region: "us-east-1",
    account: "123456789012",
    engine: "templates",
    releaseVersion: "1.2.3",
    identity: { mode: "cognito" },
    models: { orchestrator: "us.anthropic.claude-sonnet-4-6", classifier: "amazon.nova-lite-v1:0", worker: "amazon.nova-pro-v1:0" },
    alert: { kind: "email", address: "ops@example.com" },
    github: { account: "acme", accountType: "organization", appName: "AgentX acme (staging)" },
    slack: { appName: "AgentX acme (staging)", appPostedMessages: "accept" },
    createdAt: "2026-09-27T00:00:00.000Z",
    ...overrides,
  };
}

export type ScriptedAnswer = string | boolean;

/** Answers questions in order. "" takes the question's default. Records every question asked. */
export function scriptedPrompter(script: ScriptedAnswer[]): Prompter & { asked: string[]; remaining: () => number } {
  const queue = [...script];
  const asked: string[] = [];
  const next = (question: string): ScriptedAnswer => {
    asked.push(question);
    const answer = queue.shift();
    if (answer === undefined) throw new Error(`test setup: no scripted answer for "${question}"`);
    return answer;
  };
  return {
    asked,
    remaining: () => queue.length,
    async ask(question, options) {
      const answer = next(question);
      if (typeof answer !== "string") throw new Error(`test setup: "${question}" wants text`);
      const value = answer === "" && options.defaultValue !== undefined ? options.defaultValue : answer;
      const problem = options.validate?.(value);
      if (problem !== undefined) throw new Error(`test setup: "${question}" refused ${JSON.stringify(value)}: ${problem}`);
      return value;
    },
    async choose<T extends string>(question: string, choices: ReadonlyArray<{ value: T; label: string }>, options: { flag: string; defaultValue: T }): Promise<T> {
      const answer = next(question);
      if (answer === "") return options.defaultValue;
      const match = choices.find((choice) => choice.value === answer);
      if (match === undefined) throw new Error(`test setup: "${question}" has no choice ${String(answer)}`);
      return match.value;
    },
    async confirm(question) {
      const answer = next(question);
      if (typeof answer !== "boolean") throw new Error(`test setup: "${question}" wants true or false`);
      return answer;
    },
    async secret(question) {
      const answer = next(question);
      if (typeof answer !== "string") throw new Error(`test setup: "${question}" wants text`);
      return answer;
    },
  };
}

/** Spec 048 phase 2: a terminal run's settings answers, in the form's own order. Without `advanced`
 * the run says no to "Change the advanced settings?"; with it, yes, and these values (every other
 * advanced field takes its default). `flags`, `env`, `adminEmail` and `fixed` leave out the fields
 * the run's own flags answer, exactly as collectInitAnswers does. */
export function settingsScript(input: {
  email?: string; owner?: string; installName?: string; appName?: string;
  advanced?: Partial<Record<SettingsFieldName, string>>; flags?: InitFlags; env?: string; adminEmail?: string; fixed?: boolean;
} = {}): ScriptedAnswer[] {
  const fields = settingsFields({ env: input.env ?? "staging", flags: input.flags ?? {}, fixed: input.fixed === true, budgetWhy: "", ...(input.adminEmail === undefined ? {} : { adminEmail: input.adminEmail }) });
  const basic: Record<string, string> = { email: input.email ?? "ops@example.com", githubAccount: input.owner ?? "acme", installName: input.installName ?? "", appName: input.appName ?? "" };
  const answers: ScriptedAnswer[] = fields.filter((field) => field.section !== "advanced").map((field) => basic[field.name] ?? "");
  const advanced = fields.filter((field) => field.section === "advanced");
  if (advanced.length === 0) return answers;
  if (input.advanced === undefined) return [...answers, false];
  return [...answers, true, ...advanced.map((field) => input.advanced?.[field.name as SettingsFieldName] ?? "")];
}

/** Every prerequisite passes; override one method to make it fail. Records every model checked. */
export function passingChecks(overrides: Partial<PrerequisiteChecks> = {}): PrerequisiteChecks & { models: string[]; bootstraps: number } {
  const state = { models: [] as string[], bootstraps: 0 };
  return {
    get models() { return state.models; },
    get bootstraps() { return state.bootstraps; },
    converse: async (modelId) => { state.models.push(modelId); },
    ec2Quota: async () => 32,
    elasticIps: async () => ({ quota: 5, allocated: 0 }),
    commandVersion: async (command) => (command === "node" ? "v22.20.0" : "10.9.0"),
    cdkBootstrapped: async () => true,
    runCdkBootstrap: async () => { state.bootstraps += 1; },
    oidcDiscovery: async (issuer) => ({ issuer }),
    sleep: async () => undefined,
    ...overrides,
  };
}

// ---- deploy and secret fakes (Task 7) ------------------------------------------------------------

export const T0 = Date.parse("2026-09-27T00:00:00.000Z");
export const HOLDER = "arn:aws:sts::123456789012:assumed-role/Admin/alice";

/** A sensible default for `InitContext.cliInvocation` and `InitCliDependencies.cliInvocation`:
 * a CLI built from source (Plan ruling 4), so every test gets a command that works as shown
 * without pinning its own. */
export const TEST_CLI_INVOCATION: CliInvocation = { published: false, cliPath: "/opt/agentx/dist/main.js" };

/** `failCreate`: `create` always throws (spec 048 FR-032 test), as a real `CreateSecret` call that
 * failed after the app was made on GitHub would. */
export function memoryInitSecrets(initial: Record<string, string> = {}, options: { failCreate?: boolean } = {}): InitSecrets & { values: Map<string, string> } {
  const values = new Map(Object.entries(initial));
  return {
    values,
    async get(name) { return values.get(name); },
    async create(name, value) {
      if (options.failCreate === true) throw Object.assign(new Error("test setup: secret creation refused"), { name: "AccessDeniedException" });
      if (values.has(name)) throw new SecretAlreadyExistsError(name); values.set(name, value);
    },
    async put(name, value) { if (!values.has(name)) throw Object.assign(new Error(`Secrets Manager can't find ${name}`), { name: "ResourceNotFoundException" }); values.set(name, value); },
    async arn(name) { return values.has(name) ? `arn:aws:secretsmanager:us-east-1:123456789012:secret:${name}-AbCdEf` : undefined; },
  };
}

/** A parameter store where `holder` already holds env's lock for `agentx init`, as the step runner
 * leaves it while steps run. Seeded directly, so no store call is recorded for it. */
export function storeWithInitLock(env = "staging", holder = HOLDER): MemoryParameterStore {
  const store = new MemoryParameterStore();
  store.values.set(lockParameterName(env), JSON.stringify({ holder, command: "init", acquiredAt: new Date(T0).toISOString() }));
  return store;
}

/** A placeholder for every foundation output the control plane takes, so a new one never breaks these fakes. */
function foundationParameterDefaults(): Record<string, string> {
  return Object.fromEntries(CONTROL_PLANE_FOUNDATION_PARAMETERS.map((name) => [name, `fake-${name}`]));
}

/** Every part's outputs, enough for stackParameters, settings and the Slack step. */
export function allStackOutputs(env = "staging"): Record<string, StackOutputs> {
  const name = (part: Parameters<typeof environmentStackName>[1]) => environmentStackName(env, part);
  return {
    [name("access")]: { ArtifactBucketName: `agentx-${env}-access-artifactbucket-abc`, CloudFormationRoleArn: `arn:aws:iam::123456789012:role/agentx-${env}-cloudformation`, OperatorRoleArn: `arn:aws:iam::123456789012:role/agentx-${env}-operator`, PullThroughPrefix: `agentx-${env}` },
    [name("foundation")]: { VpcId: "vpc-0123456789abcdef0", PrivateSubnetIds: "subnet-1,subnet-2", SessionManagerSecurityGroupId: "sg-0123456789abcdef0", WorkspaceKmsKeyArn: "arn:aws:kms:us-east-1:123456789012:key/k", Ec2WorkerInstanceRoleArn: `arn:aws:iam::123456789012:role/agentx/${env}/worker`, Ec2WorkerLaunchTemplateId: "lt-0123456789abcdef0", ...foundationParameterDefaults() },
    [name("identity")]: { Issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_abc", Audience: "client123", ClientId: "client123" },
    [name("control-plane")]: {
      ApiEndpoint: "https://abc123.execute-api.us-east-1.amazonaws.com",
      SlackEventsUrl: "https://abc123.execute-api.us-east-1.amazonaws.com/v1/slack/events",
      SlackInteractivityUrl: "https://abc123.execute-api.us-east-1.amazonaws.com/v1/slack/interactions",
      SlackSecretArn: `arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/${env}/slack-AbCdEf`,
      SlackOrchestratorTaskRoleArn: `arn:aws:iam::123456789012:role/agentx/${env}/slack-task`,
      SlackRequestQueueUrl: "https://sqs.us-east-1.amazonaws.com/123456789012/requests",
      SlackThreadsTableName: "threads", TurnRecordsTableName: "turns", SlackThreadSessionBucketName: "sessions",
      OperatorAlertsTopicArn: `arn:aws:sns:us-east-1:123456789012:agentx-${env}-alerts`,
    },
    [name("runtime")]: {},
    [name("slack")]: {},
  };
}

/** Deploys by returning scripted outputs and emitting a deployed event; outputs() answers only for stacks deployed so far (or listed as existing). */
export function scriptedDeployer(outputsByStack: Record<string, StackOutputs>, existing: string[] = []): StackDeployer & { requests: DeployRequest[]; fail: Map<string, Error> } {
  const deployed = new Set(existing);
  const requests: DeployRequest[] = [];
  const fail = new Map<string, Error>();
  return {
    requests,
    fail,
    async deploy(request) {
      requests.push(request);
      const error = fail.get(request.stackName);
      if (error !== undefined) throw error;
      const outputs = outputsByStack[request.stackName];
      if (outputs === undefined) throw new Error(`test setup: no outputs for ${request.stackName}`);
      deployed.add(request.stackName);
      request.onEvent?.({ kind: "deployed", stackName: request.stackName });
      return outputs;
    },
    async outputs(stackName) { return deployed.has(stackName) ? outputsByStack[stackName] : undefined; },
  };
}

export function fakeRelease(version = "1.2.3"): LoadedRelease {
  const manifest: ReleaseManifest = {
    schemaVersion: 1, version, gitCommit: "a".repeat(40), environmentPlaceholder: "qqenv-placeholderqq", templates: [], packages: [],
    images: { worker: `public.ecr.aws/agentx/agentx-worker@sha256:${"b".repeat(64)}`, slack: `public.ecr.aws/agentx/agentx-slack@sha256:${"c".repeat(64)}` },
  };
  return { manifest, dir: "/nonexistent", regions: () => ["us-east-1"], template: () => { throw new Error("not used"); }, packagePath: () => { throw new Error("not used"); } };
}

export function progressHandle(initial: InstallProgress = emptyProgress("staging", T0)): ProgressHandle & { value(): InstallProgress } {
  let value = initial;
  return { value: () => value, current: () => value, update: async (patch) => { value = { ...value, ...patch }; } };
}

/** A context whose clock advances by every sleep, so timeouts can be reached without waiting. */
export type TestInitContext = InitContext & { lines: string[]; deployer: ReturnType<typeof scriptedDeployer>; opened: string[]; secrets: InitSecrets & { values: Map<string, string> } };

/** Tests that use this delete `context.home` in an afterEach. The default store already holds the
 * init lock for HOLDER, as the step runner leaves it while steps run. */
export function initContext(overrides: Partial<Omit<InitContext, "secrets">> & { secrets?: InitSecrets & { values: Map<string, string> } } = {}): TestInitContext {
  let clock = T0;
  const lines: string[] = [];
  const opened: string[] = [];
  const store = storeWithInitLock();
  const secrets = memoryInitSecrets();
  const deployer = scriptedDeployer(allStackOutputs());
  const context: InitContext = {
    env: "staging",
    answers: sampleAnswers(),
    release: fakeRelease(),
    holder: HOLDER,
    store,
    secrets,
    prompter: scriptedPrompter([]),
    write: (line) => { lines.push(line); },
    openBrowser: async (url) => { opened.push(url); return true; },
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    fetch: async () => { throw new Error("test setup: fetch not expected"); },
    processEnv: {},
    secretFlags: {},
    cloudFormation: fakeCloudFormation({ parameters: SIGN_IN_PARAMETERS }),
    signinFlags: {},
    // Read at call time, so an overridden store or secrets is the one deploys use.
    deployment: async () => ({ deployer, store: context.store, secrets: context.secrets, holder: HOLDER, partition: "aws", cleanup: async () => undefined }),
    stackStatus: { status: async () => undefined },
    home: join(tmpdir(), `agentx-init-home-${randomBytes(6).toString("hex")}`),
    prerequisitesPassed: true,
    runPrerequisites: async () => undefined,
    setup: setupServices(),
    flags: {},
    cliInvocation: TEST_CLI_INVOCATION,
    // Read at call time, as init builds it: the real openAdminSession over context.setup, with the
    // context's browser (absent means --no-browser) and your own OIDC's admin claim when named.
    adminSession: async () => {
      const settings = await readEnvironmentSettings(context.store, context.env);
      if (settings === undefined) throw new Error("test setup: no settings");
      const identity = context.answers.identity;
      return openAdminSession({
        settings, services: context.setup, now: context.now, write: context.write,
        ...(context.openBrowser === undefined ? {} : { openBrowser: context.openBrowser }),
        ...(settings.identity.mode === "oidc" && identity.mode === "oidc" && identity.adminClaim !== undefined && identity.adminValues !== undefined
          ? { adminClaim: { claim: identity.adminClaim, values: identity.adminValues } } : {}),
      });
    },
    ...overrides,
  };
  return Object.assign(context, { lines, deployer, opened }) as TestInitContext;
}

// ---- GitHub fakes (Task 8) -----------------------------------------------------------------------

const TEST_KEYS = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
// Trimmed, as the CLI stores it: GitHub's PEM ends with a newline, and the CLI trims before storing.
export const TEST_PRIVATE_KEY = TEST_KEYS.privateKey.trim();
export const TEST_PUBLIC_KEY = TEST_KEYS.publicKey;

/** A GitHub that converts any code into an app owned by `owner`, installs it after `installAfterPolls` polls, and reports repository counts in turn. Installation tokens expire at `tokenExpiresAt` (default T0 plus one hour). */
export function fakeGitHubApi(input: { owner?: string; ownerType?: string; installAfterPolls?: number; repositoryCounts?: number[]; installationId?: number; tokenExpiresAt?: number } = {}): GitHubApi & { conversions: string[]; polls: () => number; tokens: () => number } {
  const conversions: string[] = [];
  let polls = 0;
  let tokens = 0;
  const counts = [...(input.repositoryCounts ?? [1])];
  const owner = { login: input.owner ?? "acme", type: input.ownerType ?? "Organization" };
  return {
    conversions,
    polls: () => polls,
    tokens: () => tokens,
    async convertManifest(code) { conversions.push(code); return { id: 424242, slug: "agentx-acme-staging", pem: TEST_PRIVATE_KEY, owner }; },
    async getApp() { return { slug: "agentx-acme-staging", owner }; },
    async listInstallations() { polls += 1; return polls > (input.installAfterPolls ?? 0) ? [{ id: input.installationId ?? 777, account: { login: owner.login } }] : []; },
    async installationToken() { tokens += 1; return { token: "ghs_installation-token-value", expiresAt: input.tokenExpiresAt ?? T0 + 60 * 60 * 1000 }; },
    async repositoryCount() { return counts.length > 1 ? (counts.shift() as number) : (counts[0] as number); },
    async owner(login) { return login.toLowerCase() === owner.login.toLowerCase() ? { login: owner.login, type: owner.type === "User" ? "User" : "Organization" } : undefined; },
    async appBySlug() { return undefined; },
  };
}

/** A browser that, given the local form page, plays GitHub: it redirects back with `code` and the page's state. */
export function browserThatCreatesGitHubApp(opened: string[], code = "0123456789abcdef0123"): (url: string) => Promise<true> {
  return async (url) => {
    opened.push(url);
    if (!url.startsWith("http://127.0.0.1:")) return true;
    const page = await (await fetch(url)).text();
    const state = /[?&]state=([a-f0-9]+)/.exec(page)?.[1];
    await fetch(`${url.replace("/github/start", "/github/created")}?code=${code}&state=${state ?? "missing"}`);
    return true;
  };
}

// ---- Slack fakes (Task 9) ------------------------------------------------------------------------

export const TEST_BOT_TOKEN = "xoxb-1111-2222-SECRETbotTOKENvalue";
export const TEST_SIGNING_SECRET = "0123456789abcdef0123456789abcdef";

export function fakeSlackApi(overrides: Partial<SlackApi> = {}): SlackApi {
  return {
    authTest: async () => ({ ok: true, user_id: "U0BOT", bot_id: "B0BOT", team_id: "T0TEAM", team: "Acme", url: "https://acme.slack.com/", user: "agentx" }),
    botsInfo: async () => ({ ok: true, bot: { app_id: "A0APP" } }),
    ...overrides,
  };
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

/** Plays the control plane's Slack ingress: verifies the signature like validSignature does, answers 401 for the first `staleFor` calls (the cached old secret), then echoes challenges. */
export function slackIngressFetch(input: { signingSecret: string; staleFor?: number }): typeof fetch & { calls: string[] } {
  let seen = 0;
  const calls: string[] = [];
  const handler = async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const target = requestUrl(url);
    calls.push(target);
    seen += 1;
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? init.body : "";
    const timestamp = headers.get("x-slack-request-timestamp") ?? "";
    const expected = `v0=${createHmac("sha256", input.signingSecret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
    if (seen <= (input.staleFor ?? 0) || headers.get("x-slack-signature") !== expected) return new Response(JSON.stringify({ error: "invalid Slack signature" }), { status: 401 });
    if (target.endsWith("/events")) return new Response(JSON.stringify({ challenge: (JSON.parse(body) as { challenge: string }).challenge }), { status: 200 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  return Object.assign(handler, { calls });
}
