// `rovara up` and the machine size at setup (TE-C5 part B): with ROVARA_MACHINE_SIZE on, the state and the page of a project's test environment show the suggested size from a measured setup Prove, and the owner's choice is stored.
// With it off, the state, the page and the choice route are exactly what they were.
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, TestEnvironmentBodySchema, testEnvDigest, WORKER_INVOCATION_FEATURES } from "@agentx/contracts";
import { FakeWorkerMachines } from "../../packages/broker/src/ports/fake-worker-machines.js";
import { startLocalRuntime, type LocalRuntime } from "../../packages/broker/src/local/runtime.js";
import { recordMachineMeasurement, readMachineChoice, setMachineChoice } from "../../packages/broker/src/core/test-env/machine-size.js";
import { CHOOSE_MACHINE_SIZE_ON_THE_PAGE } from "../../packages/broker/src/local/app/test-environment.js";
import { FakeDocker } from "../support/local/fake-docker.js";
import { raw } from "../support/local-pages-fakes.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length > 0) await cleanup.pop()!(); });

const PROJECT = {
  name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://examplehost/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
};
const cmd = (executable: string, args: string[] = []) => ({ cwd: "repo/demo", executable, args, timeoutSeconds: 600 });
const environment = () => TestEnvironmentBodySchema.parse({
  tier: "sandbox", repos: [{ repositoryId: "demo", setupCommands: [cmd("npm", ["ci"])], checks: [{ id: "unit", label: "Unit tests", command: cmd("npm", ["test"]), kind: "test" }] }],
  roundBudgetMin: 30, selection: { method: "full", alwaysRun: [], fullSuiteOn: ["package-lock.json"] }, nightly: { enabled: false, cronUtc: "0 6 * * *", branch: "main" },
  services: [], data: { seeds: [], generator: "faker_seeded", seed: 7 }, accounts: [], prodDeny: { accountIds: ["111122223333"], hosts: ["*.prod.example.com"], arnPrefixes: [] },
  capture: { screenshots: "failed", video: false, traces: false },
});

