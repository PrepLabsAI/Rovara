// One process, the whole Slack workflow: a signed Slack mention goes through the real slack-ingress and the
// broker's start-workflow event, the notifier posts to a strict Slack double, buttons and modals go through the
// real interactivity handler, and a worker stub runs the real run-task on the scripted faux model against a real
// git repository. GitHub is a fake that only accepts a push made with a push-scoped token.
import { createHmac, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  SharedTaskRecordSchema,
  SlackChannelBindingSchema,
  SlackRequestMessageSchema,
  WorkerInvocationSchema,
  WorkflowSnapshotSchema,
  sharedTaskKey,
  type ProjectCommand,
  type SlackRequestMessage,
  type SlackThread,
  type WorkerInvocation,
  type WorkflowOptionalCheck,
  type WorkflowSnapshot,
} from "@agentx/contracts";
import type { InvokeCommand } from "@aws-sdk/client-lambda";
import type { HttpApiV2Event } from "../../packages/broker/src/aws/lambda.js";
import { createNotifierHandler } from "../../packages/broker/src/aws/developer-task-notifier.js";
import { createSlackIngressHandler, recordThreadNoteThroughBroker, startWorkflowThroughBroker } from "../../packages/broker/src/aws/slack-ingress.js";
import { createSlackInteractivityHandler, invokeWorkflowDecision, workflowSlackHandlers } from "../../packages/broker/src/aws/slack-interactivity.js";
import { answerChosenRequest, createDynamoWorkflowChoiceStore, offerWorkflowChoice, startChosenWorkflow, type SlackWorkflowStartInput } from "../../packages/broker/src/aws/slack-workflow-choice.js";
import { createChoiceOffer, routeSlackRequest } from "../../packages/slack-service/src/request-routing.js";
import type { RequestRoute } from "../../packages/orchestrator/src/request-router.js";
import type { Notice } from "../../packages/broker/src/developer/notifications.js";
import type { GitHubPullRequestDetails, GitHubPullRequestFeedback, GitHubPullRequestInput, GitHubPullRequestResult, GitHubPullRequestUpdate } from "../../packages/broker/src/github-app.js";
import { RepositoryGrantService } from "../../packages/broker/src/repository-access.js";
import { createWorkerCallbackSinks } from "../../packages/worker/src/callback-client.js";
import { createDefaultPiSessionAdapter } from "../../packages/worker/src/pi-session.js";
import { createRepositoryCredentialProvider } from "../../packages/worker/src/repository-credentials.js";
import { runTaskInvocation } from "../../packages/worker/src/run-task.js";
import { projectCheckKey } from "../../packages/worker/src/verification/check-history.js";
import type { CheckRunners } from "../../packages/worker/src/verification/checks.js";
import { createFixtureDirectory } from "../fixtures/index.js";
import { MAYA, createDeveloperTaskBroker, recordStream } from "./developer-task-broker.js";
import { FAUX_MODEL, fauxModelRuntime } from "./faux-model.js";
import { workflowModel, type WorkflowTurn } from "./faux-scripts.js";
import { SLACK_CHANNEL, SLACK_TEAM, registerSlackProject, type Handler } from "./slack-broker.js";
import { SlackPostError } from "../../packages/broker/src/aws/slack-web.js";
import { StrictSlackWeb } from "./strict-slack.js";

const execFile = promisify(execFileCallback);

/** The project's one readiness check; the worker stub's runners pass it. */
export const E2E_CHECK: ProjectCommand = { cwd: "repo/demo", executable: "node", args: ["--version"], timeoutSeconds: 30 };

const SIGNING_SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
const BOT_USER = "U0BOT000001";
const THREAD_TS = "1695500000.000001";
const CONTROL_PLANE_URL = "https://agentx.internal";
const REPOSITORY_URL = "https://github.com/example/demo.git";
const RESPONSE_URL = "https://hooks.slack.com/actions/T0BSHLLUGBD/1/e2e";
const MANIFEST_PATH = ".agentx/preparation-manifest.json";
const MAX_SETTLE_STEPS = 40;

type FakePullRequest = { number: number; url: string; headBranch: string; baseBranch: string; title: string; body?: string; draft?: boolean; commit: string; tree: string; state: "open" | "closed" | "merged" };

/**
 * GitHub as the broker and worker see it: tokens it issued (and for which access), pushes made with them,
 * commit trees, and pull requests opened from a pushed branch.
 */
