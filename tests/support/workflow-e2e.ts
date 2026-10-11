// One process, the whole Slack workflow: a signed Slack mention goes through the real slack-ingress and the
// broker's start-workflow event, the notifier posts to a strict Slack double, buttons and modals go through the
// real interactivity handler, and a worker stub runs the real run-task on the scripted faux model against a real
// git repository. GitHub is a fake that only accepts a push made with a push-scoped token.
import { createHmac, generateKeyPairSync, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import {
  SharedTaskRecordSchema,
  SlackChannelBindingSchema,
  SlackRequestMessageSchema,
  WorkerInvocationSchema,
  WorkflowSnapshotSchema,
  sharedTaskKey,
  slackThreadSubject,
  type ProjectCommand,
  type SlackRequestMessage,
  type SlackThread,
  type TaskQuestionRoute,
  type WorkerInvocation,
  type WorkflowOptionalCheck,
  type WorkflowSnapshot,
} from "@agentx/contracts";
import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import type { InvokeCommand } from "@aws-sdk/client-lambda";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import type { HttpApiV2Event } from "../../packages/broker/src/aws/lambda.js";
import { createNotifierHandler } from "../../packages/broker/src/aws/developer-task-notifier.js";
import { captureFeedbackNoteThroughBroker, createSlackIngressHandler, recordThreadNoteThroughBroker, startWorkflowThroughBroker } from "../../packages/broker/src/aws/slack-ingress.js";
import { createSlackInteractivityHandler, invokeWorkflowDecision, workflowSlackHandlers } from "../../packages/broker/src/aws/slack-interactivity.js";
import { answerChosenRequest, createDynamoWorkflowChoiceStore, offerWorkflowChoice, startChosenWorkflow, type SlackWorkflowStartInput } from "../../packages/broker/src/aws/slack-workflow-choice.js";
import { createChoiceOffer, routeSlackRequest } from "../../packages/slack-service/src/request-routing.js";
import { createHostedSlackRuntime } from "../../packages/slack-service/src/runtime.js";
import { handleTaskQuestion, runTaskAnswer } from "../../packages/slack-service/src/task-question.js";
import { createThreadApi } from "../../packages/slack-service/src/thread-api.js";
import { runOrchestratorTurn } from "../../packages/orchestrator/src/orchestrator.js";
import type { OrchestrationApi } from "../../packages/orchestrator/src/orchestration-tools.js";
import type { RequestRoute } from "../../packages/orchestrator/src/request-router.js";
import type { Notice, StreamRecord } from "../../packages/broker/src/developer/notifications.js";
import type { GitHubFeedbackComment, GitHubPullRequestFeedback } from "../../packages/broker/src/github-app.js";
import { GitHubAppCredentialProvider, webhookSecretFromSecret } from "../../packages/broker/src/github-app.js";
import { RepositoryGrantService } from "../../packages/broker/src/repository-access.js";
import { runPlanEvidenceJob, type PlanEvidenceRunOutcome } from "../../packages/broker/src/aws/plan-evidence-handler.js";
import type { PlanEvidenceEvent } from "../../packages/broker/src/developer/plan-evidence-jobs.js";
import { createWorkerCallbackSinks } from "../../packages/worker/src/callback-client.js";
import { createDefaultPiSessionAdapter } from "../../packages/worker/src/pi-session.js";
import { createRepositoryCredentialProvider } from "../../packages/worker/src/repository-credentials.js";
import { runTaskInvocation } from "../../packages/worker/src/run-task.js";
import { projectCheckKey } from "../../packages/worker/src/verification/check-history.js";
import type { CheckRunners } from "../../packages/worker/src/verification/checks.js";
import { createFixtureDirectory } from "../fixtures/index.js";
import { MAYA, createDeveloperTaskBroker, recordStream, type Developer } from "./developer-task-broker.js";
import { FAUX_MODEL, fauxModelRuntime } from "./faux-model.js";
import { workflowModel, type WorkflowTurn } from "./faux-scripts.js";
import { planAnswer, planDocument, turnPlanIntoMarkdown } from "./plan-documents.js";
import { SLACK_CHANNEL, SLACK_TEAM, call, orchestratorPrincipal, registerSlackProject, type Handler } from "./slack-broker.js";
import { SlackPostError } from "../../packages/broker/src/aws/slack-web.js";
import { StrictSlackWeb } from "./strict-slack.js";
import { FakeGitHub, type FakeGitHubOptions } from "./workflow-e2e-github.js";

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
/** The GitHub App's webhook secret, as the broker reads it; the test signs its deliveries with it. */
const WEBHOOK_SECRET = "e2e-github-webhook-secret-0123456789abcdef";

export { FakeGitHub, type FakePullRequest, type FakeGitHubMethod, type GitHubReviewState } from "./workflow-e2e-github.js";

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

let wireAppKey: string | undefined;
/** The real provider's PR feedback read, over the fake's wire endpoints, with the App's own (test) private key. */
function wireFeedbackReader(github: FakeGitHub): (repositoryUrl: string, number: number) => Promise<GitHubPullRequestFeedback> {
  wireAppKey ??= generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
  const key = wireAppKey;
  const provider = new GitHubAppCredentialProvider({ credentialRef: "github-app", appId: "123", getPrivateKey: async () => key, fetchImplementation: github.fetch });
  return async (repositoryUrl, number) => {
    github.fault("getPullRequestFeedback");
    return provider.getPullRequestFeedback(repositoryUrl, number);
  };
}

/** A GitHub webhook event for a task's pull request, as `webhook()` builds and signs it. */
export type E2EWebhookEvent =
  | { kind: "issue_comment" | "pull_request_review_comment"; action?: "created" | "edited" | "deleted"; number: number; comment: GitHubFeedbackComment }
  | { kind: "pull_request_review"; action?: "submitted" | "edited" | "dismissed"; number: number; review: GitHubFeedbackComment; body?: string | null; state?: string }
  | { kind: "pull_request"; action: "synchronize" | "closed" | "opened" | "reopened" | "edited"; number: number; merged?: boolean };

/** GitHub's numeric ID for a feedback item (`discussion:12` -> 12). */
function githubDatabaseId(id: string): number {
  return Number(id.slice(id.indexOf(":") + 1));
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
  /**
   * The project's own checks (its readiness). Absent: the one check E2E_CHECK. An empty list is a project with no
   * checks, so a coding plan's proposed checks (or none, for review only) are all that the owner approves.
   */
  readiness?: ProjectCommand[];
  /** Project-approved optional checks the owner may select when approving the coding plan. */
  optionalChecks?: WorkflowOptionalCheck[];
  /**
   * What a project command's run returns, by command. Absent (or undefined for a command): it passes with "ok". Lets a test
   * make a check fail, or be broken (exit 126 or 127, a python SyntaxError), as the worker's own check runner would report it.
   */
  checkResult?: (command: ProjectCommand) => { exitCode: number | null; stdout: string; stderr: string } | undefined;
  /** Runs in the worker just before it publishes, with the repository's directory (to change the workspace, say). */
  beforePublish?: (repositoryDirectory: string) => Promise<void>;
  /**
   * Task 21: the scripted classifier model that routes a plain top-level mention in the Slack service. Absent: the
   * classifier is unavailable, so every plain mention gets the Just answer / Quick / Full card.
   */
  route?: (text: string) => RequestRoute | Promise<RequestRoute>;
  /**
   * A task started before plans became structured: the first planning step's stored document is this Markdown, with no
   * format and no evidence, as the table, the storage and the notifier's stream all see it.
   */
  legacyPlanMarkdown?: string;
  /**
   * GitHub's realism (head lag is on by default; `realism: { lag: false }` needs a comment saying why). `wire: true`: the
   * broker reads PR feedback through the real GitHubAppCredentialProvider over the fake's REST and GraphQL endpoints.
   */
  github?: FakeGitHubOptions & { wire?: boolean };
  /** The App secret's webhook secret: absent for the default; null when the secret holds none (the broker answers 503). */
  webhookSecret?: string | null;
} = {}) {
  const github = new FakeGitHub(options.github?.realism === undefined ? {} : { realism: options.github.realism });
  // The webhook secret GitHub signs with, and the copy the broker's container has cached (it re-reads on { refresh: true }).
  let configuredSecret: string | null = options.webhookSecret === undefined ? WEBHOOK_SECRET : options.webhookSecret;
  let cachedSecret = configuredSecret;
  const githubWebhookSecret = async (read?: { refresh?: boolean }): Promise<string> => {
    if (read?.refresh === true) cachedSecret = configuredSecret;
    // The production reader's own refusal for an App secret with no usable webhook secret.
    return cachedSecret === null ? webhookSecretFromSecret("{}") : cachedSecret;
  };
  const githubPullRequests = options.github?.wire === true
    ? { ...github.gateway, getPullRequestFeedback: wireFeedbackReader(github) }
    : github.gateway;
  // The plan evidence jobs the broker started: the background Lambda is run by the test, with `runPlanEvidenceJobs`.
  const planEvidenceJobs: PlanEvidenceEvent[] = [];
  const harness = await createDeveloperTaskBroker({
    register: false,
    brokerExtra: {
      githubPullRequests,
      startPlanEvidenceJob: async (event: PlanEvidenceEvent) => { planEvidenceJobs.push(event); },
      githubWebhookSecret,
      repositoryGrants: new RepositoryGrantService(Buffer.alloc(32, 4), (reference, url, access) => github.resolveCredential(reference, url, access)),
    },
  });
  const { db, s3 } = harness;
  const readiness = options.readiness ?? [E2E_CHECK];
  await registerSlackProject(harness.handler, { readiness,
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
  // Three lines, as the fake GitHub holds them for the quick-plan test: the worker checks cited lines against this checkout.
  await writeFile(join(repoDirectory, "greeting.ts"), "export const placeholder = true;\nexport const greeting = 'Hello';\nexport const punctuation = '!';\n");
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
    completedSetupSteps: [], readinessResults: [], readinessCommandKeys: readiness.map(projectCheckKey), creationIdentity: "e2e", complete: true, updatedAt: now,
  }));

  // The worker: the real run-task on the scripted model, with check runners that pass.
  const prompts: string[] = options.model?.prompts ?? [];
  const turns: WorkflowTurn[] = options.model?.turns ?? [];
  const { modelRuntime, faux } = await fauxModelRuntime();
  const step = workflowModel({ ...(options.model ?? { plan: planAnswer(planDocument()), edits: [] }), prompts, turns });
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

  /** Every project command a check round ran, with the workspace tree it ran on; each passes unless `checkResult` says otherwise. */
  const checkRuns: Array<{ command: ProjectCommand; tree: string }> = [];
  const checkRunners: CheckRunners = {
    runAgentCommand: async () => ({ exitCode: 0, timedOut: false, output: "ok\n" }),
    runProjectCommand: async (command) => {
      checkRuns.push({ command, tree: await workspaceTree("check") });
      const scripted = options.checkResult?.(command);
      return { timedOut: false, ...(scripted ?? { exitCode: 0, stdout: "ok\n", stderr: "" }) };
    },
  };

  /** The worker's publication, simulated: the workspace tree, committed onto the base, checked out as the head branch and pushed with a push-scoped token. */
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
    // The worker leaves the workspace on the published commit (same tree, new commit), so later reads see HEAD moved.
    await git(["checkout", "--force", "-B", payload.headBranch, commit]);
    github.push(credential.token, payload.headBranch, commit, tree, [payload.workflowBaseCommit]);
    const pullRequest = await callbacks.pullRequestSink({
      repository: "demo", repositoryUrl: REPOSITORY_URL, headBranch: payload.headBranch, baseBranch: "main", commit, title: payload.title,
      ...(payload.body ? { body: payload.body } : {}),
    });
    return { repository: "demo", number: pullRequest.number, url: pullRequest.url, headBranch: payload.headBranch, baseBranch: "main", commit, checks: [], reconciled: false };
  };

  /**
   * The worker's push of a reviewed fix to an existing pull request, simulated as the worker does it: the workspace must
   * still hold the reviewed tree, GitHub's branch head must be the one the broker expects (and the workspace must descend
   * from it), and the commit (the reviewed tree on that head) is pushed as a fast-forward with a push-scoped token.
   */
  const maintain = async (invocation: Extract<WorkerInvocation, { kind: "maintain" }>, callbacks: ReturnType<typeof createWorkerCallbackSinks>): Promise<unknown> => {
    const { payload } = invocation;
    const repository = payload.project.repositories.find((entry) => entry.name === payload.repository);
    if (repository === undefined) throw new Error(`the project has no repository ${payload.repository}`);
    if (payload.action !== "append" || payload.workflowCandidateTreeSha === undefined) throw new Error("the E2E worker pushes only a reviewed fix");
    if (payload.workflowBaseCommit !== baseCommit) throw new Error(`the fix names base ${String(payload.workflowBaseCommit)}, not the task's base ${baseCommit}`);
    const tree = await workspaceTree(invocation.operationId);
    if (tree !== payload.workflowCandidateTreeSha) throw new Error(`the workspace tree ${tree} is not the reviewed tree ${payload.workflowCandidateTreeSha}`);
    const credential = await createRepositoryCredentialProvider({ controlPlaneUrl: CONTROL_PLANE_URL, invocation, fetchImplementation: workerFetch(handler) })(repository);
    const remoteHead = github.pushes.get(payload.headBranch)?.commit;
    if (remoteHead !== payload.expectedHeadCommit) throw new Error(`STALE_FENCE: pull request head changed outside AgentX`);
    await git(["merge-base", "--is-ancestor", remoteHead, "HEAD"]);
    await git(["merge-base", "--is-ancestor", baseCommit, "HEAD"]);
    const commit = await git(["commit-tree", tree, "-p", remoteHead, "-m", "AgentX: address PR feedback"]);
    await git(["checkout", "--force", "-B", payload.headBranch, commit]);
    github.push(credential.token, payload.headBranch, commit, tree, [remoteHead]);
    const updated = await callbacks.pullRequestUpdateSink({ repository: payload.repository, pullRequestNumber: payload.pullRequestNumber, action: "append",
      headBranch: payload.headBranch, baseBranch: payload.baseBranch, previousCommit: remoteHead, commit });
    return { action: "append", repository: payload.repository, number: payload.pullRequestNumber, url: updated.url, state: updated.state,
      headBranch: payload.headBranch, baseBranch: payload.baseBranch, previousCommit: remoteHead, commit, treeSha: tree, checks: [], reconciled: updated.reconciled };
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

  /** Set once the planning step's stored document has been turned into Markdown (`legacyPlanMarkdown`). */
  let legacyPlan: ReturnType<typeof turnPlanIntoMarkdown> | undefined;
  /**
   * A stream record written before that turn still shows the structured document; the stream would have delivered the
   * state as the table now holds it, so the record's task images are given the same Markdown document.
   */
  const legacyRecord = (record: StreamRecord): StreamRecord => {
    const found = legacyPlan;
    if (found === undefined) return record;
    const legacyImage = (image: Record<string, AttributeValue> | undefined): Record<string, AttributeValue> | undefined => {
      if (image === undefined) return image;
      const item = unmarshall(image) as { entityType?: unknown; workflow?: { artifacts?: Array<Record<string, unknown>> } };
      if (item.entityType !== "DEVELOPER_TASK" || item.workflow?.artifacts === undefined) return image;
      const artifacts = item.workflow.artifacts.map((artifact) => {
        if (artifact.id !== found.artifactId) return artifact;
        const { format: _format, evidence: _evidence, ...legacy } = artifact;
        void _format;
        void _evidence;
        return { ...legacy, objectKey: found.objectKey, sha256: found.sha256 };
      });
      return marshall({ ...item, workflow: { ...item.workflow, artifacts } }, { removeUndefinedValues: true });
    };
    const { NewImage, OldImage, ...rest } = record.dynamodb ?? {};
    const newImage = legacyImage(NewImage);
    const oldImage = legacyImage(OldImage);
    return { ...record, dynamodb: { ...rest, ...(newImage === undefined ? {} : { NewImage: newImage }), ...(oldImage === undefined ? {} : { OldImage: oldImage }) } };
  };

  /** Every invocation the worker was given, as the broker queued it. */
  const invocations: WorkerInvocation[] = [];
  const runInvocation = async (invocation: WorkerInvocation): Promise<void> => {
    invocations.push(invocation);
    const callbacks = createWorkerCallbackSinks({ controlPlaneUrl: CONTROL_PLANE_URL, invocation, fetchImplementation: workerFetch(handler) });
    const { operationId } = invocation;
    await probeCredentials(invocation);
    if (invocation.kind === "prepare") {
      await callbacks.terminalSink({ operationId, status: "SUCCEEDED", result: { manifestPath: MANIFEST_PATH, projectName: "payments", projectRevision: invocation.projectRevision,
        preparedBase: [{ repositoryId: "demo", baseCommitSha: baseCommit }] } });
      return;
    }
    if (invocation.kind !== "task" && invocation.kind !== "publish" && invocation.kind !== "maintain") throw new Error(`the E2E worker does not run ${invocation.kind} invocations`);
    let result: unknown;
    github.during = invocation.kind;
    try {
      result = invocation.kind === "publish" ? await publish(invocation, callbacks) : invocation.kind === "maintain" ? await maintain(invocation, callbacks) : await runTaskInvocation(invocation, {
        rootPath: root, model: FAUX_MODEL, piAdapter, eventSink: callbacks.eventSink, artifactSink: callbacks.artifactSink,
        feedbackBundleReader: callbacks.feedbackBundleReader, authorizeFeedbackApproval: callbacks.authorizeFeedbackApproval, checkRunners,
      });
    } catch (error) {
      await callbacks.terminalSink({ operationId, status: "FAILED", error: error instanceof Error ? error.message : String(error) });
      return;
    } finally {
      github.during = undefined;
    }
    await callbacks.terminalSink({ operationId, status: "SUCCEEDED", result });
    if (options.legacyPlanMarkdown !== undefined && legacyPlan === undefined && invocation.kind === "task" && invocation.payload.workflowMode === "PLAN") {
      legacyPlan = turnPlanIntoMarkdown({ db, s3 }, invocation.workspaceId, operationId, options.legacyPlanMarkdown);
    }
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
    await notify({ Records: stream.take().map((record) => ({ ...legacyRecord(record), eventSource: "aws:dynamodb" })) });
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
  const taskQuestions: SlackRequestMessage[] = [];
  /** The route the ingress sent with each parked task question (its task, saved note and `chat:` mark), in the same order. */
  const taskQuestionRoutes: TaskQuestionRoute[] = [];
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
        notify: async (thread, text) => { slack.post({ channel: thread.channelId, threadTs: thread.threadTs, text }); },
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
    // A task-thread mention goes to the service's question check (built in a later task); a top-level request is routed.
    routeRequest: async (message, _groupId, taskQuestion) => {
      if (taskQuestion === undefined) routedQueue.push(message);
      else { taskQuestions.push(message); taskQuestionRoutes.push(taskQuestion); }
    },
    answerWorkflowChoice,
    // The production adapters: a reply in the task's thread goes to the broker's thread-note event, and its
    // private acknowledgement through the strict Slack double.
    recordThreadNote: (input) => recordThreadNoteThroughBroker(invokeBroker(handler), input),
    postEphemeral: async (input) => { slack.postEphemeral(input); },
    // A shared thread that is not a Slack-started task's own thread keeps the PR feedback note path.
    captureFeedbackNote: (input) => captureFeedbackNoteThroughBroker(invokeBroker(handler), input),
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
      resolveFindings: (input) => brokerEvent(handler, "workflow-resolve-findings", input),
      retryPlan: (input) => brokerEvent(handler, "workflow-retry", input),
      retryImplementation: (input) => brokerEvent(handler, "workflow-retry", input),
      close: (input) => brokerEvent(handler, "workflow-close", input),
      submitFeedback: (input) => brokerEvent(handler, "workflow-feedback-findings-decision", input),
      retryFeedbackReview: (input) => brokerEvent(handler, "workflow-feedback-review-retry", input),
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

  /**
   * The Slack service's control-plane client as it reaches the broker: a `/v1` request goes to the IAM-signed
   * `/v1/service` route as the orchestrator role, acting for the thread and member (the signing fetch's rewrite).
   */
  const serviceFetch = (thread: SlackThread, userId: string): typeof fetch => async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const response = await call(handler, {
      method: init?.method ?? "GET", path: `/v1/service${url.pathname.slice("/v1".length)}${url.search}`,
      service: { principal: orchestratorPrincipal, thread: slackThreadSubject(thread), slackUser: userId },
      ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as unknown } : {}),
    });
    return new Response(JSON.stringify(response.body), { status: response.status, headers: { "content-type": "application/json" } });
  };
  /** What each chat-agent answer turn was given: the text the model saw, and the tools it could use. */
  const taskAnswerTurns: Array<{ question: string; modelInput: string; tools: string[] }> = [];

  let sequence = 0;
  return {
    /** Runs, as the PlanEvidence Lambda would, every job the broker started since the last call; answers what each did. */
    async runPlanEvidenceJobs(): Promise<PlanEvidenceRunOutcome[]> {
      const outcomes: PlanEvidenceRunOutcome[] = [];
      for (const event of planEvidenceJobs.splice(0)) {
        outcomes.push(await runPlanEvidenceJob({ documentClient: db as never, s3, tableName: "state", bucketName: "artifacts", github: github.gateway, now: Date.now, log: () => undefined }, event));
      }
      return outcomes;
    },
    /**
     * The Slack service's side of the task-thread mentions parked so far, on its real code: the question check
     * (`handleTaskQuestion`, with `route` as the scripted classifier, absent for none), the broker's task-answer workspace
     * and answered-note routes, and a chat-agent turn with no tools on a scripted model that says `answer`.
     */
    async answerTaskQuestions(answerOptions: { route?: (text: string) => RequestRoute | Promise<RequestRoute>; answer: string | ((question: string) => string) }): Promise<void> {
      const messages = taskQuestions.splice(0, taskQuestions.length);
      const routes = taskQuestionRoutes.splice(0, taskQuestionRoutes.length);
      for (const [index, message] of messages.entries()) {
        const route = routes[index]!;
        const api = createThreadApi({ controlPlaneUrl: CONTROL_PLANE_URL, signedFetch: serviceFetch(message.thread, message.userId) });
        const route_ = answerOptions.route;
        await handleTaskQuestion(message, route, {
          ...(route_ === undefined ? {} : { route: async (text: string) => { routeCalls.push(text); return route_(text); } }),
          answer: (question) => runTaskAnswer(message, route, question, {
            api,
            runTurn: async (input) => {
              const { modelRuntime: answerRuntime, faux: answerFaux } = await fauxModelRuntime();
              let modelInput = "";
              answerFaux.setResponses([(context) => {
                modelInput = JSON.stringify(context.messages);
                return fauxAssistantMessage([fauxText(typeof answerOptions.answer === "string" ? answerOptions.answer : answerOptions.answer(question))]);
              }]);
              const unused = new Proxy({}, { get: () => () => { throw new Error("a task answer turn used a control-plane tool"); } }) as OrchestrationApi;
              const runtime = await createHostedSlackRuntime(input, { stateDirectory: await createFixtureDirectory("agentx-e2e-answer-"), api: unused, model: FAUX_MODEL, modelRuntime: answerRuntime });
              try {
                const reply = await runOrchestratorTurn(runtime, input.message.text);
                taskAnswerTurns.push({ question: input.message.text, modelInput, tools: runtime.session.getActiveToolNames() });
                return reply;
              } finally { await runtime.dispose(); }
            },
          }),
          post: async (target, text) => { slack.post({ channel: target.channelId, threadTs: target.threadTs, text }); },
          postPrivate: async (target, user, text) => { slack.postEphemeral({ channel: target.channelId, threadTs: target.threadTs, user, text }); },
          markAnswered: (input) => api.markThreadNoteAnswered!(input),
          finish: async () => undefined,
          log: (event, fields) => { routeLogs.push({ event, fields }); },
        });
      }
    },
    db, s3, handler, slack, github, repoDirectory, baseCommit, prompts, turns, chatQueue, taskQuestions, taskQuestionRoutes, taskAnswerTurns, checkRuns, invocations, brokerCalls, credentialAttempts, routeCalls, routeLogs,

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

    /**
     * A GitHub webhook delivery for the task's pull request `number`, signed with the App's secret and sent to the broker's
     * real route: a new comment on its conversation, or (merged) the pull request closing merged. Answers the HTTP status.
     */
    async githubWebhook(number: number, event: { comment: GitHubFeedbackComment } | { merged: true }): Promise<number> {
      const built: E2EWebhookEvent = "comment" in event
        ? { kind: event.comment.kind === "REVIEW_COMMENT" ? "pull_request_review_comment" : "issue_comment", action: "created", number, comment: event.comment }
        : { kind: "pull_request", action: "closed", number, merged: true };
      return (await this.webhook(built)).status;
    },

    /**
     * Any GitHub webhook delivery for pull request `event.number`, as GitHub builds it, signed with the webhook secret GitHub
     * holds (or `secret`), with a fresh delivery ID (or `deliveryId`, to redeliver) and its event name (or `eventName`).
     */
    async webhook(event: E2EWebhookEvent, deliveryOptions: { deliveryId?: string; secret?: string; eventName?: string } = {}): Promise<{ status: number; body: Record<string, unknown> }> {
      const pullRequest = github.pullRequests.find((entry) => entry.number === event.number);
      if (pullRequest === undefined) throw new Error(`GitHub has no pull request #${event.number}`);
      const repository = { id: 4242, full_name: "example/demo" };
      const pull = { number: event.number, state: pullRequest.state === "open" ? "open" : "closed", merged: pullRequest.state === "merged", html_url: pullRequest.url,
        head: { ref: pullRequest.headBranch, sha: pullRequest.commit }, base: { ref: pullRequest.baseBranch } };
      const user = (login: string) => ({ login });
      let payload: Record<string, unknown>;
      switch (event.kind) {
        case "issue_comment":
          payload = { action: event.action ?? "created", installation: { id: 77 }, repository,
            issue: { number: event.number, state: pull.state, pull_request: { url: `https://api.github.com/repos/example/demo/pulls/${event.number}` } },
            comment: { id: githubDatabaseId(event.comment.id), body: event.comment.body, html_url: event.comment.url, updated_at: event.comment.updatedAt, user: user(event.comment.author) } };
          break;
        case "pull_request_review_comment":
          payload = { action: event.action ?? "created", installation: { id: 77 }, repository, pull_request: pull,
            comment: { id: githubDatabaseId(event.comment.id), body: event.comment.body, html_url: event.comment.url, updated_at: event.comment.updatedAt,
              ...(event.comment.path === undefined ? {} : { path: event.comment.path }), ...(event.comment.line === undefined ? {} : { line: event.comment.line }), user: user(event.comment.author) } };
          break;
        case "pull_request_review":
          payload = { action: event.action ?? "submitted", installation: { id: 77 }, repository, pull_request: pull,
            review: { id: githubDatabaseId(event.review.id), body: event.body === undefined ? event.review.body : event.body, state: (event.state ?? "commented").toLowerCase(),
              html_url: event.review.url, submitted_at: event.review.updatedAt, user: user(event.review.author) } };
          break;
        case "pull_request":
          payload = { action: event.action, installation: { id: 77 }, repository,
            pull_request: { ...pull, ...(event.action === "closed" ? { state: "closed", merged: event.merged === true } : {}) } };
          break;
      }
      const body = JSON.stringify(payload);
      const secret = deliveryOptions.secret ?? configuredSecret ?? WEBHOOK_SECRET;
      const response = await harness.handler({
        version: "2.0", rawPath: "/v1/github/webhooks", rawQueryString: "", body, isBase64Encoded: false,
        headers: { "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`,
          "x-github-delivery": deliveryOptions.deliveryId ?? randomUUID(), "x-github-event": deliveryOptions.eventName ?? event.kind },
        requestContext: { requestId: randomUUID(), http: { method: "POST" } },
      });
      return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
    },

    /** Runs the broker's scheduled GitHub webhook recovery sweep, as its EventBridge schedule does; answers its status and reply. */
    async runWebhookRecovery(): Promise<{ statusCode: number; body: Record<string, unknown> }> {
      const response = await harness.handler({ source: "agentx.github-webhook-recovery" });
      return { statusCode: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
    },

    /** The App secret's webhook secret changes (GitHub signs with it at once); the broker's cached copy stays until it re-reads. */
    rotateWebhookSecret(next: string): void {
      configuredSecret = next;
    },

    /** Sets the webhook secret on both sides at once (null: the App secret holds none). */
    setWebhookSecret(next: string | null): void {
      configuredSecret = next;
      cachedSecret = next;
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
        view: { callback_id: opened.view.callback_id, private_metadata: opened.view.private_metadata, blocks: opened.view.blocks, state: { values } },
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

    /**
     * The task page, fetched through the broker's real route with a browser sign-in as `reader` (the owner by
     * default), exactly as a browser sends it. Not counted in `brokerCalls`: it is a person's page view, not part of the Slack journey.
     */
    async taskPage(search = "", reader: Developer = MAYA): Promise<{ status: number; body: string }> {
      // A browser review sign-in is its own session record (a UUID, with a review expiry), not the CLI session.
      const browserSession = "b0b0b0b0-0000-4000-8000-000000000001";
      db.set({ pk: `SESSION#${browserSession}`, sk: "META", sessionId: browserSession, developerId: reader.developerId, amr: reader.provider,
        startedAt: new Date().toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800, reviewExpiresAt: Math.floor(Date.now() / 1000) + 604_800 });
      const response = await harness.handler({
        version: "2.0", routeKey: "ANY /review/{proxy+}", rawPath: `/review/${this.taskId()}/task`, rawQueryString: search.replace(/^\?/, ""),
        headers: { cookie: `__Host-agentx_review_session=${browserSession}` },
        requestContext: { requestId: randomUUID(), http: { method: "GET" } },
      });
      return { status: response.statusCode, body: response.body };
    },

    repoFile: (path: string): Promise<string> => readFile(join(repoDirectory, path), "utf8"),

    /** Sends the broker a Slack ingress event directly, as the AWS wiring's invoke does, and answers its status and parsed reply. */
    async brokerEvent(action: string, input: Record<string, unknown>): Promise<{ statusCode: number; body: Record<string, unknown> }> {
      const response = await handler({ source: "agentx.slack-ingress", action, ...input });
      return { statusCode: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
    },
  };
}

export type WorkflowE2E = Awaited<ReturnType<typeof createWorkflowE2E>>;
