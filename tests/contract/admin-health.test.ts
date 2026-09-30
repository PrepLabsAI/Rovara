// tests/contract/admin-health.test.ts
// Spec 025 A13: health from injected probes; a probe that is missing or fails never fails the route.
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { failureIndexKey } from "../../packages/contracts/src/index.js";
import { GitHubAppCredentialProvider } from "../../packages/broker/src/github-app.js";
import { createAdminReadBroker } from "../support/admin-read-broker.js";

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
      version: { developerApi: "1.2", adminApi: "1.0", release: "0.0.6" },
      alarms: [{ name: "agentx-live25d-ConnectorBroken", state: "ALARM" }, { name: "agentx-live25d-SlackDeadLetters", state: "OK" }],
      alarmsCheck: { status: "warn", detail: "1 alarm in ALARM" },
      deadLetterQueues: [{ name: "dispatch", depth: 0 }, { name: "slack-requests", depth: 2 }],
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
      version: { developerApi: "1.2", adminApi: "1.0" },
      alarms: [], alarmsCheck: { status: "unknown", detail: "could not read the alarms (AccessDenied)" },
      deadLetterQueues: [], slack: { status: "failed", detail: "Slack refused the bot token (token_revoked)" },
      github: { status: "unknown", detail: "not set up in this deployment" },
    });
    expect(answer.body.version).not.toHaveProperty("release");
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
