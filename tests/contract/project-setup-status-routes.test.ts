// Guided onboarding PR 8: `GET /v1/dev/client/projects/{project}/setup-status` and `PUT .../setup-status/skips`.
// Each row's state comes from fixture records; two companies never read or change each other's project; a member reads but cannot set skips; the existing route table is unchanged.
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  AgentXError, IMPLICIT_COMPANY_ID, ProjectSetupChecklistSchema, ProjectSetupEvalNoneResponseSchema, ProjectSetupSkipResponseSchema, SETUP_STATUS_ROWS, evalCommandFingerprintOf, workspaceProjectIndexValue,
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
import { SETUP_AGENT_FAILURES } from "../../packages/broker/src/core/setup-agent/agent.js";
import { evalDiscoveryDigest, evalDiscoveryKey } from "../../packages/broker/src/core/setup-agent/eval-discovery.js";
import { journalKey, setupAgentKey } from "../../packages/broker/src/core/setup-agent/keys.js";
import { modelSelectionPolicyKey } from "../../packages/broker/src/core/model-selection/policy-store.js";
import { workspacePartition } from "../../packages/broker/src/core/task-flow/keys.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

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
interface HarnessOptions { companies?: boolean; fullAccess?: boolean }

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
      issuer: "https://signin.example.test", env: "test", methods: { slack: true, oidc: true }, signInTableName: "SignIn", clientRoutes: true, slackTeamId: TEAM,
      verifyAccessToken: async () => claims, channelMembers: async (request) => ({ ok: true, memberOf: request.channelIds }),
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
    expect(body.setupRun).toEqual({ state: "needs_you", status: "none" });
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
    expect((await h.ok()).setupRun).toEqual({ state: "running", status: "running", startedAt: new Date(NOW - 120_000).toISOString() });
  });

  it("setup run: ready is done, with the commands found, time, cost and the test outcome from the run's own journal", async () => {
    const h = companyA();
    const task = setupRun(h, A, "alpha", READY());
    journal(h, A, "alpha", task, 1, { command: "npm ci" });
    journal(h, A, "alpha", task, 2, { command: "npm test", exitCode: 0 });
    const run = (await h.ok()).setupRun;
    expect(run).toEqual({
      state: "done", status: "ready", startedAt: new Date(NOW - 120_000).toISOString(), elapsedMs: 91_000, costCents: 37, commandsRun: 4, partial: false, stop: "proposed",
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
    expect((await h.ok()).setupRun).toEqual({ state: "needs_you", status: "none" });
  });

  it("setup run: a timed-out command is the failing one; a failed run with no journal has none", async () => {
    const h = companyA();
    const task = setupRun(h, A, "alpha", { status: "failed", stop: "infrastructure", failure: SETUP_AGENT_FAILURES.infrastructure });
    expect((await h.ok()).setupRun).toEqual({ state: "failed", status: "failed", startedAt: new Date(NOW - 120_000).toISOString(), testOutcome: "unknown", failure: SETUP_AGENT_FAILURES.infrastructure });
    journal(h, A, "alpha", task, 1, { command: "npm ci", exitCode: null, timedOut: true, tail: "still going" });
    expect((await h.ok()).setupRun.failedCommand).toEqual({ n: 1, command: "npm ci", exitCode: null, timedOut: true, lastLines: ["still going"] });
  });

  it("setup run: a stored proposal that no longer parses counts as no commands, never a guess", async () => {
    const h = companyA();
    setupRun(h, A, "alpha", READY({ proposal: { version: 2, setup: "nope" } }));
    const run = (await h.ok()).setupRun;
    expect(run.state).toBe("done");
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
    expect((await h.ok()).firstTask.canStart).toBe(false);
    evalReport(h, A, "alpha", task, "confirmed");
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
      journal(h, company, name, task, 1, { command: `echo ${CANARY}`, exitCode: 1, tail: CANARY });
      h.db.set({ ...setupSkipsKey(company, name), entityType: "PROJECT_SETUP_SKIPS", companyId: company, project: name, skipped: ["linear", "invites", "slackChannel"], revision: 1 });
      h.db.set({ ...projectSettingsKey(company, name), entityType: "PROJECT_SETTINGS", companyId: company, projectName: name, overrides: { model_budget_usd: 99 }, revision: 1, updatedAt: TIME, updatedBy: CAT });
      realTask(h, company, name, company === B && name === "alpha" ? "6" : "7");
    }
    h.db.set({ ...modelSelectionPolicyKey(B), entityType: "MODEL_SELECTION_POLICY", orgId: B, version: 1, revision: 5, rankingVersion: "g3-v1", stepOverrides: {} });
    const seenByA = await h.ok();
    expect(JSON.stringify(seenByA)).not.toContain(CANARY);
    expect(seenByA.setupRun).toEqual({ state: "needs_you", status: "none" });
    expect(seenByA.evalConfirm).toEqual({ state: "needs_you", report: "none", blockedBy: "setupRun" });
    expect(seenByA.aiAndSpend).toEqual({ state: "done", source: "default", companyModelSaved: false, modelBudgetUsd: null });
    expect(seenByA.firstTask.hasTask).toBe(false);
    expect([seenByA.linear.state, seenByA.invites.state, seenByA.slackChannel.state]).toEqual(["optional", "optional", "optional"]);
    // And B's own project is B's alone.
    h.as(CAT, "s-cat");
    expect(await h.call("GET", PATH("alpha"))).toEqual(NOT_FOUND);
    const seenByB = await h.ok(PATH("beta"));
    expect(seenByB.setupRun.state).toBe("done");
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

describe("\"no evals\" for the eval confirm row (L2-5 c)", () => {
  const audits = (h: Harness) => h.db.find((row) => row.entityType === "COMPANY_LOG" && row.event === "project_setup_eval_none_changed");
  const record = (h: Harness, company = A, project = "alpha") => h.db.get(setupEvalNoneKey(company, project).pk, setupEvalNoneKey(company, project).sk);

  it("an admin confirms no evals for the finished setup run: the row is done and the first task can start; a repeat writes nothing", async () => {
    const h = companyA();
    const task = setupRun(h, A, "alpha", READY());
    expect((await h.ok()).evalConfirm).toEqual({ state: "needs_you", report: "none" });
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
    expect((await h.ok()).evalConfirm).toEqual({ state: "needs_you", report: "none" });
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
    expect((await h.ok()).evalConfirm).toEqual({ state: "needs_you", report: "none" });
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
    const added = ["GET /v1/dev/client/projects/{project}/setup-status", "PUT /v1/dev/client/projects/{project}/setup-status/skips", "PUT /v1/dev/client/projects/{project}/setup-status/eval-none"];
    const rows = DEV_ROUTES.map((route) => `${route.method} ${route.path} ${route.requires}`);
    for (const row of added) expect(rows).toContain(`${row} full`);
    const existing = rows.filter((row) => !added.some((path) => row === `${path} full`));
    expect(existing).toHaveLength(DEV_ROUTES.length - 3);
    // A digest of every other row, in order: any change to an existing route fails here and must be reviewed.
    expect(createHash("sha256").update(existing.join("\n")).digest("hex")).toBe(EXISTING_ROUTES_DIGEST);
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
// The batch's other new rows are APP_ROUTES rows (test environment, wiki map, wiki reads, setup confirm/discard/decide), which this DEV_ROUTES digest does not cover.
// Batch 14 (rule D): and for 4 new rows: GET/POST /v1/dev/projects/{project}/machine-size (tasks:read / full; #882/#901) and GET /v1/dev/tasks/{taskId}/people/candidates,
// POST /v1/dev/tasks/{taskId}/people/add (tasks:act; #888). All added, none changed: removing exactly those 4 rows still gives 8e72149c....
// L4-MF4 (rule D): re-pinned for the one new row GET /v1/dev/me/sign-in-factors (full; added, none changed; removing exactly that row still gives 8e72149c...).
// Rule D (proof list): and for one new row (GET /v1/dev/tasks/{taskId}/evidence tasks:read, Cloud's Proof tab; added, none changed; removing exactly that row still gives 8e72149c...).
// Batch 14 combined (rule D): those two rows plus #960's GET /v1/dev/projects/{project}/lessons/measure (full). All 3 added, none changed: removing exactly those 3 rows
// still gives 425c010b... (the batch-14 table above).
// L4-AK1H (rule D): and for the 2 hosted team knowledge rows (POST /v1/dev/projects/{project}/lessons full, POST /v1/dev/projects/{project}/knowledge/areas full; all added, none changed; removing exactly
// those 2 rows still gives e585a6143bf06e59b70b86b207dec41c343aee0253436308d29fe83771fa8b9c).
const EXISTING_ROUTES_DIGEST = "TODO_DIGEST";