async function launch(environmentVariables: NodeJS.ProcessEnv = {}) {
  const root = await mkdtemp(join(tmpdir(), "rovara-machine-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const stateDirectory = join(root, "state");
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const machines = new FakeWorkerMachines({ startingChecks: 0, features: [...WORKER_INVOCATION_FEATURES] });
  const opened: string[] = [];
  const runtime: LocalRuntime = await startLocalRuntime({
    stateDirectory, cwd: join(root, "project"), environment: environmentVariables, gh: async () => undefined, workerImage: "worker:test", docker: new FakeDocker(), version: "9.9.9", machines, timers: false,
    openBrowser: async (url) => { opened.push(url); },
  });
  cleanup.push(() => runtime.stop());
  const token = (await readFile(runtime.sessionTokenPath, "utf8")).trim();
  const api = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const response = await fetch(`${runtime.url}${path}`, { method: init.method ?? "GET", headers: { authorization: `Bearer ${token}`, ...(init.body === undefined ? {} : { "content-type": "application/json" }) }, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
    const text = await response.text();
    return { status: response.status, text, body: (text === "" ? {} : JSON.parse(text)) as Record<string, unknown> };
  };
  const pageOf = async (path: string): Promise<string> => {
    expect((await api("/v1/local/pages/open", { method: "POST", body: { path } })).status).toBe(200);
    const once = new URL(opened.at(-1)!);
    const hop = await raw(runtime.pagesUrl, { path: once.pathname, headers: { host: once.host } });
    const page = new URL(hop.headers["location"] as string, runtime.pagesUrl);
    return (await raw(runtime.pagesUrl, { path: page.pathname, headers: { host: page.host } })).body;
  };
  const deps = () => ({ store: runtime.registry.require("storage"), now: () => Date.now(), env: environmentVariables });
  return { api, pageOf, deps };
}

const measured = (digest: string) => ({
  jobId: "job-1", leaseToken: "l".repeat(40),
  result: { ok: true, report: { schemaVersion: 1, proposalDigest: digest, machineChip: "arm64", steps: [{ step: "full_suite", status: "passed", durationMs: 35 * 60_000 }], services: [], finishedAt: new Date().toISOString(), fullSuite: { peakMemoryMiB: 6246, durationMs: 35 * 60_000, tests: 10 } } },
});
const ON = { ROVARA_MACHINE_SIZE: "1" };

async function proposed(env: NodeJS.ProcessEnv) {
  const h = await launch(env);
  expect((await h.api("/v1/admin/projects", { method: "POST", body: PROJECT })).status).toBe(201);
  const body = environment();
  expect((await h.api("/v1/app/projects/payments/test-environment/propose", { method: "POST", body: { environment: body } })).status).toBe(200);
  return { ...h, digest: testEnvDigest(body) };
}

describe("rovara up: the machine size at setup", () => {
  it("shows not measured first, then the suggested size from a measured setup Prove, and stores the owner's choice", async () => {
    const h = await proposed(ON);
    let state = await h.api("/v1/app/projects/payments/test-environment");
    expect((state.body["machine"] as { lines: string[] }).lines[0]).toBe("Machine size: not measured");
    expect(await h.pageOf("/test-environment/payments")).toContain("Machine size: not measured");

    expect(await recordMachineMeasurement(h.deps(), { orgId: IMPLICIT_COMPANY_ID, project: "payments", body: measured(h.digest) })).toEqual({ recorded: true });
    state = await h.api("/v1/app/projects/payments/test-environment");
    expect(state.body["machine"]).toMatchObject({ suggestedRowId: "arm64-4-16" });
    const page = await h.pageOf("/test-environment/payments");
    expect(page).toContain("Suggested machine: ARM, 4 vCPU, 16 GB");
    expect(page).toContain("peak memory 6246 MiB");
    expect(page).toContain("Stored only: Rovara does not launch this size yet.");

    // The choice is made on the page (the form comes with part C); here it is stored the way that form will store it.
    await setMachineChoice(h.deps(), { orgId: IMPLICIT_COMPANY_ID, project: "payments", rowId: "x86_64-4-16" });
    expect(await readMachineChoice(h.deps(), IMPLICIT_COMPANY_ID, "payments")).toBe("x86_64-4-16");
    expect((await h.api("/v1/app/projects/payments/test-environment")).body["machine"]).toMatchObject({ chosenRowId: "x86_64-4-16" });
    expect(await h.pageOf("/test-environment/payments")).toContain("Your choice: x86, 4 vCPU, 16 GB");
  });

  it("the API cannot choose the machine size, whatever the body (a cost choice is the page's alone); an unknown project is not found; nothing is stored or repeated", async () => {
    const h = await proposed(ON);
    for (const body of [{ rowId: "x86_64-4-16" }, { rowId: "CANARY-evil" }, {}]) {
      const refused = await h.api("/v1/app/projects/payments/test-environment/machine", { method: "POST", body });
      expect(refused.status).toBe(403);
      expect(refused.text).toContain(CHOOSE_MACHINE_SIZE_ON_THE_PAGE.slice(0, 40));
      expect(refused.text).not.toContain("CANARY-evil");
    }
    expect((await h.api("/v1/app/projects/other/test-environment/machine", { method: "POST", body: { rowId: "arm64-2-8" } })).status).toBe(404);
    const get = await h.api("/v1/app/projects/payments/test-environment/machine");
    const unknown = await h.api("/v1/app/projects/payments/test-environment/nothing");
    // A GET of the choice route answers as an unknown route does (its words name the path, so only the status is compared).
    expect(get.status).toBe(unknown.status);
    const withoutRequestId = (text: string) => text.replace(/"requestId":"[^"]*"/u, "");
    expect(withoutRequestId(get.text)).toBe(withoutRequestId(unknown.text));
    expect(await readMachineChoice(h.deps(), IMPLICIT_COMPANY_ID, "payments")).toBeUndefined();
  });

  it("with the switch off the state and the page have no machine section, and the choice route is as unknown as before", async () => {
    const off = await proposed({});
    const state = await off.api("/v1/app/projects/payments/test-environment");
    expect(Object.keys(state.body)).not.toContain("machine");
    expect(await off.pageOf("/test-environment/payments")).not.toContain("Machine size");
    const route = await off.api("/v1/app/projects/payments/test-environment/machine", { method: "POST", body: { rowId: "arm64-2-8" } });
    const unknown = await off.api("/v1/app/projects/payments/test-environment/nothing", { method: "POST", body: { rowId: "arm64-2-8" } });
    const noId = (text: string) => text.replace(/"requestId":"[^"]+"/u, "");
    expect({ status: route.status, text: noId(route.text) }).toEqual({ status: unknown.status, text: noId(unknown.text) });
    expect(await readMachineChoice({ ...off.deps(), env: ON }, IMPLICIT_COMPANY_ID, "payments")).toBeUndefined();
  });
});
