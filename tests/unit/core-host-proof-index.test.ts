// Cloud's Proof tab on a core task: `GET /v1/dev/tasks/{id}/evidence` through the core host's dev routes. Exactly the task read's rule (the flow's owned read: the member company, then the company's
// access rule); another company's task, a person who may not read the task and a missing task all get the same "not found". The answer is the proof index of the current code (proof-index.ts) and its
// failing tests, at most ten, as plain text.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { orgProjectCatalogKey, projectRevisionKey, type EvidencePack, type JsonValue, type ProjectDefinition } from "@agentx/contracts";
import type { TaskFlowDeps } from "../../packages/broker/src/core/task-flow/deps.js";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { readTask } from "../../packages/broker/src/core/task-flow/reads.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { evidencePackKey } from "../../packages/broker/src/core/proof/evidence-keep.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { createCoreHostApp, type CoreHostApp } from "../../packages/broker/src/core-host/index.js";
import { createCoreDevRoutes, type CompanyMembership, type CoreDevWiring, type DeployedCaller } from "../../packages/broker/src/core-host/dev-routes.js";
import { FAKE_COMPANY, createFakeWorld, type FakeWorld } from "../support/core-host-fakes.js";
import { DIGEST, v1Pack } from "../support/evidence-v2-fixtures.js";

const HONEST_CI = { honest: true as const, ciMode: () => "their_ci_fix" as const };
const OTHER = "org_corehost00000000000b";
const OWNER_ID = "person-owner-00000000001";
const READER_ID = "person-reader-0000000001";
const STRANGER_ID = "person-strange-000000001";
const PROJECT: ProjectDefinition = {
  name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
};
const SERVICES = () => ({ "merge-tracking": { pass: async () => ({}) }, "session-sweep": { pass: async () => ({}) }, "notify-deliver": { pass: async () => ({}) }, "admission-hold-sweep": { pass: async () => ({}) } });
const WIRED: CoreDevWiring = { origin: () => "https://api.example" };
const get = (path: string) => ({ method: "GET", path, headers: {} });
const SHA = "a".repeat(40);
const CHECK = (id: string, label: string) => ({ id, label, command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 30 } });
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** The company's rule as a deployment wires it: the task's own person, and the named readers, may read it. */
function hostedRule(readers: Set<string>): TaskFlowDeps["access"] {
  return {
    ...createOwnerTaskAccess(),
    async checkStart() { return { allowed: true }; },
    async canAct(principal, task) { return principal.personId === task.developerId || readers.has(principal.personId); },
  };
}

function appWith(world: FakeWorld, access: TaskFlowDeps["access"]): CoreHostApp {
  return createCoreHostApp({
    env: { ROVARA_CORE_ENGINE: "on" }, modules: world.modules, context: () => world.context(), nowMs: () => world.clock.now,
    runtime: () => ({ callbackSigningKey: Buffer.alloc(32, 7), access, repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(world.clock.now), log: () => undefined, services: SERVICES, ciReporting: HONEST_CI, flowOptions: { understandFirst: true } }),
  });
}

async function registerProject(world: FakeWorld, companyId: string): Promise<void> {
  await world.store.put({ item: { ...projectRevisionKey(companyId, PROJECT.name, PROJECT.revision), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(PROJECT)) as JsonValue } });
  await world.store.put({ item: { ...orgProjectCatalogKey(companyId, PROJECT.name), entityType: "PROJECT_CATALOG", latestRevision: PROJECT.revision } });
}

