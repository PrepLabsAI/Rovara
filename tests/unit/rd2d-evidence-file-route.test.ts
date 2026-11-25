// RD-2d: GET /v1/app/tasks/{taskId}/evidence/{sha}, the file behind a link of the checks read (core-host/task-evidence-file-routes.ts). Everything is judged through the real core host routes over the fake world: the task read's own
// rule first (every non-reader the same answer as a missing task), then the sha must be a link of the task's CURRENT pack, then retention and the bytes, then fixed headers (types never sniffed, text never HTML) and an audit line.
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ROUTES, routeIdOf } from "@preplabsai/rovara-code-api";
import { orgProjectCatalogKey, projectRevisionKey, type EvidencePack, type JsonValue, type ProjectDefinition } from "@agentx/contracts";
import type { TaskFlowDeps } from "../../packages/broker/src/core/task-flow/deps.js";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { readTask } from "../../packages/broker/src/core/task-flow/reads.js";
import type { TaskReadDecision } from "../../packages/broker/src/core/task-flow/read-rule.js";
import type { TaskRecord } from "../../packages/broker/src/core/task-flow/records.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { evidencePackKey } from "../../packages/broker/src/core/proof/evidence-keep.js";
import { evidenceArtifactKey } from "../../packages/broker/src/core/proof/evidence-artifacts.js";
import { evidenceHref, evidenceViewOf } from "../../packages/broker/src/core/proof/evidence-pack.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { createCoreHostApp, type CoreHostApp } from "../../packages/broker/src/core-host/index.js";
import { createCoreDevRoutes, type CompanyMembership, type CoreDevWiring, type DeployedCaller } from "../../packages/broker/src/core-host/dev-routes.js";
import { EVIDENCE_FILE_WORDS, EVIDENCE_READ_AUDIT, readTaskEvidenceFile, taskEvidenceFileRoute } from "../../packages/broker/src/core-host/task-evidence-file-routes.js";
import { appRouteOf } from "../../packages/broker/src/aws/dev-route-scopes.js";
import { FAKE_COMPANY, createFakeWorld } from "../support/core-host-fakes.js";
import { DIGEST, v1Pack } from "../support/evidence-v2-fixtures.js";

const D2 = "d".repeat(64);
const HONEST_CI = { honest: true as const, ciMode: () => "their_ci_fix" as const };
const OTHER = "org_corehost00000000000b";
const OWNER_ID = "person-owner-00000000001";
const COLLEAGUE_ID = "person-colleague-000000001";
const PROJECT: ProjectDefinition = {
  name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
};
const SERVICES = () => ({ "merge-tracking": { pass: async () => ({}) }, "session-sweep": { pass: async () => ({}) }, "notify-deliver": { pass: async () => ({}) }, "admission-hold-sweep": { pass: async () => ({}) } });
/** The deployment's wiring: the live project grant is re-read on every read (the hosted `canReadProject`), so the read rule proves it and `decision.codeDetails` is true. */
const WIRED: CoreDevWiring = { origin: () => "https://api.example", canReadProject: async () => true };
/** A laptop: no live-grant seam, nothing is proved, so the read rule gives no code details. */
const WIRED_LAPTOP: CoreDevWiring = { origin: () => "https://api.example" };
/** A decision as the one read rule makes it, for a test that calls the route's function directly (the mount's rule is tested through the routes and in task-read-rule.test.ts). */
const decisionOf = (task: TaskRecord, codeDetails: boolean): TaskReadDecision => ({ task, mode: "owner", money: false, sourceCode: codeDetails, codeDetails, decidedByReadRule: true });
const get = (path: string) => ({ method: "GET", path, headers: {} });
const shaOf = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const fileOf = (kind: "jpeg" | "log_txt" | "api_sample_json", bytes: Buffer) => ({ kind, sha256: shaOf(bytes), bytes: bytes.byteLength, retentionClass: "evidence-std" as const, content: bytes });
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("a screenshot of the checkout page")]);
const JPEG_AFTER = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), Buffer.from("the same page after the change")]);
const TAIL = Buffer.from("npm run build\nerror TS2304: cannot find name 'secret'\n");
const HTML = Buffer.from("<html><body><script>fetch('/v1/app/sessions')</script><img src=x onerror=alert(1)></body></html>\n");
const SAMPLE = Buffer.from('{"status":200}');

