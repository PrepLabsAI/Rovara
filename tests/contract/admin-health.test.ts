// tests/contract/admin-health.test.ts
// Spec 025 A13: health from injected probes; a probe that is missing or fails never fails the route.
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { failureIndexKey } from "../../packages/contracts/src/index.js";
import { GitHubAppCredentialProvider } from "../../packages/broker/src/github-app.js";
import { createAdminReadBroker } from "../support/admin-read-broker.js";
import { SLACK_CHANNEL, SLACK_TEAM, ensureWorkspace } from "../support/slack-broker.js";

const TEST_PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const probes = {
  release: "0.0.6",
  alarms: async () => [{ name: "agentx-live25d-SlackDeadLetters", state: "OK" }, { name: "agentx-live25d-ConnectorBroken", state: "ALARM" }],
  queueDepths: async () => [{ name: "dispatch", depth: 0 }, { name: "slack-requests", depth: 2 }],
  slackAuthCheck: async () => ({ ok: true as const, teamId: "T0BSHLLUGBD" }),
  githubInstallations: async () => 1,
};

describe("GET /v1/admin/health (FR-030, A13)", () => {
  it("answers every section from the probes and the state table", async () => {
    const { db, admin } = await createAdminReadBroker({ brokerExtra: { adminReads: { health: probes } } });
    const at = new Date(Date.now() - 3_600_000).toISOString();
    db.set({ ...failureIndexKey(at, "11111111-1111-4111-8111-111111111111"), operationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222",
      project: "payments", origin: "slack", requester: { kind: "none" }, kind: "task", status: "FAILED", category: "worker_unavailable", error: "RUNTIME_UNAVAILABLE: no capacity", endedAt: at });
    const answer = await admin("GET", "/v1/admin/health");
    expect(answer.body).toEqual({
      version: { developerApi: "1.2", adminApi: "1.1", release: "0.0.6" },
      alarms: [{ name: "agentx-live25d-ConnectorBroken", state: "ALARM" }, { name: "agentx-live25d-SlackDeadLetters", state: "OK" }],
      alarmsCheck: { status: "warn", detail: "1 alarm in ALARM" },
      deadLetterQueues: [{ name: "dispatch", depth: 0 }, { name: "slack-requests", depth: 2 }],
      deadLetterQueuesCheck: { status: "warn", detail: "1 queue holds messages" },
      slack: { status: "ok", detail: "the bot token works for team T0BSHLLUGBD" },
      github: { status: "ok", detail: "installed on 1 account" },
      workerModes: [{ mode: "ec2-ebs", configured: true, latestDispatchFailure: { at, operationId: "11111111-1111-4111-8111-111111111111", error: "RUNTIME_UNAVAILABLE: no capacity" } }],
      workspaces: {}, workspacesTruncated: false, requestId: expect.any(String) as unknown,
    });
  });

  it("says unknown, with a reason, for a probe that is not set up or fails, and still answers", async () => {
    const failing = { alarms: async () => { throw Object.assign(new Error("denied"), { name: "AccessDenied" }); }, slackAuthCheck: async () => ({ ok: false as const, error: "token_revoked" }) };
    const { admin } = await createAdminReadBroker({ brokerExtra: { adminReads: { health: failing } } });
    const answer = await admin("GET", "/v1/admin/health");
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      version: { developerApi: "1.2", adminApi: "1.1" },
      alarms: [], alarmsCheck: { status: "unknown", detail: "could not read the alarms (AccessDenied)" },
      deadLetterQueues: [], deadLetterQueuesCheck: { status: "unknown", detail: "not set up in this deployment" },
      slack: { status: "failed", detail: "Slack refused the bot token (token_revoked)" },
      github: { status: "unknown", detail: "not set up in this deployment" },
    });
    expect(answer.body.version).not.toHaveProperty("release");
  });

  it("warns, never all clear, when a listed alarm is missing, and counts it beside firing ones (issue 206)", async () => {
    const answer = async (alarms: Array<{ name: string; state: string }>) => {
      const { admin } = await createAdminReadBroker({ brokerExtra: { adminReads: { health: { alarms: async () => alarms } } } });
      return (await admin("GET", "/v1/admin/health")).body.alarmsCheck;
    };
    expect(await answer([{ name: "agentx-live25d-SlackDeadLetters", state: "MISSING" }, { name: "agentx-live25d-TurnErrors", state: "OK" }]))
      .toStrictEqual({ status: "warn", detail: "1 alarm missing" });
    expect(await answer([{ name: "agentx-live25d-SlackDeadLetters", state: "MISSING" }, { name: "agentx-live25d-TestAlarm", state: "MISSING" }, { name: "agentx-live25d-TurnErrors", state: "ALARM" }]))
      .toStrictEqual({ status: "warn", detail: "1 alarm in ALARM, 2 alarms missing" });
    expect(await answer([{ name: "agentx-live25d-TurnErrors", state: "OK" }])).toStrictEqual({ status: "ok", detail: "1 alarms, none in ALARM" });
  });

  it("gives up on a slow probe after its time limit", async () => {
    const slow = { githubInstallations: () => new Promise<number>(() => undefined), timeoutMs: 20 };
    const { admin } = await createAdminReadBroker({ brokerExtra: { adminReads: { health: slow } } });
    expect((await admin("GET", "/v1/admin/health")).body.github).toEqual({ status: "unknown", detail: "did not answer within 0.02 seconds" });
  });

  it("fails the Slack check when the bot token belongs to another team than the environment's (R17)", async () => {
    const other = { slackAuthCheck: async () => ({ ok: true as const, teamId: "T0OTHERTEAM" }) };
    const recorded = await createAdminReadBroker({ brokerExtra: { adminReads: { health: other } } });
    expect((await recorded.admin("GET", "/v1/admin/health")).body.slack).toEqual({ status: "failed", detail: "the bot token belongs to team T0OTHERTEAM, not this environment's team T0BSHLLUGBD" });
    const unrecorded = await createAdminReadBroker({ slackTeamId: null, brokerExtra: { adminReads: { health: other } } });
    expect((await unrecorded.admin("GET", "/v1/admin/health")).body.slack).toEqual({ status: "ok", detail: "the bot token works for team T0OTHERTEAM" });
  });

  it("counts GitHub App installations with the App's own token", async () => {
    const fetch = vi.fn(async () => Response.json([{ id: 1 }, { id: 2 }]));
    const provider = new GitHubAppCredentialProvider({ credentialRef: "github-app", appId: "123", getPrivateKey: async () => TEST_PRIVATE_KEY, fetchImplementation: fetch });
    expect(await provider.installationCount()).toBe(2);
    expect(String((fetch.mock.calls[0] as unknown as [string])[0])).toBe("https://api.github.com/app/installations?per_page=100");
  });
});

