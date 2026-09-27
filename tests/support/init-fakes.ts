// Shared fakes for `agentx init` tests. Nothing here reaches AWS, GitHub or Slack.
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { environmentStackName, type ReleaseManifest } from "@agentx/contracts";
import type { DeployRequest, StackDeployer, StackOutputs } from "../../packages/cli/src/deploy/deployer.js";
import type { LoadedRelease } from "../../packages/cli/src/deploy/release.js";
import { SecretAlreadyExistsError } from "../../packages/cli/src/deploy/signing-key.js";
import { lockParameterName } from "../../packages/cli/src/environments/lock.js";
import type { InitContext, InitSecrets } from "../../packages/cli/src/init/context.js";
import { emptyProgress, type InitAnswers, type InstallProgress } from "../../packages/cli/src/init/install-state.js";
import type { PrerequisiteChecks } from "../../packages/cli/src/init/prerequisites.js";
import type { Prompter } from "../../packages/cli/src/init/prompts.js";
import type { ProgressHandle } from "../../packages/cli/src/init/steps.js";
import { MemoryParameterStore } from "./memory-parameter-store.js";

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
    github: { account: "acme", accountType: "organization", appName: "AgentX acme staging" },
    slack: { appName: "AgentX", appPostedMessages: "accept" },
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

/** Every prerequisite passes; override one method to make it fail. Records every model checked. */
export function passingChecks(overrides: Partial<PrerequisiteChecks> = {}): PrerequisiteChecks & { models: string[]; bootstraps: number } {
  const state = { models: [] as string[], bootstraps: 0 };
  return {
    get models() { return state.models; },
    get bootstraps() { return state.bootstraps; },
    converse: async (modelId) => { state.models.push(modelId); },
    agentCore: async () => undefined,
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

export function memoryInitSecrets(initial: Record<string, string> = {}): InitSecrets & { values: Map<string, string> } {
  const values = new Map(Object.entries(initial));
  return {
    values,
    async get(name) { return values.get(name); },
    async create(name, value) { if (values.has(name)) throw new SecretAlreadyExistsError(name); values.set(name, value); },
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

/** Every part's outputs, enough for stackParameters, settings and the Slack step. */
export function allStackOutputs(env = "staging"): Record<string, StackOutputs> {
  const name = (part: Parameters<typeof environmentStackName>[1]) => environmentStackName(env, part);
  return {
    [name("access")]: { ArtifactBucketName: `agentx-${env}-access-artifactbucket-abc`, CloudFormationRoleArn: `arn:aws:iam::123456789012:role/agentx-${env}-cloudformation`, OperatorRoleArn: `arn:aws:iam::123456789012:role/agentx-${env}-operator`, PullThroughPrefix: `agentx-${env}` },
    [name("foundation")]: { CapacityProviderArn: `arn:aws:bedrock-agentcore:us-east-1:123456789012:capacity-provider/agentx_${env}_capacity-AbCdEfGhIj`, VpcId: "vpc-0123456789abcdef0", PrivateSubnetIds: "subnet-1,subnet-2" },
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
    openBrowser: async (url) => { opened.push(url); },
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    fetch: async () => { throw new Error("test setup: fetch not expected"); },
    processEnv: {},
    secretFlags: {},
    // Read at call time, so an overridden store or secrets is the one deploys use.
    deployment: async () => ({ deployer, store: context.store, secrets: context.secrets, holder: HOLDER, partition: "aws", cleanup: async () => undefined }),
    stackStatus: { status: async () => undefined },
    home: join(tmpdir(), `agentx-init-home-${randomBytes(6).toString("hex")}`),
    prerequisitesPassed: true,
    runPrerequisites: async () => undefined,
    ...overrides,
  };
  return Object.assign(context, { lines, deployer, opened }) as TestInitContext;
}
