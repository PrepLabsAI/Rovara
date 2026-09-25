// A live check against the real Linear MCP server (https://mcp.linear.app/mcp), skipped unless
// AGENTX_LIVE_LINEAR_TOKEN is set. It mirrors tests/live/jira-live.test.ts: the in-process broker
// from tests/support/slack-broker.ts with the production linear connector type and no `connect`
// override, so the production connectMcp path talks to the real endpoint with the API key (a
// static-secret `{apiKey}`) as a Bearer token.
// Environment: AGENTX_LIVE_LINEAR_TOKEN (a Linear API key), AGENTX_LIVE_LINEAR_TEAM (the scoped
// team's UUID) and, optionally, AGENTX_LIVE_LINEAR_OTHER_TEAM (another team's UUID the model tries
// to target) and AGENTX_LIVE_LINEAR_OUTSIDE_ISSUE (an issue identifier in another team).
// It creates one real issue and one comment in the team. It prints `linear live check: step N`
// evidence lines, never the token.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { githubConnectorType } from "../../packages/broker/src/aws/connector-types.js";
import { linearConnectorType } from "../../packages/broker/src/aws/linear-connector-type.js";
import { ConnectorCatalogSchema } from "../../packages/contracts/src/connectors.js";
import { call, createBroker, ensureWorkspace, loadSlackBroker, markReady, orchestratorPrincipal, type Handler } from "../support/slack-broker.js";

const TOKEN = process.env.AGENTX_LIVE_LINEAR_TOKEN;
const TEAM_ID = process.env.AGENTX_LIVE_LINEAR_TEAM;
const OTHER_TEAM = process.env.AGENTX_LIVE_LINEAR_OTHER_TEAM;
const OUTSIDE_ISSUE = process.env.AGENTX_LIVE_LINEAR_OUTSIDE_ISSUE;

const team = "T0BSHLLUGBD";
const channel = "C0123456789";
const thread = `${team}/${channel}/1695500000.000001`;
const pratik = "U0123456789";
const admin = { subject: "admin-subject", admin: true };
const service = { principal: orchestratorPrincipal, thread, slackUser: pratik };
const ALIAS = "live";

const CREDENTIAL_REF = "linear-agentx-live";
const CREDENTIAL_SECRET_NAME = "agentx/connectors/linear-agentx-live";
const TOOLS = ["list_issues", "get_issue", "save_issue", "save_comment", "list_comments"] as const;
// Linear stores markdown, and reads a bare URL back as an autolink `[url](<url>)`, so either form counts.
const THREAD_URL = "https:\\/\\/slack\\.com\\/archives\\/C0123456789\\/p1695500000000001";
const FOOTER = new RegExp(`\\n\\n—\\nRequested by \`Slack member U0123456789\` via AgentX · (?:${THREAD_URL}|\\[${THREAD_URL}\\]\\(<${THREAD_URL}>\\))`);

function projectRegistrationBody(revision: number, credentialRef: string, teamId: string): Record<string, unknown> {
  return {
    definition: {
      name: "payments", revision,
      repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }],
      setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
      integrations: { connectors: [{
        name: "linear", type: "linear", credentialRef, scopes: [{ alias: ALIAS, teamId }],
        tools: [
          { name: "list_issues", access: "read" }, { name: "get_issue", access: "read" },
          { name: "save_issue", access: "write" }, { name: "save_comment", access: "write" },
          { name: "list_comments", access: "read" },
        ],
      }] },
    },
    runtimeBinding: {
      runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/agentx_production_worker-YVirjlFgvk",
      endpointQualifier: "DEFAULT", deploymentMode: "instances-ebs",
      capacityProviderArn: "arn:aws:bedrock-agentcore:us-east-1:111122223333:capacity-provider/agentx_production_capacity_v3-VwkM93EABZ",
    },
    preflight: true,
  };
}

function registerCredential(handler: Handler, ref: string, secretName: string) {
  return call(handler, { method: "POST", path: "/v1/admin/credentials", user: admin, body: { ref, type: "static-secret", secretName } });
}

/** Whether a "Bug" label is usable in the team (a workspace label or the team's own), read-only through Linear's GraphQL API. */
async function teamHasBugLabel(token: string, teamId: string): Promise<boolean> {
  const response = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { authorization: token, "content-type": "application/json" },
    body: JSON.stringify({ query: `{ issueLabels(first: 50, filter: { name: { eqIgnoreCase: "Bug" } }) { nodes { name team { id } } } }` }),
  });
  if (!response.ok) return false;
  const body = await response.json() as { data?: { issueLabels?: { nodes?: Array<{ name: string; team: { id: string } | null }> } } };
  return (body.data?.issueLabels?.nodes ?? []).some((label) => label.team === null || label.team.id.toLowerCase() === teamId);
}

