import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { arch, hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeCli } from "../../packages/cli/src/main.js";
import { developerTokenKey, saveDeveloperEnvironment } from "../../packages/cli/src/developer/config.js";
import { realExec, type Exec } from "../../packages/cli/src/loop/exec.js";
import { captureCandidate } from "../../packages/cli/src/loop/candidate.js";
import { createRegisteredEnrollment } from "../../packages/cli/src/loop/enrollment.js";
import { LoopStore } from "../../packages/cli/src/loop/state.js";
import { InMemoryTokenStore } from "../../packages/cli/src/token-store.js";

const dirs: string[] = [];
const servers: Server[] = [];
const taskId = "f4ac96d1-061c-4f10-9c4a-bdb0db1c2d07";

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
      for (const [name, value] of Object.entries(request.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      const result = await handler(new Request(`http://127.0.0.1${request.url ?? "/"}`, {
        method: request.method, headers, ...(body.length === 0 ? {} : { body }),
      }));
      response.writeHead(result.status, Object.fromEntries(result.headers.entries()));
      response.end(await result.text());
    })().catch((error: unknown) => {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : "fixture handler failed");
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server did not bind");
  return `http://127.0.0.1:${address.port}`;
}

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

describe("registered task selection through the normal loop enrollment command", () => {
  it("uses the actual Git candidate and authenticated join before storing the task selector", async () => {
    const root = await mkdtemp(join(tmpdir(), "rovara-task-bind-"));
    dirs.push(root);
    const home = join(root, "home");
    const checkout = join(root, "checkout");
    await mkdir(checkout, { recursive: true });
    git(checkout, "init", "-b", "main");
    git(checkout, "config", "user.email", "test@example.invalid");
    git(checkout, "config", "user.name", "Synthetic fixture");
    await import("node:fs/promises").then(({ writeFile }) => writeFile(join(checkout, "tracked.txt"), "base\n"));
    git(checkout, "add", "tracked.txt"); git(checkout, "commit", "-m", "base");
    const baseCommitSha = git(checkout, "rev-parse", "HEAD");
    git(checkout, "branch", "rovara/42"); git(checkout, "switch", "rovara/42");
    await import("node:fs/promises").then(({ writeFile }) => writeFile(join(checkout, "tracked.txt"), "candidate\n"));
    git(checkout, "commit", "-am", "candidate");
    git(checkout, "update-ref", "refs/remotes/origin/main", baseCommitSha);
    const candidate = await captureCandidate(realExec, checkout, "rovara/42", "origin/main");
    const taskIdFromNormalStart = taskId;
    const subject = { projectName: "payments", projectRevision: 3, repositoryId: 1234, commitSha: candidate.commitSha, treeSha: candidate.treeSha, baseCommitSha: candidate.baseCommitSha };
    let taskSelectorValidated = false;
    const baseUrl = await serve(async (request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "POST" && path === "/v1/dev/tasks") return Response.json({ task: { taskId: taskIdFromNormalStart } });
      if (request.method !== "POST" || path !== `/v1/dev/tasks/${taskId}/e2e-publication-context`) return Response.json({}, { status: 404 });
      const body = await request.json() as { taskRef: string; subject: typeof subject; sourceBindingRef: string };
      taskSelectorValidated = request.headers.get("authorization") === "Bearer synthetic-cli-session" && body.taskRef === taskIdFromNormalStart && body.sourceBindingRef.startsWith("cli-source:v1:");
      if (!taskSelectorValidated || JSON.stringify(body.subject) !== JSON.stringify(subject)) return Response.json({ schemaVersion: 1, status: "UNKNOWN", reasonCode: "subject_mismatch", checkedAt: new Date().toISOString() });
      return Response.json({ schemaVersion: 1, status: "READY", requestId: "fixture-request-1", subject, candidateDigest: "a".repeat(64), contractDigest: "b".repeat(64), policyDigest: "c".repeat(64), planDigest: "d".repeat(64), roundId: "fixture-round", evidenceSetDigest: "e".repeat(64), checkedAt: new Date(Date.now() - 100).toISOString() });
    });
    const issuer = "https://identity.control.example/";
    await saveDeveloperEnvironment(home, "dev", { url: baseUrl, issuer, tokenEndpoint: `${baseUrl}/token`, revocationEndpoint: `${baseUrl}/revoke` });
    const tokenStore = new InMemoryTokenStore();
    await tokenStore.set(developerTokenKey(issuer), { accessToken: "synthetic-cli-session", expiresAt: Date.now() + 600_000 });
    const taskStart = await fetch(`${baseUrl}/v1/dev/tasks`, { method: "POST", headers: { authorization: "Bearer synthetic-cli-session" } });
    const taskStartBody = await taskStart.json() as { task?: { taskId?: string } };
    const selectedTaskId = taskStartBody.task?.taskId;
    if (selectedTaskId === undefined) throw new Error("normal task start fixture returned no task UUID");

    const store = new LoopStore(join(home, ".rovara", "loop"));
    await store.saveRepos([{ repo: "acme/payments", path: checkout }]);
    const account = "maya";
    const hostId = `${hostname()}:${process.platform}:${arch()}`;
    const uid = process.getuid?.() ?? 0;
    const enrollment = createRegisteredEnrollment({
      namespace: `${baseUrl}/env/dev/project/payments`, hostId, uid, account, project: "payments", projectRevision: 3,
      repository: "acme/payments", repositoryId: 1234, checkoutPath: checkout, commonGitDir: git(checkout, "rev-parse", "--git-common-dir") === ".git" ? join(checkout, ".git") : git(checkout, "rev-parse", "--git-common-dir"),
      sourceBindingRef: `cli-source:v1:${"1".repeat(64)}`, now: new Date(),
    });
    await store.saveEnrollment(enrollment);
    await store.saveItem({ version: 1, repo: "acme/payments", issue: 42, loop: "quick", step: "publish", startedBy: "maya", instruction: "Fix it",
      startedAt: new Date().toISOString(), stepEnteredAt: new Date().toISOString(), worktree: { path: checkout, branch: "rovara/42" },
      checksCandidate: candidate, reviewsCandidate: candidate });
    const ghExec: Exec = async (command, args, options) => {
      if (command !== "gh") return realExec(command, args, options);
      if (args[0] === "repo" && args[1] === "view") return { code: 0, stdout: "acme/payments\n", stderr: "" };
      if (args[0] === "api" && args[1] === "user") return { code: 0, stdout: "maya\n", stderr: "" };
      if (args[0] === "api" && args[1] === "repos/acme/payments" && args.at(-1) === ".id") return { code: 0, stdout: "1234\n", stderr: "" };
      if (args[0] === "api" && args[1] === "repos/acme/payments" && args.at(-1) === ".default_branch") return { code: 0, stdout: "main\n", stderr: "" };
      return { code: 1, stdout: "", stderr: `unexpected gh fixture call: ${args.join(" ")}` };
    };
    const out: string[] = [];
    const exitCode = await executeCli(["--env", "dev", "loop", "enroll", "acme/payments", "--task", selectedTaskId, "--issue", "42"], {
      environments: { home }, tokenStore, fetchImplementation: fetch.bind(globalThis), loop: { exec: ghExec },
      stdout: { write: (value) => out.push(value) }, stderr: { write: (value) => out.push(value) },
    });
    expect(exitCode, out.join("")).toBe(0);
    expect(taskSelectorValidated).toBe(true);
    expect(await store.enrollments()).toMatchObject([{ enrollmentId: enrollment.enrollmentId, taskRef: selectedTaskId }]);
    expect(out.join("")).toContain("Bound task");
  });
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
