// Tickets on `rovara up`: the owner links their tracker account in the config, names where a project's work is asked for, and a label they put on a ticket starts a task through the real runtime. The ticket starts the
// task and approves nothing: the plan waits for the owner's page. What the task does is written back to the ticket by the milestone hook. Anyone else's ticket waits in the owner's list.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IMPLICIT_COMPANY_ID, WORKER_INVOCATION_FEATURES, intakeItemIdOf, type CodeMilestone, type OrgId } from "@rovara-code/contracts";
import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";
import { registerIntakeCommand } from "../../packages/cli/src/up/cli.js";
import { sessionBindingsOf } from "../../packages/core/src/core/sessions/bindings.js";
import { taskSessionId } from "../../packages/core/src/core/sessions/create.js";
import { FakeWorkerMachines } from "../../packages/core/src/ports/fake-worker-machines.js";
import { FAKE_TRACKER_KIND, FakeTracker } from "../../packages/core/src/plugins/fake/tracker.js";
import { startLocalRuntime, type LocalRuntime } from "../../packages/core/src/local/runtime.js";
import { codeMilestoneItems } from "../../packages/core/src/core/milestones/milestones.js";
import { FakeDocker } from "../support/local/fake-docker.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length > 0) await cleanup.pop()!(); });

const ORG = IMPLICIT_COMPANY_ID as OrgId;
const PROJECT = {
  name: "web", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://examplehost/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
};
const OWNER_ACCOUNT = { provider: FAKE_TRACKER_KIND, tenant: "", accountId: "u-owner" };
const SOURCE = { channel: "tracker", system: FAKE_TRACKER_KIND, when: { label: "rovara" } };

