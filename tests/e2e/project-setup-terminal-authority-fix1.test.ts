import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID, sign as cryptoSign } from "node:crypto";
import { release as osRelease } from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GitHubRepositoryApi } from "../../packages/cli/src/setup/project-files.js";
import { addProject, ec2Binding } from "../../packages/cli/src/setup/project-add.js";
import { fakeControlPlane, FOUNDATION_OUTPUTS } from "../../tests/support/setup-fakes.js";
import { scriptedPrompter } from "../../tests/support/init-fakes.js";
import {
  canonicalJson, canonicalPlanJson, createCandidateManifest, WorkerInvocationSchema, parsePlanDocument, readCanonicalPlan,
  planDocumentMarkdown, type E2EPolicy, type E2ESourceSnapshot,
} from "@agentx/contracts";
import { call, createBroker, issuer, loadSlackBroker } from "../../tests/support/slack-broker.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { beforeAll, vi } from "vitest";
import { GitHubAppCredentialProvider } from "../../packages/broker/src/github-app.js";
import { createDispatcherHandler } from "../../packages/broker/src/aws/dispatcher.js";
import { createEc2Delivery } from "../../packages/broker/src/aws/ec2-delivery.js";
import { createOutboxPublisherHandler } from "../../packages/broker/src/aws/outbox-publisher.js";
import { createProjectSetupBindingReader, createProjectSetupDispatchGuard, createProjectSetupDispatchLifecycle } from "../../packages/broker/src/aws/dispatcher.js";
import { ProjectSetupSessionManager } from "../../packages/broker/src/aws/sessions.js";
import { OperationJournal } from "../../packages/worker/src/journal.js";
import { createWorkerServerState, handleWorkerRequest } from "../../packages/worker/src/server.js";
import { createDefaultProjectSetupExecutor } from "../../packages/worker/src/project-setup-executor.js";
import { postProjectSetupTerminalResult } from "../../packages/worker/src/project-setup-callback.js";
import { marshall } from "@aws-sdk/util-dynamodb";
import { inspectE2ERepository } from "../../packages/broker/src/e2e/discovery.js";
import { deriveProjectSetupSourceSmoke } from "../../packages/broker/src/e2e/project-setup-source-smoke.js";
import { admitProjectSetupRuntime, projectSetupBindingDigest, projectSetupRuntimeKey, ProjectSetupRuntimeRecordSchema } from "../../packages/broker/src/aws/project-setup-runtime-catalog.js";
import { selectE2EExecutionPlan } from "../../packages/broker/src/e2e/execution-plan.js";
import { taskGraphDigest } from "../../packages/contracts/src/workflow-dependencies.js";
import { persistOriginalEvidencePrimary, persistOriginalMapPrimary } from "../support/p0-evidence-capture.js";

beforeAll(async () => { await loadSlackBroker(); });
afterEach(() => vi.unstubAllGlobals());

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const gitBytes = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args]);
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const gitBlob = (cwd: string, revision: string, path: string): Buffer | undefined => {
  try { execFileSync("git", ["-C", cwd, "cat-file", "-e", `${revision}:${path}`], { stdio: "ignore" }); }
  catch { return undefined; }
  return gitBytes(cwd, "show", `${revision}:${path}`);
};

