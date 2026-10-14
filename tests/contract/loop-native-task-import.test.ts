import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { arch, hostname } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "@agentx/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { executeCli } from "../../packages/cli/src/main.js";
import { developerTokenKey, saveDeveloperEnvironment } from "../../packages/cli/src/developer/config.js";
import { createDeveloperPublicationJoinTransport } from "../../packages/cli/src/loop/enrollment-cli.js";
import { realExec, type Exec } from "../../packages/cli/src/loop/exec.js";
import { captureCandidate } from "../../packages/cli/src/loop/candidate.js";
import { createRegisteredEnrollment } from "../../packages/cli/src/loop/enrollment.js";
import { createLoopPublicationContextResolver } from "../../packages/cli/src/loop/cli.js";
import { GitHub } from "../../packages/cli/src/loop/github.js";
import { LoopStore } from "../../packages/cli/src/loop/state.js";
import { InMemoryTokenStore } from "../../packages/cli/src/token-store.js";

const servers: Server[] = [];
const taskId = "f4ac96d1-061c-4f10-9c4a-bdb0db1c2d07";
const runId = "11111111-2222-4333-8444-555555555555";
const ownerId = "a".repeat(64);
const stamp = () => new Date().toISOString();

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

async function evidenceRoot(): Promise<string> {
  const base = process.env.CONTAINED_CLI_LANES_EVIDENCE_DIR;
  if (base === undefined) throw new Error("CONTAINED_CLI_LANES_EVIDENCE_DIR is required");
  const root = join(base, `native-import-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(root, { recursive: true });
  return root;
}

async function serve(handler: (request: Request) => Response | Promise<Response>): Promise<string> {
  const server = createServer((request, response) => {
    void (async () => {
      request.setEncoding("utf8");
      const body = await new Promise<string>((resolve, reject) => {
        let text = "";
        request.on("data", (chunk: string) => { text += chunk; });
        request.on("end", () => resolve(text));
        request.on("error", reject);
      });
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      const result = await handler(new Request(`http://127.0.0.1${request.url ?? "/"}`, { method: request.method, headers, ...(body.length === 0 ? {} : { body }) }));
      response.writeHead(result.status, Object.fromEntries(result.headers.entries()));
      response.end(await result.text());
    })().catch((error: unknown) => { response.statusCode = 500; response.end(error instanceof Error ? error.message : "fixture failed"); });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server did not bind");
  return `http://127.0.0.1:${address.port}`;
}

function taskView(input: { candidate: Awaited<ReturnType<typeof captureCandidate>>; taskRef?: string; repositoryId?: string; at?: string; mutate?: (workflow: Record<string, unknown>) => void }) {
  const at = input.at ?? stamp();
  const repository = { repositoryId: input.repositoryId ?? "payments", commitSha: input.candidate.commitSha, treeSha: input.candidate.treeSha, baseCommitSha: input.candidate.baseCommitSha };
  const candidateDigest = createHash("sha256").update(JSON.stringify({ schemaVersion: 1, repositories: [repository] })).digest("hex");
  const artifactDigest = "b".repeat(64);
  const policyDigest = "c".repeat(64);
  const planDigest = "d".repeat(64);
  const admissionSha256 = "e".repeat(64);
  const evidenceSha256 = "f".repeat(64);
  const workflow: Record<string, unknown> = {
    schemaVersion: 1, definitionId: "agentx-task-to-pr", definitionVersion: "1.0.0", taskId: input.taskRef ?? taskId, ownerId,
    path: "QUICK", revision: 3, stage: "REVIEW", state: "READY", createdAt: at, updatedAt: at,
    artifacts: [{ id: "plan-1", type: "plan", version: 1, sha256: artifactDigest, producer: "agentx-worker-untrusted", objectKey: "tasks/plan.md", createdAt: at }],
    decisions: [{ requestId: "21111111-2222-4333-8444-555555555555", workflowRevision: 2, decision: "APPROVE", actorId: ownerId, actorRole: "TASK_OWNER", reason: "approved", artifactDigest, workBreakdownDigest: "1".repeat(64), at }],
    checkPolicy: { required: [{ id: "required-1", label: "Required", command: { cwd: "src", executable: "npm", args: ["test"], timeoutSeconds: 60 } }], optional: [], selectedOptionalIds: [], proposed: [] },
    e2e: { contractDigest: artifactDigest, policyDigest, bundleDigest: "2".repeat(64), executionPlanDigest: planDigest, required: true,
      currentRoundId: runId, currentGroupRunIds: [runId], resultRefs: [], qualifiedRound: { candidateDigest, contractDigest: artifactDigest, policyDigest,
        bundleDigest: "2".repeat(64), executionPlanDigest: planDigest, roundId: runId, groupRunIds: [runId], admissionSha256, evidenceSha256 } },
    candidate: { schemaVersion: 1, repositories: [repository], digest: candidateDigest },
    reviewBase: [{ repositoryId: repository.repositoryId, baseCommitSha: input.candidate.baseCommitSha }],
    verification: { candidateDigest, producer: "agentx-worker-checks", environmentId: "native-env-1", recordedAt: at, results: [{ checkId: "required-1", status: "PASS" }] },
    reviews: ["CRITIC", "SECURITY"].map((role) => ({ operationId: "31111111-2222-4333-8444-555555555555", candidateDigest, role,
      provider: "native-review", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: at })),
  };
  input.mutate?.(workflow);
  const evidenceSetDigest = createHash("sha256").update(canonicalJson({ domain: "agentx-e2e-publication-context/v1", taskId: input.taskRef ?? taskId,
    candidateDigest, roundId: runId, admissionSha256, evidenceSha256, groupRunIds: [runId] })).digest("hex");
  const task = { taskId: input.taskRef ?? taskId, title: "Synthetic task", project: "payments", status: "SUCCEEDED", workflow,
    startingRevision: 1, client: "CLI fixture", shared: false, createdAt: at, updatedAt: at, events: [] };
  return { task, candidateDigest, artifactDigest, policyDigest, planDigest, evidenceSetDigest };
}

