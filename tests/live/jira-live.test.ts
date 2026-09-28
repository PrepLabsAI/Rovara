// A live check against the real Atlassian MCP server (https://mcp.atlassian.com/v2/mcp), skipped
// unless AGENTX_LIVE_JIRA_TOKEN is set. It reuses the Task 4 broker setup from
// tests/integration/jira-connector.test.ts, with three differences: no `connect` override, so the
// production connectMcp path talks to the real endpoint; the secret comes from
// AGENTX_LIVE_JIRA_TOKEN; and cloudId/projectKey come from AGENTX_LIVE_JIRA_CLOUD_ID and
// AGENTX_LIVE_JIRA_PROJECT. Never run this with the token set outside Part A of Task 6: it creates
// a real issue and comment in the live project.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { githubConnectorType } from "../../packages/broker/src/aws/connector-types.js";
import { jiraConnectorType } from "../../packages/broker/src/aws/jira-connector-type.js";
import { ConnectorCatalogSchema } from "../../packages/contracts/src/connectors.js";
import { call, createBroker, ensureWorkspace, loadSlackBroker, markReady, orchestratorPrincipal, type Handler } from "../support/slack-broker.js";

const TOKEN = process.env.AGENTX_LIVE_JIRA_TOKEN;
const CLOUD_ID = process.env.AGENTX_LIVE_JIRA_CLOUD_ID;
const PROJECT = process.env.AGENTX_LIVE_JIRA_PROJECT;

const team = "T0BSHLLUGBD";
const channel = "C0123456789";
const thread = `${team}/${channel}/1695500000.000001`;
const pratik = "U0123456789";
const admin = { subject: "admin-subject", admin: true };
const service = { principal: orchestratorPrincipal, thread, slackUser: pratik };

const CREDENTIAL_REF = "jira-agentx-sa";
const CREDENTIAL_SECRET_NAME = "agentx/connectors/jira-agentx-sa";

/** The description override a project can give searchJiraIssuesUsingJql, pinned in Task 4's
 * tests (there for project PAY, and again for KAN); here for the live project. */
function searchDescription(project: string): string {
  return `Search Jira issues in project ${project} with JQL. AgentX adds the project filter itself; send only the rest of the query, for example status = "To Do" ORDER BY created DESC.`;
}

function jiraConnectorConfig(credentialRef: string, cloudId: string, project: string, alias: string) {
  return {
    name: "jira", type: "jira", credentialRef,
    scopes: [{ alias, cloudId, projectKey: project }],
    tools: [
      { name: "searchJiraIssuesUsingJql", access: "read", description: searchDescription(project) },
      { name: "getJiraIssue", access: "read" },
      { name: "createJiraIssue", access: "write" },
      { name: "addOrEditJiraIssueComment", access: "write" },
    ],
  };
}