/** A v1 pack for the fixture's digest whose first check failed with these tests, each with a cause (`withCauses`). */
function failingPack(failing: string[], withCauses = true): EvidencePack {
  const pack = clone(v1Pack()) as unknown as { checks: Array<Record<string, unknown>> };
  pack.checks[0] = {
    ...pack.checks[0], after: "failed", class: "regression", exitCode: 1,
    tests: {
      total: failing.length + 1, passed: 1, failed: failing.length, skipped: 0, errored: 0,
      names: [...failing.map((name) => ({ name, status: "failed" })), { name: "tests/ok.test.ts::fine", status: "passed" }], newTests: [],
      ...(withCauses ? { failureCauses: failing.map((testId, index) => ({ testId, cause: index % 2 === 0 ? { kind: "change", paths: ["src/cart.ts"], pathsCount: 1, commit: SHA, basis: ["named_in_failure"] } : { kind: "unknown", reason: "weak_evidence" } })) } : {}),
    },
  };
  return pack as unknown as EvidencePack;
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
  const blobs = (await app.registry()).require("object-storage");
  /** A task of `companyId` started by `owner`, with a checked candidate (the fixture's digest), its recorded results and reviews, and (optionally) a kept pack. */
  const taskOf = async (owner: DeployedCaller, companyId: string, pack?: EvidencePack) => {
    const runtime = await app.runtimeFor(companyId);
    const { task } = await runtime.flow.start({ principal: owner.principal, client: "test", origin: "app" }, { requestId: randomUUID(), project: "payments", instructions: "Add a /health endpoint", workflow: true });
    const record = (await readTask(runtime.flow.deps, task.taskId))!;
    const workflow = {
      ...record.workflow!, candidate: { digest: DIGEST, repositories: [] },
      checkPolicy: { required: [CHECK("readiness:0", "pytest -q"), CHECK("readiness:7", "npm run build")], optional: [], selectedOptionalIds: [], proposed: [] },
      verification: { candidateDigest: DIGEST, results: [{ checkId: "readiness:0", status: "PASS" }, { checkId: "readiness:7", status: "FAILED" }] },
      reviews: [{ role: "CRITIC", candidateDigest: DIGEST, status: "PASS", findings: [] }, { role: "SECURITY", candidateDigest: DIGEST, status: "FINDINGS", findings: [{ text: "x" }] }],
    };
    await fake.store.put({ item: { ...(await fake.store.get(taskKey(task.taskId)))!, workflow } as never });
    if (pack !== undefined) await blobs.put(evidencePackKey({ ownerKey: record.ownerKey, workspaceId: record.workspaceId, taskId: task.taskId }, DIGEST), Buffer.from(JSON.stringify(pack)), { contentType: "application/json", metadata: {}, retention: "evidence-std" }, { overwrite: true });
    return task.taskId;
  };
  const read = (caller: DeployedCaller, taskId: string) => routes.route(get(`/v1/dev/tasks/${taskId}/evidence`), caller);
  return { fake, routes, readers, person, taskOf, read, blobs };
}

const body = (answer: { statusCode: number; body: string } | undefined): Record<string, unknown> => ({ status: answer?.statusCode, ...JSON.parse(answer!.body) as Record<string, unknown> });

