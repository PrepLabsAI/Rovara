import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { ConnectorCatalogSchema } from "../../packages/contracts/src/connectors.js";
import { CHARTERARC_TEAM_ID } from "../support/fake-linear-mcp.js";
import { LINEAR_KEY, LINEAR_THREAD, LINEAR_MEMBER, setupLinearBroker } from "../support/linear-broker.js";
import { call, loadSlackBroker, orchestratorPrincipal } from "../support/slack-broker.js";

const service = { principal: orchestratorPrincipal, thread: LINEAR_THREAD, slackUser: LINEAR_MEMBER };
const linearBroker = () => setupLinearBroker({ preflight: true });

beforeAll(async () => { await loadSlackBroker(); });
let log: MockInstance<typeof console.log>;
beforeEach(() => { log = vi.spyOn(console, "log").mockImplementation(() => undefined); });
afterEach(() => { log.mockRestore(); });

describe("Linear connector over Streamable HTTP", () => {
  it("preflights, discovers with the team removed, binds it, guards issues, signs writes and keeps the key secret", async () => {
    const { db, handler, fake, requested, registered, path } = await linearBroker();
    try {
      expect(registered.body.preflight).toEqual({ connectors: [{ name: "linear", status: "connected", offered: ["linear__list_issues", "linear__get_issue", "linear__save_issue", "linear__save_comment"], skipped: [] }] });

      const discovered = await call(handler, { method: "GET", path: `${path}/tools`, service });
      expect(discovered.status).toBe(200);
      const catalog = ConnectorCatalogSchema.parse(discovered.body.catalog);
      const byName = Object.fromEntries(catalog.tools.map((tool) => [tool.name, tool]));
      // The vendor's own schema legitimately mentions "team" inside unrelated enums (list_issues'
      // `fields` filter), so the routing check is scoped to the tool's own top-level properties,
      // the same shape reviewTools removes them from.
      for (const tool of catalog.tools) {
        const properties = (tool.inputSchema as { properties: Record<string, unknown> }).properties;
        expect(properties).not.toHaveProperty("team");
        expect(properties).not.toHaveProperty("teamId");
      }
      expect(Object.keys((byName.linear__save_comment!.inputSchema as { properties: object }).properties)).toContain("issueId");
      expect(requested.every((url) => url.href === "https://mcp.linear.app/mcp")).toBe(true);
      expect(fake.headers.filter((entry) => entry.authorization !== undefined).every((entry) => entry.authorization === `Bearer ${LINEAR_KEY}`)).toBe(true);

      const invoke = (tool: string, args: Record<string, unknown>, requestId: string = randomUUID()) => call(handler, { method: "POST", path: `${path}/call`, service,
        body: { requestId, scope: "charterarc", tool, schemaHash: byName[`linear__${tool}`]!.scopes[0]!.schemaHash, arguments: args } });

      // A read binds the team.
      expect((await invoke("list_issues", { state: "started" })).body.result).toMatchObject({ status: "SUCCEEDED" });
      expect(fake.calls.at(-1)).toEqual({ name: "list_issues", arguments: { state: "started", team: CHARTERARC_TEAM_ID } });

      // A create binds the team and signs the description; a replay does not call Linear again.
      const createId = randomUUID();
      expect((await invoke("save_issue", { title: "Flaky login test", description: "Steps" }, createId)).body.result).toMatchObject({ status: "SUCCEEDED" });
      expect(fake.calls.at(-1)).toEqual({ name: "save_issue", arguments: {
        title: "Flaky login test", team: CHARTERARC_TEAM_ID,
        description: expect.stringMatching(/^Steps\n\n—\nRequested by `Slack member U0123456789` via AgentX · https:\/\/slack\.com\/archives\/C0123456789\/p1695500000000001$/) as unknown,
      } });
      const before = fake.calls.length;
      expect((await invoke("save_issue", { title: "Flaky login test", description: "Steps" }, createId)).body.result).toMatchObject({ replayed: true });
      expect(fake.calls.length).toBe(before);
      expect(db.find((item) => item.sk === `CONNECTOR#linear#${createId}`)).toEqual([expect.objectContaining({ entityType: "CONNECTOR_INVOCATION", connector: "linear" })]);

      // An update of an issue in the team is checked, then sent with the same team.
      await invoke("save_issue", { id: "CHA-1", priority: 2 });
      expect(fake.calls.slice(-2)).toEqual([{ name: "get_issue", arguments: { id: "CHA-1" } }, { name: "save_issue", arguments: { id: "CHA-1", priority: 2, team: CHARTERARC_TEAM_ID } }]);

      // An update of another team's issue is refused after the check; nothing is written.
      const outside = await invoke("save_issue", { id: "OTH-9", priority: 1 });
      expect(outside.body.result).toMatchObject({ status: "FAILED", reason: "policy_denied", text: 'Linear issue "OTH-9" is not in the charterarc team this connector may use.' });
      expect(fake.calls.at(-1)).toEqual({ name: "get_issue", arguments: { id: "OTH-9" } });

      // A comment is checked, signed, and carries neither team nor teamId.
      await invoke("save_comment", { issueId: "CHA-1", body: "Deployed" });
      const comment = fake.calls.at(-1)!;
      expect(comment.name).toBe("save_comment");
      expect(comment.arguments).not.toHaveProperty("team");
      expect(comment.arguments).not.toHaveProperty("teamId");
      expect(String(comment.arguments.body)).toMatch(/^Deployed\n\n—\nRequested by `Slack member U0123456789` via AgentX · https:\/\/slack\.com\/archives\/C0123456789\/p1695500000000001$/);

      // A reply cannot be verified and is refused without any call.
      const callsBeforeReply = fake.calls.length;
      expect((await invoke("save_comment", { parentId: "comment-1", body: "Thanks" })).body.result).toMatchObject({ status: "FAILED", reason: "policy_denied" });
      expect(fake.calls.length).toBe(callsBeforeReply);

      // A model-supplied team is refused before Linear is contacted.
      const callsBeforeTeam = fake.calls.length;
      const forged = await invoke("list_issues", { team: "Other" });
      expect(forged.status).toBe(403);
      expect(forged.body.error).toEqual({ code: "FORBIDDEN", message: "Linear routing arguments are server controlled" });
      expect(fake.calls.length).toBe(callsBeforeTeam);

      // The key appears nowhere AgentX writes.
      const everything = JSON.stringify([log.mock.calls, db.find(() => true), discovered.body, registered.body]);
      expect(everything).not.toContain(LINEAR_KEY);
    } finally { await fake.close(); }
  });

  it("reports not connected when Linear rejects the key twice, without the key in the log", async () => {
    const { handler, fake, path } = await linearBroker();
    try {
      // Registration's preflight is uncached, so this is the thread's first discovery.
      fake.unauthorized.value = true;
      const discovered = await call(handler, { method: "GET", path: `${path}/tools`, service });
      expect(discovered.status).toBe(200);
      expect(discovered.body.catalog).toEqual({ connector: "linear", notConnected: true, tools: [], skipped: [] });
      const line = log.mock.calls.map(([entry]) => String(entry)).find((entry) => entry.includes("connector.not_connected"));
      expect(line).toContain("Linear rejected the credential twice; check the Linear API key's permissions and team access");
      expect(line).not.toContain(LINEAR_KEY);
    } finally { await fake.close(); }
  });
});
