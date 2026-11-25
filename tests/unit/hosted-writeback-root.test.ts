import { randomUUID } from "node:crypto";
// R1 + L1 6.2 (plan 0.1 #3): the ticket write-back runs on a hosted company WITHOUT lessons. The broker's core root is real (registry, runtime, milestone host, intake, the broker's own job services); only the
// deployment's adapters (the fake world) and Linear (a fake GraphQL behind the fetch seam) are stand-ins. Before this lane the ticket handlers, the chat-thread handler and the milestone sweep all lived inside
// lessons, so a company the lessons switch did not cover got no comment and no status move on its ticket and no thread notice. These are the equivalents of the A1 journeys' pinned gap
// ("nothing is written back on hosted"); that pin flips in 6.3. A real Start (an admin presses it for a ticket nobody linked) runs the real flow's start, the real `started` moment and the real handlers.
import { describe, expect, it, vi } from "vitest";
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { companyScoped, intakeItemIdOf, orgProjectCatalogKey, projectRevisionKey, type CodeMilestone, type JsonValue, type OrgId, type ProjectDefinition } from "@agentx/contracts";
import { createBrokerCoreRoot } from "../../packages/broker/src/aws/core-engine-root.js";
import { createHostedBrokerCoreServices } from "../../packages/broker/src/aws/core-job-services.js";
import { codeMilestoneItems } from "../../packages/broker/src/core/milestones/milestones.js";
import { ingestIntake } from "../../packages/broker/src/core/intake/engine.js";
import { readTicketUpdates, releaseStatusFlip } from "../../packages/broker/src/core/ticket-updates/index.js";
import { seedTicketUpdatesIfUnset } from "../../packages/broker/src/core/ticket-updates/settings.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { createFakeWorld, FAKE_COMPANY, type FakeWorld } from "../support/core-host-fakes.js";
import { coreAdapter } from "../../packages/broker/src/core-host/registry.js";
import type { Principal } from "@agentx/contracts";
import { fakeLinearWrites } from "../support/fake-linear-writes.js";

const adapters = vi.hoisted(() => ({ modules: [] as unknown[] }));
vi.mock("../../packages/broker/src/core-host/code-modules.js", () => ({ codeAdapterModules: () => adapters.modules }));
vi.mock("../../packages/broker/src/core-host/hosted-modules.js", async (original) => ({ ...await original<object>(), hostedSecurityModules: () => [] }));

const A = FAKE_COMPANY as OrgId;
const secret = Buffer.alloc(32, 7);
const MEMBER = (1).toString(16).padStart(64, "0");
const ADMIN = (2).toString(16).padStart(64, "0");
const PROJECT: ProjectDefinition = {
  name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
};
const TICKET = { system: "linear", id: "ENG-1", url: "https://linear.app/acme/issue/ENG-1/x" };
const PR = { repository: "demo", number: 7, url: "https://github.com/example/demo/pull/7" };

