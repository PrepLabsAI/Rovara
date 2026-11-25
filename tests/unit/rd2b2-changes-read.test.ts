// RD-2b2: the task page's Changes read (`GET /v1/dev/tasks/{taskId}/changes`). Two layers:
//   - the view (core/task-view/changes.ts) over fake sources: the pages of a pull request, the order of the sources and the label of an unchecked list, the "why" join, the limits, and customer text made safe;
//   - the route on the core host (core-host/task-changes-routes.ts) over a real task flow: who may read (the task read's own rule; a colleague, a company admin who is not a reader and another company's caller all get the missing
//     task's answer), the pull request's files paged through the deployment's diff route, the plan read from the task's own storage, and the answer read with the Code API row's schema.
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ROUTES, ROUTE_NOT_SERVED_MESSAGE, routeIdOf } from "@preplabsai/rovara-code-api";
import { canonicalPlanJson, orgProjectCatalogKey, projectRevisionKey, type JsonValue, type ProjectDefinition, type WorkflowSnapshot } from "@agentx/contracts";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { taskKey, operationKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { WORKSPACE_DIFF_ARTIFACT, artifactRowKey, verifiedFilesKey } from "../../packages/broker/src/core/build-step/changed-files.js";
import { workspaceKeys } from "../../packages/broker/src/core/task-flow/workspace-location.js";
import { artifactObjectKey } from "../../packages/broker/src/services/callbacks.js";
import {
  CHANGES_FILES_MAX, CHANGES_PAGES_MAX, CHANGES_PATCH_MAX_CHARS, CHANGES_PATCH_TOTAL_MAX_CHARS, CHANGES_WHY_PER_FILE_MAX, plainLine, taskChangesOf,
  type ChangesSources, type ChangesTask, type PullRequestPage, type PullRequestPageFile,
} from "../../packages/broker/src/core/task-view/changes.js";
import { DIFF_ROUTE_PATCH_TOO_LONG } from "../../packages/broker/src/core-host/task-changes-routes.js";
import { DIFF_PATCH_TOO_LONG, type TaskDiffResponse } from "../../packages/broker/src/developer/task-code-routes.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { createCoreHostApp, type CoreHostApp } from "../../packages/broker/src/core-host/index.js";
import { createCompanyArtifactReader } from "../../packages/broker/src/core-host/company-artifact-reader.js";
import { createCoreDevRoutes, type CompanyMembership, type CoreDevWiring, type DeployedCaller } from "../../packages/broker/src/core-host/dev-routes.js";
import { FAKE_COMPANY, createFakeWorld, type FakeWorld } from "../support/core-host-fakes.js";
import { readsAsRow } from "../support/code-api-row-read.js";
import { planDocument } from "../support/plan-documents.js";
import { FolderObjectStorage } from "../../packages/local-adapters/src/folder-object-storage.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A key-shaped string the redaction must hide, built at run time (never a literal in the source). */
const FAKE_KEY = ["sk", "live", "0123456789abcdef0123"].join("-");
const TASK_ID = "11111111-1111-4111-8111-111111111111";

const pullRequest = (number: number, repositoryId = "demo") => ({ repositoryId, number, url: `https://github.com/example/${repositoryId}/pull/${number}`, candidateDigest: "a".repeat(64), required: true, state: "OPEN" as const });
const taskWith = (workflow: Record<string, unknown> | undefined): ChangesTask => ({ taskId: TASK_ID, ...(workflow === undefined ? {} : { workflow: workflow }) });
const file = (path: string, extra: Partial<PullRequestPageFile> = {}): PullRequestPageFile => ({ path, additions: 1, deletions: 0, patch: `@@ -0,0 +1 @@\n+${path}`, ...extra });
/** Pages of 30 files, as the diff route serves them. */
function pagesOf(total: number, options: { patch?: (index: number) => string | undefined } = {}): PullRequestPage[] {
  const pages: PullRequestPage[] = [];
  for (let start = 0; start < total; start += 30) {
    const files = Array.from({ length: Math.min(30, total - start) }, (_, offset) => {
      const index = start + offset;
      const patch = options.patch === undefined ? `@@ -0,0 +1 @@\n+line ${index}` : options.patch(index);
      return file(`src/f${index}.ts`, { patch });
    });
    pages.push({ files, more: start + 30 < total });
  }
  return pages;
}
function serving(pages: readonly (PullRequestPage | undefined | Error)[]): { read: NonNullable<ChangesSources["pullRequestPage"]>; asked: Array<{ repository: string; number: number; page: number }> } {
  const asked: Array<{ repository: string; number: number; page: number }> = [];
  return {
    asked,
    read: async (pr, page) => {
      asked.push({ ...pr, page });
      const answer = pages[page - 1];
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}
const listed = (...paths: string[]) => ({ files: paths.map((path) => ({ repository: "demo", path, added: 2, removed: 1 })), complete: true });

describe("the changes view: a pull request's files", () => {
  it("loops every page of the pull request, in order, and says the code host's list is what is shown", async () => {
    const source = serving(pagesOf(65));
    const view = await taskChangesOf(taskWith({ pullRequests: [pullRequest(7)] }), { pullRequestPage: source.read });
    expect(source.asked).toEqual([1, 2, 3].map((page) => ({ repository: "demo", number: 7, page })));
    expect(view.files.map((entry) => entry.path)).toEqual(Array.from({ length: 65 }, (_, index) => `src/f${index}.ts`));
    expect(view).toMatchObject({ taskId: TASK_ID, source: "pull_request", checkedAgainstCodeHost: true, pullRequests: [{ repository: "demo", number: 7, url: "https://github.com/example/demo/pull/7" }] });
    expect(view.filesNotListed).toBeUndefined();
    expect(view.files[0]).toEqual({ path: "src/f0.ts", repository: "demo", additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+line 0", why: [] });
  });

  it("reads each pull request of a task once (two repositories, a repeated one is read once)", async () => {
    const source = serving([{ files: [file("a.ts")], more: false }]);
    const view = await taskChangesOf(taskWith({ pullRequests: [pullRequest(7), pullRequest(7), pullRequest(3, "api")] }), { pullRequestPage: source.read });
    expect(source.asked).toEqual([{ repository: "demo", number: 7, page: 1 }, { repository: "api", number: 3, page: 1 }]);
    expect(view.files.map((entry) => `${entry.repository}:${entry.path}`)).toEqual(["demo:a.ts", "api:a.ts"]);
    expect(view.pullRequests.map((entry) => `${entry.repository}#${entry.number}`)).toEqual(["demo#7", "api#3"]);
  });

  it("lists at most CHANGES_FILES_MAX files and reads at most CHANGES_PAGES_MAX pages, and says files are left out", async () => {
    const source = serving(pagesOf(400));
    const view = await taskChangesOf(taskWith({ pullRequests: [pullRequest(7)] }), { pullRequestPage: source.read });
    expect(source.asked.length).toBe(CHANGES_PAGES_MAX);
    expect(view.files.length).toBe(CHANGES_FILES_MAX);
    // 10 pages of 30 are read (300 files): 100 are read and not listed, and at least one more page exists.
    expect(view.filesNotListed).toBe(300 - CHANGES_FILES_MAX + 1);
  });

  it("keeps a patch under the per-file limit, drops a longer one (truncated, no patch), and spends a total budget across the answer", async () => {
    const big = "x".repeat(CHANGES_PATCH_MAX_CHARS);
    const source = serving(pagesOf(60, { patch: (index) => index === 1 ? "y".repeat(CHANGES_PATCH_MAX_CHARS + 1) : big }));
    const view = await taskChangesOf(taskWith({ pullRequests: [pullRequest(7)] }), { pullRequestPage: source.read });
    expect(view.files[1]).toMatchObject({ truncated: true }); expect(view.files[1]).not.toHaveProperty("patch");
    const kept = view.files.filter((entry) => entry.patch !== undefined);
    expect(kept.reduce((total, entry) => total + entry.patch!.length, 0)).toBeLessThanOrEqual(CHANGES_PATCH_TOTAL_MAX_CHARS);
    expect(kept.length).toBe(Math.floor(CHANGES_PATCH_TOTAL_MAX_CHARS / CHANGES_PATCH_MAX_CHARS));
    // Past the budget a file is still listed, with its counts, and says its patch is not shown.
    const last = view.files.at(-1)!;
    expect(last).toMatchObject({ truncated: true, additions: 1 }); expect(last).not.toHaveProperty("patch");
  });

  it("a patch the diff route would not show whole is truncated; a file with no patch (binary) has no patch and is not truncated", async () => {
    const source = serving([{ files: [file("big.ts", { patch: undefined, tooLong: true }), file("logo.png", { patch: "" }), file("none.bin", { patch: undefined })], more: false }]);
    const view = await taskChangesOf(taskWith({ pullRequests: [pullRequest(7)] }), { pullRequestPage: source.read });
    expect(view.files[0]).toMatchObject({ path: "big.ts", truncated: true }); expect(view.files[0]).not.toHaveProperty("patch");
    for (const entry of view.files.slice(1)) { expect(entry).not.toHaveProperty("patch"); expect(entry).not.toHaveProperty("truncated"); }
  });

  it("a page that throws or answers nothing: the first page falls through to the next source, a later page keeps what was read and says some files are not listed", async () => {
    const first = await taskChangesOf(taskWith({ pullRequests: [pullRequest(7)] }), { pullRequestPage: serving([new Error("github said: token ghp_secret")]).read, reported: async () => listed("worker.ts") });
    expect(first).toMatchObject({ source: "worker_report", checkedAgainstCodeHost: false, files: [{ path: "worker.ts" }] });
    expect(JSON.stringify(first)).not.toContain("ghp_secret");
    const later = await taskChangesOf(taskWith({ pullRequests: [pullRequest(7)] }), { pullRequestPage: serving([{ files: [file("a.ts")], more: true }, undefined]).read });
    expect(later).toMatchObject({ source: "pull_request", checkedAgainstCodeHost: true, files: [{ path: "a.ts" }], filesNotListed: 1 });
  });
});

describe("the changes view: before the pull request, and which list is believed", () => {
  it("serves the code host's kept list (no patches, checked) ahead of the worker's report", async () => {
    const view = await taskChangesOf(taskWith({}), { verified: async () => listed("src/checked.ts"), reported: async () => listed("src/reported.ts") });
    expect(view).toMatchObject({ source: "pull_request", checkedAgainstCodeHost: true, pullRequests: [], files: [{ path: "src/checked.ts", repository: "demo", additions: 2, deletions: 1, why: [] }] });
    expect(view.files[0]).not.toHaveProperty("patch");
  });

  it("serves the worker's report labelled unchecked when nothing else exists, and never labels it checked", async () => {
    const view = await taskChangesOf(taskWith({}), { reported: async () => listed("src/reported.ts") });
    expect(view).toMatchObject({ source: "worker_report", checkedAgainstCodeHost: false, files: [{ path: "src/reported.ts" }] });
  });

  it("uses the code host's kept list when the pull request's pages cannot be read, and an unknown count stays unknown (not 0)", async () => {
    const view = await taskChangesOf(taskWith({ pullRequests: [pullRequest(7)] }), {
      pullRequestPage: async () => undefined,
      verified: async () => ({ files: [{ repository: "demo", path: "src/a.ts" }], complete: false }),
    });
    expect(view).toMatchObject({ source: "pull_request", checkedAgainstCodeHost: true, filesNotListed: 1 });
    expect(view.files[0]).not.toHaveProperty("additions"); expect(view.files[0]).not.toHaveProperty("deletions");
  });

  it("nothing to show is an empty list with no source, never an error (a source that throws is a source with nothing)", async () => {
    const boom = async () => { throw new Error("store down"); };
    expect(await taskChangesOf(taskWith({}), { verified: boom, reported: boom })).toEqual({ taskId: TASK_ID, checkedAgainstCodeHost: false, pullRequests: [], files: [] });
    expect(await taskChangesOf(taskWith(undefined), {})).toEqual({ taskId: TASK_ID, checkedAgainstCodeHost: false, pullRequests: [], files: [] });
    expect(await taskChangesOf(taskWith({ pullRequests: [pullRequest(7)] }), { pullRequestPage: async () => ({ files: [], more: false }) })).toMatchObject({ files: [], checkedAgainstCodeHost: false });
  });
});

describe("the changes view: the why", () => {
  const plan = planDocument({
    claims: [
      { id: "1", text: "Health answers 200 with the version.", evidence: [{ kind: "code", path: "src/health.ts", startLine: 1, endLine: 5 }] },
      { id: "2", text: "The router mounts it.", children: [{ id: "2.1", text: "Mounted at /health.", evidence: [{ kind: "code", path: "src/router.ts", startLine: 3, endLine: 9 }, { kind: "code", path: "src/health.ts", startLine: 1, endLine: 5 }] }] },
      { id: "3", text: "Nothing cites a file." },
    ],
    decisions: [],
    checks: { proposed: [{ id: "unit", label: "Unit tests", command: { cwd: "repo/demo", executable: "npx", args: ["vitest"], timeoutSeconds: 60 } }], proves: { unit: ["1"], other: ["2.1", "3"], "lonely": ["3"] } },
  });
  const designReview = { rounds: [
    { round: 1, findings: [{ id: "old", text: "An earlier round's finding.", citations: [{ kind: "code", repo: "demo", path: "src/old.ts", startLine: 1, endLine: 2, anchor: "a", commit: "abcdef1" }] }] },
    { round: 2, findings: [
      { id: "f1", text: "The health route skips auth.", citations: [{ kind: "design", section: "approach" }, { kind: "code", repo: "demo", path: "src/health.ts", startLine: 2, endLine: 3, anchor: "x", commit: "abcdef1" }] },
      { id: "f2", text: "Wrong repository.", citations: [{ kind: "code", repo: "api", path: "src/health.ts", startLine: 2, endLine: 3, anchor: "x", commit: "abcdef1" }] },
    ] },
  ] };
  const task = taskWith({ designReview, pullRequests: [pullRequest(7)] });

  it("joins by path: the steps whose code evidence cites the file, the checks that prove those steps, the latest round's findings for its own repository; steps before checks before findings", async () => {
    const view = await taskChangesOf(task, { plan, verified: async () => listed("src/health.ts", "src/router.ts", "README.md", "src/old.ts") });
    const why = Object.fromEntries(view.files.map((entry) => [entry.path, entry.why.map((item) => `${item.kind}:${item.id}`)]));
    expect(why["src/health.ts"]).toEqual(["step:1", "step:2.1", "check:unit", "check:other", "finding:f1"]);
    expect(why["src/router.ts"]).toEqual(["step:2.1", "check:other"]);
    // Nothing matches: empty, never a guess. A check that proves only a step no file cites, and an earlier round's finding, are not shown.
    expect(why["README.md"]).toEqual([]);
    expect(why["src/old.ts"]).toEqual([]);
    expect(view.files[0]!.why.find((item) => item.id === "1")).toEqual({ kind: "step", id: "1", text: "Health answers 200 with the version." });
    expect(view.files[0]!.why.find((item) => item.id === "unit")).toEqual({ kind: "check", id: "unit", text: "Unit tests" });
  });

  it("matches a renamed file by its old name, ignores a leading ./, and works from the pull request's own pages", async () => {
    const renamed = await taskChangesOf(task, { plan, reported: async () => ({ files: [{ repository: "demo", path: "src/new-health.ts", renamedFrom: "./src/health.ts" }], complete: true }) });
    expect(renamed.files[0]!.why.map((item) => item.id)).toContain("1");
    const paged = await taskChangesOf(task, { plan, pullRequestPage: serving([{ files: [file("src/health.ts")], more: false }]).read });
    expect(paged.files[0]!.why.map((item) => item.id)).toEqual(["1", "2.1", "unit", "other", "f1"]);
  });

  it("shows at most CHANGES_WHY_PER_FILE_MAX entries for a file and no why without a plan or a review", async () => {
    const many = planDocument({
      claims: Array.from({ length: 12 }, (_, index) => ({ id: String(index + 1), text: `Step ${index + 1}`, evidence: [{ kind: "code" as const, path: "src/a.ts", startLine: 1, endLine: 2 }] })),
      decisions: [],
    });
    const view = await taskChangesOf(taskWith({}), { plan: many, verified: async () => listed("src/a.ts") });
    expect(view.files[0]!.why.length).toBe(CHANGES_WHY_PER_FILE_MAX);
    expect((await taskChangesOf(taskWith({}), { verified: async () => listed("src/health.ts") })).files[0]!.why).toEqual([]);
  });
});

describe("the changes view: customer text is made safe", () => {
  it("removes control and direction characters from a path, redacts secrets everywhere (path, patch, why), and cuts long text", async () => {
    const evil = `src/${FAKE_KEY}\n/a\u202etxt.ts\u0007`;
    const planWithSecret = planDocument({ claims: [{ id: "1", text: `Uses ${FAKE_KEY} ${"long ".repeat(100)}`, evidence: [{ kind: "code", path: "src/a.ts", startLine: 1, endLine: 2 }] }], decisions: [] });
    const view = await taskChangesOf(taskWith({ pullRequests: [pullRequest(7)] }), {
      plan: planWithSecret,
      pullRequestPage: serving([{ files: [file(evil, { patch: `+const k = "${FAKE_KEY}";` }), file("src/a.ts"), file(`${"d/".repeat(400)}z.ts`)], more: false }]).read,
    });
    const text = JSON.stringify(view);
    expect(text).not.toContain(FAKE_KEY);
    // eslint-disable-next-line no-control-regex
    expect(view.files[0]!.path).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202e]/u);
    expect(view.files[0]!.patch).toContain("const k =");
    expect(view.files[1]!.why[0]!.text.length).toBeLessThanOrEqual(160);
    expect(view.files[2]!.path.length).toBe(500);
    expect(plainLine("   ", 10)).toBeUndefined();
    expect(plainLine(7, 10)).toBeUndefined();
  });

  it("a count that is not a whole non-negative number is left out, and a pull request address that is not https is not served", async () => {
    const view = await taskChangesOf(taskWith({ pullRequests: [{ ...pullRequest(7), url: "javascript:alert(1)" }] }), {
      pullRequestPage: serving([{ files: [{ path: "a.ts", additions: -3, deletions: Number.NaN, patch: "+a" }], more: false }]).read,
    });
    expect(view.pullRequests).toEqual([{ repository: "demo", number: 7 }]);
    expect(view.files[0]).not.toHaveProperty("additions"); expect(view.files[0]).not.toHaveProperty("deletions");
  });
});

// ---- the route on the core host

const OTHER = "org_corehost00000000000b";
const PROJECT: ProjectDefinition = {
  name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
};
const HONEST_CI = { honest: true as const, ciMode: () => "their_ci_fix" as const };
const SERVICES = () => ({ "merge-tracking": { pass: async () => ({}) }, "session-sweep": { pass: async () => ({}) }, "notify-deliver": { pass: async () => ({}) }, "admission-hold-sweep": { pass: async () => ({}) } });
const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const get = (path: string) => ({ method: "GET", path, headers: {}, body: "" });

function appOver(world: FakeWorld): CoreHostApp {
  return createCoreHostApp({
    modules: world.modules, context: () => world.context(), nowMs: () => world.clock.now,
    // The company's rule as a deployment wires it: only the person the task runs for acts on it or reads it through the core's own rule.
    runtime: () => ({ callbackSigningKey: Buffer.alloc(32, 7), access: { ...createOwnerTaskAccess(), canAct: async (principal, task) => principal.personId === task.developerId, canRead: async (principal, task) => principal.personId === task.developerId }, repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(world.clock.now), log: () => undefined, services: SERVICES, ciReporting: HONEST_CI }),
  });
}

async function register(world: FakeWorld, companyId: string): Promise<void> {
  await world.store.put({ item: { ...projectRevisionKey(companyId, PROJECT.name, PROJECT.revision), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(PROJECT)) as JsonValue } });
  await world.store.put({ item: { ...orgProjectCatalogKey(companyId, PROJECT.name), entityType: "PROJECT_CATALOG", latestRevision: PROJECT.revision } });
}

async function host(wiring: Partial<CoreDevWiring> = {}) {
  const objects = new FolderObjectStorage({ root: join(mkdtempSync(join(tmpdir(), "rd2b2-objects-")), "store"), maxObjectBytes: 10_000_000 });
  const world = createFakeWorld({ objects });
  await register(world, FAKE_COMPANY); await register(world, OTHER);
  const app = appOver(world);
  const members = new Map<string, CompanyMembership>();
  const callerOf = (companyId: string, personId: string, role: CompanyMembership["role"] = "member", roles: string[] = []): DeployedCaller => {
    const base = localOwnerPrincipal({ companyId, personId });
    members.set(personId + companyId, { companyId, role });
    return { principal: { ...base, roles }, client: "web", webApp: true };
  };
  const routes = createCoreDevRoutes({ app, companyOf: async (caller) => members.get(caller.principal.personId + caller.principal.companyId), wiring: () => ({ origin: () => "https://api.example", ...wiring }) });
  const owner = callerOf(FAKE_COMPANY, "owner-person");
  const runtime = await app.runtimeFor(FAKE_COMPANY);
  const { task } = await runtime.flow.start({ principal: localOwnerPrincipal({ companyId: FAKE_COMPANY, personId: "owner-person" }), origin: "app", client: "test" }, { requestId: randomUUID(), project: "payments", instructions: "Add a /health endpoint", workflow: true, workflowPath: "QUICK" });
  const stored = (await world.store.get(taskKey(task.taskId)))!;
  const setWorkflow = async (patch: Record<string, unknown>) => {
    await world.store.update({ key: taskKey(task.taskId), ops: [{ op: "set", path: ["workflow"], value: JSON.parse(JSON.stringify({ ...(stored["workflow"] as object), ...patch })) as JsonValue }] });
  };
  return { world, objects, app, routes, owner, callerOf, task, stored, setWorkflow, runtime };
}

describe("the changes route on the core host", () => {
  const row = ROUTES.find((candidate) => routeIdOf(candidate) === "tasks.changes")!;

  it("answers the owner with an empty, well-formed read for a task with nothing yet, and the answer reads with the row's schema", async () => {
    const h = await host();
    const answer = await h.routes.route(get(`/v1/dev/tasks/${h.task.taskId}/changes`), h.owner);
    expect(answer?.statusCode).toBe(200);
    expect(answer!.headers).toMatchObject({ "content-type": "application/json", "cache-control": "no-store" });
    const body = JSON.parse(answer!.body) as unknown;
    expect(body).toEqual({ changes: { taskId: h.task.taskId, checkedAgainstCodeHost: false, pullRequests: [], files: [] } });
    readsAsRow("tasks.changes", body);
    expect(row.errors).toContainEqual({ code: "ROUTE_NOT_SERVED", status: 404 });
    expect(ROUTE_NOT_SERVED_MESSAGE.length).toBeGreaterThan(0);
  });

  it("another company's caller, a colleague, a company admin who is not a reader and a missing task all get the same answer, and nothing is written", async () => {
    const h = await host();
    const before = JSON.stringify(await h.world.store.get(taskKey(h.task.taskId)));
    const missing = await h.routes.route(get(`/v1/dev/tasks/${randomUUID()}/changes`), h.owner);
    expect(missing?.statusCode).toBe(404);
    const callers = [h.callerOf(OTHER, "owner-person", "owner", ["owner"]), h.callerOf(FAKE_COMPANY, "colleague"), h.callerOf(FAKE_COMPANY, "admin-person", "admin", ["admin"]), h.callerOf(FAKE_COMPANY, "owner-of-install", "owner", ["owner"])];
    for (const caller of callers) {
      const answer = await h.routes.route(get(`/v1/dev/tasks/${h.task.taskId}/changes`), caller);
      expect(answer?.statusCode, caller.principal.personId).toBe(404);
      expect(JSON.parse(answer!.body), caller.principal.personId).toEqual(JSON.parse(missing!.body));
      expect(answer!.body).not.toContain(h.task.taskId);
    }
    expect(JSON.stringify(await h.world.store.get(taskKey(h.task.taskId)))).toBe(before);
  });

  it("has no shared-reader rule of its own: a person the old rule would admit reads no such task here (the one read rule will admit them), and a script token never gets here", async () => {
    const readsAsReader = vi.fn(async () => true);
    const h = await host({ taskRules: { route: async () => { throw new Error("not asked"); }, readsAsReader } });
    const reader = h.callerOf(FAKE_COMPANY, "reader-person");
    const answer = await h.routes.route(get(`/v1/dev/tasks/${h.task.taskId}/changes`), reader);
    const missing = await h.routes.route(get(`/v1/dev/tasks/${randomUUID()}/changes`), reader);
    expect(answer?.statusCode).toBe(404);
    expect(JSON.parse(answer!.body)).toEqual(JSON.parse(missing!.body));
    expect(readsAsReader).not.toHaveBeenCalled();
    const token = await h.routes.route(get(`/v1/dev/tasks/${h.task.taskId}/changes`), { ...reader, scriptToken: { tokenId: "stk_aaaaaaaaaaaaaaaaaaaa" } });
    expect(token?.statusCode).toBe(403);
  });

  it("pages the pull request's files through the deployment's diff route, as the person asking, and serves them with the why from the plan in the task's own storage", async () => {
    const pages: Record<number, TaskDiffResponse> = {
      1: { repository: "demo", number: 7, page: 1, more: true, files: [{ path: "src/health.ts", additions: 12, deletions: 0, patch: "@@ -0,0 +1 @@\n+export const health = 1;" }, { path: "src/huge.ts", additions: 9000, deletions: 0, patch: DIFF_PATCH_TOO_LONG }] },
      2: { repository: "demo", number: 7, page: 2, more: false, files: [{ path: "README.md", additions: 1, deletions: 1, patch: "" }] },
    };
    const seen: Array<{ path: string; person: { developerId: string; name: string }; companyId: string; method: string; taskId: unknown }> = [];
    const route = vi.fn(async (input: Parameters<NonNullable<CoreDevWiring["taskRules"]>["route"]>[0]) => {
      seen.push({ path: input.request.path, person: input.person, companyId: input.companyId, method: input.request.method, taskId: input.task["taskId"] });
      const page = Number(new URL(input.request.path, "https://x.invalid").searchParams.get("page"));
      return { statusCode: 200, headers: {}, body: JSON.stringify(pages[page]) };
    });
    const h = await host({ taskRules: { route, readsAsReader: async () => false } });
    // The task has a pull request and an approved plan whose first step cites src/health.ts.
    const plan = planDocument({ claims: [{ id: "1", text: "Health answers 200.", evidence: [{ kind: "code", path: "src/health.ts", startLine: 1, endLine: 3 }] }], decisions: [], checks: { proposed: [{ id: "unit", label: "Unit tests", command: { cwd: "repo/demo", executable: "npx", args: ["vitest"], timeoutSeconds: 60 } }], proves: { unit: ["1"] } } });
    const text = canonicalPlanJson(plan);
    const workflow = h.stored["workflow"] as WorkflowSnapshot;
    const objectKey = `private/${(h.stored["ownerKey"] as string)}/${(h.stored["workspaceId"] as string)}/plan-v1.json`;
    await h.objects.put(objectKey, new TextEncoder().encode(text), { contentType: "application/json", metadata: {}, retention: "plan" });
    await h.setWorkflow({ artifacts: [...workflow.artifacts, { id: "plan-v1", type: "plan", version: 1, sha256: sha(text), producer: "agentx-planner", objectKey, createdAt: "2026-11-15T10:00:00.000Z", format: "structured" }], pullRequests: [pullRequest(7)] });

    const answer = await h.routes.route(get(`/v1/dev/tasks/${h.task.taskId}/changes`), h.owner);
    expect(answer?.statusCode).toBe(200);
    const body = JSON.parse(answer!.body) as { changes: { files: Array<{ path: string; why?: unknown[]; patch?: string; truncated?: boolean }>; source: string } };
    readsAsRow("tasks.changes", body);
    expect(body.changes).toMatchObject({ source: "pull_request", checkedAgainstCodeHost: true, pullRequests: [{ repository: "demo", number: 7 }] });
    expect(body.changes.files.map((entry) => entry.path)).toEqual(["src/health.ts", "src/huge.ts", "README.md"]);
    expect(body.changes.files[0]).toMatchObject({ additions: 12, why: [{ kind: "step", id: "1", text: "Health answers 200." }, { kind: "check", id: "unit", text: "Unit tests" }] });
    // The diff route's "too long" words are a truncated file here, never a patch; a file with no patch has none.
    expect(body.changes.files[1]).toMatchObject({ truncated: true }); expect(body.changes.files[1]).not.toHaveProperty("patch");
    expect(body.changes.files[2]).not.toHaveProperty("patch");
    expect(seen).toEqual([1, 2].map((page) => ({ path: `/v1/dev/tasks/${h.task.taskId}/diff?repository=demo&number=7&page=${page}`, person: { developerId: "owner-person", name: h.owner.principal.displayName }, companyId: FAKE_COMPANY, method: "GET", taskId: h.task.taskId })));
  });

  it("falls back to the code host's kept list and then the worker's report, labelled, when the diff route cannot answer or is not wired", async () => {
    const refusing = vi.fn(async () => ({ statusCode: 502, headers: {}, body: JSON.stringify({ error: { message: "github down for ghp_secret" } }) }));
    for (const taskRules of [undefined, { route: refusing, readsAsReader: async () => false }]) {
      const h = await host(taskRules === undefined ? {} : { taskRules });
      // The deployment's company-bound reader of a workspace's saved files (the test runtime has none of its own).
      h.runtime.flow.deps.artifacts = createCompanyArtifactReader({ blobs: h.objects, store: h.world.store, companyId: FAKE_COMPANY });
      await h.setWorkflow({ pullRequests: [pullRequest(7)] });
      const location = await workspaceKeys(h.runtime.flow.deps, (h.stored["workspaceId"] as string));
      // The worker's report: a succeeded implement run with a saved diff.
      const diff = "## demo\n### status\n### diff\ndiff --git a/src/reported.ts b/src/reported.ts\n@@ -1 +1 @@\n-a\n+b\n";
      const workspaceId = (h.stored["workspaceId"] as string);
      const key = artifactObjectKey(workspaceId, "op-impl-1", WORKSPACE_DIFF_ARTIFACT);
      await h.objects.put(key, new TextEncoder().encode(diff), { contentType: "text/plain", metadata: {}, retention: "plan" });
      await h.world.store.put({ item: { ...operationKey(FAKE_COMPANY, workspaceId, "op-impl-1"), entityType: "OPERATION", id: "op-impl-1", workspaceId, kind: "task", workflowMode: "IMPLEMENT", status: "SUCCEEDED", fence: 1, createdAt: "2026-11-14T00:00:00.000Z", companyId: FAKE_COMPANY, dispatch: { kind: "task", payload: {} } } });
      await h.world.store.put({ item: { ...artifactRowKey(workspaceKey(FAKE_COMPANY, workspaceId), "op-impl-1", WORKSPACE_DIFF_ARTIFACT), entityType: "ARTIFACT", id: "art-1", workspaceId, operationId: "op-impl-1", name: WORKSPACE_DIFF_ARTIFACT, objectKey: key, sha256: sha(diff), bytes: diff.length, createdAt: "2026-11-14T00:00:01.000Z" } });
      const reported = JSON.parse((await h.routes.route(get(`/v1/dev/tasks/${h.task.taskId}/changes`), h.owner))!.body) as { changes: Record<string, unknown> };
      expect(reported.changes, "worker report").toMatchObject({ source: "worker_report", checkedAgainstCodeHost: false, files: [{ path: "src/reported.ts" }] });
      // Once the code host's list was kept for the task's code it wins, and is checked.
      const digest = "b".repeat(64);
      await h.setWorkflow({ pullRequests: [pullRequest(7)], candidate: { digest } });
      await h.world.store.put({ item: { ...verifiedFilesKey(location.workspaceKey, digest), entityType: "VERIFIED_FILES", candidateDigest: digest, complete: true, verifiedAt: "2026-11-15T10:00:00.000Z", files: [{ repository: "demo", path: "src/checked.ts", added: 3, removed: 1 }] } });
      const checked = JSON.parse((await h.routes.route(get(`/v1/dev/tasks/${h.task.taskId}/changes`), h.owner))!.body) as { changes: Record<string, unknown> };
      expect(checked.changes, "code host list").toMatchObject({ source: "pull_request", checkedAgainstCodeHost: true, files: [{ path: "src/checked.ts", additions: 3, deletions: 1 }] });
      expect(JSON.stringify([reported, checked])).not.toContain("ghp_secret");
    }
  });

  it("a diff answer that is not a 200 is not used, even with a page-shaped body, and nothing of it is served", async () => {
    const page = { repository: "demo", number: 7, page: 1, more: false, files: [{ path: "src/leak.ts", additions: 1, deletions: 0, patch: "+x" }] };
    const h = await host({ taskRules: { route: async () => ({ statusCode: 403, headers: {}, body: JSON.stringify(page) }), readsAsReader: async () => false } });
    await h.setWorkflow({ pullRequests: [pullRequest(7)] });
    const answer = await h.routes.route(get(`/v1/dev/tasks/${h.task.taskId}/changes`), h.owner);
    expect(answer?.statusCode).toBe(200);
    expect(answer!.body).not.toContain("leak.ts");
    expect(JSON.parse(answer!.body)).toMatchObject({ changes: { files: [], checkedAgainstCodeHost: false, pullRequests: [{ number: 7 }] } });
  });

  it("the diff route's own words for a patch that is too long are the words this read watches for", () => {
    expect(DIFF_ROUTE_PATCH_TOO_LONG).toBe(DIFF_PATCH_TOO_LONG);
  });
});
