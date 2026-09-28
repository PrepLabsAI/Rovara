// A live check against the real Asana MCP server (https://mcp.asana.com/v2/mcp) and token
// endpoint, skipped unless AGENTX_LIVE_ASANA_CLIENT_ID is set. The bot user signs in once in a
// browser through the real `agentx admin credential authorize` code (secrets held in memory, the
// control plane served in process). Then the broker from this branch registers the project,
// searches, creates a task, reads it, comments on it, refuses a task outside the project, refreshes
// headlessly from a second broker, and reports a revoked refresh token as not connected.
// Environment: AGENTX_LIVE_ASANA_CLIENT_ID, AGENTX_LIVE_ASANA_CLIENT_SECRET, AGENTX_LIVE_ASANA_PROJECT
// (the in-scope project GID) and, optionally, AGENTX_LIVE_ASANA_OUTSIDE_TASK (a task GID in another
// project). It creates one real task and one comment in the project. It prints evidence lines, and
// writes the raw get_task text to AGENTX_LIVE_ASANA_CAPTURE when set, never a token.
//
// Step 1's sign-in URL is printed on its own line, prefixed exactly `ASANA SIGN-IN URL: `, so a
// controller relaying this test's output can find and open it; the account authorizeCredential
// reports signed in (name/email only, never a token) is printed as step 1 evidence too.
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { authorizeCredential, type AuthorizeSecrets } from "../../packages/cli/src/admin/authorize.js";
import { ASANA_MCP_ENDPOINT, ASANA_TOKEN_ENDPOINT, connectMcp, resultText } from "@agentx/gateway";
import { asanaConnectorType } from "../../packages/broker/src/aws/asana-connector-type.js";
import { githubConnectorType } from "../../packages/broker/src/aws/connector-types.js";
import { CredentialRegistry } from "../../packages/broker/src/aws/credentials.js";
import { ConnectorCatalogSchema } from "../../packages/contracts/src/connectors.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { memorySecretStore } from "../support/refresh-token-fakes.js";
import { call, createBroker, ensureWorkspace, loadSlackBroker, markReady, orchestratorPrincipal, type Handler } from "../support/slack-broker.js";

const CLIENT_ID = process.env.AGENTX_LIVE_ASANA_CLIENT_ID;
const CLIENT_SECRET = process.env.AGENTX_LIVE_ASANA_CLIENT_SECRET;
const PROJECT = process.env.AGENTX_LIVE_ASANA_PROJECT;
const OUTSIDE_TASK = process.env.AGENTX_LIVE_ASANA_OUTSIDE_TASK ?? "1199999999999999";
// The bot user's email. The sign-in must be this account, or the check stops before any write:
// a default browser already signed in to Asana as someone else approves silently as that person.
const BOT_EMAIL = process.env.AGENTX_LIVE_ASANA_BOT_EMAIL;
const CAPTURE = process.env.AGENTX_LIVE_ASANA_CAPTURE;

const team = "T0BSHLLUGBD";
const channel = "C0123456789";
const thread = `${team}/${channel}/1695500000.000001`;
const pratik = "U0123456789";
const admin = { subject: "admin-subject", admin: true };
const service = { principal: orchestratorPrincipal, thread, slackUser: pratik };
const CONTROL_PLANE = "https://agentx.live.test";
const SECRET = "agentx/connectors/asana-bot";
const REVOKED_SECRET = "agentx/connectors/asana-revoked";

function registrationBody(revision: number, credentialRef: string, projectGid: string): Record<string, unknown> {
  return {
    definition: {
      name: "payments", revision,
      repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }],
      setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
      integrations: { connectors: [{
        name: "asana", type: "asana", credentialRef, scopes: [{ alias: "live", projectGid }],
        tools: [
          { name: "search_tasks", access: "read" }, { name: "get_tasks", access: "read" }, { name: "get_task", access: "read" },
          { name: "create_tasks", access: "write" }, { name: "add_comment", access: "write" },
        ],
      }] },
    },
    runtimeBinding: {
      deploymentMode: "ec2-ebs" as const,
      launchTemplateId: "lt-0123456789abcdef0",
      subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0123456789abcdef0" }],
      volumeSizeGiB: 20,
      volumeType: "gp3" as const,
    },
    preflight: true,
  };
}

/** Serves the CLI's control-plane calls from the in-process broker, and everything else from the network. */
function routedFetch(handler: () => Handler): typeof fetch {
  return async (url, init) => {
    const href = url instanceof URL ? url.href : typeof url === "string" ? url : url.url;
    if (!href.startsWith(CONTROL_PLANE)) return fetch(url, init);
    const response = await call(handler(), { method: init?.method ?? "GET", path: new URL(href).pathname, user: admin, body: JSON.parse(init?.body as string) as unknown });
    return Response.json(response.body, { status: response.status });
  };
}