export class FakeGitHub {
  readonly tokens = new Map<string, "clone" | "push">();
  readonly pushes = new Map<string, { commit: string; tree: string; token: string }>();
  readonly commits = new Map<string, string>();
  /** Each pushed commit's parents. */
  readonly parents = new Map<string, string[]>();
  readonly pullRequests: FakePullRequest[] = [];
  /** Every token minted, with the kind of worker invocation running when it was (set by the harness). */
  readonly minted: Array<{ token: string; access: "clone" | "push"; during: string | undefined }> = [];
  /** The kind of worker invocation now running, or undefined between invocations. */
  during: string | undefined;

  async resolveCredential(_reference: string, _url: string, access: "clone" | "push"): Promise<{ token: string }> {
    const token = `ghs_e2e_${access}_${this.tokens.size + 1}`;
    this.tokens.set(token, access);
    this.minted.push({ token, access, during: this.during });
    return { token };
  }

  push(token: string | undefined, headBranch: string, commit: string, tree: string, parents: readonly string[] = []): void {
    if (token === undefined || this.tokens.get(token) !== "push") throw new Error(`GitHub refused the push to ${headBranch}: the token cannot push`);
    this.pushes.set(headBranch, { commit, tree, token });
    this.commits.set(commit, tree);
    this.parents.set(commit, [...parents]);
  }

  private find(number: number): FakePullRequest {
    const found = this.pullRequests.find((pullRequest) => pullRequest.number === number);
    if (found === undefined) throw new Error(`GitHub has no pull request #${number}`);
    return found;
  }

  private details(pullRequest: FakePullRequest): GitHubPullRequestDetails {
    return {
      number: pullRequest.number, url: pullRequest.url, state: pullRequest.state, headBranch: pullRequest.headBranch,
      baseBranch: pullRequest.baseBranch, headCommit: pullRequest.commit, title: pullRequest.title, body: pullRequest.body ?? "",
    };
  }

  readonly gateway = {
    reconcilePullRequest: async (input: GitHubPullRequestInput): Promise<GitHubPullRequestResult> => {
      const pushed = this.pushes.get(input.headBranch);
      if (pushed === undefined) throw new Error(`GitHub has no branch ${input.headBranch}`);
      const existing = this.pullRequests.find((pullRequest) => pullRequest.headBranch === input.headBranch && pullRequest.state === "open");
      if (existing !== undefined) return { number: existing.number, url: existing.url, reconciled: true };
      const number = this.pullRequests.length + 1;
      const url = `https://github.com/example/demo/pull/${number}`;
      this.pullRequests.push({
        number, url, headBranch: input.headBranch, baseBranch: input.baseBranch, title: input.title,
        ...(input.body === undefined ? {} : { body: input.body }), ...(input.draft === undefined ? {} : { draft: input.draft }),
        commit: pushed.commit, tree: pushed.tree, state: "open",
      });
      return { number, url, reconciled: false };
    },
    getPullRequest: async (_repositoryUrl: string, number: number): Promise<GitHubPullRequestDetails> => this.details(this.find(number)),
    updatePullRequest: async (_repositoryUrl: string, number: number, update: GitHubPullRequestUpdate): Promise<GitHubPullRequestDetails> => {
      const pullRequest = this.find(number);
      if (update.title !== undefined) pullRequest.title = update.title;
      if (update.body !== undefined) pullRequest.body = update.body;
      if (update.state !== undefined) pullRequest.state = update.state;
      return this.details(pullRequest);
    },
    getBranchHead: async (_repositoryUrl: string, branch: string): Promise<string> => {
      const pushed = this.pushes.get(branch);
      if (pushed === undefined) throw new Error(`GitHub has no branch ${branch}`);
      return pushed.commit;
    },
    getCommitTree: async (_repositoryUrl: string, commit: string): Promise<string> => {
      const tree = this.commits.get(commit);
      if (tree === undefined) throw new Error(`GitHub has no commit ${commit}`);
      return tree;
    },
    getCommitParents: async (_repositoryUrl: string, commit: string): Promise<string[]> => {
      const parents = this.parents.get(commit);
      if (parents === undefined) throw new Error(`GitHub has no commit ${commit}`);
      return parents;
    },
    getPullRequestFeedback: async (_repositoryUrl: string, number: number): Promise<GitHubPullRequestFeedback> => {
      const pullRequest = this.find(number);
      return { pullRequest: { ...this.details(pullRequest), headTreeSha: pullRequest.tree }, comments: [], threads: [] };
    },
  };
}

