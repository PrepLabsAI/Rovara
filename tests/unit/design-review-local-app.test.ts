// The design review through `rovara up` itself (the real wiring, on a fake worker machine): a design-review operation never gets a model key of its own, and the approval of a reviewed design goes through the approval gate at the
// tier the review's own facts give, with the approval record written in the decision's transaction. Nothing is faked between the callback listener, the model proxy and the gate.
import { request as httpRequest } from "node:http";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  DesignReviewBindingSchema, IMPLICIT_COMPANY_ID, WORKER_INVOCATION_FEATURES, WorkflowSnapshotSchema, closeDesignReview, decideWorkflow, enableDesignReview, recordIntentAssessment, startWorkflowPlanAfterUnderstand, startWorkflowUnderstand,
  designWaitOf, submitWorkflowArtifact, type WorkflowSnapshot,
} from "@rovara-code/contracts";
import { CallbackCapabilities } from "../../packages/core/src/callbacks.js";
import { approvalRecordKey } from "../../packages/core/src/core/decisions/approval-gate.js";
import { designApprovalKey } from "../../packages/core/src/core/design-review/decision.js";
import { ROVARA_CODE_PROGRAM } from "../../packages/core/src/core/plan/program.js";
import { deriveKey } from "../../packages/core/src/local/app/app.js";
import { startLocalRuntime, type LocalRuntime } from "../../packages/core/src/local/runtime.js";
import { CALLBACK_KEY_FILE_NAME } from "../../packages/core/src/local/state-directory.js";
import { FakeWorkerMachines } from "../../packages/core/src/ports/fake-worker-machines.js";
import { FakeDocker } from "../support/local/fake-docker.js";
import { Command } from "commander";
import { registerDesignReviewCommand } from "../../packages/cli/src/up/cli.js";
import { sweepDesignWaits } from "../../packages/core/src/core/design-review/wait.js";
import { taskOf, toRound, waitingWithBlocker, world as flowWorld } from "../support/design-review-flow-world.js";
import { formBody, formOf, raw } from "../support/local-pages-fakes.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length > 0) await cleanup.pop()!(); });

