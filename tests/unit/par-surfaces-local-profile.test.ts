// the MCP tools and the CLI reach the `rovara up` running on this computer. `--env local` names it: no hosted sign-in, no token in an MCP entry; the
// login `rovara up` keeps in its state folder is read at each call. These tests run the real MCP server (the one `rovara mcp` runs) and the real CLI commands against a real local runtime.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { Command } from "commander";
import { WORKER_INVOCATION_FEATURES, type AuditEvent, type AuditSink } from "@rovara-code/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { defaultStateDirectory } from "../../packages/core/src/local/state-directory.js";
import { startLocalRuntime, type LocalRuntime } from "../../packages/core/src/local/runtime.js";
import { FakeWorkerMachines } from "../../packages/core/src/ports/fake-worker-machines.js";
import { saveDeveloperEnvironment } from "../../packages/cli/src/developer/config.js";
import { developerAccessToken } from "../../packages/cli/src/developer/session.js";
import { agentxMcpServer } from "../../packages/cli/src/mcp/serve.js";
import { registerSessionCommands } from "../../packages/cli/src/session/register.js";
import { LOCAL_ENVIRONMENT, readLocalRuntime } from "../../packages/cli/src/up/local-runtime.js";
import { registerTokenCommands } from "../../packages/cli/src/up/token.js";
import { FakeDocker } from "../support/local/fake-docker.js";
import { raw } from "../support/local-pages-fakes.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()!();
});

const PROJECT = {
  name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://examplehost/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
};
/** What the tools answer, as far as these tests read it. */
interface ToolValue { task_id: string; projects: Array<{ name: string }>; tasks: Array<{ task_id: string }>; sessions: Array<{ id: string }>; environment?: string }
/** What the owner's routes answer, as far as these tests read it. */
interface OwnerBody { task: { workflow: { decisions: unknown[] } } }
const tokenStore = { async get() { return undefined; }, async set() { /* none */ }, async delete() { /* none */ } };

