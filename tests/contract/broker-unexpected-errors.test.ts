// Issue #48: an error that is not an AgentXError reaches the broker's catch-all blocks. A temporary
// AWS error answers 503 RUNTIME_UNAVAILABLE so the caller tries again; no error's own words reach
// the caller, only its name reaches the log.
import { CredentialUnavailable } from "@agentx/gateway";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AWS_TEMPORARY_MESSAGE, UNEXPECTED_REQUEST_MESSAGE } from "../../packages/broker/src/aws/broker-shared.js";
import { adminCall, adminIssuer, createAdminBroker, type AdminHandler } from "../support/admin-broker.js";
import type { FakeDynamoDb } from "../support/fake-dynamodb.js";

const AWS_TEXT = "Rate exceeded for table agentx-state-secret-name";

let lines: string[] = [];
beforeEach(() => { lines = []; vi.spyOn(console, "log").mockImplementation((line: unknown) => { lines.push(String(line)); }); });
afterEach(() => { vi.restoreAllMocks(); });

function awsError(name: string, httpStatusCode?: number): Error {
  return Object.assign(new Error(AWS_TEXT), { name, ...(httpStatusCode === undefined ? {} : { $metadata: { httpStatusCode } }) });
}

/** Every DynamoDB command matching `when` throws `error`; the others reach the fake. */
function failing(db: FakeDynamoDb, error: Error, when: (command: { input?: { Key?: { pk?: string } } }) => boolean = () => true): void {
  const send = db.send;
  db.send = async (command) => {
    if (when(command)) throw error;
    return send(command);
  };
}

const runtimeBinding = {
  deploymentMode: "ec2-ebs" as const,
  launchTemplateId: "lt-0123456789abcdef0",
  subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0123456789abcdef0" }],
  volumeSizeGiB: 20,
  volumeType: "gp3" as const,
};

function register(handler: AdminHandler, connectors: unknown[] = [{ name: "github", type: "github", scopes: "all-repositories", tools: [{ name: "list_issues", access: "read" }] }]) {
  return adminCall(handler, {
    method: "POST",
    path: "/v1/admin/projects",
    body: {
      definition: {
        name: "payments", revision: 1,
        repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }],
        setup: [], readiness: [], orchestratorInstructions: "Delegate work (revision 1).",
        integrations: { connectors },
      },
      runtimeBinding,
    },
  });
}

