// Spec 041: GET /v1/dev/workspaces -- the projects a developer may use, with the workspaces in
// them, read through the sparse byWorkspaceProject index.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WORKSPACE_PROJECT_INDEX, type ChannelMembersRequest, type ChannelMembersResponse } from "@agentx/contracts";
import type { DeveloperApiConfiguration } from "../../packages/broker/src/aws/developer-routes.js";
import { developerTokenVerifier } from "../../packages/broker/src/developer/verify-token.js";
import { createAdminBroker, type AdminHandler } from "../support/admin-broker.js";
import { localSigner } from "../support/developer-fakes.js";
import type { FakeDynamoDb } from "../support/fake-dynamodb.js";

const ISSUER = "https://abc123.execute-api.us-east-1.amazonaws.com/v1/auth";
const developerId = "d".repeat(64);
const T0 = Date.parse("2026-09-27T12:00:00.000Z");

let db: FakeDynamoDb;
let handler: AdminHandler;
let channelMembers: ReturnType<typeof vi.fn<(request: ChannelMembersRequest) => Promise<ChannelMembersResponse>>>;
let config: DeveloperApiConfiguration;

const signer = localSigner();
const claims = (overrides: Record<string, unknown> = {}) => ({
  iss: ISSUER, aud: "agentx-developer", sub: developerId, amr: "slack", env: "staging", sid: "s-1", iat: T0 / 1000, nbf: T0 / 1000, exp: T0 / 1000 + 3600, ...overrides,
});
async function bearer(jwt: Record<string, unknown>): Promise<string> {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: (await signer.publicJwk()).kid })).toString("base64url");
  const input = `${header}.${Buffer.from(JSON.stringify(jwt)).toString("base64url")}`;
  return `Bearer ${input}.${(await signer.sign(Buffer.from(input))).toString("base64url")}`;
}
const call = async (path: string, jwt: Record<string, unknown>, method = "GET") =>
  handler({ rawPath: path, headers: { authorization: await bearer(jwt) }, requestContext: { requestId: "r", http: { method } } });

/** A stored workspace META item, index attributes and all, as the broker writes one. */
function workspace(input: { id: string; project: string; created: string; status?: string; revision?: number; activeOperationId?: string | null }): Record<string, unknown> {
  const created = input.created;
  return {
    pk: `WORKSPACE#${input.id}`,
    sk: "META",
    entityType: "WORKSPACE",
    [WORKSPACE_PROJECT_INDEX.partitionKey]: input.project,
    [WORKSPACE_PROJECT_INDEX.sortKey]: created,
    id: input.id,
    ownerKey: "o".repeat(64),
    projectName: input.project,
    projectRevision: input.revision ?? 7,
    deploymentMode: "ec2-ebs",
    rootPath: "/mnt/workspace",
    status: input.status ?? "READY",
    activeOperationId: input.activeOperationId ?? null,
    fence: 1,
    createdAt: created,
    updatedAt: created,
  };
}

const uuid = (tag: string) => `00000000-0000-4000-8000-0000000000${tag}`;

interface WorkspacesBody {
  developer: { id: string };
  projects: Array<{ name: string }>;
  workspaces: Array<{ id: string; projectName: string; status: string; busy: boolean; projectRevision: number; createdAt: string; updatedAt: string }>;
  notices: string[];
}

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(async () => {
  vi.useFakeTimers({ now: T0, toFake: ["Date"] });
  channelMembers = vi.fn(async () => ({ ok: true as const, memberOf: ["C0PAY0001"] }));
  config = {
    issuer: ISSUER, env: "staging", methods: { slack: true, oidc: false }, slackTeamId: "T0TEAM1", signInTableName: "signin", channelMembers,
    verifyAccessToken: developerTokenVerifier({ issuer: ISSUER, keys: async () => [await signer.publicJwk()], now: () => Date.now() }),
  };
  ({ db, handler } = await createAdminBroker({ developer: config }));
  db.set({ pk: "SESSION#s-1", sk: "META", sessionId: "s-1", developerId, amr: "slack", slackUserId: "U0MAYA001", startedAt: new Date(T0).toISOString(), endsAt: T0 / 1000 + 604_800 });
  db.set({ pk: `DEVELOPER#${developerId}`, sk: "META", developerId, provider: "slack", issuer: "https://slack.com", subject: "U0MAYA001", displayName: "Maya Chen", slackUserId: "U0MAYA001", firstSignInAt: "x", lastSignInAt: "x", revoked: false });
  db.set({ pk: "SLACK_BINDING#T0TEAM1", sk: "CHANNEL#C0PAY0001", teamId: "T0TEAM1", channelId: "C0PAY0001", projectName: "payments-api", updatedAt: "2026-09-27T00:00:00.000Z" });
  db.set({ pk: "PROJECT#payments-api", sk: "REV#000000000007", entityType: "PROJECT", definition: { name: "payments-api", revision: 7 } });
  db.set({ pk: "PROJECT#solo", sk: "REV#000000000001", entityType: "PROJECT", definition: { name: "solo", revision: 1 } });
  db.set({ pk: "PROJECT#ledger", sk: "REV#000000000002", entityType: "PROJECT", definition: { name: "ledger", revision: 2 } });
  db.set({ pk: `MEMBER#${developerId}`, sk: "PROJECT#solo", entityType: "MEMBERSHIP", ownerKey: developerId, projectName: "solo", role: "developer" });
});

