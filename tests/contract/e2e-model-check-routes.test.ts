import { describe, expect, it } from "vitest";
import { E2E_MODEL_CHECK_RESULT_SCHEMA, WEB_API_RUNTIME_PROFILE_ID } from "@agentx/contracts";
import { e2eRegisteredRuntimeKey } from "../../packages/broker/src/aws/e2e-runtime-readiness.js";
import { e2eModelCheckRunnerKey } from "../../packages/broker/src/e2e/model-route-registry.js";
import type { E2EAgentInstallation } from "../../packages/model-runtime/src/e2e-route-derive.js";
import { createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { call } from "../support/slack-broker.js";
import { PROFILE, webApiRow } from "../support/e2e-application-plan-fixtures.js";

// M1.4 Task 4.10C, test 34 at the HTTP surface: the admin routes of the model checks.

const admin = { subject: "admin-subject", admin: true };
const member = { subject: "member-subject", admin: false };
const ROLE_ID = "AROAABCDEFGHIJKLMNOP1";
const INSTANCE = "i-0123456789abcdef0";
const PREFIX = `e2e-runtime/${ROLE_ID}:${INSTANCE}/`;
const CORRELATION = "11111111-1111-4111-8111-111111111111";
const MODEL = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const installation: E2EAgentInstallation = { provider: "amazon-bedrock", region: "us-east-1" };

async function controlPlane(options: { wired?: boolean; runner?: boolean } = {}) {
  const brokerExtra = options.wired === false ? {} : { e2eFeatureRuntimeCatalogId: "catalog", e2eAgentInstallation: async () => installation };
  const harness = await createDeveloperTaskBroker({ brokerExtra });
  harness.db.set({ ...e2eRegisteredRuntimeKey("catalog", PROFILE, "web"), ...webApiRow("web", { expiresAt: new Date(Date.now() + 3_600_000).toISOString(), qualifiedAt: new Date(Date.now() - 3_600_000).toISOString() }) });
  if (options.runner !== false) harness.db.set({ ...e2eModelCheckRunnerKey(WEB_API_RUNTIME_PROFILE_ID), entityType: "E2E_MODEL_CHECK_RUNNER", roleId: ROLE_ID, instanceId: INSTANCE, transportCorrelationId: CORRELATION });
  const post = (body: unknown, user = admin) => call(harness.handler, { method: "POST", path: "/v1/admin/e2e/model-checks", user, body });
  const get = (checkId: string, user = admin) => call(harness.handler, { method: "GET", path: `/v1/admin/e2e/model-checks/${checkId}`, user });
  return { harness, post, get };
}

describe("the model check routes", () => {
  it("are an administrator's: a member is refused and nothing is put", async () => {
    const h = await controlPlane();
    const refused = await h.post({ kind: "discover" }, member);
    expect(refused.status).toBe(403);
    expect([...h.harness.s3.objects.keys()].filter((key) => key.startsWith("e2e-runtime/"))).toEqual([]);
    expect((await h.get("6b0e8a52-6f3e-4b8f-9f1c-0f5c1f4f2a11", member)).status).toBe(403);
  });

  it("answer 404 where the installation's settings or the runtime catalog are not wired", async () => {
    const h = await controlPlane({ wired: false });
    expect((await h.post({ kind: "discover" })).status).toBe(404);
  });

  it("POST answers 202 with the check's id and puts the request under the runner's own prefix", async () => {
    const h = await controlPlane();
    const answer = await h.post({ kind: "drive", modelId: MODEL });
    expect(answer.status, JSON.stringify(answer.body)).toBe(202);
    const checkId = String(answer.body.checkId);
    expect(checkId).toMatch(/^[0-9a-f-]{36}$/);
    expect([...h.harness.s3.objects.keys()].filter((key) => key.startsWith("e2e-runtime/"))).toEqual([`${PREFIX}canary-request.json`]);
    expect(JSON.parse(h.harness.s3.objects.get(`${PREFIX}canary-request.json`)!)).toMatchObject({ schemaVersion: "rovara-e2e-model-check-request/v2", checkId, kind: "drive" });
  });

  it("POST refuses a model that is not eligible with a 400, and puts nothing", async () => {
    const h = await controlPlane();
    const answer = await h.post({ kind: "drive", modelId: "anthropic.claude-haiku-4-5-20251001-v1:0" });
    expect(answer.status).toBe(400);
    expect(JSON.stringify(answer.body)).toMatch(/model-not-eligible/);
    expect(JSON.stringify(answer.body)).not.toContain("anthropic.claude-haiku-4-5-20251001-v1:0");
    expect([...h.harness.s3.objects.keys()].filter((key) => key.startsWith("e2e-runtime/"))).toEqual([]);
  });

  it("POST says there is no runner to ask when none is recorded, and a second check while one runs is a 409", async () => {
    const none = await controlPlane({ runner: false });
    expect((await none.post({ kind: "discover" })).status).toBe(503);
    expect(JSON.stringify((await none.post({ kind: "discover" })).body)).toMatch(/no-model-check-runner/);
    const h = await controlPlane();
    const first = await h.post({ kind: "discover" });
    expect(first.status).toBe(202);
    // The same request again is the same check (a lost 202); a different one is refused and names the running check.
    const again = await h.post({ kind: "discover" });
    expect([again.status, again.body.checkId]).toEqual([202, first.body.checkId]);
    const other = await h.post({ kind: "drive", modelId: MODEL });
    expect(other.status).toBe(409);
    expect(JSON.stringify(other.body)).toContain(String(first.body.checkId));
  });

  it("GET is pending until the runner answers, then gives the validated outcome; an unknown check is a 404", async () => {
    const h = await controlPlane();
    const checkId = String((await h.post({ kind: "discover" })).body.checkId);
    expect((await h.get(checkId)).body).toMatchObject({ status: "pending", checkId });
    h.harness.s3.objects.set(`${PREFIX}canary-result.json`, JSON.stringify({ schemaVersion: E2E_MODEL_CHECK_RESULT_SCHEMA, status: "discovered", checkId,
      discovery: { schemaVersion: "rovara-model-discovery/v1", provider: "amazon-bedrock", checkedAt: new Date().toISOString(), status: "unverified", unverifiedReason: "access-denied", models: [] } }));
    const done = await h.get(checkId);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: "discovered", tiers: { why: "discovery-unverified" } });
    expect((await h.get("6b0e8a52-6f3e-4b8f-9f1c-0f5c1f4f2a11")).status).toBe(404);
  });

  it("GET with no id is the tiers on record", async () => {
    const h = await controlPlane();
    const answer = await call(h.harness.handler, { method: "GET", path: "/v1/admin/e2e/model-checks", user: admin });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ tiers: { why: "discovery-unverified", recommended: { modelId: "us.anthropic.claude-haiku-5-5" } } });
  });
});
