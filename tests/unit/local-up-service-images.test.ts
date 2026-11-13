// `rovara up` with test services on and no catalog key (Code): the starter images need no approval, the test environment page proposes what a project's files ask for, the owner approves one image there (a fresh page, a form
// that answers once), the digest Docker resolved is pinned and stored, and the API token cannot approve. The real Docker is never used: a fake answers pulls and digests.
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, OWNER_STARTER_IMAGES, orgScoped, TEST_ENV_DRAFT_RESULT_KEY, TestEnvironmentBodySchema, WORKER_INVOCATION_FEATURES } from "@rovara-code/contracts";
import { FakeWorkerMachines } from "../../packages/core/src/ports/fake-worker-machines.js";
import { startLocalRuntime, type LocalRuntime } from "../../packages/core/src/local/runtime.js";
import { testEnvDraftEndItems } from "../../packages/core/src/core/test-env/draft.js";
import type { DockerResult } from "../../packages/core/src/local/docker-runner.js";
import { FakeDocker } from "../support/local/fake-docker.js";
import { OwnerDocker, sha } from "../support/owner-docker.js";
import { formBody, formOf, raw } from "../support/local-pages-fakes.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length > 0) await cleanup.pop()!(); });

/** The fake worker host, plus the registry side of Docker: a pull, a digest and an image check by name. */
class PageDocker extends FakeDocker {
  readonly registry = new OwnerDocker();
  override async run(args: readonly string[]): Promise<DockerResult> {
    const last = args.at(-1) ?? "";
    if (args[0] === "pull" || (args[0] === "image" && args[1] === "inspect" && last.startsWith("docker.io/"))) return this.registry.run(args);
    return super.run(args);
  }
}

const PROJECT = { name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.", repositories: [{ name: "demo", url: "https://examplehost/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }] };
const cmd = (executable: string, args: string[] = []) => ({ cwd: "service", executable, args, timeoutSeconds: 600 });
const body = () => TestEnvironmentBodySchema.parse({
  tier: "sandbox", repos: [{ repositoryId: "service", setupCommands: [cmd("pip", ["install", "-e", "."])], checks: [{ id: "unit", label: "Unit tests", command: cmd("pytest", ["-q"]), kind: "test" }] }],
  roundBudgetMin: 30, selection: { method: "full", alwaysRun: [], fullSuiteOn: [] }, nightly: { enabled: false, cronUtc: "0 6 * * *", branch: "main" },
  services: [], data: { seeds: [], generator: "faker_seeded", seed: 1 }, accounts: [], prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] }, capture: { screenshots: "failed", video: false, traces: false },
});
const candidate = (family: string, version: string, line: number) => ({ family, kind: family === "redis" ? "cache" : "database", evidence: [{ path: "docker-compose.yml", line }], strength: "declared", hints: { version } });