describe("the OIDC route catch-all (#48)", () => {
  it.each([
    ["ThrottlingException", undefined],
    ["SomeUnmodelledFault", 500],
  ])("answers a registration that meets a temporary AWS error (%s) with 503 RUNTIME_UNAVAILABLE and fixed words", async (name, status) => {
    const { handler, db } = await createAdminBroker({});
    failing(db, awsError(name, status));
    const answer = await register(handler);
    expect(answer.status).toBe(503);
    expect(answer.body.error).toEqual({ code: "RUNTIME_UNAVAILABLE", message: AWS_TEMPORARY_MESSAGE });
    expect(JSON.stringify(answer.body)).not.toContain(AWS_TEXT);
    const logged = lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.event === "aws.temporary_error");
    expect(logged).toEqual([expect.objectContaining({ component: "broker", event: "aws.temporary_error", name })]);
    expect(lines.join("\n")).not.toContain(AWS_TEXT);
  });

  it("answers 503 when the credential registry's read meets a temporary AWS error during registration", async () => {
    const secrets = { read: vi.fn(async () => JSON.stringify({ apiKey: "jira-api-token-value" })) };
    const { handler, db } = await createAdminBroker({ connectorCredentials: { secrets, githubApp: { ref: "github-app", secretName: "agentx/connectors/github-app" } } });
    failing(db, awsError("ProvisionedThroughputExceededException"), (command) => command.input?.Key?.pk === "CREDENTIALS");
    const answer = await register(handler, [
      { name: "github", type: "github", scopes: "all-repositories", tools: [{ name: "list_issues", access: "read" }] },
      { name: "jira", type: "jira", credentialRef: "jira-sa", scopes: [{ alias: "pay", cloudId: "1437bb04-4c88-4efd-9d38-658e8febfeba", projectKey: "PAY" }], tools: [{ name: "searchJiraIssuesUsingJql", access: "read" }] },
    ]);
    expect(answer.status).toBe(503);
    expect(answer.body.error).toEqual({ code: "RUNTIME_UNAVAILABLE", message: AWS_TEMPORARY_MESSAGE });
    expect(db.get("PROJECT#payments", "REV#000000000001")).toBeUndefined();
  });

  it("never echoes a non-temporary error's own words, and logs only its name", async () => {
    const { handler, db } = await createAdminBroker({});
    failing(db, awsError("AccessDeniedException", 400));
    const answer = await register(handler);
    expect(answer.status).toBe(400);
    expect(answer.body.error).toEqual({ code: "CONFIG_INVALID", message: UNEXPECTED_REQUEST_MESSAGE });
    const logged = lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.event === "request.unexpected_error");
    expect(logged).toEqual([expect.objectContaining({ component: "broker", name: "AccessDeniedException" })]);
    expect(lines.join("\n")).not.toContain(AWS_TEXT);
  });

  it("logs where an unexpected error was thrown, never its words", async () => {
    const { handler, db } = await createAdminBroker({});
    failing(db, new TypeError(`Cannot read properties of undefined (reading '${AWS_TEXT}')`));
    const answer = await register(handler);
    expect(answer.body.error).toEqual({ code: "CONFIG_INVALID", message: UNEXPECTED_REQUEST_MESSAGE });
    const logged = lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.event === "request.unexpected_error");
    expect(logged).toEqual([expect.objectContaining({ name: "TypeError", at: expect.stringMatching(/^at .*broker-unexpected-errors\.test\.ts:\d+:\d+/) as unknown })]);
    expect(lines.join("\n")).not.toContain(AWS_TEXT);
  });

  it("logs where an unexpected error without a message was thrown", async () => {
    const { handler, db } = await createAdminBroker({});
    // Node's own stack header for an empty message is the bare name, with no colon.
    failing(db, Object.assign(new RangeError(), { stack: "RangeError\n    at thrower (/var/task/index.js:12:34)" }));
    await register(handler);
    const logged = lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.event === "request.unexpected_error");
    expect(logged).toEqual([expect.objectContaining({ name: "RangeError", at: "at thrower (/var/task/index.js:12:34)" })]);
  });

  it("keeps a CredentialUnavailable's own words, which AgentX wrote and which name no secret", async () => {
    const { handler, db } = await createAdminBroker({});
    failing(db, new CredentialUnavailable("credential linear-key is not registered"));
    const answer = await register(handler);
    expect(answer.status).toBe(400);
    expect(answer.body.error).toEqual({ code: "CONFIG_INVALID", message: "credential linear-key is not registered" });
  });

  it("answers a body that is not JSON with fixed words, never the parser's quote of it", async () => {
    const { handler } = await createAdminBroker({});
    const response = await handler({
      version: "2.0", rawPath: "/v1/admin/projects", rawQueryString: "", headers: {}, body: "{\"secret-looking-body",
      requestContext: { requestId: "request-1", http: { method: "POST" }, authorizer: { jwt: { claims: { iss: adminIssuer, sub: "admin-subject", groups: ["admins"] } } } },
    });
    expect(response.statusCode).toBe(400);
    expect((JSON.parse(response.body) as { error: unknown }).error).toEqual({ code: "CONFIG_INVALID", message: "the request body is not valid JSON" });
    expect(response.body).not.toContain("secret-looking-body");
  });

  it("still names a schema problem in the request, which is AgentX's own words", async () => {
    const { handler } = await createAdminBroker({});
    const answer = await register(handler, [{ name: "github", type: "github", scopes: "all-repositories", tools: [{ name: "list_issues", access: "sometimes" }] }]);
    expect(answer.status).toBe(400);
    expect(answer.body.error).toMatchObject({ code: "CONFIG_INVALID" });
    expect(JSON.stringify(answer.body)).toContain("access");
  });

  it("keeps an AgentXError's own code and words", async () => {
    const { handler } = await createAdminBroker({});
    const answer = await adminCall(handler, { method: "POST", path: "/v1/admin/projects", body: {}, admin: false });
    expect(answer.status).toBe(403);
    expect(answer.body).toMatchObject({ error: { code: "FORBIDDEN" } });
  });
});

describe("the Slack stop-task catch-all (#48)", () => {
  const stop = (handler: AdminHandler, thread: unknown = { teamId: "T0BSHLLUGBD", channelId: "C0123456789", threadTs: "1695500000.000001" }) =>
    handler({ source: "agentx.slack-ingress", action: "stop-task", thread, userId: "U0123456789" });

  it("answers a temporary AWS error with 503 RUNTIME_UNAVAILABLE and fixed words", async () => {
    const { handler, db } = await createAdminBroker({});
    failing(db, awsError("InternalServerError"));
    const response = await stop(handler);
    expect(response.statusCode).toBe(503);
    expect((JSON.parse(response.body) as { error: unknown }).error).toEqual({ code: "RUNTIME_UNAVAILABLE", message: AWS_TEMPORARY_MESSAGE });
    expect(response.body).not.toContain(AWS_TEXT);
    expect(lines.map((line) => JSON.parse(line) as Record<string, unknown>)).toContainEqual(expect.objectContaining({ component: "broker", event: "aws.temporary_error", name: "InternalServerError" }));
  });

  it("never echoes a non-temporary error's own words", async () => {
    const { handler, db } = await createAdminBroker({});
    failing(db, awsError("ValidationException", 400));
    const response = await stop(handler);
    expect(response.statusCode).toBe(400);
    expect((JSON.parse(response.body) as { error: unknown }).error).toEqual({ code: "CONFIG_INVALID", message: UNEXPECTED_REQUEST_MESSAGE });
    expect(lines.join("\n")).not.toContain(AWS_TEXT);
  });
});