function hostedRule(readers: Set<string>): TaskFlowDeps["access"] {
  return { ...createOwnerTaskAccess(), async checkStart() { return { allowed: true }; }, async canAct(principal, task) { return principal.personId === task.developerId || readers.has(principal.personId); } };
}
function appWith(world: ReturnType<typeof createFakeWorld>, access: TaskFlowDeps["access"]): CoreHostApp {
  return createCoreHostApp({
    modules: world.modules, context: () => world.context(), nowMs: () => world.clock.now,
    runtime: () => ({ callbackSigningKey: Buffer.alloc(32, 7), access, repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(world.clock.now), log: () => undefined, services: SERVICES, ciReporting: HONEST_CI, flowOptions: { understandFirst: true } }),
  });
}
async function registerProject(world: ReturnType<typeof createFakeWorld>, companyId: string): Promise<void> {
  await world.store.put({ item: { ...projectRevisionKey(companyId, PROJECT.name, PROJECT.revision), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(PROJECT)) as JsonValue } });
  await world.store.put({ item: { ...orgProjectCatalogKey(companyId, PROJECT.name), entityType: "PROJECT_CATALOG", latestRevision: PROJECT.revision } });
}

type Stored = ReturnType<typeof fileOf>;
/** A pack as the keeper writes it: one command with an output tail, and (when screenshots are named) one browser scenario with a before and an after picture. */
function packWith(options: { tail?: Stored; before?: Stored[]; after?: Stored[]; samples?: Stored[] } = {}): EvidencePack {
  const ref = (file: Stored) => ({ kind: file.kind, sha256: file.sha256, bytes: file.bytes, retentionClass: file.retentionClass });
  const base = JSON.parse(JSON.stringify(v1Pack())) as unknown as Record<string, unknown>;
  return {
    ...base,
    checks: [{ checkId: "build", kind: "build", label: "npm run build", before: "passed", after: "failed", class: "regression", durationMs: 10, exitCode: 1, ...(options.tail === undefined ? {} : { outputTailRef: ref(options.tail) }) }],
    api: options.samples === undefined ? [] : [{ scenarioId: "orders", samples: options.samples.map(ref), diff: "none", changedPaths: [] }],
    browser: options.before === undefined && options.after === undefined ? [] : [{ scenarioId: "checkout", strip: { before: (options.before ?? []).map(ref), after: (options.after ?? []).map(ref) }, consoleErrors: 0 }],
    notTested: [],
  } as unknown as EvidencePack;
}

async function world() {
  const fake = createFakeWorld();
  await registerProject(fake, FAKE_COMPANY);
  await registerProject(fake, OTHER);
  const readers = new Set<string>();
  const app = appWith(fake, hostedRule(readers));
  const members = new Map<string, CompanyMembership>();
  const companyOf = vi.fn(async (caller: DeployedCaller) => members.get(`${caller.principal.personId}|${caller.principal.companyId}`));
  const person = (personId: string, companyId: string, role: CompanyMembership["role"] = "member"): DeployedCaller => {
    members.set(`${personId}|${companyId}`, { companyId, role });
    return { principal: localOwnerPrincipal({ companyId, personId }), client: "cli" };
  };
  const routes = createCoreDevRoutes({ app, companyOf, wiring: () => WIRED });
  const laptop = createCoreDevRoutes({ app, companyOf, wiring: () => WIRED_LAPTOP });
  const blobs = (await app.registry()).require("object-storage");
  /** A task of `companyId` started by `owner` with a checked candidate (the fixture's digest), a kept pack and the files it names (`stored`, written under this task's own key unless `under` names another task's). */
  const taskOf = async (owner: DeployedCaller, companyId: string, options: { pack?: EvidencePack; packFor?: string; stored?: Stored[] } = {}) => {
    const runtime = await app.runtimeFor(companyId);
    const { task } = await runtime.flow.start({ principal: owner.principal, client: "test", origin: "app" }, { requestId: randomUUID(), project: "payments", instructions: "Add a /health endpoint", workflow: true });
    const record = (await readTask(runtime.flow.deps, task.taskId))!;
    const workflow = { ...record.workflow!, candidate: { schemaVersion: 1, digest: DIGEST, repositories: [{ repositoryId: "demo", commitSha: "a".repeat(40), treeSha: "b".repeat(40) }] } };
    await fake.store.put({ item: { ...(await fake.store.get(taskKey(task.taskId)))!, workflow } as never });
    const owned = { ownerKey: record.ownerKey, workspaceId: record.workspaceId, taskId: task.taskId };
    if (options.pack !== undefined) await blobs.put(evidencePackKey(owned, options.packFor ?? DIGEST), Buffer.from(JSON.stringify(options.pack)), { contentType: "application/json", metadata: {}, retention: "evidence-std" }, { overwrite: true });
    for (const file of options.stored ?? []) await putFile(owned, file.sha256, file.content);
    return { ...owned, record };
  };
  const putFile = (owned: { ownerKey: string; workspaceId: string; taskId: string }, sha256: string, content: Uint8Array) =>
    blobs.put(evidenceArtifactKey(owned.ownerKey, owned.workspaceId, owned.taskId, sha256), content, { contentType: "text/plain", metadata: { sha256 }, retention: "evidence-std" }, { overwrite: true });
  const read = (caller: DeployedCaller, taskId: string, sha256: string) => routes.route(get(`/v1/app/tasks/${taskId}/evidence/${sha256}`), caller);
  const readOnLaptop = (caller: DeployedCaller, taskId: string, sha256: string) => laptop.route(get(`/v1/app/tasks/${taskId}/evidence/${sha256}`), caller);
  return { fake, app, routes, readers, person, taskOf, read, readOnLaptop, blobs, putFile };
}

