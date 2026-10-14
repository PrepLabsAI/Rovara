import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID, sign as cryptoSign } from "node:crypto";
import { homedir, release as osRelease } from "node:os";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { GitHubRepositoryApi } from "../../packages/cli/src/setup/project-files.js";
import { addProject, ec2Binding } from "../../packages/cli/src/setup/project-add.js";
import { fakeControlPlane, FOUNDATION_OUTPUTS } from "../support/setup-fakes.js";
import { scriptedPrompter } from "../support/init-fakes.js";
import {
  canonicalJson, canonicalPlanJson, createCandidateManifest, WorkerInvocationSchema, parsePlanDocument, readCanonicalPlan,
  planDocumentMarkdown, portableOperationId, WorkflowSnapshotSchema, workflowSendBackOffered, sendBackProblems,
  ProjectDefinitionSchema, workerInvokeToken, workerInvokeTokenPayload, type WorkerInvokeTokenClaims,
  type DeveloperTaskView, type E2EPolicy, type E2ESourceSnapshot,
} from "@agentx/contracts";
import { executeCli } from "../../packages/cli/src/main.js";
import { developerTokenKey, saveDeveloperEnvironment } from "../../packages/cli/src/developer/config.js";
import { realExec, type Exec } from "../../packages/cli/src/loop/exec.js";
import { captureCandidate } from "../../packages/cli/src/loop/candidate.js";
import { recordRegisteredLoopEnrollment } from "../../packages/cli/src/loop/enrollment-cli.js";
import { LoopStore } from "../../packages/cli/src/loop/state.js";
import { InMemoryTokenStore } from "../../packages/cli/src/token-store.js";
import { createAgentXMcpServer } from "../../packages/mcp/src/index.js";
import { StrictSlackWeb } from "../support/strict-slack.js";
import { call, createBroker, issuer, loadSlackBroker } from "../support/slack-broker.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import { beforeAll, vi } from "vitest";
import { GitHubAppCredentialProvider } from "../../packages/broker/src/github-app.js";
import { createDispatcherHandler } from "../../packages/broker/src/aws/dispatcher.js";
import { createEc2Delivery } from "../../packages/broker/src/aws/ec2-delivery.js";
import { createOutboxPublisherHandler } from "../../packages/broker/src/aws/outbox-publisher.js";
import { createProjectSetupBindingReader, createProjectSetupDispatchGuard, createProjectSetupDispatchLifecycle } from "../../packages/broker/src/aws/dispatcher.js";
import { guardTaskDispatch } from "../../packages/broker/src/aws/task-dispatch-access.js";
import { createTaskAuthorityAdmission } from "../../packages/broker/src/aws/task-authority-admission.js";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ProjectSetupSessionManager } from "../../packages/broker/src/aws/sessions.js";
import { issueProjectSetupCapability } from "../../packages/broker/src/aws/project-setup-capability.js";

import { OperationJournal } from "../../packages/worker/src/journal.js";
import { WorkerCancellationController } from "../../packages/worker/src/cancel.js";
import { executeWorkerCancelInvocation } from "../../packages/worker/src/cancel-invocation.js";
import { createWorkerServerState, handleWorkerRequest } from "../../packages/worker/src/server.js";
import { createWorkerCallbackSinks } from "../../packages/worker/src/callback-client.js";
import { createDefaultPiSessionAdapter } from "../../packages/worker/src/pi-session.js";
import { runTaskInvocation } from "../../packages/worker/src/run-task.js";
import { postWorkerTerminalResult } from "../../packages/worker/src/terminal-callback.js";
import { createDefaultProjectSetupExecutor } from "../../packages/worker/src/project-setup-executor.js";
import { postProjectSetupTerminalResult } from "../../packages/worker/src/project-setup-callback.js";
import { publishWorkspace } from "../../packages/worker/src/publish.js";
import { createRepositoryCredentialProvider } from "../../packages/worker/src/repository-credentials.js";
import { marshall } from "@aws-sdk/util-dynamodb";
import { inspectE2ERepository } from "../../packages/broker/src/e2e/discovery.js";
import { deriveProjectSetupSourceSmoke } from "../../packages/broker/src/e2e/project-setup-source-smoke.js";
import { deriveE2EFeaturePortableApprovalBinding } from "../../packages/broker/src/e2e/feature-plan-intent.js";
import { e2eFeatureVerifierKey, E2E_FEATURE_PROCESS_RESPONSE_SCOPE } from "../../packages/broker/src/aws/e2e-feature-verifier-catalog.js";
import { admitProjectSetupRuntime, projectSetupBindingDigest, projectSetupRuntimeKey, ProjectSetupRuntimeRecordSchema } from "../../packages/broker/src/aws/project-setup-runtime-catalog.js";
import { readWorkflowE2ENotifierProjection } from "../../packages/broker/src/aws/workflow-e2e-notifier-projection.js";
import { renderE2ESlackBlocks } from "../../packages/broker/src/e2e-presentation.js";
import { selectE2EExecutionPlan } from "../../packages/broker/src/e2e/execution-plan.js";
import { taskGraphDigest } from "../../packages/contracts/src/workflow-dependencies.js";
import { persistOriginalEvidencePrimary, persistOriginalMapPrimary } from "../support/p0-evidence-capture.js";
import { FAUX_MODEL, fauxModelRuntime } from "../support/faux-model.js";

beforeAll(async () => { await loadSlackBroker(); });
afterEach(() => vi.unstubAllGlobals());

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const gitBytes = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args]);
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
async function mcpGetTask(task: DeveloperTaskView, taskId: string) {
  const server = createAgentXMcpServer({ version: "0.4.0", context: (clientName) => ({
    client: { getTask: async () => task } as never, clientName, serverVersion: "0.4.0", adminSignedIn: async () => false,
    compatibility: async () => ({ env: "local", apiVersion: "1.2" }), now: () => Date.now(),
    sleep: async (ms, signal) => new Promise<void>((resolveSleep, rejectSleep) => {
      const timer = setTimeout(resolveSleep, ms);
      signal.addEventListener("abort", () => { clearTimeout(timer); rejectSleep(signal.reason instanceof Error ? signal.reason : new Error("MCP request aborted")); }, { once: true });
    }), newRequestId: () => randomUUID(),
  }) });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new McpClient({ name: "p0-native-journey", version: "1.0.0" });
  await client.connect(clientTransport);
  try { return await client.callTool({ name: "agentx_get_task", arguments: { task_id: taskId } }); }
  finally { await client.close(); await server.close(); }
}
const gitBlob = (cwd: string, revision: string, path: string): Buffer | undefined => {
  try { execFileSync("git", ["-C", cwd, "cat-file", "-e", `${revision}:${path}`], { stdio: "ignore" }); }
  catch { return undefined; }
  return gitBytes(cwd, "show", `${revision}:${path}`);
};