describe("GET /v1/dev/tasks/{id}/evidence on a core task", () => {
  it("answers the owner the proof index of the current code, with the failing tests and their likely causes", async () => {
    const w = await world();
    const owner = w.person(OWNER_ID, FAKE_COMPANY);
    const failing = ["tests/cart.test.ts::applies discount", "tests/cart.test.ts::rounds"];
    const taskId = await w.taskOf(owner, FAKE_COMPANY, failingPack(failing));
    const answer = body(await w.read(owner, taskId));
    expect(answer).toEqual({
      status: 200, taskId,
      items: [
        // readiness:0 is in the pack, so the pack's entry stands for it; readiness:7 has only Rovara's own record.
        { id: "check:1", title: "npm run build", kind: "check_result", verdict: "fail", criterionIds: [] },
        { id: "review:code", title: "Code review", kind: "review", verdict: "pass", criterionIds: [] },
        { id: "review:security", title: "Security review", kind: "review", verdict: "fail", criterionIds: [] },
        { id: "evidence:0", title: "pytest -q", kind: "test_report", verdict: "fail", criterionIds: [] },
        { id: "evidence:1", title: "ruff", kind: "check_result", verdict: "pass", criterionIds: [] },
        { id: "evidence:2", title: "semgrep", kind: "check_result", verdict: "pass", criterionIds: [] },
      ],
      failures: [
        { check: "pytest -q", test: failing[0], cause: "likely broken by a change (commit aaaaaaa) to src/cart.ts" },
        { check: "pytest -q", test: failing[1], cause: "unknown (only weak evidence)" },
      ],
    });
  });

  it.each(["CRITIC", "SECURITY"])("a failure-marked PASS from %s stays unknown through the hosted evidence route", async (role) => {
    const w = await world();
    const owner = w.person(OWNER_ID, FAKE_COMPANY);
    const taskId = await w.taskOf(owner, FAKE_COMPANY);
    const stored = (await w.fake.store.get(taskKey(taskId)))!;
    const workflow = stored["workflow"] as unknown as { reviews: Array<{ role: string; status: string; failureReason?: string }> };
    const review = workflow.reviews.find((entry) => entry.role === role)!;
    review.status = "PASS";
    review.failureReason = "SESSION_FAILED";
    await w.fake.store.put({ item: { ...stored, workflow } });
    const answer = body(await w.read(owner, taskId));
    expect(answer["status"]).toBe(200);
    const items = answer["items"] as Array<{ id: string; verdict: string }>;
    expect(items.find((item) => item.id === (role === "CRITIC" ? "review:code" : "review:security"))?.verdict).toBe("unknown");
  });

  it("with no kept pack, answers only what Rovara recorded and no failures key", async () => {
    const w = await world();
    const owner = w.person(OWNER_ID, FAKE_COMPANY);
    const taskId = await w.taskOf(owner, FAKE_COMPANY);
    const answer = body(await w.read(owner, taskId));
    expect(Object.keys(answer)).not.toContain("failures");
    expect((answer["items"] as Array<{ id: string }>).map((item) => item.id)).toEqual(["check:0", "check:1", "review:code", "review:security"]);
  });

  it("answers a person the company's rule lets read the task (a reader), the same index", async () => {
    const w = await world();
    const owner = w.person(OWNER_ID, FAKE_COMPANY);
    const taskId = await w.taskOf(owner, FAKE_COMPANY, failingPack(["tests/a.test.ts::x"]));
    w.readers.add(READER_ID);
    const reader = w.person(READER_ID, FAKE_COMPANY);
    expect(body(await w.read(reader, taskId))).toEqual(body(await w.read(owner, taskId)));
  });

  it("refuses a member of the same company who may not read the task: exactly a missing task's answer, nothing of the task in it", async () => {
    const w = await world();
    const owner = w.person(OWNER_ID, FAKE_COMPANY);
    const taskId = await w.taskOf(owner, FAKE_COMPANY, failingPack(["tests/a.test.ts::secret name"]));
    for (const role of ["member", "admin", "owner"] as const) {
      const stranger = w.person(STRANGER_ID, FAKE_COMPANY, role);
      const refused = await w.read(stranger, taskId);
      const missing = await w.read(stranger, randomUUID());
      expect(refused?.statusCode).toBe(404);
      expect(refused).toEqual(missing);
      expect(refused!.body).not.toContain("secret name");
      expect(refused!.body).not.toContain(taskId);
    }
  });

  it("keeps two companies apart: each reads only its own task's index; the other company's task answers as a missing one", async () => {
    const w = await world();
    const ownerA = w.person(OWNER_ID, FAKE_COMPANY);
    const ownerB = w.person("person-ownerb-0000000001", OTHER);
    const taskA = await w.taskOf(ownerA, FAKE_COMPANY, failingPack(["tests/a.test.ts::company A only"]));
    const taskB = await w.taskOf(ownerB, OTHER, failingPack(["tests/b.test.ts::company B only"]));
    const a = await w.read(ownerA, taskA);
    const b = await w.read(ownerB, taskB);
    expect([a?.statusCode, b?.statusCode]).toEqual([200, 200]);
    expect(a!.body).toContain("company A only");
    expect(a!.body).not.toContain("company B only");
    expect(b!.body).toContain("company B only");
    expect(b!.body).not.toContain("company A only");
    // Across: B's owner on A's task (and A's on B's) reads exactly as a task that does not exist.
    expect(await w.read(ownerB, taskA)).toEqual(await w.read(ownerB, randomUUID()));
    expect(await w.read(ownerA, taskB)).toEqual(await w.read(ownerA, randomUUID()));
    expect((await w.read(ownerB, taskA))?.statusCode).toBe(404);
    // The same person, a member of A, whose token names B: refused before any task is read.
    const crossed: DeployedCaller = { principal: localOwnerPrincipal({ companyId: OTHER, personId: OWNER_ID }), client: "cli" };
    expect((await w.read(crossed, taskA))?.statusCode).not.toBe(200);
  });

  it("lists at most ten failing tests and counts the rest", async () => {
    const w = await world();
    const owner = w.person(OWNER_ID, FAKE_COMPANY);
    const failing = Array.from({ length: 13 }, (_, index) => `tests/many.test.ts::case ${String(index)}`);
    const taskId = await w.taskOf(owner, FAKE_COMPANY, failingPack(failing));
    const answer = body(await w.read(owner, taskId));
    expect((answer["failures"] as unknown[]).length).toBe(10);
    expect(answer["failuresNotListed"]).toBe(3);
    expect((answer["failures"] as Array<{ test: string }>).map((row) => row.test)).toEqual(failing.slice(0, 10));
  });

  it("shows only plain text: a hostile test id, path and check label cannot make a tag, link, mention or carry a secret", async () => {
    const w = await world();
    const owner = w.person(OWNER_ID, FAKE_COMPANY);
    const secret = `ghp_${"Ab1Cd2Ef3Gh4".repeat(3)}`;
    const hostile = `[x](https://evil.example/p) @owner #12 <img src=x onerror=alert(1)> ${secret}`;
    const id = `tests/${hostile}.test.ts::a`;
    const pack = failingPack([id]) as unknown as { checks: Array<Record<string, unknown>> };
    pack.checks[0]!["label"] = `<b>bold</b> ${hostile}`;
    (pack.checks[0]!["tests"] as { failureCauses: Array<{ cause: unknown }> }).failureCauses[0]!.cause = { kind: "change", paths: [`src/${hostile}.ts`], pathsCount: 1, basis: ["named_in_failure"] };
    const taskId = await w.taskOf(owner, FAKE_COMPANY, pack as unknown as EvidencePack);
    const answer = await w.read(owner, taskId);
    expect(answer?.statusCode).toBe(200);
    for (const bad of ["<img", "<b>", secret, "](https://", "https://evil", "@owner", "#12"]) expect(answer!.body, bad).not.toContain(bad);
    expect(answer!.body).toContain("likely broken by a change");
  });

  it("never shows a pack kept for other code than the current candidate", async () => {
    const w = await world();
    const owner = w.person(OWNER_ID, FAKE_COMPANY);
    const stale = { ...failingPack(["tests/a.test.ts::old"]), candidateDigest: "d".repeat(64) } as EvidencePack;
    const taskId = await w.taskOf(owner, FAKE_COMPANY, stale);
    const answer = await w.read(owner, taskId);
    expect(answer!.body).not.toContain("evidence:");
    expect(answer!.body).not.toContain("failures");
  });

  it("refuses a script token (its closed list is a task's read only), and owns only GET", async () => {
    const w = await world();
    const owner = w.person(OWNER_ID, FAKE_COMPANY);
    const taskId = await w.taskOf(owner, FAKE_COMPANY, failingPack(["tests/a.test.ts::x"]));
    const token = { ...owner, scriptToken: { tokenId: "tok_1" } };
    const refused = await w.read(token, taskId);
    expect(refused?.statusCode).toBe(403);
    expect(refused!.body).not.toContain("tests/a.test.ts");
    for (const method of ["POST", "PUT", "DELETE"]) expect(await w.routes.route({ method, path: `/v1/dev/tasks/${taskId}/evidence`, headers: {} }, owner)).toBeUndefined();
  });
});