describe.skipIf(!CLIENT_ID)("asana connector, live check against the real project", () => {
  it("signs in once, registers, searches, creates, reads, comments, refuses, refreshes and reports a revoked sign-in", async () => {
    if (!CLIENT_ID || !CLIENT_SECRET || !PROJECT || !BOT_EMAIL) throw new Error("AGENTX_LIVE_ASANA_CLIENT_ID, AGENTX_LIVE_ASANA_CLIENT_SECRET, AGENTX_LIVE_ASANA_PROJECT and AGENTX_LIVE_ASANA_BOT_EMAIL are required");
    await loadSlackBroker();
    const secrets = memorySecretStore({
      [SECRET]: JSON.stringify({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }),
      [REVOKED_SECRET]: JSON.stringify({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, refreshToken: "revoked-refresh-token" }),
    });
    const printed: string[] = [];
    const evidence = (line: string) => { printed.push(line); console.log(`asana live check: ${line}`); };
    const broker = () => createBroker({ connectorTypes: { github: githubConnectorType, asana: asanaConnectorType }, connectorCredentials: { secrets, githubApp: { ref: "github-app", secretName: "agentx/connectors/github-app" } } });
    const first = broker();

    // Step 1: the one-time browser sign-in through the real authorize code, registering in process.
    // showUrl prints the sign-in URL on its own line, prefixed exactly `ASANA SIGN-IN URL: `, so a
    // controller relaying this test's stdout can find and open it, plus the redirect the Asana app
    // must be registered with. showAccount reports which account signed in (name/email only, never
    // a token); it is captured and folded into this step's evidence line below.
    const authorizeSecrets: AuthorizeSecrets = { read: (name) => secrets.read(name), write: (name, value) => secrets.write(name, value), tag: async () => undefined };
    let accountLine: string | undefined;
    await authorizeCredential({
      controlPlaneUrl: CONTROL_PLANE, accessToken: "unused", ref: "asana-bot", secretName: SECRET, provider: "asana",
      secrets: authorizeSecrets, openBrowser: async () => undefined, // never open the default browser; the URL is opened by hand in a private window
      showUrl: (url, redirectRequirement) => {
        console.log(`ASANA SIGN-IN URL: ${url}`); console.log(redirectRequirement);
        // Also written to a file, since test runners may buffer console output until the test ends.
        if (process.env.AGENTX_LIVE_ASANA_URL_FILE) void writeFile(process.env.AGENTX_LIVE_ASANA_URL_FILE, `${url}\n`);
      },
      showAccount: (line) => { accountLine = line; },
      fetchImplementation: routedFetch(() => first.handler),
    });
    const refreshToken = (JSON.parse(secrets.values[SECRET]!) as { refreshToken: string }).refreshToken;
    if (!BOT_EMAIL || !accountLine?.toLowerCase().includes(BOT_EMAIL.toLowerCase())) throw new Error(`the sign-in was not the bot user (${accountLine ?? "account not shown"}); rerun with the URL in a private window signed in as ${BOT_EMAIL ?? "AGENTX_LIVE_ASANA_BOT_EMAIL"}`);
    evidence(`step 1 ${accountLine ?? "signed in to Asana (the account could not be shown)"}; refresh token stored (${refreshToken.length} characters)`);

    // Step 2: register the project with preflight.
    const registered = await call(first.handler, { method: "POST", path: "/v1/admin/projects", user: admin, body: registrationBody(1, "asana-bot", PROJECT) });
    expect(registered.status).toBe(201);
    const preflight = registered.body.preflight as { connectors: Array<{ status: string; offered: string[]; skipped: unknown[] }> };
    expect(preflight.connectors[0]).toMatchObject({ status: "connected", skipped: [] });
    evidence(`step 2 preflight ${preflight.connectors[0]!.status}, offered ${preflight.connectors[0]!.offered.join(", ")}`);
    expect((await call(first.handler, { method: "PUT", path: `/v1/admin/slack/bindings/${team}/${channel}`, user: admin, body: { projectName: "payments" } })).status).toBe(200);
    const workspaceId = (await ensureWorkspace(first.handler, thread, pratik)).body.workspaceId as string;
    markReady(first.db, workspaceId);
    const path = `/v1/service/workspaces/${workspaceId}/connectors/asana`;
    const catalog = ConnectorCatalogSchema.parse((await call(first.handler, { method: "GET", path: `${path}/tools`, service })).body.catalog);
    const run = async (handler: Handler, tool: string, args: Record<string, unknown>) => {
      const schemaHash = catalog.tools.find((entry) => entry.name === `asana__${tool}`)!.scopes[0]!.schemaHash;
      const response = await call(handler, { method: "POST", path: `${path}/call`, service, body: { requestId: randomUUID(), scope: "live", tool, schemaHash, arguments: args } });
      return response.body.result as { status: string; reason?: string; text: string };
    };

    // Step 3: list and search (search_tasks needs a paid Asana plan; a free workspace answers vendor_error).
    const listed = await run(first.handler, "get_tasks", { limit: 5 });
    expect(listed.status).toBe("SUCCEEDED");
    const searched = await run(first.handler, "search_tasks", { completed: false, limit: 5 });
    evidence(`step 3 get_tasks ${listed.status}; search_tasks ${searched.status}${searched.reason ? ` (${searched.reason})` : ""}`);

    // Step 4: create a task in the project. name and notes are the only keys set, both allowlisted
    // in ASANA_CREATE_TASK_ITEM_KEYS (packages/gateway/src/asana.ts); the project itself comes from
    // the connector's binder (default_project), never a project_id passed here.
    const created = await run(first.handler, "create_tasks", { tasks: [{ name: `AgentX live check ${new Date().toISOString()}`, notes: "Created by the AgentX phase 7 live check." }] });
    expect(created.status).toBe("SUCCEEDED");
    const taskGid = /"gid"\s*:\s*"(\d+)"/.exec(created.text)?.[1];
    expect(taskGid).toBeDefined();
    evidence(`step 4 create_tasks ${created.status}, task ${taskGid}`);

    // Step 5: capture Asana's raw get_task answer (the shape the guard parses), then read the task
    // through the broker, which only succeeds if the guard accepts that shape.
    if (CAPTURE) {
      const db = new FakeDynamoDb();
      db.set({ pk: "CREDENTIALS", sk: "REF#asana-bot", entityType: "CREDENTIAL", ref: "asana-bot", type: "oauth-refresh-token", secretName: SECRET, registeredBy: "live", registeredAt: new Date().toISOString() });
      const registry = new CredentialRegistry({ secrets, githubApp: { ref: "github-app", secretName: "agentx/connectors/github-app" }, documentClient: db as never, tableName: "state" });
      const { token } = await registry.provider("asana-bot", { tokenEndpoint: ASANA_TOKEN_ENDPOINT }).issue(undefined, "read");
      const connection = await connectMcp({ endpoint: ASANA_MCP_ENDPOINT, token, tools: ["get_task"], signal: AbortSignal.timeout(20_000) });
      try {
        await writeFile(CAPTURE, resultText(await connection.call("get_task", { task_id: taskGid!, include_subtasks: false, include_comments: false })));
      } finally { await connection.close(); }
    }
    const read = await run(first.handler, "get_task", { task_id: taskGid });
    evidence(`step 5 get_task ${read.status}${read.reason ? ` (${read.reason})` : ""}`);
    expect(read.status).toBe("SUCCEEDED");

    // Step 6: comment on it, signed. text (not html_text, which the guard refuses on add_comment).
    const commented = await run(first.handler, "add_comment", { task_id: taskGid, text: "Live check comment." });
    expect(commented.status).toBe("SUCCEEDED");
    evidence(`step 6 add_comment ${commented.status}`);

    // Step 7: a task outside the project is refused before any write.
    const refused = await run(first.handler, "add_comment", { task_id: OUTSIDE_TASK, text: "Must not be written." });
    expect(refused).toMatchObject({ status: "FAILED", reason: "policy_denied" });
    evidence(`step 7 outside task ${refused.status} ${refused.reason}`);

    // Step 8: a second broker with no cached access token refreshes headlessly.
    const second = broker();
    for (const item of first.db.items.values()) if (item.sk !== "TOKEN#refresh-token") second.db.set(structuredClone(item));
    const refreshed = await run(second.handler, "get_task", { task_id: taskGid });
    expect(refreshed.status).toBe("SUCCEEDED");
    const after = (JSON.parse(secrets.values[SECRET]!) as { refreshToken: string }).refreshToken;
    evidence(`step 8 refreshed from a second broker ${refreshed.status}; refresh token rotated: ${after === refreshToken ? "no" : "yes (written back)"}`);

    // Step 9: a revoked refresh token reports not connected at registration preflight.
    expect((await call(second.handler, { method: "POST", path: "/v1/admin/credentials", user: admin, body: { ref: "asana-revoked", type: "oauth-refresh-token", secretName: REVOKED_SECRET } })).status).toBe(201);
    const revoked = await call(second.handler, { method: "POST", path: "/v1/admin/projects", user: admin, body: registrationBody(2, "asana-revoked", PROJECT) });
    const revokedPreflight = revoked.body.preflight as { connectors: Array<{ status: string; problem?: string }> };
    expect(revokedPreflight.connectors[0]).toMatchObject({ status: "not_connected" });
    expect(revokedPreflight.connectors[0]!.problem).toContain("agentx admin credential authorize --ref asana-revoked");
    evidence(`step 9 revoked sign-in ${revokedPreflight.connectors[0]!.status}`);

    for (const line of printed) {
      expect(line).not.toContain(refreshToken);
      expect(line).not.toContain(CLIENT_SECRET);
    }
  }, 600_000);
});