describe("P0 normal project onboarding journey", () => {
  it.each(["unchanged", "admin-revocation", "runtime-generation", "runtime-correlation"] as const)(
    "rejects setup terminal qualification after current authority changes: %s", async (authorityMutation) => {
    const evidenceRoot = process.env.CONTAINED_FOUNDATION_EVIDENCE_DIR;
    expect(evidenceRoot, "CONTAINED_FOUNDATION_EVIDENCE_DIR must be pre-created outside the fresh TMPDIR").toBeDefined();
    const root = resolve(evidenceRoot!, "native-journey", `5a-normal-discovery-${randomUUID()}`);
    const repositoryRoot = join(root, "selected-repository");
    const projectConfig = join(root, "project-config");
    await mkdir(join(repositoryRoot, "src"), { recursive: true });
    await mkdir(join(repositoryRoot, "admin", "src"), { recursive: true });
    await mkdir(join(repositoryRoot, "api"), { recursive: true });
    await mkdir(join(repositoryRoot, "api", "fixtures"), { recursive: true });
    await mkdir(join(repositoryRoot, "android", "app"), { recursive: true });
    await mkdir(join(repositoryRoot, "ios"), { recursive: true });
    await mkdir(join(repositoryRoot, "desktop"), { recursive: true });
    await mkdir(projectConfig, { recursive: true, mode: 0o700 });
    const sourceFiles = {
      "package.json": JSON.stringify({ name: "ordinary-orders", type: "module", exports: { ".": "./src/index.mjs" }, scripts: { build: "node --check src/index.mjs", test: "node --test" } }, null, 2) + "\n",
      "package-lock.json": JSON.stringify({ name: "ordinary-orders", lockfileVersion: 3, packages: { "": { name: "ordinary-orders" } } }, null, 2) + "\n",
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
      if (bytes === undefined) return {};
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
    const runtimeBinding = ec2Binding(FOUNDATION_OUTPUTS, "agentx-staging-foundation");
    const runtimeCatalogKey = projectSetupRuntimeKey(runtimeCatalogId, projectSetupBindingDigest(runtimeBinding));
    const localRunnerToolchain = { execPath: process.execPath, version: process.version as "v22.23.2", platform: process.platform, arch: process.arch };
    const ownerDeveloperId = ownerKeyForSubject(issuer, "owner");
    const ownerSessionId = randomUUID();
    const broker = createBroker({ s3, developer: {
      issuer, env: "staging", methods: { slack: false, oidc: true }, signInTableName: "state",
      workflowDependenciesEnabled: true,
      channelMembers: async () => ({ ok: true, memberOf: [] }),
      verifyAccessToken: async () => ({ iss: issuer, aud: "agentx-developer", env: "staging", sub: ownerDeveloperId, sid: ownerSessionId, amr: "oidc" }),
    }, turnRecordsTableName: "turns", extra: { projectSetupSource: sourcePort, projectSetupRuntimeCatalogId: runtimeCatalogId } });
    broker.db.set({ pk: `SESSION#${ownerSessionId}`, sk: "META", sessionId: ownerSessionId, developerId: ownerDeveloperId, amr: "oidc",
      startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 60_000 });
    broker.db.set({ pk: `DEVELOPER#${ownerDeveloperId}`, sk: "META", developerId: ownerDeveloperId, provider: "oidc", displayName: "Owner", firstSignInAt: "fixture", lastSignInAt: "fixture", revoked: false });
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
      brokerRouteObservations.push({ path: url.pathname, status: response.status, body: response.status >= 400 ? response.body : {
        accepted: response.body.accepted, parked: response.body.parked, qualification: response.body.qualification,
        uploadId: response.body.uploadId, evidenceRef: response.body.evidenceRef,
      }, ...(url.pathname.endsWith("/evidence/chunks") ? { uploadFields } : {}) });
      return new Response(JSON.stringify(response.body), { status: response.status, headers: { "content-type": "application/json" } });
    };
    vi.stubGlobal("fetch", brokerFetch);
    let terminalStatus: string | undefined;
    const workerPosts: Array<{ status: number; body: string }> = [];
    const brokerRouteObservations: Array<{ path: string; status: number; body: Record<string, unknown> }> = [];
    let terminalMutationApplied = false;
    const foreignTerminalStatuses: number[] = [];
    const workerState = createWorkerServerState(journal, {
      invocationFeatures: ["project.setupSmoke"],
      execute: createDefaultProjectSetupExecutor({ sourceRoot: process.cwd(), evidenceRoot: evidenceRootForWorker, controlPlaneUrl: "http://setup-broker.invalid" }),
    }, { onTerminal: async (result, invocation) => {
      terminalStatus = result.status;
      if (invocation.kind !== "project-setup-smoke") throw new Error("setup callback must retain its invocation domain");
      if (!terminalMutationApplied && authorityMutation === "admin-revocation") {
        terminalMutationApplied = true;
        const currentMember = broker.db.get(`MEMBER#${String(executionRow.ownerKey)}`, "PROJECT#ordinary-orders");
        expect(currentMember?.role).toBe("administrator");
        broker.db.set({ ...currentMember!, role: "viewer" });
        await writeFile(join(root, "revocation-before-terminal.json"), JSON.stringify({ ownerKey: executionRow.ownerKey, previousRole: currentMember?.role, currentRole: "viewer" }), { flag: "wx" });
      } else if (!terminalMutationApplied && authorityMutation !== "unchanged") {
        terminalMutationApplied = true;
        const currentRuntime = broker.db.get(runtimeCatalogKey.pk, runtimeCatalogKey.sk)!;
        const replacementRuntime = authorityMutation === "runtime-generation"
          ? { ...currentRuntime, generation: Number(currentRuntime.generation) + 1 }
          : { ...currentRuntime, transportCorrelationId: randomUUID() };
        broker.db.set(replacementRuntime);
        await writeFile(join(root, `${authorityMutation}-before-terminal.json`), JSON.stringify({ oldRuntime: currentRuntime, currentRuntime: replacementRuntime,
          execution: broker.db.get(`PROJECT_SETUP#${setupExecutionId}`, "EXECUTION") }), { flag: "wx" });
      }
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
    const executionOriginals = [proposalPrimary, executionPrimary];
    for (let index = 0; index < 200 && terminalStatus === undefined; index += 1) await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    for (let index = 0; index < 600 && brokerRouteObservations.every(({ path }) => !path.endsWith(`/operations/${actualInvocation.operationId}/result`)); index += 1) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    if (authorityMutation !== "unchanged") {
      const terminalObservation = brokerRouteObservations.filter(({ path }) => path.endsWith(`/operations/${actualInvocation.operationId}/result`)).at(-1);
      expect(terminalObservation?.status, JSON.stringify({ brokerRouteObservations, workerPosts, terminalStatus,
        execution: broker.db.get(`PROJECT_SETUP#${setupExecutionId}`, "EXECUTION"),
        operation: broker.db.get(`PROJECT_SETUP#${setupExecutionId}`, `OPERATION#${actualInvocation.operationId}`) })).toBe(200);
      expect(terminalObservation?.body).toMatchObject({ accepted: true, parked: true, qualification: "UNKNOWN" });
      expect(broker.db.get(`PROJECT_SETUP#${setupExecutionId}`, "EXECUTION")).toMatchObject({ state: "PARKED", result: { qualification: "UNKNOWN", processStatus: "UNKNOWN" } });
      expect(broker.db.get(`PROJECT_SETUP#${setupExecutionId}`, `OPERATION#${actualInvocation.operationId}`)).toMatchObject({ status: "PARKED" });
      const foreignOperationId = randomUUID();
      const forged = await call(broker.handler, { method: "POST", path: `/v1/internal/project-setups/${setupExecutionId}/operations/${foreignOperationId}/result`,
        headers: { "x-agentx-callback-capability": (outboxRow.invocation as { callbackCapability: string }).callbackCapability },
        body: { domain: "project-setup-source-interface/v1", setupExecutionId, operationId: foreignOperationId, candidateDigest: snapshot.candidate.digest,
          processStatus: "SUCCEEDED", qualification: "PASS", cleanupConfirmed: true } });
      foreignTerminalStatuses.push(forged.status);
      expect([403, 409], "a valid token cannot park another operation").toContain(forged.status);
      if (authorityMutation === "admin-revocation") {
        broker.db.set({ pk: `MEMBER#${String(executionRow.ownerKey)}`, sk: "PROJECT#ordinary-orders", entityType: "MEMBERSHIP", ownerKey: executionRow.ownerKey,
          projectName: "ordinary-orders", role: "administrator", grantedBy: { issuer, subject: "owner" }, grantedAt: new Date().toISOString() });
      } else broker.db.set(rawRuntime);
      const oldEvidenceRef = brokerRouteObservations.filter(({ path }) => path.endsWith(`/operations/${actualInvocation.operationId}/evidence/finalize`)).at(-1)?.body.evidenceRef as { key: string; sha256: string } | undefined;
      const staleReplay = await call(broker.handler, { method: "POST", path: `/v1/internal/project-setups/${setupExecutionId}/operations/${actualInvocation.operationId}/result`,
        headers: { "x-agentx-callback-capability": (outboxRow.invocation as { callbackCapability: string }).callbackCapability },
        body: { domain: "project-setup-source-interface/v1", setupExecutionId, operationId: actualInvocation.operationId, candidateDigest: snapshot.candidate.digest,
          processStatus: "SUCCEEDED", qualification: "PASS", cleanupConfirmed: true, ...(oldEvidenceRef ? { evidenceRef: oldEvidenceRef } : {}) } });
      expect(staleReplay.status, "restoring authority cannot revive the old setup capability").toBe(409);
      expect(broker.db.get(`PROJECT_SETUP#${setupExecutionId}`, "EXECUTION")).toMatchObject({ state: "PARKED", result: { qualification: "UNKNOWN" } });
      expect(broker.db.find((item) => item.entityType === "OUTBOX" && (item.invocation as { kind?: string } | undefined)?.kind === "project-setup-smoke")).toHaveLength(1);
      const retryPath = `/v1/admin/projects/setup-executions/${setupExecutionId}/retry`;
      const foreignRetry = await call(broker.handler, { method: "POST", path: retryPath, user: { subject: "another-owner", admin: true }, body: { requestId: randomUUID() } });
      expect([403, 409], "an unrelated administrator cannot retry the original creator's setup").toContain(foreignRetry.status);
      const projectRow = broker.db.find((item) => item.entityType === "PROJECT" && (item.definition as { name?: string } | undefined)?.name === "ordinary-orders")[0]!;
      broker.db.set({ ...projectRow, runtimeBinding: { ...(projectRow.runtimeBinding as Record<string, unknown>), volumeSizeGiB: 21 } });
      const changedBindingRetry = await call(broker.handler, { method: "POST", path: retryPath, user: { subject: "owner", admin: true }, body: { requestId: randomUUID() } });
      expect([409, 503], "a changed runtime binding requires normal reapproval before allocation").toContain(changedBindingRetry.status);
      broker.db.set(projectRow);
      const originalRuntime = broker.db.get(runtimeCatalogKey.pk, runtimeCatalogKey.sk)!;
      broker.db.set({ ...originalRuntime, runtimeCatalogId: "replacement-catalog" });
      const changedCatalogRetry = await call(broker.handler, { method: "POST", path: retryPath, user: { subject: "owner", admin: true }, body: { requestId: randomUUID() } });
      expect([409, 503], "a changed runtime catalog requires normal reapproval before allocation").toContain(changedCatalogRetry.status);
      broker.db.set(originalRuntime);
      const originalProjectDefinition = projectRow.definition as Record<string, unknown>;
      const originalPolicy = originalProjectDefinition.e2e as { limits: Record<string, number | undefined> };
      const originalTimeout = originalPolicy.limits.runTimeoutMs;
      if (typeof originalTimeout !== "number") throw new Error("the approved setup policy must retain its run timeout");
      broker.db.set({ ...projectRow, definition: { ...originalProjectDefinition, e2e: { ...originalPolicy, limits: { ...originalPolicy.limits, runTimeoutMs: originalTimeout + 1 } } } });
      const changedPolicyRetry = await call(broker.handler, { method: "POST", path: retryPath, user: { subject: "owner", admin: true }, body: { requestId: randomUUID() } });
      expect([409, 503], "a changed source policy requires normal reapproval before allocation").toContain(changedPolicyRetry.status);
      broker.db.set(projectRow);
      expect(broker.db.find((item) => item.entityType === "OUTBOX" && (item.invocation as { kind?: string } | undefined)?.kind === "project-setup-smoke")).toHaveLength(1);
      const retryRequestId = randomUUID();
      const retry = await call(broker.handler, { method: "POST", path: `/v1/admin/projects/setup-executions/${setupExecutionId}/retry`,
        user: { subject: "owner", admin: true }, body: { requestId: retryRequestId } });
      expect(retry.status, JSON.stringify(retry.body)).toBe(202);
      const retriedExecutionId = String(retry.body.setupExecutionId);
      const retriedOperationId = String(retry.body.operationId);
      expect(retriedExecutionId).not.toBe(setupExecutionId);
      expect(retriedOperationId).not.toBe(actualInvocation.operationId);
      const retriedExecutionRow = broker.db.get(`PROJECT_SETUP#${retriedExecutionId}`, "EXECUTION")!;
      expect(retriedExecutionRow).toMatchObject({ retryOfExecutionId: setupExecutionId, retryActorKey: executionRow.ownerKey,
        proposalSha256: executionRow.proposalSha256, candidateDigest: executionRow.candidateDigest });
      const retriedExecutionRef = retriedExecutionRow.executionRef as { key: string; sha256: string };
      const retriedPrimary = await persistOriginalMapPrimary({ root, kind: "setup-retry-execution", key: retriedExecutionRef.key, objects,
        producer: "broker explicit Owner retry admission", sourceCandidateDigest: snapshot.candidate.digest });
      expect(retriedPrimary.sha256).toBe(retriedExecutionRef.sha256);
      const retryOutbox = broker.db.find((item) => item.entityType === "OUTBOX" && item.operationId === retriedOperationId)[0]!;
      expect(retryOutbox).toBeDefined();
      await publisher({ Records: [{ eventName: "INSERT", dynamodb: { NewImage: marshall(retryOutbox) } }] as never });
      const queuedRetry = broker.db.get(String(retryOutbox.pk), String(retryOutbox.sk))!;
      const retryDispatch = await dispatch({ Records: [{ messageId: String(retryOutbox.id), body: JSON.stringify(queuedRetry) }] });
      expect(retryDispatch.batchItemFailures).toEqual([]);
      for (let index = 0; index < 200 && (await journal.get(retriedOperationId))?.status !== "SUCCEEDED"; index += 1) await new Promise((resolveWait) => setTimeout(resolveWait, 25));
      expect(broker.db.get(`PROJECT_SETUP#${retriedExecutionId}`, "EXECUTION")).toMatchObject({ state: "SUCCEEDED", result: { qualification: "PASS", cleanupConfirmed: true } });
      const retryEvidenceRef = (broker.db.get(`PROJECT_SETUP#${retriedExecutionId}`, `OPERATION#${retriedOperationId}`)?.result as { evidenceRef?: { key: string; sha256: string } }).evidenceRef!;
      const retryEvidencePrimary = await persistOriginalMapPrimary({ root, kind: "setup-retry-evidence", key: retryEvidenceRef.key, objects,
        producer: "authenticated fresh setup retry evidence upload", sourceCandidateDigest: snapshot.candidate.digest });
      expect(retryEvidencePrimary.sha256).toBe(retryEvidenceRef.sha256);
      const duplicateRetry = await call(broker.handler, { method: "POST", path: retryPath, user: { subject: "owner", admin: true }, body: { requestId: retryRequestId } });
      expect(duplicateRetry.status).toBe(202);
      expect(duplicateRetry.body).toMatchObject({ duplicate: true, setupExecutionId: retriedExecutionId, operationId: retriedOperationId });
      expect(broker.db.find((item) => item.entityType === "OUTBOX" && (item.invocation as { kind?: string } | undefined)?.kind === "project-setup-smoke")).toHaveLength(2);
      broker.db.delete(`MEMBER#${String(executionRow.ownerKey)}`, "PROJECT#ordinary-orders");
      const revokedDuplicate = await call(broker.handler, { method: "POST", path: retryPath, user: { subject: "owner", admin: true }, body: { requestId: retryRequestId } });
      expect(revokedDuplicate.status, "idempotent retry lookup still rechecks current project authority").toBe(404);
      expect(broker.db.find((item) => item.entityType === "OUTBOX" && (item.invocation as { kind?: string } | undefined)?.kind === "project-setup-smoke")).toHaveLength(2);
      await writeFile(join(root, "park-retry-receipt.json"), JSON.stringify({ oldExecutionId: setupExecutionId, oldOperationId: actualInvocation.operationId,
        foreignTerminalStatuses, oldTerminalStatus: terminalObservation?.status, staleReplayStatus: staleReplay.status, oldFinalState: "PARKED",
        retryStatus: retry.status, retryExecutionId: retriedExecutionId, retryOperationId: retriedOperationId, retryFinalState: "SUCCEEDED", revokedDuplicateStatus: revokedDuplicate.status,
        retryEvidenceRef, originalPrimaries: [retriedPrimary, retryEvidencePrimary] }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      return;
    }
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
      originalPrimaries: [...executionOriginals, setupEvidencePrimary],
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
    broker.db.set({ pk: `MEMBER#${ownerDeveloperId}`, sk: "PROJECT#ordinary-orders", entityType: "MEMBERSHIP", ownerKey: ownerDeveloperId,
      projectName: "ordinary-orders", role: "developer", grantedBy: { issuer, subject: "owner" }, grantedAt: new Date().toISOString() });
    const featureStart = await call(broker.handler, { method: "POST", path: "/v1/dev/tasks", headers: { authorization: "Bearer synthetic-owner-session" },
      body: { requestId: randomUUID(), project: "ordinary-orders", instructions: "Add an orders list using the approved source context", client: "native-p0-journey", workflow: true, workflowPath: "QUICK" } });
    expect(featureStart.status, JSON.stringify(featureStart.body)).toBe(200);
    const featureTaskId = String((featureStart.body.task as { taskId: string }).taskId);
    const featureTask = broker.db.get(`DEVTASK#${featureTaskId}`, "META") as { workspaceId: string; workflow: { revision: number; artifacts: Array<{ type: string; sha256: string; objectKey: string }> } };
    const featureWorkspaceId = featureTask.workspaceId;
    const featureOperations = () => broker.db.find((item) => item.pk === `WORKSPACE#${featureWorkspaceId}` && item.entityType === "OPERATION");
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
    const e2eIntent = {
      schemaVersion: 1 as const, requestedTargetIds: ["web-1"],
      accountContextRefs: [{ applicationId: "ordinary-orders", profileId: "synthetic", sourcePath: "package.json", sourceSha256: hash(Buffer.from(sourceFiles["package.json"])) }],
      scenarios: [{ scenarioId: "orders-list", requirementId: "list-orders", requestedTargetIds: ["web-1"], required: true,
        accountProfileId: "synthetic", minimumEvidence: "source" as const, requiredRealComponentIds: [],
        steps: [{ kind: "navigate" as const, path: "/orders" }], assertions: [{ kind: "visible" as const, testId: "orders-list", equals: true }] }],
      semanticExportDeltas: [],
    };
    const graph = { schemaVersion: 1 as const, taskId: featureTaskId, version: 1,
      items: [{ id: randomUUID(), title: "Implement orders list", description: "Add the requested view and regression coverage.", repository: "ordinary-orders", dependsOn: [] }] };
    const untrustedPlan = { schemaVersion: 1 as const, title: "Orders list implementation", why: [{ text: "The owner requested an orders view.", author: "planner" }],
      claims: [{ id: "1", text: "The orders list is visible." }], notChanging: ["Existing access rules."], risks: ["Source smoke does not establish native runtime behavior."],
      decisions: [], workBreakdown: graph, e2e: e2eIntent };
    const plannerArtifact = `\`\`\`agentx-plan\n${JSON.stringify(untrustedPlan)}\n\`\`\`\n`;
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