describe("P0 normal project onboarding journey", () => {
  it("discovers and presents source-backed setup from ordinary addProject without injected setup authority", async () => {
    const evidenceRoot = process.env.CONTAINED_FOUNDATION_EVIDENCE_DIR;
    expect(evidenceRoot, "CONTAINED_FOUNDATION_EVIDENCE_DIR must be pre-created outside the fresh TMPDIR").toBeDefined();
    const evidenceRootPath = resolve(evidenceRoot!);
    const evidenceRootStat = await lstat(evidenceRootPath);
    expect(evidenceRootStat.isDirectory() && !evidenceRootStat.isSymbolicLink(), "the launch-provided evidence root must be an owned real directory").toBe(true);
    expect(evidenceRootStat.uid).toBe(process.getuid?.());
    expect(evidenceRootStat.mode & 0o077).toBe(0);
    expect(await realpath(evidenceRootPath)).toBe(evidenceRootPath);
    expect(basename(dirname(evidenceRootPath))).toBe("AgentX-e2e-p0-20261012-evidence");
    expect(dirname(dirname(evidenceRootPath)), "the evidence collection must be a sibling of this source checkout").toBe(dirname(resolve(process.cwd())));
    expect(await readdir(evidenceRootPath), "evidence root must be fresh and empty before the journey begins").toEqual([]);
    const root = resolve(evidenceRoot!, "native-journey", `5a-normal-discovery-${randomUUID()}`);
    await mkdir(dirname(root), { recursive: true, mode: 0o700 });
    await mkdir(root, { recursive: false, mode: 0o700 });
    await writeFile(join(root, "actual-journey-evidence-root.json"), `${JSON.stringify({ path: root,
      evidenceRoot: evidenceRootPath, sourceCheckout: resolve(process.cwd()), parent: dirname(dirname(evidenceRootPath)),
      ownerUid: evidenceRootStat.uid, mode: evidenceRootStat.mode & 0o777, createdBeforeCandidateOrModelExecution: true }, null, 2)}\n`,
    { mode: 0o600, flag: "wx" });
    const repositoryRoot = join(root, "selected-repository");
    const projectConfig = join(root, "project-config");
    await mkdir(join(repositoryRoot, "src"), { recursive: true });
    await mkdir(join(repositoryRoot, "admin", "src"), { recursive: true });
    await mkdir(join(repositoryRoot, "api"), { recursive: true });
    await mkdir(join(repositoryRoot, "api", "fixtures"), { recursive: true });
    await mkdir(join(repositoryRoot, "android", "app"), { recursive: true });
    await mkdir(join(repositoryRoot, "ios"), { recursive: true });
    await mkdir(join(repositoryRoot, "desktop"), { recursive: true });
    await mkdir(join(repositoryRoot, ".rovara"), { recursive: true });
    await mkdir(projectConfig, { recursive: true, mode: 0o700 });
    const sourceApiFixture = {
      schemaVersion: "source-backed-api-fixtures/v1", operationId: "listOrders", method: "GET", path: "/orders", inputField: "mode",
      variants: [
        { id: "success", inputValue: "success", status: 200, body: { orders: [{ name: "Sample order" }] } },
        { id: "refusal", inputValue: "refusal", status: 403, body: { error: "refused" } },
        { id: "invalid-data", inputValue: "invalid-data", status: 200, body: { orders: "not-an-array" } },
      ],
    };
    const sourceApiSchema = {
      openapi: "3.1.0", info: { title: "Orders", version: "1" }, paths: { "/orders": { get: {
        operationId: "listOrders", parameters: [{ name: "mode", in: "query", required: true, schema: { type: "string", enum: ["success", "refusal", "invalid-data"] } }],
        responses: {
          "200": { description: "orders", content: { "application/json": { schema: { type: "object", properties: {
            orders: { type: "array", items: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false } },
          }, required: ["orders"], additionalProperties: false } } } },
          "403": { description: "refused", content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" } }, required: ["error"], additionalProperties: false } } } },
        },
      } } },
    };
    const sourceFiles = {
      ".gitignore": ".agentx/\nagent-sessions/\n",
      ".rovara/loop.yaml": "version: 1\ncollaborators:\n  - maya\nharness:\n  name: codex\n  args: []\nchecks:\n  - name: orders regression\n    run: npm test\nreviews:\n  enabled: true\n  harness: codex\n  security: true\n  maxRounds: 3\n  timeoutSeconds: 900\n",
      "package.json": JSON.stringify({ name: "ordinary-orders", type: "module", exports: { ".": "./src/index.mjs" }, scripts: { build: "node --check src/index.mjs", test: "node --test" } }, null, 2) + "\n",
      "package-lock.json": JSON.stringify({ name: "ordinary-orders", lockfileVersion: 3, packages: { "": { name: "ordinary-orders" } } }, null, 2) + "\n",
      "openapi.json": JSON.stringify(sourceApiSchema, null, 2) + "\n",
      "api/fixtures/orders-mocks.json": JSON.stringify(sourceApiFixture, null, 2) + "\n",
      "src/index.mjs": "import { applyPrice } from './price-rows.mjs';\nexport function priceRows(input) { return { rows: input.rows.map(applyPrice) }; }\n",
      "src/price-rows.mjs": "export const applyPrice = (row) => ({ ...row, price: 7 });\n",
      "admin/package.json": JSON.stringify({ name: "orders-admin", type: "module", exports: { ".": "./src/index.mjs" } }, null, 2) + "\n",
      "admin/src/index.mjs": "export function listAdminOrders() { return []; }\n",
      "api/package.json": JSON.stringify({ name: "ordinary-orders-api", type: "module", dependencies: { fastify: "^5.0.0" }, exports: { ".": "./index.mjs" } }, null, 2) + "\n",
      "api/index.mjs": "export function listOrders() { return []; }\n",
      "api/openapi.json": JSON.stringify({ openapi: "3.1.0", info: { title: "Orders", version: "1" }, paths: { "/orders": { get: { operationId: "listOrders", responses: { "200": { description: "rows" } } } } } }, null, 2) + "\n",
      "api/fixtures/orders.json": JSON.stringify({ scope: "SYNTHETIC", orders: [{ id: "o-1", price: 7 }] }, null, 2) + "\n",
      "android/app/build.gradle": "plugins { id 'com.android.application' }\n",
      "ios/Orders.swift": "struct Orders { let id: String }\n",
      "desktop/package.json": JSON.stringify({ name: "orders-desktop", type: "module", dependencies: { electron: "^42.0.0" }, main: "./main.mjs", exports: { ".": "./main.mjs" } }, null, 2) + "\n",
      "desktop/main.mjs": "export function createWindow() { return { kind: 'desktop-source-smoke' }; }\n",
    };
    for (const [path, content] of Object.entries(sourceFiles)) await writeFile(join(repositoryRoot, path), content, { mode: 0o600 });
    git(repositoryRoot, "init", "--quiet", "--initial-branch=main");
    git(repositoryRoot, "config", "user.name", "P0 fixture");
    git(repositoryRoot, "config", "user.email", "p0-fixture@example.test");
    git(repositoryRoot, "add", "--", ...Object.keys(sourceFiles));
    git(repositoryRoot, "commit", "--quiet", "-m", "immutable normal onboarding candidate");
    const commitSha = git(repositoryRoot, "rev-parse", "HEAD");
    const treeSha = git(repositoryRoot, "rev-parse", "HEAD^{tree}");
    const storedSource: Record<string, { sha256: string; bytes: string }> = {};
    for (const path of Object.keys(sourceFiles)) {
      const bytes: Buffer = gitBytes(repositoryRoot, "show", `${commitSha}:${path}`);
      storedSource[path] = { sha256: hash(bytes), bytes: bytes.toString("base64") };
    }
    await writeFile(join(root, "source-provenance.json"), `${JSON.stringify({ repositoryRoot, commitSha, treeSha, sourceFiles: storedSource }, null, 2)}\n`, { mode: 0o600 });

    const reads: string[] = [];
    const repositories: GitHubRepositoryApi = {
      list: async () => [{ fullName: "acme/ordinary-orders", name: "ordinary-orders", defaultBranch: "main", cloneUrl: "https://github.com/acme/ordinary-orders.git" }],
      file: async (_token, _fullName, path) => {
        reads.push(path);
        return gitBlob(repositoryRoot, commitSha, path)?.toString("utf8");
      },
      snapshot: async () => { throw new Error("ordinary addProject must not supply or invent server source authority"); },
    };
    const controlPlane = fakeControlPlane();
    const repositoryId = "acme/ordinary-orders";
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
    const githubReads: string[] = [];
    const localBareRemote = join(root, "ordinary-orders-owned-bare.git");
    execFileSync("git", ["clone", "--bare", "--quiet", repositoryRoot, localBareRemote], { encoding: "utf8" });
    const localPullRequests = new Map<number, { headBranch: string; baseBranch: string; title: string; body: string }>();
    const githubTransport: typeof fetch = async (url) => {
      const parsed = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
      githubReads.push(parsed.pathname + parsed.search);
      if (parsed.pathname === "/repos/acme/ordinary-orders/installation") return Response.json({ id: 456, account: { login: "acme" } });
      if (parsed.pathname === "/app/installations/456/access_tokens") return Response.json({ token: "synthetic-installation-token" });
      if (parsed.pathname === "/repos/acme/ordinary-orders/commits/main") return Response.json({ sha: commitSha, commit: { tree: { sha: treeSha } } });
      if (parsed.pathname === `/repos/acme/ordinary-orders/git/trees/${treeSha}`) {
        return Response.json({ sha: treeSha, truncated: false, tree: Object.entries(sourceFiles).map(([path]) => {
          const bytes = gitBytes(repositoryRoot, "show", `${commitSha}:${path}`);
          return { path, mode: "100644", type: "blob", sha: git(repositoryRoot, "rev-parse", `${commitSha}:${path}`), size: bytes.byteLength };
        }) });
      }
      const blobMatch = /^\/repos\/acme\/ordinary-orders\/git\/blobs\/([a-f0-9]{40})$/.exec(parsed.pathname);
      if (blobMatch?.[1]) {
        const path = Object.keys(sourceFiles).find((candidatePath) => git(repositoryRoot, "rev-parse", `${commitSha}:${candidatePath}`) === blobMatch[1]);
        if (path !== undefined) {
          const bytes = gitBytes(repositoryRoot, "show", `${commitSha}:${path}`);
          return Response.json({ sha: blobMatch[1], encoding: "base64", size: bytes.byteLength, content: bytes.toString("base64") });
        }
      }
      return Response.json({ message: "unmodeled strict GitHub request" }, { status: 404 });
    };
    const githubProvider = new GitHubAppCredentialProvider({
      credentialRef: "github-app", appId: "123", getPrivateKey: async () => privateKey, fetchImplementation: githubTransport,
    });
    const sourcePort = { capture: vi.fn(({ repositoryUrl, ref }: { repositoryUrl: string; ref: string }) => githubProvider.captureE2ESourceSnapshot(repositoryUrl, ref)) };
    const objects = new Map<string, Buffer>();
    const s3 = { send: async (command: never) => {
      const typed = command as unknown as { constructor: { name: string }; input: { Key: string; Body?: string | Uint8Array; Range?: string } };
      const input = typed.input;
      if (typed.constructor.name === "DeleteObjectCommand") { objects.delete(input.Key); return {}; }
      if (input.Body !== undefined) { objects.set(input.Key, Buffer.from(input.Body)); return {}; }
      const bytes = objects.get(input.Key);
      if (bytes === undefined) throw Object.assign(new Error("The specified key does not exist."), { name: "NoSuchKey" });
      if (input.Range !== undefined) {
        const match = /^bytes=(\d+)-(\d+)$/.exec(input.Range);
        if (!match) throw new Error("invalid bounded setup range");
        const start = Number(match[1]); const end = Number(match[2]);
        const selected = bytes.subarray(start, end + 1);
        return { Body: { transformToByteArray: async () => new Uint8Array(selected), transformToString: async () => selected.toString("utf8") },
          ContentRange: `bytes ${start}-${end}/${bytes.byteLength}`, ContentLength: end - start + 1 };
      }
      return { Body: { transformToString: async () => bytes.toString("utf8"), transformToByteArray: async () => new Uint8Array(bytes) } };
    } };
    const runtimeCatalogId = "local-p0-test-catalog";
    const featureRuntimeCatalogId = "local-p0-feature-test-catalog";
    const runtimeBinding = ec2Binding(FOUNDATION_OUTPUTS, "agentx-staging-foundation");
    const runtimeCatalogKey = projectSetupRuntimeKey(runtimeCatalogId, projectSetupBindingDigest(runtimeBinding));
    const localRunnerToolchain = { execPath: process.execPath, version: process.version as "v22.23.2", platform: process.platform, arch: process.arch };
    const ownerDeveloperId = ownerKeyForSubject(issuer, "owner");
    const ownerSessionId = randomUUID();
    const ungrantedDeveloperId = ownerKeyForSubject(issuer, "ungranted-viewer");
    const ungrantedSessionId = randomUUID();
    const taskViewerSlackId = "U0P0TASKVIEW";
    const taskViewerDeveloperId = developerIdForSlackUser(taskViewerSlackId);
    let ownerChannelAccess = true;
    const taskViewerSessionId = randomUUID();
    const localBaseTreeReads: Array<{ repositoryUrl: string; commitSha: string; treeSha: string }> = [];
    const broker = createBroker({ s3, developer: {
      issuer, env: "staging", methods: { slack: true, oidc: true }, slackTeamId: "T0P0NATIVE", signInTableName: "state",
      workflowDependenciesEnabled: true,
      channelMembers: async () => ({ ok: true, memberOf: ownerChannelAccess ? ["C0P0NATIVE"] : [] }),
      taskPeopleConfiguration: { peopleChangesEnabled: true },
      taskPersonProof: async (request) => ({ ok: true, user: { id: request.slackUserId, teamId: "T0P0NATIVE",
        name: request.slackUserId === taskViewerSlackId ? "Task Viewer" : "Task Owner" },
        memberOf: request.slackUserId === "U0P0OWNER" && !ownerChannelAccess ? [] : request.channelIds }),
      taskPeopleDisplayRead: async (request) => request.operation === "proof"
        ? { operation: "proof", admission: { version: 1, slackCallsUsed: 1 }, result: { ok: true,
          user: { id: request.request.slackUserId, teamId: "T0P0NATIVE", name: request.request.slackUserId === taskViewerSlackId ? "Task Viewer" : "Task Owner" },
          memberOf: request.request.slackUserId === "U0P0OWNER" && !ownerChannelAccess ? [] : request.request.channelIds } }
        : { operation: "directory", admission: { version: 1, slackCallsUsed: 1 }, result: { ok: true, users: ["U0P0OWNER", taskViewerSlackId].map((id) => ({
          id, teamId: "T0P0NATIVE", name: id === taskViewerSlackId ? "Task Viewer" : "Task Owner", memberOf: request.request.channelIds,
        })) } },
      verifyAccessToken: async (authorization) => authorization === "Bearer synthetic-ungranted-session"
        ? ({ iss: issuer, aud: "agentx-developer", env: "staging", sub: ungrantedDeveloperId, sid: ungrantedSessionId, amr: "oidc", groups: [] })
        : authorization === "Bearer synthetic-task-viewer-session"
          ? ({ iss: issuer, aud: "agentx-developer", env: "staging", sub: taskViewerDeveloperId, sid: taskViewerSessionId, amr: "slack", groups: [] })
          : ({ iss: issuer, aud: "agentx-developer", env: "staging", sub: ownerDeveloperId, sid: ownerSessionId, amr: "oidc", groups: ["admins"] }),
    }, turnRecordsTableName: "turns", extra: {
      projectSetupSource: sourcePort, projectSetupRuntimeCatalogId: runtimeCatalogId, e2eFeatureRuntimeCatalogId: featureRuntimeCatalogId,
      githubPullRequests: { reconcilePullRequest: async (input: { repositoryUrl: string; headBranch: string; baseBranch: string; title: string; body?: string }) => {
        if (input.repositoryUrl !== "https://github.com/acme/ordinary-orders.git" || input.baseBranch !== "main") throw new Error("strict local PR adapter refuses unregistered repository or base");
        const commit = git(localBareRemote, "rev-parse", `refs/heads/${input.headBranch}^{commit}`);
        const number = 1;
        localPullRequests.set(number, { headBranch: input.headBranch, baseBranch: input.baseBranch, title: input.title, body: input.body ?? "" });
        return { number, url: "https://github.com/acme/ordinary-orders/pull/1", reconciled: false, commit } as never;
      }, getPullRequest: async (repositoryUrl: string, number: number) => {
        const pr = localPullRequests.get(number);
        if (repositoryUrl !== "https://github.com/acme/ordinary-orders.git" || pr === undefined) throw new Error("strict local PR adapter refuses unknown pull request");
        const headCommit = git(localBareRemote, "rev-parse", `refs/heads/${pr.headBranch}^{commit}`);
        return { number, url: "https://github.com/acme/ordinary-orders/pull/1", state: "open", headBranch: pr.headBranch, baseBranch: pr.baseBranch,
          headCommit, title: pr.title, body: pr.body };
      }, updatePullRequest: vi.fn(), verifyWebhookRepository: vi.fn(),
        getRepositoryIdentity: async (repositoryUrl: string) => repositoryUrl === "https://github.com/acme/ordinary-orders.git"
          ? { repositoryId: 740001, fullName: "acme/ordinary-orders" } : undefined,
        getPullRequestFeedback: async (repositoryUrl: string, number: number) => {
          const pr = localPullRequests.get(number);
          if (repositoryUrl !== "https://github.com/acme/ordinary-orders.git" || pr === undefined) throw new Error("strict local feedback adapter refuses unknown pull request");
          const headCommit = git(localBareRemote, "rev-parse", `refs/heads/${pr.headBranch}^{commit}`);
          return { pullRequest: { number, url: "https://github.com/acme/ordinary-orders/pull/1", state: "open", headBranch: pr.headBranch,
            baseBranch: pr.baseBranch, headCommit, headTreeSha: git(localBareRemote, "rev-parse", `${headCommit}^{tree}`), title: pr.title, body: pr.body }, comments: [], threads: [] };
        },
        getCommitTree: async (repositoryUrl: string, commit: string) => {
          if (repositoryUrl !== "https://github.com/acme/ordinary-orders.git") throw new Error("strict local Git adapter refuses an unregistered URL");
          const tree = git(localBareRemote, "rev-parse", `${commit}^{tree}`);
          if (commit === commitSha) localBaseTreeReads.push({ repositoryUrl, commitSha: commit, treeSha: tree });
          return tree;
        }, getBranchHead: async (repositoryUrl: string, branch: string) => {
          if (repositoryUrl !== "https://github.com/acme/ordinary-orders.git") throw new Error("strict local Git adapter refuses an unregistered URL");
          return git(localBareRemote, "rev-parse", `refs/heads/${branch}^{commit}`);
        }, getCommitParents: async (repositoryUrl: string, commit: string) => {
          if (repositoryUrl !== "https://github.com/acme/ordinary-orders.git") throw new Error("strict local Git adapter refuses an unregistered URL");
          const parents = git(localBareRemote, "show", "-s", "--format=%P", commit);
          return parents ? parents.split(" ") : [];
        } },
    } });
    broker.db.set({ pk: `SESSION#${ownerSessionId}`, sk: "META", sessionId: ownerSessionId, developerId: ownerDeveloperId, amr: "oidc",
      startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 60_000,
      reviewExpiresAt: Math.floor(Date.now() / 1000) + 60_000, slackUserId: "U0P0OWNER" });
    broker.db.set({ pk: `DEVELOPER#${ownerDeveloperId}`, sk: "META", developerId: ownerDeveloperId, provider: "oidc", issuer, subject: "owner",
      displayName: "Owner", firstSignInAt: "fixture", lastSignInAt: "fixture", revoked: false, slackUserId: "U0P0OWNER" });
    broker.db.set({ pk: `SESSION#${ungrantedSessionId}`, sk: "META", sessionId: ungrantedSessionId, developerId: ungrantedDeveloperId, amr: "oidc",
      startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 60_000,
      reviewExpiresAt: Math.floor(Date.now() / 1000) + 60_000, slackUserId: "U0P0VIEWER" });
    broker.db.set({ pk: `DEVELOPER#${ungrantedDeveloperId}`, sk: "META", developerId: ungrantedDeveloperId, provider: "oidc", displayName: "Unjoined viewer", firstSignInAt: "fixture", lastSignInAt: "fixture", revoked: false, slackUserId: "U0P0VIEWER" });
    broker.db.set({ pk: `SESSION#${taskViewerSessionId}`, sk: "META", sessionId: taskViewerSessionId, developerId: taskViewerDeveloperId, amr: "slack",
      startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 60_000,
      reviewExpiresAt: Math.floor(Date.now() / 1000) + 60_000, slackUserId: taskViewerSlackId });
    broker.db.set({ pk: `DEVELOPER#${taskViewerDeveloperId}`, sk: "META", developerId: taskViewerDeveloperId, provider: "slack", displayName: "Task Viewer", firstSignInAt: "fixture", lastSignInAt: "fixture", revoked: false, slackUserId: taskViewerSlackId });
    const localRunnerEnvironment = { ci: true as const, trustNoticeShown: false as const, os: `${process.platform} ${osRelease()}`, arch: process.arch, runtime: `node ${process.version}` };
    broker.db.set({ ...runtimeCatalogKey, schemaVersion: 1, entityType: "PROJECT_SETUP_RUNTIME", runtimeCatalogId, catalogRevision: 1,
      bindingDigest: projectSetupBindingDigest(runtimeBinding), binding: runtimeBinding, manifestDigest: hash(Buffer.from("fixture-runtime-manifest")),
      runnerEnvironment: localRunnerEnvironment, runnerEnvironmentDigest: hash(Buffer.from(canonicalJson(localRunnerEnvironment))),
      runnerToolchain: localRunnerToolchain, runnerToolchainDigest: hash(Buffer.from(canonicalJson(localRunnerToolchain))),
      endpoint: "http://127.0.0.1:8080", generation: 1, transportCorrelationId: randomUUID(), supportedSetupScopes: ["source-interface"],
      state: "READY", qualifiedAt: new Date(Date.now() - 1_000).toISOString(), expiresAt: new Date(Date.now() + 60 * 60_000).toISOString() });
    const rawRuntime = broker.db.find((item) => item.entityType === "PROJECT_SETUP_RUNTIME")[0]!;
    const { pk: _runtimePk, sk: _runtimeSk, ...runtimeRecord } = rawRuntime;
    void _runtimePk; void _runtimeSk;
    const parsedRuntime = ProjectSetupRuntimeRecordSchema.parse(runtimeRecord);
    expect(admitProjectSetupRuntime(parsedRuntime, { runtimeCatalogId, binding: runtimeBinding, scope: "source-interface", now: Date.now() })).toBeDefined();
    const adminResults: Array<{ path: string; status: number; body: Record<string, unknown> }> = [];
    const fetchImplementation: typeof fetch = async (url, init) => {
      const parsed = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
      if (["/v1/admin/projects/setup-proposals", "/v1/admin/projects/setup-approvals", "/v1/admin/projects"].includes(parsed.pathname)) {
        const response = await call(broker.handler, {
          method: init?.method ?? "GET", path: parsed.pathname,
          ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as unknown } : {}), user: { subject: "owner", admin: true },
        });
        adminResults.push({ path: parsed.pathname, status: response.status, body: response.body });
        return new Response(JSON.stringify(response.body), { status: response.status, headers: { "content-type": "application/json" } });
      }
      return controlPlane.fetch(url, init);
    };
    const prompts = scriptedPrompter(["acme/ordinary-orders", "", true]);
    const output: string[] = [];

    await addProject({
      env: "staging",
      session: { controlPlaneUrl: "https://cp.example.test", accessToken: "synthetic-admin-session" },
      githubToken: "synthetic-repository-session",
      prompter: prompts,
      write: (line) => output.push(line),
      services: { fetch: fetchImplementation, repositories, configDir: projectConfig, stackOutputs: async (name) => name === "agentx-staging-foundation" ? FOUNDATION_OUTPUTS : undefined },
      flags: {},
    });

    expect(sourcePort.capture, "ordinary addProject must ask the real broker route to capture the selected immutable source").toHaveBeenCalledTimes(1);
    const proposalEntry = [...objects.entries()].find(([key]) => key.startsWith("project-setup-proposals/"));
    expect(proposalEntry, "source-backed proposal remains stored under its server-owned key").toBeDefined();
    const storedProposal = JSON.parse(proposalEntry?.[1].toString("utf8") ?? "{}") as Record<string, unknown>;
    const proposalCandidateDigest = (storedProposal.candidate as { digest?: unknown } | undefined)?.digest;
    expect(typeof proposalCandidateDigest).toBe("string");
    const proposalPrimary = await persistOriginalMapPrimary({ root, kind: "setup-proposal", key: proposalEntry![0], objects,
      producer: "broker source-capture proposal object", sourceCandidateDigest: String(proposalCandidateDigest) });
    expect(storedProposal.candidate).toMatchObject({ repositories: [{ repositoryId, commitSha, treeSha }] });
    expect(githubReads).toContain(`/repos/acme/ordinary-orders/git/trees/${treeSha}?recursive=1`);
    expect(githubReads.length).toBeGreaterThan(Object.keys(sourceFiles).length);
    const registered = broker.db.find((item) => item.entityType === "PROJECT" && Boolean(item.definition) && (item.definition as { name?: string }).name === "ordinary-orders")[0];
    expect(registered?.setupApproval).toMatchObject({ decision: "approve" });
    expect(typeof (registered?.setupApproval as { proposalSha256?: unknown } | undefined)?.proposalSha256).toBe("string");
    expect((registered?.definition as { e2e?: unknown } | undefined)?.e2e).toBeDefined();
    const registeredE2EPolicy = (registered?.definition as { e2e: E2EPolicy }).e2e;
    const featureRuntimeRow = { pk: e2eFeatureVerifierKey(featureRuntimeCatalogId, registeredE2EPolicy.defaultSandboxProfileId).pk,
      sk: e2eFeatureVerifierKey(featureRuntimeCatalogId, registeredE2EPolicy.defaultSandboxProfileId).sk,
      schemaVersion: 1, entityType: "E2E_FEATURE_VERIFIER", runtimeCatalogId: featureRuntimeCatalogId, catalogRevision: 1,
      profileId: registeredE2EPolicy.defaultSandboxProfileId, bindingDigest: projectSetupBindingDigest(runtimeBinding), binding: runtimeBinding,
      manifestDigest: hash(Buffer.from("fixture-feature-runtime-manifest")), runnerEnvironmentDigest: hash(Buffer.from(canonicalJson(localRunnerEnvironment))),
      runnerEnvironment: localRunnerEnvironment, runnerToolchainDigest: hash(Buffer.from(canonicalJson(localRunnerToolchain))), runnerToolchain: localRunnerToolchain,
      endpoint: "http://127.0.0.1:8081", generation: 1, transportCorrelationId: randomUUID(), supportedFeatureScopes: [E2E_FEATURE_PROCESS_RESPONSE_SCOPE],
      state: "READY", qualifiedAt: new Date(Date.now() - 1_000).toISOString(), expiresAt: new Date(Date.now() + 60 * 60_000).toISOString() };
    broker.db.set(featureRuntimeRow);
    expect(reads).toContain("package.json");
    expect(prompts.asked.some((question) => question.startsWith("Use this project setup plan?"))).toBe(true);
    expect(output.join("\n")).toContain("Detected source-backed E2E setup");

    // The setup decision authorizes only this project-domain source-interface observation. The
    // runtime recompiles from the retained proposal bytes and keeps the result out of task rows.
    const retained = storedProposal as { candidate: E2ESourceSnapshot["candidate"]; snapshot: { commitSha: string; treeSha: string; treeComplete: true; treePaths: string[]; sources: Array<{ path: string; sha256: string; bytesBase64: string; kind: "blob" }> }; proposal: { targets: Array<{ targetId: string; kind: string }> } };
    const snapshot: E2ESourceSnapshot = {
      candidate: retained.candidate, commitSha: retained.snapshot.commitSha, treeSha: retained.snapshot.treeSha, treeComplete: true,
      treePaths: retained.snapshot.treePaths,
      sources: retained.snapshot.sources.map((item) => ({ path: item.path, sha256: item.sha256, bytes: Buffer.from(item.bytesBase64, "base64"), kind: item.kind })),
    };
    const inspected = inspectE2ERepository(snapshot, retained.candidate);
    expect(inspected.inspection.applications.map((item) => item.kind)).toEqual(expect.arrayContaining(["web", "api", "desktop"]));
    const target = inspected.inspection.proposedTargets.find((item) => item.kind === "web" && item.applicationId === "ordinary-orders");
    expect(target, "fixture includes a supported web source-interface target").toBeDefined();
    const operation = inspected.portableOperations.find((item) => item.applicationId === "ordinary-orders" && item.exportName === ".");
    expect(operation, "server discovery binds the source package export").toBeDefined();
    const module = snapshot.sources.find((item) => item.path === operation!.sourceRefs[0]?.path);
    const manifest = snapshot.sources.find((item) => item.path === operation!.manifestPath);
    expect(module).toBeDefined();
    expect(manifest).toBeDefined();
    const setupApproval = registered?.setupApproval as { proposalRef: string; proposalSha256: string; candidateDigest: string };
    const storedApproval = broker.db.get(`PROJECT_SETUP#ordinary-orders`, `PROPOSAL#${setupApproval.proposalSha256}`)!;
    const setupSmokePreview = deriveProjectSetupSourceSmoke({ projectName: "ordinary-orders", proposalSha256: setupApproval.proposalSha256,
      approval: { proposalRef: setupApproval.proposalRef, proposalSha256: setupApproval.proposalSha256, candidateDigest: setupApproval.candidateDigest,
        policyDigest: storedApproval.policyDigest, runtimeCatalogId, catalogRevision: 1, bindingDigest: projectSetupBindingDigest(runtimeBinding),
        manifestDigest: rawRuntime.manifestDigest, generation: 1 }, snapshot, policy: (registered!.definition as { e2e: E2EPolicy }).e2e,
      sandboxAvailability: { targetId: "default-sandbox", profileId: "default-sandbox", connection: "connected", approval: "approved", qualification: "qualified", authorizationRevision: "catalog-1" }, runtimeAvailability: [] });
    const setupPlanPreview = selectE2EExecutionPlan(setupSmokePreview.selectionInput);
    expect(setupPlanPreview.groups.length, "the normal stored admission must include sibling groups when portable targets exceed one group's limit").toBeGreaterThan(1);
    const setupExecutions = broker.db.find((item) => item.entityType === "PROJECT_SETUP_EXECUTION");
    const outboxes = broker.db.find((item) => item.entityType === "OUTBOX" && (item.invocation as { kind?: string } | undefined)?.kind === "project-setup-smoke");
    expect(setupExecutions, JSON.stringify({ setupApproval: registered?.setupApproval, runtimeBinding: registered?.runtimeBinding, adminResults,
      previewGroups: setupPlanPreview.groups.map((group) => ({ targets: group.targetIds, cases: group.expectedCases.length })), catalog: broker.db.find((item) => item.entityType === "PROJECT_SETUP_RUNTIME"),
      projectRows: broker.db.find((item) => item.entityType === "PROJECT_SETUP_EXECUTION" || item.entityType === "OUTBOX") })).toHaveLength(1);
    expect(outboxes).toHaveLength(1);
    const executionRow = setupExecutions[0]!;
    const outboxRow = outboxes[0]!;
    const setupExecutionId = String(executionRow.setupExecutionId);
    const operationId = String(executionRow.operationId);
    const workspaceId = String(executionRow.transportCorrelationId);
    const executionRef = executionRow.executionRef as { key: string; sha256: string; byteLength: number };
    expect(objects.get(executionRef.key)).toBeDefined();
    expect(executionRef.byteLength).toBe(objects.get(executionRef.key)?.byteLength);
    const executionPrimary = await persistOriginalMapPrimary({ root, kind: "setup-execution", key: executionRef.key, objects,
      producer: "broker immutable setup admission", sourceCandidateDigest: snapshot.candidate.digest });
    expect(executionPrimary.sha256).toBe(executionRef.sha256);
    const workerKeys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const journal = new OperationJournal(join(root, "worker-journal"));
    const evidenceRootForWorker = join(root, "setup-smoke-evidence");
    await mkdir(evidenceRootForWorker, { mode: 0o700 });
    const brokerFetch: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.hostname !== "setup-broker.invalid") return fetchImplementation(input, init);
      const response = await call(broker.handler, { method: init?.method ?? "GET", path: url.pathname + url.search,
        ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as unknown } : {}),
        ...(init?.headers ? { headers: init.headers as Record<string, string> } : {}) });
      const uploadRow = broker.db.get(`PROJECT_SETUP#${setupExecutionId}`, `EVIDENCE_UPLOAD#${operationId}`);
      const uploadFields = uploadRow === undefined ? undefined : Object.fromEntries(["entityType", "status", "setupExecutionId", "subjectId", "operationId", "fence", "approvalRevision", "transportCorrelationId", "uploadId", "totalBytes", "evidenceByteLimit", "chunkCount", "nextChunkIndex", "deadlineAt"]
        .filter((field) => field in uploadRow).map((field) => [field, uploadRow[field]]));
      brokerRouteObservations.push({ path: url.pathname, status: response.status, body: response.status >= 400 ? response.body : { accepted: response.body.accepted, uploadId: response.body.uploadId, evidenceRef: response.body.evidenceRef }, ...(url.pathname.endsWith("/evidence/chunks") ? { uploadFields } : {}) });
      return new Response(JSON.stringify(response.body), { status: response.status, headers: { "content-type": "application/json" } });
    };
    vi.stubGlobal("fetch", brokerFetch);
    let terminalStatus: string | undefined;
    const workerPosts: Array<{ status: number; body: string }> = [];
    const brokerRouteObservations: Array<{ path: string; status: number; body: Record<string, unknown> }> = [];
    const workerState = createWorkerServerState(journal, {
      invocationFeatures: ["project.setupSmoke"],
      execute: createDefaultProjectSetupExecutor({ sourceRoot: process.cwd(), evidenceRoot: evidenceRootForWorker, controlPlaneUrl: "http://setup-broker.invalid" }),
    }, { onTerminal: async (result, invocation) => {
      terminalStatus = result.status;
      if (invocation.kind !== "project-setup-smoke") throw new Error("setup callback must retain its invocation domain");
      await postProjectSetupTerminalResult({ controlPlaneUrl: "http://setup-broker.invalid", invocation, result, fetchImplementation: brokerFetch });
    }, retrySleep: async () => undefined }, { publicKey: workerKeys.publicKey, workspaceId, generation: 1 });
    const workerPing = await handleWorkerRequest(new Request("http://worker/ping"), workerState);
    expect(((await workerPing.json()) as { invocationFeatures: string[] }).invocationFeatures).toContain("project.setupSmoke");
    const setupGuard = createProjectSetupDispatchGuard({ documentClient: broker.db as never, tableName: "state", runtimeCatalogId });
    const guardObservations: string[] = [];
    const projectGuard = async (record: Parameters<typeof setupGuard>[0]) => {
      const result = await setupGuard(record);
      guardObservations.push(result);
      return result;
    };
    const projectLifecycle = createProjectSetupDispatchLifecycle({ documentClient: broker.db as never, tableName: "state" });
    const projectSetupSessions = new ProjectSetupSessionManager({ documentClient: broker.db as never, tableName: "state" });
    const delivery = createEc2Delivery({
      sessions: { ensureSession: async () => { throw new Error("setup delivery must not access WORKSPACE sessions"); } },
      binding: async () => { throw new Error("setup delivery must not read WORKSPACE runtime binding"); },
      projectSetupSessions,
      projectSetupBinding: createProjectSetupBindingReader({ documentClient: broker.db as never, tableName: "state" }),
      sign: async (message) => cryptoSign("sha256", message, workerKeys.privateKey),
      post: async (url, init) => {
        const response = await handleWorkerRequest(new Request(url, { method: "POST", headers: { authorization: init.authorization }, body: init.body }), workerState);
        const body = await response.text();
        workerPosts.push({ status: response.status, body });
        return { status: response.status, body };
      },
      progress: async () => undefined,
      workerFeatures: async () => ((await (await handleWorkerRequest(new Request("http://worker/ping"), workerState)).json()) as { invocationFeatures: string[] }).invocationFeatures,
      guardProjectSetupDispatch: projectGuard,
    });
    const publisher = createOutboxPublisherHandler({ send: async () => undefined, markQueued: async (id) => {
      const row = broker.db.get(String(outboxRow.pk), String(outboxRow.sk));
      if (row?.id === id) broker.db.set({ ...row, status: "QUEUED" });
    } });
    const publishResult = await publisher({ Records: [{ eventName: "INSERT", dynamodb: { NewImage: marshall(outboxRow) } }] as never });
    expect(publishResult.published).toBe(1);
    const queuedOutbox = broker.db.get(String(outboxRow.pk), String(outboxRow.sk))!;
    const dispatch = createDispatcherHandler({ guardProjectSetupDispatch: projectGuard, projectSetupLifecycle: projectLifecycle,
      markDispatching: async () => { throw new Error("setup must not use feature task lifecycle"); }, markDelivered: async () => undefined,
      markFailed: async () => undefined, deliverEc2: delivery });
    const dispatchResult = await dispatch({ Records: [{ messageId: String(outboxRow.id), body: JSON.stringify(queuedOutbox) }] });
    expect(dispatchResult.batchItemFailures).toEqual([]);
    expect(workerPosts.map(({ status, body }) => ({ status, accepted: (JSON.parse(body) as { accepted?: unknown }).accepted, state: (JSON.parse(body) as { status?: unknown }).status }))
      .filter(({ accepted }) => accepted === true)).toEqual([{ status: 200, accepted: true, state: "ACCEPTED" }]);
    const actualInvocation = (outboxRow.invocation as { operationId: string });
    for (let index = 0; index < 800 && terminalStatus === undefined; index += 1) await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    const journalAtBoundary = await journal.get(actualInvocation.operationId);
    expect(journalAtBoundary?.acceptedAt, "worker journal acceptance is separate evidence from an empty dispatcher failure list").toBeDefined();
    expect(terminalStatus, JSON.stringify({ dispatchResult, guardObservations, workerPosts, brokerRouteObservations, workerActive: workerState.activeOperations.has(actualInvocation.operationId), journal: journalAtBoundary,
      operation: broker.db.get(`PROJECT_SETUP#${setupExecutionId}`, `OPERATION#${actualInvocation.operationId}`), outbox: broker.db.get(String(outboxRow.pk), String(outboxRow.sk)) })).toBe("SUCCEEDED");
    const journalResult = await journal.get(actualInvocation.operationId);
    expect(journalResult?.status).toBe("SUCCEEDED");
    const setupOperation = broker.db.get(`PROJECT_SETUP#${setupExecutionId}`, `OPERATION#${actualInvocation.operationId}`);
    expect(setupOperation?.status).toBe("SUCCEEDED");
    const setupResult = setupOperation?.result as Record<string, unknown> | undefined;
    expect(setupResult?.evidenceRef).toBeDefined();
    const actualRef = setupResult?.evidenceRef as { key: string; sha256: string };
    const setupEvidencePrimary = await persistOriginalMapPrimary({ root, kind: "setup-transferred-evidence", key: actualRef.key, objects,
      producer: "authenticated setup worker evidence upload", sourceCandidateDigest: snapshot.candidate.digest });
    expect(setupEvidencePrimary.sha256).toBe(actualRef.sha256);
    const actualEvidence = JSON.parse(objects.get(actualRef.key)!.toString("utf8")) as {
      unsupportedTargetIds: string[];
      groupRuns: Array<{ actual: { publicList: { pairs: Array<{ disposition: string }> }; assertionReceipts: unknown[]; runProcess: { status: number } }; collection: { status: string; reason?: string; runId?: string | null } }>;
    };
    const qualificationDiagnostic = { setupResult, actualCollections: actualEvidence.groupRuns.map(({ collection }) => collection), brokerRoutes: brokerRouteObservations.map(({ path, status, body }) => ({ path, status, error: body.error })) };
    expect(qualificationDiagnostic, JSON.stringify(qualificationDiagnostic))
      .toMatchObject({ setupResult: { domain: "project-setup-source-interface/v1", processStatus: "SUCCEEDED", qualification: "PASS", cleanupConfirmed: true }, actualCollections: actualEvidence.groupRuns.map(() => ({ status: "PASS" })) });
    expect(actualEvidence.groupRuns.length).toBeGreaterThan(0);
    expect(actualEvidence.groupRuns.every((run) => run.actual.runProcess.status === 0)).toBe(true);
    expect(actualEvidence.groupRuns.length).toBe(setupPlanPreview.groups.length);
    const supportedTargetCount = inspected.inspection.proposedTargets.length;
    expect(actualEvidence.groupRuns.reduce((total, run) => total + run.actual.publicList.pairs.length, 0)).toBe(10);
    expect(actualEvidence.groupRuns.flatMap((run) => run.actual.publicList.pairs).filter((pair) => pair.disposition === "run")).toHaveLength(supportedTargetCount);
    expect(actualEvidence.groupRuns.flatMap((run) => run.actual.publicList.pairs).filter((pair) => pair.disposition === "filtered")).toHaveLength(6);
    const admittedPlan = JSON.parse(objects.get(executionRef.key)!.toString("utf8")) as { selectedTargetIds: string[]; unsupportedTargetIds: string[] };
    const allTargetIds = inspected.inspection.proposedTargets.map((target) => target.targetId).sort();
    expect([...admittedPlan.selectedTargetIds, ...admittedPlan.unsupportedTargetIds].sort()).toEqual(allTargetIds);
    expect(new Set([...admittedPlan.selectedTargetIds, ...admittedPlan.unsupportedTargetIds]).size).toBe(allTargetIds.length);
    const androidDiscovery = inspected.inspection.applications.find((item) => item.kind === "mobile" && item.sourcePaths.includes("android/app/build.gradle"));
    expect(androidDiscovery, "native Android discovery remains visible even when discovery cannot establish a target identity").toMatchObject({ kind: "mobile", sourcePaths: ["android/app/build.gradle"] });
    const setupExecutionObject = JSON.parse(objects.get(executionRef.key)!.toString("utf8")) as {
      discoveredApplications: Array<{ applicationId: string; kind: string; sourcePaths: string[] }>;
      discoveryMissingInputs: unknown[];
      discoveredTargetIds: string[];
    };
    expect(setupExecutionObject.discoveredApplications).toEqual(inspected.inspection.applications);
    expect(setupExecutionObject.discoveryMissingInputs).toEqual(inspected.inspection.missingInputs);
    const androidMissingInput = setupExecutionObject.discoveryMissingInputs.find((item): item is { sourcePaths: string[]; reason: string; disposition: string } => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return false;
      const row = item as Record<string, unknown>;
      return Array.isArray(row.sourcePaths) && row.sourcePaths.includes("android/app/build.gradle")
        && typeof row.reason === "string" && row.disposition === "blocking";
    });
    expect(androidMissingInput).toBeDefined();
    expect(setupExecutionObject.discoveredTargetIds).toEqual(allTargetIds);
    expect(setupExecutionObject.discoveredApplications).toContainEqual(androidDiscovery);
    expect(setupExecutionObject.discoveredTargetIds).not.toContain(androidDiscovery?.applicationId);
    expect(actualEvidence.groupRuns.flatMap((run) => run.actual.assertionReceipts).length).toBeGreaterThan(0);
    await writeFile(join(root, "setup-smoke-receipt.json"), JSON.stringify({
      domain: "project-setup-source-interface/v1", projectName: "ordinary-orders", candidateDigest: snapshot.candidate.digest,
      adminHttpResponses: adminResults.map(({ path, status }) => ({ path, status })),
      setupWorkerHttpResponses: brokerRouteObservations.map(({ path, status }) => ({ path, status })),
      setupExecutionId, operationId: actualInvocation.operationId, executionRef, evidenceRef: actualRef,
      originalPrimaries: [proposalPrimary, executionPrimary, setupEvidencePrimary],
      discoveredApplications: inspected.inspection.applications.map(({ applicationId, kind, sourcePaths }) => ({ applicationId, kind, sourcePaths })),
      discoveryMissingInputs: inspected.inspection.missingInputs,
      discoveredTargetIds: inspected.inspection.proposedTargets.map(({ targetId }) => targetId).sort(),
      requestedTargets: inspected.inspection.proposedTargets.map(({ targetId, applicationId, kind, runtimeProfileId }) => ({ targetId, applicationId, kind, runtimeProfileId })),
      selectedTargetIds: (JSON.parse(objects.get(executionRef.key)!.toString("utf8")) as { selectedTargetIds: string[] }).selectedTargetIds,
      notExecutedTargetIds: (JSON.parse(objects.get(executionRef.key)!.toString("utf8")) as { notExecutedTargetIds: string[] }).notExecutedTargetIds,
      publicLists: actualEvidence.groupRuns.map((run) => run.actual.publicList), assertionReceipts: actualEvidence.groupRuns.flatMap((run) => run.actual.assertionReceipts), collections: actualEvidence.groupRuns.map((run) => run.collection),
      setupResult,
    }, null, 2) + "\n", { mode: 0o600, flag: "wx" });

    // Continue the same registered project through its ordinary developer task route. The local
    // transport below supplies only an untrusted planner artifact; the broker still parses,
    // canonicalizes, stores, and binds the bytes before the Owner decision.
    const channelBinding = await call(broker.handler, { method: "PUT", path: "/v1/admin/slack/bindings/T0P0NATIVE/C0P0NATIVE",
      user: { subject: "owner", admin: true }, body: { projectName: "ordinary-orders" } });
    expect(channelBinding.status, JSON.stringify(channelBinding.body)).toBe(200);
    broker.db.set({ pk: `MEMBER#${ownerDeveloperId}`, sk: "PROJECT#ordinary-orders", entityType: "MEMBERSHIP", ownerKey: ownerDeveloperId,
      projectName: "ordinary-orders", role: "developer", grantId: randomUUID(), grantedBy: { issuer, subject: "owner" }, grantedAt: new Date().toISOString() });
    const featureStartRequest = { requestId: randomUUID(), project: "ordinary-orders", instructions: "Add an orders list using the approved source context",
      client: "native-p0-journey", workflow: true, workflowPath: "QUICK" };
    const featureStartRequestBytes = Buffer.from(JSON.stringify(featureStartRequest), "utf8");
    const featureStartResponseRaw = await broker.handler({ version: "2.0", rawPath: "/v1/dev/tasks", rawQueryString: "",
      headers: { authorization: "Bearer synthetic-owner-session", "content-type": "application/json" }, body: featureStartRequestBytes.toString("utf8"),
      requestContext: { requestId: randomUUID(), http: { method: "POST" } } });
    const featureStartResponseBytes = Buffer.from(featureStartResponseRaw.body, "utf8");
    const featureStartRequestPrimary = await persistOriginalEvidencePrimary({ root, kind: "ordinary-task-start-http-request", key: "/v1/dev/tasks",
      bytes: featureStartRequestBytes, producer: "exact ordinary developer task start request body", sourceCandidateDigest: proposalCandidateDigest as string });
    const featureStartResponsePrimary = await persistOriginalEvidencePrimary({ root, kind: "ordinary-task-start-http-response", key: "/v1/dev/tasks",
      bytes: featureStartResponseBytes, producer: "exact normal task producer response body before parsing", sourceCandidateDigest: proposalCandidateDigest as string });
    const featureStart = { status: featureStartResponseRaw.statusCode, body: JSON.parse(featureStartResponseBytes.toString("utf8")) as Record<string, unknown> };
    expect(featureStart.status, JSON.stringify(featureStart.body)).toBe(200);
    const featureTaskId = String((featureStart.body.task as { taskId: string }).taskId);
    const featureTask = broker.db.get(`DEVTASK#${featureTaskId}`, "META") as { workspaceId: string; workflow: { revision: number; artifacts: Array<{ type: string; sha256: string; objectKey: string }> } };
    const featureWorkspaceId = featureTask.workspaceId;
    const featureOperations = () => broker.db.find((item) => item.pk === `WORKSPACE#${featureWorkspaceId}` && item.entityType === "OPERATION");
    const shareResponse = await call(broker.handler, { method: "POST", path: `/v1/dev/tasks/${featureTaskId}/share`,
      headers: { authorization: "Bearer synthetic-owner-session" }, body: { requestId: randomUUID(), shareMode: "view", channel: "C0P0NATIVE" } });
    expect(shareResponse.status, JSON.stringify(shareResponse.body)).toBe(200);
    const strictSlack = new StrictSlackWeb({ briefLimit: 1_200 });
    const notifierPosts: Array<{ channel: string; threadTs?: string; text: string; blocks?: unknown[] }> = [];
    const notifierLogs: Array<Record<string, unknown>> = [];
    const { createNotifierHandler } = await import("../../packages/broker/src/aws/developer-task-notifier.js");
    const { loadWorkflowE2EPresentation } = await import("../../packages/broker/src/aws/broker.js");
    let notifierE2EBlocks: unknown[] | undefined;
    const notifierHandler = createNotifierHandler({
      documentClient: broker.db, tableName: "state", enqueue: async () => undefined, retryLater: async () => undefined,
      post: async (input) => { const posted = strictSlack.post(input); notifierPosts.push(input); return { ts: posted.ts }; },
      update: async (input) => strictSlack.update(input), now: Date.now, log: (entry) => notifierLogs.push(entry), deliveryFailed: () => undefined,
      workflowE2EBlocks: async (task, operations) => {
        void operations;
        const progress = task.workflow?.e2e;
        const candidateDigest = task.workflow?.candidate?.digest;
        const ref = progress?.displayRef;
        if (candidateDigest === undefined || progress?.currentRoundId === undefined || ref === undefined) return undefined;
        const view = await readWorkflowE2ENotifierProjection({ ref, ownerKey: task.ownerKey, workspaceId: task.workspaceId,
          current: { candidateDigest, roundId: progress.currentRoundId, groupRunIds: progress.currentGroupRunIds,
            admissionSha256: ref.admissionSha256, evidenceSha256: ref.evidenceSha256 },
          readPrivateObject: async (key, maxBytes) => {
            if (maxBytes > 262_144 || !/^private\/[^/]+\/[^/]+\/workflow-e2e-display\/[a-f0-9]{64}\.json$/u.test(key)) return undefined;
            const bytes = objects.get(key);
            return bytes !== undefined && bytes.byteLength <= maxBytes ? bytes : undefined;
          } });
        notifierE2EBlocks = view === undefined ? undefined : renderE2ESlackBlocks(view);
        return notifierE2EBlocks;
      },
    });
    const storedShare = (broker.db.get(`DEVTASK#${featureTaskId}`, "META") as { share: { sharedAt: string } }).share;
    const startNotice = { id: `${featureTaskId}:start`, kind: "start", taskId: featureTaskId, at: storedShare.sharedAt };
    const startDelivery = await notifierHandler({ Records: [{ eventSource: "aws:sqs", messageId: "native-start", receiptHandle: "native-start",
      body: JSON.stringify(startNotice), attributes: { ApproximateReceiveCount: "1" } }] });
    expect(startDelivery.batchItemFailures).toEqual([]);
    expect((broker.db.get(`DEVTASK#${featureTaskId}`, "META") as { share?: { threadTs?: string } }).share?.threadTs).toBeDefined();
    const postsBeforeDeniedAccess = notifierPosts.length;
    const deniedTaskRead = await call(broker.handler, { method: "GET", path: `/v1/dev/tasks/${featureTaskId}`,
      headers: { authorization: "Bearer synthetic-ungranted-session" } });
    expect(deniedTaskRead.status, JSON.stringify(deniedTaskRead.body)).toBe(404);
    expect(JSON.stringify(deniedTaskRead.body)).not.toContain("Orders list implementation");
    const deniedSendBack = await call(broker.handler, { method: "POST", path: `/v1/dev/tasks/${featureTaskId}/workflow/send-back`,
      headers: { authorization: "Bearer synthetic-ungranted-session" }, body: { requestId: randomUUID(), expectedRevision: 1,
        instructions: "Unjoined viewers cannot issue workflow commands." } });
    expect(deniedSendBack.status, JSON.stringify(deniedSendBack.body)).toBe(404);
    expect(notifierPosts).toHaveLength(postsBeforeDeniedAccess);
    const deniedAccessBytes = Buffer.from(JSON.stringify({ taskRead: deniedTaskRead, sendBack: deniedSendBack }), "utf8");
    const deniedAccessPrimary = await persistOriginalEvidencePrimary({ root, kind: "ungranted-task-access-http-responses",
      key: `/v1/dev/tasks/${featureTaskId} and /v1/dev/tasks/${featureTaskId}/workflow/send-back`, bytes: deniedAccessBytes,
      producer: "actual-broker-routes for authenticated developer without project membership", sourceCandidateDigest: snapshot.candidate.digest });
    await writeFile(join(root, "ungranted-task-access-response-capture.json"), `${JSON.stringify({ taskRead: deniedTaskRead, sendBack: deniedSendBack,
      primary: deniedAccessPrimary, notifierPostsBefore: postsBeforeDeniedAccess, notifierPostsAfter: notifierPosts.length }, null, 2)}\n`,
    { mode: 0o600, flag: "wx" });
    const callbackFor = async (operationId: string, action: "result" | "artifacts", body: unknown) => {
      const outbox = broker.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0];
      const callbackCapability = (outbox?.invocation as { callbackCapability?: string } | undefined)?.callbackCapability;
      expect(callbackCapability, `task operation ${operationId} has a server-issued callback capability`).toBeDefined();
      return call(broker.handler, { method: "POST", path: `/v1/internal/workspaces/${featureWorkspaceId}/operations/${operationId}/${action}`,
        headers: { "x-agentx-callback-capability": callbackCapability! }, body });
    };
    const prepareOperation = featureOperations().find((item) => item.kind === "prepare");
    expect(prepareOperation).toBeDefined();
    const prepareCallback = await callbackFor(String(prepareOperation!.id), "result", { operationId: prepareOperation!.id, status: "SUCCEEDED",
      result: { preparedBase: [{ repositoryId: "ordinary-orders", baseCommitSha: commitSha }] } });
    expect(prepareCallback.status).toBe(200);
    const planOperation = featureOperations().find((item) => item.workflowMode === "PLAN");
    expect(planOperation).toBeDefined();
    const ordersRendererOperationId = portableOperationId(".", "ordinary-orders");
    const e2eIntent = {
      schemaVersion: 1 as const, requestedTargetIds: ["web-1", "web-2", "api-3", "desktop-4"],
      portableOperationRefs: [
        { operationId: ordersRendererOperationId, applicationId: "ordinary-orders", requestedTargetIds: ["web-1"],
          packageExportSubpath: ".", moduleSpecifier: "./src/index.mjs", callableSelector: { kind: "named" as const, exportName: "renderOrders" } },
        { operationId: portableOperationId(".", "orders-admin"), applicationId: "orders-admin", requestedTargetIds: ["web-2"],
          packageExportSubpath: ".", moduleSpecifier: "./src/index.mjs", callableSelector: { kind: "named" as const, exportName: "listAdminOrders" } },
        { operationId: portableOperationId(".", "ordinary-orders-api"), applicationId: "ordinary-orders-api", requestedTargetIds: ["api-3"],
          packageExportSubpath: ".", moduleSpecifier: "./index.mjs", callableSelector: { kind: "named" as const, exportName: "listOrders" } },
        { operationId: portableOperationId(".", "orders-desktop"), applicationId: "orders-desktop", requestedTargetIds: ["desktop-4"],
          packageExportSubpath: ".", moduleSpecifier: "./main.mjs", callableSelector: { kind: "named" as const, exportName: "createWindow" } },
      ],
      mockFixtureRefs: [{ componentId: `api-schema-${hash(Buffer.from("openapi.json")).slice(0, 12)}`, requestedTargetId: "web-1", operationId: "listOrders",
        sourcePath: "api/fixtures/orders-mocks.json", sourceSha256: hash(Buffer.from(sourceFiles["api/fixtures/orders-mocks.json"])) }],
      accountContextRefs: [
        { applicationId: "ordinary-orders", profileId: "synthetic", sourcePath: "package.json", sourceSha256: hash(Buffer.from(sourceFiles["package.json"])) },
        { applicationId: "orders-admin", profileId: "synthetic", sourcePath: "admin/package.json", sourceSha256: hash(Buffer.from(sourceFiles["admin/package.json"])) },
        { applicationId: "ordinary-orders-api", profileId: "synthetic", sourcePath: "api/package.json", sourceSha256: hash(Buffer.from(sourceFiles["api/package.json"])) },
        { applicationId: "orders-desktop", profileId: "synthetic", sourcePath: "desktop/package.json", sourceSha256: hash(Buffer.from(sourceFiles["desktop/package.json"])) },
      ],
      scenarios: [...[
        { mode: "success", expected: '<li data-testid="orders-list">Sample order</li>' },
        { mode: "refusal", expected: "refused:403" },
        { mode: "invalid-data", expected: "invalid-data" },
      ].map(({ mode, expected }) => ({ scenarioId: `orders-renderer-${mode}`, requirementId: "render-orders-source-contract", requestedTargetIds: ["web-1"], required: true,
        accountProfileId: "synthetic", minimumEvidence: "mock-contract" as const, requiredRealComponentIds: [],
        steps: [{ kind: "invoke-contract" as const, operationId: ordersRendererOperationId, input: { mode } }],
        assertions: [{ kind: "state" as const, probeId: "result", equals: expected, pollTimeoutMs: 1000 }] })),
      ...[
        { scenarioId: "orders-admin-export", targetId: "web-2", operationId: portableOperationId(".", "orders-admin"), expected: [] },
        { scenarioId: "orders-api-export", targetId: "api-3", operationId: portableOperationId(".", "ordinary-orders-api"), expected: [] },
        { scenarioId: "orders-desktop-export", targetId: "desktop-4", operationId: portableOperationId(".", "orders-desktop"), expected: { kind: "desktop-source-smoke" } },
      ].map(({ scenarioId, targetId, operationId, expected }) => ({ scenarioId, requirementId: `${scenarioId}-requirement`, requestedTargetIds: [targetId], required: true,
        accountProfileId: "synthetic", minimumEvidence: "source" as const, requiredRealComponentIds: [],
        steps: [{ kind: "invoke-contract" as const, operationId, input: {} }],
        assertions: [{ kind: "state" as const, probeId: "result", equals: expected, pollTimeoutMs: 1000 }] }))],
      semanticExportDeltas: [{ applicationId: "ordinary-orders", operationId: ordersRendererOperationId, requestedTargetIds: ["web-1"],
        expectedExportNames: ["priceRows", "renderOrders"], reason: "Expose the approved orders renderer for the source-supported portable invocation." }],
    };
    const graph = { schemaVersion: 1 as const, taskId: featureTaskId, version: 1,
      items: [{ id: randomUUID(), title: "Implement orders list", description: "Add the requested view and regression coverage.", repository: "ordinary-orders", dependsOn: [] }] };
    const untrustedPlan = { schemaVersion: 1 as const, title: "Orders list implementation", why: [{ text: "The owner requested an orders view.", author: "planner" }],
      claims: [{ id: "1", text: "The orders list is visible." }], notChanging: ["Existing access rules."], risks: ["Source smoke does not establish native runtime behavior."],
      decisions: [], workBreakdown: graph, e2e: e2eIntent };
    const plannerArtifact = `\`\`\`agentx-plan\n${JSON.stringify(untrustedPlan)}\n\`\`\`\n`;
    const parsedPlanner = parsePlanDocument(plannerArtifact, { kind: "plan" });
    if (!parsedPlanner.ok) await writeFile(join(root, "feature-plan-parse-rejection.json"), `${JSON.stringify(parsedPlanner.errors, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    expect(parsedPlanner.ok, JSON.stringify(parsedPlanner.ok ? null : parsedPlanner.errors)).toBe(true);
    const plannerPrimary = await persistOriginalEvidencePrimary({ root, kind: "untrusted-planner-artifact",
      key: `callback:/v1/internal/workspaces/${String(featureWorkspaceId)}/operations/${String(planOperation!.id)}/artifacts/plan.md`, bytes: plannerArtifact,
      producer: "worker model proposal callback request", sourceCandidateDigest: snapshot.candidate.digest });
    const planArtifactCallback = await callbackFor(String(planOperation!.id), "artifacts", { name: "plan.md", mediaType: "text/markdown", content: plannerArtifact });
    expect(planArtifactCallback.status).toBe(200);
    const planTerminal = await callbackFor(String(planOperation!.id), "result", { operationId: planOperation!.id, status: "SUCCEEDED" });
    expect(planTerminal.status, JSON.stringify(planTerminal.body)).toBe(200);
    const plannedTask = broker.db.get(`DEVTASK#${featureTaskId}`, "META") as { workflow: { revision: number; stage: string; state: string; artifacts: Array<{ type: string; sha256: string; objectKey: string }> } };
    const canonicalPlanArtifact = plannedTask.workflow.artifacts.filter((artifact) => artifact.type === "plan").at(-1);
    expect(canonicalPlanArtifact).toBeDefined();
    const canonicalPlanBytes = objects.get(String(canonicalPlanArtifact!.objectKey))?.toString("utf8");
    const canonicalPlanPrimary = await persistOriginalMapPrimary({ root, kind: "canonical-plan-document", key: canonicalPlanArtifact!.objectKey, objects,
      producer: "broker canonical PlanDocument artifact", sourceCandidateDigest: snapshot.candidate.digest });
    expect(canonicalPlanPrimary.sha256).toBe(canonicalPlanArtifact!.sha256);
    expect(canonicalPlanPrimary.byteLength).toBe(Buffer.byteLength(canonicalPlanBytes ?? "", "utf8"));
    const canonicalPlan = readCanonicalPlan(canonicalPlanBytes ?? "");
    expect(canonicalPlan?.e2e).toEqual(e2eIntent);
    expect(hash(Buffer.from(canonicalPlanBytes ?? ""))).toBe(canonicalPlanArtifact?.sha256);
    const ownerDecision = await call(broker.handler, { method: "POST", path: `/v1/dev/tasks/${featureTaskId}/workflow/decision`,
      headers: { authorization: "Bearer synthetic-owner-session" }, body: { requestId: randomUUID(), expectedRevision: plannedTask.workflow.revision,
        decision: "APPROVE", reason: "Approve the canonical plan and its ordered graph.", artifactDigest: canonicalPlanArtifact!.sha256,
        workBreakdownDigest: taskGraphDigest(graph) } });
    expect(ownerDecision.status, JSON.stringify(ownerDecision.body)).toBe(200);
    const approvedTask = broker.db.get(`DEVTASK#${featureTaskId}`, "META") as { workflow: { workflowDependenciesApproval?: { artifactDigest: string; graphDigest: string }; artifacts: Array<{ sha256: string }> } };
    expect(approvedTask.workflow.workflowDependenciesApproval).toMatchObject({ artifactDigest: canonicalPlanArtifact!.sha256, graphDigest: taskGraphDigest(graph) });
    await writeFile(join(root, "feature-plan-owner-approval-receipt.json"), JSON.stringify({ taskId: featureTaskId, workspaceId: featureWorkspaceId,
      httpResponses: { taskStart: featureStart.status, prepareCallback: prepareCallback.status, planArtifactCallback: planArtifactCallback.status,
        planTerminalCallback: planTerminal.status, ownerDecision: ownerDecision.status },
      plannerArtifactSha256: hash(Buffer.from(plannerArtifact)), canonicalPlanSha256: canonicalPlanArtifact!.sha256,
      originalPrimaries: [plannerPrimary, canonicalPlanPrimary],
      e2eIntentDigest: hash(Buffer.from(canonicalJson(e2eIntent))), graphDigest: taskGraphDigest(graph),
      ownerDecision: ownerDecision.body, workflowDependenciesApproval: approvedTask.workflow.workflowDependenciesApproval }, null, 2) + "\n", { mode: 0o600, flag: "wx" });

    // Prepare the next boundary against the frozen 5A exports: an actual local-only Git candidate
    // descends from the task's pinned base, with two commits and exact source bytes read back from
    // Git objects. These bytes are a comparison primary, never an accepted candidate/evidence
    // object supplied to the broker.
    const candidateWorktree = join(root, "unpublished-final-candidate");
    const candidateBranch = `codex/p0-candidate-${randomUUID()}`;
    git(repositoryRoot, "worktree", "add", "--quiet", "-b", candidateBranch, candidateWorktree, commitSha);
    await mkdir(join(candidateWorktree, "src"), { recursive: true });
    await writeFile(join(candidateWorktree, "src", "orders-view.mjs"),
      "export async function renderOrders(input) { const response = await fetch(`/orders?mode=${encodeURIComponent(input.mode)}`); if (!response.ok) return `refused:${response.status}`; const body = await response.json(); if (!Array.isArray(body.orders)) return 'invalid-data'; return body.orders.map((row) => `<li data-testid=\"orders-list\">${row.name.toLowerCase()}</li>`).join(''); }\n", { mode: 0o600, flag: "wx" });
    git(candidateWorktree, "add", "--", "src/orders-view.mjs");
    git(candidateWorktree, "commit", "--quiet", "-m", "Add the orders list renderer");
    const firstCandidateCommit = git(candidateWorktree, "rev-parse", "HEAD");
    const indexPath = join(candidateWorktree, "src", "index.mjs");
    const indexBefore = await readFile(indexPath, "utf8");
    await writeFile(indexPath, `import { applyPrice } from './price-rows.mjs';\nimport { renderOrders } from './orders-view.mjs';\nexport { renderOrders };\nexport function priceRows(input) { return { rows: input.rows.map(applyPrice) }; }\n`, { mode: 0o600 });
    git(candidateWorktree, "add", "--", "src/index.mjs");
    git(candidateWorktree, "commit", "--quiet", "-m", "Export the orders list renderer");
    const finalCandidateCommit = git(candidateWorktree, "rev-parse", "HEAD");
    const finalCandidateTree = git(candidateWorktree, "rev-parse", "HEAD^{tree}");
    const candidatePaths = git(candidateWorktree, "ls-tree", "-r", "--name-only", finalCandidateCommit).split("\n").filter(Boolean).sort();
    const candidateSources = candidatePaths.map((path) => {
      const bytes: Buffer = gitBytes(candidateWorktree, "show", `${finalCandidateCommit}:${path}`);
      return { path, sha256: hash(bytes), bytes, kind: "blob" as const };
    });
    const localCandidateSnapshot: E2ESourceSnapshot = {
      candidate: createCandidateManifest([{ repositoryId: "ordinary-orders", commitSha: finalCandidateCommit,
        treeSha: finalCandidateTree, baseCommitSha: commitSha }]),
      commitSha: finalCandidateCommit, treeSha: finalCandidateTree, treeComplete: true,
      treePaths: candidatePaths, sources: candidateSources,
    };
    const candidatePrimaries = [];
    for (const source of candidateSources) {
      const primary = await persistOriginalEvidencePrimary({ root, kind: "unpublished-candidate-source",
        key: `${finalCandidateCommit}:${source.path}`, bytes: source.bytes,
        producer: "independent local Git object readback; comparison only",
        sourceCandidateDigest: localCandidateSnapshot.candidate.digest });
      candidatePrimaries.push(primary);
    }
    const candidateReceipt = {
      status: "PREPARATION_ONLY_NOT_BROKER_ADMITTED", repositoryId: "ordinary-orders", branch: candidateBranch,
      baseCommitSha: commitSha, firstCandidateCommit, commitSha: finalCandidateCommit, treeSha: finalCandidateTree,
      candidateDigest: localCandidateSnapshot.candidate.digest, treePaths: candidatePaths,
      sources: candidateSources.map(({ path, sha256, bytes }) => ({ path, sha256, byteLength: bytes.byteLength })),
      remotes: git(candidateWorktree, "remote", "-v"), workingTree: git(candidateWorktree, "status", "--porcelain"),
      originalPrimaries: candidatePrimaries,
    };
    await writeFile(join(root, "unpublished-candidate-preparation.json"), `${JSON.stringify(candidateReceipt, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    expect(firstCandidateCommit).not.toBe(commitSha);
    expect(finalCandidateCommit).not.toBe(firstCandidateCommit);
    expect(finalCandidateTree).not.toBe(treeSha);
    expect(candidateReceipt.remotes, "the candidate remains local and unpublished").toBe("");
    expect(candidateReceipt.workingTree, "the candidate is captured from a clean committed Git tree").toBe("");
    expect(candidateSources.find((source) => source.path === "src/index.mjs")?.bytes.toString("utf8")).not.toBe(indexBefore);

    // Drive the approved implementation operation through the real worker runner and its normal
    // private callback client. The scripted provider is only an untrusted model transport; source
    // identity is read from the committed Git objects by runTaskInvocation itself.
    const implementOutbox = broker.db.find((item) => item.entityType === "OUTBOX" && item.workspaceId === featureWorkspaceId
      && (item.invocation as { kind?: string; payload?: { workflowMode?: string } } | undefined)?.kind === "task"
      && (item.invocation as { payload?: { workflowMode?: string } } | undefined)?.payload?.workflowMode === "IMPLEMENT")[0];
    expect(implementOutbox, "Owner approval must issue the ordinary implementation invocation").toBeDefined();
    const implementInvocation = WorkerInvocationSchema.parse(implementOutbox!.invocation);
    const workerWorkspace = join(root, "actual-worker-workspace");
    const workerRepository = join(workerWorkspace, "repo", "ordinary-orders");
    await mkdir(join(workerWorkspace, "repo"), { recursive: true });
    git(repositoryRoot, "worktree", "add", "--quiet", "-b", `codex/p0-worker-${randomUUID()}`, workerRepository, commitSha);
    git(workerRepository, "remote", "add", "origin", "https://github.com/acme/ordinary-orders.git");
    await mkdir(join(workerWorkspace, ".agentx"), { recursive: true, mode: 0o700 });
    await writeFile(join(workerWorkspace, ".agentx", "preparation-manifest.json"), `${JSON.stringify({
      schemaVersion: 2, projectName: "ordinary-orders", projectRevision: implementInvocation.projectRevision,
      repositories: [{ name: "ordinary-orders", path: "repo/ordinary-orders", defaultBranch: "main", resolvedCommit: commitSha,
        resolvedAt: new Date().toISOString(), completedAt: new Date().toISOString() }],
      completedSetupSteps: [], readinessResults: [], creationIdentity: `fixture-${featureTaskId}`, complete: true, updatedAt: new Date().toISOString(),
    }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    expect(implementInvocation).toMatchObject({ kind: "task", payload: { workflowMode: "IMPLEMENT" } });
    const callbackRequests: Array<{ path: string; request: unknown; status: number; response: unknown }> = [];
    let checksOperationId: string | undefined;
    const groupUploadInitRequests = new Map<string, Record<string, unknown>>();
    const duplicateGroupInitResponses: Array<{ groupRunId: string; status: number; body: Record<string, unknown> }> = [];
    const conflictingGroupInitResponses: Array<{ groupRunId: string; status: number; body: Record<string, unknown>; storedRunIds: string[] }> = [];
    const partialGroupTaskResponses: Array<{ groupRunId: string; statusCode: number; path: string; body: Record<string, unknown>; primary: unknown }> = [];
    const reverseGroupFinalizeOrder: string[] = [];
    const concurrentGroupFinalizeOrder: string[] = [];
    const concurrentGroupFinalizeArrivals: string[] = [];
    const groupServiceReconstruction: Array<{ priorAcceptedGroupRunIds: string[]; immutableGroupEvidenceRef: unknown; exactObjectSha256: string; exactObjectByteLength: number }> = [];
    let groupHandlerReconstructed = false;
    let groupFinalizeMode: "reverse" | "concurrent" = "reverse";
    let capturePartialGroupView = true;
    let reverseGroupRunIds: string[] = [];
    let releaseFirstGroupFinalize: () => void = () => undefined;
    const firstGroupFinalizeRelease = new Promise<void>((resolveRelease) => { releaseFirstGroupFinalize = resolveRelease; });
    let releaseConcurrentGroupFinalizes: () => void = () => undefined;
    const concurrentGroupFinalizeRelease = new Promise<void>((resolveRelease) => { releaseConcurrentGroupFinalizes = resolveRelease; });
    const workerFetch: typeof fetch = async (url, init) => {
      const parsed = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
      const requestBody = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
      const finalizeGroupRunId = recordOf(requestBody)?.stage === "finalize" ? recordOf(requestBody)?.groupRunId : undefined;
      const currentGroupFinalize = checksOperationId !== undefined && parsed.pathname.includes(`/operations/${checksOperationId}/`)
        && parsed.pathname.endsWith("/e2e-evidence") && typeof finalizeGroupRunId === "string" && reverseGroupRunIds.length === 2;
      if (currentGroupFinalize && groupFinalizeMode === "reverse" && finalizeGroupRunId === reverseGroupRunIds[0]) {
        await firstGroupFinalizeRelease;
      } else if (currentGroupFinalize && groupFinalizeMode === "concurrent") {
        concurrentGroupFinalizeArrivals.push(finalizeGroupRunId);
        if (concurrentGroupFinalizeArrivals.length === 2) releaseConcurrentGroupFinalizes();
        await concurrentGroupFinalizeRelease;
      }
      const response = await call(broker.handler, { method: init?.method ?? "GET", path: parsed.pathname,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        ...(requestBody === undefined ? {} : { body: requestBody }) });
      callbackRequests.push({ path: parsed.pathname, request: requestBody, status: response.status, response: response.body });
      if (checksOperationId !== undefined && parsed.pathname.includes(`/operations/${checksOperationId}/`) && parsed.pathname.endsWith("/e2e-evidence")
        && requestBody && typeof requestBody === "object" && !Array.isArray(requestBody)) {
        const upload = requestBody as Record<string, unknown>;
        if (upload.stage === "init" && typeof upload.groupRunId === "string") groupUploadInitRequests.set(upload.groupRunId, upload);
        if (upload.stage === "finalize" && typeof upload.groupRunId === "string" && response.status < 400) {
          const acceptedOperation = broker.db.get(`WORKSPACE#${featureWorkspaceId}`, `OPERATION#${checksOperationId}`) as {
            workflowE2EGroupRunIds?: string[]; workflowE2EGroupEvidenceRefs?: Array<{ groupRunId: string; evidenceRef: { key: string; sha256: string; byteLength: number } }>;
          } | undefined;
          if (groupFinalizeMode === "reverse") reverseGroupFinalizeOrder.splice(0, reverseGroupFinalizeOrder.length, ...(acceptedOperation?.workflowE2EGroupRunIds ?? []));
          else concurrentGroupFinalizeOrder.splice(0, concurrentGroupFinalizeOrder.length, ...(acceptedOperation?.workflowE2EGroupRunIds ?? []));
          if (groupFinalizeMode === "reverse" && !groupHandlerReconstructed && acceptedOperation?.workflowE2EGroupRunIds?.length === 1) {
            const acceptedRef = acceptedOperation.workflowE2EGroupEvidenceRefs?.[0];
            const storedBytes = acceptedRef === undefined ? undefined : objects.get(acceptedRef.evidenceRef.key);
            if (acceptedRef === undefined || storedBytes === undefined || hash(storedBytes) !== acceptedRef.evidenceRef.sha256
              || storedBytes.byteLength !== acceptedRef.evidenceRef.byteLength) throw new Error("restart control could not read back the first immutable admitted group result");
            const oldHandler = broker.handler;
            broker.handler = (await loadSlackBroker()).createAwsBrokerHandler(broker.brokerInput as never);
            if (broker.handler === oldHandler) throw new Error("restart control reused the old broker handler instead of reconstructing it");
            groupHandlerReconstructed = true;
            groupServiceReconstruction.push({ priorAcceptedGroupRunIds: [...acceptedOperation.workflowE2EGroupRunIds],
              immutableGroupEvidenceRef: acceptedRef, exactObjectSha256: hash(storedBytes), exactObjectByteLength: storedBytes.byteLength });
          }
          if (capturePartialGroupView && partialGroupTaskResponses.length === 0) {
            const taskPath = `/v1/dev/tasks/${featureTaskId}`;
            const taskResponse = await broker.handler({ version: "2.0", rawPath: taskPath, rawQueryString: "",
              headers: { authorization: "Bearer synthetic-owner-session" },
              requestContext: { requestId: randomUUID(), http: { method: "GET" } } });
            const taskBytes = Buffer.from(taskResponse.body, "utf8");
            const taskBody = JSON.parse(taskBytes.toString("utf8")) as Record<string, unknown>;
            const taskPrimary = await persistOriginalEvidencePrimary({ root, kind: "partial-current-group-task-detail-http-response",
              key: taskPath, bytes: taskBytes, producer: "actual authenticated task-detail route after first accepted group and before second group delivery",
              sourceCandidateDigest: workerCandidate.digest });
            const task = recordOf(taskBody.task);
            const presentation = recordOf(task?.e2ePresentation);
            const shared = recordOf(presentation?.shared);
            const e2e = recordOf(shared?.e2e);
            expect(taskResponse.statusCode).toBe(200);
            expect(e2e, JSON.stringify(taskBody)).toMatchObject({ status: "UNKNOWN", expectedGroups: 2, receivedGroups: 1 });
            partialGroupTaskResponses.push({ groupRunId: upload.groupRunId, statusCode: taskResponse.statusCode, path: taskPath,
              body: taskBody, primary: taskPrimary });
          }
          const groupInitRequest = groupUploadInitRequests.get(upload.groupRunId);
          if (groupInitRequest === undefined) throw new Error("group finalize had no original server-bound init request");
          const duplicate = await call(broker.handler, { method: "POST", path: parsed.pathname,
            headers: Object.fromEntries(new Headers(init?.headers).entries()), body: groupInitRequest });
          duplicateGroupInitResponses.push({ groupRunId: upload.groupRunId, status: duplicate.status, body: duplicate.body });
          const conflictDigest = groupInitRequest.sha256 === "f".repeat(64) ? "e".repeat(64) : "f".repeat(64);
          const conflict = await call(broker.handler, { method: "POST", path: parsed.pathname,
            headers: Object.fromEntries(new Headers(init?.headers).entries()), body: { ...groupInitRequest, sha256: conflictDigest } });
          const afterConflict = broker.db.get(`WORKSPACE#${featureWorkspaceId}`, `OPERATION#${checksOperationId}`) as {
            workflowE2EGroupRunIds?: string[];
          } | undefined;
          conflictingGroupInitResponses.push({ groupRunId: upload.groupRunId, status: conflict.status, body: conflict.body,
            storedRunIds: afterConflict?.workflowE2EGroupRunIds ?? [] });
        }
        if (groupFinalizeMode === "reverse" && upload.groupRunId === reverseGroupRunIds[1]) releaseFirstGroupFinalize();
      }
      if (response.status >= 400) {
        await writeFile(join(root, "worker-callback-rejection.json"), `${JSON.stringify({ path: parsed.pathname, status: response.status,
          request: requestBody, response: response.body, localBaseTreeReads }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
        throw new Error(`local callback ${parsed.pathname} HTTP ${response.status}: ${JSON.stringify(response.body)}`);
      }
      return new Response(JSON.stringify(response.body), { status: response.status, headers: { "content-type": "application/json" } });
    };
    const callbacks = createWorkerCallbackSinks({ controlPlaneUrl: "https://cp.example.test", invocation: implementInvocation, fetchImplementation: workerFetch });
    const { modelRuntime, faux } = await fauxModelRuntime();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "cd repo/ordinary-orders && mkdir -p test && cat > test/orders-view.test.mjs <<'EOF'\nimport assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { priceRows } from '../src/index.mjs';\ntest('preserves each row price', () => { assert.deepEqual(priceRows({ rows: [{ price: 4 }] }), { rows: [{ price: 7 }] }); });\nEOF\ngit add -- test/orders-view.test.mjs && git commit -m 'Add an orders renderer regression test'" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("bash", { command: "cd repo/ordinary-orders && cat > src/index.mjs <<'EOF'\nimport { applyPrice } from './price-rows.mjs';\nexport async function renderOrders(input) { const response = await fetch(`/orders?mode=${encodeURIComponent(input.mode)}`); if (!response.ok) return `refused:${response.status}`; const body = await response.json(); if (!Array.isArray(body.orders)) return 'invalid-data'; return body.orders.map((row) => `<li data-testid=\\\"orders-list\\\">${row.name.toLowerCase()}</li>`).join(''); }\nexport function priceRows(input) { return { rows: input.rows.map(applyPrice) }; }\nEOF\ngit add -- src/index.mjs && git commit -m 'Implement the orders list renderer'" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("I added the requested orders renderer export."),
    ]);
    const workerResult = await runTaskInvocation(implementInvocation, {
      rootPath: workerWorkspace, model: FAUX_MODEL, piAdapter: createDefaultPiSessionAdapter({ modelRuntime: async () => ({ runtime: modelRuntime, model: FAUX_MODEL }) }),
      eventSink: callbacks.eventSink, artifactSink: callbacks.artifactSink,
    });
    await writeFile(join(root, "worker-run-result.json"), `${JSON.stringify({ workflowMode: workerResult.workflowMode,
      candidate: workerResult.workflowCandidateRepositories, sourceExport: workerResult.workflowCandidateSourceExport,
      gitHead: git(workerRepository, "rev-parse", "HEAD"), gitTree: git(workerRepository, "rev-parse", "HEAD^{tree}"),
      gitStatus: git(workerRepository, "status", "--porcelain"), callbackRequests }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    expect(workerResult.workflowCandidateSourceExport, "the actual worker must export committed source from its final HEAD").toBeDefined();
    const workerCandidateIdentity = workerResult.workflowCandidateSourceExport!.repositories[0]!;
    const workerGitTreeBytes = gitBytes(workerRepository, "ls-tree", "-rz", "-r", "--full-tree", workerCandidateIdentity.commitSha);
    const workerGitTreePrimary = await persistOriginalEvidencePrimary({ root, kind: "worker-candidate-git-tree-listing",
      key: `${workerCandidateIdentity.commitSha}:${workerCandidateIdentity.treeSha}`, bytes: workerGitTreeBytes,
      producer: "direct Git ls-tree read from actual runTaskInvocation worktree", sourceCandidateDigest: workerResult.workflowCandidateSourceExport!.candidate.digest });
    const workerGitBlobPrimaries = [];
    for (const source of workerCandidateIdentity.sources) {
      const bytes = gitBytes(workerRepository, "show", `${workerCandidateIdentity.commitSha}:${source.path}`);
      expect(hash(bytes), `direct Git blob ${source.path} must match the first-party export`).toBe(source.sha256);
      workerGitBlobPrimaries.push(await persistOriginalEvidencePrimary({ root, kind: "worker-candidate-git-blob",
        key: `${workerCandidateIdentity.commitSha}:${source.path}`, bytes,
        producer: "direct Git show read from actual runTaskInvocation worktree", sourceCandidateDigest: workerResult.workflowCandidateSourceExport!.candidate.digest }));
    }
    await writeFile(join(root, "worker-candidate-git-readback.json"), `${JSON.stringify({ repositoryPath: workerRepository,
      candidate: workerCandidateIdentity, head: git(workerRepository, "rev-parse", "HEAD"), tree: git(workerRepository, "rev-parse", "HEAD^{tree}"),
      status: git(workerRepository, "status", "--porcelain"), treePrimary: workerGitTreePrimary, blobPrimaries: workerGitBlobPrimaries }, null, 2)}\n`,
    { mode: 0o600, flag: "wx" });
    const sourceExportPrimary = await persistOriginalEvidencePrimary({ root, kind: "worker-candidate-source-export-request",
      key: `candidate-export:${implementInvocation.operationId}`, bytes: JSON.stringify(workerResult.workflowCandidateSourceExport),
      producer: "actual runTaskInvocation result before private callback", sourceCandidateDigest: workerResult.workflowCandidateSourceExport!.candidate.digest });
    await postWorkerTerminalResult(callbacks, { operationId: implementInvocation.operationId, status: "SUCCEEDED", result: workerResult }, implementInvocation);
    const exportRequests = callbackRequests.filter(({ path }) => path.endsWith("/candidate-export"));
    await writeFile(join(root, "candidate-export-http-observations.json"), `${JSON.stringify({
      operationId: implementInvocation.operationId,
      sourceCandidateDigest: workerResult.workflowCandidateSourceExport!.candidate.digest,
      requests: exportRequests,
      resultRequest: callbackRequests.filter(({ path }) => path.endsWith("/result")),
    }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    expect(exportRequests.map(({ status }) => status)).toEqual([200, 200, 200]);
    for (const [index, request] of exportRequests.entries()) await persistOriginalEvidencePrimary({ root, kind: `candidate-export-http-${index}`,
      key: `${implementInvocation.operationId}:${index}`, bytes: JSON.stringify(request), producer: "actual default worker callback HTTP request/response",
      sourceCandidateDigest: workerResult.workflowCandidateSourceExport!.candidate.digest });
    const implementationOperation = broker.db.get(`WORKSPACE#${featureWorkspaceId}`, `OPERATION#${implementInvocation.operationId}`) as Record<string, unknown> | undefined;
    expect(implementationOperation?.candidateSourceRef, "the broker must persist the finalized sourceRef before terminal handling").toBeDefined();
    const sourceRef = implementationOperation!.candidateSourceRef as { key: string; sha256: string; byteLength: number; candidateDigest: string };
    const storedExportPrimary = await persistOriginalMapPrimary({ root, kind: "stored-candidate-source-export", key: sourceRef.key, objects,
      producer: "broker content-addressed candidate source object before test-scope teardown", sourceCandidateDigest: sourceRef.candidateDigest });
    expect(storedExportPrimary).toMatchObject({ sha256: sourceRef.sha256, byteLength: sourceRef.byteLength });
    expect(callbackRequests.find(({ path }) => path.endsWith("/result"))?.status).toBe(200);
    await writeFile(join(root, "feature-candidate-export-receipt.json"), `${JSON.stringify({ operationId: implementInvocation.operationId,
      workflowMode: "IMPLEMENT", workerCandidate: workerResult.workflowCandidateRepositories, sourceRef,
      callbackResponses: callbackRequests.map(({ path, status }) => ({ path, status })),
      sourceExportPrimary, storedExportPrimary,
    }, null, 2)}\n`, { mode: 0o600, flag: "wx" });

    // This is the actual frozen-source RED boundary: after normal Owner artifact and graph approval,
    // source export now exists, but no first-party current-round joint VERIFY is attached to the task.
    const currentTask = broker.db.get(`DEVTASK#${featureTaskId}`, "META") as { workflow: Record<string, unknown> };
    const currentWorkflow = currentTask.workflow;
    const currentE2E = currentWorkflow.e2e && typeof currentWorkflow.e2e === "object"
      ? currentWorkflow.e2e as Record<string, unknown> : undefined;
    const currentRoundId = currentE2E?.currentRoundId;
    const currentGroupRunIds = currentE2E?.currentGroupRunIds;
    await writeFile(join(root, "feature-checks-dispatch-state.json"), `${JSON.stringify({ workflow: currentWorkflow,
      workflowDispatchRows: broker.db.find((item) => item.entityType === "WORKFLOW_DISPATCH" || String(item.pk).startsWith("WORKFLOW_DISPATCH")),
      checkOperations: broker.db.find((item) => item.workflowMode === "CHECKS"), featureRuntime: broker.db.find((item) => item.entityType === "E2E_FEATURE_VERIFIER") }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    const workerCandidate = createCandidateManifest(workerResult.workflowCandidateRepositories ?? []);
    const currentPlanArtifact = (currentWorkflow.artifacts as Array<{ id: string; type: string; sha256: string; objectKey: string }>).filter((artifact) => artifact.type === "plan").at(-1);
    const workflowApproval = currentWorkflow.workflowDependenciesApproval as { artifactDigest?: string; graphDigest?: string; runId?: string; workflowRevision?: number; actorId?: string } | undefined;
    const decisions = currentWorkflow.decisions as Array<{ decision: string; actorId: string; artifactDigest?: string; workBreakdownDigest?: string }>;
    const ownerApprovedPlan = currentPlanArtifact && decisions.some((decision) => decision.decision === "APPROVE"
      && decision.artifactDigest === currentPlanArtifact.sha256 && decision.workBreakdownDigest === workflowApproval?.graphDigest);
    expect(ownerApprovedPlan, "the feature source binding must be derived only after canonical plan and graph Owner approval").toBe(true);
    expect(workflowApproval?.artifactDigest).toBe(currentPlanArtifact?.sha256);
    const actualExport = workerResult.workflowCandidateSourceExport!;
    const actualRepository = actualExport.repositories[0]!;
    const actualSnapshot: E2ESourceSnapshot = {
      candidate: actualExport.candidate, commitSha: actualRepository.commitSha, treeSha: actualRepository.treeSha,
      treeComplete: true, treePaths: actualRepository.treePaths,
      sources: actualRepository.sources.map((source) => ({ path: source.path, sha256: source.sha256,
        bytes: Buffer.from(source.bytesBase64, "base64"), kind: "blob" as const })),
    };
    const approvedCanonicalPlan = readCanonicalPlan(objects.get(String(currentPlanArtifact?.objectKey))?.toString("utf8") ?? "");
    const approvedPlanDigest = hash(Buffer.from(canonicalJson({ domain: "workflow-feature-e2e-approved-plan/v1", taskId: featureTaskId,
      artifactId: currentPlanArtifact?.id, artifactSha256: currentPlanArtifact?.sha256,
      graphDigest: workflowApproval?.graphDigest, graphRunId: workflowApproval?.runId,
      workflowRevision: workflowApproval?.workflowRevision, actorId: workflowApproval?.actorId })));
    const featureApprovalBinding = approvedCanonicalPlan?.e2e && currentPlanArtifact
      ? deriveE2EFeaturePortableApprovalBinding({ intent: approvedCanonicalPlan.e2e, snapshot: actualSnapshot,
        artifactId: currentPlanArtifact.id, artifactSha256: currentPlanArtifact.sha256, planDigest: approvedPlanDigest }) : undefined;
    expect(featureApprovalBinding?.operations, "the final committed candidate export must resolve every Owner-approved portable selector").toHaveLength(4);
    await writeFile(join(root, "feature-portable-source-binding.json"), `${JSON.stringify({ status: "SOURCE_BOUND_NOT_QUALIFIED",
      planArtifact: { id: currentPlanArtifact?.id, sha256: currentPlanArtifact?.sha256 }, graphApproval: workflowApproval,
      candidate: actualSnapshot.candidate, sourceRefs: featureApprovalBinding?.operations[0]?.sourceRefs,
      operation: featureApprovalBinding?.operations[0], bindingDigest: featureApprovalBinding?.bindingDigest,
      browserScenarioRemainsRequiredUnavailable: true }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    expect.soft((currentWorkflow.candidate as { digest?: unknown } | undefined)?.digest,
      "normal feature workflow must independently bind the unpublished worker-local final candidate").toBe(workerCandidate.digest);
    expect.soft(currentRoundId, "normal feature workflow must persist the admitted candidate-bound round before VERIFY work begins").toMatch(/^[0-9a-f-]{36}$/i);
    expect.soft(currentGroupRunIds, "the current round must bind each selected group run exactly once").toEqual(expect.arrayContaining([expect.stringMatching(/^[0-9a-f-]{36}$/i)]));
    const checksOperation = broker.db.find((item) => item.workflowMode === "CHECKS").find((item) => item.workflowE2EAdmission !== undefined);
    expect.soft(checksOperation?.workflowE2EAdmission, "the CHECKS operation must carry only the server-created immutable admission reference").toMatchObject({
      taskId: featureTaskId, candidateDigest: workerCandidate.digest, roundId: currentRoundId, groupRunIds: currentGroupRunIds,
    });

    const checksOutbox = broker.db.find((item) => item.entityType === "OUTBOX" && item.workspaceId === featureWorkspaceId
      && (item.invocation as { kind?: string; payload?: { workflowMode?: string } } | undefined)?.kind === "task"
      && (item.invocation as { payload?: { workflowMode?: string } } | undefined)?.payload?.workflowMode === "CHECKS")[0];
    expect(checksOutbox, "the server-created CHECKS operation must have its ordinary durable worker outbox").toBeDefined();
    const checksInvocation = WorkerInvocationSchema.parse(checksOutbox!.invocation);
    checksOperationId = checksInvocation.operationId;
    const initialGroupRunIds = recordOf(recordOf(checksInvocation.payload)?.workflowE2EAdmission)?.groupRunIds;
    reverseGroupRunIds = Array.isArray(initialGroupRunIds) ? initialGroupRunIds.filter((id): id is string => typeof id === "string") : [];
    const checkCallbacks = createWorkerCallbackSinks({ controlPlaneUrl: "https://cp.example.test", invocation: checksInvocation, fetchImplementation: workerFetch });
    const checksWorkerState = createWorkerServerState(journal, {
      execute: async (invocation) => runTaskInvocation(invocation, {
        rootPath: workerWorkspace, model: FAUX_MODEL, eventSink: checkCallbacks.eventSink, artifactSink: checkCallbacks.artifactSink,
        workflowE2EAdmissionReader: checkCallbacks.workflowE2EAdmissionReader, workflowE2EEvidenceSink: checkCallbacks.workflowE2EEvidenceSink,
        workflowE2EEvidenceRoot: evidenceRootForWorker, workflowE2ERuntimeRoot: process.cwd(),
      }),
    }, { onTerminal: async (result, invocation) => postWorkerTerminalResult(checkCallbacks, result, invocation), retrySleep: async () => undefined },
    { publicKey: workerKeys.publicKey, workspaceId: featureWorkspaceId, generation: 1 });
    const checksTaskGuard = async (record: Parameters<typeof guardTaskDispatch>[1]) => {
      const admission = createTaskAuthorityAdmission({ now: Date.now, lambdaRemainingMs: 60_000 });
      try { return await guardTaskDispatch({ documentClient: broker.db, tableName: "state", admission }, record); }
      finally { admission.close(); }
    };
    const checksDelivery = createEc2Delivery({
      sessions: { ensureSession: async () => ({ ready: true as const, generation: 1, privateIp: "127.0.0.1" }) },
      binding: async () => runtimeBinding,
      sign: async (message) => cryptoSign("sha256", message, workerKeys.privateKey),
      post: async (_url, init) => {
        const response = await handleWorkerRequest(new Request("http://worker/invocations", { method: "POST",
          headers: { authorization: init.authorization, "content-type": "application/json" }, body: init.body }), checksWorkerState);
        return { status: response.status, body: await response.text() };
      },
      workerFeatures: async () => ((await (await handleWorkerRequest(new Request("http://worker/ping"), checksWorkerState)).json()) as { invocationFeatures: string[] }).invocationFeatures,
      guardTaskDispatch: checksTaskGuard, progress: async () => undefined,
    });
    const checksDispatcher = createDispatcherHandler({
      guardTaskDispatch: checksTaskGuard,
      markDispatching: async (record) => {
        try {
          await broker.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `WORKSPACE#${record.workspaceId}`, sk: `OPERATION#${record.operationId}` },
            UpdateExpression: "SET #status = :dispatching, updatedAt = :now", ConditionExpression: "#status = :accepted OR #status = :dispatching",
            ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":accepted": "ACCEPTED", ":dispatching": "DISPATCHING", ":now": new Date().toISOString() } }));
          return true;
        } catch (error) { if (error instanceof Error && error.name === "ConditionalCheckFailedException") return false; throw error; }
      },
      markDelivered: async (id) => { await broker.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `OUTBOX#${id}`, sk: "OUTBOX" },
        UpdateExpression: "SET #status = :delivered, deliveredAt = :now", ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":delivered": "DELIVERED", ":now": new Date().toISOString() } })); },
      markFailed: async () => undefined, deliverEc2: checksDelivery,
    });
    const checksPublisher = createOutboxPublisherHandler({ send: async () => undefined, markQueued: async (id) => {
      await broker.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `OUTBOX#${id}`, sk: "OUTBOX" },
        UpdateExpression: "SET #status = :queued", ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":queued": "QUEUED" } }));
    } });
    const checksPublished = await checksPublisher({ Records: [{ eventName: "INSERT", dynamodb: { NewImage: marshall(checksOutbox!) } }] as never });
    expect(checksPublished.published).toBe(1);
    const checksQueuedOutbox = broker.db.get(String(checksOutbox!.pk), String(checksOutbox!.sk))!;
    const checksDispatchResult = await checksDispatcher({ Records: [{ messageId: String(checksOutbox!.id), body: JSON.stringify(checksQueuedOutbox) }] });
    expect(checksDispatchResult.batchItemFailures).toEqual([]);
    for (let index = 0; index < 800; index += 1) {
      const operation = broker.db.get(`WORKSPACE#${featureWorkspaceId}`, `OPERATION#${checksInvocation.operationId}`);
      if (operation?.status === "SUCCEEDED" || operation?.status === "FAILED") break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    const completedChecksOperation = broker.db.get(`WORKSPACE#${featureWorkspaceId}`, `OPERATION#${checksInvocation.operationId}`);
    expect(completedChecksOperation?.status, JSON.stringify({ checksInvocation, checksDispatchResult, journal: await journal.get(checksInvocation.operationId), completedChecksOperation }))
      .toBe("SUCCEEDED");
    const storedGroupEvidenceRefs = (completedChecksOperation?.workflowE2EGroupEvidenceRefs ?? []) as Array<{
      groupRunId: string; evidenceRef: { key: string; sha256: string; byteLength: number };
    }>;
    const expectedGroupRunIds = (checksInvocation.payload as { workflowE2EAdmission?: { groupRunIds?: string[] } }).workflowE2EAdmission?.groupRunIds ?? [];
    expect(storedGroupEvidenceRefs.map(({ groupRunId }) => groupRunId).sort()).toEqual([...expectedGroupRunIds].sort());
    expect(reverseGroupFinalizeOrder, "actual independent group finalization must complete in the opposite order without changing admitted IDs")
      .toEqual([...expectedGroupRunIds].reverse());
    expect(groupServiceReconstruction, "the second original admitted group must complete through a reconstructed handler over the same durable store and immutable object store")
      .toHaveLength(1);
    expect(groupServiceReconstruction[0]?.priorAcceptedGroupRunIds).toHaveLength(1);
    expect(storedGroupEvidenceRefs).toHaveLength(2);
    expect(duplicateGroupInitResponses).toHaveLength(expectedGroupRunIds.length);
    expect(duplicateGroupInitResponses.every((item) => item.status === 200
      && item.body.complete === true && item.body.groupRunId === item.groupRunId)).toBe(true);
    expect(conflictingGroupInitResponses).toHaveLength(expectedGroupRunIds.length);
    expect(conflictingGroupInitResponses.every((item) => item.status >= 400 && item.storedRunIds.filter((runId) => runId === item.groupRunId).length === 1)).toBe(true);
    const groupEvidencePrimaries = await Promise.all(storedGroupEvidenceRefs.map(async ({ groupRunId, evidenceRef }) => {
      const primary = await persistOriginalMapPrimary({ root, kind: `feature-checks-group-${groupRunId}`, key: evidenceRef.key,
        objects, producer: "default worker group finalize stored one content-addressed immutable group envelope before aggregate CHECKS completion",
        sourceCandidateDigest: workerCandidate.digest });
      expect(primary.sha256).toBe(evidenceRef.sha256);
      expect(primary.byteLength).toBe(evidenceRef.byteLength);
      return primary;
    }));
    await writeFile(join(root, "feature-checks-group-acceptance.json"), `${JSON.stringify({ operationId: checksInvocation.operationId,
      groupRunIds: expectedGroupRunIds, acceptedGroupEvidenceRefs: storedGroupEvidenceRefs, groupEvidencePrimaries,
      groupServiceReconstruction, reverseGroupFinalizeOrder, duplicateGroupInitResponses, conflictingGroupInitResponses, partialGroupTaskResponses }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    const ordinaryCheckResult = (completedChecksOperation?.result as { checks?: { checks?: Array<{ exitCode: number; status: string }> } } | undefined)?.checks?.checks;
    expect(ordinaryCheckResult, "ordinary project checks must pass independently of the E2E regression").toEqual(
      expect.arrayContaining([expect.objectContaining({ exitCode: 0, after: "passed", class: "passing" })]));
    const evidenceRef = completedChecksOperation?.workflowE2EEvidenceRef as { key?: string } | undefined;
    const rawE2EEvidence = typeof evidenceRef?.key === "string" ? evidenceRef.key : undefined;
    const e2eEvidence: unknown = rawE2EEvidence === undefined ? undefined : JSON.parse(objects.get(rawE2EEvidence)?.toString("utf8") ?? "null") as unknown;
    const e2eEvidenceRecord = e2eEvidence && typeof e2eEvidence === "object" && !Array.isArray(e2eEvidence) ? e2eEvidence as Record<string, unknown> : undefined;
    const admissionReference = completedChecksOperation?.workflowE2EAdmission as { admissionRef?: { key?: string; sha256?: string; byteLength?: number } } | undefined;
    const admissionKey = admissionReference?.admissionRef?.key;
    const admissionPrimary = typeof admissionKey === "string" ? await persistOriginalMapPrimary({ root, kind: "feature-checks-admission",
      key: admissionKey, objects, producer: "broker stored immutable CHECKS admission before test-scope teardown",
      sourceCandidateDigest: workerCandidate.digest }) : undefined;
    const evidencePrimary = rawE2EEvidence === undefined ? undefined : await persistOriginalMapPrimary({ root, kind: "feature-checks-evidence",
      key: rawE2EEvidence, objects, producer: "broker stored immutable CHECKS evidence before test-scope teardown",
      sourceCandidateDigest: workerCandidate.digest });
    const admissionText = typeof admissionKey === "string" ? objects.get(admissionKey)?.toString("utf8") : undefined;
    const storedAdmission = admissionText === undefined ? undefined : JSON.parse(admissionText) as Record<string, unknown>;
    const planDiagnostic = storedAdmission?.plan && typeof storedAdmission.plan === "object" ? storedAdmission.plan as Record<string, unknown> : undefined;
    await writeFile(join(root, "feature-checks-verifier-inputs.json"), `${JSON.stringify({ admissionPrimary, evidencePrimary,
      planCompleteness: planDiagnostic === undefined ? undefined : { criteria: planDiagnostic.criteria, unavailableCriteria: planDiagnostic.unavailableCriteria,
        groups: Array.isArray(planDiagnostic.groups) ? planDiagnostic.groups.map((group) => recordOf(group) && ({ groupId: recordOf(group)?.groupId,
          expectedCaseIds: recordOf(group)?.expectedCaseIds })) : planDiagnostic.groups },
      groupCollections: Array.isArray(e2eEvidenceRecord?.groupRuns) ? (e2eEvidenceRecord.groupRuns as unknown[]).map((group) => ({
        groupId: recordOf(group)?.groupId, collection: recordOf(group)?.collection })) : [] }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    const groupRuns: unknown[] = Array.isArray(e2eEvidenceRecord?.groupRuns) ? e2eEvidenceRecord.groupRuns as unknown[] : [];
    const groupCollections = groupRuns.map((group) => group && typeof group === "object" && !Array.isArray(group)
      ? (group as Record<string, unknown>).collection : undefined);
    const failedCollection = groupCollections.find((item) => item && typeof item === "object" && !Array.isArray(item)
      && (item as Record<string, unknown>).status === "FAILED");
    const checksAdmission = recordOf(checksInvocation.payload)?.workflowE2EAdmission as { roundId: string; groupRunIds: string[] } | undefined;
    expect(groupRuns.length, "all server-admitted groups must return actual results").toBe(checksAdmission?.groupRunIds.length);
    expect(failedCollection, "the original assertion oracle must record the actual E2E failure").toMatchObject({ status: "FAILED" });
    const completedWorkflow = WorkflowSnapshotSchema.parse((broker.db.get(`DEVTASK#${featureTaskId}`, "META") as { workflow: unknown }).workflow);
    await writeFile(join(root, "feature-checks-terminal-state.json"), `${JSON.stringify({ workflow: completedWorkflow,
      operations: broker.db.find((item) => item.entityType === "OPERATION" && item.workspaceId === featureWorkspaceId)
        .map((item) => ({ id: item.id, workflowMode: item.workflowMode, status: item.status, fence: item.fence })) }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    expect(completedWorkflow.stage).toBe("VERIFY");
    expect(completedWorkflow.state).toBe("BLOCKED");
    expect(completedWorkflow.e2e?.qualifiedRound, "a failed required E2E assertion must not qualify the candidate").toBeUndefined();
    expect(completedWorkflow.e2e?.failedRound, "the broker must persist the exact current failed-round identity").toMatchObject({
      status: "FAILED", candidateDigest: workerCandidate.digest, roundId: checksAdmission?.roundId, groupRunIds: checksAdmission?.groupRunIds,
    });
    expect(workflowSendBackOffered(completedWorkflow), "typed current-round E2E failure must enable normal SendBack").toBe(true);
    expect(sendBackProblems(completedWorkflow).some(({ text }) => text.includes("required E2E verification failed for the current round"))).toBe(true);
      const failedTaskShare = (broker.db.get(`DEVTASK#${featureTaskId}`, "META") as { share: { sharedAt: string } }).share;
      const failedRoundNotice = { id: `${featureTaskId}:workflow:${completedWorkflow.revision}`, kind: "workflow", taskId: featureTaskId,
        workflowRevision: completedWorkflow.revision, at: new Date(Math.max(Date.now(), Date.parse(failedTaskShare.sharedAt))).toISOString() };
      const failedRoundNoticeResult = await notifierHandler({ Records: [{ eventSource: "aws:sqs", messageId: "native-workflow-failed-round", receiptHandle: "native-workflow-failed-round",
        body: JSON.stringify(failedRoundNotice), attributes: { ApproximateReceiveCount: "1" } }] });
      const failedRoundPost = notifierPosts.at(-1);
      expect(failedRoundNoticeResult.batchItemFailures, JSON.stringify(notifierLogs)).toEqual([]);
      const workflowButtons = (failedRoundPost?.blocks ?? []).flatMap((block) => {
        const blockRecord = recordOf(block);
        if (blockRecord?.type !== "actions" || !Array.isArray(blockRecord.elements)) return [];
        return blockRecord.elements.map(recordOf).filter((button) => button?.action_id === "agentx_workflow_send_back");
      });
      expect(workflowButtons).toHaveLength(1);
      expect(recordOf(workflowButtons[0])?.text).toEqual({ type: "plain_text", text: "Send back to coding" });
      expect(JSON.stringify(failedRoundPost?.blocks)).toContain("FAILED");
      const ownerFailedRoundProjection = await loadWorkflowE2EPresentation(broker.brokerInput as never,
        broker.db.get(`DEVTASK#${featureTaskId}`, "META") as never,
        broker.db.find((item) => item.pk === `WORKSPACE#${featureWorkspaceId}` && item.entityType === "OPERATION"), "owner");
      expect(ownerFailedRoundProjection?.shared.actions, "E2E action proposals remain advisory and do not replace normal workflow controls").toEqual([]);
      await writeFile(join(root, "failed-round-owner-workflow-notifier-post.json"), `${JSON.stringify({ post: failedRoundPost,
        advisoryE2EActions: ownerFailedRoundProjection?.shared.actions ?? [],
        normalWorkflowSendBackAvailable: true }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    const reviewOutbox = broker.db.find((item) => item.entityType === "OUTBOX" && item.workspaceId === featureWorkspaceId
      && (item.invocation as { kind?: string; payload?: { workflowMode?: string } } | undefined)?.kind === "task"
      && (item.invocation as { payload?: { workflowMode?: string } } | undefined)?.payload?.workflowMode === "REVIEW")[0];
    expect(reviewOutbox, "a failed required E2E assertion must block review admission").toBeUndefined();
    let finalCandidateDigest = workerCandidate.digest;
    if (reviewOutbox === undefined) {
      await writeFile(join(root, "defect-e2e-red-ordinary-pass.json"), `${JSON.stringify({ operationId: checksInvocation.operationId,
        candidateDigest: workerCandidate.digest, ordinaryCheckResult, groupQualification: groupRuns[0],
        workflow: completedWorkflow, reviewOutbox: null }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      const redTaskResponse = await broker.handler({ version: "2.0", rawPath: `/v1/dev/tasks/${featureTaskId}`, rawQueryString: "",
        headers: { authorization: "Bearer synthetic-owner-session" }, requestContext: { requestId: randomUUID(), http: { method: "GET" } } });
      const redTaskBytes = Buffer.from(redTaskResponse.body, "utf8");
      const redTaskPrimary = await persistOriginalEvidencePrimary({ root, kind: "defect-red-task-detail-http-response", key: `/v1/dev/tasks/${featureTaskId}`,
        bytes: redTaskBytes, producer: "actual-broker-task-detail-route", sourceCandidateDigest: workerCandidate.digest });
      await writeFile(join(root, "defect-red-task-detail-response-capture.json"), `${JSON.stringify({ status: redTaskResponse.statusCode, primary: redTaskPrimary,
        responseSha256: hash(redTaskBytes), byteLength: redTaskBytes.byteLength }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      const redTask = JSON.parse(redTaskResponse.body) as { task?: { e2ePresentation?: { shared?: { e2e?: { status?: string; expectedGroups?: number; receivedGroups?: number } } } } };
      expect(redTaskResponse.statusCode, redTaskResponse.body).toBe(200);
      expect(redTask.task?.e2ePresentation?.shared?.e2e).toMatchObject({ status: "FAILED", expectedGroups: checksAdmission?.groupRunIds.length,
        receivedGroups: checksAdmission?.groupRunIds.length });
      const sendBack = await call(broker.handler, { method: "POST", path: `/v1/dev/tasks/${featureTaskId}/workflow/send-back`,
        headers: { authorization: "Bearer synthetic-owner-session" }, body: { requestId: randomUUID(), expectedRevision: completedWorkflow.revision,
          instructions: "Fix the failed orders renderer assertion while preserving the approved input and expected output." } });
      expect(sendBack.status, JSON.stringify(sendBack.body)).toBe(200);
      const staleTaskResponse = await broker.handler({ version: "2.0", rawPath: `/v1/dev/tasks/${featureTaskId}`, rawQueryString: "",
        headers: { authorization: "Bearer synthetic-owner-session" }, requestContext: { requestId: randomUUID(), http: { method: "GET" } } });
      const staleTaskBytes = Buffer.from(staleTaskResponse.body, "utf8");
      const staleTaskPrimary = await persistOriginalEvidencePrimary({ root, kind: "send-back-stale-task-detail-http-response", key: `/v1/dev/tasks/${featureTaskId}`,
        bytes: staleTaskBytes, producer: "actual-broker-task-detail-route", sourceCandidateDigest: workerCandidate.digest });
      await writeFile(join(root, "send-back-stale-task-detail-response-capture.json"), `${JSON.stringify({ status: staleTaskResponse.statusCode,
        primary: staleTaskPrimary, responseSha256: hash(staleTaskBytes), byteLength: staleTaskBytes.byteLength }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      const staleTask = JSON.parse(staleTaskResponse.body) as { task?: { e2ePresentation?: { shared?: { e2e?: { status?: string; expectedGroups?: number;
        receivedGroups?: number; requiredCriteria?: number; qualifiedCriteria?: number } } } } };
      expect(staleTaskResponse.statusCode, staleTaskResponse.body).toBe(200);
      expect(staleTask.task?.e2ePresentation?.shared?.e2e, "SendBack retains the approved manifest while making the prior failed round non-current")
        .toMatchObject({ status: "UNKNOWN", expectedGroups: checksAdmission?.groupRunIds.length, receivedGroups: 0, qualifiedCriteria: 0 });
      const staleTaskView = (JSON.parse(staleTaskResponse.body) as { task?: DeveloperTaskView }).task;
      expect(staleTaskView).toBeDefined();
      const staleMcpResult = await mcpGetTask(staleTaskView!, featureTaskId);
      expect(staleMcpResult.isError).not.toBe(true);
      expect(staleMcpResult.structuredContent).toMatchObject({ e2e_presentation: {
        view: { e2e: { status: "UNKNOWN", expectedGroups: checksAdmission?.groupRunIds.length, receivedGroups: 0, requiredCriteria: 6 } },
      } });
      await writeFile(join(root, "send-back-stale-task-mcp-tool-response.json"), `${JSON.stringify(staleMcpResult, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      const stalePageResponse = await broker.handler({ version: "2.0", routeKey: "ANY /review/{proxy+}", rawPath: `/review/${featureTaskId}/task/api/state`, rawQueryString: "",
        headers: { cookie: `__Host-agentx_review_session=${ownerSessionId}` }, requestContext: { requestId: randomUUID(), http: { method: "GET" } } });
      const stalePageBytes = Buffer.from(stalePageResponse.body, "utf8");
      const stalePagePrimary = await persistOriginalEvidencePrimary({ root, kind: "send-back-stale-task-page-state-http-response", key: `/review/${featureTaskId}/task/api/state`,
        bytes: stalePageBytes, producer: "actual-broker-task-page-state-route", sourceCandidateDigest: workerCandidate.digest });
      await writeFile(join(root, "send-back-stale-task-page-state-response-capture.json"), `${JSON.stringify({ status: stalePageResponse.statusCode,
        primary: stalePagePrimary, responseSha256: hash(stalePageBytes), byteLength: stalePageBytes.byteLength }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      const stalePageState = JSON.parse(stalePageResponse.body) as { e2ePresentation?: { shared?: { e2e?: { status?: string; expectedGroups?: number;
        receivedGroups?: number; qualifiedCriteria?: number; requiredCriteria?: number } } } };
      expect(stalePageResponse.statusCode, stalePageResponse.body).toBe(200);
      expect(stalePageState.e2ePresentation?.shared?.e2e, "the authenticated page poll must preserve stale obligations without current qualification")
        .toMatchObject({ status: "UNKNOWN", expectedGroups: checksAdmission?.groupRunIds.length, receivedGroups: 0, qualifiedCriteria: 0, requiredCriteria: 6 });
      const retryOutbox = broker.db.find((item) => item.entityType === "OUTBOX" && item.workspaceId === featureWorkspaceId
        && (item.invocation as { kind?: string; payload?: { workflowMode?: string } } | undefined)?.kind === "task"
        && (item.invocation as { payload?: { workflowMode?: string } } | undefined)?.payload?.workflowMode === "IMPLEMENT"
        && (item.invocation as { operationId?: string } | undefined)?.operationId !== implementInvocation.operationId).at(-1);
      expect(retryOutbox, "normal Owner SendBack must enqueue a fresh implementation operation").toBeDefined();
      const retryInvocation = WorkerInvocationSchema.parse(retryOutbox!.invocation);
      const retryCallbacks = createWorkerCallbackSinks({ controlPlaneUrl: "https://cp.example.test", invocation: retryInvocation, fetchImplementation: workerFetch });
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("bash", { command: "cd repo/ordinary-orders && cat > src/index.mjs <<'EOF'\nimport { applyPrice } from './price-rows.mjs';\nexport async function renderOrders(input) { const response = await fetch(`/orders?mode=${encodeURIComponent(input.mode)}`); if (!response.ok) return `refused:${response.status}`; const body = await response.json(); if (!Array.isArray(body.orders)) return 'invalid-data'; return body.orders.map((row) => `<li data-testid=\\\"orders-list\\\">${row.name}</li>`).join(''); }\nexport function priceRows(input) { return { rows: input.rows.map(applyPrice) }; }\nEOF\ngit add -- src/index.mjs && git commit -m 'Fix orders renderer casing regression'" })], { stopReason: "toolUse" }),
        fauxAssistantMessage("I fixed the renderer casing and kept the approved price test."),
      ]);
      const retryResult = await runTaskInvocation(retryInvocation, { rootPath: workerWorkspace, model: FAUX_MODEL,
        piAdapter: createDefaultPiSessionAdapter({ modelRuntime: async () => ({ runtime: modelRuntime, model: FAUX_MODEL }) }),
        eventSink: retryCallbacks.eventSink, artifactSink: retryCallbacks.artifactSink });
      await writeFile(join(root, "send-back-worker-result.json"), `${JSON.stringify({ sendBack: { status: sendBack.status, body: sendBack.body },
        retryOperationId: retryInvocation.operationId, resultCandidate: retryResult.workflowCandidateRepositories,
        sourceExport: retryResult.workflowCandidateSourceExport, head: git(workerRepository, "rev-parse", "HEAD"),
        tree: git(workerRepository, "rev-parse", "HEAD^{tree}"), status: git(workerRepository, "status", "--porcelain") }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      expect(retryResult.workflowCandidateSourceExport, "SendBack must produce a new committed candidate export").toBeDefined();
      expect(retryResult.workflowCandidateSourceExport!.candidate.digest).not.toBe(workerCandidate.digest);
      finalCandidateDigest = retryResult.workflowCandidateSourceExport!.candidate.digest;
      await postWorkerTerminalResult(retryCallbacks, { operationId: retryInvocation.operationId, status: "SUCCEEDED", result: retryResult }, retryInvocation);
      await writeFile(join(root, "send-back-candidate-export-http.json"), `${JSON.stringify({ operationId: retryInvocation.operationId,
        requests: callbackRequests.filter(({ path }) => path.endsWith("/candidate-export")
          && (path.includes(retryInvocation.operationId))), result: callbackRequests.filter(({ path }) => path.endsWith(`/operations/${retryInvocation.operationId}/result`)) }, null, 2)}\n`,
      { mode: 0o600, flag: "wx" });
      const retryChecksOutbox = broker.db.find((item) => item.entityType === "OUTBOX" && item.workspaceId === featureWorkspaceId
        && (item.invocation as { kind?: string; payload?: { workflowMode?: string } } | undefined)?.kind === "task"
        && (item.invocation as { payload?: { workflowMode?: string } } | undefined)?.payload?.workflowMode === "CHECKS").at(-1);
      expect(retryChecksOutbox, "the fixed candidate must receive a fresh server-admitted E2E round").toBeDefined();
      const retryChecksInvocation = WorkerInvocationSchema.parse(retryChecksOutbox!.invocation);
      checksOperationId = retryChecksInvocation.operationId;
      const retryGroupRunIds = recordOf(recordOf(retryChecksInvocation.payload)?.workflowE2EAdmission)?.groupRunIds;
      reverseGroupRunIds = Array.isArray(retryGroupRunIds) ? retryGroupRunIds.filter((id): id is string => typeof id === "string") : [];
      groupFinalizeMode = "concurrent";
      capturePartialGroupView = false;
      groupUploadInitRequests.clear();
      duplicateGroupInitResponses.splice(0);
      conflictingGroupInitResponses.splice(0);
      partialGroupTaskResponses.splice(0);
      const retryChecksCallbacks = createWorkerCallbackSinks({ controlPlaneUrl: "https://cp.example.test", invocation: retryChecksInvocation, fetchImplementation: workerFetch });
      const retryChecksJournal = new OperationJournal(join(root, "retry-checks-worker-journal"));
      const retryChecksWorkerState = createWorkerServerState(retryChecksJournal, {
        execute: async (invocation) => runTaskInvocation(invocation, { rootPath: workerWorkspace, model: FAUX_MODEL,
          eventSink: retryChecksCallbacks.eventSink, artifactSink: retryChecksCallbacks.artifactSink,
          workflowE2EAdmissionReader: retryChecksCallbacks.workflowE2EAdmissionReader, workflowE2EEvidenceSink: retryChecksCallbacks.workflowE2EEvidenceSink,
          workflowE2EEvidenceRoot: evidenceRootForWorker, workflowE2ERuntimeRoot: process.cwd() }),
      }, { onTerminal: async (result, invocation) => postWorkerTerminalResult(retryChecksCallbacks, result, invocation), retrySleep: async () => undefined },
      { publicKey: workerKeys.publicKey, workspaceId: featureWorkspaceId, generation: 1 });
      const retryChecksDelivery = createEc2Delivery({ sessions: { ensureSession: async () => ({ ready: true as const, generation: 1, privateIp: "127.0.0.1" }) },
        binding: async () => runtimeBinding, sign: async (message) => cryptoSign("sha256", message, workerKeys.privateKey),
        post: async (_url, init) => { const response = await handleWorkerRequest(new Request("http://worker/invocations", { method: "POST",
          headers: { authorization: init.authorization, "content-type": "application/json" }, body: init.body }), retryChecksWorkerState);
          return { status: response.status, body: await response.text() }; },
        workerFeatures: async () => ((await (await handleWorkerRequest(new Request("http://worker/ping"), retryChecksWorkerState)).json()) as { invocationFeatures: string[] }).invocationFeatures,
        guardTaskDispatch: checksTaskGuard, progress: async () => undefined });
      const retryChecksDispatcher = createDispatcherHandler({ guardTaskDispatch: checksTaskGuard,
        markDispatching: async (record) => {
          try { await broker.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `WORKSPACE#${record.workspaceId}`, sk: `OPERATION#${record.operationId}` },
            UpdateExpression: "SET #status = :dispatching, updatedAt = :now", ConditionExpression: "#status = :accepted OR #status = :dispatching",
            ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":accepted": "ACCEPTED", ":dispatching": "DISPATCHING", ":now": new Date().toISOString() } })); return true; }
          catch (error) { if (error instanceof Error && error.name === "ConditionalCheckFailedException") return false; throw error; }
        },
        markDelivered: async (id) => { await broker.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `OUTBOX#${id}`, sk: "OUTBOX" },
          UpdateExpression: "SET #status = :delivered, deliveredAt = :now", ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":delivered": "DELIVERED", ":now": new Date().toISOString() } })); },
        markFailed: async () => undefined, deliverEc2: retryChecksDelivery });
      const retryChecksPublisher = createOutboxPublisherHandler({ send: async () => undefined, markQueued: async (id) => {
        await broker.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `OUTBOX#${id}`, sk: "OUTBOX" }, UpdateExpression: "SET #status = :queued",
          ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":queued": "QUEUED" } }));
      } });
      const retryPublisherResult = await retryChecksPublisher({ Records: [{ eventName: "INSERT", dynamodb: { NewImage: marshall(retryChecksOutbox!) } }] as never });
      await writeFile(join(root, "retry-checks-outbox-publish-diagnostic.json"), `${JSON.stringify({ retryChecksOutbox,
        publisherResult: retryPublisherResult, marshalledImage: marshall(retryChecksOutbox!), }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      expect(retryPublisherResult.published, JSON.stringify({ retryChecksOutbox, retryPublisherResult })).toBe(1);
      const retryQueued = broker.db.get(String(retryChecksOutbox!.pk), String(retryChecksOutbox!.sk))!;
      const retryDispatchResult = await retryChecksDispatcher({ Records: [{ messageId: String(retryChecksOutbox!.id), body: JSON.stringify(retryQueued) }] });
      expect(retryDispatchResult.batchItemFailures).toEqual([]);
      for (let index = 0; index < 800; index += 1) {
        const operation = broker.db.get(`WORKSPACE#${featureWorkspaceId}`, `OPERATION#${retryChecksInvocation.operationId}`);
        if (operation?.status === "SUCCEEDED" || operation?.status === "FAILED") break;
        await new Promise((resolveWait) => setTimeout(resolveWait, 25));
      }
      const retryChecksOperation = broker.db.get(`WORKSPACE#${featureWorkspaceId}`, `OPERATION#${retryChecksInvocation.operationId}`);
      expect(retryChecksOperation?.status, JSON.stringify({ retryChecksInvocation, retryDispatchResult, journal: await retryChecksJournal.get(retryChecksInvocation.operationId), retryChecksOperation })).toBe("SUCCEEDED");
      const retryChecksAdmission = recordOf(retryChecksInvocation.payload)?.workflowE2EAdmission as { roundId: string; groupRunIds: string[] } | undefined;
      expect(retryChecksAdmission).toBeDefined();
      expect(concurrentGroupFinalizeArrivals.slice().sort()).toEqual([...retryChecksAdmission!.groupRunIds].sort());
      const retryAcceptedGroupIdsValue: unknown = retryChecksOperation?.workflowE2EGroupRunIds;
      if (!Array.isArray(retryAcceptedGroupIdsValue) || !retryAcceptedGroupIdsValue.every((value: unknown) => typeof value === "string")) {
        throw new Error("accepted group IDs were not stored as a string list");
      }
      const retryAcceptedGroupIds = retryAcceptedGroupIdsValue;
      expect([...retryAcceptedGroupIds].sort()).toEqual([...retryChecksAdmission!.groupRunIds].sort());
      expect(new Set(retryAcceptedGroupIds).size).toBe(retryChecksAdmission!.groupRunIds.length);
      expect(concurrentGroupFinalizeOrder.slice().sort()).toEqual([...retryChecksAdmission!.groupRunIds].sort());
      const retryGroupEvidenceRefs = (retryChecksOperation?.workflowE2EGroupEvidenceRefs ?? []) as Array<{
        groupRunId: string; evidenceRef: { key: string; sha256: string; byteLength: number };
      }>;
      const retryGroupEvidencePrimaries = await Promise.all(retryGroupEvidenceRefs.map(async ({ groupRunId, evidenceRef }) => {
        const primary = await persistOriginalMapPrimary({ root, kind: `retry-feature-checks-group-${groupRunId}`, key: evidenceRef.key,
          objects, producer: "default worker and broker concurrently accepted a distinct immutable group result under one admitted CHECKS round",
          sourceCandidateDigest: retryResult.workflowCandidateSourceExport!.candidate.digest });
        expect(primary.sha256).toBe(evidenceRef.sha256);
        expect(primary.byteLength).toBe(evidenceRef.byteLength);
        return primary;
      }));
      const retryReviewOutboxes = broker.db.find((item) => item.entityType === "OUTBOX" && item.workspaceId === featureWorkspaceId
        && (item.invocation as { kind?: string; payload?: { workflowMode?: string } } | undefined)?.kind === "task"
        && (item.invocation as { payload?: { workflowMode?: string } } | undefined)?.payload?.workflowMode === "REVIEW");
      expect(retryReviewOutboxes).toHaveLength(1);
      await writeFile(join(root, "retry-feature-checks-concurrent-groups.json"), `${JSON.stringify({ operationId: retryChecksInvocation.operationId,
        admissionGroupRunIds: retryChecksAdmission!.groupRunIds, simultaneousFinalizeArrivals: concurrentGroupFinalizeArrivals,
        acceptedGroupRunIds: retryAcceptedGroupIds, acceptedGroupEvidenceRefs: retryGroupEvidenceRefs, evidencePrimaries: retryGroupEvidencePrimaries,
        reviewOutboxCount: retryReviewOutboxes.length }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      const retryEvidenceRef = retryChecksOperation?.workflowE2EEvidenceRef as { key?: string } | undefined;
      const retryEvidenceRaw = typeof retryEvidenceRef?.key === "string" ? objects.get(retryEvidenceRef.key)?.toString("utf8") : undefined;
      const retryEvidence = retryEvidenceRaw === undefined ? undefined : JSON.parse(retryEvidenceRaw) as { groupRuns?: Array<{ collection?: { status?: string } }> };
      expect(retryEvidence?.groupRuns).toHaveLength(retryChecksAdmission!.groupRunIds.length);
      expect(retryEvidence?.groupRuns?.every((run) => run.collection?.status === "PASS")).toBe(true);
      const fixedWorkflow = (broker.db.get(`DEVTASK#${featureTaskId}`, "META") as { workflow: { stage: string; state: string;
        e2e?: { qualifiedRound?: { candidateDigest: string; roundId: string; groupRunIds: string[]; admissionSha256: string; evidenceSha256: string } } } }).workflow;
      expect(fixedWorkflow.e2e?.qualifiedRound?.candidateDigest).toBe(retryResult.workflowCandidateSourceExport?.candidate.digest);
      expect(fixedWorkflow.e2e?.qualifiedRound?.candidateDigest).not.toBe(workerCandidate.digest);
      const taskReadResponse = await broker.handler({ version: "2.0", rawPath: `/v1/dev/tasks/${featureTaskId}`, rawQueryString: "",
        headers: { authorization: "Bearer synthetic-owner-session" }, requestContext: { requestId: randomUUID(), http: { method: "GET" } } });
      const taskReadBytes = Buffer.from(taskReadResponse.body, "utf8");
      const taskReadPrimary = await persistOriginalEvidencePrimary({ root, kind: "task-detail-http-response", key: `/v1/dev/tasks/${featureTaskId}`,
        bytes: taskReadBytes, producer: "actual-broker-task-detail-route", sourceCandidateDigest: String(retryResult.workflowCandidateSourceExport?.candidate.digest ?? "unavailable") });
      await writeFile(join(root, "task-detail-response-capture.json"), `${JSON.stringify({ status: taskReadResponse.statusCode, primary: taskReadPrimary,
        responseSha256: hash(taskReadBytes), byteLength: taskReadBytes.byteLength }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      const taskRead = { status: taskReadResponse.statusCode, body: JSON.parse(taskReadResponse.body) as Record<string, unknown> };
      expect(taskRead.status).toBe(200);
      expect((taskRead.body as { task?: { e2ePresentation?: { shared?: { e2e?: { status?: string; expectedGroups?: number; receivedGroups?: number } }; mcp?: { view?: unknown }; slackBlocks?: unknown[]; pageHtml?: string } } }).task?.e2ePresentation)
        .toMatchObject({ shared: { e2e: { status: "PASS", expectedGroups: retryChecksAdmission?.groupRunIds.length, receivedGroups: retryChecksAdmission?.groupRunIds.length } } });
      const e2ePresentation = (taskRead.body as { task?: { e2ePresentation?: { mcp?: { view?: unknown }; slackBlocks?: unknown[]; pageHtml?: string } } }).task?.e2ePresentation;
      expect(e2ePresentation?.slackBlocks?.length).toBeGreaterThan(0);
      expect(e2ePresentation?.pageHtml).toContain("E2E checks");
      expect(e2ePresentation?.mcp?.view).toBeDefined();
      const storedFeatureRecord = broker.db.get(`DEVTASK#${featureTaskId}`, "META") as never;
      const storedFeatureOperations = broker.db.find((item) => item.pk === `WORKSPACE#${featureWorkspaceId}` && item.entityType === "OPERATION");
      const notifierProjection = await loadWorkflowE2EPresentation(broker.brokerInput as never,
        storedFeatureRecord, storedFeatureOperations, "viewer");
      expect(notifierProjection?.slackBlocks).toEqual(e2ePresentation?.slackBlocks);
      const storedAfterPass = broker.db.get(`DEVTASK#${featureTaskId}`, "META") as { workflow: { revision: number }; share: { sharedAt: string; threadTs: string } };
      const workflowNotice = { id: `${featureTaskId}:workflow:${storedAfterPass.workflow.revision}`, kind: "workflow", taskId: featureTaskId,
        workflowRevision: storedAfterPass.workflow.revision, at: new Date(Math.max(Date.now(), Date.parse(storedAfterPass.share.sharedAt))).toISOString() };
      const workflowDelivery = await notifierHandler({ Records: [{ eventSource: "aws:sqs", messageId: "native-workflow", receiptHandle: "native-workflow",
        body: JSON.stringify(workflowNotice), attributes: { ApproximateReceiveCount: "1" } }] });
      expect(workflowDelivery.batchItemFailures, JSON.stringify(notifierLogs)).toEqual([]);
      expect(notifierE2EBlocks).toEqual(e2ePresentation?.slackBlocks);
      expect(notifierPosts.at(-1)?.blocks).toEqual(expect.arrayContaining(notifierE2EBlocks ?? []));
      await writeFile(join(root, "fresh-pass-task-slack-notifier-post.json"), `${JSON.stringify({ post: notifierPosts.at(-1), e2eBlocks: notifierE2EBlocks }, null, 2)}\n`,
        { mode: 0o600, flag: "wx" });
      const actualTaskView = (taskRead.body as { task: DeveloperTaskView }).task;
      const mcpTaskResult = await mcpGetTask(actualTaskView, featureTaskId);
      expect(mcpTaskResult.isError).not.toBe(true);
      expect(mcpTaskResult.structuredContent).toMatchObject({ e2e_presentation: {
        view: { e2e: { status: "PASS", expectedGroups: retryChecksAdmission?.groupRunIds.length, qualifiedCriteria: 6 } },
      } });
      await writeFile(join(root, "fresh-pass-task-mcp-tool-response.json"), `${JSON.stringify(mcpTaskResult, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      const greenPageResponse = await broker.handler({ version: "2.0", routeKey: "ANY /review/{proxy+}", rawPath: `/review/${featureTaskId}/task/api/state`, rawQueryString: "",
        headers: { cookie: `__Host-agentx_review_session=${ownerSessionId}` }, requestContext: { requestId: randomUUID(), http: { method: "GET" } } });
      const greenPageBytes = Buffer.from(greenPageResponse.body, "utf8");
      const greenPagePrimary = await persistOriginalEvidencePrimary({ root, kind: "fresh-pass-task-page-state-http-response", key: `/review/${featureTaskId}/task/api/state`,
        bytes: greenPageBytes, producer: "actual-broker-task-page-state-route", sourceCandidateDigest: String(retryResult.workflowCandidateSourceExport?.candidate.digest ?? "unavailable") });
      await writeFile(join(root, "fresh-pass-task-page-state-response-capture.json"), `${JSON.stringify({ status: greenPageResponse.statusCode,
        primary: greenPagePrimary, responseSha256: hash(greenPageBytes), byteLength: greenPageBytes.byteLength }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      const greenPageState = JSON.parse(greenPageResponse.body) as { e2ePresentation?: { shared?: { e2e?: { status?: string; expectedGroups?: number; receivedGroups?: number } } } };
      expect(greenPageResponse.statusCode, greenPageResponse.body).toBe(200);
      expect(greenPageState.e2ePresentation?.shared?.e2e).toMatchObject({ status: "PASS", expectedGroups: retryChecksAdmission?.groupRunIds.length,
        receivedGroups: retryChecksAdmission?.groupRunIds.length });
      await writeFile(join(root, "send-back-fresh-round.json"), `${JSON.stringify({ retryOperationId: retryInvocation.operationId,
        retryCandidate: retryResult.workflowCandidateSourceExport?.candidate, checksOperationId: retryChecksInvocation.operationId,
        admission: retryChecksAdmission, evidenceRef: retryChecksOperation?.workflowE2EEvidenceRef,
        workflow: fixedWorkflow, dispatch: retryDispatchResult }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    }
    const passedReviewOutbox = reviewOutbox ?? broker.db.find((item) => item.entityType === "OUTBOX" && item.workspaceId === featureWorkspaceId
      && (item.invocation as { kind?: string; payload?: { workflowMode?: string } } | undefined)?.kind === "task"
      && (item.invocation as { payload?: { workflowMode?: string } } | undefined)?.payload?.workflowMode === "REVIEW").at(-1);
    expect(passedReviewOutbox, "a passing fresh E2E round must admit review").toBeDefined();
    const reviewInvocation = WorkerInvocationSchema.parse(passedReviewOutbox!.invocation);
    const reviewCallbacks = createWorkerCallbackSinks({ controlPlaneUrl: "https://cp.example.test", invocation: reviewInvocation, fetchImplementation: workerFetch });
    const reviewJournal = new OperationJournal(join(root, "review-worker-journal"));
    const { modelRuntime: reviewModelRuntime, faux: reviewFaux } = await fauxModelRuntime();
    // The scripted provider follows the actual role prompt, so both independent review
    // sessions receive a response even if the adapter makes an additional model request.
    // Keep the role in the transcript as the selector; never infer review outcomes from call order.
    const reviewTransportObservations: string[] = [];
    const reviewResponse: Parameters<typeof reviewFaux.setResponses>[0][number] = (context) => {
      const transcript = JSON.stringify(context.messages);
      const role = transcript.match(/Review role: (CODE|SECURITY)/)?.[1];
      if (role === "CODE" || role === "SECURITY") {
        reviewTransportObservations.push(role);
        return fauxAssistantMessage('{"findings":[]}');
      }
      if (transcript.includes("Perform the required read-only critic and security reviews for the task.")) {
        reviewTransportObservations.push("workflow-review-request");
        return fauxAssistantMessage("I will perform the requested read-only reviews.");
      }
      throw new Error(`scripted review transport received an unrecognized prompt: ${transcript.slice(-1200)}`);
    };
    reviewFaux.setResponses([reviewResponse, reviewResponse, reviewResponse]);
    const reviewWorkerState = createWorkerServerState(reviewJournal, {
      execute: async (invocation) => runTaskInvocation(invocation, {
        rootPath: workerWorkspace, model: FAUX_MODEL, piAdapter: createDefaultPiSessionAdapter({ modelRuntime: async () => ({ runtime: reviewModelRuntime, model: FAUX_MODEL }) }),
        eventSink: reviewCallbacks.eventSink, artifactSink: reviewCallbacks.artifactSink,
      }),
    }, { onTerminal: async (result, invocation) => postWorkerTerminalResult(reviewCallbacks, result, invocation), retrySleep: async () => undefined },
    { publicKey: workerKeys.publicKey, workspaceId: featureWorkspaceId, generation: 1 });
    const reviewDelivery = createEc2Delivery({
      sessions: { ensureSession: async () => ({ ready: true as const, generation: 1, privateIp: "127.0.0.1" }) },
      binding: async () => runtimeBinding,
      sign: async (message) => cryptoSign("sha256", message, workerKeys.privateKey),
      post: async (_url, init) => {
        const response = await handleWorkerRequest(new Request("http://worker/invocations", { method: "POST",
          headers: { authorization: init.authorization, "content-type": "application/json" }, body: init.body }), reviewWorkerState);
        return { status: response.status, body: await response.text() };
      },
      workerFeatures: async () => ((await (await handleWorkerRequest(new Request("http://worker/ping"), reviewWorkerState)).json()) as { invocationFeatures: string[] }).invocationFeatures,
      guardTaskDispatch: checksTaskGuard, progress: async () => undefined,
    });
    const reviewDispatcher = createDispatcherHandler({
      guardTaskDispatch: checksTaskGuard,
      markDispatching: async (record) => {
        try {
          await broker.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `WORKSPACE#${record.workspaceId}`, sk: `OPERATION#${record.operationId}` },
            UpdateExpression: "SET #status = :dispatching, updatedAt = :now", ConditionExpression: "#status = :accepted OR #status = :dispatching",
            ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":accepted": "ACCEPTED", ":dispatching": "DISPATCHING", ":now": new Date().toISOString() } }));
          return true;
        } catch (error) { if (error instanceof Error && error.name === "ConditionalCheckFailedException") return false; throw error; }
      },
      markDelivered: async (id) => { await broker.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `OUTBOX#${id}`, sk: "OUTBOX" },
        UpdateExpression: "SET #status = :delivered, deliveredAt = :now", ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":delivered": "DELIVERED", ":now": new Date().toISOString() } })); },
      markFailed: async () => undefined, deliverEc2: reviewDelivery,
    });
    const reviewPublisher = createOutboxPublisherHandler({ send: async () => undefined, markQueued: async (id) => {
      await broker.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `OUTBOX#${id}`, sk: "OUTBOX" },
        UpdateExpression: "SET #status = :queued", ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":queued": "QUEUED" } }));
    } });
    expect((await reviewPublisher({ Records: [{ eventName: "INSERT", dynamodb: { NewImage: marshall(passedReviewOutbox!) } }] as never })).published).toBe(1);
    const queuedReviewOutbox = broker.db.get(String(passedReviewOutbox!.pk), String(passedReviewOutbox!.sk))!;
    const reviewDispatch = await reviewDispatcher({ Records: [{ messageId: String(passedReviewOutbox!.id), body: JSON.stringify(queuedReviewOutbox) }] });
    expect(reviewDispatch.batchItemFailures).toEqual([]);
    for (let index = 0; index < 800; index += 1) {
      const operation = broker.db.get(`WORKSPACE#${featureWorkspaceId}`, `OPERATION#${reviewInvocation.operationId}`);
      if (operation?.status === "SUCCEEDED" || operation?.status === "FAILED") break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    const completedReviewOperation = broker.db.get(`WORKSPACE#${featureWorkspaceId}`, `OPERATION#${reviewInvocation.operationId}`);
    const finalTask = broker.db.get(`DEVTASK#${featureTaskId}`, "META") as { workflow: { stage: string; state: string; candidate?: { digest: string };
      reviews?: Array<{ role: string; status: string; candidateDigest: string }> } };
    await writeFile(join(root, "feature-review-terminal-state.json"), `${JSON.stringify({ reviewInvocation, reviewDispatch,
      scriptedTransport: { callCount: reviewFaux.state.callCount, pendingResponses: reviewFaux.getPendingResponseCount() }, journal: await reviewJournal.get(reviewInvocation.operationId),
      reviewTransportObservations,
      completedReviewOperation, workflow: finalTask.workflow, callbacks: callbackRequests.filter(({ path }) => path.includes(reviewInvocation.operationId)) }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    expect(completedReviewOperation?.status, JSON.stringify({ completedReviewOperation, journal: await reviewJournal.get(reviewInvocation.operationId) })).toBe("SUCCEEDED");
    expect(finalTask.workflow.stage).toBe("PULL_REQUEST");
    expect(finalTask.workflow.state).toBe("READY");
    expect(finalTask.workflow.reviews?.filter((review) => review.status === "PASS" && review.candidateDigest === finalCandidateDigest).map((review) => review.role).sort())
      .toEqual(["CRITIC", "SECURITY"]);

    const recoveryResponse = await broker.handler({ source: "agentx.workflow-dispatch-recovery" });
    const publishDispatchRows = broker.db.find((item) => item.pk === "WORKFLOW_DISPATCH" && item.taskId === featureTaskId);
    const publishOutbox = broker.db.find((item) => item.entityType === "OUTBOX" && item.workspaceId === featureWorkspaceId
      && (item.invocation as { kind?: string } | undefined)?.kind === "publish").at(-1);
    expect(publishOutbox, JSON.stringify({ recoveryResponse: recoveryResponse.body, workflow: finalTask.workflow, publishDispatchRows }))
      .toBeDefined();
    const publishInvocation = WorkerInvocationSchema.parse(publishOutbox!.invocation);
    expect(publishInvocation.kind).toBe("publish");
    const publishCallbacks = createWorkerCallbackSinks({ controlPlaneUrl: "https://cp.example.test", invocation: publishInvocation, fetchImplementation: workerFetch });
    const localPushTargets: Array<{ url: string; branch: string; commit: string; stdout: string }> = [];
    const localGitRunner = async (args: readonly string[], options: { timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv; cwd?: string }) => {
      const remoteIndex = args.indexOf("https://github.com/acme/ordinary-orders.git");
      if (remoteIndex < 0 || args[remoteIndex] !== "https://github.com/acme/ordinary-orders.git") throw new Error("local publication fixture refuses an unregistered push URL");
      const refspec = args[remoteIndex + 1];
      const match = refspec?.match(/^([a-f0-9]{40,64}):refs\/heads\/([A-Za-z0-9._/-]+)$/u);
      if (!match?.[1] || !match[2]) throw new Error("local publication fixture refuses an unbound push refspec");
      const rewritten = ["-c", "protocol.file.allow=always", ...args]; rewritten[remoteIndex + 2] = localBareRemote;
      const stdout = execFileSync("git", rewritten, { cwd: options.cwd, env: options.env, encoding: "utf8", timeout: options.timeout, maxBuffer: options.maxBuffer });
      localPushTargets.push({ url: "https://github.com/acme/ordinary-orders.git", branch: match[2], commit: match[1], stdout });
      return { stdout, stderr: "" };
    };
    const publishJournal = new OperationJournal(join(root, "publish-worker-journal"));
    const publishWorkerState = createWorkerServerState(publishJournal, {
      execute: async (invocation) => {
        if (invocation.kind !== "publish") throw new Error("publication worker received a non-publication invocation");
        return publishWorkspace({ rootPath: workerWorkspace, invocation,
          credentialProvider: createRepositoryCredentialProvider({ controlPlaneUrl: "https://cp.example.test", invocation, fetchImplementation: workerFetch }),
          pullRequestSink: publishCallbacks.pullRequestSink, codeBuildSink: publishCallbacks.codeBuildSink,
          stopWorkspaceProcesses: async () => ({ stopped: 0 }), sweepWorkspaceContainers: async () => ({ removed: 0 }), run: localGitRunner });
      },
    }, { onTerminal: async (result, invocation) => postWorkerTerminalResult(publishCallbacks, result, invocation), retrySleep: async () => undefined },
    { publicKey: workerKeys.publicKey, workspaceId: featureWorkspaceId, generation: 1 });
    const publishTaskGuard = async (record: Parameters<typeof guardTaskDispatch>[1]) => {
      const admission = createTaskAuthorityAdmission({ now: Date.now, lambdaRemainingMs: 60_000 });
      try { return await guardTaskDispatch({ documentClient: broker.db, tableName: "state", admission }, record); }
      finally { admission.close(); }
    };
    const publishDelivery = createEc2Delivery({
      sessions: { ensureSession: async () => ({ ready: true as const, generation: 1, privateIp: "127.0.0.1" }) },
      binding: async () => runtimeBinding,
      sign: async (message) => cryptoSign("sha256", message, workerKeys.privateKey),
      post: async (_url, init) => {
        const response = await handleWorkerRequest(new Request("http://worker/invocations", { method: "POST",
          headers: { authorization: init.authorization, "content-type": "application/json" }, body: init.body }), publishWorkerState);
        return { status: response.status, body: await response.text() };
      },
      workerFeatures: async () => ((await (await handleWorkerRequest(new Request("http://worker/ping"), publishWorkerState)).json()) as { invocationFeatures: string[] }).invocationFeatures,
      guardTaskDispatch: publishTaskGuard, progress: async () => undefined,
    });
    const publishDispatcher = createDispatcherHandler({
      guardTaskDispatch: publishTaskGuard,
      markDispatching: async (record) => {
        try {
          await broker.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `WORKSPACE#${record.workspaceId}`, sk: `OPERATION#${record.operationId}` },
            UpdateExpression: "SET #status = :dispatching, updatedAt = :now", ConditionExpression: "#status = :accepted OR #status = :dispatching",
            ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":accepted": "ACCEPTED", ":dispatching": "DISPATCHING", ":now": new Date().toISOString() } }));
          return true;
        } catch (error) { if (error instanceof Error && error.name === "ConditionalCheckFailedException") return false; throw error; }
      },
      markDelivered: async (id) => { await broker.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `OUTBOX#${id}`, sk: "OUTBOX" },
        UpdateExpression: "SET #status = :delivered, deliveredAt = :now", ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":delivered": "DELIVERED", ":now": new Date().toISOString() } })); },
      markFailed: async () => undefined, deliverEc2: publishDelivery,
    });
    const publishPublisher = createOutboxPublisherHandler({ send: async () => undefined, markQueued: async (id) => {
      await broker.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `OUTBOX#${id}`, sk: "OUTBOX" },
        UpdateExpression: "SET #status = :queued", ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":queued": "QUEUED" } }));
    } });
    const publishPayload = publishInvocation.payload as unknown as { headBranch: string; candidateCommitSha: string; candidateTreeSha: string };
    const prePublishTask = broker.db.get(`DEVTASK#${featureTaskId}`, "META") as { startingRevision: number; workflow: { stage: string; state: string;
      candidate: { digest: string; repositories: Array<{ repositoryId: string; commitSha: string; treeSha: string; baseCommitSha?: string }> };
      reviewBase?: Array<{ repositoryId: string; baseCommitSha: string }>; pullRequests?: Array<{ headSha?: string; number?: number }> } };
    expect(prePublishTask.workflow.stage).toBe("PULL_REQUEST");
    expect(prePublishTask.workflow.state).toBe("READY");
    // The normal enrolled loop joins and publishes the same reviewed candidate before native PUBLISH;
    // native publication then reconciles that exact existing PR and branch.
    git(workerRepository, "branch", "-m", publishPayload.headBranch);
    const publishedCandidateRepository = prePublishTask.workflow.candidate.repositories.find((repository) => repository.repositoryId === "ordinary-orders")!;
    const publishedBaseCommit = publishedCandidateRepository.baseCommitSha
      ?? prePublishTask.workflow.reviewBase?.find((item) => item.repositoryId === publishedCandidateRepository.repositoryId)?.baseCommitSha;
    expect(publishedBaseCommit, "current published candidate must retain its approved base binding").toBeDefined();
    const hostBaseCommit = git(localBareRemote, "rev-parse", "refs/heads/main^{commit}");
    expect(hostBaseCommit, "the host derives its base from the retained local origin branch").toBe(publishedBaseCommit);
    git(workerRepository, "update-ref", "refs/remotes/origin/main", hostBaseCommit);
    const publicationJoinSubject = { projectName: "ordinary-orders", projectRevision: prePublishTask.startingRevision, repositoryId: 740001,
      commitSha: publishedCandidateRepository.commitSha, treeSha: publishedCandidateRepository.treeSha, baseCommitSha: publishedBaseCommit! };
    const publicationJoinRequest = { taskRef: featureTaskId, subject: publicationJoinSubject,
      sourceBindingRef: `cli-source:v1:${hash(Buffer.from("synthetic-host-source-binding"))}` };
    const joinRoutePath = `/v1/dev/tasks/${featureTaskId}/e2e-publication-context`;
    const captureJoin = async (label: string, input: unknown) => {
      const requestBytes = Buffer.from(JSON.stringify(input), "utf8");
      const requestPrimary = await persistOriginalEvidencePrimary({ root, kind: `publication-context-${label}-request`, key: joinRoutePath,
        bytes: requestBytes, producer: "actual test HTTP request body sent to authenticated broker handler", sourceCandidateDigest: prePublishTask.workflow.candidate.digest });
      const response = await broker.handler({ version: "2.0", rawPath: joinRoutePath, rawQueryString: "", headers: {
        authorization: "Bearer synthetic-owner-session", "content-type": "application/json" }, body: requestBytes.toString("utf8"),
        requestContext: { requestId: randomUUID(), http: { method: "POST" } } });
      const responseBytes = Buffer.from(response.body, "utf8");
      const responsePrimary = await persistOriginalEvidencePrimary({ root, kind: `publication-context-${label}-response`, key: joinRoutePath,
        bytes: responseBytes, producer: "exact broker HTTP response body bytes before parsing or assertions", sourceCandidateDigest: prePublishTask.workflow.candidate.digest });
      return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown>, requestPrimary, responsePrimary,
        responseSha256: hash(responseBytes), responseByteLength: responseBytes.byteLength };
    };
    const publicationJoinSubjectForCli = publicationJoinSubject;
    const mismatchedJoin = await captureJoin("candidate-mismatch", { ...publicationJoinRequest,
      subject: { ...publicationJoinSubject, commitSha: "0".repeat(40) } });
    const joinBeforeInvalid = { operationCount: broker.db.find((row) => row.entityType === "OPERATION").length,
      outboxCount: broker.db.find((row) => row.entityType === "OUTBOX").length };
    const malformedJoin = await captureJoin("malformed-locator", { ...publicationJoinRequest, sourceBindingRef: "untrusted" });
    const joinAfterInvalid = { operationCount: broker.db.find((row) => row.entityType === "OPERATION").length,
      outboxCount: broker.db.find((row) => row.entityType === "OUTBOX").length };
    const cliHome = join(root, "actual-cli-home");
    await mkdir(cliHome, { recursive: true, mode: 0o700 });
    const cliIssuer = "https://identity.control.example/";
    const cliControlPlane = "https://cp.example.test";
    await saveDeveloperEnvironment(cliHome, "staging", { url: cliControlPlane, issuer: cliIssuer,
      tokenEndpoint: `${cliControlPlane}/token`, revocationEndpoint: `${cliControlPlane}/revoke` });
    const cliTokenStore = new InMemoryTokenStore();
    await cliTokenStore.set(developerTokenKey(cliIssuer), { accessToken: "synthetic-owner-session", expiresAt: Date.now() + 60 * 60_000 });
    const registrationResponse = adminResults.find(({ path, status }) => path === "/v1/admin/projects" && status === 201)?.body;
    expect(registrationResponse, "the native host receipt must use the successful ordinary project registration response").toBeDefined();
    const registeredDefinition = ProjectDefinitionSchema.parse(registered?.definition);
    const ghExec: Exec = async (command, args, options) => {
      if (command !== "gh") return realExec(command, args, options);
      if (args[0] === "repo" && args[1] === "view") return { code: 0, stdout: "acme/ordinary-orders\n", stderr: "" };
      if (args[0] === "api" && args[1] === "user") return { code: 0, stdout: "maya\n", stderr: "" };
      if (args[0] === "api" && args[1] === "repos/acme/ordinary-orders" && args.at(-1) === ".id") return { code: 0, stdout: "740001\n", stderr: "" };
      if (args[0] === "api" && args[1] === "repos/acme/ordinary-orders" && args.at(-1) === ".default_branch") return { code: 0, stdout: "main\n", stderr: "" };
      if (args[0] === "api" && args[1] === "repos/acme/ordinary-orders/issues/42" && args.at(-1) === ".state") return { code: 0, stdout: "open\n", stderr: "" };
      if (args[0] === "api" && args[1] === "repos/acme/ordinary-orders/pulls/42") return { code: 1, stdout: "", stderr: "HTTP 404: Not Found" };
      return { code: 1, stdout: "", stderr: `unexpected GitHub identity lookup: ${args.join(" ")}` };
    };
    const recordedHostEnrollment = await recordRegisteredLoopEnrollment({ home: cliHome, env: "staging", controlPlaneUrl: cliControlPlane,
      definition: registeredDefinition, response: registrationResponse, cwd: workerRepository, exec: ghExec });
    expect(recordedHostEnrollment, "native enrollment is derived from the real successful registration and current GitHub identity").toEqual({ recorded: true, repository: "acme/ordinary-orders" });
    const cliLoopStore = new LoopStore(join(cliHome, ".rovara", "loop"));
    const loopAddOutput: string[] = [];
    const loopAddExit = await executeCli(["--env", "staging", "loop", "add", workerRepository], {
      environments: { home: cliHome }, tokenStore: cliTokenStore, loop: { exec: ghExec },
      stdout: { write: (value) => loopAddOutput.push(value) }, stderr: { write: (value) => loopAddOutput.push(value) },
    });
    expect(loopAddExit, loopAddOutput.join(" ")).toBe(0);
    expect(await cliLoopStore.repos()).toEqual([{ repo: "acme/ordinary-orders", path: workerRepository }]);
    const cliCandidateBranch = git(workerRepository, "symbolic-ref", "--short", "HEAD");
    const capturedCliCandidate = await captureCandidate(realExec, workerRepository, cliCandidateBranch, hostBaseCommit);
    expect(capturedCliCandidate).toMatchObject({ commitSha: publicationJoinSubjectForCli.commitSha, treeSha: publicationJoinSubjectForCli.treeSha,
      baseCommitSha: publicationJoinSubjectForCli.baseCommitSha });
    const issueNumber = 42;
    const cliJoinRequests: Array<{ url: string; requestBytes: string; responseStatus: number; responseBytes: string }> = [];
    const cliTaskReads: Array<{ url: string; requestPrimary: unknown; responsePrimary: unknown; responseStatus: number; responseSha256: string; responseByteLength: number }> = [];
    const cliFetch: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const method = init?.method ?? "GET";
      if (url.origin !== cliControlPlane || !url.pathname.startsWith("/v1/dev/tasks/")) return new Response("unexpected CLI network request", { status: 599 });
      const requestBytes = typeof init?.body === "string" ? Buffer.from(init.body, "utf8") : Buffer.alloc(0);
      const response = await broker.handler({ version: "2.0", rawPath: url.pathname, rawQueryString: url.search.slice(1),
        headers: Object.fromEntries(new Headers(init?.headers).entries()), ...(requestBytes.byteLength === 0 ? {} : { body: requestBytes.toString("utf8") }),
        requestContext: { requestId: randomUUID(), http: { method } } });
      const responseBytes = Buffer.from(response.body, "utf8");
      if (url.pathname.endsWith("/e2e-publication-context")) {
        const requestOrdinal = cliJoinRequests.length + 1;
        const requestPrimary = await persistOriginalEvidencePrimary({ root, kind: "actual-cli-publication-join-http-request", key: `${url.pathname}#${requestOrdinal}`,
          bytes: requestBytes, producer: "exact authenticated CLI POST body sent to the broker", sourceCandidateDigest: prePublishTask.workflow.candidate.digest });
        const responsePrimary = await persistOriginalEvidencePrimary({ root, kind: "actual-cli-publication-join-http-response", key: `${url.pathname}#${requestOrdinal}`,
          bytes: responseBytes, producer: "exact broker response body returned to the actual CLI transport", sourceCandidateDigest: prePublishTask.workflow.candidate.digest });
        cliJoinRequests.push({ url: url.href, requestBytes: requestBytes.toString("utf8"), responseStatus: response.statusCode,
          responseBytes: responseBytes.toString("utf8"), requestPrimary, responsePrimary } as never);
      }
      if (method === "GET" && url.pathname === `/v1/dev/tasks/${featureTaskId}`) {
        const readOrdinal = cliTaskReads.length + 1;
        const requestPrimary = await persistOriginalEvidencePrimary({ root, kind: "actual-cli-native-task-read-http-request", key: `${url.pathname}#${readOrdinal}`,
          bytes: requestBytes, producer: "exact authenticated CLI GET task request body bytes before broker handling", sourceCandidateDigest: prePublishTask.workflow.candidate.digest });
        const responsePrimary = await persistOriginalEvidencePrimary({ root, kind: "actual-cli-native-task-read-http-response", key: `${url.pathname}#${readOrdinal}`,
          bytes: responseBytes, producer: "exact authenticated broker task-view response body bytes before CLI parsing or assertions", sourceCandidateDigest: prePublishTask.workflow.candidate.digest });
        cliTaskReads.push({ url: url.href, requestPrimary, responsePrimary, responseStatus: response.statusCode,
          responseSha256: hash(responseBytes), responseByteLength: responseBytes.byteLength });
      }
      return new Response(responseBytes, { status: response.statusCode, headers: { "content-type": "application/json" } });
    };
    const cliOutput: string[] = [];
    const cliExit = await executeCli(["--env", "staging", "loop", "enroll", "acme/ordinary-orders", "--task", featureTaskId,
      "--issue", String(issueNumber), "--worktree", workerRepository], { environments: { home: cliHome }, tokenStore: cliTokenStore, fetchImplementation: cliFetch, loop: { exec: ghExec },
      stdout: { write: (value) => cliOutput.push(value) }, stderr: { write: (value) => cliOutput.push(value) } });
    const joinedEnrollment = (await cliLoopStore.enrollments()).find((entry) => entry.kind === "registered");
    const adoptedCliRoute = await cliLoopStore.item("acme/ordinary-orders", issueNumber);
    expect(cliExit, cliOutput.join("\\n")).toBe(0);
    expect(cliJoinRequests).toHaveLength(1);
    expect(cliTaskReads).toHaveLength(1);
    expect(cliTaskReads[0]).toMatchObject({ responseStatus: 200 });
    const firstJoinRequest = recordOf(JSON.parse(cliJoinRequests[0]!.requestBytes));
    expect(firstJoinRequest).toMatchObject({ taskRef: featureTaskId, subject: publicationJoinSubjectForCli });
    expect(firstJoinRequest?.sourceBindingRef).toMatch(/^cli-source:v1:[a-f0-9]{64}$/u);
    expect(recordOf(JSON.parse(cliJoinRequests[0]!.responseBytes))).toMatchObject({ status: "READY", subject: publicationJoinSubjectForCli,
      candidateDigest: prePublishTask.workflow.candidate.digest });
    expect(joinedEnrollment?.kind).toBe("registered");
    expect((joinedEnrollment as { taskRef?: string } | undefined)?.taskRef).toBe(featureTaskId);
    expect(adoptedCliRoute).toMatchObject({ repo: "acme/ordinary-orders", issue: issueNumber, step: "publish",
      worktree: { path: workerRepository, branch: cliCandidateBranch }, nativeImport: { taskRef: featureTaskId } });
    expect(adoptedCliRoute).not.toHaveProperty("checksCandidate");
    expect(adoptedCliRoute).not.toHaveProperty("reviewsCandidate");
    const localIssueLabels = new Set<string>();
    const daemonExec: Exec = async (command, args, options) => {
      if (command === "git" && args.includes("push")) {
        const worktreeArgument = args.indexOf("-C");
        if (worktreeArgument < 0 || args[worktreeArgument + 1] !== workerRepository || args.at(-1) !== cliCandidateBranch) {
          throw new Error("loop fixture refuses an unowned Git publication");
        }
        const remoteIndex = args.indexOf("origin");
        if (remoteIndex < 0) throw new Error("loop fixture requires the registered origin remote");
        const rewritten = [...args]; rewritten[remoteIndex] = localBareRemote;
        return realExec(command, rewritten, options);
      }
      if (command !== "gh") return realExec(command, args, options);
      if (args[0] === "repo" && args[1] === "view") return { code: 0, stdout: "acme/ordinary-orders\n", stderr: "" };
      if (args[0] === "api" && args[1] === "user") return { code: 0, stdout: "maya\n", stderr: "" };
      if (args[0] === "api" && args[1] === "repos/acme/ordinary-orders" && args.at(-1) === ".id") return { code: 0, stdout: "740001\n", stderr: "" };
      if (args[0] === "api" && args[1] === "repos/acme/ordinary-orders" && args.at(-1) === ".default_branch") return { code: 0, stdout: "main\n", stderr: "" };
      if (args[0] === "api" && args[1] === "--paginate") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "api" && args[1] === "repos/acme/ordinary-orders/issues/42" && args.at(-1) === ".state") return { code: 0, stdout: "open\n", stderr: "" };
      if (args[0] === "api" && args[1] === "repos/acme/ordinary-orders/issues/42" && args.at(-1) === ".title") return { code: 0, stdout: "Ordinary orders task\n", stderr: "" };
      if (args[0] === "api" && args[1] === "repos/acme/ordinary-orders/issues/42/labels" && args.length === 4 && args[2] === "--jq" && args[3] === ".[].name") {
        return { code: 0, stdout: [...localIssueLabels].join("\n"), stderr: "" };
      }
      if (args[0] === "api" && args[1] === "-X" && args[2] === "POST" && args[3] === "repos/acme/ordinary-orders/issues/42/comments" && args[4] === "--input" && args[5] === "-") {
        const body = JSON.parse(options?.input ?? "{}") as { body?: unknown };
        if (typeof body.body !== "string" || body.body.length > 20_000) throw new Error("loop fixture refuses an invalid bounded issue comment");
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "api" && args[1] === "-X" && args[2] === "POST" && args[3] === "repos/acme/ordinary-orders/issues/42/labels" && args[4] === "--input" && args[5] === "-") {
        const body = JSON.parse(options?.input ?? "{}") as { labels?: unknown };
        if (!Array.isArray(body.labels) || body.labels.some((label) => typeof label !== "string" || !label.startsWith("rovara:"))) {
          throw new Error("loop fixture refuses an unregistered issue label");
        }
        for (const label of body.labels.filter((candidate): candidate is string => typeof candidate === "string")) localIssueLabels.add(label);
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "label" && args[1] === "create") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "pr" && args[1] === "list" && args.includes("--head")) {
        const found = [...localPullRequests.entries()].find(([, pr]) => pr.headBranch === args[args.indexOf("--head") + 1]);
        return { code: 0, stdout: found === undefined ? "" : `${found[0]} https://github.com/acme/ordinary-orders/pull/${found[0]}\n`, stderr: "" };
      }
      if (args[0] === "pr" && args[1] === "create") {
        if (args[args.indexOf("--repo") + 1] !== "acme/ordinary-orders") throw new Error("loop fixture refuses a pull request outside the registered repository");
        const headBranch = args[args.indexOf("--head") + 1]!;
        const baseBranch = args[args.indexOf("--base") + 1]!;
        const number = 1;
        localPullRequests.set(number, { headBranch, baseBranch, title: "Ordinary orders task", body: options?.input ?? "" });
        return { code: 0, stdout: "https://github.com/acme/ordinary-orders/pull/1\n", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: `unexpected loop daemon GitHub command: ${args.join(" ")}` };
    };
    const daemonOutput: string[] = [];
    const daemonRun = executeCli(["--env", "staging", "loop", "run"], { environments: { home: cliHome }, tokenStore: cliTokenStore,
      fetchImplementation: cliFetch, loop: { exec: daemonExec }, stdout: { write: (value) => daemonOutput.push(value) }, stderr: { write: (value) => daemonOutput.push(value) } });
    let daemonItem: Awaited<ReturnType<typeof cliLoopStore.item>> | undefined;
    for (let index = 0; index < 400; index += 1) {
      daemonItem = await cliLoopStore.item("acme/ordinary-orders", issueNumber);
      if (daemonItem?.pullRequest?.number === 1) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    process.emit("SIGTERM");
    const daemonExit = await daemonRun;
    await writeFile(join(root, "publication-context-join.json"), `${JSON.stringify({ taskStart: { status: featureStart.status, request: featureStartRequestPrimary,
      response: featureStartResponsePrimary, taskId: featureTaskId }, nativeRegistration: { response: registrationResponse, hostEnrollment: recordedHostEnrollment },
      actualCli: { exitCode: cliExit, output: cliOutput.join(""), joinRequests: cliJoinRequests, joinedEnrollment,
        taskReads: cliTaskReads, daemonExit, daemonOutput: daemonOutput.join(""), daemonItem }, responses: { candidateMismatch: mismatchedJoin, malformedJoin: malformedJoin },
      noSideEffects: { before: joinBeforeInvalid, after: joinAfterInvalid } }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    expect(daemonExit, daemonOutput.join(" ")).toBe(0);
    expect(daemonItem?.pullRequest?.number, daemonOutput.join(" ")).toBe(1);
    expect(cliJoinRequests, "enrollment and both publication fences must rejoin current server evidence").toHaveLength(3);
    expect(cliTaskReads, "each publication fence must reread the authenticated native task").toHaveLength(3);
    const daemonJoinRequests = cliJoinRequests.slice(1);
    for (const request of daemonJoinRequests) {
      const parsedRequest = recordOf(JSON.parse(request.requestBytes));
      expect(parsedRequest).toMatchObject({ taskRef: featureTaskId, subject: publicationJoinSubjectForCli });
      expect(parsedRequest?.sourceBindingRef).toMatch(/^cli-source:v1:[a-f0-9]{64}$/u);
      expect(recordOf(JSON.parse(request.responseBytes))).toMatchObject({ status: "READY", subject: publicationJoinSubjectForCli,
        candidateDigest: prePublishTask.workflow.candidate.digest });
    }
    expect(mismatchedJoin.body).toMatchObject({ status: "UNKNOWN", reasonCode: "candidate_commit_tree_or_base_mismatch" });
    expect(malformedJoin.body).toMatchObject({ status: "UNKNOWN", reasonCode: "invalid_or_mismatched_task_selector" });
    expect(joinAfterInvalid).toEqual(joinBeforeInvalid);

    expect(localPullRequests.size, "the host loop creates exactly the intended local PR before native reconciliation").toBe(1);
    expect([...localPullRequests.values()].map((pr) => pr.headBranch)).toEqual([publishPayload.headBranch]);

    expect((await publishPublisher({ Records: [{ eventName: "INSERT", dynamodb: { NewImage: marshall(publishOutbox!) } }] as never })).published).toBe(1);
    const queuedPublish = broker.db.get(String(publishOutbox!.pk), String(publishOutbox!.sk))!;
    const publishDispatch = await publishDispatcher({ Records: [{ messageId: String(publishOutbox!.id), body: JSON.stringify(queuedPublish) }] });
    expect(publishDispatch.batchItemFailures).toEqual([]);
    for (let index = 0; index < 800; index += 1) {
      const operation = broker.db.get(`WORKSPACE#${featureWorkspaceId}`, `OPERATION#${publishInvocation.operationId}`);
      if (operation?.status === "SUCCEEDED" || operation?.status === "FAILED") break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    const publishOperation = broker.db.get(`WORKSPACE#${featureWorkspaceId}`, `OPERATION#${publishInvocation.operationId}`);
    const finalPublishedTask = broker.db.get(`DEVTASK#${featureTaskId}`, "META") as { startingRevision: number; workflow: { stage: string; state: string;
      candidate: { digest: string; repositories: Array<{ repositoryId: string; commitSha: string; treeSha: string; baseCommitSha?: string }> };
      reviewBase?: Array<{ repositoryId: string; baseCommitSha: string }>;
      pullRequests?: Array<{ headSha?: string; headTreeSha?: string; number?: number; state?: string }> } };
    const localRemoteHead = git(localBareRemote, "rev-parse", `refs/heads/${publishPayload.headBranch}^{commit}`);
    await writeFile(join(root, "local-publication-receipt.json"), `${JSON.stringify({ recoveryResponse: recoveryResponse.body,
      publishInvocation, publishDispatch, journal: await publishJournal.get(publishInvocation.operationId), publishOperation,
      push: localPushTargets, localBareRemote, localRemoteHead, workflow: finalPublishedTask.workflow }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    expect(publishOperation?.status, JSON.stringify({ publishOperation, journal: await publishJournal.get(publishInvocation.operationId), publishDispatch })).toBe("SUCCEEDED");
    expect(localPushTargets).toHaveLength(1);
    expect(localRemoteHead).toBe(localPushTargets[0]?.commit);
    expect(localRemoteHead).toBe(publishPayload.candidateCommitSha);
    expect(git(localBareRemote, "rev-parse", `${localRemoteHead}^{tree}`)).toBe(publishPayload.candidateTreeSha);
    expect(finalPublishedTask.workflow.stage).toBe("WAIT_FOR_MERGE");
    expect(finalPublishedTask.workflow.state).toBe("WAITING");
    expect(finalPublishedTask.workflow.pullRequests).toContainEqual(expect.objectContaining({ number: 1, headSha: localRemoteHead,
      headTreeSha: git(localBareRemote, "rev-parse", `${localRemoteHead}^{tree}`), state: "UNKNOWN" }));
    expect(localPullRequests.size, "native publication must reconcile the host loop's existing PR").toBe(1);
    expect([...localPullRequests.entries()]).toEqual([[1, expect.objectContaining({ headBranch: publishPayload.headBranch })]]);
    const liveFeatureOperation = broker.db.get(`WORKSPACE#${featureWorkspaceId}`, `OPERATION#${implementInvocation.operationId}`);
    expect(liveFeatureOperation, "the collision control must use a real current operation under the real feature WORKSPACE key").toMatchObject({
      workspaceId: featureWorkspaceId, id: implementInvocation.operationId, kind: "task", workflowMode: "IMPLEMENT",
    });
    const collisionJournal = new OperationJournal(join(root, "setup-workspace-domain-collision-journal"));
    const collisionExecutor = vi.fn(async (invocation: ReturnType<typeof WorkerInvocationSchema.parse>) => ({ kind: invocation.kind }));
    const collisionWorker = createWorkerServerState(collisionJournal, { invocationFeatures: ["project.setupSmoke"], execute: collisionExecutor }, {},
      { publicKey: workerKeys.publicKey, workspaceId: featureWorkspaceId, generation: 1 });
    const authorizationFor = (claims: WorkerInvokeTokenClaims): string => {
      const payload = workerInvokeTokenPayload(claims);
      return `AgentX-Invoke ${workerInvokeToken(payload, cryptoSign("sha256", Buffer.from(payload, "ascii"), workerKeys.privateKey))}`;
    };
    const workspaceClaims: WorkerInvokeTokenClaims = { workspaceId: featureWorkspaceId, generation: 1,
      operationId: implementInvocation.operationId, fence: implementInvocation.fence, expiresAt: Math.floor(Date.now() / 1_000) + 60,
      purpose: "WORKSPACE" };
    const workspacePositiveResponse = await handleWorkerRequest(new Request("http://worker/invocations", { method: "POST",
      headers: { authorization: authorizationFor(workspaceClaims), "content-type": "application/json" }, body: JSON.stringify(implementInvocation) }), collisionWorker);
    const workspacePositiveBody = await workspacePositiveResponse.text();
    await persistOriginalEvidencePrimary({ root, kind: "workspace-purpose-collision-positive-response", key: implementInvocation.operationId,
      bytes: Buffer.from(workspacePositiveBody), producer: "actual worker HTTP response for the genuine current WORKSPACE implementation operation under the shared opaque correlation ID",
      sourceCandidateDigest: workerCandidate.digest });
    expect(workspacePositiveResponse.status, workspacePositiveBody).toBe(200);
    for (let attempt = 0; attempt < 40 && (await collisionJournal.get(implementInvocation.operationId))?.status !== "SUCCEEDED"; attempt += 1) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    }
    expect((await collisionJournal.get(implementInvocation.operationId))?.status).toBe("SUCCEEDED");
    const setupInvocationRecord = WorkerInvocationSchema.parse(outboxRow.invocation);
    expect(setupInvocationRecord.kind).toBe("project-setup-smoke");
    if (setupInvocationRecord.kind !== "project-setup-smoke") throw new Error("setup outbox row did not contain a setup invocation");
    const setupPayload = setupInvocationRecord.payload;
    const setupCollisionCapability = issueProjectSetupCapability(String(broker.brokerInput.callbackSigningKey), {
      domain: "PROJECT_SETUP", setupExecutionId: setupPayload.setupExecutionId, subjectId: setupPayload.subjectId,
      transportCorrelationId: featureWorkspaceId, operationId: implementInvocation.operationId,
      approvalRevision: setupPayload.approvalRevision, fence: implementInvocation.fence,
      expiresAt: Math.floor(Date.now() / 1_000) + 60, actions: ["read-execution", "write-evidence", "result"],
    });
    const setupTokenBrokerAttempts: Array<{ path: string; requestBytes: string; status: number; responseBytes: string }> = [];
    const setupTokenAtWorkspaceRoute = async (path: string, headers: Record<string, string>, requestBody: unknown) => {
      const requestBytes = JSON.stringify(requestBody);
      const response = await broker.handler({ version: "2.0", rawPath: path, rawQueryString: "", headers,
        body: requestBytes, requestContext: { requestId: randomUUID(), http: { method: "POST" } } });
      const responseBytes = response.body;
      setupTokenBrokerAttempts.push({ path, requestBytes, status: response.statusCode, responseBytes });
      await persistOriginalEvidencePrimary({ root, kind: `setup-token-collision-${setupTokenBrokerAttempts.length}`, key: path,
        bytes: Buffer.from(`${requestBytes}\n${responseBytes}`, "utf8"),
        producer: "actual broker request JSON bytes followed by the original HTTP response bytes for setup-purpose capability presented at a real WORKSPACE operation route",
        sourceCandidateDigest: workerCandidate.digest });
      return { status: response.statusCode, responseBytes };
    };
    const credentialResolver = vi.spyOn(broker.brokerInput.repositoryGrants as unknown as {
      resolveCredential: (...args: never[]) => Promise<unknown>;
    }, "resolveCredential");
    const setupTokenAtTaskResult = await setupTokenAtWorkspaceRoute(
      `/v1/internal/workspaces/${featureWorkspaceId}/operations/${implementInvocation.operationId}/result`,
      { "x-agentx-callback-capability": setupCollisionCapability }, {});
    const setupTokenAtPublicationCallback = await setupTokenAtWorkspaceRoute(
      `/v1/internal/workspaces/${featureWorkspaceId}/operations/${publishInvocation.operationId}/pull-request`,
      { "x-agentx-callback-capability": setupCollisionCapability }, {});
    const setupTokenAtRepositoryCredentials = await setupTokenAtWorkspaceRoute(
      `/v1/internal/workspaces/${featureWorkspaceId}/operations/${publishInvocation.operationId}/repository-credentials`,
      { "x-agentx-repository-grant": setupCollisionCapability },
      { credentialRef: "github-app", repositoryUrl: "https://github.com/acme/ordinary-orders", access: "push" });
    expect(setupTokenAtTaskResult.status, setupTokenAtTaskResult.responseBytes).toBe(409);
    expect(setupTokenAtPublicationCallback.status, setupTokenAtPublicationCallback.responseBytes).toBe(409);
    expect(setupTokenAtRepositoryCredentials.status, setupTokenAtRepositoryCredentials.responseBytes).toBe(403);
    expect(JSON.parse(setupTokenAtTaskResult.responseBytes)).toMatchObject({ error: { code: "CALLBACK_FORBIDDEN" } });
    expect(JSON.parse(setupTokenAtPublicationCallback.responseBytes)).toMatchObject({ error: { code: "CALLBACK_FORBIDDEN" } });
    expect(JSON.parse(setupTokenAtRepositoryCredentials.responseBytes)).toMatchObject({ error: { code: "FORBIDDEN" } });
    expect(credentialResolver).not.toHaveBeenCalled();
    const setupPurposeClaims: WorkerInvokeTokenClaims = { workspaceId: featureWorkspaceId, generation: 1,
      operationId: implementInvocation.operationId, fence: implementInvocation.fence, expiresAt: Math.floor(Date.now() / 1_000) + 60,
      purpose: "PROJECT_SETUP", setupExecutionId: setupPayload.setupExecutionId, setupSubjectId: setupPayload.subjectId,
      setupApprovalRevision: setupPayload.approvalRevision };
    const setupCollisionInvocation = WorkerInvocationSchema.parse({ ...setupInvocationRecord, workspaceId: featureWorkspaceId,
      operationId: implementInvocation.operationId, fence: implementInvocation.fence, callbackCapability: setupCollisionCapability,
      payload: { ...setupPayload, transportCorrelationId: featureWorkspaceId } });
    const setupCollisionResponse = await handleWorkerRequest(new Request("http://worker/invocations", { method: "POST",
      headers: { authorization: authorizationFor(setupPurposeClaims), "content-type": "application/json" },
      body: JSON.stringify(setupCollisionInvocation) }), collisionWorker);
    const setupCollisionBody = await setupCollisionResponse.text();
    await persistOriginalEvidencePrimary({ root, kind: "setup-purpose-same-workspace-operation-response", key: implementInvocation.operationId,
      bytes: Buffer.from(setupCollisionBody), producer: "actual worker HTTP response for a PROJECT_SETUP purpose against the exact opaque ID and current WORKSPACE operation",
      sourceCandidateDigest: workerCandidate.digest });
    expect(setupCollisionResponse.status, setupCollisionBody).toBe(409);
    const taskRelabelResponse = await handleWorkerRequest(new Request("http://worker/invocations", { method: "POST",
      headers: { authorization: authorizationFor(setupPurposeClaims), "content-type": "application/json" }, body: JSON.stringify(implementInvocation) }), collisionWorker);
    const taskRelabelBody = await taskRelabelResponse.text();
    await persistOriginalEvidencePrimary({ root, kind: "setup-purpose-task-model-relabel-response", key: implementInvocation.operationId,
      bytes: Buffer.from(taskRelabelBody), producer: "actual worker HTTP response when the setup-purpose signature is presented as the genuine task/model invocation",
      sourceCandidateDigest: workerCandidate.digest });
    expect(taskRelabelResponse.status, taskRelabelBody).toBe(401);
    const publicationRelabel = WorkerInvocationSchema.parse({ ...publishInvocation, workspaceId: featureWorkspaceId,
      operationId: implementInvocation.operationId, fence: implementInvocation.fence });
    const publicationRelabelResponse = await handleWorkerRequest(new Request("http://worker/invocations", { method: "POST",
      headers: { authorization: authorizationFor(setupPurposeClaims), "content-type": "application/json" }, body: JSON.stringify(publicationRelabel) }), collisionWorker);
    const publicationRelabelBody = await publicationRelabelResponse.text();
    await persistOriginalEvidencePrimary({ root, kind: "setup-purpose-publish-credential-relabel-response", key: implementInvocation.operationId,
      bytes: Buffer.from(publicationRelabelBody), producer: "actual worker HTTP response when setup purpose is presented to the publication/credential invocation loader",
      sourceCandidateDigest: workerCandidate.digest });
    expect(publicationRelabelResponse.status, publicationRelabelBody).toBe(401);
    expect(collisionExecutor).toHaveBeenCalledTimes(1);
    expect((await collisionJournal.list()).map((entry) => entry.operationId)).toEqual([implementInvocation.operationId]);
    await writeFile(join(root, "setup-workspace-domain-collision.json"), `${JSON.stringify({ workspaceId: featureWorkspaceId,
      storedWorkspace: broker.db.get(`WORKSPACE#${featureWorkspaceId}`, "META"), liveFeatureOperation, taskId: featureTaskId,
      setupExecutionId: setupPayload.setupExecutionId, setupPurpose: setupPurposeClaims, positiveWorkspaceOperation: implementInvocation.operationId,
      responseStatuses: { workspacePositive: workspacePositiveResponse.status, setupPurposeSameOperation: setupCollisionResponse.status,
        taskModelRelabel: taskRelabelResponse.status, publicationCredentialRelabel: publicationRelabelResponse.status,
        taskResultCallback: setupTokenAtTaskResult.status, publicationCallback: setupTokenAtPublicationCallback.status,
        repositoryCredentialExchange: setupTokenAtRepositoryCredentials.status },
      brokerRequestAttempts: setupTokenBrokerAttempts, credentialResolverCalls: credentialResolver.mock.calls.length,
      executorCalls: collisionExecutor.mock.calls.map(([invocation]) => ({ kind: invocation.kind, operationId: invocation.operationId })),
      effectBoundary: "The genuine WORKSPACE task was accepted. Setup-purpose invocation could not reuse its current operation; setup-purpose tokens were rejected by actual task-result/publication callback and repository-credential routes before credential resolution, and could not be relabeled to task/model or publish/credential execution." }, null, 2)}\n`,
      { mode: 0o600, flag: "wx" });
    const creatorMembershipKey = { pk: `MEMBER#${ownerDeveloperId}`, sk: "PROJECT#ordinary-orders" };
    const admittedCreatorMembership = broker.db.get(creatorMembershipKey.pk, creatorMembershipKey.sk);
    expect(admittedCreatorMembership?.grantId).toMatch(/^[0-9a-f-]{36}$/iu);
    const creatorAuthorityOutboxCount = broker.db.find((item) => item.entityType === "OUTBOX" && item.workspaceId === featureWorkspaceId).length;
    const oldChecksOperation = broker.db.find((item) => item.pk === `WORKSPACE#${featureWorkspaceId}` && item.workflowMode === "CHECKS")
      .at(-1);
    const oldRoundAdmission = oldChecksOperation?.workflowE2EAdmission as { groupRunIds?: string[]; admissionRef?: { sha256?: string } } | undefined;
    expect(oldRoundAdmission?.admissionRef?.sha256).toMatch(/^[0-9a-f]{64}$/u);
    broker.db.delete(creatorMembershipKey.pk, creatorMembershipKey.sk);
    const revokedCreatorRead = await call(broker.handler, { method: "GET", path: `/v1/dev/tasks/${featureTaskId}`,
      headers: { authorization: "Bearer synthetic-owner-session" } });
    const revokedCreatorView = (revokedCreatorRead.body as { task?: { e2ePresentation?: { shared?: { e2e?: { status?: string; expectedGroups?: number;
      receivedGroups?: number; qualifiedCriteria?: number; requiredCriteria?: number } } } } }).task?.e2ePresentation?.shared?.e2e;
    broker.db.set({ ...admittedCreatorMembership!, grantId: randomUUID(), grantedAt: new Date().toISOString() });
    const regrantedCreatorRead = await call(broker.handler, { method: "GET", path: `/v1/dev/tasks/${featureTaskId}`,
      headers: { authorization: "Bearer synthetic-owner-session" } });
    const regrantedCreatorView = (regrantedCreatorRead.body as { task?: { e2ePresentation?: { shared?: { e2e?: { status?: string; expectedGroups?: number;
      receivedGroups?: number; qualifiedCriteria?: number; requiredCriteria?: number } } } } }).task?.e2ePresentation?.shared?.e2e;
    await writeFile(join(root, "creator-revocation-regrant-old-round.json"), `${JSON.stringify({ admissionSha256: oldRoundAdmission?.admissionRef?.sha256,
      oldGrantId: admittedCreatorMembership?.grantId, newGrantId: broker.db.get(creatorMembershipKey.pk, creatorMembershipKey.sk)?.grantId,
      revokedHttp: revokedCreatorRead, revokedView: revokedCreatorView, regrantedHttp: regrantedCreatorRead, regrantedView: regrantedCreatorView,
      outboxCountBefore: creatorAuthorityOutboxCount,
      outboxCountAfter: broker.db.find((item) => item.entityType === "OUTBOX" && item.workspaceId === featureWorkspaceId).length }, null, 2)}\n`,
      { mode: 0o600, flag: "wx" });
    expect(revokedCreatorRead.status).toBe(200);
    expect(revokedCreatorView, JSON.stringify(revokedCreatorRead.body)).toMatchObject({ status: "UNKNOWN", expectedGroups: oldRoundAdmission?.groupRunIds?.length,
      receivedGroups: 0, qualifiedCriteria: 0 });
    expect(regrantedCreatorRead.status).toBe(200);
    expect(regrantedCreatorView, JSON.stringify(regrantedCreatorRead.body)).toMatchObject({ status: "UNKNOWN", expectedGroups: oldRoundAdmission?.groupRunIds?.length,
      receivedGroups: 0, qualifiedCriteria: 0 });
    expect(broker.db.find((item) => item.entityType === "OUTBOX" && item.workspaceId === featureWorkspaceId)).toHaveLength(creatorAuthorityOutboxCount);

    // A separate, normally approved task preserves the browser obligation end to end. Its
    // portable groups execute, while the unsupported required navigation criterion blocks
    // qualification and prevents review/publication admission.
    const browserTaskStart = await call(broker.handler, { method: "POST", path: "/v1/dev/tasks",
      headers: { authorization: "Bearer synthetic-owner-session" }, body: { requestId: randomUUID(), project: "ordinary-orders",
        instructions: "Add an orders list and verify the approved browser journey.", client: "native-p0-browser-hold", workflow: true, workflowPath: "QUICK" } });
    expect(browserTaskStart.status, JSON.stringify(browserTaskStart.body)).toBe(200);
    const browserTaskId = String((browserTaskStart.body.task as { taskId: string }).taskId);
    const browserTask = broker.db.get(`DEVTASK#${browserTaskId}`, "META") as { workspaceId: string };
    const browserWorkspaceId = browserTask.workspaceId;
    const browserOperations = () => broker.db.find((item) => item.pk === `WORKSPACE#${browserWorkspaceId}` && item.entityType === "OPERATION");
    const browserCallbackRequests: Array<{ path: string; status: number; request: unknown; response: unknown }> = [];
    const browserFetch: typeof fetch = async (url, init) => {
      const parsed = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
      const request = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
      const response = await call(broker.handler, { method: init?.method ?? "GET", path: parsed.pathname,
        headers: Object.fromEntries(new Headers(init?.headers).entries()), ...(request === undefined ? {} : { body: request }) });
      browserCallbackRequests.push({ path: parsed.pathname, status: response.status, request, response: response.body });
      return new Response(JSON.stringify(response.body), { status: response.status, headers: { "content-type": "application/json" } });
    };
    const browserPrepare = browserOperations().find((item) => item.workflowMode === undefined && (item as { kind?: string }).kind === "prepare");
    await writeFile(join(root, "browser-required-start-diagnostic.json"), `${JSON.stringify({ start: browserTaskStart,
      task: broker.db.get(`DEVTASK#${browserTaskId}`, "META"), operations: browserOperations(),
      outboxes: broker.db.find((item) => item.entityType === "OUTBOX" && item.workspaceId === browserWorkspaceId) }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    expect(browserPrepare).toBeDefined();
    const browserPrepareOutbox = broker.db.find((item) => item.entityType === "OUTBOX" && item.operationId === browserPrepare!.id)[0];
    const browserPrepareCapability = (browserPrepareOutbox?.invocation as { callbackCapability?: string } | undefined)?.callbackCapability;
    expect(browserPrepareCapability).toBeDefined();
    const browserPrepareResult = await call(broker.handler, { method: "POST", path: `/v1/internal/workspaces/${browserWorkspaceId}/operations/${String(browserPrepare!.id)}/result`,
      headers: { "x-agentx-callback-capability": browserPrepareCapability! }, body: { operationId: browserPrepare!.id, status: "SUCCEEDED",
        result: { preparedBase: [{ repositoryId: "ordinary-orders", baseCommitSha: commitSha }] } } });
    expect(browserPrepareResult.status, JSON.stringify(browserPrepareResult.body)).toBe(200);
    const browserPlanOperation = browserOperations().find((item) => item.workflowMode === "PLAN");
    await writeFile(join(root, "browser-required-after-prepare.json"), `${JSON.stringify({ prepareResponse: browserPrepareResult,
      task: broker.db.get(`DEVTASK#${browserTaskId}`, "META"), operations: browserOperations(),
      outboxes: broker.db.find((item) => item.entityType === "OUTBOX" && item.workspaceId === browserWorkspaceId) }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    expect(browserPlanOperation).toBeDefined();
    const browserPlanOutbox = broker.db.find((item) => item.entityType === "OUTBOX" && item.operationId === browserPlanOperation!.id)[0];
    const browserPlanInvocation = WorkerInvocationSchema.parse(browserPlanOutbox?.invocation);
    const browserWorkerRoot = join(root, "browser-required-worker-workspace");
    const browserWorkerRepository = join(browserWorkerRoot, "repo", "ordinary-orders");
    await mkdir(join(browserWorkerRoot, "repo"), { recursive: true });
    git(repositoryRoot, "worktree", "add", "--quiet", "-b", `codex/p0-browser-worker-${randomUUID()}`, browserWorkerRepository, commitSha);
    git(browserWorkerRepository, "remote", "set-url", "origin", "https://github.com/acme/ordinary-orders.git");
    await mkdir(join(browserWorkerRoot, ".agentx"), { recursive: true, mode: 0o700 });
    await writeFile(join(browserWorkerRoot, ".agentx", "preparation-manifest.json"), `${JSON.stringify({ schemaVersion: 2,
      projectName: "ordinary-orders", projectRevision: browserPlanInvocation.projectRevision,
      repositories: [{ name: "ordinary-orders", path: "repo/ordinary-orders", defaultBranch: "main", resolvedCommit: commitSha,
        resolvedAt: new Date().toISOString(), completedAt: new Date().toISOString() }],
      completedSetupSteps: [], readinessResults: [], creationIdentity: `fixture-${browserTaskId}`, complete: true, updatedAt: new Date().toISOString(),
    }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    const browserPlanCallbacks = createWorkerCallbackSinks({ controlPlaneUrl: "https://cp.example.test", invocation: browserPlanInvocation, fetchImplementation: browserFetch });
    const browserTargetScenario = { scenarioId: "orders-browser-navigation", requirementId: "orders-navigation",
      requestedTargetIds: ["web-1"], required: true, accountProfileId: "synthetic", minimumEvidence: "runtime" as const,
      requiredRealComponentIds: [], steps: [{ kind: "navigate" as const, path: "/orders" }],
      assertions: [{ kind: "visible" as const, testId: "orders-list", equals: true }] };
    const browserRequiredIntent = { ...e2eIntent, scenarios: [...e2eIntent.scenarios, browserTargetScenario] };
    const browserGraph = { schemaVersion: 1 as const, taskId: browserTaskId, version: 1,
      items: [{ id: randomUUID(), title: "Implement portable orders view", description: "Implement the source-bound renderer and regression test.",
        repository: "ordinary-orders", dependsOn: [] }] };
    const browserPlanDocument = { schemaVersion: 1 as const, title: "Orders browser journey", why: [{ text: "The owner requested an orders journey.", author: "planner" }],
      claims: [{ id: "1", text: "The portable renderer is available." }], notChanging: ["Browser behavior remains required."],
      risks: ["The browser runner is not currently qualified."], decisions: [], workBreakdown: browserGraph, e2e: browserRequiredIntent };
    const browserPlannerArtifact = `\`\`\`agentx-plan\n${JSON.stringify(browserPlanDocument)}\n\`\`\`\n`;
    const { modelRuntime: browserPlanRuntime, faux: browserPlanFaux } = await fauxModelRuntime();
    browserPlanFaux.setResponses([fauxAssistantMessage(browserPlannerArtifact)]);
    const browserPlanResult = await runTaskInvocation(browserPlanInvocation, { rootPath: browserWorkerRoot, model: FAUX_MODEL,
      piAdapter: createDefaultPiSessionAdapter({ modelRuntime: async () => ({ runtime: browserPlanRuntime, model: FAUX_MODEL }) }),
      eventSink: browserPlanCallbacks.eventSink, artifactSink: browserPlanCallbacks.artifactSink });
    await postWorkerTerminalResult(browserPlanCallbacks, { operationId: browserPlanInvocation.operationId, status: "SUCCEEDED", result: browserPlanResult }, browserPlanInvocation);
    const browserPlanState = broker.db.get(`DEVTASK#${browserTaskId}`, "META") as { workflow: { revision: number; artifacts: Array<{ type: string; id: string; sha256: string; objectKey: string }> } };
    const browserCanonicalArtifact = browserPlanState.workflow.artifacts.filter((item) => item.type === "plan").at(-1);
    expect(browserCanonicalArtifact).toBeDefined();
    const browserCanonicalText = objects.get(browserCanonicalArtifact!.objectKey)?.toString("utf8") ?? "";
    const browserCanonicalPlan = readCanonicalPlan(browserCanonicalText);
    expect(browserCanonicalPlan?.e2e).toEqual(browserRequiredIntent);
    const browserGraphApproval = await call(broker.handler, { method: "POST", path: `/v1/dev/tasks/${browserTaskId}/workflow/decision`,
      headers: { authorization: "Bearer synthetic-owner-session" }, body: { requestId: randomUUID(), expectedRevision: browserPlanState.workflow.revision,
        decision: "APPROVE", reason: "Approve the canonical browser-required plan and graph.", artifactDigest: browserCanonicalArtifact!.sha256,
        workBreakdownDigest: taskGraphDigest(browserGraph) } });
    expect(browserGraphApproval.status, JSON.stringify(browserGraphApproval.body)).toBe(200);
    const browserImplementOperation = browserOperations().find((item) => item.workflowMode === "IMPLEMENT");
    expect(browserImplementOperation).toBeDefined();
    const browserImplementOutbox = broker.db.find((item) => item.entityType === "OUTBOX" && item.operationId === browserImplementOperation!.id)[0];
    const browserImplementInvocation = WorkerInvocationSchema.parse(browserImplementOutbox?.invocation);
    await writeFile(join(browserWorkerRoot, ".agentx", "preparation-manifest.json"), `${JSON.stringify({ schemaVersion: 2,
      projectName: "ordinary-orders", projectRevision: browserImplementInvocation.projectRevision,
      repositories: [{ name: "ordinary-orders", path: "repo/ordinary-orders", defaultBranch: "main", resolvedCommit: commitSha,
        resolvedAt: new Date().toISOString(), completedAt: new Date().toISOString() }],
      completedSetupSteps: [], readinessResults: [], creationIdentity: `fixture-${browserTaskId}`, complete: true, updatedAt: new Date().toISOString(),
    }, null, 2)}\n`, { mode: 0o600 });
    const browserImplementCallbacks = createWorkerCallbackSinks({ controlPlaneUrl: "https://cp.example.test", invocation: browserImplementInvocation, fetchImplementation: browserFetch });
    const { modelRuntime: browserImplementRuntime, faux: browserImplementFaux } = await fauxModelRuntime();
    browserImplementFaux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "cd repo/ordinary-orders && mkdir -p test && cat > test/orders-browser.test.mjs <<'EOF'\nimport assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { priceRows } from '../src/index.mjs';\ntest('preserves approved order price', () => { assert.deepEqual(priceRows({ rows: [{ price: 4 }] }), { rows: [{ price: 7 }] }); });\nEOF\ngit add -- test/orders-browser.test.mjs && git commit -m 'Add orders price regression test'" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("bash", { command: "cd repo/ordinary-orders && cat > src/index.mjs <<'EOF'\nimport { applyPrice } from './price-rows.mjs';\nexport async function renderOrders(input) { const response = await fetch(`/orders?mode=${encodeURIComponent(input.mode)}`); if (!response.ok) return `refused:${response.status}`; const body = await response.json(); if (!Array.isArray(body.orders)) return 'invalid-data'; return body.orders.map((row) => `<li data-testid=\\\"orders-list\\\">${row.name}</li>`).join(''); }\nexport function priceRows(input) { return { rows: input.rows.map(applyPrice) }; }\nEOF\ngit add -- src/index.mjs && git commit -m 'Implement orders renderer'" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("I implemented the portable orders renderer and kept the browser criterion in the approved plan."),
    ]);
    const browserImplementationResult = await runTaskInvocation(browserImplementInvocation, { rootPath: browserWorkerRoot, model: FAUX_MODEL,
      piAdapter: createDefaultPiSessionAdapter({ modelRuntime: async () => ({ runtime: browserImplementRuntime, model: FAUX_MODEL }) }),
      eventSink: browserImplementCallbacks.eventSink, artifactSink: browserImplementCallbacks.artifactSink });
    await postWorkerTerminalResult(browserImplementCallbacks, { operationId: browserImplementInvocation.operationId, status: "SUCCEEDED", result: browserImplementationResult }, browserImplementInvocation);
    const browserChecksOutbox = broker.db.find((item) => item.entityType === "OUTBOX" && item.workspaceId === browserWorkspaceId
      && (item.invocation as { payload?: { workflowMode?: string } } | undefined)?.payload?.workflowMode === "CHECKS").at(-1);
    await writeFile(join(root, "browser-required-after-implement.json"), `${JSON.stringify({ implementationResult: browserImplementationResult, callbackRequests: browserCallbackRequests,
      task: broker.db.get(`DEVTASK#${browserTaskId}`, "META"), operations: browserOperations(),
      outboxes: broker.db.find((item) => item.entityType === "OUTBOX" && item.workspaceId === browserWorkspaceId),
      dispatchRows: broker.db.find((item) => String(item.pk).startsWith("WORKFLOW_DISPATCH") || item.entityType === "WORKFLOW_DISPATCH") }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    expect(browserChecksOutbox, "the normal IMPLEMENT terminal must admit real CHECKS for the browser-required plan").toBeDefined();
    const browserChecksInvocation = WorkerInvocationSchema.parse(browserChecksOutbox!.invocation);
    const browserChecksJournal = new OperationJournal(join(root, "browser-required-checks-journal"));
    const browserChecksCancellation = new WorkerCancellationController();
    let cancelBrowserChecksOnRunning: ((receipt: { containerId: string; requestId: string; sourceDigest: string; observedAt: string; inspectBytes: Uint8Array }) => Promise<void>) | undefined;
    const browserChecksWorker = createWorkerServerState(browserChecksJournal, { execute: async (invocation) => {
      if (invocation.kind === "cancel") return executeWorkerCancelInvocation(invocation, browserChecksCancellation, browserChecksJournal);
      const invocationCallbacks = createWorkerCallbackSinks({ controlPlaneUrl: "https://cp.example.test", invocation, fetchImplementation: browserFetch });
      return runTaskInvocation(invocation, {
        rootPath: browserWorkerRoot, model: FAUX_MODEL, eventSink: invocationCallbacks.eventSink, artifactSink: invocationCallbacks.artifactSink,
        workflowE2EAdmissionReader: invocationCallbacks.workflowE2EAdmissionReader, workflowE2EEvidenceSink: invocationCallbacks.workflowE2EEvidenceSink,
        workflowE2EEvidenceRoot: evidenceRootForWorker, workflowE2ERuntimeRoot: process.cwd(), cancellationController: browserChecksCancellation,
        workflowE2EOnOwnedContainerRunning: async (receipt) => { await cancelBrowserChecksOnRunning?.(receipt); },
      });
    } }, { onTerminal: async (result, invocation) => {
      const terminalCallbacks = createWorkerCallbackSinks({ controlPlaneUrl: "https://cp.example.test", invocation, fetchImplementation: browserFetch });
      await postWorkerTerminalResult(terminalCallbacks, result, invocation);
    }, retrySleep: async () => undefined },
    { publicKey: workerKeys.publicKey, workspaceId: browserWorkspaceId, generation: 1 });
    const browserChecksDelivery = createEc2Delivery({ sessions: { ensureSession: async () => ({ ready: true as const, generation: 1, privateIp: "127.0.0.1" }) },
      binding: async () => runtimeBinding, sign: async (message) => cryptoSign("sha256", message, workerKeys.privateKey),
      post: async (_url, init) => { const response = await handleWorkerRequest(new Request("http://worker/invocations", { method: "POST",
        headers: { authorization: init.authorization, "content-type": "application/json" }, body: init.body }), browserChecksWorker);
        return { status: response.status, body: await response.text() }; },
      workerFeatures: async () => ((await (await handleWorkerRequest(new Request("http://worker/ping"), browserChecksWorker)).json()) as { invocationFeatures: string[] }).invocationFeatures,
      guardTaskDispatch: checksTaskGuard, progress: async () => undefined });
    const browserChecksDispatcher = createDispatcherHandler({ guardTaskDispatch: checksTaskGuard,
      markDispatching: async (record) => { try { await broker.db.send(new UpdateCommand({ TableName: "state",
        Key: { pk: `WORKSPACE#${record.workspaceId}`, sk: `OPERATION#${record.operationId}` },
        UpdateExpression: "SET #status = :dispatching, updatedAt = :now", ConditionExpression: "#status = :accepted OR #status = :dispatching",
        ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":accepted": "ACCEPTED", ":dispatching": "DISPATCHING", ":now": new Date().toISOString() } })); return true;
      } catch (error) { if (error instanceof Error && error.name === "ConditionalCheckFailedException") return false; throw error; } },
      markDelivered: async (id) => { await broker.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `OUTBOX#${id}`, sk: "OUTBOX" },
        UpdateExpression: "SET #status = :delivered, deliveredAt = :now", ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":delivered": "DELIVERED", ":now": new Date().toISOString() } })); },
      markFailed: async () => undefined, deliverEc2: browserChecksDelivery });
    const browserChecksPublisher = createOutboxPublisherHandler({ send: async () => undefined, markQueued: async (id) => {
      await broker.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `OUTBOX#${id}`, sk: "OUTBOX" }, UpdateExpression: "SET #status = :queued",
        ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":queued": "QUEUED" } }));
    } });
    expect((await browserChecksPublisher({ Records: [{ eventName: "INSERT", dynamodb: { NewImage: marshall(browserChecksOutbox!) } }] as never })).published).toBe(1);
    const browserChecksQueued = broker.db.get(String(browserChecksOutbox!.pk), String(browserChecksOutbox!.sk))!;
    const browserChecksDispatch = await browserChecksDispatcher({ Records: [{ messageId: String(browserChecksOutbox!.id), body: JSON.stringify(browserChecksQueued) }] });
    expect(browserChecksDispatch.batchItemFailures).toEqual([]);
    for (let index = 0; index < 800; index += 1) {
      const operation = broker.db.get(`WORKSPACE#${browserWorkspaceId}`, `OPERATION#${browserChecksInvocation.operationId}`);
      if (operation?.status === "SUCCEEDED" || operation?.status === "FAILED") break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    const browserChecksOperation = broker.db.get(`WORKSPACE#${browserWorkspaceId}`, `OPERATION#${browserChecksInvocation.operationId}`);
    const browserAdmission = recordOf(browserChecksInvocation.payload)?.workflowE2EAdmission as { admissionRef: { key: string; sha256: string }; candidateDigest: string; roundId: string; groupRunIds: string[] } | undefined;
    const browserAdmissionObject = browserAdmission === undefined ? undefined : JSON.parse(objects.get(browserAdmission.admissionRef.key)?.toString("utf8") ?? "null") as {
      plan: { criteria: Array<{ scenarioId: string; criterionId: string; required: boolean; expectedCaseIds: string[] }>; unavailableCriteria: Array<{ criterionId: string }> };
    };
    const browserCriterion = browserAdmissionObject?.plan.criteria.find((criterion) => criterion.scenarioId === browserTargetScenario.scenarioId);
    const browserWorkflow = (broker.db.get(`DEVTASK#${browserTaskId}`, "META") as { workflow: { revision: number; stage: string; state: string;
      e2e?: { qualifiedRound?: unknown; currentRoundId?: string } } }).workflow;
    const browserReviewOutbox = broker.db.find((item) => item.entityType === "OUTBOX" && item.workspaceId === browserWorkspaceId
      && (item.invocation as { payload?: { workflowMode?: string } } | undefined)?.payload?.workflowMode === "REVIEW").at(-1);
    const browserAdmissionPrimary = await persistOriginalMapPrimary({ root, kind: "browser-required-current-admission",
      key: browserAdmission!.admissionRef.key, objects, producer: "broker content-addressed immutable admission from normal approved task",
      sourceCandidateDigest: browserAdmission!.candidateDigest });
    const browserEvidenceRef = (browserChecksOperation as { workflowE2EEvidenceRef?: { key: string; sha256: string; byteLength: number } }).workflowE2EEvidenceRef;
    expect(browserEvidenceRef).toBeDefined();
    const browserEvidencePrimary = await persistOriginalMapPrimary({ root, kind: "browser-required-worker-evidence",
      key: browserEvidenceRef!.key, objects, producer: "default worker's original CHECKS evidence object",
      sourceCandidateDigest: browserAdmission!.candidateDigest });
    expect(browserAdmissionPrimary.sha256).toBe(browserAdmission!.admissionRef.sha256);
    expect(browserEvidencePrimary).toMatchObject({ sha256: browserEvidenceRef!.sha256, byteLength: browserEvidenceRef!.byteLength });
    expect(browserChecksOperation?.status).toBe("SUCCEEDED");
    expect(browserCriterion).toMatchObject({ required: true, expectedCaseIds: [] });
    expect(browserAdmissionObject?.plan.unavailableCriteria).toContainEqual(expect.objectContaining({ criterionId: browserCriterion?.criterionId }));
    expect(browserWorkflow).toMatchObject({ stage: "VERIFY", state: "BLOCKED", e2e: { currentRoundId: browserAdmission?.roundId } });
    expect(browserWorkflow.e2e?.qualifiedRound).toBeUndefined();
    expect(browserReviewOutbox).toBeUndefined();
    const browserOwnerRead = await call(broker.handler, { method: "GET", path: `/v1/dev/tasks/${browserTaskId}`,
      headers: { authorization: "Bearer synthetic-owner-session" } });
    await writeFile(join(root, "browser-required-qualification-diagnostic.json"), `${JSON.stringify({ checksOperation: browserChecksOperation,
      admission: browserAdmissionObject, ownerRead: browserOwnerRead,
      workflow: broker.db.get(`DEVTASK#${browserTaskId}`, "META"), e2eRows: broker.db.find((item) => String(item.pk).startsWith("E2E#")
        || item.entityType?.toString().startsWith("E2E") === true), e2eObjectKeys: [...objects.keys()].filter((key) => key.includes("workflow-e2e")) }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    expect(browserOwnerRead.status).toBe(200);
    expect((browserOwnerRead.body.task as DeveloperTaskView).e2ePresentation?.shared.e2e)
      .toMatchObject({ status: "UNKNOWN", expectedGroups: 2, receivedGroups: 2, executedCases: 6, requiredCriteria: 7, qualifiedCriteria: 6, unavailableCriteria: 1 });
    const browserViewerProjection = await loadWorkflowE2EPresentation(broker.brokerInput as never,
      broker.db.get(`DEVTASK#${browserTaskId}`, "META") as never,
      broker.db.find((item) => item.pk === `WORKSPACE#${browserWorkspaceId}` && item.entityType === "OPERATION"), "viewer");
    expect(browserViewerProjection?.shared.e2e)
      .toMatchObject({ status: "UNKNOWN", expectedGroups: 2, receivedGroups: 2, executedCases: 6, requiredCriteria: 7, qualifiedCriteria: 6, unavailableCriteria: 1 });
    const browserShare = await call(broker.handler, { method: "POST", path: `/v1/dev/tasks/${browserTaskId}/share`,
      headers: { authorization: "Bearer synthetic-owner-session" }, body: { requestId: randomUUID(), shareMode: "view", channel: "C0P0NATIVE" } });
    expect(browserShare.status, JSON.stringify(browserShare.body)).toBe(200);
    const browserShareRecord = (broker.db.get(`DEVTASK#${browserTaskId}`, "META") as { share: { sharedAt: string } }).share;
    const browserStartNotice = await notifierHandler({ Records: [{ eventSource: "aws:sqs", messageId: "native-browser-unknown-start",
      receiptHandle: "native-browser-unknown", body: JSON.stringify({ id: `${browserTaskId}:start`, kind: "start", taskId: browserTaskId,
        at: browserShareRecord.sharedAt }), attributes: { ApproximateReceiveCount: "1" } }] });
    expect(browserStartNotice.batchItemFailures).toEqual([]);
    const browserNotice = await notifierHandler({ Records: [{ eventSource: "aws:sqs", messageId: "native-browser-unknown-workflow",
      receiptHandle: "native-browser-unknown-workflow", body: JSON.stringify({ id: `${browserTaskId}:workflow:${browserWorkflow.revision}`,
        kind: "workflow", taskId: browserTaskId, workflowRevision: browserWorkflow.revision, at: browserShareRecord.sharedAt }),
      attributes: { ApproximateReceiveCount: "1" } }] });
    expect(browserNotice.batchItemFailures).toEqual([]);
    const browserNoticePost = notifierPosts.at(-1);
    expect(JSON.stringify(browserNoticePost)).toContain("E2E UNKNOWN");
    expect(browserNoticePost?.text).toContain("required E2E evidence is incomplete or unavailable");
    expect(browserNoticePost?.text).not.toContain("Something went wrong on AgentX's side");
    expect(JSON.stringify(browserNoticePost)).not.toContain("agentx_workflow_send_back");
    const browserViewerRead = await call(broker.handler, { method: "GET", path: `/v1/dev/tasks/${browserTaskId}`,
      headers: { authorization: "Bearer synthetic-ungranted-session" } });
    expect(browserViewerRead.status, JSON.stringify(browserViewerRead.body)).toBe(404);
    expect(JSON.stringify(browserViewerRead.body)).not.toContain("orders-browser-navigation");
    const browserViewerSendBack = await call(broker.handler, { method: "POST", path: `/v1/dev/tasks/${browserTaskId}/workflow/send-back`,
      headers: { authorization: "Bearer synthetic-ungranted-session" }, body: { requestId: randomUUID(),
        expectedRevision: browserWorkflow.revision, instructions: "A project viewer cannot send the task back." } });
    expect(browserViewerSendBack.status, JSON.stringify(browserViewerSendBack.body)).toBe(404);
    const browserOwnerSendBack = await call(broker.handler, { method: "POST", path: `/v1/dev/tasks/${browserTaskId}/workflow/send-back`,
      headers: { authorization: "Bearer synthetic-owner-session" }, body: { requestId: randomUUID(),
        expectedRevision: browserWorkflow.revision, instructions: "The required browser criterion remains unknown; revise the approved plan." } });
    expect(browserOwnerSendBack.status, JSON.stringify(browserOwnerSendBack.body)).toBe(400);
    expect((browserOwnerSendBack.body as { error?: { code?: string } }).error?.code).toBe("CONFIG_INVALID");
    expect((broker.db.get(`DEVTASK#${browserTaskId}`, "META") as { workflow: { stage: string; state: string } }).workflow)
      .toMatchObject({ stage: "VERIFY", state: "BLOCKED" });
    const postBrowserOwnerAction = async (path: string, body: unknown) => {
      const response = await broker.handler({ version: "2.0", rawPath: path, rawQueryString: "",
        headers: { authorization: "Bearer synthetic-owner-session", "content-type": "application/json" }, body: JSON.stringify(body),
        requestContext: { requestId: randomUUID(), http: { method: "POST" } } });
      return { status: response.statusCode, rawBody: response.body, body: JSON.parse(response.body) as Record<string, unknown> };
    };
    const browserRetryRequestId = randomUUID();
    const browserRetry = await postBrowserOwnerAction(`/v1/dev/tasks/${browserTaskId}/workflow/retry`, {
      requestId: browserRetryRequestId, expectedRevision: browserWorkflow.revision,
      instructions: "Retry the approved checks under a fresh current E2E admission.",
    });
    await persistOriginalEvidencePrimary({ root, kind: "browser-required-owner-retry-response", key: `/v1/dev/tasks/${browserTaskId}/workflow/retry`,
      bytes: Buffer.from(browserRetry.rawBody, "utf8"), producer: "actual broker HTTP response to the authorized Owner retry route",
      sourceCandidateDigest: browserAdmission!.candidateDigest });
    expect(browserRetry.status, browserRetry.rawBody).toBe(200);
    const queuedRetryWorkflow = (browserRetry.body.task as DeveloperTaskView).workflow;
    if (queuedRetryWorkflow === undefined) throw new Error("Owner retry response omitted the task workflow");
    expect(queuedRetryWorkflow).toMatchObject({ stage: "VERIFY", state: "WAITING", revision: browserWorkflow.revision + 1 });
    expect(queuedRetryWorkflow?.e2e?.currentRoundId).toBeUndefined();
    const retryDispatchRow = broker.db.find((item) => item.entityType === "WORKFLOW_DISPATCH" && item.taskId === browserTaskId
      && item.workflowRevision === queuedRetryWorkflow?.revision && item.kind === "CHECKS")[0];
    expect(retryDispatchRow, "required-E2E retry must queue the native VERIFY dispatcher, not an ordinary CHECKS task").toBeDefined();
    const browserCreatorKey = { pk: `MEMBER#${ownerDeveloperId}`, sk: "PROJECT#ordinary-orders" };
    const browserCreatorGrant = broker.db.get(browserCreatorKey.pk, browserCreatorKey.sk);
    expect(browserCreatorGrant?.grantId).toMatch(/^[0-9a-f-]{36}$/iu);
    const checkOutboxesBeforeAccessPause = broker.db.find((item) => item.entityType === "OUTBOX" && item.workspaceId === browserWorkspaceId
      && (item.invocation as { payload?: { workflowMode?: string } } | undefined)?.payload?.workflowMode === "CHECKS").length;
    broker.db.delete(browserCreatorKey.pk, browserCreatorKey.sk);
    ownerChannelAccess = false;
    const retryRecoveryResponse = await broker.handler({ source: "agentx.workflow-dispatch-recovery" });
    const retryRecovery = JSON.parse(retryRecoveryResponse.body) as { attempted: number; dispatched: number };
    expect(retryRecoveryResponse.statusCode).toBe(200);
    const pausedRetryDispatch = broker.db.get(String(retryDispatchRow!.pk), String(retryDispatchRow!.sk)) as
      (typeof retryDispatchRow & { taskAccessPausedAt?: string; dispatchDuePk?: string }) | undefined;
    const pausedOutboxCount = broker.db.find((item) => item.entityType === "OUTBOX" && item.workspaceId === browserWorkspaceId
      && (item.invocation as { payload?: { workflowMode?: string } } | undefined)?.payload?.workflowMode === "CHECKS").length;
    await persistOriginalEvidencePrimary({ root, kind: "browser-required-access-pause-recovery-response", key: String(retryDispatchRow!.sk),
      bytes: Buffer.from(retryRecoveryResponse.body, "utf8"), producer: "actual broker workflow-dispatch recovery response after creator access was revoked",
      sourceCandidateDigest: browserAdmission!.candidateDigest });
    expect(pausedRetryDispatch?.taskAccessPausedAt).toBeDefined();
    expect(pausedRetryDispatch?.dispatchDuePk).toBeUndefined();
    expect(pausedOutboxCount).toBe(checkOutboxesBeforeAccessPause);
    broker.db.set({ ...browserCreatorGrant!, grantId: randomUUID(), grantedAt: new Date().toISOString() });
    const restoredRecoveryResponse = await broker.handler({ source: "agentx.workflow-dispatch-recovery" });
    expect(restoredRecoveryResponse.statusCode).toBe(200);
    const stillPausedAfterRestore = broker.db.get(String(retryDispatchRow!.pk), String(retryDispatchRow!.sk)) as
      (typeof retryDispatchRow & { taskAccessPausedAt?: string }) | undefined;
    const restoredOutboxCount = broker.db.find((item) => item.entityType === "OUTBOX" && item.workspaceId === browserWorkspaceId
      && (item.invocation as { payload?: { workflowMode?: string } } | undefined)?.payload?.workflowMode === "CHECKS").length;
    await persistOriginalEvidencePrimary({ root, kind: "browser-required-restoration-no-auto-response", key: String(retryDispatchRow!.sk),
      bytes: Buffer.from(restoredRecoveryResponse.body, "utf8"), producer: "actual broker recovery response after same creator was restored under a new grant",
      sourceCandidateDigest: browserAdmission!.candidateDigest });
    expect(stillPausedAfterRestore?.taskAccessPausedAt).toBeDefined();
    expect(restoredOutboxCount).toBe(checkOutboxesBeforeAccessPause);
    ownerChannelAccess = true;
    const explicitAccessRetryRequestId = randomUUID();
    const explicitAccessRetryBody = {
      requestId: explicitAccessRetryRequestId, expectedRevision: queuedRetryWorkflow.revision, candidateDigest: browserAdmission!.candidateDigest,
      instructions: "Explicitly resume the held E2E verification after current project access was restored.",
    };
    const explicitAccessRetry = await postBrowserOwnerAction(`/v1/dev/tasks/${browserTaskId}/workflow/retry`, explicitAccessRetryBody);
    await persistOriginalEvidencePrimary({ root, kind: "browser-required-explicit-access-retry-response", key: `/v1/dev/tasks/${browserTaskId}/workflow/retry#${explicitAccessRetryRequestId}`,
      bytes: Buffer.from(explicitAccessRetry.rawBody, "utf8"), producer: "actual authenticated Owner retry that alone resumes the access-paused native CHECKS dispatch",
      sourceCandidateDigest: browserAdmission!.candidateDigest });
    expect(explicitAccessRetry.status, explicitAccessRetry.rawBody).toBe(200);
    // The old paused receipt stays immutable; explicit retry creates a distinct fresh CHECKS dispatch.
    const explicitlyRetriedOldDispatch = broker.db.get(String(retryDispatchRow!.pk), String(retryDispatchRow!.sk)) as { taskAccessPausedAt?: unknown } | undefined;
    expect(typeof explicitlyRetriedOldDispatch?.taskAccessPausedAt).toBe("string");
    const explicitRetryWorkflow = (explicitAccessRetry.body.task as DeveloperTaskView).workflow;
    expect(explicitRetryWorkflow).toMatchObject({ stage: "VERIFY", state: "WAITING", revision: queuedRetryWorkflow.revision + 1 });
    const explicitRetryDispatch = broker.db.find((item) => item.entityType === "WORKFLOW_DISPATCH" && item.taskId === browserTaskId
      && item.workflowRevision === explicitRetryWorkflow?.revision && item.kind === "CHECKS")[0];
    expect(explicitRetryDispatch).toBeDefined();
    const duplicateAccessRetry = await postBrowserOwnerAction(`/v1/dev/tasks/${browserTaskId}/workflow/retry`, explicitAccessRetryBody);
    await persistOriginalEvidencePrimary({ root, kind: "browser-required-explicit-access-retry-duplicate-response", key: `/v1/dev/tasks/${browserTaskId}/workflow/retry#${explicitAccessRetryRequestId}`,
      bytes: Buffer.from(duplicateAccessRetry.rawBody, "utf8"), producer: "actual duplicate Owner retry response with the same request ID and payload",
      sourceCandidateDigest: browserAdmission!.candidateDigest });
    expect(duplicateAccessRetry.status, duplicateAccessRetry.rawBody).toBe(200);
    const conflictingAccessRetry = await postBrowserOwnerAction(`/v1/dev/tasks/${browserTaskId}/workflow/retry`, {
      ...explicitAccessRetryBody, instructions: "Reuse the same retry ID with a conflicting payload.",
    });
    expect(conflictingAccessRetry.status, conflictingAccessRetry.rawBody).toBe(409);
    expect(broker.db.find((item) => item.entityType === "WORKFLOW_DISPATCH" && item.taskId === browserTaskId
      && item.workflowRevision === explicitRetryWorkflow?.revision && item.kind === "CHECKS")).toHaveLength(1);
    const explicitRetryRecoveryResponse = await broker.handler({ source: "agentx.workflow-dispatch-recovery" });
    expect(explicitRetryRecoveryResponse.statusCode).toBe(200);
    const explicitRetryRecovery = JSON.parse(explicitRetryRecoveryResponse.body) as { attempted: number; dispatched: number };
    expect(explicitRetryRecovery.dispatched).toBeGreaterThanOrEqual(1);
    const cancelledRetryOutbox = broker.db.find((item) => item.entityType === "OUTBOX" && item.workspaceId === browserWorkspaceId
      && (item.invocation as { payload?: { workflowMode?: string } } | undefined)?.payload?.workflowMode === "CHECKS").at(-1);
    expect(cancelledRetryOutbox).toBeDefined();
    const cancelledRetryInvocation = WorkerInvocationSchema.parse(cancelledRetryOutbox!.invocation);
    expect(cancelledRetryInvocation.operationId).not.toBe(browserChecksInvocation.operationId);
    const cancelledRetryAdmission = recordOf(cancelledRetryInvocation.payload)?.workflowE2EAdmission as { roundId?: string; groupRunIds?: string[]; candidateDigest?: string } | undefined;
    expect(cancelledRetryAdmission?.roundId).toBeDefined();
    expect(cancelledRetryAdmission?.candidateDigest).toBeDefined();
    expect(cancelledRetryAdmission?.roundId).not.toBe(browserAdmission?.roundId);
    let liveCancelAttempt: { runningContainer?: { id: string; requestId: string; sourceDigest: string; observedAt: string; inspectSha256: string };
      preRequestAbortObservedAt?: string;
      preRequestReceiptSha256?: string;
      cleanup?: { exitCode: number; stderrSha256: string }; response?: { status: number; rawBody: string }; dispatcher?: unknown; error?: string } | undefined;
    let finishLiveCancelObserver!: () => void;
    const liveCancelObserverFinished = new Promise<void>((resolveFinished) => { finishLiveCancelObserver = resolveFinished; });
    cancelBrowserChecksOnRunning = async (ownedContainer: { containerId: string; requestId: string; sourceDigest: string; observedAt: string; inspectBytes: Uint8Array }) => {
      if (liveCancelAttempt !== undefined) return;
      liveCancelAttempt = {};
      try {
        const runningReceipt = Buffer.from(ownedContainer.inspectBytes);
        await persistOriginalEvidencePrimary({ root, kind: "browser-required-owned-container-running-inspect", key: ownedContainer.containerId,
          bytes: runningReceipt, producer: "original Docker inspect bytes captured by the fixed verifier observer at the running-state check before issuing the normal task cancel",
          sourceCandidateDigest: cancelledRetryAdmission!.candidateDigest! });
        const runningContainers = JSON.parse(runningReceipt.toString("utf8")) as Array<{ Id?: string; State?: { Running?: boolean; Status?: string }; Config?: { Labels?: Record<string, string> } }>;
        const runningContainer = runningContainers[0];
        const labels = runningContainer?.Config?.Labels ?? {};
        liveCancelAttempt.runningContainer = { id: ownedContainer.containerId, requestId: ownedContainer.requestId,
          sourceDigest: ownedContainer.sourceDigest, observedAt: ownedContainer.observedAt, inspectSha256: hash(runningReceipt) };
        if (!runningContainer || runningContainer.State?.Running !== true || runningContainer.State.Status !== "running"
          || labels["agentx.owner"] !== "contained-candidate-v1" || runningContainer.Id !== ownedContainer.containerId
          || labels["agentx.source"] !== ownedContainer.sourceDigest)
          throw new Error(`owned running inspect did not match callback identity: ${JSON.stringify({ id: runningContainer?.Id,
            status: runningContainer?.State?.Status, running: runningContainer?.State?.Running, owner: labels["agentx.owner"],
            source: labels["agentx.source"], receiptId: ownedContainer.containerId, receiptSource: ownedContainer.sourceDigest })}`);
        const cancelResponse = await postBrowserOwnerAction(`/v1/dev/tasks/${browserTaskId}/cancel`, { requestId: randomUUID() });
        liveCancelAttempt.response = { status: cancelResponse.status, rawBody: cancelResponse.rawBody };
        await persistOriginalEvidencePrimary({ root, kind: "browser-required-live-cancel-response", key: `/v1/dev/tasks/${browserTaskId}/cancel`,
          bytes: Buffer.from(cancelResponse.rawBody, "utf8"), producer: "actual broker HTTP response while a broker-owned candidate container was observed running",
          sourceCandidateDigest: browserAdmission!.candidateDigest });
        if (cancelResponse.status !== 200) throw new Error(`task cancel returned ${cancelResponse.status}`);
        const cancelOutbox = broker.db.find((item) => item.entityType === "OUTBOX" && item.workspaceId === browserWorkspaceId
          && (item.invocation as { kind?: string; payload?: { targetOperationId?: string } } | undefined)?.kind === "cancel"
          && (item.invocation as { payload?: { targetOperationId?: string } } | undefined)?.payload?.targetOperationId === cancelledRetryInvocation.operationId).at(-1);
        if (cancelOutbox === undefined) throw new Error("the normal task cancel did not enqueue a signed cancel operation for the running CHECKS operation");
        await browserChecksPublisher({ Records: [{ eventName: "INSERT", dynamodb: { NewImage: marshall(cancelOutbox) } }] as never });
        const queuedCancel = broker.db.get(String(cancelOutbox.pk), String(cancelOutbox.sk))!;
        const dispatchedCancel = await browserChecksDispatcher({ Records: [{ messageId: String(cancelOutbox.id), body: JSON.stringify(queuedCancel) }] });
        liveCancelAttempt.dispatcher = dispatchedCancel;
        if (dispatchedCancel.batchItemFailures.length !== 0) throw new Error("worker cancel dispatch was not accepted");
        for (let attempt = 0; attempt < 400 && !browserChecksCancellation.isCancelled(cancelledRetryInvocation.operationId); attempt += 1) {
          await new Promise((resolveWait) => setTimeout(resolveWait, 25));
        }
        if (!browserChecksCancellation.isCancelled(cancelledRetryInvocation.operationId)) throw new Error("cancel was not observed by the active CHECKS worker before releasing its candidate request barrier");
        liveCancelAttempt.preRequestAbortObservedAt = new Date().toISOString();
      } catch (error) {
        liveCancelAttempt.error = error instanceof Error ? error.message : "live cancel failed";
      } finally {
        finishLiveCancelObserver();
      }
    };
    await browserChecksPublisher({ Records: [{ eventName: "INSERT", dynamodb: { NewImage: marshall(cancelledRetryOutbox!) } }] as never });
    const queuedRetryOutbox = broker.db.get(String(cancelledRetryOutbox!.pk), String(cancelledRetryOutbox!.sk))!;
    const cancelledRetryDispatch = await browserChecksDispatcher({ Records: [{ messageId: String(cancelledRetryOutbox!.id), body: JSON.stringify(queuedRetryOutbox) }] });
    expect(cancelledRetryDispatch.batchItemFailures).toEqual([]);
    for (let index = 0; index < 800; index += 1) {
      const operation = broker.db.get(`WORKSPACE#${browserWorkspaceId}`, `OPERATION#${cancelledRetryInvocation.operationId}`);
      if (operation?.status === "CANCELLED" || operation?.status === "INTERRUPTED" || operation?.status === "FAILED") break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    const cancelledRetryOperation = broker.db.get(`WORKSPACE#${browserWorkspaceId}`, `OPERATION#${cancelledRetryInvocation.operationId}`);
    await Promise.race([liveCancelObserverFinished, new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error("the owned-container cancel observer did not finish before its bounded wait")), 5_000))]);
    if (liveCancelAttempt === undefined) throw new Error("live cancel observer completed without a result");
    await writeFile(join(root, "browser-required-live-cancel-state.json"), `${JSON.stringify({ liveCancelAttempt,
      cancelledRetryOperation, cancellationObserved: browserChecksCancellation.isCancelled(cancelledRetryInvocation.operationId),
      journal: await browserChecksJournal.list(), cancelOutboxes: broker.db.find((item) => item.entityType === "OUTBOX" && item.workspaceId === browserWorkspaceId
        && (item.invocation as { kind?: string; payload?: { targetOperationId?: string } } | undefined)?.kind === "cancel"
        && (item.invocation as { payload?: { targetOperationId?: string } } | undefined)?.payload?.targetOperationId === cancelledRetryInvocation.operationId) }, null, 2)}\n`,
    { mode: 0o600, flag: "wx" });
    expect(liveCancelAttempt?.response?.status, JSON.stringify({ liveCancelAttempt, retryRecovery, cancelledRetryOperation })).toBe(200);
    expect(liveCancelAttempt?.error).toBeUndefined();
    expect(liveCancelAttempt?.preRequestAbortObservedAt, "the active worker abort must be observed before candidate stdin can be written").toBeDefined();
    expect(cancelledRetryOperation?.status).toMatch(/^(CANCELLED|INTERRUPTED)$/);
    expect(liveCancelAttempt?.runningContainer, "persisted original inspect must identify the exact owned running candidate before cancel").toBeDefined();
    let containerStillPresent = false;
    let cleanupExitCode = 0;
    let cleanupOutput: Buffer;
    cleanupOutput = Buffer.alloc(0);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        cleanupOutput = execFileSync("docker", ["--host", process.env.DOCKER_HOST!, "inspect", liveCancelAttempt.runningContainer!.id],
          { encoding: "buffer", maxBuffer: 1024 * 1024 });
        containerStillPresent = true;
      } catch (error) {
        const result = error as NodeJS.ErrnoException & { status?: number; stderr?: Buffer };
        cleanupExitCode = result.status ?? -1;
        cleanupOutput = Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(result.message ?? "Docker inspect failed without stderr");
        if (cleanupExitCode === 1 && /no such (?:container|object)/iu.test(cleanupOutput.toString("utf8"))) {
          containerStillPresent = false;
          break;
        }
        throw error;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    await persistOriginalEvidencePrimary({ root, kind: "browser-required-owned-container-post-cancel-inspect", key: liveCancelAttempt.runningContainer!.id,
      bytes: cleanupOutput, producer: "original Docker inspect stdout or stderr after the admitted E2E cancel terminalized",
      sourceCandidateDigest: liveCancelAttempt.runningContainer!.sourceDigest });
    expect(containerStillPresent, "the exact owned container must be removed after cancellation cleanup").toBe(false);
    expect(cleanupExitCode).toBe(1);
    expect(cleanupOutput.toString("utf8")).toMatch(/no such (?:container|object)/iu);
    liveCancelAttempt.cleanup = { exitCode: cleanupExitCode, stderrSha256: hash(cleanupOutput) };
    const durableCandidateState = join(homedir(), ".local", "state", "agentx", "contained-candidate-v1");
    const durableReceiptPaths = (await readdir(durableCandidateState)).filter((name) => name.endsWith(".receipt.json"));
    const matchingDurableReceipts: { path: string; bytes: Buffer; value: { containerId?: string; aborted?: boolean; requestWritten?: boolean;
      cleanup?: string; sourceDigest?: string; recordRef?: string } }[] = [];
    for (const name of durableReceiptPaths) {
      const path = join(durableCandidateState, name);
      const bytes = await readFile(path);
      const value = JSON.parse(bytes.toString("utf8")) as { containerId?: string; aborted?: boolean; requestWritten?: boolean;
        cleanup?: string; sourceDigest?: string; recordRef?: string };
      if (value.containerId === liveCancelAttempt.runningContainer!.id) matchingDurableReceipts.push({ path, bytes, value });
    }
    expect(matchingDurableReceipts).toHaveLength(1);
    const durableAbortReceipt = matchingDurableReceipts[0]!;
    expect(durableAbortReceipt.value).toMatchObject({ requestWritten: false, aborted: true, cleanup: "confirmed",
      containerId: liveCancelAttempt.runningContainer!.id, sourceDigest: liveCancelAttempt.runningContainer!.sourceDigest });
    await persistOriginalEvidencePrimary({ root, kind: "browser-required-pre-request-abort-receipt", key: liveCancelAttempt.runningContainer!.id,
      bytes: durableAbortReceipt.bytes, producer: "original durable contained-candidate process receipt matched by exact owned container ID after the pre-stdin abort and cleanup",
      sourceCandidateDigest: cancelledRetryAdmission!.candidateDigest! });
    liveCancelAttempt.preRequestReceiptSha256 = hash(durableAbortReceipt.bytes);
    const lateGroupBytes = Buffer.from("late evidence must remain bound to the cancelled E2E operation", "utf8");
    const lateGroupRequest = { stage: "init", groupRunId: cancelledRetryAdmission!.groupRunIds![0], totalBytes: lateGroupBytes.byteLength,
      chunkCount: 1, sha256: hash(lateGroupBytes) };
    const lateGroupResponse = await broker.handler({ version: "2.0", routeKey: "POST /v1/internal/workspaces/{workspaceId}/operations/{operationId}/e2e-evidence",
      rawPath: `/v1/internal/workspaces/${browserWorkspaceId}/operations/${cancelledRetryInvocation.operationId}/e2e-evidence`,
      headers: { "content-type": "application/json", "x-agentx-callback-capability": cancelledRetryInvocation.callbackCapability },
      body: JSON.stringify(lateGroupRequest), requestContext: { requestId: randomUUID(), http: { method: "POST" } } });
    await persistOriginalEvidencePrimary({ root, kind: "browser-required-late-cancelled-group-request", key: cancelledRetryInvocation.operationId,
      bytes: Buffer.from(JSON.stringify(lateGroupRequest)), producer: "actual late group-evidence callback request with the original signed CHECKS capability",
      sourceCandidateDigest: cancelledRetryAdmission!.candidateDigest! });
    await persistOriginalEvidencePrimary({ root, kind: "browser-required-late-cancelled-group-response", key: cancelledRetryInvocation.operationId,
      bytes: Buffer.from(lateGroupResponse.body, "utf8"), producer: "actual broker response to a late group-evidence callback after cancellation",
      sourceCandidateDigest: cancelledRetryAdmission!.candidateDigest! });
    expect(lateGroupResponse.statusCode).toBeGreaterThanOrEqual(400);
    expect(broker.db.get(`WORKSPACE#${browserWorkspaceId}`, `WORKFLOW_E2E_UPLOAD#${cancelledRetryInvocation.operationId}#${cancelledRetryAdmission!.groupRunIds![0]}`))
      .toBeUndefined();
    expect(cancelledRetryAdmission?.groupRunIds).toHaveLength(2);
    const workflowAfterLiveCancel = (broker.db.get(`DEVTASK#${browserTaskId}`, "META") as { workflow: { stage: string; state: string;
      e2e?: { qualifiedRound?: unknown; currentRoundId?: string } } }).workflow;
    expect(workflowAfterLiveCancel).toMatchObject({ stage: "VERIFY", state: "BLOCKED" });
    expect(workflowAfterLiveCancel.e2e?.qualifiedRound).toBeUndefined();
    expect(workflowAfterLiveCancel.e2e?.qualifiedRound).toBeUndefined();
    const browserRetryAgainRequestId = randomUUID();
    const browserRetryAgain = await postBrowserOwnerAction(`/v1/dev/tasks/${browserTaskId}/workflow/retry`, {
      requestId: browserRetryAgainRequestId, expectedRevision: workflowAfterLiveCancel ? (broker.db.get(`DEVTASK#${browserTaskId}`, "META") as { workflow: { revision: number } }).workflow.revision : 0,
      instructions: "Start a fresh round after the cancelled attempt; preserve the approved browser requirement.",
    });
    await persistOriginalEvidencePrimary({ root, kind: "browser-required-owner-retry-after-cancel-response", key: `/v1/dev/tasks/${browserTaskId}/workflow/retry`,
      bytes: Buffer.from(browserRetryAgain.rawBody, "utf8"), producer: "actual Owner retry response after the running native E2E operation was cancelled",
      sourceCandidateDigest: browserAdmission!.candidateDigest });
    expect(browserRetryAgain.status, browserRetryAgain.rawBody).toBe(200);
    expect((browserRetryAgain.body.task as DeveloperTaskView).workflow).toMatchObject({ stage: "VERIFY", state: "WAITING" });
    cancelBrowserChecksOnRunning = undefined;
    const successfulRetryRecoveryResponse = await broker.handler({ source: "agentx.workflow-dispatch-recovery" });
    expect(successfulRetryRecoveryResponse.statusCode).toBe(200);
    const successfulRetryOutbox = broker.db.find((item) => item.entityType === "OUTBOX" && item.workspaceId === browserWorkspaceId
      && (item.invocation as { kind?: string; payload?: { workflowMode?: string } } | undefined)?.kind === "task"
      && (item.invocation as { payload?: { workflowMode?: string } } | undefined)?.payload?.workflowMode === "CHECKS").at(-1);
    expect(successfulRetryOutbox).toBeDefined();
    const successfulRetryInvocation = WorkerInvocationSchema.parse(successfulRetryOutbox!.invocation);
    const successfulRetryAdmission = recordOf(successfulRetryInvocation.payload)?.workflowE2EAdmission as { roundId?: string } | undefined;
    expect(successfulRetryAdmission?.roundId).toBeDefined();
    expect(successfulRetryAdmission?.roundId).not.toBe(cancelledRetryAdmission?.roundId);
    await browserChecksPublisher({ Records: [{ eventName: "INSERT", dynamodb: { NewImage: marshall(successfulRetryOutbox!) } }] as never });
    const queuedSuccessfulRetry = broker.db.get(String(successfulRetryOutbox!.pk), String(successfulRetryOutbox!.sk))!;
    const successfulRetryDispatch = await browserChecksDispatcher({ Records: [{ messageId: String(successfulRetryOutbox!.id), body: JSON.stringify(queuedSuccessfulRetry) }] });
    expect(successfulRetryDispatch.batchItemFailures).toEqual([]);
    for (let index = 0; index < 800; index += 1) {
      const operation = broker.db.get(`WORKSPACE#${browserWorkspaceId}`, `OPERATION#${successfulRetryInvocation.operationId}`);
      if (operation?.status === "SUCCEEDED" || operation?.status === "FAILED") break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    const successfulRetryOperation = broker.db.get(`WORKSPACE#${browserWorkspaceId}`, `OPERATION#${successfulRetryInvocation.operationId}`);
    const successfulRetryWorkflow = (broker.db.get(`DEVTASK#${browserTaskId}`, "META") as { workflow: { stage: string; state: string;
      e2e?: { qualifiedRound?: unknown } } }).workflow;
    expect(successfulRetryOperation?.status).toBe("SUCCEEDED");
    expect(successfulRetryWorkflow).toMatchObject({ stage: "VERIFY", state: "BLOCKED" });
    expect(successfulRetryWorkflow.e2e?.qualifiedRound).toBeUndefined();
    expect(broker.db.find((item) => item.entityType === "OUTBOX" && item.workspaceId === browserWorkspaceId
      && (item.invocation as { payload?: { workflowMode?: string } } | undefined)?.payload?.workflowMode === "REVIEW")).toHaveLength(0);
    await writeFile(join(root, "browser-required-cancel-retry-receipt.json"), `${JSON.stringify({ taskId: browserTaskId,
      firstRetryRequestId: browserRetryRequestId, firstRetryRevision: queuedRetryWorkflow?.revision, firstRetryDispatch: retryRecovery,
      creatorGrantBeforePause: browserCreatorGrant?.grantId, creatorGrantAfterRestore: broker.db.get(browserCreatorKey.pk, browserCreatorKey.sk)?.grantId,
      pausedRetryDispatch, pausedOutboxCount, stillPausedAfterRestore, restoredOutboxCount, explicitAccessRetryRequestId,
      explicitAccessRetryStatus: explicitAccessRetry.status, explicitRetryRecovery,
      cancelledOperationId: cancelledRetryInvocation.operationId, cancelledRoundId: cancelledRetryAdmission?.roundId,
      cancelResponse: liveCancelAttempt?.response, cancelDispatch: liveCancelAttempt?.dispatcher, cancelError: liveCancelAttempt?.error,
      preRequestAbortObservedAt: liveCancelAttempt?.preRequestAbortObservedAt, preRequestReceiptSha256: liveCancelAttempt?.preRequestReceiptSha256,
      cancelledOperation: cancelledRetryOperation, retryAgainRequestId: browserRetryAgainRequestId,
      successfulRetryOperationId: successfulRetryInvocation.operationId, successfulRetryRoundId: successfulRetryAdmission?.roundId,
      successfulRetryDispatch, successfulRetryOperation, finalWorkflow: successfulRetryWorkflow }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    expect(browserViewerProjection?.shared.e2e.status).toBe("UNKNOWN");
    const ownerPageApiCall = async (method: string, path: string, headers: Record<string, string>, body?: unknown) => {
      const response = await broker.handler({ version: "2.0", routeKey: "ANY /review/{proxy+}", rawPath: path, rawQueryString: "", headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), requestContext: { requestId: randomUUID(), http: { method } } });
      return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
    };
    const ownerPeopleRead = await call(broker.handler, { method: "GET", path: `/v1/dev/tasks/${browserTaskId}/people`,
      headers: { authorization: "Bearer synthetic-owner-session" } });
    expect(ownerPeopleRead.status, JSON.stringify(ownerPeopleRead.body)).toBe(200);
    const ownerPeopleView = ownerPeopleRead.body.view as { revision: number; people: Array<{ personId: string; name: string; role: string }> };
    const taskViewer = ownerPeopleView.people.find((person) => person.name === "Task Viewer");
    expect(taskViewer, "the current task directory registers the eligible viewer before Owner approval").toBeDefined();
    const ownerPageCookie = `__Host-agentx_review_session=${ownerSessionId}`;
    const ownerPageState = await ownerPageApiCall("GET", `/review/${browserTaskId}/task/api/state`, { cookie: ownerPageCookie });
    expect(ownerPageState.status, JSON.stringify(ownerPageState.body)).toBe(200);
    const peopleCsrf = String(ownerPageState.body.csrf);
    expect(peopleCsrf).toMatch(/^[A-Za-z0-9_-]{32,64}$/);
    const peopleRequestId = randomUUID();
    const peopleApiHeaders = { cookie: `${ownerPageCookie}; __Host-agentx_review_csrf=${peopleCsrf}`, origin: issuer,
      "x-agentx-csrf": peopleCsrf, "content-type": "application/json" };
    const peopleProposal = await ownerPageApiCall("POST", `/review/${browserTaskId}/task/api/people/role`, peopleApiHeaders,
      { requestId: peopleRequestId, expectedPeopleRevision: ownerPeopleView.revision, personId: taskViewer!.personId, role: "viewer" });
    expect(peopleProposal.status, JSON.stringify(peopleProposal.body)).toBe(202);
    const peopleConfirmation = await ownerPageApiCall("POST", `/review/${browserTaskId}/task/api/people/requests/${peopleRequestId}/confirm`,
      peopleApiHeaders, { requestId: peopleRequestId });
    expect(peopleConfirmation.status, JSON.stringify(peopleConfirmation.body)).toBe(200);
    expect(peopleConfirmation.body.status).toBe("COMMITTED");
    expect((peopleConfirmation.body.view as { people: Array<{ personId: string; role: string }> }).people)
      .toEqual(expect.arrayContaining([expect.objectContaining({ personId: taskViewer!.personId, role: "viewer" })]));
    const authorizedViewerRead = await ownerPageApiCall("GET", `/review/${browserTaskId}/task/api/state`, {
      cookie: `__Host-agentx_review_session=${taskViewerSessionId}` });
    expect(authorizedViewerRead.status, JSON.stringify(authorizedViewerRead.body)).toBe(200);
    expect(authorizedViewerRead.body).toMatchObject({ canRead: true, canDecide: false, canManagePeople: false });
    const authorizedViewerSendBack = await call(broker.handler, { method: "POST", path: `/v1/dev/tasks/${browserTaskId}/workflow/send-back`,
      headers: { authorization: "Bearer synthetic-task-viewer-session" }, body: { requestId: randomUUID(), expectedRevision: browserWorkflow.revision,
        instructions: "A current task viewer may read but cannot send work back." } });
    expect(authorizedViewerSendBack.status, JSON.stringify(authorizedViewerSendBack.body)).toBe(404);
    const viewerAccessPrimary = await persistOriginalEvidencePrimary({ root, kind: "task-people-approved-viewer-read-and-command-denial",
      key: `/review/${browserTaskId}/task/api/state viewer read and workflow SendBack`, bytes: JSON.stringify({ ownerPeopleRead, ownerPageState,
        peopleProposal, peopleConfirmation, authorizedViewerRead, authorizedViewerSendBack }),
      producer: "normal Owner People proposal and CSRF-protected confirmation followed by authenticated role-aware task page and workflow routes",
      sourceCandidateDigest: browserAdmission!.candidateDigest });
    await writeFile(join(root, "task-viewer-authorization-receipt.json"), `${JSON.stringify({ taskId: browserTaskId,
      personId: taskViewer?.personId, peopleRevisionBefore: ownerPeopleView.revision, proposal: peopleProposal,
      confirmation: peopleConfirmation, viewerReadStatus: authorizedViewerRead.status, viewerCanRead: authorizedViewerRead.body.canRead,
      viewerCanDecide: authorizedViewerRead.body.canDecide, viewerSendBackStatus: authorizedViewerSendBack.status,
      primary: viewerAccessPrimary }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    const browserNegativePrimary = await persistOriginalEvidencePrimary({ root, kind: "browser-required-current-round-unknown",
      key: `/v1/dev/tasks/${browserTaskId}`, bytes: JSON.stringify({ http: browserOwnerRead, workflow: browserWorkflow,
        viewerHttp: browserViewerRead, viewerSendBack: browserViewerSendBack, ownerSendBack: browserOwnerSendBack, browserShare, browserNotice,
        browserNoticePost,
        criterion: browserCriterion, unavailableCriteria: browserAdmissionObject?.plan.unavailableCriteria, reviewOutbox: browserReviewOutbox,
        admissionPrimary: browserAdmissionPrimary, evidencePrimary: browserEvidencePrimary, viewerProjection: browserViewerProjection?.shared }),
      producer: "actual normal task/Owner approval/worker CHECKS route with source-derived required browser criterion",
      sourceCandidateDigest: browserAdmissionObject ? String((broker.db.get(`DEVTASK#${browserTaskId}`, "META") as { workflow: { candidate?: { digest?: string } } }).workflow.candidate?.digest ?? "unavailable") : "unavailable" });
    await writeFile(join(root, "browser-required-unknown-receipt.json"), `${JSON.stringify({ taskId: browserTaskId,
      planArtifact: browserCanonicalArtifact, ownerGraphApproval: browserGraphApproval.body, planOperationId: browserPlanInvocation.operationId,
      implementationOperationId: browserImplementInvocation.operationId, checksOperationId: browserChecksInvocation.operationId,
      candidateExport: browserImplementationResult.workflowCandidateSourceExport, checksDispatch: browserChecksDispatch,
      criterion: browserCriterion, unavailableCriteria: browserAdmissionObject?.plan.unavailableCriteria, workflow: browserWorkflow,
      reviewOutbox: browserReviewOutbox ?? null, ownerHttp: browserOwnerRead, viewerHttp: browserViewerRead,
      viewerSendBack: browserViewerSendBack, ownerSendBack: browserOwnerSendBack, browserShare, browserNotice, browserNoticePost,
      viewerStatus: browserViewerProjection?.shared.e2e.status, admissionPrimary: browserAdmissionPrimary, evidencePrimary: browserEvidencePrimary,
      primary: browserNegativePrimary }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  }, 70_000);
});

describe("P0 setup proposal broker authority", () => {
  it("keeps an untrusted feature E2E proposal inside canonical PlanDocument bytes", () => {
    const proposed = {
      schemaVersion: 1 as const,
      requestedTargetIds: ["ordinary-orders-web"],
      accountContextRefs: [{ applicationId: "ordinary-orders", profileId: "synthetic", sourcePath: "package.json", sourceSha256: "a".repeat(64) }],
      scenarios: [{ scenarioId: "orders-list", requirementId: "list-orders", requestedTargetIds: ["ordinary-orders-web"], required: true,
        accountProfileId: "synthetic", minimumEvidence: "source" as const, requiredRealComponentIds: [],
        steps: [{ kind: "navigate" as const, path: "/orders" }], assertions: [{ kind: "visible" as const, testId: "orders-list", equals: true }] }],
      semanticExportDeltas: [],
    };
    const rawPlan = { schemaVersion: 1, title: "List orders", why: [{ text: "Owner requested an orders view.", author: "planner" }],
      claims: [{ id: "1", text: "Show orders." }], notChanging: ["Existing access rules."], risks: ["Missing source fixture."], decisions: [], e2e: proposed };
    const parsed = parsePlanDocument(`\`\`\`agentx-plan\n${JSON.stringify(rawPlan)}\n\`\`\``, { kind: "plan" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const canonical = canonicalPlanJson(parsed.plan);
    expect(readCanonicalPlan(canonical)?.e2e).toEqual(proposed);
    expect(parsed.plan.e2e).toEqual(proposed);
    expect(planDocumentMarkdown(parsed.plan, { kind: "plan", version: 1, sha256: hash(Buffer.from(canonical)) }))
      .toContain("The following scenarios and expected values are untrusted model proposals.");
  });

  it("uses a distinct bounded setup-smoke invocation instead of fabricating a feature task", () => {
    const workspaceId = randomUUID();
    const invocation = WorkerInvocationSchema.safeParse({
      protocolVersion: 1,
      operationId: randomUUID(), workspaceId, fence: 1, projectRevision: 1,
      callbackCapability: "setup-capability-".padEnd(32, "x"),
      kind: "project-setup-smoke",
      payload: {
        domain: "project-setup-source-interface/v1",
        setupExecutionId: randomUUID(),
        subjectId: randomUUID(),
        approvalRevision: 1,
        transportCorrelationId: workspaceId,
        executionRef: { key: "project-setup-executions/sha256/" + "a".repeat(64) + ".json", sha256: "a".repeat(64), byteLength: 1 },
      },
    });
    expect(invocation.success, "setup smoke must have its own strict invocation domain").toBe(true);
    expect(WorkerInvocationSchema.safeParse({
      protocolVersion: 1, operationId: randomUUID(), workspaceId: randomUUID(), fence: 1, projectRevision: 1,
      callbackCapability: "setup-capability-".padEnd(32, "x"), kind: "project-setup-smoke",
      payload: { domain: "project-setup-source-interface/v1", setupExecutionId: randomUUID(), subjectId: randomUUID(), approvalRevision: 1, transportCorrelationId: randomUUID(),
        executionRef: { key: "project-setup-executions/sha256/" + "a".repeat(64) + ".json", sha256: "a".repeat(64), byteLength: 1 }, prompt: "feature task" },
    }).success).toBe(false);
  });

  it("routes setup invocations through setup authority and never through the feature task guard", async () => {
    const operationId = randomUUID();
    const workspaceId = randomUUID();
    const invocation = {
      protocolVersion: 1 as const, operationId, workspaceId, fence: 1, projectRevision: 1,
      callbackCapability: "setup-capability-".padEnd(32, "x"), kind: "project-setup-smoke" as const,
      payload: { domain: "project-setup-source-interface/v1" as const, setupExecutionId: randomUUID(), subjectId: randomUUID(), approvalRevision: 1, transportCorrelationId: workspaceId,
        executionRef: { key: `project-setup-executions/sha256/${"a".repeat(64)}.json`, sha256: "a".repeat(64), byteLength: 1 } },
    };
    const order: string[] = [];
    const handler = createDispatcherHandler({
      guardTaskDispatch: async () => { order.push("task-guard"); throw new Error("setup cannot enter feature task guard"); },
      guardProjectSetupDispatch: async (record) => { order.push("setup-guard"); expect(record.invocation.kind).toBe("project-setup-smoke"); return "ALLOWED"; },
      projectSetupLifecycle: {
        markDispatching: async () => { order.push("setup-state-dispatching"); return true; },
        markDelivered: async () => { order.push("setup-state-delivered"); },
        markFailed: async () => { order.push("setup-state-failed"); },
      },
      markDispatching: async () => { order.push("mark-dispatching"); return true; },
      markDelivered: async () => { order.push("mark-delivered"); },
      markFailed: async () => { order.push("mark-failed"); },
      deliverEc2: async () => { order.push("deliver"); return "DELIVERED"; },
    });
    const result = await handler({ Records: [{ messageId: "setup-msg", body: JSON.stringify({
      id: randomUUID(), entityType: "OUTBOX", status: "QUEUED", operationId, workspaceId: invocation.workspaceId,
      deploymentMode: "ec2-ebs", invocation,
    }) }] });
    expect(result.batchItemFailures).toEqual([]);
    expect(order).toEqual(["setup-guard", "setup-state-dispatching", "deliver", "setup-state-delivered", "mark-delivered"]);
  });

  it("fails setup dispatch closed before dispatch state when its separate authority port is absent", async () => {
    const operationId = randomUUID();
    const workspaceId = randomUUID();
    let sideEffects = 0;
    const handler = createDispatcherHandler({
      guardTaskDispatch: async () => { throw new Error("feature task guard must not authorize setup"); },
      markDispatching: async () => { sideEffects += 1; return true; }, markDelivered: async () => { sideEffects += 1; },
      markFailed: async () => { sideEffects += 1; }, deliverEc2: async () => { sideEffects += 1; return "DELIVERED"; },
    });
    const result = await handler({ Records: [{ messageId: "setup-no-authority", body: JSON.stringify({
      id: randomUUID(), entityType: "OUTBOX", status: "QUEUED", operationId, workspaceId, deploymentMode: "ec2-ebs",
      invocation: { protocolVersion: 1, operationId, workspaceId, fence: 1, projectRevision: 1, callbackCapability: "setup-capability-".padEnd(32, "x"),
        kind: "project-setup-smoke", payload: { domain: "project-setup-source-interface/v1", setupExecutionId: randomUUID(), subjectId: randomUUID(), approvalRevision: 1, transportCorrelationId: workspaceId,
          executionRef: { key: `project-setup-executions/sha256/${"a".repeat(64)}.json`, sha256: "a".repeat(64), byteLength: 1 } } },
    }) }] });
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "setup-no-authority" }]);
    expect(sideEffects).toBe(0);
  });

  it("does not fall back to workspace sessions or runtime binding for an unconfigured setup transport", async () => {
    const workspaceId = randomUUID();
    const operationId = randomUUID();
    const setupExecutionId = randomUUID();
    const subjectId = randomUUID();
    const invocation = WorkerInvocationSchema.parse({ protocolVersion: 1, operationId, workspaceId, fence: 1, projectRevision: 1,
      callbackCapability: `setup-${randomUUID()}`, kind: "project-setup-smoke",
      payload: { domain: "project-setup-source-interface/v1", setupExecutionId, subjectId, approvalRevision: 1, transportCorrelationId: workspaceId,
        executionRef: { key: `project-setup-executions/sha256/${"b".repeat(64)}.json`, sha256: "b".repeat(64), byteLength: 1 } } });
    const workspaceSession = vi.fn(async () => ({ ready: true as const, generation: 1, privateIp: "127.0.0.1" }));
    const workspaceBinding = vi.fn(async () => ({ deploymentMode: "ec2-ebs" as const, launchTemplateId: "lt-0123456789abcdef0",
      subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0123456789abcdef0" }], volumeSizeGiB: 20, volumeType: "gp3" as const }));
    const deliver = createEc2Delivery({ sessions: { ensureSession: workspaceSession }, binding: workspaceBinding,
      sign: async () => new Uint8Array(), post: async () => ({ status: 200, body: "{}" }), progress: async () => undefined,
      guardProjectSetupDispatch: async () => "ALLOWED" });
    await expect(deliver({ id: randomUUID(), entityType: "OUTBOX", status: "QUEUED", operationId, workspaceId,
      deploymentMode: "ec2-ebs", invocation }, invocation)).rejects.toThrow("project setup session transport is not configured");
    expect(workspaceSession).not.toHaveBeenCalled();
    expect(workspaceBinding).not.toHaveBeenCalled();
  });

  it("rechecks current setup authority after signing and before the worker POST", async () => {
    const workspaceId = randomUUID();
    const operationId = randomUUID();
    const invocation = WorkerInvocationSchema.parse({ protocolVersion: 1, operationId, workspaceId, fence: 1, projectRevision: 1,
      callbackCapability: `setup-${randomUUID()}`, kind: "project-setup-smoke",
      payload: { domain: "project-setup-source-interface/v1", setupExecutionId: randomUUID(), subjectId: randomUUID(), approvalRevision: 1,
        transportCorrelationId: workspaceId, executionRef: { key: `project-setup-executions/sha256/${"c".repeat(64)}.json`, sha256: "c".repeat(64), byteLength: 1 } } });
    const guardProjectSetupDispatch = vi.fn()
      .mockResolvedValueOnce("ALLOWED")
      .mockResolvedValueOnce("ALLOWED")
      .mockResolvedValueOnce("ALLOWED")
      .mockResolvedValueOnce("PARKED");
    const post = vi.fn(async () => ({ status: 200, body: "{}" }));
    const delivery = createEc2Delivery({
      sessions: { ensureSession: async () => { throw new Error("setup must not use workspace sessions"); } },
      binding: async () => { throw new Error("setup must not load workspace binding"); },
      projectSetupSessions: { ensureSession: async () => ({ ready: true as const, generation: 1, privateIp: "127.0.0.1" }) },
      projectSetupBinding: async () => ({ deploymentMode: "ec2-ebs" as const, launchTemplateId: "lt-0123456789abcdef0",
        subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0123456789abcdef0" }], volumeSizeGiB: 20, volumeType: "gp3" as const }),
      sign: async () => new Uint8Array([1]), post, progress: async () => undefined,
      workerFeatures: async () => ["project.setupSmoke"], guardProjectSetupDispatch,
    });
    const result = await delivery({ id: randomUUID(), entityType: "OUTBOX", status: "QUEUED", operationId, workspaceId,
      deploymentMode: "ec2-ebs", invocation }, invocation);
    expect(result).toBe("WAITING_FOR_TASK_ACCESS");
    expect(guardProjectSetupDispatch).toHaveBeenCalledTimes(4);
    expect(post).not.toHaveBeenCalled();
  });

  it("captures the selected immutable repository through the authenticated broker route", async () => {
    const source = Buffer.from('{"name":"ordinary-orders","type":"module"}\n');
    const repositoryId = "acme/ordinary-orders";
    const commitSha = "a".repeat(40);
    const treeSha = "b".repeat(40);
    const candidate = createCandidateManifest([{ repositoryId, commitSha, treeSha }]);
    const sourcePort = { capture: vi.fn(async () => ({
      candidate, commitSha, treeSha, treeComplete: true as const,
      treePaths: ["package.json"],
      sources: [{ path: "package.json", sha256: hash(source), bytes: source, kind: "blob" as const }],
    })) };
    const objects = new Map<string, string>();
    const s3 = { send: vi.fn(async (command: never) => {
      const input = (command as unknown as { input: { Key: string; Body?: string | Uint8Array } }).input;
      if (input.Body !== undefined) { objects.set(input.Key, typeof input.Body === "string" ? input.Body : Buffer.from(input.Body).toString("utf8")); return {}; }
      const text = objects.get(input.Key);
      return text === undefined ? {} : { Body: { transformToString: async () => text } };
    }) };
    const broker = createBroker({ s3, extra: { projectSetupSource: sourcePort } });

    const response = await call(broker.handler, {
      method: "POST", path: "/v1/admin/projects/setup-proposals", user: { subject: "owner", admin: true },
      body: { repositoryUrl: "https://github.com/acme/ordinary-orders.git", ref: "main" },
    });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(sourcePort.capture).toHaveBeenCalledWith({ repositoryUrl: "https://github.com/acme/ordinary-orders.git", ref: "main" });
    expect(response.body.candidateDigest).toBe(candidate.digest);
    expect(typeof response.body.proposalRef).toBe("string");
    expect(typeof response.body.proposalSha256).toBe("string");
    expect((response.body.proposalRef as string)).toMatch(new RegExp(`^project-setup-proposals/${createHash("sha256").update("https://identity.example.test\0owner").digest("hex")}/[a-f0-9]{64}\\.json$`));
    expect((response.body.proposalSha256 as string)).toMatch(/^[a-f0-9]{64}$/);
    expect(response.body.proposal).toMatchObject({ candidateDigest: candidate.digest, state: "proposed" });
    const proposalRef = response.body.proposalRef;
    const proposalSha256 = response.body.proposalSha256;
    const storedProposal = JSON.parse(objects.get(String(proposalRef)) ?? "{}") as Record<string, unknown>;
    expect(storedProposal.identityMapping).toEqual({ schemaVersion: "github-source-to-agentx-registration/v1", sourceRepositoryId: repositoryId, registeredRepositoryId: "ordinary-orders" });
    expect(typeof proposalRef).toBe("string");
    expect(typeof proposalSha256).toBe("string");
    const approved = await call(broker.handler, {
      method: "POST", path: "/v1/admin/projects/setup-approvals", user: { subject: "owner", admin: true },
      body: { projectName: "ordinary-orders", proposalRef, proposalSha256, decision: "approve" },
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body).toMatchObject({ decision: "approve", duplicate: false, proposalRef, proposalSha256 });
  });
});