async function setup(options: { lessons?: string; linear?: boolean } = {}) {
  const world = createFakeWorld();
  // The company's one member, read live by the hosted identity point (the fake world's own identity names the laptop's owner only).
  const member: Principal = { companyId: A, personId: MEMBER, displayName: "Maya Lee", roles: ["member"], provider: "hosted" };
  const admin: Principal = { companyId: A, personId: ADMIN, displayName: "Ada Admin", roles: ["admin"], provider: "hosted" };
  const identity = coreAdapter({ point: "identity", name: "deployed", owner: "fake", create: () => ({
    capabilities: { interactiveSignIn: false, externalAccounts: false },
    authenticate: async () => ({ ok: false as const, reason: "refused" as const }),
    resolveExternalAccount: async () => undefined,
    getPrincipal: async (company: string, person: string) => (company === A && person === MEMBER ? member : company === A && person === ADMIN ? admin : undefined),
  }) });
  adapters.modules = world.modules.map((module) => (module.point === "identity" ? identity : module));
  const rows = new Map<string, Record<string, unknown>>();
  rows.set(`signin|COMPANY_MEMBER#${MEMBER}|COMPANY`, { pk: `COMPANY_MEMBER#${MEMBER}`, sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", personId: MEMBER, companyId: A, role: "member", joinedAt: "2026-10-01T00:00:00.000Z" });
  rows.set(`signin|${companyScoped(A, "MEMBERS")}|MEMBER#${MEMBER}`, { pk: companyScoped(A, "MEMBERS"), sk: `MEMBER#${MEMBER}`, entityType: "COMPANY_MEMBER_VIEW", personId: MEMBER, companyId: A, role: "member", joinedAt: "2026-10-01T00:00:00.000Z" });
  rows.set(`signin|COMPANY_MEMBER#${ADMIN}|COMPANY`, { pk: `COMPANY_MEMBER#${ADMIN}`, sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", personId: ADMIN, companyId: A, role: "admin", joinedAt: "2026-10-01T00:00:00.000Z" });
  rows.set(`signin|${companyScoped(A, "MEMBERS")}|MEMBER#${ADMIN}`, { pk: companyScoped(A, "MEMBERS"), sk: `MEMBER#${ADMIN}`, entityType: "COMPANY_MEMBER_VIEW", personId: ADMIN, companyId: A, role: "admin", joinedAt: "2026-10-01T00:00:00.000Z" });
  rows.set(`signin|DEVELOPER#${ADMIN}|META`, { pk: `DEVELOPER#${ADMIN}`, sk: "META", displayName: "Ada Admin" });
  rows.set(`state|ORG#${A}#MEMBER#${ADMIN}|PROJECT#payments`, { pk: `ORG#${A}#MEMBER#${ADMIN}`, sk: "PROJECT#payments", projectName: "payments", role: "developer" });
  rows.set(`signin|DEVELOPER#${MEMBER}|META`, { pk: `DEVELOPER#${MEMBER}`, sk: "META", displayName: "Maya Lee" });
  rows.set(`state|ORG#${A}#MEMBER#${MEMBER}|PROJECT#payments`, { pk: `ORG#${A}#MEMBER#${MEMBER}`, sk: "PROJECT#payments", projectName: "payments", role: "developer" });
  const client = { async send(command: unknown) {
    if (command instanceof GetCommand) {
      const { TableName, Key } = command.input as { TableName: string; Key: { pk: string; sk: string } };
      if (TableName === "signin" || TableName === "state") return { Item: rows.get(`${TableName}|${Key.pk}|${Key.sk}`) };
      return { Item: await world.store.get(Key) };
    }
    if (command instanceof QueryCommand) {
      const input = command.input as { ExpressionAttributeValues: Record<string, string> };
      const pk = input.ExpressionAttributeValues[":pk"]!;
      const items = [...rows.entries()].filter(([k]) => k.startsWith(`signin|${pk}|`)).map(([, row]) => row);
      return { Items: items, ScannedCount: items.length };
    }
    throw new Error("unexpected write");
  } };
  const linear = fakeLinearWrites();
  const wirings: Array<{ companyId: string; ticketMoments: boolean | undefined; threadMoments: boolean | undefined }> = [];
  const logs: Array<Record<string, unknown>> = [];
  const jobs = new Map<string, ReturnType<typeof createHostedBrokerCoreServices>>();
  const root = createBrokerCoreRoot({
    env: { ...(options.lessons === undefined ? {} : { ROVARA_CORE_LESSONS: options.lessons }) },
    documentClient: client, stateTableName: "state", signInTableName: "signin", callbackSigningKey: secret.toString(), repositoryGrantKey: secret,
    codeModules: () => ({}) as never, repositoryCredential: async () => { throw new Error("unused"); }, origin: () => "https://api.example", log: (entry) => logs.push(entry),
    now: () => new Date(world.clock.now), ciReporting: { honest: true, ciMode: async () => "sandbox_only" as const },
    // The broker's own job services (as aws/broker.ts builds them), over the flow the root gives it.
    services: (companyId, flow, registry, wiring) => {
      wirings.push({ companyId, ticketMoments: wiring.ticketMoments, threadMoments: wiring.threadMoments });
      const built = createHostedBrokerCoreServices({ companyId, flow, registry, ciMode: wiring.ciMode!, taskPeople: { documentClient: client, tableName: "state" }, ...(wiring.ticketMoments === true ? { ticketMoments: true } : {}), ...(wiring.notification === undefined ? {} : { notification: wiring.notification }) });
      jobs.set(companyId, built);
      return { ...built, "admission-hold-sweep": { pass: async () => ({}) } };
    },
    ...(options.linear === false ? {} : { linearIntake: {
      connections: {
        connection: async () => ({ status: "connected", organizationId: "ws-acme", urlKey: "acme" }) as never,
        accessToken: async (company: string) => `tok-${company}`,
      },
      fetch: linear.fetch,
    } }),
  });
  return { root, world, linear, wirings, logs, jobs };
}
type Setup = Awaited<ReturnType<typeof setup>>;

async function registerProject(world: FakeWorld): Promise<void> {
  await world.store.put({ item: { ...projectRevisionKey(A, PROJECT.name, PROJECT.revision), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(PROJECT)) as JsonValue } });
  await world.store.put({ item: { ...orgProjectCatalogKey(A, PROJECT.name), entityType: "PROJECT_CATALOG", latestRevision: PROJECT.revision } });
}
const job = (s: Setup, name: string) => s.root.app.handleScheduledJob({ source: "agentx.core-job", job: name });
const reportOf = (result: unknown) => (result as { companies: Array<{ companyId: string; outcome: string; report?: Record<string, unknown> }> }).companies.find((entry) => entry.companyId === A);

/** A ticket nobody linked waits; the member presses Start: a real task, as the member, bound to the ticket, with its `started` moment told. */
async function startedFromTicket(s: Setup): Promise<{ taskId: string; sessionId: string }> {
  await registerProject(s.world);
  const ports = await s.root.intake!.intakeFor(A);
  await ingestIntake(ports!, { orgId: A, project: "payments", channel: "tracker", externalRef: TICKET, title: "Refunds fail", actor: { kind: "unknown" } });
  const itemId = intakeItemIdOf(TICKET.system, TICKET.id);
  const started = await s.root.intake!.start(A, "payments", itemId, MEMBER);
  if (started.outcome !== "started") throw new Error(`the ticket did not start: ${JSON.stringify(started)}`);
  return { taskId: started.taskId, sessionId: started.sessionId! };
}

describe("a company without lessons has its own milestone host, with the ticket handlers on it", () => {
  it("a company with Linear gets the host (the flow's slot is filled) whether or not lessons are on; a company with no handler to register gets none", async () => {
    for (const lessons of [undefined, "on"]) {
      const s = await setup({ ...(lessons === undefined ? {} : { lessons }) });
      const runtime = await s.root.app.runtimeFor(A);
      expect(runtime.flow.deps.milestones, `lessons ${String(lessons)}`).toBeDefined();
    }
    const bare = await setup({ linear: false });
    expect((await bare.root.app.runtimeFor(A)).flow.deps.milestones).toBeUndefined();
  });

  it("the ticket's moments are written for the company's sessions only where the write-back is wired (the services builder is told)", async () => {
    const withLinear = await setup();
    await withLinear.root.app.runtimeFor(A);
    expect(withLinear.wirings).toEqual([{ companyId: A, ticketMoments: true, threadMoments: undefined }]);
    const bare = await setup({ linear: false });
    await bare.root.app.runtimeFor(A);
    expect(bare.wirings).toEqual([{ companyId: A, ticketMoments: false, threadMoments: undefined }]);
  });
});

describe("an admin starts a waiting ticket and the ticket is written back: comment and status, with lessons OFF", () => {
  it("started: In Progress and a comment; plan ready (the real session sweep): a comment; pull request: In Review; merged: Done; each once, however often the sweeps run", async () => {
    const s = await setup();
    // The project's first team pick seeds the settings (the real seed: the whole conversation, status moves ON).
    await registerProject(s.world);
    await s.root.intake!.seedTicketUpdates(A, "payments", MEMBER);
    expect((await readTicketUpdates({ store: s.world.store, now: () => s.world.clock.now }, A, "payments")).settings).toMatchObject({ changeStatus: true, level: "full" });
    const { taskId } = await startedFromTicket(s);
    expect(s.linear.stateOf(A, "ENG-1")).toBe("In Progress");
    expect(s.linear.commentsOf(A).length).toBeGreaterThan(0);

    // The plan waits for review: the real session sweep writes the ticket's own `plan_ready` moment (the ticket write-back is wired, so it does).
    const record = (await s.world.store.get(taskKey(taskId)))! as unknown as Record<string, unknown> & { workflow: Record<string, unknown> };
    await s.world.store.put({ item: { ...record, workflow: { ...record.workflow, stage: "PLAN_REVIEW", state: "WAITING" } } as never });
    s.world.clock.advance(120);
    await job(s, "session-sweep");
    const runtime = await s.root.app.runtimeFor(A);
    // The ticket's thread says so, once (the thread's own reply for the plan, written only because the ticket's own moments are wired).
    expect(s.linear.commentsOf(A).filter((entry) => entry.parent !== undefined && entry.body.startsWith("Plan ready for review"))).toHaveLength(1);

    // The pull request and the merge, as the merge tracking writes them, on the company's own milestone host.
    const milestones = runtime.flow.deps.milestones!;
    const at = () => new Date(s.world.clock.now).toISOString();
    const write = async (milestone: CodeMilestone, n: number) => { await runtime.flow.deps.store.transact(codeMilestoneItems(milestone, n, { definitionVersion: "1.1.0" })); await milestones.deliver(taskId); };
    s.world.clock.advance(120);
    await write({ kind: "pr_ready", orgId: A, taskId, at: at(), text: "ready", pullRequests: [PR] }, 1);
    s.world.clock.advance(120);
    await write({ kind: "merged", orgId: A, taskId, at: at(), text: "merged" }, 1);
    expect(s.linear.moves(A)).toEqual(["In Progress", "In Review", "Done"]);
    expect(s.linear.stateOf(A, "ENG-1")).toBe("Done");

    // The scheduled sweeps (the job that now carries the milestone retry), run many times: nothing is written again.
    const written = s.linear.writes.length;
    for (let pass = 0; pass < 3; pass += 1) { s.world.clock.advance(600); expect(reportOf(await job(s, "notify-deliver"))?.outcome).toBe("ran"); }
    expect(s.linear.writes).toHaveLength(written);
    // No lessons job exists for this company: nothing here depended on it.
    expect(reportOf(await job(s, "lessons"))?.report).toMatchObject({ skipped: "service_not_wired" });
  });

  it("a Linear outage while the work goes is retried by the notices job (the home of the milestone sweep) and the comment lands once", async () => {
    const s = await setup();
    await registerProject(s.world);
    await s.root.intake!.seedTicketUpdates(A, "payments", MEMBER);
    s.linear.fail("issueUpdate", "server_error", 1);
    s.linear.fail("commentCreate", "server_error", 2);
    await startedFromTicket(s);
    // The start itself is never failed by the ticket: the task is real and the write has not landed yet.
    expect(s.linear.writes).toEqual([]);
    const sweep = async () => { s.world.clock.advance(15 * 60); return reportOf(await job(s, "notify-deliver"))?.report; };
    expect(await sweep()).toMatchObject({ milestones: 1 });
    expect(await sweep()).toMatchObject({ milestones: 1 });
    expect(await sweep()).toMatchObject({ milestones: 1 });
    expect(s.linear.moves(A)).toEqual(["In Progress"]);
    expect(s.linear.commentsOf(A).length).toBeGreaterThan(0);
    const written = s.linear.writes.length;
    expect(await sweep()).toMatchObject({ milestones: 0 });
    expect(s.linear.writes).toHaveLength(written);
  });

  it("the seeded status default is turned on once by the notices job, only after the operator's go, for a project nobody chose for, and a person's saved choice is left alone", async () => {
    const s = await setup();
    await registerProject(s.world);
    const table = { store: s.world.store, now: () => s.world.clock.now };
    await seedTicketUpdatesIfUnset(table, { orgId: A, project: "payments", settings: { comments: true, changeStatus: false, statuses: { started: "In Progress", pr_opened: "In Review", merged: "Done" }, level: "full" }, by: "owner" });
    await job(s, "session-sweep");
    // The company is served by the schedules once it has a task on the core.
    await startedFromTicket(s).catch(() => undefined);
    s.world.clock.advance(600);
    // Controller decision 2026-11-24: nothing is flipped until the operator writes the company's go row.
    await job(s, "notify-deliver");
    expect(await readTicketUpdates(table, A, "payments")).toMatchObject({ revision: 1, settings: { changeStatus: false } });
    expect(s.world.audit.filter((event) => event.action === "ticket_updates.status_default_on")).toHaveLength(0);
    await releaseStatusFlip(table, A, "operator");
    s.world.clock.advance(600);
    await job(s, "notify-deliver");
    expect(await readTicketUpdates(table, A, "payments")).toMatchObject({ revision: 2, requestId: "dec-254zzz463-status-default", settings: { changeStatus: true, level: "full" } });
    const flips = s.world.audit.filter((event) => event.action === "ticket_updates.status_default_on");
    expect(flips).toHaveLength(1);
    s.world.clock.advance(600);
    await job(s, "notify-deliver");
    expect(s.world.audit.filter((event) => event.action === "ticket_updates.status_default_on")).toHaveLength(1);
  });
});

describe("the waiting list and Start are at the one /v1/app address on the real core root (R1 + L1 6.2b)", () => {
  it("an unlinked person's ticket waits; a company admin who may start sees it with canStart and the words, starts it as themselves, and the ticket is written back; a plain member is refused", async () => {
    const s = await setup();
    await registerProject(s.world);
    await s.root.intake!.seedTicketUpdates(A, "payments", ADMIN);
    const ports = await s.root.intake!.intakeFor(A);
    await ingestIntake(ports!, { orgId: A, project: "payments", channel: "tracker", externalRef: TICKET, title: "Refunds fail", actor: { kind: "unknown" } });
    const call = async (person: string, method: string, path: string, body?: unknown) => {
      const answer = await s.root.coreTasks!.route({ method, path, headers: {}, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, { developerId: person, sessionId: "s", name: person });
      return { status: answer!.statusCode, body: JSON.parse(answer!.body) as Record<string, unknown> };
    };
    const list = "/v1/app/projects/payments/intake";
    // A plain member of the project is not its admin: the fixed refusal, and nothing about the ticket.
    expect((await call(MEMBER, "GET", list)).status).toBe(403);
    expect((await call("nobody", "GET", list)).status).toBe(401);
    const seen = await call(ADMIN, "GET", list);
    expect(seen.status).toBe(200);
    expect(seen.body.items).toEqual([expect.objectContaining({ id: "ENG-1", reason: "outsider", canStart: true, canDismiss: true, reasonWords: expect.any(String) as string })]);
    const itemId = (seen.body.items as Array<{ itemId: string }>)[0]!.itemId;
    expect((await call(MEMBER, "POST", `${list}/${itemId}/start`, { requestId: randomUUID() })).status).toBe(403);
    expect(s.linear.writes).toEqual([]);
    const started = await call(ADMIN, "POST", `${list}/${itemId}/start`, { requestId: randomUUID() });
    expect(started.body).toMatchObject({ started: true });
    // The task is the admin's, and the ticket is written back (comment and In Progress) with lessons off.
    expect(s.linear.stateOf(A, "ENG-1")).toBe("In Progress");
    expect(s.linear.commentsOf(A).length).toBeGreaterThan(0);
    expect((await call(ADMIN, "GET", list)).body.items).toEqual([]);
  });
});
