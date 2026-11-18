// Lead 2 L2-4: the hosted intake's wiring in the broker's core root (aws/core-engine-root.ts), over the real root, registry and runtime with fake deployment adapters (as
// core-team-context.test.ts does): intake only for a company whose new tasks start on the core, the ticket-only session start extras, and the write-back on the company's milestones.
import { describe, expect, it, vi } from "vitest";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import type { OrgId, Principal } from "@agentx/contracts";
import { createBrokerCoreRoot } from "../../packages/broker/src/aws/core-engine-root.js";
import { ticketSessionStartExtras } from "../../packages/broker/src/aws/hosted-intake.js";
import { createFakeWorld, FAKE_COMPANY } from "../support/core-host-fakes.js";

const adapters = vi.hoisted(() => ({ modules: [] as unknown[] }));
vi.mock("../../packages/broker/src/core-host/code-modules.js", () => ({ codeAdapterModules: () => adapters.modules }));
vi.mock("../../packages/broker/src/core-host/hosted-modules.js", async (original) => ({ ...await original<object>(), hostedSecurityModules: () => [] }));

const A = FAKE_COMPANY as OrgId;
const B = "org_corehost00000000000b" as OrgId;
const secret = Buffer.alloc(32, 7);
const principal: Principal = { companyId: A, personId: "owner-a", displayName: "Owner", roles: ["member"], provider: "hosted" };
const ticket = { system: "linear", id: "ENG-1", url: "https://linear.app/acme/issue/ENG-1/x" };

function root(env: NodeJS.ProcessEnv, options: { linear?: boolean } = {}) {
  const world = createFakeWorld();
  adapters.modules = world.modules;
  const client = { async send(command: unknown) {
    if (!(command instanceof GetCommand)) throw new Error("unexpected write");
    return { Item: undefined };
  } };
  const accessToken = vi.fn(async () => "never-used");
  const built = createBrokerCoreRoot({
    env, documentClient: client, stateTableName: "state", signInTableName: "signin", callbackSigningKey: secret.toString(), repositoryGrantKey: secret,
    codeModules: () => ({}) as never, repositoryCredential: async () => { throw new Error("unused"); }, origin: () => "https://api.example", log: () => undefined,
    now: () => new Date(world.clock.now), ciReporting: { honest: true, ciMode: async () => "sandbox_only" as const },
    services: () => Object.fromEntries(["merge-tracking", "session-sweep", "notify-deliver", "admission-hold-sweep"].map((name) => [name, { pass: async () => ({}) }])),
    lessonsPeople: () => ({ approvers: async () => ({ complete: true, membershipVersion: 1, ownerIds: [], eligibleIds: [], lastEligibleLossAtMs: null }), onProjectRoster: async () => true, linkedAccounts: async () => [], displayName: async () => "Member", isErased: async () => false }),
    ...(options.linear === false ? {} : { linearIntake: { connections: { connection: async () => undefined, accessToken } } }),
  });
  return { root: built, accessToken };
}
const extrasInput = (withTicket: boolean) => ({ taskId: "11111111-1111-4111-8111-111111111111", project: "payments", title: "t", principal, client: "web", receivedAt: "2026-11-17T00:00:00.000Z", ...(withTicket ? { ticket } : {}) });

