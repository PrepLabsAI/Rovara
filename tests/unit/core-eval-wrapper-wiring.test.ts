// L4-EVW3 (DEC 254zzz20 D2, lead 4 hosted wiring): the eval wrapper proposal is LIVE on the deployed root. A hosted setup run's eval report (rows output) opens exactly one wrapper pull request on the company's own
// repository, through the company's own code host connection, and the audit record names the setup run (`setup-run:<taskId>`), not a person. Another company's repository is never targeted; a project with no code host
// connection makes no proposal. Real broker root, registry and callbacks over the fake host; no AWS.
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { EVAL_OUTPUT_UNREADABLE_MESSAGE, change, evalOutputNeedsWrapper, orgProjectCatalogKey, projectRevisionKey, type AuditEvent, type OrgId, type StoredDocument } from "@agentx/contracts";
import { createBrokerCoreRoot } from "../../packages/broker/src/aws/core-engine-root.js";
import { createBrokerCoreServices } from "../../packages/broker/src/aws/core-job-services.js";
import { CallbackCapabilities, type CallbackAction } from "../../packages/broker/src/callbacks.js";
import { listEvalWrappers } from "../../packages/broker/src/core/setup-agent/eval-wrapper.js";
import { readEvalCard } from "../../packages/broker/src/core/setup-agent/eval-card.js";
import { setupAgentKey } from "../../packages/broker/src/core/setup-agent/keys.js";
import { operationKey, taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { deployedSessionMembers } from "../../packages/broker/src/core-host/deployed-decisions.js";
import { createFakeWorld } from "../support/core-host-fakes.js";
import { reportOf } from "../support/eval-card-world.js";

const adapters = vi.hoisted(() => ({ modules: [] as unknown[] }));
vi.mock("../../packages/broker/src/core-host/code-modules.js", async (original) => ({ ...await original<object>(), codeAdapterModules: () => adapters.modules }));

const A: OrgId = "org_aaaaaaaaaaaaaaaaaaaa", B: OrgId = "org_bbbbbbbbbbbbbbbbbbbb";
const SIGNING = "k".repeat(32);
const PROJECT = "payments";
const PERSON_A = "a".repeat(64), PERSON_B = "b".repeat(64);
const DEMO = "https://github.com/example/demo.git";
const ROWS = { kind: "rows", format: "jsonl", language: "python", idField: "case_id", pass: { field: "passed", equals: true } } as const;
const plain = (value: unknown): StoredDocument => JSON.parse(JSON.stringify(value)) as StoredDocument;
const repo = (url: string, host?: { kind: string }) => ({ name: "demo", url, path: "repo/demo", defaultBranch: "main", credentialRef: "app", ...(host === undefined ? {} : { host }) });
const projectOf = (repository: ReturnType<typeof repo>) => ({ name: PROJECT, revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.", repositories: [repository] });

async function world(repositories: { a: ReturnType<typeof repo>; b: ReturnType<typeof repo> }) {
  const w = createFakeWorld();
  w.clock.now = Date.now();
  adapters.modules = w.modules.filter((module) => ["storage", "queue", "worker-machines", "object-storage", "code-host", "check-runner", "secrets", "model-keys"].includes(module.point));
  const client = { async send(command: unknown) {
    if (!(command instanceof GetCommand)) throw new Error("only fake point reads");
    const key = command.input.Key as { pk: string; sk: string };
    if (key.pk.startsWith("COMPANY_MEMBER#")) {
      const personId = key.pk.slice("COMPANY_MEMBER#".length);
      const companyId = personId === PERSON_A ? A : personId === PERSON_B ? B : undefined;
      return { Item: companyId === undefined ? undefined : { ...key, entityType: "COMPANY_MEMBERSHIP", personId, companyId, role: "owner", joinedAt: "2026-11-01T00:00:00.000Z" } };
    }
    if (key.pk.startsWith("MEMBER#")) return { Item: { ...key, projectName: PROJECT, role: "developer" } };
    return { Item: await w.store.get(key) };
  } };
  const root = createBrokerCoreRoot({
    env: { ROVARA_CORE_ENGINE: `on:${A}:${B}`, ROVARA_CORE_ALLOWED_COMPANIES: `${A}:${B}` },
    documentClient: client, stateTableName: "state", signInTableName: "signin", callbackSigningKey: SIGNING, repositoryGrantKey: Buffer.alloc(32, 1),
    repositoryCredential: async () => ({ token: "fake" }), codeModules: () => ({}) as never,
    origin: () => "https://api.example", now: () => new Date(w.clock.now), log: () => undefined,
    ciReporting: { honest: true, ciMode: async () => "sandbox_only" as const },
    services: (companyId, flow, registry, wiring) => createBrokerCoreServices({ companyId, flow, registry, ciMode: wiring.ciMode!, now: () => new Date(w.clock.now) }),
  });
  // The deployed root's own audit sink: its records are collected here (what the broker writes before a host write).
  const audit: AuditEvent[] = [];
  vi.spyOn((await root.app.registry()).require("audit-sink"), "record").mockImplementation(async (event) => { audit.push(event); });
  for (const [companyId, repository] of [[A, repositories.a], [B, repositories.b]] as const) {
    await w.store.put({ item: plain({ ...projectRevisionKey(companyId, PROJECT, 1), definition: projectOf(repository) }) });
    await w.store.put({ item: { ...orgProjectCatalogKey(companyId, PROJECT), latestRevision: 1 } });
  }
  /** A running setup run of `companyId`'s project, with the capability its worker holds for the setup callback, and the call that reports an eval. */
  const setupRun = async (companyId: OrgId) => {
    // A real task started through the company's own route (workspace, pointer and engine stamp as the flow writes them), made a setup run of the project.
    const started = await root.coreTasks!.route({ method: "POST", path: "/v1/dev/tasks", headers: {}, body: JSON.stringify({ requestId: randomUUID(), project: PROJECT, instructions: "Set up the project" }) }, { developerId: companyId === A ? PERSON_A : PERSON_B, sessionId: "session", name: "Owner" });
    expect(started?.statusCode, started?.body).toBe(200);
    const taskId = (JSON.parse(started!.body) as { task: { taskId: string } }).task.taskId;
    const workspaceId = z.string().parse((await w.store.get(taskKey(taskId)))!["workspaceId"]), operationId = randomUUID();
    await w.store.update({ key: taskKey(taskId), ops: [change.set("purpose", "setup_agent"), change.set("preparedBase", [{ repositoryId: "demo", baseCommitSha: "a".repeat(40) }])] });
    await w.store.put({ item: { ...setupAgentKey(companyId, PROJECT), entityType: "SETUP_AGENT", taskId } });
    await w.store.put({ item: { ...operationKey(companyId, workspaceId, operationId), entityType: "OPERATION", id: operationId, workspaceId, kind: "task", workflowMode: "SETUP_AGENT", status: "RUNNING", fence: 1, companyId } });
    const capability = new CallbackCapabilities(Buffer.from(SIGNING)).issue({ workspaceId, operationId, fence: 1, actions: ["setup-agent"] as CallbackAction[], expiresInSeconds: 600 });
    const report = async (body: unknown) => root.callback({ method: "POST", path: `/v1/internal/workspaces/${workspaceId}/operations/${operationId}/setup-agent`, headers: { "x-agentx-callback-capability": capability }, body: JSON.stringify(body) });
    return { taskId, workspaceId, report: (suite: Record<string, unknown>) => report({ kind: "eval_discovery", report: reportOf(2, { repository: "demo", ...suite }) }) };
  };
  const wrappers = (companyId: OrgId) => listEvalWrappers({ store: w.store, companyId }, PROJECT);
  const card = async (companyId: OrgId) => readEvalCard({ store: w.store, companyId, monthlyCap: async () => 50_000_000, members: deployedSessionMembers(companyId, { membershipOf: async () => ({ companyId, role: "owner" as const }), projectGrantRole: async () => undefined }) }, PROJECT,
    { companyId, personId: "p", provider: "test", displayName: "P", roles: [] });
  return { w, root, audit, setupRun, wrappers, card };
}

it("a hosted setup run whose eval writes rows opens exactly one wrapper pull request on the company's own repository; the audit actor is the setup run", async () => {
  const h = await world({ a: repo(DEMO), b: repo("https://github.com/other/secret.git") });
  const run = await h.setupRun(A);
  const reply = await run.report({ output: ROWS });
  expect(reply?.statusCode, reply?.body).toBe(200);
  expect(JSON.parse(reply!.body)).toEqual({ recorded: "new" });
  const requests = h.w.host.model.changeRequests;
  expect(requests).toHaveLength(1);
  expect(requests[0]!.sourceBranch).toMatch(/^rovara\/eval-wrapper-[0-9a-f]{12}$/u);
  // One audit record before the write, from the setup run (no person), naming this company's project.
  const audits = h.audit.filter((event) => event.action === "eval_wrapper.proposed");
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({ companyId: A, actor: { type: "system", id: `setup-run:${run.taskId}` }, subject: { type: "project", id: PROJECT }, details: { project: PROJECT, repository: "demo", taskId: run.taskId } });
  expect(await h.wrappers(A)).toMatchObject([{ state: "open", repository: "demo", number: "1" }]);
  expect((await h.card(A)).wrappers).toMatchObject([{ state: "open", line: "Rovara proposed a small file so it can read your eval results: review PR #1" }]);
  // The same report again (a second callback, or a later run of the same eval) opens nothing more.
  expect((await run.report({ output: ROWS }))?.statusCode).toBe(200);
  expect(h.w.host.model.changeRequests).toHaveLength(1);
  expect(h.audit.filter((event) => event.action === "eval_wrapper.proposed")).toHaveLength(1);
});

it("another company's repository is never targeted: B's project pins a repository its host does not know, A's pull request is A's alone, and B has no rows", async () => {
  const h = await world({ a: repo(DEMO), b: repo("https://github.com/other/secret.git") });
  const b = await h.setupRun(B);
  expect((await b.report({ output: ROWS }))?.statusCode).toBe(200);
  expect(h.w.host.model.changeRequests).toHaveLength(0);
  expect(h.audit.filter((event) => event.action === "eval_wrapper.proposed")).toEqual([]);
  expect(await h.wrappers(B)).toEqual([]);
  const a = await h.setupRun(A);
  expect((await a.report({ output: ROWS }))?.statusCode).toBe(200);
  expect(h.w.host.model.changeRequests).toHaveLength(1);
  expect(h.w.host.model.changeRequests[0]!.sourceBranch).toMatch(/^rovara\/eval-wrapper-/u);
  expect(await h.wrappers(A)).toHaveLength(1);
  expect(await h.wrappers(B)).toEqual([]);
  expect(h.audit.filter((event) => event.action === "eval_wrapper.proposed").map((event) => event.companyId)).toEqual([A]);
  // A suite that names a repository the project does not have is not proposed anywhere (another company's repository name is just a name).
  const again = await h.setupRun(A);
  const refused = await again.report({ output: ROWS, repository: "secret" });
  expect(refused?.statusCode).not.toBe(500);
  expect(h.w.host.model.changeRequests).toHaveLength(1);
});

it("a project with no code host connection makes no proposal, keeps the report, and the card says the eval cannot be read yet", async () => {
  const h = await world({ a: repo(DEMO), b: repo(DEMO) });
  const run = await h.setupRun(A);
  // The company's connection to the repository's code host goes away after the run started (the project now pins a host this install has no adapter for).
  await h.w.store.put({ item: plain({ ...projectRevisionKey(A, PROJECT, 2), definition: { ...projectOf(repo(DEMO, { kind: "gitlab" })), revision: 2 } }) });
  await h.w.store.put({ item: { ...orgProjectCatalogKey(A, PROJECT), latestRevision: 2 } });
  const reply = await run.report({ output: ROWS });
  expect(reply?.statusCode, reply?.body).toBe(200);
  expect(JSON.parse(reply!.body)).toEqual({ recorded: "new" });
  expect(h.w.host.model.changeRequests).toHaveLength(0);
  expect(h.audit.filter((event) => event.action === "eval_wrapper.proposed")).toEqual([]);
  expect(await h.wrappers(A)).toEqual([]);
  const card = await h.card(A);
  expect(card.wrappers).toEqual([]);
  expect(card.suites[0]).toMatchObject({ readable: false, needsFile: EVAL_OUTPUT_UNREADABLE_MESSAGE });
  expect(evalOutputNeedsWrapper(ROWS)).toBe(true);
});

it("an eval whose output Rovara reads as it is makes no proposal on the hosted root", async () => {
  const h = await world({ a: repo(DEMO), b: repo("https://github.com/other/secret.git") });
  const run = await h.setupRun(A);
  expect((await run.report({ output: { kind: "junit" } }))?.statusCode).toBe(200);
  expect(h.w.host.model.changeRequests).toHaveLength(0);
  expect(h.audit.filter((event) => event.action === "eval_wrapper.proposed")).toEqual([]);
});

it("the card's read and \"Try again\" reach the company's own repository on the hosted root: a merged pull request is seen, and a retry asks the same code host and opens nothing more", async () => {
  const h = await world({ a: repo(DEMO), b: repo("https://github.com/other/secret.git") });
  const run = await h.setupRun(A);
  expect((await run.report({ output: ROWS }))?.statusCode).toBe(200);
  const request = h.w.host.model.changeRequests[0]!;
  h.w.host.model.merge(request.id, { revision: h.w.host.model.headRevisionOf(request), method: "squash" });
  const caller = { developerId: PERSON_A, sessionId: "session", name: "Owner" };
  const card = await h.root.coreApp!.route({ method: "GET", path: `/v1/app/projects/${PROJECT}/setup-agent/eval`, headers: {} }, caller);
  expect(card?.statusCode, card?.body).toBe(200);
  expect((JSON.parse(card!.body) as { wrappers: unknown }).wrappers).toMatchObject([{ state: "merged", rediscover: true }]);
  const retry = await h.root.coreApp!.route({ method: "POST", path: `/v1/app/projects/${PROJECT}/setup-agent/eval-wrapper`, headers: {}, body: JSON.stringify({ requestId: randomUUID() }) }, caller);
  expect(retry?.statusCode, retry?.body).toBe(200);
  expect((JSON.parse(retry!.body) as { proposals: unknown }).proposals).toMatchObject([{ state: "merged" }]);
  expect(h.w.host.model.changeRequests).toHaveLength(1);
});