describe.skipIf(!TOKEN)("linear connector, live check against the real team", () => {
  it("registers, lists, creates, reads, comments, refuses other teams, and rejects a bad key, printing evidence but never the token", async () => {
    const token = TOKEN;
    if (!token) throw new Error("AGENTX_LIVE_LINEAR_TOKEN is required");
    if (!TEAM_ID) throw new Error("AGENTX_LIVE_LINEAR_TEAM is required alongside AGENTX_LIVE_LINEAR_TOKEN");
    const teamId = TEAM_ID.toLowerCase();

    /** One evidence line per step: the step, the status and the issue identifier, never the token. */
    const logEvidence = (step: number, status: string, detail = ""): void => {
      const line = `linear live check: step ${step} ${status}${detail ? ` ${detail}` : ""}`;
      expect(line).not.toContain(token);
      console.log(line);
    };

    await loadSlackBroker();
    const truncatedSecretName = `${CREDENTIAL_SECRET_NAME}-truncated`;
    const secrets = {
      read: async (name: string): Promise<string | undefined> => {
        if (name === CREDENTIAL_SECRET_NAME) return JSON.stringify({ apiKey: token });
        // Step 8's second credential: the key minus its last character, kept in memory only.
        if (name === truncatedSecretName) return JSON.stringify({ apiKey: token.slice(0, -1) });
        return undefined;
      },
    };
    const { db, handler } = createBroker({
      connectorTypes: { github: githubConnectorType, linear: linearConnectorType },
      connectorCredentials: { secrets, githubApp: { ref: "github-app", secretName: "agentx/connectors/github-app" } },
    });

    // Step 1: register the credential and the project with preflight: connected, every tool offered.
    expect((await registerCredential(handler, CREDENTIAL_REF, CREDENTIAL_SECRET_NAME)).status).toBe(201);
    const registered = await call(handler, { method: "POST", path: "/v1/admin/projects", user: admin, body: projectRegistrationBody(1, CREDENTIAL_REF, teamId) });
    expect(registered.status).toBe(201);
    const preflight = registered.body.preflight as { connectors: Array<{ name: string; status: string; offered: string[]; skipped: unknown[] }> };
    expect(preflight.connectors).toEqual([{ name: "linear", status: "connected", offered: TOOLS.map((tool) => `linear__${tool}`), skipped: [] }]);
    expect((await call(handler, { method: "PUT", path: `/v1/admin/slack/bindings/${team}/${channel}`, user: admin, body: { projectName: "payments" } })).status).toBe(200);
    logEvidence(1, preflight.connectors[0]!.status, `offered=${preflight.connectors[0]!.offered.length}`);

    const workspaceId = (await ensureWorkspace(handler, thread, pratik)).body.workspaceId as string;
    markReady(db, workspaceId);
    const path = `/v1/service/workspaces/${workspaceId}/connectors/linear`;
    const discovered = await call(handler, { method: "GET", path: `${path}/tools`, service });
    expect(discovered.status).toBe(200);
    const catalog = ConnectorCatalogSchema.parse(discovered.body.catalog);
    for (const tool of catalog.tools) {
      const properties = (tool.inputSchema as { properties: Record<string, unknown> }).properties;
      expect(properties).not.toHaveProperty("team");
      expect(properties).not.toHaveProperty("teamId");
    }
    const invoke = (tool: string, args: Record<string, unknown>) => {
      const scope = catalog.tools.find((candidate) => candidate.name === `linear__${tool}`)?.scopes.find((candidate) => candidate.alias === ALIAS);
      if (!scope) throw new Error(`tool ${tool} has no schemaHash for scope ${ALIAS}`);
      return call(handler, { method: "POST", path: `${path}/call`, service,
        body: { requestId: randomUUID(), scope: ALIAS, tool, schemaHash: scope.schemaHash, arguments: args } });
    };

    // Step 2: list the team's issues.
    const listed = await invoke("list_issues", { limit: 5 });
    const listResult = listed.body.result as { status: string };
    expect(listResult.status).toBe("SUCCEEDED");
    logEvidence(2, listResult.status);

    // Step 3: create an issue in the team, with the Bug label when the team has one.
    const title = `AgentX Linear live check ${new Date().toISOString()}`;
    const withBug = await teamHasBugLabel(token, teamId);
    const created = await invoke("save_issue", { title, description: "Live check issue.", ...(withBug ? { labels: ["Bug"] } : {}) });
    const createResult = created.body.result as { status: string; text: string };
    expect(createResult.status).toBe("SUCCEEDED");
    const identifierMatch = /\b[A-Z][A-Z0-9]*-[1-9][0-9]*\b/.exec(createResult.text);
    expect(identifierMatch).not.toBeNull();
    const identifier = identifierMatch![0];
    logEvidence(3, createResult.status, `${identifier} labels=${withBug ? "Bug" : "none"}`);

    // Step 4: read it back: same title, the scoped team, and the signed description.
    const read = await invoke("get_issue", { id: identifier });
    const readResult = read.body.result as { status: string; text: string };
    expect(readResult.status).toBe("SUCCEEDED");
    const issue = JSON.parse(readResult.text) as { id: string; title: string; teamId: string; description?: string; labels?: unknown[] };
    expect(issue.id).toBe(identifier);
    expect(issue.title).toBe(title);
    expect(issue.teamId.toLowerCase()).toBe(teamId);
    expect(issue.description ?? "").toMatch(FOOTER);
    if (withBug) expect(JSON.stringify(issue.labels ?? [])).toContain("Bug");
    logEvidence(4, readResult.status, `${identifier} team=scoped footer=yes`);

    // Step 5: comment on it, then read the comment back with its attribution footer.
    const commented = await invoke("save_comment", { issueId: identifier, body: "Live check comment." });
    const commentResult = commented.body.result as { status: string };
    expect(commentResult.status).toBe("SUCCEEDED");
    const comments = await invoke("list_comments", { issueId: identifier });
    const commentsResult = comments.body.result as { status: string; text: string };
    expect(commentsResult.status).toBe("SUCCEEDED");
    expect(commentsResult.text).toContain("Live check comment.");
    expect(commentsResult.text).toContain("Requested by `Slack member U0123456789` via AgentX");
    logEvidence(5, commentResult.status, `${identifier} footer=yes`);

    // Step 6: a model-supplied team (another team's UUID when given, else a random one) is refused
    // with 403 before Linear is contacted, on a create and on a list.
    const otherTeam = (OTHER_TEAM ?? randomUUID()).toLowerCase();
    expect(otherTeam).not.toBe(teamId);
    for (const [tool, args] of [
      ["save_issue", { title: `${title} (must not exist)`, team: otherTeam }],
      ["save_issue", { title: `${title} (must not exist)`, teamId: otherTeam }],
      ["list_issues", { team: otherTeam }],
    ] as const) {
      const refused = await invoke(tool, args);
      expect(refused.status).toBe(403);
      expect(refused.body.error).toEqual({ code: "FORBIDDEN", message: "Linear routing arguments are server controlled" });
    }
    logEvidence(6, "403:FORBIDDEN", `model-supplied team/teamId (${OTHER_TEAM ? "other team" : "random uuid"})`);

    // Step 7: an issue outside the team (the given one, else one that does not exist) is refused
    // before any write, for a read and a comment.
    const outside = OUTSIDE_ISSUE ?? "ZZZNOPE-1";
    for (const [tool, args] of [["get_issue", { id: outside }], ["save_comment", { issueId: outside, body: "Live check comment." }]] as const) {
      const refused = await invoke(tool, args);
      const refusedResult = refused.body.result as { status: string; reason?: string };
      expect(refusedResult).toMatchObject({ status: "FAILED", reason: "policy_denied" });
    }
    logEvidence(7, "FAILED:policy_denied", OUTSIDE_ISSUE ? `${outside} (outside issue)` : `${outside} (not found)`);

    // Step 8: a second credential holding the key minus its last character: not connected.
    const truncatedRef = `${CREDENTIAL_REF}-truncated`;
    expect((await registerCredential(handler, truncatedRef, truncatedSecretName)).status).toBe(201);
    const reregistered = await call(handler, { method: "POST", path: "/v1/admin/projects", user: admin, body: projectRegistrationBody(2, truncatedRef, teamId) });
    expect(reregistered.status).toBe(201);
    const badPreflight = reregistered.body.preflight as { connectors: Array<{ name: string; status: string; problem?: string; offered: string[]; skipped: unknown[] }> };
    expect(badPreflight.connectors).toHaveLength(1);
    expect(badPreflight.connectors[0]).toMatchObject({ name: "linear", status: "not_connected", offered: [], skipped: [] });
    expect(badPreflight.connectors[0]!.problem).toContain("Linear rejected the credential twice; check the Linear API key's permissions and team access");
    logEvidence(8, badPreflight.connectors[0]!.status);

    // The key appears nowhere AgentX wrote.
    expect(JSON.stringify([db.find(() => true), discovered.body, registered.body, reregistered.body])).not.toContain(token);
  }, 90_000);
});