describe("normal CLI import of authenticated native task evidence", () => {
  it("imports only a fresh task view bound to the exact candidate, checks, reviews, approvals, and E2E round", async () => {
    const root = await evidenceRoot();
    const home = join(root, "home");
    const checkout = join(root, "checkout");
    await mkdir(checkout, { recursive: true });
    git(checkout, "init", "-b", "main"); git(checkout, "config", "user.email", "test@example.invalid"); git(checkout, "config", "user.name", "Synthetic fixture");
    await writeFile(join(checkout, "tracked.txt"), "base\n"); git(checkout, "add", "tracked.txt"); git(checkout, "commit", "-m", "base");
    const baseCommitSha = git(checkout, "rev-parse", "HEAD");
    git(checkout, "branch", "rovara/42"); git(checkout, "switch", "rovara/42");
    await writeFile(join(checkout, "tracked.txt"), "candidate\n"); git(checkout, "commit", "-am", "candidate"); git(checkout, "update-ref", "refs/remotes/origin/main", baseCommitSha);
    const candidate = await captureCandidate(realExec, checkout, "rovara/42", "origin/main");
    const evidenceAt = stamp();
    let mode: "valid" | "same-name" | "missing-check" | "failed-check" | "missing-security" | "forged-producer" | "foreign-candidate" | "foreign-task" | "stale-round" | "stale-contract" | "future-time" | "stale-time" | "foreign-approval" | "foreign-repository-identity" = "valid";
    let calls: string[] = [];
    const baseUrl = await serve(async (request) => {
      const path = new URL(request.url).pathname;
      calls.push(`${request.method} ${path}`);
      if (request.method === "POST" && path === "/v1/dev/tasks") return Response.json({ task: { taskId } });
      if (request.method === "POST" && path === `/v1/dev/tasks/${taskId}/e2e-publication-context`) {
        const body = await request.json() as { subject: { projectName: string; projectRevision: number; repositoryId: number; commitSha: string; treeSha: string; baseCommitSha: string } };
        const current = taskView({ candidate, repositoryId: mode === "valid" ? "api" : "payments", at: evidenceAt });
        const subject = body.subject;
        return Response.json({ schemaVersion: 1, status: "READY", requestId: "fixture-request", subject,
          candidateDigest: current.candidateDigest, contractDigest: current.artifactDigest, policyDigest: current.policyDigest,
          planDigest: current.planDigest, roundId: runId, evidenceSetDigest: current.evidenceSetDigest, checkedAt: stamp() });
      }
      if (request.method === "GET" && path === `/v1/dev/tasks/${taskId}`) {
        const taskCandidate = mode === "foreign-candidate" ? { ...candidate, commitSha: "0".repeat(40) } : candidate;
        const current = taskView({ candidate: taskCandidate, at: evidenceAt, repositoryId: mode === "valid" ? "api" : "payments", mutate(workflow) {
          const verification = workflow.verification as { producer: string; results: Array<{ checkId: string; status: string }>; recordedAt: string };
          const e2e = workflow.e2e as { currentRoundId: string; contractDigest: string; qualifiedRound: { contractDigest: string } };
          if (mode === "missing-check") verification.results = [];
          if (mode === "failed-check") verification.results[0]!.status = "FAILED";
          if (mode === "forged-producer") verification.producer = "local-yaml";
          if (mode === "missing-security") workflow.reviews = (workflow.reviews as Array<{ role: string }>).filter((review) => review.role !== "SECURITY");
          if (mode === "future-time") verification.recordedAt = new Date(Date.now() + 60_000).toISOString();
          if (mode === "stale-time") verification.recordedAt = new Date(Date.now() - 25 * 60 * 60 * 1_000).toISOString();
          if (mode === "stale-round") e2e.currentRoundId = "41111111-2222-4333-8444-555555555555";
          if (mode === "stale-contract") { e2e.contractDigest = "9".repeat(64); e2e.qualifiedRound.contractDigest = "9".repeat(64); }
          if (mode === "foreign-approval") workflow.decisions = (workflow.decisions as Array<Record<string, unknown>>).map((decision) => ({ ...decision, actorId: "8".repeat(64) }));
        } });
        if (mode === "foreign-task") current.task.taskId = "51111111-2222-4333-8444-555555555555";
        return Response.json({ requestId: "task-read-request", task: current.task });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    });
    const issuer = "https://identity.control.example/";
    await saveDeveloperEnvironment(home, "dev", { url: baseUrl, issuer, tokenEndpoint: `${baseUrl}/token`, revocationEndpoint: `${baseUrl}/revoke` });
    const tokenStore = new InMemoryTokenStore();
    await tokenStore.set(developerTokenKey(issuer), { accessToken: "synthetic-cli-session", expiresAt: Date.now() + 600_000 });
    const start = await fetch(`${baseUrl}/v1/dev/tasks`, { method: "POST", headers: { authorization: "Bearer synthetic-cli-session" } });
    const selectedTaskId = (await start.json() as { task: { taskId: string } }).task.taskId;
    const store = new LoopStore(join(home, ".rovara", "loop"));
    await store.saveRepos([{ repo: "acme/payments", path: checkout }]);
    const hostId = `${hostname()}:${process.platform}:${arch()}`;
    const enrollment = createRegisteredEnrollment({ namespace: `${baseUrl}/env/dev/project/payments`, hostId, uid: process.getuid?.() ?? 0,
      account: "synthetic-user", project: "payments", projectRevision: 3, repository: "acme/payments", repositoryId: 1234, logicalRepositoryName: "api",
      checkoutPath: checkout, commonGitDir: join(checkout, ".git"), sourceBindingRef: `cli-source:v1:${"1".repeat(64)}`, now: new Date() });
    await store.saveEnrollment(enrollment);
    await store.saveItem({ version: 1, repo: "acme/payments", issue: 42, loop: "quick", step: "publish", startedBy: "synthetic-user", instruction: "Fix it",
      startedAt: stamp(), stepEnteredAt: stamp(), worktree: { path: checkout, branch: "rovara/42" } });
    const ghExec: Exec = async (command, args, options) => {
      if (command !== "gh") return realExec(command, args, options);
      if (args[0] === "repo" && args[1] === "view") return { code: 0, stdout: "acme/payments\n", stderr: "" };
      if (args[0] === "api" && args[1] === "user") return { code: 0, stdout: "synthetic-user\n", stderr: "" };
      if (args[0] === "api" && args[1] === "repos/acme/payments" && args.at(-1) === ".id") return { code: 0, stdout: "1234\n", stderr: "" };
      if (args[0] === "api" && args[1] === "repos/acme/payments" && args.at(-1) === ".default_branch") return { code: 0, stdout: "main\n", stderr: "" };
      return { code: 1, stdout: "", stderr: `unexpected synthetic gh call: ${args.join(" ")}` };
    };
    const invoke = async () => {
      const output: string[] = [];
      const exitCode = await executeCli(["--env", "dev", "loop", "enroll", "acme/payments", "--task", selectedTaskId, "--issue", "42"], {
        environments: { home }, tokenStore, fetchImplementation: fetch.bind(globalThis), loop: { exec: ghExec },
        stdout: { write: (value) => output.push(value) }, stderr: { write: (value) => output.push(value) },
      });
      return { exitCode, output: output.join(""), enrollment: (await store.enrollments())[0] };
    };

    const valid = await invoke();
    expect(valid.exitCode, valid.output).toBe(0);
    expect(valid.enrollment).toMatchObject({ taskRef: taskId, nativeEvidence: { taskRef: taskId, verification: { producer: "agentx-worker-checks", checkIds: ["required-1"] }, reviews: [{ role: "CRITIC" }, { role: "SECURITY" }] } });
    expect(calls).toEqual(["POST /v1/dev/tasks", `POST /v1/dev/tasks/${taskId}/e2e-publication-context`, `GET /v1/dev/tasks/${taskId}`]);

    mode = "same-name";
    const sameNameEnrollment = { ...enrollment, logicalRepositoryName: "payments" };
    await writeFile(store.enrollmentPath(), `${JSON.stringify([sameNameEnrollment])}\n`);
    calls = [];
    const sameName = await invoke();
    expect(sameName.exitCode, sameName.output).toBe(0);
    expect(sameName.enrollment).toMatchObject({ logicalRepositoryName: "payments", nativeEvidence: { taskRef: taskId } });
    expect(calls).toEqual([`POST /v1/dev/tasks/${taskId}/e2e-publication-context`, `GET /v1/dev/tasks/${taskId}`]);

    mode = "valid";
    const legacyEnrollment = { ...valid.enrollment } as Record<string, unknown>;
    delete legacyEnrollment.logicalRepositoryName;
    delete legacyEnrollment.nativeEvidence;
    await writeFile(store.enrollmentPath(), `${JSON.stringify([legacyEnrollment])}\n`);
    calls = [];
    const missingMapping = await invoke();
    expect(missingMapping.exitCode, missingMapping.output).toBe(1);
    expect(missingMapping.enrollment).not.toHaveProperty("nativeEvidence");
    expect(calls).toEqual([`POST /v1/dev/tasks/${taskId}/e2e-publication-context`, `GET /v1/dev/tasks/${taskId}`]);

    await writeFile(store.enrollmentPath(), `${JSON.stringify([valid.enrollment])}\n`);
    mode = "foreign-repository-identity";
    calls = [];
    const foreignRepository = await invoke();
    expect(foreignRepository.exitCode, foreignRepository.output).toBe(1);
    expect(foreignRepository.enrollment).toMatchObject({ nativeEvidence: { proofDigest: valid.enrollment?.kind === "registered" ? valid.enrollment.nativeEvidence?.proofDigest : undefined } });
    expect(calls).toEqual([`POST /v1/dev/tasks/${taskId}/e2e-publication-context`, `GET /v1/dev/tasks/${taskId}`]);

    await writeFile(store.enrollmentPath(), `${JSON.stringify([valid.enrollment])}\n`);
    mode = "valid";
    calls = [];
    const publicationTransport = createDeveloperPublicationJoinTransport({ home, env: "dev", tokenStore, fetch: fetch.bind(globalThis) });
    const resolver = createLoopPublicationContextResolver({ store, github: new GitHub(ghExec), hostId, uid: process.getuid?.() ?? 0, publicationJoin: publicationTransport });
    const admission = await resolver({ issueRepo: "acme/payments", issue: 42, targetRepo: "acme/payments", destinationRepo: "acme/payments", worktree: checkout, candidate });
    expect(admission).toEqual({ kind: "registered-ready" });
    expect(calls).toEqual([`POST /v1/dev/tasks/${taskId}/e2e-publication-context`, `GET /v1/dev/tasks/${taskId}`]);
    mode = "stale-round";
    calls = [];
    const changedRound = await resolver({ issueRepo: "acme/payments", issue: 42, targetRepo: "acme/payments", destinationRepo: "acme/payments", worktree: checkout, candidate });
    expect(changedRound.kind).toBe("hold");
    expect(calls).toEqual([`POST /v1/dev/tasks/${taskId}/e2e-publication-context`, `GET /v1/dev/tasks/${taskId}`]);

    for (const invalid of ["missing-check", "failed-check", "missing-security", "forged-producer", "foreign-candidate", "foreign-task", "stale-round", "stale-contract", "future-time", "stale-time", "foreign-approval"] as const) {
      await writeFile(store.enrollmentPath(), `${JSON.stringify([enrollment])}\n`);
      mode = invalid;
      calls = [];
      const next = await invoke();
      expect(next.exitCode, `${invalid}: ${next.output}`).toBe(1);
      expect(next.enrollment).not.toHaveProperty("nativeEvidence");
      expect(calls).toEqual([`POST /v1/dev/tasks/${taskId}/e2e-publication-context`, `GET /v1/dev/tasks/${taskId}`]);
    }
  });
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});