async function launch(environment: NodeJS.ProcessEnv, docker = new PageDocker(), reuse?: { root: string }) {
  const root = reuse?.root ?? await mkdtemp(join(tmpdir(), "rovara-images-"));
  if (reuse === undefined) cleanup.push(() => rm(root, { recursive: true, force: true }));
  const stateDirectory = join(root, "state");
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const opened: string[] = [];
  const runtime: LocalRuntime = await startLocalRuntime({
    stateDirectory, cwd: join(root, "project"), environment, gh: async () => undefined, workerImage: "worker:test", docker, version: "9.9.9", timers: false,
    machines: new FakeWorkerMachines({ startingChecks: 0, features: [...WORKER_INVOCATION_FEATURES] }), openBrowser: async (url) => { opened.push(url); },
  });
  cleanup.push(() => runtime.stop());
  const token = (await readFile(runtime.sessionTokenPath, "utf8")).trim();
  const api = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const response = await fetch(`${runtime.url}${path}`, { method: init.method ?? "GET", headers: { authorization: `Bearer ${token}`, ...(init.body === undefined ? {} : { "content-type": "application/json" }) }, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
    return { status: response.status, body: JSON.parse(await response.text()) as Record<string, unknown> };
  };
  const browse = async (path: string) => {
    expect((await api("/v1/local/pages/open", { method: "POST", body: { path } })).status).toBe(200);
    const once = new URL(opened.at(-1)!);
    const hop = await raw(runtime.pagesUrl, { path: once.pathname, headers: { host: once.host } });
    const url = new URL(hop.headers["location"] as string, runtime.pagesUrl);
    return { url, html: (await raw(runtime.pagesUrl, { path: url.pathname, headers: { host: url.host } })).body };
  };
  const keepDraft = async (candidates: unknown[]) => {
    const reported = { environment: body(), valueSources: [], pendingServices: [], notes: [], questions: [], dependencies: candidates };
    const items = testEnvDraftEndItems({ taskId: "t1", purpose: "setup_draft", project: "payments", orgId: IMPLICIT_COMPANY_ID }, { kind: "task", workflowMode: "SETUP_DRAFT" }, { status: "SUCCEEDED", result: { [TEST_ENV_DRAFT_RESULT_KEY]: reported } }, new Date().toISOString(), environment);
    expect(items).toHaveLength(1);
    await runtime.registry.require("storage").transact(items);
  };
  return { root, runtime, api, browse, keepDraft, docker, store: () => runtime.registry.require("storage") };
}

const ON = { ROVARA_TEST_SERVICES: "1" };
const pageFor = (h: Awaited<ReturnType<typeof launch>>) => ({ origin: h.runtime.pagesUrl });
const postForm = (h: Awaited<ReturnType<typeof launch>>, page: { url: URL }, form: { action: string; fields: Record<string, string> }) =>
  raw(pageFor(h).origin, { method: "POST", path: form.action, body: formBody(form.fields), headers: { host: page.url.host, origin: h.runtime.pagesUrl, "content-type": "application/x-www-form-urlencoded" } });

describe("rovara up with test services on and no catalog key", () => {
  it("serves the starter images with no approval: they are pulled by digest and put in the worker machine's guard policy and environment", async () => {
    const h = await launch(ON);
    expect(h.docker.registry.pulls().sort()).toEqual(OWNER_STARTER_IMAGES.map((image) => image.reference).sort());
    expect(h.docker.registry.pulls().every((name) => name.includes("@sha256:"))).toBe(true);
    await h.api("/v1/admin/projects", { method: "POST", body: PROJECT });
    const page = await h.browse("/test-environment/payments");
    for (const image of OWNER_STARTER_IMAGES) expect(page.html).toContain(image.reference);
    expect(page.html).toContain("Built in");
  });

  it("proposes what the project's files ask for, approves nothing by itself, and approves one image on a fresh page: the digest Docker resolved is pinned and stored", async () => {
    const h = await launch(ON);
    await h.api("/v1/admin/projects", { method: "POST", body: PROJECT });
    await h.keepDraft([candidate("postgres", "15", 4), candidate("postgres", "16", 6), candidate("redis", "7", 9)]);
    const digest = sha("postgres:15 resolved today");
    h.docker.registry.tags.set("docker.io/library/postgres:15", digest);
    const pullsBefore = h.docker.registry.pulls().length;

    let page = await h.browse("/test-environment/payments");
    expect(page.html).toContain("Approve postgres:15 from Docker Hub");
    expect(page.html).not.toContain("Approve postgres:16");
    expect(page.html).toContain("built in, no approval needed");
    expect(page.html).toContain("docker-compose.yml:4");
    // Reading the page pulled and stored nothing.
    expect(h.docker.registry.pulls()).toHaveLength(pullsBefore);
    expect((await h.api("/v1/app/projects/payments/test-environment/service-images")).body).toMatchObject({ serviceImages: { owned: [], proposed: [{ requested: "postgres:15", status: "needs_approval" }, { requested: "postgres:16", status: "builtin" }, { requested: "redis:7", status: "builtin" }] } });

    const form = formOf(page.html, "/images/approve");
    const done = await postForm(h, page, form);
    expect(done.status).toBe(303);
    expect(String(done.headers["location"])).toContain("n=imageapproved");
    expect(h.docker.registry.pulls().at(-1)).toBe("docker.io/library/postgres:15");
    const stored = await h.runtime.registry.require("storage").query({ pk: orgScoped(IMPLICIT_COMPANY_ID, "TEST_SERVICE_IMAGES") });
    expect(stored.items).toHaveLength(1);
    expect(stored.items[0]).toMatchObject({ reference: `docker.io/library/postgres@sha256:${digest}`, origin: "page", requested: "postgres:15", project: "payments" });
    expect(stored.items[0]!["reference"]).toEqual(expect.not.stringContaining(":15"));

    page = await h.browse("/test-environment/payments");
    expect(page.html).toContain(`docker.io/library/postgres@sha256:${digest}`);
    expect(page.html).toContain("used from the next rovara up");
    // The form answers once.
    expect(String((await postForm(h, page, form)).headers["location"])).toContain("n=form");
  });

  it("refuses a form drawn for an image the project's newest draft no longer asks for: stale, and nothing is pulled", async () => {
    const h = await launch(ON);
    await h.api("/v1/admin/projects", { method: "POST", body: PROJECT });
    await h.keepDraft([candidate("postgres", "15", 4)]);
    h.docker.registry.tags.set("docker.io/library/postgres:15", sha("old draft"));
    const page = await h.browse("/test-environment/payments");
    const form = formOf(page.html, "/images/approve");
    expect(form.fields["requested"]).toBe("postgres:15");
    // A newer draft (same task, kept again) no longer names it.
    await h.keepDraft([candidate("redis", "7", 2)]);
    const pulls = h.docker.registry.pulls().length;
    const answer = await postForm(h, page, form);
    expect(String(answer.headers["location"])).toContain("n=stale");
    expect(h.docker.registry.pulls()).toHaveLength(pulls);
    expect((await h.store().query({ pk: orgScoped(IMPLICIT_COMPANY_ID, "TEST_SERVICE_IMAGES") })).items).toEqual([]);
  });

  it("is used from the next `rovara up`: a second start lists the approved digest beside the starters, even after the tag moved", async () => {
    const docker = new PageDocker();
    const first = await launch(ON, docker);
    await first.api("/v1/admin/projects", { method: "POST", body: PROJECT });
    await first.keepDraft([candidate("postgres", "15", 4)]);
    docker.registry.tags.set("docker.io/library/postgres:15", sha("a"));
    const page = await first.browse("/test-environment/payments");
    expect(String((await postForm(first, page, formOf(page.html, "/images/approve"))).headers["location"])).toContain("n=imageapproved");
    docker.registry.tags.set("docker.io/library/postgres:15", sha("moved"));
    await first.runtime.stop();
    const second = await launch(ON, docker, { root: first.root });
    const view = await second.api("/v1/app/projects/payments/test-environment/service-images");
    expect(view.body).toMatchObject({ serviceImages: { owned: [{ reference: `docker.io/library/postgres@sha256:${sha("a")}`, inEffect: true }] } });
    expect(docker.registry.pulls().filter((name) => name === "docker.io/library/postgres:15")).toHaveLength(1);
    expect(docker.registry.pulls()).not.toContain(`docker.io/library/postgres@sha256:${sha("moved")}`);
  });

  it("answers the API with a refusal for an approval, whatever the credential: only the page approves", async () => {
    const h = await launch(ON);
    await h.api("/v1/admin/projects", { method: "POST", body: PROJECT });
    for (const verb of ["approve", "remove"]) {
      const answer = await h.api(`/v1/app/projects/payments/test-environment/service-images/${verb}`, { method: "POST", body: { requested: "postgres:15", reference: "x" } });
      expect(answer.status).toBe(403);
      expect(JSON.stringify(answer.body)).toContain("approved on the test environment page");
    }
    expect(h.docker.registry.pulls().some((name) => name === "docker.io/library/postgres:15")).toBe(false);
    expect((await h.store().query({ pk: orgScoped(IMPLICIT_COMPANY_ID, "TEST_SERVICE_IMAGES") })).items).toEqual([]);
  });

  it("the MCP tools have no way to approve or even name a service image", () => {
    const walk = (directory: string): string[] => readdirSync(directory).flatMap((entry) => { const path = join(directory, entry); return statSync(path).isDirectory() ? walk(path) : path.endsWith(".ts") ? [path] : []; });
    for (const file of walk("packages/mcp/src")) expect(readFileSync(file, "utf8"), file).not.toMatch(/service-images|serviceImages|approveServiceImage/u);
  });

  it("offers nothing and shows no images panel with test services off", async () => {
    const docker = new PageDocker();
    const h = await launch({}, docker);
    await h.api("/v1/admin/projects", { method: "POST", body: PROJECT });
    expect(docker.registry.calls).toEqual([]);
    const page = await h.browse("/test-environment/payments");
    expect(page.html).not.toContain("Service images");
    expect((await h.api("/v1/app/projects/payments/test-environment/service-images")).status).toBe(404);
  });
});