const codeOf = (answer: { body: string } | undefined) => (JSON.parse(answer!.body) as { error?: { code?: string; message?: string } }).error;

describe("what the owner reads", () => {
  it("a command output is served as text/plain with the fixed safe headers, and an audit line names who, the task, the digest and the kind (never the bytes)", async () => {
    const w = await world();
    const owner = w.person(OWNER_ID, FAKE_COMPANY);
    const tail = fileOf("log_txt", TAIL);
    const { taskId } = await w.taskOf(owner, FAKE_COMPANY, { pack: packWith({ tail }), stored: [tail] });
    const answer = await w.read(owner, taskId, tail.sha256);
    expect(answer?.statusCode).toBe(200);
    expect(answer!.body).toBe(TAIL.toString("utf8"));
    expect(answer!.isBase64Encoded).toBeUndefined();
    expect(answer!.headers).toMatchObject({
      "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff", "cache-control": "no-store",
      "content-disposition": `inline; filename="evidence-${tail.sha256.slice(0, 12)}.txt"`, "x-frame-options": "DENY", "referrer-policy": "no-referrer",
    });
    expect(answer!.headers["content-security-policy"]).toBe("default-src 'none'; sandbox; frame-ancestors 'none'");
    const lines = w.fake.audit.filter((event) => event.action === EVIDENCE_READ_AUDIT);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ companyId: FAKE_COMPANY, actor: { type: "person", id: OWNER_ID }, subject: { type: "task", id: taskId }, details: { sha256: tail.sha256, kind: "log_txt" } });
    expect(JSON.stringify(lines[0])).not.toContain("TS2304");
  });

  it("a screenshot is served as image/jpeg, carried as base64 for the gateway, and decodes to the stored bytes", async () => {
    const w = await world();
    const owner = w.person(OWNER_ID, FAKE_COMPANY);
    const before = fileOf("jpeg", JPEG);
    const after = fileOf("jpeg", JPEG_AFTER);
    const { taskId } = await w.taskOf(owner, FAKE_COMPANY, { pack: packWith({ before: [before], after: [after] }), stored: [before, after] });
    for (const [file, bytes] of [[before, JPEG], [after, JPEG_AFTER]] as const) {
      const answer = await w.read(owner, taskId, file.sha256);
      expect(answer?.statusCode).toBe(200);
      expect(answer!.isBase64Encoded).toBe(true);
      expect(Buffer.from(answer!.body, "base64").equals(bytes)).toBe(true);
      expect(answer!.headers).toMatchObject({ "content-type": "image/jpeg", "x-content-type-options": "nosniff", "cache-control": "no-store", "content-disposition": `inline; filename="evidence-${file.sha256.slice(0, 12)}.jpg"` });
    }
  });

  it("serves exactly the hrefs the checks read emits (evidenceViewOf): every available link answers 200 and no other shape is written", async () => {
    const w = await world();
    const owner = w.person(OWNER_ID, FAKE_COMPANY);
    const tail = fileOf("log_txt", TAIL);
    const before = fileOf("jpeg", JPEG);
    const after = fileOf("jpeg", JPEG_AFTER);
    const pack = packWith({ tail, before: [before], after: [after] });
    const { taskId } = await w.taskOf(owner, FAKE_COMPANY, { pack, stored: [tail, before, after] });
    const view = evidenceViewOf(pack, taskId, () => "available")!;
    const hrefs = [view.checks[0]!.outputTailRef!.href!, view.browser[0]!.strip.before[0]!.href!, view.browser[0]!.strip.after[0]!.href!];
    expect(hrefs).toEqual([tail, before, after].map((file) => `/v1/app/tasks/${taskId}/evidence/${file.sha256}`));
    expect(hrefs[0]).toBe(evidenceHref(taskId, tail));
    for (const href of hrefs) {
      expect(taskEvidenceFileRoute(href, "GET"), href).toEqual({ taskId, sha256: href.split("/").at(-1) });
      expect((await w.routes.route(get(href), owner))?.statusCode, href).toBe(200);
    }
  });

  it("is a row of the Code API table (GET, tasks:read) and the broker's own route selector finds it", () => {
    const row = ROUTES.find((candidate) => candidate.method === "GET" && candidate.path === "/v1/app/tasks/{taskId}/evidence/{sha}");
    expect(row).toMatchObject({ requires: "tasks:read" });
    expect(row!.response).toBeUndefined();
    expect(routeIdOf(row!)).toBe("GET /v1/app/tasks/{taskId}/evidence/{sha}");
    expect(appRouteOf("GET", `/v1/app/tasks/${randomUUID()}/evidence/${"a".repeat(64)}`)).toBe(row);
    expect(appRouteOf("POST", `/v1/app/tasks/${randomUUID()}/evidence/${"a".repeat(64)}`)).toBeUndefined();
  });

  it("owns GET on exactly this path and nothing else", async () => {
    const id = randomUUID();
    const sha = "a".repeat(64);
    expect(taskEvidenceFileRoute(`/v1/app/tasks/${id}/evidence/${sha}`, "GET")).toEqual({ taskId: id, sha256: sha });
    for (const [path, method] of [[`/v1/app/tasks/${id}/evidence/${sha}`, "POST"], [`/v1/app/tasks/${id}/evidence/${sha}`, "PUT"], [`/v1/app/tasks/${id}/evidence/${sha}/x`, "GET"], [`/v1/app/tasks/${id}/evidence/`, "GET"], [`/v1/app/tasks/${id}/evidence`, "GET"],
      [`/v1/app/tasks/not-a-uuid/evidence/${sha}`, "GET"], [`/v1/dev/tasks/${id}/evidence/${sha}`, "GET"], [`/v1/app/tasks/${id}/evidences/${sha}`, "GET"]] as const) {
      expect(taskEvidenceFileRoute(path, method), `${method} ${path}`).toBeUndefined();
    }
    const w = await world();
    const owner = w.person(OWNER_ID, FAKE_COMPANY);
    expect(await w.routes.route({ method: "POST", path: `/v1/app/tasks/${id}/evidence/${sha}`, headers: {} }, owner)).toBeUndefined();
  });
});

