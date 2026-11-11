// The How we work page and routes on `rovara up`: the project's playbook file as a person reads it, and a place to try a draft. Nothing here writes the file or the store: a draft is looked at only.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HowWeWorkViewSchema, IMPLICIT_COMPANY_ID, ProjectPlaybookResponseSchema, agentXError, projectPlaybookKey, type ProjectDefinition } from "@agentx/contracts";
import { createLocalPagesServer, type LocalPagesServer } from "../../packages/broker/src/core/local-pages/index.js";
import { DRAFT_CHARACTERS_MAX } from "../../packages/broker/src/core/local-pages/how-we-work-page.js";
import { createPlaybookService } from "../../packages/broker/src/core/playbook/service.js";
import { fixedPlaybookSource } from "../../packages/broker/src/core/playbook/source.js";
import { createStoreProjectSource } from "../../packages/broker/src/core/task-flow/project-source.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createNoopAuditSink } from "../../packages/broker/src/ports/policy-defaults.js";
import { createLocalPlaybook, EDIT_THE_FILE } from "../../packages/broker/src/local/app/playbook.js";
import { registerProject } from "../../packages/broker/src/local/app/projects.js";
import { TASK_FLOW_INDEXES } from "../../packages/broker/src/core/task-flow/flow.js";
import { fakeWorld, formBody, formOf, raw } from "../support/local-pages-fakes.js";

const COMPANY = IMPLICIT_COMPANY_ID;
const FILE = "version: 1\nrules: |\n  PROJECT-RULE: mention the ticket.\nstages:\n  plan:\n    instructions: PLAN-RULE\n";
const definition = (name: string): ProjectDefinition => ({ name, revision: 1, repositories: [{ name: "app", url: `https://github.com/example/${name}.git`, path: "repo/app", defaultBranch: "main", credentialRef: "host-app" }], setup: [], readiness: [], orchestratorInstructions: "x" });

const files: Record<string, string | undefined> = {};
let store: MemoryDocumentStore;
let server: LocalPagesServer;
let token: string;
let base: string;
let local: ReturnType<typeof createLocalPlaybook>;
let service: ReturnType<typeof createPlaybookService>;

beforeEach(async () => {
  for (const key of Object.keys(files)) delete files[key];
  Object.assign(files, { web: FILE });
  store = new MemoryDocumentStore({ indexes: TASK_FLOW_INDEXES });
  for (const name of ["web", "docs", "legacy"]) await registerProject(store, COMPANY, definition(name));
  const projects = createStoreProjectSource(store, COMPANY);
  const playbook = createPlaybookService({ companyId: COMPANY, store, audit: createNoopAuditSink(), projects, source: fixedPlaybookSource((project) => files[project]) });
  service = playbook;
  local = createLocalPlaybook({ playbook, store, companyId: COMPANY });
  const world = fakeWorld();
  server = await createLocalPagesServer({ data: { ...world.data, howWeWork: local.page }, actions: world.actions });
  token = server.sessions.mint().token;
  base = `/s/${token}`;
});
afterEach(async () => { await server.close(); });

const host = () => new URL(server.origin).host;
const get = (path: string) => raw(server.origin, { path, headers: { host: host() } });
const post = (path: string, fields: Record<string, string>) =>
  raw(server.origin, { method: "POST", path, body: formBody(fields), headers: { host: host(), origin: server.origin, "content-type": "application/x-www-form-urlencoded" } });
const decode = (text: string): string => text.replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