function projectRegistrationBody(revision: number, credentialRef: string, cloudId: string, project: string, alias: string): Record<string, unknown> {
  return {
    definition: {
      name: "payments", revision,
      repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }],
      setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
      integrations: { connectors: [jiraConnectorConfig(credentialRef, cloudId, project, alias)] },
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

function registerCredential(handler: Handler, ref: string, secretName: string) {
  return call(handler, { method: "POST", path: "/v1/admin/credentials", user: admin, body: { ref, type: "static-secret", secretName } });
}

describe.skipIf(!TOKEN)("jira connector, live check against the real project", () => {
  it("registers, searches, creates, comments, reads, refuses, and rejects a bad credential, printing evidence but never the token", async () => {
    const token = TOKEN;
    if (!token) throw new Error("AGENTX_LIVE_JIRA_TOKEN is required");
    const rawCloudId = CLOUD_ID;
    if (!rawCloudId) throw new Error("AGENTX_LIVE_JIRA_CLOUD_ID is required alongside AGENTX_LIVE_JIRA_TOKEN");
    const project = PROJECT;
    if (!project) throw new Error("AGENTX_LIVE_JIRA_PROJECT is required alongside AGENTX_LIVE_JIRA_TOKEN");
    // A cloudId must be lowercase; the guide's Step 8 may hand back mixed case.
    const cloudId = rawCloudId.toLowerCase();
    const alias = project.toLowerCase();

    /** One evidence line per step: the step, the status and the issue key, never the token. */
    const logEvidence = (step: number, status: string, issueKey: string): void => {
      const line = `jira live check step ${step}: ${status}${issueKey ? ` ${issueKey}` : ""}`;
      expect(line).not.toContain(token);
      console.log(line);
    };

    await loadSlackBroker();
    const truncatedSecretName = `${CREDENTIAL_SECRET_NAME}-truncated`;
    const secrets = {
      read: async (name: string): Promise<string | undefined> => {
        if (name === CREDENTIAL_SECRET_NAME) return JSON.stringify({ apiKey: token });
        // Step 8's second credential: the token minus its last character, built here and never
        // stored anywhere else, so it stays in memory only.
        if (name === truncatedSecretName) return JSON.stringify({ apiKey: token.slice(0, -1) });
        return undefined;
      },
    };
    const { db, handler } = createBroker({
      connectorTypes: { github: githubConnectorType, jira: jiraConnectorType },
      connectorCredentials: { secrets, githubApp: { ref: "github-app", secretName: "agentx/connectors/github-app" } },
    });

    // Step 1: register the credential and the project with preflight; expect a connected preflight
    // with the four offered tools.
    expect((await registerCredential(handler, CREDENTIAL_REF, CREDENTIAL_SECRET_NAME)).status).toBe(201);
    const registered = await call(handler, { method: "POST", path: "/v1/admin/projects", user: admin,
      body: projectRegistrationBody(1, CREDENTIAL_REF, cloudId, project, alias) });
    expect(registered.status).toBe(201);
    const preflight = registered.body.preflight as { connectors: Array<{ name: string; status: string; offered: string[]; skipped: unknown[] }> };
    expect(preflight.connectors).toEqual([{
      name: "jira", status: "connected",
      offered: ["jira__searchJiraIssuesUsingJql", "jira__getJiraIssue", "jira__createJiraIssue", "jira__addOrEditJiraIssueComment"],
      skipped: [],
    }]);
    expect((await call(handler, { method: "PUT", path: `/v1/admin/slack/bindings/${team}/${channel}`, user: admin, body: { projectName: "payments" } })).status).toBe(200);
    logEvidence(1, preflight.connectors[0]!.status, "");

    const workspaceId = (await ensureWorkspace(handler, thread, pratik)).body.workspaceId as string;
    markReady(db, workspaceId);
    const path = `/v1/service/workspaces/${workspaceId}/connectors/jira`;

    const discovered = await call(handler, { method: "GET", path: `${path}/tools`, service });
    expect(discovered.status).toBe(200);
    const catalog = ConnectorCatalogSchema.parse(discovered.body.catalog);
    const hashOf = (name: string): string => {
      const tool = catalog.tools.find((candidate) => candidate.name === name);
      const scope = tool?.scopes.find((candidate) => candidate.alias === alias);
      if (!scope) throw new Error(`tool ${name} has no schemaHash for scope ${alias}`);
      return scope.schemaHash;
    };

    // Step 2: search, expect SUCCEEDED.
    const searched = await call(handler, { method: "POST", path: `${path}/call`, service,
      body: { requestId: randomUUID(), scope: alias, tool: "searchJiraIssuesUsingJql", schemaHash: hashOf("jira__searchJiraIssuesUsingJql"),
        arguments: { jql: "status != Done ORDER BY created DESC" } } });
    const searchResult = searched.body.result as { status: string };
    expect(searchResult.status).toBe("SUCCEEDED");
    logEvidence(2, searchResult.status, "");

    // Step 3: create an AgentX live check task, expect SUCCEEDED with a <PROJECT>-<n> key in the text.
    const summary = `AgentX live check ${new Date().toISOString()}`;
    const created = await call(handler, { method: "POST", path: `${path}/call`, service,
      body: { requestId: randomUUID(), scope: alias, tool: "createJiraIssue", schemaHash: hashOf("jira__createJiraIssue"),
        arguments: { summary, issueType: "Task" } } });
    const createResult = created.body.result as { status: string; text: string };
    expect(createResult.status).toBe("SUCCEEDED");
    const keyMatch = new RegExp(`\\b${project}-[1-9][0-9]*\\b`).exec(createResult.text);
    expect(keyMatch).not.toBeNull();
    const issueKey = keyMatch![0];
    logEvidence(3, createResult.status, issueKey);

    // Step 4: comment on that key, expect SUCCEEDED.
    const commented = await call(handler, { method: "POST", path: `${path}/call`, service,
      body: { requestId: randomUUID(), scope: alias, tool: "addOrEditJiraIssueComment", schemaHash: hashOf("jira__addOrEditJiraIssueComment"),
        arguments: { issueIdOrKey: issueKey, commentBody: "Live check comment." } } });
    const commentResult = commented.body.result as { status: string };
    expect(commentResult.status).toBe("SUCCEEDED");
    logEvidence(4, commentResult.status, issueKey);

    // Step 5: read that key with getJiraIssue, expect SUCCEEDED; the live shape is {data:{key,id,fields}}.
    const read = await call(handler, { method: "POST", path: `${path}/call`, service,
      body: { requestId: randomUUID(), scope: alias, tool: "getJiraIssue", schemaHash: hashOf("jira__getJiraIssue"),
        arguments: { issueIdOrKey: issueKey } } });
    const readResult = read.body.result as { status: string; text: string };
    expect(readResult.status).toBe("SUCCEEDED");
    const readBody = JSON.parse(readResult.text) as { data: { key: string } };
    expect(readBody.data.key).toBe(issueKey);
    logEvidence(5, readResult.status, issueKey);

    // Step 6: comment on ZZZNOPE-1, expect FAILED policy_denied: the issue cannot be read, so the
    // guard refuses before any write.
    const refusedComment = await call(handler, { method: "POST", path: `${path}/call`, service,
      body: { requestId: randomUUID(), scope: alias, tool: "addOrEditJiraIssueComment", schemaHash: hashOf("jira__addOrEditJiraIssueComment"),
        arguments: { issueIdOrKey: "ZZZNOPE-1", commentBody: "Live check comment." } } });
    const refusedResult = refusedComment.body.result as { status: string; reason?: string };
    expect(refusedResult.status).toBe("FAILED");
    expect(refusedResult.reason).toBe("policy_denied");
    logEvidence(6, `${refusedResult.status}:${String(refusedResult.reason)}`, "ZZZNOPE-1");

    // Step 7: a model-supplied cloudId, expect 403 before contacting Atlassian.
    const refusedCloudId = await call(handler, { method: "POST", path: `${path}/call`, service,
      body: { requestId: randomUUID(), scope: alias, tool: "getJiraIssue", schemaHash: hashOf("jira__getJiraIssue"),
        arguments: { issueIdOrKey: issueKey, cloudId: "attacker-supplied" } } });
    expect(refusedCloudId.status).toBe(403);
    expect(refusedCloudId.body.error).toEqual({ code: "FORBIDDEN", message: "Jira routing arguments are server controlled" });
    logEvidence(7, "403:FORBIDDEN", issueKey);

    // Step 8: register a second credential whose secret is the token minus its last character
    // (built above, kept in memory only) and register a new project revision that points to it.
    // Expect a not_connected preflight naming the double rejection.
    const truncatedRef = `${CREDENTIAL_REF}-truncated`;
    expect((await registerCredential(handler, truncatedRef, truncatedSecretName)).status).toBe(201);
    const reregistered = await call(handler, { method: "POST", path: "/v1/admin/projects", user: admin,
      body: projectRegistrationBody(2, truncatedRef, cloudId, project, alias) });
    expect(reregistered.status).toBe(201);
    const badPreflight = reregistered.body.preflight as { connectors: Array<{ name: string; status: string; problem?: string; offered: string[]; skipped: unknown[] }> };
    expect(badPreflight.connectors).toHaveLength(1);
    expect(badPreflight.connectors[0]).toMatchObject({ name: "jira", status: "not_connected", offered: [], skipped: [] });
    expect(badPreflight.connectors[0]!.problem).toContain("Jira rejected the credential twice; check the service account's API token (complete, not expired)");
    logEvidence(8, badPreflight.connectors[0]!.status, "");
  }, 60_000);
});