describe("GET /v1/dev/workspaces (spec 041 FR-001, FR-002)", () => {
  it("lists the workspaces of every project the developer may use, newest first", async () => {
    db.set(workspace({ id: uuid("01"), project: "payments-api", created: "2026-09-20T09:00:00.000Z" }));
    db.set(workspace({ id: uuid("02"), project: "payments-api", created: "2026-09-26T09:00:00.000Z", status: "BUSY", activeOperationId: uuid("99") }));
    db.set(workspace({ id: uuid("03"), project: "solo", created: "2026-09-24T09:00:00.000Z", status: "UNPREPARED", revision: 1 }));

    const response = await call("/v1/dev/workspaces", claims());
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as WorkspacesBody;
    expect(body.developer.id).toBe(developerId);
    expect(body.projects.map((project) => project.name)).toEqual(["payments-api", "solo"]);
    expect(body.workspaces.map((entry) => [entry.id, entry.projectName, entry.status, entry.busy])).toEqual([
      [uuid("02"), "payments-api", "BUSY", true],
      [uuid("03"), "solo", "UNPREPARED", false],
      [uuid("01"), "payments-api", "READY", false],
    ]);
    expect(body.notices).toEqual([]);
  });

  it("never shows a workspace in a project the developer may not use", async () => {
    db.set(workspace({ id: uuid("04"), project: "ledger", created: "2026-09-26T09:00:00.000Z", revision: 2 }));
    const body = JSON.parse((await call("/v1/dev/workspaces", claims())).body) as WorkspacesBody;
    expect(body.projects.map((project) => project.name)).toEqual(["payments-api", "solo"]);
    expect(body.workspaces).toEqual([]);
  });

  it("reads only the byWorkspaceProject index, once per project the developer may use", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const original = db.send;
    vi.spyOn(db, "send").mockImplementation(async (command) => {
      if (command.constructor.name === "QueryCommand" && command.input.IndexName !== undefined) sent.push(command.input);
      return original(command);
    });
    await call("/v1/dev/workspaces", claims());
    expect(sent.map((input) => [input.IndexName, (input.ExpressionAttributeValues as Record<string, unknown>)[":project"], input.ScanIndexForward])).toEqual([
      [WORKSPACE_PROJECT_INDEX.name, "payments-api", false],
      [WORKSPACE_PROJECT_INDEX.name, "solo", false],
    ]);
  });

  it("tells the developer nothing about how a workspace runs", async () => {
    db.set(workspace({ id: uuid("05"), project: "solo", created: "2026-09-26T09:00:00.000Z", revision: 1 }));
    const body = JSON.parse((await call("/v1/dev/workspaces", claims())).body) as WorkspacesBody;
    expect(Object.keys(body.workspaces[0]!).sort()).toEqual(["busy", "createdAt", "id", "projectName", "projectRevision", "status", "updatedAt"]);
    expect((await call("/v1/dev/workspaces", claims())).body).not.toContain("o".repeat(64));
  });

  it("leaves out a record this release cannot read rather than failing the listing", async () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
    db.set({ ...workspace({ id: uuid("06"), project: "solo", created: "2026-09-26T09:00:00.000Z" }), status: "SOMETHING_NEW" });
    db.set(workspace({ id: uuid("07"), project: "solo", created: "2026-09-25T09:00:00.000Z", revision: 1 }));
    const body = JSON.parse((await call("/v1/dev/workspaces", claims())).body) as WorkspacesBody;
    expect(body.workspaces.map((entry) => entry.id)).toEqual([uuid("07")]);
    expect(logs.mock.calls.map(([line]) => (JSON.parse(String(line)) as { event: string }).event)).toContain("developer.workspace_unreadable");
  });

  it("needs a developer sign-in, like every other /v1/dev route", async () => {
    const response = await handler({ rawPath: "/v1/dev/workspaces", requestContext: { requestId: "r", http: { method: "GET" } } });
    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body)).toMatchObject({ error: { code: "AUTH_REQUIRED" } });
  });

  it("answers 404 for a method it does not serve", async () => {
    const response = await call("/v1/dev/workspaces", claims(), "POST");
    expect(response.statusCode).toBe(404);
  });
});