describe("the task read's own rule first: every one who may not read the task gets the missing task's answer", () => {
  it("another company's member, a colleague who may not read, a company admin who may not read, a missing task and a malformed digest all answer alike, saying nothing of the task, the pack or the file", async () => {
    const w = await world();
    const owner = w.person(OWNER_ID, FAKE_COMPANY);
    const stranger = w.person("person-ownerb-0000000001", OTHER);
    const colleague = w.person(COLLEAGUE_ID, FAKE_COMPANY);
    const admin = w.person("person-admin-00000000001", FAKE_COMPANY, "admin");
    const tail = fileOf("log_txt", TAIL);
    const { taskId } = await w.taskOf(owner, FAKE_COMPANY, { pack: packWith({ tail }), stored: [tail] });
    const missing = await w.read(colleague, randomUUID(), tail.sha256);
    expect(missing?.statusCode).toBe(404);
    expect(codeOf(missing)?.code).toBe("TASK_NOT_FOUND");
    for (const caller of [stranger, colleague, admin]) {
      const answer = await w.read(caller, taskId, tail.sha256);
      expect(answer, "as a missing task").toEqual(missing);
      expect(answer!.body).not.toContain(taskId);
      expect(answer!.body).not.toContain("TS2304");
    }
    // The reader's own answers for a digest the pack does not name (or one that is not a digest at all) are the same words: nothing tells a pack's files from no files.
    for (const sha of ["f".repeat(64), "not-a-digest", tail.sha256.toUpperCase(), tail.sha256.slice(1)]) expect(await w.read(owner, taskId, sha), sha).toEqual(missing);
    // Named as a reader, the colleague reads the file; the same person with a token of the other company is refused before anything is read.
    w.readers.add(COLLEAGUE_ID);
    expect((await w.read(colleague, taskId, tail.sha256))?.statusCode).toBe(200);
    const crossed: DeployedCaller = { principal: localOwnerPrincipal({ companyId: OTHER, personId: OWNER_ID }), client: "cli" };
    expect((await w.read(crossed, taskId, tail.sha256))?.statusCode).not.toBe(200);
    expect(w.fake.audit.filter((event) => event.action === EVIDENCE_READ_AUDIT).map((event) => event.actor.id)).toEqual([COLLEAGUE_ID]);
  });

  it("the links the checks read serves lead here: the output link of the checks read (EVIDENCE_FILES_SERVED) is this route's address and answers the file", async () => {
    const w = await world();
    const owner = w.person(OWNER_ID, FAKE_COMPANY);
    const tail = fileOf("log_txt", TAIL);
    const { taskId } = await w.taskOf(owner, FAKE_COMPANY, { pack: packWith({ tail }), stored: [tail] });
    const checks = await w.routes.route(get(`/v1/dev/tasks/${taskId}/checks`), owner);
    expect(checks?.statusCode).toBe(200);
    const row = (JSON.parse(checks!.body) as { checks: { rows: Array<{ id: string; output?: { href?: string } }> } }).checks.rows.find((candidate) => candidate.id === "build");
    expect(row?.output?.href).toBe(`/v1/app/tasks/${taskId}/evidence/${tail.sha256}`);
    const served = await w.routes.route(get(row!.output!.href!), owner);
    expect(served?.statusCode).toBe(200);
    expect(served?.body).toBe(TAIL.toString("utf8"));
  });

  it("a script token never reaches a file (it reads like a route that does not exist, before anything of the task is read)", async () => {
    const w = await world();
    const owner = w.person(OWNER_ID, FAKE_COMPANY);
    const tail = fileOf("log_txt", TAIL);
    const { taskId } = await w.taskOf(owner, FAKE_COMPANY, { pack: packWith({ tail }), stored: [tail] });
    const token = await w.routes.route(get(`/v1/app/tasks/${taskId}/evidence/${tail.sha256}`), { ...owner, scriptToken: { tokenId: "stk_aaaaaaaaaaaaaaaaaaaa" } });
    expect(token?.statusCode).toBe(404);
    expect(codeOf(token)?.code).toBe("NOT_FOUND");
    expect(token!.body).not.toContain("TS2304");
    expect(await w.routes.route(get(`/v1/app/tasks/${randomUUID()}/evidence/${tail.sha256}`), { ...owner, scriptToken: { tokenId: "stk_aaaaaaaaaaaaaaaaaaaa" } })).toEqual(token);
    expect(w.fake.audit.filter((event) => event.action === EVIDENCE_READ_AUDIT)).toEqual([]);
  });

  it("the code-details decision is its own: when it says no (no live project grant proved: a laptop), the same missing-task answer, and nothing of the pack or the store is read", async () => {
    const w = await world();
    const owner = w.person(OWNER_ID, FAKE_COMPANY);
    const tail = fileOf("log_txt", TAIL);
    const { taskId } = await w.taskOf(owner, FAKE_COMPANY, { pack: packWith({ tail }), stored: [tail] });
    // Through the routes: the hosted wiring proves the grant and serves the file; a wiring that proves none answers exactly as a missing task.
    expect((await w.read(owner, taskId, tail.sha256))?.statusCode).toBe(200);
    const blind = await w.readOnLaptop(owner, taskId, tail.sha256);
    expect(blind?.statusCode).toBe(404);
    expect(codeOf(blind)).toEqual({ code: "TASK_NOT_FOUND", message: "no such task" });
    // The function itself, on the decision's own part: nothing of the pack or the store is touched when code details are refused.
    const runtime = await w.app.runtimeFor(FAKE_COMPANY);
    const record = (await readTask(runtime.flow.deps, taskId))!;
    const touched = vi.fn();
    const watched = new Proxy(w.blobs, { get: (target, name, receiver) => { touched(String(name)); const value = Reflect.get(target, name, receiver) as unknown; return typeof value === "function" ? value.bind(target) as unknown : value; } });
    const context = { flow: runtime.flow, blobs: watched, caller: { principal: owner.principal }, audit: { stage: () => [], record: async () => undefined }, now: () => 0, taskId, sha256: tail.sha256 };
    await expect(readTaskEvidenceFile({ ...context, decision: decisionOf(record, false) })).rejects.toMatchObject({ code: "TASK_NOT_FOUND", message: expect.stringContaining("no such task") as string });
    expect(touched).not.toHaveBeenCalled();
    expect((await readTaskEvidenceFile({ ...context, decision: decisionOf(record, true) })).statusCode).toBe(200);
  });
});