const NOW = "2026-11-09T10:00:00.000Z";
const PROJECT = { name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.", repositories: [{ name: "demo", url: "https://examplehost/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }] };
const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const SECTIONS = ["§1 Problem and goal", "§2 Current system", "§3 Proposed design", "§4 Alternatives", "§5 Risks", "§6 Areas touched", "§7 Assumptions", "§8 Sources"];
const DESIGN = `# Design\n${SECTIONS.map((section) => `## ${section}\ntext${section.startsWith("§3") ? "\n### 3.1 Retry\nR1: retry once." : ""}`).join("\n")}\n\`\`\`rovara-design-meta\n${JSON.stringify({ touches: ["data_model"], repositories: ["demo"], services: [], sources: [] })}\n\`\`\`\n`;
const REQUIREMENTS = "# Requirements\nR1: retry a timed-out payment once.\n";

async function launch() {
  const root = await mkdtemp(join(tmpdir(), "rovara-dr-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const stateDirectory = join(root, "state");
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const key = ["sk", "ant", "d".repeat(24)].join("-");
  const opened: string[] = [];
  const runtime: LocalRuntime = await startLocalRuntime({
    stateDirectory, cwd: join(root, "project"), environment: { ROVARA_DESIGN_REVIEW: "1", ANTHROPIC_API_KEY: key }, gh: async () => undefined, workerImage: "worker:test", docker: new FakeDocker(), version: "9.9.9",
    machines: new FakeWorkerMachines({ startingChecks: 0, features: [...WORKER_INVOCATION_FEATURES] }), timers: false, openBrowser: async (url: string) => { opened.push(url); },
  });
  cleanup.push(() => runtime.stop());
  const token = (await readFile(runtime.sessionTokenPath, "utf8")).trim();
  const api = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const response = await fetch(`${runtime.url}${path}`, { method: init.method ?? "GET", headers: { authorization: `Bearer ${token}`, ...(init.body === undefined ? {} : { "content-type": "application/json" }) }, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  await api("/v1/admin/projects", { method: "POST", body: PROJECT });
  const started = await api("/v1/dev/tasks", { method: "POST", body: { requestId: randomUUID(), project: "payments", instructions: "Retry timed-out payments", workflow: true } });
  const taskId = (started.body["task"] as { taskId: string }).taskId;
  const store = runtime.registry.require("storage");
  const task = (await store.get({ pk: `DEVTASK#${taskId}`, sk: "META" }))!;
  const workspaceId = task["workspaceId"] as string;
  const operationId = (await store.get({ pk: `WORKSPACE#${workspaceId}`, sk: "META" }))!["activeOperationId"] as string;
  /** The owner's "open in browser": the server opens a single-use address, which a browser follows once to land on the page. */
  const browse = async (path: string): Promise<URL> => {
    const before = opened.length;
    expect((await api("/v1/local/pages/open", { method: "POST", body: { path } })).status).toBe(200);
    expect(opened.length).toBe(before + 1);
    const once = new URL(opened.at(-1)!);
    const hop = await raw(runtime.pagesUrl, { path: once.pathname, headers: { host: once.host } });
    return new URL(hop.headers["location"] as string, runtime.pagesUrl);
  };
  return { root, stateDirectory, runtime, api, store, browse, taskId, workspaceId, operationId, opened };
}
type World = Awaited<ReturnType<typeof launch>>;

/** What a worker's gateway sends to the callback listener for the model-access route. */
const modelAccess = (w: World, capability: string, query = "") => new Promise<{ status: number; text: string }>((resolve, reject) => {
  const req = httpRequest({
    host: "127.0.0.1", port: w.runtime.callbackPort, method: "GET", setHost: false, path: `/v1/internal/model-access${query}`,
    headers: { host: `host.docker.internal:${w.runtime.callbackPort}`, "x-agentx-callback-capability": capability, "x-rovara-workspace": w.workspaceId },
  }, (response) => {
    const chunks: Buffer[] = [];
    response.on("data", (chunk: Buffer) => chunks.push(chunk));
    response.on("end", () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
  });
  req.on("error", reject);
  req.end();
});

describe("a design-review operation's model key", () => {
  it("is never the operation's own: the same capability that gets an ordinary operation a token gets a design-review operation nothing", async () => {
    const w = await launch();
    const root = Buffer.from((await readFile(join(w.stateDirectory, CALLBACK_KEY_FILE_NAME), "utf8")).trim(), "base64url");
    const operation = (await w.store.get({ pk: `WORKSPACE#${w.workspaceId}`, sk: `OPERATION#${w.operationId}` }))!;
    const capability = new CallbackCapabilities(deriveKey(root, "callback-capability")).issue({
      workspaceId: w.workspaceId, operationId: w.operationId, fence: operation["fence"] as number, actions: ["artifacts", "events", "result", "model-access"], expiresInSeconds: 600,
    });
    // The control: the ordinary operation gets a token.
    const ordinary = await modelAccess(w, capability);
    expect(ordinary.status, ordinary.text).toBe(200);
    expect(ordinary.text).toContain("apiKey");
    // The same operation, now a design review's round (it has a stored binding): no token of its own, with or without a slot, and no slot nobody allocated.
    const binding = DesignReviewBindingSchema.parse({ version: 1, round: 1, reviewers: [{ role: "critic", keySlot: "r1-critic", packetDigest: "a".repeat(64), model: { provider: "anthropic", modelId: "m1" } }] });
    await w.store.update({ key: { pk: `WORKSPACE#${w.workspaceId}`, sk: `OPERATION#${w.operationId}` }, ops: [{ op: "set", path: ["workflowMode"], value: "PLAN_CRITIQUE" }, { op: "set", path: ["designReview"], value: JSON.parse(JSON.stringify(binding)) as never }] });
    const own = await modelAccess(w, capability);
    expect(own.status).toBe(403);
    expect(own.text).toContain("CALLBACK_FORBIDDEN");
    expect(own.text).not.toContain("apiKey");
    const slot = await modelAccess(w, capability, "?slot=r1-critic");
    expect(slot.status).toBe(403);
    expect(slot.text).not.toContain("apiKey");
  });
});

/** A design at the owner's approval after a review that did not run: the workflow is built by the contract's own moves, and the design's text kept where the pages read it. */
async function seedReviewedDesign(w: World): Promise<WorkflowSnapshot> {
  const blobs = w.runtime.registry.require("object-storage");
  const keep = async (name: string, text: string, version: number, type: "requirements" | "design") => {
    const objectKey = `test/${w.taskId}/${name}`;
    const bytes = new TextEncoder().encode(text);
    await blobs.put(objectKey, bytes, { contentType: "text/markdown", metadata: { sha256: sha(text), name }, retention: "task-document" });
    return { id: randomUUID(), type, version, sha256: sha(text), producer: "agentx-worker-untrusted", objectKey, createdAt: NOW, format: "markdown" as const };
  };
  const task = (await w.store.get({ pk: `DEVTASK#${w.taskId}`, sk: "META" }))!;
  const start = WorkflowSnapshotSchema.parse(task["workflow"]);
  const understood = recordIntentAssessment(startWorkflowUnderstand(start, NOW), { expectedRevision: start.revision + 1, assessment: { kind: "ready", path: "FULL", restatement: "Retry once.", assumptions: [], design: { needed: true, reasons: ["data_model"], note: "x" } }, now: NOW });
  const withProgram = WorkflowSnapshotSchema.parse({ ...understood, program: ROVARA_CODE_PROGRAM, programStepId: "plan" });
  const enabled = enableDesignReview(withProgram, { expectedRevision: withProgram.revision, now: NOW, start: { decidedBy: "always", reasons: ["data_model"], tier: "light", capUsd: 10 } });
  const planning = startWorkflowPlanAfterUnderstand(enabled, NOW);
  const requirements = submitWorkflowArtifact(planning, { expectedRevision: planning.revision, artifact: await keep("requirements.md", REQUIREMENTS, 1, "requirements"), now: NOW });
  const approved = decideWorkflow(requirements, { requestId: randomUUID(), expectedRevision: requirements.revision, decision: "APPROVE", artifactDigest: requirements.artifacts.at(-1)!.sha256, reason: "ok" }, { actorId: requirements.ownerId, role: "TASK_OWNER" }, { now: NOW, allowedSkipStages: [] });
  const designing = startWorkflowPlanAfterUnderstand(approved, NOW);
  const submitted = submitWorkflowArtifact(designing, { expectedRevision: designing.revision, artifact: await keep("design.md", DESIGN, 1, "design"), now: NOW });
  const waiting = closeDesignReview(submitted, { expectedRevision: submitted.revision, outcome: "not_run", notRunReason: "cost_declined", now: NOW });
  expect(waiting).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", reviewPhase: "DESIGN" });
  await w.store.update({ key: { pk: `DEVTASK#${w.taskId}`, sk: "META" }, ops: [{ op: "set", path: ["workflow"], value: JSON.parse(JSON.stringify(waiting)) as never }] });
  return waiting;
}

/** A review made on the task flow's fakes, its workflow and documents put on the launched task (the owner is the launched install's). */
async function seedFromFlow(w: World, make: (source: Awaited<ReturnType<typeof flowWorld>>) => Promise<WorkflowSnapshot>, options: Parameters<typeof flowWorld>[0] = {}): Promise<WorkflowSnapshot> {
  const source = await flowWorld(options);
  const reviewed = await make(source);
  const blobs = w.runtime.registry.require("object-storage");
  for (const artifact of reviewed.artifacts) {
    const text = source.blobs.get(artifact.objectKey)!;
    await blobs.put(artifact.objectKey, new TextEncoder().encode(text), { contentType: "text/markdown", metadata: { sha256: artifact.sha256, name: "doc" }, retention: "task-document" });
  }
  const own = WorkflowSnapshotSchema.parse((await w.store.get({ pk: `DEVTASK#${w.taskId}`, sk: "META" }))!["workflow"]);
  const seeded = { ...reviewed, taskId: w.taskId, ownerId: own.ownerId };
  await w.store.update({ key: { pk: `DEVTASK#${w.taskId}`, sk: "META" }, ops: [{ op: "set", path: ["workflow"], value: JSON.parse(JSON.stringify(seeded)) as never }] });
  return seeded;
}

describe("the approval of a reviewed design, through the owner's page and the approval gate", () => {
  it("is graded by the review's own facts (a design that touches the data model is high even though its text names nothing alarming), and leaves its record in the decision's transaction", async () => {
    const w = await launch();
    const waiting = await seedReviewedDesign(w);
    const link = await w.browse(`/plan/${w.taskId}`);
    const page = await raw(w.runtime.pagesUrl, { path: link.pathname + link.search, headers: { host: link.host } });
    expect(page.status).toBe(200);
    // The review did not run, and the page says so in plain words in front of the form.
    expect(page.body).toContain("Design review did not run:");
    const form = formOf(page.body, "/decide");
    const post = await raw(w.runtime.pagesUrl, { method: "POST", path: form.action, body: formBody({ ...form.fields, decision: "approve" }), headers: { host: link.host, origin: w.runtime.pagesUrl, "content-type": "application/x-www-form-urlencoded" } });
    expect(post.headers["location"]).toContain("n=approved");
    const record = await w.store.get(approvalRecordKey(IMPLICIT_COMPANY_ID, form.fields["requestId"]!));
    expect(record).toMatchObject({ outcome: "approve", kind: "workflow-document", risk: "high" });
    // The approval of the design, with the tier, under the digest of the design that was approved.
    const digest = waiting.artifacts.filter((artifact) => artifact.type === "design").at(-1)!.sha256;
    expect(await w.store.get(designApprovalKey(w.taskId, digest))).toMatchObject({ entityType: "DESIGN_APPROVAL", designDigest: digest, tier: "high", openBlockers: 0 });
  });

  it("needs a one-line reason when a blocker is open, through the page and the gate: without it nothing is approved; with it the reason goes on the approval record", async () => {
    const w = await launch();
    // The review that left a blocker open is made on the task flow's fakes, and its workflow and documents are put on this task.
    const reviewed = await seedFromFlow(w, async (source) => waitingWithBlocker(source));
    const link = await w.browse(`/plan/${w.taskId}`);
    const shown = await raw(w.runtime.pagesUrl, { path: link.pathname + link.search, headers: { host: link.host } });
    // The page shows the review: how it went and the finding that is still open, with the blocker's own word and the reason it asks for.
    expect(shown.body).toContain("Design review");
    expect(shown.body).toContain("Nothing bounds the retry.");
    expect(shown.body).toContain("blocker");
    expect(shown.body).toContain("A blocker is still open");
    const decide = async (note: string) => {
      const page = await raw(w.runtime.pagesUrl, { path: link.pathname + link.search, headers: { host: link.host } });
      const form = formOf(page.body, "/decide");
      const post = await raw(w.runtime.pagesUrl, { method: "POST", path: form.action, body: formBody({ ...form.fields, decision: "approve", note }), headers: { host: link.host, origin: w.runtime.pagesUrl, "content-type": "application/x-www-form-urlencoded" } });
      return String(post.headers["location"]);
    };
    expect(await decide("")).toContain("n=invalid");
    expect((WorkflowSnapshotSchema.parse((await w.store.get({ pk: `DEVTASK#${w.taskId}`, sk: "META" }))!["workflow"])).stage).toBe("PLAN_REVIEW");
    expect(await decide("The plan sets the retry limit.")).toContain("n=approved");
    const digest = reviewed.artifacts.filter((artifact) => artifact.type === "design").at(-1)!.sha256;
    expect(await w.store.get(designApprovalKey(w.taskId, digest))).toMatchObject({ openBlockers: 1, proofReason: "The plan sets the retry limit." });
  });
});

describe("the cost hold on the owner's page", () => {
  it("shows what waits for the owner and takes the choice through the approval gate: Skip ends the review as not run and the design goes to the owner", async () => {
    const w = await launch();
    await seedFromFlow(w, async (source) => { await toRound(source); return (await taskOf(source)).workflow; }, { price: false, holdAnswerable: true });
    const link = await w.browse(`/plan/${w.taskId}`);
    const page = await raw(w.runtime.pagesUrl, { path: link.pathname + link.search, headers: { host: link.host } });
    expect(page.body).toContain("design-hold");
    expect(page.body).toContain("Run it anyway");
    expect(page.body).toContain("Skip design review");
    // The hold says how an accepted run is counted, and that the real bill can differ.
    expect(page.body).toContain("counts it at $15 and $75 per million tokens");
    expect(page.body).toContain("A dearer model can cost more than the limit.");
    const form = formOf(page.body, "/design-choice");
    const post = await raw(w.runtime.pagesUrl, { method: "POST", path: form.action, body: formBody({ ...form.fields, choice: "skip" }), headers: { host: link.host, origin: w.runtime.pagesUrl, "content-type": "application/x-www-form-urlencoded" } });
    expect(String(post.headers["location"])).not.toContain("n=invalid");
    const after = WorkflowSnapshotSchema.parse((await w.store.get({ pk: `DEVTASK#${w.taskId}`, sk: "META" }))!["workflow"]);
    expect(after).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", designReview: { status: "not_run", notRunReason: "skipped" } });
    // The choice went through the gate: it left a decision record.
    expect(await w.store.get(approvalRecordKey(IMPLICIT_COMPANY_ID, form.fields["requestId"]!))).toMatchObject({ kind: "design-review-choice", outcome: "approve" });
  });
});

describe("the forms of the cost hold and of a paused review", () => {
  const postForm = (w: World, link: URL, action: string, fields: Record<string, string>) =>
    raw(w.runtime.pagesUrl, { method: "POST", path: action, body: formBody(fields), headers: { host: link.host, origin: w.runtime.pagesUrl, "content-type": "application/x-www-form-urlencoded" } });
  const workflowOfTask = async (w: World) => WorkflowSnapshotSchema.parse((await w.store.get({ pk: `DEVTASK#${w.taskId}`, sk: "META" }))!["workflow"]);

  it("refuse a cost choice whose form was not signed for this request: nothing is decided", async () => {
    const w = await launch();
    await seedFromFlow(w, async (source) => { await toRound(source); return (await taskOf(source)).workflow; }, { price: false, holdAnswerable: true });
    const link = await w.browse(`/plan/${w.taskId}`);
    const page = await raw(w.runtime.pagesUrl, { path: link.pathname + link.search, headers: { host: link.host } });
    const form = formOf(page.body, "/design-choice");
    const forged = await postForm(w, link, form.action, { ...form.fields, ft: "f".repeat(64), choice: "skip" });
    expect(String(forged.headers["location"])).toContain("n=form");
    expect(await workflowOfTask(w)).toMatchObject({ stage: "PLAN_CRITIQUE", state: "WAITING", designReview: { status: "waiting_cost" } });
  });

  it("refuse picking a paused review up again when the form was not signed for this task and revision; the signed form picks it up", async () => {
    const w = await launch();
    await seedFromFlow(w, async (source) => {
      await toRound(source);
      source.h.clock.advance(8 * 86_400);
      await sweepDesignWaits({ flow: source.h.deps, reader: source.runtime.reader, env: source.runtime.env, releaseKeys: async () => undefined });
      return (await taskOf(source)).workflow;
    }, { price: false, holdAnswerable: true });
    const link = await w.browse(`/plan/${w.taskId}`);
    const page = await raw(w.runtime.pagesUrl, { path: link.pathname + link.search, headers: { host: link.host } });
    expect(page.body).toContain("design-parked");
    const form = formOf(page.body, "/design-resume");
    const forged = await postForm(w, link, form.action, { ...form.fields, ft: "f".repeat(64) });
    expect(String(forged.headers["location"])).toContain("n=form");
    expect(designWaitOf(await workflowOfTask(w))?.parkedAt).toBeDefined();
    const signed = await postForm(w, link, form.action, form.fields);
    expect(String(signed.headers["location"])).toContain("n=resumed");
    expect(designWaitOf(await workflowOfTask(w))?.parkedAt).toBeUndefined();
  });
});

describe("reading a review and opening its page from the tools", () => {
  const printedBy = (w: World) => {
    const printed: string[] = [];
    const run = async (...args: string[]) => {
      const program = new Command().exitOverride().option("--json");
      const context = { home: w.root, fetch, stdout: { write: (text: string) => { printed.push(text); return true; } } };
      registerDesignReviewCommand(program, context);
      await program.parseAsync(["node", "rovara", ...args]);
    };
    return { printed, run };
  };

  it("the route reads the review (the hold's choices by label, with the note) and refuses to make any of the owner's acts: a choice, the answers and resume are the page's", async () => {
    const w = await launch();
    await seedFromFlow(w, async (source) => { await toRound(source); return (await taskOf(source)).workflow; }, { price: false, holdAnswerable: true });
    const read = await w.api(`/v1/dev/tasks/${w.taskId}/design-review`, {});
    expect(read.status).toBe(200);
    expect(read.body["designReview"]).toMatchObject({ taskId: w.taskId, parked: false, hold: { choices: ["Run it anyway", "Skip design review"], note: expect.stringContaining("counts it at $15 and $75") as string } });
    // The offer ids, proofs and forms are the page's: the read carries none.
    expect(JSON.stringify(read.body)).not.toMatch(/requestId|proof|formToken|artifactDigest/u);
    for (const act of ["choice", "answers", "resume"]) {
      const refused = await w.api(`/v1/dev/tasks/${w.taskId}/design-review/${act}`, { method: "POST", body: { choice: "skip", revision: 1 } });
      expect(refused.status, act).toBe(403);
      expect(JSON.stringify(refused.body)).toContain("your own acts on the task's page");
    }
    // Nothing was decided.
    expect(WorkflowSnapshotSchema.parse((await w.store.get({ pk: `DEVTASK#${w.taskId}`, sk: "META" }))!["workflow"])).toMatchObject({ stage: "PLAN_CRITIQUE", state: "WAITING", designReview: { status: "waiting_cost" } });
    // A task without a review has nothing to read.
    const other = await w.api("/v1/dev/tasks/00000000-0000-4000-8000-000000000000/design-review", {});
    expect(other.status).toBe(404);
  });

  it("`rovara design-review status <task>` says how it stands and where to act, and `open <task>` opens the task's page; neither decides", async () => {
    const w = await launch();
    await seedFromFlow(w, async (source) => { await toRound(source); return (await taskOf(source)).workflow; }, { price: false, holdAnswerable: true });
    const { printed, run } = printedBy(w);
    await run("design-review", "status", w.taskId, "--state-dir", w.stateDirectory);
    const text = printed.join("");
    expect(text).toContain("Waiting for your choice: The price of the model is not known. Choices: Run it anyway; Skip design review.");
    expect(text).toContain("counts it at $15 and $75");
    expect(text).toContain(`rovara design-review open ${w.taskId}`);
    printed.length = 0;
    await run("--json", "design-review", "status", w.taskId, "--state-dir", w.stateDirectory);
    expect(JSON.parse(printed.join(""))).toMatchObject({ ok: true, data: { hold: { choices: ["Run it anyway", "Skip design review"] } } });
    await expect(run("design-review", "status", "not-an-id", "--state-dir", w.stateDirectory)).rejects.toThrow(/UUID/u);
    printed.length = 0;
    await run("design-review", "open", w.taskId, "--state-dir", w.stateDirectory);
    expect(printed.join("")).toContain("Opened the task's page in your browser");
    expect(printed.join("")).not.toMatch(/\/s\//u);
    expect(w.opened.at(-1)).toMatch(/\/s\/once\//u);
    // Still undecided: the commands read and open, and nothing else.
    expect(WorkflowSnapshotSchema.parse((await w.store.get({ pk: `DEVTASK#${w.taskId}`, sk: "META" }))!["workflow"])).toMatchObject({ designReview: { status: "waiting_cost" } });
  });
});
