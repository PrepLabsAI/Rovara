// Guided onboarding PR 8: `GET /v1/dev/client/projects/{project}/setup-status` and `PUT .../setup-status/skips`.
// Each row's state comes from fixture records; two companies never read or change each other's project; a member reads but cannot set skips; the existing route table is unchanged.
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  AgentXError, IMPLICIT_COMPANY_ID, ProjectSetupChecklistSchema, orgProjectCatalogKey, projectMetaKey, projectRevisionKey, ProjectSetupEvalNoneResponseSchema, ProjectSetupSkipResponseSchema, SETUP_STATUS_ROWS, evalCommandFingerprintOf, workspaceProjectIndexValue,
  type SetupEvalDiscoveryReport,
} from "@agentx/contracts";
import { COMPANY_A, COMPANY_B } from "../../packages/testing/src/isolation/two-company.js";
import { companyMembershipFromDynamo } from "../../packages/broker/src/aws/company-check.js";
import { DEV_ROUTES } from "../../packages/broker/src/aws/dev-route-scopes.js";
import { routeDeveloperRequest, type DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import {
  EVAL_ALREADY_CONFIRMED, EVAL_NONE_BODY, EVAL_NONE_NEEDS_SETUP, NOT_AN_EVAL_ADMIN, NOT_A_SETUP_ADMIN, SETUP_SKIPS_BODY, SETUP_SKIPS_STALE, SETUP_STATUS_UNREADABLE, readProjectSetupStatus, readSkips, setupEvalNoneKey, setupSkipsKey,
} from "../../packages/broker/src/aws/project-setup-status.js";
import { projectSettingsKey } from "../../packages/broker/src/aws/project-settings.js";
import { setupApplyKey } from "../../packages/broker/src/core/setup-agent/apply.js";
import { SETUP_AGENT_FAILURES } from "../../packages/broker/src/core/setup-agent/agent.js";
import { evalDiscoveryDigest, evalDiscoveryKey } from "../../packages/broker/src/core/setup-agent/eval-discovery.js";
import { journalKey, setupAgentKey } from "../../packages/broker/src/core/setup-agent/keys.js";
import { modelSelectionPolicyKey } from "../../packages/broker/src/core/model-selection/policy-store.js";
import { OPERATION_SK_PREFIX, workspaceKey, workspacePartition } from "../../packages/broker/src/core/task-flow/keys.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { CLIENT_MEMBERS_NOT_ALLOWED } from "../../packages/broker/src/aws/developer-routes.js";
import { LinearConnections, linearConnectionKey, linearTeamKey } from "../../packages/broker/src/aws/linear-connections.js";
import type { LinearConnectWiring } from "../../packages/broker/src/aws/linear-connect-routes.js";

const NOW = Date.parse("2026-11-17T12:00:00.000Z");
const TIME = "2026-11-01T09:00:00.000Z";
const ADA = "a".repeat(64);
const BEN = "b".repeat(64);
const CAT = "c".repeat(64);
const CANARY = "leak-canary-pr8";
const A = COMPANY_A.orgId;
const B = COMPANY_B.orgId;
const PATH = (project = "alpha") => `/v1/dev/client/projects/${project}/setup-status`;
const SKIPS = (project = "alpha") => `${PATH(project)}/skips`;
const EVAL_NONE = (project = "alpha") => `${PATH(project)}/eval-none`;
const TEAM = "T0123ABCD";
const CHANNEL = "C0123ABCD";

type Role = "owner" | "admin" | "member";
interface HarnessOptions { companies?: boolean; fullAccess?: boolean; linear?: boolean }

function harness(options: HarnessOptions = {}) {
  const db = new FakeDynamoDb({ seed: 5 });
  const claims: Record<string, unknown> = { azp: "web-app", env: "test", sub: ADA, sid: "s-ada", amr: "slack" };
  db.set({ pk: "SIGNIN_CLIENTS", sk: "CLIENT#web-app", entityType: "SIGN_IN_CLIENT", clientId: "web-app", name: "Web App", audience: "web-app", redirectUris: ["https://cloud.example.com/callback"], loopback: false, installLevel: true, secretHash: "f".repeat(64), ...(options.fullAccess === false ? {} : { fullAccess: true }), createdAt: TIME, updatedAt: TIME, updatedBy: "admin" });
  for (const [id, name, sid] of [[ADA, "Ada", "s-ada"], [BEN, "Ben", "s-ben"], [CAT, "Cat", "s-cat"]] as const) {
    db.set({ pk: `DEVELOPER#${id}`, sk: "META", developerId: id, provider: "slack", displayName: name, revoked: false });
    db.set({ pk: `SESSION#${sid}`, sk: "META", sessionId: sid, developerId: id, amr: "slack", clientId: "web-app", startedAt: new Date(NOW - 60_000).toISOString(), endsAt: NOW / 1000 + 3600 });
  }
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const deps: DeveloperRouteDependencies = {
    documentClient: db, tableName: "State", now: () => NOW,
    ...(options.companies === false ? {} : { companies: companyMembershipFromDynamo(db, "State") }),
    developer: {
      issuer: "https://signin.example.test", env: "test", methods: { slack: true, oidc: true }, signInTableName: "SignIn", slackTeamId: TEAM,
      verifyAccessToken: async () => claims, channelMembers: async (request) => ({ ok: true, memberOf: request.channelIds }),
      ...(options.linear === true ? { linearConnect: linearWiring(db) } : {}),
    },
  };
  const jwt = () => { const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url"); return `Bearer ${part({ alg: "none" })}.${part(claims)}.sig`; };
  const call = async (method: string, path: string, body?: unknown) => {
    const request = { method, path, headers: { authorization: jwt() }, requestId: "r", ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
    try { return { status: 200, body: await routeDeveloperRequest(deps, request, new URL(path, "https://broker.example.test")) as Record<string, unknown> }; } catch (error) {
      if (!(error instanceof AgentXError)) throw error;
      return { status: error.statusCode, body: { error: { code: error.code, message: error.message.slice(error.code.length + 2) } } as Record<string, unknown> };
    }
  };
  const as = (id: string, sid: string) => { claims.sub = id; claims.sid = sid; };
  const join = (id: string, companyId: string, role: Role) => db.set({ pk: `COMPANY_MEMBER#${id}`, sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", personId: id, companyId, role, joinedAt: TIME });
  const project = (name: string, companyId?: string, repositories: unknown[] = [{ name: "api", url: "https://github.com/acme/api", defaultBranch: "main" }]) =>
    db.set({ pk: `PROJECT#${name}`, sk: "REV#000000000001", entityType: "PROJECT", ...(companyId === undefined ? {} : { companyId }), definition: { name, revision: 1, repositories } });
  const grant = (id: string, name: string, role: "administrator" | "developer") => db.set({ pk: `MEMBER#${id}`, sk: `PROJECT#${name}`, entityType: "MEMBERSHIP", ownerKey: id, projectName: name, role, grantedAt: TIME });
  const ok = async (path = PATH()) => { const answer = await call("GET", path); expect(answer.status).toBe(200); return ProjectSetupChecklistSchema.parse(answer.body); };
  return { db, claims, deps, call, as, join, project, grant, ok };
}
/** The deployed Linear wiring's connections (linear-wiring.ts builds the same class) over the same table; nothing here talks to Linear. */
function linearWiring(db: FakeDynamoDb): LinearConnectWiring {
  const never = async () => { throw new Error("no Linear call in these tests"); };
  const connections = new LinearConnections({ documentClient: db, tableName: "State", sealer: { seal: never, open: never }, fetch: never, now: () => NOW, app: async () => undefined, log: () => undefined });
  return { connections, app: async () => undefined, fetch: never, log: () => undefined };
}
const pickTeam = (h: { db: FakeDynamoDb }, company: string, project: string, over: Record<string, unknown> = {}) => h.db.set({
  ...linearTeamKey(company, project), entityType: "LINEAR_PROJECT_TEAM", companyId: company, project, teamId: "team-1234", teamKey: "ENG", teamName: "Engineering", setBy: "a".repeat(64), setAt: TIME, ...over,
});
const linearConnected = (h: { db: FakeDynamoDb }, company: string, status: "connected" | "needs_reconnect" | "disconnected" = "connected") => h.db.set({
  ...linearConnectionKey(company), entityType: "LINEAR_CONNECTION", companyId: company, organizationId: "ws-1", workspaceName: "Acme", urlKey: "acme", status, statusAt: TIME,
  connectedBy: "a".repeat(64), connectedAt: TIME, version: 1,
});
type Harness = ReturnType<typeof harness>;
const error = (code: string, message: string) => ({ error: { code, message } });
const NOT_FOUND = { status: 404, body: error("NOT_FOUND", "project not found") };

// ---- fixtures: what the setup run, the eval report, the settings and the tasks look like in the table

const PROPOSAL = (commands: { setup?: string[]; tests?: string[] } = { setup: ["npm ci"], tests: ["npm test"] }) => {
  const item = (id: string, list: string[]) => ({ id, value: { repo: "api", commands: list }, from: [{ kind: "inferred", note: "the package scripts" }], confidence: "high", risk: "safe" });
  return {
    version: 2, basedOnRevision: 1, repositories: [], setup: commands.setup === undefined ? [] : [item("setup-api", commands.setup)], tests: commands.tests === undefined ? [] : [item("tests-api", commands.tests)], checks: [], testEnvironment: [],
    knowledge: [], sources: [], intake: [], allowedDomains: [], secretsNeeded: [], flaggedCommands: [], foundNotUsed: [], notes: "",
  };
};
const SUMMARY = (over: Record<string, unknown> = {}) => ({ stop: "proposed", commandsRun: 4, spendCents: 37, elapsedMs: 91_000, hostAsks: 0, partial: false, ...over });

type RunResult = Record<string, unknown> | undefined;
function setupRun(h: Harness, company: string, project: string, result: RunResult, taskId = "11111111-1111-4111-8111-111111111111") {
  h.db.set({ ...setupAgentKey(company, project), entityType: "SETUP_AGENT", orgId: company, project, taskId, requestId: "22222222-2222-4222-8222-222222222222", requestedBy: ADA, basedOnRevision: 1, startedAt: new Date(NOW - 120_000).toISOString(), limits: {} });
  h.db.set({ pk: `DEVTASK#${taskId}`, sk: "META", entityType: "DEVELOPER_TASK", companyId: company, orgId: company, taskId, project, purpose: "setup_agent", workspaceId: "33333333-3333-4333-8333-333333333333", startingRevision: 1, ...(result === undefined ? {} : { setupAgentResult: result }) });
  return taskId;
}
/**
 * L4-T2: the proposal row ("SETUP_APPLY") a person's "Use this setup" makes, with its candidate revision and the check's workspace. `state` is the row's; `check` is the check's own state: ready (workspace READY),
 * checking (PREPARING), failed (PREPARATION_FAILED, with the worker's recorded error) or none (no workspace row at all). `madeAt` is when the row was made (default: after the setup run started).
 */
function setupApply(h: Harness, company: string, project: string, opts: { state: "checking" | "approved" | "rejected" | "discarded"; check: "ready" | "checking" | "failed" | "none"; madeAt?: string; row?: Record<string, unknown>; revision?: number; candidateGone?: true }) {
  const workspaceId = randomUUID();
  const revision = opts.revision ?? 2;
  const command = (executable: string, args: string[]) => ({ cwd: "repo/api", executable, args, timeoutSeconds: 600 });
  const definition = { name: project, revision, setup: [command("npm", ["ci"])], readiness: [command("npm", ["test"])], orchestratorInstructions: "Delegate work.",
    repositories: [{ name: "api", url: "https://github.com/acme/api.git", path: "repo/api", defaultBranch: "main", credentialRef: "host-app" }] };
  // A rejected or discarded candidate's revision is deleted by the decision (apply.ts), so `candidateGone` is what a real rejected row looks like.
  if (opts.candidateGone !== true) h.db.set({ ...projectRevisionKey(company, project, revision), entityType: "PROJECT", candidate: true, definition });
  const at = opts.madeAt ?? new Date(NOW - 60_000).toISOString();
  if (opts.check !== "none") {
    const status = opts.check === "ready" ? "READY" : opts.check === "checking" ? "PREPARING" : "PREPARATION_FAILED";
    h.db.set({ ...workspaceKey(company, workspaceId), entityType: "WORKSPACE", id: workspaceId, companyId: company, orgId: company, status });
    if (opts.check === "failed") h.db.set({ pk: workspaceKey(company, workspaceId).pk, sk: `${OPERATION_SK_PREFIX}${randomUUID()}`, kind: "prepare", error: "readiness check 0 (npm test) exited with 1", createdAt: at });
  }
  h.db.set({ ...setupApplyKey(company, project), entityType: "SETUP_APPLY", orgId: company, project, taskId: "11111111-1111-4111-8111-111111111111", requestId: randomUUID(), by: ADA, digest: "d".repeat(64), baseRevision: 1, candidateRevision: revision,
    state: opts.state, check: { workspaceId, revision, startedAt: at, startedBy: ADA }, reply: {}, createdAt: at, ...(opts.state === "approved" ? { decidedAt: new Date(NOW - 30_000).toISOString(), decidedBy: ADA } : {}), ...opts.row });
}
/**
 * L4-T2b: a setup a person approved earlier, as a rejected or still-waiting newer proposal's row leaves it: the approved revision (the project's latest, so what tasks use), the catalog row that names it and the project's own
 * check mark (`setupCheck`, the mark a start reads), with `check` being that mark's workspace state. Returns the row field to merge into the newer proposal's row (`earlierApproval`).
 */
function earlierApproval(h: Harness, company: string, project: string, check: "ready" | "checking" | "failed" | "none", at = new Date(NOW - 3_600_000).toISOString()): { earlierApproval: { revision: number; at: string } } {
  const command = (executable: string, args: string[]) => ({ cwd: "repo/api", executable, args, timeoutSeconds: 600 });
  const definition = { name: project, revision: 2, setup: [command("npm", ["ci"])], readiness: [command("npm", ["test"])], orchestratorInstructions: "Delegate work.",
    repositories: [{ name: "api", url: "https://github.com/acme/api.git", path: "repo/api", defaultBranch: "main", credentialRef: "host-app" }] };
  h.db.set({ ...projectRevisionKey(company, project, 2), entityType: "PROJECT", definition });
  h.db.set({ ...orgProjectCatalogKey(company, project), entityType: "PROJECT_CATALOG", latestRevision: 2 });
  const workspaceId = randomUUID();
  if (check !== "none") {
    const status = check === "ready" ? "READY" : check === "checking" ? "PREPARING" : "PREPARATION_FAILED";
    h.db.set({ ...workspaceKey(company, workspaceId), entityType: "WORKSPACE", id: workspaceId, companyId: company, orgId: company, status });
    if (check === "failed") h.db.set({ pk: workspaceKey(company, workspaceId).pk, sk: `${OPERATION_SK_PREFIX}${randomUUID()}`, kind: "prepare", error: "readiness check 0 (npm test) exited with 1", createdAt: at });
  }
  // The mark's start is recent so a check going reads as going (a preparation nobody finished for 50 minutes reads as failed).
  h.db.set({ ...projectMetaKey(company, project), entityType: "PROJECT_META", status: "active", setupCheck: { workspaceId, revision: 2, startedAt: new Date(NOW - 60_000).toISOString(), startedBy: ADA } });
  return { earlierApproval: { revision: 2, at } };
}
const READY = (over: Record<string, unknown> = {}) => ({ status: "ready", stop: "proposed", proposal: PROPOSAL(), summary: SUMMARY(), ...over });
function journal(h: Harness, company: string, project: string, taskId: string, n: number, entry: Record<string, unknown>) {
  h.db.set({ ...journalKey({ orgId: company, project, taskId }, n), entityType: "SETUP_JOURNAL", orgId: company, project, taskId, entry: { n, source: "agent", command: "npm test", exitCode: 0, durationMs: 1000, timedOut: false, flagged: false, blockedHosts: [], tail: "", startedAt: TIME, ...entry } });
}
const IMAGE = `registry.example/worker@sha256:${"e".repeat(64)}`;
function evalReport(h: Harness, company: string, project: string, taskId: string, state: "reported" | "confirmed") {
  const command = { executable: "node", args: ["evals/run.js"], cwd: "." };
  const report = { cwd: ".", argument: "rovara-measures.json" };
  const body = { schemaVersion: 1, suites: [{
    selection: "evals/demo", questions: [{ id: "q1", category: "ordinary", path: "evals/demo/q1.txt" }, { id: "q2", category: "safety", path: "evals/demo/q2.txt" }],
    command, report, commandFingerprint: evalCommandFingerprintOf(command, report), judge: { kind: "rule", scoringPath: "evals/demo/score.txt" }, subsetSupported: true,
    catalogRowId: "gemini", model: "gemini-2.5-flash", modelVersion: "gemini-2.5-flash-001", image: IMAGE, route: "gateway", maxCallsPerQuestion: 2, maxCostMicrosPerQuestion: 10,
  }] } as unknown as SetupEvalDiscoveryReport;
  const commits = [{ repository: "api", commit: "a".repeat(40) }];
  const row = { entityType: "EVAL_DISCOVERY", schemaVersion: 1, company, project, taskId, commits, report: body, state, reportedAt: TIME, reportDigest: evalDiscoveryDigest({ company, project, taskId, commits, report: body }),
    ...(state === "confirmed" ? { confirmed: { personId: ADA, provider: "slack", role: "admin", at: TIME, selection: "evals/demo", planDigest: "d".repeat(64) } } : {}) };
  h.db.set({ ...evalDiscoveryKey(company, project, taskId), ...row });
}
/** A task a person started: the workspace in the project's index, its pointer and the task. */
function realTask(h: Harness, company: string, project: string, id: string, purpose?: string, legacy = false) {
  const taskId = `44444444-4444-4444-8444-${id.padStart(12, "0")}`;
  const workspaceId = `55555555-5555-4555-8555-${id.padStart(12, "0")}`;
  h.db.set({ pk: legacy ? `WORKSPACE#${workspaceId}` : workspacePartition(company, workspaceId), sk: "META", entityType: "WORKSPACE", id: workspaceId, companyId: company, orgId: company, projectName: project,
    workspaceProject: legacy ? project : workspaceProjectIndexValue(company, project), workspaceCreatedAt: TIME });
  h.db.set({ pk: legacy ? `WORKSPACE#${workspaceId}` : workspacePartition(company, workspaceId), sk: "DEVELOPER_TASK", entityType: "DEVELOPER_TASK_POINTER", taskId });
  h.db.set({ pk: `DEVTASK#${taskId}`, sk: "META", entityType: "DEVELOPER_TASK", companyId: company, taskId, project, ...(purpose === undefined ? {} : { purpose }) });
}
const bindChannel = (h: Harness, project: string, channelId = CHANNEL) => h.db.set({ pk: `SLACK_BINDING#${TEAM}`, sk: `CHANNEL#${channelId}`, teamId: TEAM, channelId, projectName: project, updatedAt: TIME });

/** Company A: Ada (admin), Ben (member), a project "alpha" of A. */
function companyA(options: HarnessOptions = {}) {
  const h = harness(options);
  h.join(ADA, A, "admin"); h.join(BEN, A, "member"); h.project("alpha", A);
  return h;
}

describe("the checklist's rows, each from its own records", () => {
  it("a new project: repos done, setup run waiting for a person, the rest not done", async () => {
    const h = companyA();
    const body = await h.ok();
    expect(body.repos).toEqual({ state: "done", count: 1, items: [{ name: "api", defaultBranch: "main", fullName: "acme/api" }] });
    expect(body.setupRun).toEqual({ state: "needs_you", status: "none", approval: "none" });
    expect(body.evalConfirm).toEqual({ state: "needs_you", report: "none", blockedBy: "setupRun" });
    expect(body.aiAndSpend).toEqual({ state: "done", source: "default", companyModelSaved: false, modelBudgetUsd: null });
    expect(body.slackChannel).toEqual({ state: "optional", channels: [] });
    expect(body.linear).toEqual({ state: "optional", team: null });
    expect(body.invites).toEqual({ state: "optional" });
    expect(body.firstTask).toEqual({ state: "needs_you", hasTask: false, canStart: false });
    expect(body.progress).toEqual({ done: 2, total: 8, percent: 25, nextRequired: "setupRun" });
    expect(body.viewer).toEqual({ companyRole: "admin", projectAdmin: false, canSkip: true });
    expect(ProjectSetupChecklistSchema.safeParse(body).success).toBe(true);
    expect(SETUP_STATUS_ROWS.every((row) => row in body)).toBe(true);
  });

  it("repos: a project with no readable repository is not done; a long list is cut at 32", async () => {
    const h = companyA();
    h.project("empty", A, [{ nope: true }]);
    expect((await h.ok(PATH("empty"))).repos).toEqual({ state: "needs_you", count: 0, items: [] });
    h.project("wide", A, Array.from({ length: 40 }, (_, i) => ({ name: `r${i}`, url: `https://example.com/r${i}`, defaultBranch: "main" })));
    const wide = (await h.ok(PATH("wide"))).repos;
    expect(wide.count).toBe(32);
    expect(wide.items[0]).toEqual({ name: "r0", defaultBranch: "main" });
  });

  it("setup run: running", async () => {
    const h = companyA();
    setupRun(h, A, "alpha", undefined);
    expect((await h.ok()).setupRun).toEqual({ state: "running", status: "running", approval: "none", startedAt: new Date(NOW - 120_000).toISOString() });
  });

  it("setup run: ready with a proposal nobody used is Needs you (not done), with the commands found, time, cost and the test outcome from the run's own journal", async () => {
    const h = companyA();
    const task = setupRun(h, A, "alpha", READY());
    journal(h, A, "alpha", task, 1, { command: "npm ci" });
    journal(h, A, "alpha", task, 2, { command: "npm test", exitCode: 0 });
    const run = (await h.ok()).setupRun;
    expect(run).toEqual({
      state: "needs_you", status: "ready", approval: "none", startedAt: new Date(NOW - 120_000).toISOString(), elapsedMs: 91_000, costCents: 37, commandsRun: 4, partial: false, stop: "proposed",
      commandsFound: { setup: 1, tests: 1 }, testOutcome: "passed",
    });
    expect(run).not.toHaveProperty("failedCommand");
  });

  it("setup run: the test outcome is unknown with no matching journal entry, and failed only when every matching entry failed", async () => {
    const h = companyA();
    const task = setupRun(h, A, "alpha", READY());
    expect((await h.ok()).setupRun.testOutcome).toBe("unknown");
    journal(h, A, "alpha", task, 1, { command: "npm test", exitCode: 1 });
    expect((await h.ok()).setupRun.testOutcome).toBe("failed");
    journal(h, A, "alpha", task, 2, { command: "npm test", exitCode: 0 });
    expect((await h.ok()).setupRun.testOutcome).toBe("unknown");
  });

  it("setup run: a run that stopped at a limit kept only a partial proposal: failed, with the fixed sentence", async () => {
    const h = companyA();
    setupRun(h, A, "alpha", READY({ stop: "attempts_used", summary: SUMMARY({ stop: "attempts_used", partial: true }) }));
    const run = (await h.ok()).setupRun;
    expect(run).toMatchObject({ state: "failed", status: "ready", partial: true, stop: "attempts_used", failure: SETUP_AGENT_FAILURES.attempts_used });
  });

  it("setup run: failed shows the broker's sentence, the failing command and the last lines of its output, redacted and bounded", async () => {
    const h = companyA();
    const task = setupRun(h, A, "alpha", { status: "failed", stop: "attempts_used", failure: SETUP_AGENT_FAILURES.attempts_used, summary: SUMMARY({ stop: "attempts_used", partial: true }) });
    // A credential-shaped string built at run time (push protection), in the command and in the output.
    const secret = `ghp_${"A1b2C3d4E5".repeat(4)}`;
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i} ${"x".repeat(i === 59 ? 900 : 5)}`);
    journal(h, A, "alpha", task, 1, { command: "npm ci", exitCode: 0 });
    journal(h, A, "alpha", task, 2, { command: `npm test --token ${secret}`, exitCode: 2, tail: `${lines.join("\n")}\nAuthorization: token ${secret}` });
    journal(h, A, "alpha", task, 3, { command: "npm run lint", exitCode: 0 });
    const run = (await h.ok()).setupRun;
    expect(run).toMatchObject({ state: "failed", failure: SETUP_AGENT_FAILURES.attempts_used });
    expect(run.failedCommand).toMatchObject({ n: 2, exitCode: 2, timedOut: false });
    expect(run.failedCommand?.lastLines.length).toBeLessThanOrEqual(20);
    expect(run.failedCommand?.lastLines.every((line: string) => line.length <= 300)).toBe(true);
    expect(JSON.stringify(run)).not.toContain(secret);
    expect(run.failedCommand?.lastLines.at(-1)).toContain("[REDACTED]");
  });

  it("setup run: the last lines of a long (4 KB) output are its END, not the start", async () => {
    const h = companyA();
    const task = setupRun(h, A, "alpha", { status: "failed", stop: "attempts_used", failure: SETUP_AGENT_FAILURES.attempts_used });
    const long = [...Array.from({ length: 70 }, (_, i) => `noise ${i} ${"y".repeat(40)}`), "THE-REAL-ERROR-AT-THE-END"].join("\n").slice(-4_000);
    journal(h, A, "alpha", task, 1, { command: "npm test", exitCode: 1, tail: long });
    const lines = (await h.ok()).setupRun.failedCommand?.lastLines ?? [];
    expect(lines.at(-1)).toBe("THE-REAL-ERROR-AT-THE-END");
  });

  it("setup run: journal rows that name another company, project or run are ignored; a pointer naming another company is not applied", async () => {
    const h = companyA();
    const task = setupRun(h, A, "alpha", { status: "failed", stop: "attempts_used", failure: SETUP_AGENT_FAILURES.attempts_used });
    journal(h, A, "alpha", task, 1, { command: "npm ci", exitCode: 0 });
    for (const [n, over] of [[2, { orgId: B }], [3, { project: "beta" }], [4, { taskId: "99999999-9999-4999-8999-999999999990" }]] as const) {
      h.db.set({ ...(h.db.get(journalKey({ orgId: A, project: "alpha", taskId: task }, 1).pk, journalKey({ orgId: A, project: "alpha", taskId: task }, 1).sk) as object), ...journalKey({ orgId: A, project: "alpha", taskId: task }, n), ...over, entry: { n, source: "agent", command: `echo ${CANARY}`, exitCode: 1, durationMs: 1, timedOut: false, flagged: false, blockedHosts: [], tail: CANARY, startedAt: TIME } });
    }
    const run = (await h.ok()).setupRun;
    expect(run.failedCommand).toBeUndefined();
    expect(JSON.stringify(run)).not.toContain(CANARY);
    h.db.set({ ...(h.db.get(setupAgentKey(A, "alpha").pk, "AGENT") as object), orgId: B });
    expect((await h.ok()).setupRun).toEqual({ state: "needs_you", status: "none", approval: "none" });
  });

  it("setup run: a timed-out command is the failing one; a failed run with no journal has none", async () => {
    const h = companyA();
    const task = setupRun(h, A, "alpha", { status: "failed", stop: "infrastructure", failure: SETUP_AGENT_FAILURES.infrastructure });
    expect((await h.ok()).setupRun).toEqual({ state: "failed", status: "failed", approval: "none", startedAt: new Date(NOW - 120_000).toISOString(), testOutcome: "unknown", failure: SETUP_AGENT_FAILURES.infrastructure });
    journal(h, A, "alpha", task, 1, { command: "npm ci", exitCode: null, timedOut: true, tail: "still going" });
    expect((await h.ok()).setupRun.failedCommand).toEqual({ n: 1, command: "npm ci", exitCode: null, timedOut: true, lastLines: ["still going"] });
  });

  it("setup run: a stored proposal that no longer parses counts as no commands, never a guess", async () => {
    const h = companyA();
    setupRun(h, A, "alpha", READY({ proposal: { version: 2, setup: "nope" } }));
    const run = (await h.ok()).setupRun;
    expect(run.state).toBe("needs_you");
    expect(run).not.toHaveProperty("commandsFound");
    expect(run.testOutcome).toBe("unknown");
  });

  it("eval confirm: reported waits for a person; confirmed is done; blocked while the setup run is not done", async () => {
    const h = companyA();
    const task = setupRun(h, A, "alpha", undefined);
    evalReport(h, A, "alpha", task, "reported");
    expect((await h.ok()).evalConfirm).toEqual({ state: "needs_you", report: "reported", suites: [{ selection: "evals/demo", questions: 2 }], blockedBy: "setupRun" });
    h.db.set({ ...setupAgentKey(A, "alpha"), entityType: "SETUP_AGENT", orgId: A, project: "alpha", taskId: task, requestId: "22222222-2222-4222-8222-222222222222", requestedBy: ADA, basedOnRevision: 1, startedAt: TIME, limits: {} });
    h.db.set({ pk: `DEVTASK#${task}`, sk: "META", entityType: "DEVELOPER_TASK", companyId: A, orgId: A, taskId: task, project: "alpha", purpose: "setup_agent", workspaceId: "33333333-3333-4333-8333-333333333333", startingRevision: 1, setupAgentResult: READY() });
    expect((await h.ok()).evalConfirm).toEqual({ state: "needs_you", report: "reported", suites: [{ selection: "evals/demo", questions: 2 }] });
    evalReport(h, A, "alpha", task, "confirmed");
    expect((await h.ok()).evalConfirm).toEqual({ state: "done", report: "confirmed", suites: [{ selection: "evals/demo", questions: 2 }], confirmedSelection: "evals/demo" });
  });

  it("eval confirm: only the LATEST run's report counts, and a report row that was edited reads as none", async () => {
    const h = companyA();
    const older = "66666666-6666-4666-8666-666666666666";
    const latest = setupRun(h, A, "alpha", READY());
    evalReport(h, A, "alpha", older, "confirmed");
    expect((await h.ok()).evalConfirm.report).toBe("none");
    evalReport(h, A, "alpha", latest, "confirmed");
    h.db.set({ ...(h.db.get(evalDiscoveryKey(A, "alpha", latest).pk, evalDiscoveryKey(A, "alpha", latest).sk) as object), reportDigest: "0".repeat(64) });
    expect((await h.ok()).evalConfirm).toEqual({ state: "needs_you", report: "none" });
  });

  // L4-T5 (owner D9): the eval row is required only when evals were found. A finished run that found none leaves nothing to confirm, so the row is done by itself.
  it("eval confirm (D9): a finished run that found no evals makes the row done by itself, and the first task can start", async () => {
    const h = companyA();
    setupRun(h, A, "alpha", READY());
    // L4-T2 (D1) + L4-T5 (D9) together: the eval row is done by itself on the proposal, but the first task still waits for the setup to be approved and checked.
    const unapproved = await h.ok();
    expect(unapproved.evalConfirm).toEqual({ state: "done", report: "none" });
    expect(unapproved.setupRun.state).toBe("needs_you");
    expect(unapproved.firstTask.canStart).toBe(false);
    setupApply(h, A, "alpha", { state: "approved", check: "ready" });
    const body = await h.ok();
    expect(body.evalConfirm).toEqual({ state: "done", report: "none" });
    expect(body.firstTask.canStart).toBe(true);
    expect(body.progress).toEqual({ done: 4, total: 8, percent: 50, nextRequired: "firstTask" });
  });

  it("eval confirm (D9): not before the setup run is done (blocked while it runs, failed, partial or never started), and never when evals WERE found", async () => {
    for (const result of [undefined, { status: "failed", stop: "attempts_used", failure: SETUP_AGENT_FAILURES.attempts_used, summary: SUMMARY({ stop: "attempts_used", partial: true }) },
      READY({ stop: "attempts_used", summary: SUMMARY({ stop: "attempts_used", partial: true }) })] as const) {
      const h = companyA();
      setupRun(h, A, "alpha", result);
      expect((await h.ok()).evalConfirm).toEqual({ state: "needs_you", report: "none", blockedBy: "setupRun" });
    }
    const never = companyA();
    expect((await never.ok()).evalConfirm).toEqual({ state: "needs_you", report: "none", blockedBy: "setupRun" });
    const found = companyA();
    const task = setupRun(found, A, "alpha", READY());
    evalReport(found, A, "alpha", task, "reported");
    expect((await found.ok()).evalConfirm).toMatchObject({ state: "needs_you", report: "reported" });
    expect((await found.ok()).firstTask.canStart).toBe(false);
  });

  it("eval confirm (D9): an eval report that is there but does not read back is NOT 'none found' (the row keeps waiting), and a report that is absent is", async () => {
    const h = companyA();
    const task = setupRun(h, A, "alpha", READY());
    evalReport(h, A, "alpha", task, "reported");
    h.db.set({ ...(h.db.get(evalDiscoveryKey(A, "alpha", task).pk, evalDiscoveryKey(A, "alpha", task).sk) as object), reportDigest: "0".repeat(64) });
    expect((await h.ok()).evalConfirm).toEqual({ state: "needs_you", report: "none" });
    h.db.set({ ...(h.db.get(evalDiscoveryKey(A, "alpha", task).pk, evalDiscoveryKey(A, "alpha", task).sk) as object), report: { nonsense: true } });
    expect((await h.ok()).evalConfirm).toEqual({ state: "needs_you", report: "none" });
  });

  it("eval confirm (D9): another company's report for a project of the same name never counts, and does not hide this company's none-found", async () => {
    const h = companyA();
    const task = setupRun(h, A, "alpha", READY());
    const theirs = setupRun(h, B, "alpha", READY(), "99999999-9999-4999-8999-999999999999");
    evalReport(h, B, "alpha", theirs, "reported");
    // A's run has no report of its own: done by itself. B's report (and B's task id) is a row in B's partition and is never read for A.
    expect((await h.ok()).evalConfirm).toEqual({ state: "done", report: "none" });
    expect(task).not.toBe(theirs);
    // A report row stored under A's partition for a task that is not A's current run does not count either.
    evalReport(h, A, "alpha", "66666666-6666-4666-8666-666666666666", "reported");
    expect((await h.ok()).evalConfirm).toEqual({ state: "done", report: "none" });
  });

  it("eval confirm (D9): a person's 'no evals' for the run still reads as no_evals, not as none", async () => {
    const h = companyA();
    setupRun(h, A, "alpha", READY());
    expect((await h.call("PUT", EVAL_NONE(), { noEvals: true })).status).toBe(200);
    expect((await h.ok()).evalConfirm).toMatchObject({ state: "done", report: "no_evals" });
  });

  it("AI and spend: the project's own budget, then the company's saved model, else the install's defaults", async () => {
    const h = companyA();
    expect((await h.ok()).aiAndSpend).toEqual({ state: "done", source: "default", companyModelSaved: false, modelBudgetUsd: null });
    h.db.set({ ...modelSelectionPolicyKey(A), entityType: "MODEL_SELECTION_POLICY", orgId: A, version: 1, revision: 2, rankingVersion: "g3-v1", stepOverrides: {} });
    expect((await h.ok()).aiAndSpend).toEqual({ state: "done", source: "company", companyModelSaved: true, modelBudgetUsd: null });
    h.db.set({ ...projectSettingsKey(A, "alpha"), entityType: "PROJECT_SETTINGS", companyId: A, projectName: "alpha", overrides: { model_budget_usd: 12.5 }, revision: 1, updatedAt: TIME, updatedBy: ADA });
    expect((await h.ok()).aiAndSpend).toEqual({ state: "done", source: "project", companyModelSaved: true, modelBudgetUsd: 12.5 });
  });

  it("AI and spend: a stored row that names another company or does not parse is a fixed 503, never a guess", async () => {
    const h = companyA();
    h.db.set({ ...projectSettingsKey(A, "alpha"), entityType: "PROJECT_SETTINGS", companyId: B, projectName: "alpha", overrides: { model_budget_usd: 1 }, revision: 1 });
    expect(await h.call("GET", PATH())).toEqual({ status: 503, body: error("RUNTIME_UNAVAILABLE", SETUP_STATUS_UNREADABLE) });
    h.db.delete(projectSettingsKey(A, "alpha").pk, "META");
    h.db.set({ ...modelSelectionPolicyKey(A), entityType: "MODEL_SELECTION_POLICY", orgId: B, version: 1, revision: 2, rankingVersion: "g3-v1", stepOverrides: {} });
    expect(await h.call("GET", PATH())).toEqual({ status: 503, body: error("RUNTIME_UNAVAILABLE", SETUP_STATUS_UNREADABLE) });
  });

  it("Slack channel: the project's existing binding makes it done; the install's own team belongs to the implicit company only", async () => {
    const h = harness();
    h.join(ADA, IMPLICIT_COMPANY_ID, "admin"); h.project("alpha");
    bindChannel(h, "alpha"); bindChannel(h, "other", "C0999ZZZZ");
    expect((await h.ok()).slackChannel).toEqual({ state: "done", channels: [{ channelId: CHANNEL }] });
    // Company A has the same project name bound in the install's team: it never sees the implicit company's binding.
    const other = companyA();
    bindChannel(other, "alpha");
    expect((await other.ok()).slackChannel).toEqual({ state: "optional", channels: [] });
  });

  it("linear and invites have no Code state yet: optional, or skipped", async () => {
    const h = companyA();
    expect(await h.call("PUT", SKIPS(), { row: "linear", skipped: true })).toMatchObject({ status: 200 });
    expect(await h.call("PUT", SKIPS(), { row: "invites", skipped: true })).toMatchObject({ status: 200 });
    const body = await h.ok();
    expect(body.linear).toEqual({ state: "skipped", team: null });
    expect(body.invites).toEqual({ state: "skipped" });
  });

  it("linear: the seam for the OAuth team pick (#838) makes it done, and a set-up row beats a skip", async () => {
    const h = companyA();
    h.db.set({ ...setupSkipsKey(A, "alpha"), entityType: "PROJECT_SETUP_SKIPS", companyId: A, project: "alpha", skipped: ["linear", "slackChannel"], revision: 1 });
    const status = await readProjectSetupStatus({
      documentClient: h.db, tableName: "State", now: () => NOW, companyId: A, project: "alpha", definition: { revision: 1, repositories: [] }, viewer: { companyRole: "admin", projectAdmin: false },
      readers: { channels: async () => [{ channelId: CHANNEL, name: "dev", isPrivate: false }], linearTeam: async () => ({ id: "team-1", name: "Platform" }) },
    });
    expect(status.linear).toEqual({ state: "done", team: { id: "team-1", name: "Platform" } });
    expect(status.slackChannel.state).toBe("done");
  });

  it("first task: a setup run's workspace is not a task; a task a person started is, and the legacy partition counts for the implicit company only", async () => {
    const h = companyA();
    realTask(h, A, "alpha", "1", "setup_agent");
    expect((await h.ok()).firstTask).toEqual({ state: "needs_you", hasTask: false, canStart: false });
    h.db.set({ pk: workspacePartition(A, "77777777-7777-4777-8777-777777777777"), sk: "META", entityType: "WORKSPACE", id: "77777777-7777-4777-8777-777777777777", companyId: A, orgId: A, projectName: "alpha", workspaceProject: workspaceProjectIndexValue(A, "alpha"), workspaceCreatedAt: TIME });
    expect((await h.ok()).firstTask.hasTask).toBe(false);
    realTask(h, A, "alpha", "2");
    expect((await h.ok()).firstTask).toEqual({ state: "done", hasTask: true, canStart: false });

    const legacy = harness();
    legacy.join(ADA, IMPLICIT_COMPANY_ID, "admin"); legacy.project("alpha");
    realTask(legacy, IMPLICIT_COMPANY_ID, "alpha", "3", undefined, true);
    expect((await legacy.ok()).firstTask.hasTask).toBe(true);
    // The same plain-named index row, seen from company A, is never read (company A reads its own partition only).
    const foreign = companyA();
    realTask(foreign, IMPLICIT_COMPANY_ID, "alpha", "4", undefined, true);
    // A legacy row that names no company at all is the implicit company's: company A must not read it either.
    const bare = "88888888-8888-4888-8888-888888888881";
    foreign.db.set({ pk: `WORKSPACE#${bare}`, sk: "META", entityType: "WORKSPACE", id: bare, projectName: "alpha", workspaceProject: "alpha", workspaceCreatedAt: TIME });
    foreign.db.set({ pk: `WORKSPACE#${bare}`, sk: "DEVELOPER_TASK", entityType: "DEVELOPER_TASK_POINTER", taskId: "44444444-4444-4444-8444-000000000009" });
    foreign.db.set({ pk: "DEVTASK#44444444-4444-4444-8444-000000000009", sk: "META", entityType: "DEVELOPER_TASK", taskId: "44444444-4444-4444-8444-000000000009", project: "alpha" });
    expect((await foreign.ok()).firstTask.hasTask).toBe(false);
    // Defence in depth: a plain-named (legacy partition) row that even names company A is not read, because A never reads the legacy partition.
    const named = "88888888-8888-4888-8888-888888888882";
    foreign.db.set({ pk: `WORKSPACE#${named}`, sk: "META", entityType: "WORKSPACE", id: named, companyId: A, orgId: A, projectName: "alpha", workspaceProject: "alpha", workspaceCreatedAt: TIME });
    foreign.db.set({ pk: `WORKSPACE#${named}`, sk: "DEVELOPER_TASK", entityType: "DEVELOPER_TASK_POINTER", taskId: "44444444-4444-4444-8444-00000000000a" });
    foreign.db.set({ pk: "DEVTASK#44444444-4444-4444-8444-00000000000a", sk: "META", entityType: "DEVELOPER_TASK", companyId: A, taskId: "44444444-4444-4444-8444-00000000000a", project: "alpha" });
    expect((await foreign.ok()).firstTask.hasTask).toBe(false);
    // A task in A's own partition whose record names another org is not counted.
    realTask(foreign, A, "alpha", "b");
    foreign.db.set({ ...(foreign.db.get("DEVTASK#44444444-4444-4444-8444-00000000000b", "META") as object), orgId: B });
    expect((await foreign.ok()).firstTask.hasTask).toBe(false);
  });

  it("can start needs the setup run, the eval confirm and AI and spend all done; 100% needs every row done or skipped", async () => {
    const h = companyA();
    const task = setupRun(h, A, "alpha", READY());
    evalReport(h, A, "alpha", task, "reported");
    expect((await h.ok()).firstTask.canStart).toBe(false);
    evalReport(h, A, "alpha", task, "confirmed");
    // L4-T2: a proposal nobody approved is not a finished setup, so the first task cannot start yet.
    expect((await h.ok()).firstTask).toEqual({ state: "needs_you", hasTask: false, canStart: false });
    expect((await h.ok()).progress).toEqual({ done: 3, total: 8, percent: 38, nextRequired: "setupRun" });
    setupApply(h, A, "alpha", { state: "approved", check: "ready" });
    expect((await h.ok()).firstTask).toEqual({ state: "needs_you", hasTask: false, canStart: true });
    expect((await h.ok()).progress).toEqual({ done: 4, total: 8, percent: 50, nextRequired: "firstTask" });
    realTask(h, A, "alpha", "5");
    bindChannel(h, "alpha");
    // Company A has no Slack link: it stays optional until skipped; skipped rows count toward 100%.
    for (const row of ["slackChannel", "linear", "invites"]) expect(await h.call("PUT", SKIPS(), { row, skipped: true })).toMatchObject({ status: 200 });
    expect((await h.ok()).progress).toEqual({ done: 8, total: 8, percent: 100, nextRequired: null });
    expect(await h.call("PUT", SKIPS(), { row: "invites", skipped: false })).toMatchObject({ status: 200 });
    expect((await h.ok()).progress).toMatchObject({ done: 7, percent: 88 });
  });
});

// L4-T2 (setup review D1, G1, G6): "Setup run: Done" means a person APPROVED the setup and its check on a fresh machine is ready.
describe("Done means approved (L4-T2)", () => {
  type Apply = Parameters<typeof setupApply>[3];
  const table: Array<{ name: string; run: "ready" | "none" | "running"; apply?: Apply; state: string; approval: string; check?: string; reason?: RegExp; newer?: string }> = [
    { name: "a proposal only (nobody used it)", run: "ready", state: "needs_you", approval: "none" },
    { name: "no run and no setup", run: "none", state: "needs_you", approval: "none" },
    { name: "a candidate whose check is ready, waiting for a decision", run: "ready", apply: { state: "checking", check: "ready" }, state: "needs_you", approval: "candidate", check: "ready" },
    { name: "a candidate whose check is going on a fresh machine", run: "ready", apply: { state: "checking", check: "checking" }, state: "running", approval: "checking", check: "checking" },
    { name: "a candidate whose check failed: needs you, with the reason", run: "ready", apply: { state: "checking", check: "failed" }, state: "needs_you", approval: "candidate", check: "failed", reason: /^test: npm test/u },
    { name: "a candidate whose check has no workspace (stale)", run: "ready", apply: { state: "checking", check: "none" }, state: "needs_you", approval: "candidate", check: "unchecked" },
    { name: "approved and its check ready", run: "ready", apply: { state: "approved", check: "ready" }, state: "done", approval: "approved", check: "ready" },
    { name: "approved and its check failed: needs you, with the reason", run: "ready", apply: { state: "approved", check: "failed" }, state: "needs_you", approval: "approved", check: "failed", reason: /^test: npm test/u },
    { name: "approved and its check going", run: "ready", apply: { state: "approved", check: "checking" }, state: "running", approval: "approved", check: "checking" },
    { name: "approved with no readable check", run: "ready", apply: { state: "approved", check: "none" }, state: "needs_you", approval: "approved", check: "unchecked" },
    { name: "rejected: the proposal is waiting again", run: "ready", apply: { state: "rejected", check: "ready" }, state: "needs_you", approval: "none" },
    { name: "discarded: the proposal is waiting again", run: "ready", apply: { state: "discarded", check: "ready" }, state: "needs_you", approval: "none" },
    // L4-T2b: tasks keep using the approved setup, so a re-run's proposal nobody has used yet is named, not a reason to leave done.
    { name: "approved, then a newer run with a proposal nobody used: still done, the proposal named", run: "ready", apply: { state: "approved", check: "ready", madeAt: new Date(NOW - 600_000).toISOString() }, state: "done", approval: "approved", check: "ready", newer: "needs_you" },
    { name: "approved with a failed check, then a newer run with a proposal nobody used: needs you for the check", run: "ready", apply: { state: "approved", check: "failed", madeAt: new Date(NOW - 600_000).toISOString() }, state: "needs_you", approval: "approved", check: "failed", reason: /^test: npm test/u, newer: "needs_you" },
    { name: "approved with no run (a plan's setup update): done", run: "none", apply: { state: "approved", check: "ready" }, state: "done", approval: "approved", check: "ready" },
    { name: "a candidate waiting while no run exists (a plan's setup update)", run: "none", apply: { state: "checking", check: "ready" }, state: "needs_you", approval: "candidate", check: "ready" },
    { name: "a run going wins over an approved setup", run: "running", apply: { state: "approved", check: "ready" }, state: "running", approval: "approved", check: "ready" },
  ];
  for (const row of table) {
    it(row.name, async () => {
      const h = companyA();
      if (row.run === "ready") setupRun(h, A, "alpha", READY());
      if (row.run === "running") setupRun(h, A, "alpha", undefined);
      if (row.apply !== undefined) setupApply(h, A, "alpha", row.apply);
      const run = (await h.ok()).setupRun;
      expect(run.state).toBe(row.state);
      expect(run.approval).toBe(row.approval);
      expect(run.check?.status).toBe(row.check);
      if (row.reason === undefined) expect(run.check?.failedStep).toBeUndefined(); else expect(run.check?.failedStep).toMatch(row.reason);
      expect(run.approvedAt !== undefined).toBe(row.approval === "approved");
      expect(run.newerProposal).toBe(row.newer);
    });
  }

  describe("an approval outlives a newer proposal (L4-T2b)", () => {
    const rejected = (h: Harness, state: "rejected" | "discarded", earlier?: ReturnType<typeof earlierApproval>) =>
      setupApply(h, A, "alpha", { state, check: "ready", revision: 3, candidateGone: true, ...(earlier === undefined ? {} : { row: earlier }) });

    it("approved, then a re-run's proposal was rejected or discarded: still done, with the approval and ITS check, and the newer proposal named", async () => {
      for (const state of ["rejected", "discarded"] as const) {
        const h = companyA();
        setupRun(h, A, "alpha", READY());
        const earlier = earlierApproval(h, A, "alpha", "ready");
        rejected(h, state, earlier);
        const run = (await h.ok()).setupRun;
        expect(run, state).toMatchObject({ state: "done", status: "ready", approval: "approved", check: { status: "ready" }, approvedAt: earlier.earlierApproval.at, newerProposal: "rejected" });
        expect(run.check?.failedStep).toBeUndefined();
      }
    });

    it("approved, then a re-run's candidate is still waiting: done, with the newer proposal needing you (whatever its own check says)", async () => {
      for (const [check, newer] of [["ready", "needs_you"], ["failed", "needs_you"], ["none", "needs_you"], ["checking", "checking"]] as const) {
        const h = companyA();
        setupRun(h, A, "alpha", READY());
        setupApply(h, A, "alpha", { state: "checking", check, revision: 3, row: earlierApproval(h, A, "alpha", "ready") });
        const run = (await h.ok()).setupRun;
        expect(run, check).toMatchObject({ state: "done", approval: "approved", check: { status: "ready" }, newerProposal: newer });
        // The candidate's failed check is not the setup tasks use: nothing of it shows as the row's check.
        expect(run.check?.failedStep).toBeUndefined();
      }
    });

    it("the row is exactly what tasks use: the approved setup's own check decides, whatever happened to the newer proposal", async () => {
      for (const [check, state, status] of [["failed", "needs_you", "failed"], ["checking", "running", "checking"], ["none", "needs_you", "unchecked"], ["ready", "done", "ready"]] as const) {
        const h = companyA();
        setupRun(h, A, "alpha", READY());
        rejected(h, "rejected", earlierApproval(h, A, "alpha", check));
        const run = (await h.ok()).setupRun;
        expect([run.state, run.approval, run.check?.status, run.newerProposal], check).toEqual([state, "approved", status, "rejected"]);
        if (check === "failed") expect(run.check?.failedStep).toMatch(/^test: npm test/u);
      }
    });

    it("never approved, then rejected: needs you, no approval; never approved with a candidate waiting: the candidate's own states", async () => {
      const h = companyA();
      setupRun(h, A, "alpha", READY());
      rejected(h, "rejected");
      expect((await h.ok()).setupRun).toMatchObject({ state: "needs_you", approval: "none" });
      expect((await h.ok()).setupRun.newerProposal).toBeUndefined();
      setupApply(h, A, "alpha", { state: "checking", check: "ready", revision: 3 });
      expect((await h.ok()).setupRun).toMatchObject({ state: "needs_you", approval: "candidate" });
    });

    it("an earlier approval whose revision no longer reads back, or is another company's, is no approval", async () => {
      const h = companyA();
      setupRun(h, A, "alpha", READY());
      rejected(h, "rejected", { earlierApproval: { revision: 9, at: new Date(NOW - 1_000).toISOString() } });
      expect((await h.ok()).setupRun).toMatchObject({ state: "needs_you", approval: "none" });
      // Company B has revision 2 and a ready check under the same project name; company A's row naming revision 2 must not find them.
      earlierApproval(h, B, "alpha", "ready");
      rejected(h, "rejected", { earlierApproval: { revision: 2, at: new Date(NOW - 1_000).toISOString() } });
      expect((await h.ok()).setupRun).toMatchObject({ state: "needs_you", approval: "none" });
    });

    it("a row naming another project or company carries no approval, and a stored revision that is not the one named is no approval", async () => {
      for (const over of [{ project: "beta" }, { orgId: B }]) {
        const h = companyA();
        setupRun(h, A, "alpha", READY());
        rejected(h, "rejected", { ...earlierApproval(h, A, "alpha", "ready"), ...over });
        expect((await h.ok()).setupRun, JSON.stringify(over)).toMatchObject({ state: "needs_you", approval: "none" });
      }
      const h = companyA();
      setupRun(h, A, "alpha", READY());
      const earlier = earlierApproval(h, A, "alpha", "ready");
      const stored = h.db.get(projectRevisionKey(A, "alpha", 2).pk, projectRevisionKey(A, "alpha", 2).sk) as { definition: Record<string, unknown> };
      h.db.set({ ...projectRevisionKey(A, "alpha", 2), entityType: "PROJECT", definition: { ...stored.definition, revision: 9 } });
      rejected(h, "rejected", earlier);
      expect((await h.ok()).setupRun).toMatchObject({ state: "needs_you", approval: "none" });
    });

    it("a re-run that started after the rejected candidate has its own unused proposal: that is the newer one named", async () => {
      const h = companyA();
      setupRun(h, A, "alpha", READY());
      setupApply(h, A, "alpha", { state: "rejected", check: "ready", revision: 3, candidateGone: true, madeAt: new Date(NOW - 600_000).toISOString(), row: earlierApproval(h, A, "alpha", "ready") });
      expect((await h.ok()).setupRun).toMatchObject({ state: "done", approval: "approved", newerProposal: "needs_you" });
    });

    it("a malformed earlier approval is ignored, never guessed", async () => {
      for (const bad of [{ revision: "2", at: "x" }, { revision: 2 }, { revision: -1, at: "x" }, { revision: 1.5, at: "x" }, { revision: 2, at: "" }, "approved", null]) {
        const h = companyA();
        setupRun(h, A, "alpha", READY());
        earlierApproval(h, A, "alpha", "ready");
        rejected(h, "rejected", { earlierApproval: bad } as never);
        expect((await h.ok()).setupRun, JSON.stringify(bad)).toMatchObject({ state: "needs_you", approval: "none" });
      }
    });

    it("the first task and the progress follow the kept approval, and a running run or a failed one still wins", async () => {
      const h = companyA();
      const task = setupRun(h, A, "alpha", READY());
      evalReport(h, A, "alpha", task, "confirmed");
      rejected(h, "rejected", earlierApproval(h, A, "alpha", "ready"));
      const body = await h.ok();
      expect([body.firstTask.canStart, body.progress.nextRequired, body.setupRun.state]).toEqual([true, "firstTask", "done"]);
      const failed = companyA();
      setupRun(failed, A, "alpha", { status: "failed", stop: "attempts_used", failure: SETUP_AGENT_FAILURES.attempts_used });
      rejected(failed, "rejected", earlierApproval(failed, A, "alpha", "ready"));
      expect((await failed.ok()).setupRun).toMatchObject({ state: "failed", approval: "approved" });
      const running = companyA();
      setupRun(running, A, "alpha", undefined);
      rejected(running, "rejected", earlierApproval(running, A, "alpha", "ready"));
      expect((await running.ok()).setupRun).toMatchObject({ state: "running", approval: "approved" });
    });

    it("two companies: B's approved project reads done for B alone, and A's rejected project with the same name never borrows it", async () => {
      const h = companyA();
      h.join(CAT, B, "admin"); h.project("beta", B);
      setupRun(h, B, "beta", READY());
      const earlier = earlierApproval(h, B, "beta", "ready");
      setupApply(h, B, "beta", { state: "rejected", check: "ready", revision: 3, candidateGone: true, row: earlier });
      // A's own project: a rejected proposal, no approval of its own.
      setupRun(h, A, "alpha", READY(), "77777777-7777-4777-8777-777777777777");
      setupApply(h, A, "alpha", { state: "rejected", check: "ready", revision: 3, candidateGone: true });
      expect((await h.ok()).setupRun).toMatchObject({ state: "needs_you", approval: "none" });
      expect((await h.ok()).setupRun.approvedAt).toBeUndefined();
      h.as(CAT, "s-cat");
      expect((await h.ok(PATH("beta"))).setupRun).toMatchObject({ state: "done", approval: "approved", approvedAt: earlier.earlierApproval.at, newerProposal: "rejected" });
    });
  });

  it("a failed or partial run stays failed whatever was approved before", async () => {
    const h = companyA();
    setupRun(h, A, "alpha", { status: "failed", stop: "attempts_used", failure: SETUP_AGENT_FAILURES.attempts_used });
    setupApply(h, A, "alpha", { state: "approved", check: "ready" });
    expect((await h.ok()).setupRun).toMatchObject({ state: "failed", status: "failed", approval: "approved" });
  });

  it("the first task, the next required row and the progress follow the approval", async () => {
    const h = companyA();
    const task = setupRun(h, A, "alpha", READY());
    evalReport(h, A, "alpha", task, "confirmed");
    for (const [apply, canStart, next] of [[undefined, false, "setupRun"], [{ state: "checking", check: "ready" }, false, "setupRun"], [{ state: "approved", check: "failed" }, false, "setupRun"], [{ state: "approved", check: "ready" }, true, "firstTask"]] as const) {
      if (apply !== undefined) setupApply(h, A, "alpha", apply);
      const body = await h.ok();
      expect([body.firstTask.canStart, body.progress.nextRequired]).toEqual([canStart, next]);
    }
  });

  it("the eval row still waits on the run's proposal, not on the approval, and no other row changes with it", async () => {
    const h = companyA();
    const task = setupRun(h, A, "alpha", READY());
    evalReport(h, A, "alpha", task, "reported");
    realTask(h, A, "alpha", "5");
    const before = await h.ok();
    expect(before.evalConfirm).toEqual({ state: "needs_you", report: "reported", suites: [{ selection: "evals/demo", questions: 2 }] });
    setupApply(h, A, "alpha", { state: "approved", check: "ready" });
    const after = await h.ok();
    for (const row of ["repos", "evalConfirm", "aiAndSpend", "slackChannel", "linear", "invites", "firstTask", "viewer"] as const) expect(after[row], row).toEqual(before[row]);
    expect(after.setupRun.state).toBe("done");
    expect(before.setupRun.state).toBe("needs_you");
  });

  it("a proposal row of another project or company is no approval, and company B's approval never reaches company A", async () => {
    const h = companyA();
    setupRun(h, A, "alpha", READY());
    setupApply(h, A, "alpha", { state: "approved", check: "ready", row: { project: "beta" } });
    expect((await h.ok()).setupRun).toMatchObject({ state: "needs_you", approval: "none" });
    setupApply(h, A, "alpha", { state: "approved", check: "ready", row: { orgId: B } });
    expect((await h.ok()).setupRun).toMatchObject({ state: "needs_you", approval: "none" });
    h.db.delete(setupApplyKey(A, "alpha").pk, setupApplyKey(A, "alpha").sk);
    setupApply(h, B, "alpha", { state: "approved", check: "ready" });
    expect((await h.ok()).setupRun).toMatchObject({ state: "needs_you", approval: "none" });
  });

  it("the check's reason is the broker's one redacted line, bounded", async () => {
    const h = companyA();
    setupRun(h, A, "alpha", READY());
    setupApply(h, A, "alpha", { state: "checking", check: "failed" });
    const step = (await h.ok()).setupRun.check?.failedStep ?? "";
    expect(step.length).toBeLessThanOrEqual(300);
    expect(step).not.toMatch(/[\n\r]/u);
  });

  describe("AI and spend: done only while a model call is possible (G6)", () => {
    const read = async (modelCall?: () => Promise<boolean | null>) => {
      const h = companyA();
      const task = setupRun(h, A, "alpha", READY());
      evalReport(h, A, "alpha", task, "confirmed");
      setupApply(h, A, "alpha", { state: "approved", check: "ready" });
      return ProjectSetupChecklistSchema.parse(await readProjectSetupStatus({
        documentClient: h.db, tableName: "State", now: () => NOW, companyId: A, project: "alpha", definition: { revision: 1, repositories: [{ name: "api", url: "https://github.com/acme/api", defaultBranch: "main" }] },
        viewer: { companyRole: "admin", projectAdmin: false }, readers: { channels: async () => [], ...(modelCall === undefined ? {} : { modelCall }) },
      }));
    };
    it("no key (the gateway says no call is possible): needs you, the first task cannot start, the AI row is the next required one", async () => {
      const body = await read(async () => false);
      expect(body.aiAndSpend).toEqual({ state: "needs_you", source: "default", companyModelSaved: false, modelBudgetUsd: null, modelCall: "none" });
      expect(body.firstTask.canStart).toBe(false);
      expect(body.progress.nextRequired).toBe("aiAndSpend");
      expect(body.setupRun.state).toBe("done");
    });
    it("a call is possible: done", async () => {
      const body = await read(async () => true);
      expect(body.aiAndSpend).toMatchObject({ state: "done", modelCall: "possible" });
      expect(body.firstTask.canStart).toBe(true);
    });
    it("the gateway could not say (null or a throw): not blocked on a guess, and said so", async () => {
      for (const reader of [async () => null, async (): Promise<boolean> => { throw new Error("gateway down"); }]) {
        const body = await read(reader);
        expect(body.aiAndSpend).toMatchObject({ state: "done", modelCall: "unknown" });
        expect(body.firstTask.canStart).toBe(true);
      }
    });
    it("an install with no gateway to ask: as before, no field", async () => {
      const body = await read();
      expect(body.aiAndSpend).toEqual({ state: "done", source: "default", companyModelSaved: false, modelBudgetUsd: null });
    });
  });
});

describe("who may read, and which company's project it is", () => {
  it("any member of the project's company reads it, with no grant on the project", async () => {
    const h = companyA();
    h.as(BEN, "s-ben");
    const body = await h.ok();
    expect(body.viewer).toEqual({ companyRole: "member", projectAdmin: false, canSkip: false });
    expect(body.project).toBe("alpha");
  });

  it("another company's project, an unknown one and a bad name are the same answer", async () => {
    const h = companyA();
    h.project("foreign", B); h.grant(ADA, "foreign", "administrator");
    h.project("legacy"); // no company named: the implicit company's
    for (const project of ["foreign", "legacy", "nothing", "%E0%A4%A", "Bad_Name", CANARY]) {
      expect(await h.call("GET", PATH(project))).toEqual(NOT_FOUND);
      expect(await h.call("PUT", SKIPS(project), { row: "linear", skipped: true })).toEqual(NOT_FOUND);
    }
    // Nothing was written for any of them.
    expect(h.db.find((item) => typeof item.pk === "string" && item.pk.includes("SETUP_SKIPS#"))).toEqual([]);
  });

  it("a person who is not in any company, and a removed member, are refused like any company route (no company named)", async () => {
    const h = companyA();
    h.as(CAT, "s-cat");
    expect((await h.call("GET", PATH())).status).toBe(401);
    h.join(CAT, A, "member");
    h.db.set({ pk: `COMPANY_MEMBER#${CAT}`, sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", personId: CAT, companyId: A, role: "member", joinedAt: TIME, revokedAt: TIME });
    const refused = await h.call("GET", PATH());
    expect(refused.status).toBe(401);
    expect(JSON.stringify(refused.body)).not.toContain("alpha");
  });

  it("a sign-in client without full access is refused before the project is read", async () => {
    const h = companyA({ fullAccess: false });
    const refused = (method: string, path: string) => ({ status: 403, body: error("FORBIDDEN", `Web App needs full access for ${method} ${path}, which is off for it; an administrator can turn it on`) });
    expect(await h.call("GET", PATH())).toEqual(refused("GET", "/v1/dev/client/projects/{project}/setup-status"));
    expect(await h.call("PUT", SKIPS(), { row: "linear", skipped: true })).toEqual(refused("PUT", "/v1/dev/client/projects/{project}/setup-status/skips"));
  });

  it("two companies: company A reads only its own records for a project, whatever company B stored under the same name", async () => {
    const h = companyA();
    h.join(CAT, B, "admin"); h.project("beta", B);
    // B's records for B's project, and (a corrupted or hostile layout) B's records filed under A's project name.
    for (const [company, name] of [[B, "beta"], [B, "alpha"]] as const) {
      const task = setupRun(h, company, name, READY({ proposal: PROPOSAL({ setup: [`echo ${CANARY}`], tests: ["npm test"] }) }), company === B && name === "alpha" ? "88888888-8888-4888-8888-888888888888" : "99999999-9999-4999-8999-999999999999");
      evalReport(h, company, name, task, "confirmed");
      setupApply(h, company, name, { state: "approved", check: "ready" });
      journal(h, company, name, task, 1, { command: `echo ${CANARY}`, exitCode: 1, tail: CANARY });
      h.db.set({ ...setupSkipsKey(company, name), entityType: "PROJECT_SETUP_SKIPS", companyId: company, project: name, skipped: ["linear", "invites", "slackChannel"], revision: 1 });
      h.db.set({ ...projectSettingsKey(company, name), entityType: "PROJECT_SETTINGS", companyId: company, projectName: name, overrides: { model_budget_usd: 99 }, revision: 1, updatedAt: TIME, updatedBy: CAT });
      realTask(h, company, name, company === B && name === "alpha" ? "6" : "7");
    }
    h.db.set({ ...modelSelectionPolicyKey(B), entityType: "MODEL_SELECTION_POLICY", orgId: B, version: 1, revision: 5, rankingVersion: "g3-v1", stepOverrides: {} });
    const seenByA = await h.ok();
    expect(JSON.stringify(seenByA)).not.toContain(CANARY);
    expect(seenByA.setupRun).toEqual({ state: "needs_you", status: "none", approval: "none" });
    expect(seenByA.evalConfirm).toEqual({ state: "needs_you", report: "none", blockedBy: "setupRun" });
    expect(seenByA.aiAndSpend).toEqual({ state: "done", source: "default", companyModelSaved: false, modelBudgetUsd: null });
    expect(seenByA.firstTask.hasTask).toBe(false);
    expect([seenByA.linear.state, seenByA.invites.state, seenByA.slackChannel.state]).toEqual(["optional", "optional", "optional"]);
    // And B's own project is B's alone.
    h.as(CAT, "s-cat");
    expect(await h.call("GET", PATH("alpha"))).toEqual(NOT_FOUND);
    const seenByB = await h.ok(PATH("beta"));
    expect(seenByB.setupRun).toMatchObject({ state: "done", approval: "approved" });
    expect(seenByB.aiAndSpend).toMatchObject({ source: "project", modelBudgetUsd: 99 });
  });

  it("two companies: company A cannot set company B's skips, and B's skip record is never read or changed", async () => {
    const h = companyA();
    h.join(CAT, B, "owner"); h.project("beta", B);
    h.db.set({ ...setupSkipsKey(B, "beta"), entityType: "PROJECT_SETUP_SKIPS", companyId: B, project: "beta", skipped: ["linear"], revision: 1 });
    const before = structuredClone(h.db.get(setupSkipsKey(B, "beta").pk, "META"));
    const logs = h.db.find((item) => item.entityType === "COMPANY_LOG").length;
    expect(await h.call("PUT", SKIPS("beta"), { row: "linear", skipped: false })).toEqual(NOT_FOUND);
    expect(await h.call("PUT", SKIPS("beta"), { row: "invites", skipped: true })).toEqual(NOT_FOUND);
    expect(h.db.get(setupSkipsKey(B, "beta").pk, "META")).toEqual(before);
    expect(h.db.find((item) => item.entityType === "COMPANY_LOG").length).toBe(logs);
    // A record filed under A's own key but naming B is refused, never applied.
    h.db.set({ ...setupSkipsKey(A, "alpha"), entityType: "PROJECT_SETUP_SKIPS", companyId: B, project: "alpha", skipped: ["linear"], revision: 1 });
    expect(await h.call("GET", PATH())).toEqual({ status: 503, body: error("RUNTIME_UNAVAILABLE", SETUP_STATUS_UNREADABLE) });
    expect(await h.call("PUT", SKIPS(), { row: "invites", skipped: true })).toEqual({ status: 503, body: error("RUNTIME_UNAVAILABLE", SETUP_STATUS_UNREADABLE) });
  });

  it("without a company layer: the install's one company, and only a person who may use the project", async () => {
    const h = harness({ companies: false });
    h.project("alpha"); h.grant(ADA, "alpha", "administrator"); h.project("closed");
    const body = await h.ok();
    expect(body.viewer).toEqual({ companyRole: null, projectAdmin: true, canSkip: true });
    expect(await h.call("GET", PATH("closed"))).toEqual(NOT_FOUND);
    expect(await h.call("PUT", SKIPS(), { row: "linear", skipped: true })).toMatchObject({ status: 200 });
    expect(h.db.get(setupSkipsKey(IMPLICIT_COMPANY_ID, "alpha").pk, "META")).toMatchObject({ companyId: IMPLICIT_COMPANY_ID, skipped: ["linear"] });
  });
});

describe("setting a skipped optional row", () => {
  it("a company owner or admin sets and clears it; the answer lists every skipped row in the table's order", async () => {
    const h = companyA();
    expect(await h.call("PUT", SKIPS(), { row: "invites", skipped: true })).toEqual({ status: 200, body: { project: "alpha", row: "invites", skipped: true, skippedRows: ["invites"] } });
    const second = await h.call("PUT", SKIPS(), { row: "slackChannel", skipped: true });
    expect(second.body).toEqual({ project: "alpha", row: "slackChannel", skipped: true, skippedRows: ["slackChannel", "invites"] });
    expect(ProjectSetupSkipResponseSchema.safeParse(second.body).success).toBe(true);
    expect((await h.ok()).slackChannel.state).toBe("skipped");
    expect((await h.call("PUT", SKIPS(), { row: "invites", skipped: false })).body).toMatchObject({ skipped: false, skippedRows: ["slackChannel"] });
    expect(await readSkips(h.db, "State", A, "alpha")).toEqual({ skipped: ["slackChannel"], revision: 3 });
    h.join(ADA, A, "owner");
    expect(await h.call("PUT", SKIPS(), { row: "linear", skipped: true })).toMatchObject({ status: 200 });
  });

  it("the project's administrator may set it though a plain company member", async () => {
    const h = companyA();
    h.grant(BEN, "alpha", "administrator");
    h.as(BEN, "s-ben");
    expect(await h.call("PUT", SKIPS(), { row: "linear", skipped: true })).toMatchObject({ status: 200 });
    expect((await h.ok()).viewer).toEqual({ companyRole: "member", projectAdmin: true, canSkip: true });
  });

  it("a member may read the checklist but not set a skip, with a fixed refusal and nothing written", async () => {
    const h = companyA();
    h.grant(BEN, "alpha", "developer");
    h.as(BEN, "s-ben");
    expect((await h.call("GET", PATH())).status).toBe(200);
    expect(await h.call("PUT", SKIPS(), { row: "linear", skipped: true })).toEqual({ status: 403, body: error("FORBIDDEN", NOT_A_SETUP_ADMIN) });
    expect(await h.call("PUT", SKIPS(), { row: CANARY, skipped: true })).toEqual({ status: 403, body: error("FORBIDDEN", NOT_A_SETUP_ADMIN) });
    expect(h.db.find((item) => typeof item.pk === "string" && item.pk.includes("SETUP_SKIPS#"))).toEqual([]);
  });

  it("each change writes an audit row naming the person, in the same transaction; a repeat writes nothing", async () => {
    const h = companyA();
    await h.call("PUT", SKIPS(), { row: "linear", skipped: true });
    const logs = () => h.db.find((item) => item.entityType === "COMPANY_LOG" && item.event === "project_setup_skip_changed");
    expect(logs()).toHaveLength(1);
    expect(logs()[0]).toMatchObject({ companyId: A, personId: ADA, projectName: "alpha", row: "linear", skipped: true });
    expect(String(logs()[0]!.pk).startsWith(`ORG#${A}#`)).toBe(true);
    const record = h.db.get(setupSkipsKey(A, "alpha").pk, "META");
    expect(await h.call("PUT", SKIPS(), { row: "linear", skipped: true })).toMatchObject({ status: 200, body: { skippedRows: ["linear"] } });
    expect(logs()).toHaveLength(1);
    expect(h.db.get(setupSkipsKey(A, "alpha").pk, "META")).toEqual(record);
    await h.call("PUT", SKIPS(), { row: "linear", skipped: false });
    expect(logs()).toHaveLength(2);
    // Clearing a mark that was never set is a repeat too.
    expect(await h.call("PUT", SKIPS(), { row: "invites", skipped: false })).toMatchObject({ status: 200, body: { skippedRows: [] } });
    expect(logs()).toHaveLength(2);
  });

  it("a change that loses a race is refused whole: no skip record change and no audit row", async () => {
    const h = companyA();
    await h.call("PUT", SKIPS(), { row: "linear", skipped: true });
    const logs = h.db.find((item) => item.entityType === "COMPANY_LOG").length;
    h.db.injectFault({ command: "TransactWriteCommand", error: { name: "TransactionCanceledException", cancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }] } });
    expect(await h.call("PUT", SKIPS(), { row: "invites", skipped: true })).toEqual({ status: 409, body: error("CHANGE_STALE", SETUP_SKIPS_STALE) });
    expect(h.db.get(setupSkipsKey(A, "alpha").pk, "META")).toMatchObject({ skipped: ["linear"], revision: 1 });
    expect(h.db.find((item) => item.entityType === "COMPANY_LOG").length).toBe(logs);
  });

  it("a stale write really is refused by the revision condition (a second writer got there first)", async () => {
    const h = companyA();
    await h.call("PUT", SKIPS(), { row: "linear", skipped: true });
    // Another writer moves the record between our read and our write.
    const real = h.db.send;
    let moved = false;
    (h.db as { send: typeof real }).send = async (command) => {
      if (!moved && (command as { constructor: { name: string } }).constructor.name === "TransactWriteCommand") {
        moved = true;
        h.db.set({ ...setupSkipsKey(A, "alpha"), entityType: "PROJECT_SETUP_SKIPS", companyId: A, project: "alpha", skipped: ["linear", "invites"], revision: 2 });
      }
      return real(command);
    };
    expect(await h.call("PUT", SKIPS(), { row: "slackChannel", skipped: true })).toEqual({ status: 409, body: error("CHANGE_STALE", SETUP_SKIPS_STALE) });
    expect(h.db.get(setupSkipsKey(A, "alpha").pk, "META")).toMatchObject({ skipped: ["linear", "invites"], revision: 2 });
  });

  it("a first write that loses a race to another first write is refused, not overwritten", async () => {
    const h = companyA();
    const real = h.db.send;
    let moved = false;
    (h.db as { send: typeof real }).send = async (command) => {
      if (!moved && (command as { constructor: { name: string } }).constructor.name === "TransactWriteCommand") {
        moved = true;
        h.db.set({ ...setupSkipsKey(A, "alpha"), entityType: "PROJECT_SETUP_SKIPS", companyId: A, project: "alpha", skipped: ["invites"], revision: 1 });
      }
      return real(command);
    };
    expect(await h.call("PUT", SKIPS(), { row: "linear", skipped: true })).toEqual({ status: 409, body: error("CHANGE_STALE", SETUP_SKIPS_STALE) });
    expect(h.db.get(setupSkipsKey(A, "alpha").pk, "META")).toMatchObject({ skipped: ["invites"], revision: 1 });
  });

  it("a member gets the fixed 403 whatever the body is, even one that is not JSON; and for a foreign project the same 404", async () => {
    const h = companyA();
    h.project("foreign", B);
    h.as(BEN, "s-ben");
    const send = async (path: string, body: string) => {
      const request = { method: "PUT", path, headers: { authorization: `Bearer ${["{\"alg\":\"none\"}", JSON.stringify(h.claims)].map((p) => Buffer.from(p).toString("base64url")).join(".")}.sig` }, requestId: "r", body };
      try { return await routeDeveloperRequest(h.deps, request, new URL(path, "https://broker.example.test")); } catch (e) { return e as AgentXError; }
    };
    const memberRefused = await send(SKIPS(), "{not json");
    expect(memberRefused).toBeInstanceOf(AgentXError);
    expect((memberRefused as AgentXError).statusCode).toBe(403);
    const foreign = await send(SKIPS("foreign"), "{not json");
    expect((foreign as AgentXError).statusCode).toBe(404);
  });

  it("refuses unknown rows, extra fields and a missing flag in fixed words that echo nothing", async () => {
    const h = companyA();
    for (const body of [{ row: "setupRun", skipped: true }, { row: "repos", skipped: true }, { row: "linear" }, { skipped: true }, { row: "linear", skipped: "yes" }, { row: "linear", skipped: true, extra: CANARY }, { row: CANARY, skipped: true }, "text", [1]]) {
      const answer = await h.call("PUT", SKIPS(), body);
      expect(answer).toEqual({ status: 400, body: error("CONFIG_INVALID", SETUP_SKIPS_BODY) });
      expect(JSON.stringify(answer.body)).not.toContain(CANARY);
    }
    expect(h.db.find((item) => typeof item.pk === "string" && item.pk.includes("SETUP_SKIPS#"))).toEqual([]);
  });

  it("a stored skip record with an unknown row or a duplicate is unreadable, never partly applied", async () => {
    const h = companyA();
    for (const skipped of [["setupRun"], ["linear", "linear"], "linear"]) {
      h.db.set({ ...setupSkipsKey(A, "alpha"), entityType: "PROJECT_SETUP_SKIPS", companyId: A, project: "alpha", skipped, revision: 1 });
      expect(await h.call("GET", PATH())).toEqual({ status: 503, body: error("RUNTIME_UNAVAILABLE", SETUP_STATUS_UNREADABLE) });
    }
  });
});

// L4-T5: a run whose worker is dead no longer reads "running" for 26 hours. A live worker talks to the broker every few seconds (and the broker notes it on the task once a minute); a run silent for
// 10 minutes reads as stopped, and a run that has not spoken yet gets an hour from its start (its machine is still being made).
describe("a setup run whose worker stopped talking (L4-T5)", () => {
  const MIN = 60_000;
  /** A run with no result, started `startedAgoMin` ago, whose worker was last heard `seenAgoMin` ago (undefined: never). */
  function runningRun(h: Harness, startedAgoMin: number, seenAgoMin: number | undefined, company = A) {
    const taskId = setupRun(h, company, "alpha", undefined);
    h.db.set({ ...(h.db.get(setupAgentKey(company, "alpha").pk, setupAgentKey(company, "alpha").sk) as object), startedAt: new Date(NOW - startedAgoMin * MIN).toISOString() });
    if (seenAgoMin !== undefined) h.db.set({ ...(h.db.get(`DEVTASK#${taskId}`, "META") as object), setupAgentSeenAt: new Date(NOW - seenAgoMin * MIN).toISOString() });
    return taskId;
  }
  const row = async (h: Harness) => (await h.ok()).setupRun;
  const STOPPED = { state: "failed", status: "failed", testOutcome: "unknown", failure: "The setup run stopped before it finished. Start it again." };

  it("a worker heard from within 10 minutes is running, however long the run has been going (a run waiting on an admin's answer for hours still polls)", async () => {
    const h = companyA();
    runningRun(h, 20 * 60, 0.25);
    expect(await row(h)).toMatchObject({ state: "running", status: "running" });
    const waiting = companyA();
    runningRun(waiting, 3, 9.9);
    expect(await row(waiting)).toMatchObject({ state: "running", status: "running" });
  });

  it("a worker silent for more than 10 minutes reads as stopped, with the fixed 'start it again' sentence, and a later word makes it run again", async () => {
    const h = companyA();
    const task = runningRun(h, 30, 10.1);
    expect(await row(h)).toMatchObject(STOPPED);
    expect(SETUP_AGENT_FAILURES.stale).toBe(STOPPED.failure);
    h.db.set({ ...(h.db.get(`DEVTASK#${task}`, "META") as object), setupAgentSeenAt: new Date(NOW - 5_000).toISOString() });
    expect(await row(h)).toMatchObject({ state: "running", status: "running" });
  });

  it("a run that never spoke gets an hour from its start, then reads as stopped", async () => {
    const early = companyA();
    runningRun(early, 59, undefined);
    expect(await row(early)).toMatchObject({ state: "running", status: "running" });
    const late = companyA();
    runningRun(late, 61, undefined);
    expect(await row(late)).toMatchObject(STOPPED);
  });

  it("the old bound still holds: a run that has gone on past its wall clock and the longest wait on an admin (with 1 hour to end) reads as stopped even if something keeps talking", async () => {
    const h = companyA();
    runningRun(h, 45 + 24 * 60 + 61, 0.1);
    expect(await row(h)).toMatchObject(STOPPED);
  });

  it("only this company's run counts: a worker's word on a task that names another company changes nothing for this company's run", async () => {
    const h = companyA();
    const mine = runningRun(h, 30, 20);
    // Another company's task carries a fresh word; this company's pointer names its own task, which stays silent.
    const theirs = "99999999-9999-4999-8999-999999999999";
    h.db.set({ pk: `DEVTASK#${theirs}`, sk: "META", entityType: "DEVELOPER_TASK", companyId: B, orgId: B, taskId: theirs, project: "alpha", purpose: "setup_agent", setupAgentSeenAt: new Date(NOW - 1_000).toISOString() });
    expect(mine).not.toBe(theirs);
    expect(await row(h)).toMatchObject(STOPPED);
    // And a pointer of this company that names the other company's task never reads as running.
    h.db.set({ ...(h.db.get(setupAgentKey(A, "alpha").pk, setupAgentKey(A, "alpha").sk) as object), taskId: theirs });
    expect(await row(h)).toMatchObject({ state: "failed", status: "failed" });
  });
});

describe("\"no evals\" for the eval confirm row (L2-5 c)", () => {
  const audits = (h: Harness) => h.db.find((row) => row.entityType === "COMPANY_LOG" && row.event === "project_setup_eval_none_changed");
  const record = (h: Harness, company = A, project = "alpha") => h.db.get(setupEvalNoneKey(company, project).pk, setupEvalNoneKey(company, project).sk);

  it("an admin confirms no evals for the finished setup run: the row is done and the first task can start; a repeat writes nothing", async () => {
    const h = companyA();
    const task = setupRun(h, A, "alpha", READY());
    setupApply(h, A, "alpha", { state: "approved", check: "ready" });
    // L4-T5: with no eval found the row is already done; the answer is still taken (and bound to the run), and wins over nothing it contradicts.
    expect((await h.ok()).evalConfirm).toEqual({ state: "done", report: "none" });
    const answer = await h.call("PUT", EVAL_NONE(), { noEvals: true });
    expect(answer).toEqual({ status: 200, body: { project: "alpha", noEvals: true, taskId: task } });
    expect(ProjectSetupEvalNoneResponseSchema.safeParse(answer.body).success).toBe(true);
    const body = await h.ok();
    expect(body.evalConfirm).toEqual({ state: "done", report: "no_evals", noEvals: { confirmedAt: new Date(NOW).toISOString() } });
    expect(body.progress.nextRequired).toBe("firstTask");
    expect(body.firstTask.canStart).toBe(true);
    expect(record(h)).toMatchObject({ entityType: "PROJECT_SETUP_EVAL_NONE", companyId: A, project: "alpha", taskId: task, revision: 1, confirmedBy: ADA });
    expect(audits(h)).toEqual([expect.objectContaining({ pk: `ORG#${A}#COMPANY_LOG`, companyId: A, personId: ADA, projectName: "alpha", noEvals: true, taskId: task })]);
    const before = JSON.stringify(h.db.find(() => true));
    expect(await h.call("PUT", EVAL_NONE(), { noEvals: true })).toEqual(answer);
    expect(JSON.stringify(h.db.find(() => true))).toBe(before);
  });

  // DEC 254zzz81 (CLIENT-ROUTES-BEFORE-ON 6): company isolation of the eval-none write. Company A's admin, with a grant on company B's same-shaped project, may not confirm "no evals" there;
  // it answers like a missing project and writes nothing in either company.
  it("another company's project (even with a grant on it), the implicit company's and an unknown one are the same 404, and nothing is written", async () => {
    const h = companyA();
    h.project("foreign", B); h.grant(ADA, "foreign", "administrator");
    const task = setupRun(h, B, "foreign", READY());
    setupApply(h, B, "foreign", { state: "approved", check: "ready" });
    expect(task).toBeDefined();
    h.project("legacy");
    for (const project of ["foreign", "legacy", "nothing", CANARY]) expect(await h.call("PUT", EVAL_NONE(project), { noEvals: true }), project).toEqual(NOT_FOUND);
    expect(record(h, B, "foreign")).toBeUndefined();
    expect(record(h, A, "foreign")).toBeUndefined();
    expect(audits(h)).toEqual([]);
  });

  it("the run's evals were found, but the person chooses none: done as no_evals, the suites still shown", async () => {
    const h = companyA();
    const task = setupRun(h, A, "alpha", READY());
    evalReport(h, A, "alpha", task, "reported");
    expect((await h.call("PUT", EVAL_NONE(), { noEvals: true })).status).toBe(200);
    expect((await h.ok()).evalConfirm).toEqual({ state: "done", report: "no_evals", suites: [{ selection: "evals/demo", questions: 2 }], noEvals: { confirmedAt: new Date(NOW).toISOString() } });
  });

  it("refused before the setup run finished with a whole proposal (none, running, failed, partial): 409, nothing written", async () => {
    for (const result of ["none", undefined, { status: "failed", stop: "attempts_used", failure: SETUP_AGENT_FAILURES.attempts_used, summary: SUMMARY({ stop: "attempts_used", partial: true }) },
      READY({ stop: "attempts_used", summary: SUMMARY({ stop: "attempts_used", partial: true }) })] as const) {
      const h = companyA();
      if (result !== "none") setupRun(h, A, "alpha", result);
      expect(await h.call("PUT", EVAL_NONE(), { noEvals: true })).toEqual({ status: 409, body: error("CHANGE_STALE", EVAL_NONE_NEEDS_SETUP) });
      expect(record(h)).toBeUndefined();
      expect(audits(h)).toEqual([]);
    }
  });

  it("refused once the run's eval is confirmed: no edit after confirmation", async () => {
    const h = companyA();
    const task = setupRun(h, A, "alpha", READY());
    evalReport(h, A, "alpha", task, "confirmed");
    expect(await h.call("PUT", EVAL_NONE(), { noEvals: true })).toEqual({ status: 409, body: error("CHANGE_STALE", EVAL_ALREADY_CONFIRMED) });
    expect(record(h)).toBeUndefined();
    // A "no evals" stored before a later confirmation never hides it: confirmed wins.
    evalReport(h, A, "alpha", task, "reported");
    expect((await h.call("PUT", EVAL_NONE(), { noEvals: true })).status).toBe(200);
    evalReport(h, A, "alpha", task, "confirmed");
    expect((await h.ok()).evalConfirm.report).toBe("confirmed");
  });

  it("a member is refused with fixed words whatever the body; the project's administrator may, though a plain member", async () => {
    const h = companyA();
    setupRun(h, A, "alpha", READY());
    h.as(BEN, "s-ben");
    for (const body of [{ noEvals: true }, { nope: 1 }, "not json"]) expect(await h.call("PUT", EVAL_NONE(), body)).toEqual({ status: 403, body: error("FORBIDDEN", NOT_AN_EVAL_ADMIN) });
    expect(record(h)).toBeUndefined();
    expect((await h.ok()).viewer.canSkip).toBe(false);
    h.grant(BEN, "alpha", "administrator");
    expect((await h.call("PUT", EVAL_NONE(), { noEvals: true })).status).toBe(200);
    expect(audits(h)[0]).toMatchObject({ personId: BEN });
    h.grant(BEN, "alpha", "developer");
    expect((await h.call("PUT", EVAL_NONE(), { noEvals: false })).status).toBe(403);
  });

  it("an owner may; a removed admin may not", async () => {
    const h = companyA();
    setupRun(h, A, "alpha", READY());
    h.join(CAT, A, "owner"); h.as(CAT, "s-cat");
    expect((await h.call("PUT", EVAL_NONE(), { noEvals: true })).status).toBe(200);
    h.db.set({ ...(h.db.get(`COMPANY_MEMBER#${ADA}`, "COMPANY") as object), revokedAt: TIME });
    h.as(ADA, "s-ada");
    expect((await h.call("PUT", EVAL_NONE(), { noEvals: false })).status).toBe(401);
    expect(record(h)).toBeDefined();
  });

  it("the answer belongs to one setup run: a newer run needs a new answer", async () => {
    const h = companyA();
    const first = setupRun(h, A, "alpha", READY());
    await h.call("PUT", EVAL_NONE(), { noEvals: true });
    const second = setupRun(h, A, "alpha", READY(), "77777777-7777-4777-8777-777777777777");
    // The first run's answer does not carry over; the new run found no eval, so the row is done by itself (L4-T5), as "none" and not as the first run's "no_evals".
    expect((await h.ok()).evalConfirm).toEqual({ state: "done", report: "none" });
    expect(await h.call("PUT", EVAL_NONE(), { noEvals: true })).toEqual({ status: 200, body: { project: "alpha", noEvals: true, taskId: second } });
    expect(record(h)).toMatchObject({ taskId: second, revision: 2 });
    expect(audits(h).map((row) => String(row.taskId)).sort()).toEqual([first, second].sort());
    expect((await h.ok()).evalConfirm.state).toBe("done");
    // A run that is still going (or failed) after the answer: not done.
    setupRun(h, A, "alpha", undefined, second);
    expect((await h.ok()).evalConfirm.state).not.toBe("done");
  });

  it("taking it back removes the answer with an audit row; taking back nothing writes nothing", async () => {
    const h = companyA();
    const task = setupRun(h, A, "alpha", READY());
    await h.call("PUT", EVAL_NONE(), { noEvals: true });
    expect(await h.call("PUT", EVAL_NONE(), { noEvals: false })).toEqual({ status: 200, body: { project: "alpha", noEvals: false, taskId: null } });
    expect(record(h)).toBeUndefined();
    expect(audits(h).map((row) => row.noEvals)).toEqual(expect.arrayContaining([true, false]));
    expect(audits(h).find((row) => row.noEvals === false)).toMatchObject({ taskId: task });
    expect((await h.ok()).evalConfirm).toEqual({ state: "done", report: "none" });
    const before = JSON.stringify(h.db.find(() => true));
    expect((await h.call("PUT", EVAL_NONE(), { noEvals: false })).status).toBe(200);
    expect(JSON.stringify(h.db.find(() => true))).toBe(before);
  });

  it("refuses unknown fields, a missing or non-boolean flag, in fixed words that echo nothing", async () => {
    const h = companyA();
    setupRun(h, A, "alpha", READY());
    for (const body of [{}, { noEvals: "true" }, { noEvals: true, extra: CANARY }, { noEvals: 1 }, [true], `{"noEvals":true,"${CANARY}":1}`]) {
      const answer = await h.call("PUT", EVAL_NONE(), typeof body === "string" ? JSON.parse(body) : body);
      expect(answer).toEqual({ status: 400, body: error("CONFIG_INVALID", EVAL_NONE_BODY) });
      expect(JSON.stringify(answer)).not.toContain(CANARY);
    }
    expect(record(h)).toBeUndefined();
  });

  it("two companies: A cannot answer for B's project, and B's answer is never read or changed", async () => {
    const h = companyA();
    h.join(CAT, B, "owner"); h.project("beta", B);
    const bTask = setupRun(h, B, "beta", READY(), "88888888-8888-4888-8888-888888888888");
    h.as(CAT, "s-cat");
    expect((await h.call("PUT", EVAL_NONE("beta"), { noEvals: true })).status).toBe(200);
    const bRecord = JSON.stringify(record(h, B, "beta"));
    h.as(ADA, "s-ada");
    expect(await h.call("PUT", EVAL_NONE("beta"), { noEvals: false })).toEqual(NOT_FOUND);
    expect(JSON.stringify(record(h, B, "beta"))).toBe(bRecord);
    // A's own project named like B's run: A's key only; a copy of B's record placed at A's key names B and is refused, never applied.
    setupRun(h, A, "alpha", READY(), bTask);
    h.db.set({ ...(record(h, B, "beta") as object), ...setupEvalNoneKey(A, "alpha") });
    expect(await h.call("GET", PATH())).toEqual({ status: 503, body: error("RUNTIME_UNAVAILABLE", SETUP_STATUS_UNREADABLE) });
    expect(await h.call("PUT", EVAL_NONE(), { noEvals: true })).toEqual({ status: 503, body: error("RUNTIME_UNAVAILABLE", SETUP_STATUS_UNREADABLE) });
    expect(audits(h).filter((row) => row.companyId === A)).toEqual([]);
  });

  it("a change that loses a race is refused whole (revision condition): no record change and no audit row", async () => {
    const h = companyA();
    setupRun(h, A, "alpha", READY());
    const original = h.db.send.bind(h.db);
    let raced = false;
    vi.spyOn(h.db, "send").mockImplementation(async (command: unknown) => {
      if (!raced && (command as { constructor: { name: string } }).constructor.name === "TransactWriteCommand") {
        raced = true;
        h.db.set({ ...setupEvalNoneKey(A, "alpha"), entityType: "PROJECT_SETUP_EVAL_NONE", companyId: A, project: "alpha", taskId: "99999999-9999-4999-8999-999999999999", revision: 1, confirmedAt: TIME, confirmedBy: CAT });
      }
      return original(command as never);
    });
    expect(await h.call("PUT", EVAL_NONE(), { noEvals: true })).toEqual({ status: 409, body: error("CHANGE_STALE", SETUP_SKIPS_STALE) });
    expect(record(h)).toMatchObject({ confirmedBy: CAT, revision: 1 });
    expect(audits(h)).toEqual([]);
  });

  it("a newer setup run or an eval confirm that lands while the answer is written: refused whole, nothing stored", async () => {
    for (const race of ["run", "confirm"] as const) {
      const h = companyA();
      const task = setupRun(h, A, "alpha", READY());
      evalReport(h, A, "alpha", task, "reported");
      const original = h.db.send.bind(h.db);
      let raced = false;
      vi.spyOn(h.db, "send").mockImplementation(async (command: unknown) => {
        if (!raced && (command as { constructor: { name: string } }).constructor.name === "TransactWriteCommand") {
          raced = true;
          if (race === "run") setupRun(h, A, "alpha", READY(), "77777777-7777-4777-8777-777777777777");
          else evalReport(h, A, "alpha", task, "confirmed");
        }
        return original(command as never);
      });
      expect(await h.call("PUT", EVAL_NONE(), { noEvals: true })).toEqual({ status: 409, body: error("CHANGE_STALE", SETUP_SKIPS_STALE) });
      expect(record(h)).toBeUndefined();
      expect(audits(h)).toEqual([]);
    }
  });

  it("a stored answer that does not read back (wrong project, bad revision, unknown kind) is a fixed 503 on read and write", async () => {
    for (const fields of [{ project: "other" }, { companyId: B }, { revision: 0 }, { revision: "1" }, { entityType: "PROJECT_SETUP_SKIPS" }, { taskId: 5 }, { confirmedAt: "Sun Nov 01 2026 09:00:00 GMT+0000 (Coordinated Universal Time)" }, { confirmedAt: "yesterday" }, { confirmedBy: "" }]) {
      const h = companyA();
      const task = setupRun(h, A, "alpha", READY());
      h.db.set({ ...setupEvalNoneKey(A, "alpha"), entityType: "PROJECT_SETUP_EVAL_NONE", companyId: A, project: "alpha", taskId: task, revision: 1, confirmedAt: TIME, confirmedBy: ADA, ...fields });
      expect(await h.call("GET", PATH())).toEqual({ status: 503, body: error("RUNTIME_UNAVAILABLE", SETUP_STATUS_UNREADABLE) });
      expect(await h.call("PUT", EVAL_NONE(), { noEvals: false })).toEqual({ status: 503, body: error("RUNTIME_UNAVAILABLE", SETUP_STATUS_UNREADABLE) });
    }
  });
});

describe("what did not change", () => {
  it("the route table keeps every existing row exactly; the three new rows are full-access only", () => {
    const added = ["GET /v1/dev/client/projects/{project}/setup-status", "PUT /v1/dev/client/projects/{project}/setup-status/skips", "PUT /v1/dev/client/projects/{project}/setup-status/eval-none", "POST /v1/dev/projects/{project}/lessons/{lessonId}/keep"];
    const rows = DEV_ROUTES.map((route) => `${route.method} ${route.path} ${route.requires}`);
    for (const row of added) expect(rows).toContain(`${row} full`);
    const existing = rows.filter((row) => !added.some((path) => row === `${path} full`));
    expect(existing).toHaveLength(DEV_ROUTES.length - 4);
    // A digest of every other row, in order: any change to an existing route fails here and must be reviewed.
    expect(createHash("sha256").update(existing.join("\n")).digest("hex")).toBe(EXISTING_ROUTES_DIGEST);
    // L4-JA7 (rule D): the pin above moved only by the four hosted knowledge-switch rows; with exactly those removed the digest is the one the table had before.
    const switchRows = existing.filter((row) => row.includes("/lessons/local-tools "));
    expect(switchRows).toEqual(["GET /v1/dev/company/lessons/local-tools full", "PUT /v1/dev/company/lessons/local-tools full", "GET /v1/dev/projects/{project}/lessons/local-tools full", "PUT /v1/dev/projects/{project}/lessons/local-tools full"]);
    expect(createHash("sha256").update(existing.filter((row) => !switchRows.includes(row)).join("\n")).digest("hex")).toBe(EXISTING_ROUTES_DIGEST_BEFORE_JA7);
  });

  it("the project read, the members route and the code settings keep their answers; other methods on the new paths are not routes", async () => {
    const h = companyA();
    h.grant(ADA, "alpha", "administrator");
    expect(await h.call("GET", "/v1/dev/client/projects/alpha")).toEqual({ status: 200, body: { name: "alpha", latestRevision: 1, access: "administrator", repositories: [{ name: "api", url: "https://github.com/acme/api", defaultBranch: "main", fullName: "acme/api" }] } });
    expect((await h.call("GET", "/v1/dev/client/projects/alpha/code-settings")).status).toBe(200);
    expect((await h.call("GET", "/v1/dev/client/projects/alpha/members")).status).toBe(200);
    for (const [method, path] of [["POST", PATH()], ["DELETE", PATH()], ["PUT", PATH()], ["GET", SKIPS()], ["POST", SKIPS()], ["DELETE", SKIPS()], ["GET", EVAL_NONE()], ["POST", EVAL_NONE()], ["DELETE", EVAL_NONE()]] as const) {
      expect((await h.call(method, path, method === "GET" ? undefined : { row: "linear", skipped: true })).status, `${method} ${path}`).toBe(404);
    }
  });

  it("reads are not writes: a status read changes no record", async () => {
    const h = companyA();
    const task = setupRun(h, A, "alpha", READY());
    evalReport(h, A, "alpha", task, "reported");
    const before = JSON.stringify(h.db.find(() => true));
    await h.ok();
    expect(JSON.stringify(h.db.find(() => true))).toBe(before);
  });
});

// The sha256 of every route row (method, path, requirement) except the setup-status rows (PR 8's two and L2-5 c's eval-none), joined by newlines, as the table stood on code/next before this change.
// Batch 10: re-pinned with the batch's 22 new rows (all added, none changed; code/next's 81 rows in the same order still give 622d8b9d...): #830/#832 GitHub connect (5),
// #836/#840 Slack install and channel (9), #835 engine model (2), #839 archive/restore (4), #837 bulk create and available repositories (2).
// DEC 254y (2), batch 12: re-pinned for #838's 7 new /v1/dev/company/linear* rows and L2-4's 3 new /v1/dev/projects/{p}/intake* rows on top of batch 10's table (all added, none
// changed). Removing exactly those 10 rows still gives 805695cd...; removing instead the 9 Slack rows gives #848's approved e616631e...; removing both gives 9c594d20....
// Batch 12 (rule D): and for #869's 6 new connected sign-in rows (/v1/dev/me/sign-ins*, /v1/dev/company/members/{personId}/sign-ins*; all added, none changed; removing exactly
// those 6 rows still gives 0a31f2f4...).
// Batch 13 (rule D): and for #855's one new row (POST /v1/dev/tasks/{taskId}/answers tasks:act; added, none changed; removing exactly that row still gives ef0ea58f...).
// L4-LP12b (rule D): one new row, POST /v1/dev/projects/{project}/lessons/{lessonId}/keep (full; the answer to the weekly list's "Keep it?" card): added, none changed, so the digest of every other row is unchanged (it still gives the value below with this row removed).
// The batch's other new rows are APP_ROUTES rows (test environment, wiki map, wiki reads, setup confirm/discard/decide), which this DEV_ROUTES digest does not cover.
// Batch 14 (rule D): and for 4 new rows: GET/POST /v1/dev/projects/{project}/machine-size (tasks:read / full; #882/#901) and GET /v1/dev/tasks/{taskId}/people/candidates,
// POST /v1/dev/tasks/{taskId}/people/add (tasks:act; #888). All added, none changed: removing exactly those 4 rows still gives 8e72149c....
// L4-MF4 (rule D): re-pinned for the one new row GET /v1/dev/me/sign-in-factors (full; added, none changed; removing exactly that row still gives 8e72149c...).
// Rule D (proof list): and for one new row (GET /v1/dev/tasks/{taskId}/evidence tasks:read, Cloud's Proof tab; added, none changed; removing exactly that row still gives 8e72149c...).
// Batch 14 combined (rule D): those two rows plus #960's GET /v1/dev/projects/{project}/lessons/measure (full). All 3 added, none changed: removing exactly those 3 rows
// still gives 425c010b... (the batch-14 table above).
// L4-GH (rule D): and for the 4 new /v1/dev/me/github* rows (GET, DELETE, POST link, POST link/claim; all added, none changed; removing exactly those 4 rows still gives 8e72149c...).
// Batch 16 (rule D): with batch 14's rows above and #975's 4 /v1/dev/me/github* rows. All added, none changed: removing exactly those 4 rows still gives e585a614... (the batch-14 combined pin).
// L4-AK1H (rule D): and for the 2 hosted team knowledge rows (POST /v1/dev/projects/{project}/lessons full, POST /v1/dev/projects/{project}/knowledge/areas full; all added, none changed; removing exactly
// those 2 rows still gives 8e72149c128813727deb3c8af95007454d20f7fb60e4762249e438a8b497ca80).
// Batch 17 (rule D): with batch 16's table and the batch's 15 new /v1/dev rows (#992 lessons areas, learning-sources and its PUT; #1003's 9 graduation, Tidy, check-draft and rule rows; #995's POST lessons and
// knowledge/areas; #994's GET company/egress-addresses). All added, none changed: removing exactly those 15 rows still gives eaf715d5... (the batch-16 pin above).
// Batch 18 (rule D): with batch 16+17's table and the batch's new /v1/dev rows (#1017 GET lessons/tuning; #1029 POST lessons/{lessonId}/keep; #1034's five Rovara skills rows (GET skills, POST lessons/{lessonId}/skill,
// PUT skills/{skill}, POST skills/{skill}/approve and /retire); #1020's POST knowledge/propose; #1036's GET and PUT me/lessons-slack; #1051's GET lessons/replay). All added, none changed, the order of every earlier row kept:
// removing exactly those 11 rows gives back the batch 16+17 pin d036ff79418d38716e0e2487692bc4bacce9e4974f24e701b257d72b36591711.
// Owner DEC 254zzz73 (rule D): re-pinned for the ONE removed row GET /v1/dev/me/sign-in-factors (full; the step-up confirmation email and passkeys, removed with the step-up). Nothing else
// changed: putting exactly that row back where it stood (after DELETE /v1/dev/company/members/{personId}/sign-ins/{method}) gives the previous pin f0b1596216b1311864017ac1cc0c52761487654d42780c6daa737e89b9ef958b.
// Batch b20 (rule D): #1075 adds GET/PUT /v1/dev/company/learning-model (full). Removing exactly those two rows gives #1086's pin f116b191b61148567f889eb123e054dae473e9d80c3a61b601445af9d6e081b8.
// L4-JA7 (rule D): re-pinned for the 4 new knowledge-switch rows (GET and PUT company/lessons/local-tools, GET and PUT projects/{project}/lessons/local-tools; all full, added, none changed, order of every earlier row kept):
// removing exactly those 4 rows gives back the pin below.
const EXISTING_ROUTES_DIGEST_BEFORE_JA7 = "ee181ef4c705b6726861ae5aa145e130adef38a4e247bce68f77dcdbaf60ad8b";
// Batch b20 (rule D): with #1095 (the 4 local-tools rows) and #1104 (GET /v1/dev/projects/{project}/lessons/weekly, full) both added: removing the 4 rows gives the BEFORE_JA7 pin, and removing the weekly row too gives a3cfc661.
const EXISTING_ROUTES_DIGEST = "9716249e9fd88c072f6459ad6c5a414acf4a3a86877530a977cb4c297bff056e";
// L4-WK (rule D): re-pinned for the one new row GET /v1/dev/projects/{project}/lessons/tuning (full; added, none changed; removing exactly that row still gives e585a614...).

// Audit gap 11c (2026-11-18): the checklist's Linear row reads the project's picked Linear team where the install wires Linear (it was a seam nobody filled, so the row never turned done).
describe("the Linear row reads the project's picked team", () => {
  it("is done with the team's id and name once the project has a pick in its own company, and optional without one", async () => {
    const h = companyA({ linear: true });
    linearConnected(h, A);
    expect((await h.ok()).linear).toEqual({ state: "optional", team: null });
    pickTeam(h, A, "alpha");
    const body = await h.ok();
    expect(body.linear).toEqual({ state: "done", team: { id: "team-1234", name: "Engineering" } });
    expect(body.progress.done).toBeGreaterThan(0);
  });

  it("never reads another company's pick, nor another project's", async () => {
    const h = companyA({ linear: true });
    linearConnected(h, A);
    pickTeam(h, B, "alpha");
    pickTeam(h, A, "beta", { project: "beta" });
    expect((await h.ok()).linear).toEqual({ state: "optional", team: null });
  });

  it("a pick filed in this company's partition that names another company is no pick; one that does not read back is the fixed unreadable answer, never a guess", async () => {
    const h = companyA({ linear: true });
    linearConnected(h, A);
    pickTeam(h, A, "alpha", { companyId: B });
    expect((await h.ok()).linear).toEqual({ state: "optional", team: null });
    pickTeam(h, A, "alpha", { teamId: "bad id with spaces" });
    expect(await h.call("GET", PATH())).toEqual({ status: 503, body: error("RUNTIME_UNAVAILABLE", SETUP_STATUS_UNREADABLE) });
  });

  it("keeps the name within the contract's bounds, and leaves out an empty one", async () => {
    const h = companyA({ linear: true });
    linearConnected(h, A);
    pickTeam(h, A, "alpha", { teamName: "N".repeat(256) });
    expect((await h.ok()).linear.team).toEqual({ id: "team-1234", name: "N".repeat(200) });
    pickTeam(h, A, "alpha", { teamName: "  " });
    expect((await h.ok()).linear.team).toEqual({ id: "team-1234" });
  });

  it("a pick whose company connection is disconnected, needs reconnecting, or missing leaves the row not done", async () => {
    const h = companyA({ linear: true });
    pickTeam(h, A, "alpha");
    expect((await h.ok()).linear).toEqual({ state: "optional", team: null });
    for (const status of ["disconnected", "needs_reconnect"] as const) {
      linearConnected(h, A, status);
      expect((await h.ok()).linear, status).toEqual({ state: "optional", team: null });
    }
    // Another company's live connection does not count for this one.
    linearConnected(h, B);
    expect((await h.ok()).linear).toEqual({ state: "optional", team: null });
    linearConnected(h, A);
    expect((await h.ok()).linear.state).toBe("done");
  });

  it("without Linear wired the row stays optional whatever is stored (today's behaviour)", async () => {
    const h = companyA();
    pickTeam(h, A, "alpha");
    expect((await h.ok()).linear).toEqual({ state: "optional", team: null });
  });
});

// Audit gap 12c (2026-11-18; DEC 254n item 3, `lifecycleAccess`): a live company owner or admin manages every project of their company, so they see and change its members without a project grant.
describe("a project's members, for a live company owner or admin without a project grant", () => {
  const MEMBERS = (project = "alpha") => `/v1/dev/client/projects/${project}/members`;
  const REFUSED = { status: 403, body: error("FORBIDDEN", CLIENT_MEMBERS_NOT_ALLOWED) };

  it("an admin and an owner of the project's company list, add and remove its members", async () => {
    for (const role of ["admin", "owner"] as const) {
      const h = companyA();
      h.join(ADA, A, role); h.join(CAT, A, "member");
      expect(await h.call("GET", MEMBERS())).toEqual({ status: 200, body: { project: "alpha", members: [] } });
      expect(await h.call("PUT", `${MEMBERS()}/${CAT}`)).toMatchObject({ status: 200, body: { project: "alpha", developerId: CAT, outcome: "granted" } });
      expect(await h.call("GET", MEMBERS())).toMatchObject({ status: 200, body: { members: [{ developerId: CAT, name: "Cat", role: "developer" }] } });
      expect(await h.call("DELETE", `${MEMBERS()}/${CAT}`)).toMatchObject({ status: 200, body: { outcome: "revoked" } });
    }
  });

  it("refuses a member, with or without a developer grant, in fixed words that do not read like a missing project", async () => {
    const h = companyA();
    h.as(BEN, "s-ben");
    expect(await h.call("GET", MEMBERS())).toEqual(REFUSED);
    h.grant(BEN, "alpha", "developer");
    expect(await h.call("GET", MEMBERS())).toEqual(REFUSED);
    expect(await h.call("PUT", `${MEMBERS()}/${CAT}`)).toEqual(REFUSED);
    expect(JSON.stringify(REFUSED.body)).not.toContain("not found");
    // The project's own administrator still manages it, as before.
    h.grant(BEN, "alpha", "administrator");
    expect((await h.call("GET", MEMBERS())).status).toBe(200);
  });

  // DEC 254zzz81 (review High): the routes are always on, so a project-admin GRANT on another company's project (or the implicit company's) counts for nothing: it reads as missing, and nothing is written.
  it("a project-admin grant on another company's project, or on one with no company, does not open its members: 404, no write", async () => {
    const h = companyA();
    h.join(ADA, A, "member");
    h.project("beta", B); h.grant(ADA, "beta", "administrator");
    h.project("legacy"); h.grant(ADA, "legacy", "administrator");
    for (const project of ["beta", "legacy"]) {
      expect(await h.call("GET", MEMBERS(project)), project).toEqual(NOT_FOUND);
      expect(await h.call("PUT", `${MEMBERS(project)}/${CAT}`), project).toEqual(NOT_FOUND);
      expect(await h.call("DELETE", `${MEMBERS(project)}/${ADA}`), project).toEqual(NOT_FOUND);
    }
    expect(h.db.find((item) => item.pk === `MEMBER#${CAT}`)).toEqual([]);
    expect(h.db.find((item) => item.pk === `MEMBER#${ADA}` && item.sk === "PROJECT#beta")).toHaveLength(1);
    // A project that does not exist reads the same (a 404 never tells another company's name apart from a missing one).
    expect(await h.call("GET", MEMBERS("nothing"))).toEqual(NOT_FOUND);
    // The same grant on the caller's own company's project still works.
    h.grant(ADA, "alpha", "administrator");
    expect((await h.call("GET", MEMBERS())).status).toBe(200);
  });

  it("refuses an owner of another company, and a project with no company (the implicit company's, never the caller's)", async () => {
    const h = companyA();
    h.join(ADA, A, "owner");
    h.project("beta", B);
    h.project("legacy");
    // DEC 254zzz81: another company's project, and one with no company, read as missing (as on every other /{project} row), no longer as a 403.
    expect(await h.call("GET", MEMBERS("beta"))).toEqual(NOT_FOUND);
    expect(await h.call("PUT", `${MEMBERS("beta")}/${CAT}`)).toEqual(NOT_FOUND);
    expect(await h.call("GET", MEMBERS("legacy"))).toEqual(NOT_FOUND);
    // Company B's owner manages B's project, and not A's.
    h.join(CAT, B, "owner");
    h.as(CAT, "s-cat");
    expect((await h.call("GET", MEMBERS("beta"))).status).toBe(200);
    expect(await h.call("GET", MEMBERS())).toEqual(NOT_FOUND);
  });

  it("refuses a removed owner, and anyone where the install has no company layer", async () => {
    const h = companyA();
    h.db.set({ pk: `COMPANY_MEMBER#${ADA}`, sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", personId: ADA, companyId: A, role: "owner", joinedAt: TIME, revokedAt: TIME });
    // A removed person's sign-in no longer resolves a company: the sign-in refusal, before any project is read.
    expect((await h.call("GET", MEMBERS())).status).toBe(401);
    const plain = harness({ companies: false });
    plain.join(ADA, A, "owner"); plain.project("alpha", A);
    expect(await plain.call("GET", MEMBERS())).toEqual(REFUSED);
  });
});