async function launch() {
  const home = await mkdtemp(join(tmpdir(), "rovara-surfaces-home-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const stateDirectory = defaultStateDirectory(home);
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const events: AuditEvent[] = [];
  const audit: AuditSink = { stage(event) { events.push(event); return []; }, async record(event) { events.push(event); } };
  const opened: string[] = [];
  const runtime: LocalRuntime = await startLocalRuntime({
    stateDirectory, cwd: join(home, "project"), environment: {}, gh: async () => undefined, workerImage: "worker:test", docker: new FakeDocker(), version: "0.1.0",
    machines: new FakeWorkerMachines({ startingChecks: 0, features: [...WORKER_INVOCATION_FEATURES] }), timers: false, storage: "memory",
    registerAdapters: (registry) => { registry.register("audit-sink", "recording", audit); }, openBrowser: async (url) => { opened.push(url); },
  });
  cleanup.push(() => runtime.stop());
  const deps = { home, tokenStore, fetch, env: LOCAL_ENVIRONMENT, adminSignedIn: async () => false, adminSession: async () => undefined, stderr: { write: () => true } };
  const server = agentxMcpServer(deps);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const mcp = new Client({ name: "claude-code", version: "1.0.0" });
  await mcp.connect(clientSide);
  cleanup.push(async () => { await mcp.close(); });
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const result = CallToolResultSchema.parse(await mcp.callTool({ name, arguments: args }));
    return { isError: result.isError === true, value: (result.structuredContent ?? {}) as unknown as ToolValue, text: (result.content[0] as { text?: string } | undefined)?.text ?? "" };
  };
  const cli = async (...argv: string[]): Promise<string> => {
    const out: string[] = [];
    const program = new Command().exitOverride().option("--env <name>").option("--project <name>").option("--json", "", false);
    registerSessionCommands(program, {
      developerSession: () => ({ home, tokenStore, fetch }), developerEnv: () => LOCAL_ENVIRONMENT,
      globalOptions: (command) => ({ json: command.optsWithGlobals<{ json: boolean }>().json, ...(command.optsWithGlobals<{ project?: string }>().project === undefined ? {} : { project: command.optsWithGlobals<{ project: string }>().project }) }),
      write: (text) => { out.push(text); },
    });
    registerTokenCommands(program, { home, fetch, stdout: { write: (text: string) => { out.push(text); return true; } } });
    await program.parseAsync(["node", "rovara", ...argv]);
    return out.join("");
  };
  const owner = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const address = (await readLocalRuntime(home))!;
    const response = await fetch(`${address.url}${path}`, { method: init.method ?? "GET", headers: { authorization: `Bearer ${address.secret}`, ...(init.body === undefined ? {} : { "content-type": "application/json" }) }, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
    return { status: response.status, body: await response.json() as OwnerBody };
  };
  await owner("/v1/admin/projects", { method: "POST", body: PROJECT });
  return { home, runtime, deps, tool, cli, owner, opened, events };
}

describe("--env local is the rovara up on this computer", () => {
  it("reads where it listens and its login, and never makes a token of its own", async () => {
    const h = await launch();
    const address = await readLocalRuntime(h.home);
    expect(address).toMatchObject({ url: h.runtime.url });
    const session = await developerAccessToken({ home: h.home, tokenStore, fetch }, LOCAL_ENVIRONMENT);
    expect(session).toMatchObject({ env: "local", accessToken: address!.secret, entry: { url: h.runtime.url } });
    // Stopped: nothing is running here, and the answer says to start it.
    await h.runtime.stop();
    await expect(developerAccessToken({ home: h.home, tokenStore, fetch }, LOCAL_ENVIRONMENT)).rejects.toThrow(/not running here/);
    // Any other environment name still needs its sign-in.
    await expect(developerAccessToken({ home: h.home, tokenStore, fetch }, "staging")).rejects.toThrow(/not signed in/);
  });

  it("keeps the name local for the laptop: a hosted sign-in cannot be saved under it, and an older one is named and not used", async () => {
    const h = await launch();
    await expect(saveDeveloperEnvironment(h.home, LOCAL_ENVIRONMENT, { url: "https://a.example.test", issuer: "https://a.example.test", tokenEndpoint: "https://a.example.test/t", revocationEndpoint: "https://a.example.test/r" })).rejects.toThrow(/reserved/);
    await mkdir(join(h.home, ".agentx"), { recursive: true, mode: 0o700 });
    await writeFile(join(h.home, ".agentx", "developer.yaml"), "schemaVersion: 1\ndefault: local\nenvironments:\n  local:\n    url: https://old.example.test\n    issuer: https://old.example.test\n    tokenEndpoint: https://old.example.test/t\n    revocationEndpoint: https://old.example.test/r\n", { mode: 0o600 });
    await expect(developerAccessToken({ home: h.home, tokenStore, fetch }, LOCAL_ENVIRONMENT)).rejects.toThrow(/older saved sign-in named local.*logout/);
  });

  it("answers the configuration the tools check first, in the developer API's own version", async () => {
    const h = await launch();
    const answer = await (await fetch(`${h.runtime.url}/v1/auth/.well-known/agentx-configuration`)).json() as Record<string, unknown>;
    expect(answer).toMatchObject({ env: "local", apiVersion: "1.2", version: "0.1.0" });
  });
});

describe("the MCP tools against rovara up", () => {
  it("lists the projects, starts a plan-first task, reads it, and lists tasks and sessions with the filters the tools send", async () => {
    const h = await launch();
    const whoami = await h.tool("agentx_whoami");
    expect(whoami.isError, whoami.text).toBe(false);
    expect(whoami.value).toMatchObject({ environment: "local" });
    const projects = await h.tool("agentx_list_projects");
    expect(projects.isError, projects.text).toBe(false);
    expect(projects.value.projects.map((entry) => entry.name)).toEqual(["payments"]);
    const started = await h.tool("agentx_start", { project: "payments", instructions: "Add a /health endpoint", workflow_path: "quick" });
    expect(started.isError, started.text).toBe(false);
    const taskId = started.value.task_id;
    expect(taskId).toMatch(/^[0-9a-f-]{36}$/);
    const read = await h.tool("agentx_get_task", { task_id: taskId });
    expect(read.isError, read.text).toBe(false);
    expect(read.value).toMatchObject({ task_id: taskId, project: "payments" });
    // The list's `project` and `status` are honoured (they were ignored before): a project with no task has none, the task's own status finds it.
    expect((await h.tool("agentx_list_tasks", { project: "payments" })).value.tasks.map((task) => task.task_id)).toEqual([taskId]);
    expect((await h.tool("agentx_list_tasks", { project: "billing" })).value.tasks).toEqual([]);
    expect((await h.tool("agentx_list_tasks", { status: "CLOSED" })).value.tasks).toEqual([]);
    const sessions = await h.tool("agentx_list_sessions");
    expect(sessions.isError, sessions.text).toBe(false);
    expect(sessions.value.sessions).toHaveLength(1);
    const sessionId = sessions.value.sessions[0]!.id;
    const session = await h.tool("agentx_get_session", { session_id: sessionId });
    expect(session.isError, session.text).toBe(false);
    // No answer of any tool holds a page address or a page session.
    for (const text of [whoami.text, projects.text, started.text, read.text, sessions.text, session.text]) expect(text).not.toMatch(/\/s\/[A-Za-z0-9_-]{43}/);
  });

  it("cannot approve a plan: the tool is told to have the owner open the page, and the answer carries no address", async () => {
    const h = await launch();
    const started = await h.tool("agentx_start", { project: "payments", instructions: "Add a /health endpoint", workflow_path: "quick" });
    const taskId = started.value.task_id;
    const decided = await h.tool("agentx_decide_workflow", {
      task_id: taskId, request_id: "22222222-2222-4222-8222-222222222222", expected_revision: 1, decision: "APPROVE", reason: "ship it", artifact_digest: "a".repeat(64),
    });
    expect(decided.isError).toBe(true);
    expect(JSON.stringify(decided)).not.toMatch(/\/s\/[A-Za-z0-9_-]{43}/);
    const view = (await h.owner(`/v1/dev/tasks/${taskId}`)).body.task;
    expect(view.workflow.decisions).toEqual([]);
  });

  it("stops a session and says a message to a running step is saved and not passed on", async () => {
    const h = await launch();
    await h.tool("agentx_start", { project: "payments", instructions: "Add a /health endpoint", workflow_path: "quick" });
    const sessionId = (await h.tool("agentx_list_sessions")).value.sessions[0]!.id;
    const told = await h.tool("agentx_tell_session_agent", { session_id: sessionId, text: "use /health" });
    expect(told.isError, told.text).toBe(false);
    const stopped = await h.tool("agentx_stop_session", { session_id: sessionId });
    expect(stopped.isError, stopped.text).toBe(false);
  });

  it("cancels and closes a task, and waits on it, with the same tools as Cloud", async () => {
    const h = await launch();
    const started = await h.tool("agentx_start", { project: "payments", instructions: "Add a /health endpoint", workflow_path: "quick" });
    const taskId = started.value.task_id;
    const waited = await h.tool("agentx_wait_for_task", { task_id: taskId, wait_seconds: 1 });
    expect(waited.isError, waited.text).toBe(false);
    const cancelled = await h.tool("agentx_cancel_task", { task_id: taskId });
    expect(cancelled.isError, cancelled.text).toBe(false);
    const closed = await h.tool("agentx_close_task", { task_id: taskId });
    expect(closed.isError, closed.text).toBe(false);
    const gone = await h.tool("agentx_get_task", { task_id: taskId });
    expect(gone.isError, gone.text).toBe(false);
  });

  it("does not offer or serve the tools whose features are not in Code yet", async () => {
    const h = await launch();
    // Tools stay listed (the names are the same as Cloud's); the ones waiting on features not built yet answer plainly that the route is not here.
    const agents = await h.tool("agentx_list_agents");
    expect(agents.text).toContain("NOT_ON_THIS_INSTALL");
    expect(agents.text).toContain("do not retry");
    expect(agents.isError).toBe(true);
    const approvals = await h.tool("agentx_list_approvals");
    expect(approvals.isError).toBe(true);
    const share = await h.tool("agentx_share_task", { task_id: "44444444-4444-4444-8444-444444444444", mode: "view" });
    expect(share.isError).toBe(true);
    expect(share.text).toContain("not on this install yet");
    expect(approvals.text).toContain("not on this install yet");
  });
});

describe("the CLI against rovara up", () => {
  it("starts a session, lists it, and shows it, with no hosted sign-in", async () => {
    const h = await launch();
    const started = await h.cli("session", "start", "Add a /health endpoint", "--project", "payments", "--workflow", "quick");
    expect(started).toContain("Started task");
    const listed = await h.cli("sessions");
    expect(listed).toMatch(/ses_[0-9a-z]+/);
    const id = /ses_[0-9a-z]+/.exec(listed)![0];
    expect(await h.cli("session", "show", id)).toContain(id);
    expect(started + listed).not.toMatch(/\/s\/[A-Za-z0-9_-]{43}/);
  });

  it("makes script tokens on the page, lists them without the secret, and revokes them", async () => {
    const h = await launch();
    expect(await h.cli("token", "list")).toContain("You have no script tokens");
    // `create` opens the page in the browser, fresh, and prints no address.
    const said = await h.cli("token", "create");
    expect(said).toContain("Opened the script tokens page");
    expect(said).not.toMatch(/\/s\//);
    const once = new URL(h.opened.at(-1)!);
    expect(once.pathname).toMatch(/^\/s\/once\//);
    const hop = await raw(h.runtime.pagesUrl, { path: once.pathname, headers: { host: once.host } });
    const where = new URL(hop.headers["location"] as string, h.runtime.pagesUrl);
    expect(where.pathname).toMatch(/\/tokens$/);
    expect((await raw(h.runtime.pagesUrl, { path: where.pathname, headers: { host: where.host } })).body).toContain("name=\"name\"");
    // Make one (the form), then the CLI sees it and revokes it.
    const made = await h.runtime.app.scriptTokens.create({ requestId: "55555555-5555-4555-8555-555555555555", name: "CI", projects: ["payments"], permissions: ["read"] });
    const listed = await h.cli("token", "list");
    expect(listed).toContain(made.token.tokenId);
    expect(listed).not.toContain(made.secret.slice(-43));
    expect(await h.cli("token", "revoke", made.token.tokenId)).toContain("is revoked");
    expect(await h.cli("token", "list")).toContain("revoked");
    await expect(h.cli("token", "revoke", "not-a-token")).rejects.toThrow(/not a script token ID/);
    expect(h.events.map((event) => event.action)).toEqual(expect.arrayContaining(["script_token.created", "script_token.revoked"]));
  });
});