function signedRequest(rawPath: string, body: string): HttpApiV2Event {
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const signature = `v0=${createHmac("sha256", SIGNING_SECRET).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  return {
    version: "2.0", rawPath, headers: { "X-Slack-Request-Timestamp": timestamp, "X-Slack-Signature": signature },
    body, isBase64Encoded: false, requestContext: { requestId: randomUUID(), http: { method: "POST" } },
  };
}

/** The worker's control-plane fetch, delivered straight to the broker handler (callbacks carry no IAM authorizer). */
function workerFetch(handler: Handler): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const given = new Headers(init?.headers);
    const headers: Record<string, string> = {};
    for (const name of ["x-agentx-callback-capability", "x-agentx-repository-grant", "content-type"]) {
      const value = given.get(name);
      if (value !== null) headers[name] = value;
    }
    const response = await handler({
      version: "2.0", rawPath: url.pathname, rawQueryString: "", headers,
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
      requestContext: { requestId: randomUUID(), http: { method: init?.method ?? "POST" } },
    });
    return new Response(response.body, { status: response.statusCode, headers: { "content-type": "application/json" } });
  };
}

/** The broker invoked directly, as the AWS wiring's Lambda invoke does: the event in, the handler's answer out. */
function invokeBroker(handler: Handler) {
  return async (event: Record<string, unknown>) => {
    const response = await handler(event);
    return { statusCode: response.statusCode, body: response.body };
  };
}

/**
 * A Slack workflow press handed to the broker through the production adapter: an asynchronous invoke that Lambda
 * accepts with 202. Here the "invoke" runs the broker to completion first, so a test sees its effect at once; the
 * broker's answer is never read, as in production (a refusal reaches the thread through the notifier).
 */
function brokerEvent(handler: Handler, action: string, input: Record<string, unknown>): Promise<void> {
  const lambda = { async send(command: InvokeCommand) {
    await handler(JSON.parse(Buffer.from(command.input.Payload as Uint8Array).toString("utf8")) as Record<string, unknown>);
    return { StatusCode: 202 };
  } };
  return invokeWorkflowDecision(lambda, "broker", { source: "agentx.slack-ingress", action, ...input });
}

function actionElement(blocks: unknown[] | undefined, actionId: string): { value?: string } | undefined {
  for (const block of blocks ?? []) {
    const record = block as { elements?: unknown[]; accessory?: unknown };
    for (const element of [...(record.elements ?? []), ...(record.accessory === undefined ? [] : [record.accessory])]) {
      if ((element as { action_id?: unknown }).action_id === actionId) return element as { value?: string };
    }
  }
  return undefined;
}

/** The brief limit on a task thread's messages (1,200 visible characters), on by default. */
export const E2E_BRIEF_LIMIT = 1_200;

/** The only broker routes a Slack-only journey reaches after setup: the worker's own callbacks. */
export const WORKER_CALLBACK_ROUTE = /^\/v1\/internal\/workspaces\/[^/]+\/operations\/[^/]+\//;

export async function createWorkflowE2E(options: {
  model?: Parameters<typeof workflowModel>[0];
  /** The thread brief limit; null turns it off. */
  briefLimit?: number | null;
  /** "unavailable": this Slack workspace cannot create a Canvas, so approval cards link the task page. */
  canvas?: "available" | "unavailable";
  /** Project-approved optional checks the owner may select when approving the coding plan. */
  optionalChecks?: WorkflowOptionalCheck[];
  /** Runs in the worker just before it publishes, with the repository's directory (to change the workspace, say). */
  beforePublish?: (repositoryDirectory: string) => Promise<void>;
  /**
   * Task 21: the scripted classifier model that routes a plain top-level mention in the Slack service. Absent: the
   * classifier is unavailable, so every plain mention gets the Just answer / Quick / Full card.
   */
  route?: (text: string) => RequestRoute | Promise<RequestRoute>;
} = {}) {
  const github = new FakeGitHub();
  const harness = await createDeveloperTaskBroker({
    register: false,
    brokerExtra: {
      githubPullRequests: github.gateway,
      repositoryGrants: new RepositoryGrantService(Buffer.alloc(32, 4), (reference, url, access) => github.resolveCredential(reference, url, access)),
    },
  });
  const { db, s3 } = harness;
  await registerSlackProject(harness.handler, { readiness: [E2E_CHECK],
    ...(options.optionalChecks === undefined ? {} : { developerTasks: { optionalWorkflowChecks: options.optionalChecks } }) });
  // After setup, every call that reaches the broker is recorded: an HTTP route, or an event's source and action.
  const brokerCalls: string[] = [];
  const handler: Handler = async (event, context) => {
    const record = event as { rawPath?: unknown; source?: unknown; action?: unknown; type?: unknown };
    brokerCalls.push(typeof record.rawPath === "string" ? record.rawPath : `event:${String(record.source)}/${String(record.action ?? record.type)}`);
    return harness.handler(event, context);
  };
  const briefLimit = options.briefLimit === null ? undefined : options.briefLimit ?? E2E_BRIEF_LIMIT;
  const slack = new StrictSlackWeb(briefLimit === undefined ? {} : { briefLimit });

  // The prepared workspace: a real repository with one commit, and the manifest preparation would leave.
  const root = await createFixtureDirectory("agentx-e2e-");
  const repoDirectory = join(root, "repo", "demo");
  await mkdir(repoDirectory, { recursive: true });
  const git = async (args: string[], env?: NodeJS.ProcessEnv): Promise<string> =>
    (await execFile("git", ["-C", repoDirectory, ...args], env === undefined ? {} : { env: { ...process.env, ...env } })).stdout.trim();
  await git(["init", "--quiet", "-b", "main"]);
  await git(["config", "user.email", "e2e@example.invalid"]);
  await git(["config", "user.name", "AgentX E2E"]);
  await writeFile(join(repoDirectory, "greeting.ts"), "export const placeholder = true;\n");
  // A file the change never touches: a finding in it can only be an older problem.
  await writeFile(join(repoDirectory, "farewell.ts"), "export const farewell = (name) => 'Bye ' + name;\n");
  await git(["add", "greeting.ts", "farewell.ts"]);
  await git(["commit", "--quiet", "-m", "base"]);
  const baseCommit = await git(["rev-parse", "HEAD"]);
  github.commits.set(baseCommit, await git(["rev-parse", "HEAD^{tree}"]));
  const now = new Date().toISOString();
  await mkdir(join(root, ".agentx"), { recursive: true });
  await writeFile(join(root, MANIFEST_PATH), JSON.stringify({
    schemaVersion: 2, projectName: "payments", projectRevision: 1,
    repositories: [{ name: "demo", path: "repo/demo", defaultBranch: "main", resolvedCommit: baseCommit, resolvedAt: now, completedAt: now }],
    completedSetupSteps: [], readinessResults: [], readinessCommandKeys: [projectCheckKey(E2E_CHECK)], creationIdentity: "e2e", complete: true, updatedAt: now,
  }));

  // The worker: the real run-task on the scripted model, with check runners that pass.
  const prompts: string[] = options.model?.prompts ?? [];
  const turns: WorkflowTurn[] = options.model?.turns ?? [];
  const { modelRuntime, faux } = await fauxModelRuntime();
  const step = workflowModel({ ...(options.model ?? { plan: "# Coding plan\n\n1. Change nothing.", edits: [] }), prompts, turns });
  faux.setResponses(Array.from({ length: 500 }, () => step));
  const piAdapter = createDefaultPiSessionAdapter({ modelRuntime: async () => ({ runtime: modelRuntime, model: FAUX_MODEL }) });

  /** The workspace's tree as it is now (tracked and untracked files), read through a scratch index. */
  const workspaceTree = async (label: string): Promise<string> => {
    const index = join(root, `.agentx-e2e-index-${label}-${randomUUID()}`);
    try {
      await git(["read-tree", "HEAD"], { GIT_INDEX_FILE: index });
      await git(["add", "--all"], { GIT_INDEX_FILE: index });
      return await git(["write-tree"], { GIT_INDEX_FILE: index });
    } finally {
      await rm(index, { force: true });
    }
  };

  /** Every project command a check round ran, with the workspace tree it ran on; each passes. */
  const checkRuns: Array<{ command: ProjectCommand; tree: string }> = [];
  const checkRunners: CheckRunners = {
    runAgentCommand: async () => ({ exitCode: 0, timedOut: false, output: "ok\n" }),
    runProjectCommand: async (command) => {
      checkRuns.push({ command, tree: await workspaceTree("check") });
      return { exitCode: 0, timedOut: false, stdout: "ok\n", stderr: "" };
    },
  };

  /** The worker's publication, simulated: the workspace tree, committed onto the base and pushed with a push-scoped token. */
  const publish = async (invocation: Extract<WorkerInvocation, { kind: "publish" }>, callbacks: ReturnType<typeof createWorkerCallbackSinks>): Promise<unknown> => {
    const { payload } = invocation;
    const repository = payload.project.repositories.find((entry) => entry.name === payload.repository);
    if (repository === undefined) throw new Error(`the project has no repository ${payload.repository}`);
    // The worker publishes only the checked code: the broker must name its tree, and the workspace must still be it.
    // (The broker's own branch and pull request head checks are covered in developer-task-workflow-flow.test.ts.)
    await options.beforePublish?.(repoDirectory);
    const checkedTree = payload.candidateTreeSha;
    if (checkedTree === undefined) throw new Error("the publish request does not name the checked tree");
    const tree = await workspaceTree(invocation.operationId);
    if (checkedTree !== tree) throw new Error(`the workspace tree ${tree} is not the checked tree ${checkedTree}`);
    const credential = await createRepositoryCredentialProvider({ controlPlaneUrl: CONTROL_PLANE_URL, invocation, fetchImplementation: workerFetch(handler) })(repository);
    // The commit goes on the base the broker pinned for the task, as the worker builds it.
    if (payload.workflowBaseCommit !== baseCommit) throw new Error(`the publish request names base ${String(payload.workflowBaseCommit)}, not the task's base ${baseCommit}`);
    const commit = await git(["commit-tree", tree, "-p", payload.workflowBaseCommit, "-m", `AgentX: ${payload.title}`]);
    github.push(credential.token, payload.headBranch, commit, tree, [payload.workflowBaseCommit]);
    const pullRequest = await callbacks.pullRequestSink({
      repository: "demo", repositoryUrl: REPOSITORY_URL, headBranch: payload.headBranch, baseBranch: "main", commit, title: payload.title,
      ...(payload.body ? { body: payload.body } : {}),
    });
    return { repository: "demo", number: pullRequest.number, url: pullRequest.url, headBranch: payload.headBranch, baseBranch: "main", commit, checks: [], reconciled: false };
  };

  /**
   * A repository credential exchange through the broker's real route, as a worker would make it for `invocation`'s
   * operation, with `grant` (or none); recorded in `credentialAttempts` with the HTTP status the broker answered.
   */
  const credentialAttempts: Array<{ during: WorkerInvocation["kind"]; grant: "own" | "none" | "earlier"; access: "clone" | "push"; status: number }> = [];
  const grants: string[] = [];
  const exchangeCredential = async (invocation: WorkerInvocation, grant: { kind: "own" | "none" | "earlier"; value?: string }, access: "clone" | "push"): Promise<void> => {
    const endpoint = `${CONTROL_PLANE_URL}/v1/internal/workspaces/${invocation.workspaceId}/operations/${invocation.operationId}/repository-credentials`;
    github.during = invocation.kind;
    try {
      const response = await workerFetch(handler)(endpoint, { method: "POST",
        headers: { "content-type": "application/json", ...(grant.value === undefined ? {} : { "x-agentx-repository-grant": grant.value }) },
        body: JSON.stringify({ credentialRef: "github-app", repositoryUrl: REPOSITORY_URL, access }) });
      credentialAttempts.push({ during: invocation.kind, grant: grant.kind, access, status: response.status });
    } finally {
      github.during = undefined;
    }
  };

  /**
   * What a worker could get for this invocation's repositories. Preparation's grant clones and cannot push. A coding,
   * check or review run is given no grant at all, so it can get nothing: not with no grant, and not with a grant
   * issued for another operation.
   */
  const probeCredentials = async (invocation: WorkerInvocation): Promise<void> => {
    const own = "repositoryGrant" in invocation.payload ? invocation.payload.repositoryGrant : undefined;
    if (invocation.kind === "prepare" && own !== undefined) {
      await exchangeCredential(invocation, { kind: "own", value: own }, "clone");
      await exchangeCredential(invocation, { kind: "own", value: own }, "push");
    }
    if (invocation.kind === "task") {
      if (own !== undefined) throw new Error("a task invocation carries a repository grant");
      for (const access of ["clone", "push"] as const) {
        await exchangeCredential(invocation, { kind: "none" }, access);
        for (const earlier of grants) await exchangeCredential(invocation, { kind: "earlier", value: earlier }, access);
      }
    }
    if (own !== undefined) grants.push(own);
  };

  const runInvocation = async (invocation: WorkerInvocation): Promise<void> => {
    const callbacks = createWorkerCallbackSinks({ controlPlaneUrl: CONTROL_PLANE_URL, invocation, fetchImplementation: workerFetch(handler) });
    const { operationId } = invocation;
    await probeCredentials(invocation);
    if (invocation.kind === "prepare") {
      await callbacks.terminalSink({ operationId, status: "SUCCEEDED", result: { manifestPath: MANIFEST_PATH, projectName: "payments", projectRevision: invocation.projectRevision,
        preparedBase: [{ repositoryId: "demo", baseCommitSha: baseCommit }] } });
      return;
    }
    if (invocation.kind !== "task" && invocation.kind !== "publish") throw new Error(`the E2E worker does not run ${invocation.kind} invocations`);
    let result: unknown;
    github.during = invocation.kind;
    try {
      result = invocation.kind === "publish" ? await publish(invocation, callbacks) : await runTaskInvocation(invocation, {
        rootPath: root, model: FAUX_MODEL, piAdapter, eventSink: callbacks.eventSink, artifactSink: callbacks.artifactSink, checkRunners,
      });
    } catch (error) {
      await callbacks.terminalSink({ operationId, status: "FAILED", error: error instanceof Error ? error.message : String(error) });
      return;
    } finally {
      github.during = undefined;
    }
    await callbacks.terminalSink({ operationId, status: "SUCCEEDED", result });
  };

  const processed = new Set<string>();
  const pendingInvocation = (): WorkerInvocation | undefined => {
    for (const item of db.find((entry) => entry.entityType === "OUTBOX")) {
      const parsed = WorkerInvocationSchema.safeParse(item.invocation);
      if (!parsed.success || processed.has(parsed.data.operationId)) continue;
      const operation = db.get(`WORKSPACE#${parsed.data.workspaceId}`, `OPERATION#${parsed.data.operationId}`);
      if (operation?.status !== "ACCEPTED") continue;
      return parsed.data;
    }
    return undefined;
  };

  // The notifier, fed from the table's writes as the stream would feed it.
  const stream = recordStream(db);
  const queue: Array<{ notice: Notice; attempt: number }> = [];
  let canvas = 0;
  const notify = createNotifierHandler({
    documentClient: db, tableName: "state",
    enqueue: async (notices) => { for (const notice of notices) queue.push({ notice, attempt: 0 }); },
    retryLater: async () => undefined,
    post: async (input) => slack.post(input),
    update: async (input) => slack.update(input),
    postEphemeral: async (input) => { slack.postEphemeral(input); },
    readArtifact: async (key) => s3.objects.get(key)!,
    createPlanCanvas: async (_input, onCreated) => {
      if (options.canvas === "unavailable") throw new SlackPostError("canvas_globally_disabled", "conversations.canvases.create");
      const id = `F${String(++canvas).padStart(9, "0")}`;
      await onCreated?.(id);
      return { canvasId: id, permalink: `https://acme.slack.com/docs/${SLACK_TEAM}/${id}` };
    },
    reviewUrlBase: "https://agentx.example.test",
    now: () => Date.now(), log: () => undefined, deliveryFailed: () => undefined,
  });
  /** Stream to queue, then every queued notice once; failed ones stay queued. */
  const pumpNotices = async () => {
    await notify({ Records: stream.take().map((record) => ({ ...record, eventSource: "aws:dynamodb" })) });
    const batch = queue.splice(0, queue.length);
    const answer = await notify({ Records: batch.map((entry, index) => ({ eventSource: "aws:sqs", messageId: `m${index}`, receiptHandle: `r${index}`, body: JSON.stringify(entry.notice), attributes: { ApproximateReceiveCount: String(entry.attempt + 1) } })) });
    const failed = new Set(answer.batchItemFailures.map((failure) => failure.itemIdentifier));
    batch.forEach((entry, index) => { if (failed.has(`m${index}`)) queue.push({ notice: entry.notice, attempt: entry.attempt + 1 }); });
  };

  // Slack's Events API endpoint.
  const claimed = new Set<string>();
  const noticed = new Set<string>();
  const chatQueue: unknown[] = [];
  // The production adapter: its request ID derivation from the Slack event ID, and its refusal error.
  const startWorkflow = (input: SlackWorkflowStartInput) => startWorkflowThroughBroker(invokeBroker(handler), input);
  // A plain request waits for its requester's Quick or Full choice, on the production store and adapters.
  const choices = createDynamoWorkflowChoiceStore({ documentClient: db, tableName: "slack-threads" });
  const chooseWorkflowPath = (input: Parameters<typeof startChosenWorkflow>[1]) => startChosenWorkflow({ store: choices, startWorkflow,
    updateQuestion: async (question) => { slack.update(question); } }, input);
  // Task 21: "Just answer" queues the waiting request for the chat agent, on the production store and adapters.
  const answerWorkflowChoice = (input: Parameters<typeof answerChosenRequest>[1]) => answerChosenRequest({ store: choices,
    enqueueAnswer: async (answer) => { chatQueue.push(SlackRequestMessageSchema.parse({ version: 1, ...answer, receivedAt: new Date().toISOString() })); },
    updateQuestion: async (question) => { slack.update(question); } }, input);
  // Task 21: the Slack service's side of a plain top-level mention: route it, then answer it or post its card.
  const routedQueue: SlackRequestMessage[] = [];
  const routeLogs: Array<{ event: string; fields: Readonly<Record<string, string | number | boolean>> }> = [];
  const routeCalls: string[] = [];
  const offerChoice = createChoiceOffer({ documentClient: db, tableName: "slack-threads",
    post: async (thread, text, blocks) => slack.post({ channel: thread.channelId, threadTs: thread.threadTs, text, ...(blocks === undefined ? {} : { blocks }) }).ts,
    log: (event, fields) => { routeLogs.push({ event, fields }); } });
  const runRoutedRequests = async () => {
    for (const message of routedQueue.splice(0, routedQueue.length)) {
      const route = options.route;
      await routeSlackRequest(message, {
        ...(route === undefined ? {} : { route: async (text: string) => { routeCalls.push(text); return route(text); } }),
        offer: offerChoice, answer: async (question) => { chatQueue.push(question); }, finish: async () => undefined,
        log: (event, fields) => { routeLogs.push({ event, fields }); },
      });
    }
  };
  const ingress = createSlackIngressHandler({
    secrets: async () => ({ signingSecret: SIGNING_SECRET, botToken: "xoxb-e2e" }),
    getBinding: async (teamId, channelId) => {
      const item = db.get(`SLACK_BINDING#${teamId}`, `CHANNEL#${channelId}`);
      return item === undefined ? undefined : SlackChannelBindingSchema.parse({ teamId: item.teamId, channelId: item.channelId, projectName: item.projectName, updatedAt: item.updatedAt });
    },
    claimEvent: async (eventId) => {
      if (claimed.has(eventId)) return false;
      claimed.add(eventId);
      return true;
    },
    releaseEvent: async (eventId) => { claimed.delete(eventId); },
    changePending: async () => 1,
    enqueue: async (message) => { chatQueue.push(message); },
    postMessage: (input) => slack.postMessage(input),
    startWorkflow,
    requestWorkflowChoice: (input) => offerWorkflowChoice({ store: choices, postMessage: async (message) => slack.post(message) }, input),
    chooseWorkflowPath,
    pendingWorkflowChoice: (thread) => choices.pending(thread),
    routeRequest: async (message) => { routedQueue.push(message); },
    answerWorkflowChoice,
    // The production adapters: a reply in the task's thread goes to the broker's thread-note event, and its
    // private acknowledgement through the strict Slack double.
    recordThreadNote: (input) => recordThreadNoteThroughBroker(invokeBroker(handler), input),
    postEphemeral: async (input) => { slack.postEphemeral(input); },
    sharedTask: {
      lookup: async (thread: SlackThread) => {
        const item = db.get(sharedTaskKey(thread).pk, "META");
        if (item === undefined) return undefined;
        const record = SharedTaskRecordSchema.parse(item);
        return { mode: record.mode, closed: record.closedAt !== undefined, taskId: record.taskId,
          ...(record.workflowThread === true ? { workflowThread: true as const } : {}) };
      },
      claimNotice: async (subject, _nowSeconds, kind) => {
        const key = `${subject}#${kind}`;
        if (noticed.has(key)) return false;
        noticed.add(key);
        return true;
      },
    },
  });

  // Slack's interactivity endpoint.
  const interactivity = createSlackInteractivityHandler({
    secrets: async () => ({ signingSecret: SIGNING_SECRET, botToken: "xoxb-e2e" }),
    handlers: [],
    respondEphemeral: (url, text) => slack.respondEphemeral(url, text),
    workflow: workflowSlackHandlers({
      loadTask: async (id) => db.get(`DEVTASK#${id}`, "META"),
      openView: (triggerId, view) => slack.openView(triggerId, view),
      submit: (input) => brokerEvent(handler, "workflow-decision", input),
      retryChecks: (input) => brokerEvent(handler, "workflow-retry", input),
      retryReviews: (input) => brokerEvent(handler, "workflow-review-retry", input),
      retryPublication: (input) => brokerEvent(handler, "workflow-publish-retry", input),
      sendBack: (input) => brokerEvent(handler, "workflow-send-back", input),
      retryPlan: (input) => brokerEvent(handler, "workflow-retry", input),
      retryImplementation: (input) => brokerEvent(handler, "workflow-retry", input),
      close: (input) => brokerEvent(handler, "workflow-close", input),
      chooseWorkflowPath,
      answerWorkflowChoice,
      respondEphemeral: (url, text) => slack.respondEphemeral(url, text),
    }),
  });
  const interact = async (payload: Record<string, unknown>) => {
    const response = await interactivity(signedRequest("/v1/slack/interactions", new URLSearchParams({ payload: JSON.stringify(payload) }).toString()));
    if (response.statusCode !== 200) throw new Error(`Slack interactivity answered ${response.statusCode}: ${response.body}`);
    return JSON.parse(response.body) as Record<string, unknown>;
  };

  let sequence = 0;
  return {
    db, handler, slack, github, repoDirectory, baseCommit, prompts, turns, chatQueue, checkRuns, brokerCalls, credentialAttempts, routeCalls, routeLogs,

    /** A signed Events API callback for a message in the test thread; answers the HTTP status. */
    async mention(text: string, mentionOptions: { user?: string; threadTs?: string; type?: "app_mention" | "message"; ts?: string } = {}): Promise<number> {
      sequence += 1;
      const threadTs = mentionOptions.threadTs ?? THREAD_TS;
      const ts = mentionOptions.ts ?? `1695500000.${String(sequence).padStart(6, "0")}`;
      const type = mentionOptions.type ?? "app_mention";
      const payload = {
        type: "event_callback", team_id: SLACK_TEAM, event_id: `Ev${String(sequence).padStart(10, "0")}`,
        authorizations: [{ team_id: SLACK_TEAM, user_id: BOT_USER, is_bot: true }],
        event: {
          type, user: mentionOptions.user ?? MAYA.slackUserId, team: SLACK_TEAM, channel: SLACK_CHANNEL, ts,
          ...(ts === threadTs ? {} : { thread_ts: threadTs }),
          text: type === "app_mention" ? `<@${BOT_USER}> ${text}` : text,
        },
      };
      const status = (await ingress(signedRequest("/v1/slack/events", JSON.stringify(payload)))).statusCode;
      // The Slack service takes a routed request off the queue after Slack has its answer.
      await runRoutedRequests();
      return status;
    },

    /** Presses the button `actionId` on the latest message that carries it. */
    async click(actionId: string, clickOptions: { user?: string } = {}): Promise<void> {
      const post = slack.lastPostWithAction(actionId);
      const value = actionElement(post.blocks, actionId)?.value ?? "";
      await interact({
        type: "block_actions", user: { id: clickOptions.user ?? MAYA.slackUserId, team_id: SLACK_TEAM }, team: { id: SLACK_TEAM },
        container: { channel_id: post.channel, message_ts: post.ts, thread_ts: post.threadTs }, message: { ts: post.ts, thread_ts: post.threadTs, text: post.text },
        response_url: RESPONSE_URL, trigger_id: "1.2.3", actions: [{ action_id: actionId, value, action_ts: "1695500100.000001" }],
      });
    },

    /** Submits the latest opened modal with these input values; throws when Slack would show form errors. */
    async submitView(values: Record<string, Record<string, unknown>> = {}, submitOptions: { user?: string } = {}): Promise<void> {
      const opened = slack.views.at(-1);
      if (opened === undefined) throw new Error("no modal is open");
      const answer = await interact({
        type: "view_submission", user: { id: submitOptions.user ?? MAYA.slackUserId, team_id: SLACK_TEAM }, team: { id: SLACK_TEAM },
        view: { callback_id: opened.view.callback_id, private_metadata: opened.view.private_metadata, state: { values } },
      });
      if (answer.response_action === "errors") throw new Error(`the modal refused the submission: ${JSON.stringify(answer.errors)}`);
    },

    /** Delivers notices and runs every accepted worker invocation until nothing is pending. */
    async settle(maxSteps = MAX_SETTLE_STEPS): Promise<void> {
      for (let step = 0; ; step += 1) {
        await pumpNotices();
        const invocation = pendingInvocation();
        if (invocation === undefined) break;
        if (step >= maxSteps) throw new Error(`the workflow did not settle within ${maxSteps} steps`);
        processed.add(invocation.operationId);
        await runInvocation(invocation);
      }
      await pumpNotices();
    },

    taskId(): string {
      const tasks = db.find((item) => String(item.pk).startsWith("DEVTASK#") && item.sk === "META");
      if (tasks.length !== 1) throw new Error(`expected one task, found ${tasks.length}`);
      return String(tasks[0]!.pk).slice("DEVTASK#".length);
    },

    workflow(): WorkflowSnapshot {
      return WorkflowSnapshotSchema.parse(db.get(`DEVTASK#${this.taskId()}`, "META")?.workflow);
    },

    repoFile: (path: string): Promise<string> => readFile(join(repoDirectory, path), "utf8"),
  };
}

export type WorkflowE2E = Awaited<ReturnType<typeof createWorkflowE2E>>;