// Fix round 1 (review of Task 12): R18's queue check, and the paths the first tests left open.
describe("GET /v1/admin/health, each check's other answers", () => {
  const health = async (probes: Record<string, unknown>, options: Parameters<typeof createAdminReadBroker>[0] = {}) => {
    const { admin } = await createAdminReadBroker({ ...options, brokerExtra: { adminReads: { health: probes } } });
    return (await admin("GET", "/v1/admin/health")).body;
  };

  it("says the dead-letter queues are empty, hold messages, could not be read, or did not answer (R18)", async () => {
    expect((await health({ queueDepths: async () => [{ name: "dispatch", depth: 0 }, { name: "slack-requests", depth: 0 }] })).deadLetterQueuesCheck).toEqual({ status: "ok", detail: "2 queues, all empty" });
    expect((await health({ queueDepths: async () => [{ name: "dispatch", depth: 3 }, { name: "slack-requests", depth: 1 }] })).deadLetterQueuesCheck).toEqual({ status: "warn", detail: "2 queues hold messages" });
    expect((await health({ queueDepths: async () => [{ name: "dispatch", depth: 0 }, { name: "slack-requests", depth: null }] })).deadLetterQueuesCheck).toEqual({ status: "unknown", detail: "1 of 2 queues could not be read" });
    expect((await health({ queueDepths: async () => [{ name: "dispatch", depth: 4 }, { name: "slack-requests", depth: null }] })).deadLetterQueuesCheck).toEqual({ status: "warn", detail: "1 queue holds messages; 1 could not be read" });
    expect((await health({ queueDepths: async () => [] })).deadLetterQueuesCheck).toEqual({ status: "unknown", detail: "no dead-letter queues were listed" });
    const failing = await health({ queueDepths: async () => { throw Object.assign(new Error("denied"), { name: "AccessDenied" }); } });
    expect(failing).toMatchObject({ deadLetterQueues: [], deadLetterQueuesCheck: { status: "unknown", detail: "could not read the dead-letter queues (AccessDenied)" } });
    const slow = await health({ queueDepths: () => new Promise<never>(() => undefined), timeoutMs: 20 });
    expect(slow).toMatchObject({ deadLetterQueues: [], deadLetterQueuesCheck: { status: "unknown", detail: "did not answer within 0.02 seconds" } });
  });

  it("counts open workspaces by status and leaves closed ones out", async () => {
    const harness = await createAdminReadBroker();
    for (const ts of ["1695500000.000501", "1695500000.000502", "1695500000.000503"]) await ensureWorkspace(harness.handler, `${SLACK_TEAM}/${SLACK_CHANNEL}/${ts}`, "U0PRIYA001");
    const [first, second, third] = harness.db.find((item) => item.entityType === "WORKSPACE");
    // WorkspaceInstanceSchema requires closedAt on a closed workspace, as the close path writes it.
    harness.db.set({ ...first!, status: "CLOSED", closedAt: new Date().toISOString() });
    harness.db.set({ ...second!, status: "STOPPED" });
    harness.db.set({ ...third!, status: "READY" });
    const body = (await harness.admin("GET", "/v1/admin/health")).body;
    expect(body.workspaces).toEqual({ READY: 1, STOPPED: 1 });
    expect(body.workspaces).not.toHaveProperty("CLOSED");
    expect(body.workspacesTruncated).toBe(false);
  });

  it("says ec2-ebs is not configured when no project binds it", async () => {
    expect((await health({}, { register: false })).workerModes).toEqual([{ mode: "ec2-ebs", configured: false }]);
  });

  it("fails the GitHub check when the App is installed nowhere, and says Slack could not be reached as unknown", async () => {
    const body = await health({ githubInstallations: async () => 0, slackAuthCheck: async () => ({ ok: false as const, error: "slack_unavailable" }) });
    expect(body.github).toEqual({ status: "failed", detail: "the GitHub App is installed on no account" });
    expect(body.slack).toEqual({ status: "unknown", detail: "Slack could not be reached" });
  });

  it("throws RUNTIME_UNAVAILABLE for a failed or malformed installations answer", async () => {
    const provider = (answer: Response) => new GitHubAppCredentialProvider({ credentialRef: "github-app", appId: "123", getPrivateKey: async () => TEST_PRIVATE_KEY, fetchImplementation: vi.fn(async () => answer) });
    await expect(provider(new Response("no", { status: 401 })).installationCount()).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE", message: "RUNTIME_UNAVAILABLE: GitHub App installations lookup failed with HTTP 401" });
    await expect(provider(Response.json({ installations: [] })).installationCount()).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE", message: "RUNTIME_UNAVAILABLE: GitHub returned an invalid installations response" });
  });
});
