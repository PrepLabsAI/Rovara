// The journeys' world (A1): the hosted core on in-memory adapters, a real worker, and a person's browser. Built on the docker-free half of tests/support/core-browser-journey.ts
// (`createCoreBrowserBroker`: the real `createBrokerCoreRoot` over a fake DynamoDB and bucket, two companies, the fake code host, check runner and machines), with the real-core proof
// wrapped around the broker's front. Nothing here writes a workflow, workspace or operation row, calls `acceptStep`, or posts a stage result by hand except the two the real
// worker cannot make on a Mac (the machine's preparation and the host's pull request), which `handPosted` records so a journey's report can list them.
import { execFileSync } from "node:child_process";
import { createHmac, randomUUID, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { WORKER_INVOKE_AUTHORIZATION_SCHEME, workerInvokeToken, workerInvokeTokenPayload, type WorkerInvocation } from "@agentx/contracts";
import { linkGithubAccount } from "../../../packages/broker/src/core/people/github-links.js";
import { executeWorkerCancelInvocation } from "../../../packages/worker/src/cancel-invocation.js";
import { WorkerCancellationController } from "../../../packages/worker/src/cancel.js";
import { createWorkerCallbackSinks } from "../../../packages/worker/src/callback-client.js";
import { OperationJournal } from "../../../packages/worker/src/journal.js";
import { createDefaultPiSessionAdapter } from "../../../packages/worker/src/pi-session.js";
import { runTaskInvocation } from "../../../packages/worker/src/run-task.js";
import { createWorkerServerState, handleWorkerRequest } from "../../../packages/worker/src/server.js";
import { postWorkerTerminalResult } from "../../../packages/worker/src/terminal-callback.js";
import type { FakeWorldOptions } from "../../support/core-host-fakes.js";
import { createCoreBrowserBroker, takeCoreInvocation } from "../../support/core-browser-journey.js";
import { MAYA, OMAR, WEB_CLIENT, clientBearer, type Developer } from "../../support/developer-task-broker.js";
import { FAUX_MODEL, fauxModelRuntime } from "../../support/faux-model.js";
import { call } from "../../support/slack-broker.js";
import { fakeLinear, LINEAR_APP, LINEAR_WEBHOOK_SECRET, testSealer, type FakeLinearUser, type FakeWorkspace } from "../../support/fake-linear-oauth.js";
import { LinearConnections } from "../../../packages/broker/src/aws/linear-connections.js";
import { companyMembershipFromDynamo } from "../../../packages/broker/src/aws/company-check.js";
import { createCoreProof } from "./core-proof.js";

export { MAYA, OMAR };

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8",
  env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" } }).trim();

type Json = Record<string, unknown>;
export interface Reply { status: number; body: Json }

export async function createJourneyWorld(options: { modelGateway?: { url: string; model: string }; world?: FakeWorldOptions; linear?: boolean; page?: boolean; colleague?: { role: "member" | "admin"; grant: "developer" | "administrator" }; workerTimeouts?: { reviewMs?: number } } = {}) {
  const proof = createCoreProof();
  // Linear (journeys 3 and 4): the company's connection over the broker's table, the fake Linear behind the fetch seam, and the webhook route on the broker's front.
  const linearLogs: Array<Record<string, unknown>> = [];
  let fakeLinearServer: ReturnType<typeof fakeLinear> | undefined;
  const linearOption: NonNullable<Parameters<typeof createCoreBrowserBroker>[0]>["linear"] | undefined = options.linear !== true ? undefined : (ports) => {
    const server = fakeLinear(ports.now);
    fakeLinearServer = server;
    const app = async () => ({ ...LINEAR_APP });
    const log = (entry: Record<string, unknown>) => { linearLogs.push(entry); };
    const connections = new LinearConnections({ documentClient: ports.db, tableName: "state", sealer: testSealer(), fetch: server.fetch, now: ports.now, app, log, sleep: async () => undefined });
    return { connections, app, fetch: server.fetch, log };
  };
  // The task page (journey 15): its comment and suggestion API finds a core task through the caller's live company, which the deployed broker has (COMPANY_SIGNIN=enabled gives the developer routes
  // `companies`, broker.ts:15993). The shared fixture gives it only with Linear on, so a page journey asks for it, over the same table.
  const pageTable: { current?: { send(command: unknown, options?: unknown): Promise<unknown> } } = {};
  const lazyPageTable = { send: (command: unknown, sendOptions?: unknown) => pageTable.current!.send(command, sendOptions) };
  const harness = await createCoreBrowserBroker({ wrapCore: (root) => proof.wrap(root), realJobServices: true, ...(options.modelGateway === undefined ? {} : { modelGateway: options.modelGateway }), ...(options.world === undefined ? {} : { world: options.world }), ...(linearOption === undefined ? {} : { linear: linearOption }),
    ...(options.page !== true ? {} : { developerExtra: { companies: companyMembershipFromDynamo(lazyPageTable, "signin"), taskPeopleConfiguration: { peopleChangesEnabled: true } } }) });
  pageTable.current = harness.db;
  const handler = proof.track(harness.handler);
  // The web app's sign-in client is an install-level client (the company routes of Linear's connection and links need it).
  harness.db.set({ ...harness.db.get("SIGNIN_CLIENTS", "CLIENT#web-app")!, pk: "SIGNIN_CLIENTS", sk: "CLIENT#web-app", installLevel: true });
  const cleanups: Array<() => Promise<void>> = [];
  const handPosted: string[] = [];

  /** A person at the web app: the same request the browser makes, signed in with the web client's token. */
  const as = (who: Developer) => async (method: string, path: string, body?: unknown): Promise<Reply> => {
    const response = await handler({ version: "2.0", rawPath: path.split("?")[0], rawQueryString: path.split("?")[1] ?? "",
      headers: { authorization: await clientBearer(who, WEB_CLIENT, `${WEB_CLIENT.clientId}-${who.sessionId}`) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), requestContext: { requestId: randomUUID(), http: { method } } });
    return { status: response.statusCode, body: JSON.parse(response.body) as Json };
  };
  const maya = as(MAYA);
  // A colleague: a second member of the owner's company, with the project grant but not the task's owner. (The core's fixtures have one person per company; this is the second.)
  const PRIYA: Developer = { developerId: "9".repeat(64), name: "Priya Rao", provider: "slack", sessionId: "s-priya", slackUserId: "U0PRIYA001" };
  harness.db.set({ pk: `SESSION#${PRIYA.sessionId}`, sk: "META", sessionId: PRIYA.sessionId, developerId: PRIYA.developerId, amr: PRIYA.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
  harness.db.set({ pk: `SESSION#${WEB_CLIENT.clientId}-${PRIYA.sessionId}`, sk: "META", sessionId: `${WEB_CLIENT.clientId}-${PRIYA.sessionId}`, developerId: PRIYA.developerId, amr: PRIYA.provider, clientId: WEB_CLIENT.clientId, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
  harness.db.set({ pk: `DEVELOPER#${PRIYA.developerId}`, sk: "META", entityType: "DEVELOPER", developerId: PRIYA.developerId, provider: PRIYA.provider, displayName: PRIYA.name, slackUserId: PRIYA.slackUserId, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
  harness.db.set({ pk: `COMPANY_MEMBER#${PRIYA.developerId}`, sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", personId: PRIYA.developerId, companyId: harness.runtime.flow.deps.companyId, role: options.colleague?.role ?? "member", joinedAt: "2026-11-01T00:00:00.000Z" });
  harness.db.set({ pk: `ORG#${harness.runtime.flow.deps.companyId}#MEMBER#${PRIYA.developerId}`, sk: "PROJECT#payments", entityType: "MEMBERSHIP", ownerKey: PRIYA.developerId, projectName: "payments", grantId: randomUUID(), role: options.colleague?.grant ?? "developer", companyId: harness.runtime.flow.deps.companyId });
  const priya = as(PRIYA);
  const omarAsk = as(OMAR);
  /** Another company's member: every request is a probe that must be refused (see CoreProof.probe). */
  const omar = (method: string, path: string, body?: unknown): Promise<Reply> => proof.probe(() => omarAsk(method, path, body));

  // The repository the worker works in: one commit, the origin the fake code host knows.
  const root = await mkdtemp(join(tmpdir(), "journey-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const workerWorkspace = join(root, "worker-workspace");
  const repository = join(workerWorkspace, "repo", "demo");
  await mkdir(repository, { recursive: true });
  git(repository, "init", "--quiet", "--initial-branch=main");
  await writeFile(join(repository, "package.json"), JSON.stringify({ name: "demo", version: "1.0.0" }));
  git(repository, "add", "-A");
  git(repository, "commit", "--quiet", "-m", "the project as the task starts");
  git(repository, "remote", "add", "origin", "https://github.com/example/demo.git");
  const baseCommit = git(repository, "rev-parse", "HEAD");
  const baseTree = git(repository, "rev-parse", "HEAD^{tree}");
  // Collecting a candidate confirms its starting commit with the code host. The fake host knows no commit of this real local repository, so it answers the base commit with its tree
  // (what the real host does) and refuses every other commit as before.
  const hostTree = harness.world.host.tree.bind(harness.world.host);
  harness.world.host.tree = async (repository, revision, scope) => revision === baseCommit ? baseTree : hostTree(repository, revision, scope);

  // The worker: the real task runner behind the real server and journal, every callback through the broker's front (the real routes), only the model scripted.
  const workerKeys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const journal = new OperationJournal(join(root, "worker-journal"));
  const { modelRuntime, faux } = await fauxModelRuntime();
  const tampered = { count: 0 };
  let resultTransform: ((body: Json) => Json) | undefined;
  const workerFetch: typeof fetch = async (url, init) => {
    const parsed = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
    let body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
    // A newer or odd worker: a journey can change the body of the worker's own terminal result on its way to the real route.
    if (resultTransform !== undefined && body !== undefined && init?.method === "POST" && /\/result$/u.test(parsed.pathname)) { const changed = resultTransform(body as Json); if (changed !== body) tampered.count += 1; body = changed; }
    const response = await call(handler, { method: init?.method ?? "GET", path: parsed.pathname, headers: Object.fromEntries(new Headers(init?.headers).entries()), ...(body === undefined ? {} : { body }) });
    if (response.status >= 400) throw new Error(`worker callback ${parsed.pathname} HTTP ${response.status}: ${JSON.stringify(response.body)}`);
    return new Response(JSON.stringify(response.body), { status: response.status, headers: { "content-type": "application/json" } });
  };
  let workspaceId = "";
  const sinksFor = (invocation: WorkerInvocation) => createWorkerCallbackSinks({ controlPlaneUrl: "https://cp.example.test", invocation, fetchImplementation: workerFetch });
  const cancellationController = new WorkerCancellationController();
  let workerStateOnce: ReturnType<typeof createWorkerServerState> | undefined;
  const workerState = () => workerStateOnce ??= createWorkerServerState(journal, {
    execute: async (invocation) => {
      // As the worker's main.ts does: a cancel invocation goes to the cancellation controller, and a running step registers with it.
      if (invocation.kind === "cancel") return executeWorkerCancelInvocation(invocation, cancellationController, journal);
      const sinks = sinksFor(invocation);
      return runTaskInvocation(invocation, { rootPath: workerWorkspace, model: FAUX_MODEL, piAdapter: createDefaultPiSessionAdapter({ modelRuntime: async () => ({ runtime: modelRuntime, model: FAUX_MODEL }) }),
        ...sinks, log: () => undefined, cancellationController, ...(options.workerTimeouts === undefined ? {} : { timeouts: options.workerTimeouts }) });
    },
  }, { onTerminal: async (result, invocation) => postWorkerTerminalResult(sinksFor(invocation), result, invocation, () => undefined), retrySleep: async () => undefined },
  { publicKey: workerKeys.publicKey, workspaceId, generation: 1 });

  // A cancel the core sends to the machine reaches the worker's own server, as it does on a real machine (the worker answers it and posts the step's result through the real route).
  const deliver = harness.world.machines.deliver.bind(harness.world.machines);
  harness.world.machines.deliver = async (machineId, invocation) => {
    const receipt = await deliver(machineId, invocation);
    if (invocation.kind === "cancel") {
      const payload = workerInvokeTokenPayload({ workspaceId, generation: 1, operationId: invocation.operationId, fence: invocation.fence, expiresAt: Math.floor(Date.now() / 1000) + 3600, purpose: "WORKSPACE" });
      const authorization = `${WORKER_INVOKE_AUTHORIZATION_SCHEME} ${workerInvokeToken(payload, cryptoSign("sha256", Buffer.from(payload, "ascii"), workerKeys.privateKey))}`;
      const response = await handleWorkerRequest(new Request("http://worker/invocations", { method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify(invocation) }), workerState());
      expect(response.status).toBeLessThan(300);
    }
    return receipt;
  };

  const taskRow = (taskId: string) => harness.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string; workflow?: { stage: string; state: string; blockReason?: string } } | undefined;

  /** The hosted machine reports the workspace ready: the one result a Mac's fake machine cannot produce, posted the way the real worker's preparation does. */
  async function prepare(taskId: string): Promise<void> {
    workspaceId = String(taskRow(taskId)!.workspaceId);
    const preparation = await takeCoreInvocation(harness, workspaceId, "prepare");
    handPosted.push("prepare result");
    const response = await call(handler, { method: "POST", path: `/v1/internal/workspaces/${workspaceId}/operations/${preparation.invocation.operationId}/result`,
      headers: { "x-agentx-callback-capability": preparation.invocation.callbackCapability }, body: { operationId: preparation.invocation.operationId, status: "SUCCEEDED", result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: baseCommit }] } } });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    harness.world.machines.finish(preparation.machineId, preparation.invocation.operationId);
    await mkdir(join(workerWorkspace, ".agentx"), { recursive: true, mode: 0o700 });
    await writeFile(join(workerWorkspace, ".agentx", "preparation-manifest.json"), `${JSON.stringify({ schemaVersion: 2, projectName: "payments", projectRevision: 1,
      repositories: [{ name: "demo", path: "repo/demo", defaultBranch: "main", resolvedCommit: baseCommit, resolvedAt: new Date().toISOString(), completedAt: new Date().toISOString() }],
      completedSetupSteps: [], readinessResults: [], creationIdentity: `fixture-${taskId}`, complete: true, updatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  }

  /** The core's next step of this mode runs on the real worker, scripted by `responses`; returns once the core has the operation's terminal result. */
  /** The operations this journey has already taken: a stage that runs again (a send-back, a feedback fix) is a new operation, never one already run. */
  const consumed = new Set<string>();
  async function startStep(mode: string, responses: Parameters<typeof faux.setResponses>[0], after?: string) {
    faux.setResponses(responses);
    if (after !== undefined) consumed.add(after);
    const next = await takeCoreInvocation(harness, workspaceId, mode, consumed);
    consumed.add(next.invocation.operationId);
    const { invocation } = next;
    const payload = workerInvokeTokenPayload({ workspaceId, generation: 1, operationId: invocation.operationId, fence: invocation.fence, expiresAt: Math.floor(Date.now() / 1000) + 3600, purpose: "WORKSPACE" });
    const authorization = `${WORKER_INVOKE_AUTHORIZATION_SCHEME} ${workerInvokeToken(payload, cryptoSign("sha256", Buffer.from(payload, "ascii"), workerKeys.privateKey))}`;
    const response = await handleWorkerRequest(new Request("http://worker/invocations", { method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify(invocation) }), workerState());
    expect(response.status, `worker refused ${mode}: ${await response.clone().text()}`).toBe(200);
    return next;
  }
  /** Waits for the core to hold the operation's terminal result. */
  async function stepEnd(mode: string, next: { invocation: WorkerInvocation; machineId: string }) {
    const { invocation } = next;
    for (let attempt = 0; attempt < 6000; attempt += 1) {
      const operation = harness.db.find((row) => row.entityType === "OPERATION" && row.id === invocation.operationId)[0];
      if (["SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"].includes(String(operation?.status))) {
        harness.world.machines.finish(next.machineId, invocation.operationId);
        return { invocation, operation: operation as Json };
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const journalFiles = await readdir(join(root, "worker-journal")).catch(() => [] as string[]);
    throw new Error(`the ${mode} worker did not post a terminal result (journal: ${journalFiles.join(",") || "none"})`);
  }
  async function runStep(mode: string, responses: Parameters<typeof faux.setResponses>[0], after?: string) {
    return stepEnd(mode, await startStep(mode, responses, after));
  }

  /** The owner approves the plan on the web: the decision card the web app lists, its digest, the approve press (the real decision routes, no row written). */
  async function approvePlan(taskId: string): Promise<void> {
    const read = async () => {
      const listed = await maya("GET", "/v1/app/decisions");
      expect(listed.status, JSON.stringify(listed.body)).toBe(200);
      return listed;
    };
    // The card is built from the session the sweep job keeps; a deployment's schedule runs it every minute.
    let listed = await read();
    if (!(listed.body.cards as Array<{ taskId?: string }>).some((item) => item.taskId === taskId)) { await runJobs(); listed = await read(); }
    const cards = listed.body.cards as Array<{ id: string; taskId?: string; risk: string }>;
    const card = cards.find((item) => item.taskId === taskId);
    expect(card, "the plan is waiting for the owner as a decision card").toBeDefined();
    const shownDigest = (listed.body.digests as Record<string, string>)[card!.id];
    const path = card!.id.replace(":", "/");
    if (card!.risk === "medium") expect((await maya("POST", `/v1/app/decisions/${path}/evidence-opened`, { shownDigest, requestId: randomUUID() })).status).toBe(200);
    const approved = await maya("POST", `/v1/app/decisions/${path}/approve`, { shownDigest, requestId: randomUUID() });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  }

  /**
   * The draft pull request: the core issues its publish invocation; the code host is an external system, so its side (the branches and commits the worker would have pushed) is set on the fake host,
   * and the pull request callbacks the publishing worker makes are posted to the real routes with the invocation's own capability. Nothing about approval, admission or workflow rows is written.
   */
  async function publish() {
    const { invocation, machineId } = await takeCoreInvocation(harness, workspaceId, "publish", consumed);
    consumed.add(invocation.operationId);
    if (invocation.kind !== "publish") throw new Error("the core did not issue its publication invocation");
    handPosted.push("pull-request and result callbacks of the publish worker");
    const operation = harness.db.find((row) => row.entityType === "OPERATION" && row.id === invocation.operationId)[0]!;
    const expected = operation.publication as { repository: string; repositoryUrl: string; headBranch: string; baseBranch: string; title: string; body: string; expectedTreeSha: string; expectedCommitSha?: string };
    const commit = git(repository, "rev-parse", "HEAD");
    const tree = git(repository, "rev-parse", "HEAD^{tree}");
    expect(expected.expectedTreeSha).toBe(tree);
    if (expected.expectedCommitSha !== undefined) expect(expected.expectedCommitSha).toBe(commit);
    const model = harness.world.host.model;
    for (const sha of [baseCommit, commit]) {
      const paths = git(repository, "ls-tree", "-r", "--name-only", sha).split("\n").filter(Boolean);
      const files = new Map(paths.map((path) => [path, git(repository, "show", `${sha}:${path}`)]));
      model.revisions.set(sha, { sha, tree: git(repository, "rev-parse", `${sha}^{tree}`), parents: sha === baseCommit ? [] : [baseCommit], files, entries: new Map(paths.map((path) => [path, "file" as const])), symlinks: new Set() });
    }
    model.branches.set(expected.baseBranch, baseCommit);
    model.branches.set(expected.headBranch, commit);
    const post = (action: string, body: unknown) => call(handler, { method: "POST", path: `/v1/internal/workspaces/${workspaceId}/operations/${invocation.operationId}/${action}`, headers: { "x-agentx-callback-capability": invocation.callbackCapability }, body });
    const opened = await post("pull-request", { repository: expected.repository, repositoryUrl: expected.repositoryUrl, headBranch: expected.headBranch, baseBranch: expected.baseBranch, title: expected.title, body: expected.body, commit });
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    const result = await post("result", { operationId: invocation.operationId, status: "SUCCEEDED", result: { repository: expected.repository, number: opened.body.number, url: opened.body.url, headBranch: expected.headBranch, baseBranch: expected.baseBranch, checks: [], reconciled: opened.body.reconciled, draft: opened.body.draft, commit } });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    harness.world.machines.finish(machineId, invocation.operationId);
    return { number: opened.body.number as number, url: String(opened.body.url), commit, draft: model.changeRequests.at(-1)! };
  }

  /** One run of a deployment's scheduled jobs for the company, as the schedules would run them (merge tracking reads the code host, the session sweep, notice delivery). */
  async function runJobs(advanceSeconds = 0, budgetMs = 5_000): Promise<Record<string, unknown>> {
    harness.world.clock.advance(advanceSeconds);
    const runtime = await harness.core.app.runtimeFor(harness.runtime.flow.deps.companyId);
    const reports: Record<string, unknown> = {};
    for (const name of ["session-sweep", "merge-tracking", "notify-deliver"] as const) reports[name] = await runtime.services[name]?.pass({ budgetMs });
    return reports;
  }

  /** The project's saved merge rules (the record the developer API's settings route writes; the route needs a project administrator, which this fixture's people are not). */
  function saveMergeRules(project: string, settings: { allowSelfApproval: boolean }): void {
    const companyId = harness.runtime.flow.deps.companyId;
    harness.db.set({ pk: `CODE_SETTINGS#${companyId}#${project}`, sk: "CODE_SETTINGS", entityType: "CODE_SETTINGS", companyId, project, settings: { allowSelfApproval: settings.allowSelfApproval, mergeMethod: "squash", codeReviewers: [], revision: 1 } });
  }

  /** What "Connect your GitHub" stores for a signed-in person: their own person id linked to their own account, by the production function the connect route calls. */
  async function linkGithubAsConnected(who: Developer, login: string): Promise<ReturnType<typeof harness.world.host.model.setAccount>> {
    const account = harness.world.host.model.setAccount(login, "write");
    const outcome = await linkGithubAccount(harness.runtime.flow.deps.store, { companyId: harness.runtime.flow.deps.companyId, githubUserId: account.hostUserId, login, personId: who.developerId, linkedAt: new Date(harness.world.clock.now).toISOString() });
    expect(outcome).toBe("linked");
    return account;
  }

  /**
   * The colleague (Priya, a current member of the owner's company) links her own code-host account the way Connect GitHub does, and returns that account. Since 27d (f0fd5280d, core/merge/approval.ts
   * `countedApprovals`) an approval counts only from an account linked to a CURRENT member, in both modes, so a reviewer the journeys want counted must be linked first.
   */
  async function linkColleagueGithub(login: string): Promise<ReturnType<typeof harness.world.host.model.setAccount>> {
    const account = harness.world.host.model.setAccount(login, "write");
    const outcome = await linkGithubAccount(harness.runtime.flow.deps.store, { companyId: harness.runtime.flow.deps.companyId, githubUserId: account.hostUserId, login, personId: PRIYA.developerId, linkedAt: new Date(harness.world.clock.now).toISOString() });
    expect(outcome).toBe("linked");
    return account;
  }

  /** The core issues the next step of this mode to the machine, and nobody runs it: a step that is running when a person acts. */
  async function dispatchOnly(mode: string) {
    const next = await takeCoreInvocation(harness, workspaceId, mode, consumed);
    consumed.add(next.invocation.operationId);
    return next;
  }

  /** The dispatcher a deployment runs on its own while a request waits for a worker (a Stop asks the worker to flush and waits for it): drains the core's outbox and dispatch rows until stopped. */
  function pumpDispatcher(): () => void {
    let live = true;
    void (async () => {
      while (live) {
        await harness.runtime.flow.relayOnce();
        await harness.runtime.flow.dispatchOnce({ waitSeconds: 0 });
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    })();
    return () => { live = false; };
  }

  /**
   * The core's table refuses every write that `match` accepts (DynamoDB throttling) until the returned function is called: the way a journey makes a step fail to START without touching any row. `match` reads the
   * request as the wire sends it (attribute values typed, so a document's mode is `"workflowMode":{"S":"REVIEW"}`).
   */
  function refuseWrites(match: (request: string) => boolean): () => void {
    const wire = harness.storeWire;
    const send = wire.send.bind(wire) as (command: { input?: unknown }, options?: unknown) => Promise<unknown>;
    let refusing = true;
    (wire as { send: unknown }).send = async (command: { constructor: { name: string }; input?: unknown }, options?: unknown) => {
      if (refusing && command.constructor.name === "TransactWriteItemsCommand" && match(JSON.stringify(command.input))) {
        throw Object.assign(new Error("Rate exceeded"), { name: "ProvisionedThroughputExceededException" });
      }
      return send(command, options);
    };
    return () => { refusing = false; };
  }

  /** A callback to the worker routes with a capability the caller names (the worker's own, or a wrong one): the real route and the real authorisation. */
  function postWorkerCallback(workspace: string, operationId: string, action: string, capability: string, body: unknown): Promise<Reply> {
    return call(handler, { method: "POST", path: `/v1/internal/workspaces/${workspace}/operations/${operationId}/${action}`, headers: { "x-agentx-callback-capability": capability }, body });
  }

  /** Linear, as a person and Linear's own servers see it (journeys 3 and 4). Only with `linear: true`. */
  const linear = fakeLinearServer === undefined ? undefined : (() => {
    const server = fakeLinearServer;
    const nowMs = () => harness.world.clock.now;
    let sequence = 0;
    return {
      server, logs: linearLogs,
      /** A company admin connects the company to a Linear workspace through the real connect routes (Linear's own consent, faked). */
      async connect(admin: ReturnType<typeof as>, workspace: FakeWorkspace) {
        const started = await admin("POST", "/v1/dev/company/linear/connect", {});
        expect(started.status, JSON.stringify(started.body)).toBe(200);
        const completed = await admin("POST", "/v1/dev/company/linear/complete", { state: started.body.state, code: server.approve(String(started.body.authorizeUrl), workspace) });
        expect(completed.status, JSON.stringify(completed.body)).toBe(200);
      },
      /** The project's Linear team, picked through the real route. */
      async pickTeam(admin: ReturnType<typeof as>, project: string, teamId: string) {
        const picked = await admin("PUT", `/v1/dev/company/linear/projects/${project}`, { teamId });
        expect(picked.status, JSON.stringify(picked.body)).toBe(200);
      },
      /** A member links the Linear account that is theirs through the real routes: start, Linear's own sign-in as `user`, claim. */
      async link(person: ReturnType<typeof as>, workspace: FakeWorkspace, user: FakeLinearUser) {
        const started = await person("POST", "/v1/dev/me/tracker-accounts/linear/link", {});
        if (started.status !== 200) return started;
        return person("POST", "/v1/dev/me/tracker-accounts/linear/link/claim", { state: started.body.state, code: server.approve(String(started.body.authorizeUrl), workspace, user) });
      },
      /** An issue exists in Linear, and Linear's webhook for it reaches the broker's front, signed as Linear signs it. */
      async issueCreated(workspace: FakeWorkspace, input: { teamId: string; actor: string | undefined; key: string; labels?: string[] }) {
        sequence += 1;
        const issue = { id: `issue-${workspace.urlKey}-${input.key}-${String(sequence)}`, identifier: input.key, title: `Fix the login (${input.key})` };
        // The issue as Linear has it now (R1 + L1 6.2b): the doorbell reads the issue by id from Linear, never from the delivery, so Linear's own history names who added each label, and when.
        const labels = input.labels ?? ["rovara"];
        const history = labels.map((name, index) => ({ id: `history-${issue.id}-${String(index)}`, createdAt: new Date(nowMs()).toISOString(), ...(input.actor === undefined ? {} : { actorId: input.actor }), addedLabelIds: [`lbl-${name}`] }));
        server.addIssue(workspace, { ...issue, teamId: input.teamId, labels, history });
        const raw = JSON.stringify({ type: "Issue", action: "create", organizationId: workspace.id, webhookTimestamp: nowMs(), ...(input.actor === undefined ? {} : { actor: { id: input.actor } }),
          data: { id: issue.id, identifier: input.key, teamId: input.teamId, url: `https://linear.app/${workspace.urlKey}/issue/${input.key}/x`, labels: (input.labels ?? ["rovara"]).map((name) => ({ name })) } });
        const signature = createHmac("sha256", LINEAR_WEBHOOK_SECRET).update(Buffer.from(raw, "utf8")).digest("hex");
        const response = await handler({ version: "2.0", rawPath: "/v1/linear/webhooks", rawQueryString: "", headers: { "linear-signature": signature, "content-type": "application/json" }, body: raw, requestContext: { requestId: randomUUID(), http: { method: "POST" } } });
        return { status: response.statusCode, issueId: issue.id };
      },
    };
  })();

  return {
    harness, proof, linear, handler, as, maya, priya, omar, omarAsk, root, repository, baseCommit, faux, handPosted, taskRow,
    prepare, runStep, startStep, stepEnd, approvePlan, publish, postWorkerCallback, refuseWrites, dispatchOnly, pumpDispatcher, tampered, tamperWithResults: (transform: ((body: Json) => Json) | undefined) => { resultTransform = transform; }, runJobs, linkGithubAsConnected, linkColleagueGithub, saveMergeRules,
    async close() { for (const step of cleanups.splice(0).reverse()) await step(); },
  };
}
export type JourneyWorld = Awaited<ReturnType<typeof createJourneyWorld>>;