async function launch(config: Record<string, unknown> = { linkedAccounts: [OWNER_ACCOUNT] }) {
  const root = await mkdtemp(join(tmpdir(), "rovara-intake-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const stateDirectory = join(root, "state");
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await writeFile(join(stateDirectory, "config.json"), JSON.stringify({ version: 1, plugins: [], ...config }), { mode: 0o600 });
  const tracker = new FakeTracker();
  const runtime: LocalRuntime = await startLocalRuntime({
    stateDirectory, cwd: join(root, "project"), environment: {}, gh: async () => undefined, workerImage: "worker:test", docker: new FakeDocker(), version: "9.9.9",
    machines: new FakeWorkerMachines({ startingChecks: 0, features: [...WORKER_INVOCATION_FEATURES] }), timers: false, storage: "memory",
    registerAdapters: (registry) => { registry.register("tracker", FAKE_TRACKER_KIND, tracker); },
  });
  cleanup.push(() => runtime.stop());
  const token = (await readFile(runtime.sessionTokenPath, "utf8")).trim();
  const api = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const response = await fetch(`${runtime.url}${path}`, { method: init.method ?? "GET", headers: { authorization: `Bearer ${token}`, ...(init.body === undefined ? {} : { "content-type": "application/json" }) }, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
    const text = await response.text();
    return { status: response.status, body: JSON.parse(text || "{}") as Record<string, unknown> };
  };
  expect((await api("/v1/admin/projects", { method: "POST", body: PROJECT })).status).toBe(201);
  const asked = (id: string, accountId = "u-owner") => {
    tracker.addItem(id, { title: "Refunds fail" });
    return { ref: { tracker: FAKE_TRACKER_KIND, id, url: `https://host.example.test/items/${id}` }, title: "Refunds fail", body: "Refunds over 100 fail.", reporter: "Dana", actor: { kind: "person" as const, account: { ...OWNER_ACCOUNT, accountId } } };
  };
  return { runtime, tracker, api, asked, root, stateDirectory, store: runtime.registry.require("storage") };
}

describe("a ticket on rovara up", () => {
  it("starts a task from a label the owner's linked account put on, and the plan still waits for the owner", async () => {
    const h = await launch();
    expect((await h.api("/v1/app/projects/web/intake/sources", { method: "POST", body: { sources: [SOURCE] } })).status).toBe(200);
    h.tracker.asked = [h.asked("T-1")];
    await h.runtime.tick();
    const tasks = (await h.api("/v1/dev/tasks")).body["tasks"] as Array<{ taskId: string; title: string }>;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.title).toBe("Refunds fail");
    const task = (await h.api(`/v1/dev/tasks/${tasks[0]!.taskId}`)).body["task"] as { workflow: { stage: string; state: string; decisions: unknown[] } };
    expect(["UNDERSTAND", "PLAN"]).toContain(task.workflow.stage);
    expect(task.workflow.decisions).toEqual([]);
    expect(await sessionBindingsOf(h.store, ORG, taskSessionId(tasks[0]!.taskId))).toMatchObject([{ kind: "tracker_item", system: FAKE_TRACKER_KIND, id: "T-1" }]);
    // The session the task has shows the ticket it follows.
    const session = (await h.api(`/v1/app/sessions/${taskSessionId(tasks[0]!.taskId)}`)).body;
    expect(JSON.stringify(session)).toContain("tracker_item");
    // The ticket hears that work started.
    expect(h.tracker.writes.map((write) => write.kind)).toEqual(["comment"]);
  });

  it("writes the pull request's link back when the task's pull request opens, with the milestone the merge code writes", async () => {
    const h = await launch();
    await h.api("/v1/app/projects/web/intake/sources", { method: "POST", body: { sources: [SOURCE] } });
    h.tracker.asked = [h.asked("T-1")];
    await h.runtime.tick();
    const tasks = (await h.api("/v1/dev/tasks")).body["tasks"] as Array<{ taskId: string }>;
    const taskId = tasks[0]!.taskId;
    const milestone: CodeMilestone = { kind: "pr_ready", orgId: ORG, taskId, sessionId: taskSessionId(taskId), at: new Date().toISOString(), text: "The pull request is ready.", pullRequests: [{ repository: "demo", number: 7, url: "https://github.com/example/demo/pull/7" }] };
    expect((await h.store.transact(codeMilestoneItems(milestone, 1, { definitionVersion: "1.1.0" }))).applied).toBe(true);
    await h.runtime.tick();
    expect(h.tracker.writes.at(-1)).toMatchObject({ kind: "comment", item: "T-1" });
    expect(h.tracker.writes.at(-1)?.value).toContain("Pull request: https://github.com/example/demo/pull/7");
  });

  it("makes someone else's ticket wait, shows it to the owner, and starts it only when the owner says Start", async () => {
    const h = await launch();
    await h.api("/v1/app/projects/web/intake/sources", { method: "POST", body: { sources: [SOURCE] } });
    h.tracker.asked = [h.asked("T-2", "u-stranger")];
    await h.runtime.tick();
    expect(((await h.api("/v1/dev/tasks")).body["tasks"] as unknown[])).toHaveLength(0);
    const list = (await h.api("/v1/app/projects/web/intake")).body as { items: Array<{ itemId: string; reason: string }> };
    expect(list.items).toMatchObject([{ itemId: intakeItemIdOf(FAKE_TRACKER_KIND, "T-2"), reason: "unlinked" }]);
    const started = await h.api(`/v1/app/projects/web/intake/${list.items[0]!.itemId}/start`, { method: "POST", body: { requestId: crypto.randomUUID() } });
    expect(started.status).toBe(202);
    expect(((await h.api("/v1/dev/tasks")).body["tasks"] as unknown[])).toHaveLength(1);
  });

  it("starts nothing for any ticket while no account is linked in the config", async () => {
    const h = await launch({});
    await h.api("/v1/app/projects/web/intake/sources", { method: "POST", body: { sources: [SOURCE] } });
    h.tracker.asked = [h.asked("T-1")];
    await h.runtime.tick();
    expect(((await h.api("/v1/dev/tasks")).body["tasks"] as unknown[])).toHaveLength(0);
    expect(((await h.api("/v1/app/projects/web/intake")).body["items"] as unknown[])).toHaveLength(1);
  });

  it("is not reachable without the owner's session", async () => {
    const h = await launch();
    const response = await fetch(`${h.runtime.url}/v1/app/projects/web/intake`);
    expect(response.status).toBe(401);
  });

  it("refuses a config that links an account in a shape that is not the neutral one", async () => {
    await expect(launch({ linkedAccounts: [{ provider: "linear", accountId: "u1" }] })).rejects.toThrow();
  });
});

describe("rovara intake", () => {
  const run = async (h: Awaited<ReturnType<typeof launch>>, printed: string[], ...args: string[]) => {
    const program = new Command().exitOverride().option("--json");
    registerIntakeCommand(program, { home: h.root, fetch, stdout: { write: (text: string) => { printed.push(text); return true; } } });
    await program.parseAsync(["node", "rovara", ...args, "--state-dir", h.stateDirectory]);
  };

  it("names where a project's work is asked for, lists what waits, and starts or drops a ticket", async () => {
    const h = await launch();
    const printed: string[] = [];
    await run(h, printed, "intake", "add", "web", FAKE_TRACKER_KIND, "--label", "rovara");
    expect(printed.join("")).toContain("asks 1 place");
    h.tracker.asked = [h.asked("T-2", "u-stranger"), h.asked("T-3", "u-stranger")];
    await h.runtime.tick();
    printed.length = 0;
    await run(h, printed, "intake", "list", "web");
    expect(printed.join("")).toContain("2 tickets wait for you");
    expect(printed.join("")).toContain(`label "rovara"`);
    const ids = [intakeItemIdOf(FAKE_TRACKER_KIND, "T-2"), intakeItemIdOf(FAKE_TRACKER_KIND, "T-3")];
    printed.length = 0;
    await run(h, printed, "intake", "start", "web", ids[0]!);
    expect(printed.join("")).toContain("Its plan waits for your approval");
    expect(((await h.api("/v1/dev/tasks")).body["tasks"] as unknown[])).toHaveLength(1);
    printed.length = 0;
    await run(h, printed, "intake", "dismiss", "web", ids[1]!);
    expect(printed.join("")).toContain("Dropped.");
    printed.length = 0;
    await run(h, printed, "--json", "intake", "list", "web");
    expect(JSON.parse(printed.join(""))).toMatchObject({ ok: true, data: { items: [], sources: [{ failing: false }] } });
    printed.length = 0;
    await run(h, printed, "intake", "clear", "web");
    expect(((await h.api("/v1/app/projects/web/intake")).body["sources"] as unknown[])).toHaveLength(0);
  });

  it("changes what is written back, and refuses a ticket named any other way than by its id", async () => {
    const h = await launch();
    const printed: string[] = [];
    await run(h, printed, "intake", "updates", "web", "--status", "on");
    expect(printed.join("")).toContain("Status changes: on");
    // Rovara says where a comment can be seen: a Linear comment is visible to everyone who can see the ticket.
    expect(printed.join("")).toContain("visible to everyone who can see the ticket");
    printed.length = 0;
    await run(h, printed, "intake", "updates", "web", "--comments", "off");
    expect(printed.join("")).toContain("Comments on the ticket: off");
    await expect(run(h, [], "intake", "start", "web", "../../x")).rejects.toThrow(/by its id/u);
    await expect(run(h, [], "intake", "updates", "web", "--comments", "maybe")).rejects.toThrow(/on or off/u);
    await expect(run(h, [], "intake", "add", "web", "linear")).rejects.toThrow(/--label/u);
  });
});