describe("the page", () => {
  it("lists the projects, each linked, and the navigation names the page", async () => {
    const page = await get(`${base}/how-we-work`);
    expect(page.status).toBe(200);
    for (const name of ["web", "docs", "legacy"]) expect(page.body).toContain(`${base}/how-we-work/${name}`);
    expect(page.body).toContain(`href="${base}/how-we-work">How we work</a>`);
  });

  it("shows what the file says: where it was read, the rules marked as the project's, and the stage's own", async () => {
    const page = await get(`${base}/how-we-work/web`);
    expect(page.status).toBe(200);
    expect(page.body).toContain(".rovara/playbook.yaml");
    expect(page.body).toContain("PROJECT-RULE: mention the ticket.");
    expect(page.body).toContain("PLAN-RULE");
    expect(page.body).toContain("(this project)");
    expect(page.body).toContain("Project rules apply to Understand, Plan and Build. Reviewers only follow rules written for them.");
    // The draft box starts with the file as it is, so the owner edits what is there.
    expect(decode(/<textarea[^>]*>([\s\S]*?)<\/textarea>/.exec(page.body)![1]!)).toBe(FILE);
  });

  it("says there is no file for a project without one, and offers the starter text to try", async () => {
    const page = await get(`${base}/how-we-work/docs`);
    expect(page.body).toContain("has no How we work file, so it runs Rovara Code as it is");
    expect(decode(/<textarea[^>]*>([\s\S]*?)<\/textarea>/.exec(page.body)![1]!)).toContain("version: 1");
    expect(page.body).not.toContain("(this project)");
  });

  it("names what is wrong with a file that cannot be used, and says no step starts until it is fixed", async () => {
    files["legacy"] = "version: 1\nstages:\n  check:\n    instructions: x";
    const page = await get(`${base}/how-we-work/legacy`);
    expect(page.body).toContain("cannot be used, so no step of this project starts until it is fixed");
    expect(page.body).toContain("stages.check");
    expect(page.body).toContain("Rules for this stage aren&#39;t used yet.");
  });

  it("draws everything from the file as plain text: markup in a rule is shown, never run", async () => {
    files["web"] = "version: 1\nrules: \"<script>alert(1)</script> <img src=x onerror=y>\"";
    const page = await get(`${base}/how-we-work/web`);
    expect(page.body).not.toContain("<script>alert");
    expect(page.body).not.toContain("<img src=x");
    expect(page.body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(page.headers["content-security-policy"]).toContain("default-src 'none'");
  });

  it("is not found for a project that is not registered, or a name that is not a project name, and for an install that has no playbook", async () => {
    expect((await get(`${base}/how-we-work/nobody`)).status).toBe(404);
    expect((await get(`${base}/how-we-work/.hidden`)).status).toBe(404);
    expect((await get(`${base}/how-we-work/a%2Fb`)).status).toBe(404);
    const world = fakeWorld();
    const bare = await createLocalPagesServer({ data: world.data, actions: world.actions });
    const bareToken = bare.sessions.mint().token;
    try {
      expect((await raw(bare.origin, { path: `/s/${bareToken}/how-we-work`, headers: { host: new URL(bare.origin).host } })).status).toBe(404);
    } finally { await bare.close(); }
  });
});

describe("trying a draft", () => {
  const form = async (project = "web") => formOf((await get(`${base}/how-we-work/${project}`)).body, "/check");
  const check = async (text: string, project = "web") => {
    const f = await form(project);
    return post(f.action, { ...f.fields, text });
  };

  it("shows what a good draft would make, marked as a draft, and writes nothing", async () => {
    // The stored item is brought up to the file when a task starts or a step is sent; neither drawing the page nor the draft may change it.
    await service.current("web");
    const f = await form();
    const before = await store.get(projectPlaybookKey(COMPANY, "web"));
    expect(before).toMatchObject({ revision: 1 });
    const reply = await post(f.action, { ...f.fields, text: "version: 1\nrules: DRAFT-RULE\nstages:\n  build:\n    instructions: DRAFT-BUILD" });
    expect(reply.status).toBe(200);
    expect(reply.body).toContain("What the draft would make");
    expect(reply.body).toContain("DRAFT-RULE");
    expect(reply.body).toContain("DRAFT-BUILD");
    // The text the owner typed stays in the box, so it can be changed again.
    expect(decode(/<textarea[^>]*>([\s\S]*?)<\/textarea>/.exec(reply.body)![1]!)).toContain("DRAFT-RULE");
    expect(await store.get(projectPlaybookKey(COMPANY, "web"))).toEqual(before);
    expect(files["web"]).toBe(FILE);
  });

  it("says what is wrong with a draft that cannot be used", async () => {
    const reply = await check("version: 1\nstages:\n  pull_request:\n    instructions: x");
    expect(reply.body).toContain("The draft cannot be used");
    expect(reply.body).toContain("stages.pull_request");
    expect(reply.body).not.toContain("What the draft would make");
  });

  it("answers a form once, and only for the project it was drawn for", async () => {
    const f = await form("web");
    expect((await post(f.action, { ...f.fields, text: "version: 1" })).status).toBe(200);
    const replay = await post(f.action, { ...f.fields, text: "version: 1" });
    expect(replay.status).toBe(303);
    expect(replay.headers["location"]).toContain("n=form");
    const docs = await form("docs");
    const crossed = await post(`${base}/how-we-work/web/check`, { ...docs.fields, text: "version: 1" });
    expect(crossed.status).toBe(303);
    expect(crossed.headers["location"]).toContain("n=form");
    expect((await post(`${base}/how-we-work/web/check`, { text: "version: 1" })).headers["location"]).toContain("n=form");
  });

  it("says how long a draft the page checks, and the box holds no more", async () => {
    const page = await get(`${base}/how-we-work/web`);
    expect(page.body).toContain(`maxlength="${String(DRAFT_CHARACTERS_MAX)}"`);
    expect(page.body).toContain("rovara playbook check");
  });
});

describe("the routes", () => {
  const call = async (path: string, method = "GET", body?: unknown) => {
    const answer = await local.routes({ method, path, headers: {}, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: answer?.statusCode, json: answer === undefined ? undefined : JSON.parse(answer.body) as Record<string, unknown> };
  };

  it("answers the effective view as Cloud does (the strict schema reads it), and the stored playbook beside it", async () => {
    const view = await call("/v1/app/projects/web/how-we-work");
    expect(view.status).toBe(200);
    const parsed = HowWeWorkViewSchema.parse(view.json);
    expect(parsed.rules.map((row) => row.value)).toEqual(["PROJECT-RULE: mention the ticket."]);
    // A GET writes nothing: the item is still as it was until a task starts or a step is sent.
    expect(parsed.playbookRevision).toBe(0);
    expect(await store.get(projectPlaybookKey(COMPANY, "web"))).toBeUndefined();
    const playbook = await call("/v1/app/projects/web/playbook");
    expect(ProjectPlaybookResponseSchema.parse(playbook.json).playbook).toEqual({ revision: 0, defaultProcess: { kind: "builtin" } });
    await service.current("web");
    expect((await call("/v1/app/projects/web/how-we-work")).json).toMatchObject({ playbookRevision: 1 });
  });

  it("answers the file's state for the CLI, and what a draft would make for `check`", async () => {
    const state = await call("/v1/local/playbook/web");
    expect(state.json).toMatchObject({ file: { status: "ok", repository: "local" }, playbook: { revision: 0 } });
    const good = await call("/v1/local/playbook/web/check", "POST", { text: "version: 1\nrules: X" });
    expect(good.json).toHaveProperty("view");
    const bad = await call("/v1/local/playbook/web/check", "POST", { text: "version: 3" });
    expect(bad.json).toMatchObject({ problems: [{ path: "version" }] });
    expect((await call("/v1/local/playbook/web/check", "POST", { text: 5 })).status).toBe(400);
    expect((await call("/v1/local/playbook/web/check", "POST", { text: "x".repeat(200_000) })).status).toBe(400);
  });

  it("refuses to edit in the web way, in words that say where the file is", async () => {
    for (const method of ["PUT", "POST"]) {
      const put = await call("/v1/app/projects/web/playbook", method, { expectedRevision: 1, defaultProcess: { kind: "builtin" } });
      expect(put.status).toBeGreaterThanOrEqual(400);
      expect((put.json?.["error"] as { message: string }).message).toBe(EDIT_THE_FILE);
    }
  });

  it("does not answer for a project that is not registered, a name that is not a project name, or a path that is not its own", async () => {
    expect((await call("/v1/app/projects/nobody/how-we-work")).status).toBe(404);
    expect((await call("/v1/app/projects/..%2F/how-we-work")).status).toBeUndefined();
    expect((await call("/v1/app/projects/web/other")).status).toBeUndefined();
    expect((await call("/v1/dev/tasks")).status).toBeUndefined();
    expect((await call("/v1/local/playbook/web", "DELETE")).status).toBe(404);
    expect(agentXError("NOT_AVAILABLE_HERE", EDIT_THE_FILE).statusCode).toBeGreaterThanOrEqual(400);
  });
});
