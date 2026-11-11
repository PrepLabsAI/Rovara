// `rovara up` and a project's test environment: the owner proposes through the API, the page shows what changes and offers Approve only once a Prove run passed, the approval is the owner's own act on the
// page (the API token cannot make it), and a task that starts afterwards pins the approved revision.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";
import { RANGE_IN_USE_SENTENCE, hostUsesRunRange, prepareLocalTestServices } from "../../packages/broker/src/local/test-services-install.js";
import { registerTestEnvCommand } from "../../packages/cli/src/up/test-env-command.js";
import { IMPLICIT_COMPANY_ID, TestEnvironmentBodySchema, testEnvDigest, WORKER_INVOCATION_FEATURES } from "@agentx/contracts";
import { FakeWorkerMachines } from "../../packages/broker/src/ports/fake-worker-machines.js";
import { startLocalRuntime, type LocalRuntime } from "../../packages/broker/src/local/runtime.js";
import { readApprovedTestEnvironment, recordTestEnvProveReport, testEnvProposalKey } from "../../packages/broker/src/core/test-env/environment.js";
import { readTestEnvPin } from "../../packages/broker/src/core/test-env/usable.js";
import { FakeDocker } from "../support/local/fake-docker.js";
import { formBody, formOf, raw } from "../support/local-pages-fakes.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length > 0) await cleanup.pop()!(); });

const PROJECT = {
  name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://examplehost/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
};
const cmd = (executable: string, args: string[] = []) => ({ cwd: "repo/demo", executable, args, timeoutSeconds: 600 });
const environment = (over: Record<string, unknown> = {}) => TestEnvironmentBodySchema.parse({
  tier: "sandbox",
  repos: [{ repositoryId: "demo", setupCommands: [cmd("npm", ["ci"])], checks: [{ id: "unit", label: "Unit tests", command: cmd("npm", ["test"]), kind: "test" }] }],
  roundBudgetMin: 30, selection: { method: "full", alwaysRun: [], fullSuiteOn: ["package-lock.json"] }, nightly: { enabled: false, cronUtc: "0 6 * * *", branch: "main" },
  services: [], data: { seeds: [], generator: "faker_seeded", seed: 7 }, accounts: [], prodDeny: { accountIds: ["111122223333"], hosts: ["*.prod.example.com"], arnPrefixes: [] },
  capture: { screenshots: "failed", video: false, traces: false }, ...over,
});