describe("the sha must be a link of the task's CURRENT pack", () => {
  it("another task's file, an object the pack does not name, a file of an older candidate's pack and a kind this route does not serve all answer as a missing task", async () => {
    const w = await world();
    const owner = w.person(OWNER_ID, FAKE_COMPANY);
    const mine = fileOf("log_txt", TAIL);
    const others = fileOf("log_txt", Buffer.from("another task's output\n"));
    const stray = fileOf("log_txt", Buffer.from("an object the pack never named\n"));
    const sample = fileOf("api_sample_json", SAMPLE);
    const older = fileOf("log_txt", Buffer.from("output of an older candidate\n"));
    const a = await w.taskOf(owner, FAKE_COMPANY, { pack: packWith({ tail: mine, samples: [sample] }), stored: [mine, stray, sample] });
    const b = await w.taskOf(owner, FAKE_COMPANY, { pack: packWith({ tail: others }), stored: [others] });
    // A pack kept for another candidate of task A (not its current code): its file is not served either.
    const c = await w.taskOf(owner, FAKE_COMPANY, { pack: packWith({ tail: older }), packFor: D2, stored: [older] });
    const missing = await w.read(owner, randomUUID(), mine.sha256);
    expect((await w.read(owner, a.taskId, mine.sha256))?.statusCode).toBe(200);
    expect(await w.read(owner, a.taskId, others.sha256), "task B's file").toEqual(missing);
    expect(await w.read(owner, b.taskId, mine.sha256), "task A's file under task B").toEqual(missing);
    expect(await w.read(owner, a.taskId, stray.sha256), "stored but not named").toEqual(missing);
    expect(await w.read(owner, a.taskId, sample.sha256), "a kind this route does not serve").toEqual(missing);
    expect(await w.read(owner, c.taskId, older.sha256), "a pack of an older candidate").toEqual(missing);
    expect((await w.read(owner, b.taskId, others.sha256))?.statusCode).toBe(200);
  });

  it("a task with no kept pack, and one whose candidate is gone, serve nothing", async () => {
    const w = await world();
    const owner = w.person(OWNER_ID, FAKE_COMPANY);
    const tail = fileOf("log_txt", TAIL);
    const none = await w.taskOf(owner, FAKE_COMPANY, { stored: [tail] });
    expect(codeOf(await w.read(owner, none.taskId, tail.sha256))?.code).toBe("TASK_NOT_FOUND");
    const noCandidate = await w.taskOf(owner, FAKE_COMPANY, { pack: packWith({ tail }), stored: [tail] });
    const stored = (await w.fake.store.get(taskKey(noCandidate.taskId)))!;
    const { candidate: _candidate, ...withoutCandidate } = (stored as unknown as { workflow: Record<string, unknown> }).workflow;
    void _candidate;
    await w.fake.store.put({ item: { ...stored, workflow: withoutCandidate } as never });
    expect(codeOf(await w.read(owner, noCandidate.taskId, tail.sha256))?.code).toBe("TASK_NOT_FOUND");
  });

  it("the same bytes named by two tasks stay two objects: a file stored only under another task's key is never served for this task (it reads as past retention)", async () => {
    const w = await world();
    const owner = w.person(OWNER_ID, FAKE_COMPANY);
    const tail = fileOf("log_txt", TAIL);
    const a = await w.taskOf(owner, FAKE_COMPANY, { pack: packWith({ tail }) });
    const b = await w.taskOf(owner, FAKE_COMPANY, { pack: packWith({ tail }), stored: [tail] });
    const gone = await w.read(owner, a.taskId, tail.sha256);
    expect(gone?.statusCode).toBe(404);
    expect(codeOf(gone)).toEqual({ code: "NOT_FOUND", message: EVIDENCE_FILE_WORDS.expired });
    expect(gone!.body).not.toContain("TS2304");
    expect((await w.read(owner, b.taskId, tail.sha256))?.statusCode).toBe(200);
  });

  it("two companies stay apart: a member of the other company reads neither task nor file, and its own task's pack names only its own files", async () => {
    const w = await world();
    const ownerA = w.person(OWNER_ID, FAKE_COMPANY);
    const ownerB = w.person("person-ownerb-0000000001", OTHER);
    const tailA = fileOf("log_txt", Buffer.from("company A output\n"));
    const tailB = fileOf("log_txt", Buffer.from("company B output\n"));
    const a = await w.taskOf(ownerA, FAKE_COMPANY, { pack: packWith({ tail: tailA }), stored: [tailA] });
    const b = await w.taskOf(ownerB, OTHER, { pack: packWith({ tail: tailB }), stored: [tailB] });
    const missing = await w.read(ownerB, randomUUID(), tailA.sha256);
    expect(await w.read(ownerB, a.taskId, tailA.sha256)).toEqual(missing);
    expect(await w.read(ownerB, b.taskId, tailA.sha256)).toEqual(missing);
    expect(await w.read(ownerA, a.taskId, tailB.sha256)).toEqual(missing);
    expect((await w.read(ownerB, b.taskId, tailB.sha256))?.body).toBe("company B output\n");
  });
});

