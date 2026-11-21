// Audit gap 11b: the ticket-sharing settings route's wiring in the broker's core root (aws/core-engine-root.ts), over the real root, registry, runtime and dev routes with fake deployment adapters
// (as hosted-intake-root.test.ts does). The route is reached through the root's own /v1/app entry, with the caller's company and role read from the sign-in table's membership row, never a claim;
// without this wiring the path would answer "not on the core yet".
import { describe, expect, it, vi } from "vitest";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { DEFAULT_TICKET_UPDATES, type OrgId } from "@agentx/contracts";
import { createBrokerCoreRoot, HOSTED_TICKET_TRACKERS } from "../../packages/broker/src/aws/core-engine-root.js";
import { NOT_ON_THE_CORE_YET } from "../../packages/broker/src/core-host/dev-routes.js";
import { readTicketUpdates } from "../../packages/broker/src/core/ticket-updates/settings.js";
import type { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createFakeWorld, FAKE_COMPANY } from "../support/core-host-fakes.js";
import { projectStore } from "../support/test-env-world.js";

const adapters = vi.hoisted(() => ({ modules: [] as unknown[] }));
vi.mock("../../packages/broker/src/core-host/code-modules.js", () => ({ codeAdapterModules: () => adapters.modules }));
vi.mock("../../packages/broker/src/core-host/hosted-modules.js", async (original) => ({ ...await original<object>(), hostedSecurityModules: () => [] }));

const A = FAKE_COMPANY as OrgId;
const B = "org_corehost00000000000b" as OrgId;
const secret = Buffer.alloc(32, 7);
const members: Record<string, { companyId: OrgId; role: string }> = { "owner-a": { companyId: A, role: "owner" }, "member-a": { companyId: A, role: "member" }, "owner-b": { companyId: B, role: "owner" } };

async function root() {
  const world = createFakeWorld();
  adapters.modules = world.modules;
  await projectStore(A, "payments", { store: world.store as MemoryDocumentStore });
  const client = { async send(command: unknown) {
    if (!(command instanceof GetCommand)) throw new Error("unexpected write");
    const input = command.input as { TableName: string; Key: { pk: string; sk: string } };
    const person = /^COMPANY_MEMBER#(.+)$/u.exec(input.Key.pk)?.[1];
    if (input.TableName === "signin" && person !== undefined && members[person] !== undefined) {
      return { Item: { pk: input.Key.pk, sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", personId: person, ...members[person], joinedAt: "2026-11-01T00:00:00.000Z" } };
    }
    return { Item: undefined };
  } };
  const built = createBrokerCoreRoot({
    env: {}, documentClient: client, stateTableName: "state", signInTableName: "signin", callbackSigningKey: secret.toString(), repositoryGrantKey: secret,
    codeModules: () => ({}) as never, repositoryCredential: async () => { throw new Error("unused"); }, origin: () => "https://api.example", log: () => undefined,
    now: () => new Date(world.clock.now), ciReporting: { honest: true, ciMode: async () => "sandbox_only" as const },
    services: () => Object.fromEntries(["merge-tracking", "session-sweep", "notify-deliver", "admission-hold-sweep"].map((name) => [name, { pass: async () => ({}) }])),
  });
  const call = async (person: string, method: string, body?: unknown) => {
    const answer = await built.coreTasks!.route({ method, path: "/v1/app/projects/payments/intake/updates", headers: {}, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, { developerId: person, sessionId: "s", name: person });
    return { status: answer!.statusCode, body: JSON.parse(answer!.body) as Record<string, unknown> };
  };
  return { world, call };
}

describe("the core root's ticket-sharing settings route", () => {
  it("serves the route (never 'not on the core yet') with Linear as the tracker, for a live owner of the project's company", async () => {
    expect(HOSTED_TICKET_TRACKERS).toEqual(["linear"]);
    const { call } = await root();
    const got = await call("owner-a", "GET");
    expect(got).toEqual({ status: 200, body: { settings: { ...DEFAULT_TICKET_UPDATES }, canEdit: true, access: [{ tracker: "linear", state: "ok" }] } });
    expect(JSON.stringify(got.body)).not.toContain(NOT_ON_THE_CORE_YET);
  });

  it("saves into the company's own core store (the rows the ticket write-back reads), as the live owner", async () => {
    const { world, call } = await root();
    const settings = { comments: true, changeStatus: false, statuses: {}, level: "decisions" };
    expect(await call("owner-a", "PUT", { requestId: "6f9d0c1e-2b3a-4c5d-8e7f-001122334455", settings })).toMatchObject({ status: 200, body: { settings, canEdit: true } });
    expect((await readTicketUpdates({ store: world.store, now: () => world.clock.now }, A, "payments")).settings).toEqual(settings);
    expect(world.audit.filter((event) => event.action === "ticket_updates.changed")).toHaveLength(1);
  });

  it("refuses a plain member with no grant (the project reads as missing) and another company's owner, from live membership", async () => {
    const { world, call } = await root();
    expect(await call("member-a", "GET")).toEqual({ status: 404, body: { error: { code: "NOT_FOUND", message: "project not found" } } });
    expect((await call("owner-b", "GET")).status).toBe(404);
    expect((await call("owner-b", "PUT", { requestId: "6f9d0c1e-2b3a-4c5d-8e7f-001122334455", settings: { comments: false, changeStatus: false, statuses: {} } })).status).toBe(404);
    expect((await readTicketUpdates({ store: world.store, now: () => world.clock.now }, A, "payments")).revision).toBe(0);
    // A person with no membership is asked to sign in again.
    expect((await call("nobody", "GET")).status).toBe(401);
  });
});