async function launch(environmentVariables: NodeJS.ProcessEnv = {}, docker: FakeDocker = new FakeDocker()) {
  const root = await mkdtemp(join(tmpdir(), "rovara-testenv-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const stateDirectory = join(root, "state");
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const machines = new FakeWorkerMachines({ startingChecks: 0, features: [...WORKER_INVOCATION_FEATURES] });
  const opened: string[] = [];
  const runtime: LocalRuntime = await startLocalRuntime({
    stateDirectory, cwd: join(root, "project"), environment: environmentVariables, gh: async () => undefined, workerImage: "worker:test", docker, version: "9.9.9", machines, timers: false,
    openBrowser: async (url) => { opened.push(url); },
  });
  cleanup.push(() => runtime.stop());
  const token = (await readFile(runtime.sessionTokenPath, "utf8")).trim();
  const api = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const response = await fetch(`${runtime.url}${path}`, { method: init.method ?? "GET", headers: { authorization: `Bearer ${token}`, ...(init.body === undefined ? {} : { "content-type": "application/json" }) }, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
    return { status: response.status, body: JSON.parse(await response.text()) as Record<string, unknown> };
  };
  const browse = async (path: string): Promise<URL> => {
    const answer = await api("/v1/local/pages/open", { method: "POST", body: { path } });
    expect(answer.status).toBe(200);
    const once = new URL(opened.at(-1)!);
    const hop = await raw(runtime.pagesUrl, { path: once.pathname, headers: { host: once.host } });
    return new URL(hop.headers["location"] as string, runtime.pagesUrl);
  };
  const deps = () => ({ store: runtime.registry.require("storage"), now: () => Date.now() });
  return { root, stateDirectory, runtime, api, browse, deps, machines, opened };
}

const proved = (digest: string) => ({
  schemaVersion: 1, proposalDigest: digest, steps: [{ step: "setup", status: "passed", durationMs: 5 }, { step: "boot", status: "passed", durationMs: 7 }, { step: "smoke", status: "passed", durationMs: 9 }],
  services: [], finishedAt: new Date().toISOString(),
});

describe("rovara up: a project's test environment", () => {
  it("proposes through the API, offers Approve on the page only after a Prove run passed, and approves as the owner on the page", async () => {
    const h = await launch();
    expect((await h.api("/v1/admin/projects", { method: "POST", body: PROJECT })).status).toBe(201);
    const none = await h.api("/v1/app/projects/payments/test-environment");
    expect(none).toMatchObject({ status: 200, body: { enabled: true } });
    expect(none.body["approved"]).toBeUndefined();

    const body = environment();
    const proposed = await h.api("/v1/app/projects/payments/test-environment/propose", { method: "POST", body: { environment: body } });
    expect(proposed.status, JSON.stringify(proposed.body)).toBe(200);
    const digest = testEnvDigest(body);
    expect(proposed.body["proposal"]).toMatchObject({ digest, risk: "medium", lessSafe: [] });
    expect(String(proposed.body["approve"])).toContain("rovara test-env open");
    // The proposal records who proposed and through which client, from the caller the route was given.
    const stored = await h.runtime.registry.require("storage").get(testEnvProposalKey(IMPLICIT_COMPANY_ID, "payments", digest));
    expect(stored?.["proposer"]).toMatchObject({ provider: "local-owner" });
    expect(typeof (stored?.["client"])).toBe("string");

    // The page shows what would change, and no Approve button while no Prove run passed.
    let page = await h.browse("/test-environment/payments");
    let shown = await raw(h.runtime.pagesUrl, { path: page.pathname, headers: { host: page.host } });
    expect(shown.status).toBe(200);
    expect(shown.body).toContain("What changes");
    expect(shown.body).toContain("cannot be approved until a Prove run");
    expect(shown.body).not.toContain("Approve revision");

    await recordTestEnvProveReport(h.deps(), { orgId: IMPLICIT_COMPANY_ID, project: "payments", report: proved(digest) });
    page = await h.browse("/test-environment/payments");
    shown = await raw(h.runtime.pagesUrl, { path: page.pathname, headers: { host: page.host } });
    expect(shown.body).toContain("Approve revision 1");

    // An assistant (the API token) has no route to approve with; the owner does it on the page.
    const form = formOf(shown.body, "/decide");
    const post = await raw(h.runtime.pagesUrl, { method: "POST", path: form.action, body: formBody({ ...form.fields }), headers: { host: page.host, origin: h.runtime.pagesUrl, "content-type": "application/x-www-form-urlencoded" } });
    expect(post.status).toBe(303);
    expect(post.headers["location"]).toContain("n=envapproved");
    expect((await readApprovedTestEnvironment(h.deps(), IMPLICIT_COMPANY_ID, "payments"))?.revision).toBe(1);
    const state = await h.api("/v1/app/projects/payments/test-environment");
    expect(state.body["approved"]).toMatchObject({ revision: 1, digest });
    expect(state.body["proposal"]).toBeUndefined();

    // The form answers once: posting it again approves nothing twice.
    const again = await raw(h.runtime.pagesUrl, { method: "POST", path: form.action, body: formBody({ ...form.fields }), headers: { host: page.host, origin: h.runtime.pagesUrl, "content-type": "application/x-www-form-urlencoded" } });
    expect(again.headers["location"]).toContain("n=form");

    // A task that starts now pins revision 1.
    const started = await h.api("/v1/dev/tasks", { method: "POST", body: { requestId: "11111111-1111-4111-8111-111111111111", project: "payments", instructions: "Add a retry", workflow: true } });
    expect(started.status).toBe(201);
    const taskId = String((started.body["task"] as { taskId: string }).taskId);
    expect(await readTestEnvPin(h.deps(), IMPLICIT_COMPANY_ID, "payments", taskId)).toEqual({ revision: 1, digest });
  });

  it("refuses a body that does not parse, an unknown project, and answers 404 with the switch off", async () => {
    const h = await launch();
    await h.api("/v1/admin/projects", { method: "POST", body: PROJECT });
    expect((await h.api("/v1/app/projects/payments/test-environment/propose", { method: "POST", body: { environment: { tier: "nope" } } })).status).toBe(400);
    expect((await h.api("/v1/app/projects/other/test-environment")).status).toBe(404);
    expect((await h.api("/v1/app/projects/payments/test-environment/propose", { method: "POST", body: {} })).status).toBe(400);
  });

  it("a proposal that is high risk is shown as such, with its flags", async () => {
    const h = await launch();
    await h.api("/v1/admin/projects", { method: "POST", body: PROJECT });
    const base = environment();
    const withPreprod = environment({ services: [{ name: "scorer", kind: "sagemaker_runtime", match: { endpointName: "scorer" }, mode: "preprod", preprod: { endpointArn: "arn:aws:sagemaker:us-west-2:222222222222:endpoint/scorer", roleArn: "arn:aws:iam::222222222222:role/invoke", region: "us-west-2" } }] });
    expect(base.services).toHaveLength(0);
    const proposed = await h.api("/v1/app/projects/payments/test-environment/propose", { method: "POST", body: { environment: withPreprod } });
    expect(proposed.body["proposal"]).toMatchObject({ risk: "high", lessSafe: ["preprod"] });
  });
});

describe("rovara test-env", () => {
  it("shows, proposes and opens the page, and approves nothing", async () => {
    const h = await launch();
    await h.api("/v1/admin/projects", { method: "POST", body: PROJECT });
    const printed: string[] = [];
    const run = async (...args: string[]) => {
      const program = new Command().exitOverride().option("--json");
      registerTestEnvCommand(program, { home: h.root, fetch, stdout: { write: (text: string) => { printed.push(text); return true; } } });
      await program.parseAsync(["node", "rovara", "test-env", ...args, "--state-dir", h.stateDirectory]);
    };
    await run("show", "payments");
    expect(printed.join("")).toContain("Approved: none");
    const file = join(h.root, "environment.json");
    await writeFile(file, JSON.stringify(environment()));
    printed.length = 0;
    await run("propose", "payments", file);
    expect(printed.join("")).toContain("risk medium");
    printed.length = 0;
    await run("show", "payments");
    expect(printed.join("")).toContain("Waiting for approval");
    expect(printed.join("")).toContain("cannot be approved until a Prove run passes");
    printed.length = 0;
    await run("open", "payments");
    expect(printed.join("")).toBe("Opened in your browser.\n");
    expect(new URL(h.opened.at(-1)!).pathname).toMatch(/^\/s\/once\//);
    // There is no command that approves.
    await expect(run("approve", "payments")).rejects.toThrow();
    // A file that is not JSON, a project name that is not one, and nothing running are said plainly.
    await writeFile(file, "not json");
    await expect(run("propose", "payments", file)).rejects.toThrow(/not JSON/);
    await expect(run("show", "bad name")).rejects.toThrow(/exact name/);
    await h.runtime.stop();
    await expect(run("show", "payments")).rejects.toThrow(/not running/);
  });
});

describe("rovara up: what the switches start", () => {
  it("registers the local timer as the scheduler, and nothing else by default: no registry, no Docker image pull", async () => {
    const docker = new FakeDocker();
    const h = await launch({}, docker);
    expect(h.runtime.registry.names("scheduler")).toEqual(["interval"]);
    expect(h.runtime.registry.names("image-registry")).toEqual(["none"]);
    expect(docker.calls.some((call) => call[0] === "pull")).toBe(false);
  });

  it("test services on without a registry to take the images from or a catalog this release trusts: the worker is told nothing, and nothing is pulled", async () => {
    const docker = new FakeDocker();
    await launch({ ROVARA_TEST_SERVICES: "1" }, docker);
    expect(docker.calls.some((call) => call[0] === "pull")).toBe(false);
    const withRegistry = new FakeDocker();
    await launch({ ROVARA_TEST_SERVICES: "1", ROVARA_TEST_SERVICES_REGISTRY: "registry.examplehost:5000" }, withRegistry);
    // A catalog folder with no signed catalog in it (and no key this release trusts) pins nothing, so nothing is pulled.
    expect(withRegistry.calls.some((call) => call[0] === "pull")).toBe(false);
  });

  it("saved environments on register the local registry adapter, which says the worker cannot push or pull yet", async () => {
    const h = await launch({ ROVARA_SAVED_ENVIRONMENTS: "1" });
    expect(h.runtime.registry.names("image-registry")).toEqual(["docker"]);
    expect(h.runtime.registry.require("image-registry").capabilities).toMatchObject({ workerPush: false, workerPull: false });
  });

  it("offers no test services, and pulls nothing, when this computer already uses the range the run networks are made in", async () => {
    const used = { en0: [{ address: "172.30.4.20", netmask: "255.255.255.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: false, cidr: "172.30.4.20/24" }] } as never;
    const other = { en0: [{ address: "172.31.4.20", netmask: "255.255.255.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: false, cidr: "172.31.4.20/24" }], lo0: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: true, cidr: "127.0.0.1/8" }] } as never;
    expect(hostUsesRunRange(used)).toBe(true);
    expect(hostUsesRunRange(other)).toBe(false);
    const docker = new FakeDocker();
    const install = await prepareLocalTestServices({ environment: { ROVARA_TEST_SERVICES: "1", ROVARA_TEST_SERVICES_REGISTRY: "registry.examplehost:5000" }, stateDirectory: tmpdir(), docker, interfaces: used });
    expect(install).toEqual({ services: undefined, catalog: undefined, unavailable: RANGE_IN_USE_SENTENCE });
    expect(docker.calls).toHaveLength(0);
  });
});