describe("retention and the bytes", () => {
  it("a file past its retention answers the fixed 'no longer kept' words; bytes that are no longer the pack's (other content, other size, too big, not what its kind says) answer the fixed 'not available' words; never the bytes", async () => {
    const w = await world();
    const owner = w.person(OWNER_ID, FAKE_COMPANY);
    const tail = fileOf("log_txt", TAIL);
    const shot = fileOf("jpeg", JPEG);
    const { taskId, ...owned } = await w.taskOf(owner, FAKE_COMPANY, { pack: packWith({ tail, before: [shot] }), stored: [tail, shot] });
    const words = async (sha: string) => { const answer = await w.read(owner, taskId, sha); expect(answer?.statusCode).toBe(404); expect(answer!.isBase64Encoded).toBeUndefined(); return codeOf(answer); };
    expect((await w.read(owner, taskId, tail.sha256))?.statusCode).toBe(200);
    // Gone from the store: past its retention.
    await w.blobs.delete(evidenceArtifactKey(owned.ownerKey, owned.workspaceId, taskId, tail.sha256));
    expect(await words(tail.sha256)).toEqual({ code: "NOT_FOUND", message: EVIDENCE_FILE_WORDS.expired });
    // The same size, other content (the digest no longer matches).
    await w.putFile({ ...owned, taskId }, tail.sha256, Buffer.alloc(tail.bytes, "x"));
    expect(await words(tail.sha256)).toEqual({ code: "NOT_FOUND", message: EVIDENCE_FILE_WORDS.withheld });
    // Another size.
    await w.putFile({ ...owned, taskId }, tail.sha256, Buffer.from("short"));
    expect(await words(tail.sha256)).toEqual({ code: "NOT_FOUND", message: EVIDENCE_FILE_WORDS.withheld });
    // Larger than the pack's own count (the size cap is the pack's byte count, never more).
    await w.putFile({ ...owned, taskId }, tail.sha256, Buffer.alloc(tail.bytes + 5000, "y"));
    expect(await words(tail.sha256)).toEqual({ code: "NOT_FOUND", message: EVIDENCE_FILE_WORDS.withheld });
    // A picture whose bytes are not a JPEG (the digest matching what is stored, but the pack's kind is not what the bytes are).
    const html = fileOf("jpeg", HTML);
    const fake = await w.taskOf(owner, FAKE_COMPANY, { pack: packWith({ before: [html] }), stored: [html] });
    const answer = await w.read(owner, fake.taskId, html.sha256);
    expect(answer?.statusCode).toBe(404);
    expect(codeOf(answer)).toEqual({ code: "NOT_FOUND", message: EVIDENCE_FILE_WORDS.withheld });
    expect(answer!.body).not.toContain("script");
    // Text with control characters is not text.
    const binary = fileOf("log_txt", Buffer.from([0x41, 0x00, 0x42, 0x07]));
    const control = await w.taskOf(owner, FAKE_COMPANY, { pack: packWith({ tail: binary }), stored: [binary] });
    expect(codeOf(await w.read(owner, control.taskId, binary.sha256))).toEqual({ code: "NOT_FOUND", message: EVIDENCE_FILE_WORDS.withheld });
    expect(w.fake.audit.filter((event) => event.action === EVIDENCE_READ_AUDIT)).toHaveLength(1);
  });

  it("HTML-looking command output is served as text/plain, nosniff and sandboxed, never as HTML", async () => {
    const w = await world();
    const owner = w.person(OWNER_ID, FAKE_COMPANY);
    const html = fileOf("log_txt", HTML);
    const { taskId } = await w.taskOf(owner, FAKE_COMPANY, { pack: packWith({ tail: html }), stored: [html] });
    const answer = await w.read(owner, taskId, html.sha256);
    expect(answer?.statusCode).toBe(200);
    expect(answer!.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(answer!.headers["content-type"]).not.toMatch(/html/iu);
    expect(answer!.headers["x-content-type-options"]).toBe("nosniff");
    expect(answer!.headers["content-security-policy"]).toContain("sandbox");
    expect(answer!.headers["content-disposition"]).toMatch(/^inline; filename="evidence-[a-f0-9]{12}\.txt"$/u);
    expect(answer!.body).toBe(HTML.toString("utf8"));
  });

  it("a store that cannot answer says so in fixed words (a fault is not 'expired'), and nothing is audited", async () => {
    const w = await world();
    const owner = w.person(OWNER_ID, FAKE_COMPANY);
    const tail = fileOf("log_txt", TAIL);
    const { taskId } = await w.taskOf(owner, FAKE_COMPANY, { pack: packWith({ tail }), stored: [tail] });
    const stat = vi.spyOn(w.blobs, "stat").mockRejectedValue(new Error("the bucket is down: secret-detail"));
    const answer = await w.read(owner, taskId, tail.sha256);
    stat.mockRestore();
    expect(answer?.statusCode).toBe(503);
    expect(codeOf(answer)).toEqual({ code: "RUNTIME_UNAVAILABLE", message: EVIDENCE_FILE_WORDS.unavailable });
    expect(answer!.body).not.toContain("secret-detail");
    expect(w.fake.audit.filter((event) => event.action === EVIDENCE_READ_AUDIT)).toEqual([]);
  });
});

describe("the audit line comes first", () => {
  it("an audit that cannot be written serves no file (fixed words, no bytes)", async () => {
    const w = await world();
    const owner = w.person(OWNER_ID, FAKE_COMPANY);
    const tail = fileOf("log_txt", TAIL);
    const { taskId } = await w.taskOf(owner, FAKE_COMPANY, { pack: packWith({ tail }), stored: [tail] });
    const runtime = await w.app.runtimeFor(FAKE_COMPANY);
    const record = (await readTask(runtime.flow.deps, taskId))!;
    const audit = { stage: () => [], record: vi.fn(async () => { throw new Error("audit down: secret-detail"); }) };
    const answer = readTaskEvidenceFile({ flow: runtime.flow, blobs: w.blobs, caller: { principal: owner.principal }, audit, now: () => 0, decision: decisionOf(record, true), taskId, sha256: tail.sha256 });
    await expect(answer).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE", message: expect.stringContaining(EVIDENCE_FILE_WORDS.notRecorded) as string });
    await expect(answer).rejects.not.toMatchObject({ message: expect.stringContaining("secret-detail") as string });
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it("a read writes nothing to the task and never logs the bytes", async () => {
    const w = await world();
    const owner = w.person(OWNER_ID, FAKE_COMPANY);
    const tail = fileOf("log_txt", TAIL);
    const shot = fileOf("jpeg", JPEG);
    const { taskId } = await w.taskOf(owner, FAKE_COMPANY, { pack: packWith({ tail, before: [shot] }), stored: [tail, shot] });
    const before = await w.fake.store.get(taskKey(taskId));
    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errored = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await w.read(owner, taskId, tail.sha256);
    await w.read(owner, taskId, shot.sha256);
    const printed = JSON.stringify([...logged.mock.calls, ...errored.mock.calls]);
    logged.mockRestore();
    errored.mockRestore();
    expect(printed).not.toContain("TS2304");
    expect(await w.fake.store.get(taskKey(taskId))).toEqual(before);
  });
});
