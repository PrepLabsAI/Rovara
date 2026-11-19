import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { issueChannelLinkCode, redeemChannelLinkCode } from "../../packages/broker/src/core/channel/links.js";
import type { CoreTaskEntry } from "../../packages/broker/src/aws/engine-boundary.js";
import { assertTaskProjectCompany } from "../../packages/broker/src/aws/company-check.js";
import { createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { SLACK_CHANNEL, SLACK_TEAM, finishOperation, loadSlackBroker } from "../support/slack-broker.js";

const A = "org_demoaaaaaaaaaaaaaaaa";
const B = "org_bbbbbbbbbbbbbbbbbbbb";
const USER = "U0SHARED00";
const PERSON = "a".repeat(64);
const PERSON_B = "b".repeat(64);

beforeAll(async () => { await loadSlackBroker(); }, 120_000);

const companyBinding = (company: string) => ({
  pk: `ORG#${company}#SLACK_BINDING#${SLACK_TEAM}`, sk: `CHANNEL#${SLACK_CHANNEL}`, channelId: SLACK_CHANNEL,
  projectName: "demo-tasklog", teamId: SLACK_TEAM, updatedBy: "e".repeat(64), updatedAt: "2026-10-27T15:07:04.991Z", entityType: "SLACK_BINDING",
});

const companyProject = (company: string, name: string) => ({
  pk: `ORG#${company}#PROJECT#${name}`, sk: "REV#000000000001", entityType: "PROJECT", companyId: company,
  definition: { name, revision: 1, orchestratorInstructions: "x", setup: [], readiness: [],
    repositories: [{ name: "r", url: "https://github.com/acme/r", defaultBranch: "main", path: "repo/r", credentialRef: "github-agentx-sdlc" }] },
});

async function world() {
  const h = await createDeveloperTaskBroker({ channelMembers: async (r) => ({ ok: true, memberOf: r.channelIds }) });
  h.db.set(companyProject(A, "demo-tasklog"));
  h.db.set(companyProject(B, "b-project"));
  const store = new MemoryDocumentStore();
  const members = new Map([[PERSON, A], [PERSON_B, B]]);
  const companyOfTeam = vi.fn(async (team: string): Promise<string> => { if (team === SLACK_TEAM) return A; throw Error("private"); });
  const workspaces = { store, getProject: async () => ({ companyId: A }), linkUrl: (code: string) => `https://example.test/review/link/${code}`,
    requireCompany: companyOfTeam, tokenForEvent: vi.fn(async () => ({ companyId: A, token: "x" })) };
  const code = await issueChannelLinkCode({ store, orgId: A, now: Date.now }, { channel: "slack", tenant: SLACK_TEAM, userId: USER });
  await redeemChannelLinkCode({ store, orgId: A, now: Date.now }, PERSON, code.code);
  const entry: CoreTaskEntry = { route: async () => undefined, recordThread: vi.fn(async () => true) };
  const module = await loadSlackBroker();
  const handler = module.createAwsBrokerHandler({ ...h.brokerInput, store, workspaces, companies: { companyOf: async (id: string) => members.get(id) },
    slackWorkspaceLegacyTeamId: SLACK_TEAM, developer: { ...h.brokerInput.developer!, slackTeamId: SLACK_TEAM, coreTasks: entry } } as never);
  const start = () => handler({ source: "agentx.slack-ingress", action: "start-workflow", thread: { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: "1700000000.000001" },
    userId: USER, instructions: "Fix the flaky test", workflowPath: "QUICK", requestId: randomUUID() });
  return { ...h, handler, start };
}

async function startedTask() {
  const w = await world();
  const registered = w.db.get("PROJECT#payments", "REV#000000000001")!;
  const definition = registered.definition as Record<string, unknown>;
  w.db.set({ ...registered, pk: "PROJECT#demo-tasklog", sk: "REV#000000000001", companyId: A,
    definition: { ...definition, name: "demo-tasklog", revision: 1 } });
  w.db.set(companyBinding(A));
  w.db.set({ pk: `ORG#${A}#MEMBER#${PERSON}`, sk: "PROJECT#demo-tasklog", entityType: "MEMBERSHIP", ownerKey: PERSON, projectName: "demo-tasklog", role: "developer" });
  const started = await w.start();
  expect(started.statusCode, started.body).toBe(200);
  const taskId = String((JSON.parse(started.body) as { taskId: string }).taskId);
  const task = w.db.get(`DEVTASK#${taskId}`, "META")!;
  expect(task).toMatchObject({ companyId: A });
  const workspaceId = String(task.workspaceId);
  const prepare = w.db.find((item) => item.workspaceId === workspaceId && item.kind === "prepare")[0]!;
  await finishOperation(w.handler, w.db, workspaceId, String(prepare.id), "SUCCEEDED", { preparedBase: [{ repositoryId: "r", baseCommitSha: "e".repeat(40) }] });
  const plan = w.db.find((item) => item.workspaceId === workspaceId && item.kind === "task")[0]!;
  await finishOperation(w.handler, w.db, workspaceId, String(plan.id), "FAILED");
  return { w, taskId, workspaceId };
}

describe("Slack workflow retry project rows are checked against the task company", () => {
  it("the shared helper accepts only a valid task company and its own legacy row", () => {
    const ownRow = { pk: "PROJECT#demo-tasklog", companyId: A };
    expect(() => assertTaskProjectCompany({ companyId: A }, ownRow)).not.toThrow();
    expect(() => assertTaskProjectCompany({}, ownRow)).toThrow("Slack channel is not bound to a project");
    expect(() => assertTaskProjectCompany({ companyId: "bad-company-id" }, ownRow)).toThrow("Slack channel is not bound to a project");
  });

  it.each(["built-in", "company B", "own company", "missing companyId", "malformed companyId"])("retry handles a %s namesake safely", async (caseName) => {
    const { w, taskId, workspaceId } = await startedTask();
    const task = w.db.get(`DEVTASK#${taskId}`, "META")!;
    if (caseName === "missing companyId" || caseName === "malformed companyId") {
      const saved = { ...task };
      if (caseName === "missing companyId") delete saved.companyId;
      else saved.companyId = "bad-company-id";
      w.db.set(saved);
    }
    const base = w.db.get("PROJECT#demo-tasklog", "REV#000000000001")!;
    const { companyId: _companyId, ...legacy } = base;
    void _companyId;
    const foreign = { ...legacy, ...(caseName === "company B" ? { companyId: B } : {}), sk: "REV#000000000002",
      definition: { ...(base.definition as Record<string, unknown>), revision: 2 } };
    const own = { ...base, sk: "REV#000000000002", companyId: A,
      definition: { ...(base.definition as Record<string, unknown>), revision: 2 } };
    w.db.set(caseName === "own company" || caseName === "missing companyId" || caseName === "malformed companyId" ? own : foreign);
    const before = structuredClone(w.db.find((item) => item.kind === "task" || item.entityType === "OUTBOX"));
    const result = await w.handler({ source: "agentx.slack-ingress", action: "workflow-retry", step: "plan", selectedOptionalCheckIds: [], taskId, userId: USER,
      thread: { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: "1700000000.000001" }, requestId: randomUUID(), expectedRevision: (task.workflow as { revision: number }).revision });
    if (caseName === "own company") {
      expect(result.statusCode, result.body).toBe(200);
      expect(w.db.find((item) => item.workspaceId === workspaceId && item.kind === "task" && item.settingsRevision === 2 && item.workflowMode === "PLAN")).toHaveLength(1);
    } else {
      expect(result.statusCode, result.body).toBe(200);
      expect(JSON.parse(result.body)).toMatchObject({ refused: true });
      expect(result.body).not.toMatch(/builtin|secret|private/);
      expect(w.db.find((item) => item.kind === "task" || item.entityType === "OUTBOX")).toEqual(before);
    }
  });
});