describe("the core root's hosted intake", () => {
  it("is not built while the switch is off, its settings are unreadable, or Linear is not wired", () => {
    expect(root({ ROVARA_CORE_ENGINE: "off" }).root.intake).toBeUndefined();
    expect(root({ ROVARA_CORE_ENGINE: "on", ROVARA_CORE_ALLOWED_COMPANIES: "none" }).root.intake).toBeUndefined();
    expect(root({ ROVARA_CORE_ENGINE: "on", ROVARA_CORE_ALLOWED_COMPANIES: "all" }, { linear: false }).root.intake).toBeUndefined();
    expect(root({ ROVARA_CORE_ENGINE: "on", ROVARA_CORE_ALLOWED_COMPANIES: "all" }).root.intake).toBeDefined();
  });

  it("gives intake only to a company whose new tasks start on the core; another company's runtime is never built for it", async () => {
    const { root: built } = root({ ROVARA_CORE_ENGINE: `on:${A}`, ROVARA_CORE_ALLOWED_COMPANIES: "all" });
    const runtimeFor = vi.spyOn(built.app, "runtimeFor");
    expect(await built.intake!.intakeFor(B)).toBeUndefined();
    expect(runtimeFor).not.toHaveBeenCalled();
    expect(await built.intake!.waiting(B, "payments")).toEqual({ items: [], sources: [] });
    expect(await built.intake!.intakeFor(A)).toBeDefined();
    expect(runtimeFor.mock.calls.map(([companyId]) => companyId)).toEqual([A]);
  });

  it("a start with a ticket writes its session and binding in its own transaction; a start without one gets nothing added", async () => {
    const { root: built } = root({ ROVARA_CORE_ENGINE: "on", ROVARA_CORE_ALLOWED_COMPANIES: "all" });
    const extras = (await built.app.runtimeFor(A)).flow.deps.startExtras!;
    const plain = extras(extrasInput(false));
    const withTicket = extras(extrasInput(true));
    expect(plain.sessionId).toBeUndefined();
    expect(withTicket.sessionId).toMatch(/^ses_/u);
    // The ticket's items come in addition to exactly the items a plain start carries.
    expect(withTicket.items.length).toBeGreaterThan(plain.items.length);
    expect(JSON.stringify(plain.items)).not.toContain("SESSION");
    expect(JSON.stringify(withTicket.items)).toContain("ENG-1");
    // Without Linear wired, a ticket start is exactly a plain start (nothing hosted adds sessions).
    const { root: unwired } = root({ ROVARA_CORE_ENGINE: "on", ROVARA_CORE_ALLOWED_COMPANIES: "all" }, { linear: false });
    expect((await unwired.app.runtimeFor(A)).flow.deps.startExtras!(extrasInput(true)).sessionId).toBeUndefined();
  });

  it("ticketSessionStartExtras adds nothing to a start without a ticket", () => {
    expect(ticketSessionStartExtras(A)(extrasInput(false))).toEqual({ items: [] });
    const withTicket = ticketSessionStartExtras(A)(extrasInput(true));
    expect(withTicket.sessionId).toMatch(/^ses_/u);
    expect(JSON.stringify(withTicket.items)).toContain(A);
    expect(JSON.stringify(withTicket.items)).not.toContain(B);
  });

  it("registers the ticket write-back on the company's milestones, only where Linear is wired", async () => {
    const handler = { name: "ticket_updates", on: async () => undefined };
    const { root: built } = root({ ROVARA_CORE_ENGINE: "on", ROVARA_CORE_ALLOWED_COMPANIES: "all", ROVARA_CORE_LESSONS: "on" });
    const milestones = (await built.app.runtimeFor(A)).flow.deps.milestones as unknown as { register(h: typeof handler): () => void };
    expect(() => milestones.register(handler)).toThrow("already registered");
    const { root: unwired } = root({ ROVARA_CORE_ENGINE: "on", ROVARA_CORE_ALLOWED_COMPANIES: "all", ROVARA_CORE_LESSONS: "on" }, { linear: false });
    const plain = (await unwired.app.runtimeFor(A)).flow.deps.milestones as unknown as { register(h: typeof handler): () => void };
    expect(() => plain.register(handler)).not.toThrow();
  });

  it("L4-LP2: hooks the task log (answers, questions and decisions told to the ticket thread) and registers its handler beside the write-back, only where Linear and lessons are wired", async () => {
    const taskLogHandler = { name: "task_log", on: async () => undefined };
    const wired = root({ ROVARA_CORE_ENGINE: "on", ROVARA_CORE_ALLOWED_COMPANIES: "all", ROVARA_CORE_LESSONS: "on" }).root;
    const runtime = await wired.app.runtimeFor(A);
    expect(runtime.flow.deps.taskLog).toBeDefined();
    const milestones = runtime.flow.deps.milestones as unknown as { register(h: typeof taskLogHandler): () => void };
    expect(() => milestones.register(taskLogHandler)).toThrow("already registered");
    // Each company gets its own hook: B's flow is not told of A's tasks.
    const other = await wired.app.runtimeFor(B);
    expect(other.flow.deps.taskLog).toBeDefined();
    expect(other.flow.deps.taskLog).not.toBe(runtime.flow.deps.taskLog);
    // No Linear write-back: the flow is as before (no hook, no log handler).
    const unwired = (await root({ ROVARA_CORE_ENGINE: "on", ROVARA_CORE_ALLOWED_COMPANIES: "all", ROVARA_CORE_LESSONS: "on" }, { linear: false }).root.app.runtimeFor(A)).flow.deps;
    expect(unwired.taskLog).toBeUndefined();
    expect(() => (unwired.milestones as unknown as { register(h: typeof taskLogHandler): () => void }).register(taskLogHandler)).not.toThrow();
    // No lessons: no company milestones, so nothing here is built either.
    expect((await root({ ROVARA_CORE_ENGINE: "on", ROVARA_CORE_ALLOWED_COMPANIES: "all" }).root.app.runtimeFor(A)).flow.deps.taskLog).toBeUndefined();
  });
});
